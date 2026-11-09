# S0-13: Container Apps infrastructure

| | |
|---|---|
| Backlog | P12 |
| Decision | [ADR 0024: Host the Application on Azure Container Apps](../../decisions/0024-azure-container-apps-hosting.md) (D1, accepted 6 November 2026); [ADR 0028: Tenant Databases and Repositories](../../decisions/0028-tenant-database-and-repositories.md) §§1–2, 4 (database, roles & encryption keys, accepted 9 November 2026); [ADR 0030: Tenant-Aware Scheduler](../../decisions/0030-tenant-aware-scheduler.md) §§1, 7 (Container Apps jobs & failure alerts, accepted 9 November 2026) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4, Checkpoint 4a) |
| Branch | `s0-13-container-apps-infrastructure`, from `develop`, targeting `develop` |
| Change class | Infrastructure (`core/infra/` Bicep only), plus CI Bicep validation and Rule 11 documentation (`src/docs/articles/`, `docs/`). |
| Size | L |
| Depends on | ADR 0024, ADR 0028 and ADR 0030 accepted (all merged on `develop`). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) for live deployment, `az deployment group what-if`, and live Application Insights alert verification; operator-populated Key Vault secrets (`ANTHROPIC_API_KEY`, rotated `IDEAL_POSTCODES_API_KEY`, Entra client credentials, signing keys) once Azure environments exist. |
| Baseline | `develop` at `52390b9` |

## What exists today

Checked against `develop` (`52390b9`):

1. **Single App Service Bicep file (`core/infra/main.bicep:1-329`):**
   - Provisions a single per-tenant VNet (`vnet-${tenantSlug}-${environment}`, `:73-107`) with one subnet `snet-appservice` (`10.24.1.0/24`) delegated to `Microsoft.Web/serverFarms` (`:84-103`).
   - Truncates Key Vault names to 24 characters (`take('kv-${sanitizedSlug}-${environment}', 24)`, `:62`) and provisions one Key Vault (`:118-143`) with `publicNetworkAccess: 'Enabled'` and a `snet-appservice` service-endpoint ACL (`:131-141`), rather than Private Endpoints with `publicNetworkAccess: 'Disabled'` (ADR 0024 `:39-40, 56`).
   - Provisions a Linux App Service Plan (`P1v3`, `:145-156`) and Linux App Service web app (`Microsoft.Web/sites`, `:172-236`) with a `SystemAssigned` identity granted `Key Vault Secrets User` *after* the web app is created (`:238-246`), naming compute after `tenantSlug` even when `hostingMode == 'multi_tenant'`.
   - Declares `enablePdfConverterContainerApp` (`:37`) and outputs `postgresDatabaseName` (`:327`), `cloudBlobStorageEnabled` (`:328`), and `pdfConverterContainerEnabled` (`:329`), without provisioning any Container Apps environment, PDF converter app, PostgreSQL Flexible Server, Log Analytics workspace, Application Insights resource, alert rules, `migrate` job, `store-import` job, or scheduled jobs.
   - Provisions optional Azure Blob Storage (`Standard_ZRS`, TLS 1.2, `allowBlobPublicAccess: false`, `allowSharedKeyAccess: false`, 30-day soft delete) and Microsoft Defender for Storage on-upload malware scanning (`:248-316`).
2. **CI (`ci.yml` & `scripts/verify-ci.mjs`):**
   - `.github/workflows/ci.yml:21-81` and `scripts/verify-ci.mjs:1-211` do not yet run `az bicep build` or `az bicep lint` on `core/infra/main.bicep`.
   - `az` and `bicep` are pre-installed on GitHub Actions `ubuntu-latest`; the local Windows workstation has `node` (`24.18.0`) and `gitleaks` (`8.30.1`) without `az`/`bicep` on `PATH` (installable via `winget install Microsoft.Bicep`).
3. **Help & documentation (`src/docs/articles/deployment-and-security.ts:1-115`):**
   - Line `46` still describes App Service VNet integration (`snet-appservice`), `publicNetworkAccess: 'Enabled'`, and `@Microsoft.KeyVault(...)` App Service references.
   - Lines `37`, `43`, `86`, and `89` state that hosted tenants never share an encryption key and describe `FORCE ROW LEVEL SECURITY` rather than ADR 0028's accepted design (shared hosted PostgreSQL Flexible Server encrypted with a platform-managed key as a recorded exception to Standard 8.5, optional dedicated server per tenant for own/CMK keys, separate `migrate` admin vs `NOINHERIT` `runtime` Managed Identities, and per-tenant database + object privileges activated per transaction via `SET LOCAL ROLE`).

