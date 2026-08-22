/**
 * NEX+ · Evidence Artifact Store Backup & Restore
 * Escopo 0.85 (Bloco 0.85C · Microbloco 1: Confinamento Físico do Backup)
 *
 * Módulo de exportação de backup com confinamento físico rigoroso contra:
 * - Ancestral junctions e overlapping canônico com live store;
 * - Pre-planted internal junctions em destino não-vazio;
 * - Race conditions durante a gravação através de private staging build directory e promoção atômica.
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

function normalizePathForComparison(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Prova que os caminhos canônicos físicos do live store e do backup são estritamente disjuntos.
 */
export function assertDisjointCanonicalRoots(canonicalLiveRoot: string, canonicalBackupRoot: string): void {
  const normLive = normalizePathForComparison(canonicalLiveRoot);
  const normBackup = normalizePathForComparison(canonicalBackupRoot);

  if (normBackup === normLive) {
    throw new ArtifactStorageError('Backup destination directory cannot be equal to live store root.');
  }

  const relToLive = path.relative(normLive, normBackup);
  if (!relToLive.startsWith('..') && !path.isAbsolute(relToLive)) {
    throw new ArtifactStorageError('Backup destination directory cannot be inside the live store root.');
  }

  const relFromLive = path.relative(normBackup, normLive);
  if (!relFromLive.startsWith('..') && !path.isAbsolute(relFromLive)) {
    throw new ArtifactStorageError('Live store root cannot be inside the backup destination directory.');
  }
}

async function getCanonicalLiveRoot(service: EvidenceArtifactService): Promise<string | null> {
  if (service.blobStore instanceof LocalFsArtifactBlobStore) {
    const rawLiveRoot = service.blobStore.rootDir;
    const resolvedLive = path.resolve(rawLiveRoot);
    try {
      const stat = await fs.lstat(resolvedLive);
      if (stat.isSymbolicLink()) {
        throw new ArtifactStorageError(`Live store root cannot be a symbolic link or junction: '${resolvedLive}'.`);
      }
      return await fs.realpath(resolvedLive);
    } catch (err: any) {
      if (err instanceof ArtifactStorageError) throw err;
      return resolvedLive;
    }
  }
  return null;
}

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

/**
 * Valida rigorosamente cada segmento físico de storageKey contra symlinks/junctions
 * garantindo confinamento absoluto dentro do canonicalRoot.
 */
async function resolveContainedPhysicalPath(
  canonicalRoot: string,
  storageKey: string,
  options: { allowCreate?: boolean; requireFile?: boolean }
): Promise<string> {
  validateCanonicalStorageKey(storageKey);

  const parts = storageKey.split('/'); // ['sha256', 'ab', 'cd', '<64hex>']
  let currentCheckPath = canonicalRoot;

  for (let i = 0; i < parts.length - 1; i++) {
    currentCheckPath = path.join(currentCheckPath, parts[i]);
    try {
      const stat = await fs.lstat(currentCheckPath);
      if (stat.isSymbolicLink()) {
        throw new ArtifactStorageError(`Symlink or junction detected in physical path at '${currentCheckPath}'.`);
      }
      if (!stat.isDirectory()) {
        throw new ArtifactStorageError(`Path component is not a directory at '${currentCheckPath}'.`);
      }
      const realComp = await fs.realpath(currentCheckPath);
      const relToRoot = path.relative(canonicalRoot, realComp);
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        throw new ArtifactStorageError(`Path traversal or junction escape detected at '${currentCheckPath}'.`);
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        if (!options.allowCreate) {
          throw err;
        }
        await fs.mkdir(currentCheckPath, { recursive: true });
        const newStat = await fs.lstat(currentCheckPath);
        if (newStat.isSymbolicLink() || !newStat.isDirectory()) {
          throw new ArtifactStorageError(`Created directory component is invalid or symlink: '${currentCheckPath}'.`);
        }
      } else {
        throw err;
      }
    }
  }

  const finalPath = path.join(canonicalRoot, ...parts);
  const parentDir = path.dirname(finalPath);
  const realParent = await fs.realpath(parentDir);
  const relParent = path.relative(canonicalRoot, realParent);
  if (relParent.startsWith('..') || path.isAbsolute(relParent)) {
    throw new ArtifactStorageError(`Parent directory of final target escapes canonical root: '${finalPath}'.`);
  }

  try {
    const finalStat = await fs.lstat(finalPath);
    if (finalStat.isSymbolicLink()) {
      throw new ArtifactStorageError(`Final physical target is a symbolic link or junction: '${finalPath}'.`);
    }
    if (options.requireFile && !finalStat.isFile()) {
      throw new ArtifactStorageError(`Final target is not a regular file: '${finalPath}'.`);
    }
  } catch (err: any) {
    if (options.requireFile || err?.code !== 'ENOENT') {
      throw err;
    }
  }

  return finalPath;
}

