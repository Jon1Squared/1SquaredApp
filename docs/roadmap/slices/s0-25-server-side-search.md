# S0-25 — Server-Side Search (PostgreSQL Full-Text / Trigram Search with Pre-Ranking Visibility Filtering)

| Field | Value |
|---|---|
| Slice | `S0-25` |
| Stage / Work package | Stage 0C — Make it shared (`WP5b`) |
| Status | Planned (awaiting build; migration `0018` after `0017`) |
| Branch | `s0-25-server-side-search` (target `develop`) |
| Depends on | `S0-17c` (on `develop`; stacked after `S0-24` in `WP5b` for `register_records` & `0018`) |
| Size | `M` |
| Backlog IDs | `32` (remains `Partly built` until `S0-26` + `S0-29`; verifies `documentAccess.autoRemediateDrift` re-tagged to `backlog` during `S0-23` per owner approval 15 Nov 2026; cross-cutting `P8`, `P10`, `P11`) |
| Decision record(s) | None required (implements Architecture Standard sections 4, 7 & 10 on top of ADR 0014, ADR 0025, ADR 0028) |
| Spec / standards references | Architecture Standard sections 4, 7, 10, 12; [ADR 0014](../decisions/0014-staff-matter-access-by-permission.md); [ADR 0028](../decisions/0028-tenant-database-and-repositories.md) |

---

## 1. Purpose

Replace client-side / snapshot-wide search indexing (`buildSearchIndex`) with **PostgreSQL server-side full-text / trigram search** that:

- Covers **people, organisations, matters, enquiries, tasks, documents, quotes, key dates and register records** inside each tenant's PostgreSQL database.
- Enforces every RBAC and matter/enquiry/quote visibility predicate **inside SQL `WHERE` clauses BEFORE ranking (`ORDER BY`), pagination (`LIMIT`/`OFFSET`) and counting (`COUNT(*)` / per-type totals)** — preventing restricted-matter (`isStaffMatter` / `hasEthicalWall`), confidential document, quote, key-date and personal draft enquiry existence leaks.
- Proves strict two-tenant isolation and restricted-record non-leakage in tests.
- Verify `documentAccess.autoRemediateDrift` stays tagged `backlog` (re-tagged cleanly from `[x-reserved:S0-25]` in `S0-23` per owner approval 15 Nov 2026, as it belongs to SharePoint drift remediation, not search).

---

## 2. Classification & Architectural Layer

- **Classification:** Core migration (`0018` search GIN indexes) + core/host search repository/service + guarded search endpoint (`guardedRoute` / `guardedAction`) + `SearchBox` UI update.
- **Single-tenant and multi-tenant operation:** Identical build. Queries run inside the authenticated `TenantContext` against only that tenant's PostgreSQL connection pool; no cross-tenant shared search index is ever built or cached without a tenant-scoped cache key (`tenantId`).

---

## 3. Existing Code & Schema

- **Database schema version entering `S0-25`:** `0017` (from `S0-24`, so register records are searchable too).
- **Existing search code (to replace at query time):** `src/domain/search.ts:1-100`, `src/domain/searchIndex.ts:1-228` (`buildSearchIndex`), `src/server/services.ts:1733`, `src/components/SearchBox.tsx:1-100`.
- **Existing SQL visibility predicates & repos:**
  - `ENQUIRY_VISIBLE_SQL_PREDICATE` & `QUOTE_VISIBLE_SQL_PREDICATE` (`core/src/tenancy/intakeQuoteRepository.ts:654, 671`)
  - `TASK_VISIBLE_SQL_PREDICATE` (`core/src/tenancy/taskWorkflowRepository.ts:412`)
  - `TenantDocumentRepository` (`core/src/tenancy/documentRepository.ts:325`)
  - `TenantKeyDateRepository` (`core/src/tenancy/keyDateRepository.ts:209`)
  - `canAccessMatter` rules (`core/src/domain/rbac/resolver.ts:628`)
- **Mis-tagged schema key (`P7` cleanup):** `documentAccess.autoRemediateDrift` in `core/schemas/tenant-config.schema.json:1020-1027`, `core/src/config-engine/index.ts:1229-1235` and `core/tests/tenant-config-usage.test.ts:628` currently carries `[x-reserved:S0-25]`.

---

## 4. Scope & Exact Changes

### 4.1 Migration `0018_tenant_search_indexes_expand`

