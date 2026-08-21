/**
 * NEX+ · Evidence Artifact Store Backup & Restore
 * Escopo 0.85 (Bloco 0.85C · Hardening Pós-Red-Team)
 *
 * Módulo de exportação de backup com integridade integral de todos os registros
 * e restore transacional atômico com preflight prévio total.
 */

import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
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
  ArtifactNotFoundError,
} from './errors';
import {
  isValidSha256,
  validateCanonicalStorageKey,
  buildStorageKeyFromSha256,
  validateEvidenceBackupManifest,
} from './validators';
import { LocalFsArtifactBlobStore } from './local-fs';

const MANIFEST_FILE_NAME = 'nex-evidence-backup-v1.json';
const MANIFEST_HASH_FILE_NAME = 'nex-evidence-backup-v1.sha256';

async function calculateStreamSha256(filePath: string): Promise<{ sha256: string; byteSize: number }> {
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

export async function backupArtifactStore(
  service: EvidenceArtifactService,
  destinationDir: string,
  authorizer: ArtifactAccessAuthorizer,
  context: ArtifactAccessContext
): Promise<EvidenceBackupResult> {
  if (!context) {
    throw new ArtifactAccessDeniedError('backup', 'MISSING_ACCESS_CONTEXT', 'ArtifactAccessContext is required for backupArtifactStore.');
  }

  const authDecision = await authorizer.authorize(context, 'backup');
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

  // Proteção contra symlink/junction no destino
  const destStat = await fs.lstat(destResolved);
  if (destStat.isSymbolicLink()) {
    throw new ArtifactStorageError(`Backup destination cannot be a symbolic link or junction: '${destResolved}'.`);
  }

  const artifacts = await service.persistence.listAllArtifactMetadata();
  const sourceRefs = await service.persistence.listAllSourceRefs();
  const attemptLinks = await service.persistence.listAllAttemptLinks();

  let bytesTransferred = 0;

  // Cópia com verificação rígida: Se QUALQUER artefato registrado estiver ausente ou corrompido, FALHA O BACKUP
  for (const artifact of artifacts) {
    const canonicalKey = buildStorageKeyFromSha256(artifact.sha256);
    if (artifact.storageKey !== canonicalKey) {
      throw new ArtifactIntegrityError({
        storageKey: artifact.storageKey,
        expectedSha256: artifact.sha256,
        message: `Registered artifact '${artifact.artifactId}' has non-canonical storageKey '${artifact.storageKey}'.`,
      });
    }

    const has = await service.blobStore.hasBlob(artifact.storageKey);
    if (!has) {
      throw new ArtifactNotFoundError(
        `Registered artifact '${artifact.artifactId}' blob is missing on disk at '${artifact.storageKey}'. Backup aborted.`
      );
    }

    const blobBuffer = await service.blobStore.getBlob(artifact.storageKey, artifact.sha256);
    const destBlobPath = path.join(destResolved, artifact.storageKey);

    await fs.mkdir(path.dirname(destBlobPath), { recursive: true });
    await fs.writeFile(destBlobPath, blobBuffer);

    // Validação de integridade no destino copiado
    const destCheck = await calculateStreamSha256(destBlobPath);
    if (destCheck.sha256 !== artifact.sha256 || destCheck.byteSize !== artifact.byteSize) {
      throw new ArtifactIntegrityError({
        storageKey: artifact.storageKey,
        expectedSha256: artifact.sha256,
        actualSha256: destCheck.sha256,
        message: `Backup copy failed integrity verification for '${artifact.storageKey}'.`,
      });
    }

    bytesTransferred += blobBuffer.length;
  }

  const manifest: EvidenceBackupManifest = {
    schemaVersion: '1.0',
    createdAt: new Date().toISOString(),
    artifacts,
    sourceRefs,
    attemptLinks,
  };

  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestSha256 = createHash('sha256').update(manifestJson).digest('hex');

  const stagingManifestPath = path.join(destResolved, `_staging_manifest_${Date.now()}.tmp`);
  const stagingHashPath = path.join(destResolved, `_staging_hash_${Date.now()}.tmp`);

  const manifestPath = path.join(destResolved, MANIFEST_FILE_NAME);
  const manifestHashPath = path.join(destResolved, MANIFEST_HASH_FILE_NAME);

  // Escrita em staging e rename atômico final (Manifest só aparece após conclusão total)
  await fs.writeFile(stagingManifestPath, manifestJson, 'utf-8');
  await fs.writeFile(stagingHashPath, `${manifestSha256}  ${MANIFEST_FILE_NAME}\n`, 'utf-8');

  await fs.rename(stagingManifestPath, manifestPath);
  await fs.rename(stagingHashPath, manifestHashPath);

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
  context: ArtifactAccessContext
): Promise<EvidenceRestoreResult> {
  if (!context) {
    throw new ArtifactAccessDeniedError('restore', 'MISSING_ACCESS_CONTEXT', 'ArtifactAccessContext is required for restoreArtifactStore.');
  }

  const authDecision = await authorizer.authorize(context, 'restore');
  if (!authDecision.granted) {
    throw new ArtifactAccessDeniedError('restore', authDecision.reasonCode, authDecision.explanation);
  }

  const backupResolved = path.resolve(backupDir);

  // Validação de symlink no diretório de backup
  const backupStat = await fs.lstat(backupResolved);
  if (backupStat.isSymbolicLink()) {
    throw new ArtifactStorageError(`Backup source directory cannot be a symbolic link: '${backupResolved}'.`);
  }

  const canonicalBackupRoot = await fs.realpath(backupResolved);

  const manifestPath = path.join(canonicalBackupRoot, MANIFEST_FILE_NAME);
  const manifestHashPath = path.join(canonicalBackupRoot, MANIFEST_HASH_FILE_NAME);

  let manifestRaw: string;
  let hashFileContent: string;

  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf-8');
    hashFileContent = await fs.readFile(manifestHashPath, 'utf-8');
  } catch (err: any) {
    throw new ArtifactStorageError(`Failed to read backup manifest files from '${canonicalBackupRoot}': ${err.message}`);
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

  // Validação estrutural profunda do Manifest ANTES de qualquer alteração
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(manifestRaw);
  } catch (parseErr: any) {
    throw new ArtifactStorageError(`Malformed JSON in backup manifest: ${parseErr.message}`);
  }

  const validatedManifest = validateEvidenceBackupManifest(parsedManifest);

  // ==========================================================================
  // PREFLIGHT TOTAL DE TODOS OS BLOBS DO BACKUP ANTES DE QUALQUER ESCRITA LIVE
  // ==========================================================================
  const preflightBlobs: { artifact: typeof validatedManifest.artifacts[number]; blobPath: string }[] = [];

  for (const artifact of validatedManifest.artifacts) {
    const expectedKey = buildStorageKeyFromSha256(artifact.sha256);
    if (artifact.storageKey !== expectedKey) {
      throw new ArtifactIntegrityError({
        storageKey: artifact.storageKey,
        expectedSha256: artifact.sha256,
        message: `Manifest artifact '${artifact.artifactId}' has non-canonical storageKey '${artifact.storageKey}'.`,
      });
    }

    validateCanonicalStorageKey(artifact.storageKey, artifact.sha256);

    const parts = artifact.storageKey.split('/');
    const backupBlobPath = path.join(canonicalBackupRoot, ...parts);

    // Validação de confinamento do path no backup root
    const rel = path.relative(canonicalBackupRoot, backupBlobPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ArtifactStorageError(`Path traversal attempt in backup manifest for '${artifact.storageKey}'.`);
    }

    try {
      const bStat = await fs.lstat(backupBlobPath);
      if (bStat.isSymbolicLink() || !bStat.isFile()) {
        throw new ArtifactStorageError(`Backup blob '${artifact.storageKey}' is not a regular file (symlinks rejected).`);
      }
    } catch (err: any) {
      throw new ArtifactNotFoundError(`Backup blob '${artifact.storageKey}' was not found in backup package: ${err.message}`);
    }

    // Validação criptográfica do arquivo de backup
    const blobCheck = await calculateStreamSha256(backupBlobPath);
    if (blobCheck.sha256 !== artifact.sha256 || blobCheck.byteSize !== artifact.byteSize) {
      throw new ArtifactIntegrityError({
        storageKey: artifact.storageKey,
        expectedSha256: artifact.sha256,
        actualSha256: blobCheck.sha256,
        message: `Backup blob '${artifact.storageKey}' failed preflight integrity check during restore.`,
      });
    }

    preflightBlobs.push({ artifact, blobPath: backupBlobPath });
  }

  // ==========================================================================
  // INSTALAÇÃO DE BLOBS NO LIVE BLOB STORE APÓS PREFLIGHT COMPLETO
  // ==========================================================================
  let restoredCount = 0;
  let reusedBlobCount = 0;

  for (const item of preflightBlobs) {
    const blobBuffer = await fs.readFile(item.blobPath);
    const putResult = await service.blobStore.putBlob(blobBuffer, {
      expectedSha256: item.artifact.sha256,
    });

    if (putResult.sha256 !== item.artifact.sha256 || putResult.storageKey !== item.artifact.storageKey) {
      throw new ArtifactIntegrityError({
        storageKey: item.artifact.storageKey,
        expectedSha256: item.artifact.sha256,
        actualSha256: putResult.sha256,
        message: `Installed blob storageKey or hash mismatch during restore.`,
      });
    }

    if (putResult.alreadyExisted) {
      reusedBlobCount++;
    }
    restoredCount++;
  }

  // ==========================================================================
  // RESTAURAÇÃO ATÔMICA DOS METADADOS NO POSTGRESQL EM TRANSAÇÃO ÚNICA
  // ==========================================================================
  await service.persistence.restoreManifestMetadataAtomically(validatedManifest);

  return {
    restoredCount,
    reusedBlobCount,
    skippedCount: 0,
  };
}
