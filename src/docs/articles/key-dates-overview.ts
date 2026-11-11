import type { DocArticle } from '../registry';

export const keyDatesOverviewArticle: DocArticle = {
  slug: 'key-dates-overview',
  title: 'Overview: Key dates and limitation',
  section: 'key-dates-limitation',
  summary:
    'What key dates and limitation dates are, why the system suggests dates while qualified people confirm them, and how the lifecycle works across enquiries and matters.',
  updated: '2026-11-03',
  body: `
Key dates track time-critical obligations on enquiries and matters—most importantly **limitation dates**, **court deadlines**, **contractual dates**, **undertakings**, **compliance reviews**, and **internal milestones**.

> **Core safety principle:** The system suggests dates; a qualified person confirms them. No automatically calculated or document-extracted date becomes live without human confirmation.

## Why key dates matter

Missing a limitation date or court deadline is one of the most serious professional negligence and regulatory risks in legal practice. The Key Dates & Limitation module provides five layers of protection:

1. **Structured capture from enquiry to closure** — Key dates can be recorded at the initial enquiry stage and are automatically carried across when the enquiry converts into a matter (\`carried_from_enquiry\`).
2. **Rule-driven limitation calculator** — Calculates dates from firm-approved rule sets and business calendars with a step-by-step explanation, while keeping the solicitor in control.
3. **Two-step verification** — Where configured for a matter type (or when a rule set is marked \`unreviewed\`), a second person holding \`keydate:verify\` must confirm a proposed date before it becomes live.
4. **Team diary ownership & non-stacking reminders** — Every key date belongs to a **team diary** (\`teamId\`) as its backup owner alongside the named responsible people, and drives a single, non-stacking task in the Tasks workspace.
5. **Immutable audit trail & compliance exceptions** — Dates are never deleted. Changing a confirmed date creates a new key date that supersedes the old one with a recorded reason.

## Key date categories

Each tenant configures its own key date types under one of six standard categories:

| Category | Typical examples |
| --- | --- |
| \`limitation\` | Primary statutory or contractual limitation date, longstop date |
| \`court_deadline\` | Service of claim form, defence, disclosure, witness statements, hearing |
| \`contractual\` | Option exercise date, completion longstop, rent review notice |
| \`undertaking\` | Solicitor's undertaking discharge deadline |
| \`compliance\` | Periodic AML/CDD refresh, regulatory filing |
| \`internal_milestone\` | Target exchange, client review milestone |

## Status lifecycle

Every key date moves through a clear, auditable status lifecycle:

- **Provisional (\`provisional\`)** — Entered, calculated, or extracted from a document, but not yet relied upon. Dates extracted from documents always land as \`provisional\`.
- **Awaiting verification (\`awaiting_verification\`)** — Proposed by a fee earner or secretary where the matter type (or an unreviewed rule set) requires second-person verification by a different user with \`keydate:verify\`.
- **Confirmed (\`confirmed\`)** — Live date. Drives the single reminder task, appears as a confirmed deadline in the Team Diary, and syncs to Outlook (where enabled for the matter type and not a restricted staff matter).
- **Met (\`met\`)** — The required action was completed in time. Closes the linked reminder task.
- **Missed (\`missed\`)** — The date passed without action. Requires an outcome note and closes the reminder task while remaining visible in compliance reporting.
- **Waived (\`waived\`)** — No longer applies. Requires \`keydate:waive\` permission and a recorded reason.
- **Superseded (\`superseded\`)** — Replaced by a newer key date when a confirmed date is edited. Never deleted.

## Permissions summary

Key date permissions are granted to roles through tenant configuration (\`keyDates.permissions.roleGrants\` and central RBAC):

| Permission | Purpose |
| --- | --- |
| \`keydate:view\` | View key dates on accessible matters/enquiries and view own teams' diaries |
| \`keydate:view_any_team\` | Select any team diary and view/export the compliance exceptions report |
| \`keydate:edit\` | Add, edit, propose, supersede, and mark required key dates as not applicable |
| \`keydate:verify\` | Confirm or reject a date proposed by another user |
| \`keydate:resolve\` | Mark a key date as met or missed and acknowledge reminder stages |
| \`keydate:waive\` | Waive a key date with a mandatory reason |
| \`keydate:override_calculation\` | Override a calculated limitation date with a mandatory reason |
| \`keydate:configure\` | Configure key date types, matter types, reminder schedules, rule sets, and calendars (requires MFA) |

## Where key dates are stored

Key dates, "not applicable" records, reminder stages, Outlook sync state, and the firm's key-date configuration are held in the firm's own PostgreSQL database (one database per firm), not in the application's local working file. Every change to a key date and the matching entry in the firm audit log are saved together in a single database transaction: if either part fails, neither is saved, so the audit log can never disagree with the key date itself.

Staff matters and ethical walls are enforced in the database layer as well as on screen, so a key date on a restricted matter is never returned to someone outside the matter's access list.

## Related articles in this section

- [Adding, editing, superseding, and recording "not applicable"](/docs/key-dates-managing)
- [Using the limitation calculator](/docs/key-dates-limitation-calculator)
- [Two-step verification](/docs/key-dates-verification)
- [The team diary and selecting teams](/docs/key-dates-team-diary)
- [Reminders, stages, acknowledging, and escalation](/docs/key-dates-reminders)
- [Outlook calendar sync](/docs/key-dates-calendar-sync)
- [Compliance exceptions report](/docs/key-dates-exceptions)
- [Administration: configuring key dates](/docs/key-dates-administration)
`.trim(),
};
