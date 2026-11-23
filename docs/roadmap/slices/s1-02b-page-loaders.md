# S1-02b: B15 Page Side — Per-Route Page Loaders, Debounced Form Previews, and Guard Closure

| | |
|---|---|
| Backlog | `B15`, `B22`, `P8`, `P10` |
| Decision | Stage 1 plan `S1-02b` (`B15`), owner decisions `A1` (`B22`) & `A3` (`38` baseline), [ADR 0014](../../decisions/0014-staff-matter-access-by-permission.md), [ADR 0028](../../decisions/0028-tenant-database-and-repositories.md) |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP1b (`S1-02b`) |
| Branch | `s1-02b-page-loaders`, from `develop` (`bd73f60`), targeting `develop` |
| Change class | Host page/layout data loaders (`src/server/pageLoaders.ts`), Next.js App Router layout & route-group split (`src/app/`), scoped PostgreSQL repository readers (`core/src/tenancy/`), debounced server preview/picker actions & action-guard registration (`src/server/`, `src/app/actions.ts`), UI form/component narrowing (`src/components/`), AST guard final ratchet (`MAX_DEFERRED_S1_02B_BASELINE_COUNT = 0`) |
| Layer | Core tenancy read helpers (`core/src/tenancy/`) + Host application (`src/`) |
| Size | M–L |
| Depends on | `S1-02a` (`WP1`, merged to `develop` at `bd73f60`) |
| Blocking manual tasks | None (demo redeploy after WP1b merge follows Stage 1 plan §8) |
| Baseline | `develop` at `bd73f60` (plus Part B roadmap commit on `s1-02b-page-loaders`) |

## What exists today on `develop` (`bd73f60`)

After WP1 (`S1-01`, `S1-03`, `S1-02a`, `S1-10`) merged into `develop`, `src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts` records **`MAX_DEFERRED_S1_02B_BASELINE_COUNT = 38`** (`38` exact deferred findings):

1. **`25` `src/app/` `getAppSnapshot` call sites (`layout.tsx` + `24` `page.tsx` routes, not `22`):**
   - Shell layout: `src/app/layout.tsx:51` wraps every route (including `/docs`, `/docs/[slug]`, and `/login`) in `withPageActor` + `getAppSnapshot(actor.personId)`.
   - All `24` data-backed `page.tsx` routes call `withPageActor` + `getAppSnapshot(...)` a second time, doubling per-request actor + snapshot DB work (`50` non-transaction domain queries per single `getAppSnapshot` call; **`215`** non-tx domain queries / `659` SQL calls on Home `/` and **`188`** / `576` on Matters `/matters` for Partner `P-000001`):
     - Home: `src/app/page.tsx`
     - Admin: `src/app/admin/[[...slug]]/page.tsx`
     - Enquiries: `src/app/enquiries/page.tsx`, `enquiries/new/page.tsx`, `enquiries/[id]/page.tsx` *(still reads whole-tenant `keyDates*` as well)*
     - Key Dates: `src/app/key-dates/page.tsx`
     - Matters: `src/app/matters/page.tsx`, `matters/new/page.tsx`, `matters/[id]/page.tsx`, `matters/[id]/edit/page.tsx`
     - Organisations: `src/app/organisations/page.tsx`, `organisations/new/page.tsx`, `organisations/[id]/page.tsx`, `organisations/[id]/edit/page.tsx`
     - People: `src/app/people/page.tsx`, `people/new/page.tsx`, `people/[id]/page.tsx`, `people/[id]/edit/page.tsx`
     - Quotes: `src/app/quotes/new/page.tsx`, `quotes/[id]/page.tsx`
     - Registers: `src/app/registers/page.tsx` *(calls `getAppSnapshot` solely for `currentUserPermissions`)*
     - Tasks: `src/app/tasks/page.tsx`, `tasks/new/page.tsx`, `tasks/[id]/page.tsx`
