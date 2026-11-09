# S0-19: Tenant-aware scheduler, guardedJob, job-only permissions and key-date reminder job

| | |
|---|---|
| Backlog | P9, P7 (`[x-reserved:S0-19]` `documentGeneration.usage.retentionMonths`), P8, item 8 (Key dates and limitation), F8 (`timeZone`) |
| Decision | [ADR 0030: Tenant-Aware Scheduler](../../decisions/0030-tenant-aware-scheduler.md) (D6, accepted 9 November 2026 — Owner Decisions 7 and 8) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4c) |
| Branch | `s0-19-scheduler`, from `s0-18-pms-per-tenant` (or `develop` if Checkpoint 4b has merged), targeting `develop` |
| Change class | Core platform capability & security boundary (`core/schemas/`, `core/src/tenancy/`, `core/src/domain/rbac/registry.ts`, `src/server/authorize.ts`, `src/server/actionPermissions.ts`, `scripts/run-job.ts` -> `dist/jobs/run-job.mjs`, `core/infra/modules/platform.bicep`). |
| Size | M |
| Depends on | S0-13 (Container Apps job Bicep + `Microsoft.Insights/scheduledQueryRules` failure alert), S0-13b (`dist/jobs/run-job.mjs` bundler & telemetry), S0-14 (`tenantRegistry.ts`, `TenantScopedRepository` with `SET LOCAL ROLE`, `migrate`), S0-15 (`TenantKeyDateRepository` & `audit_entries`), S0-17a (`tasks` & `notifications` in Postgres). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) to observe live scheduled Container Apps job triggers and Azure Monitor alert firing in Azure; local and CI execution is unblocked. |
| Baseline | `develop` at `52390b9` |

## What exists today

Checked against `develop` (`52390b9`):

1. **Manual-only reminder execution & reserved usage purge (`P9`, `P7`):**
   - Key-date reminder checks (`runKeyDateReminderSchedulerRecord` at `src/server/services.ts:13684`, invoked by `runKeyDateReminderSchedulerAction` at `src/app/actions.ts:1555` with policy `keydate:configure` at `src/server/actionPermissions.ts:301`) run only when clicked manually in `KeyDatesDiaryWorkspace.tsx`.
   - `executeUsageRetentionPurgeJob` (`core/src/domain/document-generation/usageService.ts:450`) exists in core while `documentGeneration.usage.retentionMonths` (`core/schemas/tenant-config.schema.json:553`, `core/src/config-engine/index.ts:279`, `core/tests/tenant-config-usage.test.ts:621`) is marked `[x-reserved:S0-19]`.
   - *(Note: `core/schemas/tenant-registry.schema.json`, `core/src/tenancy/tenantRegistry.ts`, and `scripts/run-job.ts` -> `dist/jobs/run-job.mjs` with `migrate` are added in `S0-13b` and `S0-14` per `R403` / `R404`.)*
2. **RBAC grant-all trap for job-only permissions (`core/src/domain/rbac/registry.ts:641`, `src/server/documentStoreServices.ts:244`):**
   - `DEFAULT_RBAC_ROLES.admin.permissions` (`:641`) and `src/server/documentStoreServices.ts:244` spread `ALL_PERMISSION_KEYS`. ADR 0030 §3 (`:63-65`) requires job-only permissions to be granted to **no role — not even `admin`**.
3. **Tenant `timeZone` setting (`ADR 0030 §§2, 4`, `F8`):**
   - `core/schemas/tenant-config.schema.json` does not yet declare top-level `timeZone` (default `'Europe/London'`).

## Files and changes

Follows ADR 0030 §§1–8 verbatim (`R401`, `R403`, `R404`, `R412`, `R413`):

1. **Additive `timeZone` tenant config & `retentionMonths` activation (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `core/tests/tenant-config-usage.test.ts`):**
   - Add additive `timeZone` (`type: "string"`, `default: "Europe/London"`, validated via `Intl.DateTimeFormat(undefined, { timeZone })`, matching `tenantRegistry.ts` from `S0-14`, Rule 7).
   - Activate `[x-reserved:S0-19]` on `documentGeneration.usage.retentionMonths` (`tenant-config.schema.json:553`, `config-engine/index.ts:279`, `tenant-config-usage.test.ts:621`) by scheduling `usage-retention-purge`.
