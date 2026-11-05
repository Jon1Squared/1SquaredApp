import type { DocArticle } from '../registry';

export const keyDatesExceptionsArticle: DocArticle = {
  slug: 'key-dates-exceptions',
  title: 'Exceptions report (compliance)',
  section: 'key-dates-limitation',
  summary:
    'How risk, compliance, and managing partners monitor all 10 key date exception kinds (9 matter/diary compliance kinds plus the admin data-integrity orphan check) across teams and export audited reports.',
  updated: '2026-11-04',
  body: `
The **Compliance exceptions** tab in the [Key Dates & Limitation Diary](/key-dates) gives Risk & Compliance officers, Managing Partners, and Administrators (\`keydate:view_any_team\`) a real-time view of every key date governance exception across the firm.

## The nine compliance exception kinds (plus admin data-integrity check)

The exceptions engine continuously evaluates open and closed matters against tenant configuration and surfaces every \`KeyDateExceptionKind\` category:

| Exception kind | When it triggers |
| --- | --- |
| \`matter_missing_required_date\` | An open matter is missing one or more \`requiredKeyDateTypeIds\` configured for its matter type (and no \`KeyDateNotApplicable\` record exists). |
| \`verification_overdue\` | A proposed key date has remained in \`awaiting_verification\` for more than 5 working days. |
| \`critical_date_no_recent_activity\` | A confirmed critical key date is due within 90 days on a matter with no recorded activity in the last 30 days. |
| \`closed_matter_open_dates\` | A closed or archived matter still has key dates in \`provisional\`, \`awaiting_verification\`, or \`confirmed\` status. |
| \`calculated_from_unreviewed_rules\` | An active key date was calculated from a limitation rule set whose \`reviewStatus\` is \`'unreviewed'\`. |
| \`reminder_escalated_unacknowledged\` | A key date reminder stage has escalated (\`escalationLevel > 0\`, without \`lastSkippedReason\`) and remains unacknowledged. |
| \`restricted_matter_no_permitted_assignee\` | A confirmed key date on a restricted/staff matter has no responsible person permitted to access the matter (\`lastSkippedReason: 'no_permitted_assignees'\`); reminder task creation was skipped to prevent disclosure. |
| \`orphan_key_date_missing_matter\` | Admin-only (\`keydate:configure\`) data-integrity exception when a key date references a missing matter record (\`kd.matterId && !matter\`), reporting only the \`keyDateId\`. |
| \`calendar_sync_failed\` | One-way synchronisation to Microsoft Outlook failed (\`lastSyncStatus: 'failed'\`). |
| \`past_due_unresolved\` | A confirmed key date has passed its \`dueDate\` without being resolved as \`met\`, \`missed\`, or \`waived\`. |

## Filtering and audited exports

- **Filter by team or exception kind**: Narrow the report to specific practice teams or specific exception types.
- **Restricted (staff) matters**: Exceptions belonging to restricted staff matters are omitted at the data layer unless the viewer is explicitly listed in \`matter.restrictedAccessUserIds\` or holds the \`matter:restricted:access\` permission grant.
- **Audited CSV and JSON exports**: Selecting **Export CSV (Audited)** or **Export JSON (Audited)** downloads the filtered report and writes an immutable \`keydate-export\` entry to the audit log.
`,
};
