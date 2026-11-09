# S0-15: Key dates and audit log cut-over to PostgreSQL

| | |
|---|---|
| Backlog | P2, P8, item 8 (Key dates and limitation) |
| Decision | [ADR 0028: Tenant Databases and Repositories](../../decisions/0028-tenant-database-and-repositories.md) (D3, revised and accepted 9 November 2026 — Owner Decisions 1, 4, 5 and 9) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4a — followed by async effort measurement and S0-16 / S0-17a–c re-estimate per §7) |
| Branch | `s0-15-key-dates-and-audit-log`, from `s0-14-tenant-database`, targeting `develop` |
| Change class | Core feature / persistence cut-over (`core/src/tenancy/`, `core/src/tenancy/migrations/`, `src/server/storeLock.ts`, `src/server/auditAdapter.ts`, `src/server/services.ts`, `src/server/documentGenerationServices.ts`, `src/app/actions.ts`, `src/app/**/page.tsx`, `scripts/`). |
| Size | L (confirmed by Owner Decision 1 on 9 November 2026) |
| Depends on | S0-14 (`TenantScopedRepository` with transaction-scoped `SET LOCAL ROLE` over PgBouncer, `TenantMigrationRunner` `0001`–`0006`, real SQL `TenantKeyDateRepository` & `TenantDocumentRepository`, re-entrant `src/server/storeLock.ts`, `docs/runbooks/store-cut-over.md`). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) only for executing `docs/runbooks/store-cut-over.md` against a cloud Azure environment; local and CI PostgreSQL imports and tests are unblocked. |
| Baseline | `develop` at `52390b9` (stacked on `s0-14-tenant-database`) |

## What exists today

Checked against `develop` (`52390b9`):

1. **Key dates in the JSON store (`src/server/store.ts:117-121`, `src/server/visibility.ts:89-94`, `src/server/services.ts:579-586, 677-681, 760-804, 12747-14057`):**
   - `FirmStore` holds `keyDates` (`:117`), `keyDateNotApplicable` (`:118`), `keyDateReminderStates` (`:119`), `keyDateCalendarSyncs` (`:120`), and `keyDatesConfigOverride` (`:121`), and `buildRecordVisibility` (`src/server/visibility.ts:90`) reads `store.keyDates` to compute `hiddenMatterKeyDateIds` for `canViewTask`.
   - `TenantKeyDateRepository` (`core/src/tenancy/keyDateRepository.ts:1-588`, backed by real SQL tables `0003`–`0005` after S0-14) implements CRUD, reminder states, calendar syncs, config overrides, audit events, and matter restriction checks, while `src/server/services.ts` still reads and mutates `store.keyDates*` and `store.keyDatesConfigOverride`.
   - 7 key-date mutation exports in `src/server/services.ts` are already `async` (`createOrProposeKeyDateRecord` `:12877`, `proposeProvisionalKeyDateRecord` `:13015`, `verifyProposedKeyDateRecord` `:13099`, `rejectProposedKeyDateRecord` `:13182`, `supersedeConfirmedKeyDateRecord` `:13233`, `resolveKeyDateOutcomeRecord` `:13373`, `reassignKeyDateTeamRecord` `:13453`), while 10 key-date exports are synchronous (`getKeyDatesConfig` `:579`, `getMatterKeyDatesSnapshot` `:12747`, `previewLimitationCalculationRecord` `:12817`, `recordKeyDateNotApplicableRecord` `:13529`, `acknowledgeKeyDateReminderRecord` `:13582`, `runKeyDateReminderSchedulerRecord` `:13684`, `queryKeyDatesTeamDiaryRecord` `:13810`, `getKeyDateExceptionsReportRecord` `:13839`, `exportKeyDateExceptionsReportRecord` `:13872`, `saveKeyDatesConfigRecord` `:13950`).
