/**
 * NEX+ · Continuation Checkpoint Invariants & Factory
 * Funções Puras de Validação e Derivação — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-4A)
 *
 * Princípios Fundamentais:
 * 1. Derivação determinística pura: não consulta banco, relógio do sistema ou serviços de rede.
 * 2. Cálculo conservador de mutação (INV-12): qualquer indício de mutação em Capability,
 *    Binding ou Route determina effectiveIsDomainMutating = true.
 * 3. Factory recebe fatos canônicos explícitos e reusa assessContinuationAfterAttempt oficial.
 * 4. Validação e Revalidação estritamente fail-closed.
 */

import type { DomainEffect } from '../../capabilities/contracts';
import { isCanonicalUtcInstant } from '../../context/invariants';
import { assessContinuationAfterAttempt } from '../../evaluation/continuation';
import type { ContinuationDirective } from '../../evaluation/contracts';
import { isTerminalStatus } from '../invariants';
import type {
  CreateJobCheckpointParams,
  DomainEffectBasis,
  JobCheckpoint,
  JobCheckpointId,
  ValidateJobCheckpointParams,
} from './contracts';
import {
  JobCheckpointInvariantError,
  JobCheckpointValidationError,
  type JobCheckpointValidationErrorCode,
} from './errors';

// ============================================================================
// 1. CONSTANTES E HELPERS DE VALIDAÇÃO CANÔNICA
// ============================================================================

export const CANONICAL_JOB_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'waiting',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
]);

export const CANONICAL_TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

export const CANONICAL_ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
  'created',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'unknown_completion',
]);

export const CANONICAL_TERMINAL_ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'unknown_completion',
]);

export const CANONICAL_OUTCOME_VERDICTS: ReadonlySet<string> = new Set([
  'confirmed_mutation',
  'confirmed_no_mutation',
  'confirmed_result',
  'indeterminate',
]);

export const VALID_DOMAIN_EFFECTS: ReadonlySet<string> = new Set(['none', 'may_mutate_domain']);
export const VALID_CONTINUATION_DIRECTIVES: ReadonlySet<string> = new Set([
  'stop',
  'new_route_evaluation_required',
  'human_escalation_required',
]);

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}

function isStrictPositiveInteger(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 1;
}

/**
 * Normaliza um timestamp UTC canônico para o formato padrão fixo YYYY-MM-DDTHH:mm:ss.SSSZ.
 * Exige que a entrada seja um instante UTC canônico terminado em 'Z'.
 */
export function normalizeCanonicalUtcInstant(instant: string): string {
  if (!isCanonicalUtcInstant(instant)) {
    throw new JobCheckpointInvariantError({
      code: 'TIMESTAMP_INVALID',
      message: `[JobCheckpoint] Invalid canonical UTC timestamp: '${instant}'. Must be an ISO 8601 UTC string ending in 'Z'.`,
    });
  }
  return new Date(instant).toISOString();
}

/**
 * Derivação conservadora de mutação de domínio:
 * - false somente quando Capability, Binding e Route forem todos 'none'.
 * - true se qualquer um deles for 'may_mutate_domain'.
 */
export function computeEffectiveDomainMutating(params: {
  readonly capabilityDomainEffect: DomainEffect;
  readonly bindingDomainEffectAttested: DomainEffect;
  readonly routeDomainEffect: DomainEffect;
}): boolean {
  if (
    !VALID_DOMAIN_EFFECTS.has(params.capabilityDomainEffect) ||
    !VALID_DOMAIN_EFFECTS.has(params.bindingDomainEffectAttested) ||
    !VALID_DOMAIN_EFFECTS.has(params.routeDomainEffect)
  ) {
    throw new JobCheckpointInvariantError({
      code: 'DOMAIN_EFFECT_INVALID',
      message: `[JobCheckpoint] Invalid domainEffect value in basis: capability='${params.capabilityDomainEffect}', binding='${params.bindingDomainEffectAttested}', route='${params.routeDomainEffect}'.`,
    });
  }

  return (
    params.capabilityDomainEffect === 'may_mutate_domain' ||
    params.bindingDomainEffectAttested === 'may_mutate_domain' ||
    params.routeDomainEffect === 'may_mutate_domain'
  );
}

// ============================================================================
// 2. FACTORY PURA DE CRIAÇÃO (createJobCheckpoint)
// ============================================================================

