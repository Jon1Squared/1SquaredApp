# Email Certificate & Allow-List Setup Runbook (`S0-26`)

This runbook covers the operational setup required to enable live Microsoft Graph outbound email delivery for 1Squared (`integrations.email.provider = "graph"`), using the application-only certificate model defined in [ADR 0027](../decisions/0027-email-sender-interface.md).

## 1. Completed Owner Setup (12 November 2026)

The following shared mail and Microsoft Entra prerequisites have already been completed for the `1squared.co.uk` domain:

| Item | Value / Scope | Status |
| :--- | :--- | :--- |
| **Shared sender mailbox** | `notifications@1squared.co.uk` | **Done (12 November 2026)** |
| **Microsoft Entra application registration** | Client ID `fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1` in directory `f8218d9a-e055-463f-add2-f03679aad7f2` | **Done (12 November 2026)** |
| **Exchange Online RBAC for Applications** | `Mail.Send` application access scoped strictly to `notifications@1squared.co.uk` | **Done (12 November 2026)** |
| **Public key thumbprint registered on Entra app** | `B738D511CEF82CF63670CF540571CE03A1AB53E4` (SHA-1 hex) | **Done (12 November 2026)** |
| **Sender domain DNS records** | SPF, DKIM, and DMARC configured for `1squared.co.uk` | **Done (12 November 2026)** |

## 2. Remaining Manual Blocker Before Enabling Live Graph Send

Until the client certificate secret and non-live allow-list secret are imported into the tenant Azure Key Vault, `client-not-a-law-firm/config/environments/demo.json` keeps `"provider": "disabled"` (while carrying the non-secret Entra client ID, directory ID, Key Vault references, thumbprint, and static `@1squared.co.uk` / `@notalawfirm.example` allow-list suffixes).

### Step A: Prepare and Import the Client Certificate Secret (`graph-email-client-cert`)

`GraphAppTokenProvider` verifies the X.509 SHA-1 thumbprint against `integrations.email.graph.certificateThumbprint` (`B738D511CEF82CF63670CF540571CE03A1AB53E4`), signs an RFC 7523 `RS256` client assertion in memory with `x5t`, and discards the key material immediately without caching or writing it to disk.

1. Convert the PFX certificate exported for thumbprint `B738D511CEF82CF63670CF540571CE03A1AB53E4` into a PEM bundle in memory or on a secure workstation, verify its SHA-1 fingerprint matches `B738D511CEF82CF63670CF540571CE03A1AB53E4`, and delete any local temporary `.pem` file after upload:
   ```bash
   openssl pkcs12 -in graph-email.pfx -nodes -out graph-email.pem
   openssl x509 -in graph-email.pem -noout -fingerprint -sha1
   ```
2. Import the PEM bundle into the target **tenant** Azure Key Vault (for demo, `<vault>` matching `keyVault.vaultName` / `kv-notalawfirm-demo`) under secret name `graph-email-client-cert`:
   ```bash
   az keyvault secret set \
     --vault-name "<tenant-key-vault-name>" \
     --name "graph-email-client-cert" \
     --file "graph-email.pem"
   ```
3. Confirm the web app and jobs User-Assigned Managed Identity (`id-runtime-<slug>-<env>`) holds the `Key Vault Secrets User` RBAC role on that tenant Key Vault (`core/infra/modules/tenant.bicep`).

### Step B: Populate the Non-Live Allow-List Secret (`email-recipient-allowlist`)

In every non-live environment (`dev`, `test`, `training`, `demo`), `evaluateEmailAllowList` fails closed if `recipientAllowListVaultRef` is configured and unreadable, or if any recipient in `to`, `cc`, or `bcc` falls outside the combined allow-list.

1. Store permitted pilot tester email addresses as a JSON array (recommended) or newline-separated string inside the tenant Key Vault secret named `email-recipient-allowlist` (so personal email addresses never live in git):
   ```bash
   az keyvault secret set \
     --vault-name "<tenant-key-vault-name>" \
     --name "email-recipient-allowlist" \
     --value '["tester.one@example.invalid","@1squared.co.uk"]'
   ```
2. Note: individual test email addresses belong **only** in Key Vault; git configuration files (`base.json`, `demo.json`) store `@domain` suffixes (`"@1squared.co.uk"`, `"@notalawfirm.example"`) and `kv://` secret references only.

### Step C: Enable `graph` in the Environment Overlay & Verify

1. Set `integrations.email.senderAddress` to the provisioned mailbox (`notifications@1squared.co.uk` in the live pilot/demo config package outside client-fixture synthetic checks) and change `integrations.email.provider` from `"disabled"` to `"graph"`.
2. Deploy or trigger the scheduled `caj-outbox-drain-<env>` job (`node dist/jobs/run-job.mjs outbox-drain`) and confirm:
   - Emails to allow-listed recipients are delivered with telemetry event `outbox.delivery.sent` (with no email addresses, subjects, or bodies logged).
   - Emails to non-allow-listed addresses are blocked with `status = 'dropped_allowlist'` before any Microsoft Graph HTTP call is made.
   - Permanent failures (`attempt_count = 5`) raise an alert via Azure Monitor (`outbox.delivery.failed_permanent`).

## 3. Local `dev_catcher` Verification (Development & Test)

For local development or Mailpit testing without Azure Key Vault or Microsoft Graph:

1. Start a local SMTP catcher (for example Mailpit on `127.0.0.1:1025`).
2. Configure `integrations.email.provider = "dev_catcher"` with `devCatcher: { host: "127.0.0.1", port: 1025, secure: false }` and a non-empty non-live `recipientAllowList` (for example `["@notalawfirm.example"]`).
3. `dev_catcher` is strictly forbidden when `environment === "live"` (`EMAIL_DEV_CATCHER_FORBIDDEN_IN_LIVE`).

## 4. Retention Scrubbing & Operational Diagnostics

- Terminal outbox rows (`sent`, `dropped_allowlist`, `failed_permanent`) are automatically scrubbed by `outbox-drain` once `sent_at` (or terminal `updated_at`) is older than `integrations.email.outboxContentRetentionDays` (default `30` days).
- Scrubbing clears `recipients_json`, `subject`, `html_body`, `text_body`, and `attachments_json`, sets `content_scrubbed_at`, and records a PII-free audit entry (`email-outbox-content-scrubbed`).
- **Common error codes:**
  - `GRAPH_CERT_THUMBPRINT_MISMATCH`: Key Vault certificate does not match `integrations.email.graph.certificateThumbprint`. Re-import the matching PEM bundle.
  - `TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED`: `certificateVaultRef` or `recipientAllowListVaultRef` points to another tenant's or environment's Key Vault.
  - `EMAIL_ALLOWLIST_VAULT_UNREADABLE`: `recipientAllowListVaultRef` secret is missing or `id-runtime-*` lacks `Key Vault Secrets User`.
  - `EMAIL_PROVIDER_NOT_IMPLEMENTED`: `integrations.email.provider` is set to `"acs"` (deferred placeholder until Stage 1).
