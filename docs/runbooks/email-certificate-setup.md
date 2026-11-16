# Email Certificate & Allow-List Setup Runbook (`S0-26`)

This runbook covers the operational setup required to enable live Microsoft Graph outbound email delivery for 1Squared (`integrations.email.provider = "graph"`), using the application-only certificate model defined in [ADR 0027](../decisions/0027-email-sender-interface.md).

All demo tenant Key Vault references in `client-not-a-law-firm/config/environments/demo.json` resolve to the deployed Azure Key Vault **`kvnotalawfi2cdo3cw7vuafm`** (`https://kvnotalawfi2cdo3cw7vuafm.vault.azure.net/`).

## 1. Completed Owner Setup (12–16 November 2026)

The following shared mail, Entra ID, and demo Key Vault prerequisites have already been completed for the `1squared.co.uk` domain:

| Item | Value / Scope | Status |
| :--- | :--- | :--- |
| **Shared sender mailbox** | `notifications@1squared.co.uk` | **Done (12 November 2026)** |
| **Microsoft Entra application registration** | Client ID `fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1` in directory `f8218d9a-e055-463f-add2-f03679aad7f2` | **Done (12 November 2026)** |
| **Exchange Online RBAC for Applications** | `Mail.Send` application access scoped strictly to `notifications@1squared.co.uk` | **Done (12 November 2026)** |
| **Sender domain DNS records** | SPF, DKIM, and DMARC configured for `1squared.co.uk` | **Done (12 November 2026)** |
| **Key Vault certificate & Entra `.cer` upload** | Generated inside `kvnotalawfi2cdo3cw7vuafm` as `graph-mail-certificate` (`kv://kvnotalawfi2cdo3cw7vuafm/graph-mail-certificate`), SHA-1 thumbprint **`BC9CB621EF3BDC2413D3EA345609586ABF5167ED`**, public `.cer` uploaded to app `fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1` | **Done (16 November 2026)** |

> [!NOTE]
> Importing a PFX exported from Windows into Azure Key Vault failed even when exported with `TripleDES_SHA1`. Generating the certificate directly inside Key Vault (`az keyvault certificate create`) avoids PFX import errors altogether. `GraphAppTokenProvider` natively parses both Key Vault's default base64 passwordless PKCS#12 secret (`application/x-pkcs12`) and PEM bundles, verifies the SHA-1 thumbprint against `integrations.email.graph.certificateThumbprint` (`BC9CB621EF3BDC2413D3EA345609586ABF5167ED`), signs an RFC 7523 `RS256` client assertion in memory with `x5t`, and discards key material immediately without caching it.

## 2. How the Certificate Was Generated Inside Key Vault (Reference / Rotation Procedure)

Use this exact procedure when rotating `graph-mail-certificate` or provisioning a new tenant environment:

1. **Confirm RBAC role assignment:** The operator must hold **Key Vault Certificates Officer** on `kvnotalawfi2cdo3cw7vuafm` (and **Key Vault Secrets Officer** to manage allow-list secrets). Confirm the web app and jobs User-Assigned Managed Identity (`id-runtime-<slug>-<env>`) holds **Key Vault Secrets User** on the vault (`core/infra/modules/tenant.bicep`).
2. **Temporarily open the Key Vault firewall to one IP address:** The vault has public network access disabled by default. Allow only your current public IP while running Azure CLI commands:
   ```bash
   MY_IP=$(curl -s https://api.ipify.org)
   az keyvault update \
     --name "kvnotalawfi2cdo3cw7vuafm" \
     --public-network-access Enabled \
     --default-action Deny
   az keyvault network-rule add \
     --name "kvnotalawfi2cdo3cw7vuafm" \
     --ip-address "${MY_IP}/32"
   ```
