import { OpenWorkflow } from 'openworkflow';
import { BackendPostgres } from 'openworkflow/postgres';
import { LAB, databaseUrl } from '../src/constants.mjs';
import { makePool } from '../src/db.mjs';
import { handleNexSafeDelivery } from '../src/nex-boundary.mjs';
import { callProvider } from '../src/provider.mjs';

const mode = process.env.NEX086C_MODE;
const providerUrl = process.env.NEX086C_PROVIDER_URL;
const crashAfterEffect = process.env.NEX086C_CRASH_AFTER_EFFECT === '1';
const schema = 'nex086c_openworkflow';
if (!mode || !providerUrl) throw new Error('mode and provider URL are required');

const jobPool = mode === 'safe' ? makePool(LAB.jobDatabase) : null;
const backend = await BackendPostgres.connect(databaseUrl(LAB.candidateDatabases[3]), {
  schema,
  namespaceId: 'nex086c-openworkflow-benchmark',
  runMigrations: true,
});
const ow = new OpenWorkflow({ backend });

const delivery = ow.defineWorkflow({
  name: 'nex086c_delivery',
  retryPolicy: {
    initialInterval: '100ms',
    backoffCoefficient: 1,
    maximumInterval: '100ms',
    maximumAttempts: 2,
  },
}, async ({ input, step, run }) => {
  if (input.kind === 'sleep') {
    await step.sleep('durable-sleep', '300ms');
    const result = { status: 'slept', workflowRunId: run.id };
    process.send?.({ type: 'settled', result });
    return result;
  }
  if (input.kind === 'wait-before') {
    await step.run({ name: 'announce-before-wait' }, () => {
      process.send?.({ type: 'pre-wait', workflowRunId: run.id });
      return null;
    });
    await step.sleep('delay-before-wait', '300ms');
    const received = await step.waitForSignal({ name: 'approval-wait', signal: input.signal, timeout: 1_000 });
    const result = { status: 'wait-complete', received: received?.data ?? null };
    process.send?.({ type: 'settled', result });
    return result;
  }
  if (input.kind === 'wait-after') {
    process.send?.({ type: 'waiting', workflowRunId: run.id });
    const received = await step.waitForSignal({ name: 'approval-wait', signal: input.signal, timeout: 2_000 });
    const result = { status: 'wait-complete', received: received?.data ?? null };
    process.send?.({ type: 'settled', result });
    return result;
  }

  const result = await step.run({ name: 'mutating-delivery' }, async () => {
    if (mode === 'raw') {
      const providerResult = await callProvider(providerUrl, {
        jobId: input.jobId,
        attemptId: `openworkflow-raw:${run.id}`,
        effectKey: input.effectKey,
        providerMode: input.providerMode,
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
      jobId: input.jobId,
      workerId: `openworkflow-safe:${process.pid}`,
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

const worker = ow.newWorker({ concurrency: 1 });
await worker.start();
process.send?.({ type: 'ready' });

process.on('message', async (command) => {
  try {
    if (command.type === 'start') {
      const handle = await delivery.run(command.payload, { idempotencyKey: command.idempotencyKey });
      process.send?.({ type: 'started', workflowRunId: handle.workflowRun.id });
    }
    if (command.type === 'shutdown') {
      await worker.stop();
      await backend.stop();
      await jobPool?.end();
      process.exit(0);
    }
  } catch (error) {
    process.send?.({ type: 'error', message: error.stack ?? error.message });
  }
});
