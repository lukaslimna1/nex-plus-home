import { PgBoss } from 'pg-boss';
import { callProvider } from '../src/provider.mjs';
import { LAB, databaseUrl } from '../src/constants.mjs';
import { makePool } from '../src/db.mjs';
import {
  claimJobById,
  persistEvidenceAndComplete,
  readJob,
  startOrReadAttempt,
} from '../src/nex-store.mjs';
import { handleNexSafeDelivery } from '../src/nex-boundary.mjs';

const queue = process.env.NEX086C_QUEUE;
const role = process.env.NEX086C_ROLE;
const providerUrl = process.env.NEX086C_PROVIDER_URL;
if (!queue || !role || !providerUrl) {
  throw new Error('queue, role, and provider URL are required');
}

const boss = new PgBoss({
  connectionString: databaseUrl(LAB.candidateDatabases[0]),
  schema: 'nex086c_pgboss',
  useListenNotify: true,
  // The parent controller owns the single maintenance/supervision clock in
  // this mini-gate. Multiple supervisors would consume the one retry while
  // racing to reclaim the deliberately frozen Worker A.
  supervise: false,
  schedule: false,
  superviseIntervalSeconds: 1,
  monitorIntervalSeconds: 1,
  maintenanceIntervalSeconds: 1,
});
const jobPool = makePool(LAB.jobDatabase);
const controls = new Map();
let stopping = false;
let activeDeliveryId = null;

function send(message) {
  try {
    process.send?.({ at: new Date().toISOString(), workerRole: role, ...message });
  } catch {
    // The parent may already be tearing down this disposable worker.
  }
}

function waitForControl(name) {
  if (controls.has(name)) {
    controls.delete(name);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    controls.set(name, resolve);
  });
}

function formatJob(job) {
  return job && {
    state: job.state,
    leaseOwner: job.lease_owner,
    leaseEpoch: Number(job.lease_epoch),
    leaseUntil: job.lease_until,
    attemptId: job.attempt_id,
    cancelRequested: job.cancel_requested,
  };
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await boss.stop().catch(() => undefined);
  await jobPool.end().catch(() => undefined);
  process.exit(code);
}

function finish(result) {
  send({ type: 'handler-returned', deliveryId: activeDeliveryId, result });
  send({ type: 'settled', deliveryId: activeDeliveryId, result });
  setTimeout(() => void stop(), 25);
}

process.on('message', (message) => {
  if (message?.type === 'shutdown') {
    void stop();
    return;
  }
  if (message?.type === 'control' && typeof message.name === 'string') {
    const resolver = controls.get(message.name);
    if (resolver) {
      controls.delete(message.name);
      resolver(message.payload);
    } else {
      controls.set(message.name, message.payload ?? true);
    }
  }
});

