# S0-18: PMS data per tenant on PostgreSQL and Key Vault secret resolution

| | |
|---|---|
| Backlog | P3, P7 (`[x-reserved:S0-18]` `pmsConnectionSecretVaultRef` & `integrations.pmsSync.*`), P8, items 14, 26, 35, E6 |
| Decision | [ADR 0028: Tenant Databases and Repositories](../../decisions/0028-tenant-database-and-repositories.md) (D3, revised and accepted 9 November 2026); [ADR 0029: Finance Data Gating](../../decisions/0029-finance-data-gating.md) (D4, accepted 8 November 2026) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4b) |
| Branch | `s0-18-pms-per-tenant`, from `s0-17-remaining-modules` (or `s0-17c-catalogues-and-doc-metadata` if split), targeting `develop` |
| Change class | Core feature / tenant-scoped integration & persistence (`core/src/tenancy/`, `core/src/integrations/`, `core/src/config-engine/`, `src/pms/`, `src/server/financeServices.ts`, `src/server/services.ts`, `scripts/`). |
| Size | M |
| Depends on | S0-14 (`TenantScopedRepository`, real Postgres), S0-13b (`core/src/tenancy/keyVaultSecrets.ts`), stacked on S0-17 to keep the Checkpoint 4b branch chain linear and retire the last runtime `FirmStore` property (`pmsLinks`). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) only for testing live Azure Key Vault secret retrieval against a hosted vault; local and CI PostgreSQL + mock/vault-URI isolation tests are unblocked. |
| Baseline | `develop` at `52390b9` |

## What exists today

Checked against `develop` (`52390b9`):

1. **Process-wide SQLite PMS database (`src/pms/pmsSource.ts:38-89, 625-644`, `src/pms/importPms.ts`):**
   - `getPmsSource()` (`src/pms/pmsSource.ts:625-644`) returns a singleton `DemoDbPmsSource` reading one process-wide file `data/pms/pms-demo.sqlite` (`DEFAULT_PMS_DB_PATH`) with **zero `TenantContext` scoping** (`P3`, `docs/roadmap/feature-list.md:116`).
   - `scripts/import-pms.ts` (`npm run pms:import`) builds that single SQLite file from the demo workbook.
2. **PMS links in the JSON store (`src/server/store.ts:92`):**
   - `FirmStore.pmsLinks` (`PmsLink[]`) is the **final remaining runtime property** on `FirmStore` after S0-17.
   - Read and mutated in `src/server/services.ts` (`getPmsAdminSnapshot` `:9255`, `rerunAutomaticPmsMatching` `:9387`, `linkPmsRecord` `:9467`, `unlinkPmsRecord` `:9538`, `createRecordFromPms` `:9559`, `syncMatterCostsRatesFromPms` `:12420`, `requestMatterBill` `:10623`, `flagMatterWriteOff` `:10686`, `recordInvoiceCreditControlAction` `:10715`, `executeMerge` `:5930-5978`), `src/server/financeServices.ts:164, 192-215` (`verifyFinanceActorAndPermission`), and `src/app/actions.ts:784` (`unlinkPmsRecordAction`).
3. **Reserved PMS configuration settings & shallow `integrations` merge bug (`P7`):**
   - `core/schemas/tenant-config.schema.json:236-404` marks `integrations.pmsConnectionSecretVaultRef` (`:238`) and all leaves of `integrations.pmsSync.*` (`enabled`, `providerKey`, `syncMode`, `matterCodeAllocation`, `clientCodeAllocation`, `pollIntervalMinutes`, `fieldMappings`, `:265-402`) as `[x-reserved:S0-18]`.
   - **Schema finding 1 (`companiesHouseApiKeyVaultRef`):** `core/schemas/tenant-config.schema.json:245` (`core/src/config-engine/index.ts:246`, `core/tests/tenant-config-usage.test.ts:606`) also tagged `integrations.companiesHouseApiKeyVaultRef` as `for: "S0-18"`, even though Companies House integration is backlog item **`F17`** (`docs/roadmap/feature-list.md:169`), not PMS. In S0-18 we re-tag `companiesHouseApiKeyVaultRef` to `for: "backlog"` (matching `F19`–`F21` in S0-11b/S0-12) so `tenant-config-usage.test.ts` remains 100% honest.
   - **Config-engine finding 2 (shallow `integrations` overlay merge):** `mergeEnvironmentTenantConfig` (`core/src/config-engine/index.ts:2444-2447`) shallow-merges `base.integrations` and `overlay.integrations` (`{ ...base.integrations, ...overlay.integrations }`), which would wipe `base.integrations.pmsSync` fields if an environment overlay sets a partial `pmsSync` override. S0-18 fixes `mergeEnvironmentTenantConfig` to deep-merge `integrations.pmsSync`.

