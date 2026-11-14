# S0-20: Retire runtime JSON store, contract transitional bridges, remove Firestore sync, supersede ADR 0001 and Checkpoint B

| | |
|---|---|
| Backlog | P2 (close to `Completed`), plus **Checkpoint B** (`stage-0-plan.md:122`: full two-tenant isolation suite & strict-bar `feature-list.md` status review across WP4) |
| Decision | [ADR 0028: Tenant Databases and Repositories](../../decisions/0028-tenant-database-and-repositories.md) (D3, supersedes [ADR 0001](../../decisions/0001-shared-repo-and-transitional-store.md)); [ADR 0026: Separate Demo Tenant](../../decisions/0026-demo-tenant.md) (D5, seed-only builders) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4c + Checkpoint B) |
| Branch | `s0-20-retire-json-store`, from `s0-19b-anonymisation-job`, targeting `develop` |
| Change class | Core cleanup, contract migration (`0015`), dependency removal, ADR 0001 supersession, and Checkpoint B verification (`core/src/tenancy/`, `src/server/`, `src/seed/`, `core/infra/modules/platform.bicep`, `package.json`, `eslint.config.mjs`, `docs/decisions/0001-shared-repo-and-transitional-store.md`, `docs/roadmap/feature-list.md`). |
| Size | S |
| Depends on | S0-15, S0-16, S0-17a, S0-17b, S0-17c, S0-18, S0-19, S0-19b (every runtime module and scheduled job running on per-tenant PostgreSQL). |
| Blocking manual tasks | Owner decision at Checkpoint 4c on `CLAUDE.md` / `AGENTS.md` wording (`R415`). Azure subscription access (`stage-0-plan.md` §8) remains a manual blocker only for cloud deployment/drills, noted honestly in `P12` / `P6`. |
| Baseline | `develop` at `52390b9` |

## What exists today

Checked against `develop` (`52390b9`):

1. **Runtime JSON store & Firestore sync (`src/server/store.ts:1-1139`, `package.json:20`, `R414`):**
   - `src/server/store.ts` contains process-global mutable caches (`global.__oneSquaredStore`, `__oneSquaredStoreMtimeMs`, `__oneSquaredLastSavedStoreJson`, `:217-221`, `clearStoreMemoryCache` `:228`), Google Cloud Firestore sync (`firestoreSynced` & `trySyncToFirestore`, `:641-676`, importing `firebase-admin/app` and `firebase-admin/firestore` from `package.json:20` `"firebase-admin": "^14.5.0"`), runtime disk persistence (`resolveRuntimeStoreFilePath` `:127`, `getStore` `:722`, `saveStore` `:1073`, `resetStore` `:1108`, `clearStoreToCleanDeployment` `:1116`, `nextId` `:1122`, `nextQuoteReference` `:1131`), and seed builders (`repairOrphanTaxonomyIds` `:145`, `createSeedStore` `:266`, `createCleanDeploymentStore` `:563`).
   - In addition, `S0-14` added `src/server/storeLock.ts` (`withJsonStoreWriteLock`, `R406`, `R418`), `S0-13` added the transitional `store-import` manual Container Apps job (`R407`), and `S0-14`/`S0-16` left two unused transitional schema structures (`matter_restriction_metadata` from `0005`, unused since `S0-16`, and `people.employment_json` from `0008`, unused since `S0-17b`) on disk for safe expand-then-contract rollout (`R408`, `R417`).
2. **ADR 0001, `CLAUDE.md` / `AGENTS.md`, and `git ls-files data/` (`R415`):**
   - `docs/decisions/0001-shared-repo-and-transitional-store.md:4` still has `Status: Accepted`.
   - `CLAUDE.md` and `AGENTS.md` lines `46`, `101`, `107`, and `109` still reference `src/server/store.ts`, `pembroke-vaughan.json`, and `pms/pms-demo.sqlite`. On `develop` (`52390b9`), `git ls-files data/` tracks `data/pms/1Squared_PMS_Demo_Data.xlsx`, `data/pms/pms-demo.sqlite`, and `data/seed-not-a-law-firm.json` (`pembroke-vaughan.json` is already gone). Per **`R415`**, the owner will decide on the `CLAUDE.md` / `AGENTS.md` wording **at Checkpoint 4c** after checking which `data/` files still exist once `S0-18` and `S0-20` complete.

## Files and changes

