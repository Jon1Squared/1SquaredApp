/**
 * Temporary PostgreSQL Audit Adapter & Per-Record JSON Delta Compensator
 * (`src/server/auditAdapter.ts`).
 *
 * Implements ADR 0028 §§4–5 & `S0-15`/`S0-16` (`Owner Decision 4`, `Owner Decision 5`, `R406`, `R418`, `R420`, `R469`):
 * - While unmoved modules still persist primary records in `FirmStore` (`src/server/store.ts`),
 *   their audit entries write to PostgreSQL `public.audit_entries` (`TenantAuditRepository`) inside
 *   `withJsonStoreWriteLock`.
 * - NEVER restores a whole-store clone snapshot (`R406`). Instead,
 *   `captureJsonStoreBaseline` + `registerJsonStoreRecordDeltas` compute exact per-record ID deltas
 *   (`inserted`, `updated`, `deleted` items by ID, plus touched scalar settings keys) and register a
 *   record-level compensating callback onto `RecordDeltaCompensator`. If the PostgreSQL `audit_entries`
 *   transaction (or an outer cross-module step in a nested re-entrant lock chain, `R418`) fails, ONLY
 *   this operation's unmoved JSON record deltas are reverted in memory and on disk (`saveStore`), leaving
 *   any other operation's records untouched.
 *
 * Retirement schedule:
 * - @remove-in S0-17c: Firm settings, Choice Lists/Values, Custom Fields, Org Structure, Party Taxonomy, Home/Costs configs
 * - @remove-in S0-18: PMS Links (`pmsLinks`)
 * - Deleted completely in `S0-20` alongside `src/server/store.ts` and `src/server/storeLock.ts`.
 */

import {
  TenantAuditRepository,
  TenantCatalogueRepository,
  TenantHrAndRbacRepository,
  TenantIntakeQuoteRepository,
  TenantMatterRepository,
  TenantPartyRepository,
  TenantTaskWorkflowRepository,
  type FirmAuditEntryInput,
  type FirmAuditEntryRecord,
  type TenantContext,
} from '@platform/core';
import { getActiveActorSession } from '@/domain/rbac';
import type { AuditEntry } from '@/domain/types';
import {
  getActiveTenantConfiguration,
  getCatalogueRepository,
  getHrAndRbacRepository,
  getIntakeQuoteRepository,
  getMatterRepository,
  getPartyRepository,
  getTaskWorkflowRepository,
} from '@/platform/tenantRuntime';
import { resolveRequestCorrelationId } from './correlationId';
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

const auditRepositoryInstance = new TenantAuditRepository();
let auditRepositoryOverrideForTesting: TenantAuditRepository | null = null;

export function getAuditRepository(): TenantAuditRepository {
  return auditRepositoryOverrideForTesting ?? auditRepositoryInstance;
}

export function setAuditRepositoryOverrideForTesting(
  override: TenantAuditRepository | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'SECURITY_ERROR: setAuditRepositoryOverrideForTesting is only permitted when NODE_ENV === "test".',
    );
  }
  auditRepositoryOverrideForTesting = override;
}

export {
  getCatalogueRepository,
  getHrAndRbacRepository,
  getIntakeQuoteRepository,
  getMatterRepository,
  getPartyRepository,
  getTaskWorkflowRepository,
  TenantCatalogueRepository,
  TenantHrAndRbacRepository,
  TenantIntakeQuoteRepository,
  TenantMatterRepository,
  TenantPartyRepository,
  TenantTaskWorkflowRepository,
};

/**
 * Keys on `FirmStore` that have already moved to PostgreSQL (or are monotonic sequence counters)
 * and are therefore excluded from JSON store delta compensation (`R442`, `R468`, `R469`).
 */
