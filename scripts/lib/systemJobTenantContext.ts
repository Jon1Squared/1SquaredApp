/**
 * System job tenant context for CLI job entry points (`scripts/`), per the ADR 0030 §3 exception.
 *
 * Jobs have no user token, so the tenant comes from the tenant configuration or registry entry
 * the entry point loaded. This is the only place a synthetic verified token may be built
 * (R433): web requests always use the caller's verified `TenantContext` from `guardedAction`.
 * Users cannot reach this module; it is not exposed as a route or a server action.
 */

import { randomUUID } from 'node:crypto';
import {
  resolveTenantFromVerifiedToken,
  type HostingMode,
  type PermissionKey,
  type PlatformEnvironment,
  type TenantConfiguration,
  type TenantContext,
} from '@platform/core';

export function buildSystemJobTenantContext(params: {
  readonly tenantConfig: Pick<
    TenantConfiguration,
    'tenantId' | 'hostingMode' | 'environment'
  > & {
    readonly database?: { readonly dedicatedServerHost?: string };
    readonly keyVault?: {
      readonly vaultName?: string;
      readonly vaultUri?: string;
    };
  };
  readonly jobKey: string;
  readonly correlationId?: string;
  readonly configuredPostgresHost?: string;
  readonly jobPermissions?: readonly PermissionKey[];
}): TenantContext {
  const jobKey = params.jobKey.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(jobKey)) {
    throw new Error(
      'JOB_CONTEXT_ERROR: A valid jobKey is required to build a system job tenant context.',
    );
  }
  const configuredPostgresHost =
    params.configuredPostgresHost?.trim() ||
    params.tenantConfig.database?.dedicatedServerHost?.trim() ||
    undefined;

  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: `system:${jobKey}`,
      tenantId: params.tenantConfig.tenantId,
      name: `Platform job ${jobKey}`,
      email: `${jobKey}@platform.example`,
      roles: [],
      mfaVerified: true,
    },
    hostingMode: params.tenantConfig.hostingMode as HostingMode,
    environment: params.tenantConfig.environment as PlatformEnvironment,
    correlationId:
      params.correlationId?.trim() || `job-${jobKey}-${randomUUID()}`,
    ...(params.jobPermissions ? { jobPermissions: params.jobPermissions } : {}),
    ...(configuredPostgresHost ? { configuredPostgresHost } : {}),
    ...(params.tenantConfig.keyVault
      ? {
          configuredKeyVault: {
            vaultName: params.tenantConfig.keyVault.vaultName,
            vaultUri: params.tenantConfig.keyVault.vaultUri,
          },
        }
      : {}),
  });
}
