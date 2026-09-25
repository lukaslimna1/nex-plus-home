/**
 * NEX+ · Job Lifecycle State Machine & Reducer
 * Implementação Determinística e Pura — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-1)
 *
 * Princípios Fundamentais:
 * 1. Função pura: f(state, event) => newState (sem Date.now, sem UUID, sem I/O).
 * 2. Imutabilidade profunda: estado e linhagens anteriores permanecem inalterados.
 * 3. Revisão monotônica: cada transição aceita produz revision = previous.revision + 1.
 * 4. Terminalidade forte: succeeded, failed e cancelled rejeitam qualquer nova transição.
 * 5. Controle != Estado: solicitações de pause/cancel registram controlIntent sem mutar status prematuramente.
 */

import type {
  JobId,
  JobStatus,
  JobState,
  JobEvent,
  CreateJobParams,
  JobControlIntent,
} from './contracts';

import type { Actor } from '../observations/contracts';
import type { ContextSubjectRef } from '../context/contracts';

import {
  assertNotTerminal,
  assertJobIdMatch,
  assertUniqueAttempt,
  assertValidWaitingCause,
  assertValidProgress,
  assertCanonicalUtcInstant,
  assertMonotonicOrder,
  JobLifecycleError,
} from './invariants';

import {
  validateActor,
  validateContextSubjectRef,
} from '../context/invariants';

// ============================================================================
// 1. RECONSTRUÇÃO DEFENSIVA CANÔNICA DE PAYLOADS ANINHADOS
// ============================================================================

