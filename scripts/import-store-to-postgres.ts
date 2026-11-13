/**
 * One-off JSON-store-to-PostgreSQL import job entry point (`scripts/import-store-to-postgres.ts` -> `dist/jobs/import-store.mjs`).
 *
 * Usage:
 *   npm run db:import -- --modules documents,document-store
 *   node dist/jobs/import-store.mjs --modules documents,document-store
 *   node dist/jobs/import-store.mjs --help
 *
 * Follows `docs/runbooks/store-cut-over.md` (`R404`, `R405`, `R407`):
 * - Imports each specified module idempotently via `TenantScopedRepository` (`SET LOCAL ROLE` in every transaction).
 * - Verifies row counts on a fresh repository connection.
 * - Logs structured JSON containing only `correlationId`, `tenantId`, `environment`, `modules`, and counts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import '../core/src/tenancy/pgNodePreload';
import {
  loadActiveTenantRegistry,
  loadAndValidateTenantConfig,
  type PlatformEnvironment,
  type TenantConfiguration,
} from '@platform/core';
import { getActiveTenantConfiguration } from '../src/platform/tenantRuntime';
import { getStore } from '../src/server/store';
import {
  DEFAULT_S014_IMPORT_MODULES,
  importFirmStoreModulesToPostgres,
  type ImportableStoreModule,
} from '../src/server/storePostgresImport';
import { buildSystemJobTenantContext } from './lib/systemJobTenantContext';

const VALID_MODULES = new Set<ImportableStoreModule>([
  'documents',
  'document-store',
  'key-dates',
]);

function printUsage(): void {
  console.log(
    [
      'Usage: import-store [--modules <csv>] [--clear] [--help]',
      '',
      'Options:',
      '  --modules <csv>  Comma-separated modules to import (default: documents,document-store)',
      '                   Supported: documents, document-store, key-dates',
      '  --clear          Clear target PostgreSQL module tables for the tenant before importing',
      '  --help, -h       Print usage and exit 0',
    ].join('\n'),
  );
}

export function parseStoreImportCliArgs(argv: readonly string[]): {
  help: boolean;
  clearFirst: boolean;
  modules: ImportableStoreModule[];
} {
  let help = false;
  let clearFirst = false;
  let rawModules: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--clear') {
      clearFirst = true;
    } else if (arg === '--modules') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('CLI_USAGE_ERROR: --modules requires a comma-separated list.');
      }
      rawModules = next;
      i += 1;
    } else if (arg?.startsWith('--modules=')) {
      rawModules = arg.slice('--modules='.length);
    } else if (arg) {
      throw new Error(`CLI_USAGE_ERROR: Unknown argument "${arg}".`);
    }
  }

  const modules: ImportableStoreModule[] = rawModules
    ? rawModules
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
        .map((m) => {
          if (!VALID_MODULES.has(m as ImportableStoreModule)) {
            throw new Error(
              `CLI_USAGE_ERROR: Unsupported import module "${m}". Expected one of: ${Array.from(VALID_MODULES).join(', ')}.`,
            );
          }
          return m as ImportableStoreModule;
        })
    : [...DEFAULT_S014_IMPORT_MODULES];

  if (modules.length === 0) {
    throw new Error('CLI_USAGE_ERROR: At least one module must be specified.');
  }

  return { help, clearFirst, modules };
}

function loadTenantConfigurationFromPackageDir(
  packageDir: string,
  environment: PlatformEnvironment,
  hostingMode: 'single_tenant' | 'multi_tenant',
): TenantConfiguration {
  const resolvedPkg = path.resolve(process.cwd(), packageDir);
  const basePath = path.join(resolvedPkg, 'config', 'base.json');
  const rawBase = JSON.parse(fs.readFileSync(basePath, 'utf8')) as Record<
    string,
    unknown
  >;
  const overlayPath = path.join(
    resolvedPkg,
    'config',
    'environments',
    `${environment}.json`,
  );
  const overlay = fs.existsSync(overlayPath)
    ? (JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as Record<
        string,
        unknown
      >)
    : {};
  return loadAndValidateTenantConfig(rawBase, overlay, environment, hostingMode);
}

export async function runStoreImportCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const parsed = parseStoreImportCliArgs(argv);
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const correlationId = `corr-store-import-${randomUUID()}`;
  const hasExplicitRegistry = Boolean(
    process.env.PLATFORM_TENANT_REGISTRY_PATH?.trim() ||
      process.env.PLATFORM_TENANT_REGISTRY_JSON?.trim(),
  );

  if (hasExplicitRegistry) {
    const registry = loadActiveTenantRegistry();
    let failedCount = 0;
    for (const entry of registry.tenants) {
      if (!entry.enabled) continue;
      const tenantCorrelationId = `${correlationId}:${entry.slug}`;
      try {
        const tenantConfig = loadTenantConfigurationFromPackageDir(
          entry.packageDir,
          entry.environment,
          registry.hostingMode,
        );
        const store = getStore();
        const res = await importFirmStoreModulesToPostgres({
          ctx: buildSystemJobTenantContext({
            tenantConfig,
            jobKey: 'store-import',
            correlationId: tenantCorrelationId,
            configuredPostgresHost: entry.postgresHost,
          }),
          store,
          modules: parsed.modules,
          clearFirst: parsed.clearFirst,
        });
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'store_import.tenant_succeeded',
            correlationId: tenantCorrelationId,
            tenantId: res.tenantId,
            environment: res.environment,
            modules: res.modules,
            counts: res.counts,
          }),
        );
      } catch (err) {
        failedCount += 1;
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'store_import.tenant_failed',
            correlationId: tenantCorrelationId,
            tenantId: entry.tenantId,
            environment: entry.environment,
            errorCode:
              err instanceof Error && 'code' in err
                ? String((err as { code?: unknown }).code)
                : 'STORE_IMPORT_FAILED',
          }),
        );
      }
    }
    return failedCount === 0 ? 0 : 1;
  }

  const tenantConfig = getActiveTenantConfiguration();
  const store = getStore();
  const res = await importFirmStoreModulesToPostgres({
    ctx: buildSystemJobTenantContext({
      tenantConfig,
      jobKey: 'store-import',
      correlationId,
    }),
    store,
    modules: parsed.modules,
    clearFirst: parsed.clearFirst,
  });
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'store_import.tenant_succeeded',
      correlationId,
      tenantId: res.tenantId,
      environment: res.environment,
      modules: res.modules,
      counts: res.counts,
    }),
  );
  return 0;
}

const isDirectEntry =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1]!)).href;

if (isDirectEntry) {
  runStoreImportCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'store_import.fatal',
          message:
            err instanceof Error && err.message.startsWith('CLI_USAGE_ERROR:')
              ? err.message
              : 'Store import job failed.',
        }),
      );
      process.exitCode = 1;
    });
}
