import { defineConfig, devices } from '@playwright/test';

const port = process.env.PORT || '3108';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
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
      NEXT_DIST_DIR: process.env.NEXT_DIST_DIR || '.next-e2e-auth',
      DATABASE_URL: process.env.DATABASE_URL || '',
      PAYLOAD_SECRET: process.env.PAYLOAD_SECRET || '',
      NODE_ENV: 'production',
      PORT: port,
    },
  },
});
