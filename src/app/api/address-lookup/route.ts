import { NextResponse } from 'next/server';
import { AuthorisationError } from '@/domain/rbac';
import {
  resolveAddress,
  searchAddresses,
} from '@/server/addressLookupService';
import { guardedRoute } from '@/server/authorize';
import { resolveRequestCorrelationId } from '@/server/correlationId';
import { withAuthenticatedActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export const POST = guardedRoute(
  'POST /api/address-lookup',
  async (req: Request): Promise<Response> => {
    try {
      return await withAuthenticatedActor(async (actor) => {
        const logContext = {
          tenantId: actor.tenantId,
          correlationId: resolveRequestCorrelationId(
            req.headers.get('x-correlation-id'),
            'corr-addr',
          ),
        };

        let rawBody: unknown;
        try {
          rawBody = await req.json();
        } catch {
          return NextResponse.json(
            {
              code: 'INVALID_REQUEST',
              message: 'Provide a valid JSON body with { q } or { id }.',
            },
            { status: 400 },
          );
        }

        if (
          !rawBody ||
          typeof rawBody !== 'object' ||
          Array.isArray(rawBody)
        ) {
          return NextResponse.json(
            {
              code: 'INVALID_REQUEST',
              message: 'Provide JSON { q } or { id } for address lookup.',
            },
            { status: 400 },
          );
        }

        const body = rawBody as { id?: unknown; q?: unknown };
        const id = typeof body.id === 'string' ? body.id : null;
        const query = typeof body.q === 'string' ? body.q : null;

        if (id !== null) {
          const result = await resolveAddress(id, logContext);
          return NextResponse.json(result.body, { status: result.status });
        }

        if (query !== null) {
          const result = await searchAddresses(query, logContext);
          return NextResponse.json(result.body, { status: result.status });
        }

        return NextResponse.json(
          {
            code: 'INVALID_REQUEST',
            message: 'Provide either q or id in the JSON request body.',
          },
          { status: 400 },
        );
      });
    } catch (err) {
      if (err instanceof AuthorisationError && err.code === 'UNAUTHENTICATED') {
        return NextResponse.json(
          {
            code: 'UNAUTHENTICATED',
            error: 'Authentication is required.',
            message: 'Authentication is required.',
          },
          { status: 401 },
        );
      }
      return NextResponse.json(
        {
          code: 'INTERNAL_ERROR',
          message: 'Address lookup failed.',
        },
        { status: 500 },
      );
    }
  },
);

export const GET = guardedRoute(
  'GET /api/address-lookup',
  async (): Promise<Response> => {
    try {
      return await withAuthenticatedActor(async () =>
        NextResponse.json(
          {
            error: 'Method Not Allowed',
            code: 'METHOD_NOT_ALLOWED',
            message: 'Use POST /api/address-lookup with a JSON body.',
          },
          { status: 405, headers: { Allow: 'POST' } },
        ),
      );
    } catch (err) {
      if (err instanceof AuthorisationError && err.code === 'UNAUTHENTICATED') {
        return NextResponse.json(
          {
            code: 'UNAUTHENTICATED',
            error: 'Authentication is required.',
            message: 'Authentication is required.',
          },
          { status: 401 },
        );
      }
      return NextResponse.json(
        {
          code: 'INTERNAL_ERROR',
          message: 'Address lookup failed.',
        },
        { status: 500 },
      );
    }
  },
);
