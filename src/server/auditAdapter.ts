/**
 * Temporary PostgreSQL Audit Adapter & Per-Record JSON Delta Compensator
 * (`src/server/auditAdapter.ts`).
 *
 * Implements ADR 0028 §§4–5 & `S0-15` (`Owner Decision 4`, `Owner Decision 5`, `R406`, `R418`, `R420`):
 * - While unmoved modules still persist primary records in `FirmStore` (`src/server/store.ts`),
 *   their audit entries write to PostgreSQL `public.audit_entries` (`TenantAuditRepository`) inside
 *   `withJsonStoreWriteLock`.
 * - NEVER restores a whole-store `structuredClone(store)` snapshot (`R406`). Instead,
 *   `captureJsonStoreBaseline` + `registerJsonStoreRecordDeltas` compute exact per-record ID deltas
 *   (`inserted`, `updated`, `deleted` items by ID, plus touched scalar settings keys) and register a
 *   record-level compensating callback onto `RecordDeltaCompensator`. If the PostgreSQL `audit_entries`
 *   transaction (or an outer cross-module step in a nested re-entrant lock chain, `R418`) fails, ONLY
 *   this operation's record deltas are reverted in memory and on disk (`saveStore`), leaving any other
 *   operation's records untouched.
 *
 * Retirement schedule:
 * - @remove-in S0-16: People, Organisations, Person-Organisation Links, Notes, Merge History, Matters
 * - @remove-in S0-17a: Enquiries, Quotes, Tasks, Notifications, Sign-Offs, Recently Viewed
 * - @remove-in S0-17b: Employment, Sensitive/Payroll HR records, Teams, RBAC overrides
 * - @remove-in S0-17c: Firm settings, Choice Lists/Values, Custom Fields, Org Structure, Party Taxonomy, Home/Costs configs
 * - @remove-in S0-18: PMS Links (`pmsLinks`)
 * - Deleted completely in `S0-20` alongside `src/server/store.ts` and `src/server/storeLock.ts`.
 */

import {
  TenantAuditRepository,
  type FirmAuditEntryInput,
  type FirmAuditEntryRecord,
  type TenantContext,
} from '@platform/core';
import type { AuditEntry } from '@/domain/types';
import { getStore, saveStore, type FirmStore } from './store';
import {
  getActiveRecordDeltaCompensator,
  withJsonStoreWriteLock,
  type RecordDeltaCompensator,
} from './storeLock';

interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
}

interface ActiveAuditStagingScope {
  readonly stagedEntries: FirmAuditEntryInput[];
}

let cachedAuditStagingStorage:
  | AsyncLocalStorageLike<ActiveAuditStagingScope>
  | null
  | undefined;

function getAuditStagingStorage(): AsyncLocalStorageLike<ActiveAuditStagingScope> | null {
  if (cachedAuditStagingStorage !== undefined) {
    return cachedAuditStagingStorage;
  }
  if (
    typeof window !== 'undefined' ||
    typeof process.getBuiltinModule !== 'function'
  ) {
    cachedAuditStagingStorage = null;
    return null;
  }
  try {
    const asyncHooks = process.getBuiltinModule('node:async_hooks') as
      | typeof import('node:async_hooks')
      | undefined;
    cachedAuditStagingStorage = asyncHooks?.AsyncLocalStorage
      ? new asyncHooks.AsyncLocalStorage<ActiveAuditStagingScope>()
      : null;
  } catch {
    cachedAuditStagingStorage = null;
  }
  return cachedAuditStagingStorage;
}

declare global {
  var __oneSquaredAuditRepo: TenantAuditRepository | undefined;
}

export function getAuditRepository(): TenantAuditRepository {
  if (!global.__oneSquaredAuditRepo) {
    global.__oneSquaredAuditRepo = new TenantAuditRepository();
  }
  return global.__oneSquaredAuditRepo;
}

export type AuditAdapterTestFailureHook = (params: {
  ctx: TenantContext;
  entries: readonly FirmAuditEntryInput[];
}) => Promise<void> | void;

let testAuditFailureHook: AuditAdapterTestFailureHook | null = null;

export function setAuditAdapterFailureHookForTesting(
  hook: AuditAdapterTestFailureHook | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'SECURITY_ERROR: setAuditAdapterFailureHookForTesting is only permitted when NODE_ENV === "test".',
    );
  }
  testAuditFailureHook = hook;
}

/**
 * Unmoved ID-keyed array collections in `FirmStore` tracked for per-record delta compensation (`R406`).
 */
