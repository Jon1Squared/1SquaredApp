import type { DocArticle } from '../registry';

export const financeDataAndPermissionsArticle: DocArticle = {
  slug: 'finance-data-and-permissions',
  title: 'Finance data and permissions',
  section: 'architecture-security',
  summary:
    'Which roles can view matter-level and firm-wide Practice Management System (PMS) finance figures, how restricted matters are excluded from firm totals, and how credit-control actions are gated.',
  updated: '2026-11-08',
  body: `
1Squared delivers Practice Management System (PMS) financial figures through dedicated, permission-checked server loaders (\`src/server/financeServices.ts\`, ADR 0029). Financial figures are never included in the general page snapshot (\`getAppSnapshot\`), which exposes only boolean capabilities (\`finance: { canViewFirm, canViewMatter, canCreditControl }\`) derived strictly from the signed-in user’s effective permissions.

## 1. Who sees which finance figures

Finance visibility is divided into two read permissions and one action permission:

| Permission Key | Default Built-in Roles | What It Unlocks |
| --- | --- | --- |
| \`finance:view_matter\` | \`fee_earner\`, \`supervisor\`, \`partner\`, \`managing_partner\`, \`finance\`, \`admin\` | Matter-level PMS summaries, invoices, aged debt, disbursements, and client account ledgers on matters the user can access (\`getMatterFinanceRows\`, \`getMatterPmsViewBundle\`), client and corporate-group PMS summaries on Organisation and Person profiles (\`getClientPmsViewBundle\`), the user’s own weekly chargeable hours and fee-earner WIP figures (\`getMyFinanceFigures\`), and PMS financial attention alerts (\`attentionList\`). |
| \`finance:view\` | \`supervisor\`, \`partner\`, \`managing_partner\`, \`finance\`, \`admin\` | Firm-wide financial roll-ups (\`getFirmFinance\`): all fee-earner performance rows, monthly fees billed, cash received summaries, department financial breakdowns and firm totals, and firm-wide client financial summaries. |
| \`finance:credit_control\` | \`partner\`, \`managing_partner\`, \`finance\`, \`admin\` | Requesting draft bills, flagging matters for partner write-off review, and recording overdue-invoice credit-control actions. |

Users without \`finance:view_matter\` (such as \`call_handler\`, \`reception\`, \`paralegal\`, and \`risk_compliance\` by default) never receive PMS financial figures from the server, do not see PMS financial alerts in their attention list, and do not see the **Time & billing** tab or financial KPI cards on Matter, Organisation, or Person profiles.

A fee earner holding \`finance:view_matter\` without \`finance:view\` receives their own weekly hours and WIP figures and matter-level financials for matters they can access, while calls to \`getFirmFinance\` return \`ActionDenied\` (\`FORBIDDEN\`).

## 2. Restricted matters and ethical walls are excluded from all totals

Every finance loader enforces matter-level access (\`buildRecordVisibility\` and \`canPersonAccessMatter\`) before computing any figure or roll-up (\`buildFirmFinanceRollups\`, \`buildClientFinancialsFromRows\`, and \`buildFeeEarnerWeeklyTime\` in \`src/domain/pms.ts\`):

- **Staff matters (\`isStaffMatter\`)** are visible only to users listed in \`restrictedAccessUserIds\`.
- **Information barriers / ethical walls (\`isInformationBarrierActive\` / \`hasEthicalWall\`)** are visible only to users on the matter’s permitted participant list.

When a user is outside a restricted matter’s allow-list, all time entries, invoices, aged-debt balances, payments, disbursements, and client-account rows belonging to that matter are excluded before calculating:

- **Fee-earner performance & weekly time**: chargeable hours, time value, unbilled WIP, billed value, and written-off amounts.
- **Monthly fees billed & year-to-date total**: net fees billed per calendar month.
- **Cash received**: monthly payment receipts and receipt counts.
- **Department financials & firm total**: open matters, billed this year, unbilled WIP, outstanding debt, overdue debt, and monthly hours.
- **Client & corporate-group financials**: unbilled WIP, fees billed, invoiced total, paid total, outstanding debt, aged-debt buckets, unbilled disbursements, client-account balance, and parent/subsidiary corporate-group totals (\`getClientPmsViewBundle\`).

As a result, firm-wide totals and client summaries shown to an authorised user who is not on a restricted matter’s allow-list exclude that restricted matter, while an authorised user on the allow-list sees the restricted matter included in their totals.

## 3. Credit-control and billing actions

Three server actions allow authorised users to trigger billing and credit-control workflows from the Partner and Finance Home workspaces:

1. **Request draft bill (\`requestMatterBillAction\` / \`requestMatterBill\`)**: Raises a high-priority review task on the matter for the lead fee earner to approve a draft bill for unbilled WIP.
2. **Flag write-off (\`flagMatterWriteOffAction\` / \`flagMatterWriteOff\`)**: Creates a pending \`write_off\` sign-off item assigned to the matter’s responsible or supervising partner when WIP exceeds a cap or estimate.
3. **Record invoice credit-control action (\`recordInvoiceCreditControlActionAction\` / \`recordInvoiceCreditControlAction\`)**: Logs a chase call or reminder statement note and audit entry against the client/matter, or raises an urgent partner escalation task (\`actionType: 'escalate'\`) on overdue invoices.

Each of these three actions is enforced by \`guardedAction\` with policy \`finance:credit_control\` (\`enforcedBy: 'action'\` in \`src/server/actionPermissions.ts\`, bringing \`MAX_KNOWN_GAPS\` to \`0\`) and also verifies inside the service that the target matter exists and is accessible to the acting user via \`canPersonAccessMatter\`. If the user lacks \`finance:credit_control\` or cannot access the matter, the action returns \`ActionDenied\` (\`code: 'FORBIDDEN'\`) and the UI displays the denial message without showing a success toast.
`,
};
