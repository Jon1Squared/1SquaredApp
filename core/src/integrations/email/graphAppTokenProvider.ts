/**
 * Microsoft Graph Application-Only Certificate Token Provider
 * (`core/src/integrations/email/graphAppTokenProvider.ts`).
 *
 * Implements ADR 0027 §7.2 and R500:
 * - Resolves the client certificate PEM secret (`secretProperties.contentType = "application/x-pem-file"`)
 *   from the tenant's own Azure Key Vault after `assertTenantOwnsKeyVaultSecretRef`.
 * - Rejects non-PEM / PKCS#12 secrets with `GRAPH_CERT_FORMAT_UNSUPPORTED`.
 * - Verifies SHA-1 thumbprint (`GRAPH_CERT_THUMBPRINT_MISMATCH` on mismatch).
 * - Signs an RFC 7523 RS256 client assertion JWT with `x5t` header and
 *   discards the certificate and private key immediately after assertion signing.
 * - Caches ONLY access tokens per instance in an AES-256-GCM encrypted store
 *   keyed by `buildTenantCacheKey(ctx, 'graph-app-token', ...)`, expiring
 *   300,000 ms (5 minutes) before Entra `expires_in`.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createSign,
  randomBytes,
  randomUUID,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import type { TenantContext, TenantEmailGraphConfig } from '../../api/index';
import { buildTenantCacheKey } from '../../tenancy/index';
import { assertTenantOwnsKeyVaultSecretRef } from '../../tenancy/keyVaultSecrets';
import { EmailIntegrationError } from './errors';
import {
  DefaultAzureKeyVaultSecretReader,
  type FetchLike,
  type KeyVaultSecretReader,
} from './keyVaultSecretReader';

export const GRAPH_MAIL_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';
export const GRAPH_ACCESS_TOKEN_EXPIRY_SKEW_MS = 300_000;
const ENTRA_TOKEN_TIMEOUT_MS = 10_000;

interface EncryptedAccessTokenEntry {
  readonly tenantId: string;
  readonly ivHex: string;
  readonly authTagHex: string;
  readonly ciphertextHex: string;
  readonly expiresAtMs: number;
}

interface ParsedCertificateMaterial {
  readonly certPem: string;
  readonly privateKeyPem: string;
}

function parseCertificateMaterial(rawSecret: string): ParsedCertificateMaterial {
  const trimmed = rawSecret.trim();
  if (!trimmed) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_FORMAT_UNSUPPORTED',
      'Client certificate Key Vault secret is empty; expected an unencrypted PEM bundle.',
    );
  }

  if (trimmed.includes('ENCRYPTED PRIVATE KEY')) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_FORMAT_UNSUPPORTED',
      'Encrypted PEM private keys are not supported; configure Key Vault certificate policy with secretProperties.contentType = "application/x-pem-file".',
    );
  }

  const certMatch =
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(trimmed);
  const keyMatch =
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC )?PRIVATE KEY-----/.exec(
      trimmed,
    );

  if (!certMatch?.[0] || !keyMatch?.[0]) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_FORMAT_UNSUPPORTED',
      'Key Vault certificate secret must be an unencrypted PEM bundle (secretProperties.contentType = "application/x-pem-file") containing both CERTIFICATE and PRIVATE KEY blocks.',
    );
  }

  return {
    certPem: certMatch[0],
    privateKeyPem: keyMatch[0],
  };
}

function base64UrlEncodeJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function buildRs256ClientAssertion(params: {
  readonly graph: TenantEmailGraphConfig;
  readonly tokenEndpoint: string;
  readonly material: ParsedCertificateMaterial;
  readonly nowMs: number;
}): { readonly jwt: string; readonly thumbprintHex: string } {
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(params.material.certPem);
  } catch {
    throw new EmailIntegrationError(
      'GRAPH_CERT_FORMAT_UNSUPPORTED',
      'Unable to parse X.509 certificate PEM for Microsoft Graph client assertion.',
    );
  }

  const actualThumbprint = x509.fingerprint.replace(/:/g, '').toUpperCase();
  const expectedThumbprint = params.graph.certificateThumbprint
    .trim()
    .toUpperCase();
  if (actualThumbprint !== expectedThumbprint) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_THUMBPRINT_MISMATCH',
      'Microsoft Graph client certificate SHA-1 thumbprint does not match configured certificateThumbprint.',
    );
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(params.material.privateKeyPem);
  } catch {
    throw new EmailIntegrationError(
      'GRAPH_CERT_FORMAT_UNSUPPORTED',
      'Unable to parse private key PEM for Microsoft Graph client assertion.',
    );
  }

  const x5t = Buffer.from(actualThumbprint, 'hex').toString('base64url');
  const nowSec = Math.floor(params.nowMs / 1000);
  const header = base64UrlEncodeJson({
    alg: 'RS256',
    typ: 'JWT',
    x5t,
  });
  const payload = base64UrlEncodeJson({
    aud: params.tokenEndpoint,
    iss: params.graph.clientId,
    sub: params.graph.clientId,
    jti: randomUUID(),
    nbf: nowSec - 60,
    iat: nowSec,
    exp: nowSec + 300,
  });
  const signingInput = `${header}.${payload}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');

  return {
    jwt: `${signingInput}.${signature}`,
    thumbprintHex: actualThumbprint,
  };
}

class InstanceEncryptedAccessTokenCache {
  private readonly encryptionKey: Buffer = randomBytes(32);
  private readonly entries = new Map<string, EncryptedAccessTokenEntry>();

  public get(
    ctx: Pick<TenantContext, 'tenantId'>,
    cacheKey: string,
    nowMs: number,
  ): string | null {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return null;
    }
    if (entry.tenantId !== ctx.tenantId) {
      throw new EmailIntegrationError(
        'TENANCY_CACHE_ISOLATION_ERROR',
        'Cached Graph access token tenant mismatch rejected.',
      );
    }
    if (nowMs >= entry.expiresAtMs - GRAPH_ACCESS_TOKEN_EXPIRY_SKEW_MS) {
      this.entries.delete(cacheKey);
      return null;
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(entry.ivHex, 'hex'),
    );
    decipher.setAAD(Buffer.from(cacheKey, 'utf8'));
    decipher.setAuthTag(Buffer.from(entry.authTagHex, 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertextHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
    return plaintext;
  }

  public set(params: {
    readonly ctx: Pick<TenantContext, 'tenantId'>;
    readonly cacheKey: string;
    readonly accessToken: string;
    readonly expiresInSeconds: number;
    readonly nowMs: number;
  }): void {
    const expiresInMs = Math.max(1, Math.floor(params.expiresInSeconds)) * 1000;
    const expiresAtMs = params.nowMs + expiresInMs;
    if (params.nowMs >= expiresAtMs - GRAPH_ACCESS_TOKEN_EXPIRY_SKEW_MS) {
      return;
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(params.cacheKey, 'utf8'));
    const encrypted = Buffer.concat([
      cipher.update(params.accessToken, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    this.entries.set(params.cacheKey, {
      tenantId: params.ctx.tenantId,
      ivHex: iv.toString('hex'),
      authTagHex: authTag.toString('hex'),
      ciphertextHex: encrypted.toString('hex'),
      expiresAtMs,
    });
  }

  public readEncryptedSnapshotMetadata(cacheKey: string): {
    readonly exists: boolean;
    readonly ciphertextHex: string | null;
    readonly expiresAtMs: number | null;
  } {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return { exists: false, ciphertextHex: null, expiresAtMs: null };
    }
    return {
      exists: true,
      ciphertextHex: entry.ciphertextHex,
      expiresAtMs: entry.expiresAtMs,
    };
  }
}

export class GraphAppTokenProvider {
  private readonly secretReader: KeyVaultSecretReader;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly cache = new InstanceEncryptedAccessTokenCache();

  public constructor(options?: {
    readonly secretReader?: KeyVaultSecretReader;
    readonly fetchFn?: FetchLike;
    readonly now?: () => number;
  }) {
    this.secretReader =
      options?.secretReader ?? new DefaultAzureKeyVaultSecretReader();
    this.fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.now = options?.now ?? (() => Date.now());
  }

  public buildCacheKey(
    ctx: Pick<TenantContext, 'tenantId'>,
    graph: Pick<TenantEmailGraphConfig, 'tenantId' | 'clientId'>,
    scope: string = GRAPH_MAIL_DEFAULT_SCOPE,
  ): string {
    return buildTenantCacheKey(
      ctx,
      'graph-app-token',
      `${graph.tenantId}:${graph.clientId}:${scope}`,
    );
  }

  public inspectCacheMetadata(
    ctx: Pick<TenantContext, 'tenantId'>,
    graph: Pick<TenantEmailGraphConfig, 'tenantId' | 'clientId'>,
    scope: string = GRAPH_MAIL_DEFAULT_SCOPE,
  ): {
    readonly exists: boolean;
    readonly ciphertextHex: string | null;
    readonly expiresAtMs: number | null;
  } {
    return this.cache.readEncryptedSnapshotMetadata(
      this.buildCacheKey(ctx, graph, scope),
    );
  }

  public async acquireAppToken(
    ctx: TenantContext,
    graph: TenantEmailGraphConfig,
    scope: string = GRAPH_MAIL_DEFAULT_SCOPE,
  ): Promise<string> {
    assertTenantOwnsKeyVaultSecretRef(ctx, graph.certificateVaultRef);

    const cacheKey = this.buildCacheKey(ctx, graph, scope);
    const currentMs = this.now();
    const cachedToken = this.cache.get(ctx, cacheKey, currentMs);
    if (cachedToken) {
      return cachedToken;
    }

    const rawSecret = await this.secretReader.readSecret(
      ctx,
      graph.certificateVaultRef,
    );
    const material = parseCertificateMaterial(rawSecret);
    const tokenEndpoint = `https://login.microsoftonline.com/${encodeURIComponent(graph.tenantId)}/oauth2/v2.0/token`;

    const { jwt } = buildRs256ClientAssertion({
      graph,
      tokenEndpoint,
      material,
      nowMs: currentMs,
    });

    const body = new URLSearchParams({
      client_id: graph.clientId,
      scope,
      client_assertion_type:
        'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: jwt,
      grant_type: 'client_credentials',
    });

    const response = await this.fetchFn(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(ENTRA_TOKEN_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new EmailIntegrationError(
        `GRAPH_TOKEN_HTTP_${response.status}`,
        `Entra client-credentials token request failed with HTTP ${response.status}.`,
      );
    }

    const tokenJson = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (
      typeof tokenJson?.access_token !== 'string' ||
      !tokenJson.access_token.trim()
    ) {
      throw new EmailIntegrationError(
        'GRAPH_TOKEN_RESPONSE_INVALID',
        'Entra token response omitted access_token.',
      );
    }

    const expiresInSeconds =
      typeof tokenJson.expires_in === 'number' &&
      Number.isFinite(tokenJson.expires_in) &&
      tokenJson.expires_in > 0
        ? tokenJson.expires_in
        : 3600;

    this.cache.set({
      ctx,
      cacheKey,
      accessToken: tokenJson.access_token,
      expiresInSeconds,
      nowMs: this.now(),
    });

    return tokenJson.access_token;
  }
}
