# ADR-0023: Least-Privilege SharePoint Access via `Sites.Selected`

- **Status:** Proposed
- **Date:** 2026-11-05
- **Deciders:** Chief Architect, Security Lead, Head of Engineering
- **Amends:** [ADR-0018: Two-Identity Authentication Model](./0018-two-identity-authentication-model.md)
- **Related:** [ADR-0012](./0012-role-source-of-truth-and-entra-identity-mapping.md), [ADR-0017](./0017-document-store-provider-abstraction.md), [Platform Architecture Standard](../architecture-standard.md)

---

## 1. Context

1Squared integrates with SharePoint Online using the two-identity model defined in [ADR-0018](./0018-two-identity-authentication-model.md):

1. **Delegated User Context (`UserAccessContext`, OAuth 2.0 On-Behalf-Of flow):** Used for all interactive user file and folder operations (`listItems`, `getItem`, `downloadContent`, `uploadContent`, `createFolder`, `renameItem`, `moveItem`, `deleteItem`, `getWebUrl`, `getEffectiveAccess`) so SharePoint enforces the signed-in user's individual permissions and records the user's identity in Microsoft Purview audit logs and version history.
2. **Application Provisioning Context (`ProvisioningAccessContext`, app-only certificate or Managed Identity):** Used exclusively for background folder-tree provisioning, permission inheritance management, reconciliation, location resolution, and connection health checks (`testConnection`, `resolveLocation`, `ensureFolderTree`, `getPermissions`, `setPermissions`, `resolvePrincipal`).

Previously, the default delegated OBO scope in `tenant-config.schema.json`, `core/src/config-engine/index.ts`, and `core/src/integrations/document-stores/tokenCache.ts` was `Files.ReadWrite.All` (creating a discrepancy with `ADR-0018` §2, which had proposed defaulting to `Sites.Selected` under a different field name). While `Files.ReadWrite.All` (Delegated) still respects the signed-in user's SharePoint ACLs, it allows an OBO token issued to 1Squared to reach **every** SharePoint site, OneDrive for Business account, and Microsoft Teams file library that the signed-in user can access across the firm's Microsoft 365 tenant.

Law firm IT and information security teams rightly challenge `Files.ReadWrite.All` during vendor due diligence, and Section 2 of the [Platform Architecture Standard](../architecture-standard.md) requires strict least privilege. Microsoft Graph's `Sites.Selected` permission (available as both a **Delegated** and an **Application** permission) grants **zero access** to any SharePoint site by default until a SharePoint Administrator explicitly grants the application access to named sites via `POST /sites/{siteId}/permissions`.

---

## 2. Decision

### 2.1 Complete Minimum Permission Set

Every SharePoint document store configured for least-privilege mode (`auth.delegatedPermissionScope: "Sites.Selected"`) uses the following complete permission set on the 1Squared Entra ID application registration (`auth.clientId`):

| Resource API | Permission Name | Type | Purpose in 1Squared |
| :--- | :--- | :--- | :--- |
| **Microsoft Graph** (`00000003-0000-0000-c000-000000000000`) | `Sites.Selected` | **Delegated** | Scopes user OBO tokens (`https://graph.microsoft.com/Sites.Selected`) to explicitly granted SharePoint sites only. Effective access is `intersection(appSiteGrant, userSharePointACL)`. |
| **Microsoft Graph** (`00000003-0000-0000-c000-000000000000`) | `Sites.Selected` | **Application** | Scopes app-only Graph provisioning tokens (`https://graph.microsoft.com/.default`) to explicitly granted SharePoint sites only for folder creation and DriveItem permission management. |
| **Office 365 SharePoint Online** (`00000003-0000-0ff1-ce00-000000000000`) | `Sites.Selected` | **Application** | Required for SharePoint REST API calls (`https://{hostname}/_api/web/...`) that break and reset folder role inheritance (`breakroleinheritance` / `resetroleinheritance`) in `setPermissions` using certificate authentication. |
| **Microsoft Graph** (`00000003-0000-0000-c000-000000000000`) | `User.ReadBasic.All` | **Application** | Used by `resolvePrincipal` (`GET /users/{upn}?$select=id,displayName,mail,userPrincipalName`) when resolving an employee's Entra Object ID before they have signed in interactively. |
| **Microsoft Graph** (`00000003-0000-0000-c000-000000000000`) | `GroupMember.Read.All` | **Application** | Used by `resolvePrincipal` (`GET /groups/{id}?$select=id,displayName`) to verify department, team, and oversight Entra security groups during permission compilation and drift reconciliation. |

