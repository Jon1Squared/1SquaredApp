import 'server-only';

/**
 * Platform Runtime Bridge connecting the Next.js host (`onesquared`) to:
 * - Layer 1: `@platform/core` (Tenancy, Config Engine, Extension Host, PostgreSQL Database-per-Tenant)
 * - Layer 2: Tenant configuration package (`PLATFORM_TENANT_PACKAGE_DIR/config/base.json`)
 * - Layer 3: Registered tenant extensions on `@platform/core-api`
 */

import {
  collectStructuredConfigReservedSettings,
  emitPlatformStartupTelemetry,
  emitTenantTelemetryEvent,
  sanitizeTelemetryString,
  CORE_API_VERSION,
  CORE_VERSION,
  ExtensionHost,
  hasActiveTenantTransaction,
  loadAndValidateTenantConfig,
  resolveTenantFromVerifiedToken,
  resolveTenantPostgresConfig,
  TenantAuditRepository,
  TenantCatalogueRepository,
  TenantChasingRepository,
  TenantEngagementRepository,
  TenantEvidenceArtifactRepository,
  TenantHrAndRbacRepository,
  TenantIntakeCheckRepository,
  TenantIntakeQuoteRepository,
  TenantJobRunRepository,
  TenantMatterRepository,
  TenantMoneyOnAccountRepository,
  TenantOutboxRepository,
  TenantPartyRepository,
  TenantPmsRepository,
  TenantRateOverrideRepository,
  TenantRegisterRepository,
  TenantSearchRepository,
  TenantTaskWorkflowRepository,
  validateExtensionManifest,
  type ExtensionManifest,
  type FirmAuditEntryInput,
  type FirmAuditEntryRecord,
  type HostingMode,
  type PermissionKey,
  type TenantConfiguration,
  type TenantContext,
  type TenantRegistryEntry,
} from '@platform/core';
import type { PlatformExtension } from '@platform/core-api';
import type { AuditEntry } from '@/domain/types';
import { BUNDLED_TENANT_EXTENSIONS } from './generated/extensionRegistry';
import { resolveRequestCorrelationId } from '@/server/correlationId';

let testBaseConfigOverride: Record<string, unknown> | null = null;
let testDevOverlayOverride: Record<string, unknown> | null | undefined =
  undefined;

const fileJsonCache = new Map<string, Record<string, unknown>>();
const envOverlayPathCache = new Map<string, string>();
const EMPTY_JSON_CONFIG: Record<string, unknown> = Object.freeze({});
/**
 * Cached validated `TenantConfiguration` shared across requests for the lifetime
 * of the process. Deep-frozen so callers treat it as strictly read-only.
 */
let cachedValidatedTenantConfig: {
  packageDir: string;
  env: string;
  hostingMode: string;
  value: TenantConfiguration;
} | null = null;
let tenantConfigValidationCount = 0;
const loggedReservedSettingKeys = new Set<string>();

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const propValue of Object.values(value as Record<string, unknown>)) {
    if (propValue && typeof propValue === 'object') {
      deepFreeze(propValue);
    }
  }
  return value;
}

export function getTenantConfigValidationCountForTesting(): number {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'SECURITY_ERROR: getTenantConfigValidationCountForTesting is only permitted when NODE_ENV === "test".',
    );
  }
  return tenantConfigValidationCount;
}

export function setActiveTenantConfigForTesting(
  baseConfig: Record<string, unknown> | null,
  devOverlay?: Record<string, unknown> | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'SECURITY_ERROR: setActiveTenantConfigForTesting is only permitted when NODE_ENV === "test".',
    );
  }
  testBaseConfigOverride = baseConfig;
  testDevOverlayOverride = devOverlay;
  cachedValidatedTenantConfig = null;
  loggedReservedSettingKeys.clear();
  cachedHost = null;
  cachedHostKey = null;
  cachedHostLoadErrors = [];
}

