# S0-19: Tenant-aware scheduler, guardedJob, job-only permissions and key-date reminder job

| | |
|---|---|
| Backlog | P9, P7 (`[x-reserved:S0-19]` `documentGeneration.usage.retentionMonths`), P8, item 8 (Key dates and limitation), F8 (`timeZone`) |
| Decision | [ADR 0030: Tenant-Aware Scheduler on Container Apps Jobs](../../decisions/0030-tenant-aware-scheduler.md) (D6, revised and accepted 9 November 2026 — Owner Decisions 7 and 8) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4c) |
| Branch | `s0-19-scheduler`, from `s0-18-pms-per-tenant` (or `develop` if Checkpoint 4b has merged), targeting `develop` |
| Change class | Core platform capability & security boundary (`core/schemas/`, `core/src/tenancy/`, `core/src/domain/rbac/registry.ts`, `src/server/authorize.ts`, `src/server/actionPermissions.ts`, `scripts/run-job.mjs`, `core/infra/`). |
| Size | M |
| Depends on | S0-13 (Container Apps job Bicep resources), S0-14 (`TenantScopedRepository` & real Postgres), S0-15 (`TenantKeyDateRepository` & `audit_entries`), S0-17 (`tasks` & `notifications` in Postgres so reminder runs are 100% transactional). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) to trigger and observe scheduled Container Apps job executions in Azure; local and CI CLI + Postgres execution is unblocked. |
| Baseline | `develop` at `52390b9` |

## What exists today

Checked against `develop` (`52390b9`):

1. **No scheduler, tenant registry, `guardedJob`, or `job_runs` table (`P9`):**
   - `package.json:6-18` has no `job` script and `scripts/run-job.mjs` does not exist.
   - Key-date reminder checks (`runKeyDateReminderSchedulerRecord`, `src/server/services.ts:13684`, exposed via `runKeyDateReminderSchedulerAction` in `src/app/actions.ts:1540` with policy `keydate:configure` + MFA in `src/server/actionPermissions.ts:685`) can only be triggered manually via the UI button.
   - `executeUsageRetentionPurgeJob` (`core/src/domain/document-generation/usageService.ts:450`) exists in core, while `documentGeneration.usage.retentionMonths` in `core/schemas/tenant-config.schema.json:585` (`core/src/config-engine/index.ts:873`, `core/tests/tenant-config-usage.test.ts:624`) is marked `[x-reserved:S0-19]` waiting for the S0-19 scheduler to invoke it!
2. **RBAC permission grant-all trap for job-only permissions (`core/src/domain/rbac/registry.ts:641`, `src/server/documentStoreServices.ts:244`):**
   - `DEFAULT_RBAC_ROLES.admin.permissions` (`core/src/domain/rbac/registry.ts:641`) spreads `[...ALL_PERMISSION_KEYS]`, and `src/server/documentStoreServices.ts:244` grants `ALL_PERMISSION_KEYS` to `admin` actors when building SharePoint actor contexts.
   - ADR 0030 §3 (`docs/decisions/0030-tenant-aware-scheduler.md:45-53`) mandates that **job-only permissions are granted to no role — not even `admin`** — so no interactive user or server action can ever hold or self-grant a job-only permission.
3. **Tenant `timeZone` setting not yet in schema (`ADR 0030 §5`, `F8`):**
   - `core/schemas/tenant-config.schema.json` does not yet have a `timeZone` property; `src/domain/enquiries.ts` (`formatLondonDateIso`) currently hard-codes `'Europe/London'`.

## Files and changes

Follows ADR 0030 §§1–8 verbatim:

1. **Tenant registry schema & loader (`core/schemas/tenant-registry.schema.json` — new, `core/src/tenancy/tenantRegistry.ts` — new, `client-not-a-law-firm/config/tenant-registry.json` / env config):**
   - JSON Schema + Zod validator for the environment's active tenant registry (`environment`, `tenants[]` with `tenantId` matching `^[a-z0-9][a-z0-9-]{1,62}$`, `packageDir` / config ref, `enabled: boolean`, optional `dedicatedPostgresHost`).
   - Works identically in **Model A** (registry contains the single firm tenant) and **Model B** (registry lists all active hosted tenants in that environment), refusing disabled or malformed entries.
