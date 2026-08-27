import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { writeArtifact } from '../src/artifacts.mjs';
import { LAB, LAB_ROOT, databaseUrl } from '../src/constants.mjs';
import { recreateDatabase } from '../src/db.mjs';
import {
  createLaboratoryJob,
  forceExpireLease,
  markExpiredForRecovery,
  readAttempts,
  readEvidence,
  readJob,
  requestCancel,
} from '../src/nex-store.mjs';
import { startProviderFixture } from '../src/provider.mjs';
import { sleep } from '../src/shell.mjs';

const { Pool } = pg;
const candidateDatabase = LAB.candidateDatabases[0];
const queue = 'nex086c_minigate';
const workerScript = new URL('./pgboss-minigate-child.mjs', import.meta.url);
const deliveryConfig = Object.freeze({
  expireInSeconds: 1,
  heartbeatSeconds: 10,
  retryLimit: 2,
  retryDelay: 0,
});
const workerConfig = Object.freeze({
  pollingIntervalSeconds: 0.5,
  notifyPollingIntervalSeconds: 0.5,
  listenNotify: true,
  heartbeatRefreshSeconds: 2,
  localConcurrency: 1,
});

function makeBoss() {
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
  return boss;
}

function iso(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function snapshotPgboss(boss, id) {
  const job = await boss.getJobById(queue, id);
  if (!job) return null;
  return {
    id: job.id,
    state: job.state,
    retryCount: job.retryCount,
    retryLimit: job.retryLimit,
    expireInSeconds: job.expireInSeconds,
    heartbeatSeconds: job.heartbeatSeconds,
    heartbeatOn: iso(job.heartbeatOn),
    startedOn: iso(job.startedOn),
    completedOn: iso(job.completedOn),
  };
}

async function waitForPgbossState(boss, id, predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await snapshotPgboss(boss, id);
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`PG-BOSS did not ${description}: ${JSON.stringify(last)}`);
}

async function snapshotNex(pool, jobId) {
  const job = await readJob(pool, jobId);
  const attempts = await readAttempts(pool, jobId);
  const evidence = await readEvidence(pool, jobId);
  return {
    job: job && {
      state: job.state,
      revision: Number(job.revision),
      leaseOwner: job.lease_owner,
      leaseEpoch: Number(job.lease_epoch),
      leaseUntil: iso(job.lease_until),
      attemptId: job.attempt_id,
      cancelRequested: job.cancel_requested,
    },
    attempts: attempts.map((attempt) => ({ id: attempt.id, state: attempt.state })),
    evidence: evidence.map((item) => ({ id: Number(item.id), attemptId: item.attempt_id, providerCallId: item.provider_call_id })),
  };
}

function startWorker({ role, providerUrl }) {
  const child = fork(workerScript, [], {
    env: {
      ...process.env,
      NEX086C_QUEUE: queue,
      NEX086C_ROLE: role,
      NEX086C_PROVIDER_URL: providerUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const stderr = [];
  const stdout = [];
  const messages = [];
  const waiters = new Set();
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
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
          reject(new Error(`PG-BOSS ${role} worker did not ${description}: ${stderr.join('')}${stdout.join('')}`));
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  };
  const ready = waitForMessage((message) => message.type === 'ready' || message.type === 'error', 15_000, 'become ready');
  return ready.then((message) => {
    if (message.type === 'error') throw new Error(message.message);
    return { role, child, stderr, stdout, messages, waitForMessage };
  });
}

function sendControl(worker, name, payload = true) {
  if (worker.child.exitCode !== null || !worker.child.connected) return;
  try {
    worker.child.send({ type: 'control', name, payload });
  } catch {
    // The worker can finish between the state observation and this control.
  }
}

async function waitForExit(worker, timeoutMs = 5_000) {
  if (worker.child.exitCode !== null) {
    return { code: worker.child.exitCode, signal: worker.child.signalCode };
  }
  return Promise.race([
    once(worker.child, 'exit').then(([code, signal]) => ({ code, signal })),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`PG-BOSS ${worker.role} worker did not exit`)), timeoutMs)),
  ]);
}

