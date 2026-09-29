/**
 * NEX+ · Script Helper para Provisionamento Explícito do pg-boss Schema 43
 * Utilizado pelos harnesses de teste isolados para provisionar o banco descartável.
 */

import { provisionPgBossSchema } from '../src/core/jobs/runtime/index';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('[FAIL] DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  const result = await provisionPgBossSchema(connectionString);
  if (!result.success) {
    console.error(`[FAIL] provisionPgBossSchema failed with driftOk=${result.driftOk}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[FAIL] Unhandled error during pg-boss provisioning:', err);
  process.exit(1);
});
