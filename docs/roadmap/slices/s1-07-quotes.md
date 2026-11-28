# S1-07: Quote PDFs, Outbox Email Dispatch, Automated Chasing, Price Transparency Configuration, and Payment on Account on Quotes

| | |
|---|---|
| Backlog | Row `3` (Quote and costs information — moving to `Completed`), row `6` (payment on account on quotes), and stage exit item `3` |
| Decision | Stage 1 decisions `S1-D10`, `S1-D11`; Owner decisions 1, 2, 4 & Q1, Q3, Q6, Q7, Q9 (26 Nov 2026); [ADR 0034](../../decisions/0034-fee-arrangements-and-caps.md), [ADR 0038](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md), [ADR 0041](../../decisions/0041-pms-money-as-integer-pence.md), Proposed [ADR 0042](../../decisions/0042-generic-communication-chasing-mechanism.md) |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP3 (`S1-07`) |
| Branch | `s1-07-quotes`, stacked on `s1-06-engagement`, targeting `develop` |
| Change class | Core extension API (additive v`2.5.0`, Rule 7); Core tenancy expand migration `0029` (`public.quotes` POA pence & dispatch metadata) + repository; Core config engine (`workTypes.*.priceTransparency`); Host PDF builder, services, `/api/quotes/[id]/pdf` route, `'quote'` chasing handler, & UI (`WorkTypesAdminPanel`, `QuoteFormClient`, `QuoteDetailClient`, `MatterFormClient`); Demo config (`client-not-a-law-firm/config/base.json`); Plain-English Help (`src/docs/`) |
| Layer | Core API (`core/src/api/`), Core tenancy (`core/src/tenancy/`), Core config (`core/schemas/`, `core/src/config-engine/`), Host domain/server/routes/UI (`src/`), Client config (`client-not-a-law-firm/`) |
| Size | `M–L` (`1.75–2.0` days; leverages `S1-06`'s `communication-chases` infrastructure directly and uses plain multi-line textareas in `WorkTypesAdminPanel`) |
| Depends on | `S1-02a`, `S1-03`, `S1-06` (`0028` & `ADR 0042` generic chasing engine); Proposed [ADR 0042](../../decisions/0042-generic-communication-chasing-mechanism.md) to be Accepted |
| Blocking manual tasks | None in dev/test; **live email delivery blocked by Stage 1 §8 task** (in the `S1-06` build, `demo.json` sets `integrations.email.provider` to `"disabled"` so queued quote emails stay `'pending'` and readable in **Administration → Email Outbox**; switching it back on alongside a demo sending mailbox is a Stage 1 §8 manual setup task) |
| Baseline | `develop` at `a7e606c` |

---

## 1. Change Class and Layer Breakdown

| Part | Change class | Layer |
|---|---|---|
| Additive `WorkTypePriceTransparencyConfig` on `WorkTypeDefaultsConfig` / `WorkTypeConfigItem`, `CORE_API_VERSION = '2.5.0'` | Core API & config types (additive, Rule 7) | `core/src/api/index.ts`, `core/docs/CHANGELOG.md` |
| `workTypes.defaults.priceTransparency` & `workTypes.items[].priceTransparency` JSON Schema + Zod + deep-merge (`base.json` + overlay); approved demo Price Transparency wording (Appendix A) | Core config schema & client config | `core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `client-not-a-law-firm/config/base.json` |
| Expand migration `0029_quotes_poa_and_dispatch_expand` (`payment_on_account_pence BIGINT`, `payment_on_account_required`, `sent_to_email`, dispatch & transparency snapshot metadata); update `TenantIntakeQuoteRepository` (`upsertQuoteInTx`, `mapRowToQuote`, immutable version snapshots) | Core tenancy migration & repository | `core/src/tenancy/migrations/index.ts`, `core/src/tenancy/tenantScopedRepository.ts`, `core/src/tenancy/intakeQuoteRepository.ts` |
| Quote DOCX/PDF builder (`selectDocumentPdfConverter` outside TX, `<= 3_000_000` bytes), `GET /api/quotes/[id]/pdf` (`guardedRoute`), `sendQuoteEmailAction` (updating all 4 "Mark as sent" call paths, populating `quote_id`/`matter_id` on `email_outbox` for `R823`) + confirmed secondary `markQuoteSentOfflineAction` (Q6), `'quote'` handler on ADR 0042 `communication-chases` (`chase:<chaseId>:step:<n>`, `R818`), carry-over of quote POA into `resolveMatterCostsSnapshot` & `MatterFormClient` | Host domain, server services, HTTP routes & actions | `src/domain/quotePdf.ts`, `src/domain/quotes.ts`, `src/domain/workTypeConfig.ts`, `src/domain/matterCosts.ts`, `src/app/api/quotes/[id]/pdf/route.ts`, `src/server/services.ts`, `src/server/actionPermissions.ts`, `src/app/actions.ts` |
| Interactive **Price Transparency** editor inside `WorkTypesAdminPanel` (per-work-type plain multi-line textareas with 3-tier inheritance), Quote Form POA & email fields, Quote Detail PDF download / send / offline / chase status UI, Matter Form POA carry-over | Host UI | `src/components/WorkTypesAdminPanel.tsx`, `src/components/QuoteFormClient.tsx`, `src/components/QuoteDetailClient.tsx`, `src/components/MatterFormClient.tsx` |
| Plain-English Help (`quotes-and-pricing.ts` / updates), technical & release notes | Help & docs (Rule 11) | `src/docs/`, `docs/` |

---

## 2. What Exists Today (`develop` at `a7e606c`)

1. **Quote domain model, SQL table & repository (`src/domain/types.ts`, `core/src/tenancy/migrations/index.ts`, `intakeQuoteRepository.ts`):**
   - Domain types in `src/domain/types.ts:1279–1431`: `QuoteStatus` (`'Draft' | 'Sent' | 'Follow-up due' | 'Accepted' | 'Declined' | 'Expired' | 'Superseded'`), `QuoteFeeBasis` (`:1288–1294`), `QuoteDisbursement` (`:1303–1310`), `QuoteFollowUpEntry` (`:1312–1319`), `QuoteVersionSnapshot` (`:1321–1354`), `QuoteTimelineEvent` (`:1356–1371`), and `Quote` (`:1373–1431`). Notice **no `paymentOnAccount*` or `priceTransparency` fields exist** on `Quote` or `QuoteVersionSnapshot` today.
   - Database table `public.quotes` (`0010_intake_quotes_tasks_expand`, `migrations/index.ts:1167–1219`): already declares `payment_on_account_gbp NUMERIC(12,2) NULL` (`:1186`) alongside `QuoteRow` (`intakeQuoteRepository.ts:388–389`), **but `upsertQuoteInTx` hardcodes `$19 = null` (`intakeQuoteRepository.ts:2036`) and `mapRowToQuote` (`:575–776`) never reads it**. No `payment_on_account_pence BIGINT` column exists yet.
   - Visibility SQL (`core/src/tenancy/intakeQuoteRepository.ts:783–915`): `QUOTE_VISIBLE_SQL_PREDICATE` (`:889–915`) filters quotes linked to hidden matters (`buildMatterHiddenFromViewerSql`) or hidden draft enquiries (`buildEnquiryVisibleSqlPredicate`).
2. **Exact pinpoints where "Mark as sent" currently sends nothing:**
   - **Site 1 (Quote detail "Mark as sent"):** `src/components/QuoteDetailClient.tsx:330–337` (`handleMarkAsSent` `:146–158`) -> `markQuoteSentAction` (`src/app/actions.ts:1189–1195`) -> **`src/server/services.ts:21813–21866`** (`markQuoteSentRecord`, specifically `:21834–21862`: sets `status = 'Sent'`, `sentAt`, `nextFollowUpDate`, `'sent'` timeline event, writes audit — **zero PDF, zero outbox email**).
   - **Site 2 (Quote form create "Save & mark as sent"):** `src/components/QuoteFormClient.tsx:2105–2115` (`handleSubmit(true)` `:848, 908–943`) -> `saveQuoteAction(..., { markAsSent: true })` (`actions.ts:1173–1187`) -> **`src/server/services.ts:21263–21272, 21395–21404, 21458–21469`** (**zero PDF, zero outbox email**).
   - **Site 3 (Quote form edit "Save & mark as sent"):** same UI control -> **`src/server/services.ts:21489, 21683–21695, 21701–21712`** (**zero PDF, zero outbox email**).
   - **Site 4 (Quote revise "Save vN & mark as sent"):** `QuoteFormClient.tsx:867–888` -> `reviseQuoteAction(..., { markAsSent: true })` (`actions.ts:1212–1240`) -> **`src/server/services.ts:22247–22252, 22269–22291`** (**zero PDF, zero outbox email**).
   - No quote PDF generator or download route exists anywhere in `src/`.
3. **Quote follow-ups (manual) & `quote-expiry` job:**
   - Read-only lifecycle projection: `evaluateQuoteEffectiveStatus` (`src/domain/quotes.ts:175–193`) & `applyQuoteEffectiveLifecycle` (`:199–230`) project `'Follow-up due'` once `nextFollowUpDate <= todayYmd` and `'Expired'` once `validUntil < todayYmd`.
   - Manual logging: `QuoteDetailClient.tsx:160–181, 1032–1103` -> `logQuoteFollowUpAction` (`actions.ts:1197–1210`) -> `logQuoteFollowUpRecord` (`services.ts:21868–21942`).
   - Scheduled expiry: `executeQuoteExpiryForTenant` (`src/server/services.ts:33088–33278`) & `runScheduledQuoteExpiryJobSweep` (`:33206–33278`), running at `02:00` local time under `JOB_PERMISSIONS['quote-expiry']` (`actionPermissions.ts:1046–1054`, `caj-quo-exp-${env}` `platform.bicep:1731–1787`), calling `listOverdueQuotesForLifecycleSweep` (`intakeQuoteRepository.ts:2788–2812`) and `expireQuoteIfOverdue` (`:2819–2869`, `FOR UPDATE SKIP LOCKED`).
4. **Quote money maths & immutable `versionHistory`:**
   - `calculateQuoteTotals` (`src/domain/quotes.ts:68–168`) uses `@platform/core-api` integer minor units (`poundsToMinorUnits`, `percentToBasisPoints`, `calculateVatMinorUnits`, `sumMinorUnits`, `minorUnitsToPounds`); `normalizeQuoteDisbursements` (`services.ts:21047–21080`) rounds server-side.
   - `reviseQuoteRecord` (`services.ts:22078–22131`) freezes immutable `QuoteVersionSnapshot` (with `capturedAt` and `vatRatePercent`) after CFA/DBA cap validation.
   - Minor UI float addition sites remain in `src/components/QuoteDetailClient.tsx:797` (`totals.feeAmountExVat + totals.vatOnFee`) and `:830` (`d.amountExVat + dVat`), which `S1-07` moves onto `sumMinorUnits`.
5. **Quote-to-matter conversion & POA gap:**
   - `QuoteDetailClient.tsx:210–234` -> `prepareQuoteConversionAction` (`actions.ts:1257–1263`) -> `prepareQuoteConversionRecord` (`services.ts:22410–22966`) runs `searchMatterConflicts`, creates missing client/organisation links, and routes to `/matters/new?quoteId=...`.
   - `loadMatterFormPageData` (`src/server/pageLoaders.ts:2839–2960`) passes `initialQuoteDirect` into `MatterFormClient.tsx:471–1222`; `saveMatterRecord` finalises via `finalizeQuoteConversionToMatter` (`services.ts:22968–23031`). Neither `MatterFormClient.tsx:1171–1175` nor `resolveMatterCostsSnapshot` (`src/domain/matterCosts.ts:1094–1178`) reads payment-on-account from `initialQuote` yet.
6. **`workTypes` config schema & `WorkTypesAdminPanel`:**
   - `core/schemas/tenant-config.schema.json:1458–2007`, `core/src/config-engine/index.ts:442–625` (`.strict()`), explicit deep-merge at `:4137–4357` (by `workTypeId`), domain resolver `resolveEffectiveWorkTypesConfig` (`src/domain/workTypeConfig.ts:128–356`) with 3-tier per-setting inheritance pattern (`work_type` -> `practice_area` -> `firm_default`, `:454–524`), Admin persistence via `saveWorkTypesConfigAction` (`actions.ts:1755–1768`, requiring `admin:access` + `mfaVerified: true` at `services.ts:27318–27436`), and UI editor in `WorkTypesAdminPanel.tsx:85–1599`.

---

## 3. Design & Functional Specification

### 3.1 Payment on Account on quotes (integer pence `BIGINT`, snapshot & conversion carry-over)
- Extend `Quote` and `QuoteVersionSnapshot` (`src/domain/types.ts`, `intakeQuoteRepository.ts`) with:
  - `paymentOnAccountRequired: boolean` (`false` default)
  - `paymentOnAccountPence: MinorUnits | null` (validated non-negative; `> 0` whenever `paymentOnAccountRequired === true`)
  - `paymentOnAccountGbp: number | null` (boundary helper derived cleanly via `minorUnitsToPounds`, synced with `public.quotes.payment_on_account_gbp` during Release N)
- Preserve immutability: `reviseQuoteRecord` (`services.ts:22078–22131`) snapshots `paymentOnAccountRequired`, `paymentOnAccountPence`, and `priceTransparencySnapshot` into `versionHistory`, leaving superseded versions frozen (`QuoteDetailClient.tsx:862–939` displays archived POA & price transparency summary).
- **Quote-to-matter carry-over:** Update `resolveMatterCostsSnapshot` (`src/domain/matterCosts.ts:1045–1178`) and `MatterFormClient.tsx:1171–1175, 1215–1222` so converting an Accepted quote pre-fills `paymentOnAccountRequired`, `paymentOnAccountAmountGbp` / `retainerMoniesOnAccountPence`, and the Client Care merge field (`financial.retainerAmount`) cleanly unless the fee earner explicitly edits them on the matter.

### 3.2 Quote PDF generation & all 4 "Mark as sent" paths upgraded
1. **Quote PDF (`src/domain/quotePdf.ts` + `GET /api/quotes/[id]/pdf`):**
   - Builds an authoritative DOCX using `buildValidDocxArchive` (firm header/regulator details, client/prospect addressee — excluding unpermitted matter CDD fields, `quoteReference`, `vN`, `feeBasis`, scope, assumptions, minor-unit fee + VAT + disbursements + total inc VAT table, optional payment on account box, valid-until date, and resolved **Price Transparency** section for the quote's work type), then converts to PDF via `selectDocumentPdfConverter` **outside** any DB transaction.
   - `GET /api/quotes/[id]/pdf` (`guardedRoute`, `quote:view` + `QUOTE_VISIBLE_SQL_PREDICATE`) lets staff preview/download the PDF directly.
2. **Sending quotes by email (`sendQuoteEmailAction` + upgraded form buttons):**
   - All 4 "Mark as sent" flows (`QuoteDetailClient` primary button + `QuoteFormClient` create/edit/revise `"Save & send quote"`):
     - Require a valid recipient email (`isValidEmailAddress`, defaulted from linked enquiry/contact/person email if present) unless explicitly using the confirmed secondary **`"Record as sent offline"`** fallback (`markQuoteSentOfflineAction`, Owner Q6).
     - Generate quote PDF via `selectDocumentPdfConverter` **outside** `withTenantTransaction` and fail closed if `pdfBytes.byteLength > MAX_EMAIL_TOTAL_ATTACHMENT_BYTES` (`3_000_000` bytes — plain-English error, zero PII logged).
     - Inside `withTenantTransaction`: lock quote `FOR UPDATE`, verify it is not `Accepted`/`Declined`/`Expired`/`Superseded`, enqueue to `public.email_outbox` (populating nullable `quote_id = quote.id` and `matter_id = quote.convertedMatterId ?? null` via `0028` for `R823` outbox filtering) + inline PDF into `public.email_outbox_attachments` (`idempotency_key: 'quote:send:<quoteId>:v<version>:<dispatchNonce>'`), freeze `priceTransparencySnapshot` onto `public.quotes`, transition `status = 'Sent'`, `sentAt`, `sentToEmail`, `sentByPersonId`, `lastSentOutboxId`, create/replace `'active'` row in `public.communication_chases` (`entity_kind = 'quote'`, `quote_id = quote.id`, `sent_at`, `next_step_index = 1`) when `chasing.quote.enabled === true`, append `'sent'` timeline & audit entry (`'Quote sent'`).
     - Drain outbox best-effort post-commit (honestly reporting `"Queued in outbox"` when `email.provider === 'disabled'`).
   - Revising a sent quote (`reviseQuoteRecord`) stops any `'active'` chase on the superseded version (`stopped_reason = 'superseded'`), while saving & sending the new version starts a fresh chase from Day 0 (`vN+1`) with a new `chaseId`.

### 3.3 Automated chasing plug-in (`communication-chases`, ADR 0042) & `quote-expiry` interaction
- Registers the `'quote'` handler in `executeCommunicationChasesForTenant` (using the confirmed **7 / 14 / 21** day defaults from Owner Q3):
  - Checks `evaluateQuoteEffectiveStatus(quote, now)` inside TX; if `'Accepted' | 'Declined' | 'Expired' | 'Superseded'`, immediately sets chase `status = 'stopped'` (`stopped_reason` matching quote outcome) and exits without chasing.
  - Otherwise Day `7` -> first follow-up email (**`idempotency_key: 'chase:<chaseId>:step:1'`**, keyed on `communication_chases.id` per `R818` and populating `quote_id`/`matter_id` on `email_outbox` per `R823`; re-includes summary/validity date, no duplicate attachment needed or small PDF `<= 3 MB`), Day `14` -> second follow-up email (**`idempotency_key: 'chase:<chaseId>:step:2'`**), Day `21` -> escalation task assigned to `quote.feeEarnerId` (or `preparedById`, active & permitted via `QUOTE_VISIBLE_SQL_PREDICATE` / `canPersonAccessMatter` on source enquiry/matter) and sets chase `completed`.
  - Because chases are keyed by `chase:<chaseId>:step:<n>` (`R818`), revising and re-sending a quote on the same `quote_id` creates a new `communication_chases` row with a fresh `chaseId` and queues new day-7/day-14 emails without colliding on `email_outbox`'s `UNIQUE (tenant_id, idempotency_key)`.
  - `recordQuoteOutcomeRecord` (`services.ts:22320–22403`), `finalizeQuoteConversionToMatter` (`:22968–23031`), `reviseQuoteRecord`, and `expireQuoteIfOverdue` (`intakeQuoteRepository.ts:2819–2869`) all synchronously call `stopActiveChaseInTx(tx, ctx, 'quote', quote.id, reason)` so chasing stops **the instant** any outcome or expiry commits.
  - Existing pre-WP3 quotes remain untouched (zero retrospective chasing).

### 3.4 Per-work-type Price Transparency config & interactive `WorkTypesAdminPanel` editor
- Add optional `priceTransparency` object to `workTypes.defaults` and `workTypes.items[]`:
  - `enabled: boolean` (core default `false`; demo `true`)
  - `headlineSummary: string` (default `""`)
  - `serviceDescription: string` (default `""`)
  - `keyStages: string` (default `""`)
  - `typicalTimescales: string` (default `""`)
  - `disbursementsGuidance: string` (default `""`)
  - `exclusionsAndVatNote: string` (default `""`)
- Resolved using the exact 3-tier per-property pattern (`work_type_subcategory -> practice_area -> firm_defaults -> core empty`) in `resolveWorkTypePriceTransparencyWithProvenance` (`src/domain/workTypeConfig.ts`), displayed inside **`QuoteFormClient`** (live preview of configured guidance + toggle to include/customise note), **`QuoteDetailClient`**, and **`quotePdf.ts`**, and interactively editable inside **`WorkTypesAdminPanel.tsx`** (`admin:access` + `mfaVerified: true`) using clean multi-line textareas with inheritance status and reset-to-inherited controls (avoiding bespoke rich-text editors to stay comfortably within WP3's `7–9` day budget alongside the outbox viewer).

---

## 4. Data Model, Expand Migration `0029`, Backfill & Rollback Plan

- **Migration ID:** `0029_quotes_poa_and_dispatch_expand` (`CORE_REQUIRED_SCHEMA_VERSION = '0029'`, `dependsOn: ['0010', '0019', '0028']`).
- **`upSql`:**
  `ALTER TABLE public.quotes` adding:
  - `payment_on_account_pence BIGINT NULL CHECK (payment_on_account_pence IS NULL OR payment_on_account_pence >= 0)` *(backfilling any rare existing non-null `payment_on_account_gbp` via `ROUND((payment_on_account_gbp::numeric) * 100)::bigint`)*
  - `payment_on_account_required BOOLEAN NOT NULL DEFAULT FALSE` *(backfilled `TRUE` where `payment_on_account_pence > 0`)*
  - `sent_to_email TEXT NULL`
  - `sent_by_person_id TEXT NULL`
  - `last_sent_outbox_id TEXT NULL`
  - `price_transparency_snapshot_json JSONB NULL`
- **Backfill & compatibility:** Existing `quotes` keep rendering identically; pre-WP3 `'Sent'` quotes keep `last_sent_outbox_id = NULL` and receive **no** `communication_chases` rows (never chased retrospectively). `upsertQuoteInTx` writes both `payment_on_account_pence` and boundary `payment_on_account_gbp` (via `minorUnitsToPounds`, replacing hardcoded `$19 = null` at `intakeQuoteRepository.ts:2036`).
- **Reversible `downSql`:** Drops the six added columns from `public.quotes` (`up -> down -> up` round-trip clean).

---

## 5. Configuration Schema Changes & Runtime Usage Compliance

- **`workTypes.defaults.priceTransparency` & `workTypes.items[].priceTransparency` (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`):**
  - Core defaults: `{ enabled: false, headlineSummary: '', serviceDescription: '', keyStages: '', typicalTimescales: '', disbursementsGuidance: '', exclusionsAndVatNote: '' }` (safe empty defaults — no transparency wording appears on firm quotes until configured).
  - Explicit deep-merge added in `loadAndValidateTenantConfig` (`core/src/config-engine/index.ts:4137–4357`) alongside `retention`, `openingGate`, and `feeArrangementCapCategories`.
  - Every field read at runtime by `resolveEffectiveWorkTypesConfig` / `resolveWorkTypePriceTransparencyWithProvenance` and `quotePdf.ts` (satisfying `core/tests/tenant-config-usage.test.ts`).
