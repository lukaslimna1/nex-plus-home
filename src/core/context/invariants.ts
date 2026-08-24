/**
 * NEX+ · Invariantes & Validadores Puros de Contexto Operacional
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 *
 * Funções determinísticas puras (sem I/O, sem chamadas externas).
 * Aplica validação estrita baseada em allowlists para impedir passagem de
 * segredos materiais (tokens, senhas, cookies, JWT) e campos runtime arbitrários.
 */

import type { Actor, ActorKind } from '../observations/contracts';
import { isValidSessionRef } from '../../auth/session-ref.types';
import type {
  ContextSubjectRef,
  FlowRef,
  ContextScopeRef,
  ContextAnchorRef,
  OperationalLocation,
  ContextAspectRef,
  OperationalFocus,
  ObservedInteractionContext,
  OperationalContext,
  SessionOperationalState,
} from './contracts';
import {
  OperationalContextInvariantError,
  SessionOperationalStateInvariantError,
} from './errors';

// ============================================================================
// 1. HELPERS DE STRING E VALIDAÇÃO TEMPORAL CANÔNICA (UTC 'Z')
// ============================================================================

export function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}

/**
 * Validador estrito de instantes temporais canônicos do NEX+.
 * Exige padrão ISO 8601 UTC estritamente terminado em 'Z'.
 * Rejeita offsets (+03:00), strings sem timezone ou datas inválidas.
 */
export function isCanonicalUtcInstant(val: unknown): val is string {
  if (typeof val !== 'string' || val.trim() === '') return false;

  const isoUtcRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
  if (!isoUtcRegex.test(val)) return false;

  const d = new Date(val);
  if (isNaN(d.getTime())) return false;

  // Garantir que a data não sofreu overflow de calendário
  const [datePart] = val.split('T');
  const [dYear, dMonth, dDay] = datePart.split('-').map((s) => parseInt(s, 10));
  if (d.getUTCFullYear() !== dYear || d.getUTCMonth() + 1 !== dMonth || d.getUTCDate() !== dDay) {
    return false;
  }

  return true;
}

/**
 * Helper estrito de validação de chaves por allowlist (Zero Arbitrary/Secret Leak).
 */
export function assertExactKeys(
  obj: Record<string, unknown>,
  allowedKeys: readonly string[],
  errorType: 'OperationalContext' | 'SessionOperationalState',
  contextDescription: string
): void {
  const allowedSet = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      if (errorType === 'SessionOperationalState') {
        throw new SessionOperationalStateInvariantError(
          'UNEXPECTED_PROPERTY',
          `${contextDescription} contains forbidden/unexpected property '${key}'.`
        );
      }
      throw new OperationalContextInvariantError(
        'UNEXPECTED_PROPERTY',
        `${contextDescription} contains forbidden/unexpected property '${key}'.`
      );
    }
  }
}

// ============================================================================
// 2. VALIDAÇÃO DE ATORES (ALLOWLIST ESTREITA POR VARIANTE CANÔNICA 0.85)
// ============================================================================

const ALLOWED_ACTOR_KINDS = new Set<ActorKind>(['human', 'max', 'system', 'integration']);