boss.on('error', (error) => send({ type: 'error', message: error.message, source: 'pgboss' }));
await boss.start();
await boss.work(queue, {
  pollingIntervalSeconds: 0.5,
  notifyPollingIntervalSeconds: 0.5,
  localConcurrency: 1,
  heartbeatRefreshSeconds: 2,
}, async ([delivery]) => {
  activeDeliveryId = delivery.id;
  const jobId = delivery.data?.jobId;
  send({
    type: 'handler-started',
    deliveryId: delivery.id,
    jobId,
    deliveryMetadata: {
      expireInSeconds: delivery.expireInSeconds,
      heartbeatSeconds: delivery.heartbeatSeconds,
    },
  });

  try {
    if (role === 'stale-a' || role === 'pre-dispatch') {
      const workerId = `pgboss-minigate-${role}-${process.pid}`;
      const job = await claimJobById(jobPool, jobId, workerId, 200);
      if (!job) throw new Error(`Worker A could not claim ${jobId}`);
      const { attempt, existing } = await startOrReadAttempt(jobPool, jobId, workerId, job.lease_epoch);
      if (existing) throw new Error(`Worker A unexpectedly rehydrated an existing Attempt for ${jobId}`);
      send({
        type: 'authority-check',
        phase: 'before-dispatch',
        deliveryId: delivery.id,
        job: formatJob(job),
        attemptId: attempt.id,
      });

      await waitForControl('dispatch');
      const beforeEffect = await readJob(jobPool, jobId);
      const authorized = beforeEffect?.state === 'running'
        && beforeEffect.lease_owner === workerId
        && Number(beforeEffect.lease_epoch) === Number(job.lease_epoch)
        && beforeEffect.lease_until
        && new Date(beforeEffect.lease_until).getTime() > Date.now()
        && !beforeEffect.cancel_requested;
      send({
        type: 'authority-check',
        phase: 'last-check-before-provider',
        deliveryId: delivery.id,
        authorized,
        job: formatJob(beforeEffect),
      });

      if (role === 'pre-dispatch' && !authorized) {
        const result = { status: 'dispatch_suppressed', job: formatJob(beforeEffect) };
        send({ type: 'dispatch-suppressed', deliveryId: delivery.id, result });
        finish(result);
        return result;
      }
      if (!authorized) {
        throw new Error('Worker A lost NEX authority before the provider call');
      }

      const providerResult = await callProvider(providerUrl, {
        jobId,
        attemptId: attempt.id,
        effectKey: job.effect_key,
        providerMode: job.provider_mode,
      });
      send({ type: 'effect-applied', deliveryId: delivery.id, attemptId: attempt.id, providerResult });
      // Keep the deliberately orphaned callback alive for the stale Evidence
      // write, but stop this process from fetching its own PG-BOSS retry as a
      // second Worker A. The parent controller starts Worker B explicitly.
      void boss.offWork(queue, { wait: false });
      await waitForControl('release');

      let staleWrite;
      try {
        await persistEvidenceAndComplete(jobPool, {
          jobId,
          attemptId: attempt.id,
          workerId,
          leaseEpoch: job.lease_epoch,
          providerCallId: providerResult.callId,
        });
        staleWrite = { accepted: true };
      } catch (error) {
        staleWrite = { accepted: false, error: error.message };
      }
      send({ type: 'stale-evidence-write', deliveryId: delivery.id, staleWrite });
      const result = { status: staleWrite.accepted ? 'unexpected_evidence_accept' : 'stale_evidence_rejected', staleWrite };
      finish(result);
      return result;
    }

    if (role === 'duplicate') {
      const workerId = `pgboss-minigate-duplicate-${process.pid}`;
      const job = await claimJobById(jobPool, jobId, workerId, 5_000);
      if (!job) {
        const result = await handleNexSafeDelivery({
          pool: jobPool,
          providerUrl,
          jobId,
          workerId,
          leaseMs: 5_000,
        });
        send({ type: 'boundary-result', deliveryId: delivery.id, result });
        finish(result);
        return result;
      }
      const { attempt, existing } = await startOrReadAttempt(jobPool, jobId, workerId, job.lease_epoch);
      if (existing) throw new Error('duplicate worker claimed but found an existing Attempt');
      send({
        type: 'claimed',
        deliveryId: delivery.id,
        job: formatJob(job),
        attemptId: attempt.id,
      });
      await waitForControl('dispatch');
      const providerResult = await callProvider(providerUrl, {
        jobId,
        attemptId: attempt.id,
        effectKey: job.effect_key,
        providerMode: job.provider_mode,
      });
      await persistEvidenceAndComplete(jobPool, {
        jobId,
        attemptId: attempt.id,
        workerId,
        leaseEpoch: job.lease_epoch,
        providerCallId: providerResult.callId,
      });
      const result = { status: 'succeeded', providerResult };
      send({ type: 'boundary-result', deliveryId: delivery.id, result });
      finish(result);
      return result;
    }

    if (role === 'safe' || role === 'recovery-b') {
      const result = await handleNexSafeDelivery({
        pool: jobPool,
        providerUrl,
        jobId,
        workerId: `pgboss-minigate-${role}-${process.pid}`,
        leaseMs: 200,
      });
      send({ type: 'boundary-result', deliveryId: delivery.id, result });
      finish(result);
      return result;
    }

    throw new Error(`unknown mini-gate worker role ${role}`);
  } catch (error) {
    send({ type: 'error', message: error.stack ?? error.message, deliveryId: delivery.id });
    setTimeout(() => void stop(1), 25);
    throw error;
  }
});

send({ type: 'ready' });
