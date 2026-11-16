# Microsoft Teams Activity Feed & App Package Setup Runbook (`S0-29`)

This runbook covers the operational setup required to enable live Microsoft Teams Activity Feed delivery for 1Squared (`integrations.teams.provider = "graph"`), using the redacted activity model defined in [ADR 0035](../decisions/0035-digests-and-teams-delivery.md).

All demo tenant Key Vault references in `client-not-a-law-firm/config/environments/demo.json` resolve to the deployed Azure Key Vault **`kvnotalawfi2cdo3cw7vuafm`** (`https://kvnotalawfi2cdo3cw7vuafm.vault.azure.net/`).

## 1. Completed Microsoft Entra, Teams Admin & Key Vault Prerequisites (`16 November 2026`)

| Item | Value / Scope | Status |
| :--- | :--- | :--- |
| **Microsoft Entra application & Teams App ID** | `76474047-ac1f-49ee-83f3-5a2a58c2b3f8` in directory `f8218d9a-e055-463f-add2-f03679aad7f2` | **Done** |
| **Microsoft Graph application permission** | `TeamsActivity.Send` granted with tenant administrator consent (`User.Read` has been removed) | **Done** |
| **Teams app package manifest & icons** | `core/integrations/teams/app-package/` (`manifest.json` schema `1.16`, `color.png` 192×192, `outline.png` 32×32) | **Done** |
| **Teams Admin Center upload & Setup Policy** | `onesquared-teams-app.zip` uploaded and allowed in Teams Admin Center; App Setup Policy assigned to the demo users | **Done (16 November 2026)** |
| **Key Vault `graph-teams-client-cert` PEM certificate** | Generated inside `kvnotalawfi2cdo3cw7vuafm` with `secretProperties.contentType = "application/x-pem-file"`, SHA-1 thumbprint **`6A23E571EA3F43D1DB39C187A201B40454159D3B`**, `.cer` uploaded to `76474047-ac1f-49ee-83f3-5a2a58c2b3f8` | **Done (16 November 2026)** |
| **Allow-list secret (`teams-recipient-allowlist`)** | `kv://kvnotalawfi2cdo3cw7vuafm/teams-recipient-allowlist` created in `kvnotalawfi2cdo3cw7vuafm` | **Done (16 November 2026)** |

> [!NOTE]
> Confidential matter titles, client names, email addresses, and free-text notes never leave the platform boundary. `CoreTeamsNotifier` strips or rejects confidential fields before sending only built-in redacted `activityType` events (defined in `core/integrations/teams/app-package/manifest.json`) to bound internal users (`Person.entraObjectId` from PostgreSQL).

## 2. Build the Ready-to-Upload Teams App Package

Build the Teams app archive (`manifest.json`, `color.png`, and `outline.png` at the ZIP root):

```bash
npm run teams:package
```

This writes `dist/teams-app/onesquared-teams-app.zip`.

## 3. Enable Custom Apps & Upload the Package in Microsoft Teams Admin Center

Graph `sendActivityNotification` only delivers notifications to users for whom the 1Squared Teams app is installed in their Microsoft Teams client.

1. **Enable custom apps (org-wide setting):**
   - Sign in to the **Microsoft Teams Admin Center** (`https://admin.teams.microsoft.com`) as a Teams Administrator.
   - Navigate to **Teams apps -> Manage apps -> Actions -> Org-wide app settings**.
   - Ensure **Custom apps** -> **Let users interact with custom apps in preview** / **Upload custom apps** (as applicable in the tenant) is enabled, and save any change.
2. **Upload `onesquared-teams-app.zip`:**
   - Still in **Teams apps -> Manage apps**, select **Actions -> Upload new app** -> **Upload**.
   - Upload `dist/teams-app/onesquared-teams-app.zip` and confirm its status is **Allowed** in the app catalogue.
   - Inspect the app's detail page in the Teams Admin Center and verify its **App ID**. Notice that uploading a custom package via Teams Admin Center may either retain external ID `76474047-ac1f-49ee-83f3-5a2a58c2b3f8` or display a Teams catalogue app ID; if Microsoft Teams assigned a distinct catalogue app ID, update `integrations.teams.teamsAppId` in the demo overlay accordingly (keeping `integrations.teams.graph.clientId` as `76474047-ac1f-49ee-83f3-5a2a58c2b3f8`).
