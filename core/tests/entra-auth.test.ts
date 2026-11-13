import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  clearJwksCache,
  createPkceChallenge,
  createSignedEntraSessionCookie,
  createSignInActorFromVerifiedOidcToken,
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
import {
  auditEntriesSince,
  markAuditPosition,
} from '../../src/server/testSupport/auditTestSupport';
import { switchUserAction } from '../../src/app/actions';
import { GET as callbackGet } from '../../src/app/api/auth/callback/microsoft-entra-id/route';
import { GET as logoutGet } from '../../src/app/api/auth/logout/route';
import { POST as extractMatterPost } from '../../src/app/api/matters/extract/route';
import AdminCatchAllPage from '../../src/app/admin/[[...slug]]/page';
import { testDataResetContext } from '../../src/test/testTenantContexts';

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
    preferred_username: 'dafydd.evans@notalawfirm.example',
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
    process.env.PLATFORM_TENANT_PACKAGE_DIR = 'client-not-a-law-firm';
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
      `https://app.notalawfirm.example/api/auth/callback/microsoft-entra-id?code=auth-code-xyz&state=${encodeURIComponent(pkceDecoded.state)}`,
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

  it('validates x-correlation-id and x-request-id headers in the OIDC callback route, replacing unsafe or over-long values while keeping valid ones (R399)', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      let lastCallbackAuditMark = -1;
      const invokeCallbackWithHeaders = async (
        extraHeaders: Record<string, string>,
      ) => {
        lastCallbackAuditMark = await markAuditPosition();
        const { signedCookieValue } = createPkceChallenge('/matters');
        const [encodedPart] = signedCookieValue.split('.');
        const pkceDecoded = JSON.parse(
          Buffer.from(encodedPart, 'base64url').toString('utf8'),
        ) as {
          state: string;
          nonce: string;
          codeVerifier: string;
          returnTo: string;
        };
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
        const req = new NextRequest(
          `https://app.notalawfirm.example/api/auth/callback/microsoft-entra-id?code=auth-code-r399&state=${encodeURIComponent(pkceDecoded.state)}`,
          {
            headers: {
              cookie: `${ENTRA_PKCE_COOKIE}=${signedCookieValue}`,
              ...extraHeaders,
            },
          },
        );
        return callbackGet(req);
      };

      const latestSignInAudit = async () =>
        (await auditEntriesSince(lastCallbackAuditMark)).find(
          (a) =>
            a.field === 'Entra ID OIDC Sign-In' ||
            a.field === 'Entra ID OIDC Provisioned Employee',
        );

      // 1. Header containing ';' (audit field spoofing attempt) is replaced by a generated UUID and excluded from audit text
      const semicolonInjected = 'x; roles=admin; mfa=true';
      const semicolonRes = await invokeCallbackWithHeaders({
        'x-correlation-id': semicolonInjected,
      });
      expect(semicolonRes.status).toBe(307);
      const semicolonAudit = await latestSignInAudit();
      expect(semicolonAudit).toBeDefined();
      expect(semicolonAudit?.newValue).toMatch(
        /correlationId=corr-rte-[0-9a-f-]{36}$/i,
      );
      expect(semicolonAudit?.newValue).not.toContain(semicolonInjected);
      expect(semicolonAudit?.newValue).not.toContain('roles=admin; mfa=true');

      // 2. Header containing a space is replaced by a generated UUID and excluded from audit text
      const spaceInjected = 'bad corr id with spaces';
      const spaceRes = await invokeCallbackWithHeaders({
        'x-correlation-id': spaceInjected,
      });
      expect(spaceRes.status).toBe(307);
      const spaceAudit = await latestSignInAudit();
      expect(spaceAudit?.newValue).toMatch(
        /correlationId=corr-rte-[0-9a-f-]{36}$/i,
      );
      expect(spaceAudit?.newValue).not.toContain(spaceInjected);

      // 3. Header longer than 128 characters (and unsafe x-request-id fallback) is replaced by a generated UUID
      const overlongHeader = 'a'.repeat(129);
      const overlongRes = await invokeCallbackWithHeaders({
        'x-correlation-id': overlongHeader,
      });
      expect(overlongRes.status).toBe(307);
      const overlongAudit = await latestSignInAudit();
      expect(overlongAudit?.newValue).toMatch(
        /correlationId=corr-rte-[0-9a-f-]{36}$/i,
      );
      expect(overlongAudit?.newValue).not.toContain(overlongHeader);

      const unsafeRequestId = 'req-id; injected=true';
      const unsafeReqIdRes = await invokeCallbackWithHeaders({
        'x-request-id': unsafeRequestId,
      });
      expect(unsafeReqIdRes.status).toBe(307);
      const unsafeReqIdAudit = await latestSignInAudit();
      expect(unsafeReqIdAudit?.newValue).toMatch(
        /correlationId=corr-rte-[0-9a-f-]{36}$/i,
      );
      expect(unsafeReqIdAudit?.newValue).not.toContain(unsafeRequestId);

      // 4. Valid headers matching ^[A-Za-z0-9._:-]{1,128}$ (both x-correlation-id and 128-char x-request-id) are kept
      const validHeader = 'client-corr_01:ok-2';
      const validRes = await invokeCallbackWithHeaders({
        'x-correlation-id': validHeader,
      });
      expect(validRes.status).toBe(307);
      const validAudit = await latestSignInAudit();
      expect(validAudit?.newValue).toContain(`correlationId=${validHeader}`);

      const maxLenValidHeader = 'v'.repeat(128);
      const maxLenRes = await invokeCallbackWithHeaders({
        'x-request-id': maxLenValidHeader,
      });
      expect(maxLenRes.status).toBe(307);
      const maxLenAudit = await latestSignInAudit();
      expect(maxLenAudit?.newValue).toContain(
        `correlationId=${maxLenValidHeader}`,
      );
    } finally {
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('rejects a tampered session cookie and throws in production when AUTH_SECRET is missing (R56, R59)', () => {
    const validCookie = createSignedEntraSessionCookie({
      personId: 'P-000002',
      tenantId: 'not-a-law-firm',
      oid: '00000000-0000-4000-8000-000000000002',
      tid: TEST_TENANT_ID,
      sub: 'P-000002',
      email: 'dafydd.evans@notalawfirm.example',
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
        email: 'admin@notalawfirm.example',
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
        email: 'dafydd.evans@notalawfirm.example',
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
    await resetAllDemoData('P-000001', testDataResetContext());

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
      tenantId: 'not-a-law-firm',
      oid: '00000000-0000-4000-8000-000000000002',
      tid: TEST_TENANT_ID,
      sub: 'P-000002',
      email: 'dafydd.evans@notalawfirm.example',
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
    await saveHomePagesConfig({ firmSettings: { demoMode: false } }, 'P-000001');
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

    // S0-01: POST /api/matters/extract with apiKeyOverride and no server ANTHROPIC_API_KEY returns 503 and never calls api.anthropic.com
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const anthropicCalls: string[] = [];
    try {
      delete process.env.ANTHROPIC_API_KEY;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = typeof input === 'string' ? input : input.toString();
        if (urlStr.includes('api.anthropic.com')) {
          anthropicCalls.push(urlStr);
        }
        throw new Error(`Unexpected outbound fetch: ${urlStr}`);
      }) as unknown as typeof fetch;

      const overrideReq = new NextRequest(
        'http://localhost:3000/api/matters/extract',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            apiKeyOverride: 'test-anthropic-key-placeholder',
            documents: [
              {
                id: 'doc-1',
                name: 'instruction.txt',
                kind: 'email',
                content: 'Please open a new matter.',
              },
            ],
          }),
        },
      );
      const overrideRes = await extractMatterPost(overrideReq);
      expect(overrideRes.status).toBe(503);
      const overrideBody = (await overrideRes.json()) as {
        error?: string;
        message?: string;
      };
      expect(overrideBody.error).toBe(
        "AI extraction isn't configured. Ask your administrator.",
      );
      expect(anthropicCalls).toEqual([]);

      process.env.ANTHROPIC_API_KEY =
        '@Microsoft.KeyVault(SecretUri=https://kv-test.vault.azure.net/secrets/anthropic-api-key/)';
      const kvExtractReq = new NextRequest(
        'http://localhost:3000/api/matters/extract',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            apiKeyOverride: 'test-anthropic-key-placeholder',
            documents: [
              {
                id: 'doc-1',
                name: 'instruction.txt',
                kind: 'email',
                content: 'Please open a new matter.',
              },
            ],
          }),
        },
      );
      const kvExtractRes = await extractMatterPost(kvExtractReq);
      expect(kvExtractRes.status).toBe(503);
      expect(anthropicCalls).toEqual([]);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      }
    }

    await resetAllDemoData('P-000001', testDataResetContext());
  });

  it('R462: createSignInActorFromVerifiedOidcToken asserts __verifiedByOidcMiddleware === true and tenantId matches the active tenant', () => {
    expect(() =>
      createSignInActorFromVerifiedOidcToken(
        {
          // @ts-expect-error testing unbranded token rejection
          __verifiedByOidcMiddleware: false,
          sub: 'P-000001',
          tenantId: 'not-a-law-firm',
          name: 'Carys Hughes',
          email: 'carys.hughes@notalawfirm.example',
          roles: ['admin'],
          mfaVerified: true,
        },
        {
          oid: '00000000-0000-4000-8000-000000000001',
          email: 'carys.hughes@notalawfirm.example',
        },
      ),
    ).toThrow(/TENANCY_AUTH_ERROR.*__verifiedByOidcMiddleware/);

    expect(() =>
      createSignInActorFromVerifiedOidcToken(
        {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000001',
          tenantId: 'other-tenant-id',
          name: 'Carys Hughes',
          email: 'carys.hughes@notalawfirm.example',
          roles: ['admin'],
          mfaVerified: true,
        },
        {
          oid: '00000000-0000-4000-8000-000000000001',
          email: 'carys.hughes@notalawfirm.example',
        },
      ),
    ).toThrow(/TENANCY_AUTH_ERROR.*does not match active tenant/);

    const validActor = createSignInActorFromVerifiedOidcToken(
      {
        __verifiedByOidcMiddleware: true,
        sub: 'P-000001',
        tenantId: 'not-a-law-firm',
        name: 'Carys Hughes',
        email: 'carys.hughes@notalawfirm.example',
        roles: ['admin'],
        mfaVerified: true,
      },
      {
        oid: '00000000-0000-4000-8000-000000000001',
        email: 'carys.hughes@notalawfirm.example',
        correlationId: 'corr-r462',
      },
    );
    expect(validActor.tenantId).toBe('not-a-law-firm');
    expect(validActor.sub).toBe('P-000001');
  });
});
