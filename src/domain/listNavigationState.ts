/**
 * Pure state helpers for URL-synchronised list search & sorting (`R721`, `R722`).
 */

export type SortDirection = 'asc' | 'desc';

export interface ServerSortSpec<TCol extends string = string> {
  readonly columnId: TCol;
  readonly direction: SortDirection;
}

/**
 * Decides whether a changed `initialFilters.query` prop from the server should
 * overwrite the local search box value (`R721`).
 *
 * Returns `false` while a debounce timer is still pending or when the incoming
 * server query simply echoes the last query this client dispatched (which could
 * overwrite newer characters typed right after the request fired).
 * Returns `true` for external navigation such as browser Back/Forward or filter resets.
 */
export function shouldSyncServerQuery(input: {
  readonly serverQuery: string;
  readonly lastSentQuery: string | null;
  readonly debouncePending: boolean;
}): boolean {
  if (input.debouncePending) {
    return false;
  }
  if (
    input.lastSentQuery !== null &&
    input.serverQuery === input.lastSentQuery
  ) {
    return false;
  }
  return true;
}

/**
 * Parses URL sort parameters against a per-list allow-list (`R722`).
 * Unknown column keys or directions return `null` (falling back to default order).
 */
export function parseAllowListedSort<TCol extends string>(
  rawSort: string | undefined,
  rawDir: string | undefined,
  allowedColumns: readonly TCol[],
): ServerSortSpec<TCol> | null {
  const cleanCol = rawSort?.trim();
  if (!cleanCol || !(allowedColumns as readonly string[]).includes(cleanCol)) {
    return null;
  }
  const direction: SortDirection = rawDir?.trim() === 'desc' ? 'desc' : 'asc';
  return {
    columnId: cleanCol as TCol,
    direction,
  };
}
