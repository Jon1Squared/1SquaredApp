import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import { resetRuntimeStoreFromCommittedSeed } from '../src/seed/seedFileLoader.mjs';

const rootDir = process.cwd();
const port = process.env.PLAYWRIGHT_PORT || '3100';

// 1. Reset runtime store from seed data before starting the server via the shared seed loader
resetRuntimeStoreFromCommittedSeed({ rootDir });

// 2. Always run a fresh production build with PLATFORM_ENVIRONMENT=test unless E2E_SKIP_BUILD=1 is set
if (process.env.E2E_SKIP_BUILD !== '1') {
  execSync('npm run build', {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
      PLATFORM_ENVIRONMENT: 'test',
    },
  });
}

// 3. Start next start on the configured port
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
    ...process.env,
    NODE_ENV: 'production',
    PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
    PLATFORM_ENVIRONMENT: 'test',
  },
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
