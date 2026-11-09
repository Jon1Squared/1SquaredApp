# ADR 0030: Tenant-Aware Scheduler

- **Date:** 2026-11-06 (revised 2026-11-09 after review)
- **Status:** Proposed
- **Roadmap:** Stage 0 decision D6, slices S0-19 and S0-19b (`docs/roadmap/stage-0-plan.md`); backlog gap P9
- **Builds on:** [ADR 0024](./0024-azure-container-apps-hosting.md) (Container Apps jobs), [ADR 0025](./0025-permission-enforcement-pattern.md) (permission enforcement), [ADR 0028](./0028-tenant-database-and-repositories.md) (tenant databases), [ADR 0022](./0022-key-dates-and-limitation-module.md) (key dates)

## Context

Nothing runs on a schedule today. At commit `147ac61`:

- **Key date reminders run only by hand.**
  - The daily check runs when someone presses "Run daily reminder check" in the team diary (`src/components/KeyDatesDiaryWorkspace.tsx`).
  - That goes through `runKeyDateReminderSchedulerAction` (policy `keydate:configure`) to `runTenantKeyDateReminderJob`.
- **Enquiry anonymisation runs only by hand, outside the job wrapper.** `anonymiseExpiredEnquiries` (`src/server/services.ts:8883`) is triggered from buttons and does not use `runTenantBackgroundJob`.
- **The job wrapper has no scheduling.** `runTenantBackgroundJob` (`core/src/tenancy/index.ts:232`) refuses to run without a valid tenant ID and correlation ID, but it has no queue, retry or schedule.
- **There is no list of tenants.** Nothing in `core/` or `src/` lists the tenants in an environment. Each process loads one tenant package (`PLATFORM_TENANT_PACKAGE_DIR`).
- **Permission checks assume a user.** `guardedAction` builds its context from a signed-in user's session (ADR 0025), and a scheduled job has none.
- **A job can't read the JSON store.** The store is a file on the web app's local disk. A Container Apps job runs in its own container, with its own disk.

The standard requires background jobs to:
- carry the tenant ID, and refuse to run without it (section 8, item 7)
- have automated two-tenant tests proving they touch only the calling tenant's data (section 8, testing)

## Decision

### 1. Container Apps jobs with a cron schedule
- **Same image, with a job entry point.** Jobs run the same container image as the web app, with a job entry point: `node scripts/run-job.mjs <jobKey>`.
- **One job per job type, each with its own schedule.**
- **Concurrency:**
  - Each job's parallelism is 1.
  - The runner also takes a Postgres advisory lock for each tenant and job, so an overlapping run skips that tenant rather than running it twice.
- **Timeouts:** each tenant's run has its own timeout, shorter than the job's `replicaTimeout`. One slow tenant is stopped and reported, rather than using up the whole run.

### 2. The tenant registry (new, in core)
- **What it is:** a list of the tenants in an environment, held in a schema-validated environment configuration file.
- **Its type and loader live in core,** in `core/src/tenancy/tenantRegistry.ts`, so that only `core/src/tenancy/` reads it.
- **Each entry holds:**
  - `tenantId`
  - `slug`
  - `environment`
  - the database server and database name
  - the Key Vault reference
  - the tenant's time zone (default `Europe/London`)
- **Who changes it:** only infrastructure deployment. Nothing in the application can change it.
- **Model A:** the registry has a single entry.
- **The web app doesn't use it.** The web app still takes its tenant only from the token.

### 3. A system actor, and the recorded exception to rule 4
- **Scheduled jobs run as a system actor,** not as a user.
- **Each job declares what it needs.** Its definition lists:
  - a `jobKey`
  - the permissions it needs
  - a policy entry in `src/server/actionPermissions.ts`, checked the same way as user actions (ADR 0025)
  - `MAX_KNOWN_GAPS` must not go up
- **A `guardedJob(jobKey, handler)` wrapper** does the checks and sets the context:
  - It builds the job's context: the tenant, a correlation ID and the declared permissions.
  - It refuses to run without a tenant.
  - It checks the policy.
  - It runs the handler inside `runTenantBackgroundJob`.
- **Audit entries name the actor `system:<jobKey>`.**
- **Least privilege.**
  - Jobs get permissions that only jobs hold, scoped to what the job does. For example, `keydate:run_reminders` reads key dates and creates notifications.
  - A job doesn't reuse a broad user permission such as `keydate:configure`.
  - The registry (`core/src/domain/rbac/registry.ts`) marks job-only permissions as such. No role grants them.
