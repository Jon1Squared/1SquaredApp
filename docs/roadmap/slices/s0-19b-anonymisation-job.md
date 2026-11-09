# S0-19b: Scheduled enquiry retention anonymisation job

| | |
|---|---|
| Backlog | P9, P8, B3 (non-regression), item 23 (Archiving, retention and destruction) |
| Decision | [ADR 0030: Tenant-Aware Scheduler](../../decisions/0030-tenant-aware-scheduler.md) (D6, accepted 9 November 2026 — Owner Decisions 7 and 8) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4c) |
| Branch | `s0-19b-anonymisation-job`, from `s0-19-scheduler`, targeting `develop` |
| Change class | Core feature / scheduled retention job (`core/src/domain/rbac/registry.ts`, `src/server/actionPermissions.ts`, `src/server/services.ts`, `scripts/run-job.ts` -> `dist/jobs/run-job.mjs`, `core/infra/modules/platform.bicep`). |
| Size | S |
| Depends on | S0-17a (`enquiries` and `enquiry_settings` in PostgreSQL), S0-19 (`guardedJob`, `job_runs` `0013`, `pg_try_advisory_xact_lock`, bundled `dist/jobs/run-job.mjs`, job failure alert rule). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) to observe live Azure Container Apps scheduled execution; local and CI execution is unblocked. |
| Baseline | `develop` at `52390b9` |

## What exists today

Checked against `develop` (`52390b9`):

1. **Interactive enquiry retention anonymisation (`src/server/services.ts:8924-8970`, `src/domain/enquiries.ts:1553-1563`, `src/app/actions.ts:747-753`, `R414`):**
   - `anonymiseExpiredEnquiries(byId, specificEnquiryId?)` (`src/server/services.ts:8924-8970`, hardened in `S0-03` to fix `B3`) requires `enquiry:anonymise`, loads `retentionMonths` from `enquirySettings`, and **always** evaluates `isReadyForRetentionAnonymisation(enq, months, now)` (`src/domain/enquiries.ts:1553-1563` — refusing `Converted` enquiries, open enquiries, already-anonymised enquiries, and any closed enquiry within the retention cutoff) for both single-enquiry and bulk calls, wiping personal details and writing an audit entry (`:8956-8965`) with zero personal data.
   - However, it runs only when triggered manually via `anonymiseExpiredEnquiriesAction` (`src/app/actions.ts:747-753`, `P9`).
2. **Scheduler infrastructure ready from S0-13, S0-13b, S0-14 and S0-19:**
   - `tenantRegistry.ts`, `guardedJob` (`system:<jobKey>`), `JOB_PERMISSIONS`, `job_runs` (`0013`), `pg_try_advisory_xact_lock`, `dist/jobs/run-job.mjs`, and the `Microsoft.Insights/scheduledQueryRules` failure/timeout alert rule are all in place, and `core/infra/modules/platform.bicep` already declares the parameterised `enquiry-retention-anonymise` job resource (`['node', 'dist/jobs/run-job.mjs', 'enquiry-retention-anonymise']`).

## Files and changes

1. **Job-only permission `enquiry:run_retention_anonymise` (`core/src/domain/rbac/registry.ts`, `src/server/actionPermissions.ts`):**
   - Register `'enquiry:run_retention_anonymise'` in `PERMISSION_REGISTRY` (`module: 'enquiries'`, `sensitivity: 'critical'`, `jobOnly: true`), automatically excluded from `ALL_USER_PERMISSION_KEYS` and every user role (`admin` included).
   - Add `'enquiry-retention-anonymise': { permission: 'enquiry:run_retention_anonymise' }` to `JOB_PERMISSIONS` in `src/server/actionPermissions.ts`, keeping `MAX_KNOWN_GAPS = 0` in `src/server/__tests__/actionPermissionGuard.test.ts`.
