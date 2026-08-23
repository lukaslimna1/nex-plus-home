/**
 * NEX+ · Módulos, Referências & Eventos
 * Implementação do InMemoryModuleEventHub — Escopo 0.86 (Bloco 0.86A)
 *
 * Princípios Fundamentais:
 * 1. Validação estrita de JSON-Safe Payloads com sanitização de chaves proibidas.
 * 2. Validação rigorosa de EventOrigin (domain exige ModuleRegistry + emittedEventTypes; system exige component).
 * 3. Identificadores opacos, correlação/causação auditáveis (Anti-Self-Causation).
 * 4. Imutabilidade absoluta pós-publicação (deep-clone + deep-freeze).
 * 5. Isolamento estrito de falhas em subscribers (subscriber failure não corrompe journal nem afeta outros subscribers).
 * 6. Invariante Soberana: EVENTO É SINAL, NÃO AUTORIDADE.
 */

import type {
  CorrelationId,
  EventId,
  EventListFilter,
  EventOrigin,
  EventSubscription,
  EventType,
  JsonObject,
  JsonValue,
  NexEventEnvelope,
  PublishEventResult,
  ResourceRef,
  SubscriberId,
} from './contracts';
import type { ModuleRegistry } from './registry';
import { isValidIdentifier } from './registry';

// ============================================================================
// 1. ERROS ESTRUTURAIS & DE EVENTOS
// ============================================================================

export class DuplicateEventIdError extends Error {
  readonly code = 'DUPLICATE_EVENT_ID';
  readonly eventId: string;

  constructor(eventId: string) {
    super(`[L0 EventHub] Duplicate EventId '${eventId}' cannot be published twice.`);
    this.name = 'DuplicateEventIdError';
    this.eventId = eventId;
  }
}

export class InvalidEventEnvelopeError extends Error {
  readonly code = 'INVALID_EVENT_ENVELOPE';
  readonly fieldName: string;
  readonly reason: string;

  constructor(fieldName: string, reason: string) {
    super(`[L0 EventHub] Invalid event envelope field '${fieldName}': ${reason}.`);
    this.name = 'InvalidEventEnvelopeError';
    this.fieldName = fieldName;
    this.reason = reason;
  }
}

export class InvalidJsonPayloadError extends Error {
  readonly code = 'INVALID_JSON_PAYLOAD';
  readonly reason: string;
  readonly path?: string;

  constructor(reason: string, path?: string) {
    super(
      `[L0 EventHub] Invalid JSON payload${path ? ` at '${path}'` : ''}: ${reason}.`,
    );
    this.name = 'InvalidJsonPayloadError';
    this.reason = reason;
    this.path = path;
  }
}

export class SelfCausationError extends Error {
  readonly code = 'SELF_CAUSATION_PROHIBITED';
  readonly eventId: string;

  constructor(eventId: string) {
    super(
      `[L0 EventHub] Self-causation is prohibited: causationId cannot be equal to eventId '${eventId}'.`,
    );
    this.name = 'SelfCausationError';
    this.eventId = eventId;
  }
}

export class UnregisteredModuleRevisionError extends Error {
  readonly code = 'UNREGISTERED_MODULE_REVISION';
  readonly moduleRevisionId: string;

  constructor(moduleRevisionId: string) {
    super(
      `[L0 EventHub] ModuleRevisionId '${moduleRevisionId}' is not registered in ModuleRegistry.`,
    );
    this.name = 'UnregisteredModuleRevisionError';
    this.moduleRevisionId = moduleRevisionId;
  }
}

export class ModuleKeyMismatchError extends Error {
  readonly code = 'MODULE_KEY_MISMATCH';
  readonly originModuleKey: string;
  readonly registeredModuleKey: string;

  constructor(originModuleKey: string, registeredModuleKey: string) {
    super(
      `[L0 EventHub] Origin ModuleKey '${originModuleKey}' does not match registered ModuleKey '${registeredModuleKey}'.`,
    );
    this.name = 'ModuleKeyMismatchError';
    this.originModuleKey = originModuleKey;
    this.registeredModuleKey = registeredModuleKey;
  }
}

export class UndeclaredEventTypeError extends Error {
  readonly code = 'UNDECLARED_EVENT_TYPE';
  readonly eventType: string;
  readonly moduleRevisionId: string;

  constructor(eventType: string, moduleRevisionId: string) {
    super(
      `[L0 EventHub] EventType '${eventType}' is not declared in emittedEventTypes of ModuleRevision '${moduleRevisionId}'.`,
    );
    this.name = 'UndeclaredEventTypeError';
    this.eventType = eventType;
    this.moduleRevisionId = moduleRevisionId;
  }
}

