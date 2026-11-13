import type { DocArticle } from '../registry';

export const keyDatesRemindersArticle: DocArticle = {
  slug: 'key-dates-reminders',
  title: 'Reminders: stages, acknowledging, escalation & why there is only ever one task per date',
  section: 'key-dates-limitation',
  summary:
    'How the daily tenant reminder scheduler updates a single linked task through countdown stages (180d to 1d), resets acknowledgements, and escalates unacknowledged reminders without stacking duplicate tasks.',
  updated: '2026-11-13',
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
1. It acquires a per-tenant PostgreSQL transaction advisory lock (\`pg_try_advisory_xact_lock(hashtext('onesquared_job:key-date-reminders:' || tenantId))\`) and checks the per-tenant \`public.job_runs\` ledger inside a single \`withTenantTransaction\` block.
2. If the key date has crossed into a closer stage (e.g. from 90 days to 60 days), the job **updates the existing task in place** — updating its stage label, priority, due date, and description.
3. It resets \`acknowledgedAt\` / \`acknowledgedByPersonId\` for the new stage, sends **one** notification, and writes immutable \`audit_entries\` attributed to \`system:key-date-reminders\` (for scheduled runs) or the administrator's \`personId\` (when triggered manually via **Run daily reminder check** in Admin → Key dates & limitation).
4. Fee earners can select **Acknowledge reminder stage** on the key date panel to confirm they have reviewed the upcoming deadline at the current stage.

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
`,
};
