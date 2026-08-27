import { Absurd } from 'absurd-sdk';
import { LAB, databaseUrl } from '../src/constants.mjs';
import { makePool } from '../src/db.mjs';
import { handleNexSafeDelivery } from '../src/nex-boundary.mjs';
import { callProvider } from '../src/provider.mjs';

const mode = process.env.NEX086C_MODE;
const providerUrl = process.env.NEX086C_PROVIDER_URL;
const crashAfterEffect = process.env.NEX086C_CRASH_AFTER_EFFECT === '1';
const queue = 'nex086c_delivery';
if (!mode || !providerUrl) throw new Error('mode and provider URL are required');

const jobPool = mode === 'safe' ? makePool(LAB.jobDatabase) : null;
const app = new Absurd({ db: databaseUrl(LAB.candidateDatabases[4]), queueName: queue, defaultMaxAttempts: 2 });

app.registerTask({ name: 'nex086c_delivery', queue, defaultMaxAttempts: 2 }, async (params, ctx) => {
  if (params.kind === 'sleep') {
    await ctx.sleepFor('durable-sleep', 0.3);
    const result = { status: 'slept', taskId: ctx.taskID };
    process.send?.({ type: 'settled', result });
    return result;
  }
  if (params.kind === 'wait-before') {
    await ctx.step('announce-before-wait', () => {
      process.send?.({ type: 'pre-wait', taskId: ctx.taskID });
      return null;
    });
    await ctx.sleepFor('delay-before-wait', 0.3);
    const received = await ctx.awaitEvent(params.eventName, { stepName: 'approval-wait', timeout: 2 });
    const result = { status: 'received', received };
    process.send?.({ type: 'settled', result });
    return result;
  }
  if (params.kind === 'wait-after') {
    process.send?.({ type: 'waiting', taskId: ctx.taskID });
    const received = await ctx.awaitEvent(params.eventName, { stepName: 'approval-wait', timeout: 2 });
    const result = { status: 'received', received };
    process.send?.({ type: 'settled', result });
    return result;
  }

  const result = await ctx.step('mutating-delivery', async () => {
    if (mode === 'raw') {
      const providerResult = await callProvider(providerUrl, {
        jobId: params.jobId,
        attemptId: `absurd-raw:${ctx.taskID}`,
        effectKey: params.effectKey,
        providerMode: params.providerMode,
      });
      if (crashAfterEffect) {
        process.send?.({ type: 'effect-applied', result: providerResult });
        await new Promise(() => undefined);
      }
      return providerResult;
    }
    return handleNexSafeDelivery({
      pool: jobPool,
      providerUrl,
      jobId: params.jobId,
      workerId: `absurd-safe:${process.pid}`,
      leaseMs: 200,
      afterEffect: crashAfterEffect
        ? async ({ attempt, providerResult }) => {
            process.send?.({ type: 'effect-applied', attemptId: attempt.id, result: providerResult });
            await new Promise(() => undefined);
          }
        : undefined,
    });
  });
  process.send?.({ type: 'settled', result });
  return result;
});

await app.startWorker({
  workerId: 'nex086c-absurd-worker',
  claimTimeout: 1,
  batchSize: 1,
  concurrency: 1,
  pollInterval: 0.1,
  fatalOnLeaseTimeout: false,
  onError: (error) => process.send?.({ type: 'error', message: error.stack ?? error.message }),
});
process.send?.({ type: 'ready' });

process.on('message', async (command) => {
  try {
    if (command.type === 'start') {
      const started = await app.spawn('nex086c_delivery', command.payload, {
        queue,
        maxAttempts: 2,
        retryStrategy: { kind: 'fixed', baseSeconds: 0.1 },
        idempotencyKey: command.idempotencyKey,
      });
      process.send?.({ type: 'started', taskId: started.taskID, runId: started.runID });
    }
    if (command.type === 'shutdown') {
      await app.close();
      await jobPool?.end();
      process.exit(0);
    }
  } catch (error) {
    process.send?.({ type: 'error', message: error.stack ?? error.message });
  }
});
