/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Avaliador Determinístico de OutcomeAssessment — Escopo 0.5 (Bloco 0.5D / Hardening)
 *
 * Plano de Autoridade (L0).
 * Technical Success != Factual Effect / Result.
 * Validação de integridade causal de evidências e exigência de garantia estrutural para pré-dispatch.
 */

import type {
  AttemptState,
  ExecutionEvidence,
  OutcomeAssessment,
  OutcomeAssessmentId,
  OutcomeAssessmentVerdict,
} from './contracts';

export interface AssessOutcomeParams {
  readonly assessmentId: OutcomeAssessmentId;
  readonly attempt: AttemptState;
  readonly evidenceList: readonly ExecutionEvidence[];
  readonly isDomainMutating: boolean;
  readonly assessedAt: string;
  readonly supersedesAssessmentId?: OutcomeAssessmentId;
}

/**
 * Avalia deterministicamente o desfecho factual (OutcomeAssessment) de uma tentativa de execução:
 * 1. Rejeita deterministicamente qualquer evidência que pertença a outro Attempt.
 * 2. Para operações não-mutativas:
 *    - result_verified válido -> 'confirmed_result'.
 *    - Sem evidência factual de resultado (mesmo com technical succeeded) -> 'indeterminate' (NON_MUTATING_TECHNICAL_SUCCESS_WITHOUT_RESULT_EVIDENCE).
 * 3. Para operações mutativas:
 *    - Se há conflito entre effect_observed e no_effect_verified -> 'indeterminate'.
 *    - Se há effect_observed -> 'confirmed_mutation'.
 *    - Se há no_effect_verified -> 'confirmed_no_mutation'.
 *    - Se há pre_dispatch_failure COM noSideEffectGuarantee === 'structural' -> 'confirmed_no_mutation'.
 *    - Se há pre_dispatch_failure SEM garantia estrutural -> 'indeterminate'.
 *    - Sucesso técnico isolado sem evidência factual -> 'indeterminate'.
 *    - Falhas pós-dispatch, timeouts e conclusões desconhecidas -> 'indeterminate'.
 */
export function assessOutcome(params: AssessOutcomeParams): OutcomeAssessment {
  const {
    assessmentId,
    attempt,
    evidenceList,
    isDomainMutating,
    assessedAt,
    supersedesAssessmentId,
  } = params;

  // Validação causal rigorosa das evidências
  for (const evidence of evidenceList) {
    if (evidence.attemptId !== attempt.attemptId) {
      throw new Error(
        `[L0 Outcome Assessment] Cross-attempt evidence violation: Evidence '${evidence.evidenceId}' belongs to Attempt '${evidence.attemptId}' but Assessment is for Attempt '${attempt.attemptId}'.`,
      );
    }
  }

  let verdict: OutcomeAssessmentVerdict;
  let reasonCode: string;

  if (!isDomainMutating) {
    const hasResultVerified = evidenceList.some((e) => e.kind === 'result_verified');
    if (hasResultVerified) {
      verdict = 'confirmed_result';
      reasonCode = 'NON_MUTATING_RESULT_VERIFIED';
    } else {
      // Technical success isolado NÃO confirma factual result
      verdict = 'indeterminate';
      reasonCode = 'NON_MUTATING_TECHNICAL_SUCCESS_WITHOUT_RESULT_EVIDENCE';
    }
  } else {
    // Operação mutativa
    const hasEffect = evidenceList.some((e) => e.kind === 'effect_observed');
    const hasNoEffect = evidenceList.some((e) => e.kind === 'no_effect_verified');

    if (hasEffect && hasNoEffect) {
      verdict = 'indeterminate';
      reasonCode = 'MUTATION_EVIDENCE_CONFLICT';
    } else if (hasEffect) {
      verdict = 'confirmed_mutation';
      reasonCode = 'MUTATION_EFFECT_OBSERVED';
    } else if (hasNoEffect) {
      verdict = 'confirmed_no_mutation';
      reasonCode = 'MUTATION_NO_EFFECT_VERIFIED';
    } else {
      const structuralPreDispatchFailure = evidenceList.some(
        (e) => e.kind === 'pre_dispatch_failure' && e.noSideEffectGuarantee === 'structural',
      );
      const rawPreDispatchFailure = evidenceList.some((e) => e.kind === 'pre_dispatch_failure');

      if (structuralPreDispatchFailure && attempt.status !== 'succeeded') {
        verdict = 'confirmed_no_mutation';
        reasonCode = 'PRE_DISPATCH_FAILURE_STRUCTURAL_NO_MUTATION';
      } else if (rawPreDispatchFailure) {
        verdict = 'indeterminate';
        reasonCode = 'PRE_DISPATCH_FAILURE_WITHOUT_STRUCTURAL_GUARANTEE';
      } else if (attempt.status === 'succeeded') {
        verdict = 'indeterminate';
        reasonCode = 'TECHNICAL_SUCCESS_WITHOUT_FACTUAL_EVIDENCE';
      } else if (attempt.status === 'timed_out') {
        verdict = 'indeterminate';
        reasonCode = 'TIMEOUT_POST_DISPATCH_INDETERMINATE';
      } else if (attempt.status === 'failed') {
        verdict = 'indeterminate';
        reasonCode = 'FAILURE_POST_DISPATCH_INDETERMINATE';
      } else {
        verdict = 'indeterminate';
        reasonCode = 'MUTATION_OUTCOME_INDETERMINATE';
      }
    }
  }

  return {
    assessmentId,
    attemptId: attempt.attemptId,
    evidenceRefs: evidenceList.map((e) => e.evidenceId),
    verdict,
    reasonCode,
    supersedesAssessmentId,
    assessedAt,
  };
}