export function validateActor(val: unknown): asserts val is Actor {
  if (!val || typeof val !== 'object') {
    throw new OperationalContextInvariantError(
      'INVALID_ACTOR',
      'Actor must be a non-null object.'
    );
  }

  const candidate = val as Record<string, unknown>;
  if (typeof candidate.kind !== 'string') {
    throw new OperationalContextInvariantError(
      'INVALID_ACTOR_KIND',
      'Actor.kind must be a string.'
    );
  }

  if (!ALLOWED_ACTOR_KINDS.has(candidate.kind as ActorKind)) {
    throw new OperationalContextInvariantError(
      'INVALID_ACTOR_KIND',
      `Actor.kind '${String(candidate.kind)}' is not an allowed Actor variant.`
    );
  }

  switch (candidate.kind) {
    case 'human':
      assertExactKeys(
        candidate,
        ['kind', 'humanId', 'role', 'authorityRef'],
        'OperationalContext',
        'HumanActor'
      );
      if (!isNonEmptyString(candidate.humanId)) {
        throw new OperationalContextInvariantError(
          'INVALID_ACTOR_HUMAN_ID',
          'HumanActor.humanId must be a non-empty string.'
        );
      }
      if (candidate.role !== undefined && !isNonEmptyString(candidate.role)) {
        throw new OperationalContextInvariantError(
          'INVALID_ACTOR_ROLE',
          'HumanActor.role when provided must be a non-empty string.'
        );
      }
      if (candidate.authorityRef !== undefined && !isNonEmptyString(candidate.authorityRef)) {
        throw new OperationalContextInvariantError(
          'INVALID_ACTOR_AUTHORITY_REF',
          'HumanActor.authorityRef when provided must be a non-empty string.'
        );
      }
      break;

    case 'max':
      assertExactKeys(
        candidate,
        ['kind', 'maxVersion', 'sessionRef'],
        'OperationalContext',
        'MaxActor'
      );
      if (!isNonEmptyString(candidate.maxVersion)) {
        throw new OperationalContextInvariantError(
          'INVALID_ACTOR_MAX_VERSION',
          'MaxActor.maxVersion must be a non-empty string.'
        );
      }
      if (candidate.sessionRef !== undefined && !isNonEmptyString(candidate.sessionRef)) {
        throw new OperationalContextInvariantError(
          'INVALID_ACTOR_SESSION_REF',
          'MaxActor.sessionRef when provided must be a non-empty string.'
        );
      }
      break;

    case 'system':
      assertExactKeys(
        candidate,
        ['kind', 'component', 'version'],
        'OperationalContext',
        'SystemActor'
      );
      if (!isNonEmptyString(candidate.component)) {
        throw new OperationalContextInvariantError(
          'INVALID_ACTOR_COMPONENT',
          'SystemActor.component must be a non-empty string.'
        );
      }
      if (candidate.version !== undefined && !isNonEmptyString(candidate.version)) {
        throw new OperationalContextInvariantError(
          'INVALID_ACTOR_VERSION',
          'SystemActor.version when provided must be a non-empty string.'
        );
      }
      break;

    case 'integration':
      assertExactKeys(
        candidate,
        ['kind', 'provider', 'integrationId'],
        'OperationalContext',
        'IntegrationActor'
      );
      if (!isNonEmptyString(candidate.provider)) {
        throw new OperationalContextInvariantError(
          'INVALID_ACTOR_PROVIDER',
          'IntegrationActor.provider must be a non-empty string.'
        );
      }
      if (candidate.integrationId !== undefined && !isNonEmptyString(candidate.integrationId)) {
        throw new OperationalContextInvariantError(
          'INVALID_ACTOR_INTEGRATION_ID',
          'IntegrationActor.integrationId when provided must be a non-empty string.'
        );
      }
      break;
  }
}

