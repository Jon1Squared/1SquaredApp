import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import {
  isEntraMfaVerified,
  mapEntraTokenClaimsToVerifiedOidcToken,
  type EntraIdRawTokenClaims,
  type RbacConfiguration,
  type VerifiedOidcTokenClaims,
} from '@/domain/rbac';
import {
  type UnbrandedSessionActorInput,
  type VerifiedSessionActorInput,
} from '@/platform/tenantRuntime';

/**
 * Private brand constructor — only `src/server/entraAuth.ts` may mint a `VerifiedSessionActorInput`.
 */
function brandVerifiedSessionActor(
  input: UnbrandedSessionActorInput,
): VerifiedSessionActorInput {
  return input as VerifiedSessionActorInput;
}

declare const VERIFIED_ENTRA_SESSION_BRAND: unique symbol;
const VERIFIED_ENTRA_SESSION_RUNTIME_SYMBOL = Symbol(
  'VerifiedEntraSessionPayload',
);
const verifiedEntraSessionPayloads = new WeakSet<object>();

export const ENTRA_PKCE_COOKIE = 'onesquared_entra_pkce';
export const ENTRA_SESSION_COOKIE = 'onesquared_entra_session';

export interface EntraSessionPayload {
  personId: string;
  tenantId?: string;
  oid: string;
  tid: string;
  sub: string;
  email: string;
  displayName: string;
  entraRoles: string[];
  mappedRoles: string[];
  entraGroups: string[];
  mfaVerified: boolean;
  amr: string[];
  authenticatedAt: string;
  expiresAt: string;
}

export type VerifiedEntraSessionPayload = EntraSessionPayload & {
  readonly tenantId: string;
  readonly [VERIFIED_ENTRA_SESSION_BRAND]: true;
};

function markAsVerifiedEntraSession(
  session: EntraSessionPayload,
): VerifiedEntraSessionPayload {
  Object.defineProperty(session, VERIFIED_ENTRA_SESSION_RUNTIME_SYMBOL, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  verifiedEntraSessionPayloads.add(session);
  return session as VerifiedEntraSessionPayload;
}

export function isVerifiedEntraSessionPayload(
  session: unknown,
): session is VerifiedEntraSessionPayload {
  return Boolean(
    session &&
      typeof session === 'object' &&
      verifiedEntraSessionPayloads.has(session) &&
      (session as Record<symbol, unknown>)[
        VERIFIED_ENTRA_SESSION_RUNTIME_SYMBOL
      ] === true,
  );
}

export interface EntraEnvStatus {
  configured: boolean;
  clientId: string | null;
  tenantId: string | null;
  redirectUri: string;
  missingOrPlaceholderVars: string[];
}

interface PkceCookiePayload {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  issuedAt: number;
}

interface JwkKey {
  kid?: string;
  kty: string;
  use?: string;
  n?: string;
  e?: string;
  x5c?: string[];
  alg?: string;
}

let cachedJwks: { tenantId: string; fetchedAt: number; keys: JwkKey[] } | null = null;
const JWKS_CACHE_TTL_MS = 15 * 60 * 1000;
let testEntraSessionOverride: VerifiedEntraSessionPayload | null | undefined = undefined;

export function clearJwksCache(): void {
  cachedJwks = null;
}

export function setTestEntraSessionOverride(
  session: EntraSessionPayload | null | undefined,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'SECURITY_ERROR: setTestEntraSessionOverride is only permitted in test environments.',
    );
  }
  if (session === undefined || session === null) {
    testEntraSessionOverride = session;
    return;
  }
  const signed = createSignedEntraSessionCookie(session);
  const verified = verifySignedEntraSessionCookie(signed);
  testEntraSessionOverride = verified;
}

export function shouldUseSecureCookies(): boolean {
  return process.env.NODE_ENV === 'production';
}

function isPlaceholder(val: string | undefined): boolean {
  if (!val) return true;
  const trimmed = val.trim();
  if (!trimmed) return true;
  return trimmed.startsWith('<') && trimmed.endsWith('>');
}

export function getEntraEnvStatus(): EntraEnvStatus {
  const clientId = process.env.ENTRA_CLIENT_ID?.trim();
  const tenantId = process.env.ENTRA_TENANT_ID?.trim();
  const clientSecret = process.env.ENTRA_CLIENT_SECRET?.trim();
  const redirectUri =
    process.env.ENTRA_REDIRECT_URI?.trim() ||
    'http://localhost:3000/api/auth/callback/microsoft-entra-id';

  const missing: string[] = [];
  if (isPlaceholder(clientId)) missing.push('ENTRA_CLIENT_ID');
  if (isPlaceholder(tenantId)) missing.push('ENTRA_TENANT_ID');
  if (isPlaceholder(clientSecret)) missing.push('ENTRA_CLIENT_SECRET');

  return {
    configured: missing.length === 0,
    clientId: isPlaceholder(clientId) ? null : (clientId ?? null),
    tenantId: isPlaceholder(tenantId) ? null : (tenantId ?? null),
    redirectUri,
    missingOrPlaceholderVars: missing,
  };
}

