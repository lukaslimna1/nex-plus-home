/**
 * NEX+ · Job Lifecycle Core
 * Mappers Defensivos & Trust Boundary de Persistência — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2B)
 *
 * Plano de Autoridade (L0).
 * Validação rigorosa (fail-closed) de todos os dados trafegados entre o domínio e o PostgreSQL.
 * Trust boundary de escrita: seleção estrita por allowlist descartando tokens, segredos e extras.
 * Trust boundary de leitura: tudo do banco é untrusted e defensivamente validado.
 */

import type {
  JobId,
  JobStatus,
  JobActiveStatus,
  JobTerminalStatus,
  JobState,
  JobEvent,
  JobEventType,
  CreateJobParams,
  JobWaitingCause,
  HumanWaitingCause,
  TemporalWaitingCause,
  JobControlIntent,
  JobProgress,
} from '../contracts';

import type {
  JobRecordKind,
  JobStoredRecord,
} from './contracts';

import type { Actor } from '../../observations/contracts';
import type { ContextSubjectRef } from '../../context/contracts';
import { isCanonicalUtcInstant, validateActor, validateContextSubjectRef } from '../../context/invariants';
import { isValidSessionRef } from '../../../auth/session-ref.types';
import { validateMaterialContextPinId } from '../../material-context/invariants';
import {
  assertCanonicalJobState,
  assertValidProgress,
  assertValidWaitingCause,
} from '../invariants';
import { CorruptedJobStorageError, JobRehydrationDivergenceError } from './errors';

// ============================================================================
// 1. HELPERS DEFENSIVOS DE IMUTABILIDADE E SEGURANÇA DE OBJETOS
// ============================================================================

export function deepCloneAndFreeze<T>(val: T): Readonly<T> {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    const copy = val.map((item) => deepCloneAndFreeze(item));
    return Object.freeze(copy) as unknown as Readonly<T>;
  }
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val)) {
    Object.defineProperty(copy, k, {
      value: deepCloneAndFreeze(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(copy) as unknown as Readonly<T>;
}

export function formatPgTimestampToUtcInstant(
  val: unknown,
  table: string,
  fieldName: string,
  jobId?: string,
): string {
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) {
      throw new CorruptedJobStorageError(table, `Field '${fieldName}' contains invalid Date object.`, jobId);
    }
    return val.toISOString();
  }
  if (typeof val === 'string') {
    if (isCanonicalUtcInstant(val)) {
      return new Date(val).toISOString();
    }
    throw new CorruptedJobStorageError(
      table,
      `Field '${fieldName}' contains non-canonical or invalid UTC timestamp string '${val}'.`,
      jobId,
    );
  }
  throw new CorruptedJobStorageError(
    table,
    `Field '${fieldName}' contains invalid timestamp value '${String(val)}'.`,
    jobId,
  );
}

export function assertPlainObject(
  val: unknown,
  table: string,
  fieldName: string,
  jobId?: string,
): Readonly<Record<string, unknown>> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new CorruptedJobStorageError(
      table,
      `Field '${fieldName}' must be a non-null plain JSON object. Received: ${Array.isArray(val) ? 'array' : typeof val}`,
      jobId,
    );
  }
  const proto = Object.getPrototypeOf(val);
  if (proto !== Object.prototype && proto !== null) {
    const protoName = (val as any)?.constructor?.name ?? 'unknown';
    throw new CorruptedJobStorageError(
      table,
      `Field '${fieldName}' must be a non-null plain JSON object. Received non-plain object or class instance (${protoName}).`,
      jobId,
    );
  }
  return deepCloneAndFreeze(val as Record<string, unknown>);
}

export function assertNonEmptyString(
  val: unknown,
  table: string,
  fieldName: string,
  jobId?: string,
): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new CorruptedJobStorageError(table, `Field '${fieldName}' must be a non-empty string.`, jobId);
  }
  return val;
}

export function assertString(
  val: unknown,
  table: string,
  fieldName: string,
  jobId?: string,
): string {
  if (typeof val !== 'string') {
    throw new CorruptedJobStorageError(table, `Field '${fieldName}' must be a string.`, jobId);
  }
  return val;
}

export function assertInteger(
  val: unknown,
  table: string,
  fieldName: string,
  min: number = 0,
  jobId?: string,
): number {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < min) {
    throw new CorruptedJobStorageError(
      table,
      `Field '${fieldName}' must be an integer >= ${min}. Received: ${String(val)}`,
      jobId,
    );
  }
  return val;
}

const VALID_JOB_STATUSES = new Set<string>([
  'queued',
  'running',
  'waiting',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
]);

const VALID_CONTROL_INTENTS = new Set<string>(['pause', 'cancel']);

// ============================================================================
// 2. SANITIZAÇÃO E SERIALIZAÇÃO (TRUST BOUNDARY DE ESCRITA)
// ============================================================================

export function sanitizeActor(actor: Actor): Actor {
  switch (actor.kind) {
    case 'human':
      return Object.freeze({
        kind: 'human',
        humanId: actor.humanId,
        ...(actor.role !== undefined ? { role: actor.role } : {}),
        ...(actor.authorityRef !== undefined ? { authorityRef: actor.authorityRef } : {}),
      });
    case 'max':
      return Object.freeze({
        kind: 'max',
        maxVersion: actor.maxVersion,
        ...(actor.sessionRef !== undefined ? { sessionRef: actor.sessionRef } : {}),
      });
    case 'system':
      return Object.freeze({
        kind: 'system',
        component: actor.component,
        ...(actor.version !== undefined ? { version: actor.version } : {}),
      });
    case 'integration':
      return Object.freeze({
        kind: 'integration',
        provider: actor.provider,
        ...(actor.integrationId !== undefined ? { integrationId: actor.integrationId } : {}),
      });
  }
}

export function sanitizeContextSubjectRef(ref: ContextSubjectRef): ContextSubjectRef {
  return Object.freeze({
    subjectType: ref.subjectType,
    subjectId: ref.subjectId,
  });
}

