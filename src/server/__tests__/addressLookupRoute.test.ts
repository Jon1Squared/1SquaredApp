import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as addressLookupGet } from '@/app/api/address-lookup/route';
import {
  clearAddressLookupCaches,
  resolveAddressSuggestion,
  searchAddressSuggestions,
} from '@/domain/addressLookup';
import { resetAddressLookupNotConfiguredWarningForTests } from '@/server/addressLookupService';
import { setTestEntraSessionOverride } from '@/server/entraAuth';

const ORIGINAL_IDEAL_KEY = process.env.IDEAL_POSTCODES_API_KEY;
const ORIGINAL_FETCH = globalThis.fetch;

const TEST_SESSION = {
  personId: 'P-000002',
  tenantId: 'not-a-law-firm',
  oid: '00000000-0000-4000-8000-000000000002',
  tid: '00000000-0000-4000-8000-000000000099',
  sub: 'P-000002',
  email: 'dafydd.evans@notalawfirm.example',
  displayName: 'Dafydd Evans',
  entraRoles: [],
  mappedRoles: ['fee_earner'],
  entraGroups: [],
  mfaVerified: true,
  amr: ['pwd', 'mfa'],
  authenticatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

describe('S0-01: /api/address-lookup route and addressLookup client helper', () => {
  beforeEach(() => {
    clearAddressLookupCaches();
    resetAddressLookupNotConfiguredWarningForTests();
    setTestEntraSessionOverride(TEST_SESSION);
    delete process.env.IDEAL_POSTCODES_API_KEY;
  });

  afterEach(() => {
    clearAddressLookupCaches();
    resetAddressLookupNotConfiguredWarningForTests();
    setTestEntraSessionOverride(null);
    if (ORIGINAL_IDEAL_KEY === undefined) {
      delete process.env.IDEAL_POSTCODES_API_KEY;
    } else {
      process.env.IDEAL_POSTCODES_API_KEY = ORIGINAL_IDEAL_KEY;
    }
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('returns 401 without a session (setTestEntraSessionOverride(undefined))', async () => {
    setTestEntraSessionOverride(undefined);
    const req = new Request('http://localhost:3000/api/address-lookup?q=CF10');
    const res = await addressLookupGet(req);
    expect(res.status).toBe(401);
  });

  it('returns 503 with "Address lookup isn\'t configured" when the key is unset or an unresolved Key Vault reference, logs tenantId and correlationId without query text (R230), and searchAddressSuggestions surfaces that message', async () => {
    delete process.env.IDEAL_POSTCODES_API_KEY;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const unsetRes = await addressLookupGet(
      new Request('http://localhost:3000/api/address-lookup?q=CF10%201AA'),
    );
    expect(unsetRes.status).toBe(503);
    const unsetJson = (await unsetRes.json()) as {
      code?: string;
      message?: string;
    };
    expect(unsetJson.code).toBe('NOT_CONFIGURED');
    expect(unsetJson.message).toBe("Address lookup isn't configured");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const rawWarnPayload = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(rawWarnPayload).not.toContain('CF10');
    expect(rawWarnPayload).not.toContain('1AA');
    const parsedWarn = JSON.parse(rawWarnPayload) as {
      event?: string;
      tenantId?: string;
      correlationId?: string;
    };
    expect(parsedWarn.event).toBe('address_lookup.not_configured');
    expect(parsedWarn.tenantId).toBe('not-a-law-firm');
    expect(parsedWarn.correlationId).toMatch(/^corr-addr-[0-9a-f-]{36}$/i);

    process.env.IDEAL_POSTCODES_API_KEY =
      '@Microsoft.KeyVault(SecretUri=https://kv-test.vault.azure.net/secrets/ideal-postcodes-api-key/)';

    const kvRes = await addressLookupGet(
      new Request('http://localhost:3000/api/address-lookup?q=CF10%201AA'),
    );
    expect(kvRes.status).toBe(503);
    const kvJson = (await kvRes.json()) as {
      code?: string;
      message?: string;
    };
    expect(kvJson.code).toBe('NOT_CONFIGURED');
    expect(kvJson.message).toBe("Address lookup isn't configured");

    // Wire fetch to the route handler so searchAddressSuggestions exercises the real route response
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const pathStr = typeof input === 'string' ? input : input.toString();
      return addressLookupGet(new Request(`http://localhost:3000${pathStr}`));
    }) as unknown as typeof fetch;

    const clientResult = await searchAddressSuggestions('CF10 1AA');
    expect(clientResult.suggestions).toEqual([]);
    expect(clientResult.error).toBe("Address lookup isn't configured");
  });

  it('with the key set and fetch mocked, the outbound URL carries the server key and the response body contains no key', async () => {
    const serverKey = 'test-ideal-postcodes-key-placeholder';
    process.env.IDEAL_POSTCODES_API_KEY = serverKey;

    const outboundUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      outboundUrls.push(urlStr);
      return new Response(
        JSON.stringify({
          result: {
            hits: [
              {
                id: 'paf_1001',
                suggestion: '10 Cathedral Road, Cardiff, CF11 9LJ',
                udprn: 1001,
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as unknown as typeof fetch;

    const res = await addressLookupGet(
      new Request('http://localhost:3000/api/address-lookup?q=CF11%209LJ'),
    );
    expect(res.status).toBe(200);
    expect(outboundUrls).toHaveLength(1);
    expect(outboundUrls[0]).toContain(
      `api_key=${encodeURIComponent(serverKey)}`,
    );

    const rawBody = await res.text();
    expect(rawBody).not.toContain(serverKey);
    const parsed = JSON.parse(rawBody) as {
      suggestions: Array<{ id: string; suggestion: string; udprn?: number }>;
    };
    expect(parsed.suggestions).toEqual([
      {
        id: 'paf_1001',
        suggestion: '10 Cathedral Road, Cardiff, CF11 9LJ',
        udprn: 1001,
      },
    ]);
  });

  it('a query that is too short returns an empty list without calling fetch', async () => {
    process.env.IDEAL_POSTCODES_API_KEY = 'test-ideal-postcodes-key-placeholder';
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await addressLookupGet(
      new Request('http://localhost:3000/api/address-lookup?q=ab'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: unknown[] };
    expect(body.suggestions).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    const clientShort = await searchAddressSuggestions('a');
    expect(clientShort.suggestions).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves an address ID through the server route and rejects invalid IDs without calling fetch', async () => {
    const serverKey = 'test-ideal-postcodes-key-placeholder';
    process.env.IDEAL_POSTCODES_API_KEY = serverKey;

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          result: {
            line_1: '10 Cathedral Road',
            line_2: 'Pontcanna',
            line_3: '',
            post_town: 'Cardiff',
            county: 'South Glamorgan',
            postcode: 'CF11 9LJ',
            country: 'Wales',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const badRes = await addressLookupGet(
      new Request('http://localhost:3000/api/address-lookup?id=../bad/id'),
    );
    expect(badRes.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();

    const okRes = await addressLookupGet(
      new Request('http://localhost:3000/api/address-lookup?id=paf_1001'),
    );
    expect(okRes.status).toBe(200);
    const rawText = await okRes.text();
    expect(rawText).not.toContain(serverKey);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const pathStr = typeof input === 'string' ? input : input.toString();
      if (pathStr.startsWith('/api/address-lookup')) {
        return new Response(rawText, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${pathStr}`);
    }) as unknown as typeof fetch;

    const resolved = await resolveAddressSuggestion('paf_1001');
    expect(resolved.error).toBeUndefined();
    expect(resolved.address).toEqual({
      line1: '10 Cathedral Road',
      line2: 'Pontcanna',
      town: 'Cardiff',
      county: 'South Glamorgan',
      postcode: 'CF11 9LJ',
      country: 'Wales',
    });
  });
});
