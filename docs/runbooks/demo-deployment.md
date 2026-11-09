# Demo Environment Deployment Runbook (S0-11b)

This runbook covers deploying, seeding and resetting the standalone **Not A Law Firm LLP** demo environment (`tenantId: "not-a-law-firm"`, `environment: "demo"`), as specified in [ADR 0026](../decisions/0026-separate-demo-tenant.md).

## 1. Architecture & Tenancy Note

- **Same build everywhere (Rule 6):** The demo deployment runs the exact same production application build (`npm run build && npm start`) as live client deployments. Demo Mode, the persona switcher, sample document seeding, and data reset are enabled exclusively by tenant configuration (`environment: "demo"` and `featureFlags.enableDemoMode: true` in `client-not-a-law-firm/config/environments/demo.json`), never by `NODE_ENV`.
- **Pre-S0-17 vs post-S0-17 topology:** Before S0-17 (multi-tenant routing and PostgreSQL store), the demo environment is deployed as its own App Service instance (`environment=demo`, `tenantPackageDir=client-not-a-law-firm`). After S0-17 lands, the demo becomes a tenant (`not-a-law-firm`) inside the shared non-live multi-tenant deployment, with its own isolated database, storage container, and Key Vault secret prefix.
- **Outbound email (ADR 0027):** No `EmailSender` service is wired in Stage 0 until S0-26 lands. The demo deployment sends **no outbound email**. When S0-26 introduces outbound email, non-live environments (`dev`, `test`, `training`, `demo`) will enforce the recipient allow-list (`@notalawfirm.example` and configured operator test addresses).

## 2. Manual Prerequisite: Microsoft Entra ID App Registration & Test Users

Before deploying the Bicep template, an operator with access to the demo Microsoft Entra ID directory must complete the following manual setup (Stage 0 Plan Section 8):

1. **Create the Demo App Registration:**
   - Register a confidential web application in the demo Microsoft Entra ID tenant.
   - Configure the OIDC redirect URI: `https://<demo-app-hostname>/api/auth/callback/microsoft-entra-id`.
   - Record the **Application (client) ID** (`entraClientId`) and **Directory (tenant) ID** (`entraTenantId`).
   - Generate a client secret and store it exclusively in the demo Azure Key Vault (`entra-client-secret`).

2. **Create Invented Demo Test Users (One per Role):**
   Microsoft Entra ID cannot create user principal names on `@notalawfirm.example` (an RFC 2606 reserved domain). Create the following eight test users in the demo Entra directory using the directory's own domain (for example `<alias>@<demo-directory>.onmicrosoft.com`) and invented display names only. Record each user's Entra **Object ID (`oid`)**; the `--entra-map` flag on `npm run seed:demo` binds each Entra `oid` to the seeded `Person.id` (whose in-store profile email remains on `@notalawfirm.example`):

   | Home Role | Seed Person ID | Invented Display Name | Example Entra UPN (Directory Domain) | In-Store Seed Email | App Roles / Groups |
   |---|---|---|---|---|---|
   | `01 Fee Earner` | `P-000002` | Dafydd Evans | `dafydd.evans@<demo-tenant>.onmicrosoft.com` | `dafydd.evans@notalawfirm.example` | `fee_earner` |
   | `02 Partner` | `P-000001` | Rhian Morgan | `rhian.morgan@<demo-tenant>.onmicrosoft.com` | `rhian.morgan@notalawfirm.example` | `partner` |
   | `03 Legal Secretary` | `P-000010` | Nia Edwards | `nia.edwards@<demo-tenant>.onmicrosoft.com` | `nia.edwards@notalawfirm.example` | `legal_secretary` |
   | `04 Enquiries Coordinator` | `P-000042` | Lowri Ellis | `lowri.ellis@<demo-tenant>.onmicrosoft.com` | `lowri.ellis@notalawfirm.example` | `enquiries_coordinator` |
   | `05 Finance` | `P-000009` | Gethin Powell | `gethin.powell@<demo-tenant>.onmicrosoft.com` | `gethin.powell@notalawfirm.example` | `finance` |
   | `06 Risk & Compliance` | `P-000003` | Bethan Rees | `bethan.rees@<demo-tenant>.onmicrosoft.com` | `bethan.rees@notalawfirm.example` | `risk_compliance` |
   | `07 Managing Partner` | `P-000038` | Gethin Lloyd | `gethin.lloyd@<demo-tenant>.onmicrosoft.com` | `gethin.lloyd@notalawfirm.example` | `managing_partner` |
   | `08 Admin` | `P-000004` | Huw Pritchard | `huw.pritchard@<demo-tenant>.onmicrosoft.com` | `huw.pritchard@notalawfirm.example` | `admin` (require MFA) |