export function sanitizeWaitingCause(cause: JobWaitingCause): JobWaitingCause {
  if (cause.kind === 'human') {
    return Object.freeze({
      kind: 'human',
      reasonCode: cause.reasonCode,
      ...(cause.description !== undefined ? { description: cause.description } : {}),
      requestedAt: cause.requestedAt,
      ...(cause.deadline !== undefined ? { deadline: cause.deadline } : {}),
    });
  }
  return Object.freeze({
    kind: 'temporal',
    reasonCode: cause.reasonCode,
    resumeAfter: cause.resumeAfter,
    requestedAt: cause.requestedAt,
  });
}

export function sanitizeProgress(progress: JobProgress): JobProgress {
  return Object.freeze({
    completed: progress.completed,
    ...(progress.total !== undefined ? { total: progress.total } : {}),
    ...(progress.unit !== undefined ? { unit: progress.unit } : {}),
    ...(progress.message !== undefined ? { message: progress.message } : {}),
    updatedAt: progress.updatedAt,
  });
}

/**
 * Constrói explicitamente o payload canônico para o registro de criação (revision 1)
 * a partir do JobState inicial validado pelo Core (initialJob).
 * Extrai somente os campos canônicos necessários para reconstruir CreateJobParams no replay,
 * descartando revision, status, runtime extras e segredos.
 */
export function serializeCreationParamsFromJobState(job: JobState): Record<string, unknown> {
  const result: Record<string, unknown> = {
    jobId: job.jobId,
    actor: sanitizeActor(job.actor),
    createdAt: job.createdAt,
  };

  if (job.userId !== undefined) {
    result.userId = job.userId;
  }
  if (job.sessionRef !== undefined) {
    result.sessionRef = job.sessionRef;
  }
  if (job.contextSubjectRef !== undefined) {
    result.contextSubjectRef = sanitizeContextSubjectRef(job.contextSubjectRef);
  }
  if (job.correlationId !== undefined) {
    result.correlationId = job.correlationId;
  }
  if (job.materialContextPinId !== undefined) {
    result.materialContextPinId = job.materialContextPinId;
  }

  return deepCloneAndFreeze(result) as unknown as Record<string, unknown>;
}

/**
 * Constrói explicitamente o payload canônico para o registro de criação (revision 1)
 * selecionando somente os campos canônicos permitidos de CreateJobParams.
 * Descarta tokens, segredos ou propriedades de runtime inesperadas.
 * Preserva as strings originais validadas pelo Core sem aplicar trim.
 */
export function serializeCreateJobParams(params: CreateJobParams): Record<string, unknown> {
  const result: Record<string, unknown> = {
    jobId: params.jobId,
    actor: sanitizeActor(params.actor),
    createdAt: params.createdAt,
  };

  if (params.userId !== undefined) {
    result.userId = params.userId;
  }
  if (params.sessionRef !== undefined) {
    result.sessionRef = params.sessionRef;
  }
  if (params.contextSubjectRef !== undefined) {
    result.contextSubjectRef = sanitizeContextSubjectRef(params.contextSubjectRef);
  }
  if (params.correlationId !== undefined) {
    result.correlationId = params.correlationId;
  }
  if (params.materialContextPinId !== undefined) {
    result.materialContextPinId = params.materialContextPinId;
  }

  return deepCloneAndFreeze(result) as unknown as Record<string, unknown>;
}

/**
 * Serializa um JobEvent usando allowlist estrita baseada na discriminated union.
 * Descarta quaisquer propriedades extras injetadas no evento.
 */
export function serializeJobEvent(event: JobEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: event.type,
    jobId: event.jobId,
  };

  switch (event.type) {
    case 'JobStarted':
      if (event.attemptId !== undefined) base.attemptId = event.attemptId;
      base.startedAt = event.startedAt;
      break;

    case 'JobAttemptCorrelated':
      base.attemptId = event.attemptId;
      base.correlatedAt = event.correlatedAt;
      break;

    case 'JobWaiting':
      base.cause = sanitizeWaitingCause(event.cause);
      base.transitionedAt = event.transitionedAt;
      break;

    case 'JobYieldedWaiting':
      base.resumedAt = event.resumedAt;
      break;

    case 'JobControlRequested':
      base.intent = event.intent;
      base.requestedAt = event.requestedAt;
      break;

    case 'JobPaused':
      base.pausedAt = event.pausedAt;
      break;

    case 'JobResumed':
      base.resumedAt = event.resumedAt;
      break;

    case 'JobProgressUpdated':
      base.progress = sanitizeProgress(event.progress);
      break;

    case 'JobSucceeded':
      base.finishedAt = event.finishedAt;
      if (event.terminalReason !== undefined) base.terminalReason = event.terminalReason;
      break;

    case 'JobFailed':
      base.finishedAt = event.finishedAt;
      base.reasonCode = event.reasonCode;
      if (event.terminalReason !== undefined) base.terminalReason = event.terminalReason;
      break;

    case 'JobCancelled':
      base.finishedAt = event.finishedAt;
      if (event.reasonCode !== undefined) base.reasonCode = event.reasonCode;
      if (event.terminalReason !== undefined) base.terminalReason = event.terminalReason;
      break;
  }

  return deepCloneAndFreeze(base) as unknown as Record<string, unknown>;
}

/**
 * Extrai o timestamp canônico UTC de ocorrência de um JobEvent.
 */
export function extractEventOccurredAt(event: JobEvent): string {
  switch (event.type) {
    case 'JobStarted':
      return event.startedAt;
    case 'JobAttemptCorrelated':
      return event.correlatedAt;
    case 'JobWaiting':
      return event.transitionedAt;
    case 'JobYieldedWaiting':
      return event.resumedAt;
    case 'JobControlRequested':
      return event.requestedAt;
    case 'JobPaused':
      return event.pausedAt;
    case 'JobResumed':
      return event.resumedAt;
    case 'JobProgressUpdated':
      return event.progress.updatedAt;
    case 'JobSucceeded':
    case 'JobFailed':
    case 'JobCancelled':
      return event.finishedAt;
    default:
      throw new CorruptedJobStorageError(
        'nex_job_events',
        `Unknown event type '${(event as { type: string }).type}'.`,
      );
  }
}

