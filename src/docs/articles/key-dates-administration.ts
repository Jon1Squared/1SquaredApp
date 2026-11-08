import type { DocArticle } from '../registry';

export const keyDatesAdministrationArticle: DocArticle = {
  slug: 'key-dates-administration',
  title: 'Administration: configuring types, matter types, reminder schedules, rule sets & calendars',
  section: 'key-dates-limitation',
  summary:
    'How administrators and COLPs configure key date types, matter type policies, countdown schedules, limitation rule sets, and business calendars under strict JSON Schema validation and audit logging.',
  updated: '2026-11-08',
  body: `
All statutory limitation periods, reminder schedules, verification rules, and business calendars in 1Squared live in **schema-validated tenant configuration** (\`schemas/keyDates.config.schema.json\`), never in hardcoded core code.

Users with the \`keydate:configure\` permission (by default \`admin\` and \`risk_compliance\`) can manage this configuration in **Admin → Key dates & limitation** (\`/admin/key-dates\`).

## What you can configure

1. **Module & defaults**:
   - Enable or disable the feature (\`keyDates.enabled\`, which defaults to \`false\` for new tenants).
   - Set the default business calendar (\`defaultBusinessCalendarId\`), default reminder schedule, default verification policy, and default Outlook calendar sync rules.
2. **Key date types**:
   - Add, edit, or deactivate key date types (\`limitation\`, \`procedural\`, \`contractual\`, \`regulatory\`, \`internal\`), set whether a type is critical by default, and link default calculator rules and reminder schedules.
   - Set \`allowManualEntry\` (defaults to \`true\`). When \`allowManualEntry\` is \`false\`, manual date entry is disabled for that key date type: the key date creation form switches automatically to the limitation calculator, and any attempt to submit a manual date returns a structured validation denial (\`ActionDenied\` with code \`FORBIDDEN\`).
3. **Matter type settings**:
   - Configure \`requiredKeyDateTypeIds\` (enforced at the matter opening gate), \`blockClosureWithOpenDates\` (enforced at the matter closure gate), two-step verification policy (\`all\`, \`critical_only\`, \`limitation_only\`), and per-matter-type Outlook calendar sync.
4. **Reminder schedules**:
   - Inspect and configure countdown stages (\`daysBefore\`, \`priority\`, \`requiresAcknowledgement\`) and unacknowledged escalation levels (\`matter_supervisor\`, \`team_lead\`, \`risk_compliance\`, \`custom_role\`).
5. **Limitation rule sets**:
   - Review jurisdictional rule sets and toggle \`reviewStatus\` between \`unreviewed\` and \`reviewed\` once a qualified lawyer or COLP has verified the statutory periods. When a rule set is marked \`reviewed\`, the server records the authenticated actor's person ID in \`reviewedBy\` and today's date in \`reviewedOn\`; unmarking a rule set back to \`unreviewed\` clears both \`reviewedBy\` and \`reviewedOn\`.
6. **Business calendars**:
   - Maintain working days and bank holidays per jurisdiction (for example, England & Wales) used by the limitation calculator and overdue verification checks.

## Schema validation and immutable audit logging

Every configuration save is validated against \`keyDates.config.schema.json\` (rejecting unknown keys) and requires an explicit **audit reason**. The platform records a \`keydate-config-change\` entry in the immutable audit log containing the actor, timestamp, reason, and complete \`before\` and \`after\` configuration snapshots.
`,
};
