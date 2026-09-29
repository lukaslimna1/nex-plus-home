/**
 * NEX+ · Job Runtime Boundary & Recovery Unit Tests (0.86C-3D)
 *
 * Cobertura de testes unitários para o checkpoint 0.86C-3D:
 * - Policy técnica explícita de wake-up em sendWakeup e sendWakeupInTransaction
 * - touchWakeup attempt-fenced ({ id, retryCount }) com validação de affected
 * - Validação fail-closed de heartbeatIntervalMs (relação com lease e pg-boss)
 * - WorkerHeartbeatController (ordem renew -> touch, serialização, no-overlap, stop in-flight, signal abort)
 * - Authority loss e preservação de erros compostos no WorkerBridge
 * - AUD-3A-PM2-01: Preservação de erros falsey em composeRuntimeErrorWithCleanup (false, 0, '', undefined)
 * - Startup readiness do PgBossRuntime (schemaVersion === 43, detectSchemaDrift().ok === true)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PgBossRuntime,
  PgBossRuntimeError,
  composeRuntimeErrorWithCleanup,
  PG_BOSS_WAKEUP_RETRY_LIMIT,
  PG_BOSS_WAKEUP_RETRY_DELAY_SECONDS,
  PG_BOSS_WAKEUP_RETRY_BACKOFF,
  PG_BOSS_WAKEUP_EXPIRE_SECONDS,
  PG_BOSS_WAKEUP_HEARTBEAT_SECONDS,
  PG_BOSS_DEFAULT_WAKEUP_QUEUE,
  IPgBossRuntime,
  JobWorkerBridge,
  assertHeartbeatIntervalMs,
  WorkerHeartbeatController,
  WorkerBridgeAuthorityLostError,
  WorkerBridgeError,
  WorkerBridgeInvariantsError,
} from '../index';
import { DeliveryAttemptError } from '../invariants';
import { JobClaimStaleError } from '../../claims/errors';
import {
  AcquireJobClaimResult,
  JobClaimSnapshot,
  JobClaimStore,
  ReleaseJobClaimParams,
} from '../../claims/contracts';
import { DurableJobStore } from '../../persistence/contracts';
import type { JobState } from '../../contracts';

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
  workerId = 'worker_test_01',
  fencingToken = '1',
): JobClaimSnapshot {
  return {
    jobId,
    workerId,
    fencingToken,
    leaseUntil: new Date(Date.now() + 30000).toISOString(),
    acquiredAt: new Date().toISOString(),
    renewedAt: new Date().toISOString(),
    releasedAt: undefined,
    state: 'active',
  };
}

describe('Runtime Concurrency & Recovery Gate Unit Tests (0.86C-3D)', () => {
  // ==========================================================================
  // 1. WAKE-UP POLICY (sendWakeup & sendWakeupInTransaction)
  // ==========================================================================
  describe('Wake-up Technical Policy Options', () => {
    it('sendWakeup passa explicitamente as opções de policy congeladas para boss.send', async () => {
      let sentQueue = '';
      let sentPayload: any = null;
      let sentOptions: any = null;

      const mockBoss = {
        async start() {
          return this;
        },
        async stop() {},
        async schemaVersion() {
          return 43;
        },
        async detectSchemaDrift() {
          return { ok: true, drifts: [] };
        },
        async send(queue: string, payload: any, options: any) {
          sentQueue = queue;
          sentPayload = payload;
          sentOptions = options;
          return 'msg_send_01';
        },
      };

      const runtime = new PgBossRuntime({
        connectionString: 'postgres://user:pass@localhost:5432/db',
        bossFactory: () => mockBoss as any,
      });

      await runtime.start();

      const result = await runtime.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
        jobId: 'job_send_policy_01',
      });

      assert.equal(result.messageId, 'msg_send_01');
      assert.equal(sentQueue, PG_BOSS_DEFAULT_WAKEUP_QUEUE);
      assert.deepEqual(sentPayload, { jobId: 'job_send_policy_01' });
      assert.deepEqual(sentOptions, {
        retryLimit: PG_BOSS_WAKEUP_RETRY_LIMIT,
        retryDelay: PG_BOSS_WAKEUP_RETRY_DELAY_SECONDS,
        retryBackoff: PG_BOSS_WAKEUP_RETRY_BACKOFF,
        expireInSeconds: PG_BOSS_WAKEUP_EXPIRE_SECONDS,
        heartbeatSeconds: PG_BOSS_WAKEUP_HEARTBEAT_SECONDS,
      });

      await runtime.stop();
    });

    it('sendWakeupInTransaction passa mesma policy e anexa o db fornecido', async () => {
      let sentQueue = '';
      let sentPayload: any = null;
      let sentOptions: any = null;

      const mockBoss = {
        async start() {
          return this;
        },
        async stop() {},
        async schemaVersion() {
          return 43;
        },
        async detectSchemaDrift() {
          return { ok: true, drifts: [] };
        },
        async send(queue: string, payload: any, options: any) {
          sentQueue = queue;
          sentPayload = payload;
          sentOptions = options;
          return 'msg_tx_send_01';
        },
      };

      const runtime = new PgBossRuntime({
        connectionString: 'postgres://user:pass@localhost:5432/db',
        bossFactory: () => mockBoss as any,
      });

      await runtime.start();

      const mockTxDb = {
        executeSql: async () => ({ rows: [], rowCount: 0 }),
      };

      const result = await runtime.sendWakeupInTransaction(
        PG_BOSS_DEFAULT_WAKEUP_QUEUE,
        { jobId: 'job_tx_send_01' },
        mockTxDb,
      );

      assert.equal(result.messageId, 'msg_tx_send_01');
      assert.equal(sentQueue, PG_BOSS_DEFAULT_WAKEUP_QUEUE);
      assert.deepEqual(sentPayload, { jobId: 'job_tx_send_01' });
      assert.deepEqual(sentOptions, {
        db: mockTxDb,
        retryLimit: PG_BOSS_WAKEUP_RETRY_LIMIT,
        retryDelay: PG_BOSS_WAKEUP_RETRY_DELAY_SECONDS,
        retryBackoff: PG_BOSS_WAKEUP_RETRY_BACKOFF,
        expireInSeconds: PG_BOSS_WAKEUP_EXPIRE_SECONDS,
        heartbeatSeconds: PG_BOSS_WAKEUP_HEARTBEAT_SECONDS,
      });

      await runtime.stop();
    });
  });

  // ==========================================================================
  // 2. touchWakeup & ATTEMPT FENCING
  // ==========================================================================
  describe('PgBossRuntime · touchWakeup', () => {
    it('impede touchWakeup se runtime não foi iniciado', async () => {
      const runtime = new PgBossRuntime({
        connectionString: 'postgres://user:pass@localhost:5432/db',
      });

      await assert.rejects(
        () => runtime.touchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, { id: 'deliv_1', retryCount: 0 }),
        { name: 'PgBossRuntimeError', code: 'RUNTIME_NOT_STARTED' },
      );
    });

    it('valida target de attempt fail-closed em touchWakeup', async () => {
      const mockBoss = {
        async start() {
          return this;
        },
        async stop() {},
        async schemaVersion() {
          return 43;
        },
        async detectSchemaDrift() {
          return { ok: true, drifts: [] };
        },
      };

      const runtime = new PgBossRuntime({
        connectionString: 'postgres://user:pass@localhost:5432/db',
        bossFactory: () => mockBoss as any,
      });
      await runtime.start();

      await assert.rejects(
        () => runtime.touchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, { id: '', retryCount: 0 }),
        { name: 'DeliveryAttemptError', code: 'INVALID_DELIVERY_ATTEMPT_REF' },
      );

      await assert.rejects(
        () => runtime.touchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, { id: 'valid_id', retryCount: -1 }),
        { name: 'DeliveryAttemptError', code: 'INVALID_RETRY_COUNT' },
      );

      await runtime.stop();
    });

    it('touchWakeup passa { id, retryCount } para boss.touch e retorna settled: true em affected=1', async () => {
      let touchCalledWith: any = null;
      const mockBoss = {
        async start() {
          return this;
        },
        async stop() {},
        async schemaVersion() {
          return 43;
        },
        async detectSchemaDrift() {
          return { ok: true, drifts: [] };
        },
        async touch(queue: string, target: any) {
          touchCalledWith = { queue, target };
          return { affected: 1 };
        },
      };

      const runtime = new PgBossRuntime({
        connectionString: 'postgres://user:pass@localhost:5432/db',
        bossFactory: () => mockBoss as any,
      });
      await runtime.start();

      const res = await runtime.touchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
        id: 'deliv_touch_1',
        retryCount: 0,
      });

      assert.deepEqual(touchCalledWith, {
        queue: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
        target: { id: 'deliv_touch_1', retryCount: 0 },
      });
      assert.deepEqual(res, { settled: true, affected: 1 });

      await runtime.stop();
    });

    it('touchWakeup retorna settled: false quando affected=0 (attempt stale)', async () => {
      const mockBoss = {
        async start() {
          return this;
        },
        async stop() {},
        async schemaVersion() {
          return 43;
        },
        async detectSchemaDrift() {
          return { ok: true, drifts: [] };
        },
        async touch() {
          return { affected: 0 };
        },
      };

      const runtime = new PgBossRuntime({
        connectionString: 'postgres://user:pass@localhost:5432/db',
        bossFactory: () => mockBoss as any,
      });
      await runtime.start();

      const res = await runtime.touchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
        id: 'deliv_touch_stale',
        retryCount: 1,
      });

      assert.deepEqual(res, { settled: false, affected: 0 });

      await runtime.stop();
    });

    it('touchWakeup rejeita affected malformado fail-closed com SETTLEMENT_FAILURE', async () => {
      const mockBoss = {
        async start() {
          return this;
        },
        async stop() {},
        async schemaVersion() {
          return 43;
        },
        async detectSchemaDrift() {
          return { ok: true, drifts: [] };
        },
        async touch() {
          return { affected: 2 }; // affected > 1 é inválido para single touch
        },
      };

      const runtime = new PgBossRuntime({
        connectionString: 'postgres://user:pass@localhost:5432/db',
        bossFactory: () => mockBoss as any,
      });
      await runtime.start();

      await assert.rejects(
        () =>
          runtime.touchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
            id: 'deliv_touch_bad',
            retryCount: 0,
          }),
        { name: 'PgBossRuntimeError', code: 'SETTLEMENT_FAILURE' },
      );

      await runtime.stop();
    });
  });

  // ==========================================================================
  // 3. assertHeartbeatIntervalMs VALIDATIONS
  // ==========================================================================
  describe('assertHeartbeatIntervalMs Validations', () => {
    it('aceita valores válidos (ex: interval 10000 com lease 30000)', () => {
      assert.doesNotThrow(() => assertHeartbeatIntervalMs(10000, 30000));
      assert.doesNotThrow(() => assertHeartbeatIntervalMs(15000, 30000));
      assert.doesNotThrow(() => assertHeartbeatIntervalMs(1000, 10000));
    });

    it('rejeita valores ausentes, não numéricos, <= 0 ou não inteiros', () => {
      assert.throws(() => assertHeartbeatIntervalMs(undefined as any, 30000), {
        name: 'WorkerBridgeInvariantsError',
      });
      assert.throws(() => assertHeartbeatIntervalMs(0, 30000), {
        name: 'WorkerBridgeInvariantsError',
      });
      assert.throws(() => assertHeartbeatIntervalMs(-100, 30000), {
        name: 'WorkerBridgeInvariantsError',
      });
      assert.throws(() => assertHeartbeatIntervalMs(1000.5, 30000), {
        name: 'WorkerBridgeInvariantsError',
      });
      assert.throws(() => assertHeartbeatIntervalMs(NaN, 30000), {
        name: 'WorkerBridgeInvariantsError',
      });
    });

    it('rejeita intervalo maior que floor(leaseDurationMs / 2)', () => {
      // leaseDurationMs = 30000 -> max = 15000
      assert.throws(() => assertHeartbeatIntervalMs(15001, 30000), {
        name: 'WorkerBridgeInvariantsError',
      });

      // leaseDurationMs = 15000 -> max = 7500
      assert.throws(() => assertHeartbeatIntervalMs(7501, 15000), {
        name: 'WorkerBridgeInvariantsError',
      });
    });

    it('rejeita intervalo maior que 30000 ms (limite do heartbeat provider pg-boss de 60s)', () => {
      // Mesmo se leaseDurationMs for 100000, heartbeatIntervalMs não pode exceder 30000
      assert.throws(() => assertHeartbeatIntervalMs(30001, 100000), {
        name: 'WorkerBridgeInvariantsError',
      });
    });
  });

  // ==========================================================================
  // 4. WorkerHeartbeatController (Keepalive Invariants)
  // ==========================================================================
  describe('WorkerHeartbeatController Invariants', () => {
    it('executa renewClaim ESTRITAMENTE ANTES de touchWakeup em cada tick', async () => {
      const callOrder: string[] = [];

      const controller = new WorkerHeartbeatController({
        heartbeatIntervalMs: 20,
        leaseDurationMs: 30000,
        jobId: 'job_order_test',
        workerId: 'worker_01',
        fencingToken: '1',
        queueName: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
        deliveryId: 'deliv_order_1',
        retryCount: 0,
        claimStore: {
          async renewClaim() {
            callOrder.push('renewClaim');
            return {} as any;
          },
        } as any,
        runtime: {
          async touchWakeup() {
            callOrder.push('touchWakeup');
            return { settled: true, affected: 1 };
          },
        } as any,
      });

      controller.start();

      // Aguarda 1-2 ticks
      await new Promise((resolve) => setTimeout(resolve, 55));
      await controller.stop();

      assert.ok(callOrder.length >= 2, 'esperava pelo menos um ciclo completo');
      // Cada par consecutivo deve ser [renewClaim, touchWakeup]
      for (let i = 0; i < callOrder.length - 1; i += 2) {
        assert.equal(callOrder[i], 'renewClaim');
        if (i + 1 < callOrder.length) {
          assert.equal(callOrder[i + 1], 'touchWakeup');
        }
      }
    });

    it('não permite ticks concorrentes / sobrepostos (no-overlapping ticks)', async () => {
      let inFlightCount = 0;
      let maxConcurrent = 0;

      const controller = new WorkerHeartbeatController({
        heartbeatIntervalMs: 10,
        leaseDurationMs: 30000,
        jobId: 'job_no_overlap',
        workerId: 'worker_01',
        fencingToken: '1',
        queueName: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
        deliveryId: 'deliv_overlap_1',
        retryCount: 0,
        claimStore: {
          async renewClaim() {
            inFlightCount++;
            maxConcurrent = Math.max(maxConcurrent, inFlightCount);
            // Simula delay de rede maior que o intervalo de heartbeat
            await new Promise((resolve) => setTimeout(resolve, 30));
            inFlightCount--;
            return {} as any;
          },
        } as any,
        runtime: {
          async touchWakeup() {
            return { settled: true, affected: 1 };
          },
        } as any,
      });

      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await controller.stop();

      assert.equal(maxConcurrent, 1, 'em nenhum momento deve haver mais de 1 tick in-flight');
    });

    it('F-3D-HB-START-01: start() é estritamente idempotente e chamadas duplicadas mantêm serialidade (maxConcurrent === 1)', async () => {
      let inFlightCount = 0;
      let maxConcurrent = 0;
      let renewCount = 0;
      let touchCount = 0;

      const controller = new WorkerHeartbeatController({
        heartbeatIntervalMs: 10,
        leaseDurationMs: 30000,
        jobId: 'job_idempotent_start',
        workerId: 'worker_01',
        fencingToken: '1',
        queueName: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
        deliveryId: 'deliv_idem_1',
        retryCount: 0,
        claimStore: {
          async renewClaim() {
            inFlightCount++;
            renewCount++;
            maxConcurrent = Math.max(maxConcurrent, inFlightCount);
            // Simula delay de renew ~25ms
            await new Promise((resolve) => setTimeout(resolve, 25));
            inFlightCount--;
            return {} as any;
          },
        } as any,
        runtime: {
          async touchWakeup() {
            touchCount++;
            return { settled: true, affected: 1 };
          },
        } as any,
      });

      assert.equal(controller.isStarted, false);

      // 1ª chamada
      controller.start();
      assert.equal(controller.isStarted, true);

      // 2ª chamada imediata antes do tick disparar/terminar (deve ser no-op)
      controller.start();

      // 3ª chamada após 5ms (ainda antes do primeiro tick terminar)
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.start();

      // Aguarda 70ms para múltiplos ticks ocorrerem
      await new Promise((resolve) => setTimeout(resolve, 70));

      // Concorrência deve ser estritamente 1
      assert.equal(maxConcurrent, 1, 'em nenhum momento deve haver mais de 1 tick in-flight (maxConcurrent === 1)');
      assert.ok(renewCount >= 1, 'deve ter executado pelo menos 1 renew');
      assert.ok(touchCount >= 1, 'deve ter executado pelo menos 1 touch');

      // Stop aguarda tick atual
      const stopPromise = controller.stop();
      assert.equal(controller.isStarted, false);
      assert.equal(controller.isStopped, true);

      await stopPromise;

      const renewCountAtStop = renewCount;
      const touchCountAtStop = touchCount;

      // Aguarda mais tempo após stop e confirma nenhum renew/touch adicional
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.equal(renewCount, renewCountAtStop, 'nenhum renew adicional após stop()');
      assert.equal(touchCount, touchCountAtStop, 'nenhum touch adicional após stop()');

      // Chamar start() após stop() é NO-OP
      controller.start();
      assert.equal(controller.isStarted, false);
      assert.equal(controller.isStopped, true);
    });

    it('stop() aguarda tick in-flight finalizar e cancela qualquer timer posterior', async () => {
      let tickRunning = false;
      let tickCompleted = false;

      const controller = new WorkerHeartbeatController({
        heartbeatIntervalMs: 15,
        leaseDurationMs: 30000,
        jobId: 'job_stop_wait',
        workerId: 'worker_01',
        fencingToken: '1',
        queueName: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
        deliveryId: 'deliv_stop_1',
        retryCount: 0,
        claimStore: {
          async renewClaim() {
            tickRunning = true;
            await new Promise((resolve) => setTimeout(resolve, 40));
            tickCompleted = true;
            tickRunning = false;
            return {} as any;
          },
        } as any,
        runtime: {
          async touchWakeup() {
            return { settled: true, affected: 1 };
          },
        } as any,
      });

      controller.start();
      // Aguarda tick iniciar
      await new Promise((resolve) => setTimeout(resolve, 20));

      const stopPromise = controller.stop();
      // Logo ao chamar stop, o tick ainda estava rodando
      assert.equal(tickRunning, true);

      await stopPromise;
      // Ao resolver o stop, o tick deve ter completado
      assert.equal(tickCompleted, true);
      assert.equal(tickRunning, false);
      assert.equal(controller.isStopped, true);
    });

    it('quando renewClaim falha com JobClaimStaleError: aborta signal com canonical_claim_stale e para keepalive', async () => {
      let touchCalled = false;

      const controller = new WorkerHeartbeatController({
        heartbeatIntervalMs: 15,
        leaseDurationMs: 30000,
        jobId: 'job_stale_renew',
        workerId: 'worker_01',
        fencingToken: '1',
        queueName: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
        deliveryId: 'deliv_stale_1',
        retryCount: 0,
        claimStore: {
          async renewClaim() {
            throw new JobClaimStaleError('job_stale_renew', 'worker_01', '1');
          },
        } as any,
        runtime: {
          async touchWakeup() {
            touchCalled = true;
            return { settled: true, affected: 1 };
          },
        } as any,
      });

      const signal = controller.signal;
      let abortReason: any = null;
      signal.addEventListener('abort', () => {
        abortReason = signal.reason;
      });

      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 35));
      await controller.stop();

      assert.equal(signal.aborted, true);
      assert.ok(abortReason instanceof WorkerBridgeAuthorityLostError);
      assert.equal(abortReason.reason, 'canonical_claim_stale');
      assert.equal(touchCalled, false, 'se o renew canônico falhou stale, touch técnico NUNCA deve ser chamado');
      assert.equal(controller.isAuthorityLost, true);
      assert.equal(controller.isStopped, true);
    });

    it('quando touchWakeup retorna affected=0: aborta signal com technical_attempt_stale e para keepalive', async () => {
      const controller = new WorkerHeartbeatController({
        heartbeatIntervalMs: 15,
        leaseDurationMs: 30000,
        jobId: 'job_tech_stale',
        workerId: 'worker_01',
        fencingToken: '1',
        queueName: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
        deliveryId: 'deliv_tech_stale',
        retryCount: 0,
        claimStore: {
          async renewClaim() {
            return {} as any;
          },
        } as any,
        runtime: {
          async touchWakeup() {
            return { settled: false, affected: 0 };
          },
        } as any,
      });

      const signal = controller.signal;
      let abortReason: any = null;
      signal.addEventListener('abort', () => {
        abortReason = signal.reason;
      });

      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 35));
      await controller.stop();

      assert.equal(signal.aborted, true);
      assert.ok(abortReason instanceof WorkerBridgeAuthorityLostError);
      assert.equal(abortReason.reason, 'technical_attempt_stale');
      assert.equal(controller.isAuthorityLost, true);
      assert.equal(controller.isStopped, true);
    });

    it('quando touchWakeup lança erro operacional: aborta signal com technical_heartbeat_failure', async () => {
      const touchErr = new Error('Connection reset by peer on touch');
      const controller = new WorkerHeartbeatController({
        heartbeatIntervalMs: 15,
        leaseDurationMs: 30000,
        jobId: 'job_tech_err',
        workerId: 'worker_01',
        fencingToken: '1',
        queueName: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
        deliveryId: 'deliv_tech_err',
        retryCount: 0,
        claimStore: {
          async renewClaim() {
            return {} as any;
          },
        } as any,
        runtime: {
          async touchWakeup() {
            throw touchErr;
          },
        } as any,
      });

      const signal = controller.signal;
      let abortReason: any = null;
      signal.addEventListener('abort', () => {
        abortReason = signal.reason;
      });

      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 35));
      await controller.stop();

      assert.equal(signal.aborted, true);
      assert.ok(abortReason instanceof WorkerBridgeAuthorityLostError);
      assert.equal(abortReason.reason, 'technical_heartbeat_failure');
      assert.equal(abortReason.cause, touchErr);
      assert.equal(controller.isAuthorityLost, true);
      assert.equal(controller.isStopped, true);
    });
  });

  // ==========================================================================
  // 5. WorkerBridge Authority Loss Integration & Non-Complete
  // ==========================================================================
  describe('JobWorkerBridge Authority Loss Handling', () => {
    it('se autoridade for perdida durante callback: NÃO conclui como sucesso e lança erro de perda de autoridade', async () => {
      const sampleJob = createSampleJobState();
      const sampleClaim = createSampleClaimSnapshot();

      let completeCalled = false;
      const mockRuntime = {
        async fetchWakeup() {
          return [
            {
              id: 'deliv_auth_loss_1',
              name: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
              data: { jobId: 'job_01J8NEXPLUS001' },
              retryCount: 0,
            },
          ];
        },
        async completeWakeup() {
          completeCalled = true;
          return { settled: true, affected: 1 };
        },
        async touchWakeup() {
          return { settled: true, affected: 1 };
        },
        async failWakeup() {
          return { settled: true, affected: 1 };
        },
      } as unknown as IPgBossRuntime;

      const mockJobStore = {
        async rehydrateJob() {
          return sampleJob;
        },
      } as unknown as DurableJobStore;

      let renewCount = 0;
      const mockClaimStore = {
        async acquireClaim() {
          return { acquired: true, claim: sampleClaim };
        },
        async renewClaim() {
          renewCount++;
          // No primeiro tick de renew, simula que a claim ficou stale
          throw new JobClaimStaleError('job_01J8NEXPLUS001', 'worker_alpha', '1');
        },
        async releaseClaim() {
          return {} as any;
        },
      } as unknown as JobClaimStore;

      const bridge = new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
        workerId: 'worker_alpha',
        leaseDurationMs: 30000,
        heartbeatIntervalMs: 15,
      });

      let callbackObservedSignalAborted = false;

      await assert.rejects(
        async () => {
          await bridge.processNext(async (ctx) => {
            // Callback aguarda o primeiro tick disparar o renew stale
            await new Promise((resolve) => setTimeout(resolve, 45));
            callbackObservedSignalAborted = ctx.signal.aborted;
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof WorkerBridgeError);
          assert.ok(err.message.includes('Authority lost'));
          assert.ok(err.primaryError instanceof WorkerBridgeAuthorityLostError);
          assert.equal(err.primaryError.reason, 'canonical_claim_stale');
          return true;
        },
      );

      assert.equal(callbackObservedSignalAborted, true, 'callback deve ter observado o sinal abortado');
      assert.equal(completeCalled, false, 'completeWakeup JAMAIS pode ser chamado se autoridade foi perdida');
    });

    it('zero timers residuais após processNext resolver normalmente', async () => {
      const sampleJob = createSampleJobState();
      const sampleClaim = createSampleClaimSnapshot();

      let touchCount = 0;
      const mockRuntime = {
        async fetchWakeup() {
          return [
            {
              id: 'deliv_timer_clean_1',
              name: PG_BOSS_DEFAULT_WAKEUP_QUEUE,
              data: { jobId: 'job_01J8NEXPLUS001' },
              retryCount: 0,
            },
          ];
        },
        async completeWakeup() {
          return { settled: true, affected: 1 };
        },
        async touchWakeup() {
          touchCount++;
          return { settled: true, affected: 1 };
        },
      } as unknown as IPgBossRuntime;

      const mockJobStore = {
        async rehydrateJob() {
          return sampleJob;
        },
      } as unknown as DurableJobStore;

      let renewCount = 0;
      const mockClaimStore = {
        async acquireClaim() {
          return { acquired: true, claim: sampleClaim };
        },
        async renewClaim() {
          renewCount++;
          return {} as any;
        },
        async releaseClaim() {
          return {} as any;
        },
      } as unknown as JobClaimStore;

      const bridge = new JobWorkerBridge(mockRuntime, mockJobStore, mockClaimStore, {
        workerId: 'worker_alpha',
        leaseDurationMs: 30000,
        heartbeatIntervalMs: 15,
      });

      const res = await bridge.processNext(async () => {
        // Callback rápido
        await new Promise((resolve) => setTimeout(resolve, 35));
      });

      assert.equal(res.outcome, 'processed');

      const renewCountAtEnd = renewCount;
      const touchCountAtEnd = touchCount;

      // Espera 60ms adicionais
      await new Promise((resolve) => setTimeout(resolve, 60));

      assert.equal(renewCount, renewCountAtEnd, 'nenhum renew adicional pode ter ocorrido após término');
      assert.equal(touchCount, touchCountAtEnd, 'nenhum touch adicional pode ter ocorrido após término');
    });
  });

  // ==========================================================================
  // 6. AUD-3A-PM2-01: Falsey Cleanup Errors Preservation
  // ==========================================================================
  describe('AUD-3A-PM2-01 · Explicit Presence of Cleanup Failures', () => {
    it('preserva cleanup lançado como false', () => {
      const primary = new Error('primary error');
      const composed = composeRuntimeErrorWithCleanup(primary, {
        hasError: true,
        error: false,
      });

      assert.ok(composed instanceof PgBossRuntimeError);
      assert.ok(composed.cause instanceof AggregateError);
      assert.equal(composed.cause.errors.length, 2);
      assert.equal(composed.cause.errors[0], primary);
      assert.equal(composed.cause.errors[1], false);
      assert.equal(composed.cleanupError, false);
    });

    it('preserva cleanup lançado como 0', () => {
      const primary = new Error('primary error');
      const composed = composeRuntimeErrorWithCleanup(primary, {
        hasError: true,
        error: 0,
      });

      assert.ok(composed instanceof PgBossRuntimeError);
      assert.ok(composed.cause instanceof AggregateError);
      assert.equal(composed.cause.errors[1], 0);
      assert.equal(composed.cleanupError, 0);
    });

    it('preserva cleanup lançado como string vazia', () => {
      const primary = new Error('primary error');
      const composed = composeRuntimeErrorWithCleanup(primary, {
        hasError: true,
        error: '',
      });

      assert.ok(composed instanceof PgBossRuntimeError);
      assert.ok(composed.cause instanceof AggregateError);
      assert.equal(composed.cause.errors[1], '');
      assert.equal(composed.cleanupError, '');
    });

    it('preserva cleanup lançado como undefined explicitamente', () => {
      const primary = new Error('primary error');
      const composed = composeRuntimeErrorWithCleanup(primary, {
        hasError: true,
        error: undefined,
      });

      assert.ok(composed instanceof PgBossRuntimeError);
      assert.ok(composed.cause instanceof AggregateError);
      assert.equal(composed.cause.errors[1], undefined);
      assert.equal(composed.cleanupError, undefined);
    });

    it('retorna apenas o erro primário quando hasError é false', () => {
      const primary = new Error('primary error');
      const composed = composeRuntimeErrorWithCleanup(primary, {
        hasError: false,
      });

      assert.ok(composed instanceof PgBossRuntimeError);
      assert.equal(composed.cause, primary);
      assert.equal(composed.cleanupError, undefined);
    });
  });

  // ==========================================================================
  // 7. STARTUP READINESS & SCHEMA DRIFT
  // ==========================================================================
  describe('PgBossRuntime.start() Readiness & Drift Detection', () => {
    it('inicia normalmente quando schemaVersion === 43 e drift.ok === true', async () => {
      const mockBoss = {
        async start() {
          return this;
        },
        async stop() {},
        async schemaVersion() {
          return 43;
        },
        async detectSchemaDrift() {
          return { ok: true, drifts: [] };
        },
      };

      const runtime = new PgBossRuntime({
        connectionString: 'postgres://user:pass@localhost:5432/db',
        bossFactory: () => mockBoss as any,
      });

      assert.equal(runtime.isStarted, false);
      await runtime.start();
      assert.equal(runtime.isStarted, true);

      await runtime.stop();
      assert.equal(runtime.isStarted, false);
    });

    it('falha com SCHEMA_VERSION_MISMATCH e executa cleanup quando schemaVersion !== 43', async () => {
      let stopCalled = false;
      const mockBoss = {
        async start() {
          return this;
        },
        async stop() {
          stopCalled = true;
        },
        async schemaVersion() {
          return 42; // versão incorreta
        },
        async detectSchemaDrift() {
          return { ok: true, drifts: [] };
        },
      };

      const runtime = new PgBossRuntime({
        connectionString: 'postgres://user:pass@localhost:5432/db',
        bossFactory: () => mockBoss as any,
      });

      await assert.rejects(
        () => runtime.start(),
        (err: any) => {
          assert.equal(err.code, 'SCHEMA_VERSION_MISMATCH');
          assert.ok(err.message.includes('42'));
          return true;
        },
      );

      assert.equal(runtime.isStarted, false);
      assert.equal(stopCalled, true, 'deve executar stop best-effort no candidateBoss');
    });

    it('falha com SCHEMA_DRIFT_DETECTED e executa cleanup quando detectSchemaDrift().ok === false', async () => {
      let stopCalled = false;
      const mockBoss = {
        async start() {
          return this;
        },
        async stop() {
          stopCalled = true;
        },
        async schemaVersion() {
          return 43;
        },
        async detectSchemaDrift() {
          return {
            ok: false,
            drifts: ['Table pgboss.job has unexpected column extra_col'],
          };
        },
      };

      const runtime = new PgBossRuntime({
        connectionString: 'postgres://user:pass@localhost:5432/db',
        bossFactory: () => mockBoss as any,
      });

      await assert.rejects(
        () => runtime.start(),
        (err: any) => {
          assert.equal(err.code, 'SCHEMA_DRIFT_DETECTED');
          assert.ok(err.message.includes('Schema drift detected'));
          return true;
        },
      );

      assert.equal(runtime.isStarted, false);
      assert.equal(stopCalled, true, 'deve executar stop best-effort no candidateBoss');
    });

    it('preserva erro primário do start e erro de cleanup quando ambos falham', async () => {
      const startError = new Error('Database connection refused');
      const stopError = new Error('Stop failed due to closed socket');

      const mockBoss = {
        async start() {
          throw startError;
        },
        async stop() {
          throw stopError;
        },
      };

      const runtime = new PgBossRuntime({
        connectionString: 'postgres://user:pass@localhost:5432/db',
        bossFactory: () => mockBoss as any,
      });

      await assert.rejects(
        () => runtime.start(),
        (err: any) => {
          assert.ok(err instanceof PgBossRuntimeError);
          assert.equal(err.code, 'START_FAILURE');
          assert.equal(err.cleanupError, stopError);
          assert.ok(err.cause instanceof AggregateError);
          assert.equal(err.cause.errors[0], startError);
          assert.equal(err.cause.errors[1], stopError);
          return true;
        },
      );

      assert.equal(runtime.isStarted, false);
    });
  });
});
