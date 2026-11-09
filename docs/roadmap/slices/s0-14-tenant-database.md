# S0-14: Real per-tenant PostgreSQL database, role isolation and migration runner

| | |
|---|---|
| Backlog | P2, P8 |
| Decision | [ADR 0028: Tenant Databases and Repositories](../../decisions/0028-tenant-database-and-repositories.md) (D3, revised and accepted 9 November 2026); [ADR 0024](../../decisions/0024-azure-container-apps-hosting.md) (`migrate` job) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4a) |
| Branch | `s0-14-tenant-database`, from `s0-13b-telemetry`, targeting `develop` |
| Change class | Core tenancy & data layer (`core/src/tenancy/`, `core/src/tenancy/migrations/`), additive optional dedicated-server config in `core/schemas/tenant-config.schema.json`, CI Postgres service containers (`.github/workflows/ci.yml`), and restore runbook (`docs/runbooks/tenant-database-restore.md`). |
| Size | L |
| Depends on | S0-13 (PostgreSQL Flexible Server & `migrate` job Bicep), S0-13b (telemetry & sanitised error logging). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) for running the quarterly point-in-time restore drill against Azure Database for PostgreSQL Flexible Server (`docs/runbooks/tenant-database-restore.md`). |
| Baseline | `develop` at `52390b9` (stacked on `s0-13b-telemetry`) |

## What exists today

Checked against `develop` (`52390b9`):

1. **In-memory Postgres simulation (`core/src/tenancy/index.ts:124-212`, `src/platform/tenantRuntime.ts:16, 255, 524-529`):**
   - No PostgreSQL driver (`pg`) is installed in `package.json:19-39`.
   - `resolveTenantPostgresConfig` (`core/src/tenancy/index.ts:124-142`) computes `databaseName: pg_tenant_${sanitized}_${environment}`, `host`, `port: 5432`, `ssl: environment !== 'dev'`, and `schema: 'public'`, but nothing connects to Postgres.
   - `PostgresTenantCluster` (`core/src/tenancy/index.ts:152-212`, instantiated via `getPlatformPostgresCluster()` in `src/platform/tenantRuntime.ts:524-529`) is an in-memory `Map<string, Map<string, TenantRecord[]>>`.
   - No `TenantScopedRepository` base class exists anywhere in `core/src/tenancy/` (ADR 0028 `:29`).
2. **Migration runner records metadata in memory without executing SQL (`core/src/tenancy/migrations/index.ts:1-689`):**
   - Four expand migrations exist with real PostgreSQL `upSql` and `downSql` strings:
     - `0001_document_generation_expand` (`:83-214`): `document_templates`, `document_template_versions`, `generated_documents`, `document_links`, `template_usage_events`, `document_generation_audit_events`.
     - `0002_document_store_metadata_expand` (`:216-360`): `matter_document_locations`, `document_store_folder_scopes`, `document_lifecycle_jobs`, `document_reconciliation_findings`, `document_store_audit_events`, `document_store_tenant_configs`.
     - `0003_key_dates_and_limitation_expand` (`:362-502`): `key_dates`, `key_dates_not_applicable`, `key_date_reminder_states`, `key_date_calendar_syncs`, `key_date_audit_events`.
     - `0004_key_dates_tenant_config_expand` (`:504-525`): `key_dates_tenant_configs`.
   - **Schema gap found during inspection:** `TenantKeyDateRepository` (`core/src/tenancy/keyDateRepository.ts:84, 92, 179-215`) also persists a 6th per-tenant collection, `matterRestrictions` (`isRestricted`, `restrictedAccessUserIds`), which has no table in `0003` or `0004`. Adding `0005_key_dates_matter_restrictions_expand` in S0-14 gives 100% SQL parity for all three existing repositories before `matters` moves in S0-16.
   - `TenantMigrationRunner` (`:532-689`) stores applied records in an in-memory `Map` (`appliedByTenantDb`, `:533`) and never runs `upSql` or `downSql`.
