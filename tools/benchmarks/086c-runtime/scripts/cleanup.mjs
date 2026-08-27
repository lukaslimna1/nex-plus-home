import { writeArtifact } from '../src/artifacts.mjs';
import { LAB } from '../src/constants.mjs';
import { cleanupDockerLaboratory, dockerResourceSnapshot } from '../src/docker.mjs';
import { dropDatabase } from '../src/db.mjs';

const databases = [LAB.jobDatabase, LAB.providerDatabase, ...LAB.candidateDatabases];
const removedDatabases = [];
for (const database of databases) {
  try {
    await dropDatabase(database);
    removedDatabases.push(database);
  } catch (error) {
    if (!/ECONNREFUSED|does not exist|connect/i.test(error.message)) {
      throw error;
    }
  }
}
await cleanupDockerLaboratory();
const remaining = await dockerResourceSnapshot();
await writeArtifact('cleanup.json', {
  cleanedAt: new Date().toISOString(),
  removedDatabases,
  container: LAB.container,
  volume: LAB.volume,
  remaining,
});
console.log('Laboratory resources removed.');
