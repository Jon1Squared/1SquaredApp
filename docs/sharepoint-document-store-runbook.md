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

---

## 1. Create the Entra ID App Registration(s)

1Squared uses **two distinct identity flows** (which can be configured on a single App Registration or separated into a User API App Registration + a Provisioning App Registration):

1. **Delegated User Identity (On-Behalf-Of / OBO Flow):**
   - Used for all interactive user operations (`listItems`, `getItem`, `downloadContent`, `uploadContent`, `createFolder`, `renameItem`, `moveItem`, `deleteItem`, `getWebUrl`, `getEffectiveAccess`).
   - API permissions (Microsoft Graph -> **Delegated permissions**):
     - `Files.ReadWrite.All` (Delegated — strictly bounded by the signed-in user's own SharePoint permissions)
     - `Sites.Read.All` (Delegated)
     - `openid`, `profile`, `email`, `offline_access`
   - Expose an API scope on the 1Squared API App Registration (`api://<client-id>/access_as_user`) so the browser or Next.js server can acquire a user token and exchange it via OBO.

2. **Provisioning Application Identity (App-Only Certificate Flow):**
   - Used **only** by background jobs and admin actions (`testConnection`, `resolveLocation`, `ensureFolderTree`, `getPermissions`, `setPermissions`, `resolvePrincipal`).
   - API permissions (Microsoft Graph -> **Application permissions**):
     - `Sites.Selected` (Application — grants **zero** access to any SharePoint site until explicitly granted per site in Step 3)
     - `Group.Read.All` (Application — optional, used to verify Entra security group object IDs during connection tests)
     - `User.Read.All` (Application — optional, used to resolve `Person.entraObjectId` by UPN for restricted-matter named participants who have not yet signed in)
   - **Never** grant `Sites.FullControl.All` or `Sites.ReadWrite.All` (Application).

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
3. In the tenant configuration (`config/base.json`), reference only the Key Vault secret name in `provisioningAuth.certificateKeyVaultSecretName`:
   ```json
   "provisioningAuth": {
     "mode": "app_registration",
     "tenantId": "<firm-entra-tenant-guid>",
     "clientId": "<provisioning-app-client-guid>",
     "certificateKeyVaultSecretName": "sp-provisioning-cert"
   }
   ```

---

## 3. Grant `Sites.Selected` (`fullcontrol`) on the Target SharePoint Site

Because the provisioning app holds `Sites.Selected`, it cannot access any SharePoint site until a SharePoint Administrator explicitly grants it permission on the target site(s). Managing folder permissions (`breakroleinheritance`, `resetroleinheritance`, and group role assignments) requires the `fullcontrol` role on the target site.

### Option A: Using Microsoft Graph API (Graph Explorer or `az rest`)

First, resolve the SharePoint `siteId`:
```http
GET https://graph.microsoft.com/v1.0/sites/{hostname}:/sites/{sitePath}
```

Then grant `fullcontrol` to the 1Squared Provisioning App Registration on that site (must be called by a SharePoint Administrator):
```http
POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions
Content-Type: application/json

{
  "roles": ["fullcontrol"],
  "grantedToIdentities": [
    {
      "application": {
        "id": "<provisioning-app-client-guid>",
        "displayName": "1Squared Document Store Provisioning"
      }
    }
  ]
}
```

### Option B: Using PnP PowerShell

```powershell
Connect-PnPOnline -Url "https://<tenant>.sharepoint.com/sites/<SiteName>" -Interactive

Grant-PnPAzureADAppSitePermission `
  -AppId "<provisioning-app-client-guid>" `
  -DisplayName "1Squared Document Store Provisioning" `
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

## 6. Run the Connection Test

1. In **Administration › Document Stores & DMS › Document stores**, click **Test connection** on the configured store card.
2. `provider.testConnection()` executes a non-destructive verification check under the provisioning identity and reports:
   - Whether the SharePoint site (`siteId`) is reachable.
   - Whether the document library (`driveId`) is reachable.
   - Whether the provisioning application has `fullcontrol` (`Sites.Selected`) permission on the site.
   - Whether all mapped Department and Team Entra Security Group GUIDs in `documentAccess` resolve in Entra ID.
3. If any check fails, the UI displays a clear, non-sensitive error code and remediation message.

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
