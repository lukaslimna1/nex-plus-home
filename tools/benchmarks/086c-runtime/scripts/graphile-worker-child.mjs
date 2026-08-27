import { run } from 'graphile-worker';
import { LAB, databaseUrl } from '../src/constants.mjs';
import { makePool } from '../src/db.mjs';
import { handleNexSafeDelivery } from '../src/nex-boundary.mjs';
import { callProvider } from '../src/provider.mjs';

const mode = process.env.NEX086C_MODE;
const providerUrl = process.env.NEX086C_PROVIDER_URL;
const crashAfterEffect = process.env.NEX086C_CRASH_AFTER_EFFECT === '1';
if (!mode || !providerUrl) throw new Error('mode and provider URL are required');

let runner;
const jobPool = mode === 'safe' ? makePool(LAB.jobDatabase) : null;

const taskList = {
  nex086c_delivery: async (payload) => {
    try {
      let result;
      if (mode === 'raw') {
        result = await callProvider(providerUrl, {
          jobId: payload.jobId,
          attemptId: `graphile-raw:${process.pid}`,
          effectKey: payload.effectKey,
          providerMode: payload.providerMode,
        });
        if (crashAfterEffect) {
          process.send?.({ type: 'effect-applied', result });
          await new Promise(() => undefined);
        }
      } else {
        result = await handleNexSafeDelivery({
          pool: jobPool,
          providerUrl,
          jobId: payload.jobId,
          workerId: `graphile-safe:${process.pid}`,
          leaseMs: 200,
          afterEffect: crashAfterEffect
            ? async ({ attempt, providerResult }) => {
                process.send?.({ type: 'effect-applied', attemptId: attempt.id, result: providerResult });
                await new Promise(() => undefined);
              }
            : undefined,
        });
      }
      process.send?.({ type: 'settled', result });
      setTimeout(() => {
        void runner.stop()
          .catch(() => undefined)
          .then(() => jobPool?.end())
          .catch(() => undefined)
          .finally(() => process.exit(0));
      }, 0);
      return result;
    } catch (error) {
      process.send?.({ type: 'error', message: error.stack ?? error.message });
      process.exit(1);
    }
  },
};

runner = await run({
  connectionString: databaseUrl(LAB.jobDatabase),
  schema: 'nex086c_graphile',
  taskList,
  pollInterval: 100,
  concurrency: 1,
  maxPoolSize: 4,
  minResetLockedInterval: 200,
  maxResetLockedInterval: 200,
  noHandleSignals: true,
});
process.send?.({ type: 'ready' });
