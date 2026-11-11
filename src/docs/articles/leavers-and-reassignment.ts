import type { DocArticle } from '../registry';

export const leaversAndReassignmentArticle: DocArticle = {
  slug: 'leavers-and-reassignment',
  title: 'Leavers and record reassignment',
  section: 'people-organisations',
  summary:
    'How employee leaver status is recorded and how open matters, enquiries, tasks, people, and organisations owned by a leaver are safely reassigned with full audit trails and restricted-matter access updates.',
  updated: '2026-11-11',
  body: `
When an employee leaves the firm, their employment status is moved to **Leaver** and any open records they own or supervise can be transferred to an active replacement employee via \`reassignLeaverOwnedRecords\` (\`reassignLeaverOwnedRecordsAction\`).

## Required permissions and validation

- **Dual permission check**: Reassigning records owned by a leaver touches both HR employment state and matter/client ownership. The acting user must hold **both** \`employee:edit_core\` and \`matter:reassign_ownership\` (for example \`managing_partner\` or \`admin\`, or an HR/partner user granted both permissions).
- **Source leaver check**: The source person (\`fromLeaverId\`) must exist in the current tenant and be an actual leaver (\`isLeaverPerson(fromLeaver) === true\`). Attempts to run bulk leaver reassignment against a current active employee or a non-existent ID are rejected with \`FORBIDDEN\`.
- **Replacement employee check**: The target person (\`toEmployeeId\`) must be an active employee selectable in firm ownership dropdowns (\`isSelectableInEmployeeDropdown\`).

## What is reassigned

1. **People (\`public.people\` in \`TenantPartyRepository\`, \`S0-16\`)**: Non-merged person records where the leaver held \`relationshipOwnerId\`, \`recordOwnerId\`, or \`verificationReviewerId\` are updated to \`toEmployeeId\`.
2. **Organisations (\`public.organisations\` in \`TenantPartyRepository\`, \`S0-16\`)**: Non-merged organisation records where the leaver held \`relationshipPartnerId\`, \`recordOwnerId\`, or \`reviewerId\` are updated to \`toEmployeeId\`.
3. **Matters (\`public.matters\` in \`TenantMatterRepository\`, \`S0-16\`)**: Matters where the leaver held \`responsiblePartnerId\`, \`supervisingPartnerId\`, or \`leadFeeEarnerId\` are updated to \`toEmployeeId\` with \`row_version\` optimistic concurrency (\`R409\`, \`R448\`).
   - **Restricted and ethical-wall matters**: When a reassigned matter is restricted (\`isStaffMatter\`, \`hasEthicalWall\`, or non-empty \`restrictedAccessUserIds\`), \`reassignLeaverOwnedRecords\` removes \`fromLeaverId\` from \`restrictedAccessUserIds\`, adds \`toEmployeeId\` without widening access to anyone else, and invokes \`syncMatterLifecycleOnSaveSync\` (\`repermission_in_place\`) so SharePoint/document-store permissions stay aligned.
4. **Open tasks (\`store.tasks\`)**: Open tasks (\`status !== 'Done' && status !== 'Cancelled'\`) assigned to the leaver have both \`assignedPersonId\` and \`assignedPersonIds\` updated to replace \`fromLeaverId\` with \`toEmployeeId\`.
5. **Open enquiries (\`store.enquiries\`)**: Only open enquiries (\`isEnquiryOpen(e)\`) assigned to the leaver are reassigned to \`toEmployeeId\`, matching \`findRecordsOwnedByLeavers\`. Closed or converted enquiries keep their historical assignee.

## Per-record audit trail

- \`reassignLeaverOwnedRecords\` writes **one audit entry on each moved record** (\`person\`, \`organisation\`, \`matter\`, \`task\`, and \`enquiry\`) recording the reassigned role(s), the previous owner (\`fromLeaverId\`), and the new owner (\`toEmployeeId\`), in addition to the summary audit entry on the leaver's person record, committing all PostgreSQL \`people\`, \`organisations\`, \`matters\`, and \`audit_entries\` updates in a single tenant transaction (\`S0-16\`).
`,
};
