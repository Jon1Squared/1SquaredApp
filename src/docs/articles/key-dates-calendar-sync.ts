import type { DocArticle } from '../registry';

export const keyDatesCalendarSyncArticle: DocArticle = {
  slug: 'key-dates-calendar-sync',
  title: 'Calendar sync: what syncs, per-matter-type settings & restricted matters',
  section: 'key-dates-limitation',
  summary:
    'How one-way Microsoft Graph sync publishes key dates to Outlook, why the platform remains the single source of truth, and how restricted staff matters and client confidentiality are protected.',
  updated: '2026-11-03',
  body: `
1Squared supports one-way synchronisation of key dates to Microsoft Outlook via Microsoft Graph using an Azure Managed Identity or Key Vault-referenced credentials.

> **Single source of truth**: 1Squared is always the source of truth. Editing or deleting a synced calendar entry inside Outlook does not alter or delete the key date in 1Squared.

## Per-matter-type configuration (on by default)

Calendar sync is resolved per matter type from \`matterTypes[].calendarSync.enabled\`, falling back to \`defaults.calendarSync.enabled\` (which defaults to \`true\`).

Only key dates whose status is listed in \`calendarSync.statusesToSync\` (by default \`['confirmed']\`) are published to Outlook:
- When a date becomes \`confirmed\`, an all-day calendar event (or timed event when \`dueTime\` is set) is created for each responsible person and any mapped team calendar in \`calendarSync.teamCalendarMappings\`.
- When a confirmed date is superseded or reassigned to a new team or responsible people, the Outlook events are updated in place and any removed owner's external event is deleted.
- When a key date is resolved (\`met\`, \`missed\`, \`waived\`) or moves out of \`calendarSync.statusesToSync\`, the external calendar events are removed.
- In environments where live Microsoft Graph calendar connectivity is not enabled on the default managed-identity adapter, the sync record state is recorded as \`'disabled'\` (never marked \`'synced'\` until a live Graph upsert succeeds).

## Protecting confidentiality and restricted (staff) matters

1. **Restricted (staff) matters never sync**: If a matter has \`isStaffMatter === true\` or a non-empty \`restrictedAccessUserIds\` list, calendar sync is hard-blocked in the sync engine (\`state: 'disabled'\`). If an existing matter becomes restricted, any previously synced calendar events are deleted via \`deleteEvent\`.
2. **No client names by default**: Event titles are formatted from \`calendarSync.eventTitleTemplate\` (by default \`"{matterReference} — {keyDateTypeLabel}: {title}"\`), which includes the matter reference, key date type label, and key date title without exposing client names in calendar subjects. Matter descriptions are omitted unless \`calendarSync.includeMatterDescription\` is set to \`true\`.
3. **Zero client content in logs**: Sync diagnostic logs include only \`correlationId\`, \`tenantId\`, \`keyDateId\`, and redacted error messages — never client names or personal data.

## Handling sync failures

If Microsoft Graph returns an error, the failure is recorded in \`KeyDateCalendarSync\` (\`state: 'failed'\`, \`lastError\`, \`attempts\`) and automatically surfaced as a \`calendar_sync_failed\` item in the [Compliance exceptions report](/docs/key-dates-exceptions).
`,
};
