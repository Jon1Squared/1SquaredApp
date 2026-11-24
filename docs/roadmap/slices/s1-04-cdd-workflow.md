# S1-04: Client Due Diligence (CDD) Workflow, Evidence Storage, and Re-Check Reminders

| | |
|---|---|
| Backlog | Row `4` (Client and matter inception), plus item `16` alignment (`aml_and_cdd_queue`) |
| Decision | Stage 1 decisions `S1-D5`, `S1-D10`; Owner decisions (24 Nov 2026); [ADR 0032](../../decisions/0032-registers-engine.md), [ADR 0038](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md), Proposed [ADR 0039](../../decisions/0039-registers-engine-extensions-cdd-high-risk.md) |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP2 (`S1-04`) |
| Branch | `s1-04-cdd-workflow`, from `develop` (`1093e45` baseline), targeting `develop` |
| Change class | Core extension-point & engine evolution (`@platform/core-api` v`2.2.0`, `core/src/domain/registers/`), Core tenancy schema + repositories + expand migration `0025` (`core/src/tenancy/`), Core configuration schema & deep-merge (`core/schemas/`, `core/src/config-engine/`), Host services/actions/routes/page loaders/UI (`src/`), Demo client configuration (`client-not-a-law-firm/config/`), Help documentation (`src/docs/`) |
| Layer | Core API (`core/src/api/`), Core registers & RBAC (`core/src/domain/`), Core tenancy (`core/src/tenancy/`), Core config (`core/src/config-engine/`, `core/schemas/`), Host server & UI (`src/`), Client config (`client-not-a-law-firm/`) |
| Size | L (`3.5–4` days with `R760` Lever 1 pulled; `4–5` days un-trimmed — see §14) |
| Depends on | `S1-02a`, `S1-02b`, `S1-03` (all merged to `develop`); Approval of Proposed [ADR 0039](../../decisions/0039-registers-engine-extensions-cdd-high-risk.md) before coding |
| Blocking manual tasks | None in dev/test; existing Stage 1 §8 manual demo-deploy (`caj-migrate-demo`) when WP2 deploys. Risk `R3` still prohibits storing real live client CDD evidence until `azure-blob` replaces `local-fs`. |
| Baseline | `develop` at `1093e45` |

---

## 1. Change Class and Layer Breakdown

| Part | Change class | Layer |
|---|---|---|
| `subjectScope`, `RegisterPermission` (`'cdd:view' \| 'cdd:record'`), `'checklist'`, `'evidence'`, additive `IntakeEvidenceArtifactRef` fields & `CORE_API_VERSION = '2.2.0'` | Core extension API (additive, Rule 7) | `core/src/api/registers.types.ts`, `core/src/api/index.ts` |
| Core `'cdd'` register type, checklist/evidence validators, `buildMatterHiddenFromViewerSql` convergence | Core domain engine & tenancy SQL | `core/src/domain/registers/index.ts`, `core/src/tenancy/registerRepository.ts`, `core/src/tenancy/searchRepository.ts` |
| `cdd:view` & `cdd:record` permissions (excluding `admin` & `finance`; including `legal_secretary`) | Core RBAC registry | `core/src/domain/rbac/registry.ts` |
| Migration `0025` (`evidence_artifacts`, client register indexes, `organisation_type` `metadata_json->>'systemKey'` backfill + audit), `TenantEvidenceArtifactRepository`, `executeMergeInTransaction` repointing (`intake_check_records`, `evidence_artifacts`), `TenantIntakeCheckRepository` runtime accessor | Core tenancy persistence | `core/src/tenancy/migrations/index.ts`, `core/src/tenancy/evidenceRepository.ts`, `core/src/tenancy/partyRepository.ts`, `core/src/tenancy/registerRepository.ts`, `src/platform/tenantRuntime.ts` |
| `cdd` config schema (`clientTypeMapping`, `riskTierMapping`, `checklists`, `recheckIntervals`, `reminderRecipients`), `registers` schema updates, deep-merge, runtime usage | Core configuration engine & schemas | `core/schemas/tenant-config.schema.json`, `core/schemas/registers.config.schema.json`, `core/src/config-engine/index.ts`, `core/tests/tenant-config-usage.test.ts` |
| Server services, `/api/evidence/upload` & `/api/evidence/download`, `ACTION_PERMISSIONS`/`ROUTE_PERMISSIONS`, scoped page loaders, reminder dispatch | Host server & HTTP handlers | `src/server/services.ts`, `src/server/actionPermissions.ts`, `src/app/actions.ts`, `src/app/api/evidence/`, `src/server/pageLoaders.ts` |
| Client-mode registers panel on Person & Organisation profiles, Admin CDD settings panel, MatterFormClient real CDD status | Host UI | `src/components/PersonProfileClient.tsx`, `src/components/OrganisationProfileClient.tsx`, `src/components/RegistersWorkspaceClient.tsx`, `src/components/CddChecklistCard.tsx`, `src/components/MatterFormClient.tsx`, `src/components/HomeClient.tsx`, `src/components/AdminClient.tsx` |
| Seed `organisation_type` `systemKey`s & invented demo CDD defaults | Client config & test fixtures | `client-not-a-law-firm/config/base.json`, `src/seed/lists.ts`, `data/seed-not-a-law-firm.json` |
| Plain-English Help & release notes (Rule 11, Stage 1 §6 rule 6) | Help documentation | `src/docs/articles/`, `src/docs/registry.ts`, `docs/release-notes.md` |

---

## 2. What Exists Today (`develop` at `1093e45`)

1. **Risk ratings (`data/seed-not-a-law-firm.json:2850-2907`, `src/seed/lists.ts:294-308`, `src/domain/matterOpeningRecord.ts:839-869, 952-973`):**
   - Six active `risk_rating` values, all carrying stable `systemKey`s: `low` (`risk_rating.low`), `medium` (`risk_rating.medium`), `high` (`risk_rating.high`), `critical` (`risk_rating.critical`), `conflict_flagged` (`risk_rating.conflict_flagged`), `sensitive` (`risk_rating.sensitive`).
   - `matters.risk_rating_id` (`migrations/index.ts:965`) and `matters.risk_assessment_json` (`:983`) store matter risk derived server-side in `saveMatterRecord` (`src/server/services.ts:7516-7547`). Note (`R749`): a `Person` has **no** `riskRatingId` (`Organisation` carries `riskRatingId` at `src/domain/types.ts:682` and `reviewDate` at `:684`; `Person` carries `verificationStatusId` and `verifiedAt` / `lastVerifiedAt` at `src/domain/types.ts:606-615`), and matter risk scoring produces only `'Low' | 'Medium' | 'High'` (`matterOpeningRecord.ts:21`) — `'critical'` and `'sensitive'` come from explicit/organisation risk ratings.