2. **`6` AST-tracked component client-scan calls (`src/components/`, not `5`):**
   - `EnquiryFormClient.tsx:1142` (`runEnquiryConflictSearch`)
   - **`EnquiryProfileClient.tsx:230` (`runEnquiryConflictSearch`)** — the **6th** AST-tracked call site; dead code imported nowhere in `src/`, `core/`, or `e2e/` (`enquiries/[id]/page.tsx` renders `EnquiryFormClient`), to be removed cleanly
   - `HomeClient.tsx:474` (`findPersonDuplicates`)
   - `HomeClient.tsx:484` (`findOrganisationDuplicates`)
   - `OrganisationFormClient.tsx:410` (`findOrganisationDuplicates`)
   - `PersonFormClient.tsx:1002` (`findPersonDuplicates`)
   - *Additional browser scans not yet in `TARGET_CLIENT_SCAN_CALLEES` (also converted in S1-02b and added to the AST guard):* `detectPreliminaryConflicts` (`EnquiryFormClient.tsx:653`, `OrganisationFormClient.tsx:481`, `PersonFormClient.tsx:1083`, `QuoteFormClient.tsx:741`), `findEnquiryEntityMatches` (`5` call sites across `EnquiryFormClient`, `EnquiryProfileClient`, `OrganisationFormClient`, `PersonFormClient`, `QuoteFormClient`), and client-side fuzzy/array pickers (`MatterFormClient.tsx:3076`, `QuoteFormClient.tsx:500`, `TaskFormClient.tsx:138`, `TaskDetailClient`, `LinkModal`, and form `<select>` picklists).
3. **`7` `src/server/services.ts` calls inside `DEFERRED_S1_02B_ALLOW_LIST`:**
   - `getAppSnapshot` → `getAppSnapshotInScope`
   - `6` whole-tenant loaders inside `getAppSnapshotInScope`: `listAllPeople`, `listAllOrganisations`, `listAllLinks`, `listAllNotes`, `listAllMergeHistory`, and `listAllVisibleKeyDates`.
4. **Real `PERMANENT_ALLOW_LIST` (`MAX_PERMANENT_ALLOW_LIST_COUNT = 12`, unchanged `≤ 12`):**
   - Scheduled jobs (`guardedJob`): `executeKeyDateRemindersForTenant`, `executeRegisterRemindersForTenant`, `executeNotificationDigestsForTenant`, `runEnquiryRetentionAnonymisationForTenant` (bulk sweep only).
   - Admin / seed utilities: `rerunAutomaticPmsMatching`, `applyAdminTemplateAdditionsToOpenMatters`, `importFirmStoreModulesToPostgres`, `resetAllDemoData`.
   - Legacy PMS wrappers & firm SQL roll-ups / diary: `getTenantPmsSource`, `hydrateTenantPmsSource`, `getFirmFinance` (`getFirmFinanceRollupsSql`), `queryKeyDatesTeamDiaryRecord` (`listAllVisibleKeyDates`).
5. **`TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST` (`7` entries, backlog `B22`, owner decision `A1`):**
   - `loadFullConflictSearchGraph` and its `6` callers (`saveMatterRecord`, `runMatterConflictSearchRecord`, `updateMatterConflictRecord`, `saveEnquiryRecord`, `prepareEnquiryConversion`, `prepareQuoteConversionRecord`).
   - Remains in place until `B22`; S1-02b does **not** remove it and never places conflict paths on `PERMANENT_ALLOW_LIST`.

## Files and changes

1. **Scoped repository read helpers (`core/src/tenancy/`):**
   - `taskWorkflowRepository.ts`: add `countUrgentBadgeTasksForUser` (SQL count matching `countMyUrgentBadgeTasks`, enforcing `TASK_VISIBLE_SQL_PREDICATE` / `TASK_DRAFT_ONLY_SQL_PREDICATE` when `hasRestrictedMatterAccess: true`), support `hasRestrictedMatterAccess` + `limit` on `listNotificationsForUser` and `getRecentlyViewedForUser`, and add `linkedRecordIds?: readonly string[]` + `limit` on `listVisibleTasks`.
   - `partyRepository.ts`: add SQL-scoped `searchPeople` / `listPeoplePage` and `searchOrganisations` / `listOrganisationsPage` (supporting filtering, `includeMerged: false`, pagination, and counts without calling whole-tenant `listAllPeople` / `listAllOrganisations`).
   - `matterRepository.ts`: add SQL-visibility-scoped `listVisibleMattersForEntity` (filtering by `ids`, `clientIds`, `partyEntityIds`, `contactIds`, `sourceEnquiryIds`, `sourceQuoteIds`, `ownerPersonId`) using `buildMatterHiddenFromViewerSql` parity, plus optional `limit` on `searchVisibleMatters`.
   - `intakeQuoteRepository.ts`: extend `listVisibleEnquiries` and `listVisibleQuotes` with `linkedPersonId`, `linkedOrganisationId`, `convertedMatterId`, `search`, `limit`/`offset` filters, plus viewer visibility options on `listQuotesByIds`.
   - `keyDateRepository.ts`: add `listReminderStatesForKeyDateIds` and `listCalendarSyncsForKeyDateIds` (`WHERE tenant_id = $1 AND key_date_id = ANY($2::text[])`) so matter and enquiry key-date snapshots never trigger whole-tenant key-date scans.
   - `registerRepository.ts`: support `hasRestrictedMatterAccess` on `listVisibleRegisterRecords`.
   - `pmsRepository.ts` / `src/server/financeServices.ts`: eliminate any per-matter N+1 queries inside `getMatterFinanceRows` (currently issuing ~14–16 queries per matter across `pms_extract_metadata` / `pms_invoices` / `pms_fee_earners`) and inside shell `attention` loading so Home (`/`) and Matters (`/matters`) issue zero per-row queries.
