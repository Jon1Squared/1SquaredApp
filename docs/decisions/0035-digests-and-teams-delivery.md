# ADR 0035: Notification Digests, Per-User Channel Preferences and Microsoft Teams Activity Feed Delivery

- **Date:** 2026-11-15
- **Status:** Proposed
- **Roadmap:** Stage 0 decision D11, slice S0-29 (`docs/roadmap/stage-0-plan.md`); backlog items 25 and E1
- **Amends:** [ADR 0027](./0027-email-sender-interface.md), point 5 ("Teams delivery comes later")
- **Related:** [ADR 0018](./0018-two-identity-authentication-model.md) (per-capability app registrations), [ADR 0027](./0027-email-sender-interface.md) (one `EmailSender` interface with per-tenant adapters), [ADR 0030](./0030-background-job-runner.md) (tenant-scoped background job runner)

## Context

In-app notifications are persisted in `public.notifications`, and [ADR 0027](./0027-email-sender-interface.md) defines `EmailSender` (`S0-26`) for transactional email delivery. However:

1. **No per-user channel or frequency preferences exist.** Users cannot choose per notification kind whether they want in-app only, immediate email, a daily or weekly email digest, or Microsoft Teams activity feed notifications.
2. **No digest scheduler exists.** Without a daily/weekly digest job, users who prefer batched summaries over individual emails have no delivery mechanism.
3. **ADR 0027 point 5 deferred Microsoft Teams delivery ("Teams delivery comes later").** Backlog item E1 and slice `S0-29` bring Microsoft Teams activity feed notifications and daily/weekly digests into Stage 0C ("Make it shared").

Under the Platform Architecture Standard:
- Background jobs must obey every rule in [ADR 0030](./0030-background-job-runner.md) (`guardedJob`, job-only permissions, `pg_try_advisory_xact_lock`, `public.job_runs` idempotency, correlation ID and tenant ID in structured logs, and no client content or personal data in logs).
- Non-live environments (`environment !== 'live'`) must never send notifications (email or Teams) to real recipients outside an explicit per-tenant allow-list.
- Staff-matter confidentiality (`isStaffMatter` restricted to `restrictedAccessUserIds`, Architecture Standard section 7) must be re-checked at digest assembly and delivery time, in case a user was removed from `restrictedAccessUserIds` after an in-app notification was created.

## Decision

### 1. Per-user notification preferences (`public.user_notification_preferences`)

A forward + down per-tenant migration adds `public.user_notification_preferences`:

- **Primary key:** `(tenant_id, person_id, notification_kind)` where `notification_kind` is a validated `NotificationKind` key (`'task_assigned'`, `'task_due_soon'`, `'task_overdue'`, `'approval_requested'`, `'approval_decided'`, `'key_date_approaching'`, `'credit_control_escalation'`, `'register_review_assigned'`, `'general'`).
- **Columns:**
  - `in_app_enabled BOOLEAN NOT NULL DEFAULT TRUE`
  - `email_frequency TEXT NOT NULL DEFAULT 'daily_digest'` (`'off' | 'immediate' | 'daily_digest' | 'weekly_digest'`)
  - `teams_enabled BOOLEAN NOT NULL DEFAULT FALSE`
  - `digest_day_of_week SMALLINT NOT NULL DEFAULT 1` (`1` = Monday through `5` = Friday for `'weekly_digest'`)
  - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- **Defaults:** When a user has no row for a `NotificationKind`, the core resolver applies deterministic defaults (`in_app_enabled: true`, `email_frequency: 'daily_digest'` for routine reminders and `'immediate'` for urgent approvals/escalations, `teams_enabled: false`).
- **Self-service and RBAC:**
  - Any authenticated user can read and update their own notification preferences via `getMyNotificationPreferencesAction` (`'notification:view_own'`) and `updateMyNotificationPreferencesAction` (`'notification:manage_own_preferences'`, self-only check `ctx.actorPersonId === targetPersonId` in the server action).
  - Preferences are read inside the same tenant-scoped PostgreSQL transaction when creating notifications or assembling digests.

### 2. Daily and weekly digest job (`notification-digests`)

Following [ADR 0030](./0030-background-job-runner.md):

1. **Job guard and job-only permission:**
   - The job runs through `guardedJob('notification-digests', handler)` with `JOB_POLICIES['notification-digests'] = { permission: 'notification:send_digests' }`.
   - `'notification:send_digests'` is registered in `core/src/rbac/permissions.ts` with `jobOnly: true`. It is granted to **no role** in `DEFAULT_ROLE_PERMISSIONS` (including `'admin'`), and `resolvePersonPermissionSet`, `updatePersonPermissionOverrides`, and `updateTenantRbacConfig` reject any `jobOnly` permission so no interactive user can ever acquire or invoke it.
   - `guardedJob` builds a synthetic `TenantContext` with `sub: 'system:notification-digests'`, `roles: []`, and `mfaVerified: false`.
2. **Time-zone-aware schedule and idempotency (`public.job_runs`):**
   - In Azure Container Apps, `caj-ntf-dig-<env>` runs on an hourly cron (`0 * * * *`) and evaluates `tenantConfig.timeZone` (default `'Europe/London'`).
   - It acts only when the tenant's local wall-clock hour is at or after `tenantConfig.notifications.digestHourLocal` (default `8`, i.e. 08:00 local time across both GMT and BST) on a working day, and has not yet completed for `(tenantId, localDateIso)`.
   - Inside `withTenantTransaction`, the job acquires `pg_try_advisory_xact_lock(hashtext('notification-digests:' || tenantId))` and claims `idempotencyKey = 'notification-digests:' || tenantId || ':' || localDateIso` in `public.job_runs`. If already `'succeeded'` (or `'running'` in another worker), it exits cleanly as a no-op (`skippedAlreadySucceeded: true`).
