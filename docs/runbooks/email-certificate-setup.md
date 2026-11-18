# Email Certificate & Allow-List Setup Runbook (`S0-26`)

This runbook covers the operational setup required to enable live Microsoft Graph outbound email delivery for 1Squared (`integrations.email.provider = "graph"`), using the application-only certificate model defined in [ADR 0027](../decisions/0027-email-sender-interface.md).

All demo tenant Key Vault references in `client-not-a-law-firm/config/environments/demo.json` resolve to the deployed Azure Key Vault **`kvnotalawfi2cdo3cw7vuafm`** (`https://kvnotalawfi2cdo3cw7vuafm.vault.azure.net/`).

## 1. Completed Owner Setup (`12–16 November 2026`)

| Item | Value / Scope | Status |
| :--- | :--- | :--- |
| **Shared sender mailbox** | `notifications@1squared.co.uk` | **Done (12 November 2026)** |
| **Microsoft Entra application registration** | Client ID `fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1` in directory `f8218d9a-e055-463f-add2-f03679aad7f2` | **Done (12 November 2026)** |
| **Exchange Online RBAC for Applications** | `Mail.Send` application access scoped strictly to `notifications@1squared.co.uk` | **Done (12 November 2026)** |
| **Sender domain DNS records** | SPF, DKIM, and DMARC configured for `1squared.co.uk` | **Done (12 November 2026)** |
| **Key Vault `graph-mail-certificate` PEM version (`R500`)** | New PEM version (`secretProperties.contentType = "application/x-pem-file"`) generated inside `kvnotalawfi2cdo3cw7vuafm` with SHA-1 thumbprint **`C5428D7F519AE513A5B8CE027D291876CEDA40D3`**; `.cer` uploaded to `fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1` and retired thumbprint removed | **Done (16 November 2026)** |
| **Allow-list secret (`email-recipient-allowlist`)** | `kv://kvnotalawfi2cdo3cw7vuafm/email-recipient-allowlist` created in `kvnotalawfi2cdo3cw7vuafm` | **Done (16 November 2026)** |

> [!NOTE]
> Importing a PFX exported from Windows into Azure Key Vault failed even when exported with `TripleDES_SHA1`. Generating the certificate directly inside Key Vault (`az keyvault certificate create`) avoids PFX import issues, provided the policy explicitly sets `secretProperties.contentType = "application/x-pem-file"`.
>
> Per architecture security review `R500`, `GraphAppTokenProvider` only accepts unencrypted PEM bundles parsed natively by Node's `X509Certificate` and `createPrivateKey`, and rejects `application/x-pkcs12` or non-PEM secrets with `GRAPH_CERT_FORMAT_UNSUPPORTED`.

## 2. How to Generate a PEM Certificate Inside Key Vault

Use this exact procedure when generating or rotating `graph-mail-certificate` (or provisioning a new tenant environment):

1. **Confirm RBAC role assignment:** The operator must hold **Key Vault Certificates Officer** on `kvnotalawfi2cdo3cw7vuafm` (and **Key Vault Secrets Officer** to manage allow-list secrets). Confirm the web app and jobs User-Assigned Managed Identity (`id-runtime-<slug>-<env>`) holds **Key Vault Secrets User** on the vault (`core/infra/modules/tenant.bicep`).
2. **Temporarily open the Key Vault firewall to one IP address:** The vault has public network access disabled by default. Allow only your current public IP while running Azure CLI commands:
   ```powershell
   $MY_IP = (Invoke-RestMethod https://api.ipify.org).Trim()
   az keyvault update `
     --name "kvnotalawfi2cdo3cw7vuafm" `
     --public-network-access Enabled `
     --default-action Deny
   az keyvault network-rule add `
     --name "kvnotalawfi2cdo3cw7vuafm" `
     --ip-address "$MY_IP/32"
   ```
3. **Generate the certificate inside Key Vault using the default policy with `contentType = 'application/x-pem-file'`, the subject changed, and the key exportable:**
   ```powershell
   $p = az keyvault certificate get-default-policy | ConvertFrom-Json
   $p.x509CertificateProperties.subject = 'CN=graph-mail.1squared.co.uk'
   $p.keyProperties.exportable = $true
   $p.secretProperties.contentType = 'application/x-pem-file'
   $p | ConvertTo-Json -Depth 10 | Set-Content -Path policy.json -Encoding utf8

   az keyvault certificate create `
     --vault-name "kvnotalawfi2cdo3cw7vuafm" `
     --name "graph-mail-certificate" `
     --policy "@policy.json"
   ```
   Setting `$p.secretProperties.contentType = 'application/x-pem-file'` causes Key Vault to store both the private key and certificate in PEM format inside the backing secret `kv://kvnotalawfi2cdo3cw7vuafm/graph-mail-certificate`.
