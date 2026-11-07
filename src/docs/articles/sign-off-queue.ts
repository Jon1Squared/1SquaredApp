import type { DocArticle } from '../registry';

export const signOffQueueArticle: DocArticle = {
  slug: 'sign-off-queue',
  title: 'Partner sign-off queue and approval rules',
  section: 'getting-started',
  summary:
    'Who can approve or discuss partner sign-off items, how matter access and assigned-partner checks work, and how the no-self-approval rule is enforced.',
  updated: '2026-11-07',
  body: `
The **Partner sign-offs & approvals** queue on the Partner and Managing Partner Home workspaces surfaces items that require partner authorisation, such as matter opening approvals on higher-risk instructions, write-off requests over a fee cap, and undertakings.

## 1. Who can approve or request discussion (\`signoff:approve\`)

Both \`approveSignOffAction\` (\`approveSignOff\`) and \`discussSignOffAction\` (\`discussSignOff\`) enforce the following rules on the server before changing a sign-off item:

1. **Permission (\`signoff:approve\`)**: The acting user must hold \`signoff:approve\`, which is granted by default to **Partner (\`partner\`)**, **Managing Partner (\`managing_partner\`)**, and **System Administrator (\`admin\`)**.
2. **Matter access (\`canAccessMatter\`)**: When a sign-off item is linked to a matter (\`matterId\`), the acting user must have access to that matter. If the matter is a restricted staff matter or has an ethical wall (\`hasEthicalWall: true\`), an unnamed partner without \`matter:restricted:access\` is denied.
3. **Assigned partner check (\`assignedPartnerId\`)**:
   - When \`assignedPartnerId\` is set on the sign-off item, **only that assigned partner** may approve or discuss it.
   - When \`assignedPartnerId\` is \`null\` (for example, an unassigned write-off request), any user holding \`signoff:approve\` who can access the matter may act on it.
4. **No self-approval (\`requestedById !== byId\`)**: The person who requested the sign-off (\`requestedById\`) is never permitted to approve or discuss their own request, even if they hold \`signoff:approve\`.
5. **Status check (\`Pending\` or \`Discussing\`)**: Only sign-off items in \`Pending\` or \`Discussing\` status can be approved or discussed. Attempting to re-approve or discuss an item that is already \`Approved\` is refused.

## 2. Discussing a sign-off request

When a partner selects **Discuss** on a pending sign-off item and submits a note:

- The sign-off item’s status moves to \`Discussing\` and stores the partner’s \`discussionNote\`.
- 1Squared writes a \`status-change\` audit entry (\`Partner sign-off\`) recording the transition and note.
- A high-priority follow-up task (*"Discuss partner sign-off: …"*) is created for the original requester (\`requestedById\`), linked to the matter.
`,
};
