/**
 * NEX+ · Invariantes & Validadores Runtime de Material Context Pin
 * Escopo 0.86 (Bloco 0.86B · Checkpoint 0.86B-4)
 *
 * Princípios de Runtime Strictness & Deep Immutability:
 * 1. Sanitização e validação de 7 variantes canônicas de MaterialContextItem.
 * 2. Rejeição estrita de kinds não-canônicos (como transitórios de Ingress, content_ref, event_ref).
 * 3. Validação de JSON semântico estrito (rejeita NaN, Infinity, undefined, BigInt, Date, Buffer, Map, Set, functions, symbols, cycles).
 * 4. JSON null é explicitamente aceito como valor material válido.
 * 5. Reconstrução defensiva e congelamento profundo (Object.freeze) em todos os níveis.
 */

import type {
  MaterialContextPinId,
  MaterialContextItem,
  MaterialContextPin,
  PinMaterialContextDraft,
  MaterialInputRef,
  MaterialObservationRef,
  MaterialCanonicalProjectionRef,
  MaterialEvidenceRef,
  MaterialPrecedentRef,
  MaterialResourceRef,
  MaterialAspectSnapshot,
} from './contracts';
import { MaterialContextInvariantViolationError } from './errors';
import type { Actor } from '../observations/contracts';
import type { ContextSubjectRef, FlowRef, ContextAspectRef, ContextAnchorRef } from '../context/contracts';
import type { ResourceRef, JsonValue } from '../modules/contracts';

/**
 * Valida se um instant é uma data ISO 8601 UTC canônica com 'Z'.
 */
export function isCanonicalUtcInstant(val: unknown): boolean {
  if (typeof val !== 'string' || !val.endsWith('Z')) return false;
  const d = new Date(val);
  return !isNaN(d.getTime()) && d.toISOString() === val;
}

/**
 * Valida identificador de MaterialContextPin.
 */
export function validateMaterialContextPinId(pinId: unknown): asserts pinId is MaterialContextPinId {
  if (typeof pinId !== 'string' || pinId.trim().length === 0) {
    throw new MaterialContextInvariantViolationError(
      'INVALID_PIN_ID',
      `MaterialContextPinId must be a non-empty string, got '${String(pinId)}'.`
    );
  }
}

/**
 * Sanitiza e valida um valor JSON de forma estrita:
 * - Aceita: string, boolean, null, número finito, arrays e plain objects.
 * - Rejeita: undefined, NaN, Infinity, -Infinity, BigInt, function, symbol, Date, Buffer, Map, Set, class instances e referências circulares.
 * - Reconstrói defensivamente e congela profundamente todos os nós.
 */
export function sanitizeJsonMaterialValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null) {
    return null;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MaterialContextInvariantViolationError(
        'INVALID_JSON_NUMBER',
        `Non-finite numbers (${value}) are prohibited in material snapshot values.`
      );
    }
    return value;
  }

  if (typeof value === 'undefined') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_JSON_UNDEFINED',
      'undefined is not a valid JSON material value.'
    );
  }

  if (typeof value === 'bigint') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_JSON_BIGINT',
      'BigInt is not serializable to standard JSON in material snapshot values.'
    );
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_JSON_TYPE',
      `Type '${typeof value}' is prohibited in material snapshot values.`
    );
  }

  if (typeof value === 'object') {
    // Rejeita Date, Buffer/TypedArray, Map, Set, RegExp, etc.
    if (value instanceof Date) {
      throw new MaterialContextInvariantViolationError(
        'INVALID_JSON_DATE_INSTANCE',
        'Date instances are prohibited in JSON material values; use ISO 8601 strings.'
      );
    }
    if (typeof (Buffer as any)?.isBuffer === 'function' && Buffer.isBuffer(value)) {
      throw new MaterialContextInvariantViolationError(
        'INVALID_JSON_BUFFER_INSTANCE',
        'Buffer instances are prohibited in JSON material values.'
      );
    }
    if (value instanceof Map || value instanceof Set) {
      throw new MaterialContextInvariantViolationError(
        'INVALID_JSON_COLLECTION',
        'Map and Set collections are prohibited in JSON material values.'
      );
    }

    // Detecção de referências circulares na pilha de ancestrais
    if (seen.has(value)) {
      throw new MaterialContextInvariantViolationError(
        'CIRCULAR_REFERENCE_DETECTED',
        'Circular references are prohibited in material snapshot values.'
      );
    }
    seen.add(value);

    try {
      // Arrays
      if (Array.isArray(value)) {
        const sanitizedArray = value.map((item) => sanitizeJsonMaterialValue(item, seen));
        return Object.freeze(sanitizedArray);
      }

      // Plain objects (garante prototype Object ou null)
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new MaterialContextInvariantViolationError(
          'INVALID_CLASS_INSTANCE',
          `Arbitrary class instances (${value.constructor?.name ?? 'unknown'}) are prohibited in JSON material values.`
        );
      }

      const sanitizedObj: Record<string, JsonValue> = {};
      for (const key of Object.keys(value)) {
        const val = (value as Record<string, unknown>)[key];
        if (typeof val === 'undefined') {
          throw new MaterialContextInvariantViolationError(
            'INVALID_OBJECT_UNDEFINED_PROPERTY',
            `Property '${key}' has value undefined which is invalid in JSON.`
          );
        }
        const sanitizedVal = sanitizeJsonMaterialValue(val, seen);
        Object.defineProperty(sanitizedObj, key, {
          value: sanitizedVal,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }

      return Object.freeze(sanitizedObj);
    } finally {
      seen.delete(value);
    }
  }

  throw new MaterialContextInvariantViolationError(
    'UNRECOGNIZED_JSON_VALUE',
    `Unrecognized value type '${typeof value}' in material snapshot.`
  );
}