2. **Additive `timeZone` tenant configuration (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `core/src/api/index.ts`):**
   - Add additive `timeZone` (`type: "string"`, `default: "Europe/London"`, description: IANA time zone for tenant local-day calculations and scheduling) to `tenant-config.schema.json`, validated in `core/src/config-engine/index.ts` via `Intl.DateTimeFormat(undefined, { timeZone })` so invalid zone strings fail config validation immediately (Rule 7).
   - Activate `[x-reserved:S0-19]` on `documentGeneration.usage.retentionMonths` (`tenant-config.schema.json:585`, `core/src/config-engine/index.ts:873`, `core/tests/tenant-config-usage.test.ts:624`) by wiring the scheduled `usage-retention-purge` job alongside `key-date-reminders`.
3. **Job-only permissions in RBAC (`core/src/api/index.ts`, `core/src/domain/rbac/registry.ts`, `src/server/documentStoreServices.ts`, `src/server/services.ts`):**
   - Add `jobOnly?: boolean` to `PermissionRegistryEntry` (`core/src/api/index.ts`).
   - Register:
     - `'keydate:run_reminders'` (`module: 'key_dates'`, `sensitivity: 'critical'`, `jobOnly: true`)
     - `'document_generation:purge_usage'` (`module: 'document_generation'`, `sensitivity: 'critical'`, `jobOnly: true`)
   - Export `ALL_USER_PERMISSION_KEYS` (`PERMISSION_REGISTRY.filter((e) => !e.jobOnly).map((e) => e.key)`) and `ALL_JOB_ONLY_PERMISSION_KEYS`.
   - Update `DEFAULT_RBAC_ROLES.admin.permissions` (`core/src/domain/rbac/registry.ts:641`) and `src/server/documentStoreServices.ts:244` to use `ALL_USER_PERMISSION_KEYS` instead of `ALL_PERMISSION_KEYS`, and update `updateTenantRbacConfig` / `updatePersonPermissionOverrides` (`src/server/services.ts:10201, 10300`) and `resolvePersonPermissionSet` to **reject any attempt to assign a `jobOnly: true` permission to a role or person** (`FORBIDDEN`).
4. **`guardedJob(jobKey, handler)` & `JOB_PERMISSIONS` (`src/server/authorize.ts`, `src/server/actionPermissions.ts`, `src/server/__tests__/actionPermissionGuard.test.ts`):**
   - Add `JOB_PERMISSIONS` in `src/server/actionPermissions.ts` mapping each `RegisteredJobKey` (`'key-date-reminders'`, `'usage-retention-purge'`) to its required `jobOnly: true` permission (`'keydate:run_reminders'`, `'document_generation:purge_usage'`).
   - Extend `src/server/__tests__/actionPermissionGuard.test.ts` so every registered job in `JOB_REGISTRY` must have an explicit `JOB_PERMISSIONS` entry referencing a `jobOnly: true` permission, keeping **`MAX_KNOWN_GAPS = 0`**.
   - Implement `guardedJob(jobKey, tenantEntry, opts, handler)` in `src/server/authorize.ts`:
     - Validates the caller came from the job runner with a registered active tenant (`tenantRegistry.assertRegisteredActiveTenant`), mints a job-scoped `TenantContext` (`actorSub: 'system:job:' + jobKey`, `actorRoles: []`, `jobPermissions: [policy.permission]`, fresh `correlationId` via `resolveRequestCorrelationId`), enforces `policy.permission` against `jobPermissions` (never user roles), enforces a **per-tenant timeout** (default 120s via `AbortController` + Postgres `SET LOCAL statement_timeout`), emits PII-free start/finish/failure telemetry (`S0-13b`), and isolates errors per tenant so one tenant failing never aborts other tenants in the loop (exiting non-zero after completing the sweep if any tenant failed, ADR 0030 §6).
5. **`job_runs` migration & `TenantJobRunRepository` (`core/src/tenancy/migrations/index.ts`, `core/src/tenancy/jobRunRepository.ts`):**
   - Add expand migration **`0014_scheduler_job_runs_expand`** (`kind: 'expand'`, `requiresAppliedVersion: '0013'`, with reversible `DROP TABLE IF EXISTS job_runs;` `downSql`):
     - `job_runs`: `tenant_id TEXT NOT NULL`, `id TEXT NOT NULL`, `job_key TEXT NOT NULL`, `local_date TEXT NOT NULL` (`YYYY-MM-DD` in tenant `timeZone`), `status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed'))`, `started_at TIMESTAMPTZ NOT NULL`, `finished_at TIMESTAMPTZ NULL`, `correlation_id TEXT NOT NULL`, `error_code TEXT NULL`, `summary_json JSONB NOT NULL DEFAULT '{}'::jsonb` (numeric counts only — zero PII), `PRIMARY KEY (tenant_id, id)`, plus partial unique index `CREATE UNIQUE INDEX idx_job_runs_succeeded_once_per_day ON job_runs (tenant_id, job_key, local_date) WHERE status = 'succeeded';` and index on `(tenant_id, job_key, local_date, started_at DESC)`.
   - **Idempotency & advisory locking (Owner Decision 7, ADR 0030 §§4–5):**
     - Acquires a non-blocking per-`(jobKey, tenantId)` Postgres advisory lock (`pg_try_advisory_lock(hashtext('onesquared_job:' || jobKey || ':' || tenantId))`) so overlapping hourly containers never double-run the same tenant.
     - Computes `localDate` in `tenantConfig.timeZone` (default `'Europe/London'`, handling GMT/BST 23-hour and 25-hour days cleanly via `Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })`) and checks optional target window hour (e.g. `>= 06:00` local time).
     - **Only `status = 'succeeded'` blocks a repeat** for `(tenant_id, job_key, local_date)`. If a prior run on the same `local_date` recorded `status = 'failed'` (or stale crashed `'running'`), the next hourly tick retries cleanly!
