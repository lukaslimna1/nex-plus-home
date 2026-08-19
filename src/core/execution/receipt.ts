/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Materializador de Recibos Imutáveis — Escopo 0.5 (Bloco 0.5D)
 *
 * Plano de Autoridade (L0).
 * Recibos são registros materializados (não recalculados dinamicamente).
 * Suporte a recibos com Attempt (execução) e sem Attempt (negações / cancelamentos pré-dispatch).
 */

import type { HumanAuthorizationDecision, PolicyDecision } from '../policy/contracts';

import type {
  DecisionId,
  RouteEvaluationId,
  AttemptId,
  OutcomeAssessment,
  Receipt,
  ReceiptId,
} from './contracts';

/**
 * Materializa um Receipt de execução a partir de um OutcomeAssessment factual.
 * Se o desfecho for 'indeterminate', o recibo preserva estritamente a incerteza
 * e não emite alegações de sucesso factual.
 */
export function materializeExecutionReceipt(params: {
  readonly receiptId: ReceiptId;
  readonly decisionId: DecisionId;
  readonly routeEvaluationId: RouteEvaluationId;
  readonly attemptId: AttemptId;
  readonly outcomeAssessment: OutcomeAssessment;
  readonly safeStructuredFacts?: Readonly<Record<string, unknown>>;
  readonly materializedAt: string;
}): Receipt {
  const {
    receiptId,
    decisionId,
    routeEvaluationId,
    attemptId,
    outcomeAssessment,
    safeStructuredFacts = Object.freeze({}),
    materializedAt,
  } = params;

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
}): Receipt {
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
}): Receipt {
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
}): Receipt {
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
}): Receipt {
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
