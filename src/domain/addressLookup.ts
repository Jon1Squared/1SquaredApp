export interface AddressSuggestion {
  id: string;
  suggestion: string;
  udprn?: number;
}

export interface ResolvedUkAddress {
  line1: string;
  line2: string;
  town: string;
  county: string;
  postcode: string;
  country: string;
}

const DEFAULT_API_KEY =
  process.env.NEXT_PUBLIC_IDEAL_POSTCODES_API_KEY ||
  'ak_h88HXIcAS6B1MmRPE0kwrVO05Vuhg';

const suggestionCache = new Map<string, AddressSuggestion[]>();
const resolvedCache = new Map<string, ResolvedUkAddress>();

const SESSION_CACHE_PREFIX = 'ideal_pc_resolved_v1:';

function readSessionCache(id: string): ResolvedUkAddress | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(`${SESSION_CACHE_PREFIX}${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as ResolvedUkAddress;
  } catch {
    return null;
  }
}

function writeSessionCache(id: string, value: ResolvedUkAddress): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      `${SESSION_CACHE_PREFIX}${id}`,
      JSON.stringify(value),
    );
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Step 1 (Free / 0 credits):
 * Queries Ideal Postcodes Address Autocomplete API with a partial address or postcode.
 */
export async function searchAddressSuggestions(
  query: string,
  signal?: AbortSignal,
): Promise<{ suggestions: AddressSuggestion[]; error?: string }> {
  const trimmed = query.trim();
  if (trimmed.length < 3) {
    return { suggestions: [] };
  }

  const cacheKey = trimmed.toLowerCase();
  const cached = suggestionCache.get(cacheKey);
  if (cached) {
    return { suggestions: cached };
  }

  const url = `https://api.ideal-postcodes.co.uk/v1/autocomplete/addresses?api_key=${encodeURIComponent(
    DEFAULT_API_KEY,
  )}&query=${encodeURIComponent(trimmed)}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      const msg =
        (data && typeof data.message === 'string' && data.message) ||
        `Address lookup failed (${res.status})`;
      return { suggestions: [], error: msg };
    }

    const hits = Array.isArray(data?.result?.hits) ? data.result.hits : [];
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
      .map((h: { id: string; suggestion: string; udprn?: number }) => ({
        id: h.id,
        suggestion: h.suggestion,
        udprn: h.udprn,
      }));

    suggestionCache.set(cacheKey, suggestions);
    return { suggestions };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { suggestions: [] };
    }
    return {
      suggestions: [],
      error: 'Could not reach Ideal Postcodes service.',
    };
  }
}

/**
 * Step 2 (1 credit per unique resolved address, cached in memory & sessionStorage):
 * Resolves a selected autocomplete suggestion ID into structured UK address fields.
 */
export async function resolveAddressSuggestion(
  id: string,
): Promise<{ address: ResolvedUkAddress | null; error?: string }> {
  const trimmedId = id.trim();
  if (!trimmedId) {
    return { address: null, error: 'Missing address ID' };
  }

  const memCached = resolvedCache.get(trimmedId);
  if (memCached) {
    return { address: memCached };
  }

  const sessionCached = readSessionCache(trimmedId);
  if (sessionCached) {
    resolvedCache.set(trimmedId, sessionCached);
    return { address: sessionCached };
  }

  const url = `https://api.ideal-postcodes.co.uk/v1/autocomplete/addresses/${encodeURIComponent(
    trimmedId,
  )}/gbr?api_key=${encodeURIComponent(DEFAULT_API_KEY)}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.result) {
      const msg =
        (data && typeof data.message === 'string' && data.message) ||
        `Could not resolve address (${res.status})`;
      return { address: null, error: msg };
    }

    const r = data.result as Record<string, unknown>;
    const line1 = typeof r.line_1 === 'string' ? r.line_1.trim() : '';
    const line2Parts = [r.line_2, r.line_3]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((p) => p.trim());
    const line2 = line2Parts.join(', ');
    const town = typeof r.post_town === 'string' ? r.post_town.trim() : '';
    const county =
      (typeof r.county === 'string' && r.county.trim()) ||
      (typeof r.traditional_county === 'string' && r.traditional_county.trim()) ||
      (typeof r.administrative_county === 'string' && r.administrative_county.trim()) ||
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

    resolvedCache.set(trimmedId, resolved);
    writeSessionCache(trimmedId, resolved);
    return { address: resolved };
  } catch {
    return {
      address: null,
      error: 'Could not resolve address from Ideal Postcodes.',
    };
  }
}
