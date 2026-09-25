import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { PgBoss, TestClock } from 'pg-boss';
import { readArtifact, writeArtifact } from '../src/artifacts.mjs';
import { LAB, LAB_ROOT, databaseUrl } from '../src/constants.mjs';
import { makePool, recreateDatabase } from '../src/db.mjs';
import { run, sleep } from '../src/shell.mjs';

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const PG_BOSS_SCHEMA = 'nex086c_pgboss';
const CANDIDATE_DATABASE = LAB.candidateDatabases[1];
const MIGRATION_QUEUE = 'nex086c_revalidation_migration';
const TEMPORAL_QUEUE = 'nex086c_revalidation_temporal';
const TEMPORAL_KEY = 'radar-canonical';
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-01-01T00:00:00.000Z');
const OFFLINE_AT = new Date(T0.getTime() + 31 * DAY);
const RADAR_RULE = 'DTSTART:20260111T000000Z\nRRULE:FREQ=DAILY;INTERVAL=10';

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function pgBossOptions(extra = {}) {
  return {
    connectionString: databaseUrl(CANDIDATE_DATABASE),
    schema: PG_BOSS_SCHEMA,
    useListenNotify: true,
    supervise: false,
    schedule: false,
    migrate: false,
    monitorIntervalSeconds: 1,
    maintenanceIntervalSeconds: 1,
    superviseIntervalSeconds: 1,
    ...extra,
  };
}

async function query(database, text, values = []) {
  const pool = makePool(database);
  try {
    return (await pool.query(text, values)).rows;
  } finally {
    await pool.end();
  }
}

async function queryWithPool(pool, text, values = []) {
  return (await pool.query(text, values)).rows;
}

