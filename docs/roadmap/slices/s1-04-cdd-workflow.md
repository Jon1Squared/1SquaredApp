# S1-04: Client Due Diligence (CDD) Workflow, Evidence Storage, and Re-Check Reminders

| | |
|---|---|
| Backlog | Row `4` (Client and matter inception), plus item `16` alignment (`aml_and_cdd_queue`) |
| Decision | Stage 1 decisions `S1-D5`, `S1-D10`; Owner decisions (24 Nov 2026); [ADR 0032](../../decisions/0032-registers-engine.md), [ADR 0038](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md), Proposed [ADR 0039](../../decisions/0039-registers-engine-extensions-cdd-high-risk.md) |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP2 (`S1-04`) |
| Branch | `s1-04-cdd-workflow`, from `develop` (`1093e45` baseline), targeting `develop` |
| Change class | Core extension-point & engine evolution (`@platform/core-api` v`2.2.0`, `core/src/domain/registers/`), Core tenancy schema + repositories + expand migration `0025` (`core/src/tenancy/`), Core configuration schema & deep-merge (`core/schemas/`, `core/src/config-engine/`), Host services/actions/routes/page loaders/UI (`src/`), Demo client configuration (`client-not-a-law-firm/config/`), Help documentation (`src/docs/`) |
| Layer | Core API (`core/src/api/`), Core registers & RBAC (`core/src/domain/`), Core tenancy (`core/src/tenancy/`), Core config (`core/src/config-engine/`, `core/schemas/`), Host server & UI (`src/`), Client config (`client-not-a-law-firm/`) |
| Size | L (`3.5–4` days) |
| Depends on | `S1-02a`, `S1-02b`, `S1-03` (all merged to `develop`); Approval of Proposed [ADR 0039](../../decisions/0039-registers-engine-extensions-cdd-high-risk.md) before coding |
| Blocking manual tasks | None in dev/test; existing Stage 1 §8 manual demo-deploy (`caj-migrate-demo`) when WP2 deploys. Risk `R3` still prohibits storing real live client CDD evidence until `azure-blob` replaces `local-fs`. |
| Baseline | `develop` at `1093e45` |

---

## 1. Change Class and Layer Breakdown

| Part | Change class | Layer |
|---|---|---|
| `subjectScope`, `'checklist'`, `'evidence'` types & `CORE_API_VERSION = '2.2.0'` | Core extension API (additive, Rule 7) | `core/src/api/registers.types.ts`, `core/src/api/index.ts` |
| Core `'cdd'` register type, checklist/evidence validators, `buildClientRegisterVisibleSql` convergence | Core domain engine & tenancy SQL | `core/src/domain/registers/index.ts`, `core/src/tenancy/registerRepository.ts`, `core/src/tenancy/searchRepository.ts` |
| `cdd:view` & `cdd:record` permissions | Core RBAC registry | `core/src/domain/rbac/registry.ts` |
| Migration `0025`, `TenantEvidenceArtifactRepository`, `TenantIntakeCheckRepository` runtime accessor | Core tenancy persistence | `core/src/tenancy/migrations/index.ts`, `core/src/tenancy/evidenceRepository.ts`, `core/src/tenancy/registerRepository.ts`, `src/platform/tenantRuntime.ts` |
| `cdd` config schema (`clientTypeMapping`, `riskTierMapping`, `checklists`, `recheckIntervals`, `reminderRecipients`), `registers` schema updates, deep-merge, runtime usage | Core configuration engine & schemas | `core/schemas/tenant-config.schema.json`, `core/schemas/registers.config.schema.json`, `core/src/config-engine/index.ts`, `core/tests/tenant-config-usage.test.ts` |
| Server services, `/api/evidence/upload` & `/api/evidence/download`, `ACTION_PERMISSIONS`/`ROUTE_PERMISSIONS`, scoped page loaders, reminder dispatch | Host server & HTTP handlers | `src/server/services.ts`, `src/server/actionPermissions.ts`, `src/app/actions.ts`, `src/app/api/evidence/`, `src/server/pageLoaders.ts` |
| Client-mode registers panel on Person & Organisation profiles, Admin CDD settings panel, MatterFormClient real CDD status | Host UI | `src/components/PersonProfileClient.tsx`, `src/components/OrganisationProfileClient.tsx`, `src/components/RegistersWorkspaceClient.tsx`, `src/components/CddChecklistCard.tsx`, `src/components/MatterFormClient.tsx`, `src/components/HomeClient.tsx`, `src/components/AdminClient.tsx` |
| Seed `organisation_type` `systemKey`s & invented demo CDD defaults | Client config & test fixtures | `client-not-a-law-firm/config/base.json`, `src/seed/lists.ts`, `data/seed-not-a-law-firm.json` |
| Plain-English Help & release notes (Rule 11, Stage 1 §6 rule 6) | Help documentation | `src/docs/articles/`, `src/docs/registry.ts`, `docs/release-notes.md` |

---

## 2. What Exists Today (`develop` at `1093e45`)

1. **Risk ratings (`data/seed-not-a-law-firm.json:2850-2907`, `src/seed/lists.ts:294-308`, `src/domain/matterOpeningRecord.ts:839-869, 952-973`):**
   - Six active `risk_rating` values, all carrying stable `systemKey`s: `low` (`risk_rating.low`), `medium` (`risk_rating.medium`), `high` (`risk_rating.high`), `critical` (`risk_rating.critical`), `conflict_flagged` (`risk_rating.conflict_flagged`), `sensitive` (`risk_rating.sensitive`).
   - `matters.risk_rating_id` (`migrations/index.ts:965`) and `matters.risk_assessment_json` (`:983`) store matter risk derived server-side in `saveMatterRecord` (`src/server/services.ts:7516-7547`). `Organisation` also carries `riskRatingId` (`src/domain/types.ts:682`) and `reviewDate` (`:684`); `Person` carries `verificationStatusId` and `verifiedAt` / `lastVerifiedAt` (`src/domain/types.ts:606-615`).
