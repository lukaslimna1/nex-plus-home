import { randomUUID } from 'node:crypto';
import { LAB } from './constants.mjs';
import { callProvider } from './provider.mjs';
import {
  claimNextJob,
  markExpiredForRecovery,
  persistEvidenceAndComplete,
  recoverUnknownCompletion,
  startOrReadAttempt,
} from './nex-store.mjs';

export class NexSafeOwnRunner {
  constructor({ pool, providerUrl, workerId = `own-${randomUUID()}`, leaseMs = 500, pollMs = 100 }) {
    this.pool = pool;
    this.providerUrl = providerUrl;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
    this.pollMs = pollMs;
    this.listener = null;
    this.timer = null;
    this.ticking = false;
  }

  async start() {
    this.listener = await this.pool.connect();
    this.listener.on('notification', (message) => {
      if (message.channel === LAB.notifyChannel) {
        void this.tick();
      }
    });
    await this.listener.query(`listen ${LAB.notifyChannel}`);
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.listener) {
      await this.listener.query(`unlisten ${LAB.notifyChannel}`).catch(() => undefined);
      this.listener.release();
      this.listener = null;
    }
  }

  async tick(options = {}) {
    if (this.ticking) {
      return { status: 'already_ticking' };
    }
    this.ticking = true;
    try {
      return await this.processOne(options);
    } finally {
      this.ticking = false;
    }
  }

  async processOne({ afterEffect } = {}) {
    const job = await claimNextJob(this.pool, this.workerId, this.leaseMs);
    if (!job) {
      return { status: 'idle' };
    }
    if (job.cancel_requested) {
      return { status: 'cancel_requested_before_dispatch', jobId: job.id };
    }
    const { attempt, existing } = await startOrReadAttempt(this.pool, job.id, this.workerId, job.lease_epoch);
    if (existing) {
      const recovery = await recoverUnknownCompletion(this.pool, job.id);
      return { status: 'blocked_unknown', jobId: job.id, recovery };
    }

    const providerResult = await callProvider(this.providerUrl, {
      jobId: job.id,
      attemptId: attempt.id,
      effectKey: job.effect_key,
      providerMode: job.provider_mode,
    });

    if (afterEffect) {
      await afterEffect({ job, attempt, providerResult });
    }

    await persistEvidenceAndComplete(this.pool, {
      jobId: job.id,
      attemptId: attempt.id,
      workerId: this.workerId,
      leaseEpoch: job.lease_epoch,
      providerCallId: providerResult.callId,
    });
    return { status: 'succeeded', jobId: job.id, attemptId: attempt.id, providerResult };
  }

  async reaper() {
    return markExpiredForRecovery(this.pool);
  }
}

export async function unsafeBlindRedelivery(providerUrl, { jobId, effectKey, providerMode }) {
  return callProvider(providerUrl, {
    jobId,
    attemptId: `unsafe-redelivery:${randomUUID()}`,
    effectKey,
    providerMode,
  });
}
