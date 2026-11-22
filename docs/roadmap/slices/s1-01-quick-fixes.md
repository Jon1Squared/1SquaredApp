# S1-01: Quick Fixes, Truth and Backlog (`B2`, Non-Engagement Task, `R371`, `R598`, `R636`, Fallbacks, Backlog & Inventory Corrections)

| | |
|---|---|
| Backlog | Items `1`, `1a`, `2`, `5`, `6`, `32`, `33`, `34`; bugs `B2`, `B15`, `P5` (`R371` carry-over); plus `R598` (configured sender precedence) and `R636` (stable warning key) |
| Decision | Stage 1 Plan §§2–3, §5 (`S1-01`); [ADR 0009](../../decisions/0009-docx-library-and-pdf-conversion.md) (`client_care` generated template); [ADR 0038](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md) (`CLIENT_CARE_DOCUMENT_TYPE`); [platform architecture standard](../../architecture-standard.md) §14 |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP1 (`S1-01`) |
| Branch | `s1-01-quick-fixes`, from `develop`, targeting `develop` |
| Change class | Core API shared constant + email sender bug fix (`core/src/api/`, `core/src/integrations/email/`), Host services/routes/domain/UI bug fixes (`src/app/api/address-lookup/`, `src/domain/`, `src/server/`, `src/components/`), CI branch trigger (`.github/workflows/ci.yml`), Help & documentation (`src/docs/`), backlog & inventory (`docs/roadmap/`) |
| Layer | Core (`@platform/core-api`, `@platform/core`) + Host application (`src/`) + Documentation (`docs/`) |
| Size | S–M |
| Depends on | `–` |
| Blocking manual tasks | None (`P5` Ideal Postcodes test key rotation remains an owner manual task under Stage 1 plan §8 standing conditions) |
| Baseline | `develop` at `7c2ba3e` (`b3bcce1` demo-deployed code baseline) |

## What exists today

Checked against `develop` (`7c2ba3e`):

1. **`B2` (`'Client Care Letter'` vs `'client_care'` mismatch, missing Documents-tab & server enforcement, status regression):**
   - `ensureSeedDocumentTemplatesInner` (`src/server/documentGenerationServices.ts:600`) seeds `TPL-SEED-CCL` with `outputDocumentType: 'client_care'`, and `DocumentTemplatesAdminPanel.tsx:905` offers `<option value="client_care">Client Care Letter</option>`.
   - `generateDocumentFromTemplate` (`core/src/domain/document-generation/generationService.ts:540`) copies `template.outputDocumentType` verbatim onto `GeneratedDocumentRecord.documentType` (`'client_care'`).
   - Meanwhile `MatterProfileClient.tsx:4530` checks `doc.documentType === 'Client Care Letter' && matter.engagementLetterStatus !== 'Signed'`, fires `void markEngagementLetterDraftedAction(matter.id)` unawaited before `router.refresh()` (`:4533-4536`), and the **Documents** tab `<DocumentListSection>` (`MatterProfileClient.tsx:2545-2553` -> `DocumentListSection.tsx:286-301`) never calls `markEngagementLetterDraftedAction` at all.
   - `generateDocumentService` (`src/server/documentGenerationServices.ts:1457-1590`) does not advance `matter.engagementLetterStatus` on the server when a `'client_care'` document is generated for a matter.
   - `markEngagementLetterDrafted` (`src/server/services.ts:8171-8251`) only guards `if (existing.engagementLetterStatus === 'Signed')` (`:8225`), ignoring `'Signed & returned'` (`src/seed/demo.ts:1356, 1717, 2038`), `'Sent'`, `'Sent to client'`, `engagementLetterSentAt`, and `engagementLetterSignedAt`. `MatterFormClient.tsx:11820-11824` omits `'Drafted'` from its `<select>`, and `MatterProfileClient.tsx:248` omits `'Signed & returned'` when `engagementLetterSignedAt` is null.
   - **Test coverage gap:** only three narrow tests exercise `markEngagementLetterDrafted` directly (`core/tests/document-store.test.ts:3930-3936`, `core/tests/isolation.test.ts:2087-2090`, `core/tests/parties-matters-postgres.test.ts:541-553`); none test `'client_care'` docgen -> `'Drafted'`, `matter:edit` denial, non-regression from `'Sent'`/`'Signed'`/`'Signed & returned'`, audit entry, or two-tenant isolation.