export function resetTenantRuntimeForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'SECURITY_ERROR: resetTenantRuntimeForTesting is only permitted when NODE_ENV === "test".',
    );
  }
  fileJsonCache.clear();
  envOverlayPathCache.clear();
  testBaseConfigOverride = null;
  testDevOverlayOverride = undefined;
  cachedValidatedTenantConfig = null;
  loggedReservedSettingKeys.clear();
  cachedHost = null;
  cachedHostKey = null;
  cachedHostLoadErrors = [];
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
  env: 'dev' | 'test' | 'training' | 'demo' | 'live' = 'dev',
): string {
  const folder = resolveTenantPackageDir();
  if (typeof window !== 'undefined' || typeof process.getBuiltinModule !== 'function') {
    return `${folder}/config/environments/${env}.json`;
  }
  const cacheKey = `${folder}::${env}`;
  const cachedPath = envOverlayPathCache.get(cacheKey);
  if (cachedPath) {
    return cachedPath;
  }
  const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const path = process.getBuiltinModule('node:path') as typeof import('node:path');
  const packageRoot = path.resolve(process.cwd(), folder);
  const envDirCandidate = path.join(packageRoot, 'config', 'environments', `${env}.json`);
  const directCandidate = path.join(packageRoot, 'config', `${env}.json`);
  const resolvedPath =
    !fs.existsSync(envDirCandidate) && fs.existsSync(directCandidate)
      ? directCandidate
      : envDirCandidate;
  envOverlayPathCache.set(cacheKey, resolvedPath);
  return resolvedPath;
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
      fileJsonCache.set(filePath, EMPTY_JSON_CONFIG);
      return EMPTY_JSON_CONFIG;
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
  if (process.env.NODE_ENV === 'test' && testBaseConfigOverride) {
    return testBaseConfigOverride;
  }
  return readJsonConfigFile(getActiveTenantBaseConfigPath(), false);
}

