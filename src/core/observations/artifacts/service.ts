/**
 * NEX+ · Evidence Artifact Service Orchestrator
 * Escopo 0.85 (Bloco 0.85C · Hardening Pós-Red-Team)
 *
 * Serviço de orquestração de materialização, consulta, autorização e integridade
 * de artefatos duráveis de evidência com contexto ACL obrigatório e fail-closed por padrão.
 */

import type {
  EvidenceArtifactRefId,
  SourceRefId,
} from '../contracts';
import type { AttemptId } from '../../execution/contracts';
import type { ArtifactBlobStore } from './blob-store';
import type {
  EvidenceArtifactRecord,
  MaterializeArtifactParams,
  SourceRefRecord,
  ArtifactAccessAuthorizer,
  ArtifactAccessContext,
} from './contracts';
import { DefaultArtifactAccessAuthorizer } from './authorizer';
import { PgEvidenceArtifactPersistenceAdapter } from './postgres';
import {
  ArtifactAccessDeniedError,
  ArtifactNotFoundError,
  SecretMaterialRejectedError,
  ArtifactInvariantViolationError,
} from './errors';
import {
  buildStorageKeyFromSha256,
  validateCanonicalStorageKey,
} from './validators';

export interface EvidenceArtifactServiceOptions {
  readonly blobStore: ArtifactBlobStore;
  readonly persistence: PgEvidenceArtifactPersistenceAdapter;
  readonly authorizer?: ArtifactAccessAuthorizer;
}

export class EvidenceArtifactService {
  readonly blobStore: ArtifactBlobStore;
  readonly persistence: PgEvidenceArtifactPersistenceAdapter;
  readonly authorizer: ArtifactAccessAuthorizer;

  constructor(options: EvidenceArtifactServiceOptions) {
    this.blobStore = options.blobStore;
    this.persistence = options.persistence;
    this.authorizer = options.authorizer ?? new DefaultArtifactAccessAuthorizer();
  }

  /**
   * Materializa um artefato durável de evidência física no store e registra seus metadados no PostgreSQL.
   * Exige accessContext com autorização explícita para 'write'.
   */
  async materializeArtifact(
    data: Buffer | NodeJS.ReadableStream,
    params: MaterializeArtifactParams,
    accessContext: ArtifactAccessContext
  ): Promise<EvidenceArtifactRecord> {
    // 1. Autorização Obrigatória de Escrita (Fail-Closed)
    if (!accessContext) {
      throw new ArtifactAccessDeniedError('write', 'MISSING_ACCESS_CONTEXT', 'ArtifactAccessContext is required for materializeArtifact.');
    }

    const authDecision = await this.authorizer.authorize(accessContext, 'write');
    if (!authDecision.granted) {
      throw new ArtifactAccessDeniedError('write', authDecision.reasonCode, authDecision.explanation);
    }

    // 2. Verificação Estrita de Segredos (Fail-Closed)
    if (params.containsSecretMaterial === true) {
      throw new SecretMaterialRejectedError(
        'containsSecretMaterial was explicitly set to true. No durable blob or metadata will be persisted.'
      );
    }

    // 3. Validação de SourceRef prévia
    if (params.sourceRefId) {
      const source = await this.persistence.getSourceRef(params.sourceRefId);
      if (!source) {
        throw new ArtifactInvariantViolationError(
          'SOURCE_REF_NOT_FOUND',
          `Referenced sourceRefId '${params.sourceRefId}' does not exist in persistence.`
        );
      }
    }

    // 4. Gravação física do blob no storage content-addressed
    const blobResult = await this.blobStore.putBlob(data, {
      expectedSha256: params.expectedSha256,
    });

    const expectedStorageKey = buildStorageKeyFromSha256(blobResult.sha256);
    validateCanonicalStorageKey(blobResult.storageKey, blobResult.sha256);

    const capturedAt = params.capturedAt ?? new Date().toISOString();
    const sensitivity = params.sensitivity ?? 'NORMAL';
    const mimeType = params.mimeType ?? 'application/octet-stream';

    const record: EvidenceArtifactRecord = {
      artifactId: params.artifactId,
      kind: params.kind,
      sourceRefId: params.sourceRefId,
      sha256: blobResult.sha256,
      byteSize: blobResult.byteSize,
      mimeType,
      storageBackend: 'local_fs',
      storageKey: expectedStorageKey,
      safeDescription: params.safeDescription,
      capturedAt,
      sensitivity,
      containsSecretMaterial: false,
      redactionApplied: params.redactionApplied ?? false,
      redactionMethodRef: params.redactionMethodRef,
      retentionClass: 'durable_evidence',
    };

    // 5. Persistência de metadados no PostgreSQL
    return this.persistence.recordArtifactMetadata(record, params.attemptId);
  }

