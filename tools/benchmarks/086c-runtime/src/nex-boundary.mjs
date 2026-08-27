import { randomUUID } from 'node:crypto';
import { callProvider } from './provider.mjs';
import {
  claimJobById,
  markExpiredForRecovery,
  persistEvidenceAndComplete,
  readJob,
  recoverUnknownCompletion,
  startOrReadAttempt,
} from './nex-store.mjs';

/**
 * Experimental NEX-safe adapter boundary. It deliberately receives only a
 * durable delivery's `jobId`, rehydrates the laboratory JobStore, and refuses
 * to replay an already-started mutative Attempt after an unknown completion.
 */
export async function handleNexSafeDelivery({
  pool,
  providerUrl,
  jobId,
  workerId = `boundary-${randomUUID()}`,
  leaseMs = 200,
  afterEffect,
}) {
  let job = await claimJobById(pool, jobId, workerId, leaseMs);
  if (!job) {
    await markExpiredForRecovery(pool);
    const existing = await readJob(pool, jobId);
    if (!existing) {
      throw new Error(`NEX-safe boundary received unknown job ${jobId}`);
    }
    // A duplicate wake-up during a valid lease is operational noise, not
    // evidence that the current Attempt reached an unknown completion. Let the
    // current lease owner finish; only an expired/recovery state is eligible
    // for unknown-completion classification.
    if (existing.state === 'running' && existing.lease_until && new Date(existing.lease_until).getTime() > Date.now()) {
      return { status: 'in_flight_elsewhere', job: existing };
    }
    if (existing.attempt_id && existing.state === 'recovery_pending') {
      const recovery = await recoverUnknownCompletion(pool, jobId);
      return { status: 'blocked_unknown', recovery };
    }
    return { status: `not_dispatchable:${existing.state}` };
  }

  const { attempt, existing } = await startOrReadAttempt(pool, jobId, workerId, job.lease_epoch);
  if (existing) {
    const recovery = await recoverUnknownCompletion(pool, jobId);
    return { status: 'blocked_unknown', recovery };
  }

  const providerResult = await callProvider(providerUrl, {
    jobId,
    attemptId: attempt.id,
    effectKey: job.effect_key,
    providerMode: job.provider_mode,
  });
  if (afterEffect) {
    await afterEffect({ job, attempt, providerResult });
  }
  await persistEvidenceAndComplete(pool, {
    jobId,
    attemptId: attempt.id,
    workerId,
    leaseEpoch: job.lease_epoch,
    providerCallId: providerResult.callId,
  });
  return { status: 'succeeded', job, attempt, providerResult };
}