const ID_KEYED_ARRAY_COLLECTIONS = [
  { name: 'lists', keyField: 'key' },
  { name: 'values', keyField: 'id' },
  { name: 'customFields', keyField: 'id' },
  { name: 'people', keyField: 'id' },
  { name: 'organisations', keyField: 'id' },
  { name: 'links', keyField: 'id' },
  { name: 'matters', keyField: 'id' },
  { name: 'teams', keyField: 'id' },
  { name: 'tasks', keyField: 'id' },
  { name: 'enquiries', keyField: 'id' },
  { name: 'quotes', keyField: 'id' },
  { name: 'notifications', keyField: 'id' },
  { name: 'notes', keyField: 'id' },
  { name: 'mergeHistory', keyField: 'id' },
  { name: 'pmsLinks', keyField: 'id' },
  { name: 'signOffs', keyField: 'id' },
] as const;

/**
 * Unmoved scalar / map properties on `FirmStore` tracked individually (never as a whole store).
 */
const SCALAR_CONFIG_KEYS = [
  'firmId',
  'isCleanDeployment',
  'firm',
  'enquirySettings',
  'taskSettings',
  'homePagesConfig',
  'orgStructure',
  'matterPartyTaxonomy',
  'matterPartyMigrationReport',
  'matterCostsConfig',
  'rbacConfig',
] as const;

interface CapturedItemEntry {
  readonly json: string;
  readonly index: number;
}

export interface JsonStoreBaseline {
  readonly arraysByCollection: Map<string, Map<string, CapturedItemEntry>>;
  readonly recentlyViewedByUser: Map<string, string>;
  readonly countersByPrefix: Map<string, number>;
  readonly scalarConfigsByKey: Map<string, { hadKey: boolean; json: string }>;
}

export function captureJsonStoreBaseline(store: FirmStore): JsonStoreBaseline {
  const arraysByCollection = new Map<string, Map<string, CapturedItemEntry>>();
  const storeRecord = store as unknown as Record<string, unknown>;

  for (const spec of ID_KEYED_ARRAY_COLLECTIONS) {
    const arr = storeRecord[spec.name];
    const itemMap = new Map<string, CapturedItemEntry>();
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i] as Record<string, unknown> | null | undefined;
        const idVal = item?.[spec.keyField];
        if (typeof idVal === 'string' && idVal) {
          itemMap.set(idVal, { json: JSON.stringify(item), index: i });
        }
      }
    }
    arraysByCollection.set(spec.name, itemMap);
  }

  const recentlyViewedByUser = new Map<string, string>();
  if (store.recentlyViewed && typeof store.recentlyViewed === 'object') {
    for (const [uid, list] of Object.entries(store.recentlyViewed)) {
      recentlyViewedByUser.set(uid, JSON.stringify(list));
    }
  }

  const countersByPrefix = new Map<string, number>();
  if (store.counters && typeof store.counters === 'object') {
    for (const [prefix, val] of Object.entries(store.counters)) {
      if (typeof val === 'number') {
        countersByPrefix.set(prefix, val);
      }
    }
  }

  const scalarConfigsByKey = new Map<
    string,
    { hadKey: boolean; json: string }
  >();
  for (const key of SCALAR_CONFIG_KEYS) {
    const hadKey = Object.prototype.hasOwnProperty.call(storeRecord, key);
    const val = storeRecord[key];
    scalarConfigsByKey.set(key, {
      hadKey,
      json: val === undefined ? 'undefined' : JSON.stringify(val),
    });
  }

  return {
    arraysByCollection,
    recentlyViewedByUser,
    countersByPrefix,
    scalarConfigsByKey,
  };
}

interface ArrayRecordDelta {
  readonly collection: string;
  readonly keyField: string;
  readonly insertedIds: string[];
  readonly updatedItems: Array<{ id: string; beforeJson: string }>;
  readonly deletedItems: Array<{
    id: string;
    beforeJson: string;
    beforeIndex: number;
  }>;
}

/**
 * Computes the exact per-record diff between `baseline` and `afterStore` and registers
 * a record-level compensating undo step on `compensator` (`R406`).
 * Returns `true` if any JSON store record or scalar setting changed.
 */
