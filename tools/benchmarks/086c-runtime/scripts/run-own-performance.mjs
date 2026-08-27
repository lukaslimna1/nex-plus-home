import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeArtifact } from '../src/artifacts.mjs';
import { LAB } from '../src/constants.mjs';
import { makePool } from '../src/db.mjs';
import { createLaboratoryJob } from '../src/nex-store.mjs';
import { NexSafeOwnRunner } from '../src/own-runner.mjs';
import { startProviderFixture } from '../src/provider.mjs';
import { sleep } from '../src/shell.mjs';

async function eventually(assertion, { timeoutMs = 120_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  throw lastError ?? new Error('performance run timed out');
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return Number(sorted[index].toFixed(2));
}

function summarize(values) {
  return {
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: Number(Math.max(...values).toFixed(2)),
  };
}

async function runScale({ pool, providerUrl, jobs, workers }) {
  const runners = Array.from({ length: workers }, (_, index) => new NexSafeOwnRunner({
    pool,
    providerUrl,
    workerId: `performance-${jobs}-${workers}-${index + 1}`,
    leaseMs: 2_000,
    pollMs: 10,
  }));
  await Promise.all(runners.map((runner) => runner.start()));
  const startedAt = performance.now();
  let jobsCreated;
  try {
    jobsCreated = await Promise.all(Array.from({ length: jobs }, (_, index) => createLaboratoryJob(pool, {
      jobId: `performance-${jobs}-${workers}-${index}-${randomUUID()}`,
      providerMode: 'idempotent',
    })));
    const jobIds = jobsCreated.map((job) => job.jobId);
    await eventually(async () => {
      const completed = Number((await pool.query(
        "select count(*)::int as count from bench_jobs where id = any($1::text[]) and state = 'succeeded'",
        [jobIds],
      )).rows[0].count);
      assert.equal(completed, jobs);
    });
    const elapsedMs = performance.now() - startedAt;
    const rows = (await pool.query(
      `select extract(epoch from attempt.created_at - job.created_at) * 1000 as enqueue_to_attempt_ms,
              extract(epoch from evidence.created_at - job.created_at) * 1000 as enqueue_to_evidence_ms
       from bench_jobs job
       join bench_attempts attempt on attempt.job_id = job.id
       join bench_evidence evidence on evidence.job_id = job.id
       where job.id = any($1::text[])`,
      [jobIds],
    )).rows;
    assert.equal(rows.length, jobs);
    return {
      jobs,
      workers,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      jobsPerSecond: Number((jobs / (elapsedMs / 1_000)).toFixed(2)),
      enqueueToAttempt: summarize(rows.map((row) => Number(row.enqueue_to_attempt_ms))),
      enqueueToEvidence: summarize(rows.map((row) => Number(row.enqueue_to_evidence_ms))),
      qualification: 'Own-runner-only laboratory baseline; loopback HTTP provider and Docker PostgreSQL are included, so this is not a cross-runtime throughput ranking.',
    };
  } finally {
    await Promise.all(runners.map((runner) => runner.stop()));
  }
}

const pool = makePool(LAB.jobDatabase);
const provider = await startProviderFixture();
try {
  const results = [];
  for (const configuration of [
    { jobs: 100, workers: 1 },
    { jobs: 100, workers: 5 },
    { jobs: 1_000, workers: 5 },
    { jobs: 10_000, workers: 5 },
  ]) {
    results.push(await runScale({ pool, providerUrl: provider.url, ...configuration }));
  }
  await writeArtifact('own-performance-results.json', {
    completedAt: new Date().toISOString(),
    runner: 'own-postgresql-runner',
    results,
  });
  console.log(JSON.stringify({ runner: 'own-postgresql-runner', results }, null, 2));
} finally {
  await provider.close();
  await pool.end();
}
