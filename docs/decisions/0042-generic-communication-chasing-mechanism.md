# ADR 0042: Generic Communication Chasing Mechanism (`S1-06`, `S1-07`, `S1-08`)

- **Date:** 2026-11-26
- **Status:** Proposed
- **Roadmap:** Stage 1 Work Package 3, slices `S1-06`, `S1-07`, and `S1-08` ([docs/roadmap/slices/](../roadmap/slices/)); Owner Decision 2 (26 Nov 2026); backlog items `3`, `5`, and `6`
- **Builds on:** [ADR 0014](./0014-staff-matter-access-by-permission.md) (restricted matters), [ADR 0025](./0025-permission-enforcement-pattern.md) (action/job permission enforcement), [ADR 0027](./0027-email-sender-interface.md) (per-tenant email outbox), [ADR 0028](./0028-tenant-database-and-repositories.md) (tenant databases & repositories), [ADR 0030](./0030-tenant-aware-scheduler.md) (tenant-aware scheduled jobs & Rule 4 exception), [ADR 0035](./0035-digests-and-teams-delivery.md) (notifications, outbox drain, restricted-matter filtering), [ADR 0038](./0038-intake-check-interfaces-and-manual-adapters.md) (outbox-held attachments & manual intake checks)

## Context

Stage 1 exit criteria (`docs/roadmap/stage-1-plan.md:33–61`) and the owner decision of 26 November 2026 require automated client chasing across **three distinct WP3 workflows**:

1. **Client care / engagement letters (`S1-06`, item `5`):** unsigned letters sent to clients are chased automatically.
2. **Quotes (`S1-07`, item `3`):** sent, unaccepted quotes are chased automatically (while existing `quote-expiry` at `02:00` local time expires past-validity quotes and manual follow-up notes remain in `logQuoteFollowUpRecord`).
3. **Money on account requests (`S1-08`, item `6`):** unpaid client payment requests are chased automatically.

Owner decision 2 (26 Nov 2026) fixes the core behavioural model across all three:
- An automatic first chase email **7 days** after sending, and a second chase email at **14 days**;
- If there is still no response after the second chase, an **escalation task assigned to the fee earner** (or matter/quote owner);
- Each schedule (day intervals, and whether chase emails are sent) is configurable per firm, with **safe core defaults** so no unsolicited client emails are sent until configured;
- Chasing **stops immediately** when a quote is accepted, declined, or expired; an engagement letter is signed; requested money is received; or the item is withdrawn/cancelled.

Building three separate scheduling tables, three Bicep Container Apps jobs, three job-only permissions, and three duplicate step-tracking loops would triplicate operational surface, increase infrastructure cost, and risk subtle divergences in idempotency, restricted-matter suppression, and outbox drain behaviour. Instead, we introduce **one generic chasing mechanism** in `S1-06` and plug `S1-07` (quotes) and `S1-08` (money on account) into it cleanly.

Because this introduces shared tenant database tables (`public.communication_chases`, `public.communication_chase_events`), one new ADR 0030 scheduled job (`communication-chases` with job-only permission `'communication:run_chases'`, invoking the recorded Rule 4 exception), and shared tenant configuration (`TenantConfiguration.chasing`), it is structural and requires this ADR before WP3 implementation begins.

## Decision

### 1. Generic per-tenant data model (`0028_engagement_and_chasing_expand`)

Introduced once in `S1-06` and reused unchanged by `S1-07` and `S1-08`:

