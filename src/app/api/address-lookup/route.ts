import { NextResponse } from 'next/server';
import { AuthorisationError } from '@/domain/rbac';
import {
  resolveAddress,
  searchAddresses,
} from '@/server/addressLookupService';
import { withAuthenticatedActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    return await withAuthenticatedActor(async () => {
      const url = new URL(req.url);
      const id = url.searchParams.get('id');
      const query = url.searchParams.get('q');

      if (id !== null) {
        const result = await resolveAddress(id);
        return NextResponse.json(result.body, { status: result.status });
      }

      if (query !== null) {
        const result = await searchAddresses(query);
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
}
