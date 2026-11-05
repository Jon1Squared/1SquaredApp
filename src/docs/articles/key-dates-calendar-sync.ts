import type { DocArticle } from '../registry';

export const keyDatesCalendarSyncArticle: DocArticle = {
  slug: 'key-dates-calendar-sync',
  title: 'Calendar sync: phase 1 status, per-matter-type settings & restricted matters',
  section: 'key-dates-limitation',
  summary:
    'Why Microsoft Graph Outlook calendar sync is not available in this phase (all records remain disabled until a live Graph adapter is delivered), why 1Squared is the single source of truth, and how restricted staff matters and client confidentiality are protected.',
  updated: '2026-11-03',
  body: `
Microsoft Outlook calendar synchronisation via Microsoft Graph is **not available in this phase**. Until a live Microsoft Graph calendar adapter is delivered in a subsequent release, no external Graph calls are made by default and every \`KeyDateCalendarSync\` record remains in state \`'disabled'\`.

> **Single source of truth**: 1Squared is always the source of truth. Even when an external calendar adapter is connected in a future phase, editing or deleting a calendar entry inside Outlook will never alter or delete the key date in 1Squared.

## Per-matter-type configuration and sync contract

Calendar sync policy is resolved per matter type from \`matterTypes[].calendarSync.enabled\`, falling back to \`defaults.calendarSync.enabled\` (which defaults to \`true\`).

When a live Graph calendar adapter is supplied:
- Only key dates whose status is listed in \`calendarSync.statusesToSync\` (by default \`['confirmed']\`) are eligible for publication:
  - When a date becomes \`confirmed\`, an all-day calendar event (or timed event when \`dueTime\` is set) is created for each responsible person and any mapped team calendar in \`calendarSync.teamCalendarMappings\`.
  - When a confirmed date is superseded or reassigned to a new team or responsible people, external events are updated in place and any removed owner's external event is deleted.
  - When a key date is resolved (\`met\`, \`missed\`, \`waived\`) or moves out of \`calendarSync.statusesToSync\`, external calendar events are removed.
- In the current release without a live Microsoft Graph adapter, \`syncKeyDateToOutlookCalendar\` records \`state: 'disabled'\` and \`externalEvents: []\` on every key date (never marking a record \`'synced'\` without a live Graph adapter).

## Protecting confidentiality and restricted (staff) matters

1. **Restricted (staff) matters never sync**: If a matter has \`isStaffMatter === true\` or a non-empty \`restrictedAccessUserIds\` list, calendar sync is hard-blocked in the sync engine (\`state: 'disabled'\`). If an existing matter becomes restricted, any previously synced calendar events are deleted via \`deleteEvent\`.
2. **No client names by default**: Event titles are formatted from \`calendarSync.eventTitleTemplate\` (by default \`"{matterReference} — {keyDateTypeLabel}: {title}"\`), which includes the matter reference, key date type label, and key date title without exposing client names in calendar subjects. Matter descriptions are omitted unless \`calendarSync.includeMatterDescription\` is set to \`true\`.
3. **Zero client content in logs**: Sync diagnostic logs include only \`correlationId\`, \`tenantId\`, \`keyDateId\`, and redacted error messages — never client names or personal data.

## Handling sync failures

When a calendar adapter returns an error, the failure is recorded in \`KeyDateCalendarSync\` (\`state: 'failed'\`, \`lastError\`, \`attempts\`) and automatically surfaced as a \`calendar_sync_failed\` item in the [Compliance exceptions report](/docs/key-dates-exceptions).
`,
};
