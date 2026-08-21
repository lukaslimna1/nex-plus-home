/**
 * NEX+ · Invariantes & Validadores Puros de Observação e Revisão
 * Escopo 0.85 (Bloco 0.85A · Hardening Pós-Auditoria)
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
  ActorKind,
  EvidenceArtifactRef,
  EvidenceArtifactKind,
  ReviewDecision,
  NonCanonicalReviewDecision,
  ReconciliationLifecycle,
  OpenReconciliationStatus,
  ResolvedReconciliationStatus,
} from './contracts';

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

  // Regex estrito para ISO 8601 UTC: YYYY-MM-DDTHH:mm:ssZ ou YYYY-MM-DDTHH:mm:ss.sssZ
  const isoUtcRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
  if (!isoUtcRegex.test(val)) return false;

  const d = new Date(val);
  if (isNaN(d.getTime())) return false;

  // Garantir que a data não sofreu overflow (ex: 2026-02-30 -> 2026-03-02)
  const isoString = d.toISOString();
  // Normalizar comparação tratando .000Z vs Z
  const normalizedInput = val.includes('.') ? val : val.replace('Z', '.000Z');
  const normalizedDate = isoString;

  // Comparar componentes de ano, mês e dia
  const [datePart] = val.split('T');
  const [dYear, dMonth, dDay] = datePart.split('-').map((s) => parseInt(s, 10));
  if (d.getUTCFullYear() !== dYear || d.getUTCMonth() + 1 !== dMonth || d.getUTCDate() !== dDay) {
    return false;
  }

  return true;
}

// ============================================================================
// 2. VALIDAÇÃO DE ATORES (Runtime Guard Fechado)
// ============================================================================

const ALLOWED_ACTOR_KINDS = new Set<ActorKind>(['human', 'max', 'system', 'integration']);

export function isActor(val: unknown): val is Actor {
  if (!val || typeof val !== 'object') return false;

  const candidate = val as Record<string, unknown>;
  if (typeof candidate.kind !== 'string') return false;
  if (!ALLOWED_ACTOR_KINDS.has(candidate.kind as ActorKind)) return false;

  switch (candidate.kind) {
    case 'human':
      return isNonEmptyString(candidate.humanId);
    case 'max':
      return isNonEmptyString(candidate.maxVersion);
    case 'system':
      return isNonEmptyString(candidate.component);
    case 'integration':
      return isNonEmptyString(candidate.provider);
    default:
      return false;
  }
}

export function validateActor(val: unknown): ValidationResult {
  const errors: string[] = [];

  if (!val || typeof val !== 'object') {
    return { valid: false, errors: ['Actor must be an object'] };
  }

  const candidate = val as Record<string, unknown>;
  if (!isNonEmptyString(candidate.kind)) {
    errors.push('actor.kind is required and must be a non-empty string');
    return { valid: false, errors };
  }

  if (!ALLOWED_ACTOR_KINDS.has(candidate.kind as ActorKind)) {
    errors.push(
      `actor.kind '${candidate.kind}' is invalid. Allowed kinds: ${Array.from(ALLOWED_ACTOR_KINDS).join(', ')}`
    );
    return { valid: false, errors };
  }

  switch (candidate.kind) {
    case 'human':
      if (!isNonEmptyString(candidate.humanId)) {
        errors.push('human actor requires a non-empty humanId');
      }
      break;
    case 'max':
      if (!isNonEmptyString(candidate.maxVersion)) {
        errors.push('max actor requires a non-empty maxVersion');
      }
      break;
    case 'system':
      if (!isNonEmptyString(candidate.component)) {
        errors.push('system actor requires a non-empty component');
      }
      break;
    case 'integration':
      if (!isNonEmptyString(candidate.provider)) {
        errors.push('integration actor requires a non-empty provider');
      }
      break;
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// 3. VALIDAÇÃO DE EVIDENCE ARTIFACT (Runtime Guard Fechado)
// ============================================================================

const ALLOWED_EVIDENCE_KINDS = new Set<EvidenceArtifactKind>([
  'url_resource',
  'api_response',
  'document',
  'screenshot',
  'snapshot',
  'text_snippet',
  'human_message',
  'execution_evidence_ref',
]);

export function validateEvidenceArtifactRef(val: unknown): ValidationResult {
  const errors: string[] = [];

  if (!val || typeof val !== 'object') {
    return { valid: false, errors: ['EvidenceArtifactRef must be an object'] };
  }

  const art = val as Record<string, unknown>;

  if (!isNonEmptyString(art.artifactId)) {
    errors.push('artifactId is required and must be a non-empty string');
  }

  if (!isNonEmptyString(art.kind) || !ALLOWED_EVIDENCE_KINDS.has(art.kind as EvidenceArtifactKind)) {
    errors.push(
      `kind '${art.kind}' is invalid. Allowed kinds: ${Array.from(ALLOWED_EVIDENCE_KINDS).join(', ')}`
    );
  }

  if (!isCanonicalUtcInstant(art.capturedAt)) {
    errors.push('capturedAt must be a valid ISO 8601 UTC string ending with Z');
  }

  if (art.kind === 'execution_evidence_ref') {
    if (!isNonEmptyString(art.executionEvidenceId)) {
      errors.push('executionEvidenceId is mandatory when kind is execution_evidence_ref');
    }
  } else {
    if (art.executionEvidenceId !== undefined) {
      errors.push(`executionEvidenceId is prohibited for kind '${art.kind}'`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function isEvidenceArtifactRef(val: unknown): val is EvidenceArtifactRef {
  return validateEvidenceArtifactRef(val).valid;
}

// ============================================================================
// 4. VALIDAÇÃO DE OBSERVATION RECORD
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

  // Validação estrita de Actor
  const actorValidation = validateActor(rec.actor);
  if (!actorValidation.valid) {
    errors.push(...actorValidation.errors);
  }

  if (!Array.isArray(rec.sourceRefs)) {
    errors.push('sourceRefs must be an array');
  }

  if (!Array.isArray(rec.evidenceRefs)) {
    errors.push('evidenceRefs must be an array');
  }

  // Validação temporal canônica (UTC 'Z')
  if (!isCanonicalUtcInstant(rec.observedAt)) {
    errors.push('observedAt must be a valid ISO 8601 UTC string ending with Z');
  }

  if (!isCanonicalUtcInstant(rec.capturedAt)) {
    errors.push('capturedAt must be a valid ISO 8601 UTC string ending with Z');
  }

  if (rec.occurredAt !== undefined && !isCanonicalUtcInstant(rec.occurredAt)) {
    errors.push('occurredAt, if provided, must be a valid ISO 8601 UTC string ending with Z');
  }

  if (rec.receivedAt !== undefined && !isCanonicalUtcInstant(rec.receivedAt)) {
    errors.push('receivedAt, if provided, must be a valid ISO 8601 UTC string ending with Z');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// 5. VALIDAÇÃO DE PROMOÇÃO CANÔNICA (Invariante de Autoridade Humana)
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
// 6. VALIDAÇÃO DE REVIEW EVENT (Matriz Fechada Decision × CanonicalEffect)
// ============================================================================

const ALLOWED_NON_CANONICAL_DECISIONS = new Set<NonCanonicalReviewDecision>([
  'provisional',
  'corroborated',
  'contested',
  'divergent',
  'awaiting_evidence',
  'inconclusive',
  'rejected',
]);

const ALLOWED_ALL_DECISIONS = new Set<ReviewDecision>([
  ...ALLOWED_NON_CANONICAL_DECISIONS,
  'canonical_promoted',
  'canonical_reclassified',
]);

export function validateReviewEvent(event: unknown): ValidationResult {
  const errors: string[] = [];

  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['ReviewEvent must be an object'] };
  }

  const ev = event as Record<string, unknown>;

  if (!isNonEmptyString(ev.reviewId)) {
    errors.push('reviewId is required and must be a non-empty string');
  }

  // Validação estrita de Actor
  const actorValidation = validateActor(ev.actor);
  if (!actorValidation.valid) {
    errors.push(...actorValidation.errors);
  }

  if (!Array.isArray(ev.targetObservationIds) || ev.targetObservationIds.length === 0) {
    errors.push('targetObservationIds must be a non-empty array of ObservationRecordIds');
  }

  if (!isNonEmptyString(ev.decision) || !ALLOWED_ALL_DECISIONS.has(ev.decision as ReviewDecision)) {
    errors.push(
      `decision '${ev.decision}' is invalid. Allowed decisions: ${Array.from(ALLOWED_ALL_DECISIONS).join(', ')}`
    );
  }

  if (!isNonEmptyString(ev.justification)) {
    errors.push('justification is mandatory and cannot be empty or whitespace only');
  }

  if (!isCanonicalUtcInstant(ev.reviewedAt)) {
    errors.push('reviewedAt must be a valid ISO 8601 UTC string ending with Z');
  }

  // Matriz de coerência Decision × CanonicalEffect
  const decision = ev.decision as ReviewDecision | undefined;
  const canonicalEffect = ev.canonicalEffect as Record<string, unknown> | undefined;

  if (decision === 'canonical_promoted') {
    if (!canonicalEffect || typeof canonicalEffect !== 'object') {
      errors.push('canonicalEffect is mandatory when decision is canonical_promoted');
    } else {
      if (canonicalEffect.action !== 'promote') {
        errors.push("canonicalEffect.action must be 'promote' for canonical_promoted decision");
      }
      if (!canonicalEffect.targetCanonicalState || typeof canonicalEffect.targetCanonicalState !== 'object') {
        errors.push('canonicalEffect.targetCanonicalState must be an object');
      }
    }
  } else if (decision === 'canonical_reclassified') {
    if (!canonicalEffect || typeof canonicalEffect !== 'object') {
      errors.push('canonicalEffect is mandatory when decision is canonical_reclassified');
    } else {
      if (canonicalEffect.action !== 'reclassify') {
        errors.push("canonicalEffect.action must be 'reclassify' for canonical_reclassified decision");
      }
      if (!canonicalEffect.targetCanonicalState || typeof canonicalEffect.targetCanonicalState !== 'object') {
        errors.push('canonicalEffect.targetCanonicalState must be an object');
      }
    }
  } else if (decision && ALLOWED_NON_CANONICAL_DECISIONS.has(decision as NonCanonicalReviewDecision)) {
    if (canonicalEffect !== undefined) {
      errors.push(`canonicalEffect is strictly prohibited for non-canonical decision '${decision}'`);
    }
  }

  // Validação de autoridade humana para promoção
  if (actorValidation.valid && decision && (decision === 'canonical_promoted' || decision === 'canonical_reclassified')) {
    const promoCheck = validateCanonicalPromotion(ev as unknown as ReviewEvent);
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
// 7. DETECÇÃO DE REVISÃO OBSOLETA / CONCORRÊNCIA (Stale Base)
// ============================================================================

export type ReviewBaseStatus = 'current' | 'stale_conflicting' | 'unanchored';

export function evaluateReviewBaseStatus(
  review: ReviewEvent,
  currentCanonicalRevisionId?: CanonicalProjectionRevisionId
): ReviewBaseStatus {
  if (!review.targetBaseRevisionId) {
    if (!currentCanonicalRevisionId) {
      return 'unanchored';
    }
    return 'stale_conflicting';
  }

  if (review.targetBaseRevisionId === currentCanonicalRevisionId) {
    return 'current';
  }

  return 'stale_conflicting';
}

// ============================================================================
// 8. VALIDAÇÃO DE RECONCILIATION CASE (Ciclo de Vida Fechado)
// ============================================================================

const ALLOWED_LIFECYCLES = new Set<ReconciliationLifecycle>(['open', 'resolved']);

const ALLOWED_OPEN_STATUSES = new Set<OpenReconciliationStatus>([
  'open',
  'awaiting_evidence',
  'divergent',
  'inconclusive',
]);

const ALLOWED_RESOLVED_STATUSES = new Set<ResolvedReconciliationStatus>([
  'validated',
  'partially_validated',
  'divergent',
  'inconclusive',
  'reclassified',
]);

export function validateReconciliationCase(reconciliationCase: unknown): ValidationResult {
  const errors: string[] = [];

  if (!reconciliationCase || typeof reconciliationCase !== 'object') {
    return { valid: false, errors: ['ReconciliationCase must be an object'] };
  }

  const c = reconciliationCase as Record<string, unknown>;

  if (!isNonEmptyString(c.caseId)) errors.push('caseId is required');
  if (!c.subject || typeof c.subject !== 'object') errors.push('subject is required');

  if (!Array.isArray(c.observationIds) || c.observationIds.length === 0) {
    errors.push('observationIds must be a non-empty array');
  }
  if (!Array.isArray(c.reviewIds)) errors.push('reviewIds must be an array');

  if (!isCanonicalUtcInstant(c.openedAt)) {
    errors.push('openedAt must be a valid ISO 8601 UTC string ending with Z');
  }

  // Validação de lifecycle e status
  if (!isNonEmptyString(c.lifecycle) || !ALLOWED_LIFECYCLES.has(c.lifecycle as ReconciliationLifecycle)) {
    errors.push(
      `lifecycle '${c.lifecycle}' is invalid. Allowed: ${Array.from(ALLOWED_LIFECYCLES).join(', ')}`
    );
    return { valid: false, errors };
  }

  const lifecycle = c.lifecycle as ReconciliationLifecycle;

  if (lifecycle === 'open') {
    if (!isNonEmptyString(c.status) || !ALLOWED_OPEN_STATUSES.has(c.status as OpenReconciliationStatus)) {
      errors.push(
        `status '${c.status}' is invalid for open lifecycle. Allowed: ${Array.from(ALLOWED_OPEN_STATUSES).join(', ')}`
      );
    }
    if (c.resolvedAt !== undefined) {
      errors.push('resolvedAt is prohibited when lifecycle is open');
    }
  } else if (lifecycle === 'resolved') {
    if (!isNonEmptyString(c.status) || !ALLOWED_RESOLVED_STATUSES.has(c.status as ResolvedReconciliationStatus)) {
      errors.push(
        `status '${c.status}' is invalid for resolved lifecycle. Allowed: ${Array.from(ALLOWED_RESOLVED_STATUSES).join(', ')}`
      );
    }
    if (!isCanonicalUtcInstant(c.resolvedAt)) {
      errors.push('resolvedAt is mandatory and must be a valid ISO 8601 UTC string ending with Z when lifecycle is resolved');
    }
    if (!isNonEmptyString(c.resolutionSummary)) {
      errors.push('resolutionSummary is mandatory and cannot be empty when lifecycle is resolved');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// 9. VALIDAÇÃO DE CANONICAL PROJECTION
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

  if (!isCanonicalUtcInstant(p.materializedAt)) {
    errors.push('materializedAt must be a valid ISO 8601 UTC string ending with Z');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// 10. PRECEDENTE CONTEXTUAL NÃO É POLICY (Garantia Estrutural)
// ============================================================================

export function isPrecedentContextual(precedent: ContextualPrecedent): boolean {
  return (
    isNonEmptyString(precedent.precedentId) &&
    isNonEmptyString(precedent.reviewEventId) &&
    isNonEmptyString(precedent.contextSummary) &&
    Array.isArray(precedent.applicabilityConditions)
  );
}
