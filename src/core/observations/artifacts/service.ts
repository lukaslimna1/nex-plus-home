/**
 * NEX+ · Evidence Artifact Service Orchestrator
 * Escopo 0.85 (Bloco 0.85C)
 *
 * Serviço de orquestração de materialização, consulta, autorização e integridade
 * de artefatos duráveis de evidência.
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
   */
  async materializeArtifact(
    data: Buffer | NodeJS.ReadableStream,
    params: MaterializeArtifactParams,
    accessContext?: ArtifactAccessContext
  ): Promise<EvidenceArtifactRecord> {
    // 1. Verificação Estrita de Segredos (Fail-Closed)
    if (params.containsSecretMaterial === true) {
      throw new SecretMaterialRejectedError(
        'containsSecretMaterial was explicitly set to true. No durable blob or metadata will be persisted.'
      );
    }

    // 2. Autorização de escrita se contexto fornecido
    if (accessContext) {
      const authDecision = await this.authorizer.authorize(accessContext);
      if (!authDecision.granted) {
        throw new ArtifactAccessDeniedError('write', authDecision.reasonCode, authDecision.explanation);
      }
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
      storageKey: blobResult.storageKey,
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
    // 1. Autorização Obrigatória de Leitura
    const authDecision = await this.authorizer.authorize(accessContext);
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
    accessContext?: ArtifactAccessContext
  ): Promise<EvidenceArtifactRecord | null> {
    if (accessContext) {
      const authDecision = await this.authorizer.authorize(accessContext);
      if (!authDecision.granted) {
        throw new ArtifactAccessDeniedError('read', authDecision.reasonCode, authDecision.explanation);
      }
    }
    return this.persistence.getArtifactMetadata(artifactId);
  }

  async recordSourceRef(
    source: SourceRefRecord,
    accessContext?: ArtifactAccessContext
  ): Promise<SourceRefRecord> {
    if (accessContext) {
      const authDecision = await this.authorizer.authorize(accessContext);
      if (!authDecision.granted) {
        throw new ArtifactAccessDeniedError('write', authDecision.reasonCode, authDecision.explanation);
      }
    }
    return this.persistence.recordSourceRef(source);
  }

  async getSourceRef(
    sourceId: SourceRefId,
    accessContext?: ArtifactAccessContext
  ): Promise<SourceRefRecord | null> {
    if (accessContext) {
      const authDecision = await this.authorizer.authorize(accessContext);
      if (!authDecision.granted) {
        throw new ArtifactAccessDeniedError('read', authDecision.reasonCode, authDecision.explanation);
      }
    }
    return this.persistence.getSourceRef(sourceId);
  }

  async linkArtifactToAttempt(artifactId: EvidenceArtifactRefId, attemptId: AttemptId): Promise<void> {
    return this.persistence.linkArtifactToAttempt(artifactId, attemptId);
  }
}
