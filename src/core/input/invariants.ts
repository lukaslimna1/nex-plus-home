/**
 * NEX+ · Invariantes e Validadores Runtime de Input & Ingress Content
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3)
 *
 * Princípios:
 * 1. Allowlist runtime fechada em todas as variantes e objetos canônicos.
 * 2. Rejeição imediata de chaves extras, híbridos, vazios e base64.
 * 3. Validação estrita de formato (SHA-256 64 hex, timestamps UTC ISO 8601 com 'Z' compartilhados com o Core).
 * 4. Validação de coerência de autoridade (SessionRef -> userId, HumanActor.humanId === userId).
 * 5. Imutabilidade profunda com cópia defensiva estruturada por variante.
 */

import type { Actor, HumanActor, MaxActor, SystemActor, IntegrationActor } from '../observations/contracts';
import { isValidSessionRef } from '../../auth/session-ref.types';
import {
  isCanonicalUtcInstant,
  isNonEmptyString,
  validateContextSubjectRef,
} from '../context/invariants';
import type {
  InputRecordId,
  IngressContentId,
  SourceEventIdentity,
  IngressContentRef,
  InputPart,
  InputRecord,
  IngressContentRecord,
  RecordInputDraft,
} from './contracts';
import { InputInvariantViolationError } from './errors';

// ============================================================================
// 1. UTILITÁRIOS INTERNOS DE VALIDAÇÃO
// ============================================================================

function isValidSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function assertExactKeys(
  candidate: Record<string, unknown>,
  allowedKeys: readonly string[],
  contextName: string,
  variantName?: string
): void {
  const actualKeys = Object.keys(candidate);
  const unexpectedKeys = actualKeys.filter((k) => !allowedKeys.includes(k));
  if (unexpectedKeys.length > 0) {
    throw new InputInvariantViolationError(
      'UNEXPECTED_PROPERTY',
      `Unexpected property ${unexpectedKeys.map((k) => `'${k}'`).join(', ')} found on ${contextName}${
        variantName ? ` (${variantName})` : ''
      }. Only allowed: ${allowedKeys.map((k) => `'${k}'`).join(', ')}.`
    );
  }
}

// ============================================================================
// 2. VALIDAÇÃO DE IDENTIFICADORES
// ============================================================================

export function validateInputRecordId(id: unknown): asserts id is InputRecordId {
  if (!isNonEmptyString(id)) {
    throw new InputInvariantViolationError(
      'INVALID_INPUT_RECORD_ID',
      `InputRecordId must be a non-empty string, got '${String(id)}'.`
    );
  }
}

export function validateIngressContentId(id: unknown): asserts id is IngressContentId {
  if (!isNonEmptyString(id)) {
    throw new InputInvariantViolationError(
      'INVALID_INGRESS_CONTENT_ID',
      `IngressContentId must be a non-empty string, got '${String(id)}'.`
    );
  }
}

// ============================================================================
// 3. VALIDAÇÃO E SANITIZAÇÃO DE SOURCE EVENT IDENTITY
// ============================================================================

export function validateSourceEventIdentity(identity: unknown): asserts identity is SourceEventIdentity {
  if (!identity || typeof identity !== 'object') {
    throw new InputInvariantViolationError(
      'INVALID_SOURCE_EVENT_IDENTITY',
      'SourceEventIdentity must be a non-null object.'
    );
  }
  const candidate = identity as Record<string, unknown>;
  assertExactKeys(candidate, ['source', 'id'], 'SourceEventIdentity');

  if (typeof candidate.source !== 'string' || candidate.source.length === 0) {
    throw new InputInvariantViolationError(
      'INVALID_SOURCE_EVENT_IDENTITY',
      'SourceEventIdentity.source must be a non-empty string.'
    );
  }

  if (candidate.source.trim() !== candidate.source) {
    throw new InputInvariantViolationError(
      'INVALID_SOURCE_EVENT_IDENTITY',
      'SourceEventIdentity.source must not contain leading or trailing whitespace.'
    );
  }

  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new InputInvariantViolationError(
      'INVALID_SOURCE_EVENT_IDENTITY',
      'SourceEventIdentity.id must be a non-empty string.'
    );
  }

  if (candidate.id.trim() !== candidate.id) {
    throw new InputInvariantViolationError(
      'INVALID_SOURCE_EVENT_IDENTITY',
      'SourceEventIdentity.id must not contain leading or trailing whitespace.'
    );
  }
}

