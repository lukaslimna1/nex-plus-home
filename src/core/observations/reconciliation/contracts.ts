/**
 * NEX+ · Contratos da Camada de Reconciliação & Precedentes Contextuais
 * Escopo 0.85 (Bloco 0.85D)
 */

import type {
  ReconciliationCase,
  ReconciliationCaseId,
  ReconciliationLifecycle,
  ReconciliationStatus,
  ObservationSubject,
  ContextualPrecedent,
  ContextualPrecedentRefId,
  ReviewEvent,
  ReviewEventId,
  CanonicalPromotedReviewEvent,
  CanonicalReclassifiedReviewEvent,
  CanonicalProjection,
  CanonicalProjectionRevisionId,
} from '../contracts';
import type { CommitCanonicalPromotionResult } from '../persistence/contracts';
import type { HumanAuthorizationDecision } from '../../policy/contracts';

export interface ReconciliationHeadInfo {
  readonly caseId: ReconciliationCaseId;
  readonly currentVersion: number;
  readonly subject: ObservationSubject;
  readonly lifecycle: ReconciliationLifecycle;
  readonly status: ReconciliationStatus;
  readonly updatedAt: string; // ISO 8601 UTC ('Z')
}

export interface CreateReconciliationCaseParams {
  readonly case: ReconciliationCase;
}

export interface AppendReconciliationRevisionParams {
  readonly case: ReconciliationCase;
  readonly expectedVersion: number;
}

export interface CreateReconciliationCaseResult {
  readonly case: ReconciliationCase;
  readonly head: ReconciliationHeadInfo;
}

export interface AppendReconciliationRevisionResult {
  readonly case: ReconciliationCase;
  readonly head: ReconciliationHeadInfo;
}

export interface ReconciliationPersistenceAdapter {
  /**
   * Registra a primeira versão de um ReconciliationCase (versão 1).
   * Se o caseId já existir com payload exatamente igual, retorna a versão existente (idempotência estrita).
   * Se já existir com payload divergente, lança `ReconciliationCaseConflictError`.
   */
  createReconciliationCase(
    params: CreateReconciliationCaseParams
  ): Promise<CreateReconciliationCaseResult>;

  /**
   * Adiciona uma nova revisão a um caso existente, exigindo que a versão atual coincida com `expectedVersion`.
   * A versão anterior é estritamente preservada (append-only) e a head é atualizada atomicamente.
   * Se a versão atual divergir de `expectedVersion`, lança `StaleReconciliationVersionConflictError`.
   */
  appendReconciliationRevision(
    params: AppendReconciliationRevisionParams
  ): Promise<AppendReconciliationRevisionResult>;

  /**
   * Obtém a revisão mais recente (head) de um caso.
   */
  getCurrentReconciliationCase(caseId: ReconciliationCaseId): Promise<ReconciliationCase | null>;

  /**
   * Obtém as informações da head operacional de um caso.
   */
  getCurrentReconciliationHead(caseId: ReconciliationCaseId): Promise<ReconciliationHeadInfo | null>;

  /**
   * Lista todas as revisões históricas de um caso em ordem crescente de versão.
   */
  listReconciliationHistory(caseId: ReconciliationCaseId): Promise<readonly ReconciliationCase[]>;

  /**
   * Persiste um ContextualPrecedent de forma estritamente append-only.
   * Exige que o reviewId pertença a um ReviewEvent de ator humano existente.
   * Idempotente para payloads idênticos; lança `ContextualPrecedentConflictError` para payloads divergentes.
   */
  recordContextualPrecedent(precedent: ContextualPrecedent): Promise<ContextualPrecedent>;

  /**
   * Obtém um ContextualPrecedent pelo seu ID.
   */
  getContextualPrecedent(precedentId: ContextualPrecedentRefId): Promise<ContextualPrecedent | null>;

  /**
   * Lista precedentes vinculados a uma dada revisão.
   */
  listContextualPrecedentsByReview(reviewId: ReviewEventId): Promise<readonly ContextualPrecedent[]>;
}

export interface SubmitCanonicalPromotionParams {
  readonly review: CanonicalPromotedReviewEvent | CanonicalReclassifiedReviewEvent;
  readonly projection: CanonicalProjection;
  readonly expectedBaseRevisionId?: CanonicalProjectionRevisionId;
  readonly authorization: HumanAuthorizationDecision;
}

export interface CreateContextualPrecedentParams {
  readonly precedent: ContextualPrecedent;
  readonly authorization?: HumanAuthorizationDecision;
}
