/**
 * Temporary PostgreSQL Audit Adapter & Per-Record JSON Delta Compensator
 * (`src/server/auditAdapter.ts`).
 *
 * Implements ADR 0028 §§4–5 & `S0-15` (`Owner Decision 4`, `Owner Decision 5`, `R406`, `R418`, `R420`):
 * - While unmoved modules still persist primary records in `FirmStore` (`src/server/store.ts`),
 *   their audit entries write to PostgreSQL `public.audit_entries` (`TenantAuditRepository`) inside
 *   `withJsonStoreWriteLock`.
 * - NEVER restores a whole-store clone snapshot (`R406`). Instead,
 *   `captureJsonStoreBaseline` + `registerJsonStoreRecordDeltas` compute exact per-record ID deltas
 *   (`inserted`, `updated`, `deleted` items by ID, plus touched scalar settings keys) and register a
 *   record-level compensating callback onto `RecordDeltaCompensator`. If the PostgreSQL `audit_entries`
 *   transaction (or an outer cross-module step in a nested re-entrant lock chain, `R418`) fails, ONLY
 *   this operation's record deltas are reverted in memory and on disk (`saveStore`), leaving any other
 *   operation's records untouched.
 *
 * Retirement schedule:
 * - @remove-in S0-17a: Enquiries, Quotes, Tasks, Notifications, Sign-Offs, Recently Viewed
 * - @remove-in S0-17b: Employment, Sensitive/Payroll HR records, Teams, RBAC overrides
 * - @remove-in S0-17c: Firm settings, Choice Lists/Values, Custom Fields, Org Structure, Party Taxonomy, Home/Costs configs
 * - @remove-in S0-18: PMS Links (`pmsLinks`)
 * - Deleted completely in `S0-20` alongside `src/server/store.ts` and `src/server/storeLock.ts`.
 */

import {
  MATTER_CONCURRENCY_CONFLICT_CODE,
  MATTER_CONCURRENCY_CONFLICT_MESSAGE,
  TenantAuditRepository,
  TenantMatterRepository,
  TenantPartyRepository,
  type FirmAuditEntryInput,
  type FirmAuditEntryRecord,
  type TenantContext,
  type TenantMatterRecord,
  type TenantMergeHistoryRecord,
  type TenantNoteRecord,
  type TenantOrganisationRecord,
  type TenantPersonOrganisationLinkRecord,
  type TenantPersonRecord,
} from '@platform/core';
import { getActiveActorSession } from '@/domain/rbac';
import type {
  AuditEntry,
  EmployeeSensitiveRecord,
  Matter,
  MergeHistory,
  Note,
  Organisation,
  Person,
  PersonOrganisationLink,
} from '@/domain/types';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import { resolveRequestCorrelationId } from './correlationId';
import { getStore, saveStore, type FirmStore } from './store';
import {
  getActiveRecordDeltaCompensator,
  withJsonStoreWriteLock,
  type RecordDeltaCompensator,
} from './storeLock';
import { computeMatterRestrictionMetadataForStore } from './storePostgresImport';

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

interface TenantPartiesMattersSyncState {
  peopleById: Map<string, string>;
  organisationsById: Map<string, string>;
  linksById: Map<string, string>;
  notesById: Map<string, string>;
  mergeHistoryById: Map<string, string>;
  mattersById: Map<string, string>;
  matterRowVersionById: Map<string, number>;
  storeResetGeneration: number;
  pgWriteSeq: number;
}

declare global {
  var __oneSquaredAuditRepo: TenantAuditRepository | undefined;
  var __oneSquaredPartyRepo: TenantPartyRepository | undefined;
  var __oneSquaredMatterRepo: TenantMatterRepository | undefined;
  var __oneSquaredPartiesMattersSyncByDb:
    | Map<string, TenantPartiesMattersSyncState>
    | undefined;
}

export function getAuditRepository(): TenantAuditRepository {
  if (!global.__oneSquaredAuditRepo) {
    global.__oneSquaredAuditRepo = new TenantAuditRepository();
  }
  return global.__oneSquaredAuditRepo;
}

export function getPartyRepository(): TenantPartyRepository {
  if (!global.__oneSquaredPartyRepo) {
    global.__oneSquaredPartyRepo = new TenantPartyRepository();
  }
  return global.__oneSquaredPartyRepo;
}

export function getMatterRepository(): TenantMatterRepository {
  if (!global.__oneSquaredMatterRepo) {
    global.__oneSquaredMatterRepo = new TenantMatterRepository();
  }
  return global.__oneSquaredMatterRepo;
}

function getPartiesMattersSyncCache(): Map<string, TenantPartiesMattersSyncState> {
  if (!global.__oneSquaredPartiesMattersSyncByDb) {
    global.__oneSquaredPartiesMattersSyncByDb = new Map();
  }
  return global.__oneSquaredPartiesMattersSyncByDb;
}

function serializeMatterWithoutRowVersion(matter: Matter | TenantMatterRecord): string {
  const { rowVersion: _rv, ...rest } = matter as Matter & { rowVersion?: number };
  void _rv;
  return JSON.stringify(rest);
}

function buildSyncStateFromStore(
  store: FirmStore,
  rowVersionOverrides?: ReadonlyMap<string, number>,
): TenantPartiesMattersSyncState {
  const peopleById = new Map<string, string>();
  for (const p of store.people ?? []) {
    peopleById.set(p.id, JSON.stringify(p));
  }
  const organisationsById = new Map<string, string>();
  for (const o of store.organisations ?? []) {
    organisationsById.set(o.id, JSON.stringify(o));
  }
  const linksById = new Map<string, string>();
  for (const l of store.links ?? []) {
    linksById.set(l.id, JSON.stringify(l));
  }
  const notesById = new Map<string, string>();
  for (const n of store.notes ?? []) {
    notesById.set(n.id, JSON.stringify(n));
  }
  const mergeHistoryById = new Map<string, string>();
  for (const mh of store.mergeHistory ?? []) {
    mergeHistoryById.set(mh.id, JSON.stringify(mh));
  }
  const mattersById = new Map<string, string>();
  const matterRowVersionById = new Map<string, number>();
  for (const m of store.matters ?? []) {
    const rv =
      rowVersionOverrides?.get(m.id) ??
      (typeof m.rowVersion === 'number' &&
      Number.isInteger(m.rowVersion) &&
      m.rowVersion >= 1
        ? m.rowVersion
        : 1);
    if (m.rowVersion === undefined) {
      m.rowVersion = rv;
    }
    mattersById.set(m.id, serializeMatterWithoutRowVersion(m));
    matterRowVersionById.set(m.id, rv);
  }
  return {
    peopleById,
    organisationsById,
    linksById,
    notesById,
    mergeHistoryById,
    mattersById,
    matterRowVersionById,
    storeResetGeneration: global.__oneSquaredStoreResetGeneration ?? 0,
    pgWriteSeq: global.__oneSquaredPostgresPartiesMattersWriteSeq ?? 0,
  };
}

