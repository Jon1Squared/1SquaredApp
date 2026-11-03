import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  clearJwksCache,
  createPkceChallenge,
  createSignedEntraSessionCookie,
  ENTRA_PKCE_COOKIE,
  ENTRA_SESSION_COOKIE,
  exchangeCodeForVerifiedEntraClaims,
  getEntraSession,
  setTestEntraSessionOverride,
  shouldUseSecureCookies,
  verifyEntraJwtSignatureAndClaims,
  verifyPkceCookie,
  verifySignedEntraSessionCookie,
} from '../../src/server/entraAuth';
import {
  getCurrentUserId,
  requireAuthenticatedActor,
  resetAllDemoData,
  saveHomePagesConfig,
} from '../../src/server/services';
import { switchUserAction } from '../../src/app/actions';
import { GET as callbackGet } from '../../src/app/api/auth/callback/microsoft-entra-id/route';
import { GET as logoutGet } from '../../src/app/api/auth/logout/route';
import { POST as extractMatterPost } from '../../src/app/api/matters/extract/route';
import AdminCatchAllPage from '../../src/app/admin/[[...slug]]/page';

const TEST_TENANT_ID = '00000000-0000-4000-8000-000000000099';
const OTHER_TENANT_ID = '00000000-0000-4000-8000-000000000888';
const TEST_CLIENT_ID = '00000000-0000-4000-8000-000000000111';
const TEST_KID = 'test-signing-key-1';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const { privateKey: wrongPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const publicJwk = {
  ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
  kid: TEST_KID,
  use: 'sig',
  alg: 'RS256',
};

function signTestJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signingKey: crypto.KeyObject = privateKey,
): string {
  const rawHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const rawPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${rawHeader}.${rawPayload}`;
  if (header.alg === 'none') {
    return `${signingInput}.`;
  }
  if (header.alg === 'HS256') {
    const hmac = crypto
      .createHmac('sha256', 'hs256-secret')
      .update(signingInput)
      .digest('base64url');
    return `${signingInput}.${hmac}`;
  }
  const sig = crypto
    .sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), signingKey)
    .toString('base64url');
  return `${signingInput}.${sig}`;
}

function makeValidPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    aud: TEST_CLIENT_ID,
    tid: TEST_TENANT_ID,
    iss: `https://login.microsoftonline.com/${TEST_TENANT_ID}/v2.0`,
    sub: 'sub-user-1',
    oid: '00000000-0000-4000-8000-000000000222',
    nonce: 'expected-nonce-123',
    iat: nowSec - 10,
    nbf: nowSec - 10,
    exp: nowSec + 3600,
    preferred_username: 'dafydd.evans@notalawfirm.co.uk',
    roles: ['1Squared.FeeEarner'],
    amr: ['pwd', 'mfa'],
    ...overrides,
  };
}

