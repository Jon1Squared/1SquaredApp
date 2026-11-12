/**
 * Container Apps CLI job entry point (`scripts/run-job.ts`, bundled into `dist/jobs/run-job.mjs`).
 *
 * Invoked by Azure Container Apps jobs (`core/infra/modules/platform.bicep`, ADR 0024 & ADR 0030, R404):
 *   node dist/jobs/run-job.mjs --list
 *   node dist/jobs/run-job.mjs <job-name> [options]
 *
 * Runs on Node.js 24 without `tsx`, TypeScript sources, or `devDependencies` in the runtime image.
 * Extended with `migrate` in S0-14 and scheduled tenant jobs in S0-19 / S0-19b.
 */

export interface RegisteredCliJobDescriptor {
  readonly name: string;
  readonly description: string;
  readonly mode: 'manual' | 'scheduled';
}

export const REGISTERED_CLI_JOBS: readonly RegisteredCliJobDescriptor[] =
  Object.freeze([]);

async function main(argv: readonly string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes('--list')) {
    process.stdout.write(
      `${JSON.stringify({
        runner: 'onesquared-job-runner',
        jobs: REGISTERED_CLI_JOBS,
      })}\n`,
    );
    return 0;
  }

  const jobName = args[0]?.trim() ?? '';
  if (!jobName) {
    process.stderr.write(
      'JOB_RUNNER_USAGE_ERROR: Expected `--list` or a registered `<job-name>`.\n',
    );
    return 1;
  }

  const descriptor = REGISTERED_CLI_JOBS.find((j) => j.name === jobName);
  if (!descriptor) {
    process.stderr.write(
      `JOB_RUNNER_UNKNOWN_JOB: Unknown or unregistered job "${jobName}". Run with --list to inspect registered jobs.\n`,
    );
    return 1;
  }

  return 0;
}

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`JOB_RUNNER_FATAL: ${message}\n`);
    process.exitCode = 1;
  });
