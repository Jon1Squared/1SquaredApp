import type { DocArticle } from '../registry';

export const deploymentAndSecurityArticle: DocArticle = {
  slug: 'deployment-and-security',
  title: 'Deployment models, customisation & security architecture',
  section: 'architecture-security',
  summary:
    'How 1Squared isolates every firm’s data in a dedicated database, supports firm-specific customisations without forking the core, and runs identically in 1Squared UK Cloud or your firm’s own Azure subscription.',
  updated: '2026-11-09',
  body: `
Law firms evaluating practice management platforms traditionally face an uncomfortable compromise between **multi-tenant SaaS** (easy upgrades, but your client and matter records sit in a shared database alongside rival firms) and **bespoke on-premises forks** (isolated infrastructure, but every customisation makes upgrades slow, expensive, and fragile).

1Squared eliminates this compromise by separating **how the software is built and upgraded** from **where your data lives and how it is isolated**.

> Every firm gets a single, continuously upgraded core application, a dedicated private repository for firm-specific configuration and extensions, a physically separate database and storage container (with a dedicated PostgreSQL server and customer-managed key whenever required), and the freedom to run either in 1Squared’s UK-hosted cloud or inside the firm’s own Microsoft Azure tenant.

## 1. The three-layer application architecture

To allow deep firm-specific tailoring while keeping every firm on the same tested release path, 1Squared strictly separates the platform into three layers:

| Architectural Layer | What It Contains | Where It Lives | Security & Upgrade Guarantee |
| --- | --- | --- | --- |
| **Layer 1: Core Application** (\`@platform/core\`) | Practice management domain logic, RBAC, conflict checking, workflows, time & billing, document store abstraction, and UI | Shared platform repository (identical immutable container image for every firm) | Zero client-specific names, branches, or credentials exist in the core. Upgraded continuously with automated regression and isolation tests. |
| **Layer 2: Client Configuration** | Firm branding, terminology, custom fields, workflow rules, role permissions, storage routing, and [SharePoint matter folder templates](/docs/sharepoint-document-store) | Dedicated private repository per firm (\`client-<firm>/config/\`) | Validated against a strict JSON Schema before deployment. Backward-compatible across upgrades. |
| **Layer 3: Client Extensions** | Bespoke workflows, custom calculators, matter lifecycle hooks, custom UI panels, and 3rd-party firm integrations | Dedicated private repository per firm (\`client-<firm>/extensions/\`) | Runs in an isolated extension sandbox with explicit manifest permissions, per-hook timeouts, and circuit breakers. |

### How custom code works safely

When a firm needs custom business logic—such as a bespoke risk-scoring integration or a custom billing export—it is never written as an \`if (client === 'FirmX')\` branch inside the core codebase. Instead:

- **Dedicated Private Repository**: Each firm’s configuration and custom extensions live in their own private repository. When \`PLATFORM_TENANT_PACKAGE_DIR\` is unset, \`scripts/generate-extension-registry.ts\` emits an empty registry (\`[]\`) with zero client imports, so another firm’s code is never packaged into your deployment.
- **Public Extension API Contract**: Extensions import only from the versioned \`@platform/core/api\` contract (such as \`beforeMatterCostsCalculate\`, \`beforeMatterOpen\`, \`afterMatterDocumentsProvisioned\`, or \`beforeMatterDocumentsClose\`) and never reach into core internals.
- **Sandboxed Execution**: Every extension declares its required permissions in an \`extension-manifest.json\`. At build time, \`scripts/generate-extension-registry.ts\` merges the active tenant’s \`config/base.json\` and environment overlay through \`loadAndValidateTenantConfig\`, validates enabled extension manifests, rejects duplicate extension IDs, and emits \`src/platform/generated/extensionRegistry.ts\` so \`src/platform/tenantRuntime.ts\` (guarded by \`import 'server-only'\`) contains zero client-specific paths. At runtime, the Extension Host enforces manifest permissions, wraps every asynchronous hook (\`executeMatterCostsHook\`) in a strict execution timeout (default 2,000 ms), and blocks matter opening (\`allowProceed = false\`) whenever an enabled \`beforeMatterOpen\` hook vetoes the transition, throws an error, times out, or fails to load (note: a CPU-bound synchronous hook cannot be cut short mid-execution by a timer).

## 2. Database, storage & cryptographic isolation

Whether you choose 1Squared Hosted Cloud or Self-Hosted Azure, **no two law firms ever share a database or storage container**. In 1Squared Hosted Cloud (Model B), tenant databases on the shared Azure Database for PostgreSQL Flexible Server use a platform-managed encryption key (a recorded exception to Standard §8.5 in ADR 0028, stated openly to hosted firms), while any firm requiring its own or a Customer-Managed Key (CMK) is provisioned on a dedicated PostgreSQL Flexible Server (\`deployDedicatedPostgresServer: true\` in \`core/infra/modules/tenant.bicep\`).

| Isolation Layer | How 1Squared Protects Your Firm |
| --- | --- |
| **Cryptographic Identity & Tenant Resolution** | The active tenant configuration is loaded via \`getActiveTenantConfiguration()\` (from the configured \`PLATFORM_TENANT_PACKAGE_DIR\`), and the request \`TenantContext\` is resolved by \`resolveCurrentTenantContext()\` from the user’s cryptographically verified Microsoft Entra ID (OIDC) session claims. The tenant configuration is loaded and validated once per process as a read-only cached configuration; a process restart is required to pick up configuration file changes. In the transitional Next.js host, \`resolveCurrentTenantContext()\` binds the session to the active tenant configuration’s \`tenantId\` and rejects any mismatched actor or request \`tenantId\` (\`TENANCY_FORGERY_DETECTED\`); in \`@platform/core\`’s \`resolveTenantFromVerifiedToken()\`, \`single_tenant\` mode cross-checks \`configuredSingleTenantId\` against \`verifiedToken.tenantId\` and \`multi_tenant\` mode binds the context to \`verifiedToken.tenantId\`, never trusting a URL parameter, HTTP header, or form field. |
| **Dedicated Database per Firm** | Each firm has its own dedicated PostgreSQL 16 database (\`pg_tenant_<slug>_<env>\`) on Azure Database for PostgreSQL Flexible Server with Microsoft Entra ID sign-in only (\`passwordAuth: 'Disabled'\`), TLS 1.2+ enforced, and explicit PgBouncer \`TRANSACTION\` pooling on port \`6432\`. |
| **Separate Identities & Per-Tenant Database Privileges** | Infrastructure (\`core/infra/modules/platform.bicep\`) separates two User-Assigned Managed Identities: \`migrateIdentity\` (registered as the PostgreSQL Entra administrator and attached exclusively to the manual \`migrate\` job connecting directly on port \`5432\`) and \`runtimeIdentity\` (attached to the web app and background jobs on PgBouncer port \`6432\`, mapped in PostgreSQL to a non-admin \`NOINHERIT\` login with zero direct table privileges). Every table and sequence in a firm’s database is granted only to that firm’s PostgreSQL role (\`role_tenant_<slug>_<env>\`), and every unit of work runs inside a transaction starting with \`SET LOCAL ROLE\`. |
| **Dedicated File Storage** | Exports and attachments stored by 1Squared reside in a dedicated Azure Blob Storage container per firm (\`tenant-<slug>-<env>\`, \`publicNetworkAccess: 'Disabled'\` behind a Private Endpoint with Microsoft Defender for Storage malware scanning), accessed only through short-lived, tenant-scoped tokens. |
| **Isolated Cache, Search, Telemetry & Background Jobs** | Cache keys, search indices, Log Analytics / Application Insights telemetry, and Container Apps jobs (\`migrate\`, \`store-import\`, and hourly scheduled jobs running bundled \`dist/jobs/\` entry points) carry the firm’s \`tenantId\` and \`correlationId\` (with no client content or personal data) and are monitored by an Azure Monitor scheduled-query alert rule (\`Microsoft.Insights/scheduledQueryRules\`) for job failures or timeouts. |
| **Key Vault Private Endpoints & Cost Attribution** | \`core/infra/main.bicep\` composes \`modules/platform.bicep\` (platform Key Vault for platform-wide secrets only: \`entra-client-secret\`, \`auth-secret\`, \`blob-signing-key\`, \`ideal-postcodes-api-key\`, and \`anthropic-api-key\`) and \`modules/tenant.bicep\` (a dedicated Key Vault per firm, \`kv-<slug>-<env>\`, exporting \`keyVaultName\` and \`keyVaultUri\` so 24-character truncated vault names are never re-derived). All Key Vaults enforce RBAC authorisation (\`Key Vault Secrets User\` granted before Container Apps and jobs are created), 90-day soft delete, purge protection, \`publicNetworkAccess: 'Disabled'\`, \`networkAcls.defaultAction: 'Deny'\`, and Private Endpoints on \`privatelink.vaultcore.azure.net\`. Every per-tenant resource carries mandatory \`tenant\`, \`environment\`, \`hostingMode\`, and \`costCentre\` tags, and \`entraClientId\` and \`entraRedirectUri\` are required deployment parameters with no empty defaults. Address lookup (\`/api/address-lookup\`) and AI matter extraction (\`/api/matters/extract\`) run strictly on the server; no API keys or secrets live in Bicep, code, or configuration files. |

## 3. External document store & SharePoint security

Law firms want their sensitive client files to remain inside their own **Microsoft 365 SharePoint Online** environment rather than being duplicated into a third-party vendor’s cloud. See [SharePoint Document Store & Matter Folder Templates](/docs/sharepoint-document-store) for operational details.

- **Zero Document Copies**: 1Squared stores only lightweight metadata pointers (\`siteId\`, \`driveId\`, \`itemId\`) in its database. Client documents never rest on 1Squared’s servers.
- **Dual-Identity Security Model**:
  1. **User Context (On-Behalf-Of Delegated Token)**: When a fee earner browses, uploads, downloads, or opens a document in Word/Co-Authoring, 1Squared exchanges their signed-in token for a delegated Microsoft Graph token. SharePoint evaluates the individual user’s own Microsoft 365 permissions and records their real name in the Microsoft Purview audit log.
  2. **Provisioning Context (Application Identity with \`Sites.Selected\`)**: Used strictly by background jobs to create matter folder trees and apply security groups. Instead of broad tenant-wide permissions, it uses a Key Vault certificate restricted via \`Sites.Selected\` to only the designated SharePoint matter libraries.
- **Ethical Walls & Drift Reconciliation**: Standard matters inherit permissions cleanly from Department and Team Entra ID security groups (\`{departmentCode}/{teamCode}/{matterFolderName}\`). Restricted matters (including staff matters and matters with \`hasEthicalWall: true\`) fail closed in \`@platform/core\` \`canAccessMatter\` and across every wrapper—even when \`restrictedAccessUserIds\` is empty—denying access to any user who is not a named matter participant or a holder of \`matter:restricted:access\`. In SharePoint, restricted matters automatically break inheritance and apply an explicit allow-list, monitored by an automated **Permission Drift Reconciliation** engine that alerts administrators if permissions are altered directly in SharePoint.

## 4. Deployment models: Hosted vs Self-Hosted

Because tenancy mode is a configuration setting (\`PLATFORM_HOSTING_MODE=multi_tenant\` or \`PLATFORM_HOSTING_MODE=single_tenant\`), the **exact same immutable container build** runs in two deployment topologies:

### Model B: 1Squared Managed Cloud (UK Hosted)

Designed for firms that want a turnkey, zero-maintenance SaaS experience with enterprise-grade isolation.

- **Hosting Location**: 1Squared’s UK Azure production environment (\`uksouth\` primary, \`ukwest\` geo-redundant failover).
- **Compute**: Shared auto-scaling application tier with cryptographic per-request tenant context isolation.
- **Data Isolation**: Dedicated PostgreSQL database per firm, dedicated Azure Blob container per firm, and dedicated Key Vault secret paths.
- **Operations & Upgrades**: 24/7 monitoring, backups, disaster recovery, and zero-downtime rolling upgrades managed entirely by 1Squared.
- **Observability & Privacy-First Telemetry**: Exports OpenTelemetry spans and exceptions via \`@azure/monitor-opentelemetry\` stamped with \`tenantId\` and a validated \`correlationId\` (\`resolveRequestCorrelationId\`), routing pre-request start-up lifecycle events through \`emitPlatformStartupTelemetry\` and stripping all personal data, client content, SQL queries/parameters, and credentials through a recursive deny-list scrubber (including special-category HR fields, IP addresses, file names, message content and search terms). Automatic HTTP and database instrumentation is switched off, so only these scrubbed, tenant-stamped spans are exported. Because Application Insights local authentication is disabled, export signs in with the container's managed identity (\`AZURE_CLIENT_ID\`, granted Monitoring Metrics Publisher) and refuses to start outside \`dev\` if that identity is not configured. In Model A, telemetry export is opt-in via \`APPLICATIONINSIGHTS_CONNECTION_STRING\` (zero network calls when unset).

### Model A: Client Self-Hosted (Dedicated in Your Firm’s Azure)

Designed for firms with strict regulatory, sovereign, or client-mandated policies requiring all compute, network traffic, and data to reside inside their own cloud boundary.

- **Hosting Location**: Deployed directly into the law firm’s own Microsoft Azure subscription via 1Squared’s automated Bicep Infrastructure-as-Code templates (\`core/infra/\`).
- **Compute**: Dedicated Azure Container Apps (plus optional internal-only PDF converter Container App and Container Apps jobs) running in \`single_tenant\` mode inside the firm’s private Virtual Network (VNet).
- **Network & Keys**: Supports ExpressRoute/VPN private peering, Private Endpoints for PostgreSQL/Storage/Key Vault, and full Customer-Managed Keys (CMK) where the firm holds the master encryption keys and can revoke access at any time.
- **Upgrades**: Delivered as signed container images and declarative Bicep templates into the firm’s change-controlled release pipeline.

### Side-by-side comparison

| Dimension | Model B: 1Squared Managed Cloud (Hosted) | Model A: Client Self-Hosted (Firm’s Azure) |
| --- | --- | --- |
| **Application Build** | Identical immutable container image | Identical immutable container image |
| **Tenancy Mode** | \`multi_tenant\` (shared Container Apps compute, isolated data) | \`single_tenant\` (dedicated Container Apps compute & dedicated data) |
| **Database Isolation** | Dedicated PostgreSQL database & role per firm (\`SET LOCAL ROLE\` over PgBouncer \`TRANSACTION\` pooling) | Dedicated PostgreSQL Flexible Server, database & role in firm’s Azure |
| **Document Storage** | Firm’s own M365 SharePoint Online (zero copies in 1Squared) | Firm’s own M365 SharePoint Online (zero copies in 1Squared) |
| **Custom Code & Config** | Firm’s private config & sandboxed extension bundle | Firm’s private config & sandboxed extension bundle |
| **Encryption Keys** | Per-firm Key Vault Private Endpoint; shared Postgres server uses platform-managed key (recorded Standard §8.5 exception) or \`deployDedicatedPostgresServer: true\` for own/CMK key | Firm-owned Azure Key Vault Private Endpoint & Customer-Managed Keys (CMK) |
| **Network Boundary** | TLS 1.3 public ingress with Entra Conditional Access | Optional full private VNet / ExpressRoute / Private Link |
| **Infrastructure Management** | Fully managed by 1Squared SRE (24/7 SLA) | Automated Bicep deployment into firm’s subscription |

## 5. Continuous security verification

Every change to the 1Squared platform must pass automated **Two-Tenant Isolation Tests** and **Platform CI Parity Checks** (\`npm run ci\`) before it can be merged or deployed:

1. **Cross-Tenant ID Tampering**: The test suite provisions two independent firms (*Tenant A* and *Tenant B*) and verifies that if an authenticated user in *Tenant A* attempts to read, modify, or delete a record belonging to *Tenant B* by guessing or tampering with its ID, the data layer returns \`null\` and blocks the request.
2. **Forged Claim Rejection**: The test suite injects mismatched or forged \`tenantId\` parameters into request payloads and verifies that the platform ignores user-supplied tenant fields in favour of the verified OIDC token claim.
3. **Extension Sandbox Enforcement**: Automated tests verify that extensions cannot import core internals, access ungranted permissions, or exceed execution timeouts.
4. **Secret Scanning, Key Vault Ownership, Production Environment & Container Build Parity**: Automated \`gitleaks\` secret scanning (\`.gitleaks.toml\`) blocks hard-coded keys before dependencies install, \`assertTenantOwnsKeyVaultSecretRef\` verifies every \`kv://<vault>/<secret>\` and \`https://<vault>.vault.azure.net/secrets/<secret>\` reference against the tenant's configured \`keyVault.vaultName\` / \`keyVault.vaultUri\` outputs from \`modules/tenant.bicep\` (including 24-character truncated vault names), \`resolveConfiguredEnvironment()\` fails closed in production (\`NODE_ENV=production\`) unless a valid \`PLATFORM_ENVIRONMENT\` is explicitly set, production builds verify under \`PLATFORM_ENVIRONMENT=live\`, and CI builds the non-root Node 24 standalone \`Dockerfile\` and executes \`node dist/jobs/run-job.mjs --list\` inside the container image without \`tsx\` or \`devDependencies\`. Application fonts are self-hosted in \`src/app/fonts/\` via \`next/font/local\`, so builds and client-hosted deployments require no internet access to external font services.

## 6. Prospective client slide deck blueprint (8 slides)

When presenting 1Squared’s security and deployment architecture to prospective law firm Managing Partners, CIOs, or Information Security Officers, use the following 8-slide structure:

1. **Slide 1 — The Law Firm Technology Dilemma**: Contrast legacy shared-table SaaS against un-upgradeable bespoke forks, introducing 1Squared’s principle: *One continuously upgraded core, dedicated firm customisation, and zero shared data*.
2. **Slide 2 — The Three-Layer Architecture**: Visualise Layer 1 (Immutable Core), Layer 2 (Schema-Validated Firm Config), and Layer 3 (Sandboxed Client Extensions in a private repo per firm).
3. **Slide 3 — Six-Layer Data Isolation**: Walk through OIDC Token Identity → Dedicated PostgreSQL Database per Firm → Per-Tenant Role & \`SET LOCAL ROLE\` Object Privileges (\`NOINHERIT\` runtime identity) → Dedicated Blob Storage → Tenant-Prefixed Cache/Jobs → Azure Key Vault Private Endpoints.
4. **Slide 4 — Documents Stay in Your Microsoft 365**: Show how 1Squared stores only pointers while SharePoint enforces per-user permissions via On-Behalf-Of (OBO) tokens and \`Sites.Selected\` provisioning.
5. **Slide 5 — Ethical Walls & Automated Drift Detection**: Show how Department/Team folder inheritance works alongside Restricted Matter lockdowns and automated SharePoint permission drift alerts.
6. **Slide 6 — Deployment Choice: 1Squared UK Cloud vs Your Azure**: Present the side-by-side comparison of **Model B (Turnkey UK Hosted)** and **Model A (Self-Hosted in the Firm’s Azure VNet)**, noting that firms can migrate between models without rewriting config or extensions.
7. **Slide 7 — Upgrades Without Disruption**: Explain expand-then-contract database migrations, semantic extension API versioning, and automated two-tenant isolation testing on every release.
8. **Slide 8 — Compliance & Security Summary**: Highlight UK data residency (\`uksouth\` / \`ukwest\`), zero PII in application logs, dual-identity audit trails, and readiness for ISO 27001 / Law Society Cyber Essentials due diligence.
`,
};