async function shutdownWorker(worker) {
  if (worker.child.exitCode !== null) return;
  try {
    worker.child.send({ type: 'shutdown' });
    await waitForExit(worker);
  } catch {
    worker.child.kill('SIGKILL');
    await waitForExit(worker, 5_000).catch(() => undefined);
  }
}

function record(events, name, data = {}) {
  events.push({ at: new Date().toISOString(), name, ...data });
}

function deliveryId(value) {
  assert.equal(typeof value, 'string', 'PG-BOSS send must return a delivery id');
  return value;
}

function resultSummary(jobId, pgboss, nex, providerCounts, extra = {}) {
  return { jobId, pgboss, nex, providerCounts, ...extra };
}

function renderReport(result) {
  const table = result.authorityTable
    .map((row) => `| ${row.stage} | ${row.pgboss} | ${row.nexJob} | ${row.nexAttempt} | ${row.worker} | ${row.leaseEpoch} | ${row.effectCount} |`)
    .join('\n');
  const tests = result.tests
    .map((test) => `| ${test.id} | ${test.passed ? 'PASS' : 'FAIL'} | ${test.providerCounts.calls} calls / ${test.providerCounts.effects} effects | ${test.finalState} |`)
    .join('\n');
  return `# 0.86C-0 PG-BOSS subordinate mini-gate\n\n` +
    `This is a disposable, experimental spike under tools/benchmarks/086c-runtime. It does not implement 0.86C-1 or change src/core/**.\n\n` +
    `## Verdict\n\n${result.verdict}\n\n` +
    `## Scope and exact configuration\n\n` +
    `- PG-BOSS: 12.28.0; schema: nex086c_pgboss; PostgreSQL: ${candidateDatabase}.\n` +
    `- queue: ${queue}; LISTEN/NOTIFY enabled; polling: ${workerConfig.pollingIntervalSeconds}s; notify polling: ${workerConfig.notifyPollingIntervalSeconds}s.\n` +
    `- delivery: expireInSeconds=${deliveryConfig.expireInSeconds}, heartbeatSeconds=${deliveryConfig.heartbeatSeconds}, retryLimit=${deliveryConfig.retryLimit}, retryDelay=${deliveryConfig.retryDelay}.\n` +
    `- worker: heartbeatRefreshSeconds=${workerConfig.heartbeatRefreshSeconds}, localConcurrency=${workerConfig.localConcurrency}.\n\n` +
    `The redelivery trigger is the PG-BOSS active-delivery expiration. NEX's 200ms operational lease is independently fenced. The observed rule is: PG-BOSS state alone never authorizes an external side effect; the handler must rehydrate and consult NEX.\n\n` +
    `## Scenarios\n\n| Scenario | Result | Provider count | NEX final state |\n|---|---:|---:|---|\n${tests}\n\n` +
    `## Dual authority table: T9 main timeline\n\n| Stage | PG-BOSS state | NEX Job | NEX Attempt | Worker | lease_epoch | provider effects |\n|---|---|---|---|---|---:|---:|\n${table}\n\n` +
    `## Ack and completion order\n\n` +
    result.ackOrder.map((item, index) => `${index + 1}. **${item.event}** — ${item.detail}`).join('\n') + '\n\n' +
    `The canonical NEX state is committed before a delivery is allowed to complete when the handler has a definitive outcome. A crash after that NEX commit and before PG-BOSS ack is harmless: the next delivery sees the canonical state and does not call the provider. In T9, B's PG-BOSS delivery completed while A's late Evidence write was rejected by the old lease epoch.\n\n` +
    `## Limitations\n\n` +
    result.limitations.map((item) => `- ${item}`).join('\n') + '\n\n' +
    `## Artifact\n\n` +
    `Machine-readable evidence: .artifacts/pgboss-minigate-results.json.\n\n` +
    `0.86C-0 MINI-GATE PG-BOSS CONCLUÍDO PARA SÍNTESE HUMANA\n`;
}

