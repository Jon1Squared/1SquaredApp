# 1Squared — SharePoint Document Store Setup & Operations Runbook

This runbook provides step-by-step instructions for setting up and operating the **SharePoint Online Document Store Integration** in both hosting models:

- **Model A (`single_tenant`):** Client-hosted deployment in the law firm's own Azure subscription and Microsoft Entra ID tenant.
- **Model B (`multi_tenant`):** 1Squared-hosted multi-tenant platform in UK South (`uksouth`) / UK West (`ukwest`) connecting to the client firm's SharePoint Online tenant.

Related Architecture Decision Records:
- [ADR-0017: Document Store Provider Abstraction](./decisions/0017-document-store-provider-abstraction.md)
- [ADR-0018: Two-Identity Authentication Model (Delegated OBO + Provisioning `Sites.Selected`)](./decisions/0018-two-identity-authentication-model.md)
- [ADR-0019: Inheritance-Based Document Permission Model](./decisions/0019-inheritance-based-document-permission-model.md)
- [ADR-0020: Document References and Zero-Content Storage](./decisions/0020-document-references-and-zero-content-storage.md)
- [ADR-0021: Matter Folder Template Inheritance Model](./decisions/0021-matter-folder-template-inheritance-model.md)
- [ADR-0023: Least-Privilege SharePoint Access via `Sites.Selected`](./decisions/0023-sharepoint-sites-selected-least-privilege.md)

---

## 1. Create the Entra ID App Registration and Configure Minimum Permissions

1Squared uses **two distinct identity flows** on the configured Entra ID application (`auth.clientId`):

| API / Resource | Permission Name | Type | Purpose in 1Squared |
| :--- | :--- | :--- | :--- |
| **Microsoft Graph** (`00000003-0000-0000-c000-000000000000`) | `Sites.Selected` | **Delegated** | User On-Behalf-Of (OBO) operations (`listItems`, `getItem`, `downloadContent`, `uploadContent`, `createFolder`, `renameItem`, `moveItem`, `deleteItem`, `getWebUrl`, `getEffectiveAccess`) scoped strictly to granted sites (`intersection(appSiteGrant, userSharePointACL)`). |
| **Microsoft Graph** (`00000003-0000-0000-c000-000000000000`) | `Sites.Selected` | **Application** | Background folder provisioning and DriveItem permission management (`testConnection`, `resolveLocation`, `ensureFolderTree`, `getPermissions`, `setPermissions`) on granted sites only. |
| **Office 365 SharePoint Online** (`00000003-0000-0ff1-ce00-000000000000`) | `Sites.Selected` | **Application** | SharePoint REST role inheritance calls (`breakroleinheritance` and `resetroleinheritance`) in `setPermissions` using certificate authentication. |
| **Microsoft Graph** (`00000003-0000-0000-c000-000000000000`) | `User.ReadBasic.All` | **Application** | Used by `resolvePrincipal` (`GET /users/{upn}?$select=id,displayName,mail,userPrincipalName`) to resolve employee Entra Object IDs before first interactive sign-in. |
| **Microsoft Graph** (`00000003-0000-0000-c000-000000000000`) | `GroupMember.Read.All` | **Application** | Used by `resolvePrincipal` (`GET /groups/{id}?$select=id,displayName`) to verify department, team, and oversight Entra security groups. |

- Expose an API scope on the 1Squared App Registration (`api://<client-id>/access_as_user`) alongside standard OIDC scopes (`openid`, `profile`, `email`, `offline_access`) so the server can exchange the user's token via OBO.
- **Fail-Closed Excess-Permission Check (`excess_permissions_consented`):** When `auth.delegatedPermissionScope` is set to `"Sites.Selected"`, 1Squared inspects the `roles` and `scp` claims of acquired tokens (without ever logging token values) and **fails closed** (`code: "misconfigured"`, `reason: "excess_permissions_consented"`) if any of the following tenant-wide permissions remain consented on the application:
  - `Files.Read.All` or `Files.ReadWrite.All`
  - `Sites.Read.All` or `Sites.ReadWrite.All`
  - `Sites.Manage.All` or `Sites.FullControl.All`