export function markPartiesAndMattersSyncedWithStore(
  store: FirmStore,
  ctx: TenantContext,
  rowVersionOverrides?: ReadonlyMap<string, number>,
): void {
  getPartiesMattersSyncCache().set(
    ctx.postgresDatabaseName,
    buildSyncStateFromStore(store, rowVersionOverrides),
  );
}

export function invalidatePartiesAndMattersSyncCache(
  postgresDatabaseName?: string,
): void {
  const cache = getPartiesMattersSyncCache();
  if (postgresDatabaseName) {
    cache.delete(postgresDatabaseName);
  } else {
    cache.clear();
  }
}

function updateCounterHighWater(
  store: FirmStore,
  prefix: 'P' | 'O' | 'L' | 'N' | 'M',
  ids: readonly string[],
): void {
  const regex = new RegExp(`^${prefix}-(\\d+)$`);
  let maxVal = store.counters?.[prefix] ?? 0;
  for (const id of ids) {
    const m = regex.exec(id);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxVal) {
        maxVal = n;
      }
    }
  }
  if (store.counters) {
    store.counters[prefix] = maxVal;
  }
}

function mergeOrderedFromPostgres<T extends { id: string }>(
  currentInMemory: readonly T[],
  pgRows: readonly T[],
): T[] {
  const pgById = new Map<string, T>();
  for (const r of pgRows) {
    pgById.set(r.id, r);
  }
  const result: T[] = [];
  const seen = new Set<string>();
  for (const existing of currentInMemory) {
    const pgRow = pgById.get(existing.id);
    if (pgRow) {
      const target = existing as unknown as Record<string, unknown>;
      const source = pgRow as unknown as Record<string, unknown>;
      for (const k of Object.keys(target)) {
        if (!Object.prototype.hasOwnProperty.call(source, k)) {
          delete target[k];
        }
      }
      Object.assign(target, source);
      result.push(existing);
      seen.add(existing.id);
    }
  }
  for (const pgRow of pgRows) {
    if (!seen.has(pgRow.id)) {
      result.push(pgRow);
    }
  }
  return result;
}

/**
 * Reconciles `store.people`, `store.organisations`, `store.links`, `store.notes`,
 * `store.mergeHistory`, and `store.matters` with PostgreSQL (`S0-16`):
 * - Fast path (0 SQL queries) when neither `store` nor PostgreSQL has changed since the last sync.
 * - If a test called `resetStore()` / `clearStoreToCleanDeployment()` synchronously, resets and
 *   imports `store`'s parties & matters into PostgreSQL (preserving `matter_number_sequences`, `B6`).
 * - If a test mutated `store` directly in memory, pushes those per-record diffs to PostgreSQL.
 * - If `TenantPartyRepository` or `TenantMatterRepository` wrote directly to PostgreSQL, hydrates
 *   `store` in place from PostgreSQL.
 */