2. **Audit log in the JSON store (`src/server/store.ts:94`, `src/domain/types.ts:1182-1210`, `src/server/services.ts:559-577, 898-909`, `src/server/documentGenerationServices.ts:904-927`):**
   - `FirmStore.audit` (`AuditEntry[]`) is written by `writeAudit(store, ...)` (`src/server/services.ts:559-577`, **115 call sites across 66 functions** in `src/server/services.ts`), direct `store.audit.unshift(...)` in `exportKeyDateExceptionsReportRecord` (`:13906`) and `saveKeyDatesConfigRecord` (`:14029`), key-date domain helpers (`src/domain/keyDates.ts:1156-2010`, `src/domain/keyDateReminders.ts:335, 513, 681, 737, 840`) called from 11 functions in `services.ts` (`finalizeEnquiryConversionToMatter` `:8879` plus 10 key-date services `:12971`–`:13799`), and `appendAudit` in `src/server/documentGenerationServices.ts:904-927` (whose templates/documents already moved to PostgreSQL in `S0-14`, `R405`).
   - `getAppSnapshotInScope` (`src/server/services.ts:898-909`) currently loads the entire firm-wide `store.audit` array on every page render (`R413`), even though only 5 record profile pages (`src/app/enquiries/[id]/page.tsx:26`, `src/app/matters/[id]/page.tsx:113`, `src/app/organisations/[id]/page.tsx:48`, `src/app/people/[id]/page.tsx:56`, `src/app/tasks/[id]/page.tsx:19`) and Admin (`src/app/admin/[[...slug]]/page.tsx:21`) display audit entries.
3. **Shared process-wide JSON store concurrency hazard once services become `async` (`R406`):**
   - `getStore()` (`src/server/store.ts:722`) returns one process-wide mutable object (`global.__oneSquaredStore` `:218`) and `saveStore()` (`:1073`, called 96 times in `services.ts`) replaces it synchronously. Once services `await` PostgreSQL mid-operation, concurrent requests can interleave on `global.__oneSquaredStore`, and restoring a whole-store snapshot on failure would wipe another request's committed writes (`R406`).

## Tables

