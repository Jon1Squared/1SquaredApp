import type { DocArticle } from '../registry';

export const keyDatesRemindersArticle: DocArticle = {
  slug: 'key-dates-reminders',
  title: 'Reminders: stages, acknowledging, escalation & why there is only ever one task per date',
  section: 'key-dates-limitation',
  summary:
    'How the daily tenant reminder scheduler updates a single linked task through countdown stages (180d to 1d), resets acknowledgements, and escalates unacknowledged reminders without stacking duplicate tasks.',
  updated: '2026-11-21',
  body: `
Traditional practice management systems often generate a brand-new reminder task at 180 days, another at 90 days, another at 60 days, and so on. That "task stacking" creates clutter and makes it dangerous when someone ticks off an old 90-day task thinking the deadline itself has been handled.

1Squared enforces a strict **one-task-per-key-date invariant**.

## Why there is only ever one task per key date

Each confirmed key date has:
- Exactly one \`KeyDateReminderState\`, and
- Exactly one linked \`Task\` in the tasks domain, keyed by the deterministic idempotency key \`keydate-reminder:{tenantId}:{keyDateId}\`.

The task's \`assignedTeamId\` is set to the key date's \`teamId\`, and \`assignedPersonIds\` is set to the key date's \`responsiblePersonIds\`. Standard task ownership rules (\`canUserTakeTask\`, \`canUserReassignTask\`) apply.

## Countdown stages and acknowledging

A reminder schedule defines countdown stages in days before the due date (for example, \`180 → 90 → 60 → 30 → 14 → 7 → 1\`), each with a priority (\`normal\`, \`high\`, \`urgent\`) and whether explicit acknowledgement is required.

When the daily tenant scheduler job (\`key-date-reminders\`) runs—triggered on an hourly UTC Container Apps schedule (\`0 * * * *\`) and executing once per local day on the first hourly tick at or after \`02:00\` in the tenant's configured IANA \`timeZone\` (default \`Europe/London\`, handling GMT/BST transitions automatically):
1. It acquires an exclusive per-tenant scheduler lock, checks the firm's scheduled job run ledger for today's local date, evaluates an unlocked snapshot of key dates to identify only the candidates whose reminder stage or linked task requires an update, and locks only those candidate records in ascending order (skipping any row currently locked by an active user edit so reminder acknowledgements and key-date updates are never delayed). If any candidate row was locked, the scheduler waits briefly and retries the skipped key dates once in a second lock pass; if any key date remains locked (or invisible to a manual trigger on a restricted matter the caller cannot access), it records \`skippedCount\` in the job summary and leaves today's scheduled completion open (instead of recording a completed full-day run) so the next hourly run evaluates the remaining dates on the same day. Same-stage writes preserve committed \`acknowledgedAt\` / \`acknowledgedById\` values unless the reminder was re-armed for a new stage window.
2. When a live calendar adapter is configured, any key dates whose Outlook calendar sync previously recorded a \`'failed'\` state are retried strictly after the scheduler transaction commits so external Graph calls never hold database locks.
3. If the key date has crossed into a closer stage (e.g. from 90 days to 60 days), the job **updates the existing task in place** — updating its stage label, priority, due date, and description.
4. It resets \`acknowledgedAt\` / \`acknowledgedByPersonId\` for the new stage, sends **one** notification, and writes immutable firm audit entries attributed to \`system:key-date-reminders\` (for scheduled runs) or the administrator's \`personId\` (when triggered manually via **Run daily reminder check** in Admin → Key dates & limitation).
5. Fee earners can select **Acknowledge reminder stage** on the key date panel to confirm they have reviewed the upcoming deadline at the current stage.
6. All create, propose, verify, supersede, acknowledge, and "not applicable" actions serialise under a transaction-scoped advisory lock per \`(tenant, scope, keyDateType)\`, so marking a key date type not applicable never races with reminder creation. Unconfirmed superseding replacements close the old reminder task without starting a new reminder until verified.

## Escalation when a stage is unacknowledged

If a stage requires acknowledgement and remains unacknowledged after \`escalation.afterUnacknowledgedDays\` (for example, 3 days):
- The scheduler steps through \`escalation.levels\` in order:
  - Level 1: \`matter_supervisor\`
  - Level 2: \`team_lead\`
  - Level 3: \`risk_compliance\`
- Escalation adds the escalation targets as watchers/assignees on the **same task** and sends an escalation notification. It never creates a second task.

## Superseding, resolving, and past-due dates

- **Superseding**: When a confirmed key date is superseded by a new date, the superseding date **takes over the same task** rather than creating a new one.
- **Resolving**: When a key date is resolved as \`met\`, \`missed\`, or \`waived\`, the linked task is automatically closed.
- **Past due, unresolved**: If a confirmed key date passes its \`dueDate\` without being resolved, it moves to **"Past due, unresolved"**, remains at the top urgency stage, and surfaces in the [Compliance exceptions report](/docs/key-dates-exceptions) until a user resolves it as \`met\` or \`missed\`.

## Delivery cadence (In-app, digests & Microsoft Teams)

- **Daily & weekly digests (\`S4\` defaults)**: Reminder tasks raised for key dates follow each assignee’s \`task_assigned\` preference (delivering an **Immediate email** when outbound email is enabled, subject to matter-restriction / ethical-wall verification before queueing). The separate \`key_date_approaching\` preference category remains reserved and hidden from the self-service preferences panel until dedicated approaching-stage notifications are wired directly to that category.
- **Microsoft Teams activity alerts**: When a user opts in to Teams notifications and \`integrations.teams.provider\` is enabled, Teams delivers only generic redacted category notices and relative deep links—never confidential matter titles, client names, or limitation notes.
`,
};