export function registerJsonStoreRecordDeltas(
  baseline: JsonStoreBaseline,
  afterStore: FirmStore,
  compensator: RecordDeltaCompensator,
  label = 'json-store.record-delta',
): boolean {
  const afterRecord = afterStore as unknown as Record<string, unknown>;
  const arrayDeltas: ArrayRecordDelta[] = [];

  for (const spec of ID_KEYED_ARRAY_COLLECTIONS) {
    const beforeMap =
      baseline.arraysByCollection.get(spec.name) ??
      new Map<string, CapturedItemEntry>();
    const afterArr = Array.isArray(afterRecord[spec.name])
      ? (afterRecord[spec.name] as Array<Record<string, unknown>>)
      : [];
    const seenAfterIds = new Set<string>();
    const insertedIds: string[] = [];
    const updatedItems: Array<{ id: string; beforeJson: string }> = [];

    for (const item of afterArr) {
      const idVal = item?.[spec.keyField];
      if (typeof idVal !== 'string' || !idVal) continue;
      seenAfterIds.add(idVal);
      const beforeEntry = beforeMap.get(idVal);
      if (!beforeEntry) {
        insertedIds.push(idVal);
      } else {
        const afterJson = JSON.stringify(item);
        if (afterJson !== beforeEntry.json) {
          updatedItems.push({ id: idVal, beforeJson: beforeEntry.json });
        }
      }
    }

    const deletedItems: Array<{
      id: string;
      beforeJson: string;
      beforeIndex: number;
    }> = [];
    for (const [idVal, beforeEntry] of beforeMap.entries()) {
      if (!seenAfterIds.has(idVal)) {
        deletedItems.push({
          id: idVal,
          beforeJson: beforeEntry.json,
          beforeIndex: beforeEntry.index,
        });
      }
    }

    if (
      insertedIds.length > 0 ||
      updatedItems.length > 0 ||
      deletedItems.length > 0
    ) {
      arrayDeltas.push({
        collection: spec.name,
        keyField: spec.keyField,
        insertedIds,
        updatedItems,
        deletedItems,
      });
    }
  }

  const recentChanges: Array<{
    userId: string;
    beforeJson: string | null;
  }> = [];
  const afterRecent = afterStore.recentlyViewed ?? {};
  const allRecentUsers = new Set<string>([
    ...baseline.recentlyViewedByUser.keys(),
    ...Object.keys(afterRecent),
  ]);
  for (const uid of allRecentUsers) {
    const beforeJson = baseline.recentlyViewedByUser.get(uid) ?? null;
    const hasAfter = Object.prototype.hasOwnProperty.call(afterRecent, uid);
    const afterJson = hasAfter ? JSON.stringify(afterRecent[uid]) : null;
    if (beforeJson !== afterJson) {
      recentChanges.push({ userId: uid, beforeJson });
    }
  }

  const scalarChanges: Array<{
    key: string;
    hadBefore: boolean;
    beforeJson: string;
  }> = [];
  for (const key of SCALAR_CONFIG_KEYS) {
    const before = baseline.scalarConfigsByKey.get(key)!;
    const val = afterRecord[key];
    const afterJson = val === undefined ? 'undefined' : JSON.stringify(val);
    if (afterJson !== before.json) {
      scalarChanges.push({
        key,
        hadBefore: before.hadKey,
        beforeJson: before.json,
      });
    }
  }

  const hasAnyDelta =
    arrayDeltas.length > 0 ||
    recentChanges.length > 0 ||
    scalarChanges.length > 0;

  if (!hasAnyDelta) {
    return false;
  }

  compensator.register(label, () => {
    const liveStore = getStore();
    const liveRecord = liveStore as unknown as Record<string, unknown>;

    for (const delta of arrayDeltas) {
      let arr = liveRecord[delta.collection] as
        | Array<Record<string, unknown>>
        | undefined;
      if (!Array.isArray(arr)) {
        arr = [];
        liveRecord[delta.collection] = arr;
      }
      if (delta.insertedIds.length > 0) {
        const removeSet = new Set(delta.insertedIds);
        for (let i = arr.length - 1; i >= 0; i--) {
          const itemKey = arr[i]?.[delta.keyField];
          if (typeof itemKey === 'string' && removeSet.has(itemKey)) {
            arr.splice(i, 1);
          }
        }
      }
      for (const upd of delta.updatedItems) {
        const idx = arr.findIndex((x) => x?.[delta.keyField] === upd.id);
        const restored = JSON.parse(upd.beforeJson) as Record<string, unknown>;
        if (idx >= 0) {
          arr[idx] = restored;
        } else {
          arr.push(restored);
        }
      }
      const sortedDeleted = [...delta.deletedItems].sort(
        (a, b) => a.beforeIndex - b.beforeIndex,
      );
      for (const del of sortedDeleted) {
        const existsNow = arr.some((x) => x?.[delta.keyField] === del.id);
        if (!existsNow) {
          const restored = JSON.parse(del.beforeJson) as Record<string, unknown>;
          const insertAt = Math.min(Math.max(0, del.beforeIndex), arr.length);
          arr.splice(insertAt, 0, restored);
        }
      }
    }

    if (recentChanges.length > 0) {
      liveStore.recentlyViewed = liveStore.recentlyViewed ?? {};
      for (const rc of recentChanges) {
        if (rc.beforeJson === null) {
          delete liveStore.recentlyViewed[rc.userId];
        } else {
          liveStore.recentlyViewed[rc.userId] = JSON.parse(
            rc.beforeJson,
          ) as string[];
        }
      }
    }

    for (const sc of scalarChanges) {
      if (!sc.hadBefore || sc.beforeJson === 'undefined') {
        delete liveRecord[sc.key];
      } else {
        liveRecord[sc.key] = JSON.parse(sc.beforeJson);
      }
    }

    saveStore(liveStore);
  });

  return true;
}

