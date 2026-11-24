# S1-05: High-Risk Opening Sign-Off, Per-Work-Type Opening Gate, and Configurable Matter Numbering

| | |
|---|---|
| Backlog | Row `4` (Client and matter inception), plus `B6` (monotonic numbering invariance across format changes) |
| Decision | Stage 1 decisions `S1-D6`, `S1-D7`, `S1-D8`, `S1-D10`; Owner decisions (24 Nov 2026); [ADR 0032](../../decisions/0032-registers-engine.md), Proposed [ADR 0039](../../decisions/0039-registers-engine-extensions-cdd-high-risk.md), Proposed [ADR 0040](../../decisions/0040-matter-opening-gate-and-numbering.md) |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP2 (`S1-05`) |
| Branch | `s1-05-high-risk-opening-gate-numbering`, stacked on `s1-04-cdd-workflow`, targeting `develop` |
| Change class | Core registers engine extension (`high_risk_opening`, per-transition roles, `mustDifferFromPreviousApprover`, `allowAdminBypass: false`), Core domain matter-numbering engine (`@platform/core`), Core tenancy schema + repositories + expand migration `0026` (`core/src/tenancy/`), Core configuration schema & deep-merge (`core/schemas/`, `core/src/config-engine/`), Host transactional gate + opening paths + UI + page loaders (`src/`), Demo client config (`client-not-a-law-firm/config/base.json`), Help docs (`src/docs/`) |
| Layer | Core API & domain (`core/src/api/`, `core/src/domain/`), Core tenancy (`core/src/tenancy/`), Core config (`core/src/config-engine/`, `core/schemas/`), Host server & UI (`src/`), Client config (`client-not-a-law-firm/`) |
| Size | L (`3–4` days) |
| Depends on | `S1-04` (CDD workflow & client-subject registers); Approval of Proposed [ADR 0039](../../decisions/0039-registers-engine-extensions-cdd-high-risk.md) and [ADR 0040](../../decisions/0040-matter-opening-gate-and-numbering.md) before coding |
| Blocking manual tasks | None in dev/test; existing Stage 1 §8 manual demo-deploy (`caj-migrate-demo`) when WP2 deploys |
| Baseline | `develop` at `1093e45` |

---

## 1. Change Class and Layer Breakdown