/**
 * Serializa o JobState completo para a projeção de nex_job_heads.state_payload.
 */
export function serializeJobState(state: JobState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    jobId: state.jobId,
    status: state.status,
    revision: state.revision,
    actor: sanitizeActor(state.actor),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    attemptLineage: [...state.attemptLineage],
  };

  if (state.userId !== undefined) payload.userId = state.userId;
  if (state.sessionRef !== undefined) payload.sessionRef = state.sessionRef;
  if (state.contextSubjectRef !== undefined) payload.contextSubjectRef = sanitizeContextSubjectRef(state.contextSubjectRef);
  if (state.correlationId !== undefined) payload.correlationId = state.correlationId;
  if (state.materialContextPinId !== undefined) payload.materialContextPinId = state.materialContextPinId;
  if (state.startedAt !== undefined) payload.startedAt = state.startedAt;
  if (state.finishedAt !== undefined) payload.finishedAt = state.finishedAt;
  if (state.waitingCause !== undefined) payload.waitingCause = sanitizeWaitingCause(state.waitingCause);
  if (state.controlIntent !== undefined) payload.controlIntent = state.controlIntent;
  if (state.progress !== undefined) payload.progress = sanitizeProgress(state.progress);
  if (state.terminalReason !== undefined) payload.terminalReason = state.terminalReason;

  return deepCloneAndFreeze(payload) as unknown as Record<string, unknown>;
}

// ============================================================================
// 3. MAPPEADORES DE LEITURA DEFENSIVOS (TRUST BOUNDARY DE LEITURA)
// ============================================================================

export function mapPayloadToActor(raw: unknown, table: string, jobId?: string): Actor {
  const obj = assertPlainObject(raw, table, 'actor', jobId);
  const kind = assertNonEmptyString(obj.kind, table, 'actor.kind', jobId);

  switch (kind) {
    case 'human': {
      const humanId = assertNonEmptyString(obj.humanId, table, 'actor.humanId', jobId);
      const res: Record<string, unknown> = { kind: 'human', humanId };
      if (obj.role !== undefined) res.role = assertNonEmptyString(obj.role, table, 'actor.role', jobId);
      if (obj.authorityRef !== undefined) res.authorityRef = assertNonEmptyString(obj.authorityRef, table, 'actor.authorityRef', jobId);
      validateActor(res as any);
      return deepCloneAndFreeze(res) as unknown as Actor;
    }
    case 'max': {
      const maxVersion = assertNonEmptyString(obj.maxVersion, table, 'actor.maxVersion', jobId);
      const res: Record<string, unknown> = { kind: 'max', maxVersion };
      if (obj.sessionRef !== undefined) {
        res.sessionRef = assertNonEmptyString(obj.sessionRef, table, 'actor.sessionRef', jobId);
      }
      validateActor(res as any);
      return deepCloneAndFreeze(res) as unknown as Actor;
    }
    case 'system': {
      const component = assertNonEmptyString(obj.component, table, 'actor.component', jobId);
      const res: Record<string, unknown> = { kind: 'system', component };
      if (obj.version !== undefined) res.version = assertNonEmptyString(obj.version, table, 'actor.version', jobId);
      validateActor(res as any);
      return deepCloneAndFreeze(res) as unknown as Actor;
    }
    case 'integration': {
      const provider = assertNonEmptyString(obj.provider, table, 'actor.provider', jobId);
      const res: Record<string, unknown> = { kind: 'integration', provider };
      if (obj.integrationId !== undefined) res.integrationId = assertNonEmptyString(obj.integrationId, table, 'actor.integrationId', jobId);
      validateActor(res as any);
      return deepCloneAndFreeze(res) as unknown as Actor;
    }
    default:
      throw new CorruptedJobStorageError(table, `Unknown actor kind '${kind}'.`, jobId);
  }
}

export function mapPayloadToContextSubjectRef(raw: unknown, table: string, jobId?: string): ContextSubjectRef {
  const obj = assertPlainObject(raw, table, 'contextSubjectRef', jobId);
  const subjectType = assertNonEmptyString(obj.subjectType, table, 'contextSubjectRef.subjectType', jobId);
  const subjectId = assertNonEmptyString(obj.subjectId, table, 'contextSubjectRef.subjectId', jobId);
  const ref = { subjectType, subjectId };
  validateContextSubjectRef(ref as any);
  return deepCloneAndFreeze(ref) as unknown as ContextSubjectRef;
}

export function mapPayloadToWaitingCause(raw: unknown, table: string, jobId?: string): JobWaitingCause {
  const obj = assertPlainObject(raw, table, 'waitingCause', jobId);
  const kind = assertNonEmptyString(obj.kind, table, 'waitingCause.kind', jobId);
  const reasonCode = assertNonEmptyString(obj.reasonCode, table, 'waitingCause.reasonCode', jobId);
  const requestedAt = formatPgTimestampToUtcInstant(obj.requestedAt, table, 'waitingCause.requestedAt', jobId);

  let causeCandidate: JobWaitingCause;
  if (kind === 'human') {
    const res: Record<string, unknown> = { kind: 'human', reasonCode, requestedAt };
    if (obj.description !== undefined) res.description = assertString(obj.description, table, 'waitingCause.description', jobId);
    if (obj.deadline !== undefined) res.deadline = formatPgTimestampToUtcInstant(obj.deadline, table, 'waitingCause.deadline', jobId);
    causeCandidate = res as unknown as HumanWaitingCause;
  } else if (kind === 'temporal') {
    const resumeAfter = formatPgTimestampToUtcInstant(obj.resumeAfter, table, 'waitingCause.resumeAfter', jobId);
    causeCandidate = { kind: 'temporal', reasonCode, resumeAfter, requestedAt } as unknown as TemporalWaitingCause;
  } else {
    throw new CorruptedJobStorageError(table, `Unknown waitingCause kind '${kind}'.`, jobId);
  }

  try {
    assertValidWaitingCause(causeCandidate, (jobId ?? 'unknown') as JobId);
  } catch (err: any) {
    throw new CorruptedJobStorageError(table, err?.message ?? String(err), jobId);
  }

  return deepCloneAndFreeze(causeCandidate) as unknown as JobWaitingCause;
}

