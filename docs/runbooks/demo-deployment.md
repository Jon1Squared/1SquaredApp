# Demo Environment Deployment Runbook (`not-a-law-firm` / `environment: "demo"`)

This runbook covers the end-to-end deployment of the standalone **Not A Law Firm LLP** demo environment (`tenantId: "not-a-law-firm"`, `environment: "demo"`) on Azure Container Apps and Azure Database for PostgreSQL Flexible Server in `uksouth` (ADR 0024, ADR 0026, ADR 0028, ADR 0030, `S0-11b`).

## Architectural Guarantees

- **Same build everywhere (Rule 6):** The demo deployment runs the exact same immutable production container image (`Dockerfile`, `NODE_ENV=production`) as live client deployments. Demo Mode, the persona switcher, sample document seeding, and in-app data reset are enabled exclusively by tenant configuration (`environment: "demo"` and `featureFlags.enableDemoMode: true` in [demo.json](../../client-not-a-law-firm/config/environments/demo.json)), never by `NODE_ENV`.
- **Two-stage Bicep deployment (`deployApps` toggle):** Because the Platform Key Vault has `publicNetworkAccess: 'Disabled'` and Container Apps validate Key Vault secret references and pull the container image at creation time, [main.bicep](../../core/infra/main.bicep) and [platform.bicep](../../core/infra/modules/platform.bicep) support a two-stage deployment:
  - **Stage 1 (`deployApps=false`):** Provisions the VNet, Private DNS zones, User-Assigned Managed Identities (`runtimeIdentity` and `migrateIdentity`), Azure Container Registry (`Basic` SKU in non-live, `adminUserEnabled: false`, with `AcrPull` role assignments), Platform Key Vault and Tenant Key Vault (with Private Endpoints and `Key Vault Secrets User` role assignments), Log Analytics + Application Insights, PostgreSQL Flexible Server (`Standard_B1ms`, Entra ID auth only, TLS 1.2+, PgBouncer `TRANSACTION` pooling on port `6432`, `migrateIdentity` as Entra administrator), and Azure Blob Storage (`tenant-not-a-law-firm-demo`).
  - **Stage 2 (`deployApps=true`):** Provisions the Container Apps Environment (`cae-platform-demo`), the web Container App (`ca-web-platform-demo`), the manual provisioning, migration, and demo-seeding jobs (`caj-provision-demo`, `caj-migrate-demo`, `caj-seed-demo-demo`), and the hourly scheduled jobs (`caj-kd-rem-demo`, `caj-doc-prg-demo`, `caj-enq-anon-demo`).
- **In-VNet PostgreSQL provisioning, migration, and demo seeding:** Because PostgreSQL Flexible Server has `publicNetworkAccess: 'Disabled'` inside `snet-postgres`, database setup runs entirely inside the VNet via three manual Container Apps jobs:
  1. `caj-provision-demo` (`node dist/jobs/run-job.mjs provision`, running as `migrateIdentity` on direct port `5432`) creates the `NOINHERIT` PostgreSQL Entra principal for `runtimeIdentity`, the `NOLOGIN` role `role_tenant_not_a_law_firm_demo`, the isolated database `pg_tenant_not_a_law_firm_demo`, and the `R402` schema privileges.
  2. `caj-migrate-demo` (`node dist/jobs/run-job.mjs migrate`, running as `migrateIdentity` on direct port `5432`) applies all 15 expand/contract migrations (`0001`–`0015`).
  3. `caj-seed-demo-demo` (`node dist/jobs/run-job.mjs seed-demo`, running as `runtimeIdentity` on PgBouncer port `6432`) reads the `DEMO_ENTRA_MAP_JSON` secret from Key Vault and seeds the invented demo dataset (`data/seed-not-a-law-firm.json` and `data/pms/1Squared_PMS_Demo_Data.xlsx`) into PostgreSQL.

---

## 1. Prerequisites & Pre-Configured Identifiers

The non-secret identifiers for the 1Squared Non-Live demo setup are pre-filled in [demo.bicepparam](../../core/infra/parameters/demo.bicepparam):