export class DuplicateSubscriberIdError extends Error {
  readonly code = 'DUPLICATE_SUBSCRIBER_ID';
  readonly subscriberId: string;

  constructor(subscriberId: string) {
    super(`[L0 EventHub] Duplicate SubscriberId '${subscriberId}'.`);
    this.name = 'DuplicateSubscriberIdError';
    this.subscriberId = subscriberId;
  }
}

// ============================================================================
// 2. VALIDADOR E CLONADOR JSON-SAFE
// ============================================================================

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Valida recursivamente que um valor é estritamente JSON-safe:
 * - Rejeita undefined, function, symbol, bigint, NaN, Infinity, circular references, non-plain objects
 * - Rejeita chaves perigosas (__proto__, prototype, constructor)
 * - Retorna uma cópia profunda e congelada (deep-freeze).
 */
export function validateAndDeepCloneJson<T extends JsonValue>(value: unknown, path = '$'): T {
  const seenObjects = new WeakSet<object>();

  function validateRecursive(current: unknown, currentPath: string): any {
    if (current === null) {
      return null;
    }

    const type = typeof current;

    if (type === 'string' || type === 'boolean') {
      return current;
    }

    if (type === 'number') {
      if (Number.isNaN(current) || !Number.isFinite(current)) {
        throw new InvalidJsonPayloadError(`Number value '${String(current)}' is not valid JSON`, currentPath);
      }
      return current;
    }

    if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
      throw new InvalidJsonPayloadError(`Type '${type}' is not valid JSON`, currentPath);
    }

    if (type === 'object') {
      if (seenObjects.has(current as object)) {
        throw new InvalidJsonPayloadError('Circular reference detected', currentPath);
      }
      seenObjects.add(current as object);

      if (Array.isArray(current)) {
        const clonedArr: any[] = [];
        for (let i = 0; i < current.length; i++) {
          clonedArr.push(validateRecursive(current[i], `${currentPath}[${i}]`));
        }
        return Object.freeze(clonedArr);
      }

      // Validar objeto plain
      const proto = Object.getPrototypeOf(current);
      if (proto !== null && proto !== Object.prototype) {
        throw new InvalidJsonPayloadError('Non-plain object instance is not valid JSON', currentPath);
      }

      const clonedObj: Record<string, any> = {};
      const keys = Object.keys(current as object);

      for (const key of keys) {
        if (FORBIDDEN_KEYS.has(key)) {
          throw new InvalidJsonPayloadError(`Forbidden key '${key}' is not allowed in JSON payload`, `${currentPath}.${key}`);
        }
        clonedObj[key] = validateRecursive((current as any)[key], `${currentPath}.${key}`);
      }

      return Object.freeze(clonedObj);
    }

    throw new InvalidJsonPayloadError(`Unsupported value of type '${type}'`, currentPath);
  }

  return validateRecursive(value, path);
}

function deepCloneAndFreezeResourceRef(ref: ResourceRef): ResourceRef {
  if (!ref || typeof ref !== 'object') {
    throw new InvalidEventEnvelopeError('subject', 'must be an object');
  }
  if (!ref.ownerModule || !isValidIdentifier(ref.ownerModule.moduleKey)) {
    throw new InvalidEventEnvelopeError('subject.ownerModule.moduleKey', 'must be a valid identifier');
  }
  if (!isValidIdentifier(ref.resourceType)) {
    throw new InvalidEventEnvelopeError('subject.resourceType', 'must be a valid identifier');
  }
  if (!isValidIdentifier(ref.resourceId)) {
    throw new InvalidEventEnvelopeError('subject.resourceId', 'must be a valid identifier');
  }

  return Object.freeze({
    ownerModule: Object.freeze({ moduleKey: ref.ownerModule.moduleKey }),
    resourceType: ref.resourceType,
    resourceId: ref.resourceId,
  });
}

function deepCloneAndFreezeOrigin(origin: EventOrigin): EventOrigin {
  if (!origin || typeof origin !== 'object') {
    throw new InvalidEventEnvelopeError('origin', 'must be an object');
  }

  if (origin.kind === 'module') {
    if (!origin.module || !isValidIdentifier(origin.module.moduleKey)) {
      throw new InvalidEventEnvelopeError('origin.module.moduleKey', 'must be a valid identifier');
    }
    if (!isValidIdentifier(origin.moduleRevisionId)) {
      throw new InvalidEventEnvelopeError('origin.moduleRevisionId', 'must be a valid identifier');
    }

    return Object.freeze({
      kind: 'module',
      module: Object.freeze({ moduleKey: origin.module.moduleKey }),
      moduleRevisionId: origin.moduleRevisionId,
    });
  }

  if (origin.kind === 'system') {
    if (!isValidIdentifier(origin.component)) {
      throw new InvalidEventEnvelopeError('origin.component', 'must be a non-empty trimmed string');
    }

    return Object.freeze({
      kind: 'system',
      component: origin.component,
    });
  }

  throw new InvalidEventEnvelopeError('origin.kind', `must be 'module' or 'system', got '${(origin as any).kind}'`);
}

