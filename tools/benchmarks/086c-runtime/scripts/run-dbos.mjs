import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { writeArtifact } from '../src/artifacts.mjs';
import { LAB, databaseUrl } from '../src/constants.mjs';
import { recreateDatabase } from '../src/db.mjs';
import { createLaboratoryJob, readJob } from '../src/nex-store.mjs';
import { startProviderFixture } from '../src/provider.mjs';

const { Pool } = pg;
const candidateDatabase = LAB.candidateDatabases[2];
const applicationName = 'nex086c_dbos_benchmark';
const queueName = 'nex086c_delivery';

async function startWorker({ mode, providerUrl, crashAfterEffect }) {
  const child = fork(new URL('./dbos-child.mjs', import.meta.url), [], {
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
          reject(new Error(`DBOS worker did not ${description}: ${stderr.join('')}${stdout.join('')}`));
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  };
  const ready = await waitForMessage((message) => message.type === 'ready' || message.type === 'error', 30_000, 'become ready');
  if (ready.type === 'error') throw new Error(ready.message);
  return { child, stderr, stdout, waitForMessage };
}

function startWorkflow(worker, workflowId, payload) {
  worker.child.send({ type: 'start', workflowId, payload });
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
    new Promise((_, reject) => setTimeout(() => reject(new Error('DBOS worker did not shut down')), 10_000)),
  ]);
}

await recreateDatabase(candidateDatabase);
const provider = await startProviderFixture();
const jobPool = new Pool({ connectionString: databaseUrl(LAB.jobDatabase), max: 8 });
const results = [];
let client;
try {
  const raw = { jobId: `dbos-raw-${randomUUID()}`, effectKey: `dbos-effect-${randomUUID()}`, providerMode: 'non_idempotent' };
  const rawCrashWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: true });
  const rawWorkflowId = `dbos-raw-${randomUUID()}`;
  startWorkflow(rawCrashWorker, rawWorkflowId, raw);
  const rawCrash = await awaitEffectAndKill(rawCrashWorker);
  assert.deepEqual(await provider.counts(raw.effectKey), { calls: 1, effects: 1 });
  const rawRecoveryWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  await awaitMessage(rawRecoveryWorker, 'settled', 30_000);
  assert.deepEqual(await provider.counts(raw.effectKey), { calls: 2, effects: 2 });
  results.push({ id: 'raw-step-crash-recovery-repeats-non-idempotent-effect', passed: true, crash: rawCrash });
  await shutdownWorker(rawRecoveryWorker);

  const safeJob = await createLaboratoryJob(jobPool, {
    jobId: `dbos-safe-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const safeCrashWorker = await startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: true });
  const safeWorkflowId = `dbos-safe-${randomUUID()}`;
  startWorkflow(safeCrashWorker, safeWorkflowId, { jobId: safeJob.jobId });
  const safeCrash = await awaitEffectAndKill(safeCrashWorker);
  assert.deepEqual(await provider.counts(safeJob.effectKey), { calls: 1, effects: 1 });
  const safeRecoveryWorker = await startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: false });
  const safeSettled = await awaitMessage(safeRecoveryWorker, 'settled', 30_000);
  assert.equal(safeSettled.result.status, 'blocked_unknown');
  assert.equal((await readJob(jobPool, safeJob.jobId)).state, 'blocked_unknown');
  assert.deepEqual(await provider.counts(safeJob.effectKey), { calls: 1, effects: 1 });
  results.push({ id: 'nex-safe-boundary-step-recovery-blocks-unknown-completion', passed: true, crash: safeCrash });
  await shutdownWorker(safeRecoveryWorker);

  client = await DBOSClient.create({
    systemDatabaseUrl: databaseUrl(candidateDatabase),
    systemDatabaseSchemaName: 'nex086c_dbos',
    systemDatabasePoolSize: 4,
    applicationName,
  });
  await client.registerQueue(queueName, { globalConcurrency: 1, minPollingIntervalMs: 50, applicationName, onConflict: 'always_update' });
  const txPool = new Pool({ connectionString: databaseUrl(candidateDatabase), max: 2 });
  await txPool.query('create table bench_dbos_transaction_marker (id text primary key)');
  const tx = await txPool.connect();
  const rollbackWorkflowId = `dbos-rollback-${randomUUID()}`;
  try {
    await tx.query('begin');
    await tx.query("insert into bench_dbos_transaction_marker (id) values ('rollback')");
    await client.enqueueInTransaction(tx, {
      queueName,
      workflowName: 'nex086c_delivery',
      workflowID: rollbackWorkflowId,
      applicationName,
    }, { kind: 'sleep' });
    await tx.query('rollback');
  } finally {
    tx.release();
  }
  assert.equal((await txPool.query('select count(*)::int as count from bench_dbos_transaction_marker')).rows[0].count, 0);
  assert.equal(await client.retrieveWorkflow(rollbackWorkflowId).getStatus(), null);
  await txPool.end();
  results.push({ id: 'enqueueInTransaction-rollback', passed: true });

  const waitBeforeWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  const waitBeforeId = `dbos-wait-before-${randomUUID()}`;
  startWorkflow(waitBeforeWorker, waitBeforeId, { kind: 'wait-before' });
  await awaitMessage(waitBeforeWorker, 'pre-wait');
  await client.send(waitBeforeId, 'durably-buffered-before-recv', 'approval', `early-${waitBeforeId}`);
  const waitBeforeSettled = await awaitMessage(waitBeforeWorker, 'settled', 10_000);
  assert.equal(waitBeforeSettled.result.message, 'durably-buffered-before-recv');
  results.push({ id: 'durable-signal-before-waiter', passed: true });
  await shutdownWorker(waitBeforeWorker);

  const waitAfterWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  const waitAfterId = `dbos-wait-after-${randomUUID()}`;
  startWorkflow(waitAfterWorker, waitAfterId, { kind: 'wait-after' });
  await awaitMessage(waitAfterWorker, 'waiting');
  await client.send(waitAfterId, 'signal-after-waiter', 'approval', `late-${waitAfterId}`);
  const waitAfterSettled = await awaitMessage(waitAfterWorker, 'settled', 10_000);
  assert.equal(waitAfterSettled.result.message, 'signal-after-waiter');
  results.push({ id: 'durable-signal-after-waiter', passed: true });
  await shutdownWorker(waitAfterWorker);

  const sleepWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  const sleepWorkflowId = `dbos-sleep-${randomUUID()}`;
  const sleepStarted = Date.now();
  startWorkflow(sleepWorker, sleepWorkflowId, { kind: 'sleep' });
  await awaitMessage(sleepWorker, 'settled', 10_000);
  assert.ok(Date.now() - sleepStarted >= 250);
  results.push({ id: 'durable-sleep', passed: true });
  await shutdownWorker(sleepWorker);

  await writeArtifact('dbos-results.json', {
    completedAt: new Date().toISOString(),
    version: '4.27.6',
    systemDatabaseSchema: 'nex086c_dbos',
    results,
  });
  console.log(JSON.stringify({ runner: 'dbos', results }, null, 2));
} finally {
  await client?.destroy().catch(() => undefined);
  await jobPool.end();
  await provider.close();
}