| Setting | Value |
| --- | --- |
| **Azure Subscription** | `1Squared Non-Live` |
| **Resource Group** | `rg-onesquared-demo-uksouth` (`uksouth`) |
| **Entra Directory (Tenant) ID (`entraTenantId`)** | `f8218d9a-e055-463f-add2-f03679aad7f2` |
| **Demo Sign-In App Registration (`entraClientId`)** | `0a1a7a83-367f-426b-aaa3-70c288541d1d` (`1Squared Demo`) |
| **Local Entra Persona Map (uncommitted, git-ignored)** | `data/entra-map.local.json` (maps `P-000001`–`P-000018` to the 8 demo Entra user Object IDs) |

Verify your local Azure CLI session in PowerShell before starting:

```powershell
az login --tenant f8218d9a-e055-463f-add2-f03679aad7f2
az account set --subscription "1Squared Non-Live"
az account show --query "{subscriptionName:name, subscriptionId:id, tenantId:tenantId, user:user.name}" -o json
```

**Expected output:** JSON showing `"subscriptionName": "1Squared Non-Live"` and `"tenantId": "f8218d9a-e055-463f-add2-f03679aad7f2"`.

---

## 2. Step-by-Step Deployment Procedure (PowerShell)

### Step 1: Verify the resource group and preview Stage 1 (`what-if`)

```powershell
$RG = "rg-onesquared-demo-uksouth"
az group show --name $RG --query "{name:name, location:location, provisioningState:properties.provisioningState}" -o json

az deployment group what-if `
  --resource-group $RG `
  --template-file core/infra/main.bicep `
  --parameters core/infra/parameters/demo.bicepparam `
  --parameters deployApps=false
```

**Expected output:** `what-if` summary listing the VNet (`10.26.0.0/16`), Private DNS zones, Managed Identities, Azure Container Registry, Platform & Tenant Key Vaults, Log Analytics, Application Insights, PostgreSQL Flexible Server (`psql-platform-demo`), and Tenant Storage Account (`stnotalawfi...`), with **no** Container Apps or jobs yet.

### Step 2: Deploy Stage 1 (Foundation Infrastructure)

```powershell
$Stage1 = az deployment group create `
  --name "demo-stage1-foundation" `
  --resource-group $RG `
  --template-file core/infra/main.bicep `
  --parameters core/infra/parameters/demo.bicepparam `
  --parameters deployApps=false `
  --query "properties.outputs" -o json | ConvertFrom-Json

$ACR_NAME        = $Stage1.containerRegistryName.value
$ACR_SERVER      = $Stage1.containerRegistryLoginServer.value
$PLATFORM_KV     = $Stage1.platformKeyVaultName.value
$POSTGRES_FQDN   = $Stage1.sharedPostgresServerFqdn.value

[PSCustomObject]@{
  ContainerRegistryName        = $ACR_NAME
  ContainerRegistryLoginServer = $ACR_SERVER
  PlatformKeyVaultName         = $PLATFORM_KV
  SharedPostgresServerFqdn     = $POSTGRES_FQDN
}
```

**Expected output:** Provisioning succeeds in ~8–12 minutes (PostgreSQL Flexible Server takes the majority of the time) and prints the generated `ContainerRegistryName`, `ContainerRegistryLoginServer`, `PlatformKeyVaultName`, and `SharedPostgresServerFqdn`.

### Step 3: Build and push the immutable container image via `az acr build`

Build the multi-stage `Dockerfile` remotely in Azure Container Registry (`PLATFORM_TENANT_PACKAGE_DIR=client-not-a-law-firm`, `PLATFORM_ENVIRONMENT=demo`) so no local Docker daemon is required:

```powershell
$GitSha = (git rev-parse --short HEAD).Trim()
$ImageTag = "demo-$GitSha"
$FullImage = "$ACR_SERVER/onesquared-web:$ImageTag"

az acr build `
  --registry $ACR_NAME `
  --image "onesquared-web:$ImageTag" `
  --image "onesquared-web:demo-latest" `
  --build-arg PLATFORM_TENANT_PACKAGE_DIR=client-not-a-law-firm `
  --build-arg PLATFORM_ENVIRONMENT=demo `
  .

Write-Host "Built image: $FullImage"
```

**Expected output:** `Run ID: ... was successful after ...` and the image tag `$FullImage`.

### Step 4: Populate the Platform Key Vault secrets (temporary firewall window)

