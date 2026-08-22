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
  DispatchAdmissionId,
  HumanEscalation,
  HumanEscalationId,
} from './contracts';

import { claimAdmissionForAttempt } from './admission-authority';

export interface AssessContinuationParams {
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly attempt: AttemptState;
  readonly assessment: OutcomeAssessment;
  readonly isDomainMutating: boolean;
  readonly assessedAt: string;
}

export interface BuildAttemptCreatedEventParams {
  readonly admissionId: DispatchAdmissionId;
  readonly attemptId: AttemptId;
  readonly createdAt: string;
  readonly currentMaterialContextId: DecisionMaterialContextId;
  readonly effectiveOperation?: string;
  readonly effectiveResourceTarget?: string;
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
 * Constrói o evento canônico AttemptCreatedEvent através do claim de uma DispatchAdmission canônica.
 *
 * PROPRIEDADES DE AUTORIDADE DE L0 (Passagem 2 - Correção Final):
 * 1. Somente o fluxo interno de evaluateDecision() emite DispatchAdmission.
 * 2. O consumer/caller NÃO pode fabricar ou registrar admissions arbitrárias.
 * 3. O claim é síncrono, atômico e estritamente SINGLE-USE: uma admission só pode ser consumida uma vez.
 * 4. Validações de materialContextId, effectiveOperation e effectiveResourceTarget não queimam token em falha.
 * 5. Todas as referências (decisionId, routeEvaluationId, capabilityRevisionId, bindingRevisionId,
 *    routeRevisionId, policyRevisionId) derivam exclusivamente da admissão canônica registrada.
 */
export function buildAttemptCreatedEvent(
  params: BuildAttemptCreatedEventParams,
): AttemptCreatedEvent {
  if (!params || typeof params !== 'object') {
    throw new Error('[L0 Admission] BuildAttemptCreatedEventParams is required.');
  }

  const {
    admissionId,
    attemptId,
    createdAt,
    currentMaterialContextId,
    effectiveOperation,
    effectiveResourceTarget,
  } = params;

  if (!admissionId || !attemptId || !createdAt || !currentMaterialContextId) {
    throw new Error(
      '[L0 Admission] admissionId, attemptId, createdAt, and currentMaterialContextId are required.',
    );
  }

  // 1. Claim atômico e síncrono no runtime interno (validações de escopo e marcação de consumo single-use)
  const canonicalAdmission = claimAdmissionForAttempt({
    admissionId,
    attemptId,
    currentMaterialContextId,
    effectiveOperation,
    effectiveResourceTarget,
  });

  // 2. Derivar AttemptCreatedEvent SOMENTE da Admission Canônica
  return {
    type: 'AttemptCreated',
    attemptId,
    decisionId: canonicalAdmission.decisionId,
    routeEvaluationId: canonicalAdmission.routeEvaluationId,
    capabilityRevisionId: canonicalAdmission.capabilityRevisionId,
    bindingRevisionId: canonicalAdmission.bindingRevisionId,
    routeRevisionId: canonicalAdmission.routeRevisionId,
    policyRevisionId: canonicalAdmission.policyRevisionId,
    createdAt,
  };
}
