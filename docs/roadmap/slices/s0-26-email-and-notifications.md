# S0-26 — Email and Notifications (Transactional Outbox, `EmailSender` Adapters and User Preferences Store)

| Field | Value |
|---|---|
| Slice | `S0-26` |
| Stage / Work package | Stage 0C — Make it shared (`WP5c`) |
| Status | Planned (awaiting build after `WP5b`; proposed resize `M -> L` in stage plan callout) |
| Branch | `s0-26-email-and-notifications` (target `develop`) |
| Depends on | `S0-19` (on `develop`; stacked on `0018` in `WP5c` -> adds `0019`) |
| Size | `M` in existing plan (recommended resize **`M -> L`** in stage plan callout) |
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

- **`public.email_outbox`**: `id`, `tenant_id`, `idempotency_key UNIQUE`, `status` (`'pending' | 'sending' | 'sent' | 'dead_letter' | 'dropped_not_allow_listed'`), `attempts`, `next_attempt_at`, `to_addresses_jsonb`, `subject`, `template_key`, `body_text`, `body_html`, `attachment_blob_keys_jsonb`, `correlation_id`, `sent_at`, `body_redacted_at`, timestamps.
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

- Enforce non-live (`environment !== 'live'`) allow-listing in the shared pipeline **before invoking any adapter** (`dev_catcher`, `graph`, `acs`, `disabled`): recipients matching `recipientAllowList` or `recipientAllowListVaultRef` pass; any disallowed recipient is blocked/dropped cleanly (`dropped_not_allow_listed`), audited without body/PII leakage in logs (`tenantId` + `correlationId` only).
- Wire transactional enqueue on immediate email-enabled notifications + scheduled **`outbox-drain`** job:
  - Registered under `guardedJob('outbox-drain', ...)` with `jobOnly: true` permission **`'email:drain_outbox'`** (`JOB_PERMISSIONS` in `src/server/actionPermissions.ts`, `MAX_KNOWN_GAPS = 0`, `REGISTERED_CLI_JOBS` in `scripts/run-job.ts`).
  - Documented `ADR 0030` variant rationale: unlike daily calendar jobs (`key-date-reminders`), `outbox-drain` runs frequently (`*/5` or scheduled interval via Bicep **`caj-outbox-drain-<env>`**) with `pg_try_advisory_xact_lock`, per-row status claiming (`pending` -> `sending` -> `sent` / backoff retry / `dead_letter`), `public.job_runs` run telemetry, and content redaction (`body_redacted_at` nullifying `body_text` / `body_html`) once `sent_at` exceeds `outboxContentRetentionDays` (`default: 30`).
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
- `outbox-drain` runs under `guardedJob` with `jobOnly: true` `'email:drain_outbox'`.
- Logs emit only `tenantId`, `correlationId`, outbox ID, adapter status and error codes — never email subjects, bodies or recipient addresses (`Architecture Standard section 8`).
- Admin config saves for `integrations.email` require admin permission + `mfaVerified === true`.

---

## 7. Tests Required

1. **`GraphAppTokenProvider` RS256 & token cache tests:** Mock Key Vault PFX/PEM secret + Entra token endpoint; verify signed RS256 client assertion JWT claims, encrypted cache hit/expiry refresh, and cross-tenant Key Vault ref rejection (`assertTenantOwnsKeyVaultSecretRef`).
2. **All-adapter non-live allow-list tests:** Test **`dev_catcher`**, **`graph`** and **`acs`** (plus `disabled`) under non-live mode against allowed (`@domain` / Key Vault allow-list ref) and disallowed recipients — prove no external transport call is ever made for disallowed addresses on any adapter!
3. **`acs` fail-closed placeholder test:** Selecting `provider: 'acs'` returns explicit `'EMAIL_PROVIDER_NOT_IMPLEMENTED'` error rather than succeeding silently.
4. **Attachment isolation test:** `DocumentStorageProvider.getObjectBytes` throws on cross-tenant blob keys before reading storage.
5. **`outbox-drain` & retention tests:** Retry exponential backoff -> `dead_letter` after max attempts, `idempotency_key` deduplication, `outboxContentRetentionDays` (`30` days default) content redaction sets `body_redacted_at` and clears body columns, and `JOB_PERMISSIONS` / `REGISTERED_CLI_JOBS` / `infra-bicep-contract.test.ts` pass.
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

Live Graph delivery in the demo/pilot environment depends on Section 8 manual tasks documented in `docs/runbooks/email-certificate-setup.md` (automated CI tests pass against mocked Graph & Mailpit `dev_catcher` without them):
- Provision shared sender mailbox (`noreply@1Squared.co.uk`) and Exchange Online RBAC for Applications scoping app access solely to that mailbox.
- Create/import PFX client certificate into tenant Azure Key Vault and register public key on the Graph mail Entra app.
- Populate `recipientAllowListVaultRef` secret in Key Vault with permitted tester addresses.
- Configure SPF / DKIM DNS records for sender domain.

---

## 10. Acceptance Criteria

- [ ] Migration `0019_email_outbox_and_preferences_expand` creates `public.email_outbox` and `public.user_notification_preferences`; `CORE_REQUIRED_SCHEMA_VERSION === '0019'`.
- [ ] `EmailSender` supports `dev_catcher`, `graph` (`GraphAppTokenProvider` RS256 + encrypted cache), fail-closed `acs` placeholder and `disabled`.
- [ ] `DocumentStorageProvider.getObjectBytes` checks `assertBlobKeyBelongsToTenant`.
- [ ] Non-live allow-list (`recipientAllowList` + `recipientAllowListVaultRef`) blocks disallowed recipients across every adapter (`dev_catcher`, `graph`, `acs`).
- [ ] `outbox-drain` runs under `guardedJob` with `'email:drain_outbox'`, Bicep job `caj-outbox-drain-<env>` and `outboxContentRetentionDays` redaction (`default: 30`).
- [ ] Two-tenant isolation tests, fixture verification (`verify-invented-fixtures.mjs`) and `npm run ci` pass.
- [ ] Help articles, `email-certificate-setup.md` runbook, `docs/release-notes.md` and `docs/roadmap/feature-list.md` (`32` kept `Partly built`) are updated in the same PR.

---

## 11. Re-plan Signs & Risks

- **Re-plan if:**
  - Owner does not approve resizing `S0-26` from `M` to `L` in `stage-0-plan.md` (split `GraphAppTokenProvider` cert auth or outbox retention purge if kept strictly `M`);
  - Azure Container Apps cron cadence needs dedicated Bicep alert rules in `core/infra/` beyond existing job resource blocks;
  - Live Key Vault certificate secret format (`.pfx` base64 vs `.pem`) differs across Azure Key Vault SDK bindings requiring format auto-detection.
