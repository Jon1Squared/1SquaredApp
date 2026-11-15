# ADR 0035: Notification Digests, Per-User Channel Preferences and Microsoft Teams Activity Feed Delivery

- **Date:** 2026-11-15
- **Status:** Accepted
- **Roadmap:** Stage 0 decision D11, slice S0-29 (`docs/roadmap/stage-0-plan.md`); backlog item 32 (*Search and notifications*)
- **Amends:** [ADR 0027](./0027-email-sender-interface.md), point 5 ("Teams delivery comes later")
- **Related:** [ADR 0018](./0018-two-identity-authentication-model.md) (per-capability app registrations), [ADR 0027](./0027-email-sender-interface.md) (one `EmailSender` interface with per-tenant adapters), [ADR 0030](./0030-tenant-aware-scheduler.md) (tenant-aware scheduler)

## Context

In-app notifications are persisted in `public.notifications`, and [ADR 0027](./0027-email-sender-interface.md) defines `EmailSender` (`S0-26`) for transactional email delivery. However:

1. **No per-user channel or frequency preferences exist.** Users cannot choose per notification kind whether they want in-app only, immediate email, a daily or weekly email digest, or Microsoft Teams activity feed notifications.
2. **No digest scheduler exists.** Without a daily/weekly digest job, users who prefer batched summaries over individual emails have no delivery mechanism.
3. **ADR 0027 point 5 deferred Microsoft Teams delivery ("Teams delivery comes later").** Backlog item 32 (*Search and notifications*) and slice `S0-29` bring Microsoft Teams activity feed notifications and daily/weekly digests into Stage 0C ("Make it shared").

Under the Platform Architecture Standard:
- Background jobs must obey [ADR 0030](./0030-tenant-aware-scheduler.md) (`guardedJob`, job-only permissions, `pg_try_advisory_xact_lock`, `public.job_runs` idempotency or the recorded `outbox-drain` variant in [ADR 0027 §6.4](./0027-email-sender-interface.md), correlation ID and tenant ID in structured logs, and no client content or personal data in logs).
- Non-live environments (`environment !== 'live'`) must never send notifications (email or Teams) to real recipients outside an explicit per-tenant allow-list, and no personal identifiers or Entra Object IDs may be committed to configuration files.
- Staff-matter confidentiality (`isStaffMatter` restricted to `restrictedAccessUserIds`, Architecture Standard section 7) and ethical walls (`B12`) must be re-checked at digest assembly and delivery time, in case a user was removed from `restrictedAccessUserIds` after an in-app notification was created.

## Decision

### 1. Per-user notification preferences (`public.user_notification_preferences`)

A forward + down per-tenant migration adds `public.user_notification_preferences`:

- **Primary key:** `(tenant_id, person_id, notification_kind)` where `notification_kind` is a validated `NotificationKind` key (`'task_assigned'`, `'team_task_arrived'`, `'task_comment'`, `'enquiry_assigned'`, `'task_due_soon'`, `'task_overdue'`, `'approval_requested'`, `'approval_decided'`, `'key_date_approaching'`, `'credit_control_escalation'`, `'register_review_assigned'`, `'general'`, preserving all 5 existing live kinds alongside the 7 new kinds).
- **Columns:**
  - `in_app_enabled BOOLEAN NOT NULL DEFAULT TRUE`
  - `email_frequency TEXT NOT NULL DEFAULT 'daily_digest'` (`'off' | 'immediate' | 'daily_digest' | 'weekly_digest'`)
  - `teams_enabled BOOLEAN NOT NULL DEFAULT FALSE`
  - `digest_day_of_week SMALLINT NOT NULL DEFAULT 1` (`1` = Monday through `5` = Friday for `'weekly_digest'`)
  - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- **Defaults (`S4`, confirmed by the product owner on 15 November 2026):** When a user has no row for a `NotificationKind`, the core resolver applies deterministic defaults (`in_app_enabled: true`, `email_frequency: 'daily_digest'` for routine reminders and `'immediate'` for urgent approvals/escalations, `teams_enabled: false`). Keeping a daily email digest as the out-of-the-box default was confirmed by the product owner on 15 November 2026; the Help & documentation page for notifications (`S0-26` / `S0-29`) must explain clearly how users can change their frequency or switch to in-app only (`'off'`).
- **Self-service and RBAC:**
  - Any authenticated user can read and update their own notification preferences via `getMyNotificationPreferencesAction` (`'notification:view_own'`) and `updateMyNotificationPreferencesAction` (`'notification:manage_own_preferences'`, self-only check `ctx.actorPersonId === targetPersonId` in the server action).
  - Preferences are read inside the same tenant-scoped PostgreSQL transaction when creating notifications or assembling digests.

### 2. Daily and weekly digest job (`notification-digests`)

Following [ADR 0030](./0030-tenant-aware-scheduler.md):

