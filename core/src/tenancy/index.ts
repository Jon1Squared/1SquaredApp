/**
 * Tenant resolution and tenant-scoped data access layer (`core/src/tenancy/`).
 *
 * Rules enforced:
 * 1. Tenant identity comes ONLY from the authenticated OIDC token, never from a URL,
 *    form field, query string, or user-controlled header.
 * 2. All data access goes through a tenant-scoped repository connected to that tenant's
 *    isolated database store.
 * 3. Cache keys, queue messages, search entries, storage tokens, and background jobs
 *    always include the tenant ID and refuse to execute without one.
 */

import type {
  HostingMode,
  PlatformEnvironment,
  TenantContext,
  TenantKeyVaultConfig,
} from '../api/index';
import {
  isEntraMfaVerified,
  mapEntraTokenClaimsToVerifiedOidcToken,
  type EntraIdRawTokenClaims,
  type VerifiedOidcTokenClaims,
} from '../domain/rbac/entra';

export * from './migrations/index';
export * from './blobStorage';
export * from './documentRepository';
export * from './documentStoreRepository';
export * from './keyVaultSecrets';
export * from './tenantRegistry';
export * from './postgresPoolManager';
export * from './tenantScopedRepository';
export * from './keyDateRepository';
export * from './auditRepository';

export {
  isEntraMfaVerified,
  mapEntraTokenClaimsToVerifiedOidcToken,
  type EntraIdRawTokenClaims,
  type VerifiedOidcTokenClaims,
};

export interface ResolveTenantInput {
  verifiedToken: VerifiedOidcTokenClaims;
  hostingMode: HostingMode;
  environment: PlatformEnvironment;
  correlationId: string;
  /**
   * Optional untrusted request parameters used strictly to detect and reject
   * attempts to override tenant identity via URL, header, or form fields.
   */
  untrustedRequestTenantOverride?: string;
  configuredKeyVault?: TenantKeyVaultConfig;
  configuredPostgresHost?: string;
}

export interface TenantPostgresConnectionConfig {
  host: string;
  port: number;
  databaseName: string;
  sslMode: 'verify-full';
  keyVaultEncryptionKeyRef: string;
}

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export function normaliseTenantSlug(tenantId: string): string {
  return tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

export function resolveTenantFromVerifiedToken(
  input: ResolveTenantInput,
): TenantContext {
  const { verifiedToken, hostingMode, environment, correlationId } = input;

  if (!verifiedToken || verifiedToken.__verifiedByOidcMiddleware !== true) {
    throw new Error(
      'TENANCY_AUTH_ERROR: Tenant context can only be resolved from a verified OIDC token.',
    );
  }

  const tenantId = verifiedToken.tenantId?.trim();
  if (!tenantId || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(
      'TENANCY_CLAIM_ERROR: Authenticated token is missing a valid tenantId claim.',
    );
  }

  if (
    input.untrustedRequestTenantOverride &&
    input.untrustedRequestTenantOverride !== tenantId
  ) {
    throw new Error(
      'TENANCY_FORGERY_DETECTED: Request attempted to override authenticated token tenantId.',
    );
  }

  if (!correlationId || !correlationId.trim()) {
    throw new Error(
      'TENANCY_OBSERVABILITY_ERROR: Every request context requires a correlationId.',
    );
  }

  const slug = normaliseTenantSlug(tenantId);

  return Object.freeze({
    tenantId,
    actorId: verifiedToken.sub,
    actorName: verifiedToken.name,
    actorEmail: verifiedToken.email,
    ...(verifiedToken.upn ? { actorUpn: verifiedToken.upn } : {}),
    actorRoles: Object.freeze([...verifiedToken.roles]),
    ...(verifiedToken.groups
      ? { actorGroups: Object.freeze([...verifiedToken.groups]) }
      : {}),
    ...(verifiedToken.entraObjectId
      ? { entraObjectId: verifiedToken.entraObjectId }
      : {}),
    ...(verifiedToken.entraTenantId
      ? { entraTenantId: verifiedToken.entraTenantId }
      : {}),
    mfaVerified: Boolean(verifiedToken.mfaVerified),
    hostingMode,
    environment,
    correlationId,
    postgresDatabaseName: `pg_tenant_${slug}_${environment}`,
    ...(input.configuredPostgresHost?.trim()
      ? { configuredPostgresHost: input.configuredPostgresHost.trim() }
      : {}),
    blobContainerName: `tenant-${tenantId}-${environment}`,
    keyVaultSecretPrefix:
      input.configuredKeyVault?.vaultName?.trim() ||
      (input.configuredKeyVault?.vaultUri
        ? input.configuredKeyVault.vaultUri
            .trim()
            .replace(/^https:\/\//i, '')
            .split('.')[0] || `kv-${tenantId}-${environment}`
        : `kv-${tenantId}-${environment}`),
    ...(input.configuredKeyVault
      ? {
          configuredKeyVault: Object.freeze({
            ...(input.configuredKeyVault.vaultName
              ? { vaultName: input.configuredKeyVault.vaultName }
              : {}),
            ...(input.configuredKeyVault.vaultUri
              ? { vaultUri: input.configuredKeyVault.vaultUri }
              : {}),
          }),
        }
      : {}),
  });
}

export function resolveTenantPostgresConfig(
  ctx: TenantContext,
): TenantPostgresConnectionConfig {
  const slug = normaliseTenantSlug(ctx.tenantId);
  const host =
    ctx.configuredPostgresHost?.trim() ||
    (ctx.hostingMode === 'single_tenant'
      ? `${ctx.tenantId}-pg-${ctx.environment}.postgres.database.azure.com`
      : `platform-shared-pool-${ctx.environment}.postgres.database.azure.com`);

  return {
    host,
    port: Number(process.env.PLATFORM_POSTGRES_PORT || 6432),
    databaseName: ctx.postgresDatabaseName,
    sslMode: 'verify-full',
    keyVaultEncryptionKeyRef: `https://kv-platform-${ctx.environment}.vault.azure.net/keys/cmk-${slug}`,
  };
}

export function buildTenantCacheKey(
  ctx: Pick<TenantContext, 'tenantId'>,
  namespace: string,
  key: string,
): string {
  if (!ctx?.tenantId) {
    throw new Error('TENANCY_CACHE_ERROR: Cache key requires a tenantId.');
  }
  return `tenant:${ctx.tenantId}:${namespace}:${key}`;
}

export interface TenantBackgroundJob<TPayload = unknown> {
  jobId: string;
  tenantId: string;
  correlationId: string;
  payload: TPayload;
}

export function runTenantBackgroundJob<TPayload, TResult>(
  job: TenantBackgroundJob<TPayload>,
  handler: (job: TenantBackgroundJob<TPayload>) => TResult,
): TResult {
  if (!job?.tenantId || !TENANT_ID_PATTERN.test(job.tenantId)) {
    throw new Error(
      'TENANCY_JOB_ERROR: Background job refused to run without a valid tenantId.',
    );
  }
  if (!job?.correlationId) {
    throw new Error(
      'TENANCY_JOB_ERROR: Background job refused to run without a correlationId.',
    );
  }
  return handler(job);
}