export async function syncAndHydratePartiesAndMattersFromPostgres(
  store: FirmStore,
  ctx: TenantContext,
): Promise<void> {
  const cache = getPartiesMattersSyncCache();
  const dbKey = ctx.postgresDatabaseName;
  const state = cache.get(dbKey);
  const currentResetGen = global.__oneSquaredStoreResetGeneration ?? 0;
  const currentPgWriteSeq = global.__oneSquaredPostgresPartiesMattersWriteSeq ?? 0;
  const lastResetAtWriteSeq =
    ((global as Record<string, unknown>).__oneSquaredLastResetAtWriteSeq as
      | number
      | undefined) ?? 0;
  const isInMemoryTestEnv =
    Boolean(process.env.VITEST || process.env.NODE_ENV === 'test') &&
    !process.env.ONESQUARED_RUNTIME_STORE_PATH;
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const tenantCfg = getActiveTenantConfiguration();

  if (
    (state && state.storeResetGeneration !== currentResetGen) ||
    (!state && isInMemoryTestEnv && currentPgWriteSeq <= lastResetAtWriteSeq)
  ) {
    await partyRepo.withTenantTransaction(ctx, async () => {
      await matterRepo.clearTenantData(ctx, { resetMatterNumberSequences: false });
      await partyRepo.clearTenantData(ctx);
      await partyRepo.putPeople(
        ctx,
        (store.people ?? []) as unknown as TenantPersonRecord[],
      );
      await partyRepo.putOrganisations(
        ctx,
        (store.organisations ?? []) as unknown as TenantOrganisationRecord[],
      );
      await partyRepo.putLinks(
        ctx,
        (store.links ?? []) as unknown as TenantPersonOrganisationLinkRecord[],
      );
      await partyRepo.putNotes(
        ctx,
        (store.notes ?? []) as unknown as TenantNoteRecord[],
      );
      await partyRepo.putMergeHistoryRecords(
        ctx,
        (store.mergeHistory ?? []) as unknown as TenantMergeHistoryRecord[],
      );
      const sqlRestrictions = new Map<string, readonly string[]>();
      for (const m of store.matters ?? []) {
        const meta = computeMatterRestrictionMetadataForStore(
          m,
          store.people ?? [],
          store.teams ?? [],
          tenantCfg,
        );
        sqlRestrictions.set(m.id, meta.restrictedAccessUserIds);
      }
      const importedMatters = await matterRepo.importMatters(
        ctx,
        (store.matters ?? []) as unknown as TenantMatterRecord[],
        { sqlRestrictedAccessUserIdsByMatterId: sqlRestrictions },
      );
      const rvMap = new Map<string, number>();
      for (const im of importedMatters) {
        rvMap.set(im.id, im.rowVersion ?? 1);
      }
      for (const m of store.matters ?? []) {
        m.rowVersion = rvMap.get(m.id) ?? 1;
      }
    });
    markPartiesAndMattersSyncedWithStore(store, ctx);
    return;
  }

  if (!state) {
    const [pgPeople, pgOrgs, pgLinks, pgNotes, pgMerges, pgMatters] =
      await partyRepo.withTenantReadTransaction(ctx, async () => {
        const people = await partyRepo.listAllPeople<Person>(ctx);
        const orgs = await partyRepo.listAllOrganisations<Organisation>(ctx);
        const links =
          await partyRepo.listAllLinks<PersonOrganisationLink>(ctx);
        const notes = await partyRepo.listAllNotes<Note>(ctx);
        const merges = await partyRepo.listAllMergeHistory<MergeHistory>(ctx);
        const matters =
          await matterRepo.listAllMattersUnfiltered<Matter>(ctx);
        return [people, orgs, links, notes, merges, matters] as const;
      });

    if (
      pgPeople.length === 0 &&
      pgOrgs.length === 0 &&
      pgMatters.length === 0 &&
      !store.isCleanDeployment &&
      (store.people.length > 0 || store.matters.length > 0)
    ) {
      await partyRepo.withTenantTransaction(ctx, async () => {
        await partyRepo.putPeople(
          ctx,
          (store.people ?? []) as unknown as TenantPersonRecord[],
        );
        await partyRepo.putOrganisations(
          ctx,
          (store.organisations ?? []) as unknown as TenantOrganisationRecord[],
        );
        await partyRepo.putLinks(
          ctx,
          (store.links ?? []) as unknown as TenantPersonOrganisationLinkRecord[],
        );
        await partyRepo.putNotes(
          ctx,
          (store.notes ?? []) as unknown as TenantNoteRecord[],
        );
        await partyRepo.putMergeHistoryRecords(
          ctx,
          (store.mergeHistory ?? []) as unknown as TenantMergeHistoryRecord[],
        );
        const sqlRestrictions = new Map<string, readonly string[]>();
        for (const m of store.matters ?? []) {
          const meta = computeMatterRestrictionMetadataForStore(
            m,
            store.people ?? [],
            store.teams ?? [],
            tenantCfg,
          );
          sqlRestrictions.set(m.id, meta.restrictedAccessUserIds);
        }
        const importedMatters = await matterRepo.importMatters(
          ctx,
          (store.matters ?? []) as unknown as TenantMatterRecord[],
          { sqlRestrictedAccessUserIdsByMatterId: sqlRestrictions },
        );
        const rvMap = new Map<string, number>();
        for (const im of importedMatters) {
          rvMap.set(im.id, im.rowVersion ?? 1);
        }
        for (const m of store.matters ?? []) {
          m.rowVersion = rvMap.get(m.id) ?? 1;
        }
      });
      markPartiesAndMattersSyncedWithStore(store, ctx);
      return;
    }

    store.people = mergeOrderedFromPostgres(store.people ?? [], pgPeople);
    store.organisations = mergeOrderedFromPostgres(
      store.organisations ?? [],
      pgOrgs,
    );
    store.links = mergeOrderedFromPostgres(store.links ?? [], pgLinks);
    store.notes = mergeOrderedFromPostgres(store.notes ?? [], pgNotes);
    store.mergeHistory = mergeOrderedFromPostgres(
      store.mergeHistory ?? [],
      pgMerges,
    );
    store.matters = mergeOrderedFromPostgres(store.matters ?? [], pgMatters);
    updateCounterHighWater(
      store,
      'P',
      store.people.map((x) => x.id),
    );
    updateCounterHighWater(
      store,
      'O',
      store.organisations.map((x) => x.id),
    );
    updateCounterHighWater(
      store,
      'L',
      store.links.map((x) => x.id),
    );
    updateCounterHighWater(
      store,
      'N',
      store.notes.map((x) => x.id),
    );
    updateCounterHighWater(
      store,
      'M',
      store.matters.map((x) => x.id),
    );
    markPartiesAndMattersSyncedWithStore(store, ctx);
    return;
  }

  // Check if in-memory store was mutated directly since `state` was recorded
  const changedPeople: Person[] = [];
  const deletedPersonIds: string[] = [];
  const seenPeople = new Set<string>();
  for (const p of store.people ?? []) {
    seenPeople.add(p.id);
    if (state.peopleById.get(p.id) !== JSON.stringify(p)) {
      changedPeople.push(p);
    }
  }
  for (const id of state.peopleById.keys()) {
    if (!seenPeople.has(id)) deletedPersonIds.push(id);
  }

  const changedOrgs: Organisation[] = [];
  const deletedOrgIds: string[] = [];
  const seenOrgs = new Set<string>();
  for (const o of store.organisations ?? []) {
    seenOrgs.add(o.id);
    if (state.organisationsById.get(o.id) !== JSON.stringify(o)) {
      changedOrgs.push(o);
    }
  }
  for (const id of state.organisationsById.keys()) {
    if (!seenOrgs.has(id)) deletedOrgIds.push(id);
  }

  const changedLinks: PersonOrganisationLink[] = [];
  const deletedLinkIds: string[] = [];
  const seenLinks = new Set<string>();
  for (const l of store.links ?? []) {
    seenLinks.add(l.id);
    if (state.linksById.get(l.id) !== JSON.stringify(l)) {
      changedLinks.push(l);
    }
  }
  for (const id of state.linksById.keys()) {
    if (!seenLinks.has(id)) deletedLinkIds.push(id);
  }

  const changedNotes: Note[] = [];
  const deletedNoteIds: string[] = [];
  const seenNotes = new Set<string>();
  for (const n of store.notes ?? []) {
    seenNotes.add(n.id);
    if (state.notesById.get(n.id) !== JSON.stringify(n)) {
      changedNotes.push(n);
    }
  }
  for (const id of state.notesById.keys()) {
    if (!seenNotes.has(id)) deletedNoteIds.push(id);
  }

  const changedMerges: MergeHistory[] = [];
  const deletedMergeIds: string[] = [];
  const seenMerges = new Set<string>();
  for (const mh of store.mergeHistory ?? []) {
    seenMerges.add(mh.id);
    if (state.mergeHistoryById.get(mh.id) !== JSON.stringify(mh)) {
      changedMerges.push(mh);
    }
  }
  for (const id of state.mergeHistoryById.keys()) {
    if (!seenMerges.has(id)) deletedMergeIds.push(id);
  }

  const changedMatters: Matter[] = [];
  const deletedMatterIds: string[] = [];
  const seenMatters = new Set<string>();
  for (const m of store.matters ?? []) {
    seenMatters.add(m.id);
    if (m.rowVersion === undefined) {
      m.rowVersion = state.matterRowVersionById.get(m.id) ?? 1;
    }
    if (state.mattersById.get(m.id) !== serializeMatterWithoutRowVersion(m)) {
      changedMatters.push(m);
    }
  }
  for (const id of state.mattersById.keys()) {
    if (!seenMatters.has(id)) deletedMatterIds.push(id);
  }

  const hasInMemoryStoreChanges =
    changedPeople.length > 0 ||
    deletedPersonIds.length > 0 ||
    changedOrgs.length > 0 ||
    deletedOrgIds.length > 0 ||
    changedLinks.length > 0 ||
    deletedLinkIds.length > 0 ||
    changedNotes.length > 0 ||
    deletedNoteIds.length > 0 ||
    changedMerges.length > 0 ||
    deletedMergeIds.length > 0 ||
    changedMatters.length > 0 ||
    deletedMatterIds.length > 0;

  if (!hasInMemoryStoreChanges && state.pgWriteSeq === currentPgWriteSeq) {
    return;
  }

  if (hasInMemoryStoreChanges) {
    await partyRepo.withTenantTransaction(ctx, async () => {
      for (const id of deletedMergeIds) {
        await partyRepo.deleteMergeHistoryById(ctx, id);
      }
      for (const id of deletedNoteIds) {
        await partyRepo.deleteNoteById(ctx, id);
      }
      for (const id of deletedLinkIds) {
        await partyRepo.deleteLinkById(ctx, id);
      }
      for (const id of deletedMatterIds) {
        await matterRepo.deleteMatterById(ctx, id);
      }
      for (const id of deletedOrgIds) {
        await partyRepo.deleteOrganisationById(ctx, id);
      }
      for (const id of deletedPersonIds) {
        await partyRepo.deletePersonById(ctx, id);
      }
      if (changedPeople.length > 0) {
        await partyRepo.putPeople(
          ctx,
          changedPeople as unknown as TenantPersonRecord[],
        );
      }
      if (changedOrgs.length > 0) {
        await partyRepo.putOrganisations(
          ctx,
          changedOrgs as unknown as TenantOrganisationRecord[],
        );
      }
      if (changedLinks.length > 0) {
        await partyRepo.putLinks(
          ctx,
          changedLinks as unknown as TenantPersonOrganisationLinkRecord[],
        );
      }
      if (changedNotes.length > 0) {
        await partyRepo.putNotes(
          ctx,
          changedNotes as unknown as TenantNoteRecord[],
        );
      }
      if (changedMerges.length > 0) {
        await partyRepo.putMergeHistoryRecords(
          ctx,
          changedMerges as unknown as TenantMergeHistoryRecord[],
        );
      }
      if (changedMatters.length > 0 || changedPeople.length > 0) {
        const mattersToSync =
          changedPeople.length > 0
            ? (store.matters ?? []).filter(
                (m) =>
                  changedMatters.includes(m) ||
                  Boolean(m.isStaffMatter || m.hasEthicalWall),
              )
            : changedMatters;
        if (mattersToSync.length > 0) {
          const sqlRestrictions = new Map<string, readonly string[]>();
          for (const m of mattersToSync) {
            const meta = computeMatterRestrictionMetadataForStore(
              m,
              store.people ?? [],
              store.teams ?? [],
              tenantCfg,
            );
            sqlRestrictions.set(m.id, meta.restrictedAccessUserIds);
          }
          const importedMatters = await matterRepo.importMatters(
            ctx,
            mattersToSync as unknown as TenantMatterRecord[],
            { sqlRestrictedAccessUserIdsByMatterId: sqlRestrictions },
          );
          const rvMap = new Map<string, number>();
          for (const im of importedMatters) {
            rvMap.set(im.id, im.rowVersion ?? 1);
          }
          for (const m of mattersToSync) {
            m.rowVersion = rvMap.get(m.id) ?? m.rowVersion ?? 1;
          }
        }
      }
    });
  }

  if (state.pgWriteSeq !== currentPgWriteSeq) {
    const [pgPeople, pgOrgs, pgLinks, pgNotes, pgMerges, pgMatters] =
      await partyRepo.withTenantReadTransaction(ctx, async () => {
        const people = await partyRepo.listAllPeople<Person>(ctx);
        const orgs = await partyRepo.listAllOrganisations<Organisation>(ctx);
        const links =
          await partyRepo.listAllLinks<PersonOrganisationLink>(ctx);
        const notes = await partyRepo.listAllNotes<Note>(ctx);
        const merges = await partyRepo.listAllMergeHistory<MergeHistory>(ctx);
        const matters =
          await matterRepo.listAllMattersUnfiltered<Matter>(ctx);
        return [people, orgs, links, notes, merges, matters] as const;
      });
    store.people = mergeOrderedFromPostgres(store.people ?? [], pgPeople);
    store.organisations = mergeOrderedFromPostgres(
      store.organisations ?? [],
      pgOrgs,
    );
    store.links = mergeOrderedFromPostgres(store.links ?? [], pgLinks);
    store.notes = mergeOrderedFromPostgres(store.notes ?? [], pgNotes);
    store.mergeHistory = mergeOrderedFromPostgres(
      store.mergeHistory ?? [],
      pgMerges,
    );
    store.matters = mergeOrderedFromPostgres(store.matters ?? [], pgMatters);
    updateCounterHighWater(
      store,
      'P',
      store.people.map((x) => x.id),
    );
    updateCounterHighWater(
      store,
      'O',
      store.organisations.map((x) => x.id),
    );
    updateCounterHighWater(
      store,
      'L',
      store.links.map((x) => x.id),
    );
    updateCounterHighWater(
      store,
      'N',
      store.notes.map((x) => x.id),
    );
    updateCounterHighWater(
      store,
      'M',
      store.matters.map((x) => x.id),
    );
  }

  markPartiesAndMattersSyncedWithStore(store, ctx);
}