## 3. Infrastructure Deployment (`core/infra/main.bicep`)

Deploy `core/infra/main.bicep` into the non-live UK South resource group with the following parameters:

```bash
az deployment group create \
  --resource-group rg-onesquared-demo-uksouth \
  --template-file core/infra/main.bicep \
  --parameters \
    environment=demo \
    hostingMode=multi_tenant \
    location=uksouth \
    tenantSlug=not-a-law-firm \
    tenantPackageDir=client-not-a-law-firm \
    entraClientId="<DEMO_ENTRA_APPLICATION_CLIENT_ID>" \
    entraTenantId="<DEMO_ENTRA_DIRECTORY_TENANT_ID>" \
    entraRedirectUri="https://app-not-a-law-firm-demo.azurewebsites.net/api/auth/callback/microsoft-entra-id" \
    vnetAddressPrefix="10.26.0.0/16" \
    appServiceSubnetPrefix="10.26.1.0/24"
```

## 4. Key Vault Secrets

Populate the following secrets in the provisioned demo Key Vault (`kv-notalawfirm-demo`). Never place secret values in Bicep files, environment overlays, or source control (Rule 5):

| Key Vault Secret Name | App Service Setting | Purpose |
|---|---|---|
| `entra-client-secret` | `ENTRA_CLIENT_SECRET` | Microsoft Entra ID confidential client secret for OIDC code exchange |
| `auth-secret` | `AUTH_SECRET` | 32+ byte random base64 HMAC-SHA256 session cookie signing key (`openssl rand -base64 32`) |
| `blob-signing-key` | `PLATFORM_BLOB_SIGNING_KEY` | 32+ byte random base64 HMAC-SHA256 scoped blob token signing key (`openssl rand -base64 32`) |
| `ideal-postcodes-api-key` | `IDEAL_POSTCODES_API_KEY` | Optional UK postcode lookup key (leave unset or use test key in demo) |
| `anthropic-api-key` | `ANTHROPIC_API_KEY` | Anthropic commercial API key for AI matter extraction (`enableAiMatterExtraction: true`) |
| `pms-connection-string` | Referenced via `kv://kv-notalawfirm-demo/pms-connection-string` | Reserved for S0-18 live PMS database connection |
| `companies-house-api-key` | Referenced via `kv://kv-notalawfirm-demo/companies-house-api-key` | Reserved for S0-18 Companies House API integration |

## 5. Seeding the Demo Store (`npm run seed:demo`)

Product code (`getStore()`) never auto-seeds demo records: when no runtime store file exists, the application initialises a clean empty deployment store (`createCleanDeploymentStore`). Demo data enters only through `npm run seed:demo` or the authenticated `resetAllDemoData` action.

Under [ADR 0001](../decisions/0001-shared-repo-and-transitional-store.md), the transitional JSON store reads and writes `data/runtime-store.json` (or the file path specified in `ONESQUARED_RUNTIME_STORE_PATH`) on the filesystem where the Next.js server process runs:
- Running `npm run seed:demo` on an engineer's workstation writes the local `data/runtime-store.json` file in that checkout.
- To seed the deployed demo App Service instance before S0-17 replaces the transitional store with PostgreSQL, run the command against the deployed instance's persistent store path (or set `ONESQUARED_RUNTIME_STORE_PATH` to the mounted persistent store path). Because `tsx` is declared in `devDependencies`, run `npm run seed:demo` in the build/deployment environment where dev dependencies are installed (or copy the generated store file to the deployed instance's `data/runtime-store.json`).

### 5a. Local Entra Object ID Mapping File (`--entra-map`)

To bind the real Entra test users created in Section 2 to the seeded personas, create a local, **uncommitted** JSON file whose name matches the `.gitignore` patterns (`/data/entra-map*.json` or `*.entra-map.json`, for example `data/entra-map.local.json`) mapping each seed `personId` to its Entra `oid`:

```json
{
  "P-000001": "<ENTRA_OID_FOR_RHIAN_MORGAN>",
  "P-000002": "<ENTRA_OID_FOR_DAFYDD_EVANS>",
  "P-000003": "<ENTRA_OID_FOR_BETHAN_REES>",
  "P-000004": "<ENTRA_OID_FOR_HUW_PRITCHARD>",
  "P-000009": "<ENTRA_OID_FOR_GETHIN_POWELL>",
  "P-000010": "<ENTRA_OID_FOR_NIA_EDWARDS>",
  "P-000038": "<ENTRA_OID_FOR_GETHIN_LLOYD>",
  "P-000042": "<ENTRA_OID_FOR_LOWRI_ELLIS>"
}
```

