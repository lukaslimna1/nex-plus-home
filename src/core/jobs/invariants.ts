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
import {
  isCanonicalUtcInstant,
  validateActor,
  validateContextSubjectRef,
} from '../context/invariants';
import { isValidSessionRef } from '../../auth/session-ref.types';
import { validateMaterialContextPinId } from '../material-context/invariants';

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
 * INV-JOB-SCALAR-01: Asserção de campo string escalar.
 */
export function assertStringField(
  val: unknown,
  fieldName: string,
  jobId?: JobId,
): asserts val is string {
  if (typeof val !== 'string') {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PAYLOAD',
      message: `[Job Lifecycle] Field '${fieldName}' must be a string${jobId ? ` in Job '${jobId}'` : ''}. Received: ${typeof val}`,
      jobId,
    });
  }
}

/**
 * INV-JOB-SCALAR-02: Asserção de campo string não-vazia escalar.
 */
export function assertNonEmptyStringField(
  val: unknown,
  fieldName: string,
  jobId?: JobId,
): asserts val is string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PAYLOAD',
      message: `[Job Lifecycle] Field '${fieldName}' must be a non-empty string${jobId ? ` in Job '${jobId}'` : ''}.`,
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

/**
 * INV-JOB-06: Asserção pura de conformidade do snapshot de JobState com os invariantes do Core C1.
 * Valida modelo estrutural, actor, referências, timestamps monotônicos, attemptLineage sem duplicatas,
 * invariantes específicos por status, terminalidade e regras de inicialização na revisão 1.
 * Fail-closed, sem qualquer normalização destrutiva de strings.
 */
