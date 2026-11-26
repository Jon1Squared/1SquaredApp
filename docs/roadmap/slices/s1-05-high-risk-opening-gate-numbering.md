# S1-05: High-Risk Opening Sign-Off, Per-Work-Type Opening Gate, and Configurable Matter Numbering

| | |
|---|---|
| Backlog | Row `4` (Client and matter inception), plus `B6` (monotonic numbering invariance across format changes) |
| Decision | Stage 1 decisions `S1-D6`, `S1-D7`, `S1-D8`, `S1-D10`; Owner decisions (24 Nov 2026); [ADR 0032](../../decisions/0032-registers-engine.md), Accepted [ADR 0039](../../decisions/0039-registers-engine-extensions-cdd-high-risk.md), Accepted [ADR 0040](../../decisions/0040-matter-opening-gate-and-numbering.md) |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP2 (`S1-05`) |
| Branch | `s1-05-high-risk-opening-gate-numbering`, stacked on `s1-04-cdd-workflow`, targeting `develop` |
| Change class | Core registers engine extension (`high_risk_opening`, per-transition roles, `mustDifferFromPreviousApprover`, `allowAdminBypass: false`), Core domain matter-numbering engine (`@platform/core`), Core tenancy schema + repositories + expand migration `0026` (`core/src/tenancy/`), Core configuration schema & deep-merge (`core/schemas/`, `core/src/config-engine/`), Host transactional gate + opening paths + UI + page loaders (`src/`), Demo client config (`client-not-a-law-firm/config/base.json`), Help docs (`src/docs/`) |
| Layer | Core API & domain (`core/src/api/`, `core/src/domain/`), Core tenancy (`core/src/tenancy/`), Core config (`core/src/config-engine/`, `core/schemas/`), Host server & UI (`src/`), Client config (`client-not-a-law-firm/`) |
| Size | L (`3.5–4` days with `R760` Levers 2 & 3 pulled; `4–5` days un-trimmed — see §14) |
| Depends on | `S1-04` (CDD workflow & client-subject registers); [ADR 0039](../../decisions/0039-registers-engine-extensions-cdd-high-risk.md) and [ADR 0040](../../decisions/0040-matter-opening-gate-and-numbering.md) Accepted (owner, 24 Nov 2026) |
| Blocking manual tasks | None in dev/test; existing Stage 1 §8 manual demo-deploy (`caj-migrate-demo`) when WP2 deploys |
| Baseline | `develop` at `1093e45` |

---

## 1. Change Class and Layer Breakdown

