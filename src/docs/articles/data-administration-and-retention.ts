import type { DocArticle } from '../registry';

export const dataAdministrationAndRetentionArticle: DocArticle = {
  slug: 'data-administration-and-retention',
  title: 'Data administration and retention',
  section: 'architecture-security',
  summary:
    'How non-live demo data reset and clean-deployment clear operations are protected by admin-only MFA permissions and audited, and how unconverted enquiry retention anonymisation is enforced.',
  updated: '2026-11-07',
  body: `
1Squared separates destructive environment data administration from routine firm configuration and enforces strict retention eligibility rules before personal data on closed enquiries can be anonymised.

## 1. Demo data reset and clean-deployment clear (\`admin:data_reset\`)

The **Admin → Demo data** tools (**Load demo dataset** and **Clear all data**) are restricted by three independent controls:

1. **Non-live environments only**: Both \`resetDemoDataAction\` and \`clearAllDataAction\` check \`isDataResetAllowedEnvironment()\`. They are refused whenever the active tenant configuration has \`environment: 'live'\`, or when \`NODE_ENV === 'production'\` outside \`dev\`, \`test\`, or \`training\`.
2. **System Administrator with MFA (\`admin:data_reset\`)**: Both actions require the \`admin:data_reset\` permission (\`requiresMfa: true\`), which is granted **exclusively to the built-in \`admin\` role** (and not to \`managing_partner\` or \`partner\`). An administrator signed in without multi-factor authentication receives \`MFA_REQUIRED\`.
3. **Post-reset audit trail**: Before resetting or clearing the store, 1Squared captures the acting administrator’s person ID and display name, then writes a \`data-reset\` or \`data-cleared\` audit entry into the newly initialised store. After clearing all data, the browser signs out cleanly via \`/api/auth/logout\` so stale session references cannot persist.

## 2. Enquiry retention anonymisation (\`enquiry:anonymise\`)

Unconverted closed enquiries retain personal contact details only until the firm’s configured retention period (\`enquirySettings.retentionMonths\`, default 12 months) expires:

- **Permission required**: Running anonymisation—either in bulk from **Admin → Enquiry settings** or for an individual enquiry from the enquiry profile—requires \`enquiry:anonymise\`, granted to **Risk & Compliance (\`risk_compliance\`)** and **System Administrator (\`admin\`)**. The single-enquiry **Anonymise** button is hidden when the signed-in user lacks \`enquiry:anonymise\`.
- **Retention period enforced on every path**: \`anonymiseExpiredEnquiries\` always evaluates \`isReadyForRetentionAnonymisation(enquiry, retentionMonths, now)\`, whether called in bulk or with a specific enquiry ID. An open enquiry, a converted enquiry, or a closed enquiry whose \`receivedAt\` date has not yet passed the retention cutoff is never anonymised early.
- **Clear user feedback**: If a user triggers single-enquiry anonymisation before the retention period has elapsed, 1Squared leaves the record untouched and displays *"Not yet due for anonymisation (retention period ends …)"* rather than a success message.
- **What is removed and retained**: When an eligible enquiry is anonymised, 1Squared scrubs the enquirer’s name, email, phone number, postal address, other named parties, and notes, while preserving the practice area, intake channel, dates, and closure outcome for management reporting, and records a \`Privacy retention anonymisation\` audit entry.
`,
};
