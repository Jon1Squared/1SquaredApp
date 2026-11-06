# ADR 0024: Host the Application on Azure Container Apps

- **Date:** 2026-11-06
- **Status:** Accepted
- **Roadmap:** Stage 0 decision D1, slice S0-13 (`docs/roadmap/stage-0-plan.md`)

## Context

Section 16 of `docs/architecture-standard.md` confirms "containers (for example Azure Container Apps) with a managed database and Key Vault" as the hosting platform. `core/infra/main.bicep` instead provisions a Linux App Service plan (`P1v3`) and an App Service web app.

The template also names every resource after `tenantSlug`, including the web app, so even `hostingMode: 'multi_tenant'` deploys one compute stack per tenant. Section 8 of the standard asks for a database per tenant on **shared** compute.

The template declares a PDF converter parameter (`enablePdfConverterContainerApp`) and outputs a Postgres database name, but provisions neither. It has no Application Insights.

## Decision

1. **Run the application on Azure Container Apps** in a workload-profiles environment integrated with the VNet. One container image serves both hosting models (standard section 7). Single-tenant or multi-tenant remains configuration (`PLATFORM_HOSTING_MODE`), not code.

2. **Split `main.bicep` into modules.**
   - `modules/platform.bicep` (shared): the Container Apps environment and apps, Log Analytics, Application Insights, the user-assigned managed identity, the VNet, the Key Vault private DNS zone, and a platform Key Vault for platform-wide secrets only (for example the session signing key). No tenant secrets or keys are held in the platform vault.
   - `modules/tenant.bicep` (once per tenant): the tenant's **own Key Vault** (as today, `kv-<tenant>-<environment>`) for its secrets and encryption keys (standard sections 7 and 8.5–8.6), its private endpoint, the tenant's database, storage container and cost tags.

   `main.bicep` composes the two. In Model A (client-hosted), both are deployed once into the firm's subscription. In Model B (hosted), the platform module is deployed once and the tenant module once per firm.

3. **What changes in `core/infra/main.bicep`.**

   | Today | After |
   |---|---|
   | `appServicePlan` (`Microsoft.Web/serverfarms`, P1v3) | Removed. Replaced by `Microsoft.App/managedEnvironments`: workload profiles with the Consumption profile by default, `infrastructureSubnetId` set, and logs sent to Log Analytics. |
   | `webApp` (`Microsoft.Web/sites`, system-assigned identity, `alwaysOn`) | `Microsoft.App/containerApps` web app. External HTTPS ingress with `allowInsecure: false` and target port 3000. Minimum one replica (replaces `alwaysOn`). HTTP scale rule. Liveness and readiness probes. The image comes from the new parameters `containerImage` and `containerRegistryServer`. |
   | System-assigned identity plus the `webAppKeyVaultSecretsUserRole` assignment | A **user-assigned** managed identity (`Microsoft.ManagedIdentity/userAssignedIdentities`), granted Key Vault Secrets User and AcrPull **before** the app is created. A system-assigned identity does not exist until the app does, so it cannot read Key Vault secrets in the first revision. |
   | `@Microsoft.KeyVault(SecretUri=…)` app settings (an App Service-only syntax) | Container Apps `secrets` entries with `keyVaultUrl` and `identity`, referenced by environment variables through `secretRef`. The same secret names are kept (`entra-client-secret`, `auth-secret`, `blob-signing-key`), plus those added in S0-01 (`ideal-postcodes-api-key`, `anthropic-api-key`). |
   | Subnet `snet-appservice` delegated to `Microsoft.Web/serverFarms`; parameter `appServiceSubnetPrefix` | Subnet `snet-aca` delegated to `Microsoft.App/environments` (at least /27); the parameter is renamed `containerAppsSubnetPrefix`. The Key Vault service endpoint is kept. A delegated subnet for the database is added under D3. |
   | Key Vault `networkAcls.virtualNetworkRules` pointing at `snet-appservice` | Each Key Vault (platform and per tenant) is reached through a **private endpoint** (`Microsoft.Network/privateEndpoints`) in a dedicated subnet, with the `privatelink.vaultcore.azure.net` private DNS zone linked to the VNet, and `publicNetworkAccess: 'Disabled'`. Container Apps is not a trusted Azure service for the Key Vault firewall, so the service-endpoint rule is not relied on. Secret retrieval at revision start-up is verified in S0-13. |
   | `enablePdfConverterContainerApp` parameter with no resource | A second container app with **internal ingress only**, deployed when the parameter is true. The web app receives `DOC_CONVERTER_URL` ([ADR 0009](./0009-docx-library-and-pdf-conversion.md)). |
   | No monitoring resources | `Microsoft.OperationalInsights/workspaces` and workspace-based `Microsoft.Insights/components`, with `APPLICATIONINSIGHTS_CONNECTION_STRING` set on the web app. |
   | A `postgresDatabaseName` output but no database | Database resources in the tenant module. Their design is decision D3 (slice S0-14). |
   | No tags | A `tags` object (`tenant`, `environment`, `hostingMode`, `costCentre`) on every resource, for per-tenant cost tracking (standard section 13). |
   | Outputs `webAppName`, `webAppPrincipalId`, `appSettingsKeyVaultReferences` | Outputs `containerAppName`, `containerAppFqdn`, `managedIdentityPrincipalId`, `appInsightsName`. |

   Unchanged:
   - the Key Vault settings (RBAC authorisation, soft delete, purge protection)
   - the optional storage account, blob container and Defender for Storage malware scanning
   - the TLS 1.2 minimum

4. **Scheduled work runs as Container Apps jobs** (`Microsoft.App/jobs` with a schedule trigger) in the same environment. The tenant-aware job runner is decision D6 and is added in slice S0-19.

## Alternatives Considered

- **Keep App Service.** It works, and Key Vault references are simpler. Rejected: it contradicts the confirmed standard, and it has no native scheduled jobs or internal-only companion apps.
- **Azure Kubernetes Service.** More control, but far more to operate for a small team. Rejected.
- **One compute stack per tenant in the hosted model.** Simpler to reason about, but it multiplies cost and contradicts "shared compute, database per tenant". Rejected; isolation comes from the tenant-scoped data layer and the database per tenant.

## Consequences

- **Amendment (6 November 2026, review finding AG3):** Key Vault access is by private endpoint rather than a VNet service-endpoint rule, and each tenant keeps its own Key Vault. In the hosted model the shared app identity is granted Key Vault Secrets User on each tenant's vault. Isolation between tenants rests on the tenant-scoped data layer choosing the right vault, and a two-tenant test in S0-13 proves a request for tenant A never reads tenant B's vault.

- Slice S0-13 rewrites the hosting resources and renames parameters and outputs. Nothing has been deployed yet, so no migration is needed.
- Deployments need a container registry and an image build. Publishing the image from CI is part of S0-13.
- The Help & documentation article `src/docs/articles/deployment-and-security.ts` describes App Service and Key Vault references, so it is updated in S0-13 (rule 11).
- Cost: the web app keeps at least one replica running on the Consumption profile. Dedicated workload profiles can be added for steady load.
