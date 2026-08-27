import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeArtifact } from '../src/artifacts.mjs';
import { LAB } from '../src/constants.mjs';
import { makePool, recreateDatabase } from '../src/db.mjs';
import { createLaboratoryJob, readJob } from '../src/nex-store.mjs';
import { createPayloadFixture } from '../src/payload-fixture.mjs';
import { startProviderFixture } from '../src/provider.mjs';
import { sleep } from '../src/shell.mjs';

// Payload starts a development HMR socket unless this is explicit. The lab has
// no Next.js dev server and must not retain a process solely for that socket.
process.env.NODE_ENV = 'test';
process.env.DISABLE_PAYLOAD_HMR = 'true';

async function startWorker({ mode, providerUrl, crashAfterEffect }) {
  const child = fork(new URL('./payload-child.mjs', import.meta.url), [], {
    env: {
      ...process.env,
      NEX086C_MODE: mode,
      NEX086C_PROVIDER_URL: providerUrl,
      NEX086C_CRASH_AFTER_EFFECT: crashAfterEffect ? '1' : '0',
      NODE_ENV: 'test',
      DISABLE_PAYLOAD_HMR: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const stderr = [];
  const stdout = [];
  const messages = [];
  const waiters = new Set();
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
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
          reject(new Error(`Payload worker did not ${description}: ${stderr.join('')}${stdout.join('')}`));
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  };
  const ready = await waitForMessage((message) => message.type === 'ready' || message.type === 'error', 30_000, 'become ready');
  if (ready.type === 'error') throw new Error(ready.message);
  return { child, stderr, stdout, waitForMessage };
}

async function awaitEffectAndKill(worker) {
  const message = await worker.waitForMessage((value) => value.type === 'effect-applied' || value.type === 'error', 15_000, 'apply the effect');
  if (message.type === 'error') throw new Error(message.message);
  worker.child.kill('SIGKILL');
  const [code, signal] = await once(worker.child, 'exit');
  assert.ok(signal || code !== 0);
  return { message, exit: { code, signal }, stderr: worker.stderr.join(''), stdout: worker.stdout.join('') };
}

async function awaitMessage(worker, type, timeoutMs = 15_000) {
  const message = await worker.waitForMessage((value) => value.type === type || value.type === 'error', timeoutMs, type);
  if (message.type === 'error') throw new Error(message.message);
  return message;
}

async function shutdownWorker(worker) {
  if (worker.child.exitCode !== null || worker.child.killed) return;
  worker.child.send({ type: 'shutdown' });
  await Promise.race([
    once(worker.child, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Payload worker did not shut down')), 10_000)),
  ]);
}

async function queuePayload({ payload, providerUrl, workers, waitUntil }) {
  const worker = await startWorker({ mode: 'raw', providerUrl, crashAfterEffect: false });
  workers.add(worker);
  const requestId = randomUUID();
  worker.child.send({ type: 'queue', payload, waitUntil, requestId });
  const queued = await worker.waitForMessage(
    (message) => (message.type === 'queued' && message.requestId === requestId) || message.type === 'error',
    15_000,
    'queue a job',
  );
  if (queued.type === 'error') throw new Error(queued.message);
  await shutdownWorker(worker);
  workers.delete(worker);
  return queued.jobId;
}

async function cancelPayload({ jobId, providerUrl, workers }) {
  const worker = await startWorker({ mode: 'raw', providerUrl, crashAfterEffect: false });
  workers.add(worker);
  const requestId = randomUUID();
  worker.child.send({ type: 'cancel', jobId, requestId });
  const cancelled = await worker.waitForMessage(
    (message) => (message.type === 'cancelled' && message.requestId === requestId) || message.type === 'error',
    15_000,
    'cancel the job',
  );
  if (cancelled.type === 'error') throw new Error(cancelled.message);
  await shutdownWorker(worker);
  workers.delete(worker);
}

async function readPayloadJob(pool, id) {
  return (await pool.query(
    `select id::text, processing, completed_at, has_error, wait_until, total_tried
     from payload_jobs
     where id = $1`,
    [id],
  )).rows[0] ?? null;
}

await recreateDatabase(LAB.candidateDatabases[5]);
const provider = await startProviderFixture();
const jobPool = makePool(LAB.jobDatabase);
const payloadPool = makePool(LAB.candidateDatabases[5]);
const workers = new Set();
const results = [];
try {
  // Bootstrap the isolated Payload schema once. This never reads the NEX config
  // or production DATABASE_URL, and uses the exact root installation (3.88.0).
  const bootstrap = await createPayloadFixture({ mode: 'raw', providerUrl: provider.url, push: true });
  await bootstrap.close();

  const raw = { jobId: `payload-raw-${randomUUID()}`, effectKey: `payload-effect-${randomUUID()}`, providerMode: 'non_idempotent' };
  const rawCrashWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: true });
  workers.add(rawCrashWorker);
  rawCrashWorker.child.send({ type: 'queue-and-run', payload: raw });
  const rawCrash = await awaitEffectAndKill(rawCrashWorker);
  workers.delete(rawCrashWorker);
  assert.deepEqual(await provider.counts(raw.effectKey), { calls: 1, effects: 1 });
  const rawJobId = (await rawCrashWorker.waitForMessage((message) => message.type === 'queued', 1_000, 'queue raw job')).jobId;
  const rawJob = await readPayloadJob(payloadPool, rawJobId);
  assert.equal(rawJob.processing, true);

  const rawRestartWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(rawRestartWorker);
  rawRestartWorker.child.send({ type: 'run' });
  const noRecovery = await awaitMessage(rawRestartWorker, 'run-finished', 10_000);
  assert.equal(noRecovery.result.noJobsRemaining, true);
  assert.deepEqual(await provider.counts(raw.effectKey), { calls: 1, effects: 1 });
  results.push({
    id: 'worker-kill-leaves-processing-job-stuck-after-restart',
    passed: true,
    crash: rawCrash,
    rawJobId,
    payloadProcessing: rawJob.processing,
    restartRunResult: noRecovery.result,
  });
  await shutdownWorker(rawRestartWorker);
  workers.delete(rawRestartWorker);

  const safeJob = await createLaboratoryJob(jobPool, {
    jobId: `payload-safe-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const safeCrashWorker = await startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: true });
  workers.add(safeCrashWorker);
  safeCrashWorker.child.send({ type: 'queue-and-run', payload: { jobId: safeJob.jobId } });
  const safeCrash = await awaitEffectAndKill(safeCrashWorker);
  workers.delete(safeCrashWorker);
  assert.deepEqual(await provider.counts(safeJob.effectKey), { calls: 1, effects: 1 });
  const safePayloadJobId = (await safeCrashWorker.waitForMessage((message) => message.type === 'queued', 1_000, 'queue safe job')).jobId;
  const safeStuckJob = await readPayloadJob(payloadPool, safePayloadJobId);
  assert.equal(safeStuckJob.processing, true);

  // Payload 3.88.0 has no lease/reaper path in the tested local runner. This is
  // deliberately an operator/reaper simulation, not an assertion of native recovery.
  await sleep(260);
  await payloadPool.query('update payload_jobs set processing = false, updated_at = now() where id = $1', [safePayloadJobId]);
  const safeRecoveryWorker = await startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(safeRecoveryWorker);
  safeRecoveryWorker.child.send({ type: 'run' });
  const safeSettlement = await awaitMessage(safeRecoveryWorker, 'settled', 15_000);
  assert.equal(safeSettlement.result.status, 'blocked_unknown');
  assert.equal((await readJob(jobPool, safeJob.jobId)).state, 'blocked_unknown');
  assert.deepEqual(await provider.counts(safeJob.effectKey), { calls: 1, effects: 1 });
  results.push({
    id: 'nex-safe-boundary-manual-requeue-blocks-unknown-completion',
    passed: true,
    crash: safeCrash,
    payloadJobId: safePayloadJobId,
    recoveryQualification: 'manual processing=false operator/reaper simulation; not native Payload recovery',
  });
  await shutdownWorker(safeRecoveryWorker);
  workers.delete(safeRecoveryWorker);

  const delayed = {
    jobId: `payload-delayed-${randomUUID()}`,
    effectKey: `payload-delayed-effect-${randomUUID()}`,
    providerMode: 'idempotent',
  };
  const delayedDueAt = Date.now() + 6_000;
  const delayedJobId = await queuePayload({
    payload: delayed,
    providerUrl: provider.url,
    workers,
    waitUntil: new Date(delayedDueAt).toISOString(),
  });
  const earlyWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(earlyWorker);
  earlyWorker.child.send({ type: 'run' });
  const earlyRun = await awaitMessage(earlyWorker, 'run-finished', 10_000);
  assert.equal(earlyRun.result.noJobsRemaining, true);
  assert.deepEqual(await provider.counts(delayed.effectKey), { calls: 0, effects: 0 });
  await shutdownWorker(earlyWorker);
  workers.delete(earlyWorker);
  await sleep(Math.max(0, delayedDueAt - Date.now() + 200));
  const delayedWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(delayedWorker);
  delayedWorker.child.send({ type: 'run' });
  await awaitMessage(delayedWorker, 'settled', 15_000);
  assert.deepEqual(await provider.counts(delayed.effectKey), { calls: 1, effects: 1 });
  results.push({ id: 'delayed-job', passed: true, payloadJobId: delayedJobId });
  await shutdownWorker(delayedWorker);
  workers.delete(delayedWorker);

  const cancelled = {
    jobId: `payload-cancel-${randomUUID()}`,
    effectKey: `payload-cancel-effect-${randomUUID()}`,
    providerMode: 'non_idempotent',
  };
  const cancelledJobId = await queuePayload({ payload: cancelled, providerUrl: provider.url, workers });
  await cancelPayload({ jobId: cancelledJobId, providerUrl: provider.url, workers });
  const cancelWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(cancelWorker);
  cancelWorker.child.send({ type: 'run' });
  const cancelRun = await awaitMessage(cancelWorker, 'run-finished', 10_000);
  assert.equal(cancelRun.result.noJobsRemaining, true);
  assert.deepEqual(await provider.counts(cancelled.effectKey), { calls: 0, effects: 0 });
  results.push({ id: 'cancel-before-execution', passed: true, payloadJobId: cancelledJobId });
  await shutdownWorker(cancelWorker);
  workers.delete(cancelWorker);

  const concurrent = {
    jobId: `payload-concurrent-${randomUUID()}`,
    effectKey: `payload-concurrent-effect-${randomUUID()}`,
    providerMode: 'non_idempotent',
  };
  const concurrentJobId = await queuePayload({ payload: concurrent, providerUrl: provider.url, workers });
  const concurrentWorkers = await Promise.all(Array.from({ length: 5 }, () => startWorker({
    mode: 'raw',
    providerUrl: provider.url,
    crashAfterEffect: false,
  })));
  concurrentWorkers.forEach((worker) => workers.add(worker));
  for (const worker of concurrentWorkers) worker.child.send({ type: 'run' });
  await Promise.all(concurrentWorkers.map((worker) => awaitMessage(worker, 'run-finished', 15_000)));
  const concurrentCounts = await provider.counts(concurrent.effectKey);
  assert.ok(concurrentCounts.effects >= 1);
  const duplicateObserved = concurrentCounts.effects > 1;
  results.push({
    id: 'multi-worker-race-5',
    passed: true,
    payloadJobId: concurrentJobId,
    workerCount: 5,
    providerCounts: concurrentCounts,
    duplicateObserved,
    qualification: duplicateObserved
      ? 'duplicate external mutation reproduced in this run'
      : 'no duplicate reproduced in this run; exact-source audit still finds non-atomic find-then-update claim path',
  });
  await Promise.all(concurrentWorkers.map(shutdownWorker));
  concurrentWorkers.forEach((worker) => workers.delete(worker));

  const finalPayloadJobCount = Number((await payloadPool.query('select count(*)::int as count from payload_jobs')).rows[0].count);
  await writeArtifact('payload-results.json', {
    completedAt: new Date().toISOString(),
    version: '3.88.0',
    candidateDatabase: LAB.candidateDatabases[5],
    sourceAudit: {
      claimPath: 'runJobs filters processing=false then updateJobs performs findMany followed by per-job upsert',
      leaseColumnsObserved: false,
      nativeCrashReaperObserved: false,
    },
    finalPayloadJobCount,
    results,
  });
  console.log(JSON.stringify({ runner: 'payload-3.88.0', results }, null, 2));
} finally {
  await Promise.allSettled([...workers].map(shutdownWorker));
  await payloadPool.end();
  await jobPool.end();
  await provider.close();
}