### Scope boundary with S0-13b

Per WP4 Checkpoint 4a, **S0-13 keeps infrastructure changes strictly Bicep-only in `core/infra/`** (plus CI Bicep checks and Rule 11 documentation). Runtime TypeScript, job bundling (`dist/jobs/run-job.mjs`), `Dockerfile` / `.dockerignore`, `@azure/monitor-opentelemetry` runtime telemetry export, failing closed when `PLATFORM_ENVIRONMENT` is unset under `NODE_ENV=production` (`src/platform/tenantRuntime.ts:533-540`, `R371`), and the two-tenant Key Vault secret-reference isolation test (`ADR 0024` AG3) land immediately next in **S0-13b** (`s0-13b-telemetry.md`).

## Files and changes

1. **`core/infra/modules/platform.bicep` (new — shared platform resources per ADR 0024 §2, ADR 0028 §§1–2, ADR 0030 §§1, 7):**
   - **Networking (preserving and extending existing VNet & Key Vault security):**
     - `Microsoft.Network/virtualNetworks` (`vnet-platform-${environment}` in `multi_tenant`, or `vnet-${tenantSlug}-${environment}` in `single_tenant`) with parameterised CIDR prefixes for hub-and-spoke peering:
       - `snet-aca` (`/27` minimum, default `10.24.0.0/27`, delegated to `Microsoft.App/environments`) for the workload-profiles Container Apps environment.
       - `snet-postgres` (`10.24.1.0/28`, delegated to `Microsoft.DBforPostgreSQL/flexibleServers`) for private PostgreSQL Flexible Server access.
       - `snet-private-endpoints` (`10.24.2.0/27`, private endpoint network policies disabled) for Key Vault (and optional Blob Storage) Private Endpoints.
     - Private DNS zones linked to the VNet: `privatelink.vaultcore.azure.net` and `privatelink.postgres.database.azure.com`.
   - **Observability & Job Failure Alerts (Standard §13, ADR 0030 §7, R412):**
     - `Microsoft.OperationalInsights/workspaces` (Log Analytics workspace, retention configurable by environment, daily quota cap parameter for non-live cost control).
     - `Microsoft.Insights/components` (workspace-based Application Insights, `IngestionMode: 'LogAnalytics'`, `DisableLocalAuth: true`, passing `APPLICATIONINSIGHTS_CONNECTION_STRING` to Container Apps and jobs).
     - **`Microsoft.Insights/scheduledQueryRules` job failure & timeout alert rule (`R412`, ADR 0030 `:112`):** evaluates Log Analytics (`ContainerAppSystemLogs_CL` / `AppTraces` / `AppExceptions`) every 5 minutes and raises a Severity 1/2 alert (routed to an optional parameterised `alertActionGroupId`) whenever any Container Apps job (`migrate`, `store-import`, `key-date-reminders`, `usage-retention-purge`, `enquiry-retention-anonymise`) records a failed replica execution, non-zero exit code, `job.tenant.failed` telemetry event, or replica timeout.
   - **Two Least-Privilege User-Assigned Managed Identities (created BEFORE Container Apps and jobs — ADR 0024 §3, R402):**
     - **`runtimeIdentity` (`id-runtime-${environment}`):** attached to the web Container App, `store-import` job, and scheduled jobs. Granted `Key Vault Secrets User` (`4633458b-17de-408a-b874-0445c86b69e6`) on the platform Key Vault (and per-tenant vaults in `tenant.bicep`) and `AcrPull` (`7f951dda-4ed3-4680-a7ca-43fe172d538d`) on ACR. It is **never** a PostgreSQL server administrator; in Postgres it maps to a plain `LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER` role granted membership in each `role_tenant_<slug>_<env>`, with zero direct table privileges (`R402`).
     - **`migrateIdentity` (`id-migrate-${environment}`):** registered as the PostgreSQL Flexible Server Microsoft Entra administrator (`Microsoft.DBforPostgreSQL/flexibleServers/administrators`), granted `AcrPull` on ACR, and attached **exclusively** to the `migrate` job (and tenant provisioning). Never attached to the web app or scheduled jobs (`R402`).
     - Container Apps and jobs declare explicit `dependsOn` on their identity's RBAC role assignments before pulling images or resolving Key Vault secrets.
   - **Platform Key Vault:**
     - `Microsoft.KeyVault/vaults` (`enableRbacAuthorization: true`, `enableSoftDelete: true`, `softDeleteRetentionInDays: 90`, `enablePurgeProtection: true`, `publicNetworkAccess: 'Disabled'`, `networkAcls.defaultAction: 'Deny'`, `bypass: 'None'`), exposed exclusively via a Private Endpoint in `snet-private-endpoints` registered in `privatelink.vaultcore.azure.net`. Holds platform-wide secrets only (`auth-secret`, hosted `entra-client-secret`, `blob-signing-key`, `ideal-postcodes-api-key`, platform-scoped `anthropic-api-key`).
   - **Shared PostgreSQL Flexible Server (`Microsoft.DBforPostgreSQL/flexibleServers`, ADR 0028 §1, R401, R402):**
     - Provisioned in `snet-postgres` (`delegatedSubnetResourceId`) with `privateDnsZoneArmResourceId` (`privatelink.postgres.database.azure.com`) and `publicNetworkAccess: 'Disabled'`.
     - PostgreSQL version `16`; SKU parameterised with `Burstable` (`Standard_B1ms`) default for `dev`/`test`/`demo` and `GeneralPurpose` for `training`/`live`.
     - **Entra ID authentication only, zero passwords:** `authConfig: { activeDirectoryAuth: 'Enabled', passwordAuth: 'Disabled', tenantId: subscription().tenantId }`, registering **`migrateIdentity` only** (`id-migrate-${environment}`) as Microsoft Entra administrator (`R402`).
     - **TLS & explicit PgBouncer `TRANSACTION` pool mode (`R401`):** `Microsoft.DBforPostgreSQL/flexibleServers/configurations` resources explicitly setting `require_secure_transport = 'ON'`, `ssl_min_protocol_version = 'TLSv1.2'`, `pgbouncer.enabled = 'true'`, and **`pgbouncer.pool_mode = 'TRANSACTION'`**.
     - Backup retention (`7`–`35` days parameterised; geo-redundant configurable for `live` in `ukwest`); platform-managed encryption key on the shared server (ADR 0028 Decision 1 recorded exception to Standard 8.5).
   - **Container Apps Environment & Apps (`Microsoft.App/managedEnvironments` & `Microsoft.App/containerApps`, ADR 0024 §§1–4):**
     - Workload-profiles Container Apps environment (`Consumption` profile enabled by default, parameterised for dedicated profiles) integrated with `snet-aca` and wired to Log Analytics.
     - **Web Container App:** external HTTPS ingress (`external: true`, `allowInsecure: false`, `targetPort: 3000`, `transport: 'auto'`), `minReplicas: 1` (`maxReplicas` parameterised), HTTP scaling rule, liveness/readiness probes, attached **`runtimeIdentity`**, zero inline secret values — all secrets declared via `keyVaultUrl` + `identity: runtimeIdentity.id` and referenced via `secretRef`, alongside non-secret config (`PLATFORM_HOSTING_MODE`, `PLATFORM_ENVIRONMENT`, `PLATFORM_TENANT_PACKAGE_DIR`, `PLATFORM_POSTGRES_HOST`, **`PLATFORM_POSTGRES_PORT: '6432'`** via PgBouncer, `PLATFORM_POSTGRES_CLIENT_ID: runtimeIdentity.properties.clientId`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, and `DOC_CONVERTER_URL` when `enablePdfConverterContainerApp` is `true`).
     - **PDF Converter Internal Container App** (`if (enablePdfConverterContainerApp)`): internal-only ingress (`external: false`, `allowInsecure: false`), `minReplicas: 0`, no external exposure.
   - **Container Apps Jobs (`Microsoft.App/jobs`, ADR 0028 §4, ADR 0030, R401, R402, R403, R404, R407):**
     - **`migrate` job** (`triggerType: 'Manual'`, `replicaTimeout: 1800`, `replicaRetryLimit: 0`): uses the same container image, **`migrateIdentity`**, **direct PostgreSQL port `5432` bypassing PgBouncer** (`PLATFORM_POSTGRES_MIGRATE_PORT: '5432'`, `R401`), and the bundled command override **`['node', 'dist/jobs/run-job.mjs', 'migrate']`** (`R403`, `R404`).
     - **`store-import` job** (`if (enableStoreImportJob)`, default `true` until retired in `S0-20`, `triggerType: 'Manual'`, `replicaTimeout: 1800`, `replicaRetryLimit: 0`, `R404`, `R407`): uses the same container image, **`runtimeIdentity`** on PgBouncer port `6432`, and bundled command **`['node', 'dist/jobs/import-store.mjs']`**, triggered during the zero-write-loss release cut-over (`docs/runbooks/store-cut-over.md`).
     - **Scheduled jobs (parameterised, disabled by default until S0-19 and S0-19b):** `enableSchedulerJobs` (`bool = false`) and per-job toggles (`enableKeyDateRemindersJob`, `enableUsageRetentionPurgeJob`, `enableEnquiryAnonymisationJob`), provisioning `Microsoft.App/jobs` (`triggerType: 'Schedule'`, `cronExpression: '0 * * * *'`, `parallelism: 1`, `replicaCompletionCount: 1`, `replicaRetryLimit: 1`, `replicaTimeout: 1800`) using **`runtimeIdentity`** on PgBouncer port `6432` and bundled command **`['node', 'dist/jobs/run-job.mjs', '<jobKey>']`** (`R404`).