2. **Honest `"Sanctions & PEP: Not checked"` displays and CI guards:**
   - `src/components/PersonProfileClient.tsx:126-194, 505-517, 1245-1284` (`resolvePersonComplianceDisplay`): derives `idVerification` from `verificationStatusId` + `verifiedAt`, hardcodes `sanctionsAndPep: { label: 'Not checked', pillClass: 'client-pill--neutral' }` (`:188-191`), and hardcodes `recheckDue: 'Not set'` (`:192`).
   - `src/components/OrganisationProfileClient.tsx:146-263, 495-507, 1205-1285, 1911-1960` (`resolveOrganisationComplianceDisplay`): computes `companyVerification`, `conflictCheck`, `ableToAct`, `recheckDue: formatDate(organisation.reviewDate) || 'Not set'`, and hardcodes `sanctionsAndPep: { label: 'Not checked', tone: 'neutral' }` (`:246-249`).
   - `src/components/HomeClient.tsx:4516-4540` (`high_risk_matters_and_pep_register`) renders `"PEP & sanctions watch: Not yet available"`; `aml_and_cdd_queue` (`rc_aml_pending`) renders a neutral empty state.
   - `src/domain/__tests__/noDemoLiterals.test.ts:57-91, 155-230, 384-410, 747-790` bans fake `"Sanctions & PEP: Clear"` literals and asserts both display resolvers return `'Not checked'` unless a real recorded check exists.
3. **Derived client CDD status on matter opening (`computeClientRelationshipCdd`, `R698`) & legacy matter CDD fields (`R750`):**
   - `src/domain/matterOpeningRecord.ts:2357-2528` (`computeClientRelationshipCdd`) currently guesses client CDD currency from `verificationStatusId` / `relationshipStatusId` **display label substring matching** (`resolveLabel(...).toLowerCase()`), `organisation.reviewDate`, and legacy prior matter `amlStatus === 'Verified'`.
   - Fed by `loadMatterFormPageData` / `loadMatterDetailPageData` (`src/server/pageLoaders.ts:2415-2435, 2755-2775`) and `listClientPriorMattersAction` (`src/app/actions.ts:1979-1987` -> `src/server/services.ts:30865-30930`), consumed in `MatterFormClient.tsx:1839-1965` (`userEditedCddRef`) to pre-fill Q2.1 (`clientRelationshipStatus`).
   - Separately (`R750`), `MatterFormClient.tsx:1172-1174` and `:12020-12033` still render editable matter-level `amlStatus`, `sourceOfFundsVerified`, and `sourceOfWealthVerified` inputs saved directly at `services.ts:5196-5197`.
   - **S1-04 replaces both:** `computeClientRelationshipCdd` uses real client `cdd` register records (`getActiveClientCddSummary`, falling back to `'New client'` / `'CDD not started'`), the three legacy matter-level fields become read-only derived values on `MatterFormClient`, and `saveMatterRecord` ignores client-supplied legacy CDD values (`R750`).
4. **Registers engine (`core/src/domain/registers/index.ts`, `core/src/tenancy/registerRepository.ts`):**
   - Supports `sign_off`, `undertaking`, `complaint`, `breach` (`CORE_REGISTER_TYPES`, `:67-437`), scalar fields (`:752-839`), `public.register_records` with `person_id`/`organisation_id` columns (`migrations/index.ts:2048-2051`) lacking client indexes, and `register-reminders` hourly job (`src/server/services.ts:28088-28370`). Note (`R743`): `0017_registers_engine_expand` indexes `(tenant_id, register_type_key, status, updated_at DESC)`, `matter_id`, `due_at`, and `review_at` (`migrations/index.ts:2068-2080`), plus `0018` adds GIN/trigram indexes — specifically `person_id` and `organisation_id` lack indexes.
   - **Two bugs/gaps to fix while extending (`R755`):**
     1. `REGISTER_RECORD_VISIBLE_SQL_PREDICATE` (`registerRepository.ts:39-52`) lacks the empty-allow-list participant fallback and `restrictedAccessUserIdsFallback` of `buildMatterHiddenFromViewerSql` (`intakeQuoteRepository.ts:812-842`);
     2. `listRegistersWorkspaceDataRecord` (`services.ts:27111-27117`) and `listTransitionsForRecord` inside `getRegisterRecordDetailRecord` (`services.ts:27249-27251`) omit `hasRestrictedMatterAccess` / `includeRestricted` after `canPersonAccessMatter` already succeeded.
   - `RegistersWorkspaceClient.tsx:1-1146` only exposes `matterId` (`lockedMatterId` on `MatterProfileClient.tsx:3544-3560`); client subject linking (`personId` / `organisationId`) is absent.
5. **S1-03 evidence storage & intake checks (`R746`):**
   - `DocumentStorageProvider.putObject` (`core/src/api/index.ts:617`, `core/src/tenancy/blobStorage.ts:189-243`) scans bytes with `scanBytesForMalwareAndMacros` (`:104`), hashes SHA-256, and writes `tenant-<tenantId>-<env>/evidence/<safeId>/<safeName>`, **but `putObject` does NOT refuse infected files** (`blobStorage.ts:214-231` writes bytes and returns `scanStatus`). Therefore `uploadEvidenceArtifactService` **must call exported `scanBytesForMalwareAndMacros` before `putObject`** and refuse infected or macro-bearing files with `EVIDENCE_MALWARE_DETECTED`.
   - `IntakeEvidenceArtifactRef` (`core/src/api/index.ts:2166-2172`) currently contains only `{ blobKey, sha256, contentType, sizeBytes, scanStatus }` — `S1-04` adds optional `fileName`, `uploadedByActorId`, and `uploadedAt` additively (`CORE_API_VERSION = '2.2.0'`, `ADR 0039` §6) and persists full metadata in `public.evidence_artifacts`.
   - `verifyEvidenceArtifacts` (`core/src/integrations/intake-checks/manualProviders.ts:81-133`) is currently **module-private** and is exported in `S1-04` (preserving optional `{ fileName?, uploadedByActorId?, uploadedAt? }` fields), alongside exposing `getIntakeCheckRepository()` on `src/platform/tenantRuntime.ts:983-1045`. Because `verifyEvidenceArtifacts` performs blob-storage I/O (`getMalwareScanStatus`, `getObjectBytes`), run it immediately **before** `withTenantTransaction` (`ADR 0039` §2), then verify `public.evidence_artifacts` DB ownership/checksum atomically **inside** `withTenantTransaction`.
   - `src/app/api/documents/download/route.ts:43-86` strictly requires `public.documents` (`verified.documentId`), so `S1-04` adds `GET /api/evidence/download` + `POST /api/evidence/upload` backed by `public.evidence_artifacts`.
