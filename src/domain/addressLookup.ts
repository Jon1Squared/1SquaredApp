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

const NOT_CONFIGURED_ERROR = "Address lookup isn't configured";

const suggestionCache = new Map<string, AddressSuggestion[]>();
const resolvedCache = new Map<string, ResolvedUkAddress>();

const SESSION_CACHE_PREFIX = 'ideal_pc_resolved_v1:';

export function clearAddressLookupCaches(): void {
  suggestionCache.clear();
  resolvedCache.clear();
}

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
 * Queries the server-side `/api/address-lookup` endpoint with a partial address or postcode.
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

  const url = `/api/address-lookup?q=${encodeURIComponent(trimmed)}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      if (res.status === 503 || data?.code === 'NOT_CONFIGURED') {
        return { suggestions: [], error: NOT_CONFIGURED_ERROR };
      }
      const msg =
        (data && typeof data.message === 'string' && data.message) ||
        `Address lookup failed (${res.status})`;
      return { suggestions: [], error: msg };
    }

    const rawHits = Array.isArray(data?.suggestions)
      ? data.suggestions
      : Array.isArray(data?.result?.hits)
        ? data.result.hits
        : [];
    const suggestions: AddressSuggestion[] = rawHits
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
      error: 'Could not reach address lookup service.',
    };
  }
}

/**
 * Step 2 (1 credit per unique resolved address, cached in memory & sessionStorage):
 * Resolves a selected autocomplete suggestion ID into structured UK address fields
 * via the server-side `/api/address-lookup` endpoint.
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

  const url = `/api/address-lookup?id=${encodeURIComponent(trimmedId)}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.address) {
      if (res.status === 503 || data?.code === 'NOT_CONFIGURED') {
        return { address: null, error: NOT_CONFIGURED_ERROR };
      }
      const msg =
        (data && typeof data.message === 'string' && data.message) ||
        `Could not resolve address (${res.status})`;
      return { address: null, error: msg };
    }

    const a = data.address as Record<string, unknown>;
    const resolved: ResolvedUkAddress = {
      line1: typeof a.line1 === 'string' ? a.line1 : '',
      line2: typeof a.line2 === 'string' ? a.line2 : '',
      town: typeof a.town === 'string' ? a.town : '',
      county: typeof a.county === 'string' ? a.county : '',
      postcode: typeof a.postcode === 'string' ? a.postcode : '',
      country:
        typeof a.country === 'string' && a.country.trim()
          ? a.country.trim()
          : 'United Kingdom',
    };

    resolvedCache.set(trimmedId, resolved);
    writeSessionCache(trimmedId, resolved);
    return { address: resolved };
  } catch {
    return {
      address: null,
      error: 'Could not resolve address from address lookup service.',
    };
  }
}