1. **`public.tenant_communication_chase_id_seq`** (`START WITH 1`, formatting IDs `'CHS-000001'`) and **`public.tenant_communication_chase_event_id_seq`** (`'CHE-000001'`).
2. **`public.communication_chases`:**
   - `tenant_id TEXT NOT NULL`
   - `id TEXT NOT NULL`
   - `entity_kind TEXT NOT NULL CHECK (entity_kind IN ('engagement_letter', 'quote', 'money_on_account'))`
   - `entity_id TEXT NOT NULL` *(for `engagement_letter`: `matter_id`; for `quote`: `quote_id`; for `money_on_account`: `request_id`)*
   - `matter_id TEXT NULL` *(nullable FK-indexed matter link used directly for restricted-matter and `S1-09` information-barrier enforcement)*
   - `quote_id TEXT NULL` *(nullable quote link for quote-scoped visibility checks)*
   - `recipient_email TEXT NULL`
   - `recipient_name TEXT NULL`
   - `sent_at TIMESTAMPTZ NOT NULL` *(baseline clock `T0` for step day offsets)*
   - `status TEXT NOT NULL CHECK (status IN ('active', 'stopped', 'completed'))`
   - `stopped_reason TEXT NULL` *(`'signed' | 'accepted' | 'declined' | 'expired' | 'superseded' | 'received' | 'withdrawn' | 'cancelled' | 'manual_stop' | 'entity_missing'`)*
   - `stopped_at TIMESTAMPTZ NULL`
   - `stopped_by_person_id TEXT NULL`
   - `last_chased_at TIMESTAMPTZ NULL`
   - `next_step_index INTEGER NOT NULL DEFAULT 1 CHECK (next_step_index BETWEEN 1 AND 4)` *(steps: `1` = first email, `2` = second email, `3` = escalation task, `4` = finished/completed)*
   - `next_action_at TIMESTAMPTZ NULL` *(indexed next evaluation timestamp so due-candidate queries never scan closed rows)*
   - `created_by_person_id TEXT NOT NULL`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `PRIMARY KEY (tenant_id, id)`
   - **Partial unique index:** `CREATE UNIQUE INDEX uq_communication_chases_active ON public.communication_chases (tenant_id, entity_kind, entity_id) WHERE status = 'active';` — guarantees at most one active chase stream per item.
   - **Scheduler index:** `CREATE INDEX idx_communication_chases_due ON public.communication_chases (tenant_id, status, next_action_at ASC) WHERE status = 'active' AND next_action_at IS NOT NULL;`.
3. **`public.communication_chase_events` (immutable step ledger — guarantees at most one chase per step):**
   - `tenant_id TEXT NOT NULL`
   - `id TEXT NOT NULL`
   - `chase_id TEXT NOT NULL`
   - `step_index INTEGER NOT NULL CHECK (step_index IN (1, 2, 3))`
   - `action_kind TEXT NOT NULL CHECK (action_kind IN ('chase_email', 'escalation_task'))`
   - `outcome TEXT NOT NULL CHECK (outcome IN ('executed', 'skipped_emails_disabled', 'skipped_no_recipient', 'suppressed_restricted'))`
   - `outbox_email_id TEXT NULL` *(points to `public.email_outbox.id` when `action_kind = 'chase_email'`)*
   - `task_id TEXT NULL` *(points to `public.tasks.id` when `action_kind = 'escalation_task'`)*
   - `executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `PRIMARY KEY (tenant_id, id)`
   - `FOREIGN KEY (tenant_id, chase_id) REFERENCES public.communication_chases (tenant_id, id) ON DELETE CASCADE`
   - **Idempotency constraint:** `CONSTRAINT uq_communication_chase_events_step UNIQUE (tenant_id, chase_id, step_index);` — makes executing the same chase step twice impossible at the PostgreSQL level even under concurrent manual retries or scheduler overlap.

### 2. Per-tenant configuration (`TenantConfiguration.chasing`)

Add optional `chasing` subtree in `core/schemas/tenant-config.schema.json`, Zod (`core/src/config-engine/index.ts`), and `TenantModuleConfig` (`tenant_module_configs['communication_chasing']` edited via `saveChasingConfigAction` with `admin:access` + `mfaVerified: true`):

```ts
export interface ChasingRuleConfig {
  readonly enabled: boolean;          // core safe default: false
  readonly sendEmails: boolean;       // core safe default: false
  readonly firstChaseDays: number;    // default: 7  (int 1..90)
  readonly secondChaseDays: number;   // default: 14 (int 2..180, strictly > firstChaseDays)
  readonly escalateTaskDays: number;  // default: 21 (int 3..365, strictly > secondChaseDays)
}