### Model A (`single_tenant`) vs Model B (`multi_tenant`)
- **Model A (`single_tenant`):** Register the application as **Single tenant** inside the firm's Entra ID tenant (or use a User-Assigned Managed Identity for the provisioning identity).
- **Model B (`multi_tenant`):** Either register a per-tenant App Registration in the client firm's Entra ID, or register a **Multi-tenant** App Registration in 1Squared's Entra tenant and have the client firm's Global/SharePoint Administrator grant tenant-wide admin consent via:
  ```text
  https://login.microsoftonline.com/{firm-tenant-id}/adminconsent?client_id={app-client-id}
  ```

---

## 2. Upload the Provisioning Certificate to Azure Key Vault

Application-only `Sites.Selected` authentication requires an X.509 certificate stored in Azure Key Vault. Client secrets and private keys must **never** be placed in `base.json`, source code, or git-tracked environment files.

### Generate or Import the Certificate in Key Vault
```powershell
# Create a self-signed or CA-issued certificate directly inside the tenant Key Vault
az keyvault certificate create `
  --vault-name "kv-<tenant-slug>-<env>" `
  --name "sp-provisioning-cert" `
  --policy "$(az keyvault certificate get-default-policy)"

# Download the public .cer file to upload to the Entra App Registration
az keyvault certificate download `
  --vault-name "kv-<tenant-slug>-<env>" `
  --name "sp-provisioning-cert" `
  --file "sp-provisioning-cert.cer" `
  --encoding DER
```

### Attach the Public Certificate to the App Registration
1. In the [Microsoft Entra admin center](https://entra.microsoft.com), open **App registrations › `<1Squared App>` › Certificates & secrets › Certificates**.
2. Click **Upload certificate** and select `sp-provisioning-cert.cer`.
3. In the tenant configuration (`config/base.json`), reference only the Key Vault secret URI in `auth.certificateKeyVaultSecretRef` and set `auth.delegatedPermissionScope` to `"Sites.Selected"`:
   ```json
   "auth": {
     "entraTenantId": "<firm-entra-tenant-guid>",
     "credentialMode": "client_certificate",
     "clientId": "<1squared-app-client-guid>",
     "certificateKeyVaultSecretRef": "kv://kv-<tenant-slug>-<env>/sp-provisioning-cert",
     "delegatedPermissionScope": "Sites.Selected"
   }
   ```

---

## 3. Grant `Sites.Selected` (`fullcontrol`) on Each Target SharePoint Site

Because both the delegated OBO flow and the application provisioning flow use `Sites.Selected` on the same `auth.clientId`, the application has **zero access** to any SharePoint site until a SharePoint Administrator explicitly grants it permission on each configured site.

A **single** site permission grant with `roles: ["fullcontrol"]` for `auth.clientId` authorises both flows:
- **Provisioning (`ProvisioningAccessContext`):** Requires `fullcontrol` on the target site to manage folder role assignments and break/reset role inheritance (`setPermissions`).
- **Delegated User OBO (`UserAccessContext`):** Uses the site grant as an outer boundary while SharePoint strictly enforces the signed-in user's own folder and item permissions (`read`, `contribute`, `edit`, or `none`).

### Option A: Using Microsoft Graph API (Graph Explorer or `az rest`)

First, resolve the SharePoint `siteId`:
```http
GET https://graph.microsoft.com/v1.0/sites/{hostname}:/sites/{sitePath}
```

Then grant `fullcontrol` to the 1Squared App Registration on that site (must be called by a SharePoint Administrator):
```http
POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions
Content-Type: application/json

{
  "roles": ["fullcontrol"],
  "grantedToIdentities": [
    {
      "application": {
        "id": "<1squared-app-client-guid>",
        "displayName": "1Squared Document Store Integration"
      }
    }
  ]
}
```

### Option B: Using PnP PowerShell

```powershell
Connect-PnPOnline -Url "https://<tenant>.sharepoint.com/sites/<SiteName>" -Interactive

Grant-PnPAzureADAppSitePermission `
  -AppId "<1squared-app-client-guid>" `
  -DisplayName "1Squared Document Store Integration" `
  -Site "https://<tenant>.sharepoint.com/sites/<SiteName>" `
  -Permissions FullControl
