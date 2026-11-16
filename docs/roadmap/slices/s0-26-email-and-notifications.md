# S0-26 — Email and Notifications (Transactional Outbox, `EmailSender` Adapters and User Preferences Store)

| Field | Value |
|---|---|
| Slice | `S0-26` |
| Stage / Work package | Stage 0C — Make it shared (`WP5c`) |
| Status | Implemented (awaiting Key Vault cert import blocker before live demo Graph switch; resized `M -> L` per owner approval 15 Nov 2026) |
| Branch | `s0-26-email-and-notifications` (target `develop`) |
| Depends on | `S0-19` (on `develop`; stacked on `0018` in `WP5c` -> adds `0019`) |
| Size | `L` (resized from `M` per owner approval 15 Nov 2026) |
| Backlog IDs | `32` (remains `Partly built` until `S0-29` completes digests + Teams; advances `P6`; cross-cutting `P10`, `P11`) |
| Decision record(s) | `D9` — [ADR 0027](../decisions/0027-email-sender-interface.md) (`Accepted` + Accepted Outbox Amendment) |
| Spec / standards references | Architecture Standard sections 4, 5, 6, 8, 10, 12; [ADR 0018](../decisions/0018-two-identity-authentication-model.md); [ADR 0030](../decisions/0030-tenant-aware-scheduler.md) |

---

## 1. Purpose

Deliver the shared transactional email pipeline and user notification preferences store under [ADR 0027](../decisions/0027-email-sender-interface.md) (including the Accepted Outbox Amendment):

- Define one `EmailSender` interface in `@platform/core` with tenant-configured adapters (`dev_catcher`, `graph`, fail-closed `acs` placeholder, and `disabled`).
- Build transactional **`public.email_outbox`** plus scheduled **`outbox-drain`** delivery (`caj-outbox-drain-<env>`) and retention redaction (`outboxContentRetentionDays`, default `30` days), along with **`public.user_notification_preferences`** ready for immediate email routing here and digests/Teams in `S0-29`.
- Implement **`GraphAppTokenProvider`** (RS256 certificate-signed client assertions loaded from Key Vault + encrypted per-tenant access-token cache).
- Enforce non-live recipient allow-listing (`recipientAllowList` domain suffixes + `recipientAllowListVaultRef`) across **all** adapters, and fetch attachments strictly through `DocumentStorageProvider.getObjectBytes` with tenant blob ownership checks.

---

## 2. Classification & Architectural Layer

- **Classification:** Core integration (`core/src/integrations/email/`), core migration (`0019`), tenant config schema (`integrations.email`), Bicep Container Apps job (`core/infra/modules/platform.bicep`), and operational certificate runbook.
- **Single-tenant and multi-tenant operation:** Identical build. Outbox rows and notification preferences live inside each tenant's PostgreSQL database, token caches and attachment reads are isolated by `tenantId`, and non-live allow-list checks guard every adapter identically.

---

## 3. Existing Code & Schema

- **Database schema version entering `S0-26`:** `0018` (from `S0-25`, sequential in `WP5c`).
- **Blob & Key Vault primitives to reuse:** `DocumentStorageProvider` (`core/src/tenancy/blobStorage.ts:55-225` — add `getObjectBytes` obeying `assertBlobKeyBelongsToTenant`), `assertTenantOwnsKeyVaultSecretRef` (`core/src/tenancy/keyVaultSecrets.ts:67`), encrypted token cache pattern in `core/src/integrations/document-stores/tokenCache.ts`.
- **Fixture validator constraint:** `scripts/verify-invented-fixtures.mjs:22-36` rejects non-RFC-2606 email addresses in committed `client-*/config/**/*.json`.
- **Scheduler, jobs & Bicep contracts:** `JOB_PERMISSIONS` (`src/server/actionPermissions.ts:706-768`, `MAX_KNOWN_GAPS = 0`), `REGISTERED_CLI_JOBS` (`scripts/run-job.ts:44-85`), `core/infra/modules/platform.bicep:1380-1475`, `core/tests/infra-bicep-contract.test.ts:327-336`.

---

## 4. Scope & Exact Changes

### 4.1 Migration `0019_email_outbox_and_preferences_expand`

Bump `CORE_REQUIRED_SCHEMA_VERSION` from `'0018'` to `'0019'` and add `0019_email_outbox_and_preferences_expand` (reversible expand migration):