When `--entra-map` is supplied, `seed:demo` sets `entraObjectId` **only** on the person IDs listed in the map and leaves all other seeded people without an `entraObjectId`. When `--entra-map` is omitted, `seed:demo` builds the store with `includeSyntheticEntraOids: false` so that no synthetic Entra Object IDs are written and email first-linking can bind users on first sign-in. Never commit the mapping file to source control.

### 5b. Running the Seed Command

Run `npm run seed:demo` with `PLATFORM_TENANT_PACKAGE_DIR` and `PLATFORM_ENVIRONMENT` set:

```bash
PLATFORM_TENANT_PACKAGE_DIR=client-not-a-law-firm \
PLATFORM_ENVIRONMENT=demo \
npm run seed:demo -- --entra-map data/entra-map.local.json
```

Safety checks enforced by `seed:demo`:
- Requires both `PLATFORM_TENANT_PACKAGE_DIR` and `PLATFORM_ENVIRONMENT`.
- Refuses to run when `PLATFORM_ENVIRONMENT=live` or when the resolved tenant configuration has `environment: "live"`.
- Refuses to run when the resolved `tenantConfig.tenantId` differs from the seed snapshot's `firmId`.
- Refuses to overwrite a non-empty or unparseable store file unless `--force` is passed.
- Builds fresh relative dates anchored to the current UTC date (`createSeedStore(new Date(), { includeSyntheticEntraOids: false })`) so key dates, SLA deadlines, and task due dates are always current when seeded.
- Prints only record counts, `tenantId`, and `environment` (never person, client, or matter names).

To regenerate the committed seed snapshot (`data/seed-not-a-law-firm.json`, used by deterministic unit and e2e tests) from `buildDemoData` (`src/seed/demo.ts`) after updating seed fixtures:

```bash
PLATFORM_TENANT_PACKAGE_DIR=client-not-a-law-firm \
PLATFORM_ENVIRONMENT=demo \
npm run seed:demo -- --write-snapshot
```

## 6. Resetting the Demo Environment

The demo environment can be reset to its clean initial seed state in two ways:

1. **In-App Demo Data Administration (requires `admin:data_reset` and MFA):**
   - Sign in as the Admin persona (`P-000004`, Huw Pritchard) with MFA verified.
   - Navigate to **Administration → Demo data** (`/admin/demo-data`).
   - Click **Load demo dataset** (`resetDemoDataAction`), which calls `resetAllDemoData` to restore the seeded **Not A Law Firm LLP** dataset with fresh relative dates (`includeSyntheticEntraOids: false` outside `PLATFORM_ENVIRONMENT === 'test'`), preserves `entraObjectId` bindings only when the pre-reset store was itself a seeded store (`!prevStore.isCleanDeployment`) and both the person ID and primary email match the seeded persona (so `--entra-map` bindings survive the reset without binding a user provisioned after **Clear all data** to a seeded persona), and records a `data-reset` audit entry.
2. **CLI Re-Seed (with `--force`):**
   ```bash
   PLATFORM_TENANT_PACKAGE_DIR=client-not-a-law-firm \
   PLATFORM_ENVIRONMENT=demo \
   npm run seed:demo -- --force --entra-map data/entra-map.local.json
   ```

## 7. Recovering from a Corrupted Runtime Store File

`saveStore` writes `data/runtime-store.json` atomically via a temporary file (`<targetPath>.tmp-<pid>-<timestamp>`) and `fs.renameSync`. If `data/runtime-store.json` (or `ONESQUARED_RUNTIME_STORE_PATH`) is ever truncated or corrupted on disk, `getStore()` refuses to overwrite it and throws:

```text
Refusing to load corrupted runtime store file at <path>: not valid JSON.
```

The error message logs only the file path and generic reason—never any fragment of the file's contents (Rule 5).

To recover:
1. **Restore from backup:** Replace `data/runtime-store.json` with the most recent known-good backup copy.
2. **Start with a clean store:** Delete the corrupted `data/runtime-store.json` file; on the next request `getStore()` will initialise a clean empty deployment store (`createCleanDeploymentStore`).
3. **Re-seed the demo dataset:** Run `npm run seed:demo -- --force` (with `--entra-map` where applicable) as shown in Section 6.2 above to overwrite the corrupted file with a fresh demo store.
