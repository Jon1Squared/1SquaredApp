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
  resolveTenantFromVerifiedToken,
  TenantMigrationRunner,
  type TenantMigrationDefinition,
  type TenantRegistry,
} from '@platform/core';

export interface RegisteredCliJobDescriptor {
  readonly name: string;
  readonly description: string;
  readonly mode: 'manual' | 'scheduled';
}

export const REGISTERED_CLI_JOBS: readonly RegisteredCliJobDescriptor[] =
  Object.freeze([
    {
      name: 'migrate',
      description:
        'Apply pending per-tenant PostgreSQL expand/contract migrations across active registry tenants on direct port 5432',
      mode: 'manual',
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
    const ctx = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'system:job:migrate',
        tenantId: entry.tenantId,
        name: 'Platform Migration Job',
        email: 'migrate-job@platform.example',
        roles: ['admin'],
        mfaVerified: true,
      },
      hostingMode: registry.hostingMode,
      environment: entry.environment,
      correlationId,
      configuredPostgresHost: entry.postgresHost,
      configuredKeyVault: {
        vaultUri: entry.keyVaultUri,
      },
    });

    const tenantMigrations =
      options?.migrationsByTenant?.[entry.tenantId] ?? CORE_TENANT_MIGRATIONS;

    try {
      const applied = await runner.applyUp(ctx, tenantMigrations);
      succeededTenants.push(entry.tenantId);
      emitTenantTelemetryEvent({
        eventName: 'job.migrate.tenant_succeeded',
        tenantId: entry.tenantId,
        correlationId,
        properties: {
          appliedCount: applied.length,
          databaseName: entry.postgresDatabaseName,
        },
      });
    } catch (err) {
      const errorCode =
        typeof (err as { code?: unknown })?.code === 'string'
          ? String((err as { code?: unknown }).code)
          : undefined;
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
