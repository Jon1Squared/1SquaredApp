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
    include: ['src/**/*.test.ts', 'core/tests/**/*.test.ts'],
  },
});
