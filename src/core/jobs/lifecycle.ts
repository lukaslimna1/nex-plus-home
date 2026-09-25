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
  JobState,
  JobEvent,
  CreateJobParams,
  JobControlIntent,
} from './contracts';

import {
  assertNotTerminal,
  assertJobIdMatch,
  assertUniqueAttempt,
  assertValidWaitingCause,
  assertValidProgress,
  JobLifecycleError,
} from './invariants';

// ============================================================================
// 1. FACTORY DETERMINÍSTICA DE CRIAÇÃO (Novo Job -> 'queued')
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

  if (!params.createdAt || typeof params.createdAt !== 'string' || params.createdAt.trim().length === 0) {
    throw new JobLifecycleError({
      code: 'JOB_INVALID_PAYLOAD',
      message: `[Job Lifecycle] createdAt timestamp is required to create Job '${params.jobId}'.`,
      jobId: params.jobId,
    });
  }

  return Object.freeze({
    jobId: params.jobId,
    status: 'queued',
    revision: 1,

    actor: Object.freeze({ ...params.actor }),
    userId: params.userId,
    sessionRef: params.sessionRef,
    contextSubjectRef: params.contextSubjectRef ? Object.freeze({ ...params.contextSubjectRef }) : undefined,
    correlationId: params.correlationId,
    materialContextPinId: params.materialContextPinId,

    createdAt: params.createdAt,
    updatedAt: params.createdAt,

    attemptLineage: Object.freeze([]),
  });
}

// ============================================================================
// 2. REDUCER DETERMINÍSTICO PURO DO LIFECYCLE
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

      assertValidWaitingCause(event.cause, state.jobId);

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

      // Se a intenção era 'pause', ela foi efetivada e é resolvida. Se era 'cancel', permanece ativa.
      const nextControlIntent = state.controlIntent === 'pause' ? undefined : state.controlIntent;

      return Object.freeze({
        ...state,
        status: 'paused',
        revision: nextRevision,
        waitingCause: undefined,
        controlIntent: nextControlIntent,
        updatedAt: event.pausedAt,
      });
    }

    // ------------------------------------------------------------------------
    // G. JobResumed: paused -> queued (retorno estrutural ao lifecycle elegível)
    // ------------------------------------------------------------------------
    case 'JobResumed': {
      if (state.status !== 'paused') {
        throw new JobLifecycleError({
          code: 'JOB_INVALID_TRANSITION',
          message: `[Job Lifecycle] Cannot resume Job '${state.jobId}' from status '${state.status}'. Expected 'paused'.`,
          jobId: state.jobId,
          currentStatus: state.status,
          targetStatus: 'queued',
          attemptedEvent: event.type,
        });
      }

      return Object.freeze({
        ...state,
        status: 'queued',
        revision: nextRevision,
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
      // Estado terminal cancelado é aceito a partir de qualquer estado não-terminal
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