1. **Job guard and job-only permission:**
   - The job runs through `guardedJob('notification-digests', handler)` with `JOB_PERMISSIONS['notification-digests']` (`src/server/actionPermissions.ts:706-768`) requiring `'notification:send_digests'`.
   - `'notification:send_digests'` is registered in `PERMISSION_REGISTRY` (`core/src/domain/rbac/registry.ts`) with `jobOnly: true`. It is granted to **no role** in `DEFAULT_RBAC_ROLES` (including `'admin'`), and `resolvePersonPermissionSet`, `updatePersonPermissionOverrides`, and `updateTenantRbacConfig` reject any `jobOnly` permission so no interactive user can ever acquire or invoke it.
   - `guardedJob` builds a synthetic `TenantContext` with `sub: 'system:notification-digests'`, `roles: []`, and `mfaVerified: false`.
2. **Time-zone-aware schedule and idempotency (`public.job_runs`):**
   - In Azure Container Apps, `caj-ntf-dig-<env>` runs on an hourly cron (`0 * * * *`) and evaluates `tenantConfig.timeZone` (default `'Europe/London'`).
   - It acts only when the tenant's local wall-clock hour is at or after `tenantConfig.notifications.digestHourLocal` (default `8`, i.e. 08:00 local time across both GMT and BST) on a working day, and has not yet completed for `(tenantId, localDateIso)`.
   - Inside `withTenantTransaction`, the job acquires `pg_try_advisory_xact_lock(hashtext('notification-digests:' || tenantId))` and claims `idempotencyKey = 'notification-digests:' || tenantId || ':' || localDateIso` in `public.job_runs`. If already `'succeeded'` (or `'running'` in another worker), it exits cleanly as a no-op (`skippedAlreadySucceeded: true`).
3. **Digest assembly and staff-matter re-verification:**
   - For each active person in the tenant who has undigested notifications (`digest_sent_at IS NULL`) and a preference of `'daily_digest'` (or `'weekly_digest'` when the local day of week matches `digest_day_of_week`):
     - If a notification links to a matter (`matter_id IS NOT NULL`), the job re-verifies inside the transaction that the recipient still has access to that matter (checking `isStaffMatter`, `hasEthicalWall`, and `restrictedAccessUserIds`). Any notification for a matter the recipient can no longer view is excluded from the digest and marked suppressed.
     - The job writes one `OutgoingEmail` row to `public.email_outbox` (`template_key = 'notification-digest-daily'` or `'notification-digest-weekly'`, `idempotency_key = 'digest:' || tenantId || ':' || personId || ':' || localDateIso`), sets `digest_sent_at = NOW()` on the included `public.notifications` rows, and writes an `audit_entries` row (`action = 'notification-digest-queued'`, recording only `recipientPersonId`, `itemCount`, and `correlationId` — never subject lines or body text) in the **same transaction** as marking `public.job_runs.status = 'succeeded'`.
   - Post-commit, the job triggers a best-effort pass of the shared `outbox-drain` processor (with the scheduled `outbox-drain` job handling retries).

### 3. Microsoft Teams activity feed adapter (`TeamsNotifier`)

Amending [ADR 0027](./0027-email-sender-interface.md) point 5:

1. **Core interface (`@platform/core-api`) and recipient resolution (`R491`):**
   ```ts
   export interface OutgoingTeamsActivity {
     readonly recipientPersonId: string;
     readonly activityType: string;
     readonly previewText: string;
     readonly templateParameters: ReadonlyArray<{ name: string; value: string }>;
     readonly deepLinkPath: string;
     readonly correlationId: string;
   }

   export interface TeamsSendResult {
     readonly status: 'sent' | 'dropped_not_allow_listed' | 'dropped_unbound' | 'disabled';
     readonly providerRequestId?: string;
   }

   export interface TeamsNotifier {
     sendActivity(ctx: TenantContext, activity: OutgoingTeamsActivity): Promise<TeamsSendResult>;
   }
   ```
   - Callers pass the internal **`recipientPersonId`** (`P-xxxxxx`), never an Entra Object ID from configuration.
   - Inside core, the dispatcher resolves the recipient's `Person` record from the tenant database (`TenantPartyRepository`) to obtain their bound `entraObjectId` (for Graph `POST /users/{entraObjectId}/teamwork/sendActivityNotification`) and verified email address(es). If the person has no bound `entraObjectId`, delivery returns `{ status: 'dropped_unbound' }` without calling Graph.
