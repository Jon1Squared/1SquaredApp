# ADR-0005: Template Versioning, Approval Workflow, and Self-Approval Controls

- **Date:** 2026-04-20
- **Status:** Proposed

## Context

Legal documents carry regulatory and professional indemnity risk. Templates must not become available to fee earners until placeholders are fully mapped, required fields are validated, uploaded `.docx` binaries have passed malware scanning, and a designated approver (`document_template:approve`) has reviewed and approved the template version. Additionally, edits to an existing active template must not disrupt ongoing document generation or overwrite historical version metadata needed to audit which template version produced an existing document.

## Decision

### 1. Immutable Template Versions

A logical template (`document_templates`) has one or more numbered, immutable versions (`document_template_versions`, `versionNumber = 1, 2, 3, ...`):

- Each version stores its own `.docx` blob reference, SHA-256 content hash, malware scan status (`pending | clean | infected`), engine identifier (`basic-merge`), extracted placeholders, field mappings, prompted field definitions, status, submission metadata, and approval/rejection metadata.
- Once a version transitions out of `Draft`, its mappings and binary `.docx` payload are **immutable**.
- Editing an `Active`, `Rejected`, or `Retired` template creates a **new `Draft` version** (`versionNumber = max + 1`) cloned from the selected version while leaving the currently `Active` version serving users uninterrupted.

### 2. Version Lifecycle State Machine

Each template version follows a strict state machine enforced in `core/src/domain/document-generation/approvalWorkflow.ts`:

```
[Draft] ──(submit)──► [Submitted] ──(approve)──► [Active] ──(retire / superseded)──► [Retired]
   ▲                       │
   └──(edit new draft)─────┴────────(reject with reason)──► [Rejected]
```

- **`Draft` → `Submitted`** (requires `document_template:build`):
  - Blocked if any placeholder in the `.docx` is unmapped (neither mapped to a valid Field Catalogue key nor declared as a Prompted Field).
  - Blocked if the `.docx` contains reserved `{% ... %}` block syntax under the `basic-merge` engine.
  - Blocked unless the `.docx` binary has `scanStatus === 'clean'`.
- **`Submitted` → `Active`** (requires `document_template:approve`):
  - Enforces the tenant's `documentGeneration.approval.allowSelfApproval` setting (default: `false`). When `allowSelfApproval` is `false`, the approving user's `actorUserId` must not equal the version's `submittedByUserId` (nor `createdByUserId` if submitted by the creator).
  - Atomically transitions any previously `Active` version of the same logical template to `Retired` (`supersededByVersionId`) and sets `activeVersionId` on `document_templates`.
- **`Submitted` → `Rejected`** (requires `document_template:approve`):
  - Requires a non-empty rejection reason (`rejectionReason`), which is recorded on the version and displayed to builders.
- **`Active` → `Retired`** (requires `document_template:approve`):
  - Retires the active version so the template can no longer be used for new document generation, while preserving historical generated documents and usage analytics.
- **Rollback to a Previous Approved Version** (requires `document_template:approve`):
  - An approver can roll back a template to a previously approved (`Retired`) version. To keep version history append-only and auditable, rollback either reactivates the prior approved version record (recording `rolledBackByUserId`, `rolledBackAt`, `rollbackReason`) and retires the current `Active` version, or creates a new active version pointing to the prior version's immutable snapshot, logging an immutable audit entry.

### 3. Approval Queue & Home Page Visibility

- Approvers (`hasDocumentPermission(user, 'document_template:approve')`) see a dedicated **Approval Queue** listing all `Submitted` template versions with their diff/summary of mappings, test preview runner, and Approve / Reject actions.
- The Home screen (`src/components/HomeClient.tsx`) displays a **Pending Template Approvals** count indicator/badge for users holding `document_template:approve`.
- Every state transition (`submit`, `approve`, `reject`, `retire`, `rollback`) writes a structured tenant audit log entry with `tenantId`, `correlationId`, `actorUserId`, `templateId`, `versionNumber`, and transition metadata.

## Alternatives Considered

1. **Mutate template versions in place when builders make edits.**
   - *Rejected:* If a generated document records `templateVersionId`, mutating a version in place makes it impossible to know what template wording and mappings were active when a historical client care letter or court form was generated.
2. **Hardcode self-approval prohibition with no configuration option.**
   - *Rejected:* Small single-partner firms or UAT/sandbox tenants often have a single administrator/managing partner who both builds and approves templates. Making `documentGeneration.approval.allowSelfApproval` a schema-validated configuration option (defaulting to `false`) satisfies both strict dual-control firms and smaller practices without code branches.

## Consequences

- Every generated document is permanently traceable to an immutable `templateId` + `templateVersionId`.
- Dual-control approval is enforced by default (`allowSelfApproval: false`) and configurable per tenant.
