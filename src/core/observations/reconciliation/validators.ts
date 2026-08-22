/**
 * NEX+ · Validadores de Reconciliação, Precedentes & Gates de Autoridade
 * Escopo 0.85 (Bloco 0.85D · Micro-Hardening A)
 */

import type {
  ReconciliationCase,
  ContextualPrecedent,
  ReviewEvent,
  ObservationRecord,
  HumanActor,
} from '../contracts';
import type { HumanAuthorizationDecision } from '../../policy/contracts';
import {
  validateReconciliationCase,
  isPrecedentContextual,
  isCanonicalUtcInstant,
  isNonEmptyString,
} from '../invariants';
import {
  ReconciliationCaseCoherenceError,
  ContextualPrecedentInvalidReviewError,
  CanonicalPromotionAuthorityError,
} from './errors';

export function assertValidReconciliationCase(caseObj: ReconciliationCase): void {
  const result = validateReconciliationCase(caseObj);
  if (!result.valid) {
    throw new ReconciliationCaseCoherenceError(
      'INVALID_RECONCILIATION_CASE_SCHEMA',
      result.errors.join('; ')
    );
  }
}

/**
 * Validação de integridade e coerência entre um ReconciliationCase e as entidades referenciadas no banco.
 */
export function assertReconciliationCaseCoherence(
  caseObj: ReconciliationCase,
  observations: readonly ObservationRecord[],
  reviews: readonly ReviewEvent[]
): void {
  assertValidReconciliationCase(caseObj);

  // 1. Todas as observações referenciadas diretamente pelo caso devem existir e pertencer ao mesmo subject
  const obsMap = new Map<string, ObservationRecord>();
  for (const obs of observations) {
    obsMap.set(obs.observationId, obs);
  }

  for (const obsId of caseObj.observationIds) {
    const obs = obsMap.get(obsId);
    if (!obs) {
      throw new ReconciliationCaseCoherenceError(
        'OBSERVATION_NOT_FOUND',
        `ReconciliationCase '${caseObj.caseId}' references non-existent observationId '${obsId}'.`
      );
    }

    if (
      obs.subject.domain !== caseObj.subject.domain ||
      obs.subject.entityType !== caseObj.subject.entityType ||
      obs.subject.entityId !== caseObj.subject.entityId
    ) {
      throw new ReconciliationCaseCoherenceError(
        'CROSS_SUBJECT_OBSERVATION_MISMATCH',
        `Observation '${obsId}' belongs to subject '${obs.subject.domain}:${obs.subject.entityType}:${obs.subject.entityId}', but case '${caseObj.caseId}' is for '${caseObj.subject.domain}:${caseObj.subject.entityType}:${caseObj.subject.entityId}'.`
      );
    }
  }

  // 2. Todas as reviews referenciadas pelo caso devem existir e ter seus alvos coerentes com o subject do caso
  const revMap = new Map<string, ReviewEvent>();
  for (const rev of reviews) {
    revMap.set(rev.reviewId, rev);
  }

  for (const revId of caseObj.reviewIds) {
    const rev = revMap.get(revId);
    if (!rev) {
      throw new ReconciliationCaseCoherenceError(
        'REVIEW_NOT_FOUND',
        `ReconciliationCase '${caseObj.caseId}' references non-existent reviewId '${revId}'.`
      );
    }

    // Cada targetObservationId da review deve existir e pertencer ao mesmo subject do caso
    for (const targetObsId of rev.targetObservationIds) {
      const targetObs = obsMap.get(targetObsId);
      if (!targetObs) {
        throw new ReconciliationCaseCoherenceError(
          'REVIEW_OBSERVATION_NOT_FOUND',
          `Review '${revId}' in case '${caseObj.caseId}' targets observation '${targetObsId}', which is not present among the case's verified observations.`
        );
      }

      if (
        targetObs.subject.domain !== caseObj.subject.domain ||
        targetObs.subject.entityType !== caseObj.subject.entityType ||
        targetObs.subject.entityId !== caseObj.subject.entityId
      ) {
        throw new ReconciliationCaseCoherenceError(
          'REVIEW_CROSS_SUBJECT_MISMATCH',
          `Review '${revId}' targets observation '${targetObsId}' from another subject ('${targetObs.subject.domain}:${targetObs.subject.entityType}:${targetObs.subject.entityId}').`
        );
      }
    }
  }
}