2. **Honest `"Sanctions & PEP: Not checked"` displays and CI guards:**
   - `src/components/PersonProfileClient.tsx:126-194, 505-517, 1245-1284` (`resolvePersonComplianceDisplay`): derives `idVerification` from `verificationStatusId` + `verifiedAt`, hardcodes `sanctionsAndPep: { label: 'Not checked', pillClass: 'client-pill--neutral' }` (`:188-191`), and hardcodes `recheckDue: 'Not set'` (`:192`).
   - `src/components/OrganisationProfileClient.tsx:146-263, 495-507, 1205-1285, 1911-1960` (`resolveOrganisationComplianceDisplay`): computes `companyVerification`, `conflictCheck`, `ableToAct`, `recheckDue: formatDate(organisation.reviewDate) || 'Not set'`, and hardcodes `sanctionsAndPep: { label: 'Not checked', tone: 'neutral' }` (`:246-249`).
   - `src/components/HomeClient.tsx:4516-4540` (`high_risk_matters_and_pep_register`) renders `"PEP & sanctions watch: Not yet available"`; `aml_and_cdd_queue` (`rc_aml_pending`) renders a neutral empty state.
   - `src/domain/__tests__/noDemoLiterals.test.ts:57-91, 155-230, 384-410, 747-790` bans fake `"Sanctions & PEP: Clear"` literals and asserts both display resolvers return `'Not checked'` unless a real recorded check exists.
3. **Derived client CDD status on matter opening (`computeClientRelationshipCdd`, `R698`):**
   - `src/domain/matterOpeningRecord.ts:2357-2528` (`computeClientRelationshipCdd`) currently guesses client CDD currency from `verificationStatusId` / `relationshipStatusId` **display label substring matching** (`resolveLabel(...).toLowerCase()`), `organisation.reviewDate`, and legacy prior matter `amlStatus === 'Verified'`.
   - Fed by `loadMatterFormPageData` / `loadMatterDetailPageData` (`src/server/pageLoaders.ts:2415-2435, 2755-2775`) and `listClientPriorMattersAction` (`src/app/actions.ts:1979-1987` -> `src/server/services.ts:30865-30930`), consumed in `MatterFormClient.tsx:1839-1965` (`userEditedCddRef`) to pre-fill Q2.1 (`clientRelationshipStatus`).
   - **S1-04 replaces this heuristic** with real `cdd` register records (`getActiveClientCddSummary`), falling back honestly to `'New client'` / `'CDD not started'` rather than label-substring heuristics.
4. **Registers engine (`core/src/domain/registers/index.ts`, `core/src/tenancy/registerRepository.ts`):**
   - Supports `sign_off`, `undertaking`, `complaint`, `breach` (`CORE_REGISTER_TYPES`, `:67-437`), scalar fields (`:752-839`), `public.register_records` with `person_id`/`organisation_id` columns (`migrations/index.ts:2048-2051`) lacking client indexes, and `register-reminders` hourly job (`src/server/services.ts:28088-28370`).
   - **Two bugs/gaps to fix while extending:**
     1. `REGISTER_RECORD_VISIBLE_SQL_PREDICATE` (`registerRepository.ts:39-52`) lacks the empty-allow-list participant fallback and `restrictedAccessUserIdsFallback` of `buildMatterHiddenFromViewerSql` (`intakeQuoteRepository.ts:812-842`);
     2. `listRegistersWorkspaceDataRecord` (`services.ts:27111-27117`) and `listTransitionsForRecord` inside `getRegisterRecordDetailRecord` (`services.ts:27249-27251`) omit `hasRestrictedMatterAccess` / `includeRestricted` after `canPersonAccessMatter` already succeeded.
   - `RegistersWorkspaceClient.tsx:1-1146` only exposes `matterId` (`lockedMatterId` on `MatterProfileClient.tsx:3544-3560`); client subject linking (`personId` / `organisationId`) is absent.
5. **S1-03 evidence storage & intake checks:**
   - `DocumentStorageProvider.putObject` (`core/src/api/index.ts:617`, `core/src/tenancy/blobStorage.ts:189-243`) already accepts `category: 'evidence'`, scans bytes with `scanBytesForMalwareAndMacros`, hashes SHA-256, and writes `tenant-<tenantId>-<env>/evidence/<safeId>/<safeName>`.
   - `TenantIntakeCheckRepository` (`core/src/tenancy/intakeCheckRepository.ts:108-315`) and `ManualIdentityVerificationProvider` / `ManualSanctionsPepScreeningProvider` (`core/src/integrations/intake-checks/manualProviders.ts:81-343`) verify clean evidence artifacts and persist `public.intake_check_records` (`ICHK-*`) + same-TX `audit_entries`.
   - **Wiring gaps S1-04 closes:** `src/platform/tenantRuntime.ts:983-1045` does not yet expose `getIntakeCheckRepository()`, and `src/app/api/documents/download/route.ts:43-86` strictly requires `public.documents` (`verified.documentId`), so `S1-04` adds `GET /api/evidence/download` + `POST /api/evidence/upload` backed by `public.evidence_artifacts`.
6. **Codebase contradiction flagged explicitly:**
   - `Stage1-WP2-plan-prompt.md` requires mapping client types using `systemKey`, never labels. In `develop` (`1093e45`), `organisation_type` choice values (`data/seed-not-a-law-firm.json:1163-1259`, `src/seed/lists.ts:166-171`) currently have **no `systemKey`** at all (`systemKey: undefined`). Migration `0025` + `src/seed/lists.ts` + `data/seed-not-a-law-firm.json` backfill `systemKey` onto all 13 `organisation_type` values so S1-04 maps strictly by `systemKey` without introducing label matching or silent fallback.

---

