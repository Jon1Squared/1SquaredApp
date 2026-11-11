/**
 * Per-tenant Azure Key Vault secret-reference ownership guard (`core/src/tenancy/keyVaultSecrets.ts`).
 *
 * Enforces ADR 0024 AG3 & Platform Architecture Standard §8 / Rule 5:
 * - Every `kv://<vault>/<secret>` or `https://<vault>.vault.azure.net/secrets/<secret>` reference
 *   resolved at runtime or validated in tenant configuration must belong to the calling tenant's
 *   own Key Vault.
 * - When `keyVault` (`vaultName` / `vaultUri`, populated from `core/infra/modules/tenant.bicep`
 *   deployment outputs including 24-character truncated Azure Key Vault names, R413) is present,
 *   the secret reference's `<vault>` must match that configured vault directly rather than
 *   re-deriving Azure naming truncation in TypeScript.
 */

import type { TenantContext, TenantKeyVaultConfig } from '../api/index';

const KV_SCHEME_PATTERN = /^kv:\/\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9-]+)$/;
const HTTPS_VAULT_SECRET_PATTERN =
  /^https:\/\/([a-zA-Z0-9-]+)\.vault\.azure\.net\/secrets\/([a-zA-Z0-9-]+)(?:\/[a-zA-Z0-9-]+)?\/?$/i;
const VAULT_URI_HOST_PATTERN =
  /^https:\/\/([a-zA-Z0-9-]+)\.vault\.azure\.net\/?$/i;
const VALID_PLATFORM_ENVIRONMENTS = new Set([
  'dev',
  'test',
  'training',
  'demo',
  'live',
]);

function createCrossTenantVaultError(message: string): Error & { code: string } {
  const err = new Error(
    `TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED: ${message}`,
  ) as Error & { code: string };
  err.code = 'TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED';
  return err;
}

function parseConfiguredVaultName(
  configuredVault: TenantKeyVaultConfig | undefined,
): string | null {
  if (!configuredVault) {
    return null;
  }
  const explicitName = configuredVault.vaultName?.trim().toLowerCase() || '';
  const explicitUri = configuredVault.vaultUri?.trim() || '';
  let uriVaultName = '';
  if (explicitUri) {
    const match = VAULT_URI_HOST_PATTERN.exec(explicitUri);
    if (!match?.[1]) {
      throw createCrossTenantVaultError(
        'Configured tenant keyVault.vaultUri is not a valid Azure Key Vault URI.',
      );
    }
    uriVaultName = match[1].toLowerCase();
  }
  if (explicitName && uriVaultName && explicitName !== uriVaultName) {
    throw createCrossTenantVaultError(
      'Configured tenant keyVault.vaultName and keyVault.vaultUri refer to different vaults.',
    );
  }
  return explicitName || uriVaultName || null;
}

/**
 * Verifies that `secretRef` (`kv://<vault>/<secret>` or `https://<vault>.vault.azure.net/secrets/<secret>`)
 * belongs exclusively to `ctx`'s own Key Vault. Throws `TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED` otherwise.
 */
export function assertTenantOwnsKeyVaultSecretRef(
  ctx: Pick<
    TenantContext,
    'tenantId' | 'environment' | 'keyVaultSecretPrefix' | 'configuredKeyVault'
  >,
  secretRef: string,
): { vaultName: string; secretName: string } {
  const tenantId = ctx?.tenantId?.trim().toLowerCase() ?? '';
  if (!tenantId) {
    throw createCrossTenantVaultError(
      'Key Vault secret resolution requires a valid TenantContext.',
    );
  }

  const trimmedRef = (secretRef ?? '').trim();
  const kvMatch = KV_SCHEME_PATTERN.exec(trimmedRef);
  const httpsMatch = kvMatch ? null : HTTPS_VAULT_SECRET_PATTERN.exec(trimmedRef);
  const parsedVaultName = (kvMatch?.[1] ?? httpsMatch?.[1] ?? '').toLowerCase();
  const parsedSecretName = kvMatch?.[2] ?? httpsMatch?.[2] ?? '';

  if (!parsedVaultName || !parsedSecretName) {
    throw createCrossTenantVaultError(
      'Secret reference must be formatted as kv://<vault>/<secret> or https://<vault>.vault.azure.net/secrets/<secret>.',
    );
  }

  const expectedConfiguredVault = parseConfiguredVaultName(ctx.configuredKeyVault);
  if (expectedConfiguredVault) {
    if (parsedVaultName !== expectedConfiguredVault) {
      throw createCrossTenantVaultError(
        `Tenant "${tenantId}" attempted to reference Key Vault "${parsedVaultName}", which does not match its configured Key Vault "${expectedConfiguredVault}".`,
      );
    }
    return { vaultName: parsedVaultName, secretName: parsedSecretName };
  }

  const compactSlug = tenantId.replace(/-/g, '');
  const allowedPrefixes = new Set<string>();
  if (ctx.keyVaultSecretPrefix?.trim()) {
    allowedPrefixes.add(ctx.keyVaultSecretPrefix.trim().toLowerCase());
  }
  for (const env of VALID_PLATFORM_ENVIRONMENTS) {
    allowedPrefixes.add(`kv-${tenantId}-${env}`);
    allowedPrefixes.add(`kv-${compactSlug}-${env}`);
  }

  if (!allowedPrefixes.has(parsedVaultName)) {
    throw createCrossTenantVaultError(
      `Tenant "${tenantId}" is not permitted to access Key Vault "${parsedVaultName}".`,
    );
  }

  return { vaultName: parsedVaultName, secretName: parsedSecretName };
}
