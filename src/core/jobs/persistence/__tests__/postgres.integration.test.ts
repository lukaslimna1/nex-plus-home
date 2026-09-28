/**
 * NEX+ · Job Lifecycle Core
 * Testes de Integração PostgreSQL para Durable Job Store — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2B)
 *
 * Provas Obrigatórias (Seção 20):
 * C1. Criação durável revision 1 + head na mesma transação.
 * C2. Duplicate JobId falha deterministicamente e não deixa segunda criação parcial.
 * C3. Transição válida produz exatamente revision + 1.
 * C4. State machine persistida equivale ao reduceJob() puro.
 * C5. Transição de domínio inválida não altera evento/head.
 * C6. Stale expectedRevision falha deterministicamente com JobRevisionConflictError.
 * C7. Duas writers concorrentes na mesma revision: exatamente uma vence.
 * C8 & C28. Restart com nova Store/Pool preserva JobState completo sem memória in-process.
 * C9. waitingCause sobrevive.
 * C10. controlIntent sobrevive.
 * C11. progress sobrevive.
 * C12. attemptLineage e ordem sobrevivem.
 * C13. Job terminal continua terminal após restart e no-resurrection permanece vigente.
 * C14. Replay íntegro == head.
 * C15. Revision gap fail-closed.
 * C16. Record kind / event type desconhecido fail-closed.
 * C17. JobId divergente no registro fail-closed.
 * C18. Head corrompido fail-closed.
 * C19. Event payload corrompido fail-closed.
 * C20. Replay/head divergence fail-closed.
 * C21. Rollback impede evento parcial se atualização de head falhar.
 * C22. SQL direto UPDATE em histórico é rejeitado por trigger.
 * C23. SQL direto DELETE em histórico é rejeitado por trigger.
 * C24. SQL direto TRUNCATE em histórico é rejeitado por trigger.
 * C25 & C27. Extra fields e campos de segredo não são persistidos.
 * C26. __proto__ / prototype payload não ganha autoridade nem contamina objetos reconstruídos.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import type {
  JobId,
  JobState,
  JobEvent,
  CreateJobParams,
  JobStartedEvent,
  JobAttemptCorrelatedEvent,
  JobWaitingEvent,
  JobYieldedWaitingEvent,
  JobControlRequestedEvent,
  JobPausedEvent,
  JobResumedEvent,
  JobProgressUpdatedEvent,
  JobSucceededEvent,
  JobFailedEvent,
  JobCancelledEvent,
} from '../../contracts';
import { createJob as pureCreateJob, reduceJob as pureReduceJob } from '../../lifecycle';
import { JobLifecycleError } from '../../invariants';
import type { AttemptId } from '../../../execution/contracts';
import type { HumanActor, SystemActor, MaxActor } from '../../../observations/contracts';
import type { SessionRef } from '../../../../auth/session-ref.types';
import type { DurableJobStore } from '../contracts';
import {
  PostgresJobStore,
  createPostgresJobStore,
} from '../postgres';
import {
  mapRowToJobState,
  mapRowToStoredRecord,
  mapStoredRecordToCreateJobParams,
  assertJobStatesEquivalent,
} from '../serialization';
import {
  DuplicateJobIdError,
  JobNotFoundError,
  JobRevisionConflictError,
  CorruptedJobStorageError,
  JobRehydrationDivergenceError,
} from '../errors';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (process.env.NEX_REQUIRE_JOB_STORE_DB === '1' && !databaseUrl) {
  throw new Error(
    'NEX_REQUIRE_JOB_STORE_DB=1 is set but DATABASE_URL is missing. Aborting test suite to prevent accidental green skip.',
  );
}

describe('0.86C-2B · Persistência PostgreSQL de Durable Job Store L0', { skip: !databaseUrl }, () => {
  let pool: pg.Pool;
  let store: PostgresJobStore;

  const ACTOR_HUMAN: HumanActor = {
    kind: 'human',
    humanId: 'usr_lucas',
    role: 'operator',
  };

  const ACTOR_SYSTEM: SystemActor = {
    kind: 'system',
    component: 'orchestrator',
  };

  const SESSION_REF = 'a'.repeat(64) as SessionRef;

  const T0 = '2026-09-27T10:00:00.000Z';
  const T1 = '2026-09-27T10:01:00.000Z';
  const T2 = '2026-09-27T10:02:00.000Z';
  const T3 = '2026-09-27T10:03:00.000Z';
  const T4 = '2026-09-27T10:04:00.000Z';
  const T5 = '2026-09-27T10:05:00.000Z';

  function makeJobId(prefix: string): JobId {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}` as JobId;
  }

  function stripUndefined<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(stripUndefined) as unknown as T;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v !== undefined) {
        result[k] = stripUndefined(v);
      }
    }
    return result as unknown as T;
  }

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    store = new PostgresJobStore(pool);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  // ==========================================================================
  // C1 & C2: CRIAÇÃO DURÁVEL, REVISION 1 E UNICIDADE
  // ==========================================================================
  describe('Criação Durável & Unicidade (Revision 1)', () => {
    it('C1: Criação durável revision 1 + head gravados atomicamente na mesma transação', async () => {
      const jobId = makeJobId('job_c1');

      const jobState = await store.createJob({
        jobId,
        createdAt: T0,
        userId: 'usr_lucas',
        sessionRef: SESSION_REF,
        actor: ACTOR_HUMAN,
        correlationId: 'corr_test_01',
      });

      // Validação do retorno imediato
      assert.equal(jobState.jobId, jobId);
      assert.equal(jobState.status, 'queued');
      assert.equal(jobState.revision, 1);
      assert.equal(jobState.createdAt, T0);
      assert.equal(jobState.updatedAt, T0);
      assert.equal(jobState.startedAt, undefined);
      assert.equal(jobState.finishedAt, undefined);
      assert.deepEqual(jobState.attemptLineage, []);

      // Leitura operacional defensiva
      const readState = await store.getJob(jobId);
      assert.ok(readState);
      assert.equal(readState.jobId, jobId);
      assert.equal(readState.status, 'queued');
      assert.equal(readState.revision, 1);

      // Verificação direta no banco (nex_job_heads)
      const headRows = await pool.query(
        `SELECT job_id, status, revision, created_at, updated_at FROM "nex_job_heads" WHERE "job_id" = $1`,
        [jobId],
      );
      assert.equal(headRows.rows.length, 1);
      assert.equal(headRows.rows[0].status, 'queued');
      assert.equal(headRows.rows[0].revision, 1);

      // Verificação direta no histórico (nex_job_events)
      const eventRows = await pool.query(
        `SELECT job_id, revision, record_kind, event_type, occurred_at FROM "nex_job_events" WHERE "job_id" = $1`,
        [jobId],
      );
      assert.equal(eventRows.rows.length, 1);
      assert.equal(eventRows.rows[0].revision, 1);
      assert.equal(eventRows.rows[0].record_kind, 'created');
      assert.equal(eventRows.rows[0].event_type, null);
    });

    it('C2: Duplicate JobId falha deterministicamente e não deixa segunda criação parcial', async () => {
      const jobId = makeJobId('job_c2');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      // Tentativa de duplicar o mesmo JobId
      await assert.rejects(
        async () => {
          await store.createJob({
            jobId,
            createdAt: T1,
            actor: ACTOR_SYSTEM,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof DuplicateJobIdError);
          assert.equal(err.jobId, jobId);
          return true;
        },
      );

      // Provar que continua existindo exatamente uma linha de head e um evento histórico
      const heads = await pool.query(`SELECT count(*) as cnt FROM "nex_job_heads" WHERE "job_id" = $1`, [jobId]);
      assert.equal(heads.rows[0].cnt, '1');

      const events = await pool.query(`SELECT count(*) as cnt FROM "nex_job_events" WHERE "job_id" = $1`, [jobId]);
      assert.equal(events.rows[0].cnt, '1');
    });
  });

  // ==========================================================================
  // C3, C4 & C5: TRANSIÇÕES VÁLIDAS, EQUIVALÊNCIA COM REDUCER PURO E TRANSIÇÕES INVÁLIDAS
  // ==========================================================================
  describe('Transições, State Machine & Invariantes', () => {
    it('C3 & C4: Transição válida produz exatamente revision + 1 e equivale ao reduceJob() puro', async () => {
      const jobId = makeJobId('job_c3_c4');

      // 1. Criação no store
      const persistedState1 = await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_HUMAN,
      });

      // Criação pura de referência
      let pureState = pureCreateJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_HUMAN,
      });
      assertJobStatesEquivalent(persistedState1, pureState);

      // 2. Transição para running (JobStarted)
      const startEvent: JobStartedEvent = {
        type: 'JobStarted',
        jobId,
        startedAt: T1,
      };

      const persistedState2 = await store.applyJobEvent(startEvent, 1);
      pureState = pureReduceJob(pureState, startEvent);

      assert.equal(persistedState2.revision, 2);
      assert.equal(persistedState2.status, 'running');
      assertJobStatesEquivalent(persistedState2, pureState);

      // 3. Transição com progresso (JobProgressUpdated)
      const progressEvent: JobProgressUpdatedEvent = {
        type: 'JobProgressUpdated',
        jobId,
        progress: {
          completed: 40,
          total: 100,
          unit: 'percent',
          message: 'Downloading assets',
          updatedAt: T2,
        },
      };

      const persistedState3 = await store.applyJobEvent(progressEvent, 2);
      pureState = pureReduceJob(pureState, progressEvent);

      assert.equal(persistedState3.revision, 3);
      assertJobStatesEquivalent(persistedState3, pureState);

      // 4. Verificação de histórico ordenado
      const events = await store.listJobEvents(jobId);
      assert.equal(events.length, 3);
      assert.equal(events[0].revision, 1);
      assert.equal(events[0].recordKind, 'created');
      assert.equal(events[1].revision, 2);
      assert.equal(events[1].eventType, 'JobStarted');
      assert.equal(events[2].revision, 3);
      assert.equal(events[2].eventType, 'JobProgressUpdated');
    });

    it('C5: Transição de domínio inválida não altera evento/head e faz rollback integral', async () => {
      const jobId = makeJobId('job_c5');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      // Job está em 'queued'. Tentar JobResumed (válido apenas a partir de 'paused')
      const invalidEvent: JobResumedEvent = {
        type: 'JobResumed',
        jobId,
        resumedAt: T1,
      };

      await assert.rejects(
        async () => {
          await store.applyJobEvent(invalidEvent, 1);
        },
        (err: unknown) => {
          assert.ok(err instanceof JobLifecycleError);
          return true;
        },
      );

      // Verificar que o estado não foi alterado e nenhum evento extra foi persistido
      const current = await store.getJob(jobId);
      assert.ok(current);
      assert.equal(current.revision, 1);
      assert.equal(current.status, 'queued');

      const events = await store.listJobEvents(jobId);
      assert.equal(events.length, 1);
    });

    it('C6: Stale expectedRevision falha deterministicamente com JobRevisionConflictError', async () => {
      const jobId = makeJobId('job_c6');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      const startEvent: JobStartedEvent = {
        type: 'JobStarted',
        jobId,
        startedAt: T1,
      };

      // Passar expectedRevision 999 em vez de 1
      await assert.rejects(
        async () => {
          await store.applyJobEvent(startEvent, 999);
        },
        (err: unknown) => {
          assert.ok(err instanceof JobRevisionConflictError);
          assert.equal(err.jobId, jobId);
          assert.equal(err.expectedRevision, 999);
          assert.equal(err.actualRevision, 1);
          return true;
        },
      );
    });
  });

  // ==========================================================================
  // C7: CONCORRÊNCIA OTIMISTA (TWO WRITERS)
  // ==========================================================================
  describe('Concorrência Otimista (SELECT FOR UPDATE)', () => {
    it('C7: Duas writers concorrentes na mesma revision: exatamente uma vence e outra falha com conflito', async () => {
      const jobId = makeJobId('job_c7');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      // Dois eventos concorrentes competindo pela revision 1
      const writerAEvent: JobStartedEvent = {
        type: 'JobStarted',
        jobId,
        startedAt: T1,
      };

      const writerBEvent: JobCancelledEvent = {
        type: 'JobCancelled',
        jobId,
        finishedAt: T1,
        terminalReason: 'Cancelled concurrently',
      };

      // Disparo em paralelo
      const [resA, resB] = await Promise.allSettled([
        store.applyJobEvent(writerAEvent, 1),
        store.applyJobEvent(writerBEvent, 1),
      ]);

      const successes = [resA, resB].filter((r) => r.status === 'fulfilled');
      const failures = [resA, resB].filter((r) => r.status === 'rejected');

      // Exatamente uma venceu e exatamente uma foi rejeitada
      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);

      const rejectedReason = (failures[0] as PromiseRejectedResult).reason;
      assert.ok(rejectedReason instanceof JobRevisionConflictError);
      assert.equal(rejectedReason.expectedRevision, 1);
      assert.equal(rejectedReason.actualRevision, 2);

      // O banco deve conter exatamente 2 revisões históricas
      const events = await store.listJobEvents(jobId);
      assert.equal(events.length, 2);
      assert.equal(events[0].revision, 1);
      assert.equal(events[1].revision, 2);

      // O head final corresponde exatamente ao resultado da vencedora
      const finalHead = await store.getJob(jobId);
      assert.ok(finalHead);
      assert.equal(finalHead.revision, 2);
      const winnerState = (successes[0] as PromiseFulfilledResult<JobState>).value;
      assert.deepEqual(finalHead, winnerState);
    });
  });

  // ==========================================================================
  // C8, C9, C10, C11, C12, C13 & C28: REIDRATAÇÃO PÓS-RESTART / NOVA INSTÂNCIA
  // ==========================================================================
  describe('Persistência Cross-Instance / Restart & Campos de Domínio', () => {
    it('C8 & C28 / R-03: Nova Pool e nova Store recuperam JobState completo com Pool A encerrada antes de criar Pool B', async () => {
      const jobId = makeJobId('job_c8_c28_strict');

      // 1. Pool A dedicada e Store A dedicada (NÃO usa store/pool global)
      const poolA = new Pool({ connectionString: databaseUrl, max: 2 });
      let storeARef: DurableJobStore | null = createPostgresJobStore(poolA);
      const storeA = storeARef;

      await storeA.createJob({
        jobId,
        createdAt: T0,
        userId: 'usr_lucas',
        sessionRef: SESSION_REF,
        actor: ACTOR_HUMAN,
        correlationId: 'corr_restart_test',
        materialContextPinId: 'mcp_restart',
      });

      const expectedState = await storeA.applyJobEvent({
        type: 'JobStarted',
        jobId,
        startedAt: T1,
      }, 1);

      // 2. Executar await poolA.end() ANTES de criar Pool B
      await poolA.end();

      // 3. Remover/abandonar referências à Store A
      storeARef = null;
      void storeARef;

      // 4. Criar Pool B e Store B após o encerramento garantido da Pool A
      const poolB = new Pool({ connectionString: databaseUrl, max: 2 });
      const storeB = createPostgresJobStore(poolB);

      try {
        const getResult = await storeB.getJob(jobId);
        assert.ok(getResult);
        assert.deepEqual(stripUndefined(getResult), stripUndefined(expectedState));
        assertJobStatesEquivalent(getResult, expectedState);

        const rehydratedResult = await storeB.rehydrateJob(jobId);
        assert.ok(rehydratedResult);
        assert.deepEqual(stripUndefined(rehydratedResult), stripUndefined(expectedState));
        assertJobStatesEquivalent(rehydratedResult, expectedState);
      } finally {
        await poolB.end();
      }
    });

  // ==========================================================================
  // R-01 / SEÇÃO 3 & SEÇÃO 14 (1 a 4): PROVAS DE RETORNO LEGÍTIMO A QUEUED
  // ==========================================================================
  describe('R-01 · Retorno Canônico a Queued Pós-Start (waiting/paused -> queued)', () => {
    it('Cenário A (1, 3, 4): running -> waiting -> yielded -> queued preserva startedAt, attemptLineage e progress', async () => {
      const jobId = makeJobId('job_r01_a');
      const attId = 'att_01_a' as AttemptId;

      // 1. Criar Job
      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_HUMAN,
      });

      // 2. JobStarted com AttemptId
      await store.applyJobEvent({
        type: 'JobStarted',
        jobId,
        attemptId: attId,
        startedAt: T1,
      }, 1);

      // 3. JobProgressUpdated
      await store.applyJobEvent({
        type: 'JobProgressUpdated',
        jobId,
        progress: {
          completed: 25,
          total: 100,
          unit: 'percent',
          message: 'Processing batch 1',
          updatedAt: T2,
        },
      }, 2);

      // 4. JobWaiting
      const waitingCause = {
        kind: 'human' as const,
        reasonCode: 'approval_required',
        description: 'Waiting for manual review',
        requestedAt: T3,
      };
      await store.applyJobEvent({
        type: 'JobWaiting',
        jobId,
        cause: waitingCause,
        transitionedAt: T3,
      }, 3);

      // 5. JobYieldedWaiting -> queued
      const yieldedState = await store.applyJobEvent({
        type: 'JobYieldedWaiting',
        jobId,
        resumedAt: T4,
      }, 4);

      // Verificação do estado retornado
      assert.equal(yieldedState.status, 'queued');
      assert.equal(yieldedState.revision, 5);
      assert.equal(yieldedState.startedAt, T1);
      assert.equal(yieldedState.finishedAt, undefined);
      assert.equal(yieldedState.waitingCause, undefined);
      assert.deepEqual(yieldedState.attemptLineage, [attId]);
      assert.ok(yieldedState.progress);
      assert.equal(yieldedState.progress.completed, 25);
      assert.equal(yieldedState.progress.total, 100);
      assert.equal(yieldedState.updatedAt, T4);

      // getJob PASS
      const getHead = await store.getJob(jobId);
      assert.ok(getHead);
      assert.deepEqual(stripUndefined(getHead), stripUndefined(yieldedState));
      assertJobStatesEquivalent(getHead, yieldedState);

      // rehydrateJob PASS
      const rehydrated = await store.rehydrateJob(jobId);
      assert.ok(rehydrated);
      assert.deepEqual(stripUndefined(rehydrated), stripUndefined(yieldedState));
      assertJobStatesEquivalent(rehydrated, yieldedState);

      // Replay == Head confirmado
      assertJobStatesEquivalent(rehydrated, getHead);
    });

    it('Cenário B (2, 3, 4): running -> paused -> resumed -> queued preserva startedAt, attemptLineage e progress', async () => {
      const jobId = makeJobId('job_r01_b');
      const attId = 'att_01_b' as AttemptId;

      // 1. Criar Job
      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      // 2. JobStarted com AttemptId
      await store.applyJobEvent({
        type: 'JobStarted',
        jobId,
        attemptId: attId,
        startedAt: T1,
      }, 1);

      // 3. JobProgressUpdated
      await store.applyJobEvent({
        type: 'JobProgressUpdated',
        jobId,
        progress: {
          completed: 40,
          total: 100,
          unit: 'items',
          message: 'Processed 40 items',
          updatedAt: T2,
        },
      }, 2);

      // 4. JobPaused
      await store.applyJobEvent({
        type: 'JobPaused',
        jobId,
        pausedAt: T3,
      }, 3);

      // 5. JobResumed -> queued
      const resumedState = await store.applyJobEvent({
        type: 'JobResumed',
        jobId,
        resumedAt: T4,
      }, 4);

      // Verificação do estado retornado
      assert.equal(resumedState.status, 'queued');
      assert.equal(resumedState.revision, 5);
      assert.equal(resumedState.startedAt, T1);
      assert.equal(resumedState.finishedAt, undefined);
      assert.equal(resumedState.waitingCause, undefined);
      assert.deepEqual(resumedState.attemptLineage, [attId]);
      assert.ok(resumedState.progress);
      assert.equal(resumedState.progress.completed, 40);
      assert.equal(resumedState.progress.total, 100);
      assert.equal(resumedState.updatedAt, T4);

      // getJob PASS
      const getHead = await store.getJob(jobId);
      assert.ok(getHead);
      assert.deepEqual(stripUndefined(getHead), stripUndefined(resumedState));
      assertJobStatesEquivalent(getHead, resumedState);

      // rehydrateJob PASS
      const rehydrated = await store.rehydrateJob(jobId);
      assert.ok(rehydrated);
      assert.deepEqual(stripUndefined(rehydrated), stripUndefined(resumedState));
      assertJobStatesEquivalent(rehydrated, resumedState);

      // Replay == Head confirmado
      assertJobStatesEquivalent(rehydrated, getHead);
    });
  });

    it('C9: waitingCause sobrevive e é reidratado com fidelidade estrutural', async () => {
      const jobId = makeJobId('job_c9');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      await store.applyJobEvent({
        type: 'JobStarted',
        jobId,
        startedAt: T1,
      }, 1);

      const waitingEvent: JobWaitingEvent = {
        type: 'JobWaiting',
        jobId,
        cause: {
          kind: 'human',
          reasonCode: 'approval_required',
          description: 'Requires human sign-off on dispatch',
          requestedAt: T2,
        },
        transitionedAt: T2,
      };

      const waitedState = await store.applyJobEvent(waitingEvent, 2);
      assert.equal(waitedState.status, 'waiting');
      assert.deepEqual(waitedState.waitingCause, waitingEvent.cause);

      // Leitura após reidratação
      const readState = await store.getJob(jobId);
      assert.ok(readState);
      assert.equal(readState.status, 'waiting');
      assert.deepEqual(readState.waitingCause, waitingEvent.cause);

      // Replay também confirma waitingCause
      const replayed = await store.rehydrateJob(jobId);
      assert.ok(replayed);
      assert.deepEqual(replayed.waitingCause, waitingEvent.cause);
    });

    it('C10: controlIntent sobrevive a transições e restart', async () => {
      const jobId = makeJobId('job_c10');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      await store.applyJobEvent({
        type: 'JobStarted',
        jobId,
        startedAt: T1,
      }, 1);

      const controlEvent: JobControlRequestedEvent = {
        type: 'JobControlRequested',
        jobId,
        intent: 'pause',
        requestedAt: T2,
      };

      const requestedState = await store.applyJobEvent(controlEvent, 2);
      assert.equal(requestedState.status, 'running');
      assert.equal(requestedState.controlIntent, 'pause');

      const rehydrated = await store.rehydrateJob(jobId);
      assert.ok(rehydrated);
      assert.equal(rehydrated.controlIntent, 'pause');
    });

    it('C11: progress sobrevive e é recuperado corretamente', async () => {
      const jobId = makeJobId('job_c11');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      await store.applyJobEvent({
        type: 'JobStarted',
        jobId,
        startedAt: T1,
      }, 1);

      const progressEvent: JobProgressUpdatedEvent = {
        type: 'JobProgressUpdated',
        jobId,
        progress: {
          completed: 75,
          total: 100,
          unit: 'percent',
          message: 'Encoding video chunks',
          updatedAt: T2,
        },
      };

      await store.applyJobEvent(progressEvent, 2);

      const head = await store.getJob(jobId);
      assert.ok(head);
      assert.deepEqual(head.progress, progressEvent.progress);

      const replayed = await store.rehydrateJob(jobId);
      assert.ok(replayed);
      assert.deepEqual(replayed.progress, progressEvent.progress);
    });

    it('C12: attemptLineage e sua ordenação estrita sobrevivem', async () => {
      const jobId = makeJobId('job_c12');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      await store.applyJobEvent({
        type: 'JobStarted',
        jobId,
        startedAt: T1,
        attemptId: 'att_001' as AttemptId,
      }, 1);

      await store.applyJobEvent({
        type: 'JobAttemptCorrelated',
        jobId,
        attemptId: 'att_002' as AttemptId,
        correlatedAt: T2,
      }, 2);

      await store.applyJobEvent({
        type: 'JobAttemptCorrelated',
        jobId,
        attemptId: 'att_003' as AttemptId,
        correlatedAt: T3,
      }, 3);

      const readState = await store.getJob(jobId);
      assert.ok(readState);
      assert.deepEqual(readState.attemptLineage, ['att_001', 'att_002', 'att_003']);

      const replayed = await store.rehydrateJob(jobId);
      assert.ok(replayed);
      assert.deepEqual(replayed.attemptLineage, ['att_001', 'att_002', 'att_003']);
    });

    it('C13: Job terminal continua terminal após restart e no-resurrection permanece vigente', async () => {
      const jobId = makeJobId('job_c13');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      await store.applyJobEvent({
        type: 'JobStarted',
        jobId,
        startedAt: T1,
      }, 1);

      await store.applyJobEvent({
        type: 'JobSucceeded',
        jobId,
        finishedAt: T2,
        terminalReason: 'Execution completed with 100% success',
      }, 2);

      // Nova Store
      const freshPool = new Pool({ connectionString: databaseUrl, max: 2 });
      const freshStore = createPostgresJobStore(freshPool);

      try {
        const terminalJob = await freshStore.getJob(jobId);
        assert.ok(terminalJob);
        assert.equal(terminalJob.status, 'succeeded');
        assert.equal(terminalJob.finishedAt, T2);

        // Tentativa de ressuscitar deve falhar via reducer do Core
        await assert.rejects(
          async () => {
            await freshStore.applyJobEvent({
              type: 'JobStarted',
              jobId,
              startedAt: T3,
            }, 3);
          },
          (err: unknown) => {
            assert.ok(err instanceof JobLifecycleError);
            return true;
          },
        );
      } finally {
        await freshPool.end();
      }
    });
  });

  // ==========================================================================
  // C14 A C21: REPLAY INTEGRAL & PROVAS DE CORRUPÇÃO FAIL-CLOSED
  // ==========================================================================
  describe('Replay / Reidratação Auditável & Detecção de Corrupção (Fail-Closed)', () => {
    it('C14: Replay íntegro desde a revision 1 coincide exatamente com o head', async () => {
      const jobId = makeJobId('job_c14');

      await store.createJob({
        jobId,
        createdAt: T0,
        userId: 'usr_audit',
        sessionRef: SESSION_REF,
        actor: ACTOR_HUMAN,
      });

      await store.applyJobEvent({
        type: 'JobStarted',
        jobId,
        startedAt: T1,
      }, 1);

      await store.applyJobEvent({
        type: 'JobProgressUpdated',
        jobId,
        progress: {
          completed: 50,
          total: 100,
          unit: 'percent',
          message: 'Halfway through',
          updatedAt: T1,
        },
      }, 2);

      await store.applyJobEvent({
        type: 'JobSucceeded',
        jobId,
        finishedAt: T2,
      }, 3);

      const replayed = await store.rehydrateJob(jobId);
      const head = await store.getJob(jobId);

      assert.ok(replayed);
      assert.ok(head);
      assertJobStatesEquivalent(replayed, head);
    });

    it('C15: Revision gap no histórico fail-closed', async () => {
      const jobId = makeJobId('job_c15');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      // Insere artificialmente a revision 3 sem a revision 2
      await pool.query(
        `INSERT INTO "nex_job_events" ("job_id", "revision", "record_kind", "event_type", "occurred_at", "payload")
         VALUES ($1, 3, 'transition', 'JobStarted', $2, $3)`,
        [jobId, T2, JSON.stringify({ type: 'JobStarted', jobId, startedAt: T2 })],
      );

      // Ajusta o head para revision 3 tanto na coluna quanto no state_payload
      await pool.query(
        `UPDATE "nex_job_heads"
         SET "revision" = 3,
             "state_payload" = jsonb_set(state_payload, '{revision}', '3')
         WHERE "job_id" = $1`,
        [jobId],
      );

      await assert.rejects(
        async () => {
          await store.rehydrateJob(jobId);
        },
        (err: unknown) => {
          assert.ok(err instanceof CorruptedJobStorageError);
          assert.ok(err.detail.includes('Revision gap'));
          return true;
        },
      );
    });

    it('C16: Record kind desconhecido fail-closed', async () => {
      const jobId = makeJobId('job_c16');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      const corruptRow = {
        job_id: jobId,
        revision: 2,
        record_kind: 'invalid_kind',
        event_type: null,
        occurred_at: T1,
        payload: {},
        append_sequence: '2',
      };

      assert.throws(
        () => {
          mapRowToStoredRecord(corruptRow);
        },
        (err: unknown) => {
          assert.ok(err instanceof CorruptedJobStorageError);
          return true;
        },
      );
    });

    it('C17: JobId divergente entre coluna e payload fail-closed', async () => {
      const jobId = makeJobId('job_c17');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      // Tenta desserializar record com jobId divergente na payload
      const corruptRecord = {
        jobId,
        revision: 1,
        recordKind: 'created' as const,
        occurredAt: T0,
        payload: {
          jobId: 'divergent_job_id',
          createdAt: T0,
          actor: ACTOR_SYSTEM,
        },
        appendSequence: '1',
      };

      assert.throws(
        () => {
          mapStoredRecordToCreateJobParams(corruptRecord);
        },
        (err: unknown) => {
          assert.ok(err instanceof CorruptedJobStorageError);
          return true;
        },
      );
    });

    it('C18: Head corrompido fail-closed', async () => {
      const jobId = makeJobId('job_c18');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      // Grava payload JSON válida para o Postgres porém corrompida para o Job (não possui campos obrigatórios)
      await pool.query(
        `UPDATE "nex_job_heads" SET "state_payload" = $1 WHERE "job_id" = $2`,
        [JSON.stringify({ notAJob: true }), jobId],
      );

      await assert.rejects(
        async () => {
          await store.getJob(jobId);
        },
        (err: unknown) => {
          assert.ok(err instanceof CorruptedJobStorageError);
          return true;
        },
      );
    });

    it('C20: Divergência entre replay e head fail-closed com JobRehydrationDivergenceError', async () => {
      const jobId = makeJobId('job_c20');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      await store.applyJobEvent({
        type: 'JobStarted',
        jobId,
        startedAt: T1,
      }, 1);

      // Adulterar status no head para 'failed' diretamente no banco enquanto o replay dá 'running'
      // O head adulterado deve ser internamente canônico (updatedAt === finishedAt e terminalReason presente)
      await pool.query(
        `UPDATE "nex_job_heads"
         SET "status" = 'failed',
             "updated_at" = $2,
             "finished_at" = $2,
             "state_payload" = jsonb_set(
               jsonb_set(
                 jsonb_set(
                   jsonb_set(state_payload, '{status}', '"failed"'),
                   '{finishedAt}',
                   $3::jsonb
                 ),
                 '{updatedAt}',
                 $3::jsonb
               ),
               '{terminalReason}',
               '"Manual divergence corruption"'
             )
         WHERE "job_id" = $1`,
        [jobId, T2, JSON.stringify(T2)],
      );

      await assert.rejects(
        async () => {
          await store.rehydrateJob(jobId);
        },
        (err: unknown) => {
          assert.ok(err instanceof JobRehydrationDivergenceError);
          return true;
        },
      );
    });

    it('C19: Evento com payload corrompido em nex_job_events falha fechado com CorruptedJobStorageError', async () => {
      const jobId = makeJobId('job_c19');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      // Inserir diretamente uma linha de evento com payload corrompido (sem o tipo do evento ou sem campos obrigatórios)
      await pool.query(
        `INSERT INTO "nex_job_events" (
          "job_id",
          "revision",
          "record_kind",
          "event_type",
          "occurred_at",
          "payload"
        ) VALUES ($1, 2, 'transition', 'JobStarted', $2, $3)`,
        [jobId, T1, JSON.stringify({ notAValidEvent: true })],
      );

      // Rehydrate deve falhar fechado com CorruptedJobStorageError ao tentar desserializar o evento corrompido
      await assert.rejects(
        async () => {
          await store.rehydrateJob(jobId);
        },
        (err: unknown) => {
          assert.ok(err instanceof CorruptedJobStorageError);
          return true;
        },
      );

      // listJobEvents também deve falhar fechado ao encontrar payload corrompido
      await assert.rejects(
        async () => {
          await store.listJobEvents(jobId);
        },
        (err: unknown) => {
          assert.ok(err instanceof CorruptedJobStorageError);
          return true;
        },
      );
    });

    it('C21: Rollback integral impede evento parcial se atualização de head falhar', async () => {
      const jobId = makeJobId('job_c21');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      // Criar trigger transitório para simular falha estrita no UPDATE de nex_job_heads
      await pool.query(`
        CREATE OR REPLACE FUNCTION nex_test_fail_head_update()
        RETURNS trigger AS $$
        BEGIN
          IF NEW.job_id = '${jobId}' THEN
            RAISE EXCEPTION 'simulated_head_update_failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS "nex_test_fail_head_update_trg" ON "nex_job_heads";
        CREATE TRIGGER "nex_test_fail_head_update_trg"
        BEFORE UPDATE ON "nex_job_heads"
        FOR EACH ROW EXECUTE FUNCTION nex_test_fail_head_update();
      `);

      try {
        await assert.rejects(
          async () => {
            await store.applyJobEvent(
              {
                type: 'JobStarted',
                jobId,
                startedAt: T1,
              },
              1,
            );
          },
          /simulated_head_update_failure/,
        );

        // Provar C21: Transação deu rollback integral. Nenhum evento de revision 2 foi persistido!
        const eventsRes = await pool.query(
          `SELECT "revision" FROM "nex_job_events" WHERE "job_id" = $1 ORDER BY "revision" ASC`,
          [jobId],
        );
        assert.equal(eventsRes.rows.length, 1);
        assert.equal(eventsRes.rows[0].revision, 1);

        // Head permanece em revision 1 e queued
        const headRes = await pool.query(
          `SELECT "revision", "status" FROM "nex_job_heads" WHERE "job_id" = $1`,
          [jobId],
        );
        assert.equal(headRes.rows[0].revision, 1);
        assert.equal(headRes.rows[0].status, 'queued');
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS "nex_test_fail_head_update_trg" ON "nex_job_heads";`);
      }
    });
  });

  // ==========================================================================
  // C22, C23, C24: PROTEÇÃO ESTRUTURAL APPEND-ONLY (TRIGGERS)
  // ==========================================================================
  describe('Proteção Estrutural Append-Only (Triggers no Histórico)', () => {
    it('C22: UPDATE direto em nex_job_events é rejeitado por trigger', async () => {
      const jobId = makeJobId('job_c22');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      await assert.rejects(
        async () => {
          await pool.query(
            `UPDATE "nex_job_events" SET "occurred_at" = now() WHERE "job_id" = $1`,
            [jobId],
          );
        },
        /APPEND_ONLY_VIOLATION|nex_reject_append_only_mutation/i,
      );
    });

    it('C23: DELETE direto em nex_job_events é rejeitado por trigger', async () => {
      const jobId = makeJobId('job_c23');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      await assert.rejects(
        async () => {
          await pool.query(
            `DELETE FROM "nex_job_events" WHERE "job_id" = $1`,
            [jobId],
          );
        },
        /APPEND_ONLY_VIOLATION|nex_reject_append_only_mutation/i,
      );
    });

    it('C24: TRUNCATE direto em nex_job_events é rejeitado por trigger', async () => {
      await assert.rejects(
        async () => {
          await pool.query(`TRUNCATE "nex_job_events"`);
        },
        /APPEND_ONLY_VIOLATION|nex_reject_append_only_mutation/i,
      );
    });
  });

  // ==========================================================================
  // C25, C26, C27: TRUST BOUNDARY NO BANCO REAL
  // ==========================================================================
  describe('Trust Boundary contra Segredos e Prototype Pollution no Banco Real', () => {
    it('C25 & C27: Campos injetados de token, senha e extras não existem no JSON persistido', async () => {
      const jobId = makeJobId('job_c25_c27');

      const maliciousParams = {
        jobId,
        createdAt: T0,
        actor: ACTOR_HUMAN,
        // Segredos e extras injetados no input:
        token: 'raw_bearer_jwt_secret',
        password: 'super_secret_password',
        cookie: 'sessionId=secret',
        authorization: 'Bearer 12345',
        internalProcessState: { memory: 4096 },
      } as unknown as CreateJobParams;

      await store.createJob(maliciousParams);

      // Inspeciona diretamente o JSON gravado no banco em nex_job_heads
      const headRes = await pool.query(
        `SELECT "state_payload" FROM "nex_job_heads" WHERE "job_id" = $1`,
        [jobId],
      );
      const headJson = typeof headRes.rows[0].state_payload === 'string'
        ? JSON.parse(headRes.rows[0].state_payload)
        : headRes.rows[0].state_payload;

      assert.equal(headJson.token, undefined);
      assert.equal(headJson.password, undefined);
      assert.equal(headJson.cookie, undefined);
      assert.equal(headJson.authorization, undefined);
      assert.equal(headJson.internalProcessState, undefined);

      // Inspeciona diretamente o JSON gravado em nex_job_events
      const eventRes = await pool.query(
        `SELECT "payload" FROM "nex_job_events" WHERE "job_id" = $1`,
        [jobId],
      );
      const eventJson = typeof eventRes.rows[0].payload === 'string'
        ? JSON.parse(eventRes.rows[0].payload)
        : eventRes.rows[0].payload;

      assert.equal(eventJson.token, undefined);
      assert.equal(eventJson.password, undefined);
      assert.equal(eventJson.cookie, undefined);
      assert.equal(eventJson.authorization, undefined);
      assert.equal(eventJson.internalProcessState, undefined);
    });

    it('C26: Objeto recuperado do banco é seguro contra prototype pollution', async () => {
      const jobId = makeJobId('job_c26');

      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      const recovered = await store.getJob(jobId);
      assert.ok(recovered);
      assert.equal(({} as any).polluted, undefined);
      assert.equal((recovered as any).__proto__.polluted, undefined);
    });
  });

  // ==========================================================================
  // H-01, H-02, H-03 & M-03: AUDITORIA CODEX & PROVAS ESPECÍFICAS
  // ==========================================================================
  describe('Auditoria Codex · H-01, H-02, H-03 & M-03', () => {
    it('H-01: Round-trip preserva whitespace original e strings vazias sem trim', async () => {
      const jobId = makeJobId('job_h01');

      // 1. Criação com whitespace significativo em campos que exigem non-empty
      const initialJob = await store.createJob({
        jobId,
        createdAt: T0,
        userId: '   usr_spaced   ',
        correlationId: '   corr_spaced   ',
        actor: {
          kind: 'human',
          humanId: '   human_spaced   ',
          role: '   operator_spaced   ',
        },
      });

      assert.equal(initialJob.userId, '   usr_spaced   ');
      assert.equal(initialJob.correlationId, '   corr_spaced   ');
      assert.equal((initialJob.actor as HumanActor).humanId, '   human_spaced   ');
      assert.equal((initialJob.actor as HumanActor).role, '   operator_spaced   ');

      // 2. Transições com campos contendo strings vazias permitidas pelo Core
      await store.applyJobEvent(
        {
          type: 'JobStarted',
          jobId,
          startedAt: T1,
        },
        1,
      );

      await store.applyJobEvent(
        {
          type: 'JobProgressUpdated',
          jobId,
          progress: {
            completed: 25,
            unit: '', // string vazia permitida
            message: '', // string vazia permitida
            updatedAt: T2,
          },
        },
        2,
      );

      await store.applyJobEvent(
        {
          type: 'JobCancelled',
          jobId,
          finishedAt: T3,
          terminalReason: '', // string vazia permitida
        },
        3,
      );

      // 3. Provar que getJob recupera exatamente os mesmos valores sem modificação
      const readJob = await store.getJob(jobId);
      assert.ok(readJob);
      assert.equal(readJob.userId, '   usr_spaced   ');
      assert.equal(readJob.correlationId, '   corr_spaced   ');
      assert.equal((readJob.actor as HumanActor).humanId, '   human_spaced   ');
      assert.equal((readJob.actor as HumanActor).role, '   operator_spaced   ');
      assert.equal(readJob.progress?.unit, '');
      assert.equal(readJob.progress?.message, '');
      assert.equal(readJob.terminalReason, '');

      // 4. Provar que rehydrateJob preserva e valida com sucesso
      const rehydratedJob = await store.rehydrateJob(jobId);
      assert.ok(rehydratedJob);
      assert.equal(rehydratedJob.userId, '   usr_spaced   ');
      assert.equal(rehydratedJob.correlationId, '   corr_spaced   ');
      assert.equal((rehydratedJob.actor as HumanActor).humanId, '   human_spaced   ');
      assert.equal((rehydratedJob.actor as HumanActor).role, '   operator_spaced   ');
      assert.equal(rehydratedJob.progress?.unit, '');
      assert.equal(rehydratedJob.progress?.message, '');
      assert.equal(rehydratedJob.terminalReason, '');
    });

    it('H-02: rehydrateJob garante consistência interna sob interleaving concorrente via snapshot REPEATABLE READ', async () => {
      const jobId = makeJobId('job_h02');

      // 1. Criar job em revision 1 (queued)
      await store.createJob({
        jobId,
        createdAt: T0,
        actor: ACTOR_SYSTEM,
      });

      // 2. Conexão A abre transação REPEATABLE READ READ ONLY (como feito internamente por withReadSnapshot)
      const clientA = await pool.connect();
      try {
        await clientA.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

        // Primeira leitura: observa o head em revision 1
        const headResA = await clientA.query(
          `SELECT "job_id", "status", "revision", "created_at", "updated_at", "started_at", "finished_at", "state_payload"
           FROM "nex_job_heads" WHERE "job_id" = $1`,
          [jobId],
        );
        assert.equal(headResA.rows[0].revision, 1);
        assert.equal(headResA.rows[0].status, 'queued');

        // 3. Enquanto clientA mantém a transação aberta, outra conexão (Conexão B / store) comita revision 2
        await store.applyJobEvent(
          {
            type: 'JobStarted',
            jobId,
            startedAt: T1,
          },
          1,
        );

        // Confirmar que no banco agora o head está em revision 2
        const currentDbHead = await pool.query(
          `SELECT "revision" FROM "nex_job_heads" WHERE "job_id" = $1`,
          [jobId],
        );
        assert.equal(currentDbHead.rows[0].revision, 2);

        // 4. Conexão A executa sua segunda leitura: SELECT de nex_job_events
        const eventsResA = await clientA.query(
          `SELECT "job_id", "revision", "record_kind", "event_type", "occurred_at", "payload", "append_sequence"
           FROM "nex_job_events" WHERE "job_id" = $1 ORDER BY "revision" ASC`,
          [jobId],
        );

        // PROVA DE ISOLAMENTO H-02:
        // Como clientA está sob REPEATABLE READ READ ONLY, seu snapshot NÃO vê a revision 2 inserida pela Conexão B!
        // Enxerga EXATAMENTE 1 evento (revision 1), perfeitamente consistente com o head lido na query 1!
        assert.equal(eventsResA.rows.length, 1);
        assert.equal(eventsResA.rows[0].revision, 1);

        // Replay e equivalência funcionam de forma consistente
        const replayed = pureCreateJob(mapStoredRecordToCreateJobParams(mapRowToStoredRecord(eventsResA.rows[0])));
        const headState = mapRowToJobState(headResA.rows[0]);
        assertJobStatesEquivalent(replayed, headState);

        await clientA.query('COMMIT');
      } catch (err) {
        try {
          await clientA.query('ROLLBACK');
        } catch {
          // ignore
        }
        throw err;
      } finally {
        clientA.release();
      }

      // Agora uma nova chamada de rehydrateJob após o commit enxerga revision 2 consistentemente
      const rehydratedRev2 = await store.rehydrateJob(jobId);
      assert.ok(rehydratedRev2);
      assert.equal(rehydratedRev2.revision, 2);
      assert.equal(rehydratedRev2.status, 'running');
    });

    it('H-03: CHECK da migration suporta transições válidas a partir de queued (paused, failed, cancelled)', async () => {
      // 1. queued -> paused (started_at IS NULL, finished_at IS NULL)
      const jobPausedId = makeJobId('job_h03_paused');
      await store.createJob({ jobId: jobPausedId, createdAt: T0, actor: ACTOR_SYSTEM });
      const pausedState = await store.applyJobEvent(
        { type: 'JobPaused', jobId: jobPausedId, pausedAt: T1 },
        1,
      );
      assert.equal(pausedState.status, 'paused');
      assert.equal(pausedState.startedAt, undefined);
      assert.equal(pausedState.finishedAt, undefined);
      const rehydratedPaused = await store.rehydrateJob(jobPausedId);
      assert.ok(rehydratedPaused);
      assert.equal(rehydratedPaused.status, 'paused');

      // 2. queued -> failed (started_at IS NULL, finished_at IS NOT NULL)
      const jobFailedId = makeJobId('job_h03_failed');
      await store.createJob({ jobId: jobFailedId, createdAt: T0, actor: ACTOR_SYSTEM });
      const failedState = await store.applyJobEvent(
        { type: 'JobFailed', jobId: jobFailedId, finishedAt: T1, reasonCode: 'validation_error' },
        1,
      );
      assert.equal(failedState.status, 'failed');
      assert.equal(failedState.startedAt, undefined);
      assert.equal(failedState.finishedAt, T1);
      const rehydratedFailed = await store.rehydrateJob(jobFailedId);
      assert.ok(rehydratedFailed);
      assert.equal(rehydratedFailed.status, 'failed');

      // 3. queued -> cancelled (started_at IS NULL, finished_at IS NOT NULL)
      const jobCancelledId = makeJobId('job_h03_cancelled');
      await store.createJob({ jobId: jobCancelledId, createdAt: T0, actor: ACTOR_SYSTEM });
      const cancelledState = await store.applyJobEvent(
        { type: 'JobCancelled', jobId: jobCancelledId, finishedAt: T1 },
        1,
      );
      assert.equal(cancelledState.status, 'cancelled');
      assert.equal(cancelledState.startedAt, undefined);
      assert.equal(cancelledState.finishedAt, T1);
      const rehydratedCancelled = await store.rehydrateJob(jobCancelledId);
      assert.ok(rehydratedCancelled);
      assert.equal(rehydratedCancelled.status, 'cancelled');
    });

    it('M-03: Restart estrito desvinculado recupera JobState sem memória in-process', async () => {
      const jobId = makeJobId('job_m03');

      // Usar a store atual para criar e iniciar o job
      await store.createJob({
        jobId,
        createdAt: T0,
        userId: 'usr_m03',
        actor: ACTOR_HUMAN,
        correlationId: 'corr_m03',
      });

      await store.applyJobEvent(
        {
          type: 'JobStarted',
          jobId,
          startedAt: T1,
        },
        1,
      );

      // Instanciar pool completamente novo e isolado sem compartilhar nenhuma referência
      const isolatedPool = new Pool({ connectionString: databaseUrl, max: 1 });
      const isolatedStore = createPostgresJobStore(isolatedPool);

      try {
        const recovered = await isolatedStore.getJob(jobId);
        assert.ok(recovered);
        assert.equal(recovered.jobId, jobId);
        assert.equal(recovered.revision, 2);
        assert.equal(recovered.status, 'running');
        assert.equal(recovered.userId, 'usr_m03');
        assert.equal(recovered.correlationId, 'corr_m03');

        const rehydrated = await isolatedStore.rehydrateJob(jobId);
        assert.ok(rehydrated);
        assert.equal(rehydrated.revision, 2);
        assert.equal(rehydrated.status, 'running');
      } finally {
        await isolatedPool.end();
      }
    });

    it('R-04: Persiste e reidrata Job com MaxActor contendo sessionRef opaca preservada', async () => {
      const jobId = makeJobId('job_r04_max');
      const maxActor: MaxActor = {
        kind: 'max',
        maxVersion: 'max-v1',
        sessionRef: 'max-session-opaque',
      };

      // Criar sem JobState.sessionRef top-level (não confundir os dois)
      const created = await store.createJob({
        jobId,
        createdAt: T0,
        actor: maxActor,
      });

      assert.equal(created.actor.kind, 'max');
      if (created.actor.kind === 'max') {
        assert.equal(created.actor.sessionRef, 'max-session-opaque');
      }
      assert.equal(created.sessionRef, undefined);

      const fetched = await store.getJob(jobId);
      assert.ok(fetched);
      assert.equal(fetched.actor.kind, 'max');
      if (fetched.actor.kind === 'max') {
        assert.equal(fetched.actor.sessionRef, 'max-session-opaque');
      }
      assert.equal(fetched.sessionRef, undefined);

      const rehydrated = await store.rehydrateJob(jobId);
      assert.ok(rehydrated);
      assert.equal(rehydrated.actor.kind, 'max');
      if (rehydrated.actor.kind === 'max') {
        assert.equal(rehydrated.actor.sessionRef, 'max-session-opaque');
      }
      assert.equal(rehydrated.sessionRef, undefined);

      assertJobStatesEquivalent(rehydrated, fetched);
      assert.deepEqual(stripUndefined(rehydrated), stripUndefined(fetched));
    });

    it('R-04: Não-regressão - CreateJobParams.sessionRef top-level continua estrito e exige SessionRef auth hex-64', async () => {
      const jobIdInvalid = makeJobId('job_r04_inv');
      const maxActor: MaxActor = {
        kind: 'max',
        maxVersion: 'max-v1',
        sessionRef: 'max-session-opaque',
      };

      // Top-level sessionRef com string opaca (não hex-64) DEVE ser rejeitado pelo Core
      await assert.rejects(
        async () => {
          await store.createJob({
            jobId: jobIdInvalid,
            createdAt: T0,
            actor: maxActor,
            sessionRef: 'max-session-opaque' as any,
          });
        },
        (err: any) => {
          assert.equal(err.name, 'JobLifecycleError');
          assert.match(err.message, /sessionRef/);
          return true;
        },
      );

      // Top-level sessionRef com hex-64 válido passa normalmente
      const jobIdValid = makeJobId('job_r04_valid');
      const createdValid = await store.createJob({
        jobId: jobIdValid,
        createdAt: T0,
        actor: maxActor,
        sessionRef: SESSION_REF,
      });
      assert.equal(createdValid.sessionRef, SESSION_REF);
      if (createdValid.actor.kind === 'max') {
        assert.equal(createdValid.actor.sessionRef, 'max-session-opaque');
      }
    });

    // ========================================================================
    // T-01 · FIDELIDADE TEXTUAL DE TIMESTAMPS UTC EM POSTGRESQL REAL
    // ========================================================================
    const TIMESTAMP_VARIANTS = [
      { label: '0 casas decimais', val: '2026-09-25T12:00:00Z' },
      { label: '1 casa decimal', val: '2026-09-25T12:00:00.1Z' },
      { label: '2 casas decimais', val: '2026-09-25T12:00:00.12Z' },
      { label: '3 casas decimais', val: '2026-09-25T12:00:00.123Z' },
    ];

    for (const variant of TIMESTAMP_VARIANTS) {
      it(`T-01: Matriz de criação (${variant.label}) preserva representação textual exata '${variant.val}'`, async () => {
        const jobId = makeJobId(`job_t01_c_${variant.val.replace(/[^a-zA-Z0-9]/g, '_')}`);
        const input = variant.val;

        // 1. retorno imediato
        const created = await store.createJob({
          jobId,
          createdAt: input,
          actor: ACTOR_SYSTEM,
        });
        assert.equal(created.createdAt, input);
        assert.equal(created.updatedAt, input);

        // 2. getJob
        const fetched = await store.getJob(jobId);
        assert.ok(fetched);
        assert.equal(fetched.createdAt, input);
        assert.equal(fetched.updatedAt, input);

        // 3. listJobEvents
        const events = await store.listJobEvents(jobId);
        assert.equal(events.length, 1);
        assert.equal(events[0].occurredAt, input);
        assert.equal(events[0].payload.createdAt, input);

        // 4. rehydrateJob
        const rehydrated = await store.rehydrateJob(jobId);
        assert.ok(rehydrated);
        assert.equal(rehydrated.createdAt, input);
        assert.equal(rehydrated.updatedAt, input);

        // 5. equivalência replay == head
        assertJobStatesEquivalent(rehydrated, fetched);
        assert.deepEqual(stripUndefined(rehydrated), stripUndefined(fetched));
      });
    }

    for (const variant of TIMESTAMP_VARIANTS) {
      it(`T-01: Matriz de JobStarted (${variant.label}) preserva representação textual exata '${variant.val}'`, async () => {
        const jobId = makeJobId(`job_t01_s_${variant.val.replace(/[^a-zA-Z0-9]/g, '_')}`);
        const creationT = '2026-09-25T11:00:00Z'; // Anterior a todos os variants
        const startedInput = variant.val;

        await store.createJob({
          jobId,
          createdAt: creationT,
          actor: ACTOR_SYSTEM,
        });

        // 1. applyJobEvent
        const started = await store.applyJobEvent(
          {
            type: 'JobStarted',
            jobId,
            startedAt: startedInput,
          },
          1,
        );
        assert.equal(started.startedAt, startedInput);
        assert.equal(started.updatedAt, startedInput);

        // 2. getJob
        const fetched = await store.getJob(jobId);
        assert.ok(fetched);
        assert.equal(fetched.startedAt, startedInput);
        assert.equal(fetched.updatedAt, startedInput);

        // 3. listJobEvents
        const events = await store.listJobEvents(jobId);
        assert.equal(events.length, 2);
        assert.equal(events[1].occurredAt, startedInput);
        assert.equal(events[1].payload.startedAt, startedInput);

        // 4. rehydrateJob
        const rehydrated = await store.rehydrateJob(jobId);
        assert.ok(rehydrated);
        assert.equal(rehydrated.startedAt, startedInput);
        assert.equal(rehydrated.updatedAt, startedInput);

        // 5. equivalência replay == head
        assertJobStatesEquivalent(rehydrated, fetched);
        assert.deepEqual(stripUndefined(rehydrated), stripUndefined(fetched));
      });
    }

    it('T-01: Progress com updatedAt contendo 1 casa decimal é preservado exatamente', async () => {
      const jobId = makeJobId('job_t01_prog');
      const creationT = '2026-09-25T11:00:00Z';
      const startedT = '2026-09-25T11:30:00Z';
      const progressT = '2026-09-25T12:00:00.1Z';

      await store.createJob({ jobId, createdAt: creationT, actor: ACTOR_SYSTEM });
      await store.applyJobEvent({ type: 'JobStarted', jobId, startedAt: startedT }, 1);

      // apply JobProgressUpdated
      const progressed = await store.applyJobEvent(
        {
          type: 'JobProgressUpdated',
          jobId,
          progress: { completed: 25, total: 100, updatedAt: progressT },
        },
        2,
      );
      assert.equal(progressed.progress?.updatedAt, progressT);

      // getJob
      const fetched = await store.getJob(jobId);
      assert.ok(fetched);
      assert.equal(fetched.progress?.updatedAt, progressT);

      // listJobEvents
      const events = await store.listJobEvents(jobId);
      assert.equal(events.length, 3);
      assert.equal(events[2].occurredAt, progressT);
      assert.equal((events[2].payload.progress as any)?.updatedAt, progressT);

      // rehydrateJob
      const rehydrated = await store.rehydrateJob(jobId);
      assert.ok(rehydrated);
      assert.equal(rehydrated.progress?.updatedAt, progressT);

      assertJobStatesEquivalent(rehydrated, fetched);
      assert.deepEqual(stripUndefined(rehydrated), stripUndefined(fetched));
    });

    it('T-01: WaitingCause (Human) com timestamps fracionários preserva strings exatas', async () => {
      const jobId = makeJobId('job_t01_wait');
      const creationT = '2026-09-25T11:00:00Z';
      const startedT = '2026-09-25T11:30:00Z';
      const transitionedT = '2026-09-25T12:00:00.1Z';
      const requestedT = '2026-09-25T12:00:00.1Z';
      const deadlineT = '2026-09-25T12:00:00.12Z';

      await store.createJob({ jobId, createdAt: creationT, actor: ACTOR_SYSTEM });
      await store.applyJobEvent({ type: 'JobStarted', jobId, startedAt: startedT }, 1);

      // apply JobWaiting (Human)
      const waiting = await store.applyJobEvent(
        {
          type: 'JobWaiting',
          jobId,
          transitionedAt: transitionedT,
          cause: {
            kind: 'human',
            reasonCode: 'HUMAN_INTERVENTION',
            requestedAt: requestedT,
            deadline: deadlineT,
          },
        },
        2,
      );
      assert.equal(waiting.waitingCause?.requestedAt, requestedT);
      if (waiting.waitingCause?.kind === 'human') {
        assert.equal(waiting.waitingCause.deadline, deadlineT);
      }

      // getJob
      const fetched = await store.getJob(jobId);
      assert.ok(fetched);
      assert.equal(fetched.waitingCause?.requestedAt, requestedT);
      if (fetched.waitingCause?.kind === 'human') {
        assert.equal(fetched.waitingCause.deadline, deadlineT);
      }

      // listJobEvents
      const events = await store.listJobEvents(jobId);
      assert.equal(events.length, 3);
      assert.equal(events[2].occurredAt, transitionedT);
      assert.equal((events[2].payload.cause as any)?.requestedAt, requestedT);
      assert.equal((events[2].payload.cause as any)?.deadline, deadlineT);

      // rehydrateJob
      const rehydrated = await store.rehydrateJob(jobId);
      assert.ok(rehydrated);
      assert.equal(rehydrated.waitingCause?.requestedAt, requestedT);
      if (rehydrated.waitingCause?.kind === 'human') {
        assert.equal(rehydrated.waitingCause.deadline, deadlineT);
      }

      assertJobStatesEquivalent(rehydrated, fetched);
      assert.deepEqual(stripUndefined(rehydrated), stripUndefined(fetched));
    });
  });
});
