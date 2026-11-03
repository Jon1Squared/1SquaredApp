# ADR-0002: Template Storage as Tenant Data and Architectural Layer Separation

- **Date:** 2026-04-20
- **Status:** Proposed

## Context

The Basic Document Generation feature allows client administrators to upload Microsoft Word (`.docx`) templates, map placeholders to application data fields, route templates through an approval workflow, generate documents from client and matter records, and track template usage.

Under Section 4 (*Core versus client separation*) and Section 8 (*Multi-tenancy and data isolation*) of `docs/architecture-standard.md`, we must decide:

1. Whether client-authored Word templates and their field mappings are stored as **tenant data** in the application or as **versioned configuration** in a client repository (`client-<slug>/config/`).
2. How future platform-authored advanced templates (e.g., complex conditional or scripted Precedents built by the platform team) relate to client-authored templates.
3. How the implementation is split between `core/src/` (`@platform/core` and `@platform/core-api`) and `src/` (the Next.js host application) in accordance with ADR-0001 (`docs/decisions/0001-shared-repo-and-transitional-store.md`).

## Decision

### 1. Client-authored templates are tenant data stored in-app

Client-authored `.docx` templates, their version history, placeholder mappings, approval records, generated documents, and usage analytics are classified as **tenant data**:

- **Metadata, mappings, and version state** live in the tenant's own PostgreSQL database (`document_templates`, `document_template_versions`, `documents`, `document_links`, `template_usage_events`, `template_usage_summaries`), accessed exclusively through the tenant-scoped data layer (`core/src/tenancy/`).
- **Binary `.docx` template files and generated document files** live in the tenant's dedicated Azure Blob Storage container (`tenant-<slug>-<env>`), accessed only through short-lived, tenant-scoped tokens.
- **No client template files, placeholder mappings, generated documents, or usage data** are ever stored in the `core` repository.
- To support moving templates between a client's non-production (UAT/Staging) and production tenants without developer intervention, builders with `document_template:build` can export and import a portable **Template Package** (`.docx` binary + versioned JSON manifest of metadata, field mappings, and prompted field definitions). Imported packages always enter the target tenant as a `Draft` and must pass field validation, malware scanning, and approval (`document_template:approve`) before activation.

### 2. Platform-authored advanced templates remain versioned client configuration

When the platform team builds bespoke, complex templates in a future phase (for example, multi-schedule conditional Precedents using a future conditional-clause engine), those definitions may be authored as **client configuration or client extensions** in `client-<slug>/` and deployed through the client pipeline (`docs/architecture-standard.md` Section 4.2), or imported into the tenant database via the same versioned contract. Both mechanisms target the same `DocumentGenerationEngine` and `FieldCatalogue` contracts in `@platform/core-api`.

### 3. Placement across `core/src/` and `src/`

Following Section 4 of the Standard and ADR-0001:

- **`core/src/api/` (`@platform/core-api`)** owns all public contracts: `DocumentPermission`, `FieldCatalogueEntry`, `FieldGroup`, `FieldProviderExtension`, `ExtensionPermission` (`'document:fields:provide'`), `DocumentGenerationEngine`, `DocumentStorageProvider`, template/document/usage record interfaces, and configuration types.
- **`core/src/config-engine/` and `core/schemas/`** own the `documentGeneration.*` configuration schema, defaults, and strict validation.
- **`core/src/tenancy/`** owns the tenant-scoped document/template/usage repository contracts, database migrations (`core/src/tenancy/migrations/`), tenant-scoped Azure Blob Storage adapter, and malware-scan gating.
- **`core/src/domain/document-generation/`** owns the generic, client-agnostic business logic: the versioned Field Catalogue registry, permission resolution (`resolveDocumentPermissions`, `hasDocumentPermission`), approval workflow state machine, the `basic-merge` DOCX generation engine, template package import/export validator, and usage aggregator.
- **`core/src/extension-host/`** owns execution of `FieldProvider` extensions with timeout, error isolation, and manifest permission checks.
- **`core/infra/main.bicep`** owns the Azure Blob Storage, Microsoft Defender for Storage malware scanning, and Key Vault integration.
- **`src/` (Next.js Host Application)** owns the presentation layer and transitional runtime bridge (`src/platform/tenantRuntime.ts`, `src/server/store.ts`, `src/server/services.ts`, `src/app/actions.ts`, and `src/components/*`), wiring the `@platform/core` document generation engine into the Admin Template Builder, Approval Queue, Matter/Client Generation Modal, Saved Documents lists, and Usage Reports.

## Alternatives Considered

1. **Store all client `.docx` templates in `client-<slug>/config/` Git repositories.**
   - *Rejected:* Legal template managers and administrators need to upload, map, preview, and approve Word templates at runtime through the application UI without opening pull requests or triggering CI/CD deployments for routine wording updates.
2. **Implement the document generation engine and field catalogue directly inside `src/domain/`.**
   - *Rejected:* Violates Section 4.1 of the Platform Architecture Standard and ADR-0001. Placing core domain contracts, permissions, and extension points in `core/src/` ensures `@platform/core-api` remains the single contract surface for extensions and keeps the module independent of Next.js UI concerns.

## Consequences

- Client administrators can self-serve template creation, mapping, and approval inside their tenant while preserving strict tenant isolation.
- Moving templates from UAT to Production is supported cleanly via Template Package export/import without bypassing target-tenant approval controls.
- All extension points (`FieldProvider`, `DocumentGenerationEngine`, `DocumentStorageProvider`) live in `@platform/core-api` and are verified by contract and two-tenant isolation tests in `core/tests/`.
