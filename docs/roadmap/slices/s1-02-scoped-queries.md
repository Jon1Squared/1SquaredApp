# S1-02: B15 — Per-Page and SQL-Scoped Queries (Eliminate Whole-Tenant Request-Path Loads)

| | |
|---|---|
| Backlog | `B15`, items `1`, `1a`, `2`, `3`, `4`, `28`, `33`, `P2`, `P8`, `P10` |
| Decision | Stage 1 plan `S1-02` (`B15`), [ADR 0014](../../decisions/0014-staff-matter-access-by-permission.md), [ADR 0028](../../decisions/0028-tenant-database-and-repositories.md), [ADR 0029](../../decisions/0029-finance-data-delivery.md) |
| Stage plan | `docs/roadmap/stage-1-plan.md`, WP1 (`S1-02`) |
| Branch | `s1-02-scoped-queries`, stacked on `s1-01-quick-fixes`, targeting `develop` |
| Change class | Core tenancy repository SQL query expansion & optional expand indexes (`core/src/tenancy/`) + Host page loaders, services & debounced preview actions (`src/server/`, `src/app/`, `src/components/`) |
| Layer | Core tenancy layer (`core/src/tenancy/`) + Host server/UI layer (`src/`) |
| Size | L |
| Depends on | `S1-01` (stacking order for WP1) |
| Blocking manual tasks | Executing `caj-migrate-demo` in Azure when deploying WP1 (only if an optional expand index migration `0023` is added) |
| Baseline | `develop` at `7c2ba3e` |

## What exists today

Checked against `develop` (`7c2ba3e`):

1. **`getAppSnapshot` & double loading across `layout.tsx` + 22 pages (`src/server/services.ts:1711-2381`, `src/app/layout.tsx:51`):**
   - `layout.tsx:51` calls `getAppSnapshot(actor.personId)` on every request, and `22` of `25` `page.tsx` routes call `getAppSnapshot(...)` a second time. Even `/docs` triggers `layout.tsx:51`, and `src/app/registers/page.tsx:20` calls `getAppSnapshot` solely to read `currentUserPermissions`.
   - Each call loads `loadTenantCatalogueStoreView` (including a whole-PMS `getTenantPmsSource` at `:983` when `matter_costs` config is absent), ten unfiltered table loads (`listAllPeople`, `listAllOrganisations`, `listAllLinks`, `listAllNotes`, `listAllMergeHistory`, `listAllMattersUnfiltered`, `listAllEnquiriesUnfiltered`, `listAllQuotesUnfiltered`, `listAllTasksUnfiltered`, `listAllSignOffsUnfiltered`), all Key Dates tables, a second whole-PMS `getTenantPmsSource` at `:2055`, and mutates expired quotes via `putQuote` (`:2171-2187`).
   - Five client forms (`EnquiryFormClient.tsx:620-675`, `PersonFormClient.tsx:988-1069`, `OrganisationFormClient.tsx:410-481`, `QuoteFormClient.tsx:720-741`, `HomeClient.tsx:474-484`) run duplicate and preliminary conflict matching in browser `useMemo` over whole-tenant props.
2. **Existing SQL-scoped methods sit unused (`core/src/tenancy/`):**
   - `TenantMatterRepository.listVisibleMatters` (`:1642-1707`) and `TenantIntakeQuoteRepository.listVisibleEnquiries` (`:1290-1342`) / `listVisibleQuotes` (`:1687-1725`) and `TenantTaskWorkflowRepository.listVisibleTasks` (`:977-1045`) already exist, yet have **zero** production request-path callers in `src/`.
   - **Subtlety in `ENQUIRY_VISIBLE_SQL_PREDICATE` (`intakeQuoteRepository.ts:779-792`):** passing `includeRestricted: true` currently skips BOTH restricted-matter checks AND the personal `Draft` owner filter, whereas `visibility.ts:61-77` forbids `matter:restricted:access` holders from seeing another user's `Draft` enquiries. Separate `hasRestrictedMatterAccess` from `includeRestricted`.
3. **Complete inventory of all `40` non-test `listAllMattersUnfiltered` sites and unbounded loaders (with disposition):**