export function mapPayloadToProgress(raw: unknown, table: string, jobId?: string): JobProgress {
  const obj = assertPlainObject(raw, table, 'progress', jobId);
  const updatedAt = formatPgTimestampToUtcInstant(obj.updatedAt, table, 'progress.updatedAt', jobId);

  const res: Record<string, unknown> = {
    completed: obj.completed,
    updatedAt,
  };

  if (obj.total !== undefined) {
    res.total = obj.total;
  }
  if (obj.unit !== undefined) res.unit = assertString(obj.unit, table, 'progress.unit', jobId);
  if (obj.message !== undefined) res.message = assertString(obj.message, table, 'progress.message', jobId);

  const progressCandidate = res as unknown as JobProgress;
  try {
    assertValidProgress(progressCandidate, (jobId ?? 'unknown') as JobId);
  } catch (err: any) {
    throw new CorruptedJobStorageError(table, err?.message ?? String(err), jobId);
  }

  return deepCloneAndFreeze(progressCandidate) as unknown as JobProgress;
}

/**
 * Reconstrói um JobState a partir de uma linha de nex_job_heads com validação estrita.
 */
export function mapRowToJobState(row: any): JobState {
  const TABLE = 'nex_job_heads';
  if (!row || typeof row !== 'object') {
    throw new CorruptedJobStorageError(TABLE, 'Expected database row object.');
  }

  const jobId = assertNonEmptyString(row.job_id, TABLE, 'job_id') as JobId;
  const statusStr = assertNonEmptyString(row.status, TABLE, 'status', jobId);
  if (!VALID_JOB_STATUSES.has(statusStr)) {
    throw new CorruptedJobStorageError(TABLE, `Invalid job status '${statusStr}'.`, jobId);
  }
  const status = statusStr as JobStatus;
  const revision = assertInteger(row.revision, TABLE, 'revision', 1, jobId);

  // Parse state_payload
  let payloadRaw: unknown;
  if (typeof row.state_payload === 'string') {
    try {
      payloadRaw = JSON.parse(row.state_payload);
    } catch (parseErr) {
      throw new CorruptedJobStorageError(TABLE, `Failed to parse state_payload as JSON: ${String(parseErr)}`, jobId);
    }
  } else {
    payloadRaw = row.state_payload;
  }
  const payload = assertPlainObject(payloadRaw, TABLE, 'state_payload', jobId);

  // Validação cruzada de jobId e revision
  if (payload.jobId !== jobId) {
    throw new CorruptedJobStorageError(TABLE, `Mismatch between column job_id '${jobId}' and payload jobId '${String(payload.jobId)}'.`, jobId);
  }
  if (payload.revision !== revision) {
    throw new CorruptedJobStorageError(TABLE, `Mismatch between column revision ${revision} and payload revision ${String(payload.revision)}.`, jobId);
  }
  if (payload.status !== status) {
    throw new CorruptedJobStorageError(TABLE, `Mismatch between column status '${status}' and payload status '${String(payload.status)}'.`, jobId);
  }

  const actor = mapPayloadToActor(payload.actor, TABLE, jobId);

  // M-04: Cross-validação estrita de timestamps escalares colunas vs payload
  const colCreatedAt = formatPgTimestampToUtcInstant(row.created_at, TABLE, 'created_at', jobId);
  const payloadCreatedAt = formatPgTimestampToUtcInstant(payload.createdAt, TABLE, 'payload.createdAt', jobId);
  if (colCreatedAt !== payloadCreatedAt) {
    throw new CorruptedJobStorageError(TABLE, `Mismatch between column created_at '${colCreatedAt}' and payload createdAt '${payloadCreatedAt}'.`, jobId);
  }
  const createdAt = payloadCreatedAt;

  const colUpdatedAt = formatPgTimestampToUtcInstant(row.updated_at, TABLE, 'updated_at', jobId);
  const payloadUpdatedAt = formatPgTimestampToUtcInstant(payload.updatedAt, TABLE, 'payload.updatedAt', jobId);
  if (colUpdatedAt !== payloadUpdatedAt) {
    throw new CorruptedJobStorageError(TABLE, `Mismatch between column updated_at '${colUpdatedAt}' and payload updatedAt '${payloadUpdatedAt}'.`, jobId);
  }
  const updatedAt = payloadUpdatedAt;

  let startedAt: string | undefined;
  if (row.started_at !== null && row.started_at !== undefined) {
    if (payload.startedAt === undefined || payload.startedAt === null) {
      throw new CorruptedJobStorageError(TABLE, `Column started_at is present but payload.startedAt is missing.`, jobId);
    }
    const colStartedAt = formatPgTimestampToUtcInstant(row.started_at, TABLE, 'started_at', jobId);
    const payloadStartedAt = formatPgTimestampToUtcInstant(payload.startedAt, TABLE, 'payload.startedAt', jobId);
    if (colStartedAt !== payloadStartedAt) {
      throw new CorruptedJobStorageError(TABLE, `Mismatch between column started_at '${colStartedAt}' and payload startedAt '${payloadStartedAt}'.`, jobId);
    }
    startedAt = payloadStartedAt;
  } else {
    if (payload.startedAt !== undefined && payload.startedAt !== null) {
      throw new CorruptedJobStorageError(TABLE, `Column started_at is null but payload.startedAt is present ('${String(payload.startedAt)}').`, jobId);
    }
  }

  let finishedAt: string | undefined;
  if (row.finished_at !== null && row.finished_at !== undefined) {
    if (payload.finishedAt === undefined || payload.finishedAt === null) {
      throw new CorruptedJobStorageError(TABLE, `Column finished_at is present but payload.finishedAt is missing.`, jobId);
    }
    const colFinishedAt = formatPgTimestampToUtcInstant(row.finished_at, TABLE, 'finished_at', jobId);
    const payloadFinishedAt = formatPgTimestampToUtcInstant(payload.finishedAt, TABLE, 'payload.finishedAt', jobId);
    if (colFinishedAt !== payloadFinishedAt) {
      throw new CorruptedJobStorageError(TABLE, `Mismatch between column finished_at '${colFinishedAt}' and payload finishedAt '${payloadFinishedAt}'.`, jobId);
    }
    finishedAt = payloadFinishedAt;
  } else {
    if (payload.finishedAt !== undefined && payload.finishedAt !== null) {
      throw new CorruptedJobStorageError(TABLE, `Column finished_at is null but payload.finishedAt is present ('${String(payload.finishedAt)}').`, jobId);
    }
  }

  // Attempt Lineage
  if (!Array.isArray(payload.attemptLineage)) {
    throw new CorruptedJobStorageError(TABLE, `Field 'attemptLineage' must be an array.`, jobId);
  }
  const attemptLineage = payload.attemptLineage.map((att: unknown, idx: number) =>
    assertNonEmptyString(att, TABLE, `attemptLineage[${idx}]`, jobId)
  );

  const state: Record<string, unknown> = {
    jobId,
    status,
    revision,
    actor,
    createdAt,
    updatedAt,
    attemptLineage: Object.freeze(attemptLineage),
  };

  if (startedAt !== undefined) {
    state.startedAt = startedAt;
  }
  if (finishedAt !== undefined) {
    state.finishedAt = finishedAt;
  }

  if (payload.userId !== undefined) {
    state.userId = assertNonEmptyString(payload.userId, TABLE, 'userId', jobId);
  }
  if (payload.sessionRef !== undefined) {
    if (!isValidSessionRef(payload.sessionRef)) {
      throw new CorruptedJobStorageError(TABLE, `Invalid sessionRef in Job payload.`, jobId);
    }
    state.sessionRef = payload.sessionRef;
  }
  if (payload.contextSubjectRef !== undefined) {
    state.contextSubjectRef = mapPayloadToContextSubjectRef(payload.contextSubjectRef, TABLE, jobId);
  }
  if (payload.correlationId !== undefined) {
    state.correlationId = assertNonEmptyString(payload.correlationId, TABLE, 'correlationId', jobId);
  }
  if (payload.materialContextPinId !== undefined) {
    validateMaterialContextPinId(payload.materialContextPinId as any);
    state.materialContextPinId = payload.materialContextPinId;
  }

  if (payload.waitingCause !== undefined) {
    state.waitingCause = mapPayloadToWaitingCause(payload.waitingCause, TABLE, jobId);
  }
  if (payload.controlIntent !== undefined) {
    const ci = assertNonEmptyString(payload.controlIntent, TABLE, 'controlIntent', jobId);
    if (!VALID_CONTROL_INTENTS.has(ci)) {
      throw new CorruptedJobStorageError(TABLE, `Invalid controlIntent '${ci}'.`, jobId);
    }
    state.controlIntent = ci as JobControlIntent;
  }
  if (payload.progress !== undefined) {
    state.progress = mapPayloadToProgress(payload.progress, TABLE, jobId);
  }
  if (payload.terminalReason !== undefined) {
    state.terminalReason = assertString(payload.terminalReason, TABLE, 'terminalReason', jobId);
  }

  // Validação canônica estrita delegada integralmente ao Core C1
  try {
    assertCanonicalJobState(state as unknown as JobState);
  } catch (err: any) {
    throw new CorruptedJobStorageError(
      TABLE,
      err?.message ?? String(err),
      jobId,
    );
  }

  return deepCloneAndFreeze(state) as unknown as JobState;
}

