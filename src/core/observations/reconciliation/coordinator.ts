/**
 * NEX+ · Coordenador de Reconciliação, Precedentes & Gates de Autoridade
 * Escopo 0.85 (Bloco 0.85D)
 */

import { isDeepStrictEqual } from 'node:util';
import type {
  ReviewEvent,
  NonCanonicalReviewEvent,
  CanonicalPromotedReviewEvent,
  CanonicalReclassifiedReviewEvent,
  CanonicalProjection,
  CanonicalProjectionRevisionId,
  ReconciliationCase,
  ReconciliationCaseId,
  ContextualPrecedent,
} from '../contracts';
import type {
  ObservationPersistenceAdapter,
  CommitCanonicalPromotionResult,
} from '../persistence/contracts';
import { StaleCanonicalBaseConflictError } from '../persistence/errors';
import type {
  ReconciliationPersistenceAdapter,
  CreateReconciliationCaseParams,
  CreateReconciliationCaseResult,
  AppendReconciliationRevisionParams,
  AppendReconciliationRevisionResult,
  SubmitCanonicalPromotionParams,
  CreateContextualPrecedentParams,
} from './contracts';
import {
  assertCanonicalPromotionAuthority,
  assertReconciliationCaseCoherence,
} from './validators';
import {
  CanonicalPromotionAuthorityError,
  StaleReviewPreservationError,
  ReviewIdentityConflictError,
} from './errors';

function normalizeArrayLinks<T extends string>(arr?: readonly T[]): readonly T[] | undefined {
  if (!arr || arr.length === 0) {
    return undefined;
  }
  return [...arr].sort();
}

function areContestedReviewsSemanticallyEquivalent(
  existing: ReviewEvent,
  expected: NonCanonicalReviewEvent
): boolean {
  if (existing.reviewId !== expected.reviewId) return false;
  if (existing.decision !== expected.decision) return false;
  if (!isDeepStrictEqual(existing.actor, expected.actor)) return false;
  if ((existing.targetBaseRevisionId ?? null) !== (expected.targetBaseRevisionId ?? null)) return false;
  if (existing.justification !== expected.justification) return false;
  if (existing.reviewedAt !== expected.reviewedAt) return false;

  const existingObs = normalizeArrayLinks(existing.targetObservationIds);
  const expectedObs = normalizeArrayLinks(expected.targetObservationIds);
  if (!isDeepStrictEqual(existingObs, expectedObs)) return false;

  const existingPrev = normalizeArrayLinks(existing.previousReviewIds);
  const expectedPrev = normalizeArrayLinks(expected.previousReviewIds);
  if (!isDeepStrictEqual(existingPrev, expectedPrev)) return false;

  const existingEv = normalizeArrayLinks(existing.consideredEvidenceIds);
  const expectedEv = normalizeArrayLinks(expected.consideredEvidenceIds);
  if (!isDeepStrictEqual(existingEv, expectedEv)) return false;

  return true;
}

export class ReconciliationCoordinator {
  constructor(
    public readonly observationPersistence: ObservationPersistenceAdapter,
    public readonly reconciliationPersistence: ReconciliationPersistenceAdapter
  ) {}

  /**
   * Submete um ReviewEvent não-canônico (ex: MAX registrando 'divergent', 'awaiting_evidence', 'inconclusive').
   * Se um ator tentar submeter uma revisão canônica sem passar pelo gate de autoridade, rejeita fail-closed.
   */
  async submitReview(review: ReviewEvent): Promise<ReviewEvent> {
    if (review.decision === 'canonical_promoted' || review.decision === 'canonical_reclassified') {
      throw new CanonicalPromotionAuthorityError(
        'CANONICAL_PROMOTION_GATE_REQUIRED',
        `Canonical promotion/reclassification review must be submitted through submitCanonicalPromotion with explicit HumanAuthorizationDecision.`
      );
    }

    return this.observationPersistence.recordNonCanonicalReview(review);
  }

