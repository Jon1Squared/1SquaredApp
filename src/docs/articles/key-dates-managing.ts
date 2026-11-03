import type { DocArticle } from '../registry';

export const keyDatesManagingArticle: DocArticle = {
  slug: 'key-dates-managing',
  title: 'Adding, editing, superseding & recording "not applicable" key dates',
  section: 'key-dates-limitation',
  summary:
    'How to record manual or calculated key dates on matters and enquiries, supersede confirmed dates with a reason, resolve dates, and satisfy matter opening and closure gates.',
  updated: '2026-11-03',
  body: `
Key dates can be captured on both **Enquiries** (in the right-hand sidebar of an enquiry) and **Matters** (under the **Tasks & Dates** tab). When an enquiry converts into a matter, all active key dates are automatically carried across with \`source: 'carried_from_enquiry'\`.

## Adding a key date

1. Open the **Key dates & limitation** panel on the matter or enquiry.
2. Select **+ Add key date** and choose **Manual date entry** or **Limitation calculator** (see [Using the limitation calculator](/docs/key-dates-limitation-calculator)).
3. Choose the **Key date type**, **Title**, **Due date**, **Team diary** (defaults to the matter's owning team), and **Responsible people** (defaults to the employees listed on the matter).
4. Submit the date:
   - If the matter type (or an unreviewed limitation rule set) requires [two-step verification](/docs/key-dates-verification), the date enters \`awaiting_verification\`.
   - Otherwise, the date enters \`confirmed\` and creates its single linked reminder task.
   - You can also save an early estimate as \`provisional\` while awaiting medical records, contracts, or incident particulars.

## Why key dates are never deleted — superseding a confirmed date

For regulatory and professional indemnity compliance, key dates are **immutable once confirmed** and can never be deleted.

If a confirmed due date changes (for example, following a court order, a standstill agreement, or newly discovered facts):
1. Select **Edit / Supersede** on the confirmed key date.
2. Enter the **New due date** and a mandatory **Reason for superseding**.
3. The original record is marked \`superseded\` (with \`supersededById\` pointing to the new record), and the new record links back via \`supersedesId\`.
4. The existing reminder task is transferred to the new key date — a duplicate task is never created.

## Resolving a key date (Met, Missed, Waived)

When a deadline is satisfied or otherwise concluded:
- **Met**: Completed on or before the deadline (for example, claim form issued and served).
- **Missed**: Passed without completion. Recording a date as \`missed\` requires a mandatory explanation and is logged in the immutable audit trail.
- **Waived**: Waived by agreement or court order. Requires a mandatory reason.

Resolving a key date automatically closes its linked reminder task and updates or removes its synced Outlook calendar event.

## Matter opening gate and recording "Not applicable"

A matter type can specify \`requiredKeyDateTypeIds\` (for example, requiring a primary limitation date before a litigation or employment matter can transition from *Pre-open* to *Open*).

Until every required key date type is either:
- recorded as a key date on the matter, or
- explicitly marked **Not applicable** with a mandatory reason (` + '`keydate-not-applicable`' + ` in the audit log),

the matter cannot be opened.

## Matter closure gate

When \`blockClosureWithOpenDates\` is enabled for a matter type, the matter cannot be closed or archived while any key date remains \`provisional\`, \`awaiting_verification\`, or \`confirmed\`. Every date must first be resolved as \`met\`, \`missed\`, or \`waived\`.
`,
};