- **Demo defaults (`client-not-a-law-firm/config/base.json`):** Firm-default guidance plus specific SRA-style Price Transparency blocks on Residential Conveyancing, Estate Administration (Probate), Employment Tribunal Claims, Debt Recovery / Pre-action Dispute Resolution, and Corporate & Commercial (full invented British English text in Appendix A).

---

## 6. Permissions, Action/Route Policies, Role Matrix & MFA

- **No new RBAC permission keys needed in `S1-07`:** Reuses `quote:view`, `quote:edit`, `admin:access` (+ `mfaVerified: true` on `saveWorkTypesConfigAction`), and `S1-06`'s `communication:run_chases` (`PERMISSION_REGISTRY` stays `82 / 71 / 11`).
- **New Actions / Route (`src/server/actionPermissions.ts`, `MAX_KNOWN_GAPS = 0`, `ROUTE_PERMISSIONS` `17 -> 18`):**
  - `sendQuoteEmailAction` -> `{ kind: 'permission', key: 'quote:edit', enforcedBy: 'action' }`
  - `markQuoteSentOfflineAction` *(confirmed secondary action per Owner Q6)* -> `{ kind: 'permission', key: 'quote:edit', enforcedBy: 'action' }`
  - `GET /api/quotes/[id]/pdf` -> `{ kind: 'permission', key: 'quote:view', enforcedBy: 'action' }` *(verifying `QUOTE_VISIBLE_SQL_PREDICATE` + `ctx.tenantId`)*
  - Existing `saveQuoteAction`, `reviseQuoteAction`, `markQuoteSentAction`, `logQuoteFollowUpAction`, `recordQuoteOutcomeAction`, `saveWorkTypesConfigAction` (MFA enforced).

