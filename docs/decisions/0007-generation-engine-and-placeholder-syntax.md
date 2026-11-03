# ADR-0007: Document Generation Engine Abstraction and Placeholder Syntax

- **Date:** 2026-04-20
- **Status:** Accepted

## Context

In Phase 1, client administrators need a reliable **basic merge** capability that replaces placeholders in `.docx` templates with formatted values from the Field Catalogue or user-prompted inputs. In future phases, the platform team will introduce an advanced engine supporting conditional clauses (`{% if ... %}`), repeating sections/tables (`{% for row in ... %}`), and sub-template assembly without migrating existing templates or changing the `GeneratedDocumentRecord` or `TemplateVersionRecord` data models.

## Decision

### 1. `DocumentGenerationEngine` Interface in `@platform/core-api`

We define a pluggable engine contract in `core/src/api/index.ts`:

```ts
export type GenerationEngineId = 'basic-merge' | (string & {});

export interface ExtractedPlaceholder {
  rawToken: string;           // e.g. "{{ matter.openDate | date:\"d MMMM yyyy\" }}"
  identifier: string;         // e.g. "matter.openDate" or custom label "OurRef"
  inlineFilter?: {
    name: PlaceholderFilterName;
    arg?: string;
  };
  locations: Array<{ partName: string; paragraphIndex: number }>;
}

export interface DocumentGenerationEngine {
  readonly engineId: GenerationEngineId;
  readonly supportedVersion: string;
  extractPlaceholders(docxBytes: Uint8Array): Promise<{
    placeholders: ExtractedPlaceholder[];
    validationErrors: Array<{ code: string; message: string; token?: string }>;
  }>;
  render(input: {
    docxBytes: Uint8Array;
    resolvedValues: Record<string, unknown>;
    mappings: Record<string, TemplatePlaceholderMapping>;
  }): Promise<{
    outputBytes: Uint8Array;
    missingRequiredFields: string[];
    warnings: string[];
  }>;
}
```

Each `TemplateVersionRecord` persists `engine: GenerationEngineId` (defaulting to `'basic-merge'` in Phase 1).

### 2. Placeholder & Filter Syntax (`{{ key | filter }}`)

The `basic-merge` engine supports double-brace interpolation tokens:

- **Canonical or Custom Identifier:** `{{ matter.reference }}` or `{{ OurRef }}` (whitespace inside `{{ ... }}` is trimmed).
- **Optional Pipe Filter:** `{{ key | filterName }}` or `{{ key | filterName:"argument" }}`.
- **Supported Filters in Phase 1:**
  - `date:"<pattern>"` — Formats ISO dates or `Date` values using deterministic UK/ISO patterns (`"d MMMM yyyy"`, `"dd/MM/yyyy"`, `"yyyy-MM-dd"`, `"d MMM yyyy"`).
  - `currency` / `currency:"GBP"` — Formats numeric/pence amounts as `£1,234.56`.
  - `upper` — Converts text to `UPPERCASE`.
  - `title` — Converts text to `Title Case`.
  - `words` — Converts numeric/currency amounts into English words (e.g., `one thousand two hundred and thirty-four pounds and fifty-six pence`).
  - `address_single` — Formats structured addresses on a single comma-separated line (`10 King's Bench Walk, London, EC4Y 7EB`).
  - `address_multi` — Formats structured addresses across multiple lines using Word line breaks (`<w:br/>`) inside the paragraph run.
- **precedence:** A filter configured in the Template Builder UI mapping overrides or supplements an inline filter on the token, and empty values fall back to the mapping's `fallbackText` (or `""` if not required).

### 3. Reservation and Rejection of `{% ... %}` Block Syntax

- Block tags delimited by `{% ... %}` (such as `{% if ... %}`, `{% endif %}`, `{% for ... %}`, `{% include ... %}`) are **reserved** for the future platform conditional/repeating engine.
- If a template uploaded to the `basic-merge` engine contains any `{% ... %}` token (including across split Word runs), `extractPlaceholders` and `render` reject the template with a clear, actionable validation error (`RESERVED_BLOCK_SYNTAX_UNSUPPORTED`: *"Block tag '{% ... %}' is reserved for advanced conditional templates and cannot be used in a basic-merge template."*).

### 4. Forward Compatibility for Repeating Sections, Tables, and Conditional Assembly

- Because each `TemplateVersionRecord` stores `engine: 'basic-merge'` and its structured `mappings` JSON, introducing `'conditional-merge'` in a future release requires only registering a second `DocumentGenerationEngine` implementation in the engine registry:
  - Existing `'basic-merge'` template versions continue routing to `BasicMergeEngine` with zero migration.
  - Repeating table rows (`<w:tr>`) and conditional clauses (`<w:p>` / `<w:r>` blocks) will use the reserved `{% for item in ... %}...{% endfor %}` and `{% if ... %}...{% endif %}` syntax handled by the future engine while sharing the exact same `FieldCatalogue`, `FieldProvider`, approval workflow, storage provider, and usage reporting infrastructure.

## Alternatives Considered

1. **Silently ignore `{% ... %}` tags in `basic-merge` templates.**
   - *Rejected:* Leaving unrendered `{% if ... %}` text inside a generated client document is dangerous and confusing. Explicit rejection at upload/validation time catches mistakes immediately.
2. **Use single braces `{key}` or angle brackets `<<key>>` as placeholders.**
   - *Rejected:* Single braces frequently collide with ordinary legal or JSON text, and `<<key>>` gets auto-converted by Word into guillemet characters (`«key»`). `{{ key }}` is unambiguous and required by the architectural brief.

## Consequences

- Template authors get a clean, predictable placeholder syntax with built-in legal formatting filters (dates, GBP currency, amounts in words, single/multi-line addresses).
- The platform can add conditional and repeating-table engines later without altering database schemas or breaking existing templates.