| Part | Change class | Layer |
|---|---|---|
| Per-transition `allowedRoles`, `mustDifferFromPreviousApprover`, `distinctFromTransitionKeys`, `allowAdminBypass: false`, core `'high_risk_opening'` register type | Core registers engine & API (additive, Rule 7) | `core/src/api/registers.types.ts`, `core/src/domain/registers/index.ts`, `core/schemas/registers.config.schema.json` |
| Token-based matter numbering engine (`validateMatterNumberPattern`, `renderMatterNumber`, `resolveMatterSequenceKey`) | Core domain feature | `core/src/domain/matterNumbering/index.ts`, `core/src/api/index.ts` |
| `matter:opening_gate:override` permission (partner & managing partner only) | Core RBAC registry | `core/src/domain/rbac/registry.ts` |
| Migration `0026`, `matter_opening_gate_overrides` persistence, decoupled `allocateNextMatterNumber`, `lockAndExecuteTransition` cycle approver check | Core tenancy layer | `core/src/tenancy/migrations/index.ts`, `core/src/tenancy/matterRepository.ts`, `core/src/tenancy/registerRepository.ts` |
| `workTypes.*.openingGate` & `matterNumbering` schemas, Zod validation, `loadAndValidateTenantConfig` deep-merge, `tenant_module_configs['matter_numbering']` | Core config engine & schemas | `core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `core/tests/tenant-config-usage.test.ts` |
| Shared `evaluateAndEnforceOpeningGateInTx` across all 4 opening paths, `signoff:approve`/`register:approve` alignment, override actions, numbering actions, `ACTION_PERMISSIONS`, scoped loaders | Host server & HTTP/Action boundary | `src/server/services.ts`, `src/server/actionPermissions.ts`, `src/server/pageLoaders.ts`, `src/app/actions.ts` |
| Opening gate banner/override UI, high-risk banner, unified Home sign-off panel, Admin work-type opening-gate & matter-numbering screens | Host UI | `src/components/MatterFormClient.tsx`, `src/components/MatterProfileClient.tsx`, `src/components/HomeClient.tsx`, `src/components/RegistersWorkspaceClient.tsx`, `src/components/AdminClient.tsx` |
| Complete demo `workTypes.items[].openingGate` rules (across all 76 work types) & default `matterNumbering` config | Client configuration | `client-not-a-law-firm/config/base.json`, `data/seed-not-a-law-firm.json` |
| Plain-English Help & release notes (Rule 11, Stage 1 §6 rule 6) | Help documentation | `src/docs/articles/`, `docs/release-notes.md` |

---

## 2. What Exists Today (`develop` at `1093e45`)

1. **Risk ratings & matter opening wizard (`src/domain/matterOpeningRecord.ts`, `MatterFormClient.tsx`, `src/server/services.ts`):**
   - `MATTER_RISK_SECTIONS` (`src/domain/matterOpeningRecord.ts:56-326`) scores 22 core questions + work-type `extraRiskQuestions` via `buildMatterRiskAssessmentSnapshot` (`:508-644`, pure max-elevation `High > Medium > Low`). Server validates via `validateMatterRiskAssessmentInput` (`:675-837`) inside `saveMatterRecord` (`src/server/services.ts:6274-6311`), ignoring client `input.riskRatingId` and overwriting `matter.riskRatingId` (`:7542-7547`) via `resolveRiskRatingIdForLevel` (`matterOpeningRecord.ts:952-973`), storing `matters.risk_assessment_json` alongside `fields_json.riskAssessment`.
   - **Pre-existing UI & gate issues to fix:**
     - `MatterFormClient.tsx:2006-2021` syncs client `riskRatingId` via label prefix matching (`v.label.toLowerCase().startsWith(targetLabel)`) instead of `systemKey`; replace with `resolveRiskRatingIdForLevel`.
     - `MatterFormClient.tsx:4312-4357` (`missingItems` / `canSubmit`) does not surface work-type opening gate status or overrides.
     - `runMatterOpeningGate` (`src/server/services.ts:5509-5672`) runs **outside** `withTenantTransaction` (`:7762`), checks only extensions/Key Dates/partner cost sign-off, and has a bug at `:5659-5660` (`allowProceed = Object.keys(errors).length === 0 && Boolean(openGovernance?.allowProceed)` blocks opening when `enableMatterCostsGovernance` is disabled!).
     - Three separate opening triggers (`saveMatterRecord` `:7088-7103`, `updateMatterConflictRecord` `:9290-9355`, `signOffMatterCostsRecord` `:9703-9868`) never re-check CDD, engagement, funds, or high-risk approval inside `withTenantTransaction`. A `High` rating currently opens immediately without creating any register approval.
2. **Matter numbering (`allocateNextMatterNumber` & `matter_number_sequences`):**
   - Migration `0009` (`core/src/tenancy/migrations/index.ts:751, 760-766`) defines `tenant_matter_number_seq` and `public.matter_number_sequences (tenant_id, prefix, last_number, updated_at)`.
   - `generateMatterNumber` (`src/server/services.ts:5006-5026`) derives `prefix` from `org.clientReference` else 3-letter org legalName/`person.surname` + `'001'`, fallback `'MAT001'`.
   - `TenantMatterRepository.allocateNextMatterNumber` (`core/src/tenancy/matterRepository.ts:714-768`) executes inside `withAutonomousTenantTransaction` (`tenantScopedRepository.ts:209-237`), scans existing numbers `~ '^' || $2 || '-[0-9]+$'`, upserts `matter_number_sequences` atomically, and formats **`${cleanPrefix}-${String(nextNum).padStart(4, '0')}`** (e.g., `PEN001-0005`, `MAT001-0001`). `clearTenantData` (`:3220-3242`) preserves `matter_number_sequences` across demo resets (`B6`).
   - `advanceMatterNumberHighWaterInTx` (`:877-896`) regex-parses `/^([A-Z0-9_-]+)-(\d+)$/i` on every save/import, and `saveMatterRecord` calls `generateMatterNumber` at `:6645-6657` before validation/gate checks.
3. **`signoff:approve` vs `register:approve` alignment gap:**
   - `core/src/domain/rbac/registry.ts:467-475` (`signoff:approve`: `admin`, `managing_partner`, `partner`) vs `:707-716` (`register:approve`: adds `risk_compliance` and `supervisor`).
   - `HomeClient.tsx:438-441, 3529-3587` reads `signOffs` via `taskWorkflowRepository.listVisibleSignOffs` (which only sees `register_type_key = 'sign_off'`, drops `'discussing'`, and exposes no `'reject'`) and mutates via `approveSignOffAction` / `discussSignOffAction` (`src/app/actions.ts:1011-1038` -> `src/server/services.ts:18343-18444`, strictly requiring `signoff:approve` even though `risk_compliance` and `supervisor` are listed in `CORE_REGISTER_TYPES.sign_off.approvalRules.allowedApproverRoles`!).
   - `core/src/domain/registers/index.ts:1010-1023` enforces type-wide `allowedApproverRoles`, lacks prior-approver distinctness in `register_transitions`, and skips role checks when `actorRoles.includes('admin')` (`:1013`).
   - `sign_off` kind `'matter_opening'` exists in seed/types (`src/domain/types.ts:1725`, `src/seed/demo.ts:4127`) with zero runtime creators.
4. **Engagement status (`B2` pre-S1-06):**
   - Stored on `matters.engagement_letter_status TEXT NOT NULL DEFAULT ''` (`migrations/index.ts:975`) with values `""`, `"Drafting"`, `"Drafted"`, `"Sent"`, `"Sent to client"`, `"Signed"`, `"Signed & returned"` plus timestamps `engagement_letter_sent_at` / `engagement_letter_signed_at`. `MatterProfileClient.tsx:246-249` and `matterOpeningRecord.ts:940-942` treat `Boolean(engagementLetterSignedAt) || engagementLetterStatus === 'Signed' || engagementLetterStatus === 'Signed & returned'` as signed.
5. **Codebase contradiction flagged explicitly:**
   - `Stage1-WP2-plan-prompt.md` specifies `"Conflict check cleared and CDD complete: required for every chargeable work type"`. In `develop` (`1093e45`), `work_type` choice values (`data/seed-not-a-law-firm.json:3788-4763`) have **no `chargeable` flag** (`pro_bono` exists on `matter_type.pro_bono` L3196 and `billing_basis.pro_bono` L3268, whereas every work type in `work_type` can be used on chargeable instructions). All 76 configured work types therefore have `requireConflictCleared: true` and `requireCddComplete: true` in the demo `workTypes` config; open question `Q5` asks the owner whether `billing_basis.pro_bono` / `matter_type.pro_bono` should exempt any work-type gate automatically or require a partner override.

---

## 3. High-Risk Opening Approval (`high_risk_opening`) & Entry-Point Alignment

### 3.1 Core `high_risk_opening` register type (`CORE_REGISTER_TYPES`, Proposed ADR 0039)
- **Key:** `'high_risk_opening'`, prefix `'HRO'`, `subjectScope: 'matter'`, `requireMatterLink: true`.
- **Approval rules (core-locked, non-overridable by tenant config):**
  - `requireTwoPersonApproval: true`, `forbidSelfApproval: true`, `requireAssignedApproverMatch: false`, **`allowAdminBypass: false`**.
- **States:**
  - `pending_partner` (`initial: true`, `category: 'pending_approval'`, label `"Pending Partner approval"`)
  - `pending_compliance` (`category: 'pending_approval'`, label `"Pending Risk & Compliance approval"`)
  - `approved` (`terminal: true`, `category: 'approved'`, label `"Approved"`)
  - `rejected` (`terminal: true`, `category: 'rejected'`, label `"Rejected"`)
- **Transitions:**
  1. `partner_approve`: `['pending_partner'] -> 'pending_compliance'`, `requiredPermission: 'register:approve'`, **`allowedRoles: ['partner', 'managing_partner']`**, `forbidSelfAction: true`, `requiresComment: false` (optional comment), raises notification `approval_requested` for active `'risk_compliance'` users.
  2. `compliance_approve`: `['pending_compliance'] -> 'approved'`, `requiredPermission: 'register:approve'`, **`allowedRoles: ['risk_compliance']`**, `forbidSelfAction: true`, **`mustDifferFromPreviousApprover: true`**, **`distinctFromTransitionKeys: ['partner_approve']`**, `setsDecidedAt: true`, optional `evaluateAndEnforceOpeningGateInTx` attempt to transition linked `prospective` matter to `active` if remaining work-type pre-conditions are met!
  3. `reject_opening`: `['pending_partner', 'pending_compliance'] -> 'rejected'`, `requiredPermission: 'register:approve'`, **`allowedRoles: ['partner', 'managing_partner', 'risk_compliance']`**, `forbidSelfAction: true`, `requiresComment: true`.
- **Creation & re-assessment lifecycle:**
  - Whenever `saveMatterRecord` (or re-scoring on edit/submit) produces `isHighOrCriticalRiskRating(matter.riskRatingId, values)` and no non-rejected `high_risk_opening` record exists for `matterId`, core transactionally creates one in `'pending_partner'` (with `ownerId` = `actorId` or `leadFeeEarnerId`, summary linking client & risk score) unless already `'approved'` for the current/higher risk rating.
  - If a matter's risk rating re-scores *down* below High/Critical before opening, any active `pending_*` `high_risk_opening` record is left audited or closed as superseded? **Decision:** only treat an active `high_risk_opening` as no longer blocking once re-scored `< High`; record an audit note if superseded, and if re-scored back to High/Critical create a fresh approval cycle (`pending_partner`) unless already `'approved'` at that rating.
  - Because `allowAdminBypass: false`, `admin` users **cannot** execute `partner_approve` or `compliance_approve` unless that specific person independently holds `'partner'`/`'managing_partner'` (for step 1) or `'risk_compliance'` (for step 2) and is neither `ownerId`/`createdById` nor the step-1 approver.

### 3.2 Aligning `signoff:approve` and `register:approve` (`Home` queue + `/registers`)
1. **Unify Home `sign_offs_and_approvals` query onto `registerRepo.listVisibleRegisterRecords` (`['sign_off', 'high_risk_opening']`):**
   - `HomeClient` renders both standard partner sign-offs (`write_off`, legacy `matter_opening`) and two-stage `high_risk_opening` items awaiting the viewer's eligible stage (`pending_partner` for partners, `pending_compliance` for Risk & Compliance where viewer !== step-1 approver), keeping `SignOffItem` compatibility projection only for `sign_off` consumers if any remain.
2. **Permission alignment on existing `sign_off` vs new `high_risk_opening`:**
   - Keep `approveSignOffAction` / `discussSignOffAction` working cleanly for legacy Home callers (authorising `{ anyOf: ['signoff:approve', 'register:approve'] }` on `sign_off`, fixing the split where `risk_compliance`/`supervisor` could approve a `sign_off` in `/registers` yet were blocked on Home!).
   - Keep `transitionRegisterRecordAction` (`{ anyOf: ['register:approve', 'signoff:approve', 'register:edit', 'undertaking:manage'] }`) as the canonical entry point for all new UI calls (`high_risk_opening` strictly requires `register:approve` + transition's `allowedRoles`, with **zero** `signoff:approve` alias bypass).
   - Remove unused `'matter_opening'` auto-creation speculation and reserve `'sign_off'` for `'write_off'` and legacy migrated `'matter_opening'` records (`SO-*`).

---

## 4. Complete Work-Type Opening Pre-Conditions & High-ML-Risk Non-Overridable CDD Table (`S1-D6`)

**Firm-wide default in core (`workTypes.defaults.openingGate`):** all 5 keys **`false`** (`requireConflictCleared: false`, `requireCddComplete: false`, `requireEngagementSigned: false`, `requireFundsOnAccount: false`, `allowCddOverride: true`).

**Pre-S1-06 / Pre-S1-08 evaluation notes:**
- **`requireEngagementSigned` before `S1-06`:** Evaluated by `isMatterEngagementSignedForGate(matter)` checking `Boolean(matter.engagementLetterSignedAt) || matter.engagementLetterStatus === 'Signed' || matter.engagementLetterStatus === 'Signed & returned'` (B2 values in `matters.engagement_letter_status`). Drafted/Sent letters do not satisfy it; `S1-06` later backs this with uploaded signed client care copy / `ESignatureEnvelopeRecord`.
- **`requireFundsOnAccount` before `S1-08`:** Configuration key defined and validated everywhere; **set to `false` across all 76 demo work types** in `client-not-a-law-firm/config/base.json`. Gate evaluator reads it cleanly so `S1-08` switches selected work types to `true` without schema changes.

**Proposed Non-Overridable CDD (`allowCddOverride: false`) Rationale (23 work types):**
1. **Real Estate & Property (`8`: parent + 7 subcategories):** Conveyancing, commercial property, leases, development/planning, secured lending, property management, and construction are primary UK AML targets under MLR 2017 Reg 12(2)(a) (`clientMoneyThresholdGbp: 250000`, `amlInScope: true`).
2. **Corporate M&A, Company Formations, Joint Ventures & Due Diligence (`4`: `company_formations_and_structures`, `mergers_and_acquisitions`, `joint_ventures`, `due_diligence`):** Entity creation and corporate acquisitions directly fall under MLR 2017 Reg 12(2)(b)–(c) (company formation & buying/selling business entities, `£250,000` threshold).
3. **Private Client Trusts, Probate & Tax (`4`: parent + `trusts_and_settlements`, `estate_administration`, `inheritance_tax_planning`):** Trust/estate administration and tax structuring involve high-value client account flows and complex beneficial ownership (MLR 2017 Reg 12(2)(d)/(e), `amlInScope: true`); meanwhile `wills_and_codicils`, `lasting_powers_of_attorney`, and `court_of_protection` remain overridable (`true`) for urgent capacity/end-of-life instructions.
4. **Finance & Banking (`7`: parent + 6 subcategories):** Loan facilities, security, guarantees, asset finance, restructuring/insolvency, and financial services regulation (`amlInScope: true`, `£250,000` threshold) carry direct regulated financial-transaction risk.
*(Pending owner confirmation in `Q6`: whether `technology_and_digital_fintech_and_payments` and `private_client` parent should remain as proposed.)*

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
| 43 | `work_type.private_client_wills_and_codicils` | Wills & codicils | `true` | `true` | `true` | **`true`** | `false` | `true` | Urgent testator capacity overrideable |
| 44 | `work_type.private_client_lasting_powers_of_attorney` | Lasting powers of attorney | `true` | `true` | `true` | **`true`** | `false` | `true` | Urgent capacity overrideable |
| 45 | `work_type.private_client_trusts_and_settlements` | Trusts & settlements | `true` | `true` | `true` | **`true`** | `false` | **`false`** | MLR 2017 Reg 12 trust creation/assets |
| 46 | `work_type.private_client_estate_administration` | Estate administration | `true` | `true` | `true` | **`true`** | `false` | **`false`** | Probate estate asset distribution (`£100k`) |
| 47 | `work_type.private_client_inheritance_tax_planning` | Inheritance tax planning | `true` | `true` | `true` | **`true`** | `false` | **`false`** | MLR Reg 12(2)(d) tax/wealth structuring |
| 48 | `work_type.private_client_court_of_protection` | Court of Protection | `true` | `true` | `true` | **`true`** | `false` | `true` | Vulnerable client urgency overrideable |
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
| 68 | `work_type.technology_and_digital_cyber_incident_response` | Cyber incident response | `false` | `true` | `true` | `false` | `false` | `true` | Urgent incident response overrideable |
| 69 | `work_type.technology_and_digital_fintech_and_payments` | Fintech & payments | `false` | `true` | `true` | `false` | `false` | `true` | See `Q6` (candidate for `false`) |
| 70 | `work_type.family` | Family (Parent, *court/litigation*) | `false` | `true` | `true` | **`true`** | `false` | `true` | Contested/Private Client court work |
| 71 | `work_type.family_pre_nuptial_agreements` | Pre-nuptial agreements | `false` | `true` | `true` | `false` | `false` | `true` | Non-litigious agreement; overridable |
| 72 | `work_type.family_separation_and_divorce` | Separation & divorce *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Court proceedings engagement |
| 73 | `work_type.family_financial_orders` | Financial orders *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Court/asset proceedings engagement |
| 74 | `work_type.family_children_arrangements` | Children arrangements *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Court/urgent proceedings engagement |
| 75 | `work_type.family_cohabitation_agreements` | Cohabitation agreements | `false` | `true` | `true` | `false` | `false` | `true` | Non-litigious agreement; overridable |
| 76 | `work_type.family_domestic_abuse_proceedings` | Domestic abuse proceedings *(litigation)* | `false` | `true` | `true` | **`true`** | `false` | `true` | Urgent injunction/court; overrideable CDD |

---

## 5. Data Model, Expand Migration `0026`, and Backfill

- **Migration ID:** `0026_opening_gate_overrides_and_numbering_expand` (`CORE_REQUIRED_SCHEMA_VERSION = '0026'`, `dependsOn: ['0009', '0025']`).
- **`upSql`:**
  1. Create `public.tenant_opening_override_id_seq` (`OVR-000001`).
  2. Create `public.matter_opening_gate_overrides` (`tenant_id`, `id`, `matter_id`, `precondition_key IN ('conflict_cleared', 'cdd_complete', 'engagement_signed', 'funds_on_account')`, `reason CHECK (char_length(btrim(reason)) >= 10)`, `overridden_by_person_id`, `overridden_at`, `revoked_by_person_id`, `revoked_at`, `PRIMARY KEY (tenant_id, id)`, `FOREIGN KEY (tenant_id, matter_id) REFERENCES public.matters (tenant_id, id) ON DELETE CASCADE`, plus partial unique index `uq_matter_opening_gate_overrides_active` where `revoked_at IS NULL`). `GRANT SELECT, INSERT, UPDATE, DELETE` to `<runtimeRole>`.
  3. Expand `public.matters` with nullable `number_sequence_key TEXT NULL` and `number_sequence_value BIGINT NULL`.
  4. Add partial unique index `uq_matters_tenant_matter_number_non_draft ON public.matters (tenant_id, matter_number) WHERE matter_number <> '' AND matter_number <> 'DRAFT'`. *(Pre-flight check on seeded/clean data confirms zero duplicate non-draft numbers exist.)*
  5. **Backfill SQL in `upSql`:** Populate `number_sequence_key` & `number_sequence_value` for existing non-draft `matters` rows matching `^([A-Z0-9_-]+)-([0-9]+)$` where `number_sequence_key IS NULL`, leaving `matters.matter_number` completely **untouched**.
- **Existing matters backfill & compatibility:** Existing active matters stay `active` unchanged (`openingGate` and `high_risk_opening` apply when a prospective/draft matter transitions to opening, never locking existing open matters retroactively).
- **Reversible `downSql`:** Drops `uq_matters_tenant_matter_number_non_draft`, drops `number_sequence_key` and `number_sequence_value` from `public.matters`, drops `public.matter_opening_gate_overrides`, and drops `public.tenant_opening_override_id_seq`.

---

## 6. Configuration Schema Changes (`workTypes` & `matterNumbering`)

1. **`workTypes.defaults.openingGate` and `workTypes.items[].openingGate`** (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `core/src/api/index.ts`):
   - Object (`strict`): `requireConflictCleared` (`boolean`, default `false`), `requireCddComplete` (`boolean`, default `false`), `allowCddOverride` (`boolean`, default `true`), `requireEngagementSigned` (`boolean`, default `false`), `requireFundsOnAccount` (`boolean`, default `false`).
   - Merged additively in `loadAndValidateTenantConfig` (`workTypes.defaults` + `workTypes.items[]` by `workTypeId`) and runtime-edited via `saveWorkTypesConfigAction` (`tenant_module_configs['work_type_configs']`).
2. **`matterNumbering`** (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `core/src/api/index.ts`):
   - `pattern`: `string` (default `"{CLIENT_REF}-{SEQ:4}"`), validated by `validateMatterNumberPattern` (only allowed tokens `{CLIENT_REF}`, `{SEQ}`, `{SEQ:1..8}` [exactly one required], `{YYYY}`, `{YY}`, `{DEPT}`, `{WORK_TYPE}`, `{ENTITY}`; allowed literals `[A-Z0-9\-/._]`, max 64 chars).
   - `sequenceScope`: `enum ['firm', 'year', 'department', 'work_type', 'client', 'entity']` (default `'client'`).
   - `emptyTokenFallback`: `string` (uppercase alphanumeric 1–12 chars, default `'MAT'`).
   - Deep-merged in `loadAndValidateTenantConfig`, runtime-overridable via `tenant_module_configs['matter_numbering']` (**Administration → Matter Numbering**, preview-only live rendering without consuming a sequence integer).
   - Every leaf consumed in runtime `core/src/domain/matterNumbering/index.ts` & `src/server/services.ts` so `core/tests/tenant-config-usage.test.ts` stays completely green with zero false `x-reserved` markers.

---

## 7. Permissions, Action Policies, Role Matrix & MFA

- **New permission (`core/src/domain/rbac/registry.ts`):**
  - `'matter:opening_gate:override'` (`domain: 'matter'`, `sensitivity: 'restricted'`, `requiresMfa: false`, granted by default in `DEFAULT_RBAC_ROLES` **ONLY** to `'partner'` and `'managing_partner'`; explicitly excluded from `'admin'`, `'risk_compliance'`, `'supervisor'`, `'fee_earner'`, and `'legal_secretary'`).
- **New/Updated Server Actions & `ACTION_PERMISSIONS` (`src/server/actionPermissions.ts`, `MAX_KNOWN_GAPS = 0`):**
  - `overrideMatterOpeningPreconditionAction` -> `{ kind: 'permission', key: 'matter:opening_gate:override', enforcedBy: 'action' }` *(service also checks `canAccessMatter` & `allowCddOverride`)*
  - `revokeMatterOpeningOverrideAction` -> `{ kind: 'permission', key: 'matter:opening_gate:override', enforcedBy: 'action' }`
  - `saveWorkTypesConfigAction` -> existing `admin:access` (**`requiresMfa: true`**)
  - `saveMatterNumberingConfigAction` -> `{ kind: 'permission', key: 'admin:access', enforcedBy: 'action' }` *(enforces `mfaVerified: true`)*
  - `previewMatterNumberPatternAction` -> `{ kind: 'permission', key: 'admin:access', enforcedBy: 'action' }` *(pure formatting preview, zero DB sequence increment)*
  - `approveSignOffAction` / `discussSignOffAction` -> `{ kind: 'permission', key: { anyOf: ['signoff:approve', 'register:approve'] }, enforcedBy: 'service' }` *(aligning `sign_off` queue with `/registers`, while `high_risk_opening` transitions enforce strict `register:approve` + transition `allowedRoles` + `allowAdminBypass: false` + `mustDifferFromPreviousApprover: true`)*.

---

## 8. Visibility, Isolation & In-Transaction Server Enforcement

1. **Visibility & S1-09 composition:**
   - `high_risk_opening` register records carry `matter_id` and inherit matter restriction unconditionally via converged `REGISTER_RECORD_VISIBLE_SQL_PREDICATE` (`buildMatterHiddenFromViewerSql`) and `canPersonAccessMatter` (`services.ts:27228, 27552`).
   - `matter_opening_gate_overrides` inherits parent matter visibility via `canAccessMatter` inside `services.ts` and scoped SQL queries (`getOpeningGateStateForMatter` only queried for accessible matters). When `S1-09` adds barrier tables into `canAccessMatter` and `buildMatterHiddenFromViewerSql`, all high-risk approvals, overrides, and opening gate reads automatically inherit barriers without code changes.
   - `executeRegisterRemindersForTenant` adds recipient routing for `high_risk_opening`: `pending_partner` escalates to partners (`responsiblePartnerId`, `supervisingPartnerId`, or active `'partner'` users), and `pending_compliance` escalates to active `'risk_compliance'` users (skipping restricted staff matters unless permitted per ADR 0014).
2. **In-transaction gate & race prevention (`evaluateAndEnforceOpeningGateInTx`):**
   - Called inside `withTenantTransaction` across all 4 opening commit paths (`saveMatterRecord`, `updateMatterConflictRecord`, `signOffMatterCostsRecord`, `high_risk_opening` `compliance_approve`).
   - Acquires locks in fixed order: (1) `public.matters FOR UPDATE` (`row_version` verified), (2) ordered `public.register_records` (`high_risk_opening` `FOR UPDATE`, client `cdd` `FOR SHARE`), (3) `public.matter_opening_gate_overrides FOR UPDATE`, (4) `tenant_module_configs` (`work_type_configs`, `registers`) & Key Dates opening check.
   - Fixes `runMatterOpeningGate` (`src/server/services.ts:5659-5660`) null-governance bug (`openGovernance === null` when extension is disabled no longer sets `allowProceed = false`), keeping `beforeMatterOpen` extension hooks **outside** the TX (`R490`).
   - Any concurrent modification (e.g., partner revoking an override or Compliance approving step 2 while CDD expires simultaneously) either sees committed new state cleanly or serialises behind the row lock — never commits an active matter with an unmet gate.
3. **Rule 9 two-tenant & tampered-ID coverage:** Every new repo query (`matter_opening_gate_overrides`, `high_risk_opening` register transitions, `allocateNextMatterNumber`) verifies `ctx.tenantId`, uses `SET LOCAL ROLE`, and asserts `assertRowTenant`.

---

## 9. Help and Documentation (Rule 11 & Stage 1 §6 Rule 6)

Plain British English for firm users (zero code identifiers, table names, or migration numbers):
- `src/docs/articles/matter-opening-and-risk.ts`: document opening pre-conditions per work type, partner overrides with mandatory reason, why CDD cannot be overridden on conveyancing and high-ML-risk work types, two-stage High-risk opening sign-off (Partner followed by a different Risk & Compliance colleague), and how matter numbers are assigned on submission.
- `src/docs/articles/sign-off-queue.ts`: document the High-risk opening approval stage in Home Sign-Offs & Approvals (`Pending Partner approval` → `Pending Risk & Compliance approval`) and that two different people must approve.
- `src/docs/articles/registers-engine.ts`: document the High-risk opening register type.
- `src/docs/articles/tenant-settings.ts`: document work-type opening rules and configurable matter numbering patterns in Administration (preserving existing matter numbers).
- `src/docs/articles/authentication-rbac-and-mfa.ts`: document opening-gate override permission (`Partner` and `Managing Partner` only, excluded from `System Administrator`) and no admin bypass on High-risk approvals.
- Technical notes: `docs/guides/platform-technical-notes.md` and `docs/release-notes.md` (covering migration `0026`, ADRs `0039`/`0040`).

---

## 10. Tests

1. **Migration round-trip (`core/tests/migrations-postgres.test.ts`):** `0026` `up -> down -> up` cleanly after `0025`, preserving existing `matters.matter_number` values and backfilling `number_sequence_key`/`number_sequence_value`.
2. **Unit & contract (`core/tests/matter-numbering-s105.test.ts`, `core/tests/registers-engine-s024.test.ts`, `core/tests/config-engine.test.ts`, `core/tests/tenant-config-usage.test.ts`):**
   - Token pattern validator, default `{CLIENT_REF}-{SEQ:4}` byte-for-byte parity with legacy numbering, `{YYYY}/{DEPT}/{SEQ:5}` and `{ENTITY}-{WORK_TYPE}-{YYYY}-{SEQ}` rendering, forbidden token/length rejection, and existing matter number immutability across pattern updates.
   - `high_risk_opening` rules: per-transition `allowedRoles`, distinct-approver rejection when same person holds both `partner` and `risk_compliance` (`REGISTER_DISTINCT_APPROVER_REQUIRED`), and explicit refusal when `admin` attempts approval without holding the transition role (`allowAdminBypass: false`).
   - All 76 work-type gate configurations parsed and resolved cleanly (`subcategory` -> `practice_area` -> `defaults` -> core `false`).
3. **Two-tenant PG16 isolation, gate enforcement & concurrency (`core/tests/opening-gate-numbering-s105.test.ts`):**
   - All 4 opening paths (`saveMatterRecord`, `updateMatterConflictRecord`, `signOffMatterCostsRecord`, `high_risk_opening` `compliance_approve`) enforcing work-type gates inside `withTenantTransaction`.
   - Pre-S1-06 engagement gate accepting `'Signed'` / `'Signed & returned'` and rejecting `'Drafting'` / `'Drafted'` / `'Sent'`.
   - Override permission matrix (`partner`/`managing_partner` succeed; `admin`, `fee_earner`, `risk_compliance` denied), mandatory reason check, refusal on Residential Conveyancing CDD (`allowCddOverride: false`), and refusal on `high_risk_approval` or `Rejected` conflict.
   - Concurrent `Promise.all` tests: double-approval race by dual-role actor, override revoke vs open submit race, B6 monotonicity under pattern switch + outer TX rollback + demo reset.
   - Forged `TenantContext` claims, tampered `matterId`/`registerRecordId`/`overrideId` across `tenant-alpha` vs `tenant-bravo`.
4. **Guards (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`, `actionPermissionGuard.test.ts`):** ZERO new whole-tenant loads; `MAX_KNOWN_GAPS = 0`; MFA verified on Admin numbering/work-type saves.
5. **Playwright E2E (`e2e/role-journeys.spec.ts`, via `npx playwright test --reporter=line --global-timeout=900000`):**
   - **High-risk opening journey:** Fee earner submits a High-risk matter → blocked in prospective status with `high_risk_opening` in `Pending Partner approval`; Partner approves (`Pending Risk & Compliance approval`, verifying same Partner cannot step 2); different Risk & Compliance user approves → matter transitions to Open.
   - **Override journey:** Fee earner opens a Litigation (`Pre-action correspondence`) matter missing Engagement signed → Partner records audited override with reason → matter opens; Residential Conveyancing missing CDD refuses override in UI/server.