6. **CLI entry point `scripts/run-job.mjs` & Bicep schedule activation (`scripts/run-job.mjs`, `package.json`, `core/infra/modules/platform.bicep`):**
   - Add `"job": "tsx --conditions react-server scripts/run-job.mjs"` in `package.json` (`npm run job -- <jobKey>`, supporting `migrate`, `key-date-reminders`, and `usage-retention-purge`).
   - **Rule 4 recorded exception (Owner Decision 7, ADR 0030 §2):** `scripts/run-job.mjs` is the **sole file** permitted to iterate `loadActiveTenantRegistry()` and pass a registry-validated tenant into `guardedJob` without an interactive user OIDC token. Every downstream service and `TenantScopedRepository` still receives a strict `TenantContext` and executes `SET ROLE`.
   - Move the daily key-date reminder check (`runKeyDateReminderForTenant`) onto `guardedJob('key-date-reminders', ...)` while **keeping the interactive `"Run daily reminder check"` button** (`runKeyDateReminderSchedulerAction`, gated on `keydate:configure` + MFA) working through the shared core reminder service.
   - Enable the `key-date-reminders` and `usage-retention-purge` hourly schedule defaults (`0 * * * *`) in `core/infra/modules/platform.bicep`.

## Tests

- **Unit & RBAC tests (`core/tests/scheduler.test.ts` — new, `core/tests/rbac.test.ts`, `src/server/__tests__/actionPermissionGuard.test.ts`):**
  - Assert **no built-in role (`admin` included) holds `keydate:run_reminders` or `document_generation:purge_usage`**, and attempting to grant either via `updateTenantRbacConfig` or `updatePersonPermissionOverrides` is rejected with `FORBIDDEN`.
  - Assert an interactive user (including `admin` with `mfaVerified: true`) cannot invoke a `guardedJob` handler or satisfy a `jobOnly` permission check, while the interactive `runKeyDateReminderSchedulerAction` button still works with `keydate:configure` + MFA and fails with `FORBIDDEN` when `keydate:configure` is revoked.
  - **`job_runs` idempotency & retry:** (a) first hourly tick on `2026-06-15` runs and records `status = 'succeeded'`, (b) second hourly tick on the same `local_date` skips with zero duplicate reminders/tasks, (c) simulated transient failure records `status = 'failed'` and the next hourly tick **retries and succeeds**, (d) GMT->BST (`2026-03-29`) and BST->GMT (`2026-10-25`) transitions run exactly once per local day, and a tenant configured with `timeZone: 'America/New_York'` evaluates its local day independently of a `'Europe/London'` tenant.
  - **Advisory lock & per-tenant timeout:** concurrent `run-job` invocations for the same `(jobKey, tenantId)` skip/serialise via `pg_try_advisory_lock`; a hanging tenant times out cleanly while the second tenant in the registry still runs and succeeds.
  - **Zero PII in logs/telemetry:** assert `job_runs.summary_json` and emitted telemetry contain only `tenantId`, `correlationId`, `jobKey`, `localDate`, `durationMs`, and numeric counts — never client names, matter titles, or email addresses.
- **Contract tests:**
  - `0014_scheduler_job_runs_expand` `upSql` -> `downSql` -> `upSql` round-trip.
  - `core/tests/tenant-config-usage.test.ts` passes for new `timeZone` and newly activated `documentGeneration.usage.retentionMonths` (`'S0-19'` removed from `RESERVED_FOR_SLICE`).
  - `actionPermissionGuard.test.ts` passes with `MAX_KNOWN_GAPS = 0`.
