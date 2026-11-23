# S1-02a: B15 Server Side — SQL-Scoped Repositories, Service Write/Finance Paths, and Monotonic Guard Baseline

| | |
|---|---|
| Backlog | `B15`, items `1`, `1a`, `2`, `3`, `4`, `28`, `33`, `P2`, `P8`, `P10` |
| Decision | Stage 1 plan `S1-02a` (`B15`), [ADR 0014](../../decisions/0014-staff-matter-access-by-permission.md), [ADR 0028](../../decisions/0028-tenant-database-and-repositories.md), [ADR 0029](../../decisions/0029-finance-data-delivery.md) |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP1 (`S1-02a`) |
| Branch | `s1-02a-scoped-queries-server`, stacked on `s1-03-intake-check-interfaces`, targeting `develop` |
| Change class | Core tenancy repository SQL queries & optional expand migration `0024` (`core/src/tenancy/`) + Host server service/finance/docgen/docstore/extract-route refactoring & AST guard (`src/server/`, `src/app/api/matters/extract/`) |
| Layer | Core tenancy layer (`core/src/tenancy/`) + Host server layer (`src/server/`, `src/app/api/matters/extract/`); **pages, `layout.tsx`, and the 5 browser `useMemo` form scans move in WP1b (`S1-02b`)** |
| Size | L |
| Depends on | `S1-01`; stacked on `S1-03` (`CORE_REQUIRED_SCHEMA_VERSION = '0023'`) per WP1 build order |
| Blocking manual tasks | Executing `caj-migrate-demo` in Azure when deploying WP1 (only if optional expand migration `0024` is added) |
| Baseline | `develop` at `7c2ba3e` |

## What exists today

Checked against `develop` (`7c2ba3e`):

1. **Existing SQL-scoped repository methods sit unused (`core/src/tenancy/`):**
   - `TenantMatterRepository.listVisibleMatters` (`:1642-1707`) and `TenantIntakeQuoteRepository.listVisibleEnquiries` (`:1290-1342`) / `listVisibleQuotes` (`:1687-1725`) and `TenantTaskWorkflowRepository.listVisibleTasks` (`:977-1045`) already exist, yet have zero request-path callers in `src/`.
   - **Subtlety in `ENQUIRY_VISIBLE_SQL_PREDICATE` (`intakeQuoteRepository.ts:779-792`):** passing `includeRestricted: true` currently skips **both** restricted-matter checks **and** personal-`Draft` creator ownership checks, whereas `visibility.ts:61-77` forbids `matter:restricted:access` holders from seeing another user's personal `Draft` enquiries. Separate `hasRestrictedMatterAccess` (`matter:restricted:access`) from `includeRestricted` (`internal/system` only).
   - `searchVisibleMatters` (`matterRepository.ts:1892-1918`) loads matching visibility rows and filters search text in JS rather than pushing text predicates into SQL `ILIKE` / `pg_trgm`.
2. **Whole-tenant loads across server services & routes:**
   - `41` non-test call sites call `listAllMattersUnfiltered` (plus unfiltered `listAllPeople`, `listAllOrganisations`, `listAllEnquiriesUnfiltered`, `listAllQuotesUnfiltered`, `listAllTasksUnfiltered`, `listAllSignOffsUnfiltered`), and ~`35` call sites load every non-employee contact in `listAllPeople` solely to resolve employee/RBAC permissions (`hasPersonPermission` / `filterEmployees`).
   - `verifyFinanceActorAndPermission` (`src/server/financeServices.ts:216`) calls `listAllMattersUnfiltered` and `TenantPmsRepository.loadTenantPmsSnapshot` (`pmsRepository.ts:2185` executes 12 full `SELECT *` queries). On `/` alone this runs up to 7× full PMS hydrations per request.
   - `getAppSnapshotInScope` (`src/server/services.ts:2171-2187`) performs a hidden `intakeRepo.putQuote` write-on-read during snapshot reads.
3. **Migration number coordination in WP1 (`S1-01` -> `S1-03` -> `S1-02a` -> `S1-10`):**
   - `S1-03` claims migration `0023` (`0023_intake_checks_and_outbox_attachments_expand`, raising `CORE_REQUIRED_SCHEMA_VERSION = '0023'`). Because `0024` adds indexes and columns only to `people`, `organisations`, and `matters` (requiring `0009` and `0018`, with zero dependency on `0023`), **`S1-02a` uses migration `0024`** (`0024_scoped_lookup_and_candidate_indexes_expand`, `dependsOn: ['0009', '0018']`, `CORE_REQUIRED_SCHEMA_VERSION = '0024'`) so `0023` and `0024` can be rolled back independently.
