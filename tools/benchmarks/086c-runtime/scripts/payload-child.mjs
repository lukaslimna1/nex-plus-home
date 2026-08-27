import { createPayloadFixture, PAYLOAD_JOB_TASK } from '../src/payload-fixture.mjs';

const mode = process.env.NEX086C_MODE;
const providerUrl = process.env.NEX086C_PROVIDER_URL;
const crashAfterEffect = process.env.NEX086C_CRASH_AFTER_EFFECT === '1';
if (!mode || !providerUrl) throw new Error('mode and provider URL are required');

const fixture = await createPayloadFixture({ mode, providerUrl, crashAfterEffect, push: false });
const { payload } = fixture;
process.send?.({ type: 'ready' });

async function queue(payloadInput, waitUntil, requestId) {
  const job = await payload.jobs.queue({
    task: PAYLOAD_JOB_TASK,
    input: payloadInput,
    queue: 'default',
    waitUntil: waitUntil ? new Date(waitUntil) : undefined,
  });
  process.send?.({ type: 'queued', jobId: job.id, requestId });
  return job;
}

async function run() {
  const result = await payload.jobs.run({ allQueues: true, limit: 1, sequential: true, silent: true });
  process.send?.({ type: 'run-finished', result });
  return result;
}

process.on('message', async (command) => {
  try {
    if (command.type === 'queue') await queue(command.payload, command.waitUntil, command.requestId);
    if (command.type === 'run') await run();
    if (command.type === 'queue-and-run') {
      await queue(command.payload, command.waitUntil, command.requestId);
      await run();
    }
    if (command.type === 'cancel') {
      await payload.jobs.cancelByID({ id: command.jobId });
      process.send?.({ type: 'cancelled', jobId: command.jobId, requestId: command.requestId });
    }
    if (command.type === 'shutdown') {
      await fixture.close();
      process.exit(0);
    }
  } catch (error) {
    process.send?.({ type: 'error', message: error.stack ?? error.message });
  }
});