2. **Job-only permissions in RBAC — including `tenant:migrate` (`core/src/api/index.ts`, `core/src/domain/rbac/registry.ts`, `src/server/documentStoreServices.ts`, `src/server/services.ts`, `R403`, `R412`):**
   - Add `jobOnly?: boolean` to `PermissionRegistryEntry` and register **three** job-only permissions:
     - **`'tenant:migrate'`** (`module: 'tenancy'`, `sensitivity: 'critical'`, `jobOnly: true` — ADR 0030 `:93`, `R403`, `R412`)
     - **`'keydate:run_reminders'`** (`module: 'key_dates'`, `sensitivity: 'critical'`, `jobOnly: true`)
     - **`'document_generation:purge_usage'`** (`module: 'document_generation'`, `sensitivity: 'critical'`, `jobOnly: true`)
   - Export `ALL_USER_PERMISSION_KEYS` (`PERMISSION_REGISTRY.filter((e) => !e.jobOnly).map((e) => e.key)`) and `ALL_JOB_ONLY_PERMISSION_KEYS`.
   - Switch `DEFAULT_RBAC_ROLES.admin.permissions` (`registry.ts:641`) and `documentStoreServices.ts:244` to `ALL_USER_PERMISSION_KEYS`, and reject assigning any `jobOnly: true` permission in `updatePersonPermissionOverrides` (`services.ts:10201`), `updateTenantRbacConfig` (`:10300`), and `resolvePersonPermissionSet` (`FORBIDDEN`).
