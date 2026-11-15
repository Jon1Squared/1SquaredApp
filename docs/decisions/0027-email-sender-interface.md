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
     - `recipients_json JSONB NOT NULL` (`to`, `cc`, `bcc` addresses)
     - `subject TEXT NOT NULL`
     - `html_body TEXT NOT NULL`
     - `text_body TEXT NOT NULL`
     - `attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb` (tenant blob storage keys + metadata, resolved via `TenantBlobStorage.getReadStream` at send time after `assertTenantOwnsBlobKey`)
     - `status TEXT NOT NULL DEFAULT 'pending'` (`'pending' | 'sending' | 'sent' | 'dropped_allowlist' | 'failed_permanent'`)
     - `attempt_count INTEGER NOT NULL DEFAULT 0`
     - `next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
     - `sent_at TIMESTAMPTZ NULL`
     - `provider_message_id TEXT NULL`
     - `last_error_code TEXT NULL`
     - `created_by_person_id TEXT NULL`
     - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
     - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
2. **Enqueuing in the domain transaction:**
   - Any server action (`sendEnquiryEmailAction`, `sendQuoteEmailAction`, `sendCreditControlReminderAction`, etc.) or background job (`notification-digests`) inserts a row into `public.email_outbox` (with a deterministic `idempotency_key`) and writes an `audit_entries` row (`action = 'email-queued'`) inside the **same `withTenantTransaction` call** as the domain state update.
3. **Non-live `recipientAllowList` enforced in core before any adapter runs:**
   - Before invoking `dev_catcher`, `graph`, or `acs`, the core dispatcher checks `environment !== 'live'`.
   - In any non-live environment, `integrations.email.recipientAllowList` must be non-empty (enforced both by schema/config validation and at runtime). Any recipient address (case-insensitive) not in `recipientAllowList` is stripped before the adapter is called, and an `audit_entries` row (`action = 'email-recipient-dropped-allowlist'`, recording the dropped count and `correlationId` — never the email address) is written. If no allowed recipients remain, the outbox row is marked `status = 'dropped_allowlist'` and no adapter is called.
4. **Post-commit drain + scheduled retry job (`email-outbox-drain`):**
   - Interactive actions trigger a best-effort post-commit drain immediately after `withTenantTransaction` commits, claiming the newly created outbox row with `SELECT ... FOR UPDATE SKIP LOCKED` so normal interactive sends complete with near-zero latency.
   - If the process crashes after commit or Microsoft Graph returns a transient error (`429`, `5xx`, or network timeout), the outbox row remains `'pending'` with exponential backoff in `next_attempt_at`.
   - A tenant-scoped background job `email-outbox-drain` (`guardedJob('email-outbox-drain', ...)` with job-only permission `'email:drain_outbox'`, `jobOnly: true`, obeying all [ADR 0030](./0030-background-job-runner.md) rules) sweeps due `'pending'` rows (`attempt_count < 5`, `next_attempt_at <= NOW()`) and delivers them.
   - On completion, `audit_entries` records `action = 'email-sent'` or `'email-send-failed'` with `outboxId`, `templateKey`, `recipientCount`, `provider`, and `correlationId` — never recipient addresses, subject lines, or bodies (Rule 5).

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
2. **Key Vault retrieval and JWT client assertion (`RS256`):**
   - When a certificate is imported into Azure Key Vault (`az keyvault certificate import`), Key Vault exposes the certificate bundle (private key + X.509 certificate in PEM/PKCS#12 form) as a Key Vault **secret** with the same name (`kv://<vault-name>/<cert-name>`).
   - At send time, the Graph adapter fetches the secret value via `@azure/keyvault-secrets` (`SecretClient` authenticated with `DefaultAzureCredential` / managed identity `runtimeIdentity`), parses the private key using Node's built-in `node:crypto` (`createPrivateKey`), verifies that the certificate's SHA-1 thumbprint matches `certificateThumbprint`, and signs a short-lived RFC 7523 `client_assertion` JWT (`alg: 'RS256'`, `x5t` header derived from `certificateThumbprint`, `aud: 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token'`, `iss: clientId`, `sub: clientId`, 5-minute lifetime, unique `jti`).
   - It exchanges the `client_assertion` for an app-only Graph access token (`scope = 'https://graph.microsoft.com/.default'`) and calls `POST https://graph.microsoft.com/v1.0/users/{encodeURIComponent(senderAddress)}/sendMail` with `saveToSentItems: false`.
   - Neither the private key nor the access token is ever stored in a module-level or process-level map across requests without keying by `(tenantId, clientId, certificateThumbprint)` and strict short TTL, and neither is ever written to logs, errors, or audit rows.

## Alternatives Considered

- **SMTP AUTH to Exchange Online.** Rejected: Microsoft is retiring it, and it relies on passwords.
- **A third-party email provider now.** Not now: it adds another data processor before one is needed. Revisit it for the hosted service.
- **Tenant-wide Graph Mail.Send.** Rejected: it would allow sending as any mailbox in the tenant.

## Consequences

- Demo and pilot email passes through 1Squared's Microsoft 365 tenant. Before this is turned on for a pilot holding real firm data, the data processing terms must cover it.
- Some setup must be done by hand: the shared mailbox, the app registration, the Exchange RBAC scope, and SPF, DKIM and DMARC. That blocks the live Graph adapter, but not the interface or the dev catcher.
- Enquiry email, quote sending and credit-control reminders are connected to the interface in stage 1.