```

### Option C: Model A (`single_tenant`) with Azure Managed Identity (`credentialMode: "managed_identity"`)

When a firm runs 1Squared in **Model A (`single_tenant`)** using an Azure Managed Identity for background provisioning (`credentialMode: "managed_identity"`) alongside an Entra App Registration for user OBO (`auth.clientId`):
1. Grant `fullcontrol` on each target site to the **OBO App Registration** (`<1squared-app-client-guid>`) using Option A or B above so delegated user operations can reach the site.
2. Also grant `fullcontrol` on each target site to the **Managed Identity Service Principal** (using its Application `appId` GUID):
```powershell
# Look up the Managed Identity's Application ID (appId)
$miSp = Get-MgServicePrincipal -Filter "displayName eq 'mi-1squared-<tenant>-<env>'"

# Grant FullControl on the target SharePoint site to both the OBO App and Managed Identity
Connect-PnPOnline -Url "https://<tenant>.sharepoint.com/sites/<SiteName>" -Interactive
Grant-PnPAzureADAppSitePermission `
  -AppId $miSp.AppId `
  -DisplayName $miSp.DisplayName `
  -Site "https://<tenant>.sharepoint.com/sites/<SiteName>" `
  -Permissions FullControl
```

---

## 4. Create or Identify Entra Security Groups for Departments and Teams

1Squared's inheritance-based security model sets permissions on high-level `{departmentCode}` and `{teamCode}` folders using Entra ID Security Groups:

1. In **Microsoft Entra ID › Groups**, create or identify an Entra **Security Group** (`securityEnabled: true`) for each active Department and Team in 1Squared.
2. Copy each group's immutable **Object ID** (GUID).
3. In 1Squared, navigate to **Administration › Document Stores & DMS › Routing & access** (or edit `documentAccess.departmentGroups` and `documentAccess.teamGroups` in `config/base.json`) and map every active Department and Team to its Entra Security Group Object ID.
4. Configure the store's `accessPolicy`:
   - `departmentGroupLevel`: e.g. `"read"`
   - `teamGroupLevel`: e.g. `"contribute"`
   - `responsiblePartnerLevel`: e.g. `"manage"`
   - `restrictedMatterTeamMemberLevel`: e.g. `"contribute"`
   - `closedMatterLevel`: e.g. `"read"`

---

## 5. Resolve the Site and Library in 1Squared Admin ("Paste-a-URL")

Administrators never need to look up Graph `siteId` or `driveId` GUIDs manually:

1. Open the target SharePoint document library in your browser and copy its URL from the address bar (for example: `https://1squared1.sharepoint.com/sites/NotALawFirm/Not%20A%20Law%20Firm%20Document%20Repository/Forms/AllItems.aspx`).
2. In 1Squared, go to **Administration › Document Stores & DMS › Document stores** (`/admin?tab=document-stores`).
3. Paste the URL into the **Resolve SharePoint Library URL** box and click **Resolve URL**.
4. 1Squared parses the SharePoint URL, calls `provider.resolveLocation()` under the provisioning identity, and populates:
   - `hostname` (e.g. `1squared1.sharepoint.com`)
   - `sitePath` (e.g. `/sites/NotALawFirm`)
   - `siteId` (resolved Graph site identifier)
   - `driveId` (resolved Graph drive identifier)
   - `libraryName` (e.g. `Not A Law Firm Document Repository`)
   - `webUrl`

---

## 6. Run the Connection Test & Scheduled Tenant Health Check

1. In **Administration › Document Stores & DMS › Document stores** (requires `document_store:configure` and `mfaVerified === true`), click **Test connection** on the configured store card. The same verification also runs per tenant via `runTenantSharePointHealthCheckJob` (which requires a valid `tenantId` via `runTenantBackgroundJob`).
2. `provider.testConnection()` executes a non-destructive verification check under the provisioning identity, caches the result per `(tenantId, storeId)`, and reports:
   - **Credentials & least-privilege claims (`checks.credentialsValid`):** Confirms no forbidden broad permissions (`Files.ReadWrite.All`, `Sites.FullControl.All`, etc.) remain consented when `delegatedPermissionScope === "Sites.Selected"`.
   - **Site reachability (`checks.targetSiteReachable`):** Confirms the SharePoint site (`siteId`) has been granted access (otherwise fails closed with `errorCode: "access_denied"`, `errorReasonCode: "site_access_not_granted"`).
   - **Library reachability (`checks.librariesFound`):** Confirms each configured document library (`driveId`) is reachable.
   - **Tri-state site grant role verification (`roleVerificationStatus`):**
     - `"verified"`: `GET /sites/{siteId}/permissions` confirmed `fullcontrol` (`checks.permissionManagementSupported: true`).
     - `"insufficient"`: Fails closed (`errorReasonCode: "site_grant_role_insufficient"`) if the site grant role is only `read` or `write`.
     - `"not_verified"`: If `GET /sites/{siteId}/permissions` returns `403 Forbidden`, reports a warning (`checks.permissionManagementSupported: false`) without crashing or reporting a false pass.
