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
  DispatchAdmissionId,
  HumanEscalation,
  HumanEscalationId,
} from './contracts';

import {
  DispatchAdmissionAuthority,
  defaultDispatchAdmissionAuthority,
  DispatchAdmissionNotFoundError,
} from './admission-authority';

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
  readonly admissionAuthority?: DispatchAdmissionAuthority;
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
 * Constrói o evento canônico AttemptCreatedEvent a partir da DispatchAdmission canônica.
 *
 * PROPRIEDADE DE AUTORIDADE DE L0 (Blocker J):
 * A admission é resolvida estritamente por admissionId a partir da DispatchAdmissionAuthority.
 * Clones ou objetos arbitrários fornecidos pelo caller são ignorados; todas as referências
 * de execução (decisionId, routeEvaluationId, capabilityRevisionId, bindingRevisionId,
 * routeRevisionId, policyRevisionId) derivam exclusivamente da admissão canônica registrada.
 *
 * Validações fail-closed:
 * 1. admissionId deve existir na autoridade runtime (caso contrário lança DispatchAdmissionNotFoundError).
 * 2. materialContextId deve coincidir exatamente com currentMaterialContextId.
 * 3. Se admission.authorizationScope possuir operation, effectiveOperation deve coincidir exatamente.
 * 4. Se admission.authorizationScope possuir resourceTarget, effectiveResourceTarget deve coincidir exatamente.
 */
export function buildAttemptCreatedEvent(
  paramsOrAdmission: BuildAttemptCreatedEventParams | DispatchAdmission | DispatchAdmissionId,
  maybeAttemptId?: AttemptId,
  maybeCreatedAt?: string,
  maybeCurrentMaterialContextId?: DecisionMaterialContextId,
  maybeEffectiveOperation?: string,
  maybeEffectiveResourceTarget?: string,
  maybeAuthority?: DispatchAdmissionAuthority,
): AttemptCreatedEvent {
  let admissionId: DispatchAdmissionId;
  let attemptId: AttemptId;
  let createdAt: string;
  let currentMaterialContextId: DecisionMaterialContextId;
  let effectiveOperation: string | undefined;
  let effectiveResourceTarget: string | undefined;
  let authority: DispatchAdmissionAuthority;

  if (
    typeof paramsOrAdmission === 'object' &&
    paramsOrAdmission !== null &&
    'attemptId' in paramsOrAdmission &&
    'currentMaterialContextId' in paramsOrAdmission
  ) {
    const p = paramsOrAdmission as BuildAttemptCreatedEventParams;
    admissionId = p.admissionId;
    attemptId = p.attemptId;
    createdAt = p.createdAt;
    currentMaterialContextId = p.currentMaterialContextId;
    effectiveOperation = p.effectiveOperation;
    effectiveResourceTarget = p.effectiveResourceTarget;
    authority = p.admissionAuthority ?? defaultDispatchAdmissionAuthority;
  } else {
    if (typeof paramsOrAdmission === 'string') {
      admissionId = paramsOrAdmission as DispatchAdmissionId;
    } else if (
      typeof paramsOrAdmission === 'object' &&
      paramsOrAdmission !== null &&
      'admissionId' in paramsOrAdmission
    ) {
      admissionId = (paramsOrAdmission as DispatchAdmission).admissionId;
    } else {
      throw new Error('[L0 Admission] Invalid admission parameter.');
    }

    attemptId = maybeAttemptId!;
    createdAt = maybeCreatedAt!;
    currentMaterialContextId = maybeCurrentMaterialContextId!;
    effectiveOperation = maybeEffectiveOperation;
    effectiveResourceTarget = maybeEffectiveResourceTarget;
    authority = maybeAuthority ?? defaultDispatchAdmissionAuthority;
  }

  if (!admissionId) {
    throw new Error('[L0 Admission] admissionId is required to resolve DispatchAdmission.');
  }

  // 1. Resolver Admission estritamente na Autoridade Runtime
  const canonicalAdmission = authority.getAdmission(admissionId);
  if (!canonicalAdmission) {
    throw new DispatchAdmissionNotFoundError(admissionId);
  }

  // 2. Validação de Contexto Material
  if (canonicalAdmission.materialContextId !== currentMaterialContextId) {
    throw new Error(
      `[L0 Admission] DispatchAdmission material context mismatch: admission was issued for '${canonicalAdmission.materialContextId}', but current context is '${currentMaterialContextId}'. Re-evaluation is required.`,
    );
  }

  // 3. Validação de Operação Efetiva (se escopo de autorização presente)
  if (canonicalAdmission.authorizationScope?.operation) {
    if (!effectiveOperation || effectiveOperation !== canonicalAdmission.authorizationScope.operation) {
      throw new Error(
        `[L0 Admission] Operation mismatch: admission was authorized for operation '${canonicalAdmission.authorizationScope.operation}', but attempt requested '${effectiveOperation ?? 'none'}'.`,
      );
    }
  }

  // 4. Validação de ResourceTarget Efetivo (se presente no escopo autorizado)
  if (canonicalAdmission.authorizationScope?.resourceTarget !== undefined) {
    if (effectiveResourceTarget !== canonicalAdmission.authorizationScope.resourceTarget) {
      throw new Error(
        `[L0 Admission] ResourceTarget mismatch: admission was authorized for resourceTarget '${canonicalAdmission.authorizationScope.resourceTarget}', but attempt requested '${effectiveResourceTarget ?? 'none'}'.`,
      );
    }
  }

  // 5. Derivar AttemptCreatedEvent SOMENTE da Admission Canônica
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
