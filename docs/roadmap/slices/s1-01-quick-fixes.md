# S1-01: Quick Fixes, Truth and Backlog (`B2`, Non-Engagement Task, `R371`, Backlog & Inventory Corrections)

| | |
|---|---|
| Backlog | Items `1`, `1a`, `2`, `5`, `6`, `33`, `34`; bugs `B2`, `B15`, `P5` (`R371` carry-over); plus `R636` clean-up |
| Decision | Stage 1 Plan §3 & `Stage1-WP1-prompt.md` (`S1-01`); [ADR 0009](../../decisions/0009-docx-library-and-pdf-conversion.md) (`client_care` generated template); [platform architecture standard](../../architecture-standard.md) §14 |
| Stage plan | `docs/roadmap/stage-1-plan.md`, WP1 (`S1-01`) |
| Branch | `s1-01-quick-fixes`, from `develop` (or `docs/stage-1-plan`), targeting `develop` |
| Change class | Core feature bug fix (host services, API route, UI forms & document generation service wiring), backlog & Help documentation (`core/src/api/`, `src/app/api/address-lookup/`, `src/domain/`, `src/server/`, `src/components/`, `src/docs/`, `docs/roadmap/`) |
| Layer | Core public API (`@platform/core-api` shared constant only) + Host application (`src/`) + Documentation (`docs/`) |
| Size | S (upper S) |
| Depends on | `–` |
| Blocking manual tasks | None |
| Baseline | `develop` at `7c2ba3e` (`b3bcce1` demo-deployed code baseline) |

## What exists today

Checked against `develop` (`7c2ba3e`):

1. **B2 (`Client Care Letter` vs `'client_care'` mismatch & missing server enforcement):**
   - `ensureSeedDocumentTemplatesInner` (`src/server/documentGenerationServices.ts:600`) seeds `TPL-SEED-CCL` with `outputDocumentType: 'client_care'`, and `DocumentTemplatesAdminPanel.tsx:905` renders `<option value="client_care">Client Care Letter</option>`.
   - `generateDocumentFromTemplate inner` (`core/src/domain/document-generation/generationService.ts:540`) copies `template.outputDocumentType` verbatim onto `GeneratedDocumentRecord.documentType` (`'client_care'`).
   - Meanwhile `MatterProfileClient.tsx:4530` checks `doc.documentType === 'Client Care Letter' && matter.engagementLetterStatus !== 'Signed'`, fires `void markEngagementLetterDraftedAction(matter.id)` unawaited before `router.refresh()` (`:4533-4536`), and the **Documents** tab `<DocumentListSection>` (`MatterProfileClient.tsx:2545-2553` -> `DocumentListSection.tsx:286-301`) never calls `markEngagementLetterDraftedAction` at all (`:298-300` only reloads the snapshot).
   - `generateDocumentService` (`src/server/documentGenerationServices.ts:1457-1590`) does not update `matter.engagementLetterStatus` on the server when a `'client_care'` document is generated for a matter.
   - `markEngagementLetterDrafted` (`src/server/services.ts:8171-8251`) only guards `if (existing.engagementLetterStatus === 'Signed')` (`:8225`), ignoring `'Signed & returned'` (`src/seed/demo.ts:1356, 1717, 2038`), `'Sent'`, `'Sent to client'`, `engagementLetterSentAt`, and `engagementLetterSignedAt`. `MatterFormClient.tsx:11820-11824` omits `'Drafted'` from its engagement-letter `<select>`, and `MatterProfileClient.tsx:248` omits `'Signed & returned'` when `engagementLetterSignedAt` is null.
   - **Stored templates/documents backfill check:** `public.document_templates.output_document_type` (`migrations/index.ts:70`) and `public.documents.document_type` (`:119`) already hold `'client_care'` for every seeded template (`TPL-SEED-CCL`) and every template built in the Admin UI (`DocumentTemplatesAdminPanel.tsx:905`), and `seed-not-a-law-firm.json` contains zero templates/documents. A stored row could only hold `'Client Care Letter'` if imported or uploaded via direct action call; standardising on `CLIENT_CARE_DOCUMENT_TYPE = 'client_care'` requires no backfill for seeded/UI rows (optionally add a safe one-line expand normalisation in the next DB migration only if legacy `'Client Care Letter'` imports exist in any tenant).
