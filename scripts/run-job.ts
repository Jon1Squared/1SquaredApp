/**
 * Container Apps CLI job entry point (`scripts/run-job.ts`, bundled into `dist/jobs/run-job.mjs`).
 *
 * Invoked by Azure Container Apps jobs (`core/infra/modules/platform.bicep`, ADR 0024, ADR 0028 §4, ADR 0030, R403, R404):
 *   node dist/jobs/run-job.mjs --list
 *   node dist/jobs/run-job.mjs migrate
 *   node dist/jobs/run-job.mjs <job-name> [options]
 *
 * Runs on Node.js 24 without `tsx`, TypeScript sources, or `devDependencies` in the runtime image.
 */

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import '../core/src/tenancy/pgNodePreload';
import {
  CORE_TENANT_MIGRATIONS,
  emitTenantTelemetryEvent,
  emitTenantTelemetryException,
  loadActiveTenantRegistry,
  sanitizeJobErrorCode,
  TenantMigrationRunner,
  type TenantMigrationDefinition,
  type TenantRegistry,
} from '@platform/core';
import { guardedJob, type GuardedJobOptions } from '../src/server/authorize';
import {
  runScheduledKeyDateRemindersJobSweep,
  runScheduledUsageRetentionPurgeJobSweep,
} from '../src/server/services';

export interface RegisteredCliJobDescriptor {
  readonly name: string;
  readonly description: string;
  readonly mode: 'manual' | 'scheduled';
  readonly schedule?: string;
}

export const REGISTERED_CLI_JOBS: readonly RegisteredCliJobDescriptor[] =
  Object.freeze([
    {
      name: 'migrate',
      description:
        'Apply pending per-tenant PostgreSQL expand/contract migrations across active registry tenants on direct port 5432',
      mode: 'manual',
    },
    {
      name: 'key-date-reminders',
      description:
        'Evaluate due key date reminders, follow-up tasks, and overdue escalations per tenant once per local day at 02:00 local time',
      mode: 'scheduled',
      schedule: '0 * * * *',
    },
    {
      name: 'usage-retention-purge',
      description:
        'Purge expired document generation usage events and daily summaries per tenant once per local day at 02:00 local time',
      mode: 'scheduled',
      schedule: '0 * * * *',
    },
  ]);

export interface MigrateJobRunSummary {
  readonly exitCode: number;
  readonly succeededTenants: string[];
  readonly failedTenants: Array<{ tenantId: string; errorCode?: string }>;
}

export async function runMigrateJobSweep(options?: {
  registry?: TenantRegistry;
  migrationsByTenant?: Readonly<
    Record<string, readonly TenantMigrationDefinition[]>
  >;
  runner?: TenantMigrationRunner;
  timeoutMs?: number;
  guardedJobOptions?: GuardedJobOptions;
}): Promise<MigrateJobRunSummary> {
  const registry = options?.registry ?? loadActiveTenantRegistry();
  const runner = options?.runner ?? new TenantMigrationRunner();
  const succeededTenants: string[] = [];
  const failedTenants: Array<{ tenantId: string; errorCode?: string }> = [];

  for (const entry of registry.tenants) {
    if (!entry.enabled) {
      continue;
    }
    const correlationId = `job-migrate-${entry.slug}-${randomUUID()}`;
    const tenantMigrations =
      options?.migrationsByTenant?.[entry.tenantId] ?? CORE_TENANT_MIGRATIONS;

    try {
      await guardedJob(
        'migrate',
        entry,
        async ({ tenantContext }) => {
          const applied = await runner.applyUp(tenantContext, tenantMigrations);
          succeededTenants.push(entry.tenantId);
          emitTenantTelemetryEvent({
            eventName: 'job.migrate.tenant_succeeded',
            tenantId: entry.tenantId,
            correlationId: tenantContext.correlationId,
            properties: {
              appliedCount: applied.length,
              databaseName: entry.postgresDatabaseName,
            },
          });
          return {
            status: 'succeeded',
            summary: { appliedCount: applied.length },
          };
        },
        {
          registry,
          correlationId,
          timeoutMs: options?.timeoutMs,
          ...options?.guardedJobOptions,
        },
      );
    } catch (err) {
      const errorCode =
        typeof (err as { code?: unknown })?.code === 'string'
          ? String((err as { code?: unknown }).code)
          : sanitizeJobErrorCode(err);
      failedTenants.push({ tenantId: entry.tenantId, errorCode });
      emitTenantTelemetryException({
        eventName: 'job.migrate.tenant_failed',
        tenantId: entry.tenantId,
        correlationId,
        error: err,
        properties: {
          databaseName: entry.postgresDatabaseName,
        },
      });
    }
  }

  return {
    exitCode: failedTenants.length > 0 ? 1 : 0,
    succeededTenants,
    failedTenants,
  };
}