export function sanitizeSourceEventIdentity(identity: SourceEventIdentity): SourceEventIdentity {
  validateSourceEventIdentity(identity);
  return Object.freeze({
    source: identity.source,
    id: identity.id,
  });
}

// ============================================================================
// 4. VALIDAÇÃO DE INGRESS CONTENT REF
// ============================================================================

export function validateIngressContentRef(ref: unknown): asserts ref is IngressContentRef {
  if (!ref || typeof ref !== 'object') {
    throw new InputInvariantViolationError(
      'INVALID_INGRESS_CONTENT_REF',
      'IngressContentRef must be a non-null object.'
    );
  }
  const candidate = ref as Record<string, unknown>;
  assertExactKeys(candidate, ['contentId'], 'IngressContentRef');
  validateIngressContentId(candidate.contentId);
}

// ============================================================================
// 5. VALIDAÇÃO DE RESOURCE REF
// ============================================================================

export function validateResourceRef(resource: unknown): void {
  if (!resource || typeof resource !== 'object') {
    throw new InputInvariantViolationError(
      'INVALID_RESOURCE_REF',
      'ResourceRef must be a non-null object.'
    );
  }
  const candidate = resource as Record<string, unknown>;
  assertExactKeys(candidate, ['ownerModule', 'resourceType', 'resourceId'], 'ResourceRef');

  if (!candidate.ownerModule || typeof candidate.ownerModule !== 'object') {
    throw new InputInvariantViolationError(
      'INVALID_RESOURCE_REF',
      'ResourceRef.ownerModule must be a non-null object containing moduleKey.'
    );
  }
  const ownerModule = candidate.ownerModule as Record<string, unknown>;
  assertExactKeys(ownerModule, ['moduleKey'], 'ModuleRef');
  if (!isNonEmptyString(ownerModule.moduleKey)) {
    throw new InputInvariantViolationError(
      'INVALID_RESOURCE_REF',
      'ResourceRef.ownerModule.moduleKey must be a non-empty string.'
    );
  }

  if (!isNonEmptyString(candidate.resourceType)) {
    throw new InputInvariantViolationError(
      'INVALID_RESOURCE_REF',
      'ResourceRef.resourceType must be a non-empty string.'
    );
  }

  if (!isNonEmptyString(candidate.resourceId)) {
    throw new InputInvariantViolationError(
      'INVALID_RESOURCE_REF',
      'ResourceRef.resourceId must be a non-empty string.'
    );
  }
}

// ============================================================================
// 6. VALIDAÇÃO E SANITIZAÇÃO DE INPUT PART (DISCRIMINATED UNION ESTRITA)
// ============================================================================

