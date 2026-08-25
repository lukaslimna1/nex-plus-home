/**
 * NEX+ · Ingress Content Service & Trust Boundary
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3 · Rodada B3-R3)
 *
 * Responsabilidades:
 * 1. Materialização física de blobs com hashing em streaming e staging seguro.
 * 2. Inspeção server-side obrigatória via IngressContentInspector com leitura de amostra limitada em RAM.
 * 3. Falha fechada (fail-closed) caso o inspetor ou a amostra não possam ser obtidos.
 * 4. Autorização obrigatória via IngressAccessAuthorizer (fail-closed, sem permissão implícita por contentId).
 * 5. Registro append-only de metadados internos em IngressContentStore.
 * 6. Leitura e streaming autorizados com verificação ativa de integridade e expiração.
 * 7. Isolamento de fronteira (Boundary): métodos públicos retornam IngressContentView,
 *    garantindo que storageBackend e storageKey jamais sejam expostos a callers.
 */

import { randomUUID } from 'node:crypto';
import type { OperationalContext } from '../context/contracts';
import { validateOperationalContext } from '../context/invariants';
import type { BlobStore } from '../storage/blob-store';
import type {
  IngressContentId,
  IngressContentRecord,
  IngressContentView,
  IngressContentRef,
  IngestContentParams,
  IngressAccessAuthorizer,
  IngressContentInspector,
} from './contracts';
import {
  validateIngressContentId,
  validateIngressContentRecord,
  sanitizeContextSubjectRef,
  toIngressContentView,
} from './invariants';
import {
  IngressAuthorizationError,
  IngressContentInspectionError,
  IngressContentExpiredError,
  IngressContentNotFoundError,
  IngressIntegrityError,
} from './errors';
import type { IngressContentStore } from './persistence/contracts';

const DEFAULT_SAMPLE_LIMIT_BYTES = 64 * 1024; // 64 KiB

/**
 * Helper interno para ler de forma segura e limitada em RAM
 * uma amostra inicial de bytes a partir de um ReadableStream.
 */
async function readStreamSample(
  stream: NodeJS.ReadableStream,
  maxSampleBytes: number = DEFAULT_SAMPLE_LIMIT_BYTES
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (totalBytes + buf.length >= maxSampleBytes) {
        const needed = maxSampleBytes - totalBytes;
        if (needed > 0) {
          chunks.push(buf.subarray(0, needed));
          totalBytes += needed;
        }
        if (typeof (stream as any).destroy === 'function') {
          (stream as any).destroy();
        }
        break;
      }
      chunks.push(buf);
      totalBytes += buf.length;
    }
  } catch (err) {
    if (typeof (stream as any).destroy === 'function') {
      (stream as any).destroy();
    }
    throw err;
  }

  return Buffer.concat(chunks);
}

export interface IngressContentServiceOptions {
  readonly blobStore: BlobStore;
  readonly contentStore: IngressContentStore;
  readonly authorizer: IngressAccessAuthorizer;
  readonly inspector: IngressContentInspector;
  readonly storageBackend?: string; // Padrão: 'local_fs'
  readonly maxSampleBytes?: number; // Padrão: 64 KiB
  readonly nowProvider?: () => string;
}

export class IngressContentService {
  private readonly blobStore: BlobStore;
  private readonly contentStore: IngressContentStore;
  private readonly authorizer: IngressAccessAuthorizer;
  private readonly inspector: IngressContentInspector;
  private readonly storageBackend: string;
  private readonly maxSampleBytes: number;
  private readonly nowProvider: () => string;