## Files and changes

1. **Per-tenant PostgreSQL PMS schema & `TenantPmsRepository` (`core/src/tenancy/migrations/index.ts`, `core/src/tenancy/pmsRepository.ts`, `core/src/index.ts`):**
   - Add expand migration **`0013_pms_per_tenant_expand`** (`kind: 'expand'`, `requiresAppliedVersion: '0012'`, with full `DROP TABLE IF EXISTS ...` `downSql`) creating per-tenant PMS tables, every one carrying `tenant_id TEXT NOT NULL` and composite primary keys `(tenant_id, ...)`:
     - `pms_links`: `(tenant_id, id)` + unique indexes on `(tenant_id, entity_type, onesquared_id)` and `(tenant_id, entity_type, pms_code)` — replaces `FirmStore.pmsLinks`.
     - `pms_extract_metadata`: `(tenant_id)` storing `as_at_date` (strictly validated via `isValidPmsAsAtDate`, failing closed with `PMS as-at date unavailable` when missing/invalid per `S0-10` / `R319` / `R358`), `source_name`, `imported_at TIMESTAMPTZ`, `sync_mode`, `last_sync_status`, `last_sync_correlation_id`.
     - `pms_fee_earners`, `pms_clients`, `pms_matters`, `pms_matter_financials`, `pms_invoices`, `pms_payments`, `pms_time_entries`, `pms_disbursements`, `pms_client_account_entries`, `pms_fee_estimates`, and `pms_credit_control_log` — normalised financial columns (`NUMERIC(14,2)`) matching `src/pms/types.ts` with indexes on `(tenant_id, matter_code)`, `(tenant_id, client_code)`, `(tenant_id, fee_earner_id)`, and `(tenant_id, entry_date)`.
   - Implement `TenantPmsRepository extends TenantScopedRepository` executing parameterised SQL under `SET ROLE` + `assertRowTenant`.
2. **Tenant-scoped PMS connector & `pmsConnectionSecretVaultRef` wiring (`core/src/integrations/pmsConnector.ts`, `src/pms/pmsSource.ts`, `core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`):**
   - Replace the global `getPmsSource()` singleton (`src/pms/pmsSource.ts:625-644`) with `getTenantPmsSource(ctx: TenantContext, tenantConfig: TenantConfiguration): TenantPmsSource` backed by `TenantPmsRepository` — **refusing any call without a verified `TenantContext`**.
   - Wire `integrations.pmsConnectionSecretVaultRef` and `integrations.pmsSync` (`enabled`, `providerKey`, `syncMode`, `matterCodeAllocation`, `clientCodeAllocation`, `pollIntervalMinutes`, `fieldMappings`) into `TenantPmsSyncConnector`:
     - Resolves the external PMS connection secret exclusively through `resolveTenantKeyVaultSecret` (`core/src/tenancy/keyVaultSecrets.ts` from S0-13b), enforcing that Tenant A's `pmsConnectionSecretVaultRef` can only reference Tenant A's Key Vault (`TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED` on cross-tenant vault refs).
     - Applies `integrations.pmsSync.enabled`, `syncMode` (`read_only` vs `two_way` gating outbound PMS sync commands), `matterCodeAllocation` / `clientCodeAllocation`, `pollIntervalMinutes`, and `fieldMappings` when importing/reconciling PMS records (`src/domain/pmsSync.ts`), removing `[x-reserved:S0-18]` from all PMS settings in `tenant-config.schema.json`, `core/src/config-engine/index.ts`, and `core/tests/tenant-config-usage.test.ts` (and re-tagging `companiesHouseApiKeyVaultRef` to `for: 'backlog'`, `F17`).
     - Fix `mergeEnvironmentTenantConfig` (`core/src/config-engine/index.ts:2444-2447`) to deep-merge `integrations.pmsSync`.
