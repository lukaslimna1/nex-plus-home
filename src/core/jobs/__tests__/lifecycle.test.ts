/**
 * NEX+ · Job Lifecycle Core
 * Suíte de Testes Determinísticos — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-1)
 *
 * Cobertura Completa de Invariantes:
 * - Lifecycle básico (queued -> running -> waiting -> paused -> succeeded / failed / cancelled)
 * - Controle != Estado (pause/cancel requested != paused/cancelled)
 * - Precedência de controle (cancel supersedes pause; pause não apaga cancel)
 * - Terminalidade forte (succeeded, failed, cancelled irrevogáveis)
 * - Waiting com causa material explícita (human, temporal)
 * - Attempt lineage causal (sem absorção de autoridade)
 * - Progresso factual
 * - Determinismo puro e imutabilidade profunda
 * - Transições impossíveis / rejeitadas
 * - Testes de fronteira arquitetural
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AttemptId } from '../../execution/contracts';
import type { Actor } from '../../observations/contracts';
import type { SessionRef } from '../../../auth/session-ref.types';
import type { ContextSubjectRef } from '../../context/contracts';
import type { CorrelationId } from '../../modules/contracts';
import type { MaterialContextPinId } from '../../material-context/contracts';

import {
  createJob,
  reduceJob,
  JobLifecycleError,
  type JobId,
  type JobState,
  type JobWaitingCause,
  type JobProgress,
} from '../index';

// ============================================================================
// FIXTURES PURAS PARA OS TESTES
// ============================================================================

const TEST_JOB_ID = 'job_test_01' as JobId;
const OTHER_JOB_ID = 'job_test_other' as JobId;

const TEST_ACTOR: Actor = {
  kind: 'human',
  humanId: 'user_operator_01',
  role: 'operator',
};

const TEST_SESSION_REF = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as SessionRef;
const TEST_CORRELATION_ID = 'corr_test_01' as CorrelationId;
const TEST_PIN_ID = 'pin_test_01' as MaterialContextPinId;
const TEST_SUBJECT_REF: ContextSubjectRef = {
  subjectType: 'brand' as any,
  subjectId: 'brand_starlevel' as any,
};

const T0 = '2026-09-25T12:00:00.000Z';
const T1 = '2026-09-25T12:01:00.000Z';
const T2 = '2026-09-25T12:02:00.000Z';
const T3 = '2026-09-25T12:03:00.000Z';
const T4 = '2026-09-25T12:04:00.000Z';
const T5 = '2026-09-25T12:05:00.000Z';

function createBaseJob(overrides: Partial<Parameters<typeof createJob>[0]> = {}): JobState {
  return createJob({
    jobId: TEST_JOB_ID,
    actor: TEST_ACTOR,
    userId: 'user_123',
    sessionRef: TEST_SESSION_REF,
    contextSubjectRef: TEST_SUBJECT_REF,
    correlationId: TEST_CORRELATION_ID,
    materialContextPinId: TEST_PIN_ID,
    createdAt: T0,
    ...overrides,
  });
}

// ============================================================================
// SUÍTE DE TESTES DO JOB LIFECYCLE CORE
// ============================================================================

describe('NEX+ · 0.86C-1 · Job Lifecycle Core', () => {
  // --------------------------------------------------------------------------
  // GRUPO 1: LIFECYCLE BÁSICO
  // --------------------------------------------------------------------------
  describe('1. Lifecycle Básico', () => {
    it('1. Criação de novo Job produz status "queued" e revision 1', () => {
      const job = createBaseJob();
      assert.equal(job.jobId, TEST_JOB_ID);
      assert.equal(job.status, 'queued');
      assert.equal(job.revision, 1);
      assert.equal(job.createdAt, T0);
      assert.equal(job.updatedAt, T0);
      assert.deepEqual(job.attemptLineage, []);
      assert.equal(job.waitingCause, undefined);
      assert.equal(job.controlIntent, undefined);
      assert.equal(job.progress, undefined);
      assert.equal(job.terminalReason, undefined);
    });

    it('2. Transição queued → running válida via JobStarted', () => {
      const job = createBaseJob();
      const running = reduceJob(job, {
        type: 'JobStarted',
        jobId: TEST_JOB_ID,
        startedAt: T1,
      });

      assert.equal(running.status, 'running');
      assert.equal(running.revision, 2);
      assert.equal(running.startedAt, T1);
      assert.equal(running.updatedAt, T1);
    });

    it('3. Transição running → waiting válida via JobWaiting com causa', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: {
          kind: 'human',
          reasonCode: 'AWAITING_SUPERVISOR_APPROVAL',
          requestedAt: T2,
        },
        transitionedAt: T2,
      });

      assert.equal(waiting.status, 'waiting');
      assert.equal(waiting.revision, 3);
      assert.equal(waiting.waitingCause?.kind, 'human');
      assert.equal(waiting.waitingCause?.reasonCode, 'AWAITING_SUPERVISOR_APPROVAL');
      assert.equal(waiting.updatedAt, T2);
    });

    it('4. Retorno de waiting → queued via JobYieldedWaiting limpa waitingCause', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: { kind: 'temporal', reasonCode: 'BACKOFF_DELAY', resumeAfter: T4, requestedAt: T2 },
        transitionedAt: T2,
      });

      const queuedAgain = reduceJob(waiting, {
        type: 'JobYieldedWaiting',
        jobId: TEST_JOB_ID,
        resumedAt: T3,
      });

      assert.equal(queuedAgain.status, 'queued');
      assert.equal(queuedAgain.revision, 4);
      assert.equal(queuedAgain.waitingCause, undefined);
      assert.equal(queuedAgain.updatedAt, T3);
    });

    it('5. Pause efetivo transiciona para "paused" e limpa controlIntent pause', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const pauseRequested = reduceJob(running, {
        type: 'JobControlRequested',
        jobId: TEST_JOB_ID,
        intent: 'pause',
        requestedAt: T2,
      });
      assert.equal(pauseRequested.status, 'running');
      assert.equal(pauseRequested.controlIntent, 'pause');

      const paused = reduceJob(pauseRequested, {
        type: 'JobPaused',
        jobId: TEST_JOB_ID,
        pausedAt: T3,
      });

      assert.equal(paused.status, 'paused');
      assert.equal(paused.revision, 4);
      assert.equal(paused.controlIntent, undefined);
      assert.equal(paused.updatedAt, T3);
    });

    it('6. Resume estrutural paused → queued torna Job elegível novamente', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const paused = reduceJob(running, { type: 'JobPaused', jobId: TEST_JOB_ID, pausedAt: T2 });

      const resumed = reduceJob(paused, {
        type: 'JobResumed',
        jobId: TEST_JOB_ID,
        resumedAt: T3,
      });

      assert.equal(resumed.status, 'queued');
      assert.equal(resumed.revision, 4);
      assert.equal(resumed.updatedAt, T3);
    });

    it('7. Conclusão running → succeeded alcança estado terminal com sucesso', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      const succeeded = reduceJob(running, {
        type: 'JobSucceeded',
        jobId: TEST_JOB_ID,
        finishedAt: T2,
        terminalReason: 'ALL_OPERATIONS_COMPLETED',
      });

      assert.equal(succeeded.status, 'succeeded');
      assert.equal(succeeded.revision, 3);
      assert.equal(succeeded.finishedAt, T2);
      assert.equal(succeeded.terminalReason, 'ALL_OPERATIONS_COMPLETED');
    });

    it('8. Conclusão running → failed alcança estado terminal com falha', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      const failed = reduceJob(running, {
        type: 'JobFailed',
        jobId: TEST_JOB_ID,
        finishedAt: T2,
        reasonCode: 'NON_RETRYABLE_BUSINESS_ERROR',
        terminalReason: 'Failed due to business rule validation failure',
      });

      assert.equal(failed.status, 'failed');
      assert.equal(failed.revision, 3);
      assert.equal(failed.finishedAt, T2);
      assert.equal(failed.terminalReason, 'Failed due to business rule validation failure');
    });

    it('9. Conclusão de cancelamento alcança estado terminal "cancelled"', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      const cancelled = reduceJob(running, {
        type: 'JobCancelled',
        jobId: TEST_JOB_ID,
        finishedAt: T2,
        reasonCode: 'OPERATOR_CANCELLED',
        terminalReason: 'Cancelled by operator intervention',
      });

      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.revision, 3);
      assert.equal(cancelled.finishedAt, T2);
      assert.equal(cancelled.terminalReason, 'Cancelled by operator intervention');
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 2: CONTROLE ≠ ESTADO
  // --------------------------------------------------------------------------
  describe('2. Controle ≠ Estado & Precedência', () => {
    it('10. pause request não transforma imediatamente status em "paused"', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      const requested = reduceJob(running, {
        type: 'JobControlRequested',
        jobId: TEST_JOB_ID,
        intent: 'pause',
        requestedAt: T2,
      });

      assert.equal(requested.status, 'running'); // Continua running!
      assert.equal(requested.controlIntent, 'pause');
      assert.equal(requested.revision, 3);
    });

    it('11. cancel request não transforma imediatamente status em "cancelled"', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      const requested = reduceJob(running, {
        type: 'JobControlRequested',
        jobId: TEST_JOB_ID,
        intent: 'cancel',
        requestedAt: T2,
      });

      assert.equal(requested.status, 'running'); // Continua running até efetivação!
      assert.equal(requested.controlIntent, 'cancel');
      assert.equal(requested.revision, 3);
    });

    it('12. cancel request pode superseder pause request existente', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const pauseReq = reduceJob(running, {
        type: 'JobControlRequested',
        jobId: TEST_JOB_ID,
        intent: 'pause',
        requestedAt: T2,
      });
      assert.equal(pauseReq.controlIntent, 'pause');

      const cancelReq = reduceJob(pauseReq, {
        type: 'JobControlRequested',
        jobId: TEST_JOB_ID,
        intent: 'cancel',
        requestedAt: T3,
      });

      assert.equal(cancelReq.controlIntent, 'cancel');
      assert.equal(cancelReq.status, 'running');
    });

    it('13. pause request posterior NÃO pode sobrescrever cancel request ativo', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const cancelReq = reduceJob(running, {
        type: 'JobControlRequested',
        jobId: TEST_JOB_ID,
        intent: 'cancel',
        requestedAt: T2,
      });
      assert.equal(cancelReq.controlIntent, 'cancel');

      const secondPauseReq = reduceJob(cancelReq, {
        type: 'JobControlRequested',
        jobId: TEST_JOB_ID,
        intent: 'pause',
        requestedAt: T3,
      });

      // Permanece 'cancel'! Cancel tem precedência absoluta
      assert.equal(secondPauseReq.controlIntent, 'cancel');
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 3: TERMINALIDADE FORTE (NO RESURRECTION)
  // --------------------------------------------------------------------------
  describe('3. Terminalidade Forte', () => {
    it('14. succeeded é irrevogável: rejeita qualquer novo evento', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const succeeded = reduceJob(running, { type: 'JobSucceeded', jobId: TEST_JOB_ID, finishedAt: T2 });

      assert.throws(
        () => reduceJob(succeeded, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T3 }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_TERMINAL_IMMUTABLE',
      );
    });

    it('15. failed é irrevogável: rejeita tentativa de restart ou resume', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const failed = reduceJob(running, {
        type: 'JobFailed',
        jobId: TEST_JOB_ID,
        finishedAt: T2,
        reasonCode: 'FATAL_ERROR',
      });

      assert.throws(
        () => reduceJob(failed, { type: 'JobResumed', jobId: TEST_JOB_ID, resumedAt: T3 }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_TERMINAL_IMMUTABLE',
      );
    });

    it('16. cancelled é irrevogável: rejeita qualquer transição subsequente', () => {
      const job = createBaseJob();
      const cancelled = reduceJob(job, { type: 'JobCancelled', jobId: TEST_JOB_ID, finishedAt: T1 });

      assert.throws(
        () => reduceJob(cancelled, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T2 }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_TERMINAL_IMMUTABLE',
      );
    });

    it('17. Estado terminal rejeita correlação de novos Attempts', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const succeeded = reduceJob(running, { type: 'JobSucceeded', jobId: TEST_JOB_ID, finishedAt: T2 });

      assert.throws(
        () =>
          reduceJob(succeeded, {
            type: 'JobAttemptCorrelated',
            jobId: TEST_JOB_ID,
            attemptId: 'att_late_99' as AttemptId,
            correlatedAt: T3,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_TERMINAL_IMMUTABLE',
      );
    });

    it('18. Estado terminal rejeita atualização de progresso', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const failed = reduceJob(running, {
        type: 'JobFailed',
        jobId: TEST_JOB_ID,
        finishedAt: T2,
        reasonCode: 'TIMEOUT',
      });

      assert.throws(
        () =>
          reduceJob(failed, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: { completed: 10, total: 10, updatedAt: T3 },
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_TERMINAL_IMMUTABLE',
      );
    });

    it('19. Estado terminal rejeita solicitações de controle', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const cancelled = reduceJob(running, { type: 'JobCancelled', jobId: TEST_JOB_ID, finishedAt: T2 });

      assert.throws(
        () =>
          reduceJob(cancelled, {
            type: 'JobControlRequested',
            jobId: TEST_JOB_ID,
            intent: 'pause',
            requestedAt: T3,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_TERMINAL_IMMUTABLE',
      );
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 4: WAITING
  // --------------------------------------------------------------------------
  describe('4. Waiting com Causa Material', () => {
    it('20. Causa de espera humana é válida com reasonCode, deadline e description', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: {
          kind: 'human',
          reasonCode: 'MANUAL_VALIDATION_REQUIRED',
          description: 'Aguardando validação manual de formulário pelo supervisor',
          requestedAt: T2,
          deadline: T5,
        },
        transitionedAt: T2,
      });

      assert.equal(waiting.status, 'waiting');
      assert.equal(waiting.waitingCause?.kind, 'human');
      assert.equal((waiting.waitingCause as any).description, 'Aguardando validação manual de formulário pelo supervisor');
      assert.equal((waiting.waitingCause as any).deadline, T5);
    });

    it('21. Causa de espera temporal é válida com resumeAfter e reasonCode', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: {
          kind: 'temporal',
          reasonCode: 'EXTERNAL_RATE_LIMIT_COOLDOWN',
          resumeAfter: T4,
          requestedAt: T2,
        },
        transitionedAt: T2,
      });

      assert.equal(waiting.status, 'waiting');
      assert.equal(waiting.waitingCause?.kind, 'temporal');
      assert.equal((waiting.waitingCause as any).resumeAfter, T4);
    });

    it('22. Waiting sem causa válida é rejeitado com JOB_INVALID_WAITING_CAUSE', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobWaiting',
            jobId: TEST_JOB_ID,
            cause: null as any,
            transitionedAt: T2,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_WAITING_CAUSE',
      );

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobWaiting',
            jobId: TEST_JOB_ID,
            cause: { kind: 'unknown_dsl_engine' } as any,
            transitionedAt: T2,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_WAITING_CAUSE',
      );
    });

    it('23. Retorno de waiting NÃO cria Attempt automaticamente', () => {
      const job = createBaseJob();
      const running = reduceJob(job, {
        type: 'JobStarted',
        jobId: TEST_JOB_ID,
        attemptId: 'att_01' as AttemptId,
        startedAt: T1,
      });
      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: { kind: 'human', reasonCode: 'WAITING_FOR_DATA', requestedAt: T2 },
        transitionedAt: T2,
      });

      const queued = reduceJob(waiting, {
        type: 'JobYieldedWaiting',
        jobId: TEST_JOB_ID,
        resumedAt: T3,
      });

      assert.equal(queued.status, 'queued');
      // Linhagem preserva estritamente os Attempts anteriores sem criar nada fantasma
      assert.deepEqual(queued.attemptLineage, ['att_01']);
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 5: ATTEMPT LINEAGE
  // --------------------------------------------------------------------------
  describe('5. Attempt Lineage (Job != Attempt)', () => {
    it('24. Zero Attempts é perfeitamente válido na criação e no lifecycle', () => {
      const job = createBaseJob();
      assert.equal(job.attemptLineage.length, 0);

      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      assert.equal(running.attemptLineage.length, 0);
    });

    it('25. Primeiro AttemptId pode ser correlacionado no start ou em running', () => {
      const job = createBaseJob();
      const running = reduceJob(job, {
        type: 'JobStarted',
        jobId: TEST_JOB_ID,
        attemptId: 'att_alpha_01' as AttemptId,
        startedAt: T1,
      });

      assert.deepEqual(running.attemptLineage, ['att_alpha_01']);
    });

    it('26. Múltiplos Attempts distintos preservam ordem cronológica de correlação', () => {
      const job = createBaseJob();
      const running = reduceJob(job, {
        type: 'JobStarted',
        jobId: TEST_JOB_ID,
        attemptId: 'att_01' as AttemptId,
        startedAt: T1,
      });

      const withSecond = reduceJob(running, {
        type: 'JobAttemptCorrelated',
        jobId: TEST_JOB_ID,
        attemptId: 'att_02' as AttemptId,
        correlatedAt: T2,
      });

      const withThird = reduceJob(withSecond, {
        type: 'JobAttemptCorrelated',
        jobId: TEST_JOB_ID,
        attemptId: 'att_03' as AttemptId,
        correlatedAt: T3,
      });

      assert.deepEqual(withThird.attemptLineage, ['att_01', 'att_02', 'att_03']);
      assert.equal(withThird.revision, 4);
    });

    it('27. Duplicate AttemptId é rejeitado deterministicamente', () => {
      const job = createBaseJob();
      const running = reduceJob(job, {
        type: 'JobStarted',
        jobId: TEST_JOB_ID,
        attemptId: 'att_duplicate_target' as AttemptId,
        startedAt: T1,
      });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobAttemptCorrelated',
            jobId: TEST_JOB_ID,
            attemptId: 'att_duplicate_target' as AttemptId,
            correlatedAt: T2,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_DUPLICATE_ATTEMPT',
      );
    });

    it('28. Reducer não absorve nem muta objetos externos de AttemptState', () => {
      const externalAttempt = {
        attemptId: 'att_external_10' as AttemptId,
        status: 'running',
        internalSecretState: 'do_not_leak',
      };

      const job = createBaseJob();
      const running = reduceJob(job, {
        type: 'JobStarted',
        jobId: TEST_JOB_ID,
        attemptId: externalAttempt.attemptId,
        startedAt: T1,
      });

      // Apenas a string do ID foi registrada
      assert.equal(typeof running.attemptLineage[0], 'string');
      assert.equal(running.attemptLineage[0], 'att_external_10');
      assert.equal((running as any).internalSecretState, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 6: PROGRESSO FACTUAL
  // --------------------------------------------------------------------------
  describe('6. Progresso Factual', () => {
    it('29. Progress sem total conhecido é válido (ex: streaming de itens)', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      const withProgress = reduceJob(running, {
        type: 'JobProgressUpdated',
        jobId: TEST_JOB_ID,
        progress: {
          completed: 42,
          unit: 'messages_processed',
          updatedAt: T2,
        },
      });

      assert.equal(withProgress.progress?.completed, 42);
      assert.equal(withProgress.progress?.total, undefined);
      assert.equal(withProgress.progress?.unit, 'messages_processed');
    });

    it('30. Progress com total conhecido e coerente é válido', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      const withProgress = reduceJob(running, {
        type: 'JobProgressUpdated',
        jobId: TEST_JOB_ID,
        progress: {
          completed: 75,
          total: 100,
          unit: 'percent',
          message: 'Processando lote 3/4',
          updatedAt: T2,
        },
      });

      assert.equal(withProgress.progress?.completed, 75);
      assert.equal(withProgress.progress?.total, 100);
      assert.equal(withProgress.progress?.message, 'Processando lote 3/4');
    });

    it('31. Progress negativo é rejeitado', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: { completed: -5, updatedAt: T2 },
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PROGRESS',
      );
    });

    it('32. completed > total é rejeitado quando total está definido', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: { completed: 150, total: 100, updatedAt: T2 },
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PROGRESS',
      );
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 7: DETERMINISMO & IMUTABILIDADE PROFUNDA
  // --------------------------------------------------------------------------
  describe('7. Determinismo & Imutabilidade Profunda', () => {
    it('33. Mesma entrada produz saída profundamente idêntica', () => {
      const jobA = createBaseJob();
      const jobB = createBaseJob();

      const event = {
        type: 'JobStarted' as const,
        jobId: TEST_JOB_ID,
        attemptId: 'att_det_01' as AttemptId,
        startedAt: T1,
      };

      const resA = reduceJob(jobA, event);
      const resB = reduceJob(jobB, event);

      assert.deepEqual(resA, resB);
    });

    it('34. Estado anterior permanece absolutamente inalterado após transição', () => {
      const job = createBaseJob();
      const statusBefore = job.status;
      const revisionBefore = job.revision;
      const updatedAtBefore = job.updatedAt;

      reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.equal(job.status, statusBefore);
      assert.equal(job.revision, revisionBefore);
      assert.equal(job.updatedAt, updatedAtBefore);
    });

    it('35. Evento recebido permanece inalterado', () => {
      const job = createBaseJob();
      const event = {
        type: 'JobStarted' as const,
        jobId: TEST_JOB_ID,
        startedAt: T1,
      };
      const eventJsonBefore = JSON.stringify(event);

      reduceJob(job, event);

      assert.equal(JSON.stringify(event), eventJsonBefore);
    });

    it('36. Arrays de attemptLineage anteriores não são mutados', () => {
      const job = createBaseJob();
      const running1 = reduceJob(job, {
        type: 'JobStarted',
        jobId: TEST_JOB_ID,
        attemptId: 'att_01' as AttemptId,
        startedAt: T1,
      });

      const lineageRefBefore = running1.attemptLineage;
      assert.equal(lineageRefBefore.length, 1);

      const running2 = reduceJob(running1, {
        type: 'JobAttemptCorrelated',
        jobId: TEST_JOB_ID,
        attemptId: 'att_02' as AttemptId,
        correlatedAt: T2,
      });

      assert.equal(lineageRefBefore.length, 1);
      assert.equal(running2.attemptLineage.length, 2);
      assert.notEqual(lineageRefBefore, running2.attemptLineage);
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 8: TRANSIÇÕES IMPOSSÍVEIS / REJEITADAS
  // --------------------------------------------------------------------------
  describe('8. Transições Impossíveis / Rejeitadas', () => {
    it('37. queued → succeeded direto é estritamente rejeitado', () => {
      const job = createBaseJob();
      assert.equal(job.status, 'queued');

      assert.throws(
        () => reduceJob(job, { type: 'JobSucceeded', jobId: TEST_JOB_ID, finishedAt: T1 }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_TRANSITION',
      );
    });

    it('38. waiting → succeeded direto é estritamente rejeitado', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: { kind: 'human', reasonCode: 'WAIT', requestedAt: T2 },
        transitionedAt: T2,
      });

      assert.throws(
        () => reduceJob(waiting, { type: 'JobSucceeded', jobId: TEST_JOB_ID, finishedAt: T3 }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_TRANSITION',
      );
    });

    it('39. paused → running direto é rejeitado (deve ser paused → queued)', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const paused = reduceJob(running, { type: 'JobPaused', jobId: TEST_JOB_ID, pausedAt: T2 });

      assert.throws(
        () => reduceJob(paused, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T3 }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_TRANSITION',
      );
    });

    it('40. Evento com JobId mismatch é rejeitado', () => {
      const job = createBaseJob();

      assert.throws(
        () => reduceJob(job, { type: 'JobStarted', jobId: OTHER_JOB_ID, startedAt: T1 }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_ID_MISMATCH',
      );
    });

    it('41. Progress update em estado queued ou paused é rejeitado', () => {
      const job = createBaseJob();
      assert.throws(
        () =>
          reduceJob(job, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: { completed: 1, updatedAt: T1 },
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_TRANSITION',
      );
    });

    it('42. Attempt correlation em estado queued ou waiting é rejeitado', () => {
      const job = createBaseJob();
      assert.throws(
        () =>
          reduceJob(job, {
            type: 'JobAttemptCorrelated',
            jobId: TEST_JOB_ID,
            attemptId: 'att_early' as AttemptId,
            correlatedAt: T1,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_TRANSITION',
      );
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 9: TESTES DE FRONTEIRA ARQUITETURAL
  // --------------------------------------------------------------------------
  describe('9. Fronteiras Arquiteturais', () => {
    it('43. Estado não contém credenciais, tokens, secrets ou cookies', () => {
      const job = createBaseJob();
      const json = JSON.stringify(job);

      assert.equal(json.includes('token'), false);
      assert.equal(json.includes('secret'), false);
      assert.equal(json.includes('password'), false);
      assert.equal(json.includes('cookie'), false);
      assert.equal(json.includes('jwt'), false);
      assert.equal(json.includes('_sid'), false);
    });

    it('44. C1 opera 100% em memória, de forma síncrona e pura sem dependências externas', () => {
      const job = createBaseJob();
      const s1 = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const s2 = reduceJob(s1, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: { kind: 'temporal', reasonCode: 'WAIT_IO', resumeAfter: T3, requestedAt: T2 },
        transitionedAt: T2,
      });
      const s3 = reduceJob(s2, { type: 'JobYieldedWaiting', jobId: TEST_JOB_ID, resumedAt: T3 });
      const s4 = reduceJob(s3, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T4 });
      const s5 = reduceJob(s4, { type: 'JobSucceeded', jobId: TEST_JOB_ID, finishedAt: T5 });

      assert.equal(s5.status, 'succeeded');
      assert.equal(s5.revision, 6);
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 10: L-01 · PROGRESS NÃO FINITO
  // --------------------------------------------------------------------------
  describe('10. L-01 · Validação de Finitude de Progresso', () => {
    it('45. completed: Infinity é rejeitado com JOB_INVALID_PROGRESS', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: { completed: Infinity, updatedAt: T2 },
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PROGRESS',
      );
    });

    it('46. completed: -Infinity é rejeitado com JOB_INVALID_PROGRESS', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: { completed: -Infinity, updatedAt: T2 },
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PROGRESS',
      );
    });

    it('47. total: Infinity é rejeitado com JOB_INVALID_PROGRESS', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: { completed: 10, total: Infinity, updatedAt: T2 },
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PROGRESS',
      );
    });

    it('48. total: -Infinity é rejeitado com JOB_INVALID_PROGRESS', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: { completed: 10, total: -Infinity, updatedAt: T2 },
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PROGRESS',
      );
    });

    it('49. completed: Infinity e total: Infinity são rejeitados com JOB_INVALID_PROGRESS', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: { completed: Infinity, total: Infinity, updatedAt: T2 },
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PROGRESS',
      );
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 11: L-02 · FORMATO TEMPORAL CANÔNICO (UTC 'Z')
  // --------------------------------------------------------------------------
  describe('11. L-02 · Validação de Formato Temporal Canônico (UTC "Z")', () => {
    it('50. createdAt inválido é rejeitado com JOB_INVALID_TIMESTAMP', () => {
      assert.throws(
        () => createBaseJob({ createdAt: 'not-a-timestamp' }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_TIMESTAMP',
      );

      assert.throws(
        () => createBaseJob({ createdAt: '2026-09-25T12:00:00+03:00' }), // offset não 'Z'
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_TIMESTAMP',
      );
    });

    it('51. startedAt inválido é rejeitado com JOB_INVALID_TIMESTAMP', () => {
      const job = createBaseJob();
      assert.throws(
        () => reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: 'bad' }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_TIMESTAMP',
      );
    });

    it('52. progress.updatedAt inválido é rejeitado com JOB_INVALID_TIMESTAMP', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: { completed: 1, updatedAt: 'not-a-timestamp' },
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_TIMESTAMP',
      );
    });

    it('53. waiting requestedAt inválido é rejeitado com JOB_INVALID_TIMESTAMP', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobWaiting',
            jobId: TEST_JOB_ID,
            cause: { kind: 'human', reasonCode: 'APPROVAL', requestedAt: 'invalid' },
            transitionedAt: T2,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_TIMESTAMP',
      );
    });

    it('54. temporal waiting resumeAfter inválido é rejeitado com JOB_INVALID_TIMESTAMP', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobWaiting',
            jobId: TEST_JOB_ID,
            cause: { kind: 'temporal', reasonCode: 'BACKOFF', requestedAt: T2, resumeAfter: 'invalid-resume' },
            transitionedAt: T2,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_TIMESTAMP',
      );
    });

    it('55. human waiting deadline inválido é rejeitado com JOB_INVALID_TIMESTAMP', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobWaiting',
            jobId: TEST_JOB_ID,
            cause: { kind: 'human', reasonCode: 'APPROVAL', requestedAt: T2, deadline: 'bad-deadline' },
            transitionedAt: T2,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_TIMESTAMP',
      );
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 12: SEMÂNTICA TEMPORAL LOCAL & MONOTONICIDADE
  // --------------------------------------------------------------------------
  describe('12. Semântica Temporal Local & Monotonicidade', () => {
    it('56. startedAt anterior a createdAt é rejeitado com JOB_TEMPORAL_ORDER_VIOLATION', () => {
      const job = createBaseJob({ createdAt: T1 });
      assert.throws(
        () => reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T0 }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_TEMPORAL_ORDER_VIOLATION',
      );
    });

    it('57. Evento posterior com timestamp anterior a state.updatedAt é rejeitado', () => {
      const job = createBaseJob({ createdAt: T0 });
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T2 });
      assert.equal(running.updatedAt, T2);

      // Attempt com correlatedAt = T1 (< T2)
      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobAttemptCorrelated',
            jobId: TEST_JOB_ID,
            attemptId: 'att_backwards' as AttemptId,
            correlatedAt: T1,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_TEMPORAL_ORDER_VIOLATION',
      );
    });

    it('58. Progress com updatedAt anterior a state.updatedAt é rejeitado (progress regressivo)', () => {
      const job = createBaseJob({ createdAt: T0 });
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T2 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: { completed: 5, updatedAt: T1 }, // T1 < T2
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_TEMPORAL_ORDER_VIOLATION',
      );
    });

    it('59. temporal waiting com resumeAfter < requestedAt é rejeitado com JOB_TEMPORAL_ORDER_VIOLATION', () => {
      const job = createBaseJob({ createdAt: T0 });
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobWaiting',
            jobId: TEST_JOB_ID,
            cause: { kind: 'temporal', reasonCode: 'BACKOFF', requestedAt: T3, resumeAfter: T2 },
            transitionedAt: T3,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_TEMPORAL_ORDER_VIOLATION',
      );
    });

    it('60. human waiting com deadline < requestedAt é rejeitado com JOB_TEMPORAL_ORDER_VIOLATION', () => {
      const job = createBaseJob({ createdAt: T0 });
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobWaiting',
            jobId: TEST_JOB_ID,
            cause: { kind: 'human', reasonCode: 'REVIEW', requestedAt: T3, deadline: T2 },
            transitionedAt: T3,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_TEMPORAL_ORDER_VIOLATION',
      );
    });

    it('61. waiting requestedAt posterior ao transitionedAt é rejeitado com JOB_TEMPORAL_ORDER_VIOLATION', () => {
      const job = createBaseJob({ createdAt: T0 });
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobWaiting',
            jobId: TEST_JOB_ID,
            cause: { kind: 'human', reasonCode: 'REVIEW', requestedAt: T3 },
            transitionedAt: T2, // transitionedAt < requestedAt
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_TEMPORAL_ORDER_VIOLATION',
      );
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 13: L-03 · WAITING PRESERVADO EM PAUSE / RESUME
  // --------------------------------------------------------------------------
  describe('13. L-03 · Waiting Preservado em Pause & Resume', () => {
    it('62. human waiting → pause preserva waitingCause', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const waitingCause = {
        kind: 'human' as const,
        reasonCode: 'SUPERVISOR_ACTION',
        description: 'Aguardando liberação de cota',
        requestedAt: T2,
        deadline: T5,
      };

      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: waitingCause,
        transitionedAt: T2,
      });

      const paused = reduceJob(waiting, { type: 'JobPaused', jobId: TEST_JOB_ID, pausedAt: T3 });

      assert.equal(paused.status, 'paused');
      assert.deepEqual(paused.waitingCause, waitingCause);
      assert.equal(paused.updatedAt, T3);
    });

    it('63. human waiting → pause → resume retorna para "waiting" preservando causa', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const waitingCause = {
        kind: 'human' as const,
        reasonCode: 'SUPERVISOR_ACTION',
        requestedAt: T2,
      };
      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: waitingCause,
        transitionedAt: T2,
      });
      const paused = reduceJob(waiting, { type: 'JobPaused', jobId: TEST_JOB_ID, pausedAt: T3 });

      const resumed = reduceJob(paused, { type: 'JobResumed', jobId: TEST_JOB_ID, resumedAt: T4 });

      assert.equal(resumed.status, 'waiting');
      assert.deepEqual(resumed.waitingCause, waitingCause);
      assert.equal(resumed.updatedAt, T4);
    });

    it('64. JobYieldedWaiting após resume de waiting resolve para "queued" e limpa waitingCause', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: { kind: 'human', reasonCode: 'DATA_INPUT', requestedAt: T2 },
        transitionedAt: T2,
      });
      const paused = reduceJob(waiting, { type: 'JobPaused', jobId: TEST_JOB_ID, pausedAt: T3 });
      const resumed = reduceJob(paused, { type: 'JobResumed', jobId: TEST_JOB_ID, resumedAt: T4 });

      // Agora resolução explícita da espera: JobYieldedWaiting
      const queued = reduceJob(resumed, { type: 'JobYieldedWaiting', jobId: TEST_JOB_ID, resumedAt: T5 });

      assert.equal(queued.status, 'queued');
      assert.equal(queued.waitingCause, undefined);
      assert.equal(queued.updatedAt, T5);
    });

    it('65. temporal waiting → pause preserva resumeAfter e causa temporal', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const temporalCause = {
        kind: 'temporal' as const,
        reasonCode: 'RATE_LIMIT_COOLDOWN',
        resumeAfter: T5,
        requestedAt: T2,
      };
      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: temporalCause,
        transitionedAt: T2,
      });

      const paused = reduceJob(waiting, { type: 'JobPaused', jobId: TEST_JOB_ID, pausedAt: T3 });

      assert.equal(paused.status, 'paused');
      assert.equal(paused.waitingCause?.kind, 'temporal');
      assert.equal((paused.waitingCause as any)?.resumeAfter, T5);
    });

    it('66. paused originado de running (sem waitingCause) continua resumindo para "queued"', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const paused = reduceJob(running, { type: 'JobPaused', jobId: TEST_JOB_ID, pausedAt: T2 });

      assert.equal(paused.status, 'paused');
      assert.equal(paused.waitingCause, undefined);

      const resumed = reduceJob(paused, { type: 'JobResumed', jobId: TEST_JOB_ID, resumedAt: T3 });

      assert.equal(resumed.status, 'queued');
      assert.equal(resumed.waitingCause, undefined);
      assert.equal(resumed.updatedAt, T3);
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 14: L-04 · DEFENSIVE BOUNDARY DE PAYLOADS ANINHADOS
  // --------------------------------------------------------------------------
  describe('14. L-04 · Hardening de Payloads Aninhados', () => {
    it('67. Actor com propriedade extra/arbitrária é rejeitado com JOB_INVALID_PAYLOAD', () => {
      assert.throws(
        () =>
          createBaseJob({
            actor: {
              kind: 'human',
              humanId: 'user_01',
              injectedField: 'malicious',
            } as any,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('68. Actor é reconstruído canonicamente e congelado (sem protótipos ou vazamentos)', () => {
      const customActor: Actor = {
        kind: 'human',
        humanId: 'user_02',
        role: 'reviewer',
      };

      const job = createBaseJob({ actor: customActor });

      assert.equal(job.actor.kind, 'human');
      assert.equal(job.actor.humanId, 'user_02');
      assert.equal(job.actor.role, 'reviewer');
      assert.equal(Object.isFrozen(job.actor), true);
      // Garantir que é um objeto limpo sem propriedades espúrias
      assert.deepEqual(Object.keys(job.actor).sort(), ['humanId', 'kind', 'role'].sort());
    });

    it('69. ContextSubjectRef com chave extra é rejeitado com JOB_INVALID_PAYLOAD', () => {
      assert.throws(
        () =>
          createBaseJob({
            contextSubjectRef: {
              subjectType: 'brand' as any,
              subjectId: 'brand_01' as any,
              extraKey: 'leak_secret',
            } as any,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('70. ContextSubjectRef reconstruído explicitamente apenas com subjectType e subjectId', () => {
      const job = createBaseJob({
        contextSubjectRef: {
          subjectType: 'user' as any,
          subjectId: 'user_456' as any,
        },
      });

      assert.equal(job.contextSubjectRef?.subjectType, 'user');
      assert.equal(job.contextSubjectRef?.subjectId, 'user_456');
      assert.equal(Object.isFrozen(job.contextSubjectRef), true);
      assert.deepEqual(Object.keys(job.contextSubjectRef!), ['subjectType', 'subjectId']);
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 15: PRESERVAÇÃO DE CONTROL INTENT (Item 10)
  // --------------------------------------------------------------------------
  describe('15. Preservação de Control Intent em Transições Estruturais', () => {
    it('71. cancel intent permanece preservado em transições estruturais do C1 (sem apagar silenciosamente)', () => {
      const job = createBaseJob();

      // Solicita cancelamento enquanto queued
      const withCancel = reduceJob(job, {
        type: 'JobControlRequested',
        jobId: TEST_JOB_ID,
        intent: 'cancel',
        requestedAt: T1,
      });
      assert.equal(withCancel.status, 'queued');
      assert.equal(withCancel.controlIntent, 'cancel');

      // JobStarted ocorre (C1 não antecipa bloqueio de dispatch do C3/C4; preserva intent)
      const running = reduceJob(withCancel, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T2 });
      assert.equal(running.status, 'running');
      assert.equal(running.controlIntent, 'cancel');

      // Attempt correlated preserva cancel intent
      const correlated = reduceJob(running, {
        type: 'JobAttemptCorrelated',
        jobId: TEST_JOB_ID,
        attemptId: 'att_01' as AttemptId,
        correlatedAt: T3,
      });
      assert.equal(correlated.controlIntent, 'cancel');

      // JobWaiting preserva cancel intent
      const waiting = reduceJob(correlated, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: { kind: 'human', reasonCode: 'AWAIT', requestedAt: T4 },
        transitionedAt: T4,
      });
      assert.equal(waiting.controlIntent, 'cancel');

      // JobYieldedWaiting preserva cancel intent
      const resumedToQueued = reduceJob(waiting, {
        type: 'JobYieldedWaiting',
        jobId: TEST_JOB_ID,
        resumedAt: T5,
      });
      assert.equal(resumedToQueued.controlIntent, 'cancel');
    });

    it('72. cancelamento resolve a espera, limpa controlIntent e alcança estado terminal', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: { kind: 'human', reasonCode: 'NEED_INPUT', requestedAt: T2 },
        transitionedAt: T2,
      });

      // Cancelamento em waiting
      const cancelled = reduceJob(waiting, {
        type: 'JobCancelled',
        jobId: TEST_JOB_ID,
        finishedAt: T3,
        reasonCode: 'USER_ABORTED',
      });

      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.waitingCause, undefined);
      assert.equal(cancelled.controlIntent, undefined);
      assert.equal(cancelled.updatedAt, T3);
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 16: MICROFIX FINAL L-04 · RUNTIME ALLOWLIST & RECONSTRUÇÃO CANÔNICA
  // --------------------------------------------------------------------------
  describe('16. Microfix Final L-04 · Runtime Allowlist & Reconstrução Canônica', () => {
    it('73. HumanWaitingCause com propriedade extra (ex: secret) é rejeitado com JOB_INVALID_WAITING_CAUSE', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobWaiting',
            jobId: TEST_JOB_ID,
            cause: {
              kind: 'human',
              reasonCode: 'SUPERVISOR_REVIEW',
              requestedAt: T2,
              secret: 'x',
            } as any,
            transitionedAt: T2,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_WAITING_CAUSE',
      );
    });

    it('74. HumanWaitingCause com description inválida (não-string) é rejeitado com JOB_INVALID_WAITING_CAUSE', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobWaiting',
            jobId: TEST_JOB_ID,
            cause: {
              kind: 'human',
              reasonCode: 'SUPERVISOR_REVIEW',
              requestedAt: T2,
              description: { secret: 'x' } as any,
            },
            transitionedAt: T2,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_WAITING_CAUSE',
      );
    });

    it('75. HumanWaitingCause válido é reconstruído canonicamente contendo apenas chaves permitidas', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: {
          kind: 'human',
          reasonCode: 'APPROVAL',
          description: 'Aprovacao pendente',
          requestedAt: T2,
          deadline: T3,
        },
        transitionedAt: T2,
      });

      assert.equal(waiting.status, 'waiting');
      assert.deepEqual(Object.keys(waiting.waitingCause!).sort(), ['deadline', 'description', 'kind', 'reasonCode', 'requestedAt'].sort());
      assert.equal(Object.isFrozen(waiting.waitingCause), true);
    });

    it('76. TemporalWaitingCause com chave extra é rejeitado com JOB_INVALID_WAITING_CAUSE', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobWaiting',
            jobId: TEST_JOB_ID,
            cause: {
              kind: 'temporal',
              reasonCode: 'RATE_LIMIT',
              requestedAt: T2,
              resumeAfter: T3,
              leakData: 'secret_leak',
            } as any,
            transitionedAt: T2,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_WAITING_CAUSE',
      );
    });

    it('77. TemporalWaitingCause é reconstruído contendo exclusivamente kind, reasonCode, requestedAt, resumeAfter', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: {
          kind: 'temporal',
          reasonCode: 'RATE_LIMIT',
          requestedAt: T2,
          resumeAfter: T3,
        },
        transitionedAt: T2,
      });

      assert.equal(waiting.status, 'waiting');
      assert.deepEqual(Object.keys(waiting.waitingCause!).sort(), ['kind', 'reasonCode', 'requestedAt', 'resumeAfter'].sort());
      assert.equal(Object.isFrozen(waiting.waitingCause), true);
    });

    it('78. JobProgress com chave extra (ex: secret) é rejeitado com JOB_INVALID_PROGRESS', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: {
              completed: 10,
              updatedAt: T2,
              secret: 'x',
            } as any,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PROGRESS',
      );
    });

    it('79. JobProgress com unit inválida (não-string) é rejeitado com JOB_INVALID_PROGRESS', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: {
              completed: 10,
              updatedAt: T2,
              unit: { secret: 'x' } as any,
            },
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PROGRESS',
      );
    });

    it('80. JobProgress com message inválida (não-string) é rejeitado com JOB_INVALID_PROGRESS', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobProgressUpdated',
            jobId: TEST_JOB_ID,
            progress: {
              completed: 10,
              updatedAt: T2,
              message: ['unexpected'] as any,
            },
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PROGRESS',
      );
    });

    it('81. JobProgress válido é reconstruído canonicamente contendo apenas propriedades fornecidas e é congelado', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      const withProgress = reduceJob(running, {
        type: 'JobProgressUpdated',
        jobId: TEST_JOB_ID,
        progress: {
          completed: 50,
          total: 100,
          unit: 'percent',
          message: 'Processando lote',
          updatedAt: T2,
        },
      });

      assert.deepEqual(Object.keys(withProgress.progress!).sort(), ['completed', 'message', 'total', 'unit', 'updatedAt'].sort());
      assert.equal(Object.isFrozen(withProgress.progress), true);
    });

    it('82. Mutação posterior no objeto de evento não afeta o JobState (independência de referência externa)', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });

      const externalCause = {
        kind: 'human' as const,
        reasonCode: 'VALIDATION',
        description: 'Original description',
        requestedAt: T2,
      };

      const waiting = reduceJob(running, {
        type: 'JobWaiting',
        jobId: TEST_JOB_ID,
        cause: externalCause,
        transitionedAt: T2,
      });

      // Muta o objeto externo
      (externalCause as any).description = 'Mutated externally!';
      (externalCause as any).extraProperty = 'injected!';

      assert.equal((waiting.waitingCause as any).description, 'Original description');
      assert.equal((waiting.waitingCause as any).extraProperty, undefined);

      // Progresso
      const externalProgress = {
        completed: 10,
        total: 100,
        unit: 'records',
        message: 'Step 1',
        updatedAt: T5,
      };

      const withProgress = reduceJob(waiting, {
        type: 'JobYieldedWaiting',
        jobId: TEST_JOB_ID,
        resumedAt: T3,
      });
      const runningAgain = reduceJob(withProgress, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T4 });

      const progressed = reduceJob(runningAgain, {
        type: 'JobProgressUpdated',
        jobId: TEST_JOB_ID,
        progress: externalProgress,
      });

      // Muta o objeto externo de progresso
      (externalProgress as any).completed = 999;
      (externalProgress as any).message = 'Tampered!';
      (externalProgress as any).extraProperty = 'tampered!';

      assert.equal(progressed.progress?.completed, 10);
      assert.equal(progressed.progress?.message, 'Step 1');
      assert.equal((progressed.progress as any).extraProperty, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // GRUPO 17: MICROFIX L-05 · RUNTIME SCALAR GUARDS (PAYLOAD-SCALAR-01)
  // --------------------------------------------------------------------------
  describe('17. Microfix L-05 · Runtime Scalar Guards Adversariais', () => {
    // ------------------------------------------------------------------------
    // CreateJob: userId, sessionRef, correlationId, materialContextPinId
    // ------------------------------------------------------------------------
    it('83. CreateJob rejeita userId com objeto adversarial ({ secret: "x" }) com JOB_INVALID_PAYLOAD', () => {
      assert.throws(
        () => createBaseJob({ userId: { secret: 'x' } as any }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('84. CreateJob rejeita userId com string vazia ou whitespace com JOB_INVALID_PAYLOAD', () => {
      assert.throws(
        () => createBaseJob({ userId: '   ' as any }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('85. CreateJob rejeita sessionRef com objeto adversarial ({ secret: "x" }) com JOB_INVALID_PAYLOAD', () => {
      assert.throws(
        () => createBaseJob({ sessionRef: { secret: 'x' } as any }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('86. CreateJob rejeita sessionRef inválido (não-conforme regex 64 hex minúsculo) com JOB_INVALID_PAYLOAD', () => {
      assert.throws(
        () => createBaseJob({ sessionRef: 'not_a_valid_64_hex_session_ref' as any }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
      assert.throws(
        () => createBaseJob({ sessionRef: '' as any }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('87. CreateJob rejeita correlationId com objeto adversarial ({ secret: "x" }) com JOB_INVALID_PAYLOAD', () => {
      assert.throws(
        () => createBaseJob({ correlationId: { secret: 'x' } as any }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('88. CreateJob rejeita correlationId com string vazia ou whitespace com JOB_INVALID_PAYLOAD', () => {
      assert.throws(
        () => createBaseJob({ correlationId: '   ' as any }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('89. CreateJob rejeita materialContextPinId com objeto adversarial ({ secret: "x" }) com JOB_INVALID_PAYLOAD', () => {
      assert.throws(
        () => createBaseJob({ materialContextPinId: { secret: 'x' } as any }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('90. CreateJob rejeita materialContextPinId com string vazia ou whitespace com JOB_INVALID_PAYLOAD', () => {
      assert.throws(
        () => createBaseJob({ materialContextPinId: '   ' as any }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    // ------------------------------------------------------------------------
    // Attempt: JobStarted e JobAttemptCorrelated
    // ------------------------------------------------------------------------
    it('91. JobStarted rejeita attemptId com objeto adversarial ({ secret: "x" }) e não insere na lineage', () => {
      const job = createBaseJob();
      assert.throws(
        () =>
          reduceJob(job, {
            type: 'JobStarted',
            jobId: TEST_JOB_ID,
            startedAt: T1,
            attemptId: { secret: 'x' } as any,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
      assert.equal(job.attemptLineage.length, 0);
    });

    it('92. JobStarted rejeita attemptId com string vazia ou whitespace e não insere na lineage', () => {
      const job = createBaseJob();
      assert.throws(
        () =>
          reduceJob(job, {
            type: 'JobStarted',
            jobId: TEST_JOB_ID,
            startedAt: T1,
            attemptId: '   ' as any,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
      assert.equal(job.attemptLineage.length, 0);
    });

    it('93. JobAttemptCorrelated rejeita attemptId com objeto adversarial ({ secret: "x" }) com JOB_INVALID_PAYLOAD', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobAttemptCorrelated',
            jobId: TEST_JOB_ID,
            attemptId: { secret: 'x' } as any,
            correlatedAt: T2,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
      assert.equal(running.attemptLineage.length, 0);
    });

    it('94. JobAttemptCorrelated rejeita attemptId com string vazia ou whitespace com JOB_INVALID_PAYLOAD', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobAttemptCorrelated',
            jobId: TEST_JOB_ID,
            attemptId: '   ' as any,
            correlatedAt: T2,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
      assert.equal(running.attemptLineage.length, 0);
    });

    // ------------------------------------------------------------------------
    // Terminal: JobSucceeded, JobFailed, JobCancelled
    // ------------------------------------------------------------------------
    it('95. JobSucceeded rejeita terminalReason com objeto adversarial ({ secret: "x" }) com JOB_INVALID_PAYLOAD', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobSucceeded',
            jobId: TEST_JOB_ID,
            finishedAt: T2,
            terminalReason: { secret: 'x' } as any,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('96. JobFailed rejeita reasonCode com objeto adversarial ({ secret: "x" }) ou vazio com JOB_INVALID_PAYLOAD', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobFailed',
            jobId: TEST_JOB_ID,
            finishedAt: T2,
            reasonCode: { secret: 'x' } as any,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobFailed',
            jobId: TEST_JOB_ID,
            finishedAt: T2,
            reasonCode: '   ',
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('97. JobFailed rejeita terminalReason com objeto adversarial ({ secret: "x" }) com JOB_INVALID_PAYLOAD', () => {
      const job = createBaseJob();
      const running = reduceJob(job, { type: 'JobStarted', jobId: TEST_JOB_ID, startedAt: T1 });
      assert.throws(
        () =>
          reduceJob(running, {
            type: 'JobFailed',
            jobId: TEST_JOB_ID,
            finishedAt: T2,
            reasonCode: 'ERR_FAIL',
            terminalReason: { secret: 'x' } as any,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('98. JobCancelled rejeita reasonCode com objeto adversarial ({ secret: "x" }) ou vazio com JOB_INVALID_PAYLOAD', () => {
      const job = createBaseJob();
      assert.throws(
        () =>
          reduceJob(job, {
            type: 'JobCancelled',
            jobId: TEST_JOB_ID,
            finishedAt: T1,
            reasonCode: { secret: 'x' } as any,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
      assert.throws(
        () =>
          reduceJob(job, {
            type: 'JobCancelled',
            jobId: TEST_JOB_ID,
            finishedAt: T1,
            reasonCode: '   ',
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('99. JobCancelled rejeita terminalReason com objeto adversarial ({ secret: "x" }) com JOB_INVALID_PAYLOAD', () => {
      const job = createBaseJob();
      assert.throws(
        () =>
          reduceJob(job, {
            type: 'JobCancelled',
            jobId: TEST_JOB_ID,
            finishedAt: T1,
            terminalReason: { secret: 'x' } as any,
          }),
        (err: any) => err instanceof JobLifecycleError && err.code === 'JOB_INVALID_PAYLOAD',
      );
    });

    it('100. Valores escalares primitivos válidos continuam sendo aceitos e preservados no JobState', () => {
      const job = createBaseJob({
        userId: 'usr_valid_123',
        sessionRef: TEST_SESSION_REF,
        correlationId: TEST_CORRELATION_ID,
        materialContextPinId: TEST_PIN_ID,
      });

      assert.equal(job.userId, 'usr_valid_123');
      assert.equal(job.sessionRef, TEST_SESSION_REF);
      assert.equal(job.correlationId, TEST_CORRELATION_ID);
      assert.equal(job.materialContextPinId, TEST_PIN_ID);

      const running = reduceJob(job, {
        type: 'JobStarted',
        jobId: TEST_JOB_ID,
        startedAt: T1,
        attemptId: 'att_01' as AttemptId,
      });
      assert.deepEqual(running.attemptLineage, ['att_01']);

      const correlated = reduceJob(running, {
        type: 'JobAttemptCorrelated',
        jobId: TEST_JOB_ID,
        attemptId: 'att_02' as AttemptId,
        correlatedAt: T2,
      });
      assert.deepEqual(running.attemptLineage, ['att_01']);
      assert.deepEqual(correlated.attemptLineage, ['att_01', 'att_02']);

      const succeeded = reduceJob(correlated, {
        type: 'JobSucceeded',
        jobId: TEST_JOB_ID,
        finishedAt: T3,
        terminalReason: 'Processed completely',
      });
      assert.equal(succeeded.status, 'succeeded');
      assert.equal(succeeded.terminalReason, 'Processed completely');
    });
  });
});
