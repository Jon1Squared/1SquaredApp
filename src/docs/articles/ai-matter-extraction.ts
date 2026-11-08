import type { DocArticle } from '../registry';

export const aiMatterExtractionArticle: DocArticle = {
  slug: 'ai-matter-extraction',
  title: 'AI matter extraction',
  section: 'getting-started',
  summary:
    'How AI matter extraction pre-fills the matter opening form from uploaded emails and documents, who can use it, how per-tenant settings govern it, and what data flows to the configured AI provider.',
  updated: '2026-11-07',
  body: `## What AI matter extraction does

When opening a new matter, the **Pre-fill from emails & documents (AI)** panel parses uploaded or pasted intake documents (\`.eml\`, \`.msg\`, \`.pdf\`, \`.docx\`, \`.txt\`) and pre-fills:

- **Section 1 (Matter details & team):** client, instructing contact, billing contact, practice area, work type, matter title, responsible partner, and lead fee earner.
- **Section 2 (Risk assessment & key dates):** document-backed risk questionnaire answers with source citations and critical key dates.
- **Section 3 (Matter parties):** opposing parties, counterparties, representatives, and third parties for the conflict check.
- **Section 6 (More details):** short description, fee estimate, agreed fee cap, payment terms, billing basis, client reference, and court/tribunal details.

### Provenance and fallback labelling

- When extraction succeeds via Anthropic's Claude API, the panel displays the model identifier used (for example \`claude-sonnet-4-5-20250929\`).
- If the remote API is unreachable or refuses a document, the server falls back to deterministic local parsing and labels the result \`local-fallback\` (**Local fallback (offline / deterministic)**) so users can see that AI inference was not used.

### Employee records are never created automatically (B10)

- Extraction matches named partners and fee earners against existing firm employees only.
- If a document names a partner or fee earner who does not match an existing employee record, the name is returned as an unmatched suggestion so the user can choose an existing employee from the dropdown. Extraction never creates employee records.

---

## Permissions required

1. **\`matter:create\` (route gate):** \`POST /api/matters/extract\` is wrapped in \`guardedRoute\` with policy \`{ kind: 'permission', key: 'matter:create', enforcedBy: 'action' }\`. Built-in roles granted \`matter:create\`: **Admin**, **Managing Partner**, **Partner**, **Fee Earner**, **Legal Secretary**, and **Enquiries Coordinator**. **Finance** and **Risk & Compliance** do not hold \`matter:create\` and receive HTTP \`403 FORBIDDEN\`.
2. **\`contact:create\` (CRM record creation):** Before creating an unmatched client organisation, client person, instructing contact, billing contact, or person–organisation link in CRM, the route checks that the signed-in actor holds \`contact:create\`. If \`contact:create\` is not held, no CRM records or links are created.
3. **Scoped response:** The API response returns only the organisations, people (non-employees visible to the actor), and person–organisation links created or matched for that specific extraction—never the entire people, organisation, or link store.

---

## Per-tenant configuration settings (ADR 0031)

AI matter extraction runs **only** when **both** tenant configuration settings are enabled:

| Setting | Path | Allowed values | Default | Required for extraction |
|---|---|---|---|---|
| Feature flag | \`featureFlags.enableAiMatterExtraction\` | \`true\` \\| \`false\` | \`false\` | \`true\` |
| AI provider | \`integrations.aiProviderChoice\` | \`'disabled'\` \\| \`'anthropic'\` \\| \`'azure_openai_uk'\` (reserved) | \`'disabled'\` | \`'anthropic'\` |

- When either setting is not enabled, \`MatterFormClient\` hides the AI extraction panel and \`POST /api/matters/extract\` returns HTTP \`403\` with code \`AI_EXTRACTION_DISABLED\` without reading \`ANTHROPIC_API_KEY\` or making any external network call.
- \`azure_openai_uk\` is reserved in the schema for a UK-resident Azure OpenAI adapter.

---

## Data flow record (Platform Architecture Standard section 10)

| Attribute | Record |
|---|---|
| **Feature** | AI matter extraction (\`POST /api/matters/extract\`) |
| **Provider** | Anthropic commercial API (\`https://api.anthropic.com/v1/messages\` and \`https://api.anthropic.com/v1/models\`) when \`integrations.aiProviderChoice === 'anthropic'\` and \`featureFlags.enableAiMatterExtraction === true\` |
| **Authentication** | Server-side API key read from \`ANTHROPIC_API_KEY\` (Key Vault secret reference in hosted/client Azure environments; never exposed to the browser) |
| **Data sent to provider** | Uploaded or pasted intake document text (\`.eml\`, \`.msg\`, \`.docx\`, \`.txt\`, and text-extractable \`.pdf\` files), raw base64 PDF document blocks when a PDF has no locally extractable text, and the tenant's active practice area and work-type labels |
| **Data never sent** | Existing CRM people, organisations, matters, enquiries, quotes, finance data, HR/payroll data, or other tenants' records (CRM matching happens locally on the server after the AI response returns) |
| **Model training policy** | **No training on client content.** Under Anthropic's commercial API terms, prompts and documents submitted via the API are never used to train or fine-tune models |
| **Data residency** | Anthropic commercial API endpoints operate outside UK Azure regions. Tenants requiring strict UK-only data residency must keep \`integrations.aiProviderChoice\` set to \`'disabled'\` until the \`'azure_openai_uk'\` adapter is enabled |
| **Caching and logging** | In-memory extraction cache keys are scoped by \`tenantId\` and \`actor.personId\`. Application error logs record only \`correlationId\`, \`tenantId\`, and a stable error code (\`EXTRACTION_FAILED\`)—never document content or personal data |
| **Configured tenants** | \`not-a-law-firm\` (\`base.json\`, \`environments/dev.json\`, \`environments/test.json\`): \`enableAiMatterExtraction: true\`, \`aiProviderChoice: 'anthropic'\`. Default for all new tenants: \`enableAiMatterExtraction: false\`, \`aiProviderChoice: 'disabled'\` |
`,
};