export function createJobCheckpoint(params: CreateJobCheckpointParams): JobCheckpoint {
  const {
    checkpointId,
    job,
    jobRevision,
    attempt,
    outcomeAssessment,
    decisionMaterialContextId,
    capabilityRevisionId,
    capabilityDomainEffect,
    bindingRevisionId,
    bindingDomainEffectAttested,
    routeRevisionId,
    routeDomainEffect,
    recordedAt,
  } = params;

  // 1. Identificador
  if (!isNonEmptyString(checkpointId)) {
    throw new JobCheckpointInvariantError({
      code: 'CHECKPOINT_ID_INVALID',
      message: '[JobCheckpoint] CheckpointId must be a non-empty string.',
      checkpointId: String(checkpointId),
    });
  }

  // 2. Validação estrita do Job
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new JobCheckpointInvariantError({
      code: 'JOB_STATUS_INVALID',
      message: '[JobCheckpoint] Job must be a non-null object.',
      checkpointId,
    });
  }
  if (!isNonEmptyString(job.jobId)) {
    throw new JobCheckpointInvariantError({
      code: 'CHECKPOINT_ID_INVALID',
      message: '[JobCheckpoint] job.jobId must be a non-empty string.',
      checkpointId,
    });
  }
  if (typeof job.status !== 'string' || !CANONICAL_JOB_STATUSES.has(job.status)) {
    throw new JobCheckpointInvariantError({
      code: 'JOB_STATUS_INVALID',
      message: `[JobCheckpoint] Invalid job.status '${String(job.status)}'. Must be one of canonical JobStatus values.`,
      checkpointId,
    });
  }
  if (CANONICAL_TERMINAL_JOB_STATUSES.has(job.status)) {
    throw new JobCheckpointInvariantError({
      code: 'JOB_TERMINAL_INVALID',
      message: `[JobCheckpoint] Cannot create checkpoint for Job '${job.jobId}' in terminal status '${job.status}'.`,
      checkpointId,
    });
  }
  if (!isStrictPositiveInteger(job.revision)) {
    throw new JobCheckpointInvariantError({
      code: 'JOB_REVISION_INVALID',
      message: `[JobCheckpoint] job.revision must be a safe integer >= 1, received '${job.revision}'.`,
      checkpointId,
    });
  }
  if (!Array.isArray(job.attemptLineage)) {
    throw new JobCheckpointInvariantError({
      code: 'ATTEMPT_NOT_IN_LINEAGE',
      message: `[JobCheckpoint] job.attemptLineage must be an array.`,
      checkpointId,
    });
  }
  for (const linId of job.attemptLineage) {
    if (!isNonEmptyString(linId)) {
      throw new JobCheckpointInvariantError({
        code: 'ATTEMPT_NOT_IN_LINEAGE',
        message: `[JobCheckpoint] job.attemptLineage contains invalid or empty attemptId: '${String(linId)}'.`,
        checkpointId,
      });
    }
  }

  // 3. Revisão do Job
  if (!isStrictPositiveInteger(jobRevision)) {
    throw new JobCheckpointInvariantError({
      code: 'JOB_REVISION_INVALID',
      message: `[JobCheckpoint] jobRevision must be a safe integer >= 1, received '${jobRevision}'.`,
      checkpointId,
    });
  }
  if (jobRevision !== job.revision) {
    throw new JobCheckpointInvariantError({
      code: 'JOB_REVISION_MISMATCH',
      message: `[JobCheckpoint] jobRevision '${jobRevision}' does not match job.revision '${job.revision}'.`,
      checkpointId,
    });
  }

  // 4. Validação estrita do Attempt
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    throw new JobCheckpointInvariantError({
      code: 'ATTEMPT_STATUS_INVALID',
      message: '[JobCheckpoint] Attempt must be a non-null object.',
      checkpointId,
    });
  }
  if (!isNonEmptyString(attempt.attemptId)) {
    throw new JobCheckpointInvariantError({
      code: 'ATTEMPT_NOT_TERMINAL',
      message: '[JobCheckpoint] attempt.attemptId must be a non-empty string.',
      checkpointId,
    });
  }
  if (!isNonEmptyString(attempt.decisionId)) {
    throw new JobCheckpointInvariantError({
      code: 'DECISION_MATERIAL_CONTEXT_INVALID',
      message: '[JobCheckpoint] attempt.decisionId must be a non-empty string.',
      checkpointId,
    });
  }
  if (!isNonEmptyString(attempt.routeEvaluationId)) {
    throw new JobCheckpointInvariantError({
      code: 'ROUTE_REVISION_MISMATCH',
      message: '[JobCheckpoint] attempt.routeEvaluationId must be a non-empty string.',
      checkpointId,
    });
  }
  if (!isNonEmptyString(attempt.capabilityRevisionId)) {
    throw new JobCheckpointInvariantError({
      code: 'CAPABILITY_REVISION_MISMATCH',
      message: '[JobCheckpoint] attempt.capabilityRevisionId must be a non-empty string.',
      checkpointId,
    });
  }
  if (!isNonEmptyString(attempt.bindingRevisionId)) {
    throw new JobCheckpointInvariantError({
      code: 'BINDING_REVISION_MISMATCH',
      message: '[JobCheckpoint] attempt.bindingRevisionId must be a non-empty string.',
      checkpointId,
    });
  }
  if (!isNonEmptyString(attempt.routeRevisionId)) {
    throw new JobCheckpointInvariantError({
      code: 'ROUTE_REVISION_MISMATCH',
      message: '[JobCheckpoint] attempt.routeRevisionId must be a non-empty string.',
      checkpointId,
    });
  }

  if (typeof attempt.status !== 'string' || !CANONICAL_ATTEMPT_STATUSES.has(attempt.status)) {
    throw new JobCheckpointInvariantError({
      code: 'ATTEMPT_STATUS_INVALID',
      message: `[JobCheckpoint] Invalid attempt.status '${String(attempt.status)}'. Must be one of canonical AttemptStatus values.`,
      checkpointId,
    });
  }

  // Attempt deve estar em estado terminal permitido
  if (!CANONICAL_TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
    throw new JobCheckpointInvariantError({
      code: 'ATTEMPT_NOT_TERMINAL',
      message: `[JobCheckpoint] Attempt '${attempt.attemptId}' is not terminal (current status: '${attempt.status}').`,
      checkpointId,
    });
  }

  // 5. Attempt pertence à lineage do Job e é o último
  if (!job.attemptLineage.includes(attempt.attemptId)) {
    throw new JobCheckpointInvariantError({
      code: 'ATTEMPT_NOT_IN_LINEAGE',
      message: `[JobCheckpoint] Attempt '${attempt.attemptId}' is not in job '${job.jobId}' attemptLineage.`,
      checkpointId,
    });
  }
  const lastAttemptId = job.attemptLineage[job.attemptLineage.length - 1];
  if (lastAttemptId !== attempt.attemptId) {
    throw new JobCheckpointInvariantError({
      code: 'ATTEMPT_NOT_LATEST',
      message: `[JobCheckpoint] Attempt '${attempt.attemptId}' is not the latest attempt in job '${job.jobId}' lineage (latest: '${lastAttemptId}').`,
      checkpointId,
    });
  }

  // 6. Validação estrita do OutcomeAssessment
  if (!outcomeAssessment || typeof outcomeAssessment !== 'object' || Array.isArray(outcomeAssessment)) {
    throw new JobCheckpointInvariantError({
      code: 'OUTCOME_ASSESSMENT_VERDICT_INVALID',
      message: '[JobCheckpoint] OutcomeAssessment must be a non-null object.',
      checkpointId,
    });
  }
  if (!isNonEmptyString(outcomeAssessment.assessmentId)) {
    throw new JobCheckpointInvariantError({
      code: 'OUTCOME_ASSESSMENT_ATTEMPT_MISMATCH',
      message: '[JobCheckpoint] outcomeAssessment.assessmentId must be a non-empty string.',
      checkpointId,
    });
  }
  if (!isNonEmptyString(outcomeAssessment.attemptId)) {
    throw new JobCheckpointInvariantError({
      code: 'OUTCOME_ASSESSMENT_ATTEMPT_MISMATCH',
      message: '[JobCheckpoint] outcomeAssessment.attemptId must be a non-empty string.',
      checkpointId,
    });
  }
  if (outcomeAssessment.attemptId !== attempt.attemptId) {
    throw new JobCheckpointInvariantError({
      code: 'OUTCOME_ASSESSMENT_ATTEMPT_MISMATCH',
      message: `[JobCheckpoint] OutcomeAssessment attemptId '${outcomeAssessment.attemptId}' does not match attempt.attemptId '${attempt.attemptId}'.`,
      checkpointId,
    });
  }
  if (!isNonEmptyString(outcomeAssessment.reasonCode)) {
    throw new JobCheckpointInvariantError({
      code: 'OUTCOME_ASSESSMENT_VERDICT_INVALID',
      message: '[JobCheckpoint] outcomeAssessment.reasonCode must be a non-empty string.',
      checkpointId,
    });
  }
  if (typeof outcomeAssessment.verdict !== 'string' || !CANONICAL_OUTCOME_VERDICTS.has(outcomeAssessment.verdict)) {
    throw new JobCheckpointInvariantError({
      code: 'OUTCOME_ASSESSMENT_VERDICT_INVALID',
      message: `[JobCheckpoint] Invalid outcomeAssessment.verdict '${String(outcomeAssessment.verdict)}'. Must be one of canonical OutcomeAssessmentVerdict values.`,
      checkpointId,
    });
  }

  // 7. Revisions fornecidas devem ser strings não-vazias e coincidir com o Attempt
  if (!isNonEmptyString(capabilityRevisionId)) {
    throw new JobCheckpointInvariantError({
      code: 'CAPABILITY_REVISION_MISMATCH',
      message: '[JobCheckpoint] capabilityRevisionId must be a non-empty string.',
      checkpointId,
    });
  }
  if (capabilityRevisionId !== attempt.capabilityRevisionId) {
    throw new JobCheckpointInvariantError({
      code: 'CAPABILITY_REVISION_MISMATCH',
      message: `[JobCheckpoint] capabilityRevisionId '${capabilityRevisionId}' does not match attempt '${attempt.capabilityRevisionId}'.`,
      checkpointId,
    });
  }

  if (!isNonEmptyString(bindingRevisionId)) {
    throw new JobCheckpointInvariantError({
      code: 'BINDING_REVISION_MISMATCH',
      message: '[JobCheckpoint] bindingRevisionId must be a non-empty string.',
      checkpointId,
    });
  }
  if (bindingRevisionId !== attempt.bindingRevisionId) {
    throw new JobCheckpointInvariantError({
      code: 'BINDING_REVISION_MISMATCH',
      message: `[JobCheckpoint] bindingRevisionId '${bindingRevisionId}' does not match attempt '${attempt.bindingRevisionId}'.`,
      checkpointId,
    });
  }

  if (!isNonEmptyString(routeRevisionId)) {
    throw new JobCheckpointInvariantError({
      code: 'ROUTE_REVISION_MISMATCH',
      message: '[JobCheckpoint] routeRevisionId must be a non-empty string.',
      checkpointId,
    });
  }
  if (routeRevisionId !== attempt.routeRevisionId) {
    throw new JobCheckpointInvariantError({
      code: 'ROUTE_REVISION_MISMATCH',
      message: `[JobCheckpoint] routeRevisionId '${routeRevisionId}' does not match attempt '${attempt.routeRevisionId}'.`,
      checkpointId,
    });
  }

  // 8. DecisionMaterialContextId
  if (!isNonEmptyString(decisionMaterialContextId)) {
    throw new JobCheckpointInvariantError({
      code: 'DECISION_MATERIAL_CONTEXT_INVALID',
      message: '[JobCheckpoint] decisionMaterialContextId must be a non-empty string.',
      checkpointId,
    });
  }

  // 9. Timestamp UTC canônico com normalização determinística fixa
  if (!isCanonicalUtcInstant(recordedAt)) {
    throw new JobCheckpointInvariantError({
      code: 'TIMESTAMP_INVALID',
      message: `[JobCheckpoint] recordedAt must be a canonical ISO 8601 UTC string ending in 'Z', received '${recordedAt}'.`,
      checkpointId,
    });
  }
  const normalizedRecordedAt = normalizeCanonicalUtcInstant(recordedAt);

  // 10. Cálculo de DomainEffectBasis
  const effectiveIsDomainMutating = computeEffectiveDomainMutating({
    capabilityDomainEffect,
    bindingDomainEffectAttested,
    routeDomainEffect,
  });

  const domainEffectBasis: DomainEffectBasis = Object.freeze({
    capabilityRevisionId,
    capabilityDomainEffect,
    bindingRevisionId,
    bindingDomainEffectAttested,
    routeRevisionId,
    routeDomainEffect,
    effectiveIsDomainMutating,
  });

  // 11. Avaliação canônica de continuação via L0 evaluation
  const continuation = assessContinuationAfterAttempt({
    decisionId: attempt.decisionId,
    materialContextId: decisionMaterialContextId,
    attempt,
    assessment: outcomeAssessment,
    isDomainMutating: effectiveIsDomainMutating,
    assessedAt: normalizedRecordedAt,
  });

  return Object.freeze({
    checkpointId,
    jobId: job.jobId,
    jobRevision,
    attemptId: attempt.attemptId,
    outcomeAssessmentId: outcomeAssessment.assessmentId,
    decisionMaterialContextId,
    domainEffectBasis,
    continuationDirective: continuation.directive,
    continuationReasonCode: continuation.reasonCode,
    recordedAt: normalizedRecordedAt,
  });
}