6. **Codebase contradiction flagged explicitly:**
   - `Stage1-WP2-plan-prompt.md` specifies mapping client types using `systemKey`, never labels. In `develop` (`1093e45`), `organisation_type` choice values (`data/seed-not-a-law-firm.json:1163-1259`, `src/seed/lists.ts:166-171`) currently have **no `systemKey`** at all (stored inside `choice_values.metadata_json->>'systemKey'`, since `choice_values` has no `system_key` column per `migrations/index.ts:1496-1507`). Migration `0025` (using migration `0021`'s `jsonb_set` + `migration_0025_backfill_audit` pattern, `R743`) + `src/seed/lists.ts` + `data/seed-not-a-law-firm.json` backfill `systemKey` onto all 13 `organisation_type` values so S1-04 maps strictly by `systemKey` without label matching or silent fallback.

---

## 3. Demo CDD Configuration, Checklists, `systemKey` Mappings & Reminder Recipients

All values below are **invented demo defaults** living in `client-not-a-law-firm/config/base.json`, validated by JSON Schema + Zod, and editable via `saveCddConfigAction` (with core schema defaults remaining neutral empty rules).

### 3.1 Checklist templates (`S1-D5`, `S1-D10`) and immediate completion (Owner Answer 2)

| Client CDD category key | Standard risk items (`riskTier: 'standard'`) | Additional High-risk items (`riskTier: 'high'`, additive on top of Standard) |
|---|---|---|
| `individual` | `photo_id` ("Photo ID", linked to manual `identity_verification`), `proof_of_address` ("Proof of address") | `source_of_funds` ("Source of funds"), `source_of_wealth` ("Source of wealth") |
| `company_or_llp` | `companies_house_record` ("Companies House record"), `beneficial_owners_over_25` ("Beneficial owners over 25%"), `director_photo_id` ("ID for one director", linked to manual `identity_verification`) | `ownership_structure_chart` ("Ownership structure chart"), `source_of_funds` ("Source of funds") |
| `trust_charity_or_partnership` | `founding_document` ("Founding document"), `controllers_id` ("Controllers' ID", linked to manual `identity_verification`) | `source_of_funds` ("Source of funds") |

- **Completion model (Owner Answer 2, confirmed 24 Nov 2026):** As soon as every required checklist item is recorded by a permitted user (`cdd:record`), the `cdd` record becomes **`'recorded'`** immediately (`dueAt` set from completion date + tier interval). There is **no second approver** for client CDD (the two-person control sits on High-risk matter opening in `S1-05`).
- **Optional Sanctions & PEP manual check slot:** Every CDD checklist also renders a separate, explicitly manual `Sanctions & PEP check (manual)` section backed by `SanctionsPepScreeningProvider` (`provider: 'manual'`), defaulting to **Not checked** (`sanctions_pep` outcome absent) until a user holding `cdd:record` explicitly records a manual check with date and evidence (Risk `R1`).

### 3.2 Subject mapping onto existing configuration (`systemKey` only — Owner Answer 4 confirmed 24 Nov 2026)

1. **All `Person` records (`subjectType === 'person'`):** map unconditionally to `individual`. (A `Person` acting via their sole trader business still undergoes individual identity checks; when instructing as an `Organisation` with `organisation_type` `sole_trader`, see below.)
2. **All 13 `Organisation` legal forms (`organisation.organisationTypeId` resolved via `choice_values.metadata_json->>'systemKey'`):**

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

### 3.3 Risk rating mapping (`risk_rating.systemKey` -> CDD risk tier & re-check interval — Owner Answer 3 confirmed 24 Nov 2026)

All 6 configured `risk_rating` values (`data/seed-not-a-law-firm.json:2850-2907`):

| `risk_rating.id` | `systemKey` | Mapped CDD tier | Re-check interval | Rationale |
|---|---|---|---|---|
| `risk_rating.low` | `low` | **`standard`** | **3 years** (`36` months) | Confirmed by owner (24 Nov 2026): Low risk uses the **Standard** checklist and 3-year interval (`Reg 28` basic client ID/constitutional verification; statutory SDD exemptions captured via `'not_applicable'` with mandatory note where justified). |
| `risk_rating.medium` | `medium` | `standard` | **3 years** | Normal standard CDD baseline. |
| `risk_rating.conflict_flagged` | `conflict_flagged` | `standard` | **3 years** | Conflict flag does not itself imply ML/TF escalation unless matter/client risk is separately High/Critical/Sensitive. |
| `risk_rating.high` | `high` | `high` | **1 year** (`12` months) | Requires enhanced due diligence (source of funds/wealth or ownership chart) + annual review. |
| `risk_rating.critical` | `critical` | `high` | **1 year** | Highest risk tier; triggers enhanced CDD + annual review. |
| `risk_rating.sensitive` | `sensitive` | `high` | **1 year** | Reputational/PEP/political/media sensitivity warrants enhanced due diligence (`high` tier) + annual review; **does NOT trigger `high_risk_opening`** (only `'high'` and `'critical'` trigger two-stage `high_risk_opening` via `isHighOrCriticalRiskRating`, `R749`). |

### 3.3a Client CDD Tier Derivation & Standard → High Upgrade (`R749`)
Because `Person` has no `riskRatingId`, matter scoring produces only `Low | Medium | High` (`matterOpeningRecord.ts:21`), and a client may already hold a Standard CDD record when a new High-risk matter opens:
- **Required client tier:** Computed dynamically as `maxTier(clientOwnRating, openingOrOpenNonClosedMattersRatings)` — the higher of the client's own `riskRatingId` (on `Organisation`) and the rating of any of that client's matters currently opening (or explicitly upgraded by Compliance/partner).
- **In-place Standard → High upgrade:** When a matter (or updated client rating) requires the `'high'` tier and the client's existing `cdd` record is `'standard'` (`'in_progress'` or `'recorded'`), `upgradeClientCddToHighRisk` appends the High-risk checklist items (`highAdditional` for that client category) onto the existing record, keeps all already-recorded Standard items and uploaded evidence untouched, and transitions `'recorded'` → **`'in_progress'`** (`riskTier: 'high'`) until the newly added High-risk items are recorded.
- **Interval reset on High-tier completion:** Once those remaining High-risk items are recorded and the record returns to `'recorded'`, `dueAt` is calculated as **`1` year (`12` months) from the High-tier completion date**.

### 3.4 Re-check reminder recipient order, employee-client rule & justification
- **Recipient resolution priority for `cdd` reminders (`recipientMode: 'client_owner_or_recent_fee_earner'`):**
  1. **Primary:** Active, non-leaver **client relationship owner** (`record.ownerId` on the `cdd` record, defaulted from `person.relationshipOwnerId` / `organisation.relationshipOwnerId` or assigned partner/owner).
  2. **Fallback 1 (when client has no active relationship owner):** Active, non-leaver **`responsibleFeeEarnerId` (else `responsiblePartnerId`) on the client's most recently updated or opened non-draft matter** holding `'cdd:view'` and respecting staff-matter access.
  3. **Fallback 2 (when client has no active owner or non-draft matter fee earner, e.g. dormant client whose owner became a leaver):** Active users holding both `'cdd:view'` and `'risk:view'` (`risk_compliance`, excluding `admin` per `DEFAULT_RBAC_ROLES.admin.permissions` filter) so overdue reviews never drop silently into a void and never reach `admin`.
- **Employee-client filter (`R747`):** Whenever the CDD subject has `isEmployee === true` (or active/leaver employment), filter candidate recipients strictly through the `R747` visibility rule (`'cdd:view'` **AND** (`'risk:view'`, `'matter:restricted:access'`, or active participant on a matter for that employee-client)) **before** sending or enqueuing notifications/emails/Teams alerts — omitting any non-permitted owner and falling back to active `'cdd:view'` + `'risk:view'` users.
- **Justification:** When a firm has an active client relationship owner (partner/client partner), they hold continuous accountability across multiple matters and know whether the firm still acts (`Ongoing monitoring`). Without a named relationship owner, the fee earner on the most recent matter holds current client contact without burdening compliance unnecessarily; the `risk_compliance` fallback catches orphan/leaver gaps cleanly (`no_permitted_recipients` avoided).

---

## 4. Data Model, Expand Migration `0025`, Backfill, Merge & Retention Plan

- **Migration ID:** `0025_registers_cdd_and_org_type_keys_expand` (raises `CORE_REQUIRED_SCHEMA_VERSION = '0025'`, `dependsOn: ['0009', '0012', '0017', '0021', '0023']`).
- **Default runtime privileges (`R743`):** Cluster bootstrap (`core/src/tenancy/postgresAdminBootstrap.ts:205-211`) configures default privileges on `<runtimeRole>` for new tables and sequences automatically, matching migrations `0023` and `0024` — **do NOT emit explicit `GRANT ... TO <runtimeRole>` statements**.
- **Expand DDL (`upSql`):**
  1. **Client-subject indexes on `public.register_records`:**
     - `idx_register_records_tenant_person ON public.register_records (tenant_id, person_id, register_type_key, status) WHERE person_id IS NOT NULL;`
     - `idx_register_records_tenant_organisation ON public.register_records (tenant_id, organisation_id, register_type_key, status) WHERE organisation_id IS NOT NULL;`
  2. **Evidence artifact metadata table (`public.evidence_artifacts`) + sequence:**
     - `CREATE SEQUENCE IF NOT EXISTS public.tenant_evidence_artifact_id_seq START WITH 1 INCREMENT BY 1;`
     - Table columns: `tenant_id TEXT NOT NULL`, `id TEXT NOT NULL` (`EVD-000001`), `blob_key TEXT NOT NULL`, `subject_type TEXT NOT NULL CHECK (subject_type IN ('person', 'organisation', 'matter', 'enquiry', 'quote', 'register'))`, `subject_id TEXT NOT NULL`, `file_name TEXT NOT NULL`, `content_type TEXT NOT NULL`, `byte_size BIGINT NOT NULL CHECK (byte_size > 0)`, `sha256 TEXT NOT NULL`, `scan_status TEXT NOT NULL CHECK (scan_status IN ('clean', 'infected', 'pending'))`, `uploaded_by_person_id TEXT NOT NULL`, `uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `PRIMARY KEY (tenant_id, id)`, `CONSTRAINT uq_evidence_artifacts_blob UNIQUE (tenant_id, blob_key)`.
     - Index: `idx_evidence_artifacts_tenant_subject ON public.evidence_artifacts (tenant_id, subject_type, subject_id, uploaded_at DESC)`.
  3. **`organisation_type` `systemKey` backfill in `metadata_json` (`upSql`, exact migration `0021` pattern `core/src/tenancy/migrations/index.ts:2735-3017`, `R743`):**
     - `public.choice_values` has **no `system_key` column** (`migrations/index.ts:1496-1507`); `systemKey` lives at `metadata_json->>'systemKey'`.
     - Create `public.migration_0025_backfill_audit (tenant_id TEXT NOT NULL, entity_kind TEXT NOT NULL, record_id TEXT NOT NULL, written_value TEXT NOT NULL, PRIMARY KEY (tenant_id, entity_kind, record_id))` locked down with `REVOKE ALL` from `PUBLIC` and `role_tenant_<slug>`.
     - Use a `WITH org_type_mapping(id, list_key, sys_key) AS (VALUES ...)` CTE mapping all `13` `organisation_type.*` IDs (`organisation_type.company` → `'company'`, ..., `organisation_type.trust` → `'trust'`), record each inserted audit row only where `COALESCE(cv.metadata_json->>'systemKey', '') = ''` and `NOT EXISTS` another row in `(tenant_id, 'organisation_type')` already holding that `systemKey`, and update `cv.metadata_json = jsonb_set(COALESCE(cv.metadata_json, '{}'::jsonb), '{systemKey}', to_jsonb(ica.written_value), true)`.
     - Keep `src/seed/lists.ts` and `data/seed-not-a-law-firm.json` in step (noting seed updates alone do not backfill existing tenants per `services.ts:1485-1501`).
- **Pre-storage malware guard & additive artifact ref (`R746`):**
  - `uploadEvidenceArtifactService` calls exported `scanBytesForMalwareAndMacros(bytes, safeName)` (`core/src/tenancy/blobStorage.ts:104`) **BEFORE** calling `putObject`, failing closed with newly defined **`EVIDENCE_MALWARE_DETECTED`** before writing any bytes to storage or `public.evidence_artifacts`.
  - Export `verifyEvidenceArtifacts` (`core/src/integrations/intake-checks/manualProviders.ts:81-133`, preserving optional `{ fileName?, uploadedByActorId?, uploadedAt? }` fields and running storage I/O immediately **before** `withTenantTransaction` while `public.evidence_artifacts` DB ownership/checksum checks run inside TX) and extend `IntakeEvidenceArtifactRef` (`core/src/api/index.ts:2166-2172`) additively with `{ fileName?: string; uploadedByActorId?: string; uploadedAt?: string }` (`ADR 0039` §6, `CORE_API_VERSION = '2.2.0'`).
- **Party merge repointing (`R754`):**
  - Extend `executeMergeInTransaction` (`core/src/tenancy/partyRepository.ts:3713-3757`) in `S1-04` so merging duplicate `person` or `organisation` records atomically repoints `public.intake_check_records.subject_id` and `public.evidence_artifacts.subject_id` (matching `subject_type = recordType`) alongside existing `register_records` repointing.
- **Reversible `downSql`:** Drops `idx_register_records_tenant_person`, `idx_register_records_tenant_organisation`, `idx_evidence_artifacts_tenant_subject`, `public.evidence_artifacts`, and `tenant_evidence_artifact_id_seq`, removes only `metadata_json - 'systemKey'` on `choice_values` rows recorded in `public.migration_0025_backfill_audit` (`entity_kind = 'choice_value'`), and drops `public.migration_0025_backfill_audit` — giving an exact `up -> down -> up` round-trip.
- **Existing client policy:** Existing clients start with **NO `cdd` register record** and display **`"CDD not started"`** (never fabricating checks or timestamps, Risk `R1`; hidden completely on employees per `R747`). Seed demo data (`src/seed/demo.ts` / `data/seed-not-a-law-firm.json`) adds explicit manual demo `cdd` records for 2–3 invented external sample clients plus unstarted clients for E2E coverage.
- **Retention policy (`R758`):** `cdd` register records, `public.intake_check_records`, `public.evidence_artifacts`, and `'evidence'` blobs are **never** deleted or scrubbed by any existing retention or anonymisation job (`enquiry-retention-anonymise`, `usage-retention-purge`, `outbox-drain`). Automated regulatory retention (`5` years after the client relationship ends, then delete) is logged as a pre-hosted-client backlog item (§11).

---

## 5. Configuration Schema Changes & Runtime Usage Compliance

Every new configuration key requires a JSON Schema entry, Zod validation, `loadAndValidateTenantConfig` deep-merge support (`core/src/config-engine/index.ts:3365-3981`), non-test runtime access (`core/tests/tenant-config-usage.test.ts`), and demo defaults in `client-not-a-law-firm/config/base.json`:

1. **`core/schemas/registers.config.schema.json` (and `core/src/api/registers.types.ts`):**
   - `RegisterTypeDefinition.subjectScope`: `enum: ["matter", "client", "any"]`, default `"any"`, description `"Restricts whether records attach to a matter, a client (person/organisation), or either."`.
   - `RegisterPermission`: widen additively with `'cdd:view' | 'cdd:record'`.
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
3. **`loadAndValidateTenantConfig` deep-merge, `tenant-config-usage.test.ts` & `R760` Lever 1:**
   - Add explicit deep-merge helper for `cdd` (and nested `clientTypeMapping`, `riskTierMapping`, `checklists`, `recheckIntervalsMonths`) in `core/src/config-engine/index.ts`.
   - Ensure every leaf under `cdd.*` and `registers` is read cleanly in runtime helpers (`resolveCddConfigForClient`, `createCddRecordService`, `executeRegisterRemindersForTenant`, `uploadEvidenceArtifactService`) so `core/tests/tenant-config-usage.test.ts` passes with **zero** unreferenced non-reserved leaves and **no** unintended `x-reserved` escapes.
   - Persist optional runtime overrides under `public.tenant_module_configs` (`config_key = 'cdd'`) via `saveCddConfigAction` (`register:configure` + `admin:access` + `mfaVerified: true`), with a read-only Admin CDD configuration summary panel in **Administration → CDD Settings**. Under **`R760` Lever 1** (`0.5` day saved to fit WP2 in 7–8 days), defer the full interactive Admin checklist-item editor UI to a short post-WP2 follow-up while schema, `base.json`, `saveCddConfigAction`, and tests ship complete in `S1-04`.

---

## 6. Permissions, Action Policies & Role Matrix (`R748` + Owner Answer 1 & Additional Decisions)

### New Permissions (`core/src/domain/rbac/registry.ts`)

- **`'cdd:view'`** (`domain: 'register'`, `sensitivity: 'standard'`, `requiresMfa: false`):
  - **Default roles holding it (`HomeRoleKey`):** `managing_partner`, `partner`, `risk_compliance`, `fee_earner`, `supervisor`, `legal_secretary`.
  - **Explicitly excluded (`R748` + owner decision 24 Nov 2026):** `admin` (explicitly filtered out alongside `'undertaking:manage'` in `DEFAULT_RBAC_ROLES.admin.permissions` at `core/src/domain/rbac/registry.ts:859-861`; system administrator role, not compliance/fee-earning), `finance` (no business need to inspect ID scans), `enquiries_coordinator`, and `intake`.
- **`'cdd:record'`** (`domain: 'register'`, `sensitivity: 'restricted'`, `requiresMfa: false`):
  - **Default roles holding it (`HomeRoleKey`):** `managing_partner`, `partner`, `risk_compliance`, `fee_earner`, `supervisor`, **`legal_secretary`** (confirmed by Owner Answer 1, 24 Nov 2026: support staff collect client ID).
  - **Explicitly excluded (`R748` + owner decision 24 Nov 2026):** `admin`, `finance`, `enquiries_coordinator`, and `intake`.
- **Core `'cdd'` register type alignment:** Bind `CORE_REGISTER_TYPES.cdd.permissions` to `'cdd:view'` and `'cdd:record'` (`RegisterPermission` widened in `core/src/api/registers.types.ts`) so generic `/registers` queries and writes enforce the same boundary against `admin` and `finance`.
- **Other reused permissions:** `risk:view` and `matter:restricted:access` (employee-client gating per `R747`), plus `register:configure` + `admin:access` (**`requiresMfa: true`** for `saveCddConfigAction`).

### New Server Actions & HTTP Routes (`src/server/actionPermissions.ts`, `MAX_KNOWN_GAPS = 0`)

| Entry | Registry map | Policy (`kind`, `key`, `enforcedBy`) — `R748` tightened |
|---|---|---|
| `startOrLoadClientCddAction` | `ACTION_PERMISSIONS` | `{ kind: 'permission', key: { anyOf: ['cdd:view', 'cdd:record'] }, enforcedBy: 'action' }` *(service enforces `cdd:record` when creating or upgrading)* |
| `recordCddChecklistItemAction` | `ACTION_PERMISSIONS` | `{ kind: 'permission', key: 'cdd:record', enforcedBy: 'action' }` *(no `register:edit` alternative)* |
| `completeClientCddAction` | `ACTION_PERMISSIONS` | `{ kind: 'permission', key: 'cdd:record', enforcedBy: 'action' }` *(no `register:edit` alternative)* |
| `recordManualSanctionsPepAction` | `ACTION_PERMISSIONS` | `{ kind: 'permission', key: 'cdd:record', enforcedBy: 'action' }` *(no `risk:view` write bypass — `risk_compliance` already holds `cdd:record`)* |
| `saveCddConfigAction` | `ACTION_PERMISSIONS` | `{ kind: 'permission', key: { allOf: ['admin:access', 'register:configure'] }, enforcedBy: 'action' }` *(enforces `mfaVerified: true` on both)* |
| `POST /api/evidence/upload` | `ROUTE_PERMISSIONS` | `{ kind: 'permission', key: 'cdd:record', enforcedBy: 'action' }` *(dropped `register:edit`, `register:create`, `matter:edit`; service verifies subject access, `R747`, malware pre-scan, & size limit)* |
| `GET /api/evidence/download` | `ROUTE_PERMISSIONS` | `{ kind: 'permission', key: 'cdd:view', enforcedBy: 'action' }` *(dropped `register:view` & `risk:view`; verifies HMAC `ScopedDownloadToken`, DB `evidence_artifacts` ownership, & `R747` employee-client access)* |

- **MFA enforcement on Admin configuration:** `/admin/registers` / `/admin/cdd` checks `admin:access` + `register:configure` with `mfaVerified: true` in `loadAdminPageData` and `saveCddConfigAction` (`enforcedBy: 'action'`). Non-MFA sessions are redirected from `/admin` to `/` and receive `MFA_REQUIRED` from `saveCddConfigAction`.

---

## 7. Visibility, Isolation & Composition with S1-09 Information Barriers (`R747`, `R755`)

1. **Who can see client CDD & evidence:**
   - **Standard external clients:** Any user holding `cdd:view` can inspect the CDD checklist summary on `/people/[id]`, `/organisations/[id]`, and `/registers?type=cdd`. Evidence file download (`GET /api/evidence/download`) requires `cdd:view` inside the request transaction plus HMAC token `sub === actor.id` and `tenantId === ctx.tenantId`.
   - **Employee-as-client full hiding (`R747`, `ADR 0014`):** For subjects with `person.isEmployee === true` (or active/leaver employment records), the **entire** CDD record — CDD card, status text (never displaying `"CDD not started"` or `"Recorded manually on..."` to non-permitted staff, because even `"CDD not started"` reveals the employee is a client of a staff matter), `/registers?type=cdd` rows, downloads (`/api/evidence/download`), and reminder recipients — is visible **only** to users holding **`'cdd:view'` AND**:
     - **`'risk:view'` or `'matter:restricted:access'`**, **or**
     - **active participation** (`leadFeeEarnerId`, `responsiblePartnerId`, `supervisingPartnerId`, or `teamMemberIds`) in a matter for that employee-client (`canPersonAccessMatter` check).
     *(Because `DEFAULT_RBAC_ROLES.admin.permissions` explicitly excludes `'cdd:view'` and `'cdd:record'`, `admin` never sees employee-client CDD or receives reminders despite holding `'risk:view'` / `'matter:restricted:access'`.)* Everyone else sees no CDD card or register row at all.
2. **SQL matter-visibility convergence (`R755`):**
   - `S1-04` converges `REGISTER_RECORD_VISIBLE_SQL_PREDICATE` (`core/src/tenancy/registerRepository.ts:39-52`) onto `buildMatterHiddenFromViewerSql` (`core/src/tenancy/intakeQuoteRepository.ts:812-842`) and passes `hasRestrictedMatterAccess` in `listRegistersWorkspaceDataRecord` (`services.ts:27111-27117`) and `listTransitionsForRecord` (`services.ts:27249-27251`) — fixing the bugs where a matter's own partner could miss register rows/transitions on empty-allow-list restricted matters. `stage-1-plan.md` §5 `S1-09` records that `registerRepository` was converged here in `S1-04`.
3. **S1-09 Information Barrier composition:**
   - S1-04 does **not** build barrier tables now.
   - All CDD queries route through `TenantRegisterRepository.listVisibleRegisterRecords` and `TenantEvidenceArtifactRepository.getArtifactByIdForActor`, separating matter predicates (`buildMatterHiddenFromViewerSql`) and client predicates (`buildClientRegisterVisibleSql` enforcing `R747` today). In `S1-09`, `buildClientRegisterVisibleSql` adds a single `NOT EXISTS` barrier clause on `(target_type IN ('person', 'organisation') AND target_id = ...)` without touching S1-04 services or routes.
4. **Two-tenant & tampered-ID guarantees (Rule 9):**
   - `public.register_records`, `public.evidence_artifacts`, `public.intake_check_records`, `ScopedDownloadToken` (`${tokenSigningKey}:${ctx.tenantId}`), and blob keys (`tenant-<tenantId>-<env>/evidence/...`) all embed and verify `ctx.tenantId` inside `withTenantTransaction`.
   - Any tampered cross-tenant `recordId`, `personId`, `organisationId`, `evidenceId`, `blobKey`, or download `token` fails closed (`NOT_FOUND` / `TENANCY_CROSS_TENANT_RECORD_ACCESS` / `403`).

---

## 8. Profiles (Risk `R1`), Legacy Matter CDD (`R750`), Matter Form & Reminders (`R758`)

1. **Profiles (`/people/[id]`, `/organisations/[id]`):**
   - Render the **Client Due Diligence** card on external clients (and on employee profiles strictly when permitted by `R747`; omitted completely otherwise).
   - When no `cdd` register record exists: show `"CDD not started"` (never `"Verified"`).
   - When manually recorded (`status === 'recorded'`): show **`"Recorded manually by <Person Name> on <DD Mon YYYY>"`**, risk tier (`Standard (3 years)` / `High (1 year)`), item progress (`X of Y required items recorded`), next re-check due date (`dueAt`), and downloadable verified evidence links (`cdd:view` + `R747`).
   - When upgraded in place from Standard → High (`'in_progress'`, `R749`): display already-recorded Standard items alongside the newly added outstanding High-risk items.
   - **`Sanctions & PEP` row (Risk `R1` + `noDemoLiterals.test.ts`):** stays `"Not checked"` (`client-pill--neutral`) **unless** an explicit manual `SanctionsPepScreeningProvider` check has been recorded, in which case it displays **`"Clear — Recorded manually by <Person Name> on <DD Mon YYYY>"`** (or `"Potential match flagged — Recorded manually..."`), never `"Screened by provider"`. Update `noDemoLiterals.test.ts` so unbacked `"Sanctions & PEP: Clear"` strings stay prohibited while explicit manual-record helper outputs are tested.
2. **Legacy matter-level CDD fields (`R750`) & matter opening wizard (`MatterFormClient.tsx`, `matterOpeningRecord.ts`):**
   - Make the legacy matter-level fields `amlStatus`, `sourceOfFundsVerified`, and `sourceOfWealthVerified` (`MatterFormClient.tsx:1172-1174, :12020-12033`) **read-only** on the form — displaying the derived status from the client's `cdd` register record where one exists, or falling back read-only to the historical stored matter value on existing matters when no client `cdd` record exists yet (preserving stored values on existing matters with **no migration**).
   - Update `saveMatterRecord` (`services.ts:5196-5197`) to **ignore** client-supplied `amlStatus`, `sourceOfFundsVerified`, and `sourceOfWealthVerified` values on save.
   - Update all `computeClientRelationshipCdd` callers (`loadMatterFormPageData`, `loadMatterDetailPageData`, `listClientPriorMattersAction`, `MatterFormClient.tsx`) to consume SQL-scoped `clientCddSummaries` (`"CDD current (recorded <date>, next re-check <date>)"`, `"CDD expired (<date>)"`, `"CDD in progress"`, or `"CDD not started"`).
3. **Re-check reminders (`register-reminders` under ADR 0030) & retention non-deletion (`R758`):**
   - `cdd` register records set `dueAt` (`lastCompletedAt + recheckIntervalMonths`: `36` months Standard, `12` months High) once `'recorded'` (non-terminal so `evaluateRegisterDueAndReviewReminders` keeps evaluating `dueAt`; terminal states are `'archived'` / `'superseded'`). Reminders execute inside existing **`register-reminders` (`caj-reg-rem-<env>`, `register:run_reminders`, zero new Bicep job)** using `'client_owner_or_recent_fee_earner'` filtered by `R747` employee-client visibility.
   - Existing anonymisation/purge jobs never delete or scrub CDD records or `'evidence'` blobs (`R758`).

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

1. **Migration round-trip (`core/tests/migrations-postgres.test.ts`, `R743`):** verify `0025` `up -> down -> up` cleanly after `0024` (indexes, `evidence_artifacts`, `migration_0025_backfill_audit` + `choice_values.metadata_json->>'systemKey'` `jsonb_set` backfill and clean removal on `down`, and default runtime privileges with zero explicit `GRANT`).
2. **Unit & contract (`core/tests/registers-engine-s024.test.ts`, `core/tests/config-engine.test.ts`, `core/tests/tenant-config-usage.test.ts`, `src/domain/__tests__/noDemoLiterals.test.ts`):**
   - Client-subject register validation (`personId` XOR `organisationId`), `'checklist'` / `'evidence'` field validation, missing/invalid notes on `'not_applicable'`.
   - Checklist resolution across all `organisation_type` `systemKey`s and all 6 `risk_rating` `systemKey`s (`low` -> standard 3y, `high`/`critical`/`sensitive` -> enhanced 1y, plus Standard → High upgrade keeping Standard items and resetting 1-year `dueAt`, `R749`).
   - `tenant-config-usage.test.ts` passes with every new `cdd.*` and `registers.*` key exercised.
   - `noDemoLiterals.test.ts` still fails on unbacked `"Sanctions & PEP: Clear"` strings and passes only when backed by manual check wording.
3. **Two-tenant PG16 isolation, RBAC & merge (`core/tests/cdd-workflow-s104.test.ts`):**
   - Client CDD creation, checklist item updates, manual ID/Sanctions&PEP linkage to `public.intake_check_records`, immediate `'recorded'` completion (`dueAt` calculation, no second approver), Standard → High tier upgrade (`R749`), and refusing/ignoring legacy matter-level CDD fields in `saveMatterRecord` (`R750`).
   - **Pre-storage malware & hardened evidence download (`R746`, `R748`):** `POST /api/evidence/upload` runs `scanBytesForMalwareAndMacros` before `putObject` and rejects infected/macro files with `EVIDENCE_MALWARE_DETECTED` (asserting zero bytes written in storage and `evidence_artifacts`); `GET /api/evidence/download` requires `'cdd:view'` + HMAC `ScopedDownloadToken` + DB ownership + MIME headers, rejecting tampered `token`/`evidenceId`/`blobKey`, cross-tenant tokens (`tenant-bravo` vs `tenant-alpha`), and forged `TenantContext`.
   - **Strict CDD role permissions (`R748`, Owner Answer 1):** `admin` and `finance` are refused `startOrLoadClientCddAction`, `recordCddChecklistItemAction`, `recordManualSanctionsPepAction`, `POST /api/evidence/upload`, `GET /api/evidence/download`, and `cdd` rows in `/registers`; `risk:view` without `cdd:record` cannot write manual sanctions/PEP checks; `legal_secretary` succeeds on recording and upload.
   - **Full employee-client hiding (`R747`):** for an employee-subject with or without a `cdd` record, non-permitted staff (`fee_earner` not on any matter for that employee, lacking `risk:view` and `matter:restricted:access`) see zero CDD card, zero `"CDD not started"` / `"Recorded manually..."` text, zero rows on `/registers?type=cdd`, receive `FORBIDDEN` on `/api/evidence/download`, and receive zero reminder alerts; active matter participants and `risk:view` / `matter:restricted:access` holders succeed as positive controls.
   - **Party merge repointing (`R754`) & non-deletion (`R758`):** `executeMergeInTransaction` atomically repoints `public.intake_check_records.subject_id` and `public.evidence_artifacts.subject_id` (plus `register_records`); retention/anonymisation jobs leave `cdd` records, `intake_check_records`, `evidence_artifacts`, and `'evidence'` blobs untouched.
   - **Re-check reminder sweep (`executeRegisterRemindersForTenant` / `guardedJob('register-reminders')`):** two-tenant isolation, `tenantId` requirement, idempotent non-duplication on repeat runs, recipient fallback (`owner` -> most recent non-draft matter fee earner -> `risk_compliance`) filtered through `R747`.
   - **SQL visibility parity (`R755`):** `REGISTER_RECORD_VISIBLE_SQL_PREDICATE` empty-allow-list participant fallback parity test proving a matter's own partner sees register rows & transition history on empty-allow-list restricted matters.
4. **Guards (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`, `actionPermissionGuard.test.ts`):**
   - **Zero** new entries in `PERMANENT_ALLOW_LIST` (`<= 12`), `DEFERRED_S1_02B_ALLOW_LIST` (`0`), or `TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST` (`<= 8`). Every new CDD loader uses SQL-scoped queries (`listVisibleRegisterRecords` filtered by `personId`/`organisationId`).
   - `actionPermissionGuard.test.ts` passes with `MAX_KNOWN_GAPS = 0` and verifies every new action and `/api/evidence/*` route + MFA requirement on `saveCddConfigAction`.