export function validateInputPart(part: unknown): asserts part is InputPart {
  if (!part || typeof part !== 'object') {
    throw new InputInvariantViolationError(
      'INVALID_INPUT_PART',
      'InputPart must be a non-null object.'
    );
  }
  const candidate = part as Record<string, unknown>;

  if (typeof candidate.kind !== 'string') {
    throw new InputInvariantViolationError(
      'INVALID_INPUT_PART_KIND',
      'InputPart must have a string discriminator property "kind".'
    );
  }

  if (candidate.kind === 'source_ref') {
    throw new InputInvariantViolationError(
      'SOURCE_REF_AS_INPUT_PART_PROHIBITED',
      'source_ref is not an allowed InputPart kind. SourceRef represents provenance/source and must not be used as an input part.'
    );
  }

  switch (candidate.kind) {
    case 'text': {
      assertExactKeys(candidate, ['kind', 'text'], 'InputPart', 'text');
      if (!isNonEmptyString(candidate.text)) {
        throw new InputInvariantViolationError(
          'INVALID_TEXT_PART',
          'TextInputPart.text must be a non-empty string with non-whitespace content.'
        );
      }
      break;
    }

    case 'content_ref': {
      assertExactKeys(candidate, ['kind', 'content'], 'InputPart', 'content_ref');
      validateIngressContentRef(candidate.content);
      break;
    }

    case 'event_ref': {
      assertExactKeys(candidate, ['kind', 'eventId'], 'InputPart', 'event_ref');
      if (!isNonEmptyString(candidate.eventId)) {
        throw new InputInvariantViolationError(
          'INVALID_EVENT_REF_PART',
          'EventRefInputPart.eventId must be a non-empty string.'
        );
      }
      break;
    }

    case 'resource_ref': {
      assertExactKeys(candidate, ['kind', 'resource'], 'InputPart', 'resource_ref');
      validateResourceRef(candidate.resource);
      break;
    }

    case 'evidence_ref': {
      assertExactKeys(candidate, ['kind', 'evidenceArtifactId'], 'InputPart', 'evidence_ref');
      if (!isNonEmptyString(candidate.evidenceArtifactId)) {
        throw new InputInvariantViolationError(
          'INVALID_EVIDENCE_REF_PART',
          'EvidenceRefInputPart.evidenceArtifactId must be a non-empty string.'
        );
      }
      break;
    }

    default: {
      throw new InputInvariantViolationError(
        'UNKNOWN_INPUT_PART_KIND',
        `Unknown InputPart kind '${String(candidate.kind)}'. Allowed kinds: 'text', 'content_ref', 'event_ref', 'resource_ref', 'evidence_ref'.`
      );
    }
  }
}

/**
 * Reconstrói e congela profundamente cada InputPart por variante.
 * Preserva o texto original sem trimar conteúdo textual do usuário.
 */
export function sanitizeInputPart(part: InputPart): InputPart {
  validateInputPart(part);

  switch (part.kind) {
    case 'text':
      return Object.freeze({
        kind: 'text',
        text: part.text, // Preservar o texto original sem trim
      });

    case 'content_ref':
      return Object.freeze({
        kind: 'content_ref',
        content: Object.freeze({
          contentId: part.content.contentId,
        }),
      });

    case 'event_ref':
      return Object.freeze({
        kind: 'event_ref',
        eventId: part.eventId,
      });

    case 'resource_ref':
      return Object.freeze({
        kind: 'resource_ref',
        resource: Object.freeze({
          ownerModule: Object.freeze({
            moduleKey: part.resource.ownerModule.moduleKey,
          }),
          resourceType: part.resource.resourceType,
          resourceId: part.resource.resourceId,
        }),
      });

    case 'evidence_ref':
      return Object.freeze({
        kind: 'evidence_ref',
        evidenceArtifactId: part.evidenceArtifactId,
      });
  }
}

// ============================================================================
// 7. VALIDAÇÃO DE ACTOR (ALLOWLIST FECHADA)
// ============================================================================