// ============================================================================
// 3. REVALIDAÇÃO PURA (validateJobCheckpoint / assertJobCheckpointValid)
// ============================================================================

export interface CheckpointValidationResult {
  readonly valid: boolean;
  readonly code?: JobCheckpointValidationErrorCode;
  readonly reason?: string;
}

export function validateJobCheckpoint(params: ValidateJobCheckpointParams): CheckpointValidationResult {
  const { checkpoint, job, attempt, latestOutcomeAssessment } = params;

  // 1. Validação estrutural prévia fail-closed do próprio Checkpoint
  try {
    assertCanonicalJobCheckpoint(checkpoint);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      code: 'STRUCTURAL_VALIDATION_FAILED',
      reason: `Checkpoint failed structural validation: ${msg}`,
    };
  }

  // 2. Validação defensiva de runtime facts de Job, Attempt e Outcome
  if (
    !job ||
    typeof job !== 'object' ||
    Array.isArray(job) ||
    !isNonEmptyString(job.jobId) ||
    !isStrictPositiveInteger(job.revision) ||
    !Array.isArray(job.attemptLineage) ||
    typeof job.status !== 'string' ||
    !CANONICAL_JOB_STATUSES.has(job.status)
  ) {
    return {
      valid: false,
      code: 'INVALID_RUNTIME_FACTS',
      reason: 'Job state contains invalid or non-canonical runtime facts.',
    };
  }

  if (
    !attempt ||
    typeof attempt !== 'object' ||
    Array.isArray(attempt) ||
    !isNonEmptyString(attempt.attemptId) ||
    !isNonEmptyString(attempt.decisionId) ||
    !isNonEmptyString(attempt.routeEvaluationId) ||
    !isNonEmptyString(attempt.capabilityRevisionId) ||
    !isNonEmptyString(attempt.bindingRevisionId) ||
    !isNonEmptyString(attempt.routeRevisionId) ||
    typeof attempt.status !== 'string' ||
    !CANONICAL_ATTEMPT_STATUSES.has(attempt.status)
  ) {
    return {
      valid: false,
      code: 'INVALID_RUNTIME_FACTS',
      reason: 'Attempt state contains invalid or non-canonical runtime facts.',
    };
  }

  if (
    !latestOutcomeAssessment ||
    typeof latestOutcomeAssessment !== 'object' ||
    Array.isArray(latestOutcomeAssessment) ||
    !isNonEmptyString(latestOutcomeAssessment.assessmentId) ||
    !isNonEmptyString(latestOutcomeAssessment.attemptId) ||
    !isNonEmptyString(latestOutcomeAssessment.reasonCode) ||
    typeof latestOutcomeAssessment.verdict !== 'string' ||
    !CANONICAL_OUTCOME_VERDICTS.has(latestOutcomeAssessment.verdict)
  ) {
    return {
      valid: false,
      code: 'INVALID_RUNTIME_FACTS',
      reason: 'OutcomeAssessment contains invalid or non-canonical runtime facts.',
    };
  }

  // 3. Checkpoint deve pertencer ao mesmo Job
  if (checkpoint.jobId !== job.jobId) {
    return {
      valid: false,
      code: 'JOB_ID_MISMATCH',
      reason: `JobId mismatch: Checkpoint belongs to Job '${checkpoint.jobId}' but validation target is Job '${job.jobId}'.`,
    };
  }

  // 4. Job não pode estar terminal
  if (CANONICAL_TERMINAL_JOB_STATUSES.has(job.status)) {
    return {
      valid: false,
      code: 'JOB_IS_TERMINAL',
      reason: `Job '${job.jobId}' is in terminal status '${job.status}'.`,
    };
  }

  // 5. jobRevision coincide
  if (job.revision !== checkpoint.jobRevision) {
    return {
      valid: false,
      code: 'JOB_REVISION_MISMATCH',
      reason: `Job revision mismatch: Job has revision '${job.revision}' but Checkpoint was created for revision '${checkpoint.jobRevision}'.`,
    };
  }

  // 6. AttemptId coincide
  if (attempt.attemptId !== checkpoint.attemptId) {
    return {
      valid: false,
      code: 'ATTEMPT_ID_MISMATCH',
      reason: `Attempt mismatch: Attempt has id '${attempt.attemptId}' but Checkpoint was created for '${checkpoint.attemptId}'.`,
    };
  }

  // 7. Attempt deve ser o último da lineage (nenhum Attempt posterior)
  if (job.attemptLineage.length === 0 || job.attemptLineage[job.attemptLineage.length - 1] !== checkpoint.attemptId) {
    return {
      valid: false,
      code: 'ATTEMPT_NOT_LATEST_IN_LINEAGE',
      reason: `Attempt '${checkpoint.attemptId}' is no longer the latest attempt in Job '${job.jobId}' lineage.`,
    };
  }

  // 8. Attempt deve estar terminal
  if (!CANONICAL_TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
    return {
      valid: false,
      code: 'ATTEMPT_NOT_TERMINAL',
      reason: `Attempt '${attempt.attemptId}' is not terminal (current status: '${attempt.status}').`,
    };
  }

  // 9. OutcomeAssessment coincide com o checkpoint (não pode ter sido superseded)
  if (latestOutcomeAssessment.assessmentId !== checkpoint.outcomeAssessmentId) {
    return {
      valid: false,
      code: 'OUTCOME_ASSESSMENT_SUPERSEDED',
      reason: `OutcomeAssessment has been superseded: Latest is '${latestOutcomeAssessment.assessmentId}', but Checkpoint was created for '${checkpoint.outcomeAssessmentId}'.`,
    };
  }

  // 10. Latest Outcome pertence ao mesmo Attempt
  if (latestOutcomeAssessment.attemptId !== attempt.attemptId) {
    return {
      valid: false,
      code: 'OUTCOME_ASSESSMENT_ATTEMPT_MISMATCH',
      reason: `OutcomeAssessment attemptId '${latestOutcomeAssessment.attemptId}' does not match Attempt '${attempt.attemptId}'.`,
    };
  }

  // 11. Revisions do Attempt coincidem com a DomainEffectBasis
  if (checkpoint.domainEffectBasis.capabilityRevisionId !== attempt.capabilityRevisionId) {
    return {
      valid: false,
      code: 'CAPABILITY_REVISION_MISMATCH',
      reason: `DomainEffectBasis capabilityRevisionId '${checkpoint.domainEffectBasis.capabilityRevisionId}' does not match Attempt '${attempt.capabilityRevisionId}'.`,
    };
  }
  if (checkpoint.domainEffectBasis.bindingRevisionId !== attempt.bindingRevisionId) {
    return {
      valid: false,
      code: 'BINDING_REVISION_MISMATCH',
      reason: `DomainEffectBasis bindingRevisionId '${checkpoint.domainEffectBasis.bindingRevisionId}' does not match Attempt '${attempt.bindingRevisionId}'.`,
    };
  }
  if (checkpoint.domainEffectBasis.routeRevisionId !== attempt.routeRevisionId) {
    return {
      valid: false,
      code: 'ROUTE_REVISION_MISMATCH',
      reason: `DomainEffectBasis routeRevisionId '${checkpoint.domainEffectBasis.routeRevisionId}' does not match Attempt '${attempt.routeRevisionId}'.`,
    };
  }

  // 12. Integridade de DomainEffectBasis (effectiveIsDomainMutating deve ser fiel aos 3 effects)
  const expectedMutating = computeEffectiveDomainMutating({
    capabilityDomainEffect: checkpoint.domainEffectBasis.capabilityDomainEffect,
    bindingDomainEffectAttested: checkpoint.domainEffectBasis.bindingDomainEffectAttested,
    routeDomainEffect: checkpoint.domainEffectBasis.routeDomainEffect,
  });
  if (expectedMutating !== checkpoint.domainEffectBasis.effectiveIsDomainMutating) {
    return {
      valid: false,
      code: 'CORRUPTED_DOMAIN_EFFECT_BASIS',
      reason: `DomainEffectBasis effectiveIsDomainMutating mismatch: expected '${expectedMutating}', found '${checkpoint.domainEffectBasis.effectiveIsDomainMutating}'.`,
    };
  }

  // 13. Recomputação determinística via assessContinuationAfterAttempt
  const recomputed = assessContinuationAfterAttempt({
    decisionId: attempt.decisionId,
    materialContextId: checkpoint.decisionMaterialContextId,
    attempt,
    assessment: latestOutcomeAssessment,
    isDomainMutating: checkpoint.domainEffectBasis.effectiveIsDomainMutating,
    assessedAt: checkpoint.recordedAt,
  });

  if (
    recomputed.directive !== checkpoint.continuationDirective ||
    recomputed.reasonCode !== checkpoint.continuationReasonCode
  ) {
    return {
      valid: false,
      code: 'CONTINUATION_DIRECTIVE_RECOMPUTATION_MISMATCH',
      reason: `Continuation directive/reasonCode recomputation mismatch: recomputed { directive: '${recomputed.directive}', reason: '${recomputed.reasonCode}' } vs checkpoint { directive: '${checkpoint.continuationDirective}', reason: '${checkpoint.continuationReasonCode}' }.`,
    };
  }

  return { valid: true };
}