| Capability | Partner / MP | Fee Earner | Supervisor | Legal Secretary | Enquiries / Intake | Risk & Compliance | Finance | Admin |
|---|---|---|---|---|---|---|---|---|
| Create/edit quote & set POA (`quote:edit`) | Yes | Yes | Yes | Yes | Yes | No (`quote:view` only) | No | Yes* |
| Send quote email + PDF / chase (`quote:edit`) | Yes | Yes | Yes | Yes | Yes | No | No | Yes* |
| View/download quote PDF (`quote:view`) | Yes | Yes | Yes | Yes | Yes | Yes* | No | Yes* |
| Edit Price Transparency in Work Types Admin (`admin:access` + **MFA**) | MP / Partner | No | No | No | No | No | No | Yes (**MFA**) |

---

## 7. Visibility, Isolation, `R812` CDD Redaction & `S1-09` Composition

1. **Visibility & `S1-09` composition:**
   - Every quote read, send, chase, and `GET /api/quotes/[id]/pdf` enforces `QUOTE_VISIBLE_SQL_PREDICATE` (`intakeQuoteRepository.ts:889–915`) and checks `canPersonAccessMatter` / draft-enquiry privacy (`B19`).
   - `'quote'` chase escalation tasks attach `quoteId`, `matterId` (if converted), and `sourceEnquiryId`, keeping `canRecipientReceiveNotification` restricted-safe and ready for `S1-09` client/enquiry/matter barriers.
