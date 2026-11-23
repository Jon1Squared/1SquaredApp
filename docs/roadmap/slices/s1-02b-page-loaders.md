# S1-02b: B15 Page Side — Per-Route Page Loaders, Debounced Form Previews, and Guard Closure

| | |
|---|---|
| Backlog | `B15`, `P8`, `P10` |
| Decision | Stage 1 plan `S1-02b` (`B15`), [ADR 0014](../../decisions/0014-staff-matter-access-by-permission.md), [ADR 0028](../../decisions/0028-tenant-database-and-repositories.md) |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP1b (`S1-02b`) |
| Branch | `s1-02b-page-loaders`, from `develop` (after `WP1` merges), targeting `develop` |
| Change class | Host page/layout data loaders, debounced server preview/picker actions & action-guard registration (`src/server/`, `src/app/`), UI form refactoring (`src/components/`), AST guard final ratchet (`BASELINE_TO_SHRINK = 0`) |
| Layer | Host application (`src/`) |
| Size | M |
| Depends on | `S1-02a` (`WP1`) |
| Blocking manual tasks | None (or redeploy demo after WP1b merge per Stage 1 plan §8) |
| Baseline | `develop` after `WP1` merges |

## What exists today (after `S1-02a`)

After `S1-02a` converts all server write/finance/docgen/docstore/extract paths, the remaining whole-tenant request-path baseline consists exclusively of page hydration and client-side form scans:

1. **Shell & route double-loading (`src/app/layout.tsx:51`, `22` `src/app/**/page.tsx` routes, `src/server/services.ts:getAppSnapshot`):**
   - `layout.tsx:51` calls `getAppSnapshot(actor.personId)` on every request (even `/docs`, and `src/app/registers/page.tsx:20` calls it solely for `currentUserPermissions`), and `22` of `25` `page.tsx` routes call `getAppSnapshot(...)` a second time, serialising broad tenant state to RSC client components.
2. **Five browser `useMemo` whole-tenant scans (`src/components/`):**
   - `EnquiryFormClient.tsx:620-675` (`detectPreliminaryConflicts` + duplicate scan across `people`, `organisations`, `matters`, `enquiries`)
   - `PersonFormClient.tsx:988-1069` (duplicate candidate `useMemo` over whole-tenant `people` + `links`)
   - `OrganisationFormClient.tsx:410-481` (duplicate + subsidiary checks over whole-tenant `organisations`)
   - `QuoteFormClient.tsx:720-741` (client/enquiry/matter picklists & duplicate/conflict preview)
   - `HomeClient.tsx:474-484` (Home quick-search / entity preview scans)
3. **AST guard baseline (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`):**
   - Contains `getAppSnapshotInScope`, `layout.tsx:51`, the `22` `page.tsx` callers, and the `5` `useMemo` client scans inside `BASELINE_TO_SHRINK`.

## Files and changes

1. **Per-route server page loaders (`src/server/pageLoaders.ts`):**
   - Implement `React.cache`-deduplicated `loadShellContext(actorId)` (used by `src/app/layout.tsx` and child server pages, loading only acting user persona, teams/permissions summary, badge counts via `countUrgentBadgeTasksForUser`, recently-viewed IDs, and demo switcher list when enabled).
   - Implement narrow SQL-scoped page loaders for every route currently calling `getAppSnapshot`:
     - Home (`/`)
     - Enquiries (`list`, `new`, `[id]`)
     - Matters (`list`, `new`, `[id]`, `[id]/edit`)
     - People (`list`, `new`, `[id]`, `[id]/edit`)
     - Organisations (`list`, `new`, `[id]`, `[id]/edit`)
     - Quotes (`list`/`new`, `[id]`)
     - Tasks (`list`, `new`, `[id]`)
     - Key Dates, Registers (passes `currentUserPermissions` + matter/register slice cleanly without snapshot), Admin (tab-scoped), and `/docs` (zero entity loading).
   - Narrow client component prop types so pages send only visible/needed slices, reference picklists, or initial search results.
2. **Debounced server preview & entity-picker actions (`src/server/services.ts`, `src/app/actions.ts`, `src/server/actionPermissions.ts`):**
   - Add `previewIntakeDuplicatesAndConflictsAction` (`guardedAction`, permission-checked on `enquiry:create` / `contact:create` / `matter:create` as appropriate, redacting restricted matter hits via `redactRecordId`) and `searchEntityPickerAction` (`guardedAction`, SQL-scoped `searchPeople`/`searchOrganisations`/`searchMatters` picklists with visibility predicates).
   - Register both new actions in `ACTION_PERMISSIONS` (`src/server/actionPermissions.ts`), updating `src/server/__tests__/actionPermissionGuard.test.ts` expected count cleanly with `MAX_KNOWN_GAPS = 0`.
3. **App routes & 5 UI forms (`src/app/layout.tsx`, `22` `src/app/**/page.tsx` files, `EnquiryFormClient.tsx`, `PersonFormClient.tsx`, `OrganisationFormClient.tsx`, `QuoteFormClient.tsx`, `HomeClient.tsx`):**
   - Replace `getAppSnapshot` calls in `layout.tsx` and all `22` `page.tsx` routes with `src/server/pageLoaders.ts`.
   - Replace the 5 `useMemo` whole-tenant scans with debounced calls (`250ms`–`300ms`, cancelling stale responses cleanly) to `previewIntakeDuplicatesAndConflictsAction` / `searchEntityPickerAction`.
   - Deprecate/limit `getAppSnapshot` strictly to test helpers (outside request paths, or remove from `BASELINE_TO_SHRINK`).
4. **AST guard closure (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`):**
   - Shrink `BASELINE_TO_SHRINK` to **`0`** (`MAX_BASELINE_COUNT = 0`), leaving **only** `PERMANENT_ALLOW_LIST`:
     - `executeKeyDateRemindersForTenant` (scheduled job `guardedJob('key-date-reminders')`)
     - `executeRegisterRemindersForTenant` (scheduled job `guardedJob('register-reminders')`)
     - `executeNotificationDigestsForTenant` (scheduled job `guardedJob('notification-digests')`)
     - `runEnquiryRetentionAnonymisationForTenant` scheduled bulk sweep (scheduled job `guardedJob('enquiry-retention-anonymise')`)
     - `rerunAutomaticPmsMatching` (explicit admin whole-tenant PMS matching batch)
     - `applyAdminTemplateAdditionsToOpenMatters` (explicit admin bulk folder-provisioning batch)
     - `importFirmStoreModulesToPostgres` and `resetAllDemoData` (explicit seed/demo reset utilities)

