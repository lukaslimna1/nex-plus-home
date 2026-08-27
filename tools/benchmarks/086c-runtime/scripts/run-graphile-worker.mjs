import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { makeWorkerUtils, runMigrations } from 'graphile-worker';
import { writeArtifact } from '../src/artifacts.mjs';
import { LAB, databaseUrl } from '../src/constants.mjs';
import { createLaboratoryJob, createLaboratoryJobInTransaction, readJob } from '../src/nex-store.mjs';
import { startProviderFixture } from '../src/provider.mjs';
import { sleep } from '../src/shell.mjs';

const { Pool } = pg;
const schema = 'nex086c_graphile';
const workerOptions = {
  connectionString: databaseUrl(LAB.jobDatabase),
  schema,
  pollInterval: 100,
  concurrency: 1,
  maxPoolSize: 4,
  minResetLockedInterval: 200,
  maxResetLockedInterval: 200,
  noHandleSignals: true,
};

async function startWorker({ mode, providerUrl, crashAfterEffect }) {
  const child = fork(new URL('./graphile-worker-child.mjs', import.meta.url), [], {
    env: {
      ...process.env,
      NEX086C_MODE: mode,
      NEX086C_PROVIDER_URL: providerUrl,
      NEX086C_CRASH_AFTER_EFFECT: crashAfterEffect ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const stderr = [];
  const messages = [];
  const waiters = new Set();
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  child.on('message', (value) => {
    messages.push(value);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(value)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(value);
      }
    }
  });
  const waitForMessage = (predicate, timeoutMs, description) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Graphile Worker did not ${description}: ${stderr.join('')}`));
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  };
  const ready = await waitForMessage((message) => message.type === 'ready' || message.type === 'error', 15_000, 'become ready');
  if (ready.type === 'error') throw new Error(ready.message);
  return { child, stderr, waitForMessage };
}

async function awaitEffectAndKill(worker) {
  const message = await worker.waitForMessage((value) => value.type === 'effect-applied' || value.type === 'error', 10_000, 'apply the effect');
  if (message.type === 'error') throw new Error(message.message);
  worker.child.kill('SIGKILL');
  const [code, signal] = await once(worker.child, 'exit');
  assert.ok(signal || code !== 0);
  return { message, exit: { code, signal }, stderr: worker.stderr.join('') };
}

async function awaitSettlement(worker) {
  const message = await worker.waitForMessage((value) => value.type === 'settled' || value.type === 'error', 15_000, 'settle');
  if (message.type === 'error') throw new Error(message.message);
  await once(worker.child, 'exit');
  return message;
}

async function ageLockForLaboratoryRecovery(pool, predicateValue) {
  const before = await pool.query(
    `select locked_at, attempts from ${schema}._private_jobs where payload->>'effectKey' = $1 or payload->>'jobId' = $1`,
    [predicateValue],
  );
  assert.equal(before.rowCount, 1);
  assert.ok(before.rows[0].locked_at, 'Graphile Worker should persist a lock after the killed process');
  await pool.query(
    `update ${schema}._private_jobs
     set locked_at = now() - interval '4 hours 1 second'
     where payload->>'effectKey' = $1 or payload->>'jobId' = $1`,
    [predicateValue],
  );
  return { lockedAt: before.rows[0].locked_at, attempts: before.rows[0].attempts };
}

const provider = await startProviderFixture();
const jobPool = new Pool({ connectionString: databaseUrl(LAB.jobDatabase), max: 8 });
const utils = await makeWorkerUtils(workerOptions);
const results = [];
try {
  await runMigrations(workerOptions);

  const transactionClient = await jobPool.connect();
  const rollbackJobId = `graphile-rollback-${randomUUID()}`;
  try {
    await transactionClient.query('begin');
    await createLaboratoryJobInTransaction(transactionClient, { jobId: rollbackJobId });
    await transactionClient.query(
      `select * from ${schema}.add_job($1, $2::json, null, null, 1, null, null, null, 'replace')`,
      ['nex086c_delivery', JSON.stringify({ jobId: rollbackJobId })],
    );
    await transactionClient.query('rollback');
  } finally {
    transactionClient.release();
  }
  assert.equal((await jobPool.query('select count(*)::int as count from bench_jobs where id = $1', [rollbackJobId])).rows[0].count, 0);
  assert.equal((await jobPool.query(`select count(*)::int as count from ${schema}._private_jobs where payload->>'jobId' = $1`, [rollbackJobId])).rows[0].count, 0);
  results.push({ id: 'transactional-add_job-rollback-same-postgres-transaction', passed: true });

  const raw = { jobId: `graphile-raw-${randomUUID()}`, effectKey: `graphile-effect-${randomUUID()}`, providerMode: 'non_idempotent' };
  const rawCrashWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: true });
  await utils.addJob('nex086c_delivery', raw, { maxAttempts: 2 });
  const rawCrash = await awaitEffectAndKill(rawCrashWorker);
  assert.deepEqual(await provider.counts(raw.effectKey), { calls: 1, effects: 1 });
  await sleep(350);
  const rawLock = await ageLockForLaboratoryRecovery(jobPool, raw.effectKey);
  const rawRecoveryWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  await awaitSettlement(rawRecoveryWorker);
  assert.deepEqual(await provider.counts(raw.effectKey), { calls: 2, effects: 2 });
  results.push({
    id: 'raw-engine-crash-redelivery-duplicates-non-idempotent-effect',
    passed: true,
    crash: rawCrash,
    observedLockedJob: rawLock,
    automaticRecoveryLockThreshold: '4 hours (hard-coded by OSS 0.17.3 reset query)',
    laboratoryRecovery: 'locked_at deliberately aged past threshold',
  });

  const safeJob = await createLaboratoryJob(jobPool, {
    jobId: `graphile-safe-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const safeCrashWorker = await startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: true });
  await utils.addJob('nex086c_delivery', { jobId: safeJob.jobId }, { maxAttempts: 2 });
  const safeCrash = await awaitEffectAndKill(safeCrashWorker);
  assert.deepEqual(await provider.counts(safeJob.effectKey), { calls: 1, effects: 1 });
  await sleep(350);
  const safeLock = await ageLockForLaboratoryRecovery(jobPool, safeJob.jobId);
  const safeRecoveryWorker = await startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: false });
  const safeSettlement = await awaitSettlement(safeRecoveryWorker);
  assert.equal(safeSettlement.result.status, 'blocked_unknown');
  assert.equal((await readJob(jobPool, safeJob.jobId)).state, 'blocked_unknown');
  assert.deepEqual(await provider.counts(safeJob.effectKey), { calls: 1, effects: 1 });
  results.push({
    id: 'nex-safe-boundary-crash-redelivery-blocks-unknown-completion',
    passed: true,
    crash: safeCrash,
    observedLockedJob: safeLock,
    laboratoryRecovery: 'locked_at deliberately aged past Graphile OSS 4-hour threshold',
  });

  const duplicateWakeJob = await createLaboratoryJob(jobPool, {
    jobId: `graphile-duplicate-wake-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const duplicateWakeWorkers = await Promise.all([
    startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: false }),
    startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: false }),
  ]);
  await Promise.all([
    utils.addJob('nex086c_delivery', { jobId: duplicateWakeJob.jobId }, { maxAttempts: 1 }),
    utils.addJob('nex086c_delivery', { jobId: duplicateWakeJob.jobId }, { maxAttempts: 1 }),
  ]);
  const duplicateWakeSettlements = await Promise.all(duplicateWakeWorkers.map(awaitSettlement));
  assert.equal((await readJob(jobPool, duplicateWakeJob.jobId)).state, 'succeeded');
  assert.deepEqual(await provider.counts(duplicateWakeJob.effectKey), { calls: 1, effects: 1 });
  assert.equal(duplicateWakeSettlements.filter((settlement) => settlement.result.status === 'in_flight_elsewhere').length, 1);
  results.push({
    id: 'multi-worker-duplicate-wake-2-nex-safe',
    passed: true,
    workers: 2,
    duplicateDeliveries: 2,
    outcomes: duplicateWakeSettlements.map((settlement) => settlement.result.status),
  });

  const delayedStarted = Date.now();
  let delayedSettled = false;
  const delayedWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  await utils.addJob('nex086c_delivery', {
    jobId: `graphile-delayed-${randomUUID()}`,
    effectKey: `graphile-delayed-effect-${randomUUID()}`,
    providerMode: 'idempotent',
  }, { runAt: new Date(Date.now() + 300), maxAttempts: 1 });
  await awaitSettlement(delayedWorker);
  delayedSettled = true;
  assert.ok(Date.now() - delayedStarted >= 250);
  results.push({ id: 'delayed-job', passed: delayedSettled });

  await writeArtifact('graphile-worker-results.json', {
    completedAt: new Date().toISOString(),
    version: '0.17.3',
    schema,
    results,
  });
  console.log(JSON.stringify({ runner: 'graphile-worker', results }, null, 2));
} finally {
  await utils.release().catch(() => undefined);
  await jobPool.end();
  await provider.close();
}