2. **`non_engagement_letter` automatic task never raised (`src/server/services.ts:13030-13249, 14358-14507`) & close-reason label matching:**
   - `raiseAutomaticTask` (`services.ts:13030`) already supports `trigger === 'non_engagement_letter'` with `DEFAULT_TASK_SETTINGS` (`dueWorkingDaysOffset: 2`, `task_type.send_letter`, `Send non-engagement letter: {name}`), but only `'enquiry_contact'` (`:13855`) and `'complete_matter_opening'` call it.
   - `closeEnquiryRecord` (`:14358-14507`) deletes orphan enquiry-only `people` rows inside its transaction at `:14469-14500`, returns `{ enquiry: enq }` without `nonEngagementTask`, and never calls `raiseAutomaticTask`.
   - `EnquiryProfileClient.tsx:352-356` unconditionally claims `"raised 'Send non-engagement letter' task"` whenever `mode` is `'Declined'` or `'Referred out'`, while `EnquiryFormClient.tsx:1263-1267` is a second close caller that never mentions any task; both also match the conflict close reason by `.label.toLowerCase() === 'conflict'` (`EnquiryProfileClient.tsx:401`, `EnquiryFormClient.tsx:1316`).
3. **`R371` (`/api/address-lookup` GET -> POST) & UI modal picker faults (`src/app/api/address-lookup/route.ts`):**
   - `route.ts:13-68` exports only `GET` reading `q` and `id` from `url.searchParams`; `src/domain/addressLookup.ts:70-77, 144-150` uses `GET` query strings; `actionPermissions.ts:763` lists `'GET /api/address-lookup'` only.
   - `PersonFormClient.tsx:1187-1244` (`handleFindAddress` in the `addressModalOpen` modal at `:5329-5345`) scans in-memory `allPeople`/`organisations` by postcode and otherwise picks **`lookup.suggestions[0]` (the first premise!)** at `:1230` without a multi-premise picker.
   - `EnquiryFormClient.tsx:4511-4525` calls `handleFindAddress()` (`:942`) inside the manual address modal, rendering the autocomplete dropdown behind the modal backdrop.
4. **Small carry-overs & domain fallbacks:**
   - `src/server/services.ts:13886-13930` (`R636`): once-daily unmapped-enquiry admin warning deduplicates by matching `n.title === unroutedWarningTitle` instead of a stable key.
   - `core/src/integrations/email/adapters.ts:475-476` (`R598`): `message.from?.trim() || email.senderAddress?.trim()` lets caller `message.from` override tenant-configured `integrations.email.senderAddress`.
   - `src/domain/documentGeneration.ts:914, 932`: hardcoded fallback figures `?? 285` (`hourlyRate`) and `?? 1500` (`retainerAmount`) remain when costs/fee-earner fields are absent.
   - `.github/workflows/ci.yml:11`: push triggers include `'s0-*'` but not `'s1-*'`.
5. **Backlog & inventory truth gaps (`docs/roadmap/feature-list.md`, `docs/roadmap/functionality-inventory.md`):**
   - `feature-list.md`: rows `1`, `1a`, `2` (`:23-25`) still claim `"Live Azure deployment awaits a manual task"` even though the demo is live; row `5` claims generating+drafted is `"tested"`; row `6` falsely claims `"Payment on account amount on quotes"`; row `33` needs approver-per-barrier gap clarified; row `34` still mentions `lookupPostcode` and lacks the five deferred integration items; `B15` only mentions `getAppSnapshot` rather than ~39 `listAllMattersUnfiltered` sites and five browser scans.
   - `functionality-inventory.md`: `:111` claims generating a Client Care Letter marks it drafted (`[Real]`); `:138` says UK address lookup `"runs in the browser"`; `:155` still describes `non_engagement_letter` as a `[Stub]`.

