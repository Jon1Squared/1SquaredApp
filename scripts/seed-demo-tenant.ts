import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAndValidateTenantConfig } from '@platform/core';
import type { PlatformEnvironment } from '@platform/core-api';
import {
  applyEntraObjectIdMapToStore,
  loadCommittedSeedStore,
  resolveRuntimeStorePath,
  writeCommittedSeedStoreSnapshot,
} from '../src/seed/seedSnapshot';
import { createSeedStore, type FirmStore } from '../src/server/store';

export interface SeedDemoTenantOptions {
  args?: string[];
  env?: Record<string, string | undefined>;
  rootDir?: string;
  runtimeStorePath?: string;
  logger?: (jsonLine: string) => void;
}

export interface SeedDemoTenantResult {
  event: 'seed.demo_tenant_completed' | 'seed.snapshot_written';
  tenantId: string;
  environment: string;
  mappedEntraPersonas: number;
  counts: {
    people: number;
    organisations: number;
    matters: number;
    enquiries: number;
    quotes: number;
    tasks: number;
    teams: number;
    keyDates: number;
    signOffs: number;
  };
}

function isStoreNonEmpty(store: Partial<FirmStore> | null | undefined): boolean {
  if (!store || typeof store !== 'object') return false;
  if (store.isCleanDeployment === false) return true;
  return (
    (Array.isArray(store.people) && store.people.length > 0) ||
    (Array.isArray(store.organisations) && store.organisations.length > 0) ||
    (Array.isArray(store.matters) && store.matters.length > 0) ||
    (Array.isArray(store.enquiries) && store.enquiries.length > 0) ||
    (Array.isArray(store.quotes) && store.quotes.length > 0) ||
    (Array.isArray(store.tasks) && store.tasks.length > 0)
  );
}

function summarizeCounts(store: FirmStore): SeedDemoTenantResult['counts'] {
  return {
    people: store.people?.length ?? 0,
    organisations: store.organisations?.length ?? 0,
    matters: store.matters?.length ?? 0,
    enquiries: store.enquiries?.length ?? 0,
    quotes: store.quotes?.length ?? 0,
    tasks: store.tasks?.length ?? 0,
    teams: store.teams?.length ?? 0,
    keyDates: store.keyDates?.length ?? 0,
    signOffs: store.signOffs?.length ?? 0,
  };
}

export function runSeedDemoTenant(
  options: SeedDemoTenantOptions = {},
): SeedDemoTenantResult {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? process.cwd();
  const log = options.logger ?? ((line: string) => console.info(line));

  const writeSnapshot = args.includes('--write-snapshot');
  const force = args.includes('--force');

  let entraMapPath: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--entra-map') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Option --entra-map requires a file path argument.');
      }
      entraMapPath = next;
      i += 1;
    } else if (arg?.startsWith('--entra-map=')) {
      entraMapPath = arg.slice('--entra-map='.length).trim();
      if (!entraMapPath) {
        throw new Error('Option --entra-map requires a file path argument.');
      }
    }
  }

  const packageDirRaw = env.PLATFORM_TENANT_PACKAGE_DIR?.trim();
  const environmentRaw = env.PLATFORM_ENVIRONMENT?.trim();
  if (!packageDirRaw || !environmentRaw) {
    throw new Error(
      'PLATFORM_TENANT_PACKAGE_DIR and PLATFORM_ENVIRONMENT are required to run seed:demo.',
    );
  }

  if (environmentRaw.toLowerCase() === 'live') {
    throw new Error('Refusing to seed demo data in the live environment.');
  }

  const resolvedPackageDir = path.resolve(rootDir, packageDirRaw);
  const baseConfigPath = path.join(resolvedPackageDir, 'config', 'base.json');
  if (!fs.existsSync(baseConfigPath)) {
    throw new Error(`Tenant base configuration not found at ${baseConfigPath}`);
  }
  const baseConfig = JSON.parse(
    fs.readFileSync(baseConfigPath, 'utf8'),
  ) as Record<string, unknown>;
  const overlayPath = path.join(
    resolvedPackageDir,
    'config',
    'environments',
    `${environmentRaw}.json`,
  );
  const overlayConfig = fs.existsSync(overlayPath)
    ? (JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as Record<
        string,
        unknown
      >)
    : {};

  const tenantConfig = loadAndValidateTenantConfig(
    baseConfig,
    overlayConfig,
    environmentRaw as PlatformEnvironment,
    (env.PLATFORM_HOSTING_MODE as 'single_tenant' | 'multi_tenant' | undefined) ??
      'multi_tenant',
  );
  if (tenantConfig.environment === 'live') {
    throw new Error('Refusing to seed demo data in the live environment.');
  }

  const committedSnapshot = loadCommittedSeedStore(rootDir);
  if (tenantConfig.tenantId !== committedSnapshot.firmId) {
    throw new Error(
      `Refusing to seed demo data: tenantId (${tenantConfig.tenantId}) does not match seed snapshot firmId (${committedSnapshot.firmId}).`,
    );
  }

  if (writeSnapshot) {
    const { store } = writeCommittedSeedStoreSnapshot(rootDir);
    const result: SeedDemoTenantResult = {
      event: 'seed.snapshot_written',
      tenantId: tenantConfig.tenantId,
      environment: tenantConfig.environment,
      mappedEntraPersonas: 0,
      counts: summarizeCounts(store),
    };
    log(JSON.stringify(result));
    return result;
  }

  const targetStorePath =
    options.runtimeStorePath ?? resolveRuntimeStorePath(rootDir, env);

  if (fs.existsSync(targetStorePath)) {
    let existingStore: Partial<FirmStore> | null = null;
    let parseFailed = false;
    try {
      existingStore = JSON.parse(
        fs.readFileSync(targetStorePath, 'utf8'),
      ) as Partial<FirmStore>;
    } catch {
      parseFailed = true;
    }
    if ((parseFailed || isStoreNonEmpty(existingStore)) && !force) {
      throw new Error(
        parseFailed
          ? 'Refusing to overwrite an unparseable store file without --force.'
          : 'Refusing to overwrite a non-empty store without --force.',
      );
    }
  }

  const seedStore = createSeedStore(new Date(), {
    includeSyntheticEntraOids: false,
  });
  seedStore.firmId = tenantConfig.tenantId;
  seedStore.isCleanDeployment = false;

  let mappedEntraPersonas = 0;
  if (entraMapPath) {
    const resolvedMapPath = path.resolve(rootDir, entraMapPath);
    if (!fs.existsSync(resolvedMapPath)) {
      throw new Error(`Entra map file not found: ${entraMapPath}`);
    }
    const rawMap = JSON.parse(
      fs.readFileSync(resolvedMapPath, 'utf8'),
    ) as Record<string, string>;
    const applied = applyEntraObjectIdMapToStore(seedStore, rawMap);
    mappedEntraPersonas = applied.mappedCount;
  }

  const targetDir = path.dirname(targetStorePath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  fs.writeFileSync(targetStorePath, JSON.stringify(seedStore, null, 2), 'utf8');

  const result: SeedDemoTenantResult = {
    event: 'seed.demo_tenant_completed',
    tenantId: tenantConfig.tenantId,
    environment: tenantConfig.environment,
    mappedEntraPersonas,
    counts: summarizeCounts(seedStore),
  };
  log(JSON.stringify(result));
  return result;
}

const isMainModule =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1]!)).href;

if (isMainModule) {
  try {
    runSeedDemoTenant();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'seed.demo_tenant_failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  }
}