/**
 * Valida as regras de continuidade e imutabilidade histórica entre a revisão anterior e a nova revisão.
 */
export function assertReconciliationRevisionContinuity(
  previousCase: ReconciliationCase,
  newCase: ReconciliationCase
): void {
  // 1. caseId imutável
  if (newCase.caseId !== previousCase.caseId) {
    throw new ReconciliationCaseCoherenceError(
      'MUTATION_CASE_ID_PROHIBITED',
      `Cannot change caseId from '${previousCase.caseId}' to '${newCase.caseId}'.`
    );
  }

  // 2. subject imutável integralmente
  if (
    newCase.subject.domain !== previousCase.subject.domain ||
    newCase.subject.entityType !== previousCase.subject.entityType ||
    newCase.subject.entityId !== previousCase.subject.entityId
  ) {
    throw new ReconciliationCaseCoherenceError(
      'MUTATION_SUBJECT_PROHIBITED',
      `Cannot mutate subject during reconciliation revision append. Expected '${previousCase.subject.domain}:${previousCase.subject.entityType}:${previousCase.subject.entityId}', got '${newCase.subject.domain}:${newCase.subject.entityType}:${newCase.subject.entityId}'.`
    );
  }

  // 3. openedAt imutável
  if (newCase.openedAt !== previousCase.openedAt) {
    throw new ReconciliationCaseCoherenceError(
      'MUTATION_OPENED_AT_PROHIBITED',
      `Cannot mutate openedAt timestamp during reconciliation revision append. Expected '${previousCase.openedAt}', got '${newCase.openedAt}'.`
    );
  }

  // 4. Resolved NÃO reabre
  if (previousCase.lifecycle === 'resolved' && newCase.lifecycle === 'open') {
    throw new ReconciliationCaseCoherenceError(
      'RESOLVED_CASE_CANNOT_BE_REOPENED',
      `ReconciliationCase '${previousCase.caseId}' is already resolved and cannot be reopened to lifecycle 'open'.`
    );
  }

  // 5. Histórico cumulativo de observationIds: não pode remover referências anteriores
  const newObsSet = new Set(newCase.observationIds);
  if (newObsSet.size !== newCase.observationIds.length) {
    throw new ReconciliationCaseCoherenceError(
      'DUPLICATE_OBSERVATION_REFERENCES',
      `ReconciliationCase contains duplicate observationIds.`
    );
  }

  for (const prevObsId of previousCase.observationIds) {
    if (!newObsSet.has(prevObsId)) {
      throw new ReconciliationCaseCoherenceError(
        'HISTORICAL_OBSERVATIONS_CANNOT_BE_REMOVED',
        `Historical observationId '${prevObsId}' was removed in new revision. Historical references must be monotonically preserved.`
      );
    }
  }

  // 6. Histórico cumulativo de reviewIds: não pode remover referências anteriores
  const newRevSet = new Set(newCase.reviewIds);
  if (newRevSet.size !== newCase.reviewIds.length) {
    throw new ReconciliationCaseCoherenceError(
      'DUPLICATE_REVIEW_REFERENCES',
      `ReconciliationCase contains duplicate reviewIds.`
    );
  }

  for (const prevRevId of previousCase.reviewIds) {
    if (!newRevSet.has(prevRevId)) {
      throw new ReconciliationCaseCoherenceError(
        'HISTORICAL_REVIEWS_CANNOT_BE_REMOVED',
        `Historical reviewId '${prevRevId}' was removed in new revision. Historical references must be monotonically preserved.`
      );
    }
  }
}

