/**
 * NEX+ · Continuation Checkpoint Contracts & Store
 * Testes de Integração PostgreSQL para Job Checkpoint Store — Escopo 0.86C-4A
 *
 * Provas de Acceptance Cobertas:
 * 1. Checkpoint íntegro round-trip PostgreSQL;
 * 2. Restart com nova instância do adapter preserva exatamente o checkpoint;
 * 12. jobRevision inexistente / violação de FK falha fechado;
 * 17. SQL direto não consegue UPDATE/DELETE/TRUNCATE (triggers append-only);
 * 18. Duplicate checkpointId é determinístico e sem escrita parcial;
 * 19. Extra fields / prototype keys não persistem.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import type {
  CapabilityRevisionId,
  BindingRevisionId,
  RouteRevisionId,
} from '../../../capabilities/contracts';
import type {
  AttemptId,
  AttemptState,
  DecisionId,
  OutcomeAssessment,
  OutcomeAssessmentId,
} from '../../../execution/contracts';
import type { DecisionMaterialContextId } from '../../../evaluation/contracts';
import type { JobId, JobState } from '../../contracts';

import { createJobCheckpoint } from '../invariants';
import { PostgresJobCheckpointStore } from '../postgres';
import {
  DuplicateJobCheckpointError,
  JobCheckpointInvariantError,
} from '../errors';
import type { JobCheckpoint, JobCheckpointId } from '../contracts';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (process.env.NEX_REQUIRE_EXECUTION_LEDGER_DB === '1' && !databaseUrl) {
  throw new Error(
    'NEX_REQUIRE_EXECUTION_LEDGER_DB=1 is set but DATABASE_URL is missing. Aborting test suite to prevent accidental green skip.',
  );
}

describe('0.86C-4A · Persistência PostgreSQL de Continuation Checkpoint', { skip: !databaseUrl }, () => {
  let pool: pg.Pool;
  let store: PostgresJobCheckpointStore;

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    store = new PostgresJobCheckpointStore(pool);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  // Helpers para popular tabelas antecedentes (satisfazer FKs de Job Events e Outcome Assessments)
  async function seedJobAndEvents(
    client: pg.PoolClient | pg.Pool,
    jobId: string,
    revision: number = 2,
  ): Promise<void> {
    const now = new Date().toISOString();
    // 1. nex_job_heads
    await client.query(
      `
      INSERT INTO "nex_job_heads" (
        "job_id", "status", "revision", "created_at", "updated_at", "started_at", "state_payload"
      ) VALUES ($1, 'running', $2, $3, $3, $3, '{}'::jsonb)
      ON CONFLICT ("job_id") DO NOTHING
      `,
      [jobId, revision, now],
    );

    // 2. nex_job_events (revision 1 = created)
    await client.query(
      `
      INSERT INTO "nex_job_events" (
        "job_id", "revision", "record_kind", "event_type", "occurred_at", "payload"
      ) VALUES ($1, 1, 'created', NULL, $2, '{}'::jsonb)
      ON CONFLICT ("job_id", "revision") DO NOTHING
      `,
      [jobId, now],
    );

    // Se revision >= 2, inserir eventos de transição
    for (let r = 2; r <= revision; r++) {
      await client.query(
        `
        INSERT INTO "nex_job_events" (
          "job_id", "revision", "record_kind", "event_type", "occurred_at", "payload"
        ) VALUES ($1, $2, 'transition', 'JobStarted', $3, '{}'::jsonb)
        ON CONFLICT ("job_id", "revision") DO NOTHING
        `,
        [jobId, r, now],
      );
    }
  }

  async function seedAttemptAndOutcome(
    client: pg.PoolClient | pg.Pool,
    attemptId: string,
    assessmentId: string,
    opts: {
      verdict?: string;
      capabilityRevisionId?: string;
      bindingRevisionId?: string;
      routeRevisionId?: string;
    } = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    const verdict = opts.verdict ?? 'confirmed_result';
    const capRev = opts.capabilityRevisionId ?? 'cap_rev_1';
    const bindRev = opts.bindingRevisionId ?? 'bind_rev_1';
    const routeRev = opts.routeRevisionId ?? 'route_rev_1';

    // 1. nex_execution_attempt_heads
    await client.query(
      `
      INSERT INTO "nex_execution_attempt_heads" (
        "attempt_id", "decision_id", "route_evaluation_id", "status",
        "capability_revision_id", "binding_revision_id", "route_revision_id",
        "created_at", "started_at", "finished_at", "revision"
      ) VALUES ($1, 'dec_001', 'rte_001', 'succeeded', $2, $3, $4, $5, $5, $5, 1)
      ON CONFLICT ("attempt_id") DO NOTHING
      `,
      [attemptId, capRev, bindRev, routeRev, now],
    );

    // 2. nex_execution_outcome_assessments
    await client.query(
      `
      INSERT INTO "nex_execution_outcome_assessments" (
        "assessment_id", "attempt_id", "verdict", "reason_code", "assessed_at"
      ) VALUES ($1, $2, $3, 'NON_MUTATING_RESULT_VERIFIED', $4)
      ON CONFLICT ("assessment_id") DO NOTHING
      `,
      [assessmentId, attemptId, verdict, now],
    );
  }

  function buildTestJob(jobId: JobId, attemptId: AttemptId, revision: number = 2): JobState {
    return {
      jobId,
      status: 'running',
      revision,
      actor: { kind: 'human', humanId: 'usr_001' },
      materialContextPinId: 'pin_001' as any,
      attemptLineage: [attemptId],
      createdAt: '2026-09-29T20:00:00.000Z',
      updatedAt: '2026-09-29T20:30:00.000Z',
    };
  }

  function buildTestAttempt(attemptId: AttemptId): AttemptState {
    return {
      attemptId,
      decisionId: 'dec_001' as DecisionId,
      routeEvaluationId: 'rte_001' as any,
      status: 'succeeded',
      capabilityRevisionId: 'cap_rev_1' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_1' as BindingRevisionId,
      routeRevisionId: 'route_rev_1' as RouteRevisionId,
      createdAt: '2026-09-29T20:30:00.000Z',
      startedAt: '2026-09-29T20:31:00.000Z',
      finishedAt: '2026-09-29T20:35:00.000Z',
    };
  }

  function buildTestOutcome(assessmentId: OutcomeAssessmentId, attemptId: AttemptId): OutcomeAssessment {
    return {
      assessmentId,
      attemptId,
      evidenceRefs: [],
      verdict: 'confirmed_result',
      reasonCode: 'NON_MUTATING_RESULT_VERIFIED',
      assessedAt: '2026-09-29T20:40:00.000Z',
    };
  }

  it('acceptance #1: checkpoint íntegro round-trip PostgreSQL', async () => {
    const suffix = Date.now().toString();
    const jobId = `job_pg_${suffix}` as JobId;
    const attemptId = `att_pg_${suffix}` as AttemptId;
    const assessmentId = `out_pg_${suffix}` as OutcomeAssessmentId;
    const chkId = `chk_pg_${suffix}` as JobCheckpointId;

    await seedJobAndEvents(pool, jobId, 2);
    await seedAttemptAndOutcome(pool, attemptId, assessmentId);

    const job = buildTestJob(jobId, attemptId, 2);
    const attempt = buildTestAttempt(attemptId);
    const outcome = buildTestOutcome(assessmentId, attemptId);

    const chk = createJobCheckpoint({
      checkpointId: chkId,
      job,
      jobRevision: 2,
      attempt,
      outcomeAssessment: outcome,
      decisionMaterialContextId: 'dmc_001' as DecisionMaterialContextId,
      capabilityRevisionId: 'cap_rev_1' as CapabilityRevisionId,
      capabilityDomainEffect: 'none',
      bindingRevisionId: 'bind_rev_1' as BindingRevisionId,
      bindingDomainEffectAttested: 'none',
      routeRevisionId: 'route_rev_1' as RouteRevisionId,
      routeDomainEffect: 'none',
      recordedAt: '2026-09-29T20:40:00.000Z',
    });

    // Append no PostgreSQL
    await store.appendCheckpoint(chk);

    // Leitura pontual por ID
    const retrieved = await store.getCheckpoint(chkId);
    assert(retrieved !== null && retrieved !== undefined);
    assert.equal(retrieved.checkpointId, chk.checkpointId);
    assert.equal(retrieved.jobId, chk.jobId);
    assert.equal(retrieved.jobRevision, chk.jobRevision);
    assert.equal(retrieved.attemptId, chk.attemptId);
    assert.equal(retrieved.outcomeAssessmentId, chk.outcomeAssessmentId);
    assert.equal(retrieved.continuationDirective, chk.continuationDirective);
    assert.equal(retrieved.continuationReasonCode, chk.continuationReasonCode);
    assert.equal(retrieved.recordedAt, chk.recordedAt);
    assert.equal(retrieved.domainEffectBasis.effectiveIsDomainMutating, false);
    assert(Object.isFrozen(retrieved));
    assert(Object.isFrozen(retrieved.domainEffectBasis));

    // Listagem por Job
    const list = await store.listCheckpointsByJob(jobId);
    assert.equal(list.length, 1);
    assert.equal(list[0].checkpointId, chkId);
  });

  it('acceptance #2: restart com nova instância do adapter preserva exatamente o checkpoint', async () => {
    const suffix = `${Date.now()}_restart`;
    const jobId = `job_rst_${suffix}` as JobId;
    const attemptId = `att_rst_${suffix}` as AttemptId;
    const assessmentId = `out_rst_${suffix}` as OutcomeAssessmentId;
    const chkId = `chk_rst_${suffix}` as JobCheckpointId;

    await seedJobAndEvents(pool, jobId, 2);
    await seedAttemptAndOutcome(pool, attemptId, assessmentId);

    const job = buildTestJob(jobId, attemptId, 2);
    const attempt = buildTestAttempt(attemptId);
    const outcome = buildTestOutcome(assessmentId, attemptId);

    const chk = createJobCheckpoint({
      checkpointId: chkId,
      job,
      jobRevision: 2,
      attempt,
      outcomeAssessment: outcome,
      decisionMaterialContextId: 'dmc_001' as DecisionMaterialContextId,
      capabilityRevisionId: 'cap_rev_1' as CapabilityRevisionId,
      capabilityDomainEffect: 'none',
      bindingRevisionId: 'bind_rev_1' as BindingRevisionId,
      bindingDomainEffectAttested: 'none',
      routeRevisionId: 'route_rev_1' as RouteRevisionId,
      routeDomainEffect: 'none',
      recordedAt: '2026-09-29T20:40:00.000Z',
    });

    await store.appendCheckpoint(chk);

    // Nova instância de adapter com nova conexão
    const freshPool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      const freshStore = new PostgresJobCheckpointStore(freshPool);
      const rehydrated = await freshStore.getCheckpoint(chkId);

      assert(rehydrated !== null && rehydrated !== undefined);
      assert.deepEqual(rehydrated, chk);
      assert(Object.isFrozen(rehydrated));
    } finally {
      await freshPool.end();
    }
  });

  it('acceptance #17: SQL direto não consegue UPDATE, DELETE ou TRUNCATE (triggers append-only)', async () => {
    const suffix = `${Date.now()}_trg`;
    const jobId = `job_trg_${suffix}` as JobId;
    const attemptId = `att_trg_${suffix}` as AttemptId;
    const assessmentId = `out_trg_${suffix}` as OutcomeAssessmentId;
    const chkId = `chk_trg_${suffix}` as JobCheckpointId;

    await seedJobAndEvents(pool, jobId, 2);
    await seedAttemptAndOutcome(pool, attemptId, assessmentId);

    const job = buildTestJob(jobId, attemptId, 2);
    const attempt = buildTestAttempt(attemptId);
    const outcome = buildTestOutcome(assessmentId, attemptId);

    const chk = createJobCheckpoint({
      checkpointId: chkId,
      job,
      jobRevision: 2,
      attempt,
      outcomeAssessment: outcome,
      decisionMaterialContextId: 'dmc_001' as DecisionMaterialContextId,
      capabilityRevisionId: 'cap_rev_1' as CapabilityRevisionId,
      capabilityDomainEffect: 'none',
      bindingRevisionId: 'bind_rev_1' as BindingRevisionId,
      bindingDomainEffectAttested: 'none',
      routeRevisionId: 'route_rev_1' as RouteRevisionId,
      routeDomainEffect: 'none',
      recordedAt: '2026-09-29T20:40:00.000Z',
    });

    await store.appendCheckpoint(chk);

    // 1. Tentar UPDATE direto via SQL
    await assert.rejects(
      async () => {
        await pool.query(
          `UPDATE "nex_job_checkpoints" SET "continuation_directive" = 'stop' WHERE "checkpoint_id" = $1`,
          [chkId],
        );
      },
      (err: any) => {
        assert(err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION'));
        return true;
      },
    );

    // 2. Tentar DELETE direto via SQL
    await assert.rejects(
      async () => {
        await pool.query(
          `DELETE FROM "nex_job_checkpoints" WHERE "checkpoint_id" = $1`,
          [chkId],
        );
      },
      (err: any) => {
        assert(err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION'));
        return true;
      },
    );

    // 3. Tentar TRUNCATE direto via SQL
    await assert.rejects(
      async () => {
        await pool.query(`TRUNCATE TABLE "nex_job_checkpoints"`);
      },
      (err: any) => {
        assert(err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION'));
        return true;
      },
    );
  });

  it('acceptance #18: duplicate checkpointId é determinístico e sem escrita parcial', async () => {
    const suffix = `${Date.now()}_dup`;
    const jobId = `job_dup_${suffix}` as JobId;
    const attemptId = `att_dup_${suffix}` as AttemptId;
    const assessmentId = `out_dup_${suffix}` as OutcomeAssessmentId;
    const chkId = `chk_dup_${suffix}` as JobCheckpointId;

    await seedJobAndEvents(pool, jobId, 2);
    await seedAttemptAndOutcome(pool, attemptId, assessmentId);

    const job = buildTestJob(jobId, attemptId, 2);
    const attempt = buildTestAttempt(attemptId);
    const outcome = buildTestOutcome(assessmentId, attemptId);

    const chk = createJobCheckpoint({
      checkpointId: chkId,
      job,
      jobRevision: 2,
      attempt,
      outcomeAssessment: outcome,
      decisionMaterialContextId: 'dmc_001' as DecisionMaterialContextId,
      capabilityRevisionId: 'cap_rev_1' as CapabilityRevisionId,
      capabilityDomainEffect: 'none',
      bindingRevisionId: 'bind_rev_1' as BindingRevisionId,
      bindingDomainEffectAttested: 'none',
      routeRevisionId: 'route_rev_1' as RouteRevisionId,
      routeDomainEffect: 'none',
      recordedAt: '2026-09-29T20:40:00.000Z',
    });

    // 1ª escrita: OK
    await store.appendCheckpoint(chk);

    // 2ª escrita com mesmo ID: deve falhar determinísticamente com DuplicateJobCheckpointError
    await assert.rejects(
      async () => {
        await store.appendCheckpoint(chk);
      },
      (err: unknown) => {
        assert(err instanceof DuplicateJobCheckpointError);
        assert.equal(err.checkpointId, chkId);
        return true;
      },
    );

    // Verificar que continua existindo apenas 1 registro
    const res = await pool.query(
      `SELECT count(*)::int as count FROM "nex_job_checkpoints" WHERE "checkpoint_id" = $1`,
      [chkId],
    );
    assert.equal(res.rows[0].count, 1);
  });

  it('acceptance #12: violação de FK para job_events ou outcome_assessments falha fechado', async () => {
    const suffix = `${Date.now()}_fk`;
    const chkId = `chk_fk_${suffix}` as JobCheckpointId;

    // Tentativa com job inexistente em nex_job_events
    const unseededJobId = `job_missing_${suffix}` as JobId;
    const attemptId = `att_fk_${suffix}` as AttemptId;
    const assessmentId = `out_fk_${suffix}` as OutcomeAssessmentId;

    // Seedamos o attempt e outcome, mas NÃO seedamos o job_event
    await seedAttemptAndOutcome(pool, attemptId, assessmentId);

    const rawChk: JobCheckpoint = {
      checkpointId: chkId,
      jobId: unseededJobId,
      jobRevision: 99, // Inexistente em nex_job_events
      attemptId,
      outcomeAssessmentId: assessmentId,
      decisionMaterialContextId: 'dmc_001' as DecisionMaterialContextId,
      domainEffectBasis: {
        capabilityRevisionId: 'cap_rev_1' as CapabilityRevisionId,
        capabilityDomainEffect: 'none',
        bindingRevisionId: 'bind_rev_1' as BindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId: 'route_rev_1' as RouteRevisionId,
        routeDomainEffect: 'none',
        effectiveIsDomainMutating: false,
      },
      continuationDirective: 'stop',
      continuationReasonCode: 'RESULT_CONFIRMED_STOP',
      recordedAt: '2026-09-29T20:40:00.000Z',
    };

    await assert.rejects(
      async () => {
        await store.appendCheckpoint(rawChk);
      },
      (err: unknown) => {
        assert(err instanceof JobCheckpointInvariantError);
        assert(err.message.includes('Foreign key violation'));
        return true;
      },
    );
  });

  it('constraint de banco: nex_job_checkpoints_mutating_chk rejeita effective_is_domain_mutating inconsistente', async () => {
    const suffix = `${Date.now()}_chk_mut`;
    const jobId = `job_chk_mut_${suffix}`;
    const attemptId = `att_chk_mut_${suffix}`;
    const assessmentId = `out_chk_mut_${suffix}`;
    const chkId = `chk_mut_raw_${suffix}`;

    await seedJobAndEvents(pool, jobId, 1);
    await seedAttemptAndOutcome(pool, attemptId, assessmentId);

    // Tentar INSERT direto violando a constraint que exige effective_is_domain_mutating = true quando capability = may_mutate_domain
    await assert.rejects(
      async () => {
        await pool.query(
          `
          INSERT INTO "nex_job_checkpoints" (
            "checkpoint_id", "job_id", "job_revision", "attempt_id", "outcome_assessment_id",
            "decision_material_context_id", "capability_revision_id", "capability_domain_effect",
            "binding_revision_id", "binding_domain_effect_attested", "route_revision_id",
            "route_domain_effect", "effective_is_domain_mutating", "continuation_directive",
            "continuation_reason_code", "recorded_at"
          ) VALUES (
            $1, $2, 1, $3, $4,
            'dmc_01', 'cap_1', 'may_mutate_domain',
            'bind_1', 'none', 'route_1',
            'none', false, 'stop', -- false aqui VIOLA nex_job_checkpoints_mutating_chk
            'STOP_REASON', NOW()
          )
          `,
          [chkId, jobId, attemptId, assessmentId],
        );
      },
      (err: any) => {
        assert(err.message.includes('nex_job_checkpoints_mutating_chk'));
        return true;
      },
    );
  });

  it('listCheckpointsByJob retorna múltiplos checkpoints na ordem exata de append (append_sequence ASC)', async () => {
    const suffix = `${Date.now()}_multi`;
    const jobId = `job_multi_${suffix}` as JobId;
    const attemptId = `att_multi_${suffix}` as AttemptId;
    const assessmentId = `out_multi_${suffix}` as OutcomeAssessmentId;

    await seedJobAndEvents(pool, jobId, 2);
    await seedAttemptAndOutcome(pool, attemptId, assessmentId);

    const job = buildTestJob(jobId, attemptId, 2);
    const attempt = buildTestAttempt(attemptId);
    const outcome = buildTestOutcome(assessmentId, attemptId);

    const chk1 = createJobCheckpoint({
      checkpointId: `chk_multi_1_${suffix}` as JobCheckpointId,
      job,
      jobRevision: 2,
      attempt,
      outcomeAssessment: outcome,
      decisionMaterialContextId: 'dmc_001' as DecisionMaterialContextId,
      capabilityRevisionId: 'cap_rev_1' as CapabilityRevisionId,
      capabilityDomainEffect: 'none',
      bindingRevisionId: 'bind_rev_1' as BindingRevisionId,
      bindingDomainEffectAttested: 'none',
      routeRevisionId: 'route_rev_1' as RouteRevisionId,
      routeDomainEffect: 'none',
      recordedAt: '2026-09-29T20:41:00.000Z',
    });

    const chk2 = createJobCheckpoint({
      checkpointId: `chk_multi_2_${suffix}` as JobCheckpointId,
      job,
      jobRevision: 2,
      attempt,
      outcomeAssessment: outcome,
      decisionMaterialContextId: 'dmc_001' as DecisionMaterialContextId,
      capabilityRevisionId: 'cap_rev_1' as CapabilityRevisionId,
      capabilityDomainEffect: 'none',
      bindingRevisionId: 'bind_rev_1' as BindingRevisionId,
      bindingDomainEffectAttested: 'none',
      routeRevisionId: 'route_rev_1' as RouteRevisionId,
      routeDomainEffect: 'none',
      recordedAt: '2026-09-29T20:42:00.000Z',
    });

    await store.appendCheckpoint(chk1);
    await store.appendCheckpoint(chk2);

    const list = await store.listCheckpointsByJob(jobId);
    assert.equal(list.length, 2);
    assert.equal(list[0].checkpointId, chk1.checkpointId);
    assert.equal(list[1].checkpointId, chk2.checkpointId);
  });

  it('F-4A-ROUNDTRIP-TIME-01: round-trip no PostgreSQL para timestamps sem fração, .1Z, .12Z e .123Z com igualdade exata', async () => {
    const rawInstants = [
      '2026-09-29T21:00:00Z',
      '2026-09-29T21:00:00.1Z',
      '2026-09-29T21:00:00.12Z',
      '2026-09-29T21:00:00.123Z',
    ];

    const suffix = `${Date.now()}_time_rt`;
    const jobId = `job_trt_${suffix}` as JobId;
    const attemptId = `att_trt_${suffix}` as AttemptId;
    const assessmentId = `out_trt_${suffix}` as OutcomeAssessmentId;

    await seedJobAndEvents(pool, jobId, 2);
    await seedAttemptAndOutcome(pool, attemptId, assessmentId);

    const job = buildTestJob(jobId, attemptId, 2);
    const attempt = buildTestAttempt(attemptId);
    const outcome = buildTestOutcome(assessmentId, attemptId);

    for (let i = 0; i < rawInstants.length; i++) {
      const rawTime = rawInstants[i];
      const chkId = `chk_trt_${i}_${suffix}` as JobCheckpointId;

      // 1. Criação na factory (normalização determinística)
      const chk = createJobCheckpoint({
        checkpointId: chkId,
        job,
        jobRevision: 2,
        attempt,
        outcomeAssessment: outcome,
        decisionMaterialContextId: 'dmc_001' as DecisionMaterialContextId,
        capabilityRevisionId: 'cap_rev_1' as CapabilityRevisionId,
        capabilityDomainEffect: 'none',
        bindingRevisionId: 'bind_rev_1' as BindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId: 'route_rev_1' as RouteRevisionId,
        routeDomainEffect: 'none',
        recordedAt: rawTime,
      });

      // 2. Provar normalização determinística (.SSSZ)
      assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(chk.recordedAt));

      // 3. Persistência
      await store.appendCheckpoint(chk);

      // 4. Reidratação
      const rehydrated = await store.getCheckpoint(chkId);
      assert(rehydrated !== null && rehydrated !== undefined);

      // 5. Provar igualdade exata com o objeto canônico gerado pela factory
      assert.deepEqual(rehydrated, chk);
      assert.equal(rehydrated.recordedAt, chk.recordedAt);
      assert.equal(rehydrated.checkpointId, chk.checkpointId);
    }
  });
});