1. **Contract migration `0015_transitional_bridges_contract` (`core/src/tenancy/migrations/index.ts`, `R408`, `R417`, Rule 8):**
   - Now that `S0-16` (`matters`) and `S0-17b` (`employee_employment_records`) already stopped all runtime reads and writes of `matter_restriction_metadata` and `people.employment_json` (`R417`), and `0014_enquiry_retention_anonymised_at` (`S0-19b`) is applied (`requiresAppliedVersion: '0014'`), the running `S0-19b` revision never references either structure while `0015` executes (`CORE_REQUIRED_SCHEMA_VERSION = '0015'`):
     - **`upSql`:** drops `ALTER TABLE people DROP COLUMN IF EXISTS employment_json;` and `DROP TABLE IF EXISTS matter_restriction_metadata;` (with zero fallback-read code left to remove in `S0-20`, `R417`).
     - **`downSql` (fully reversible):**
       1. Recreates `matter_restriction_metadata` (`tenant_id`, `matter_id`, `is_restricted`, `restricted_access_user_ids`, `updated_at`, `PRIMARY KEY (tenant_id, matter_id)`, granting `SELECT, INSERT, UPDATE, DELETE` to `role_tenant_<slug>_<env>`) and repopulates it from `matters` (`INSERT INTO matter_restriction_metadata (tenant_id, matter_id, is_restricted, restricted_access_user_ids, updated_at) SELECT tenant_id, id, (is_staff_matter OR has_ethical_wall), restricted_access_user_ids_json, updated_at FROM matters ON CONFLICT (tenant_id, matter_id) DO UPDATE SET is_restricted = EXCLUDED.is_restricted, restricted_access_user_ids = EXCLUDED.restricted_access_user_ids, updated_at = EXCLUDED.updated_at;`).
       2. Re-adds `ALTER TABLE people ADD COLUMN IF NOT EXISTS employment_json JSONB NULL;` and repopulates it from `employee_employment_records` (`UPDATE people p SET employment_json = e.employment_json FROM employee_employment_records e WHERE p.tenant_id = e.tenant_id AND p.id = e.person_id;`).
2. **Delete runtime JSON persistence, `storeLock.ts`, `DemoDbPmsSource` & Firestore sync (`src/server/store.ts` -> seed-only `src/seed/seedStoreBuilder.ts`, `src/server/storeLock.ts`, `package.json`, `core/infra/modules/platform.bicep`, `R406`, `R407`, `R414`):**
   - Delete `src/server/store.ts` (`trySyncToFirestore` `:643-676`, `getStore` `:722`, `saveStore` `:1073`, `resetStore` `:1108`, `clearStoreToCleanDeployment` `:1116`, `nextId` `:1122`, `nextQuoteReference` `:1131`, global caches `:217-233`) and delete **`src/server/storeLock.ts`** (`R406`).
   - Uninstall `"firebase-admin"` (`^14.5.0`, `package.json:20`) and regenerate `package-lock.json`.
   - Move `createSeedStore` and `createCleanDeploymentStore` into `src/seed/seedStoreBuilder.ts` solely for `scripts/seed-demo-tenant.ts`, non-live `resetAllDemoData` / `clearAllDataToCleanDeployment`, and `src/seed/seedSnapshot.ts`.
   - Retire `DemoDbPmsSource` (`src/pms/pmsSource.ts`) and `data/pms/pms-demo.sqlite` (keeping `data/pms/1Squared_PMS_Demo_Data.xlsx` + `src/pms/importPms.ts` for seeding `TenantPmsRepository`), and disable/remove the transitional `store-import` manual job in `core/infra/modules/platform.bicep` (`R407`).
3. **Permanent ESLint & contract ban on runtime JSON store re-introduction (`eslint.config.mjs`, `src/test/vitest.setup.ts`):**
   - Forbid `src/app/**`, `src/components/**`, `core/**`, and `src/server/**` (except the gated non-live demo reset seeder) from importing `src/seed/**` or `src/server/store`; remove `clearStoreMemoryCache()` from `src/test/vitest.setup.ts:2-6`.
4. **Supersede ADR 0001 & prepare `CLAUDE.md` / `AGENTS.md` wording for Checkpoint 4c (`docs/decisions/0001-shared-repo-and-transitional-store.md`, `R415`):**
   - Update `docs/decisions/0001-shared-repo-and-transitional-store.md:4` to `Superseded by ADR 0028 (runtime persistence) and ADR 0026 (demo seeding)` with a concise supersession note.
   - **Do NOT edit `CLAUDE.md` or `AGENTS.md` without the owner's decision at Checkpoint 4c (`R415`)** — verify `git ls-files data/` after removing `data/pms/pms-demo.sqlite` (`seed-not-a-law-firm.json`, `pms/1Squared_PMS_Demo_Data.xlsx`, `storage/`) and present the exact diff at Checkpoint 4c.