**Single Site Permission Grant (`roles: ["fullcontrol"]`):**
Because both the delegated OBO flow (`UserAccessContext`) and the application provisioning flow (`ProvisioningAccessContext`) authenticate as the same Entra application (`auth.clientId`), a **single** site permission grant created by the firm's SharePoint Administrator on each configured site (`POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions` with `roles: ["fullcontrol"]` for `application.id = auth.clientId`) authorises both identities:
- For **Provisioning (`ProvisioningAccessContext`)**, `fullcontrol` on the target site enables folder creation (`ensureFolderTree`), permission inspection (`getPermissions`), and role inheritance management (`setPermissions`).
- For **User OBO (`UserAccessContext`)**, the `fullcontrol` site grant acts only as an **outer ceiling** on which site the application can reach; SharePoint Online still strictly enforces the signed-in user's own folder and item permissions (`read`, `contribute`, `edit`, or `none`). A user never gains administrative or `fullcontrol` rights on the site from the application's site grant.

### 2.2 Schema-Validated Configuration and Backward-Compatible Transition (Rule 7)

All SharePoint site and permission settings remain per-tenant configuration validated by `core/schemas/tenant-config.schema.json` and `core/src/config-engine/index.ts` (`DocumentStoreConfig`, `DocumentStoreAuthConfig`, and `SharePointStoreConfig`):

```json
{
  "storeId": "primary-sharepoint",
  "displayName": "Primary Matter Document Store",
  "providerType": "sharepoint",
  "isDefault": true,
  "enabled": true,
  "auth": {
    "entraTenantId": "11111111-2222-3333-4444-555555555555",
    "credentialMode": "client_certificate",
    "clientId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "certificateKeyVaultSecretRef": "kv://kv-tenant-prod/sp-provisioning-cert",
    "delegatedPermissionScope": "Sites.Selected"
  },
  "sharepoint": {
    "hostname": "contoso.sharepoint.com",
    "siteRelativePath": "/sites/LegalMatters",
    "siteId": "contoso.sharepoint.com,22222222-3333-4444-5555-666666666666,77777777-8888-9999-aaaa-bbbbbbbbbbbb",
    "libraries": [
      {
        "libraryId": "matters-active",
        "displayName": "Active Matters",
        "libraryUrlSegment": "Active Matters",
        "driveId": "b!exampleDriveId001"
      }
    ]
  }
}
```

To comply with **Rule 7** (backward compatibility within a major version: additive first, deprecate before removing) and resolve the discrepancy with `ADR-0018`:
1. **v1.x Schema Default Retained:** `auth.delegatedPermissionScope` keeps `"Files.ReadWrite.All"` as the schema and config-engine default throughout v1.x (`tenant-config.schema.json`, `core/src/config-engine/index.ts`, and `tokenCache.ts`). Existing v1.x tenants that omit `delegatedPermissionScope` continue operating without a breaking change on upgrade. `sharepoint.siteId` remains optional so stores can resolve it via `resolveLocation` or `testConnection`.
2. **Structured Deprecation Warning:** Whenever an enabled SharePoint store's effective `delegatedPermissionScope` is `"Files.ReadWrite.All"` (whether set explicitly or inherited from the v1.x default), `collectStructuredConfigDeprecationWarnings` and `validateTenantConfigWithWarnings` emit a `ConfigDeprecationWarning` advising the tenant administrator to migrate to `"Sites.Selected"` before v2.0.
3. **Explicit `"Sites.Selected"` in Reference Config, Runbooks, and Admin UI:** Reference client configurations (`client-not-a-law-firm/config/base.json`) and onboarding runbooks set `"delegatedPermissionScope": "Sites.Selected"` explicitly; the Admin UI (`DocumentStoresAdminPanel.tsx`) lets administrators select `"Sites.Selected"` (marked as recommended) on existing stores and will default to `"Sites.Selected"` when store creation is added.
4. **v2.0 Default Flip:** In v2.0, the schema default flips to `"Sites.Selected"`, and `"Files.ReadWrite.All"` will be removed in a subsequent major release.

