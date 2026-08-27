import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { writeArtifact } from '../src/artifacts.mjs';
import { LAB, databaseUrl } from '../src/constants.mjs';
import { restartPostgresLaboratory, waitForPostgres } from '../src/docker.mjs';
import { pingPostgres, recreateDatabase } from '../src/db.mjs';
import { createLaboratoryJob, readJob } from '../src/nex-store.mjs';
import { startProviderFixture } from '../src/provider.mjs';
import { sleep } from '../src/shell.mjs';

const { Pool } = pg;
const queue = 'nex086c_delivery';
const candidateDatabase = LAB.candidateDatabases[0];

async function startWorker({ mode, providerUrl, crashAfterEffect }) {
  const child = fork(new URL('./pgboss-worker.mjs', import.meta.url), [], {
    env: {
      ...process.env,
      NEX086C_QUEUE: queue,
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
    const alreadyReceived = messages.find(predicate);
    if (alreadyReceived) return Promise.resolve(alreadyReceived);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`pg-boss worker did not ${description}: ${stderr.join('')}`));
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  };

  const message = await waitForMessage((value) => value.type === 'ready' || value.type === 'error', 10_000, 'become ready');
  if (message.type === 'error') throw new Error(message.message);
  return { child, message, stderr, waitForMessage };
}