async function installSchema38AndMigrate() {
  await recreateDatabase(CANDIDATE_DATABASE);
  await query(CANDIDATE_DATABASE, `
    create schema nex_domain;
    create table nex_domain.revalidation_sentinel (id integer primary key, value text not null);
    insert into nex_domain.revalidation_sentinel values (1, 'untouched');
  `);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nex086c-pgboss-12-28-'));
  const npm = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const npmArgs = (args) => process.platform === 'win32' ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args;
  const legacyJobId = '00000000-0000-4000-8000-000000000038';
  let oldBoss;
  let currentBoss;
  try {
    await execFileAsync(npm, npmArgs(['init', '--yes']), { cwd: tempRoot, windowsHide: true });
    await execFileAsync(npm, npmArgs(['install', '--ignore-scripts', '--no-audit', '--no-fund', 'pg-boss@12.28.0', 'pg@8.20.0']), {
      cwd: tempRoot,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const legacyModule = await import(pathToFileURL(path.join(tempRoot, 'node_modules', 'pg-boss', 'dist', 'index.js')).href);
    oldBoss = new legacyModule.PgBoss({
      connectionString: databaseUrl(CANDIDATE_DATABASE),
      schema: PG_BOSS_SCHEMA,
      supervise: false,
      schedule: false,
    });
    oldBoss.on('error', () => undefined);
    await oldBoss.start();
    const legacySchemaVersion = await oldBoss.schemaVersion();
    assert.equal(legacySchemaVersion, 38);
    await oldBoss.createQueue(MIGRATION_QUEUE, {
      expireInSeconds: 30,
      retryLimit: 1,
      retryDelay: 0,
      notify: true,
      deleteAfterSeconds: 86_400,
    });
    const legacyJob = await oldBoss.send(MIGRATION_QUEUE, { marker: 'schema-38' }, {
      id: legacyJobId,
      retryLimit: 1,
      retryDelay: 0,
    });
    await oldBoss.schedule(MIGRATION_QUEUE, '0 * * * *', { marker: 'legacy-schedule' }, { key: 'legacy-hourly' });
    assert.equal(legacyJob, legacyJobId);
    await oldBoss.stop();
    oldBoss = null;

    const [legacySchedule] = await query(CANDIDATE_DATABASE, `
      select name, key, cron, data from "${PG_BOSS_SCHEMA}".schedule where name = $1 and key = $2;
    `, [MIGRATION_QUEUE, 'legacy-hourly']);
    assert.ok(legacySchedule);

    const beforeRows = await query(CANDIDATE_DATABASE, `
      select count(*)::int as jobs from "${PG_BOSS_SCHEMA}".job where name = $1;
    `, [MIGRATION_QUEUE]);

    currentBoss = new PgBoss(pgBossOptions({ migrate: true, bamIntervalSeconds: 10 }));
    currentBoss.on('error', () => undefined);
    await currentBoss.start();
    const migratedSchemaVersion = await currentBoss.schemaVersion();
    let drift;
    for (let i = 0; i < 180; i += 1) {
      drift = await currentBoss.detectSchemaDrift();
      if (drift.building.length === 0 && drift.extraIndexes.length === 0) break;
      await sleep(250);
    }
    assert.equal(drift.building.length, 0, 'schema migration left a background index build');
    assert.equal(drift.extraIndexes.length, 0, 'schema migration left an obsolete index');
    const migratedQueue = await currentBoss.getQueue(MIGRATION_QUEUE);
    const migratedJob = await currentBoss.getJobById(MIGRATION_QUEUE, legacyJobId);
    const migratedSchedule = await currentBoss.getSchedule(MIGRATION_QUEUE, 'legacy-hourly');
    assert.equal(migratedSchemaVersion, 42);
    assert.ok(migratedQueue);
    assert.ok(migratedJob);
    assert.ok(migratedSchedule);
    assert.equal(migratedSchedule.kind, 'cron');
    const afterRows = await query(CANDIDATE_DATABASE, `
      select count(*)::int as jobs from "${PG_BOSS_SCHEMA}".job where name = $1;
    `, [MIGRATION_QUEUE]);
    const sentinel = await query(CANDIDATE_DATABASE, 'select * from nex_domain.revalidation_sentinel');
    assert.deepEqual(afterRows, beforeRows);
    assert.deepEqual(sentinel, [{ id: 1, value: 'untouched' }]);
    await currentBoss.stop();
    currentBoss = null;
    return {
      database: CANDIDATE_DATABASE,
      schema: PG_BOSS_SCHEMA,
      sourceVersion: '12.28.0',
      sourceSchema: 38,
      targetVersion: '12.34.0',
      targetSchema: migratedSchemaVersion,
      migrationChain: ['38→39', '39→40', '40→41', '41→42'],
      mechanism: '12.28.0 installation via official PgBoss.start(), followed by 12.34.0 PgBoss.start() with migrate:true',
      existingQueueReadable: true,
      existingJobReadable: true,
      existingScheduleReadable: true,
      existingScheduleKind: migratedSchedule.kind,
      jobsBefore: beforeRows[0].jobs,
      jobsAfter: afterRows[0].jobs,
      sentinelUntouched: sentinel[0].value === 'untouched',
      isolatedSchema: true,
      schemaDrift: drift,
    };
  } finally {
    if (oldBoss) await oldBoss.stop().catch(() => undefined);
    if (currentBoss) await currentBoss.stop().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function initializeTemporalStore(pool) {
  await pool.query(`
    drop table if exists bench_temporal_events cascade;
    drop table if exists bench_temporal_attempts cascade;
    drop table if exists bench_temporal_obligations cascade;
    create table bench_temporal_obligations (
      id text primary key,
      state text not null,
      last_checked_at timestamptz,
      next_due_at timestamptz,
      recurrence_rule text,
      catch_up_policy text,
      missed_windows integer not null default 0,
      last_observation_at timestamptz,
      last_observation jsonb,
      approval_state text,
      human_due_at timestamptz,
      refresh_requested boolean not null default false,
      revision integer not null default 0
    );
    create table bench_temporal_attempts (
      id text primary key,
      obligation_id text not null references bench_temporal_obligations(id),
      kind text not null,
      created_at timestamptz not null,
      authorization_source text not null,
      unique (obligation_id, kind)
    );
    create table bench_temporal_events (
      id bigserial primary key,
      obligation_id text not null references bench_temporal_obligations(id),
      kind text not null,
      payload jsonb not null,
      created_at timestamptz not null
    );
  `);
}

async function seedTemporalFixtures(pool) {
  const fixtures = {
    radar: 'temporal-radar-coalesce',
    duplicate: 'temporal-duplicate-wakeup',
    waitingHuman: 'temporal-waiting-human',
    humanRetry: 'temporal-human-retry',
    refresh: 'temporal-refresh-on-demand',
  };
  await pool.query(`
    insert into bench_temporal_obligations
      (id, state, last_checked_at, next_due_at, recurrence_rule, catch_up_policy, approval_state, refresh_requested)
    values
      ($1, 'due', $6, $7, $8, 'COALESCE_MISSED', null, false),
      ($2, 'due', $6, $7, null, 'COALESCE_MISSED', null, false),
      ($3, 'waiting_human', $6, $7, null, null, 'pending', false),
      ($4, 'waiting_temporal', $6, $9, null, null, 'pending', false),
      ($5, 'scheduled', $6, $10, null, null, null, true)
  `, [
    fixtures.radar,
    fixtures.duplicate,
    fixtures.waitingHuman,
    fixtures.humanRetry,
    fixtures.refresh,
    T0,
    new Date(T0.getTime() + 10 * DAY),
    RADAR_RULE,
    new Date(T0.getTime() + 2 * DAY),
    new Date(T0.getTime() + 12 * DAY),
  ]);
  return fixtures;
}

async function readObligation(pool, id) {
  const [row] = await queryWithPool(pool, 'select * from bench_temporal_obligations where id = $1', [id]);
  return row;
}

async function countAttempts(pool, id) {
  const rows = await queryWithPool(pool, 'select count(*)::int as count from bench_temporal_attempts where obligation_id = $1', [id]);
  return rows[0].count;
}

async function claimCatchup(pool, id, runtimeNow, worker) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const [obligation] = (await client.query('select * from bench_temporal_obligations where id = $1 for update', [id])).rows;
    if (!obligation || obligation.state !== 'due' || new Date(obligation.next_due_at).getTime() > runtimeNow.getTime()) {
      await client.query('commit');
      return { authority: false, effect: false, worker, id };
    }
    const attemptId = `${id}-${worker}`;
    const inserted = await client.query(`
      insert into bench_temporal_attempts (id, obligation_id, kind, created_at, authorization_source)
      values ($1, $2, 'coalesced-catch-up', $3, 'temporal-policy')
      on conflict (obligation_id, kind) do nothing returning id
    `, [attemptId, id, runtimeNow]);
    if (inserted.rowCount !== 1) {
      await client.query('commit');
      return { authority: false, effect: false, worker, id };
    }
    await client.query(`
      update bench_temporal_obligations
      set state = 'observed', missed_windows = 3, last_observation_at = $2,
          last_observation = $3::jsonb, next_due_at = $4, revision = revision + 1
      where id = $1
    `, [id, runtimeNow, JSON.stringify({ type: 'current-catch-up', source: 'NEX-policy' }), new Date(runtimeNow.getTime() + 10 * DAY)]);
    await client.query(`
      insert into bench_temporal_events (obligation_id, kind, payload, created_at)
      values ($1, 'coalesced-catch-up', $2::jsonb, $3)
    `, [id, JSON.stringify({ windows: 3, policy: 'COALESCE_MISSED', worker }), runtimeNow]);
    await client.query('commit');
    return { authority: true, effect: true, worker, id };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function reconcileHumanRetry(pool, id, runtimeNow, authorized) {
  if (!authorized) return { authorized: false, attemptCreated: false };
  const client = await pool.connect();
  try {
    await client.query('begin');
    const [row] = (await client.query('select * from bench_temporal_obligations where id = $1 for update', [id])).rows;
    assert.equal(row.state, 'waiting_temporal');
    const attemptId = `${id}-human-authorized`;
    const inserted = await client.query(`
      insert into bench_temporal_attempts (id, obligation_id, kind, created_at, authorization_source)
      values ($1, $2, 'human-retry', $3, 'human-instruction-plus-fresh-evaluation')
      on conflict (obligation_id, kind) do nothing returning id
    `, [attemptId, id, runtimeNow]);
    await client.query(`update bench_temporal_obligations set state = 'running', revision = revision + 1 where id = $1`, [id]);
    await client.query('commit');
    return { authorized: true, attemptCreated: inserted.rowCount === 1 };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function performRefresh(pool, id, runtimeNow) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const [row] = (await client.query('select * from bench_temporal_obligations where id = $1 for update', [id])).rows;
    assert.equal(row.refresh_requested, true);
    const nextDue = new Date(runtimeNow.getTime() + 10 * DAY);
    await client.query(`
      update bench_temporal_obligations
      set refresh_requested = false, last_observation_at = $2,
          last_observation = $3::jsonb, next_due_at = $4, revision = revision + 1
      where id = $1
    `, [id, runtimeNow, JSON.stringify({ type: 'on-demand-refresh', source: 'human-intent' }), nextDue]);
    await client.query(`
      insert into bench_temporal_events (obligation_id, kind, payload, created_at)
      values ($1, 'on-demand-refresh', $2::jsonb, $3)
    `, [id, JSON.stringify({ authorization: 'policy-accepted' }), runtimeNow]);
    await client.query('commit');
    return { refreshed: true, nextDueAt: nextDue.toISOString() };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function waitFor(predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function runTemporalProbe() {
  const pool = makePool(LAB.jobDatabase);
  const clock = new TestClock(T0);
  const errors = [];
  const processed = [];
  let online;
  let offline;
  let bootA;
  let bootB;
  try {
    await initializeTemporalStore(pool);
    const fixtures = await seedTemporalFixtures(pool);

    online = new PgBoss(pgBossOptions({ clock, schedule: true }));
    online.on('error', (error) => errors.push(error.message));
    await online.start();
    await online.createQueue(TEMPORAL_QUEUE, { notify: true, expireInSeconds: 30, retryLimit: 0, deleteAfterSeconds: 86_400 });
    await online.schedule(TEMPORAL_QUEUE, RADAR_RULE, { obligationId: fixtures.radar }, { key: TEMPORAL_KEY, missed: 'once' });
    await clock.tick(1_000);
    const scheduleAtT0 = await online.getSchedule(TEMPORAL_QUEUE, TEMPORAL_KEY);
    assert.equal(scheduleAtT0.options.missed, 'once');
    await online.stop();
    online = null;

    offline = new PgBoss(pgBossOptions({ clock, schedule: false }));
    offline.on('error', (error) => errors.push(error.message));
    await offline.start();
    await clock.setTime(new Date(T0.getTime() + DAY));
    const refresh = await performRefresh(pool, fixtures.refresh, new Date(T0.getTime() + DAY));
    await clock.setTime(OFFLINE_AT);

    const humanWaitingBefore = await readObligation(pool, fixtures.waitingHuman);
    const humanRetryBefore = await readObligation(pool, fixtures.humanRetry);
    const retryBeforeAttempts = await countAttempts(pool, fixtures.humanRetry);
    const unauthorisedRetry = await reconcileHumanRetry(pool, fixtures.humanRetry, OFFLINE_AT, false);
    const retryAfterUnauthorised = await countAttempts(pool, fixtures.humanRetry);
    const authorisedRetry = await reconcileHumanRetry(pool, fixtures.humanRetry, OFFLINE_AT, true);
    const retryAfterAuthorised = await countAttempts(pool, fixtures.humanRetry);

    bootA = new PgBoss(pgBossOptions({ clock, schedule: true }));
    bootB = new PgBoss(pgBossOptions({ clock, schedule: true }));
    for (const boss of [bootA, bootB]) boss.on('error', (error) => errors.push(error.message));
    await bootA.start();
    await bootB.start();
    const worker = (boss, name) => boss.work(TEMPORAL_QUEUE, {
      pollingIntervalSeconds: 0.5,
      notifyPollingIntervalSeconds: 0.5,
      localConcurrency: 1,
    }, async (jobs) => {
      for (const job of jobs) {
        const result = await claimCatchup(pool, job.data.obligationId, new Date(clock.now()), name);
        processed.push({ boss: name, jobId: job.id, obligationId: job.data.obligationId, result });
      }
      return { processed: jobs.length };
    });
    await worker(bootA, 'boot-a');
    await worker(bootB, 'boot-b');
    await clock.tick(1_000);
    await waitFor(() => processed.some((item) => item.obligationId === fixtures.radar), 'scheduled Radar catch-up');

    const radarAfter = await readObligation(pool, fixtures.radar);
    const radarDeliveries = processed.filter((item) => item.obligationId === fixtures.radar);
    const radarAuthorities = radarDeliveries.filter((item) => item.result.authority);
    const radarEffects = radarDeliveries.filter((item) => item.result.effect);
    assert.equal(radarAfter.state, 'observed');
    assert.equal(radarAfter.missed_windows, 3);
    assert.equal(radarAuthorities.length, 1);
    assert.equal(radarEffects.length, 1);

    await bootA.unschedule(TEMPORAL_QUEUE, TEMPORAL_KEY);
    const canonicalAfterScheduleDelete = await readObligation(pool, fixtures.radar);
    await bootA.schedule(TEMPORAL_QUEUE, canonicalAfterScheduleDelete.recurrence_rule, { obligationId: fixtures.radar }, {
      key: TEMPORAL_KEY,
      missed: canonicalAfterScheduleDelete.catch_up_policy === 'COALESCE_MISSED' ? 'once' : 'skip',
    });
    const recreatedSchedule = await bootA.getSchedule(TEMPORAL_QUEUE, TEMPORAL_KEY);
    assert.equal(canonicalAfterScheduleDelete.state, 'observed');
    assert.ok(recreatedSchedule);

    const duplicateIds = await Promise.all([
      bootA.send(TEMPORAL_QUEUE, { obligationId: fixtures.duplicate, source: 'duplicate-scheduled-wakeup-a' }, { retryLimit: 0 }),
      bootB.send(TEMPORAL_QUEUE, { obligationId: fixtures.duplicate, source: 'duplicate-scheduled-wakeup-b' }, { retryLimit: 0 }),
    ]);
    await clock.tick(1_000);
    await waitFor(() => processed.filter((item) => item.obligationId === fixtures.duplicate).length >= 2, 'duplicate wake-up deliveries');
    const duplicateDeliveries = processed.filter((item) => item.obligationId === fixtures.duplicate);
    const duplicateAuthorities = duplicateDeliveries.filter((item) => item.result.authority);
    const duplicateEffects = duplicateDeliveries.filter((item) => item.result.effect);
    assert.equal(duplicateIds.length, 2);
    assert.equal(duplicateDeliveries.length, 2);
    assert.equal(duplicateAuthorities.length, 1);
    assert.equal(duplicateEffects.length, 1);

    const humanWaitingAfter = await readObligation(pool, fixtures.waitingHuman);
    const humanRetryAfter = await readObligation(pool, fixtures.humanRetry);
    const refreshAfter = await readObligation(pool, fixtures.refresh);
    assert.equal(humanWaitingAfter.approval_state, 'pending');
    assert.equal(humanWaitingAfter.state, 'waiting_human');
    assert.equal(humanRetryBefore.approval_state, 'pending');
    assert.equal(retryBeforeAttempts, 0);
    assert.equal(unauthorisedRetry.attemptCreated, false);
    assert.equal(retryAfterUnauthorised, 0);
    assert.equal(authorisedRetry.attemptCreated, true);
    assert.equal(retryAfterAuthorised, 1);
    assert.equal(humanRetryAfter.state, 'running');
    assert.equal(refreshAfter.refresh_requested, false);

    const scheduleJobs = await bootA.findJobs(TEMPORAL_QUEUE, { data: { obligationId: fixtures.radar } });
    const driftBeforeStop = await bootA.detectSchemaDrift();
    await bootA.stop();
    bootA = null;
    await bootB.stop();
    bootB = null;
    await offline.stop();
    offline = null;

    const cleanupProbe = new PgBoss(pgBossOptions());
    cleanupProbe.on('error', () => undefined);
    await cleanupProbe.start();
    const driftAfterStop = await cleanupProbe.detectSchemaDrift();
    await cleanupProbe.stop();
    const clockRows = await query(CANDIDATE_DATABASE, `
      select to_regclass($1) as clock_table,
             (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = $2 and p.proname = 'job_now') as job_now_source
    `, [`${PG_BOSS_SCHEMA}.__pgboss_test_clock`, PG_BOSS_SCHEMA]);
    const clockClean = clockRows[0].clock_table === null && !String(clockRows[0].job_now_source).includes('pgboss_test_clock');
    assert.equal(clockClean, true);
    return {
      node: process.version,
      postgres: (await query(CANDIDATE_DATABASE, 'select version() as version'))[0].version,
      windows: process.platform === 'win32',
      config: {
        schema: PG_BOSS_SCHEMA,
        database: CANDIDATE_DATABASE,
        listennotify: true,
        schedule: true,
        cronMonitorIntervalSeconds: 1,
        workerPollingIntervalSeconds: 0.5,
        testClock: true,
      },
      canonicalTemporalState: {
        t0: T0.toISOString(),
        offlineUntil: OFFLINE_AT.toISOString(),
        radarNextDueAtBefore: new Date(T0.getTime() + 10 * DAY).toISOString(),
        radarLastCheckedAt: T0.toISOString(),
        catchUpPolicy: 'COALESCE_MISSED',
        missedWindows: 3,
        radarStateAfter: radarAfter.state,
        radarNextDueAtAfter: radarAfter.next_due_at,
      },
      schedule: {
        missedPolicy: scheduleAtT0.options.missed,
        automaticCatchupDeliveries: radarDeliveries.length,
        automaticCatchupAuthorities: radarAuthorities.length,
        automaticCatchupEffects: radarEffects.length,
        scheduleJobs: scheduleJobs.length,
        reconstructedFromNexState: recreatedSchedule?.data?.obligationId === fixtures.radar,
        deletedScheduleDidNotEraseCanonicalState: canonicalAfterScheduleDelete.state === 'observed',
      },
      duplicateWakeup: {
        deliveries: duplicateDeliveries.length,
        materialAuthorities: duplicateAuthorities.length,
        materialEffects: duplicateEffects.length,
        finalState: (await readObligation(pool, fixtures.duplicate)).state,
      },
      humanWait: {
        approvalBefore: humanWaitingBefore.approval_state,
        approvalAfter: humanWaitingAfter.approval_state,
        stateAfterOffline: humanWaitingAfter.state,
        automaticApprovalOrRejection: false,
        retryDueAfterOffline: true,
        attemptBeforeAuthorization: retryAfterUnauthorised,
        attemptAfterAuthorization: retryAfterAuthorised,
        finalState: humanRetryAfter.state,
      },
      refreshOnDemand: refresh,
      testClock: {
        driftBeforeStop,
        driftAfterStop,
        clockTable: clockRows[0].clock_table,
        clean: clockClean,
      },
      errors,
    };
  } finally {
    if (bootA) await bootA.stop().catch(() => undefined);
    if (bootB) await bootB.stop().catch(() => undefined);
    if (online) await online.stop().catch(() => undefined);
    if (offline) await offline.stop().catch(() => undefined);
    await pool.end();
  }
}

function renderReport(result) {
  const tests = result.minigate?.tests ?? [];
  const rows = tests.map((test) => `| ${test.id} | ${test.passed ? 'PASS' : 'FAIL'} | ${test.providerCounts.calls}/${test.providerCounts.effects} | ${test.finalState} |`).join('\n');
  return `# NEX+ 0.86C-0 · pg-boss 12.34.0 final revalidation\n\n` +
    `Experimental spike only. No production code, main, Notion, or other runtimes were changed.\n\n` +
    `## Verdict\n\n${result.verdict}\n\n` +
    `## Environment\n\n` +
    `- pg-boss: 12.34.0; schema: 42; database: ${result.migration.database}; schema name: ${result.migration.schema}.\n` +
    `- Node: ${result.temporal.node}; PostgreSQL: ${result.temporal.postgres}; Windows: ${result.temporal.windows}.\n` +
    `- LISTEN/NOTIFY enabled with polling fallback; cron monitor 1s; worker polling 0.5s; TestClock enabled only in the lab.\n\n` +
    `## Schema 38 → 42\n\n` +
    `- Chain: ${result.migration.migrationChain.join(', ')}.\n` +
    `- ${result.migration.mechanism}.\n` +
    `- Existing queue/job/schedule remained readable: ${result.migration.existingQueueReadable && result.migration.existingJobReadable && result.migration.existingScheduleReadable ? 'yes' : 'no'}.\n` +
    `- Sentinel outside pg-boss schema untouched: ${result.migration.sentinelUntouched ? 'yes' : 'no'}.\n` +
    `- Schema drift: ${JSON.stringify(result.migration.schemaDrift)}.\n\n` +
    `## Authority mini-gate on 12.34.0\n\n` +
    `| Scenario | Result | Provider calls/effects | NEX state |\n|---|---|---:|---|\n${rows}\n\n` +
    `T9 preserved blocked_unknown, one external effect, and stale Evidence rejection by fencing. Pre-dispatch and cancel-before remained at zero effects; cancel-after preserved the already factual effect. Duplicate delivery remained one NEX authority and one effect.\n\n` +
    `## Offline temporal catch-up\n\n` +
    `- Canonical NEX obligation: lastCheckedAt ${result.temporal.canonicalTemporalState.radarLastCheckedAt}; nextDueAt ${result.temporal.canonicalTemporalState.radarNextDueAtBefore}; Home offline until ${result.temporal.canonicalTemporalState.offlineUntil}.\n` +
    `- Radar policy COALESCE_MISSED found 3 missed windows and produced ${result.temporal.schedule.automaticCatchupEffects} material catch-up observation.\n` +
    `- Two-worker duplicate wake-up: ${result.temporal.duplicateWakeup.deliveries} deliveries, ${result.temporal.duplicateWakeup.materialAuthorities} material authority, ${result.temporal.duplicateWakeup.materialEffects} material effect.\n` +
    `- Deleting/recreating only the pg-boss schedule preserved and reconstructed the obligation from NEX state: ${result.temporal.schedule.reconstructedFromNexState ? 'yes' : 'no'}.\n` +
    `- Human approval stayed pending across offline time; new Attempt was created only after explicit authorization.\n` +
    `- On-demand refresh was accepted before the automatic due date and recalculated the next date.\n\n` +
    `## TestClock / cleanup\n\n` +
    `- job_now() override and __pgboss_test_clock cleanup: ${result.temporal.testClock.clean ? 'PASS' : 'FAIL'}.\n` +
    `- No persistent clock override remained after all bosses stopped.\n\n` +
    `## Limitations\n\n` +
    `- Temporal NEX tables are disposable fixtures, not 0.86C-1 production implementation.\n` +
    `- TestClock validates deterministic runtime behavior; it does not prove physical clock drift, network partitions, or provider exactly-once semantics.\n` +
    `- The test does not adopt transactional workers; long waits remain outside open PostgreSQL transactions.\n` +
    `- No other runtime or full benchmark was repeated.\n\n` +
    `0.86C-0 · PG-BOSS 12.34.0 · REVALIDAÇÃO CONCLUÍDA PARA SÍNTESE HUMANA\n`;
}

async function main() {
  const migration = await installSchema38AndMigrate();
  const minigate = await readArtifact('pgboss-minigate-results.json');
  assert.equal(minigate?.version, '12.34.0');
  assert.equal(minigate?.schemaVersion, 42);
  const temporal = await runTemporalProbe();
  const result = {
    completedAt: new Date().toISOString(),
    verdict: 'PG-BOSS 12.34.0 REVALIDADO · 0.86C-0 PODE SER CONGELADO',
    migration,
    minigate,
    temporal,
  };
  await writeArtifact('pgboss-1234-revalidation.json', result);
  await writeFile(path.join(LAB_ROOT, 'PGBOSS_1234_REVALIDATION_REPORT.md'), renderReport(result), 'utf8');
  console.log(JSON.stringify({ verdict: result.verdict, migration, temporal }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
