/**
 * NEX+ · Route Eligibility, Selection & Escalation
 * Avaliador de Continuação Pós-Tentativa e Helper de Admissão — Escopo 0.5 (Bloco 0.5E)
 *
 * Plano de Autoridade (L0).
 * Preservação de INV-12 (proibição de retries cegos em mutações indeterminadas)
 * e validação estrita de pinning de contexto material em DispatchAdmission.
 */

import type {
  AttemptCreatedEvent,
  AttemptId,
  AttemptState,
  DecisionId,
  OutcomeAssessment,
} from '../execution/contracts';

import type {
  ContinuationAssessment,
  DecisionMaterialContextId,
  DispatchAdmission,
  HumanEscalation,
  HumanEscalationId,
} from './contracts';

export interface AssessContinuationParams {
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly attempt: AttemptState;
  readonly assessment: OutcomeAssessment;
  readonly isDomainMutating: boolean;
  readonly assessedAt: string;
}

/**
 * Avalia deterministicamente a diretiva de continuação pós-Attempt:
 * 1. confirmed_mutation / confirmed_result -> 'stop'.
 * 2. confirmed_no_mutation -> 'new_route_evaluation_required'.
 * 3. indeterminate mutativa -> 'human_escalation_required' (INV-12: Proibido retry automático).
 * 4. indeterminate não-mutativa -> 'new_route_evaluation_required'.
 */
export function assessContinuationAfterAttempt(params: AssessContinuationParams): ContinuationAssessment {
  const {
    decisionId,
    materialContextId,
    attempt,
    assessment,
    isDomainMutating,
    assessedAt,
  } = params;

  // 0. Correlação Causal Obrigatória
  if (assessment.attemptId !== attempt.attemptId) {
    throw new Error(
      `[L0 Continuation] OutcomeAssessment attemptId '${assessment.attemptId}' does not match AttemptState '${attempt.attemptId}'.`,
    );
  }
  if (attempt.decisionId !== decisionId) {
    throw new Error(
      `[L0 Continuation] AttemptState decisionId '${attempt.decisionId}' does not match DecisionId '${decisionId}'.`,
    );
  }

  if (assessment.verdict === 'confirmed_mutation') {
    return {
      directive: 'stop',
      reasonCode: 'MUTATION_CONFIRMED_STOP',
    };
  }

  if (assessment.verdict === 'confirmed_result') {
    return {
      directive: 'stop',
      reasonCode: 'RESULT_CONFIRMED_STOP',
    };
  }

  if (assessment.verdict === 'confirmed_no_mutation') {
    return {
      directive: 'new_route_evaluation_required',
      reasonCode: 'CONFIRMED_NO_MUTATION_REEVALUATION_ALLOWED',
    };
  }

  // Desfecho indeterminate
  if (isDomainMutating) {
    const escalation: HumanEscalation = {
      escalationId: `esc_indet_${decisionId}` as HumanEscalationId,
      decisionId,
      materialContextId,
      kind: 'indeterminate_mutation',
      reasonCode: 'INDETERMINATE_MUTATION_REQUIRES_HUMAN',
      detail: 'Mutation outcome is indeterminate. Automatic retry or route fallback is strictly prohibited (INV-12).',
      escalatedAt: assessedAt,
    };

    return {
      directive: 'human_escalation_required',
      reasonCode: 'INDETERMINATE_MUTATION_REQUIRES_HUMAN',
      escalation,
    };
  }

  return {
    directive: 'new_route_evaluation_required',
    reasonCode: 'NON_MUTATING_INDETERMINATE_REEVALUATION_ALLOWED',
  };
}

/**
 * Constrói o evento canônico AttemptCreatedEvent a partir de uma DispatchAdmission válida.
 * Rejeita se o contexto material atual divergir do contexto fixado na admissão.
 */
export function buildAttemptCreatedEvent(
  admission: DispatchAdmission,
  attemptId: AttemptId,
  createdAt: string,
  currentMaterialContextId: DecisionMaterialContextId,
): AttemptCreatedEvent {
  if (admission.materialContextId !== currentMaterialContextId) {
    throw new Error(
      `[L0 Admission] DispatchAdmission material context mismatch: admission was issued for '${admission.materialContextId}', but current context is '${currentMaterialContextId}'. Re-evaluation is required.`,
    );
  }

  return {
    type: 'AttemptCreated',
    attemptId,
    decisionId: admission.decisionId,
    routeEvaluationId: admission.routeEvaluationId,
    capabilityRevisionId: admission.capabilityRevisionId,
    bindingRevisionId: admission.bindingRevisionId,
    routeRevisionId: admission.routeRevisionId,
    policyRevisionId: admission.policyRevisionId,
    createdAt,
  };
}
