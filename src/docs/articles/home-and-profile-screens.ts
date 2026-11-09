import type { DocArticle } from '../registry';

export const homeAndProfileScreensArticle: DocArticle = {
  slug: 'home-and-profile-screens',
  title: 'Home panels, profile compliance statuses and empty states',
  section: 'getting-started',
  summary:
    'How role-based Home panels, matter intake and compliance cards, and person and organisation compliance displays derive their values from stored records and show honest empty states when a module or screening integration is not yet connected.',
  updated: '2026-11-09',
  body: `
1Squared displays only stored, tenant-scoped records and practice management system (PMS) figures on every workspace screen. Product screens never fall back to invented client names, hard-coded figures, or fabricated compliance statuses.

## 1. Role-based Home panels and empty states

Each role’s Home page renders a configurable set of panels (\`data-panel-id\` from \`src/domain/homeConfig.ts\`). Every panel follows one of two patterns:

1. **Data-driven panels** compute their rows and summary metrics from the signed-in user’s accessible matters, enquiries, quotes, tasks, key dates, sign-offs, and (where permitted by \`finance:view_matter\` or \`finance:view\`) PMS financial records. Examples include:
   - **\`todays_outcomes_and_conversion\`**, **\`enquiries_and_conversion_by_practice_area\`**, and **\`referral_sources_this_month\`**: count visible enquiries received in the current \`Europe/London\` calendar month (\`receivedAt\`, \`formatLondonDateIso\`, \`computeEnquiryDashboardMetrics\`) by status (\`Converted\`, \`In contact\`, \`Declined\`, \`Referred out\`, \`No response\`, and open/unassigned) and calculate conversion and channel totals from those current-month enquiries, with **\`enquiries_and_conversion_by_practice_area\`** and **\`pt_enquiries_month\`** filtered to the partner’s team practice areas and teams (\`filterEnquiriesForPracticeAreasAndTeams\`, where the user’s teams include active teams they belong to via \`memberIds\` or lead via \`leadIds\`; showing \`No practice area set\` / \`—\` when the user has neither).
   - **\`key_dates_and_deadlines\`** and **\`upcoming_completions_and_filings\`**: list upcoming key dates and milestones on accessible matters ordered by due date.
   - **\`conflict_checks_awaiting_decision\`** (and the **\`rc_conflicts_pending\`** headline card): use \`isMatterConflictCheckAwaitingDecision\` to count and list accessible matters whose \`conflictCheckRecord.status\` is \`Referred\` (or, when \`conflictCheckRecord\` is absent, whose legacy \`conflictCheckStatus\` maps to \`Referred\` via \`conflictStatusPillFromLegacy\` and \`conflictDecision\` is \`null\`).
   - **\`matter_openings_in_progress\`** (and **\`ls_matter_openings\`**) and **\`overdue_compliance_tasks_by_team\`**: resolve in-progress matter statuses (\`prospective\`, \`cmi_incomplete\`) and compliance/onboarding task types (\`conflict_check\`, \`complete_matter_opening\`) by \`systemKey\` via \`valueBySystemKey\` (\`isMatterOpeningInProgress\`, \`computeMatterOpeningChecklistProgress\`, \`isComplianceOrOnboardingTask\`).
   - **\`matters_needing_partner_attention\`**, **\`high_risk_matters_and_pep_register\`**, and the **\`rc_high_risk_matters\`** headline card: flag or list open matters whose stored \`riskRatingId\` is **High** or **Critical** (\`isHighOrCriticalRiskRating\` / \`HIGH_RISK_RATING_IDS\`, matching \`risk_rating.high\` and \`risk_rating.critical\` or \`systemKey\` \`'high'\` / \`'critical'\`), while noting on \`high_risk_matters_and_pep_register\` that PEP and sanctions watch screening is not yet available.
   - **\`enquiries_conversion_and_pipeline\`** and **\`ec_callbacks_due\`**: \`computeEnquiryDashboardMetrics\` calculates the first-contact SLA-met percentage over enquiries that have been contacted (comparing the earliest \`contactLog[].at\` timestamp against \`firstContactDueAt\`) or are already overdue (comparing \`firstContactDueAt\` against the real \`nowIso\` instant), so uncontacted enquiries that are not yet due do not inflate the SLA percentage and later follow-up calls do not mask an on-time first contact, and shows \`—\` when no enquiries have been evaluated yet. \`ec_callbacks_due\` (\`callbacksDueTodayCount\`) counts open uncontacted enquiries (\`contactLog.length === 0\`) due today in \`Europe/London\`.
   - **\`callback_sla_queue\`**: lists all open enquiries ordered by \`firstContactDueAt ?? receivedAt\` and marks an open enquiry \`SLA overdue\` only when \`contactLog.length === 0\` and its due timestamp is in the past (\`isDueTimestampOverdue(e.firstContactDueAt, nowIso, todayIso)\`), matching \`overdueSlaCount\`.
   - **\`wip_ready_to_bill\`**, **\`disbursements_and_invoices_to_log\`**, and **\`disbursements_awaiting_billing\`**: list unbilled WIP and disbursements from the PMS across accessible matters (gated on \`finance:view_matter\` or \`finance:view\`), showing a neutral \`No estimate\` label on \`wip_ready_to_bill\` when a matter has no fee estimate.
   - **PMS period labels**: all PMS financial panels and headline cards (\`fe_hours_month\`, \`my_time_and_wip\`, \`mp_fees_ytd\`, \`mp_cash_month\`, \`cash_collection_vs_target\`, \`firm_financial_pulse\`, \`performance_by_department\`, \`team_workload_and_utilisation\`, and \`utilisation_and_realisation_by_grade\`) derive their month and year labels from the PMS extract \`asAtDate\` (or show \`—\` / \`PMS as-at date unavailable\` when missing or invalid) and display \`PMS as at <date>\` (\`formatPmsAsAtLabel\`).

2. **Empty-state panels for upcoming modules**: Where a register or workflow is scheduled for a later roadmap stage — **\`aml_and_cdd_queue\`** (and **\`rc_aml_pending\`**), **\`documents_and_correspondence_queue\`** (and **\`ls_letters_docs\`**), **\`undertakings_and_file_reviews\`**, **\`complaints_incidents_and_breaches\`** (and **\`rc_sra_breaches\`**), and **\`firm_risk_and_exceptions_register\`** — the panel remains in the layout and renders a neutral empty state (*"Not yet available"* or *"No open undertakings or scheduled periodic file reviews"*) with no positive status badge rather than invented rows or a fake *"0 pending"* / *"0 items"* badge.

Action buttons on Home and profile screens only appear when they perform a real server action or navigation (such as opening a record, recording a task, or downloading a CSV export). Prototype toast-only buttons are not shown.

## 2. Matter Intake & compliance card

On a matter profile (**Overview** tab), the **Intake & compliance** card is derived from the matter’s stored fields via \`resolveMatterIntakeComplianceRows\`:

| Row | Source fields on the matter | Shown when populated | Shown when not yet recorded |
| --- | --- | --- | --- |
| **Conflict check** | \`conflictDecision.outcome\`, \`conflictDecision.decidedAt\`, \`conflictCheckDate\` | \`Conflict check cleared\` (or the recorded outcome) with the decision date | \`Conflict check not recorded\` (\`—\`) |
| **Client due diligence** | \`amlCompletedAt\`, \`amlStatus\` | \`Verified <date>\` when \`amlCompletedAt\` is set | The stored \`amlStatus\` label, or \`Not recorded\` |
| **Engagement letter** | \`engagementLetterSignedAt\`, \`engagementLetterStatus\` | \`Engagement letter signed\` with the signed date | \`Engagement letter\` with the stored status (such as \`Drafted\` or \`Sent\`), or \`Not recorded\` |
| **Matter risk assessment** | Server-scored risk assessment (\`overallRisk\`, \`completedQuestions\`, \`totalQuestions\`) | \`Matter risk assessment (<Low/Medium/High> risk)\` with \`<completed>/<total> answered\` | \`Matter risk assessment (Not started)\` with \`0/<total> answered\` |

## 3. Person and organisation compliance displays ("Sanctions & PEP: Not checked")

On person and organisation profiles, the **Compliance & verification** card is derived from the record’s stored verification fields (\`resolvePersonComplianceDisplay\` and \`resolveOrganisationComplianceDisplay\`):

- **ID / Company verification**: reflects the stored verification status (\`Verified <date>\`, \`In progress\`, \`Expired\`, or \`Not verified\`).
- **Sanctions & PEP**: always displays **\`Not checked\`** in a neutral badge until an external sanctions and politically exposed person (PEP) screening provider is connected (tracked under roadmap item 34). The application never displays a hard-coded \`Clear\` status when no screening check has been run.
- **Re-check due**: shows the stored \`reviewDate\` on an organisation, or \`Not set\` when no review date has been scheduled.

## 4. External lookups (Companies House and UK postcodes)

- **UK address lookup**: queries the server-side \`/api/address-lookup\` route using the tenant’s configured Ideal Postcodes key. When address lookup is not configured or returns no match, the form displays a clear message prompting the user to enter the address manually, and never fills a fabricated street address.
- **Companies House lookup**: until the live Companies House API integration is enabled, searching from the organisation form reports *"Companies House lookup isn't set up"* rather than returning demo company records.
`,
};