| Part | Change class | Layer |
|---|---|---|
| Per-transition `allowedRoles`, `mustDifferFromPreviousApprover`, `distinctFromTransitionKeys`, `allowAdminBypass: false`, terminal `'withdrawn'` state, core `'high_risk_opening'` register type | Core registers engine & API (additive, Rule 7) | `core/src/api/registers.types.ts`, `core/src/domain/registers/index.ts`, `core/schemas/registers.config.schema.json` |
| Token-based matter numbering engine (`{CLIENT_REF}`, `{SEQ}`/`{SEQ:N}`, `{YYYY}`, `{YY}`, `{DEPT}`; scopes `client_ref_prefix`, `firm`, `year`, `department` per `R760` Lever 3) | Core domain feature | `core/src/domain/matterNumbering/index.ts`, `core/src/api/index.ts` |
| `matter:opening_gate:override` permission (partner & managing partner only) | Core RBAC registry | `core/src/domain/rbac/registry.ts` |
| Migration `0026` (`matter_opening_gate_overrides`, `number_sequence_key`/`number_sequence_value` columns, no unique matter-number index per `R744`), decoupled `allocateNextMatterNumber`, `lockAndExecuteTransition` cycle approver check | Core tenancy layer | `core/src/tenancy/migrations/index.ts`, `core/src/tenancy/matterRepository.ts`, `core/src/tenancy/registerRepository.ts` |
| `workTypes.*.openingGate` & `matterNumbering` schemas, Zod validation, `loadAndValidateTenantConfig` deep-merge, `tenant_module_configs['matter_numbering']` | Core config engine & schemas | `core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `core/tests/tenant-config-usage.test.ts` |
| Shared `evaluateAndEnforceOpeningGateInTx` across all opening paths (`saveMatterRecord`, `openProspectiveMatterRecord`, `updateMatterConflictRecord`, `signOffMatterCostsRecord`, `compliance_approve`), exempt `createRecordFromPms` + audit, `recordEngagementLetterSignedAction`, `signoff:approve`/`register:approve` alignment, ignore caller `matterNumber`/`matterStatusId`, PMS clash uniqueness check | Host server & HTTP/Action boundary | `src/server/services.ts`, `src/server/actionPermissions.ts`, `src/server/pageLoaders.ts`, `src/app/actions.ts` |
| Opening gate banner/override & **Open matter** UI, server-only engagement signed trigger, high-risk banner, unified Home sign-off panel, Admin work-type opening-gate toggles | Host UI | `src/components/MatterFormClient.tsx`, `src/components/MatterProfileClient.tsx`, `src/components/HomeClient.tsx`, `src/components/RegistersWorkspaceClient.tsx`, `src/components/WorkTypesAdminPanel.tsx`, `src/components/AdminClient.tsx` |
| Complete demo `workTypes.items[].openingGate` rules (across all 76 work types), default `matterNumbering` config, & seed duplicate `M-000007` → `BRI001-0001` fix (`R744`) | Client configuration & seed fixture | `client-not-a-law-firm/config/base.json`, `data/seed-not-a-law-firm.json`, `src/seed/demo.ts` |
| Plain-English Help & release notes (Rule 11, Stage 1 §6 rule 6, `R757`) | Help documentation | `src/docs/articles/`, `docs/release-notes.md` |

---

## 2. What Exists Today (`develop` at `1093e45`)

1. **Risk ratings, real opening status transitions & caller bypasses (`src/domain/matterOpeningRecord.ts`, `MatterFormClient.tsx`, `src/server/services.ts`, `R741`, `R742`):**
   - `MATTER_RISK_SECTIONS` (`src/domain/matterOpeningRecord.ts:56-326`) scores 22 core questions + work-type `extraRiskQuestions` via `buildMatterRiskAssessmentSnapshot` (`:508-644`, producing only `'Low' | 'Medium' | 'High'`). Server validates via `validateMatterRiskAssessmentInput` (`:675-837`) inside `saveMatterRecord` (`:6274-6311`), ignoring client `input.riskRatingId` and overwriting `matter.riskRatingId` (`:7542-7547`) via `resolveRiskRatingIdForLevel` (`matterOpeningRecord.ts:952-973`).
   - **Real status & path gaps (`R741`, `R742`):**
     - Normal cleared opening in `saveMatterRecord` (`resolveNextMatterStatusId`, `services.ts:5730-5779`) routes to **`cmi_incomplete`** (not `active`), and `matterHasOpened` (`:5730-5742`) treats `cmi_incomplete`, `active`, and `on_hold` as opened — **however**, `submit_cleared` accepts any caller-supplied non-prospective `input.matterStatusId` (`:5773-5776`), allowing crafted payloads to skip straight to `active` or `closed` (changed to `active` in R810/R811).
     - Matter creation/opening spans `saveMatterRecord` (also called by `prepareEnquiryConversion` and `prepareQuoteConversionRecord`), `updateMatterConflictRecord` (`:9276, :9317-9321`, which trusts stale stored `matterOpeningGate.allowProceed` without re-running pre-hooks or DB checks), `signOffMatterCostsRecord` (`:9703-9868`), PMS import (`createRecordFromPms`, `:17011, :17363-17379`, directly creating `active`/`on_hold`/`closed` matters), and demo seed import (`importMatters`, `src/server/storePostgresImport.ts:460`), whilst `updateMatterLifecycleStatusRecord` (`:25916-25970`) handles post-closure reopens (`closed → active`).
     - `runMatterOpeningGate` (`:5509-5672`) runs **outside** `withTenantTransaction` (`:7762`) and has the `:5659-5660` null-governance bug (`openGovernance === null` when extension is disabled blocks opening). `MatterFormClient.tsx:2006-2021` still matches `riskRatingId` by label prefix instead of `systemKey`, and `:4312-4357` lacks opening-gate banners.
2. **Matter numbering, caller override bug & demo duplicate (`allocateNextMatterNumber`, `R744`, `R745`):**
   - Migration `0009` (`migrations/index.ts:751, 760-766`) defines `tenant_matter_number_seq` and `public.matter_number_sequences (tenant_id, prefix, last_number, updated_at)`.
   - `generateMatterNumber` (`services.ts:5006-5026`) and `TenantMatterRepository.allocateNextMatterNumber` (`matterRepository.ts:714-768`) use a counter keyed by **cleaned client-reference prefix** (NOT per client — an organisation and person such as `Hughes Lloyd Accountants LLP` and `P-000013` share `'HUG001'`, `R745`), formatting `${cleanPrefix}-${String(nextNum).padStart(4, '0')}` using exact `replace(/[^A-Z0-9_-]/g, '')` → empty `'MAT001'`.
   - `saveMatterAction` (`actions.ts:361-377`) and `saveMatterRecord` (`services.ts:6645-6657`) keep caller-supplied `matterNumber` on creates and allocate **before** gate/input validation, whilst the demo dataset already contains duplicate active number `BRI001-0003` (`M-000007` and `M-000010` at `data/seed-not-a-law-firm.json:19417, 19795`, `R744`).
3. **`signoff:approve` vs `register:approve` & admin bypass (`R756`, `R757`):**
   - `core/src/domain/rbac/registry.ts:467-475` (`signoff:approve`: `admin`, `managing_partner`, `partner`) vs `:707-716` (`register:approve`: adds `risk_compliance` and `supervisor`). Home `HomeClient.tsx:438-441, 3529-3587` routes `approveSignOffAction` / `discussSignOffAction` through `signoff:approve`, blocking `risk_compliance` and `supervisor` who can already approve `sign_off` write-offs on `/registers` (`R757`).
   - `core/src/domain/registers/index.ts:1010-1023` skips **only** `allowedApproverRoles` for `admin`, **only** on `forbidSelfAction` transitions (`:1013`), and raises `REGISTER_APPROVER_MISMATCH` (`:31`, `R756`).
4. **Engagement status & free-choice self-certification (`B2`, `R753`):**
   - `matters.engagement_letter_status` (`migrations/index.ts:975`) holds `"" | "Drafting" | "Drafted" | "Sent" | "Sent to client" | "Signed" | "Signed & returned"`, currently editable directly via picklist on `MatterFormClient.tsx:~12056` (`saveMatterRecord`) without server actor/timestamp verification (`R753`).
5. **Pro Bono handling (codebase contradiction resolved by Owner Answer 5, 24 Nov 2026):**
   - `work_type` choices (`data/seed-not-a-law-firm.json:3788-4763`) have **no `chargeable` flag** (`pro_bono` exists on `matter_type.pro_bono` L3196 and `billing_basis.pro_bono` L3268). Confirmed by the owner (`24 Nov 2026`): **Pro Bono receives no automatic exemption** — the selected work type's opening rules apply uniformly across all matters (using a partner override where permitted).

---

## 3. High-Risk Opening Approval (`high_risk_opening`) & Entry-Point Alignment

### 3.1 Core `high_risk_opening` register type (`CORE_REGISTER_TYPES`, `ADR 0039`)
- **Key:** `'high_risk_opening'`, prefix `'HRO'`, `subjectScope: 'matter'`, `requireMatterLink: true`.
- **Approval rules (core-locked per Owner Answer 8, 24 Nov 2026 — non-weakenable via Admin UI):**
  - `requireTwoPersonApproval: true`, `forbidSelfApproval: true`, `requireAssignedApproverMatch: false`, **`allowAdminBypass: false`**.
  - Note (`R749`): triggered strictly by `isHighOrCriticalRiskRating` (`risk_rating` `systemKey` `'high'` or `'critical'`). **`risk_rating.sensitive` maps to `high` CDD tier (`S1-04`), NOT `high_risk_opening`.**
- **States:**
  - `pending_partner` (`initial: true`, `category: 'pending_approval'`, label `"Pending Partner approval"`)
  - `pending_compliance` (`category: 'pending_approval'`, label `"Pending Risk & Compliance approval"`)
  - `approved` (`terminal: true`, `category: 'approved'`, label `"Approved"`)
  - `rejected` (`terminal: true`, `category: 'rejected'`, label `"Rejected"`)
  - **`withdrawn`** (`terminal: true`, `category: 'cancelled'`, label `"Withdrawn"`, `R752`)
- **Transitions:**
  1. `partner_approve`: `['pending_partner'] -> 'pending_compliance'`, `requiredPermission: 'register:approve'`, **`allowedRoles: ['partner', 'managing_partner']`**, `forbidSelfAction: true`, `requiresComment: false`, raises notification `approval_requested` for active `'risk_compliance'` users. Role mismatch raises `REGISTER_APPROVER_MISMATCH` (`R756`).
  2. `compliance_approve`: `['pending_compliance'] -> 'approved'`, `requiredPermission: 'register:approve'`, **`allowedRoles: ['risk_compliance']`**, `forbidSelfAction: true`, **`mustDifferFromPreviousApprover: true`**, **`distinctFromTransitionKeys: ['partner_approve']`**, `setsDecidedAt: true`, invokes outside-TX `beforeMatterOpen` pre-hooks then `evaluateAndEnforceOpeningGateInTx` in the same TX to transition linked `prospective` matter to `active` if remaining pre-conditions pass.
  3. `reject_opening`: `['pending_partner', 'pending_compliance'] -> 'rejected'`, `requiredPermission: 'register:approve'`, **`allowedRoles: ['partner', 'managing_partner', 'risk_compliance']`**, `forbidSelfAction: true`, `requiresComment: true`.
  4. **`withdraw_opening` (system transition, `R752`):** `['pending_partner', 'pending_compliance'] -> 'withdrawn'`, triggered automatically (system actor, audited) when a prospective matter's risk rating drops below High/Critical before opening, or when the prospective matter is deleted/abandoned.
- **Lifecycle invariants:**
  - Whenever `saveMatterRecord` (or re-scoring on edit/submit) yields `isHighOrCriticalRiskRating` and no active (`pending_*`) or `'approved'` `high_risk_opening` record exists for `matterId`, create a `'pending_partner'` record in TX.
  - Re-scoring below High/Critical before opening automatically runs `withdraw_opening` (`R752`), removing the record from Home queues; re-scoring back up starts a fresh `'pending_partner'` approval cycle. **An `'approved'` record is never withdrawn.**
  - Because `allowAdminBypass: false`, `admin` users **cannot** execute `partner_approve` or `compliance_approve` unless that specific individual independently holds the transition's `allowedRoles`, differs from the creator/owner (`REGISTER_SELF_APPROVAL_FORBIDDEN`), and differs from the step-1 approver (`REGISTER_DISTINCT_APPROVER_REQUIRED`).

### 3.2 Aligning `signoff:approve` and `register:approve` (`Home` queue + `/registers`, `R757`)
1. **Unify Home `sign_offs_and_approvals` query onto `registerRepo.listVisibleRegisterRecords` (`['sign_off', 'high_risk_opening']`):**
   - `HomeClient` renders both standard sign-offs (`write_off`, legacy `matter_opening`) and two-stage `high_risk_opening` items awaiting the viewer's eligible stage (`pending_partner` for partners, `pending_compliance` for Risk & Compliance where viewer !== step-1 approver).
2. **Owner-confirmed permission alignment (`R757`, 24 Nov 2026):**
   - `approveSignOffAction` / `discussSignOffAction` align Home with `/registers` by enforcing `sign_off`'s configured approver rules (`{ anyOf: ['signoff:approve', 'register:approve'] }` checked against `sign_off.approvalRules.allowedApproverRoles` — allowing `Partner`, `Managing Partner`, `Risk & Compliance`, and `Supervisor` to approve write-offs from Home just as they already can in `/registers`). Document this explicitly in `docs/release-notes.md` (`R757`).
   - `transitionRegisterRecordAction` remains canonical for `high_risk_opening` (strict `register:approve` + transition `allowedRoles` + `allowAdminBypass: false` + `mustDifferFromPreviousApprover: true` — zero `signoff:approve` bypass).

---

## 4. Complete Work-Type Opening Pre-Conditions & High-ML-Risk Non-Overridable CDD Table (`S1-D6`)

**Firm-wide default in core (`workTypes.defaults.openingGate`):** all four requirement keys **`false`** and `allowCddOverride: true` (`requireConflictCleared: false`, `requireCddComplete: false`, `requireEngagementSigned: false`, `requireFundsOnAccount: false`, `allowCddOverride: true`).

**Gate, Override & Pre-S1-06 / Pre-S1-08 Rules (`R740`, `R753`, Owner Answers 5 & 6):**
- **`requireConflictCleared` (`R740`):** Uses real `ConflictCheckStatusPill` statuses (`src/domain/types.ts:839-845`: `'Not started' | 'In progress' | 'Cleared' | 'Referred' | 'Approved' | 'Declined'`). Satisfied by **`'Cleared'` or `'Approved'`**; unmet for `'Not started'`, `'In progress'`, `'Referred'`, and `'Declined'` (or absent check). Neither **`'Declined'`** nor **`'Referred'`** conflicts can ever be overridden (`OPENING_GATE_OVERRIDE_FORBIDDEN`; referred conflicts must go through conflict review). Only `'Not started'` or `'In progress'` checks may be overridden with a mandatory partner reason.
- **`requireEngagementSigned` before `S1-06` (`R753`):** Evaluated by `isMatterEngagementSignedForGate(matter)` checking `Boolean(matter.engagementLetterSignedAt) || matter.engagementLetterStatus === 'Signed' || matter.engagementLetterStatus === 'Signed & returned'` (B2 values in `matters.engagement_letter_status`). Drafted/Sent letters do not satisfy it. **Hardening (`R753`):** remove `'Signed'` and `'Signed & returned'` from the free-choice picklist in `MatterFormClient` (`saveMatterRecord` refuses/ignores direct transitions into signed states) and set them solely via guarded server action `recordEngagementLetterSignedAction` (`matter:edit`), which stamps `engagementLetterSignedAt`, acting user ID, and an immutable audit entry (`S1-06` later backs this with uploaded signed copies).
- **`requireFundsOnAccount` before `S1-08`:** Configuration key defined and validated everywhere; **set to `false` across all 76 demo work types** in `client-not-a-law-firm/config/base.json`. Gate evaluator reads it cleanly so `S1-08` switches selected work types to `true` without schema changes.
- **Pro Bono (`Owner Answer 5`, 24 Nov 2026):** Obeys the selected work type's rules uniformly (using partner overrides where allowed; no automatic exemption).

**Confirmed Non-Overridable CDD (`allowCddOverride: false`) Rationale (23 work types, Owner Answer 6 confirmed 24 Nov 2026):**
1. **Real Estate & Property (`8`: parent + 7 subcategories):** Conveyancing, commercial property, leases, development/planning, secured lending, property management, and construction are primary UK AML targets under MLR 2017 Reg 12(2)(a) (`clientMoneyThresholdGbp: 250000`, `amlInScope: true`).
2. **Corporate M&A, Company Formations, Joint Ventures & Due Diligence (`4`: `company_formations_and_structures`, `mergers_and_acquisitions`, `joint_ventures`, `due_diligence`):** Entity creation and corporate acquisitions directly fall under MLR 2017 Reg 12(2)(b)–(c) (company formation & buying/selling business entities, `£250,000` threshold).
3. **Private Client Trusts, Probate & Tax (`4`: parent + `trusts_and_settlements`, `estate_administration`, `inheritance_tax_planning`):** Trust/estate administration and tax structuring involve high-value client account flows and complex beneficial ownership (MLR 2017 Reg 12(2)(d)/(e), `amlInScope: true`); meanwhile `wills_and_codicils`, `lasting_powers_of_attorney`, and `court_of_protection` remain overridable (`true`) for urgent capacity/end-of-life instructions.
4. **Finance & Banking (`7`: parent + 6 subcategories):** Loan facilities, security, guarantees, asset finance, restructuring/insolvency, and financial services regulation (`amlInScope: true`, `£250,000` threshold) carry direct regulated financial-transaction risk.
*(Owner confirmed on 24 Nov 2026 that the 23 non-overridable entries stay as proposed and Row 69 `technology_and_digital_fintech_and_payments` remains overridable.)*

### Complete Table of ALL 76 Seeded Work Types (`data/seed-not-a-law-firm.json:3788-4763`)

| # | `work_type` ID | Label (Parent / Subcategory) | `amlInScope` | Conflict | CDD | Engagement Signed | Funds on Account | `allowCddOverride` | Non-Overridable Rationale |
|---:|---|---|---:|:---:|:---:|:---:|:---:|:---:|---|
| 1 | `work_type.corporate_and_commercial` | Corporate & Commercial (Parent) | `true` | `true` | `true` | `false` | `false` | `true` | Advisory commercial default |
| 2 | `work_type.corporate_and_commercial_company_formations_and_structures` | Company formations & structures | `true` | `true` | `true` | `false` | `false` | **`false`** | MLR 2017 Reg 12 TCSP/formation |
| 3 | `work_type.corporate_and_commercial_shareholder_agreements` | Shareholder agreements | `true` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 4 | `work_type.corporate_and_commercial_mergers_and_acquisitions` | Mergers & acquisitions | `true` | `true` | `true` | `false` | `false` | **`false`** | MLR 2017 Reg 12 entity sale/acquisition |
| 5 | `work_type.corporate_and_commercial_joint_ventures` | Joint ventures | `true` | `true` | `true` | `false` | `false` | **`false`** | MLR 2017 entity structuring/assets |
| 6 | `work_type.corporate_and_commercial_commercial_contracts` | Commercial contracts | `true` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 7 | `work_type.corporate_and_commercial_agency_and_distribution` | Agency & distribution | `true` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 8 | `work_type.corporate_and_commercial_corporate_governance` | Corporate governance | `true` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 9 | `work_type.corporate_and_commercial_due_diligence` | Due diligence | `true` | `true` | `true` | `false` | `false` | **`false`** | Core M&A / investment transaction scope |
| 10 | `work_type.real_estate_and_property` | Real Estate & Property (Parent) | `true` | `true` | `true` | `false` | `false` | **`false`** | MLR 2017 Reg 12 property sector |
| 11 | `work_type.real_estate_and_property_residential_conveyancing` | Residential conveyancing | `true` | `true` | `true` | `false` | `false` | **`false`** | Highest UK AML conveyancing vector |
| 12 | `work_type.real_estate_and_property_commercial_property` | Commercial property | `true` | `true` | `true` | `false` | `false` | **`false`** | MLR 2017 commercial real estate transfers |
| 13 | `work_type.real_estate_and_property_landlord_and_tenant` | Landlord & tenant | `true` | `true` | `true` | `false` | `false` | **`false`** | Property leasehold/rent flows |
| 14 | `work_type.real_estate_and_property_development_and_planning` | Development & planning | `true` | `true` | `true` | `false` | `false` | **`false`** | Real estate development financing/land |
| 15 | `work_type.real_estate_and_property_finance_and_secured_lending` | Finance & secured lending | `true` | `true` | `true` | `false` | `false` | **`false`** | Property-backed lending & security |
| 16 | `work_type.real_estate_and_property_property_management` | Property management | `true` | `true` | `true` | `false` | `false` | **`false`** | Managing real property / client rents |
| 17 | `work_type.real_estate_and_property_construction_contracts` | Construction contracts | `true` | `true` | `true` | `false` | `false` | **`false`** | Real estate capital projects (`£250k`) |
| 18 | `work_type.employment_and_hr` | Employment & HR (Parent) | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 19 | `work_type.employment_and_hr_employment_contracts` | Employment contracts | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 20 | `work_type.employment_and_hr_disciplinary_and_grievance` | Disciplinary & grievance | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 21 | `work_type.employment_and_hr_settlement_agreements` | Settlement agreements | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 22 | `work_type.employment_and_hr_redundancy_and_restructuring` | Redundancy & restructuring | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 23 | `work_type.employment_and_hr_tupe_transfers` | TUPE transfers | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 24 | `work_type.employment_and_hr_hr_policies_and_handbooks` | HR policies & handbooks | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 25 | `work_type.employment_and_hr_tribunal_claims` | Tribunal claims *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Contentious litigation; overridable CDD |
| 26 | `work_type.employment_and_hr_executive_and_senior_hire` | Executive & senior hire | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 27 | `work_type.dispute_resolution` | Dispute Resolution (Parent, *litigation*) | `false` | `true` | `true` | **`true`** | `false` | `true` | Litigation; urgent injunctions overridable |
| 28 | `work_type.dispute_resolution_pre_action_correspondence` | Pre-action correspondence *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Litigation engagement required |
| 29 | `work_type.dispute_resolution_court_pleadings` | Court pleadings *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Litigation engagement required |
| 30 | `work_type.dispute_resolution_mediation_and_adr` | Mediation & ADR *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Dispute engagement required |
| 31 | `work_type.dispute_resolution_arbitration` | Arbitration *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Dispute engagement required |
| 32 | `work_type.dispute_resolution_enforcement` | Enforcement *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Litigation enforcement engagement |
| 33 | `work_type.dispute_resolution_injunctions_and_urgent_relief` | Injunctions & urgent relief *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Litigation; urgent override allowed |
| 34 | `work_type.dispute_resolution_cost_management` | Cost management *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Litigation costs engagement |
| 35 | `work_type.intellectual_property` | Intellectual Property (Parent) | `true` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 36 | `work_type.intellectual_property_trade_mark_applications` | Trade mark applications | `true` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 37 | `work_type.intellectual_property_ip_assignment_and_licensing` | IP assignment & licensing | `true` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 38 | `work_type.intellectual_property_copyright_notices` | Copyright notices | `true` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 39 | `work_type.intellectual_property_confidentiality_and_ndas` | Confidentiality & NDAs | `true` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 40 | `work_type.intellectual_property_ip_due_diligence` | IP due diligence | `true` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 41 | `work_type.intellectual_property_infringement_and_enforcement` | Infringement & enforcement *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Contentious IP litigation engagement |
| 42 | `work_type.private_client` | Private Client (Parent) | `true` | `true` | `true` | **`true`** | `false` | **`false`** | Private client wealth/trusts ML risk |
| 43 | `work_type.private_client_wills_and_codicils` | Wills & codicils | `true` | `true` | `true` | **`true`** | `false` | `true` | Urgent testator capacity overridable |
| 44 | `work_type.private_client_lasting_powers_of_attorney` | Lasting powers of attorney | `true` | `true` | `true` | **`true`** | `false` | `true` | Urgent capacity overridable |
| 45 | `work_type.private_client_trusts_and_settlements` | Trusts & settlements | `true` | `true` | `true` | **`true`** | `false` | **`false`** | MLR 2017 Reg 12 trust creation/assets |
| 46 | `work_type.private_client_estate_administration` | Estate administration | `true` | `true` | `true` | **`true`** | `false` | **`false`** | Probate estate asset distribution (`£100k`) |
| 47 | `work_type.private_client_inheritance_tax_planning` | Inheritance tax planning | `true` | `true` | `true` | **`true`** | `false` | **`false`** | MLR Reg 12(2)(d) tax/wealth structuring |
| 48 | `work_type.private_client_court_of_protection` | Court of Protection | `true` | `true` | `true` | **`true`** | `false` | `true` | Vulnerable client urgency overridable |
| 49 | `work_type.finance_and_banking` | Finance & Banking (Parent) | `true` | `true` | `true` | `false` | `false` | **`false`** | High-value financial facilities (`£250k`) |
| 50 | `work_type.finance_and_banking_loan_and_facility_agreements` | Loan & facility agreements | `true` | `true` | `true` | `false` | `false` | **`false`** | MLR Reg 12 financial facility movements |
| 51 | `work_type.finance_and_banking_security_documents` | Security documents | `true` | `true` | `true` | `false` | `false` | **`false`** | Security over property/financial assets |
| 52 | `work_type.finance_and_banking_guarantees_and_indemnities` | Guarantees & indemnities | `true` | `true` | `true` | `false` | `false` | **`false`** | Third-party financial guarantee ML risk |
| 53 | `work_type.finance_and_banking_asset_finance` | Asset finance | `true` | `true` | `true` | `false` | `false` | **`false`** | High-value asset financing flows |
| 54 | `work_type.finance_and_banking_restructuring_and_insolvency` | Restructuring & insolvency | `true` | `true` | `true` | `false` | `false` | **`false`** | Corporate distress/asset dispersal risk |
| 55 | `work_type.finance_and_banking_regulatory_compliance` | Regulatory compliance | `true` | `true` | `true` | `false` | `false` | **`false`** | Regulated financial services exposure |
| 56 | `work_type.regulatory_and_compliance` | Regulatory & Compliance (Parent) | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 57 | `work_type.regulatory_and_compliance_data_protection_and_gdpr` | Data protection & GDPR | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 58 | `work_type.regulatory_and_compliance_anti_bribery_and_corruption` | Anti-bribery & corruption | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 59 | `work_type.regulatory_and_compliance_financial_services_regulation` | Financial services regulation | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 60 | `work_type.regulatory_and_compliance_environmental_and_planning` | Environmental & planning | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 61 | `work_type.regulatory_and_compliance_health_and_safety` | Health & safety | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 62 | `work_type.regulatory_and_compliance_regulatory_investigations` | Regulatory investigations *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Contentious enforcement/tribunal defence |
| 63 | `work_type.technology_and_digital` | Technology & Digital (Parent) | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 64 | `work_type.technology_and_digital_software_and_saas_agreements` | Software & SaaS agreements | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 65 | `work_type.technology_and_digital_data_sharing_and_processing` | Data sharing & processing | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 66 | `work_type.technology_and_digital_ai_and_emerging_tech` | AI & emerging tech | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 67 | `work_type.technology_and_digital_outsourcing_contracts` | Outsourcing contracts | `false` | `true` | `true` | `false` | `false` | `true` | Overridable with reason |
| 68 | `work_type.technology_and_digital_cyber_incident_response` | Cyber incident response | `false` | `true` | `true` | `false` | `false` | `true` | Urgent incident response overridable |
| 69 | `work_type.technology_and_digital_fintech_and_payments` | Fintech & payments | `false` | `true` | `true` | `false` | `false` | `true` | Confirmed overridable (Owner Answer 6) |
| 70 | `work_type.family` | Family (Parent, *court/litigation*) | `false` | `true` | `true` | **`true`** | `false` | `true` | Contested/Private Client court work |
| 71 | `work_type.family_pre_nuptial_agreements` | Pre-nuptial agreements | `false` | `true` | `true` | `false` | `false` | `true` | Non-litigious agreement; overridable |
| 72 | `work_type.family_separation_and_divorce` | Separation & divorce *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Court proceedings engagement |
| 73 | `work_type.family_financial_orders` | Financial orders *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Court/asset proceedings engagement |
| 74 | `work_type.family_children_arrangements` | Children arrangements *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Court/urgent proceedings engagement |
| 75 | `work_type.family_cohabitation_agreements` | Cohabitation agreements | `false` | `true` | `true` | `false` | `false` | `true` | Non-litigious agreement; overridable |
| 76 | `work_type.family_domestic_abuse_proceedings` | Domestic abuse proceedings *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Urgent injunction/court; overridable CDD |

---

## 5. Data Model, Expand Migration `0026`, Backfill & Seed Duplicate Fix (`R743`, `R744`)

- **Migration ID:** `0026_opening_gate_overrides_and_numbering_expand` (`CORE_REQUIRED_SCHEMA_VERSION = '0026'`, `dependsOn: ['0009', '0025']`).
- **Default runtime privileges (`R743`):** Cluster bootstrap (`postgresAdminBootstrap.ts:205-211`) covers new tables and sequences on `<runtimeRole>` automatically — **do NOT emit explicit `GRANT ... TO <runtimeRole>` statements**.
- **`upSql`:**
  1. Create `public.tenant_opening_override_id_seq` (`OVR-000001`).
  2. Create `public.matter_opening_gate_overrides` (`tenant_id`, `id`, `matter_id`, `precondition_key IN ('conflict_cleared', 'cdd_complete', 'engagement_signed', 'funds_on_account')`, `reason CHECK (char_length(btrim(reason)) >= 10)`, `overridden_by_person_id`, `overridden_at`, `revoked_by_person_id`, `revoked_at`, `PRIMARY KEY (tenant_id, id)`, `FOREIGN KEY (tenant_id, matter_id) REFERENCES public.matters (tenant_id, id) ON DELETE CASCADE`, plus partial unique index `uq_matter_opening_gate_overrides_active` where `revoked_at IS NULL`).
  3. Expand `public.matters` with nullable `number_sequence_key TEXT NULL` and `number_sequence_value BIGINT NULL`.
  4. **No unique `matter_number` index in `0026` (`R744`):** **Do NOT add `uq_matters_tenant_matter_number_non_draft`.** The seeded demo already contains duplicate active number `BRI001-0003` (`M-000007` and `M-000010` at `data/seed-not-a-law-firm.json:19417, 19795`), existing numbers never change in place, so adding a unique index now would fail existing tenant migrations. Because `M-000007` is PMS-linked to `PMSL-M-BRI001-0001` while `M-000010` is linked to `PMSL-M-BRI001-0003` and asserted in `core/tests/rbac.test.ts:7003`, fix **`M-000007`**'s duplicate number to `'BRI001-0001'` in `data/seed-not-a-law-firm.json` (and `src/seed/demo.ts`, leaving existing tenant databases untouched), ignore caller-supplied `matterNumber` on normal saves, and log `B29` (§11) to add the unique constraint after tenants are checked for duplicates.
  5. **Backfill SQL in `upSql`:** Populate `number_sequence_key` & `number_sequence_value` for existing non-draft `matters` rows matching `^([A-Z0-9_-]+)-([0-9]+)$` where `number_sequence_key IS NULL`, leaving `matters.matter_number` completely **untouched**.
- **Existing matters compatibility:** Existing opened matters (`cmi_incomplete`, `active`, `on_hold`, `closed`) stay untouched; opening rules apply strictly on the first transition out of `prospective`/draft (`R741`).
- **Reversible `downSql`:** Drops `number_sequence_key` and `number_sequence_value` from `public.matters`, drops `public.matter_opening_gate_overrides`, and drops `public.tenant_opening_override_id_seq`.

---

## 6. Configuration Schema Changes (`workTypes` & `matterNumbering`, `R745`, `R760`)

1. **`workTypes.defaults.openingGate` and `workTypes.items[].openingGate`** (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `core/src/api/index.ts`):
   - Object (`strict`): `requireConflictCleared` (`boolean`, default `false`), `requireCddComplete` (`boolean`, default `false`), `allowCddOverride` (`boolean`, default `true`), `requireEngagementSigned` (`boolean`, default `false`), `requireFundsOnAccount` (`boolean`, default `false`).
   - Merged additively in `loadAndValidateTenantConfig` (`workTypes.defaults` + `workTypes.items[]` by `workTypeId`) and runtime-edited via `saveWorkTypesConfigAction` (`tenant_module_configs['work_type_configs']`).
2. **`matterNumbering`** (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `core/src/api/index.ts`):
   - `pattern`: `string` (default `"{CLIENT_REF}-{SEQ:4}"`), validated by `validateMatterNumberPattern`:
     - Under **`R760` Lever 3**, core WP2 supports the five essential tokens: `{CLIENT_REF}`, `{SEQ}` / `{SEQ:1..8}` (exactly one required), `{YYYY}`, `{YY}`, and `{DEPT}`. (`{WORK_TYPE}` and `{ENTITY}` remain additive future tokens under Rule 7.)
     - Allowed custom-pattern literals: `[A-Z0-9\-/._]`, custom rendered max `64` chars (**applied to non-default custom patterns only** so long client references keep byte-for-byte parity on `{CLIENT_REF}-{SEQ:4}`, `R745`).
     - **`{CLIENT_REF}` cleaning parity (`R745`):** `{CLIENT_REF}` uses exact legacy cleaning `replace(/[^A-Z0-9_-]/g, '')` → empty `'MAT001'` (`matterRepository.ts:718-722`), distinct from custom pattern separator validation.
   - `sequenceScope`: `enum ['client_ref_prefix', 'firm', 'year', 'department']` (**default `'client_ref_prefix'`** — renamed from `'client'` per `R745` to reflect accurately that the counter is keyed by cleaned client-reference prefix and can be shared e.g. `HUG001` across Hughes Lloyd Accountants LLP and `P-000013`).
   - `emptyTokenFallback`: `string` (uppercase alphanumeric 1–12 chars, default `'MAT'`).
   - Deep-merged in `loadAndValidateTenantConfig` and runtime-overridable via `tenant_module_configs['matter_numbering']` (**Administration → Matter Numbering**). Under **`R760` Lever 2**, keep `WorkTypesAdminPanel` opening-gate toggles + schema/JSON-validated `saveMatterNumberingConfigAction` in `S1-05` and defer the standalone interactive Admin pattern preview builder UI widget to a small follow-up (`0.5` day saved).
   - Every schema leaf is consumed cleanly at runtime (`core/src/domain/matterNumbering/index.ts` & `src/server/services.ts`) so `core/tests/tenant-config-usage.test.ts` stays green with zero false `x-reserved` markers.

---

## 7. Permissions, Action Policies, Role Matrix & MFA

- **New permission (`core/src/domain/rbac/registry.ts`):**
  - `'matter:opening_gate:override'` (`domain: 'matter'`, `sensitivity: 'restricted'`, `requiresMfa: false`, granted by default in `DEFAULT_RBAC_ROLES` **ONLY** to `'partner'` and `'managing_partner'`; explicitly excluded from `'admin'` — filtered out alongside `'undertaking:manage'` in `DEFAULT_RBAC_ROLES.admin.permissions` at `core/src/domain/rbac/registry.ts:859-861` — as well as `'risk_compliance'`, `'supervisor'`, `'fee_earner'`, and `'legal_secretary'`).
- **New/Updated Server Actions & `ACTION_PERMISSIONS` (`src/server/actionPermissions.ts`, `MAX_KNOWN_GAPS = 0`):**
  - `openProspectiveMatterAction` -> `{ kind: 'permission', key: 'matter:edit', enforcedBy: 'action' }` *(R751 explicit **"Open matter"** retry action; runs outside-TX pre-hooks + `evaluateAndEnforceOpeningGateInTx`, transitioning prospective → `active` when every pre-condition/override clears)*
  - `recordEngagementLetterSignedAction` -> `{ kind: 'permission', key: 'matter:edit', enforcedBy: 'action' }` *(R753 pre-S1-06 server-stamped signed action setting `'Signed'`/`'Signed & returned'`, `engagementLetterSignedAt`, actor, and audit entry; closes free-choice self-certification on `saveMatterRecord`)*
  - `overrideMatterOpeningPreconditionAction` -> `{ kind: 'permission', key: 'matter:opening_gate:override', enforcedBy: 'action' }` *(service also checks `canAccessMatter`, `allowCddOverride`, & non-`'Referred'`/non-`'Declined'` conflict rules; granting never opens the matter by itself per `R751`)*
  - `revokeMatterOpeningOverrideAction` -> `{ kind: 'permission', key: 'matter:opening_gate:override', enforcedBy: 'action' }`
  - `saveWorkTypesConfigAction` -> existing `admin:access` (**`requiresMfa: true`**)
  - `saveMatterNumberingConfigAction` -> `{ kind: 'permission', key: 'admin:access', enforcedBy: 'action' }` *(enforces `mfaVerified: true`)*
  - `approveSignOffAction` / `discussSignOffAction` -> `{ kind: 'permission', key: { anyOf: ['signoff:approve', 'register:approve'] }, enforcedBy: 'service' }` *(owner-confirmed `R757` alignment of Home write-offs with `sign_off`'s configured approvers; `high_risk_opening` transitions strictly enforce `register:approve` + transition `allowedRoles` + `allowAdminBypass: false` + `mustDifferFromPreviousApprover: true`)*.

---

## 8. Visibility, Opening Paths, Gate Enforcement & Allocation Timing (`R740`–`R744`, `R751`, Owner Answer 7)

1. **Visibility & S1-09 composition:**
   - `high_risk_opening` register records carry `matter_id` and inherit matter restriction unconditionally via converged `REGISTER_RECORD_VISIBLE_SQL_PREDICATE` (`buildMatterHiddenFromViewerSql`, converged in `S1-04`, `R755`) and `canPersonAccessMatter` (`services.ts:27228, 27552`).
   - `matter_opening_gate_overrides` inherits parent matter visibility via `canAccessMatter` inside `services.ts` and scoped SQL queries (`getOpeningGateStateForMatter`). Once `S1-09` adds core barrier tables into `canAccessMatter` and `buildMatterHiddenFromViewerSql`, all high-risk approvals, overrides, and opening gate reads inherit barriers automatically.
   - `executeRegisterRemindersForTenant` adds recipient routing for `high_risk_opening`: `pending_partner` escalates to partners (`responsiblePartnerId`, `supervisingPartnerId`, or active `'partner'` users), and `pending_compliance` escalates to active `'risk_compliance'` users (skipping restricted staff matters unless permitted per ADR 0014).
2. **Definition of "opening" & server-owned status (`R741`):**
   - **Opening** = strictly **the first transition out of `prospective` or draft-like (`matterHasOpened === false`, `services.ts:5730-5742`) into any opened status (`cmi_incomplete`, `active`, or `on_hold`)**.
   - On first opening, the **server chooses the destination status** (**`active`** on all five gated paths: `saveMatterRecord`, `openProspectiveMatterRecord`, `updateMatterConflictRecord`, `signOffMatterCostsRecord`, and `high_risk_opening` `compliance_approve`, retaining `cmi_incomplete` only for PMS-imported matters, legacy matters, and ungated moves between already-opened statuses) and **ignores any caller-supplied `input.matterStatusId`** from `saveMatterAction` or external callers (closing `resolveNextMatterStatusId` `:5773-5776` bypass). Only internal `source === 'pms_import'` calls from `createRecordFromPms` may pass initial `input.matterStatusId` / `input.matterNumber` to `saveMatterRecord`.
   - Moves between already-opened statuses (`cmi_incomplete → active`, `active → on_hold`) and reopens from `closed` (`updateMatterLifecycleStatusRecord`, `:25916-25970`) are **not openings** and are **not gated**.
3. **All matter creation/opening paths accounted for (`R742`, `R751`):**
   - **Gated paths running outside-TX `beforeMatterOpen` pre-hooks + `evaluateAndEnforceOpeningGateInTx` inside `withTenantTransaction`:** (1) `saveMatterRecord` (also backing `prepareEnquiryConversion` and `prepareQuoteConversionRecord`), (2) `openProspectiveMatterRecord` (**Open matter** button after blocked prospective matter has late CDD/engagement/overrides), (3) `updateMatterConflictRecord` (`Approved` conflict review — must re-run pre-hooks and DB gate rather than trusting stored `matterOpeningGate.allowProceed` at `:9276, 9317-9321`), (4) `signOffMatterCostsRecord`, and (5) `transitionRegisterRecordService` on `high_risk_opening` `compliance_approve`.
   - **Explicitly exempt paths (`R742` & owner decision 24 Nov 2026):** (6) **PMS import (`createRecordFromPms`, `services.ts:17011, 17363-17379`)** — calls `saveMatterRecord(..., { byId, source: 'pms_import' })` (the sole internal path allowed to supply `input.matterStatusId` / `input.matterNumber`), exempt from the opening gate, restricted to its existing permissions (`finance:manage_links` + `admin:access` + `mfaVerified: true` at `services.ts:17049-17075` plus `matter:create` inside `saveMatterRecord`), writes an audit entry **`"Opened by PMS import; opening gate not applied"`**, checks `existsMatterNumber` on `pm.matter_code` and generates a new number on collision (`R744`); and (7) **Demo seed import & reset (`importMatters`, `storePostgresImport.ts:460`)** — exempt. (8) **Reopen (`updateMatterLifecycleStatusRecord`)** — not an opening.
4. **In-transaction locking, race prevention & `matterNumber` rules (`R744`, Owner Answer 7):**
   - Lock order inside TX: (1) `public.matters FOR UPDATE` (`row_version` verified), (2) ordered `public.register_records` (`high_risk_opening` `FOR UPDATE`, client `cdd` `FOR SHARE`), (3) `public.matter_opening_gate_overrides FOR UPDATE`, (4) `tenant_module_configs` (`work_type_configs`, `registers`) & Key Dates opening rule. Also fix `runMatterOpeningGate` (`services.ts:5659-5660`) null-governance bug.
   - If a High-risk matter re-scores below High/Critical before opening or is deleted/abandoned, pending `high_risk_opening` transitions to `'withdrawn'` in TX (`R752`). If CDD expires or overrides revoke concurrently, the gate fails closed cleanly (leaving `prospective` on submit or rejecting `openProspectiveMatterAction` with `MATTER_OPENING_GATE_BLOCKED`).
   - **Caller `matterNumber` ignored & Owner Answer 7 allocation timing:** `saveMatterRecord` (`services.ts:6645-6657`) **ignores any caller-supplied `input.matterNumber`** on normal creates/updates (`R744`); permanent matter numbers are allocated **at the first non-draft submission, AFTER validation passes** (so rejected saves consume zero sequences, whilst Referred and High-risk matters awaiting approval DO receive their permanent number — Owner Answer 7, 24 Nov 2026).

---

## 9. Help and Documentation (Rule 11 & Stage 1 §6 Rule 6)

Plain British English for firm users (zero code identifiers, table names, or migration numbers):
- `src/docs/articles/matter-opening-and-risk.ts`: document opening pre-conditions per work type, why Pro Bono follows the same work-type rules, **Open matter** retry on prospective matters, partner overrides with mandatory reason (and why CDD cannot be overridden on conveyancing/high-ML-risk work types), recording signed engagement letters directly via **Mark engagement signed** until `S1-06` adds signed-copy upload, two-stage High-risk opening sign-off (Partner followed by a different Risk & Compliance colleague), automatic withdrawal if risk is reduced below High, and how matter numbers are assigned on submission.
- `src/docs/articles/sign-off-queue.ts`: document the High-risk opening approval stage in Home Sign-Offs & Approvals (`Pending Partner approval` → `Pending Risk & Compliance approval`), two-person separation, and note clearly (`R757`) that `Partner`, `Managing Partner`, `Risk & Compliance`, and `Supervisor` can approve write-offs from Home just as in Registers.
- `src/docs/articles/registers-engine.ts`: document the High-risk opening register type (including `Withdrawn` when a matter drops below High risk before opening).
- `src/docs/articles/tenant-settings.ts`: document work-type opening rules and configurable matter numbering patterns in Administration (preserving existing matter numbers).
- `src/docs/articles/authentication-rbac-and-mfa.ts`: document opening-gate override permission (`Partner` and `Managing Partner` only, excluded from `System Administrator`) and no admin bypass on High-risk approvals.
- Technical notes: `docs/guides/platform-technical-notes.md` and **`docs/release-notes.md`** (covering migration `0026`, ADRs `0039`/`0040`, and explicitly recording who can now approve write-offs from Home per `R757`).

---

## 10. Tests

1. **Migration round-trip (`core/tests/migrations-postgres.test.ts`):** `0026` `up -> down -> up` cleanly after `0025` (with zero explicit `GRANT` statements per `R743`, zero unique index on `matter_number` per `R744`), preserving existing `matters.matter_number` values and backfilling `number_sequence_key`/`number_sequence_value`.
2. **Unit & contract (`core/tests/matter-numbering-s105.test.ts`, `core/tests/registers-engine-s024.test.ts`, `core/tests/config-engine.test.ts`, `core/tests/tenant-config-usage.test.ts`):**
   - Token pattern validator (`{CLIENT_REF}`, `{SEQ}`, `{SEQ:N}`, `{YYYY}`, `{YY}`, `{DEPT}`), forbidden token / custom 64-char limit rejection, existing matter number immutability across pattern updates, and **`R745` default parity suite** covering: a `clientReference` with punctuation (`"O'Connor & Co."`), a >60-char reference staying byte-for-byte identical under `{CLIENT_REF}-{SEQ:4}`, shared `'client_ref_prefix'` (`HUG001` across Hughes Lloyd Accountants LLP & `P-000013`), and `'MAT001'` empty fallback.
   - `high_risk_opening` rules: per-transition `allowedRoles`, distinct-approver rejection when same person holds both `partner` and `risk_compliance` (`REGISTER_DISTINCT_APPROVER_REQUIRED`), explicit refusal when `admin` attempts approval without holding the transition role (`allowAdminBypass: false`, raising `REGISTER_APPROVER_MISMATCH`, `R756`), and core-locked rejection against Admin/config weakening (Owner Answer 8).
   - All 76 work-type gate configurations parsed and resolved cleanly (`subcategory` -> `practice_area` -> `defaults` -> core `false`), plus `risk_rating.sensitive` mapping to `high` CDD without triggering `high_risk_opening` (`R749`).
3. **Two-tenant PG16 isolation, gate enforcement & concurrency (`core/tests/opening-gate-numbering-s105.test.ts`):**
   - **All opening & exempt paths (`R740`–`R742`):** all 5 gated paths (`saveMatterRecord`, `openProspectiveMatterRecord`, `updateMatterConflictRecord` re-running pre-hooks + TX gate, `signOffMatterCostsRecord`, `high_risk_opening` `compliance_approve`) enforcing work-type gates inside `withTenantTransaction`; `'Cleared'` and `'Approved'` satisfy conflict cleared; `'Referred'` and `'Declined'` block and refuse override (`R740`); crafted non-prospective `input.matterStatusId` on first submission is ignored (`R741`); `cmi_incomplete → active` and reopen from `closed` (`updateMatterLifecycleStatusRecord`) are ungated (`R741`); `createRecordFromPms` is exempt and writes `"Opened by PMS import; opening gate not applied"` (`R742`).
   - **Pre-S1-06 engagement stamp (`R753`):** free-choice `'Signed'`/`'Signed & returned'` on `saveMatterRecord` is rejected/ignored; `recordEngagementLetterSignedAction` server-stamps `engagementLetterSignedAt`, actor, and audit entry.
   - **Numbering security & timing (`R744`, Owner Answer 7):** crafted caller `input.matterNumber` on normal `saveMatterRecord` is ignored; PMS import `pm.matter_code` clash allocates a fresh number; validation failure consumes zero sequences; Referred & High-risk prospective submissions receive their permanent number cleanly.
   - **Override permission matrix & non-auto-open (`R751`):** `partner`/`managing_partner` succeed; `admin`, `fee_earner`, `risk_compliance` denied; mandatory reason check; granting override alone leaves matter `Prospective` until `openProspectiveMatterAction`; Residential Conveyancing CDD refuses override (`allowCddOverride: false`), Fintech allows override (Owner Answer 6), Pro Bono follows work type uniformly (Owner Answer 5), and `'Declined'` or `'Referred'` conflicts refuse override (`R740`).
   - **Stale High-risk withdrawal (`R752`):** down-scoring below High/Critical before opening, or deleting/abandoning the prospective matter, automatically transitions `pending_*` to `'withdrawn'` (system actor, audited); `'approved'` is never withdrawn; re-scoring back up starts a fresh cycle.
   - **Concurrent `Promise.all` tests & Rule 9 isolation:** double-approval race by dual-role actor, override revoke vs open submit race, B6 monotonicity under pattern switch + outer TX rollback + demo reset, forged `TenantContext` claims, tampered IDs across `tenant-alpha` vs `tenant-bravo`.
4. **Guards (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`, `actionPermissionGuard.test.ts`):** ZERO new whole-tenant loads; `MAX_KNOWN_GAPS = 0`; MFA verified on Admin numbering/work-type saves; Home write-off policy (`signoff:approve` / `register:approve`) verified (`R757`).
5. **Playwright E2E (`e2e/role-journeys.spec.ts`, via `npx playwright test --reporter=line --global-timeout=900000`):**
   - **High-risk opening journey:** Fee earner submits a High-risk matter → receives permanent matter number, stays `Prospective` with `high_risk_opening` in `Pending Partner approval`; Partner approves (`Pending Risk & Compliance approval`, verifying same Partner cannot step 2); different Risk & Compliance user approves → matter opens.
   - **Blocked-by-CDD then Open matter journey (`R751`):** Fee earner submits a Residential Conveyancing matter with CDD unstarted → blocked in `Prospective` (override refused in UI/server) → records client CDD → clicks **Open matter** → matter opens cleanly (`active`).
   - **Override journey:** Fee earner submits Litigation (`Pre-action correspondence`) missing Engagement signed → Partner records audited override (`matter stays Prospective`) → clicks **Open matter** → matter opens cleanly.