function isValidIsoDate(str: unknown): str is string {
  if (typeof str !== 'string' || str.length === 0) return false;
  const d = new Date(str);
  return !Number.isNaN(d.getTime());
}

// ============================================================================
// 3. IN-MEMORY EVENT HUB
// ============================================================================

export interface ModuleEventHub {
  publish(event: NexEventEnvelope): Promise<PublishEventResult>;
  subscribe(subscription: EventSubscription): () => void;
  unsubscribe(subscriberId: SubscriberId): boolean;
  getEvent(eventId: EventId): NexEventEnvelope | undefined;
  listEvents(filter?: EventListFilter): readonly NexEventEnvelope[];
  getJournalSize(): number;
  clearForTests(): void;
}

export interface CreateEventHubOptions {
  readonly moduleRegistry?: ModuleRegistry;
}

export function createModuleEventHub(options: CreateEventHubOptions = {}): ModuleEventHub {
  const { moduleRegistry } = options;
  const journalById = new Map<EventId, NexEventEnvelope>();
  const journalList: NexEventEnvelope[] = [];
  const subscriptions: EventSubscription[] = [];

  function validateEventEnvelope(event: NexEventEnvelope): NexEventEnvelope {
    if (!event || typeof event !== 'object') {
      throw new InvalidEventEnvelopeError('event', 'must be an object');
    }

    if (!isValidIdentifier(event.eventId)) {
      throw new InvalidEventEnvelopeError('eventId', 'must be a valid identifier');
    }

    if (!['domain', 'system'].includes(event.eventClass)) {
      throw new InvalidEventEnvelopeError('eventClass', `must be 'domain' or 'system', got '${event.eventClass}'`);
    }

    if (!isValidIdentifier(event.type)) {
      throw new InvalidEventEnvelopeError('type', 'must be a valid identifier');
    }

    if (!isValidIsoDate(event.occurredAt)) {
      throw new InvalidEventEnvelopeError('occurredAt', 'must be a valid ISO 8601 date string');
    }

    if (!isValidIsoDate(event.recordedAt)) {
      throw new InvalidEventEnvelopeError('recordedAt', 'must be a valid ISO 8601 date string');
    }

    if (event.correlationId !== undefined && !isValidIdentifier(event.correlationId)) {
      throw new InvalidEventEnvelopeError('correlationId', 'must be a valid identifier when provided');
    }

    if (event.causationId !== undefined) {
      if (!isValidIdentifier(event.causationId)) {
        throw new InvalidEventEnvelopeError('causationId', 'must be a valid identifier when provided');
      }
      if (event.causationId === event.eventId) {
        throw new SelfCausationError(event.eventId);
      }
    }

    const frozenOrigin = deepCloneAndFreezeOrigin(event.origin);
    const frozenSubject = event.subject ? deepCloneAndFreezeResourceRef(event.subject) : undefined;

    // Validações semânticas por classe de evento
    if (event.eventClass === 'domain') {
      if (frozenOrigin.kind !== 'module') {
        throw new InvalidEventEnvelopeError('origin.kind', "domain events must have origin.kind === 'module'");
      }

      if (moduleRegistry) {
        const manifest = moduleRegistry.getModuleRevision(frozenOrigin.moduleRevisionId);
        if (!manifest) {
          throw new UnregisteredModuleRevisionError(frozenOrigin.moduleRevisionId);
        }

        if (manifest.moduleKey !== frozenOrigin.module.moduleKey) {
          throw new ModuleKeyMismatchError(frozenOrigin.module.moduleKey, manifest.moduleKey);
        }

        if (!manifest.emittedEventTypes.includes(event.type)) {
          throw new UndeclaredEventTypeError(event.type, frozenOrigin.moduleRevisionId);
        }
      }
    } else if (event.eventClass === 'system') {
      if (frozenOrigin.kind !== 'system') {
        throw new InvalidEventEnvelopeError('origin.kind', "system events must have origin.kind === 'system'");
      }
    }

    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      throw new InvalidJsonPayloadError('Payload must be a plain object', 'payload');
    }

    const frozenPayload = validateAndDeepCloneJson<JsonObject>(event.payload, 'payload');

    return Object.freeze({
      eventId: event.eventId,
      eventClass: event.eventClass,
      type: event.type,
      origin: frozenOrigin,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      subject: frozenSubject,
      correlationId: event.correlationId,
      causationId: event.causationId,
      payload: frozenPayload,
    });
  }

  async function publish(rawEvent: NexEventEnvelope): Promise<PublishEventResult> {
    const validatedEvent = validateEventEnvelope(rawEvent);

    // 1. Unicidade de EventId
    if (journalById.has(validatedEvent.eventId)) {
      throw new DuplicateEventIdError(validatedEvent.eventId);
    }

    // 2. Append no Journal
    journalById.set(validatedEvent.eventId, validatedEvent);
    journalList.push(validatedEvent);

    // 3. Notificação determinística dos subscribers
    const deliveries: Array<{ subscriberId: SubscriberId; status: 'delivered' | 'failed'; error?: string }> = [];

    // Snapshot das subscriptions ativas na ordem de registro
    const currentSubs = [...subscriptions];

    for (const sub of currentSubs) {
      if (sub.eventTypes && sub.eventTypes.length > 0 && !sub.eventTypes.includes(validatedEvent.type)) {
        continue;
      }

      try {
        await Promise.resolve(sub.handler(validatedEvent));
        deliveries.push({
          subscriberId: sub.subscriberId,
          status: 'delivered',
        });
      } catch (err: any) {
        deliveries.push({
          subscriberId: sub.subscriberId,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return Object.freeze({
      event: validatedEvent,
      deliveries: Object.freeze(deliveries),
    });
  }

  function subscribe(subscription: EventSubscription): () => void {
    if (!subscription || typeof subscription !== 'object') {
      throw new Error('[L0 EventHub] Subscription must be an object.');
    }
    if (!isValidIdentifier(subscription.subscriberId)) {
      throw new InvalidEventEnvelopeError('subscriberId', 'must be a valid identifier');
    }
    if (typeof subscription.handler !== 'function') {
      throw new Error('[L0 EventHub] Subscription handler must be a function.');
    }

    if (subscription.eventTypes) {
      if (!Array.isArray(subscription.eventTypes)) {
        throw new Error('[L0 EventHub] eventTypes must be an array when provided.');
      }
      for (const t of subscription.eventTypes) {
        if (!isValidIdentifier(t)) {
          throw new InvalidEventEnvelopeError('eventTypes', `contains invalid eventType '${String(t)}'`);
        }
      }
    }

    const existingIndex = subscriptions.findIndex((s) => s.subscriberId === subscription.subscriberId);
    if (existingIndex >= 0) {
      throw new DuplicateSubscriberIdError(subscription.subscriberId);
    }

    const subCopy: EventSubscription = Object.freeze({
      subscriberId: subscription.subscriberId,
      eventTypes: subscription.eventTypes ? Object.freeze([...subscription.eventTypes]) : undefined,
      handler: subscription.handler,
    });

    subscriptions.push(subCopy);

    return () => {
      unsubscribe(subscription.subscriberId);
    };
  }

  function unsubscribe(subscriberId: SubscriberId): boolean {
    const index = subscriptions.findIndex((s) => s.subscriberId === subscriberId);
    if (index >= 0) {
      subscriptions.splice(index, 1);
      return true;
    }
    return false;
  }

  function getEvent(eventId: EventId): NexEventEnvelope | undefined {
    return journalById.get(eventId);
  }

  function listEvents(filter?: EventListFilter): readonly NexEventEnvelope[] {
    if (!filter) {
      return Object.freeze([...journalList]);
    }

    return Object.freeze(
      journalList.filter((e) => {
        if (filter.eventClass && e.eventClass !== filter.eventClass) return false;
        if (filter.eventType && e.type !== filter.eventType) return false;
        if (filter.correlationId && e.correlationId !== filter.correlationId) return false;
        if (filter.causationId && e.causationId !== filter.causationId) return false;
        if (filter.moduleKey) {
          if (e.origin.kind !== 'module' || e.origin.module.moduleKey !== filter.moduleKey) {
            return false;
          }
        }
        return true;
      }),
    );
  }

  function getJournalSize(): number {
    return journalList.length;
  }

  function clearForTests(): void {
    journalById.clear();
    journalList.length = 0;
    subscriptions.length = 0;
  }

  return {
    publish,
    subscribe,
    unsubscribe,
    getEvent,
    listEvents,
    getJournalSize,
    clearForTests,
  };
}
