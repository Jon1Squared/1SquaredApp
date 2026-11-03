import type { DocArticle } from '../registry';

export const documentGenerationArticle: DocArticle = {
  slug: 'document-generation',
  title: 'Document generation, precedent templates & approval workflow',
  section: 'documents-dms',
  summary:
    'How to author .docx precedent templates, map Field Catalogue placeholders, approve template versions with separation of duties, generate merged documents, and review template usage.',
  updated: '2026-11-03',
  body: `
1Squared includes a built-in **Document Generation & Precedent Management** engine that merges live client, matter, party, fee earner, and financial data into Word (\`.docx\`) templates while enforcing role-based field permissions, restricted-matter controls, and two-person template approval.

## 1. Generating a document from a Matter or Client record

Users with the \`document:generate\` permission can generate letters, attendance notes, and precedent documents directly from any accessible Matter, Organisation, or Person record:

1. Open the **Documents** section on the record and click **Generate Document**.
2. **Choose an Active Template**: The template picker automatically filters templates by context (\`matter\` vs \`client\`), practice area, work type, client type, and your assigned roles. Templates that reference financial merge fields (\`financial.*\`) require the \`finance:view\` permission.
3. **Select Recipient & Counterparty**: Choose which linked party populates \`party.recipient.*\` and \`party.counterparty.*\` placeholders.
4. **Complete Prompted Fields**: Fill in any template-specific prompted inputs (text, dates, currency amounts, booleans, or choice lists).
5. **Preview & Generate**: Inspect the live field-resolution preview (including any missing-field warnings), choose the output format, and generate the merged document.

## 2. Scoped download tokens & access control

Generated documents are stored in the tenant’s isolated document storage container and linked to the originating Matter or Client record:

- Viewing generated document metadata requires \`document:view\` and access to the underlying Matter or Client record (including \`matter:restricted:access\` or allow-list membership on restricted staff matters).
- Downloading a generated file requires \`document:download\`. 1Squared issues a short-lived, HMAC-signed scoped download token bound to your \`tenantId\`, user \`sub\`, \`documentId\`, and \`blobKey\`. When the download endpoint is called, 1Squared verifies both the token signature and your live session permissions before streaming the file.
- Deleting a generated document requires \`document:delete\` and is recorded in the audit log.

## 3. Authoring templates & the Field Catalogue

Template authors with \`document_template:view\` and \`document_template:build\` permissions can create and update templates under **Administration → Document Templates**:

- **Canonical Field Catalogue**: Placeholders use \`{{ group.field | filter }}\` syntax (for example \`{{ client.name }}\`, \`{{ matter.reference }}\`, \`{{ feeEarner.fullName }}\`, \`{{ financial.feeEstimate | currency }}\`, or \`{{ date.today | date:"d MMMM yyyy" }}\`).
- **Automatic Placeholder Extraction**: Uploading a \`.docx\` file extracts all placeholders across the document body, headers, and footers, automatically maps known Field Catalogue keys, and highlights any unmapped placeholders before submission.
- **Portable Template Packages**: Templates and their placeholder mappings can be exported and imported across environments (\`dev\`, \`test\`, \`training\`, \`live\`) as schema-validated template packages.

## 4. Approval workflow & separation of duties

To prevent unreviewed precedent changes from reaching fee earners, template versions follow a strict lifecycle (\`Draft\` → \`PendingApproval\` → \`Active\` → \`Superseded\` / \`Retired\`):

1. A template builder with \`document_template:build\` submits a draft version for approval (requiring all placeholders to be mapped).
2. A reviewer with \`document_template:approve\` and a multi-factor authenticated session (\`requiresMfa: true\`) reviews the version in the **Approval Queue**.
3. When \`documentGeneration.approval.enforceDifferentApprover\` is enabled, the approver must be a different person from the author who created or submitted the draft version.
4. Approving a version promotes it to \`Active\` and supersedes the previous active version. Reviewers with \`document_template:approve\` can also roll back to a prior approved version or retire a template.

## 5. Template usage reporting

- Users with \`document_template:view_usage\` can inspect aggregate 30-day and 90-day generation counts, output format breakdowns, low-use retirement candidates, and blocked-field diagnostics.
- Viewing per-user generation breakdowns requires both \`document_template:view_usage_by_user\` and \`documentGeneration.usage.showUserLevelDetail: true\` in the tenant configuration.
- Modifying tenant-level document generation settings requires \`document_template:configure\` with MFA.
`,
};