---

## 11. Expected `docs/roadmap/feature-list.md` Updates (`R744`, `R759`)

When `S1-05` lands on its implementation PR:
- **Update row `4`** ("What exists", "What's missing", & Status):
  - **Add to "What exists":** Two-stage `high_risk_opening` approval (`Partner` → different `Risk & Compliance`, no admin bypass, automatic `'withdrawn'` on down-score/abandon, `ADR 0039`), work-type opening gate (`workTypes.*.openingGate`) re-checked inside `withTenantTransaction` across all opening paths (`R741`, `R742`), audited `matter:opening_gate:override` (`allowCddOverride` enforcement, `0026`, `ADR 0040`), explicit **Open matter** retry (`R751`), server-stamped pre-S1-06 signed engagement action (`R753`), aligned Home `sign_off` / `/registers` write-off approvals (`R757`), and configurable token-based `matterNumbering` (`client_ref_prefix` default parity, server-enforced ignoring caller `matterNumber`, `B6` monotonicity).
  - **Set "What's missing" to:** `"Engagement signature gate awaits uploaded signed copies and outbox dispatch in S1-06; funds-on-account gate awaits ledger receipt matching in S1-08; live E-ID and Sanctions & PEP screening provider integrations remain deferred (F24, F25)."`
  - **Status:** **`Partly built`** (`R759` — moved cleanly to `Completed` only when `S1-06`/`S1-08` finish the remaining Stage 1 gates or per final Stage 1 §2 exit criteria noting deferred providers `F24`/`F25`).
