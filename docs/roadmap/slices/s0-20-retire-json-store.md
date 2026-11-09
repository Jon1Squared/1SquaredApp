# S0-20: Retire runtime JSON store, remove Firestore sync, supersede ADR 0001 and Checkpoint B

| | |
|---|---|
| Backlog | P2 (close to `Completed`), plus **Checkpoint B** (`stage-0-plan.md:122`: full two-tenant isolation suite & strict-bar `feature-list.md` status review across WP4) |
| Decision | [ADR 0028: Tenant Databases and Repositories](../../decisions/0028-tenant-database-and-repositories.md) (D3, supersedes [ADR 0001](../../decisions/0001-shared-repo-and-transitional-store.md)); [ADR 0026: Separate Demo Tenant](../../decisions/0026-demo-tenant.md) (D5, seed-only JSON builders) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4c + Checkpoint B) |
| Branch | `s0-20-retire-json-store`, from `s0-19b-anonymisation-job`, targeting `develop` |
| Change class | Core cleanup, dependency removal, architecture decision supersession, and Checkpoint B verification (`src/server/`, `src/seed/`, `package.json`, `eslint.config.mjs`, `docs/decisions/0001-shared-repo-and-transitional-store.md`, `docs/roadmap/feature-list.md`). |
| Size | S |
| Depends on | S0-15, S0-16, S0-17, S0-18, S0-19, S0-19b (every runtime module and scheduled job running on per-tenant PostgreSQL). |
| Blocking manual tasks | Owner approval required before editing `CLAUDE.md` / `AGENTS.md` references to ADR 0001 (proposed wording included below). Azure subscription access (`stage-0-plan.md` §8) remains a manual blocker only for cloud deployment/drills, noted honestly in `P12` / `P6`. |
| Baseline | `develop` at `52390b9` |

## What exists today

Checked against `develop` (`52390b9`):

1. **Runtime JSON store & Firestore sync in `src/server/store.ts` (`:1-1145`) and `package.json` (`:20`):**
   - `src/server/store.ts` contains:
     - Process-global mutable caches (`globalThis.__oneSquaredStore`, `__oneSquaredStorePath`, `__oneSquaredFirestoreHydrated`, `:50-64`).
     - Google Cloud Firestore runtime persistence (`getFirestoreDocRef`, `tryLoadFromFirestore`, `trySyncToFirestore`, `:617-709`) importing `firebase-admin/app` and `firebase-admin/firestore` (`package.json:20` `"firebase-admin": "^13.7.0"`), plus `FIREBASE_STORE_COLLECTION` / `FIREBASE_STORE_DOC` env vars.
     - Runtime disk persistence (`resolveRuntimeStoreFilePath` `:127`, `getStore` `:711`, `saveStore` `:1076`, `resetStore` `:1108`, `clearStoreToCleanDeployment` `:1116`, `nextId` `:1122`, `nextQuoteReference` `:1131`) reading and writing `data/runtime-store.json`.
     - Seed-data builders (`createSeedStore` `:258`, `createCleanDeploymentStore` `:344`, `repairOrphanTaxonomyIds` `:145`) used by `scripts/seed-demo-tenant.ts` (`S0-11b`), `src/seed/seedSnapshot.ts`, and `data/seed-not-a-law-firm.json`.
2. **ADR 0001 & governance references (`docs/decisions/0001-shared-repo-and-transitional-store.md:4`, `CLAUDE.md:46, 101, 107, 109`, `AGENTS.md:46, 101, 107, 109`):**
   - `docs/decisions/0001-shared-repo-and-transitional-store.md` still has `Status: Accepted` (`:4`).
   - `CLAUDE.md` (and `AGENTS.md`) lines `46`, `101`, `107`, and `109` still describe `src/server/store.ts` as the runtime transitional JSON store and `data/pms/pms-demo.sqlite` as the PMS database. Per the WP4 instructions, **`CLAUDE.md` / `AGENTS.md` must NOT be modified without the owner's explicit approval** — exact replacement wording is proposed below.

