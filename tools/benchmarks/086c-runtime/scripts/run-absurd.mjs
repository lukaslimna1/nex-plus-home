import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { Absurd } from 'absurd-sdk';
import { writeArtifact } from '../src/artifacts.mjs';
import { LAB, databaseUrl } from '../src/constants.mjs';
import { recreateDatabase } from '../src/db.mjs';
import { createLaboratoryJob, readJob } from '../src/nex-store.mjs';
import { startProviderFixture } from '../src/provider.mjs';
import { run } from '../src/shell.mjs';

const { Pool } = pg;
const candidateDatabase = LAB.candidateDatabases[4];
const queue = 'nex086c_delivery';

async function startWorker({ mode, providerUrl, crashAfterEffect }) {
  const child = fork(new URL('./absurd-child.mjs', import.meta.url), [], {
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
          reject(new Error(`Absurd worker did not ${description}: ${stderr.join('')}${stdout.join('')}`));
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  };
  const ready = await waitForMessage((message) => message.type === 'ready' || message.type === 'error', 20_000, 'become ready');
  if (ready.type === 'error') throw new Error(ready.message);
  return { child, stderr, stdout, waitForMessage };
}

function startTask(worker, payload) {
  worker.child.send({ type: 'start', payload, idempotencyKey: `absurd-run-${randomUUID()}` });
  return worker.waitForMessage((message) => message.type === 'started' || message.type === 'error', 10_000, 'start task');
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
    new Promise((_, reject) => setTimeout(() => reject(new Error('Absurd worker did not shut down')), 10_000)),
  ]);
}

await recreateDatabase(candidateDatabase);
// The official Windows CLI currently shells out to a host `psql`; the host
// intentionally has no psql because PostgreSQL is containerized for this lab.
// Load the exact schema bundled in the official absurdctl release, then apply
// it through the Node PostgreSQL driver to the same disposable database.
const bundledSchema = await run('uvx', [
  '--from', 'absurdctl', 'python', '-c',
  'import absurdctl, sys; sys.stdout.write(absurdctl.BUNDLED_SCHEMA_SQL)',
]);
const schemaPool = new Pool({ connectionString: databaseUrl(candidateDatabase), max: 2 });
try {
  await schemaPool.query(bundledSchema.stdout);
} finally {
  await schemaPool.end();
}
const provider = await startProviderFixture();
const jobPool = new Pool({ connectionString: databaseUrl(LAB.jobDatabase), max: 8 });
const workers = new Set();
const controller = new Absurd({ db: databaseUrl(candidateDatabase), queueName: queue });
const results = [];
try {
  await controller.createQueue(queue);
  const raw = { jobId: `absurd-raw-${randomUUID()}`, effectKey: `absurd-effect-${randomUUID()}`, providerMode: 'non_idempotent' };
  const rawCrashWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: true });
  workers.add(rawCrashWorker);
  await startTask(rawCrashWorker, raw);
  const rawCrash = await awaitEffectAndKill(rawCrashWorker);
  workers.delete(rawCrashWorker);
  assert.deepEqual(await provider.counts(raw.effectKey), { calls: 1, effects: 1 });
  const rawRecoveryStarted = Date.now();
  const rawRecoveryWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(rawRecoveryWorker);
  await awaitMessage(rawRecoveryWorker, 'settled', 15_000);
  const rawRecoveryMs = Date.now() - rawRecoveryStarted;
  assert.deepEqual(await provider.counts(raw.effectKey), { calls: 2, effects: 2 });
  results.push({ id: 'raw-step-crash-recovery-repeats-non-idempotent-effect', passed: true, crash: rawCrash, recoveryMs: rawRecoveryMs, claimTimeoutSeconds: 1 });
  await shutdownWorker(rawRecoveryWorker);
  workers.delete(rawRecoveryWorker);

  const safeJob = await createLaboratoryJob(jobPool, {
    jobId: `absurd-safe-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const safeCrashWorker = await startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: true });
  workers.add(safeCrashWorker);
  await startTask(safeCrashWorker, { jobId: safeJob.jobId });
  const safeCrash = await awaitEffectAndKill(safeCrashWorker);
  workers.delete(safeCrashWorker);
  assert.deepEqual(await provider.counts(safeJob.effectKey), { calls: 1, effects: 1 });
  const safeRecoveryStarted = Date.now();
  const safeRecoveryWorker = await startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(safeRecoveryWorker);
  const safeSettled = await awaitMessage(safeRecoveryWorker, 'settled', 15_000);
  const safeRecoveryMs = Date.now() - safeRecoveryStarted;
  assert.equal(safeSettled.result.status, 'blocked_unknown');
  assert.equal((await readJob(jobPool, safeJob.jobId)).state, 'blocked_unknown');
  assert.deepEqual(await provider.counts(safeJob.effectKey), { calls: 1, effects: 1 });
  results.push({ id: 'nex-safe-boundary-step-recovery-blocks-unknown-completion', passed: true, crash: safeCrash, recoveryMs: safeRecoveryMs, claimTimeoutSeconds: 1 });
  await shutdownWorker(safeRecoveryWorker);
  workers.delete(safeRecoveryWorker);

  const beforeWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(beforeWorker);
  const beforeEvent = `absurd-before-${randomUUID()}`;
  await startTask(beforeWorker, { kind: 'wait-before', eventName: beforeEvent });
  await awaitMessage(beforeWorker, 'pre-wait');
  await controller.emitEvent(beforeEvent, 'persisted-before-waiter');
  const beforeSettled = await awaitMessage(beforeWorker, 'settled', 10_000);
  assert.equal(beforeSettled.result.received, 'persisted-before-waiter');
  results.push({ id: 'event-before-waiter-is-persisted', passed: true });
  await shutdownWorker(beforeWorker);
  workers.delete(beforeWorker);

  const afterWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(afterWorker);
  const afterEvent = `absurd-after-${randomUUID()}`;
  await startTask(afterWorker, { kind: 'wait-after', eventName: afterEvent });
  await awaitMessage(afterWorker, 'waiting');
  await controller.emitEvent(afterEvent, 'sent-after-waiter');
  const afterSettled = await awaitMessage(afterWorker, 'settled', 10_000);
  assert.equal(afterSettled.result.received, 'sent-after-waiter');
  results.push({ id: 'event-after-waiter-delivers', passed: true });
  await shutdownWorker(afterWorker);
  workers.delete(afterWorker);

  const sleepWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  workers.add(sleepWorker);
  const sleepStarted = Date.now();
  await startTask(sleepWorker, { kind: 'sleep' });
  await awaitMessage(sleepWorker, 'settled', 10_000);
  assert.ok(Date.now() - sleepStarted >= 250);
  results.push({ id: 'durable-sleep', passed: true });
  await shutdownWorker(sleepWorker);
  workers.delete(sleepWorker);

  await writeArtifact('absurd-results.json', {
    completedAt: new Date().toISOString(),
    version: '0.5.0',
    schemaVersion: '0.5.0',
    initializer: 'official absurdctl bundled schema applied through node-postgres; absurdctl CLI requires unavailable host psql on Windows',
    results,
  });
  console.log(JSON.stringify({ runner: 'absurd', schemaVersion: '0.5.0', results }, null, 2));
} finally {
  await Promise.allSettled([...workers].map(shutdownWorker));
  await controller.close().catch(() => undefined);
  await jobPool.end();
  await provider.close();
}