describe('Microsoft Entra ID OIDC Authentication, JWT Verification & Cookie Security (R50-R59, R62, R73)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearJwksCache();
    setTestEntraSessionOverride(undefined);
    process.env.ENTRA_CLIENT_ID = TEST_CLIENT_ID;
    process.env.ENTRA_TENANT_ID = TEST_TENANT_ID;
    process.env.ENTRA_CLIENT_SECRET = 'test-dummy-secret-not-real';
    process.env.AUTH_SECRET = 'test-auth-secret-32-bytes-minimum-length';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ keys: [publicJwk] }),
      }),
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setTestEntraSessionOverride(undefined);
    vi.unstubAllGlobals();
  });

  it('accepts a validly signed RS256 Entra ID token with matching claims', async () => {
    const token = signTestJwt(
      { alg: 'RS256', kid: TEST_KID, typ: 'JWT' },
      makeValidPayload(),
    );
    const claims = await verifyEntraJwtSignatureAndClaims({
      idToken: token,
      tenantId: TEST_TENANT_ID,
      clientId: TEST_CLIENT_ID,
      expectedNonce: 'expected-nonce-123',
    });
    expect(claims.oid).toBe('00000000-0000-4000-8000-000000000222');
    expect(claims.tid).toBe(TEST_TENANT_ID);
  });

  it('rejects a token with a bad RS256 cryptographic signature', async () => {
    const token = signTestJwt(
      { alg: 'RS256', kid: TEST_KID, typ: 'JWT' },
      makeValidPayload(),
      wrongPrivateKey,
    );
    await expect(
      verifyEntraJwtSignatureAndClaims({
        idToken: token,
        tenantId: TEST_TENANT_ID,
        clientId: TEST_CLIENT_ID,
        expectedNonce: 'expected-nonce-123',
      }),
    ).rejects.toThrow(/signature verification failed/i);
  });

  it('rejects tokens with alg: none or HS256', async () => {
    const noneToken = signTestJwt(
      { alg: 'none', kid: TEST_KID, typ: 'JWT' },
      makeValidPayload(),
    );
    await expect(
      verifyEntraJwtSignatureAndClaims({
        idToken: noneToken,
        tenantId: TEST_TENANT_ID,
        clientId: TEST_CLIENT_ID,
        expectedNonce: 'expected-nonce-123',
      }),
    ).rejects.toThrow(/Unsupported JWT algorithm/i);

    const hsToken = signTestJwt(
      { alg: 'HS256', kid: TEST_KID, typ: 'JWT' },
      makeValidPayload(),
    );
    await expect(
      verifyEntraJwtSignatureAndClaims({
        idToken: hsToken,
        tenantId: TEST_TENANT_ID,
        clientId: TEST_CLIENT_ID,
        expectedNonce: 'expected-nonce-123',
      }),
    ).rejects.toThrow(/Unsupported JWT algorithm/i);
  });

  it('rejects a token with an unknown kid not present in JWKS', async () => {
    const token = signTestJwt(
      { alg: 'RS256', kid: 'unknown-kid-999', typ: 'JWT' },
      makeValidPayload(),
    );
    await expect(
      verifyEntraJwtSignatureAndClaims({
        idToken: token,
        tenantId: TEST_TENANT_ID,
        clientId: TEST_CLIENT_ID,
        expectedNonce: 'expected-nonce-123',
      }),
    ).rejects.toThrow(/No matching Microsoft Entra signing key/i);
  });

  it('rejects a token with the wrong audience (aud)', async () => {
    const token = signTestJwt(
      { alg: 'RS256', kid: TEST_KID, typ: 'JWT' },
      makeValidPayload({ aud: 'wrong-client-id' }),
    );
    await expect(
      verifyEntraJwtSignatureAndClaims({
        idToken: token,
        tenantId: TEST_TENANT_ID,
        clientId: TEST_CLIENT_ID,
        expectedNonce: 'expected-nonce-123',
      }),
    ).rejects.toThrow(/audience \(aud\) does not match/i);
  });

  it('rejects a validly signed token with tid/iss from another Entra tenant or missing tid (R56, R57)', async () => {
    const foreignTenantToken = signTestJwt(
      { alg: 'RS256', kid: TEST_KID, typ: 'JWT' },
      makeValidPayload({
        tid: OTHER_TENANT_ID,
        iss: `https://login.microsoftonline.com/${OTHER_TENANT_ID}/v2.0`,
      }),
    );
    await expect(
      verifyEntraJwtSignatureAndClaims({
        idToken: foreignTenantToken,
        tenantId: TEST_TENANT_ID,
        clientId: TEST_CLIENT_ID,
        expectedNonce: 'expected-nonce-123',
      }),
    ).rejects.toThrow(/tenant \(tid\) is missing or does not match/i);

    const missingTidPayload = makeValidPayload();
    delete missingTidPayload.tid;
    const missingTidToken = signTestJwt(
      { alg: 'RS256', kid: TEST_KID, typ: 'JWT' },
      missingTidPayload,
    );
    await expect(
      verifyEntraJwtSignatureAndClaims({
        idToken: missingTidToken,
        tenantId: TEST_TENANT_ID,
        clientId: TEST_CLIENT_ID,
        expectedNonce: 'expected-nonce-123',
      }),
    ).rejects.toThrow(/tenant \(tid\) is missing or does not match/i);
  });

  it('rejects a token with missing or mismatched nonce (R56, R57)', async () => {
    const mismatchedNonceToken = signTestJwt(
      { alg: 'RS256', kid: TEST_KID, typ: 'JWT' },
      makeValidPayload({ nonce: 'wrong-nonce' }),
    );
    await expect(
      verifyEntraJwtSignatureAndClaims({
        idToken: mismatchedNonceToken,
        tenantId: TEST_TENANT_ID,
        clientId: TEST_CLIENT_ID,
        expectedNonce: 'expected-nonce-123',
      }),
    ).rejects.toThrow(/nonce is missing or does not match/i);

    const noNoncePayload = makeValidPayload();
    delete noNoncePayload.nonce;
    const noNonceToken = signTestJwt(
      { alg: 'RS256', kid: TEST_KID, typ: 'JWT' },
      noNoncePayload,
    );
    await expect(
      verifyEntraJwtSignatureAndClaims({
        idToken: noNonceToken,
        tenantId: TEST_TENANT_ID,
        clientId: TEST_CLIENT_ID,
        expectedNonce: 'expected-nonce-123',
      }),
    ).rejects.toThrow(/nonce is missing or does not match/i);
  });

  it('rejects an expired exp or future nbf/iat beyond clock skew (R56, R57)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expiredToken = signTestJwt(
      { alg: 'RS256', kid: TEST_KID, typ: 'JWT' },
      makeValidPayload({ exp: nowSec - 300 }),
    );
    await expect(
      verifyEntraJwtSignatureAndClaims({
        idToken: expiredToken,
        tenantId: TEST_TENANT_ID,
        clientId: TEST_CLIENT_ID,
        expectedNonce: 'expected-nonce-123',
      }),
    ).rejects.toThrow(/expired/i);

    const futureNbfToken = signTestJwt(
      { alg: 'RS256', kid: TEST_KID, typ: 'JWT' },
      makeValidPayload({ nbf: nowSec + 300 }),
    );
    await expect(
      verifyEntraJwtSignatureAndClaims({
        idToken: futureNbfToken,
        tenantId: TEST_TENANT_ID,
        clientId: TEST_CLIENT_ID,
        expectedNonce: 'expected-nonce-123',
      }),
    ).rejects.toThrow(/not yet valid/i);

    const futureIatToken = signTestJwt(
      { alg: 'RS256', kid: TEST_KID, typ: 'JWT' },
      makeValidPayload({ iat: nowSec + 300 }),
    );
    await expect(
      verifyEntraJwtSignatureAndClaims({
        idToken: futureIatToken,
        tenantId: TEST_TENANT_ID,
        clientId: TEST_CLIENT_ID,
        expectedNonce: 'expected-nonce-123',
      }),
    ).rejects.toThrow(/issued-at \(iat\) is in the future/i);
  });

  it('rejects PKCE state mismatch, expiry, and open-redirect returnTo values (R56, R58)', () => {
    const { signedCookieValue } = createPkceChallenge('//evil.example/phish');
    const [encodedPart] = signedCookieValue.split('.');
    const decoded = JSON.parse(
      Buffer.from(encodedPart, 'base64url').toString('utf8'),
    ) as { state: string; nonce: string; codeVerifier: string; returnTo: string; issuedAt: number };

    // R58: //evil.example is normalised to '/'
    expect(decoded.returnTo).toBe('/');

    // State mismatch rejected
    expect(() => verifyPkceCookie(signedCookieValue, 'wrong-state')).toThrow(
      /state mismatch/i,
    );

    // Tampered PKCE cookie rejected
    const tamperedCookie = `${Buffer.from(
      JSON.stringify({ ...decoded, returnTo: 'https://evil.example' }),
      'utf8',
    ).toString('base64url')}.${signedCookieValue.split('.')[1]}`;
    expect(() => verifyPkceCookie(tamperedCookie, decoded.state)).toThrow(
      /Invalid or expired OIDC sign-in state cookie/i,
    );

    // Expired PKCE cookie (>10 minutes old) rejected even with valid signature
    const expiredPayloadEncoded = Buffer.from(
      JSON.stringify({ ...decoded, issuedAt: Date.now() - 11 * 60 * 1000 }),
      'utf8',
    ).toString('base64url');
    const expiredSig = crypto
      .createHmac('sha256', process.env.AUTH_SECRET!)
      .update(expiredPayloadEncoded)
      .digest('base64url');
    expect(() =>
      verifyPkceCookie(`${expiredPayloadEncoded}.${expiredSig}`, decoded.state),
    ).toThrow(/OIDC sign-in request expired/i);
  });

  it('exchanges an OIDC code for verified claims and sets a Secure signed session cookie in the callback route (R56, R59)', async () => {
    const { signedCookieValue } = createPkceChallenge('/matters');
    const [encodedPart] = signedCookieValue.split('.');
    const pkceDecoded = JSON.parse(
      Buffer.from(encodedPart, 'base64url').toString('utf8'),
    ) as { state: string; nonce: string; codeVerifier: string; returnTo: string };

    const validIdToken = signTestJwt(
      { alg: 'RS256', kid: TEST_KID, typ: 'JWT' },
      makeValidPayload({ nonce: pkceDecoded.nonce }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/oauth2/v2.0/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id_token: validIdToken,
              access_token: 'opaque-access-token',
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ keys: [publicJwk] }),
        };
      }),
    );

    const exchanged = await exchangeCodeForVerifiedEntraClaims({
      code: 'auth-code-xyz',
      codeVerifier: pkceDecoded.codeVerifier,
      expectedNonce: pkceDecoded.nonce,
    });
    expect(exchanged.rawClaims.oid).toBe('00000000-0000-4000-8000-000000000222');

    // R59: Verify callback route sets Secure on onesquared_entra_session in production
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    expect(shouldUseSecureCookies()).toBe(true);

    const callbackReq = new NextRequest(
      `https://app.notalawfirm.co.uk/api/auth/callback/microsoft-entra-id?code=auth-code-xyz&state=${encodeURIComponent(pkceDecoded.state)}`,
      {
        headers: {
          cookie: `${ENTRA_PKCE_COOKIE}=${signedCookieValue}`,
        },
      },
    );
    const callbackRes = await callbackGet(callbackReq);
    expect(callbackRes.status).toBe(307);
    const setCookieHeader = callbackRes.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain(`${ENTRA_SESSION_COOKIE}=`);
    expect(setCookieHeader.toLowerCase()).toContain('secure');
    expect(setCookieHeader.toLowerCase()).toContain('httponly');

    const sessionCookieVal = callbackRes.cookies.get(ENTRA_SESSION_COOKIE)?.value;
    const verifiedSession = verifySignedEntraSessionCookie(sessionCookieVal);
    expect(verifiedSession).not.toBeNull();
    expect(verifiedSession?.oid).toBe('00000000-0000-4000-8000-000000000222');
  });

  it('rejects a tampered session cookie and throws in production when AUTH_SECRET is missing (R56, R59)', () => {
    const validCookie = createSignedEntraSessionCookie({
      personId: 'P-000002',
      oid: '00000000-0000-4000-8000-000000000002',
      tid: TEST_TENANT_ID,
      sub: 'P-000002',
      email: 'dafydd.evans@notalawfirm.co.uk',
      displayName: 'Dafydd Evans',
      entraRoles: [],
      mappedRoles: ['fee_earner'],
      entraGroups: [],
      mfaVerified: true,
      amr: ['pwd', 'mfa'],
      authenticatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(verifySignedEntraSessionCookie(validCookie)?.personId).toBe('P-000002');

    // Tamper payload to P-000001 (admin) keeping signature
    const [, sig] = validCookie.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        personId: 'P-000001',
        oid: '00000000-0000-4000-8000-000000000002',
        tid: TEST_TENANT_ID,
        sub: 'P-000001',
        email: 'admin@notalawfirm.co.uk',
        displayName: 'Forged Admin',
        entraRoles: ['1Squared.Admin'],
        mappedRoles: ['admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
      'utf8',
    ).toString('base64url');
    expect(verifySignedEntraSessionCookie(`${forgedPayload}.${sig}`)).toBeNull();

    // R59: Production without AUTH_SECRET throws
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    delete process.env.AUTH_SECRET;
    expect(() =>
      createSignedEntraSessionCookie({
        personId: 'P-000002',
        oid: '00000000-0000-4000-8000-000000000002',
        tid: TEST_TENANT_ID,
        sub: 'P-000002',
        email: 'dafydd.evans@notalawfirm.co.uk',
        displayName: 'Dafydd Evans',
        entraRoles: [],
        mappedRoles: ['fee_earner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    ).toThrow(/AUTH_SECRET/i);
  });

  it('prevents the onesquared_user cookie escalation attack, enforces requireAuthenticatedActor, and blocks GET logout & non-admin /admin (R50, R51, R62, R73)', async () => {
    resetAllDemoData('P-000001');

    // R51: getCurrentUserId() with no session throws UNAUTHENTICATED
    setTestEntraSessionOverride(null);
    await expect(getCurrentUserId()).rejects.toThrow(/Authentication is required/i);
    await expect(requireAuthenticatedActor()).rejects.toThrow(
      /Authentication is required/i,
    );

    // R51 & R56: Unauthenticated POST /api/matters/extract returns 401 even if a forged onesquared_user=P-000001 cookie is sent
    const unauthExtractReq = new NextRequest(
      'http://localhost:3000/api/matters/extract',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'onesquared_user=P-000001',
        },
        body: JSON.stringify({}),
      },
    );
    const unauthExtractRes = await extractMatterPost(unauthExtractReq);
    expect(unauthExtractRes.status).toBe(401);

    // Without test override, getEntraSession() returns null when no signed onesquared_entra_session cookie exists
    setTestEntraSessionOverride(undefined);
    expect(await getEntraSession()).toBeNull();

    // R50: Active Entra session for P-000002 always resolves to P-000002
    setTestEntraSessionOverride({
      personId: 'P-000002',
      oid: '00000000-0000-4000-8000-000000000002',
      tid: TEST_TENANT_ID,
      sub: 'P-000002',
      email: 'dafydd.evans@notalawfirm.co.uk',
      displayName: 'Dafydd Evans',
      entraRoles: [],
      mappedRoles: ['fee_earner'],
      entraGroups: [],
      mfaVerified: true,
      amr: ['pwd', 'mfa'],
      authenticatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(await getCurrentUserId()).toBe('P-000002');

    // R50: switchUserAction as a non-admin with demo mode off is rejected
    saveHomePagesConfig({ firmSettings: { demoMode: false } }, 'P-000001');
    await expect(switchUserAction('P-000001')).rejects.toThrow(
      /Demo Mode is enabled/i,
    );

    // R62: Rendering /admin as a fee earner redirects
    await expect(
      AdminCatchAllPage({
        params: Promise.resolve({ slug: ['rbac-and-entra'] }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // R73: GET /api/auth/logout returns 405
    const logoutRes = await logoutGet();
    expect(logoutRes.status).toBe(405);

    resetAllDemoData('P-000001');
  });
});
