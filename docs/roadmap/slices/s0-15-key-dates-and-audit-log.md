# S0-15: Key dates and audit log cut-over to PostgreSQL

| | |
|---|---|
| Backlog | P2, P8, item 8 (Key dates and limitation) |
| Decision | [ADR 0028: Tenant Databases and Repositories](../../decisions/0028-tenant-database-and-repositories.md) (D3, revised and accepted 9 November 2026 — Owner Decisions 4, 5 and 9) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4a — followed by async effort measurement and S0-16 / S0-17 re-estimate per §7) |
| Branch | `s0-15-key-dates-and-audit-log`, from `s0-14-tenant-database`, targeting `develop` |
| Change class | Core feature / persistence cut-over (`core/src/tenancy/`, `core/src/tenancy/migrations/`, `src/server/services.ts`, `src/app/actions.ts`, `src/app/**/page.tsx`, `scripts/`). |
| Size | L (see honest async-conversion estimate below; `stage-0-plan.md` listed `M` before the audit log was moved from S0-17 into S0-15 on 9 November 2026) |
| Depends on | S0-14 (`TenantScopedRepository`, real `pg` pools with `SET ROLE`, `TenantMigrationRunner`, real SQL `TenantKeyDateRepository`). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) only for running the one-off import against a cloud Azure environment; local and CI PostgreSQL imports and tests are unblocked. |
| Baseline | `develop` at `52390b9` (stacked on `s0-14-tenant-database`) |

## What exists today

Checked against `develop` (`52390b9`):

1. **Key dates in the JSON store (`src/server/store.ts:117-121`, `src/server/visibility.ts:89-94`, `src/server/services.ts:579-586, 677-681, 760-804, 12747-14057`):**
   - `FirmStore` holds `keyDates` (`:117`), `keyDateNotApplicable` (`:118`), `keyDateReminderStates` (`:119`), `keyDateCalendarSyncs` (`:120`), and `keyDatesConfigOverride` (`:121`), and `buildRecordVisibility` (`src/server/visibility.ts:90`) reads `store.keyDates` to compute `hiddenMatterKeyDateIds` for task visibility (`canViewTask`).
   - `TenantKeyDateRepository` (`core/src/tenancy/keyDateRepository.ts:1-588`, backed by real SQL tables `0003`–`0005` after S0-14) already implements CRUD, reminder states, calendar syncs, config overrides, audit events, and matter restriction checks (`isStaffMatter` / `hasEthicalWall` / `restrictedAccessUserIds`), but `src/server/services.ts` still reads and writes `store.keyDates*` and `store.keyDatesConfigOverride` instead of calling `TenantKeyDateRepository`.
   - In `src/server/services.ts`, 7 key-date mutation exports are already `async` (`createOrProposeKeyDateRecord` `:12877`, `proposeProvisionalKeyDateRecord` `:13015`, `verifyProposedKeyDateRecord` `:13099`, `rejectProposedKeyDateRecord` `:13182`, `supersedeConfirmedKeyDateRecord` `:13233`, `resolveKeyDateOutcomeRecord` `:13373`, `reassignKeyDateTeamRecord` `:13453`), while 10 key-date exports are still synchronous (`getKeyDatesConfig` `:579`, `getMatterKeyDatesSnapshot` `:12747`, `previewLimitationCalculationRecord` `:12817`, `recordKeyDateNotApplicableRecord` `:13529`, `acknowledgeKeyDateReminderRecord` `:13582`, `runKeyDateReminderSchedulerRecord` `:13684`, `queryKeyDatesTeamDiaryRecord` `:13810`, `getKeyDateExceptionsReportRecord` `:13839`, `exportKeyDateExceptionsReportRecord` `:13872`, `saveKeyDatesConfigRecord` `:13950`).
