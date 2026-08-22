/**
 * NEX+ · Coordenador de Reconciliação, Precedentes & Gates de Autoridade
 * Escopo 0.85 (Bloco 0.85D)
 */

import type {
  ReviewEvent,
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
   */
  async submitCanonicalPromotion(
    params: SubmitCanonicalPromotionParams
  ): Promise<CommitCanonicalPromotionResult> {
    // 1. Gate de Autoridade Runtime Fail-Closed
    assertCanonicalPromotionAuthority(params.review, params.authorization);

    // 2. Execução Atômica de Promoção Canônica no PostgreSQL
    return this.observationPersistence.commitCanonicalPromotion({
      review: params.review,
      projection: params.projection,
      expectedBaseRevisionId: params.expectedBaseRevisionId,
    });
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
