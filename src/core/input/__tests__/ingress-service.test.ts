/**
 * NEX+ · Testes Unitários e Adversariais do IngressContentService
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3 · Rodada B3-R3)
 *
 * Provas:
 * 1. Autorização obrigatória no 'create' e 'read' (fail-closed sem authorizer).
 * 2. Posse de IngressContentId NÃO autoriza leitura (A não lê conteúdo de B).
 * 3. declaredMimeType não é confiável; verifiedMimeType só nasce após inspector aceitar.
 * 4. Inspector rejeitado impede persistência do IngressContentRecord.
 * 5. Expiração temporal (expiresAt) bloqueia leitura com IngressContentExpiredError.
 * 6. Mesmo conteúdo físico (mesmo SHA) gera contentIds lógicos distintos sem colapso.
 * 7. IngressContentRef público contém apenas contentId (sem storageKey/sha256).
 * 8. Verificação criptográfica ativa detecta corrupção e lança IngressIntegrityError.
 * 9. Inspeção streaming limita amostra em RAM sem materializar o blob inteiro.
 * 10. Boundary de Não-Vazamento de Storage: métodos públicos retornam IngressContentView
 *     e jamais expõem storageKey, storageBackend ou caminhos físicos internos.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import type { HumanActor } from '../../observations/contracts';
import type { SessionRef } from '../../../auth/session-ref.types';
import type { ContextSubjectRef, ContextSubjectType, ContextSubjectId, OperationalContext } from '../../context/contracts';
import type { BlobStore, PutBlobOptions, PutBlobResult, VerifyBlobResult } from '../../storage/blob-store';
import type {
  IngressContentId,
  IngressContentRecord,
  IngressAccessAuthorizer,
  IngressContentInspector,
} from '../contracts';
import {
  IngressAuthorizationError,
  IngressContentInspectionError,
  IngressContentExpiredError,
  IngressIntegrityError,
} from '../errors';
import type { IngressContentStore } from '../persistence/contracts';
import { IngressContentService } from '../ingress';

class InMemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Buffer>();
  readonly accessedStorageKeys: string[] = [];

  async putBlob(data: Buffer | NodeJS.ReadableStream, options?: PutBlobOptions): Promise<PutBlobResult> {
    let buf: Buffer;
    if (Buffer.isBuffer(data)) {
      buf = data;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of data) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      buf = Buffer.concat(chunks);
    }

    if (options?.maxBytes && buf.length > options.maxBytes) {
      throw new Error('Blob too large');
    }

    const sha256 = createHash('sha256').update(buf).digest('hex');
    if (options?.expectedSha256 && options.expectedSha256 !== sha256) {
      throw new Error('SHA-256 mismatch');
    }

    const storageKey = `sha256/${sha256.substring(0, 2)}/${sha256.substring(2, 4)}/${sha256}`;
    const alreadyExisted = this.blobs.has(storageKey);
    this.blobs.set(storageKey, buf);

    return {
      sha256,
      byteSize: buf.length,
      storageKey,
      alreadyExisted,
    };
  }

  async getBlob(storageKey: string, expectedSha256?: string): Promise<Buffer> {
    this.accessedStorageKeys.push(storageKey);
    const buf = this.blobs.get(storageKey);
    if (!buf) throw new Error('Not found');
    if (expectedSha256) {
      const actual = createHash('sha256').update(buf).digest('hex');
      if (actual !== expectedSha256) throw new Error('Corrupted blob');
    }
    return buf;
  }

  async getBlobStream(storageKey: string, expectedSha256?: string): Promise<NodeJS.ReadableStream> {
    this.accessedStorageKeys.push(storageKey);
    const buf = await this.getBlob(storageKey, expectedSha256);
    const { Readable } = await import('node:stream');
    return Readable.from(buf);
  }

  async hasBlob(storageKey: string): Promise<boolean> {
    return this.blobs.has(storageKey);
  }

  async verifyBlob(storageKey: string, expectedSha256: string, expectedSize?: number): Promise<VerifyBlobResult> {
    this.accessedStorageKeys.push(storageKey);
    const buf = this.blobs.get(storageKey);
    if (!buf) {
      return { valid: false, error: 'Blob not found' };
    }
    const actualSha256 = createHash('sha256').update(buf).digest('hex');
    if (actualSha256 !== expectedSha256) {
      return { valid: false, actualSha256, expectedSha256, error: 'Hash mismatch' };
    }
    if (expectedSize !== undefined && buf.length !== expectedSize) {
      return { valid: false, actualSize: buf.length, expectedSize, error: 'Size mismatch' };
    }
    return { valid: true, actualSha256, actualSize: buf.length };
  }

  async listStorageKeys(): Promise<string[]> {
    return Array.from(this.blobs.keys());
  }
}

class InMemoryIngressContentStore implements IngressContentStore {
  readonly records = new Map<string, IngressContentRecord>();

  async saveContent(record: IngressContentRecord): Promise<IngressContentRecord> {
    this.records.set(record.contentId, record);
    return record;
  }

  async getContent(contentId: IngressContentId): Promise<IngressContentRecord | null> {
    return this.records.get(contentId) ?? null;
  }

  async hasContent(contentId: IngressContentId): Promise<boolean> {
    return this.records.has(contentId);
  }
}

describe('0.86B-3 · IngressContentService (Trust Boundary & Lifecycle · B3-R3)', () => {
  const sessionRefLucas = '1111111111111111111111111111111111111111111111111111111111111111' as SessionRef;
  const sessionRefJoao = '2222222222222222222222222222222222222222222222222222222222222222' as SessionRef;

  const lucasContext: OperationalContext = {
    actor: { kind: 'human', humanId: 'usr_lucas' },
    userId: 'usr_lucas',
    sessionRef: sessionRefLucas,
    contextSubjectRef: { subjectType: 'brand' as ContextSubjectType, subjectId: 'alterstate' as ContextSubjectId },
  };

  const joaoContext: OperationalContext = {
    actor: { kind: 'human', humanId: 'usr_joao' },
    userId: 'usr_joao',
    sessionRef: sessionRefJoao,
  };

  it('1. ingesta conteúdo com sucesso retornando IngressContentView sem expor storageBackend/storageKey', async () => {
    const blobStore = new InMemoryBlobStore();
    const contentStore = new InMemoryIngressContentStore();

    const authorizer: IngressAccessAuthorizer = {
      async authorize() {
        return true;
      },
    };

    const inspector: IngressContentInspector = {
      async inspect({ declaredMimeType }) {
        return {
          accepted: true,
          verifiedMimeType: declaredMimeType === 'image/jpeg' ? 'image/jpeg' : 'application/octet-stream',
        };
      },
    };

    const service = new IngressContentService({
      blobStore,
      contentStore,
      authorizer,
      inspector,
    });

    const fileData = Buffer.from('conteúdo binário da foto');
    const result = await service.ingestContent(
      {
        data: fileData,
        declaredMimeType: 'image/jpeg',
      },
      lucasContext
    );

    assert.ok(result.ref.contentId.startsWith('ing_'));
    assert.equal(result.record.actor.kind, 'human');
    assert.equal((result.record.actor as HumanActor).humanId, 'usr_lucas');
    assert.equal(result.record.userId, 'usr_lucas');
    assert.equal(result.record.sessionRef, sessionRefLucas);
    assert.equal(result.record.contextSubjectRef?.subjectId, 'alterstate');
    assert.equal(result.record.declaredMimeType, 'image/jpeg');
    assert.equal(result.record.verifiedMimeType, 'image/jpeg');
    assert.equal(result.record.byteSize, fileData.length);

    // Boundary: Prova que a resposta de ingestContent NÃO expõe storageKey nem storageBackend
    assert.equal((result.record as any).storageBackend, undefined);
    assert.equal((result.record as any).storageKey, undefined);

    // IngressContentRef público só expõe contentId
    assert.deepEqual(Object.keys(result.ref), ['contentId']);

    // Persistência interna preservou storageKey e storageBackend
    const internal = await contentStore.getContent(result.ref.contentId);
    assert.ok(internal);
    assert.equal(internal.storageBackend, 'local_fs');
    assert.ok(internal.storageKey.startsWith('sha256/'));
  });

  it('2. rejeita ingestão se authorizer negar create', async () => {
    const blobStore = new InMemoryBlobStore();
    const contentStore = new InMemoryIngressContentStore();

    const denyingAuthorizer: IngressAccessAuthorizer = {
      async authorize() {
        return false;
      },
    };

    const inspector: IngressContentInspector = {
      async inspect() {
        return { accepted: true, verifiedMimeType: 'text/plain' };
      },
    };

    const service = new IngressContentService({
      blobStore,
      contentStore,
      authorizer: denyingAuthorizer,
      inspector,
    });

    await assert.rejects(
      () => service.ingestContent({ data: Buffer.from('teste') }, lucasContext),
      IngressAuthorizationError
    );
  });

  it('3. rejeita ingestão e NÃO grava metadata canônica se inspector rejeitar conteúdo', async () => {
    const blobStore = new InMemoryBlobStore();
    const contentStore = new InMemoryIngressContentStore();

    const authorizer: IngressAccessAuthorizer = {
      async authorize() {
        return true;
      },
    };

    const rejectingInspector: IngressContentInspector = {
      async inspect({ declaredMimeType }) {
        return {
          accepted: false,
          rejectionReason: `MIME type '${declaredMimeType}' is prohibited by security policy.`,
        };
      },
    };

    const service = new IngressContentService({
      blobStore,
      contentStore,
      authorizer,
      inspector: rejectingInspector,
    });

    await assert.rejects(
      () =>
        service.ingestContent(
          { data: Buffer.from('malicious script'), declaredMimeType: 'application/x-msdownload' },
          lucasContext
        ),
      (err: any) => {
        assert.ok(err instanceof IngressContentInspectionError);
        assert.equal(err.declaredMimeType, 'application/x-msdownload');
        return true;
      }
    );

    // Garante que nenhum registro canônico foi salvo
    assert.equal(contentStore.records.size, 0);
  });

  it('4. posse de IngressContentId NÃO autoriza leitura: A não lê conteúdo de B se authorizer negar', async () => {
    const blobStore = new InMemoryBlobStore();
    const contentStore = new InMemoryIngressContentStore();

    const userScopedAuthorizer: IngressAccessAuthorizer = {
      async authorize({ operation, context, content }) {
        if (operation === 'create') return true;
        if (operation === 'read') {
          return content?.userId === context.userId;
        }
        return false;
      },
    };

    const inspector: IngressContentInspector = {
      async inspect() {
        return { accepted: true, verifiedMimeType: 'text/plain' };
      },
    };

    const service = new IngressContentService({
      blobStore,
      contentStore,
      authorizer: userScopedAuthorizer,
      inspector,
    });

    // Lucas ingesta um arquivo privado
    const { ref } = await service.ingestContent(
      { data: Buffer.from('dados confidenciais de Lucas') },
      lucasContext
    );

    // Lucas consegue ler
    const lucasRead = await service.getContent(ref.contentId, lucasContext);
    assert.equal(lucasRead.data.toString(), 'dados confidenciais de Lucas');

    // João conhece o ID 'ref.contentId', mas é negado pelo authorizer
    await assert.rejects(
      () => service.getContent(ref.contentId, joaoContext),
      (err: any) => {
        assert.ok(err instanceof IngressAuthorizationError);
        assert.equal(err.operation, 'read');
        assert.equal(err.contentId, ref.contentId);
        return true;
      }
    );
  });

  it('5. bloqueia acesso a conteúdo expirado com IngressContentExpiredError', async () => {
    const blobStore = new InMemoryBlobStore();
    const contentStore = new InMemoryIngressContentStore();

    const authorizer: IngressAccessAuthorizer = {
      async authorize() {
        return true;
      },
    };

    const inspector: IngressContentInspector = {
      async inspect() {
        return { accepted: true, verifiedMimeType: 'application/pdf' };
      },
    };

    let currentTime = '2026-08-24T21:00:00.000Z';

    const service = new IngressContentService({
      blobStore,
      contentStore,
      authorizer,
      inspector,
      nowProvider: () => currentTime,
    });

    const { ref } = await service.ingestContent(
      {
        data: Buffer.from('documento temporário'),
        expiresAt: '2026-08-24T22:00:00.000Z',
      },
      lucasContext
    );

    // Às 21h30 (antes de expirar): leitura permitida
    currentTime = '2026-08-24T21:30:00.000Z';
    const active = await service.getContent(ref.contentId, lucasContext);
    assert.ok(active.data.length > 0);

    // Às 22h01 (após expirar): leitura rejeitada por expiração
    currentTime = '2026-08-24T22:01:00.000Z';
    await assert.rejects(
      () => service.getContent(ref.contentId, lucasContext),
      (err: any) => {
        assert.ok(err instanceof IngressContentExpiredError);
        assert.equal(err.contentId, ref.contentId);
        return true;
      }
    );
  });

  it('6. dois uploads com mesmo conteúdo físico geram contentIds distintos sem colapso lógico', async () => {
    const blobStore = new InMemoryBlobStore();
    const contentStore = new InMemoryIngressContentStore();

    const authorizer: IngressAccessAuthorizer = {
      async authorize() {
        return true;
      },
    };

    const inspector: IngressContentInspector = {
      async inspect() {
        return { accepted: true, verifiedMimeType: 'text/plain' };
      },
    };

    const service = new IngressContentService({
      blobStore,
      contentStore,
      authorizer,
      inspector,
    });

    const identicalBytes = Buffer.from('mesmo texto exatamente');

    const res1 = await service.ingestContent({ data: identicalBytes }, lucasContext);
    const res2 = await service.ingestContent({ data: identicalBytes }, joaoContext);

    assert.notEqual(res1.ref.contentId, res2.ref.contentId);
    assert.equal(res1.record.userId, 'usr_lucas');
    assert.equal(res2.record.userId, 'usr_joao');

    assert.equal(res1.record.sha256, res2.record.sha256);
  });

  it('7. detecta corrupção no storage físico e lança IngressIntegrityError sem expor storageKey', async () => {
    const blobStore = new InMemoryBlobStore();
    const contentStore = new InMemoryIngressContentStore();

    const authorizer: IngressAccessAuthorizer = {
      async authorize() {
        return true;
      },
    };

    const inspector: IngressContentInspector = {
      async inspect() {
        return { accepted: true, verifiedMimeType: 'text/plain' };
      },
    };

    const service = new IngressContentService({
      blobStore,
      contentStore,
      authorizer,
      inspector,
    });

    const { ref } = await service.ingestContent(
      { data: Buffer.from('conteúdo original intacto') },
      lucasContext
    );

    const internal = await contentStore.getContent(ref.contentId);
    assert.ok(internal);
    blobStore.blobs.set(internal.storageKey, Buffer.from('conteúdo corrompido'));

    await assert.rejects(
      () => service.getContent(ref.contentId, lucasContext),
      (err: any) => {
        assert.ok(err instanceof IngressIntegrityError);
        assert.equal(err.contentId, ref.contentId);
        assert.ok(!err.message.includes('storageKey'));
        assert.ok(!err.message.includes('sha256/'));
        return true;
      }
    );
  });

  it('8. inspeção com stream lê apenas amostra limitada em RAM sem carregar blob inteiro', async () => {
    const blobStore = new InMemoryBlobStore();
    const contentStore = new InMemoryIngressContentStore();

    let capturedSampleLength = 0;
    let capturedByteSize = 0;
    let capturedSha256 = '';

    const authorizer: IngressAccessAuthorizer = {
      async authorize() {
        return true;
      },
    };

    const inspector: IngressContentInspector = {
      async inspect({ byteSize, sha256, sampleBuffer }) {
        capturedSampleLength = sampleBuffer ? sampleBuffer.length : 0;
        capturedByteSize = byteSize;
        capturedSha256 = sha256;
        return {
          accepted: true,
          verifiedMimeType: 'application/octet-stream',
        };
      },
    };

    const service = new IngressContentService({
      blobStore,
      contentStore,
      authorizer,
      inspector,
      maxSampleBytes: 1024,
    });

    const largeBlob = Buffer.alloc(100 * 1024, 'X');
    const expectedSha256 = createHash('sha256').update(largeBlob).digest('hex');

    const result = await service.ingestContent({ data: largeBlob }, lucasContext);

    assert.equal(capturedSampleLength, 1024);
    assert.equal(capturedByteSize, 100 * 1024);
    assert.equal(capturedSha256, expectedSha256);
    assert.equal(result.record.byteSize, 100 * 1024);
    assert.equal(result.record.sha256, expectedSha256);
  });

  // ==========================================================================
  // 9. PROVAS DE BOUNDARY: NÃO-VAZAMENTO DE STORAGE METADATA
  // ==========================================================================

  it('9. Prova A-E: getRecord, getContent e getContentStream retornam IngressContentView sem storageKey/storageBackend', async () => {
    const blobStore = new InMemoryBlobStore();
    const contentStore = new InMemoryIngressContentStore();

    const authorizer: IngressAccessAuthorizer = {
      async authorize() {
        return true;
      },
    };

    const inspector: IngressContentInspector = {
      async inspect() {
        return { accepted: true, verifiedMimeType: 'text/plain' };
      },
    };

    const service = new IngressContentService({
      blobStore,
      contentStore,
      authorizer,
      inspector,
    });

    const { record: ingestedView, ref } = await service.ingestContent(
      { data: Buffer.from('conteúdo para teste de boundary') },
      lucasContext
    );

    // A. ingestContent: não possui storageKey nem storageBackend
    assert.equal((ingestedView as any).storageBackend, undefined);
    assert.equal((ingestedView as any).storageKey, undefined);

    // B. getRecord: retorna IngressContentView sem chaves físicas
    const recordView = await service.getRecord(ref.contentId, lucasContext);
    assert.equal((recordView as any).storageBackend, undefined);
    assert.equal((recordView as any).storageKey, undefined);
    assert.equal(recordView.contentId, ref.contentId);
    assert.equal(recordView.sha256, ingestedView.sha256);

    // C. getContent: retorna data + IngressContentView sem chaves físicas
    const contentResult = await service.getContent(ref.contentId, lucasContext);
    assert.equal(contentResult.data.toString(), 'conteúdo para teste de boundary');
    assert.equal((contentResult.record as any).storageBackend, undefined);
    assert.equal((contentResult.record as any).storageKey, undefined);

    // D. getContentStream: retorna stream + IngressContentView sem chaves físicas
    const streamResult = await service.getContentStream(ref.contentId, lucasContext);
    assert.ok(streamResult.stream);
    assert.equal((streamResult.record as any).storageBackend, undefined);
    assert.equal((streamResult.record as any).storageKey, undefined);

    // E. JSON.stringify de todas as respostas públicas não contém chaves de storage ou path prefix
    for (const res of [ingestedView, recordView, contentResult.record, streamResult.record]) {
      const json = JSON.stringify(res);
      assert.ok(!json.includes('storageKey'), `JSON contained storageKey: ${json}`);
      assert.ok(!json.includes('storageBackend'), `JSON contained storageBackend: ${json}`);
      assert.ok(!json.includes('sha256/'), `JSON contained physical path prefix: ${json}`);
      assert.ok(json.includes('"sha256":'), 'JSON must contain semantic sha256 checksum field');
    }

    // F. IngressContentStore interno mantém storageKey e storageBackend intactos
    const internal = await contentStore.getContent(ref.contentId);
    assert.ok(internal);
    assert.equal(internal.storageBackend, 'local_fs');
    assert.ok(internal.storageKey.startsWith('sha256/'));

    // G. BlobStore recebeu a storageKey internamente para verificar e carregar
    assert.ok(blobStore.accessedStorageKeys.includes(internal.storageKey));
  });
});