/**
 * Keys on `FirmStore` that have already moved to PostgreSQL (or are monotonic sequence counters)
 * and are therefore excluded from JSON store delta compensation (`R442`).
 */
export type MovedToPostgresKeys =
  | 'audit'
  | 'counters'
  | 'people'
  | 'organisations'
  | 'links'
  | 'matters'
  | 'notes'
  | 'mergeHistory'
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
  | 'keyDatesConfigOverride';

export type TrackedFirmStoreKeys = Exclude<keyof FirmStore, MovedToPostgresKeys>;

/**
 * Unmoved ID-keyed array collections in `FirmStore` tracked for per-record delta compensation (`R406`, `R442`).
 */
const ID_KEYED_ARRAY_COLLECTIONS = [
  { name: 'lists', keyField: 'key' },
  { name: 'values', keyField: 'id' },
  { name: 'customFields', keyField: 'id' },
  { name: 'teams', keyField: 'id' },
  { name: 'tasks', keyField: 'id' },
  { name: 'enquiries', keyField: 'id' },
  { name: 'quotes', keyField: 'id' },
  { name: 'notifications', keyField: 'id' },
  { name: 'pmsLinks', keyField: 'id' },
  { name: 'signOffs', keyField: 'id' },
] as const;

/**
 * Unmoved per-key map properties on `FirmStore` tracked per entry (`R442`).
 */