---

## 11. Expected `docs/roadmap/feature-list.md` Row 4 Update

When `S1-05` lands, update **row `4`** ("What exists" & "What's missing"):
- **Add to "What exists":** Two-stage `high_risk_opening` approval (`Partner` → different `Risk & Compliance`, no admin bypass, `ADR 0039`), work-type opening gate (`workTypes.*.openingGate`) re-checked inside the matter transaction with audited `matter:opening_gate:override` (`allowCddOverride` enforcement, `0026`, `ADR 0040`), aligned `signoff:approve`/`register:approve` approval paths, and configurable token-based `matterNumbering` preserving existing numbers & B6 monotonicity.
- **Narrow "What's missing" to:** `"Engagement signature gate uses live uploaded signed copies once S1-06 lands; funds-on-account gate wires to ledger receipts in S1-08; live E-ID and Sanctions & PEP screening provider integrations deferred (F24, F25)."`
- Row 4 status remains **Completed** for Stage 1 core manual inception (or **Partly built** only for the deferred third-party providers `F24`/`F25` per Stage 1 §2 exit criteria, noted explicitly).

---

## 12. Commit Breakdown (Each Independently Testable)

1. `feat(s1-05): add per-transition roles, distinct-approver, allowAdminBypass=false, and high_risk_opening core type to registers engine` (`core/src/api/`, `core/src/domain/registers/`, `core/src/tenancy/registerRepository.ts`, unit/contract tests).
2. `feat(s1-05): add configurable token matter numbering engine and decoupled sequence keys` (`core/src/domain/matterNumbering/`, `core/schemas/`, `core/src/config-engine/`, unit tests).
3. `feat(s1-05): add migration 0026 (opening_gate_overrides, matter number sequence columns, unique non-draft index) and demo work-type/numbering config` (`core/src/tenancy/migrations/index.ts`, `core/src/tenancy/matterRepository.ts`, `client-not-a-law-firm/config/base.json`, migration test).
4. `feat(s1-05): enforce transactional opening gate across all 4 opening paths, align signoff/register permissions, and add override actions` (`core/src/domain/rbac/registry.ts`, `src/server/`, `src/app/actions.ts`, `core/tests/opening-gate-numbering-s105.test.ts`, guard tests).
5. `feat(s1-05): wire opening gate/override banners, High-risk queue, Admin numbering UI, and Playwright E2E journeys` (`src/components/`, `src/server/pageLoaders.ts`, `e2e/role-journeys.spec.ts`).
6. `docs(s1-05): update Help articles, technical notes, release notes, and feature-list row 4` (`src/docs/`, `docs/`).