Because the Platform Key Vault has `publicNetworkAccess: 'Disabled'` (`defaultAction: 'Deny'`), grant your signed-in operator account `Key Vault Secrets Officer` on the vault, briefly allow your workstation public IP through the Key Vault firewall, write the 4 required secrets, and immediately lock `publicNetworkAccess` back to `Disabled` in a `try / finally` block:

```powershell
$SignedInUserOid = (az ad signed-in-user show --query id -o tsv).Trim()
$KvResourceId    = (az keyvault show --name $PLATFORM_KV --resource-group $RG --query id -o tsv).Trim()

# Grant Key Vault Secrets Officer (b86a8fe4-44ce-4948-aee5-eccb2c155cd7) to your operator account
az role assignment create `
  --assignee-object-id $SignedInUserOid `
  --assignee-principal-type User `
  --role "b86a8fe4-44ce-4948-aee5-eccb2c155cd7" `
  --scope $KvResourceId | Out-Null

$MyPublicIp = (Invoke-RestMethod -Uri "https://api.ipify.org").Trim()
$EntraClientSecretPlain = Read-Host "Paste the 1Squared Demo Entra client secret Value"

# Generate 32-byte (64-hex-char) signing keys for session cookies and blob tokens
$Bytes1 = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Fill($Bytes1)
$AuthSecretHex = ($Bytes1 | ForEach-Object { $_.ToString("x2") }) -join ""
$Bytes2 = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Fill($Bytes2)
$BlobSigningKeyHex = ($Bytes2 | ForEach-Object { $_.ToString("x2") }) -join ""

try {
  az keyvault update --name $PLATFORM_KV --resource-group $RG --public-network-access Enabled --default-action Deny | Out-Null
  az keyvault network-rule add --name $PLATFORM_KV --resource-group $RG --ip-address "$MyPublicIp/32" | Out-Null
  Start-Sleep -Seconds 15

  az keyvault secret set --vault-name $PLATFORM_KV --name "entra-client-secret" --value $EntraClientSecretPlain --query "name" -o tsv
  az keyvault secret set --vault-name $PLATFORM_KV --name "auth-secret"         --value $AuthSecretHex         --query "name" -o tsv
  az keyvault secret set --vault-name $PLATFORM_KV --name "blob-signing-key"    --value $BlobSigningKeyHex    --query "name" -o tsv
  az keyvault secret set --vault-name $PLATFORM_KV --name "demo-entra-map"      --file "data/entra-map.local.json" --query "name" -o tsv
}
finally {
  az keyvault network-rule remove --name $PLATFORM_KV --resource-group $RG --ip-address "$MyPublicIp/32" | Out-Null
  az keyvault update --name $PLATFORM_KV --resource-group $RG --public-network-access Disabled --default-action Deny | Out-Null
  Remove-Variable EntraClientSecretPlain, AuthSecretHex, BlobSigningKeyHex -ErrorAction SilentlyContinue
}
```

**Expected output:** Prints the four secret names (`entra-client-secret`, `auth-secret`, `blob-signing-key`, `demo-entra-map`) and leaves `publicNetworkAccess` set to `Disabled`.

### Step 5: Deploy Stage 2 (Container Apps Environment, Web App & Jobs)

```powershell
$Stage2 = az deployment group create `
  --name "demo-stage2-apps" `
  --resource-group $RG `
  --template-file core/infra/main.bicep `
  --parameters core/infra/parameters/demo.bicepparam `
  --parameters deployApps=true `
  --parameters containerRegistryName=$ACR_NAME `
  --parameters appContainerImage=$FullImage `
  --query "properties.outputs" -o json | ConvertFrom-Json

$WEB_APP_NAME = $Stage2.webContainerAppName.value
$WEB_FQDN     = $Stage2.webContainerAppFqdn.value
$REDIRECT_URI = "https://$WEB_FQDN/api/auth/callback/microsoft-entra-id"

[PSCustomObject]@{
  WebContainerAppName = $WEB_APP_NAME
  WebContainerAppFqdn = $WEB_FQDN
  EntraRedirectUri    = $REDIRECT_URI
  ProvisionJobName    = $Stage2.provisionJobName.value
  MigrateJobName      = $Stage2.migrateJobName.value
  SeedDemoJobName     = $Stage2.seedDemoJobName.value
}
```