2. **`non_engagement_letter` automatic task never raised (`src/server/services.ts:13030-13249, 14358-14507`):**
   - `raiseAutomaticTask` (`services.ts:13030`) already handles `trigger === 'non_engagement_letter'` with `DEFAULT_TASK_SETTINGS` (`dueWorkingDaysOffset: 2`, `task_type.send_letter`, `Send non-engagement letter: {name}`), but only `'enquiry_contact'` (`:13863`) and `'complete_matter_opening'` (`:15152`) ever call it.
   - `closeEnquiryRecord` (`:14358-14507`) deletes orphan enquiry-only `people` rows inside its transaction at `:14469-14500`, returns `{ enquiry: enq }` without `nonEngagementTask`, and never calls `raiseAutomaticTask`.
   - `EnquiryProfileClient.tsx:352-356` unconditionally shows `raised 'Send non-engagement letter' task` whenever `mode` is `'Declined'` or `'Referred out'`, while `EnquiryFormClient.tsx:1263-1267` is a second close caller that never mentions any raised task; both also match the conflict close reason by `.label.toLowerCase() === 'conflict'` (`EnquiryProfileClient.tsx:401`, `EnquiryFormClient.tsx:1316`).
3. **`R371` (`/api/address-lookup` GET -> POST) & UI picker parity (`src/app/api/address-lookup/route.ts`):**
   - `route.ts:13-68` exports only `export const GET = guardedRoute('GET /api/address-lookup', ...)` reading `q` and `id` from `url.searchParams`.
   - `src/domain/addressLookup.ts:70-77, 144-150` uses `GET` with query parameters.
   - `FormControls.tsx:219-685` (`SingleAddressEditor`) and `EnquiryFormClient.tsx:2557-2645` already offer a multi-premise autocomplete picker, **but**:
     - `EnquiryFormClient.tsx:4511-4525` calls `handleFindAddress()` (`:942`) inside the manual edit modal, opening the picker behind the modal backdrop;
     - `PersonFormClient.tsx:1187-1244` (`handleFindAddress` for its manual `addressModalOpen` modal at `:5329-5345`) scans `allPeople`/`organisations` in memory by postcode and otherwise calls `searchAddressSuggestions`, picks **`lookup.suggestions[0]` (the first premise!)** at `:1230`, and immediately resolves it with no multi-premise picker.
4. **Backlog, inventory & Stage 1 plan §3 truth gaps:**
   - `docs/roadmap/feature-list.md`: row `5` claims generating+drafted is `"tested"` (only `markEngagementLetterDrafted` direct happy-path, restricted-matter denial, and `rowVersion` bump exist; no docgen/audit/non-regression/two-tenant tests); row `6` falsely claims `"Payment on account amount on quotes"` (quotes have zero payment-on-account fields); row `33` needs approver-per-barrier gap clarified; row `34` has stale `"lookupPostcode currently returns the first premise"` text and lacks the 5 deferred integration rows; rows `1`, `1a`, `2` still say `"Live Azure deployment awaits a manual task"`; `B15` only mentions `getAppSnapshot` rather than ~39 `listAllMattersUnfiltered` sites.
   - `docs/roadmap/functionality-inventory.md`: line `111` falsely says generating a Client Care Letter marks it drafted (`[Real]`); line `138` says UK address lookup `"runs in the browser"`.

## Files and changes

1. **Shared `CLIENT_CARE_DOCUMENT_TYPE` constant & B2 server + UI fix:**
   - `core/src/api/index.ts`: export `export const CLIENT_CARE_DOCUMENT_TYPE = 'client_care' as const;` (`Rule 3` / `@platform/core-api`).
   - `src/server/documentGenerationServices.ts`:
     - Use `CLIENT_CARE_DOCUMENT_TYPE` at `:600` (`TPL-SEED-CCL`).
     - Inside `generateDocumentService` (`:1545+`), when `result.status === 'generated'`, `input.matterId` is set, and `result.document.documentType === CLIENT_CARE_DOCUMENT_TYPE`, invoke server-side engagement-letter drafted progression (`markEngagementLetterDraftedForMatterInScope`) if the acting user holds `matter:edit` (or update within the permitted generation boundary cleanly without silently swallowing unexpected DB errors).
   - `src/server/services.ts:8171-8251`:
     - Expand `markEngagementLetterDrafted`'s non-regression guard (`:8225`) so it skips changing `engagementLetterStatus` when status is already `'Sent'`, `'Sent to client'`, `'Signed'`, or `'Signed & returned'`, or when `engagementLetterSentAt` or `engagementLetterSignedAt` is already set.
   - `src/components/DocumentTemplatesAdminPanel.tsx:905`, `src/components/MatterProfileClient.tsx:248, 4528-4537`, `src/components/DocumentListSection.tsx:286-301`, `src/components/MatterFormClient.tsx:11820-11824`:
     - Replace `'client_care'` / `'Client Care Letter'` literals with `CLIENT_CARE_DOCUMENT_TYPE`.
     - `await markEngagementLetterDraftedAction(matter.id)` (as defensive UI refresh fallback alongside server-side progression) before `router.refresh()`, add the callback/refresh in `DocumentListSection`, recognise `'Signed & returned'` at `MatterProfileClient.tsx:248`, and add `'Drafted'` + `'Sent'` + `'Signed'` support cleanly in `MatterFormClient.tsx:11820-11824`.