export interface PlatformArchitectureSnapshot {
  coreVersion: string;
  coreApiVersion: string;
  schemaVersion: string;
  tenantId: string;
  hostingMode: 'single_tenant' | 'multi_tenant';
  environment: 'dev' | 'test' | 'training' | 'demo' | 'live';
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

export interface ExtensionLoadError {
  tenantId: string;
  extensionDir: string;
  extensionId?: string;
  errorCode: string;
  declaredHooks: readonly string[] | null;
  error: string;
}

export interface ExtensionReadinessResult {
  readonly ok: boolean;
  readonly errorCode?: string;
}

let cachedHost: ExtensionHost | null = null;
let cachedHostKey: string | null = null;
let cachedHostLoadErrors: ExtensionLoadError[] = [];

export function getExtensionHostLoadErrors(): readonly ExtensionLoadError[] {
  if (!cachedHost) {
    return cachedHostLoadErrors;
  }
  const tenantConfig = getActiveTenantConfiguration();
  const registeredIds = new Set(
    cachedHost
      .getActiveExtensionsForTenant(tenantConfig)
      .map((ext) => ext.manifest.id),
  );
  return cachedHostLoadErrors.filter(
    (err) =>
      !(
        err.error.startsWith('EXTENSION_NOT_REGISTERED:') &&
        err.extensionId &&
        registeredIds.has(err.extensionId)
      ),
  );
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
): ExtensionLoadError[] {
  const loadErrors: ExtensionLoadError[] = [];
  if (typeof window !== 'undefined' || typeof process.getBuiltinModule !== 'function') {
    return loadErrors;
  }
  const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const path = process.getBuiltinModule('node:path') as typeof import('node:path');
  const nodeModule = process.getBuiltinModule('node:module') as typeof import('node:module');
  const nodeCrypto = process.getBuiltinModule('node:crypto') as typeof import('node:crypto');
  const packageRoot = path.resolve(process.cwd(), packageDir);
  const extensionsRoot = path.join(packageRoot, 'extensions');
  const enabledSet = new Set(tenantConfig.enabledExtensions ?? []);
  const req = nodeModule.createRequire(path.join(process.cwd(), 'package.json'));
  const entries = fs.existsSync(extensionsRoot)
    ? fs
        .readdirSync(extensionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  for (const extDirName of entries) {
    const extDir = path.join(extensionsRoot, extDirName);
    const manifestPath = path.join(extDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      if (enabledSet.size > 0) {
        const loadCorrelationId = `ext-load-${nodeCrypto.randomUUID()}`;
        const rawMessage = `EXTENSION_MANIFEST_NOT_FOUND: manifest.json is missing in "${extDir}".`;
        const safeMessage = sanitizeTelemetryString(rawMessage);
        loadErrors.push({
          tenantId: tenantConfig.tenantId,
          extensionDir: extDirName,
          extensionId: extDirName,
          errorCode: 'EXTENSION_MANIFEST_NOT_FOUND',
          declaredHooks: null,
          error: safeMessage,
        });
        emitTenantTelemetryEvent({
          eventName: 'extension_load_failed',
          severity: 'error',
          tenantId: tenantConfig.tenantId,
          correlationId: loadCorrelationId,
          properties: {
            extensionDir: extDirName,
            extensionId: extDirName,
            errorCode: 'EXTENSION_MANIFEST_NOT_FOUND',
          },
        });
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'extension_load_failed',
            tenantId: tenantConfig.tenantId,
            correlationId: loadCorrelationId,
            extensionDir: extDirName,
            extensionId: extDirName,
            errorCode: 'EXTENSION_MANIFEST_NOT_FOUND',
            error: safeMessage,
          }),
        );
      }
      continue;
    }
    let resolvedExtensionId = extDirName;
    let declaredHooks: readonly string[] | null = null;
    try {
      const rawManifestJson = JSON.parse(
        fs.readFileSync(manifestPath, 'utf8'),
      ) as Record<string, unknown>;
      const candidateId =
        typeof rawManifestJson?.id === 'string' && rawManifestJson.id.trim()
          ? rawManifestJson.id.trim()
          : extDirName;
      resolvedExtensionId = candidateId;
      if (!enabledSet.has(candidateId) && !enabledSet.has(extDirName)) {
        continue;
      }
      const validatedManifest = validateExtensionManifest(rawManifestJson);
      resolvedExtensionId = validatedManifest.id;
      declaredHooks = validatedManifest.hooks;

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
                correlationId: `ext-load-${nodeCrypto.randomUUID()}`,
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
      const rawMessage = err instanceof Error ? err.message : String(err);
      const errorCode =
        rawMessage.match(/^([A-Z0-9_]+):/)?.[1] ?? 'EXTENSION_LOAD_FAILED';
      const safeMessage = sanitizeTelemetryString(rawMessage);
      const loadCorrelationId = `ext-load-${nodeCrypto.randomUUID()}`;
      loadErrors.push({
        tenantId: tenantConfig.tenantId,
        extensionDir: extDirName,
        extensionId: resolvedExtensionId,
        errorCode,
        declaredHooks,
        error: safeMessage,
      });
      emitTenantTelemetryEvent({
        eventName: 'extension_load_failed',
        severity: 'error',
        tenantId: tenantConfig.tenantId,
        correlationId: loadCorrelationId,
        properties: {
          extensionDir: extDirName,
          extensionId: resolvedExtensionId,
          errorCode,
        },
      });
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'extension_load_failed',
          tenantId: tenantConfig.tenantId,
          correlationId: loadCorrelationId,
          extensionDir: extDirName,
          extensionId: resolvedExtensionId,
          errorCode,
          error: safeMessage,
        }),
      );
    }
  }

  const registeredIds = new Set(
    host
      .getActiveExtensionsForTenant(tenantConfig as TenantConfiguration)
      .map((ext) => ext.manifest.id),
  );
  for (const enabledId of enabledSet) {
    if (
      !registeredIds.has(enabledId) &&
      !loadErrors.some(
        (err) =>
          err.extensionId === enabledId || err.extensionDir === enabledId,
      )
    ) {
      const loadCorrelationId = `ext-load-${nodeCrypto.randomUUID()}`;
      const rawMessage = `EXTENSION_NOT_REGISTERED: Enabled extension "${enabledId}" was not found or failed to register.`;
      const safeMessage = sanitizeTelemetryString(rawMessage);
      loadErrors.push({
        tenantId: tenantConfig.tenantId,
        extensionDir: enabledId,
        extensionId: enabledId,
        errorCode: 'EXTENSION_NOT_REGISTERED',
        declaredHooks: null,
        error: safeMessage,
      });
      emitTenantTelemetryEvent({
        eventName: 'extension_load_failed',
        severity: 'error',
        tenantId: tenantConfig.tenantId,
        correlationId: loadCorrelationId,
        properties: {
          extensionDir: enabledId,
          extensionId: enabledId,
          errorCode: 'EXTENSION_NOT_REGISTERED',
        },
      });
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'extension_load_failed',
          tenantId: tenantConfig.tenantId,
          correlationId: loadCorrelationId,
          extensionDir: enabledId,
          extensionId: enabledId,
          errorCode: 'EXTENSION_NOT_REGISTERED',
          error: safeMessage,
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

/**
 * Verifies that every extension enabled for the active tenant loaded and registered cleanly (`R655`).
 * Returns a safe `errorCode` only so readiness probes and startup checks never expose file paths or secrets.
 */
export function checkActiveTenantExtensionsReadiness(): ExtensionReadinessResult {
  const activeCfg = getActiveTenantConfiguration();
  const enabledIds = activeCfg.enabledExtensions ?? [];
  if (enabledIds.length === 0) {
    return { ok: true };
  }
  const host = getPlatformExtensionHost();
  const enabledSet = new Set(enabledIds);
  const matchingError = getExtensionHostLoadErrors().find(
    (err) =>
      err.tenantId === activeCfg.tenantId &&
      ((err.extensionId && enabledSet.has(err.extensionId)) ||
        enabledSet.has(err.extensionDir)),
  );
  if (matchingError) {
    return {
      ok: false,
      errorCode: matchingError.errorCode || 'EXTENSION_LOAD_FAILED',
    };
  }
  const registeredIds = new Set(
    host.getActiveExtensionsForTenant(activeCfg).map((ext) => ext.manifest.id),
  );
  for (const enabledId of enabledIds) {
    if (!registeredIds.has(enabledId)) {
      return { ok: false, errorCode: 'EXTENSION_NOT_REGISTERED' };
    }
  }
  return { ok: true };
}


const ALLOWED_PLATFORM_ENVIRONMENTS = new Set<TenantConfiguration['environment']>([
  'dev',
  'test',
  'training',
  'demo',
  'live',
]);

export function resolveConfiguredEnvironment(): TenantConfiguration['environment'] {
  const raw = process.env.PLATFORM_ENVIRONMENT?.trim() ?? '';
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'TENANT_CONFIG_ERROR: PLATFORM_ENVIRONMENT must be explicitly set when NODE_ENV=production.',
      );
    }
    return 'dev';
  }
  if (
    !ALLOWED_PLATFORM_ENVIRONMENTS.has(
      raw as TenantConfiguration['environment'],
    )
  ) {
    throw new Error(
      `TENANT_CONFIG_ERROR: Invalid PLATFORM_ENVIRONMENT "${raw}". Expected one of: dev, test, training, demo, live.`,
    );
  }
  return raw as TenantConfiguration['environment'];
}