3. **Digest assembly and staff-matter re-verification:**
   - For each active person in the tenant who has undigested notifications (`digest_sent_at IS NULL`) and a preference of `'daily_digest'` (or `'weekly_digest'` when the local day of week matches `digest_day_of_week`):
     - If a notification links to a matter (`matter_id IS NOT NULL`), the job re-verifies that the recipient still has access to that matter (in particular, if `matter.isStaffMatter === true`, the recipient must currently be in `matter.restrictedAccessUserIds`). Any notification for a matter the recipient can no longer view is excluded from the digest and marked suppressed.
     - The job writes one `OutgoingEmail` row to `public.email_outbox` (`template_key = 'notification-digest-daily'` or `'notification-digest-weekly'`, `idempotency_key = 'digest:' || tenantId || ':' || personId || ':' || localDateIso`), sets `digest_sent_at = NOW()` on the included `public.notifications` rows, and writes an `audit_entries` row (`action = 'notification-digest-queued'`, recording only `recipientPersonId`, `itemCount`, and `correlationId` — never subject lines or body text) in the **same transaction** as marking `public.job_runs.status = 'succeeded'`.
   - Post-commit, the job triggers the outbox drain for the queued digest emails.

### 3. Microsoft Teams activity feed adapter (`TeamsNotifier`)

Amending [ADR 0027](./0027-email-sender-interface.md) point 5:

1. **Core interface (`@platform/core-api`):**
   ```ts
   export interface OutgoingTeamsActivity {
     readonly recipientEntraOid: string;
     readonly recipientEmail?: string;
     readonly activityType: string;
     readonly previewText: string;
     readonly templateParameters: ReadonlyArray<{ name: string; value: string }>;
     readonly deepLinkPath: string;
     readonly correlationId: string;
   }

   export interface TeamsSendResult {
     readonly status: 'sent' | 'dropped_not_allow_listed' | 'disabled';
     readonly providerRequestId?: string;
   }

   export interface TeamsNotifier {
     sendActivity(ctx: TenantContext, activity: OutgoingTeamsActivity): Promise<TeamsSendResult>;
   }
   ```
2. **Per-tenant configuration (`integrations.teams`):**
   Additive schema addition in `core/schemas/tenant-config.schema.json`:
   ```json
   "teams": {
     "provider": "'disabled' | 'dev_catcher' | 'graph'",
     "teamsAppId": "string (optional catalog/external app ID)",
     "graph": {
       "tenantId": "string (UUID)",
       "clientId": "string (UUID)",
       "certificateVaultRef": "kv://<vault>/<secret>",
       "certificateThumbprint": "string (40-char hex SHA-1)"
     },
     "recipientAllowList": ["string (email or Entra OID)"]
   }
   ```
   - Defaults to `provider: 'disabled'`.
   - Dedicated Entra app registration per [ADR 0018](./0018-two-identity-authentication-model.md) (for demo: client ID `76474047-ac1f-49ee-83f3-5a2a58c2b3f8`, separate from web sign-in and email).
   - Uses certificate authentication from Key Vault (`certificateVaultRef` validated by `assertTenantOwnsKeyVaultSecretRef`), never client secrets.
   - Calls Microsoft Graph `POST /users/{recipientEntraOid}/teamwork/sendActivityNotification` with application permission `TeamsActivity.Send`.
3. **Non-live allow-list enforced in core before any adapter runs:**
   - Exactly like `EmailSender`, when `environment !== 'live'`, the core `TeamsNotifier` wrapper checks `integrations.teams.recipientAllowList` **before** calling `dev_catcher` or `graph`.
   - If `recipientAllowList` is empty in a non-live environment, configuration validation / sending fails closed.
   - If the recipient's email/Entra OID is not on `recipientAllowList`, the core wrapper drops the notification, writes an `audit_entries` row (`action = 'teams-notification-dropped-allowlist'`), and returns `{ status: 'dropped_not_allow_listed' }` without calling the adapter.
4. **Transactional outbox (`public.teams_activity_outbox`):**
   - Just like `public.email_outbox`, Teams activity notifications are written to `public.teams_activity_outbox` inside the domain transaction and drained post-commit / via scheduled drain so no external HTTP call ever runs inside an open database transaction.
   - Logs and `audit_entries` record only `correlationId`, `tenantId`, `activityType`, and `status` — never preview text, parameter values, or personal data.

## Alternatives Considered

- **Send digests or Teams notifications directly inside interactive server actions.** Rejected: external HTTP calls inside a database transaction hold row locks and cannot be rolled back if the transaction later fails.
- **Share one Entra app registration between Email (`Mail.Send`) and Teams (`TeamsActivity.Send`).** Rejected: violates [ADR 0018](./0018-two-identity-authentication-model.md) least-privilege separation of duties.
- **Check non-live allow-lists inside individual adapters (`graph`, `dev_catcher`).** Rejected: enforcing `recipientAllowList` in the core dispatcher before invoking any adapter guarantees that every adapter (including test/dev adapters) obeys the exact same safety invariant.

## Consequences

- Backlog items 25 (Notification centre, email & Teams digests) and E1 (Microsoft Teams activity feed & channel notifications) have a complete, tenant-isolated, testable architecture in `S0-29`.
- Live Microsoft Graph Teams delivery in the demo tenant requires two manual steps by the owner in the Microsoft Teams Admin Center / Entra portal (uploading the Teams app manifest declaring `activityTypes` and granting `TeamsActivity.Send` on app `76474047-ac1f-49ee-83f3-5a2a58c2b3f8`). Those are tracked as manual setup blockers for live verification only; all unit, two-tenant isolation, allow-list, and `dev_catcher` / mock Graph contract tests run in CI without them.
