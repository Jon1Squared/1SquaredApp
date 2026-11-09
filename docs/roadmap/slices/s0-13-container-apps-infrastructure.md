# S0-13: Container Apps infrastructure

| | |
|---|---|
| Backlog | P12 |
| Decision | [ADR 0024: Host the Application on Azure Container Apps](../../decisions/0024-azure-container-apps-hosting.md) (D1, accepted 6 November 2026); [ADR 0028: Tenant Databases and Repositories](../../decisions/0028-tenant-database-and-repositories.md) §1 (database & encryption keys, accepted 9 November 2026); [ADR 0030: Tenant-Aware Scheduler](../../decisions/0030-tenant-aware-scheduler.md) (Container Apps jobs, accepted 9 November 2026) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4, Checkpoint 4a) |
| Branch | `s0-13-container-apps-infrastructure`, from `develop`, targeting `develop` |
| Change class | Infrastructure (`core/infra/` Bicep only), plus CI Bicep validation and Rule 11 documentation (`src/docs/articles/`, `docs/`). |
| Size | L |
| Depends on | ADR 0024, ADR 0028 and ADR 0030 accepted (all merged on `develop`). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) for live deployment and `az deployment group what-if`; operator-populated Key Vault secrets (`ANTHROPIC_API_KEY`, rotated `IDEAL_POSTCODES_API_KEY`, Entra client credentials, signing keys) once Azure environments exist. |
| Baseline | `develop` at `52390b9` |

## What exists today

Checked against `develop` (`52390b9`):

1. **Single App Service Bicep file (`core/infra/main.bicep:1-329`):**
   - Provisions a single per-tenant VNet (`vnet-${tenantSlug}-${environment}`, `:73-107`) with one subnet `snet-appservice` (`10.24.1.0/24`) delegated to `Microsoft.Web/serverFarms` (`:84-103`).
   - Provisions one Key Vault (`kv-${sanitizedSlug}-${environment}`, `:118-143`) with `publicNetworkAccess: 'Enabled'` and a `snet-appservice` service-endpoint network ACL (`:131-141`), rather than Private Endpoints with `publicNetworkAccess: 'Disabled'` as required by ADR 0024 §3 (`docs/decisions/0024-azure-container-apps-hosting.md:39-40, 56`).
   - Provisions a Linux App Service Plan (`P1v3`, `:145-156`) and Linux App Service web app (`Microsoft.Web/sites`, `:172-236`) with a `SystemAssigned` identity granted `Key Vault Secrets User` *after* the web app is created (`:238-246`), naming compute after `tenantSlug` even when `hostingMode == 'multi_tenant'`.
   - Declares `enablePdfConverterContainerApp` (`:37`) and outputs `postgresDatabaseName` (`:327`), `cloudBlobStorageEnabled` (`:328`), and `pdfConverterContainerEnabled` (`:329`), without provisioning any Container Apps environment, PDF converter app, PostgreSQL Flexible Server, Log Analytics workspace, Application Insights resource, `migrate` job, or scheduled jobs.
   - Provisions optional Azure Blob Storage (`Standard_ZRS`, TLS 1.2, `allowBlobPublicAccess: false`, `allowSharedKeyAccess: false`, 30-day soft delete) and Microsoft Defender for Storage on-upload malware scanning (`:248-316`).
2. **CI (`ci.yml` & `scripts/verify-ci.mjs`):**
   - `.github/workflows/ci.yml:21-81` and `scripts/verify-ci.mjs:1-211` do not currently run `az bicep build` or `az bicep lint` on `core/infra/main.bicep`.
   - Note on local workstation: `az` and `bicep` are pre-installed on GitHub Actions `ubuntu-latest`, whereas the current Windows workstation has `node` (`24.18.0`) and `gitleaks` (`8.30.1`) installed without `az`/`bicep` on `PATH` (installable locally via `winget install Microsoft.Bicep` or Azure CLI).
3. **Help & documentation (`src/docs/articles/deployment-and-security.ts:1-115`):**
   - Line `46` still describes App Service VNet integration (`snet-appservice`), `publicNetworkAccess: 'Enabled'`, and `@Microsoft.KeyVault(...)` App Service references.
   - Lines `37`, `43`, `86`, and `89` state that hosted tenants never share an encryption key and describe `FORCE ROW LEVEL SECURITY` rather than ADR 0028's accepted design (shared hosted PostgreSQL Flexible Server encrypted with a platform-managed key as a recorded exception to Standard 8.5, optional dedicated server per tenant for own/CMK keys, and per-tenant database + Postgres role enforced via `SET ROLE`).