/**
 * Converte uma linha de nex_job_events para JobStoredRecord.
 */
export function mapRowToStoredRecord(row: any): JobStoredRecord {
  const TABLE = 'nex_job_events';
  if (!row || typeof row !== 'object') {
    throw new CorruptedJobStorageError(TABLE, 'Expected database row object.');
  }

  const jobId = assertNonEmptyString(row.job_id, TABLE, 'job_id') as JobId;
  const revision = assertInteger(row.revision, TABLE, 'revision', 1, jobId);
  const recordKind = assertNonEmptyString(row.record_kind, TABLE, 'record_kind', jobId);
  if (recordKind !== 'created' && recordKind !== 'transition') {
    throw new CorruptedJobStorageError(TABLE, `Unknown record_kind '${recordKind}'.`, jobId);
  }

  let eventType: JobEventType | undefined;
  if (recordKind === 'created') {
    if (row.event_type !== null && row.event_type !== undefined) {
      throw new CorruptedJobStorageError(TABLE, `Creation record must have null event_type.`, jobId);
    }
  } else {
    eventType = assertNonEmptyString(row.event_type, TABLE, 'event_type', jobId) as JobEventType;
  }

  const occurredAt = formatPgTimestampToUtcInstant(row.occurred_at, TABLE, 'occurred_at', jobId);
  let payloadRaw: unknown;
  if (typeof row.payload === 'string') {
    try {
      payloadRaw = JSON.parse(row.payload);
    } catch (parseErr) {
      throw new CorruptedJobStorageError(TABLE, `Failed to parse payload as JSON: ${String(parseErr)}`, jobId);
    }
  } else {
    payloadRaw = row.payload;
  }
  const payload = assertPlainObject(payloadRaw, TABLE, 'payload', jobId);

  // M-06: Validação cruzada de occurred_at com o timestamp correspondente no payload
  if (recordKind === 'created') {
    if (payload.createdAt === undefined || payload.createdAt === null) {
      throw new CorruptedJobStorageError(TABLE, `Creation payload missing createdAt.`, jobId);
    }
    const payloadCreatedAt = formatPgTimestampToUtcInstant(payload.createdAt, TABLE, 'payload.createdAt', jobId);
    if (payloadCreatedAt !== occurredAt) {
      throw new CorruptedJobStorageError(
        TABLE,
        `Mismatch between row occurred_at '${occurredAt}' and payload.createdAt '${payloadCreatedAt}'.`,
        jobId,
      );
    }
  } else {
    let payloadOccurredAt: unknown;
    switch (eventType) {
      case 'JobStarted':
        payloadOccurredAt = payload.startedAt;
        break;
      case 'JobAttemptCorrelated':
        payloadOccurredAt = payload.correlatedAt;
        break;
      case 'JobWaiting':
        payloadOccurredAt = payload.transitionedAt;
        break;
      case 'JobYieldedWaiting':
        payloadOccurredAt = payload.resumedAt;
        break;
      case 'JobControlRequested':
        payloadOccurredAt = payload.requestedAt;
        break;
      case 'JobPaused':
        payloadOccurredAt = payload.pausedAt;
        break;
      case 'JobResumed':
        payloadOccurredAt = payload.resumedAt;
        break;
      case 'JobProgressUpdated':
        payloadOccurredAt = (payload.progress as Record<string, unknown> | undefined)?.updatedAt;
        break;
      case 'JobSucceeded':
      case 'JobFailed':
      case 'JobCancelled':
        payloadOccurredAt = payload.finishedAt;
        break;
      default:
        throw new CorruptedJobStorageError(TABLE, `Unknown event_type '${String(eventType)}'.`, jobId);
    }

    if (payloadOccurredAt === undefined || payloadOccurredAt === null) {
      throw new CorruptedJobStorageError(
        TABLE,
        `Event payload for '${String(eventType)}' missing timestamp field matching occurred_at.`,
        jobId,
      );
    }

    const formattedPayloadOccurredAt = formatPgTimestampToUtcInstant(
      payloadOccurredAt,
      TABLE,
      `payload timestamp for ${String(eventType)}`,
      jobId,
    );
    if (formattedPayloadOccurredAt !== occurredAt) {
      throw new CorruptedJobStorageError(
        TABLE,
        `Mismatch between row occurred_at '${occurredAt}' and event payload timestamp '${formattedPayloadOccurredAt}'.`,
        jobId,
      );
    }
  }

  // M-07: Validar formato de append_sequence com /^[1-9]\d*$/ (bigint identity positivo)
  const rawSeq = row.append_sequence;
  const seqStr = String(rawSeq ?? '');
  if (!/^[1-9]\d*$/.test(seqStr)) {
    throw new CorruptedJobStorageError(
      TABLE,
      `Field 'append_sequence' must be a positive integer sequence string matching /^[1-9]\\d*$/. Received: '${seqStr}'.`,
      jobId,
    );
  }
  const appendSequence = seqStr;

  return Object.freeze({
    jobId,
    revision,
    recordKind,
    eventType,
    occurredAt,
    payload,
    appendSequence,
  });
}