2. **`non_engagement_letter` automatic task & accurate close toast:**
   - `src/server/services.ts:14358-14507`:
     - Refactor the unlinked-person delete check (`:14469-14500`) inside the transaction so `raiseAutomaticTask(..., 'non_engagement_letter', ...)` executes **after** `:14500` when `prevStatus !== 'Draft'` and `(targetStatus === 'Referred out' || (targetStatus === 'Declined' && !['no_response', 'went_elsewhere'].includes(closeReasonSystemKey)))`, provided no open `non_engagement_letter` task is already linked to `enq.id`.
     - Assignee: use active `enq.assignedToId` if set and permitted (falling back to `byId` if unset/leaver), respecting `enq.assignedTeamId` and `dueWorkingDaysOffset` from `taskSettings`.
     - Drain outboxes best-effort after transaction commit (`drainEmailOutboxForTenant`), and return `{ enquiry: enq, nonEngagementTask }` (`null` when not raised).
   - `src/components/EnquiryProfileClient.tsx:332-358, 401` and `src/components/EnquiryFormClient.tsx:1238-1270, 1316`:
     - Only show the `'raised ... task'` toast when `Boolean(res.nonEngagementTask)`; otherwise show a plain close toast (`Enquiry closed as ...`).
     - Match conflict reason using `r.systemKey === 'conflict'` (stable key rule) instead of `.label.toLowerCase() === 'conflict'`.
3. **`R371` (`POST /api/address-lookup`) & modal address-picker fixes:**
   - `src/app/api/address-lookup/route.ts`:
     - Replace `GET` handler logic with `export const POST = guardedRoute('POST /api/address-lookup', ...)` parsing JSON `{ q?: unknown; id?: unknown }` (`400 INVALID_REQUEST` if body invalid or neither `q` nor `id` is a non-empty string; **never** read `req.url` searchParams).
     - Export `export const GET = guardedRoute('GET /api/address-lookup', async () => NextResponse.json({ error: 'Method Not Allowed', code: 'METHOD_NOT_ALLOWED' }, { status: 405, headers: { Allow: 'POST' } }))` so GET requests fail closed through `guardedRoute` with HTTP `405` and do not touch query parameters or Ideal Postcodes.
   - `src/server/actionPermissions.ts:763-766` & `src/server/__tests__/actionPermissionGuard.test.ts:719`:
     - Add `'POST /api/address-lookup'` (`{ kind: 'authenticated', reason: '...' }`), keep `'GET /api/address-lookup'` for the explicit `405` stub, and update `:719` route handler count (`13` → `14`).
   - `src/domain/addressLookup.ts:70-77, 144-150`: switch `searchAddressSuggestions` and `resolveAddressSuggestion` to `method: 'POST'` with `headers: { 'Content-Type': 'application/json' }` and JSON body `{ q }` / `{ id }`.
   - `src/components/PersonFormClient.tsx:1187-1244, 5329-5345` & `src/components/EnquiryFormClient.tsx:942-960, 4511-4525`: replace `PersonFormClient`'s cross-entity postcode scan & `suggestions[0]` auto-pick and `EnquiryFormClient`'s background dropdown with `<SingleAddressEditor>` (`FormControls.tsx`) or an explicit multi-premise picker list inside each modal.
4. **Documentation, backlog, inventory & Help (`Rule 11`):**
   - `docs/roadmap/feature-list.md`: update rows `1`, `1a`, `2`, `5`, `6`, `33`, `34` (adding deferred items `F24`–`F28` or explicit named deferred entries for ID verification provider, sanctions & PEP screening provider, e-signature provider, payment links, and live Companies House under `34` + `F*` series without renumbering existing IDs), `B2`, `B15`, and `P5`.
   - `docs/roadmap/functionality-inventory.md`: correct lines `111`, `138`, and `155` accurately.
   - Help articles (`src/docs/articles/document-generation.ts`, `matters-enquiries-tasks-and-navigation.ts`, `deployment-and-security.ts`, `home-and-profile-screens.ts`): document automatic Client Care Letter drafted marking, when `non_engagement_letter` tasks are raised on decline/referral, and `POST /api/address-lookup` behaviour.
   - `docs/release-notes.md`: add entry under `Unreleased`.