5. **Playwright E2E (`e2e/role-journeys.spec.ts`, run via `npx playwright test --reporter=line --global-timeout=900000`):**
   - **New journey:** Fee earner opens a newly created external Individual client profile (`/people/[id]`), confirms `"CDD not started"` and `"Sanctions & PEP: Not checked"`, records manual Photo ID + Proof of Address checklist items with clean evidence upload, marks CDD recorded (verifying `"Recorded manually by ..."` and 3-year re-check due date), then opens `/matters/new` for that client and sees the real recorded CDD status reflected.

---

## 11. Expected `docs/roadmap/feature-list.md` Updates

When `S1-04` lands on its implementation PR:
- **Update row `4`** ("What exists" & "What's missing"):
  - **Add to "What exists":** Client-level `cdd` register workflow on People & Organisations (`0025`, `ADR 0039`), configurable client-type × risk checklist templates (with Standard → High upgrade), S1-03 `'evidence'` malware-pre-scanned upload & `/api/evidence/download` (`public.evidence_artifacts`, repointed on party merge), full employee-client CDD hiding (`R747`), manual `"Recorded manually by..."` display & `Sanctions & PEP` manual recording integration (`intake_check_records`), real CDD summary + read-only legacy matter CDD fields on `MatterFormClient`, converged `REGISTER_RECORD_VISIBLE_SQL_PREDICATE` (`R755`), and scheduled re-check reminders via `register-reminders`.
  - **Narrow "What's missing" to:** `"A High rating triggers nothing. Matter number format isn't configurable. Opening gate pre-conditions per work type and audited overrides (S1-05). Live E-ID provider and Sanctions & PEP screening provider integrations (F24, F25)."`
  - Keep row 4 status as **Partly built** until `S1-05` completes.
