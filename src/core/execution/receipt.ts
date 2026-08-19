/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Materializador de Recibos Imutáveis — Escopo 0.5 (Bloco 0.5D / Hardening)
 *
 * Plano de Autoridade (L0).
 * Recibos são registros materializados discriminados por kind.
 * Validação causal estrita na materialização de recibos de execução.
 */

import type { HumanAuthorizationDecision, PolicyDecision } from '../policy/contracts';

import type {
  DecisionId,
  RouteEvaluationId,
  AttemptId,
  OutcomeAssessment,
  ReceiptId,
  ExecutionOutcomeReceipt,
  PolicyDenialReceipt,
  AuthorizationDenialReceipt,
  NoEligibleRouteReceipt,
  CancelledReceipt,
} from './contracts';

/**
 * Materializa um Receipt de execução a partir de um OutcomeAssessment factual.
 * Rejeita se o OutcomeAssessment não pertencer ao mesmo AttemptId.
 */
export function materializeExecutionReceipt(params: {
  readonly receiptId: ReceiptId;
  readonly decisionId: DecisionId;
  readonly routeEvaluationId: RouteEvaluationId;
  readonly attemptId: AttemptId;
  readonly outcomeAssessment: OutcomeAssessment;
  readonly safeStructuredFacts?: Readonly<Record<string, unknown>>;
  readonly materializedAt: string;
}): ExecutionOutcomeReceipt {
  const {
    receiptId,
    decisionId,
    routeEvaluationId,
    attemptId,
    outcomeAssessment,
    safeStructuredFacts = Object.freeze({}),
    materializedAt,
  } = params;

  if (outcomeAssessment.attemptId !== attemptId) {
    throw new Error(
      `[L0 Receipt Materializer] OutcomeAssessment '${outcomeAssessment.assessmentId}' belongs to Attempt '${outcomeAssessment.attemptId}' but Receipt requested for Attempt '${attemptId}'.`,
    );
  }

  return {
    receiptId,
    decisionId,
    kind: 'execution_outcome',
    routeEvaluationId,
    attemptId,
    outcomeAssessmentId: outcomeAssessment.assessmentId,
    verdictSummary: outcomeAssessment.verdict,
    reasonCode: outcomeAssessment.reasonCode,
    safeStructuredFacts,
    materializedAt,
  };
}

/**
 * Materializa um Receipt de negação de Policy (sem Attempt criado, preservando INV-09).
 */
export function materializePolicyDenialReceipt(params: {
  readonly receiptId: ReceiptId;
  readonly decisionId: DecisionId;
  readonly policyDecision: PolicyDecision;
  readonly materializedAt: string;
}): PolicyDenialReceipt {
  const { receiptId, decisionId, policyDecision, materializedAt } = params;

  const reason =
    policyDecision.egressAxis.verdict === 'deny'
      ? policyDecision.egressAxis.reasonCode
      : policyDecision.zeroCostAxis.reasonCode;

  return {
    receiptId,
    decisionId,
    kind: 'policy_denial',
    verdictSummary: 'policy_denied',
    reasonCode: reason,
    safeStructuredFacts: Object.freeze({
      policyRevisionId: policyDecision.policyRevisionId,
      egressReason: policyDecision.egressAxis.reasonCode,
      zeroCostReason: policyDecision.zeroCostAxis.reasonCode,
    }),
    materializedAt,
  };
}

/**
 * Materializa um Receipt de negação de Autorização Humana (sem Attempt criado, preservando INV-09).
 */
export function materializeAuthorizationDenialReceipt(params: {
  readonly receiptId: ReceiptId;
  readonly decisionId: DecisionId;
  readonly authDecision: HumanAuthorizationDecision;
  readonly materializedAt: string;
}): AuthorizationDenialReceipt {
  const { receiptId, decisionId, authDecision, materializedAt } = params;

  return {
    receiptId,
    decisionId,
    kind: 'authorization_denial',
    verdictSummary: 'authorization_denied',
    reasonCode: authDecision.reasonCode,
    safeStructuredFacts: Object.freeze({
      actorRef: authDecision.actorRef,
      operation: authDecision.operation,
    }),
    materializedAt,
  };
}

/**
 * Materializa um Receipt de ausência de rota elegível (sem Attempt criado, preservando INV-09).
 */
export function materializeNoEligibleRouteReceipt(params: {
  readonly receiptId: ReceiptId;
  readonly decisionId: DecisionId;
  readonly reasonCode: string;
  readonly materializedAt: string;
}): NoEligibleRouteReceipt {
  const { receiptId, decisionId, reasonCode, materializedAt } = params;

  return {
    receiptId,
    decisionId,
    kind: 'no_eligible_route',
    verdictSummary: 'no_eligible_route',
    reasonCode,
    safeStructuredFacts: Object.freeze({}),
    materializedAt,
  };
}

/**
 * Materializa um Receipt de cancelamento pré-dispatch (sem Attempt criado).
 */
export function materializeCancelledReceipt(params: {
  readonly receiptId: ReceiptId;
  readonly decisionId: DecisionId;
  readonly reasonCode: string;
  readonly materializedAt: string;
}): CancelledReceipt {
  const { receiptId, decisionId, reasonCode, materializedAt } = params;

  return {
    receiptId,
    decisionId,
    kind: 'cancelled',
    verdictSummary: 'cancelled',
    reasonCode,
    safeStructuredFacts: Object.freeze({}),
    materializedAt,
  };
}
