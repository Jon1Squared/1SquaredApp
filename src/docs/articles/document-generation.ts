import type { DocArticle } from '../registry';

export const documentGenerationArticle: DocArticle = {
  slug: 'document-generation',
  title: 'Document generation, precedent templates & approval workflow',
  section: 'documents-dms',
  summary:
    'How to author .docx precedent templates, map Field Catalogue placeholders, approve template versions with separation of duties, generate merged documents, and review template usage.',
  updated: '2026-11-23',
  body: `
1Squared includes a built-in **Document Generation & Precedent Management** engine that merges live client, matter, party, fee earner, and financial data into Word (\`.docx\`) templates while enforcing role-based field permissions, restricted-matter controls, and two-person template approval.

## 1. Generating a document from a Matter or Client record

Users with the \`document:generate\` permission can generate letters, attendance notes, and precedent documents directly from any accessible Matter, Organisation, or Person record:

1. Open the **Documents** section on the record and click **Generate Document**.
2. **Choose an Active Template**: The template picker automatically filters templates by context (\`matter\` vs \`client\`), practice area, work type, client type, and your assigned roles. Templates that reference financial merge fields (\`financial.*\`) require the \`finance:view\` permission.
3. **Select Recipient & Counterparty**: Choose which linked party populates \`party.recipient.*\` and \`party.counterparty.*\` placeholders.
4. **Complete Prompted Fields**: Fill in any template-specific prompted inputs (text, dates, currency amounts, booleans, or choice lists).
5. **Preview & Generate**: Inspect the live field-resolution preview (including any missing-field warnings), choose the output format, and generate the merged document.

## 2. PDF rendering options & fallback behaviour

When generating or previewing a document in PDF format, 1Squared selects the converter from the tenant configuration:

- **\`documentGeneration.pdfConverter\` (\`'builtin'\` default, or \`'container'\`)**:
  - **Built-in OpenXML (\`'builtin'\`)**: Renders \`.docx\` XML in process with zero external dependencies (\`BuiltInOpenXmlPdfConverter\`). Suitable for standard text, headings, simple tables, and Stage 0 deployments without extra compute.
  - **Dedicated Container (\`'container'\`)**: Sends the merged \`.docx\` bytes over internal networking (\`DOC_CONVERTER_URL\`) to the dedicated headless LibreOffice Writer container app (\`ca-pdf\`, item \`46\`). Produces high-fidelity layout, typography, complex tables, and page numbering matching desktop LibreOffice Writer, with a \`25 MiB\` payload cap, a \`60s\` client HTTP timeout (giving \`15s\` cold-start headroom above the \`45s\` \`soffice\` subprocess timeout), and \`x-tenant-id\` / \`x-correlation-id\` headers (never document titles or content in logs).
- **\`documentGeneration.pdfConverterFallback\` (\`'builtin'\` default, or \`'fail'\`)**:
  - When \`'builtin'\`, if the dedicated container is unconfigured, times out, returns an error, or is unreachable, 1Squared falls back to \`BuiltInOpenXmlPdfConverter\` and records a structured \`document_generation.pdf_converter_fallback\` warning containing only \`tenantId\`, \`correlationId\`, and \`errorCode\`.
  - When \`'fail'\`, conversion fails closed with a typed \`PDF_CONVERTER_*\` error rather than falling back silently.

## 3. Scoped download tokens & access control

Generated documents are stored in the tenant’s isolated document storage container and linked to the originating Matter or Client record, while all template, version, generated document, link, usage, and tenant configuration records live exclusively in the firm’s isolated database: \`LocalTenantStorageProvider\` (\`local-fs\`, single-replica demo container, reading strictly from disk when \`inMemoryOnly: false\` and returning \`'pending'\` for unknown scan keys) refuses to start in \`live\` environments; per-tenant Azure Blob Storage (\`azure-blob\`) is not yet enabled (deployment, start-up, readiness, settings saves, and effective per-tenant document generation checks fail closed if \`azure-blob\`, another unimplemented provider, or a mismatched storage provider is selected without falling back to \`local-fs\`; a \`live\` web deployment is refused until \`azure-blob\` exists, ADR 0008 and ADR 0024).

- Viewing generated document metadata requires \`document:view\` and access to the underlying Matter or Client record (including \`matter:restricted:access\` or allow-list membership on restricted staff matters). Roles holding \`document:view\` without \`document_template:view\` can still view generated documents linked to accessible matters via \`getDocumentGenerationSnapshotAction\` (template definitions and Field Catalogue metadata remain omitted unless \`document_template:view\` is also held). Generating new documents requires both \`document:generate\` and \`document_template:view\`.
- **Client Care Letters & engagement status (\`B2\`)**: When a Client Care Letter (identified by the shared constant \`CLIENT_CARE_DOCUMENT_TYPE = 'client_care'\`) is generated from a Matter (either from the Overview modal or the Documents tab), \`generateDocumentService\` atomically advances the matter's \`engagementLetterStatus\` to \`'Drafted'\` on the server (with an audit entry, requiring no separate client-side drafted action) whenever the user holds \`matter:edit\` and the letter has not already progressed to \`'Drafted'\`, \`'Sent'\`, \`'Sent to client'\`, \`'Signed'\`, or \`'Signed & returned'\` (or recorded sent/signed timestamps). Financial merge fields resolve from the matter's validated costs snapshot (\`fieldValues.matterCosts\`, retaining \`fieldValues.matterCostsSnapshot\` as a read-only fallback for older records). Missing fee-earner charge-out rates, estimates, balances, or zero/not-required payment-on-account amounts (\`<= 0\` or \`paymentOnAccountRequired === 'No'\`) resolve to \`undefined\` in merge fields rather than defaulting to \`0\` or fabricated amounts, so required placeholders fail closed with \`blocked_missing_required\` and optional placeholders render blank without printed \`£0.00\` amounts or dangling payment wording.
- Downloading a generated file requires \`document:download\`. 1Squared issues a short-lived, HMAC-signed scoped download token bound to your \`tenantId\`, user \`sub\`, \`documentId\`, and \`blobKey\`. When the download endpoint is called, 1Squared verifies both the token signature and your live session permissions before streaming the file.
- Deleting a generated document requires \`document:delete\` and is recorded in the audit log.

## 3. Authoring templates & the Field Catalogue

Template authors with \`document_template:view\` and \`document_template:build\` permissions can create and update templates under **Administration → Document Templates**:

- **Canonical Field Catalogue**: Placeholders use \`{{ group.field | filter }}\` syntax (for example \`{{ client.name }}\`, \`{{ matter.reference }}\`, \`{{ feeEarner.fullName }}\`, \`{{ financial.feeEstimate | currency }}\`, or \`{{ date.today | date:"d MMMM yyyy" }}\`).
- **Firm Contact Details (\`firm.contactEmail\` & \`firm.website\`)**: Document headers and footers can reference \`{{ firm.contactEmail }}\` and \`{{ firm.website }}\`, which are populated from the tenant configuration keys \`firm.contactEmail\` and \`firm.website\` (validated as email and hostname/URL formats respectively). For backward compatibility, deprecated \`branding.contactEmail\` and \`branding.website\` values act as fallbacks when \`firm.*\` is unset, and both merge fields resolve to blank strings (\`""\`) if neither is configured.
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
- Modifying ordinary tenant-level document generation settings requires \`document_template:build\` or \`rbac:manage_config\`, whilst changes to \`permissions\`, \`approval.requireApproval\`, or \`approval.allowSelfApproval\` require \`rbac:manage_config\` or \`admin:access\`, and every Document Generation settings change requires a multi-factor authenticated session (\`mfaVerified === true\`). Saving settings validates all 16 \`DocumentPermission\` keys in \`documentGeneration.permissions.roleDefaults\` (\`ALL_DOCUMENT_PERMISSION_KEYS\`) against both the Zod configuration engine and \`core/schemas/tenant-config.schema.json\`.

## Audit trail

Template uploads, submissions, approvals, rejections, retirements, rollbacks, imports, generated documents, deletions and settings changes each write a firm audit entry in the same database transaction as the change. If the audit entry cannot be saved, the change is not saved either. Audit entries are append-only.
`,
};
