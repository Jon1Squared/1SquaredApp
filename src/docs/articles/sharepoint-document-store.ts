import type { DocArticle } from '../registry';

export const sharepointDocumentStoreArticle: DocArticle = {
  slug: 'sharepoint-document-store',
  title: 'SharePoint document store, matter folder templates & permissions',
  section: 'documents-dms',
  summary:
    'How 1Squared connects to Microsoft SharePoint Online, automatically provisions matter folder trees by work type, enforces per-user permissions and ethical walls, and detects permission drift.',
  updated: '2026-11-03',
  body: `
1Squared connects to your firm’s **Microsoft 365 SharePoint Online** document store model so fee earners can browse, upload, organise, and co-author matter documents inside 1Squared while all files remain governed by SharePoint library and folder permissions. (In Phase 1, \`SharePointDocumentStoreProvider\` runs against the built-in \`MockSharePointGraphBackend\` contract simulation harness; live Microsoft Graph HTTP transport and Key Vault certificate exchange are scheduled for Phase 2.)

> **Core security principle**: Whenever a user views, uploads, downloads, or deletes a document in 1Squared, the action is performed **as that individual user** via Microsoft Graph On-Behalf-Of (OBO) authentication. SharePoint enforces each user’s own permissions and records their identity in the Microsoft 365 audit trail.

## 1. How matter folders are organised in SharePoint

To avoid SharePoint’s 50,000 unique-permission-item threshold and keep permissions fast and auditable, 1Squared uses an **inheritance-based folder hierarchy** inside each configured document library:

\`\`\`
{Document Library Root}/
  └── {departmentCode}/                 ← Department Entra ID group granted access here
        └── {teamCode}/                 ← Team Entra ID group granted access here
              └── {matterFolderName}/   ← Inherits permissions by default
                    ├── 01 Client Care & Compliance/
                    ├── 02 Correspondence/
                    ├── 03 Drafts & Precedents/
                    └── ... (work-type template folders)
\`\`\`

- **Standard Matters (\`securityPolicy: "inherited"\`)**: The matter folder inherits permissions from its parent \`{departmentCode}/{teamCode}\` folder. No unique SharePoint ACL is created on the matter folder itself.
- **Restricted Matters / Ethical Walls (\`securityPolicy: "restricted"\`)**: When a matter is marked as restricted, 1Squared breaks permission inheritance on \`{matterFolderName}\` and applies an explicit allow-list consisting only of the named fee earners and security groups on that matter.
- **Archived / Closed Matters (\`securityPolicy: "read_only"\`)**: When a matter is closed or archived, 1Squared switches the matter folder’s access level to read-only (\`read\`) so historical files remain inspectable without allowing accidental edits.

## 2. Matter folder templates & inheritance

Every new matter automatically receives a structured folder tree based on its **Work Type** or **Department**. Templates support single-level inheritance (\`extends\`) so firms can define a common base layout once and add specialist subfolders per practice area:

| Template Scope | How It Applies | Example Folders |
| --- | --- | --- |
| **Firm Default Template** | Base structure applied to every matter unless overridden | \`01 Client Care & Compliance\`, \`02 Correspondence\`, \`03 Drafts & Documents\`, \`04 Finance & Billing\` |
| **Department Template** | Extends the firm default for a specific department | Adds department-specific folders on top of the base template |
| **Work Type Template** | Extends the department or default template for a specific work type (e.g. *Conveyancing* or *Litigation*) | Adds \`05 Title & Searches\` and \`06 Completion & Post-Completion\` for Conveyancing, or \`05 Pleadings & Court Bundles\` and \`06 Disclosure & Evidence\` for Litigation |

If two templates in an inheritance chain define the same folder path, 1Squared merges their children in declaration order without duplicating folders.

## 3. Using the Documents tab on a matter

Open any matter and select the **Documents (SharePoint)** tab to work with its files:

1. **Provisioning Status Banner**: Shows the connected SharePoint site, document library, relative folder path, security mode (*Inherited*, *Restricted / Ethical Wall*, or *Read-Only*), and last permission verification time.
2. **Folder Tree & Breadcrumbs**: Navigate through the provisioned template folders or create additional subfolders on the fly (when your SharePoint permissions allow \`write\` access).
3. **Upload & Conflict Handling**: Upload documents directly into the active folder. Choose how to handle duplicate filenames:
   - **Rename**: Automatically appends a suffix if a file with the same name exists.
   - **Replace**: Overwrites the existing file and creates a new SharePoint version.
   - **Fail**: Blocks the upload if a file with the same name already exists.
4. **Open in SharePoint / Office Co-Authoring**: Every folder and file includes a deep link to open it directly in SharePoint Online or Microsoft Word/Excel/PDF viewer for real-time co-authoring.
5. **Effective Access Awareness**: 1Squared checks your effective SharePoint permissions (\`canRead\`, \`canWrite\`, \`canDelete\`, \`canManagePermissions\`) and automatically disables upload, create-folder, or delete actions if your SharePoint account only has read access.

## 4. Restricted matters, owning department/team routing & lifecycle updates

### Owning department & team requirement for document routing
Every matter form (**New Matter** and **Edit Matter**) includes explicit **Owning department (document routing)** (\`owningDepartmentId\`) and **Owning team / practice group (document routing)** (\`owningTeamId\`) selectors persisted by \`saveMatterAction\` / \`saveMatterRecord\`. Creating a matter requires \`matter:create\`, editing a matter requires \`matter:edit\` and \`canPersonAccessMatter\`, and changing \`owningDepartmentId\` or \`owningTeamId\` on an existing matter requires \`matter:reassign_ownership\`. Both \`owningDepartmentId\` and \`owningTeamId\` are validated against active \`store.orgStructure\` records (with \`owningTeamId.parentDepartmentId\` required to match \`owningDepartmentId\`). 1Squared never guesses or falls back to the first team in a department: if a matter’s matched routing rule requires a department or \`{teamCode}\` segment and \`owningDepartmentId\` or \`owningTeamId\` is unset, provisioning fails as \`misconfigured\` until an explicit owning department and team are selected on the matter. Note that saving a matter updates SharePoint permissions in place and never moves an already-provisioned SharePoint folder.

### Restricted matters, ethical walls & conflict-on-hire
When a matter is flagged as a staff/restricted matter or has an ethical wall (\`isStaffMatter\` or \`hasEthicalWall\`), 1Squared computes \`isStaffMatter\`, \`hasEthicalWall\`, and \`restrictedAccessUserIds\` authoritatively on the server, breaks permission inheritance on the SharePoint matter folder (\`inheritsFromParent: false\`), and restricts access to the matter’s explicit allow-list (\`restrictedAccessUserIds\`, or the named matter team on an ethical-wall matter) plus oversight roles granted \`matter:restricted:access\`. When a restriction is lifted, 1Squared automatically restores standard Department/Team folder inheritance.

If a person who is an existing client or counterparty on an open matter is subsequently hired as an employee (\`savePersonRecord\`), 1Squared automatically converts the matter to a restricted staff matter (\`isStaffMatter: true\`), locks \`restrictedAccessUserIds\` to the existing matter team (excluding the newly hired employee), and synchronises the SharePoint matter folder to break inheritance and remove broad department and team group grants.

### Lifecycle triggers & permissions for retrying or linking folders
1Squared automatically runs SharePoint lifecycle jobs on the following events:
- **First access or manual provisioning (\`ensureMatterDocumentStoreProvisioned\` / \`browseMatterDocumentStoreFolder\`)**: Automatically provisions the matter’s routed SharePoint folder tree (\`provision_matter_documents\`) when the matter’s Documents tab is first opened by an authorised user or triggered manually. Sample documents are seeded into newly provisioned matter folders (via the provider using the provisioning identity) **only when Demo Mode (\`featureFlags.enableDemoMode\`) is enabled in a non-\`live\`, non-production environment**; in \`live\` or production environments, or when Demo Mode is disabled, no sample files are created.
- **Matter & conflict updates (\`saveMatterRecord\`, \`updateMatterConflictRecord\`, and \`savePersonRecord\`)**: Synchronises SharePoint folder permissions in place (without moving folders) whenever a matter’s restriction status (\`isStaffMatter\`), ethical wall (\`hasEthicalWall\`), conflict check record, \`restrictedAccessUserIds\`, \`teamMemberIds\`, \`leadFeeEarnerId\`, \`supervisingPartnerId\`, \`responsiblePartnerId\`, \`owningDepartmentId\`, \`owningTeamId\`, or closed/reopened status changes.
- **Manual retry of failed provisioning**: Users with \`document:edit\` or \`document_store:configure\` can retry matter folder provisioning on a matter they can access.
- **Linking an existing SharePoint folder**: Because linking an existing folder rewrites its SharePoint ACLs and applies missing template subfolders, only administrators with \`document_store:configure\` and a multi-factor authenticated session (\`mfaVerified === true\`) may link an existing folder. The resolved folder must sit inside the matter’s routed SharePoint document library (\`libraryId\`) and, by default, inside the matter’s routed \`{departmentCode}/{teamCode}\` path; an administrator with MFA can explicitly enable \`allowRoutingMismatchOverride\` to link a dedicated matter subfolder outside the routed path within the same library (recording a routing-mismatch note and audit event), but linking any library root, routing rule \`basePath\` prefix, department container, team container, or folder already linked to another matter is always blocked.

## 5. Administration & permission drift reconciliation

System administrators with \`document_store:configure\`, \`document_template:configure\`, or \`document_access:review\` permissions (and a multi-factor authenticated session) can manage the integration under **Administration → Document Stores (SharePoint)**:

- **Connected Stores & Connection Test**: Verify the application certificate identity (\`Sites.Selected\`), inspect the resolved SharePoint \`siteId\` and \`driveId\`, and paste any SharePoint library URL to resolve its canonical Microsoft Graph identifiers.
- **Department & Team Group Mappings**: Review the mapping between 1Squared departments/teams and Microsoft Entra ID security group Object IDs (\`entraGroupId\`), along with their default access levels (\`read\` vs \`write\`).
- **Matter Folder Templates**: Inspect the active base and work-type folder templates configured for the tenant.
- **Permission Drift Reconciliation**: Run an on-demand or scheduled drift check across provisioned matters. The reconciliation engine compares each matter’s intended security policy in 1Squared against the live SharePoint folder permissions and flags:
  - \`unexpected_broken_inheritance\` — Someone broke inheritance directly in SharePoint on a standard matter.
  - \`unexpected_inherited_permissions\` — A restricted matter had its ethical wall removed in SharePoint.
  - \`missing_expected_grant\` — A required fee earner or group is missing from the SharePoint folder ACL.
  - \`unexpected_extra_grant\` — An unauthorised user or group was granted access directly in SharePoint.
  - \`missing_matter_folder\` — The provisioned matter folder was moved or deleted outside 1Squared.

Administrators can click **Repair Drift (Apply Intended ACL)** on any finding to immediately restore the SharePoint folder’s permissions to match 1Squared’s security policy.
`,
};