## Files and changes

1. **Shared `CLIENT_CARE_DOCUMENT_TYPE` constant & `B2` server + UI fix:**
   - `core/src/api/index.ts`: export `export const CLIENT_CARE_DOCUMENT_TYPE = 'client_care' as const;` (`Rule 3`, part of additive `@platform/core-api` updates confirmed in `ADR 0038`).
   - `src/server/documentGenerationServices.ts`:
     - Use `CLIENT_CARE_DOCUMENT_TYPE` at `:600` (`TPL-SEED-CCL`).
     - Inside `generateDocumentService` (`:1545+`), when `result.status === 'generated'`, `input.matterId` is present, and `result.document.documentType === CLIENT_CARE_DOCUMENT_TYPE`, advance engagement letter status on the server (calling `markEngagementLetterDraftedInScope` when the acting user holds `matter:edit`, without silently swallowing unexpected DB errors).
   - `src/server/services.ts:8171-8251` (`markEngagementLetterDrafted`):
     - Harden the non-regression guard (`:8225`) so status is **not** changed back to `'Drafted'` when `existing.engagementLetterStatus` is `'Sent'`, `'Sent to client'`, `'Signed'`, or `'Signed & returned'`, or when `engagementLetterSentAt` or `engagementLetterSignedAt` is already populated.
   - `src/components/DocumentTemplatesAdminPanel.tsx:905`, `src/components/MatterProfileClient.tsx:248, 2545-2553, 4528-4537`, `src/components/DocumentListSection.tsx:286-301`, `src/components/MatterFormClient.tsx:11820-11824`:
     - Replace `'client_care'` / `'Client Care Letter'` string literals with `CLIENT_CARE_DOCUMENT_TYPE`.
     - `await markEngagementLetterDraftedAction(matter.id)` defensively before `router.refresh()` in `MatterProfileClient.tsx`, refresh/update cleanly from `DocumentListSection`, recognise `'Signed & returned'` alongside `'Signed'` at `MatterProfileClient.tsx:248`, and include `'Drafted'`, `'Sent'`, `'Signed'`, and `'Signed & returned'` cleanly in `MatterFormClient.tsx:11820-11824`.
2. **`non_engagement_letter` automatic task, accurate close toast, and `systemKey` conflict check:**
   - `src/server/services.ts:14358-14507` (`closeEnquiryRecord`):
     - Execute `raiseAutomaticTask(..., 'non_engagement_letter', ...)` **after** the unlinked-person delete check (`:14500`) so deleted orphan person IDs are never added to `linkedRecords`.
     - Skip raising when `prevStatus === 'Draft'` or `targetStatus === 'No response'` or `closeReasonSystemKey` is `'went_elsewhere'` or `'no_response'`, and skip if an open `non_engagement_letter` task is already linked to `enq.id` (prevents duplicates on reopen/re-close).
     - Pick assignee as active, permitted `enq.assignedToId` (falling back to `byId` if unset/leaver), respecting `enq.assignedTeamId` and `taskSettings.dueWorkingDaysOffset` (default `+2` working days).
     - Drain outboxes post-commit (`drainNotificationOutboxesBestEffort`) and return `{ enquiry: enq, nonEngagementTask }` (`null` when no task was raised).
   - `src/components/EnquiryProfileClient.tsx:332-358, 401` and `src/components/EnquiryFormClient.tsx:1238-1270, 1316`:
     - Show `'... and raised a non-engagement letter task'` **only** when `Boolean(res.nonEngagementTask)`; otherwise show a plain close toast.
     - Match the conflict close reason by `r.systemKey === 'conflict'` (stable keys rule), never `.label.toLowerCase() === 'conflict'`.
