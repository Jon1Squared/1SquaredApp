# Transitional Store to PostgreSQL Release Cut-Over Runbook (S0-14 to S0-18)

This runbook defines the mandatory release cut-over and rollback sequence when moving modules from the transitional JSON store (`src/server/store.ts`) to per-tenant PostgreSQL databases (`core/src/tenancy/`), as specified in [ADR 0024](../decisions/0024-azure-container-apps-hosting.md), [ADR 0028 §5](../decisions/0028-tenant-database-and-repositories.md), and slices `S0-14` through `S0-18` (`R407`, `R421`).

> **Manual blocker (`docs/roadmap/stage-0-plan.md` §8):** Executing this runbook against Azure Container Apps (`ca-web-<env>`, `job-migrate-<env>`, `job-store-import-<env>`) waits on Azure subscription access. Local and CI execution (`npm run job -- migrate` and `npm run db:import`) is active now against PostgreSQL 16 + PgBouncer.

---

## 1. Core Principles

1. **No dual-writing (Owner Decision 9, ADR 0028 §5):** Once a slice cuts a module over to PostgreSQL, all reads and writes for that module go exclusively through its `TenantScopedRepository` subclass (`SET LOCAL ROLE` inside explicit transactions). Dual-write sync bridges are deleted in the same slice (`R405`).
2. **Stop writes during cut-over (`R407`):** Because the previous container revision writes to the JSON store (or transitional columns) while the new revision writes to the newly migrated PostgreSQL tables, web and scheduled job writes **must** be stopped across the cut-over window so zero writes land in the retiring store after `store-import` reads it.
3. **Read every collection or sub-document from its live source at cut-over (`R421`):** Each slice's `store-import` step must read every collection or embedded sub-document from wherever that data **currently lives at the moment of cut-over** — never assuming an already-migrated entity still has fresh data in the frozen JSON store:

   | Slice | PostgreSQL Migrations | `store-import --modules` | Live Source Read at Cut-Over |
   |---|---|---|---|
   | **S0-14** | `0001`–`0006` | `documents,document-store` | JSON store (`documentTemplates`, `documentTemplateVersions`, `documents`, `documentLinks`, `templateUsageEvents`, `documentGenerationConfigOverride`, `matterDocumentLocations`, `documentStoreFolderScopes`, `documentLifecycleJobs`, `documentReconciliationFindings`, `documentStoreAuditEvents`, `documentStoreConfigOverride`, `people[].entraObjectId`) |
   | **S0-15** | `0007` | `key-dates,audit` | JSON store (`matters` restriction metadata, `keyDatesConfigOverride`, 2-pass `keyDates`, `keyDateNotApplicable`, `keyDateReminderStates`, `keyDateCalendarSyncs`, `audit`) |
   | **S0-16** | `0008` | `directory-and-matters` | JSON store (`organisations`, `people` including transitional `employment_json`, `links`, `matters`, `notes`, `mergeHistory`, `matterPartyMigrationReport`) |
   | **S0-17a** | `0009` | `intake-and-workflows` | JSON store (`enquiries`, `quotes`, `tasks`, `notifications`, `signOffs`, `recentlyViewed`, `enquirySettings`, `taskSettings`) |
   | **S0-17b** | `0010` | `hr-and-rbac` | **Hybrid (`R421`):** `employment` and `employment.payroll` are read from PostgreSQL `people.employment_json` (live since `S0-16`), while `employeeSensitiveRecords`, `employeeMigrationReport`, `teams`, and `rbacConfigOverride` are read from the JSON store |
   | **S0-17c** | `0011` | `firm-config` | JSON store (`firm`, `lists`, `values`, `customFields`, `orgStructure`, `matterPartyTaxonomy`, `homePagesConfig`, `matterCostsConfig`, `counters`) |
   | **S0-18** | `0012` | `pms` | Global SQLite `data/pms/pms-demo.sqlite` (for demo/training tenants only) + JSON store (`pmsLinks`) |

---

## 2. Five-Step Release Cut-Over Procedure

Run these five steps in strict order for every `S0-14`–`S0-18` deployment, in both **Model A** (single-tenant client Azure) and **Model B** (hosted multi-tenant):

### Step 1 — Stop Writes

Scale the web Container App to zero replicas (or activate ingress maintenance mode) and verify no scheduled job executions (`job-scheduler-*` from `S0-19` onwards) are running:

```bash
az containerapp update \
  --resource-group "rg-onesquared-<env>-uksouth" \
  --name "ca-web-<env>" \
  --min-replicas 0 \
  --max-replicas 0
```

Confirm active replica count reaches `0` before proceeding.

### Step 2 — Run Per-Tenant Schema Migrations (`migrate` Job on Direct Port `5432`)

