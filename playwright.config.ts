import { defineConfig, devices } from '@playwright/test';

/**
 * Test-only cookie signing key for Playwright role journey tests (Slice S0-27).
 * Never used outside automated browser tests; never a real secret.
 */
export const E2E_TEST_AUTH_SECRET =
  'e2e-test-only-cookie-signing-value-not-a-real-secret';
export const E2E_TEST_BLOB_SIGNING_KEY =
  'e2e-test-only-blob-signing-value-not-a-real-secret';

export const E2E_PORT = Number(process.env.PLAYWRIGHT_PORT || 3100);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? 'list' : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `node e2e/start-server.mjs`,
    url: E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
      PLATFORM_ENVIRONMENT: 'test',
      AUTH_SECRET: E2E_TEST_AUTH_SECRET,
      PLATFORM_BLOB_SIGNING_KEY: E2E_TEST_BLOB_SIGNING_KEY,
      PLAYWRIGHT_PORT: String(E2E_PORT),
      PLATFORM_POSTGRES_HOST: process.env.PLATFORM_POSTGRES_HOST || '127.0.0.1',
      PLATFORM_POSTGRES_PORT: process.env.PLATFORM_POSTGRES_PORT || '5432',
      PLATFORM_POSTGRES_MIGRATE_PORT:
        process.env.PLATFORM_POSTGRES_MIGRATE_PORT || '5432',
      // Throwaway local/CI cluster credentials (R435): core has no built-in passwords.
      PLATFORM_POSTGRES_RUNTIME_PASSWORD:
        process.env.PLATFORM_POSTGRES_RUNTIME_PASSWORD || 'onesquared_local_runtime',
      PLATFORM_POSTGRES_MIGRATE_PASSWORD:
        process.env.PLATFORM_POSTGRES_MIGRATE_PASSWORD || 'onesquared_local_migrate',
    },
  },
});