export function validateActor(actor: unknown): asserts actor is Actor {
  if (!actor || typeof actor !== 'object') {
    throw new InputInvariantViolationError('INVALID_ACTOR', 'Actor must be a non-null object.');
  }
  const candidate = actor as Record<string, unknown>;
  const kind = candidate.kind;

  if (typeof kind !== 'string') {
    throw new InputInvariantViolationError('INVALID_ACTOR_KIND', 'Actor must have a string property "kind".');
  }

  switch (kind) {
    case 'human': {
      assertExactKeys(candidate, ['kind', 'humanId', 'role', 'authorityRef'], 'Actor', 'human');
      if (!isNonEmptyString(candidate.humanId)) {
        throw new InputInvariantViolationError('INVALID_HUMAN_ACTOR', 'HumanActor.humanId must be a non-empty string.');
      }
      if (candidate.role !== undefined && !isNonEmptyString(candidate.role)) {
        throw new InputInvariantViolationError('INVALID_HUMAN_ACTOR', 'HumanActor.role must be a non-empty string when provided.');
      }
      if (candidate.authorityRef !== undefined && !isNonEmptyString(candidate.authorityRef)) {
        throw new InputInvariantViolationError('INVALID_HUMAN_ACTOR', 'HumanActor.authorityRef must be a non-empty string when provided.');
      }
      break;
    }

    case 'max': {
      assertExactKeys(candidate, ['kind', 'maxVersion', 'sessionRef'], 'Actor', 'max');
      if (!isNonEmptyString(candidate.maxVersion)) {
        throw new InputInvariantViolationError('INVALID_MAX_ACTOR', 'MaxActor.maxVersion must be a non-empty string.');
      }
      if (candidate.sessionRef !== undefined && !isNonEmptyString(candidate.sessionRef)) {
        throw new InputInvariantViolationError('INVALID_MAX_ACTOR', 'MaxActor.sessionRef must be a non-empty string when provided.');
      }
      break;
    }

    case 'system': {
      assertExactKeys(candidate, ['kind', 'component', 'version'], 'Actor', 'system');
      if (!isNonEmptyString(candidate.component)) {
        throw new InputInvariantViolationError('INVALID_SYSTEM_ACTOR', 'SystemActor.component must be a non-empty string.');
      }
      if (candidate.version !== undefined && !isNonEmptyString(candidate.version)) {
        throw new InputInvariantViolationError('INVALID_SYSTEM_ACTOR', 'SystemActor.version must be a non-empty string when provided.');
      }
      break;
    }

    case 'integration': {
      assertExactKeys(candidate, ['kind', 'provider', 'integrationId'], 'Actor', 'integration');
      if (!isNonEmptyString(candidate.provider)) {
        throw new InputInvariantViolationError('INVALID_INTEGRATION_ACTOR', 'IntegrationActor.provider must be a non-empty string.');
      }
      if (candidate.integrationId !== undefined && !isNonEmptyString(candidate.integrationId)) {
        throw new InputInvariantViolationError('INVALID_INTEGRATION_ACTOR', 'IntegrationActor.integrationId must be a non-empty string when provided.');
      }
      break;
    }

    default: {
      throw new InputInvariantViolationError('UNKNOWN_ACTOR_KIND', `Unknown actor kind '${String(kind)}'.`);
    }
  }
}

export function sanitizeActor(actor: Actor): Actor {
  validateActor(actor);
  switch (actor.kind) {
    case 'human': {
      const h: HumanActor = {
        kind: 'human',
        humanId: actor.humanId.trim(),
        ...(actor.role ? { role: actor.role.trim() } : {}),
        ...(actor.authorityRef ? { authorityRef: actor.authorityRef.trim() } : {}),
      };
      return Object.freeze(h);
    }
    case 'max': {
      const m: MaxActor = {
        kind: 'max',
        maxVersion: actor.maxVersion.trim(),
        ...(actor.sessionRef ? { sessionRef: actor.sessionRef.trim() } : {}),
      };
      return Object.freeze(m);
    }
    case 'system': {
      const s: SystemActor = {
        kind: 'system',
        component: actor.component.trim(),
        ...(actor.version ? { version: actor.version.trim() } : {}),
      };
      return Object.freeze(s);
    }
    case 'integration': {
      const i: IntegrationActor = {
        kind: 'integration',
        provider: actor.provider.trim(),
        ...(actor.integrationId ? { integrationId: actor.integrationId.trim() } : {}),
      };
      return Object.freeze(i);
    }
  }
}

// ============================================================================
// 8. VALIDAÇÃO DE INPUT RECORD (ENVELOPE CANÔNICO)
// ============================================================================

