# ADR-0019: Inheritance-Based Permission Model, Scale Guard, and Drift Reconciliation

- **Date:** 2026-11-02
- **Status:** Accepted
- **Related:** [ADR-0014](../../../docs/decisions/0014-staff-matter-access-by-permission.md), [ADR-0017](./0017-document-store-provider-abstraction.md), [ADR-0018](./0018-two-identity-authentication-model.md)

## Context

A law firm may have tens of thousands of matters in a SharePoint document library. Setting unique permissions on every matter folder (or every subfolder within a matter) causes two severe problems in SharePoint Online:
1. **SharePoint Unique Permission Scope Limits:** Microsoft documents a hard limit of **50,000 unique permission scopes** per list or library, and a recommended operational threshold of **5,000 unique permission scopes** above which ACL evaluation degrades noticeably.
2. **Administrative & Permission Drift:** Granting access to individual users on thousands of folders makes joiner/mover/leaver administration brittle and error-prone.

At the same time, legal practice requires strict exceptions when:
- A matter is **restricted** (`matter.isStaffMatter` or `matter.hasEthicalWall` / `isRestricted`), where department and team colleagues outside the named matter participants and designated oversight groups must have **zero** access; or
- A fee earner or specialist **outside the owning team** is added to `matter.teamMemberIds` and needs `contribute` access to that matter without being added to the owning team's Entra group.

## Decision

### 1. Defence-in-Depth Access Enforcement

1. **1Squared First:** Before any provider call, 1Squared checks `canAccessMatter` and the required RBAC permission (`document:view`, `document:download`, `document:upload`, `document:edit`, `document:delete`, `document:provision`).
2. **Document Store Second:** The provider call executes using the user's OBO token so SharePoint enforces its own ACLs.
3. **Mismatch Handling:** If 1Squared allows an action on a provisioned matter but SharePoint returns `403 Forbidden` (`access_denied`), the UI shows a clear "Access denied by the document store" message and records a **reconciliation finding** (`permission_mismatch_store_denied`) so administrators can inspect and remediate group membership or folder ACL drift.

### 2. Entra Security Group Mapping & Phase 2 `GroupMembershipSync` Interface

- In tenant configuration (`documentAccess.groups`), departments (`OrgDepartment.id`), teams (`OrgTeamOrPracticeGroup.id`), and named firm-wide groups (e.g. `named:riskCompliance`) map to Entra ID Security Group Object GUIDs (or explicit `'none'`).
- In Phase 1, the firm manages group membership in Microsoft Entra ID.
- For Phase 2, we define and export the `GroupMembershipSync` interface in `@platform/core-api` (without implementing a write-back job in Phase 1) so 1Squared can later synchronise department and team assignments to Entra security groups without changing `documentAccess` configuration or `DocumentStoreProvider`.

### 3. Inheritance-Based Folder Hierarchy by Default

Permissions are applied at high-level structural folders; standard matter folders and their template subfolders **inherit** permissions (`inherit: true`) and consume **zero** additional unique permission scopes:

```text
{libraryRoot}/                  named groups (e.g. named:riskCompliance -> read)
  {departmentCode}/             department group -> policy.departmentFolder.departmentGroup (e.g. read)
    {teamCode}/                 team group       -> policy.teamFolder.teamGroup (e.g. contribute)
      {matterFolderName}/       inherits from {teamCode} by default (0 unique scopes)
        Correspondence/         inherits
        Documents/              inherits
```

### 4. Abstract Permission Levels & SharePoint Role Mapping

Tenant access policies use five provider-agnostic levels mapped in one place inside `SharePointDocumentStoreProvider`:

| Abstract Level | SharePoint Role / Graph Role | Meaning |
| :--- | :--- | :--- |
| `none` | *(No grant / remove existing grant)* | No access |
| `read` | `read` (`SP.RoleType.Reader`) | View and download only |
| `contribute` | `write` (`SP.RoleType.Contributor`) | View, download, upload, edit, create folders |
| `edit` | `sp.edit` / `write` (`SP.RoleType.Editor`) | Contribute plus delete/move/manage lists |
| `manage` | `owner` / `sp.full control` (`SP.RoleType.Administrator`) | Full control including permission management |

### 5. Breaking and Restoring Inheritance for Matter Exceptions

