import type { DocArticle } from '../registry';

export const homeAndProfileScreensArticle: DocArticle = {
  slug: 'home-and-profile-screens',
  title: 'Home panels, profile compliance statuses and empty states',
  section: 'getting-started',
  summary:
    'How role-based Home panels, matter intake and compliance cards, and person and organisation compliance displays derive their values from stored records and show honest empty states when a module or screening integration is not yet connected.',
  updated: '2026-11-08',
  body: `
1Squared displays only stored, tenant-scoped records and practice management system (PMS) figures on every workspace screen. Product screens never fall back to invented client names, hard-coded figures, or fabricated compliance statuses.

## 1. Role-based Home panels and empty states

Each role’s Home page renders a configurable set of panels (\`data-panel-id\`). Every panel follows one of two patterns:

1. **Data-driven panels** compute their rows and summary metrics from the signed-in user’s accessible matters, enquiries, quotes, tasks, key dates, sign-offs, and (where permitted by \`finance:view_matter\` or \`finance:view\`) PMS financial records. Examples include:
   - **Intake & Conversion Funnel**: counts visible enquiries by stage (received, routed, quoted, and converted to a matter) and calculates the conversion percentage from those counts.
   - **My Key Dates**, **Team Key Dates** and **Limitation & Key Dates Watchlist**: list open key dates on accessible matters ordered by due date.
   - **Compliance & AML Queue** and **PEP & High-Risk Client Register**: list people, organisations, and matters whose stored verification, AML status, PEP flag (\`isPep\`), or risk rating requires attention.
   - **High-Risk Matters Register**: lists accessible matters whose stored risk assessment or risk rating is **High**.
   - **Enquiry Response SLA & Callback Queue**: calculates the SLA-met percentage from enquiries with a recorded \`firstContactAt\` timestamp against \`slaDueAt\`, or shows \`—\` when no enquiries have been contacted yet.
   - **Unbilled Disbursements**: lists unbilled disbursements from the PMS across accessible matters (gated on \`finance:view_matter\`).

2. **Empty-state panels for upcoming modules**: Where a register or workflow is scheduled for a later roadmap stage — such as the central undertakings register, complaints register, breach and incident register, supervisory file reviews, reconciliations, regulatory returns, or live calendar sync — the panel remains in the layout and renders an honest empty state (for example, *"Undertakings register not yet available"* or *"No complaints recorded"*) rather than invented rows.

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
