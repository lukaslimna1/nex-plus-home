/**
 * NEX+ · Evidence Artifact Store Integrity Audit
 * Escopo 0.85 (Bloco 0.85C · Hardening Pós-Red-Team)
 *
 * Módulo de varredura e auditoria técnica read-only de integridade física e relacional
 * com contexto de autorização obrigatório ('integrity_inspect').
 */

import type { ArtifactBlobStore } from './blob-store';
import type {
  EvidenceAuditFinding,
  EvidenceAuditReport,
  ArtifactAccessAuthorizer,
  ArtifactAccessContext,
} from './contracts';
import { PgEvidenceArtifactPersistenceAdapter } from './postgres';
import { ArtifactAccessDeniedError } from './errors';
import { buildStorageKeyFromSha256 } from './validators';

export async function auditArtifactStore(
  blobStore: ArtifactBlobStore,
  persistence: PgEvidenceArtifactPersistenceAdapter,
  authorizer: ArtifactAccessAuthorizer,
  context: ArtifactAccessContext
): Promise<EvidenceAuditReport> {
  if (!context) {
    throw new ArtifactAccessDeniedError(
      'integrity_inspect',
      'MISSING_ACCESS_CONTEXT',
      'ArtifactAccessContext is required for auditArtifactStore.'
    );
  }

  const authDecision = await authorizer.authorize(context, 'integrity_inspect');
  if (!authDecision.granted) {
    throw new ArtifactAccessDeniedError('integrity_inspect', authDecision.reasonCode, authDecision.explanation);
  }

  const findings: EvidenceAuditFinding[] = [];
  const registeredArtifacts = await persistence.listAllArtifactMetadata();
  const registeredStorageKeys = new Set<string>();

  let healthyCount = 0;

  // 1. Verificação de cada artefato registrado no PostgreSQL contra o filesystem
  for (const artifact of registeredArtifacts) {
    const expectedCanonicalKey = buildStorageKeyFromSha256(artifact.sha256);
    registeredStorageKeys.add(artifact.storageKey);

    if (artifact.storageKey !== expectedCanonicalKey) {
      findings.push({
        type: 'hash_mismatch',
        artifactId: artifact.artifactId,
        storageKey: artifact.storageKey,
        expectedSha256: artifact.sha256,
        details: `Artifact storageKey '${artifact.storageKey}' does not match canonical key '${expectedCanonicalKey}'.`,
      });
      continue;
    }

    const exists = await blobStore.hasBlob(artifact.storageKey);
    if (!exists) {
      findings.push({
        type: 'missing_blob',
        artifactId: artifact.artifactId,
        storageKey: artifact.storageKey,
        expectedSha256: artifact.sha256,
        expectedSize: artifact.byteSize,
        details: `Blob file does not exist on disk for registered artifact '${artifact.artifactId}'.`,
      });
      continue;
    }

    const verifyResult = await blobStore.verifyBlob(
      artifact.storageKey,
      artifact.sha256,
      artifact.byteSize
    );

    if (!verifyResult.valid) {
      if (verifyResult.actualSize !== undefined && verifyResult.actualSize !== artifact.byteSize) {
        findings.push({
          type: 'size_mismatch',
          artifactId: artifact.artifactId,
          storageKey: artifact.storageKey,
          expectedSize: artifact.byteSize,
          actualSize: verifyResult.actualSize,
          expectedSha256: artifact.sha256,
          actualSha256: verifyResult.actualSha256,
          details: verifyResult.error,
        });
      } else if (verifyResult.actualSha256 !== undefined && verifyResult.actualSha256 !== artifact.sha256) {
        findings.push({
          type: 'hash_mismatch',
          artifactId: artifact.artifactId,
          storageKey: artifact.storageKey,
          expectedSha256: artifact.sha256,
          actualSha256: verifyResult.actualSha256,
          expectedSize: artifact.byteSize,
          actualSize: verifyResult.actualSize,
          details: verifyResult.error,
        });
      } else {
        findings.push({
          type: 'missing_blob',
          artifactId: artifact.artifactId,
          storageKey: artifact.storageKey,
          details: verifyResult.error,
        });
      }
    } else {
      healthyCount++;
    }
  }

  // 2. Detecção de Blobs Físicos Órfãos (presentes no disco mas sem registro PostgreSQL)
  const physicalKeys = await blobStore.listStorageKeys();
  for (const physicalKey of physicalKeys) {
    if (!registeredStorageKeys.has(physicalKey)) {
      findings.push({
        type: 'orphan_blob',
        storageKey: physicalKey,
        details: `Physical blob '${physicalKey}' exists on disk without a corresponding PostgreSQL metadata record.`,
      });
    }
  }

  return {
    auditedAt: new Date().toISOString(),
    totalRegistered: registeredArtifacts.length,
    healthyCount,
    findings,
  };
}
