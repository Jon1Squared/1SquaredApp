import type { DocArticle } from '../registry';

export const keyDatesTeamDiaryArticle: DocArticle = {
  slug: 'key-dates-team-diary',
  title: 'The team diary and multi-team compliance oversight',
  section: 'key-dates-limitation',
  summary:
    'Why every key date belongs to a team diary as its backup owner, how to use the Month, Week, and List views, and how compliance users filter across teams.',
  updated: '2026-11-03',
  body: `
A recurring cause of missed deadlines in legal practice is reliance on an individual fee earner's personal inbox or calendar when that person is on leave, unwell, or leaves the firm.

In 1Squared, **every key date belongs to a team diary (\`teamId\`, required)**. The team diary is the institutional backup owner. There is no individual backup owner field because the entire team and its leads share visibility and escalation responsibility.

## Navigating to the Team Diary

Select **Key dates** in the left-hand navigation rail (\`/key-dates\`). This link is visible to every user with the \`keydate:view\` permission.

## Calendar and list views

The Team Diary provides three synchronised views:
- **List view**: Displays key dates in chronological due-date order with status badges, critical indicators, responsible fee earners, reminder stage status, and inline **Verify / Reject** buttons for verifiers.
- **Month calendar view**: A 6-week monthly grid highlighting critical and standard deadlines on each day.
- **Week calendar view**: A 7-day rolling schedule showing team deadlines and ownership across the week.

## Filtering the diary

You can filter the diary by:
- **Team diaries**: Defaults to the teams you belong to.
- **Date range**: \`Due from\` and \`Due to\` dates.
- **Category**: \`limitation\`, \`procedural\`, \`contractual\`, \`regulatory\`, or \`internal\`.
- **Status**: Defaults to active open statuses (\`provisional\`, \`awaiting_verification\`, \`confirmed\`), with toggles for \`met\`, \`missed\`, \`waived\`, and \`superseded\`.
- **Critical only**: Shows only dates marked \`isCritical\`.
- **Awaiting verification queue**: Isolates dates waiting for second-person verification.

## Multi-team selector for Risk, Compliance & Managing Partners

Users holding the \`keydate:view_any_team\` permission (granted by default to \`risk_compliance\`, \`managing_partner\`, and \`admin\`) see an **All-team compliance selector** at the top of the diary. They can select any combination of teams simultaneously, switch to **Select all teams**, or narrow back to **My teams only**.

## Restricted (staff) matters

Where a matter is marked as a restricted staff matter (\`matter.restrictedAccessUserIds\` is non-empty), its key dates are filtered in the server data layer:
- Viewers listed in \`matter.restrictedAccessUserIds\` see the key date as normal.
- All other users — even those with \`keydate:view_any_team\` — receive **no entry and no placeholder** in the Team Diary, Reminders, or Exceptions report.
`,
};