await recreateDatabase(candidateDatabase);
const provider = await startProviderFixture();
const jobPool = new Pool({ connectionString: databaseUrl(LAB.jobDatabase), max: 8 });
jobPool.on('error', () => undefined);
const boss = makeBoss();
const workers = new Set();
const events = [];
const tests = [];
let main;
let preDispatch;
let cancelBefore;
let duplicate;

try {
  await boss.start();
  await boss.createQueue(queue, {
    ...deliveryConfig,
    deleteAfterSeconds: 3_600,
    notify: true,
  });
  record(events, 'pgboss-started', { version: '12.28.0', queue, deliveryConfig, workerConfig });

  // T9 main: A gets the delivery and NEX lease_epoch=1, applies the external
  // effect, then remains frozen while both authorities expire independently.
  const mainJob = await createLaboratoryJob(jobPool, {
    jobId: `pgboss-minigate-t9-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const mainDeliveryId = deliveryId(await boss.send(queue, { jobId: mainJob.jobId }, deliveryConfig));
  record(events, 'pgboss-send', { scenario: 't9', deliveryId: mainDeliveryId, jobId: mainJob.jobId });
  const mainDeliveryCreated = {
    pgboss: await snapshotPgboss(boss, mainDeliveryId),
    nex: await snapshotNex(jobPool, mainJob.jobId),
  };
  const workerA = await startWorker({ role: 'stale-a', providerUrl: provider.url });
  workers.add(workerA);
  const aStarted = await workerA.waitForMessage((message) => (message.type === 'handler-started' && message.deliveryId === mainDeliveryId) || message.type === 'error', 10_000, 'start T9 Worker A');
  if (aStarted.type === 'error') throw new Error(aStarted.message);
  const aAuthority = await workerA.waitForMessage((message) => (message.type === 'authority-check' && message.phase === 'before-dispatch') || message.type === 'error', 10_000, 'claim T9 through NEX');
  if (aAuthority.type === 'error') throw new Error(aAuthority.message);
  assert.equal(aAuthority.job.leaseEpoch, 1);
  assert.equal(aAuthority.job.state, 'running');
  const mainBeforeDispatch = {
    pgboss: await snapshotPgboss(boss, mainDeliveryId),
    nex: await snapshotNex(jobPool, mainJob.jobId),
  };
  record(events, 'nex-authority-granted', { scenario: 't9', deliveryId: mainDeliveryId, nex: mainBeforeDispatch.nex });

  sendControl(workerA, 'dispatch');
  const aLastCheck = await workerA.waitForMessage((message) => (message.type === 'authority-check' && message.phase === 'last-check-before-provider') || message.type === 'error', 10_000, 'perform T9 last authority check');
  if (aLastCheck.type === 'error') throw new Error(aLastCheck.message);
  assert.equal(aLastCheck.authorized, true);
  const aEffect = await workerA.waitForMessage((message) => message.type === 'effect-applied' || message.type === 'error', 10_000, 'apply the T9 external effect');
  if (aEffect.type === 'error') throw new Error(aEffect.message);
  const mainAfterEffect = {
    pgboss: await snapshotPgboss(boss, mainDeliveryId),
    nex: await snapshotNex(jobPool, mainJob.jobId),
    providerCounts: await provider.counts(mainJob.effectKey),
  };
  assert.deepEqual(mainAfterEffect.providerCounts, { calls: 1, effects: 1 });
  record(events, 'external-effect-applied', { scenario: 't9', deliveryId: mainDeliveryId, providerCounts: mainAfterEffect.providerCounts });

  const cancelAfterDispatch = await requestCancel(jobPool, mainJob.jobId);
  record(events, 'cancel-requested-after-dispatch', { scenario: 't9', job: { state: cancelAfterDispatch.state, cancelRequested: cancelAfterDispatch.cancel_requested } });
  await sleep(1_300);
  const expiredNexRows = await markExpiredForRecovery(jobPool);
  assert.equal(expiredNexRows.length, 1);
  const mainBeforeB = {
    pgboss: await snapshotPgboss(boss, mainDeliveryId),
    nex: await snapshotNex(jobPool, mainJob.jobId),
  };
  record(events, 'leases-expired-before-b', { scenario: 't9', expiredNexRows: expiredNexRows.length, pgboss: mainBeforeB.pgboss, nex: mainBeforeB.nex });
  await boss.supervise(queue);
  const mainPgbossRetry = await waitForPgbossState(boss, mainDeliveryId, (snapshot) => snapshot?.state === 'retry', 'move T9 delivery to retry after active expiration');
  const workerB = await startWorker({ role: 'recovery-b', providerUrl: provider.url });
  workers.add(workerB);
  const bStarted = await workerB.waitForMessage((message) => (message.type === 'handler-started' && message.deliveryId === mainDeliveryId) || message.type === 'error', 15_000, 'start T9 Worker B redelivery');
  if (bStarted.type === 'error') throw new Error(bStarted.message);
  const mainDuringB = {
    pgboss: await snapshotPgboss(boss, mainDeliveryId),
    nex: await snapshotNex(jobPool, mainJob.jobId),
  };
  const bBoundary = await workerB.waitForMessage((message) => (message.type === 'boundary-result' && message.deliveryId === mainDeliveryId) || message.type === 'error', 15_000, 'rehydrate T9 in Worker B');
  if (bBoundary.type === 'error') throw new Error(bBoundary.message);
  assert.equal(bBoundary.result.status, 'blocked_unknown');
  record(events, 'worker-b-blocked-unknown', { scenario: 't9', deliveryId: mainDeliveryId, result: bBoundary.result });
  const bSettled = await workerB.waitForMessage((message) => (message.type === 'settled' && message.deliveryId === mainDeliveryId) || message.type === 'error', 15_000, 'settle T9 Worker B');
  if (bSettled.type === 'error') throw new Error(bSettled.message);
  const mainAfterB = {
    pgboss: await waitForPgbossState(boss, mainDeliveryId, (snapshot) => snapshot?.state === 'completed', 'ack T9 Worker B completion'),
    nex: await snapshotNex(jobPool, mainJob.jobId),
    providerCounts: await provider.counts(mainJob.effectKey),
  };
  assert.equal(mainAfterB.nex.job.state, 'blocked_unknown');
  assert.deepEqual(mainAfterB.providerCounts, { calls: 1, effects: 1 });
  sendControl(workerA, 'release');
  const staleWriteMessage = await workerA.waitForMessage((message) => message.type === 'stale-evidence-write' || message.type === 'error', 10_000, 'attempt the stale T9 Evidence write');
  if (staleWriteMessage.type === 'error') throw new Error(staleWriteMessage.message);
  assert.equal(staleWriteMessage.staleWrite.accepted, false);
  const aReturned = await workerA.waitForMessage((message) => message.type === 'handler-returned' || message.type === 'error', 10_000, 'return from stale T9 Worker A');
  if (aReturned.type === 'error') throw new Error(aReturned.message);
  const mainFinal = {
    pgboss: await snapshotPgboss(boss, mainDeliveryId),
    nex: await snapshotNex(jobPool, mainJob.jobId),
    providerCounts: await provider.counts(mainJob.effectKey),
  };
  assert.equal(mainFinal.nex.job.state, 'blocked_unknown');
  assert.equal(mainFinal.nex.job.cancelRequested, true);
  assert.equal(mainFinal.nex.evidence.length, 0);
  assert.deepEqual(mainFinal.providerCounts, { calls: 1, effects: 1 });
  main = {
    id: 't9-stale-worker-a-pgboss-redelivery-worker-b',
    jobId: mainJob.jobId,
    deliveryId: mainDeliveryId,
    deliveryCreated: mainDeliveryCreated,
    beforeDispatch: mainBeforeDispatch,
    afterEffect: mainAfterEffect,
    beforeB: mainBeforeB,
    pgbossRetry: mainPgbossRetry,
    duringB: mainDuringB,
    afterB: mainAfterB,
    final: mainFinal,
    staleWrite: staleWriteMessage.staleWrite,
    cancelAfterDispatch: { state: cancelAfterDispatch.state, cancelRequested: cancelAfterDispatch.cancel_requested },
    providerCounts: mainFinal.providerCounts,
    finalState: mainFinal.nex.job.state,
    passed: true,
  };
  tests.push(main);
  tests.push(resultSummary(mainJob.jobId, mainFinal.pgboss, mainFinal.nex, mainFinal.providerCounts, {
    id: 'cancel-after-dispatch-conservative-no-repeat',
    deliveryId: mainDeliveryId,
    derivedFrom: main.id,
    cancelRequest: main.cancelAfterDispatch,
    rule: 'Cancellation does not imply that the already-issued provider effect did not happen; no automatic repeat is authorized.',
    finalState: mainFinal.nex.job.state,
    passed: true,
  }));
  await shutdownWorker(workerA);
  await shutdownWorker(workerB);
  workers.delete(workerA);
  workers.delete(workerB);

  // Pre-dispatch variant: authority is revoked between the first check and the
  // final check. The provider must not be called; the race window is recorded.
  const preJob = await createLaboratoryJob(jobPool, {
    jobId: `pgboss-minigate-pre-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const preWorker = await startWorker({ role: 'pre-dispatch', providerUrl: provider.url });
  workers.add(preWorker);
  const preDeliveryId = deliveryId(await boss.send(queue, { jobId: preJob.jobId }, { ...deliveryConfig, retryLimit: 0 }));
  const preAuthority = await preWorker.waitForMessage((message) => (message.type === 'authority-check' && message.phase === 'before-dispatch') || message.type === 'error', 10_000, 'claim the pre-dispatch variant');
  if (preAuthority.type === 'error') throw new Error(preAuthority.message);
  assert.equal(preAuthority.job.leaseEpoch, 1);
  await forceExpireLease(jobPool, preJob.jobId);
  const preExpired = await markExpiredForRecovery(jobPool);
  assert.equal(preExpired.length, 1);
  sendControl(preWorker, 'dispatch');
  const preSuppressed = await preWorker.waitForMessage((message) => message.type === 'dispatch-suppressed' || message.type === 'error', 10_000, 'suppress the pre-dispatch provider call');
  if (preSuppressed.type === 'error') throw new Error(preSuppressed.message);
  assert.equal(preSuppressed.result.status, 'dispatch_suppressed');
  const preSettled = await preWorker.waitForMessage((message) => (message.type === 'settled' && message.deliveryId === preDeliveryId) || message.type === 'error', 10_000, 'settle the pre-dispatch variant');
  if (preSettled.type === 'error') throw new Error(preSettled.message);
  const preFinal = {
    pgboss: await waitForPgbossState(boss, preDeliveryId, (snapshot) => snapshot?.state === 'completed', 'ack the pre-dispatch variant'),
    nex: await snapshotNex(jobPool, preJob.jobId),
    providerCounts: await provider.counts(preJob.effectKey),
  };
  assert.equal(preFinal.nex.job.state, 'recovery_pending');
  assert.deepEqual(preFinal.providerCounts, { calls: 0, effects: 0 });
  preDispatch = resultSummary(preJob.jobId, preFinal.pgboss, preFinal.nex, preFinal.providerCounts, {
    id: 'pre-dispatch-authority-loss-suppresses-provider',
    deliveryId: preDeliveryId,
    firstCheck: preAuthority.job,
    finalCheck: preSuppressed.result.job,
    raceQualification: 'There is an inherent check-to-external-I/O race; the final NEX authority check suppresses dispatch when authority is already lost.',
    finalState: preFinal.nex.job.state,
    passed: true,
  });
  tests.push(preDispatch);
  await shutdownWorker(preWorker);
  workers.delete(preWorker);

  // Cancel before dispatch: cancellation is committed in NEX before PG-BOSS
  // delivers the wake-up, so the safe boundary never invokes the provider.
  const cancelJob = await createLaboratoryJob(jobPool, {
    jobId: `pgboss-minigate-cancel-before-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const cancelState = await requestCancel(jobPool, cancelJob.jobId);
  const cancelWorker = await startWorker({ role: 'safe', providerUrl: provider.url });
  workers.add(cancelWorker);
  const cancelDeliveryId = deliveryId(await boss.send(queue, { jobId: cancelJob.jobId }, { ...deliveryConfig, retryLimit: 0 }));
  const cancelBoundary = await cancelWorker.waitForMessage((message) => (message.type === 'boundary-result' && message.deliveryId === cancelDeliveryId) || message.type === 'error', 10_000, 'honor cancel before dispatch');
  if (cancelBoundary.type === 'error') throw new Error(cancelBoundary.message);
  assert.equal(cancelBoundary.result.status, 'not_dispatchable:cancelled');
  const cancelSettled = await cancelWorker.waitForMessage((message) => (message.type === 'settled' && message.deliveryId === cancelDeliveryId) || message.type === 'error', 10_000, 'settle cancel-before-dispatch');
  if (cancelSettled.type === 'error') throw new Error(cancelSettled.message);
  const cancelFinal = {
    pgboss: await waitForPgbossState(boss, cancelDeliveryId, (snapshot) => snapshot?.state === 'completed', 'ack cancel-before-dispatch'),
    nex: await snapshotNex(jobPool, cancelJob.jobId),
    providerCounts: await provider.counts(cancelJob.effectKey),
  };
  assert.equal(cancelFinal.nex.job.state, 'cancelled');
  assert.deepEqual(cancelFinal.providerCounts, { calls: 0, effects: 0 });
  cancelBefore = resultSummary(cancelJob.jobId, cancelFinal.pgboss, cancelFinal.nex, cancelFinal.providerCounts, {
    id: 'cancel-before-dispatch-no-provider-effect',
    deliveryId: cancelDeliveryId,
    cancelCommit: { state: cancelState.state, cancelRequested: cancelState.cancel_requested },
    finalState: cancelFinal.nex.job.state,
    passed: true,
  });
  tests.push(cancelBefore);
  await shutdownWorker(cancelWorker);
  workers.delete(cancelWorker);

  // Duplicate wake-up: two PG-BOSS deliveries race, but only one NEX lease is
  // valid. The second delivery observes in_flight_elsewhere and never calls
  // the provider.
  const duplicateJob = await createLaboratoryJob(jobPool, {
    jobId: `pgboss-minigate-duplicate-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const duplicateWorkers = await Promise.all([
    startWorker({ role: 'duplicate', providerUrl: provider.url }),
    startWorker({ role: 'duplicate', providerUrl: provider.url }),
  ]);
  duplicateWorkers.forEach((worker) => workers.add(worker));
  const duplicateDeliveryIds = await Promise.all([
    boss.send(queue, { jobId: duplicateJob.jobId }, { ...deliveryConfig, retryLimit: 0 }),
    boss.send(queue, { jobId: duplicateJob.jobId }, { ...deliveryConfig, retryLimit: 0 }),
  ]).then((ids) => ids.map(deliveryId));
  const duplicateClaim = await Promise.race(duplicateWorkers.map((worker) => worker.waitForMessage((message) => message.type === 'claimed' || message.type === 'error', 10_000, 'claim one duplicate delivery')));
  if (duplicateClaim.type === 'error') throw new Error(duplicateClaim.message);
  assert.equal(duplicateClaim.job.leaseEpoch, 1);
  const duplicateInFlight = await Promise.race(duplicateWorkers.map((worker) => worker.waitForMessage((message) => (message.type === 'boundary-result' && message.result.status === 'in_flight_elsewhere') || message.type === 'error', 10_000, 'observe duplicate in-flight authority')));
  if (duplicateInFlight.type === 'error') throw new Error(duplicateInFlight.message);
  sendControl(duplicateWorkers[0], 'dispatch');
  sendControl(duplicateWorkers[1], 'dispatch');
  const duplicateSettlements = await Promise.all(duplicateWorkers.map((worker) => worker.waitForMessage((message) => message.type === 'settled' || message.type === 'error', 10_000, 'settle duplicate delivery')));
  duplicateSettlements.forEach((message) => {
    if (message.type === 'error') throw new Error(message.message);
  });
  const duplicateFinal = {
    pgboss: await Promise.all(duplicateDeliveryIds.map((id) => waitForPgbossState(boss, id, (snapshot) => snapshot?.state === 'completed', 'ack a duplicate delivery'))),
    nex: await snapshotNex(jobPool, duplicateJob.jobId),
    providerCounts: await provider.counts(duplicateJob.effectKey),
  };
  assert.equal(duplicateFinal.nex.job.state, 'succeeded');
  assert.deepEqual(duplicateFinal.providerCounts, { calls: 1, effects: 1 });
  assert.equal(duplicateSettlements.filter((message) => message.result.status === 'in_flight_elsewhere').length, 1);
  duplicate = resultSummary(duplicateJob.jobId, duplicateFinal.pgboss, duplicateFinal.nex, duplicateFinal.providerCounts, {
    id: 'duplicate-delivery-one-nex-authority',
    deliveryIds: duplicateDeliveryIds,
    outcomes: duplicateSettlements.map((message) => message.result.status),
    finalState: duplicateFinal.nex.job.state,
    passed: true,
  });
  tests.push(duplicate);
  await Promise.all(duplicateWorkers.map(shutdownWorker));
  duplicateWorkers.forEach((worker) => workers.delete(worker));

  const authorityTable = [
    {
      stage: 'Delivery created',
      pgboss: main.deliveryCreated.pgboss?.state ?? 'created',
      nexJob: main.deliveryCreated.nex.job.state,
      nexAttempt: 'none',
      worker: 'none',
      leaseEpoch: main.deliveryCreated.nex.job.leaseEpoch,
      effectCount: 0,
    },
    {
      stage: 'A owns and passes first check',
      pgboss: main.beforeDispatch.pgboss?.state ?? 'active',
      nexJob: main.beforeDispatch.nex.job.state,
      nexAttempt: main.beforeDispatch.nex.attempts[0]?.state ?? 'started',
      worker: main.beforeDispatch.nex.job.leaseOwner,
      leaseEpoch: main.beforeDispatch.nex.job.leaseEpoch,
      effectCount: 0,
    },
    {
      stage: 'A applied provider effect; Evidence held',
      pgboss: main.afterEffect.pgboss?.state ?? 'active',
      nexJob: main.afterEffect.nex.job.state,
      nexAttempt: main.afterEffect.nex.attempts[0]?.state ?? 'started',
      worker: main.afterEffect.nex.job.leaseOwner,
      leaseEpoch: main.afterEffect.nex.job.leaseEpoch,
      effectCount: main.afterEffect.providerCounts.effects,
    },
    {
      stage: 'A authority expired; B is next',
      pgboss: main.pgbossRetry.state,
      nexJob: main.beforeB.nex.job.state,
      nexAttempt: main.beforeB.nex.attempts[0]?.state ?? 'started',
      worker: 'A stale / B not started',
      leaseEpoch: main.beforeB.nex.job.leaseEpoch,
      effectCount: main.afterEffect.providerCounts.effects,
    },
    {
      stage: 'B redelivery rehydrates NEX',
      pgboss: main.duringB.pgboss?.state ?? 'active',
      nexJob: main.duringB.nex.job.state,
      nexAttempt: main.duringB.nex.attempts[0]?.state ?? 'started',
      worker: 'B; A stale',
      leaseEpoch: main.duringB.nex.job.leaseEpoch,
      effectCount: main.afterEffect.providerCounts.effects,
    },
    {
      stage: 'B commits blocked_unknown before ack',
      pgboss: main.afterB.pgboss.state,
      nexJob: main.afterB.nex.job.state,
      nexAttempt: main.afterB.nex.attempts[0]?.state ?? 'unknown_completion',
      worker: 'B completed; A stale',
      leaseEpoch: main.afterB.nex.job.leaseEpoch,
      effectCount: main.afterB.providerCounts.effects,
    },
    {
      stage: 'A stale Evidence write rejected',
      pgboss: main.final.pgboss?.state ?? main.afterB.pgboss.state,
      nexJob: main.final.nex.job.state,
      nexAttempt: main.final.nex.attempts[0]?.state ?? 'unknown_completion',
      worker: 'A stale / B completed',
      leaseEpoch: main.final.nex.job.leaseEpoch,
      effectCount: main.final.providerCounts.effects,
    },
  ];

  const ackOrder = [
    { event: 'A handler begins', detail: `PG-BOSS delivery ${main.deliveryId} is active; NEX has lease_epoch=1.` },
    { event: 'A external effect', detail: 'Provider count becomes calls=1/effects=1; NEX Evidence is intentionally not committed.' },
    { event: 'PG-BOSS retry/redelivery', detail: `The active delivery expires at ${deliveryConfig.expireInSeconds}s; observed state before B: ${main.pgbossRetry.state}.` },
    { event: 'B canonical decision', detail: 'B rehydrates NEX, classifies blocked_unknown, and returns without a provider call.' },
    { event: 'B delivery completion', detail: `PG-BOSS reports ${main.afterB.pgboss.state}; canonical NEX state is already blocked_unknown.` },
    { event: 'A late Evidence attempt', detail: `A's old lease_epoch=1 is rejected (${main.staleWrite.error}); Evidence count remains ${main.final.nex.evidence.length}.` },
  ];

  const result = {
    completedAt: new Date().toISOString(),
    verdict: 'PG-BOSS SUBORDINADO PASSA MINI-GATE',
    version: '12.28.0',
    schemaVersion: await boss.schemaVersion(),
    queue,
    candidateDatabase,
    deliveryConfig,
    workerConfig,
    tests,
    authorityTable,
    ackOrder,
    limitations: [
      'This is an experimental spike only; it does not select the 0.86C-1 architecture and does not modify src/core/**, migrations, Notion, or main.',
      'The provider fixture is an independent PostgreSQL database, so the external effect is deliberately outside the NEX JobStore transaction.',
      'PG-BOSS expiration and NEX lease expiry are separate clocks. A real deployment must size and monitor both; PG-BOSS state is never treated as mutative authority.',
      'The pre-dispatch test demonstrates the final-check suppression boundary, but no software can eliminate the inherent check-to-external-I/O race; only an external idempotency/commit protocol can change that fact.',
    ],
  };
  await writeArtifact('pgboss-minigate-results.json', result);
  await writeFile(path.join(LAB_ROOT, 'PG_BOSS_MINIGATE_REPORT.md'), renderReport(result), 'utf8');
  console.log(JSON.stringify({ verdict: result.verdict, tests: result.tests.map(({ id, passed, finalState, providerCounts }) => ({ id, passed, finalState, providerCounts })) }, null, 2));
} finally {
  await Promise.allSettled([...workers].map(shutdownWorker));
  await boss.stop().catch(() => undefined);
  await jobPool.end();
  await provider.close();
}