5. **Checkpoint B verification & strict-bar backlog review (`docs/roadmap/stage-0-plan.md:122`, `docs/roadmap/feature-list.md`):**
   - Run the complete PgBouncer two-tenant isolation suite (`npx vitest run isolation` + `npm run ci`) across **every** module and **every** scheduled job (`migrate`, `key-date-reminders`, `usage-retention-purge`, `enquiry-retention-anonymise`).
   - Update `docs/roadmap/feature-list.md` against the strict **Completed** bar: **`P2` -> `Completed`**, confirm **`P3`**, **`P9`**, and **`B6` = `Completed`**, update **`P8`**, **`P10`**, **`P11`**, **`P12`**, items `1`, `1a`, `2`, `4`, `8`, `10`, `23`, `28`, `E1`, `E4`, `E6`, `E8`, `E9`, and reconcile the Delivery stages summary counts (`:186-192`).

## Tests

- **Contract & migration tests (`core/tests/no-runtime-json-store.test.ts` — new, `core/tests/migrations-postgres.test.ts`):**
  - **`0015_transitional_bridges_contract` round-trip (`R408`):** seed `matters` (with restrictions) and `employee_employment_records`, apply `0015` `upSql` (asserting `matter_restriction_metadata` table and `people.employment_json` column no longer exist), run `0015` `downSql` (asserting both are recreated and accurately back-populated from `matters` and `employee_employment_records`), and re-apply `upSql`.
  - Assert `src/server/store.ts`, `src/server/storeLock.ts`, `src/server/auditAdapter.ts`, `data/pms/pms-demo.sqlite`, and `firebase-admin` (`package.json`) are gone, and `data/runtime-store.json` is never read or written during `npm test` or `npm run e2e`.
- **Seed, Checkpoint B two-tenant isolation & full CI:** `demoTenant.test.ts`, `npx vitest run isolation` over PgBouncer (`SET LOCAL ROLE`), and full `npm run ci` (`MAX_KNOWN_GAPS = 0`, 9 Playwright journeys) pass.

## Help and documentation (rule 11)

- **`src/docs/articles/development-process.ts`, `src/docs/articles/deployment-and-security.ts`, `src/docs/articles/demo-environment.ts`, and `src/docs/articles/data-administration-and-retention.ts`:** Remove remaining `src/server/store.ts` / `getStore()` / `runtime-store.json` / Firestore references (`demo-environment.ts:19`, `development-process.ts:49`), documenting `src/seed/seedStoreBuilder.ts` as seed-only.
- **`docs/decisions/0001-shared-repo-and-transitional-store.md`, `docs/release-notes.md`, and `docs/roadmap/feature-list.md`:** Supersede ADR 0001, record `S0-20` + `0015`, and complete Checkpoint B (`P2` -> `Completed`).

## Acceptance criteria

- `0015_transitional_bridges_contract` cleanly contracts `matter_restriction_metadata` and `people.employment_json` with tested reversible `downSql` (`R408`).
- `src/server/store.ts`, `src/server/storeLock.ts`, `firebase-admin`, and `data/pms/pms-demo.sqlite` are removed; ESLint and contract tests forbid runtime JSON store imports; ADR 0001 is marked `Superseded`.
- `CLAUDE.md` / `AGENTS.md` remain untouched until owner confirmation at Checkpoint 4c (`R415`).
- Checkpoint B's full two-tenant isolation suite passes across every module and job, `P2` moves to `Completed`, and `npm run ci` passes.

## Manual blockers

- **Owner decision at Checkpoint 4c (`R415`):** `CLAUDE.md` / `AGENTS.md` update deferred to Checkpoint 4c.
- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Cloud deployment, `what-if`, quarterly PITR drill, and live alert verification wait on subscription access.

## Rollback (`R408`)

- Because `S0-20` includes contract migration **`0015_transitional_bridges_contract`**, rolling back `S0-20` **first runs `downSql` for `0015`** via the `migrate` job (recreating `matter_restriction_metadata` from `matters` and re-adding/back-populating `people.employment_json` from `employee_employment_records`), and **then** reverts the `s0-20-retire-json-store` revision so prior code revisions have both transitional structures intact without data loss.

## Pull request description must state

- **Change class:** Core transitional-store retirement, contract migration `0015_transitional_bridges_contract`, `firebase-admin` removal, ADR 0001 supersession, and Checkpoint B verification.
- **Both hosting models:** Model A and Model B run 100% of application state and scheduled jobs against per-tenant PostgreSQL databases (`TenantScopedRepository` + `SET LOCAL ROLE` over PgBouncer), with zero local JSON, SQLite, or Firestore runtime paths.
- **Migration and rollback (`R408`):** Runs `0015_transitional_bridges_contract` via `migrate` before routing traffic; rollback runs `0015` `downSql` (re-populating `matter_restriction_metadata` and `people.employment_json`) before reverting the code revision.