### Scope boundary with S0-13b

Per the WP4 Checkpoint 4a specification, **S0-13 keeps infrastructure changes strictly Bicep-only in `core/infra/`** (plus CI Bicep checks and Rule 11 documentation). Runtime TypeScript and container packaging items referenced in ADR 0024 Consequences (`:56-59`) and `P12` (`docs/roadmap/feature-list.md:125`) — specifically the `Dockerfile` / `.dockerignore`, Application Insights runtime telemetry export, failing closed when `PLATFORM_ENVIRONMENT` is unset under `NODE_ENV=production` (`src/platform/tenantRuntime.ts:533-540`, `R371`), and the two-tenant Key Vault secret-resolution isolation test in `core/tests/isolation.test.ts` (AG3) — are delivered immediately next in **S0-13b** (`s0-13b-telemetry.md`), so `P12` moves to `Completed` at the end of S0-13b (subject to manual Azure deployment verification).

## Files and changes

1. **`core/infra/modules/platform.bicep` (new — shared platform resources per ADR 0024 §2, ADR 0028 §1, ADR 0030):**
   - **Networking (preserving and extending existing VNet & Key Vault security):**
     - `Microsoft.Network/virtualNetworks` (`vnet-platform-${environment}` in `multi_tenant`, or `vnet-${tenantSlug}-${environment}` in `single_tenant`) with parameterised CIDR prefixes to support hub-and-spoke peering:
       - `snet-aca` (`/27` minimum, default `10.24.0.0/27`, delegated to `Microsoft.App/environments`) for the workload-profiles Container Apps environment.
       - `snet-postgres` (`10.24.1.0/28`, delegated to `Microsoft.DBforPostgreSQL/flexibleServers`) for private PostgreSQL Flexible Server access.
       - `snet-private-endpoints` (`10.24.2.0/27`, private endpoint network policies disabled) for Key Vault (and optional Blob Storage) Private Endpoints.
     - Private DNS zones linked to the VNet:
       - `privatelink.vaultcore.azure.net` for platform and tenant Key Vault private endpoints.
       - `privatelink.postgres.database.azure.com` for the shared (and any dedicated) PostgreSQL Flexible Server.
   - **Observability (Standard §13):**
     - `Microsoft.OperationalInsights/workspaces` (Log Analytics workspace, retention configurable by environment, daily quota cap parameter for non-live cost control).
     - `Microsoft.Insights/components` (workspace-based Application Insights, `IngestionMode: 'LogAnalytics'`, `DisableLocalAuth: true` where supported / Entra auth, passing `APPLICATIONINSIGHTS_CONNECTION_STRING` to Container Apps and jobs).
   - **Identity & Role Assignments (created BEFORE Container Apps and jobs — ADR 0024 §3):**
     - User-assigned Managed Identity (`Microsoft.ManagedIdentity/userAssignedIdentities`, `id-platform-${environment}`).
     - Built-in RBAC role assignments (`Key Vault Secrets User` `4633458b-17de-408a-b874-0445c86b69e6` on the platform Key Vault and `AcrPull` `7f951dda-4ed3-4680-a7ca-43fe172d538d` on the Azure Container Registry resource ID parameter), declared cleanly so Container Apps and jobs `dependsOn` both role assignments before pulling images or resolving Key Vault secrets.
   - **Platform Key Vault:**
     - `Microsoft.KeyVault/vaults` (`enableRbacAuthorization: true`, `enableSoftDelete: true`, `softDeleteRetentionInDays: 90`, `enablePurgeProtection: true`, `publicNetworkAccess: 'Disabled'`, `networkAcls.defaultAction: 'Deny'`, `bypass: 'None'`), exposed exclusively via a Private Endpoint in `snet-private-endpoints` registered in `privatelink.vaultcore.azure.net`. Holds platform-wide secrets only (for example `auth-secret`, `entra-client-secret` in hosted multi-tenant mode, `blob-signing-key`, `ideal-postcodes-api-key`, `anthropic-api-key` when platform-scoped).
   - **Shared PostgreSQL Flexible Server (`Microsoft.DBforPostgreSQL/flexibleServers`, ADR 0028 §1):**
     - Provisioned in `snet-postgres` (`delegatedSubnetResourceId`) with `privateDnsZoneArmResourceId` pointing to `privatelink.postgres.database.azure.com` and `publicNetworkAccess: 'Disabled'`.
     - PostgreSQL version `16`; SKU parameterised with `Burstable` (`Standard_B1ms`) default for `dev`/`test`/`demo` and `GeneralPurpose` for `training`/`live`.
     - **Entra ID authentication only, zero passwords:** `authConfig: { activeDirectoryAuth: 'Enabled', passwordAuth: 'Disabled', tenantId: subscription().tenantId }`, registering the user-assigned Managed Identity as a Microsoft Entra administrator (`Microsoft.DBforPostgreSQL/flexibleServers/administrators`).
     - **TLS & PgBouncer:** server configurations (`Microsoft.DBforPostgreSQL/flexibleServers/configurations`) enforcing `require_secure_transport = ON`, `ssl_min_protocol_version = TLSv1.2`, and `pgbouncer.enabled = true` (ADR 0028 §2).
     - Backup retention (`7`–`35` days parameterised; geo-redundant backup configurable for `live` in `ukwest`).
     - Platform-managed encryption key on the shared server (ADR 0028 Decision 1 recorded exception to Standard 8.5).
   - **Container Apps Environment & Apps (`Microsoft.App/managedEnvironments` & `Microsoft.App/containerApps`, ADR 0024 §1–§4):**
     - Workload-profiles Container Apps environment (`Consumption` profile enabled by default, parameterised for optional dedicated profiles) integrated with `snet-aca` and wired to Log Analytics.
     - **Web Container App:** external HTTPS ingress (`external: true`, `allowInsecure: false`, `targetPort: 3000`, `transport: 'auto'`), `minReplicas: 1` (`maxReplicas` parameterised), HTTP scaling rule, liveness/readiness probes, user-assigned Managed Identity, zero inline secret values — all secrets declared in `configuration.secrets` via `keyVaultUrl` + `identity: appIdentity.id` and referenced in `env` via `secretRef` (`ENTRA_CLIENT_SECRET`, `AUTH_SECRET`, `PLATFORM_BLOB_SIGNING_KEY`, `IDEAL_POSTCODES_API_KEY`, `ANTHROPIC_API_KEY`), alongside non-secret config (`PLATFORM_HOSTING_MODE`, `PLATFORM_ENVIRONMENT`, `PLATFORM_TENANT_PACKAGE_DIR`, `PLATFORM_POSTGRES_HOST`, `PLATFORM_POSTGRES_PORT: '6432'`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, and `DOC_CONVERTER_URL` when `enablePdfConverterContainerApp` is `true`).
     - **PDF Converter Internal Container App** (`if (enablePdfConverterContainerApp)`): internal-only ingress (`external: false`, `allowInsecure: false`, reachable only inside the Container Apps environment), `minReplicas: 0` (scales to zero when idle), running the parameterised converter image with no external network exposure.
   - **Container Apps Jobs (`Microsoft.App/jobs`, ADR 0028 §4 & ADR 0030):**
     - **`migrate` job** (`triggerType: 'Manual'`, `replicaTimeout: 1800`, `replicaRetryLimit: 0`), using the same application container image, user-assigned Managed Identity, and command override `['node', 'scripts/run-job.mjs', 'migrate']`, triggered by the release pipeline before a new web revision takes traffic.
     - **Scheduled jobs (parameterised, disabled by default until S0-19 and S0-19b):**
       - `enableSchedulerJobs` (`bool = false`) and per-job toggles (`enableKeyDateRemindersJob`, `enableUsageRetentionPurgeJob`, `enableEnquiryAnonymisationJob`), provisioning `Microsoft.App/jobs` with `triggerType: 'Schedule'`, `cronExpression: '0 * * * *'` (hourly check per ADR 0030 §5), `parallelism: 1`, `replicaCompletionCount: 1`, `replicaRetryLimit: 1`, `replicaTimeout: 1800`, invoking `['node', 'scripts/run-job.mjs', '<jobKey>']`.
