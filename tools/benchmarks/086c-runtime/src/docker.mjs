import { LAB } from './constants.mjs';
import { runAllowFailure, run, sleep } from './shell.mjs';

async function docker(args) {
  return run('docker', args);
}

export async function removeLaboratoryContainer() {
  await runAllowFailure('docker', ['rm', '--force', LAB.container]);
}

export async function removeLaboratoryVolume() {
  await runAllowFailure('docker', ['volume', 'rm', LAB.volume]);
}

export async function cleanupDockerLaboratory() {
  await removeLaboratoryContainer();
  await removeLaboratoryVolume();
}

export async function startPostgresLaboratory() {
  await cleanupDockerLaboratory();
  await docker(['volume', 'create', LAB.volume]);
  await docker([
    'run', '--detach', '--rm', '--name', LAB.container,
    '--publish', `${LAB.host}:${LAB.port}:5432`,
    '--env', `POSTGRES_USER=${LAB.user}`,
    '--env', 'POSTGRES_HOST_AUTH_METHOD=trust',
    '--env', `POSTGRES_DB=${LAB.adminDatabase}`,
    '--volume', `${LAB.volume}:/var/lib/postgresql`,
    LAB.image,
  ]);
}

export async function waitForPostgres(connect, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await connect();
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error(`Disposable PostgreSQL did not become ready: ${lastError?.message ?? 'unknown error'}`);
}

export async function restartPostgresLaboratory() {
  await docker(['restart', LAB.container]);
}

export async function dockerResourceSnapshot() {
  const container = await runAllowFailure('docker', ['inspect', '--format', '{{json .State}}', LAB.container]);
  const volume = await runAllowFailure('docker', ['volume', 'inspect', '--format', '{{json .}}', LAB.volume]);
  return { container, volume };
}
