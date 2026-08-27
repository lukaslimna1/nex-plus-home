import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { OpenWorkflow } from 'openworkflow';
import { BackendPostgres } from 'openworkflow/postgres';
import { writeArtifact } from '../src/artifacts.mjs';
import { LAB, databaseUrl } from '../src/constants.mjs';
import { recreateDatabase } from '../src/db.mjs';
import { createLaboratoryJob, readJob } from '../src/nex-store.mjs';
import { startProviderFixture } from '../src/provider.mjs';

const { Pool } = pg;
const candidateDatabase = LAB.candidateDatabases[3];
const schema = 'nex086c_openworkflow';

async function startWorker({ mode, providerUrl, crashAfterEffect }) {
  const child = fork(new URL('./openworkflow-child.mjs', import.meta.url), [], {
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
          reject(new Error(`OpenWorkflow worker did not ${description}: ${stderr.join('')}${stdout.join('')}`));
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  };
  const ready = await waitForMessage((message) => message.type === 'ready' || message.type === 'error', 20_000, 'become ready');
  if (ready.type === 'error') throw new Error(ready.message);
  return { child, stderr, stdout, waitForMessage };
}

function startWorkflow(worker, payload) {
  const idempotencyKey = `openworkflow-run-${randomUUID()}`;
  worker.child.send({ type: 'start', payload, idempotencyKey });
  return worker.waitForMessage((message) => message.type === 'started' || message.type === 'error', 10_000, 'start workflow');
}

async function awaitEffectAndKill(worker) {
  const message = await worker.waitForMessage((value) => value.type === 'effect-applied' || value.type === 'error', 10_000, 'apply the effect');
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
    new Promise((_, reject) => setTimeout(() => reject(new Error('OpenWorkflow worker did not shut down')), 10_000)),
  ]);
}

await recreateDatabase(candidateDatabase);
const provider = await startProviderFixture();
const jobPool = new Pool({ connectionString: databaseUrl(LAB.jobDatabase), max: 8 });
const workers = new Set();
let controllerBackend;
const results = [];
try {
  const raw = { jobId: `openworkflow-raw-${randomUUID()}`, effectKey: `openworkflow-effect-${randomUUID()}`, providerMode: 'non_idempotent' };
  const rawCrashWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: true });
  workers.add(rawCrashWorker);
  await startWorkflow(rawCrashWorker, raw);
  const rawCrash = await awaitEffectAndKill(rawCrashWorker);
  workers.delete(rawCrashWorker);
  assert.deepEqual(await provider.counts(raw.effectKey), { calls: 1, effects: 1 });
  const rawRecoveryStarted = Date.now();
  const rawRecoveryWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(rawRecoveryWorker);
  await awaitMessage(rawRecoveryWorker, 'settled', 45_000);
  const rawRecoveryMs = Date.now() - rawRecoveryStarted;
  assert.ok(rawRecoveryMs >= 25_000, `expected default 30-second lease recovery, got ${rawRecoveryMs}ms`);
  assert.deepEqual(await provider.counts(raw.effectKey), { calls: 2, effects: 2 });
  results.push({
    id: 'raw-step-crash-recovery-repeats-non-idempotent-effect',
    passed: true,
    crash: rawCrash,
    recoveryMs: rawRecoveryMs,
    defaultLease: '30 seconds',
  });
  await shutdownWorker(rawRecoveryWorker);
  workers.delete(rawRecoveryWorker);

  const safeJob = await createLaboratoryJob(jobPool, {
    jobId: `openworkflow-safe-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const safeCrashWorker = await startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: true });
  workers.add(safeCrashWorker);
  await startWorkflow(safeCrashWorker, { jobId: safeJob.jobId });
  const safeCrash = await awaitEffectAndKill(safeCrashWorker);
  workers.delete(safeCrashWorker);
  assert.deepEqual(await provider.counts(safeJob.effectKey), { calls: 1, effects: 1 });
  const safeRecoveryStarted = Date.now();
  const safeRecoveryWorker = await startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(safeRecoveryWorker);
  const safeSettled = await awaitMessage(safeRecoveryWorker, 'settled', 45_000);
  const safeRecoveryMs = Date.now() - safeRecoveryStarted;
  assert.ok(safeRecoveryMs >= 25_000, `expected default 30-second lease recovery, got ${safeRecoveryMs}ms`);
  assert.equal(safeSettled.result.status, 'blocked_unknown');
  assert.equal((await readJob(jobPool, safeJob.jobId)).state, 'blocked_unknown');
  assert.deepEqual(await provider.counts(safeJob.effectKey), { calls: 1, effects: 1 });
  results.push({
    id: 'nex-safe-boundary-step-recovery-blocks-unknown-completion',
    passed: true,
    crash: safeCrash,
    recoveryMs: safeRecoveryMs,
    defaultLease: '30 seconds',
  });
  await shutdownWorker(safeRecoveryWorker);
  workers.delete(safeRecoveryWorker);

  controllerBackend = await BackendPostgres.connect(databaseUrl(candidateDatabase), {
    schema,
    namespaceId: 'nex086c-openworkflow-benchmark',
    runMigrations: false,
  });
  const controller = new OpenWorkflow({ backend: controllerBackend });

  const signalBeforeWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(signalBeforeWorker);
  await startWorkflow(signalBeforeWorker, { kind: 'wait-before', signal: 'approval-before' });
  await awaitMessage(signalBeforeWorker, 'pre-wait');
  const dropped = await controller.sendSignal({ signal: 'approval-before', data: 'sent-before-waiter' });
  assert.deepEqual(dropped.workflowRunIds, []);
  const beforeSettled = await awaitMessage(signalBeforeWorker, 'settled', 10_000);
  assert.equal(beforeSettled.result.received, null);
  results.push({ id: 'signal-before-waiter-is-dropped', passed: true, deliveryIds: dropped.workflowRunIds });
  await shutdownWorker(signalBeforeWorker);
  workers.delete(signalBeforeWorker);

  const signalAfterWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(signalAfterWorker);
  await startWorkflow(signalAfterWorker, { kind: 'wait-after', signal: 'approval-after' });
  await awaitMessage(signalAfterWorker, 'waiting');
  const delivered = await controller.sendSignal({ signal: 'approval-after', data: 'sent-after-waiter', idempotencyKey: 'openworkflow-after-signal' });
  assert.equal(delivered.workflowRunIds.length, 1);
  const afterSettled = await awaitMessage(signalAfterWorker, 'settled', 10_000);
  assert.equal(afterSettled.result.received, 'sent-after-waiter');
  results.push({ id: 'signal-after-waiter-delivers', passed: true, deliveryIds: delivered.workflowRunIds });
  await shutdownWorker(signalAfterWorker);
  workers.delete(signalAfterWorker);

  const sleepWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(sleepWorker);
  const sleepStarted = Date.now();
  await startWorkflow(sleepWorker, { kind: 'sleep' });
  await awaitMessage(sleepWorker, 'settled', 10_000);
  assert.ok(Date.now() - sleepStarted >= 250);
  results.push({ id: 'durable-sleep', passed: true });
  await shutdownWorker(sleepWorker);
  workers.delete(sleepWorker);

  await writeArtifact('openworkflow-results.json', {
    completedAt: new Date().toISOString(),
    version: '0.9.2',
    schema,
    results,
  });
  console.log(JSON.stringify({ runner: 'openworkflow', results }, null, 2));
} finally {
  await Promise.allSettled([...workers].map(shutdownWorker));
  await controllerBackend?.stop().catch(() => undefined);
  await jobPool.end();
  await provider.close();
}