/**
 * Sanitiza e congela ResourceRef.
 */
export function sanitizeResourceRef(resource: unknown): ResourceRef {
  if (!resource || typeof resource !== 'object') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_RESOURCE_REF',
      'ResourceRef must be a non-null object.'
    );
  }
  const r = resource as Record<string, unknown>;

  const allowedKeys = new Set(['ownerModule', 'resourceType', 'resourceId']);
  for (const k of Object.keys(r)) {
    if (!allowedKeys.has(k)) {
      throw new MaterialContextInvariantViolationError(
        'RESOURCE_REF_EXTRA_KEYS',
        `ResourceRef contained unauthorized extra key '${k}'.`
      );
    }
  }

  if (!r.ownerModule || typeof r.ownerModule !== 'object') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_RESOURCE_OWNER_MODULE',
      'ResourceRef.ownerModule must be a non-null object.'
    );
  }
  const om = r.ownerModule as Record<string, unknown>;
  if (typeof om.moduleKey !== 'string' || om.moduleKey.trim().length === 0) {
    throw new MaterialContextInvariantViolationError(
      'INVALID_RESOURCE_MODULE_KEY',
      'ResourceRef.ownerModule.moduleKey must be a non-empty string.'
    );
  }

  if (typeof r.resourceType !== 'string' || r.resourceType.trim().length === 0) {
    throw new MaterialContextInvariantViolationError(
      'INVALID_RESOURCE_TYPE',
      'ResourceRef.resourceType must be a non-empty string.'
    );
  }

  if (typeof r.resourceId !== 'string' || r.resourceId.trim().length === 0) {
    throw new MaterialContextInvariantViolationError(
      'INVALID_RESOURCE_ID',
      'ResourceRef.resourceId must be a non-empty string.'
    );
  }

  return Object.freeze({
    ownerModule: Object.freeze({
      moduleKey: om.moduleKey.trim() as any,
    }),
    resourceType: r.resourceType.trim() as any,
    resourceId: r.resourceId.trim() as any,
  });
}

/**
 * Sanitiza e congela ContextAnchorRef.
 */