Bump `CORE_REQUIRED_SCHEMA_VERSION` from `'0017'` to `'0018'` and add `0018_tenant_search_indexes_expand` (reversible expand migration):

- Enable `pg_trgm` extension if not present (safe/idempotent `CREATE EXTENSION IF NOT EXISTS pg_trgm`) and create GIN / `to_tsvector` + trigram search indexes across tenant tables:
  - `public.people` (names, email lookup via `person_emails`), `public.organisations`, `public.matters` (ref, title, description/client), `public.enquiries`, `public.tasks`, `public.documents` (`TenantDocumentRepository`), `public.quotes` (`TenantIntakeQuoteRepository`), `public.key_dates` (`TenantKeyDateRepository`), and `public.register_records` (`S0-24`).

### 4.2 Server-side search repository & strict pre-ranking / pre-count filtering invariant

Implement a tenant-scoped server search service & repository method queried by `SearchBox.tsx` via a `guardedAction` / `guardedRoute` (with explicit policy in `src/server/actionPermissions.ts`, `MAX_KNOWN_GAPS = 0`):

- **Supported entity types:** `person`, `organisation`, `matter`, `enquiry`, `task`, **`document`**, **`quote`**, **`key_date`**, `register_record`.
- **Mandatory SQL security invariant (filter BEFORE ranking and counting):**
  - Every `UNION` / CTE / subquery applies visibility and RBAC predicates inside `WHERE` **prior** to computing relevance ranking (`ts_rank` / trigram similarity), facet `COUNT(*)`, total count, `ORDER BY`, `LIMIT`, and `OFFSET`:
    - **Matters:** exclude `is_staff_matter = TRUE` and `has_ethical_wall = TRUE` rows unless the caller holds `'matter:restricted:access'` or is in `restricted_access_user_ids` / named participant (matching `canAccessMatter`, fail-closed even when `restricted_access_user_ids` is empty per `B12`).
    - **Documents (`public.documents`):** check caller has `'document:view'` AND join/filter linked `matter` (or parent entity) with the same restricted-matter predicate!
    - **Quotes (`public.quotes`):** apply `QUOTE_VISIBLE_SQL_PREDICATE` + finance/quote view permissions (`finance:view` / fee details redacted if unpermitted).
    - **Key Dates (`public.key_dates`):** check caller has `'keydate:view'` (and `'keydate:view_any_team'` scope rules) AND exclude any key date on a restricted matter the caller cannot access!
    - **Enquiries / Tasks / Register Records:** apply `ENQUIRY_VISIBLE_SQL_PREDICATE` (no personal draft leakage), `TASK_VISIBLE_SQL_PREDICATE` and register-matter visibility joins.
  - Because filtering happens before counting and pagination, an unpermitted user **never** sees total count `1` or empty gaps revealing the existence of a restricted matter, confidential document, restricted quote or key date.

### 4.3 `SearchBox` UI & `documentAccess.autoRemediateDrift` re-tag

- Update `SearchBox.tsx` (`src/components/SearchBox.tsx`) to query the server-side search action/endpoint with debouncing, type facets (including Documents, Quotes, Key Dates, Registers), keyboard navigation and honest empty/loading states — stop shipping the whole snapshot to build client-side search indexes (`buildSearchIndex` retained only if needed for non-sensitive UI helpers or retired cleanly).
- Re-tag `documentAccess.autoRemediateDrift` (`core/schemas/tenant-config.schema.json:1020`, `core/src/config-engine/index.ts:1229`, `core/tests/tenant-config-usage.test.ts:628`) from `[x-reserved:S0-25]` to `backlog` (so SharePoint drift auto-remediation stays cleanly tracked without blocking `S0-25`).

### 4.4 Out of Scope

- Transactional email & notification outbox (`S0-26`) and digests/Teams (`S0-29`) which complete backlog item `32`.
- External Azure AI Search service (PostgreSQL GIN/FTS covers Stage 0 requirements cleanly per tenant database).

---

## 5. Migrations & Backwards Compatibility

- **Migration:** `0018_tenant_search_indexes_expand` (adds `pg_trgm`/FTS GIN indexes; bumps `CORE_REQUIRED_SCHEMA_VERSION` from `'0017'` to `'0018'`).
- **Reversibility:** Down SQL drops the search indexes cleanly with zero table/data changes.
- Verify Azure Database for PostgreSQL flexible server extension allow-listing for `pg_trgm` (already standard in Azure PostgreSQL; fall back to native `to_tsvector` + `pg_trgm` Bicep check if needed).

