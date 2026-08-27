import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

export const LAB_ROOT = path.resolve(directory, '..');
export const ARTIFACTS_DIRECTORY = path.join(LAB_ROOT, '.artifacts');

export const LAB = Object.freeze({
  container: 'nex086c-postgres',
  volume: 'nex086c_pgdata',
  image: 'postgres:18.1-alpine',
  host: '127.0.0.1',
  port: 55432,
  user: 'nex086c',
  adminDatabase: 'postgres',
  jobDatabase: 'nex086c_jobstore',
  providerDatabase: 'nex086c_provider',
  candidateDatabases: [
    'nex086c_pgboss',
    'nex086c_graphile',
    'nex086c_dbos',
    'nex086c_openworkflow',
    'nex086c_absurd',
    'nex086c_payload',
  ],
  notifyChannel: 'nex086c_wake',
});

export function databaseUrl(database) {
  if (!/^nex086c_[a-z0-9_]+$/.test(database) && database !== LAB.adminDatabase) {
    throw new Error(`Refusing non-laboratory database name: ${database}`);
  }

  return `postgresql://${LAB.user}@${LAB.host}:${LAB.port}/${database}`;
}

export function assertLaboratoryDatabase(database) {
  if (!database.startsWith('nex086c_')) {
    throw new Error(`Refusing to mutate non-laboratory database: ${database}`);
  }
}