- **`public.email_outbox`** (`ADR 0027 §6.1` canonical schema): `(tenant_id, id)` PK (via `tenant_email_outbox_id_seq`), `idempotency_key` (`UNIQUE (tenant_id, idempotency_key)`), `template_key`, `correlation_id`, `recipients_json JSONB`, `subject`, `html_body`, `text_body`, `attachments_json JSONB`, `status` (`'pending' | 'sending' | 'sent' | 'dropped_allowlist' | 'failed_permanent'`), `attempt_count`, `next_attempt_at`, `claimed_at`, `claim_token`, `sent_at`, `provider_message_id`, `last_error_code`, `content_scrubbed_at` (`CHECK ((content_scrubbed_at IS NOT NULL) OR (subject IS NOT NULL AND html_body IS NOT NULL AND text_body IS NOT NULL))`), `created_by_person_id`, `created_at`, `updated_at`.
- **`public.user_notification_preferences`**: `(tenant_id, person_id, notification_kind)` primary key with `in_app_enabled BOOLEAN DEFAULT TRUE`, `email_frequency TEXT DEFAULT 'daily_digest'`, `teams_enabled BOOLEAN DEFAULT FALSE`, `digest_day_of_week SMALLINT DEFAULT 1`, `updated_at TIMESTAMPTZ`.

### 4.2 `EmailSender` interface, `GraphAppTokenProvider` & four adapters

- **`EmailSender` & attachment helper:** Define core `EmailSender` in `core/src/integrations/email/` (and public types in `core/src/api/`). Add `DocumentStorageProvider.getObjectBytes(ctx, blobKey)` which enforces `assertBlobKeyBelongsToTenant` (failing closed on cross-tenant blob keys) before reading attachment bytes.
- **Four adapters selectable via `integrations.email.provider`:**
  1. **`dev_catcher`**: Local SMTP / Mailpit catcher transport for dev and automated test verification (respects allow-list in non-live environments too!).
  2. **`graph`**: `GraphAppTokenProvider` loads PFX/PEM certificate via `assertTenantOwnsKeyVaultSecretRef`, signs RS256 JWT client assertions via `crypto.createSign('RSA-SHA256')` against Entra token endpoint, caches short-lived access tokens inside an encrypted per-tenant token cache (following `tokenCache.ts`), and POSTs `/users/{senderAddress}/sendMail` using Microsoft Graph.
  3. **`acs` (fail-closed placeholder)**: Registered adapter slot that throws explicit domain error `'EMAIL_PROVIDER_NOT_IMPLEMENTED'` (Azure Communication Services hosted integration deferred to Stage 1; never silently drops or mocks live sends).
  4. **`disabled`**: Safe no-op / explicit disabled status returning without network calls.

### 4.3 Tenant configuration & fixture-safe allow-list (`integrations.email`)

Add additive, backwards-compatible `integrations.email` schema entries in `core/schemas/tenant-config.schema.json` and `core/src/config-engine/index.ts`:
- `provider` (`'disabled' | 'dev_catcher' | 'graph' | 'acs'`, default `'disabled'`), `senderAddress`, `tenantDirectoryId`, `clientId`, `certificateVaultRef`, `recipientAllowList` (`@domain` suffix patterns + allowed synthetic domains), `recipientAllowListVaultRef` (`kv://...` secret ref holding non-live individual test recipient emails at runtime without storing personal emails in git!), and `outboxContentRetentionDays` (`default: 30`).
- Update `client-not-a-law-firm/config/` cleanly using RFC 2606 addresses (`@notalawfirm.example`) / Key Vault refs so `node scripts/verify-invented-fixtures.mjs` passes with zero personal data or real emails in git.

### 4.4 Core non-live allow-list pipeline & `outbox-drain` job (`ADR 0030` variant)