---

## 6. Security, Tenancy & Permissions

- Search endpoint/action goes through `guardedAction` / `guardedRoute` in `src/server/actionPermissions.ts`.
- Pre-ranking & pre-count filtering eliminates timing/count side channels on restricted `isStaffMatter` and `hasEthicalWall` records, confidential documents, quotes, key dates and personal drafts.
- Search logs emit only `tenantId`, `correlationId`, result count and timing — never search query strings containing potential PII/matter names.

---

## 7. Tests Required

1. **All-entity search tests:** Verify accurate matches, relevance ranking and pagination across **people, organisations, matters, enquiries, tasks, documents, quotes, key dates and register records**.
2. **Restricted-record visibility & zero-oracle count tests (`isStaffMatter` & `hasEthicalWall`):**
   - Explicitly seed restricted matter + linked **document**, linked **quote**, linked **key date**, linked **task** and linked **register record** matching a unique search term.
   - Search as a **non-permitted user** (without `matter:restricted:access` and not named on the matter) -> assert **zero hits**, **totalCount === 0** and **every facet count === 0** across documents, quotes, key dates, matters and tasks!
   - Search as a **permitted user** -> assert matching records appear and count accurately.
   - Verify personal draft enquiries created by User A never appear in hits or counts for User B.
3. **Permission-gating tests:** User lacking `'keydate:view'`, `'document:view'` or `'finance:view'` never sees restricted entity types in search hits or counts.
4. **Config re-tag test:** `core/tests/tenant-config-usage.test.ts` passes with `documentAccess.autoRemediateDrift` cleanly moved to `backlog` (`[x-reserved:S0-25]` retired).
5. **Two-tenant isolation tests (`P8`):** Matching documents, quotes, key dates, people and matters in Tenant A NEVER appear in Tenant B search results or facet counts even under forged `tenantId` claims or tampered filter/cursor params.

---

## 8. Documentation, Help & Backlog Updates

- **Help & documentation (`Rule 11`, `P11`):**
  - Update [matters-enquiries-tasks-and-navigation.ts](file:///c:/1Squared/App/src/docs/articles/matters-enquiries-tasks-and-navigation.ts) (global search coverage across matters, documents, quotes, key dates and registers, and visibility rules).
- **Release notes:** Add an `S0-25` entry in `docs/release-notes.md`.
- **Backlog updates (`docs/roadmap/feature-list.md`):**
  - Item `32` (*Search and notifications*): remains `Partly built` (record server-side search complete for all entities; *"What's missing"*: `S0-26` email/preferences and `S0-29` digests/Teams).
  - Record `P7` (`documentAccess.autoRemediateDrift` re-tagged `backlog`), `P8`, `P10`, `P11`.

---

## 9. Manual Setup / External Blockers

- `None` (verify `pg_trgm` is enabled on Azure PostgreSQL Flexible Server in Bicep `azure.extensions` parameter if not already allow-listed in `core/infra/`).

---

## 10. Acceptance Criteria

- [ ] Migration `0018_tenant_search_indexes_expand` creates tenant-local search indexes; `CORE_REQUIRED_SCHEMA_VERSION === '0018'`.
- [ ] Server-side search covers people, organisations, matters, enquiries, tasks, **documents, quotes, key dates** and register records.
- [ ] SQL `WHERE` clauses filter by RBAC, `isStaffMatter`/`hasEthicalWall`, `QUOTE_VISIBLE_SQL_PREDICATE` and `ENQUIRY_VISIBLE_SQL_PREDICATE` **before** ranking, pagination and counting (explicit test verifies `totalCount === 0` for restricted documents/quotes/key dates/matters).
- [ ] `documentAccess.autoRemediateDrift` is re-tagged cleanly from `[x-reserved:S0-25]` to `backlog` (`tenant-config-usage.test.ts` passes).
- [ ] Two-tenant isolation tests and `npm run ci` pass.
- [ ] Help article (`matters-enquiries-tasks-and-navigation.ts`), `docs/release-notes.md` and `docs/roadmap/feature-list.md` (`32` kept `Partly built`) are updated in the same PR.

---

## 11. Re-plan Signs & Risks

- **Re-plan if:**
  - `pg_trgm` is blocked in Azure PostgreSQL Flexible Server extensions parameter and requires an allow-list update in `core/infra/`;
  - Cross-joining `documents` or `key_dates` visibility predicates surfaces missing foreign-key indexes needed for sub-100ms query latency.