4. **Complete inventory and split disposition between `S1-02a` (WP1) and `S1-02b` (WP1b):**

| # | `file:line` | Function / surface | Disposition (`S1-02a` vs `S1-02b` baseline vs `Permanent Allow-list`) |
|---:|---|---|---|
| 1 | `src/server/services.ts:636` | `switchUserInDemoMode` | **Convert in `S1-02a`**: SQL check on restricted matters accessible to target persona (`idx_matters_tenant_restricted`) |
| 2 | `src/server/services.ts:1388` | `listAuditEntriesForRecord` | **Convert in `S1-02a`**: scoped single-record lookup + `employeesAndLeaversOnly` RBAC |
| 3 | `src/server/services.ts:1518` | `listFirmAuditEntriesPage` | **Convert in `S1-02a`**: load only entities referenced by the `limit: 250` audit page |
| 4 | `src/server/services.ts:1758` | `getAppSnapshotInScope` (`putQuote` at `:2171-2187`) | **Partial in `S1-02a`**: remove `putQuote` write-on-read and switch internal list queries to SQL `listVisible*`; remove `getAppSnapshotInScope` + `layout.tsx` + `24` `page.tsx` callers + `6` component scan calls in **`S1-02b`** (kept explicitly in AST guard's `DEFERRED_S1_02B_ALLOW_LIST` at end of `S1-02a`) |
| 5 | `src/server/services.ts:2411` | `getEmployeeDetailsForUser` | **Convert in `S1-02a`**: `listMattersByIds` for `rawEmployment.supervisionMatterIds` + `employeesAndLeaversOnly` |
| 6 | `src/server/services.ts:2621` | `reassignLeaverOwnedRecords` | **Convert in `S1-02a`**: SQL `WHERE responsible_partner_id = $2 OR ...` targeted updates across matters/tasks/enquiries/orgs |
| 7 | `src/server/services.ts:2978` | `savePersonRecord` (+ `findCandidateDuplicatesForRecord` `:10042`) | **Convert in `S1-02a`**: affected matters (`client_id`, `additional_client_ids`, `matter_parties`, audit targets) + SQL duplicate candidates |
| 8 | `src/server/services.ts:4148` | `saveOrganisationRecord` | **Convert in `S1-02a`**: `getOrganisationById` + SQL duplicate candidates + `employeesAndLeaversOnly` RBAC (zero matters loaded) |
| 9 | `src/server/services.ts:4606` | `addNoteToRecord` | **Convert in `S1-02a`**: `getMatterById` only when `recordType === 'matter'` |
| 10 | `src/server/services.ts:5853` | `saveMatterRecord` | **Convert in `S1-02a`**: targeted ID lookups + SQL conflict candidate subgraph |
| 11 | `src/server/services.ts:8446` | `runMatterConflictSearchRecord` | **Convert in `S1-02a`**: SQL conflict candidate subgraph (`searchMatterConflicts` algorithm preserved identically) |
| 12 | `src/server/services.ts:8612` | `updateMatterConflictRecord` | **Convert in `S1-02a`**: SQL conflict candidate subgraph + matter-linked tasks (`listTasksLinkedToRecord`) |
| 13 | `src/server/services.ts:9007` | `signOffMatterCostsRecord` | **Convert in `S1-02a`**: `getMatterById` + single client/source enquiry/quote + matter-linked tasks |
| 14 | `src/server/services.ts:9600` | `executeMerge` | **Convert in `S1-02a`**: survivor + merged records, their links/notes, subsidiary orgs, and referencing matters only |
| 15–17 | `src/server/services.ts:12092, 12831, 12901` | `saveTaskRecord`, `takeTaskRecord`, `addTaskCommentRecord` | **Convert in `S1-02a`**: `loadScopedVisibilityContext` (`getTaskById` + linked records/matters/enquiries/quotes/keyDates) |
| 18–23 | `src/server/services.ts:13329, 13970, 14119, 14227, 14377, 14519` | `saveEnquiryRecord` (`computeEnquiryConflictSnapshot`), `assignEnquiryRecord`, `logEnquiryContactRecord`, `sendEnquiryEmailRecord`, `closeEnquiryRecord`, `reopenEnquiryRecord` | **Convert in `S1-02a`**: `getEnquiryById` + `loadScopedVisibilityContext` + SQL conflict candidates (`saveEnquiryRecord`) + targeted notification count / SQL `EXISTS` (`closeEnquiryRecord`) |
| 24 | `src/server/services.ts:14661` | `prepareEnquiryConversion` | **Convert in `S1-02a`**: SQL conflict candidate subgraph for `runEnquiryConflictSearch` + candidate duplicate check |
| 25 | `src/server/services.ts:15923` | `rerunAutomaticPmsMatching` | **Permanent allow-list**: explicit whole-tenant admin PMS matching batch action |
| 26–27 | `src/server/services.ts:18110, 18273` | `deleteMatterPartyRelationship`, `deleteMatterPartyCapacity` | **Convert in `S1-02a`**: single SQL usage count (`countMatterPartyUsages`) across `public.matters` and `public.matter_parties` |
| 28–32 | `src/server/services.ts:18443, 19025, 19105, 19218, 19595` | `saveQuoteRecord`, `markQuoteSentRecord`, `logQuoteFollowUpRecord`, `reviseQuoteRecord`, `recordQuoteOutcomeRecord` | **Convert in `S1-02a`**: `loadScopedVisibilityContext` via `getQuoteById` + `listMattersUnfilteredByIdsOrSources` |
| 33 | `src/server/services.ts:19715` | `prepareQuoteConversionRecord` | **Convert in `S1-02a`**: SQL conflict candidate subgraph for `searchMatterConflicts` + `runEnquiryConflictSearch` |
| 34 | `src/server/services.ts:20809` (+ `:21672–22972`) | `resolveKeyDatesActorAndData` & key-date mutations | **Convert in `S1-02a`**: single `getMatterById` when `matterId` given; `listVisibleMatters` for diary/exceptions; linked tasks only on key-date mutations |
| 35 | `src/server/services.ts:23127` | `executeKeyDateRemindersForTenant` | **Permanent allow-list**: unattended scheduled job (`guardedJob('key-date-reminders')`) |
| 36 | `src/server/services.ts:25871` | `listRegistersWorkspaceDataRecord` | **Convert in `S1-02a`**: `getMatterById` (when `filter.matterId` set) or `listVisibleMatters` |
| 37 | `src/server/services.ts:26867` | `executeRegisterRemindersForTenant` | **Permanent allow-list**: scheduled job (`guardedJob('register-reminders')`; narrow matters to candidate `matterId`s) |
| 38 | `src/server/services.ts:27559` | `executeNotificationDigestsForTenant` | **Permanent allow-list**: scheduled job (`guardedJob('notification-digests')`; narrow to IDs referenced in `undigested`) |
| 39 | `src/server/financeServices.ts:216` (+ `:444, 550, 652`) | `verifyFinanceActorAndPermission` (firm/matter/my finance, PMS bundles, admin snapshot) | **Convert in `S1-02a`**: SQL join `pms_links × matters` + targeted SQL queries on `TenantPmsRepository` |
| 40 | `src/server/documentGenerationServices.ts:831` | `getInitializedDocGenContext` | **Convert in `S1-02a`**: target matter/client on preview & generate; referenced matters only on workspace/admin context |
| 41 | `src/server/documentStoreServices.ts:867` (+ `:297-298`) | `loadMatterByIdForAccessCheck` & `buildTenantContextForUser` | **Convert in `S1-02a`**: `getMatterById(ctx, matterId, { includeRestricted: true })`, `getOrganisationById`, and `employeesAndLeaversOnly` |
| 42 | `src/server/documentStoreServices.ts:2349` | `applyAdminTemplateAdditionsToOpenMatters` | **Permanent allow-list**: explicit admin bulk SharePoint folder-provisioning batch across open matters |
| 43 | `src/app/api/matters/extract/route.ts:2233, 2425` | `ensureContactInCrm`, `enrichExtractionWithCrmMatches` (`POST /api/matters/extract`) | **Convert in `S1-02a`**: scoped link queries + SQL candidate matching |
| 44 | `src/server/storePostgresImport.ts:1096` (+ `resetAllDemoData` `:10605`, scheduled `runEnquiryRetentionAnonymisationForTenant` `:15337`) | Seed/demo reset & scheduled retention anonymisation | **Split in `S1-02a`**: manual single-enquiry anonymisation (`enquiryId` supplied) converts to `getEnquiryById`; bulk scheduled job sweep + seed/demo reset stay on **Permanent allow-list** |
| 45 | `src/app/layout.tsx:51`, `24` `src/app/**/page.tsx` routes, and `6` component calls (`EnquiryFormClient`, `EnquiryProfileClient`, `HomeClient` ×2, `OrganisationFormClient`, `PersonFormClient`), plus `7` `getAppSnapshot`/`getAppSnapshotInScope` sites | Initial shell/page hydration & live `useMemo` duplicate/conflict previews | **Deferred baseline in `S1-02b`** (recorded explicitly in AST guard's `DEFERRED_S1_02B_ALLOW_LIST` / `MAX_DEFERRED_S1_02B_BASELINE_COUNT = 38` at end of `S1-02a`—up from initial `37` estimate solely because an existing `listAllVisibleKeyDates` call inside `getAppSnapshotInScope` is now detected after adding `listAllVisibleKeyDates` to `TARGET_WHOLE_TENANT_CALLEES`, not a regression—shrunk to `0` in WP1b). Additionally, `loadFullConflictSearchGraph` and its `6` live conflict callers are confined to `TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST` (`MAX_TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST_COUNT = 7`) tracked against **`B22`**. |

## Files and changes

1. **Core SQL-scoped repository methods & optional migration `0024` (`core/src/tenancy/`):**
   - `core/src/tenancy/migrations/index.ts`: reversible expand migration **`0024_scoped_lookup_and_candidate_indexes_expand`** (`dependsOn: ['0009', '0018']`, `CORE_REQUIRED_SCHEMA_VERSION = '0024'`, `downSql` drops added columns/indexes cleanly per Rule 8) adding indexed lookup columns/arrays (`people.phone_last9_keys`, `people.postcode_keys`, `people.phonetic_keys`, `organisations.email_domains`, `organisations.phone_last9_keys`, `organisations.postcode_keys`, `organisations.norm_company_number`, `organisations.phonetic_keys`) populated via deterministic TypeScript `compute*LookupKeys` `afterUpSql` batches so SQL candidate selection guarantees zero missed hits against `normalise.ts` / `duplicates.ts` / `matterConflicts.ts`.
   - `core/src/tenancy/matterRepository.ts`: push `searchVisibleMatters` text search (`:1892-1918`) into SQL `ILIKE`; add `listMatterIdsMatchingCandidateGraph(...)` and `listMattersUnfilteredByIdsOrSources`.
   - `core/src/tenancy/partyRepository.ts`:
     - Add `employeesAndLeaversOnly` filter option on `listAllPeople` (`WHERE tenant_id = $1 AND (is_employee = TRUE OR EXISTS (SELECT 1 FROM public.employee_employment_records e WHERE e.tenant_id = people.tenant_id AND e.person_id = people.id))`) so ~35 RBAC/auth checks never load external contacts;
     - Add `listPeopleByIds`, `listOrganisationsByIds`, `listLinksForEntities`, `listMergeHistoryForEntity`, `findSqlConflictCandidates(...)`, and `findSqlDuplicateCandidates(...)` preserving exact email/domain/phone-last-9/company-number/initial/`pg_trgm`/Metaphone/corporate-group/historical-link recall.
   - `core/src/tenancy/intakeQuoteRepository.ts`:
     - Separate `hasRestrictedMatterAccess` (`matter:restricted:access`) from `includeRestricted` (`system/service internal`) in `ENQUIRY_VISIBLE_SQL_PREDICATE` (`:779-792`) and `QUOTE_VISIBLE_SQL_PREDICATE` so `matter:restricted:access` never bypasses personal-`Draft` privacy;
     - Add `getQuoteByIdOrReference`, `listVisibleEnquiriesPage`, `listVisibleQuotesPage`, and `findSqlConflictEnquiryCandidates`.
   - `core/src/tenancy/taskWorkflowRepository.ts`: add `listTasksLinkedToRecord`, `countUrgentBadgeTasksForUser`, and targeted notification/task readers.
   - `core/src/tenancy/pmsRepository.ts`: add SQL-scoped queries (`listFeeEarnersOnly`, `getMatterPmsDataByCode`, `getClientPmsDataByCodes`, `getFeeEarnerTimeSummary`, `getMatterFinanceSummaryRows`, `getFirmFinanceRollupsSql`) eliminating `loadTenantPmsSnapshot` (`:2185`) from request paths.
2. **Server service, finance, docgen, docstore & extract conversion (`src/server/`, `src/app/api/matters/extract/route.ts`):**
   - `src/server/services.ts`:
     - Remove hidden `putQuote` write-on-read in `getAppSnapshotInScope` (`:2171-2187`) (compute effective expired display status read-only and leave mutation to explicit/scheduled expiry transitions), and switch `getAppSnapshotInScope` internally onto SQL `listVisible*` queries without changing the page/layout prop contract needed until `S1-02b`.
     - Add `loadScopedVisibilityContext` and convert all server-side call sites in rows `1–3`, `5–24`, `26–34`, `36`, `44` (manual single-enquiry anonymisation), all 6 conflict search paths, `findCandidateDuplicatesForRecord`, and ~35 employee-only RBAC checks (`employeesAndLeaversOnly`).
   - `src/server/financeServices.ts`: convert `verifyFinanceActorAndPermission` (`:216`) and its callers (`getFirmFinance`, `getMatterFinanceRows`, `getMyFinanceFigures`, `getMatterPmsViewBundle`, `getClientPmsViewBundle`, `getPmsAdminSnapshot`) to SQL joins (`pms_links × matters`) and targeted `TenantPmsRepository` queries.
   - `src/server/documentGenerationServices.ts` (`:831`), `src/server/documentStoreServices.ts` (`:297-298, :867`), and `src/app/api/matters/extract/route.ts` (`:2233, :2425`): convert to targeted record lookups + SQL candidate queries.
3. **Monotonically shrinking AST guard test (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`):**
   - Build a TypeScript AST guard scanning `src/app/`, `src/components/`, and `src/server/` for whole-tenant calls (`listAllMattersUnfiltered`, `listAllEnquiriesUnfiltered`, `listAllQuotesUnfiltered`, `listAllTasksUnfiltered`, `listAllSignOffsUnfiltered`, `loadTenantPmsSnapshot`, unfiltered `listAllPeople` / `listAllOrganisations`, `getAppSnapshot`, and client-side `useMemo` duplicate/conflict loops).
   - Model `PERMANENT_ALLOW_LIST` (`MAX_PERMANENT_ALLOW_LIST_COUNT = 12` justified batch/job/seed entries, each with an inline reason and explicit `callees`) separately from `TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST` (`MAX_TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST_COUNT = 7` confined to `B22`) and `DEFERRED_S1_02B_ALLOW_LIST` (`MAX_DEFERRED_S1_02B_BASELINE_COUNT = 38`), matching the Stage 0 `actionPermissionGuard.test.ts` `MAX_KNOWN_GAPS` pattern so CI fails immediately if any slice introduces a new whole-tenant call or enlarges the baseline.
   - Enforce `MAX_DEFERRED_S1_02B_BASELINE_COUNT = 38` (up from initial `37` estimate solely because `listAllVisibleKeyDates` was added to `TARGET_WHOLE_TENANT_CALLEES`, catching an existing `getAppSnapshotInScope` call rather than introducing a regression), plus `MAX_PERMANENT_ALLOW_LIST_COUNT = 12` and `MAX_TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST_COUNT = 7` (`B22`) in `src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`: **zero** non-`getAppSnapshotInScope`, non-conflict-graph server sites remain (`25` layout/page `getAppSnapshot` calls + `6` component client-scan calls + `7` `getAppSnapshot`/`getAppSnapshotInScope` sites deferred to `S1-02b`).
   - **Developer note (migrations `0023` & `0024`):** Because migrations `0023` and `0024` were updated in place during WP1 fixes (altering their computed checksums), local and test databases that already applied an earlier `0023`/`0024` must be reset (`drop` + `node scripts/setup-test-postgres.mjs`).

## Tests

*(Record fail-first evidence before converting paths in `Stage1-WP1-report.md`.)*

1. **AST guard test (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`):**
   - Fail-first when run against initial code (discovering all ~`41` `listAllMattersUnfiltered` sites, `layout.tsx`, `22` pages, and `5` UI forms), ratcheted down as `S1-02a` converts every server service/finance/docgen/docstore/extract site to `0` non-snapshot server sites.
2. **Migration round-trip test (`core/tests/migrations-postgres.test.ts`):**
   - Test `0024` `up -> down -> up` reversibility cleanly after `0023`.
3. **Candidate parity, Draft privacy & two-tenant PostgreSQL isolation tests (`core/tests/scoped-queries-s102a.test.ts`, plus `isolation.test.ts`, `clients-contacts-parties-s021.test.ts`, `pms-postgres.test.ts`):**
   - Assert exact match/redaction parity (`searchMatterConflicts`, `runEnquiryConflictSearch`, `findCandidateDuplicatesForRecord`, `savePersonRecord`, `saveOrganisationRecord`, `saveMatterRecord`, `markQuoteSentRecord`, `closeEnquiryRecord`, `signOffMatterCostsRecord`, `verifyFinanceActorAndPermission`, `listRegistersWorkspaceDataRecord`, `loadMatterByIdForAccessCheck`, `POST /api/matters/extract`) — specifically testing Trigram typos, Metaphone sound-alikes, phone last-9 matches, subsidiary/parent corporate group traversals, and historical link hits across two real PostgreSQL tenants (`tenant-alpha` vs `tenant-bravo`).
   - Verify `hasRestrictedMatterAccess` (`matter:restricted:access`) can inspect restricted-matter-linked enquiries/quotes while still refusing another user's personal `Draft` enquiry.
   - Verify tampered cross-tenant record IDs and forged `TenantContext` claims fail closed (`NOT_FOUND` / `TENANCY_FORGERY_DETECTED`).

## Help and documentation (rule 11)

- `src/docs/articles/development-process.ts` & `deployment-and-security.ts`: document server-side SQL-scoped repository queries, the request-path AST guard (`B15` server phase), `employeesAndLeaversOnly` / Draft privacy hardening, and accurate `S1-D12` boundary (`S1-09` pending, `R691`, `R692`, `R694`).
- `docs/roadmap/feature-list.md`: update `B15` (`Partly built` — server-side converted, page loaders & UI form scans remaining for `S1-02b`), plus items `1`–`4`, `28`, `33`, `P2`, `P8`, `P10`.
- `docs/release-notes.md`: add `S1-02a` entry under `Unreleased`.

## Acceptance criteria

- Zero server-side request paths (`services.ts`, `financeServices.ts`, `documentGenerationServices.ts`, `documentStoreServices.ts`, `extract/route.ts`) call whole-tenant loaders outside `PERMANENT_ALLOW_LIST` (`MAX_PERMANENT_ALLOW_LIST_COUNT = 12`), `TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST` (`MAX_TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST_COUNT = 7`, `B22`), and `DEFERRED_S1_02B_ALLOW_LIST` (`MAX_DEFERRED_S1_02B_BASELINE_COUNT = 38` reserved for `S1-02b`).
- `putQuote` write-on-read in `getAppSnapshotInScope` is removed and `ENQUIRY_VISIBLE_SQL_PREDICATE` keeps personal `Draft` enquiries private from `matter:restricted:access` holders.
- AST guard, migration `0024` round-trip, two-tenant candidate-parity + isolation tests, `npx tsc --noEmit`, `npm run lint`, and `npx vitest run isolation` all pass cleanly.

## Manual blockers

- Running `caj-migrate-demo` in Azure when deploying WP1 (`0024`; Stage 1 plan §8).

## Rollback

- Expand migration `0024` drops cleanly via `downSql`; revert `s1-02a-scoped-queries-server` and execute `downSql` for `0024` (leaving `0023` intact).

## Pull request description must state

- **Change class:** Core tenancy SQL query expansion (`core/src/tenancy/`, reversible migration `0024`) and Host server/service/finance SQL-scoping refactor (`B15` part 1, server side).
- **Both hosting models:** Identical per-tenant PostgreSQL execution over `SET LOCAL ROLE` across Model A (`single_tenant`) and Model B (`multi_tenant`); zero tenancy-mode branches.
- **Migration and rollback:** Additive expand migration `0024` (`CORE_REQUIRED_SCHEMA_VERSION = '0024'`, `dependsOn: ['0009', '0018']`) with tested `downSql`; reversible via `downSql` + `git revert`.
