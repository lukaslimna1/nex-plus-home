/**
 * NEX+ · Evidence Artifact Runtime Validators & Guard Boundaries
 * Escopo 0.85 (Bloco 0.85C · Micro-Hardening Final Pós-Reauditoria)
 */

import { isCanonicalUtcInstant } from '../invariants';
import type {
  EvidenceArtifactRecord,
  SourceRefRecord,
  EvidenceBackupManifest,
  EvidenceArtifactAttemptLink,
} from './contracts';
import { ArtifactInvariantViolationError } from './errors';

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
const CANONICAL_STORAGE_KEY_REGEX = /^sha256\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

const VALID_PHYSICAL_KINDS = new Set([
  'url_resource',
  'api_response',
  'document',
  'screenshot',
  'snapshot',
  'text_snippet',
  'human_message',
]);

const VALID_SOURCE_KINDS = new Set([
  'url',
  'api_endpoint',
  'system_feed',
  'human_statement',
  'document_source',
  'internal_process',
]);

const FORBIDDEN_SECRET_KEY_NAMES = new Set([
  'credential',
  'credentials',
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'apikey',
  'authorization',
  'cookie',
  'setcookie',
]);

export function isValidSha256(sha256: unknown): sha256 is string {
  return typeof sha256 === 'string' && SHA256_HEX_REGEX.test(sha256);
}

export function buildStorageKeyFromSha256(sha256: string): string {
  if (!isValidSha256(sha256)) {
    throw new ArtifactInvariantViolationError(
      'INVALID_SHA256_FOR_KEY',
      `Cannot build storageKey from invalid SHA-256: '${sha256}'.`
    );
  }
  return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

export function validateCanonicalStorageKey(storageKey: string, expectedSha256?: string): void {
  if (typeof storageKey !== 'string' || !CANONICAL_STORAGE_KEY_REGEX.test(storageKey)) {
    throw new ArtifactInvariantViolationError(
      'INVALID_STORAGE_KEY_FORMAT',
      `storageKey must follow the canonical pattern 'sha256/ab/cd/<64hex>', received '${storageKey}'.`
    );
  }

  const parts = storageKey.split('/');
  const prefix = parts[0];
  const seg1 = parts[1];
  const seg2 = parts[2];
  const hash = parts[3];

  if (prefix !== 'sha256' || seg1 !== hash.slice(0, 2) || seg2 !== hash.slice(2, 4)) {
    throw new ArtifactInvariantViolationError(
      'STORAGE_KEY_SEGMENT_MISMATCH',
      `storageKey path segments do not match the embedded hash: '${storageKey}'.`
    );
  }

  if (expectedSha256) {
    const normExpected = expectedSha256.toLowerCase();
    if (hash !== normExpected) {
      throw new ArtifactInvariantViolationError(
        'STORAGE_KEY_HASH_MISMATCH',
        `storageKey hash '${hash}' does not match expected SHA-256 '${normExpected}'.`
      );
    }
  }
}

function scanForForbiddenSecretKeys(obj: unknown, path: string = ''): void {
  if (!obj || typeof obj !== 'object') {
    return;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      scanForForbiddenSecretKeys(obj[i], `${path}[${i}]`);
    }
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
    if (FORBIDDEN_SECRET_KEY_NAMES.has(normalizedKey)) {
      throw new ArtifactInvariantViolationError(
        'SAFE_METADATA_SECRET_KEY_FORBIDDEN',
        `safeMetadata contains forbidden key name indicating secret/credential material at '${path ? `${path}.${key}` : key}'.`
      );
    }
    scanForForbiddenSecretKeys(value, path ? `${path}.${key}` : key);
  }
}

