import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { guardedRoute } from '@/server/authorize';
import { checkTenantReadinessWithCache } from '@/server/healthReadiness';

export const dynamic = 'force-dynamic';

const SAFE_CORRELATION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const GET = guardedRoute(
  'GET /api/health/ready',
  async (req: Request): Promise<Response> => {
    const headerCorrId = req.headers.get('x-correlation-id')?.trim() ?? '';
    const correlationId = SAFE_CORRELATION_ID_RE.test(headerCorrId)
      ? headerCorrId
      : randomUUID();
    const result = await checkTenantReadinessWithCache({ correlationId });
    return NextResponse.json(
      { status: result.ready ? 'ready' : 'not_ready' },
      {
        status: result.status,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  },
);
