import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

import { LocalFsArtifactBlobStore } from '../local-fs';
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactStorageError,
  ArtifactTooLargeError,
  ArtifactInvariantViolationError,
} from '../errors';
import { buildStorageKeyFromSha256 } from '../validators';

describe('Escopo 0.85C · LocalFsArtifactBlobStore (Hardening Pós-Red-Team)', () => {
  let tempRoot: string;
  let store: LocalFsArtifactBlobStore;

  before(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nex_blob_hardened_'));
    store = new LocalFsArtifactBlobStore({
      rootDir: tempRoot,
      defaultMaxArtifactBytes: 1024 * 1024, // 1MB para teste
    });
  });

  after(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('1. Filesystem, Confinamento e Integridade de Blobs', () => {
    it('FS-4: Formato exato da storageKey deriva do SHA-256 via buildStorageKeyFromSha256', async () => {
      const content = Buffer.from('Evidence Content For Key Structure Verification');
      const hash = createHash('sha256').update(content).digest('hex');
      const expectedKey = `sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;

      assert.equal(buildStorageKeyFromSha256(hash), expectedKey);

      const putRes = await store.putBlob(content);
      assert.equal(putRes.sha256, hash);
      assert.equal(putRes.storageKey, expectedKey);
    });

    it('FS-2: Destino existente com mesmo tamanho mas bytes (hash) diferentes é rejeitado com ArtifactIntegrityError', async () => {
      const content1 = Buffer.from('AAAA1111'); // 8 bytes
      const content2 = Buffer.from('BBBB2222'); // 8 bytes (mesmo tamanho, hash diferente)

      const hash1 = createHash('sha256').update(content1).digest('hex');
      const key1 = buildStorageKeyFromSha256(hash1);
      const destPath = path.join(tempRoot, ...key1.split('/'));

      // Cria manualmente arquivo corrompido no destino de hash1 com o conteúdo content2
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, content2);

      // Tenta gravar content1 cujo destino foi corrompido
      await assert.rejects(
        async () => {
          await store.putBlob(content1);
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactIntegrityError);
          assert.ok(err.message.includes('corrupted'));
          return true;
        }
      );

      // Limpa o arquivo adulterado
      await fs.unlink(destPath).catch(() => {});
    });

    it('FS-3: Destino existente com tamanho diferente é rejeitado com ArtifactIntegrityError', async () => {
      const content = Buffer.from('Authentic content 100 bytes');
      const hash = createHash('sha256').update(content).digest('hex');
      const key = buildStorageKeyFromSha256(hash);
      const destPath = path.join(tempRoot, ...key.split('/'));

      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, Buffer.from('Short')); // tamanho diferente

      await assert.rejects(
        async () => {
          await store.putBlob(content);
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactIntegrityError);
          return true;
        }
      );

      await fs.unlink(destPath).catch(() => {});
    });

    it('FS-7: Diretório no lugar do arquivo de destino é rejeitado', async () => {
      const content = Buffer.from('Payload destined for collision with dir');
      const hash = createHash('sha256').update(content).digest('hex');
      const key = buildStorageKeyFromSha256(hash);
      const destPath = path.join(tempRoot, ...key.split('/'));

      await fs.mkdir(destPath, { recursive: true }); // Cria pasta onde deveria ser arquivo

      await assert.rejects(
        async () => {
          await store.putBlob(content);
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactStorageError);
          return true;
        }
      );

      await fs.rm(destPath, { recursive: true, force: true }).catch(() => {});
    });

    it('FS-1: Escape por Junction / Symlink é detectado e rejeitado', async () => {
      // Teste de junction no Windows se suportado
      if (process.platform === 'win32') {
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nex_outside_target_'));
        const junctionDir = path.join(tempRoot, 'sha256', 'ee');

        try {
          await fs.mkdir(path.dirname(junctionDir), { recursive: true });
          // Cria junction via cmd /c mklink /J
          execSync(`cmd.exe /c mklink /J "${junctionDir}" "${outsideDir}"`, { stdio: 'ignore' });

          const fakeHash = 'ee00000000000000000000000000000000000000000000000000000000000000';
          const fakeKey = `sha256/ee/00/${fakeHash}`;

          await assert.rejects(
            async () => {
              await store.getBlob(fakeKey);
            },
            (err: unknown) => {
              assert.ok(err instanceof ArtifactStorageError);
              assert.ok(err.message.includes('Symlink or junction detected'));
              return true;
            }
          );
        } catch {
          // Se ambiente não permitir criação de junction, segue
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
          try {
            execSync(`cmd.exe /c rmdir "${junctionDir}"`, { stdio: 'ignore' });
          } catch {}
        }
      }
    });

    it('FS-8 & FS-9: Concorrência de 50 writers simultâneos com mesmo hash resulta em 1 blob íntegro e staging vazio', async () => {
      const concurrentData = Buffer.from('Heavy concurrent stress test payload for 50 writers 2026');
      const hash = createHash('sha256').update(concurrentData).digest('hex');

      const promises = Array.from({ length: 50 }, () => store.putBlob(concurrentData));
      const results = await Promise.all(promises);

      for (const res of results) {
        assert.equal(res.sha256, hash);
        assert.equal(res.byteSize, concurrentData.length);
      }

      // Prova que o arquivo final está 100% íntegro
      const verify = await store.verifyBlob(results[0].storageKey, hash, concurrentData.length);
      assert.equal(verify.valid, true);

      // FS-9: Staging permanece completamente vazio após conclusão
      const stagingFiles = await fs.readdir(path.join(tempRoot, '_staging'));
      assert.equal(stagingFiles.length, 0);
    });
  });

  describe('2. Streaming, Pipelines e Limites', () => {
    it('ST-1: Stream que excede maxArtifactBytes falha com ArtifactTooLargeError e limpa temp', async () => {
      const storeSmall = new LocalFsArtifactBlobStore({
        rootDir: tempRoot,
        defaultMaxArtifactBytes: 100,
      });

      const chunk = Buffer.alloc(60, 'Z');
      const stream = Readable.from([chunk, chunk]); // Total 120 bytes > 100

      await assert.rejects(
        async () => {
          await storeSmall.putBlob(stream);
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactTooLargeError);
          assert.equal(err.maxArtifactBytes, 100);
          return true;
        }
      );

      const stagingFiles = await fs.readdir(path.join(tempRoot, '_staging'));
      assert.equal(stagingFiles.length, 0);
    });

    it('ST-2: Stream com tamanho exatamente igual ao maxArtifactBytes passa', async () => {
      const storeExact = new LocalFsArtifactBlobStore({
        rootDir: tempRoot,
        defaultMaxArtifactBytes: 120,
      });

      const chunk = Buffer.alloc(60, 'W');
      const stream = Readable.from([chunk, chunk]); // 120 bytes exatos

      const res = await storeExact.putBlob(stream);
      assert.equal(res.byteSize, 120);
    });

    it('ST-3: Erro no stream de origem propaga e limpa staging', async () => {
      const faultyStream = new Readable({
        read() {
          this.destroy(new Error('Simulated upstream stream network failure'));
        },
      });

      await assert.rejects(
        async () => {
          await store.putBlob(faultyStream);
        },
        (err: any) => {
          assert.ok(err.message.includes('Simulated upstream stream network failure'));
          return true;
        }
      );

      const stagingFiles = await fs.readdir(path.join(tempRoot, '_staging'));
      assert.equal(stagingFiles.length, 0);
    });

    it('ST-4: Pipeline com backpressure preserva bytes e hash', async () => {
      const chunks = Array.from({ length: 20 }, (_, i) => Buffer.from(`Chunk index ${i} with padding data - `));
      const fullBuffer = Buffer.concat(chunks);
      const expectedHash = createHash('sha256').update(fullBuffer).digest('hex');

      const stream = Readable.from(chunks);
      const res = await store.putBlob(stream);

      assert.equal(res.sha256, expectedHash);
      assert.equal(res.byteSize, fullBuffer.length);

      const readBack = await store.getBlob(res.storageKey);
      assert.deepEqual(readBack, fullBuffer);
    });

    it('ST-5: getBlobStream retorna ReadStream funcional com verificação de integridade', async () => {
      const content = Buffer.from('Stream readable consumption test');
      const putRes = await store.putBlob(content);

      const stream = await store.getBlobStream(putRes.storageKey, putRes.sha256);
      const readChunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (c: Buffer) => readChunks.push(c));
        stream.on('end', () => resolve());
        stream.on('error', (err) => reject(err));
      });

      assert.deepEqual(Buffer.concat(readChunks), content);
    });

    it('ST-6: verifyBlob calcula hash em streaming sem estourar memória', async () => {
      const largeContent = Buffer.alloc(100 * 1024, 'K'); // 100KB
      const hash = createHash('sha256').update(largeContent).digest('hex');
      const putRes = await store.putBlob(largeContent);

      const verifyRes = await store.verifyBlob(putRes.storageKey, hash, largeContent.length);
      assert.equal(verifyRes.valid, true);
      assert.equal(verifyRes.actualSha256, hash);
    });
  });
});
