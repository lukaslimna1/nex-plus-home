import pg from 'pg';
import { LAB, assertLaboratoryDatabase, databaseUrl } from './constants.mjs';

const { Pool } = pg;

export function makePool(database) {
  const pool = new Pool({
    connectionString: databaseUrl(database),
    max: 12,
    application_name: 'nex086c-runtime-benchmark',
  });
  // A PostgreSQL restart is an intentional chaos scenario. Individual queries
  // still fail and are observed by the harness; idle-client errors must not
  // terminate the parent process before it can record that behavior.
  pool.on('error', () => undefined);
  return pool;
}

export async function pingPostgres() {
  const pool = makePool(LAB.adminDatabase);
  try {
    await pool.query('select 1');
  } finally {
    await pool.end();
  }
}

export async function recreateDatabase(database) {
  assertLaboratoryDatabase(database);
  const pool = makePool(LAB.adminDatabase);
  try {
    await pool.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [database],
    );
    await pool.query(`drop database if exists ${database}`);
    await pool.query(`create database ${database}`);
  } finally {
    await pool.end();
  }
}

export async function dropDatabase(database) {
  assertLaboratoryDatabase(database);
  const pool = makePool(LAB.adminDatabase);
  try {
    await pool.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [database],
    );
    await pool.query(`drop database if exists ${database}`);
  } finally {
    await pool.end();
  }
}

export async function initializeJobStore() {
  const pool = makePool(LAB.jobDatabase);
  try {
    await pool.query(`
      create table bench_jobs (
        id text primary key,
        state text not null check (state in ('queued', 'running', 'recovery_pending', 'blocked_unknown', 'succeeded', 'cancelled', 'paused')),
        revision integer not null default 0,
        lease_owner text,
        lease_epoch bigint not null default 0,
        lease_until timestamptz,
        attempt_id text,
        effect_key text not null,
        provider_mode text not null check (provider_mode in ('idempotent', 'non_idempotent')),
        pause_requested boolean not null default false,
        cancel_requested boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index bench_jobs_claim_idx on bench_jobs (state, created_at) where state = 'queued';
      create index bench_jobs_lease_idx on bench_jobs (lease_until) where state = 'running';

      create table bench_attempts (
        id text primary key,
        job_id text not null references bench_jobs(id),
        state text not null check (state in ('started', 'unknown_completion', 'succeeded', 'cancelled')),
        created_at timestamptz not null default now(),
        terminal_at timestamptz,
        unique (job_id, id)
      );

      create table bench_evidence (
        id bigserial primary key,
        job_id text not null references bench_jobs(id),
        attempt_id text not null references bench_attempts(id),
        provider_call_id text not null,
        observed_effect boolean not null,
        created_at timestamptz not null default now(),
        unique (attempt_id)
      );

      create table bench_deliveries (
        id bigserial primary key,
        job_id text not null references bench_jobs(id),
        kind text not null,
        created_at timestamptz not null default now()
      );

      create table bench_outbox (
        id bigserial primary key,
        job_id text not null references bench_jobs(id),
        published_at timestamptz,
        created_at timestamptz not null default now()
      );

      create table bench_signals (
        id bigserial primary key,
        job_id text not null references bench_jobs(id),
        signal_key text not null,
        payload jsonb,
        created_at timestamptz not null default now(),
        unique (job_id, signal_key)
      );
    `);
  } finally {
    await pool.end();
  }
}

export async function initializeProviderStore() {
  const pool = makePool(LAB.providerDatabase);
  try {
    await pool.query(`
      create table provider_calls (
        id uuid primary key,
        job_id text not null,
        attempt_id text not null,
        effect_key text not null,
        provider_mode text not null check (provider_mode in ('idempotent', 'non_idempotent')),
        payload_hash text not null,
        created_at timestamptz not null default now()
      );
      create table provider_effects (
        id uuid primary key,
        call_id uuid not null references provider_calls(id),
        effect_key text not null,
        payload_hash text not null,
        created_at timestamptz not null default now()
      );
      create table provider_idempotency (
        effect_key text primary key,
        first_call_id uuid not null references provider_calls(id),
        created_at timestamptz not null default now()
      );
    `);
  } finally {
    await pool.end();
  }
}

export async function queryRows(database, text, values = []) {
  const pool = makePool(database);
  try {
    return (await pool.query(text, values)).rows;
  } finally {
    await pool.end();
  }
}
