import type { DocArticle } from '../registry';

export const signOffQueueArticle: DocArticle = {
  slug: 'sign-off-queue',
  title: 'Partner sign-off queue and approval rules',
  section: 'getting-started',
  summary:
    'Who can approve or discuss partner sign-off items, how matter access and assigned-partner checks work, and how the no-self-approval rule is enforced.',
  updated: '2026-11-21',
  body: `
The **Partner sign-offs & approvals** queue on the Partner and Managing Partner Home workspaces surfaces pending write-off sign-off requests (\`write_off\`, created through **Flag write-off** via \`flagMatterWriteOffAction\`); the \`sign_off\` register schema also defines \`matter_opening\`, although automatic matter-opening sign-off creation is not yet wired at runtime. Undertakings are managed directly by permitted fee earners in the [Configurable registers and undertakings](/docs/registers-engine) workspace without two-person partner sign-off. Sign-off items use the per-tenant Registers engine (\`sign_off\` register type via \`TenantTaskWorkflowRepository\` / \`TenantRegisterRepository\`, using a single unified \`SO-\` reference allocator), and every Home-queue write runs through \`createRegisterRecordService\` and \`transitionRegisterRecordService\`—enforcing optimistic concurrency (\`expectedRowVersion\`), recording full state-transition history, executing configured extension hooks, sending \`approval_requested\` and \`approval_decided\` notifications through \`pushNotification\`, and committing follow-up tasks and firm audit entries in the same transaction.

## 1. Who can approve or request discussion (\`signoff:approve\`)

Both \`approveSignOffAction\` (\`approveSignOff\`) and \`discussSignOffAction\` (\`discussSignOff\`) delegate to \`transitionRegisterRecordService\` and enforce the following rules on the server before changing a sign-off item:

1. **Permission (\`signoff:approve\`)**: The acting user must hold \`signoff:approve\`, which is granted by default to **Partner (\`partner\`)**, **Managing Partner (\`managing_partner\`)**, and **System Administrator (\`admin\`)**, and satisfies the engine’s approver-role rule (\`partner\`, \`managing_partner\`, \`risk_compliance\`, \`supervisor\`, or \`admin\`).
2. **Matter access (\`canAccessMatter\`)**: When a sign-off item is linked to a matter (\`matterId\`), the acting user must have access to that matter. If the matter is a restricted staff matter or has an ethical wall (\`hasEthicalWall: true\`), an unnamed partner without \`matter:restricted:access\` is denied.
3. **Assigned partner check (\`assignedPartnerId\`)**:
   - When \`assignedPartnerId\` is set on the sign-off item, **only that assigned partner** may approve or discuss it.
   - When \`assignedPartnerId\` is \`null\` (for example, an unassigned write-off request), any authorised approver holding \`signoff:approve\` who can access the matter may act on it.
4. **No self-approval (\`requestedById !== byId\`)**: The person who requested the sign-off (\`requestedById\`) is never permitted to approve or discuss their own request, even if they hold \`signoff:approve\`.
5. **Status & optimistic concurrency check**: Only sign-off items in \`Pending\` or \`Discussing\` status can be approved or discussed; passing a stale \`expectedRowVersion\` is refused cleanly so concurrent approvals or discussions cannot overwrite each other.

## 2. Discussing and flagging a sign-off request

- **Flagging a write-off (\`flagMatterWriteOffAction\`)**: Creates a \`sign_off\` record through \`createRegisterRecordService\` inside a single transaction with an audit entry and dispatches an \`approval_requested\` notification to the assigned partner (when \`assignedPartnerId\` is set and can access the matter).
- **Discussing (\`discussSignOffAction\`)**: Moves the sign-off item’s status to \`Discussing\`, stores the partner’s \`discussionNote\`, appends a transition history record and a \`status-change\` audit entry (\`Partner sign-off\`), creates a high-priority follow-up task (*"Discuss partner sign-off: …"*) for the original requester (\`requestedById\`), linked to the matter, and notifies the requester (\`approval_decided\`) subject to restricted-matter access.
- **Approving (\`approveSignOffAction\`)**: Moves the sign-off item to \`Approved\`, appends the transition history and \`Partner sign-off\` audit entry, increments the record version, and notifies the requester (\`approval_decided\`) subject to restricted-matter access.
`,
};