4. **Download the `.cer` and upload it to Microsoft Entra:**
   ```powershell
   az keyvault certificate download `
     --vault-name "kvnotalawfi2cdo3cw7vuafm" `
     --name "graph-mail-certificate" `
     --file "graph-mail-certificate.cer" `
     --encoding DER

   az keyvault certificate show `
     --vault-name "kvnotalawfi2cdo3cw7vuafm" `
     --name "graph-mail-certificate" `
     --query "x509Thumbprint" -o tsv
   ```
   Upload `graph-mail-certificate.cer` to Entra app registration `fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1` under **Certificates & secrets -> Certificates**, note the 40-character uppercase SHA-1 hex thumbprint, and delete local temporary files (`policy.json`, `graph-mail-certificate.cer`).
5. **Close the Key Vault firewall again and verify it shows `Disabled`:**
   ```powershell
   az keyvault network-rule remove `
     --name "kvnotalawfi2cdo3cw7vuafm" `
     --ip-address "$MY_IP/32"
   az keyvault update `
     --name "kvnotalawfi2cdo3cw7vuafm" `
     --public-network-access Disabled
   az keyvault show `
     --name "kvnotalawfi2cdo3cw7vuafm" `
     --query properties.publicNetworkAccess -o tsv
   ```
   Confirm the final command outputs **`Disabled`**.

## 3. Initial PKCS#12 Replacement History (`R500`, Completed)

The initial `graph-mail-certificate` version used Key Vault's default `application/x-pkcs12` content type. On 16 November 2026 the owner generated a PEM version (`$p.secretProperties.contentType = 'application/x-pem-file'`, thumbprint `C5428D7F519AE513A5B8CE027D291876CEDA40D3`), uploaded its `.cer` to Entra app `fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1`, removed the retired initial certificate from Entra, and updated `integrations.email.graph.certificateThumbprint` in `client-not-a-law-firm/config/environments/demo.json`.

## 4. Non-Live Allow-List Secret Format (`email-recipient-allowlist`)

In every non-live environment (`dev`, `test`, `training`, `demo`), `evaluateEmailAllowList` fails closed if `recipientAllowListVaultRef` is configured and unreadable, or if any recipient in `to`, `cc`, or `bcc` falls outside the combined allow-list.

`email-recipient-allowlist` was created in `kvnotalawfi2cdo3cw7vuafm` on **16 November 2026**. Following live post-deploy verification on **18 November 2026**, `client-not-a-law-firm/config/environments/demo.json` permanently enables `"provider": "graph"`, sets `"senderAddress": "notifications@1squared.co.uk"`, and restricts static `recipientAllowList` to `["@1squared.co.uk"]` (combined with `email-recipient-allowlist`).

### Exact Secret Name & Format (`email-recipient-allowlist`)

- **Key Vault:** `kvnotalawfi2cdo3cw7vuafm`
- **Secret name:** `email-recipient-allowlist` (`kv://kvnotalawfi2cdo3cw7vuafm/email-recipient-allowlist`)
- **Format:** Plain UTF-8 text containing **one lower-case email address or `@domain` suffix per line** (LF or CRLF line endings; blank lines are ignored). A JSON string array (e.g. `["alex.morgan@notalawfirm.example","@notalawfirm.example"]`) or comma/semicolon-separated list is also accepted by `parseVaultAllowListEntries`, because individual tester addresses must never live in git.