export function assertValidContextualPrecedent(
  precedent: ContextualPrecedent,
  sourceReview: ReviewEvent
): void {
  if (!isPrecedentContextual(precedent)) {
    throw new ContextualPrecedentInvalidReviewError(
      precedent.precedentId,
      precedent.reviewEventId,
      'ContextualPrecedent fails structural invariants (invalid id, reviewEventId, contextSummary or conditions).'
    );
  }

  if (sourceReview.reviewId !== precedent.reviewEventId) {
    throw new ContextualPrecedentInvalidReviewError(
      precedent.precedentId,
      precedent.reviewEventId,
      `Precedent reviewEventId '${precedent.reviewEventId}' does not match source reviewId '${sourceReview.reviewId}'.`
    );
  }

  // Precedente exige que a revisão fonte seja de um ator HUMANO
  if (sourceReview.actor.kind !== 'human') {
    throw new ContextualPrecedentInvalidReviewError(
      precedent.precedentId,
      precedent.reviewEventId,
      `ContextualPrecedent can only be established from a human review. Review '${sourceReview.reviewId}' was performed by '${sourceReview.actor.kind}'.`
    );
  }

  const humanActor = sourceReview.actor as HumanActor;
  if (!isNonEmptyString(humanActor.humanId)) {
    throw new ContextualPrecedentInvalidReviewError(
      precedent.precedentId,
      precedent.reviewEventId,
      `Source review human actor must have a valid non-empty humanId.`
    );
  }

  // A justificativa da revisão fonte deve ser válida e não-vazia
  if (!isNonEmptyString(sourceReview.justification)) {
    throw new ContextualPrecedentInvalidReviewError(
      precedent.precedentId,
      precedent.reviewEventId,
      `Source review '${sourceReview.reviewId}' must have a non-empty justification to establish a precedent.`
    );
  }
}

export function assertCanonicalPromotionAuthority(
  review: ReviewEvent,
  authorization: HumanAuthorizationDecision | undefined
): void {
  // 1. Verificação estrita de Actor em runtime (bloqueio total de MAX/System/Integration)
  if (review.actor.kind !== 'human') {
    throw new CanonicalPromotionAuthorityError(
      'UNAUTHORIZED_ACTOR_KIND',
      `Actor of kind '${review.actor.kind}' is strictly forbidden from executing canonical promotions. Only verified human actors may promote to canonical.`
    );
  }

  const humanActor = review.actor as HumanActor;
  if (!isNonEmptyString(humanActor.humanId)) {
    throw new CanonicalPromotionAuthorityError(
      'INVALID_HUMAN_ID',
      'Human actor must have a valid non-empty humanId.'
    );
  }

  // 2. Verificação de HumanAuthorizationDecision
  if (!authorization) {
    throw new CanonicalPromotionAuthorityError(
      'MISSING_AUTHORIZATION',
      'HumanAuthorizationDecision is strictly required for canonical promotion.'
    );
  }

  if (authorization.verdict !== 'authorized') {
    throw new CanonicalPromotionAuthorityError(
      'AUTHORIZATION_DENIED',
      `Human authorization verdict is '${authorization.verdict}' (reason: '${authorization.reasonCode}'). Canonical promotion rejected.`
    );
  }

  // 3. Correspondência EXATA da operação (sem aliases ambíguos)
  if (review.decision === 'canonical_promoted') {
    if (authorization.operation !== 'canonical_promotion') {
      throw new CanonicalPromotionAuthorityError(
        'OPERATION_MISMATCH',
        `Review decision 'canonical_promoted' strictly requires authorization operation 'canonical_promotion'. Got '${authorization.operation}'.`
      );
    }
  } else if (review.decision === 'canonical_reclassified') {
    if (authorization.operation !== 'canonical_reclassification') {
      throw new CanonicalPromotionAuthorityError(
        'OPERATION_MISMATCH',
        `Review decision 'canonical_reclassified' strictly requires authorization operation 'canonical_reclassification'. Got '${authorization.operation}'.`
      );
    }
  } else {
    throw new CanonicalPromotionAuthorityError(
      'INVALID_CANONICAL_DECISION',
      `Decision '${review.decision}' is not a valid canonical promotion decision.`
    );
  }

  if (authorization.actorRef !== humanActor.humanId) {
    throw new CanonicalPromotionAuthorityError(
      'ACTOR_MISMATCH',
      `Authorization decision actorRef '${authorization.actorRef}' does not match review actor humanId '${humanActor.humanId}'.`
    );
  }

  if (authorization.authorizedAt && !isCanonicalUtcInstant(authorization.authorizedAt)) {
    throw new CanonicalPromotionAuthorityError(
      'INVALID_AUTHORIZED_AT_TIMESTAMP',
      `Authorization authorizedAt timestamp '${authorization.authorizedAt}' is not a valid ISO 8601 UTC instant.`
    );
  }
}
