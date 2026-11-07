import { NextRequest, NextResponse } from 'next/server';
import { guardedRoute } from '@/server/authorize';
import {
  createPkceChallenge,
  ENTRA_PKCE_COOKIE,
  getEntraEnvStatus,
  sanitizeReturnToPath,
  shouldUseSecureCookies,
} from '@/server/entraAuth';

export const GET = guardedRoute(
  'GET /api/auth/login',
  async (request: NextRequest) => {
    const rawReturnTo = request.nextUrl.searchParams.get('returnTo') || '/';
    const returnTo = sanitizeReturnToPath(rawReturnTo, new URL(request.url).origin);
    const status = getEntraEnvStatus();

    if (!status.configured) {
      const errUrl = new URL('/', request.url);
      errUrl.searchParams.set(
        'authError',
        `Please configure ${status.missingOrPlaceholderVars.join(', ')} in .env.local and restart the dev server.`,
      );
      return NextResponse.redirect(errUrl);
    }

    try {
      const { authorizeUrl, signedCookieValue } = createPkceChallenge(returnTo);
      const response = NextResponse.redirect(authorizeUrl);
      response.cookies.set(ENTRA_PKCE_COOKIE, signedCookieValue, {
        httpOnly: true,
        secure: shouldUseSecureCookies(),
        sameSite: 'lax',
        path: '/',
        maxAge: 600,
      });
      return response;
    } catch (err) {
      const errUrl = new URL('/', request.url);
      errUrl.searchParams.set(
        'authError',
        err instanceof Error ? err.message : 'Failed to start Entra ID sign-in.',
      );
      return NextResponse.redirect(errUrl);
    }
  },
);
