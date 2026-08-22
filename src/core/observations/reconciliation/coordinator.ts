/**
 * NEX+ · Coordenador de Reconciliação, Precedentes & Gates de Autoridade
 * Escopo 0.85 (Bloco 0.85D)
 */

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
import { CanonicalPromotionAuthorityError } from './errors';

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
   * e relança o erro original fail-closed.
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
        // Materializar a avaliação humana como NonCanonicalReviewEvent ('contested') para auditoria histórica
        try {
          const staleContestedReview: NonCanonicalReviewEvent = {
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

          const existingReview = await this.observationPersistence.getReview(params.review.reviewId);
          if (!existingReview) {
            await this.observationPersistence.recordNonCanonicalReview(staleContestedReview);
          }
        } catch {
          // Preservar sempre a propagação do StaleCanonicalBaseConflictError original
        }
        throw err;
      }
      throw err;
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
