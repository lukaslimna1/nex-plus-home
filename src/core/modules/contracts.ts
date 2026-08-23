/**
 * NEX+ · Módulos, Referências & Eventos
 * Contratos Canônicos TypeScript — Escopo 0.86 (Bloco 0.86A · Boundary Transversal Mínimo)
 *
 * Princípios Fundamentais:
 * 1. Identidade estável de módulos (ModuleRef) desacoplada de revisões temporais (ModuleManifestRevision).
 * 2. Referência a recursos entre módulos (ResourceRef) preservando ownership original do módulo produtor/dono.
 * 3. Envelope transversal de eventos (NexEventEnvelope) com separação estrita entre domain e system events.
 * 4. Rastreabilidade causal e contextual (correlationId e causationId).
 * 5. Evento é sinal e NUNCA autorização para mutação (INV-EVENT-NO-AUTHORITY).
 */

// ============================================================================
// 1. IDENTIFICADORES BRANDED (Semantic Aliases)
// ============================================================================

export type ModuleKey = string & { readonly __brand?: 'ModuleKey' };
export type ModuleRevisionId = string & { readonly __brand?: 'ModuleRevisionId' };

export type ResourceType = string & { readonly __brand?: 'ResourceType' };
export type ResourceId = string & { readonly __brand?: 'ResourceId' };

export type EventId = string & { readonly __brand?: 'EventId' };
export type EventType = string & { readonly __brand?: 'EventType' };
export type CorrelationId = string & { readonly __brand?: 'CorrelationId' };
export type SubscriberId = string & { readonly __brand?: 'SubscriberId' };

// ============================================================================
// 2. LIFECYCLE DE MÓDULOS
// ============================================================================

export type ModuleLifecycle = 'active' | 'deprecated' | 'retired';

// ============================================================================
// 3. IDENTIDADE ESTÁVEL (ModuleRef) & MANIFESTO REVISIONADO
// ============================================================================

/**
 * Identidade estável do módulo.
 * Não aponta para uma revisão específica, permitindo que o módulo evolua
 * sem invalidar referências cruzadas existentes.
 */
export interface ModuleRef {
  readonly moduleKey: ModuleKey;
}

/**
 * Revisão factual e imutável do manifesto de um módulo.
 */
export interface ModuleManifestRevision {
  readonly moduleKey: ModuleKey;
  readonly moduleRevisionId: ModuleRevisionId;
  readonly lifecycle: ModuleLifecycle;
  readonly supersedesRevisionIds: readonly ModuleRevisionId[];
  readonly title: string;
  readonly description: string;
  readonly ownedResourceTypes: readonly ResourceType[];
  readonly emittedEventTypes: readonly EventType[];
}

// ============================================================================
// 4. RESOURCE REF & OWNERSHIP TRANSVERSAL
// ============================================================================

/**
 * Referência a um recurso gerenciado por um módulo.
 * Permite que módulos externos referenciem o recurso sem assumir ou transferir ownership.
 */
export interface ResourceRef {
  readonly ownerModule: ModuleRef;
  readonly resourceType: ResourceType;
  readonly resourceId: ResourceId;
}

// ============================================================================
// 5. JSON-SAFE TYPES (Payloads Estritamente Serializáveis)
// ============================================================================

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

// ============================================================================
// 6. EVENT ENVELOPE, ORIGIN & CLASSES
// ============================================================================

export type EventClass = 'domain' | 'system';

export interface ModuleEventOrigin {
  readonly kind: 'module';
  readonly module: ModuleRef;
  readonly moduleRevisionId: ModuleRevisionId;
}

export interface SystemEventOrigin {
  readonly kind: 'system';
  readonly component: string;
}

export type EventOrigin = ModuleEventOrigin | SystemEventOrigin;

/**
 * Envelope transversal de eventos do NEX+.
 * Semântica orientada ao CloudEvents (id, source, type, time, subject, data),
 * mantendo 'recordedAt' separado de 'occurredAt' conforme a temporalidade do Core (0.85).
 */
export interface NexEventEnvelope {
  readonly eventId: EventId;
  readonly eventClass: EventClass;
  readonly type: EventType;
  readonly origin: EventOrigin;
  readonly occurredAt: string; // ISO 8601 UTC
  readonly recordedAt: string; // ISO 8601 UTC
  readonly subject?: ResourceRef;
  readonly correlationId?: CorrelationId;
  readonly causationId?: EventId;
  readonly payload: JsonObject;
}

// ============================================================================
// 7. SUBSCRIPTION & DELIVERY CONTRACTS
// ============================================================================

export type EventHandler = (event: NexEventEnvelope) => Promise<void> | void;

export interface EventSubscription {
  readonly subscriberId: SubscriberId;
  readonly eventTypes?: readonly EventType[];
  readonly handler: EventHandler;
}

export interface EventDeliveryResult {
  readonly subscriberId: SubscriberId;
  readonly status: 'delivered' | 'failed';
  readonly error?: string;
}

export interface PublishEventResult {
  readonly event: NexEventEnvelope;
  readonly deliveries: readonly EventDeliveryResult[];
}

export interface EventListFilter {
  readonly eventClass?: EventClass;
  readonly eventType?: EventType;
  readonly moduleKey?: ModuleKey;
  readonly correlationId?: CorrelationId;
  readonly causationId?: EventId;
}
