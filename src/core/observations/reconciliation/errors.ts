/**
 * NEX+ · Erros da Camada de Reconciliação & Autoridade
 * Escopo 0.85 (Bloco 0.85D)
 */

import type { ReconciliationCaseId, ContextualPrecedentRefId, ReviewEventId } from '../contracts';

export class ReconciliationCaseConflictError extends Error {
  readonly caseId: ReconciliationCaseId;
  readonly reason: string;

  constructor(caseId: ReconciliationCaseId, reason: string) {
    super(`ReconciliationCase conflict for '${caseId}': ${reason}`);
    this.name = 'ReconciliationCaseConflictError';
    this.caseId = caseId;
    this.reason = reason;
  }
}

export class StaleReconciliationVersionConflictError extends Error {
  readonly caseId: ReconciliationCaseId;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(caseId: ReconciliationCaseId, expectedVersion: number, actualVersion: number) {
    super(
      `ReconciliationCase '${caseId}' optimistic concurrency violation: expected version ${expectedVersion}, but current version is ${actualVersion}.`
    );
    this.name = 'StaleReconciliationVersionConflictError';
    this.caseId = caseId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class ReconciliationCaseCoherenceError extends Error {
  readonly code: string;
  readonly explanation: string;

  constructor(code: string, explanation: string) {
    super(`ReconciliationCase coherence violation [${code}]: ${explanation}`);
    this.name = 'ReconciliationCaseCoherenceError';
    this.code = code;
    this.explanation = explanation;
  }
}

export class ContextualPrecedentConflictError extends Error {
  readonly precedentId: ContextualPrecedentRefId;
  readonly reason: string;

  constructor(precedentId: ContextualPrecedentRefId, reason: string) {
    super(`ContextualPrecedent conflict for '${precedentId}': ${reason}`);
    this.name = 'ContextualPrecedentConflictError';
    this.precedentId = precedentId;
    this.reason = reason;
  }
}

export class ContextualPrecedentInvalidReviewError extends Error {
  readonly precedentId: ContextualPrecedentRefId;
  readonly reviewEventId: ReviewEventId;
  readonly reason: string;

  constructor(precedentId: ContextualPrecedentRefId, reviewEventId: ReviewEventId, reason: string) {
    super(`ContextualPrecedent '${precedentId}' references invalid review '${reviewEventId}': ${reason}`);
    this.name = 'ContextualPrecedentInvalidReviewError';
    this.precedentId = precedentId;
    this.reviewEventId = reviewEventId;
    this.reason = reason;
  }
}

export class CanonicalPromotionAuthorityError extends Error {
  readonly code: string;
  readonly explanation: string;

  constructor(code: string, explanation: string) {
    super(`Canonical promotion authority gate violation [${code}]: ${explanation}`);
    this.name = 'CanonicalPromotionAuthorityError';
    this.code = code;
    this.explanation = explanation;
  }
}

export class StaleReviewPreservationError extends Error {
  readonly reviewId: ReviewEventId;
  readonly staleConflict: Error;

  constructor(
    reviewId: ReviewEventId,
    staleConflict: Error,
    explanation: string,
    options?: { cause?: unknown }
  ) {
    super(`Failed to preserve stale review '${reviewId}': ${explanation}`, options);
    this.name = 'StaleReviewPreservationError';
    this.reviewId = reviewId;
    this.staleConflict = staleConflict;
  }
}

export class ReviewIdentityConflictError extends Error {
  readonly reviewId: ReviewEventId;
  readonly reason: string;

  constructor(
    reviewId: ReviewEventId,
    reason: string,
    options?: { cause?: unknown }
  ) {
    super(`Review identity conflict for '${reviewId}': ${reason}`, options);
    this.name = 'ReviewIdentityConflictError';
    this.reviewId = reviewId;
    this.reason = reason;
  }
}
