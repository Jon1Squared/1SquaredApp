import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const npxCmd = isWin ? 'npx.cmd' : 'npx';

const testEnv = {
  ...process.env,
  PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
  PLATFORM_ENVIRONMENT: 'test',
};

const liveBuildEnv = {
  ...process.env,
  PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
  PLATFORM_ENVIRONMENT: 'live',
};

function runStep(label, command, args, env = testEnv) {
  console.log(`\n=== [CI Verify] ${label} ===`);
  const useShell = isWin && command.endsWith('.cmd');
  const result = useShell
    ? spawnSync([command, ...args].join(' '), {
        stdio: 'inherit',
        env,
        shell: true,
      })
    : spawnSync(command, args, {
        stdio: 'inherit',
        env,
        shell: false,
      });
  if (result.status !== 0) {
    console.error(`\n[CI Verify] FAILED at step: ${label}`);
    process.exit(result.status ?? 1);
  }
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor !== 24) {
  console.error(
    `[CI Verify] FAILED: Node.js 24 is required to match Platform CI (found ${process.versions.node}).`,
  );
  process.exit(1);
}
console.log(`=== [CI Verify] Node.js ${process.versions.node} (matches Platform CI major 24) ===`);

runStep('1/7 Generate extension registry', npmCmd, ['run', 'generate:extensions'], testEnv);
runStep('2/7 TypeScript typecheck', npxCmd, ['tsc', '--noEmit'], testEnv);
runStep('3/7 ESLint check', npmCmd, ['run', 'lint'], testEnv);
runStep(
  '4/7 Verify invented-only fixture data in data/ and src/seed/',
  process.execPath,
  ['scripts/verify-invented-fixtures.mjs'],
  testEnv,
);

console.log('\n=== [CI Verify] 5/7 Verify generated extension registry contains bundled extension ===');
const registryPath = path.resolve(
  process.cwd(),
  'src/platform/generated/extensionRegistry.ts',
);
const registryContent = fs.existsSync(registryPath)
  ? fs.readFileSync(registryPath, 'utf8')
  : '';
if (!registryContent.includes('extModule_0')) {
  console.error(
    '[CI Verify] FAILED: src/platform/generated/extensionRegistry.ts does not contain "extModule_0".',
  );
  process.exit(1);
}

runStep(
  '6/7 Run unit, contract & two-tenant isolation tests (PLATFORM_ENVIRONMENT=test)',
  npmCmd,
  ['test'],
  testEnv,
);
runStep(
  '7/7 Verify production build (PLATFORM_ENVIRONMENT=live)',
  npmCmd,
  ['run', 'build'],
  liveBuildEnv,
);

console.log('\n=== [CI Verify] All Platform CI checks passed ===\n');
