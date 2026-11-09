# S0-19b: Scheduled enquiry retention anonymisation job

| | |
|---|---|
| Backlog | P9, P8, B3 (non-regression), item 23 (Archiving, retention and destruction) |
| Decision | [ADR 0030: Tenant-Aware Scheduler on Container Apps Jobs](../../decisions/0030-tenant-aware-scheduler.md) (D6, revised and accepted 9 November 2026 — Owner Decisions 7 and 8) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4c) |
| Branch | `s0-19b-anonymisation-job`, from `s0-19-scheduler`, targeting `develop` |
| Change class | Core feature / scheduled retention job (`core/src/domain/rbac/registry.ts`, `src/server/actionPermissions.ts`, `src/server/services.ts`, `scripts/run-job.mjs`, `core/infra/modules/platform.bicep`). |
| Size | S |
| Depends on | S0-17 (`enquiries` and `enquiry_settings` in PostgreSQL — specifically `S0-17a`), S0-19 (`tenantRegistry`, `guardedJob`, `job_runs`, `scripts/run-job.mjs`). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) to observe live Azure Container Apps scheduled execution; local and CI execution is unblocked. |
| Baseline | `develop` at `52390b9` |

## What exists today

Checked against `develop` (`52390b9`):

1. **Interactive enquiry retention anonymisation (`src/server/services.ts:8731-8807`, `src/domain/enquiries.ts:1553-1563`, `src/app/actions.ts:747-753`):**
   - `anonymiseExpiredEnquiries(byId, specificEnquiryId?)` (hardened in `S0-03` to fix `B3`) requires `enquiry:anonymise`, loads `retentionMonths` from `enquirySettings`, and **always** evaluates `isReadyForRetentionAnonymisation(enquiry, retentionMonths, now)` (`src/domain/enquiries.ts:1553-1563` — refusing `Converted` enquiries, open enquiries, already-anonymised enquiries, and any closed enquiry within the retention cutoff) for both single-enquiry and bulk calls, wiping personal details (`firstName`, `lastName`, `email`, `phone`, `postcode`, address lines, `callingOnBehalfOf`, `otherPartiesNamed`, `summary`, `notes`, `contactLog` notes, `conflictSnapshot` personal inputs) and recording an `anonymise` audit entry.
   - However, it can only be run manually by an administrator/compliance user clicking the single-enquiry or bulk anonymise button in the UI (`P9`, `docs/roadmap/feature-list.md:59, 122`).
2. **Scheduler infrastructure ready from S0-19:**
   - `tenantRegistry`, `guardedJob`, `JOB_PERMISSIONS`, `job_runs` (`0014`), and `scripts/run-job.mjs` are all built in `S0-19`, and `core/infra/modules/platform.bicep` (from `S0-13`) already declares the parameterised `enquiry-retention-anonymise` Container Apps job resource.

## Files and changes

1. **Job-only permission `enquiry:run_retention_anonymise` (`core/src/domain/rbac/registry.ts`, `src/server/actionPermissions.ts`):**
   - Register `'enquiry:run_retention_anonymise'` in `PERMISSION_REGISTRY` (`module: 'enquiries'`, `sensitivity: 'critical'`, `jobOnly: true`), automatically excluded from `ALL_USER_PERMISSION_KEYS` and every user role (`admin` included).
   - Add `'enquiry-retention-anonymise': { permission: 'enquiry:run_retention_anonymise' }` to `JOB_PERMISSIONS` in `src/server/actionPermissions.ts`, keeping `MAX_KNOWN_GAPS = 0` in `src/server/__tests__/actionPermissionGuard.test.ts`.
