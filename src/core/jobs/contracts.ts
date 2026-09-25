/**
 * NEX+ · Job Lifecycle Core
 * Contratos Canônicos TypeScript — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-1)
 *
 * Princípios Fundamentais:
 * 1. Job é envelope lógico durável de trabalho (Job != Attempt).
 * 2. Attempt é uma tentativa concreta de execução; Job correlaciona Attempts sem absorver seu estado interno.
 * 3. Runtime (pg-boss, fila, scheduler) NÃO é autoridade do lifecycle do Job.
 * 4. Estados canônicos mínimos explícitos: queued, running, waiting, paused, succeeded, failed, cancelled.
 * 5. Estados terminais (succeeded, failed, cancelled) são estritamente irrevogáveis (no-resurrection).
 * 6. Controle != Estado: pause/cancel requested != paused/cancelled.
 * 7. Waiting exige causa material explícita (discriminated union: human | temporal).
 * 8. Imutabilidade profunda e determinismo puro (sem Date.now, sem UUID, sem I/O).
 * 9. Revisão monotônica adequada para concorrência otimista.
 * 10. Provenance e referências causais sem credenciais ou segredos.
 */

import type { AttemptId } from '../execution/contracts';
import type { Actor } from '../observations/contracts';
import type { SessionRef } from '../../auth/session-ref.types';
import type { ContextSubjectRef } from '../context/contracts';
import type { CorrelationId } from '../modules/contracts';
import type { MaterialContextPinId } from '../material-context/contracts';

// ============================================================================
// 1. IDENTIFICADORES BRANDED (Semantic Aliases)
// ============================================================================

export type JobId = string & { readonly __brand?: 'JobId' };

// ============================================================================
// 2. ESTADOS DO LIFECYCLE
// ============================================================================

export type JobActiveStatus = 'queued' | 'running' | 'waiting' | 'paused';
export type JobTerminalStatus = 'succeeded' | 'failed' | 'cancelled';
export type JobStatus = JobActiveStatus | JobTerminalStatus;

// ============================================================================
// 3. CAUSAS MATERIAIS DE WAITING (União Discriminada Estrita)
// ============================================================================

export interface HumanWaitingCause {
  readonly kind: 'human';
  readonly reasonCode: string;
  readonly description?: string;
  readonly requestedAt: string; // ISO 8601 UTC
  readonly deadline?: string;    // ISO 8601 UTC
}

export interface TemporalWaitingCause {
  readonly kind: 'temporal';
  readonly reasonCode: string;
  readonly resumeAfter: string; // ISO 8601 UTC
  readonly requestedAt: string; // ISO 8601 UTC
}

export type JobWaitingCause = HumanWaitingCause | TemporalWaitingCause;
export type JobWaitingCauseKind = JobWaitingCause['kind'];

// ============================================================================
// 4. SOLICITAÇÃO DE CONTROLE (Controle ≠ Estado)
// ============================================================================

export type JobControlIntent = 'pause' | 'cancel';

// ============================================================================
// 5. PROGRESSO FACTUAL (Opcional)
// ============================================================================

export interface JobProgress {
  readonly completed: number;
  readonly total?: number;
  readonly unit?: string;
  readonly message?: string;
  readonly updatedAt: string; // ISO 8601 UTC
}

// ============================================================================
// 6. ESTADO DO JOB (Imutável)
// ============================================================================

export interface JobState {
  readonly jobId: JobId;
  readonly status: JobStatus;
  readonly revision: number;

  // Provenance / Contexto de Origem (Sem credenciais!)
  readonly actor: Actor;
  readonly userId?: string;
  readonly sessionRef?: SessionRef;
  readonly contextSubjectRef?: ContextSubjectRef;
  readonly correlationId?: CorrelationId;
  readonly materialContextPinId?: MaterialContextPinId;