export function isActor(val: unknown): val is Actor {
  try {
    validateActor(val);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// 3. VALIDAÇÃO DE REFS DE CONTEXTO
// ============================================================================

export function validateContextSubjectRef(ref: unknown): asserts ref is ContextSubjectRef {
  if (!ref || typeof ref !== 'object') {
    throw new OperationalContextInvariantError(
      'INVALID_CONTEXT_SUBJECT_REF',
      'ContextSubjectRef must be a non-null object.'
    );
  }
  const candidate = ref as Record<string, unknown>;
  assertExactKeys(
    candidate,
    ['subjectType', 'subjectId'],
    'OperationalContext',
    'ContextSubjectRef'
  );
  if (!isNonEmptyString(candidate.subjectType)) {
    throw new OperationalContextInvariantError(
      'INVALID_SUBJECT_TYPE',
      'ContextSubjectRef.subjectType must be a non-empty string.'
    );
  }
  if (!isNonEmptyString(candidate.subjectId)) {
    throw new OperationalContextInvariantError(
      'INVALID_SUBJECT_ID',
      'ContextSubjectRef.subjectId must be a non-empty string.'
    );
  }
}

export function validateFlowRef(ref: unknown): asserts ref is FlowRef {
  if (!ref || typeof ref !== 'object') {
    throw new OperationalContextInvariantError(
      'INVALID_FLOW_REF',
      'FlowRef must be a non-null object.'
    );
  }
  const candidate = ref as Record<string, unknown>;
  assertExactKeys(
    candidate,
    ['flowType', 'flowId'],
    'OperationalContext',
    'FlowRef'
  );
  if (!isNonEmptyString(candidate.flowType)) {
    throw new OperationalContextInvariantError(
      'INVALID_FLOW_TYPE',
      'FlowRef.flowType must be a non-empty string.'
    );
  }
  if (!isNonEmptyString(candidate.flowId)) {
    throw new OperationalContextInvariantError(
      'INVALID_FLOW_ID',
      'FlowRef.flowId must be a non-empty string.'
    );
  }
}

export function validateContextScopeRef(ref: unknown): asserts ref is ContextScopeRef {
  if (!ref || typeof ref !== 'object') {
    throw new OperationalContextInvariantError(
      'INVALID_CONTEXT_SCOPE_REF',
      'ContextScopeRef must be a non-null object.'
    );
  }
  const candidate = ref as Record<string, unknown>;
  assertExactKeys(
    candidate,
    ['module', 'scopeType', 'scopeId'],
    'OperationalContext',
    'ContextScopeRef'
  );

  if (!candidate.module || typeof candidate.module !== 'object') {
    throw new OperationalContextInvariantError(
      'INVALID_SCOPE_MODULE',
      'ContextScopeRef.module must be a valid ModuleRef object.'
    );
  }
  const modCandidate = candidate.module as Record<string, unknown>;
  assertExactKeys(modCandidate, ['moduleKey'], 'OperationalContext', 'ModuleRef');
  if (!isNonEmptyString(modCandidate.moduleKey)) {
    throw new OperationalContextInvariantError(
      'INVALID_SCOPE_MODULE',
      'ContextScopeRef.module.moduleKey must be a non-empty string.'
    );
  }

  if (!isNonEmptyString(candidate.scopeType)) {
    throw new OperationalContextInvariantError(
      'INVALID_SCOPE_TYPE',
      'ContextScopeRef.scopeType must be a non-empty string.'
    );
  }
  if (!isNonEmptyString(candidate.scopeId)) {
    throw new OperationalContextInvariantError(
      'INVALID_SCOPE_ID',
      'ContextScopeRef.scopeId must be a non-empty string.'
    );
  }
}

export function validateContextAnchorRef(ref: unknown): asserts ref is ContextAnchorRef {
  if (!ref || typeof ref !== 'object') {
    throw new OperationalContextInvariantError(
      'INVALID_CONTEXT_ANCHOR_REF',
      'ContextAnchorRef must be a non-null object.'
    );
  }
  const candidate = ref as Record<string, unknown>;

  if (candidate.kind === 'resource') {
    assertExactKeys(
      candidate,
      ['kind', 'resource'],
      'OperationalContext',
      "ContextAnchorRef (kind='resource')"
    );

    const res = candidate.resource as Record<string, unknown> | undefined;
    if (!res || typeof res !== 'object') {
      throw new OperationalContextInvariantError(
        'INVALID_ANCHOR_RESOURCE_REF',
        "ContextAnchorRef with kind 'resource' must contain a valid ResourceRef object."
      );
    }
    assertExactKeys(res, ['ownerModule', 'resourceType', 'resourceId'], 'OperationalContext', 'ResourceRef');

    const mod = res.ownerModule as Record<string, unknown> | undefined;
    if (!mod || typeof mod !== 'object') {
      throw new OperationalContextInvariantError(
        'INVALID_ANCHOR_RESOURCE_REF',
        'ResourceRef.ownerModule must be a valid ModuleRef object.'
      );
    }
    assertExactKeys(mod, ['moduleKey'], 'OperationalContext', 'ModuleRef');
    if (!isNonEmptyString(mod.moduleKey) || !isNonEmptyString(res.resourceType) || !isNonEmptyString(res.resourceId)) {
      throw new OperationalContextInvariantError(
        'INVALID_ANCHOR_RESOURCE_REF',
        "ResourceRef must contain valid non-empty ownerModule.moduleKey, resourceType, and resourceId."
      );
    }
  } else if (candidate.kind === 'scope') {
    assertExactKeys(
      candidate,
      ['kind', 'scope'],
      'OperationalContext',
      "ContextAnchorRef (kind='scope')"
    );
    validateContextScopeRef(candidate.scope);
  } else {
    throw new OperationalContextInvariantError(
      'INVALID_ANCHOR_KIND',
      `ContextAnchorRef.kind must be either 'resource' or 'scope', got '${String(candidate.kind)}'.`
    );
  }
}

export function validateOperationalLocation(loc: unknown): asserts loc is OperationalLocation {
  if (!loc || typeof loc !== 'object') {
    throw new OperationalContextInvariantError(
      'INVALID_OPERATIONAL_LOCATION',
      'OperationalLocation must be a non-null object.'
    );
  }
  const candidate = loc as Record<string, unknown>;
  assertExactKeys(
    candidate,
    ['module', 'trail'],
    'OperationalContext',
    'OperationalLocation'
  );

  if (!candidate.module || typeof candidate.module !== 'object') {
    throw new OperationalContextInvariantError(
      'INVALID_LOCATION_MODULE',
      'OperationalLocation.module must be a valid ModuleRef object.'
    );
  }
  const modCandidate = candidate.module as Record<string, unknown>;
  assertExactKeys(modCandidate, ['moduleKey'], 'OperationalContext', 'ModuleRef');
  if (!isNonEmptyString(modCandidate.moduleKey)) {
    throw new OperationalContextInvariantError(
      'INVALID_LOCATION_MODULE',
      'OperationalLocation.module.moduleKey must be a non-empty string.'
    );
  }

  if (!Array.isArray(candidate.trail)) {
    throw new OperationalContextInvariantError(
      'INVALID_LOCATION_TRAIL',
      'OperationalLocation.trail must be an array of ContextAnchorRef.'
    );
  }
  for (const item of candidate.trail) {
    validateContextAnchorRef(item);
  }
}

export function validateContextAspectRef(aspect: unknown): asserts aspect is ContextAspectRef {
  if (!aspect || typeof aspect !== 'object') {
    throw new OperationalContextInvariantError(
      'INVALID_CONTEXT_ASPECT_REF',
      'ContextAspectRef must be a non-null object.'
    );
  }
  const candidate = aspect as Record<string, unknown>;
  assertExactKeys(
    candidate,
    ['target', 'aspectKey'],
    'OperationalContext',
    'ContextAspectRef'
  );
  validateContextAnchorRef(candidate.target);
  if (!isNonEmptyString(candidate.aspectKey)) {
    throw new OperationalContextInvariantError(
      'INVALID_ASPECT_KEY',
      'ContextAspectRef.aspectKey must be a non-empty string.'
    );
  }
}

export function validateOperationalFocus(focus: unknown): asserts focus is OperationalFocus {
  if (!focus || typeof focus !== 'object') {
    throw new OperationalContextInvariantError(
      'INVALID_OPERATIONAL_FOCUS',
      'OperationalFocus must be a non-null object.'
    );
  }
  const candidate = focus as Record<string, unknown>;
  assertExactKeys(
    candidate,
    ['primaryTarget', 'relatedTargets', 'activeAspects', 'visibleAspects', 'action'],
    'OperationalContext',
    'OperationalFocus'
  );

  if (candidate.primaryTarget !== undefined) {
    validateContextAnchorRef(candidate.primaryTarget);
  }

  if (candidate.relatedTargets !== undefined) {
    if (!Array.isArray(candidate.relatedTargets)) {
      throw new OperationalContextInvariantError(
        'INVALID_RELATED_TARGETS',
        'OperationalFocus.relatedTargets must be an array of ContextAnchorRef.'
      );
    }
    for (const item of candidate.relatedTargets) {
      validateContextAnchorRef(item);
    }
  }

  if (candidate.activeAspects !== undefined) {
    if (!Array.isArray(candidate.activeAspects)) {
      throw new OperationalContextInvariantError(
        'INVALID_ACTIVE_ASPECTS',
        'OperationalFocus.activeAspects must be an array of ContextAspectRef.'
      );
    }
    for (const item of candidate.activeAspects) {
      validateContextAspectRef(item);
    }
  }

  if (candidate.visibleAspects !== undefined) {
    if (!Array.isArray(candidate.visibleAspects)) {
      throw new OperationalContextInvariantError(
        'INVALID_VISIBLE_ASPECTS',
        'OperationalFocus.visibleAspects must be an array of ContextAspectRef.'
      );
    }
    for (const item of candidate.visibleAspects) {
      validateContextAspectRef(item);
    }
  }

  if (candidate.action !== undefined && !isNonEmptyString(candidate.action)) {
    throw new OperationalContextInvariantError(
      'INVALID_FOCUS_ACTION',
      'OperationalFocus.action when provided must be a non-empty string.'
    );
  }
}

export function validateObservedInteractionContext(
  observed: unknown
): asserts observed is ObservedInteractionContext {
  if (!observed || typeof observed !== 'object') {
    throw new OperationalContextInvariantError(
      'INVALID_OBSERVED_INTERACTION',
      'ObservedInteractionContext must be a non-null object.'
    );
  }
  const candidate = observed as Record<string, unknown>;
  assertExactKeys(
    candidate,
    ['origin', 'observedAt', 'location', 'focus'],
    'OperationalContext',
    'ObservedInteractionContext'
  );

  if (candidate.origin !== 'client_observed') {
    throw new OperationalContextInvariantError(
      'INVALID_OBSERVED_ORIGIN',
      `ObservedInteractionContext.origin must be exactly 'client_observed', got '${String(candidate.origin)}'.`
    );
  }
  if (!isCanonicalUtcInstant(candidate.observedAt)) {
    throw new OperationalContextInvariantError(
      'INVALID_OBSERVED_AT',
      `ObservedInteractionContext.observedAt must be a valid ISO 8601 UTC instant ending in 'Z', got '${String(candidate.observedAt)}'.`
    );
  }
  if (candidate.location !== undefined) {
    validateOperationalLocation(candidate.location);
  }
  if (candidate.focus !== undefined) {
    validateOperationalFocus(candidate.focus);
  }
}

// ============================================================================
// 4. VALIDAÇÃO PRINCIPAL DE OPERATIONAL CONTEXT
// ============================================================================

export function validateOperationalContext(ctx: unknown): asserts ctx is OperationalContext {
  if (!ctx || typeof ctx !== 'object') {
    throw new OperationalContextInvariantError(
      'INVALID_OPERATIONAL_CONTEXT',
      'OperationalContext must be a non-null object.'
    );
  }
  const candidate = ctx as Record<string, unknown>;
  assertExactKeys(
    candidate,
    [
      'actor',
      'userId',
      'sessionRef',
      'contextSubjectRef',
      'location',
      'focus',
      'observedInteraction',
      'flowRef',
      'correlationId',
      'channel',
    ],
    'OperationalContext',
    'OperationalContext'
  );

  // 1. actor válido por allowlist estrita
  validateActor(candidate.actor);

  // 2. Validação de sessionRef e userId
  if (candidate.sessionRef !== undefined) {
    if (!isValidSessionRef(candidate.sessionRef)) {
      throw new OperationalContextInvariantError(
        'INVALID_SESSION_REF',
        'OperationalContext.sessionRef must be a valid 64-char lowercase hexadecimal SessionRef.'
      );
    }
    // Se sessionRef existir, userId é obrigatório
    if (!isNonEmptyString(candidate.userId)) {
      throw new OperationalContextInvariantError(
        'MISSING_USER_ID_FOR_SESSION',
        'OperationalContext.userId is mandatory when sessionRef is present.'
      );
    }
  }

  // 3. userId quando presente deve ser string não vazia
  if (candidate.userId !== undefined && !isNonEmptyString(candidate.userId)) {
    throw new OperationalContextInvariantError(
      'INVALID_USER_ID',
      'OperationalContext.userId must be a non-empty string when provided.'
    );
  }

  // 4. Se actor.kind === 'human' E sessionRef existir, actor.humanId === userId
  if (candidate.actor.kind === 'human' && candidate.sessionRef !== undefined) {
    if (candidate.actor.humanId !== candidate.userId) {
      throw new OperationalContextInvariantError(
        'HUMAN_ACTOR_USER_MISMATCH',
        `OperationalContext human actor humanId ('${candidate.actor.humanId}') must match userId ('${String(candidate.userId)}').`
      );
    }
  }

  // 5. contextSubjectRef
  if (candidate.contextSubjectRef !== undefined) {
    if (candidate.contextSubjectRef === null) {
      throw new OperationalContextInvariantError(
        'INVALID_CONTEXT_SUBJECT_REF',
        'OperationalContext.contextSubjectRef must be either a valid ContextSubjectRef or undefined (null is not allowed in canonical context).'
      );
    }
    validateContextSubjectRef(candidate.contextSubjectRef);
  }

  // 6. location
  if (candidate.location !== undefined) {
    validateOperationalLocation(candidate.location);
  }

  // 7. focus
  if (candidate.focus !== undefined) {
    validateOperationalFocus(candidate.focus);
  }

  // 8. observedInteraction
  if (candidate.observedInteraction !== undefined) {
    validateObservedInteractionContext(candidate.observedInteraction);
  }

  // 9. flowRef
  if (candidate.flowRef !== undefined) {
    validateFlowRef(candidate.flowRef);
  }

  // 10. correlationId
  if (candidate.correlationId !== undefined && !isNonEmptyString(candidate.correlationId)) {
    throw new OperationalContextInvariantError(
      'INVALID_CORRELATION_ID',
      'OperationalContext.correlationId must be a non-empty string when provided.'
    );
  }

  // 11. channel
  if (candidate.channel !== undefined && !isNonEmptyString(candidate.channel)) {
    throw new OperationalContextInvariantError(
      'INVALID_CHANNEL',
      'OperationalContext.channel must be a non-empty string when provided.'
    );
  }
}

// ============================================================================
// 5. VALIDAÇÃO DE SESSION OPERATIONAL STATE (SHAPE MÍNIMO ESTRITO)
// ============================================================================

export function validateSessionOperationalState(state: unknown): asserts state is SessionOperationalState {
  if (!state || typeof state !== 'object') {
    throw new SessionOperationalStateInvariantError(
      'INVALID_STATE_OBJECT',
      'SessionOperationalState must be a non-null object.'
    );
  }
  const candidate = state as Record<string, unknown>;

  // Assert exact minimal keys — reject any extra property (jwt, cookie, module, focus, route, secret, etc.)
  assertExactKeys(
    candidate,
    ['sessionRef', 'userId', 'contextSubjectRef', 'revision', 'createdAt', 'updatedAt'],
    'SessionOperationalState',
    'SessionOperationalState'
  );

  if (!isValidSessionRef(candidate.sessionRef)) {
    throw new SessionOperationalStateInvariantError(
      'INVALID_SESSION_REF',
      'SessionOperationalState.sessionRef must be a valid 64-char lowercase hexadecimal SessionRef.'
    );
  }

  if (!isNonEmptyString(candidate.userId)) {
    throw new SessionOperationalStateInvariantError(
      'INVALID_USER_ID',
      'SessionOperationalState.userId must be a non-empty string.'
    );
  }

  if (
    typeof candidate.revision !== 'number' ||
    !Number.isInteger(candidate.revision) ||
    candidate.revision < 1
  ) {
    throw new SessionOperationalStateInvariantError(
      'INVALID_REVISION',
      `SessionOperationalState.revision must be an integer >= 1, got ${String(candidate.revision)}.`
    );
  }

  if (!isCanonicalUtcInstant(candidate.createdAt)) {
    throw new SessionOperationalStateInvariantError(
      'INVALID_CREATED_AT',
      `SessionOperationalState.createdAt must be a valid ISO 8601 UTC instant ending in 'Z', got '${String(candidate.createdAt)}'.`
    );
  }

  if (!isCanonicalUtcInstant(candidate.updatedAt)) {
    throw new SessionOperationalStateInvariantError(
      'INVALID_UPDATED_AT',
      `SessionOperationalState.updatedAt must be a valid ISO 8601 UTC instant ending in 'Z', got '${String(candidate.updatedAt)}'.`
    );
  }

  if (candidate.contextSubjectRef !== undefined) {
    if (candidate.contextSubjectRef === null) {
      throw new SessionOperationalStateInvariantError(
        'INVALID_CONTEXT_SUBJECT_REF',
        'SessionOperationalState.contextSubjectRef must be either a valid ContextSubjectRef or undefined/absent (null is not allowed in canonical state).'
      );
    }
    validateContextSubjectRef(candidate.contextSubjectRef);
  }
}
