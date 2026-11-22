# `@platform/core` Changelog

All notable changes to `@platform/core` and `@platform/core-api` are documented in this file.

## 2026-11-22 — Extension API v2.1.0 (`S1-03` Intake Check Interfaces, Evidence Storage & Outbox Attachment References)

### Added (Backward Compatible within `^2.0.0`)
- **`CORE_API_VERSION` bumped from `'2.0.0'` to `'2.1.0'` (`@platform/core-api`, `core/src/api/index.ts`, [ADR 0038](../../docs/decisions/0038-intake-check-interfaces-and-manual-adapters.md)):**
  - Existing extensions declaring `^2.0.0` remain compatible without modification.
  - Added intake check provider interfaces (`IdentityVerificationProvider`, `SanctionsPepScreeningProvider`, `ESignatureProvider`, `ClientPaymentRequestProvider`, `TenantIntakeCheckProviders`) and records (`IdentityVerificationRecord`, `SanctionsPepScreeningRecord`, `ESignatureRecord`, `PaymentRequestRecord` with integer `bigint` minor units `amountMinorUnits` and `currency`).
  - Added `DocumentStorageObjectCategory` `'evidence'` on `DocumentStorageProvider.putObject`.
  - Added `'intake_check'` to `FirmAuditRecordType`.
  - Added `MAX_EMAIL_TOTAL_ATTACHMENT_BYTES` (`3_000_000`), `EmailInlineAttachment`, `EmailOutboxAttachmentMetadata`, and extended `OutgoingEmail.attachments` / `EmailOutboxRecord.attachments`.
  - Added `integrations.intakeChecks` (`idVerification`, `sanctionsPep`, `eSignature`, `payments`, each defaulting to `'manual'`) to `TenantConfiguration` schema, Zod parser, and deep-merge defaults.
- **Database Migration `0023` & Manual Providers (`@platform/core`, `core/src/tenancy/`, `core/src/integrations/intake-checks/`):**
  - Added migration `0023_intake_checks_and_outbox_attachments_expand` (`CORE_REQUIRED_SCHEMA_VERSION = '0023'`), `TenantIntakeCheckRepository`, manual provider implementations, and transactional `public.email_outbox_attachments` storage with retention cleanup.
- **Additive v`2.1.0` PDF Converter Additions (`S1-10`, item `46`, `@platform/core-api`, `@platform/core`):**
  - Added optional `tenantId` and `correlationId` inputs on `DocumentPdfConverter.convertDocxToPdf` for zero-PII outbound correlation logging, plus `DocumentPdfConverterMode` (`'builtin' | 'container'`) and `DocumentPdfConverterFallbackMode` (`'builtin' | 'fail'`) on `DocumentGenerationConfig`.
  - Added `HttpPdfConverter` (`60s` default cold-start-tolerant timeout, `25 MiB` DOCX size limit, `%PDF-` signature validation), `FallbackAwarePdfConverter` (structured zero-PII fallback warning logs or fail-closed mode), and `selectDocumentPdfConverter`.

## 2026-11-21 — Extension API v2.0.0 (Least-Privilege `config:read`, `manifest.hooks` Gate & Registry Update)

### Breaking Changes
- **`CORE_API_VERSION` bumped from `'1.1.0'` to `'2.0.0'` (`@platform/core-api`, `core/src/api/index.ts`, [ADR 0037](../../docs/decisions/0037-extension-api-v2-least-privilege-config-context.md)):**
  - Narrowed `ExtensionExecutionContext.config` from `TenantConfiguration` to `TenantConfiguration | undefined` (`readonly config?: TenantConfiguration`).
  - `ExtensionHost` (`core/src/extension-host/index.ts`) populates `ctx.config` only when `'config:read'` is declared in `manifest.permissions` and passes `undefined` otherwise.
  - All hook runners refuse extensions whose `manifest.hooks` omits the invoked hook.
  - Manifests still declaring `^1.0.0` or `^1.1.0` fail closed at registration with `EXTENSION_COMPATIBILITY_ERROR`. See [`core/docs/extension-api-v2-migration.md`](./extension-api-v2-migration.md) for upgrade instructions.