2. **Audit log in the JSON store (`src/server/store.ts:94`, `src/domain/types.ts:1182-1210`, `src/server/services.ts:559-577, 898-909`, `src/server/documentGenerationServices.ts:904-927`):**
   - `FirmStore.audit` (`AuditEntry[]`) is written by:
     - `writeAudit(store, ...)` (`src/server/services.ts:559-577`, called at **115 call sites across 66 functions** in `src/server/services.ts`),
     - direct `store.audit.unshift(...)` in `exportKeyDateExceptionsReportRecord` (`:13906`) and `saveKeyDatesConfigRecord` (`:14029`),
     - passing `audit: store.audit` into key-date domain helpers (`src/domain/keyDates.ts:1156-2010` and `src/domain/keyDateReminders.ts:335, 513, 681, 737, 840`) from 11 functions in `src/server/services.ts` (`finalizeEnquiryConversionToMatter` `:8879` plus 10 key-date services `:12971`–`:13799`), and
     - `appendAudit` in `src/server/documentGenerationServices.ts:904-927` (`store.audit.unshift` at `:916`, called from 9 already-`async` document generation services).
   - `store.audit` is read in `getAppSnapshotInScope` (`src/server/services.ts:898-909`, filtering out hidden matters, tasks, enquiries, quotes, and key dates) and passed down via `snap.audit` to 5 profile pages (`src/app/enquiries/[id]/page.tsx:26`, `src/app/matters/[id]/page.tsx:113`, `src/app/organisations/[id]/page.tsx:48`, `src/app/people/[id]/page.tsx:56`, `src/app/tasks/[id]/page.tsx:19`) and Admin (`src/app/admin/[[...slug]]/page.tsx:21`).

## Tables

