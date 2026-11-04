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
- **Matter opening gate**: When a matter type specifies \`requiredKeyDateTypeIds\`, a matter cannot transition from *Pre-open* to *Open* until each required key date type is either added or recorded as **Not applicable** with a mandatory reason. Opening a matter always goes through the matter form (\`saveMatterRecord\`), which runs any enabled \`beforeMatterOpen\` extension gate and requires all configured extension manifests to load cleanly. Server-owned governance fields in \`matter.fieldValues\` (\`partnerCostSignOffCompleted\`, \`partnerCostSignOff\`, \`matterOpeningSnapshot\`, \`matterCostsGovernance\`, \`riskAssessment\`) and \`matter.conflictClearedById\` are stripped from caller input in \`saveMatterRecord\`; once a matter is open, its \`matterOpeningSnapshot\` is preserved unchanged. Partner cost sign-off on high-value fee estimates is recorded exclusively through \`signOffMatterCostsRecord\` (\`signOffMatterCostsAction\`), which requires the \`matter:costs:sign_off\` permission (granted to \`partner\`, \`managing_partner\`, and \`admin\`), writes an audit entry, and automatically resets if \`feeEstimateGbp\` / \`agreedFeeCapGbp\` subsequently changes. Approving a referred conflict review via \`updateMatterConflictRecord\` records the conflict decision on the matter and only sets \`matterStatusId\` to \`Active\` if the matter has already passed the opening gate; it never opens a draft matter directly.
- **Matter closure gate**: When \`blockClosureWithOpenDates\` is enabled for the matter type, the matter cannot be closed or archived while any key date remains \`provisional\`, \`awaiting_verification\`, or \`confirmed\`.
- **Restricted (staff) & ethical-wall matters and enquiries**: Matters with \`isStaffMatter\`, \`hasEthicalWall\`, or \`restrictedAccessUserIds\` and restricted enquiries (personal \`Draft\` enquiries belonging to another user or enquiries linked to/converted into a restricted matter) enforce strict server-side access control via the shared \`buildRecordVisibility\` helper (\`src/server/visibility.ts\`) across \`getAppSnapshot\`, matter lists, linked tasks, enquiries, quotes, notes, audit entries, PMS summary views, team diaries, reminders, and compliance exceptions, and never sync to external Outlook calendars. Matter conflict searches (\`runMatterConflictSearchRecord\`, \`saveMatterRecord\`, and \`updateMatterConflictRecord\`) execute exclusively on the server across all tenant matters and enquiries (with no browser-side fallback); when a match falls on a matter or enquiry the current user cannot view, 1Squared returns a redacted match (\`Match on a restricted matter\` or \`Match on a restricted enquiry\`, \`restricted: true\`) without exposing the restricted record's reference, client, summary, or partner, writes a count-only \`conflict_search_restricted_match\` audit and log entry (with zero party or matter names), and requires the matter to be referred to Risk (\`submit_referred\`). When Risk & Compliance approves a referred conflict review, \`updateMatterConflictRecord\` records the server-verified \`approvedRestrictedMatchIds\`; adding any new unapproved restricted match after approval blocks \`submit_cleared\` until Risk reviews and approves the new match. Note that Risk & Compliance reviewers who are not on an ethical-wall matter's \`restrictedAccessUserIds\` see the redacted restricted match unless they inspect the underlying record outside the matter opening form or hold \`matter:restricted:access\` / \`matter:restriction:lift\`.

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
