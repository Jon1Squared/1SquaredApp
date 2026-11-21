import type { DocArticle } from '../registry';

export const tenantSettingsArticle: DocArticle = {
  slug: 'tenant-settings',
  title: 'Tenant settings',
  section: 'architecture-security',
  summary:
    'Per-tenant configuration settings in base.json and environment overlays, their defaults, runtime enforcement, and reserved status.',
  updated: '2026-11-21',
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
| \`timeZone\` | \`"Europe/London"\` | Active | IANA time zone identifier validated via \`Intl.DateTimeFormat\` (ADR 0030); governs the \`02:00\` local-time window and local calendar date in the job run ledger for daily scheduled jobs across GMT/BST transitions |
| \`branding.primaryDomain\` | Required | Active | Verified primary email/UPN domain for the tenant |
| \`branding.accentColorHex\` | \`"#1f6feb"\` | Reserved (backlog, F21) | Reserved for tenant branding theme rendering; the demo tenant uses the standard platform theme |
| \`branding.logoAssetKey\` | \`"default-logo.svg"\` | Reserved (backlog, F21) | Reserved for tenant firm logo rendering; the demo tenant uses the standard platform logo |
| \`firm.contactEmail\` | \`""\` | Active | Public firm contact email for document headers and footers |
| \`firm.website\` | \`""\` | Active | Public firm website URL or hostname for document headers and footers |
| \`conflictReview.assigneeTeamKey\` | \`null\` | Active | Team ID or code receiving referred conflict review tasks |
| \`conflictReview.assigneeRoleKey\` | \`null\` | Active | Role key used to select an assignee within the conflict review team |
| \`enquiries.fallbackTeamId\` | \`null\` | Active | Optional active Team ID used as the default fallback intake team when no practice area matches (an explicit non-empty setting under **Admin → Enquiry settings** overrides this; when unset in Admin it falls back to \`enquiries.fallbackTeamId\`, then to an active team with \`systemKey: "intake"\`, or saves unmapped enquiries unassigned with a warning stating that no active fallback intake team is configured; repeated admin warnings for unrouted enquiries are deduplicated per tenant per calendar day) |

#### Upgrade step: fallback intake team routing

Before or straight after upgrading from \`develop\`, firms must ensure an explicit intake fallback is configured: set the intake team's \`systemKey\` to \`"intake"\` under **Admin → Teams**, or set \`enquiries.fallbackTeamId\` in tenant configuration (or **Admin → Enquiry settings**). Previously, fallback routing matched a team named \`"Intake"\`; without an active \`intake\` \`systemKey\` or \`fallbackTeamId\`, unmapped enquiries save unassigned with a \`"no active fallback intake team"\` warning and a once-daily per-tenant admin warning notification. For the demo tenant, running **Load demo dataset** in **Admin → Demo data** (or the \`seed-demo\` job) sets the intake team metadata automatically.

### Feature flags

| Setting | Default | Status | Notes |
|---|---|---|---|
| \`featureFlags.enableMatterCostsGovernance\` | \`true\` | Active | Gates the Rates & matter costs administration tab, partner cost sign-off UI, \`saveMatterCostsConfigAction\` (\`admin:access\`), \`signOffMatterCostsAction\` (\`matter:costs:sign_off\`), and matter costs opening governance hooks. \`AdminClient\` defaults its \`enableMatterCostsGovernance\` prop to \`false\` when omitted so UI controls fail closed unless explicitly enabled by the server snapshot. **Warning:** setting \`enableMatterCostsGovernance\` to \`false\` also skips the \`beforeMatterOpen\` partner cost sign-off check when opening a matter |
| \`featureFlags.enablePmsLiveRateSync\` | \`true\` | Active | Gates the Pull / Sync Rates from PMS action (\`syncMatterCostsRatesFromPmsAction\`, requiring \`admin:access\`) and button. \`AdminClient\` defaults its \`enablePmsLiveRateSync\` prop to \`false\` when omitted |
| \`featureFlags.enableAiMatterExtraction\` | \`false\` | Active | Gates \`/api/matters/extract\` (\`matter:create\`) and the AI matter extraction panel (together with \`integrations.aiProviderChoice === "anthropic"\`) |
| \`featureFlags.enableDemoMode\` | \`false\` | Active | Enables demo mode, persona switching, sample document seeding, and data reset in non-live environments (\`dev\`, \`test\`, \`training\`, \`demo\`) regardless of \`NODE_ENV\`; rejected in \`live\` (see [Demo environment](/docs/demo-environment)) |

### Matter costs configuration (tenant level)

The \`matterCosts.*\` settings in \`base.json\` and environment overlays supply schema-validated tenant defaults (\`resolveEffectiveMatterCostsConfig\` in \`src/domain/matterCosts.ts\`), merged with per-tenant overrides stored in the tenant’s module configuration store (\`'matter_costs'\`, managed via **Administration -> Rates & matter costs** and \`saveMatterCostsConfigAction\` when \`featureFlags.enableMatterCostsGovernance\` is enabled):

| Setting | Default | Status | Notes |
|---|---|---|---|
| \`matterCosts.rateSourceMode\` | \`"pms_when_linked"\` | Active | Controls hourly rate card lookup order (\`app_table\`, \`pms_when_linked\`, or \`pms_only\`) |
| \`matterCosts.allowMatterRateOverrides\` | \`true\` | Active | Controls whether fee earners may customise Partner, Associate, Trainee, or custom grade rates on a matter (or add Tier 1 matter rate overrides, \`S0-28a\`); enforced server-side in \`saveMatterRecord\` and \`saveMatterRateOverrideRecord\`. Tier 2 negotiated client rates and Tier 3 parent-group rates remain active read-only baselines even when matter overrides are disabled |
| \`matterCosts.partnerSignOffThresholdGbp\` | \`25000\` | Active | Default fee estimate / agreed cap threshold in GBP passed to \`beforeMatterCostsCalculate\` and \`beforeMatterOpen\` governance hooks |
| \`matterCosts.vatRatePercent\` | \`20\` | Active | Standard UK VAT percentage (\`0\`–\`100\`, additive default \`20\`) captured into new quotes and matter cost snapshots and calculated in exact integer pence via \`@platform/core-api\` |
| \`matterCosts.rateCards\` | \`[]\` | Active | Tenant-default hourly rate cards by practice area mapped into runtime \`MatterCostsConfig\` when no module override exists |
| \`matterCosts.disbursementPresets\` | \`[]\` | Active | Tenant-default disbursement presets merged when no module override exists |
| \`matterCosts.feeArrangementCaps\` | Statutory defaults (\`100%\`, \`25%\`, \`50%\`, \`35%\`, \`25%\`) | Active | Firm-level CFA and DBA cap percentages paired with locked statutory calculation bases (\`capBaseKey\`); editable in **Administration -> Rates & matter costs** (\`0\` up to statutory maximum; rejected with \`FEE_CAP_CONFIG_EXCEEDS_STATUTORY\` if above statutory limits) |

### Integrations and PMS synchronisation

Per-tenant Practice Management System (PMS) extract datasets and PMS links are stored in each tenant's isolated database via \`TenantPmsRepository\` (\`S0-18\`, \`0013_pms_per_tenant_expand\`). \`loadAndValidateTenantConfig\` deep-merges \`base.integrations.pmsSync\` and \`overlay.integrations.pmsSync\` so environment overlays can override individual \`pmsSync\` fields without wiping \`base.json\` defaults (\`R411\`). Live external PMS adapter synchronisation and live Companies House API integration (\`F17\`) remain reserved for the post-Stage-0 backlog (Owner Decision 3):

| Setting | Default | Status | Notes |
|---|---|---|---|
| \`integrations.aiProviderChoice\` | \`"disabled"\` | Active | \`"anthropic"\`, \`"azure_openai_uk"\`, or \`"disabled"\` (ADR-0031) |
| \`integrations.email.provider\` | \`"disabled"\` | Active | Outbound transactional email provider: \`"disabled"\` (default safe no-op), \`"dev_catcher"\` (non-live SMTP catcher), \`"graph"\` (Microsoft Graph app-only certificate), or \`"acs"\` (fail-closed placeholder returning \`EMAIL_PROVIDER_NOT_IMPLEMENTED\` until Stage 1) |
| \`integrations.email.senderAddress\` | Optional | Active | Shared mailbox From address (and target Graph \`/users/{mailbox}/sendMail\` mailbox) |
| \`integrations.email.replyTo\` | Optional | Active | Optional Reply-To mailbox address set on outbound messages |
| \`integrations.email.outboxContentRetentionDays\` | \`30\` | Active | Days after terminal send/drop/failure before outbox message subjects, bodies, attachments, and recipient addresses are scrubbed |
| \`integrations.email.recipientAllowList\` | \`[]\` | Active | Non-live recipient domain suffixes and permitted synthetic addresses; empty allow-list fails closed outside \`live\` |
| \`integrations.email.recipientAllowListVaultRef\` | Optional | Active | Tenant Key Vault secret ref (\`kv://...\`) storing non-live permitted tester emails without committing PII to git |
| \`integrations.email.graph.*\` | Optional | Active | Microsoft Graph certificate settings (\`tenantId\`, \`clientId\`, \`certificateVaultRef\`, 40-hex SHA-1 \`certificateThumbprint\`) |
| \`integrations.email.acs.connectionVaultRef\` | Optional | Active | Tenant Key Vault secret ref reserved for the Stage 1 Azure Communication Services adapter |
| \`integrations.email.devCatcher.*\` | Optional | Active | Local SMTP catcher settings (\`host\`, \`port\`, \`secure\`) for \`dev\` and \`test\` environments (forbidden in \`live\`) |
| \`integrations.teams.provider\` | \`"disabled"\` | Active | Microsoft Teams Activity Feed delivery provider: \`"disabled"\` (default safe no-op), \`"dev_catcher"\` (non-live HTTP catcher, forbidden in \`live\`), or \`"graph"\` (Microsoft Graph app-only \`TeamsActivity.Send\`) |
| \`integrations.teams.teamsAppId\` | Optional | Active | Entra / Teams manifest application ID used for Teams entity deep-link \`webUrl\` generation |
| \`integrations.teams.recipientAllowList\` | \`[]\` | Active | Non-live recipient domain suffixes (e.g. \`@notalawfirm.example\`) and permitted person IDs (\`P-xxxxxx\`); empty allow-list fails closed outside \`live\` |
| \`integrations.teams.recipientAllowListVaultRef\` | Optional | Active | Tenant Key Vault secret ref (\`kv://...\`) storing non-live permitted Teams recipients without committing PII to git |
| \`integrations.teams.devCatcher.endpointUrl\` | Optional | Active | HTTP endpoint URL for local Teams Activity catcher testing in \`dev\` and \`test\` (forbidden in \`live\`) |
| \`integrations.teams.graph.*\` | Optional | Active | Microsoft Graph application-only certificate settings (\`tenantId\`, \`clientId\`, \`certificateVaultRef\`, optional 40-hex \`certificateThumbprint\` required when \`provider === "graph"\`) |
| \`notifications.digestHourLocal\` | \`8\` | Active | Tenant-local hour (\`0\`–\`23\`, default \`8\`) at or after which the Monday–Friday \`notification-digests\` scheduler job queues daily and weekly email digests across GMT/BST transitions |
| \`integrations.pmsConnectionSecretVaultRef\` | Required | Reserved (backlog, F22) | Key Vault reference reserved for post-Stage-0 live tenant-scoped PMS database connection secret resolution (\`F22\`) |
| \`integrations.companiesHouseApiKeyVaultRef\` | Required | Reserved (backlog, F17) | Key Vault reference reserved for post-Stage-0 live Companies House API integration (\`F17\`) |
| \`integrations.pmsSync.enabled\` | \`true\` | Reserved (backlog, F22) | Post-Stage-0 live tenant-scoped PMS synchronisation (\`F22\`) |
| \`integrations.pmsSync.providerKey\` | \`"generic_sql"\` | Reserved (backlog, F22) | Post-Stage-0 live tenant-scoped PMS adapter selection (\`F22\`) |
| \`integrations.pmsSync.syncMode\` | \`"two_way"\` | Reserved (backlog, F22) | Post-Stage-0 live tenant-scoped PMS sync direction control (\`F22\`) |
| \`integrations.pmsSync.matterCodeAllocation\` | \`"onesquared"\` | Reserved (backlog, F22) | Post-Stage-0 live tenant-scoped PMS matter number allocation (\`F22\`) |
| \`integrations.pmsSync.clientCodeAllocation\` | \`"onesquared"\` | Reserved (backlog, F22) | Post-Stage-0 live tenant-scoped PMS client code allocation (\`F22\`) |
| \`integrations.pmsSync.pollIntervalMinutes\` | \`15\` | Reserved (backlog, F22) | Post-Stage-0 live tenant-scoped PMS delta polling interval (\`F22\`) |
| \`integrations.pmsSync.fieldMappings\` | \`[]\` | Reserved (backlog, F22) | Post-Stage-0 live tenant-scoped PMS field-level synchronisation (\`F22\`) |
| \`integrations.pmsSync.gradeRoleMap\` | \`{}\` | Active | Maps external PMS fee-earner grade strings (case-insensitive) to canonical \`employee_role.*\` IDs in \`createRecordFromPms\`; unmapped grades fall back to least-privileged \`employee_role.support_staff\` |

### Custom fields, extensions, RBAC, documents and key dates

| Setting | Default | Status | Notes |
|---|---|---|---|
| \`customFields\` | \`[]\` | Active | Declarative custom field definitions in \`base.json\` merged at runtime with administrator-managed custom fields via \`TenantCatalogueRepository\` (\`S0-17c\`); administrator definitions with the same \`id\` take precedence over declarative entries |
| \`enabledExtensions\` | \`[]\` | Active | Registered extension IDs active for the tenant |
| \`documentGeneration.*\` | Enabled | Active | Document template limits, output format, approval rules (\`requireApproval\` controls whether \`submitTemplateVersionForApproval\` requires a separate approval step or activates clean template versions directly on submit without a separate approver check, recording \`Document Template Activated (approval not required)\` in the audit trail; \`allowSelfApproval\` controls whether a builder may approve their own submitted version), deprecated \`permissions.roleDefaults\` derived across all 16 \`DocumentPermission\` keys (\`ALL_DOCUMENT_PERMISSION_KEYS\`), and usage reporting |
| \`documentGeneration.usage.retentionMonths\` | \`24\` | Active | Retention window (in months) for document generation usage events; expired events are purged daily at or after \`02:00\` in the tenant's \`timeZone\` by the \`usage-retention-purge\` scheduled job (\`executeUsageRetentionPurgeForTenant\`, \`S0-19\`) |
| \`documentGeneration.customDocumentTypes\` | \`[]\` | Reserved (backlog, F20) | Reserved for tenant-configured custom document classification types in document generation |
| \`rbac.*\` | Built-in roles | Active | Role definitions, department grants, relationship grants, and Entra ID identity mapping (\`authorityMode\`, \`entraGroupToRoleKey\`, \`entraAppRoleToRoleKey\`, \`requireMfaForAdminPermissions\`, \`defaultRoleKeys\`, \`allowAcrsC1AsMfa\`, and \`emailLinking\`), with runtime tenant overrides persisted per tenant via \`TenantHrAndRbacRepository\` (\`S0-17b\`). Setting \`rbac.identityMapping.requireMfaForAdminPermissions\` to \`false\` is rejected when \`environment === 'live'\` (Schema validation, \`updateTenantRbacConfig\`, \`previewRbacOverrides\`, and Admin UI) and ignored as defence in depth by the core resolver |
| \`rbac.identityMapping.emailLinking.enabled\` | \`true\` | Active | Controls whether first-time Entra sign-in can link an unbound non-privileged employee record by verified domain email; when \`false\`, only explicit \`entraObjectId\` (\`oid\`) bindings are used |
| \`rbac.identityMapping.emailLinking.domains\` | \`[]\` | Active | Lower-case domain names permitted for first-time email linking on sign-in; an empty array (\`[]\`) means the tenant's \`branding.primaryDomain\` only |
| \`documentStores\` | Optional | Active | External SharePoint Online document stores |
| \`documentRouting\` | Optional | Active | Ordered rules mapping matters to a document store, library, and base path |
| \`matterFolderNameTemplate\` | \`"{matterNumber} - {matterDescription}"\` | Active | Template for naming each matter root folder |
| \`documentAccess.departmentEntraGroups\` | \`{}\` | Active | Department to Entra security group mappings |
| \`documentAccess.teamEntraGroups\` | \`{}\` | Active | Team to Entra security group mappings |
| \`documentAccess.uniqueScopeWarningThreshold\` | \`4000\` | Active | Warning threshold for unique SharePoint permission scopes per library |
| \`documentAccess.autoRemediateDrift\` | \`false\` | Reserved (backlog, F23) | Reserved for future scheduled automatic SharePoint permission drift remediation (\`F23\`, beyond Stage 0) |
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
| \`workTypes.defaults.*\` | 6 years retention | Active | Firm-wide fallback automatic opening task templates (\`matter_open\`), work-type risk questions, and closure retention period (\`1\`–\`100\` years) |
| \`workTypes.items[]\` | \`[]\` | Active | Per-work-type and practice-area overrides for auto-task templates, risk questions/weights, and closure retention periods, merged with administrator work-type configuration (\`admin:access\` + MFA) |
| \`workTypes.items[].feeArrangementCapCategories\` | Optional | Active | Maps \`conditional_fee_agreement\` and \`damages_based_agreement\` fee bases on a work type to a core statutory cap category key (\`cfa_general_civil\`, \`cfa_personal_injury\`, \`dba_general_civil\`, \`dba_employment\`, \`dba_personal_injury\`); unmapped CFA/DBA matters and quotes fail closed with \`FEE_CAP_CATEGORY_UNMAPPED\` (\`S0-28b\`) |
| \`workTypes.items[].workTypeCapOverrides\` | \`[]\` | Active | Per-work-type CFA/DBA fee cap percentage overrides (\`R486\`, editable up to each category’s core statutory maximum regardless of lower firm defaults; takes precedence over \`matterCosts.feeArrangementCaps\` when present) |
`.trim(),
};