export function getSigningSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (secret && !isPlaceholder(secret)) {
    return secret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_SECRET environment variable is required in production and must not be a placeholder.',
    );
  }
  return crypto
    .createHash('sha256')
    .update('onesquared-cookie-key:dev-local-fallback-signing-key')
    .digest('hex');
}

export function sanitizeReturnToPath(
  returnTo: string | null | undefined,
  baseOrigin = 'http://localhost',
): string {
  if (!returnTo || typeof returnTo !== 'string') return '/';
  const trimmed = returnTo.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return '/';
  }
  try {
    const base = new URL(baseOrigin);
    const resolved = new URL(trimmed, base.origin);
    if (resolved.origin !== base.origin) {
      return '/';
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}

function signPayload(payloadJson: string): string {
  const encoded = Buffer.from(payloadJson, 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

function verifySignedPayload<T>(token: string | undefined): T | null {
  if (!token || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expectedSig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function createPkceChallenge(returnTo = '/'): {
  authorizeUrl: string;
  signedCookieValue: string;
} {
  const status = getEntraEnvStatus();
  if (!status.configured || !status.clientId || !status.tenantId) {
    throw new Error(
      `Microsoft Entra ID environment variables are not fully configured. Check: ${status.missingOrPlaceholderVars.join(', ')}`,
    );
  }

  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  const cookiePayload: PkceCookiePayload = {
    state,
    nonce,
    codeVerifier,
    returnTo: sanitizeReturnToPath(returnTo),
    issuedAt: Date.now(),
  };

  const params = new URLSearchParams({
    client_id: status.clientId,
    response_type: 'code',
    redirect_uri: status.redirectUri,
    response_mode: 'query',
    scope: 'openid profile email User.Read',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });

  const authorizeUrl = `https://login.microsoftonline.com/${encodeURIComponent(status.tenantId)}/oauth2/v2.0/authorize?${params.toString()}`;
  return {
    authorizeUrl,
    signedCookieValue: signPayload(JSON.stringify(cookiePayload)),
  };
}

export function verifyPkceCookie(cookieValue: string | undefined, returnedState: string): PkceCookiePayload {
  const payload = verifySignedPayload<PkceCookiePayload>(cookieValue);
  if (!payload) {
    throw new Error('Invalid or expired OIDC sign-in state cookie. Please try signing in again.');
  }
  if (Date.now() - payload.issuedAt > 10 * 60 * 1000) {
    throw new Error('OIDC sign-in request expired (over 10 minutes old). Please try signing in again.');
  }
  if (payload.state !== returnedState) {
    throw new Error('OIDC state mismatch detected.');
  }
  return payload;
}

async function fetchEntraJwks(tenantId: string): Promise<JwkKey[]> {
  if (
    cachedJwks &&
    cachedJwks.tenantId === tenantId &&
    Date.now() - cachedJwks.fetchedAt < JWKS_CACHE_TTL_MS
  ) {
    return cachedJwks.keys;
  }

  const jwksUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/discovery/v2.0/keys`;
  const res = await fetch(jwksUrl, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch Microsoft Entra JWKS discovery keys (${res.status}).`);
  }
  const data = (await res.json()) as { keys?: JwkKey[] };
  const keys = Array.isArray(data.keys) ? data.keys : [];
  cachedJwks = { tenantId, fetchedAt: Date.now(), keys };
  return keys;
}

export async function verifyEntraJwtSignatureAndClaims(params: {
  idToken: string;
  tenantId: string;
  clientId: string;
  expectedNonce: string;
}): Promise<EntraIdRawTokenClaims & Record<string, unknown>> {
  const { idToken, tenantId, clientId, expectedNonce } = params;
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Microsoft Entra ID token.');
  }
  const [rawHeader, rawPayload, rawSignature] = parts;
  if (!rawHeader || !rawPayload) {
    throw new Error('Malformed Microsoft Entra ID token.');
  }

  let header: { alg?: string; kid?: string; typ?: string };
  try {
    header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8')) as {
      alg?: string;
      kid?: string;
      typ?: string;
    };
  } catch {
    throw new Error('Malformed Microsoft Entra ID token header.');
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error(`Unsupported JWT algorithm (${header.alg ?? 'unknown'}) or missing kid.`);
  }
  if (!rawSignature) {
    throw new Error('Malformed Microsoft Entra ID token signature.');
  }

  const keys = await fetchEntraJwks(tenantId);
  const matchingJwk = keys.find((k) => k.kid === header.kid);
  if (!matchingJwk) {
    throw new Error('No matching Microsoft Entra signing key (kid) found in JWKS.');
  }

  const publicKey = crypto.createPublicKey({
    key: matchingJwk as unknown as crypto.JsonWebKey,
    format: 'jwk',
  });

  const signingInput = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8');
  const signatureBytes = Buffer.from(rawSignature, 'base64url');
  const signatureValid = crypto.verify('RSA-SHA256', signingInput, publicKey, signatureBytes);
  if (!signatureValid) {
    throw new Error('Microsoft Entra ID token cryptographic signature verification failed.');
  }

  let claims: EntraIdRawTokenClaims & Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8')) as EntraIdRawTokenClaims &
      Record<string, unknown>;
  } catch {
    throw new Error('Malformed Microsoft Entra ID token payload.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number') {
    throw new Error('Microsoft Entra ID token is missing required exp claim.');
  }
  if (claims.exp + 60 < nowSec) {
    throw new Error('Microsoft Entra ID token has expired.');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - 60 > nowSec) {
    throw new Error('Microsoft Entra ID token is not yet valid (nbf).');
  }
  if (typeof claims.iat === 'number' && claims.iat - 60 > nowSec) {
    throw new Error('Microsoft Entra ID token issued-at (iat) is in the future.');
  }
  if (claims.aud !== clientId) {
    throw new Error('Microsoft Entra ID token audience (aud) does not match ENTRA_CLIENT_ID.');
  }
  if (typeof claims.tid !== 'string' || !claims.tid.trim() || claims.tid !== tenantId) {
    throw new Error('Microsoft Entra ID token tenant (tid) is missing or does not match ENTRA_TENANT_ID.');
  }
  const expectedIssuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  if (typeof claims.iss !== 'string' || claims.iss !== expectedIssuer) {
    throw new Error(`Unexpected or missing token issuer: ${String(claims.iss ?? 'missing')}`);
  }
  if (typeof claims.nonce !== 'string' || !claims.nonce || claims.nonce !== expectedNonce) {
    throw new Error('Microsoft Entra ID token nonce is missing or does not match.');
  }

  return claims;
}

export async function exchangeCodeForVerifiedEntraClaims(params: {
  code: string;
  codeVerifier: string;
  expectedNonce: string;
}): Promise<{
  rawClaims: EntraIdRawTokenClaims & Record<string, unknown>;
}> {
  const status = getEntraEnvStatus();
  const clientSecret = process.env.ENTRA_CLIENT_SECRET?.trim();
  if (!status.configured || !status.clientId || !status.tenantId || !clientSecret) {
    throw new Error('Microsoft Entra ID environment variables are not configured.');
  }

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(status.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: status.clientId,
    client_secret: clientSecret,
    code: params.code,
    redirect_uri: status.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: params.codeVerifier,
    scope: 'openid profile email User.Read',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    cache: 'no-store',
  });

  const tokenData = (await response.json()) as {
    id_token?: string;
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !tokenData.id_token) {
    const detail = tokenData.error_description || tokenData.error || `HTTP ${response.status}`;
    throw new Error(`Entra token exchange failed: ${detail}`);
  }

  const rawClaims = await verifyEntraJwtSignatureAndClaims({
    idToken: tokenData.id_token,
    tenantId: status.tenantId,
    clientId: status.clientId,
    expectedNonce: params.expectedNonce,
  });

  // Note: In Entra ID v2.0, `amr` (Authentication Methods References) is sometimes emitted on the
  // access_token or v1/v2 payload depending on optionalClaims. If access_token is a readable JWT
  // for this tenant and rawClaims lacks `amr`, inspect access_token's `amr` / `acrs` as a supplement.
  let enrichedClaims: EntraIdRawTokenClaims & Record<string, unknown> = {
    ...rawClaims,
  };
  if (!enrichedClaims.amr && typeof tokenData.access_token === 'string') {
    const atParts = tokenData.access_token.split('.');
    if (atParts.length === 3) {
      try {
        const atPayload = JSON.parse(
          Buffer.from(atParts[1], 'base64url').toString('utf8'),
        ) as Record<string, unknown>;
        if (Array.isArray(atPayload.amr)) {
          enrichedClaims = { ...enrichedClaims, amr: atPayload.amr as string[] };
        }
        if (Array.isArray(atPayload.acrs) && !enrichedClaims.acrs) {
          enrichedClaims = { ...enrichedClaims, acrs: atPayload.acrs as string[] };
        }
      } catch {
        // Ignore opaque Microsoft Graph access tokens
      }
    }
  }

  return { rawClaims: enrichedClaims };
}

