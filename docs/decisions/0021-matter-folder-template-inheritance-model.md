# ADR-0021: Matter Folder Template Resolution, Inheritance, and Additive Versioning

- **Date:** 2026-11-02
- **Status:** Accepted
- **Related:** [ADR-0017](./0017-document-store-provider-abstraction.md), [ADR-0019](./0019-inheritance-based-document-permission-model.md)

## Context

Different areas of legal practice require different matter folder structures:
- Every matter needs a baseline structure (for example `Correspondence`, `Documents`, `Attendance Notes`, `Client Care & Compliance`, `Billing & Finance`).
- A department (for example `DEPT-RE` Real Estate or `DEPT-DR` Dispute Resolution) often needs additional standard folders across all its matters, or slightly different naming.
- A specific work type (for example Residential Conveyancing or Commercial Litigation) often needs specialised subfolders (such as `Searches`, `Title & Enquiries`, `Completion & Post-Completion` for Conveyancing, or `Pleadings`, `Disclosure`, `Bundles`, `Witnesses & Experts` for Litigation).

If every work type had to duplicate the entire folder tree from scratch, a firm-wide change (such as adding a `Client Care & Compliance` folder to all matters) would require editing dozens of templates. Furthermore, when a firm updates a template, existing open matters must never have their populated folders deleted, renamed, or moved automatically.

## Decision

### 1. Three-Layer Resolution Chain

For any matter with `{ departmentId, workTypeId }`, the effective template is resolved along a deterministic three-layer chain:

```text
work type template (matterFolderTemplates.byWorkType[workTypeId])
  → department template (matterFolderTemplates.byDepartment[departmentId])
    → tenant default template (matterFolderTemplates.default) [REQUIRED]
```

- `matterFolderTemplates.default` is mandatory whenever `documentStores` is enabled.
- If a work type has no entry in `byWorkType`, resolution falls back to `byDepartment[departmentId]`.
- If the department has no entry in `byDepartment`, resolution falls back to `default`.

### 2. Existing Work Type Entity and Department Link

- 1Squared models work types via the hierarchical `work_type` catalogue (`ChoiceValue` entries where top-level items are Practice Areas stored on `Matter.practiceAreaId`, and child items are Work Type Subcategories stored on `Matter.workTypeSubcategoryId`, paired with `MATTER_FIELD_MODEL.matrix`).
- Each work type links to its owning `OrgDepartment` (`DEPT-RE`, `DEPT-CORP`, `DEPT-DR`, `DEPT-PC`, `DEPT-EMP`, etc.) via the practice area–to–department mapping (`resolveOrgDepartmentIdsForPracticeArea` / `ChoiceValue.meta.departmentId`).
- `matterFolderTemplates.byWorkType` accepts either a specific work type subcategory ID (e.g. `work_type.real_estate_and_property_residential_conveyancing`) or a top-level practice area work type ID (e.g. `work_type.real_estate_and_property`), checking the subcategory first and then its parent practice area before falling back to `byDepartment[departmentId]`.

### 3. Template Node Structure & Inheritance Modes (`replaces` vs `extends`)

Each folder node in a template tree has:
- `name`: Folder name (may include allowed tokens: `{clientNumber}`, `{matterNumber}`, `{matterDescription}`, `{departmentCode}`, `{teamCode}`, `{workType}`).
- `description?`: Optional guidance shown in the admin template editor.
- `orderPrefix?`: Optional numeric prefix setting (e.g. `'none' | 'two_digit'`, rendering `01 Correspondence`, `02 Documents` when enabled).
- `access?`: Optional folder-level access override (`{ principalType: 'matter_team' | 'department' | 'named_group', groupKey?: string, level: DocumentAccessLevel }`). Any node with `access` triggers the unique-permission-scope scale warning (`ADR-0019`).
- `filingAliases?`: Optional Phase 2 hook for Outlook email filing.
- `children?`: Nested child folder nodes.

A department or work type template can either:
1. **Replace (`mode: 'replaces'` or `{ folders: [...] }`):** Supply a complete replacement `folders` tree; or
2. **Extend (`extends: 'default' | 'department'`):** Apply an ordered array of deterministic tree operations (`operations`) to the parent template's resolved tree:
   - `{ add: { parent: '/path', name: 'FolderName', description?: '...', orderPrefix?: '...', access?: {...}, children?: [...] } }`
   - `{ remove: { path: '/path/FolderName' } }`
   - `{ rename: { path: '/path/OldName', newName: 'NewName' } }`
   - `{ move: { path: '/path/FolderName', targetParent: '/newParent' } }`
   - `{ setAccess: { path: '/path/FolderName', access: {...} | null } }`

### 4. Compile-Time & Save-Time Validation Rules

The template compiler validates every template (default, department, and work type) at configuration load and admin save time, rejecting:
- Duplicate sibling folder names at the same parent path (case-insensitive, since SharePoint paths are case-insensitive).
- Characters forbidden by the store (`" * : < > ? / \ |`, leading/trailing dots or spaces, or reserved names such as `CON`, `PRN`, `AUX`, `NUL`, `Forms`, `_vti_`).
- Unknown interpolation tokens.
- Operations (`remove`, `rename`, `move`, `setAccess`, or `add` with `parent`) targeting a path that does not exist at that step in the operation sequence, or moving a folder into its own descendant.
- Trees exceeding `maxDepth` (default `8`) or rendered paths exceeding the provider's `maxPathLengthChars` (default `400` for SharePoint Online).

### 5. Versioning and "Apply Additions to Open Matters"

- Every template definition carries an integer `version` (`>= 1`) and version history metadata.
- When a matter folder is provisioned, `MatterDocumentLocation` records `templateId` and `templateVersion`.
- Subsequent edits to a template increment `version` and apply automatically to **new** matters only.
- Administrators can trigger **"Apply additions to open matters"**, which runs as a tenant-scoped background job (`applyTemplateAdditionsToOpenMattersJob`). The job resolves the current effective template tree for each open matter, calls `ensureFolderTree` to **add** any newly introduced folders that are missing, and updates `templateVersion`—it **never** deletes, renames, or moves existing folders on provisioned matters.

## Alternatives Considered

1. **Flat list of folder paths without tree operations.**
   - *Rejected:* Without `extends` operations (`add`, `remove`, `rename`, `move`, `setAccess`), departments and work types cannot cleanly customise a shared firm baseline or preview inherited vs overridden nodes in the Admin UI.
2. **Automatically rename/delete folders on existing open matters when a template changes.**
   - *Rejected:* Fee earners may already have saved documents or active co-authoring links inside existing folders; mutating or deleting existing folders on live matters risks data loss and broken links.

## Consequences

- Administrators can maintain a single firm-wide default template, layer department and work-type variations with minimal configuration, and preview the exact resolved tree for any work type in the Admin UI.
- Existing open matters remain safe when templates evolve, with an explicit additive-only upgrade job when new standard folders are introduced.