| # | `file:line` | Function | Target disposition (`Convert` vs `Allow-list` + reason) |
|---:|---|---|---|
| 1 | `src/server/services.ts:636` | `switchUserInDemoMode` | **Convert**: SQL check on restricted matters accessible to target persona (`idx_matters_tenant_restricted`) |
| 2 | `src/server/services.ts:1388` | `listAuditEntriesForRecord` | **Convert**: scoped single-record visibility (`listMattersUnfilteredByIdsOrSources`) + employee-only RBAC |
| 3 | `src/server/services.ts:1518` | `listFirmAuditEntriesPage` | **Convert**: load only records referenced by the `limit: 250` audit page |
| 4 | `src/server/services.ts:1758` | `getAppSnapshotInScope` | **Convert**: pages migrate to `src/server/pageLoaders.ts`; `getAppSnapshot` itself uses `listVisible*` SQL queries (`test` compatibility helper only) |
| 5 | `src/server/services.ts:2411` | `getEmployeeDetailsForUser` | **Convert**: `listMattersUnfilteredByIdsOrSources({ ids: rawEmployment.supervisionMatterIds })` |
| 6 | `src/server/services.ts:2621` | `reassignLeaverOwnedRecords` | **Convert**: SQL `WHERE responsible_partner_id = $2 OR ...` targeted queries across matters/tasks/enquiries/orgs |
| 7 | `src/server/services.ts:2978` | `savePersonRecord` | **Convert**: affected matters only (`client_id`, `additional_client_ids`, `matter_parties`, audit targets) |
| 8 | `src/server/services.ts:4148` | `saveOrganisationRecord` | **Convert**: `getOrganisationById` + SQL duplicate candidates + employee-only RBAC (needs zero matters) |
| 9 | `src/server/services.ts:4606` | `addNoteToRecord` | **Convert**: `getMatterById` only when `recordType === 'matter'` |
| 10 | `src/server/services.ts:5853` | `saveMatterRecord` | **Convert**: targeted ID lookups + SQL conflict candidate subgraph |
| 11 | `src/server/services.ts:8446` | `runMatterConflictSearchRecord` | **Convert**: SQL conflict candidate subgraph (`searchMatterConflicts` unchanged) |
| 12 | `src/server/services.ts:8612` | `updateMatterConflictRecord` | **Convert**: SQL conflict candidate subgraph + matter-linked tasks (`listVisibleTasks`) |
| 13 | `src/server/services.ts:9007` | `signOffMatterCostsRecord` | **Convert**: `getMatterById` + single client/source enquiry/quote + matter-linked tasks |
| 14 | `src/server/services.ts:9600` | `executeMerge` | **Convert**: survivor + merged records, their links/notes, subsidiary orgs, and referencing matters only |
| 15–17 | `src/server/services.ts:12092, 12831, 12901` | `saveTaskRecord`, `takeTaskRecord`, `addTaskCommentRecord` | **Convert**: `loadScopedVisibilityContext` (`getTaskById` + linked IDs) |
| 18–23 | `src/server/services.ts:13329, 13970, 14119, 14227, 14377, 14519` | `saveEnquiryRecord` (`computeEnquiryConflictSnapshot`), `assignEnquiryRecord`, `logEnquiryContactRecord`, `sendEnquiryEmailRecord`, `closeEnquiryRecord`, `reopenEnquiryRecord` | **Convert**: `getEnquiryById` + `loadScopedVisibilityContext` + SQL conflict candidates (`saveEnquiryRecord`) + targeted notification count / SQL `EXISTS` (`closeEnquiryRecord`) |
| 24 | `src/server/services.ts:14661` | `prepareEnquiryConversion` | **Convert**: SQL conflict candidate subgraph for `runEnquiryConflictSearch` |
| 25 | `src/server/services.ts:15923` | `rerunAutomaticPmsMatching` | **Allow-list**: explicit whole-tenant admin PMS matching batch job |
| 26–27 | `src/server/services.ts:18110, 18273` | `deleteMatterPartyRelationship`, `deleteMatterPartyCapacity` | **Convert**: single SQL `COUNT(*)` against `public.matter_parties` |
| 28–32 | `src/server/services.ts:18443, 19025, 19105, 19218, 19595` | `saveQuoteRecord`, `markQuoteSentRecord`, `logQuoteFollowUpRecord`, `reviseQuoteRecord`, `recordQuoteOutcomeRecord` | **Convert**: `loadScopedVisibilityContext` via `getQuoteById` + `listMattersUnfilteredByIdsOrSources` |
| 33 | `src/server/services.ts:19715` | `prepareQuoteConversionRecord` | **Convert**: SQL conflict candidate subgraph for `searchMatterConflicts` + `runEnquiryConflictSearch` |
| 34 | `src/server/services.ts:20809` | `resolveKeyDatesActorAndData` (+ `src/server/services.ts:21672–22972`) | **Convert**: single `getMatterById` when `matterId` given; `listVisibleMatters` for diary/exceptions; linked tasks only on key-date mutations |
| 35 | `src/server/services.ts:23127` | `executeKeyDateRemindersForTenant` | **Allow-list**: unattended scheduled job (`guardedJob('key-date-reminders')`) |
| 36 | `src/server/services.ts:25871` | `listRegistersWorkspaceDataRecord` | **Convert**: `getMatterById` (when `filter.matterId` set) or `listVisibleMatters` |
| 37 | `src/server/services.ts:26867` | `executeRegisterRemindersForTenant` | **Allow-list** (scheduled job `guardedJob('register-reminders')`; narrow matters to candidate `matterId`s) |
| 38 | `src/server/services.ts:27559` | `executeNotificationDigestsForTenant` | **Allow-list** (scheduled job `guardedJob('notification-digests')`; narrow to IDs in `undigested`) |
| 39 | `src/server/financeServices.ts:216` | `verifyFinanceActorAndPermission` (used by `getFirmFinance`, `getMatterFinanceRows`, `getMyFinanceFigures`, `getMatterPmsViewBundle`, `getClientPmsViewBundle`, `getPmsAdminSnapshot`) | **Convert**: SQL join `pms_links` × `matters` + targeted SQL aggregates/queries on `TenantPmsRepository` |
| 40 | `src/server/documentGenerationServices.ts:831` | `getInitializedDocGenContext` | **Convert**: target matter/client on generate; referenced matters only on admin snapshot |
| 41 | `src/server/documentStoreServices.ts:867` | `loadMatterByIdForAccessCheck` (+ `:297-298` in `buildTenantContextForUser`) | **Convert**: `getMatterById(ctx, matterId, { includeRestricted: true })` and `getOrganisationById` only |
| 42 | `src/server/documentStoreServices.ts:2349` | `applyAdminTemplateAdditionsToOpenMatters` | **Allow-list**: explicit admin bulk folder-provisioning batch across open matters |
| 43 | `src/app/api/matters/extract/route.ts:2233, 2425` | `POST /api/matters/extract` (`ensureContactInCrm`, `enrichExtractionWithCrmMatches`) | **Convert**: filtered `listAllLinks` + SQL candidate matching |
| 44 | `src/server/storePostgresImport.ts:1096` | `importFirmStoreModulesToPostgres` (+ `resetAllDemoData` `:10605` & bulk `runEnquiryRetentionAnonymisationForTenant` `:15337`) | **Allow-list**: explicit seed/demo reset & scheduled anonymisation job (single-enquiry manual anonymisation converts to `getEnquiryById`) |

