# S0-29 — Teams Delivery and Digests (`notification-digests`, User Preferences UI and `TeamsNotifier`)

| Field | Value |
|---|---|
| Slice | `S0-29` |
| Stage / Work package | Stage 0C — Make it shared (`WP5c`) |
| Status | Planned (awaiting build after `S0-26`) |
| Branch | `s0-29-teams-delivery-and-digests` (target `develop`) |
| Depends on | `S0-26`, `S0-19` |
| Size | `M` |
| Backlog IDs | `32` (`Partly built` -> `Completed`; advances `P9`; cross-cutting `P10`, `P11`) |
| Decision record(s) | `D11` — [ADR 0035](../decisions/0035-digests-and-teams-delivery.md) (`Accepted`, amending ADR 0027 point 5) |
| Spec / standards references | Architecture Standard sections 4, 7, 8, 10, 12; [ADR 0027](../decisions/0027-email-sender-interface.md); [ADR 0030](../decisions/0030-tenant-aware-scheduler.md) |

---

## 1. Purpose

Complete Stage 0 backlog item `32` (*Search and notifications*) to the strict **Completed** bar under [ADR 0035](../decisions/0035-digests-and-teams-delivery.md) (`D11`):

- Expand `NotificationKind` to all **12** canonical notification kinds and expose per-user channel/frequency preference management (`'notification:view_own'`, `'notification:manage_own_preferences'`), defaulting routine items to `daily_digest` (`S4`).
- Deliver the scheduled **`notification-digests`** job (`caj-ntf-dig-<env>`) on the `ADR 0030` scheduler at `08:00` local time (`tenantConfig.timeZone`, `Europe/London`, GMT/BST-safe), queueing daily/weekly digest emails into `public.email_outbox` while re-checking `canAccessMatter` so revoked restricted matters never leak.
- Implement **`TeamsNotifier`** (`integrations.teams`, default `'disabled'`) resolving `recipientPersonId` -> bound `entraObjectId`, enforcing non-live allow-listing and strict content-scrubbing via transactional **`public.teams_activity_outbox`** drained by `outbox-drain` (`S0-26`).

---

## 2. Classification & Architectural Layer

- **Classification:** Core migration (`0020`), core notification/digest/Teams integration (`core/src/integrations/teams/`), scheduler job (`notification-digests` + Bicep `caj-ntf-dig-<env>`), RBAC & action guards, and profile preferences UI.
- **Single-tenant and multi-tenant operation:** Identical build. Notification preferences, digest state (`notifications.digest_sent_at`), `teams_activity_outbox` and employee `entraObjectId` resolution run inside each tenant's PostgreSQL database under authenticated `TenantContext` / `guardedJob`.

---

## 3. Existing Code & Schema

- **Database schema version entering `S0-29`:** `0019` (from `S0-26`, which already creates `public.email_outbox`, `public.user_notification_preferences` and `outbox-drain`).
- **Notification types & scheduler baseline:** `NotificationKind` currently has `5` values (`'task_assigned' | 'team_task_arrived' | 'task_comment' | 'enquiry_assigned' | 'task_overdue'`, `src/domain/types.ts:1363-1368`), `JOB_PERMISSIONS` (`src/server/actionPermissions.ts:706-768`, `MAX_KNOWN_GAPS = 0`), `REGISTERED_CLI_JOBS` (`scripts/run-job.ts:44-85`), `core/infra/modules/platform.bicep:1380-1475`, `core/tests/infra-bicep-contract.test.ts:327-336`.
- **Matter confidentiality:** `canAccessMatter` (`core/src/domain/rbac/resolver.ts:628`).

---

## 4. Scope & Exact Changes

### 4.1 Migration `0020_teams_outbox_and_digests_expand`

Bump `CORE_REQUIRED_SCHEMA_VERSION` from `'0019'` to `'0020'` and add `0020_teams_outbox_and_digests_expand` (reversible expand migration):