export type MovedToPostgresKeys =
  | 'audit'
  | 'counters'
  | 'documentTemplates'
  | 'documentTemplateVersions'
  | 'documents'
  | 'documentLinks'
  | 'templateUsageEvents'
  | 'matterDocumentLocations'
  | 'documentStoreFolderScopes'
  | 'documentLifecycleJobs'
  | 'documentReconciliationFindings'
  | 'documentStoreAuditEvents'
  | 'keyDates'
  | 'keyDateNotApplicable'
  | 'keyDateReminderStates'
  | 'keyDateCalendarSyncs'
  | 'keyDatesConfigOverride'
  | 'people'
  | 'organisations'
  | 'links'
  | 'matters'
  | 'notes'
  | 'mergeHistory'
  | 'tasks'
  | 'enquiries'
  | 'quotes'
  | 'notifications'
  | 'signOffs'
  | 'recentlyViewed'
  | 'teams'
  | 'employeeSensitiveRecords'
  | 'employeeMigrationReport'
  | 'rbacConfigOverride'
  | 'firmId'
  | 'isCleanDeployment'
  | 'firm'
  | 'lists'
  | 'values'
  | 'customFields'
  | 'enquirySettings'
  | 'taskSettings'
  | 'homePagesConfig'
  | 'orgStructure'
  | 'matterPartyTaxonomy'
  | 'matterPartyMigrationReport'
  | 'matterCostsConfig'
  | 'documentGenerationConfigOverride'
  | 'documentStoreConfigOverride';

export type TrackedFirmStoreKeys = Exclude<keyof FirmStore, MovedToPostgresKeys>;

/**
 * Unmoved ID-keyed array collections in `FirmStore` tracked for per-record delta compensation (`R406`, `R442`).
 */
const ID_KEYED_ARRAY_COLLECTIONS = [
  { name: 'pmsLinks', keyField: 'id' },
] as const;

/**
 * Unmoved per-key map properties on `FirmStore` tracked per entry (`R442`).
 */
const PER_KEY_MAP_KEYS = [] as const;

/**
 * Unmoved scalar / configuration properties on `FirmStore` tracked individually (`R442`).
 */
const SCALAR_CONFIG_KEYS = [] as const;

type RepresentedTrackedFirmStoreKey =
  | (typeof ID_KEYED_ARRAY_COLLECTIONS)[number]['name']
  | (typeof PER_KEY_MAP_KEYS)[number]
  | (typeof SCALAR_CONFIG_KEYS)[number];

const _exhaustiveTrackedFirmStoreCheck = {
  missingFromTracked: undefined as Exclude<
    TrackedFirmStoreKeys,
    RepresentedTrackedFirmStoreKey
  >,
  extraInTracked: undefined as Exclude<
    RepresentedTrackedFirmStoreKey,
    TrackedFirmStoreKeys
  >,
} satisfies { missingFromTracked: never; extraInTracked: never };
void _exhaustiveTrackedFirmStoreCheck;

interface CapturedItemEntry {
  readonly json: string;
  readonly index: number;
}

export interface JsonStoreBaseline {
  readonly arraysByCollection: Map<string, Map<string, CapturedItemEntry>>;
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
 * Returns `true` if any unmoved JSON store record or scalar setting changed.
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

  const hasAnyDelta = arrayDeltas.length > 0 || scalarChanges.length > 0;

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

    for (const sc of scalarChanges) {
      if (!sc.hadBefore || sc.beforeJson === 'undefined') {
        delete liveRecord[sc.key];
      } else {
        liveRecord[sc.key] = JSON.parse(sc.beforeJson);
      }
    }

    try {
      saveStore(liveStore);
    } catch (saveErr) {
      if (label === 'executeMerge') {
        const session = getActiveActorSession();
        const tenantId =
          session?.tenantId ?? getActiveTenantConfiguration().tenantId;
        const correlationId = resolveRequestCorrelationId(
          (
            session?.verifiedSession as
              | { correlationId?: string }
              | undefined
          )?.correlationId,
          'corr-merge-rollback',
        );
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'merge.rollback_save_failed',
            correlationId,
            tenantId,
          }),
        );
        if (saveErr && typeof saveErr === 'object') {
          (
            saveErr as { __alreadyLoggedCompensationFailure?: boolean }
          ).__alreadyLoggedCompensationFailure = true;
        }
      }
      throw saveErr;
    }
  });

  return true;
}

/**
 * Stages an audit entry inside an active unmoved-module mutation scope without touching `store.audit` (`R444`).
 * Throws `TENANCY_AUDIT_WRITE_ERROR` if called outside an active `runUnmigratedJsonMutationWithAudit` scope.
 */
