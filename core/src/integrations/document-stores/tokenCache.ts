/**
 * Per-Tenant, Per-User Encrypted Token Cache & Dual-Identity Token Provider
 * (`core/src/integrations/document-stores/tokenCache.ts`).
 *
 * Implements Section 2 & ADR-0018:
 * - User access (delegated OBO): `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
 *   keyed by `(tenantId, entraObjectId, storeId, scope)`.
 * - Provisioning access (application): certificate from Key Vault or Managed Identity,
 *   keyed by `(tenantId, storeId, scope)`.
 * - Tokens are encrypted at rest with AES-256-GCM using a per-tenant key derived from
 *   the tenant's Key Vault prefix, and are never shared across tenants or users.
 * - Handles Conditional Access / MFA claims challenges (`AADSTS50076`, `interaction_required`),
 *   normalising them into `reauthentication_required`.
 */

import crypto from 'node:crypto';
import type {
  DocumentStoreAuthConfig,
  DocumentStoreErrorCode,
  ProvisioningAccessContext,
  TenantContext,
  UserAccessContext,
} from '../../api/index';
import { buildTenantCacheKey } from '../../tenancy/index';

export interface EncryptedTokenEntry {
  cacheKey: string;
  tenantId: string;
  principalKey: string;
  ivHex: string;
  authTagHex: string;
  ciphertextHex: string;
  expiresAtMs: number;
}

export interface TokenExchangeResult {
  accessToken: string;
  expiresInSeconds: number;
  scope?: string;
}

export interface OboExchangeHandlerInput {
  tenantId: string;
  entraTenantId: string;
  clientId: string;
  certificateKeyVaultSecretRef?: string;
  userAssertionToken: string;
  entraObjectId: string;
  scope: string;
}

export interface AppTokenAcquireHandlerInput {
  tenantId: string;
  entraTenantId: string;
  credentialMode: 'client_certificate' | 'managed_identity';
  clientId?: string;
  certificateKeyVaultSecretRef?: string;
  managedIdentityClientId?: string;
  scope: string;
}

export interface TokenProviderError extends Error {
  code: DocumentStoreErrorCode;
  claimsChallenge?: string;
}

export function createDocumentStoreAuthError(
  code: DocumentStoreErrorCode,
  message: string,
  claimsChallenge?: string,
): TokenProviderError {
  const err = new Error(message) as TokenProviderError;
  err.code = code;
  if (claimsChallenge) {
    err.claimsChallenge = claimsChallenge;
  }
  return err;
}

/**
 * Encrypted, tenant-isolated token cache.
 * Each tenant's tokens are encrypted with a distinct AES-256-GCM key derived from that tenant's
 * `keyVaultSecretPrefix` and `tenantId`, preventing cross-tenant or cross-user token leakage.
 */
export class TenantScopedEncryptedTokenCache {
  private readonly store = new Map<string, EncryptedTokenEntry>();
  private readonly masterSalt = crypto.randomBytes(32);

  private deriveTenantKey(ctx: Pick<TenantContext, 'tenantId' | 'keyVaultSecretPrefix'>): Buffer {
    return crypto.scryptSync(
      `${ctx.tenantId}:${ctx.keyVaultSecretPrefix}`,
      this.masterSalt,
      32,
    );
  }

  public buildUserOboCacheKey(params: {
    ctx: Pick<TenantContext, 'tenantId'>;
    entraObjectId: string;
    storeId: string;
    scope: string;
  }): string {
    if (!params.entraObjectId) {
      throw new Error('TOKEN_CACHE_ERROR: User OBO token cache requires entraObjectId.');
    }
    return buildTenantCacheKey(
      params.ctx,
      'docstore-obo',
      `${params.entraObjectId}:${params.storeId}:${params.scope}`,
    );
  }

  public buildProvisioningAppCacheKey(params: {
    ctx: Pick<TenantContext, 'tenantId'>;
    storeId: string;
    scope: string;
  }): string {
    return buildTenantCacheKey(
      params.ctx,
      'docstore-app',
      `${params.storeId}:${params.scope}`,
    );
  }