export function assertJobCheckpointValid(params: ValidateJobCheckpointParams): void {
  const result = validateJobCheckpoint(params);
  if (!result.valid) {
    throw new JobCheckpointValidationError({
      code: result.code ?? 'CONTINUATION_DIRECTIVE_RECOMPUTATION_MISMATCH',
      message: `[JobCheckpoint] Checkpoint '${params.checkpoint?.checkpointId}' is invalid: ${result.reason}`,
      checkpointId: params.checkpoint?.checkpointId ?? 'unknown',
    });
  }
}

// ============================================================================
// 4. ASSERÇÃO ESTRUTURAL DE CHECKPOINT (Boundary Guard)
// ============================================================================

const REQUIRED_CHECKPOINT_KEYS = [
  'checkpointId',
  'jobId',
  'jobRevision',
  'attemptId',
  'outcomeAssessmentId',
  'decisionMaterialContextId',
  'domainEffectBasis',
  'continuationDirective',
  'continuationReasonCode',
  'recordedAt',
] as const;
const CANONICAL_CHECKPOINT_KEYS: ReadonlySet<string> = new Set(REQUIRED_CHECKPOINT_KEYS);

const REQUIRED_BASIS_KEYS = [
  'capabilityRevisionId',
  'capabilityDomainEffect',
  'bindingRevisionId',
  'bindingDomainEffectAttested',
  'routeRevisionId',
  'routeDomainEffect',
  'effectiveIsDomainMutating',
] as const;
const CANONICAL_BASIS_KEYS: ReadonlySet<string> = new Set(REQUIRED_BASIS_KEYS);