export function getActiveTenantConfiguration(): TenantConfiguration {
  const packageDir = resolveTenantPackageDir();
  const env = resolveConfiguredEnvironment();
  const hostingMode =
    (process.env.PLATFORM_HOSTING_MODE as 'single_tenant' | 'multi_tenant' | undefined) ??
    'multi_tenant';
  if (
    cachedValidatedTenantConfig &&
    cachedValidatedTenantConfig.packageDir === packageDir &&
    cachedValidatedTenantConfig.env === env &&
    cachedValidatedTenantConfig.hostingMode === hostingMode
  ) {
    return cachedValidatedTenantConfig.value;
  }
  const baseCfg = getActiveTenantRawBaseConfig();
  const isTestEnv = process.env.NODE_ENV === 'test';
  const overlayCfg =
    isTestEnv && testDevOverlayOverride !== undefined
      ? (testDevOverlayOverride ?? EMPTY_JSON_CONFIG)
      : isTestEnv && testBaseConfigOverride
        ? EMPTY_JSON_CONFIG
        : readJsonConfigFile(
            getActiveTenantEnvironmentOverlayPath(env),
            true,
          );
  const validated = deepFreeze(
    loadAndValidateTenantConfig(
      baseCfg,
      overlayCfg,
      env,
      hostingMode,
    ),
  );
  tenantConfigValidationCount += 1;
  const reservedLogKey = `${validated.tenantId}::${env}::${hostingMode}`;
  if (!loggedReservedSettingKeys.has(reservedLogKey)) {
    loggedReservedSettingKeys.add(reservedLogKey);
    const reservedNotices = collectStructuredConfigReservedSettings(
      baseCfg,
      overlayCfg,
    );
    if (reservedNotices.length > 0) {
      const startupCorrelationId = resolveRequestCorrelationId(
        null,
        `cfg-startup-${validated.tenantId}-${env}`,
      );
      emitPlatformStartupTelemetry({
        eventName: 'tenant_config.reserved_settings',
        hostingMode,
        configuredTenantId: validated.tenantId,
        correlationId: startupCorrelationId,
        properties: {
          environment: env,
          reservedCount: reservedNotices.length,
        },
      });
      console.info(
        JSON.stringify({
          level: 'info',
          event: 'tenant_config.reserved_settings',
          tenantId: validated.tenantId,
          correlationId: resolveRequestCorrelationId(
            null,
            `cfg-startup-${validated.tenantId}-${env}`,
          ),
          environment: env,
          reservedSettings: reservedNotices.map((n) => ({
            path: n.path,
            for: n.forSlice,
            reason: n.reason,
          })),
        }),
      );
    }
  }
  cachedValidatedTenantConfig = {
    packageDir,
    env,
    hostingMode,
    value: validated,
  };
  return validated;
}