**Invented example value:**

```text
alex.morgan@notalawfirm.example
priya.patel@notalawfirm.example
@notalawfirm.example
```

Set the secret while your IP firewall rule is temporarily open, then close the vault back to `Disabled` as in Section 2 Step 5:

```powershell
@"
alex.morgan@notalawfirm.example
priya.patel@notalawfirm.example
@notalawfirm.example
"@ | Set-Content -Path email-allowlist.txt -Encoding utf8

az keyvault secret set `
  --vault-name "kvnotalawfi2cdo3cw7vuafm" `
  --name "email-recipient-allowlist" `
  --file "email-allowlist.txt"

Remove-Item email-allowlist.txt
```

## 5. Active `graph` Configuration & Post-Deploy Verification (`Done`)

`client-not-a-law-firm/config/environments/demo.json` has `integrations.email.provider = "graph"` enabled with `senderAddress = "notifications@1squared.co.uk"` (matching the scoped Exchange Online RBAC mailbox):

1. Confirm `integrations.email.graph.certificateThumbprint` is `C5428D7F519AE513A5B8CE027D291876CEDA40D3` and `recipientAllowList` is `["@1squared.co.uk"]` alongside `email-recipient-allowlist` (`kv://kvnotalawfi2cdo3cw7vuafm/email-recipient-allowlist`).
2. When triggering test notifications via `caj-outbox-drain-demo`, allow-listed `@1squared.co.uk` / Key Vault recipients log `outbox.delivery.sent` whilst seeded `@notalawfirm.example` personas stop safely at `status = 'dropped_allowlist'`.
3. Confirm permanent failures (`attempt_count = 5`) raise an alert via Azure Monitor (`outbox.delivery.failed_permanent`).

## 6. Local `dev_catcher` Verification (Development & Test)

For local development or Mailpit testing without Azure Key Vault or Microsoft Graph:

1. Start a local SMTP catcher (for example Mailpit on `127.0.0.1:1025`).
2. Configure `integrations.email.provider = "dev_catcher"` with `devCatcher: { host: "127.0.0.1", port: 1025, secure: false }` and a non-empty non-live `recipientAllowList` (for example `["@notalawfirm.example"]`).
3. `dev_catcher` is strictly forbidden when `environment === "live"` (`EMAIL_DEV_CATCHER_FORBIDDEN_IN_LIVE`).

## 7. Retention Scrubbing & Operational Diagnostics

- Terminal outbox rows (`sent`, `dropped_allowlist`, `failed_permanent`) are automatically scrubbed by `outbox-drain` once `sent_at` (or terminal `updated_at`) is older than `integrations.email.outboxContentRetentionDays` (default `30` days).
- Scrubbing clears `recipients_json`, `subject`, `html_body`, `text_body`, and `attachments_json`, sets `content_scrubbed_at`, and records a PII-free audit entry (`email-outbox-content-scrubbed`).
- **Common error codes:**
  - `GRAPH_CERT_FORMAT_UNSUPPORTED`: Key Vault certificate secret is PKCS#12 (`application/x-pkcs12`), encrypted, or otherwise not an unencrypted PEM bundle (`application/x-pem-file`). Create a new certificate version with `$p.secretProperties.contentType = 'application/x-pem-file'`.
  - `GRAPH_CERT_THUMBPRINT_MISMATCH`: Key Vault certificate does not match `integrations.email.graph.certificateThumbprint`. Confirm the certificate version in `kvnotalawfi2cdo3cw7vuafm` matches the `.cer` uploaded to Entra app `fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1`.
  - `TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED`: `certificateVaultRef` or `recipientAllowListVaultRef` points to another tenant's or environment's Key Vault instead of `kvnotalawfi2cdo3cw7vuafm`.
  - `EMAIL_ALLOWLIST_VAULT_UNREADABLE`: `recipientAllowListVaultRef` secret is missing or `id-runtime-*` lacks `Key Vault Secrets User`.
  - `EMAIL_PROVIDER_NOT_IMPLEMENTED`: `integrations.email.provider` is set to `"acs"` (deferred placeholder until Stage 1).
