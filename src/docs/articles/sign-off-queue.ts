import type { DocArticle } from '../registry';

export const signOffQueueArticle: DocArticle = {
  slug: 'sign-off-queue',
  title: 'Partner sign-off queue and approval rules',
  section: 'getting-started',
  summary:
    'Who can approve or discuss write-off sign-offs and two-stage High-risk matter openings, how matter access and assigned-partner checks work, and how distinct approver and no-self-approval rules are enforced.',
  updated: '2026-11-25',
  body: `
The **Sign-offs & approvals** queue on the Partner, Managing Partner, Risk & Compliance, and Supervisor Home workspaces surfaces pending write-off sign-off requests (created through **Flag write-off**) alongside Stage 1 and Stage 2 **High-risk matter opening** approvals. In addition, the **High-risk matters & PEP register** panel on the Risk & Compliance Home workspace highlights prospective matters awaiting Stage 2 Risk & Compliance sign-off. Undertakings are managed directly by permitted fee earners in the [Configurable registers and undertakings](/docs/registers-engine) workspace without two-person partner sign-off. Every sign-off and High-risk opening decision checks matter permissions, enforces concurrency protection, records full approval history and firm audit entries, and notifies the requester automatically.

## 1. Who can approve or request discussion on write-offs

Write-off approvals are aligned across the Home **Sign-offs & approvals** panel and **Registers**. On the server, approving or requesting discussion on a write-off enforces:

1. **Permission**: The acting user must hold write-off approval or register approval permission, permitting **Partner**, **Managing Partner**, **Risk & Compliance**, and **Supervisor** (non-fee-earning administrators cannot approve).
2. **Matter visibility**: When a sign-off item links to a matter, the acting user must have access to that matter (restricted staff matters and ethical-wall matters remain hidden unless specifically permitted).
3. **Assigned partner check**:
   - When a specific partner is assigned to the sign-off item, **only that assigned partner** may approve or discuss it.
   - When no specific partner is assigned, any authorised approver in those roles who can access the matter may act on it.
4. **No self-approval**: The person who requested the sign-off is never permitted to approve or discuss their own request, even if they hold approval permissions.
5. **Status & concurrent edit protection**: Only pending or discussing items can be updated, and stale saves are refused cleanly so concurrent approvals or discussions cannot overwrite each other.

## 2. Two-stage High-risk matter opening approvals

Matters rated **High** or **Critical** automatically raise a linked **High-risk opening** register item and stay **Prospective** until two separate approvals complete:

1. **Stage 1 — Partner approval**: Completed by an independent **Partner** or **Managing Partner** with access to the matter who is neither the matter’s lead fee earner nor its responsible partner (from Home, **Registers**, or the matter’s **Matter opening checklist & gate** panel).
2. **Stage 2 — Risk & Compliance approval**: Completed by a **different** **Risk & Compliance** officer (the Stage 1 partner cannot approve Stage 2, and administrators cannot bypass either stage). Completing Stage 2 re-evaluates the matter’s work-type opening gate and opens the matter automatically if every required precondition is satisfied.
3. **Rejection or automatic withdrawal**: Either stage can reject the high-risk opening with a reason (leaving the matter Prospective), and reducing the risk rating below High or abandoning the matter withdraws any open High-risk sign-off automatically.

## 3. Discussing and flagging a write-off sign-off request

- **Flagging a write-off (\`flagMatterWriteOffAction\`)**: Creates a \`sign_off\` record through \`createRegisterRecordService\` inside a single transaction with an audit entry and dispatches an \`approval_requested\` notification to the assigned partner (when \`assignedPartnerId\` is set and can access the matter).
- **Discussing (\`discussSignOffAction\`)**: Moves the sign-off item’s status to \`Discussing\`, stores the partner’s \`discussionNote\`, appends a transition history record and a \`status-change\` audit entry (\`Partner sign-off\`), creates a high-priority follow-up task (*"Discuss partner sign-off: …"*) for the original requester (\`requestedById\`), linked to the matter, and notifies the requester (\`approval_decided\`) subject to restricted-matter access.
- **Approving (\`approveSignOffAction\`)**: Moves the sign-off item to \`Approved\`, appends the transition history and \`Partner sign-off\` audit entry, increments the record version, and notifies the requester (\`approval_decided\`) subject to restricted-matter access.
`,
};