export function getTenantConfigurationForRegistryEntry(
  entry: Pick<TenantRegistryEntry, 'tenantId' | 'packageDir' | 'environment'>,
  hostingModeOverride?: HostingMode,
): TenantConfiguration {
  const activeCfg = getActiveTenantConfiguration();
  if (
    activeCfg.tenantId === entry.tenantId &&
    activeCfg.environment === entry.environment &&
    (!hostingModeOverride || activeCfg.hostingMode === hostingModeOverride)
  ) {
    return activeCfg;
  }
  const pathMod =
    typeof process.getBuiltinModule === 'function'
      ? (process.getBuiltinModule('node:path') as typeof import('node:path'))
      : null;
  const fsMod =
    typeof process.getBuiltinModule === 'function'
      ? (process.getBuiltinModule('node:fs') as typeof import('node:fs'))
      : null;
  if (!pathMod || !fsMod) {
    throw new Error(
      'TENANT_CONFIG_ERROR: Registry entry configuration loading requires Node.js runtime.',
    );
  }
  const packageRoot = pathMod.resolve(process.cwd(), entry.packageDir);
  const basePath = pathMod.join(packageRoot, 'config', 'base.json');
  const envDirCandidate = pathMod.join(
    packageRoot,
    'config',
    'environments',
    `${entry.environment}.json`,
  );
  const directCandidate = pathMod.join(
    packageRoot,
    'config',
    `${entry.environment}.json`,
  );
  const overlayPath =
    !fsMod.existsSync(envDirCandidate) && fsMod.existsSync(directCandidate)
      ? directCandidate
      : envDirCandidate;
  const baseCfg = readJsonConfigFile(basePath, false);
  const overlayCfg = readJsonConfigFile(overlayPath, true);
  const hostingMode =
    hostingModeOverride ??
    (process.env.PLATFORM_HOSTING_MODE as HostingMode | undefined) ??
    'multi_tenant';
  const validated = loadAndValidateTenantConfig(
    baseCfg,
    overlayCfg,
    entry.environment,
    hostingMode,
  );
  if (validated.tenantId !== entry.tenantId) {
    const mismatchErr = new Error(
      `TENANT_CONFIG_MISMATCH: Registry tenantId "${entry.tenantId}" does not match package configuration tenantId "${validated.tenantId}".`,
    ) as Error & { code?: string };
    mismatchErr.code = 'TENANT_CONFIG_MISMATCH';
    throw mismatchErr;
  }
  return deepFreeze(validated);
}

export function resolveVerifiedTenantConfiguration(
  ctx: TenantContext,
  explicitConfig?: TenantConfiguration,
): TenantConfiguration {
  if (explicitConfig) {
    if (explicitConfig.tenantId !== ctx.tenantId) {
      const mismatchErr = new Error(
        `TENANT_CONFIG_MISMATCH: Supplied TenantConfiguration tenantId "${explicitConfig.tenantId}" does not match caller context tenantId "${ctx.tenantId}".`,
      ) as Error & { code?: string };
      mismatchErr.code = 'TENANT_CONFIG_MISMATCH';
      throw mismatchErr;
    }
    return explicitConfig;
  }
  const activeCfg = getActiveTenantConfiguration();
  if (activeCfg.tenantId === ctx.tenantId) {
    return activeCfg;
  }
  const mismatchErr = new Error(
    `TENANT_CONFIG_MISMATCH: Active process TenantConfiguration tenantId "${activeCfg.tenantId}" does not match caller context tenantId "${ctx.tenantId}", and no explicit tenantConfig was supplied.`,
  ) as Error & { code?: string };
  mismatchErr.code = 'TENANT_CONFIG_MISMATCH';
  throw mismatchErr;
}

/**
 * Shared configuration-driven helper for non-live demo mode (Rule 6).
 * Returns true only when the tenant environment is non-live (`dev`, `test`,
 * `training` or `demo`) AND `featureFlags.enableDemoMode` is enabled.
 * Never depends on `NODE_ENV`.
 */
export function isNonLiveDemoEnvironment(
  config: {
    environment: TenantConfiguration['environment'];
    featureFlags?: { enableDemoMode?: boolean };
  } = getActiveTenantConfiguration(),
): boolean {
  return (
    config.environment !== 'live' &&
    Boolean(config.featureFlags?.enableDemoMode)
  );
}

