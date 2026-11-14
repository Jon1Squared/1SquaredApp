import type { DocArticle } from '../registry';

export const demoEnvironmentArticle: DocArticle = {
  slug: 'demo-environment',
  title: 'Demo environment',
  section: 'architecture-security',
  summary:
    'How the standalone Not A Law Firm LLP demo environment is configured, how persona switching and sample document seeding work, and how the demo dataset is seeded and reset.',
  updated: '2026-11-13',
  body: `
The **Demo environment** (\`environment: "demo"\`) provides a standalone, isolated deployment of **Not A Law Firm LLP** (\`tenantId: "not-a-law-firm"\`) for product walkthroughs and role demonstrations without putting any demo logic, fallback strings, or auto-seeding into live client deployments (ADR 0026, ADR 0028).

## 1. Configuration-driven demo mode (never live)

In accordance with Platform Architecture Standard Rule 6, the exact same production build (\`NODE_ENV=production\`) runs in every environment. Demo features are governed exclusively by tenant configuration via \`isNonLiveDemoEnvironment()\`:

- **Allowed environments**: \`dev\`, \`test\`, \`training\`, and \`demo\` when \`featureFlags.enableDemoMode\` is \`true\` (enabled in \`client-not-a-law-firm/config/environments/demo.json\` and \`dev.json\`).
- **Never allowed in \`live\`**: The core configuration validator rejects \`featureFlags.enableDemoMode: true\` when \`environment === "live"\`, and \`isNonLiveDemoEnvironment()\` always returns \`false\` for \`live\` regardless of the build mode.
- **No runtime JSON store or auto-seeding in product code**: All runtime persistence runs exclusively against the tenant's PostgreSQL database (\`core/src/tenancy/\`, \`S0-20\`). The pure in-memory seed builders in \`src/seed/seedStoreBuilder.ts\` (\`createSeedStore\`, \`createCleanDeploymentStore\`, \`repairOrphanTaxonomyIds\`) are never imported by runtime application routes or UI components (enforced by ESLint \`no-restricted-imports\` in \`eslint.config.mjs\` and \`core/tests/no-runtime-json-store.test.ts\`). A fresh tenant database starts empty until an administrator or operator explicitly runs \`npm run seed:demo\` or **Administration → Demo data** (**Load demo dataset**).

## 2. Persona switching

When \`isNonLiveDemoEnvironment()\` is \`true\` (as configured in \`client-not-a-law-firm/config/environments/demo.json\` and \`dev.json\`):

- The account menu displays the **Demo persona switcher**, listing seeded demo employees (\`demo: true\`) across the eight built-in Home roles (Fee Earner, Partner, Legal Secretary, Enquiries Coordinator, Finance, Risk & Compliance, Managing Partner, and Admin).
- **Least-privilege switching guard**: A signed-in user may only switch to a demo persona whose effective permissions are a subset of the signed-in user’s own permissions, and who does not hold access to any restricted or staff matter (\`restrictedAccessUserIds\`) that the signed-in user cannot access.
- When \`featureFlags.enableDemoMode\` is \`false\` (or in \`live\`), the persona switcher is hidden and \`switchActiveUser\` returns \`ActionDenied\`.

## 3. Seeding and resetting the demo dataset

Demo data enters a non-live tenant PostgreSQL database through two controlled paths only:

1. **CLI seed command (\`npm run seed:demo\`)**:
   - Builds fresh relative dates anchored to the current UTC date via \`createSeedStore(new Date(), { includeSyntheticEntraOids: false })\` in \`src/seed/seedStoreBuilder.ts\` (while \`--write-snapshot\` regenerates the committed \`data/seed-not-a-law-firm.json\` snapshot used by deterministic unit and e2e tests).
   - Requires \`PLATFORM_TENANT_PACKAGE_DIR\` and \`PLATFORM_ENVIRONMENT\`, refuses to run when the environment is \`live\`, and refuses when \`tenantConfig.tenantId\` differs from the snapshot’s \`firmId\`.
   - Checks \`TenantPartyRepository.listAllPeople(ctx)\` and refuses to overwrite a non-empty tenant database unless \`--force\` is passed.
   - Accepts \`--entra-map <path>\` (an uncommitted local JSON mapping of seed person IDs to demo Microsoft Entra ID user Object IDs, matching \`/data/entra-map*.json\` or \`*.entra-map.json\`) and sets \`entraObjectId\` **only** on the mapped personas so real Entra sign-ins land on the corresponding seeded roles. Privileged personas (any employee whose resolved roles or permissions include a critical or MFA-gated permission, such as Admin, Managing Partner, Partner, or Risk & Compliance) **never link automatically by email** (\`S0-30\`), so they must be bound via \`--entra-map\` or explicitly by an administrator in **Admin → Users** (**Admin → RBAC & Entra ID**).
   - Imports all modules (\`parties\`, \`matters\`, \`intake\`, \`quotes\`, \`tasks\`, \`hr\`, \`catalogues\`, \`pms\`, \`documents\`, \`document-store\`, \`key-dates\`, and \`audit\`) into the tenant's PostgreSQL database via \`importFirmStoreModulesToPostgres\` (\`src/server/storePostgresImport.ts\`).
   - Logs only record counts, \`tenantId\`, and \`environment\`—never personal, client, or email details—and prints a structured warning when run without \`--entra-map\` (or whenever privileged personas remain unbound) stating how many privileged personas remain unbound without naming any email addresses.
2. **In-app data reset (\`resetDemoDataAction\`)**:
   - Available under **Administration → Demo data** (\`/admin/demo-data\`, **Load demo dataset**) only when \`isDataResetAllowedEnvironment()\` is \`true\` (non-live environment with \`featureFlags.enableDemoMode: true\`).
   - Requires the \`admin:data_reset\` permission (\`admin\` role only) with verified multi-factor authentication (\`mfaVerified === true\`).
   - Calls \`resetAllDemoData\`, which builds the seeded dataset in memory with fresh relative dates (\`includeSyntheticEntraOids: false\` outside \`PLATFORM_ENVIRONMENT === 'test'\`), preserves \`entraObjectId\` bindings only when the pre-reset database was itself a seeded deployment (\`!prevFirmProfile?.isCleanDeployment\`) and both the person ID and primary email match the seeded persona (so \`--entra-map\` bindings survive a reset without binding a user provisioned after **Clear all data** to a seeded persona), clears and re-imports all per-tenant PostgreSQL modules under the signed-in administrator's own verified tenant context, and writes a \`data-reset\` audit entry in \`public.audit_entries\`. Because the audit log is reloaded from the demo data, audit reference numbers (\`AU-…\`) restart from the demo sequence after every reset.
`.trim(),
};