2. **Shared single-transaction anonymisation job, `pg_try_advisory_xact_lock` scope & manual-run `job_runs` recording (`src/server/services.ts`, `scripts/run-job.ts` -> `dist/jobs/run-job.mjs`, `core/infra/modules/platform.bicep`, `R404`, `R412`, `R419`):**
   - Extract the shared execution helper `runEnquiryRetentionAnonymisationForTenant(ctx, opts: { triggerSource: 'scheduled' | 'manual'; actorId: string; specificEnquiryId?: string; now?: Date })` running **entirely inside one `withTenantTransaction(ctx, ...)` (`SET LOCAL ROLE` first) that acquires `pg_try_advisory_xact_lock(hashtext('onesquared_job:enquiry-retention-anonymise:' || tenantId))` and holds it across the `job_runs` check, all `enquiries` + `audit_entries` work on that same transaction client, and the `status = 'succeeded'` `job_runs` insert** (`R419`, for both scheduled and manual `"run now"` triggers):
     - Reads `retentionMonths` from the tenant's `enquiry_settings` row in PostgreSQL (`Math.max(1, retentionMonths)`).
     - **Unconditionally enforces `isReadyForRetentionAnonymisation(enq, retentionMonths, now)` (`B3`)** on every candidate row — never trusting pre-filtered IDs or skipping the cutoff check.
     - Updates eligible `enquiries` rows (`anonymised_at`, scrubbed personal fields) and inserts per-enquiry `audit_entries` (`byId: 'system:enquiry-retention-anonymise'` for scheduled runs per ADR 0030 `:61` or `actor.personId` for manual runs, containing **zero personal data** in `oldValue`/`newValue`/`snapshot`) in the **same PostgreSQL transaction**.
   - Wire **both** paths to this shared job code (`ADR 0030 :80, :90-92`, `R412`):
     1. **Scheduled job (`enquiry-retention-anonymise` in `scripts/run-job.ts` -> `dist/jobs/run-job.mjs`):** runs via `guardedJob('enquiry-retention-anonymise', ...)` (`npm run job -- enquiry-retention-anonymise` locally / `node dist/jobs/run-job.mjs enquiry-retention-anonymise` in Container Apps, `R404`), checking hourly (`0 * * * *`) and executing once per tenant local day after `02:00` local time (`tenantConfig.timeZone`), recording `trigger_source: 'scheduled'`, `triggered_by_id: 'system:enquiry-retention-anonymise'`, and `{ evaluatedCount, anonymisedCount }` in `job_runs.summary_json` (zero PII).
     2. **Manual UI buttons (`anonymiseExpiredEnquiriesAction` at `src/app/actions.ts:747`, gated on `enquiry:anonymise`):** invoke the **same** `runEnquiryRetentionAnonymisationForTenant` helper (taking the **same** `pg_try_advisory_xact_lock`, `R419`) for single-enquiry (`specificEnquiryId`) and bulk runs, **recording each manual execution in `job_runs`** (`trigger_source: 'manual'`, `triggered_by_id: actor.personId`, `summary_json: { evaluatedCount, anonymisedCount, scope: specificEnquiryId ? 'single' : 'bulk' }`, `R412`).
   - Enable `enableEnquiryAnonymisationJob` (`true`) in `core/infra/modules/platform.bicep` and verify the `Microsoft.Insights/scheduledQueryRules` failure/timeout alert covers `enquiry-retention-anonymise` (`R412`).

## Tests