/**
 * Reconstrói CreateJobParams a partir de um JobStoredRecord de revision 1 (recordKind === 'created').
 */
export function mapStoredRecordToCreateJobParams(record: JobStoredRecord): CreateJobParams {
  const TABLE = 'nex_job_events';
  if (record.recordKind !== 'created' || record.revision !== 1) {
    throw new CorruptedJobStorageError(TABLE, `Record is not a valid creation record (kind=${record.recordKind}, rev=${record.revision}).`, record.jobId);
  }

  const payload = record.payload;
  const jobId = assertNonEmptyString(payload.jobId ?? record.jobId, TABLE, 'payload.jobId', record.jobId) as JobId;
  if (jobId !== record.jobId) {
    throw new CorruptedJobStorageError(TABLE, `Mismatch between record.jobId '${record.jobId}' and payload.jobId '${jobId}'.`, record.jobId);
  }

  const actor = mapPayloadToActor(payload.actor, TABLE, jobId);
  const createdAt = formatPgTimestampToUtcInstant(payload.createdAt ?? record.occurredAt, TABLE, 'payload.createdAt', jobId);

  const params: Record<string, unknown> = {
    jobId,
    actor,
    createdAt,
  };

  if (payload.userId !== undefined) {
    params.userId = assertNonEmptyString(payload.userId, TABLE, 'userId', jobId);
  }
  if (payload.sessionRef !== undefined) {
    if (!isValidSessionRef(payload.sessionRef)) {
      throw new CorruptedJobStorageError(TABLE, `Invalid sessionRef in creation payload.`, jobId);
    }
    params.sessionRef = payload.sessionRef;
  }
  if (payload.contextSubjectRef !== undefined) {
    params.contextSubjectRef = mapPayloadToContextSubjectRef(payload.contextSubjectRef, TABLE, jobId);
  }
  if (payload.correlationId !== undefined) {
    params.correlationId = assertNonEmptyString(payload.correlationId, TABLE, 'correlationId', jobId);
  }
  if (payload.materialContextPinId !== undefined) {
    validateMaterialContextPinId(payload.materialContextPinId as any);
    params.materialContextPinId = payload.materialContextPinId;
  }

  return deepCloneAndFreeze(params) as unknown as CreateJobParams;
}

/**
 * Reconstrói um JobEvent canônico a partir de um JobStoredRecord de transição (recordKind === 'transition').
 */