3. **In-memory `Map` stores inside the three existing repositories:**
   - `TenantDocumentRepository` (`core/src/tenancy/documentRepository.ts:29-31`, `databases = new Map<string, TenantDocGenDb>()`), synchronous methods (`:51-531`).
   - `TenantDocumentStoreRepository` (`core/src/tenancy/documentStoreRepository.ts:38-40`, `databases = new Map<string, TenantDocStoreDb>()`), synchronous methods (`:68-410`).
   - `TenantKeyDateRepository` (`core/src/tenancy/keyDateRepository.ts:83-85`, `databases = new Map<string, TenantKeyDateDb>()`), synchronous methods (`:179-587`).
4. **Callers of the three repositories today:**
   - `TenantDocumentRepository` is called from `core/src/domain/document-generation/{approvalWorkflow,generationService,packageTransfer,usageService}.ts`, `src/server/documentGenerationServices.ts:263-1699`, `src/server/services.ts:6101` (`executeMerge` -> `repointMergedEntityInDocRepository`), and tests (`core/tests/{document-generation,isolation,rbac,tenant-config-usage}.test.ts`, `src/domain/__tests__/documentGeneration.test.ts`).
   - `TenantDocumentStoreRepository` is called from `core/src/domain/documents/{lifecycle,reconciliation}.ts`, `src/server/documentStoreServices.ts:286-2407`, and `core/tests/document-store.test.ts`.
   - `TenantKeyDateRepository` is called only in tests today (`core/tests/key-dates-isolation.test.ts`, `core/tests/isolation.test.ts`); runtime host key-date services move onto it in **S0-15**.

## Files and changes

