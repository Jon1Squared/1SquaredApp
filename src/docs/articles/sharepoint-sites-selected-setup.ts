import type { DocArticle } from '../registry';

export const sharepointSitesSelectedSetupArticle: DocArticle = {
  slug: 'sharepoint-sites-selected-setup',
  title: 'Granting least-privilege SharePoint access with Sites.Selected',
  section: 'documents-dms',
  summary:
    'Step-by-step guide for IT and SharePoint Administrators on configuring Microsoft Entra ID permissions, granting per-site Sites.Selected access, verifying health checks, and migrating from Files.ReadWrite.All.',
  updated: '2026-11-05',
  body: `
1Squared uses Microsoft Graph **\`Sites.Selected\`** for both delegated user access (On-Behalf-Of flow) and background folder provisioning. Unlike legacy tenant-wide permissions (\`Files.ReadWrite.All\` or \`Sites.FullControl.All\`), \`Sites.Selected\` grants **zero access** to any SharePoint site, OneDrive account, or Microsoft Teams library until a SharePoint Administrator explicitly grants the 1Squared application access to named matter repository sites.

> **Effective access guarantee**: For interactive user operations, SharePoint Online evaluates \`intersection(appSiteGrant, userSharePointACL)\`. The site-level grant restricts *which sites* the 1Squared application can reach, while SharePoint still strictly enforces each signed-in user's own folder and file permissions.

## 1. Required Microsoft Entra ID permissions

Configure the following exact minimum permission set on the 1Squared application registration (\`auth.clientId\`) in **Microsoft Entra ID → App registrations → API permissions**:

| API / Resource | Permission Name | Type | Purpose |
| --- | --- | --- | --- |
| **Microsoft Graph** (\`00000003-0000-0000-c000-000000000000\`) | \`Sites.Selected\` | **Delegated** | User On-Behalf-Of (OBO) browsing, upload, download, rename, move, and delete on granted sites only |
| **Microsoft Graph** (\`00000003-0000-0000-c000-000000000000\`) | \`Sites.Selected\` | **Application** | Background matter folder provisioning and DriveItem permission management on granted sites only |
| **Office 365 SharePoint Online** (\`00000003-0000-0ff1-ce00-000000000000\`) | \`Sites.Selected\` | **Application** | SharePoint REST role inheritance calls (\`breakroleinheritance\` and \`resetroleinheritance\`) using certificate authentication |
| **Microsoft Graph** (\`00000003-0000-0000-c000-000000000000\`) | \`User.ReadBasic.All\` | **Application** | Resolving employee Entra Object IDs by UPN before first interactive sign-in |
| **Microsoft Graph** (\`00000003-0000-0000-c000-000000000000\`) | \`GroupMember.Read.All\` | **Application** | Verifying department, team, and oversight Entra security groups |

### Forbidden broad permissions in \`Sites.Selected\` mode
When a store is configured with \`delegatedPermissionScope: "Sites.Selected"\`, 1Squared inspects the \`roles\` and \`scp\` claims of acquired tokens (without ever logging token values) and **fails closed** (\`errorCode: "misconfigured"\`, \`errorReasonCode: "excess_permissions_consented"\`) if any of the following tenant-wide permissions remain consented on the application:
- \`Files.Read.All\` or \`Files.ReadWrite.All\`
- \`Sites.Read.All\` or \`Sites.ReadWrite.All\`
- \`Sites.Manage.All\` or \`Sites.FullControl.All\`

## 2. Step-by-step: Granting access to each SharePoint site

Because both the delegated OBO flow and the application provisioning flow use the same \`auth.clientId\`, a **single** \`fullcontrol\` site permission grant on each configured SharePoint site serves both identities:
- **Provisioning identity**: Uses \`fullcontrol\` on that site to create folder hierarchies and manage folder role inheritance.
- **Signed-in user (OBO)**: Uses the same site grant as an outer boundary while SharePoint enforces the user's own \`read\`, \`contribute\`, or \`edit\` permissions.

### Option A: Using PnP PowerShell (Recommended for SharePoint Administrators)

Run the following commands as a **SharePoint Administrator** for each SharePoint site configured in 1Squared:

\`\`\`powershell
# Connect interactively as a SharePoint Administrator
Connect-PnPOnline -Url "https://<firm-tenant>.sharepoint.com/sites/<MatterSite>" -Interactive

# Grant the 1Squared Entra application FullControl on this specific site only
Grant-PnPAzureADAppSitePermission \`
  -AppId "<1Squared-App-ClientId>" \`
  -DisplayName "1Squared Document Store Integration" \`
  -Site "https://<firm-tenant>.sharepoint.com/sites/<MatterSite>" \`
  -Permissions FullControl
\`\`\`

### Option B: Using Microsoft Graph Explorer or \`Invoke-MgGraphRequest\`

\`\`\`http
POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions
Content-Type: application/json

{
  "roles": ["fullcontrol"],
  "grantedToIdentities": [
    {
      "application": {
        "id": "<1Squared-App-ClientId>",
        "displayName": "1Squared Document Store Integration"
      }
    }
  ]
}
\`\`\`

### Hosting Model A (\`single_tenant\`) with Azure Managed Identity
If your firm runs 1Squared in **Model A (\`single_tenant\`, client-hosted Azure)** with \`credentialMode: "managed_identity"\`:
1. Grant the site permission above to the **1Squared OBO App Registration** (\`auth.clientId\`) so delegated user operations can reach the site.
2. Also grant \`roles: ["fullcontrol"]\` on the same site to the **Azure Managed Identity Service Principal** (using its Application \`appId\` in \`grantedToIdentitiesV2.application.id\`) so background provisioning jobs can manage folders and permissions on that site.

## 3. Verifying the connection and site grant in 1Squared

1. Sign in to 1Squared as an administrator with **multi-factor authentication (\`mfaVerified === true\`)** and the \`document_store:configure\` permission.
2. Navigate to **Administration → Document Stores (SharePoint) → 1. Document stores**.
3. Ensure **Delegated Permission Scope** is set to **\`Sites.Selected\` (Least-privilege — Recommended)** and click **Save stores configuration** (this records a \`config:stores:updated\` audit entry).
4. Click **Test connection** on the store card. 1Squared runs a four-step verification and caches the health status per tenant and store:
   - **Credentials valid & least-privilege claims verified**: Confirms no broad permissions (\`Files.ReadWrite.All\`, \`Sites.FullControl.All\`, etc.) remain in the token claims.
   - **Target SharePoint site reachable**: Confirms the site grant exists (otherwise fails closed with \`site_access_not_granted\`).
   - **Document libraries resolved**: Confirms each configured \`driveId\` is reachable.
   - **\`Sites.Selected\` role verification (\`roleVerificationStatus\`)**:
     - \`verified\`: Confirmed \`fullcontrol\` grant on the target site.
     - \`insufficient\`: Fails closed (\`site_grant_role_insufficient\`) if the site grant is only \`read\` or \`write\`.
     - \`not_verified\`: If \`GET /sites/{siteId}/permissions\` returns \`403 Forbidden\`, 1Squared displays a warning badge (\`permissionManagementSupported: false\`) without crashing or reporting a false pass.

> **Non-admin error privacy**: If a SharePoint site grant is missing or misconfigured, fee earners and support staff never see raw GUIDs, \`clientId\` values, \`siteId\` identifiers, or SharePoint hostnames. They see only: *"Documents for this matter are unavailable. Please contact your administrator."*

## 4. Migrating from \`Files.ReadWrite.All\` and rollback procedure

### Migrating an existing v1.x tenant to \`Sites.Selected\`
During v1.x, \`Files.ReadWrite.All\` remains the schema fallback so existing tenants do not break on upgrade, but 1Squared emits a structured \`ConfigDeprecationWarning\` whenever \`Files.ReadWrite.All\` is active. To migrate with zero downtime:
1. Grant \`Sites.Selected\` (Delegated & Application) and SharePoint \`Sites.Selected\` (Application) in Entra ID, and apply the per-site \`fullcontrol\` grant (§2) on each configured site.
2. In **Administration → Document Stores (SharePoint)**, switch **Delegated Permission Scope** to \`Sites.Selected\` and click **Save stores configuration**.
3. Revoke \`Files.ReadWrite.All\` from the Entra ID app registration and click **Test connection** to verify \`roleVerificationStatus: "verified"\`.

### Rollback procedure
Because this is a configuration-only change (no database migration) and the encrypted OBO token cache includes \`scope\` in its cache key (\`tenant:{tenantId}:obo:{entraTenantId}:{userOid}:{storeId}:{scope}\`), rolling back requires no service restart or manual cache flush:
1. Re-consent \`Files.ReadWrite.All\` (Delegated) on the Entra ID app registration if it was removed.
2. In **Administration → Document Stores (SharePoint)** (with MFA verified), set **Delegated Permission Scope** back to \`Files.ReadWrite.All\` and click **Save stores configuration**.
3. Click **Test connection** to refresh the cached health status for the store.
`,
};
