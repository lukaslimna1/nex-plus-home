/**
 * NEX+ · Safe Wake-Up & Worker Bridge — PostgreSQL Integration Tests
 * Suíte de Prova Técnica e Concorrência Atômica — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3C)
 *
 * Cobertura de Validação Obrigatória:
 * C1. atomic create+wake success
 * C2. queue absent → create rollback
 * C3. explicit rollback after enqueue → both sides absent
 * C4. atomic event+wake success
 * C5. event enqueue failure → revision/history rollback
 * C6. bridge happy path
 * C7. orphan
 * C8. concurrent duplicate held
 * C9. sequential duplicate repeat safe
 * C10. callback failure → technical retry
 * C11. stale canonical claim before release
 * C12. technical attempt stale fence
 * C13. Job lifecycle unchanged pelo bridge
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PgBoss } from 'pg-boss';

import {
  createPgBossRuntime,
  PG_BOSS_DEFAULT_WAKEUP_QUEUE,
  type IPgBossRuntime,
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
} from '../worker-bridge';
import { PostgresJobStore } from '../../persistence/postgres';
import { PostgresJobClaimStore } from '../../claims/postgres';
import type { CreateJobParams, JobEvent, JobStartedEvent } from '../../contracts';

const { Pool, Client } = pg;
const databaseUrl = process.env.DATABASE_URL;

const T0 = '2026-09-28T22:00:00.000Z';
const T1 = '2026-09-28T22:01:00.000Z';

if (process.env.NEX_REQUIRE_JOB_WAKEUP_BRIDGE_DB === '1' && !databaseUrl) {
  throw new Error(
    'NEX_REQUIRE_JOB_WAKEUP_BRIDGE_DB=1 is set but DATABASE_URL is missing. Aborting test suite to prevent accidental green skip.'
  );
}

describe('Safe Wake-Up & Worker Bridge — PostgreSQL Integration (0.86C-3C)', { skip: !databaseUrl }, () => {
  let pool: pg.Pool;
  let jobStore: PostgresJobStore;
  let claimStore: PostgresJobClaimStore;
  let runtime: IPgBossRuntime;

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    jobStore = new PostgresJobStore(pool);
    claimStore = new PostgresJobClaimStore(pool);

    runtime = createPgBossRuntime({ connectionString: databaseUrl! });
    await runtime.start();

    // Assegura que a fila canônica de wake-up está provisionada
    await runtime.createQueue(PG_BOSS_DEFAULT_WAKEUP_QUEUE);
  });

  after(async () => {
    try {
      await runtime?.stop();
    } catch {
      // Ignora erro em cleanup
    }
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM pgboss.job');
  });

  // ==========================================================================
  // C1. ATOMIC CREATE + WAKE SUCCESS
  // ==========================================================================
  it('C1: createJobAndWakeup persiste Job revision 1 e wake-up no pg-boss atomicamente', async () => {
    const jobId = 'job_c1_atomic_create_001';
    const params: CreateJobParams = {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    };

    const result = await createJobAndWakeup(jobStore, runtime, params);

    assert.equal(result.job.jobId, jobId);
    assert.equal(result.job.revision, 1);
    assert.equal(result.job.status, 'queued');
    assert.ok(result.messageId, 'messageId deve ser string válida e não-nula');

    // 1. Prova head em nex_job_heads
    const headRes = await pool.query('SELECT status, revision FROM nex_job_heads WHERE job_id = $1', [jobId]);
    assert.equal(headRes.rows.length, 1);
    assert.equal(headRes.rows[0].status, 'queued');
    assert.equal(headRes.rows[0].revision, 1);

    // 2. Prova evento em nex_job_events
    const eventRes = await pool.query('SELECT record_kind, revision FROM nex_job_events WHERE job_id = $1', [jobId]);
    assert.equal(eventRes.rows.length, 1);
    assert.equal(eventRes.rows[0].record_kind, 'created');
    assert.equal(eventRes.rows[0].revision, 1);

    // 3. Prova mensagem no pgboss.job com payload { jobId }
    const bossRes = await pool.query(
      `SELECT id, name, data, state FROM pgboss.job WHERE id = $1`,
      [result.messageId],
    );
    assert.equal(bossRes.rows.length, 1);
    assert.equal(bossRes.rows[0].name, PG_BOSS_DEFAULT_WAKEUP_QUEUE);
    assert.deepEqual(bossRes.rows[0].data, { jobId });
    assert.equal(bossRes.rows[0].state, 'created');
  });

  // ==========================================================================
  // C2. QUEUE ABSENT → CREATE ROLLBACK
  // ==========================================================================
  it('C2: falha no enqueue (queue ausente) desfaz criação do Job integralmente (rollback)', async () => {
    const jobId = 'job_c2_queue_absent_rollback';
    const params: CreateJobParams = {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    };

    const nonExistentQueue = 'non_existent_queue_should_fail';

    await assert.rejects(
      async () => {
        await createJobAndWakeup(jobStore, runtime, params, { queueName: nonExistentQueue });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );

    // Prova que nada persistiu no JobStore nem no pg-boss
    const headRes = await pool.query('SELECT 1 FROM nex_job_heads WHERE job_id = $1', [jobId]);
    assert.equal(headRes.rows.length, 0);

    const eventRes = await pool.query('SELECT 1 FROM nex_job_events WHERE job_id = $1', [jobId]);
    assert.equal(eventRes.rows.length, 0);

    const bossRes = await pool.query(`SELECT 1 FROM pgboss.job WHERE data->>'jobId' = $1`, [jobId]);
    assert.equal(bossRes.rows.length, 0);
  });

  // ==========================================================================
  // C3. EXPLICIT ROLLBACK AFTER ENQUEUE → BOTH SIDES ABSENT
  // ==========================================================================
  it('C3: erro deliberado após enqueue no mesmo client desfaz ambos os lados (head, event e pg-boss job)', async () => {
    const jobId = 'job_c3_deliberate_rollback';
    const params: CreateJobParams = {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    };

    let generatedMessageId: string | null = null;

    await assert.rejects(
      async () => {
        await jobStore.withWriteTransaction(async (scope) => {
          // 1. Cria o Job
          const job = await scope.createJob(params);
          assert.equal(job.jobId, jobId);

          // 2. Envia mensagem para a fila na mesma transação usando a façade transactionDb
          const sendRes = await runtime.sendWakeupInTransaction(
            PG_BOSS_DEFAULT_WAKEUP_QUEUE,
            { jobId },
            scope.transactionDb,
          );
          generatedMessageId = sendRes.messageId;
          assert.ok(generatedMessageId);

          // 3. Erro deliberado injetado antes do commit
          throw new Error('deliberate_rollback_after_enqueue_test');
        });
      },
      /deliberate_rollback_after_enqueue_test/,
    );

    // Prova ausência absoluta em todos os lados
    const headRes = await pool.query('SELECT 1 FROM nex_job_heads WHERE job_id = $1', [jobId]);
    assert.equal(headRes.rows.length, 0);

    const eventRes = await pool.query('SELECT 1 FROM nex_job_events WHERE job_id = $1', [jobId]);
    assert.equal(eventRes.rows.length, 0);

    assert.ok(generatedMessageId);
    const bossRes = await pool.query('SELECT 1 FROM pgboss.job WHERE id = $1', [generatedMessageId]);
    assert.equal(bossRes.rows.length, 0);
  });

  // ==========================================================================
  // C4. ATOMIC EVENT + WAKE SUCCESS
  // ==========================================================================
  it('C4: applyJobEventAndWakeup avança para revision N+1 e gera wake-up atômico', async () => {
    const jobId = 'job_c4_atomic_event_wake';
    await jobStore.createJob({
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    const event: JobStartedEvent = {
      type: 'JobStarted',
      jobId,
      attemptId: 'att_c4_001',
      startedAt: T1,
    };

    const result = await applyJobEventAndWakeup(jobStore, runtime, event, 1);

    assert.equal(result.job.jobId, jobId);
    assert.equal(result.job.revision, 2);
    assert.equal(result.job.status, 'running');
    assert.ok(result.messageId);

    // Prova head atualizado
    const headRes = await pool.query('SELECT status, revision FROM nex_job_heads WHERE job_id = $1', [jobId]);
    assert.equal(headRes.rows[0].status, 'running');
    assert.equal(headRes.rows[0].revision, 2);

    // Prova histórico com 2 eventos
    const eventRes = await pool.query('SELECT revision, record_kind FROM nex_job_events WHERE job_id = $1 ORDER BY revision ASC', [jobId]);
    assert.equal(eventRes.rows.length, 2);
    assert.equal(eventRes.rows[1].revision, 2);
    assert.equal(eventRes.rows[1].record_kind, 'transition');

    // Prova wake-up no pg-boss
    const bossRes = await pool.query('SELECT id, data FROM pgboss.job WHERE id = $1', [result.messageId]);
    assert.equal(bossRes.rows.length, 1);
    assert.deepEqual(bossRes.rows[0].data, { jobId });
  });

  // ==========================================================================
  // C5. EVENT ENQUEUE FAILURE → REVISION/HISTORY ROLLBACK
  // ==========================================================================
  it('C5: falha no enqueue em transição não avança revisão e desfaz evento (rollback)', async () => {
    const jobId = 'job_c5_event_enqueue_fail';
    await jobStore.createJob({
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    const event: JobStartedEvent = {
      type: 'JobStarted',
      jobId,
      attemptId: 'att_c5_001',
      startedAt: T1,
    };

    await assert.rejects(
      async () => {
        await applyJobEventAndWakeup(jobStore, runtime, event, 1, {
          queueName: 'non_existent_queue_for_c5',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );

    // Prova que o head permaneceu em revision 1 e queued
    const headRes = await pool.query('SELECT status, revision FROM nex_job_heads WHERE job_id = $1', [jobId]);
    assert.equal(headRes.rows[0].status, 'queued');
    assert.equal(headRes.rows[0].revision, 1);

    // Prova que histórico contém apenas a criação
    const eventRes = await pool.query('SELECT revision FROM nex_job_events WHERE job_id = $1', [jobId]);
    assert.equal(eventRes.rows.length, 1);
    assert.equal(eventRes.rows[0].revision, 1);
  });

  // ==========================================================================
  // C6. BRIDGE HAPPY PATH
  // ==========================================================================
  it('C6: bridge processa delivery única, adquire claim, executa callback, libera claim e liquida delivery', async () => {
    const jobId = 'job_c6_bridge_happy';
    await createJobAndWakeup(jobStore, runtime, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    const bridge = new JobWorkerBridge(runtime, jobStore, claimStore, {
      workerId: 'worker_c6',
      leaseDurationMs: 30000,
    });

    let callbackContext: any = null;
    let callbackCount = 0;

    const result = await bridge.processNext(async (ctx) => {
      callbackCount++;
      callbackContext = ctx;
    });

    assert.equal(result.outcome, 'processed');
    assert.equal(result.jobId, jobId);
    assert.equal(result.fencingToken, '1');
    assert.equal(callbackCount, 1);
    assert.equal(callbackContext.job.jobId, jobId);
    assert.equal(callbackContext.claim.fencingToken, '1');

    // Prova claim liberado no PostgreSQL
    const claimSnapshot = await claimStore.getJobClaim(jobId);
    assert.ok(claimSnapshot);
    assert.equal(claimSnapshot.state, 'released');
    assert.ok(claimSnapshot.releasedAt);
    assert.equal(claimSnapshot.fencingToken, '1');

    // Prova mensagem técnica liquidada no pg-boss (state = 'completed')
    const bossRes = await pool.query('SELECT state FROM pgboss.job WHERE id = $1', [result.deliveryId]);
    assert.equal(bossRes.rows[0].state, 'completed');
  });

  // ==========================================================================
  // C7. ORPHAN WAKE-UP
  // ==========================================================================
  it('C7: wake-up para Job inexistente liquida delivery sem chamar callback nem criar Job', async () => {
    const orphanJobId = 'job_c7_orphan_not_found';
    // Envia wake-up diretamente pelo runtime sem criar Job
    const sendRes = await runtime.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      jobId: orphanJobId,
    });

    const bridge = new JobWorkerBridge(runtime, jobStore, claimStore, {
      workerId: 'worker_c7',
      leaseDurationMs: 30000,
    });

    let callbackCalled = false;
    const result = await bridge.processNext(async () => {
      callbackCalled = true;
    });

    assert.equal(result.outcome, 'orphaned');
    assert.equal(result.jobId, orphanJobId);
    assert.equal(callbackCalled, false);

    // Prova que Job continua não existindo
    const headRes = await pool.query('SELECT 1 FROM nex_job_heads WHERE job_id = $1', [orphanJobId]);
    assert.equal(headRes.rows.length, 0);

    // Prova mensagem concluída no pg-boss
    const bossRes = await pool.query('SELECT state FROM pgboss.job WHERE id = $1', [sendRes.messageId]);
    assert.equal(bossRes.rows[0].state, 'completed');
  });

  // ==========================================================================
  // C8. CONCURRENT DUPLICATE HELD
  // ==========================================================================
  it('C8: delivery concorrente sob claim ativo resulta em held e não duplica execução do callback', async () => {
    const jobId = 'job_c8_concurrent_held';
    await createJobAndWakeup(jobStore, runtime, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    // Envia segunda mensagem para o mesmo Job
    await runtime.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, { jobId });

    const bridgeA = new JobWorkerBridge(runtime, jobStore, claimStore, {
      workerId: 'worker_c8_a',
      leaseDurationMs: 30000,
    });
    const bridgeB = new JobWorkerBridge(runtime, jobStore, claimStore, {
      workerId: 'worker_c8_b',
      leaseDurationMs: 30000,
    });

    let barrierRelease: () => void = () => {};
    const barrierPromise = new Promise<void>((resolve) => {
      barrierRelease = resolve;
    });

    let callbackACalled = 0;
    let callbackBCalled = 0;

    // Worker A inicia e segura o callback na barreira
    const promiseA = bridgeA.processNext(async () => {
      callbackACalled++;
      await barrierPromise;
    });

    // Aguarda claim de A estar ativo no banco
    let claimActive = false;
    for (let i = 0; i < 50; i++) {
      const snap = await claimStore.getJobClaim(jobId);
      if (snap && snap.state === 'active' && snap.workerId === 'worker_c8_a') {
        claimActive = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(claimActive, true, 'Claim de A deve estar ativo no PostgreSQL');

    // Worker B processa a segunda mensagem enquanto A ainda está ativo no callback
    const resultB = await bridgeB.processNext(async () => {
      callbackBCalled++;
    });

    assert.equal(resultB.outcome, 'held');
    assert.equal(callbackBCalled, 0, 'Callback de B NUNCA deve ser executado no held');

    // Libera a barreira para A concluir
    barrierRelease();
    const resultA = await promiseA;

    assert.equal(resultA.outcome, 'processed');
    assert.equal(callbackACalled, 1);
    assert.equal(callbackACalled + callbackBCalled, 1, 'Total de execuções do callback DEVE ser 1');
  });

  // ==========================================================================
  // C9. SEQUENTIAL DUPLICATE REPEAT SAFE
  // ==========================================================================
  it('C9: duplicate sequencial pós-release adquire fence seguinte e repete callback com segurança', async () => {
    const jobId = 'job_c9_sequential_safe';
    await createJobAndWakeup(jobStore, runtime, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    // Envia segundo wake-up
    await runtime.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, { jobId });

    const bridgeA = new JobWorkerBridge(runtime, jobStore, claimStore, {
      workerId: 'worker_c9_a',
      leaseDurationMs: 30000,
    });
    const bridgeB = new JobWorkerBridge(runtime, jobStore, claimStore, {
      workerId: 'worker_c9_b',
      leaseDurationMs: 30000,
    });

    const receivedFences: string[] = [];

    // Processa a primeira mensagem integralmente
    const resA = await bridgeA.processNext(async (ctx) => {
      receivedFences.push(ctx.claim.fencingToken);
    });
    assert.equal(resA.outcome, 'processed');
    assert.equal(resA.fencingToken, '1');

    // Processa a segunda mensagem após o claim anterior ter sido liberado
    const resB = await bridgeB.processNext(async (ctx) => {
      receivedFences.push(ctx.claim.fencingToken);
    });
    assert.equal(resB.outcome, 'processed');
    assert.equal(resB.fencingToken, '2');

    assert.deepEqual(receivedFences, ['1', '2']);

    // Prova que JobState permaneceu inalterado (queued, revision 1)
    const headRes = await pool.query('SELECT status, revision FROM nex_job_heads WHERE job_id = $1', [jobId]);
    assert.equal(headRes.rows[0].status, 'queued');
    assert.equal(headRes.rows[0].revision, 1);
  });

  // ==========================================================================
  // C10. CALLBACK FAILURE → TECHNICAL RETRY
  // ==========================================================================
  it('C10: falha no callback libera claim e agenda retry técnico no pg-boss sem alterar JobState', async () => {
    const jobId = 'job_c10_callback_failure';
    await createJobAndWakeup(jobStore, runtime, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    const bridge = new JobWorkerBridge(runtime, jobStore, claimStore, {
      workerId: 'worker_c10',
      leaseDurationMs: 30000,
    });

    const primaryError = new Error('Explicit callback failure simulation for C10');

    await assert.rejects(
      async () => {
        await bridge.processNext(async () => {
          throw primaryError;
        });
      },
      /Explicit callback failure simulation for C10/,
    );

    // 1. Prova claim liberado
    const claimSnapshotC10 = await claimStore.getJobClaim(jobId);
    assert.ok(claimSnapshotC10);
    assert.equal(claimSnapshotC10.state, 'released');

    // 2. Prova tentativa técnica em retry no pg-boss
    const bossRes = await pool.query(
      "SELECT id, state, retry_count FROM pgboss.job WHERE data->>'jobId' = $1",
      [jobId],
    );
    assert.equal(bossRes.rows.length, 1);
    assert.equal(bossRes.rows[0].state, 'retry');

    // 3. Prova que nova fetch retorna o mesmo technical job id com retryCount maior (1)
    await pool.query(
      "UPDATE pgboss.job SET start_after = now() - interval '1 second' WHERE id = $1",
      [bossRes.rows[0].id],
    );
    const retriedDeliveries = await runtime.fetchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, 1);
    assert.equal(retriedDeliveries.length, 1);
    assert.equal(retriedDeliveries[0].id, bossRes.rows[0].id);
    assert.equal(retriedDeliveries[0].retryCount, 1);

    // Conclui delivery técnica para limpar
    await runtime.completeWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      id: retriedDeliveries[0].id,
      retryCount: retriedDeliveries[0].retryCount,
    });

    // 4. Prova JobState intacto (queued, revision 1) e sem tentativas NEX
    const headRes = await pool.query('SELECT status, revision FROM nex_job_heads WHERE job_id = $1', [jobId]);
    assert.equal(headRes.rows[0].status, 'queued');
    assert.equal(headRes.rows[0].revision, 1);

    const eventRes = await pool.query('SELECT revision FROM nex_job_events WHERE job_id = $1', [jobId]);
    assert.equal(eventRes.rows.length, 1);
  });

  // ==========================================================================
  // C11. STALE CANONICAL CLAIM BEFORE RELEASE
  // ==========================================================================
  it('C11: se claim se torna stale durante o callback, release falha e delivery não é concluída como sucesso', async () => {
    const jobId = 'job_c11_claim_stale_before_release';
    await createJobAndWakeup(jobStore, runtime, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    const bridge = new JobWorkerBridge(runtime, jobStore, claimStore, {
      workerId: 'worker_c11_a',
      leaseDurationMs: 30000,
    });

    await assert.rejects(
      async () => {
        await bridge.processNext(async () => {
          // Simula roubo ou expiração do claim por outro worker enquanto A estava rodando
          await pool.query(
            "UPDATE nex_job_claims SET worker_id = 'worker_c11_stolen', fencing_token = 99 WHERE job_id = $1",
            [jobId],
          );
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );

    // Prova que o claim com fence 99 permaneceu intacto (não foi liberado por A)
    const claimSnapshotC11 = await claimStore.getJobClaim(jobId);
    assert.ok(claimSnapshotC11);
    assert.equal(claimSnapshotC11.workerId, 'worker_c11_stolen');
    assert.equal(claimSnapshotC11.fencingToken, '99');
  });

  // ==========================================================================
  // C12. TECHNICAL ATTEMPT STALE FENCE
  // ==========================================================================
  it('C12: settlement de tentativa técnica com retryCount stale resulta em affected=0 / settled=false', async () => {
    const jobId = 'job_c12_technical_stale_fence';
    const sendRes = await runtime.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, { jobId });

    // Força avanço de retry_count no banco pg-boss
    await pool.query(
      "UPDATE pgboss.job SET retry_count = 1, state = 'active' WHERE id = $1",
      [sendRes.messageId],
    );

    // Tentativa antiga de liquidar com retryCount = 0
    const staleResult = await runtime.completeWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      id: sendRes.messageId!,
      retryCount: 0,
    });

    assert.equal(staleResult.settled, false);
    assert.equal(staleResult.affected, 0);

    // Tentativa antiga de failWakeup com retryCount = 0 também retorna affected=0
    const staleFailResult = await runtime.failWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      id: sendRes.messageId!,
      retryCount: 0,
    });
    assert.equal(staleFailResult.settled, false);
    assert.equal(staleFailResult.affected, 0);

    // Tentativa com retryCount correto = 1
    const freshResult = await runtime.completeWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      id: sendRes.messageId!,
      retryCount: 1,
    });

    assert.equal(freshResult.settled, true);
    assert.equal(freshResult.affected, 1);

    // Prova ponta-a-ponta via JobWorkerBridge:
    // Callback falha, mas a attempt técnica ficou stale antes do settlement de falha
    const bridgeJobId = 'job_c12_bridge_technical_stale';
    await createJobAndWakeup(jobStore, runtime, {
      jobId: bridgeJobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    const bridge = new JobWorkerBridge(runtime, jobStore, claimStore, {
      workerId: 'worker_c12_stale_test',
      leaseDurationMs: 30000,
    });

    const callbackError = new Error('simulated_failure_during_stale_test');

    await assert.rejects(
      async () => {
        await bridge.processNext(async () => {
          // Simula que durante o callback o pg-boss avançou o retry_count da mensagem
          await pool.query(
            "UPDATE pgboss.job SET retry_count = 5, state = 'active' WHERE data->>'jobId' = $1",
            [bridgeJobId],
          );
          throw callbackError;
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof WorkerBridgeError);
        assert.equal(err.primaryError, callbackError);
        assert.equal(err.hasReleaseError, false);
        assert.equal(err.hasTechnicalSettlementError, true);
        assert.ok(err.technicalSettlementError instanceof WorkerBridgeTechnicalStaleError);
        assert.equal(err.technicalSettlementError.retryCount, 0);
        return true;
      },
    );

    // Confirma que a tentativa mais nova (retry_count = 5) permaneceu intacta
    const finalJobRes = await pool.query(
      "SELECT retry_count, state FROM pgboss.job WHERE data->>'jobId' = $1",
      [bridgeJobId],
    );
    assert.equal(finalJobRes.rows[0].retry_count, 5);
    assert.equal(finalJobRes.rows[0].state, 'active');
  });

  // ==========================================================================
  // C13. JOB LIFECYCLE UNCHANGED PELO BRIDGE
  // ==========================================================================
  it('C13: operações do Worker Bridge não alteram o JobState nem criam eventos no JobStore', async () => {
    const jobId = 'job_c13_zero_lifecycle_mutation';
    await createJobAndWakeup(jobStore, runtime, {
      jobId,
      createdAt: T0,
      actor: { kind: 'system', component: 'orchestrator' },
    });

    // Captura estado exato antes
    const headBefore = (await pool.query('SELECT * FROM nex_job_heads WHERE job_id = $1', [jobId])).rows[0];
    const eventsBefore = (await pool.query('SELECT * FROM nex_job_events WHERE job_id = $1', [jobId])).rows;

    const bridge = new JobWorkerBridge(runtime, jobStore, claimStore, {
      workerId: 'worker_c13',
      leaseDurationMs: 30000,
    });

    const res = await bridge.processNext(async (ctx) => {
      assert.equal(ctx.job.jobId, jobId);
    });
    assert.equal(res.outcome, 'processed');

    // Captura estado exato depois
    const headAfter = (await pool.query('SELECT * FROM nex_job_heads WHERE job_id = $1', [jobId])).rows[0];
    const eventsAfter = (await pool.query('SELECT * FROM nex_job_events WHERE job_id = $1', [jobId])).rows;

    // Compara campos de domínio
    assert.equal(headAfter.status, headBefore.status);
    assert.equal(headAfter.revision, headBefore.revision);
    assert.equal(headAfter.created_at.toISOString(), headBefore.created_at.toISOString());
    assert.equal(headAfter.updated_at.toISOString(), headBefore.updated_at.toISOString());
    assert.deepEqual(headAfter.state_payload, headBefore.state_payload);
    assert.equal(eventsAfter.length, eventsBefore.length);
  });
});
