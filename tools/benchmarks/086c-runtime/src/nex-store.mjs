import { randomUUID } from 'node:crypto';
import { LAB } from './constants.mjs';

async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function assertLease(job, workerId, leaseEpoch) {
  if (job.state !== 'running' || job.lease_owner !== workerId || Number(job.lease_epoch) !== Number(leaseEpoch)) {
    throw new Error('fenced: worker no longer owns the current operational lease');
  }
}

export async function createLaboratoryJob(pool, {
  jobId = randomUUID(),
  effectKey = `effect:${jobId}`,
  providerMode = 'non_idempotent',
  enqueue = 'direct',
} = {}) {
  return transaction(pool, (client) => createLaboratoryJobInTransaction(client, {
    jobId,
    effectKey,
    providerMode,
    enqueue,
  }));
}

export async function createLaboratoryJobInTransaction(client, {
  jobId = randomUUID(),
  effectKey = `effect:${jobId}`,
  providerMode = 'non_idempotent',
  enqueue = 'direct',
} = {}) {
  await client.query(
    "insert into bench_jobs (id, state, effect_key, provider_mode) values ($1, 'queued', $2, $3)",
    [jobId, effectKey, providerMode],
  );
  if (enqueue === 'direct') {
    await client.query("insert into bench_deliveries (job_id, kind) values ($1, 'direct_enqueue')", [jobId]);
    await client.query('select pg_notify($1, $2)', [LAB.notifyChannel, jobId]);
  } else if (enqueue === 'outbox') {
    await client.query('insert into bench_outbox (job_id) values ($1)', [jobId]);
  } else {
    throw new Error(`unknown enqueue mode ${enqueue}`);
  }
  return { jobId, effectKey, providerMode, enqueue };
}

export async function relayOutbox(pool) {
  return transaction(pool, async (client) => {
    const claimed = await client.query(`
      select id, job_id
      from bench_outbox
      where published_at is null
      order by id
      for update skip locked
    `);
    for (const row of claimed.rows) {
      await client.query('update bench_outbox set published_at = now() where id = $1', [row.id]);
      await client.query("insert into bench_deliveries (job_id, kind) values ($1, 'outbox_relay')", [row.job_id]);
      await client.query('select pg_notify($1, $2)', [LAB.notifyChannel, row.job_id]);
    }
    return claimed.rows.map((row) => row.job_id);
  });
}

export async function claimNextJob(pool, workerId, leaseMs = 1_000) {
  const result = await pool.query(`
    with candidate as (
      select id
      from bench_jobs
      where state = 'queued'
      order by created_at, id
      for update skip locked
      limit 1
    )
    update bench_jobs as job
    set state = 'running',
        revision = job.revision + 1,
        lease_owner = $1,
        lease_epoch = job.lease_epoch + 1,
        lease_until = now() + ($2::text || ' milliseconds')::interval,
        updated_at = now()
    from candidate
    where job.id = candidate.id
    returning job.*
  `, [workerId, leaseMs]);
  return result.rows[0] ?? null;
}

export async function claimJobById(pool, jobId, workerId, leaseMs = 1_000) {
  const result = await pool.query(`
    update bench_jobs
    set state = 'running',
        revision = revision + 1,
        lease_owner = $2,
        lease_epoch = lease_epoch + 1,
        lease_until = now() + ($3::text || ' milliseconds')::interval,
        updated_at = now()
    where id = $1 and state = 'queued'
    returning *
  `, [jobId, workerId, leaseMs]);
  return result.rows[0] ?? null;
}

export async function startOrReadAttempt(pool, jobId, workerId, leaseEpoch) {
  return transaction(pool, async (client) => {
    const jobResult = await client.query('select * from bench_jobs where id = $1 for update', [jobId]);
    const job = jobResult.rows[0];
    if (!job) {
      throw new Error(`job ${jobId} not found`);
    }
    assertLease(job, workerId, leaseEpoch);
    if (job.attempt_id) {
      const attempt = (await client.query('select * from bench_attempts where id = $1', [job.attempt_id])).rows[0];
      return { attempt, existing: true };
    }
    const attemptId = randomUUID();
    const attempt = (await client.query(
      "insert into bench_attempts (id, job_id, state) values ($1, $2, 'started') returning *",
      [attemptId, jobId],
    )).rows[0];
    await client.query('update bench_jobs set attempt_id = $1, revision = revision + 1, updated_at = now() where id = $2', [attemptId, jobId]);
    return { attempt, existing: false };
  });
}

