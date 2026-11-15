# ADR 0027: One EmailSender Interface with Per-Tenant Adapters

- **Date:** 2026-11-06
- **Status:** Accepted
- **Roadmap:** Stage 0 decision D9, slice S0-26 (`docs/roadmap/stage-0-plan.md`); backlog item 32

## Context

No email is ever sent today:
- The enquiry "Send email" action and the quote "Mark as sent" action only write audit entries.
- Credit-control reminders only write a note.
- Notifications are in-app only.

Demos need real email now. Hosted and client-hosted installations need different sending routes, and non-live environments must never email real people by accident.

## Decision

1. **A core interface.** `EmailSender` is exported from `@platform/core-api`:

   ```ts
   send(ctx: TenantContext, message: OutgoingEmail): Promise<EmailSendResult>
   ```

   `OutgoingEmail` carries the recipients, subject, HTML and text bodies, optional attachments by document reference, a correlation ID and a template key.
   - Sending is queued as a tenant-scoped background job. The job carries the tenant ID and refuses to run without it.
   - Logs and audit entries record the message ID, template key, recipient count and outcome. They never record message bodies or email addresses.

2. **Adapters, chosen per tenant in configuration.**

   | Adapter | Used for |
   |---|---|
   | `dev_catcher` (SMTP to Mailpit or similar) | dev and test |
   | `graph` (app-only `POST /users/{mailbox}/sendMail`) | Now: the demo tenant and pilots, sending from a 1Squared.co.uk shared mailbox. Later: client-hosted installations, sending from the firm's own mailbox. |
   | `acs` (Azure Communication Services Email) | The hosted service, later. A placeholder adapter for now. |
   | `disabled` | The default |

3. **Configuration.** This is an additive schema change, so it stays backward compatible within the major version (architecture rule 7):

   ```text
   integrations.email = {
     provider: 'disabled' | 'dev_catcher' | 'graph' | 'acs',
     senderAddress,
     replyTo?,
     graph?: { tenantId, clientId, certificateVaultRef },
     acs?: { connectionVaultRef },
     recipientAllowList: string[]
   }
   ```

   - Credentials are Key Vault references only.
   - When `environment !== 'live'`, `recipientAllowList` must not be empty. The sender drops any recipient that isn't on it, and audits the drop.

4. **Least privilege for Graph.**
   - The Entra app registration for email is separate from the sign-in and SharePoint registrations ([ADR 0018](./0018-two-identity-authentication-model.md)).
   - It is granted Mail.Send **only** through Exchange Online RBAC for Applications, scoped to the sending mailbox.
   - It has no tenant-wide Microsoft Graph Mail.Send consent.
   - It authenticates with a certificate held in Key Vault, not a client secret.

5. **Teams delivery comes later,** through the same notification service rather than through `EmailSender` (now specified in [ADR 0035](./0035-digests-and-teams-delivery.md)).

## Proposed Amendment (2026-11-15 — WP5 Phase 0, slice S0-26)

- **Status of amendment:** Proposed

### 6. Transactional outbox (`public.email_outbox`) and delivery mechanism

Email must never be sent over the network from inside an open PostgreSQL transaction that could still roll back, and a transient network or Microsoft Graph failure must not roll back a completed business action (or lose the email). We therefore use a **transactional outbox combined with post-commit drain and a scheduled retry job**:

1. **Outbox table (`public.email_outbox`):**
   - Created by a reversible per-tenant migration (`core/src/tenancy/migrations/`).
   - Scoped by `tenant_id` (enforced by `TenantConnection` / `assertQueryIncludesTenantId`) with columns:
     - `id TEXT PRIMARY KEY`
     - `tenant_id TEXT NOT NULL`
     - `idempotency_key TEXT NOT NULL` (`UNIQUE (tenant_id, idempotency_key)`)
     - `template_key TEXT NOT NULL`
     - `correlation_id TEXT NOT NULL`
     - `recipients_json JSONB NOT NULL` (`to`, `cc`, `bcc` addresses; scrubbed to `'[]'::jsonb` on retention expiry)
     - `subject TEXT NULL` (non-null until `content_scrubbed_at IS NOT NULL`)
     - `html_body TEXT NULL` (non-null until `content_scrubbed_at IS NOT NULL`)
     - `text_body TEXT NULL` (non-null until `content_scrubbed_at IS NOT NULL`)
     - `attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb` (tenant blob storage keys + metadata, resolved via `TenantBlobStorage.getReadStream` at send time after `assertTenantOwnsBlobKey`)
     - `status TEXT NOT NULL DEFAULT 'pending'` (`'pending' | 'sending' | 'sent' | 'dropped_allowlist' | 'failed_permanent'`)
     - `attempt_count INTEGER NOT NULL DEFAULT 0`
     - `next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
     - `claimed_at TIMESTAMPTZ NULL`
     - `claim_token TEXT NULL`
     - `sent_at TIMESTAMPTZ NULL`
     - `provider_message_id TEXT NULL`
     - `last_error_code TEXT NULL`
     - `content_scrubbed_at TIMESTAMPTZ NULL` (`CHECK ((content_scrubbed_at IS NOT NULL) OR (subject IS NOT NULL AND html_body IS NOT NULL AND text_body IS NOT NULL))`)
     - `created_by_person_id TEXT NULL`
     - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
     - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
2. **Enqueuing in the domain transaction:**
   - Any server action (`sendEnquiryEmailAction`, `sendQuoteEmailAction`, `sendCreditControlReminderAction`, etc.) or background job (`notification-digests`) inserts a row into `public.email_outbox` (with a deterministic `idempotency_key`) and writes an `audit_entries` row (`action = 'email-queued'`) inside the **same `withTenantTransaction` call** as the domain state update.
3. **Non-live `recipientAllowList` enforced in core before any adapter runs (no personal data in committed config, `R491`):**
   - `integrations.email.recipientAllowList` supports **domain entries** prefixed with `@` (for example `["@1squared.co.uk"]` in `demo.json`, matched case-insensitively against each recipient's domain) so personal email addresses never need to be committed to repository configuration files (Rule 5). Entra Object IDs are forbidden in allow-lists.
   - An additive optional setting `integrations.email.recipientAllowListVaultRef` (`kv://<vault>/<secret>`, validated by `assertTenantOwnsKeyVaultSecretRef`) loads exact allowed email addresses from the tenant's Key Vault at send time without committing them to git.
   - Before invoking `dev_catcher`, `graph`, or `acs`, the core dispatcher checks `environment !== 'live'`.
   - **Fail closed:** In any non-live environment, if the combined allow-list (`recipientAllowList` domain entries plus resolved `recipientAllowListVaultRef` addresses) is empty, or if `recipientAllowListVaultRef` is configured and unreadable or invalid, **nothing is sent**: all recipients are blocked before any adapter is called, an `audit_entries` row is written with only the blocked count, error code, and `correlationId` (never email addresses), and pending/blocked outbox rows do not invoke an adapter. Otherwise, any recipient address not matched by an allowed domain or Key Vault address is stripped before invoking the adapter, and an `audit_entries` row (`action = 'email-recipient-dropped-allowlist'`, recording the dropped count and `correlationId` — never the email address) is written; if no allowed recipients remain, the row is marked `status = 'dropped_allowlist'`.
4. **Post-commit drain + shared `outbox-drain` retry job (`ADR 0030` variant, `R492`, `S3`):**
   - Interactive actions trigger a best-effort post-commit drain immediately after `withTenantTransaction` commits, claiming the newly created outbox row in a short claim transaction (`FOR UPDATE SKIP LOCKED`, setting `status = 'sending'`, `claimed_at = NOW()`, `claim_token`) so normal interactive sends complete with near-zero latency.
   - If the process crashes after commit or Microsoft Graph returns a transient error (`429`, `5xx`, or network timeout), a scheduled retry job **`outbox-drain`** (`caj-outbox-drain-<env>`, shared by `public.email_outbox` in `S0-26` and `public.teams_activity_outbox` in `S0-29`) claims due rows in batches and delivers them.
   - **`outbox-drain` as a recorded [ADR 0030](./0030-tenant-aware-scheduler.md) variant:** `outbox-drain` runs through `guardedJob('outbox-drain', ...)` with job-only permission `'notification:drain_outbox'` (`jobOnly: true`, granted to **no** role including `'admin'`, actor `'system:outbox-drain'`). Unlike daily [ADR 0030](./0030-tenant-aware-scheduler.md) jobs, `outbox-drain` runs **every 5 minutes** (`*/5 * * * *`) rather than once per local day, and therefore does **not** gate execution on a per-day `public.job_runs` key; concurrency and idempotency are coordinated on the outbox rows via short claim transactions (`FOR UPDATE SKIP LOCKED` with `claimed_at` and `claim_token`).
   - **Stale-claim reclamation:** Any row left in `status = 'sending'` with `claimed_at <= NOW() - INTERVAL '5 minutes'` (after a worker crash or network hang) is reclaimed automatically on the next drain pass while `attempt_count < maxAttempts` (default `5`), using exponential backoff in `next_attempt_at`.
   - **Permanent failure and alerting:** When `attempt_count >= maxAttempts` (default `5`) or a non-retryable provider error occurs, the row transitions to `status = 'failed_permanent'`, writes an `audit_entries` row (`action = 'email-send-failed-permanent'`), and emits structured error telemetry (`outbox.delivery.failed_permanent` carrying `tenantId`, `correlationId`, `outboxId`, `channel: 'email'`, and `lastErrorCode` — zero PII) wired to an Application Insights alert rule.
   - **At-least-once delivery semantics (`S3`):** `UNIQUE (tenant_id, idempotency_key)` guarantees at-most-once enqueueing, while Microsoft Graph `sendMail` itself is not idempotent. External email delivery is therefore **at-least-once**: if a worker crashes after Graph accepts `sendMail` and before the post-send database transaction marks the row `'sent'`, the row may be sent again once the 5-minute claim expires.
   - On completion, `audit_entries` records `action = 'email-sent'` or `'email-send-failed'` / `'email-send-failed-permanent'` with `outboxId`, `templateKey`, `recipientCount`, `provider`, and `correlationId` — never recipient addresses, subject lines, or bodies (Rule 5).