  /**
   * Lê o conteúdo completo de um artefato durável com autorização de acesso e verificação ativa de integridade.
   */
  async readArtifact(
    artifactId: EvidenceArtifactRefId,
    accessContext: ArtifactAccessContext
  ): Promise<{ metadata: EvidenceArtifactRecord; bytes: Buffer }> {
    // 1. Autorização Obrigatória de Leitura (Fail-Closed)
    if (!accessContext) {
      throw new ArtifactAccessDeniedError('read', 'MISSING_ACCESS_CONTEXT', 'ArtifactAccessContext is required for readArtifact.');
    }

    const authDecision = await this.authorizer.authorize(accessContext, 'read');
    if (!authDecision.granted) {
      throw new ArtifactAccessDeniedError('read', authDecision.reasonCode, authDecision.explanation);
    }

    // 2. Busca de Metadados no PostgreSQL
    const metadata = await this.persistence.getArtifactMetadata(artifactId);
    if (!metadata) {
      throw new ArtifactNotFoundError(artifactId);
    }

    // 3. Leitura Criptograficamente Verificada do Blob Físico
    const bytes = await this.blobStore.getBlob(metadata.storageKey, metadata.sha256);

    return {
      metadata,
      bytes,
    };
  }

  async getArtifactMetadata(
    artifactId: EvidenceArtifactRefId,
    accessContext: ArtifactAccessContext
  ): Promise<EvidenceArtifactRecord | null> {
    if (!accessContext) {
      throw new ArtifactAccessDeniedError('read', 'MISSING_ACCESS_CONTEXT', 'ArtifactAccessContext is required for getArtifactMetadata.');
    }

    const authDecision = await this.authorizer.authorize(accessContext, 'read');
    if (!authDecision.granted) {
      throw new ArtifactAccessDeniedError('read', authDecision.reasonCode, authDecision.explanation);
    }

    return this.persistence.getArtifactMetadata(artifactId);
  }

  async recordSourceRef(
    source: SourceRefRecord,
    accessContext: ArtifactAccessContext
  ): Promise<SourceRefRecord> {
    if (!accessContext) {
      throw new ArtifactAccessDeniedError('write', 'MISSING_ACCESS_CONTEXT', 'ArtifactAccessContext is required for recordSourceRef.');
    }

    const authDecision = await this.authorizer.authorize(accessContext, 'write');
    if (!authDecision.granted) {
      throw new ArtifactAccessDeniedError('write', authDecision.reasonCode, authDecision.explanation);
    }

    return this.persistence.recordSourceRef(source);
  }

  async getSourceRef(
    sourceId: SourceRefId,
    accessContext: ArtifactAccessContext
  ): Promise<SourceRefRecord | null> {
    if (!accessContext) {
      throw new ArtifactAccessDeniedError('read', 'MISSING_ACCESS_CONTEXT', 'ArtifactAccessContext is required for getSourceRef.');
    }

    const authDecision = await this.authorizer.authorize(accessContext, 'read');
    if (!authDecision.granted) {
      throw new ArtifactAccessDeniedError('read', authDecision.reasonCode, authDecision.explanation);
    }

    return this.persistence.getSourceRef(sourceId);
  }

  async linkArtifactToAttempt(
    artifactId: EvidenceArtifactRefId,
    attemptId: AttemptId,
    accessContext: ArtifactAccessContext
  ): Promise<void> {
    if (!accessContext) {
      throw new ArtifactAccessDeniedError('write', 'MISSING_ACCESS_CONTEXT', 'ArtifactAccessContext is required for linkArtifactToAttempt.');
    }

    const authDecision = await this.authorizer.authorize(accessContext, 'write');
    if (!authDecision.granted) {
      throw new ArtifactAccessDeniedError('write', authDecision.reasonCode, authDecision.explanation);
    }

    return this.persistence.linkArtifactToAttempt(artifactId, attemptId);
  }
}