const PER_KEY_MAP_KEYS = [
  'recentlyViewed',
  'employeeSensitiveRecords',
] as const;

/**
 * Unmoved scalar / configuration properties on `FirmStore` tracked individually (`R442`).
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
  'employeeMigrationReport',
  'matterCostsConfig',
  'rbacConfigOverride',
  'documentGenerationConfigOverride',
  'documentStoreConfigOverride',
] as const;

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
  readonly recentlyViewedByUser: Map<string, string>;
  readonly employeeSensitiveByPerson: Map<string, string>;
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

  const employeeSensitiveByPerson = new Map<string, string>();
  if (
    store.employeeSensitiveRecords &&
    typeof store.employeeSensitiveRecords === 'object'
  ) {
    for (const [pid, rec] of Object.entries(store.employeeSensitiveRecords)) {
      employeeSensitiveByPerson.set(pid, JSON.stringify(rec));
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
    employeeSensitiveByPerson,
    countersByPrefix,
    scalarConfigsByKey,
  };
}

interface CapturedPostgresMatterEntry {
  readonly jsonWithoutRowVersion: string;
  readonly fullJson: string;
  readonly rowVersion: number;
  readonly index: number;
}

export interface PostgresPartiesAndMattersBaseline {
  readonly peopleById: Map<string, CapturedItemEntry>;
  readonly organisationsById: Map<string, CapturedItemEntry>;
  readonly linksById: Map<string, CapturedItemEntry>;
  readonly notesById: Map<string, CapturedItemEntry>;
  readonly mergeHistoryById: Map<string, CapturedItemEntry>;
  readonly mattersById: Map<string, CapturedPostgresMatterEntry>;
  readonly matterObjectsById: Map<string, Matter>;
}

export function capturePostgresPartiesAndMattersBaseline(
  store: FirmStore,
  ctx?: TenantContext | null,
): PostgresPartiesAndMattersBaseline {
  const syncState = ctx
    ? getPartiesMattersSyncCache().get(ctx.postgresDatabaseName)
    : undefined;

  const peopleById = new Map<string, CapturedItemEntry>();
  for (let i = 0; i < (store.people?.length ?? 0); i++) {
    const p = store.people[i]!;
    peopleById.set(p.id, { json: JSON.stringify(p), index: i });
  }

  const organisationsById = new Map<string, CapturedItemEntry>();
  for (let i = 0; i < (store.organisations?.length ?? 0); i++) {
    const o = store.organisations[i]!;
    organisationsById.set(o.id, { json: JSON.stringify(o), index: i });
  }

  const linksById = new Map<string, CapturedItemEntry>();
  for (let i = 0; i < (store.links?.length ?? 0); i++) {
    const l = store.links[i]!;
    linksById.set(l.id, { json: JSON.stringify(l), index: i });
  }

  const notesById = new Map<string, CapturedItemEntry>();
  for (let i = 0; i < (store.notes?.length ?? 0); i++) {
    const n = store.notes[i]!;
    notesById.set(n.id, { json: JSON.stringify(n), index: i });
  }

  const mergeHistoryById = new Map<string, CapturedItemEntry>();
  for (let i = 0; i < (store.mergeHistory?.length ?? 0); i++) {
    const mh = store.mergeHistory[i]!;
    mergeHistoryById.set(mh.id, { json: JSON.stringify(mh), index: i });
  }

  const mattersById = new Map<string, CapturedPostgresMatterEntry>();
  const matterObjectsById = new Map<string, Matter>();
  for (let i = 0; i < (store.matters?.length ?? 0); i++) {
    const m = store.matters[i]!;
    const rv =
      typeof m.rowVersion === 'number' &&
      Number.isInteger(m.rowVersion) &&
      m.rowVersion >= 1
        ? m.rowVersion
        : (syncState?.matterRowVersionById.get(m.id) ?? 1);
    if (m.rowVersion === undefined) {
      m.rowVersion = rv;
    }
    mattersById.set(m.id, {
      jsonWithoutRowVersion: serializeMatterWithoutRowVersion(m),
      fullJson: JSON.stringify(m),
      rowVersion: rv,
      index: i,
    });
    matterObjectsById.set(m.id, m);
  }

  return {
    peopleById,
    organisationsById,
    linksById,
    notesById,
    mergeHistoryById,
    mattersById,
    matterObjectsById,
  };
}

export interface PostgresPartiesAndMattersDeltas {
  readonly upsertedPeople: Person[];
  readonly deletedPersonIds: string[];
  readonly upsertedOrganisations: Organisation[];
  readonly deletedOrganisationIds: string[];
  readonly upsertedLinks: PersonOrganisationLink[];
  readonly deletedLinkIds: string[];
  readonly upsertedNotes: Note[];
  readonly deletedNoteIds: string[];
  readonly upsertedMergeHistory: MergeHistory[];
  readonly deletedMergeHistoryIds: string[];
  readonly createdMatters: Matter[];
  readonly updatedMatters: Array<{ matter: Matter; expectedRowVersion: number }>;
  readonly deletedMatterIds: string[];
  readonly hasAnyDelta: boolean;
}

export function diffPostgresPartiesAndMatters(
  baseline: PostgresPartiesAndMattersBaseline,
  afterStore: FirmStore,
): PostgresPartiesAndMattersDeltas {
  const upsertedPeople: Person[] = [];
  const deletedPersonIds: string[] = [];
  const seenPeople = new Set<string>();
  for (const p of afterStore.people ?? []) {
    seenPeople.add(p.id);
    const before = baseline.peopleById.get(p.id);
    if (!before || before.json !== JSON.stringify(p)) {
      upsertedPeople.push(p);
    }
  }
  for (const id of baseline.peopleById.keys()) {
    if (!seenPeople.has(id)) deletedPersonIds.push(id);
  }

  const upsertedOrganisations: Organisation[] = [];
  const deletedOrganisationIds: string[] = [];
  const seenOrgs = new Set<string>();
  for (const o of afterStore.organisations ?? []) {
    seenOrgs.add(o.id);
    const before = baseline.organisationsById.get(o.id);
    if (!before || before.json !== JSON.stringify(o)) {
      upsertedOrganisations.push(o);
    }
  }
  for (const id of baseline.organisationsById.keys()) {
    if (!seenOrgs.has(id)) deletedOrganisationIds.push(id);
  }

  const upsertedLinks: PersonOrganisationLink[] = [];
  const deletedLinkIds: string[] = [];
  const seenLinks = new Set<string>();
  for (const l of afterStore.links ?? []) {
    seenLinks.add(l.id);
    const before = baseline.linksById.get(l.id);
    if (!before || before.json !== JSON.stringify(l)) {
      upsertedLinks.push(l);
    }
  }
  for (const id of baseline.linksById.keys()) {
    if (!seenLinks.has(id)) deletedLinkIds.push(id);
  }

  const upsertedNotes: Note[] = [];
  const deletedNoteIds: string[] = [];
  const seenNotes = new Set<string>();
  for (const n of afterStore.notes ?? []) {
    seenNotes.add(n.id);
    const before = baseline.notesById.get(n.id);
    if (!before || before.json !== JSON.stringify(n)) {
      upsertedNotes.push(n);
    }
  }
  for (const id of baseline.notesById.keys()) {
    if (!seenNotes.has(id)) deletedNoteIds.push(id);
  }

  const upsertedMergeHistory: MergeHistory[] = [];
  const deletedMergeHistoryIds: string[] = [];
  const seenMerges = new Set<string>();
  for (const mh of afterStore.mergeHistory ?? []) {
    seenMerges.add(mh.id);
    const before = baseline.mergeHistoryById.get(mh.id);
    if (!before || before.json !== JSON.stringify(mh)) {
      upsertedMergeHistory.push(mh);
    }
  }
  for (const id of baseline.mergeHistoryById.keys()) {
    if (!seenMerges.has(id)) deletedMergeHistoryIds.push(id);
  }

  const createdMatters: Matter[] = [];
  const updatedMatters: Array<{ matter: Matter; expectedRowVersion: number }> = [];
  const deletedMatterIds: string[] = [];
  const seenMatters = new Set<string>();
  for (const m of afterStore.matters ?? []) {
    seenMatters.add(m.id);
    const before = baseline.mattersById.get(m.id);
    if (!before) {
      createdMatters.push(m);
    } else {
      const afterWithoutRv = serializeMatterWithoutRowVersion(m);
      if (afterWithoutRv !== before.jsonWithoutRowVersion) {
        const expectedRowVersion =
          typeof m.rowVersion === 'number' &&
          Number.isInteger(m.rowVersion) &&
          m.rowVersion >= 1
            ? m.rowVersion
            : before.rowVersion;
        updatedMatters.push({ matter: m, expectedRowVersion });
      }
    }
  }
  for (const id of baseline.mattersById.keys()) {
    if (!seenMatters.has(id)) deletedMatterIds.push(id);
  }

  const hasAnyDelta =
    upsertedPeople.length > 0 ||
    deletedPersonIds.length > 0 ||
    upsertedOrganisations.length > 0 ||
    deletedOrganisationIds.length > 0 ||
    upsertedLinks.length > 0 ||
    deletedLinkIds.length > 0 ||
    upsertedNotes.length > 0 ||
    deletedNoteIds.length > 0 ||
    upsertedMergeHistory.length > 0 ||
    deletedMergeHistoryIds.length > 0 ||
    createdMatters.length > 0 ||
    updatedMatters.length > 0 ||
    deletedMatterIds.length > 0;

  return {
    upsertedPeople,
    deletedPersonIds,
    upsertedOrganisations,
    deletedOrganisationIds,
    upsertedLinks,
    deletedLinkIds,
    upsertedNotes,
    deletedNoteIds,
    upsertedMergeHistory,
    deletedMergeHistoryIds,
    createdMatters,
    updatedMatters,
    deletedMatterIds,
    hasAnyDelta,
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

function computeArrayDeltaForCollection(
  collectionName: string,
  keyField: string,
  beforeMap: ReadonlyMap<string, CapturedItemEntry>,
  afterArr: ReadonlyArray<Record<string, unknown>>,
): ArrayRecordDelta | null {
  const seenAfterIds = new Set<string>();
  const insertedIds: string[] = [];
  const updatedItems: Array<{ id: string; beforeJson: string }> = [];

  for (const item of afterArr) {
    const idVal = item?.[keyField];
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
    insertedIds.length === 0 &&
    updatedItems.length === 0 &&
    deletedItems.length === 0
  ) {
    return null;
  }

  return {
    collection: collectionName,
    keyField,
    insertedIds,
    updatedItems,
    deletedItems,
  };
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
  pgBaseline?: PostgresPartiesAndMattersBaseline,
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
    const delta = computeArrayDeltaForCollection(
      spec.name,
      spec.keyField,
      beforeMap,
      afterArr,
    );
    if (delta) {
      arrayDeltas.push(delta);
    }
  }

  const pgArrayDeltas: ArrayRecordDelta[] = [];
  if (pgBaseline) {
    const pgSpecs: Array<{
      name: string;
      beforeMap: ReadonlyMap<string, CapturedItemEntry>;
    }> = [
      { name: 'people', beforeMap: pgBaseline.peopleById },
      { name: 'organisations', beforeMap: pgBaseline.organisationsById },
      { name: 'links', beforeMap: pgBaseline.linksById },
      { name: 'notes', beforeMap: pgBaseline.notesById },
      { name: 'mergeHistory', beforeMap: pgBaseline.mergeHistoryById },
      {
        name: 'matters',
        beforeMap: new Map(
          Array.from(pgBaseline.mattersById.entries()).map(([id, entry]) => [
            id,
            { json: entry.fullJson, index: entry.index },
          ]),
        ),
      },
    ];
    for (const spec of pgSpecs) {
      const afterArr = Array.isArray(afterRecord[spec.name])
        ? (afterRecord[spec.name] as Array<Record<string, unknown>>)
        : [];
      const delta = computeArrayDeltaForCollection(
        spec.name,
        'id',
        spec.beforeMap,
        afterArr,
      );
      if (delta) {
        pgArrayDeltas.push(delta);
      }
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

  const sensitiveChanges: Array<{
    personId: string;
    beforeJson: string | null;
  }> = [];
  const afterSensitive = afterStore.employeeSensitiveRecords ?? {};
  const allSensitivePersons = new Set<string>([
    ...baseline.employeeSensitiveByPerson.keys(),
    ...Object.keys(afterSensitive),
  ]);
  for (const pid of allSensitivePersons) {
    const beforeJson = baseline.employeeSensitiveByPerson.get(pid) ?? null;
    const hasAfter = Object.prototype.hasOwnProperty.call(afterSensitive, pid);
    const afterJson = hasAfter ? JSON.stringify(afterSensitive[pid]) : null;
    if (beforeJson !== afterJson) {
      sensitiveChanges.push({ personId: pid, beforeJson });
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

  const hasUnmovedDelta =
    arrayDeltas.length > 0 ||
    recentChanges.length > 0 ||
    sensitiveChanges.length > 0 ||
    scalarChanges.length > 0;

  const hasAnyDelta = hasUnmovedDelta || pgArrayDeltas.length > 0;

  if (!hasAnyDelta) {
    return false;
  }

  compensator.register(label, () => {
    const liveStore = getStore();
    const liveRecord = liveStore as unknown as Record<string, unknown>;

    for (const delta of [...arrayDeltas, ...pgArrayDeltas]) {
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

    if (sensitiveChanges.length > 0) {
      liveStore.employeeSensitiveRecords =
        liveStore.employeeSensitiveRecords ?? {};
      for (const sc of sensitiveChanges) {
        if (sc.beforeJson === null) {
          delete liveStore.employeeSensitiveRecords[sc.personId];
        } else {
          liveStore.employeeSensitiveRecords[sc.personId] = JSON.parse(
            sc.beforeJson,
          ) as EmployeeSensitiveRecord;
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

    if (pgArrayDeltas.length > 0) {
      invalidatePartiesAndMattersSyncCache();
    }

    try {
      saveStore(liveStore);
    } catch (saveErr) {
      if (label === 'executeMerge') {
        let tenantId = 'unknown';
        try {
          tenantId = getActiveTenantConfiguration().tenantId || 'unknown';
        } catch {
          // ignore
        }
        const correlationId = resolveRequestCorrelationId(
          (getActiveActorSession() as { correlationId?: string } | null)
            ?.correlationId ?? null,
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

  return hasUnmovedDelta;
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
 * Runs an unmoved-module JSON store mutation or `S0-16` party/matter mutation inside `withJsonStoreWriteLock` (`R406`, `R418`, `R446`):
 * - Only the outermost `runUnmigratedJsonMutationWithAudit` frame captures the JSON store and PostgreSQL
 *   party/matter baselines, registers the single per-record delta undo step, and commits all moved
 *   party/matter writes + staged `audit_entries` in one PostgreSQL transaction (`withTenantTransaction`).
 * - Nested frames push their staged entries onto the outer scope and skip baseline/undo/append so
 *   overlapping record mutations revert cleanly to the pre-outer state and never commit inner PostgreSQL
 *   or audit rows before the outer frame succeeds (`R446`).
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

  try {
    return await withJsonStoreWriteLock(async (compensator) => {
      const store = getStore();
      let preCtx: TenantContext | null = null;
      try {
        preCtx = params.resolveCtx(store, undefined as unknown as T);
      } catch {
        preCtx = null;
      }
      if (preCtx) {
        await syncAndHydratePartiesAndMattersFromPostgres(store, preCtx);
      }

      const baseline = captureJsonStoreBaseline(store);
      const pgBaseline = capturePostgresPartiesAndMattersBaseline(store, preCtx);
      const stagedEntries: FirmAuditEntryInput[] = [];

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
          pgBaseline,
        );
        throw err;
      }

      const pgDeltas = diffPostgresPartiesAndMatters(pgBaseline, store);
      const storeMutated = registerJsonStoreRecordDeltas(
        baseline,
        store,
        compensator,
        params.label ?? 'json-store.record-delta',
        pgBaseline,
      );

      if (stagedEntries.length > 0 || storeMutated || pgDeltas.hasAnyDelta) {
        const ctx = params.resolveCtx(store, result) ?? preCtx;
        if (!ctx) {
          throw new Error(
            'TENANCY_AUTH_ERROR: Cannot write firm audit entries without a resolved TenantContext.',
          );
        }

        if (pgDeltas.hasAnyDelta || stagedEntries.length > 0) {
          const partyRepo = getPartyRepository();
          const matterRepo = getMatterRepository();
          const auditRepo = getAuditRepository();
          const tenantCfg = getActiveTenantConfiguration();
          const persistedRowVersions = new Map<string, number>();

          let capturedAuditError: unknown = null;
          try {
            await partyRepo.withTenantTransaction(ctx, async () => {
              for (const id of pgDeltas.deletedMergeHistoryIds) {
                await partyRepo.deleteMergeHistoryById(ctx, id);
              }
              for (const id of pgDeltas.deletedNoteIds) {
                await partyRepo.deleteNoteById(ctx, id);
              }
              for (const id of pgDeltas.deletedLinkIds) {
                await partyRepo.deleteLinkById(ctx, id);
              }
              for (const id of pgDeltas.deletedMatterIds) {
                await matterRepo.deleteMatterById(ctx, id);
              }
              for (const id of pgDeltas.deletedOrganisationIds) {
                await partyRepo.deleteOrganisationById(ctx, id);
              }
              for (const id of pgDeltas.deletedPersonIds) {
                await partyRepo.deletePersonById(ctx, id);
              }
              if (pgDeltas.upsertedPeople.length > 0) {
                await partyRepo.putPeople(
                  ctx,
                  pgDeltas.upsertedPeople as unknown as TenantPersonRecord[],
                );
              }
              if (pgDeltas.upsertedOrganisations.length > 0) {
                await partyRepo.putOrganisations(
                  ctx,
                  pgDeltas.upsertedOrganisations as unknown as TenantOrganisationRecord[],
                );
              }
              if (pgDeltas.upsertedLinks.length > 0) {
                await partyRepo.putLinks(
                  ctx,
                  pgDeltas.upsertedLinks as unknown as TenantPersonOrganisationLinkRecord[],
                );
              }
              if (pgDeltas.upsertedNotes.length > 0) {
                await partyRepo.putNotes(
                  ctx,
                  pgDeltas.upsertedNotes as unknown as TenantNoteRecord[],
                );
              }
              if (pgDeltas.upsertedMergeHistory.length > 0) {
                await partyRepo.putMergeHistoryRecords(
                  ctx,
                  pgDeltas.upsertedMergeHistory as unknown as TenantMergeHistoryRecord[],
                );
              }
              for (const m of pgDeltas.createdMatters) {
                const meta = computeMatterRestrictionMetadataForStore(
                  m,
                  store.people ?? [],
                  store.teams ?? [],
                  tenantCfg,
                );
                const created = await matterRepo.createMatter(
                  ctx,
                  m as unknown as TenantMatterRecord,
                  { sqlRestrictedAccessUserIds: meta.restrictedAccessUserIds },
                );
                persistedRowVersions.set(m.id, created.rowVersion ?? 1);
              }
              for (const { matter: m, expectedRowVersion } of pgDeltas.updatedMatters) {
                const meta = computeMatterRestrictionMetadataForStore(
                  m,
                  store.people ?? [],
                  store.teams ?? [],
                  tenantCfg,
                );
                const updated = await matterRepo.updateMatter(
                  ctx,
                  m as unknown as TenantMatterRecord,
                  {
                    expectedRowVersion,
                    sqlRestrictedAccessUserIds: meta.restrictedAccessUserIds,
                  },
                );
                persistedRowVersions.set(
                  m.id,
                  updated.rowVersion ?? expectedRowVersion + 1,
                );
              }
              if (
                pgDeltas.upsertedPeople.length > 0 ||
                pgDeltas.deletedPersonIds.length > 0
              ) {
                const touchedMatterIds = new Set<string>([
                  ...pgDeltas.createdMatters.map((x) => x.id),
                  ...pgDeltas.updatedMatters.map((x) => x.matter.id),
                ]);
                const restrictedUntouchedMatters = (store.matters ?? []).filter(
                  (m) =>
                    !touchedMatterIds.has(m.id) &&
                    Boolean(
                      m.isStaffMatter ||
                        m.hasEthicalWall ||
                        (m.restrictedAccessUserIds &&
                          m.restrictedAccessUserIds.length > 0),
                    ),
                );
                if (restrictedUntouchedMatters.length > 0) {
                  const sqlRestrictions = new Map<string, readonly string[]>();
                  for (const m of restrictedUntouchedMatters) {
                    const meta = computeMatterRestrictionMetadataForStore(
                      m,
                      store.people ?? [],
                      store.teams ?? [],
                      tenantCfg,
                    );
                    sqlRestrictions.set(m.id, meta.restrictedAccessUserIds);
                  }
                  await matterRepo.importMatters(
                    ctx,
                    restrictedUntouchedMatters as unknown as TenantMatterRecord[],
                    { sqlRestrictedAccessUserIdsByMatterId: sqlRestrictions },
                  );
                }
              }
              if (stagedEntries.length > 0) {
                try {
                  await auditRepo.appendAuditEntries(ctx, stagedEntries);
                } catch (auditErr) {
                  capturedAuditError = auditErr;
                  throw auditErr;
                }
              }
            });
          } catch (txErr) {
            if (capturedAuditError !== null) {
              throw capturedAuditError;
            }
            throw txErr;
          }

          if (persistedRowVersions.size > 0) {
            for (const [mId, newRv] of persistedRowVersions.entries()) {
              const storeM = store.matters?.find((x) => x.id === mId);
              if (storeM) {
                storeM.rowVersion = newRv;
              }
              const preMatterObj = pgBaseline.matterObjectsById.get(mId);
              if (preMatterObj) {
                preMatterObj.rowVersion = newRv;
              }
              if (result && typeof result === 'object') {
                const resMatter = (result as { matter?: Matter | null }).matter;
                if (resMatter && resMatter.id === mId) {
                  resMatter.rowVersion = newRv;
                }
                const resDirect = result as {
                  id?: string;
                  matterNumber?: string;
                  rowVersion?: number;
                };
                if (
                  resDirect.id === mId &&
                  typeof resDirect.matterNumber === 'string'
                ) {
                  resDirect.rowVersion = newRv;
                }
              }
            }
          }

          if (pgDeltas.hasAnyDelta) {
            markPartiesAndMattersSyncedWithStore(store, ctx, persistedRowVersions);
            if (
              persistedRowVersions.size > 0 &&
              (process.env.VITEST || process.env.NODE_ENV === 'test') &&
              !process.env.ONESQUARED_RUNTIME_STORE_PATH
            ) {
              global.__oneSquaredLastSavedStoreJson = JSON.stringify(store);
            }
          }
        }
      }

      return result;
    });
  } catch (err) {
    if (
      params.label === 'saveMatterRecord' &&
      err &&
      typeof err === 'object' &&
      (err as { code?: string }).code === MATTER_CONCURRENCY_CONFLICT_CODE
    ) {
      return {
        matter: null,
        code: MATTER_CONCURRENCY_CONFLICT_CODE,
        message: MATTER_CONCURRENCY_CONFLICT_MESSAGE,
        errors: {
          conflict: MATTER_CONCURRENCY_CONFLICT_MESSAGE,
        },
      } as unknown as T;
    }
    throw err;
  }
}

export function getActiveCompensatorOrNull(): RecordDeltaCompensator | null {
  return getActiveRecordDeltaCompensator();
}