1. **PostgreSQL driver & `TenantScopedRepository` (`package.json`, `core/src/tenancy/postgresPoolManager.ts`, `core/src/tenancy/tenantScopedRepository.ts`, `core/src/tenancy/index.ts`):**
   - Add `pg` (`^8.x`) to `dependencies` and `@types/pg` to `devDependencies`.
   - Implement `TenantPostgresPoolManager` and `TenantScopedRepository` inside `core/src/tenancy/`:
     - Resolves the target database (`pg_tenant_<slug>_<environment>`), tenant Postgres role (`role_tenant_<slug>_<environment>`), and server host (shared `PLATFORM_POSTGRES_HOST` or tenant's dedicated `database.dedicatedServerHost` config) **strictly from `TenantContext`** (`assertValidTenantContext(ctx)`).
     - Lazily creates one `pg.Pool` per `(host, port, databaseName)` capped at `max: 5` connections per tenant per replica by default (configurable via `PLATFORM_POSTGRES_POOL_MAX`), connecting through PgBouncer (`PLATFORM_POSTGRES_PORT`, default `6432` in Azure / `5432` locally), and closes idle tenant pools after an configurable idle eviction timeout (default 5 minutes) plus graceful `closeAllTenantPools()` shutdown.
     - Supports Entra ID token acquisition in Azure (`PLATFORM_POSTGRES_AUTH_MODE=entra_managed_identity` via `@azure/identity` `DefaultAzureCredential` token for `https://ossrdbms-aad.database.windows.net/.default`, zero passwords) and standard local/CI socket/peer/dev user connection in `dev`/`test` (`PLATFORM_POSTGRES_AUTH_MODE=local`, connection settings in env, never committed secrets).
     - **Mandatory `SET ROLE` defence-in-depth (Owner Decision 2, ADR 0028 §2):** Every `withTenantConnection(ctx, fn)` and `withTenantTransaction(ctx, fn)` checks out a `PoolClient`, executes `SET ROLE <quoted_tenant_role>` (using strict identifier allow-list validation `/^[a-z0-9_]{1,63}$/`) before running caller SQL, sets `SET LOCAL statement_timeout`, and runs `RESET ROLE` in `finally` before releasing the client back to the pool (in `withTenantTransaction`, `SET LOCAL ROLE` scopes automatically to the transaction and resets on `COMMIT`/`ROLLBACK`). If a connection is ever pointed at the wrong tenant's database, `SET ROLE` or table access fails immediately because each tenant role has `CONNECT` and object privileges on its own database only.
     - Provides `assertRowTenant(ctx, rowTenantId, entityLabel)` verifying the `tenant_id` column on every returned row as a second check, and wraps `pg` errors so **no thrown `Error` ever echoes SQL text, bind parameters, or row contents** (Standard §13, working rules).
   - **Architecture boundary check:** add an ESLint `no-restricted-imports` rule in `eslint.config.mjs` (and a contract test) forbidding `import ... from 'pg'` anywhere outside `core/src/tenancy/**` (Owner Decision 2: *"No code outside `core/src/tenancy/` opens a connection"*).
2. **Additive dedicated-server configuration (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `src/docs/articles/tenant-settings.ts`):**
   - Add optional `database?: { dedicatedServerHost?: string | null }` (default `null`, hostname pattern validated, `additionalProperties: false`) to `tenant-config.schema.json` and the Zod validator so tenants with a dedicated server (Owner Decision 1) declare their server in configuration without client branches in core, and exercise it in `core/tests/tenant-config-usage.test.ts`.
3. **Real SQL `TenantMigrationRunner` & `migrate` job (`core/src/tenancy/migrations/index.ts`, `scripts/migrate-tenant-db.mjs`, `package.json`):**
   - Rewrite `TenantMigrationRunner` (`core/src/tenancy/migrations/index.ts`) to execute real SQL against the tenant's PostgreSQL database:
     - Acquires a per-tenant Postgres transaction/session advisory lock (`pg_advisory_lock(hashtext('onesquared_migrate:' || tenantId))`) so concurrent runners never race (Owner Decision 3, ADR 0028 §4).
     - Ensures `schema_migrations` (`version TEXT PRIMARY KEY`, `tenant_id TEXT NOT NULL`, `name TEXT NOT NULL`, `kind TEXT NOT NULL`, `checksum TEXT NOT NULL`, `applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`) exists in the tenant's database.
     - Verifies SHA-256 checksums of already-applied migrations (refusing drift), checks `requiresAppliedVersion` dependencies, and runs each pending migration's `upSql` (or `rollbackVersion`'s `downSql`) inside `BEGIN ... COMMIT` (`ROLLBACK` on error), recording/removing the row in `schema_migrations`.
     - **Never runs when the web app starts.** Web requests verify schema readiness or fail closed if unmigrated; migrations run exclusively via `npm run db:migrate` (`scripts/migrate-tenant-db.mjs`, invoked by the `migrate` Container Apps job in Azure and by test/dev bootstrap locally and in CI).
   - Add migration `0005_key_dates_matter_restrictions_expand` (`matter_restriction_metadata` table: `tenant_id TEXT NOT NULL`, `matter_id TEXT NOT NULL`, `is_restricted BOOLEAN NOT NULL DEFAULT FALSE`, `restricted_access_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `PRIMARY KEY (tenant_id, matter_id)`, with reversible `DROP TABLE IF EXISTS matter_restriction_metadata;` `downSql`) and fix any column/index mismatch between `0001`–`0004` SQL and the three repository types via additive expand SQL.
4. **Delete in-memory Postgres simulation & convert the three core repositories to real Postgres (`Owner Decision 6`):**
   - **Delete `PostgresTenantCluster`** (`core/src/tenancy/index.ts:152-212`, `core/src/index.ts` export, and `getPlatformPostgresCluster` / `cachedCluster` in `src/platform/tenantRuntime.ts:16, 255, 524-529`).
   - **Delete the in-memory `Map` stores** inside `TenantDocumentRepository` (`core/src/tenancy/documentRepository.ts`), `TenantDocumentStoreRepository` (`core/src/tenancy/documentStoreRepository.ts`), and `TenantKeyDateRepository` (`core/src/tenancy/keyDateRepository.ts`).
   - Make all three extend `TenantScopedRepository` and execute parameterised SQL (`$1, $2, ...`) with `async` methods (`Promise<...>`), `tenant_id` column checks, and `assertRowTenant`.
   - **Update callers of the three repositories to `await`:**
     - `core/src/domain/document-generation/{approvalWorkflow,generationService,packageTransfer,usageService}.ts` (including `executeUsageRetentionPurgeJob` at `usageService.ts:450` and `runTenantBackgroundJob` in `core/src/tenancy/index.ts`) and `core/src/domain/documents/{lifecycle,reconciliation}.ts`.
     - `src/server/documentGenerationServices.ts` (17 of 24 exports are already `async`; convert `syncStoreToRepository`, `persistRepositoryToStore`, `repointMergedEntityInDocRepository`, and their callers until `FirmStore` sync is retired in S0-17) and `src/app/api/documents/download/route.ts:50, 63` (`await repo.getDocumentById` / `await repo.listLinksForDocument`).
     - `src/server/documentStoreServices.ts` (14 of 30 exports are already `async`; convert `ensureRepositorySyncedWithStore`, `persistRepositoryToStore`, `syncMatterLifecycleOnSaveSync`, `getDocumentStoresAdminDashboard`, `saveAdminDocumentStoreConfiguration`, and `previewAdminMatterFolderTemplate`, plus `await` in `src/app/api/document-stores/route.ts:63,74,142,169,185,205,224,241`).
     - `src/server/services.ts:5639` (`executeMerge` -> `async` because it calls `await repointMergedEntityInDocRepository(...)` at `:6101`, updating `mergeRecordsAction` in `src/app/actions.ts:409` and the 27 `executeMerge` test call sites in `core/tests/rbac.test.ts`).
5. **CI & local Postgres setup (`.github/workflows/ci.yml`, `scripts/verify-ci.mjs`, `scripts/setup-test-postgres.mjs`, `docker-compose.postgres.yml`, `.env.example`):**
   - Add a `postgres:16` service container (with health checks) to **both** the `verify` and `e2e` jobs in `.github/workflows/ci.yml`.
   - Add `docker-compose.postgres.yml` at repo root for one-command local startup (`docker compose -f docker-compose.postgres.yml up -d`), and add `scripts/setup-test-postgres.mjs` (used by Vitest global setup, `e2e/global-setup.ts`, and `scripts/verify-ci.mjs`) that provisions isolated databases and distinct non-superuser Postgres roles (`CONNECT` revoked from `PUBLIC` and granted only to that tenant's role!) for the test tenants (`not-a-law-firm`, `tenant-a`, `tenant-b`, etc.) and runs `TenantMigrationRunner` (`0001`–`0005`).
   - Update `scripts/verify-ci.mjs` to verify Postgres connectivity (starting the `docker-compose.postgres.yml` container if Docker is running and Postgres isn't already listening, or failing with a clear setup message if neither local Postgres nor Docker is running).
   - Update `.env.example` with non-secret local connection settings (`PLATFORM_POSTGRES_HOST="127.0.0.1"`, `PLATFORM_POSTGRES_PORT="5432"`, `PLATFORM_POSTGRES_ADMIN_USER="postgres"`, `PLATFORM_POSTGRES_AUTH_MODE="local"` — zero real secrets; gitleaks-clean).
6. **Single-tenant backup & restore runbook (`docs/runbooks/tenant-database-restore.md` — new, ADR 0028 §7):**
   - Step-by-step operational runbook covering:
     1. Point-in-time restore (PITR) of the shared Flexible Server to a temporary isolated server in the same VNet/delegated subnet.
     2. `pg_dump --format=custom` of **only** `pg_tenant_<slug>_<env>` from the temporary server.
     3. Restoring into a staged database on the live server, verifying `schema_migrations` checksums, row counts, and `role_tenant_<slug>_<env>` permissions (`CONNECT` revoked from `PUBLIC`), and swapping the tenant database cleanly without interrupting any other tenant on the shared server.
     4. Deleting the temporary restored server and recording the drill evidence (RPO/RTO, correlation ID, operator, sign-off).
     5. Dedicated-server (`deployDedicatedPostgresServer` and Model A) direct server PITR procedure.
     6. Quarterly restore test schedule, explicitly noting the first Azure restore drill is blocked on manual Azure subscription access (`stage-0-plan.md` §8).

## Tests

- **Unit & migration tests (`core/tests/migrations-postgres.test.ts` — new, plus updated `core/tests/document-generation.test.ts` & `core/tests/document-store.test.ts`):**
  - `TenantMigrationRunner` applies `0001`–`0005` in real Postgres, records `version`, `name`, `checksum` in `schema_migrations`, is idempotent on re-run, rejects tampered checksums, rolls back cleanly on a failing SQL statement (`BEGIN ... ROLLBACK`), and executes `rollbackVersion` (`downSql`) and re-`applyUp` cleanly in reverse/forward order.
  - Concurrent `TenantMigrationRunner` invocations against the same tenant serialise cleanly via `pg_advisory_lock` without duplicate-table or race errors.
  - Pool cap (`max: 5`), idle pool eviction, and sanitised error wrapping (forcing a SQL constraint failure and asserting neither SQL parameters nor row values appear in `err.message`).
- **Contract tests:**
  - Static import-boundary test asserting zero files outside `core/src/tenancy/` import `pg` or instantiate `Pool`/`Client`, and asserting `PostgresTenantCluster` no longer exists anywhere in `core/` or `src/`.
  - `core/tests/tenant-config-usage.test.ts` updated for optional `database.dedicatedServerHost`.
- **Two-tenant isolation tests against real, separate Postgres databases (`core/tests/isolation.test.ts` & `core/tests/key-dates-isolation.test.ts`, Rule 9 & ADR 0028 §2, §8):**
  - Provision two real PostgreSQL databases (`pg_tenant_a_test`, `pg_tenant_b_test`) and two distinct non-superuser roles (`role_tenant_a_test`, `role_tenant_b_test`) with `REVOKE ALL ON DATABASE ... FROM PUBLIC` and `GRANT CONNECT` only to the matching role.
  - **Wrong-database `SET ROLE` defence-in-depth test:** prove that if a connection to `pg_tenant_b_test` attempts `SET ROLE role_tenant_a_test` or queries Tenant B's tables as `role_tenant_a_test`, PostgreSQL itself rejects access (`permission denied`), and zero rows from Tenant B are returned or modified.
  - **Repository isolation (Documents, Document Store, Key Dates):** in the same test, verify (a) positive Tenant A control creates and reads Tenant A records in `pg_tenant_a_test`, (b) forged tenant claim is rejected with `TENANCY_FORGERY_DETECTED` (asserting both `code` and `message`), (c) tampered Tenant B record ID queried under Tenant A's context returns `null` / `NOT_FOUND` (and update/delete throws/denies without touching `pg_tenant_b_test`, verified via a fresh connection to `pg_tenant_b_test`).
- **E2E tests:**
  - `npm run e2e` runs with the `postgres:16` service container in CI (`e2e` job) and passes all 9 role journeys.

## Help and documentation (rule 11)

- **`docs/runbooks/tenant-database-restore.md` (new):** Single-tenant PITR & swap procedure, dedicated-server procedure, and quarterly test log template.
- **`src/docs/articles/deployment-and-security.ts` and `src/docs/articles/development-process.ts`:**
  - Update database isolation descriptions from `FORCE ROW LEVEL SECURITY` / in-memory transitional cluster to the real per-tenant PostgreSQL database + per-tenant Postgres role (`SET ROLE`) + `tenant_id` column verification (`assertRowTenant`), `migrate` job advisory-locked migrations, and CI/local PostgreSQL testing.
- **`src/docs/articles/tenant-settings.ts`:** Document optional `database.dedicatedServerHost`.
- **`docs/development-process-and-governance-guide.md` and `README.md`:** Document local PostgreSQL / `docker-compose.postgres.yml` setup and `npm run db:migrate`.
- **`docs/release-notes.md`:** Record `TenantScopedRepository`, `pg` driver, real SQL migrations, deletion of `PostgresTenantCluster`, and the restore runbook (`S0-14`).
- **`docs/roadmap/feature-list.md`:** Update rows **P2** (real per-tenant Postgres & `TenantScopedRepository` live; module cut-overs follow in S0-15 to S0-17) and **P8** (real two-database `SET ROLE` isolation tests).

## Acceptance criteria

- `pg` is installed and `TenantScopedRepository` resolves pools strictly from `TenantContext` (capped at 5/tenant/replica, idle eviction, PgBouncer-compatible, `SET ROLE` on every connection).
- Zero code outside `core/src/tenancy/` opens a database connection or imports `pg`.
- `TenantMigrationRunner` executes real `upSql` and `downSql` in per-tenant transactions under a Postgres advisory lock, recording `version`, `name`, and `checksum` in `schema_migrations`, with a `migrate` CLI/job entry point, and never runs on web app startup.
- `PostgresTenantCluster` and all in-memory `Map` stores inside `TenantDocumentRepository`, `TenantDocumentStoreRepository`, and `TenantKeyDateRepository` are deleted.
- Both jobs in `.github/workflows/ci.yml` run against a `postgres:16` service container; `docs/runbooks/tenant-database-restore.md` is added; all unit, reversible-migration, two-tenant `SET ROLE` isolation, and Playwright e2e tests pass.

## Manual blockers

- **Quarterly Azure restore drill (`docs/roadmap/stage-0-plan.md` §8 & ADR 0028 §7):** Testing `docs/runbooks/tenant-database-restore.md` against a live Azure Database for PostgreSQL Flexible Server waits on Azure subscription access.
- **Local workstation PostgreSQL / Docker:** Neither `docker` nor `psql` is currently installed on this Windows workstation. Before running `npm test` or `npm run ci` locally in Checkpoint 4a from S0-14 onwards, either Docker Desktop (for `docker-compose.postgres.yml`) or PostgreSQL 16 (`winget install PostgreSQL.PostgreSQL.16`) must be running locally; GitHub Actions `ubuntu-latest` provides `postgres:16` automatically via service containers.

## Rollback

- Migrations `0001`–`0005` each have tested `downSql` (`npm run db:migrate -- --down <version>`).
- Host runtime modules still read their primary firm records from the JSON store in S0-14 (Document Generation and Document Store retain their JSON sync bridge until S0-17), so reverting `s0-14-tenant-database` loses no firm store data. If optional `database.dedicatedServerHost` was added to any tenant config, remove that key before reverting the schema change.

## Pull request description must state

- **Change class:** Core tenancy & persistence infrastructure (`core/src/tenancy/`, `core/src/tenancy/migrations/`), additive configuration option (`database.dedicatedServerHost`), CI Postgres service containers, and operational runbook.
- **Both hosting models:** Identical `TenantScopedRepository` and `TenantMigrationRunner` run in Model A (connecting via Entra Managed Identity and PgBouncer to the firm's dedicated PostgreSQL Flexible Server) and Model B (connecting via Entra Managed Identity and PgBouncer to the shared PostgreSQL Flexible Server — or a tenant's dedicated server when `database.dedicatedServerHost` is set — and executing `SET ROLE role_tenant_<slug>_<env>` on every checked-out connection).
- **Migration and rollback:** Runs migrations `0001`–`0005` via the `migrate` job under per-tenant advisory locks before web traffic is routed. Each migration is reversible via `downSql`.
- **Manual blockers:** Quarterly Azure Flexible Server restore runbook test waits on Azure subscription access (`stage-0-plan.md` §8).