**Expected output:** Prints `ca-web-platform-demo`, its public HTTPS `<fqdn>`, and the job names `caj-provision-demo`, `caj-migrate-demo`, and `caj-seed-demo-demo`.

### Step 6: Configure the Entra ID Redirect URI, Optional `amr` Claim, and `ENTRA_REDIRECT_URI` on the Web App

Add `$REDIRECT_URI` (`https://<fqdn>/api/auth/callback/microsoft-entra-id`) and the `amr` (*Authentication Methods References*) optional claim to the **1Squared Demo** (`0a1a7a83-367f-426b-aaa3-70c288541d1d`) App Registration, and update the web Container App's `ENTRA_REDIRECT_URI` environment variable:

> **Security Rule (`R484`):** Demo user accounts in Microsoft Entra ID must **never** be assigned any Microsoft Entra directory administrator role (such as `Billing Administrator`, `Helpdesk Administrator`, or `Authentication Administrator`), because demo credentials may be shared during demonstrations and live in the company directory. Keep all 8 Entra demo user accounts (`P-000001`, `P-000002`, `P-000003`, `P-000004`, `P-000009`, `P-000010`, `P-000038`, `P-000042`; note that `P-000051` `Adam Admin` is an in-app synthetic demo-switcher record with `demo: true` and `showsWorkOfId: 'P-000004'` and is never bound to an Entra user) as standard non-admin Entra users with zero directory roles. Under Microsoft Entra ID Free (Security Defaults), `/admin` (which enforces `mfaVerified === true`) is demonstrated only when Entra challenges the session for MFA or with a real MFA-verified account (a known demo limitation on Entra ID Free unless a Conditional Access policy under Entra ID P1 is used).

```powershell
$ClaimsFile = Join-Path $env:TEMP 'entra-optional-claims.json'
@'
{
  "idToken": [
    { "name": "amr", "essential": false }
  ],
  "accessToken": [
    { "name": "amr", "essential": false }
  ]
}
'@ | Set-Content -Path $ClaimsFile -Encoding utf8

az ad app update `
  --id "0a1a7a83-367f-426b-aaa3-70c288541d1d" `
  --web-redirect-uris "http://localhost:3000/api/auth/callback/microsoft-entra-id" $REDIRECT_URI `
  --optional-claims "@$ClaimsFile"
Remove-Item $ClaimsFile -Force

az containerapp update `
  --name $WEB_APP_NAME `
  --resource-group $RG `
  --set-env-vars "ENTRA_REDIRECT_URI=$REDIRECT_URI" `
  --query "{name:name, fqdn:properties.configuration.ingress.fqdn, provisioningState:properties.provisioningState}" -o json