export function sanitizeContextAnchorRef(anchor: unknown): ContextAnchorRef {
  if (!anchor || typeof anchor !== 'object') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_ANCHOR_REF',
      'ContextAnchorRef must be a non-null object.'
    );
  }
  const a = anchor as Record<string, unknown>;

  if (a.kind === 'resource') {
    const allowed = new Set(['kind', 'resource']);
    for (const k of Object.keys(a)) {
      if (!allowed.has(k)) {
        throw new MaterialContextInvariantViolationError(
          'ANCHOR_RESOURCE_EXTRA_KEYS',
          `ContextAnchorRef(resource) contained extra key '${k}'.`
        );
      }
    }
    return Object.freeze({
      kind: 'resource',
      resource: sanitizeResourceRef(a.resource),
    });
  }

  if (a.kind === 'scope') {
    const allowed = new Set(['kind', 'scope']);
    for (const k of Object.keys(a)) {
      if (!allowed.has(k)) {
        throw new MaterialContextInvariantViolationError(
          'ANCHOR_SCOPE_EXTRA_KEYS',
          `ContextAnchorRef(scope) contained extra key '${k}'.`
        );
      }
    }

    if (!a.scope || typeof a.scope !== 'object') {
      throw new MaterialContextInvariantViolationError(
        'INVALID_CONTEXT_SCOPE',
        'ContextScopeRef must be a non-null object.'
      );
    }
    const s = a.scope as Record<string, unknown>;
    const scopeAllowed = new Set(['module', 'scopeType', 'scopeId']);
    for (const k of Object.keys(s)) {
      if (!scopeAllowed.has(k)) {
        throw new MaterialContextInvariantViolationError(
          'SCOPE_REF_EXTRA_KEYS',
          `ContextScopeRef contained extra key '${k}'.`
        );
      }
    }

    if (!s.module || typeof s.module !== 'object') {
      throw new MaterialContextInvariantViolationError(
        'INVALID_SCOPE_MODULE',
        'ContextScopeRef.module must be a non-null object.'
      );
    }
    const m = s.module as Record<string, unknown>;
    if (typeof m.moduleKey !== 'string' || m.moduleKey.trim().length === 0) {
      throw new MaterialContextInvariantViolationError(
        'INVALID_SCOPE_MODULE_KEY',
        'ContextScopeRef.module.moduleKey must be a non-empty string.'
      );
    }

    if (typeof s.scopeType !== 'string' || s.scopeType.trim().length === 0) {
      throw new MaterialContextInvariantViolationError(
        'INVALID_SCOPE_TYPE',
        'ContextScopeRef.scopeType must be a non-empty string.'
      );
    }

    if (typeof s.scopeId !== 'string' || s.scopeId.trim().length === 0) {
      throw new MaterialContextInvariantViolationError(
        'INVALID_SCOPE_ID',
        'ContextScopeRef.scopeId must be a non-empty string.'
      );
    }

    return Object.freeze({
      kind: 'scope',
      scope: Object.freeze({
        module: Object.freeze({ moduleKey: m.moduleKey.trim() as any }),
        scopeType: s.scopeType.trim() as any,
        scopeId: s.scopeId.trim() as any,
      }),
    });
  }

  throw new MaterialContextInvariantViolationError(
    'INVALID_ANCHOR_KIND',
    `ContextAnchorRef.kind must be 'resource' or 'scope', got '${String(a.kind)}'.`
  );
}

/**
 * Sanitiza e congela ContextAspectRef.
 */
export function sanitizeContextAspectRef(aspect: unknown): ContextAspectRef {
  if (!aspect || typeof aspect !== 'object') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_ASPECT_REF',
      'ContextAspectRef must be a non-null object.'
    );
  }
  const a = aspect as Record<string, unknown>;

  const allowedKeys = new Set(['target', 'aspectKey']);
  for (const k of Object.keys(a)) {
    if (!allowedKeys.has(k)) {
      throw new MaterialContextInvariantViolationError(
        'ASPECT_REF_EXTRA_KEYS',
        `ContextAspectRef contained unauthorized extra key '${k}'.`
      );
    }
  }

  if (typeof a.aspectKey !== 'string' || a.aspectKey.trim().length === 0) {
    throw new MaterialContextInvariantViolationError(
      'INVALID_ASPECT_KEY',
      'ContextAspectRef.aspectKey must be a non-empty string.'
    );
  }

  const target = sanitizeContextAnchorRef(a.target);

  return Object.freeze({
    target,
    aspectKey: a.aspectKey.trim() as any,
  });
}

/**
 * Sanitiza e valida uma variante individual de MaterialContextItem.
 * Constrói defensivamente e congela profundamente.
 */
