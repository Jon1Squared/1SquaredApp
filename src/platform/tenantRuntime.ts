/**
 * Platform Runtime Bridge connecting the Next.js host (`onesquared`) to:
 * - Layer 1: `@platform/core` (Tenancy, Config Engine, Extension Host, PostgreSQL Database-per-Tenant)
 * - Layer 2: Tenant configuration package (`PLATFORM_TENANT_PACKAGE_DIR/config/base.json`)
 * - Layer 3: Registered tenant extensions on `@platform/core-api`
 */

import {
  CORE_API_VERSION,
  CORE_VERSION,
  ExtensionHost,
  loadAndValidateTenantConfig,
  PostgresTenantCluster,
  resolveTenantFromVerifiedToken,
  resolveTenantPostgresConfig,
  type TenantConfiguration,
  type TenantContext,
} from '@platform/core';

let testBaseConfigOverride: Record<string, unknown> | null = null;
let testDevOverlayOverride: Record<string, unknown> | null | undefined = undefined;
const fileJsonCache = new Map<string, Record<string, unknown>>();

export function setActiveTenantConfigForTesting(
  baseConfig: Record<string, unknown> | null,
  devOverlay?: Record<string, unknown> | null,
): void {
  testBaseConfigOverride = baseConfig;
  testDevOverlayOverride = devOverlay;
}

function resolveTenantPackageDir(): string {
  const configured = process.env.PLATFORM_TENANT_PACKAGE_DIR?.trim();
  if (configured) {
    return configured;
  }
  if (
    process.env.NODE_ENV !== 'test' ||
    typeof window !== 'undefined' ||
    typeof process.getBuiltinModule !== 'function'
  ) {
    throw new Error(
      'TENANT_CONFIG_ERROR: PLATFORM_TENANT_PACKAGE_DIR must be configured to resolve tenant configuration.',
    );
  }
  const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const path = process.getBuiltinModule('node:path') as typeof import('node:path');
  const entries = fs.readdirSync(process.cwd(), { withFileTypes: true });
  const candidate = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('client-'))
    .map((entry) => entry.name)
    .sort()
    .find((dirName) =>
      fs.existsSync(path.join(process.cwd(), dirName, 'config', 'base.json')),
    );
  if (!candidate) {
    throw new Error(
      'TENANT_CONFIG_ERROR: PLATFORM_TENANT_PACKAGE_DIR is not set and no client-* tenant package directory was found.',
    );
  }
  return candidate;
}

export function getActiveTenantBaseConfigPath(): string {
  const folder = resolveTenantPackageDir();
  if (typeof window !== 'undefined' || typeof process.getBuiltinModule !== 'function') {
    return `${folder}/config/base.json`;
  }
  const path = process.getBuiltinModule('node:path') as typeof import('node:path');
  return path.join(process.cwd(), folder, 'config', 'base.json');
}

export function getActiveTenantEnvironmentOverlayPath(
  env: 'dev' | 'test' | 'training' | 'live' = 'dev',
): string {
  const folder = resolveTenantPackageDir();
  if (typeof window !== 'undefined' || typeof process.getBuiltinModule !== 'function') {
    return `${folder}/config/environments/${env}.json`;
  }
  const path = process.getBuiltinModule('node:path') as typeof import('node:path');
  return path.join(process.cwd(), folder, 'config', 'environments', `${env}.json`);
}