- Enforce non-live (`environment !== 'live'`) allow-listing in the shared pipeline **before invoking any adapter** (`dev_catcher`, `graph`, `acs`): recipients matching `recipientAllowList` or `recipientAllowListVaultRef` pass; any disallowed recipient is blocked/dropped cleanly (`dropped_allowlist`), audited without body/PII leakage in logs (`tenantId` + `correlationId` only).
- Wire transactional enqueue on immediate email-enabled notifications + scheduled **`outbox-drain`** job:
  - Registered under `guardedJob('outbox-drain', ...)` with `jobOnly: true` permission **`'notification:drain_outbox'`** (`JOB_PERMISSIONS` in `src/server/actionPermissions.ts`, `MAX_KNOWN_GAPS = 0`, `REGISTERED_CLI_JOBS` in `scripts/run-job.ts`, ADR 0027 §6.4 & ADR 0035 §3.4).
  - Documented `ADR 0030` variant rationale: unlike daily calendar jobs (`key-date-reminders`), `outbox-drain` runs frequently (`*/5 * * * *` via Bicep **`caj-outbox-drain-<env>`**) with `FOR UPDATE SKIP LOCKED` row claiming (`pending` -> `sending` -> `sent` / exponential backoff retry / `failed_permanent` at 5 attempts + `outbox.delivery.failed_permanent` Log Analytics alert), per-tenant `pg_try_advisory_xact_lock` content scrubbing (`content_scrubbed_at` nullifying `subject`, `html_body`, `text_body`, `attachments_json`, and clearing recipient emails once past `outboxContentRetentionDays`, `default: 30`), and zero-PII telemetry.
- Update `core/tests/infra-bicep-contract.test.ts:327-336` for `caj-outbox-drain-<env>`.

### 4.5 Out of Scope

- Enquiry and quote outbound email wiring (items `1` and `3` — wired onto `EmailSender` in Stage 1).
- Daily/weekly digest builder and Microsoft Teams `TeamsNotifier` (`S0-29`).

---

## 5. Migrations & Backwards Compatibility

- **Migration:** `0019_email_outbox_and_preferences_expand` (adds `public.email_outbox` and `public.user_notification_preferences`; bumps `CORE_REQUIRED_SCHEMA_VERSION` from `'0018'` to `'0019'`).
- **Reversibility:** Reversible down SQL drops the two new tables cleanly. Existing in-app `public.notifications` behaviour is unchanged for tenants leaving `integrations.email.provider = 'disabled'`.

---

## 6. Security, Tenancy & Permissions

- Certificate Key Vault references validated via `assertTenantOwnsKeyVaultSecretRef` before token acquisition; PFX/private key material never written to disk or logs.
- `DocumentStorageProvider.getObjectBytes` rejects cross-tenant blob keys (`assertBlobKeyBelongsToTenant`).
- `outbox-drain` runs under `guardedJob` with `jobOnly: true` `'notification:drain_outbox'` (`actorId: 'system:outbox-drain'`).
- Logs emit only `tenantId`, `correlationId`, outbox ID, adapter status and error codes — never email subjects, bodies or recipient addresses (`Architecture Standard section 8`).
- Outbound `integrations.email` configuration comes exclusively from validated tenant configuration (`base.json` / environment overlays checked by `assertTenantOwnsKeyVaultSecretRef`).

---

## 7. Tests Required

1. **`GraphAppTokenProvider` RS256 & token cache tests:** Mock Key Vault PFX/PEM secret + Entra token endpoint; verify signed RS256 client assertion JWT claims, encrypted cache hit/expiry refresh, and cross-tenant Key Vault ref rejection (`assertTenantOwnsKeyVaultSecretRef`).
2. **All-adapter non-live allow-list tests:** Test **`dev_catcher`**, **`graph`** and **`acs`** (plus `disabled`) under non-live mode against allowed (`@domain` / Key Vault allow-list ref) and disallowed recipients — prove no external transport call is ever made for disallowed addresses on any adapter!
3. **`acs` fail-closed placeholder test:** Selecting `provider: 'acs'` returns explicit `'EMAIL_PROVIDER_NOT_IMPLEMENTED'` error rather than succeeding silently.
4. **Attachment isolation test:** `DocumentStorageProvider.getObjectBytes` throws on cross-tenant blob keys before reading storage.
5. **`outbox-drain` & retention tests:** Retry exponential backoff -> `failed_permanent` after max attempts (emitting `outbox.delivery.failed_permanent`), `idempotency_key` deduplication, 5-minute stale `'sending'` reclamation, `outboxContentRetentionDays` (`30` days default) content scrubbing sets `content_scrubbed_at` and clears body/subject/attachments/recipients, and `JOB_PERMISSIONS` / `REGISTERED_CLI_JOBS` / `infra-bicep-contract.test.ts` pass.
6. **Two-tenant isolation tests (`P8`):** Tampered `outboxId` / `personId` and forged `tenantId` claims cannot drain, read or mutate another tenant's outbox rows, token cache or notification preferences; `node scripts/verify-invented-fixtures.mjs` passes.

---

## 8. Documentation, Help & Backlog Updates