  constructor(options: IngressContentServiceOptions) {
    if (!options.blobStore || typeof options.blobStore.putBlob !== 'function') {
      throw new Error('IngressContentService requires a valid BlobStore instance.');
    }
    if (!options.contentStore || typeof options.contentStore.saveContent !== 'function') {
      throw new Error('IngressContentService requires a valid IngressContentStore instance.');
    }
    if (!options.authorizer || typeof options.authorizer.authorize !== 'function') {
      throw new Error('IngressContentService requires a valid IngressAccessAuthorizer instance (fail-closed).');
    }
    if (!options.inspector || typeof options.inspector.inspect !== 'function') {
      throw new Error('IngressContentService requires a valid IngressContentInspector instance (fail-closed).');
    }
    const maxSampleBytes = options.maxSampleBytes ?? DEFAULT_SAMPLE_LIMIT_BYTES;
    if (!Number.isSafeInteger(maxSampleBytes) || maxSampleBytes <= 0) {
      throw new Error('IngressContentService requires maxSampleBytes to be a positive safe integer.');
    }

    this.blobStore = options.blobStore;
    this.contentStore = options.contentStore;
    this.authorizer = options.authorizer;
    this.inspector = options.inspector;
    this.storageBackend = options.storageBackend ?? 'local_fs';
    this.maxSampleBytes = maxSampleBytes;
    this.nowProvider = options.nowProvider ?? (() => new Date().toISOString());
  }

  /**
   * Ingesta um conteúdo binário/documental:
   * 1. Valida OperationalContext confiável.
   * 2. Autoriza operação 'create'.
   * 3. Grava no BlobStore (staging, streaming hash SHA-256).
   * 4. Obtém amostra limitada em RAM via streaming (fail-closed se indisponível).
   * 5. Executa inspeção server-side (determina verifiedMimeType ou rejeita).
   * 6. Se rejeitado, interrompe sem criar registro canônico.
   * 7. Se aceito, persiste IngressContentRecord append-only internamente.
   * 8. Retorna a projeção pública IngressContentView (sem storageBackend/storageKey) e a IngressContentRef.
   */
  async ingestContent(
    params: IngestContentParams,
    context: OperationalContext
  ): Promise<{ record: IngressContentView; ref: IngressContentRef }> {
    validateOperationalContext(context);

    const isAuthorized = await this.authorizer.authorize({
      operation: 'create',
      context,
    });
    if (!isAuthorized) {
      throw new IngressAuthorizationError('create', undefined, 'Unauthorized to ingest content in current operational context.');
    }

    const contentId = (params.contentId ?? `ing_${randomUUID()}`) as IngressContentId;
    validateIngressContentId(contentId);

    // 1. Materializar no BlobStore
    const putResult = await this.blobStore.putBlob(params.data, {
      expectedSha256: params.expectedSha256,
      maxBytes: params.maxBytes,
    });

    // 2. Obter amostra limitada em RAM a partir de stream (FAIL CLOSED se falhar)
    let sampleBuffer: Buffer;
    try {
      const stream = await this.blobStore.getBlobStream(putResult.storageKey, putResult.sha256);
      sampleBuffer = await readStreamSample(stream, this.maxSampleBytes);
    } catch (err: any) {
      throw new IngressContentInspectionError(
        `Failed to obtain verified content sample for inspection: ${err.message}`,
        params.declaredMimeType
      );
    }

    // 3. Inspecionar conteúdo server-side com sampleBuffer limitado
    const inspection = await this.inspector.inspect({
      declaredMimeType: params.declaredMimeType,
      byteSize: putResult.byteSize,
      sha256: putResult.sha256,
      sampleBuffer,
    });

    if (!inspection.accepted || !inspection.verifiedMimeType) {
      throw new IngressContentInspectionError(
        inspection.rejectionReason ?? 'Content rejected by server-side inspector policy.',
        params.declaredMimeType
      );
    }

    const receivedAt = this.nowProvider();

    // 4. Montar IngressContentRecord interno derivando autoridade estritamente do OperationalContext
    const internalRecord: IngressContentRecord = Object.freeze({
      contentId,
      actor: Object.freeze({ ...context.actor }),
      ...(context.userId ? { userId: context.userId } : {}),
      ...(context.sessionRef ? { sessionRef: context.sessionRef } : {}),
      ...(context.contextSubjectRef
        ? { contextSubjectRef: sanitizeContextSubjectRef(context.contextSubjectRef) }
        : {}),
      ...(params.sourceRefId ? { sourceRefId: params.sourceRefId } : {}),
      ...(params.declaredMimeType ? { declaredMimeType: params.declaredMimeType.trim() } : {}),
      verifiedMimeType: inspection.verifiedMimeType.trim(),
      sha256: putResult.sha256,
      byteSize: putResult.byteSize,
      storageBackend: this.storageBackend,
      storageKey: putResult.storageKey,
      receivedAt,
      ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
    });

    validateIngressContentRecord(internalRecord);

    const savedRecord = await this.contentStore.saveContent(internalRecord);
    const ref: IngressContentRef = Object.freeze({ contentId: savedRecord.contentId });
    const view: IngressContentView = toIngressContentView(savedRecord);

    return { record: view, ref };
  }