- **Add new backlog rows (after `B26` reserved on `fix/sign-out`, plus `B27`–`B28` from `S1-04`):**
  - **`B29` — Enforce non-draft `matter_number` uniqueness constraint after tenant duplicate audit (`R744`):** Pre-check existing tenant databases (`M-000007`/`M-000010`-style historical duplicates such as `BRI001-0003` in early demo data), resolve any duplicates safely with the firm, and apply a partial unique index `uq_matters_tenant_matter_number_non_draft` (`Severity: Medium`, `Stage: Before first hosted client`, `Status: Not started`).
  - **`B30` — Interactive Admin matter-numbering preview builder widget (`R760` Lever 2 deferral):** Build the standalone interactive Admin UI preview builder for custom matter-numbering tokens (`S1-05` ships `matterNumbering` config schema, `base.json`, `saveMatterNumberingConfigAction` + MFA, `WorkTypesAdminPanel` gate toggles, and read-only Admin summary).
  - **`B31` — Additional matter-numbering tokens `{WORK_TYPE}` and `{ENTITY}` (`R760` Lever 3 deferral):** Additive tokens beyond WP2's five core tokens (`{CLIENT_REF}`, `{SEQ}`/`{SEQ:N}`, `{YYYY}`, `{YY}`, `{DEPT}`) and four scopes (`client_ref_prefix`, `firm`, `year`, `department`).

