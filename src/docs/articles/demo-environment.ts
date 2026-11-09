import type { DocArticle } from '../registry';

export const demoEnvironmentArticle: DocArticle = {
  slug: 'demo-environment',
  title: 'Demo environment',
  section: 'architecture-security',
  summary:
    'How the standalone Not A Law Firm LLP demo environment is configured, how persona switching and sample document seeding work, and how the demo dataset is seeded and reset.',
  updated: '2026-11-08',
  body: `
The **Demo environment** (\`environment: "demo"\`) provides a standalone, isolated deployment of **Not A Law Firm LLP** (\`tenantId: "not-a-law-firm"\`) for product walkthroughs and role demonstrations without putting any demo logic, fallback strings, or auto-seeding into live client deployments (ADR 0026).

## 1. Configuration-driven demo mode (never live)

In accordance with Platform Architecture Standard Rule 6, the exact same production build (\`NODE_ENV=production\`) runs in every environment. Demo features are governed exclusively by tenant configuration via \`isNonLiveDemoEnvironment()\`:

- **Allowed environments**: \`dev\`, \`test\`, \`training\`, and \`demo\` when \`featureFlags.enableDemoMode\` is \`true\`.
- **Never allowed in \`live\`**: The core configuration validator rejects \`featureFlags.enableDemoMode: true\` when \`environment === "live"\`, and \`isNonLiveDemoEnvironment()\` always returns \`false\` for \`live\` regardless of the build mode.
- **No auto-seeding in product code**: \`getStore()\` never back-fills missing collections from \`buildDemoData\` and never creates a demo store when no runtime store file exists. If no runtime store file exists, \`getStore()\` initialises a clean empty deployment store (\`createCleanDeploymentStore\`).

## 2. Persona switching

When \`isNonLiveDemoEnvironment()\` is \`true\` (as configured in \`client-not-a-law-firm/config/environments/demo.json\`):

- The account menu displays the **Demo persona switcher**, listing seeded demo employees (\`demo: true\`) across the eight built-in Home roles (Fee Earner, Partner, Legal Secretary, Enquiries Coordinator, Finance, Risk & Compliance, Managing Partner, and Admin).
- **Least-privilege switching guard**: A signed-in user may only switch to a demo persona whose effective permissions are a subset of the signed-in user’s own permissions, and who does not hold access to any restricted or staff matter (\`restrictedAccessUserIds\`) that the signed-in user cannot access.
- When \`featureFlags.enableDemoMode\` is \`false\` (or in \`live\`), the persona switcher is hidden and \`switchActiveUser\` returns \`ActionDenied\`.

## 3. Seeding and resetting the demo dataset

Demo data enters a non-live tenant store through two controlled paths only:

1. **CLI seed command (\`npm run seed:demo\`)**:
   - Reads the committed seed snapshot (\`data/seed-not-a-law-firm.json\`, generated from \`buildDemoData\` via \`--write-snapshot\`).
   - Requires \`PLATFORM_TENANT_PACKAGE_DIR\` and \`PLATFORM_ENVIRONMENT\`, and refuses to run when the environment is \`live\`.
   - Refuses to overwrite a non-empty store unless \`--force\` is passed.
   - Accepts \`--entra-map <path>\` (an uncommitted local JSON mapping of seed person IDs to demo Microsoft Entra ID user Object IDs) and sets \`entraObjectId\` **only** on the mapped personas so real Entra sign-ins land on the corresponding seeded roles.
   - Logs only record counts, \`tenantId\`, and \`environment\`—never personal or client names.
2. **In-app data reset (\`resetDemoDataAction\`)**:
   - Available under **Admin → Demo data** only when \`isDataResetAllowedEnvironment()\` is \`true\` (non-live environment with \`featureFlags.enableDemoMode: true\`).
   - Requires the \`admin:data_reset\` permission (\`admin\` role only) with verified multi-factor authentication (\`mfaVerified === true\`).
   - Restores the seeded dataset and writes a \`data-reset\` audit entry recording the acting administrator.
`.trim(),
};