- **`public.teams_activity_outbox`**: `id`, `tenant_id`, `idempotency_key UNIQUE`, `status` (`'pending' | 'sending' | 'sent' | 'dead_letter' | 'dropped_not_allow_listed' | 'dropped_unbound'`), `recipient_person_id`, `entra_object_id NULL`, `activity_type`, `preview_text` (scrubbed only), `template_parameters_jsonb`, `deep_link_path`, `correlation_id`, `attempts`, `next_attempt_at`, `sent_at`, `body_redacted_at`, timestamps.
- **`public.notifications`**: `ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS digest_sent_at TIMESTAMPTZ`.

### 4.2 All 12 `NotificationKind` values & self-service preferences UI

- Expand `NotificationKind` (`src/domain/types.ts` & validation schemas) to include all **12 exact values** (`ADR 0035 §1`):
  1. `'task_assigned'` (existing)
  2. `'team_task_arrived'` (existing)
  3. `'task_comment'` (existing)
  4. `'enquiry_assigned'` (existing)
  5. `'task_due_soon'` (new)
  6. `'task_overdue'` (existing)
  7. `'approval_requested'` (new)
  8. `'approval_decided'` (new)
  9. `'key_date_approaching'` (new)
  10. `'credit_control_escalation'` (new)
  11. `'register_review_assigned'` (new)
  12. `'general'` (new)
- Implement core deterministic default resolver (`S4`, owner-confirmed 15 Nov 2026): `in_app_enabled: true`, `email_frequency: 'daily_digest'` for routine reminders (`'immediate'` for urgent approvals/escalations), `teams_enabled: false`.
- Register `'notification:view_own'` and `'notification:manage_own_preferences'` in `PERMISSION_REGISTRY` (`core/src/domain/rbac/registry.ts`), add `getMyNotificationPreferencesAction` and `updateMyNotificationPreferencesAction` via `guardedAction` in `src/app/actions.ts` + `src/server/actionPermissions.ts` (self-only check `ctx.actorPersonId === targetPersonId`), and add user preference controls in Profile/Notifications settings.

### 4.3 Digest scheduler job (`notification-digests`, `caj-ntf-dig-<env>`)

- Register `jobOnly: true` permission **`'notification:send_digests'`** in `core/src/domain/rbac/registry.ts` (granted to zero roles, rejected on role/override mutation), `JOB_PERMISSIONS['notification-digests']` (`src/server/actionPermissions.ts`), `REGISTERED_CLI_JOBS` (`scripts/run-job.ts`), and Bicep Container Apps job **`caj-ntf-dig-<env>`** (`0 * * * *`) + `core/tests/infra-bicep-contract.test.ts:327-336`.
- Inside `guardedJob('notification-digests', ...)` + `withTenantTransaction`:
  - Evaluate `tenantConfig.timeZone` (`Europe/London`) vs `tenantConfig.notifications.digestHourLocal` (default `8`, working days).
  - Acquire `pg_try_advisory_xact_lock(hashtext('notification-digests:' || tenantId))` and claim `idempotencyKey = 'notification-digests:' || tenantId || ':' || localDateIso` in `public.job_runs`.
  - Assemble per-user digest (unread notifications with `digest_sent_at IS NULL`, tasks due and upcoming key dates for `'daily_digest'`, plus `'weekly_digest'` on matching `digest_day_of_week`).
  - **Re-verify `canAccessMatter` at assembly time:** exclude/suppress any item pointing to an `isStaffMatter` or `hasEthicalWall` matter the recipient is no longer permitted to view.
  - Enqueue one digest row into `public.email_outbox` (`template_key = 'notification-digest-daily' | 'notification-digest-weekly'`), set `digest_sent_at = NOW()`, write `'notification-digest-queued'` in `audit_entries`, mark `job_runs = 'succeeded'`, and trigger post-commit `outbox-drain` pass.

### 4.4 `TeamsNotifier`, content-scrubbing & `outbox-drain` extension (`integrations.teams`)

