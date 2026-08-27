import { DBOS } from '@dbos-inc/dbos-sdk';
import { LAB, databaseUrl } from '../src/constants.mjs';
import { makePool } from '../src/db.mjs';
import { handleNexSafeDelivery } from '../src/nex-boundary.mjs';
import { callProvider } from '../src/provider.mjs';

const mode = process.env.NEX086C_MODE;
const providerUrl = process.env.NEX086C_PROVIDER_URL;
const crashAfterEffect = process.env.NEX086C_CRASH_AFTER_EFFECT === '1';
const applicationName = 'nex086c_dbos_benchmark';
const queueName = 'nex086c_delivery';
if (!mode || !providerUrl) throw new Error('mode and provider URL are required');

const jobPool = mode === 'safe' ? makePool(LAB.jobDatabase) : null;

DBOS.setConfig({
  name: applicationName,
  applicationVersion: '0.0.0-experimental',
  // Recovery is scoped by executor ID in the local SDK. A stable deployment
  // identity is therefore intentional here: this child simulates a process
  // restart of the same worker, not a different fleet member.
  executorID: 'nex086c-dbos-restart-worker',
  systemDatabaseUrl: databaseUrl(LAB.candidateDatabases[2]),
  systemDatabaseSchemaName: 'nex086c_dbos',
  systemDatabasePoolSize: 8,
  systemDatabasePollingConcurrency: 2,
  schedulerPollingIntervalMs: 100,
  maxConcurrentQueueDispatches: 1,
  useListenNotify: true,
  notificationCoalesceMs: 1,
  runMigrations: true,
  logLevel: 'warn',
});

async function deliveryWorkflow(payload) {
  if (payload.kind === 'sleep') {
    await DBOS.sleep(300);
    const result = { status: 'slept', workflowId: DBOS.workflowID };
    process.send?.({ type: 'settled', result });
    return result;
  }
  if (payload.kind === 'wait-before') {
    process.send?.({ type: 'pre-wait', workflowId: DBOS.workflowID });
    await DBOS.sleep(300);
    const message = await DBOS.recv('approval', 2);
    const result = { status: 'received', message };
    process.send?.({ type: 'settled', result });
    return result;
  }
  if (payload.kind === 'wait-after') {
    process.send?.({ type: 'waiting', workflowId: DBOS.workflowID });
    const message = await DBOS.recv('approval', 2);
    const result = { status: 'received', message };
    process.send?.({ type: 'settled', result });
    return result;
  }

  const result = await DBOS.runStep(async () => {
    if (mode === 'raw') {
      const providerResult = await callProvider(providerUrl, {
        jobId: payload.jobId,
        attemptId: `dbos-raw:${DBOS.workflowID}`,
        effectKey: payload.effectKey,
        providerMode: payload.providerMode,
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
      jobId: payload.jobId,
      workerId: `dbos-safe:${process.pid}`,
      leaseMs: 200,
      afterEffect: crashAfterEffect
        ? async ({ attempt, providerResult }) => {
            process.send?.({ type: 'effect-applied', attemptId: attempt.id, result: providerResult });
            await new Promise(() => undefined);
          }
        : undefined,
    });
  }, { name: 'nex086c_mutating_delivery' });
  process.send?.({ type: 'settled', result });
  return result;
}

const delivery = DBOS.registerWorkflow(deliveryWorkflow, { name: 'nex086c_delivery' });

await DBOS.launch();
await DBOS.registerQueue(queueName, {
  globalConcurrency: 1,
  workerConcurrency: 1,
  minPollingIntervalMs: 50,
  onConflict: 'always_update',
});
process.send?.({ type: 'ready' });

process.on('message', async (command) => {
  try {
    if (command.type === 'start') {
      await DBOS.startWorkflow(delivery, {
        workflowID: command.workflowId,
        queueName,
      })(command.payload);
      process.send?.({ type: 'started', workflowId: command.workflowId });
    }
    if (command.type === 'shutdown') {
      await DBOS.shutdown({ deregister: true, workflowCompletionTimeoutMS: 100 });
      await jobPool?.end();
      process.exit(0);
    }
  } catch (error) {
    process.send?.({ type: 'error', message: error.stack ?? error.message });
  }
});