3. **Generate the certificate inside Key Vault using the default policy with the subject changed and the key exportable:**
   ```bash
   az keyvault certificate get-default-policy > policy.json
   # Edit policy.json:
   # - set x509CertificateProperties.subject (for example "CN=graph-mail.1squared.co.uk")
   # - set keyProperties.exportable to true
   az keyvault certificate create \
     --vault-name "kvnotalawfi2cdo3cw7vuafm" \
     --name "graph-mail-certificate" \
     --policy @policy.json
   ```
   (Key Vault's default policy uses `contentType: "application/x-pkcs12"`, which `GraphAppTokenProvider` reads automatically from `kv://kvnotalawfi2cdo3cw7vuafm/graph-mail-certificate`.)
4. **Download the `.cer` and upload it to Microsoft Entra:**
   ```bash
   az keyvault certificate download \
     --vault-name "kvnotalawfi2cdo3cw7vuafm" \
     --name "graph-mail-certificate" \
     --file "graph-mail-certificate.cer" \
     --encoding DER
   ```
   Upload `graph-mail-certificate.cer` to Entra app registration `fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1` under **Certificates & secrets -> Certificates**, confirm its SHA-1 thumbprint matches `integrations.email.graph.certificateThumbprint` (`BC9CB621EF3BDC2413D3EA345609586ABF5167ED`), and remove local temporary `policy.json` / `.cer` files.
5. **Close the Key Vault firewall again and verify it shows `Disabled`:**
   ```bash
   az keyvault network-rule remove \
     --name "kvnotalawfi2cdo3cw7vuafm" \
     --ip-address "${MY_IP}/32"
   az keyvault update \
     --name "kvnotalawfi2cdo3cw7vuafm" \
     --public-network-access Disabled
   az keyvault show \
     --name "kvnotalawfi2cdo3cw7vuafm" \
     --query properties.publicNetworkAccess -o tsv
   ```
   Confirm the final command outputs **`Disabled`**.

## 3. Remaining Blocker: Populate `email-recipient-allowlist` While the Vault Is Open

In every non-live environment (`dev`, `test`, `training`, `demo`), `evaluateEmailAllowList` fails closed if `recipientAllowListVaultRef` is configured and unreadable, or if any recipient in `to`, `cc`, or `bcc` falls outside the combined allow-list.

Until the allow-list secret is set and live sending is verified, `client-not-a-law-firm/config/environments/demo.json` keeps `"provider": "disabled"` (while carrying `"keyVault": { "vaultName": "kvnotalawfi2cdo3cw7vuafm", "vaultUri": "https://kvnotalawfi2cdo3cw7vuafm.vault.azure.net/" }` and static `@1squared.co.uk` / `@notalawfirm.example` domain suffixes).

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

```bash
cat <<'EOF' > email-allowlist.txt
alex.morgan@notalawfirm.example
priya.patel@notalawfirm.example
@notalawfirm.example
EOF

az keyvault secret set \
  --vault-name "kvnotalawfi2cdo3cw7vuafm" \
  --name "email-recipient-allowlist" \
  --file "email-allowlist.txt"

rm email-allowlist.txt
```

## 4. Enable `graph` in the Environment Overlay After the Live Check

Keep `integrations.email.provider = "disabled"` in `client-not-a-law-firm/config/environments/demo.json` until `email-recipient-allowlist` is populated and live Graph send is checked:

1. Ensure `integrations.email.senderAddress` is set to the provisioned mailbox (`notifications@1squared.co.uk` in the live demo deployment config overlay — keep RFC 2606 `@notalawfirm.example` in git config fixtures checked by `verify-invented-fixtures.mjs`).
2. Perform a live verification send to an allow-listed test recipient, checking `caj-outbox-drain-demo` logs for `outbox.delivery.sent` (and confirming non-allow-listed addresses stop with `status = 'dropped_allowlist'`).
3. Once verified, change `integrations.email.provider` from `"disabled"` to `"graph"` and deploy the updated configuration.
4. Confirm permanent failures (`attempt_count = 5`) raise an alert via Azure Monitor (`outbox.delivery.failed_permanent`).

## 5. Local `dev_catcher` Verification (Development & Test)

For local development or Mailpit testing without Azure Key Vault or Microsoft Graph:

1. Start a local SMTP catcher (for example Mailpit on `127.0.0.1:1025`).
2. Configure `integrations.email.provider = "dev_catcher"` with `devCatcher: { host: "127.0.0.1", port: 1025, secure: false }` and a non-empty non-live `recipientAllowList` (for example `["@notalawfirm.example"]`).
3. `dev_catcher` is strictly forbidden when `environment === "live"` (`EMAIL_DEV_CATCHER_FORBIDDEN_IN_LIVE`).

## 6. Retention Scrubbing & Operational Diagnostics

- Terminal outbox rows (`sent`, `dropped_allowlist`, `failed_permanent`) are automatically scrubbed by `outbox-drain` once `sent_at` (or terminal `updated_at`) is older than `integrations.email.outboxContentRetentionDays` (default `30` days).
- Scrubbing clears `recipients_json`, `subject`, `html_body`, `text_body`, and `attachments_json`, sets `content_scrubbed_at`, and records a PII-free audit entry (`email-outbox-content-scrubbed`).
- **Common error codes:**
  - `GRAPH_CERT_THUMBPRINT_MISMATCH`: Key Vault certificate does not match `integrations.email.graph.certificateThumbprint` (`BC9CB621EF3BDC2413D3EA345609586ABF5167ED`). Confirm the certificate version in `kvnotalawfi2cdo3cw7vuafm` matches the `.cer` uploaded to Entra app `fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1`.
  - `TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED`: `certificateVaultRef` or `recipientAllowListVaultRef` points to another tenant's or environment's Key Vault instead of `kvnotalawfi2cdo3cw7vuafm`.
  - `EMAIL_ALLOWLIST_VAULT_UNREADABLE`: `recipientAllowListVaultRef` secret is missing or `id-runtime-*` lacks `Key Vault Secrets User`.
  - `EMAIL_PROVIDER_NOT_IMPLEMENTED`: `integrations.email.provider` is set to `"acs"` (deferred placeholder until Stage 1).