2. **`core/infra/modules/tenant.bicep` (new — per-tenant resources per ADR 0024 §2 & ADR 0028 §1):**
   - **Required cost & governance tags on every tenant resource (Standard §13):** `tenant: tenantSlug`, `environment: environment`, `hostingMode: hostingMode`, `costCentre: costCentre` (plus optional `owner`).
   - **Tenant Key Vault (`take('kv-${sanitizedSlug}-${environment}', 24)`, `R413`):** RBAC-enabled, soft-delete 90 days, purge protection enabled, `publicNetworkAccess: 'Disabled'`, `networkAcls.defaultAction: 'Deny'`, Private Endpoint in `snet-private-endpoints` linked to `privatelink.vaultcore.azure.net`, and `Key Vault Secrets User` role assignment granting `runtimeIdentity` access to that tenant's vault (ADR 0024 AG3). **Outputs both `keyVaultName` and `keyVaultUri`** (`keyVault.properties.vaultUri`) so runtime config and `tenantRegistry.ts` consume the exact 24-character-truncated vault name/URI rather than re-deriving it (`R413`).
   - **Optional Dedicated PostgreSQL Flexible Server (`deployDedicatedPostgresServer bool = false`, Owner Decision 1 / ADR 0028 §1, R401, R402):**
     - When `deployDedicatedPostgresServer` is `true`, provisions a dedicated `Microsoft.DBforPostgreSQL/flexibleServers` in `snet-postgres` (`privatelink.postgres.database.azure.com`), Entra ID auth only (`passwordAuth: 'Disabled'`), **`migrateIdentity` only** as Entra admin (`R402`), TLS 1.2+, explicit `pgbouncer.enabled = 'true'` and **`pgbouncer.pool_mode = 'TRANSACTION'`** (`R401`), optional Customer-Managed Key (`dataEncryption` referencing key URI in the tenant's own Key Vault), and tenant cost tags (ADR 0028 `:170`).
     - When `deployDedicatedPostgresServer` is `false`, targets `sharedPostgresServerName`.
   - **Per-Tenant Database (`Microsoft.DBforPostgreSQL/flexibleServers/databases`):** creates `pg_tenant_${replace(tenantSlug, '-', '_')}_${environment}` (`charset: 'UTF8'`, `collation: 'en_GB.utf8'`).
   - **Per-Tenant Blob Storage & Defender for Storage (`if (enableCloudBlobStorage)`):** hardened `Standard_ZRS` storage account, `tenant-${tenantSlug}-${environment}` private container, TLS 1.2, `allowSharedKeyAccess: false`, 30-day soft delete, Private Endpoint (`privatelink.blob.core.windows.net`), `Storage Blob Data Delegator` / `Storage Blob Data Contributor` scoped to `runtimeIdentity` on the tenant container, and `Microsoft.Security/defenderForStorageSettings` malware scanning, all carrying tenant cost tags.
3. **`core/infra/main.bicep` (rewrite — orchestrator composing `modules/platform.bicep` and `modules/tenant.bicep`):**
   - Supports both Model A (`hostingMode == 'single_tenant'`) and Model B (`hostingMode == 'multi_tenant'`, looping `[for tenant in tenants: ...]` over `modules/tenant.bicep`) from one entry point (Rule 6, Standard §7).
   - Outputs `containerAppsEnvironmentId`, `webContainerAppName`, `webContainerAppFqdn`, `runtimeIdentityClientId`, `migrateIdentityClientId`, `applicationInsightsName`, `jobFailureAlertRuleName`, `sharedPostgresServerFqdn`, `migrateJobName`, `storeImportJobName`, and per-tenant `tenantOutputs` (`postgresDatabaseName`, `postgresHost`, **`keyVaultName`**, **`keyVaultUri`**, `blobContainerName`). Zero secrets in parameters, variables, resources, or outputs (Rule 5).
4. **`core/infra/bicepconfig.json` (new):**
   - Strict Bicep linter rules (`no-hardcoded-env-urls`, `no-unused-params`, `no-unused-vars`, `outputs-should-not-contain-secrets`, `secure-secrets-in-params`, `use-recent-api-versions`).
5. **`.github/workflows/ci.yml` and `scripts/verify-ci.mjs`:**
   - Add `az bicep build` and `az bicep lint` on `core/infra/main.bicep`, `modules/platform.bicep`, and `modules/tenant.bicep` in `.github/workflows/ci.yml` (`verify` job) and `scripts/verify-ci.mjs`.

## Tests

- **Bicep compilation & lint verification (CI & local):**
  - `az bicep build --file core/infra/main.bicep` and `az bicep lint` pass on `main.bicep`, `modules/platform.bicep`, and `modules/tenant.bicep` with zero errors or warnings.
- **Infrastructure contract test (`core/tests/infra-bicep-contract.test.ts` — new Vitest suite):**
  - Asserts structural invariants across `main.bicep`, `modules/platform.bicep`, and `modules/tenant.bicep`:
    - Zero `Microsoft.Web/serverfarms` or `Microsoft.Web/sites` resources remain.
    - Separate **`runtimeIdentity` and `migrateIdentity`** exist (`R402`); only `migrateIdentity` is registered as `Microsoft.DBforPostgreSQL/flexibleServers/administrators` and attached to the `migrate` job (`PORT=5432`), while web, `store-import`, and scheduled jobs use `runtimeIdentity` (`PORT=6432`) and `dependsOn` their RBAC role assignments.
    - Both shared and dedicated PostgreSQL Flexible Servers set `activeDirectoryAuth: 'Enabled'`, `passwordAuth: 'Disabled'`, `require_secure_transport: 'ON'`, `pgbouncer.enabled: 'true'`, and **`pgbouncer.pool_mode: 'TRANSACTION'`** (`R401`).
    - Job commands invoke bundled **`dist/jobs/run-job.mjs`** (`migrate` + scheduler jobs) and **`dist/jobs/import-store.mjs`** (`store-import`), never `scripts/*.ts` or `tsx` (`R404`, `R407`).
    - **`Microsoft.Insights/scheduledQueryRules`** job failure & timeout alert rule is present (`R412`).
    - Platform and tenant Key Vaults set `publicNetworkAccess: 'Disabled'` with Private Endpoints on `privatelink.vaultcore.azure.net`, and `modules/tenant.bicep` outputs `keyVaultName` and `keyVaultUri` (`R413`), `deployDedicatedPostgresServer`, and tenant cost tags, with zero literal secrets.
- **Two-tenant isolation & E2E tests:** `core/tests/isolation.test.ts`, `core/tests/key-dates-isolation.test.ts`, and `npm run e2e` (9 journeys) pass unchanged (runtime Key Vault isolation test lands in `S0-13b`).

## Help and documentation (rule 11)

- **`src/docs/articles/deployment-and-security.ts` and `docs/deployment-and-security-architecture-guide.md`:**
  - Replace App Service (`snet-appservice`, `@Microsoft.KeyVault(...)`, `publicNetworkAccess: 'Enabled'`) and outdated RLS/encryption-key statements (`:37, 43, 46, 86, 89`) with Azure Container Apps, internal PDF converter, `migrate` / `store-import` / scheduled jobs (`dist/jobs/`), Key Vault Private Endpoints (`publicNetworkAccess: 'Disabled'`), Application Insights + job failure alert rules (`R412`), explicit PgBouncer `TRANSACTION` pooling on port `6432` (with `migrate` on direct port `5432`, `R401`), **separate `migrateIdentity` (Entra server admin) vs `NOINHERIT` `runtimeIdentity` with per-tenant object privileges activated via `SET LOCAL ROLE`** (`R402`), and the **recorded exception to Standard §8.5** (shared server platform-managed key vs `deployDedicatedPostgresServer: true`).
- **`docs/release-notes.md` and `docs/roadmap/feature-list.md`:** Record `S0-13` and update **P12** (`Partly built` until `S0-13b` runtime telemetry/guard and live Azure verification).

## Acceptance criteria

- `core/infra/main.bicep` composes `modules/platform.bicep` and `modules/tenant.bicep` for both `single_tenant` (Model A) and `multi_tenant` (Model B).
- Separate `migrateIdentity` (Postgres Entra admin, `migrate` job only, direct port `5432`) and `runtimeIdentity` (non-admin `NOINHERIT` login, web/import/scheduled jobs on PgBouncer port `6432`) are provisioned with RBAC role assignments created before Container Apps and jobs (`R401`, `R402`).
- PostgreSQL Flexible Server explicitly sets `pgbouncer.enabled = 'true'` and `pgbouncer.pool_mode = 'TRANSACTION'`, Entra ID auth only (`passwordAuth: 'Disabled'`), TLS 1.2+, and per-tenant `deployDedicatedPostgresServer` (`R401`).
- Container Apps jobs run bundled `dist/jobs/run-job.mjs` and `dist/jobs/import-store.mjs` (`R404`, `R407`), monitored by a `Microsoft.Insights/scheduledQueryRules` failure/timeout alert rule (`R412`).
- Platform and tenant Key Vaults use Private Endpoints (`publicNetworkAccess: 'Disabled'`), `tenant.bicep` outputs `keyVaultName` and `keyVaultUri` (`R413`), tenant resources carry cost tags, `az bicep build` + `az bicep lint` pass in CI, and `npm run ci` passes.

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Live deployment, `az deployment group what-if`, cost tag roll-ups, and live alert rule firing wait on subscription access.
- **Azure Key Vault secret population (`docs/roadmap/stage-0-plan.md` §8):** Operator secret population waits on first Azure environment deployment.
- **Local workstation Bicep CLI (optional):** `az` / `bicep` runs automatically on GitHub Actions `ubuntu-latest`; `core/tests/infra-bicep-contract.test.ts` runs locally in Vitest.

## Rollback

- Nothing has been deployed to Azure yet (ADR 0024 `:58`); `git revert` restores the previous Bicep and documentation cleanly.

## Pull request description must state

- **Change class:** Infrastructure (`core/infra/` Bicep modules) plus CI Bicep validation and Rule 11 documentation.
- **Both hosting models:** `main.bicep` composes `modules/platform.bicep` and `modules/tenant.bicep` for Model A (`single_tenant`) and Model B (`multi_tenant`, shared Container Apps + shared Flexible Server with `deployDedicatedPostgresServer: true` for own/CMK keys, per-tenant Key Vault Private Endpoints, and cost tags), separating `migrateIdentity` (port `5432`) from `runtimeIdentity` (PgBouncer `TRANSACTION` mode on port `6432`).
- **Recorded exception (Standard §8.5 / ADR 0028 Decision 1):** Shared hosted PostgreSQL Flexible Server uses a platform-managed key; tenants needing their own/CMK key use `deployDedicatedPostgresServer: true`.
- **Migration and rollback:** No database or runtime migration; clean `git revert`.
- **Manual blockers:** Azure subscription access (`what-if`, deployment, live alert verification) and Key Vault secret population.
