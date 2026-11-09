import type { DocArticle } from '../registry';

export const demoEnvironmentArticle: DocArticle = {
  slug: 'demo-environment',
  title: 'Demo environment',
  section: 'architecture-security',
  summary:
    'How the standalone Not A Law Firm LLP demo environment is configured, how persona switching and sample document seeding work, and how the demo dataset is seeded and reset.',
  updated: '2026-11-09',
  body: `
The **Demo environment** (\`environment: "demo"\`) provides a standalone, isolated deployment of **Not A Law Firm LLP** (\`tenantId: "not-a-law-firm"\`) for product walkthroughs and role demonstrations without putting any demo logic, fallback strings, or auto-seeding into live client deployments (ADR 0026).

## 1. Configuration-driven demo mode (never live)

In accordance with Platform Architecture Standard Rule 6, the exact same production build (\`NODE_ENV=production\`) runs in every environment. Demo features are governed exclusively by tenant configuration via \`isNonLiveDemoEnvironment()\`:

- **Allowed environments**: \`dev\`, \`test\`, \`training\`, and \`demo\` when \`featureFlags.enableDemoMode\` is \`true\` (enabled in \`client-not-a-law-firm/config/environments/demo.json\` and \`dev.json\`).
- **Never allowed in \`live\`**: The core configuration validator rejects \`featureFlags.enableDemoMode: true\` when \`environment === "live"\`, and \`isNonLiveDemoEnvironment()\` always returns \`false\` for \`live\` regardless of the build mode.
- **No auto-seeding or demo branding rewrite in product code**: \`getStore()\` never back-fills missing collections from \`buildDemoData\`, never overwrites \`store.firm\` or email domains (\`syncStoreFirmIdAndHomeRoles\` syncs only \`firmId\` and Home roles), and never creates a demo store when no runtime store file exists. If no runtime store file exists at \`data/runtime-store.json\` (or \`ONESQUARED_RUNTIME_STORE_PATH\`), \`getStore()\` initialises a clean empty deployment store (\`createCleanDeploymentStore\`), and if an existing store file is corrupted it refuses to load rather than overwriting it.

## 2. Persona switching

When \`isNonLiveDemoEnvironment()\` is \`true\` (as configured in \`client-not-a-law-firm/config/environments/demo.json\` and \`dev.json\`):

- The account menu displays the **Demo persona switcher**, listing seeded demo employees (\`demo: true\`) across the eight built-in Home roles (Fee Earner, Partner, Legal Secretary, Enquiries Coordinator, Finance, Risk & Compliance, Managing Partner, and Admin).
- **Least-privilege switching guard**: A signed-in user may only switch to a demo persona whose effective permissions are a subset of the signed-in user’s own permissions, and who does not hold access to any restricted or staff matter (\`restrictedAccessUserIds\`) that the signed-in user cannot access.
- When \`featureFlags.enableDemoMode\` is \`false\` (or in \`live\`), the persona switcher is hidden and \`switchActiveUser\` returns \`ActionDenied\`.

## 3. Seeding and resetting the demo dataset

Demo data enters a non-live tenant store through two controlled paths only:

1. **CLI seed command (\`npm run seed:demo\`)**:
   - Builds fresh relative dates anchored to the current UTC date via \`createSeedStore(new Date(), { includeSyntheticEntraOids: false })\` (while \`--write-snapshot\` regenerates the committed \`data/seed-not-a-law-firm.json\` snapshot used by deterministic unit and e2e tests).
   - Requires \`PLATFORM_TENANT_PACKAGE_DIR\` and \`PLATFORM_ENVIRONMENT\`, refuses to run when the environment is \`live\`, and refuses when \`tenantConfig.tenantId\` differs from the snapshot’s \`firmId\`.
   - Refuses to overwrite a non-empty or unparseable store file unless \`--force\` is passed.
   - Accepts \`--entra-map <path>\` (an uncommitted local JSON mapping of seed person IDs to demo Microsoft Entra ID user Object IDs, matching \`/data/entra-map*.json\` or \`*.entra-map.json\`) and sets \`entraObjectId\` **only** on the mapped personas so real Entra sign-ins land on the corresponding seeded roles.
   - Logs only record counts, \`tenantId\`, and \`environment\`—never personal or client names.
2. **In-app data reset (\`resetDemoDataAction\`)**:
   - Available under **Administration → Demo data** (\`/admin/demo-data\`, **Load demo dataset**) only when \`isDataResetAllowedEnvironment()\` is \`true\` (non-live environment with \`featureFlags.enableDemoMode: true\`).
   - Requires the \`admin:data_reset\` permission (\`admin\` role only) with verified multi-factor authentication (\`mfaVerified === true\`).
   - Calls \`resetAllDemoData\`, which restores the seeded dataset with fresh relative dates (\`includeSyntheticEntraOids: false\` outside \`PLATFORM_ENVIRONMENT === 'test'\`), preserves \`entraObjectId\` bindings only when the pre-reset store was itself a seeded store (\`!prevStore.isCleanDeployment\`) and both the person ID and primary email match the seeded persona (so \`--entra-map\` bindings survive a reset without binding a user provisioned after **Clear all data** to a seeded persona), and writes a \`data-reset\` audit entry recording the acting administrator.
`.trim(),
};