3. **`guardedJob(jobKey, handler)`, `system:<jobKey>` actor & `JOB_PERMISSIONS` (`src/server/authorize.ts`, `src/server/actionPermissions.ts`, `src/server/__tests__/actionPermissionGuard.test.ts`, `R403`, `R412`):**
   - Add `JOB_PERMISSIONS` in `src/server/actionPermissions.ts` mapping `'migrate'` -> `'tenant:migrate'`, `'key-date-reminders'` -> `'keydate:run_reminders'`, and `'usage-retention-purge'` -> `'document_generation:purge_usage'`. Extend `actionPermissionGuard.test.ts` so every registered job must declare a `jobOnly: true` policy (`MAX_KNOWN_GAPS = 0`).
   - Implement `guardedJob(jobKey, tenantEntry, opts, handler)` inside `runTenantBackgroundJob`:
     - Refuses missing, disabled, or unregistered tenants (`TENANCY_UNREGISTERED_JOB_TENANT`), mints a job `TenantContext` with **`actorSub: 'system:' + jobKey`** (for example `'system:migrate'`, `'system:key-date-reminders'`, `'system:usage-retention-purge'` — exact ADR 0030 `:61` format, `R412`), `actorRoles: []`, `jobPermissions: [policy.permission]`, and fresh `correlationId` via `resolveRequestCorrelationId(null)`.
     - Enforces `policy.permission` against `jobPermissions`, applies a per-tenant timeout (default `120s` via `AbortController` + `SET LOCAL statement_timeout`), emits PII-free telemetry (`job.tenant.started`, `job.tenant.succeeded`, `job.tenant.failed` — feeding S0-13's `Microsoft.Insights/scheduledQueryRules` alert rule, `R412`), and isolates per-tenant failures so remaining tenants continue before exiting non-zero.
   - Wrap `S0-14`'s `migrate` runner per tenant inside `guardedJob('migrate', ...)` (`R403`, `R412`).
4. **`job_runs` migration, single-transaction `pg_try_advisory_xact_lock` scope, and manual-run recording (`core/src/tenancy/migrations/index.ts`, `core/src/tenancy/jobRunRepository.ts`, `R401`, `R412`, `R419`):**
   - Add expand migration **`0013_scheduler_job_runs_expand`** (`kind: 'expand'`, `requiresAppliedVersion: '0012'`, `CORE_REQUIRED_SCHEMA_VERSION = '0013'`, reversible `DROP TABLE IF EXISTS job_runs;`):
     - `job_runs`: `tenant_id TEXT NOT NULL`, `id TEXT NOT NULL`, `job_key TEXT NOT NULL`, `local_date TEXT NOT NULL` (`YYYY-MM-DD` in `tenantConfig.timeZone`), `trigger_source TEXT NOT NULL CHECK (trigger_source IN ('scheduled', 'manual'))`, `triggered_by_id TEXT NOT NULL` (`'system:' || job_key` or `actor.personId`), `status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed'))`, `started_at TIMESTAMPTZ NOT NULL`, `finished_at TIMESTAMPTZ NULL`, `correlation_id TEXT NOT NULL`, `error_code TEXT NULL`, `summary_json JSONB NOT NULL DEFAULT '{}'::jsonb` (counts only — zero PII), `PRIMARY KEY (tenant_id, id)`, partial unique index `idx_job_runs_scheduled_once_per_day ON job_runs (tenant_id, job_key, local_date) WHERE status = 'succeeded' AND trigger_source = 'scheduled'`, and lookup index on `(tenant_id, job_key, local_date, status)`.
   - **Single-transaction lock coverage & local-day idempotency (`R401`, `R419`, ADR 0030 §4):**
     - **Each tenant's entire job body runs in the one `withTenantTransaction` (`SET LOCAL ROLE` first) that acquires `pg_try_advisory_xact_lock(hashtext('onesquared_job:' || jobKey || ':' || tenantId))`** (`R401`, `R419` — never splitting lock acquisition and work across separate transactions): that single transaction covers (1) acquiring `pg_try_advisory_xact_lock` (returning `'already_running'` immediately if `false`), (2) the `job_runs` check on the same transaction client (`status = 'succeeded'` for `(tenant_id, job_key, local_date)` in `tenantConfig.timeZone`, default `'Europe/London'` at `02:00`), (3) all of that tenant's reminder/purge work and `audit_entries` writes on the **same transaction client**, and (4) inserting the `status = 'succeeded'` row in `job_runs` before `COMMIT` releases the lock atomically (if step 3 throws, that transaction rolls back and a short follow-up transaction writes `status = 'failed'` so failure history is kept without blocking retry on the next hourly tick).
     - Evaluates `localDate` and local hour in `tenantConfig.timeZone` (default `'Europe/London'`, default run hour **`02:00`** per ADR 0030 `:83`). For scheduled ticks, any existing `status = 'succeeded'` row (scheduled **or** manual) for `(tenant_id, job_key, local_date)` skips the repeat; `status = 'failed'` allows retry on the next hourly tick.
   - **Manual `"Run daily reminder check"` button (`runKeyDateReminderSchedulerAction` at `src/app/actions.ts:1555`, policy at `src/server/actionPermissions.ts:301`, `R412`, `R419`):**
     - Calls the **exact same per-tenant transaction helper** for the signed-in user's tenant (behind `keydate:configure`), **taking the exact same `pg_try_advisory_xact_lock(hashtext('onesquared_job:key-date-reminders:' || tenantId))` across the check, reminder work, and `job_runs` insert** (`R419`), while recording `actor.personId` on user-triggered audit entries and **`trigger_source = 'manual'`, `status = 'succeeded'` in `job_runs`** (`ADR 0030 :80, :92`, `R412`).
5. **Bundled CLI & Bicep schedule/alert wiring (`scripts/run-job.ts` -> `dist/jobs/run-job.mjs`, `package.json`, `core/infra/modules/platform.bicep`, `R404`, `R412`):**
   - Add `"job": "tsx --conditions react-server scripts/run-job.ts"` in `package.json` (`npm run job -- <jobKey>` locally, ADR 0030 `:115`) while `scripts/build-jobs.mjs` bundles `dist/jobs/run-job.mjs` (`['node', 'dist/jobs/run-job.mjs', '<jobKey>']` in Container Apps).
   - Enable `enableSchedulerJobs`, `enableKeyDateRemindersJob`, and `enableUsageRetentionPurgeJob` (`0 * * * *`) in `core/infra/modules/platform.bicep` and verify the `Microsoft.Insights/scheduledQueryRules` alert covers all registered job keys (`R412`).

## Tests

- **Unit, RBAC & `R412` tests (`core/tests/scheduler.test.ts` — new, `core/tests/rbac.test.ts`, `src/server/__tests__/actionPermissionGuard.test.ts`, `core/tests/infra-bicep-contract.test.ts`):**
  - Assert **no role (`admin` included) holds `tenant:migrate`, `keydate:run_reminders`, or `document_generation:purge_usage`**, RBAC overrides cannot grant them (`FORBIDDEN`), and `migrate` runs inside `guardedJob` requiring `tenant:migrate` (`R403`, `R412`).
  - Assert scheduled audit entries and `job_runs.triggered_by_id` record **`system:key-date-reminders` / `system:usage-retention-purge`** (`R412`).
  - **Manual button -> `job_runs` & concurrent scheduled + manual lock test (`R412`, `R419`):** (a) invoking `runKeyDateReminderSchedulerAction` (`keydate:configure`) executes the shared job logic, writes `trigger_source: 'manual'`, `status: 'succeeded'` in `job_runs`, and causes a subsequent scheduled hourly tick on the same `local_date` to skip cleanly; (b) **starting a scheduled `key-date-reminders` run and a manual `runKeyDateReminderSchedulerAction` together (`Promise.all`) for one tenant creates each due reminder, task, notification, and audit entry once** (`R419`).
  - **`job_runs` idempotency, retry after failure, GMT/BST (`02:00` local hour across `2026-03-29` & `2026-10-25`), `pg_try_advisory_xact_lock` over PgBouncer (`R401`), per-tenant timeout isolation, zero-PII telemetry, and Bicep alert rule contract test (`R412`).**
- **Contract, two-tenant isolation & E2E tests:** `0013` `upSql` -> `downSql` -> `upSql`; `tenant-config-usage.test.ts` covers `timeZone` and `documentGeneration.usage.retentionMonths`; two-tenant PgBouncer job isolation (`core/tests/isolation.test.ts`) across `[tenant-a, tenant-b]` + unregistered/forged tenant rejection; `docker run --rm <image> node dist/jobs/run-job.mjs --list` (`R404`); `npm run e2e` passes.

## Help and documentation (rule 11)

- **`src/docs/articles/key-dates-reminders.ts`, `src/docs/articles/key-dates-administration.ts`, `src/docs/articles/deployment-and-security.ts`, `src/docs/articles/authentication-rbac-and-mfa.ts`, and `src/docs/articles/tenant-settings.ts`:** Document hourly/once-per-local-day (`02:00` default) scheduled jobs, manual `"Run daily reminder check"` recording in `job_runs`, `guardedJob` (`system:<jobKey>`), `jobOnly` permissions (`tenant:migrate`, `keydate:run_reminders`, `document_generation:purge_usage`), the narrow Rule 4 exception in `run-job`, `timeZone`, `documentGeneration.usage.retentionMonths`, and Application Insights job failure alerts.
- **`docs/rbac-reference.md`, `docs/release-notes.md`, and `docs/roadmap/feature-list.md`:** Update item **8**, **F8**, **P7**, **P8**, and **P9** (`Partly built` until `S0-19b`).

## Acceptance criteria

- `guardedJob` (`system:<jobKey>`), `JOB_PERMISSIONS` (`MAX_KNOWN_GAPS = 0`), job-only permissions (`tenant:migrate`, `keydate:run_reminders`, `document_generation:purge_usage` — granted to no role), `job_runs` (`0013`) with `pg_try_advisory_xact_lock`, manual-run `job_runs` recording, `timeZone`, `usage-retention-purge`, bundled `dist/jobs/run-job.mjs`, and Bicep job failure alerts are all live and tested (`npm run ci`).

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Live observation of Azure Container Apps cron executions and Azure Monitor alert notifications waits on subscription access.

## Rollback

- Disable the Container Apps job schedule (or revert `s0-19-scheduler`) and run `downSql` for `0013_scheduler_job_runs_expand` if rolling back schema; remove `timeZone` from tenant configs first if set.

## Pull request description must state

- **Change class:** Core scheduler (`guardedJob`, `job_runs`, `dist/jobs/run-job.mjs`), RBAC job-only permissions (`tenant:migrate`, `keydate:run_reminders`, `document_generation:purge_usage`), and additive `timeZone` config.
- **Justified scope beyond the stage-plan summary row (`R413`):** Explicitly notes (1) additive `timeZone` tenant configuration (required by ADR 0030 §§2, 4 `:44, :81-84` for DST-safe local-day scheduling) and (2) wiring `usage-retention-purge` (activating `documentGeneration.usage.retentionMonths`, reserved for `S0-19` in `S0-12`).
- **Recorded exception to Rule 4 (ADR 0030 §3):** Confined strictly to `scripts/run-job.ts` (`dist/jobs/run-job.mjs`) and `guardedJob`; every downstream repository call still requires a valid `TenantContext` and runs `SET LOCAL ROLE`.
- **Both hosting models & rollback:** Identical bundled job image runs in Model A and Model B over PgBouncer (`6432`, `migrate` on `5432`); reversible via `downSql` (`0013`) and schedule toggle.
