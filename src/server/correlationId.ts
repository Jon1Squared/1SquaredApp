import { randomUUID } from 'node:crypto';

export const SAFE_REQUEST_CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Accepts a request correlation ID only when its trimmed value matches
 * `^[A-Za-z0-9._:-]{1,128}$`. Otherwise generates a fresh UUID with
 * `crypto.randomUUID()` (optionally prefixed for route or service context).
 */
export function resolveRequestCorrelationId(
  headerValue: string | null | undefined,
  fallbackPrefix?: string,
): string {
  const trimmed = headerValue?.trim() ?? '';
  if (SAFE_REQUEST_CORRELATION_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const generated = randomUUID();
  return fallbackPrefix ? `${fallbackPrefix}-${generated}` : generated;
}
