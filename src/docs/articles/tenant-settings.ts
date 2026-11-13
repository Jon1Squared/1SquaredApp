import type { DocArticle } from '../registry';

export const tenantSettingsArticle: DocArticle = {
  slug: 'tenant-settings',
  title: 'Tenant settings',
  section: 'architecture-security',
  summary:
    'Per-tenant configuration settings in base.json and environment overlays, their defaults, runtime enforcement, and reserved status.',
  updated: '2026-11-09',
  body: `
Every tenant deployment is configured through \`config/base.json\` and optional per-environment overlays (\`config/environments/dev.json\`, \`test.json\`, \`training.json\`, \`demo.json\`, \`live.json\`). Settings are validated at startup against \`core/schemas/tenant-config.schema.json\` and the core Zod configuration engine.

## Active and reserved settings

Every leaf property in the tenant configuration schema is either actively read at runtime or explicitly marked with \`x-reserved\` metadata naming the roadmap slice that will activate it. When a tenant configuration includes any reserved keys, the platform logs a single structured \`info\` event (\`tenant_config.reserved_settings\`) with the tenant ID and correlation ID at startup.

### Identity, hosting and branding

| Setting | Default | Status | Notes |
|---|---|---|---|
| \`schemaVersion\` | \`"1.0.0"\` | Active | Semantic version of the tenant configuration schema |
| \`tenantId\` | Required | Active | Immutable tenant slug validated against authenticated token claims |
| \`displayName\` | Required | Active | Tenant display name shown across the workspace and generated documents |
| \`hostingMode\` | \`"multi_tenant"\` | Active | \`single_tenant\` (Model A) or \`multi_tenant\` (Model B) |
| \`environment\` | \`"dev"\` | Active | \`dev\`, \`test\`, \`training\`, \`demo\`, or \`live\` |
| \`branding.primaryDomain\` | Required | Active | Verified primary email/UPN domain for the tenant |
| \`branding.accentColorHex\` | \`"#1f6feb"\` | Reserved (backlog, F21) | Reserved for tenant branding theme rendering; the demo tenant uses the standard platform theme |
| \`branding.logoAssetKey\` | \`"default-logo.svg"\` | Reserved (backlog, F21) | Reserved for tenant firm logo rendering; the demo tenant uses the standard platform logo |
| \`firm.contactEmail\` | \`""\` | Active | Public firm contact email for document headers and footers |
| \`firm.website\` | \`""\` | Active | Public firm website URL or hostname for document headers and footers |
| \`conflictReview.assigneeTeamKey\` | \`null\` | Active | Team ID or code receiving referred conflict review tasks |
| \`conflictReview.assigneeRoleKey\` | \`null\` | Active | Role key used to select an assignee within the conflict review team |

### Feature flags

| Setting | Default | Status | Notes |
|---|---|---|---|
| \`featureFlags.enableMatterCostsGovernance\` | \`true\` | Active | Gates the Rates & matter costs administration tab, partner cost sign-off UI, \`saveMatterCostsConfigAction\` (\`admin:access\`), \`signOffMatterCostsAction\` (\`matter:costs:sign_off\`), and matter costs opening governance hooks. \`AdminClient\` defaults its \`enableMatterCostsGovernance\` prop to \`false\` when omitted so UI controls fail closed unless explicitly enabled by the server snapshot. **Warning:** setting \`enableMatterCostsGovernance\` to \`false\` also skips the \`beforeMatterOpen\` partner cost sign-off check when opening a matter |
| \`featureFlags.enablePmsLiveRateSync\` | \`true\` | Active | Gates the Pull / Sync Rates from PMS action (\`syncMatterCostsRatesFromPmsAction\`, requiring \`admin:access\`) and button. \`AdminClient\` defaults its \`enablePmsLiveRateSync\` prop to \`false\` when omitted |
| \`featureFlags.enableAiMatterExtraction\` | \`false\` | Active | Gates \`/api/matters/extract\` (\`matter:create\`) and the AI matter extraction panel (together with \`integrations.aiProviderChoice === "anthropic"\`) |
| \`featureFlags.enableDemoMode\` | \`false\` | Active | Enables demo mode, persona switching, sample document seeding, and data reset in non-live environments (\`dev\`, \`test\`, \`training\`, \`demo\`) regardless of \`NODE_ENV\`; rejected in \`live\` (see [Demo environment](/docs/demo-environment)) |

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
| \`documentGeneration.*\` | Enabled | Active | Document template limits, output format, approval rules (\`requireApproval\` controls whether \`submitTemplateVersionForApproval\` requires a separate approval step or activates clean template versions directly on submit without a separate approver check, recording \`Document Template Activated (approval not required)\` in the audit trail; \`allowSelfApproval\` controls whether a builder may approve their own submitted version), and usage reporting |
| \`documentGeneration.usage.retentionMonths\` | \`24\` | Reserved (S0-19) | Reserved for automated document usage event retention pruning |
| \`documentGeneration.customDocumentTypes\` | \`[]\` | Reserved (backlog, F20) | Reserved for tenant-configured custom document classification types in document generation |
| \`rbac.*\` | Built-in roles | Active | Role definitions, department grants, relationship grants, and Entra ID identity mapping (\`authorityMode\`, \`entraGroupToRoleKey\`, \`entraAppRoleToRoleKey\`, \`defaultRoleKeys\`, \`allowAcrsC1AsMfa\`, and \`emailLinking\`) |
| \`rbac.identityMapping.emailLinking.enabled\` | \`true\` | Active | Controls whether first-time Entra sign-in can link an unbound non-privileged employee record by verified domain email; when \`false\`, only explicit \`entraObjectId\` (\`oid\`) bindings are used |
| \`rbac.identityMapping.emailLinking.domains\` | \`[]\` | Active | Lower-case domain names permitted for first-time email linking on sign-in; an empty array (\`[]\`) means the tenant's \`branding.primaryDomain\` only |
| \`documentStores\` | Optional | Active | External SharePoint Online document stores |
| \`documentRouting\` | Optional | Active | Ordered rules mapping matters to a document store, library, and base path |
| \`matterFolderNameTemplate\` | \`"{matterNumber} - {matterDescription}"\` | Active | Template for naming each matter root folder |
| \`documentAccess.departmentEntraGroups\` | \`{}\` | Active | Department to Entra security group mappings |
| \`documentAccess.teamEntraGroups\` | \`{}\` | Active | Team to Entra security group mappings |
| \`documentAccess.uniqueScopeWarningThreshold\` | \`4000\` | Active | Warning threshold for unique SharePoint permission scopes per library |
| \`documentAccess.autoRemediateDrift\` | \`false\` | Reserved (S0-25) | Reserved for scheduled automatic SharePoint permission drift remediation |
| \`documentAccess.defaultPolicy\` / \`policiesByStore\` | Built-in policy | Active | Inheritance-based document access policies |
| \`matterFolderTemplates.*\` | Required \`default\` | Active | Versioned matter folder templates with work-type and department inheritance |
| \`keyDates.*\` | Enabled | Active | Key dates, limitation rule sets (marking a rule set \`reviewed\` records the saving actor's person ID in \`reviewedBy\` and today's ISO date in \`reviewedOn\` on the server, rejects invalid \`reviewStatus\` values, and clears \`reviewedBy\` / \`reviewedOn\` when unmarked), key date types (\`allowManualEntry: false\` disables the Manual Date Entry button, switches to the limitation calculator when \`allowCalculation\` is enabled or displays a notice when neither is enabled, and returns \`ActionDenied\` (\`FORBIDDEN\`) on manual creation, manual supersede, or spoofed system sources), verification rules, reminder schedules, and calendar sync |
| \`keyDates.defaults.teamAssignment\` | \`"matter_owning_team"\` | Reserved (backlog, F19) | Reserved for additional key dates team diary assignment modes beyond \`matter_owning_team\` |
| \`keyDates.matterTypes[].defaultRuleSetIds\` | \`[]\` | Reserved (backlog, F19) | Reserved for default limitation rule set filtering by matter type |
| \`keyDates.limitationRuleSets[].rules[].claimType\` | Optional | Reserved (backlog, F19) | Reserved for claim-type classification and filtering on limitation rules |
| \`keyDates.calendarSync.provider\` | \`"microsoft_graph"\` | Reserved (backlog, F19) | Reserved for multi-provider external calendar adapter selection |
| \`keyVault.vaultName\` | Optional | Active | Deployed per-tenant Azure Key Vault name (3–24 characters, populated from \`keyVaultName\` output of \`core/infra/modules/tenant.bicep\`); enforced by \`assertTenantOwnsKeyVaultSecretRef\` against every \`kv://\` secret reference |
| \`keyVault.vaultUri\` | Optional | Active | Deployed per-tenant Azure Key Vault URI (\`https://<vault>.vault.azure.net/\`, populated from \`keyVaultUri\` output of \`core/infra/modules/tenant.bicep\`); validated alongside \`keyVault.vaultName\` |
| \`database.dedicatedServerHost\` | Optional | Active | Hostname of a dedicated Azure Database for PostgreSQL Flexible Server (\`psql-<slug>-<env>.postgres.database.azure.com\`) for Model B hosted tenants requiring their own server or a Customer-Managed Key (ADR 0028 Decision 1) |
`.trim(),
};