3. **`R371` (`POST /api/address-lookup`) & modal multi-premise address picker:**
   - `src/app/api/address-lookup/route.ts`:
     - Export `POST = guardedRoute('POST /api/address-lookup', ...)` parsing JSON `{ q?: unknown; id?: unknown }` (`400 INVALID_REQUEST` when invalid or empty; **never** reads `req.url` query params).
     - Export `GET = guardedRoute('GET /api/address-lookup', ...)` returning HTTP `405` (`{ error: 'Method Not Allowed', code: 'METHOD_NOT_ALLOWED' }`, `Allow: POST`) without calling Ideal Postcodes.
   - `src/server/actionPermissions.ts:763-766` & `src/server/__tests__/actionPermissionGuard.test.ts:719`:
     - Add `'POST /api/address-lookup'` (`kind: 'authenticated'`), retain `'GET /api/address-lookup'` (documenting `405` stub), and update route handler count (`13` -> `14`).
   - `src/domain/addressLookup.ts:70-77, 144-150`: switch `searchAddressSuggestions` and `resolveAddressSuggestion` to `POST` JSON requests.
   - `src/components/PersonFormClient.tsx:1187-1244, 5329-5345` & `src/components/EnquiryFormClient.tsx:942-960, 4511-4525`: remove cross-entity `allPeople`/`organisations` postcode copying and `lookup.suggestions[0]` first-premise auto-pick; render an accessible multi-premise picker list inside each modal (or reuse `SingleAddressEditor`) so staff explicitly choose the premise.
