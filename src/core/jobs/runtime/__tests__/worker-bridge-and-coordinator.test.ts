/**
 * NEX+ · Atomic Enqueue & Worker Bridge — Unit Tests
 * Testes Unitários de Coordenação Transacional e Worker Bridge — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3C)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { JobState, JobEvent, CreateJobParams } from '../../contracts';
import type { DurableJobStore } from '../../persistence/contracts';
import {
  PostgresJobStore,
  assertNoTransactionControlSql,
  type PostgresJobStoreWriteTransactionScope,
} from '../../persistence/postgres';
import type {
  JobClaimStore,
  JobClaimSnapshot,
  AcquireJobClaimResult,
  ReleaseJobClaimParams,
} from '../../claims/contracts';
import {
  createPgBossRuntime,
  PgBossRuntime,
  PgBossRuntimeError,
  PG_BOSS_DEFAULT_WAKEUP_QUEUE,
  type IPgBossRuntime,
  type PgBossDeliveryAttemptRef,
  type PgBossSendResult,
  type PgBossSettlementResult,
  type PgBossTransactionDb,
  type PgBossWakeupMessage,
} from '../index';
import {
  createJobAndWakeup,
  applyJobEventAndWakeup,
  adaptTransactionalClientToPgBossDb,
} from '../coordinator';
import {
  JobWorkerBridge,
  WorkerBridgeError,
  WorkerBridgeTechnicalStaleError,
  composeBridgeCallbackError,
  composeBridgeReleaseError,
} from '../worker-bridge';

// ============================================================================
// FIXTURES E MOCKS LEVES PARA TESTES UNITÁRIOS
// ============================================================================

function createSampleJobState(jobId = 'job_01J8NEXPLUS001', revision = 1): JobState {
  return {
    jobId,
    status: 'queued',
    revision,
    createdAt: '2026-09-28T22:00:00Z',
    updatedAt: '2026-09-28T22:00:00Z',
    actor: { kind: 'system', component: 'orchestrator' },
    attemptLineage: [],
  };
}

function createSampleClaimSnapshot(
  jobId = 'job_01J8NEXPLUS001',
  workerId = 'worker_alpha',
  fencingToken = '1',
): JobClaimSnapshot {
  return {
    jobId,
    workerId,
    fencingToken,
    acquiredAt: '2026-09-28T22:00:01Z',
    renewedAt: '2026-09-28T22:00:01Z',
    leaseUntil: '2026-09-28T22:05:01Z',
    state: 'active',
  };
}

describe('Atomic Enqueue & Worker Bridge Unit Tests (0.86C-3C)', () => {
  // ==========================================================================
  // 1. sendWakeupInTransaction UNIT TESTS
  // ==========================================================================
  describe('PgBossRuntime · sendWakeupInTransaction', () => {
    it('impede sendWakeupInTransaction se runtime não foi iniciado', async () => {
      const runtime = createPgBossRuntime({
        connectionString: 'postgres://dummy:dummy@localhost:5432/dummy',
      });
      const dummyDb: PgBossTransactionDb = {
        async executeSql() {
          return { rows: [], rowCount: 0 };
        },
      };

      await assert.rejects(
        async () => {
          await runtime.sendWakeupInTransaction(
            PG_BOSS_DEFAULT_WAKEUP_QUEUE,
            { jobId: 'job_01' },
            dummyDb,
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof PgBossRuntimeError);
          assert.equal(err.code, 'RUNTIME_NOT_STARTED');
          return true;
        },
      );
    });

    it('rejeita sendWakeupInTransaction se db for inválido ou omitido', async () => {
      const runtime = createPgBossRuntime({
        connectionString: 'postgres://dummy:dummy@localhost:5432/dummy',
      });

      // Validação de db ocorre mesmo antes do start ou durante
      await assert.rejects(
        async () => {
          await runtime.sendWakeupInTransaction(
            PG_BOSS_DEFAULT_WAKEUP_QUEUE,
            { jobId: 'job_01' },
            null as unknown as PgBossTransactionDb,
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof PgBossRuntimeError);
          assert.equal(err.code, 'SEND_FAILURE');
          assert.ok(err.message.includes('valid PgBossTransactionDb is required'));
          return true;
        },
      );
    });

    it('valida payload com fail-closed em sendWakeupInTransaction antes de qualquer interação técnica', async () => {
      const runtime = createPgBossRuntime({
        connectionString: 'postgres://dummy:dummy@localhost:5432/dummy',
      });
      const dummyDb: PgBossTransactionDb = {
        async executeSql() {
          return { rows: [], rowCount: 0 };
        },
      };

      await assert.rejects(
        async () => {
          await runtime.sendWakeupInTransaction(
            PG_BOSS_DEFAULT_WAKEUP_QUEUE,
            { jobId: '' },
            dummyDb,
          );
        },
        { name: 'JobWakeupPayloadError' },
      );

      await assert.rejects(
        async () => {
          await runtime.sendWakeupInTransaction(
            PG_BOSS_DEFAULT_WAKEUP_QUEUE,
            { jobId: 'job_01', extra: 'forbidden' } as any,
            dummyDb,
          );
        },
        { name: 'JobWakeupPayloadError' },
      );
    });

    it('sendWakeupInTransaction repassa db fornecido para o boss.send sem chamar BEGIN ou COMMIT no db', async () => {
      const runtime = createPgBossRuntime({
        connectionString: 'postgres://dummy:dummy@localhost:5432/dummy',
      });

      let sendCalledWithOptions: any = null;
      (runtime as any)._isStarted = true;
      (runtime as any)._boss = {
        async send(name: string, payload: any, options: any) {
          sendCalledWithOptions = options;
          return 'msg_generated_123';
        },
      };

      const sqlExecuted: string[] = [];
      const mockDb: PgBossTransactionDb = {
        async executeSql(text: string) {
          sqlExecuted.push(text);
          return { rows: [], rowCount: 0 };
        },
      };

      const result = await runtime.sendWakeupInTransaction(
        PG_BOSS_DEFAULT_WAKEUP_QUEUE,
        { jobId: 'job_tx_001' },
        mockDb,
      );

      assert.equal(result.messageId, 'msg_generated_123');
      assert.ok(sendCalledWithOptions);
      assert.equal(sendCalledWithOptions.db, mockDb);
      // Confirma que runtime não injetou BEGIN nem COMMIT no db (ownership do caller)
      assert.equal(sqlExecuted.length, 0);
    });
  });

  // ==========================================================================
  // 2. failWakeup UNIT TESTS
  // ==========================================================================
  describe('PgBossRuntime · failWakeup', () => {
    it('impede failWakeup se runtime não foi iniciado', async () => {
      const runtime = createPgBossRuntime({
        connectionString: 'postgres://dummy:dummy@localhost:5432/dummy',
      });

      await assert.rejects(
        async () => {
          await runtime.failWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
            id: 'attempt_01',
            retryCount: 0,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof PgBossRuntimeError);
          assert.equal(err.code, 'RUNTIME_NOT_STARTED');
          return true;
        },
      );
    });

    it('valida target de attempt fail-closed em failWakeup', async () => {
      const runtime = createPgBossRuntime({
        connectionString: 'postgres://dummy:dummy@localhost:5432/dummy',
      });

      await assert.rejects(
        async () => {
          await runtime.failWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
            id: '',
            retryCount: 0,
          });
        },
        { name: 'DeliveryAttemptError' },
      );

      await assert.rejects(
        async () => {
          await runtime.failWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
            id: 'valid_id',
            retryCount: -1,
          });
        },
        { name: 'DeliveryAttemptError' },
      );
    });

    it('retorna settled: true quando affected === 1 e settled: false quando affected === 0', async () => {
      const runtime = createPgBossRuntime({
        connectionString: 'postgres://dummy:dummy@localhost:5432/dummy',
      });
      (runtime as any)._isStarted = true;

      // Caso 1: affected === 1
      (runtime as any)._boss = {
        async fail() {
          return { affected: 1 };
        },
      };
      const res1 = await runtime.failWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
        id: 'msg_01',
        retryCount: 0,
      });
      assert.deepEqual(res1, { settled: true, affected: 1 });

      // Caso 2: affected === 0 (tentativa stale)
      (runtime as any)._boss = {
        async fail() {
          return { affected: 0 };
        },
      };
      const res2 = await runtime.failWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
        id: 'msg_01',
        retryCount: 0,
      });
      assert.deepEqual(res2, { settled: false, affected: 0 });
    });

    it('rejeita affected malformado fail-closed com SETTLEMENT_FAILURE', async () => {
      const runtime = createPgBossRuntime({
        connectionString: 'postgres://dummy:dummy@localhost:5432/dummy',
      });
      (runtime as any)._isStarted = true;
      (runtime as any)._boss = {
        async fail() {
          return { affected: 2 };
        },
      };

      await assert.rejects(
        async () => {
          await runtime.failWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
            id: 'msg_01',
            retryCount: 0,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof PgBossRuntimeError);
          assert.equal(err.code, 'SETTLEMENT_FAILURE');
          return true;
        },
      );
    });
  });

  // ==========================================================================
  // 3. COORDINATOR ATÔMICO UNIT TESTS
  // ==========================================================================
  describe('Coordinator Atômico · createJobAndWakeup & applyJobEventAndWakeup', () => {
    it('adaptTransactionalClientToPgBossDb delega query para executeSql corretamente', async () => {
      let queriedSql = '';
      let queriedParams: unknown[] | undefined;

      const mockClient = {
        async query(sql: string, params?: unknown[]) {
          queriedSql = sql;
          queriedParams = params;
          return { rows: [{ val: 42 }], rowCount: 1 };
        },
        release() {},
      } as any;

      const txDb = adaptTransactionalClientToPgBossDb(mockClient);
      const res = await txDb.executeSql('SELECT $1::int as val', [42]);

      assert.equal(queriedSql, 'SELECT $1::int as val');
      assert.deepEqual(queriedParams, [42]);
      assert.deepEqual(res.rows, [{ val: 42 }]);
      assert.equal(res.rowCount, 1);
    });

    it('createJobAndWakeup lança SEND_FAILURE e provoca rollback se messageId for null', async () => {
      const sampleJob = createSampleJobState();
      let createJobCalled = false;

      const mockScope: PostgresJobStoreWriteTransactionScope = {
        async createJob() {
          createJobCalled = true;
          return sampleJob;
        },
        async applyJobEvent() {
          return sampleJob;
        },
        transactionDb: {
          async executeSql() {
            return { rows: [], rowCount: 0 };
          },
        },
      };

      const mockStore = {
        async withWriteTransaction<T>(
          cb: (scope: PostgresJobStoreWriteTransactionScope) => Promise<T>,
        ): Promise<T> {
          return await cb(mockScope);
        },
      } as unknown as PostgresJobStore;

      const mockRuntime = {
        async sendWakeupInTransaction(): Promise<PgBossSendResult> {
          return { messageId: null }; // messageId nulo simulando falha do provider
        },
      } as unknown as IPgBossRuntime;

      const params: CreateJobParams = {
        jobId: 'job_01J8NEXPLUS001',
        createdAt: '2026-09-28T22:00:00.000Z',
        actor: { kind: 'system', component: 'orchestrator' },
      };

      await assert.rejects(
        async () => {
          await createJobAndWakeup(mockStore, mockRuntime, params);
        },
        (err: unknown) => {
          assert.ok(err instanceof PgBossRuntimeError);
          assert.equal(err.code, 'SEND_FAILURE');
          assert.ok(err.message.includes('returned null messageId'));
          return true;
        },
      );

      assert.equal(createJobCalled, true);
    });

    it('applyJobEventAndWakeup lança SEND_FAILURE e provoca rollback se messageId for null', async () => {
      const sampleJob = createSampleJobState('job_01J8NEXPLUS001', 2);
      let applyEventCalled = false;

      const mockScope: PostgresJobStoreWriteTransactionScope = {
        async createJob() {
          return sampleJob;
        },
        async applyJobEvent() {
          applyEventCalled = true;
          return sampleJob;
        },
        transactionDb: {
          async executeSql() {
            return { rows: [], rowCount: 0 };
          },
        },
      };

      const mockStore = {
        async withWriteTransaction<T>(
          cb: (scope: PostgresJobStoreWriteTransactionScope) => Promise<T>,
        ): Promise<T> {
          return await cb(mockScope);
        },
      } as unknown as PostgresJobStore;

      const mockRuntime = {
        async sendWakeupInTransaction(): Promise<PgBossSendResult> {
          return { messageId: null };
        },
      } as unknown as IPgBossRuntime;

      const event: JobEvent = {
        type: 'JobStarted',
        jobId: 'job_01J8NEXPLUS001',
        attemptId: 'att_001',
        startedAt: '2026-09-28T22:01:00Z',
      };

      await assert.rejects(
        async () => {
          await applyJobEventAndWakeup(mockStore, mockRuntime, event, 1);
        },
        (err: unknown) => {
          assert.ok(err instanceof PgBossRuntimeError);
          assert.equal(err.code, 'SEND_FAILURE');
          return true;
        },
      );

      assert.equal(applyEventCalled, true);
    });
  });

  // ==========================================================================
  // 4. WORKER BRIDGE UNIT TESTS
  // ==========================================================================
  describe('JobWorkerBridge Unit Tests', () => {
    it('valida opções defensivas: rejeita workerId inválido e leaseDurationMs inválido', () => {
      const mockRuntime = {} as IPgBossRuntime;
      const mockJobStore = {} as DurableJobStore;
      const mockClaimStore = {} as JobClaimStore;

      assert.throws(
        () =>
          new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
            workerId: '',
            leaseDurationMs: 30000,
          }),
        { name: 'JobClaimInvariantsError' },
      );

      assert.throws(
        () =>
          new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
            workerId: 'worker_01',
            leaseDurationMs: 0,
          }),
        { name: 'JobClaimInvariantsError' },
      );
    });

    it('retorna outcome: idle quando fetchWakeup não traz mensagens', async () => {
      const mockRuntime = {
        async fetchWakeup(): Promise<readonly PgBossWakeupMessage[]> {
          return [];
        },
      } as unknown as IPgBossRuntime;
      const mockJobStore = {} as DurableJobStore;
      const mockClaimStore = {} as JobClaimStore;

      const bridge = new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
        workerId: 'worker_01',
        leaseDurationMs: 30000,
      });

      let callbackCalled = false;
      const result = await bridge.processNext(async () => {
        callbackCalled = true;
      });

      assert.equal(result.outcome, 'idle');
      assert.equal(callbackCalled, false);
    });

    it('retorna outcome: orphaned e liquida delivery se Job não existe, sem chamar callback nem acquireClaim', async () => {
      let completeTarget: PgBossDeliveryAttemptRef | null = null;

      const mockRuntime = {
        async fetchWakeup(): Promise<readonly PgBossWakeupMessage[]> {
          return [
            {
              id: 'deliv_orphan_1',
              name: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
              data: { jobId: 'job_inexistente' },
              retryCount: 0,
            },
          ];
        },
        async completeWakeup(_queue: string, target: PgBossDeliveryAttemptRef): Promise<PgBossSettlementResult> {
          completeTarget = target;
          return { settled: true, affected: 1 };
        },
      } as unknown as IPgBossRuntime;

      const mockJobStore = {
        async rehydrateJob(): Promise<JobState | undefined> {
          return undefined; // Job não encontrado
        },
      } as unknown as DurableJobStore;

      let acquireCalled = false;
      const mockClaimStore = {
        async acquireClaim(): Promise<AcquireJobClaimResult> {
          acquireCalled = true;
          return { acquired: false, reason: 'held' };
        },
      } as unknown as JobClaimStore;

      const bridge = new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
        workerId: 'worker_01',
        leaseDurationMs: 30000,
      });

      let callbackCalled = false;
      const result = await bridge.processNext(async () => {
        callbackCalled = true;
      });

      assert.equal(result.outcome, 'orphaned');
      assert.equal(result.jobId, 'job_inexistente');
      assert.equal(callbackCalled, false);
      assert.equal(acquireCalled, false);
      assert.deepEqual(completeTarget, { id: 'deliv_orphan_1', retryCount: 0 });
    });

    it('retorna outcome: held e liquida delivery duplicada se claim estiver retido por outro worker', async () => {
      let completeTarget: PgBossDeliveryAttemptRef | null = null;

      const mockRuntime = {
        async fetchWakeup(): Promise<readonly PgBossWakeupMessage[]> {
          return [
            {
              id: 'deliv_held_1',
              name: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
              data: { jobId: 'job_01J8NEXPLUS001' },
              retryCount: 0,
            },
          ];
        },
        async completeWakeup(_queue: string, target: PgBossDeliveryAttemptRef): Promise<PgBossSettlementResult> {
          completeTarget = target;
          return { settled: true, affected: 1 };
        },
      } as unknown as IPgBossRuntime;

      const sampleJob = createSampleJobState();
      const mockJobStore = {
        async rehydrateJob(): Promise<JobState | undefined> {
          return sampleJob;
        },
      } as unknown as DurableJobStore;

      const mockClaimStore = {
        async acquireClaim(): Promise<AcquireJobClaimResult> {
          return { acquired: false, reason: 'held' };
        },
      } as unknown as JobClaimStore;

      const bridge = new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
        workerId: 'worker_02',
        leaseDurationMs: 30000,
      });

      let callbackCalled = false;
      const result = await bridge.processNext(async () => {
        callbackCalled = true;
      });

      assert.equal(result.outcome, 'held');
      assert.equal(result.jobId, 'job_01J8NEXPLUS001');
      assert.equal(callbackCalled, false);
      assert.deepEqual(completeTarget, { id: 'deliv_held_1', retryCount: 0 });
    });

    it('happy path: adquire claim, executa callback, libera claim e liquida delivery com processed', async () => {
      const sampleJob = createSampleJobState();
      const sampleClaim = createSampleClaimSnapshot('job_01J8NEXPLUS001', 'worker_alpha', '1');

      let completeTarget: PgBossDeliveryAttemptRef | null = null;
      let releasedClaimParams: ReleaseJobClaimParams | null = null;

      const mockRuntime = {
        async fetchWakeup(): Promise<readonly PgBossWakeupMessage[]> {
          return [
            {
              id: 'deliv_happy_1',
              name: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
              data: { jobId: 'job_01J8NEXPLUS001' },
              retryCount: 0,
            },
          ];
        },
        async completeWakeup(_queue: string, target: PgBossDeliveryAttemptRef): Promise<PgBossSettlementResult> {
          completeTarget = target;
          return { settled: true, affected: 1 };
        },
      } as unknown as IPgBossRuntime;

      const mockJobStore = {
        async rehydrateJob(): Promise<JobState | undefined> {
          return sampleJob;
        },
      } as unknown as DurableJobStore;

      const mockClaimStore = {
        async acquireClaim(): Promise<AcquireJobClaimResult> {
          return { acquired: true, claim: sampleClaim };
        },
        async releaseClaim(params: ReleaseJobClaimParams) {
          releasedClaimParams = params;
          return {
            ...sampleClaim,
            status: 'released' as const,
            releasedAt: '2026-09-28T22:00:05Z',
          };
        },
      } as unknown as JobClaimStore;

      const bridge = new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
        workerId: 'worker_alpha',
        leaseDurationMs: 30000,
      });

      let callbackContextReceived: any = null;
      const result = await bridge.processNext(async (ctx) => {
        callbackContextReceived = ctx;
      });

      assert.equal(result.outcome, 'processed');
      assert.equal(result.fencingToken, '1');
      assert.ok(callbackContextReceived);
      assert.equal(callbackContextReceived.job.jobId, 'job_01J8NEXPLUS001');
      assert.equal(callbackContextReceived.claim.fencingToken, '1');
      assert.deepEqual(releasedClaimParams, {
        jobId: 'job_01J8NEXPLUS001',
        workerId: 'worker_alpha',
        fencingToken: '1',
      });
      assert.deepEqual(completeTarget, { id: 'deliv_happy_1', retryCount: 0 });
    });

    it('quando callback falha: tenta release do claim, aciona failWakeup e preserva todos os erros estruturadamente', async () => {
      const sampleJob = createSampleJobState();
      const sampleClaim = createSampleClaimSnapshot();

      let releaseAttempted = false;
      let failedTarget: PgBossDeliveryAttemptRef | null = null;

      const mockRuntime = {
        async fetchWakeup(): Promise<readonly PgBossWakeupMessage[]> {
          return [
            {
              id: 'deliv_fail_1',
              name: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
              data: { jobId: 'job_01J8NEXPLUS001' },
              retryCount: 0,
            },
          ];
        },
        async failWakeup(_queue: string, target: PgBossDeliveryAttemptRef): Promise<PgBossSettlementResult> {
          failedTarget = target;
          return { settled: true, affected: 1 };
        },
      } as unknown as IPgBossRuntime;

      const mockJobStore = {
        async rehydrateJob(): Promise<JobState | undefined> {
          return sampleJob;
        },
      } as unknown as DurableJobStore;

      const mockClaimStore = {
        async acquireClaim(): Promise<AcquireJobClaimResult> {
          return { acquired: true, claim: sampleClaim };
        },
        async releaseClaim() {
          releaseAttempted = true;
          return {
            ...sampleClaim,
            status: 'released' as const,
            releasedAt: '2026-09-28T22:00:05Z',
          };
        },
      } as unknown as JobClaimStore;

      const bridge = new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
        workerId: 'worker_alpha',
        leaseDurationMs: 30000,
      });

      const primaryCallbackError = new Error('Explicit domain test error inside callback');

      await assert.rejects(
        async () => {
          await bridge.processNext(async () => {
            throw primaryCallbackError;
          });
        },
        (err: unknown) => {
          assert.equal(err, primaryCallbackError);
          return true;
        },
      );

      assert.equal(releaseAttempted, true);
      assert.deepEqual(failedTarget, { id: 'deliv_fail_1', retryCount: 0 });
    });

    it('composeBridgeCallbackError preserva falhas secundárias em AggregateError quando release ou failWakeup falham', () => {
      const primary = new Error('Callback business logic failure');
      const releaseErr = new Error('Network timeout during releaseClaim');
      const failErr = new Error('pg-boss connection refused during failWakeup');

      const composed = composeBridgeCallbackError(primary, releaseErr, failErr);

      assert.ok(composed instanceof WorkerBridgeError);
      assert.equal(composed.primaryError, primary);
      assert.equal(composed.releaseError, releaseErr);
      assert.equal(composed.technicalSettlementError, failErr);
      assert.ok(composed.message.includes('Callback business logic failure'));
      assert.ok(composed.message.includes('Network timeout during releaseClaim'));
      assert.ok(composed.message.includes('pg-boss connection refused'));
      assert.ok(composed.cause instanceof AggregateError);
    });

    it('composeBridgeReleaseError preserva falha técnica em AggregateError quando failWakeup também falha pós release inválido', () => {
      const releaseErr = new Error('Claim was stolen by worker B');
      const failErr = new Error('Queue connection reset');

      const composed = composeBridgeReleaseError(releaseErr, failErr);

      assert.ok(composed instanceof WorkerBridgeError);
      assert.equal(composed.primaryError, releaseErr);
      assert.equal(composed.technicalSettlementError, failErr);
      assert.ok(composed.message.includes('Claim was stolen'));
      assert.ok(composed.message.includes('Queue connection reset'));
      assert.ok(composed.cause instanceof AggregateError);
    });
  });

  // ==========================================================================
  // 5. TRANSACTION BOUNDARY & FAÇADE TESTS (F-3C-01)
  // ==========================================================================
  describe('PostgresJobStoreWriteTransactionScope & transactionDb façade (F-3C-01)', () => {
    it('scope entregue ao callback não possui release, client, connect ou end', async () => {
      const fakeClient = {
        async query() {
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
      const fakeExecutor = {
        async connect() {
          return fakeClient;
        },
      };

      const store = new PostgresJobStore(fakeExecutor as any);

      await store.withWriteTransaction(async (scope) => {
        // 1. Prova que client NÃO é exposto
        assert.equal((scope as unknown as Record<string, unknown>).client, undefined);

        // 2. Prova que release NÃO existe no scope
        assert.equal((scope as unknown as Record<string, unknown>).release, undefined);

        // 3. Prova que connect NÃO existe no scope
        assert.equal((scope as unknown as Record<string, unknown>).connect, undefined);

        // 4. Prova que end NÃO existe no scope
        assert.equal((scope as unknown as Record<string, unknown>).end, undefined);

        // 5. Prova que transactionDb existe e expõe somente executeSql
        assert.ok(scope.transactionDb);
        assert.equal(typeof scope.transactionDb.executeSql, 'function');
        assert.equal((scope.transactionDb as unknown as Record<string, unknown>).release, undefined);
        assert.equal((scope.transactionDb as unknown as Record<string, unknown>).end, undefined);
        assert.equal((scope.transactionDb as unknown as Record<string, unknown>).client, undefined);
      });
    });

    it('rejeita comandos de controle transacional (COMMIT, ROLLBACK, BEGIN, START, SAVEPOINT, RELEASE, SET TRANSACTION) antes de chamar o PG client', async () => {
      let clientQueryCalls = 0;
      const fakeClient = {
        async query() {
          clientQueryCalls++;
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
      const fakeExecutor = {
        async connect() {
          return fakeClient;
        },
      };

      const store = new PostgresJobStore(fakeExecutor as any);

      const forbiddenCommands = [
        'COMMIT',
        'commit',
        '  COMMIT  ',
        'COMMIT;',
        'ROLLBACK',
        'rollback',
        'ROLLBACK WORK',
        'ROLLBACK TO SAVEPOINT sp1',
        'BEGIN',
        'begin',
        'START TRANSACTION',
        'start transaction read write',
        'SAVEPOINT sp1',
        'RELEASE SAVEPOINT sp1',
        'RELEASE sp1',
        'END',
        'end',
        'ABORT',
        'abort',
        'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
        '/* comment */ COMMIT',
        '-- single line comment\nROLLBACK',
      ];

      await store.withWriteTransaction(async (scope) => {
        const baselineQueries = clientQueryCalls;

        for (const cmd of forbiddenCommands) {
          await assert.rejects(
            async () => {
              await scope.transactionDb.executeSql(cmd);
            },
            (err: unknown) => {
              assert.ok(err instanceof Error);
              assert.ok(
                err.message.includes('prohibited in transactionDb façade'),
                `Esperado erro proibindo controle transacional para: ${cmd}. Recebido: ${err.message}`,
              );
              return true;
            },
          );
        }

        // Prova que NENHUM desses comandos chegou ao client.query!
        assert.equal(clientQueryCalls, baselineQueries);

        // Prova que comandos SQL normais passam normalmente
        const validRes = await scope.transactionDb.executeSql('SELECT 1');
        assert.ok(validRes);
        assert.equal(clientQueryCalls, baselineQueries + 1);
      });
    });

    it('assertNoTransactionControlSql não bloqueia queries legítimas contendo palavras-chave em strings ou colunas', () => {
      assert.doesNotThrow(() => {
        assertNoTransactionControlSql("SELECT * FROM jobs WHERE status = 'COMMIT'");
      });
      assert.doesNotThrow(() => {
        assertNoTransactionControlSql("UPDATE jobs SET commit_hash = 'abcdef' WHERE id = 1");
      });
      assert.doesNotThrow(() => {
        assertNoTransactionControlSql("INSERT INTO logs (message) VALUES ('rollback initiated')");
      });
    });
  });

  // ==========================================================================
  // 6. TECHNICAL STALE ON FAILURE PATHS (F-3C-02)
  // ==========================================================================
  describe('WorkerBridge Technical Stale on Failure Paths (F-3C-02)', () => {
    it('quando callback falha e failWakeup retorna affected=0 (stale): preserva erro primário do callback e anexa WorkerBridgeTechnicalStaleError', async () => {
      const sampleJob = createSampleJobState();
      const sampleClaim = createSampleClaimSnapshot();

      const mockRuntime = {
        async fetchWakeup(): Promise<readonly PgBossWakeupMessage[]> {
          return [
            {
              id: 'deliv_stale_callback_fail',
              name: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
              data: { jobId: 'job_01J8NEXPLUS001' },
              retryCount: 2,
            },
          ];
        },
        async failWakeup(): Promise<PgBossSettlementResult> {
          return { settled: false, affected: 0 };
        },
      } as unknown as IPgBossRuntime;

      const mockJobStore = {
        async rehydrateJob(): Promise<JobState | undefined> {
          return sampleJob;
        },
      } as unknown as DurableJobStore;

      const mockClaimStore = {
        async acquireClaim(): Promise<AcquireJobClaimResult> {
          return { acquired: true, claim: sampleClaim };
        },
        async releaseClaim() {
          return {
            ...sampleClaim,
            status: 'released' as const,
            releasedAt: '2026-09-28T22:00:05Z',
          };
        },
      } as unknown as JobClaimStore;

      const bridge = new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
        workerId: 'worker_alpha',
        leaseDurationMs: 30000,
      });

      const callbackError = new Error('Callback business computation crashed');

      await assert.rejects(
        async () => {
          await bridge.processNext(async () => {
            throw callbackError;
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof WorkerBridgeError);
          assert.equal(err.primaryError, callbackError);
          assert.equal(err.hasReleaseError, false);
          assert.equal(err.hasTechnicalSettlementError, true);
          assert.ok(err.technicalSettlementError instanceof WorkerBridgeTechnicalStaleError);
          assert.equal(err.technicalSettlementError.deliveryId, 'deliv_stale_callback_fail');
          assert.equal(err.technicalSettlementError.retryCount, 2);
          assert.equal(err.technicalSettlementError.queueName, PG_BOSS_DEFAULT_WAKEUP_QUEUE);
          assert.ok(err.message.includes('Technical attempt is stale'));
          return true;
        },
      );
    });

    it('quando callback tem sucesso mas release falha e failWakeup retorna affected=0 (stale): preserva erro primário do release e anexa WorkerBridgeTechnicalStaleError', async () => {
      const sampleJob = createSampleJobState();
      const sampleClaim = createSampleClaimSnapshot();

      const mockRuntime = {
        async fetchWakeup(): Promise<readonly PgBossWakeupMessage[]> {
          return [
            {
              id: 'deliv_stale_release_fail',
              name: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
              data: { jobId: 'job_01J8NEXPLUS001' },
              retryCount: 0,
            },
          ];
        },
        async failWakeup(): Promise<PgBossSettlementResult> {
          return { settled: false, affected: 0 };
        },
      } as unknown as IPgBossRuntime;

      const mockJobStore = {
        async rehydrateJob(): Promise<JobState | undefined> {
          return sampleJob;
        },
      } as unknown as DurableJobStore;

      const releaseError = new Error('Claim fence mismatch on release');
      const mockClaimStore = {
        async acquireClaim(): Promise<AcquireJobClaimResult> {
          return { acquired: true, claim: sampleClaim };
        },
        async releaseClaim() {
          throw releaseError;
        },
      } as unknown as JobClaimStore;

      const bridge = new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
        workerId: 'worker_alpha',
        leaseDurationMs: 30000,
      });

      await assert.rejects(
        async () => {
          await bridge.processNext(async () => {
            // callback succeeds
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof WorkerBridgeError);
          assert.equal(err.primaryError, releaseError);
          assert.equal(err.hasReleaseError, false);
          assert.equal(err.hasTechnicalSettlementError, true);
          assert.ok(err.technicalSettlementError instanceof WorkerBridgeTechnicalStaleError);
          assert.equal(err.technicalSettlementError.deliveryId, 'deliv_stale_release_fail');
          assert.equal(err.technicalSettlementError.retryCount, 0);
          return true;
        },
      );
    });
  });

  // ==========================================================================
  // 7. FALSEY ERRORS & EXPLICIT PRESENCE (F-3C-03)
  // ==========================================================================
  describe('WorkerBridge Falsey Errors & Explicit Presence (F-3C-03)', () => {
    it('composeBridgeCallbackError preserva erro secundário quando lançado como false', () => {
      const primary = new Error('Primary error');
      const composed = composeBridgeCallbackError(
        primary,
        { hasError: true, error: false },
        { hasError: false },
      );

      assert.ok(composed instanceof WorkerBridgeError);
      assert.equal(composed.primaryError, primary);
      assert.equal(composed.hasReleaseError, true);
      assert.equal(composed.releaseError, false);
      assert.equal(composed.hasTechnicalSettlementError, false);
      assert.ok(composed.message.includes('(release error: false)'));
    });

    it('composeBridgeCallbackError preserva erro secundário quando lançado como undefined', () => {
      const primary = new Error('Primary error');
      const composed = composeBridgeCallbackError(
        primary,
        { hasError: false },
        { hasError: true, error: undefined },
      );

      assert.ok(composed instanceof WorkerBridgeError);
      assert.equal(composed.primaryError, primary);
      assert.equal(composed.hasReleaseError, false);
      assert.equal(composed.hasTechnicalSettlementError, true);
      assert.equal(composed.technicalSettlementError, undefined);
      assert.ok(composed.message.includes('(failWakeup error: undefined)'));
    });

    it('composeBridgeCallbackError preserva erro secundário quando lançado como 0 ou string vazia', () => {
      const primary = new Error('Primary error');
      const composed = composeBridgeCallbackError(
        primary,
        { hasError: true, error: 0 },
        { hasError: true, error: '' },
      );

      assert.ok(composed instanceof WorkerBridgeError);
      assert.equal(composed.hasReleaseError, true);
      assert.equal(composed.releaseError, 0);
      assert.equal(composed.hasTechnicalSettlementError, true);
      assert.equal(composed.technicalSettlementError, '');
    });

    it('WorkerBridge captura e preserva quando o callback lança valor falsey (ex: throw false)', async () => {
      const sampleJob = createSampleJobState();
      const sampleClaim = createSampleClaimSnapshot();

      const mockRuntime = {
        async fetchWakeup(): Promise<readonly PgBossWakeupMessage[]> {
          return [
            {
              id: 'deliv_falsey_callback',
              name: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
              data: { jobId: 'job_01J8NEXPLUS001' },
              retryCount: 0,
            },
          ];
        },
        async failWakeup(): Promise<PgBossSettlementResult> {
          return { settled: true, affected: 1 };
        },
      } as unknown as IPgBossRuntime;

      const mockJobStore = {
        async rehydrateJob(): Promise<JobState | undefined> {
          return sampleJob;
        },
      } as unknown as DurableJobStore;

      const mockClaimStore = {
        async acquireClaim(): Promise<AcquireJobClaimResult> {
          return { acquired: true, claim: sampleClaim };
        },
        async releaseClaim() {
          return {
            ...sampleClaim,
            status: 'released' as const,
            releasedAt: '2026-09-28T22:00:05Z',
          };
        },
      } as unknown as JobClaimStore;

      const bridge = new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
        workerId: 'worker_alpha',
        leaseDurationMs: 30000,
      });

      await assert.rejects(
        async () => {
          await bridge.processNext(async () => {
            throw false;
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, 'false');
          return true;
        },
      );
    });

    it('WorkerBridge captura e preserva valor falsey lançado no release quando callback falha', async () => {
      const sampleJob = createSampleJobState();
      const sampleClaim = createSampleClaimSnapshot();

      const mockRuntime = {
        async fetchWakeup(): Promise<readonly PgBossWakeupMessage[]> {
          return [
            {
              id: 'deliv_falsey_both',
              name: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
              data: { jobId: 'job_01J8NEXPLUS001' },
              retryCount: 0,
            },
          ];
        },
        async failWakeup(): Promise<PgBossSettlementResult> {
          return { settled: true, affected: 1 };
        },
      } as unknown as IPgBossRuntime;

      const mockJobStore = {
        async rehydrateJob(): Promise<JobState | undefined> {
          return sampleJob;
        },
      } as unknown as DurableJobStore;

      const mockClaimStore = {
        async acquireClaim(): Promise<AcquireJobClaimResult> {
          return { acquired: true, claim: sampleClaim };
        },
        async releaseClaim() {
          throw false;
        },
      } as unknown as JobClaimStore;

      const bridge = new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
        workerId: 'worker_alpha',
        leaseDurationMs: 30000,
      });

      await assert.rejects(
        async () => {
          await bridge.processNext(async () => {
            throw new Error('primary_callback_fail');
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof WorkerBridgeError);
          assert.equal(err.hasReleaseError, true);
          assert.equal(err.releaseError, false);
          assert.equal(err.hasTechnicalSettlementError, false);
          return true;
        },
      );
    });
  });
});
