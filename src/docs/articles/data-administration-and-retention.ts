import type { DocArticle } from '../registry';

export const dataAdministrationAndRetentionArticle: DocArticle = {
  slug: 'data-administration-and-retention',
  title: 'Data administration and retention',
  section: 'architecture-security',
  summary:
    'How non-live demo data reset and clean-deployment clear operations are protected by admin-only MFA permissions and audited, and how scheduled and manual unconverted enquiry retention anonymisation is enforced.',
  updated: '2026-11-13',
  body: `
1Squared separates destructive environment data administration from routine firm configuration and enforces strict retention eligibility rules before personal data on closed enquiries can be anonymised.

## 1. Demo data reset and clean-deployment clear (\`admin:data_reset\`)

The **Admin → Demo data** tools (**Load demo dataset** and **Clear all data**) are restricted by three independent controls:

1. **Non-live demo-enabled environments only**: Both \`resetDemoDataAction\` and \`clearAllDataAction\` check \`isDataResetAllowedEnvironment()\`, which delegates to \`isNonLiveDemoEnvironment()\`. They are allowed only when the tenant \`environment\` is \`dev\`, \`test\`, \`training\`, or \`demo\` (never \`live\`) **and** \`featureFlags.enableDemoMode\` is \`true\`. Eligibility is decided strictly by tenant configuration rather than \`NODE_ENV\` (see [Demo environment](/docs/demo-environment)).
2. **System Administrator with MFA (\`admin:data_reset\`)**: Both actions require the \`admin:data_reset\` permission (\`requiresMfa: true\`), which is granted **exclusively to the built-in \`admin\` role** (and not to \`managing_partner\` or \`partner\`). An administrator signed in without multi-factor authentication receives \`MFA_REQUIRED\`.
3. **Post-reset audit trail**: Before resetting or clearing the store, 1Squared captures the acting administrator’s person ID and display name, then writes a \`data-reset\` or \`data-cleared\` audit entry into the newly initialised store. After clearing all data, the browser signs out cleanly via \`/api/auth/logout\` so stale session references cannot persist.

## 2. Enquiry retention anonymisation (\`enquiry:anonymise\` & \`enquiry:run_retention_anonymise\`)

Unconverted closed enquiries retain personal contact details only until the firm’s configured retention period (\`enquirySettings.retentionMonths\`, default 12 months) expires:

- **Automated daily scheduled job (\`enquiry-retention-anonymise\`)**: In addition to manual runs, an unattended Container Apps job (\`node dist/jobs/run-job.mjs enquiry-retention-anonymise\`, \`npm run job -- enquiry-retention-anonymise\` locally) checks hourly (\`0 * * * *\`) and executes once per tenant local calendar day at or after \`02:00\` in the tenant’s configured \`timeZone\` (\`default: 'Europe/London'\`). It runs via \`guardedJob('enquiry-retention-anonymise', ...)\` under the synthetic actor \`system:enquiry-retention-anonymise\`, which holds only the job-only permission \`enquiry:run_retention_anonymise\` (\`jobOnly: true\`, held by no interactive role including \`admin\`).
- **Manual permission required (\`enquiry:anonymise\`)**: Running anonymisation manually—either in bulk from **Admin → Enquiry settings** or for an individual enquiry from the enquiry profile (\`anonymiseExpiredEnquiriesAction\`)—requires \`enquiry:anonymise\`, granted to **Risk & Compliance (\`risk_compliance\`)** and **System Administrator (\`admin\`)**. The single-enquiry **Anonymise** button is hidden when the signed-in user lacks \`enquiry:anonymise\`.
- **Single-transaction execution & \`job_runs\` ledger**: Both scheduled and manual runs execute the shared \`runEnquiryRetentionAnonymisationForTenant\` helper inside a single PostgreSQL transaction (\`withTenantTransaction\`) that acquires \`pg_try_advisory_xact_lock(hashtext('onesquared_job:enquiry-retention-anonymise:' || tenantId))\`, reads \`retentionMonths\` and candidate enquiries inside the transaction, updates eligible \`public.enquiries\` rows and writes \`Privacy retention anonymisation\` entries into \`public.audit_entries\` (\`byId: 'system:enquiry-retention-anonymise'\` for scheduled runs or \`actor.personId\` for manual runs, with zero personal data), and records a non-PII summary (\`{ evaluatedCount, anonymisedCount, retentionMonths, scope: 'single' | 'bulk' }\`) in \`public.job_runs\` (\`trigger_source = 'scheduled'\` or \`'manual'\`). A bulk manual \`succeeded\` run satisfies that local day’s scheduled check, whereas a single-enquiry manual run (\`scope: 'single'\`) does not suppress the daily scheduled sweep for remaining expired enquiries.
- **Retention period enforced on every path (\`B3\`)**: \`runEnquiryRetentionAnonymisationForTenant\` and \`anonymiseExpiredEnquiries\` unconditionally evaluate \`isReadyForRetentionAnonymisation(enquiry, retentionMonths, now)\` on every candidate row inside the transaction, whether called by the scheduler, in bulk, or with a specific enquiry ID. An open enquiry, a converted enquiry, an already-anonymised enquiry, or a closed enquiry whose \`receivedAt\` date has not yet passed the retention cutoff is never anonymised early.
- **Clear user feedback**: If a user triggers single-enquiry anonymisation before the retention period has elapsed, 1Squared leaves the record untouched and displays *"Not yet due for anonymisation (retention period ends …)"* rather than a success message.
- **What is removed and retained**: When an eligible enquiry is anonymised, 1Squared scrubs the enquirer’s name (\`Anonymised Enquirer\`), organisation name, email, phone number, postal address, other named parties, notes, close notes, conflict snapshot, linked person/organisation IDs, and contact-log notes in \`public.enquiries\` while preserving the practice area, intake channel, source, dates, and closure outcome for management reporting, and writes the \`Privacy retention anonymisation\` entry into \`public.audit_entries\` in the same PostgreSQL transaction.

## 3. Administrative saves for lists, custom fields, teams & PMS links (\`admin:access\` and \`finance:manage_links\`)

All administrative configuration mutations in the \`/admin\` console require multi-factor authentication (\`mfaVerified === true\`) and are enforced at the server action boundary (\`enforcedBy: 'action'\`):

- **Choice lists & matter stage groups (\`admin:access\` + MFA)**: Adding, editing, deactivating, or reordering picklist values (\`addChoiceValueAction\`, \`updateChoiceValueAction\`, \`reorderChoiceValueAction\`) and creating matter stage groups (\`createMatterStageGroupAction\`) require \`admin:access\` with MFA, persisting to \`public.choice_lists\` and \`public.choice_values\` via \`TenantCatalogueRepository\` (\`S0-17c\`) in the same PostgreSQL transaction as \`public.audit_entries\`.
- **Custom fields (\`admin:access\` + MFA)**: Creating, updating, or reordering custom field definitions (\`saveCustomFieldAction\`, \`reorderCustomFieldAction\`) across People, Organisations, Matters, and Enquiries requires \`admin:access\` with MFA, persisting to \`public.custom_field_definitions\` via \`TenantCatalogueRepository\` (\`S0-17c\`) and merging at runtime with declarative \`tenantConfig.customFields\`.
- **Teams & self-escalation guard (\`admin:access\` + MFA)**: Creating or updating operational teams (\`saveTeamAction\`, persisted in \`public.teams\` via \`TenantHrAndRbacRepository\` in \`S0-17b\`) requires \`admin:access\` with MFA. Because team leadership (\`leadIds\`) grants relationship permissions (including \`employee:edit_core\`), \`saveTeamRecord\` also enforces the self-modification rule (\`SELF_MODIFICATION_FORBIDDEN\`): an administrator cannot add themselves as a team lead.
- **Firm settings, organisation structure, party taxonomy & matter costs (\`admin:access\` + MFA)**: Saving enquiry settings, automatic task templates, the organisation structure catalogue, matter party relationships/capacities/work-type profiles, Home page layouts, and matter costs rate cards (or syncing rates from the PMS) all require \`admin:access\` with MFA and persist to \`public.firm_profiles\` and \`public.tenant_module_configs\` via \`TenantCatalogueRepository\` (\`S0-17c\`).
- **PMS record linking & creation (\`finance:manage_links\` / \`admin:access\` + MFA)**: Linking, unlinking, and re-running automatic PMS matching require \`finance:manage_links\` with MFA; creating a 1Squared record from the PMS (\`createRecordFromPmsAction\`) requires \`admin:access\` with MFA plus \`employee:edit_core\` (for employees), \`matter:create\` (for matters), or \`contact:create\` (for people and organisations).

## 4. The firm audit log

- **Append-only**: Audit entries are stored in the tenant's own PostgreSQL database. The application role may only insert and read them; any attempt to edit or delete an entry is refused by the database.
- **Written with the change it describes**: An audit entry is saved in the same transaction as the change it records (for example key-date and Document Generation changes). If either fails, neither is saved.
- **Scoped views**: The **Firm audit log** section in **Admin** requires \`admin:access\` and shows up to 250 visible entries per page in reverse sequence order, with a **Next** cursor link (\`?auditBeforeSeq=…\`) to page through older entries. Entries about restricted staff matters and sensitive or payroll HR records are filtered out before filling each page for viewers without access.
- **Demo reset**: Loading the demo dataset reloads the audit log from the demo data, so audit reference numbers (\`AU-…\`) start again from the demo sequence.
`,
};