## 3. Demo CDD Configuration, Checklists, `systemKey` Mappings & Reminder Recipients

All values below are **invented demo defaults** living in `client-not-a-law-firm/config/base.json`, validated by JSON Schema + Zod, and editable by an MFA-verified administrator in **Administration → Registers / CDD**. Core ships empty template defaults (no firm compliance rules hardcoded in `core/`).

### 3.1 Checklist templates (`S1-D5`, `S1-D10`)

| Client CDD category key | Standard risk items (`riskTier: 'standard'`) | Additional High-risk items (`riskTier: 'high'`, additive on top of Standard) |
|---|---|---|
| `individual` | `photo_id` ("Photo ID", linked to manual `identity_verification`), `proof_of_address` ("Proof of address") | `source_of_funds` ("Source of funds"), `source_of_wealth` ("Source of wealth") |
| `company_or_llp` | `companies_house_record` ("Companies House record"), `beneficial_owners_over_25` ("Beneficial owners over 25%"), `director_photo_id` ("ID for one director", linked to manual `identity_verification`) | `ownership_structure_chart` ("Ownership structure chart"), `source_of_funds` ("Source of funds") |
| `trust_charity_or_partnership` | `founding_document` ("Founding document"), `controllers_id` ("Controllers' ID", linked to manual `identity_verification`) | `source_of_funds` ("Source of funds") |

- **Optional Sanctions & PEP manual check slot:** Every CDD checklist also renders a separate, explicitly manual `Sanctions & PEP check (manual)` section backed by `SanctionsPepScreeningProvider` (`provider: 'manual'`), defaulting to **Not checked** (`sanctions_pep` outcome absent) until a staff member explicitly records a manual check with date and evidence (Risk `R1`).

### 3.2 Subject mapping onto existing configuration (`systemKey` only, never labels)

1. **All `Person` records (`subjectType === 'person'`):** map unconditionally to `individual`. (A `Person` acting via their sole trader business still undergoes individual identity checks; when instructing as an `Organisation` with `organisation_type` `sole_trader`, see below.)
2. **All 13 `Organisation` legal forms (`organisation.organisationTypeId` resolved via `choice_values.systemKey`):**

| `choice_values.id` | Backfilled `systemKey` | Mapped CDD Category Key | Rationale |
|---|---|---|---|
| `organisation_type.sole_trader` | `sole_trader` | `individual` | Natural person trading unincorporated (MLR 2017 Reg 28 individual CDD: Photo ID + proof of address). |
| `organisation_type.company` | `company` | `company_or_llp` | Corporate body requiring Companies House check, PSC (>25%), and one director ID. |
| `organisation_type.plc` | `plc` | `company_or_llp` | Public limited company; corporate/director/beneficial ownership checklist (with Companies House / listed exemption noted in manual note/S&P evidence if listed). |
| `organisation_type.llp` | `llp` | `company_or_llp` | Limited Liability Partnership registered at Companies House (`company_or_llp` expressly covers "Company or LLP"). |
| `organisation_type.law_firm` | `law_firm` | `company_or_llp` | Corporate legal practice (typically company/LLP). |
| `organisation_type.insurer` | `insurer` | `company_or_llp` | Corporate regulated insurer. |
| `organisation_type.supplier` | `supplier` | `company_or_llp` | Commercial supplier when also instructed/onboarded as an organisation. |
| `organisation_type.partnership` | `partnership` | `trust_charity_or_partnership` | Unincorporated partnership without Companies House incorporation. |
| `organisation_type.trust` | `trust` | `trust_charity_or_partnership` | Expressly named in category: founding trust deed + trustees/settlors/beneficiaries ID. |
| `organisation_type.charity` | `charity` | `trust_charity_or_partnership` | Expressly named in category: governing document + trustees/controllers ID. |
| `organisation_type.non_profit` | `non_profit` | `trust_charity_or_partnership` | Unincorporated association / club / non-profit controlled by officers/trustees. |
| `organisation_type.barristers_chambers` | `barristers_chambers` | `trust_charity_or_partnership` | Unincorporated collective / association governed by constitution and heads/clerks. |
| `organisation_type.public_body` | `public_body` | `trust_charity_or_partnership` | Statutory charter/enabling legislation ("founding document") and authorised officers ("controllers' ID"). |

*(Fallback if an `Organisation` has an empty/unrecognised `organisationTypeId`: fail UI/create validation or select an explicit client category picker constrained to `'individual' | 'company_or_llp' | 'trust_charity_or_partnership'` with a mandatory recorded note — never guess by display label.)*

### 3.3 Risk rating mapping (`risk_rating.systemKey` -> CDD risk tier & re-check interval)

All 6 configured `risk_rating` values (`data/seed-not-a-law-firm.json:2850-2907`):

| `risk_rating.id` | `systemKey` | Mapped CDD tier | Re-check interval | Rationale |
|---|---|---|---|---|
| `risk_rating.low` | `low` | **`standard`** | **3 years** (`36` months) | **Owner question proposal:** Low risk exists in config (`risk_rating.low`, routine matter). It **should use the `standard` checklist and 3-year interval** rather than a stripped checklist, because under the Money Laundering Regulations 2017 (`Reg 28`) a UK law firm still requires basic client identification & address/constitutional verification unless statutory Simplified Due Diligence (SDD) criteria are formally recorded; SDD exemptions can be captured via item `'not_applicable'` with a mandatory note where legally justified. |
| `risk_rating.medium` | `medium` | `standard` | **3 years** | Normal standard CDD baseline. |
| `risk_rating.conflict_flagged` | `conflict_flagged` | `standard` | **3 years** | Conflict flag does not itself imply ML/TF escalation unless matter/client risk is separately High/Critical/Sensitive. |
| `risk_rating.high` | `high` | `high` | **1 year** (`12` months) | Requires enhanced due diligence (source of funds/wealth or ownership chart) + annual review. |
| `risk_rating.critical` | `critical` | `high` | **1 year** | Highest risk tier; triggers enhanced CDD + annual review. |
| `risk_rating.sensitive` | `sensitive` | `high` | **1 year** | Reputational/PEP/political/media sensitivity warrants enhanced due diligence + annual review. |