export function validateEvidenceArtifactRecord(record: unknown): EvidenceArtifactRecord {
  if (!record || typeof record !== 'object') {
    throw new ArtifactInvariantViolationError('INVALID_RECORD', 'Artifact record must be an object.');
  }

  const r = record as Record<string, any>;

  if (typeof r.artifactId !== 'string' || r.artifactId.trim().length === 0) {
    throw new ArtifactInvariantViolationError('INVALID_ARTIFACT_ID', 'artifactId must be a non-empty string.');
  }

  if (!VALID_PHYSICAL_KINDS.has(r.kind)) {
    throw new ArtifactInvariantViolationError('INVALID_KIND', `kind '${r.kind}' is not a valid physical evidence artifact kind.`);
  }

  if (r.sourceRefId !== undefined && (typeof r.sourceRefId !== 'string' || r.sourceRefId.trim().length === 0)) {
    throw new ArtifactInvariantViolationError('INVALID_SOURCE_REF_ID', 'sourceRefId must be a non-empty string when provided.');
  }

  if (!isValidSha256(r.sha256)) {
    throw new ArtifactInvariantViolationError('INVALID_SHA256', `sha256 must be a 64-character lowercase hex string, received '${r.sha256}'.`);
  }

  if (typeof r.byteSize !== 'number' || !Number.isSafeInteger(r.byteSize) || r.byteSize < 0) {
    throw new ArtifactInvariantViolationError('INVALID_BYTE_SIZE', `byteSize must be a non-negative safe integer, received '${r.byteSize}'.`);
  }

  if (typeof r.mimeType !== 'string' || r.mimeType.trim().length === 0) {
    throw new ArtifactInvariantViolationError('INVALID_MIME_TYPE', 'mimeType must be a non-empty string.');
  }

  if (r.storageBackend !== 'local_fs') {
    throw new ArtifactInvariantViolationError('INVALID_STORAGE_BACKEND', `storageBackend must be 'local_fs', received '${r.storageBackend}'.`);
  }

  validateCanonicalStorageKey(r.storageKey, r.sha256);

  const expectedStorageKey = buildStorageKeyFromSha256(r.sha256);
  if (r.storageKey !== expectedStorageKey) {
    throw new ArtifactInvariantViolationError(
      'STORAGE_KEY_SHA_MISMATCH',
      `storageKey '${r.storageKey}' does not match canonical key for sha256 '${expectedStorageKey}'.`
    );
  }

  if (r.safeDescription !== undefined) {
    if (typeof r.safeDescription !== 'string') {
      throw new ArtifactInvariantViolationError('INVALID_SAFE_DESCRIPTION', 'safeDescription must be a string when provided.');
    }
  }

  if (!isCanonicalUtcInstant(r.capturedAt)) {
    throw new ArtifactInvariantViolationError('INVALID_CAPTURED_AT', `capturedAt must be a canonical ISO 8601 UTC instant ending in 'Z', received '${r.capturedAt}'.`);
  }

  if (r.sensitivity !== 'NORMAL' && r.sensitivity !== 'LOCAL_ONLY') {
    throw new ArtifactInvariantViolationError('INVALID_SENSITIVITY', `sensitivity must be 'NORMAL' or 'LOCAL_ONLY', received '${r.sensitivity}'.`);
  }

  if (r.containsSecretMaterial !== false) {
    throw new ArtifactInvariantViolationError('SECRET_MATERIAL_FORBIDDEN', `containsSecretMaterial must be strictly false for persisted records.`);
  }

  if (typeof r.redactionApplied !== 'boolean') {
    throw new ArtifactInvariantViolationError('INVALID_REDACTION_APPLIED', `redactionApplied must be a boolean.`);
  }

  if (r.redactionApplied && (typeof r.redactionMethodRef !== 'string' || r.redactionMethodRef.trim().length === 0)) {
    throw new ArtifactInvariantViolationError('MISSING_REDACTION_METHOD_REF', `redactionMethodRef is required when redactionApplied is true.`);
  }

  if (!r.redactionApplied && r.redactionMethodRef !== undefined && r.redactionMethodRef !== null) {
    throw new ArtifactInvariantViolationError('REDACTION_METHOD_REF_NOT_ALLOWED', `redactionMethodRef is not allowed when redactionApplied is false.`);
  }

  if (r.retentionClass !== 'durable_evidence') {
    throw new ArtifactInvariantViolationError('INVALID_RETENTION_CLASS', `retentionClass must be 'durable_evidence', received '${r.retentionClass}'.`);
  }

  return {
    artifactId: r.artifactId,
    kind: r.kind,
    sourceRefId: r.sourceRefId,
    sha256: r.sha256,
    byteSize: r.byteSize,
    mimeType: r.mimeType,
    storageBackend: r.storageBackend,
    storageKey: r.storageKey,
    safeDescription: r.safeDescription,
    capturedAt: r.capturedAt,
    sensitivity: r.sensitivity,
    containsSecretMaterial: false,
    redactionApplied: r.redactionApplied,
    redactionMethodRef: r.redactionMethodRef ?? undefined,
    retentionClass: 'durable_evidence',
  };
}

