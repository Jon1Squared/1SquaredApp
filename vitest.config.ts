import path from 'node:path';
import { defineConfig } from 'vitest/config';

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
      PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
      PLATFORM_ENVIRONMENT: 'test',
      PLATFORM_POSTGRES_HOST: process.env.PLATFORM_POSTGRES_HOST || '127.0.0.1',
      PLATFORM_POSTGRES_PORT: process.env.PLATFORM_POSTGRES_PORT || '5432',
      PLATFORM_POSTGRES_MIGRATE_PORT:
        process.env.PLATFORM_POSTGRES_MIGRATE_PORT || '5432',
    },
  },
});