export function validateInputRecord(record: unknown): asserts record is InputRecord {
  if (!record || typeof record !== 'object') {
    throw new InputInvariantViolationError(
      'INVALID_INPUT_RECORD',
      'InputRecord must be a non-null object.'
    );
  }
  const candidate = record as Record<string, unknown>;

  assertExactKeys(
    candidate,
    [
      'inputId',
      'actor',
      'userId',
      'sessionRef',
      'contextSubjectRef',
      'sourceRefId',
      'sourceEventIdentity',
      'occurredAt',
      'receivedAt',
      'channel',
      'correlationId',
      'parts',
    ],
    'InputRecord'
  );

  validateInputRecordId(candidate.inputId);
  validateActor(candidate.actor);

  if (candidate.userId !== undefined && !isNonEmptyString(candidate.userId)) {
    throw new InputInvariantViolationError(
      'INVALID_USER_ID',
      'InputRecord.userId must be a non-empty string when provided.'
    );
  }

  if (candidate.sessionRef !== undefined) {
    if (!isValidSessionRef(candidate.sessionRef)) {
      throw new InputInvariantViolationError(
        'INVALID_SESSION_REF',
        `InputRecord.sessionRef must be a valid 64-char lowercase hexadecimal SessionRef, got '${String(
          candidate.sessionRef
        )}'.`
      );
    }
    if (candidate.userId === undefined) {
      throw new InputInvariantViolationError(
        'SESSION_REF_WITHOUT_USER_ID',
        'InputRecord.sessionRef cannot be provided without a corresponding userId.'
      );
    }
  }

  if (candidate.actor.kind === 'human' && candidate.sessionRef !== undefined) {
    if ((candidate.actor as HumanActor).humanId !== candidate.userId) {
      throw new InputInvariantViolationError(
        'ACTOR_USER_MISMATCH',
        `InputRecord human actor humanId ('${
          (candidate.actor as HumanActor).humanId
        }') must match userId ('${String(candidate.userId)}').`
      );
    }
  }

  if (candidate.contextSubjectRef !== undefined) {
    if (candidate.contextSubjectRef === null) {
      throw new InputInvariantViolationError(
        'INVALID_CONTEXT_SUBJECT_REF',
        'InputRecord.contextSubjectRef must be either a valid ContextSubjectRef or undefined (null is not allowed).'
      );
    }
    validateContextSubjectRef(candidate.contextSubjectRef);
  }

  if (candidate.sourceRefId !== undefined && !isNonEmptyString(candidate.sourceRefId)) {
    throw new InputInvariantViolationError(
      'INVALID_SOURCE_REF_ID',
      'InputRecord.sourceRefId must be a non-empty string when provided.'
    );
  }

  if (candidate.sourceEventIdentity !== undefined) {
    validateSourceEventIdentity(candidate.sourceEventIdentity);
  }

  if (candidate.occurredAt !== undefined && !isCanonicalUtcInstant(candidate.occurredAt)) {
    throw new InputInvariantViolationError(
      'INVALID_OCCURRED_AT',
      `InputRecord.occurredAt must be a valid ISO 8601 UTC instant ending in 'Z', got '${String(
        candidate.occurredAt
      )}'.`
    );
  }

  if (!isCanonicalUtcInstant(candidate.receivedAt)) {
    throw new InputInvariantViolationError(
      'INVALID_RECEIVED_AT',
      `InputRecord.receivedAt must be a valid ISO 8601 UTC instant ending in 'Z', got '${String(
        candidate.receivedAt
      )}'.`
    );
  }

  if (candidate.channel !== undefined && !isNonEmptyString(candidate.channel)) {
    throw new InputInvariantViolationError(
      'INVALID_CHANNEL',
      'InputRecord.channel must be a non-empty string when provided.'
    );
  }

  if (candidate.correlationId !== undefined && !isNonEmptyString(candidate.correlationId)) {
    throw new InputInvariantViolationError(
      'INVALID_CORRELATION_ID',
      'InputRecord.correlationId must be a non-empty string when provided.'
    );
  }

  if (!Array.isArray(candidate.parts) || candidate.parts.length === 0) {
    throw new InputInvariantViolationError(
      'EMPTY_PARTS_ARRAY',
      'InputRecord.parts must be a non-empty array with at least 1 part.'
    );
  }

  for (let i = 0; i < candidate.parts.length; i++) {
    validateInputPart(candidate.parts[i]);
  }
}

