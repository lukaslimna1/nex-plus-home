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

  before(async () => {
    poolA = new Pool({ connectionString: databaseUrl, max: 10 });
    poolB = new Pool({ connectionString: databaseUrl, max: 10 });

    storeA = new PostgresJobClaimStore(poolA);
    storeB = new PostgresJobClaimStore(poolB);

    // Criação dos Jobs canônicos em nex_job_heads para satisfazer a FK de nex_job_claims
    const jobIds = [testJobId1, testJobId2, testJobId3, testJobId4, testJobId5];
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

    // Forçar expiração atômica no banco de teste
    await poolA.query(
      `UPDATE "nex_job_claims"
       SET "lease_until" = CURRENT_TIMESTAMP(3) - interval '1 second'
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
});
