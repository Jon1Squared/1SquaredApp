import type { DocArticle } from '../registry';

export const globalSearchArticle: DocArticle = {
  slug: 'global-search',
  title: 'Global server-side search and visibility',
  section: 'getting-started',
  summary:
    'How global search queries PostgreSQL full-text and trigram indexes across nine record types whilst enforcing permissions and restricted-matter rules before ranking or counting.',
  updated: '2026-11-20',
  body: `
The global search bar on **Home** and in the top navigation bar runs debounced queries exclusively on the server via \`searchGlobalRecordsAction\` and \`TenantSearchRepository\` (\`core/src/tenancy/searchRepository.ts\`). The full searchable estate is never built or shipped into browser memory on page load (\`getAppSnapshot\` returns an empty client \`searchIndex\`).

## 1. Record types indexed

Migration \`0018_tenant_search_indexes_expand\` installs \`pg_trgm\` in the tenant database and maintains immutable GIN full-text (\`to_tsvector('simple', ...)\`) and trigram (\`gin_trgm_ops\`) indexes across nine record types:

| Type | Searchable fields | Destination |
| --- | --- | --- |
| **People** | Name, preferred/other names, job title, primary email, active \`person_emails\`, ID (excluding merged tombstones) | \`/people/[id]\` |
| **Organisations** | Legal name, trading name, company number, VAT number, client reference, general email, main phone, website, ID (excluding merged tombstones) | \`/organisations/[id]\` |
| **Matters** | Matter number, title, practice area, work type, status, stage, ID (excluding \`O-KEYDATE-STUB\`) | \`/matters/[id]\` |
| **Enquiries** | Reference, name, email, phone, postcode, calling-on-behalf-of, organisation name, practice area, matter summary, ID | \`/enquiries/[id]\` |
| **Quotes** | Quote reference, prospect name, status, fee basis, practice area, ID | \`/quotes/[id]\` |
| **Tasks** | Task reference, title, description, status, ID | \`/tasks/[id]\` |
| **Documents** | Title, file name, document type, output format, template name, generator name, ID (excluding soft-deleted documents) | Linked matter, client, enquiry or quote |
| **Key dates** | Title, category, key date type, status, notes, ID | Linked matter/enquiry or \`/key-dates\` |
| **Registers** | Reference, title, register type, status, ID | \`/registers?record=[id]\` |

## 2. Matching, ranking and pagination

- **Hybrid matching**: Each search combines exact reference/ID boosts, prefix \`to_tsquery('simple', ...)\` matching, \`websearch_to_tsquery('simple', ...)\` full-text matching, case-insensitive substring \`ILIKE\`, and trigram word similarity (\`pg_trgm\`) so minor spelling mistakes still surface relevant records.
- **Type facets & pagination**: Users can filter by any of the nine record types using the facet pills inside the search dropdown (displaying per-type counts across permitted matches) and load subsequent pages with **Load more results**.

## 3. Permissions, ethical walls and privacy

All access control executes inside PostgreSQL \`WHERE\` clauses **before** ranking, counting or pagination—so restricted or unpermitted records never contribute to either search hits or facet totals (and two-tenant isolation tests verify that exact cross-tenant record ID and reference queries return zero hits across tenants, \`R587\`):

- **Staff matters & ethical walls**: Matters with \`isStaffMatter\`, \`hasEthicalWall\`, or a non-empty allowlist (\`restrictedAccessUserIdsFallback\`) are visible only to users holding \`matter:restricted:access\`, named partners/supervisors/fee earners/team members, or explicit allowlist members. Linked enquiries, quotes, tasks, documents (\`document_links\` and \`primary_matter_id\`), key dates, and register records inherit the same restriction.
- **Role permissions**:
  - \`document:view\` is required for documents.
  - \`quote:view\` is required for quotes (and quote amounts in subtitles are hidden unless the user also holds \`finance:view\` or \`finance:view_matter\`).
  - \`keyDatesConfig.enabled\` and \`keydate:view\` (scoped by \`keydate:view_any_team\` vs own active teams via \`resolvePermittedDiaryTeamIds\`) are required for key dates.
  - \`register:view\` or \`undertaking:manage\` is required for register records (users holding only \`undertaking:manage\` see undertakings only).
  - Personal \`Draft\` enquiries remain visible only to their creator or the user who took the enquiry.
- **Privacy-first telemetry**: Global search emits only aggregate timing and result-count telemetry (\`search.global.executed\`) stamped with \`tenantId\` and \`correlationId\`—search query text and record contents are never logged.
`,
};