3. **Preserve 100% of ADR 0029 (`S0-10`) finance gating rules (`src/server/financeServices.ts`, `src/server/services.ts`, `src/app/actions.ts`):**
   - Remove `getStore()` from `src/server/financeServices.ts:164` and `src/app/actions.ts:784` (`unlinkPmsRecordAction`), reading `pms_links` and PMS financial rows from `TenantPmsRepository`.
   - Keep **every single S0-10 rule intact**:
     - Zero financial fields in `getAppSnapshot`.
     - `getMatterFinanceRows`, `getMyFinanceFigures`, `getMatterPmsViewBundle`, and `getClientPmsViewBundle` require `finance:view_matter` + `canPersonAccessMatter` (failing closed on unlinked PMS rows; `allUnlinkedPmsMatters` gated on `finance:manage_links`).
     - `getFirmFinance` requires `finance:view` and rebuilds all 6 roll-ups (`buildFirmFinanceRollups`, `buildClientFinancialsFromRows`, `buildFeeEarnerWeeklyTime`) excluding restricted `isStaffMatter` and `hasEthicalWall` matters (`B12`) and deriving period windows strictly from `pms_extract_metadata.as_at_date` (`PMS as-at date unavailable` fail-closed).
     - `requestMatterBillAction`, `flagMatterWriteOffAction`, and `recordInvoiceCreditControlActionAction` (`recordInvoiceCreditControlAction` converted from sync/`store` -> `TenantPmsRepository` + same-transaction `audit_entries`) require `finance:credit_control` + `canPersonAccessMatter`.
   - Move `executeMerge` (`:5930-5978`) PMS link repointing into the single PostgreSQL merge transaction and delete the final two `@remove-in S0-18` entries (`linkPmsRecord`, `unlinkPmsRecord`) — **deleting `src/server/auditAdapter.ts` completely!**
4. **Per-tenant PMS import & demo seeding (`scripts/import-pms.ts`, `scripts/seed-demo-tenant.ts`, `scripts/import-store-to-postgres.ts`):**
   - Update `npm run pms:import` (`scripts/import-pms.ts`) to require `--tenant <tenantSlug>` (defaulting in `dev`/`test` to the active configured tenant package, never writing a shared un-scoped file at runtime), loading workbook data and `pms_links` idempotently into that tenant's PostgreSQL database (`TenantPmsRepository`) and removing runtime dependency on `data/pms/pms-demo.sqlite`.
   - Update `scripts/seed-demo-tenant.ts`, `resetAllDemoData`, `clearAllDataToCleanDeployment`, and `e2e/global-setup.ts` to seed/clear `TenantPmsRepository` (`pms_links` + demo PMS dataset when demo seeding) per tenant.

## Tests

- **Unit & ADR 0029 regression tests (`src/pms/pms.test.ts`, `core/tests/rbac.test.ts`, `src/domain/home.test.ts`):**
  - All S0-10 finance gating, restricted-matter exclusion delta, unlinked-matter fail-closed, missing/invalid `asAtDate`, prior-year exclusion, credit-control permission, and `syncMode: 'read_only'` vs `'two_way'` / `fieldMappings` tests run against real PostgreSQL `TenantPmsRepository`.
  - Deep-merge test for `mergeEnvironmentTenantConfig` on `integrations.pmsSync`.
- **Contract tests:**
  - `0013_pms_per_tenant_expand` `upSql` -> `downSql` -> `upSql` round-trip in `core/tests/migrations-postgres.test.ts`.
  - `core/tests/tenant-config-usage.test.ts` passes with `pmsConnectionSecretVaultRef` and all `integrations.pmsSync.*` settings removed from `RESERVED_FOR_SLICE` (`'S0-18'`) and genuinely exercised at runtime.
  - Assert `DemoDbPmsSource` / `node:sqlite` is no longer imported anywhere in runtime `src/server/` or `src/app/`, and `src/server/auditAdapter.ts` no longer exists.