export function assertCanonicalJobCheckpoint(checkpoint: unknown): asserts checkpoint is JobCheckpoint {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    throw new JobCheckpointInvariantError({
      code: 'CHECKPOINT_ID_INVALID',
      message: '[JobCheckpoint] Checkpoint must be a non-null object.',
    });
  }

  const cp = checkpoint as Record<string, unknown>;

  // Checagem de propriedades próprias obrigatórias
  for (const key of REQUIRED_CHECKPOINT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(cp, key)) {
      throw new JobCheckpointInvariantError({
        code: 'CHECKPOINT_ID_INVALID',
        message: `[JobCheckpoint] Missing required own property '${key}'.`,
        checkpointId: typeof cp.checkpointId === 'string' ? cp.checkpointId : undefined,
      });
    }
  }

  // Rejeição de propriedades inesperadas (allowlist estrita)
  for (const key of Object.keys(cp)) {
    if (!CANONICAL_CHECKPOINT_KEYS.has(key)) {
      throw new JobCheckpointInvariantError({
        code: 'EXTRA_FIELDS_DETECTED',
        message: `[JobCheckpoint] Unexpected own property '${key}' found on checkpoint object.`,
        checkpointId: typeof cp.checkpointId === 'string' ? cp.checkpointId : undefined,
      });
    }
  }

  if (typeof cp.checkpointId !== 'string' || cp.checkpointId.trim().length === 0) {
    throw new JobCheckpointInvariantError({
      code: 'CHECKPOINT_ID_INVALID',
      message: '[JobCheckpoint] checkpointId must be a non-empty string.',
    });
  }

  if (typeof cp.jobId !== 'string' || cp.jobId.trim().length === 0) {
    throw new JobCheckpointInvariantError({
      code: 'CHECKPOINT_ID_INVALID',
      message: '[JobCheckpoint] jobId must be a non-empty string.',
      checkpointId: cp.checkpointId,
    });
  }

  if (typeof cp.jobRevision !== 'number' || !Number.isSafeInteger(cp.jobRevision) || cp.jobRevision < 1) {
    throw new JobCheckpointInvariantError({
      code: 'JOB_REVISION_INVALID',
      message: `[JobCheckpoint] jobRevision must be a safe integer >= 1, received '${cp.jobRevision}'.`,
      checkpointId: cp.checkpointId,
    });
  }

  if (typeof cp.attemptId !== 'string' || cp.attemptId.trim().length === 0) {
    throw new JobCheckpointInvariantError({
      code: 'CHECKPOINT_ID_INVALID',
      message: '[JobCheckpoint] attemptId must be a non-empty string.',
      checkpointId: cp.checkpointId,
    });
  }

  if (typeof cp.outcomeAssessmentId !== 'string' || cp.outcomeAssessmentId.trim().length === 0) {
    throw new JobCheckpointInvariantError({
      code: 'CHECKPOINT_ID_INVALID',
      message: '[JobCheckpoint] outcomeAssessmentId must be a non-empty string.',
      checkpointId: cp.checkpointId,
    });
  }

  if (typeof cp.decisionMaterialContextId !== 'string' || cp.decisionMaterialContextId.trim().length === 0) {
    throw new JobCheckpointInvariantError({
      code: 'DECISION_MATERIAL_CONTEXT_INVALID',
      message: '[JobCheckpoint] decisionMaterialContextId must be a non-empty string.',
      checkpointId: cp.checkpointId,
    });
  }

  if (typeof cp.continuationDirective !== 'string' || !VALID_CONTINUATION_DIRECTIVES.has(cp.continuationDirective)) {
    throw new JobCheckpointInvariantError({
      code: 'CHECKPOINT_ID_INVALID',
      message: `[JobCheckpoint] continuationDirective must be one of 'stop', 'new_route_evaluation_required', 'human_escalation_required', received '${cp.continuationDirective}'.`,
      checkpointId: cp.checkpointId,
    });
  }

  if (typeof cp.continuationReasonCode !== 'string' || cp.continuationReasonCode.trim().length === 0) {
    throw new JobCheckpointInvariantError({
      code: 'CHECKPOINT_ID_INVALID',
      message: '[JobCheckpoint] continuationReasonCode must be a non-empty string.',
      checkpointId: cp.checkpointId,
    });
  }

  // Canonical UTC ending in 'Z' with exactly 3 millisecond digits
  if (
    typeof cp.recordedAt !== 'string' ||
    !isCanonicalUtcInstant(cp.recordedAt) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cp.recordedAt)
  ) {
    throw new JobCheckpointInvariantError({
      code: 'TIMESTAMP_INVALID',
      message: `[JobCheckpoint] recordedAt must be a canonical ISO 8601 UTC string with 3 millisecond digits (YYYY-MM-DDTHH:mm:ss.SSSZ), received '${cp.recordedAt}'.`,
      checkpointId: cp.checkpointId,
    });
  }

  const basis = cp.domainEffectBasis as Record<string, unknown> | undefined;
  if (!basis || typeof basis !== 'object' || Array.isArray(basis)) {
    throw new JobCheckpointInvariantError({
      code: 'DOMAIN_EFFECT_INVALID',
      message: '[JobCheckpoint] domainEffectBasis must be a non-null object.',
      checkpointId: cp.checkpointId,
    });
  }

  for (const key of REQUIRED_BASIS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(basis, key)) {
      throw new JobCheckpointInvariantError({
        code: 'DOMAIN_EFFECT_INVALID',
        message: `[JobCheckpoint] Missing required own property '${key}' in domainEffectBasis.`,
        checkpointId: cp.checkpointId,
      });
    }
  }

  for (const key of Object.keys(basis)) {
    if (!CANONICAL_BASIS_KEYS.has(key)) {
      throw new JobCheckpointInvariantError({
        code: 'EXTRA_FIELDS_DETECTED',
        message: `[JobCheckpoint] Unexpected own property '${key}' found on domainEffectBasis.`,
        checkpointId: cp.checkpointId,
      });
    }
  }

  if (
    typeof basis.capabilityRevisionId !== 'string' ||
    basis.capabilityRevisionId.trim().length === 0 ||
    typeof basis.bindingRevisionId !== 'string' ||
    basis.bindingRevisionId.trim().length === 0 ||
    typeof basis.routeRevisionId !== 'string' ||
    basis.routeRevisionId.trim().length === 0
  ) {
    throw new JobCheckpointInvariantError({
      code: 'DOMAIN_EFFECT_INVALID',
      message: '[JobCheckpoint] domainEffectBasis revision IDs must be non-empty strings.',
      checkpointId: cp.checkpointId,
    });
  }

  if (
    typeof basis.capabilityDomainEffect !== 'string' ||
    !VALID_DOMAIN_EFFECTS.has(basis.capabilityDomainEffect) ||
    typeof basis.bindingDomainEffectAttested !== 'string' ||
    !VALID_DOMAIN_EFFECTS.has(basis.bindingDomainEffectAttested) ||
    typeof basis.routeDomainEffect !== 'string' ||
    !VALID_DOMAIN_EFFECTS.has(basis.routeDomainEffect)
  ) {
    throw new JobCheckpointInvariantError({
      code: 'DOMAIN_EFFECT_INVALID',
      message: '[JobCheckpoint] domainEffectBasis contains invalid DomainEffect values.',
      checkpointId: cp.checkpointId,
    });
  }

  if (typeof basis.effectiveIsDomainMutating !== 'boolean') {
    throw new JobCheckpointInvariantError({
      code: 'DOMAIN_EFFECT_INVALID',
      message: '[JobCheckpoint] domainEffectBasis.effectiveIsDomainMutating must be a boolean.',
      checkpointId: cp.checkpointId,
    });
  }
}
