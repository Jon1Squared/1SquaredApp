import type { DocArticle } from '../registry';

export const mattersEnquiriesTasksNavigationArticle: DocArticle = {
  slug: 'matters-enquiries-tasks-and-navigation',
  title: 'Matters, enquiries, tasks & navigation: how key dates integrate across the workspace',
  section: 'getting-started',
  summary:
    'How the Key Dates & Limitation module connects with Enquiries, Matter opening and closure gates, the single-task reminder model, and left-rail navigation.',
  updated: '2026-11-04',
  body: `
This guide explains how **Matters**, **Enquiries**, **Tasks**, and **Navigation** work together across 1Squared, including how the [Key Dates & Limitation](/docs/key-dates-overview) module and conflict review routing integrate into each screen.

## Enquiries and conversion to a matter

- On the **Enquiry detail** screen (\`/enquiries/[id]\`), fee earners and call handlers can capture early key dates (such as a provisional limitation date or ACAS early conciliation deadline) in the **Key dates & limitation** panel.
- When an enquiry is converted into a matter, every non-superseded key date on the enquiry is automatically carried across onto the new matter with \`source: 'carried_from_enquiry'\`, preserving its calculation audit trail and verification state.

## Matters: opening gate, Tasks & Dates tab, and closure gate

- **Matter profile (\`/matters/[id]\`)**: Under the **Tasks & Dates** tab, the **Key dates & limitation** panel sits alongside matter tasks and critical dates.
- **Matter opening gate**: Opening a matter enforces a unified opening gate (\`runMatterOpeningGate\`) across \`saveMatterRecord\`, \`signOffMatterCostsRecord\`, and \`updateMatterConflictRecord\`:
  1. All enabled extensions for the active tenant declaring \`beforeMatterOpen\` must have loaded without manifest or module errors (\`getExtensionHostLoadErrors\`).
  2. When the Key Dates module is enabled and the matter type (or practice area) specifies \`requiredKeyDateTypeIds\`, the matter cannot transition from *Pre-open* to *Open* until each required key date type is either added or recorded as **Not applicable** with a mandatory reason (\`evaluateMatterKeyDateOpeningGate\`). Brand-new matters whose matter type has required key dates must be saved as a draft first (\`"Save the matter as a draft and add its required key dates before opening"\`) so key dates or Not-applicable reasons can be recorded before opening.
  3. Every enabled \`beforeMatterOpen\` extension hook must return \`allowProceed: true\`.
  Draft saves of an unopened matter always set \`matterOpeningGate.allowProceed\` to \`false\` (never inferring a pass from \`beforeMatterCostsCalculate\`), so only a real \`runMatterOpeningGate\` check can record \`allowProceed: true\`. Server-owned governance fields in \`matter.fieldValues\` (\`partnerCostSignOffCompleted\`, \`partnerCostSignOff\`, \`matterOpeningSnapshot\`, \`matterOpeningGate\`, \`matterCostsGovernance\`, \`riskAssessment\`) and \`matter.conflictClearedById\` are stripped from caller input in \`saveMatterRecord\`; once a matter has actually opened, its \`matterOpeningSnapshot\` is preserved unchanged. Partner cost sign-off on high-value fee estimates is recorded exclusively through \`signOffMatterCostsRecord\` (\`signOffMatterCostsAction\`), which requires the \`matter:costs:sign_off\` permission (granted to \`partner\`, \`managing_partner\`, and \`admin\`), runs \`runMatterOpeningGate\`, writes an audit entry, and automatically resets when the matter's fee estimate (\`resolveMatterSignOffEstimateGbp\`: fee estimate, agreed cap, or calculated estimate) differs from the amount signed off. Approving a referred conflict review via \`updateMatterConflictRecord\` records the conflict decision on the matter and only sets \`matterStatusId\` to \`Active\` (and locks \`matterOpeningSnapshot\`) when \`matterOpeningGate.allowProceed === true\` and required key dates are present; otherwise the matter stays in \`Prospective / Enquiry\` status with a warning until all opening checks pass.
- **Matter closure gate**: When \`blockClosureWithOpenDates\` is enabled for the matter type, the matter cannot be closed or archived while any key date remains \`provisional\`, \`awaiting_verification\`, or \`confirmed\`.
- **Restricted (staff) & ethical-wall matters and enquiries**: Matters with \`isStaffMatter\`, \`hasEthicalWall\`, or \`restrictedAccessUserIds\` and restricted enquiries (personal \`Draft\` enquiries belonging to another user or enquiries linked to/converted into a restricted matter) enforce strict server-side access control via the shared \`buildRecordVisibility\` helper (\`src/server/visibility.ts\`) across \`getAppSnapshot\`, matter lists, linked tasks, enquiries, quotes, notes, audit entries, PMS summary views, team diaries, reminders, and compliance exceptions, and never sync to external Outlook calendars. Matter conflict searches (\`runMatterConflictSearchRecord\`, \`saveMatterRecord\`, and \`updateMatterConflictRecord\`) execute exclusively on the server across all tenant matters and enquiries (with no browser-side fallback); when a match falls on a matter or enquiry the current user cannot view, 1Squared returns a redacted match (\`Match on a restricted matter\` or \`Match on a restricted enquiry\`, \`restricted: true\`) without exposing the restricted record's reference, client, summary, or partner, logs a count-only \`conflict_search_restricted_match\` structured log (and writes a matter audit entry when \`currentMatterId\` is a saved matter, with zero party or matter names), and requires the matter to be referred to Risk (\`submit_referred\`). Even users holding \`risk:view\` cannot \`submit_cleared\` a matter with unapproved restricted matches (\`hasUnapprovedRestrictedMatches\`) unless they explicitly record \`status: 'Approved'\`. Both \`saveMatterRecord\` and \`updateMatterConflictRecord\` construct \`ConflictCheckRecord\` on the server (\`buildServerConflictCheckRecord\`), preserving stored comments and runs and setting \`approvedById\` / \`approvedByName\` / \`approvedAtDisplay\` and \`approvedRestrictedMatchIds\` only when a \`risk:view\` holder records \`Approved\` or \`Declined\`. Only \`matter:restricted:access\` allows Risk & Compliance reviewers to see full match details on a restricted matter they are not otherwise assigned to, and other users' personal \`Draft\` enquiries always appear as restricted.

## Referred conflict review routing (\`conflictReview\`)

- When a matter is saved with a referred conflict check (\`submit_referred\`), 1Squared creates or updates a conflict review task using the tenant configuration section \`conflictReview\`:
  - \`conflictReview.assigneeTeamKey\`: Stable team \`id\` or organisation team \`code\` of the team that receives referred conflict reviews (for example \`"TM-000009"\`). Display names are not matched.
  - \`conflictReview.assigneeRoleKey\`: Optional stable role key (\`employee_role.*\` or \`HomeRoleKey\`, such as \`"employee_role.risk_and_compliance"\`) used to select an assignee within that team.
- Candidate assignees are filtered by \`canPersonAccessMatter\` so a restricted or staff matter is never assigned to someone outside its allow-list.
- When \`conflictReview.assigneeTeamKey\` is not configured or no permitted assignee matches, the task is left unassigned in the team queue (\`assignedPersonIds: []\`) and a structured \`conflict_review_task_unassigned\` warning is logged. On restricted or staff matters with no permitted reviewer, the task uses a generic title (\`[Ref] Conflict review required (restricted matter)\`) that omits client and matter names.
- Recording an \`Approved\` or \`Declined\` conflict decision via \`updateMatterConflictRecord\` requires the \`risk:view\` permission in addition to \`matter:edit\`, and records \`conflictClearedById\` / \`approvedById\` from the authenticated server caller.

## Tasks: one reminder task per confirmed key date

- Confirming a key date creates or updates **one** linked \`Task\` in the Tasks workspace (\`/tasks\`) with the deterministic idempotency key \`keydate-reminder:{tenantId}:{keyDateId}\`.
- \`assignedTeamId\` is set to the key date's \`teamId\` (the team diary backup owner) and \`assignedPersonIds\` is set to its \`responsiblePersonIds\`.
- As the key date crosses countdown stages (e.g. 90 days to 60 days), the daily tenant job updates that **same task** in place rather than stacking duplicate tasks. Standard task rules (\`canUserTakeTask\`, \`canUserReassignTask\`) apply.

## Navigation (\`getLeftRailVisibility\`)

- The left-hand navigation rail includes **Key dates** (\`/key-dates\`), controlled by \`leftRailVisibility.keyDates\` and visible to any user holding the \`keydate:view\` permission.
- System configuration for key dates is available under **Admin → Key dates & limitation** (\`/admin/key-dates\`) for users holding \`keydate:configure\`.
`,
};
