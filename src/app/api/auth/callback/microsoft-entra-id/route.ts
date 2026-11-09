import { NextRequest, NextResponse } from 'next/server';
import { guardedRoute } from '@/server/authorize';
import { resolveRequestCorrelationId } from '@/server/correlationId';
import {
  buildEntraSessionPayload,
  createSignedEntraSessionCookie,
  ENTRA_PKCE_COOKIE,
  ENTRA_SESSION_COOKIE,
  exchangeCodeForVerifiedEntraClaims,
  sanitizeReturnToPath,
  shouldUseSecureCookies,
  verifyPkceCookie,
} from '@/server/entraAuth';
import { resolveOrProvisionEntraEmployee } from '@/server/services';

export const GET = guardedRoute(
  'GET /api/auth/callback/microsoft-entra-id',
  async (request: NextRequest) => {
    const searchParams = request.nextUrl.searchParams;
    const oauthError = searchParams.get('error');
    const oauthErrorDesc = searchParams.get('error_description');

    if (oauthError) {
      const errUrl = new URL('/', request.url);
      errUrl.searchParams.set('authError', oauthErrorDesc || oauthError);
      return NextResponse.redirect(errUrl);
    }

    const code = searchParams.get('code');
    const state = searchParams.get('state');
    if (!code || !state) {
      const errUrl = new URL('/', request.url);
      errUrl.searchParams.set('authError', 'Missing authorization code or state from Microsoft Entra ID.');
      return NextResponse.redirect(errUrl);
    }

    try {
      const pkceCookieVal = request.cookies.get(ENTRA_PKCE_COOKIE)?.value;
      const pkce = verifyPkceCookie(pkceCookieVal, state);

      const { rawClaims } = await exchangeCodeForVerifiedEntraClaims({
        code,
        codeVerifier: pkce.codeVerifier,
        expectedNonce: pkce.nonce,
      });

      const requestCorrelationId = resolveRequestCorrelationId(
        request.headers.get('x-correlation-id') ??
          request.headers.get('x-request-id'),
        'corr-rte',
      );
      const { person, verifiedToken, rbacConfig } =
        resolveOrProvisionEntraEmployee(rawClaims, {
          correlationId: requestCorrelationId,
        });

      const sessionPayload = buildEntraSessionPayload({
        personId: person.id,
        rawClaims,
        verifiedToken,
        rbacConfig,
      });

      const signedSession = createSignedEntraSessionCookie(sessionPayload);

      const reqOrigin = new URL(request.url).origin;
      const destPath = sanitizeReturnToPath(pkce.returnTo, reqOrigin);
      const destUrl = new URL(destPath, reqOrigin);
      if (destUrl.origin !== reqOrigin) {
        throw new Error('Cross-origin redirect blocked.');
      }
      destUrl.searchParams.set('authSuccess', '1');

      const response = NextResponse.redirect(destUrl);
      response.cookies.delete(ENTRA_PKCE_COOKIE);
      response.cookies.set(ENTRA_SESSION_COOKIE, signedSession, {
        httpOnly: true,
        secure: shouldUseSecureCookies(),
        sameSite: 'lax',
        path: '/',
        maxAge: 8 * 60 * 60,
      });
      return response;
    } catch (err) {
      const errUrl = new URL('/', request.url);
      errUrl.searchParams.set(
        'authError',
        err instanceof Error ? err.message : 'Entra ID authentication callback failed.',
      );
      const response = NextResponse.redirect(errUrl);
      response.cookies.delete(ENTRA_PKCE_COOKIE);
      return response;
    }
  },
);
