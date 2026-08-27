import { postgresAdapter } from '@payloadcms/db-postgres';
import { buildConfig, getPayload } from 'payload';
import { LAB, databaseUrl } from './constants.mjs';
import { makePool } from './db.mjs';
import { handleNexSafeDelivery } from './nex-boundary.mjs';
import { callProvider } from './provider.mjs';

export const PAYLOAD_JOB_TASK = 'nex086c_delivery';

/** Exact Payload 3.88.0, isolated from the NEX application config and DB. */
export async function createPayloadFixture({ mode, providerUrl, crashAfterEffect = false, push = false }) {
  const jobPool = mode === 'safe' ? makePool(LAB.jobDatabase) : null;
  const config = buildConfig({
    secret: 'nex086c-experimental-payload-secret-only-for-disposable-lab',
    collections: [],
    db: postgresAdapter({
      pool: { connectionString: databaseUrl(LAB.candidateDatabases[5]) },
      disableCreateDatabase: true,
      idType: 'uuid',
      push,
    }),
    jobs: {
      autoRun: [],
      deleteJobOnComplete: false,
      tasks: [{
        slug: PAYLOAD_JOB_TASK,
        retries: { attempts: 1, backoff: { delay: 100, type: 'fixed' } },
        handler: async ({ input }) => {
          let result;
          if (mode === 'raw') {
            result = await callProvider(providerUrl, {
              jobId: input.jobId,
              attemptId: `payload-raw:${process.pid}`,
              effectKey: input.effectKey,
              providerMode: input.providerMode,
            });
            if (crashAfterEffect) {
              process.send?.({ type: 'effect-applied', result });
              await new Promise(() => undefined);
            }
          } else {
            result = await handleNexSafeDelivery({
              pool: jobPool,
              providerUrl,
              jobId: input.jobId,
              workerId: `payload-safe:${process.pid}`,
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
          return { output: { status: result.status ?? 'succeeded' } };
        },
      }],
    },
  });
  const payload = await getPayload({ config, key: `nex086c-payload-${process.pid}-${mode}` });
  return {
    payload,
    async close() {
      // Payload 3.88.0's adapter destroy resets its schema state but does not
      // call node-postgres Pool.end(). Its connect helper also retains one
      // checked-out health connection, so release that lab-only client before
      // ending the pool. This reaches node-postgres internals only in the
      // disposable fixture and is recorded as an operational finding.
      const payloadPool = payload.db?.pool;
      await payload.destroy();
      const idleClients = new Set((payloadPool?._idle ?? []).map(({ client }) => client));
      for (const client of payloadPool?._clients ?? []) {
        if (!idleClients.has(client)) client.release?.();
      }
      await payloadPool?.end?.();
      await jobPool?.end();
    },
  };
}
