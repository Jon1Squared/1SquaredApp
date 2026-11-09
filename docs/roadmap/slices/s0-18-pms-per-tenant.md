# S0-18: PMS data and PMS links per tenant on PostgreSQL

| | |
|---|---|
| Backlog | P3, P7 (re-tag reserved PMS sync & Companies House settings to `backlog`), P8, items 14, 26, 35, E6 |
| Decision | [ADR 0028: Tenant Databases and Repositories](../../decisions/0028-tenant-database-and-repositories.md) (D3, accepted 9 November 2026); [ADR 0029: Finance Data Gating](../../decisions/0029-finance-data-gating.md) (D4, accepted 8 November 2026); Owner Decision 3 (9 November 2026: keep `integrations.pmsSync.*` and `pmsConnectionSecretVaultRef` reserved; move PMS data and `pms_links` per tenant only) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4b) |
| Branch | `s0-18-pms-per-tenant`, from `s0-17c-catalogues-and-configs`, targeting `develop` |
| Change class | Core feature / tenant-scoped persistence & config-merge fix (`core/src/tenancy/`, `core/src/config-engine/`, `core/schemas/tenant-config.schema.json`, `src/pms/`, `src/server/financeServices.ts`, `src/server/services.ts`, `scripts/`). |
| Size | M |
| Depends on | S0-14 (`TenantScopedRepository`, real Postgres), stacked on `S0-17c` to keep Checkpoint 4b linear and retire the final runtime `FirmStore` property (`pmsLinks`). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) only for executing `docs/runbooks/store-cut-over.md` in Azure; local and CI PostgreSQL execution is unblocked. |
| Baseline | `develop` at `52390b9` |

## What exists today

Checked against `develop` (`52390b9`):

1. **Process-wide SQLite PMS database (`src/pms/pmsSource.ts:38-89, 625-644`, `src/pms/importPms.ts`):**
   - `getPmsSource()` (`src/pms/pmsSource.ts:625-644`) returns a singleton `DemoDbPmsSource` reading one process-wide file `data/pms/pms-demo.sqlite` (`DEFAULT_PMS_DB_PATH`) with **zero `TenantContext` scoping** (`P3`, `docs/roadmap/feature-list.md:116`).
   - `scripts/import-pms.ts` (`npm run pms:import`) builds that single SQLite file from `data/pms/1Squared_PMS_Demo_Data.xlsx`.
2. **PMS links in the JSON store (`src/server/store.ts:92`):**
   - `FirmStore.pmsLinks` (`PmsLink[]`) is the **final remaining runtime property** on `FirmStore` after `S0-17c`.
   - Read and mutated in `src/server/services.ts` (`getMatterPmsViewBundle` `:9022`, `getClientPmsViewBundle` `:9097`, `getPmsAdminSnapshot` `:9255`, `linkPmsRecord` `:9313`, `unlinkPmsRecord` `:9362`, `rerunAutomaticPmsMatching` `:9387`, `createRecordFromPms` `:9452`, `requestMatterBill` `:10623`, `flagMatterWriteOff` `:10686`, `recordInvoiceCreditControlAction` `:10826`, `syncMatterCostsRatesFromPms` `:12422`, `executeMerge` `:5930-5978`), `src/server/financeServices.ts:164, 192-215` (`verifyFinanceActorAndPermission`), and `src/app/actions.ts:784` (`unlinkPmsRecordAction`).
