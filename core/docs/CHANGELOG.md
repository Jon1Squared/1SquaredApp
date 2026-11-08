# `@platform/core` Changelog

All notable changes to `@platform/core` and `@platform/core-api` are documented in this file.

## 2026-11-08 — Slice S0-12 (Tenant Configuration Reserved Settings & Template Approval Gate)

### Added
- **Reserved Tenant Settings Inspection (`@platform/core`, `core/src/config-engine/index.ts`, `core/schemas/tenant-config.schema.json`):**
  - Added `"x-reserved": { "for": "S0-...", "reason": "..." }` metadata in `core/schemas/tenant-config.schema.json` (and `[x-reserved:S0-...]` descriptions in `TenantConfigurationSchema`) for `branding.accentColorHex` and `branding.logoAssetKey` (`S0-11b`), `matterCosts.*` (`S0-23`), `integrations.pmsConnectionSecretVaultRef`, `integrations.companiesHouseApiKeyVaultRef`, and `integrations.pmsSync.*` (`S0-18`), `customFields` (`S0-17`), and `documentAccess.autoRemediateDrift` (`S0-25`).
  - Exported `ConfigReservedSettingNotice`, `RESERVED_TENANT_CONFIG_SETTINGS` (derived directly from the JSON schema's `x-reserved` entries), `collectStructuredConfigReservedSettings`, and `collectConfigReservedSettings` from `@platform/core`.
  - Extended `validateTenantConfigWithWarnings` to return `reservedSettings: string[]` and `structuredReservedSettings: ConfigReservedSettingNotice[]` alongside `deprecationWarnings` and `structuredDeprecationWarnings`.

### Changed
- **`submitTemplateVersionForApproval` (`core/src/domain/document-generation/approvalWorkflow.ts`):**
  - Enforced `config.documentGeneration.approval.requireApproval` (default `true`): when `requireApproval === false`, submitting a clean, mapped `Draft` template version retires any previously `Active` version and transitions the version and template directly to `'Active'`.

## 2026-11-08 — Slice S0-09 (Tenant Document Repository Entity Repointing and Recipient Matching)

### Added
- **`TenantDocumentRepository.repointMergedEntity`, `snapshotTenantDocumentsAndLinks`, and `restoreTenantDocumentsAndLinks` (`@platform/core`, `core/src/tenancy/documentRepository.ts`):**
  - Added tenant-scoped `repointMergedEntity(ctx, entityType, mergedId, survivorId): number` on `TenantDocumentRepository` (exported via `@platform/core`) to repoint `GeneratedDocumentRecord.primaryClientId` and `GeneratedDocumentRecord.recipientPartyId` and repoint or de-duplicate `DocumentLinkRecord.entityId` within the caller's `ctx.tenantId` partition when an organisation or person record is merged.
  - Added additive tenant-scoped `snapshotTenantDocumentsAndLinks(ctx): { documents: GeneratedDocumentRecord[]; links: DocumentLinkRecord[] }` and `restoreTenantDocumentsAndLinks(ctx, snapshot): void` on `TenantDocumentRepository` so callers can capture and atomically restore a tenant's document and link partition on rollback (validating that every snapshot record belongs to `ctx.tenantId` before modifying the repository).

### Changed
- **`TenantDocumentRepository.listDocumentsForEntity` (`core/src/tenancy/documentRepository.ts`):**
  - Extended `listDocumentsForEntity(ctx, entityType, entityId, options)` so that, in addition to matching `DocumentLinkRecord` entries and `primaryMatterId` / `primaryClientId`, it also matches `GeneratedDocumentRecord.recipientPartyId === entityId` when `entityType` is `'person'` or `'organisation'`, ensuring generated documents addressed to a recipient party are returned by `listDocumentsForEntity` and core `generationService` entity queries after a merge.

## 2026-11-07 — Slice S0-03 (B12, RBAC Registry Additions)

### Added
- **Permission keys (`@platform/core-api`, `core/src/domain/rbac/registry.ts`):**
  - `admin:data_reset` (`requiresMfa: true`, `critical`): granted to `admin` only for non-live data reset and clean-deployment clear operations.
  - `signoff:approve` (`restricted`): granted to `partner`, `managing_partner`, and `admin` for approving or discussing partner sign-off items.
  - `enquiry:anonymise` (`restricted`): granted to `risk_compliance` and `admin` for running enquiry retention anonymisation.
  - `contact:create` and `contact:edit` (`standard`): granted to `fee_earner`, `supervisor`, `partner`, `legal_secretary`, `enquiries_coordinator`, `intake`, `managing_partner`, and `admin` (plus `contact:edit` for `risk_compliance`) for non-employee contact and organisation creation and editing.
- **Ethical walls fail closed (`MatterAccessRecord.hasEthicalWall`, B12):**
  - Added optional `hasEthicalWall?: boolean` to `MatterAccessRecord` (`core/src/domain/rbac/resolver.ts`) and `MatterAccessSubject` (`core/src/domain/document-generation/permissions.ts`).
  - Updated `canAccessMatter` so `Boolean(matter.hasEthicalWall)` marks a matter as restricted even when `isStaffMatter` is `false` and `restrictedAccessUserIds` is empty (`[]`), failing closed unless the actor is a named matter participant or holds `matter:restricted:access`.