export function createSignedEntraSessionCookie(payload: EntraSessionPayload): string {
  return signPayload(JSON.stringify(payload));
}

export function verifySignedEntraSessionCookie(
  rawCookieValue: string | undefined,
): VerifiedEntraSessionPayload | null {
  const session = verifySignedPayload<EntraSessionPayload>(rawCookieValue);
  if (!session) return null;
  if (typeof session.tenantId !== 'string' || !session.tenantId.trim()) {
    return null;
  }
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    return null;
  }
  return markAsVerifiedEntraSession(session);
}

export async function getEntraSession(): Promise<VerifiedEntraSessionPayload | null> {
  if (process.env.NODE_ENV === 'test' && testEntraSessionOverride !== undefined) {
    return testEntraSessionOverride;
  }
  try {
    const jar = await cookies();
    const raw = jar.get(ENTRA_SESSION_COOKIE)?.value;
    return verifySignedEntraSessionCookie(raw);
  } catch {
    return null;
  }
}

export function buildEntraSessionPayload(params: {
  personId: string;
  rawClaims: EntraIdRawTokenClaims & Record<string, unknown>;
  verifiedToken: VerifiedOidcTokenClaims;
  rbacConfig: RbacConfiguration;
}): EntraSessionPayload {
  const { personId, rawClaims, verifiedToken, rbacConfig } = params;
  const email = (
    rawClaims.email ||
    rawClaims.preferred_username ||
    rawClaims.upn ||
    ''
  ).trim();
  const displayName =
    (typeof rawClaims.name === 'string' && rawClaims.name.trim()) ||
    email ||
    'Entra ID User';

  const oid =
    typeof rawClaims.oid === 'string' ? rawClaims.oid.trim() : '';
  if (!oid) {
    throw new Error(
      'ENTRA_CLAIM_ERROR: Microsoft Entra ID token is missing required Object ID (oid) claim.',
    );
  }

  const now = Date.now();
  const expiresAt = new Date(now + 8 * 60 * 60 * 1000).toISOString();

  return {
    personId,
    tenantId: verifiedToken.tenantId,
    oid,
    tid: rawClaims.tid ?? '',
    sub: verifiedToken.sub,
    email,
    displayName,
    entraRoles: Array.isArray(rawClaims.roles) ? [...rawClaims.roles] : [],
    mappedRoles: [...verifiedToken.roles],
    entraGroups: Array.isArray(rawClaims.groups) ? [...rawClaims.groups] : [],
    mfaVerified: isEntraMfaVerified(rawClaims, {
      allowAcrsC1: rbacConfig.identityMapping.allowAcrsC1AsMfa === true,
    }),
    amr: Array.isArray(rawClaims.amr) ? [...rawClaims.amr] : [],
    authenticatedAt: new Date(now).toISOString(),
    expiresAt,
  };
}