3. **Reserved PMS sync & Companies House settings and shallow `integrations` merge bug (`P7`, Owner Decision 3, `R411`):**
   - `core/schemas/tenant-config.schema.json:236-404` currently tags `integrations.pmsConnectionSecretVaultRef` (`:238`), `integrations.companiesHouseApiKeyVaultRef` (`:245`, `core/src/config-engine/index.ts:730`, `core/tests/tenant-config-usage.test.ts:612`), and all 7 leaves of `integrations.pmsSync.*` (`enabled`, `providerKey`, `syncMode`, `matterCodeAllocation`, `clientCodeAllocation`, `pollIntervalMinutes`, `fieldMappings` at `:268-401`, `core/src/config-engine/index.ts:727`, `core/tests/tenant-config-usage.test.ts:611, 613-619`) as `for: "S0-18"`.
   - Per **Owner Decision 3 (`R411`)**, live external PMS synchronisation is out of scope for Stage 0 (S0-18 moves only PMS data and `pms_links` per tenant into PostgreSQL), and Companies House is backlog item **`F17`** (`docs/roadmap/feature-list.md:169`). All 9 settings stay reserved and are re-tagged from `"S0-18"` to `"backlog"`.
   - **Config-engine bug (`core/src/config-engine/index.ts:2412, 2444-2447`):** `loadAndValidateTenantConfig` (`:2412`) shallow-merges `base.integrations` and `overlay.integrations` (`{ ...base.integrations, ...overlay.integrations }` at `:2444-2447`), wiping `base.integrations.pmsSync` fields if an environment overlay specifies a partial `pmsSync` override.

## Files and changes

1. **Per-tenant PostgreSQL PMS schema & `TenantPmsRepository` (`core/src/tenancy/migrations/index.ts`, `core/src/tenancy/pmsRepository.ts`, `core/src/index.ts`):**
   - Add expand migration **`0012_pms_per_tenant_expand`** (`kind: 'expand'`, `requiresAppliedVersion: '0011'`, `CORE_REQUIRED_SCHEMA_VERSION = '0012'`, with full `DROP TABLE IF EXISTS ...` `downSql`) creating per-tenant PMS tables, each with `tenant_id TEXT NOT NULL` and composite primary keys `(tenant_id, ...)`:
     - `pms_links`: `(tenant_id, id)` + unique indexes on `(tenant_id, entity_type, onesquared_id)` and `(tenant_id, entity_type, pms_code)` — replaces `FirmStore.pmsLinks`.
     - `pms_extract_metadata`: `(tenant_id)` storing `as_at_date` (strictly validated via `isValidPmsAsAtDate`, failing closed with `PMS as-at date unavailable` when missing/invalid per `S0-10` / `R319` / `R358`), `source_name`, and `imported_at TIMESTAMPTZ`.
     - `pms_fee_earners`, `pms_clients`, `pms_matters`, `pms_matter_financials`, `pms_invoices`, `pms_payments`, `pms_time_entries`, `pms_disbursements`, `pms_client_account_entries`, `pms_fee_estimates`, and `pms_credit_control_log` — normalised financial columns (`NUMERIC(14,2)`) matching `src/pms/types.ts` with indexes on `(tenant_id, matter_code)`, `(tenant_id, client_code)`, `(tenant_id, fee_earner_id)`, and `(tenant_id, entry_date)`.
   - Implement `TenantPmsRepository extends TenantScopedRepository` executing parameterised SQL inside `withTenantReadTransaction` / `withTenantTransaction` (`SET LOCAL ROLE` + `assertRowTenant`).