Key date tables (`key_dates`, `key_dates_not_applicable`, `key_date_reminder_states`, `key_date_calendar_syncs`, `key_date_audit_events`, `key_dates_tenant_configs`, and S0-14's `matter_restriction_metadata`) already exist from migrations `0003`–`0005` (`core/src/tenancy/migrations/index.ts:362-525`), with normalised columns for all core fields, `jsonb` for structured sub-documents (`responsible_person_ids`, `calculation_json`, `verification_json`, `outcome_json`, `acknowledged_stages_json`, `recipient_person_ids_json`, `config_json`), and `tenant_id TEXT NOT NULL` on every table.

S0-15 adds the firm-wide **`audit_entries`** table (replacing `FirmStore.audit`) and a per-tenant audit sequence **`tenant_audit_id_seq`**:

| Table | Normalised columns | `jsonb` columns (and why, per ADR 0028 §2) | Primary key & indexes |
|---|---|---|---|
| `audit_entries` | `tenant_id TEXT NOT NULL`, `id TEXT NOT NULL` (`AU-000001` or UUID), `seq BIGSERIAL NOT NULL` (deterministic insertion ordering when timestamps tie), `record_type TEXT NOT NULL`, `record_id TEXT NOT NULL`, `action TEXT NOT NULL`, `field TEXT NULL`, `old_value TEXT NULL`, `new_value TEXT NULL`, `reason TEXT NULL`, `by_id TEXT NOT NULL`, `at TIMESTAMPTZ NOT NULL`, `at_iso TEXT NOT NULL` (preserves exact ISO string format expected by UI/tests) | `snapshot_json JSONB NULL` — optional before/after record snapshot (`AuditEntry.snapshot`), shaped by whichever module/custom-field schema produced the audit event | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_audit_entries_tenant_at ON audit_entries (tenant_id, at DESC, seq DESC)`; `INDEX idx_audit_entries_tenant_record ON audit_entries (tenant_id, record_type, record_id, at DESC)` |

Every row carries `tenant_id TEXT NOT NULL`, checked both in SQL (`WHERE tenant_id = $1`) and in `TenantAuditRepository` via `assertRowTenant(ctx, row.tenant_id, 'audit_entries')`.

## Migrations

Expand-then-contract migration added to `CORE_TENANT_MIGRATIONS` (`core/src/tenancy/migrations/index.ts`):

1. **`0006_firm_audit_log_expand`** (`kind: 'expand'`, `requiresAppliedVersion: '0005'`):
   - **`upSql`:**
     ```sql
     CREATE SEQUENCE IF NOT EXISTS tenant_audit_id_seq START WITH 1 INCREMENT BY 1;
     CREATE TABLE IF NOT EXISTS audit_entries (
       tenant_id TEXT NOT NULL,
       id TEXT NOT NULL,
       seq BIGSERIAL NOT NULL,
       record_type TEXT NOT NULL,
       record_id TEXT NOT NULL,
       action TEXT NOT NULL,
       field TEXT NULL,
       old_value TEXT NULL,
       new_value TEXT NULL,
       reason TEXT NULL,
       by_id TEXT NOT NULL,
       at TIMESTAMPTZ NOT NULL,
       at_iso TEXT NOT NULL,
       snapshot_json JSONB NULL,
       PRIMARY KEY (tenant_id, id)
     );
     CREATE INDEX IF NOT EXISTS idx_audit_entries_tenant_at
       ON audit_entries (tenant_id, at DESC, seq DESC);
     CREATE INDEX IF NOT EXISTS idx_audit_entries_tenant_record
       ON audit_entries (tenant_id, record_type, record_id, at DESC);
     ```
   - **`downSql`:**
     ```sql
     DROP INDEX IF EXISTS idx_audit_entries_tenant_record;
     DROP INDEX IF EXISTS idx_audit_entries_tenant_at;
     DROP TABLE IF EXISTS audit_entries;
     DROP SEQUENCE IF EXISTS tenant_audit_id_seq;
     ```
   - No contract migration is needed in S0-15 because `0003`–`0005` are newly receiving runtime data; `FirmStore` JSON properties (`keyDates*`, `audit`) remain optional on the seed/import type until S0-20 retires runtime `store.ts`.

## Import (one-off JSON store to PostgreSQL)

1. **Entry point:** `scripts/import-store-to-postgres.ts` (`npm run db:import -- --modules key-dates,audit [--store-path <path>]`), calling a reusable core/server importer (`importKeyDatesAndAuditFromStore(ctx, store)`).
2. **What it imports (inside a single per-tenant transaction under `withTenantTransaction`):**
   - Populates `matter_restriction_metadata` from `store.matters` (`isRestricted = Boolean(m.isStaffMatter || m.hasEthicalWall)`, `restrictedAccessUserIds = m.restrictedAccessUserIds ?? []`) so `TenantKeyDateRepository`'s staff/ethical-wall filter has complete restriction state before `matters` moves in S0-16.
   - Upserts `store.keyDatesConfigOverride` (if present) into `key_dates_tenant_configs`.
   - Upserts every row of `store.keyDates`, `store.keyDateNotApplicable`, `store.keyDateReminderStates`, and `store.keyDateCalendarSyncs` into `key_dates`, `key_dates_not_applicable`, `key_date_reminder_states`, and `key_date_calendar_syncs` with `tenant_id = ctx.tenantId`.
   - Upserts every row of `store.audit` into `audit_entries` (preserving chronological order and advancing `tenant_audit_id_seq` via `setval('tenant_audit_id_seq', GREATEST(max_au_num, 1), true)` so subsequent `AU-XXXXXX` IDs never collide with imported IDs).
3. **Second-run idempotency:**
   - Every insert uses `ON CONFLICT (tenant_id, id) DO UPDATE SET ...` (or `(tenant_id, matter_id, key_date_type_id)` / `(tenant_id)` on singleton config tables), and `setval` uses `GREATEST(current_seq, imported_max)`. Running the import a second time produces identical row counts, zero duplicate rows, and zero sequence regression.
4. **Verification checks:**
   - After commit, the importer opens a fresh connection via `TenantScopedRepository` and verifies exact row-count parity (`keyDates`, `keyDateNotApplicable`, `keyDateReminderStates`, `keyDateCalendarSyncs`, `audit`, `matter_restriction_metadata`), asserts every row's `tenant_id === ctx.tenantId`, and exits non-zero on any mismatch (logging counts, `tenantId`, and `correlationId` only — zero PII).
   - Also wired into `scripts/seed-demo-tenant.ts`, `resetAllDemoData` (`services.ts:6544`), `clearAllDataToCleanDeployment` (`services.ts:6584`), and `e2e/global-setup.ts` so seeding or resetting a dev/test/demo tenant seeds/clears the moved Postgres tables in lockstep.

## Async conversion and effort estimate

### Why S0-15 carries the majority of the codebase's signature conversion

Because `store.audit` moves in S0-15 (Owner Decision 4) and `pg` has no synchronous API, **every function that reads or writes `audit_entries` (including unmoved modules calling the temporary Postgres audit adapter) or `key_dates` becomes `async` in S0-15**:

1. **Key dates & snapshot functions in `src/server/services.ts`:**
   - **Already `async` (7 exports — internal body updated to `TenantKeyDateRepository` + same-transaction `TenantAuditRepository`, signature unchanged):** `createOrProposeKeyDateRecord` (`:12877`), `proposeProvisionalKeyDateRecord` (`:13015`), `verifyProposedKeyDateRecord` (`:13099`), `rejectProposedKeyDateRecord` (`:13182`), `supersedeConfirmedKeyDateRecord` (`:13233`), `resolveKeyDateOutcomeRecord` (`:13373`), `reassignKeyDateTeamRecord` (`:13453`), plus already-`async` `saveMatterRecord` (`:3329`), `signOffMatterCostsRecord` (`:5367`), `switchUserInDemoMode` (`:423`), and internal `runMatterOpeningGate` (`:2960`).
   - **Synchronous -> `async` for key dates & `getAppSnapshot` (11 exports + 2 internal helpers):** `getKeyDatesConfig` (`:579`), `getAppSnapshot` (`:604`) + `getAppSnapshotInScope` (`:611`), `getMatterKeyDatesSnapshot` (`:12747`), `previewLimitationCalculationRecord` (`:12817`), `recordKeyDateNotApplicableRecord` (`:13529`), `acknowledgeKeyDateReminderRecord` (`:13582`), `runKeyDateReminderSchedulerRecord` (`:13684`), `queryKeyDatesTeamDiaryRecord` (`:13810`), `getKeyDateExceptionsReportRecord` (`:13839`), `exportKeyDateExceptionsReportRecord` (`:13872`), `saveKeyDatesConfigRecord` (`:13950`), plus internal `finalizeEnquiryConversionToMatter` (`:8809`).
2. **Unmoved modules calling the temporary Postgres audit adapter (`writeAuditToPostgresAdapter`):**
   - **63 synchronous exported functions in `src/server/services.ts`** that call `writeAudit` (`logEmployeeRestrictedAccess`, `reassignLeaverOwnedRecords`, `savePersonRecord`, `saveOrganisationRecord`, `createOrUpdateLink`, `deleteLink`, `addNoteToRecord`, `markEngagementLetterDrafted`, `liftMatterRestriction`, `runMatterConflictSearchRecord`, `updateMatterConflictRecord`, `dismissDuplicateMatch`, `addChoiceValue`, `updateChoiceValue`, `reorderChoiceValue`, `createMatterStageGroup`, `saveCustomFieldDefinition`, `reorderCustomField`, `resetAllDemoData`, `clearAllDataToCleanDeployment`, `saveTeamRecord`, `updateEmployeeRoleSetting`, `saveEnquirySettingsRecord`, `saveTaskSettingsRecord`, `saveTaskRecord`, `addTaskCommentRecord`, `saveEnquiryRecord`, `assignEnquiryRecord`, `logEnquiryContactRecord`, `sendEnquiryEmailRecord`, `closeEnquiryRecord`, `reopenEnquiryRecord`, `prepareEnquiryConversion`, `anonymiseExpiredEnquiries`, `linkPmsRecord`, `unlinkPmsRecord`, `saveHomePagesConfig`, `resetHomePagesConfig`, `addHomeRole`, `updateEmployeeRolesAndSupports`, `updatePersonPermissionOverrides`, `updateTenantRbacConfig`, `approveSignOff`, `discussSignOff`, `remindTeamLeadOverdueCompliance`, `recordInvoiceCreditControlAction`, `saveOrgStructure`, `saveMatterPartyRelationship`, `reorderMatterPartyRelationship`, `deleteMatterPartyRelationship`, `saveMatterPartyCapacity`, `deleteMatterPartyCapacity`, `updateWorkTypeProfiles`, `saveQuoteRecord`, `markQuoteSentRecord`, `logQuoteFollowUpRecord`, `reviseQuoteRecord`, `recordQuoteOutcomeRecord`, `prepareQuoteConversionRecord`, `saveMatterCostsConfig`, `syncMatterCostsRatesFromPms`, `resolveOrProvisionEntraEmployee`; note `executeMerge` already became `async` in S0-14), plus **`takeTaskRecord`** (`:7257`, delegates to `saveTaskRecord`) and internal helpers (`raiseAutomaticTask` `:7360`, `completeOpenContactTasksForEnquiry` `:7461`, `finalizeQuoteConversionToMatter` `:12333`).
   - **`src/server/documentGenerationServices.ts`:** `appendAudit` (`:904`) becomes `async` (all 9 callers in `:929`–`:1699` are already `async`).
3. **Callers outside `src/server/services.ts`:**
   - **`src/app/layout.tsx` + 23 `src/app/**/page.tsx` files (24 files, 30 call sites):** every page is already an `async` Server Component using `withPageActor(async (actor) => ...)`; add `await` to `getAppSnapshot` (24 sites), `queryKeyDatesTeamDiaryRecord` (1), `getKeyDateExceptionsReportRecord` (1), and `getMatterKeyDatesSnapshot` (1) — 27 mechanical 1-line `await` additions.
   - **`src/app/actions.ts` (1 file, 69 action callbacks):** every exported server action is already `export async function ...` returning `guardedAction(...)` (ADR 0028 §3 `:75` — public signatures do not change); add `async` / `await` inside the 69 `guardedAction` callbacks whose service became `async`.
   - **API routes (2 files, 5 call sites):** `src/app/api/auth/callback/microsoft-entra-id/route.ts:53` (`await resolveOrProvisionEntraEmployee(...)`) and `src/app/api/matters/extract/route.ts:2398, 2442, 2577, 2611` (`await savePersonRecord` / `saveOrganisationRecord` / `createOrUpdateLink` inside the already-`async` `POST` handler).
   - **Test files (14 files, ~395 call sites):** mechanical `await` insertion on direct service calls in `core/tests/isolation.test.ts` (~35 sites — note 86 `saveMatterRecord` calls already return/await a Promise), `core/tests/rbac.test.ts` (~285 sites), `core/tests/key-dates-isolation.test.ts` (1 site), `core/tests/entra-auth.test.ts` (5 sites), `core/tests/document-store.test.ts` (11 sites), `core/tests/tenant-config-usage.test.ts` (10 sites), `src/domain/employment.test.ts` (14 sites), `src/domain/home.test.ts` (15 sites), `src/domain/__tests__/draftEnquiries.test.ts` (26 sites), `src/domain/__tests__/enquiryDashboardMetrics.test.ts` (7 sites), `src/domain/__tests__/keyDateDiaryAndExceptions.test.ts` (3 sites), `src/domain/__tests__/keyDatesPermissionsAndConfig.test.ts` (22 sites), `src/domain/__tests__/matterRiskAssessment.test.ts` (2 sites), `src/server/__tests__/demoTenant.test.ts` (4 sites), `src/server/__tests__/matterExtractRoute.test.ts` (2 sites), plus replacing direct `getStore().audit` / `getStore().keyDates` test assertions with repository reads.

**Honest effort estimate:** **Size L (~3–4 engineering days).** While the SQL and repository surface in S0-15 is compact (`TenantKeyDateRepository` already exists and `TenantAuditRepository` is 1 table), pulling `audit_entries` forward into S0-15 pulls ~85% of the entire repository's synchronous-to-`async` caller conversion forward into S0-15, leaving S0-16, S0-17, and S0-18 with only 14 remaining synchronous service exports to convert. After S0-15 completes at the end of Checkpoint 4a, we will report the exact measured effort and confirm or adjust the S0-16 / S0-17 estimates before starting Checkpoint 4b.

## Operations that span modules (Owner Decision 5)

1. **Moved module writes + audit (`key_dates` + `audit_entries`):**
   - Every key-date create, propose, verify, reject, supersede, resolve, waive, reassign, not-applicable, reminder-acknowledge, exceptions-export, and config-save operation runs inside a **single `withTenantTransaction(ctx, ...)`** writing both the key-date table(s) and `audit_entries` atomically.
2. **Temporary Postgres audit adapter for unmoved JSON modules (`Owner Decision 4`):**
   - Unmoved modules (`people`, `organisations`, `links`, `notes`, `matters`, `enquiries`, `quotes`, `tasks`, `signOffs`, `pmsLinks`, `lists`, `customFields`, `orgStructure`, `homePagesConfig`, `rbac`, `documentGeneration`) write their `AuditEntry` records via `appendUnmigratedModuleAuditEntries(ctx, entries)` in `src/server/auditAdapter.ts`, which opens its own `withTenantTransaction` on `TenantAuditRepository` *after* JSON validation succeeds and `saveStore(store)` completes (restoring the pre-call JSON `storeSnapshot` if the Postgres audit transaction throws, so a failed audit write cannot leave an unaudited mutation behind — critical for HR `view-payroll` / `view-sensitive` / `update-payroll` / `update-sensitive` and RBAC overrides).
   - Every call site in `src/server/auditAdapter.ts` is tagged with the target slice (`@remove-in S0-16`, `@remove-in S0-17`, `@remove-in S0-18`) and removed module by module as each module moves into `withTenantTransaction`.
3. **`saveMatterRecord` (`:3329`) + `runMatterOpeningGate` (`:2960`) + `finalizeEnquiryConversionToMatter` (`:8809`) + `liftMatterRestriction` (`:4833`) + `reassignLeaverOwnedRecords` (`:1196`):**
   - Opening and closure gates read `keyDates` and `keyDateNotApplicable` from `TenantKeyDateRepository`.
   - When `saveMatterRecord` converts an enquiry (`carryEnquiryKeyDatesToMatter`, `:8868`) or changes matter restriction flags (`isStaffMatter`, `hasEthicalWall`, `restrictedAccessUserIds`), `saveMatterRecord` snapshots the JSON store (`storeSnapshot = structuredClone(store)`), writes the JSON store, and then runs **one Postgres transaction** writing carried/seeded `key_dates`, `matter_restriction_metadata`, and all `audit_entries`; if the Postgres transaction throws, the `catch` block restores `storeSnapshot` and calls `saveStore(store)` so neither store is left half-updated. The same compensation wraps `liftMatterRestriction` and `reassignLeaverOwnedRecords` when syncing `matter_restriction_metadata`.
4. **`updateMatterConflictRecord` (`:5101`):**
   - Reads `keyDates` and `keyDateNotApplicable` from `TenantKeyDateRepository` when evaluating the opening gate on conflict clearance, and writes its audit entry with JSON snapshot compensation.
5. **`runKeyDateReminderSchedulerRecord` (`:13684`):**
   - Reads `keyDates` and `keyDateReminderStates` from `TenantKeyDateRepository` and `matters`/`tasks`/`people`/`teams` from `store`; snapshots `store`, saves any newly raised reminder `tasks` and `notifications` to `store`, and commits updated `key_date_reminder_states` + `audit_entries` in one Postgres transaction (restoring `storeSnapshot` if the Postgres transaction fails). Once `tasks` and `notifications` move in S0-17, this becomes 100% single-transaction in Postgres before S0-19 schedules it.

## Tests

- **Unit & transactional tests (`src/domain/__tests__/keyDate*.test.ts`, `core/tests/audit-log-postgres.test.ts` — new):**
  - All 6 existing key-date test files (`keyDateCalculator`, `keyDateCalendarSync`, `keyDateDiaryAndExceptions`, `keyDateReminders`, `keyDatesPermissionsAndConfig`, `keyDateVerificationAndLifecycle`) run against real PostgreSQL via `TenantKeyDateRepository` and `TenantAuditRepository`.
  - **Same-transaction atomicity test:** force an error mid-way through a key-date write after staging an `audit_entries` insert (and vice versa) and assert via a fresh database connection that **neither** the key-date change nor the audit entry was committed.
  - **Compensation test (cross-store):** force a Postgres failure during `saveMatterRecord` enquiry conversion (`carryEnquiryKeyDatesToMatter`) and during `logEmployeeRestrictedAccess` / `savePersonRecord`, and assert both the JSON store and Postgres remain unchanged.
  - **One-off import test:** import `createSeedStore()` into Postgres, verify row counts and `AU-` sequence continuation, run the importer a second time, and assert idempotency (identical counts, zero duplicates).
- **Contract tests:**
  - `0006_firm_audit_log_expand` `upSql` -> `downSql` -> `upSql` round-trip in `core/tests/migrations-postgres.test.ts`.
  - Verify `FirmStore.keyDates*` and `FirmStore.audit` are never read or mutated at runtime in `src/server/services.ts`, `src/server/visibility.ts`, or `src/server/documentGenerationServices.ts`.
- **Two-tenant isolation tests (`core/tests/key-dates-isolation.test.ts` & `core/tests/isolation.test.ts`, Rule 9):**
  - Separate real databases (`pg_tenant_a_test`, `pg_tenant_b_test`) with per-tenant `SET ROLE`:
    - **Positive control:** Tenant A creates, verifies, queries diary/exceptions, and reads `audit_entries` for its own key dates and matters.
    - **Forged tenant claim:** calling key-date actions/services or audit queries with a forged `tenantId` is rejected with `TENANCY_FORGERY_DETECTED` (or `UNAUTHENTICATED`), asserting both `code` and `message`.
    - **Tampered record ID:** Tenant A passing Tenant B's `keyDateId` or `matterId` to `verifyProposedKeyDateRecord`, `resolveKeyDateOutcomeRecord`, `reassignKeyDateTeamRecord`, `acknowledgeKeyDateReminderRecord`, `recordKeyDateNotApplicableRecord`, or `getMatterKeyDatesSnapshot` fails with `KEY_DATE_NOT_FOUND` / `NOT_FOUND` (asserting code and message), and a fresh connection to `pg_tenant_b_test` confirms Tenant B's rows and `audit_entries` were untouched.
    - **Staff / ethical-wall restriction test:** restricted matter key dates and `key_date` audit entries in `getAppSnapshot` remain hidden from unauthorised users in the same tenant.
- **E2E tests:**
  - `e2e/global-setup.ts` runs the S0-15 Postgres import after seeding `data/seed-not-a-law-firm.json`; all 9 Playwright role journeys pass (`npm run e2e`).

## Help and documentation (rule 11)

- **`src/docs/articles/key-dates-overview.ts`, `src/docs/articles/key-dates-administration.ts`, and `src/docs/articles/data-administration-and-retention.ts`:**
  - Update storage architecture notes to reflect that key dates, key-date configurations, and the firm-wide audit log are stored in each tenant's dedicated PostgreSQL database with transactional audit recording (noting the temporary cross-store audit adapter for modules migrating in S0-16 to S0-18).
- **`src/docs/articles/demo-environment.ts` and `src/docs/articles/development-process.ts`:**
  - Document `npm run db:import` and how `seed:demo` / `resetDemoData` populate the tenant database.
- **`docs/release-notes.md`:**
  - Record runtime cut-over of key dates and the audit log to PostgreSQL (`S0-15`).
- **`docs/roadmap/feature-list.md`:**
  - Update item **8** (`Key dates and limitation` — remove `"Runs on the transitional store, not the tenant-scoped repository"` from `"What's missing"`), **P2**, and **P8**.

## Acceptance criteria

- All runtime key-date reads/writes and firm-wide audit log reads/writes go through `TenantKeyDateRepository` and `TenantAuditRepository` in PostgreSQL; `store.keyDates*` and `store.audit` are untouched at runtime.
- Key-date mutations write their data and `audit_entries` in the same Postgres transaction.
- Unmoved JSON modules write `audit_entries` via the documented temporary Postgres adapter (`src/server/auditAdapter.ts`) with snapshot compensation on failure.
- `npm run db:import -- --modules key-dates,audit` imports existing JSON store data idempotently and verifies counts on a fresh connection.
- All unit, compensation, reversible-migration, two-tenant isolation, guard (`MAX_KNOWN_GAPS = 0`), and Playwright e2e tests pass (`npm run ci`).
- Measured async-conversion effort and revised estimates for S0-16 and S0-17 are reported at the Checkpoint 4a hand-off.

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Running `migrate` (`0006`) and `db:import` against a hosted Azure environment waits on subscription access; local and CI PostgreSQL execution is unblocked.

## Rollback

- Per Owner Decision 9 (ADR 0028 §5), there is no dual-writing while there is no live client data.
- To roll back S0-15: revert the `s0-15-key-dates-and-audit-log` code revision, run `npm run db:migrate -- --down 0006` if rolling back the `audit_entries` table, and re-seed / restore from the JSON store (`npm run seed:demo -- --force` on demo). Any key dates or audit entries created after the S0-15 cut-over on non-live demo environments would be lost on revert, which is explicitly accepted in ADR 0028 §5.

## Pull request description must state

- **Change class:** Core persistence cut-over (`core/src/tenancy/`, `src/server/services.ts`, `src/app/`).
- **Both hosting models:** Identical `TenantKeyDateRepository` and `TenantAuditRepository` run per-tenant in both Model A (single-tenant dedicated server) and Model B (hosted database-per-tenant with `SET ROLE`).
- **Migration and rollback:** Runs expand migration `0006_firm_audit_log_expand` via the `migrate` job, followed by the idempotent one-off import (`npm run db:import -- --modules key-dates,audit`). Rollback reverts the code, runs `downSql` for `0006` if needed, and re-runs from the JSON store (losing post-import writes on non-live environments per ADR 0028 §5).
- **Cross-module operations & temporary audit adapter:** Lists `src/server/auditAdapter.ts` (own-transaction Postgres audit writes for unmoved JSON modules, removed module-by-module in S0-16 to S0-18) and the JSON snapshot compensation in `saveMatterRecord`, `liftMatterRestriction`, `reassignLeaverOwnedRecords`, `updateMatterConflictRecord`, and `runKeyDateReminderSchedulerRecord`.