export function mapStoredRecordToJobEvent(record: JobStoredRecord): JobEvent {
  const TABLE = 'nex_job_events';
  if (record.recordKind !== 'transition') {
    throw new CorruptedJobStorageError(TABLE, `Record is not a transition event.`, record.jobId);
  }
  if (!record.eventType) {
    throw new CorruptedJobStorageError(TABLE, `Transition record missing eventType.`, record.jobId);
  }

  const p = record.payload;
  const jobId = record.jobId;

  switch (record.eventType) {
    case 'JobStarted': {
      const startedAt = formatPgTimestampToUtcInstant(p.startedAt ?? record.occurredAt, TABLE, 'startedAt', jobId);
      const res: Record<string, unknown> = { type: 'JobStarted', jobId, startedAt };
      if (p.attemptId !== undefined) res.attemptId = assertNonEmptyString(p.attemptId, TABLE, 'attemptId', jobId);
      return deepCloneAndFreeze(res) as unknown as JobEvent;
    }

    case 'JobAttemptCorrelated': {
      const attemptId = assertNonEmptyString(p.attemptId, TABLE, 'attemptId', jobId);
      const correlatedAt = formatPgTimestampToUtcInstant(p.correlatedAt ?? record.occurredAt, TABLE, 'correlatedAt', jobId);
      return deepCloneAndFreeze({ type: 'JobAttemptCorrelated', jobId, attemptId, correlatedAt }) as unknown as JobEvent;
    }

    case 'JobWaiting': {
      const cause = mapPayloadToWaitingCause(p.cause, TABLE, jobId);
      const transitionedAt = formatPgTimestampToUtcInstant(p.transitionedAt ?? record.occurredAt, TABLE, 'transitionedAt', jobId);
      return deepCloneAndFreeze({ type: 'JobWaiting', jobId, cause, transitionedAt }) as unknown as JobEvent;
    }

    case 'JobYieldedWaiting': {
      const resumedAt = formatPgTimestampToUtcInstant(p.resumedAt ?? record.occurredAt, TABLE, 'resumedAt', jobId);
      return deepCloneAndFreeze({ type: 'JobYieldedWaiting', jobId, resumedAt }) as unknown as JobEvent;
    }

    case 'JobControlRequested': {
      const intent = assertNonEmptyString(p.intent, TABLE, 'intent', jobId);
      if (!VALID_CONTROL_INTENTS.has(intent)) {
        throw new CorruptedJobStorageError(TABLE, `Invalid control intent '${intent}'.`, jobId);
      }
      const requestedAt = formatPgTimestampToUtcInstant(p.requestedAt ?? record.occurredAt, TABLE, 'requestedAt', jobId);
      return deepCloneAndFreeze({ type: 'JobControlRequested', jobId, intent: intent as JobControlIntent, requestedAt }) as unknown as JobEvent;
    }

    case 'JobPaused': {
      const pausedAt = formatPgTimestampToUtcInstant(p.pausedAt ?? record.occurredAt, TABLE, 'pausedAt', jobId);
      return deepCloneAndFreeze({ type: 'JobPaused', jobId, pausedAt }) as unknown as JobEvent;
    }

    case 'JobResumed': {
      const resumedAt = formatPgTimestampToUtcInstant(p.resumedAt ?? record.occurredAt, TABLE, 'resumedAt', jobId);
      return deepCloneAndFreeze({ type: 'JobResumed', jobId, resumedAt }) as unknown as JobEvent;
    }

    case 'JobProgressUpdated': {
      const progress = mapPayloadToProgress(p.progress, TABLE, jobId);
      return deepCloneAndFreeze({ type: 'JobProgressUpdated', jobId, progress }) as unknown as JobEvent;
    }

    case 'JobSucceeded': {
      const finishedAt = formatPgTimestampToUtcInstant(p.finishedAt ?? record.occurredAt, TABLE, 'finishedAt', jobId);
      const res: Record<string, unknown> = { type: 'JobSucceeded', jobId, finishedAt };
      if (p.terminalReason !== undefined) res.terminalReason = assertString(p.terminalReason, TABLE, 'terminalReason', jobId);
      return deepCloneAndFreeze(res) as unknown as JobEvent;
    }

    case 'JobFailed': {
      const finishedAt = formatPgTimestampToUtcInstant(p.finishedAt ?? record.occurredAt, TABLE, 'finishedAt', jobId);
      const reasonCode = assertNonEmptyString(p.reasonCode, TABLE, 'reasonCode', jobId);
      const res: Record<string, unknown> = { type: 'JobFailed', jobId, finishedAt, reasonCode };
      if (p.terminalReason !== undefined) res.terminalReason = assertString(p.terminalReason, TABLE, 'terminalReason', jobId);
      return deepCloneAndFreeze(res) as unknown as JobEvent;
    }

    case 'JobCancelled': {
      const finishedAt = formatPgTimestampToUtcInstant(p.finishedAt ?? record.occurredAt, TABLE, 'finishedAt', jobId);
      const res: Record<string, unknown> = { type: 'JobCancelled', jobId, finishedAt };
      if (p.reasonCode !== undefined) res.reasonCode = assertNonEmptyString(p.reasonCode, TABLE, 'reasonCode', jobId);
      if (p.terminalReason !== undefined) res.terminalReason = assertString(p.terminalReason, TABLE, 'terminalReason', jobId);
      return deepCloneAndFreeze(res) as unknown as JobEvent;
    }

    default:
      throw new CorruptedJobStorageError(TABLE, `Unknown event_type '${String(record.eventType)}'.`, jobId);
  }
}

/**
 * Asserção estrita de equivalência entre o estado reidratado por replay e o head persistido.
 */