2. **Tenant-scoped `getTenantPmsSource`, reserved-settings re-tag & `integrations.pmsSync` deep-merge fix (`src/pms/pmsSource.ts`, `core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `core/tests/tenant-config-usage.test.ts`, Owner Decision 3, `R411`):**
   - Replace the global `getPmsSource()` singleton (`src/pms/pmsSource.ts:625-644`) with `getTenantPmsSource(ctx: TenantContext): TenantPmsSource` backed by `TenantPmsRepository` — **refusing any call without a verified `TenantContext`**.
   - **Keep PMS sync & Companies House settings reserved (`R411`, Owner Decision 3):** re-tag `integrations.pmsConnectionSecretVaultRef` (`tenant-config.schema.json:238`, `config-engine/index.ts:727`, `tenant-config-usage.test.ts:611`), `integrations.pmsSync.*` (`enabled`, `providerKey`, `syncMode`, `matterCodeAllocation`, `clientCodeAllocation`, `pollIntervalMinutes`, `fieldMappings` at `tenant-config.schema.json:268-401`, `tenant-config-usage.test.ts:613-619`), and `integrations.companiesHouseApiKeyVaultRef` (`tenant-config.schema.json:245`, `config-engine/index.ts:730`, `tenant-config-usage.test.ts:612`) from `S0-18` to **`backlog`** (live external PMS sync and `F17` Companies House integration). Build **zero** dead/unused live PMS sync adapter code.
   - **Deep-merge fix (`R411`):** update `loadAndValidateTenantConfig` (`core/src/config-engine/index.ts:2444-2447`) to deep-merge `base.integrations.pmsSync` and `overlay.integrations.pmsSync` instead of overwriting `pmsSync` shallowly.
3. **Preserve 100% of ADR 0029 (`S0-10`) finance gating rules & retire `auditAdapter.ts` (`src/server/financeServices.ts`, `src/server/services.ts`, `src/app/actions.ts`):**
   - Remove `getStore()` from `src/server/financeServices.ts:164` and `src/app/actions.ts:784` (`unlinkPmsRecordAction`), reading `pms_links` and PMS rows exclusively from `TenantPmsRepository`.
   - Preserve every S0-10 rule: zero financial fields in `getAppSnapshot`; `finance:view_matter` + `canPersonAccessMatter` failing closed on unlinked PMS rows (`allUnlinkedPmsMatters` gated on `finance:manage_links`); `getFirmFinance` (`finance:view`) rebuilding all 6 roll-ups excluding `isStaffMatter` and `hasEthicalWall` (`B12`) with `as_at_date` fail-closed validation; and `requestMatterBillAction`, `flagMatterWriteOffAction`, and `recordInvoiceCreditControlActionAction` (`recordInvoiceCreditControlAction` `:10826` writing to `TenantPmsRepository` + `audit_entries` in one transaction) requiring `finance:credit_control` + `canPersonAccessMatter`.
   - Move `executeMerge` (`:5930-5978`) PMS link repointing into the single PostgreSQL merge transaction and delete `linkPmsRecord` / `unlinkPmsRecord` from `src/server/auditAdapter.ts` — **deleting `src/server/auditAdapter.ts` completely!**
4. **Per-tenant PMS import & release cut-over (`scripts/import-pms.ts`, `scripts/import-store-to-postgres.ts` -> `dist/jobs/import-store.mjs`, `docs/runbooks/store-cut-over.md`, `R407`):**
   - Update `npm run pms:import` (`scripts/import-pms.ts`) to require `--tenant <tenantSlug>` (defaulting in `dev`/`test` to the active configured tenant) and load workbook rows directly into that tenant's PostgreSQL database via `TenantPmsRepository`, removing runtime dependency on `data/pms/pms-demo.sqlite`.
   - Extend `dist/jobs/import-store.mjs --modules pms` to import `store.pmsLinks` + PMS extract rows idempotently (`ON CONFLICT ... DO UPDATE`) inside `docs/runbooks/store-cut-over.md`, and wire into `seed-demo-tenant.ts`, `resetAllDemoData`, `clearAllDataToCleanDeployment`, and `e2e/global-setup.ts`.

## Tests

- **Unit, ADR 0029 & config deep-merge tests (`src/pms/pms.test.ts`, `core/tests/rbac.test.ts`, `src/domain/home.test.ts`, `core/tests/config-engine.test.ts`):**
  - All S0-10 finance gating, restricted-matter exclusion delta, unlinked-matter fail-closed, missing/invalid `asAtDate`, prior-year exclusion, and credit-control tests run against real PostgreSQL `TenantPmsRepository`.
  - Unit test proving `loadAndValidateTenantConfig` deep-merges partial `overlay.integrations.pmsSync` overrides without wiping `base.integrations.pmsSync` (`R411`).
- **Contract tests:**
  - `0012_pms_per_tenant_expand` `upSql` -> `downSql` -> `upSql` round-trip.
  - `core/tests/tenant-config-usage.test.ts` passes with `pmsConnectionSecretVaultRef`, `integrations.pmsSync.*`, and `companiesHouseApiKeyVaultRef` verified under `backlog` (`R411`).
  - Assert `DemoDbPmsSource` / `node:sqlite` is no longer imported in runtime `src/server/` or `src/app/`, and `src/server/auditAdapter.ts` no longer exists.
- **Two-tenant isolation tests (`core/tests/isolation.test.ts`, Rule 9 & `P3`):**
  - Separate real databases (`pg_tenant_a_test`, `pg_tenant_b_test`) over PgBouncer (`SET LOCAL ROLE`) seeded with distinct PMS extracts (different `as_at_date`, clients, matters, WIP, invoices, and `pms_links`):
    - **Positive control & zero cross-tenant bleed:** Tenant A's `getFirmFinance`, `getMatterFinanceRows`, `getMyFinanceFigures`, `getMatterPmsViewBundle`, `getClientPmsViewBundle`, `getPmsAdminSnapshot`, and `syncMatterCostsRatesFromPms` return Tenant A's exact figures and never include Tenant B's rows.
    - **Forged claim & tampered IDs:** forged `tenantId` fails with `TENANCY_FORGERY_DETECTED`; Tenant A passing Tenant B's `matterId`, `pmsCode`, `invoiceNumber`, or `linkId` to `linkPmsRecord`, `unlinkPmsRecord`, `requestMatterBill`, `flagMatterWriteOff`, or `recordInvoiceCreditControlAction` fails (`NOT_FOUND` / `FORBIDDEN`), verified untouched on `pg_tenant_b_test`.
- **E2E tests:** all 9 Playwright role journeys pass (`npm run e2e`).

## Help and documentation (rule 11)

- **`src/docs/articles/tenant-settings.ts` (`R411`):** Update lines `60-68` so `integrations.pmsConnectionSecretVaultRef`, all 7 `integrations.pmsSync.*` settings, and `integrations.companiesHouseApiKeyVaultRef` (`F17`) are explicitly listed as **`Reserved (backlog)`** (live external PMS sync / Companies House integration), and document per-tenant PostgreSQL PMS storage.
- **`src/docs/articles/finance-data-and-permissions.ts`, `docs/release-notes.md`, and `docs/roadmap/feature-list.md` (`R411`):** Document per-tenant PostgreSQL PMS data + `pms_links` and `npm run pms:import -- --tenant <slug>`; move **P3** to **`Completed`** (PMS data and `pms_links` stored per tenant in PostgreSQL; live external PMS sync stays reserved and is not part of `P3`) and update **P2**, **P7** (re-tagging `pmsConnectionSecretVaultRef`, `integrations.pmsSync.*`, and `companiesHouseApiKeyVaultRef` from `S0-18` to `backlog` per `R411`), **P8**, **E6**, and item **35**.

## Acceptance criteria

- Global SQLite PMS reads (`DemoDbPmsSource`) and `FirmStore.pmsLinks` are replaced at runtime by `TenantPmsRepository` in PostgreSQL, preserving 100% of ADR 0029 (`S0-10`) rules; `src/server/auditAdapter.ts` is deleted.
- `integrations.pmsConnectionSecretVaultRef`, `integrations.pmsSync.*`, and `companiesHouseApiKeyVaultRef` remain cleanly reserved (`backlog`, listed in `tenant-settings.ts`), and `loadAndValidateTenantConfig` deep-merges `integrations.pmsSync` (`R411`).
- Two-tenant PMS isolation tests and full `npm run ci` pass (`MAX_KNOWN_GAPS = 0`).

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Cloud execution of `docs/runbooks/store-cut-over.md` waits on subscription access.

## Rollback

- Follow **`docs/runbooks/store-cut-over.md`** (`R407`): stop web writes, revert `s0-18-pms-per-tenant`, run `downSql` for `0012_pms_per_tenant_expand` if rolling back schema, and re-seed from the JSON store / `npm run pms:import`.

## Pull request description must state

- **Change class:** Core per-tenant PMS & `pms_links` PostgreSQL cut-over (`core/src/tenancy/pmsRepository.ts`, `src/pms/`, `src/server/financeServices.ts`) and `integrations.pmsSync` config deep-merge fix (`R411`).
- **Both hosting models:** Identical `TenantPmsRepository` runs per-tenant over PgBouncer (`SET LOCAL ROLE`) in Model A and Model B; live external PMS sync settings (`pmsConnectionSecretVaultRef`, `integrations.pmsSync.*`) remain reserved for `backlog` per Owner Decision 3.
- **Migration, cut-over and rollback:** Follows **`docs/runbooks/store-cut-over.md`** (`0012_pms_per_tenant_expand` + `store-import --modules pms`); reversible via `downSql`.
