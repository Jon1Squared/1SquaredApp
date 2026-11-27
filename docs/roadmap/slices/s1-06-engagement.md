# S1-06: Client Care / Engagement Letters, Outbox PDF Dispatch, Signed-Copy Upload, Non-Engagement Letters, and Generic Chasing Engine

| | |
|---|---|
| Backlog | Row `5` (Engagement — Client care/engagement letter, terms of business, signature tracking, and non-engagement letters), item `B2` follow-through, Admin Email Outbox viewer (`Q1` / `R823`), and generic chasing foundation for items `3`, `5`, `6` |
| Decision | Stage 1 decisions `S1-D1`, `S1-D3`, `S1-D10`, `S1-D11`; Owner decisions 1, 2, 3, 4 & Q1, Q2, Q3, Q7, Q9 (26 Nov 2026); [ADR 0038](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md), Accepted [ADR 0040](../../decisions/0040-matter-opening-gate-and-numbering.md), Proposed [ADR 0042](../../decisions/0042-generic-communication-chasing-mechanism.md) |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP3 (`S1-06`) |
| Branch | `s1-06-engagement`, stacked on `s1-12-pms-money-pence`, targeting `develop` |
| Change class | Core extension API (additive v`2.4.0`, Rule 7); Core tenancy expand migration `0028` (`communication_chases`, `communication_chase_events`, `engagement_dispatches`, `documents.primary_enquiry_id`, nullable `matter_id`/`quote_id`/`enquiry_id` on `email_outbox`) + repositories; Core ADR 0030 scheduled job (`communication-chases` + `communication:run_chases`) & Bicep container job; Core config engine (`engagement.*`, `chasing.*`); Host services, actions, Admin Email Outbox viewer (`admin:access` + MFA, `R823`), evidence purpose decoupling (`R817`), and UI (`src/`); Demo config (`client-not-a-law-firm/` incl. `demo.json` `email.provider: "disabled"` in the `S1-06` build); Plain-English Help (`src/docs/`) |
| Layer | Core API (`core/src/api/`), Core domain & RBAC (`core/src/domain/`, `core/src/integrations/intake-checks/`), Core tenancy (`core/src/tenancy/`), Core config (`core/schemas/`, `core/src/config-engine/`), Infrastructure (`core/infra/`), Host server/routes/UI (`src/`), Client config (`client-not-a-law-firm/`) |
| Size | `L` (`2.5–3.0` days — Levers 1 & 2 applied + Admin Email Outbox viewer with `R823`) |
| Depends on | `S1-03` (outbox attachments & `e_signature` interface), `S1-05` (`recordEngagementLetterSignedAction` & opening gate), `S1-12` (WP3 dependency order); Proposed [ADR 0042](../../decisions/0042-generic-communication-chasing-mechanism.md) to be Accepted before coding |
| Blocking manual tasks | None in dev/test; **live email delivery blocked by Stage 1 §8 task** (in the **`S1-06` build**, `client-not-a-law-firm/config/environments/demo.json` sets `integrations.email.provider` to `"disabled"` so queued emails stay `'pending'` and readable in the Admin Email Outbox viewer; switching it back on alongside a demo sending mailbox is a Stage 1 §8 manual setup task) |
| Baseline | `develop` at `a7e606c` |

---

## 1. Change Class and Layer Breakdown