```

**Expected output:** `"provisioningState": "Succeeded"`.

### Step 7: Run `caj-provision-demo`, `caj-migrate-demo`, and `caj-seed-demo-demo` in order

Run the three manual Container Apps jobs sequentially inside the VNet:

```powershell
foreach ($JobName in @("caj-provision-demo", "caj-migrate-demo", "caj-seed-demo-demo")) {
  Write-Host "Starting $JobName..."
  $Exec = az containerapp job start --name $JobName --resource-group $RG -o json | ConvertFrom-Json
  $ExecName = $Exec.name
  do {
    Start-Sleep -Seconds 5
    $Status = az containerapp job execution show `
      --name $JobName `
      --resource-group $RG `
      --job-execution-name $ExecName `
      --query "properties.status" -o tsv
    Write-Host "  $JobName ($ExecName): $Status"
  } while ($Status -in @("Running", "Processing", "Pending"))

  if ($Status -ne "Succeeded") {
    throw "Job $JobName failed with status: $Status"
  }
}
```

**Expected output:** Each job transitions from `Running` to `Succeeded`.
- To re-seed an already-seeded demo database from the CLI at any time, either use **Administration → Demo data → Load demo dataset** in the UI (requires MFA-verified Admin) or temporarily pass `SEED_DEMO_FORCE=true` to `caj-seed-demo-demo`:
  ```powershell
  az containerapp job update --name "caj-seed-demo-demo" --resource-group $RG --set-env-vars "SEED_DEMO_FORCE=true" | Out-Null
  az containerapp job start  --name "caj-seed-demo-demo" --resource-group $RG
  az containerapp job update --name "caj-seed-demo-demo" --resource-group $RG --remove-env-vars "SEED_DEMO_FORCE" | Out-Null
  ```

### In-Place Upgrade & Rollback Rule for Migrations `0028` (`S1-06`) & `0027` (`S1-12`, `R821` Option B, `R853`)

- **In-place demo conversion (`S1-12`, `0027`):** Deploying `S1-12` upgrades the existing demo tenant in place via `caj-migrate-demo` (`0027_pms_money_and_retainer_pence_expand`, zero automatic re-seeding). After `caj-migrate-demo` finishes, inspect `ContainerAppConsoleLogs_CL` (and Application Insights) for `job.migrate.pms_pence_verified` and confirm `mismatchCount: 0` across all 21 verified monetary columns (`maxColumnTotalDiffPence: 0`; logs contain counts and per-column differences only). Re-seeding is used only as a manual fallback if conversion verification fails and only with owner approval.
- **In-place engagement & chasing schema expand (`S1-06`, `0028`):** Deploying `S1-06` applies `0028_engagement_and_chasing_expand` cleanly over `0027` with zero backfill onto pre-existing `'Sent'` matters.
- **Mandatory newest-first rollback rule (`R828`, `R853`):** Because migrate-down executes strictly **newest first, one version at a time** (non-newest targets are refused) and earlier container images do not contain newer `downSql` scripts, **always run migrate-down using the newest deployed image (`S1-06` when both `S1-06` and `S1-12` are deployed) before rolling back application containers**:
  - **Rolling back only `S1-06` (to `S1-12`):** Undo migration `0028` only and confirm every tenant returns to schema version `0027` before rolling web and scheduled-job containers back to `<s1-12-release-tag>`.
  - **Rolling back both `S1-06` and `S1-12` (to a pre-`S1-12` release):** Undo migration `0028` first and confirm `0027`, then undo migration `0027` (still using the `S1-06` image) and confirm `0026` before rolling web and scheduled-job containers back to `<pre-s1-12-release-tag>`. *(While `S1-12` reads solely from integer-pence columns, it still dual-writes legacy float columns so rolling back `0027` -> `0026` remains reversible.)*

Execute the rollback steps in this exact order (replace `<placeholders>` with the environment values):
  1. **Stop traffic or scale app containers to zero:**
     ```powershell
     az containerapp update --name <web-app-name> --resource-group <resource-group> --min-replicas 0 --max-replicas 0
     ```
  2. **Step A — Run migrate-down for `0028` using the newest (`S1-06`) image and confirm schema version `0027`:**
     ```powershell
     az containerapp job update --name <migrate-job-name> --resource-group <resource-group> --set-env-vars "PLATFORM_MIGRATE_DOWN_TARGET=0028" "PLATFORM_MIGRATE_DOWN_CONFIRM=true" | Out-Null
     az containerapp job start --name <migrate-job-name> --resource-group <resource-group>
     az containerapp job update --name <migrate-job-name> --resource-group <resource-group> --set-env-vars "PLATFORM_MIGRATE_DOWN_TARGET=" "PLATFORM_MIGRATE_DOWN_CONFIRM=false" | Out-Null
     ```
     Confirm execution status and schema version `0027` before continuing:
     ```powershell
     az containerapp job execution show --name <migrate-job-name> --resource-group <resource-group> --job-execution-name <execution-name> --query "properties.status" -o tsv
     az containerapp job logs show --name <migrate-job-name> --resource-group <resource-group> --job-execution-name <execution-name>
     ```
     Verify `Succeeded` and the `job.migrate.down` log showing `"previousVersion":"0028"`, `"resultingVersion":"0027"`, and `"outcome":"rolled_back"` for every tenant.
     *(If rolling back **only `S1-06`** to `S1-12`, skip Step 3 and proceed directly to Step 4 using `<s1-12-release-tag>`.)*
  3. **Step B (only when rolling back past `S1-12` to a pre-`S1-12` release) — Run migrate-down for `0027` still using the newest (`S1-06`) image and confirm schema version `0026`:**
     ```powershell
     az containerapp job update --name <migrate-job-name> --resource-group <resource-group> --set-env-vars "PLATFORM_MIGRATE_DOWN_TARGET=0027" "PLATFORM_MIGRATE_DOWN_CONFIRM=true" | Out-Null
     az containerapp job start --name <migrate-job-name> --resource-group <resource-group>
     az containerapp job update --name <migrate-job-name> --resource-group <resource-group> --set-env-vars "PLATFORM_MIGRATE_DOWN_TARGET=" "PLATFORM_MIGRATE_DOWN_CONFIRM=false" | Out-Null
     ```
     *(Direct CLI invocation on the newest image: `node dist/jobs/run-job.mjs migrate --down --target 0028 --confirm-rollback` then `--target 0027 --confirm-rollback`. The tenant list always comes from the tenant registry, never a free-text flag, and non-newest or unconfirmed rollbacks are refused.)*
     Confirm execution status and schema version `0026` before rolling containers back:
     ```powershell
     az containerapp job execution show --name <migrate-job-name> --resource-group <resource-group> --job-execution-name <execution-name> --query "properties.status" -o tsv
     az containerapp job logs show --name <migrate-job-name> --resource-group <resource-group> --job-execution-name <execution-name>
     ```
     Verify `Succeeded` and the `job.migrate.down` log showing `"previousVersion":"0027"`, `"resultingVersion":"0026"`, and `"outcome":"rolled_back"` for every tenant.
  4. **Roll application and scheduled-job containers back to the target release and restore traffic (`<s1-12-release-tag>` or `<pre-s1-12-release-tag>`):**
     ```powershell
     az containerapp update --name <web-app-name> --resource-group <resource-group> --image <acr-login-server>/<web-image>:<target-release-tag> --min-replicas 1 --max-replicas <max-replicas>
     ```
     Repeat for any scheduled-job Container Apps jobs on `<target-release-tag>`. Re-deploying later runs `0027` / `0028` up cleanly from live tables.

---

## 3. Post-Deployment Verification Checklist

1. **Health & Sign-In Redirect (`https://<fqdn>/login`):**
   Open `https://$WEB_FQDN/login` in an InPrivate / Incognito browser window and click **Sign in with Microsoft Entra ID**. Verify that Microsoft Entra ID prompts for sign-in and redirects back to `https://$WEB_FQDN/api/auth/callback/microsoft-entra-id` without `AADSTS50011` or internal `0.0.0.0:3000` redirects.