- Add schema-validated `integrations.teams` (`provider: 'disabled' | 'dev_catcher' | 'graph'`, default `'disabled'`, `teamsAppId`, `graph: { tenantId, clientId, certificateVaultRef, certificateThumbprint }`) in `core/schemas/tenant-config.schema.json` + `core/src/config-engine/index.ts`.
- Implement `TeamsNotifier` (`sendActivity(ctx, OutgoingTeamsActivity): Promise<TeamsSendResult>`):
  - Callers pass `recipientPersonId` (`P-xxxxxx`) only; core resolves `entraObjectId` from `TenantPartyRepository` (`dropped_unbound` if absent; never stores or accepts personal OIDs in config).
  - Enforces non-live allow-list (`dropped_not_allow_listed`) identical to `EmailSender`.
  - **Content-scrubbing:** strictly strips/blocks confidential matter titles, client names and narrative bodies from `previewText` and `templateParameters` before queueing into `public.teams_activity_outbox`.
  - Extend `outbox-drain` (`S0-26`) to drain both `public.email_outbox` and `public.teams_activity_outbox` (`POST /users/{entraObjectId}/teamwork/sendActivityNotification`) with retry/backoff, `dead_letter` and `outboxContentRetentionDays` body scrubbing.

### 4.5 Out of Scope

- Direct interactive Teams bot commands / adaptive card approvals inside Teams (Stage 2+).

---

## 5. Migrations & Backwards Compatibility

- **Migration:** `0020_teams_outbox_and_digests_expand` (adds `public.teams_activity_outbox` and nullable `public.notifications.digest_sent_at`; bumps `CORE_REQUIRED_SCHEMA_VERSION` from `'0019'` to `'0020'`).
- **Reversibility:** Down SQL drops `teams_activity_outbox` and the `digest_sent_at` column cleanly without altering existing notifications.
- Tenants with `integrations.teams.provider = 'disabled'` (default) incur zero Teams traffic.

---

## 6. Security, Tenancy & Permissions

- `'notification:send_digests'` is `jobOnly: true`; `'notification:view_own'` and `'notification:manage_own_preferences'` enforce `ctx.actorPersonId === targetPersonId` via `guardedAction`.
- Restricted matter re-verification (`canAccessMatter`) runs at digest build time so revoked access never leaks into daily/weekly email digests.
- Teams push notifications never expose sensitive client/matter body content (`content-scrubbing`), resolve OIDs solely from bound tenant `Person` records (`R491`), and respect non-live allow-lists.

---

## 7. Tests Required

1. **All 12 `NotificationKind` & preference tests:** Verify all 12 kinds validate and round-trip through `public.user_notification_preferences`, default `S4` behaviour (`daily_digest` routine vs `immediate` urgent approvals, `teams_enabled: false`), and self-only RBAC check (`'notification:view_own'`, `'notification:manage_own_preferences'`).
2. **`notification-digests` GMT/BST DST transition tests:** Test around `08:00` `Europe/London` across both **March spring-forward** (UTC+0 -> UTC+1) and **October fall-back** (UTC+1 -> UTC+0), proving the job runs **exactly once per local working day**, respects `weekly_digest` `digest_day_of_week`, sets `digest_sent_at`, and stays idempotent on duplicate hourly invocations via `job_runs`.
3. **Restricted-matter revocation test:** Create notification on restricted matter, remove user's access before `08:00` digest run -> excluded from queued digest email.
4. **`TeamsNotifier` & scrubbing tests:** Unbound person returns `dropped_unbound`, disallowed non-live recipient returns `dropped_not_allow_listed`, content scrubber rejects/redacts forbidden confidential text, `outbox-drain` drains both `email_outbox` and `teams_activity_outbox` against mocked Graph.
5. **Bicep & permission guard tests:** `notification-digests` in `JOB_PERMISSIONS` + `REGISTERED_CLI_JOBS`, `'notification:send_digests'` denied to all roles including `'admin'`, and `infra-bicep-contract.test.ts` passes with `caj-ntf-dig-<env>`.
6. **Two-tenant isolation tests (`P8`):** Tampered `personId`, cross-tenant digest assembly, forged `tenantId` claims and cross-tenant `teams_activity_outbox` draining fail closed across Tenant A and Tenant B.

---

## 8. Documentation, Help & Backlog Updates

