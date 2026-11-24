/**
 * Strict same-origin, path-only validation for authentication `returnTo` targets (`Suggestion 9`).
 * Rejects scheme-relative URLs, backslashes, control characters, external origins, and `/login` / `/api/auth` loops.
 */
export function sanitizeReturnToPath(
  returnTo: string | null | undefined,
  baseOrigin = 'http://localhost',
): string {
  if (!returnTo || typeof returnTo !== 'string') return '/';
  const trimmed = returnTo.trim();
  if (!trimmed) return '/';
  // Reject control characters anywhere (including CR/LF header injection attempts)
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '/';
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\')
  ) {
    return '/';
  }
  try {
    const base = new URL(baseOrigin);
    const resolved = new URL(trimmed, base.origin);
    if (resolved.origin !== base.origin) {
      return '/';
    }
    if (
      resolved.pathname === '/login' ||
      resolved.pathname.startsWith('/api/auth')
    ) {
      return '/';
    }
    const candidate = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    if (
      !candidate.startsWith('/') ||
      candidate.startsWith('//') ||
      candidate.includes('\\')
    ) {
      return '/';
    }
    const rechecked = new URL(candidate, base.origin);
    if (rechecked.origin !== base.origin) {
      return '/';
    }
    return candidate;
  } catch {
    return '/';
  }
}

export function buildLoginRedirectPath(returnTo?: string | null): string {
  const safe = sanitizeReturnToPath(returnTo);
  return safe !== '/' ? `/login?returnTo=${encodeURIComponent(safe)}` : '/login';
}

export function buildRouteReturnTo(
  pathname: string,
  searchParams?: Record<string, string | string[] | undefined>,
): string {
  if (!searchParams) return sanitizeReturnToPath(pathname);
  const qs = new URLSearchParams();
  for (const [key, rawVal] of Object.entries(searchParams)) {
    if (key === 'authError' || key === 'signedOut' || key === 'authSuccess') {
      continue;
    }
    const val = Array.isArray(rawVal) ? rawVal[0] : rawVal;
    if (typeof val === 'string' && val.length > 0) {
      qs.set(key, val);
    }
  }
  const query = qs.toString();
  return sanitizeReturnToPath(query ? `${pathname}?${query}` : pathname);
}