2. **`R812` CDD-redaction rule compliance:**
   - Quotes (`Quote` / `QuoteVersionSnapshot` / `priceTransparencySnapshot` / `quotePdf.ts`) do **not** read or copy matter CDD fields (`amlStatus`, `amlCompletedAt`, `clientCddStatus`) anywhere. Any quote loader returning linked converted matter summaries runs through `withPageShell` (`redactMatterCddInBrowserPayload`). `GET /api/quotes/[id]/pdf` serves strictly quote pricing, scope, disbursements, POA, and transparency guidance — never matter CDD outcomes.
3. **Rule 9 guarantees:** Two-tenant tests cover cross-tenant `quoteId` on `sendQuoteEmailAction`, `GET /api/quotes/[id]/pdf`, `communication-chases`, and `WorkTypesAdminPanel` save actions.

---

## 8. Help and Documentation (Rule 11 & Stage 1 §6 Rule 6)

Plain British English for firm users (zero code names, error codes, or migration numbers):
- **New/updated Help articles:**
  - `src/docs/articles/quotes-and-pricing.ts` (new or consolidated with `matters-enquiries-tasks-and-navigation.ts`): creating a quote, setting Payment on Account and carrying it through to matter opening, downloading or sending the Quote PDF by email, how automatic 7/14-day follow-up emails and day-21 fee-earner tasks work, when chasing stops automatically, and viewing frozen historical versions.
  - `src/docs/articles/document-generation.ts` & `src/docs/articles/tenant-settings.ts`: explaining Quote PDFs and configuring Price Transparency text per work type (with inheritance from practice area and firm defaults).
