/**
 * Platform Runtime Bridge connecting the Next.js host (`onesquared`) to:
 * - Layer 1: `@platform/core` (Tenancy, Config Engine, Extension Host, PostgreSQL Database-per-Tenant)
 * - Layer 2: `client-not-a-law-firm/config/base.json` (Schema-validated Tenant Configuration)
 * - Layer 3: `client-not-a-law-firm/extensions/nalf-matter-costs-governance` (Bespoke Client Extension)
 */

import path from 'node:path';
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
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import notALawFirmDevOverlay from '../../client-not-a-law-firm/config/environments/dev.json';
import { notALawFirmMatterCostsExtension } from '../../client-not-a-law-firm/extensions/nalf-matter-costs-governance/src/index';

let testBaseConfigOverride: Record<string, unknown> | null = null;
let testDevOverlayOverride: Record<string, unknown> | null | undefined = undefined;

export function setActiveTenantConfigForTesting(
  baseConfig: Record<string, unknown> | null,
  devOverlay?: Record<string, unknown> | null,
): void {
  testBaseConfigOverride = baseConfig;
  testDevOverlayOverride = devOverlay;
}

export function getActiveTenantBaseConfigPath(): string {
  const folder = process.env.PLATFORM_TENANT_PACKAGE_DIR || 'client-not-a-law-firm';
  return path.join(process.cwd(), folder, 'config', 'base.json');
}

export function getActiveTenantRawBaseConfig(): Record<string, unknown> {
  return (testBaseConfigOverride ?? notALawFirmBaseConfig) as Record<string, unknown>;
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

export interface VerifiedSessionActorInput {
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

let cachedHost: ExtensionHost | null = null;
let cachedCluster: PostgresTenantCluster | null = null;

export function getPlatformExtensionHost(): ExtensionHost {
  if (!cachedHost) {
    cachedHost = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
    cachedHost.registerExtension(notALawFirmMatterCostsExtension);
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
  const baseCfg = testBaseConfigOverride ?? notALawFirmBaseConfig;
  const overlayCfg =
    testDevOverlayOverride !== undefined
      ? (testDevOverlayOverride ?? {})
      : testBaseConfigOverride
        ? {}
        : notALawFirmDevOverlay;
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
      email: actor.email ?? `user@${cfg.branding.primaryDomain}`,
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
