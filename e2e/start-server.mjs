import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import { resetRuntimeStoreFromCommittedSeed } from '../src/seed/seedFileLoader.mjs';

const rootDir = process.cwd();
const port = process.env.PLAYWRIGHT_PORT || '3100';

const serverEnv = {
  ...process.env,
  PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
  PLATFORM_ENVIRONMENT: 'test',
  PLATFORM_POSTGRES_HOST: process.env.PLATFORM_POSTGRES_HOST || '127.0.0.1',
  PLATFORM_POSTGRES_PORT: process.env.PLATFORM_POSTGRES_PORT || '5432',
  PLATFORM_POSTGRES_MIGRATE_PORT:
    process.env.PLATFORM_POSTGRES_MIGRATE_PORT || '5432',
  PLATFORM_HOSTING_MODE: process.env.PLATFORM_HOSTING_MODE || 'multi_tenant',
  // Throwaway local/CI cluster credentials (R435): core has no built-in passwords.
  PLATFORM_POSTGRES_ADMIN_USER: process.env.PLATFORM_POSTGRES_ADMIN_USER || 'postgres',
  PLATFORM_POSTGRES_ADMIN_PASSWORD:
    process.env.PLATFORM_POSTGRES_ADMIN_PASSWORD || 'postgres',
  PLATFORM_POSTGRES_RUNTIME_PASSWORD:
    process.env.PLATFORM_POSTGRES_RUNTIME_PASSWORD || 'onesquared_local_runtime',
  PLATFORM_POSTGRES_MIGRATE_PASSWORD:
    process.env.PLATFORM_POSTGRES_MIGRATE_PASSWORD || 'onesquared_local_migrate',
};

// 1. Ensure local / CI PostgreSQL 16 is running, provisioned, and migrated
execSync('node scripts/setup-test-postgres.mjs', {
  cwd: rootDir,
  stdio: 'inherit',
  env: serverEnv,
});

// 2. Reset runtime store from seed data before starting the server via the shared seed loader
resetRuntimeStoreFromCommittedSeed({ rootDir });

// 3. Always run a fresh production build with PLATFORM_ENVIRONMENT=test unless E2E_SKIP_BUILD=1 is set
if (process.env.E2E_SKIP_BUILD !== '1') {
  execSync('npm run build', {
    cwd: rootDir,
    stdio: 'inherit',
    env: serverEnv,
  });
}

// 4. Import migrated modules into the tenant PostgreSQL database via bundled store-import job
execSync('node dist/jobs/import-store.mjs --clear', {
  cwd: rootDir,
  stdio: 'inherit',
  env: serverEnv,
});

// 5. Start next start on the configured port
const nextBin = path.join(
  rootDir,
  'node_modules',
  'next',
  'dist',
  'bin',
  'next',
);

const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
  cwd: rootDir,
  stdio: 'inherit',
  env: {
    ...serverEnv,
    NODE_ENV: 'production',
  },
});

function terminateChild() {
  if (!child.killed) {
    try {
      child.kill();
    } catch {
      // Ignore if already exited
    }
  }
}

process.on('SIGINT', () => {
  terminateChild();
  process.exit(0);
});
process.on('SIGTERM', () => {
  terminateChild();
  process.exit(0);
});
process.on('exit', () => {
  terminateChild();
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
