import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const outDir = path.join(rootDir, 'dist', 'jobs');

const jobEntries = [
  {
    entryPoint: path.join(rootDir, 'scripts', 'run-job.ts'),
    outfile: path.join(outDir, 'run-job.mjs'),
  },
];

async function bundleJobs() {
  fs.mkdirSync(outDir, { recursive: true });

  for (const item of jobEntries) {
    if (!fs.existsSync(item.entryPoint)) {
      if (item.optional) {
        continue;
      }
      throw new Error(
        `Required job entry point not found: ${path.relative(rootDir, item.entryPoint)}`,
      );
    }

    await build({
      entryPoints: [item.entryPoint],
      outfile: item.outfile,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      sourcemap: false,
      logLevel: 'warning',
      banner: {
        js: "import { createRequire as __oneSquaredCreateRequire } from 'node:module'; import { fileURLToPath as __oneSquaredFileURLToPath } from 'node:url'; import { dirname as __oneSquaredDirname } from 'node:path'; const require = __oneSquaredCreateRequire(import.meta.url); const __filename = __oneSquaredFileURLToPath(import.meta.url); const __dirname = __oneSquaredDirname(__filename);",
      },
      alias: {
        '@': path.join(rootDir, 'src'),
        '@platform/core': path.join(rootDir, 'core', 'src', 'index.ts'),
        '@platform/core-api': path.join(rootDir, 'core', 'src', 'api', 'index.ts'),
        'server-only': path.join(rootDir, 'tests', 'stubs', 'empty.ts'),
      },
    });
  }
}

bundleJobs().catch((err) => {
  console.error('[build:jobs] Failed to bundle CLI job entry points:', err);
  process.exit(1);
});