### 3.4 Re-check reminder recipient order & justification
- **Recipient resolution priority for `cdd` reminders (`recipientMode: 'client_owner_or_recent_fee_earner'`):**
  1. **Primary:** Active, non-leaver **client relationship owner** (`record.ownerId` on the `cdd` record, defaulted from `person.relationshipOwnerId` / `organisation.relationshipOwnerId` or assigned partner/owner).
  2. **Fallback 1 (when client has no active relationship owner):** Active, non-leaver **`responsibleFeeEarnerId` (else `responsiblePartnerId`) on the client's most recently updated or opened non-draft matter** (filtered to users still holding `cdd:view` / `matter:edit` and respecting staff-matter access).
  3. **Fallback 2 (when client has no active owner or non-draft matter fee earner, e.g. dormant client whose owner became a leaver):** Active users with `'risk:view'` (`risk_compliance`) so overdue reviews never drop silently into a void.
- **Justification:** When a firm has an active client relationship owner (partner/client partner), they hold continuous accountability across multiple matters and know whether the firm still acts (`Ongoing monitoring`). For transactional/private clients without a named relationship owner, the fee earner on the most recent matter holds current client contact and can refresh ID/source-of-funds or mark the client dormant without burdening compliance unnecessarily; the compliance fallback catches orphan/leaver gaps cleanly (`no_permitted_recipients` avoided).

---

## 4. Data Model, Expand Migration `0025`, and Backfill Plan