---

## 12. Commit Breakdown (Each Independently Testable)

1. `feat(s1-05): add per-transition roles, distinct-approver, allowAdminBypass=false, withdrawn state, and high_risk_opening core type to registers engine` (`core/src/api/`, `core/src/domain/registers/`, `core/src/tenancy/registerRepository.ts`, unit/contract tests).
2. `feat(s1-05): add configurable token matter numbering engine and client_ref_prefix decoupled sequence keys` (`core/src/domain/matterNumbering/`, `core/schemas/`, `core/src/config-engine/`, `matter-numbering-s105.test.ts`).
3. `feat(s1-05): add migration 0026 (opening_gate_overrides, matter number sequence columns), demo work-type/numbering config, and seed BRI001-0003 duplicate fix` (`core/src/tenancy/migrations/index.ts`, `core/src/tenancy/matterRepository.ts`, `client-not-a-law-firm/config/base.json`, `data/seed-not-a-law-firm.json`, migration test).
4. `feat(s1-05): enforce transactional opening gate across all opening paths, ignore crafted status/number, exempt PMS import with audit, add open/engagement actions, and align signoff/register permissions` (`core/src/domain/rbac/registry.ts`, `src/server/`, `src/app/actions.ts`, `core/tests/opening-gate-numbering-s105.test.ts`, guard tests).
5. `feat(s1-05): wire opening gate/override/Open-matter UI, High-risk queue, WorkTypesAdminPanel gate controls, and Playwright E2E journeys` (`src/components/`, `src/server/pageLoaders.ts`, `e2e/role-journeys.spec.ts`).
6. `docs(s1-05): update Help articles, technical notes, release notes (R757), and feature-list` (`src/docs/`, `docs/`).

