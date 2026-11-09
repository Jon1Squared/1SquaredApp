/**
 * Transitional Cross-Module Serialisation Lock & Record-Delta Compensator (`src/server/storeLock.ts`).
 *
 * Implements ADR 0028 §5 & `S0-14` / `S0-15` (`R406`, `R418`; retired in `S0-20` once `store.ts` is deleted):
 * 1. `withJsonStoreWriteLock(fn)` serialises cross-module mutations that write to PostgreSQL and then
 *    mutate unmoved collections in `FirmStore` via a FIFO async mutex.
 * 2. Re-entrant for the same async call chain via `AsyncLocalStorage` (`R418`), so nested calls such as
 *    `takeTaskRecord` -> `saveTaskRecord` reuse the active lock and `RecordDeltaCompensator` without deadlocking.
 * 3. `RecordDeltaCompensator` records compensating SQL/repository callbacks for PostgreSQL mutations made
 *    during a hybrid operation; if a subsequent JSON `saveStore()` or validation step throws, only that
 *    operation's own PostgreSQL deltas are rolled back in LIFO order — never overwriting another concurrent
 *    operation's store snapshot (`R406`).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type CompensationStep = () => Promise<void> | void;

export class RecordDeltaCompensator {
  private readonly undoSteps: Array<{
    readonly label: string;
    readonly undo: CompensationStep;
  }> = [];

  public register(label: string, undo: CompensationStep): void {
    this.undoSteps.push({ label, undo });
  }

  public async compensateAll(): Promise<void> {
    const errors: unknown[] = [];
    for (let i = this.undoSteps.length - 1; i >= 0; i--) {
      const step = this.undoSteps[i]!;
      try {
        await step.undo();
      } catch (err) {
        errors.push(err);
      }
    }
    this.undoSteps.length = 0;
    if (errors.length > 0) {
      const first = errors[0];
      throw first instanceof Error
        ? first
        : new Error(`STORE_LOCK_COMPENSATION_FAILED: ${String(first)}`);
    }
  }

  public clear(): void {
    this.undoSteps.length = 0;
  }
}

interface ActiveStoreWriteLockContext {
  readonly lockToken: symbol;
  readonly compensator: RecordDeltaCompensator;
  depth: number;
}

const storeLockContextStorage =
  new AsyncLocalStorage<ActiveStoreWriteLockContext>();

let lockQueueTail: Promise<void> = Promise.resolve();

export function getActiveRecordDeltaCompensator(): RecordDeltaCompensator | null {
  return storeLockContextStorage.getStore()?.compensator ?? null;
}

/**
 * Acquires the process-wide FIFO JSON store write lock (or re-enters immediately if already held
 * in the current `AsyncLocalStorage` async call chain, `R418`), running `fn(compensator)`.
 * If the outermost locked call throws, runs all registered `RecordDeltaCompensator` undo callbacks
 * in LIFO order before rethrowing (`R406`).
 */
export async function withJsonStoreWriteLock<T>(
  fn: (compensator: RecordDeltaCompensator) => Promise<T> | T,
): Promise<T> {
  const existing = storeLockContextStorage.getStore();
  if (existing) {
    existing.depth += 1;
    try {
      return await fn(existing.compensator);
    } finally {
      existing.depth -= 1;
    }
  }

  let releaseMutex!: () => void;
  const previousTail = lockQueueTail;
  const currentDone = new Promise<void>((resolve) => {
    releaseMutex = resolve;
  });
  lockQueueTail = previousTail.then(() => currentDone);

  await previousTail;

  const compensator = new RecordDeltaCompensator();
  const context: ActiveStoreWriteLockContext = {
    lockToken: Symbol('json-store-write-lock'),
    compensator,
    depth: 1,
  };

  try {
    const result = await storeLockContextStorage.run(context, async () =>
      fn(compensator),
    );
    compensator.clear();
    return result;
  } catch (err) {
    await compensator.compensateAll().catch(() => {});
    throw err;
  } finally {
    releaseMutex();
  }
}