// ============================================================================
// 9. VALIDAÇÃO DE INGRESS CONTENT RECORD (METADATA INTERNA)
// ============================================================================

export function validateIngressContentRecord(
  record: unknown
): asserts record is IngressContentRecord {
  if (!record || typeof record !== 'object') {
    throw new InputInvariantViolationError(
      'INVALID_INGRESS_CONTENT_RECORD',
      'IngressContentRecord must be a non-null object.'
    );
  }
  const candidate = record as Record<string, unknown>;

  assertExactKeys(
    candidate,
    [
      'contentId',
      'actor',
      'userId',
      'sessionRef',
      'contextSubjectRef',
      'sourceRefId',
      'declaredMimeType',
      'verifiedMimeType',
      'sha256',
      'byteSize',
      'storageBackend',
      'storageKey',
      'receivedAt',
      'expiresAt',
    ],
    'IngressContentRecord'
  );

  validateIngressContentId(candidate.contentId);
  validateActor(candidate.actor);

  if (candidate.userId !== undefined && !isNonEmptyString(candidate.userId)) {
    throw new InputInvariantViolationError(
      'INVALID_USER_ID',
      'IngressContentRecord.userId must be a non-empty string when provided.'
    );
  }

  if (candidate.sessionRef !== undefined) {
    if (!isValidSessionRef(candidate.sessionRef)) {
      throw new InputInvariantViolationError(
        'INVALID_SESSION_REF',
        `IngressContentRecord.sessionRef must be a valid 64-char lowercase hexadecimal SessionRef, got '${String(
          candidate.sessionRef
        )}'.`
      );
    }
    if (candidate.userId === undefined) {
      throw new InputInvariantViolationError(
        'SESSION_REF_WITHOUT_USER_ID',
        'IngressContentRecord.sessionRef cannot be provided without a corresponding userId.'
      );
    }
  }

  if (candidate.contextSubjectRef !== undefined) {
    if (candidate.contextSubjectRef === null) {
      throw new InputInvariantViolationError(
        'INVALID_CONTEXT_SUBJECT_REF',
        'IngressContentRecord.contextSubjectRef must be either a valid ContextSubjectRef or undefined (null is not allowed).'
      );
    }
    validateContextSubjectRef(candidate.contextSubjectRef);
  }

  if (candidate.sourceRefId !== undefined && !isNonEmptyString(candidate.sourceRefId)) {
    throw new InputInvariantViolationError(
      'INVALID_SOURCE_REF_ID',
      'IngressContentRecord.sourceRefId must be a non-empty string when provided.'
    );
  }

  if (candidate.declaredMimeType !== undefined && !isNonEmptyString(candidate.declaredMimeType)) {
    throw new InputInvariantViolationError(
      'INVALID_DECLARED_MIME_TYPE',
      'IngressContentRecord.declaredMimeType must be a non-empty string when provided.'
    );
  }

  if (!isNonEmptyString(candidate.verifiedMimeType)) {
    throw new InputInvariantViolationError(
      'INVALID_VERIFIED_MIME_TYPE',
      'IngressContentRecord.verifiedMimeType must be a non-empty string.'
    );
  }

  if (!isValidSha256(candidate.sha256)) {
    throw new InputInvariantViolationError(
      'INVALID_SHA256',
      `IngressContentRecord.sha256 must be a 64-char lowercase hexadecimal string, got '${String(
        candidate.sha256
      )}'.`
    );
  }

  if (
    typeof candidate.byteSize !== 'number' ||
    !Number.isSafeInteger(candidate.byteSize) ||
    candidate.byteSize < 0
  ) {
    throw new InputInvariantViolationError(
      'INVALID_BYTE_SIZE',
      `IngressContentRecord.byteSize must be a non-negative safe integer, got '${String(
        candidate.byteSize
      )}'.`
    );
  }

  if (!isNonEmptyString(candidate.storageBackend)) {
    throw new InputInvariantViolationError(
      'INVALID_STORAGE_BACKEND',
      'IngressContentRecord.storageBackend must be a non-empty string.'
    );
  }

  if (!isNonEmptyString(candidate.storageKey)) {
    throw new InputInvariantViolationError(
      'INVALID_STORAGE_KEY',
      'IngressContentRecord.storageKey must be a non-empty string.'
    );
  }

  if (!isCanonicalUtcInstant(candidate.receivedAt)) {
    throw new InputInvariantViolationError(
      'INVALID_RECEIVED_AT',
      `IngressContentRecord.receivedAt must be a valid ISO 8601 UTC instant ending in 'Z', got '${String(
        candidate.receivedAt
      )}'.`
    );
  }

  if (candidate.expiresAt !== undefined) {
    if (!isCanonicalUtcInstant(candidate.expiresAt)) {
      throw new InputInvariantViolationError(
        'INVALID_EXPIRES_AT',
        `IngressContentRecord.expiresAt must be a valid ISO 8601 UTC instant ending in 'Z', got '${String(
          candidate.expiresAt
        )}'.`
      );
    }
    if (new Date(candidate.expiresAt).getTime() <= new Date(candidate.receivedAt as string).getTime()) {
      throw new InputInvariantViolationError(
        'INVALID_EXPIRES_AT_ORDER',
        `IngressContentRecord.expiresAt ('${candidate.expiresAt}') must be after receivedAt ('${candidate.receivedAt}').`
      );
    }
  }
}