export function createVerifiedSessionActorFromEntraSession(
  session: VerifiedEntraSessionPayload,
  overrides?: {
    correlationId?: string;
    untrustedRequestTenantOverride?: string;
  },
): VerifiedSessionActorInput {
  if (!session || !isVerifiedEntraSessionPayload(session)) {
    throw new Error(
      'TENANCY_AUTH_ERROR: Session payload was not produced by verifySignedEntraSessionCookie or getEntraSession.',
    );
  }
  const tenantId = (session.tenantId ?? '').trim();
  if (!tenantId) {
    throw new Error(
      'TENANCY_AUTH_ERROR: Verified OIDC session is missing required tenantId claim.',
    );
  }
  const email = (session.email ?? '').trim();
  if (!email) {
    throw new Error(
      'TENANCY_AUTH_ERROR: Verified OIDC session is missing required email/UPN claim.',
    );
  }
  const oid = (session.oid ?? '').trim();
  if (!oid) {
    throw new Error(
      'TENANCY_AUTH_ERROR: Verified OIDC session is missing required Entra Object ID (oid) claim.',
    );
  }
  return brandVerifiedSessionActor({
    id: session.personId,
    sub: session.sub || session.personId,
    name: session.displayName,
    email,
    upn: email,
    roles: session.mappedRoles,
    groups: session.entraGroups,
    entraObjectId: oid,
    entraTenantId: session.tid,
    mfaVerified: session.mfaVerified,
    tenantId,
    untrustedRequestTenantOverride: overrides?.untrustedRequestTenantOverride,
    correlationId: overrides?.correlationId,
  });
}

export { mapEntraTokenClaimsToVerifiedOidcToken };
