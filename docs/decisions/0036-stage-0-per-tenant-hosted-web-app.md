# ADR 0036: Stage 0 Per-Tenant Hosted Web App Runtime

- **Date:** 2026-11-20
- **Status:** Accepted (2026-11-20)
- **Related:** [ADR 0024: Host the Application on Azure Container Apps](./0024-azure-container-apps-hosting.md), [ADR 0028: Tenant Databases and Repositories](./0028-tenant-database-and-repositories.md), [ADR 0030: Tenant-Aware Scheduler](./0030-tenant-aware-scheduler.md), [Platform Architecture Standard](../architecture-standard.md) §§2, 4, 7, 8

## Context

Section 7 of `docs/architecture-standard.md` and [ADR 0024](./0024-azure-container-apps-hosting.md) describe Model B (1Squared-hosted multi-tenant) as shared Container Apps web compute hosting multiple firms simultaneously, while isolating each firm's data in its own database, storage container, and Key Vault.

In Stage 0, three concrete constraints mean the hosted **web application** runtime operates as **one Container App and image build per tenant**:

1. `Dockerfile` takes `PLATFORM_TENANT_PACKAGE_DIR` as a required build argument (`scripts/generate-extension-registry.ts` emits `src/platform/generated/extensionRegistry.ts` from that tenant package at build time), rather than promoting one CI-published container image across tenants and loading tenant extensions dynamically at runtime.
2. `src/platform/tenantRuntime.ts` (`getActiveTenantConfiguration` and `resolveCurrentTenantContext`) caches the active process tenant configuration and enforces fail-closed single-active-tenant checks (`TENANCY_FORGERY_DETECTED` if a verified session carries a different `tenantId`). Likewise, `GET /api/health/ready` (`checkTenantReadinessWithCache` in `src/server/healthReadiness.ts`) probes PostgreSQL connectivity and `CORE_REQUIRED_SCHEMA_VERSION` solely for that single process-configured tenant (`R618`).
3. `core/infra/modules/platform.bicep` deploys a tenant-bound web Container App (`ca-web-...`) parameterized for `PLATFORM_TENANT_PACKAGE_DIR`, whereas background job sweeps already iterate `TenantRegistry` and resolve each tenant's own package configuration via `getTenantConfigurationForRegistryEntry` and `resolveVerifiedTenantConfiguration` (`R586`).

There are no hosted production clients in Stage 0 (only the standalone non-live demo deployment `not-a-law-firm` in `rg-onesquared-demo-uksouth`), and the current web runtime already fails closed on any cross-tenant request.

## Decision

1. **Accepted Stage 0 position:** For Stage 0 exit, the hosted web application runtime is **one web Container App (with tenant configuration and extensions built into the image) per tenant**, paired with `PLATFORM_HOSTING_MODE` configuration (`single_tenant` vs `multi_tenant`), dedicated per-tenant PostgreSQL databases (`pg_tenant_<slug>_<env>`), dedicated per-tenant Key Vaults (`modules/tenant.bicep`), and fail-closed cross-tenant session checks (`TENANCY_FORGERY_DETECTED` / `TENANT_CONFIG_MISMATCH`).
2. **Pre-hosted-client removal condition:** Before onboarding the first hosted multi-tenant client, record and execute the transition on the **"Before the first hosted client"** list in `docs/roadmap/stage-0-plan.md`:
   - Build and publish **one immutable container image** from CI (`ci.yml`) and promote that exact digest across environments rather than running per-environment / per-tenant image builds (`Standard §2 & §7`).
   - Load tenant configurations and extension bundles dynamically per verified request (`TenantRegistry` / external package store) on **shared multi-tenant web compute**, and separate Container App readiness from single-tenant database probes (`/api/health/ready`, `R618`; `Standard §7`).
   - Add an automated lint rule requiring client extensions to import only from `@platform/core-api` and extend client-name checks to tenant slugs and `.bicep` / `.bicepparam` files (`Standard §4`).

## Consequences

- Stage 0 remains strictly isolated and fail-closed without premature multi-tenant dynamic extension bundling inside the Next.js server runtime.
- No hosted multi-tenant client may be onboarded onto shared web compute until the prerequisites recorded in `docs/roadmap/stage-0-plan.md` ("Before the first hosted client") are completed.