| Part | Change class | Layer |
|---|---|---|
| Additive `NON_ENGAGEMENT_DOCUMENT_TYPE = 'non_engagement'`, `EvidencePurpose`, `ChasingConfiguration`, `EngagementConfiguration`, additive `listEnvelopes` / `cancelManualRequest` / `recordCheckInTx` on `ESignatureProvider`, `CORE_API_VERSION = '2.4.0'` | Core extension API & config types (additive, Rule 7) | `core/src/api/index.ts`, `core/docs/CHANGELOG.md` |
| Job-only permission `'communication:run_chases'`; Container Apps job `caj-comm-chase-${env}` (`enableCommunicationChasesJob`); ADR 0030 runner registration | Core RBAC, CLI scheduler & Bicep infra | `core/src/domain/rbac/registry.ts`, `core/infra/main.bicep`, `core/infra/modules/platform.bicep`, `scripts/run-job.ts` |
| Migration `0028_engagement_and_chasing_expand` (`communication_chases`, `communication_chase_events`, `engagement_dispatches`, `documents.primary_enquiry_id`, `evidence_artifacts.purpose`, nullable `matter_id`/`quote_id`/`enquiry_id` on `email_outbox`), `TenantChasingRepository`, `TenantEngagementRepository`, `*InTx` helpers on `TenantIntakeCheckRepository`, visibility-scoped non-destructive Admin viewer methods on `TenantOutboxRepository` | Core tenancy schema & repositories | `core/src/tenancy/migrations/index.ts`, `core/src/tenancy/tenantScopedRepository.ts`, `core/src/tenancy/`, `core/src/tenancy/outboxRepository.ts`, `core/src/tenancy/intakeCheckRepository.ts` |
| Config schemas `engagement` & `chasing` (`enabled: false, sendEmails: false` safe defaults), Zod & deep-merge, demo defaults (`base.json` with approved Appendix A text; `demo.json` `integrations.email.provider = "disabled"` in `S1-06` build) | Core config engine & client config | `core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `client-not-a-law-firm/config/base.json`, `client-not-a-law-firm/config/environments/demo.json` |
| Outbox PDF dispatch (`sendEngagementLetterAction`, `sendNonEngagementLetterAction`), signed-copy upload requirement (`recordEngagementLetterSignedAction`), monotonic B2 state guard, `/api/evidence/*` stored-`purpose` decoupling (`R817`, `cdd` vs `engagement_signed`), `'engagement_letter'` handler in `communication-chases` (`chase:<chaseId>:step:<n>`, `R818`), Admin Email Outbox viewer actions & route (`listOutboxMessagesForAdminAction`, `getOutboxMessageForAdminAction`, `GET /api/admin/outbox/[id]/attachments/[ordinal]`, `R823`) | Host server services, actions & HTTP routes | `src/server/services.ts`, `src/server/documentGenerationServices.ts`, `src/server/actionPermissions.ts`, `src/app/actions.ts`, `src/app/api/evidence/`, `src/app/api/admin/outbox/` |
| Engagement letter dispatch/upload/chase panel on Matter Profile (Prospective & Active), Non-Engagement send workflow on declined enquiries/tasks, Admin Engagement & Chasing read-only summaries (Lever 1, `B35`) and Admin **Email Outbox** viewer tab (`admin:access` + MFA, `R823`) | Host UI | `src/components/MatterProfileClient.tsx`, `src/components/MatterFormClient.tsx`, `src/components/EnquiryDetailClient.tsx`, `src/components/AdminClient.tsx` |
| Plain-English Help (`engagement-letters.ts` new + updates), technical & release notes | Help & documentation (Rule 11) | `src/docs/`, `docs/` |

---

## 2. What Exists Today (`develop` at `a7e606c`)

1. **B2 engagement status model, `CLIENT_CARE_DOCUMENT_TYPE` & `generateDocumentService`:**
   - `Matter` (`src/domain/types.ts:1005–1007`) and `TenantMatterRecord` (`core/src/tenancy/matterRepository.ts:222–224`) carry `engagementLetterStatus: string`, `engagementLetterSentAt: string | null`, and `engagementLetterSignedAt: string | null`.
   - `public.matters.engagement_letter_status` (`core/src/tenancy/migrations/index.ts:975`) is a top-level `TEXT NOT NULL DEFAULT ''` column; `engagementLetterSentAt` and `engagementLetterSignedAt` live inside `public.matters.opening_record_json` JSONB (`core/src/tenancy/matterRepository.ts:474–477, 654–655`). Observed status values: `''`, `'Drafting'`, `'Drafted'`, `'Sent'`, `'Sent to client'`, `'Signed'`, `'Signed & returned'`.
   - `CLIENT_CARE_DOCUMENT_TYPE` (`core/src/api/index.ts:659`, `'client_care'`) is used by `src/components/DocumentTemplatesAdminPanel.tsx:4, 908` and `src/server/documentGenerationServices.ts:16, 605, 1737`.
   - `generateDocumentService` (`src/server/documentGenerationServices.ts:1592–1797`) calls `getMatterRepository().markEngagementLetterDraftedIfEligible` inside `withTenantTransaction` (`:1735–1751`), which locks `FOR UPDATE`, refuses regression from `{'Drafted', 'Sent', 'Sent to client', 'Signed', 'Signed & returned'}` (`core/src/tenancy/matterRepository.ts:3539–3549`), and sets `'Drafted'` + bumps `row_version` (`:3560–3569`). (Legacy unused `markEngagementLetterDrafted` in `src/server/services.ts:9850–9938` is called only by tests.)
   - **Temporary `S1-05` signed action & form state:** `recordEngagementLetterSignedAction` (`src/app/actions.ts:2219–2231`, `src/server/actionPermissions.ts:828–832` `'matter:edit'`) -> `recordEngagementLetterSignedRecord` (`src/server/services.ts:36715–36804`) stamps `engagementLetterSignedAt` and `'Signed'` / `'Signed & returned'` **without requiring any uploaded signed copy** and without writing an ADR 0038 `e_signature` record. In UI, `MatterProfileClient.tsx:1623–1656` shows "Mark engagement signed" **only when `isProspective`**, and `:4146–4152` never displays `engagementLetterSentAt`. Meanwhile `saveMatterRecord` (`services.ts:7380–7388, 8547–8560`) blocks caller-supplied signed statuses, **but still lets `MatterFormClient.tsx:12131–12169` move `'Sent'` backwards to `'Drafting'`/`'Drafted'`** and lets callers overwrite `input.engagementLetterSentAt`.
2. **Opening gate check (`isMatterEngagementSignedForGate`):**
   - `src/domain/openingGate.ts:29–49` (`isEngagementLetterSignedStatus` `:36–40`; `isMatterEngagementSignedForGate` `:42–49` checks `Boolean(matter.engagementLetterSignedAt?.trim()) || isEngagementLetterSignedStatus(matter.engagementLetterStatus)`), called by `evaluateOpeningPreconditions` (`:370–390`, `src/server/services.ts:6430, 36369`) and `MatterProfileClient.tsx:1625`. Note `src/domain/matterOpeningRecord.ts:946–948` checks status strings only (omitting `engagementLetterSignedAt`) and `MatterProfileClient.tsx:285–292` duplicates the string check.
3. **`non_engagement_letter` task in `closeEnquiryRecord`:**
   - `closeEnquiryRecord` (`src/server/services.ts:16805–17080`, specifically `:16980–17071`) cleans up orphan enquiry contacts (`:16941–16976`), saves the closed enquiry (`:16978`), then — when `prevStatus !== 'Draft' && targetStatus !== 'No response' && !['went_elsewhere', 'no_response'].includes(closeReasonSystemKey)` (`:16982–16989`) — raises a deduplicated `non_engagement_letter` task assigned to the active enquiry assignee (due `+2` working days).
   - All 7 `enquiry_close_reason` `systemKey`s (`conflict`, `outside_expertise`, `not_viable`, `went_elsewhere`, `no_response`, `referred_out`, `other`) match across `src/seed/lists.ts:412–426`, `data/seed-not-a-law-firm.json:3581–3645`, and migration `0021` (`core/src/tenancy/migrations/index.ts:2850–2856`). No non-engagement letter generator or email dispatch exists yet.
4. **Outbox, `email_outbox_attachments`, size cap, drain sites & absence of outbox UI:**
   - `0019` creates `public.email_outbox` (`migrations/index.ts:2585–2654`, status `'pending' | 'sending' | 'sent' | 'dropped_allowlist' | 'failed_permanent'`, `UNIQUE (tenant_id, idempotency_key)`). `0023` creates `public.email_outbox_attachments` (`:3038–3101`, `BYTEA NOT NULL`, cascading delete).
   - `MAX_EMAIL_TOTAL_ATTACHMENT_BYTES = 3_000_000` (exact `3,000,000` bytes, `core/src/api/index.ts:1982`) is enforced fail-closed in `TenantOutboxRepository.enqueueEmail` (`core/src/tenancy/outboxRepository.ts:493–498`, throwing `EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED`) and `CoreEmailDispatcher.send` (`core/src/integrations/email/adapters.ts:391–397`).
   - `scrubExpiredOutboxContent` (`outboxRepository.ts:991–1066`, `outboxContentRetentionDays` default `30` days at `:49`) deletes `email_outbox_attachments` rows and nulls bodies/recipients only on terminal statuses (`sent | dropped_allowlist | failed_permanent` at `:1036`, leaving `'pending'` rows intact while email is `'disabled'`).
   - **All 5 drain call sites** (`src/server/services.ts:13477, 13597, 16790, 33333, 33909`) invoke `drainEmailOutboxForTenant` without passing `storageProvider`, so attachment bytes **must** be enqueued as `kind: 'inline'` inside `email_outbox_attachments`.
   - **Outbox inspection UI & demo email provider (resolved by Owner Q1 & Q9, 26 Nov 2026):** `listOutboxRecords` (`outboxRepository.ts:1090–1116`) currently has zero callers in `src/`, `getClaimedOutboxAttachmentBytes` (`:710–766`) requires `status = 'sending'` + `claimToken` (no non-destructive read method exists for `'pending'` or `'sent'` rows), and `client-not-a-law-firm/config/environments/demo.json:19–31` currently sets `"provider": "graph"`. Per Owner Q1 & Q9, `S1-06` adds an MFA-gated, visibility-scoped Admin **Email Outbox** viewer (`R823`) and sets `demo.json` `integrations.email.provider` to `"disabled"` (during the `S1-06` build, not during planning) so queued emails remain `'pending'` and readable in the viewer.
5. **Seeded document templates & Item 46 PDF converter (`S1-10`):**
   - `data/seed-not-a-law-firm.json` holds `0` templates; lazy demo seeding (`src/server/documentGenerationServices.ts:448–810`) seeds 3 templates (`TPL-SEED-CCL` `'client_care'` via `buildSeedClientCareTemplateDocxBytes` in `src/domain/documentGeneration.ts:1050–1142`, `TPL-SEED-CORR`, `TPL-SEED-ATT`) only when `existingTemplates.length === 0` (`:539`). No non-engagement template exists, and `CORE_FIELD_CATALOGUE` (`core/src/domain/document-generation/fieldCatalogue.ts:146–1031`) has no `'enquiry'` field group (`sourceContexts` accepts `'matter' | 'client'` only).
   - Item 46 PDF conversion (`core/src/domain/document-generation/pdfConverter.ts:242–799`, `selectDocumentPdfConverter` `:762–799`, `DOC_CONVERTER_URL` injected into web + all jobs in `platform.bicep:948–1771`, `demo.json:7–10` sets `'container'` with `'builtin'` fallback). **TX caveat:** `generateDocumentService` currently calls `generateDocumentFromTemplate` (and `converter.convertDocxToPdf` HTTP I/O) *inside* `repo.withTenantTransaction` (`src/server/documentGenerationServices.ts:1695–1767`); new WP3 email/PDF flows must render PDF bytes **before** opening `withTenantTransaction`.
6. **ADR 0038 `e_signature` & `'evidence'` upload/download permission coupling:**
   - `ESignatureProvider` (`core/src/api/index.ts:2365–2417`) and `ManualESignatureProvider` (`core/src/integrations/intake-checks/manualProviders.ts:348–433`) exist behind `integrations.intakeChecks.eSignature.provider = 'manual'` (`adapters.ts:44–108`) and `public.intake_check_records` (`migrations/index.ts:3049–3077`), but are currently unwired in `src/`.
   - `/api/evidence/upload` and `/api/evidence/download` (`src/server/actionPermissions.ts:939–948`, `src/server/services.ts:32291–32296, 32442–32447`, `verifyEvidenceRefsOwnedInTx` `:30693–30727`) currently hardcode `cdd:record` / `cdd:view` even though `VALID_EVIDENCE_SUBJECT_TYPES` (`:31922–31929`) includes `'matter'` and `assertActorCanAccessEvidenceSubject` (`:32066–32083`) already checks `canPersonAccessMatter`. Any role/override holding `matter:edit` without `cdd:record` would be blocked on signed engagement uploads unless `purpose` permission routing is decoupled.

---

## 3. Design & Functional Specification

### 3.1 Server-side monotonic B2 state machine & Client Care sending
1. **Strict monotonic status transitions (server-controlled):**
   - Progression order: `'' | 'Drafting'` (`0`) -> `'Drafted'` (`1`) -> `'Sent'` / `'Sent to client'` (`2`) -> `'Signed'` / `'Signed & returned'` (`3`).
   - `saveMatterRecord` continues blocking client-supplied signed statuses (`7380–7388`), **additionally blocks moving backwards** once a matter has reached `'Drafted'`, `'Sent'`/`'Sent to client'`, or `'Signed'`/`'Signed & returned'`, and ignores client-supplied `input.engagementLetterSentAt` (only `sendEngagementLetterRecord` sets `engagementLetterSentAt`). `MatterFormClient.tsx:12131–12169` disables regressive picklist choices whenever `rank >= 2` (`Sent` or higher).
2. **`sendEngagementLetterAction` (Send Client Care / Engagement Letter by email with PDF):**
   - **Sources:** Either attach an already-generated active `'client_care'` PDF from `public.documents` belonging to the matter (`sourceDocumentId`), **or** generate and persist the Client Care document + PDF cleanly on demand from `TPL-SEED-CCL` / active `'client_care'` template (or structured fallback builder when no template exists in a fresh non-demo tenant) — merging in tenant `engagement.clientCareTerms` where configured.
   - **Pre-TX PDF render & size guard (S1-D11):** Convert `.docx` to PDF via `selectDocumentPdfConverter` **before** opening `withTenantTransaction` (using fallback policy). Check `pdfBytes.byteLength <= MAX_EMAIL_TOTAL_ATTACHMENT_BYTES` (`3_000_000` bytes). If exceeded, fail closed with `EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED` and plain-English user message (`"The generated letter PDF exceeds the 3 MB email attachment limit. Remove large embedded images or download and split the document before sending."`), writing zero outbox rows and logging zero attachment bytes or PII.
   - **Atomic TX (`withTenantTransaction`):** Lock `matters FOR UPDATE` (verify `canPersonAccessMatter` + non-regressive status), validate recipient email via `isValidEmailAddress`, enqueue email to `public.email_outbox` (populating nullable `matter_id = matter.id` via `0028` for `R823` outbox filtering) + inline PDF into `public.email_outbox_attachments` (`idempotency_key: 'engagement:client_care:<matterId>:<versionOrDispatchKey>'`), insert `engagement_dispatches` (`kind = 'client_care'`), record ADR 0038 `e_signature` `'requested_manual'` via `TenantIntakeCheckRepository` inside TX, update `matters.engagement_letter_status = 'Sent'`, stamp `engagementLetterSentAt`, upsert/reactivate active `communication_chases` (`entity_kind = 'engagement_letter'`, `matter_id`, `sent_at`, `next_step_index = 1`, `next_action_at = sent_at + firstChaseDays`) when `chasing.engagementLetter.enabled === true`, and write zero-PII audit entry (`'Engagement letter sent'`).
   - **Post-commit:** Call best-effort `drainEmailOutboxForTenant` (returning `"Email queued in outbox"` honestly when `email.provider === 'disabled'`, never claiming delivery!). Re-sending a client-supplied identical `idempotencyKey` is strictly idempotent; intentional resends create a new dispatch record (resetting or advancing the active chase intentionally while cancelling the superseded chase cleanly).
3. **`recordEngagementLetterSignedAction` (Signed-copy upload required & `R817` stored-purpose download):**
   - Replace `S1-05`'s provisional mark-signed-only flow: callers MUST supply `evidenceArtifactId` (`POST /api/evidence/upload` with `subjectType: 'matter'`, `purpose: 'engagement_signed'`, malware pre-scanned before storage, magic-byte verified PDF/JPEG/PNG).
   - Pre-TX: call `verifyEvidenceArtifacts` against storage blob & SHA-256 (`ADR 0039` §2).
   - Inside TX: verify `evidence_artifacts` row belongs to `matterId` with **stored `purpose === 'engagement_signed'`** (rejecting `'cdd'` and `'moa_receipt'` files) and `scan_status = 'clean'`, write ADR 0038 `e_signature` `'signed_uploaded'` with `evidenceRefs`, transition `matters.engagement_letter_status = 'Signed & returned'` (`engagementLetterSignedAt = nowIso`, updating `opening_record_json` + incrementing `row_version`), mark latest `engagement_dispatches` row signed, **immediately stop** any active `'engagement_letter'` `communication_chases` row (`status = 'stopped'`, `stopped_reason = 'signed'`), and write zero-PII audit entry (`'Engagement letter signed'`).
   - **Stored-purpose enforcement across CDD & downloads (`R817`):**
     - Download links use strictly **`GET /api/evidence/download?token=...`** (no `&purpose=` query parameter in the URL; any `purpose` supplied in a download request is ignored). `downloadEvidenceArtifactRecord` and download-token issuance branch permission and subject checks **only on the stored `evidence_artifacts.purpose`** (`'cdd'` -> `cdd:view` + `R747`; `'engagement_signed'` -> `subjectType === 'matter'` + `document:view` or `matter:edit` + `canPersonAccessMatter`; `'moa_receipt'` -> `subjectType === 'matter'` + `money_on_account:view` / `money_on_account:record_receipt` / `document:view` + `canPersonAccessMatter`), returning the **exact same opaque refusal** (`NOT_FOUND` / HTTP `404` `'Evidence file not found or access denied.'`) whether the file does not exist, belongs to another tenant, or is disallowed by stored purpose (so there is zero existence oracle).
     - **Every CDD path that attaches evidence** (`verifyEvidenceRefsOwnedInTx` at `src/server/services.ts:30693–30727`, `saveCddRecord`, `upgradeCddToHighRisk`, and `R747` checks) **requires a stored `purpose` of `'cdd'`**: `engagement_signed` and `moa_receipt` files can never be attached as CDD evidence, and `'cdd'` files can never be attached as signed engagement copies.
   - Available in UI on **both Prospective and Active** matters whenever not yet signed (fixing `MatterProfileClient.tsx:1623` prospective-only gate); displays signed timestamp, acting person name (resolved safely), and scoped download link (`GET /api/evidence/download?token=...`), plus historical compatibility when pre-`S1-06` matters already have `'Signed & returned'` stamped in `S1-05`/seed.

### 3.2 Non-Engagement Letters (`closeEnquiryRecord` task -> Generate, Email + PDF, Complete)
- Triggered either from the open `non_engagement_letter` task (raised by `closeEnquiryRecord`) or directly from a closed/declined Enquiry screen (`EnquiryDetailClient.tsx`, gated on `enquiry:edit` / `matter:edit` / `document:generate` + enquiry visibility).
- **Approved Lever 2 (`B36`, Owner Q2):** Build the Non-Engagement letter DOCX from firm profile, enquiry metadata (`reference`, subject/contact name/email/address cleanly resolved), configured `engagement.nonEngagementWording` keyed by `enquiry_close_reason.systemKey` (`conflict`, `outside_expertise`, `not_viable`, `referred_out`, `defaultFallback` — ensuring `conflict` wording **never reveals** confidential conflicting party/matter names!), convert to PDF via `selectDocumentPdfConverter` outside TX, check `<= 3_000_000` bytes, save document metadata in `public.documents` (with `primary_enquiry_id` populated) + `public.document_links`, enqueue outbox (populating `enquiry_id = enquiry.id` on `public.email_outbox` for `R823`) + `email_outbox_attachments` (`kind: 'inline'`), insert `engagement_dispatches` (`kind = 'non_engagement'`), and automatically complete open `non_engagement_letter` task(s) on that enquiry (`status = 'Done'`). *(No `'engagement_letter'` chase is started for non-engagement letters.)*

### 3.3 Generic Chasing Job (`communication-chases`, ADR 0042)
- Ships the shared `communication_chases` & `communication_chase_events` tables, `TenantConfiguration.chasing` config engine, `caj-comm-chase-${env}` Bicep job (`08:00` local time), and `executeCommunicationChasesForTenant` runner.
- Registers the `'engagement_letter'` handler first (uniform **7 / 14 / 21** day defaults confirmed by Owner Q3):
  - Stops immediately as `'signed'` if `isMatterEngagementSignedForGate(matter)` is `true`, or `'withdrawn'` if the matter was deleted/closed/abandoned before engagement (`systemKey === 'closed'`).
  - Day `7` (`firstChaseDays`): enqueues friendly reminder email (**`idempotency_key: 'chase:<chaseId>:step:1'`**, keyed on `communication_chases.id` per `R818` so re-sending after stopping creates a new `chaseId` without collision, and populating `matter_id` on `email_outbox` per `R823`).
  - Day `14` (`secondChaseDays`): enqueues firmer second reminder email (**`idempotency_key: 'chase:<chaseId>:step:2'`**).
  - Day `21` (`escalateTaskDays`, confirmed Q3): creates a deduplicated task assigned to the matter's active fee earner (else partner/supervisor with verified `canPersonAccessMatter` — safe for staff/ethical-wall matters!) and sets chase `status = 'completed'`.
- Adding `'quote'` in `S1-07` and `'money_on_account'` in `S1-08` requires only registering two adapters — zero schema, Bicep, or scheduler changes.

### 3.4 Admin Email Outbox Viewer (Owner Q1 & `R823`)
- **Matter / quote / enquiry linkage (`email_outbox` in `0028`):** Add nullable `matter_id TEXT NULL`, `quote_id TEXT NULL`, and `enquiry_id TEXT NULL` columns (with supporting indexes) directly to `public.email_outbox` in migration `0028`. *(Chosen over multi-table joins across `engagement_dispatches`, `quotes`, `money_on_account_requests`, and `communication_chase_events` because `0028` lands before `0029`/`0030`, keeps SQL visibility uniform across every WP3 and notification email, and mirrors `public.notifications.matter_id` from `0020`.)* Every WP3 email enqueue call (`S1-06`, `S1-07`, `S1-08`) populates these link columns.
- **Restricted-matter & barrier SQL filtering (Admin NOT exempt):** `TenantOutboxRepository.listVisibleOutboxRecordsForAdmin`, `getVisibleOutboxRecordForAdmin`, and `getVisibleOutboxAttachmentForAdmin` filter directly in SQL using **`buildMatterHiddenFromViewerSql`** (when `matter_id IS NOT NULL`), **`QUOTE_VISIBLE_SQL_PREDICATE`** (when `quote_id IS NOT NULL`), and **`ENQUIRY_VISIBLE_SQL_PREDICATE`** (when `enquiry_id IS NOT NULL`) against the acting administrator's `viewerId` and `hasRestrictedMatterAccess` (`admin` does not hold `matter:restricted:access` by default, and under `S1-09` barriers exclude everyone not on the allow-list). Hidden or cross-tenant outbox/attachment IDs fail closed with uniform `NOT_FOUND` (zero existence oracle).
- **Audited message viewing & non-destructive attachment download:**
  - `listOutboxMessagesForAdminAction` (`admin:access` + `mfaVerified: true`) returns list summary metadata only (status, recipient, subject, template key, timestamps, attachment summaries) — never bulk-loading message bodies.
  - `getOutboxMessageForAdminAction` (`admin:access` + `mfaVerified: true`) re-verifies SQL visibility, loads the single message body, and writes a zero-PII `audit_entries` record (`recordType: 'email_outbox'`, `recordId: outboxId`, `action: 'view'`, `field: 'Outbox message inspected'`).
  - `GET /api/admin/outbox/[id]/attachments/[ordinal]` (`admin:access` + `mfaVerified: true`) reads inline PDF/attachment bytes non-destructively from `public.email_outbox_attachments` (regardless of `'pending'` vs `'sent'` status, without claiming/mutating `email_outbox.status`) after SQL visibility verification, and writes a zero-PII `audit_entries` record (`recordType: 'email_outbox_attachment'`, `recordId: '${outboxId}:${ordinal}'`, `action: 'download'`, `field: 'Outbox attachment downloaded'`).
- **Zero CDD values (`R812`):** Outbox viewer SQL queries and DTOs never select, project, or display `amlStatus`, `amlCompletedAt`, or client CDD outcomes.
- **Admin UI (`AdminClient.tsx`):** Adds an **Email Outbox** tab (behind `admin:access` + MFA) showing filterable status (`pending`, `sent`, `dropped_allowlist`, `failed_permanent`), recipient, subject, template, created/sent timestamps, expandable/modal message detail (triggering `getOutboxMessageForAdminAction`), and clickable PDF attachment links.

---

## 4. Data Model, Expand Migration `0028`, Backfill & Rollback Plan

- **Migration ID:** `0028_engagement_and_chasing_expand` (`CORE_REQUIRED_SCHEMA_VERSION = '0028'`, `dependsOn: ['0001', '0009', '0010', '0019', '0023', '0025']`).
- **`upSql`:**
  1. `CREATE SEQUENCE IF NOT EXISTS public.tenant_communication_chase_id_seq START WITH 1 INCREMENT BY 1;`
  2. `CREATE SEQUENCE IF NOT EXISTS public.tenant_communication_chase_event_id_seq START WITH 1 INCREMENT BY 1;`
  3. `CREATE SEQUENCE IF NOT EXISTS public.tenant_engagement_dispatch_id_seq START WITH 1 INCREMENT BY 1;`
  4. `CREATE TABLE IF NOT EXISTS public.communication_chases (...)` + `uq_communication_chases_active` + `idx_communication_chases_due` + `idx_communication_chases_matter` (full schema in [ADR 0042 §1](../../decisions/0042-generic-communication-chasing-mechanism.md#1-generic-per-tenant-data-model-0028_engagement_and_chasing_expand)).
  5. `CREATE TABLE IF NOT EXISTS public.communication_chase_events (...)` + `UNIQUE (tenant_id, chase_id, step_index)`.
  6. `CREATE TABLE IF NOT EXISTS public.engagement_dispatches` (`tenant_id`, `id`, `kind IN ('client_care', 'non_engagement')`, `matter_id NULL`, `enquiry_id NULL`, `document_id NULL`, `outbox_email_id NULL`, `recipient_email`, `recipient_name`, `status IN ('sent', 'signed', 'withdrawn')`, `sent_at`, `sent_by_person_id`, `signed_evidence_artifact_id NULL`, `signed_at NULL`, `signed_by_person_id NULL`, `intake_check_record_id NULL`, `idempotency_key`, `created_at`; `PRIMARY KEY (tenant_id, id)`, `UNIQUE (tenant_id, idempotency_key)`).
  7. Expand `public.evidence_artifacts` (`0025`) with additive `purpose TEXT NOT NULL DEFAULT 'cdd' CHECK (purpose IN ('cdd', 'engagement_signed', 'moa_receipt', 'general'))` (`R817`).
  8. Expand `public.documents` (`0001`) with nullable `primary_enquiry_id TEXT NULL` + index `idx_documents_tenant_enquiry`.
  9. Expand `public.email_outbox` (`0019`) with nullable `matter_id TEXT NULL`, `quote_id TEXT NULL`, `enquiry_id TEXT NULL` + indexes `idx_email_outbox_tenant_matter`, `idx_email_outbox_tenant_quote`, `idx_email_outbox_tenant_enquiry` (`R823` outbox viewer visibility linkage).
- **Backfill policy:** Zero backfill of `communication_chases` on existing `'Sent'` matters or legacy enquiries (`existing` pre-WP3 letters remain readable/signable via signed-copy upload without unexpected retroactive chase emails). Existing `evidence_artifacts` rows default cleanly to `'cdd'`.
- **Reversible `downSql`:** Drops `idx_email_outbox_tenant_enquiry`, `idx_email_outbox_tenant_quote`, `idx_email_outbox_tenant_matter`, `email_outbox.{enquiry_id, quote_id, matter_id}`, `idx_documents_tenant_enquiry`, `documents.primary_enquiry_id`, `evidence_artifacts.purpose`, `engagement_dispatches`, `communication_chase_events`, `communication_chases`, and all three sequences cleanly (`up -> down -> up` round-trip verified).

---

## 5. Configuration Schema Changes & Runtime Usage Compliance

All keys validated in `core/schemas/tenant-config.schema.json` + Zod (`core/src/config-engine/index.ts`), deep-merged in `loadAndValidateTenantConfig`, overridden in `public.tenant_module_configs`, and read cleanly at runtime to keep `core/tests/tenant-config-usage.test.ts` green:

1. **`chasing` subtree (`tenant-config.schema.json`, `tenant_module_configs['communication_chasing']`):**
   - `chasing.{engagementLetter, quote, moneyOnAccount}` (uniform `7 / 14 / 21` day defaults confirmed by Owner Q3):
     - `enabled` (`boolean`, **core default `false`**, demo `true`, `"Enables automated chasing progression for this communication kind."`)
     - `sendEmails` (`boolean`, **core default `false`**, demo `true`, `"When enabled alongside chasing, sends scheduled email reminders; when false, skips client email steps while retaining escalation tasks."`)
     - `firstChaseDays` (`integer`, min `1`, max `90`, default `7`)
     - `secondChaseDays` (`integer`, min `2`, max `180`, default `14`, must be `> firstChaseDays`)
     - `escalateTaskDays` (`integer`, min `3`, max `365`, default `21`, must be `> secondChaseDays`)
2. **`engagement` subtree (`tenant-config.schema.json`, `tenant_module_configs['engagement_config']`):**
   - `engagement.clientCareIntroductoryParagraph` (`string`, default `""` in core; populated in `base.json` from Appendix A)
   - `engagement.clientCareTermsSummary` (`string`, default `""` in core; populated in `base.json` from Appendix A)
   - `engagement.clientCareSignatureInstruction` (`string`, default `""` in core; populated in `base.json` from Appendix A)
   - `engagement.nonEngagementWording` (`object` with keys `conflict`, `outside_expertise`, `not_viable`, `referred_out`, `defaultFallback`, each `{ subjectTemplate: string, bodyParagraphs: string[] }`, default empty `""`/`[]` in core; populated in `base.json` from Appendix A)
   - **Approved Lever 1 (`B35`, Owner Q2):** Ship `saveChasingConfigAction` & `saveEngagementConfigAction` (`admin:access` + `mfaVerified: true`) + schema + validation + tests + read-only Admin summary card in `AdminClient`, with interactive Admin wording/schedule editors tracked in `B35`.
3. **Demo email provider (`client-not-a-law-firm/config/environments/demo.json`, Owner Q9):**
   - During the **`S1-06` build** (not during planning), update `integrations.email.provider` in `demo.json` from `"graph"` to `"disabled"` so queued demo emails stay `'pending'` and readable in **Administration → Email Outbox**. Switching `integrations.email.provider` back on alongside provisioning a demo sending mailbox remains a Stage 1 §8 manual task.

---

## 6. Permissions, Action/Route/Job Policies, Role Matrix & MFA

### New job-only permission (`core/src/domain/rbac/registry.ts`)
- `'communication:run_chases'` (`domain: 'intake'`, `sensitivity: 'critical'`, `jobOnly: true`) — counts move `81/71/10 -> 82/71/11` across all 5 RBAC test files. Excluded from every user role including `admin`.

### Action & Route policies (`src/server/actionPermissions.ts`, `MAX_KNOWN_GAPS = 0`, `ROUTE_PERMISSIONS` `16 -> 17`)
- `sendEngagementLetterAction` -> `matter:edit` (`enforcedBy: 'action'`)
- `stopCommunicationChaseAction` -> `{ anyOf: ['matter:edit', 'quote:edit'] }` (`enforcedBy: 'service'`, checking kind access)
- `sendNonEngagementLetterAction` -> `{ anyOf: ['enquiry:edit', 'enquiry:close', 'matter:edit'] }` (`enforcedBy: 'action'`)
- `recordEngagementLetterSignedAction` -> `matter:edit` (`enforcedBy: 'action'`, now requires verified `evidenceArtifactId` with stored `purpose === 'engagement_signed'`)
- `saveEngagementConfigAction` -> `admin:access` + `mfaVerified: true` (`enforcedBy: 'service'`)
- `saveChasingConfigAction` -> `admin:access` + `mfaVerified: true` (`enforcedBy: 'service'`)
- `listOutboxMessagesForAdminAction` -> `admin:access` + `mfaVerified: true` (`enforcedBy: 'service'`, SQL-scoped by `buildMatterHiddenFromViewerSql`, `R823`)
- `getOutboxMessageForAdminAction` -> `admin:access` + `mfaVerified: true` (`enforcedBy: 'service'`, SQL-scoped + writes `view` audit entry, `R823`)
- `GET /api/admin/outbox/[id]/attachments/[ordinal]` -> `admin:access` + `mfaVerified: true` (`enforcedBy: 'service'`, SQL-scoped + writes `download` audit entry, `R823`)
- `JOB_PERMISSIONS['communication-chases']` -> `'communication:run_chases'` (`jobOnly: true`, local hour `8`)
- **`POST /api/evidence/upload` & `GET /api/evidence/download` stored-purpose decoupling (`R817`):**
  - `ROUTE_PERMISSIONS` widens the outer gate to `{ anyOf: ['cdd:record', 'matter:edit'] }` (upload; further extended with `'money_on_account:record_receipt'` in `S1-08`) and `{ anyOf: ['cdd:view', 'matter:edit', 'document:view'] }` (download; further extended with `'money_on_account:view'` / `'money_on_account:record_receipt'` in `S1-08`).
  - **Upload:** validates request `purpose` (`'cdd' | 'engagement_signed' | 'moa_receipt'`), checks exact purpose upload permission and compatible `subjectType` (`'cdd'` -> `cdd:record` + `R747`; `'engagement_signed'` -> `subjectType === 'matter'` + `matter:edit` + `canPersonAccessMatter`), and stores `purpose` immutably.
  - **Download:** **ignores any `purpose` parameter in the request** and branches permission & subject checks **exclusively on the stored `evidence_artifacts.purpose`** (`'cdd'` -> `cdd:view` + `R747`, blocking `admin` & `finance` strictly; `'engagement_signed'` -> `subjectType === 'matter'` + `document:view` / `matter:edit` + `canPersonAccessMatter`). Refused downloads return the exact same opaque `NOT_FOUND` (`404` `'Evidence file not found or access denied.'`) as non-existent or cross-tenant artifacts (zero existence oracle).
  - **Attachment checks:** every CDD path (`verifyEvidenceRefsOwnedInTx`, `saveCddRecord`, `upgradeCddToHighRisk`, `R747`) requires stored `purpose === 'cdd'`, and `recordEngagementLetterSignedRecord` requires stored `purpose === 'engagement_signed'`.

### Built-in Role Matrix (`S1-06`)

| Capability | Partner / Managing Partner | Fee Earner | Supervisor | Legal Secretary | Risk & Compliance | Finance | Enquiries / Intake | Admin |
|---|---|---|---|---|---|---|---|---|
| Generate & send Client Care letter (`matter:edit`) | Yes | Yes | Yes | Yes | Yes | No | No | Yes* |
| Chase / stop Engagement chase (`matter:edit`) | Yes | Yes | Yes | Yes | Yes | No | No | Yes* |
| Upload/download signed copy (`purpose: engagement_signed`) | Yes | Yes | Yes | Yes | Yes | Download only* (`document:view`) | No | Yes* |
| Upload/download CDD evidence (`cdd:record`/`cdd:view`) | Yes | Yes | Yes | Yes | Yes | **No** | **No** | **No** |
| Send Non-Engagement letter (`enquiry:edit`) | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes* |
| Configure Terms & Chase Schedule (`admin:access` + **MFA**) | MP / Partner | No | No | No | No | No | No | Yes (**MFA**) |
| View Email Outbox & download attachments (`admin:access` + **MFA**) | MP / Partner* | No | No | No | No | No | No | Yes* (**MFA**) |

*\*Subject to `canPersonAccessMatter` / `buildMatterHiddenFromViewerSql` (Admin cannot access matters hidden by restrictions/barriers).*

---

## 7. Visibility, Isolation, `R812` CDD Redaction & `S1-09` Composition

1. **Restricted/staff matters & `S1-09` composition:**
   - All `engagement_dispatches`, `communication_chases` (`matter_id`), `email_outbox` viewer queries (`matter_id`, `quote_id`, `enquiry_id`), and `evidence_artifacts` (`subject_id = matterId`) enforce `canPersonAccessMatter` / `buildMatterHiddenFromViewerSql` on every read/write/download/stop (Admin is **not** exempt).
   - `communication-chases` attaches `matterId` to every escalation task and notification so `canRecipientReceiveNotification` (`services.ts:13040–13381`) suppresses alerts for restricted-matter non-participants (`B19`).
   - Carrying indexed `matter_id` on `communication_chases`, `engagement_dispatches`, and `email_outbox` lets `S1-09` compose `NOT ${buildMatterHiddenFromViewerSql(...)}` directly onto all three tables.
2. **`R812` CDD-redaction rule compliance:**
   - Any new/updated loader (`loadMatterDetailPageData`, `loadEnquiryDetailPageData`, `loadAdminPageData`) passes through `withPageShell` (`redactMatterCddInBrowserPayload`).
   - `EngagementDispatchRecord`, `CommunicationChaseSummary`, `EmailOutboxAdminView` DTOs, and Client Care / Non-Engagement PDF merge fields **never** read, copy, or embed matter `amlStatus`, `amlCompletedAt`, or client CDD outcomes (`matters` CDD fields never appear under alternate keys on dispatches, chases, or outbox viewer rows).
   - Non-Engagement letters for `conflict` close reason include **no** conflicting client/matter identifiers.
3. **Rule 9 two-tenant & tampered-ID guarantees:**
   - `ScopedDownloadToken` / `evidenceArtifactId`, `matterId`, `enquiryId`, `chaseId`, `outboxId` all verify `ctx.tenantId` inside `withTenantTransaction`. `communication-chases` passes `ctx.tenantId` on every chase and outbox email (`enqueueEmail`).

---

## 8. Help and Documentation (Rule 11 & Stage 1 §6 Rule 6)

Plain British English for firm users (zero code names, error codes, or migration numbers):
- **New article:** `src/docs/articles/engagement-letters.ts` (registered in `src/docs/registry.ts` under `matters-enquiries` / `documents-dms`): explains sending a Client Care letter by email with its PDF attached, how queued outbound emails can be reviewed in **Administration → Email Outbox** (with multi-factor authentication, visibility restricted to matters the administrator is permitted to see, and every view/download logged in the audit log), automatic reminders at 7 and 14 days and day-21 fee-earner escalation tasks, uploading the client's signed copy (PDF or image) to unlock the opening gate, why statuses never move backwards, and generating/sending a Non-Engagement letter to close the follow-up task when an enquiry does not proceed.
- **Updated articles:** `src/docs/articles/matter-opening-and-risk.ts` (replace `S1-05` "Mark engagement signed" button description with signed-copy upload requirement), `src/docs/articles/document-generation.ts` (cover sending generated Client Care & Non-Engagement PDFs), `src/docs/articles/matters-enquiries-tasks-and-navigation.ts` (non-engagement send & chase tasks), `src/docs/articles/tenant-settings.ts` (configuring engagement terms, non-engagement wording, chase schedules, and using **Administration → Email Outbox**).
- **Technical docs:** Document `ADR 0042`, migration `0028`, `CORE_API_VERSION = '2.4.0'`, `R817`/`R818`/`R823`, and `caj-comm-chase-<env>` in `docs/guides/platform-technical-notes.md` and `docs/release-notes.md`.

---

## 9. Tests, Guards & Build-Phase Test Cadence

1. **Migration round-trip (`core/tests/migrations-postgres.test.ts`):** `0028` `up -> down -> up` cleanly after `0027` (including `email_outbox.{matter_id, quote_id, enquiry_id}`).
2. **Unit & config (`core/tests/chasing-config-s106.test.ts`, `core/tests/tenant-config-usage.test.ts`):** safe core defaults (`enabled: false, sendEmails: false`), ascending day validation (`1 <= 7 < 14 < 21`), monotonic B2 rank checks, 3 MB PDF cap rejection (`EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED`), non-engagement `conflict` zero-leakage check.
3. **Two-tenant PG16 isolation, RBAC, outbox PDFs, outbox viewer & chasing (`core/tests/engagement-workflow-s106.test.ts`):**
   - Generate/send Client Care PDF -> verifies `email_outbox` (`matter_id` populated) + `email_outbox_attachments` bytes (`%PDF-`) + `engagement_dispatches` + `intake_check_records` (`e_signature` `'requested_manual'`) + `communication_chases` `'active'` + `matters.engagement_letter_status = 'Sent'`.
   - Regression attempts (`saveMatterRecord` attempting `'Sent' -> 'Drafted'` or `'Signed' -> 'Sent'`) blocked fail-closed; recording signed without clean uploaded `evidenceArtifactId` rejected (`ENGAGEMENT_SIGNED_COPY_REQUIRED`); uploading clean signed copy transitions to `'Signed & returned'`, sets `e_signature` `'signed_uploaded'`, **stops active chase immediately**, and satisfies `requireEngagementSigned` on opening gate.
   - **Evidence purpose isolation tests (`R817`):**
     - **As Finance**, request a CDD artifact while passing `purpose=engagement_signed` -> **refused with the exact same opaque `NOT_FOUND` response as a missing artifact, with zero sign of whether the file exists**; positive control: Finance downloads a stored `purpose = 'engagement_signed'` file on an accessible matter.
     - Attaching an `'engagement_signed'` or `'moa_receipt'` artifact to a CDD record (`saveCddRecord` / `verifyEvidenceRefsOwnedInTx`) is refused; attaching a `'cdd'` artifact to `recordEngagementLetterSignedAction` is refused.
   - **Generic scheduler `communication-chases` & chase re-send test (`R818`):** day 7 chase email queued + drained, day 14 second email queued, day 21 fee-earner task raised + `'completed'`; `Promise.all` concurrent run executes step 1 at most once (`uq_communication_chase_events_step`); **send -> stop -> send again on same matter (new `chaseId`) -> run `communication-chases` -> the new chase's day-7 and day-14 emails queue cleanly without idempotency collision**; no retrospective chases on pre-existing `'Sent'` matters; restricted matter skips non-permitted recipients; two-tenant isolation & tampered-ID failures (`tenant-alpha` vs `tenant-bravo`).
   - **Admin Email Outbox viewer tests (`R823`):** non-admin fails `FORBIDDEN`; Admin without MFA fails `MFA_REQUIRED`; Admin with MFA lists `'pending'` and `'sent'` outbox rows, opens a message (writing `action: 'view'` audit entry), and downloads PDF bytes via `GET /api/admin/outbox/[id]/attachments/[ordinal]` (writing `action: 'download'` audit entry) without mutating `email_outbox.status`; restricted/walled matter emails are hidden from unpermitted Admin across list, message inspect, and attachment download with uniform `NOT_FOUND` (positive control when Admin is on the allow-list); two-tenant tampered `outboxId` fails closed; zero CDD values (`amlStatus` etc.) in viewer DTOs.
   - Non-engagement dispatch: sends PDF via outbox (`enquiry_id` populated) + marks open `non_engagement_letter` task `'Done'`.
4. **Guards (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`, `actionPermissionGuard.test.ts`, `core/tests/infra-bicep-contract.test.ts`, 5 RBAC permission count tests):** zero new allow-list entries; `JOB_PERMISSIONS` ↔ `REGISTERED_CLI_JOBS` ↔ `PERMISSION_REGISTRY` parity (`82/71/11`); `ROUTE_PERMISSIONS` `16 -> 17` and new outbox viewer action policies; Bicep `enableCommunicationChasesJob` verified.
5. **Playwright E2E (`e2e/role-journeys.spec.ts`):** Fee earner generates & sends Client Care letter -> Admin (MFA) inspects `'pending'` outbox message & PDF in **Administration → Email Outbox**, Fee earner uploads signed PDF copy -> verifies `"Signed & returned"` status & unlocked opening gate; Coordinator/Fee earner sends Non-Engagement letter on closed enquiry and sees task marked `'Done'`.
6. **Existing test files touched by `S1-06`:**
   `core/tests/migrations-postgres.test.ts`, `src/server/__tests__/actionPermissionGuard.test.ts`, `core/tests/rbac.test.ts`, `core/tests/scheduler.test.ts`, `core/tests/email-notifications-s026.test.ts`, `core/tests/registers-engine-s024.test.ts`, `core/tests/teams-digests-s029.test.ts`, `core/tests/infra-bicep-contract.test.ts`, `core/tests/tenant-config-usage.test.ts`, `src/server/__tests__/demoTenant.test.ts`, `core/tests/quick-fixes-s101.test.ts`, `core/tests/document-store.test.ts`, `core/tests/opening-gate-numbering-s105.test.ts`, `e2e/role-journeys.spec.ts`.
7. **Build-phase test cadence:** Per commit/branch run `npx tsc --noEmit`, `npm run lint`, targeted Vitest files listed above, and `npx vitest run isolation`. (Reserve full `npm run ci` and `npm run e2e` for the top WP3 branch `s1-08-money-on-account`.)

---

## 10. Expected `docs/roadmap/feature-list.md` Updates

When `S1-06` lands:
- **Row `5` (Engagement):** Update status from `Partly built` to **`Completed`** (once `e_signature` live provider stays tracked on `F26`), documenting monotonic B2 server enforcement, outbox-held Client Care PDF dispatch (`0028`, `ADR 0038`, `ADR 0042`), required signed-copy upload (`purpose: 'engagement_signed'`, `R817` stored-purpose checks), automated generic chasing (`7 / 14 / 21` days, `chase:<chaseId>:step:<n>`, `communication-chases`), Non-Engagement letter PDF generation + outbox dispatch + task completion, MFA-gated & visibility-scoped Admin **Email Outbox** viewer (`R823`), config + Help articles (`engagement-letters.ts`), and two-tenant/E2E tests.
- **Backlog `B35` & `B36`:** Already logged in `docs/roadmap/feature-list.md` (WP3 Levers 1 & 2 deferrals).

---

## 11. Commit Breakdown (Each Independently Testable)

1. **`feat(s1-06): extend @platform/core-api (v2.4.0), RBAC job permission communication:run_chases, and chasing/engagement config schemas + approved demo defaults`**
2. **`feat(s1-06): add migration 0028 (communication_chases, chase_events, engagement_dispatches, documents.primary_enquiry_id, evidence.purpose, email_outbox links) and repositories`**
3. **`feat(s1-06): implement communication-chases ADR 0030 job (R818), platform.bicep job, send/sign/chase services, R817 stored-purpose decoupling, R823 outbox viewer APIs, and Non-Engagement dispatch`**
4. **`feat(s1-06): wire Matter Profile engagement send/signed-upload UI, Enquiry Non-Engagement action, Admin Email Outbox tab + config summaries, demo.json disabled email provider (Q9), and Playwright tests`**
5. **`docs(s1-06): add engagement-letters Help article, update gate/doc-gen/settings articles, release notes, and feature-list row 5`**

---

## 12. Draft Owner Spot Checks (Demo — Outbox Verified)

- **Client Care dispatch & Admin Outbox Viewer (no live mailbox on demo):** Open a Prospective or Active matter, review/generate Client Care letter, enter recipient email, click **Send Client Care letter**, confirm status moves monotonically to `"Sent"` with stamped sent timestamp, then open **Administration → Email Outbox** (with MFA) to inspect the `'pending'` message confirming recipient address, subject, wording, and downloadable PDF attachment. Confirm an Admin not on a restricted matter's allow-list cannot see emails for that matter, and confirm viewing/downloading writes an audit log entry.
- **Monotonicity & Signed Upload (`R817`):** Confirm you cannot select `"Drafted"` after `"Sent"`, nor mark signed without uploading a clean PDF/image copy; upload a signed PDF and confirm status moves to `"Signed & returned"` and the opening gate's `Engagement signed` requirement turns green. Also confirm **Finance** can download the signed engagement PDF on an accessible matter while remaining blocked from CDD evidence downloads.
- **Non-Engagement Letter:** Close an active enquiry with `"Outside our expertise"`, open the `Send non-engagement letter` task, generate & send, inspect the `'pending'` outbox message/recipient/PDF attachment in **Administration → Email Outbox**, and confirm the task closes automatically as `Done`.

---

## 13. Risks & Open Questions (Resolved Owner Decisions, 26 Nov 2026)

All `S1-06` open questions (`Q1`, `Q2`, `Q3`, `Q7`, `Q9`) were resolved by the product owner on 26 November 2026:
- **Q1 & Q9 (Outbox Viewer & Demo Email Provider):** Build the **Administration → Email Outbox** viewer in `S1-06` behind `admin:access` + MFA with `R823` visibility (`buildMatterHiddenFromViewerSql`), audit logging, and zero CDD values; during the **`S1-06` build**, set `client-not-a-law-firm/config/environments/demo.json` `integrations.email.provider` to `"disabled"` so queued emails stay `'pending'` and readable in the viewer. Switching `integrations.email.provider` back on alongside provisioning a demo sending mailbox remains a Stage 1 §8 manual task.
- **Q2 (Levers 1 & 2):** Approved. Deferred interactive Admin wording/schedule editors (`Lever 1`) and generic `'enquiry'` merge fields in `CORE_FIELD_CATALOGUE` (`Lever 2`) are logged in `docs/roadmap/feature-list.md` as `B35` and `B36`.
- **Q3 (Chase timing):** Confirmed **7, 14 and 21 days** uniformly across engagement letters, quotes, and money on account.
*(No open questions remain.)*

---

## 14. Estimate (`2.5–3.0` days — Levers 1 & 2 applied + Admin Email Outbox viewer)

- Migration `0028` (incl. `email_outbox` link columns) + ADR 0042 generic chasing table & repository: `0.5` day.
- `communication-chases` ADR 0030 job + Bicep + permission parity + `'engagement_letter'` handler (`chase:<chaseId>:step:<n>`): `0.5` day.
- Client Care send/outbox-PDF + signed upload requirement (`e_signature` + `R817` stored-purpose decoupling) + Non-Engagement dispatch (Lever 2): `0.75–1.0` day.
- Admin **Email Outbox** viewer (`R823` SQL scoping, audited view/download, `demo.json` `"disabled"` update): `0.5` day.
- UI + Help (`engagement-letters.ts`) + two-tenant/RBAC/scheduler/outbox-viewer tests: `0.25–0.5` day.
- **Total `S1-06`:** **`2.5–3.0` days**.

---

## Appendix A: Approved Invented Demo Compliance Content (`client-not-a-law-firm/config/base.json`)

*(Approved by owner on 26 Nov 2026 per Decision 1 / Q7, with Legal Ombudsman escalation sentence added to §A.1 item 4. All names, addresses, and terms are invented demonstration text for Not A Law Firm LLP in plain British English.)*

### A.1 Client Care / Engagement Letter Standard Terms (`engagement.*`)

- **Introductory paragraph (`engagement.clientCareIntroductoryParagraph`):**
  > Thank you for instructing Not A Law Firm LLP. This Client Care and Engagement Letter sets out the scope of the work we have agreed to undertake for you, who will handle your matter day to day, our fees and anticipated expenses, and the regulatory terms that apply to our relationship. Please read this letter carefully alongside our estimate or quote before signing and returning a copy so that we can begin work promptly.
- **Key terms summary (`engagement.clientCareTermsSummary`):**
  > 1. **Basis of charges:** Unless we have agreed a fixed fee in writing, our charges are calculated by reference to the time spent on your matter at the hourly rates notified to you, plus VAT at the prevailing UK rate and any third-party disbursements properly incurred on your behalf. Any fee estimate is given in good faith on the basis of the information currently available and is not a fixed quotation unless expressly stated as such. We will notify you promptly if it becomes clear that our estimate is likely to be exceeded.
  > 2. **Money on account and billing:** Where we have requested a payment on account of costs or disbursements, we are unable to incur external expenditure or begin substantive work (where required for your matter type) until cleared funds are held in our client account. Interim invoices are payable within 14 days of delivery unless otherwise agreed.
  > 3. **Client identification and regulatory checks:** Under the Money Laundering Regulations we are legally required to obtain satisfactory evidence of client identity and, where applicable, source of funds before acting or handling client money.
  > 4. **Limitation and complaints:** Not A Law Firm LLP is a demonstration legal practice (Fictional Regulator ID 000000). Our liability in connection with this matter is capped at £3,000,000 in the aggregate unless prohibited by statute. If you are dissatisfied with any aspect of our service or our bill, please contact your supervising partner in the first instance, or write to our Complaints Partner at complaints@notalawfirm.example. If our own complaints process does not resolve your complaint within eight weeks, you have the right to complain to the Legal Ombudsman (demonstration wording only — Not A Law Firm LLP is a fictional firm).
- **Signature instruction (`engagement.clientCareSignatureInstruction`):**
  > Please sign and date the confirmation section of this letter and return a scanned copy or clear photograph to your fee earner by email so we can record your acceptance and proceed with your matter.

### A.2 Non-Engagement Letter Wording by Close Reason (`engagement.nonEngagementWording`)

*(Note: Every variant states clearly that no solicitor–client relationship has been formed, warns of potential statutory time limits without giving legal advice on specific deadlines, and avoids disclosing confidential third-party details on `conflict` declines.)*

- **`conflict` (`enquiry_close_reason.conflict`):**
  - Subject: `Your recent enquiry ({{enquiryReference}}) — unable to act`
  - Body:
    > Dear {{recipientName}},
    > Thank you for contacting Not A Law Firm LLP regarding your enquiry (Ref: {{enquiryReference}}).
    > Having carried out our regulatory conflict and compliance checks, we regret that professional obligations prevent Not A Law Firm LLP from accepting your instructions on this matter. For reasons of client confidentiality, we are unable to provide further details regarding the nature of the restriction.
    > Because we have not accepted instructions, no solicitor–client relationship exists between you and Not A Law Firm LLP, and we have not reviewed the merits or any limitation deadlines affecting your matter. You should seek alternative independent legal advice without delay, particularly if your matter may be subject to statutory time limits or court deadlines. We recommend consulting the Law Society's "Find a Solicitor" directory (solicitors.lawsociety.org.uk).
    > Yours sincerely,
    > {{feeEarnerOrSenderName}} — Not A Law Firm LLP
- **`outside_expertise` (`enquiry_close_reason.outside_expertise`):**
  - Subject: `Your enquiry ({{enquiryReference}}) — Not A Law Firm LLP`
  - Body:
    > Dear {{recipientName}},
    > Thank you for getting in touch with Not A Law Firm LLP about {{matterAreaLabel}} (Ref: {{enquiryReference}}).
    > Having reviewed your enquiry, we regret that this area falls outside the specialist expertise our team currently offers, so we are not in a position to accept instructions or advise you on the matter.
    > No solicitor–client relationship has been formed and we are not monitoring any deadlines on your behalf. If your issue is urgent or may be subject to a limitation deadline, please instruct a specialist firm promptly via solicitors.lawsociety.org.uk.
    > Yours sincerely,
    > {{feeEarnerOrSenderName}} — Not A Law Firm LLP
- **`not_viable` (`enquiry_close_reason.not_viable`):**
  - Subject: `Your enquiry ({{enquiryReference}}) — Not A Law Firm LLP`
  - Body:
    > Dear {{recipientName}},
    > Thank you for contacting Not A Law Firm LLP regarding your enquiry (Ref: {{enquiryReference}}).
    > Following our initial review, we regret that we are unable to take on this matter on a commercially viable basis or offer an appropriate funding arrangement for your requirements. Accordingly, Not A Law Firm LLP is not acting for you and will not take any steps on your behalf.
    > You may wish to approach another firm or seek guidance from Citizens Advice or a free legal advice clinic. Please act promptly if any time limits could apply to your situation.
    > Yours sincerely,
    > {{feeEarnerOrSenderName}} — Not A Law Firm LLP
- **`referred_out` (`enquiry_close_reason.referred_out`):**
  - Subject: `Confirmation of non-engagement and referral ({{enquiryReference}})`
  - Body:
    > Dear {{recipientName}},
    > Thank you for contacting Not A Law Firm LLP (Ref: {{enquiryReference}}). As discussed, we are unable to handle this matter in house and have suggested alternative external providers who may be able to assist you.
    > For clarity, Not A Law Firm LLP does not act for you in this matter and accepts no responsibility for any external provider you choose to instruct, nor for tracking any deadlines on your behalf. Please contact your chosen adviser promptly.
    > Yours sincerely,
    > {{feeEarnerOrSenderName}} — Not A Law Firm LLP
- **`defaultFallback` (`other` / general close):**
  - Subject: `Your enquiry ({{enquiryReference}}) — Confirmation of non-engagement`
  - Body:
    > Dear {{recipientName}},
    > Thank you for contacting Not A Law Firm LLP (Ref: {{enquiryReference}}). We write to confirm that Not A Law Firm LLP will not be accepting instructions or acting for you in connection with this enquiry, and our file has now been closed.
    > Please note that no solicitor–client relationship exists between us and we have not advised on or diarised any limitation periods or procedural deadlines. If you still require legal assistance, please seek alternative representation without delay.
    > Yours sincerely,
    > {{feeEarnerOrSenderName}} — Not A Law Firm LLP