## Tests

*(Record which tests fail before the fix in `Stage1-WP1-report.md`.)*

1. **B2 tests (`core/tests/document-generation.test.ts` + new `src/domain/__tests__/engagementLetterDrafted.test.ts` or PostgreSQL service test):**
   - Fail-first: generating from `TPL-SEED-CCL` (`CLIENT_CARE_DOCUMENT_TYPE`) for a matter advances `engagementLetterStatus` to `'Drafted'` and writes `'Engagement letter status'` audit entry; non-`'client_care'` template leaves it unchanged.
   - Guard/non-regression: calling when status is `'Signed'`, `'Signed & returned'`, `'Sent'`, `'Sent to client'`, or `engagementLetterSignedAt` is set does **not** regress to `'Drafted'`; user lacking `matter:edit` cannot call `markEngagementLetterDrafted`; forged claim (`TENANCY_FORGERY_DETECTED`) and tampered cross-tenant `matterId` refused across two PostgreSQL tenants (`tenant-alpha` vs `tenant-bravo`).
2. **Non-engagement letter task tests (`core/tests/intake-quotes-tasks-postgres.test.ts`):**
   - Fail-first: closing an open enquiry as `Declined` (reason `not_viable` or `conflict`) or `Referred out` creates a `non_engagement_letter` task with `dueDate` +2 working days and assignee = `enq.assignedToId ?? byId`, and returns `nonEngagementTask`; closing with reason `went_elsewhere` / `no_response` / `Draft` creates **no** task and returns `nonEngagementTask: null`.
   - Two-tenant isolation, tampered `enquiryId`, and forged-claim rejection; reopen + re-close does not duplicate an active `non_engagement_letter` task.
3. **`R371` `/api/address-lookup` tests (`src/server/__tests__/addressLookupRoute.test.ts` & `src/server/__tests__/actionPermissionGuard.test.ts`):**
   - Fail-first: `POST /api/address-lookup` accepts JSON `{ q }` / `{ id }` when signed in; `GET /api/address-lookup?q=SW1A1AA` returns HTTP `405` (`METHOD_NOT_ALLOWED`, `Allow: POST`) and never invokes `searchAddresses` or Ideal Postcodes; unauthenticated `POST` returns `401`.
   - `actionPermissionGuard.test.ts` passes with updated route count (`14`).

## Help and documentation (rule 11)

- `src/docs/articles/document-generation.ts`
- `src/docs/articles/matters-enquiries-tasks-and-navigation.ts`
- `src/docs/articles/deployment-and-security.ts`
- `src/docs/articles/home-and-profile-screens.ts`
- `docs/roadmap/feature-list.md`
- `docs/roadmap/functionality-inventory.md`
- `docs/release-notes.md`

## Acceptance criteria

- Generating a Client Care Letter (header or Documents tab) sets `engagementLetterStatus = 'Drafted'` reliably without regressing `'Sent'` / `'Signed'` / `'Signed & returned'` matters, backed by `CLIENT_CARE_DOCUMENT_TYPE` and tests.
- Declining/referring an open enquiry raises `non_engagement_letter` once when warranted and never displays a `"raised ... task"` toast when no task was created.
- `/api/address-lookup` uses `POST` JSON bodies, rejects `GET` with `405`, and no UI modal picks only the first premise (`suggestions[0]`).
- `docs/roadmap/feature-list.md` and `functionality-inventory.md` match the verified codebase (`B2`, `B15`, items `1`, `1a`, `2`, `5`, `6`, `33`, `34` with the 5 deferred integrations named).
- `npx tsc --noEmit`, `npm run lint`, all changed tests, and `npx vitest run isolation` pass cleanly.

## Manual blockers

- Ideal Postcodes test key rotation (`P5` agreed Stage 0 exception) remains an owner manual task under stage plan §8 conditions; all route tests mock `fetch` locally.

## Rollback

- Zero database migrations (`CORE_REQUIRED_SCHEMA_VERSION` unchanged); revert `s1-01-quick-fixes` via `git revert` and keep `actionPermissionGuard.test.ts` route count aligned.

## Pull request description must state

- **Change class:** Core bug fixes (`@platform/core-api` constant, host intake/engagement/address-lookup services & routes, UI forms), Help articles, and backlog/inventory truth corrections.
- **Both hosting models:** Identical across single-tenant (`Model A`) and multi-tenant (`Model B`); `POST /api/address-lookup` and engagement/close services scope strictly to the verified `TenantContext`.
- **Migration and rollback:** No database migration; `git revert` cleanly restores prior behaviour.