A matter folder breaks inheritance (`inherit: false`) **only** in three cases:
1. **Restricted Matter (`matter.isStaffMatter || matter.hasEthicalWall`):**
   - Breaks inheritance with `copyRoleAssignments = false` (removes inherited department and team group grants).
   - Grants `policy.restrictedMatter.level` (e.g. `contribute`) to:
     - Each person in `matter.restrictedAccessUserIds` (and named matter participants) resolved to their `entraObjectId`.
     - Each configured group in `policy.restrictedMatter.groups` (e.g. `named:riskCompliance`).
2. **Matter-Team Outsider (`outsiderUserIds.length > 0` on a non-restricted matter):**
   - Breaks inheritance while retaining the owning department/team and library-root grants, and adds each outsider's `entraObjectId` with `policy.matterTeamOutsider` level (e.g. `contribute`).
3. **Closed Matter with Read-Only Policy (`matter.closedAt` when `policy.closedMatter === 'read'`):**
   - Downgrades `contribute`/`edit` grants on the matter folder to `read` while preserving the same principal set.

**Restoring Inheritance:** Whenever a matter stops needing an exception (for example, an outsider is removed from `matter.teamMemberIds` and the matter is open and unrestricted, or a closed matter is reopened without exceptions), provisioning calls `setPermissions(ctx, itemRef, [], { inherit: true })`, which restores parent inheritance and removes the unique scope.

**Graph v1.0 vs SharePoint REST API for Inheritance Reset:**
- Microsoft Graph v1.0 supports reading permissions (`GET /drives/{driveId}/items/{itemId}/permissions`), adding grants (`POST .../invite`), and deleting grants (`DELETE .../permissions/{id}`).
- However, Graph v1.0 does not expose an endpoint to **restore inheritance** (`resetRoleInheritance`) or cleanly **break inheritance without copying parent roles** (`breakRoleInheritance(copyRoleAssignments=false, clearSubscopes=true)`).
- Therefore, in accordance with Section 8 of the specification, `SharePointDocumentStoreProvider` uses the SharePoint REST API (`POST https://{hostname}{sitePath}/_api/web/GetFolderByServerRelativeUrl(@u)/ListItemAllFields/breakroleinheritance(copyRoleAssignments=false,clearSubscopes=true)` and `.../resetroleinheritance()`) strictly for breaking and restoring folder inheritance using the same provisioning certificate identity, and uses Microsoft Graph v1.0 for all other operations.

### 6. Unique Permission Scope Scale Guard

- We track the count of unique permission scopes per library (`uniqueScopeCount`: department folders + team folders + matter folders with broken inheritance + template subfolders with `access` overrides).
- Default `uniqueScopeWarningThreshold` is **`4000`** (configurable per tenant), providing a 20% safety buffer below Microsoft's 5,000 operational recommendation and well below the 50,000 hard limit.
- The Admin UI displays the live scope count and warning banner when `uniqueScopeCount >= uniqueScopeWarningThreshold`, and warns immediately in the Folder Template editor whenever an admin adds a folder-level `access` override that would multiply unique scopes across every matter.

### 7. No Sharing Links & Scheduled Reconciliation

- Provisioning never creates anonymous or organisation sharing links (`link` facet on Graph permissions).
- A tenant-scoped scheduled reconciliation job (`runDocumentAccessReconciliationJob`) compares intended vs actual permissions on department folders, team folders, and exception matter folders, checks that every provisioned matter folder exists, detects orphan folders under team directories, flags any unexpected `sharingLinks`, and optionally auto-remediates when `documentAccess.reconciliation.autoRemediate === true` (default `false`).

## Alternatives Considered

1. **Break inheritance on every matter folder.**
   - *Rejected:* A firm opening 3,000 matters per year would exceed Microsoft's 5,000 operational scope threshold within two years, degrading SharePoint performance and complicating group administration.
2. **Use Microsoft Graph v1.0 only and simulate inheritance by manually copying parent permissions.**
   - *Rejected:* Leaving broken inheritance permanently on folders that no longer need exceptions would monotonically exhaust the 5,000 unique scope budget. Using the SharePoint REST API specifically for `breakroleinheritance` and `resetroleinheritance` keeps inheritance genuine and reversible.

## Consequences

- Standard open matters use zero unique permission scopes in SharePoint.
- Restricted matters, ethical walls, and cross-team collaborations are enforced in both 1Squared and SharePoint and automatically clean up their unique scope when the exception ends.