### 2.3 Fail-Closed Excess Permission Detection (`excess_permissions_consented`)

In Microsoft Entra ID, requesting `https://graph.microsoft.com/.default` for an application token returns **every** application role currently consented for that service principal. Similarly, an OBO token's `scp` claim reflects consented delegated scopes. If a tenant sets `delegatedPermissionScope: "Sites.Selected"` in 1Squared configuration without revoking legacy tenant-wide permissions in Entra ID, the issued tokens would still carry broad access.

To prevent a false sense of security:
- Both `DocumentStoreTokenService` and `SharePointDocumentStoreProvider` inspect the decoded JWT payload claims (`roles` on application tokens and `scp` on delegated OBO tokens) in memory when `delegatedPermissionScope === "Sites.Selected"`.
- **Raw token strings are never written to logs, audit events, error messages, or responses.**
- If any of the following broad permissions are present in `roles` or `scp` when `delegatedPermissionScope === "Sites.Selected"`:
  - `Files.Read.All`
  - `Files.ReadWrite.All`
  - `Sites.Read.All`
  - `Sites.ReadWrite.All`
  - `Sites.Manage.All`
  - `Sites.FullControl.All`
  the token service and health check **fail closed** with `code: 'misconfigured'` and `reason: 'excess_permissions_consented'`.

### 2.4 Tenant-Scoped Health Check, Tri-State Role Verification, and Error Hygiene

Because 1Squared is a multi-tenant platform where `TenantContext` is derived exclusively from verified token claims (`Rule 4`), SharePoint health checks **never** run at Node.js process startup without a `TenantContext`. Instead, health checks run in two tenant-scoped contexts:
1. **Admin "Test Connection" (`testAdminDocumentStoreConnection`):** Requires `document_store:configure` permission and `mfaVerified === true`.
2. **Scheduled Per-Tenant Background Job (`runTenantSharePointHealthCheckJob`):** Executed via `runTenantBackgroundJob`, which refuses to run without a valid `tenantId` (`TENANCY_JOB_ERROR`).

**Health Check Steps & Tri-State Role Verification (`roleVerificationStatus`):**
- **Step 0 (Least-Privilege Claim Verification):** Verifies that issued tokens do not carry any forbidden broad permissions when `delegatedPermissionScope === "Sites.Selected"`.
- **Step 1 (Site Reachability — `GET /sites/{siteId}`):** If Microsoft Graph returns `403 Forbidden`, fails closed with `errorCode: 'access_denied'`, `errorReasonCode: 'site_access_not_granted'`, and a clear admin diagnostic message (`SharePoint access not granted for site "..."`).
- **Step 2 (Configured Libraries Reachability — `GET /drives/{driveId}`):** Verifies each library in `sharepoint.libraries[]`.
- **Step 3 (Site Permission Grant Role Check — `GET /sites/{siteId}/permissions`):**
  - Only calls endpoints permitted under `Sites.Selected` (never requires `Sites.FullControl.All`).
  - If `GET /sites/{siteId}/permissions` succeeds and confirms `fullcontrol`, reports `roleVerificationStatus: 'verified'` and `checks.permissionManagementSupported: true`.
  - If `GET /sites/{siteId}/permissions` succeeds and shows only `read` or `write`, fails closed with `errorCode: 'access_denied'`, `errorReasonCode: 'site_grant_role_insufficient'`, `roleVerificationStatus: 'insufficient'`, and `checks.permissionManagementSupported: false`.
  - If `GET /sites/{siteId}/permissions` returns `403 Forbidden` (because some SharePoint configurations restrict a `Sites.Selected` app from listing site permission grants), reports `ok: true`, `roleVerificationStatus: 'not_verified'`, `checks.permissionManagementSupported: false`, and an explicit warning — neither crashing nor reporting a false pass.