3. When a cached health check is `ok: false`, subsequent user and provisioning operations fail closed immediately. Non-admin users never see GUIDs, `clientId`, `siteId`, or SharePoint hostnames; they see only: `"Documents for this matter are unavailable. Please contact your administrator."`

---

## 7. Reading and Acting on Reconciliation Findings

1Squared runs a tenant-scoped permission reconciliation job (`reconcileTenantDocumentPermissionsJob`) either on schedule or on demand via **Administration › Document Stores & DMS › Access review** (**Run reconciliation**).

| Finding Kind | Severity | Meaning | Recommended Action |
| :--- | :--- | :--- | :--- |
| `inheritance_drift` | `high` | A normal (non-restricted) matter folder has broken permission inheritance in SharePoint, or a restricted matter folder is still inheriting parent permissions. | Click **Repair** to reset inheritance (for normal matters) or break inheritance and apply explicit grants (for restricted matters). |
| `missing_grant` | `warning` / `high` | An expected Entra group or restricted-matter participant grant is missing on a folder. | Click **Repair** to re-apply the expected `PermissionGrant` via `setPermissions`. |
| `unexpected_grant` | `high` | A principal holds permissions on a restricted or department/team folder in SharePoint that is not authorised by 1Squared's `documentAccess` policy. | Review whether someone granted ad-hoc access directly in SharePoint; click **Repair** to enforce 1Squared's intended grant list or **Acknowledge** if intentional. |
| `access_mismatch` | `warning` | 1Squared allowed a user to view a matter, but SharePoint returned `ACCESS_DENIED` (`403`) during a user-context operation. | Verify that the user is a member of the relevant Department or Team Entra Security Group in Microsoft Entra ID, then click **Acknowledge**. |
| `missing_folder` | `high` | A provisioned `MatterDocumentLocation` points to a `providerRootItemId` that no longer exists in SharePoint. | Open the Matter's **Documents** tab and click **Retry provisioning** or **Link existing folder**. |
| `orphaned_group` | `warning` | A Department or Team Entra group GUID in `documentAccess` could not be resolved in Entra ID. | Update the group's Object ID in **Routing & access** and click **Repair**. |

---

## 8. Migrating from `Files.ReadWrite.All` to `Sites.Selected` and Rollback Procedure

### Migrating an Existing v1.x Tenant
During v1.x, `auth.delegatedPermissionScope` retains `"Files.ReadWrite.All"` as the schema fallback so existing tenants do not break on upgrade, while emitting a structured `ConfigDeprecationWarning`. To migrate an existing tenant to `"Sites.Selected"`:
1. In Microsoft Entra ID, add `Sites.Selected` (Delegated and Application on Microsoft Graph) and `Sites.Selected` (Application on Office 365 SharePoint Online) to the 1Squared App Registration and grant admin consent.
2. Have a SharePoint Administrator grant `fullcontrol` on each configured SharePoint site (Step 3).
3. In 1Squared (**Administration › Document Stores & DMS › Document stores**, with MFA verified), change **Delegated Permission Scope** to `Sites.Selected` and click **Save stores configuration** (writes a `config:stores:updated` audit event).
4. Remove `Files.ReadWrite.All` (and any other broad `Files.*.All` / `Sites.*.All` permissions) from the Entra App Registration.
5. Click **Test connection** in 1Squared and confirm `roleVerificationStatus: "verified"`.

### Rollback Procedure
No database migration is involved, and `TenantScopedEncryptedTokenCache` keys user OBO tokens by `scope` (`tenant:{tenantId}:obo:{entraTenantId}:{actorEntraObjectId}:{storeId}:{scope}`). To roll back a tenant to `"Files.ReadWrite.All"` without restarting services or flushing caches:
1. Re-consent `Files.ReadWrite.All` (Delegated) on the Entra ID App Registration if it was revoked.
2. In 1Squared (**Administration › Document Stores & DMS › Document stores**, with MFA verified), set **Delegated Permission Scope** back to `Files.ReadWrite.All` and click **Save stores configuration**.
3. Click **Test connection** to refresh the store's cached health status.