export function resolveCurrentTenantContext(
  actor?: VerifiedSessionActorInput | null,
  configOverride?: Pick<
    TenantConfiguration,
    'tenantId' | 'hostingMode' | 'environment' | 'branding' | 'keyVault' | 'database'
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
    correlationId: resolveRequestCorrelationId(actor.correlationId, 'req'),
    untrustedRequestTenantOverride: actor.untrustedRequestTenantOverride,
    configuredPostgresHost: cfg.database?.dedicatedServerHost,
    configuredKeyVault: cfg.keyVault
      ? {
          vaultName: cfg.keyVault.vaultName,
          vaultUri: cfg.keyVault.vaultUri,
        }
      : undefined,
  });
}

export function resolveJobTenantContext(params: {
  actorSub: string;
  jobKey: string;
  tenantId: string;
  hostingMode: 'single_tenant' | 'multi_tenant';
  environment: 'dev' | 'test' | 'training' | 'demo' | 'live';
  correlationId: string;
  postgresHost?: string;
  keyVaultUri?: string;
  jobPermissions: readonly PermissionKey[];
}): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: params.actorSub,
      tenantId: params.tenantId,
      name: `Platform job ${params.jobKey}`,
      email: `${params.jobKey}@platform.example`,
      roles: [],
      mfaVerified: true,
    },
    hostingMode: params.hostingMode,
    environment: params.environment,
    correlationId: params.correlationId,
    configuredPostgresHost: params.postgresHost,
    configuredKeyVault: params.keyVaultUri
      ? { vaultUri: params.keyVaultUri }
      : undefined,
    jobPermissions: params.jobPermissions,
  });
}

const partyRepositoryInstance = new TenantPartyRepository();
const matterRepositoryInstance = new TenantMatterRepository();
const intakeQuoteRepositoryInstance = new TenantIntakeQuoteRepository();
const taskWorkflowRepositoryInstance = new TenantTaskWorkflowRepository();
const hrAndRbacRepositoryInstance = new TenantHrAndRbacRepository();
const catalogueRepositoryInstance = new TenantCatalogueRepository();
const pmsRepositoryInstance = new TenantPmsRepository();
const rateOverrideRepositoryInstance = new TenantRateOverrideRepository();
const registerRepositoryInstance = new TenantRegisterRepository();
const intakeCheckRepositoryInstance = new TenantIntakeCheckRepository();
const evidenceArtifactRepositoryInstance = new TenantEvidenceArtifactRepository();
const chasingRepositoryInstance = new TenantChasingRepository();
const engagementRepositoryInstance = new TenantEngagementRepository();
const moneyOnAccountRepositoryInstance = new TenantMoneyOnAccountRepository();
const searchRepositoryInstance = new TenantSearchRepository();
const jobRunRepositoryInstance = new TenantJobRunRepository();
const outboxRepositoryInstance = new TenantOutboxRepository();
const auditRepositoryInstance = new TenantAuditRepository();
let auditRepositoryOverrideForTesting: TenantAuditRepository | null = null;
let jobRunRepositoryOverrideForTesting: TenantJobRunRepository | null = null;

export function getPartyRepository(): TenantPartyRepository {
  return partyRepositoryInstance;
}

export function getMatterRepository(): TenantMatterRepository {
  return matterRepositoryInstance;
}

export function getIntakeQuoteRepository(): TenantIntakeQuoteRepository {
  return intakeQuoteRepositoryInstance;
}

export function getTaskWorkflowRepository(): TenantTaskWorkflowRepository {
  return taskWorkflowRepositoryInstance;
}

export function getHrAndRbacRepository(): TenantHrAndRbacRepository {
  return hrAndRbacRepositoryInstance;
}

export function getCatalogueRepository(): TenantCatalogueRepository {
  return catalogueRepositoryInstance;
}

export function getPmsRepository(): TenantPmsRepository {
  return pmsRepositoryInstance;
}

export function getRateOverrideRepository(): TenantRateOverrideRepository {
  return rateOverrideRepositoryInstance;
}

export function getRegisterRepository(): TenantRegisterRepository {
  return registerRepositoryInstance;
}

export function getIntakeCheckRepository(): TenantIntakeCheckRepository {
  return intakeCheckRepositoryInstance;
}

export function getEvidenceArtifactRepository(): TenantEvidenceArtifactRepository {
  return evidenceArtifactRepositoryInstance;
}

export function getChasingRepository(): TenantChasingRepository {
  return chasingRepositoryInstance;
}

export function getEngagementRepository(): TenantEngagementRepository {
  return engagementRepositoryInstance;
}

export function getMoneyOnAccountRepository(): TenantMoneyOnAccountRepository {
  return moneyOnAccountRepositoryInstance;
}