export function assertJobStatesEquivalent(replayed: JobState, head: JobState): void {
  const jobId = replayed.jobId;

  if (replayed.jobId !== head.jobId) {
    throw new JobRehydrationDivergenceError(jobId, `jobId mismatch: replayed=${replayed.jobId}, head=${head.jobId}`);
  }
  if (replayed.status !== head.status) {
    throw new JobRehydrationDivergenceError(jobId, `status mismatch: replayed=${replayed.status}, head=${head.status}`);
  }
  if (replayed.revision !== head.revision) {
    throw new JobRehydrationDivergenceError(jobId, `revision mismatch: replayed=${replayed.revision}, head=${head.revision}`);
  }
  if (replayed.createdAt !== head.createdAt) {
    throw new JobRehydrationDivergenceError(jobId, `createdAt mismatch: replayed=${replayed.createdAt}, head=${head.createdAt}`);
  }
  if (replayed.updatedAt !== head.updatedAt) {
    throw new JobRehydrationDivergenceError(jobId, `updatedAt mismatch: replayed=${replayed.updatedAt}, head=${head.updatedAt}`);
  }
  if (replayed.startedAt !== head.startedAt) {
    throw new JobRehydrationDivergenceError(jobId, `startedAt mismatch: replayed=${replayed.startedAt}, head=${head.startedAt}`);
  }
  if (replayed.finishedAt !== head.finishedAt) {
    throw new JobRehydrationDivergenceError(jobId, `finishedAt mismatch: replayed=${replayed.finishedAt}, head=${head.finishedAt}`);
  }
  if (replayed.userId !== head.userId) {
    throw new JobRehydrationDivergenceError(jobId, `userId mismatch: replayed=${replayed.userId}, head=${head.userId}`);
  }
  if (replayed.sessionRef !== head.sessionRef) {
    throw new JobRehydrationDivergenceError(jobId, `sessionRef mismatch: replayed=${replayed.sessionRef}, head=${head.sessionRef}`);
  }
  if (replayed.correlationId !== head.correlationId) {
    throw new JobRehydrationDivergenceError(jobId, `correlationId mismatch: replayed=${replayed.correlationId}, head=${head.correlationId}`);
  }
  if (replayed.materialContextPinId !== head.materialContextPinId) {
    throw new JobRehydrationDivergenceError(jobId, `materialContextPinId mismatch: replayed=${replayed.materialContextPinId}, head=${head.materialContextPinId}`);
  }
  if (replayed.controlIntent !== head.controlIntent) {
    throw new JobRehydrationDivergenceError(jobId, `controlIntent mismatch: replayed=${replayed.controlIntent}, head=${head.controlIntent}`);
  }
  if (replayed.terminalReason !== head.terminalReason) {
    throw new JobRehydrationDivergenceError(jobId, `terminalReason mismatch: replayed=${replayed.terminalReason}, head=${head.terminalReason}`);
  }

  // Actor
  if (replayed.actor.kind !== head.actor.kind) {
    throw new JobRehydrationDivergenceError(jobId, `actor.kind mismatch: replayed=${replayed.actor.kind}, head=${head.actor.kind}`);
  }
  switch (replayed.actor.kind) {
    case 'human': {
      const hHead = head.actor as typeof replayed.actor;
      if (replayed.actor.humanId !== hHead.humanId || replayed.actor.role !== hHead.role || replayed.actor.authorityRef !== hHead.authorityRef) {
        throw new JobRehydrationDivergenceError(jobId, `human actor mismatch.`);
      }
      break;
    }
    case 'max': {
      const mHead = head.actor as typeof replayed.actor;
      if (replayed.actor.maxVersion !== mHead.maxVersion || replayed.actor.sessionRef !== mHead.sessionRef) {
        throw new JobRehydrationDivergenceError(jobId, `max actor mismatch.`);
      }
      break;
    }
    case 'system': {
      const sHead = head.actor as typeof replayed.actor;
      if (replayed.actor.component !== sHead.component || replayed.actor.version !== sHead.version) {
        throw new JobRehydrationDivergenceError(jobId, `system actor mismatch.`);
      }
      break;
    }
    case 'integration': {
      const iHead = head.actor as typeof replayed.actor;
      if (replayed.actor.provider !== iHead.provider || replayed.actor.integrationId !== iHead.integrationId) {
        throw new JobRehydrationDivergenceError(jobId, `integration actor mismatch.`);
      }
      break;
    }
  }

  // ContextSubjectRef
  if ((replayed.contextSubjectRef === undefined) !== (head.contextSubjectRef === undefined)) {
    throw new JobRehydrationDivergenceError(jobId, `contextSubjectRef presence mismatch.`);
  }
  if (replayed.contextSubjectRef && head.contextSubjectRef) {
    if (replayed.contextSubjectRef.subjectType !== head.contextSubjectRef.subjectType ||
        replayed.contextSubjectRef.subjectId !== head.contextSubjectRef.subjectId) {
      throw new JobRehydrationDivergenceError(jobId, `contextSubjectRef mismatch.`);
    }
  }

  // Attempt Lineage
  if (replayed.attemptLineage.length !== head.attemptLineage.length ||
      replayed.attemptLineage.some((att: string, i: number) => att !== head.attemptLineage[i])) {
    throw new JobRehydrationDivergenceError(jobId, `attemptLineage mismatch: replayed=${JSON.stringify(replayed.attemptLineage)}, head=${JSON.stringify(head.attemptLineage)}`);
  }

  // Waiting Cause
  if ((replayed.waitingCause === undefined) !== (head.waitingCause === undefined)) {
    throw new JobRehydrationDivergenceError(jobId, `waitingCause presence mismatch.`);
  }
  if (replayed.waitingCause && head.waitingCause) {
    if (replayed.waitingCause.kind !== head.waitingCause.kind ||
        replayed.waitingCause.reasonCode !== head.waitingCause.reasonCode ||
        replayed.waitingCause.requestedAt !== head.waitingCause.requestedAt) {
      throw new JobRehydrationDivergenceError(jobId, `waitingCause mismatch.`);
    }
    if (replayed.waitingCause.kind === 'human') {
      const hHead = head.waitingCause as typeof replayed.waitingCause;
      if (replayed.waitingCause.description !== hHead.description ||
          replayed.waitingCause.deadline !== hHead.deadline) {
        throw new JobRehydrationDivergenceError(jobId, `human waitingCause mismatch.`);
      }
    } else {
      const tHead = head.waitingCause as typeof replayed.waitingCause;
      if (replayed.waitingCause.resumeAfter !== tHead.resumeAfter) {
        throw new JobRehydrationDivergenceError(jobId, `temporal waitingCause mismatch.`);
      }
    }
  }

  // Progress
  if ((replayed.progress === undefined) !== (head.progress === undefined)) {
    throw new JobRehydrationDivergenceError(jobId, `progress presence mismatch.`);
  }
  if (replayed.progress && head.progress) {
    if (replayed.progress.completed !== head.progress.completed ||
        replayed.progress.total !== head.progress.total ||
        replayed.progress.unit !== head.progress.unit ||
        replayed.progress.message !== head.progress.message ||
        replayed.progress.updatedAt !== head.progress.updatedAt) {
      throw new JobRehydrationDivergenceError(jobId, `progress mismatch: replayed=${JSON.stringify(replayed.progress)}, head=${JSON.stringify(head.progress)}`);
    }
  }
}