export function sanitizeMaterialContextItem(item: unknown): MaterialContextItem {
  if (!item || typeof item !== 'object') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_ITEM',
      'MaterialContextItem must be a non-null object.'
    );
  }
  const raw = item as Record<string, unknown>;

  if (typeof raw.kind !== 'string') {
    throw new MaterialContextInvariantViolationError(
      'MISSING_ITEM_KIND',
      'MaterialContextItem.kind is required and must be a string.'
    );
  }

  switch (raw.kind) {
    case 'input_ref': {
      const allowed = new Set(['kind', 'inputId']);
      for (const k of Object.keys(raw)) {
        if (!allowed.has(k)) {
          throw new MaterialContextInvariantViolationError(
            'INPUT_REF_EXTRA_KEYS',
            `MaterialInputRef contained unauthorized key '${k}'.`
          );
        }
      }
      if (typeof raw.inputId !== 'string' || raw.inputId.trim().length === 0) {
        throw new MaterialContextInvariantViolationError(
          'INVALID_INPUT_ID',
          `MaterialInputRef.inputId must be a non-empty string, got '${String(raw.inputId)}'.`
        );
      }
      return Object.freeze<MaterialInputRef>({
        kind: 'input_ref',
        inputId: raw.inputId.trim() as any,
      });
    }

    case 'observation_ref': {
      const allowed = new Set(['kind', 'observationId']);
      for (const k of Object.keys(raw)) {
        if (!allowed.has(k)) {
          throw new MaterialContextInvariantViolationError(
            'OBSERVATION_REF_EXTRA_KEYS',
            `MaterialObservationRef contained unauthorized key '${k}'.`
          );
        }
      }
      if (typeof raw.observationId !== 'string' || raw.observationId.trim().length === 0) {
        throw new MaterialContextInvariantViolationError(
          'INVALID_OBSERVATION_ID',
          `MaterialObservationRef.observationId must be a non-empty string, got '${String(raw.observationId)}'.`
        );
      }
      return Object.freeze<MaterialObservationRef>({
        kind: 'observation_ref',
        observationId: raw.observationId.trim() as any,
      });
    }

    case 'canonical_projection_ref': {
      const allowed = new Set(['kind', 'projectionRevisionId']);
      for (const k of Object.keys(raw)) {
        if (!allowed.has(k)) {
          throw new MaterialContextInvariantViolationError(
            'PROJECTION_REF_EXTRA_KEYS',
            `MaterialCanonicalProjectionRef contained unauthorized key '${k}'.`
          );
        }
      }
      if (typeof raw.projectionRevisionId !== 'string' || raw.projectionRevisionId.trim().length === 0) {
        throw new MaterialContextInvariantViolationError(
          'INVALID_PROJECTION_REVISION_ID',
          `MaterialCanonicalProjectionRef.projectionRevisionId must be a non-empty string, got '${String(raw.projectionRevisionId)}'.`
        );
      }
      return Object.freeze<MaterialCanonicalProjectionRef>({
        kind: 'canonical_projection_ref',
        projectionRevisionId: raw.projectionRevisionId.trim() as any,
      });
    }

    case 'evidence_ref': {
      const allowed = new Set(['kind', 'evidenceArtifactId']);
      for (const k of Object.keys(raw)) {
        if (!allowed.has(k)) {
          throw new MaterialContextInvariantViolationError(
            'EVIDENCE_REF_EXTRA_KEYS',
            `MaterialEvidenceRef contained unauthorized key '${k}'.`
          );
        }
      }
      if (typeof raw.evidenceArtifactId !== 'string' || raw.evidenceArtifactId.trim().length === 0) {
        throw new MaterialContextInvariantViolationError(
          'INVALID_EVIDENCE_ARTIFACT_ID',
          `MaterialEvidenceRef.evidenceArtifactId must be a non-empty string, got '${String(raw.evidenceArtifactId)}'.`
        );
      }
      return Object.freeze<MaterialEvidenceRef>({
        kind: 'evidence_ref',
        evidenceArtifactId: raw.evidenceArtifactId.trim() as any,
      });
    }

    case 'precedent_ref': {
      const allowed = new Set(['kind', 'precedentId']);
      for (const k of Object.keys(raw)) {
        if (!allowed.has(k)) {
          throw new MaterialContextInvariantViolationError(
            'PRECEDENT_REF_EXTRA_KEYS',
            `MaterialPrecedentRef contained unauthorized key '${k}'.`
          );
        }
      }
      if (typeof raw.precedentId !== 'string' || raw.precedentId.trim().length === 0) {
        throw new MaterialContextInvariantViolationError(
          'INVALID_PRECEDENT_ID',
          `MaterialPrecedentRef.precedentId must be a non-empty string, got '${String(raw.precedentId)}'.`
        );
      }
      return Object.freeze<MaterialPrecedentRef>({
        kind: 'precedent_ref',
        precedentId: raw.precedentId.trim() as any,
      });
    }

    case 'resource_ref': {
      const allowed = new Set(['kind', 'resource']);
      for (const k of Object.keys(raw)) {
        if (!allowed.has(k)) {
          throw new MaterialContextInvariantViolationError(
            'RESOURCE_REF_ITEM_EXTRA_KEYS',
            `MaterialResourceRef contained unauthorized key '${k}'.`
          );
        }
      }
      const resource = sanitizeResourceRef(raw.resource);
      return Object.freeze<MaterialResourceRef>({
        kind: 'resource_ref',
        resource,
      });
    }

    case 'aspect_snapshot': {
      const allowed = new Set(['kind', 'aspect', 'value']);
      for (const k of Object.keys(raw)) {
        if (!allowed.has(k)) {
          throw new MaterialContextInvariantViolationError(
            'ASPECT_SNAPSHOT_EXTRA_KEYS',
            `MaterialAspectSnapshot contained unauthorized key '${k}'.`
          );
        }
      }

      if (!('value' in raw)) {
        throw new MaterialContextInvariantViolationError(
          'ASPECT_SNAPSHOT_MISSING_VALUE',
          'MaterialAspectSnapshot requires a value property (JSON null is valid).'
        );
      }

      const aspect = sanitizeContextAspectRef(raw.aspect);
      const value = sanitizeJsonMaterialValue(raw.value);

      return Object.freeze<MaterialAspectSnapshot>({
        kind: 'aspect_snapshot',
        aspect,
        value,
      });
    }

    default:
      throw new MaterialContextInvariantViolationError(
        'UNSUPPORTED_ITEM_KIND',
        `Unsupported MaterialContextItem kind '${String(raw.kind)}'. Prohibited kinds include 'content_ref', 'ingress_ref', 'event_ref', 'source_ref'.`
      );
  }
}

