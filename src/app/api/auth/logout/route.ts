import { NextRequest, NextResponse } from 'next/server';
import { ENTRA_PKCE_COOKIE, ENTRA_SESSION_COOKIE } from '@/server/entraAuth';
import { USER_COOKIE } from '@/server/services';

function buildLogoutResponse(request: NextRequest) {
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
