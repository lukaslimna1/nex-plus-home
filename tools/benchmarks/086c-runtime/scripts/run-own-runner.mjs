import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeArtifact } from '../src/artifacts.mjs';
import { LAB } from '../src/constants.mjs';
import { restartPostgresLaboratory, waitForPostgres } from '../src/docker.mjs';
import { makePool, pingPostgres } from '../src/db.mjs';
import {
  claimNextJob,
  createLaboratoryJob,
  createLaboratoryJobInTransaction,
  forceExpireLease,
  markExpiredForRecovery,
  persistEvidenceAndComplete,
  readAttempts,
  readEvidence,
  readJob,
  recoverUnknownCompletion,
  relayOutbox,
  requestCancel,
  startOrReadAttempt,
  unsafeRequeueExpired,
} from '../src/nex-store.mjs';
import { NexSafeOwnRunner, unsafeBlindRedelivery } from '../src/own-runner.mjs';
import { startProviderFixture } from '../src/provider.mjs';
import { sleep } from '../src/shell.mjs';

async function eventually(assertion, { timeoutMs = 6_000, intervalMs = 30 } = {}) {
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
  throw lastError ?? new Error('eventually timed out');
}

async function crashAfterEffect(providerUrl, workerId) {
  const child = fork(new URL('./crash-own-worker.mjs', import.meta.url), [], {
    env: { ...process.env, NEX086C_PROVIDER_URL: providerUrl, NEX086C_WORKER_ID: workerId },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  const [message] = await once(child, 'message');
  assert.equal(message.type, 'effect-applied');
  child.kill('SIGKILL');
  const [code, signal] = await once(child, 'exit');
  assert.ok(signal || code !== 0, `worker unexpectedly completed: ${code}`);
  return { message, exit: { code, signal }, stderr: stderr.join('') };
}

const results = [];
const pool = makePool(LAB.jobDatabase);
const provider = await startProviderFixture();
try {
  const listenerRunner = new NexSafeOwnRunner({ pool, providerUrl: provider.url, workerId: 'own-listen', pollMs: 1_000 });
  await listenerRunner.start();
  const startedAt = Date.now();
  const directJob = await createLaboratoryJob(pool, {
    jobId: `own-direct-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  await eventually(async () => {
    assert.equal((await readJob(pool, directJob.jobId)).state, 'succeeded');
  });
  await listenerRunner.stop();
  results.push({ id: 'own-listen-notify', passed: true, latencyMs: Date.now() - startedAt });

  const missedNotifyJob = await createLaboratoryJob(pool, {
    jobId: `own-poll-fallback-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const pollFallbackRunner = new NexSafeOwnRunner({ pool, providerUrl: provider.url, workerId: 'own-poll-fallback', pollMs: 60 });
  const pollStartedAt = Date.now();
  await pollFallbackRunner.start();
  await eventually(async () => {
    assert.equal((await readJob(pool, missedNotifyJob.jobId)).state, 'succeeded');
  });
  await pollFallbackRunner.stop();
  results.push({ id: 'listen-registration-race-poll-fallback', passed: true, latencyMs: Date.now() - pollStartedAt });

  const rollbackId = `rollback-${randomUUID()}`;
  const transactionClient = await pool.connect();
  try {
    await transactionClient.query('begin');
    await createLaboratoryJobInTransaction(transactionClient, { jobId: rollbackId, enqueue: 'direct' });
    await transactionClient.query('rollback');
  } finally {
    transactionClient.release();
  }
  assert.equal(await readJob(pool, rollbackId), null);
  results.push({ id: 'transactional-enqueue-rollback', passed: true });

  const outboxJob = await createLaboratoryJob(pool, { jobId: `outbox-${randomUUID()}`, enqueue: 'outbox' });
  const outboxRunner = new NexSafeOwnRunner({ pool, providerUrl: provider.url, workerId: 'own-outbox', pollMs: 20 });
  await outboxRunner.start();
  assert.deepEqual(await relayOutbox(pool), [outboxJob.jobId]);
  await eventually(async () => assert.equal((await readJob(pool, outboxJob.jobId)).state, 'succeeded'));
  await outboxRunner.stop();
  results.push({ id: 'outbox-relay', passed: true });

  const cancelledJob = await createLaboratoryJob(pool, { jobId: `cancel-${randomUUID()}` });
  await requestCancel(pool, cancelledJob.jobId);
  const cancelRunner = new NexSafeOwnRunner({ pool, providerUrl: provider.url, workerId: 'own-cancel' });
  assert.equal((await cancelRunner.tick()).status, 'idle');
  assert.deepEqual(await provider.counts(cancelledJob.effectKey), { calls: 0, effects: 0 });
  results.push({ id: 'cancel-before-execution', passed: true });

  const crashJob = await createLaboratoryJob(pool, {
    jobId: `crash-no-idempotency-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  const crash = await crashAfterEffect(provider.url, 'own-crash-safe');
  assert.equal(crash.message.jobId, crashJob.jobId);
  assert.deepEqual(await provider.counts(crashJob.effectKey), { calls: 1, effects: 1 });
  assert.equal((await readEvidence(pool, crashJob.jobId)).length, 0);
  assert.equal((await readAttempts(pool, crashJob.jobId))[0].state, 'started');
  await sleep(250);
  assert.equal((await markExpiredForRecovery(pool)).some((job) => job.id === crashJob.jobId), true);
  const classification = await recoverUnknownCompletion(pool, crashJob.jobId);
  assert.equal(classification.classification, 'unknown_completion');
  assert.equal((await readJob(pool, crashJob.jobId)).state, 'blocked_unknown');
  assert.equal(await claimNextJob(pool, 'must-not-claim'), null);
  assert.deepEqual(await provider.counts(crashJob.effectKey), { calls: 1, effects: 1 });
  results.push({ id: 'T5-nex-safe-unknown-completion-no-idempotency', passed: true, crash });

  const rawJob = await createLaboratoryJob(pool, {
    jobId: `raw-redelivery-${randomUUID()}`,
    providerMode: 'non_idempotent',
  });
  await crashAfterEffect(provider.url, 'own-crash-raw');
  assert.deepEqual(await provider.counts(rawJob.effectKey), { calls: 1, effects: 1 });
  await sleep(250);
  await markExpiredForRecovery(pool);
  await unsafeRequeueExpired(pool, rawJob.jobId);
  await unsafeBlindRedelivery(provider.url, rawJob);
  assert.deepEqual(await provider.counts(rawJob.effectKey), { calls: 2, effects: 2 });
  await requestCancel(pool, rawJob.jobId);
  results.push({ id: 'T5-raw-blind-redelivery-duplicates-non-idempotent-effect', passed: true });

  const idempotentJob = await createLaboratoryJob(pool, {
    jobId: `raw-idempotent-${randomUUID()}`,
    providerMode: 'idempotent',
  });
  await crashAfterEffect(provider.url, 'own-crash-idempotent');
  await sleep(250);
  await markExpiredForRecovery(pool);
  await unsafeRequeueExpired(pool, idempotentJob.jobId);
  await unsafeBlindRedelivery(provider.url, idempotentJob);
  assert.deepEqual(await provider.counts(idempotentJob.effectKey), { calls: 2, effects: 1 });
  await requestCancel(pool, idempotentJob.jobId);
  results.push({ id: 'idempotency-key-provider-guarantee-is-effectively-once-not-exactly-once-delivery', passed: true });

  const fencingJob = await createLaboratoryJob(pool, { jobId: `fencing-${randomUUID()}` });
  const ownerA = await claimNextJob(pool, 'worker-A', 20);
  const attemptA = await startOrReadAttempt(pool, fencingJob.jobId, 'worker-A', ownerA.lease_epoch);
  await sleep(35);
  await forceExpireLease(pool, fencingJob.jobId);
  await markExpiredForRecovery(pool);
  await unsafeRequeueExpired(pool, fencingJob.jobId);
  const ownerB = await claimNextJob(pool, 'worker-B', 500);
  assert.ok(ownerB);
  await assert.rejects(
    () => persistEvidenceAndComplete(pool, {
      jobId: fencingJob.jobId,
      attemptId: attemptA.attempt.id,
      workerId: 'worker-A',
      leaseEpoch: ownerA.lease_epoch,
      providerCallId: 'stale-write-must-fail',
    }),
    /fenced/,
  );
  await recoverUnknownCompletion(pool, fencingJob.jobId);
  results.push({ id: 'T9-stale-worker-fencing', passed: true });

  const restartJob = await createLaboratoryJob(pool, { jobId: `postgres-restart-${randomUUID()}` });
  await restartPostgresLaboratory();
  await waitForPostgres(pingPostgres);
  const postRestartPool = makePool(LAB.jobDatabase);
  const restartRunner = new NexSafeOwnRunner({ pool: postRestartPool, providerUrl: provider.url, workerId: 'own-after-pg-restart' });
  await eventually(async () => {
    await restartRunner.tick();
    assert.equal((await readJob(postRestartPool, restartJob.jobId)).state, 'succeeded');
  });
  await postRestartPool.end();
  results.push({ id: 'postgres-restart-rehydration', passed: true });

  const multiJobs = await Promise.all(Array.from({ length: 10 }, (_, index) => createLaboratoryJob(pool, {
    jobId: `multi-${index}-${randomUUID()}`,
  })));
  const runners = [
    new NexSafeOwnRunner({ pool, providerUrl: provider.url, workerId: 'multi-1', pollMs: 10 }),
    new NexSafeOwnRunner({ pool, providerUrl: provider.url, workerId: 'multi-2', pollMs: 10 }),
  ];
  await Promise.all(runners.map((runner) => runner.start()));
  await eventually(async () => {
    const states = await Promise.all(multiJobs.map((job) => readJob(pool, job.jobId)));
    assert.equal(states.filter((job) => job.state === 'succeeded').length, multiJobs.length);
  });
  await Promise.all(runners.map((runner) => runner.stop()));
  for (const job of multiJobs) {
    assert.deepEqual(await provider.counts(job.effectKey), { calls: 1, effects: 1 });
  }
  results.push({ id: 'multi-worker-correctness-2', passed: true, jobs: multiJobs.length });

  const fiveWorkerJobs = await Promise.all(Array.from({ length: 20 }, (_, index) => createLaboratoryJob(pool, {
    jobId: `multi-five-${index}-${randomUUID()}`,
  })));
  const fiveRunners = Array.from({ length: 5 }, (_, index) => new NexSafeOwnRunner({
    pool,
    providerUrl: provider.url,
    workerId: `multi-five-${index + 1}`,
    pollMs: 10,
  }));
  await Promise.all(fiveRunners.map((runner) => runner.start()));
  await eventually(async () => {
    const states = await Promise.all(fiveWorkerJobs.map((job) => readJob(pool, job.jobId)));
    assert.equal(states.filter((job) => job.state === 'succeeded').length, fiveWorkerJobs.length);
  });
  await Promise.all(fiveRunners.map((runner) => runner.stop()));
  for (const job of fiveWorkerJobs) {
    assert.deepEqual(await provider.counts(job.effectKey), { calls: 1, effects: 1 });
  }
  results.push({ id: 'multi-worker-correctness-5', passed: true, jobs: fiveWorkerJobs.length });

  await writeArtifact('own-runner-results.json', { completedAt: new Date().toISOString(), results });
  console.log(JSON.stringify({ runner: 'own', results }, null, 2));
} finally {
  await provider.close();
  await pool.end();
}
