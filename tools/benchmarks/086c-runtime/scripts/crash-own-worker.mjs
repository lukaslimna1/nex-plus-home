import { LAB } from '../src/constants.mjs';
import { makePool } from '../src/db.mjs';
import { NexSafeOwnRunner } from '../src/own-runner.mjs';

const providerUrl = process.env.NEX086C_PROVIDER_URL;
if (!providerUrl) {
  throw new Error('NEX086C_PROVIDER_URL is required');
}

const pool = makePool(LAB.jobDatabase);
const runner = new NexSafeOwnRunner({
  pool,
  providerUrl,
  workerId: process.env.NEX086C_WORKER_ID ?? 'crash-worker',
  leaseMs: 200,
});

await runner.processOne({
  afterEffect: async ({ job, attempt, providerResult }) => {
    process.send?.({ type: 'effect-applied', jobId: job.id, attemptId: attempt.id, providerResult });
    await new Promise(() => undefined);
  },
});
