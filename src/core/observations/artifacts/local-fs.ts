/**
 * NEX+ · Local Filesystem Artifact Blob Store
 * Escopo 0.85 (Bloco 0.85C · Hardening Pós-Red-Team)
 *
 * Implementação de armazenamento físico em filesystem local com content-addressing (SHA-256),
 * staging atômico via temporary files, fsync explícito, proteção ativa contra path traversal,
 * proteção contra symlinks/junctions, pipelines com backpressure e cálculo de hash em streaming O(1).
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Transform, pipeline, Readable } from 'node:stream';
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
import {
  isValidSha256,
  validateCanonicalStorageKey,
  buildStorageKeyFromSha256,
} from './validators';

const streamPipeline = promisify(pipeline);

export interface LocalFsArtifactBlobStoreOptions {
  readonly rootDir: string;
  readonly defaultMaxArtifactBytes?: number; // Padrão: 50MB (52_428_800 bytes)
}

function validateMaxBytes(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ArtifactInvariantViolationError(
      'INVALID_MAX_BYTES',
      `${name} must be a non-negative safe integer, received '${value}'.`
    );
  }
}

export class LocalFsArtifactBlobStore implements ArtifactBlobStore {
  readonly rootDir: string;
  readonly defaultMaxArtifactBytes: number;
  private canonicalRootDir: string | null = null;
  private initialized = false;

  constructor(options: LocalFsArtifactBlobStoreOptions) {
    if (!options.rootDir || typeof options.rootDir !== 'string' || options.rootDir.trim().length === 0) {
      throw new ArtifactInvariantViolationError('INVALID_ROOT_DIR', 'rootDir must be a non-empty string.');
    }
    this.rootDir = path.resolve(options.rootDir);

    const maxBytes = options.defaultMaxArtifactBytes ?? 52_428_800;
    validateMaxBytes(maxBytes, 'defaultMaxArtifactBytes');
    this.defaultMaxArtifactBytes = maxBytes;
  }

  private async ensureInitialized(): Promise<string> {
    if (this.initialized && this.canonicalRootDir) {
      return this.canonicalRootDir;
    }

    await fs.mkdir(this.rootDir, { recursive: true });

    // Proteção contra symlink / junction no próprio root configurado
    const rootStat = await fs.lstat(this.rootDir);
    if (rootStat.isSymbolicLink()) {
      throw new ArtifactStorageError(`Live store root directory cannot be a symbolic link or junction: '${this.rootDir}'.`);
    }

    this.canonicalRootDir = await fs.realpath(this.rootDir);

    await fs.mkdir(path.join(this.canonicalRootDir, '_staging'), { recursive: true });
    await fs.mkdir(path.join(this.canonicalRootDir, 'sha256'), { recursive: true });

    this.initialized = true;
    return this.canonicalRootDir;
  }

  /**
   * Constrói e valida o path absoluto a partir da storageKey, assegurando confinamento estrito
   * no canonicalRootDir e ausência de symlinks/junctions em toda a árvore de diretórios.
   */
  private async resolveStoragePath(storageKey: string): Promise<string> {
    const canonicalRoot = await this.ensureInitialized();

    validateCanonicalStorageKey(storageKey);

    const parts = storageKey.split('/'); // ['sha256', 'ab', 'cd', '<64hex>']
    const relativePath = path.join(...parts);
    const absolutePath = path.join(canonicalRoot, relativePath);

    // Validação de confinamento físico contra symlinks intermediários
    let currentCheckPath = canonicalRoot;
    for (let i = 0; i < parts.length - 1; i++) {
      currentCheckPath = path.join(currentCheckPath, parts[i]);
      try {
        const stat = await fs.lstat(currentCheckPath);
        if (stat.isSymbolicLink()) {
          throw new ArtifactStorageError(`Symlink or junction detected in storage path at '${currentCheckPath}'.`);
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          throw err;
        }
        // Diretório ainda não existe, será criado legitimamente
        break;
      }
    }

    // Se o diretório-pai já existir, valida realpath para garantir confinamento
    const parentDir = path.dirname(absolutePath);
    try {
      const realParent = await fs.realpath(parentDir);
      const relToRoot = path.relative(canonicalRoot, realParent);
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        throw new ArtifactStorageError(`Path traversal or junction escape detected for storageKey '${storageKey}'.`);
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        throw err;
      }
    }

    return absolutePath;
  }

  /**
   * Calcula o hash SHA-256 e tamanho de um arquivo via streaming com O(1) de memória.
   */
  private async calculateFileSha256(filePath: string): Promise<{ sha256: string; byteSize: number }> {
    const hash = createHash('sha256');
    let byteSize = 0;

    const readStream = createReadStream(filePath);
    await new Promise<void>((resolve, reject) => {
    readStream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += buf.length;
      hash.update(buf);
    });
      readStream.on('end', () => resolve());
      readStream.on('error', (err) => reject(err));
    });

    return {
      sha256: hash.digest('hex'),
      byteSize,
    };
  }

  async putBlob(
    data: Buffer | NodeJS.ReadableStream,
    options?: PutBlobOptions
  ): Promise<PutBlobResult> {
    const canonicalRoot = await this.ensureInitialized();

    const maxBytes = options?.maxBytes ?? this.defaultMaxArtifactBytes;
    validateMaxBytes(maxBytes, 'options.maxBytes');

    const stagingFileName = `${Date.now()}_${randomBytes(12).toString('hex')}.tmp`;
    const stagingPath = path.join(canonicalRoot, '_staging', stagingFileName);

    let calculatedSha256 = '';
    let totalBytes = 0;
    let fileHandle: fs.FileHandle | null = null;

    try {
      fileHandle = await fs.open(stagingPath, 'wx'); // Criação exclusiva

      const hash = createHash('sha256');

      if (Buffer.isBuffer(data)) {
        totalBytes = data.length;
        if (totalBytes > maxBytes) {
          throw new ArtifactTooLargeError(totalBytes, maxBytes);
        }
        hash.update(data);
        await fileHandle.writeFile(data);
      } else {
        // Pipeline com Transform Stream respeitando backpressure e contagem estrita
        const countingHashTransform = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
              callback(new ArtifactTooLargeError(totalBytes, maxBytes));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });

        const fileWriteStream = createWriteStream('', { fd: fileHandle.fd, autoClose: false });

        await streamPipeline(
          data as Readable,
          countingHashTransform,
          fileWriteStream
        );
      }

      await fileHandle.sync(); // Garante flush físico em disco
      await fileHandle.close();
      fileHandle = null;

      calculatedSha256 = hash.digest('hex');

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

      const storageKey = buildStorageKeyFromSha256(calculatedSha256);
      const finalPath = await this.resolveStoragePath(storageKey);

      await fs.mkdir(path.dirname(finalPath), { recursive: true });

      // Verificação rigorosa se destino já existe
      try {
        const existingStat = await fs.lstat(finalPath);
        if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
          throw new ArtifactStorageError(`Destination path '${finalPath}' exists and is not a regular file.`);
        }

        // Calcula o hash completo do arquivo existente para garantir integridade absoluta
        const existingCheck = await this.calculateFileSha256(finalPath);
        if (existingCheck.byteSize === totalBytes && existingCheck.sha256 === calculatedSha256) {
          await fs.unlink(stagingPath).catch(() => {});
          return {
            sha256: calculatedSha256,
            byteSize: totalBytes,
            storageKey,
            alreadyExisted: true,
          };
        } else {
          // Arquivo existente está corrompido! Não sobrescrever silenciosamente.
          throw new ArtifactIntegrityError({
            storageKey,
            expectedSha256: calculatedSha256,
            actualSha256: existingCheck.sha256,
            message: `Destination file at '${storageKey}' exists but is corrupted (hash mismatch). Cannot overwrite historical evidence.`,
          });
        }
      } catch (statErr: any) {
        if (statErr instanceof ArtifactIntegrityError || statErr instanceof ArtifactStorageError) {
          throw statErr;
        }
        // Se ENOENT, segue para rename normal
      }

      // Move atômico de staging para destino final
      try {
        await fs.rename(stagingPath, finalPath);
      } catch (renameErr: any) {
        // Fallback defensivo para concorrência (EEXIST / EPERM)
        if (renameErr?.code === 'EEXIST' || renameErr?.code === 'EPERM') {
          const verifyExisting = await this.verifyBlob(storageKey, calculatedSha256, totalBytes);
          if (verifyExisting.valid) {
            await fs.unlink(stagingPath).catch(() => {});
            return {
              sha256: calculatedSha256,
              byteSize: totalBytes,
              storageKey,
              alreadyExisted: true,
            };
          } else {
            throw new ArtifactIntegrityError({
              storageKey,
              expectedSha256: calculatedSha256,
              actualSha256: verifyExisting.actualSha256,
              message: `Destination file corrupted after rename race on '${storageKey}'.`,
            });
          }
        }
        throw renameErr;
      }

      return {
        sha256: calculatedSha256,
        byteSize: totalBytes,
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
    const finalPath = await this.resolveStoragePath(storageKey);

    try {
      const stat = await fs.lstat(finalPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new ArtifactStorageError(`Target storage object '${storageKey}' is not a regular file.`);
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new ArtifactNotFoundError(storageKey);
      }
      throw err;
    }

    let data: Buffer;
    try {
      data = await fs.readFile(finalPath);
    } catch (err: any) {
      throw new ArtifactStorageError(`Failed to read artifact blob at '${storageKey}': ${err.message}`, err);
    }

    const calculatedSha256 = createHash('sha256').update(data).digest('hex');
    const expectedHash = expectedSha256?.toLowerCase() ?? storageKey.split('/').pop()?.toLowerCase();

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
    const canonicalRoot = await this.ensureInitialized();
    const finalPath = await this.resolveStoragePath(storageKey);

    const expectedHash = expectedSha256?.toLowerCase() ?? storageKey.split('/').pop()?.toLowerCase();
    if (!expectedHash || !isValidSha256(expectedHash)) {
      throw new ArtifactInvariantViolationError('INVALID_SHA256', `Cannot get stream with invalid hash '${expectedHash}'.`);
    }

    try {
      const stat = await fs.lstat(finalPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new ArtifactStorageError(`Target storage object '${storageKey}' is not a regular file.`);
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new ArtifactNotFoundError(storageKey);
      }
      throw err;
    }

    // Criação de snapshot temporário verificado e isolado contra TOCTOU
    const snapshotName = `_snap_${Date.now()}_${randomBytes(8).toString('hex')}.tmp`;
    const snapshotPath = path.join(canonicalRoot, '_staging', snapshotName);

    let totalBytes = 0;
    const hash = createHash('sha256');

    const sourceStream = createReadStream(finalPath);

    // Gerador assíncrono para streaming O(1) com cálculo de hash simultâneo
    async function* makeHashingIterable() {
      for await (const chunk of sourceStream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        hash.update(buf);
        yield buf;
      }
    }

    // Abertura exclusiva para escrita E leitura (wx+)
    const fileHandle = await fs.open(snapshotPath, 'wx+');

    try {
      // Gravação no snapshot via AsyncIterable sem criar WriteStream titular
      await fileHandle.writeFile(makeHashingIterable());
      await fileHandle.sync();

      const calculatedHash = hash.digest('hex');
      if (calculatedHash !== expectedHash) {
        await fileHandle.close().catch(() => {});
        await fs.unlink(snapshotPath).catch(() => {});
        throw new ArtifactIntegrityError({
          storageKey,
          expectedSha256: expectedHash,
          actualSha256: calculatedHash,
          message: `Active integrity verification failed for '${storageKey}': expected hash '${expectedHash}', got '${calculatedHash}'.`,
        });
      }

      // Cria ReadStream diretamente vinculado ao FileHandle já verificado (sem reabertura por path)
      const snapshotReadStream = fileHandle.createReadStream({
        start: 0,
        autoClose: true,
      });

      // Remoção garantida e idempotente do snapshot após o fechamento do ReadStream / FileHandle
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        fs.unlink(snapshotPath).catch(() => {});
      };

      snapshotReadStream.on('close', cleanup);
      snapshotReadStream.on('error', cleanup);

      return snapshotReadStream;
    } catch (err) {
      await fileHandle.close().catch(() => {});
      await fs.unlink(snapshotPath).catch(() => {});
      throw err;
    }
  }

  async hasBlob(storageKey: string): Promise<boolean> {
    try {
      const finalPath = await this.resolveStoragePath(storageKey);
      const stat = await fs.lstat(finalPath);
      return stat.isFile() && !stat.isSymbolicLink();
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
      const finalPath = await this.resolveStoragePath(storageKey);
      const stat = await fs.lstat(finalPath);

      if (stat.isSymbolicLink() || !stat.isFile()) {
        return {
          valid: false,
          error: `Target path '${storageKey}' is not a regular file (symlinks/junctions rejected).`,
        };
      }

      if (expectedSize !== undefined && stat.size !== expectedSize) {
        return {
          valid: false,
          actualSize: stat.size,
          expectedSize,
          error: `Size mismatch: expected ${expectedSize} bytes, found ${stat.size} bytes.`,
        };
      }

      // Verificação em streaming constante O(1)
      const fileCheck = await this.calculateFileSha256(finalPath);

      if (fileCheck.sha256 !== expectedSha256.toLowerCase()) {
        return {
          valid: false,
          actualSha256: fileCheck.sha256,
          expectedSha256: expectedSha256.toLowerCase(),
          actualSize: fileCheck.byteSize,
          error: `Hash mismatch: expected ${expectedSha256}, found ${fileCheck.sha256}.`,
        };
      }

      return {
        valid: true,
        actualSha256: fileCheck.sha256,
        expectedSha256: expectedSha256.toLowerCase(),
        actualSize: fileCheck.byteSize,
        expectedSize: expectedSize ?? fileCheck.byteSize,
      };
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return {
          valid: false,
          error: `Blob file does not exist on disk for '${storageKey}'.`,
        };
      }
      return {
        valid: false,
        error: err?.message ?? 'Unknown verification error.',
      };
    }
  }

  async listStorageKeys(): Promise<string[]> {
    const canonicalRoot = await this.ensureInitialized();
    const shaRoot = path.join(canonicalRoot, 'sha256');
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
          const key = `${prefix}/${entry.name}`;
          try {
            validateCanonicalStorageKey(key);
            storageKeys.push(key);
          } catch {
            // Ignora arquivos que não sejam chaves canônicas válidas
          }
        }
      }
    }

    await walk(shaRoot, 'sha256');
    return storageKeys.sort();
  }
}