export function validateSourceRefRecord(source: unknown): SourceRefRecord {
  if (!source || typeof source !== 'object') {
    throw new ArtifactInvariantViolationError('INVALID_SOURCE_RECORD', 'Source record must be an object.');
  }

  const s = source as Record<string, any>;

  if (typeof s.sourceId !== 'string' || s.sourceId.trim().length === 0) {
    throw new ArtifactInvariantViolationError('INVALID_SOURCE_ID', 'sourceId must be a non-empty string.');
  }

  if (!VALID_SOURCE_KINDS.has(s.kind)) {
    throw new ArtifactInvariantViolationError('INVALID_SOURCE_KIND', `kind '${s.kind}' is not a valid source kind.`);
  }

  if (typeof s.name !== 'string' || s.name.trim().length === 0) {
    throw new ArtifactInvariantViolationError('INVALID_SOURCE_NAME', 'name must be a non-empty string.');
  }

  if (s.locationOrUri !== undefined) {
    if (typeof s.locationOrUri !== 'string') {
      throw new ArtifactInvariantViolationError('INVALID_LOCATION_OR_URI', 'locationOrUri must be a string when provided.');
    }

    // Validação de credenciais via WHATWG URL se for URL válida
    try {
      const parsedUrl = new URL(s.locationOrUri);
      if (parsedUrl.username || parsedUrl.password) {
        throw new ArtifactInvariantViolationError(
          'EMBEDDED_CREDENTIALS_FORBIDDEN',
          'locationOrUri contains embedded basic auth credentials, which is strictly forbidden.'
        );
      }

      // Checa se algum query parameter name é um segredo conhecido
      for (const paramName of parsedUrl.searchParams.keys()) {
        const normParam = paramName.toLowerCase().replace(/[-_]/g, '');
        if (FORBIDDEN_SECRET_KEY_NAMES.has(normParam)) {
          throw new ArtifactInvariantViolationError(
            'LOCATION_URI_SECRET_PARAM_FORBIDDEN',
            `locationOrUri contains sensitive query parameter '${paramName}'.`
          );
        }
      }

      // Checa se algum fragment / hash parameter name é um segredo conhecido
      if (parsedUrl.hash) {
        const rawHash = parsedUrl.hash.replace(/^#/, '');
        if (rawHash.includes('=') || rawHash.includes('&') || rawHash.includes('?')) {
          const hashSearch = rawHash.includes('?') ? rawHash.slice(rawHash.indexOf('?') + 1) : rawHash;
          const hashParams = new URLSearchParams(hashSearch);
          for (const paramName of hashParams.keys()) {
            const normParam = paramName.toLowerCase().replace(/[-_]/g, '');
            if (FORBIDDEN_SECRET_KEY_NAMES.has(normParam)) {
              throw new ArtifactInvariantViolationError(
                'LOCATION_URI_SECRET_FRAGMENT_FORBIDDEN',
                `locationOrUri contains sensitive credential parameter in URI fragment.`
              );
            }
          }
        }
      }
    } catch (e: any) {
      if (e instanceof ArtifactInvariantViolationError) {
        throw e;
      }
      // Se não for uma URL parsed com sucesso, aplica regex defensiva para user:pass@
      if (/:\/\/[^@\s]+:[^@\s]+@/.test(s.locationOrUri)) {
        throw new ArtifactInvariantViolationError(
          'EMBEDDED_CREDENTIALS_FORBIDDEN',
          'locationOrUri contains embedded basic auth credentials, which is strictly forbidden.'
        );
      }
    }
  }

  if (s.safeMetadata !== undefined) {
    if (typeof s.safeMetadata !== 'object' || s.safeMetadata === null || Array.isArray(s.safeMetadata)) {
      throw new ArtifactInvariantViolationError('INVALID_SAFE_METADATA', 'safeMetadata must be a plain object when provided.');
    }
    scanForForbiddenSecretKeys(s.safeMetadata);
  }

  if (!isCanonicalUtcInstant(s.createdAt)) {
    throw new ArtifactInvariantViolationError('INVALID_CREATED_AT', `createdAt must be a canonical ISO 8601 UTC instant ending in 'Z', received '${s.createdAt}'.`);
  }

  return {
    sourceId: s.sourceId,
    kind: s.kind,
    name: s.name,
    locationOrUri: s.locationOrUri,
    safeMetadata: s.safeMetadata,
    createdAt: s.createdAt,
  };
}

export function validateEvidenceArtifactAttemptLink(link: unknown): EvidenceArtifactAttemptLink {
  if (!link || typeof link !== 'object') {
    throw new ArtifactInvariantViolationError('INVALID_ATTEMPT_LINK', 'Attempt link must be an object.');
  }

  const l = link as Record<string, any>;

  if (typeof l.artifactId !== 'string' || l.artifactId.trim().length === 0) {
    throw new ArtifactInvariantViolationError('INVALID_LINK_ARTIFACT_ID', 'artifactId must be a non-empty string in attempt link.');
  }

  if (typeof l.attemptId !== 'string' || l.attemptId.trim().length === 0) {
    throw new ArtifactInvariantViolationError('INVALID_LINK_ATTEMPT_ID', 'attemptId must be a non-empty string in attempt link.');
  }

  if (!isCanonicalUtcInstant(l.linkedAt)) {
    throw new ArtifactInvariantViolationError('INVALID_LINKED_AT', `linkedAt must be a canonical ISO 8601 UTC instant ending in 'Z', received '${l.linkedAt}'.`);
  }

  return {
    artifactId: l.artifactId,
    attemptId: l.attemptId,
    linkedAt: l.linkedAt,
  };
}

export function validateEvidenceBackupManifest(manifest: unknown): EvidenceBackupManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new ArtifactInvariantViolationError('INVALID_MANIFEST', 'Manifest must be an object.');
  }

  const m = manifest as Record<string, any>;

  if (m.schemaVersion !== '1.0') {
    throw new ArtifactInvariantViolationError(
      'UNSUPPORTED_MANIFEST_VERSION',
      `Unsupported backup manifest schemaVersion: '${m.schemaVersion}'. Expected '1.0'.`
    );
  }

  if (!isCanonicalUtcInstant(m.createdAt)) {
    throw new ArtifactInvariantViolationError('INVALID_MANIFEST_CREATED_AT', `createdAt must be a canonical ISO 8601 UTC instant ending in 'Z', received '${m.createdAt}'.`);
  }

  if (!Array.isArray(m.artifacts)) {
    throw new ArtifactInvariantViolationError('INVALID_MANIFEST_ARTIFACTS', 'artifacts must be an array in manifest.');
  }

  if (!Array.isArray(m.sourceRefs)) {
    throw new ArtifactInvariantViolationError('INVALID_MANIFEST_SOURCE_REFS', 'sourceRefs must be an array in manifest.');
  }

  if (!Array.isArray(m.attemptLinks)) {
    throw new ArtifactInvariantViolationError('INVALID_MANIFEST_ATTEMPT_LINKS', 'attemptLinks must be an array in manifest.');
  }

  const validatedArtifacts = m.artifacts.map((a: unknown) => validateEvidenceArtifactRecord(a));
  const validatedSourceRefs = m.sourceRefs.map((s: unknown) => validateSourceRefRecord(s));
  const validatedAttemptLinks = m.attemptLinks.map((l: unknown) => validateEvidenceArtifactAttemptLink(l));

  // 1. Validação de Unicidade Estrutural no Manifest
  const seenArtifactIds = new Set<string>();
  for (const art of validatedArtifacts) {
    if (seenArtifactIds.has(art.artifactId)) {
      throw new ArtifactInvariantViolationError(
        'MANIFEST_DUPLICATE_ARTIFACT_ID',
        `Manifest contains duplicate artifactId: '${art.artifactId}'.`
      );
    }
    seenArtifactIds.add(art.artifactId);
  }

  const seenSourceIds = new Set<string>();
  for (const src of validatedSourceRefs) {
    if (seenSourceIds.has(src.sourceId)) {
      throw new ArtifactInvariantViolationError(
        'MANIFEST_DUPLICATE_SOURCE_ID',
        `Manifest contains duplicate sourceId: '${src.sourceId}'.`
      );
    }
    seenSourceIds.add(src.sourceId);
  }

  const seenAttemptPairs = new Set<string>();
  for (const link of validatedAttemptLinks) {
    const pairKey = `${link.artifactId}::${link.attemptId}`;
    if (seenAttemptPairs.has(pairKey)) {
      throw new ArtifactInvariantViolationError(
        'MANIFEST_DUPLICATE_ATTEMPT_LINK',
        `Manifest contains duplicate attempt link for artifactId '${link.artifactId}' and attemptId '${link.attemptId}'.`
      );
    }
    seenAttemptPairs.add(pairKey);
  }

  // 2. Validação de Referências Cruzadas
  for (const art of validatedArtifacts) {
    if (art.sourceRefId && !seenSourceIds.has(art.sourceRefId)) {
      throw new ArtifactInvariantViolationError(
        'MANIFEST_DANGLING_SOURCE_REF',
        `Manifest artifact '${art.artifactId}' references non-existent sourceRefId '${art.sourceRefId}'.`
      );
    }
  }

  for (const link of validatedAttemptLinks) {
    if (!seenArtifactIds.has(link.artifactId)) {
      throw new ArtifactInvariantViolationError(
        'MANIFEST_DANGLING_ATTEMPT_LINK_ARTIFACT',
        `Manifest attempt link references non-existent artifactId '${link.artifactId}'.`
      );
    }
  }

  return {
    schemaVersion: '1.0',
    createdAt: m.createdAt,
    artifacts: validatedArtifacts,
    sourceRefs: validatedSourceRefs,
    attemptLinks: validatedAttemptLinks,
  };
}