- **Help & documentation (`Rule 11`, `P11`):**
  - Update [tenant-settings.ts](file:///c:/1Squared/App/src/docs/articles/tenant-settings.ts) (`integrations.email` config, `recipientAllowList`, `outboxContentRetentionDays`).
  - Update [deployment-and-security.ts](file:///c:/1Squared/App/src/docs/articles/deployment-and-security.ts) (outbound email allow-listing, Graph app-only certificate model, outbox retention redaction).
- **Operational runbook:** Create `docs/runbooks/email-certificate-setup.md` (PFX certificate creation, Key Vault import, `ApplicationAccessPolicy` / Exchange Online RBAC scoping to shared mailbox, `recipientAllowListVaultRef` setup) and link from `docs/runbooks/demo-deployment.md`.
- **Release notes:** Add an `S0-26` entry in `docs/release-notes.md`.
- **Backlog updates (`docs/roadmap/feature-list.md`):**
  - Item `32` (*Search and notifications*): remains `Partly built` (record `EmailSender`, outbox, `GraphAppTokenProvider`, `user_notification_preferences` table and `outbox-drain` complete; *"What's missing"*: `S0-29` digest job & Teams notifier).
  - Record advances on `P6` (demo allow-list protection) + `P10`, `P11`.

---

## 9. Manual Setup / External Blockers

Live Graph delivery in the demo/pilot environment depends on Section 8 manual tasks documented in `docs/runbooks/email-certificate-setup.md` (automated CI tests pass against mocked Graph & TCP SMTP `dev_catcher` without them):
- **Done (12–16 November 2026):** Shared sender mailbox (`notifications@1squared.co.uk`) provisioned; Microsoft Entra app (`fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1`, directory `f8218d9a-e055-463f-add2-f03679aad7f2`) registered and scoped solely to that mailbox via Exchange Online RBAC for Applications; SPF/DKIM/DMARC DNS records configured for `1squared.co.uk`; client certificate `graph-mail-certificate` (`kv://kvnotalawfi2cdo3cw7vuafm/graph-mail-certificate`, thumbprint `BC9CB621EF3BDC2413D3EA345609586ABF5167ED`) generated inside `kvnotalawfi2cdo3cw7vuafm` with `.cer` uploaded to Microsoft Entra.
- **Remaining blocker:** Populate `email-recipient-allowlist` (`kv://kvnotalawfi2cdo3cw7vuafm/email-recipient-allowlist`) with permitted tester addresses, run the live verification check, and switch `demo.json` `integrations.email.provider` from `"disabled"` to `"graph"`.

---

## 10. Acceptance Criteria

- [x] Migration `0019_email_outbox_and_preferences_expand` creates `public.email_outbox` and `public.user_notification_preferences`; `CORE_REQUIRED_SCHEMA_VERSION === '0019'`.
- [x] `EmailSender` supports `dev_catcher`, `graph` (`GraphAppTokenProvider` RS256 + AES-256-GCM 300s-skew access-token cache), fail-closed `acs` placeholder (`EMAIL_PROVIDER_NOT_IMPLEMENTED`), and `disabled`.
- [x] `DocumentStorageProvider.getObjectBytes` checks `assertBlobKeyBelongsToTenant`.
- [x] Non-live allow-list (`recipientAllowList` + `recipientAllowListVaultRef`) blocks disallowed recipients across every active adapter (`dev_catcher`, `graph`, `acs`).
- [x] `outbox-drain` runs under `guardedJob` with `'notification:drain_outbox'`, Bicep job `caj-outbox-drain-<env>`, `outbox.delivery.failed_permanent` alert query, and `outboxContentRetentionDays` content scrubbing (`default: 30`).
- [x] Two-tenant isolation tests, fixture verification (`verify-invented-fixtures.mjs`), and `core/tests/email-notifications-s026.test.ts` pass.
- [x] Help articles, `docs/runbooks/email-certificate-setup.md`, `docs/release-notes.md`, and `docs/roadmap/feature-list.md` (`32` kept `Partly built`) updated in the same PR.

---

## 11. Re-plan Signs & Risks

- **Re-plan if:**
  - Owner does not approve resizing `S0-26` from `M` to `L` in `stage-0-plan.md` (split `GraphAppTokenProvider` cert auth or outbox retention purge if kept strictly `M`);
  - Azure Container Apps cron cadence needs dedicated Bicep alert rules in `core/infra/` beyond existing job resource blocks;
  - Live Key Vault certificate secret format (`.pfx` base64 vs `.pem`) differs across Azure Key Vault SDK bindings requiring format auto-detection.
