/**
 * NEX+ · Canonical Job Claims & Operational Lease
 * Testes de Integração com PostgreSQL Real e Provas de Concorrência Atômica (0.86C-3B)
 *
 * Cobertura de Validação:
 * 1. Primeiro claim atômico (fence 1)
 * 2. Concorrência real de primeiro claim entre pools independentes (exatamente 1 vencedor)
 * 3. Mesmo worker tentando acquire em lease ativa recebe 'held' (sem auto-renew acidental)
 * 4. Renovação segura (renew) avançando renewed_at e lease_until preservando fence
 * 5. Liberação (release) marcando released_at sem deletar a linha nem zerar o fence
 * 6. Concorrência sob claim liberado (exatamente 1 vencedor recebendo fence + 1)
 * 7. Concorrência sob claim expirado (exatamente 1 vencedor recebendo fence + 1)
 * 8. Proteção contra renew / release stale (fencing token antigo ou estado não-ativo)
 * 9. Restrição referencial FK para nex_job_heads (JobClaimJobNotFoundError)
 * 10. getJobClaim com derivação temporal via relógio do PostgreSQL
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import {
  PostgresJobClaimStore,
  JobClaimJobNotFoundError,
  JobClaimStaleError,
} from '../index';
import { PostgresJobStore } from '../../persistence/postgres';
import type { JobId } from '../../contracts';
import type { SessionRef } from '../../../../auth/session-ref.types';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (process.env.NEX_REQUIRE_JOB_CLAIMS_DB === '1' && !databaseUrl) {
  throw new Error(
    'NEX_REQUIRE_JOB_CLAIMS_DB=1 is set but DATABASE_URL is missing. Aborting test suite to prevent accidental green skip.'
  );
}

describe('Canonical Job Claims — PostgreSQL Integration & Concurrency (0.86C-3B)', { skip: !databaseUrl }, () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let storeA: PostgresJobClaimStore;
  let storeB: PostgresJobClaimStore;

  const testJobId1 = 'job_claim_itest_001';
  const testJobId2 = 'job_claim_itest_002';
  const testJobId3 = 'job_claim_itest_003';
  const testJobId4 = 'job_claim_itest_004';
  const testJobId5 = 'job_claim_itest_005';
  const testJobId6 = 'job_claim_itest_006';

  before(async () => {
    poolA = new Pool({ connectionString: databaseUrl, max: 10 });
    poolB = new Pool({ connectionString: databaseUrl, max: 10 });

    storeA = new PostgresJobClaimStore(poolA);
    storeB = new PostgresJobClaimStore(poolB);

    // Criação dos Jobs canônicos em nex_job_heads para satisfazer a FK de nex_job_claims
    const jobIds = [testJobId1, testJobId2, testJobId3, testJobId4, testJobId5, testJobId6];
    for (const jId of jobIds) {
      await poolA.query(
        `INSERT INTO "nex_job_heads" (
           "job_id", "status", "revision", "created_at", "updated_at", "state_payload"
         ) VALUES (
           $1, 'queued', 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), $2::jsonb
         ) ON CONFLICT ("job_id") DO NOTHING;`,
        [jId, JSON.stringify({ jobId: jId })]
      );
    }
  });

  after(async () => {
    await poolA.end();
    await poolB.end();
  });

  it('1. adquire primeiro claim em job sem claim com fencing token 1 e lease ativa', async () => {
    const res = await storeA.acquireClaim({
      jobId: testJobId1,
      workerId: 'worker_alpha',
      leaseDurationMs: 60000,
    });

    assert.equal(res.acquired, true);
    if (res.acquired) {
      assert.equal(res.claim.jobId, testJobId1);
      assert.equal(res.claim.workerId, 'worker_alpha');
      assert.equal(res.claim.fencingToken, '1');
      assert.equal(res.claim.state, 'active');
      assert.equal(res.claim.releasedAt, null);
      assert.ok(new Date(res.claim.leaseUntil).getTime() > new Date(res.claim.acquiredAt).getTime());
    }

    const fetched = await storeA.getJobClaim(testJobId1);
    assert.ok(fetched);
    assert.equal(fetched.fencingToken, '1');
    assert.equal(fetched.state, 'active');
  });

  it('2. concorrência de primeiro claim entre dois workers independentes: exatamente um vence com fence 1', async () => {
    // testJobId2 não possui claims prévios
    const [res1, res2] = await Promise.all([
      storeA.acquireClaim({
        jobId: testJobId2,
        workerId: 'worker_pool_a',
        leaseDurationMs: 60000,
      }),
      storeB.acquireClaim({
        jobId: testJobId2,
        workerId: 'worker_pool_b',
        leaseDurationMs: 60000,
      }),
    ]);

    const winners = [res1, res2].filter((r) => r.acquired);
    const losers = [res1, res2].filter((r) => !r.acquired);

    assert.equal(winners.length, 1, 'Exatamente um worker deve adquirir o claim');
    assert.equal(losers.length, 1, 'Exatamente um worker deve ser rejeitado com held');

    const winner = winners[0];
    const loser = losers[0];

    assert.equal(winner.acquired, true);
    if (winner.acquired) {
      assert.equal(winner.claim.fencingToken, '1');
      assert.equal(winner.claim.state, 'active');
    }

    assert.equal(loser.acquired, false);
    if (!loser.acquired) {
      assert.equal(loser.reason, 'held');
    }
  });

  it('3. mesmo worker tentando acquire novamente em lease ativa é rejeitado com held (não renew automático)', async () => {
    // testJobId1 pertence ativamente a worker_alpha
    const res = await storeA.acquireClaim({
      jobId: testJobId1,
      workerId: 'worker_alpha',
      leaseDurationMs: 60000,
    });

    assert.equal(res.acquired, false);
    if (!res.acquired) {
      assert.equal(res.reason, 'held');
    }

    // Fencing token não pode ter sido alterado
    const fetched = await storeA.getJobClaim(testJobId1);
    assert.ok(fetched);
    assert.equal(fetched.fencingToken, '1');
  });

  it('4. renovação segura (renewClaim) avança renewed_at e lease_until preservando fence e worker', async () => {
    const beforeClaim = await storeA.getJobClaim(testJobId1);
    assert.ok(beforeClaim);

    // Pequeno intervalo real para garantir monotonicidade de timestamp no DB
    await new Promise((resolve) => setTimeout(resolve, 50));

    const renewed = await storeA.renewClaim({
      jobId: testJobId1,
      workerId: 'worker_alpha',
      fencingToken: '1',
      leaseDurationMs: 120000,
    });

    assert.equal(renewed.jobId, testJobId1);
    assert.equal(renewed.workerId, 'worker_alpha');
    assert.equal(renewed.fencingToken, '1');
    assert.equal(renewed.acquiredAt, beforeClaim.acquiredAt);
    assert.ok(
      new Date(renewed.renewedAt).getTime() >= new Date(beforeClaim.renewedAt).getTime(),
      'renewedAt deve ter avançado'
    );
    assert.ok(
      new Date(renewed.leaseUntil).getTime() > new Date(beforeClaim.leaseUntil).getTime(),
      'leaseUntil deve ter sido estendido'
    );
    assert.equal(renewed.state, 'active');
  });

  it('5. liberação graciosa (releaseClaim) marca released_at sem deletar a linha nem zerar fence', async () => {
    const released = await storeA.releaseClaim({
      jobId: testJobId1,
      workerId: 'worker_alpha',
      fencingToken: '1',
    });

    assert.equal(released.jobId, testJobId1);
    assert.equal(released.fencingToken, '1');
    assert.equal(released.state, 'released');
    assert.ok(released.releasedAt);

    // Linha permanece no PostgreSQL
    const fetched = await storeA.getJobClaim(testJobId1);
    assert.ok(fetched);
    assert.equal(fetched.state, 'released');
    assert.equal(fetched.fencingToken, '1');
    assert.ok(fetched.releasedAt);
  });

  it('6. concorrência de reacquire sob claim liberado: exatamente um vence com fence incrementado para 2', async () => {
    // testJobId1 está em estado 'released' (fence 1)
    const [resA, resB] = await Promise.all([
      storeA.acquireClaim({
        jobId: testJobId1,
        workerId: 'worker_new_a',
        leaseDurationMs: 60000,
      }),
      storeB.acquireClaim({
        jobId: testJobId1,
        workerId: 'worker_new_b',
        leaseDurationMs: 60000,
      }),
    ]);

    const winners = [resA, resB].filter((r) => r.acquired);
    const losers = [resA, resB].filter((r) => !r.acquired);

    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);

    const winner = winners[0];
    assert.equal(winner.acquired, true);
    if (winner.acquired) {
      assert.equal(winner.claim.fencingToken, '2', 'Novo fencing token deve ser exatamente 2 (anterior + 1)');
      assert.equal(winner.claim.state, 'active');
      assert.equal(winner.claim.releasedAt, null);
    }
  });

  it('7. concorrência sob claim expirado: exatamente um vence com fence incrementado em 1', async () => {
    // testJobId3: criar claim com worker inicial
    const initialRes = await storeA.acquireClaim({
      jobId: testJobId3,
      workerId: 'worker_to_expire',
      leaseDurationMs: 60000,
    });
    assert.equal(initialRes.acquired, true);
    if (!initialRes.acquired) return;
    assert.equal(initialRes.claim.fencingToken, '1');

    // Forçar expiração atômica no banco de teste preservando sanidade temporal
    await poolA.query(
      `UPDATE "nex_job_claims"
       SET "acquired_at" = CURRENT_TIMESTAMP(3) - interval '10 seconds',
           "renewed_at"  = CURRENT_TIMESTAMP(3) - interval '10 seconds',
           "lease_until" = CURRENT_TIMESTAMP(3) - interval '1 second'
       WHERE "job_id" = $1;`,
      [testJobId3]
    );

    // Verificar que o estado do claim foi derivado como 'expired'
    const expiredClaim = await storeA.getJobClaim(testJobId3);
    assert.ok(expiredClaim);
    assert.equal(expiredClaim.state, 'expired');

    // Dois workers concorrentes disputam o claim expirado
    const [res1, res2] = await Promise.all([
      storeA.acquireClaim({
        jobId: testJobId3,
        workerId: 'worker_reclaim_1',
        leaseDurationMs: 60000,
      }),
      storeB.acquireClaim({
        jobId: testJobId3,
        workerId: 'worker_reclaim_2',
        leaseDurationMs: 60000,
      }),
    ]);

    const winners = [res1, res2].filter((r) => r.acquired);
    const losers = [res1, res2].filter((r) => !r.acquired);

    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);

    const winner = winners[0];
    assert.equal(winner.acquired, true);
    if (winner.acquired) {
      assert.equal(winner.claim.fencingToken, '2', 'Fencing token deve avançar de 1 para 2');
      assert.equal(winner.claim.state, 'active');
    }
  });

  it('8. rejeita renew e release stale com JobClaimStaleError', async () => {
    // testJobId4 inicial
    await storeA.acquireClaim({
      jobId: testJobId4,
      workerId: 'worker_gen1',
      leaseDurationMs: 60000,
    });

    // Worker com fence antigo não pode fazer renew
    await assert.rejects(
      () =>
        storeA.renewClaim({
          jobId: testJobId4,
          workerId: 'worker_gen1',
          fencingToken: '999', // token errado
          leaseDurationMs: 60000,
        }),
      JobClaimStaleError
    );

    // Worker diferente não pode fazer release
    await assert.rejects(
      () =>
        storeA.releaseClaim({
          jobId: testJobId4,
          workerId: 'worker_intruder',
          fencingToken: '1',
        }),
      JobClaimStaleError
    );

    // Liberar legitimamente
    await storeA.releaseClaim({
      jobId: testJobId4,
      workerId: 'worker_gen1',
      fencingToken: '1',
    });

    // Segundo release sobre claim já liberado falha
    await assert.rejects(
      () =>
        storeA.releaseClaim({
          jobId: testJobId4,
          workerId: 'worker_gen1',
          fencingToken: '1',
        }),
      JobClaimStaleError
    );

    // Renew sobre claim já liberado falha
    await assert.rejects(
      () =>
        storeA.renewClaim({
          jobId: testJobId4,
          workerId: 'worker_gen1',
          fencingToken: '1',
          leaseDurationMs: 60000,
        }),
      JobClaimStaleError
    );
  });

  it('9. tentativa de claim para Job inexistente lança JobClaimJobNotFoundError (FK)', async () => {
    await assert.rejects(
      () =>
        storeA.acquireClaim({
          jobId: 'job_does_not_exist_in_heads_xyz',
          workerId: 'worker_x',
          leaseDurationMs: 60000,
        }),
      (err: unknown) => {
        assert.ok(err instanceof JobClaimJobNotFoundError);
        assert.equal(err.code, 'JOB_NOT_FOUND');
        assert.equal(err.jobId, 'job_does_not_exist_in_heads_xyz');
        return true;
      }
    );
  });

  it('10. getJobClaim retorna undefined para Job sem claims prévios', async () => {
    const claim = await storeA.getJobClaim(testJobId5);
    assert.equal(claim, undefined);
  });

  it('11. F-3B-03A: restart real Pool A -> Pool B preserva claim ativo factual e permite reacquire pós-expiry', async () => {
    // 1. Criar Pool A dedicado para isolar ciclo de vida de conexão
    const poolIsolatedA = new Pool({ connectionString: databaseUrl, max: 2 });
    const storeIsolatedA = new PostgresJobClaimStore(poolIsolatedA);

    // 2. Pool A adquire claim
    const acquireResA = await storeIsolatedA.acquireClaim({
      jobId: testJobId6,
      workerId: 'worker_isolated_alpha',
      leaseDurationMs: 60000,
    });

    assert.equal(acquireResA.acquired, true);
    if (!acquireResA.acquired) return;

    const savedWorkerId = acquireResA.claim.workerId;
    const savedFencingToken = acquireResA.claim.fencingToken;
    const savedAcquiredAt = acquireResA.claim.acquiredAt;
    const savedLeaseUntil = acquireResA.claim.leaseUntil;

    assert.equal(savedWorkerId, 'worker_isolated_alpha');
    assert.equal(savedFencingToken, '1');

    // 3. Fechar COMPLETAMENTE Pool A (restart real de conexão)
    await poolIsolatedA.end();

    // 4. Criar NOVO Pool B e NOVO store
    const poolIsolatedB = new Pool({ connectionString: databaseUrl, max: 2 });
    const storeIsolatedB = new PostgresJobClaimStore(poolIsolatedB);

    try {
      // 5. getJobClaim no novo pool confirma persistência factual
      const fetchedB = await storeIsolatedB.getJobClaim(testJobId6);
      assert.ok(fetchedB);
      assert.equal(fetchedB.jobId, testJobId6);
      assert.equal(fetchedB.workerId, savedWorkerId);
      assert.equal(fetchedB.fencingToken, savedFencingToken);
      assert.equal(fetchedB.acquiredAt, savedAcquiredAt);
      assert.equal(fetchedB.leaseUntil, savedLeaseUntil);
      assert.equal(fetchedB.state, 'active');

      // 6. Pool B tenta acquire com lease ativa -> held
      const acquireHeldB = await storeIsolatedB.acquireClaim({
        jobId: testJobId6,
        workerId: 'worker_isolated_beta',
        leaseDurationMs: 60000,
      });
      assert.equal(acquireHeldB.acquired, false);
      if (!acquireHeldB.acquired) {
        assert.equal(acquireHeldB.reason, 'held');
      }

      // 7. Forçar expiry diretamente na fixture PostgreSQL preservando sanidade temporal
      await poolIsolatedB.query(
        `UPDATE "nex_job_claims"
         SET "acquired_at" = CURRENT_TIMESTAMP(3) - interval '10 seconds',
             "renewed_at"  = CURRENT_TIMESTAMP(3) - interval '10 seconds',
             "lease_until" = CURRENT_TIMESTAMP(3) - interval '1 second'
         WHERE "job_id" = $1;`,
        [testJobId6]
      );

      // Verificar estado derivado como 'expired'
      const expiredB = await storeIsolatedB.getJobClaim(testJobId6);
      assert.ok(expiredB);
      assert.equal(expiredB.state, 'expired');

      // 8. Pool B tenta reacquire pós-expiry -> sucesso com fencing token incrementado (1 -> 2)
      const reacquireResB = await storeIsolatedB.acquireClaim({
        jobId: testJobId6,
        workerId: 'worker_isolated_beta',
        leaseDurationMs: 60000,
      });
      assert.equal(reacquireResB.acquired, true);
      if (reacquireResB.acquired) {
        assert.equal(reacquireResB.claim.fencingToken, '2');
        assert.equal(reacquireResB.claim.workerId, 'worker_isolated_beta');
        assert.equal(reacquireResB.claim.state, 'active');
      }
    } finally {
      await poolIsolatedB.end();
    }
  });

  it('12. F-3B-03B: ciclo completo de claims (acquire, renew, release, reacquire) não altera JobState, revision nem nex_job_events', async () => {
    const durableJobStore = new PostgresJobStore(poolA);
    const lifecycleJobId = `job_claim_lifecycle_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` as JobId;
    const sessionRef = 'b'.repeat(64) as SessionRef;

    // 1. Criar Job canônico completo via DurableJobStore
    const initialJobState = await durableJobStore.createJob({
      jobId: lifecycleJobId,
      createdAt: '2026-09-28T10:00:00.000Z',
      userId: 'usr_lucas',
      sessionRef,
      actor: { kind: 'system', component: 'orchestrator' },
      correlationId: 'corr_lifecycle_claim_proof',
    });

    assert.equal(initialJobState.jobId, lifecycleJobId);
    assert.equal(initialJobState.status, 'queued');
    assert.equal(initialJobState.revision, 1);

    // 2. Capturar ANTES das operações de claims:
    // A. Head no banco
    const beforeHeadRes = await poolA.query(
      `SELECT "job_id", "status", "revision", "created_at", "updated_at", "state_payload"
       FROM "nex_job_heads"
       WHERE "job_id" = $1;`,
      [lifecycleJobId]
    );
    assert.equal(beforeHeadRes.rows.length, 1);
    const beforeHead = beforeHeadRes.rows[0];

    // B. Histórico no banco (nex_job_events)
    const beforeEventsRes = await poolA.query(
      `SELECT "job_id", "revision", "record_kind", "event_type", "occurred_at", "payload"
       FROM "nex_job_events"
       WHERE "job_id" = $1
       ORDER BY "revision" ASC;`,
      [lifecycleJobId]
    );
    assert.equal(beforeEventsRes.rows.length, 1);
    const beforeEvents = beforeEventsRes.rows;

    // C. JobState reidratado
    const beforeRehydrated = await durableJobStore.getJob(lifecycleJobId);
    assert.ok(beforeRehydrated);

    // 3. Executar ciclo de claims completo: acquire -> renew -> release -> reacquire
    // Acquire (fence 1)
    const acq = await storeA.acquireClaim({
      jobId: lifecycleJobId,
      workerId: 'worker_lifecycle_1',
      leaseDurationMs: 60000,
    });
    assert.equal(acq.acquired, true);

    // Renew (fence 1)
    const ren = await storeA.renewClaim({
      jobId: lifecycleJobId,
      workerId: 'worker_lifecycle_1',
      fencingToken: '1',
      leaseDurationMs: 120000,
    });
    assert.equal(ren.fencingToken, '1');

    // Release (fence 1)
    const rel = await storeA.releaseClaim({
      jobId: lifecycleJobId,
      workerId: 'worker_lifecycle_1',
      fencingToken: '1',
    });
    assert.equal(rel.state, 'released');

    // Reacquire (fence 2)
    const reacq = await storeB.acquireClaim({
      jobId: lifecycleJobId,
      workerId: 'worker_lifecycle_2',
      leaseDurationMs: 60000,
    });
    assert.equal(reacq.acquired, true);
    if (reacq.acquired) {
      assert.equal(reacq.claim.fencingToken, '2');
    }

    // 4. Capturar DEPOIS das operações de claims:
    // A. Head no banco
    const afterHeadRes = await poolA.query(
      `SELECT "job_id", "status", "revision", "created_at", "updated_at", "state_payload"
       FROM "nex_job_heads"
       WHERE "job_id" = $1;`,
      [lifecycleJobId]
    );
    assert.equal(afterHeadRes.rows.length, 1);
    const afterHead = afterHeadRes.rows[0];

    // B. Histórico no banco (nex_job_events)
    const afterEventsRes = await poolA.query(
      `SELECT "job_id", "revision", "record_kind", "event_type", "occurred_at", "payload"
       FROM "nex_job_events"
       WHERE "job_id" = $1
       ORDER BY "revision" ASC;`,
      [lifecycleJobId]
    );
    const afterEvents = afterEventsRes.rows;

    // C. JobState reidratado
    const afterRehydrated = await durableJobStore.getJob(lifecycleJobId);
    assert.ok(afterRehydrated);

    // 5. Provas factuais de isolamento e zero mutação do Job Lifecycle:
    // A. Head: revision, status, updatedAt e payload idênticos
    assert.equal(afterHead.revision, beforeHead.revision, 'Job revision deve ser idêntica (1)');
    assert.equal(afterHead.status, beforeHead.status, 'Job status deve ser idêntico (queued)');
    assert.equal(
      new Date(afterHead.updated_at).getTime(),
      new Date(beforeHead.updated_at).getTime(),
      'updated_at do Job head deve permanecer idêntico'
    );
    assert.deepEqual(afterHead.state_payload, beforeHead.state_payload, 'state_payload do Job head deve permanecer idêntico');

    // B. Histórico: contagem e registros exatos idênticos em nex_job_events
    assert.equal(afterEvents.length, beforeEvents.length, 'Contagem de nex_job_events deve ser idêntica (1)');
    assert.deepEqual(afterEvents, beforeEvents, 'Registros de nex_job_events devem ser exatamente idênticos');

    // C. Reidratação: JobState reidratado idêntico antes e depois
    assert.deepEqual(afterRehydrated, beforeRehydrated, 'JobState reidratado deve ser idêntico');
  });
});