**Tenant-Scoped Health Caching & Fail-Closed Operations:**
- The health check result is cached per `(tenantId, storeId)` using `buildTenantCacheKey(tenantContext, 'docstore-health', storeId)`.
- If a store's cached health status is `ok: false`, subsequent user and provisioning operations on that store fail closed immediately until a fresh health check succeeds.

**Error Hygiene and Non-Admin User Message:**
- `DocumentStoreErrorCode` remains unchanged (`'not_found' | 'access_denied' | 'conflict' | 'throttled' | 'unavailable' | 'misconfigured' | 'invalid_path' | 'reauthentication_required'`).
- A new optional `DocumentStoreErrorReason` (`'site_access_not_granted' | 'site_grant_role_insufficient' | 'excess_permissions_consented' | 'site_or_drive_mismatch'`) provides structured diagnostics.
- Non-admin users **never** see Entra `clientId` GUIDs, `siteId` values, or SharePoint hostnames. Any store misconfiguration or missing site grant returns the generic British English user message:
  `"Documents for this matter are unavailable. Please contact your administrator."`
- Detailed diagnostic messages are shown only in the Admin Connection Test panel (`mfaVerified === true`) and structured server logs keyed by `correlationId`, `tenantId`, and `storeId`.

### 2.5 Defence-in-Depth Provider Site & Drive Scope Guard (`assertStoreTargetScope`)

Before any Microsoft Graph or SharePoint REST call (`backend.recordCall`) in `SharePointDocumentStoreProvider` (`listItems`, `getItem`, `downloadContent`, `uploadContent`, `createFolder`, `renameItem`, `moveItem`, `deleteItem`, `getWebUrl`, `getEffectiveAccess`, `ensureFolderTree`, `getPermissions`, `setPermissions`), `assertStoreTargetScope` verifies that:
1. `siteId` matches the store's configured `sharepoint.siteId` (or resolved default for that store).
2. `driveId` belongs to one of the libraries configured in `sharepoint.libraries[]` for that store.

Any tampered `siteId`, tampered `driveId`, or cross-tenant `siteId` is rejected with `code: 'access_denied'` and `reason: 'site_or_drive_mismatch'` before any outbound Graph request is made.

### 2.6 Hosting Models (Model A and Model B) and Rollback

- **Model A (`single_tenant`, Client-Hosted Azure):**
  - Supports both `credentialMode: "client_certificate"` (App Registration in the firm's Entra ID with certificate in the firm's Key Vault) and `credentialMode: "managed_identity"` (Azure Managed Identity for background provisioning paired with an Entra App Registration for user OBO).
  - When `credentialMode: "managed_identity"` is used, the firm's SharePoint Administrator grants `Sites.Selected` (`roles: ["fullcontrol"]`) to **both** the Managed Identity service principal and the OBO App Registration on each target site (see the onboarding runbook for the exact PowerShell / Graph commands).
- **Model B (`multi_tenant`, 1Squared-Hosted):**
  - The firm consents the 1Squared multi-tenant application (or per-tenant registration) in their Entra ID tenant with the minimum permission set in §2.1, and their SharePoint Administrator grants `roles: ["fullcontrol"]` on each target matter repository site.
- **Rollback Procedure:**
  - No database migration is required (configuration-only change).
  - Because `TenantScopedEncryptedTokenCache` keys OBO tokens by `scope` (`tenant:${tenantId}:obo:${entraTenantId}:${actorEntraObjectId}:${storeId}:${scope}`), rolling back a tenant from `"Sites.Selected"` to `"Files.ReadWrite.All"` requires only:
    1. Re-consenting `Files.ReadWrite.All` (Delegated) in Entra ID if previously revoked.
    2. Updating `auth.delegatedPermissionScope` back to `"Files.ReadWrite.All"` in Admin → Integrations → Document stores (requires `mfaVerified === true` and writes a `config:stores:updated` audit entry).
    3. Running **Test connection** to refresh the cached store health state. No token cache flush or service restart is needed.

---

## 3. Open Items to Confirm on a Dev M365 Tenant

Before flipping this ADR from **Proposed** to **Accepted**, the following four items must be verified or completed against a live Microsoft 365 developer tenant and recorded in the test log:

