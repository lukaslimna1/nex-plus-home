/**
 * NEX+ · Runtime Concurrency & Recovery Gate — PostgreSQL Integration Tests
 * Suíte de Prova Técnica e Concorrência Real — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3D)
 *
 * Cobertura de Validação Obrigatória:
 * D1. One delivery / two workers (exatamente um processa, outro fica idle, zero duplicate settlement)
 * D2. Duplicate delivery / two workers (ambos buscam, mas só um adquire claim; outro recebe held)
 * D3. Dual heartbeat real (avanço de renewed_at/lease_until no NEX e heartbeat_on no pg-boss)
 * D4. Canonical lease lost (reacquire por outro worker gera stale renew -> signal abort -> non-complete)
 * D5. Technical attempt lost (retryCount avança -> touch affected=0 -> signal abort -> canonical released)
 * D6. Touch operational error (falha operacional no touch -> signal abort -> erros preservados)
 * D7. Crash / restart real (Worker A abandona conexões sem cleanup; supervisor recupera N->N+1; Worker B assume com F+1)
 * D8. Old worker stale após recovery (operações antigas do Worker A resultam stale/affected=0 sem tocar B)
 * D9. Expiration independente de heartbeat (started_on > 900s expira mesmo com heartbeat recente, e vice-versa)
 * D10. Clean runtime restart (restart sequencial com migrate: false sem alteração de schema)
 * D11. Schema drift fail-closed (coluna inesperada bloqueia start com SCHEMA_DRIFT_DETECTED sem autorreparação)
 * D12. Timer cleanup & no-overlap (nenhum timer residual observável após término de processNext)
 * D13. Zero lifecycle mutation (operações do runtime não alteram JobState nem criam eventos ou Attempts)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PgBoss } from 'pg-boss';

import {
  createPgBossRuntime,
  PG_BOSS_DEFAULT_WAKEUP_QUEUE,
  PG_BOSS_WAKEUP_EXPIRE_SECONDS,
  PG_BOSS_WAKEUP_HEARTBEAT_SECONDS,
  type IPgBossRuntime,
} from '../index';
import { createJobAndWakeup } from '../coordinator';
import {
  JobWorkerBridge,
  WorkerBridgeError,
  WorkerBridgeAuthorityLostError,
} from '../index';
import { PostgresJobStore } from '../../persistence/postgres';
import { PostgresJobClaimStore } from '../../claims/postgres';
import { JobClaimStaleError } from '../../claims/errors';
import type { CreateJobParams } from '../../contracts';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

const T0 = '2026-09-29T10:00:00.000Z';

if (process.env.NEX_REQUIRE_JOB_RUNTIME_RECOVERY_DB === '1' && !databaseUrl) {
  throw new Error(
    'NEX_REQUIRE_JOB_RUNTIME_RECOVERY_DB=1 is set but DATABASE_URL is missing. Aborting test suite to prevent accidental green skip.',
  );
}

describe('Runtime Concurrency & Recovery Gate — PostgreSQL Integration (0.86C-3D)', { skip: !databaseUrl }, () => {
  let poolRoot: pg.Pool;
  let jobStore: PostgresJobStore;
  let claimStore: PostgresJobClaimStore;
  let runtimeRoot: IPgBossRuntime;
  let rawBossSupervisor: PgBoss;

  before(async () => {
    poolRoot = new Pool({ connectionString: databaseUrl, max: 10 });
    jobStore = new PostgresJobStore(poolRoot);
    claimStore = new PostgresJobClaimStore(poolRoot);

    runtimeRoot = createPgBossRuntime({ connectionString: databaseUrl! });
    await runtimeRoot.start();
    await runtimeRoot.createQueue(PG_BOSS_DEFAULT_WAKEUP_QUEUE);

    // Instância raw de PgBoss usada estritamente em teste para supervisionar filas sob demanda
    rawBossSupervisor = new PgBoss({
      connectionString: databaseUrl!,
      schema: 'pgboss',
      migrate: false,
      useListenNotify: false,
    });
    await rawBossSupervisor.start();
  });

  after(async () => {
    try {
      await rawBossSupervisor?.stop({ graceful: false, close: true });
    } catch {
      // Ignora erro em cleanup
    }
    try {
      await runtimeRoot?.stop({ graceful: false });
    } catch {
      // Ignora erro em cleanup
    }
    await poolRoot?.end();
  });

  beforeEach(async () => {
    await poolRoot.query('DELETE FROM pgboss.job');
    await poolRoot.query('DELETE FROM nex_job_claims');
    await poolRoot.query('UPDATE pgboss.queue SET monitor_claim_on = NULL, monitor_on = NULL');
  });

  // ==========================================================================
  // D1. UMA DELIVERY / DOIS WORKERS INDEPENDENTES
  // ==========================================================================
  it('D1: uma delivery disputada por dois workers independentes resulta em exatamente um processed e um idle', async () => {
    const jobId = 'job_d1_single_delivery_two_workers';
    await createJobAndWakeup(jobStore, runtimeRoot, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    const poolA = new Pool({ connectionString: databaseUrl, max: 2 });
    const poolB = new Pool({ connectionString: databaseUrl, max: 2 });

    const runtimeA = createPgBossRuntime({ connectionString: databaseUrl! });
    const runtimeB = createPgBossRuntime({ connectionString: databaseUrl! });
    await runtimeA.start();
    await runtimeB.start();

    const claimStoreA = new PostgresJobClaimStore(poolA);
    const claimStoreB = new PostgresJobClaimStore(poolB);
    const jobStoreA = new PostgresJobStore(poolA);
    const jobStoreB = new PostgresJobStore(poolB);

    const bridgeA = new JobWorkerBridge(runtimeA, jobStoreA, claimStoreA, {
      workerId: 'worker_d1_a',
      leaseDurationMs: 30000,
      heartbeatIntervalMs: 10000,
    });
    const bridgeB = new JobWorkerBridge(runtimeB, jobStoreB, claimStoreB, {
      workerId: 'worker_d1_b',
      leaseDurationMs: 30000,
      heartbeatIntervalMs: 10000,
    });

    let callbackCountA = 0;
    let callbackCountB = 0;

    const [resA, resB] = await Promise.all([
      bridgeA.processNext(async () => {
        callbackCountA++;
      }),
      bridgeB.processNext(async () => {
        callbackCountB++;
      }),
    ]);

    const processedCount = (resA.outcome === 'processed' ? 1 : 0) + (resB.outcome === 'processed' ? 1 : 0);
    const idleCount = (resA.outcome === 'idle' ? 1 : 0) + (resB.outcome === 'idle' ? 1 : 0);

    assert.equal(processedCount, 1, 'exatamente um worker deve ter processado a delivery');
    assert.equal(idleCount, 1, 'o outro worker deve ter retornado idle');
    assert.equal(callbackCountA + callbackCountB, 1, 'exatamente um callback deve ter executado');

    // Confirma que no pg-boss a mensagem foi liquidada uma única vez
    const bossRes = await poolRoot.query('SELECT state FROM pgboss.job');
    assert.equal(bossRes.rows.length, 1);
    assert.equal(bossRes.rows[0].state, 'completed');

    await runtimeA.stop();
    await runtimeB.stop();
    await poolA.end();
    await poolB.end();
  });

  // ==========================================================================
  // D2. DUPLICATE DELIVERY / DOIS WORKERS INDEPENDENTES
  // ==========================================================================
  it('D2: wake-up duplicado disputado simultaneamente resulta em um processed e um held sem duplicate callback', async () => {
    const jobId = 'job_d2_duplicate_delivery';
    await createJobAndWakeup(jobStore, runtimeRoot, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });
    // Envia segunda mensagem para o mesmo Job
    await runtimeRoot.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, { jobId });

    const poolA = new Pool({ connectionString: databaseUrl, max: 2 });
    const poolB = new Pool({ connectionString: databaseUrl, max: 2 });
    const runtimeA = createPgBossRuntime({ connectionString: databaseUrl! });
    const runtimeB = createPgBossRuntime({ connectionString: databaseUrl! });
    await runtimeA.start();
    await runtimeB.start();

    const bridgeA = new JobWorkerBridge(runtimeA, new PostgresJobStore(poolA), new PostgresJobClaimStore(poolA), {
      workerId: 'worker_d2_a',
      leaseDurationMs: 30000,
      heartbeatIntervalMs: 10000,
    });
    const bridgeB = new JobWorkerBridge(runtimeB, new PostgresJobStore(poolB), new PostgresJobClaimStore(poolB), {
      workerId: 'worker_d2_b',
      leaseDurationMs: 30000,
      heartbeatIntervalMs: 10000,
    });

    let barrierRelease: () => void = () => {};
    const barrierPromise = new Promise<void>((resolve) => {
      barrierRelease = resolve;
    });

    let callbacksStarted = 0;
    let heldCount = 0;

    // Dispara Worker A e B concorrentemente
    const promiseA = bridgeA.processNext(async () => {
      callbacksStarted++;
      await barrierPromise;
    });

    const promiseB = bridgeB.processNext(async () => {
      callbacksStarted++;
      await barrierPromise;
    });

    // Aguarda o primeiro worker entrar no callback e o outro processar
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(callbacksStarted, 1, 'apenas um worker deve ter entrado no callback');

    // Libera a barreira para o worker que está segurando o claim concluir
    barrierRelease();

    const [resA, resB] = await Promise.all([promiseA, promiseB]);

    const processedWorker = resA.outcome === 'processed' ? resA : resB;
    const heldWorker = resA.outcome === 'held' ? resA : resB;

    assert.equal(processedWorker.outcome, 'processed');
    assert.equal(heldWorker.outcome, 'held');
    assert.equal(callbacksStarted, 1, 'total de callbacks executados deve ser exatamente 1');

    await runtimeA.stop();
    await runtimeB.stop();
    await poolA.end();
    await poolB.end();
  });

  // ==========================================================================
  // D3. DUAL HEARTBEAT REAL (CANÔNICO E TÉCNICO)
  // ==========================================================================
  it('D3: dual heartbeat renova renewed_at/lease_until no NEX e heartbeat_on no pg-boss enquanto callback está ativo', async () => {
    const jobId = 'job_d3_dual_heartbeat';
    await createJobAndWakeup(jobStore, runtimeRoot, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    // Bridge com lease curta de 3s e heartbeat a cada 800ms
    const bridge = new JobWorkerBridge(runtimeRoot, jobStore, claimStore, {
      workerId: 'worker_d3',
      leaseDurationMs: 3000,
      heartbeatIntervalMs: 800,
    });

    let observedRenewedAdvance = false;
    let observedBossHeartbeatAdvance = false;

    const res = await bridge.processNext(async (ctx) => {
      // Captura estado imediatamente após aquisição do claim
      const initialClaim = (await poolRoot.query('SELECT acquired_at, renewed_at, lease_until, fencing_token FROM nex_job_claims WHERE job_id = $1', [jobId])).rows[0];
      const initialBoss = (await poolRoot.query("SELECT started_on, heartbeat_on, retry_count FROM pgboss.job WHERE data->>'jobId' = $1", [jobId])).rows[0];

      // Bloqueia callback por 2000ms (tempo superior a 2 ticks de heartbeat)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const midClaim = (await poolRoot.query('SELECT acquired_at, renewed_at, lease_until, fencing_token FROM nex_job_claims WHERE job_id = $1', [jobId])).rows[0];
      const midBoss = (await poolRoot.query("SELECT started_on, heartbeat_on, retry_count FROM pgboss.job WHERE data->>'jobId' = $1", [jobId])).rows[0];

      if (new Date(midClaim.renewed_at).getTime() > new Date(initialClaim.renewed_at).getTime()) {
        observedRenewedAdvance = true;
      }
      if (new Date(midClaim.lease_until).getTime() > new Date(initialClaim.lease_until).getTime()) {
        observedRenewedAdvance = true;
      }
      if (new Date(midBoss.heartbeat_on).getTime() > new Date(initialBoss.heartbeat_on).getTime()) {
        observedBossHeartbeatAdvance = true;
      }

      assert.equal(midClaim.fencing_token, initialClaim.fencing_token, 'fencing_token deve permanecer estável');
      assert.equal(midBoss.retry_count, initialBoss.retry_count, 'retry_count deve permanecer estável');
    });

    assert.equal(res.outcome, 'processed');
    assert.equal(observedRenewedAdvance, true, 'renewed_at e lease_until devem ter avançado no PostgreSQL');
    assert.equal(observedBossHeartbeatAdvance, true, 'heartbeat_on deve ter avançado no pgboss.job');

    // Confirma que claim foi liberado após o término do callback
    const finalClaim = await claimStore.getJobClaim(jobId);
    assert.equal(finalClaim?.state, 'released');
  });

  // ==========================================================================
  // D4. CANONICAL LEASE LOST (REACQUIRE POR OUTRO WORKER)
  // ==========================================================================
  it('D4: perda de claim canônico durante callback provoca abort signal, impede completeWakeup e não altera claim novo', async () => {
    const jobId = 'job_d4_canonical_lease_lost';
    await createJobAndWakeup(jobStore, runtimeRoot, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    const bridgeA = new JobWorkerBridge(runtimeRoot, jobStore, claimStore, {
      workerId: 'worker_d4_a',
      leaseDurationMs: 10000,
      heartbeatIntervalMs: 500,
    });

    let signalAbortedObserved = false;

    await assert.rejects(
      async () => {
        await bridgeA.processNext(async (ctx) => {
          // 1. Força expiração do claim A via fixture controlada no PostgreSQL
          await poolRoot.query("UPDATE nex_job_claims SET lease_until = NOW() - INTERVAL '10 seconds' WHERE job_id = $1", [jobId]);

          // 2. Worker B re-adquire o claim expirado com fencing token 2
          const poolB = new Pool({ connectionString: databaseUrl, max: 2 });
          const claimStoreB = new PostgresJobClaimStore(poolB);
          const reacquired = await claimStoreB.acquireClaim({
            jobId,
            workerId: 'worker_d4_b',
            leaseDurationMs: 30000,
          });
          assert.equal(reacquired.acquired, true);
          assert.equal(reacquired.claim?.fencingToken, '2');
          await poolB.end();

          // 3. Aguarda o próximo tick do heartbeat de A (que falhará com JobClaimStaleError)
          await new Promise((resolve) => setTimeout(resolve, 1100));
          signalAbortedObserved = ctx.signal.aborted;
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof WorkerBridgeError);
        assert.ok(err.primaryError instanceof WorkerBridgeAuthorityLostError);
        assert.equal(err.primaryError.reason, 'canonical_claim_stale');
        return true;
      },
    );

    assert.equal(signalAbortedObserved, true, 'AbortSignal deve ter sido abortado');

    // Confirma que o claim do Worker B com fence 2 permaneceu intacto e ativo
    const finalClaim = await claimStore.getJobClaim(jobId);
    assert.equal(finalClaim?.workerId, 'worker_d4_b');
    assert.equal(finalClaim?.fencingToken, '2');
    assert.equal(finalClaim?.state, 'active');

    // Confirma que Worker A não completou o wakeup no pg-boss
    const bossJob = await poolRoot.query("SELECT state, retry_count FROM pgboss.job WHERE data->>'jobId' = $1", [jobId]);
    assert.notEqual(bossJob.rows[0].state, 'completed', 'Worker A não deve ter completado o wakeup');
  });

  // ==========================================================================
  // D5. TECHNICAL ATTEMPT LOST (TOUCH AFFECTED=0)
  // ==========================================================================
  it('D5: tentativa técnica stale no pg-boss provoca abort signal e libera claim canônico se ainda válido', async () => {
    const jobId = 'job_d5_technical_stale';
    await createJobAndWakeup(jobStore, runtimeRoot, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    const bridgeA = new JobWorkerBridge(runtimeRoot, jobStore, claimStore, {
      workerId: 'worker_d5_a',
      leaseDurationMs: 30000,
      heartbeatIntervalMs: 500,
    });

    let signalAbortedObserved = false;

    await assert.rejects(
      async () => {
        await bridgeA.processNext(async (ctx) => {
          // Força avanço de retry_count no pg-boss para simular que a attempt ficou stale
          await poolRoot.query("UPDATE pgboss.job SET retry_count = 5 WHERE data->>'jobId' = $1", [jobId]);

          // Aguarda o próximo tick do heartbeat (touchWakeup com retryCount 0 retornará affected=0)
          await new Promise((resolve) => setTimeout(resolve, 1100));
          signalAbortedObserved = ctx.signal.aborted;
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof WorkerBridgeError);
        assert.ok(err.primaryError instanceof WorkerBridgeAuthorityLostError);
        assert.equal(err.primaryError.reason, 'technical_attempt_stale');
        return true;
      },
    );

    assert.equal(signalAbortedObserved, true);

    // Confirma que a tentativa mais nova (retry_count = 5) permaneceu intacta no pg-boss
    const bossRes = await poolRoot.query("SELECT retry_count, state FROM pgboss.job WHERE data->>'jobId' = $1", [jobId]);
    assert.equal(bossRes.rows[0].retry_count, 5);

    // Como o claim de A ainda era válido e seu, deve ter sido liberado com segurança
    const claimRes = await claimStore.getJobClaim(jobId);
    assert.equal(claimRes?.state, 'released');
  });

  // ==========================================================================
  // D6. TOUCH OPERATIONAL ERROR
  // ==========================================================================
  it('D6: erro operacional no touchWakeup aborta signal, para heartbeat e preserva erros', async () => {
    const jobId = 'job_d6_touch_error';
    await createJobAndWakeup(jobStore, runtimeRoot, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    // Intercepta touchWakeup no runtimeRoot para simular falha operacional
    const originalTouch = runtimeRoot.touchWakeup.bind(runtimeRoot);
    const simulatedError = new Error('Database socket reset on touchWakeup');
    let touchInterceptionActive = false;

    runtimeRoot.touchWakeup = async (queue, target) => {
      if (touchInterceptionActive) {
        throw simulatedError;
      }
      return originalTouch(queue, target);
    };

    const bridge = new JobWorkerBridge(runtimeRoot, jobStore, claimStore, {
      workerId: 'worker_d6',
      leaseDurationMs: 30000,
      heartbeatIntervalMs: 500,
    });

    let signalAborted = false;

    try {
      await assert.rejects(
        async () => {
          await bridge.processNext(async (ctx) => {
            touchInterceptionActive = true;
            await new Promise((resolve) => setTimeout(resolve, 1100));
            signalAborted = ctx.signal.aborted;
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof WorkerBridgeError);
          assert.ok(err.primaryError instanceof WorkerBridgeAuthorityLostError);
          assert.equal(err.primaryError.reason, 'technical_heartbeat_failure');
          assert.equal(err.primaryError.cause, simulatedError);
          return true;
        },
      );
    } finally {
      runtimeRoot.touchWakeup = originalTouch;
    }

    assert.equal(signalAborted, true);

    // Cleanup: claim canônico deve ter sido liberado com segurança
    const claimAfter = await claimStore.getJobClaim(jobId);
    assert.equal(claimAfter?.state, 'released');

    // Fail fenced: pg-boss deve ter registrado a falha da delivery (estado movido para retry/failed, nunca active nem completed)
    const bossAfter = await poolRoot.query("SELECT state FROM pgboss.job WHERE data->>'jobId' = $1", [jobId]);
    assert.ok(bossAfter.rows[0].state === 'retry' || bossAfter.rows[0].state === 'failed');
    assert.notEqual(bossAfter.rows[0].state, 'completed');
    assert.notEqual(bossAfter.rows[0].state, 'active');
  });

  // ==========================================================================
  // D7. CRASH / RESTART REAL
  // ==========================================================================
  it('D7: Worker A sofre crash; supervisor recupera attempt N->N+1; Worker B novo assume com fence F+1', async () => {
    const jobId = 'job_d7_crash_restart';
    await createJobAndWakeup(jobStore, runtimeRoot, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    // 1. Worker A (Pool e Runtime dedicados) busca mensagem e simula crash imediato
    const poolA = new Pool({ connectionString: databaseUrl, max: 2 });
    const runtimeA = createPgBossRuntime({ connectionString: databaseUrl! });
    await runtimeA.start();

    const claimStoreA = new PostgresJobClaimStore(poolA);
    const bridgeA = new JobWorkerBridge(runtimeA, new PostgresJobStore(poolA), claimStoreA, {
      workerId: 'worker_d7_a',
      leaseDurationMs: 30000,
      heartbeatIntervalMs: 10000,
    });

    let workerAClaimFence = '';
    let workerARetryCount = -1;

    // Simula crash de Worker A fechando runtime/pool sem liquidar nada
    try {
      await bridgeA.processNext(async (ctx) => {
        workerAClaimFence = ctx.claim.fencingToken;
        const msgRes = await poolRoot.query("SELECT retry_count FROM pgboss.job WHERE data->>'jobId' = $1", [jobId]);
        workerARetryCount = msgRes.rows[0].retry_count;
        // CRASH simulado: encerra o runtime e fecha conexões para impedir qualquer release/settlement
        await runtimeA.stop();
        await poolA.end();
        throw new Error('WORKER_PROCESS_CRASH_SIMULATION');
      });
    } catch {
      // Ignora erro decorrente da simulação de crash abrupto
    } finally {
      if (runtimeA.isStarted) {
        await runtimeA.stop().catch(() => {});
      }
      await poolA.end().catch(() => {});
    }

    assert.equal(workerAClaimFence, '1');
    assert.equal(workerARetryCount, 0);

    // Confirma que no banco Worker A abandonou sem release nem settlement
    const claimBeforeSupervise = await claimStore.getJobClaim(jobId);
    assert.equal(claimBeforeSupervise?.state, 'active');
    assert.equal(claimBeforeSupervise?.fencingToken, '1');

    const bossBeforeSupervise = await poolRoot.query("SELECT retry_count, state FROM pgboss.job WHERE data->>'jobId' = $1", [jobId]);
    assert.equal(bossBeforeSupervise.rows[0].state, 'active');
    assert.equal(bossBeforeSupervise.rows[0].retry_count, 0);

    // 2. Expirar autoridades via fixture temporal no banco descartável:
    // Envelhece claim canônico
    await poolRoot.query("UPDATE nex_job_claims SET lease_until = NOW() - INTERVAL '15 seconds' WHERE job_id = $1", [jobId]);
    // Envelhece heartbeat no pg-boss além dos 60 segundos
    await poolRoot.query(
      "UPDATE pgboss.job SET heartbeat_on = NOW() - INTERVAL '70 seconds', started_on = NOW() - INTERVAL '70 seconds' WHERE data->>'jobId' = $1",
      [jobId],
    );

    // 3. Dispara supervisor no pg-boss
    await rawBossSupervisor.supervise(PG_BOSS_DEFAULT_WAKEUP_QUEUE);

    // Confirma que a mensagem foi movida para retry pelo pg-boss
    const bossAfterSupervise = await poolRoot.query("SELECT retry_count, state FROM pgboss.job WHERE data->>'jobId' = $1", [jobId]);
    assert.equal(bossAfterSupervise.rows[0].state, 'retry', 'estado deve ser retry');

    // 4. Worker B totalmente novo (novo Pool, novo Runtime com migrate:false, novo ClaimStore, novo WorkerBridge)
    const poolB = new Pool({ connectionString: databaseUrl, max: 2 });
    const runtimeB = createPgBossRuntime({ connectionString: databaseUrl! });
    await runtimeB.start();

    const claimStoreB = new PostgresJobClaimStore(poolB);
    const bridgeB = new JobWorkerBridge(runtimeB, new PostgresJobStore(poolB), claimStoreB, {
      workerId: 'worker_d7_b',
      leaseDurationMs: 30000,
      heartbeatIntervalMs: 10000,
    });

    let workerBCallbackExecuted = false;
    let workerBClaimFence = '';

    try {
      const resB = await bridgeB.processNext(async (ctx) => {
        workerBCallbackExecuted = true;
        workerBClaimFence = ctx.claim.fencingToken;
      });

      assert.equal(resB.outcome, 'processed');
      assert.equal(workerBCallbackExecuted, true);
      assert.equal(workerBClaimFence, '2', 'Worker B deve assumir com fencingToken F+1 = 2');
      assert.equal(resB.retryCount, 1, 'Worker B deve receber delivery com retryCount N+1 = 1');
    } finally {
      await runtimeB.stop();
      await poolB.end();
    }
  });

  // ==========================================================================
  // D8. OLD WORKER DEPOIS DO RECOVERY
  // ==========================================================================
  it('D8: operações stale da geração antiga de Worker A falham deterministicamente sem tocar Worker B', async () => {
    const jobId = 'job_d8_old_worker_stale';
    await createJobAndWakeup(jobStore, runtimeRoot, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    const msgRes = await poolRoot.query("SELECT id FROM pgboss.job WHERE data->>'jobId' = $1", [jobId]);
    const messageId = msgRes.rows[0].id;

    // Simula que Worker B já assumiu e avançou retryCount para 1 e fencingToken para 2
    await poolRoot.query(
      "INSERT INTO nex_job_claims (job_id, worker_id, fencing_token, acquired_at, renewed_at, lease_until) VALUES ($1, 'worker_b', 2, NOW(), NOW(), NOW() + INTERVAL '30 seconds')",
      [jobId],
    );
    await poolRoot.query("UPDATE pgboss.job SET retry_count = 1, state = 'active' WHERE id = $1", [messageId]);

    // Tentativas do Worker A antigo (fence 1, retryCount 0):
    await assert.rejects(
      () =>
        claimStore.renewClaim({
          jobId,
          workerId: 'worker_a_old',
          fencingToken: '1',
          leaseDurationMs: 30000,
        }),
      (err: any) => err instanceof JobClaimStaleError,
    );

    await assert.rejects(
      () =>
        claimStore.releaseClaim({
          jobId,
          workerId: 'worker_a_old',
          fencingToken: '1',
        }),
      (err: any) => err instanceof JobClaimStaleError,
    );

    const staleTouch = await runtimeRoot.touchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      id: messageId,
      retryCount: 0,
    });
    assert.equal(staleTouch.settled, false);
    assert.equal(staleTouch.affected, 0);

    const staleComplete = await runtimeRoot.completeWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      id: messageId,
      retryCount: 0,
    });
    assert.equal(staleComplete.settled, false);
    assert.equal(staleComplete.affected, 0);

    const staleFail = await runtimeRoot.failWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      id: messageId,
      retryCount: 0,
    });
    assert.equal(staleFail.settled, false);
    assert.equal(staleFail.affected, 0);

    // Confirma que o estado de B permaneceu 100% intocado
    const claimB = await claimStore.getJobClaim(jobId);
    assert.equal(claimB?.workerId, 'worker_b');
    assert.equal(claimB?.fencingToken, '2');

    const bossB = await poolRoot.query('SELECT retry_count, state FROM pgboss.job WHERE id = $1', [messageId]);
    assert.equal(bossB.rows[0].retry_count, 1);
    assert.equal(bossB.rows[0].state, 'active');
  });

  // ==========================================================================
  // D9. EXPIRATION INDEPENDENTE DE HEARTBEAT
  // ==========================================================================
  it('D9: expiração técnica do pg-boss (started_on > 900s) e heartbeat perdido atuam independentemente', async () => {
    // Caso 1: heartbeat recente, mas started_on além de 900 segundos (950s)
    const jobId1 = 'job_d9_expire_started_on';
    const sendRes1 = await runtimeRoot.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, { jobId: jobId1 });

    const fetched1 = await runtimeRoot.fetchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, 1);
    assert.equal(fetched1.length, 1);

    await poolRoot.query(
      "UPDATE pgboss.job SET started_on = NOW() - INTERVAL '950 seconds', heartbeat_on = NOW() WHERE id = $1",
      [sendRes1.messageId],
    );

    await rawBossSupervisor.supervise(PG_BOSS_DEFAULT_WAKEUP_QUEUE);

    const bossExpired1 = await poolRoot.query('SELECT state, retry_count FROM pgboss.job WHERE id = $1', [sendRes1.messageId]);
    assert.equal(bossExpired1.rows[0].state, 'retry', 'job expirado por started_on deve ser movido para retry mesmo com heartbeat recente');

    // Conclui o job 1 para não concorrer no fetch do caso 2
    await poolRoot.query("UPDATE pgboss.job SET state = 'completed' WHERE id = $1", [sendRes1.messageId]);

    // Caso 2: started_on recente (10s), mas heartbeat_on envelhecido (> 60s, ex: 75s)
    const jobId2 = 'job_d9_expire_heartbeat_lost';
    const sendRes2 = await runtimeRoot.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, { jobId: jobId2 });

    const fetched2 = await runtimeRoot.fetchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, 1);
    assert.equal(fetched2.length, 1);
    assert.equal(fetched2[0].id, sendRes2.messageId);

    await poolRoot.query(
      "UPDATE pgboss.job SET started_on = NOW() - INTERVAL '10 seconds', heartbeat_on = NOW() - INTERVAL '75 seconds' WHERE id = $1",
      [sendRes2.messageId],
    );

    // Envelhece monitor_claim_on e monitor_on para permitir que o supervisor execute uma nova varredura completa
    await poolRoot.query(
      "UPDATE pgboss.queue SET monitor_claim_on = NOW() - INTERVAL '120 seconds', monitor_on = NOW() - INTERVAL '120 seconds' WHERE name = $1",
      [PG_BOSS_DEFAULT_WAKEUP_QUEUE],
    );

    await rawBossSupervisor.supervise(PG_BOSS_DEFAULT_WAKEUP_QUEUE);

    const bossExpired2 = await poolRoot.query('SELECT state, retry_count FROM pgboss.job WHERE id = $1', [sendRes2.messageId]);
    assert.equal(bossExpired2.rows[0].state, 'retry', 'job com heartbeat perdido deve ser movido para retry independentemente de started_on');
  });

  // ==========================================================================
  // D10. CLEAN RUNTIME RESTART
  // ==========================================================================
  it('D10: restarts limpos sucessivos com migrate: false funcionam sem alteração de schema', async () => {
    const runtime1 = createPgBossRuntime({ connectionString: databaseUrl! });
    assert.equal(runtime1.isStarted, false);
    await runtime1.start();
    assert.equal(runtime1.isStarted, true);
    await runtime1.stop();
    assert.equal(runtime1.isStarted, false);

    const runtime2 = createPgBossRuntime({ connectionString: databaseUrl! });
    assert.equal(runtime2.isStarted, false);
    await runtime2.start();
    assert.equal(runtime2.isStarted, true);
    await runtime2.stop();
    assert.equal(runtime2.isStarted, false);

    // Confirma versão do schema
    const versionRes = await poolRoot.query('SELECT version FROM pgboss.version');
    assert.equal(versionRes.rows[0].version, 43);
  });

  // ==========================================================================
  // D11. SCHEMA DRIFT FAIL-CLOSED
  // ==========================================================================
  it('D11: schema drift na tabela pg-boss causa fail-closed no start() sem autorreparação', async () => {
    // Injeta coluna de drift benigna e reversível
    await poolRoot.query('ALTER TABLE pgboss.job ADD COLUMN temp_drift_test_col text');

    const driftRuntime = createPgBossRuntime({ connectionString: databaseUrl! });

    try {
      await assert.rejects(
        () => driftRuntime.start(),
        (err: any) => {
          assert.equal(err.code, 'SCHEMA_DRIFT_DETECTED');
          return true;
        },
      );

      // Prova que o runtime NÃO removeu a coluna nem auto-reparou o schema
      const checkCol = await poolRoot.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'pgboss' AND table_name = 'job' AND column_name = 'temp_drift_test_col'",
      );
      assert.equal(checkCol.rows.length, 1, 'a coluna de drift deve continuar presente (nenhuma auto-reparação)');
    } finally {
      // Reversão limpa da fixture
      await poolRoot.query('ALTER TABLE pgboss.job DROP COLUMN temp_drift_test_col');
    }

    // Após restauração da fixture, novo runtime inicia com sucesso
    const restoredRuntime = createPgBossRuntime({ connectionString: databaseUrl! });
    await restoredRuntime.start();
    assert.equal(restoredRuntime.isStarted, true);
    await restoredRuntime.stop();
  });

  // ==========================================================================
  // D12. TIMER CLEANUP & NO-OVERLAP REAL
  // ==========================================================================
  it('D12: encerramento do processNext garante cancelamento de timers sem chamadas residuais', async () => {
    const jobId = 'job_d12_timer_cleanup';
    await createJobAndWakeup(jobStore, runtimeRoot, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    let ticksObserved = 0;
    const bridge = new JobWorkerBridge(runtimeRoot, jobStore, claimStore, {
      workerId: 'worker_d12',
      leaseDurationMs: 30000,
      heartbeatIntervalMs: 200,
    });

    const res = await bridge.processNext(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    assert.equal(res.outcome, 'processed');

    // Captura estado no pg-boss logo após o término
    const bossAfter = (await poolRoot.query("SELECT heartbeat_on FROM pgboss.job WHERE data->>'jobId' = $1", [jobId])).rows[0];
    const heartbeatAtEnd = new Date(bossAfter.heartbeat_on).getTime();

    // Aguarda mais 600ms (tempo suficiente para 3 ticks adicionais se timers tivessem vazado)
    await new Promise((resolve) => setTimeout(resolve, 600));

    const bossLater = (await poolRoot.query("SELECT heartbeat_on FROM pgboss.job WHERE data->>'jobId' = $1", [jobId])).rows[0];
    const heartbeatLater = new Date(bossLater.heartbeat_on).getTime();

    assert.equal(heartbeatLater, heartbeatAtEnd, 'nenhum heartbeat adicional pode ocorrer após término');
  });

  // ==========================================================================
  // D13. ZERO LIFECYCLE MUTATION
  // ==========================================================================
  it('D13: toda a atividade do runtime 3D preserva integralmente o JobState e não cria eventos nem Attempts', async () => {
    const jobId = 'job_d13_zero_lifecycle_mutation';
    await createJobAndWakeup(jobStore, runtimeRoot, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    const headBefore = (await poolRoot.query('SELECT status, revision, created_at, updated_at FROM nex_job_heads WHERE job_id = $1', [jobId])).rows[0];
    const eventsBefore = (await poolRoot.query('SELECT * FROM nex_job_events WHERE job_id = $1', [jobId])).rows;

    const bridge = new JobWorkerBridge(runtimeRoot, jobStore, claimStore, {
      workerId: 'worker_d13',
      leaseDurationMs: 10000,
      heartbeatIntervalMs: 1000,
    });

    const res = await bridge.processNext(async (ctx) => {
      assert.equal(ctx.job.jobId, jobId);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });

    assert.equal(res.outcome, 'processed');

    const headAfter = (await poolRoot.query('SELECT status, revision, created_at, updated_at FROM nex_job_heads WHERE job_id = $1', [jobId])).rows[0];
    const eventsAfter = (await poolRoot.query('SELECT * FROM nex_job_events WHERE job_id = $1', [jobId])).rows;

    assert.equal(headAfter.status, headBefore.status);
    assert.equal(headAfter.revision, headBefore.revision);
    assert.equal(headAfter.created_at.toISOString(), headBefore.created_at.toISOString());
    assert.equal(headAfter.updated_at.toISOString(), headBefore.updated_at.toISOString());
    assert.equal(eventsAfter.length, eventsBefore.length);
  });
});