## Tests

*(Record fail-first evidence and guard baseline shrinkage in `Stage1-WP1b-report.md`.)*

1. **AST guard test (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`):**
   - Asserts `BASELINE_TO_SHRINK` has `length === 0` and fails if any `src/app/`, `src/components/`, or request-path `src/server/` file calls `getAppSnapshot`, `listAll*Unfiltered`, `loadTenantPmsSnapshot`, or client-side whole-tenant scans outside `PERMANENT_ALLOW_LIST`.
2. **Action guard & preview two-tenant isolation tests (`src/server/__tests__/actionPermissionGuard.test.ts`, `core/tests/page-loaders-s102b.test.ts`):**
   - `actionPermissionGuard.test.ts` passes with updated action count and `MAX_KNOWN_GAPS = 0`.
   - Two-tenant PostgreSQL tests for `loadShellContext`, key `pageLoaders.ts` loaders (`registers`, `matters`, `enquiries`, `people`, `organisations`, `quotes`), `previewIntakeDuplicatesAndConflictsAction` (verifying restricted-matter redaction + denied-user non-leakage), and `searchEntityPickerAction` (including forged claim and tampered ID rejection).
3. **End-to-end Playwright journeys (`e2e/role-journeys.spec.ts`):**
   - All 11 Playwright role journeys + full `npm run ci` pass without regression after removing whole-tenant props and converting the 5 UI form scans.

## Help and documentation (rule 11)

- `src/docs/articles/development-process.ts` & `deployment-and-security.ts`: note per-page scoped route loaders (`B15` completed) and `MAX_BASELINE_COUNT = 0` request-path guard.
- `docs/roadmap/feature-list.md`: update `B15` to **`Completed`** (`MAX_BASELINE_COUNT = 0`), plus `P8` and `P10`.
- `docs/release-notes.md`: add `S1-02b` entry under `Unreleased`.

## Acceptance criteria

- `layout.tsx` and all `22` `page.tsx` routes load solely via `src/server/pageLoaders.ts` with zero `getAppSnapshot` calls and zero double-loading.
- All 5 browser `useMemo` whole-tenant scans run via permission-checked debounced server preview/picker actions.
- `noWholeTenantLoadInRequestPaths.test.ts` locks `BASELINE_TO_SHRINK = []` (`MAX_BASELINE_COUNT = 0`), leaving only the documented `PERMANENT_ALLOW_LIST`.
- Full `npm run ci` and `npm run e2e` pass cleanly.

## Manual blockers

- None in code (demo redeploy after `WP1b` merge follows Stage 1 plan §8).

## Rollback

- Zero database migrations (`CORE_REQUIRED_SCHEMA_VERSION` unchanged); revert `s1-02b-page-loaders` cleanly via `git revert`.

## Pull request description must state

- **Change class:** Host per-route page loaders, debounced server preview/picker actions, and UI form refactor (`B15` part 2, page side).
- **Both hosting models:** Identical across Model A (`single_tenant`) and Model B (`multi_tenant`); all loaders and preview actions scope strictly to verified `TenantContext`.
- **Migration and rollback:** No database migration; `git revert` restores prior loaders cleanly.