1. **DriveItem Permission Mutation under App-Only `Sites.Selected`:** Confirm that `POST /drives/{driveId}/items/{itemId}/invite` and `DELETE /drives/{driveId}/items/{itemId}/permissions/{permId}` succeed using an app-only token holding only Graph `Sites.Selected` (Application) + a site-level `fullcontrol` grant, without `Sites.FullControl.All`.
2. **SharePoint REST Role Inheritance Calls under Certificate Auth:** Confirm that `POST https://{hostname}/sites/{site}/_api/web/lists(guid'...')/items(...)/breakroleinheritance(copyRoleAssignments=false,clearSubscopes=false)` and `resetroleinheritance` succeed using an app-only certificate token carrying SharePoint `Sites.Selected` (`00000003-0000-0ff1-ce00-000000000000/.default`) + a site-level `fullcontrol` grant.
3. **Self-Inspection of Site Permission Grants (`GET /sites/{siteId}/permissions`):** Confirm whether an application holding only `Sites.Selected` + a site-level `fullcontrol` grant can call `GET /sites/{siteId}/permissions` to verify its own grant role, or whether Graph returns `403 Forbidden` (in which case the health check's `roleVerificationStatus: 'not_verified'` warning path is exercised).
4. **Health Status Cache Location:** Move the per-`(tenantId, storeId)` health status cache (`setStoreHealthResult` / `getStoreHealthResult`) out of `MockSharePointGraphBackend` into a core tenant-keyed store independent of the backend before a real Microsoft Graph backend replaces the mock.

---

## 4. Alternatives Considered

| Option | Blast Radius | Supports Per-User OBO | Supports Folder Provisioning & ACLs | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **`Files.ReadWrite.All` (Delegated) + `Sites.FullControl.All` (Application)** | Entire M365 tenant (all SharePoint sites, OneDrive, Teams files) | Yes | Yes | **Rejected (Deprecated in v1.x for Delegated; Forbidden for Application).** Violates least privilege; unacceptable to law firm security teams. |
| **`Sites.ReadWrite.All` (Delegated / Application)** | Every SharePoint site in the M365 tenant | Yes | Cannot break/reset role inheritance without `FullControl` | **Rejected.** Tenant-wide blast radius and insufficient for ACL inheritance management. |
| **`Sites.Selected` (Delegated + Application) + Site-Level `fullcontrol` Grant** | Restricted strictly to explicitly granted SharePoint sites | Yes (`intersection(siteGrant, userACL)`) | Yes (`fullcontrol` on granted sites only) | **Selected.** Meets law firm due-diligence requirements while preserving per-user OBO attribution and automated folder/ACL provisioning. |
| **`Lists.SelectedOperations.Selected` / `Files.SelectedOperations.Selected`** | Library or folder scope | Preview / incomplete parity across SharePoint REST inheritance APIs | Requires site-level coordination for initial grant creation | **Deferred.** Will be re-evaluated once Microsoft Graph provides full general-availability parity for role inheritance management at container scope without SharePoint REST calls. |

---

## 5. Consequences

### Positive
- **Zero Tenant-Wide Blast Radius:** 1Squared cannot access executive, HR, finance, or M&A SharePoint sites, nor any user's personal OneDrive, unless a SharePoint Administrator explicitly grants access to that site ID.
- **Defence-in-Depth Verification:** Even before calling SharePoint, 1Squared verifies that the target `siteId` and `driveId` belong to the tenant's configured store (`assertStoreTargetScope`) and that Entra ID tokens do not carry legacy tenant-wide scopes (`verifyTokenClaimsForSitesSelected`).
- **Smooth v1.x Migration:** Existing tenants continue working while receiving structured deprecation warnings until they complete the site grant and switch `delegatedPermissionScope` to `"Sites.Selected"`.

### Trade-offs & Onboarding Impact
- **One-Time SharePoint Admin Grant Step:** During tenant onboarding (or when adding a new SharePoint site), a SharePoint Administrator must execute a one-time `POST /sites/{siteId}/permissions` (or `Grant-PnPAzureADAppSitePermission -Permissions FullControl`) command for each target SharePoint site. Step-by-step instructions are provided in the [SharePoint Document Store Runbook](../sharepoint-document-store-runbook.md) and in-app Help & Documentation.
