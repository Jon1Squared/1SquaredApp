import 'server-only';

import type { AddressSuggestion, ResolvedUkAddress } from '@/domain/addressLookup';
import { readServerSecret } from '@/server/serverSecrets';

export const ADDRESS_LOOKUP_NOT_CONFIGURED_MESSAGE =
  "Address lookup isn't configured";

const IDEAL_POSTCODES_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface AddressLookupLogContext {
  tenantId: string;
  correlationId: string;
}

let loggedNotConfiguredWarning = false;

export function resetAddressLookupNotConfiguredWarningForTests(): void {
  loggedNotConfiguredWarning = false;
}

export function getIdealPostcodesApiKey(
  logContext?: AddressLookupLogContext,
): string | null {
  const secret = readServerSecret('IDEAL_POSTCODES_API_KEY');
  if (!secret) {
    if (!loggedNotConfiguredWarning) {
      loggedNotConfiguredWarning = true;
      console.warn(
        JSON.stringify({
          event: 'address_lookup.not_configured',
          tenantId: logContext?.tenantId ?? 'unknown',
          correlationId: logContext?.correlationId ?? 'corr-addr-uncorrelated',
          message:
            'IDEAL_POSTCODES_API_KEY is unset or is an unresolved Key Vault reference.',
        }),
      );
    }
    return null;
  }
  return secret;
}

export type AddressSearchServiceResult =
  | {
      ok: true;
      status: 200;
      body: { suggestions: AddressSuggestion[] };
    }
  | {
      ok: false;
      status: 400 | 502 | 503;
      body: { code: string; message: string };
    };

export type AddressResolveServiceResult =
  | {
      ok: true;
      status: 200;
      body: { address: ResolvedUkAddress };
    }
  | {
      ok: false;
      status: 400 | 502 | 503;
      body: { code: string; message: string };
    };

/**
 * Queries Ideal Postcodes Address Autocomplete API using the server-side
 * `IDEAL_POSTCODES_API_KEY` environment variable only.
 * Never logs the query or returned address suggestions.
 */
export async function searchAddresses(
  query: string,
  logContext?: AddressLookupLogContext,
): Promise<AddressSearchServiceResult> {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (trimmed.length < 3) {
    return {
      ok: true,
      status: 200,
      body: { suggestions: [] },
    };
  }
  if (trimmed.length > 100) {
    return {
      ok: false,
      status: 400,
      body: {
        code: 'INVALID_QUERY',
        message: 'Address query must be between 3 and 100 characters.',
      },
    };
  }

  const apiKey = getIdealPostcodesApiKey(logContext);
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      body: {
        code: 'NOT_CONFIGURED',
        message: ADDRESS_LOOKUP_NOT_CONFIGURED_MESSAGE,
      },
    };
  }

  const url = `https://api.ideal-postcodes.co.uk/v1/autocomplete/addresses?api_key=${encodeURIComponent(
    apiKey,
  )}&query=${encodeURIComponent(trimmed)}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    const data = (await res.json().catch(() => null)) as
      | { result?: { hits?: unknown[] }; message?: unknown }
      | null;

    if (!res.ok || !data) {
      return {
        ok: false,
        status: 502,
        body: {
          code: 'UPSTREAM_ERROR',
          message: `Address lookup failed (${res.status})`,
        },
      };
    }

    const hits = Array.isArray(data.result?.hits) ? data.result.hits : [];
    const suggestions: AddressSuggestion[] = hits
      .filter(
        (h: unknown): h is { id: string; suggestion: string; udprn?: number } =>
          Boolean(
            h &&
              typeof h === 'object' &&
              typeof (h as { id?: unknown }).id === 'string' &&
              typeof (h as { suggestion?: unknown }).suggestion === 'string',
          ),
      )
      .map((h) => ({
        id: h.id,
        suggestion: h.suggestion,
        ...(typeof h.udprn === 'number' ? { udprn: h.udprn } : {}),
      }));

    return {
      ok: true,
      status: 200,
      body: { suggestions },
    };
  } catch {
    return {
      ok: false,
      status: 502,
      body: {
        code: 'UPSTREAM_ERROR',
        message: 'Could not reach address lookup service.',
      },
    };
  }
}

/**
 * Resolves a selected Ideal Postcodes autocomplete suggestion ID into structured UK
 * address fields using the server-side `IDEAL_POSTCODES_API_KEY` only.
 * Never logs the ID or resolved address.
 */
export async function resolveAddress(
  id: string,
  logContext?: AddressLookupLogContext,
): Promise<AddressResolveServiceResult> {
  const trimmedId = typeof id === 'string' ? id.trim() : '';
  if (
    !trimmedId ||
    trimmedId.includes('..') ||
    !IDEAL_POSTCODES_ID_PATTERN.test(trimmedId)
  ) {
    return {
      ok: false,
      status: 400,
      body: {
        code: 'INVALID_ID',
        message: 'Invalid address ID.',
      },
    };
  }

  const apiKey = getIdealPostcodesApiKey(logContext);
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      body: {
        code: 'NOT_CONFIGURED',
        message: ADDRESS_LOOKUP_NOT_CONFIGURED_MESSAGE,
      },
    };
  }

  const url = `https://api.ideal-postcodes.co.uk/v1/autocomplete/addresses/${encodeURIComponent(
    trimmedId,
  )}/gbr?api_key=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    const data = (await res.json().catch(() => null)) as
      | { result?: Record<string, unknown>; message?: unknown }
      | null;

    if (!res.ok || !data || !data.result) {
      return {
        ok: false,
        status: 502,
        body: {
          code: 'UPSTREAM_ERROR',
          message: `Could not resolve address (${res.status})`,
        },
      };
    }

    const r = data.result;
    const line1 = typeof r.line_1 === 'string' ? r.line_1.trim() : '';
    const line2Parts = [r.line_2, r.line_3]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((p) => p.trim());
    const line2 = line2Parts.join(', ');
    const town = typeof r.post_town === 'string' ? r.post_town.trim() : '';
    const county =
      (typeof r.county === 'string' && r.county.trim()) ||
      (typeof r.traditional_county === 'string' && r.traditional_county.trim()) ||
      (typeof r.administrative_county === 'string' &&
        r.administrative_county.trim()) ||
      '';
    const postcode = typeof r.postcode === 'string' ? r.postcode.trim() : '';
    const country =
      typeof r.country === 'string' && r.country.trim()
        ? r.country.trim()
        : 'United Kingdom';

    const resolved: ResolvedUkAddress = {
      line1,
      line2,
      town,
      county,
      postcode,
      country,
    };

    return {
      ok: true,
      status: 200,
      body: { address: resolved },
    };
  } catch {
    return {
      ok: false,
      status: 502,
      body: {
        code: 'UPSTREAM_ERROR',
        message: 'Could not resolve address from address lookup service.',
      },
    };
  }
}