- **Add new backlog row (next free `B`-number on merge, `R758`):**
  - *CDD regulatory retention (keep 5 years after client relationship ends, then delete):* `cdd` register records, `intake_check_records`, `evidence_artifacts`, and `'evidence'` blobs are never deleted by current anonymisation/purge jobs. Build automated post-relationship `5`-year retention/disposal job **before the first hosted client** (`Severity: Medium`, `Stage: Before first hosted client`, `Status: Not started`). *(Note: deliberately left unnumbered in this planning doc to avoid colliding with `B26` on `fix/sign-out`.)*

---

## 12. Commit Breakdown (Each Independently Testable)

1. `feat(s1-04): extend @platform/core-api and registers engine for client-subject CDD, permissions, checklist/evidence fields, and buildMatterHiddenFromViewerSql convergence` (`core/src/api/`, `core/src/domain/registers/`, `core/src/tenancy/registerRepository.ts`, unit tests).
2. `feat(s1-04): add migration 0025 (evidence_artifacts, client register indexes, jsonb_set organisation_type systemKeys + audit), seed keys, and merge repointing` (`core/src/tenancy/migrations/index.ts`, `core/src/tenancy/evidenceRepository.ts`, `core/src/tenancy/partyRepository.ts`, `src/seed/lists.ts`, `data/seed-not-a-law-firm.json`, migration round-trip test).
3. `feat(s1-04): add CDD configuration schema, deep-merge, and demo defaults` (`core/schemas/`, `core/src/config-engine/`, `client-not-a-law-firm/config/base.json`, `config-engine.test.ts`, `tenant-config-usage.test.ts`).
4. `feat(s1-04): add CDD RBAC permissions, server services, malware-pre-scanned /api/evidence upload/download routes, and employee-safe re-check reminder routing` (`core/src/domain/rbac/registry.ts`, `core/src/integrations/intake-checks/manualProviders.ts`, `src/platform/tenantRuntime.ts`, `src/server/`, `src/app/actions.ts`, `src/app/api/evidence/`, `core/tests/cdd-workflow-s104.test.ts`, guard tests).
5. `feat(s1-04): build client CDD workspace UI, profile summaries, read-only legacy matter CDD fields, and Admin summary` (`src/components/`, `src/domain/matterOpeningRecord.ts`, `src/server/pageLoaders.ts`, `e2e/role-journeys.spec.ts`).
6. `docs(s1-04): add Client Due Diligence Help articles, technical notes, release notes, and update feature-list` (`src/docs/`, `docs/`).