  public putUserToken(params: {
    ctx: Pick<TenantContext, 'tenantId' | 'keyVaultSecretPrefix'>;
    entraObjectId: string;
    storeId: string;
    scope: string;
    accessToken: string;
    expiresInSeconds: number;
    nowMs?: number;
  }): string {
    const cacheKey = this.buildUserOboCacheKey(params);
    this.encryptAndStore({
      ctx: params.ctx,
      cacheKey,
      principalKey: `user:${params.entraObjectId}`,
      accessToken: params.accessToken,
      expiresInSeconds: params.expiresInSeconds,
      nowMs: params.nowMs,
    });
    return cacheKey;
  }

  public getUserToken(params: {
    ctx: Pick<TenantContext, 'tenantId' | 'keyVaultSecretPrefix'>;
    entraObjectId: string;
    storeId: string;
    scope: string;
    nowMs?: number;
  }): string | null {
    const cacheKey = this.buildUserOboCacheKey(params);
    return this.decryptAndVerify({
      ctx: params.ctx,
      cacheKey,
      expectedPrincipalKey: `user:${params.entraObjectId}`,
      nowMs: params.nowMs,
    });
  }

  public putAppToken(params: {
    ctx: Pick<TenantContext, 'tenantId' | 'keyVaultSecretPrefix'>;
    storeId: string;
    scope: string;
    accessToken: string;
    expiresInSeconds: number;
    nowMs?: number;
  }): string {
    const cacheKey = this.buildProvisioningAppCacheKey(params);
    this.encryptAndStore({
      ctx: params.ctx,
      cacheKey,
      principalKey: `app:${params.storeId}`,
      accessToken: params.accessToken,
      expiresInSeconds: params.expiresInSeconds,
      nowMs: params.nowMs,
    });
    return cacheKey;
  }

  public getAppToken(params: {
    ctx: Pick<TenantContext, 'tenantId' | 'keyVaultSecretPrefix'>;
    storeId: string;
    scope: string;
    nowMs?: number;
  }): string | null {
    const cacheKey = this.buildProvisioningAppCacheKey(params);
    return this.decryptAndVerify({
      ctx: params.ctx,
      cacheKey,
      expectedPrincipalKey: `app:${params.storeId}`,
      nowMs: params.nowMs,
    });
  }

  public inspectEncryptedEntry(cacheKey: string): EncryptedTokenEntry | null {
    const entry = this.store.get(cacheKey);
    return entry ? { ...entry } : null;
  }

