/**
 * NEX+ · Material Context Pin & Snapshot Boundary
 * Contratos Canônicos TypeScript — Escopo 0.86 (Bloco 0.86B · Checkpoint 0.86B-4)
 *
 * Princípios Fundamentais:
 * 1. MaterialContextPin representa o snapshot DURÁVEL, IMUTÁVEL, AUDITÁVEL e SELETIVO
 *    do contexto material utilizado por uma operação ou Decision futura.
 * 2. MaterialContextPin NÃO é OperationalContext, InputRecord, ObservationRecord,
 *    EvidenceArtifact, CanonicalProjection, Interpretation, Intent, Decision ou MAX memory.
 * 3. Não prova verdade. Não concede autoridade. Registra: "este foi o contexto material congelado".
 * 4. Ref pública mínima (MaterialContextPinRef) apenas identifica; nunca autoriza.
 * 5. União discriminada estrita com 7 variantes de itens, sem variantes transitórias de Ingress.
 * 6. Authorization fail-closed obrigatória (MaterialContextAccessAuthorizer).
 */

import type { Actor, ObservationRecordId, CanonicalProjectionRevisionId, EvidenceArtifactRefId, ContextualPrecedentRefId } from '../observations/contracts';
import type { SessionRef } from '../../auth/session-ref.types';
import type {
  ContextSubjectRef,
  FlowRef,
  ContextAspectRef,
  OperationalChannel,
  OperationalContext,
} from '../context/contracts';
import type {
  ResourceRef,
  CorrelationId,
  JsonValue,
} from '../modules/contracts';
import type { InputRecordId } from '../input/contracts';

// ============================================================================
// 1. IDENTIFICADORES BRANDED & REFS PÚBLICAS
// ============================================================================

export type MaterialContextPinId = string & { readonly __brand?: 'MaterialContextPinId' };

export interface MaterialContextPinRef {
  readonly pinId: MaterialContextPinId;
}

// ============================================================================
// 2. MATERIAL CONTEXT ITEMS (União Discriminada Estrita)
// ============================================================================

export interface MaterialInputRef {
  readonly kind: 'input_ref';
  readonly inputId: InputRecordId;
}

export interface MaterialObservationRef {
  readonly kind: 'observation_ref';
  readonly observationId: ObservationRecordId;
}

export interface MaterialCanonicalProjectionRef {
  readonly kind: 'canonical_projection_ref';
  readonly projectionRevisionId: CanonicalProjectionRevisionId;
}

export interface MaterialEvidenceRef {
  readonly kind: 'evidence_ref';
  readonly evidenceArtifactId: EvidenceArtifactRefId;
}

export interface MaterialPrecedentRef {
  readonly kind: 'precedent_ref';
  readonly precedentId: ContextualPrecedentRefId;
}

export interface MaterialResourceRef {
  readonly kind: 'resource_ref';
  readonly resource: ResourceRef;
}

export interface MaterialAspectSnapshot {
  readonly kind: 'aspect_snapshot';
  readonly aspect: ContextAspectRef;
  readonly value: JsonValue;
}

export type MaterialContextItem =
  | MaterialInputRef
  | MaterialObservationRef
  | MaterialCanonicalProjectionRef
  | MaterialEvidenceRef
  | MaterialPrecedentRef
  | MaterialResourceRef
  | MaterialAspectSnapshot;

export type MaterialContextItemKind = MaterialContextItem['kind'];

// ============================================================================
// 3. MATERIAL CONTEXT PIN (Entidade Canônica Imutável)
// ============================================================================

export interface MaterialContextPin {
  readonly pinId: MaterialContextPinId;

  readonly actor: Actor;
  readonly userId?: string;
  readonly sessionRef?: SessionRef;
  readonly contextSubjectRef?: ContextSubjectRef;

  readonly flowRef?: FlowRef;
  readonly correlationId?: CorrelationId;
  readonly channel?: OperationalChannel;

  readonly pinnedAt: string; // ISO 8601 UTC ('Z')

  readonly items: readonly MaterialContextItem[];
}

// ============================================================================
// 4. DRAFT DE CRIAÇÃO
// ============================================================================

export interface PinMaterialContextDraft {
  readonly pinId?: MaterialContextPinId;
  readonly items: readonly MaterialContextItem[];
}

// ============================================================================
// 5. BOUNDARY DE AUTORIZAÇÃO (Fail-Closed)
// ============================================================================

export type MaterialContextAccessOperation = 'create' | 'read';

export interface MaterialContextAccessAuthorizationParams {
  readonly operation: MaterialContextAccessOperation;
  readonly context: OperationalContext;
  readonly pin?: MaterialContextPin;
  readonly pinId?: MaterialContextPinId;
}

export interface MaterialContextAccessAuthorizer {
  authorize(params: MaterialContextAccessAuthorizationParams): Promise<boolean> | boolean;
}
