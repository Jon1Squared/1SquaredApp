/**
 * Tenant-Scoped Azure Key Vault Secret Reader for Email Integrations
 * (`core/src/integrations/email/keyVaultSecretReader.ts`).
 *
 * Enforces ADR 0024 AG3 & Standard §8 / Rule 5: every `kv://` or `https://*.vault.azure.net`
 * secret reference is verified via `assertTenantOwnsKeyVaultSecretRef` BEFORE any
 * Azure credential or Key Vault network request occurs.
 */

import type { TokenCredential } from '@azure/identity';
import type { TenantContext } from '../../api/index';
import { assertTenantOwnsKeyVaultSecretRef } from '../../tenancy/keyVaultSecrets';
import { EmailIntegrationError } from './errors';

export interface KeyVaultSecretReader {
  readSecret(ctx: TenantContext, secretRef: string): Promise<string>;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const KEY_VAULT_SCOPE = 'https://vault.azure.net/.default';
const DEFAULT_KV_TIMEOUT_MS = 10_000;

export class DefaultAzureKeyVaultSecretReader implements KeyVaultSecretReader {
  private credential: TokenCredential | null;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  public constructor(options?: {
    readonly credential?: TokenCredential;
    readonly fetchFn?: FetchLike;
    readonly timeoutMs?: number;
  }) {
    this.credential = options?.credential ?? null;
    this.fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_KV_TIMEOUT_MS;
  }

  public async readSecret(
    ctx: TenantContext,
    secretRef: string,
  ): Promise<string> {
    const { vaultName, secretName } = assertTenantOwnsKeyVaultSecretRef(
      ctx,
      secretRef,
    );

    if (!this.credential) {
      const { DefaultAzureCredential } = await import('@azure/identity');
      this.credential = new DefaultAzureCredential();
    }
    const tokenRes = await this.credential.getToken(KEY_VAULT_SCOPE);
    if (!tokenRes?.token) {
      throw new EmailIntegrationError(
        'EMAIL_KEYVAULT_AUTH_FAILED',
        'Failed to acquire Azure Key Vault access token for tenant secret read.',
      );
    }

    const url = `https://${encodeURIComponent(vaultName)}.vault.azure.net/secrets/${encodeURIComponent(secretName)}?api-version=7.4`;
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokenRes.token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new EmailIntegrationError(
        `EMAIL_KEYVAULT_HTTP_${response.status}`,
        `Key Vault secret lookup failed with HTTP ${response.status}.`,
      );
    }

    const payload = (await response.json()) as { value?: unknown };
    if (typeof payload?.value !== 'string' || !payload.value.trim()) {
      throw new EmailIntegrationError(
        'EMAIL_KEYVAULT_SECRET_EMPTY',
        'Resolved Azure Key Vault secret has an empty or missing value.',
      );
    }
    return payload.value;
  }
}