/**
 * Stages an audit entry inside an active unmoved-module mutation scope without touching `store.audit`.
 * Provisional `id` is replaced with the sequence-allocated `AU-NNNNNN` ID when persisted to PostgreSQL.
 */
export function stageUnmigratedAuditEntry(
  entry: Omit<AuditEntry, 'id' | 'at'> & { id?: string; at?: string },
): AuditEntry {
  const atIso = entry.at ?? new Date().toISOString();
  const stagedInput: FirmAuditEntryInput = {
    ...(entry.id ? { id: entry.id } : {}),
    recordType: entry.recordType,
    recordId: entry.recordId,
    action: entry.action,
    field: entry.field,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    byId: entry.byId,
    at: atIso,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.snapshot !== undefined ? { snapshot: entry.snapshot } : {}),
  };

  const activeScope = getAuditStagingStorage()?.getStore();
  if (activeScope) {
    activeScope.stagedEntries.push(stagedInput);
  }

  return {
    id: entry.id ?? 'AU-PENDING',
    at: atIso,
    recordType: entry.recordType,
    recordId: entry.recordId,
    action: entry.action,
    field: entry.field,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    byId: entry.byId,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.snapshot !== undefined ? { snapshot: entry.snapshot } : {}),
  };
}

/**
 * Appends audit entries for unmoved JSON modules to PostgreSQL `public.audit_entries`.
 */
export async function appendUnmigratedModuleAuditEntries(
  ctx: TenantContext,
  entries: readonly FirmAuditEntryInput[],
): Promise<FirmAuditEntryRecord[]> {
  if (entries.length === 0) {
    return [];
  }
  if (testAuditFailureHook) {
    await testAuditFailureHook({ ctx, entries });
  }
  const repo = getAuditRepository();
  return repo.appendAuditEntries(ctx, entries);
}

/**
 * Runs an unmoved-module JSON store mutation inside `withJsonStoreWriteLock` (`R406`, `R418`):
 * - Captures per-record baseline before executing `fn`,
 * - Stages any `stageUnmigratedAuditEntry` (`writeAudit`) calls made during `fn`,
 * - Registers exact per-record JSON delta compensation onto `RecordDeltaCompensator` (`R406`),
 * - Persists `audit_entries` to PostgreSQL via `appendUnmigratedModuleAuditEntries` (reverting
 *   this operation's per-record JSON delta if PostgreSQL throws!).
 */
export async function runUnmigratedJsonMutationWithAudit<T>(params: {
  resolveCtx: (store: FirmStore, result: T) => TenantContext | null;
  mutate: (
    store: FirmStore,
    compensator: RecordDeltaCompensator,
  ) => Promise<T>;
  label?: string;
}): Promise<T> {
  return withJsonStoreWriteLock(async (compensator) => {
    const store = getStore();
    const baseline = captureJsonStoreBaseline(store);
    const stagingStorage = getAuditStagingStorage();
    const stagedEntries: FirmAuditEntryInput[] = [];

    const executeMutate = async () => params.mutate(store, compensator);
    let result: T;
    try {
      result = stagingStorage
        ? await stagingStorage.run({ stagedEntries }, executeMutate)
        : await executeMutate();
    } catch (err) {
      // A nested locked call (R418) may fail after this operation has already changed records;
      // register this operation's own delta so the outermost frame reverts it (R406).
      registerJsonStoreRecordDeltas(
        baseline,
        store,
        compensator,
        params.label ?? 'json-store.record-delta',
      );
      throw err;
    }

    registerJsonStoreRecordDeltas(
      baseline,
      store,
      compensator,
      params.label ?? 'json-store.record-delta',
    );

    if (stagedEntries.length > 0) {
      const ctx = params.resolveCtx(store, result);
      if (!ctx) {
        throw new Error(
          'TENANCY_AUTH_ERROR: Cannot write firm audit entries without a resolved TenantContext.',
        );
      }
      await appendUnmigratedModuleAuditEntries(ctx, stagedEntries);
    }

    return result;
  });
}

export function getActiveCompensatorOrNull(): RecordDeltaCompensator | null {
  return getActiveRecordDeltaCompensator();
}
