import type { DocArticle } from '../registry';

export const registersEngineArticle: DocArticle = {
  slug: 'registers-engine',
  title: 'Configurable registers and undertakings',
  section: 'getting-started',
  summary:
    'How the Configurable Registers Engine manages undertakings, complaints, SRA breaches, periodic file reviews, partner sign-offs, tenant custom registers, extension hooks, and automated due/review reminders.',
  updated: '2026-11-16',
  body: `
The **Registers** workspace (\`/registers\`) provides a single, configurable per-tenant engine for regulatory and practice registers, persisted in PostgreSQL (\`0017_registers_engine_expand\`, \`TenantRegisterRepository\`) with full state-transition history (\`public.register_transitions\`), reminder deduplication (\`public.register_reminder_states\`), and same-transaction audit logging (\`public.audit_entries\`).

## 1. Built-in register types and direct undertaking creation

1Squared ships four core register definitions in \`CORE_REGISTER_TYPES\` (with tenant-defined custom registers such as periodic file reviews configured per firm in \`tenant_module_configs['registers']\`):

| Key | Label | Initial Status | Creation & Governance |
| --- | --- | --- | --- |
| \`sign_off\` | Sign-Off | \`pending_approval\` | Supports \`write_off\` and \`matter_opening\` sign-offs; transitions through \`pending_approval\` → \`discussing\` → \`approved\` / \`rejected\` with the no-self-approval rule enforced on the server |
| \`undertaking\` | Undertaking | \`open\` | **Direct creation without two-person approval** (\`approvalRules: null\`): any permitted fee earner (\`undertaking:manage\`) records an undertaking directly as \`open\` and can record variations (\`varied\`), mark overdue (\`overdue\`), reopen (\`open\`), discharge (\`discharged\`), or cancel (\`cancelled\`) |
| \`complaint\` | Client Complaint | \`open\` | Stages from \`open\` → \`investigating\` → \`resolved\` / \`closed\` |
| \`breach\` | Compliance Breach | \`logged\` | Stages from \`logged\` → \`remediation\` → \`closed\` (requiring \`register:approve\` with no self-approval) |

Undertakings live exclusively in the **Registers** engine rather than the partner sign-off queue (\`SignOffKind\` covers \`write_off\` and \`matter_opening\` only, and historical undertaking rows from \`public.sign_offs\` are backfilled into \`public.register_records\` during migration \`0017\`).

## 2. Permissions and role separation (\`undertaking:manage\`)

Access to registers and undertakings is governed by six user permissions and one background job permission:

- \`register:view\`: View register records in \`/registers\`, on Home panels, and on linked matter profiles.
- \`register:create\`: Create new non-undertaking register records (for example complaints, SRA breaches, and file reviews).
- \`register:edit\`: Update metadata and execute non-approval workflow transitions on accessible register records.
- \`register:approve\`: Execute formal approval/decision transitions on register types configured with approval rules (never permitting self-approval).
- \`register:configure\` (**requires MFA**): Configure firm register overrides, reminder schedules, and custom register types in **Administration → Registers**.
- \`undertaking:manage\`: Create, edit, vary, and discharge undertakings. **Restricted to fee-earning roles (\`fee_earner\`, \`supervisor\`, \`partner\`, and \`managing_partner\`)**—excluded from \`admin\` by default and protected by override escalation guards so non-fee-earning administrators cannot exercise undertaking authority on their own behalf without explicit, authorised role/override governance.
- \`register:run_reminders\` (\`jobOnly: true\`): Reserved exclusively for the unattended \`register-reminders\` background job; never grantable to interactive users or roles.

## 3. Custom firm registers & configuration (\`tenant_module_configs['registers']\`)

Administrators with \`register:configure\` (and verified MFA) can open **Administration → Registers** (\`saveRegistersConfigAction\`) to:

- Enable or disable specific core register types, adjust default reminder lead days (\`defaultDueDaysBefore\`, \`defaultReviewDaysBefore\`, and \`defaultReminderHourLocal\`), or override labels, navigation visibility, reminder schedules, and \`additionalFields\` on built-in types.
- Add client-specific **custom register types** (custom \`key\`, \`referencePrefix\`, fields, states, transitions, and optional approval rules) validated against \`core/schemas/registers.config.schema.json\` with zero client code in platform core.

## 4. Matter visibility and restricted matters

When a register record links to a matter (\`matterId\`), both SQL repository queries (\`REGISTER_RECORD_VISIBLE_SQL_PREDICATE\`) and server services enforce \`canAccessMatter\`. Records linked to a restricted staff matter (\`isStaffMatter\`) or ethical-wall matter (\`hasEthicalWall\`) are omitted from lists, detail lookups, Home workspace panels, matter tabs, notifications, and reminder dispatches for any user without matter access.

## 5. Extension hooks (executed outside write transactions)

Client extensions declaring \`register:read\` or \`register:write\` in their manifest may subscribe to three extension points:

1. \`register.beforeCreate\`: Runs **before** opening the PostgreSQL write transaction (\`!hasActiveTenantTransaction(ctx)\`), with a \`2000ms\` timeout. Throwing or returning \`allowProceed: false\` blocks creation fail-closed; returned \`enrichedFieldValues\` / metadata are validated and persisted inside the subsequent transaction.
2. \`register.beforeTransition\`: Runs **before** opening the transition transaction; throwing or returning \`allowProceed: false\` aborts the transition before any database write.
3. \`register.afterTransition\`: Runs **after** the PostgreSQL transaction commits; hook errors or timeouts are logged and isolated so committed transitions are never rolled back.

## 6. Automated due & review reminders (\`register-reminders\`)

An unattended scheduled Container Apps Job (\`caj-reg-rem-<env>\`, CLI job \`register-reminders\`) runs hourly (\`0 * * * *\`) under synthetic actor \`system:register-reminders\` with permission \`register:run_reminders\`:

- Inspects open, non-terminal register records whose \`dueAt\` or \`reviewAt\` matches a configured \`dueDaysBefore\` / \`reviewDaysBefore\` threshold (including overdue day \`0\`).
- Filters candidate recipients by \`recipientMode\` (\`owner_and_approver\`, \`owner_only\`, or \`matter_team_and_owner\`), \`register:view\` / \`undertaking:manage\` permission, and restricted-matter access.
- Records deduplicated keys in \`public.register_reminder_states\` in the same PostgreSQL transaction as in-app notifications (\`kind: 'register_reminder'\`) and \`public.audit_entries\`, guaranteeing idempotency across retries and scheduled sweeps.
`,
};