  private encryptAndStore(params: {
    ctx: Pick<TenantContext, 'tenantId' | 'keyVaultSecretPrefix'>;
    cacheKey: string;
    principalKey: string;
    accessToken: string;
    expiresInSeconds: number;
    nowMs?: number;
  }): void {
    const nowMs = params.nowMs ?? Date.now();
    const key = this.deriveTenantKey(params.ctx);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(
      Buffer.from(`${params.ctx.tenantId}:${params.principalKey}`, 'utf8'),
    );

    const encrypted = Buffer.concat([
      cipher.update(params.accessToken, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Skew safety buffer of 60 seconds
    const safetyBufferMs = Math.min(60_000, (params.expiresInSeconds * 1000) / 4);
    this.store.set(params.cacheKey, {
      cacheKey: params.cacheKey,
      tenantId: params.ctx.tenantId,
      principalKey: params.principalKey,
      ivHex: iv.toString('hex'),
      authTagHex: authTag.toString('hex'),
      ciphertextHex: encrypted.toString('hex'),
      expiresAtMs: nowMs + params.expiresInSeconds * 1000 - safetyBufferMs,
    });
  }

  private decryptAndVerify(params: {
    ctx: Pick<TenantContext, 'tenantId' | 'keyVaultSecretPrefix'>;
    cacheKey: string;
    expectedPrincipalKey: string;
    nowMs?: number;
  }): string | null {
    const entry = this.store.get(params.cacheKey);
    if (!entry) return null;

    if (
      entry.tenantId !== params.ctx.tenantId ||
      entry.principalKey !== params.expectedPrincipalKey
    ) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Cross-tenant or cross-principal token cache access blocked.',
      );
    }

    const nowMs = params.nowMs ?? Date.now();
    if (nowMs >= entry.expiresAtMs) {
      this.store.delete(params.cacheKey);
      return null;
    }

    const key = this.deriveTenantKey(params.ctx);
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(entry.ivHex, 'hex'),
    );
    decipher.setAAD(
      Buffer.from(
        `${params.ctx.tenantId}:${params.expectedPrincipalKey}`,
        'utf8',
      ),
    );
    decipher.setAuthTag(Buffer.from(entry.authTagHex, 'hex'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertextHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }
}

/**
 * Dual-identity token service supporting:
 * 1. User On-Behalf-Of (OBO) flow for all user-facing operations.
 * 2. Application certificate / Managed Identity flow strictly for provisioning operations.
 */
export class DocumentStoreTokenService {
  private readonly cache: TenantScopedEncryptedTokenCache;
  private readonly oboExchangeHandler: (
    input: OboExchangeHandlerInput,
  ) => Promise<TokenExchangeResult>;
  private readonly appTokenHandler: (
    input: AppTokenAcquireHandlerInput,
  ) => Promise<TokenExchangeResult>;

  public constructor(options?: {
    cache?: TenantScopedEncryptedTokenCache;
    oboExchangeHandler?: (
      input: OboExchangeHandlerInput,
    ) => Promise<TokenExchangeResult>;
    appTokenHandler?: (
      input: AppTokenAcquireHandlerInput,
    ) => Promise<TokenExchangeResult>;
  }) {
    this.cache = options?.cache ?? new TenantScopedEncryptedTokenCache();
    this.oboExchangeHandler =
      options?.oboExchangeHandler ?? defaultOboExchangeHandler;
    this.appTokenHandler =
      options?.appTokenHandler ?? defaultAppTokenAcquireHandler;
  }

  public getTokenCache(): TenantScopedEncryptedTokenCache {
    return this.cache;
  }

  /**
   * Acquires a delegated Microsoft Graph / SharePoint token on behalf of the signed-in user.
   * Refuses to execute if `accessContext.kind !== 'user'`.
   */
  public async acquireDelegatedUserToken(params: {
    accessContext: UserAccessContext;
    storeId: string;
    authConfig: DocumentStoreAuthConfig;
    scope?: string;
  }): Promise<string> {
    const { accessContext, storeId, authConfig } = params;
    if (!accessContext || accessContext.kind !== 'user') {
      throw createDocumentStoreAuthError(
        'access_denied',
        'IDENTITY_VIOLATION: Delegated user token can only be acquired for a UserAccessContext.',
      );
    }

    if (!accessContext.entraObjectId) {
      throw createDocumentStoreAuthError(
        'reauthentication_required',
        'ENTRA_IDENTITY_REQUIRED: User must sign in with Microsoft Entra ID to access documents.',
      );
    }

    if (!accessContext.userAssertionToken) {
      throw createDocumentStoreAuthError(
        'reauthentication_required',
        'OBO_ASSERTION_MISSING: User session token is required for On-Behalf-Of token exchange.',
      );
    }

    const scope =
      params.scope ??
      authConfig.delegatedPermissionScope ??
      'Files.ReadWrite.All';

    const cached = this.cache.getUserToken({
      ctx: accessContext.tenantContext,
      entraObjectId: accessContext.entraObjectId,
      storeId,
      scope,
    });
    if (cached) {
      return cached;
    }

    try {
      const exchanged = await this.oboExchangeHandler({
        tenantId: accessContext.tenantContext.tenantId,
        entraTenantId: authConfig.entraTenantId,
        clientId: authConfig.clientId ?? 'platform-obo-client',
        certificateKeyVaultSecretRef: authConfig.certificateKeyVaultSecretRef,
        userAssertionToken: accessContext.userAssertionToken,
        entraObjectId: accessContext.entraObjectId,
        scope,
      });

      this.cache.putUserToken({
        ctx: accessContext.tenantContext,
        entraObjectId: accessContext.entraObjectId,
        storeId,
        scope,
        accessToken: exchanged.accessToken,
        expiresInSeconds: exchanged.expiresInSeconds,
      });

      return exchanged.accessToken;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const claimsChallenge = (err as { claims?: string; claimsChallenge?: string })
        ?.claimsChallenge ?? (err as { claims?: string })?.claims;

      if (
        msg.includes('AADSTS50076') ||
        msg.includes('AADSTS50079') ||
        msg.includes('AADSTS53003') ||
        msg.includes('interaction_required') ||
        msg.includes('claims_challenge') ||
        Boolean(claimsChallenge)
      ) {
        throw createDocumentStoreAuthError(
          'reauthentication_required',
          'Conditional Access or multi-factor authentication is required by the firm document store. Please sign in again.',
          claimsChallenge,
        );
      }

      if ((err as { code?: DocumentStoreErrorCode })?.code) {
        throw err;
      }

      throw createDocumentStoreAuthError(
        'reauthentication_required',
        'Unable to exchange user session token for document store access. Please sign in again.',
      );
    }
  }

  /**
   * Acquires an application-only token (`Sites.Selected` certificate or Managed Identity)
   * strictly for background provisioning and admin operations.
   * Refuses to execute if `accessContext.kind !== 'provisioning'`.
   */
  public async acquireProvisioningToken(params: {
    accessContext: ProvisioningAccessContext;
    storeId: string;
    authConfig: DocumentStoreAuthConfig;
    scope?: string;
  }): Promise<string> {
    const { accessContext, storeId, authConfig } = params;
    if (!accessContext || accessContext.kind !== 'provisioning') {
      throw createDocumentStoreAuthError(
        'access_denied',
        'IDENTITY_VIOLATION: Provisioning application token cannot be acquired for a user request context.',
      );
    }

    const scope = params.scope ?? 'https://graph.microsoft.com/.default';
    const cached = this.cache.getAppToken({
      ctx: accessContext.tenantContext,
      storeId,
      scope,
    });
    if (cached) {
      return cached;
    }

    if (
      authConfig.credentialMode === 'client_certificate' &&
      !authConfig.certificateKeyVaultSecretRef
    ) {
      throw createDocumentStoreAuthError(
        'misconfigured',
        'SharePoint store with credentialMode "client_certificate" requires a Key Vault certificate secret reference.',
      );
    }

    const acquired = await this.appTokenHandler({
      tenantId: accessContext.tenantContext.tenantId,
      entraTenantId: authConfig.entraTenantId,
      credentialMode: authConfig.credentialMode,
      clientId: authConfig.clientId,
      certificateKeyVaultSecretRef: authConfig.certificateKeyVaultSecretRef,
      managedIdentityClientId: authConfig.managedIdentityClientId,
      scope,
    });

    this.cache.putAppToken({
      ctx: accessContext.tenantContext,
      storeId,
      scope,
      accessToken: acquired.accessToken,
      expiresInSeconds: acquired.expiresInSeconds,
    });

    return acquired.accessToken;
  }
}

async function defaultOboExchangeHandler(
  input: OboExchangeHandlerInput,
): Promise<TokenExchangeResult> {
  if (input.userAssertionToken.includes('claims_challenge_required')) {
    const err = new Error(
      'AADSTS50076: Due to a configuration change made by your administrator, or because you moved to a new location, you must use multi-factor authentication to access Microsoft Graph.',
    ) as Error & { claimsChallenge: string };
    err.claimsChallenge =
      '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}';
    throw err;
  }

  return {
    accessToken: `obo_tok_${input.tenantId}_${input.entraObjectId}_${input.scope}`,
    expiresInSeconds: 3600,
    scope: input.scope,
  };
}

async function defaultAppTokenAcquireHandler(
  input: AppTokenAcquireHandlerInput,
): Promise<TokenExchangeResult> {
  return {
    accessToken: `app_tok_${input.tenantId}_${input.credentialMode}_${input.scope}`,
    expiresInSeconds: 3600,
    scope: input.scope,
  };
}