- **Migration ID:** `0025_registers_cdd_and_org_type_keys_expand` (raises `CORE_REQUIRED_SCHEMA_VERSION = '0025'`, `dependsOn: ['0009', '0012', '0017', '0023']`).
- **Expand DDL (`upSql`):**
  1. **Client-subject indexes on `public.register_records`:**
     - `idx_register_records_tenant_person ON public.register_records (tenant_id, person_id, register_type_key, status) WHERE person_id IS NOT NULL;`
     - `idx_register_records_tenant_organisation ON public.register_records (tenant_id, organisation_id, register_type_key, status) WHERE organisation_id IS NOT NULL;`
  2. **Evidence artifact metadata table (`public.evidence_artifacts`) + sequence:**
     - `CREATE SEQUENCE IF NOT EXISTS public.tenant_evidence_artifact_id_seq START WITH 1 INCREMENT BY 1;`
     - Table columns: `tenant_id TEXT NOT NULL`, `id TEXT NOT NULL` (`EVD-000001`), `blob_key TEXT NOT NULL`, `subject_type TEXT NOT NULL CHECK (subject_type IN ('person', 'organisation', 'matter', 'enquiry', 'quote', 'register'))`, `subject_id TEXT NOT NULL`, `file_name TEXT NOT NULL`, `content_type TEXT NOT NULL`, `byte_size BIGINT NOT NULL CHECK (byte_size > 0)`, `sha256 TEXT NOT NULL`, `scan_status TEXT NOT NULL CHECK (scan_status IN ('clean', 'infected', 'pending'))`, `uploaded_by_person_id TEXT NOT NULL`, `uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `PRIMARY KEY (tenant_id, id)`, `CONSTRAINT uq_evidence_artifacts_blob UNIQUE (tenant_id, blob_key)`.
     - Index: `idx_evidence_artifacts_tenant_subject ON public.evidence_artifacts (tenant_id, subject_type, subject_id, uploaded_at DESC)`.
     - `GRANT SELECT, INSERT, UPDATE, DELETE ON public.evidence_artifacts TO <runtimeRole>`.
  3. **`organisation_type` `system_key` backfill (in `upSql`):**
     - Update `public.choice_values` for all 13 `list_key = 'organisation_type'` IDs (`organisation_type.company` → `company`, ..., `organisation_type.trust` → `trust`) **only where `system_key IS NULL`** (`AND NOT EXISTS` conflict guard matching migration `0021` pattern). Update `src/seed/lists.ts` and `data/seed-not-a-law-firm.json` to match.
- **Reversible `downSql`:** Drops `idx_register_records_tenant_person`, `idx_register_records_tenant_organisation`, `idx_evidence_artifacts_tenant_subject`, `public.evidence_artifacts`, and `tenant_evidence_artifact_id_seq` cleanly (and preserves or clears only backfilled `organisation_type` `system_key`s safely; since `system_key` column already exists from `0021`, restoring `NULL` only on `organisation_type` rows whose `id` matches `'organisation_type.' || system_key` gives an exact `up -> down -> up` round-trip).
- **Existing client backfill policy (`upSql` + UI/loader):**
  - **Existing clients start with NO `cdd` register record** and display **`"CDD not started"`** (or legacy summary line clearly labelled `"Legacy verification only — no manual CDD record"` alongside `"Sanctions & PEP: Not checked"` until recorded).
  - Never synthetically generate `cdd` records from unverified seed `verificationStatusId` fields during migration — doing so would fabricate verification timestamps and violate Risk `R1`. Seed demo data (`src/seed/demo.ts` / `data/seed-not-a-law-firm.json`) adds explicit, clearly manual demo `cdd` records for 2–3 invented sample clients (`Not A Law Firm LLP` test entities) plus leaving others `"CDD not started"` for E2E testing.

---

## 5. Configuration Schema Changes & Runtime Usage Compliance

Every new configuration key requires a JSON Schema entry, Zod validation, `loadAndValidateTenantConfig` deep-merge support (`core/src/config-engine/index.ts:3365-3981`), non-test runtime access (`core/tests/tenant-config-usage.test.ts`), and demo defaults in `client-not-a-law-firm/config/base.json`:

1. **`core/schemas/registers.config.schema.json` (and `core/src/api/registers.types.ts`):**
   - `RegisterTypeDefinition.subjectScope`: `enum: ["matter", "client", "any"]`, default `"any"`, description `"Restricts whether records attach to a matter, a client (person/organisation), or either."`.
   - `RegisterFieldDefinition.fieldType`: widen enum with `"checklist"` and `"evidence"`.
   - `RegisterReminderScheduleConfig.recipientMode`: widen enum with `"client_owner_or_recent_fee_earner"`.
   - Note in Zod + JSON Schema: additive optional keys validated strictly.
2. **New `TenantConfiguration.cdd` subtree (`core/schemas/tenant-config.schema.json` + `core/src/config-engine/index.ts`):**
   - `cdd.enabled` (`boolean`, default `true` — enables CDD checklist templates on `'cdd'` register creation; demo `true`).
   - `cdd.clientTypeMapping` (`object`, strictly keyed by `organisation_type` `systemKey`s (`company`, `plc`, `llp`, `partnership`, `sole_trader`, `charity`, `public_body`, `law_firm`, `barristers_chambers`, `supplier`, `non_profit`, `insurer`, `trust`) -> enum `['individual', 'company_or_llp', 'trust_charity_or_partnership']`, default `{}` in core schema, populated with the §3.2 mapping in `client-not-a-law-firm/config/base.json`).
   - `cdd.riskTierMapping` (`object`, keyed by `risk_rating` `systemKey` -> enum `['standard', 'high']`, default `{}` in core schema, populated with the §3.3 mapping in `base.json`).
   - `cdd.checklists` (`object` mapping `'individual' | 'company_or_llp' | 'trust_charity_or_partnership'` -> `{ standard: ChecklistItemTemplate[], highAdditional: ChecklistItemTemplate[] }`, where `ChecklistItemTemplate` has `itemKey`, `label`, `description`, `required`, `requiresEvidence`, `linkedIntakeCheckKind?: 'identity_verification' | 'sanctions_pep'`; default empty `{}` in core, populated with §3.1 in `base.json`).
   - `cdd.recheckIntervalsMonths` (`{ standard: number (integer 1..120, default 36), high: number (integer 1..120, default 12) }`).
   - `cdd.reminderScheduleDaysBefore` (`number[]`, e.g. `[30, 7, 0, -7, -30]`, default `[14, 7, 0]`).
   - `cdd.maxEvidenceFileSizeBytes` (`integer`, min `1024`, max `26214400`, default `10485760` = `10 MiB`).
3. **`loadAndValidateTenantConfig` deep-merge + `tenant-config-usage.test.ts`:**
   - Add explicit deep-merge helper for `cdd` (and nested `clientTypeMapping`, `riskTierMapping`, `checklists`, `recheckIntervalsMonths`) in `core/src/config-engine/index.ts`.
   - Ensure every leaf under `cdd.*` and `registers` is read cleanly in runtime helpers (`resolveCddConfigForClient`, `createCddRecordService`, `executeRegisterRemindersForTenant`, `uploadEvidenceArtifactService`) so `core/tests/tenant-config-usage.test.ts` passes with **zero** unreferenced non-reserved leaves and **no** unintended `x-reserved` escapes.
   - Add optional runtime override storage under `public.tenant_module_configs` (`config_key = 'cdd'`) editable via **Administration → CDD Settings** (or Registers/Compliance admin tab) requiring `register:configure` + `admin:access` + `mfaVerified: true`.

---

## 6. Permissions, Action Policies & Role Matrix

### New Permissions (`core/src/domain/rbac/registry.ts`)

| Permission key | Domain | Sensitivity | `requiresMfa` | Built-in roles holding it by default (`HomeRoleKey`) |
|---|---|---|---|---|
| `cdd:view` | `register` / `cdd` | `standard` | `false` | `admin`, `managing_partner`, `partner`, `risk_compliance`, `fee_earner`, `supervisor`, `legal_secretary`, `finance` (same practice/operations scope as `register:view`, plus `enquiries_coordinator` read-only summary visibility or checked explicitly — propose granting `cdd:view` to `enquiries_coordinator`? No: keep `enquiries_coordinator` & `intake` out of `cdd:view` document downloads unless granted; show non-PII status badge via `matter:create` or keep `cdd:view` on the 8 roles above). |
| `cdd:record` | `register` / `cdd` | `restricted` | `false` | `admin`, `managing_partner`, `partner`, `risk_compliance`, `fee_earner`, `supervisor`, `legal_secretary` (excludes `finance`, `enquiries_coordinator`, `intake` unless granted). |

- **Reused permissions:** `register:view`, `register:create`, `register:edit`, `risk:view` (`risk_compliance`, `managing_partner`, `admin`), `matter:restricted:access` (employee-client evidence gating), and `register:configure` + `admin:access` (**`requiresMfa: true`** for admin CDD configuration screens & `saveCddConfigAction`).

### New Server Actions & HTTP Routes (`src/server/actionPermissions.ts`, `MAX_KNOWN_GAPS = 0`)

| Entry | Registry map | Policy (`kind`, `key`, `enforcedBy`) |
|---|---|---|
| `startOrLoadClientCddAction` | `ACTION_PERMISSIONS` | `{ kind: 'permission', key: { anyOf: ['cdd:view', 'cdd:record', 'register:view'] }, enforcedBy: 'action' }` *(service enforces `cdd:record` when creating)* |
| `recordCddChecklistItemAction` | `ACTION_PERMISSIONS` | `{ kind: 'permission', key: { allOf: ['cdd:record', 'register:edit'] }, enforcedBy: 'action' }` |
| `completeClientCddAction` | `ACTION_PERMISSIONS` | `{ kind: 'permission', key: { allOf: ['cdd:record', 'register:edit'] }, enforcedBy: 'action' }` |
| `recordManualSanctionsPepAction` | `ACTION_PERMISSIONS` | `{ kind: 'permission', key: { anyOf: ['cdd:record', 'risk:view'] }, enforcedBy: 'action' }` |
| `saveCddConfigAction` | `ACTION_PERMISSIONS` | `{ kind: 'permission', key: { allOf: ['admin:access', 'register:configure'] }, enforcedBy: 'action' }` *(enforces `mfaVerified: true` on both)* |
| `POST /api/evidence/upload` | `ROUTE_PERMISSIONS` | `{ kind: 'permission', key: { anyOf: ['cdd:record', 'register:edit', 'register:create', 'matter:edit'] }, enforcedBy: 'action' }` *(service verifies subject access & malware/size limits)* |
| `GET /api/evidence/download` | `ROUTE_PERMISSIONS` | `{ kind: 'authenticated', reason: 'Download uses short-lived tenant/actor HMAC-signed ScopedDownloadToken plus DB subject visibility and RBAC re-verification inside guardedRoute' }` *(mirrors `GET /api/documents/download`)* |

- **MFA enforcement on Admin configuration:** `/admin/registers` / `/admin/cdd` checks `admin:access` + `register:configure` with `mfaVerified: true` in `loadAdminPageData` and `saveCddConfigAction` (`enforcedBy: 'action'`). Non-MFA sessions are redirected from `/admin` to `/` and receive `MFA_REQUIRED` from `saveCddConfigAction`.

---

## 7. Visibility, Isolation & Composition with S1-09 Information Barriers

1. **Who can see client CDD & evidence:**
   - **Standard external clients:** Any user holding `cdd:view` (`register:view`) can inspect the CDD checklist summary on `/people/[id]`, `/organisations/[id]`, and `/registers?type=cdd`. Evidence file download (`GET /api/evidence/download`) re-checks `cdd:view` (or `register:view` / `risk:view`) inside the request transaction plus HMAC token `sub === actor.id` and `tenantId === ctx.tenantId`.
   - **Employee-as-client (`person.isEmployee === true`):** Detailed checklist notes, attached ID documents (`public.evidence_artifacts`), and `/api/evidence/download` are restricted to holders of **`risk:view` or `matter:restricted:access`** (or the subject themselves? No — even employees do not bypass Compliance oversight via general directory view; keep restricted to `risk:view` / `matter:restricted:access`). Non-privileged staff viewing the employee's profile or opening a matter only see the honest status summary (`"Recorded manually on <date>"` or `"CDD not started"`).
2. **S1-09 Information Barrier composition:**
   - S1-04 does **not** build barrier tables now.
   - Instead, all CDD queries route through `TenantRegisterRepository.listVisibleRegisterRecords` and `TenantEvidenceArtifactRepository.getArtifactByIdForActor`, which already separate subject-visibility predicates (`buildMatterHiddenFromViewerSql` for matter-linked rows; `buildClientRegisterVisibleSql` seam for client rows). In `S1-09`, `buildClientRegisterVisibleSql` adds a single `NOT EXISTS` barrier clause on `(target_type IN ('person', 'organisation') AND target_id = ...)` without touching S1-04 services or routes.
3. **Two-tenant & tampered-ID guarantees (Rule 9):**
   - `public.register_records`, `public.evidence_artifacts`, `public.intake_check_records`, `ScopedDownloadToken` (`${tokenSigningKey}:${ctx.tenantId}`), and blob keys (`tenant-<tenantId>-<env>/evidence/...`) all embed and verify `ctx.tenantId` inside `withTenantTransaction`.
   - Any tampered cross-tenant `recordId`, `personId`, `organisationId`, `evidenceId`, `blobKey`, or download `token` fails closed (`NOT_FOUND` / `TENANCY_CROSS_TENANT_RECORD_ACCESS` / `403`).

---

## 8. Profiles (Risk `R1`), Matter Form Integration & Reminders

1. **Profiles (`/people/[id]`, `/organisations/[id]`):**
   - Show a dedicated **Client Due Diligence** card (plus linked checklist items and evidence upload/download) replacing the hardcoded placeholder feel of `recheckDue: 'Not set'`.
   - When no `cdd` register record exists: show `"CDD not started"` (never `"Verified"`).
   - When manually recorded: show **`"Recorded manually by <Person Name> on <DD Mon YYYY>"`**, risk tier (`Standard (3 years)` / `High (1 year)`), item progress (`X of Y required items recorded`), next re-check due date (`dueAt` / `reviewAt`), and downloadable verified evidence links (gated for employees).
   - **`Sanctions & PEP` row (Risk `R1` + `noDemoLiterals.test.ts`):** stays `"Not checked"` (`client-pill--neutral`) **unless** an explicit manual `SanctionsPepScreeningProvider` check has been recorded, in which case it displays **`"Clear — Recorded manually by <Person Name> on <DD Mon YYYY>"`** (or `"Potential match flagged — Recorded manually..."`), never `"Screened by provider"`! Update `noDemoLiterals.test.ts` carefully so banned `"Sanctions & PEP: Clear"` shortcuts remain prohibited while explicit manual-record helper outputs are tested.
2. **Matter opening wizard (`src/components/MatterFormClient.tsx`, `src/domain/matterOpeningRecord.ts:2357-2528`):**
   - Pass SQL-scoped `clientCddSummaries` (for initial clients via `loadMatterFormPageData`, and dynamically refreshed via `listClientPriorMattersAction` + `getClientCddSummariesAction` without loading whole-tenant lists) so Q2.1 displays actual client CDD currency (`"CDD current (recorded <date>, next re-check <date>)"`, `"CDD expired (<date>)"`, `"CDD in progress"`, or `"CDD not started"`) instead of label-substring guesses.
3. **Re-check reminders (`register-reminders` under ADR 0030):**
   - `cdd` register records set `dueAt` (`lastCompletedAt + recheckIntervalMonths`) once recorded (status `'recorded'`, which is **non-terminal** so `evaluateRegisterDueAndReviewReminders` keeps evaluating `dueAt` — with terminal states only `'archived'` / `'superseded'`). Transitioning past due date or receiving `due_at` reminders uses the existing **`register-reminders` (`caj-reg-rem-<env>`, `register:run_reminders`)** job inside `guardedJob` (mandatory `tenantId`, daily `job_runs` ledger + `register_reminder_states` idempotency, immediate `register_reminder` in-app + email + Teams alerts, **zero new Bicep job**). Add recipient resolver mode `'client_owner_or_recent_fee_earner'` per §3.4.

---

## 9. Help and Documentation (Rule 11 & Stage 1 §6 Rule 6)

Plain British English for firm users (zero code identifiers, table names, or migration numbers):
- **New article:** `src/docs/articles/client-due-diligence.ts` (registered in `src/docs/registry.ts` under section `people-organisations`): explains client-level CDD records (reused across matters), checklists by client type and risk tier, uploading ID/address/source-of-funds evidence, recording manual checks (`"Recorded manually by..."`), what `"Not checked"` means for sanctions & PEP until an external provider is connected, re-check intervals (3 years standard / 1 year high), and who receives reminders.
- **Updated articles:**
  - `src/docs/articles/clients-and-contacts.ts`: add section on viewing and updating client CDD status on Person and Organisation profiles.
  - `src/docs/articles/matter-opening-and-risk.ts`: note how the matter opening form now reflects the client's recorded CDD status instead of estimated status.
  - `src/docs/articles/registers-engine.ts`: add client-subject registers (`Client Due Diligence`) and checklist/evidence fields to the guide.
  - `src/docs/articles/home-and-profile-screens.ts`: describe the Risk & Compliance CDD queue panel once wired to live `cdd` records.
  - `src/docs/articles/tenant-settings.ts`: document configuring client-type CDD checklists, re-check intervals, and evidence size limits in Administration.
- **Technical notes:** Document migration `0025`, `ADR 0039`, and `GET /api/evidence/download` in `docs/guides/platform-technical-notes.md` and `docs/release-notes.md`.

---

## 10. Tests

1. **Migration round-trip (`core/tests/migrations-postgres.test.ts`):** verify `0025` `up -> down -> up` cleanly after `0024` (indexes, `evidence_artifacts`, `organisation_type.system_key` backfill).
2. **Unit & contract (`core/tests/registers-engine-s024.test.ts`, `core/tests/config-engine.test.ts`, `core/tests/tenant-config-usage.test.ts`, `src/domain/__tests__/noDemoLiterals.test.ts`):**
   - Client-subject register validation (`personId` XOR `organisationId`), `'checklist'` / `'evidence'` field validation, missing/invalid notes on `'not_applicable'`.
   - Checklist resolution across all `organisation_type` `systemKey`s and all 6 `risk_rating` `systemKey`s (`low` -> standard 3y, `high`/`critical`/`sensitive` -> enhanced 1y).
   - `tenant-config-usage.test.ts` passes with every new `cdd.*` and `registers.*` key exercised.
   - `noDemoLiterals.test.ts` still fails on unbacked `"Sanctions & PEP: Clear"` strings and passes only when backed by manual check wording.
3. **Two-tenant PG16 isolation & RBAC (`core/tests/cdd-workflow-s104.test.ts`):**
   - Client CDD creation, checklist item updates, manual ID/Sanctions&PEP linkage to `public.intake_check_records`, completing CDD (`dueAt` calculation), refreshing on subsequent matter.
   - Evidence upload (`POST /api/evidence/upload`) rejecting infected/oversized/bad-extension files; download (`GET /api/evidence/download`) verifying HMAC token, DB ownership, MIME headers, and rejecting tampered `token`/`evidenceId`/`blobKey`, cross-tenant tokens (`tenant-bravo` vs `tenant-alpha`), forged `TenantContext` claims, and non-`risk:view` access to employee-client ID scans.
   - Re-check reminder sweep (`executeRegisterRemindersForTenant` / `guardedJob('register-reminders')`): two-tenant isolation, `tenantId` requirement, idempotent non-duplication on repeat runs, recipient fallback (`owner` -> most recent non-draft matter fee earner -> `risk_compliance`), and leaver/restricted-matter respect.
   - `REGISTER_RECORD_VISIBLE_SQL_PREDICATE` empty-allow-list participant fallback parity test.
4. **Guards (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`, `actionPermissionGuard.test.ts`):**
   - **Zero** new entries in `PERMANENT_ALLOW_LIST` (`<= 12`), `DEFERRED_S1_02B_ALLOW_LIST` (`0`), or `TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST` (`<= 8`). Every new CDD loader uses SQL-scoped queries (`listVisibleRegisterRecords` filtered by `personId`/`organisationId`).
   - `actionPermissionGuard.test.ts` passes with `MAX_KNOWN_GAPS = 0` and verifies every new action and `/api/evidence/*` route + MFA requirement on `saveCddConfigAction`.
