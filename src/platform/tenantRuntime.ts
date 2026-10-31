/**
 * Platform Runtime Bridge connecting the Next.js host (`onesquared`) to:
 * - Layer 1: `@platform/core` (Tenancy, Config Engine, Extension Host, PostgreSQL Database-per-Tenant)
 * - Layer 2: `client-not-a-law-firm/config/base.json` (Schema-validated Tenant Configuration)
 * - Layer 3: `client-not-a-law-firm/extensions/nalf-matter-costs-governance` (Bespoke Client Extension)
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
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import notALawFirmDevOverlay from '../../client-not-a-law-firm/config/environments/dev.json';
import { notALawFirmMatterCostsExtension } from '../../client-not-a-law-firm/extensions/nalf-matter-costs-governance/src/index';

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
  return loadAndValidateTenantConfig(
    notALawFirmBaseConfig,
    notALawFirmDevOverlay,
    env,
    hostingMode,
  );
}

export function resolveCurrentTenantContext(actor?: {
  id: string;
  name: string;
  email?: string;
  roles?: string[];
}): TenantContext {
  const cfg = getActiveTenantConfiguration();
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actor?.id ?? 'P-000001',
      tenantId: cfg.tenantId,
      email: actor?.email ?? `user@${cfg.branding.primaryDomain}`,
      name: actor?.name ?? 'Authenticated User',
      roles: actor?.roles ?? ['fee_earner', 'admin'],
      mfaVerified: true,
    },
    hostingMode: cfg.hostingMode,
    environment: cfg.environment,
    correlationId: `req-${Date.now()}`,
  });
}

export function getPlatformArchitectureSnapshot(actor?: {
  id: string;
  name: string;
  email?: string;
  roles?: string[];
}): PlatformArchitectureSnapshot {
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