## 2026-11-09 — Slice S0-30 (Employee Identity Binding & Sign-In Email Linking Configuration)

### Added
- **Sign-in email linking configuration (`@platform/core-api`, `@platform/core`, `core/schemas/tenant-config.schema.json`, `core/src/api/index.ts`, `core/src/domain/rbac/registry.ts`, `core/src/config-engine/index.ts`):**
  - Added `RbacEmailLinkingConfig` (`{ enabled: boolean; domains: string[] }`) and optional `emailLinking?: RbacEmailLinkingConfig` on `RbacIdentityMappingConfig` in `@platform/core-api`.
  - Added `rbac.identityMapping.emailLinking` (`enabled` default `true`; `domains` default `[]`, validated as lower-case domain names) to `core/schemas/tenant-config.schema.json`, `TenantConfigurationSchema`, `DEFAULT_RBAC_IDENTITY_MAPPING`, `createDefaultRbacConfig`, and `loadAndValidateTenantConfig`.
- **Entra token email-verification claim (`@platform/core`, `core/src/domain/rbac/entra.ts`):**
  - Added optional `xms_edov?: boolean` to `EntraIdRawTokenClaims`, honoured only when `xms_edov === true`.

## 2026-11-08 — Slice S0-11b (Additive `demo` Environment & Branding Re-reservation)

### Added
- **Additive `demo` Deployment Environment (`@platform/core-api`, `@platform/core`, `core/schemas/tenant-config.schema.json`, `core/infra/main.bicep`):**
  - Added `'demo'` to `PlatformEnvironment`, `TenantConfigurationSchema.shape.environment`, `core/schemas/tenant-config.schema.json`, and `core/infra/main.bicep` (`dev | test | training | demo | live`, default `'dev'`).

### Changed
- **Branding Reservation Metadata (`core/src/config-engine/index.ts`, `core/schemas/tenant-config.schema.json`):**
  - Updated `branding.accentColorHex` and `branding.logoAssetKey` reservation metadata from `S0-11b` to `backlog` (tracked under backlog item `F21`, as the demo tenant uses the standard platform theme and logo).

## 2026-11-08 — Slice S0-12 (Tenant Configuration Reserved Settings & Template Approval Gate)

### Added
- **Reserved Tenant Settings Inspection (`@platform/core`, `core/src/config-engine/index.ts`, `core/schemas/tenant-config.schema.json`):**
  - Added `"x-reserved": { "for": "S0-... | backlog", "reason": "..." }` metadata in `core/schemas/tenant-config.schema.json` and `core/schemas/keyDates.config.schema.json` (and `[x-reserved:...]` descriptions in `TenantConfigurationSchema`) for all 24 reserved tenant settings: `branding.accentColorHex` and `branding.logoAssetKey` (`S0-11b`), `matterCosts.*` (`S0-23`), `integrations.pmsConnectionSecretVaultRef`, `integrations.companiesHouseApiKeyVaultRef`, and `integrations.pmsSync.*` (`S0-18`), `customFields` (`S0-17`), `documentGeneration.usage.retentionMonths` (`S0-19`), `documentGeneration.customDocumentTypes` (`backlog`), `documentAccess.autoRemediateDrift` (`S0-25`), and `keyDates.defaults.teamAssignment`, `keyDates.matterTypes[].defaultRuleSetIds`, `keyDates.limitationRuleSets[].rules[].claimType`, and `keyDates.calendarSync.provider` (`backlog`), recording reserved array settings once at the array node without expanding child fields.
  - Exported `ConfigReservedSettingNotice`, `RESERVED_TENANT_CONFIG_SETTINGS` (derived directly from the JSON schemas' `x-reserved` entries, resolving relative `$ref` files), `collectStructuredConfigReservedSettings`, and `collectConfigReservedSettings` from `@platform/core`.
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
