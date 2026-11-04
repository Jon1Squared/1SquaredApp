import 'server-only';

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
  validateExtensionManifest,
  type ExtensionManifest,
  type TenantConfiguration,
  type TenantContext,
} from '@platform/core';
import type { PlatformExtension } from '@platform/core-api';
import { registerServerTenantConfigReader } from '@/domain/rbac';
import { BUNDLED_TENANT_EXTENSIONS } from './generated/extensionRegistry';

let testBaseConfigOverride: Record<string, unknown> | null = null;
let testDevOverlayOverride: Record<string, unknown> | null | undefined = undefined;
const fileJsonCache = new Map<string, Record<string, unknown>>();

registerServerTenantConfigReader(() => getActiveTenantConfiguration());

export function setActiveTenantConfigForTesting(
  baseConfig: Record<string, unknown> | null,
  devOverlay?: Record<string, unknown> | null,
): void {
  testBaseConfigOverride = baseConfig;
  testDevOverlayOverride = devOverlay;
  cachedHost = null;
  cachedHostKey = null;
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
  const packageRoot = path.resolve(process.cwd(), folder);
  return path.join(packageRoot, 'config', 'base.json');
}

export function getActiveTenantEnvironmentOverlayPath(
  env: 'dev' | 'test' | 'training' | 'live' = 'dev',
): string {
  const folder = resolveTenantPackageDir();
  if (typeof window !== 'undefined' || typeof process.getBuiltinModule !== 'function') {
    return `${folder}/config/environments/${env}.json`;
  }
  const path = process.getBuiltinModule('node:path') as typeof import('node:path');
  const packageRoot = path.resolve(process.cwd(), folder);
  return path.join(packageRoot, 'config', 'environments', `${env}.json`);
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
let cachedHostKey: string | null = null;
let cachedHostLoadErrors: {
  tenantId: string;
  extensionDir: string;
  error: string;
}[] = [];
let cachedCluster: PostgresTenantCluster | null = null;

export function getExtensionHostLoadErrors(): readonly {
  tenantId: string;
  extensionDir: string;
  error: string;
}[] {
  return cachedHostLoadErrors;
}

function isPlatformExtensionCandidate(
  value: unknown,
): value is PlatformExtension {
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

function assertManifestMatchesFile(
  fileManifest: ExtensionManifest,
  exportedManifest: ExtensionManifest,
): void {
  const validatedExported = validateExtensionManifest(exportedManifest);
  const normalise = (m: ExtensionManifest) => ({
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    supportedCoreApiRange: m.supportedCoreApiRange,
    permissions: [...m.permissions],
    hooks: [...m.hooks],
    uiSlots: [...(m.uiSlots ?? [])],
    hookTimeoutMs: m.hookTimeoutMs ?? 2000,
  });
  if (
    JSON.stringify(normalise(fileManifest)) !==
    JSON.stringify(normalise(validatedExported))
  ) {
    throw new Error(
      `EXTENSION_MANIFEST_MISMATCH: Exported manifest for "${exportedManifest.id}" does not match manifest.json for "${fileManifest.id}".`,
    );
  }
}

function loadTenantPackageExtensions(
  host: ExtensionHost,
  packageDir: string,
  tenantConfig: Pick<TenantConfiguration, 'tenantId' | 'enabledExtensions'>,
): { tenantId: string; extensionDir: string; error: string }[] {
  const loadErrors: { tenantId: string; extensionDir: string; error: string }[] = [];
  if (typeof window !== 'undefined' || typeof process.getBuiltinModule !== 'function') {
    return loadErrors;
  }
  const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const path = process.getBuiltinModule('node:path') as typeof import('node:path');
  const nodeModule = process.getBuiltinModule('node:module') as typeof import('node:module');
  const packageRoot = path.resolve(process.cwd(), packageDir);
  const extensionsRoot = path.join(packageRoot, 'extensions');
  if (!fs.existsSync(extensionsRoot)) {
    return loadErrors;
  }
  const enabledSet = new Set(tenantConfig.enabledExtensions ?? []);
  const req = nodeModule.createRequire(path.join(process.cwd(), 'package.json'));
  const entries = fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const extDirName of entries) {
    const extDir = path.join(extensionsRoot, extDirName);
    const manifestPath = path.join(extDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    try {
      const rawManifestJson = JSON.parse(
        fs.readFileSync(manifestPath, 'utf8'),
      ) as Record<string, unknown>;
      const candidateId =
        typeof rawManifestJson?.id === 'string' && rawManifestJson.id.trim()
          ? rawManifestJson.id.trim()
          : extDirName;
      if (!enabledSet.has(candidateId) && !enabledSet.has(extDirName)) {
        continue;
      }
      const validatedManifest = validateExtensionManifest(rawManifestJson);
      if (!enabledSet.has(validatedManifest.id)) {
        continue;
      }

      const entryCandidates = [
        path.join(extDir, 'src', 'index.js'),
        path.join(extDir, 'index.js'),
        path.join(extDir, 'src', 'index.ts'),
        path.join(extDir, 'index.ts'),
      ];
      const entryPath = entryCandidates.find((candidate) =>
        fs.existsSync(candidate),
      );

      let candidates: PlatformExtension[] = [];
      if (entryPath) {
        try {
          const loadedModule = req(entryPath) as Record<string, unknown>;
          candidates = Object.values(loadedModule).filter(
            isPlatformExtensionCandidate,
          );
        } catch (requireErr) {
          const bundled = BUNDLED_TENANT_EXTENSIONS[validatedManifest.id];
          if (bundled) {
            console.warn(
              JSON.stringify({
                level: 'warn',
                event: 'extension_require_fallback_to_bundled_registry',
                tenantId: tenantConfig.tenantId,
                correlationId: `ext-load-${tenantConfig.tenantId}`,
                extensionDir: extDirName,
                extensionId: validatedManifest.id,
                reason:
                  requireErr instanceof Error
                    ? requireErr.message
                    : String(requireErr),
              }),
            );
            candidates = [bundled];
          } else {
            throw requireErr;
          }
        }
      } else if (BUNDLED_TENANT_EXTENSIONS[validatedManifest.id]) {
        candidates = [BUNDLED_TENANT_EXTENSIONS[validatedManifest.id]];
      } else {
        throw new Error(
          `EXTENSION_ENTRY_NOT_FOUND: No entry module found in "${extDir}".`,
        );
      }

      if (candidates.length === 0) {
        throw new Error(
          `EXTENSION_EXPORT_MISSING: Module in "${extDir}" did not export a valid PlatformExtension.`,
        );
      }

      for (const exportedValue of candidates) {
        assertManifestMatchesFile(validatedManifest, exportedValue.manifest);
        host.registerExtension(exportedValue);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      loadErrors.push({
        tenantId: tenantConfig.tenantId,
        extensionDir: extDirName,
        error: message,
      });
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'extension_load_failed',
          tenantId: tenantConfig.tenantId,
          correlationId: `ext-load-${tenantConfig.tenantId}`,
          extensionDir: extDirName,
          error: message,
        }),
      );
    }
  }
  return loadErrors;
}

export function getPlatformExtensionHost(): ExtensionHost {
  const packageDir = resolveTenantPackageDir();
  const tenantConfig = getActiveTenantConfiguration();
  const hostKey = `${packageDir}::${tenantConfig.tenantId}::${(tenantConfig.enabledExtensions ?? []).join(',')}`;
  if (!cachedHost || cachedHostKey !== hostKey) {
    const host = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
    cachedHostLoadErrors = loadTenantPackageExtensions(
      host,
      packageDir,
      tenantConfig,
    );
    cachedHost = host;
    cachedHostKey = hostKey;
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
  const sessionTenantId = (actor.tenantId ?? '').trim();
  if (!sessionTenantId) {
    throw new Error(
      'TENANCY_AUTH_ERROR: Verified OIDC session actor is missing required tenantId claim.',
    );
  }
  if (sessionTenantId !== cfg.tenantId) {
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