function sanitizeActor(actor: Actor): Actor {
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

function sanitizeContextSubjectRef(ref: ContextSubjectRef): ContextSubjectRef {
  return Object.freeze({
    subjectType: ref.subjectType,
    subjectId: ref.subjectId,
  });
}

// ============================================================================
// 2. FACTORY DETERMINÍSTICA DE CRIAÇÃO (Novo Job -> 'queued')
// ============================================================================

export function createJob(params: CreateJobParams): JobState {
  if (!params.jobId || typeof params.jobId !== 'string' || params.jobId.trim().length === 0) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PAYLOAD',
      message: '[Job Lifecycle] JobId must be a valid non-empty string.',
    });
  }

  if (!params.actor || typeof params.actor !== 'object') {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PAYLOAD',
      message: `[Job Lifecycle] Actor is required to create Job '${params.jobId}'.`,
      jobId: params.jobId,
    });
  }

  try {
    validateActor(params.actor);
  } catch (err: any) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PAYLOAD',
      message: `[Job Lifecycle] Invalid Actor in Job '${params.jobId}': ${err?.message ?? String(err)}`,
      jobId: params.jobId,
    });
  }

  const sanitizedActor = sanitizeActor(params.actor);

  let sanitizedContextSubjectRef: ContextSubjectRef | undefined;
  if (params.contextSubjectRef !== undefined) {
    try {
      validateContextSubjectRef(params.contextSubjectRef);
    } catch (err: any) {
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Invalid ContextSubjectRef in Job '${params.jobId}': ${err?.message ?? String(err)}`,
        jobId: params.jobId,
      });
    }
    sanitizedContextSubjectRef = sanitizeContextSubjectRef(params.contextSubjectRef);
  }

  assertCanonicalUtcInstant(params.createdAt, 'createdAt', params.jobId);

  return Object.freeze({
    jobId: params.jobId,
    status: 'queued',
    revision: 1,

    actor: sanitizedActor,
    userId: params.userId,
    sessionRef: params.sessionRef,
    contextSubjectRef: sanitizedContextSubjectRef,
    correlationId: params.correlationId,
    materialContextPinId: params.materialContextPinId,

    createdAt: params.createdAt,
    updatedAt: params.createdAt,

    attemptLineage: Object.freeze([]),
  });
}

// ============================================================================
// 3. REDUCER DETERMINÍSTICO PURO DO LIFECYCLE
// ============================================================================

export function reduceJob(state: JobState, event: JobEvent): JobState {
  // 1. Asserção de imutabilidade terminal (no-resurrection)
  assertNotTerminal(state, event.type);

  // 2. Asserção de correlação de JobId
  assertJobIdMatch(state, event.jobId, event.type);

  // Revisão monotônica estrita
  const nextRevision = state.revision + 1;

  switch (event.type) {
    // ------------------------------------------------------------------------
    // A. JobStarted: queued -> running
    // ------------------------------------------------------------------------
    case 'JobStarted': {
      if (state.status !== 'queued') {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_TRANSITION',
          message: `[Job Lifecycle] Cannot start Job '${state.jobId}' from status '${state.status}'. Expected 'queued'.`,
          jobId: state.jobId,
          currentStatus: state.status,
          targetStatus: 'running',
          attemptedEvent: event.type,
        });
      }

      assertCanonicalUtcInstant(event.startedAt, 'startedAt', state.jobId);
      assertMonotonicOrder(state.updatedAt, event.startedAt, 'state.updatedAt', 'startedAt', state.jobId);

      let nextAttemptLineage = state.attemptLineage;
      if (event.attemptId) {
        assertUniqueAttempt(state.attemptLineage, event.attemptId, state.jobId);
        nextAttemptLineage = Object.freeze([...state.attemptLineage, event.attemptId]);
      }

      return Object.freeze({
        ...state,
        status: 'running',
        revision: nextRevision,
        startedAt: state.startedAt ?? event.startedAt,
        updatedAt: event.startedAt,
        attemptLineage: nextAttemptLineage,
      });
    }

    // ------------------------------------------------------------------------
    // B. JobAttemptCorrelated: anexa AttemptId à linhagem (durante running)
    // ------------------------------------------------------------------------
    case 'JobAttemptCorrelated': {
      if (state.status !== 'running') {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_TRANSITION',
          message: `[Job Lifecycle] Cannot correlate Attempt '${event.attemptId}' to Job '${state.jobId}' while in status '${state.status}'. Attempts can only be attached while 'running'.`,
          jobId: state.jobId,
          currentStatus: state.status,
          attemptedEvent: event.type,
        });
      }

      assertCanonicalUtcInstant(event.correlatedAt, 'correlatedAt', state.jobId);
      assertMonotonicOrder(state.updatedAt, event.correlatedAt, 'state.updatedAt', 'correlatedAt', state.jobId);

      assertUniqueAttempt(state.attemptLineage, event.attemptId, state.jobId);
      const nextAttemptLineage = Object.freeze([...state.attemptLineage, event.attemptId]);

      return Object.freeze({
        ...state,
        revision: nextRevision,
        updatedAt: event.correlatedAt,
        attemptLineage: nextAttemptLineage,
      });
    }

    // ------------------------------------------------------------------------
    // C. JobWaiting: running -> waiting (com causa material)
    // ------------------------------------------------------------------------
    case 'JobWaiting': {
      if (state.status !== 'running') {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_TRANSITION',
          message: `[Job Lifecycle] Cannot transition Job '${state.jobId}' to 'waiting' from status '${state.status}'. Expected 'running'.`,
          jobId: state.jobId,
          currentStatus: state.status,
          targetStatus: 'waiting',
          attemptedEvent: event.type,
        });
      }

      assertCanonicalUtcInstant(event.transitionedAt, 'transitionedAt', state.jobId);
      assertMonotonicOrder(state.updatedAt, event.transitionedAt, 'state.updatedAt', 'transitionedAt', state.jobId);

      assertValidWaitingCause(event.cause, state.jobId);
      assertMonotonicOrder(event.cause.requestedAt, event.transitionedAt, 'cause.requestedAt', 'transitionedAt', state.jobId);

      return Object.freeze({
        ...state,
        status: 'waiting',
        revision: nextRevision,
        waitingCause: Object.freeze({ ...event.cause }),
        updatedAt: event.transitionedAt,
      });
    }

    // ------------------------------------------------------------------------
    // D. JobYieldedWaiting: waiting -> queued (retorno estrutural ao agendamento)
    // ------------------------------------------------------------------------
    case 'JobYieldedWaiting': {
      if (state.status !== 'waiting') {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_TRANSITION',
          message: `[Job Lifecycle] Cannot yield waiting on Job '${state.jobId}' from status '${state.status}'. Expected 'waiting'.`,
          jobId: state.jobId,
          currentStatus: state.status,
          targetStatus: 'queued',
          attemptedEvent: event.type,
        });
      }

      assertCanonicalUtcInstant(event.resumedAt, 'resumedAt', state.jobId);
      assertMonotonicOrder(state.updatedAt, event.resumedAt, 'state.updatedAt', 'resumedAt', state.jobId);

      return Object.freeze({
        ...state,
        status: 'queued',
        revision: nextRevision,
        waitingCause: undefined,
        updatedAt: event.resumedAt,
      });
    }

    // ------------------------------------------------------------------------
    // E. JobControlRequested: solicita pause ou cancel (Controle != Estado)
    // ------------------------------------------------------------------------
    case 'JobControlRequested': {
      assertCanonicalUtcInstant(event.requestedAt, 'requestedAt', state.jobId);
      assertMonotonicOrder(state.updatedAt, event.requestedAt, 'state.updatedAt', 'requestedAt', state.jobId);

      // Regra de precedência: 'cancel' tem precedência absoluta sobre 'pause'.
      // Um pedido de pause nunca pode apagar ou substituir um pedido de cancelamento já ativo.
      let nextControlIntent: JobControlIntent;

      if (event.intent === 'pause') {
        if (state.controlIntent === 'cancel') {
          // Cancelamento já ativo tem precedência; preserva cancel
          nextControlIntent = 'cancel';
        } else {
          nextControlIntent = 'pause';
        }
      } else if (event.intent === 'cancel') {
        // Cancelamento solicitado supersederá qualquer intenção prévia
        nextControlIntent = 'cancel';
      } else {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_PAYLOAD',
          message: `[Job Lifecycle] Invalid control intent in Job '${state.jobId}'. Expected 'pause' or 'cancel'.`,
          jobId: state.jobId,
        });
      }

      return Object.freeze({
        ...state,
        revision: nextRevision,
        controlIntent: nextControlIntent,
        updatedAt: event.requestedAt,
      });
    }

    // ------------------------------------------------------------------------
    // F. JobPaused: running | queued | waiting -> paused (efetiva o pause)
    // ------------------------------------------------------------------------
    case 'JobPaused': {
      if (state.status !== 'running' && state.status !== 'queued' && state.status !== 'waiting') {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_TRANSITION',
          message: `[Job Lifecycle] Cannot pause Job '${state.jobId}' from status '${state.status}'. Expected 'running', 'queued' or 'waiting'.`,
          jobId: state.jobId,
          currentStatus: state.status,
          targetStatus: 'paused',
          attemptedEvent: event.type,
        });
      }

      assertCanonicalUtcInstant(event.pausedAt, 'pausedAt', state.jobId);
      assertMonotonicOrder(state.updatedAt, event.pausedAt, 'state.updatedAt', 'pausedAt', state.jobId);

      // Se a intenção era 'pause', ela foi efetivada e é resolvida. Se era 'cancel', permanece ativa.
      const nextControlIntent = state.controlIntent === 'pause' ? undefined : state.controlIntent;

      // Preservar waitingCause se a pausa ocorreu durante espera (waiting)
      const nextWaitingCause = state.status === 'waiting' ? state.waitingCause : undefined;

      return Object.freeze({
        ...state,
        status: 'paused',
        revision: nextRevision,
        waitingCause: nextWaitingCause,
        controlIntent: nextControlIntent,
        updatedAt: event.pausedAt,
      });
    }

    // ------------------------------------------------------------------------
    // G. JobResumed: paused -> queued | waiting (retorno estrutural ao lifecycle elegível)
    // ------------------------------------------------------------------------
    case 'JobResumed': {
      if (state.status !== 'paused') {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_TRANSITION',
          message: `[Job Lifecycle] Cannot resume Job '${state.jobId}' from status '${state.status}'. Expected 'paused'.`,
          jobId: state.jobId,
          currentStatus: state.status,
          targetStatus: state.waitingCause ? 'waiting' : 'queued',
          attemptedEvent: event.type,
        });
      }

      assertCanonicalUtcInstant(event.resumedAt, 'resumedAt', state.jobId);
      assertMonotonicOrder(state.updatedAt, event.resumedAt, 'state.updatedAt', 'resumedAt', state.jobId);

      // Se Job pausado possuía waitingCause pendente, volta estruturalmente para 'waiting' preservando a causa.
      // Se não possuía, transiciona para 'queued'.
      const nextStatus: JobStatus = state.waitingCause ? 'waiting' : 'queued';

      return Object.freeze({
        ...state,
        status: nextStatus,
        revision: nextRevision,
        waitingCause: state.waitingCause,
        updatedAt: event.resumedAt,
      });
    }

    // ------------------------------------------------------------------------
    // H. JobProgressUpdated: atualiza progresso factual (apenas durante running)
    // ------------------------------------------------------------------------
    case 'JobProgressUpdated': {
      if (state.status !== 'running') {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_TRANSITION',
          message: `[Job Lifecycle] Cannot update progress on Job '${state.jobId}' while in status '${state.status}'. Progress can only be reported while 'running'.`,
          jobId: state.jobId,
          currentStatus: state.status,
          attemptedEvent: event.type,
        });
      }

      assertValidProgress(event.progress, state.jobId);
      assertMonotonicOrder(state.updatedAt, event.progress.updatedAt, 'state.updatedAt', 'progress.updatedAt', state.jobId);

      return Object.freeze({
        ...state,
        revision: nextRevision,
        progress: Object.freeze({ ...event.progress }),
        updatedAt: event.progress.updatedAt,
      });
    }

    // ------------------------------------------------------------------------
    // I. JobSucceeded: running -> succeeded (terminal)
    // ------------------------------------------------------------------------
    case 'JobSucceeded': {
      if (state.status !== 'running') {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_TRANSITION',
          message: `[Job Lifecycle] Cannot succeed Job '${state.jobId}' from status '${state.status}'. Expected 'running'. Direct transitions from 'queued' or 'waiting' are forbidden.`,
          jobId: state.jobId,
          currentStatus: state.status,
          targetStatus: 'succeeded',
          attemptedEvent: event.type,
        });
      }

      assertCanonicalUtcInstant(event.finishedAt, 'finishedAt', state.jobId);
      assertMonotonicOrder(state.updatedAt, event.finishedAt, 'state.updatedAt', 'finishedAt', state.jobId);

      return Object.freeze({
        ...state,
        status: 'succeeded',
        revision: nextRevision,
        finishedAt: event.finishedAt,
        updatedAt: event.finishedAt,
        waitingCause: undefined,
        controlIntent: undefined,
        terminalReason: event.terminalReason,
      });
    }

    // ------------------------------------------------------------------------
    // J. JobFailed: running | queued -> failed (terminal)
    // ------------------------------------------------------------------------
    case 'JobFailed': {
      if (state.status !== 'running' && state.status !== 'queued') {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_TRANSITION',
          message: `[Job Lifecycle] Cannot fail Job '${state.jobId}' from status '${state.status}'. Expected 'running' or 'queued'.`,
          jobId: state.jobId,
          currentStatus: state.status,
          targetStatus: 'failed',
          attemptedEvent: event.type,
        });
      }

      assertCanonicalUtcInstant(event.finishedAt, 'finishedAt', state.jobId);
      assertMonotonicOrder(state.updatedAt, event.finishedAt, 'state.updatedAt', 'finishedAt', state.jobId);

      return Object.freeze({
        ...state,
        status: 'failed',
        revision: nextRevision,
        finishedAt: event.finishedAt,
        updatedAt: event.finishedAt,
        waitingCause: undefined,
        controlIntent: undefined,
        terminalReason: event.terminalReason ?? event.reasonCode,
      });
    }

    // ------------------------------------------------------------------------
    // K. JobCancelled: queued | running | waiting | paused -> cancelled (terminal)
    // ------------------------------------------------------------------------
    case 'JobCancelled': {
      assertCanonicalUtcInstant(event.finishedAt, 'finishedAt', state.jobId);
      assertMonotonicOrder(state.updatedAt, event.finishedAt, 'state.updatedAt', 'finishedAt', state.jobId);

      // Estado terminal cancelado é aceito a partir de qualquer estado não-terminal.
      // Cancelamento resolve explicitamente a espera e limpa intenção de controle.
      return Object.freeze({
        ...state,
        status: 'cancelled',
        revision: nextRevision,
        finishedAt: event.finishedAt,
        updatedAt: event.finishedAt,
        waitingCause: undefined,
        controlIntent: undefined,
        terminalReason: event.terminalReason ?? event.reasonCode ?? 'CANCELLED',
      });
    }

    default: {
      const exhaustiveCheck: never = event;
      throw new JobLifecycleError({
        code: 'JOB_INVALID_PAYLOAD',
        message: `[Job Lifecycle] Unknown event type on Job '${state.jobId}': ${JSON.stringify(exhaustiveCheck)}`,
        jobId: state.jobId,
      });
    }
  }
}
