import type { DocArticle } from '../registry';

export const financeDataAndPermissionsArticle: DocArticle = {
  slug: 'finance-data-and-permissions',
  title: 'Finance data and permissions',
  section: 'architecture-security',
  summary:
    'Which roles can view matter-level and firm-wide Practice Management System (PMS) finance figures, how unlinked and restricted matters are handled, and how credit-control actions are gated.',
  updated: '2026-11-09',
  body: `
1Squared delivers Practice Management System (PMS) financial figures through dedicated, permission-checked server loaders (\`src/server/financeServices.ts\`, ADR 0029). Financial figures are never included in the general page snapshot (\`getAppSnapshot\`), which exposes only boolean capabilities (\`finance: { canViewFirm, canViewMatter, canCreditControl }\`) derived strictly from the signed-in user’s effective permissions.

## 1. Who sees which finance figures

Finance permissions and their default built-in role grants in \`DEFAULT_RBAC_ROLES\` (\`@platform/core\`) are:

| Permission Key | Default Built-in Roles | What It Unlocks |
| --- | --- | --- |
| \`finance:view_matter\` | \`fee_earner\`, \`supervisor\`, \`risk_compliance\`, \`finance\`, \`partner\`, \`managing_partner\`, \`admin\` | Matter-level PMS summaries, invoices, aged debt, disbursements, and client account ledgers on linked 1Squared matters the user can access (\`getMatterFinanceRows\`, \`getMatterPmsViewBundle\`), client and corporate-group PMS summaries on Organisation and Person profiles (\`getClientPmsViewBundle\`), the user’s own weekly chargeable hours and fee-earner WIP figures (\`getMyFinanceFigures\`), and PMS financial attention alerts (\`attentionList\`). |
| \`finance:view\` | \`finance\`, \`partner\`, \`managing_partner\`, \`admin\` | Firm-wide financial roll-ups (\`getFirmFinance\`): all fee-earner performance rows, monthly fees billed, cash received summaries, department financial breakdowns and firm totals, and firm-wide client financial summaries. |
| \`finance:credit_control\` | \`finance\`, \`partner\`, \`managing_partner\`, \`admin\` | Requesting draft bills, flagging matters for partner write-off review, and recording overdue-invoice credit-control actions. |
| \`finance:manage_links\` | \`admin\` (requires MFA) | Linking or unlinking 1Squared records to PMS client, fee-earner, and matter codes, and receiving the \`allUnlinkedPmsMatters\` link-picker list in \`getMatterPmsViewBundle\`. |

Built-in roles without \`finance:view_matter\` by default (\`legal_secretary\`, \`enquiries_coordinator\`, and \`intake\`) never receive PMS financial figures from the server, do not see PMS financial alerts in their attention list, and do not see the **Time & billing** tab or financial KPI cards on Matter, Organisation, or Person profiles.

Roles holding \`finance:view_matter\` without \`finance:view\` (\`fee_earner\`, \`supervisor\`, and \`risk_compliance\` by default) receive their own weekly hours and WIP figures and matter-level financials for linked matters they can access, while calls to \`getFirmFinance\` return \`ActionDenied\` (\`FORBIDDEN\`).

## 2. Matter-level fail-closed linking and restricted-matter exclusion

1Squared distinguishes between matter-level loaders and firm-wide book totals (ADR 0029):

1. **Matter-level loaders fail closed on unlinked PMS rows (\`getMatterFinanceRows\`, \`getMyFinanceFigures\`, \`getMatterPmsViewBundle\`, and \`getClientPmsViewBundle\`)**: These loaders include only PMS rows whose \`matter_code\` maps through a \`pmsLinks\` entry to a 1Squared matter that the acting user can access via \`canPersonAccessMatter\` (\`buildRecordVisibility\`). \`getMyFinanceFigures\` computes the signed-in fee earner’s performance and weekly chargeable hours via \`buildFirmFinanceRollups\` and \`buildFeeEarnerWeeklyTime\` (\`src/domain/pms.ts\`). Any PMS matter that is not yet linked to a 1Squared matter is excluded from matter-level loaders, and \`allUnlinkedPmsMatters\` in \`getMatterPmsViewBundle\` is populated only when the user holds \`finance:manage_links\`.
2. **Firm-wide roll-ups include unlinked PMS rows while excluding restricted matters (\`getFirmFinance\`)**: Firm totals belong to the firm’s books and are restricted to \`finance:view\` holders (\`finance\`, \`partner\`, \`managing_partner\`, and \`admin\`). \`getFirmFinance\` includes unlinked PMS rows in the firm totals, while excluding any PMS rows linked to a restricted 1Squared matter that the user cannot access (\`buildFirmFinanceRollups\` and \`buildClientFinancialsFromRows\` in \`src/domain/pms.ts\`). Current-year totals (\`chargeable_hours\`, \`pct_of_annual_target\`, \`yearToDateTotal\`, and department \`billedThisYear\`) are scoped to the PMS extract \`asAtDate\` year up to \`asAtDate\`, and if \`asAtDate\` is missing or not a valid \`YYYY-MM-DD\` date, \`getExtractInfo\` and the finance loaders return an unavailable state (\`PMS as-at date unavailable\`) with empty figures.

Restricted 1Squared matters checked by \`canPersonAccessMatter\` (\`src/server/rbacRuntime.ts\`) are:

- **Staff matters (\`isStaffMatter\`)**: visible only to users listed in \`restrictedAccessUserIds\` (plus users holding \`matter:restricted:access\` when permitted by policy).
- **Ethical walls (\`hasEthicalWall\`)**: visible only to users listed in \`restrictedAccessUserIds\`.

When a user cannot access a restricted matter, all time entries, invoices, aged-debt balances, payments, disbursements, and client-account rows belonging to that matter are excluded before calculating:

- **Fee-earner performance & weekly time**: chargeable hours, time value, unbilled WIP, billed value, and written-off amounts.
- **Monthly fees billed & year-to-date total**: net fees billed per calendar month (derived from the PMS extract \`asAtDate\`).
- **Cash received**: current-month and previous-month payment receipts and receipt counts (derived from the PMS extract \`asAtDate\`).
- **Department financials & firm total**: open matters, billed this year, unbilled WIP, outstanding debt, overdue debt, and current-month chargeable hours.
- **Client & corporate-group financials**: unbilled WIP, fees billed, invoiced total, paid total, outstanding debt, aged-debt buckets, unbilled disbursements, client-account balance, and parent/subsidiary corporate-group totals (\`getClientPmsViewBundle\`).

## 3. Credit-control and billing actions

Three server actions allow authorised users to trigger billing and credit-control workflows from the Partner and Finance Home workspaces:

1. **Request draft bill (\`requestMatterBillAction\` / \`requestMatterBill\`)**: Raises a high-priority review task on the matter for the lead fee earner to approve a draft bill for unbilled WIP.
2. **Flag write-off (\`flagMatterWriteOffAction\` / \`flagMatterWriteOff\`)**: Creates a pending \`write_off\` sign-off item assigned to the matter’s responsible or supervising partner when WIP exceeds a cap or estimate.
3. **Record invoice credit-control action (\`recordInvoiceCreditControlActionAction\` / \`recordInvoiceCreditControlAction\`)**: Verifies that the invoice exists in the PMS, belongs to the specified \`matterCode\`, and matches \`clientCode\` (taking the client code from the PMS invoice record), then logs a chase call or reminder statement note and audit entry against the client/matter or raises an urgent partner escalation task (\`actionType: 'escalate'\`).

Each of these three actions is enforced by \`guardedAction\` with policy \`finance:credit_control\` (\`enforcedBy: 'action'\` in \`src/server/actionPermissions.ts\`, bringing \`MAX_KNOWN_GAPS\` to \`0\`), resolves the target 1Squared matter strictly through \`findOneSquaredIdForPmsCode(store.pmsLinks, 'matter', code)\` (never guessing from \`matterNumber\`), verifies that the PMS matter exists and the linked 1Squared matter is accessible to the acting user via \`canPersonAccessMatter\`, and in \`flagMatterWriteOff\` requires \`amountGbp\` to be a finite number greater than \`0\`. If the user lacks \`finance:credit_control\`, the PMS code is unlinked, the user cannot access the matter, or the request supplies an invalid write-off amount or mismatched invoice/client code, the action returns \`ActionDenied\` (\`code: 'FORBIDDEN'\`) and the UI displays the denial message without showing a success toast.
`,
};