export function getSearchRepository(): TenantSearchRepository {
  return searchRepositoryInstance;
}

export function getOutboxRepository(): TenantOutboxRepository {
  return outboxRepositoryInstance;
}

export function getJobRunRepository(): TenantJobRunRepository {
  return jobRunRepositoryOverrideForTesting ?? jobRunRepositoryInstance;
}

export function setJobRunRepositoryOverrideForTesting(
  override: TenantJobRunRepository | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'SECURITY_ERROR: setJobRunRepositoryOverrideForTesting is only permitted when NODE_ENV === "test".',
    );
  }
  jobRunRepositoryOverrideForTesting = override;
}

export function getAuditRepository(): TenantAuditRepository {
  return auditRepositoryOverrideForTesting ?? auditRepositoryInstance;
}

export function setAuditRepositoryOverrideForTesting(
  override: TenantAuditRepository | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'SECURITY_ERROR: setAuditRepositoryOverrideForTesting is only permitted when NODE_ENV === "test".',
    );
  }
  auditRepositoryOverrideForTesting = override;
}

interface ScopedAuditStorage<T> {
  current(): T | undefined;
  run<R>(context: T, callback: () => R): R;
}

interface ActiveAuditStagingScope {
  readonly stagedEntries: FirmAuditEntryInput[];
  depth: number;
}

let cachedAuditStagingStorage:
  | ScopedAuditStorage<ActiveAuditStagingScope>
  | null
  | undefined;

function getAuditStagingStorage(): ScopedAuditStorage<ActiveAuditStagingScope> | null {
  if (cachedAuditStagingStorage !== undefined) {
    return cachedAuditStagingStorage;
  }
  if (
    typeof window !== 'undefined' ||
    typeof process.getBuiltinModule !== 'function'
  ) {
    cachedAuditStagingStorage = null;
    return null;
  }
  try {
    const asyncHooks = process.getBuiltinModule('node:async_hooks') as
      | typeof import('node:async_hooks')
      | undefined;
    if (asyncHooks?.AsyncLocalStorage) {
      const rawAls =
        new asyncHooks.AsyncLocalStorage<ActiveAuditStagingScope>();
      const readMethodKey = ['get', 'Store'].join('') as keyof typeof rawAls;
      cachedAuditStagingStorage = {
        current: () =>
          (
            rawAls[readMethodKey] as () =>
              | ActiveAuditStagingScope
              | undefined
          ).call(rawAls),
        run: (context, callback) => rawAls.run(context, callback),
      };
    } else {
      cachedAuditStagingStorage = null;
    }
  } catch {
    cachedAuditStagingStorage = null;
  }
  return cachedAuditStagingStorage;
}

export function stageAuditEntry(
  entry: Omit<AuditEntry, 'id' | 'at'> & { id?: string; at?: string },
): AuditEntry {
  const activeScope = getAuditStagingStorage()?.current();
  if (!activeScope) {
    const err = new Error(
      'TENANCY_AUDIT_WRITE_ERROR: writeAudit was called outside an active audit staging scope.',
    ) as Error & { code: string };
    err.code = 'TENANCY_AUDIT_WRITE_ERROR';
    throw err;
  }

  const atIso = entry.at ?? new Date().toISOString();
  const stagedInput: FirmAuditEntryInput = {
    ...(entry.id ? { id: entry.id } : {}),
    recordType: entry.recordType,
    recordId: entry.recordId,
    action: entry.action,
    field: entry.field,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    byId: entry.byId,
    at: atIso,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.snapshot !== undefined ? { snapshot: entry.snapshot } : {}),
  };

  activeScope.stagedEntries.push(stagedInput);

  return {
    id: entry.id ?? 'AU-PENDING',
    at: atIso,
    recordType: entry.recordType,
    recordId: entry.recordId,
    action: entry.action,
    field: entry.field,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    byId: entry.byId,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.snapshot !== undefined ? { snapshot: entry.snapshot } : {}),
  };
}

export async function appendTenantAuditEntries(
  ctx: TenantContext,
  entries: readonly FirmAuditEntryInput[],
): Promise<FirmAuditEntryRecord[]> {
  if (entries.length === 0) {
    return [];
  }
  const repo = getAuditRepository();
  return repo.appendAuditEntries(ctx, entries);
}