2. **MFA-Verified Admin Sign-In (`Huw Pritchard`, `P-000004`):**
   Sign in as the demo Admin user mapped to `P-000004` (`huw.pritchard@1squared.onmicrosoft.com`) with MFA. Verify:
   - The firm header shows **Not A Law Firm LLP**.
   - **Matters**, **Enquiries**, **Tasks**, **People & Organisations**, **Key Dates**, and **Time & Billing** are populated with the seeded demo dataset, and all 5 seeded key dates have due dates in the future.
   - **Administration → RBAC & Entra ID** is accessible (confirming `mfaVerified === true` and `admin:access`).
3. **Least-Privilege Demo Persona Switcher:**
   - While signed in as `Huw Pritchard` (Admin), use the top-right account menu **Demo persona switcher** to switch between seeded personas (Managing Partner, Partner, Fee Earner, Legal Secretary, Enquiries Coordinator, Finance, Risk & Compliance) and confirm each role's Home dashboard and left-rail navigation update immediately.
   - Sign out (`POST /api/auth/logout`) and sign in as the Fee Earner demo user (`Rhian Morgan`, `P-000001`). Confirm that the persona switcher only offers personas whose permissions are a subset of Fee Earner and never offers Admin, Managing Partner, Partner, or Risk & Compliance.
4. **In-App Reset Demo Data (`R326`):**
   Sign back in as `Huw Pritchard` (Admin with MFA), open **Administration → Demo data** (`/admin/demo-data`), and trigger **Load demo dataset**. Confirm that the reset completes, audit reference numbers restart from the demo sequence with a new `data-reset` audit entry, and all 8 Entra Object ID bindings (`entraObjectId`) are preserved so demo users can continue signing in without re-running `caj-seed-demo-demo`.

---

## 4. Troubleshooting Common Issues