2. **Per-tenant configuration (`integrations.teams`) and credential caching (`R491`, `R493`):**
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
     "recipientAllowList": ["string (@domain suffix or P-xxxxxx personId; never OIDs or personal emails)"],
     "recipientAllowListVaultRef": "kv://<vault>/<secret> (optional; exact allowed emails)"
   }
   ```
   - Defaults to `provider: 'disabled'`.
   - Dedicated Entra app registration per [ADR 0018](./0018-two-identity-authentication-model.md) (for demo: client ID `76474047-ac1f-49ee-83f3-5a2a58c2b3f8`, separate from web sign-in and email).
   - Uses certificate authentication from Key Vault (`certificateVaultRef` validated by `assertTenantOwnsKeyVaultSecretRef`), never client secrets, and acquires tokens via the same `GraphAppTokenProvider` named-exception access-token-only cache specified in [ADR 0027 §7.2](./0027-email-sender-interface.md) (keyed by `(tenantId, entraTenantId, clientId, certificateThumbprint, scope)`, never caching private keys, and verified with two-tenant token isolation tests).
   - Calls Microsoft Graph `POST /users/{entraObjectId}/teamwork/sendActivityNotification` with application permission `TeamsActivity.Send`.
3. **Non-live allow-list enforced in core before any adapter runs (`R491`):**
   - Exactly like `EmailSender`, committed configuration files (`demo.json`, `dev.json`, `test.json`) never contain personal email addresses or Entra Object IDs (Rule 5): `integrations.teams.recipientAllowList` holds `@domain` suffixes (e.g. `["@1squared.co.uk"]`) or `P-xxxxxx` person IDs, and exact allowed emails may be supplied through `recipientAllowListVaultRef` (`assertTenantOwnsKeyVaultSecretRef`).
   - When `environment !== 'live'`, the core `TeamsNotifier` wrapper checks the allow-list **before** calling `dev_catcher` or `graph`:
     - **Fail closed:** If the combined allow-list (`recipientAllowList` + `recipientAllowListVaultRef`) is empty, or if `recipientAllowListVaultRef` is configured and unreadable/invalid, **nothing is sent** (all notifications are blocked before any adapter runs, audited/logged with counts and error codes only).
     - Matching is performed by the recipient's `recipientPersonId` or verified database email address (never by an OID typed into configuration). If the recipient is not matched, the core wrapper drops the notification, writes an `audit_entries` row (`action = 'teams-notification-dropped-allowlist'`), and returns `{ status: 'dropped_not_allow_listed' }` without calling the adapter.
4. **Transactional outbox (`public.teams_activity_outbox`), shared `outbox-drain` job, and content scrubbing (`R492`, `R494`, `S3`):**
   - Teams activity notifications are written to `public.teams_activity_outbox` (with `(tenant_id, idempotency_key)` uniqueness, `status`, `attempt_count`, `next_attempt_at`, `claimed_at`, `claim_token`, `last_error_code`, and `content_scrubbed_at`) inside the domain transaction so no external HTTP call ever runs inside an open database transaction.
   - `public.teams_activity_outbox` is drained post-commit and on a 5-minute retry schedule (`*/5 * * * *`) by the **shared `outbox-drain` job** (`caj-outbox-drain-<env>`, `guardedJob('outbox-drain', ...)`, job-only permission `'notification:drain_outbox'`, recorded [ADR 0030](./0030-tenant-aware-scheduler.md) variant) described in [ADR 0027 §6.4](./0027-email-sender-interface.md), including `FOR UPDATE SKIP LOCKED` claiming, 5-minute stale `'sending'` reclamation, `failed_permanent` transition + `audit_entries` + Application Insights telemetry alert after `maxAttempts` (`5`), and **at-least-once** external Graph delivery semantics.
   - At the end of each `outbox-drain` tenant pass, terminal `teams_activity_outbox` rows older than `integrations.email.outboxContentRetentionDays` (`default: 30`) have `preview_text` and `template_parameters_json` scrubbed (`NULL` / `'[]'::jsonb`, `content_scrubbed_at = NOW()`), preserving delivery metadata and audit entries.
   - Logs and `audit_entries` record only `correlationId`, `tenantId`, `outboxId`, `activityType`, and `status` — never preview text, parameter values, or personal data.

## Alternatives Considered

- **Send digests or Teams notifications directly inside interactive server actions.** Rejected: external HTTP calls inside a database transaction hold row locks and cannot be rolled back if the transaction later fails.
- **Share one Entra app registration between Email (`Mail.Send`) and Teams (`TeamsActivity.Send`).** Rejected: violates [ADR 0018](./0018-two-identity-authentication-model.md) least-privilege separation of duties.
- **Check non-live allow-lists inside individual adapters (`graph`, `dev_catcher`), or commit user OIDs/emails in config.** Rejected: enforcing `recipientAllowList` + `recipientAllowListVaultRef` in core by person ID / verified email (and `@domain` entries) before invoking any adapter prevents PII/OIDs in git and guarantees every adapter obeys the exact same fail-closed safety invariant.

## Consequences

- Backlog item 32 (*Search and notifications*) has a complete, tenant-isolated, testable architecture for per-user channel preferences, daily/weekly digests, and Teams activity feed notifications in `S0-29`.
- Live Microsoft Graph Teams delivery in the demo tenant requires two manual steps by the owner in the Microsoft Teams Admin Center / Entra portal (uploading the Teams app manifest declaring `activityTypes` and granting `TeamsActivity.Send` on app `76474047-ac1f-49ee-83f3-5a2a58c2b3f8`). Those are tracked as manual setup blockers for live verification only; all unit, two-tenant isolation, allow-list, and `dev_catcher` / mock Graph contract tests run in CI without them.
