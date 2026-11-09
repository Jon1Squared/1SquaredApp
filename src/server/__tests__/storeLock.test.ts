import { describe, expect, it } from 'vitest';
import {
  getActiveRecordDeltaCompensator,
  withJsonStoreWriteLock,
} from '@/server/storeLock';

describe('S0-14: withJsonStoreWriteLock FIFO serialisation, AsyncLocalStorage re-entrancy, and RecordDeltaCompensator (R406, R418)', () => {
  it('serialises concurrent top-level callers in FIFO order while allowing nested re-entrant calls on the same async call chain without deadlocking (R418)', async () => {
    const timeline: string[] = [];

    const first = withJsonStoreWriteLock(async () => {
      timeline.push('first:enter');
      await new Promise((r) => setTimeout(r, 25));
      // Nested re-entrant call (e.g. takeTaskRecord -> saveTaskRecord) must NOT deadlock
      const nestedResult = await Promise.race([
        withJsonStoreWriteLock(async (innerCompensator) => {
          timeline.push('first:nested:enter');
          expect(innerCompensator).toBe(getActiveRecordDeltaCompensator());
          timeline.push('first:nested:exit');
          return 'nested-ok';
        }),
        new Promise<string>((_, reject) =>
          setTimeout(
            () => reject(new Error('DEADLOCK_DETECTED_ON_REENTRANT_LOCK')),
            1000,
          ),
        ),
      ]);
      expect(nestedResult).toBe('nested-ok');
      timeline.push('first:exit');
      return 1;
    });

    const second = withJsonStoreWriteLock(async () => {
      timeline.push('second:enter');
      timeline.push('second:exit');
      return 2;
    });

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(timeline).toEqual([
      'first:enter',
      'first:nested:enter',
      'first:nested:exit',
      'first:exit',
      'second:enter',
      'second:exit',
    ]);
  });

  it('executes registered RecordDeltaCompensator undo callbacks in LIFO order when a hybrid operation fails, without affecting subsequent callers (R406)', async () => {
    const state = { pgRows: [] as string[] };
    const undoOrder: string[] = [];

    await expect(
      withJsonStoreWriteLock(async (compensator) => {
        state.pgRows.push('ROW-1');
        compensator.register('undo-row-1', () => {
          undoOrder.push('undo-row-1');
          state.pgRows = state.pgRows.filter((id) => id !== 'ROW-1');
        });

        await withJsonStoreWriteLock(async (nestedCompensator) => {
          state.pgRows.push('ROW-2');
          nestedCompensator.register('undo-row-2', async () => {
            undoOrder.push('undo-row-2');
            state.pgRows = state.pgRows.filter((id) => id !== 'ROW-2');
          });
        });

        throw new Error('SIMULATED_SAVE_STORE_FAILURE');
      }),
    ).rejects.toThrow('SIMULATED_SAVE_STORE_FAILURE');

    expect(undoOrder).toEqual(['undo-row-2', 'undo-row-1']);
    expect(state.pgRows).toEqual([]);

    // Subsequent caller acquires the released lock cleanly
    const nextRes = await withJsonStoreWriteLock(async (compensator) => {
      state.pgRows.push('ROW-3');
      compensator.register('undo-row-3', () => {
        state.pgRows = [];
      });
      return 'ok';
    });
    expect(nextRes).toBe('ok');
    expect(state.pgRows).toEqual(['ROW-3']);
  });
});
