/**
 * NEX+ · Local Filesystem Artifact Blob Store
 * Escopo 0.85 (Bloco 0.85C)
 *
 * Implementação de armazenamento físico em filesystem local com content-addressing (SHA-256),
 * staging atômico via temporary files, fsync explícito, proteção contra path traversal
 * e verificação ativa de integridade na leitura.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { promisify } from 'node:util';

import type {
  ArtifactBlobStore,
  PutBlobOptions,
  PutBlobResult,
  VerifyBlobResult,
} from './blob-store';
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactStorageError,
  ArtifactTooLargeError,
  ArtifactInvariantViolationError,
} from './errors';
import { isValidSha256 } from './validators';

const streamPipeline = promisify(pipeline);

export interface LocalFsArtifactBlobStoreOptions {
  readonly rootDir: string;
  readonly defaultMaxArtifactBytes?: number; // Padrão: 50MB (52_428_800 bytes)
}

export class LocalFsArtifactBlobStore implements ArtifactBlobStore {
  readonly rootDir: string;
  readonly defaultMaxArtifactBytes: number;
  private initialized = false;

  constructor(options: LocalFsArtifactBlobStoreOptions) {
    if (!options.rootDir || typeof options.rootDir !== 'string' || options.rootDir.trim().length === 0) {
      throw new ArtifactInvariantViolationError('INVALID_ROOT_DIR', 'rootDir must be a non-empty string.');
    }
    this.rootDir = path.resolve(options.rootDir);
    this.defaultMaxArtifactBytes = options.defaultMaxArtifactBytes ?? 52_428_800;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await fs.mkdir(path.join(this.rootDir, '_staging'), { recursive: true });
      await fs.mkdir(path.join(this.rootDir, 'sha256'), { recursive: true });
      this.initialized = true;
    }
  }

  /**
   * Constrói e valida o path absoluto a partir da storageKey, assegurando confinamento dentro de rootDir.
   */
  private resolveStoragePath(storageKey: string): string {
    if (!storageKey || typeof storageKey !== 'string') {
      throw new ArtifactStorageError('Invalid storageKey.');
    }

    if (path.isAbsolute(storageKey)) {
      throw new ArtifactStorageError(`Absolute path not allowed for storageKey '${storageKey}'.`);
    }

    const absolutePath = path.resolve(this.rootDir, storageKey);
    const relative = path.relative(this.rootDir, absolutePath);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ArtifactStorageError(`Path traversal attempt detected for storageKey '${storageKey}'.`);
    }

    return absolutePath;
  }

  async putBlob(
    data: Buffer | NodeJS.ReadableStream,
    options?: PutBlobOptions
  ): Promise<PutBlobResult> {
    await this.ensureInitialized();

    const maxBytes = options?.maxBytes ?? this.defaultMaxArtifactBytes;
    const stagingFileName = `${Date.now()}_${randomBytes(8).toString('hex')}.tmp`;
    const stagingPath = path.join(this.rootDir, '_staging', stagingFileName);

    const hash = createHash('sha256');
    let byteSize = 0;

    let fileHandle: fs.FileHandle | null = null;

    try {
      fileHandle = await fs.open(stagingPath, 'wx'); // Cria exclusivamente

      if (Buffer.isBuffer(data)) {
        byteSize = data.length;
        if (byteSize > maxBytes) {
          throw new ArtifactTooLargeError(byteSize, maxBytes);
        }
        hash.update(data);
        await fileHandle.writeFile(data);
      } else {
        // Leitura via Stream com contagem e limite progressivo
        const writeStream = createWriteStream('', { fd: fileHandle.fd, autoClose: false });

        const countingStream = new Readable({
          read() {},
        });

        const inputStream = data as Readable;

        await new Promise<void>((resolve, reject) => {
          inputStream.on('data', (chunk: Buffer) => {
            byteSize += chunk.length;
            if (byteSize > maxBytes) {
              inputStream.destroy();
              reject(new ArtifactTooLargeError(byteSize, maxBytes));
              return;
            }
            hash.update(chunk);
            writeStream.write(chunk);
          });

          inputStream.on('end', () => {
            writeStream.end(() => resolve());
          });

          inputStream.on('error', (err) => reject(err));
          writeStream.on('error', (err) => reject(err));
        });
      }

      await fileHandle.sync(); // Garante flush físico em disco
      await fileHandle.close();
      fileHandle = null;

      const calculatedSha256 = hash.digest('hex');

      if (options?.expectedSha256) {
        const expected = options.expectedSha256.toLowerCase();
        if (calculatedSha256 !== expected) {
          throw new ArtifactIntegrityError({
            storageKey: stagingPath,
            expectedSha256: expected,
            actualSha256: calculatedSha256,
            message: `Provided expectedSha256 '${expected}' does not match calculated hash '${calculatedSha256}'.`,
          });
        }
      }

      const storageKey = `sha256/${calculatedSha256.slice(0, 2)}/${calculatedSha256.slice(2, 4)}/${calculatedSha256}`;
      const finalPath = this.resolveStoragePath(storageKey);

      // Garante diretório de destino
      await fs.mkdir(path.dirname(finalPath), { recursive: true });

      // Verificação de blob já existente por content-addressing
      try {
        const existingStat = await fs.stat(finalPath);
        if (existingStat.isFile() && existingStat.size === byteSize) {
          // Arquivo idêntico já existe intacto
          await fs.unlink(stagingPath).catch(() => {});
          return {
            sha256: calculatedSha256,
            byteSize,
            storageKey,
            alreadyExisted: true,
          };
        }
      } catch {
        // Não existe, prossegue com a instalação
      }

      // Move atômico do staging para o destino final
      try {
        await fs.rename(stagingPath, finalPath);
      } catch (renameErr: any) {
        // Fallback defensivo para Windows se rename falhar
        if (renameErr?.code === 'EEXIST' || renameErr?.code === 'EPERM') {
          const verifyExisting = await this.verifyBlob(storageKey, calculatedSha256, byteSize);
          if (verifyExisting.valid) {
            await fs.unlink(stagingPath).catch(() => {});
            return {
              sha256: calculatedSha256,
              byteSize,
              storageKey,
              alreadyExisted: true,
            };
          }
        }
        throw renameErr;
      }

      return {
        sha256: calculatedSha256,
        byteSize,
        storageKey,
        alreadyExisted: false,
      };
    } catch (err) {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
      }
      await fs.unlink(stagingPath).catch(() => {});
      throw err;
    }
  }

  async getBlob(storageKey: string, expectedSha256?: string): Promise<Buffer> {
    const finalPath = this.resolveStoragePath(storageKey);

    let data: Buffer;
    try {
      data = await fs.readFile(finalPath);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new ArtifactNotFoundError(storageKey);
      }
      throw new ArtifactStorageError(`Failed to read artifact blob at '${storageKey}': ${err.message}`, err);
    }

    const calculatedSha256 = createHash('sha256').update(data).digest('hex');

    const expectedHash = expectedSha256?.toLowerCase() ?? (storageKey.startsWith('sha256/') ? storageKey.split('/').pop() : undefined);

    if (expectedHash && isValidSha256(expectedHash)) {
      if (calculatedSha256 !== expectedHash) {
        throw new ArtifactIntegrityError({
          storageKey,
          expectedSha256: expectedHash,
          actualSha256: calculatedSha256,
          message: `Active integrity check failed on read for '${storageKey}': expected hash '${expectedHash}', got '${calculatedSha256}'.`,
        });
      }
    }

    return data;
  }

  async getBlobStream(storageKey: string, expectedSha256?: string): Promise<NodeJS.ReadableStream> {
    const finalPath = this.resolveStoragePath(storageKey);

    try {
      await fs.access(finalPath);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new ArtifactNotFoundError(storageKey);
      }
      throw err;
    }

    // Para verificação de integridade no stream, lemos os dados e emitimos
    // garantindo que não passem dados corrompidos
    const buffer = await this.getBlob(storageKey, expectedSha256);
    return Readable.from(buffer);
  }

  async hasBlob(storageKey: string): Promise<boolean> {
    try {
      const finalPath = this.resolveStoragePath(storageKey);
      const stat = await fs.stat(finalPath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async verifyBlob(
    storageKey: string,
    expectedSha256: string,
    expectedSize?: number
  ): Promise<VerifyBlobResult> {
    try {
      const finalPath = this.resolveStoragePath(storageKey);
      const stat = await fs.stat(finalPath);

      if (!stat.isFile()) {
        return { valid: false, error: 'Target path is not a file.' };
      }

      if (expectedSize !== undefined && stat.size !== expectedSize) {
        return {
          valid: false,
          actualSize: stat.size,
          expectedSize,
          error: `Size mismatch: expected ${expectedSize} bytes, found ${stat.size} bytes.`,
        };
      }

      const data = await fs.readFile(finalPath);
      const actualSha256 = createHash('sha256').update(data).digest('hex');

      if (actualSha256 !== expectedSha256.toLowerCase()) {
        return {
          valid: false,
          actualSha256,
          actualSize: stat.size,
          error: `Hash mismatch: expected ${expectedSha256}, found ${actualSha256}.`,
        };
      }

      return {
        valid: true,
        actualSha256,
        actualSize: stat.size,
      };
    } catch (err: any) {
      return {
        valid: false,
        error: err?.message ?? 'Unknown verification error.',
      };
    }
  }

  async listStorageKeys(): Promise<string[]> {
    await this.ensureInitialized();
    const shaRoot = path.join(this.rootDir, 'sha256');
    const storageKeys: string[] = [];

    async function walk(dir: string, prefix: string) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
        } else if (entry.isFile() && isValidSha256(entry.name)) {
          storageKeys.push(`${prefix}/${entry.name}`);
        }
      }
    }

    await walk(shaRoot, 'sha256');
    return storageKeys.sort();
  }
}
