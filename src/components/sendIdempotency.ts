export interface SendIdempotencyController {
  /** Return the current attempt's UUID, lazily generating one via `crypto.randomUUID()` on first send. */
  getOrCreateKey(): string;
  /** Discard the current key so the next send attempt creates a fresh UUID. Call only after success or subject change. */
  reset(): void;
  /** Whether a guarded send invocation is currently executing synchronously/asynchronously. */
  isInFlight(): boolean;
  /**
   * Execute `fn` with the stable `idempotencyKey` while blocking overlapping double-clicks
   * synchronously before React finishes flushing `disabled={true}`.
   */
  runGuarded<T>(
    fn: (idempotencyKey: string) => Promise<T>,
  ): Promise<{ ignored: true } | { ignored: false; value: T }>;
}

/**
 * Coordinates single-attempt client idempotency keys and synchronous double-submit protection
 * for Client Care and Non-Engagement dispatch forms (R848).
 */
export function createSendIdempotencyController(
  generateKey: () => string = () => crypto.randomUUID(),
): SendIdempotencyController {
  let currentKey: string | null = null;
  let inFlight = false;

  const getOrCreateKey = (): string => {
    if (!currentKey) {
      currentKey = generateKey();
    }
    return currentKey;
  };

  const reset = (): void => {
    currentKey = null;
  };

  const isInFlight = (): boolean => inFlight;

  const runGuarded = async <T>(
    fn: (idempotencyKey: string) => Promise<T>,
  ): Promise<{ ignored: true } | { ignored: false; value: T }> => {
    if (inFlight) {
      return { ignored: true };
    }
    inFlight = true;
    try {
      const idempotencyKey = getOrCreateKey();
      const value = await fn(idempotencyKey);
      return { ignored: false, value };
    } finally {
      inFlight = false;
    }
  };

  return {
    getOrCreateKey,
    reset,
    isInFlight,
    runGuarded,
  };
}