- **Two-tenant isolation tests (`core/tests/isolation.test.ts`, Rule 9 & Backlog `P3`):**
  - Separate real databases (`pg_tenant_a_test`, `pg_tenant_b_test`) loaded with distinct PMS extracts (different `as_at_date`, clients, matters, WIP, invoices, and `pms_links`):
    - **Positive control:** Tenant A `getFirmFinance`, `getMatterFinanceRows`, `getMyFinanceFigures`, `getMatterPmsViewBundle`, `getClientPmsViewBundle`, and `getPmsAdminSnapshot` return Tenant A's exact figures and `as_at_date`.
    - **Zero cross-tenant bleed:** Tenant B's PMS invoices, WIP, fee earners, and `pms_links` never appear in Tenant A's totals, unlinked lists, or rate syncs.
    - **Vault secret isolation:** Tenant A attempting to resolve a `pmsConnectionSecretVaultRef` pointing at Tenant B's Key Vault fails closed with `TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED`.
    - **Forged tenant claim & tampered IDs:** forged `tenantId` fails with `TENANCY_FORGERY_DETECTED`; Tenant A passing Tenant B's `matterId`, `pmsCode`, `invoiceNumber`, or `linkId` to `linkPmsRecord`, `unlinkPmsRecord`, `requestMatterBill`, `flagMatterWriteOff`, or `recordInvoiceCreditControlAction` fails with `NOT_FOUND` / `FORBIDDEN` (asserting both `code` and `message`), verified untouched on a fresh connection to `pg_tenant_b_test`.
- **E2E tests:**
  - `e2e/global-setup.ts` seeds per-tenant PMS data into Postgres; all 9 Playwright role journeys pass (`npm run e2e`).

## Help and documentation (rule 11)

- **`src/docs/articles/finance-data-and-permissions.ts` and `src/docs/articles/tenant-settings.ts`:**
  - Document per-tenant PMS PostgreSQL storage, `pmsConnectionSecretVaultRef` Key Vault resolution, `integrations.pmsSync` configuration (`enabled`, `providerKey`, `syncMode`, code allocation, `fieldMappings`), and `npm run pms:import -- --tenant <slug>`.
- **`docs/release-notes.md`:**
  - Record per-tenant PMS PostgreSQL cut-over, Key Vault secret resolution, activation of `integrations.pmsSync`, and retirement of global SQLite (`S0-18`).
- **`docs/roadmap/feature-list.md`:**
  - Move **P3** (`Tenant-scope the PMS data`) to **`Completed`**!
  - Update **P2** (all runtime modules now off `FirmStore`; S0-20 removes `store.ts` runtime helpers and Firestore sync), **P7** (`pmsConnectionSecretVaultRef` & `integrations.pmsSync.*` active; `companiesHouseApiKeyVaultRef` aligned to `F17`), **P8** (PMS SQL two-tenant isolation completed), **E6**, and item **35**.

## Acceptance criteria

- Global process-wide SQLite PMS reads (`DemoDbPmsSource`) and `FirmStore.pmsLinks` are replaced at runtime by `TenantPmsRepository` in PostgreSQL.
- External PMS connection credentials resolve per-tenant via `pmsConnectionSecretVaultRef` and `core/src/tenancy/keyVaultSecrets.ts`.
- All `[x-reserved:S0-18]` PMS settings are active and verified by `core/tests/tenant-config-usage.test.ts` (`companiesHouseApiKeyVaultRef` re-tagged to `backlog` for `F17`), and `mergeEnvironmentTenantConfig` deep-merges `integrations.pmsSync`.
- Every ADR 0029 (`S0-10`) finance gating and restricted-matter rule holds without regression.
- `src/server/auditAdapter.ts` is completely removed (100% of audit writes share their module's PostgreSQL transaction).
- Two-tenant PMS database and Key Vault isolation tests and all CI checks pass (`npm run ci`, `MAX_KNOWN_GAPS = 0`).

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Testing live Azure Key Vault secret retrieval for an external client PMS database waits on Azure subscription access.

## Rollback

- `0013_pms_per_tenant_expand` has a tested `downSql` dropping the `pms_*` tables. Rolling back reverts `s0-18-pms-per-tenant`, runs `downSql` for `0013`, and re-runs `npm run pms:import` / demo seed.

## Pull request description must state

- **Change class:** Core per-tenant integration & persistence (`core/src/tenancy/pmsRepository.ts`, `core/src/integrations/`, `src/pms/`, `src/server/financeServices.ts`) and activation of `integrations.pmsConnectionSecretVaultRef` & `integrations.pmsSync.*`.
- **Both hosting models:** Identical `TenantPmsRepository` and `TenantPmsSyncConnector` run in Model A (resolving the firm's PMS secret from the firm's Key Vault into the firm's dedicated Postgres server) and Model B (resolving each hosted tenant's PMS secret strictly from that tenant's Key Vault into that tenant's isolated Postgres database with `SET ROLE`).
- **Migration and rollback:** Runs `0013_pms_per_tenant_expand` via `migrate` job, then `npm run pms:import -- --tenant <slug>` / `db:import -- --modules pms`. Reversible via `downSql`.
