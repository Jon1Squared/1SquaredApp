# ADR 0031: Add Anthropic to Tenant AI Provider Choice

- **Date:** 2026-11-07
- **Status:** Accepted
- **Roadmap:** Stage 0 decision D12, slice S0-06 (`docs/roadmap/stage-0-plan.md`); backlog items B10, P7

## Context

The matter opening form includes an optional AI extraction workflow (`POST /api/matters/extract`) that parses uploaded or pasted emails and documents (`.eml`, `.msg`, `.pdf`, `.docx`, `.txt`) to pre-fill matter details, parties, key dates, and risk assessment answers.

Before S0-06:
- `integrations.aiProviderChoice` in `core/schemas/tenant-config.schema.json` and `core/src/config-engine/index.ts` allowed only `'azure_openai_uk' | 'disabled'`.
- However, `src/app/api/matters/extract/route.ts` called Anthropic's Claude API (`https://api.anthropic.com/v1/messages`) without checking either `featureFlags.enableAiMatterExtraction` or `integrations.aiProviderChoice`.
- `docs/deployment-and-security-architecture-guide.md` stated that AI features were limited to `'azure_openai_uk'` or `'disabled'` within UK Azure regions.

Under the Platform Architecture Standard (sections 3, 10, and 12), tenant configuration must accurately govern which AI provider is active, schema changes must be additive and backward compatible within a major version, and any external AI data flow must be explicitly documented per tenant.

## Decision

1. **Additive schema update (`aiProviderChoice`).**
   Add `'anthropic'` to `integrations.aiProviderChoice` across `core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, and `@platform/core-api`:

   ```text
   integrations.aiProviderChoice: 'azure_openai_uk' | 'anthropic' | 'disabled'
   ```

   - The default remains `'disabled'` (backward compatible under architecture rule 7).
   - `'azure_openai_uk'` remains in the schema enum for a future UK-resident Azure OpenAI adapter (rejected at runtime by `POST /api/matters/extract` with `403 AI_EXTRACTION_DISABLED` until that adapter is wired).

2. **Runtime enforcement on `/api/matters/extract` and UI.**
   - AI matter extraction runs **only** when `featureFlags.enableAiMatterExtraction === true` **and** `integrations.aiProviderChoice === 'anthropic'`.
   - If either condition is false, `POST /api/matters/extract` returns HTTP `403` with code `'AI_EXTRACTION_DISABLED'` before reading the API key or calling any external service, and `MatterFormClient` hides the AI extraction panel.

3. **Data flow and commercial terms (Standard section 10).**
   - When a tenant enables `enableAiMatterExtraction: true` and `aiProviderChoice: 'anthropic'`, uploaded/pasted intake document text, raw PDF documents (when text cannot be extracted locally), and active work-type labels are sent over TLS to Anthropic's commercial API (`https://api.anthropic.com/v1/messages` and `https://api.anthropic.com/v1/models`) using the server-side `ANTHROPIC_API_KEY` secret from Key Vault.
   - Under Anthropic's commercial API terms, client content submitted via the API is not used to train models.
   - Anthropic's API endpoints are hosted outside UK Azure regions; tenants requiring strict UK-only data residency must keep `aiProviderChoice` set to `'disabled'` (or use `'azure_openai_uk'` once the UK Azure OpenAI adapter is implemented).
   - No client content or document text is written to application logs; extraction cache keys are scoped by `tenantId` and `actor.personId`.

## Alternatives Considered

- **Removing Anthropic and building an Azure OpenAI adapter immediately in Stage 0.** Rejected by the product owner on 7 November 2026: the existing Anthropic extraction prompt and PDF handling are already tested and used in demonstrations, whereas provisioning and tuning an Azure OpenAI deployment would add scope to Stage 0.
- **Allowing `azure_openai_uk` to call Anthropic.** Rejected: configuration values must truthfully represent the provider receiving tenant data (standard section 10).

## Consequences

- Tenants must explicitly opt in to both `featureFlags.enableAiMatterExtraction: true` and `integrations.aiProviderChoice: 'anthropic'` before any document content is sent to Anthropic.
- `client-not-a-law-firm` (`base.json`, `environments/dev.json`, and `environments/test.json`) is updated to `"aiProviderChoice": "anthropic"` so development, test, and demo extraction flows match the configured provider.
- The help documentation (`ai-matter-extraction`) and tenant configuration notes record the exact data flow and residency characteristics for firm Risk/Compliance and COLP review.
