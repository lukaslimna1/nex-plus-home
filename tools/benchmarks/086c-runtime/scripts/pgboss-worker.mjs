import { PgBoss } from 'pg-boss';
import { LAB, databaseUrl } from '../src/constants.mjs';
import { makePool } from '../src/db.mjs';
import { handleNexSafeDelivery } from '../src/nex-boundary.mjs';
import { callProvider } from '../src/provider.mjs';

const queue = process.env.NEX086C_QUEUE;
const mode = process.env.NEX086C_MODE;
const providerUrl = process.env.NEX086C_PROVIDER_URL;
const crashAfterEffect = process.env.NEX086C_CRASH_AFTER_EFFECT === '1';
if (!queue || !mode || !providerUrl) {
  throw new Error('queue, mode, and provider URL are required');
}

const boss = new PgBoss({
  connectionString: databaseUrl(LAB.candidateDatabases[0]),
  schema: 'nex086c_pgboss',
  useListenNotify: true,
  supervise: true,
  schedule: false,
  superviseIntervalSeconds: 1,
  monitorIntervalSeconds: 1,
  maintenanceIntervalSeconds: 1,
});
const jobPool = mode === 'safe' ? makePool(LAB.jobDatabase) : null;

boss.on('error', (error) => process.send?.({ type: 'error', message: error.message }));
await boss.start();
await boss.work(queue, {
  pollingIntervalSeconds: 0.5,
  notifyPollingIntervalSeconds: 0.5,
  localConcurrency: 1,
}, async ([delivery]) => {
  try {
    let result;
    if (mode === 'raw') {
      result = await callProvider(providerUrl, {
        jobId: delivery.data.jobId,
        attemptId: `pgboss-raw:${delivery.id}`,
        effectKey: delivery.data.effectKey,
        providerMode: delivery.data.providerMode,
      });
      if (crashAfterEffect) {
        process.send?.({ type: 'effect-applied', deliveryId: delivery.id, result });
        await new Promise(() => undefined);
      }
    } else {
      result = await handleNexSafeDelivery({
        pool: jobPool,
        providerUrl,
        jobId: delivery.data.jobId,
        workerId: `pgboss-safe:${process.pid}`,
        leaseMs: 200,
        afterEffect: crashAfterEffect
          ? async ({ attempt, providerResult }) => {
              process.send?.({ type: 'effect-applied', deliveryId: delivery.id, attemptId: attempt.id, result: providerResult });
              await new Promise(() => undefined);
            }
          : undefined,
      });
    }
    process.send?.({ type: 'settled', deliveryId: delivery.id, result });
    setTimeout(() => {
      void boss.stop()
        .catch(() => undefined)
        .then(() => jobPool?.end())
        .catch(() => undefined)
        .finally(() => process.exit(0));
    }, 0);
    return result;
  } catch (error) {
    process.send?.({ type: 'error', message: error.stack ?? error.message });
    await boss.stop().catch(() => undefined);
    await jobPool?.end().catch(() => undefined);
    process.exit(1);
  }
});
process.send?.({ type: 'ready' });