5. **Playwright E2E (`e2e/role-journeys.spec.ts`, run via `npx playwright test --reporter=line --global-timeout=900000`):**
   - **New journey:** Fee earner (or Enquiries Coordinator / Risk & Compliance) opens a newly created Individual client profile (`/people/[id]`), confirms `"CDD not started"` and `"Sanctions & PEP: Not checked"`, records manual Photo ID + Proof of Address checklist items with clean evidence upload, marks CDD recorded (verifying `"Recorded manually by ..."` and 3-year re-check due date), then opens `/matters/new` for that client and sees the real recorded CDD status reflected.

---

## 11. Expected `docs/roadmap/feature-list.md` Row 4 Update

When `S1-04` lands, update **row `4`** ("What exists" & "What's missing"):
- **Add to "What exists":** Client-level `cdd` register workflow on People & Organisations (`0025`, `ADR 0039`), configurable client-type × risk checklist templates, S1-03 `'evidence'` upload/malware-scan & `/api/evidence/download` (`public.evidence_artifacts`), manual `"Recorded manually by..."` display & `Sanctions & PEP` manual recording integration (`intake_check_records`), real CDD summary replacing `computeClientRelationshipCdd` heuristics on matter opening, and scheduled re-check reminders via `register-reminders`.
- **Narrow "What's missing" to:** `"A High rating triggers nothing. Matter number format isn't configurable. Opening gate pre-conditions per work type and audited overrides (S1-05). Live E-ID provider and Sanctions & PEP screening provider integrations (F24, F25)."`
- Keep row 4 status as **Partly built** until `S1-05` completes.

