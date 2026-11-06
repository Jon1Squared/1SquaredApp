# ADR 0030: Tenant-Aware Scheduler

- **Date:** 2026-11-06
- **Status:** Proposed
- **Roadmap:** Stage 0 decision D6, slice S0-19 (`docs/roadmap/stage-0-plan.md`); backlog gap P9
- **Builds on:** [ADR 0024](./0024-azure-container-apps-hosting.md) (Container Apps jobs), [ADR 0025](./0025-permission-enforcement-pattern.md), [ADR 0022](./0022-key-dates-and-limitation-module.md)

## Context

Nothing runs on a schedule today. At commit `a0a5534`:

- **Key date reminders run only by hand.** The daily check runs when someone presses "Run daily reminder check" in the team diary (`src/components/KeyDatesDiaryWorkspace.tsx:338`). That goes through `runKeyDateReminderSchedulerAction` to `runTenantKeyDateReminderJob`.
- **Enquiry anonymisation runs only by hand, outside the job wrapper.** `anonymiseExpiredEnquiries` (`src/server/services.ts:7438`) is triggered from buttons and does not use `runTenantBackgroundJob`.
- **The job wrapper has no scheduling.** `runTenantBackgroundJob` (`core/src/tenancy/index.ts:232-247`) refuses to run without a valid tenant ID and correlation ID, but it has no queue, retry or schedule.

The standard (section 8.7) requires background jobs to carry the tenant ID and refuse to run without it.

## Decision

1. **Container Apps jobs with a cron schedule** run the same container image as the web app, with a job entry point: `node scripts/run-job.mjs <jobKey>`. Each job type has its own schedule. The daily jobs run overnight UK time.
2. **A tenant-aware runner.** The entry point loads the list of tenants for the environment from configuration, then runs the job once per tenant through `runTenantBackgroundJob`. In single-tenant (Model A) installations, that list has one tenant.
   - **One tenant's failure doesn't stop the others.** It is logged and reported.
   - **Job IDs are idempotent** per tenant and day (`<jobKey>:<tenantId>:<yyyy-mm-dd>`), so a re-run does no duplicate work.
3. **A system actor.** Scheduled jobs run as a system actor, not as a user.
   - **Its permissions are listed in the job definition.** For example, the reminder job holds `keydate:configure` and the anonymisation job holds `enquiry:anonymise`. They go through the same policies as user actions (ADR 0025).
   - **Its tenant context is built by the runner from the tenant registry.** This is the one recorded exception to "the tenant comes only from the authenticated token". It is allowed only inside the job entry point, which users cannot call.
4. **The first jobs moved onto it** are the key date reminder check and enquiry retention anonymisation. Anonymisation is moved inside `runTenantBackgroundJob`, and the retention check is always applied (B3). The manual "run now" buttons stay, behind their permissions.
5. **Observability.** Every run logs the job key, tenant ID, correlation ID, outcome and counts, and no personal data. Failures raise an Application Insights alert.
6. **Running locally.** `npm run job -- <jobKey>` runs a job against the local tenant.

## Alternatives Considered

- **Timers inside the web app.** They run once per replica, stop when the app scales to zero, and are hard to observe. Rejected.
- **Azure Functions timer triggers.** That is a second hosting model and build to maintain. Rejected in favour of a Container Apps job using the same image.
- **A third-party job queue.** Not needed for daily batch jobs. It can be revisited if near-real-time queues are needed, for example for email (ADR 0027).

## Consequences

- Infrastructure (S0-13 and S0-19) adds one Container Apps job per job type.
- Jobs need access to every tenant's database and Key Vault in the hosted model, through the shared managed identity, scoped as in ADR 0024.
- Later jobs, such as notification digests (D11), registers reminders (D7) and retention, follow the same pattern.
