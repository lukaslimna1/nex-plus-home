/**
 * NEX+ · Contratos da Camada de Persistência de Observações & Projeções
 * Escopo 0.85 (Bloco 0.85B)
 */

import type {
  ObservationRecord,
  ObservationRecordId,
  ObservationSubject,
  ReviewEvent,
  ReviewEventId,
  NonCanonicalReviewEvent,
  CanonicalPromotedReviewEvent,
  CanonicalReclassifiedReviewEvent,
  CanonicalProjection,
  CanonicalProjectionRevisionId,
} from '../contracts';

export interface IdempotencyKeyParams {
  readonly scope: string;
  readonly key: string;
}

export interface RecordObservationResult {
  readonly record: ObservationRecord;
  readonly deduplicated: boolean;
}

export interface CommitCanonicalPromotionParams {
  readonly review: CanonicalPromotedReviewEvent | CanonicalReclassifiedReviewEvent;
  readonly projection: CanonicalProjection;
  readonly expectedBaseRevisionId?: CanonicalProjectionRevisionId;
}

export interface CanonicalHeadInfo {
  readonly subject: ObservationSubject;
  readonly currentProjectionRevisionId: CanonicalProjectionRevisionId;
  readonly version: bigint;
  readonly updatedAt: string; // ISO 8601 UTC ('Z')
}

export interface CommitCanonicalPromotionResult {
  readonly review: ReviewEvent;
  readonly projection: CanonicalProjection;
  readonly head: CanonicalHeadInfo;
}

export interface ObservationPersistenceAdapter {
  /**
   * Persiste uma ObservationRecord no histórico append-only.
   * Suporta chave opcional de idempotência. Se já inserida com a mesma chave e ID,
   * retorna a observação existente com `deduplicated: true`. Se houver chave idêntica
   * com ID diferente, lança `IdempotencyConflictError`.
   */
  recordObservation(
    record: ObservationRecord,
    idempotency?: IdempotencyKeyParams
  ): Promise<RecordObservationResult>;

  /**
   * Obtém uma ObservationRecord pelo seu ID.
   */
  getObservation(observationId: ObservationRecordId): Promise<ObservationRecord | null>;

  /**
   * Lista o histórico completo de observações para um dado subject ordenado por observedAt.
   */
  listObservationsBySubject(subject: ObservationSubject): Promise<readonly ObservationRecord[]>;

  /**
   * Registra um ReviewEvent não-canônico (ex: provisional, corroborated, contested, divergent).
   */
  recordNonCanonicalReview(review: NonCanonicalReviewEvent): Promise<ReviewEvent>;

  /**
   * Obtém um ReviewEvent pelo seu ID.
   */
  getReview(reviewId: ReviewEventId): Promise<ReviewEvent | null>;

  /**
   * Transação atômica que registra um ReviewEvent canônico (promote ou reclassify),
   * persiste a nova CanonicalProjectionRevision e atualiza a CanonicalProjectionHead,
   * verificando concorrência otimista contra a base esperada (`expectedBaseRevisionId`).
   */
  commitCanonicalPromotion(
    params: CommitCanonicalPromotionParams
  ): Promise<CommitCanonicalPromotionResult>;

  /**
   * Obtém uma revisão histórica de CanonicalProjection pelo ID da revisão.
   */
  getCanonicalProjectionRevision(
    revisionId: CanonicalProjectionRevisionId
  ): Promise<CanonicalProjection | null>;

  /**
   * Obtém a projeção canônica atualmente vigente para um dado subject.
   */
  getCurrentCanonicalProjection(subject: ObservationSubject): Promise<CanonicalProjection | null>;

  /**
   * Obtém as informações operacionais da head canônica atual para um subject.
   */
  getCurrentCanonicalHead(subject: ObservationSubject): Promise<CanonicalHeadInfo | null>;
}