export function assertCanonicalJobState(state: JobState): void {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PAYLOAD',
      message: '[Job Lifecycle] JobState must be a non-null object.',
    });
  }

  assertNonEmptyStringField(state.jobId, 'jobId');
  const jobId = state.jobId;

  const validStatuses: readonly JobStatus[] = [
    'queued',
    'running',
    'waiting',
    'paused',
    'succeeded',
    'failed',
    'cancelled',
  ];
  if (!validStatuses.includes(state.status)) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PAYLOAD',
      message: `[Job Lifecycle] Invalid job status '${String(state.status)}' in Job '${jobId}'.`,
      jobId,
    });
  }

  if (typeof state.revision !== 'number' || !Number.isInteger(state.revision) || state.revision < 1) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PAYLOAD',
      message: `[Job Lifecycle] Revision must be an integer >= 1 in Job '${jobId}'. Received: ${String(state.revision)}`,
      jobId,
    });
  }

  if (!state.actor || typeof state.actor !== 'object') {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PAYLOAD',
      message: `[Job Lifecycle] Actor must be an object in Job '${jobId}'.`,
      jobId,
    });
  }
  try {
    validateActor(state.actor);
  } catch (err: any) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PAYLOAD',
      message: `[Job Lifecycle] Invalid Actor in Job '${jobId}': ${err?.message ?? String(err)}`,
      jobId,
    });
  }

  if (state.userId !== undefined) {
    assertNonEmptyStringField(state.userId, 'userId', jobId);
  }

  if (state.sessionRef !== undefined) {
    if (!isValidSessionRef(state.sessionRef)) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Invalid sessionRef in Job '${jobId}'.`,
        jobId,
      });
    }
  }

  if (state.contextSubjectRef !== undefined) {
    try {
      validateContextSubjectRef(state.contextSubjectRef);
    } catch (err: any) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Invalid contextSubjectRef in Job '${jobId}': ${err?.message ?? String(err)}`,
        jobId,
      });
    }
  }

  if (state.correlationId !== undefined) {
    assertNonEmptyStringField(state.correlationId, 'correlationId', jobId);
  }

  if (state.materialContextPinId !== undefined) {
    try {
      validateMaterialContextPinId(state.materialContextPinId);
    } catch (err: any) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Invalid materialContextPinId in Job '${jobId}': ${err?.message ?? String(err)}`,
        jobId,
      });
    }
  }

  // Timestamps canônicos & Monotonicidade
  assertCanonicalUtcInstant(state.createdAt, 'createdAt', jobId);
  assertCanonicalUtcInstant(state.updatedAt, 'updatedAt', jobId);
  assertMonotonicOrder(state.createdAt, state.updatedAt, 'createdAt', 'updatedAt', jobId);

  if (state.startedAt !== undefined) {
    assertCanonicalUtcInstant(state.startedAt, 'startedAt', jobId);
    assertMonotonicOrder(state.createdAt, state.startedAt, 'createdAt', 'startedAt', jobId);
    assertMonotonicOrder(state.startedAt, state.updatedAt, 'startedAt', 'updatedAt', jobId);
  }

  if (state.finishedAt !== undefined) {
    assertCanonicalUtcInstant(state.finishedAt, 'finishedAt', jobId);
    assertMonotonicOrder(state.createdAt, state.finishedAt, 'createdAt', 'finishedAt', jobId);
  }

  if (state.startedAt !== undefined && state.finishedAt !== undefined) {
    assertMonotonicOrder(state.startedAt, state.finishedAt, 'startedAt', 'finishedAt', jobId);
  }

  // Attempt Lineage
  if (!Array.isArray(state.attemptLineage)) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PAYLOAD',
      message: `[Job Lifecycle] Field 'attemptLineage' must be an array in Job '${jobId}'.`,
      jobId,
    });
  }
  const seenAttempts = new Set<string>();
  for (let idx = 0; idx < state.attemptLineage.length; idx++) {
    const att = state.attemptLineage[idx];
    assertNonEmptyStringField(att, `attemptLineage[${idx}]`, jobId);
    if (seenAttempts.has(att)) {
      throw new JobLifecycleError({
        code: 'JOB_DUPLICATE_ATTEMPT',
        message: `[Job Lifecycle] Duplicate AttemptId '${att}' detected in attemptLineage of Job '${jobId}'.`,
        jobId,
      });
    }
    seenAttempts.add(att);
  }

  // WaitingCause
  if (state.waitingCause !== undefined) {
    assertValidWaitingCause(state.waitingCause, jobId);
    assertMonotonicOrder(state.waitingCause.requestedAt, state.updatedAt, 'waitingCause.requestedAt', 'updatedAt', jobId);
  }

  // Progress
  if (state.progress !== undefined) {
    assertValidProgress(state.progress, jobId);
    assertMonotonicOrder(state.progress.updatedAt, state.updatedAt, 'progress.updatedAt', 'updatedAt', jobId);
  }

  // ControlIntent
  if (state.controlIntent !== undefined) {
    if (state.controlIntent !== 'pause' && state.controlIntent !== 'cancel') {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Invalid controlIntent '${String(state.controlIntent)}' in Job '${jobId}'.`,
        jobId,
      });
    }
  }

  // TerminalReason
  if (state.terminalReason !== undefined) {
    assertStringField(state.terminalReason, 'terminalReason', jobId);
  }

  // REVISION 1 (Seção 8)
  if (state.revision === 1) {
    if (state.status !== 'queued') {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Job at revision 1 must have status 'queued', but found '${state.status}' in Job '${jobId}'.`,
        jobId,
        currentStatus: state.status,
      });
    }
    if (state.updatedAt !== state.createdAt) {
      throw new JobLifecycleError({
        code: 'JOB_TEMPORAL_ORDER_VIOLATION',
        message: `[Job Lifecycle] Job at revision 1 must have updatedAt equal to createdAt in Job '${jobId}'.`,
        jobId,
      });
    }
    if (state.startedAt !== undefined) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Job at revision 1 cannot have startedAt in Job '${jobId}'.`,
        jobId,
      });
    }
    if (state.finishedAt !== undefined) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Job at revision 1 cannot have finishedAt in Job '${jobId}'.`,
        jobId,
      });
    }
    if (state.attemptLineage.length > 0) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Job at revision 1 must have empty attemptLineage in Job '${jobId}'.`,
        jobId,
      });
    }
    if (state.waitingCause !== undefined) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Job at revision 1 cannot have waitingCause in Job '${jobId}'.`,
        jobId,
      });
    }
    if (state.controlIntent !== undefined) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Job at revision 1 cannot have controlIntent in Job '${jobId}'.`,
        jobId,
      });
    }
    if (state.progress !== undefined) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Job at revision 1 cannot have progress in Job '${jobId}'.`,
        jobId,
      });
    }
    if (state.terminalReason !== undefined) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Job at revision 1 cannot have terminalReason in Job '${jobId}'.`,
        jobId,
      });
    }
  }

  // TERMINALIDADE TEMPORAL (Seção 7)
  if (isTerminalStatus(state.status)) {
    if (state.finishedAt === undefined) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Terminal Job '${jobId}' must have finishedAt defined.`,
        jobId,
        currentStatus: state.status,
      });
    }
    if (state.updatedAt !== state.finishedAt) {
      throw new JobLifecycleError({
        code: 'JOB_TEMPORAL_ORDER_VIOLATION',
        message: `[Job Lifecycle] Terminal Job '${jobId}' must have updatedAt strictly equal to finishedAt ('${state.updatedAt}' !== '${state.finishedAt}').`,
        jobId,
        currentStatus: state.status,
      });
    }
    if (state.waitingCause !== undefined) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Terminal Job '${jobId}' cannot have waitingCause.`,
        jobId,
        currentStatus: state.status,
      });
    }
    if (state.controlIntent !== undefined) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Terminal Job '${jobId}' cannot have controlIntent.`,
        jobId,
        currentStatus: state.status,
      });
    }
  }

  // INVARIANTS POR STATUS (Seção 6)
  switch (state.status) {
    case 'queued': {
      if (state.finishedAt !== undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Queued Job '${jobId}' cannot have finishedAt.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.waitingCause !== undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Queued Job '${jobId}' cannot have waitingCause.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.terminalReason !== undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Queued Job '${jobId}' cannot have terminalReason.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.startedAt === undefined) {
        if (state.attemptLineage.length > 0) {
          throw new JobLifecycleError({
            code: 'JOB_INVALID_PAYLOAD',
            message: `[Job Lifecycle] Queued Job '${jobId}' without startedAt must have empty attemptLineage.`,
            jobId,
            currentStatus: state.status,
          });
        }
        if (state.progress !== undefined) {
          throw new JobLifecycleError({
            code: 'JOB_INVALID_PAYLOAD',
            message: `[Job Lifecycle] Queued Job '${jobId}' without startedAt cannot have progress.`,
            jobId,
            currentStatus: state.status,
          });
        }
      }
      break;
    }

    case 'running': {
      if (state.startedAt === undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Running Job '${jobId}' must have startedAt.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.finishedAt !== undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Running Job '${jobId}' cannot have finishedAt.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.waitingCause !== undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Running Job '${jobId}' cannot have waitingCause.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.terminalReason !== undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Running Job '${jobId}' cannot have terminalReason.`,
          jobId,
          currentStatus: state.status,
        });
      }
      break;
    }

    case 'waiting': {
      if (state.startedAt === undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Waiting Job '${jobId}' must have startedAt.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.waitingCause === undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Waiting Job '${jobId}' must have waitingCause.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.finishedAt !== undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Waiting Job '${jobId}' cannot have finishedAt.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.terminalReason !== undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Waiting Job '${jobId}' cannot have terminalReason.`,
          jobId,
          currentStatus: state.status,
        });
      }
      break;
    }

    case 'paused': {
      if (state.finishedAt !== undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Paused Job '${jobId}' cannot have finishedAt.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.terminalReason !== undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Paused Job '${jobId}' cannot have terminalReason.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.controlIntent === 'pause') {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Paused Job '${jobId}' cannot retain controlIntent='pause'.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.waitingCause !== undefined && state.startedAt === undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Paused Job '${jobId}' with waitingCause must have startedAt.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.startedAt === undefined) {
        if (state.attemptLineage.length > 0) {
          throw new JobLifecycleError({
            code: 'JOB_INVALID_PAYLOAD',
            message: `[Job Lifecycle] Unstarted paused Job '${jobId}' must have empty attemptLineage.`,
            jobId,
            currentStatus: state.status,
          });
        }
        if (state.progress !== undefined) {
          throw new JobLifecycleError({
            code: 'JOB_INVALID_PAYLOAD',
            message: `[Job Lifecycle] Unstarted paused Job '${jobId}' cannot have progress.`,
            jobId,
            currentStatus: state.status,
          });
        }
        if (state.waitingCause !== undefined) {
          throw new JobLifecycleError({
            code: 'JOB_INVALID_PAYLOAD',
            message: `[Job Lifecycle] Unstarted paused Job '${jobId}' cannot have waitingCause.`,
            jobId,
            currentStatus: state.status,
          });
        }
      }
      break;
    }

    case 'succeeded': {
      if (state.startedAt === undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Succeeded Job '${jobId}' must have startedAt.`,
          jobId,
          currentStatus: state.status,
        });
      }
      break;
    }

    case 'failed':
    case 'cancelled': {
      if (state.terminalReason === undefined) {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] ${state.status} Job '${jobId}' must have terminalReason.`,
          jobId,
          currentStatus: state.status,
        });
      }
      if (state.startedAt === undefined) {
        if (state.attemptLineage.length > 0) {
          throw new JobLifecycleError({
            code: 'JOB_INVALID_PAYLOAD',
            message: `[Job Lifecycle] Unstarted ${state.status} Job '${jobId}' must have empty attemptLineage.`,
            jobId,
            currentStatus: state.status,
          });
        }
        if (state.progress !== undefined) {
          throw new JobLifecycleError({
            code: 'JOB_INVALID_PAYLOAD',
            message: `[Job Lifecycle] Unstarted ${state.status} Job '${jobId}' cannot have progress.`,
            jobId,
            currentStatus: state.status,
          });
        }
      }
      break;
    }
  }
}
