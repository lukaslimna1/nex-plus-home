/**
 * NEX+ · Evidence Artifact Store Backup & Restore
 * Escopo 0.85 (Bloco 0.85C)
 *
 * Módulo de exportação de backup estruturado com manifest versionado (SHA-256)
 * e restore idempotente com verificação criptográfica estrita.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { EvidenceArtifactService } from './service';
import type {
  ArtifactAccessAuthorizer,
  ArtifactAccessContext,
  EvidenceBackupManifest,
  EvidenceBackupResult,
  EvidenceRestoreResult,
} from './contracts';
import {
  ArtifactAccessDeniedError,
  ArtifactIntegrityError,
  ArtifactStorageError,
  ArtifactInvariantViolationError,
} from './errors';
import { isValidSha256 } from './validators';
import { LocalFsArtifactBlobStore } from './local-fs';

const MANIFEST_FILE_NAME = 'nex-evidence-backup-v1.json';
const MANIFEST_HASH_FILE_NAME = 'nex-evidence-backup-v1.sha256';

export async function backupArtifactStore(
  service: EvidenceArtifactService,
  destinationDir: string,
  authorizer: ArtifactAccessAuthorizer,
  context?: ArtifactAccessContext
): Promise<EvidenceBackupResult> {
  const authContext = context ?? {
    operation: 'backup',
    bypassForTesting: true,
  };

  const authDecision = await authorizer.authorize(authContext);
  if (!authDecision.granted) {
    throw new ArtifactAccessDeniedError('backup', authDecision.reasonCode, authDecision.explanation);
  }

  const destResolved = path.resolve(destinationDir);

  // Validação de segurança do destino contra live store
  if (service.blobStore instanceof LocalFsArtifactBlobStore) {
    const liveRoot = service.blobStore.rootDir;
    if (destResolved === liveRoot) {
      throw new ArtifactStorageError('Backup destination directory cannot be equal to live store root.');
    }
    const relToLive = path.relative(liveRoot, destResolved);
    if (!relToLive.startsWith('..') && !path.isAbsolute(relToLive)) {
      throw new ArtifactStorageError('Backup destination directory cannot be inside the live store root.');
    }
    const relFromLive = path.relative(destResolved, liveRoot);
    if (!relFromLive.startsWith('..') && !path.isAbsolute(relFromLive)) {
      throw new ArtifactStorageError('Live store root cannot be inside the backup destination directory.');
    }
  }

  await fs.mkdir(destResolved, { recursive: true });

  const artifacts = await service.persistence.listAllArtifactMetadata();
  const sourceRefs = await service.persistence.listAllSourceRefs();
  const attemptLinks = await service.persistence.listAllAttemptLinks();

  let bytesTransferred = 0;
  const healthyArtifacts: typeof artifacts[number][] = [];

  for (const artifact of artifacts) {
    const hasBlob = await service.blobStore.hasBlob(artifact.storageKey);
    if (!hasBlob) {
      continue;
    }

    const blobBuffer = await service.blobStore.getBlob(artifact.storageKey, artifact.sha256);
    const destBlobPath = path.join(destResolved, artifact.storageKey);

    await fs.mkdir(path.dirname(destBlobPath), { recursive: true });
    await fs.writeFile(destBlobPath, blobBuffer);

    // Validação de verificação no destino
    const destCheckData = await fs.readFile(destBlobPath);
    const destHash = createHash('sha256').update(destCheckData).digest('hex');
    if (destHash !== artifact.sha256) {
      throw new ArtifactIntegrityError({
        storageKey: artifact.storageKey,
        expectedSha256: artifact.sha256,
        actualSha256: destHash,
        message: `Backup copy failed integrity verification for '${artifact.storageKey}'.`,
      });
    }

    bytesTransferred += blobBuffer.length;
    healthyArtifacts.push(artifact);
  }

  const manifest: EvidenceBackupManifest = {
    schemaVersion: '1.0',
    createdAt: new Date().toISOString(),
    artifacts: healthyArtifacts,
    sourceRefs,
    attemptLinks,
  };

  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestSha256 = createHash('sha256').update(manifestJson).digest('hex');

  const manifestPath = path.join(destResolved, MANIFEST_FILE_NAME);
  const manifestHashPath = path.join(destResolved, MANIFEST_HASH_FILE_NAME);

  await fs.writeFile(manifestPath, manifestJson, 'utf-8');
  await fs.writeFile(manifestHashPath, `${manifestSha256}  ${MANIFEST_FILE_NAME}\n`, 'utf-8');

  return {
    backupDir: destResolved,
    manifestPath,
    manifestSha256,
    artifactsCount: artifacts.length,
    bytesTransferred,
  };
}

export async function restoreArtifactStore(
  service: EvidenceArtifactService,
  backupDir: string,
  authorizer: ArtifactAccessAuthorizer,
  context?: ArtifactAccessContext
): Promise<EvidenceRestoreResult> {
  const authContext = context ?? {
    operation: 'restore',
    bypassForTesting: true,
  };

  const authDecision = await authorizer.authorize(authContext);
  if (!authDecision.granted) {
    throw new ArtifactAccessDeniedError('restore', authDecision.reasonCode, authDecision.explanation);
  }

  const backupResolved = path.resolve(backupDir);
  const manifestPath = path.join(backupResolved, MANIFEST_FILE_NAME);
  const manifestHashPath = path.join(backupResolved, MANIFEST_HASH_FILE_NAME);

  let manifestRaw: string;
  let hashFileContent: string;

  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf-8');
    hashFileContent = await fs.readFile(manifestHashPath, 'utf-8');
  } catch (err: any) {
    throw new ArtifactStorageError(`Failed to read backup manifest files from '${backupResolved}': ${err.message}`);
  }

  const calculatedManifestSha256 = createHash('sha256').update(manifestRaw).digest('hex');
  const expectedManifestSha256 = hashFileContent.trim().split(/\s+/)[0]?.toLowerCase();

  if (!isValidSha256(expectedManifestSha256) || calculatedManifestSha256 !== expectedManifestSha256) {
    throw new ArtifactIntegrityError({
      storageKey: MANIFEST_FILE_NAME,
      expectedSha256: expectedManifestSha256,
      actualSha256: calculatedManifestSha256,
      message: `Manifest integrity verification failed: expected hash '${expectedManifestSha256}', calculated '${calculatedManifestSha256}'.`,
    });
  }

  const manifest: EvidenceBackupManifest = JSON.parse(manifestRaw);

  if (manifest.schemaVersion !== '1.0') {
    throw new ArtifactInvariantViolationError(
      'UNSUPPORTED_MANIFEST_VERSION',
      `Unsupported backup manifest schemaVersion: '${manifest.schemaVersion}'. Expected '1.0'.`
    );
  }

  let restoredCount = 0;
  let reusedBlobCount = 0;
  let skippedCount = 0;

  // 1. Restaura SourceRefs
  for (const source of manifest.sourceRefs) {
    await service.persistence.recordSourceRef(source);
  }

  // 2. Restaura Blobs e Metadata
  for (const artifact of manifest.artifacts) {
    const backupBlobPath = path.join(backupResolved, artifact.storageKey);
    let blobBuffer: Buffer;
    try {
      blobBuffer = await fs.readFile(backupBlobPath);
    } catch (err: any) {
      throw new ArtifactStorageError(`Missing blob in backup: '${artifact.storageKey}'.`, err);
    }

    const calculatedBlobSha = createHash('sha256').update(blobBuffer).digest('hex');
    if (calculatedBlobSha !== artifact.sha256) {
      throw new ArtifactIntegrityError({
        storageKey: artifact.storageKey,
        expectedSha256: artifact.sha256,
        actualSha256: calculatedBlobSha,
        message: `Backup blob '${artifact.storageKey}' failed integrity check during restore.`,
      });
    }

    // Instala no live store físico
    const putResult = await service.blobStore.putBlob(blobBuffer, {
      expectedSha256: artifact.sha256,
    });

    if (putResult.alreadyExisted) {
      reusedBlobCount++;
    }

    // Registra metadata no PostgreSQL
    await service.persistence.recordArtifactMetadata(artifact);
    restoredCount++;
  }

  // 3. Restaura AttemptLinks
  for (const link of manifest.attemptLinks) {
    await service.persistence.linkArtifactToAttempt(link.artifactId, link.attemptId);
  }

  return {
    restoredCount,
    reusedBlobCount,
    skippedCount,
  };
}