- **Technical docs:** Update `docs/guides/platform-technical-notes.md`, `docs/release-notes.md`, and `core/docs/CHANGELOG.md` for `0029`, `CORE_API_VERSION = '2.5.0'`, `/api/quotes/[id]/pdf`, and `S1-07` UI float-sum fixes.

---

## 9. Tests, Guards & Build-Phase Test Cadence

1. **Migration `0029` round-trip (`core/tests/migrations-postgres.test.ts`):** `up -> down -> up` cleanly after `0028`.
2. **Unit & config (`core/tests/rates-charging-s023.test.ts`, `core/tests/departments-work-types-s022.test.ts`, `core/tests/tenant-config-usage.test.ts`, `src/domain/__tests__/quotes.test.ts`):**
   - Quote POA minor-unit preservation across create/edit/revise snapshots and carry-over into `resolveMatterCostsSnapshot`; `QuoteDetailClient` integer total arithmetic; 3-tier Price Transparency inheritance (`work_type` -> `practice_area` -> `firm_default` -> safe empty core default).
3. **Two-tenant PG16 isolation, PDF/outbox & chasing (`core/tests/quotes-outbox-chasing-s107.test.ts`):**
   - `sendQuoteEmailAction` renders valid `%PDF-` via `selectDocumentPdfConverter` outside TX, enforces `3_000_000` byte cap, enqueues `email_outbox` (populating `quote_id` / `matter_id` for `R823` outbox filtering) + `email_outbox_attachments`, stamps `Sent`, starts `communication_chases` (`'quote'`), and blocks `finance` / cross-tenant callers (`GET /api/quotes/[id]/pdf` cross-tenant `404`/`403` and hidden restricted draft-enquiry rejection, plus restricted/hidden quote outbox suppression in `Admin` outbox viewer).
   - Chase progression: day 7 -> email 1, day 14 -> email 2, day 21 -> fee-earner task; **immediate stop** verified on each of `Accepted` (outcome & `finalizeQuoteConversionToMatter`), `Declined`, `Expired` (`quote-expiry` & lazy check), and `Superseded` (`reviseQuoteRecord`); pre-existing `'Sent'` quotes never chased retroactively.
   - **Chase re-send key test (`R818`):** send quote v1 -> run `communication-chases` (day-7 queued) -> revise quote to v2 and send (`superseded` stops v1 chase, v2 gets a new `chaseId`) -> run `communication-chases` -> v2's day-7 and day-14 chase emails are queued cleanly under `chase:<chaseId>:step:<n>` with zero idempotency collision.
   - `saveWorkTypesConfigAction` MFA requirement (`admin_no_mfa` fails `MFA_REQUIRED`) & Price Transparency persistence.