| Symptom | Root Cause | Resolution |
| --- | --- | --- |
| **`TENANT_SCHEMA_NOT_READY`** on sign-in or page load | `caj-provision-demo` or `caj-migrate-demo` has not been executed yet, or failed before applying migration `0015`. | Run Step 7 (`caj-provision-demo` then `caj-migrate-demo`) and inspect job logs in Log Analytics (`ContainerAppConsoleLogs_CL \| where ContainerJobName_s in ("caj-provision-demo", "caj-migrate-demo")`). |
| **`AADSTS50011: The redirect URI ... specified in the request does not match`** | The web Container App's `https://<fqdn>/api/auth/callback/microsoft-entra-id` is missing from the **1Squared Demo** App Registration (`0a1a7a83-367f-426b-aaa3-70c288541d1d`) or `ENTRA_REDIRECT_URI` on `ca-web-platform-demo` still has the Stage 1 placeholder value. | Re-run Step 6 to register `$REDIRECT_URI` on the Entra App Registration and update `ENTRA_REDIRECT_URI` on `ca-web-platform-demo`. |
| **`ForbiddenByConnection` / `PublicNetworkAccessDisabled`** when running `az keyvault secret set` | Platform Key Vault enforces `publicNetworkAccess: 'Disabled'` (`defaultAction: 'Deny'`) at rest, or your workstation IP changed. | Run the `try / finally` block in Step 4, which temporarily enables public access for your current `$MyPublicIp/32`, waits 15 seconds for firewall propagation, writes the secrets, and disables public access again. |
| **Container App fails to start with Key Vault secret resolution error** | One of the required secrets (`entra-client-secret`, `auth-secret`, `blob-signing-key`, or `demo-entra-map` for `caj-seed-demo-demo`) was not written to `$PLATFORM_KV` before Stage 2. | Verify all 4 secret names exist in `$PLATFORM_KV` (Step 4), then restart the revision (`az containerapp revision restart --name $WEB_APP_NAME --resource-group $RG --revision <rev>`). |
| **`caj-seed-demo-demo` exits with `Refusing to overwrite a non-empty store without --force`** | The demo database `pg_tenant_not_a_law_firm_demo` is already seeded (idempotency guard). | No action needed if already seeded; to force a fresh CLI re-seed, use **Administration → Demo data → Load demo dataset** in the UI or pass `SEED_DEMO_FORCE=true` on `caj-seed-demo-demo`. |

---

## 5. Estimated Monthly Running Cost & Teardown / Pause Instructions

### Estimated Monthly Running Cost (`uksouth`, Non-Live Demo SKU Profile)

| Resource | SKU / Tier | Estimated Monthly Cost (GBP) |
| --- | --- | --- |
| **Azure Database for PostgreSQL Flexible Server** (`psql-platform-demo`) | Burstable `Standard_B1ms` (1 vCore, 2 GiB RAM), 32 GiB storage, 7-day backup | ~£12–£16 / month |
| **Azure Container Apps** (`ca-web-platform-demo` + jobs in `cae-platform-demo`) | Consumption workload profile (`minReplicas: 1` idle vCPU/memory grant + job executions) | ~£8–£18 / month |
| **Azure Private Endpoints & Private DNS Zones** (Platform KV, Tenant KV, Blob Storage + 3 DNS zones) | 3 Private Endpoints + 3 Private DNS zones | ~£18–£22 / month |
| **Azure Container Registry** (`acronesquared...`) | `Basic` SKU | ~£4 / month |
| **Azure Key Vaults & Storage Account** (`kvp...`, `kv...`, `st...`) | Standard Key Vaults + Standard LRS Blob Storage | ~£1–£3 / month |
| **Log Analytics & Application Insights** (`law-platform-demo`, `appi-platform-demo`) | Pay-as-you-go (`PerGB2018`, 30-day retention, 2 GB/day cap; first 5 GB/month free) | ~£0–£3 / month |
| **Estimated Total** | | **~£43–£66 / month** |

### Pausing Between Demos (Cost-Saving Mode)

To reduce compute costs between demos without deleting the database or secrets, stop the PostgreSQL Flexible Server (Azure stops billing compute for up to 7 days at a time) and scale `ca-web-platform-demo` to `minReplicas: 0`:

```powershell
az postgres flexible-server stop --resource-group rg-onesquared-demo-uksouth --name psql-platform-demo
az containerapp update --resource-group rg-onesquared-demo-uksouth --name ca-web-platform-demo --min-replicas 0
```

To resume before a demo:

