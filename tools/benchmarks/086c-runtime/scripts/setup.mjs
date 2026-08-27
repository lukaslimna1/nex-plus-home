import { writeArtifact } from '../src/artifacts.mjs';
import { LAB } from '../src/constants.mjs';
import { cleanupDockerLaboratory, dockerResourceSnapshot, startPostgresLaboratory, waitForPostgres } from '../src/docker.mjs';
import { initializeJobStore, initializeProviderStore, pingPostgres, recreateDatabase } from '../src/db.mjs';

try {
  await startPostgresLaboratory();
  await waitForPostgres(pingPostgres);
  await recreateDatabase(LAB.jobDatabase);
  await recreateDatabase(LAB.providerDatabase);
  await initializeJobStore();
  await initializeProviderStore();
  const resources = await dockerResourceSnapshot();
  await writeArtifact('resources.json', {
    createdAt: new Date().toISOString(),
    container: LAB.container,
    volume: LAB.volume,
    image: LAB.image,
    hostPort: LAB.port,
    databases: [LAB.jobDatabase, LAB.providerDatabase],
    resources,
  });
  console.log(`Laboratory PostgreSQL ready at ${LAB.host}:${LAB.port}`);
} catch (error) {
  await cleanupDockerLaboratory().catch(() => undefined);
  throw error;
}
