import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

import { LocalFsArtifactBlobStore } from '../local-fs';
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactStorageError,
  ArtifactTooLargeError,
} from '../errors';

describe('Escopo 0.85C · LocalFsArtifactBlobStore (Testes Físicos de Filesystem)', () => {
  let tempRoot: string;
  let store: LocalFsArtifactBlobStore;

  before(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nex_blob_test_'));
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

  it('A: Buffer pequeno é salvo e lido corretamente com verificação ativa de hash', async () => {
    const content = Buffer.from('NEX+ durable evidence test content 123');
    const expectedHash = createHash('sha256').update(content).digest('hex');

    const putRes = await store.putBlob(content);
    assert.equal(putRes.sha256, expectedHash);
    assert.equal(putRes.byteSize, content.length);
    assert.ok(putRes.storageKey.startsWith('sha256/'));

    const readBuffer = await store.getBlob(putRes.storageKey);
    assert.deepEqual(readBuffer, content);
  });

  it('B: Stream é salvo sem carregar tudo na memória', async () => {
    const chunk1 = Buffer.from('Stream chunk 1 - ');
    const chunk2 = Buffer.from('Stream chunk 2 - ');
    const chunk3 = Buffer.from('Stream chunk 3 finale');
    const fullContent = Buffer.concat([chunk1, chunk2, chunk3]);
    const expectedHash = createHash('sha256').update(fullContent).digest('hex');

    const stream = Readable.from([chunk1, chunk2, chunk3]);

    const putRes = await store.putBlob(stream);
    assert.equal(putRes.sha256, expectedHash);
    assert.equal(putRes.byteSize, fullContent.length);

    const readBuffer = await store.getBlob(putRes.storageKey);
    assert.deepEqual(readBuffer, fullContent);
  });

  it('C, D, E: SHA-256 e byteSize correspondem exatamente aos bytes e storageKey deriva apenas do hash', async () => {
    const raw = Buffer.from('Evidence Deterministic Hash Payload');
    const expectedHash = createHash('sha256').update(raw).digest('hex');
    const expectedKey = `sha256/${expectedHash.slice(0, 2)}/${expectedHash.slice(2, 4)}/${expectedHash}`;

    const putRes = await store.putBlob(raw);
    assert.equal(putRes.sha256, expectedHash);
    assert.equal(putRes.byteSize, raw.length);
    assert.equal(putRes.storageKey, expectedKey);
  });

  it('F: Source URL, path externo e nomes arbitrários não influenciam o filesystem path físico', async () => {
    const raw = Buffer.from('External origin agnostic data');
    const putRes = await store.putBlob(raw);

    // O storageKey sempre segue o padrão sha256/ab/cd/<hash>
    assert.match(putRes.storageKey, /^sha256\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  });

  it('G: Artefato maior que maxArtifactBytes é rejeitado e temp file é limpo', async () => {
    const storeSmall = new LocalFsArtifactBlobStore({
      rootDir: tempRoot,
      defaultMaxArtifactBytes: 50, // Limite estrito de 50 bytes
    });

    const largeBuffer = Buffer.alloc(100, 'X');

    await assert.rejects(
      async () => {
        await storeSmall.putBlob(largeBuffer);
      },
      (err: unknown) => {
        assert.ok(err instanceof ArtifactTooLargeError);
        assert.equal(err.byteSize, 100);
        assert.equal(err.maxArtifactBytes, 50);
        return true;
      }
    );

    // Confirma que staging está limpo de temps abandonados
    const stagingDir = path.join(tempRoot, '_staging');
    const stagingFiles = await fs.readdir(stagingDir);
    assert.equal(stagingFiles.length, 0);
  });

  it('H: Temp file é limpo após erro de mismatch em expectedSha256', async () => {
    const content = Buffer.from('Mismatch test payload');
    const wrongHash = '0000000000000000000000000000000000000000000000000000000000000000';

    await assert.rejects(
      async () => {
        await store.putBlob(content, { expectedSha256: wrongHash });
      },
      (err: unknown) => {
        assert.ok(err instanceof ArtifactIntegrityError);
        return true;
      }
    );

    const stagingFiles = await fs.readdir(path.join(tempRoot, '_staging'));
    assert.equal(stagingFiles.length, 0);
  });

  it('I & J: Duas escritas concorrentes dos mesmos bytes produzem um blob final íntegro e reutilizam o mesmo hash', async () => {
    const identicalContent = Buffer.from('Identical concurrent content bytes 999');

    const [res1, res2] = await Promise.all([
      store.putBlob(identicalContent),
      store.putBlob(identicalContent),
    ]);

    assert.equal(res1.sha256, res2.sha256);
    assert.equal(res1.storageKey, res2.storageKey);

    // Um dos dois cria e o outro detecta que já existia ou ambos convergem com segurança
    const read = await store.getBlob(res1.storageKey);
    assert.deepEqual(read, identicalContent);

    // Verificação física de integridade
    const verify = await store.verifyBlob(res1.storageKey, res1.sha256, identicalContent.length);
    assert.equal(verify.valid, true);
  });

  it('Proteção estrita contra Path Traversal no getBlob', async () => {
    await assert.rejects(
      async () => {
        await store.getBlob('../../etc/passwd');
      },
      (err: unknown) => {
        assert.ok(err instanceof ArtifactStorageError);
        assert.ok(err.message.includes('Path traversal attempt detected'));
        return true;
      }
    );
  });
});