4. **Carry-overs (`R636`, `R598`, hardcoded `documentGeneration.ts` fallbacks) & CI branch trigger:**
   - `src/server/services.ts:13886-13930` (`R636`): key once-daily unrouted-enquiry admin warning deduplication on a stable non-display key (e.g. `recordId: 'system:enquiry_unrouted_no_fallback_team'` matched against today's tenant-local notifications) rather than title text.
   - `core/src/integrations/email/adapters.ts:475-476` (`R598`): enforce `email.senderAddress?.trim() || message.from?.trim() || ''` so tenant-configured `integrations.email.senderAddress` always takes precedence over caller-supplied `message.from`.
   - `src/domain/documentGeneration.ts:914, 932`: replace `?? 285` (`hourlyRate`) and `?? 1500` (`retainerAmount`) with `?? 0`.
   - `.github/workflows/ci.yml:11`: add `- 's1-*'` alongside `- 's0-*'` in push triggers.
5. **Documentation, backlog, inventory & Help (`Rule 11`):**
   - `docs/roadmap/feature-list.md`: remove `"Live Azure deployment awaits a manual task"` from rows `1`, `1a`, `2`; update row `1` (`R636`), row `5`, row `6`, row `32` (`R598`), row `33`, row `34` (+ new named backlog rows `F24`–`F28` in `Future / Additional items` for ID verification provider, sanctions & PEP screening provider, e-signature provider, payment links, and HM Land Registry / live Companies House alignment without renumbering existing IDs), `B2`, `B15`, and `P5`.
   - `docs/roadmap/functionality-inventory.md`: update lines `111`, `138`, `155` to reflect server-side Client Care status, `POST /api/address-lookup`, and real `non_engagement_letter` task raising.
   - Help articles (`src/docs/articles/document-generation.ts`, `matters-enquiries-tasks-and-navigation.ts`, `deployment-and-security.ts`, `home-and-profile-screens.ts`) and `docs/release-notes.md`.

## Tests

*(Record which tests fail before the fix in `Stage1-WP1-report.md`.)*

1. **`B2` docgen & non-regression tests (`core/tests/document-generation.test.ts` + new PostgreSQL service tests):**
   - Fail-first: generating from `TPL-SEED-CCL` (`CLIENT_CARE_DOCUMENT_TYPE`) for a matter advances `engagementLetterStatus = 'Drafted'` and records `'Engagement letter status'` audit entry; non-`'client_care'` template does not.
   - Non-regression: calling when status is `'Sent'`, `'Sent to client'`, `'Signed'`, `'Signed & returned'`, or when `engagementLetterSentAt`/`engagementLetterSignedAt` is set preserves existing status.
   - Permission & isolation: user without `matter:edit` denied `markEngagementLetterDrafted`; forged claim (`TENANCY_FORGERY_DETECTED`) and tampered cross-tenant `matterId` rejected across two PostgreSQL tenants (`tenant-alpha` vs `tenant-bravo`).
2. **`non_engagement_letter` task tests (`core/tests/intake-quotes-tasks-postgres.test.ts`):**
   - Fail-first: declining (`not_viable` / `conflict` via `systemKey`) or referring an open enquiry raises one `non_engagement_letter` task after orphan-person clean-up (`nonEngagementTask !== null`), skips `Draft` / `went_elsewhere` / `no_response` (`nonEngagementTask === null`), and never duplicates on reopen/re-close; includes two-tenant isolation and tampered `enquiryId`.
3. **`R371` `/api/address-lookup` tests (`src/server/__tests__/addressLookupRoute.test.ts` & `actionPermissionGuard.test.ts`):**
   - Fail-first: `POST /api/address-lookup` accepts JSON `{ q }` / `{ id }` for signed-in users; `GET` returns `405` (`Allow: POST`) and never invokes Ideal Postcodes; unauthenticated `POST` returns `401`; `actionPermissionGuard.test.ts` passes with `14` route handlers.
4. **Carry-over unit/service tests:**
   - `R598`: `CoreEmailDispatcher.send` uses configured `email.senderAddress` over `message.from` (`core/tests/email-notifications-s026.test.ts`).
   - `R636`: unmapped-enquiry warning deduplicates on stable key even when title varies.
   - `documentGeneration.ts`: missing fee earner / costs snapshot produces `0` for `hourlyRate` and `retainerAmount` (never `285` / `1500`).

## Help and documentation (rule 11)

- `src/docs/articles/document-generation.ts`
- `src/docs/articles/matters-enquiries-tasks-and-navigation.ts`
- `src/docs/articles/deployment-and-security.ts`
- `src/docs/articles/home-and-profile-screens.ts`
- `docs/roadmap/feature-list.md`
- `docs/roadmap/functionality-inventory.md`
- `docs/release-notes.md`

## Acceptance criteria

- Every item listed for `S1-01` in Stage 1 Plan §5 (`B2`, `non_engagement_letter`, conflict `systemKey`, `R371` POST + both modal pickers, stale backlog/inventory text, `R636`, `R598`, removing `?? 285` / `?? 1500`, deferred backlog rows) is implemented and verified with fail-first tests.
- `npx tsc --noEmit`, `npm run lint`, changed test suites, `npx vitest run isolation`, and `gitleaks` pass cleanly.

## Manual blockers

- Ideal Postcodes test key rotation (`P5` agreed Stage 0 exception) remains an owner manual task under Stage 1 plan §8 standing conditions.

## Rollback

- Zero database migrations (`CORE_REQUIRED_SCHEMA_VERSION` unchanged); revert `s1-01-quick-fixes` cleanly via `git revert`.

## Pull request description must state

- **Change class:** Core API constant + email sender fix (`core/src/`), Host bug fixes across document generation, enquiry close, address lookup, and UI modals (`src/`), CI branch trigger, Help articles, and backlog/inventory corrections (`docs/`).
- **Both hosting models:** Identical across Model A (`single_tenant`) and Model B (`multi_tenant`); all PostgreSQL writes/reads remain scoped strictly to verified `TenantContext`.
- **Migration and rollback:** No database migration; `git revert` restores prior behaviour cleanly.
