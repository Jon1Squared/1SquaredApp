# Tenant Configuration Notes (`client-not-a-law-firm`)

This directory holds the schema-validated tenant configuration for the invented test and development tenant **Not A Law Firm LLP** (`tenantId: "not-a-law-firm"`).

- `base.json`: base tenant configuration validated against `core/schemas/tenant-config.schema.json`.
- `environments/dev.json`: development environment overlay.
- `environments/test.json`: automated test environment overlay.
- `environments/demo.json`: standalone demo environment overlay (`environment: "demo"`, `featureFlags.enableDemoMode: true`).

## Feature Flags & Active Tenant Settings (S0-06, S0-12, S0-11b)

| Setting | `base.json` value | Schema default | Runtime behaviour |
|---|---|---|---|
| `featureFlags.enableMatterCostsGovernance` | `true` | `true` | Gates the Administration **Rates & matter costs** tab, the matter form partner cost sign-off UI, `saveMatterCostsConfigAction`, `signOffMatterCostsAction`, and the `beforeMatterCostsCalculate` / `beforeMatterOpen` governance hooks |
| `featureFlags.enablePmsLiveRateSync` | `true` | `true` | Gates the **Pull / Sync Rates from PMS** button and `syncMatterCostsRatesFromPmsAction` |
| `featureFlags.enableAiMatterExtraction` | `true` | `false` | Gates `POST /api/matters/extract` and the AI extraction panel (requires `integrations.aiProviderChoice === "anthropic"`) |
| `featureFlags.enableDemoMode` | `false` (`false` in `base.json`, `dev.json` and `test.json`; `true` in `environments/demo.json`) | `false` | Enables Demo Mode, the persona switcher, sample document seeding, and data reset when `environment` is non-live (`dev`, `test`, `training`, or `demo`) |
| `integrations.aiProviderChoice` | `"anthropic"` | `"disabled"` | Selects the AI model provider (`"anthropic"`, `"azure_openai_uk"`, or `"disabled"`) |

## Reserved Tenant Settings (`x-reserved`)

Settings that are validated by `core/schemas/tenant-config.schema.json` for backward compatibility (Rule 7) and reserved for upcoming Stage 0 or backlog slices are marked with `"x-reserved": { "for": "...", "reason": "..." }` in the JSON schema and logged once at startup as a structured `info` notice (`event: "tenant_config.reserved_settings"`):

| Setting | Target slice | Reason |
|---|---|---|
| `branding.accentColorHex` | `backlog` (F21) | Reserved for tenant branding theme rendering; the demo tenant uses the standard platform theme |
| `branding.logoAssetKey` | `backlog` (F21) | Reserved for tenant firm logo rendering; the demo tenant uses the standard platform logo |
| `matterCosts.*` (`rateSourceMode`, `allowMatterRateOverrides`, `partnerSignOffThresholdGbp`, `rateCards`, `disbursementPresets`) | `S0-23` | Reserved for unifying tenant-level and runtime-store matter costs configuration |
| `integrations.pmsConnectionSecretVaultRef` | `S0-18` | Reserved for live tenant-scoped PMS database connection secret resolution |
| `integrations.companiesHouseApiKeyVaultRef` | `S0-18` | Reserved for live Companies House API integration |
| `integrations.pmsSync.*` (`enabled`, `providerKey`, `syncMode`, `matterCodeAllocation`, `clientCodeAllocation`, `pollIntervalMinutes`, `fieldMappings`) | `S0-18` | Reserved for live tenant-scoped PMS synchronisation and code allocation |
| `customFields` | `S0-17` | Reserved for moving custom field definitions off the transitional JSON store |
| `documentGeneration.usage.retentionMonths` | `S0-19` | Reserved for automated document usage event retention pruning |
| `documentGeneration.customDocumentTypes` | `backlog` (F20) | Reserved for tenant-configured custom document classification types in document generation |
| `documentAccess.autoRemediateDrift` | `S0-25` | Reserved for scheduled automatic SharePoint permission drift remediation |
| `keyDates.defaults.teamAssignment` | `backlog` (F19) | Reserved for additional key dates team diary assignment modes beyond `matter_owning_team` |
| `keyDates.matterTypes[].defaultRuleSetIds` | `backlog` (F19) | Reserved for default limitation rule set filtering by matter type |
| `keyDates.limitationRuleSets[].rules[].claimType` | `backlog` (F19) | Reserved for claim-type classification and filtering on limitation rules |
| `keyDates.calendarSync.provider` | `backlog` (F19) | Reserved for multi-provider external calendar adapter selection |

## AI Matter Extraction Configuration & Data Flow Record (Standard Section 10, ADR 0031)

AI matter extraction (`POST /api/matters/extract`) is governed by two tenant settings:

1. `featureFlags.enableAiMatterExtraction` (`boolean`, default `false`)
2. `integrations.aiProviderChoice` (`"disabled" | "anthropic" | "azure_openai_uk"`, default `"disabled"`)

Extraction runs **only** when `featureFlags.enableAiMatterExtraction === true` **and** `integrations.aiProviderChoice === "anthropic"`. When either condition is not met, the AI panel is hidden in `MatterFormClient` and `POST /api/matters/extract` returns HTTP `403` (`AI_EXTRACTION_DISABLED`).

### Per-Environment Settings for `not-a-law-firm`

| Environment | `featureFlags.enableAiMatterExtraction` | `integrations.aiProviderChoice` | Active Provider |
|---|---|---|---|
| `base.json` | `true` | `"anthropic"` | Anthropic commercial API (`ANTHROPIC_API_KEY`) |
| `environments/dev.json` | `true` (inherited) | `"anthropic"` | Anthropic commercial API (`ANTHROPIC_API_KEY`) |
| `environments/test.json` | `true` (inherited) | `"anthropic"` | Anthropic commercial API (`ANTHROPIC_API_KEY`) |
| `environments/demo.json` | `true` (inherited) | `"anthropic"` | Anthropic commercial API (`ANTHROPIC_API_KEY`) |

### Data Flow Record (Platform Architecture Standard Section 10)

- **Destination provider:** Anthropic commercial API (`https://api.anthropic.com/v1/messages` and `https://api.anthropic.com/v1/models`) when `aiProviderChoice === "anthropic"`.
- **Fields and documents transmitted:**
  - Text extracted from uploaded or pasted intake emails and documents (`.eml`, `.msg`, `.docx`, `.txt`, and text-extractable `.pdf` files).
  - Raw base64 PDF document blocks only when a `.pdf` file has no locally extractable text.
  - Active practice area and work-type labels from the tenant's catalogue.
- **Data never transmitted:** Existing CRM people, organisations, matters, enquiries, quotes, financial records, HR/payroll records, or any other tenant's data. CRM matching runs locally on the server after the provider response is received.
- **Model training:** No training on client content under Anthropic's commercial API terms.
- **Residency note:** Anthropic API endpoints are outside UK Azure regions. Tenants requiring strict UK-only data residency must leave `aiProviderChoice` set to `"disabled"` until the reserved `"azure_openai_uk"` option is wired.