function readJsonConfigFile(
  filePath: string,
  optional = false,
): Record<string, unknown> {
  if (typeof window !== 'undefined' || typeof process.getBuiltinModule !== 'function') {
    throw new Error(
      `TENANT_CONFIG_ERROR: Cannot read tenant configuration file "${filePath}" outside Node.js runtime.`,
    );
  }
  const cached = fileJsonCache.get(filePath);
  if (cached) {
    return cached;
  }
  const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  if (!fs.existsSync(filePath)) {
    if (optional) {
      return {};
    }
    throw new Error(
      `TENANT_CONFIG_ERROR: Tenant configuration file not found at "${filePath}".`,
    );
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    fileJsonCache.set(filePath, parsed);
    return parsed;
  } catch (err) {
    throw new Error(
      `TENANT_CONFIG_ERROR: Invalid JSON in tenant configuration file "${filePath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function getActiveTenantRawBaseConfig(): Record<string, unknown> {
  if (testBaseConfigOverride) {
    return testBaseConfigOverride;
  }
  return readJsonConfigFile(getActiveTenantBaseConfigPath(), false);
}

export interface PlatformArchitectureSnapshot {
  coreVersion: string;
  coreApiVersion: string;
  tenantId: string;
  hostingMode: 'single_tenant' | 'multi_tenant';
  environment: 'dev' | 'test' | 'training' | 'live';
  postgresDatabaseName: string;
  postgresHost: string;
  blobContainerName: string;
  keyVaultSecretPrefix: string;
  tenantConfig: TenantConfiguration;
  activeExtensions: {
    id: string;
    name: string;
    version: string;
    description: string;
    supportedCoreApiRange: string;
    permissions: string[];
    hooks: string[];
    uiSlots: string[];
  }[];
}

export declare const VERIFIED_SESSION_BRAND: unique symbol;

export interface UnbrandedSessionActorInput {
  id?: string;
  sub?: string;
  name: string;
  email?: string;
  upn?: string;
  roles?: readonly string[];
  groups?: readonly string[];
  entraObjectId?: string;
  entraTenantId?: string;
  mfaVerified?: boolean;
  tenantId?: string;
  untrustedRequestTenantOverride?: string;
  correlationId?: string;
}

export type VerifiedSessionActorInput = UnbrandedSessionActorInput & {
  readonly [VERIFIED_SESSION_BRAND]: true;
};

let cachedHost: ExtensionHost | null = null;
let cachedHostPackageDir: string | null = null;
let cachedCluster: PostgresTenantCluster | null = null;

function isPlatformExtensionCandidate(
  value: unknown,
): value is import('@platform/core-api').PlatformExtension {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.manifest === 'object' &&
    candidate.manifest !== null &&
    typeof (candidate.manifest as Record<string, unknown>).id === 'string' &&
    typeof candidate.hooks === 'object' &&
    candidate.hooks !== null
  );
}

function loadTenantPackageExtensions(host: ExtensionHost, packageDir: string): void {
  if (typeof window !== 'undefined' || typeof process.getBuiltinModule !== 'function') {
    return;
  }
  const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const path = process.getBuiltinModule('node:path') as typeof import('node:path');
  const nodeModule = process.getBuiltinModule('node:module') as typeof import('node:module');
  const extensionsRoot = path.join(process.cwd(), packageDir, 'extensions');
  if (!fs.existsSync(extensionsRoot)) {
    return;
  }
  const req = nodeModule.createRequire(path.join(process.cwd(), 'package.json'));
  const entries = fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const extDirName of entries) {
    const extDir = path.join(extensionsRoot, extDirName);
    const manifestPath = path.join(extDir, 'manifest.json');
    const entryCandidates = [
      path.join(extDir, 'src', 'index.ts'),
      path.join(extDir, 'src', 'index.js'),
      path.join(extDir, 'index.ts'),
      path.join(extDir, 'index.js'),
    ];
    const entryPath = entryCandidates.find((candidate) => fs.existsSync(candidate));
    if (!fs.existsSync(manifestPath) || !entryPath) {
      continue;
    }
    const loadedModule = req(entryPath) as Record<string, unknown>;
    for (const exportedValue of Object.values(loadedModule)) {
      if (isPlatformExtensionCandidate(exportedValue)) {
        host.registerExtension(exportedValue);
      }
    }
  }
}

export function getPlatformExtensionHost(): ExtensionHost {
  const packageDir = resolveTenantPackageDir();
  if (!cachedHost || cachedHostPackageDir !== packageDir) {
    const host = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
    loadTenantPackageExtensions(host, packageDir);
    cachedHost = host;
    cachedHostPackageDir = packageDir;
  }
  return cachedHost;
}

export function getPlatformPostgresCluster(): PostgresTenantCluster {
  if (!cachedCluster) {
    cachedCluster = new PostgresTenantCluster();
  }
  return cachedCluster;
}

export function getActiveTenantConfiguration(): TenantConfiguration {
  const env =
    (process.env.PLATFORM_ENVIRONMENT as 'dev' | 'test' | 'training' | 'live' | undefined) ??
    'dev';
  const hostingMode =
    (process.env.PLATFORM_HOSTING_MODE as 'single_tenant' | 'multi_tenant' | undefined) ??
    'multi_tenant';
  const baseCfg = getActiveTenantRawBaseConfig();
  const overlayCfg =
    testDevOverlayOverride !== undefined
      ? (testDevOverlayOverride ?? {})
      : testBaseConfigOverride
        ? {}
        : readJsonConfigFile(
            getActiveTenantEnvironmentOverlayPath(env),
            true,
          );
  return loadAndValidateTenantConfig(
    baseCfg,
    overlayCfg,
    env,
    hostingMode,
  );
}

export function resolveCurrentTenantContext(
  actor?: VerifiedSessionActorInput | null,
  configOverride?: Pick<
    TenantConfiguration,
    'tenantId' | 'hostingMode' | 'environment' | 'branding'
  >,
): TenantContext {
  const actorId = (actor?.id ?? actor?.sub ?? '').trim();
  if (!actor || !actorId) {
    throw new Error(
      'TENANCY_AUTH_ERROR: Missing or unverified OIDC session claims. TenantContext requires an authenticated actor.',
    );
  }
  const actorEmail = (actor.email ?? actor.upn ?? '').trim();
  if (!actorEmail) {
    throw new Error(
      'TENANCY_AUTH_ERROR: Verified OIDC session actor is missing required email/UPN claim.',
    );
  }
  const actorOid = (actor.entraObjectId ?? '').trim();
  if (!actorOid) {
    throw new Error(
      'TENANCY_AUTH_ERROR: Verified OIDC session actor is missing required entraObjectId (oid) claim.',
    );
  }
  const cfg = configOverride ?? getActiveTenantConfiguration();
  const sessionTenantId = cfg.tenantId;
  if (actor.tenantId && actor.tenantId !== sessionTenantId) {
    throw new Error(
      'TENANCY_FORGERY_DETECTED: Request attempted to override authenticated session tenantId.',
    );
  }
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      tenantId: sessionTenantId,
      email: actorEmail,
      ...(actor.upn ? { upn: actor.upn } : {}),
      name: actor.name,
      roles: actor.roles ? [...actor.roles] : [],
      ...(actor.groups ? { groups: [...actor.groups] } : {}),
      ...(actor.entraObjectId ? { entraObjectId: actor.entraObjectId } : {}),
      ...(actor.entraTenantId ? { entraTenantId: actor.entraTenantId } : {}),
      mfaVerified: actor.mfaVerified ?? false,
    },
    hostingMode: cfg.hostingMode,
    environment: cfg.environment,
    correlationId: actor.correlationId ?? `req-${Date.now()}`,
    untrustedRequestTenantOverride: actor.untrustedRequestTenantOverride,
  });
}

export function getPlatformArchitectureSnapshot(
  actor: VerifiedSessionActorInput,
): PlatformArchitectureSnapshot {
  const tenantConfig = getActiveTenantConfiguration();
  const tenantCtx = resolveCurrentTenantContext(actor);
  const pgConfig = resolveTenantPostgresConfig(tenantCtx);
  const host = getPlatformExtensionHost();
  const activeExts = host.getActiveExtensionsForTenant(tenantConfig);

  return {
    coreVersion: CORE_VERSION,
    coreApiVersion: CORE_API_VERSION,
    tenantId: tenantCtx.tenantId,
    hostingMode: tenantCtx.hostingMode,
    environment: tenantCtx.environment,
    postgresDatabaseName: pgConfig.databaseName,
    postgresHost: pgConfig.host,
    blobContainerName: tenantCtx.blobContainerName,
    keyVaultSecretPrefix: tenantCtx.keyVaultSecretPrefix,
    tenantConfig,
    activeExtensions: activeExts.map((ext) => ({
      id: ext.manifest.id,
      name: ext.manifest.name,
      version: ext.manifest.version,
      description: ext.manifest.description,
      supportedCoreApiRange: ext.manifest.supportedCoreApiRange,
      permissions: [...ext.manifest.permissions],
      hooks: [...ext.manifest.hooks],
      uiSlots: [...(ext.manifest.uiSlots ?? [])],
    })),
  };
}
