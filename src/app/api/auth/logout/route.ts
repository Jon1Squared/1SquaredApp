import { NextRequest, NextResponse } from 'next/server';
import { clearActiveSessionTokenRoles } from '@/domain/rbac';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import {
  ENTRA_PKCE_COOKIE,
  ENTRA_SESSION_COOKIE,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { USER_COOKIE } from '@/server/services';

function buildLogoutResponse(request: NextRequest) {
  const rawSessionCookie = request.cookies.get(ENTRA_SESSION_COOKIE)?.value;
  const verified = verifySignedEntraSessionCookie(rawSessionCookie);
  if (verified?.personId) {
    clearActiveSessionTokenRoles(
      verified.personId,
      verified.tenantId || getActiveTenantConfiguration().tenantId,
    );
  }
  const destUrl = new URL('/?signedOut=1', request.url);
  const response = NextResponse.redirect(destUrl, { status: 303 });
  response.cookies.delete(ENTRA_SESSION_COOKIE);
  response.cookies.delete(ENTRA_PKCE_COOKIE);
  response.cookies.delete(USER_COOKIE);
  return response;
}

export async function GET() {
  return NextResponse.json(
    { error: 'Method Not Allowed. Use POST /api/auth/logout to sign out.' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export async function POST(request: NextRequest) {
  return buildLogoutResponse(request);
}
