import { NextResponse } from 'next/server';
import { guardedRoute } from '@/server/authorize';

export const dynamic = 'force-dynamic';

export const GET = guardedRoute(
  'GET /api/health/live',
  async (): Promise<Response> => {
    return NextResponse.json(
      { status: 'live' },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  },
);