2. **`React.cache` shell loader & Route Groups (`src/server/pageLoaders.ts`, `src/app/`):**
   - Keep `src/app/layout.tsx` bare (`<html>`, fonts, `<ToastProvider>` if needed, `{children}`) with zero DB calls and no `force-dynamic`.
   - Move authenticated workspace routes into `src/app/(app)/layout.tsx` calling `React.cache`-deduplicated `loadShellContext(entraSession)` (including `withPageActor`, slim user/role/left-rail state, `urgentTaskBadgeCount` via SQL, top notifications, SQL-scoped shell `attention` summary, and `demoUsers` only when `demoMode === true`).
   - Add `src/app/docs/layout.tsx` so `/docs` and `/docs/[slug]` load **zero** tenant entities (using only `getEntraSession()` cookie check if auth gating is needed, with clean navigation back to `/`).
   - Implement per-route SQL-scoped loaders in `src/server/pageLoaders.ts` across Home (`/`), Admin (tab-scoped so non-entity tabs don't load people/orgs/matters/enquiries), Enquiries (`list`, `new`, `[id]`), Key Dates, Matters (`list`, `new`, `[id]`, `[id]/edit`), Organisations (`list`, `new`, `[id]`, `[id]/edit`), People (`list`, `new`, `[id]`, `[id]/edit`), Quotes (`new`, `[id]`), Registers (`currentUserPermissions` without snapshot), and Tasks (`list`, `new`, `[id]`).
   - Preserve exact routing behaviour: `people/[id]` `ENQ-*` redirect, `quotes/[id]` and `matters/new` `id OR reference` lookup, `mergedIntoId` tombstone redirects, and uniform not-found responses across non-existent, hidden, and cross-tenant tampered IDs.
   - Remove whole-tenant props from client components (`HomeClient`, `MattersListClient`, `EnquiriesListClient`, `PeopleListClient`, `OrganisationsListClient`, `TasksListClient`, `AdminClient`, `MatterFormClient`, `MatterProfileClient`, `EnquiryFormClient`, `PersonFormClient`, `PersonProfileClient`, `OrganisationFormClient`, `OrganisationProfileClient`, `QuoteFormClient`, `QuoteDetailClient`, `TaskFormClient`, `TaskDetailClient`, `KeyDatesDiaryWorkspace`).
   - Remove dead `src/components/EnquiryProfileClient.tsx`.
   - Move `getAppSnapshot` / `getAppSnapshotInScope` out of `src/server/services.ts` into test-only helper `src/server/__tests__/testAppSnapshot.ts` (asserted unreachable from `src/app/`, `src/components/`, and request-path `src/server/`).
3. **Debounced server preview & entity-picker actions (`src/server/services.ts`, `src/app/actions.ts`, `src/server/actionPermissions.ts`):**
   - Add `previewIntakeDuplicatesAndConflictsAction` (`guardedAction`, policy `{ kind: 'permission', key: { anyOf: ['enquiry:create', 'enquiry:edit', 'contact:create', 'contact:edit', 'quote:edit', 'matter:create', 'matter:edit'] }, enforcedBy: 'action' }`):
     - Read-only `previewIntakeDuplicatesAndConflictsRecord`: duplicate & known-entity checks run SQL-scoped (`findSqlDuplicateCandidates`, SQL enquiry candidate filtering by `canViewEnquiry`), and conflict checks reuse the existing conflict search path (`loadFullConflictSearchGraph` + `runEnquiryConflictSearch` filtered by `canViewEnquiry` & `canViewMatter` + `redactRecordId`) for identical results. Adds **exactly 1** entry to `TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST`, tagged `B22`, raising `MAX_TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST_COUNT` from **`7` to `8`**.
     - Client forms debounce duplicate/entity previews at `250`–`300` ms, trigger conflict previews **only** at debounce `≥ 600` ms with `≥ 3` name characters or on blur, and cancel stale requests / ignore late responses.
   - Add `searchEntityPickerAction` (`guardedAction`, `{ kind: 'authenticated' }` since underlying SQL searches enforce RBAC + visibility predicates per entity), backing `MatterFormClient`, `QuoteFormClient`, `TaskFormClient`, `TaskDetailClient`, `LinkModal`, `EnquiryFormClient` (refer-out), `PersonFormClient` (org link), and `OrganisationFormClient` (parent org).
   - Register both in `ACTION_PERMISSIONS` (`124 → 126`, keeping `MAX_KNOWN_GAPS = 0`).
4. **AST guard closure (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`):**
   - Set `DEFERRED_S1_02B_ALLOW_LIST = []` and `MAX_DEFERRED_S1_02B_BASELINE_COUNT = 0`.
   - Keep `PERMANENT_ALLOW_LIST.length <= MAX_PERMANENT_ALLOW_LIST_COUNT` (`12`).
   - Raise `MAX_TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST_COUNT` to `8` (`B22`, with the 1 C2 entry).
   - Expand `TARGET_CLIENT_SCAN_CALLEES` to also forbid `detectPreliminaryConflicts` and `findEnquiryEntityMatches` in `src/components/`.
   - Assert `getAppSnapshot` / `getAppSnapshotInScope` are unreachable from `src/app/`, `src/components/`, and request-path `src/server/`.

## Tests

*(Record fail-first evidence, guard counts, and before/after Home + Matters query counts in `C:\1Squared\PlanReviews\Stage1-WP1b-report.md`.)*

1. **AST & action guard (`noWholeTenantLoadInRequestPaths.test.ts`, `actionPermissionGuard.test.ts`):** fail-first ratchet at `0` deferred sites, `MAX_KNOWN_GAPS = 0` (`126` actions), `getAppSnapshot` unreachable in request paths.
2. **Two-tenant PostgreSQL (`core/tests/page-loaders-s102b.test.ts`):** `loadShellContext`, matters/enquiries/people/organisations/quotes/tasks/registers loaders, staff-matter & personal-draft privacy, uniform tampered-ID / hidden-ID not-found, forged tenant claims, `previewIntakeDuplicatesAndConflictsAction` (restricted redaction, non-leakage, exact parity with `saveEnquiryRecord` / `runEnquiryConflictSearch`), `searchEntityPickerAction` (visibility & forged claims).
3. **E2E (`e2e/role-journeys.spec.ts`):** all `11` existing journeys plus `2` new journeys (Lowri creating a duplicate contact and seeing `"Possible duplicate detected"`; preliminary conflict hit on `/enquiries/new`), run under `npx playwright test --reporter=line --global-timeout=900000`.
4. **Full `npm run ci`** once on branch tip.

## Help and docs (rule 11 & Stage 1 §6 rule 6)

- Update `src/docs/articles/development-process.ts` and `deployment-and-security.ts` in **plain British English for firm users** (zero code identifiers, migration numbers, or internal symbols).
- Update `docs/release-notes.md` and `docs/roadmap/feature-list.md` (`B15` → `Completed` once `MAX_DEFERRED_S1_02B_BASELINE_COUNT === 0` and all tests pass, plus `P8` and `P10`).

## Acceptance criteria

- Zero `getAppSnapshot` / `getAppSnapshotInScope` calls in `src/app/`, `src/components/`, or request-path `src/server/`; `/docs` loads zero tenant entities; `layout` + `page` never duplicate shell loading.
- All `6` AST-tracked client scans plus `detectPreliminaryConflicts` / `findEnquiryEntityMatches` / browser client-scan pickers use debounced SQL/conflict server actions with stale-request cancellation and unchanged duplicate/conflict UX.
- `MAX_DEFERRED_S1_02B_BASELINE_COUNT = 0`, `MAX_PERMANENT_ALLOW_LIST_COUNT = 12`, `MAX_TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST_COUNT = 8` (`B22`), `MAX_KNOWN_GAPS = 0`.
- `npm run ci` and `npx playwright test --reporter=line --global-timeout=900000` pass cleanly, with zero per-row N+1 queries on Home and Matters loaders.

## Pull request description (when owner later asks)

- **Change class:** Host per-route page loaders, Route Group shell split, scoped `core/src/tenancy/` readers, debounced preview/picker actions (`1` `B22` `TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST` addition `7 → 8`), UI narrowing, and AST guard closure (`MAX_DEFERRED_S1_02B_BASELINE_COUNT = 0`).
- **Both hosting models:** Identical across Model A (`single_tenant`) and Model B (`multi_tenant`); all loaders and actions scope strictly to verified `TenantContext`.
- **Migration and rollback:** No database migration (`CORE_REQUIRED_SCHEMA_VERSION` stays `0024`); revert cleanly via `git revert`.