// ============================================================================
// 10. VALIDAÇÃO DE DRAFT DE INPUT RECORD
// ============================================================================

export function validateRecordInputDraft(draft: unknown): asserts draft is RecordInputDraft {
  if (!draft || typeof draft !== 'object') {
    throw new InputInvariantViolationError(
      'INVALID_RECORD_INPUT_DRAFT',
      'RecordInputDraft must be a non-null object.'
    );
  }
  const candidate = draft as Record<string, unknown>;
  assertExactKeys(
    candidate,
    ['inputId', 'parts', 'sourceRefId', 'sourceEventIdentity', 'occurredAt'],
    'RecordInputDraft'
  );

  if (candidate.inputId !== undefined) {
    validateInputRecordId(candidate.inputId);
  }

  if (candidate.sourceRefId !== undefined && !isNonEmptyString(candidate.sourceRefId)) {
    throw new InputInvariantViolationError(
      'INVALID_SOURCE_REF_ID',
      'RecordInputDraft.sourceRefId must be a non-empty string when provided.'
    );
  }

  if (candidate.sourceEventIdentity !== undefined) {
    validateSourceEventIdentity(candidate.sourceEventIdentity);
  }

  if (candidate.occurredAt !== undefined && !isCanonicalUtcInstant(candidate.occurredAt)) {
    throw new InputInvariantViolationError(
      'INVALID_OCCURRED_AT',
      `RecordInputDraft.occurredAt must be a valid ISO 8601 UTC instant ending in 'Z', got '${String(
        candidate.occurredAt
      )}'.`
    );
  }

  if (!Array.isArray(candidate.parts) || candidate.parts.length === 0) {
    throw new InputInvariantViolationError(
      'EMPTY_PARTS_ARRAY',
      'RecordInputDraft.parts must be a non-empty array with at least 1 part.'
    );
  }

  for (let i = 0; i < candidate.parts.length; i++) {
    validateInputPart(candidate.parts[i]);
  }
}
