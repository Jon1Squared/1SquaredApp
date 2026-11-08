import type { DocArticle } from '../registry';

export const tenantSettingsArticle: DocArticle = {
  slug: 'tenant-settings',
  title: 'Tenant settings',
  section: 'architecture-security',
  summary:
    'Per-tenant configuration settings in base.json and environment overlays, their defaults, runtime enforcement, and reserved status.',
  updated: '2026-11-07',
  body: `
Every tenant deployment is configured through \`config/base.json\` and optional per-environment overlays (\`config/environments/dev.json\`, \`test.json\`, \`training.json\`, \`live.json\`). Settings are validated at startup against \`core/schemas/tenant-config.schema.json\` and the core Zod configuration engine.

## Active and reserved settings

Every leaf property in the tenant configuration schema is either actively read at runtime or explicitly marked with \`x-reserved\` metadata naming the roadmap slice that will activate it. When a tenant configuration includes any reserved keys, the platform logs a single structured \`info\` event (\`tenant_config.reserved_settings\`) with the tenant ID and correlation ID at startup.

### Identity, hosting and branding

| Setting | Default | Status | Notes |
|---|---|---|---|
| \`schemaVersion\` | \`"1.0.0"\` | Active | Semantic version of the tenant configuration schema |
| \`tenantId\` | Required | Active | Immutable tenant slug validated against authenticated token claims |
| \`displayName\` | Required | Active | Tenant display name shown across the workspace and generated documents |
| \`hostingMode\` | \`"multi_tenant"\` | Active | \`single_tenant\` (Model A) or \`multi_tenant\` (Model B) |
| \`environment\` | \`"dev"\` | Active | \`dev\`, \`test\`, \`training\`, or \`live\` |
| \`branding.primaryDomain\` | Required | Active | Verified primary email/UPN domain for the tenant |
| \`branding.accentColorHex\` | \`"#1f6feb"\` | Reserved (S0-11b) | Reserved for tenant branding theme rendering |
| \`branding.logoAssetKey\` | \`"default-logo.svg"\` | Reserved (S0-11b) | Reserved for tenant firm logo rendering |
| \`firm.contactEmail\` | \`""\` | Active | Public firm contact email for document headers and footers |
| \`firm.website\` | \`""\` | Active | Public firm website URL or hostname for document headers and footers |
| \`conflictReview.assigneeTeamKey\` | \`null\` | Active | Team ID or code receiving referred conflict review tasks |
| \`conflictReview.assigneeRoleKey\` | \`null\` | Active | Role key used to select an assignee within the conflict review team |

### Feature flags

| Setting | Default | Status | Notes |
|---|---|---|---|
| \`featureFlags.enableMatterCostsGovernance\` | \`true\` | Active | Gates the Rates & matter costs administration tab, partner cost sign-off UI, \`saveMatterCostsConfigAction\` (\`admin:access\`), \`signOffMatterCostsAction\` (\`matter:costs:sign_off\`), and matter costs opening governance hooks. **Warning:** setting \`enableMatterCostsGovernance\` to \`false\` also skips the \`beforeMatterOpen\` partner cost sign-off check when opening a matter |
| \`featureFlags.enablePmsLiveRateSync\` | \`true\` | Active | Gates the Pull / Sync Rates from PMS action (\`syncMatterCostsRatesFromPmsAction\`, requiring \`admin:access\`) and button |
| \`featureFlags.enableAiMatterExtraction\` | \`false\` | Active | Gates \`/api/matters/extract\` (\`matter:create\`) and the AI matter extraction panel (together with \`integrations.aiProviderChoice === "anthropic"\`) |
| \`featureFlags.enableDemoMode\` | \`false\` | Active | Enables persona switching in non-live environments; always forced off in \`live\` |

### Matter costs configuration (tenant level)

Runtime rate cards and partner sign-off thresholds are currently stored in the firm store and managed through Administration when \`featureFlags.enableMatterCostsGovernance\` is enabled. The declarative \`matterCosts.*\` block in \`base.json\` is reserved for S0-23, which unifies the tenant configuration and runtime store:

| Setting | Default | Status | Notes |
|---|---|---|---|
| \`matterCosts.rateSourceMode\` | \`"pms_when_linked"\` | Reserved (S0-23) | Unifying tenant-level and runtime-store matter costs configuration |
| \`matterCosts.allowMatterRateOverrides\` | \`true\` | Reserved (S0-23) | Unifying tenant-level and runtime-store matter costs configuration |
| \`matterCosts.partnerSignOffThresholdGbp\` | \`25000\` | Reserved (S0-23) | Unifying tenant-level and runtime-store matter costs configuration |
| \`matterCosts.rateCards\` | \`[]\` | Reserved (S0-23) | Unifying tenant-level and runtime-store matter costs configuration |
| \`matterCosts.disbursementPresets\` | \`[]\` | Reserved (S0-23) | Unifying tenant-level and runtime-store matter costs configuration |

### Integrations and PMS synchronisation

| Setting | Default | Status | Notes |
|---|---|---|---|
| \`integrations.aiProviderChoice\` | \`"disabled"\` | Active | \`"anthropic"\`, \`"azure_openai_uk"\`, or \`"disabled"\` (ADR-0031) |
| \`integrations.pmsConnectionSecretVaultRef\` | Required | Reserved (S0-18) | Key Vault reference for live tenant-scoped PMS database connection secret resolution |
| \`integrations.companiesHouseApiKeyVaultRef\` | Required | Reserved (S0-18) | Key Vault reference for live Companies House API integration |
| \`integrations.pmsSync.enabled\` | \`true\` | Reserved (S0-18) | Live tenant-scoped PMS synchronisation |
| \`integrations.pmsSync.providerKey\` | \`"generic_sql"\` | Reserved (S0-18) | Live tenant-scoped PMS adapter selection |
| \`integrations.pmsSync.syncMode\` | \`"two_way"\` | Reserved (S0-18) | Live tenant-scoped PMS sync direction control |
| \`integrations.pmsSync.matterCodeAllocation\` | \`"onesquared"\` | Reserved (S0-18) | Live tenant-scoped PMS matter number allocation |
| \`integrations.pmsSync.clientCodeAllocation\` | \`"onesquared"\` | Reserved (S0-18) | Live tenant-scoped PMS client code allocation |
| \`integrations.pmsSync.pollIntervalMinutes\` | \`15\` | Reserved (S0-18) | Live tenant-scoped PMS delta polling interval |
| \`integrations.pmsSync.fieldMappings\` | \`[]\` | Reserved (S0-18) | Live tenant-scoped PMS field-level synchronisation |

### Custom fields, extensions, RBAC, documents and key dates

| Setting | Default | Status | Notes |
|---|---|---|---|
| \`customFields\` | \`[]\` | Reserved (S0-17) | Reserved for moving custom field definitions off the transitional JSON store in S0-17 (runtime custom fields are currently managed in the firm store) |
| \`enabledExtensions\` | \`[]\` | Active | Registered extension IDs active for the tenant |
| \`documentGeneration.*\` | Enabled | Active | Document template limits, output format, approval rules (\`requireApproval\` controls whether \`submitTemplateVersionForApproval\` requires a separate approval step or activates clean templates directly; \`allowSelfApproval\` controls whether a builder may approve their own submitted version), and usage reporting |
| \`rbac.*\` | Built-in roles | Active | Role definitions, department grants, relationship grants, and Entra ID identity mapping |
| \`documentStores\` | Optional | Active | External SharePoint Online document stores |
| \`documentRouting\` | Optional | Active | Ordered rules mapping matters to a document store, library, and base path |
| \`matterFolderNameTemplate\` | \`"{matterNumber} - {matterDescription}"\` | Active | Template for naming each matter root folder |
| \`documentAccess.departmentEntraGroups\` | \`{}\` | Active | Department to Entra security group mappings |
| \`documentAccess.teamEntraGroups\` | \`{}\` | Active | Team to Entra security group mappings |
| \`documentAccess.uniqueScopeWarningThreshold\` | \`4000\` | Active | Warning threshold for unique SharePoint permission scopes per library |
| \`documentAccess.autoRemediateDrift\` | \`false\` | Reserved (S0-25) | Reserved for scheduled automatic SharePoint permission drift remediation |
| \`documentAccess.defaultPolicy\` / \`policiesByStore\` | Built-in policy | Active | Inheritance-based document access policies |
| \`matterFolderTemplates.*\` | Required \`default\` | Active | Versioned matter folder templates with work-type and department inheritance |
| \`keyDates.*\` | Enabled | Active | Key dates, limitation rule sets, verification rules, reminder schedules, and calendar sync |
`.trim(),
};
