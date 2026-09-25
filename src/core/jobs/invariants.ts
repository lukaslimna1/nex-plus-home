/**
 * NEX+ · Job Lifecycle Invariants & Errors
 * Invariantes Puros e Erros Estruturados — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-1)
 */

import type {
  JobId,
  JobStatus,
  JobState,
  JobProgress,
  JobWaitingCause,
} from './contracts';
import type { AttemptId } from '../execution/contracts';

// ============================================================================
// 1. CÓDIGOS DE ERRO RECONHECÍVEIS & TESTÁVEIS
// ============================================================================

export type JobErrorCode =
  | 'JOB_TERMINAL_IMMUTABLE'
  | 'JOB_INVALID_TRANSITION'
  | 'JOB_DUPLICATE_ATTEMPT'
  | 'JOB_INVALID_WAITING_CAUSE'
  | 'JOB_INVALID_PROGRESS'
  | 'JOB_CONTROL_OVERWRITE_FORBIDDEN'
  | 'JOB_ID_MISMATCH'
  | 'JOB_INVALID_PAYLOAD';

export interface JobLifecycleErrorOptions {
  readonly code: JobErrorCode;
  readonly message: string;
  readonly jobId?: JobId;
  readonly currentStatus?: JobStatus;
  readonly targetStatus?: JobStatus;
  readonly attemptedEvent?: string;
}

export class JobLifecycleError extends Error {
  readonly code: JobErrorCode;
  readonly jobId?: JobId;
  readonly currentStatus?: JobStatus;
  readonly targetStatus?: JobStatus;
  readonly attemptedEvent?: string;

  constructor(options: JobLifecycleErrorOptions) {
    super(options.message);
    this.name = 'JobLifecycleError';
    this.code = options.code;
    this.jobId = options.jobId;
    this.currentStatus = options.currentStatus;
    this.targetStatus = options.targetStatus;
    this.attemptedEvent = options.attemptedEvent;
    Object.setPrototypeOf(this, JobLifecycleError.prototype);
  }
}

// ============================================================================
// 2. ASSERÇÕES & INVARIANTES PURAS
// ============================================================================

export function isTerminalStatus(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/**
 * INV-JOB-01: Estado terminal é estritamente irrevogável (no resurrection).
 */
export function assertNotTerminal(state: JobState, attemptedEvent: string): void {
  if (isTerminalStatus(state.status)) {
    throw new JobLifecycleError({
      code: 'JOB_TERMINAL_IMMUTABLE',
      message: `[Job Lifecycle] Cannot apply event '${attemptedEvent}' to Job '${state.jobId}' because it is in terminal status '${state.status}'. Terminal states are immutable and irrevocable.`,
      jobId: state.jobId,
      currentStatus: state.status,
      attemptedEvent,
    });
  }
}

/**
 * INV-JOB-02: Evento deve coincidir com o JobId do estado.
 */
export function assertJobIdMatch(state: JobState, eventJobId: JobId, attemptedEvent: string): void {
  if (state.jobId !== eventJobId) {
    throw new JobLifecycleError({
      code: 'JOB_ID_MISMATCH',
      message: `[Job Lifecycle] JobId mismatch in event '${attemptedEvent}': State has '${state.jobId}' but Event target is '${eventJobId}'.`,
      jobId: state.jobId,
      currentStatus: state.status,
      attemptedEvent,
    });
  }
}

/**
 * INV-JOB-03: Linhagem causal de Attempts não admite duplicidade no mesmo Job.
 */
export function assertUniqueAttempt(
  lineage: readonly AttemptId[],
  attemptId: AttemptId,
  jobId: JobId,
): void {
  if (lineage.includes(attemptId)) {
    throw new JobLifecycleError({
      code: 'JOB_DUPLICATE_ATTEMPT',
      message: `[Job Lifecycle] Duplicate AttemptId '${attemptId}' in Job '${jobId}'. An Attempt can only be correlated once per Job.`,
      jobId,
    });
  }
}

/**
 * INV-JOB-04: Causa de waiting deve ser material, reconhecida e consistente.
 */
export function assertValidWaitingCause(cause: JobWaitingCause, jobId: JobId): void {
  if (!cause || typeof cause !== 'object') {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_WAITING_CAUSE',
      message: `[Job Lifecycle] Waiting cause must be a valid object in Job '${jobId}'.`,
      jobId,
    });
  }

  if (cause.kind !== 'human' && cause.kind !== 'temporal') {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_WAITING_CAUSE',
      message: `[Job Lifecycle] Invalid waiting cause kind in Job '${jobId}'. Expected 'human' or 'temporal'.`,
      jobId,
    });
  }

  if (!cause.reasonCode || typeof cause.reasonCode !== 'string' || cause.reasonCode.trim().length === 0) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_WAITING_CAUSE',
      message: `[Job Lifecycle] Waiting cause must have a non-empty reasonCode in Job '${jobId}'.`,
      jobId,
    });
  }

  if (!cause.requestedAt || typeof cause.requestedAt !== 'string' || cause.requestedAt.trim().length === 0) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_WAITING_CAUSE',
      message: `[Job Lifecycle] Waiting cause must have a valid requestedAt ISO timestamp in Job '${jobId}'.`,
      jobId,
    });
  }

  if (cause.kind === 'temporal') {
    if (!cause.resumeAfter || typeof cause.resumeAfter !== 'string' || cause.resumeAfter.trim().length === 0) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_WAITING_CAUSE',
        message: `[Job Lifecycle] Temporal waiting cause must specify a valid resumeAfter timestamp in Job '${jobId}'.`,
        jobId,
      });
    }
  }
}

/**
 * INV-JOB-05: Progresso não pode ser negativo; se total definido, completed <= total.
 */
export function assertValidProgress(progress: JobProgress, jobId: JobId): void {
  if (!progress || typeof progress !== 'object') {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PROGRESS',
      message: `[Job Lifecycle] Progress must be a valid object in Job '${jobId}'.`,
      jobId,
    });
  }

  if (typeof progress.completed !== 'number' || isNaN(progress.completed) || progress.completed < 0) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PROGRESS',
      message: `[Job Lifecycle] Progress completed must be a non-negative number in Job '${jobId}'. Received: ${progress.completed}`,
      jobId,
    });
  }

  if (progress.total !== undefined) {
    if (typeof progress.total !== 'number' || isNaN(progress.total) || progress.total < 0) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PROGRESS',
        message: `[Job Lifecycle] Progress total must be a non-negative number when specified in Job '${jobId}'. Received: ${progress.total}`,
        jobId,
      });
    }

    if (progress.completed > progress.total) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PROGRESS',
        message: `[Job Lifecycle] Progress completed (${progress.completed}) cannot exceed total (${progress.total}) in Job '${jobId}'.`,
        jobId,
      });
    }
  }

  if (!progress.updatedAt || typeof progress.updatedAt !== 'string' || progress.updatedAt.trim().length === 0) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PROGRESS',
      message: `[Job Lifecycle] Progress updatedAt must be a valid timestamp in Job '${jobId}'.`,
      jobId,
    });
  }
}
