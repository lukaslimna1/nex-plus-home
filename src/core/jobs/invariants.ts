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
import { isCanonicalUtcInstant } from '../context/invariants';

// ============================================================================
// 1. CÓDIGOS DE ERRO RECONHECÍVEIS & TESTÁVEIS
// ============================================================================

export type JobErrorCode =
  | 'JOB_TERMINAL_IMMUTABLE'
  | 'JOB_INVALID_TRANSITION'
  | 'JOB_DUPLICATE_ATTEMPT'
  | 'JOB_INVALID_WAITING_CAUSE'
  | 'JOB_INVALID_PROGRESS'
  | 'JOB_INVALID_TIMESTAMP'
  | 'JOB_TEMPORAL_ORDER_VIOLATION'
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
 * INV-JOB-TEMPORAL-01: Asserção de formato temporal ISO 8601 UTC estritamente terminado em 'Z'.
 * Reutiliza o validador canônico compartilhado do Core (isCanonicalUtcInstant).
 */
export function assertCanonicalUtcInstant(
  val: unknown,
  fieldName: string,
  jobId?: JobId,
): asserts val is string {
  if (!isCanonicalUtcInstant(val)) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_TIMESTAMP',
      message: `[Job Lifecycle] Field '${fieldName}' must be a valid ISO 8601 UTC instant ending in 'Z'. Received: '${String(val)}'${jobId ? ` in Job '${jobId}'` : ''}.`,
      jobId,
    });
  }
}

/**
 * Converte timestamp canônico já validado para epoch milliseconds (determinístico, sem I/O ou clock atual).
 */
export function parseCanonicalUtcInstant(timestamp: string): number {
  return new Date(timestamp).getTime();
}

/**
 * INV-JOB-TEMPORAL-02: Asserção de ordem monotônica de timestamps já canônicos (laterTimestamp >= earlierTimestamp).
 */
export function assertMonotonicOrder(
  earlierTimestamp: string,
  laterTimestamp: string,
  earlierFieldName: string,
  laterFieldName: string,
  jobId?: JobId,
): void {
  const earlierMs = parseCanonicalUtcInstant(earlierTimestamp);
  const laterMs = parseCanonicalUtcInstant(laterTimestamp);

  if (laterMs < earlierMs) {
    throw new JobLifecycleError({
      code: 'JOB_TEMPORAL_ORDER_VIOLATION',
      message: `[Job Lifecycle] Temporal order violation: '${laterFieldName}' (${laterTimestamp}) cannot be earlier than '${earlierFieldName}' (${earlierTimestamp})${jobId ? ` in Job '${jobId}'` : ''}.`,
      jobId,
    });
  }
}

function assertAllowedKeys(
  candidate: Record<string, unknown>,
  allowedKeys: readonly string[],
  errorCode: JobErrorCode,
  description: string,
  jobId?: JobId,
): void {
  const allowedSet = new Set(allowedKeys);
  for (const key of Object.keys(candidate)) {
    if (!allowedSet.has(key)) {
      throw new JobLifecycleError({
        code: errorCode,
        message: `[Job Lifecycle] ${description} contains forbidden/unexpected property '${key}'${jobId ? ` in Job '${jobId}'` : ''}.`,
        jobId,
      });
    }
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

  const candidate = cause as unknown as Record<string, unknown>;

  if (candidate.kind !== 'human' && candidate.kind !== 'temporal') {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_WAITING_CAUSE',
      message: `[Job Lifecycle] Invalid waiting cause kind in Job '${jobId}'. Expected 'human' or 'temporal'.`,
      jobId,
    });
  }

  if (cause.kind === 'human') {
    assertAllowedKeys(
      candidate,
      ['kind', 'reasonCode', 'description', 'requestedAt', 'deadline'],
      'JOB_INVALID_WAITING_CAUSE',
      'HumanWaitingCause',
      jobId,
    );

    if (typeof cause.reasonCode !== 'string' || cause.reasonCode.trim().length === 0) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_WAITING_CAUSE',
        message: `[Job Lifecycle] Waiting cause must have a non-empty reasonCode in Job '${jobId}'.`,
        jobId,
      });
    }

    assertCanonicalUtcInstant(cause.requestedAt, 'waitingCause.requestedAt', jobId);

    if (cause.description !== undefined && typeof cause.description !== 'string') {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_WAITING_CAUSE',
        message: `[Job Lifecycle] Human waiting cause description must be a string when provided in Job '${jobId}'.`,
        jobId,
      });
    }

    if (cause.deadline !== undefined) {
      assertCanonicalUtcInstant(cause.deadline, 'waitingCause.deadline', jobId);
      assertMonotonicOrder(cause.requestedAt, cause.deadline, 'requestedAt', 'deadline', jobId);
    }
  } else if (cause.kind === 'temporal') {
    assertAllowedKeys(
      candidate,
      ['kind', 'reasonCode', 'resumeAfter', 'requestedAt'],
      'JOB_INVALID_WAITING_CAUSE',
      'TemporalWaitingCause',
      jobId,
    );

    if (typeof cause.reasonCode !== 'string' || cause.reasonCode.trim().length === 0) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_WAITING_CAUSE',
        message: `[Job Lifecycle] Waiting cause must have a non-empty reasonCode in Job '${jobId}'.`,
        jobId,
      });
    }

    assertCanonicalUtcInstant(cause.requestedAt, 'waitingCause.requestedAt', jobId);
    assertCanonicalUtcInstant(cause.resumeAfter, 'waitingCause.resumeAfter', jobId);
    assertMonotonicOrder(cause.requestedAt, cause.resumeAfter, 'requestedAt', 'resumeAfter', jobId);
  }
}

/**
 * INV-JOB-05: Progresso não pode ser negativo; completed e total finitos; se total definido, completed <= total.
 */
export function assertValidProgress(progress: JobProgress, jobId: JobId): void {
  if (!progress || typeof progress !== 'object') {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PROGRESS',
      message: `[Job Lifecycle] Progress must be a valid object in Job '${jobId}'.`,
      jobId,
    });
  }

  const candidate = progress as unknown as Record<string, unknown>;
  assertAllowedKeys(
    candidate,
    ['completed', 'total', 'unit', 'message', 'updatedAt'],
    'JOB_INVALID_PROGRESS',
    'JobProgress',
    jobId,
  );

  if (
    typeof progress.completed !== 'number' ||
    !Number.isFinite(progress.completed) ||
    progress.completed < 0
  ) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PROGRESS',
      message: `[Job Lifecycle] Progress completed must be a non-negative finite number in Job '${jobId}'. Received: ${progress.completed}`,
      jobId,
    });
  }

  if (progress.total !== undefined) {
    if (
      typeof progress.total !== 'number' ||
      !Number.isFinite(progress.total) ||
      progress.total < 0
    ) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PROGRESS',
        message: `[Job Lifecycle] Progress total must be a non-negative finite number when specified in Job '${jobId}'. Received: ${progress.total}`,
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

  if (progress.unit !== undefined && typeof progress.unit !== 'string') {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PROGRESS',
      message: `[Job Lifecycle] Progress unit must be a string when provided in Job '${jobId}'.`,
      jobId,
    });
  }

  if (progress.message !== undefined && typeof progress.message !== 'string') {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PROGRESS',
      message: `[Job Lifecycle] Progress message must be a string when provided in Job '${jobId}'.`,
      jobId,
    });
  }

  assertCanonicalUtcInstant(progress.updatedAt, 'progress.updatedAt', jobId);
}
