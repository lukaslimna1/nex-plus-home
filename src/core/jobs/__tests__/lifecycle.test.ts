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

const TEST_SESSION_REF = 'sess_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as SessionRef;
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
});