/**
 * Sanitiza Actor allowlist fechada.
 */
export function sanitizeActor(actor: unknown): Actor {
  if (!actor || typeof actor !== 'object') {
    throw new MaterialContextInvariantViolationError('INVALID_ACTOR', 'Actor must be a non-null object.');
  }
  const a = actor as Record<string, unknown>;

  if (a.kind === 'human') {
    const allowed = new Set(['kind', 'humanId', 'role', 'authorityRef']);
    for (const k of Object.keys(a)) {
      if (!allowed.has(k)) {
        throw new MaterialContextInvariantViolationError('ACTOR_EXTRA_KEYS', `HumanActor contained extra key '${k}'.`);
      }
    }
    if (typeof a.humanId !== 'string' || a.humanId.trim().length === 0) {
      throw new MaterialContextInvariantViolationError('INVALID_HUMAN_ID', 'HumanActor.humanId must be non-empty.');
    }
    return Object.freeze({
      kind: 'human',
      humanId: a.humanId.trim(),
      ...(typeof a.role === 'string' && a.role.trim().length > 0 ? { role: a.role.trim() } : {}),
      ...(typeof a.authorityRef === 'string' && a.authorityRef.trim().length > 0 ? { authorityRef: a.authorityRef.trim() } : {}),
    });
  }

  if (a.kind === 'max') {
    const allowed = new Set(['kind', 'maxVersion', 'sessionRef']);
    for (const k of Object.keys(a)) {
      if (!allowed.has(k)) {
        throw new MaterialContextInvariantViolationError('ACTOR_EXTRA_KEYS', `MaxActor contained extra key '${k}'.`);
      }
    }
    if (typeof a.maxVersion !== 'string' || a.maxVersion.trim().length === 0) {
      throw new MaterialContextInvariantViolationError('INVALID_MAX_VERSION', 'MaxActor.maxVersion must be non-empty.');
    }
    return Object.freeze({
      kind: 'max',
      maxVersion: a.maxVersion.trim(),
      ...(typeof a.sessionRef === 'string' && a.sessionRef.trim().length > 0 ? { sessionRef: a.sessionRef.trim() } : {}),
    });
  }

  if (a.kind === 'system') {
    const allowed = new Set(['kind', 'component', 'version']);
    for (const k of Object.keys(a)) {
      if (!allowed.has(k)) {
        throw new MaterialContextInvariantViolationError('ACTOR_EXTRA_KEYS', `SystemActor contained extra key '${k}'.`);
      }
    }
    if (typeof a.component !== 'string' || a.component.trim().length === 0) {
      throw new MaterialContextInvariantViolationError('INVALID_SYSTEM_COMPONENT', 'SystemActor.component must be non-empty.');
    }
    return Object.freeze({
      kind: 'system',
      component: a.component.trim(),
      ...(typeof a.version === 'string' && a.version.trim().length > 0 ? { version: a.version.trim() } : {}),
    });
  }

  if (a.kind === 'integration') {
    const allowed = new Set(['kind', 'provider', 'integrationId']);
    for (const k of Object.keys(a)) {
      if (!allowed.has(k)) {
        throw new MaterialContextInvariantViolationError('ACTOR_EXTRA_KEYS', `IntegrationActor contained extra key '${k}'.`);
      }
    }
    if (typeof a.provider !== 'string' || a.provider.trim().length === 0) {
      throw new MaterialContextInvariantViolationError('INVALID_INTEGRATION_PROVIDER', 'IntegrationActor.provider must be non-empty.');
    }
    return Object.freeze({
      kind: 'integration',
      provider: a.provider.trim(),
      ...(typeof a.integrationId === 'string' && a.integrationId.trim().length > 0 ? { integrationId: a.integrationId.trim() } : {}),
    });
  }

  throw new MaterialContextInvariantViolationError(
    'INVALID_ACTOR_KIND',
    `Unsupported actor kind '${String(a.kind)}'.`
  );
}