- **Unit, `B3` retention, RBAC & `R412` manual-run tests (`core/tests/enquiry-anonymisation-job.test.ts` — new, `core/tests/rbac.test.ts`, `src/server/__tests__/actionPermissionGuard.test.ts`):**
  - Assert no role (`admin` included) holds `enquiry:run_retention_anonymise`, interactive users cannot call `guardedJob`, and scheduled audit entries record **`byId: 'system:enquiry-retention-anonymise'`** (`R412`).
  - **`B3` retention enforcement in scheduled & manual modes:** seed (a) closed unconverted enquiry past `retentionMonths` -> **anonymised** + audited in same transaction, (b) closed unconverted enquiry 1 day inside `retentionMonths` -> **untouched**, (c) `Converted` enquiry past `retentionMonths` -> **untouched**, (d) open enquiry past `retentionMonths` -> **untouched**, (e) already-anonymised enquiry -> **skipped**.
  - **Manual buttons record in `job_runs` (`R412`):** both single-enquiry `anonymiseExpiredEnquiriesAction(specificId)` and bulk `anonymiseExpiredEnquiriesAction()` (gated on `enquiry:anonymise`) run the shared job code and write `trigger_source = 'manual'` rows in `job_runs` (with a bulk manual `'succeeded'` run satisfying that `local_date`'s scheduled check, while a single-enquiry manual run does not suppress the daily bulk sweep for remaining expired enquiries).
  - **Concurrent scheduled + manual lock test (`R419`), `job_runs` idempotency, retry after failure, and zero PII** in `job_runs`, `audit_entries`, and telemetry: starting a scheduled `enquiry-retention-anonymise` run and `anonymiseExpiredEnquiriesAction()` together (`Promise.all`) for one tenant anonymises and audits each eligible enquiry once.
- **Contract, two-tenant isolation & E2E tests:**
  - `actionPermissionGuard.test.ts` (`MAX_KNOWN_GAPS = 0`) and `infra-bicep-contract.test.ts` (cron schedule + alert coverage).
  - Two-tenant PgBouncer job isolation (`core/tests/isolation.test.ts`): `pg_tenant_a_test` (`retentionMonths: 6`) vs `pg_tenant_b_test` (`retentionMonths: 24`) seeded with 12-month-old closed unconverted enquiries -> Tenant A anonymises (`1`), Tenant B leaves intact (`0`), plus forged-claim / unregistered-tenant / tampered-`specificEnquiryId` checks.
  - All 9 Playwright role journeys pass (`npm run e2e`).

## Help and documentation (rule 11)

- **`src/docs/articles/data-administration-and-retention.ts`, `docs/rbac-reference.md`, `docs/release-notes.md`, and `docs/roadmap/feature-list.md`:** Document automated daily `enquiry-retention-anonymise` (`system:enquiry-retention-anonymise`) and manual-button `job_runs` recording; move **P9** (`Background job scheduler`) to **`Completed`** and update item **23** and **P8**.

## Acceptance criteria

- `enquiry:run_retention_anonymise` (`jobOnly: true`) is enforced via `guardedJob` (`MAX_KNOWN_GAPS = 0`), running via bundled `dist/jobs/run-job.mjs enquiry-retention-anonymise` (`R404`) as actor `system:enquiry-retention-anonymise` (`R412`).
- Both scheduled and manual (`anonymiseExpiredEnquiriesAction`) runs execute the shared `B3`-enforced transaction and record non-PII summaries in `job_runs` (`R412`), with two-tenant isolation tests and full `npm run ci` passing.

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Live observation of the scheduled Container Apps job and alert rule in Azure waits on subscription access.

## Rollback

- No schema migration in `S0-19b` (uses `enquiries` from `0009` and `job_runs` from `0013`). Disable `enableEnquiryAnonymisationJob` or revert `s0-19b-anonymisation-job`; manual buttons continue working. *(Already-anonymised PII is irreversibly scrubbed by design.)*

## Pull request description must state

- **Change class:** Core scheduled retention job & RBAC job-only permission (`core/src/domain/rbac/registry.ts`, `src/server/`, `scripts/run-job.ts`, `core/infra/modules/platform.bicep`).
- **Rule 4 exception scope:** Uses `S0-19`'s `run-job` + `guardedJob` (`system:enquiry-retention-anonymise`, ADR 0030 §3); all DB access uses `TenantScopedRepository` (`SET LOCAL ROLE`).
- **Both hosting models & rollback:** Runs per-tenant in Model A and Model B over PgBouncer; no schema migration, reversible via schedule toggle or `git revert`.
