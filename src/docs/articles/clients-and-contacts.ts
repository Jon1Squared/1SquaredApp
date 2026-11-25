import type { DocArticle } from '../registry';

export const clientsAndContactsArticle: DocArticle = {
  slug: 'clients-and-contacts',
  title: 'Clients, contacts & matter parties',
  section: 'people-organisations',
  summary:
    'How canonical Person and Organisation records work with multiple personas, person–organisation links, corporate groups, the two-field matter party model, conflict checks, and directory permissions.',
  updated: '2026-11-21',
  body: `
1Squared maintains **one canonical record per real-world person or organisation** in the **People** (\`/people\`) and **Organisations** (\`/organisations\`) directories. A single person or company can hold multiple relationship roles, connect to several organisations over time, and act in different capacities on different matters without creating duplicate directory records.

## 1. Canonical People & multiple personas

A single person often interacts with a firm in more than one capacity—for example as an instructing contact at a commercial client who also instructs the firm personally on a private client matter:

- **One record, multiple personas**: A \`Person\` record stores core identity, email addresses (primary and secondary), telephone numbers, postal addresses, alternative or former names (\`otherNames\`), and an array of directory role IDs (\`person_role.*\`).
- **Automatic private-client persona assignment**: When an existing business contact is selected as a client on a matter (either directly on matter save or via enquiry/quote conversion), the server unions \`person_role.private_client\` onto their existing record inside the same database transaction rather than creating a second person row.
- **No cross-matter bleed**: Matter-specific involvement is stored separately on each matter rather than on the directory profile, so acting for an individual on one matter never alters their commercial contact role on another.
- **Employee separation**: Firm staff (\`people\` with employment records) follow separate governance rules—\`contact:create\` and \`contact:edit\` cannot edit employee status, roles, or sign-in addresses (which require \`employee:edit_core\`, and verified MFA when adding or changing an employee sign-in email), and requests attempting to supply security role or override fields on person save are rejected (\`B11\`). Employee and leaver records can never be merged.

## 2. Two-field Matter Party model (relationships & capacities)

Rather than duplicating directory entries per matter role, each matter links people and organisations through structured party links using two fields:

1. **Relationship (8 core codes)**: Captures the legal relationship to the firm's instruction:
   - \`CL\` (Client), \`JC\` (Joint Client), \`CC\` (Connected to Client), \`OP\` (Opposing Party), \`CP\` (Connected to Opposing Party), \`CO\` (Counterparty — non-contentious), \`TP\` (Third Party), and \`NO\` (Neutral / Other).
2. **Capacity (70 structured capacities)**: Describes the specific role played on that matter—such as Director, Shareholder, Trustee, Executor, Lender, Opposing Solicitor, Counsel / Barrister, Expert Witness, Referrer, or Litigation Funder.
   - A person can appear as \`CL\` on one matter, an instructing contact on a second, and \`OP\` or \`TP\` on a third.
   - Dedicated matter contact fields—**Instructing contact**, **Billing contact**, and **Referrer contact**—alongside \`additionalClientIds\` complement the party table cleanly.
   - Administrators holding \`admin:access\` (with verified MFA) can manage party relationship labels, capacities, and work-type party profiles under **Administration → Matter parties** (\`/admin/matter-parties\`).

## 3. Person–organisation links & corporate groups

- **Links between people and organisations**: People link to organisations via typed relationships carrying \`roles\`, optional job titles, \`isPrimaryContact\`, \`startDate\`, \`endDate\`, and \`isCurrent\`. Historical links (\`isCurrent: false\`) remain visible on profiles and continue to be traversed during conflict checks.
- **Corporate groups**: Organisations support parent–subsidiary hierarchies via \`parentOrganisationId\` (with server-side self-parenting and cycle guards). Direct subsidiaries inherit group financial roll-ups (where finance permissions apply) and Tier 3 negotiated corporate-group rate schedules when billing matters.

## 4. Profile screens, permissions & compliance states

- **Permissions**:
  - Viewing directory profiles follows firm access controls and restricted-matter filtering. Creating or updating external contacts and organisations requires \`contact:create\` or \`contact:edit\`.
  - Viewing or editing negotiated client and corporate-group rate schedules on the **Finance** tab requires finance/matter access to view and \`matter:costs:sign_off\`, \`finance:credit_control\`, or \`admin:access\` alongside verified MFA to add, update, or remove overrides.
  - Sensitive staff employment, payroll (\`employee:payroll\`), and HR records (\`employee:sensitive\`) are filtered out of directory lists and require dedicated HR permissions and explicit profile disclosure with audit logging.
- **Honest compliance states**: Until a third-party e-ID or sanctions/PEP provider is integrated, Person and Organisation compliance pills report only factual stored state (**Not verified**, **Not checked**, **Checks pending**, **Manual check logged**, or **Review required**) and never fabricate cleared screening results.
- **Audit and optimistic concurrency**: Directory saves, organisation link mutations, and merges record firm audit entries in the same transaction; merging duplicate contacts or organisations (for holders of \`record:merge\`) uses tombstone redirection (\`mergedIntoId\`) and preserves references across matters, enquiries, quotes, tasks, documents, registers, and rate schedules.

## 5. Client Due Diligence (CDD) on profiles

Every external Person and Organisation profile includes a **Client Due Diligence** card showing whether checks are **CDD not started**, **In progress**, **Recorded**, **Due for re-check**, or **Expired**, together with client-type checklist items, secure evidence uploads, and **Recorded manually by ...** attribution. When an employee or leaver instructs the firm personally, their CDD details are hidden from staff who lack risk/restricted permissions and are not working on an active matter for that person.

## 6. Related guides

- [Client Due Diligence (CDD) workflow and evidence](/docs/client-due-diligence) — step-by-step guide to checklists, evidence uploads, manual screening checks, and re-check schedules.
- [How the quick conflict check works](/docs/quick-conflict-check) — full conflict traversal across all 8 relationship codes, 70 capacities, secondary emails, former names, instructing/billing/referrer contacts, links, and corporate groups, with restricted-matter redaction.
- [Duplicate checks on People and Organisations](/docs/duplicate-checks) — live duplicate detection and single-transaction merge rules.
- [Matter opening wizard & risk assessment](/docs/matter-opening-and-risk) — how clients, contacts, and matter parties flow through matter opening and conflict review.
`,
};