export interface ChasingConfiguration {
  readonly engagementLetter: ChasingRuleConfig;
  readonly quote: ChasingRuleConfig;
  readonly moneyOnAccount: ChasingRuleConfig;
}
```

- **Safe core defaults (schema / Zod fallback for unconfigured firms):** `enabled: false`, `sendEmails: false`, `firstChaseDays: 7`, `secondChaseDays: 14`, `escalateTaskDays: 21`. Unconfigured firms never send automated client chase emails.
- **Invented demo defaults (`client-not-a-law-firm/config/base.json`):** `enabled: true`, `sendEmails: true`, `firstChaseDays: 7`, `secondChaseDays: 14`, `escalateTaskDays: 21` for all three kinds (`engagementLetter`, `quote`, `moneyOnAccount`).
- Validation enforces strictly ascending step days (`1 <= firstChaseDays < secondChaseDays < escalateTaskDays <= 365`) so steps never invert or collide on the same day. When `enabled === true` and `sendEmails === false`, email steps (`1` and `2`) record `'skipped_emails_disabled'` events (zero outbox emails sent), while step `3` still raises the fee-earner escalation task at `escalateTaskDays` so internal follow-up is not lost.

### 3. Single ADR 0030 scheduled job (`communication-chases`)

- **CLI & Container Apps job (`scripts/run-job.ts`, `core/infra/`):**
  - Job key: `'communication-chases'`, cron `'0 * * * *'` (hourly check acting once per local day at or after `08:00` in `tenantConfig.timeZone`, consistent with `register-reminders` and `notification-digests` in `actionPermissions.ts:1020–1045`).
  - Container Apps job: `caj-comm-chase-${env}` in `core/infra/modules/platform.bicep` gated by `enableCommunicationChasesJob` (referencing `enableSchedulerJobs`) in `core/infra/main.bicep`, using `runtimeIdentity` and `runtimeCommonEnv`.
  - Job-only permission: `'communication:run_chases'` (`jobOnly: true`, `sensitivity: 'critical'`) in `core/src/domain/rbac/registry.ts`, declared in `JOB_PERMISSIONS['communication-chases']` (`src/server/actionPermissions.ts`).
  - **Restatement of ADR 0030 Rule 4 exception:** Like the existing scheduled jobs (`key-date-reminders`, `register-reminders`, `quote-expiry`, etc.), `communication-chases` resolves tenant context strictly from the deployment's `tenantRegistry.ts` inside `scripts/run-job.ts` and `guardedJob('communication-chases', ...)` (`src/server/authorize.ts:667–935`); user routes and server actions never read the tenant registry.
- **Step execution semantics & idempotency (`executeCommunicationChasesForTenant`):**
  1. Wraps tenant execution in `executeControlledTenantJobRun` with `pg_try_advisory_xact_lock`, `public.job_runs` daily ledger, `AbortSignal` checks, and `resolveVerifiedTenantConfiguration`.
  2. Uses SQL-scoped candidate loading (`listDueActiveChases`, capped batch size, **never** loading all quotes/matters/requests — preserving `noWholeTenantLoadInRequestPaths.test.ts`).
  3. For each candidate inside its transaction, acquires `SELECT ... FROM public.communication_chases ... FOR UPDATE SKIP LOCKED`, locks and loads the target entity (`matters`, `quotes`, or `money_on_account_requests`), and invokes a typed entity handler (`CommunicationChaseEntityAdapter`) in a clean handler map:
     - **Immediate stop check:** If the entity is missing, resolved (`Signed` / `Signed & returned`, `Accepted` / `Declined` / `Expired` / `Superseded`, `received`), or withdrawn/cancelled, transitions `communication_chases.status = 'stopped'` with `stopped_reason` and performs **zero** chasing.
     - **Eventual/explicit stop hooks:** Every domain state-change service (`recordEngagementLetterSignedRecord`, `recordQuoteOutcomeRecord`, `finalizeQuoteConversionToMatter`, `reviseQuoteRecord`, `expireQuoteIfOverdue`, `recordMoneyOnAccountReceiptRecord`, `matchPmsClientLedgerReceiptRecord`, `cancelMoneyOnAccountRequestRecord`) also stops any active chase **synchronously inside the same write transaction** so UI and DB immediately reflect cessation without waiting for the next scheduler tick.
     - **Step 1 & 2 (`chase_email`):** Enqueues to `public.email_outbox` with deterministic **`idempotency_key = 'chase:${entityKind}:${entityId}:step:${stepIndex}'`** (never attaching PDFs on routine reminder chases unless needed, or staying well within 3 MB if attached), inserts `communication_chase_events` (`UNIQUE (tenant_id, chase_id, step_index)`), advances `next_step_index`, recomputes `next_action_at`, and appends a zero-PII `'communication-chase'` `audit_entries` row. Drains outbox post-commit.
     - **Step 3 (`escalation_task`):** Resolves the fee earner (`matter.responsibleFeeEarnerId ?? matter.responsiblePartnerId` or `quote.feeEarnerId`, verified active, non-leaver, and permitted via `canPersonAccessMatter` / `canRecipientReceiveNotification` — falling back to active supervisor/partner with matter access if restricted), inserts an idempotent task (`autoTrigger: 'communication_chase:${entityKind}'` deduplicated against open tasks), records `communication_chase_events` (`step_index = 3`), sets `communication_chases.status = 'completed'`, `next_action_at = NULL`, and writes a zero-PII audit entry.
  4. **Zero backfill for legacy items:** Existing pre-WP3 `'Sent'` quotes, `'Sent'` engagement letters, and matters receive **no** backfilled `communication_chases` rows; chasing begins strictly when an item is dispatched through WP3 send actions.

### 4. Relationship to `quote-expiry` and manual quote `followUps`

- **`quote-expiry` (`scripts/run-job.ts:117–123`, `src/server/services.ts:33088–33278`):** Continues running unchanged at `02:00` local time (`JOB_PERMISSIONS['quote-expiry']`, `actionPermissions.ts:1046–1054`). Because `quote-expiry` runs at `02:00` before `communication-chases` runs at `08:00`, expired quotes normally transition to `'Expired'` and close before chase evaluation; additionally, the `'quote'` chase adapter runs `evaluateQuoteEffectiveStatus(quote, now)` (`src/domain/quotes.ts:175–193`) inside the chase transaction as defence-in-depth and immediately stops the chase as `'expired'` if `validUntil < todayYmd`.
- **Manual quote `followUps` (`QuoteDetailClient.tsx:160–181`, `logQuoteFollowUpRecord` at `services.ts:21868–21942`):** Remain supported for fee earners logging telephone calls or ad-hoc client contact. Automated step-1/step-2 chases append a read-only `QuoteTimelineEvent` (`'follow_up'` note indicating automatic chase step) and record `communication_chase_events`, while manual `logQuoteFollowUpRecord` continues working independently and does not silently suppress scheduled chases unless the user stops chasing explicitly (`stopCommunicationChaseAction`) or records an outcome (`Accepted` / `Declined` / `Superseded`).

### 5. Behaviour across both hosting models & `S1-09` Information Barriers (Rules 6 & 9)

- **Model A (`single_tenant`):** Single entry in `tenantRegistry.ts`; `communication-chases` processes that tenant only, scoped via `ctx.tenantId` and `SET LOCAL ROLE`.
- **Model B (`multi_tenant`):** Runner iterates all enabled entries in `tenantRegistry.ts`; each tenant executes in its own isolated PostgreSQL transaction and database, with its own `chasing` config and outbox; a failure or timeout on tenant Alpha never stops or touches tenant Bravo.
- **Restricted matters and `S1-09` composition:** `communication_chases` stores nullable `matter_id` and `quote_id`. Escalation tasks link to the underlying `matter` / `quote` and enforce `canPersonAccessMatter` (`services.ts` / `TASK_VISIBLE_SQL_PREDICATE` / `QUOTE_VISIBLE_SQL_PREDICATE`). Chase audit entries, logs, and emails never leak client PII or restricted matter titles (`ADR 0020`, `B19`).

## Alternatives Considered

1. **Three separate scheduled jobs (`engagement-chase`, `quote-chase`, `money-on-account-chase`):** Rejected. Triples Bicep job definitions, `job_runs` tracking overhead, and scheduler failure/monitoring surfaces while duplicating identical 7-day / 14-day / escalation-task logic.
2. **Extend existing `register-reminders` (`caj-reg-rem-${env}`) instead of a dedicated `communication-chases` job:** Rejected. `register-reminders` serves internal staff compliance registers (`public.register_records`); client-facing outbound email chasing across entities outside `register_records` (`quotes`, `matters`, `money_on_account_requests`) needs clean domain separation, its own `communication:run_chases` job-only permission, and distinct monitoring.
3. **Piggy-back chases onto `quote.follow_ups_json` / per-table timestamp columns without a dedicated chase table:** Rejected. Per-table columns lead to three incompatible schemas, make unique step enforcement `(chase_id, step_index)` harder across kinds, and duplicate admin/monitoring queries.

## Consequences

- `S1-06` delivers the complete `communication_chases` / `communication_chase_events` schema, `chasing` config engine, `communication-chases` job, Bicep job definition, and `'engagement_letter'` handler once.
- `S1-07` and `S1-08` each require **zero new scheduler infrastructure or Bicep jobs** — only plugging their entity handler into `CommunicationChaseEntityAdapter` and wiring start/stop calls inside their send/outcome transactions.
- Requires two-tenant PostgreSQL tests covering `S1-06`, `S1-07`, and `S1-08` chases, concurrency (`UNIQUE (tenant_id, chase_id, step_index)`), immediate stop on outcomes, restricted-matter task filtering, and zero retrospective chasing of legacy items.