async function validateAncestorsDisjointAndCanonical(
  destResolved: string,
  canonicalLiveRoot: string | null
): Promise<void> {
  let current = path.dirname(destResolved);
  while (current && current !== path.dirname(current)) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new ArtifactStorageError(`Ancestor directory of backup destination is a symbolic link or junction: '${current}'.`);
      }
      if (stat.isDirectory()) {
        const realAncestor = await fs.realpath(current);
        if (canonicalLiveRoot) {
          const normLive = normalizePathForComparison(canonicalLiveRoot);
          const normAnc = normalizePathForComparison(realAncestor);
          if (normAnc === normLive || (!path.relative(normLive, normAnc).startsWith('..') && !path.isAbsolute(path.relative(normLive, normAnc)))) {
            throw new ArtifactStorageError(`Ancestor directory of backup destination resolves inside live store root: '${current}' -> '${realAncestor}'.`);
          }
        }
        break;
      }
    } catch (err: any) {
      if (err instanceof ArtifactStorageError) throw err;
      if (err?.code !== 'ENOENT') throw err;
    }
    current = path.dirname(current);
  }
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

  // 1. Obter Live Root canônico físico para validação estrita de relações
  const canonicalLiveRoot = await getCanonicalLiveRoot(service);

  // 2. Validação prévia de ancestrais contra junctions e overlaps com live root ANTES de mkdir
  await validateAncestorsDisjointAndCanonical(destResolved, canonicalLiveRoot);

  // 3. Resolver o destination físico e verificar existência/vazio
  let destinationExistedBefore = false;
  try {
    const stat = await fs.lstat(destResolved);
    if (stat.isSymbolicLink()) {
      throw new ArtifactStorageError(`Backup destination cannot be a symbolic link or junction: '${destResolved}'.`);
    }
    if (!stat.isDirectory()) {
      throw new ArtifactStorageError(`Backup destination must be a directory: '${destResolved}'.`);
    }
    destinationExistedBefore = true;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }
  }

  if (destinationExistedBefore) {
    // Se o destino já existia, exige que esteja estritamente vazio para impedir junctions pré-plantadas
    const entries = await fs.readdir(destResolved);
    if (entries.length > 0) {
      throw new ArtifactStorageError(
        `Backup destination directory is not empty: '${destResolved}'. Backup requires a new or empty directory.`
      );
    }
  } else {
    // Se não existia, cria o diretório governadamente
    await fs.mkdir(destResolved, { recursive: true });
    const newStat = await fs.lstat(destResolved);
    if (newStat.isSymbolicLink()) {
      throw new ArtifactStorageError(`Created backup destination is a symbolic link: '${destResolved}'.`);
    }
  }

  const canonicalDestRoot = await fs.realpath(destResolved);

  // 4. Provar que o destino canônico físico é estritamente disjunto do live root canônico físico
  if (canonicalLiveRoot) {
    assertDisjointCanonicalRoots(canonicalLiveRoot, canonicalDestRoot);
  }

  const artifacts = await service.persistence.listAllArtifactMetadata();
  const sourceRefs = await service.persistence.listAllSourceRefs();
  const attemptLinks = await service.persistence.listAllAttemptLinks();

  let bytesTransferred = 0;

  // 4. Private Staging Build Directory exclusivo (proteção anti-race de paths internos)
  const stagingBuildDir = await fs.mkdtemp(path.join(canonicalDestRoot, '_build_pkg_'));

  try {
    const writtenBlobs = new Set<string>();

    // Cópia para o staging privado com verificação rígida
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

      if (writtenBlobs.has(artifact.storageKey)) {
        continue;
      }

      const blobBuffer = await service.blobStore.getBlob(artifact.storageKey, artifact.sha256);
      const stagingBlobPath = await resolveContainedPhysicalPath(stagingBuildDir, artifact.storageKey, {
        allowCreate: true,
      });

      // Gravação exclusiva no staging com FileHandle
      const fileHandle = await fs.open(stagingBlobPath, 'wx');
      try {
        await fileHandle.writeFile(blobBuffer);
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }

      // Pós-verificação física de integridade e confinamento
      const stat = await fs.lstat(stagingBlobPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new ArtifactStorageError(`Written blob in backup package is not a regular file: '${stagingBlobPath}'.`);
      }

      const realBlobFile = await fs.realpath(stagingBlobPath);
      const relToStaging = path.relative(stagingBuildDir, realBlobFile);
      if (relToStaging.startsWith('..') || path.isAbsolute(relToStaging)) {
        throw new ArtifactStorageError(`Written blob escaped staging build package: '${stagingBlobPath}'.`);
      }

      const destCheck = await calculateStreamSha256(stagingBlobPath);
      if (destCheck.sha256 !== artifact.sha256 || destCheck.byteSize !== artifact.byteSize) {
        throw new ArtifactIntegrityError({
          storageKey: artifact.storageKey,
          expectedSha256: artifact.sha256,
          actualSha256: destCheck.sha256,
          message: `Backup copy failed integrity verification for '${artifact.storageKey}'.`,
        });
      }

      writtenBlobs.add(artifact.storageKey);
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

    const stagingManifestPath = path.join(stagingBuildDir, MANIFEST_FILE_NAME);
    const stagingHashPath = path.join(stagingBuildDir, MANIFEST_HASH_FILE_NAME);

    await fs.writeFile(stagingManifestPath, manifestJson, 'utf-8');
    await fs.writeFile(stagingHashPath, `${manifestSha256}  ${MANIFEST_FILE_NAME}\n`, 'utf-8');

    // 5. Promoção Controlada do staging build para o destination root canônico
    // Mover árvore de blobs 'sha256' se houver blobs
    const stagingSha256Dir = path.join(stagingBuildDir, 'sha256');
    const destSha256Dir = path.join(canonicalDestRoot, 'sha256');

    try {
      await fs.lstat(stagingSha256Dir);
      await fs.rename(stagingSha256Dir, destSha256Dir);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }

    const finalManifestPath = path.join(canonicalDestRoot, MANIFEST_FILE_NAME);
    const finalHashPath = path.join(canonicalDestRoot, MANIFEST_HASH_FILE_NAME);

    // Mover hash sidecar primeiro e por ÚLTIMO o manifest principal (Garantia de atomicidade do manifest)
    await fs.rename(stagingHashPath, finalHashPath);
    await fs.rename(stagingManifestPath, finalManifestPath);

    // Limpar o diretório de staging temporário vazio
    await fs.rm(stagingBuildDir, { recursive: true, force: true }).catch(() => {});

    return {
      backupDir: canonicalDestRoot,
      manifestPath: finalManifestPath,
      manifestSha256,
      artifactsCount: artifacts.length,
      bytesTransferred,
    };
  } catch (error) {
    // Em caso de falha: remover completamente o staging build para não deixar lixo
    await fs.rm(stagingBuildDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
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

    // Validação física rigorosa do path do blob de backup (anti-junction)
    let backupBlobPath: string;
    try {
      backupBlobPath = await resolveContainedPhysicalPath(canonicalBackupRoot, artifact.storageKey, {
        allowCreate: false,
        requireFile: true,
      });
    } catch (err: any) {
      if (err instanceof ArtifactStorageError) {
        throw err;
      }
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