4. **Guards (`noWholeTenantLoadInRequestPaths.test.ts`, `actionPermissionGuard.test.ts`):** zero new whole-tenant loads; `actionPermissionGuard` exact counts updated for new actions + `GET /api/quotes/[id]/pdf` (`ROUTE_PERMISSIONS` `17 -> 18`).
5. **Playwright E2E (`e2e/role-journeys.spec.ts`):** Fee earner/Enquiries creates quote with POA and checks Price Transparency preview, clicks **Send quote by email** (helper checks `email_outbox` + PDF bytes in PG16), downloads `/api/quotes/[id]/pdf`, accepts and converts to a prospective matter verifying POA carried into Step 2!
6. **Existing test files touched by `S1-07`:** `core/tests/migrations-postgres.test.ts`, `src/server/__tests__/actionPermissionGuard.test.ts`, `core/tests/tenant-config-usage.test.ts`, `core/tests/intake-quotes-tasks-postgres.test.ts`, `core/tests/rates-charging-s023.test.ts`, `core/tests/departments-work-types-s022.test.ts`, `e2e/role-journeys.spec.ts`.
7. **Build-phase test cadence:** Per commit/branch run `npx tsc --noEmit`, `npm run lint`, changed/new Vitest files above, and `npx vitest run isolation`.

---

## 10. Expected `docs/roadmap/feature-list.md` Updates

When `S1-07` lands:
- **Row `3` (Quote and costs information):** Update status from `Partly built` to **`Completed`**; update "What exists" to include quote PDF generation & `/api/quotes/[id]/pdf`, outbox email+PDF dispatch across all send flows (`0029`), automated 7/14/21-day chasing on `communication-chases` (`ADR 0042`), configurable per-work-type Price Transparency text with `WorkTypesAdminPanel` MFA editor, Payment on Account on quotes + matter conversion carry-over, Help article (`quotes-and-pricing.ts`), and two-tenant/E2E tests; clear "What's missing" (`–`).
- **Row `6` (Money on account):** Narrow "What's missing" to remove `"Payment on account amount on quotes (and quote migration)"`.

---

## 11. Commit Breakdown

1. **`feat(s1-07): extend @platform/core-api (v2.5.0) and workTypes config schema + deep-merge + base.json Price Transparency defaults`**
2. **`feat(s1-07): add migration 0029 (quote POA pence & dispatch metadata) and wire TenantIntakeQuoteRepository`**
3. **`feat(s1-07): build quote PDF generator, /api/quotes/[id]/pdf route, outbox dispatch across send flows, and quote chasing handler`**
4. **`feat(s1-07): add WorkTypesAdminPanel Price Transparency editor, Quote Form/Detail POA & send UI, and Matter conversion carry-over`**
5. **`docs(s1-07): add Quote Help article, update settings/doc-gen articles, release notes, and feature-list row 3`**

