/**
 * NEX+ · Evidence Artifact Store & Integrity Contracts
 * Escopo 0.85 (Bloco 0.85C · Hardening Pós-Red-Team)
 *
 * Contratos canônicos para materialização, persistência, autorização,
 * integridade e backup de artefatos de evidência duráveis.
 */

import type {
  EvidenceArtifactRefId,
  SourceRefId,
  SourceRefKind,
  NonExecutionEvidenceArtifactKind,
  Actor,
} from '../contracts';
import type { SensitivityClass } from '../../policy/contracts';
import type { AttemptId } from '../../execution/contracts';

// ============================================================================
// 1. REGISTRO CANÔNICO DE METADADOS DO ARTEFATO DURÁVEL
// ============================================================================

export type ArtifactStorageBackend = 'local_fs';

export type ArtifactRetentionClass = 'durable_evidence';

export interface EvidenceArtifactRecord {
  readonly artifactId: EvidenceArtifactRefId;
  readonly kind: NonExecutionEvidenceArtifactKind;
  readonly sourceRefId?: SourceRefId;
  readonly sha256: string; // 64 caracteres hex lowercase
  readonly byteSize: number; // Safe non-negative integer
  readonly mimeType: string;
  readonly storageBackend: ArtifactStorageBackend;
  readonly storageKey: string; // Ex: sha256/ab/cd/<hash>
  readonly safeDescription?: string;
  readonly capturedAt: string; // ISO 8601 UTC ('Z')
  readonly sensitivity: SensitivityClass; // 'NORMAL' | 'LOCAL_ONLY'
  readonly containsSecretMaterial: false; // Sempre false para artefatos duráveis canônicos
  readonly redactionApplied: boolean;
  readonly redactionMethodRef?: string;
  readonly retentionClass: ArtifactRetentionClass; // 'durable_evidence'
}

// ============================================================================
// 2. PARÂMETROS DE MATERIALIZAÇÃO DE ARTEFATO
// ============================================================================

export interface MaterializeArtifactParams {
  readonly artifactId: EvidenceArtifactRefId;
  readonly kind: NonExecutionEvidenceArtifactKind;
  readonly sourceRefId?: SourceRefId;
  readonly mimeType?: string;
  readonly safeDescription?: string;
  readonly capturedAt?: string;
  readonly sensitivity?: SensitivityClass;
  readonly containsSecretMaterial: boolean; // Obrigatório explícito
  readonly redactionApplied?: boolean;
  readonly redactionMethodRef?: string;
  readonly expectedSha256?: string;
  readonly attemptId?: AttemptId;
}

// ============================================================================
// 3. REGISTRO DE FONTE (SourceRef)
// ============================================================================

export interface SourceRefRecord {
  readonly sourceId: SourceRefId;
  readonly kind: SourceRefKind;
  readonly name: string;
  readonly locationOrUri?: string;
  readonly safeMetadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string; // ISO 8601 UTC ('Z')
}

// ============================================================================
// 4. AUTORIZAÇÃO E ACL BOUNDARY (Fail-Closed Estrutural)
// ============================================================================

export type ArtifactAccessOperation =
  | 'read'
  | 'write'
  | 'backup'
  | 'restore'
  | 'integrity_inspect';

export interface ArtifactAccessContext {
  readonly actor?: Actor;
  readonly operation: ArtifactAccessOperation;
  readonly artifactId?: EvidenceArtifactRefId;
  readonly scope?: string;
}

export interface ArtifactAccessDecision {
  readonly granted: boolean;
  readonly reasonCode: string;
  readonly explanation?: string;
}

export interface ArtifactAccessAuthorizer {
  authorize(context: ArtifactAccessContext, expectedOperation?: ArtifactAccessOperation): Promise<ArtifactAccessDecision>;
}

// ============================================================================
// 5. AUDITORIA E INTEGRIDADE DO STORE
// ============================================================================

export type EvidenceAuditFindingType =
  | 'missing_blob'
  | 'hash_mismatch'
  | 'size_mismatch'
  | 'orphan_blob';

export interface EvidenceAuditFinding {
  readonly type: EvidenceAuditFindingType;
  readonly artifactId?: EvidenceArtifactRefId;
  readonly storageKey: string;
  readonly expectedSha256?: string;
  readonly actualSha256?: string;
  readonly expectedSize?: number;
  readonly actualSize?: number;
  readonly details?: string;
}

export interface EvidenceAuditReport {
  readonly auditedAt: string;
  readonly totalRegistered: number;
  readonly healthyCount: number;
  readonly findings: readonly EvidenceAuditFinding[];
}

// ============================================================================
// 6. BACKUP E RESTORE
// ============================================================================

export interface EvidenceArtifactAttemptLink {
  readonly artifactId: EvidenceArtifactRefId;
  readonly attemptId: AttemptId;
  readonly linkedAt: string;
}

export interface EvidenceBackupManifest {
  readonly schemaVersion: '1.0';
  readonly createdAt: string;
  readonly artifacts: readonly EvidenceArtifactRecord[];
  readonly sourceRefs: readonly SourceRefRecord[];
  readonly attemptLinks: readonly EvidenceArtifactAttemptLink[];
}

export interface EvidenceBackupResult {
  readonly backupDir: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly artifactsCount: number;
  readonly bytesTransferred: number;
}

export interface EvidenceRestoreResult {
  readonly restoredCount: number;
  readonly reusedBlobCount: number;
  readonly skippedCount: number;
}
