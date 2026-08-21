/**
 * NEX+ · Evidence Artifact Runtime Validators & Guard Boundaries
 * Escopo 0.85 (Bloco 0.85C)
 */

import { isCanonicalUtcInstant } from '../invariants';
import type {
  EvidenceArtifactRecord,
  SourceRefRecord,
} from './contracts';
import { ArtifactInvariantViolationError } from './errors';

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

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

export function isValidSha256(sha256: unknown): sha256 is string {
  return typeof sha256 === 'string' && SHA256_HEX_REGEX.test(sha256);
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

  if (typeof r.storageKey !== 'string' || !r.storageKey.startsWith('sha256/')) {
    throw new ArtifactInvariantViolationError('INVALID_STORAGE_KEY', `storageKey must be content-addressed starting with 'sha256/', received '${r.storageKey}'.`);
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
    redactionMethodRef: r.redactionMethodRef,
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

  if (s.locationOrUri !== undefined && typeof s.locationOrUri !== 'string') {
    throw new ArtifactInvariantViolationError('INVALID_LOCATION_OR_URI', 'locationOrUri must be a string when provided.');
  }

  // Sanitização básica contra credenciais em plaintext na URI
  if (s.locationOrUri && /:\/\/[^@\s]+:[^@\s]+@/.test(s.locationOrUri)) {
    throw new ArtifactInvariantViolationError('EMBEDDED_CREDENTIALS_FORBIDDEN', 'locationOrUri contains embedded basic auth credentials, which is strictly forbidden.');
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