  // Temporalidade explícita
  readonly createdAt: string;  // ISO 8601 UTC
  readonly startedAt?: string;  // ISO 8601 UTC
  readonly finishedAt?: string; // ISO 8601 UTC
  readonly updatedAt: string;   // ISO 8601 UTC

  // Linhagem causal de tentativas (AttemptId apenas)
  readonly attemptLineage: readonly AttemptId[];

  // Estado contextual de espera (apenas quando status === 'waiting')
  readonly waitingCause?: JobWaitingCause;

  // Intenção de controle solicitada (pause requested != paused; cancel requested != cancelled)
  readonly controlIntent?: JobControlIntent;

  // Progresso factual
  readonly progress?: JobProgress;

  // Desfecho ou justificativa terminal
  readonly terminalReason?: string;
}

// ============================================================================
// 7. EVENTOS PUROS DE TRANSIÇÃO DO LIFECYCLE (Discriminated Union)
// ============================================================================

export interface CreateJobParams {
  readonly jobId: JobId;
  readonly actor: Actor;
  readonly userId?: string;
  readonly sessionRef?: SessionRef;
  readonly contextSubjectRef?: ContextSubjectRef;
  readonly correlationId?: CorrelationId;
  readonly materialContextPinId?: MaterialContextPinId;
  readonly createdAt: string; // ISO 8601 UTC
}

export interface JobStartedEvent {
  readonly type: 'JobStarted';
  readonly jobId: JobId;
  readonly attemptId?: AttemptId;
  readonly startedAt: string; // ISO 8601 UTC
}

export interface JobAttemptCorrelatedEvent {
  readonly type: 'JobAttemptCorrelated';
  readonly jobId: JobId;
  readonly attemptId: AttemptId;
  readonly correlatedAt: string; // ISO 8601 UTC
}

export interface JobWaitingEvent {
  readonly type: 'JobWaiting';
  readonly jobId: JobId;
  readonly cause: JobWaitingCause;
  readonly transitionedAt: string; // ISO 8601 UTC
}

export interface JobYieldedWaitingEvent {
  readonly type: 'JobYieldedWaiting';
  readonly jobId: JobId;
  readonly resumedAt: string; // ISO 8601 UTC
}

export interface JobControlRequestedEvent {
  readonly type: 'JobControlRequested';
  readonly jobId: JobId;
  readonly intent: JobControlIntent;
  readonly requestedAt: string; // ISO 8601 UTC
}

export interface JobPausedEvent {
  readonly type: 'JobPaused';
  readonly jobId: JobId;
  readonly pausedAt: string; // ISO 8601 UTC
}

export interface JobResumedEvent {
  readonly type: 'JobResumed';
  readonly jobId: JobId;
  readonly resumedAt: string; // ISO 8601 UTC
}

export interface JobProgressUpdatedEvent {
  readonly type: 'JobProgressUpdated';
  readonly jobId: JobId;
  readonly progress: JobProgress;
}

export interface JobSucceededEvent {
  readonly type: 'JobSucceeded';
  readonly jobId: JobId;
  readonly finishedAt: string; // ISO 8601 UTC
  readonly terminalReason?: string;
}

export interface JobFailedEvent {
  readonly type: 'JobFailed';
  readonly jobId: JobId;
  readonly finishedAt: string; // ISO 8601 UTC
  readonly reasonCode: string;
  readonly terminalReason?: string;
}

export interface JobCancelledEvent {
  readonly type: 'JobCancelled';
  readonly jobId: JobId;
  readonly finishedAt: string; // ISO 8601 UTC
  readonly reasonCode?: string;
  readonly terminalReason?: string;
}

export type JobEvent =
  | JobStartedEvent
  | JobAttemptCorrelatedEvent
  | JobWaitingEvent
  | JobYieldedWaitingEvent
  | JobControlRequestedEvent
  | JobPausedEvent
  | JobResumedEvent
  | JobProgressUpdatedEvent
  | JobSucceededEvent
  | JobFailedEvent
  | JobCancelledEvent;

export type JobEventType = JobEvent['type'];
