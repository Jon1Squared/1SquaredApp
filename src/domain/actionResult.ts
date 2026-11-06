/**
 * Shared typed denial shape returned by `guardedAction` when `enforcedBy: 'action'`
 * denies a server action (`src/domain/actionResult.ts`, ADR 0025).
 */

export type ActionDenialCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'MFA_REQUIRED';

export interface ActionDenied {
  ok: false;
  denied: true;
  code: ActionDenialCode;
  message: string;
  error: string;
}

export function buildActionDenied(
  code: ActionDenialCode,
  message: string,
): ActionDenied {
  return {
    ok: false,
    denied: true,
    code,
    message,
    error: `${code}: ${message}`,
  };
}

export function isActionDenied(value: unknown): value is ActionDenied {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.ok === false &&
    candidate.denied === true &&
    (candidate.code === 'UNAUTHENTICATED' ||
      candidate.code === 'FORBIDDEN' ||
      candidate.code === 'MFA_REQUIRED') &&
    typeof candidate.message === 'string' &&
    typeof candidate.error === 'string'
  );
}