2. **`core/infra/modules/tenant.bicep` (new — per-tenant resources per ADR 0024 §2 & ADR 0028 §1):**
   - **Required cost & governance tags on every tenant resource (Standard §13):** `tenant: tenantSlug`, `environment: environment`, `hostingMode: hostingMode`, `costCentre: costCentre` (plus optional `owner`).
   - **Tenant Key Vault (`kv-${sanitizedSlug}-${environment}`):** RBAC-enabled, soft-delete 90 days, purge protection enabled, `publicNetworkAccess: 'Disabled'`, `networkAcls.defaultAction: 'Deny'`, Private Endpoint in `snet-private-endpoints` linked to `privatelink.vaultcore.azure.net`, and `Key Vault Secrets User` role assignment granting the platform's user-assigned Managed Identity access to that tenant's vault (ADR 0024 AG3).
   - **Optional Dedicated PostgreSQL Flexible Server (`deployDedicatedPostgresServer bool = false`, Owner Decision 1 / ADR 0028 §1):**
     - When `deployDedicatedPostgresServer` is `true` (or always in `single_tenant` mode when desired), provisions a dedicated `Microsoft.DBforPostgreSQL/flexibleServers` instance in `snet-postgres` linked to `privatelink.postgres.database.azure.com`, Entra ID auth only (`passwordAuth: 'Disabled'`), TLS 1.2+, PgBouncer enabled, and optional Customer-Managed Key (`dataEncryption` referencing key URI in the tenant's own Key Vault), tagged with the tenant's cost tags so dedicated server cost is attributed directly to that tenant (ADR 0028 `:170`).
     - When `deployDedicatedPostgresServer` is `false`, targets the shared server passed in via `sharedPostgresServerName`.
   - **Per-Tenant Database (`Microsoft.DBforPostgreSQL/flexibleServers/databases`):**
     - Creates `pg_tenant_${replace(tenantSlug, '-', '_')}_${environment}` (`charset: 'UTF8'`, `collation: 'en_GB.utf8'`) on either the dedicated server or the shared server.
   - **Per-Tenant Blob Storage & Defender for Storage (`if (enableCloudBlobStorage)`):**
     - Carries across the hardened `Standard_ZRS` storage account, `tenant-${tenantSlug}-${environment}` private blob container, TLS 1.2, `allowSharedKeyAccess: false`, 30-day soft delete, Private Endpoint in `snet-private-endpoints` (with `privatelink.blob.core.windows.net` DNS zone), `Storage Blob Data Delegator` / `Storage Blob Data Contributor` scoped to the tenant container, and `Microsoft.Security/defenderForStorageSettings` on-upload malware scanning (`capGBPerMonth`), all carrying tenant cost tags.
3. **`core/infra/main.bicep` (rewrite — orchestrator composing `modules/platform.bicep` and `modules/tenant.bicep`):**
   - Supports both deployment topologies from the same Bicep entry point (Rule 6, Standard §7):
     - **Model A (`hostingMode == 'single_tenant'`):** deploys `platform.bicep` + a single `tenant.bicep` for `tenantSlug` in the client's Azure resource group.
     - **Model B (`hostingMode == 'multi_tenant'`):** deploys `platform.bicep` once for the shared environment and loops `[for tenant in tenants: ...]` over `modules/tenant.bicep` (keeping a single-tenant convenience parameter compatibility path when `tenants` has one entry).
   - Exposes clean, non-secret outputs (`containerAppsEnvironmentId`, `webContainerAppName`, `webContainerAppFqdn`, `managedIdentityClientId`, `managedIdentityPrincipalId`, `applicationInsightsName`, `sharedPostgresServerFqdn`, `migrateJobName`, and per-tenant `tenantOutputs` with database name, postgres host, vault URI, and blob container name).
   - Zero secrets in parameters, variables, resources, or outputs (Rule 5).
4. **`core/infra/bicepconfig.json` (new):**
   - Enables strict Bicep linter rules (`no-hardcoded-env-urls`, `no-unused-params`, `no-unused-vars`, `outputs-should-not-contain-secrets`, `secure-secrets-in-params`, `use-recent-api-versions`) so `az bicep lint` / `bicep lint` fails on any warning or secret-in-output regression.
5. **`.github/workflows/ci.yml` and `scripts/verify-ci.mjs`:**
   - Add a `Validate Bicep templates (build & lint)` step to `.github/workflows/ci.yml` (`verify` job, where `az bicep` is pre-installed on `ubuntu-latest`) running `az bicep build --file core/infra/main.bicep --stdout > /dev/null` and `az bicep lint --file core/infra/main.bicep` (plus `modules/platform.bicep` and `modules/tenant.bicep`).
   - Update `scripts/verify-ci.mjs` to run `bicep build` / `bicep lint` (via `bicep` CLI or `az bicep` when installed locally, failing hard in CI `process.env.CI === 'true'` and printing a clear install notice if neither CLI is present on a developer laptop).

## Tests

- **Bicep compilation & lint verification (CI & local):**
  - `az bicep build --file core/infra/main.bicep` compiles `main.bicep`, `modules/platform.bicep`, and `modules/tenant.bicep` cleanly with zero errors or warnings.
  - `az bicep lint --file core/infra/main.bicep` (and both modules) passes every rule in `core/infra/bicepconfig.json` with zero warnings.
- **Infrastructure contract test (`core/tests/infra-bicep-contract.test.ts` — new Vitest suite):**
  - Parses `core/infra/main.bicep`, `core/infra/modules/platform.bicep`, and `core/infra/modules/tenant.bicep` to assert structural invariants even on developer machines without `az`:
    - Zero `Microsoft.Web/serverfarms` or `Microsoft.Web/sites` resources remain.
    - `Microsoft.App/managedEnvironments`, web `Microsoft.App/containerApps` (`allowInsecure: false`, `minReplicas: 1`), internal PDF converter `Microsoft.App/containerApps` (`external: false`), `Microsoft.App/jobs` (`migrate` + disabled-by-default scheduler jobs), `Microsoft.OperationalInsights/workspaces`, `Microsoft.Insights/components`, and `Microsoft.DBforPostgreSQL/flexibleServers` (`activeDirectoryAuth: 'Enabled'`, `passwordAuth: 'Disabled'`, `require_secure_transport`, `pgbouncer.enabled`) are present.
    - User-assigned Managed Identity and its `Key Vault Secrets User` + `AcrPull` role assignments are declared and referenced via `dependsOn` on the Container Apps and jobs.
    - Both platform and tenant Key Vaults set `publicNetworkAccess: 'Disabled'`, `enableRbacAuthorization: true`, `enablePurgeProtection: true`, and attach `Microsoft.Network/privateEndpoints` on `privatelink.vaultcore.azure.net`.
    - `modules/tenant.bicep` exposes the dedicated Postgres server parameter (`deployDedicatedPostgresServer`) and applies cost tags (`tenant`, `environment`, `hostingMode`, `costCentre`) on every tenant resource.
    - Zero literal secret values appear in any Bicep file or parameter default; all secrets use Key Vault `keyVaultUrl` + `secretRef`.
- **Two-tenant isolation tests:**
  - Existing isolation suites (`core/tests/isolation.test.ts`, `core/tests/key-dates-isolation.test.ts`) continue to pass unchanged; runtime Key Vault secret-resolution two-tenant isolation (ADR 0024 AG3) lands in **S0-13b** alongside the runtime config/telemetry changes.
- **E2E tests:**
  - `npm run e2e` (`e2e/role-journeys.spec.ts`, 9 role journey smoke tests) continues to pass unchanged.

## Help and documentation (rule 11)

- **`src/docs/articles/deployment-and-security.ts`:**
  - Replace App Service (`snet-appservice`, `@Microsoft.KeyVault(...)`, `publicNetworkAccess: 'Enabled'`) references with the Azure Container Apps workload-profiles architecture, internal-only PDF converter Container App, Container Apps `migrate` and scheduled jobs, Key Vault Private Endpoints (`publicNetworkAccess: 'Disabled'`, `privatelink.vaultcore.azure.net`), Log Analytics + Application Insights, and PostgreSQL Flexible Server in `snet-postgres` with Entra ID passwordless auth and PgBouncer.
  - State clearly the **recorded exception to Standard §8.5** (ADR 0028 Decision 1): tenants on the shared hosted PostgreSQL Flexible Server share its platform-managed encryption key (isolated by database-per-tenant and per-tenant Postgres roles in S0-14), while any hosted tenant requiring its own key or CMK is provisioned on a dedicated Flexible Server (`deployDedicatedPostgresServer`) encrypted with a key in that tenant's Key Vault, and Model A firms always have their own server and key.
- **`docs/deployment-and-security-architecture-guide.md`:**
  - Mirror the Container Apps, Private Endpoint Key Vault, PostgreSQL Flexible Server, cost-tag, and Standard §8.5 exception updates so external architecture docs match in-app Help.
- **`docs/release-notes.md`:**
  - Record the move from Azure App Service Bicep to modular Azure Container Apps + PostgreSQL Flexible Server + Key Vault Private Endpoints (`S0-13`).
- **`docs/roadmap/feature-list.md`:**
  - Update row **P12** (`Infrastructure gaps`): record the completed Bicep split (`modules/platform.bicep`, `modules/tenant.bicep`), Container Apps environment/web app/internal PDF converter/jobs, PostgreSQL Flexible Server, Log Analytics & Application Insights, Key Vault Private Endpoints, and tenant cost tags, keeping status `Partly built` until `S0-13b` adds runtime telemetry, the `PLATFORM_ENVIRONMENT` production guard (`R371`), and live Azure `what-if`/deployment verification.

## Acceptance criteria

- `core/infra/main.bicep` is split into `core/infra/modules/platform.bicep` and `core/infra/modules/tenant.bicep`, supporting both `single_tenant` (Model A) and `multi_tenant` (Model B).
- App Service resources are replaced by a workload-profiles Container Apps environment, web Container App (`minReplicas: 1`, external HTTPS), internal-only PDF converter Container App, `migrate` Container Apps job, and disabled-by-default scheduler job resources.
- A user-assigned Managed Identity is granted `Key Vault Secrets User` and `AcrPull` before the Container Apps and jobs are created.
- PostgreSQL Flexible Server is provisioned in a delegated subnet with `privatelink.postgres.database.azure.com`, TLS enforced, PgBouncer enabled, Entra ID sign-in only (`passwordAuth: 'Disabled'`), Burstable default SKU for `dev`/`test`, and a per-tenant `deployDedicatedPostgresServer` option.
- Platform and per-tenant Key Vaults use Private Endpoints (`publicNetworkAccess: 'Disabled'`), and zero secrets exist in Bicep or parameters.
- Per-tenant resources carry cost tags (`tenant`, `environment`, `hostingMode`, `costCentre`).
- `az bicep build` and `az bicep lint` run cleanly in CI, and `npm run ci` passes.
- Help & documentation, architecture guide, release notes, and `feature-list.md` row `P12` are updated.

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Not yet in place. Live deployment, `az deployment group what-if` against a target Azure subscription, and verifying Azure Cost Management tag roll-ups and live Application Insights alert rules wait on subscription access.
- **Azure Key Vault secret population (`docs/roadmap/stage-0-plan.md` §8):** Populating `entra-client-secret`, `auth-secret`, `blob-signing-key`, `anthropic-api-key`, and the rotated `ideal-postcodes-api-key` in Azure Key Vault waits on the first Azure environment deployment.
- **Local workstation Bicep CLI (optional local convenience):** `az` / `bicep` is not currently on `PATH` on the local Windows workstation; GitHub Actions `ubuntu-latest` runs `az bicep build` and `az bicep lint` in CI, and `core/tests/infra-bicep-contract.test.ts` runs locally in Vitest. Installing `Microsoft.Bicep` locally enables local `bicep build`/`lint` inside `npm run ci`.

## Rollback

- Nothing has been deployed to Azure yet (ADR 0024 `:58`), so no cloud state or data migration is affected.
- Reverting the `s0-13-container-apps-infrastructure` merge commit restores the previous `core/infra/main.bicep` and CI/documentation files cleanly.

## Pull request description must state

- **Change class:** Infrastructure (`core/infra/` Bicep modules) plus CI validation and Rule 11 documentation updates.
- **Both hosting models:** `core/infra/main.bicep` composes `modules/platform.bicep` and `modules/tenant.bicep` for both Model A (`hostingMode: 'single_tenant'` in a client's Azure subscription, dedicated compute, server, vault, and CMK) and Model B (`hostingMode: 'multi_tenant'` in 1Squared UK Cloud, shared Container Apps compute and shared PostgreSQL Flexible Server with per-tenant database, per-tenant Key Vault Private Endpoint, per-tenant Blob container, per-tenant cost tags, and optional `deployDedicatedPostgresServer: true` for tenants requiring their own or customer-managed encryption key).
- **Recorded exception (Standard §8.5 / ADR 0028 Decision 1):** Hosted tenants on the shared PostgreSQL Flexible Server share its platform-managed encryption key; tenants needing their own or a CMK use `deployDedicatedPostgresServer: true`.
- **Migration and rollback:** No database or runtime migration; nothing has been deployed yet. Rollback is a clean `git revert`.
- **Manual blockers:** Azure subscription access (`what-if` and first deployment) and operator Key Vault secret population.
