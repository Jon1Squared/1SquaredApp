# 1Squared — Release Notes

## Unreleased — External Document Store Integration (Phase 1: SharePoint Online)

### Change Classification (Platform Architecture Standard Section 14)

- **Core Feature (`@platform/core`):**
  - Provider-agnostic `DocumentStoreProvider` abstraction (`core/src/domain/documents/` and `core/src/integrations/document-stores/`).
  - SharePoint Online provider (`SharePointDocumentStoreProvider`) using Microsoft Graph v1.0 for folder/file operations and SharePoint REST (`breakroleinheritance` / `resetroleinheritance`) for folder permission inheritance management.
  - Two-identity security model:
    - `user` access context: On-Behalf-Of (OBO) delegated Graph token exchange so SharePoint enforces each user's own permissions and records their identity in its audit trail.
    - `provisioning` access context: Application-only certificate authentication (`Sites.Selected` `fullcontrol` on the target site only) restricted to background jobs and admin connection/location/permission operations.
  - Per-tenant, per-user AES-256-GCM encrypted OBO token cache (`EncryptedUserTokenCache`) keyed by `${tenantId}:${entraObjectId}`.
  - Inheritance-based security model (`{departmentCode}/{teamCode}/{matterFolderName}`) mapped to Microsoft Entra ID security groups, with restricted-matter inheritance breaking and closed-matter read-only locking.
  - Matter folder template engine supporting three-tier inheritance (`workType → department → default`) with `extends` (deep merge by path) and `replace` modes.
  - Matter lifecycle background jobs (`provisionMatterDocumentsJob`, `reconcileMatterPermissionsOnTeamChangeJob`, `applyMatterRestrictionDocumentsJob`, `applyMatterClosureDocumentsJob`, `linkExistingMatterFolderJob`) and permission drift reconciliation (`reconcileTenantDocumentPermissionsJob`).
  - 7 new RBAC permissions registered in `PERMISSION_REGISTRY`: `document:download`, `document:upload`, `document:edit`, `document:provision`, `document_store:configure`, `document_template:configure`, and `document_access:review`.
  - Admin UI (**Administration › Document Stores & DMS**: Document stores, Routing & access, Folder templates, Access review) and Matter UI (**Matter › Documents**: SharePoint Document Store browser, breadcrumb navigation, drag-and-drop upload, effective-access gating, deep links to SharePoint & Desktop Office apps, and link-existing-folder workflow).
- **Core Extension Point (`@platform/core/api`):**
  - Exported `DocumentStoreProvider`, `UserAccessContext`, `ProvisioningAccessContext`, `DocumentStoreCapabilities`, `GroupMembershipSync` (Phase 2 interface), and lifecycle hooks `afterMatterDocumentsProvisioned` and `beforeMatterDocumentsClose`. Additive minor extension API update (`1.1.0`).
- **Configuration Options (`core/schemas/tenant-config.schema.json`):**
  - Added optional `documentStores`, `documentRouting`, `matterFolderNameTemplate`, `documentAccess`, and `matterFolderTemplates` sections to `TenantConfigSchema`, plus cross-entity validation (`validateDocumentConfigAgainstTenantData`).
- **Client Configuration (`client-not-a-law-firm/config/base.json`):**
  - Configured the demo tenant's SharePoint store (`1squared1.sharepoint.com`, `/sites/NotALawFirm`, `Not A Law Firm Document Repository`), routing rules, 11 department + 16 team Entra security group mappings, and default + Conveyancing + Litigation folder templates.

### Hosting Model Compatibility (Model A `single_tenant` & Model B `multi_tenant`)
- The identical build runs in both `single_tenant` (Model A, client-hosted Azure with Managed Identity or client App Registration) and `multi_tenant` (Model B, 1Squared-hosted with per-tenant App Registration or multi-tenant App Registration with admin consent).
- Zero document content, file bytes, or SharePoint item listings are cached or persisted in 1Squared databases or storage.

### Database Migrations & Rollback (`0002_document_store_integration_expand`)
- **Expand Migration (`0002_document_store_integration_expand`):**
  - Creates tenant-scoped tables `matter_document_locations` (with Row-Level Security `rls_matter_document_locations_tenant`) and `document_reconciliation_findings` (with RLS `rls_document_reconciliation_findings_tenant`).
  - Adds nullable `entra_object_id`, `restricted_access`, and `folder_template_id` columns.
- **Rollback (`downSql`):**
  - Drops RLS policies and tables `document_reconciliation_findings` and `matter_document_locations`, and drops the additive columns safely.

---

## Security, Tenancy & Architecture Standard Remediation (`feat/platform-architecture-standard`)

### Breaking & Operational Changes
- **Demo Mode (`featureFlags.enableDemoMode`):**
  - `featureFlags.enableDemoMode` now defaults to `false` in `base.json` and is enabled only in `config/environments/dev.json`.
  - Schema and runtime validation reject `featureFlags.enableDemoMode: true` whenever `environment === 'live'`.
  - Demo Mode persona switching requires `featureFlags.enableDemoMode === true`, `environment !== 'live'`, `NODE_ENV !== 'production'`, `firmSettings.demoMode === true`, and verifies that the signed-in actor holds every permission of the target persona and can access every restricted/staff matter (`restrictedAccessUserIds`) accessible to the target persona.
- **Scoped Blob Download Token Signing (`PLATFORM_BLOB_SIGNING_KEY`):**
  - `PLATFORM_BLOB_SIGNING_KEY` must be configured in Key Vault / environment in non-test environments (`resolveTenantBlobSigningKey`). The legacy static fallback key has been removed, and signature verification uses constant-time `crypto.timingSafeEqual`.
- **Transitional Local Store (`data/runtime-store.json`):**
  - Local runtime state writes to the git-ignored `data/runtime-store.json` (bootstrapped from the tracked seed snapshot `data/seed-not-a-law-firm.json`), preventing dirty working trees during development and testing.
  - All invented employee and client fixture email addresses now use RFC 2606 reserved domains (`notalawfirm.example`, `*.example`, `example.com`) and Ofcom drama telephone ranges.
- **Entra ID Session & RBAC Isolation:**
  - `TenantContext` requires a branded `VerifiedSessionActorInput` minted exclusively by `src/server/entraAuth.ts`.
  - In `hybrid` authority mode, token-derived roles are scoped strictly per `(tenantId, personId)` to the active session/request and cleared on `POST /api/auth/logout`.
  - `getEmployeeDetailsForUser` returns `sensitive: null` unless `logViewSensitive: true` is passed (which records a `view-sensitive` audit entry).
- **Key Dates & Limitation Governance:**
  - Limitation date calculations are verified server-side against the `(ruleSetId, ruleId)` pair in tenant configuration.
  - Superseding a confirmed calculated key date to a different due date (or after its limitation rule set has been retired from configuration) requires `keydate:override_calculation` and a recorded override reason, writing a `keydate-override-calculation` audit entry.
  - Reminder task idempotency keys are tenant-scoped (`keydate-reminder:${tenantId}:${keyDateId}`), and restricted/staff matters with no permitted assignees surface a distinct `restricted_matter_no_permitted_assignee` compliance exception without leaking task details.
  - Phase 1 Calendar Sync is read-only / disabled pending Phase 2 Microsoft Graph calendar integration.
