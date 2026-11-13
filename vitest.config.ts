import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Throwaway local/CI PostgreSQL cluster settings (R435, R436). Core has no built-in passwords,
// hosts or hosting mode, so the test run sets them explicitly. They are also copied into this
// process so `src/test/vitest.global-setup.ts` provisions the cluster with the same values.
const localPostgresTestEnv: Record<string, string> = {
  PLATFORM_HOSTING_MODE: process.env.PLATFORM_HOSTING_MODE || 'multi_tenant',
  PLATFORM_POSTGRES_HOST: process.env.PLATFORM_POSTGRES_HOST || '127.0.0.1',
  PLATFORM_POSTGRES_ADMIN_USER:
    process.env.PLATFORM_POSTGRES_ADMIN_USER || 'postgres',
  PLATFORM_POSTGRES_ADMIN_PASSWORD:
    process.env.PLATFORM_POSTGRES_ADMIN_PASSWORD || 'postgres',
  PLATFORM_POSTGRES_RUNTIME_PASSWORD:
    process.env.PLATFORM_POSTGRES_RUNTIME_PASSWORD || 'onesquared_local_runtime',
  PLATFORM_POSTGRES_MIGRATE_PASSWORD:
    process.env.PLATFORM_POSTGRES_MIGRATE_PASSWORD || 'onesquared_local_migrate',
};
for (const [key, value] of Object.entries(localPostgresTestEnv)) {
  process.env[key] = value;
}

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      zod: path.resolve(__dirname, 'node_modules/zod'),
      vitest: path.resolve(__dirname, 'node_modules/vitest'),
      '@platform/core/testing': path.resolve(__dirname, 'core/src/testing.ts'),
      '@platform/core': path.resolve(__dirname, 'core/src/index.ts'),
      '@platform/core-api': path.resolve(__dirname, 'core/src/api/index.ts'),
      'server-only': path.resolve(__dirname, 'tests/stubs/empty.ts'),
    },
  },
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15000,
    globalSetup: ['./src/test/vitest.global-setup.ts'],
    setupFiles: ['./src/test/vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'core/tests/**/*.test.ts'],
    env: {
      ...localPostgresTestEnv,
      PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
      PLATFORM_ENVIRONMENT: 'test',
      PLATFORM_POSTGRES_HOST: process.env.PLATFORM_POSTGRES_HOST || '127.0.0.1',
      PLATFORM_POSTGRES_PORT: process.env.PLATFORM_POSTGRES_PORT || '5432',
      PLATFORM_POSTGRES_MIGRATE_PORT:
        process.env.PLATFORM_POSTGRES_MIGRATE_PORT || '5432',
    },
  },
});