  /**
   * Submete uma promoção ou reclassificação canônica através do gate estrito de autoridade.
   * Rejeita MAX, System e Integration runtime fail-closed antes de qualquer escrita no banco.
   * Exige HumanActor e HumanAuthorizationDecision com veredicto 'authorized'.
   * Se a transação atômica for abortada por conflito de base stale (StaleCanonicalBaseConflictError),
   * preserva a avaliação humana no histórico como ReviewEvent não-canônico com decision 'contested'
   * de forma fail-visible e relança o erro original fail-closed.
   */
  async submitCanonicalPromotion(
    params: SubmitCanonicalPromotionParams
  ): Promise<CommitCanonicalPromotionResult> {
    // 1. Gate de Autoridade Runtime Fail-Closed
    assertCanonicalPromotionAuthority(params.review, params.authorization);

    // 2. Execução Atômica de Promoção Canônica no PostgreSQL
    try {
      return await this.observationPersistence.commitCanonicalPromotion({
        review: params.review,
        projection: params.projection,
        expectedBaseRevisionId: params.expectedBaseRevisionId,
      });
    } catch (err: unknown) {
      if (err instanceof StaleCanonicalBaseConflictError) {
        const expectedContestedReview: NonCanonicalReviewEvent = {
          reviewId: params.review.reviewId,
          actor: params.review.actor,
          decision: 'contested',
          targetObservationIds: params.review.targetObservationIds,
          previousReviewIds: params.review.previousReviewIds,
          consideredEvidenceIds: params.review.consideredEvidenceIds,
          targetBaseRevisionId: params.review.targetBaseRevisionId ?? params.expectedBaseRevisionId,
          justification: params.review.justification,
          reviewedAt: params.review.reviewedAt,
        };

        // Preservação fail-visible da avaliação stale no histórico
        await this.ensureStaleReviewPreserved(expectedContestedReview, err);

        // Se a preservação foi confirmada, relança o StaleCanonicalBaseConflictError original
        throw err;
      }
      throw err;
    }
  }

  private async ensureStaleReviewPreserved(
    expectedReview: NonCanonicalReviewEvent,
    staleError: StaleCanonicalBaseConflictError
  ): Promise<void> {
    let existing: ReviewEvent | null = null;
    try {
      existing = await this.observationPersistence.getReview(expectedReview.reviewId);
    } catch (readErr) {
      throw new StaleReviewPreservationError(
        expectedReview.reviewId,
        staleError,
        'Failed to read pre-existing review state.',
        { cause: readErr }
      );
    }

    if (existing) {
      if (areContestedReviewsSemanticallyEquivalent(existing, expectedReview)) {
        return; // Preservação já confirmada e equivalente
      }
      throw new ReviewIdentityConflictError(
        expectedReview.reviewId,
        'Pre-existing review with same reviewId has divergent semantic payload.'
      );
    }

    // Tentar gravar a review contested
    try {
      await this.observationPersistence.recordNonCanonicalReview(expectedReview);
      return; // Gravado com sucesso
    } catch (insertErr) {
      // Falha no INSERT: pode ser corrida concorrente de retry
      let afterInsert: ReviewEvent | null = null;
      try {
        afterInsert = await this.observationPersistence.getReview(expectedReview.reviewId);
      } catch (readAfterErr) {
        throw new StaleReviewPreservationError(
          expectedReview.reviewId,
          staleError,
          'Failed to verify review persistence after insert failure.',
          { cause: readAfterErr }
        );
      }

      if (afterInsert) {
        if (areContestedReviewsSemanticallyEquivalent(afterInsert, expectedReview)) {
          return; // Concorrência idempotente confirmada
        }
        throw new ReviewIdentityConflictError(
          expectedReview.reviewId,
          'Concurrently inserted review with same reviewId has divergent semantic payload.',
          { cause: insertErr }
        );
      }

      // Continua ausente: falha de preservação real
      throw new StaleReviewPreservationError(
        expectedReview.reviewId,
        staleError,
        'Failed to persist stale review to database.',
        { cause: insertErr }
      );
    }
  }

  /**
   * Cria a primeira versão de um caso de reconciliação.
   */
  async createReconciliationCase(
    params: CreateReconciliationCaseParams
  ): Promise<CreateReconciliationCaseResult> {
    return this.reconciliationPersistence.createReconciliationCase(params);
  }

  /**
   * Adiciona uma nova revisão a um caso de reconciliação existente com verificação de concorrência esperada.
   */
  async appendReconciliationRevision(
    params: AppendReconciliationRevisionParams
  ): Promise<AppendReconciliationRevisionResult> {
    return this.reconciliationPersistence.appendReconciliationRevision(params);
  }

  /**
   * Cria um precedente contextual explicitamente a partir de uma revisão humana.
   * Nunca cria ou modifica PolicyRevision.
   */
  async createContextualPrecedent(
    params: CreateContextualPrecedentParams
  ): Promise<ContextualPrecedent> {
    return this.reconciliationPersistence.recordContextualPrecedent(params.precedent);
  }
}