---

## 12. Draft Owner Spot Checks (Demo — Outbox Verified)

- **Price Transparency Admin (MFA):** Sign in as **Admin** (with MFA) -> **Administration -> Work Types** -> select **Residential Conveyancing** -> inspect the **Price Transparency** section, verify firm-default inheritance vs override, and update one sentence.
- **Quote PDF, POA & Send -> Outbox:** Create a quote for Residential Conveyancing with Fixed Fee £1,200 + £200 Search disbursement + **Payment on Account £500**, confirm Price Transparency guidance appears, preview/download the **Quote PDF**, enter recipient email, and send. Open **Administration -> Email Outbox** (with MFA) to inspect the queued `'pending'` message confirming recipient, message, and downloadable Quote PDF attachment (containing fee breakdown, £500 POA, and transparency text), then verify converting the accepted quote pre-fills £500 POA on the new matter.

---

## 13. Risks & Open Questions (Resolved Owner Decisions, 26 Nov 2026)

- **Owner Q6 (`"Record as sent offline"` secondary button — Resolved 26 Nov 2026):** Confirmed. **"Send quote by email"** (enqueueing email + PDF and starting automated chasing) is the primary action, and **`"Record as sent offline"`** (`markQuoteSentOfflineAction`) remains available as the secondary button for printed/DX quotes (`status = 'Sent'`, `'sent'` audit, optional date, no outbox email or automatic chasing unless requested).
- *(Owner Q1, Q2, Q3, Q7, and Q9 are likewise resolved in `S1-06` and `S1-08`; no open questions remain.)*

---

## 14. Estimate (`1.75–2.0` days)

- Config schema/deep-merge + `base.json` defaults + `0029` migration + repository POA wiring: `0.5` day.
- Quote PDF builder + `/api/quotes/[id]/pdf` + upgrade all 4 send paths + `'quote'` chaser handler: `0.75` day.
- `WorkTypesAdminPanel` plain-textarea Price Transparency UI + `QuoteFormClient`/`QuoteDetailClient`/conversion carry-over + Help + tests: `0.5–0.75` day.
- **Total `S1-07`:** **`1.75–2.0` days**.

---

## Appendix A: Approved Draft Invented Demo Price Transparency Defaults (`client-not-a-law-firm/config/base.json`)

*(Approved by owner on 26 Nov 2026 per Decision 1 / Q7. Plain British English; all fees/timescales are illustrative demo guidance reflecting UK SRA Transparency Rules style.)*

### A.1 Firm Default (`workTypes.defaults.priceTransparency`)
- `enabled`: `true`
- `headlineSummary`:
  > We believe in clear, upfront pricing. Our quote sets out whether your matter is priced on a fixed fee, estimate, capped fee, or hourly-rate basis, together with anticipated third-party disbursements and VAT.
- `serviceDescription`:
  > This matter is handled by an allocated fee earner under partner supervision. All quotes include initial review of your instructions, standard correspondence, and reporting on progress at key milestones.
- `keyStages`:
  > Typical stages comprise: (1) Initial instructions, conflict checks, and client due diligence; (2) Scoping, document review, and advice; (3) Negotiation or drafting; and (4) Completion and post-matter wrap-up.
- `typicalTimescales`:
  > Timescales depend on matter complexity, third-party response times, and prompt completion of client due diligence and initial payments on account. Your quote and welcome email confirm the expected timeframe for your specific matter.