---

## 12. Commit Breakdown (Each Independently Testable)

1. `feat(s1-04): extend @platform/core-api and registers engine for client-subject CDD, checklist/evidence fields, and buildMatterHiddenFromViewerSql convergence` (`core/src/api/`, `core/src/domain/registers/`, `core/src/tenancy/registerRepository.ts`, unit tests).
2. `feat(s1-04): add migration 0025 (evidence_artifacts, client register indexes, organisation_type systemKeys) and seed keys` (`core/src/tenancy/migrations/index.ts`, `core/src/tenancy/evidenceRepository.ts`, `src/seed/lists.ts`, `data/seed-not-a-law-firm.json`, migration round-trip test).
3. `feat(s1-04): add CDD configuration schema, deep-merge, and demo defaults` (`core/schemas/`, `core/src/config-engine/`, `client-not-a-law-firm/config/base.json`, `config-engine.test.ts`, `tenant-config-usage.test.ts`).
4. `feat(s1-04): add CDD RBAC permissions, server services, /api/evidence upload/download routes, and re-check reminder recipient routing` (`core/src/domain/rbac/registry.ts`, `src/platform/tenantRuntime.ts`, `src/server/`, `src/app/actions.ts`, `src/app/api/evidence/`, `core/tests/cdd-workflow-s104.test.ts`, guard tests).
5. `feat(s1-04): build client CDD workspace UI, profile summaries, Admin config panel, and real MatterFormClient CDD status` (`src/components/`, `src/domain/matterOpeningRecord.ts`, `src/server/pageLoaders.ts`, `e2e/role-journeys.spec.ts`).
6. `docs(s1-04): add Client Due Diligence Help articles, technical notes, release notes, and update feature-list row 4` (`src/docs/`, `docs/`).

