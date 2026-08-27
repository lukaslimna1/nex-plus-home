import { writeArtifact } from '../src/artifacts.mjs';
import { LAB } from '../src/constants.mjs';
import { makePool } from '../src/db.mjs';
import { runAllowFailure } from '../src/shell.mjs';

const databases = [LAB.jobDatabase, LAB.providerDatabase, ...LAB.candidateDatabases];
const adminPool = makePool(LAB.adminDatabase);
try {
  const databaseSizes = [];
  for (const database of databases) {
    const row = (await adminPool.query(
      `select datname as database,
              pg_database_size(datname)::bigint as bytes,
              pg_size_pretty(pg_database_size(datname)) as pretty
       from pg_database
       where datname = $1`,
      [database],
    )).rows[0];
    if (row) databaseSizes.push(row);
  }
  const existingDatabases = databaseSizes.map((row) => row.database);
  const connections = (await adminPool.query(
    `select datname as database, count(*)::int as connections
     from pg_stat_activity
     where datname = any($1::text[])
     group by datname
     order by datname`,
    [databases],
  )).rows;
  const databaseShapes = [];
  for (const database of existingDatabases) {
    const pool = makePool(database);
    try {
      const tables = Number((await pool.query(
        "select count(*)::int as count from pg_class where relkind = 'r' and relnamespace not in (select oid from pg_namespace where nspname like 'pg_%' or nspname = 'information_schema')",
      )).rows[0].count);
      const indexes = Number((await pool.query(
        "select count(*)::int as count from pg_class where relkind = 'i' and relnamespace not in (select oid from pg_namespace where nspname like 'pg_%' or nspname = 'information_schema')",
      )).rows[0].count);
      const schemas = (await pool.query(
        "select nspname from pg_namespace where nspname like 'nex086c%' order by nspname",
      )).rows.map((row) => row.nspname);
      databaseShapes.push({ database, tables, indexes, schemas });
    } finally {
      await pool.end();
    }
  }
  const dockerStats = await runAllowFailure('docker', ['stats', '--no-stream', '--format', '{{json .}}', LAB.container]);
  await writeArtifact('footprint.json', {
    measuredAt: new Date().toISOString(),
    scope: 'PostgreSQL container snapshot after laboratory tests; not a host-wide RAM/CPU profiler.',
    databaseSizes,
    connections,
    databaseShapes,
    topologyNotes: {
      graphileWorker: 'The Graphile OSS harness uses schema nex086c_graphile inside nex086c_jobstore to prove same-PostgreSQL transactional enqueue.',
      absentCandidateDatabases: databases.filter((database) => !existingDatabases.includes(database)),
    },
    dockerStats,
  });
  console.log(JSON.stringify({ databaseSizes, connections, databaseShapes, dockerStats }, null, 2));
} finally {
  await adminPool.end();
}
