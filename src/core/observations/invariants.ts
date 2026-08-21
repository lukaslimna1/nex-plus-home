/**
 * NEX+ · Invariantes & Validadores Puros de Observação e Revisão
 * Escopo 0.85 (Bloco 0.85A)
 *
 * Funções determinísticas puras (sem I/O, sem dependência de banco/rede).
 */

import type {
  ObservationRecord,
  ReviewEvent,
  CanonicalProjection,
  ReconciliationCase,
  ContextualPrecedent,
  CanonicalProjectionRevisionId,
  Actor,
} from './contracts';

// ============================================================================
// 1. HELPERS DE VALIDAÇÃO TEMPORAL
// ============================================================================

export function isValidIso8601(dateString: unknown): boolean {
  if (typeof dateString !== 'string' || dateString.trim() === '') return false;
  const d = new Date(dateString);
  return !isNaN(d.getTime()) && dateString.includes('T');
}

export function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}

// ============================================================================
// 2. VALIDAÇÃO DE OBSERVATION RECORD
// ============================================================================

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function validateObservationRecord(record: unknown): ValidationResult {
  const errors: string[] = [];

  if (!record || typeof record !== 'object') {
    return { valid: false, errors: ['ObservationRecord must be an object'] };
  }

  const rec = record as Partial<ObservationRecord>;

  if (!isNonEmptyString(rec.observationId)) {
    errors.push('observationId is required and must be a non-empty string');
  }

  if (!rec.subject || typeof rec.subject !== 'object') {
    errors.push('subject is required and must be an object');
  } else {
    if (!isNonEmptyString(rec.subject.domain)) errors.push('subject.domain is required');
    if (!isNonEmptyString(rec.subject.entityType)) errors.push('subject.entityType is required');
    if (!isNonEmptyString(rec.subject.entityId)) errors.push('subject.entityId is required');
  }

  if (!isNonEmptyString(rec.observedClaim)) {
    errors.push('observedClaim is required');
  }

  if (rec.rawValue === undefined) {
    errors.push('rawValue is required (may be null, but cannot be undefined)');
  }

  if (!rec.actor || typeof rec.actor !== 'object' || !isNonEmptyString((rec.actor as Actor).kind)) {
    errors.push('actor with a valid kind is required');
  } else {
    const actor = rec.actor as Actor;
    if (actor.kind === 'human' && !isNonEmptyString(actor.humanId)) {
      errors.push('human actor requires humanId');
    } else if (actor.kind === 'max' && !isNonEmptyString(actor.maxVersion)) {
      errors.push('max actor requires maxVersion');
    } else if (actor.kind === 'system' && !isNonEmptyString(actor.component)) {
      errors.push('system actor requires component');
    } else if (actor.kind === 'integration' && !isNonEmptyString(actor.provider)) {
      errors.push('integration actor requires provider');
    }
  }

  if (!Array.isArray(rec.sourceRefs)) {
    errors.push('sourceRefs must be an array');
  }

  if (!Array.isArray(rec.evidenceRefs)) {
    errors.push('evidenceRefs must be an array');
  }

  // Validação temporal
  if (!isValidIso8601(rec.observedAt)) {
    errors.push('observedAt must be a valid ISO 8601 string');
  }

  if (!isValidIso8601(rec.capturedAt)) {
    errors.push('capturedAt must be a valid ISO 8601 string');
  }

  if (rec.occurredAt !== undefined && !isValidIso8601(rec.occurredAt)) {
    errors.push('occurredAt, if provided, must be a valid ISO 8601 string');
  }

  if (rec.receivedAt !== undefined && !isValidIso8601(rec.receivedAt)) {
    errors.push('receivedAt, if provided, must be a valid ISO 8601 string');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// 3. VALIDAÇÃO DE PROMOÇÃO CANÔNICA (Invariante de Autoridade Humana)
// ============================================================================

export interface PromotionValidationResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function validateCanonicalPromotion(event: ReviewEvent): PromotionValidationResult {
  const isPromoting =
    event.decision === 'canonical_promoted' ||
    event.decision === 'canonical_reclassified' ||
    event.canonicalEffect !== undefined;

  if (!isPromoting) {
    return { allowed: true };
  }

  // 1. Ator deve ser estritamente humano
  if (event.actor.kind !== 'human') {
    return {
      allowed: false,
      reason: `Canonical promotion requires a human actor; received actor kind: '${event.actor.kind}'`,
    };
  }

  // 2. Humano deve ter autoridade explícita
  if (!isNonEmptyString(event.actor.authorityRef)) {
    return {
      allowed: false,
      reason: 'Human actor must provide an explicit authorityRef to authorize canonical promotion',
    };
  }

  // 3. Justificativa material obrigatória
  if (!isNonEmptyString(event.justification)) {
    return {
      allowed: false,
      reason: 'Justification is mandatory and cannot be empty for canonical promotion',
    };
  }

  // 4. Deve apontar para observações alvo
  if (!Array.isArray(event.targetObservationIds) || event.targetObservationIds.length === 0) {
    return {
      allowed: false,
      reason: 'Target observation IDs are required to support canonical promotion',
    };
  }

  return { allowed: true };
}

// ============================================================================
// 4. VALIDAÇÃO DE REVIEW EVENT
// ============================================================================

export function validateReviewEvent(event: unknown): ValidationResult {
  const errors: string[] = [];

  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['ReviewEvent must be an object'] };
  }

  const ev = event as Partial<ReviewEvent>;

  if (!isNonEmptyString(ev.reviewId)) {
    errors.push('reviewId is required and must be a non-empty string');
  }

  if (!ev.actor || typeof ev.actor !== 'object' || !isNonEmptyString((ev.actor as Actor).kind)) {
    errors.push('actor with a valid kind is required');
  }

  if (!Array.isArray(ev.targetObservationIds) || ev.targetObservationIds.length === 0) {
    errors.push('targetObservationIds must be a non-empty array of ObservationRecordIds');
  }

  if (!isNonEmptyString(ev.decision)) {
    errors.push('decision is required');
  }

  if (!isNonEmptyString(ev.justification)) {
    errors.push('justification is mandatory and cannot be empty or whitespace only');
  }

  if (!isValidIso8601(ev.reviewedAt)) {
    errors.push('reviewedAt must be a valid ISO 8601 string');
  }

  // Validação de autoridade canônica se os campos básicos existirem
  if (ev.decision && ev.actor && isNonEmptyString(ev.justification)) {
    const promoCheck = validateCanonicalPromotion(ev as ReviewEvent);
    if (!promoCheck.allowed && promoCheck.reason) {
      errors.push(promoCheck.reason);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// 5. DETECÇÃO DE REVISÃO OBSOLETA / CONCORRÊNCIA (Stale Review Base)
// ============================================================================

export type ReviewBaseStatus = 'current' | 'stale_conflicting' | 'unanchored';

export function evaluateReviewBaseStatus(
  review: ReviewEvent,
  currentCanonicalRevisionId?: CanonicalProjectionRevisionId
): ReviewBaseStatus {
  if (!review.targetBaseRevisionId) {
    // Se não tinha base e ainda não existe projeção canônica, é não-ancorada válida (criação inicial)
    if (!currentCanonicalRevisionId) {
      return 'unanchored';
    }
    // Se não tinha base mas já existe uma projeção canônica corrente, a revisão é conflitante/stale
    return 'stale_conflicting';
  }

  // Se a revisão aponta exatamente para a base vigente
  if (review.targetBaseRevisionId === currentCanonicalRevisionId) {
    return 'current';
  }

  // Se a base mudou (nova projeção foi materializada no ínterim)
  return 'stale_conflicting';
}

// ============================================================================
// 6. VALIDAÇÃO DE CANONICAL PROJECTION
// ============================================================================

export function validateCanonicalProjection(projection: unknown): ValidationResult {
  const errors: string[] = [];

  if (!projection || typeof projection !== 'object') {
    return { valid: false, errors: ['CanonicalProjection must be an object'] };
  }

  const p = projection as Partial<CanonicalProjection>;

  if (!isNonEmptyString(p.projectionRevisionId)) {
    errors.push('projectionRevisionId is required and must be a non-empty string');
  }

  if (!p.subject || typeof p.subject !== 'object') {
    errors.push('subject is required');
  }

  if (!p.canonicalState || typeof p.canonicalState !== 'object') {
    errors.push('canonicalState is required and must be an object');
  }

  if (!Array.isArray(p.underlyingObservationIds) || p.underlyingObservationIds.length === 0) {
    errors.push('underlyingObservationIds must be a non-empty array');
  }

  if (!Array.isArray(p.authorizingReviewIds) || p.authorizingReviewIds.length === 0) {
    errors.push('authorizingReviewIds must be a non-empty array');
  }

  if (!isNonEmptyString(p.explanation)) {
    errors.push('explanation is mandatory and cannot be empty');
  }

  if (!isValidIso8601(p.materializedAt)) {
    errors.push('materializedAt must be a valid ISO 8601 string');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// 7. VALIDAÇÃO DE RECONCILIATION CASE
// ============================================================================

export function validateReconciliationCase(reconciliationCase: unknown): ValidationResult {
  const errors: string[] = [];

  if (!reconciliationCase || typeof reconciliationCase !== 'object') {
    return { valid: false, errors: ['ReconciliationCase must be an object'] };
  }

  const c = reconciliationCase as Partial<ReconciliationCase>;

  if (!isNonEmptyString(c.caseId)) errors.push('caseId is required');
  if (!c.subject || typeof c.subject !== 'object') errors.push('subject is required');
  if (!isNonEmptyString(c.status)) errors.push('status is required');
  if (!Array.isArray(c.observationIds) || c.observationIds.length === 0) {
    errors.push('observationIds must be a non-empty array');
  }
  if (!Array.isArray(c.reviewIds)) errors.push('reviewIds must be an array');
  if (!isValidIso8601(c.openedAt)) errors.push('openedAt must be a valid ISO 8601 string');
  if (c.resolvedAt !== undefined && !isValidIso8601(c.resolvedAt)) {
    errors.push('resolvedAt, if present, must be a valid ISO 8601 string');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// 8. PRECEDENTE CONTEXTUAL NÃO É POLICY (Garantia Estrutural)
// ============================================================================

export function isPrecedentContextual(precedent: ContextualPrecedent): boolean {
  return (
    isNonEmptyString(precedent.precedentId) &&
    isNonEmptyString(precedent.reviewEventId) &&
    isNonEmptyString(precedent.contextSummary) &&
    Array.isArray(precedent.applicabilityConditions)
  );
}