3. **Create or update an App Setup Policy for the demo users:**
   - Navigate to **Teams apps -> Setup policies**.
   - Edit an existing demo policy or select **+ Add** (for example `1Squared Demo Users`).
   - Under **Installed apps**, select **+ Add apps**, find **1Squared** (`76474047-ac1f-49ee-83f3-5a2a58c2b3f8`), and add it (optionally also add it to **Pinned apps** if desired).
   - Select **Manage users** -> **Assign users** and assign all 8 demo personas (`entra-map.local.json` / demo Entra test accounts), or verify they receive the Global setup policy if assigned tenant-wide.

## 4. Generate `graph-teams-client-cert` Inside Key Vault (`kvnotalawfi2cdo3cw7vuafm`)

> [!IMPORTANT]
> Generating a Windows `.pfx` and importing it into Azure Key Vault failed for the mail app even when using `TripleDES_SHA1`. Generate the Teams client certificate **directly inside Azure Key Vault** with `secretProperties.contentType = "application/x-pem-file"`, because `GraphAppTokenProvider` only accepts unencrypted PEM secrets and rejects `application/x-pkcs12` secrets with `GRAPH_CERT_FORMAT_UNSUPPORTED`.

1. **Confirm RBAC roles on the vault:**
   - You need **Key Vault Certificates Officer** (to create/download the certificate) and **Key Vault Secrets Officer** (to set `teams-recipient-allowlist`) on **`kvnotalawfi2cdo3cw7vuafm`**.
   - Confirm the runtime Managed Identity (`id-runtime-<slug>-<env>`) already holds **Key Vault Secrets User** on `kvnotalawfi2cdo3cw7vuafm`.
2. **Temporarily open `kvnotalawfi2cdo3cw7vuafm` to your single public IP address:**
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
3. **Generate `graph-teams-client-cert` using the default policy with `contentType = 'application/x-pem-file'`, the subject changed, and the key exportable:**
   ```powershell
   $p = az keyvault certificate get-default-policy | ConvertFrom-Json
   $p.x509CertificateProperties.subject = 'CN=graph-teams.1squared.co.uk'
   $p.keyProperties.exportable = $true
   $p.secretProperties.contentType = 'application/x-pem-file'
   $p | ConvertTo-Json -Depth 10 | Set-Content -Path teams-policy.json -Encoding utf8

   az keyvault certificate create `
     --vault-name "kvnotalawfi2cdo3cw7vuafm" `
     --name "graph-teams-client-cert" `
     --policy "@teams-policy.json"
   ```
   (Setting `$p.secretProperties.contentType = 'application/x-pem-file'` stores the backing private key and certificate in PEM format under `kv://kvnotalawfi2cdo3cw7vuafm/graph-teams-client-cert`, which `GraphAppTokenProvider` parses directly in memory with `X509Certificate` and `createPrivateKey` without any disk write.)
4. **Download `.cer`, upload it to Entra app `76474047-ac1f-49ee-83f3-5a2a58c2b3f8`, and record the thumbprint:**
   ```powershell
   az keyvault certificate download `
     --vault-name "kvnotalawfi2cdo3cw7vuafm" `
     --name "graph-teams-client-cert" `
     --file "graph-teams-client-cert.cer" `
     --encoding DER

   az keyvault certificate show `
     --vault-name "kvnotalawfi2cdo3cw7vuafm" `
     --name "graph-teams-client-cert" `
     --query "x509Thumbprint" -o tsv
   ```
   Upload `graph-teams-client-cert.cer` to Entra app registration **`76474047-ac1f-49ee-83f3-5a2a58c2b3f8`** under **Certificates & secrets -> Certificates**, note the 40-character uppercase SHA-1 hex thumbprint (`integrations.teams.graph.certificateThumbprint` in `demo.json`), and delete local temporary files (`teams-policy.json`, `graph-teams-client-cert.cer`).

## 5. Populate `teams-recipient-allowlist` While the Vault Is Open

In every non-live environment (`dev`, `test`, `training`, `demo`), `evaluateTeamsRecipientAllowList` fails closed if `recipientAllowListVaultRef` is unreadable or if a recipient falls outside the combined allow-list.

### Exact Secret Name & Format (`teams-recipient-allowlist`)

- **Key Vault:** `kvnotalawfi2cdo3cw7vuafm`
- **Secret name:** `teams-recipient-allowlist` (`kv://kvnotalawfi2cdo3cw7vuafm/teams-recipient-allowlist`)
- **Format:** Plain UTF-8 text containing **one `P-xxxxxx` person ID, verified lower-case email address, or `@domain` suffix per line** (LF or CRLF line endings; blank lines are ignored). A JSON string array (e.g. `["P-000001","@notalawfirm.example"]`) or comma/semicolon-separated list is also accepted by `parseVaultAllowListEntries`.
- **Important (`R491`):** Never place Microsoft Entra Object IDs (`oid`) in configuration or Key Vault allow-list entries — `CoreTeamsNotifier` only trusts `entraObjectId` stored on the bound `Person` row in PostgreSQL.

