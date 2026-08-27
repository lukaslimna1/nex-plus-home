import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { LAB, databaseUrl } from './constants.mjs';
import { makePool } from './db.mjs';

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function applyMutation(pool, input) {
  const { jobId, attemptId, effectKey, providerMode } = input;
  if (!['idempotent', 'non_idempotent'].includes(providerMode)) {
    throw new Error('providerMode must be idempotent or non_idempotent');
  }

  const client = await pool.connect();
  const callId = randomUUID();
  const payloadHash = hash(input);
  try {
    await client.query('begin');
    await client.query(
      'insert into provider_calls (id, job_id, attempt_id, effect_key, provider_mode, payload_hash) values ($1, $2, $3, $4, $5, $6)',
      [callId, jobId, attemptId, effectKey, providerMode, payloadHash],
    );

    let applied = true;
    if (providerMode === 'idempotent') {
      const idempotency = await client.query(
        'insert into provider_idempotency (effect_key, first_call_id) values ($1, $2) on conflict do nothing returning effect_key',
        [effectKey, callId],
      );
      applied = idempotency.rowCount === 1;
    }

    let effectId = null;
    if (applied) {
      effectId = randomUUID();
      await client.query(
        'insert into provider_effects (id, call_id, effect_key, payload_hash) values ($1, $2, $3, $4)',
        [effectId, callId, effectKey, payloadHash],
      );
    }
    await client.query('commit');
    return { callId, effectId, applied };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function startProviderFixture() {
  const pool = makePool(LAB.providerDatabase);
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'POST' && request.url === '/mutate') {
        const result = await applyMutation(pool, await readJson(request));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
        return;
      }

      if (request.method === 'GET' && request.url?.startsWith('/counts')) {
        const url = new URL(request.url, 'http://127.0.0.1');
        const effectKey = url.searchParams.get('effectKey');
        const result = await providerCounts(pool, effectKey);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('provider fixture did not receive a TCP port');
  }
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await pool.end();
    },
    counts(effectKey) {
      return providerCounts(pool, effectKey);
    },
  };
}

export async function callProvider(providerUrl, input) {
  const response = await fetch(`${providerUrl}/mutate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`provider fixture rejected mutation: ${body.error ?? response.status}`);
  }
  return body;
}

export async function providerCounts(pool, effectKey = null) {
  const filter = effectKey ? 'where effect_key = $1' : '';
  const values = effectKey ? [effectKey] : [];
  const [calls, effects] = await Promise.all([
    pool.query(`select count(*)::int as count from provider_calls ${filter}`, values),
    pool.query(`select count(*)::int as count from provider_effects ${filter}`, values),
  ]);
  return { calls: calls.rows[0].count, effects: effects.rows[0].count };
}

export const PROVIDER_DATABASE_URL = databaseUrl(LAB.providerDatabase);
