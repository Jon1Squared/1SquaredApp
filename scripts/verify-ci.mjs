import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const npxCmd = isWin ? 'npx.cmd' : 'npx';

const GITLEAKS_VERSION = '8.30.1';

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

function resolveGitleaksBinary() {
  const direct = spawnSync(isWin ? 'gitleaks.exe' : 'gitleaks', ['version'], {
    stdio: 'ignore',
    shell: false,
  });
  if (direct.status === 0) {
    return isWin ? 'gitleaks.exe' : 'gitleaks';
  }

  if (isWin && process.env.LOCALAPPDATA) {
    const wingetLinks = path.join(
      process.env.LOCALAPPDATA,
      'Microsoft',
      'WinGet',
      'Links',
      'gitleaks.exe',
    );
    if (fs.existsSync(wingetLinks)) {
      return wingetLinks;
    }

    const wingetPackagesDir = path.join(
      process.env.LOCALAPPDATA,
      'Microsoft',
      'WinGet',
      'Packages',
    );
    if (fs.existsSync(wingetPackagesDir)) {
      const entries = fs.readdirSync(wingetPackagesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('Gitleaks.Gitleaks')) {
          const candidate = path.join(
            wingetPackagesDir,
            entry.name,
            'gitleaks.exe',
          );
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
    }
  }

  console.error(
    `[CI Verify] FAILED: gitleaks is not installed or not on PATH. Install it locally first (for example \`winget install gitleaks --version ${GITLEAKS_VERSION}\` on Windows or \`brew install gitleaks\` on macOS).`,
  );
  process.exit(1);
}

function resolveBicepRunner() {
  const directBicep = isWin ? 'bicep.exe' : 'bicep';
  const directRes = spawnSync(directBicep, ['--version'], {
    stdio: 'ignore',
    shell: false,
  });
  if (directRes.status === 0) {
    return { kind: 'bicep', bin: directBicep };
  }

  if (isWin && process.env.LOCALAPPDATA) {
    const wingetLinks = path.join(
      process.env.LOCALAPPDATA,
      'Microsoft',
      'WinGet',
      'Links',
      'bicep.exe',
    );
    if (fs.existsSync(wingetLinks)) {
      return { kind: 'bicep', bin: wingetLinks };
    }

    const wingetPackagesDir = path.join(
      process.env.LOCALAPPDATA,
      'Microsoft',
      'WinGet',
      'Packages',
    );
    if (fs.existsSync(wingetPackagesDir)) {
      const entries = fs.readdirSync(wingetPackagesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('Microsoft.Bicep')) {
          const candidate = path.join(
            wingetPackagesDir,
            entry.name,
            'bicep.exe',
          );
          if (fs.existsSync(candidate)) {
            return { kind: 'bicep', bin: candidate };
          }
        }
      }
    }
  }

  const azCmd = isWin ? 'az.cmd' : 'az';
  const azRes = spawnSync(azCmd, ['bicep', 'version'], {
    stdio: 'ignore',
    shell: isWin,
  });
  if (azRes.status === 0) {
    return { kind: 'az', bin: azCmd };
  }

  console.error(
    '[CI Verify] FAILED: Bicep CLI is not installed or not on PATH. Install it locally with `winget install --id Microsoft.Bicep --scope user` on Windows or `az bicep install`.',
  );
  process.exit(1);
}