**Invented example value:**

```text
P-000001
alex.morgan@notalawfirm.example
@notalawfirm.example
```

Set the secret while the IP firewall rule is open:

```bash
cat <<'EOF' > teams-allowlist.txt
P-000001
alex.morgan@notalawfirm.example
@notalawfirm.example
EOF

az keyvault secret set \
  --vault-name "kvnotalawfi2cdo3cw7vuafm" \
  --name "teams-recipient-allowlist" \
  --file "teams-allowlist.txt"

rm teams-allowlist.txt
```

## 6. Close the Key Vault Firewall & Verify `Disabled`

Remove your temporary IP rule and verify public access is back to **`Disabled`**:

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

## 7. Live Verification Test & Switching `"provider"` from `"disabled"` to `"graph"`

Keep `integrations.teams.provider = "disabled"` in `client-not-a-law-firm/config/environments/demo.json` until Checkpoint 5c is deployed and live Graph verification succeeds:

1. **Test prerequisites:**
   - Ensure the target test user has an **Entra `entraObjectId` bound** in PostgreSQL (`people.entra_object_id`), has opted into Teams notifications (`teamsEnabled: true` on their profile's **Notifications** tab), and matches `teams-recipient-allowlist` (`kv://kvnotalawfi2cdo3cw7vuafm/teams-recipient-allowlist`).
   - Confirm `integrations.teams.graph.certificateThumbprint` is set to `6A23E571EA3F43D1DB39C187A201B40454159D3B` (already set in `demo.json`).
2. **Deploy Checkpoint 5c and run a live verification check:**
   - Temporarily test a live notification trigger (for example assigning a task to the allow-listed user) with `integrations.teams.provider = "graph"`, run/wait for `caj-outbox-drain-demo`, and confirm the user receives a redacted Teams Activity Feed notification linking safely back into the platform (`https://teams.microsoft.com/l/entity/<teamsAppId>/home?...`) with zero client names or confidential titles in the card.
   - Check telemetry/outbox state: `public.teams_activity_outbox` marks the row `'sent'` (`outbox.delivery.sent`), whilst un-bound users stop with `'dropped_unbound'` and non-allow-listed recipients stop with `'dropped_not_allow_listed'` and zero-PII audit entry `'teams-notification-dropped-allowlist'`.
3. **Promote `demo.json` after the live check:**
   - Change `integrations.teams.provider` from `"disabled"` to `"graph"` once the live check succeeds.

## 8. Common Error Codes & Diagnostics

- `GRAPH_CERT_FORMAT_UNSUPPORTED`: Key Vault certificate secret (`graph-teams-client-cert`) is PKCS#12 (`application/x-pkcs12`) or otherwise not an unencrypted PEM bundle. Create the certificate with `$p.secretProperties.contentType = 'application/x-pem-file'`.
- `TEAMS_GRAPH_CONFIG_INVALID`: Missing `certificateThumbprint`, `certificateVaultRef`, `clientId`, or `tenantId` under `integrations.teams.graph`.
- `TEAMS_CONTENT_SCRUB_REJECTED`: Confidential content or disallowed parameter name attempted to enter the Teams payload; blocked before queuing or HTTP send.
- `GRAPH_CERT_THUMBPRINT_MISMATCH`: `graph-teams-client-cert` in `kvnotalawfi2cdo3cw7vuafm` does not match `integrations.teams.graph.certificateThumbprint`.
- `TEAMS_GRAPH_HTTP_403` / `TEAMS_GRAPH_HTTP_404`: Usually indicates either the 1Squared Teams app is not yet installed for the target user (check the App Setup Policy in Section 3 Step 3) or `manifest.json` has not finished propagating in Teams Admin Center.