```powershell
az postgres flexible-server start --resource-group rg-onesquared-demo-uksouth --name psql-platform-demo
az containerapp update --resource-group rg-onesquared-demo-uksouth --name ca-web-platform-demo --min-replicas 1
```

### Full Teardown

To remove all Azure resources in the demo resource group (whilst keeping your Microsoft Entra ID app registrations and demo users intact):

```powershell
az group delete --name rg-onesquared-demo-uksouth --yes --no-wait
```

### Production Go-Live Configuration Notes

- **Verified-domain email linking default (`rbac.identityMapping.emailLinking.enabled`):** `rbac.identityMapping.emailLinking.enabled` defaults to `true` across tenant configurations (restricted to verified tokens matching `emailLinking.domains` or `branding.primaryDomain`, and always refusing privileged/ambiguous targets per B13 / S0-30). For production client go-live deployments that require strict pre-bound `entraObjectId`-only sign-in before provisioning or reject all automatic first-sign-in email matching, set `rbac.identityMapping.emailLinking.enabled: false` (or confirm `emailLinking.domains`) in the tenant's live configuration before cut-over (`R534`).
- **Session & blob signing secrets:** Set dedicated Key Vault-backed `AUTH_SECRET` and `PLATFORM_BLOB_SIGNING_KEY` secrets on every live Container App revision; `getSigningSecret()` (`R532`) and `resolveTenantBlobSigningKey()` (`R520`) refuse fallback development keys outside non-live `dev`/`test` configurations.

---

## Outbound Email Certificate & Allow-List Readiness (`S0-26`)

Owner prerequisites completed on **12–16 November 2026**: the `notifications@1squared.co.uk` shared mailbox, Entra app `fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1` (directory `f8218d9a-e055-463f-add2-f03679aad7f2`), Exchange Online RBAC scoped strictly to that mailbox, SPF/DKIM/DMARC DNS records for `1squared.co.uk`, the `application/x-pem-file` Key Vault certificate `graph-mail-certificate` in `kvnotalawfi2cdo3cw7vuafm` (SHA-1 thumbprint `C5428D7F519AE513A5B8CE027D291876CEDA40D3`, `.cer` uploaded to Entra and prior version removed), and the `email-recipient-allowlist` secret in `kvnotalawfi2cdo3cw7vuafm`.

`client-not-a-law-firm/config/environments/demo.json` permanently enables `integrations.email.provider = "graph"` (sending from `notifications@1squared.co.uk`) with `recipientAllowList = ["@1squared.co.uk"]` plus `email-recipient-allowlist` in `kvnotalawfi2cdo3cw7vuafm` (verified **18 November 2026** per [`docs/runbooks/email-certificate-setup.md`](./email-certificate-setup.md)). The 5-minute `caj-outbox-drain-demo` job drains queued emails and blocks seeded `@notalawfirm.example` personas at `dropped_allowlist`.

### 10. Microsoft Teams Activity Feed (`S0-29`, enabled)

Owner prerequisites completed on **16 November 2026** and live Graph delivery enabled on **18 November 2026**: `TeamsActivity.Send` application permission granted tenant admin consent on app `76474047-ac1f-49ee-83f3-5a2a58c2b3f8` (`User.Read` removed), Teams app package uploaded & allowed in Teams Admin Center with an App Setup Policy assigned to the demo users, PEM Key Vault certificate `graph-teams-client-cert` generated in `kvnotalawfi2cdo3cw7vuafm` (SHA-1 thumbprint `6A23E571EA3F43D1DB39C187A201B40454159D3B`, `.cer` uploaded to Entra), and `teams-recipient-allowlist` created in `kvnotalawfi2cdo3cw7vuafm`. `client-not-a-law-firm/config/environments/demo.json` permanently enables `integrations.teams.provider = "graph"` with `recipientAllowList = ["@1squared.co.uk"]` alongside `teams-recipient-allowlist` following [`docs/runbooks/teams-app-setup.md`](./teams-app-setup.md). The hourly `notification-digests` job (`caj-ntf-dig-demo`, `0 * * * *`) dispatches Monday–Friday daily/weekly digests through `public.email_outbox`, whilst `caj-outbox-drain-demo` safely drains and retention-scrubs both `public.email_outbox` and `public.teams_activity_outbox`.