---

## 13. Risks and Owner Decisions

- **Risk `R1` (manual vs automated):** Enforced via explicit UI wording (`"Recorded manually by..."`), leaving `"Sanctions & PEP: Not checked"` unless manually logged, and extending `noDemoLiterals.test.ts`.
- **Risk `R3` (storage):** `local-fs` demo-only exception applies; live tenants remain blocked until `azure-blob` ships.
- **Risk — `noWholeTenantLoadInRequestPaths` compliance:** `/people/[id]`, `/organisations/[id]`, and `executeRegisterRemindersForTenant` must avoid adding new `listAllPeople` / `listAllMattersUnfiltered` request-path calls (`listVisibleRegisterRecords` SQL filters + scoped `employeesAndLeaversOnly` / `getMatterById` only).

### Owner answers incorporated (24 Nov 2026)
1. **Default role for `cdd:record` (`§6`):** Confirmed — `legal_secretary` holds `cdd:record` (and `cdd:view`); `admin` holds neither `cdd:record` nor evidence download, and `finance` holds neither `cdd:view` nor `cdd:record` (`R748`).
2. **Completion model (`§3.1`):** Confirmed — `cdd` becomes `'recorded'` immediately once all required items are recorded (no second approver on client CDD; two-person control sits on `S1-05` `high_risk_opening`).
3. **`Low` risk rating tier (`§3.3`):** Confirmed — `risk_rating.low` uses the **Standard** checklist (`3`-year re-check interval).
4. **`organisation_type` mappings (`§3.2`):** Confirmed as proposed across all 13 values.

---

## 14. Estimate (`3.5–4` days with Lever 1; `4–5` days un-trimmed)

- **Un-trimmed `S1-04` estimate (incorporating `R743`, `R746`–`R750`, `R754`–`R755`, `R758`):** **`4–5` days** (`0.5d` core engine + migration `0025` + merge repointing, `0.5d` config schema + seeds, `1.5d` malware-guarded evidence routes + Standard→High upgrade + employee hiding + reminders + two-tenant tests, `1.5–2d` UI + interactive Admin checklist editor + MatterForm integration + Playwright + Help).
- **Recommended schedule lever (`R760` Lever 1 — saves ~`0.5–1` day, bringing `S1-04` to `3.5–4` days):**
  - Keep `cdd.*` JSON Schema, `client-not-a-law-firm/config/base.json`, `saveCddConfigAction` + MFA + service/config tests, and a read-only Admin CDD settings summary in `S1-04`.
  - Defer the full interactive Admin checklist-item editor UI widget to a small post-WP2 follow-up, keeping combined WP2 (`S1-04` + `S1-05` with Levers 1–3) within **`7–8` days** inside [stage-1-plan.md](../stage-1-plan.md) §5a's **`6–8` days** budget (open question for owner confirmation in WP2 review report).