- **The exception to "the tenant comes only from the authenticated token" (rule 4; standard section 8):**
  - In a job, the tenant context comes from the tenant registry, not from a token.
  - This is a recorded exception, accepted by the owner on 9 November 2026. It is allowed only inside the job entry point (`scripts/run-job.mjs` and `guardedJob`).
  - Users cannot call the entry point. It isn't exposed as a route or action.
  - The pull request for S0-19 restates the exception.

### 4. A tenant-aware runner
- **What it does:**
  - The entry point loads the registry, then runs the job once for each tenant through `guardedJob`.
  - Each tenant runs with its own context, database connection and Key Vault access.
- **One tenant's failure doesn't stop the others.** It is logged and reported, and the runner moves on to the next tenant.
- **Idempotency:**
  - Each run is recorded in a `job_runs` table in the tenant's own database (ADR 0028), keyed by `<jobKey>:<tenantId>:<business date>`.
  - Only a **successful** run blocks a repeat, so a failed run can be retried the same day.
  - A manual run from a "run now" button is recorded too.
- **Time zone:**
  - Container Apps cron schedules are in UTC.
  - Daily jobs are scheduled **hourly**. For each tenant, the runner works out the business date and local hour in the tenant's time zone, and acts once per local day after the configured local hour (default 02:00).
  - This keeps the run time fixed in UK time across the GMT/BST change. It also supports tenants in other time zones.

### 5. Data must be in Postgres before a job moves
- A job reads and writes only through the tenant-scoped repositories (ADR 0028), never through the JSON store.
- So a job moves onto the scheduler only after its data has moved:
  - **The key date reminder check** moves in S0-19, after key dates move in S0-15.
  - **Enquiry retention anonymisation** moves in S0-19b, after enquiries move in S0-17.
    - It moves inside `guardedJob`, and the retention check is always applied (B3).
- **The manual "run now" buttons stay,** behind their existing permissions, and run the same job code for the signed-in user's tenant.
- **The `migrate` job (ADR 0028)** uses this runner, with its own job-only permission.

### 6. Tests
- **Two-tenant tests** for every job (standard section 8 testing; rule 9). Two tenants are seeded in separate databases. The tests assert that:
  - each tenant's run reads and writes only its own database, with a positive control showing the data that should change does change
  - a failure in one tenant doesn't stop or alter the other
  - a context with no tenant, or with a tenant not in the registry, is refused with a specific error
  - a job without its declared permission is refused
  - a repeat run after success does nothing, and a repeat after failure runs again
- **Unit tests** cover the business-date and local-hour calculation across the GMT/BST change.

### 7. Observability
- **Every run logs:**
  - the job key
  - the tenant ID
  - the correlation ID
  - the outcome
  - counts
  - no personal data
- **Failures and timeouts** raise an Application Insights alert.

### 8. Running locally
`npm run job -- <jobKey>` runs a job against the local tenant's registry entry.

## Alternatives Considered

- **Timers inside the web app.** They run once per replica, stop when the app scales to zero, and are hard to observe. Rejected.
- **Azure Functions timer triggers.** That is a second hosting model and build to maintain. Rejected in favour of a Container Apps job using the same image.
- **A third-party job queue.** Not needed for daily batch jobs. It can be revisited if near-real-time queues are needed, for example for email (ADR 0027).
- **Reusing user permissions for jobs**, such as `keydate:configure` for the reminder job. This gives jobs more than they need. Rejected in favour of permissions that only jobs hold.
- **Running daily jobs on a fixed UTC schedule.** The run time would move by an hour at each GMT/BST change, and it can't serve tenants in other time zones. Rejected in favour of hourly runs that act once per local day.

## Consequences

- **Infrastructure (S0-13, S0-19 and S0-19b)** adds one Container Apps job per job type, plus `migrate`.
- **Jobs can reach every tenant's database and Key Vault** in the hosted model, through the shared managed identity, scoped as in ADR 0024. They use the same role per tenant and `SET ROLE` as the web app (ADR 0028), so the trust boundary is the same: the tenant-scoped data layer.
- **New pieces in core:**
  - the tenant registry and its schema
  - `guardedJob`
  - job-only permissions in the permission registry
  - the `job_runs` table, in a tenant migration
- **The exception to rule 4** is limited to the job entry point, and must be restated in any later change to the scheduler.
- **Later jobs follow the same pattern,** including its two-tenant tests. Examples:
  - notification digests (D11)
  - registers reminders (D7)
  - further retention jobs
