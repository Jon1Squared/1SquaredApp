import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('S0-13b: Standalone Dockerfile, .dockerignore, and bundled dist/jobs entry point contract (R404)', () => {
  it('configures Next.js standalone output, non-root Node 24 runtime image, and excludes secrets and runtime-store.json from Docker context', () => {
    const nextConfigText = fs.readFileSync(
      path.join(REPO_ROOT, 'next.config.ts'),
      'utf8',
    );
    expect(nextConfigText).toContain("output: 'standalone'");

    const dockerfileText = fs.readFileSync(
      path.join(REPO_ROOT, 'Dockerfile'),
      'utf8',
    );
    expect(dockerfileText).toContain('FROM node:24-bookworm-slim AS builder');
    expect(dockerfileText).toContain('FROM node:24-bookworm-slim AS runner');
    expect(dockerfileText).toContain('/app/.next/standalone');
    expect(dockerfileText).toContain('/app/dist/jobs ./dist/jobs');
    expect(dockerfileText).toContain('USER node');
    expect(dockerfileText).not.toMatch(/COPY[^\n]*\.env/i);
    expect(dockerfileText).not.toContain('runtime-store.json');

    const dockerignoreText = fs.readFileSync(
      path.join(REPO_ROOT, '.dockerignore'),
      'utf8',
    );
    expect(dockerignoreText).toContain('.env.*');
    expect(dockerignoreText).toContain('data/runtime-store.json');
    expect(dockerignoreText).toContain('node_modules');
    expect(dockerignoreText).toContain('.next');
  });

  it('bundles scripts/run-job.ts into self-contained dist/jobs/run-job.mjs and executes --list on plain Node 24 without tsx', () => {
    const buildRes = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'build-jobs.mjs')],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );
    expect(buildRes.status).toBe(0);

    const bundledRunnerPath = path.join(REPO_ROOT, 'dist', 'jobs', 'run-job.mjs');
    expect(fs.existsSync(bundledRunnerPath)).toBe(true);

    const listRes = spawnSync(process.execPath, [bundledRunnerPath, '--list'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(listRes.status).toBe(0);
    const parsed = JSON.parse(listRes.stdout.trim()) as {
      runner: string;
      jobs: unknown[];
    };
    expect(parsed.runner).toBe('onesquared-job-runner');
    expect(Array.isArray(parsed.jobs)).toBe(true);

    const unknownRes = spawnSync(
      process.execPath,
      [bundledRunnerPath, 'nonexistent-job'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );
    expect(unknownRes.status).toBe(1);
    expect(unknownRes.stderr).toContain('JOB_RUNNER_UNKNOWN_JOB');
  });
});