function parseOptionalNowArg(args: readonly string[]): string | undefined {
  const idx = args.indexOf('--now');
  if (idx >= 0 && args[idx + 1]) {
    return args[idx + 1]!.trim();
  }
  return undefined;
}

export async function executeCliJobRunner(
  argv: readonly string[],
  io: {
    stdout?: (msg: string) => void;
    stderr?: (msg: string) => void;
  } = {},
): Promise<number> {
  const writeOut = io.stdout ?? ((msg: string) => process.stdout.write(msg));
  const writeErr = io.stderr ?? ((msg: string) => process.stderr.write(msg));

  const args = argv.slice(2);
  if (args.includes('--list')) {
    writeOut(
      `${JSON.stringify({
        runner: 'onesquared-job-runner',
        jobs: REGISTERED_CLI_JOBS,
      })}\n`,
    );
    return 0;
  }

  const jobName = args[0]?.trim() ?? '';
  if (!jobName) {
    writeErr(
      'JOB_RUNNER_USAGE_ERROR: Expected `--list` or a registered `<job-name>`.\n',
    );
    return 1;
  }

  const descriptor = REGISTERED_CLI_JOBS.find((j) => j.name === jobName);
  if (!descriptor) {
    writeErr(
      `JOB_RUNNER_UNKNOWN_JOB: Unknown or unregistered job "${jobName}". Run with --list to inspect registered jobs.\n`,
    );
    return 1;
  }

  const nowIso = parseOptionalNowArg(args);

  if (jobName === 'migrate') {
    const summary = await runMigrateJobSweep();
    writeOut(
      `${JSON.stringify({
        event: 'job.migrate.completed',
        succeededCount: summary.succeededTenants.length,
        failedCount: summary.failedTenants.length,
      })}\n`,
    );
    return summary.exitCode;
  }

  if (jobName === 'key-date-reminders') {
    const summary = await runScheduledKeyDateRemindersJobSweep({ nowIso });
    writeOut(
      `${JSON.stringify({
        event: 'job.key-date-reminders.completed',
        succeededCount: summary.succeededTenants.length,
        skippedCount: summary.skippedTenants.length,
        failedCount: summary.failedTenants.length,
      })}\n`,
    );
    return summary.exitCode;
  }

  if (jobName === 'usage-retention-purge') {
    const summary = await runScheduledUsageRetentionPurgeJobSweep({ nowIso });
    writeOut(
      `${JSON.stringify({
        event: 'job.usage-retention-purge.completed',
        succeededCount: summary.succeededTenants.length,
        skippedCount: summary.skippedTenants.length,
        failedCount: summary.failedTenants.length,
      })}\n`,
    );
    return summary.exitCode;
  }

  return 0;
}

const isDirectEntryPoint =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]!).href;

if (isDirectEntryPoint) {
  executeCliJobRunner(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`JOB_RUNNER_FATAL: ${message}\n`);
      process.exitCode = 1;
    });
}