- **Help & documentation (`Rule 11`, `P11`):**
  - Update [home-and-profile-screens.ts](file:///c:/1Squared/App/src/docs/articles/home-and-profile-screens.ts) (explicitly explaining **`daily_digest` `S4` out-of-the-box default**, 12 notification kinds and how users switch preferences to `'off'`, `'immediate'` or `'weekly_digest'`).
  - Update [tenant-settings.ts](file:///c:/1Squared/App/src/docs/articles/tenant-settings.ts) (`integrations.teams` setting, default `'disabled'`, digest local hour setting).
  - Update [key-dates-reminders.ts](file:///c:/1Squared/App/src/docs/articles/key-dates-reminders.ts) and [deployment-and-security.ts](file:///c:/1Squared/App/src/docs/articles/deployment-and-security.ts) (`TeamsActivity.Send` allow-list and content-scrubbing).
- **Release notes:** Add an `S0-29` entry in `docs/release-notes.md`.
- **Backlog updates (`docs/roadmap/feature-list.md`):**
  - Item `32` (*Search and notifications*): **`Partly built` -> `Completed`** (now that `S0-25`, `S0-26` and `S0-29` are all done!).
  - Record advances on `P9` (scheduler completeness), `P10`, `P11`.

---

## 9. Manual Setup & Readiness

Live Graph `TeamsActivity.Send` delivery in the demo environment relies on Section 8 setup documented in [`docs/runbooks/teams-app-setup.md`](../../runbooks/teams-app-setup.md) (all unit, DST, scrubbing, outbox-drain and mocked Graph tests pass cleanly without live Azure access):
- **Done (16 November 2026):** Microsoft Entra app `76474047-ac1f-49ee-83f3-5a2a58c2b3f8` (directory `f8218d9a-e055-463f-add2-f03679aad7f2`) has **`TeamsActivity.Send` application permission granted with admin consent** (`User.Read` removed); `core/integrations/teams/app-package/` is packaged, uploaded and allowed in Teams Admin Center with an App Setup Policy assigned to the demo users; PEM certificate `graph-teams-client-cert` (`secretProperties.contentType = "application/x-pem-file"`, SHA-1 thumbprint `6A23E571EA3F43D1DB39C187A201B40454159D3B`) and `teams-recipient-allowlist` are created in `kvnotalawfi2cdo3cw7vuafm` with `.cer` uploaded to Entra; `demo.json` holds `"certificateThumbprint": "6A23E571EA3F43D1DB39C187A201B40454159D3B"` and `"provider": "disabled"`.
- **Remaining activation step:** After Checkpoint 5c deploys to Azure, run the live Graph verification test and switch `integrations.teams.provider` from `"disabled"` to `"graph"`.

---

## 10. Acceptance Criteria

- [x] Migration `0020_teams_outbox_and_digests_expand` creates `public.teams_activity_outbox` and `notifications.digest_sent_at`; `CORE_REQUIRED_SCHEMA_VERSION === '0020'`.
- [x] All **13** canonical `NotificationKind` values (the 12 operational kinds plus `general`) are supported end to end with `S4` (`daily_digest`) default, `'notification:view_own'` and `'notification:manage_own_preferences'`.
- [x] `notification-digests` runs via `guardedJob` (`'notification:send_digests'`, Bicep `caj-ntf-dig-<env>`), handles GMT/BST transitions accurately, re-verifies `canAccessMatter` and queues digests idempotently.
- [x] `TeamsNotifier` resolves `recipientPersonId` -> `entraObjectId`, enforces non-live allow-lists and content-scrubbing, delivers through `public.teams_activity_outbox` + `outbox-drain`, and includes a contract-tested `core/integrations/teams/app-package/` (`manifest.json` schema `1.16`, icons, `npm run teams:package`) plus `docs/runbooks/teams-app-setup.md`.
- [x] Two-tenant isolation tests, GMT/BST tests and `npm run ci` pass.
- [x] Help articles (`S4` daily_digest explanation included), `docs/runbooks/teams-app-setup.md`, `docs/release-notes.md` and `docs/roadmap/feature-list.md` (`32` -> `Completed`) are updated in the same PR.

---

## 11. Re-plan Signs & Risks

- **Re-plan if:**
  - Any tenant work-type/notification source emits notification rows without a bound `matterId` when linking to restricted matters (preventing digest-time re-check);
  - Teams app catalog approval is needed earlier for a live demo -> Teams stays `disabled` / `dev_catcher` until manual Teams app consent is completed (section 8 blocker).