Update `job-migrate-<env>` and `job-store-import-<env>` to the new container image digest, then start `job-migrate-<env>`:

```bash
az containerapp job start \
  --resource-group "rg-onesquared-<env>-uksouth" \
  --name "job-migrate-<env>"
```

- `job-migrate-<env>` runs `node dist/jobs/run-job.mjs migrate` under **`migrateIdentity`** (`id-migrate-<env>`, PostgreSQL Entra administrator) directly against port **`5432`** (`PLATFORM_POSTGRES_MIGRATE_PORT=5432`, bypassing PgBouncer).
- Each tenant in `tenantRegistry` migrates inside its own transaction protected by `pg_advisory_xact_lock`. If one tenant fails, its transaction rolls back and its web requests will fail closed with `TENANT_SCHEMA_NOT_READY`, while healthy tenants complete migration (`ADR 0028 §4`, `R403`).
- Local equivalent: `npm run job -- migrate`.

### Step 3 — Run Idempotent One-Off Module Import (`store-import` Job)

Execute `job-store-import-<env>` with the slice's `--modules` list (for `S0-14`: `documents,document-store`):

```bash
az containerapp job start \
  --resource-group "rg-onesquared-<env>-uksouth" \
  --name "job-store-import-<env>" \
  --args "dist/jobs/import-store.mjs" "--modules" "documents,document-store"
```

- `import-store.mjs` connects through PgBouncer (`6432`) under **`runtimeIdentity`** (`id-runtime-<env>`, `NOINHERIT`), running every upsert inside an explicit transaction starting with `SET LOCAL ROLE role_tenant_<slug>_<env>`.
- Re-running the import is safe and idempotent (`ON CONFLICT ... DO UPDATE` / `DO NOTHING` with single-increment guard on `template_usage_daily_summaries`).
- Local equivalent: `npm run db:import -- --modules documents,document-store`.
- **S0-15** (`--modules key-dates,audit`): the import is idempotent. Running it twice leaves identical `key_dates*` and `audit_entries` counts, and the tenant `AU-` sequence is advanced past the highest imported number, so new entries continue the sequence. `audit_entries` is append-only for `role_tenant_*` (INSERT/SELECT only); the import inserts with `ON CONFLICT DO NOTHING` and never updates existing audit rows. Covered by `core/tests/audit-log-postgres.test.ts`.

### Step 4 — Verify Row Counts and `CORE_REQUIRED_SCHEMA_VERSION`

1. Inspect the Container Apps job logs (`Log Analytics`) for `"event":"store_import.tenant_succeeded"` on every enabled tenant and confirm zero `"store_import.tenant_failed"` entries. Note that `import-store.mjs` automatically verifies imported row counts on a fresh repository connection before logging `store_import.tenant_succeeded`.
2. Confirm `public.tenant_schema_migrations` in each tenant database includes `CORE_REQUIRED_SCHEMA_VERSION` (`0006` in `S0-14`, `0007` in `S0-15`). Any tenant below `CORE_REQUIRED_SCHEMA_VERSION` will immediately refuse web traffic with `TENANT_SCHEMA_NOT_READY`.

### Step 5 — Scale Up and Route Traffic to the New Web Revision

Deploy the new image digest to `ca-web-<env>` and restore normal replica scaling (`minReplicas: 1` in live; configured scale rules in non-live):

```bash
az containerapp update \
  --resource-group "rg-onesquared-<env>-uksouth" \
  --name "ca-web-<env>" \
  --image "<acr>.azurecr.io/onesquared@sha256:<digest>" \
  --min-replicas 1 \
  --max-replicas 5
```

Verify `/api/health` returns `200 OK` and Application Insights records zero `TENANT_SCHEMA_NOT_READY` or `POSTGRES_QUERY_ERROR` exceptions.

---

## 3. Rollback Procedure

While there is no live client data in Stage 0 (Owner Decision 9, ADR 0028 §5):

1. **Stop writes:** Scale `ca-web-<env>` to `0` replicas so no further writes occur.
2. **Revert application revision:** Point `ca-web-<env>` and the job definitions back to the previous known-good container image digest.
3. **Optional schema rollback (`downSql`):** All Stage 0 migrations are additive expand migrations, so the previous revision can run alongside the expanded tables. If schema rollback is explicitly required, run `TenantMigrationRunner.rollbackVersion(ctx, migration)` on port `5432` in reverse order (`0006` down to the target version).
4. **Re-seed / resume from JSON store:** Because there is no dual-writing, writes made to PostgreSQL after Step 3 of cut-over are not mirrored back into the JSON store. In non-live/demo environments, re-run `npm run seed:demo -- --force` (which resets both the JSON store and migrated PostgreSQL tables cleanly) before scaling `ca-web-<env>` back up.
