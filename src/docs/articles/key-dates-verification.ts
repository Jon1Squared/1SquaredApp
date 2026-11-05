import type { DocArticle } from '../registry';

export const keyDatesVerificationArticle: DocArticle = {
  slug: 'key-dates-verification',
  title: 'Two-step verification: when it applies and how to verify or reject',
  section: 'key-dates-limitation',
  summary:
    'How four-eyes verification prevents single-person calculation errors on limitation and critical dates, and why proposers cannot verify their own dates.',
  updated: '2026-11-03',
  body: `
Professional indemnity insurers and risk teams recommend "four-eyes" verification for limitation and other critical deadlines. 1Squared enforces two-step verification at the domain and data layers.

## When two-step verification applies

Verification policy is resolved per matter type (\`matterTypes[].verification\`), falling back to the tenant default (\`defaults.verification\`, which is off by default).

When \`verification.required\` is \`true\`, the \`appliesTo\` setting determines which dates require verification:
- \`all\`: Every key date on matters of this type requires verification.
- \`critical_only\`: Only key dates where \`isCritical\` is \`true\` require verification.
- \`limitation_only\`: Only key dates in the \`limitation\` category require verification.

> **Unreviewed rule sets always require verification**: Any key date calculated from a limitation rule set whose \`reviewStatus\` is \`'unreviewed'\` automatically requires two-step verification, even if the matter type does not otherwise require it.

## How verification works

1. **Proposal**: When a user proposes a key date that requires verification, its status is set to \`awaiting_verification\` and \`proposedByPersonId\` / \`proposedAt\` are recorded.
2. **Queue visibility**: Dates awaiting verification appear immediately in the [Team diary](/docs/key-dates-team-diary) and in the **Awaiting verification queue** filter for users holding \`keydate:verify\`.
3. **Strict separation of duties**: The person who proposed the date (\`proposedByPersonId\`) can **never** verify their own date. Attempting to do so is rejected by the server regardless of role.
4. **Confirming (Verify)**: A different user with \`keydate:verify\` reviews the trigger dates, rule calculation, or source order and selects **Verify**. The date moves to \`confirmed\`, records \`verifiedByPersonId\` and \`verifiedAt\`, and creates its single reminder task.
5. **Rejecting (Reject)**: If the verifier spots an error, they select **Reject** and must provide a mandatory **rejection reason**. The date returns to \`provisional\` with \`rejectionReason\` recorded, and the proposer is notified to amend and re-propose it.

## Overdue verification monitoring

If a key date remains in \`awaiting_verification\` for more than 5 working days, it is automatically flagged as a \`verification_overdue\` exception in the [Compliance exceptions report](/docs/key-dates-exceptions).
`,
};