async function awaitEffectAndKill(worker) {
  const message = await worker.waitForMessage((value) => value.type === 'effect-applied' || value.type === 'error', 10_000, 'apply the effect');
  if (message.type === 'error') throw new Error(message.message);
  assert.equal(message.type, 'effect-applied');
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

await recreateDatabase(candidateDatabase);
const provider = await startProviderFixture();
const jobPool = new Pool({ connectionString: databaseUrl(LAB.jobDatabase), max: 8 });
// The PostgreSQL restart is intentional chaos. Avoid turning an idle-client
// disconnect into an unhandled Node event before the runner can verify it.
jobPool.on('error', () => undefined);
const boss = new PgBoss({
  connectionString: databaseUrl(candidateDatabase),
  schema: 'nex086c_pgboss',
  useListenNotify: true,
  supervise: true,
  schedule: false,
  superviseIntervalSeconds: 1,
  monitorIntervalSeconds: 1,
  maintenanceIntervalSeconds: 1,
});
boss.on('error', () => undefined);
const results = [];
let restartedBoss;
try {
  await boss.start();
  await boss.createQueue(queue, { expireInSeconds: 1, retryLimit: 1, retryDelay: 0, deleteAfterSeconds: 3600, notify: true });

  const txPool = new Pool({ connectionString: databaseUrl(candidateDatabase), max: 2 });
  await txPool.query('create table bench_transaction_marker (id text primary key)');
  const transactionClient = await txPool.connect();
  try {
    await transactionClient.query('begin');
    await transactionClient.query("insert into bench_transaction_marker (id) values ('rollback')");
    await boss.send(queue, { transaction: 'rollback' }, { db: { executeSql: (text, values) => transactionClient.query(text, values) } });
    await transactionClient.query('rollback');
  } finally {
    transactionClient.release();
  }
  assert.equal(Number((await txPool.query('select count(*)::int as count from bench_transaction_marker')).rows[0].count), 0);
  assert.equal((await boss.findJobs(queue, { data: { transaction: 'rollback' } })).length, 0);
  await txPool.end();
  results.push({ id: 'transactional-enqueue-rollback', passed: true });

  const raw = { jobId: `pgboss-raw-${randomUUID()}`, effectKey: `pgboss-effect-${randomUUID()}`, providerMode: 'non_idempotent' };
  const rawCrashWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: true });
  await boss.send(queue, raw, { expireInSeconds: 1, retryLimit: 1, retryDelay: 0 });
  const rawCrash = await awaitEffectAndKill(rawCrashWorker);
  assert.deepEqual(await provider.counts(raw.effectKey), { calls: 1, effects: 1 });
  await sleep(1_300);
  await boss.supervise(queue);
  const rawRecoveryWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  await awaitSettlement(rawRecoveryWorker);
  assert.deepEqual(await provider.counts(raw.effectKey), { calls: 2, effects: 2 });
  results.push({ id: 'raw-engine-crash-redelivery-duplicates-non-idempotent-effect', passed: true, crash: rawCrash });

  const safeJob = await createLaboratoryJob(jobPool, {
    jobId: `pgboss-safe-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const safeCrashWorker = await startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: true });
  await boss.send(queue, { jobId: safeJob.jobId }, { expireInSeconds: 1, retryLimit: 1, retryDelay: 0 });
  const safeCrash = await awaitEffectAndKill(safeCrashWorker);
  assert.deepEqual(await provider.counts(safeJob.effectKey), { calls: 1, effects: 1 });
  await sleep(1_300);
  await boss.supervise(queue);
  const safeRecoveryWorker = await startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: false });
  const safeSettlement = await awaitSettlement(safeRecoveryWorker);
  assert.equal(safeSettlement.result.status, 'blocked_unknown');
  assert.equal((await readJob(jobPool, safeJob.jobId)).state, 'blocked_unknown');
  assert.deepEqual(await provider.counts(safeJob.effectKey), { calls: 1, effects: 1 });
  results.push({ id: 'nex-safe-boundary-crash-redelivery-blocks-unknown-completion', passed: true, crash: safeCrash });

  const duplicateWakeJob = await createLaboratoryJob(jobPool, {
    jobId: `pgboss-duplicate-wake-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const duplicateWakeWorkers = await Promise.all([
    startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: false }),
    startWorker({ mode: 'safe', providerUrl: provider.url, crashAfterEffect: false }),
  ]);
  await Promise.all([
    boss.send(queue, { jobId: duplicateWakeJob.jobId }, { expireInSeconds: 1, retryLimit: 0 }),
    boss.send(queue, { jobId: duplicateWakeJob.jobId }, { expireInSeconds: 1, retryLimit: 0 }),
  ]);
  const duplicateWakeSettlements = await Promise.all(duplicateWakeWorkers.map(awaitSettlement));
  assert.equal((await readJob(jobPool, duplicateWakeJob.jobId)).state, 'succeeded');
  assert.deepEqual(await provider.counts(duplicateWakeJob.effectKey), { calls: 1, effects: 1 });
  assert.equal(
    duplicateWakeSettlements.filter((settlement) => settlement.result.status === 'in_flight_elsewhere').length,
    1,
    'one duplicate delivery should observe the still-valid NEX lease',
  );
  results.push({
    id: 'multi-worker-duplicate-wake-2-nex-safe',
    passed: true,
    workers: 2,
    duplicateDeliveries: 2,
    outcomes: duplicateWakeSettlements.map((settlement) => settlement.result.status),
  });

  const restartDelivery = {
    jobId: `pgboss-postgres-restart-${randomUUID()}`,
    effectKey: `pgboss-postgres-restart-effect-${randomUUID()}`,
    providerMode: 'idempotent',
  };
  await boss.send(queue, restartDelivery, { retryLimit: 0 });
  await boss.stop();
  await restartPostgresLaboratory();
  await waitForPostgres(pingPostgres);
  restartedBoss = new PgBoss({
    connectionString: databaseUrl(candidateDatabase),
    schema: 'nex086c_pgboss',
    useListenNotify: true,
    supervise: true,
    schedule: false,
    superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
    maintenanceIntervalSeconds: 1,
  });
  restartedBoss.on('error', () => undefined);
  await restartedBoss.start();
  const postRestartWorker = await startWorker({ mode: 'raw', providerUrl: provider.url, crashAfterEffect: false });
  await awaitSettlement(postRestartWorker);
  assert.deepEqual(await provider.counts(restartDelivery.effectKey), { calls: 1, effects: 1 });
  results.push({ id: 'postgres-restart-persisted-delivery-rehydration', passed: true });

  await writeArtifact('pg-boss-results.json', {
    completedAt: new Date().toISOString(),
    version: '12.28.0',
    schemaVersion: await restartedBoss.schemaVersion(),
    results,
  });
  console.log(JSON.stringify({ runner: 'pg-boss', results, schemaVersion: await restartedBoss.schemaVersion() }, null, 2));
} finally {
  await boss.stop().catch(() => undefined);
  await restartedBoss?.stop().catch(() => undefined);
  await jobPool.end();
  await provider.close();
}