*(Plus ~35 sites calling `listAllPeople` solely for RBAC resolution -> replace with `listAllPeople(ctx, { includeLeaversFromHr: true, employeesOnly: true })` so client/contact `people` rows are never loaded on auth/RBAC paths, and move `searchVisibleMatters` filtering at `matterRepository.ts:1892-1918` into SQL `ILIKE`.)*

## Files and changes

1. **Core SQL-scoped repository methods & indexes (`core/src/tenancy/`):**
   - `core/src/tenancy/migrations/index.ts`: reversible expand migration `0023_scoped_lookup_and_candidate_indexes_expand` (`CORE_REQUIRED_SCHEMA_VERSION = '0023'`, `downSql` drops added columns/indexes cleanly) adding precomputed lookup tokens/arrays (`people.phone_last9_keys`, `people.phonetic_keys`, `organisations.email_domains`, `organisations.norm_company_number`, `organisations.phonetic_keys`) with GIN / B-tree indexes so fuzzy/phonetic duplicate & conflict candidate selection runs in indexed SQL with zero missed hits.
   - `core/src/tenancy/matterRepository.ts`: push `searchVisibleMatters` text search into SQL; add `listMatterIdsMatchingCandidateGraph(...)` for two-phase conflict candidate loading.
   - `core/src/tenancy/partyRepository.ts`: add `employeesAndLeaversOnly` flag on `listAllPeople` (covering `is_employee = TRUE OR EXISTS (SELECT 1 FROM employee_employment_records ...)`), `listPeopleByIds`, `listOrganisationsByIds`, `listLinksForEntities`, `listMergeHistoryForEntity`, `findSqlConflictCandidates(...)`, and `findSqlDuplicateCandidates(...)` preserving 100% of `normalise.ts` / `duplicates.ts` / `matterConflicts.ts` matching (email, domain, phone last-9, company number, initial, Damerau-Levenshtein via `pg_trgm`, Metaphone `phoneticKey`, corporate group recursive ancestors/descendants, historical links).
   - `core/src/tenancy/intakeQuoteRepository.ts`: separate `hasRestrictedMatterAccess` from `includeRestricted` in `ENQUIRY_VISIBLE_SQL_PREDICATE` / `QUOTE_VISIBLE_SQL_PREDICATE` (never leaking another user's personal `Draft`), add `getQuoteByIdOrReference`, `listVisibleEnquiriesPage`, `listVisibleQuotesPage`, and `findSqlConflictEnquiryCandidates`.
   - `core/src/tenancy/taskWorkflowRepository.ts`: add `listTasksLinkedToRecord`, `countUrgentBadgeTasksForUser`, and fix `TASK_VISIBLE_SQL_PREDICATE` edge cases.
   - `core/src/tenancy/pmsRepository.ts`: add SQL-scoped queries (`listFeeEarnersOnly`, `getMatterPmsDataByCode`, `getClientPmsDataByCodes`, `getFeeEarnerTimeSummary`, `getMatterFinanceSummaryRows`, `getFirmFinanceRollupsSql`) instead of executing 12 `SELECT *` queries in `loadTenantPmsSnapshot` on every finance call.
2. **Server page loaders & scoped helpers (`src/server/`):**
   - `src/server/pageLoaders.ts`: add `React.cache`-deduplicated `loadShellContext(actorId)` (for `layout.tsx`) plus narrow per-route loaders for Home, Enquiries (list/new/detail), Matters (list/new/detail/edit), People (list/new/detail/edit), Organisations (list/new/detail/edit), Quotes (new/detail), Tasks (list/new/detail), Key Dates, Registers, and Admin (tab-scoped).
   - `src/server/services.ts`:
     - Remove the hidden `putQuote` write-on-read in `getAppSnapshotInScope` (`:2171-2187`) — compute effective expired/follow-up display status read-only or transition cleanly on explicit/scheduled sweeps.
     - Add `loadScopedVisibilityContext`, employee-only RBAC loading, SQL `COUNT(*)` for party relationship/capacity deletion, two-phase SQL conflict/duplicate candidate loading across all 6 conflict paths and `findCandidateDuplicatesForRecord`, and debounced server actions (`previewIntakeDuplicatesAndConflictsAction`, `searchEntityPickerAction`) for UI forms.
   - `src/server/financeServices.ts`, `documentGenerationServices.ts`, `documentStoreServices.ts`: update all remaining request-path call sites in the table above to use SQL-scoped repository methods (`verifyFinanceActorAndPermission` uses SQL join `pms_links × matters`).
3. **App routes & UI forms (`src/app/layout.tsx`, `22` `src/app/**/page.tsx` routes, `EnquiryFormClient.tsx`, `PersonFormClient.tsx`, `OrganisationFormClient.tsx`, `QuoteFormClient.tsx`, `HomeClient.tsx`, `MatterFormClient.tsx`):**
   - Switch `layout.tsx` and all `22` `page.tsx` routes to `src/server/pageLoaders.ts` (keeping `src/app/actions.ts` `guardedAction` policies updated for any new preview/search actions).
   - Replace client-side `useMemo` whole-tenant scans with debounced server previews / picker search actions.

## Tests

*(Record fail-first evidence for the guard test and repository candidate queries in `Stage1-WP1-report.md`.)*

1. **Request-path guard test (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`):**
   - Fail-first: static/AST guard failing if any file in `src/app/`, `src/components/`, `src/server/` calls `listAllMattersUnfiltered`, `listAllEnquiriesUnfiltered`, `listAllQuotesUnfiltered`, `listAllTasksUnfiltered`, `listAllSignOffsUnfiltered`, `loadTenantPmsSnapshot`, or unfiltered `listAllPeople` / `listAllOrganisations`, outside an explicit documented allow-list (jobs, `rerunAutomaticPmsMatching`, `applyAdminTemplateAdditionsToOpenMatters`, `resetAllDemoData`, `importFirmStoreModulesToPostgres`, and test-compat `getAppSnapshot`).
2. **Migration round-trip test (`core/tests/migrations-postgres.test.ts`):**
   - Test `0023` `up -> down -> up` reversibility cleanly.
3. **Two-tenant & restricted-matter tests (`core/tests/scoped-queries-s102.test.ts` & existing `isolation.test.ts`, `clients-contacts-parties-s021.test.ts`, `pms-postgres.test.ts`):**
   - Assert exact behavioural & redaction parity (`searchMatterConflicts`, `runEnquiryConflictSearch`, `findCandidateDuplicatesForRecord`, `markQuoteSentRecord`, `closeEnquiryRecord`, `signOffMatterCostsRecord`, `verifyFinanceActorAndPermission`, `listRegistersWorkspaceDataRecord`, `loadMatterByIdForAccessCheck`) across two real PostgreSQL tenants (`tenant-alpha` vs `tenant-bravo`).
   - Verify `hasRestrictedMatterAccess` (`matter:restricted:access`) can inspect restricted-matter-linked enquiries/quotes while still refusing another user's personal `Draft` enquiry.
   - Verify tampered cross-tenant IDs and forged tenant claims reject (`NOT_FOUND` / `TENANCY_FORGERY_DETECTED`).
4. **End-to-end journey tests (`e2e/role-journeys.spec.ts`):** all 11 journeys stay green (`npm run ci` on top branch).

## Help and documentation (rule 11)

- `src/docs/articles/development-process.ts` & `deployment-and-security.ts`: note per-page scoped PostgreSQL queries (`B15`) and request-path guard check.
- `docs/roadmap/feature-list.md`: update `B15` (`Completed`), items `1`–`4`, `28`, `33`, `P2`, `P8`, `P10`, plus `R636` notification key follow-up if resolved here.
- `docs/release-notes.md`: add `S1-02` entry under `Unreleased`.

## Acceptance criteria

- `layout.tsx` and all `22` `page.tsx` routes call `src/server/pageLoaders.ts` (zero double-loading of `getAppSnapshot`), and `0` request-path whole-tenant calls remain outside the documented allow-list.
- Two-phase SQL conflict search and duplicate detection produce identical match/redaction output (`redactRecordId`) and pass all existing + new two-tenant PostgreSQL tests (`core/tests/isolation.test.ts`, `e2e/role-journeys.spec.ts`).

## Manual blockers

- Running `caj-migrate-demo` in Azure when deploying WP1 (only if migration `0023` is included; covered by standard stage plan §8 / `demo-deployment.md`).

## Rollback

- Expand migration `0023` is fully additive (`up -> down` tested); revert `s1-02-scoped-queries` and run `downSql` for `0023` if reverting schema.

## Pull request description must state

- **Change class:** Core tenancy SQL query expansion (`core/src/tenancy/`, reversible migration `0023`) and Host request-path loader/service refactoring (`B15`).
- **Both hosting models:** Identical per-tenant PostgreSQL execution over `SET LOCAL ROLE` (`Model A` and `Model B`); zero tenancy-mode branches.
- **Migration and rollback:** Additive expand migration `0023` (`CORE_REQUIRED_SCHEMA_VERSION = '0023'`) with tested `downSql`; reversible via `downSql` + `git revert`.