## Files and changes

1. **Delete runtime JSON persistence & Firestore sync (`src/server/store.ts` -> seed-only `src/seed/seedStoreBuilder.ts`, `package.json`, `package-lock.json`):**
   - Delete `getFirestoreDocRef`, `tryLoadFromFirestore`, and `trySyncToFirestore` (`src/server/store.ts:617-709`), global `__oneSquaredStore*` state (`:50-64`), `resolveRuntimeStoreFilePath` (`:127`), `getStore` (`:711`), `saveStore` (`:1076`), `resetStore` (`:1108`), `clearStoreToCleanDeployment` (`:1116`), `nextId` (`:1122`), and `nextQuoteReference` (`:1131`).
   - Remove `"firebase-admin"` from `package.json:20` and regenerate `package-lock.json` (`npm uninstall firebase-admin`), removing ~150 transitive Google Cloud packages that are unused on Azure.
   - Move `FirmStore` (renamed/typed as `SeedTenantSnapshot` with a deprecated type alias if needed for seed scripts), `createSeedStore`, and `createCleanDeploymentStore` into `src/seed/seedStoreBuilder.ts` (deleting `src/server/store.ts`, or leaving an empty compile-time guard), used **only** for:
     - `scripts/seed-demo-tenant.ts` (`npm run seed:demo` -> builds `createSeedStore` and imports into the demo tenant's PostgreSQL database via `scripts/import-store-to-postgres.ts`),
     - `scripts/import-store-to-postgres.ts` (for importing legacy JSON snapshots during development/testing),
     - `resetAllDemoData` / `clearAllDataToCleanDeployment` (which are already gated on `isDataResetAllowedEnvironment()` — never `live` — and seed/clear the tenant's PostgreSQL tables directly), and
     - `src/seed/seedSnapshot.ts` (`data/seed-not-a-law-firm.json` fixture generator).
   - Also retire runtime use of `data/pms/pms-demo.sqlite` (`src/pms/pmsSource.ts` `DemoDbPmsSource`), keeping workbook parsing in `src/pms/importPms.ts` strictly for seeding `TenantPmsRepository` in `scripts/import-pms.ts` and tests.
2. **Enforce permanent ban on runtime JSON store re-introduction (`eslint.config.mjs`, `src/test/vitest.setup.ts`):**
   - Add an ESLint `no-restricted-imports` rule in `eslint.config.mjs` (plus a Vitest architectural contract test) forbidding `src/app/**`, `src/components/**`, `core/**`, and `src/server/**` (except the explicit non-live demo reset seeder) from importing `src/seed/**` or `src/server/store`.
   - Update `src/test/vitest.setup.ts` (`:2-6`) to remove `clearStoreMemoryCache()` and reset/isolate per-test PostgreSQL state cleanly.
3. **Supersede ADR 0001 (`docs/decisions/0001-shared-repo-and-transitional-store.md`):**
   - Update line 4 from `- **Status:** Accepted` to `- **Status:** Superseded by [ADR 0028](0028-tenant-database-and-repositories.md) (runtime persistence) and [ADR 0026](0026-demo-tenant.md) (demo seeding)` and add a concise **Supersession Note (S0-20)** recording that:
     - Decision 3 (transitional runtime store `src/server/store.ts`) is retired — all runtime modules persist exclusively through `TenantScopedRepository` subclasses in `core/src/tenancy/` against per-tenant PostgreSQL databases.
     - Decision 1 (shared repository folder boundaries until client repository split per Standard §4) and Decision 2 (invented test fixtures `Not A Law Firm LLP` / `Pembroke Vaughan`) remain governed by `docs/architecture-standard.md` §4, `CLAUDE.md`, and ADR 0026.
4. **Proposed wording for `CLAUDE.md` and `AGENTS.md` (awaiting owner approval — NOT applied unless approved):**
   - **Line 46 — replace:**
     > `- See docs/decisions/0001-shared-repo-and-transitional-store.md for the approved early-stage coexistence of the Next.js host (src/), transitional local JSON store (src/server/store.ts), and invented test fixtures (Not A Law Firm LLP / Pembroke Vaughan).`
     **with:**
     > `- See docs/decisions/0028-tenant-database-and-repositories.md for per-tenant PostgreSQL persistence and repositories (superseding ADR 0001's transitional JSON store), docs/decisions/0026-demo-tenant.md for demo/dev seeding, and docs/decisions/0001-shared-repo-and-transitional-store.md for the early-stage shared repository boundary and invented test fixtures (Not A Law Firm LLP / Pembroke Vaughan).`
   - **Lines 101, 107, and 109 — replace:**
     > `- src/: Next.js host application (transitional, see ADR 0001).`
     > `  - src/server/: services and the transitional JSON store (store.ts).`
     > `- data/: invented local data (pembroke-vaughan.json, pms/pms-demo.sqlite, storage/).`
     **with:**
     > `- src/: Next.js host application.`
     > `  - src/server/: application services, authorisation guards (authorize.ts, actionPermissions.ts) and telemetry.`
     > `- data/: invented seed snapshots and local dev storage (seed-not-a-law-firm.json, storage/).`
5. **Checkpoint B verification & strict-bar backlog review (`docs/roadmap/stage-0-plan.md:122`, `docs/roadmap/feature-list.md`):**
   - Run the complete two-tenant isolation test suite (`npx vitest run isolation` + full `npm run ci`) verifying real two-database `SET ROLE` isolation across **every** module (`documents`, `document_store`, `key_dates`, `audit_entries`, `people`, `organisations`, `links`, `notes`, `merge_history`, `matters`, `matter_parties`, `enquiries`, `quotes`, `tasks`, `notifications`, `sign_offs`, `teams`, `HR/payroll`, `RBAC`, `catalogues/custom_fields`, `PMS/finance`) and **every** scheduled job (`key-date-reminders`, `usage-retention-purge`, `enquiry-retention-anonymise`), plus Key Vault and telemetry isolation.
   - Perform the **Checkpoint B strict-bar status review** of `docs/roadmap/feature-list.md`:
     - **`P2` (`Move off the transitional store`):** -> **`Completed`** (every module runs on a real per-tenant PostgreSQL database via `TenantScopedRepository` with `SET ROLE`, reversible migrations, two-tenant tests, and help documentation; runtime `store.ts` and Firestore sync deleted).
     - **`P3` (`Tenant-scope the PMS data`):** confirmed **`Completed`** (from `S0-18`).
     - **`P9` (`Background job scheduler`):** confirmed **`Completed`** (from `S0-19` & `S0-19b`).
     - **`B6` (`Matter numbers can be reissued`):** confirmed **`Completed`** (from `S0-16`).
     - **`P8` (`Two-tenant isolation tests`):** updated with complete Phase 0B repository & scheduler coverage (noting only Phase 0C's upcoming `S0-24` registers engine, `S0-25` server-side search, and `S0-28` negotiated rates remain for Stage 0 exit).
     - **`P12` (`Infrastructure gaps`):** all repository Bicep, Container Apps, PostgreSQL, Private Endpoint Key Vault, `Dockerfile`, Application Insights telemetry, and `R371` production `PLATFORM_ENVIRONMENT` checks built and tested; remains `Partly built` **only** if live Azure `what-if`/deployment verification (`stage-0-plan.md` §8 manual blocker) has not yet been run, or moves to `Completed` once verified.
     - Re-check items `1`, `1a`, `2`, `4`, `8`, `10`, `23`, `28`, `E1`, `E4`, `E6`, `E8`, `E9`, `P10`, `P11`, and update the **Delivery stages** summary counts (`docs/roadmap/feature-list.md:186-192`) so they match row-by-row.

## Tests

- **Architectural contract tests (`core/tests/no-runtime-json-store.test.ts` — new):**
  - Assert `src/server/store.ts` does not exist (or exports zero runtime persistence functions), `firebase-admin` is absent from `package.json`, `data/runtime-store.json` is never created or read during `npm test` or `npm run e2e`, and zero runtime files import `src/seed/**` (except the gated non-live demo seeder).
- **Seed & demo reset tests (`src/server/__tests__/demoTenant.test.ts`):**
  - `npm run seed:demo`, `resetDemoDataAction`, and `clearAllDataAction` work end-to-end against PostgreSQL without writing any runtime JSON store file, while still refusing to run in `live` (`enableDemoMode: false`).
- **Checkpoint B full two-tenant isolation & CI suite:**
  - `npx vitest run isolation` passes across all modules and scheduled jobs against real separate PostgreSQL databases (`SET ROLE`).
  - Full `npm run ci` passes (Gitleaks, Bicep build & lint, `tsc --noEmit`, ESLint, `verify-invented-fixtures`, `verify-no-demo-literals`, full Vitest suite, `PLATFORM_ENVIRONMENT=live` build, `docker build`, and all 9 Playwright role journeys in `npm run e2e`, with `MAX_KNOWN_GAPS = 0`).

## Help and documentation (rule 11)

- **`src/docs/articles/development-process.ts`, `src/docs/articles/deployment-and-security.ts`, `src/docs/articles/demo-environment.ts`, and `src/docs/articles/data-administration-and-retention.ts`:**
  - Remove remaining transitional JSON store (`src/server/store.ts` / `getStore()` / `data/runtime-store.json` / Firestore) descriptions (for example `demo-environment.ts:19` and `development-process.ts:49`), documenting `src/seed/seedStoreBuilder.ts` as seed-only for `dev`/`test`/`demo` PostgreSQL seeding.
- **`docs/decisions/0001-shared-repo-and-transitional-store.md`:** Marked `Superseded by ADR 0028` (and ADR 0026 for demo seeding).
- **`docs/release-notes.md` and `docs/roadmap/feature-list.md`:** Record retirement of `src/server/store.ts` and Firestore sync (`S0-20`) and complete the Checkpoint B status review (`P2` -> `Completed`).

## Acceptance criteria

- `src/server/store.ts` runtime persistence (`getStore`, `saveStore`, `data/runtime-store.json`) and Firestore sync (`firebase-admin`) are completely removed; seed builders remain only for `dev`/`test`/`demo` database seeding.
- ESLint and contract tests block re-introducing runtime JSON store imports.
- `docs/decisions/0001-shared-repo-and-transitional-store.md` is marked `Superseded by ADR 0028`.
- `CLAUDE.md` / `AGENTS.md` are **only** edited if the owner has approved the proposed wording.
- Checkpoint B's full two-tenant isolation suite passes across every module and job, `feature-list.md` is updated against the strict Completed bar, and `npm run ci` passes cleanly.

## Manual blockers

- **Owner approval for `CLAUDE.md` / `AGENTS.md` wording:** Proposed above; will not edit `CLAUDE.md` or `AGENTS.md` in Checkpoint 4c unless confirmed by the owner.
- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Cloud deployment, live `what-if`, quarterly Azure Flexible Server PITR drill, and live Application Insights alert verification wait on Azure subscription access.

## Rollback

- No database schema changes in `S0-20`. Reverting `s0-20-retire-json-store` restores `src/server/store.ts` and `firebase-admin` without affecting any PostgreSQL tenant database.

## Pull request description must state

- **Change class:** Core transitional-store retirement, dependency cleanup (`firebase-admin` removed), ADR 0001 supersession, and Checkpoint B verification.
- **Both hosting models:** Both Model A (single-tenant client Azure) and Model B (hosted multi-tenant UK Cloud) now run 100% of application state and background jobs against per-tenant PostgreSQL databases (`TenantScopedRepository` + `SET ROLE`), with zero local JSON or Firestore code paths in the container image.
- **Migration and rollback:** No database migration; clean `git revert` if needed.
