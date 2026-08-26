import { defineConfig, devices } from '@playwright/test';

const port = process.env.PORT || '3108';
const baseURL = `http://127.0.0.1:${port}`;
const e2eOrigin = 'http://127.0.0.1:3108';

// Travas de segurança: E2E só pode usar o modo e o diretório isolados.
if (process.env.NEX_BUILD_MODE && process.env.NEX_BUILD_MODE !== 'e2e') {
  throw new Error('[SECURITY_GUARD] Playwright recusou execução fora de NEX_BUILD_MODE=e2e.');
}
if (process.env.NEXT_DIST_DIR) {
  throw new Error('[SECURITY_GUARD] Playwright recusou NEXT_DIST_DIR externo; use o distDir controlado pelo modo e2e.');
}

const outputDir =
  process.env.NEX_E2E_ISOLATED === '1'
    ? '.test-results-e2e-auth'
    : './test-results';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir,
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npx next start -H 127.0.0.1 -p ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      NEX_BUILD_MODE: 'e2e',
      NEXT_DIST_DIR: '',
      DATABASE_URL: process.env.DATABASE_URL || '',
      PAYLOAD_SECRET: process.env.PAYLOAD_SECRET || '',
      PAYLOAD_PUBLIC_SERVER_URL: e2eOrigin,
      PAYLOAD_TRUSTED_ORIGINS: e2eOrigin,
      NODE_ENV: 'production',
      PORT: port,
      NEX_EMAIL_RELAY_URL: '',
      NEX_EMAIL_RELAY_SECRET: '',
    },
  },
});
