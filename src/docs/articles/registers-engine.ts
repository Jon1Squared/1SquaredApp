import type { DocArticle } from '../registry';

export const registersEngineArticle: DocArticle = {
  slug: 'registers-engine',
  title: 'Configurable registers and undertakings',
  section: 'getting-started',
  summary:
    'How the Configurable Registers Engine manages undertakings, complaints, SRA breaches, periodic file reviews, partner sign-offs, tenant custom registers, extension hooks, and automated due/review reminders.',
  updated: '2026-11-25',
  body: `
The **Registers** workspace (\`/registers\`) provides a single, configurable per-tenant engine for regulatory and practice registers, persisted per tenant (\`0017_registers_engine_expand\`, \`TenantRegisterRepository\`) with full state-transition history across both \`/registers\` and the Home partner sign-off queue (\`approveSignOff\`, \`discussSignOff\`, and \`flagMatterWriteOff\`), single-allocator \`SO-\` reference numbering, reminder deduplication, and same-transaction audit logging.

## 1. Built-in register types and direct undertaking creation

1Squared ships six built-in register types (alongside any custom registers configured for your practice, such as periodic file reviews):

| Key | Label | Initial Status | Creation & Governance |
| --- | --- | --- | --- |
| \`sign_off\` | Sign-Off | \`pending_approval\` | Supports \`write_off\` (via **Flag write-off**) and schema-defined \`matter_opening\`; transitions through \`pending_approval\` → \`discussing\` → \`approved\` / \`rejected\` with optimistic concurrency, no-self-approval, approver notifications, and aligned Home / Registers write-off approvals (\`signoff:approve\` or \`register:approve\`) |
| \`high_risk_opening\` | High-Risk Opening | \`pending_partner\` | Created automatically on prospective submission for matters rated **High**, **Critical**, or **Sensitive** (\`HRO-\` prefix); enforces sequential **Partner** → **different Risk & Compliance officer** two-stage approval with zero administrator bypass, rejecting back to \`rejected\` or moving automatically to \`withdrawn\` if downgraded below High or abandoned |
| \`undertaking\` | Undertaking | \`open\` | **Direct creation without two-person approval** (\`approvalRules: null\`): any permitted fee earner (\`undertaking:manage\`) records an undertaking directly as \`open\` and can record variations (\`varied\`), mark overdue (\`overdue\`), reopen (\`open\`), discharge (\`discharged\`), or cancel (\`cancelled\`) |
| \`complaint\` | Client Complaint | \`open\` | Stages from \`open\` → \`investigating\` → \`resolved\` / \`closed\`; supports optional assigned reviewer (\`register_review_assigned\`) |
| \`breach\` | Compliance Breach | \`logged\` | Stages from \`logged\` → \`remediation\` → \`closed\` (requiring \`register:approve\` with no self-approval) |
| Client Due Diligence | Client Due Diligence | In progress | Linked directly to a client Person or Organisation record (managed from client profiles rather than created standalone in Registers); moves through **In progress** → **Recorded** → **Archived** / **Superseded**, tracking verification checklists and security-scanned evidence uploads (see [Client Due Diligence](/docs/client-due-diligence)) |

Undertakings live exclusively in the **Registers** engine rather than the partner sign-off queue (\`SignOffKind\` covers \`write_off\` and \`matter_opening\` only, and historical undertaking records are consolidated into the unified register engine during migration \`0017\`).

## 2. How to record and discharge an undertaking (step by step)

Practising fee earners holding \`undertaking:manage\` can record an undertaking directly from either a **Matter profile** or the firm-wide **Registers** workspace without waiting for partner approval:

### From a Matter profile
1. Open the matter (\`/matters/<id>\`).
2. Click **New undertaking** in the top-right page header, or click **+ New undertaking** on the **Undertakings & registers** card in the **Overview** right sidebar, or open the **Compliance** tab, scroll to **Matter registers & undertakings**, and click **+ New undertaking**.
3. The **New Undertaking** creation form opens pre-linked to that matter. Enter the **Title**, due/compliance deadline (and optional periodic review date), **Recipient / counterparty**, **Terms of undertaking**, and **Given by fee earner** (pre-filled with your own name by default).
4. Click **Create Undertaking**. The undertaking is assigned a \`UND-\` reference and opens immediately in \`open\` status.

### From the Registers workspace
1. Open **Registers** (\`/registers\`) from the left navigation rail.
2. Click **+ Record undertaking** in the top-right header.
3. Choose the **Linked matter** (or leave firm-wide if appropriate), complete the **Title**, due date, **Recipient / counterparty**, **Terms of undertaking**, and **Given by fee earner**, then click **Create Undertaking**.

### Varying, monitoring, or discharging an undertaking
1. Open an undertaking from **Registers** (\`/registers\`) or from the matter's **Compliance** tab (**Matter registers & undertakings**).
2. Use the workflow action buttons on the record detail pane to **Record variation** (requires a comment), **Mark overdue**, **Reopen undertaking**, **Discharge undertaking** (moves to terminal \`discharged\` status), or **Cancel / withdraw** (requires a comment). Every transition is audited with optimistic concurrency protection.

## 3. Permissions and role separation (\`undertaking:manage\`)

Access to registers and undertakings is governed by six user permissions and one background job permission:

- \`register:view\`: View register records in \`/registers\`, on Home panels, and on linked matter profiles.
- \`register:create\`: Create new non-undertaking register records (for example complaints, SRA breaches, and file reviews).
- \`register:edit\`: Update metadata and execute non-approval workflow transitions on accessible register records.
- \`register:approve\`: Execute formal approval/decision transitions on register types configured with approval rules (never permitting self-approval). Home-queue approvals via \`signoff:approve\` also enforce these same engine rules through \`transitionRegisterRecordService\`.
- \`register:configure\` (**requires MFA**): Configure firm register overrides, reminder schedules, and custom register types in **Administration → Registers**.
- \`undertaking:manage\`: Create, edit, vary, and discharge undertakings. **Restricted to fee-earning roles (\`fee_earner\`, \`supervisor\`, \`partner\`, and \`managing_partner\`)**—excluded from \`admin\` by default and protected by override escalation guards so non-fee-earning administrators cannot exercise undertaking authority on their own behalf without explicit, authorised role/override governance.
- \`register:run_reminders\` (\`jobOnly: true\`): Reserved exclusively for the unattended \`register-reminders\` background job; never grantable to interactive users or roles.

## 4. Custom firm registers & configuration

Administrators with \`register:configure\` (and verified MFA) can open **Administration → Registers** (\`saveRegistersConfigAction\`) to:

- Enable or disable specific core register types, adjust default reminder lead days (\`defaultDueDaysBefore\`, \`defaultReviewDaysBefore\`, and \`defaultReminderHourLocal\`), or override labels, navigation visibility, reminder schedules, and \`additionalFields\` on built-in types.
- Add client-specific **custom register types** (custom \`key\`, \`referencePrefix\`, fields, states, transitions, and optional approval rules) validated against \`core/schemas/registers.config.schema.json\` with zero client code in platform core.

## 5. Matter visibility, approvals & notifications

When a register record links to a matter (\`matterId\`), both repository visibility queries and server services enforce \`canAccessMatter\`. Records linked to a restricted staff matter (\`isStaffMatter\`) or ethical-wall matter (\`hasEthicalWall\`) are omitted from lists, detail lookups, Home workspace panels, matter tabs, notifications, and reminder dispatches for any user without matter access.

- **Approval requests (\`approval_requested\`):** Sent via \`pushNotification\` when an approval-governed record (\`sign_off\` or \`breach\`) is created or reassigned to a designated approver.
- **Approval decisions (\`approval_decided\`):** Sent to the record owner when an approver approves, rejects, or requests discussion on a sign-off or approval-governed register record.
- **Review assignments (\`register_review_assigned\`):** Sent when a non-approval register record is assigned to a reviewer or given a scheduled periodic review.

## 6. Extension hooks (executed outside write transactions)

Client extensions declaring \`register:read\` or \`register:write\` in their manifest may subscribe to three extension points:

1. \`register.beforeCreate\`: Runs **before** opening the PostgreSQL write transaction (\`!hasActiveTenantTransaction(ctx)\`), with a \`2000ms\` timeout. Throwing or returning \`allowProceed: false\` blocks creation fail-closed; returned \`enrichedFieldValues\` / metadata are validated and persisted inside the subsequent transaction.
2. \`register.beforeTransition\`: Runs **before** opening the transition transaction; throwing or returning \`allowProceed: false\` aborts the transition before any database write.
3. \`register.afterTransition\`: Runs **after** the PostgreSQL transaction commits; hook errors or timeouts are logged and isolated so committed transitions are never rolled back.

## 7. Automated due & review reminders (\`register-reminders\`)

An unattended scheduled Container Apps Job (\`caj-reg-rem-<env>\`, CLI job \`register-reminders\`) runs hourly (\`0 * * * *\`) under synthetic actor \`system:register-reminders\` with permission \`register:run_reminders\`:

- Inspects open, non-terminal register records whose \`dueAt\` or \`reviewAt\` matches a configured \`dueDaysBefore\` / \`reviewDaysBefore\` threshold (including overdue day \`0\`).
- Filters candidate recipients by \`recipientMode\` (\`owner_and_approver\`, \`owner_only\`, or \`matter_team_and_owner\`), \`register:view\` / \`undertaking:manage\` permission, and restricted-matter access.
- Records deduplicated keys in the register reminder state store in the same transaction as in-app notifications (\`kind: 'register_reminder'\`) and the firm audit log, and enqueues immediate outbound email (\`emailFrequency === 'immediate'\`) and opt-in Microsoft Teams activity alerts (\`teamsEnabled === true\`) atomically in that transaction followed by a post-commit outbox drain, guaranteeing idempotency across retries and scheduled sweeps.
`,
};