---

## 13. Risks, Contradictions & Owner Decisions

- **Codebase contradictions resolved:** `work_type` has no `chargeable` boolean (`pro_bono` exists on `matter_type` / `billing_basis`); demo contains duplicate `BRI001-0003` (`M-000007` matches `PMSL-M-BRI001-0001` while `M-000010` matches `PMSL-M-BRI001-0003` and `core/tests/rbac.test.ts:7003`, so fix `M-000007` to `BRI001-0001` rather than changing `M-000010`); `MatterFormClient.tsx:2006-2021` uses label matching; `services.ts:5659-5660` fails closed when governance extension is disabled; `resolveNextMatterStatusId` (`:5773-5776`) accepts arbitrary caller status; `saveMatterRecord` (`:6645-6657`) accepts caller `matterNumber`. All resolved explicitly in `S1-05`.

### Owner answers incorporated (24 Nov 2026)
5. **Non-chargeable / Pro Bono matters:** Confirmed — Pro Bono obeys the selected work type's rules uniformly (partner override where permitted; no automatic exemption).
6. **High-ML-risk non-overridable list (`allowCddOverride: false`, `§4`):** Confirmed — the `23` proposed work types cannot have CDD overridden, and `technology_and_digital_fintech_and_payments` stays overridable.
7. **Matter number allocation timing:** Confirmed — allocate permanently at first non-draft submission **after** validation passes (so rejected validation saves consume zero numbers; Referred & High-risk matters awaiting approval receive their number cleanly).
8. **Core-locked `high_risk_opening` rules:** Confirmed — transitions, `allowedRoles`, `mustDifferFromPreviousApprover`, and `allowAdminBypass: false` are locked in core and cannot be weakened via Admin UI.
- **Additional owner confirmations (24 Nov 2026):**
  - PMS import (`createRecordFromPms`) is exempt with an audit entry (`R742`); Home write-off approval aligns with `/registers` approvers (`R757`).
  - **Schedule trim (`R760` Levers 2 & 3):** Owner confirmed pulling **Levers 2 & 3** — defer the Admin interactive numbering preview widget (`B30`) and extra tokens beyond `{CLIENT_REF}`, `{SEQ}`/`{SEQ:N}`, `{YYYY}`, `{YY}`, `{DEPT}` (`B31`).
  - **`'Referred'` conflicts (`R740`):** Owner confirmed `'Referred'` conflicts cannot be overridden (`OPENING_GATE_OVERRIDE_FORBIDDEN`; must complete conflict review).
  - **Engagement self-certification (`R753`):** Owner confirmed closing free-choice signed status now via server-stamped `recordEngagementLetterSignedAction`.

---

## 14. Estimate (`3.5–4` days with Levers 2 & 3 accepted)

- **Baseline scope estimate (un-trimmed):** `4–5` days.
- **Confirmed `S1-05` delivery estimate (`R760` Levers 2 & 3 pulled, 24 Nov 2026 — `3.5–4` days):**
  - **Lever 2:** Keep `matterNumbering` config schema, `client-not-a-law-firm/config/base.json`, `saveMatterNumberingConfigAction` + MFA, `WorkTypesAdminPanel` opening-gate toggles, read-only numbering summary, and tests complete in `S1-05`; defer the interactive Admin pattern-preview widget (`B30`).
  - **Lever 3:** Ship the five core numbering tokens (`{CLIENT_REF}`, `{SEQ}`/`{SEQ:N}`, `{YYYY}`, `{YY}`, `{DEPT}`) and scopes (`client_ref_prefix`, `firm`, `year`, `department`) in `S1-05`; defer `{WORK_TYPE}` and `{ENTITY}` (`B31`).
- **Combined WP2 total (`S1-04` + `S1-05`):** **`7–8` days** (accepted, fitting inside [stage-1-plan.md](../stage-1-plan.md) §5a's **`6–8` days** budget).