- `disbursementsGuidance`:
  > Disbursements are costs payable to third parties (such as search providers, HM Land Registry, Companies House, court fees, or Counsel's fees). We will obtain your approval before incurring any significant unquoted disbursement.
- `exclusionsAndVatNote`:
  > All professional fees quoted exclude VAT (charged at the prevailing UK standard rate, currently 20%, where applicable) unless expressly stated as inclusive. Any material change in scope will be discussed and confirmed in writing before extra charges are incurred.

### A.2 Work-Type Specific Overrides (`workTypes.items[]`)

1. **`work_type.real_estate_and_property_residential_conveyancing` (Residential Conveyancing):**
   - `headlineSummary`: `Residential conveyancing fees cover standard legal work on a freehold or leasehold sale, purchase, or remortgage, billed on the basis shown above plus statutory searches, Land Registry fees, and VAT.`
   - `serviceDescription`: `Includes investigating title, raising and answering pre-contract enquiries, reviewing mortgage offers, preparing transfer/charge documentation, exchanging contracts, completing the transaction, and submitting SDLT/LTT returns and HM Land Registry applications.`
   - `keyStages`: `1. Onboarding, ID/source-of-funds checks & contract pack; 2. Property searches, enquiries & mortgage review; 3. Report on title & exchange of contracts; 4. Pre-completion checks & completion; 5. SDLT return & Land Registry registration.`
   - `typicalTimescales`: `An average freehold purchase or sale takes approximately 8 to 14 weeks from instruction to completion; leasehold matters commonly take 12 to 18 weeks depending on landlord/management pack turnaround.`
   - `disbursementsGuidance`: `Typical third-party costs include local/drainage/environmental searches (£250–£450 plus VAT), HM Land Registry priority and registration fees (band-based by price), bank telegraphic transfer fees, and Stamp Duty Land Tax (where payable). Leasehold transactions also attract landlord notice/management pack fees.`
   - `exclusionsAndVatNote`: `Standard fee quotes exclude unexpected title defects, defective lease variations, restrictive covenant indemnity policies, or aborted-transaction surcharges if a chain collapses unexpectedly. VAT at 20% applies to our fees.`

2. **`work_type.private_client_estate_administration` (Estate Administration / Probate):**
   - `headlineSummary`: `Estate administration costs depend on whether we are assisting solely with applying for the Grant of Representation or handling full estate collection, tax reporting, and distribution.`
   - `serviceDescription`: `Full administration typically includes identifying estate assets and liabilities, preparing IHT returns (IHT400/IHT205 equivalents), applying for the Grant of Probate or Letters of Administration, collecting funds, settling estate debts, preparing estate accounts, and distributing to beneficiaries.`
   - `keyStages`: `1. Asset & liability valuation; 2. Inheritance Tax reporting & Grant application; 3. Encashment of assets & settlement of liabilities; 4. Statutory creditor notices & final estate accounts; 5. Distribution & closure.`
   - `typicalTimescales`: `Obtaining the Grant typically takes 10 to 16 weeks; full uncontested estate administration usually completes within 6 to 12 months depending on HMRC clearance and property sales.`
   - `disbursementsGuidance`: `Common third-party costs include the Probate Court application fee, official copies of the Grant, statutory Section 27 Trustee Act notices (London Gazette and local newspaper), bankruptcy searches, and asset valuation fees.`
   - `exclusionsAndVatNote`: `Excludes contested probate claims, contentious beneficiary disputes, foreign asset resealing, and property conveyancing (quoted separately). VAT at 20% applies to our legal fees.`

3. **`work_type.employment_and_hr_tribunal_claims` (Employment Tribunal Claims):**
   - `headlineSummary`: `Employment Tribunal representation for unfair or wrongful dismissal claims is quoted based on case complexity (Simple, Medium, or High complexity) and anticipated hearing length.`
   - `serviceDescription`: `Covers taking instructions, reviewing employment records and grievance/disciplinary files, preparing claim or response forms (ET1/ET3), disclosure, witness statement drafting, schedule of loss preparation, ACAS/settlement discussions, and advocacy or instructing Counsel for hearings.`
   - `keyStages`: `1. Initial merits assessment & ACAS Early Conciliation review; 2. Pleadings (ET1/ET3) & Case Management Preliminary Hearing; 3. Disclosure of documents & witness statements; 4. Without-prejudice settlement negotiations; 5. Final Merits & Remedy Hearing.`
   - `typicalTimescales`: `Simple claims resolved before hearing commonly take 3 to 6 months; claims proceeding to a multi-day Final Hearing typically take 9 to 18 months depending on Employment Tribunal listing capacity.`
   - `disbursementsGuidance`: `Principal disbursements are Specialist Counsel's brief and refresher fees for preliminary or final hearings (quoted per day plus VAT) and any agreed expert medical/actuarial reports. Currently there is no Employment Tribunal issue fee.`
   - `exclusionsAndVatNote`: `VAT at 20% applies to our fees and Counsel's fees. Quotes do not cover appeals to the Employment Appeal Tribunal or unrelated County/High Court litigation.`

4. **`work_type.dispute_resolution_pre_action_correspondence` (Debt Recovery & Pre-Action Claims):**
   - `headlineSummary`: `Pre-action dispute resolution and uncontested debt recovery services are tailored to claim value, evidence complexity, and whether formal court proceedings are required.`
   - `serviceDescription`: `Covers reviewing contracts and correspondence, conducting debtor/insolvency searches, drafting formal Letters Before Claim complying with Pre-Action Protocols, handling without-prejudice correspondence, and advising on next steps if payment is not received.`
   - `keyStages`: `1. Document review & solvency checks; 2. Pre-Action Protocol Letter of Claim; 3. Reviewing debtor's response & settlement negotiation; 4. Reporting on litigation options if unresolved.`
   - `typicalTimescales`: `Initial Letter Before Claim preparation usually completes within 5 working days of onboarding; statutory pre-action response windows are typically 14 to 30 days depending on debtor type.`
   - `disbursementsGuidance`: `Court issue fees apply only if proceedings are later issued (HMCTS fee scale based on claim value, VAT-exempt). Company/insolvency search fees and tracing agent fees may apply where instructed.`
   - `exclusionsAndVatNote`: `VAT at 20% applies to our legal fees. Defended litigation, injunctions, or enforcement actions are quoted separately if the matter becomes contested.`

5. **`work_type.corporate_and_commercial` (Corporate & Commercial Practice Area Default):**
   - `headlineSummary`: `Corporate and commercial advisory matters are priced using transparent fixed fees for defined deliverables or estimated/capped hourly budgets agreed against seniority rate cards.`
   - `serviceDescription`: `Includes scoping commercial objectives, reviewing existing corporate constitutional or contractual documentation, drafting and negotiating transaction documents, and reporting on key legal and commercial risks.`
   - `keyStages`: `1. Initial scoping & instruction review; 2. First draft or mark-up; 3. Counterparty negotiation rounds; 4. Execution, filings & completion deliverables.`
   - `typicalTimescales`: `Routine commercial agreements usually complete within 2 to 4 weeks; multi-party transactions typically span 6 to 12 weeks subject to third-party responsiveness.`
   - `disbursementsGuidance`: `Companies House filing fees, specialist tax/regulatory input, and virtual data room charges (where applicable) are passed through at cost.`
   - `exclusionsAndVatNote`: `VAT at 20% applies to UK clients unless zero-rated/exempt; non-UK VAT treatment is confirmed at onboarding.`