Key date tables (`key_dates`, `key_dates_not_applicable`, `key_date_reminder_states`, `key_date_calendar_syncs`, `key_date_audit_events`, `key_dates_tenant_configs`, and S0-14's `matter_restriction_metadata`) exist from migrations `0003`–`0005`. S0-15 adds the immutable firm-wide **`audit_entries`** table and per-tenant sequence **`tenant_audit_id_seq`** (`TenantAuditRepository extends TenantScopedRepository`):

| Table | Normalised columns | `jsonb` columns (per ADR 0028 §2) | Primary key, indexes & privileges |
|---|---|---|---|
| `audit_entries` | `tenant_id TEXT NOT NULL`, `id TEXT NOT NULL` (`AU-000001` or UUID), `seq BIGSERIAL NOT NULL`, `record_type TEXT NOT NULL`, `record_id TEXT NOT NULL`, `action TEXT NOT NULL`, `field TEXT NULL`, `old_value TEXT NULL`, `new_value TEXT NULL`, `reason TEXT NULL`, `by_id TEXT NOT NULL`, `at TIMESTAMPTZ NOT NULL`, `at_iso TEXT NOT NULL` | `snapshot_json JSONB NULL` — optional before/after record snapshot (`AuditEntry.snapshot`), shaped by module/custom-field schema | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_audit_entries_tenant_at ON audit_entries (tenant_id, at DESC, seq DESC)`; `INDEX idx_audit_entries_tenant_record ON audit_entries (tenant_id, record_type, record_id, at DESC)`; **append-only grant (`R413`):** `role_tenant_<slug>_<env>` has **`SELECT, INSERT` only** (zero `UPDATE` or `DELETE` privilege) |

**Scoped audit queries (`R413`):**
- `getAppSnapshotInScope` (`src/server/services.ts:898-909`) stops loading the whole `audit_entries` table on every page! Instead, `snap.audit` defaults to `[]` unless explicitly requested, the 5 profile pages (`enquiries/[id]`, `matters/[id]`, `organisations/[id]`, `people/[id]`, `tasks/[id]`) call `listAuditEntriesForRecord(recordType, recordId, { limit: 200 })` hitting `idx_audit_entries_tenant_record` (enforcing `canViewMatter` / `canViewEnquiry` / `canViewTask`), and `admin/[[...slug]]/page.tsx` calls `listFirmAuditEntriesPage({ limit: 250, beforeSeq? })` hitting `idx_audit_entries_tenant_at` with restricted-matter filtering.

## Migrations

Expand migration added to `CORE_TENANT_MIGRATIONS` (`core/src/tenancy/migrations/index.ts`), advancing `CORE_REQUIRED_SCHEMA_VERSION` to `'0007'`:

1. **`0007_firm_audit_log_expand`** (`kind: 'expand'`, `requiresAppliedVersion: '0006'`):
   - **`upSql`:** creates `tenant_audit_id_seq`, `audit_entries`, `idx_audit_entries_tenant_at`, and `idx_audit_entries_tenant_record`, and explicitly revokes `UPDATE, DELETE` from the tenant role (`REVOKE UPDATE, DELETE ON TABLE audit_entries FROM role_tenant_...; GRANT SELECT, INSERT ON TABLE audit_entries TO role_tenant_...; GRANT USAGE, SELECT ON SEQUENCE tenant_audit_id_seq, audit_entries_seq_seq TO role_tenant_...;`) so `audit_entries` is append-only enforced by PostgreSQL (`R413`).
   - **`downSql`:** drops `idx_audit_entries_tenant_record`, `idx_audit_entries_tenant_at`, `audit_entries`, and `tenant_audit_id_seq`.

## Import and release cut-over (`R407`, `R413`)

1. **Bundled entry point:** `node dist/jobs/import-store.mjs --modules key-dates,audit` in Azure (`store-import` Container Apps job) / `npm run db:import -- --modules key-dates,audit [--store-path <path>]` locally, executed inside the 5-step zero-write-loss release sequence in **`docs/runbooks/store-cut-over.md`** (stop web writes -> `migrate` `0007` -> `store-import --modules key-dates,audit` -> verify fresh-connection counts -> start new revision).
2. **Idempotent transactional import (`withTenantTransaction`):**
   - Upserts `matter_restriction_metadata` from `store.matters`, `key_dates_tenant_configs` from `store.keyDatesConfigOverride`, and `key_dates`, `key_dates_not_applicable`, `key_date_reminder_states`, and `key_date_calendar_syncs` (`ON CONFLICT ... DO UPDATE`).
   - Inserts `store.audit` into `audit_entries` using **`ON CONFLICT (tenant_id, id) DO NOTHING`** (`R413` — compatible with the tenant role's `SELECT, INSERT`-only privilege) and advances `tenant_audit_id_seq` via `setval('tenant_audit_id_seq', GREATEST(max_au_num, 1), true)`.
3. **Verification & dev/demo wiring:** verifies row counts and `tenant_id === ctx.tenantId` on a fresh connection, exiting non-zero on mismatch; wired into `scripts/seed-demo-tenant.ts`, `resetAllDemoData` (`services.ts:6544`), `clearAllDataToCleanDeployment` (`:6584`), and `e2e/global-setup.ts`.

## Async conversion and effort estimate

1. **Key dates & snapshot functions in `src/server/services.ts`:**
   - **Already `async` (7 key-date exports + 4 cross-module callers):** `createOrProposeKeyDateRecord` (`:12877`), `proposeProvisionalKeyDateRecord` (`:13015`), `verifyProposedKeyDateRecord` (`:13099`), `rejectProposedKeyDateRecord` (`:13182`), `supersedeConfirmedKeyDateRecord` (`:13233`), `resolveKeyDateOutcomeRecord` (`:13373`), `reassignKeyDateTeamRecord` (`:13453`), plus `saveMatterRecord` (`:3329`), `signOffMatterCostsRecord` (`:5367`), `switchUserInDemoMode` (`:423`), and `runMatterOpeningGate` (`:2960`).
   - **Synchronous -> `async` (11 exports + 2 internal helpers):** `getKeyDatesConfig` (`:579`), `getAppSnapshot` (`:604`) + `getAppSnapshotInScope` (`:611`), `getMatterKeyDatesSnapshot` (`:12747`), `previewLimitationCalculationRecord` (`:12817`), `recordKeyDateNotApplicableRecord` (`:13529`), `acknowledgeKeyDateReminderRecord` (`:13582`), `runKeyDateReminderSchedulerRecord` (`:13684`), `queryKeyDatesTeamDiaryRecord` (`:13810`), `getKeyDateExceptionsReportRecord` (`:13839`), `exportKeyDateExceptionsReportRecord` (`:13872`), `saveKeyDatesConfigRecord` (`:13950`), plus `finalizeEnquiryConversionToMatter` (`:8809`).
2. **Document Generation (`R405`) & unmoved JSON modules:**
   - **`src/server/documentGenerationServices.ts` (`appendAudit` `:904`):** because `TenantDocumentRepository` moved to PostgreSQL in `S0-14` (`R405`), `appendAudit` (`:904`) becomes `async` and writes `audit_entries` **inside the same `withTenantTransaction` as the template/document write** (all 9 callers in `:929`–`:1699` are already `async`).
   - **Unmoved JSON modules in `src/server/services.ts`:** 63 synchronous exported functions calling `writeAudit` (`prepareEnquiryConversion` `:8490`, `linkPmsRecord` `:9313`, `unlinkPmsRecord` `:9362`, `prepareQuoteConversionRecord` `:11905`, `syncMatterCostsRatesFromPms` `:12422`, `resolveOrProvisionEntraEmployee` `:12469`, etc.; `executeMerge` `:5639` already became `async` in `S0-14`), plus `takeTaskRecord` (`:7257`) and internal helpers (`raiseAutomaticTask` `:7360`, `completeOpenContactTasksForEnquiry` `:7461`, `finalizeQuoteConversionToMatter` `:12333`), convert to `async`.
3. **Callers outside `src/server/services.ts`:**
   - `src/app/layout.tsx` + 23 `src/app/**/page.tsx` Server Components (including scoped `listAuditEntriesForRecord` on the 5 profile pages and `listFirmAuditEntriesPage` on Admin), `src/app/actions.ts` (69 `guardedAction` callbacks; exported action signatures stay `async`), `src/app/api/auth/callback/microsoft-entra-id/route.ts:53`, `src/app/api/matters/extract/route.ts:2398, 2442, 2577, 2611`, and ~395 `await` insertions across 15 test files.

**Effort:** **Size L (~3–4 engineering days)**, pulling ~85% of the codebase's synchronous-to-`async` signature conversion into Checkpoint 4a; measured effort and revised estimates for `S0-16` and `S0-17a–c` are reported right after `S0-15`.

## Operations that span modules & JSON store async lock (`Owner Decision 5`, `R406`, `R418`, `R420`)

1. **Re-entrant per-process async JSON store lock & delta-only compensation (`src/server/storeLock.ts`, started in `S0-14` and retired in `S0-20`, `R406`, `R418`, `R420`):**
   - Every operation in `S0-14` through `S0-17c` that mutates the transitional JSON store runs inside **`withJsonStoreWriteLock(async () => { ... })`**, which holds a FIFO async mutex from `getStore()` through `saveStore()` and its accompanying PostgreSQL transaction so concurrent `async` requests cannot interleave on `global.__oneSquaredStore` (`store.ts:218, 722, 1073`).
   - **Re-entrant via `AsyncLocalStorage` (`R418`):** `storeLock.ts` tracks the active holder in `AsyncLocalStorage<{ compensator: RecordDeltaCompensator }>`. The outermost mutating call (at the `guardedAction` / `guardedRoute` callback or top-level service function) acquires the FIFO mutex once; **nested mutating calls in the same async call chain** — such as `takeTaskRecord` delegating to `saveTaskRecord` (`src/server/services.ts:7257`), or `saveMatterRecord` (`:3329`) calling `finalizeEnquiryConversionToMatter` (`:8809`) and `raiseAutomaticTask` (`:7360`) — detect the active `AsyncLocalStorage` context, execute directly without re-queueing (preventing deadlock), and record their item pre-images onto the outermost `RecordDeltaCompensator`.
   - **Delta-only compensation (`R406`):** operations **never** restore a whole-store `structuredClone(store)` snapshot. If the outermost operation or its PostgreSQL step throws, the outermost `withJsonStoreWriteLock` frame reverts **only** the per-record deltas recorded in that call chain (in reverse order) before releasing the mutex.
   - **Unlocked reads (`R420`):** read-only paths that do not mutate the JSON store (such as `getAppSnapshot` `:604`) do not acquire `withJsonStoreWriteLock`; while a mutating request awaits PostgreSQL inside the lock, an unlocked read can transiently observe that request's in-memory JSON changes prior to commit or delta compensation. That transient local-JSON read behaviour is accepted until `S0-20` retires the JSON store.
2. **Same-transaction PostgreSQL writes (`key_dates` + `audit_entries`, `documents` + `audit_entries`):**
   - Every key-date mutation and every `documentGenerationServices.ts` template/document mutation (`appendAudit` `:904`, removing `saveStore` and `withJsonStoreWriteLock` from `documentGenerationServices.ts`, `R405`, `R418`) writes its rows and `audit_entries` inside **one `withTenantTransaction(ctx, ...)`**.
3. **Temporary Postgres audit adapter (`src/server/auditAdapter.ts`) for unmoved JSON modules:**
   - Unmoved JSON modules write `audit_entries` inside `withJsonStoreWriteLock` via `appendUnmigratedModuleAuditEntries(ctx, entries)`, reverting the operation's per-record JSON delta if the Postgres audit transaction fails (preserving mandatory HR `view-payroll` / `view-sensitive` / `update-payroll` / `update-sensitive` audit guarantees). Tagged `@remove-in S0-16`, `@remove-in S0-17a/b/c`, and `@remove-in S0-18`.
4. **Cross-store flows wrapped in `withJsonStoreWriteLock` + delta compensation:** `saveMatterRecord` (`:3329`, `carryEnquiryKeyDatesToMatter` `:8868` + `matter_restriction_metadata`), `liftMatterRestriction` (`:4833`), `reassignLeaverOwnedRecords` (`:1196`), `updateMatterConflictRecord` (`:5101`), and `runKeyDateReminderSchedulerRecord` (`:13684`).

## Tests

- **Unit, immutability, scoped-query & `R406` concurrency tests (`core/tests/audit-log-postgres.test.ts` — new, `src/domain/__tests__/keyDate*.test.ts`):**
  - All 6 existing key-date test suites run against real PostgreSQL.
  - **Append-only immutability test (`R413`):** attempting `UPDATE audit_entries ...` or `DELETE FROM audit_entries ...` inside `withTenantTransaction` as `role_tenant_*` fails with PostgreSQL `permission denied`.
  - **Scoped profile audit query test (`R413`):** `listAuditEntriesForRecord` returns only matching `(record_type, record_id)` rows bounded by `limit`, while `getAppSnapshot` no longer loads the full table.
  - **Same-transaction atomicity:** forced failure mid-way through a key-date or DocGen write commits neither the record nor `audit_entries`.
  - **Concurrent cross-store interleaving, delta compensation & nested re-entrancy tests (`R406`, `R418`):** (a) launch two concurrent operations (`Promise.all([opA, opB])`) where `opA` mutates JSON and is forced to fail in PostgreSQL while `opB` succeeds, call `clearStoreMemoryCache()` (`src/server/store.ts:228`), and assert `opB`'s JSON + Postgres writes survive intact while `opA`'s JSON delta is reverted; (b) invoke nested locked calls (`takeTaskRecord` -> `saveTaskRecord` at `src/server/services.ts:7257` and `saveMatterRecord` -> `raiseAutomaticTask`) under a strict timeout (`< 2s`) and assert they complete without deadlock and roll back outer + inner record deltas cleanly on forced Postgres failure.
  - **One-off import idempotency (`ON CONFLICT DO NOTHING` on `audit_entries`):** run twice, verify exact counts and `AU-` sequence continuation.
- **Contract, two-tenant isolation & E2E tests:**
  - `0007_firm_audit_log_expand` `upSql` -> `downSql` -> `upSql` round-trip; `store.keyDates*` and `store.audit` untouched at runtime.
  - Two-tenant isolation through PgBouncer (`core/tests/key-dates-isolation.test.ts`, `core/tests/isolation.test.ts`): positive Tenant A control + forged claim (`TENANCY_FORGERY_DETECTED`) + tampered Tenant B `keyDateId`/`matterId`/`recordId` (`KEY_DATE_NOT_FOUND` / `NOT_FOUND`) + staff/ethical-wall redaction.
  - `npm run e2e` passes all 9 Playwright role journeys.

## Help and documentation (rule 11)

- **`src/docs/articles/key-dates-overview.ts`, `src/docs/articles/key-dates-administration.ts`, `src/docs/articles/data-administration-and-retention.ts`, `src/docs/articles/document-generation.ts`, `src/docs/articles/demo-environment.ts`, and `src/docs/articles/development-process.ts`:** Document PostgreSQL key-date and append-only (`SELECT, INSERT`) audit persistence, record-scoped profile audit queries, and `store-cut-over.md` / `db:import`.
- **`docs/release-notes.md` and `docs/roadmap/feature-list.md`:** Record `S0-15` and update item **8**, **P2**, and **P8**.

## Acceptance criteria

- All runtime key-date and firm-wide audit reads/writes go through `TenantKeyDateRepository` and `TenantAuditRepository` (`SELECT, INSERT` only on `audit_entries`, scoped per-record queries on profile pages); `store.keyDates*` and `store.audit` are untouched at runtime.
- Key-date and Document Generation mutations write `audit_entries` in the same PostgreSQL transaction; unmoved JSON modules use `withJsonStoreWriteLock` + delta-only compensation (`R406`).
- `dist/jobs/import-store.mjs --modules key-dates,audit` imports idempotently (`ON CONFLICT DO NOTHING` on `audit_entries`), and `npm run ci` passes (`MAX_KNOWN_GAPS = 0`).
- Measured async-conversion effort and confirmed/adjusted estimates for `S0-16` and `S0-17a–c` are reported at Checkpoint 4a hand-off.

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Cloud execution of `docs/runbooks/store-cut-over.md` waits on subscription access.

## Rollback

- Follow the rollback steps in **`docs/runbooks/store-cut-over.md`** (`R407`): stop web writes, revert `s0-15-key-dates-and-audit-log`, run `downSql` for `0007` if rolling back schema, and resume from the JSON store (`npm run seed:demo -- --force` on demo; post-import demo writes lost per ADR 0028 §5).

## Pull request description must state

- **Change class:** Core persistence cut-over (`core/src/tenancy/`, `src/server/`, `src/app/`).
- **Both hosting models:** Identical `TenantKeyDateRepository` and append-only `TenantAuditRepository` run per-tenant over PgBouncer (`SET LOCAL ROLE`) in Model A and Model B.
- **Migration, cut-over and rollback:** Follows **`docs/runbooks/store-cut-over.md`** (stop writes -> `migrate` `0007_firm_audit_log_expand` -> `store-import --modules key-dates,audit` -> verify counts -> start revision); reversible via `downSql` and JSON re-seed.
- **Cross-module operations:** Details same-transaction key-date & DocGen audit writes, `src/server/auditAdapter.ts`, and `withJsonStoreWriteLock` + per-record delta compensation (`R406`).
