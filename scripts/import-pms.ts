import { pathToFileURL } from 'node:url';
import '../core/src/tenancy/pgNodePreload';
import {
  getGlobalTenantPostgresPoolManager,
  loadActiveTenantRegistry,
  type TenantConfiguration,
  type TenantContext,
  type TenantRegistry,
} from '@platform/core';
import {
  getActiveTenantConfiguration,
  getTenantConfigurationForRegistryEntry,
} from '../src/platform/tenantRuntime';
import {
  importPmsWorkbookToPostgres,
  parseImportPmsCliArgs,
  type ImportSummary,
} from '../src/pms/importPms';
import { buildSystemJobTenantContext } from './lib/systemJobTenantContext';

export interface RunImportPmsCliOptions {
  readonly registry?: TenantRegistry;
  readonly environment?: string;
  readonly importer?: (
    ctx: TenantContext,
    options?: {
      workbookPath?: string;
      asAtDate?: string;
      importedAt?: string;
    },
  ) => Promise<ImportSummary>;
  readonly closePools?: () => Promise<void>;
}

export interface RunImportPmsCliResult {
  readonly tenantId: string;
  readonly databaseName: string;
  readonly asAtDate: string;
  readonly importedAt: string;
  readonly counts: ImportSummary['counts'];
}

function createCodedError(code: string, message: string): Error & { code: string } {
  const err = new Error(`${code}: ${message}`) as Error & { code: string };
  err.code = code;
  return err;
}

export async function runImportPmsCli(
  rawArgs: readonly string[],
  options: RunImportPmsCliOptions = {},
): Promise<RunImportPmsCliResult> {
  const envName = (
    options.environment ??
    process.env.PLATFORM_ENVIRONMENT ??
    ''
  )
    .trim()
    .toLowerCase();
  if (envName === 'live') {
    throw createCodedError(
      'PMS_IMPORT_LIVE_FORBIDDEN',
      'Refusing to run pms:import when environment is "live".',
    );
  }

  const cliOptions = parseImportPmsCliArgs(rawArgs);
  const registry = options.registry ?? loadActiveTenantRegistry();
  const enabledEntries = registry.tenants.filter((t) => t.enabled);

  const targetTenantId =
    cliOptions.tenant?.trim().replace(/_/g, '-') ||
    (enabledEntries.length === 1
      ? enabledEntries[0]!.tenantId
      : getActiveTenantConfiguration().tenantId);

  const entry = registry.tenants.find((t) => t.tenantId === targetTenantId);
  if (!entry || !entry.enabled) {
    throw createCodedError(
      'TENANCY_UNREGISTERED_JOB_TENANT',
      `Tenant "${targetTenantId}" is not registered or is disabled in the active tenant registry.`,
    );
  }

  if (entry.environment === 'live') {
    throw createCodedError(
      'PMS_IMPORT_LIVE_FORBIDDEN',
      `Refusing to run pms:import for live tenant "${entry.tenantId}".`,
    );
  }

  const resolvedConfig = getTenantConfigurationForRegistryEntry(
    entry,
    registry.hostingMode,
  );
  if (resolvedConfig.environment === 'live') {
    throw createCodedError(
      'PMS_IMPORT_LIVE_FORBIDDEN',
      `Refusing to run pms:import for live configuration of tenant "${entry.tenantId}".`,
    );
  }

  const effectiveConfig: TenantConfiguration = {
    ...resolvedConfig,
    keyVault: entry.keyVaultUri
      ? {
          vaultName: resolvedConfig.keyVault?.vaultName,
          vaultUri: entry.keyVaultUri,
        }
      : resolvedConfig.keyVault,
  };

  const ctx = buildSystemJobTenantContext({
    tenantConfig: effectiveConfig,
    configuredPostgresHost: entry.postgresHost,
    jobKey: 'pms-import',
  });

  if (entry.postgresDatabaseName !== ctx.postgresDatabaseName) {
    throw createCodedError(
      'TENANT_REGISTRY_DATABASE_MISMATCH',
      `Registry postgresDatabaseName does not match the database derived for "${entry.tenantId}".`,
    );
  }

  const importer = options.importer ?? importPmsWorkbookToPostgres;
  const closePools =
    options.closePools ??
    (() => getGlobalTenantPostgresPoolManager().closeAllPools());

  try {
    const pgResult = await importer(ctx, {
      asAtDate: cliOptions.asAtDate,
    });
    return {
      tenantId: ctx.tenantId,
      databaseName: ctx.postgresDatabaseName,
      asAtDate: pgResult.asAtDate,
      importedAt: pgResult.importedAt,
      counts: pgResult.counts,
    };
  } finally {
    await closePools();
  }
}

const isDirectEntryPoint =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]!).href;

if (isDirectEntryPoint) {
  runImportPmsCli(process.argv.slice(2))
    .then((result) => {
      console.log(
        'PMS extract imported into tenant PostgreSQL database successfully:',
      );
      console.log(`  Tenant ID:     ${result.tenantId}`);
      console.log(`  Database:      ${result.databaseName}`);
      console.log(`  As-at date:    ${result.asAtDate}`);
      console.log(`  Imported at:   ${result.importedAt}`);
      console.log('  Row counts:', result.counts);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`PMS_IMPORT_FAILED: ${message}\n`);
      process.exitCode = 1;
    });
}
