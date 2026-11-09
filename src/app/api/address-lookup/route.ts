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

export const GET = guardedRoute(
  'GET /api/address-lookup',
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

        const url = new URL(req.url);
        const id = url.searchParams.get('id');
        const query = url.searchParams.get('q');

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
            message: 'Provide either q or id query parameter.',
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