  /**
   * Helper interno para carregar e autorizar o IngressContentRecord completo
   * necessário para operações do BlobStore e checagens de integridade.
   */
  private async getInternalRecord(
    contentId: IngressContentId,
    context: OperationalContext
  ): Promise<IngressContentRecord> {
    validateIngressContentId(contentId);
    validateOperationalContext(context);

    const record = await this.contentStore.getContent(contentId);
    if (!record) {
      throw new IngressContentNotFoundError(contentId);
    }

    // Verifica expiração temporal
    if (record.expiresAt) {
      const now = new Date(this.nowProvider()).getTime();
      const expires = new Date(record.expiresAt).getTime();
      if (now > expires) {
        throw new IngressContentExpiredError(contentId, record.expiresAt);
      }
    }

    const isAuthorized = await this.authorizer.authorize({
      operation: 'read',
      context,
      content: record,
      contentId,
    });
    if (!isAuthorized) {
      throw new IngressAuthorizationError('read', contentId);
    }

    return record;
  }

  /**
   * Obtém a projeção pública IngressContentView após verificar autorização e expiração.
   * Não expõe storageBackend nem storageKey.
   */
  async getRecord(
    contentId: IngressContentId,
    context: OperationalContext
  ): Promise<IngressContentView> {
    const internalRecord = await this.getInternalRecord(contentId, context);
    return toIngressContentView(internalRecord);
  }

  /**
   * Lê o conteúdo binário do blob após verificar autorização, expiração e integridade criptográfica.
   * Retorna os bytes do blob acompanhados da projeção pública IngressContentView.
   */
  async getContent(
    contentId: IngressContentId,
    context: OperationalContext
  ): Promise<{ record: IngressContentView; data: Buffer }> {
    const internalRecord = await this.getInternalRecord(contentId, context);

    const verifyResult = await this.blobStore.verifyBlob(
      internalRecord.storageKey,
      internalRecord.sha256,
      internalRecord.byteSize
    );

    if (!verifyResult.valid) {
      throw new IngressIntegrityError(contentId);
    }

    const data = await this.blobStore.getBlob(internalRecord.storageKey, internalRecord.sha256);
    return { record: toIngressContentView(internalRecord), data };
  }

  /**
   * Obtém stream do blob após verificar autorização, expiração e integridade.
   * Retorna o ReadableStream acompanhado da projeção pública IngressContentView.
   */
  async getContentStream(
    contentId: IngressContentId,
    context: OperationalContext
  ): Promise<{ record: IngressContentView; stream: NodeJS.ReadableStream }> {
    const internalRecord = await this.getInternalRecord(contentId, context);

    const verifyResult = await this.blobStore.verifyBlob(
      internalRecord.storageKey,
      internalRecord.sha256,
      internalRecord.byteSize
    );

    if (!verifyResult.valid) {
      throw new IngressIntegrityError(contentId);
    }

    const stream = await this.blobStore.getBlobStream(internalRecord.storageKey, internalRecord.sha256);
    return { record: toIngressContentView(internalRecord), stream };
  }
}