function runBicepValidation(runner) {
  console.log('\n=== [CI Verify] 2/12 Validate Bicep infrastructure templates (build & lint) ===');
  const mainBicep = path.join('core', 'infra', 'main.bicep');
  const modulesDir = path.join('core', 'infra', 'modules');
  const moduleFiles = fs
    .readdirSync(modulesDir)
    .filter((name) => name.endsWith('.bicep'))
    .sort()
    .map((name) => path.join(modulesDir, name));
  const allBicepFiles = [mainBicep, ...moduleFiles];

  const buildArgs =
    runner.kind === 'bicep'
      ? ['build', mainBicep, '--stdout']
      : ['bicep', 'build', '--file', mainBicep, '--stdout'];
  const buildRes = spawnSync(runner.bin, buildArgs, {
    encoding: 'utf8',
    shell: isWin && runner.bin.endsWith('.cmd'),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (buildRes.stderr && buildRes.stderr.trim().length > 0) {
    console.error(buildRes.stderr.trim());
  }
  if (buildRes.status !== 0) {
    console.error('[CI Verify] FAILED: Bicep build failed on core/infra/main.bicep.');
    process.exit(buildRes.status ?? 1);
  }

  for (const bicepFile of allBicepFiles) {
    const lintArgs =
      runner.kind === 'bicep'
        ? ['lint', bicepFile]
        : ['bicep', 'lint', '--file', bicepFile];
    const lintRes = spawnSync(runner.bin, lintArgs, {
      encoding: 'utf8',
      shell: isWin && runner.bin.endsWith('.cmd'),
    });
    const stderrText = (lintRes.stderr ?? '').trim();
    if (stderrText.length > 0) {
      console.error(stderrText);
    }
    if (lintRes.status !== 0 || /\bWarning\b/i.test(stderrText)) {
      console.error(`[CI Verify] FAILED: Bicep lint failed or emitted warnings on ${bicepFile}.`);
      process.exit(lintRes.status || 1);
    }
  }
}

function checkGitleaksVersion(gitleaksBin) {
  const versionRes = spawnSync(gitleaksBin, ['version'], {
    encoding: 'utf8',
    shell: false,
  });
  const rawVersion = (versionRes.stdout ?? '').trim().replace(/^v/i, '');
  if (rawVersion === GITLEAKS_VERSION) {
    console.log(
      `=== [CI Verify] Gitleaks ${rawVersion} (matches Platform CI ${GITLEAKS_VERSION}) ===`,
    );
  } else {
    console.warn(
      `[CI Verify] WARNING: Local gitleaks version is "${rawVersion || 'unknown'}", but Platform CI pins "${GITLEAKS_VERSION}". Install the pinned version with \`winget install gitleaks --version ${GITLEAKS_VERSION}\` for exact CI parity.`,
    );
  }
}

function collectFilesRecursively(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursively(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

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

const gitleaksBin = resolveGitleaksBinary();
checkGitleaksVersion(gitleaksBin);
const bicepRunner = resolveBicepRunner();

runStep(
  '1/12 Secret scan (gitleaks)',
  gitleaksBin,
  ['dir', '.', '--config', '.gitleaks.toml', '--redact'],
  testEnv,
);
runBicepValidation(bicepRunner);
runStep('3/12 Generate extension registry', npmCmd, ['run', 'generate:extensions'], testEnv);
runStep('4/12 TypeScript typecheck', npxCmd, ['tsc', '--noEmit'], testEnv);
runStep('5/12 ESLint check', npmCmd, ['run', 'lint'], testEnv);
runStep(
  '6/12 Verify invented-only fixture data in data/ and src/seed/',
  process.execPath,
  ['scripts/verify-invented-fixtures.mjs'],
  testEnv,
);
runStep(
  '7/12 Verify no demo literals in src/components/ and src/domain/',
  process.execPath,
  ['scripts/verify-no-demo-literals.mjs'],
  testEnv,
);

console.log('\n=== [CI Verify] 8/12 Verify generated extension registry contains bundled extension ===');
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
  '9/12 Run unit, contract & two-tenant isolation tests (PLATFORM_ENVIRONMENT=test)',
  npmCmd,
  ['test'],
  testEnv,
);
runStep(
  '10/12 Verify production build (PLATFORM_ENVIRONMENT=live)',
  npmCmd,
  ['run', 'build'],
  liveBuildEnv,
);

console.log('\n=== [CI Verify] 11/12 Verify client bundle (.next/static) contains no API keys ===');
const staticDir = path.resolve(process.cwd(), '.next/static');
const staticFiles = collectFilesRecursively(staticDir);
if (staticFiles.length === 0) {
  console.error('[CI Verify] FAILED: .next/static contains no files after production build.');
  process.exit(1);
}
const BUNDLE_SECRET_REGEX_SOURCE = '\\bak_[A-Za-z0-9]{20,}\\b|sk-ant-';
const bundleSecretPattern = new RegExp(BUNDLE_SECRET_REGEX_SOURCE);
for (const filePath of staticFiles) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (bundleSecretPattern.test(content)) {
    const rel = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
    console.error(`[CI Verify] FAILED: Client bundle file ${rel} contains a forbidden API key pattern.`);
    process.exit(1);
  }
}

runStep(
  '12/12 Run Playwright role journey smoke tests (PLATFORM_ENVIRONMENT=test)',
  npmCmd,
  ['run', 'e2e'],
  testEnv,
);

console.log('\n=== [CI Verify] All Platform CI checks passed ===\n');
