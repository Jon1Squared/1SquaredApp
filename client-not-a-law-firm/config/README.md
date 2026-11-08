# Tenant Configuration Notes (`client-not-a-law-firm`)

This directory holds the schema-validated tenant configuration for the invented test and development tenant **Not A Law Firm LLP** (`tenantId: "not-a-law-firm"`).

- `base.json`: base tenant configuration validated against `core/schemas/tenant-config.schema.json`.
- `environments/dev.json`: development environment overlay.
- `environments/test.json`: automated test environment overlay.

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

### Data Flow Record (Platform Architecture Standard Section 10)

- **Destination provider:** Anthropic commercial API (`https://api.anthropic.com/v1/messages` and `https://api.anthropic.com/v1/models`) when `aiProviderChoice === "anthropic"`.
- **Fields and documents transmitted:**
  - Text extracted from uploaded or pasted intake emails and documents (`.eml`, `.msg`, `.docx`, `.txt`, and text-extractable `.pdf` files).
  - Raw base64 PDF document blocks only when a `.pdf` file has no locally extractable text.
  - Active practice area and work-type labels from the tenant's catalogue.
- **Data never transmitted:** Existing CRM people, organisations, matters, enquiries, quotes, financial records, HR/payroll records, or any other tenant's data. CRM matching runs locally on the server after the provider response is received.
- **Model training:** No training on client content under Anthropic's commercial API terms.
- **Residency note:** Anthropic API endpoints are outside UK Azure regions. Tenants requiring strict UK-only data residency must leave `aiProviderChoice` set to `"disabled"` until the reserved `"azure_openai_uk"` option is wired.