export function stageUnmigratedAuditEntry(
  entry: Omit<AuditEntry, 'id' | 'at'> & { id?: string; at?: string },
): AuditEntry {
  const activeScope = getAuditStagingStorage()?.getStore();
  if (!activeScope) {
    const err = new Error(
      'TENANCY_AUDIT_WRITE_ERROR: writeAudit was called outside an active audit staging scope.',
    ) as Error & { code: string };
    err.code = 'TENANCY_AUDIT_WRITE_ERROR';
    throw err;
  }

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

  activeScope.stagedEntries.push(stagedInput);

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
  const repo = getAuditRepository();
  return repo.appendAuditEntries(ctx, entries);
}

/**
 * Runs a PostgreSQL-backed service mutation inside an active audit staging scope
 * so `writeAudit` + `flushStagedAuditEntries(ctx)` commit atomically inside `withTenantTransaction`.
 */
export async function runWithAuditStagingScope<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const stagingStorage = getAuditStagingStorage();
  if (!stagingStorage) {
    return fn();
  }
  return stagingStorage.run({ stagedEntries: [] }, fn);
}

/**
 * Drains and appends all currently staged audit entries inside the active scope
 * (joining an active `withTenantTransaction` if called inside one).
 */
export async function flushStagedAuditEntries(
  ctx: TenantContext,
): Promise<FirmAuditEntryRecord[]> {
  const activeScope = getAuditStagingStorage()?.getStore();
  if (!activeScope || activeScope.stagedEntries.length === 0) {
    return [];
  }
  const entries = activeScope.stagedEntries.splice(
    0,
    activeScope.stagedEntries.length,
  );
  return appendUnmigratedModuleAuditEntries(ctx, entries);
}

/**
 * Runs an unmoved-module JSON store mutation inside `withJsonStoreWriteLock` (`R406`, `R418`, `R446`):
 * - Only the outermost `runUnmigratedJsonMutationWithAudit` frame captures the JSON store baseline,
 *   registers the single per-record delta undo step, and appends all staged `audit_entries` in one
 *   PostgreSQL transaction.
 * - Nested frames push their staged entries onto the outer scope and skip baseline/undo/append so
 *   overlapping record mutations revert cleanly to the pre-outer state and never commit inner audit
 *   rows before the outer frame succeeds (`R446`).
 */
export async function runUnmigratedJsonMutationWithAudit<T>(params: {
  resolveCtx: (store: FirmStore, result: T) => TenantContext | null;
  mutate: (
    store: FirmStore,
    compensator: RecordDeltaCompensator,
  ) => Promise<T>;
  label?: string;
}): Promise<T> {
  const stagingStorage = getAuditStagingStorage();
  const outerScope = stagingStorage?.getStore();
  if (outerScope) {
    return withJsonStoreWriteLock(async (compensator) =>
      params.mutate(getStore(), compensator),
    );
  }

  return withJsonStoreWriteLock(async (compensator) => {
    const store = getStore();
    const baseline = captureJsonStoreBaseline(store);
    const stagedEntries: FirmAuditEntryInput[] = [];

    const executeBody = async (): Promise<T> => {
      const executeMutate = async () => params.mutate(store, compensator);
      let result: T;
      try {
        result = stagingStorage
          ? await stagingStorage.run({ stagedEntries }, executeMutate)
          : await executeMutate();
      } catch (err) {
        registerJsonStoreRecordDeltas(
          baseline,
          store,
          compensator,
          params.label ?? 'json-store.record-delta',
        );
        throw err;
      }

      const storeMutated = registerJsonStoreRecordDeltas(
        baseline,
        store,
        compensator,
        params.label ?? 'json-store.record-delta',
      );

      if (stagedEntries.length > 0 || storeMutated) {
        const ctx = params.resolveCtx(store, result);
        if (!ctx) {
          throw new Error(
            'TENANCY_AUTH_ERROR: Cannot write firm audit entries without a resolved TenantContext.',
          );
        }
        if (stagedEntries.length > 0) {
          await appendUnmigratedModuleAuditEntries(ctx, stagedEntries);
        }
      }

      return result;
    };

    let preCtx: TenantContext | null = null;
    try {
      preCtx = params.resolveCtx(store, undefined as unknown as T);
    } catch {
      preCtx = null;
    }

    if (preCtx) {
      return getAuditRepository().withTenantTransaction(preCtx, executeBody);
    }
    return executeBody();
  });
}

export function getActiveCompensatorOrNull(): RecordDeltaCompensator | null {
  return getActiveRecordDeltaCompensator();
}