export async function persistEvidenceAndComplete(pool, { jobId, attemptId, workerId, leaseEpoch, providerCallId }) {
  return transaction(pool, async (client) => {
    const job = (await client.query('select * from bench_jobs where id = $1 for update', [jobId])).rows[0];
    if (!job) {
      throw new Error(`job ${jobId} not found`);
    }
    assertLease(job, workerId, leaseEpoch);
    const attempt = (await client.query('select * from bench_attempts where id = $1 for update', [attemptId])).rows[0];
    if (!attempt || attempt.state !== 'started') {
      throw new Error(`attempt ${attemptId} is not an active attempt`);
    }
    await client.query(
      'insert into bench_evidence (job_id, attempt_id, provider_call_id, observed_effect) values ($1, $2, $3, true)',
      [jobId, attemptId, providerCallId],
    );
    await client.query("update bench_attempts set state = 'succeeded', terminal_at = now() where id = $1", [attemptId]);
    await client.query(`
      update bench_jobs
      set state = 'succeeded', revision = revision + 1, lease_owner = null, lease_until = null, updated_at = now()
      where id = $1
    `, [jobId]);
  });
}

export async function markExpiredForRecovery(pool) {
  const result = await pool.query(`
    update bench_jobs
    set state = 'recovery_pending', revision = revision + 1, lease_owner = null, lease_until = null, updated_at = now()
    where state = 'running' and lease_until < now()
    returning *
  `);
  return result.rows;
}

export async function recoverUnknownCompletion(pool, jobId) {
  return transaction(pool, async (client) => {
    const job = (await client.query('select * from bench_jobs where id = $1 for update', [jobId])).rows[0];
    if (!job) {
      throw new Error(`job ${jobId} not found`);
    }
    const evidence = job.attempt_id
      ? (await client.query('select * from bench_evidence where attempt_id = $1', [job.attempt_id])).rows[0]
      : null;
    if (evidence) {
      return { classification: 'evidence_present', job };
    }
    if (job.attempt_id) {
      await client.query(
        "update bench_attempts set state = 'unknown_completion', terminal_at = now() where id = $1 and state = 'started'",
        [job.attempt_id],
      );
    }
    const updated = (await client.query(`
      update bench_jobs
      set state = 'blocked_unknown', revision = revision + 1, lease_owner = null, lease_until = null, updated_at = now()
      where id = $1
      returning *
    `, [jobId])).rows[0];
    return { classification: 'unknown_completion', job: updated };
  });
}

export async function unsafeRequeueExpired(pool, jobId) {
  const result = await pool.query(`
    update bench_jobs
    set state = 'queued', revision = revision + 1, updated_at = now()
    where id = $1 and state = 'recovery_pending'
    returning *
  `, [jobId]);
  return result.rows[0] ?? null;
}

export async function forceExpireLease(pool, jobId) {
  const result = await pool.query(`
    update bench_jobs
    set lease_until = now() - interval '1 second', updated_at = now()
    where id = $1 and state = 'running'
    returning *
  `, [jobId]);
  return result.rows[0] ?? null;
}

export async function requestCancel(pool, jobId) {
  const result = await pool.query(`
    update bench_jobs
    set cancel_requested = true,
        state = case when state = 'queued' then 'cancelled' else state end,
        revision = revision + 1,
        updated_at = now()
    where id = $1
    returning *
  `, [jobId]);
  return result.rows[0] ?? null;
}

export async function requestPause(pool, jobId) {
  const result = await pool.query(`
    update bench_jobs
    set pause_requested = true,
        state = case when state = 'queued' then 'paused' else state end,
        revision = revision + 1,
        updated_at = now()
    where id = $1
    returning *
  `, [jobId]);
  return result.rows[0] ?? null;
}

export async function readJob(pool, jobId) {
  return (await pool.query('select * from bench_jobs where id = $1', [jobId])).rows[0] ?? null;
}

export async function readAttempts(pool, jobId) {
  return (await pool.query('select * from bench_attempts where job_id = $1 order by created_at', [jobId])).rows;
}

export async function readEvidence(pool, jobId) {
  return (await pool.query('select * from bench_evidence where job_id = $1 order by id', [jobId])).rows;
}

export async function countRows(pool, table) {
  if (!['bench_jobs', 'bench_attempts', 'bench_evidence', 'bench_deliveries', 'bench_outbox'].includes(table)) {
    throw new Error(`unapproved table ${table}`);
  }
  return Number((await pool.query(`select count(*)::int as count from ${table}`)).rows[0].count);
}