/**
 * Sanitiza ContextSubjectRef.
 */
export function sanitizeContextSubjectRef(subject: unknown): ContextSubjectRef | undefined {
  if (subject === undefined || subject === null) {
    return undefined;
  }
  if (typeof subject !== 'object') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_SUBJECT_REF',
      'ContextSubjectRef must be an object when provided.'
    );
  }
  const s = subject as Record<string, unknown>;
  const allowed = new Set(['subjectType', 'subjectId']);
  for (const k of Object.keys(s)) {
    if (!allowed.has(k)) {
      throw new MaterialContextInvariantViolationError(
        'SUBJECT_REF_EXTRA_KEYS',
        `ContextSubjectRef contained unauthorized extra key '${k}'.`
      );
    }
  }

  if (typeof s.subjectType !== 'string' || s.subjectType.trim().length === 0) {
    throw new MaterialContextInvariantViolationError(
      'INVALID_SUBJECT_TYPE',
      'ContextSubjectRef.subjectType must be a non-empty string.'
    );
  }
  if (typeof s.subjectId !== 'string' || s.subjectId.trim().length === 0) {
    throw new MaterialContextInvariantViolationError(
      'INVALID_SUBJECT_ID',
      'ContextSubjectRef.subjectId must be a non-empty string.'
    );
  }

  return Object.freeze({
    subjectType: s.subjectType.trim() as any,
    subjectId: s.subjectId.trim() as any,
  });
}

/**
 * Sanitiza FlowRef.
 */
export function sanitizeFlowRef(flow: unknown): FlowRef | undefined {
  if (flow === undefined || flow === null) {
    return undefined;
  }
  if (typeof flow !== 'object') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_FLOW_REF',
      'FlowRef must be an object when provided.'
    );
  }
  const f = flow as Record<string, unknown>;
  const allowed = new Set(['flowType', 'flowId']);
  for (const k of Object.keys(f)) {
    if (!allowed.has(k)) {
      throw new MaterialContextInvariantViolationError(
        'FLOW_REF_EXTRA_KEYS',
        `FlowRef contained unauthorized extra key '${k}'.`
      );
    }
  }

  if (typeof f.flowType !== 'string' || f.flowType.trim().length === 0) {
    throw new MaterialContextInvariantViolationError(
      'INVALID_FLOW_TYPE',
      'FlowRef.flowType must be a non-empty string.'
    );
  }
  if (typeof f.flowId !== 'string' || f.flowId.trim().length === 0) {
    throw new MaterialContextInvariantViolationError(
      'INVALID_FLOW_ID',
      'FlowRef.flowId must be a non-empty string.'
    );
  }

  return Object.freeze({
    flowType: f.flowType.trim() as any,
    flowId: f.flowId.trim() as any,
  });
}

