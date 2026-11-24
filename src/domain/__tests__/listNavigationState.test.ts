import { describe, expect, it } from 'vitest';
import {
  parseAllowListedSort,
  shouldSyncServerQuery,
} from '../listNavigationState';

describe('listNavigationState (R721 & R722)', () => {
  it('R721: does not overwrite search box with delayed server response while user keeps typing', () => {
    // 1. User types "smi", debounce fires -> client dispatches "smi" (debouncePending = false, lastSent = "smi")
    // 2. Before RSC response arrives, user types "t" -> local input is "smit" and debouncePending = true
    expect(
      shouldSyncServerQuery({
        serverQuery: 'smi',
        lastSentQuery: 'smi',
        debouncePending: true,
      }),
    ).toBe(false);

    // Even right as debounce completes or for a stale echo matching lastSentQuery,
    // do not clobber local state.
    expect(
      shouldSyncServerQuery({
        serverQuery: 'smi',
        lastSentQuery: 'smi',
        debouncePending: false,
      }),
    ).toBe(false);
  });

  it('R721: syncs external navigation (Back/Forward/Clear) when server query differs and no debounce is pending', () => {
    expect(
      shouldSyncServerQuery({
        serverQuery: 'previous-search',
        lastSentQuery: 'smit',
        debouncePending: false,
      }),
    ).toBe(true);

    expect(
      shouldSyncServerQuery({
        serverQuery: '',
        lastSentQuery: 'smit',
        debouncePending: false,
      }),
    ).toBe(true);
  });

  it('R722: parseAllowListedSort accepts allow-listed columns only and normalises direction', () => {
    expect(
      parseAllowListedSort('matter', 'desc', ['matter', 'status', 'openedAt']),
    ).toEqual({ columnId: 'matter', direction: 'desc' });

    expect(
      parseAllowListedSort('status', 'invalid', ['matter', 'status', 'openedAt']),
    ).toEqual({ columnId: 'status', direction: 'asc' });

    expect(
      parseAllowListedSort('DROP TABLE matters;--', 'asc', [
        'matter',
        'status',
        'openedAt',
      ]),
    ).toBeNull();
  });
});