5. **Scrubbing personal data and message bodies from terminal outbox rows (`R494`):**
   - Additive tenant configuration setting `integrations.email.outboxContentRetentionDays` (`integer`, `minimum: 1`, `maximum: 365`, `default: 30`, description `'Days to retain recipient addresses and message bodies on terminal email/Teams outbox rows before scrubbing PII while keeping delivery metadata'`).
   - At the end of each `outbox-drain` tenant pass, any row in a terminal state (`status IN ('sent', 'dropped_allowlist', 'failed_permanent')`) with `content_scrubbed_at IS NULL` and `updated_at <= NOW() - make_interval(days => outboxContentRetentionDays)` has `recipients_json` cleared to `'[]'::jsonb`, `subject = NULL`, `html_body = NULL`, `text_body = NULL`, `attachments_json` cleared to `'[]'::jsonb`, and `content_scrubbed_at = NOW()` inside a tenant transaction, while keeping operational metadata (`id`, `idempotency_key`, `template_key`, `correlation_id`, `status`, `attempt_count`, `sent_at`, `provider_message_id`, `last_error_code`, timestamps) and `audit_entries` intact. Telemetry logs only the count of scrubbed rows.

### 7. Loading the Microsoft Graph client certificate from Key Vault

1. **Configuration schema (`integrations.email.graph`):**
   ```text
   integrations.email.graph = {
     tenantId: string (UUID),
     clientId: string (UUID),
     certificateVaultRef: string (kv://<vault-name>/<secret-name>),
     certificateThumbprint: string (40-char hex SHA-1 thumbprint)
   }
   ```
   - `certificateVaultRef` is validated by `assertTenantOwnsKeyVaultSecretRef(ctx, ref, tenantConfig)` before any Key Vault access so Tenant A can never reference a secret belonging to Tenant B.
2. **Key Vault retrieval, JWT client assertion (`RS256`), and explicit credential caching policy (`R493`):**
   - When a certificate is imported into Azure Key Vault (`az keyvault certificate import`), Key Vault exposes the certificate bundle (private key + X.509 certificate in PEM/PKCS#12 form) as a Key Vault **secret** with the same name (`kv://<vault-name>/<cert-name>`).
   - At token acquisition time, `GraphAppTokenProvider` fetches the secret value via `@azure/keyvault-secrets` (`SecretClient` authenticated with `DefaultAzureCredential` / managed identity `runtimeIdentity`), parses the private key using Node's built-in `node:crypto` (`createPrivateKey`), verifies that the certificate's SHA-1 thumbprint matches `certificateThumbprint`, signs a short-lived RFC 7523 `client_assertion` JWT (`alg: 'RS256'`, `x5t` header derived from `certificateThumbprint`, `aud: 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token'`, `iss: clientId`, `sub: clientId`, 5-minute lifetime, unique `jti`), and **immediately discards the private key and certificate bundle**.
   - It exchanges the `client_assertion` for an app-only Graph access token (`scope = 'https://graph.microsoft.com/.default'`) and calls `POST https://graph.microsoft.com/v1.0/users/{encodeURIComponent(senderAddress)}/sendMail` with `saveToSentItems: false`.
   - **Named exception — access-token-only cache (never private keys):**
     - **Private keys and Key Vault certificate secrets are NEVER cached in memory** across drain batches or requests.
     - Only short-lived OAuth **access tokens** may be cached in memory by `GraphAppTokenProvider` as an explicit, named exception to the no-module-map rule, following the encrypted cache pattern in `core/src/integrations/document-stores/tokenCache.ts`:
       - each cached access token is encrypted at rest in memory (`AES-256-GCM`) and keyed strictly by `buildTenantCacheKey(ctx, 'graph-app-token', ...)` over `(tenantId, entraTenantId, clientId, certificateThumbprint, scope)`;
       - entries expire **5 minutes (`300s`) before** the token's `expires_in` timestamp so stale tokens are never reused;
       - private keys, certificate bundles, and tokens are never written to logs, errors, or audit rows.
     - **Mandatory two-tenant isolation test:** `S0-26` (and `S0-29`) must include a two-tenant test proving Tenant B never receives Tenant A's cached access token under any sequence of calls or forged contexts.

## Alternatives Considered

- **SMTP AUTH to Exchange Online.** Rejected: Microsoft is retiring it, and it relies on passwords.
- **A third-party email provider now.** Not now: it adds another data processor before one is needed. Revisit it for the hosted service.
- **Tenant-wide Graph Mail.Send.** Rejected: it would allow sending as any mailbox in the tenant.

## Consequences

- Demo and pilot email passes through 1Squared's Microsoft 365 tenant. Before this is turned on for a pilot holding real firm data, the data processing terms must cover it.
- Some setup must be done by hand: the shared mailbox, the app registration, the Exchange RBAC scope, and SPF, DKIM and DMARC. That blocks the live Graph adapter, but not the interface or the dev catcher.
- Enquiry email, quote sending and credit-control reminders are connected to the interface in stage 1.