/**
 * Valida o draft de criação do MaterialContextPin.
 */
export function validatePinMaterialContextDraft(draft: unknown): asserts draft is PinMaterialContextDraft {
  if (!draft || typeof draft !== 'object') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_DRAFT',
      'PinMaterialContextDraft must be a non-null object.'
    );
  }
  const d = draft as Record<string, unknown>;

  const allowedKeys = new Set(['pinId', 'items']);
  for (const k of Object.keys(d)) {
    if (!allowedKeys.has(k)) {
      throw new MaterialContextInvariantViolationError(
        'DRAFT_UNAUTHORIZED_KEY',
        `PinMaterialContextDraft contains unauthorized key '${k}'. Caller cannot declare actor, sessionRef, pinnedAt, etc.`
      );
    }
  }

  if (d.pinId !== undefined) {
    validateMaterialContextPinId(d.pinId);
  }

  if (!Array.isArray(d.items) || d.items.length === 0) {
    throw new MaterialContextInvariantViolationError(
      'EMPTY_ITEMS',
      'PinMaterialContextDraft.items must be a non-empty array of MaterialContextItem.'
    );
  }
}

/**
 * Valida a entidade canônica completa MaterialContextPin.
 */
export function validateMaterialContextPin(pin: unknown): asserts pin is MaterialContextPin {
  if (!pin || typeof pin !== 'object') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_PIN',
      'MaterialContextPin must be a non-null object.'
    );
  }
  const p = pin as Record<string, unknown>;

  const allowedKeys = new Set([
    'pinId',
    'actor',
    'userId',
    'sessionRef',
    'contextSubjectRef',
    'flowRef',
    'correlationId',
    'channel',
    'pinnedAt',
    'items',
  ]);

  for (const k of Object.keys(p)) {
    if (!allowedKeys.has(k)) {
      throw new MaterialContextInvariantViolationError(
        'PIN_EXTRA_KEY',
        `MaterialContextPin contained unauthorized key '${k}'.`
      );
    }
  }

  validateMaterialContextPinId(p.pinId);
  sanitizeActor(p.actor);

  if (p.sessionRef !== undefined) {
    if (typeof p.sessionRef !== 'string' || (p.sessionRef as string).trim().length === 0) {
      throw new MaterialContextInvariantViolationError(
        'INVALID_SESSION_REF',
        'MaterialContextPin.sessionRef must be a non-empty string when provided.'
      );
    }
    if (typeof p.userId !== 'string' || (p.userId as string).trim().length === 0) {
      throw new MaterialContextInvariantViolationError(
        'SESSION_WITHOUT_USER',
        'MaterialContextPin with sessionRef requires userId.'
      );
    }
  }

  if (p.contextSubjectRef !== undefined && p.contextSubjectRef !== null) {
    sanitizeContextSubjectRef(p.contextSubjectRef);
  }

  if (p.flowRef !== undefined && p.flowRef !== null) {
    sanitizeFlowRef(p.flowRef);
  }

  if (!isCanonicalUtcInstant(p.pinnedAt)) {
    throw new MaterialContextInvariantViolationError(
      'INVALID_PINNED_AT',
      `MaterialContextPin.pinnedAt must be a valid ISO 8601 UTC instant ending in 'Z', got '${String(p.pinnedAt)}'.`
    );
  }

  if (!Array.isArray(p.items) || p.items.length === 0) {
    throw new MaterialContextInvariantViolationError(
      'EMPTY_PIN_ITEMS',
      'MaterialContextPin.items must be a non-empty array of MaterialContextItem.'
    );
  }

  for (const item of p.items) {
    sanitizeMaterialContextItem(item);
  }
}