---

## 13. Risks and Open Questions

- **Risk `R1` (manual vs automated):** Enforced via explicit UI wording (`"Recorded manually by..."`), leaving `"Sanctions & PEP: Not checked"` unless manually logged, and extending `noDemoLiterals.test.ts`.
- **Risk `R3` (storage):** `local-fs` demo-only exception applies; live tenants remain blocked until `azure-blob` ships.
- **Risk — `noWholeTenantLoadInRequestPaths` compliance:** `/people/[id]`, `/organisations/[id]`, and `executeRegisterRemindersForTenant` must avoid adding new `listAllPeople` / `listAllMattersUnfiltered` request-path calls (`listVisibleRegisterRecords` SQL filters + scoped `employeesAndLeaversOnly` / `getMatterById` only).

### Open questions for owner confirmation (please reply with numbers)
1. **Default role for `cdd:record` (`§6`):** Should `legal_secretary` (Support Staff) hold `cdd:record` by default alongside fee earners, partners, supervisors, and Risk & Compliance, or should recording CDD checks be restricted to `fee_earner`, `supervisor`, `partner`, `managing_partner`, `risk_compliance`, and `admin`? *(Plan proposes including `legal_secretary` since support staff often collect/upload client ID at onboarding; easy 1-line toggle in `DEFAULT_RBAC_ROLES`.)*
2. **Approval step on Standard vs High-risk CDD records:** Does completing a client `cdd` checklist become effective immediately once all required items are recorded by a permitted user (`'recorded'`, with optional Risk & Compliance review), or should High-risk client CDD itself require a second approver before marking CDD complete (separately from S1-05's High-risk *matter* sign-off)? *(Plan proposes immediate `'recorded'` status so High-risk client + High-risk matter isn't double-gated twice by two separate two-person registers, while `S1-05` enforces the two-person Partner + Risk & Compliance gate at matter opening.)*
3. **`Low` risk rating (`risk_rating.low`) CDD tier (`§3.3`):** Confirm the proposal that `risk_rating.low` uses the **Standard** checklist (`3`-year re-check) rather than skipping CDD items by default.
4. **Mapping `public_body`, `barristers_chambers`, `non_profit`, `plc`, `law_firm`, `insurer`, `supplier` (`§3.2`):** Confirm the proposed `systemKey` groupings onto `company_or_llp` vs `trust_charity_or_partnership`.

---

## 14. Estimate (`3.5–4` days)

- Combined WP2 budget in [stage-1-plan.md](../stage-1-plan.md) §5a is **`6–8` days** (`S1-04` + `S1-05`).
- **`S1-04` estimate: `3.5–4` days** (`0.5d` core engine + migration `0025`, `0.5d` config schema + seeds, `1d` evidence routes + CDD services + reminders + two-tenant tests, `1–1.5d` UI + MatterForm integration + Playwright + Help). Together with `S1-05` (`3–4` days), WP2 sits within **`6.5–8` days**.
- **Cut/move lever if `S1-04` pushes past 4 days:** Defer the interactive Admin CDD checklist editor UI (`saveCddConfigAction` stays implemented & tested; runtime editing waits for a quick WP3 follow-up while demo config lives in `base.json`), saving ~`0.5` day without compromising security, isolation, or end-to-end journeys.
