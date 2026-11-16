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
import {
  provisionPostgresClusterRolesAndDatabases,
  type ProvisionPostgresClusterOptions,
} from '../core/src/tenancy/postgresAdminBootstrap';
import { guardedJob, type GuardedJobOptions } from '../src/server/authorize';
import {
  runScheduledEnquiryRetentionAnonymisationJobSweep,
  runScheduledKeyDateRemindersJobSweep,
  runScheduledRegisterRemindersJobSweep,
  runScheduledUsageRetentionPurgeJobSweep,
} from '../src/server/services';
import { runSeedDemoTenant, type SeedDemoTenantResult } from './seed-demo-tenant';

export interface RegisteredCliJobDescriptor {
  readonly name: string;
  readonly description: string;
  readonly mode: 'manual' | 'scheduled';
  readonly schedule?: string;
}

export const REGISTERED_CLI_JOBS: readonly RegisteredCliJobDescriptor[] =
  Object.freeze([
    {
      name: 'provision',
      description:
        'Provision per-tenant PostgreSQL databases, NOLOGIN roles, NOINHERIT runtime Entra principal, and public schema privileges on direct port 5432',
      mode: 'manual',
    },
    {
      name: 'migrate',
      description:
        'Apply pending per-tenant PostgreSQL expand/contract migrations across active registry tenants on direct port 5432',
      mode: 'manual',
    },
    {
      name: 'seed-demo',
      description:
        'Seed non-live demo tenant database and blob storage with invented demo data and optional Entra ID user mapping',
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
    {
      name: 'enquiry-retention-anonymise',
      description:
        'Anonymise closed unconverted enquiries past the tenant retention period once per local day at 02:00 local time',
      mode: 'scheduled',
      schedule: '0 * * * *',
    },
    {
      name: 'register-reminders',
      description:
        'Dispatch due and periodic review reminders for open firm register records and undertakings once per stage',
      mode: 'scheduled',
      schedule: '0 * * * *',
    },
  ]);

export interface ProvisionJobRunSummary {
  readonly exitCode: number;
  readonly succeededTenants: string[];
  readonly failedTenants: Array<{ tenantId: string; errorCode?: string }>;
  readonly databasesProvisioned: string[];
}

export async function runProvisionJobSweep(options?: {
  registry?: TenantRegistry;
  provisioner?: (opts: ProvisionPostgresClusterOptions) => Promise<{
    databasesProvisioned: string[];
  }>;
  timeoutMs?: number;
  guardedJobOptions?: GuardedJobOptions;
}): Promise<ProvisionJobRunSummary> {
  const registry = options?.registry ?? loadActiveTenantRegistry();
  const provisioner =
    options?.provisioner ?? provisionPostgresClusterRolesAndDatabases;
  const succeededTenants: string[] = [];
  const failedTenants: Array<{ tenantId: string; errorCode?: string }> = [];
  const databasesProvisioned: string[] = [];

  for (const entry of registry.tenants) {
    if (!entry.enabled) {
      continue;
    }
    const correlationId = `job-provision-${entry.slug}-${randomUUID()}`;

    try {
      await guardedJob(
        'provision',
        entry,
        async ({ tenantContext }) => {
          const res = await provisioner({
            tenants: [
              {
                tenantId: entry.tenantId,
                environment: entry.environment,
              },
            ],
          });
          succeededTenants.push(entry.tenantId);
          databasesProvisioned.push(...res.databasesProvisioned);
          emitTenantTelemetryEvent({
            eventName: 'job.provision.tenant_succeeded',
            tenantId: entry.tenantId,
            correlationId: tenantContext.correlationId,
            properties: {
              databasesProvisionedCount: res.databasesProvisioned.length,
              databaseName: entry.postgresDatabaseName,
            },
          });
          return {
            status: 'succeeded',
            summary: {
              databasesProvisionedCount: res.databasesProvisioned.length,
            },
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
        eventName: 'job.provision.tenant_failed',
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
    databasesProvisioned,
  };
}

export interface SeedDemoJobRunSummary {
  readonly exitCode: number;
  readonly succeededTenants: string[];
  readonly failedTenants: Array<{ tenantId: string; errorCode?: string }>;
  readonly resultsByTenant: Record<string, SeedDemoTenantResult>;
}

export async function runSeedDemoJobSweep(options?: {
  registry?: TenantRegistry;
  force?: boolean;
  env?: Record<string, string | undefined>;
  rootDir?: string;
  timeoutMs?: number;
  guardedJobOptions?: GuardedJobOptions;
}): Promise<SeedDemoJobRunSummary> {
  const registry = options?.registry ?? loadActiveTenantRegistry();
  const env = options?.env ?? process.env;
  const force =
    options?.force === true ||
    env.SEED_DEMO_FORCE?.trim().toLowerCase() === 'true';
  const succeededTenants: string[] = [];
  const failedTenants: Array<{ tenantId: string; errorCode?: string }> = [];
  const resultsByTenant: Record<string, SeedDemoTenantResult> = {};

  for (const entry of registry.tenants) {
    if (!entry.enabled) {
      continue;
    }
    const correlationId = `job-seed-demo-${entry.slug}-${randomUUID()}`;

    try {
      await guardedJob(
        'seed-demo',
        entry,
        async ({ tenantContext }) => {
          if (
            entry.environment === 'live' ||
            tenantContext.environment === 'live'
          ) {
            const liveErr = new Error(
              'SEED_DEMO_LIVE_FORBIDDEN: Refusing to seed demo data in the live environment.',
            ) as Error & { code: string };
            liveErr.code = 'SEED_DEMO_LIVE_FORBIDDEN';
            throw liveErr;
          }

          const res = await runSeedDemoTenant({
            args: force ? ['--force'] : [],
            env: {
              ...env,
              PLATFORM_TENANT_PACKAGE_DIR:
                entry.packageDir ||
                env.PLATFORM_TENANT_PACKAGE_DIR ||
                'client-not-a-law-firm',
              PLATFORM_ENVIRONMENT: entry.environment,
            },
            rootDir: options?.rootDir,
            logger: () => {},
            warnLogger: () => {},
          });

          succeededTenants.push(entry.tenantId);
          resultsByTenant[entry.tenantId] = res;
          emitTenantTelemetryEvent({
            eventName: 'job.seed-demo.tenant_succeeded',
            tenantId: entry.tenantId,
            correlationId: tenantContext.correlationId,
            properties: {
              mappedPersonas: res.mappedEntraPersonas,
              unboundPrivilegedPersonas: res.unboundPrivilegedPersonas,
              peopleCount: res.counts.people,
              organisationsCount: res.counts.organisations,
              mattersCount: res.counts.matters,
              enquiriesCount: res.counts.enquiries,
              tasksCount: res.counts.tasks,
              keyDatesCount: res.counts.keyDates,
            },
          });
          return {
            status: 'succeeded',
            summary: {
              mappedPersonas: res.mappedEntraPersonas,
              peopleCount: res.counts.people,
              mattersCount: res.counts.matters,
              enquiriesCount: res.counts.enquiries,
              tasksCount: res.counts.tasks,
              keyDatesCount: res.counts.keyDates,
            },
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
        eventName: 'job.seed-demo.tenant_failed',
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
    resultsByTenant,
  };
}

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
  if (args.length === 1 && args[0] === '--list') {
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

  const extraArgs = args.slice(1);
  const isSeedDemoForceFlag =
    jobName === 'seed-demo' &&
    extraArgs.length === 1 &&
    extraArgs[0] === '--force';
  if (extraArgs.length > 0 && !isSeedDemoForceFlag) {
    writeErr(
      'JOB_RUNNER_USAGE_ERROR: Unexpected CLI arguments or flags. Scheduled jobs accept only `--list` or `<job-name>`.\n',
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

  if (jobName === 'provision') {
    const summary = await runProvisionJobSweep();
    writeOut(
      `${JSON.stringify({
        event: 'job.provision.completed',
        succeededCount: summary.succeededTenants.length,
        failedCount: summary.failedTenants.length,
        databasesProvisionedCount: summary.databasesProvisioned.length,
        ...(summary.failedTenants.length > 0
          ? { failedTenants: summary.failedTenants }
          : {}),
      })}\n`,
    );
    return summary.exitCode;
  }

  if (jobName === 'migrate') {
    const summary = await runMigrateJobSweep();
    writeOut(
      `${JSON.stringify({
        event: 'job.migrate.completed',
        succeededCount: summary.succeededTenants.length,
        failedCount: summary.failedTenants.length,
        ...(summary.failedTenants.length > 0
          ? { failedTenants: summary.failedTenants }
          : {}),
      })}\n`,
    );
    return summary.exitCode;
  }

  if (jobName === 'seed-demo') {
    const summary = await runSeedDemoJobSweep({ force: isSeedDemoForceFlag });
    const firstRes = Object.values(summary.resultsByTenant)[0];
    writeOut(
      `${JSON.stringify({
        event: 'job.seed-demo.completed',
        succeededCount: summary.succeededTenants.length,
        failedCount: summary.failedTenants.length,
        mappedPersonas: firstRes?.mappedEntraPersonas ?? 0,
        peopleCount: firstRes?.counts.people ?? 0,
        mattersCount: firstRes?.counts.matters ?? 0,
        enquiriesCount: firstRes?.counts.enquiries ?? 0,
        tasksCount: firstRes?.counts.tasks ?? 0,
        keyDatesCount: firstRes?.counts.keyDates ?? 0,
        ...(summary.failedTenants.length > 0
          ? { failedTenants: summary.failedTenants }
          : {}),
      })}\n`,
    );
    return summary.exitCode;
  }

  if (jobName === 'key-date-reminders') {
    const summary = await runScheduledKeyDateRemindersJobSweep();
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
    const summary = await runScheduledUsageRetentionPurgeJobSweep();
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

  if (jobName === 'enquiry-retention-anonymise') {
    const summary = await runScheduledEnquiryRetentionAnonymisationJobSweep();
    writeOut(
      `${JSON.stringify({
        event: 'job.enquiry-retention-anonymise.completed',
        succeededCount: summary.succeededTenants.length,
        skippedCount: summary.skippedTenants.length,
        failedCount: summary.failedTenants.length,
      })}\n`,
    );
    return summary.exitCode;
  }

  if (jobName === 'register-reminders') {
    const summary = await runScheduledRegisterRemindersJobSweep();
    writeOut(
      `${JSON.stringify({
        event: 'job.register-reminders.completed',
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
