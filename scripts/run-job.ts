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
  initializeAzureMonitorTelemetry,
  loadActiveTenantRegistry,
  sanitizeJobErrorCode,
  shutdownAzureMonitorTelemetry,
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
  checkActiveTenantExtensionsReadiness,
  getActiveTenantConfiguration,
  getPlatformExtensionHost,
} from '../src/platform/tenantRuntime';
import {
  runScheduledCommunicationChasesJobSweep,
  runScheduledEnquiryRetentionAnonymisationJobSweep,
  runScheduledKeyDateRemindersJobSweep,
  runScheduledNotificationDigestsJobSweep,
  runScheduledOutboxDrainJobSweep,
  runScheduledQuoteExpiryJobSweep,
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
    {
      name: 'outbox-drain',
      description:
        'Drain due email and Teams activity outbox rows with exponential backoff and scrub expired terminal content past outboxContentRetentionDays',
      mode: 'scheduled',
      schedule: '*/5 * * * *',
    },
    {
      name: 'notification-digests',
      description:
        'Compile and queue Mon-Fri daily and weekly email notification digests per tenant user once per working day',
      mode: 'scheduled',
      schedule: '0 * * * *',
    },
    {
      name: 'quote-expiry',
      description:
        'Transition overdue Sent and Follow-up due quotes past validUntil to Expired once per local day at 02:00 local time',
      mode: 'scheduled',
      schedule: '0 * * * *',
    },
    {
      name: 'communication-chases',
      description:
        'Run automated communication chasing steps (day-7 and day-14 client reminder emails, day-21 escalation tasks) once per local day at 08:00 local time',
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

export interface MigrateDownTenantOutcome {
  readonly tenantId: string;
  readonly previousVersion: string | null;
  readonly targetVersion: string;
  readonly resultingVersion: string | null;
  readonly outcome: 'rolled_back' | 'refused';
  readonly errorCode?: string;
}

export interface MigrateDownJobRunSummary {
  readonly exitCode: number;
  readonly targetVersion: string;
  readonly succeededTenants: string[];
  readonly failedTenants: Array<{ tenantId: string; errorCode: string }>;
  readonly results: readonly MigrateDownTenantOutcome[];
}

export type ParsedMigrateInvocation =
  | { readonly ok: true; readonly mode: 'up' }
  | { readonly ok: true; readonly mode: 'down'; readonly targetVersion: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function parseMigrateInvocation(
  extraArgs: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  knownMigrations: readonly TenantMigrationDefinition[] = CORE_TENANT_MIGRATIONS,
): ParsedMigrateInvocation {
  let hasDownFlag = false;
  let cliTarget: string | undefined;
  let hasConfirmRollbackFlag = false;

  for (let i = 0; i < extraArgs.length; i++) {
    const token = extraArgs[i]!;
    if (token === '--down') {
      hasDownFlag = true;
    } else if (token === '--confirm-rollback') {
      hasConfirmRollbackFlag = true;
    } else if (token === '--target') {
      const next = extraArgs[i + 1];
      if (next === undefined || next.startsWith('--') || !next.trim()) {
        return {
          ok: false,
          code: 'MIGRATION_ROLLBACK_TARGET_REQUIRED',
          message:
            'JOB_RUNNER_USAGE_ERROR MIGRATION_ROLLBACK_TARGET_REQUIRED: `--target` requires a migration version (for example `0027`).',
        };
      }
      cliTarget = next.trim();
      i += 1;
    } else if (token.startsWith('--target=')) {
      const val = token.slice('--target='.length).trim();
      if (!val) {
        return {
          ok: false,
          code: 'MIGRATION_ROLLBACK_TARGET_REQUIRED',
          message:
            'JOB_RUNNER_USAGE_ERROR MIGRATION_ROLLBACK_TARGET_REQUIRED: `--target=` requires a non-empty migration version.',
        };
      }
      cliTarget = val;
    } else {
      return {
        ok: false,
        code: 'JOB_RUNNER_USAGE_ERROR',
        message:
          'JOB_RUNNER_USAGE_ERROR: Unexpected CLI arguments or flags for `migrate`. Only `--down --target <version> --confirm-rollback` is accepted.',
      };
    }
  }

  const envTarget = env.PLATFORM_MIGRATE_DOWN_TARGET?.trim() ?? '';
  const envConfirmRaw = env.PLATFORM_MIGRATE_DOWN_CONFIRM?.trim().toLowerCase() ?? '';
  const downViaEnvRequested =
    Boolean(envTarget) || (Boolean(envConfirmRaw) && envConfirmRaw !== 'false');

  if (!hasDownFlag && !cliTarget && !hasConfirmRollbackFlag && !downViaEnvRequested) {
    return { ok: true, mode: 'up' };
  }

  if (!hasDownFlag && (cliTarget !== undefined || hasConfirmRollbackFlag)) {
    return {
      ok: false,
      code: 'JOB_RUNNER_USAGE_ERROR',
      message:
        'JOB_RUNNER_USAGE_ERROR: Migrate-down mode requires `--down` alongside `--target <version>` and `--confirm-rollback`.',
    };
  }

  const targetVersion = cliTarget ?? envTarget;
  if (!targetVersion) {
    return {
      ok: false,
      code: 'MIGRATION_ROLLBACK_TARGET_REQUIRED',
      message:
        'JOB_RUNNER_USAGE_ERROR MIGRATION_ROLLBACK_TARGET_REQUIRED: Specify `--target <version>` or `PLATFORM_MIGRATE_DOWN_TARGET`.',
    };
  }

  const confirmed = hasConfirmRollbackFlag || envConfirmRaw === 'true';
  if (!confirmed) {
    return {
      ok: false,
      code: 'MIGRATION_ROLLBACK_CONFIRMATION_REQUIRED',
      message:
        'JOB_RUNNER_USAGE_ERROR MIGRATION_ROLLBACK_CONFIRMATION_REQUIRED: Explicit confirmation via `--confirm-rollback` or `PLATFORM_MIGRATE_DOWN_CONFIRM=true` is required.',
    };
  }

  if (!knownMigrations.some((m) => m.version === targetVersion)) {
    return {
      ok: false,
      code: 'MIGRATION_ROLLBACK_UNKNOWN_VERSION',
      message: `JOB_RUNNER_USAGE_ERROR MIGRATION_ROLLBACK_UNKNOWN_VERSION: Target migration "${targetVersion}" is unknown in this image.`,
    };
  }

  return {
    ok: true,
    mode: 'down',
    targetVersion,
  };
}

export async function runMigrateDownJob(options: {
  targetVersion: string;
  confirmRollback: boolean;
  registry?: TenantRegistry;
  migrationsByTenant?: Readonly<
    Record<string, readonly TenantMigrationDefinition[]>
  >;
  runner?: TenantMigrationRunner;
  timeoutMs?: number;
  guardedJobOptions?: GuardedJobOptions;
}): Promise<MigrateDownJobRunSummary> {
  if (!options.confirmRollback) {
    const err = new Error(
      'MIGRATION_ROLLBACK_CONFIRMATION_REQUIRED: Explicit rollback confirmation is required.',
    ) as Error & { code: string };
    err.code = 'MIGRATION_ROLLBACK_CONFIRMATION_REQUIRED';
    throw err;
  }

  const targetVersion = options.targetVersion?.trim() ?? '';
  if (!targetVersion) {
    const err = new Error(
      'MIGRATION_ROLLBACK_TARGET_REQUIRED: Target migration version is required.',
    ) as Error & { code: string };
    err.code = 'MIGRATION_ROLLBACK_TARGET_REQUIRED';
    throw err;
  }

  const registry = options.registry ?? loadActiveTenantRegistry();
  const runner = options.runner ?? new TenantMigrationRunner();
  const succeededTenants: string[] = [];
  const failedTenants: Array<{ tenantId: string; errorCode: string }> = [];
  const results: MigrateDownTenantOutcome[] = [];

  for (const entry of registry.tenants) {
    if (!entry.enabled) {
      continue;
    }
    const correlationId = `job-migrate-down-${entry.slug}-${randomUUID()}`;
    const tenantMigrations =
      options.migrationsByTenant?.[entry.tenantId] ?? CORE_TENANT_MIGRATIONS;

    if (!tenantMigrations.some((m) => m.version === targetVersion)) {
      const unknownErr = new Error(
        `MIGRATION_ROLLBACK_UNKNOWN_VERSION: Target migration "${targetVersion}" is not defined in the current image.`,
      ) as Error & { code: string };
      unknownErr.code = 'MIGRATION_ROLLBACK_UNKNOWN_VERSION';
      failedTenants.push({
        tenantId: entry.tenantId,
        errorCode: unknownErr.code,
      });
      results.push({
        tenantId: entry.tenantId,
        previousVersion: null,
        targetVersion,
        resultingVersion: null,
        outcome: 'refused',
        errorCode: unknownErr.code,
      });
      emitTenantTelemetryException({
        eventName: 'job.migrate.down_failed',
        tenantId: entry.tenantId,
        correlationId,
        error: unknownErr,
        properties: {
          targetVersion,
          outcome: 'refused',
        },
      });
      continue;
    }

    let previousVersion: string | null = null;
    try {
      const tenantOutcome = await guardedJob(
        'migrate',
        entry,
        async ({ tenantContext }) => {
          const appliedBefore = await runner.listAppliedMigrations(tenantContext);
          const newest = appliedBefore[appliedBefore.length - 1];
          previousVersion = newest?.version ?? null;

          if (!newest || newest.version !== targetVersion) {
            const notNewestErr = new Error(
              `MIGRATION_ROLLBACK_NOT_NEWEST: Refusing to roll back "${targetVersion}" because the newest applied migration is "${previousVersion ?? 'none'}". Only the single newest applied migration may be rolled back.`,
            ) as Error & { code: string };
            notNewestErr.code = 'MIGRATION_ROLLBACK_NOT_NEWEST';
            throw notNewestErr;
          }

          const rolledBack = await runner.rollbackVersion(
            tenantContext,
            targetVersion,
            tenantMigrations,
          );
          if (!rolledBack) {
            const failErr = new Error(
              `MIGRATION_ROLLBACK_FAILED: Target migration "${targetVersion}" did not roll back cleanly.`,
            ) as Error & { code: string };
            failErr.code = 'MIGRATION_ROLLBACK_FAILED';
            throw failErr;
          }

          const appliedAfter = await runner.listAppliedMigrations(tenantContext);
          const resultingVersion =
            appliedAfter[appliedAfter.length - 1]?.version ?? null;

          emitTenantTelemetryEvent({
            eventName: 'job.migrate.down',
            tenantId: entry.tenantId,
            correlationId: tenantContext.correlationId,
            properties: {
              previousVersion,
              targetVersion,
              resultingVersion,
              outcome: 'rolled_back',
            },
          });

          return {
            status: 'succeeded',
            summary: { rolledBack: 1 },
            outcome: {
              tenantId: entry.tenantId,
              previousVersion,
              targetVersion,
              resultingVersion,
              outcome: 'rolled_back' as const,
            },
          };
        },
        {
          registry,
          correlationId,
          timeoutMs: options.timeoutMs,
          ...options.guardedJobOptions,
        },
      );

      succeededTenants.push(entry.tenantId);
      results.push(tenantOutcome.outcome);
    } catch (err) {
      const errorCode =
        typeof (err as { code?: unknown })?.code === 'string'
          ? String((err as { code?: unknown }).code)
          : sanitizeJobErrorCode(err);
      failedTenants.push({ tenantId: entry.tenantId, errorCode });
      results.push({
        tenantId: entry.tenantId,
        previousVersion,
        targetVersion,
        resultingVersion: previousVersion,
        outcome: 'refused',
        errorCode,
      });
      emitTenantTelemetryException({
        eventName: 'job.migrate.down_failed',
        tenantId: entry.tenantId,
        correlationId,
        error: err,
        properties: {
          previousVersion,
          targetVersion,
          outcome: 'refused',
        },
      });
    }
  }

  return {
    exitCode: failedTenants.length > 0 ? 1 : 0,
    targetVersion,
    succeededTenants,
    failedTenants,
    results,
  };
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
          for (const rec of applied) {
            const pmsVerify = rec.verificationMetadata?.pmsPenceVerification as
              | {
                  readonly tablesVerified: number;
                  readonly totalRowsChecked: number;
                  readonly totalNonNullChecked: number;
                  readonly totalColumnsVerified: number;
                  readonly mismatchCount: number;
                  readonly maxColumnTotalDiffPence: number;
                  readonly columns: ReadonlyArray<{
                    readonly table: string;
                    readonly column: string;
                    readonly sourceColumn: string;
                    readonly rowCount: number;
                    readonly nonNullCount: number;
                    readonly totalDiffPence: number;
                  }>;
                }
              | undefined;
            if (pmsVerify) {
              emitTenantTelemetryEvent({
                eventName: 'job.migrate.pms_pence_verified',
                tenantId: entry.tenantId,
                correlationId: tenantContext.correlationId,
                properties: {
                  databaseName: entry.postgresDatabaseName,
                  tablesVerified: pmsVerify.tablesVerified,
                  totalRowsChecked: pmsVerify.totalRowsChecked,
                  totalNonNullChecked: pmsVerify.totalNonNullChecked,
                  totalColumnsVerified: pmsVerify.totalColumnsVerified,
                  mismatchCount: pmsVerify.mismatchCount,
                  maxColumnTotalDiffPence: pmsVerify.maxColumnTotalDiffPence,
                  columns: pmsVerify.columns,
                },
              });
            }
          }
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
    env?: Readonly<Record<string, string | undefined>>;
    registry?: TenantRegistry;
    runner?: TenantMigrationRunner;
    telemetryInitOptions?: Parameters<typeof initializeAzureMonitorTelemetry>[0];
    telemetryShutdownOptions?: Parameters<typeof shutdownAzureMonitorTelemetry>[0];
  } = {},
): Promise<number> {
  const writeOut = io.stdout ?? ((msg: string) => process.stdout.write(msg));
  const writeErr = io.stderr ?? ((msg: string) => process.stderr.write(msg));
  const env = io.env ?? process.env;

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

  if (args.length === 1 && args[0] === '--verify-extensions') {
    const activeCfg = getActiveTenantConfiguration();
    const host = getPlatformExtensionHost();
    const readiness = checkActiveTenantExtensionsReadiness();
    const registeredExtensions = host
      .getActiveExtensionsForTenant(activeCfg)
      .map((ext) => ({ id: ext.manifest.id, version: ext.manifest.version }));
    if (!readiness.ok) {
      writeErr(
        `${JSON.stringify({
          event: 'job.verify-extensions.failed',
          tenantId: activeCfg.tenantId,
          environment: activeCfg.environment,
          errorCode: readiness.errorCode ?? 'EXTENSION_LOAD_FAILED',
        })}\n`,
      );
      return 1;
    }
    writeOut(
      `${JSON.stringify({
        event: 'job.verify-extensions.succeeded',
        tenantId: activeCfg.tenantId,
        environment: activeCfg.environment,
        enabledExtensions: activeCfg.enabledExtensions ?? [],
        registeredExtensions,
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
  const parsedMigrate =
    jobName === 'migrate' ? parseMigrateInvocation(extraArgs, env) : null;
  if (parsedMigrate && !parsedMigrate.ok) {
    writeErr(`${parsedMigrate.message}\n`);
    return 1;
  }
  if (jobName !== 'migrate' && extraArgs.length > 0 && !isSeedDemoForceFlag) {
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

  await initializeAzureMonitorTelemetry(io.telemetryInitOptions);
  try {
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
      if (parsedMigrate && parsedMigrate.ok && parsedMigrate.mode === 'down') {
        const summary = await runMigrateDownJob({
          targetVersion: parsedMigrate.targetVersion,
          confirmRollback: true,
          ...(io.registry ? { registry: io.registry } : {}),
          ...(io.runner ? { runner: io.runner } : {}),
        });
        for (const r of summary.results) {
          writeOut(
            `${JSON.stringify({
              event: 'job.migrate.down',
              tenantId: r.tenantId,
              previousVersion: r.previousVersion,
              targetVersion: r.targetVersion,
              resultingVersion: r.resultingVersion,
              outcome: r.outcome,
              ...(r.errorCode ? { errorCode: r.errorCode } : {}),
            })}\n`,
          );
        }
        return summary.exitCode;
      }

      const summary = await runMigrateJobSweep({
        ...(io.registry ? { registry: io.registry } : {}),
        ...(io.runner ? { runner: io.runner } : {}),
      });
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

    if (jobName === 'outbox-drain') {
      const summary = await runScheduledOutboxDrainJobSweep();
      const failedPermanentCount = Object.values(summary.resultsByTenant).reduce(
        (acc, res) =>
          acc +
          (res.failedPermanentCount ?? 0) +
          (res.teams?.failedPermanentCount ?? 0),
        0,
      );
      writeOut(
        `${JSON.stringify({
          event: 'job.outbox-drain.completed',
          succeededCount: summary.succeededTenants.length,
          skippedCount: summary.skippedTenants.length,
          failedCount: summary.failedTenants.length,
          failedPermanentCount,
        })}\n`,
      );
      return summary.exitCode;
    }

    if (jobName === 'notification-digests') {
      const summary = await runScheduledNotificationDigestsJobSweep();
      writeOut(
        `${JSON.stringify({
          event: 'job.notification-digests.completed',
          succeededCount: summary.succeededTenants.length,
          skippedCount: summary.skippedTenants.length,
          failedCount: summary.failedTenants.length,
        })}\n`,
      );
      return summary.exitCode;
    }

    if (jobName === 'quote-expiry') {
      const summary = await runScheduledQuoteExpiryJobSweep();
      writeOut(
        `${JSON.stringify({
          event: 'job.quote-expiry.completed',
          succeededCount: summary.succeededTenants.length,
          skippedCount: summary.skippedTenants.length,
          failedCount: summary.failedTenants.length,
        })}\n`,
      );
      return summary.exitCode;
    }

    if (jobName === 'communication-chases') {
      const summary = await runScheduledCommunicationChasesJobSweep();
      writeOut(
        `${JSON.stringify({
          event: 'job.communication-chases.completed',
          succeededCount: summary.succeededTenants.length,
          skippedCount: summary.skippedTenants.length,
          failedCount: summary.failedTenants.length,
        })}\n`,
      );
      return summary.exitCode;
    }

    return 0;
  } finally {
    await shutdownAzureMonitorTelemetry(io.telemetryShutdownOptions);
  }
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