---

## 13. Risks, Contradictions & Open Questions

- **Codebase contradiction noted:** `work_type` has no `chargeable` boolean today (`pro_bono` exists on `matter_type` / `billing_basis`). Also `MatterFormClient.tsx:2006-2021` uses label matching and `services.ts:5659-5660` fails closed when governance extension is disabled — both fixed explicitly in `S1-05`.
- **Matter number allocation timing vs `B6`:** Allocating at `saveMatterRecord` before gate pass burns a sequence integer if submission fails validation; moving number allocation **after** validation & gate readiness (or on `submit_referred` / first non-draft persistence) avoids unnecessary gaps while still preserving B6 monotonicity on rollbacks.

### Open questions for owner confirmation (numbered consecutively from `S1-04`: `Q5`–`Q8`)
5. **Non-chargeable / Pro Bono matters (`matter_type.pro_bono` / `billing_basis.pro_bono`):** Because individual work types carry no `chargeable` flag in tenant configuration, should Pro Bono matters still enforce the selected work type's `requireConflictCleared` / `requireCddComplete` rules (with a partner override allowed on overridable work types), or automatically waive CDD/engagement for `billing_basis.pro_bono`? *(Plan keeps work-type rules uniform — conflict cleared always sensible even pro bono, CDD overridable on advisory types — simplest and safest.)*
6. **High-ML-risk non-overridable list (`allowCddOverride: false`, `§4`):** Confirm the proposed list (`real_estate_and_property` + all 7 subcategories, Corporate `company_formations_and_structures` / `mergers_and_acquisitions` / `joint_ventures` / `due_diligence`, Private Client parent + `trusts_and_settlements` / `estate_administration` / `inheritance_tax_planning`, and `finance_and_banking` + all 6 subcategories) — and state whether `technology_and_digital_fintech_and_payments` should also have `allowCddOverride: false`.
7. **Matter number allocation timing on blocked high-risk openings (`§2`, `§8`):** When a fee earner submits a new High-risk matter that transitions to `Prospective` awaiting `high_risk_opening` Partner + Compliance approval, should its permanent matter number be allocated at submission (like `submit_referred` today so reviewers/approvers see a real matter number) or deferred until the final opening gate passes (`active`)? *(Plan proposes allocating at initial non-draft submission so the `high_risk_opening` register record, conflict review, and SharePoint folder naming have a stable reference, keeping B6 monotonicity.)*
8. **Custom register overrides in `public.tenant_module_configs['registers']` vs `high_risk_opening`:** Confirm that `high_risk_opening` transitions, roles, `mustDifferFromPreviousApprover`, and `allowAdminBypass: false` are **core-locked** (non-weakenable via Admin UI), matching ADR 0032's lock on self-approval.

---

## 14. Estimate (`3–4` days)

- **`S1-05` estimate: `3–4` days** (`0.5d` registers engine extensions & numbering domain, `0.5d` migration `0026` + repo + config schema, `1d` unified transactional gate across 4 paths + override permissions + two-tenant/concurrency tests, `1–1.5d` UI + Admin screens + Playwright E2E + Help).
- **Combined WP2 (`S1-04` + `S1-05`) total: `6.5–8` days**, fitting directly within the [stage-1-plan.md](../stage-1-plan.md) §5a estimate of **`6–8` days**.
- **Cut/move lever if `S1-05` trends above 4 days:** Keep Admin `matterNumbering` config schema + `client-not-a-law-firm/config/base.json` + server enforcement complete and tested in `S1-05`, and move the standalone interactive Admin pattern preview builder UI tab to a small follow-up (`0.5` day saved) while retaining Admin Work Types opening-gate toggles in `WorkTypesAdminPanel`.