- **Two-tenant isolation tests (`core/tests/isolation.test.ts`, Rule 9 & Owner Decision 7):**
  - Separate real databases (`pg_tenant_a_test`, `pg_tenant_b_test`) with per-tenant `SET ROLE`:
    - **Positive control & cross-tenant isolation:** running `npm run job -- key-date-reminders` and `usage-retention-purge` across `[tenant-a, tenant-b]` raises tasks/notifications and purges expired usage events strictly inside each tenant's own database, using each tenant's own `timeZone` and `retentionMonths` config, with zero cross-tenant task, notification, audit, or `job_runs` rows.
    - **Unregistered / disabled / forged tenant rejection:** passing an unlisted or `enabled: false` tenant ID to `guardedJob` fails closed (`TENANCY_UNREGISTERED_JOB_TENANT` / `TENANCY_FORGERY_DETECTED`, asserting both `code` and `message`).
- **E2E tests:**
  - All 9 Playwright role journeys pass (`npm run e2e`).

## Help and documentation (rule 11)

- **`src/docs/articles/key-dates-reminders-and-escalations.ts` and `src/docs/articles/key-dates-administration.ts`:** Document automated hourly/once-per-local-day reminder execution alongside the manual `"Run daily reminder check"` button (`keydate:configure` + MFA).
- **`src/docs/articles/deployment-and-security.ts`, `src/docs/articles/authentication-rbac-and-mfa.ts`, and `src/docs/articles/tenant-settings.ts`:** Document Container Apps scheduled jobs, `guardedJob`, job-only permissions, the narrow Rule 4 entry-point exception in `scripts/run-job.mjs`, `timeZone` (default `Europe/London`), and `documentGeneration.usage.retentionMonths`.
- **`docs/rbac-reference.md` and `docs/release-notes.md`:** Document `jobOnly` permissions (`keydate:run_reminders`, `document_generation:purge_usage`) and `S0-19`.
- **`docs/roadmap/feature-list.md`:** Update item **8** (remove `"Reminder job is started by hand (no scheduler)"`), **F8** (`timeZone` setting now exists), **P7** (`documentGeneration.usage.retentionMonths` active), **P8**, and **P9** (`Partly built` until `S0-19b` adds enquiry retention anonymisation).

## Acceptance criteria

- Tenant registry schema + `core/src/tenancy/tenantRegistry.ts`, `timeZone` tenant config (default `Europe/London`), `job_runs` migration (`0014`), `guardedJob`, `JOB_PERMISSIONS` (`MAX_KNOWN_GAPS = 0`), job-only permissions (`keydate:run_reminders`, `document_generation:purge_usage` — granted to no role, not even `admin`), and `npm run job -- <jobKey>` (`scripts/run-job.mjs`) are all live and tested.
- Jobs check hourly and act at most once per tenant local day (`status = 'succeeded'` blocks repeat; `'failed'` retries on next tick), under per-tenant timeouts and per-`(job, tenant)` advisory locks, with zero PII in logs or `job_runs`.
- Manual `"Run daily reminder check"` button remains working behind `keydate:configure` + MFA.
- All unit, RBAC, config-usage, reversible-migration, two-tenant job isolation, and e2e tests pass (`npm run ci`).

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Observing live Azure Container Apps cron job triggers and Azure Monitor job failure alerts waits on subscription access.

## Rollback

- Disable the Container Apps job schedule (or revert `s0-19-scheduler`) and run `downSql` for `0014_scheduler_job_runs_expand` if rolling back `job_runs`; manual `"Run daily reminder check"` continues to work throughout. Remove `timeZone` from any tenant config file before reverting the schema if set.

## Pull request description must state

- **Change class:** Core scheduler infrastructure, RBAC job-only permission model, additive `timeZone` tenant configuration, and `key-date-reminders` / `usage-retention-purge` jobs.
- **Recorded exception to Rule 4 (ADR 0030 §2):** `scripts/run-job.mjs` resolves target tenants from the environment's validated tenant registry rather than an interactive user's OIDC token; this exception is strictly confined to `scripts/run-job.mjs` + `guardedJob`, and every downstream repository call still requires a valid `TenantContext` and runs `SET ROLE`.
- **Both hosting models:** Identical `scripts/run-job.mjs` Container Apps job runs in Model A (single-entry tenant registry for the client firm) and Model B (iterating all active hosted tenants with isolated timeouts, advisory locks, and per-tenant `SET ROLE`).
- **Migration and rollback:** Runs `0014_scheduler_job_runs_expand` via `migrate` job before enabling scheduled jobs; reversible via `downSql` and disabling the job schedule.