2. **Shared transactional anonymisation core + scheduled job (`src/server/services.ts`, `scripts/run-job.mjs`, `core/infra/modules/platform.bicep`):**
   - Extract the shared core execution helper `anonymiseEligibleEnquiriesInTransaction(ctx, actorLabel, opts?: { specificEnquiryId?: string; now?: Date })` running inside `withTenantTransaction(ctx, ...)` on `TenantIntakeAndWorkflowRepository` + `TenantAuditRepository`:
     - Reads `retentionMonths` from the tenant's `enquiry_settings` row in PostgreSQL (`Math.max(1, retentionMonths)`).
     - **Unconditionally enforces `isReadyForRetentionAnonymisation(enq, retentionMonths, now)` (`B3`)** on every candidate row — never trusting pre-filtered IDs or skipping the cutoff check.
     - Updates eligible `enquiries` rows (`anonymised_at`, scrubbed personal fields) and inserts per-enquiry `audit_entries` (`action: 'anonymise'`, `byId: 'system:job:enquiry-retention-anonymise'` for scheduled runs or `actor.personId` for manual runs, containing **zero scrubbed personal data** in `oldValue`/`newValue`/`snapshot`) in the **same PostgreSQL transaction**.
   - Wire **both** paths to this helper:
     1. **Scheduled job (`enquiry-retention-anonymise` in `scripts/run-job.mjs`):** runs via `guardedJob('enquiry-retention-anonymise', ...)` (`npm run job -- enquiry-retention-anonymise`), checking hourly (`0 * * * *`) and executing once per tenant local day (`tenantConfig.timeZone`), recording only `{ evaluatedCount, anonymisedCount }` in `job_runs.summary_json` (zero PII).
     2. **Manual UI buttons (`anonymiseExpiredEnquiriesAction` in `src/app/actions.ts:747`):** remain intact behind `enquiry:anonymise` for single-enquiry and immediate bulk runs, so admins can still trigger anonymisation on demand and existing `S0-03` workflows do not change.
   - Enable `enableEnquiryAnonymisationJob` by default in `core/infra/modules/platform.bicep`.

## Tests

- **Unit, `B3` retention & RBAC tests (`core/tests/enquiry-anonymisation-job.test.ts` — new, `core/tests/rbac.test.ts`, `src/server/__tests__/actionPermissionGuard.test.ts`):**
  - Assert no role (`admin` included) holds `enquiry:run_retention_anonymise`, and interactive users cannot invoke the `guardedJob` handler or grant `enquiry:run_retention_anonymise` via RBAC overrides.
  - **`B3` retention enforcement in scheduled & manual modes:** seed (a) a closed unconverted enquiry older than `retentionMonths` -> **anonymised** and audited in the same transaction, (b) a closed unconverted enquiry 1 day inside `retentionMonths` -> **untouched**, (c) a `Converted` enquiry older than `retentionMonths` -> **untouched**, (d) an open (`New` / `In progress`) enquiry older than `retentionMonths` -> **untouched**, and (e) an already-anonymised enquiry -> **skipped cleanly**.
  - **`job_runs` idempotency, retry & zero PII:** second hourly tick on the same `local_date` skips (`status = 'succeeded'`); a simulated DB error rolls back both the enquiry update and `audit_entries` row, records `status = 'failed'`, and succeeds on the next hourly retry; neither `job_runs`, `audit_entries`, nor telemetry contains any scrubbed personal data from the enquiry.
  - **Manual buttons preserved:** `anonymiseExpiredEnquiriesAction(specificId)` and bulk `anonymiseExpiredEnquiriesAction()` still work with `enquiry:anonymise` and fail with `FORBIDDEN` when `enquiry:anonymise` is revoked.
- **Contract tests:**
  - `actionPermissionGuard.test.ts` passes with `MAX_KNOWN_GAPS = 0`; Bicep contract test (`core/tests/infra-bicep-contract.test.ts`) confirms the `enquiry-retention-anonymise` job schedule (`0 * * * *`) compiles and lints cleanly.