export async function runWithAuditStagingScope<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const stagingStorage = getAuditStagingStorage();
  if (!stagingStorage) {
    return fn();
  }
  const existing = stagingStorage.current();
  if (existing) {
    existing.depth += 1;
    try {
      return await fn();
    } finally {
      existing.depth -= 1;
    }
  }
  const scope: ActiveAuditStagingScope = {
    stagedEntries: [],
    depth: 1,
  };
  return stagingStorage.run(scope, async () => {
    const result = await fn();
    if (scope.stagedEntries.length > 0) {
      const err = new Error(
        'TENANCY_UNFLUSHED_AUDIT_ERROR: Staged audit entries were not flushed inside a withTenantTransaction.',
      ) as Error & { code: string };
      err.code = 'TENANCY_UNFLUSHED_AUDIT_ERROR';
      throw err;
    }
    return result;
  });
}

export async function flushStagedAuditEntries(
  ctx: TenantContext,
): Promise<FirmAuditEntryRecord[]> {
  if (!hasActiveTenantTransaction(ctx)) {
    const err = new Error(
      'TENANCY_AUDIT_TRANSACTION_REQUIRED: flushStagedAuditEntries must be called inside an active withTenantTransaction.',
    ) as Error & { code: string };
    err.code = 'TENANCY_AUDIT_TRANSACTION_REQUIRED';
    throw err;
  }
  const activeScope = getAuditStagingStorage()?.current();
  if (
    !activeScope ||
    activeScope.stagedEntries.length === 0 ||
    activeScope.depth > 1
  ) {
    return [];
  }
  const entries = activeScope.stagedEntries.splice(
    0,
    activeScope.stagedEntries.length,
  );
  return appendTenantAuditEntries(ctx, entries);
}

/** Returns the current staged audit watermark before opening a PostgreSQL transaction. */
export function getStagedAuditWatermark(): number {
  return getAuditStagingStorage()?.current()?.stagedEntries.length ?? 0;
}

/** Discards audit entries staged inside a PostgreSQL transaction that rolled back. */
export function discardStagedAuditEntriesSince(watermark: number): void {
  const activeScope = getAuditStagingStorage()?.current();
  if (!activeScope) return;
  const safeWatermark = Math.max(0, Math.floor(watermark));
  if (activeScope.stagedEntries.length > safeWatermark) {
    activeScope.stagedEntries.length = safeWatermark;
  }
}

export function createVerifiedTenantContext(
  claims: {
    sub: string;
    tenantId: string;
    name?: string;
    email?: string;
    upn?: string;
    roles?: readonly string[];
    groups?: readonly string[];
    entraObjectId?: string;
    entraTenantId?: string;
    mfaVerified?: boolean;
    correlationId?: string;
  },
  configOverride?: Pick<
    TenantConfiguration,
    'tenantId' | 'hostingMode' | 'environment' | 'branding' | 'keyVault' | 'database'
  >,
): TenantContext {
  const cfg = configOverride ?? getActiveTenantConfiguration();
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: claims.sub,
      tenantId: claims.tenantId,
      name: claims.name ?? claims.sub,
      email:
        claims.email ??
        `${claims.sub.toLowerCase()}@${claims.tenantId}.local`,
      ...(claims.upn ? { upn: claims.upn } : {}),
      roles: claims.roles ? [...claims.roles] : [],
      ...(claims.groups ? { groups: [...claims.groups] } : {}),
      ...(claims.entraObjectId ? { entraObjectId: claims.entraObjectId } : {}),
      ...(claims.entraTenantId ? { entraTenantId: claims.entraTenantId } : {}),
      mfaVerified: claims.mfaVerified ?? false,
    },
    hostingMode: cfg.hostingMode,
    environment: cfg.environment,
    correlationId: resolveRequestCorrelationId(claims.correlationId, 'req'),
    configuredPostgresHost: cfg.database?.dedicatedServerHost,
    configuredKeyVault: cfg.keyVault
      ? {
          vaultName: cfg.keyVault.vaultName,
          vaultUri: cfg.keyVault.vaultUri,
        }
      : undefined,
  });
}

export {
  TenantAuditRepository,
  TenantCatalogueRepository,
  TenantChasingRepository,
  TenantEngagementRepository,
  TenantEvidenceArtifactRepository,
  TenantHrAndRbacRepository,
  TenantIntakeCheckRepository,
  TenantIntakeQuoteRepository,
  TenantJobRunRepository,
  TenantMatterRepository,
  TenantMoneyOnAccountRepository,
  TenantOutboxRepository,
  TenantPartyRepository,
  TenantPmsRepository,
  TenantRateOverrideRepository,
  TenantRegisterRepository,
  TenantSearchRepository,
  TenantTaskWorkflowRepository,
};

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
    schemaVersion: tenantConfig.schemaVersion,
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