- **Two-tenant isolation tests (`core/tests/isolation.test.ts`, Rule 9 & Owner Decision 7):**
  - Separate real databases (`pg_tenant_a_test` configured with `retentionMonths: 6`, `pg_tenant_b_test` configured with `retentionMonths: 24`) with per-tenant `SET ROLE`:
    - Seed identical 12-month-old closed unconverted enquiries in both Tenant A and Tenant B, and run `npm run job -- enquiry-retention-anonymise`:
      - **Positive control (Tenant A):** Tenant A's 12-month-old enquiry is anonymised (`> 6` months), audited in `pg_tenant_a_test`, and recorded in Tenant A's `job_runs`.
      - **Cross-tenant isolation (Tenant B):** verified via a fresh connection to `pg_tenant_b_test`, Tenant B's 12-month-old enquiry (`< 24` months) retains its intact fields, and Tenant B's `job_runs` records `anonymisedCount: 0` independently.
    - **Forged claim & tampered ID:** forged `tenantId` on `anonymiseExpiredEnquiriesAction` or `guardedJob` fails with `TENANCY_FORGERY_DETECTED` / `TENANCY_UNREGISTERED_JOB_TENANT`; Tenant A passing Tenant B's `specificEnquiryId` to `anonymiseExpiredEnquiries` anonymises `0` records (`NOT_FOUND` / zero rows matched) and leaves `pg_tenant_b_test` untouched.
- **E2E tests:**
  - All 9 Playwright role journeys pass (`npm run e2e`).

## Help and documentation (rule 11)

- **`src/docs/articles/data-administration-and-retention.ts`:** Document automated daily scheduled enquiry retention anonymisation (`enquiry-retention-anonymise`, respecting each tenant's configured `retentionMonths` and `timeZone`) alongside the manual single-enquiry and bulk anonymise controls (`enquiry:anonymise`).
- **`docs/rbac-reference.md` and `docs/release-notes.md`:** Add job-only permission `enquiry:run_retention_anonymise` and record `S0-19b`.
- **`docs/roadmap/feature-list.md`:**
  - Move **P9** (`Background job scheduler`) to **`Completed`**!
  - Update item **23** (`Archiving, retention and destruction` — remove `"A scheduler"` from `"What's missing"` and record scheduled enquiry retention anonymisation in `"What exists"`) and **P8** (two-tenant job isolation for enquiry retention anonymisation).

## Acceptance criteria

- `enquiry:run_retention_anonymise` is registered as `jobOnly: true` (granted to no user role) and wired in `JOB_PERMISSIONS` (`MAX_KNOWN_GAPS = 0`).
- `npm run job -- enquiry-retention-anonymise` runs through `guardedJob`, always applies `isReadyForRetentionAnonymisation` (`B3`), writes enquiry updates and `audit_entries` in one PostgreSQL transaction, records non-PII counts in `job_runs`, and acts once per tenant local day.
- Manual single-enquiry and bulk anonymisation buttons continue to work behind `enquiry:anonymise`.
- Two-tenant job isolation tests and full `npm run ci` pass.

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Live observation of the scheduled `enquiry-retention-anonymise` Container Apps job in Azure waits on subscription access.

## Rollback

- No database schema migration is added in `S0-19b` (uses `enquiries` from `0009` and `job_runs` from `0014`). Rolling back disables `enableEnquiryAnonymisationJob` or reverts `s0-19b-anonymisation-job`; manual anonymisation buttons remain unaffected. *(Note: already-anonymised personal data is irreversibly scrubbed by design.)*

## Pull request description must state

- **Change class:** Core scheduled retention job & RBAC job-only permission (`core/src/domain/rbac/registry.ts`, `src/server/`, `scripts/run-job.mjs`, `core/infra/modules/platform.bicep`).
- **Rule 4 exception scope:** Uses S0-19's `scripts/run-job.mjs` + `guardedJob` entry point (ADR 0030 §2); all database reads/writes execute through `TenantScopedRepository` with `SET ROLE`.
- **Both hosting models:** Runs per-tenant in both Model A (single firm tenant) and Model B (each hosted tenant evaluated against its own `enquiry_settings.retentionMonths`, `timeZone`, and isolated Postgres database).
- **Migration and rollback:** No schema migration; rollback disables the job schedule or reverts the commit.
