# ADR 0040: Work-Type Matter Opening Gate, Audited Overrides, and Configurable Matter Numbering

- **Date:** 2026-11-24
- **Status:** Accepted (owner, 24 Nov 2026)
- **Amended 26 Nov 2026 (R810/R811, owner-confirmed):** Gate-cleared openings now go to `active` on every path. They previously went to `cmi_incomplete` on `saveMatterRecord` and `openProspectiveMatterRecord`. When the gate opens a matter, it also records the client due diligence outcome on the matter (`Verified`, `Overridden` or `Not required`).
- **Roadmap:** Stage 1 decisions `S1-D6`, `S1-D7`, `S1-D8`, `S1-D10`; Work Package 2 slice `S1-05` ([stage-1-plan.md](../roadmap/stage-1-plan.md)); backlog items `4` and `B6`
- **Builds on:** [ADR 0014](./0014-staff-matter-access-by-permission.md) (restricted matters), [ADR 0022](./0022-key-dates-and-limitation-module.md) (key dates opening gate), [ADR 0025](./0025-permission-enforcement-pattern.md) (permission enforcement), [ADR 0028](./0028-tenant-database-and-repositories.md) (tenant databases & repositories), [ADR 0032](./0032-registers-engine.md) (registers engine), [ADR 0034](./0034-fee-arrangements-and-caps.md) (work-type config overrides), [ADR 0039](./0039-registers-engine-extensions-cdd-high-risk.md) (high-risk opening & CDD registers)

## Context

In the current codebase (`develop` at `1093e45`), matter opening and matter numbering have four structural gaps that `S1-05` (decisions `S1-D6`, `S1-D7`, `S1-D8`) and downstream `S1-06` / `S1-08` depend on:

1. **Fragmented, out-of-transaction opening paths & caller bypasses (`src/server/services.ts`):**
   - Matter creation and opening today span five paths: `saveMatterRecord` (`:6067-8571`, also invoked by enquiry conversion `prepareEnquiryConversion` and quote conversion `prepareQuoteConversionRecord`), `updateMatterConflictRecord` (`:9007-9451`, when a referred conflict is approved), `signOffMatterCostsRecord` (`:9453-9900+`, when fee estimates are signed off), `createRecordFromPms` (`:17011, 17363-17379`, PMS import directly to opened/closed states), and seed import (`importMatters`, `src/server/storePostgresImport.ts:460`), plus `S1-05`'s new `high_risk_opening` `compliance_approve` and explicit `"Open matter"` retry action.
   - `saveMatterRecord` (`resolveNextMatterStatusId`, `:5730-5779`) routes normal cleared openings to `cmi_incomplete` (`matterHasOpened` treats `cmi_incomplete`, `active`, and `on_hold` as opened), yet `submit_cleared` accepts **any** caller-supplied non-prospective `matterStatusId` (`:5773-5776`) — allowing a crafted payload to jump straight to `active` or `closed`.
   - `runMatterOpeningGate` (`:5509-5672`) runs **outside** `withTenantTransaction` (`:7762`), checks only extension hooks, Key Dates, and partner cost sign-off (not conflict clearance, CDD, engagement, funds, or High-risk approval), and `:5659-5660` treat `openGovernance === null` (when `enableMatterCostsGovernance` is disabled) as `allowProceed = false`. Meanwhile `updateMatterConflictRecord` (`:9276, 9317-9321`) trusts a stale stored `matterOpeningGate.allowProceed` snapshot instead of re-running the gate and pre-hooks.
2. **No audited override or tamper-resistant pre-`S1-06` engagement stamp (`S1-D6`, `R753`):**
   - Owner decisions require configurable pre-conditions per work type (firm-wide default `"not required"`), an explicit audited partner override with reason for overridable pre-conditions, and a hard block (`allowCddOverride: false`) on conveyancing and high ML risk work types.
   - Pre-`S1-06`, `engagementLetterStatus` is also a free picklist on `MatterFormClient.tsx` (`saveMatterRecord`), allowing self-certification of `"Signed"` without a server stamp or audit trail.
3. **Concurrent approval / override / CDD race surface & stale High-risk queues:**
   - Without unified in-transaction locking (`SELECT ... FOR UPDATE`), concurrent requests (e.g., partner granting/revoking an override while submitting opening, or Compliance approving `high_risk_opening` while CDD changes/expires) can observe stale snapshots. Also, there is currently no explicit `"Open matter"` action once a blocked prospective matter satisfies late-arriving CDD/overrides (`R751`).
4. **Hardcoded numbering coupled to prefix strings, caller `matterNumber`, & duplicate demo data (`S1-D8`, `B6`, `R744`, `R745`):**
   - `generateMatterNumber` (`src/server/services.ts:5006-5026`) derives a prefix from `org.clientReference` / name (e.g. `PEN001` / `HUG001`, which can be shared across a person and organisation with matching surnames/references) and `TenantMatterRepository.allocateNextMatterNumber` (`core/src/tenancy/matterRepository.ts:714-768`) hardcodes `${cleanPrefix}-${String(nextNum).padStart(4, '0')}`. `advanceMatterNumberHighWaterInTx` (`:877-896`) regex-parses `/^([A-Z0-9_-]+)-(\d+)$/i` from rendered strings, breaking multi-token patterns.
   - Worse, `saveMatterAction` / `saveMatterRecord` (`actions.ts:361-377`, `services.ts:6645-6657`) accept caller-supplied `matterNumber` on normal creates and allocate sequences *before* validation, while the seeded demo already contains duplicate active number `BRI001-0003` (`M-000007` and `M-000010` at `data/seed-not-a-law-firm.json:19417, 19795`), meaning adding a unique DB index now would fail existing tenant migrations.

Because this establishes a platform-wide transactional gate invariant, an audited persistence table shared by WP2 and WP3 (`S1-06`, `S1-08`), and a schema/sequence-key boundary on `public.matters`, it is structural and requires this ADR before `S1-05` coding starts (`CLAUDE.md`).

## Decision

### 1. Per-work-type opening pre-conditions (two-level configuration resolution)
- Extend `WorkTypesConfigSchema` (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `core/src/api/index.ts`) and `tenant_module_configs['work_type_configs']` additively with an optional `openingGate` block on `workTypes.defaults` and each `workTypes.items[]`:
  ```ts
  export interface WorkTypeOpeningGateConfig {
    readonly allowConflictOverride?: boolean;
    readonly requireCddComplete?: boolean;
    readonly allowCddOverride?: boolean;
    readonly requireEngagementSigned?: boolean;
    readonly requireFundsOnAccount?: boolean;
  }
  ```
- **Firm-wide core defaults (`S1-D6`):** Every pre-condition requirement boolean defaults to **`false`** (`"not required"`), while `allowConflictOverride` and `allowCddOverride` default to **`true`**. Tenants configure work types via `client-<slug>/config/base.json` and runtime **Administration → Work Types** (`saveWorkTypesConfigAction`, requiring `admin:access` + `mfaVerified === true`). Per owner decision 5 (24 November 2026), Pro Bono (`billing_basis.pro_bono` / `matter_type.pro_bono`) receives **no automatic exemption** — the selected work type's rules apply uniformly (with partner override where allowed).
- **Resolution order (`resolveWorkTypeOpeningGate(config, { workTypeSubcategoryId, practiceAreaId })`):**
  1. Subcategory override in `workTypes.items[]` (per-property inheritance when defined),
  2. Parent practice area entry in `workTypes.items[]` (when present),
  3. `workTypes.defaults.openingGate`,
  4. Core fallback (`require*` flags `false`, `allowConflictOverride: true`, `allowCddOverride: true`).
- **High-risk approval invariant (`S1-D7`, `R749`):** Whenever the server-derived `matter.riskRatingId` matches `isHighOrCriticalRiskRating` (`risk_rating` `systemKey` `'high'` or `'critical'`, `src/domain/matterOpeningRecord.ts:856-869`), **High-risk opening approval (`high_risk_opening` register record in state `'approved'`) is ALWAYS required before opening**, regardless of work-type settings, and cannot be disabled or overridden. Note explicitly (`R749`): `risk_rating.sensitive` maps to the `high` CDD tier in `S1-04`, **not** `high_risk_opening` (only `'high'` and `'critical'` trigger two-stage `high_risk_opening`).
- **Pre-condition evaluation semantics (`WP2` + forward `WP3` compatibility):**
  - Conflict readiness (`R740`, `R761`, `R794`): Conflict readiness is always evaluated using real `ConflictCheckStatusPill` statuses (`src/domain/types.ts:839-845`: `'Not started' | 'In progress' | 'Cleared' | 'Referred' | 'Approved' | 'Declined'`). Satisfied by **`'Cleared'` or `'Approved'`** (with no unapproved restricted matches); unmet for `'Not started'`, `'In progress'`, `'Referred'`, and `'Declined'` (or absent check). `allowConflictOverride` controls whether `'Not started'` or `'In progress'` checks may be overridden by a partner for that work type.
  - `requireCddComplete` (`R749` & Owner Answer 2): satisfied only when **every** client (`clientId` + `additionalClientIds`) holds an active, non-expired `cdd` register record in state `'recorded'` (no separate CDD approval step) with `riskTier` at least matching the client's required tier — defined as the **maximum** of the client's own risk rating (`Organisation.riskRatingId`, since `Person` has no `riskRatingId`) and any of that client's currently opening matters (`'standard'` suffices for `'low'`/`'medium'`; `'high'` required for `'high'`/`'critical'`/`'sensitive'`; Standard → High upgrade appends high-risk items onto the existing record and moves it back to `'in_progress'` until recorded).
  - `requireEngagementSigned` (`R753` pre-`S1-06` hardening): before `S1-06` ships uploaded signed client care letters, satisfied when `Boolean(matter.engagementLetterSignedAt) || matter.engagementLetterStatus === 'Signed' || matter.engagementLetterStatus === 'Signed & returned'` (`MatterProfileClient.tsx:246-249`, `matterOpeningRecord.ts:940-942`), ignoring empty or `'Drafting' | 'Drafted' | 'Sent' | 'Sent to client'`. Close the self-certification hole now (`R753`): refuse/ignore `'Signed'` and `'Signed & returned'` in `saveMatterRecord` / `MatterFormClient`'s free picklist and set them solely via a dedicated guarded server action (`recordEngagementLetterSignedAction`, `matter:edit`) that server-stamps `engagementLetterSignedAt`, actor, and an immutable audit entry. `S1-06` later backs this with uploaded signed copy / `ESignatureEnvelopeRecord`.
  - `requireFundsOnAccount`: key is defined, schema-validated, and checked read-only by the evaluator in `S1-05` (defaulting `false` everywhere in demo config, and returning `{ satisfied: false, reasonCode: 'FUNDS_ON_ACCOUNT_NOT_CONFIGURED_FOR_S1_08' }` unless satisfied once `S1-08` wires receipt matching).

### 2. Audited override model (`public.matter_opening_gate_overrides`)
- **Table (`0026_opening_gate_overrides_and_numbering_expand`):**
  ```sql
  CREATE TABLE IF NOT EXISTS public.matter_opening_gate_overrides (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    matter_id TEXT NOT NULL,
    precondition_key TEXT NOT NULL CHECK (
      precondition_key IN ('conflict_cleared', 'cdd_complete', 'engagement_signed', 'funds_on_account')
    ),
    reason TEXT NOT NULL CHECK (char_length(btrim(reason)) >= 10),
    overridden_by_person_id TEXT NOT NULL,
    overridden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_by_person_id TEXT NULL,
    revoked_at TIMESTAMPTZ NULL,
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, matter_id) REFERENCES public.matters (tenant_id, id) ON DELETE CASCADE
  );
  ```
  Plus partial unique index `uq_matter_opening_gate_overrides_active ON public.matter_opening_gate_overrides (tenant_id, matter_id, precondition_key) WHERE revoked_at IS NULL` so each precondition has at most one active override at a time. (Cluster default privileges cover new tables automatically for `<runtimeRole>` — no explicit `GRANT` needed.)
- **Permission & strict non-admin/role boundary:**
  - Introduce permission `'matter:opening_gate:override'` (`sensitivity: 'restricted'`, `requiresMfa: false`), granted by default **only** to `'partner'` and `'managing_partner'` (`HomeRoleKey`) — explicitly **excluded from `'admin'`** (`DEFAULT_RBAC_ROLES.admin.permissions` at `core/src/domain/rbac/registry.ts:859-861` filters out `'matter:opening_gate:override'` alongside `'undertaking:manage'`), `'risk_compliance'`, `'fee_earner'`, and `'supervisor'`.
  - Authoritative actor check also verifies matter visibility (`canAccessMatter`) before granting or revoking an override.
- **Hard override prohibitions (fail closed with `OPENING_GATE_OVERRIDE_FORBIDDEN`):**
  - `cdd_complete` cannot be overridden whenever the resolved work type sets `allowCddOverride === false` (conveyancing and high money-laundering risk work types — 23 confirmed demo work types; Fintech stays overridable).
  - `high_risk_approval` is not in the `precondition_key` enum and can never be overridden.
  - Conflict checks in status **`'Declined'`** or **`'Referred'`** (`matter.conflictCheckRecord?.status`) can **never** be overridden (`R740` — declined conflicts are final rejections, and referred conflicts must go through conflict review rather than a partner override); `'Not started'` or `'In progress'` conflict checks may only be overridden when the work type's resolved `allowConflictOverride` setting is `true` (`R794`).
- **Same-transaction audit:** Granting or revoking an override runs inside `withTenantTransaction` over `SELECT ... FROM public.matters ... FOR UPDATE`, checks `expectedRowVersion`, bumps `matters.row_version`, inserts/updates `matter_opening_gate_overrides`, and writes an immutable `audit_entries` record containing `matterId`, `preconditionKey`, actor, correlation ID, and reason (never client secrets/personal data). Overrides apply strictly to that matter (`matter_id`), never across matters — and granting an override **never opens the matter by itself** (`R751`); the user clicks **Open matter** (`openProspectiveMatterAction`) afterwards.

### 3. Opening definition, complete path inventory & `evaluateAndEnforceOpeningGateInTx` (`R741`, `R742`, `R751`)
- **Definition of "opening" (`R741`):**
  - Opening is strictly **the first transition out of `prospective` or draft-like (`matterHasOpened === false`, `src/server/services.ts:5730-5742`) into any opened status (`cmi_incomplete`, `active`, or `on_hold`)**.
  - **Server-owned status on first opening (`R810`/`R811`):** On first opening, the server always moves the matter to **`active`** on all five gated paths (`saveMatterRecord`, `openProspectiveMatterRecord`, `updateMatterConflictRecord`, `signOffMatterCostsRecord`, `high_risk_opening` `compliance_approve`), records the client due diligence outcome (`Verified`, `Overridden`, or `Not required`) before building the opening snapshot, and **ignores any caller-supplied `input.matterStatusId`** from `saveMatterAction` or external callers (closing the `resolveNextMatterStatusId` bypass at `services.ts:5773-5776` where crafted `submit_cleared` payloads could jump directly to `active` or `closed`). Only internal `source === 'pms_import'` calls from `createRecordFromPms` may supply initial `input.matterStatusId` / `input.matterNumber`.
  - Where `cmi_incomplete` stays:
    - as the status for PMS-imported matters;
    - for legacy matters;
    - as a status that can still be chosen between already-opened statuses (`active` → `cmi_incomplete` → `active`), which isn't an opening and isn't gated.
  - Subsequent transitions between already-opened statuses (`active` → `cmi_incomplete` → `active`, `active` → `on_hold`) and reopening from `closed` (`updateMatterLifecycleStatusRecord`, `:25916-25970`) are **not openings** and are **not gated**.
- **Complete inventory of matter creation / opening paths (`R742`, `R751`):**
  1. `saveMatterRecord` (also called by enquiry conversion `prepareEnquiryConversion` and quote conversion `prepareQuoteConversionRecord` — neither conversion path is separate),
  2. Dedicated **"Open matter"** retry action (`openProspectiveMatterAction` / `openProspectiveMatterRecord`, `matter:edit`) so previously blocked `prospective` matters can be opened cleanly once late CDD, engagement, or overrides arrive (`granting an override never opens the matter by itself`),
  3. `updateMatterConflictRecord` (`Approved` conflict review): **must re-run outside-TX `beforeMatterOpen` extension pre-hooks** before entering `withTenantTransaction` and then invoke `evaluateAndEnforceOpeningGateInTx` (never trusting stale stored `matterOpeningGate.allowProceed` at `:9276, :9317-9321`),
  4. `signOffMatterCostsRecord` (partner fee sign-off): runs outside-TX pre-hooks then `evaluateAndEnforceOpeningGateInTx`,
  5. `transitionRegisterRecordService` on `high_risk_opening` `compliance_approve`: runs outside-TX pre-hooks before the transition TX, commits `'approved'`, and invokes `evaluateAndEnforceOpeningGateInTx` in the same TX (opening if all remaining conditions are met, or returning clear remaining blockers cleanly),
  6. **PMS import (`createRecordFromPms`, `services.ts:17011, 17363-17379`, owner-confirmed):** **exempt** from the opening gate (brings in pre-existing firm matters); `createRecordFromPms` calls `saveMatterRecord(..., { byId, source: 'pms_import' })` (the sole internal caller allowed to pass `input.matterStatusId` / `input.matterNumber`), enforces its existing permissions (`finance:manage_links` + `admin:access` + `mfaVerified: true` at `services.ts:17049-17075` plus `matter:create` inside `saveMatterRecord`), and writes a mandatory audit entry `"Opened by PMS import; opening gate not applied"`,
  7. **Demo seed import and reset (`importMatters`, `src/server/storePostgresImport.ts:460`):** **exempt** (non-live test/demo seed loading),
  8. **Reopen from closed (`updateMatterLifecycleStatusRecord`, `:25916-25970`):** **not an opening** (ungated).
- **Transaction boundary split (preserving `R490`):**
  - Extension pre-hooks (`beforeMatterOpen` for governance/extensions) and Key Dates preview run **outside** `withTenantTransaction` (`no DB lock held during extension timeout`) across all gated opening paths (#1–#5 above). Fix `runMatterOpeningGate` (`src/server/services.ts:5659-5660`) so an unconfigured/disabled `nalf-matter-costs-governance` extension (`openGovernance === null`) does not force `allowProceed = false`.
  - Every database-backed gate check (matter conflict status + work type + `risk_rating_id`, resolved `work_type_configs`, active `cdd` register records for all primary/additional clients, active `high_risk_opening` register record, `matter_opening_gate_overrides`, engagement status, funds on account when enabled in `S1-08`, and Key Dates mandatory opening rule) is **re-read and evaluated inside `withTenantTransaction`**.
- **Deadlock-free locking discipline (`READ COMMITTED`):**
  1. Lock target matter row first: `SELECT * FROM public.matters WHERE tenant_id = $1 AND id = $2 FOR UPDATE` (verify `row_version`).
  2. Lock relevant `public.register_records` in deterministic `(register_type_key, id)` ascending order (`FOR UPDATE` when transitioning `high_risk_opening` or creating it; `FOR SHARE` on `cdd` client records so concurrent CDD expiry/fail modifications serialise cleanly).
  3. Read `public.matter_opening_gate_overrides WHERE tenant_id = $1 AND matter_id = $2 AND revoked_at IS NULL FOR UPDATE`.
  4. Read `public.tenant_module_configs` (`work_type_configs`, `registers`).
  - If any required check is unsatisfied and lacks a valid active override, `saveMatterRecord` leaves/creates the matter in `'prospective'` with explicit blocking reasons + creates/links the `high_risk_opening` register record when High/Critical, while explicit `openProspectiveMatterAction` rejects opening cleanly with structured gate errors (`MATTER_OPENING_GATE_BLOCKED`). No partial opened matter can ever commit while a check fails concurrently.

### 4. Configurable token-based matter number format & decoupled sequence keys (`S1-D8`, `B6`, `R744`, `R745`, `R760`)
- **Configuration (`TenantConfiguration.matterNumbering`, overridable via `public.tenant_module_configs['matter_numbering']`):**
  ```ts
  export type MatterNumberSequenceScope =
    | 'client_ref_prefix'
    | 'firm'
    | 'year'
    | 'department';

  export interface MatterNumberingConfiguration {
    readonly pattern: string;                    // default: '{CLIENT_REF}-{SEQ:4}'
    readonly sequenceScope: MatterNumberSequenceScope; // default: 'client_ref_prefix'
    readonly emptyTokenFallback: string;         // default: 'MAT'
    readonly previewSampleClientRef?: string;    // optional preview helper default
  }
  ```
  *(Per `R760` Lever 3 to keep WP2 within the 6–8 day budget, WP2 `S1-05` ships the core five tokens `{CLIENT_REF}`, `{SEQ}`, `{SEQ:N}`, `{YYYY}`, `{YY}`, and `{DEPT}` with scopes `'client_ref_prefix' | 'firm' | 'year' | 'department'`. Additional tokens `{WORK_TYPE}` / `{ENTITY}` remain additive future extensions under Rule 7.)*
- **Default parity & `client_ref_prefix` edge cases (`R745`, owner decision 5):**
  - Default `pattern = "{CLIENT_REF}-{SEQ:4}"` and `sequenceScope = "client_ref_prefix"` (named explicitly to reflect today's shared cleaned-prefix behaviour — an organisation and an individual person such as `Hughes Lloyd Accountants LLP` and `P-000013` can share `HUG001`).
  - `{CLIENT_REF}` resolves using **exact legacy cleaning** (`replace(/[^A-Z0-9_-]/g, '')` → empty becomes `'MAT001'`, `core/src/tenancy/matterRepository.ts:718-722`), distinct from custom pattern-literal allowed characters (`-`, `/`, `.`, `_`).
  - The 64-character rendered maximum applies **strictly to non-default custom patterns** so long client references remain byte-for-byte identical under `{CLIENT_REF}-{SEQ:4}`.
  - With default settings, newly numbered matters render **byte-for-byte identical numbers** to today (e.g. `PEN001-0005`, `MAT001-0001`).
- **Allowed tokens and validation (`core/src/domain/matterNumbering/index.ts`, strict Zod + runtime guard):**
  - `{CLIENT_REF}`: client reference token (exact legacy derivation and cleaning above, empty fallback `'MAT001'`).
  - `{SEQ}` or `{SEQ:N}` (`1 <= N <= 8`): zero-padded monotonic sequence integer (`{SEQ}` unpadded if no width, `{SEQ:4}` 4+ digits preserving overflow cleanly e.g. `10000`). **Exactly one** `{SEQ...}` token is mandatory in `pattern`.
  - `{YYYY}`: 4-digit year in tenant timezone (`tenantConfig.timeZone || 'Europe/London'`).
  - `{YY}`: 2-digit year in tenant timezone.
  - `{DEPT}`: department code/short key (derived from `departmentId` or practice area's department sanitised uppercase alphanumeric, fallback `emptyTokenFallback`).
  - Allowed custom-pattern literal characters: uppercase ASCII `A-Z0-9` plus `-`, `/`, `.`, `_`; rejects empty tokens (`{}`), unknown tokens, consecutive separators, directory traversal (`..`), and custom rendered length `> 64`.
- **Sequence key separation, allocation timing & uniqueness boundaries (`B6`, `R744`, Owner Answer 7):**
  - The counter row key in `public.matter_number_sequences(tenant_id, prefix)` is computed solely from **`sequenceScope`** + structural date/scope inputs (NOT by parsing the rendered `matter_number`):
    - `'client_ref_prefix'` → `{CLIENT_REF}` (matches existing `PEN001`, `MAT001` rows in `public.matter_number_sequences` directly with **zero data reset**!);
    - `'firm'` → `'FIRM'`;
    - `'year'` → `'YR:' + YYYY`;
    - `'department'` → `'DEPT:' + deptCode`.
  - Allocation still runs inside `this.withAutonomousTenantTransaction(ctx, ...)` (`core/src/tenancy/matterRepository.ts:724`) so rolled-back outer transactions, deleted matters, or `resetAllDemoData` (`resetMatterNumberSequences` unset) **never** roll back or reuse an allocated sequence integer (`B6`).
  - Persist `number_sequence_key TEXT NULL` and `number_sequence_value BIGINT NULL` on `public.matters` (migration `0026`). **Do NOT add a unique index on `matter_number` in migration `0026`** (`R744`): the seeded demo dataset contains duplicate active number `BRI001-0003` (`M-000007` and `M-000010` at `data/seed-not-a-law-firm.json:19417, 19795`), existing numbers never change in place, so a migration unique index would fail the demo migrate job (`caj-migrate-demo`). Fix **`M-000007`** to `'BRI001-0001'` (matching its `PMSL-M-BRI001-0001` link while preserving `M-000010` = `'BRI001-0003'` asserted by `core/tests/rbac.test.ts:7003`) in seed data for fresh seeds only, and track a tenant duplicate-audit + unique constraint as a backlog item (`B29`, `S1-05` §11).
  - **Ignore caller-supplied `matterNumber` on normal saves (`R744`, `services.ts:6645-6657`, `actions.ts:361-377`):** `saveMatterRecord` ignores any client-provided `matterNumber` on normal creates/updates; only server allocation or `source: 'pms_import'` may supply a number. On PMS import (`createRecordFromPms`), check `existsMatterNumber` before accepting `pm.matter_code` and allocate a fresh number on a clash.
  - **Allocation timing (Owner Answer 7, 24 Nov 2026):** Allocate a permanent matter number at the **first non-draft submission, AFTER input validation passes** (so rejected validation saves never waste sequence integers; Referred and High-risk matters awaiting approval **do** receive their permanent number cleanly).
  - `allocateNextMatterNumber` computes `maxExisting` using `WHERE tenant_id = $1 AND number_sequence_key = $2` (`MAX(number_sequence_value)`), unified cleanly with legacy regex `MAX` fallback for rows created prior to `0026` under `'client_ref_prefix'` scope (`~ '^' || prefix || '-[0-9]+$'`). `advanceMatterNumberHighWaterInTx` prefers explicit `(numberSequenceKey, numberSequenceValue)` on the `Matter` record, falling back to legacy regex only when absent on imports. Existing `matters.matter_number` values remain immutable once assigned (`MATTER_NUMBER_IMMUTABLE` guard on existing non-draft matters).

### 5. Behaviour across both hosting models (Rule 6)
- **Model A (`single_tenant`):** Single tenant database stores `public.matter_opening_gate_overrides`, `public.tenant_module_configs['work_type_configs']`, `public.tenant_module_configs['matter_numbering']`, `public.matter_number_sequences`, and `public.matters`. Every override, gate evaluation, and number allocation still checks verified `TenantContext` (`SET LOCAL ROLE`).
- **Model B (`multi_tenant`):** Every tenant database has independent `workTypes.openingGate`, `matterNumbering`, `matter_opening_gate_overrides`, and `matter_number_sequences`. Pattern changes, partner overrides, and high-risk approvals in tenant Alpha have zero effect on tenant Bravo, enforced via `SET LOCAL ROLE`, `assertRowTenant`, and two-tenant PostgreSQL tests (`core/tests/opening-gate-numbering-s105.test.ts`).

## Alternatives Considered

1. **Handle high-risk opening purely with a boolean flag on `matters` instead of `high_risk_opening` register type:** Rejected (`S1-D7`). Using the extended registers engine (`ADR 0039`) provides multi-stage workflow states, transition logs, distinct-approver locking, scheduled reminders (`register-reminders`), and unified compliance reporting.
2. **Parse `{SEQ}` dynamically back out of existing `matters.matter_number` on every allocation:** Rejected (`S1-D8`). Configurable multi-token formats (`{YYYY}/{DEPT}/{SEQ:4}`, `/` separators, changing patterns mid-year) make regex parsing ambiguous and fragile; storing `(number_sequence_key, number_sequence_value)` on `public.matters` guarantees exact `B6` monotonicity across pattern changes without modifying historical `matter_number` values.
3. **Allow `admin` to grant opening gate overrides or sign off high-risk matters:** Rejected by owner decision 3 (24 November 2026); compliance overrides and high-risk approvals belong strictly to practising partners (`partner`, `managing_partner`) and Risk & Compliance (`risk_compliance`).

## Consequences

- Every matter opening path in the platform converges on one transactional gate evaluator (`evaluateAndEnforceOpeningGateInTx`) inside `withTenantTransaction` (with `createRecordFromPms` explicitly exempt and audited, `importMatters` exempt, and reopen/post-opening status moves ungated), closing TOCTOU and caller-bypass gaps across `saveMatterRecord`, `openProspectiveMatterRecord`, `updateMatterConflictRecord`, `signOffMatterCostsRecord`, and `high_risk_opening` `compliance_approve`.
- `S1-06` (`requireEngagementSigned` backed by uploaded signed client care copy) and `S1-08` (`requireFundsOnAccount` backed by pence ledger receipts) plug directly into `evaluateAndEnforceOpeningGateInTx` without redefining `WorkTypesConfigSchema` or `matter_opening_gate_overrides`.
- Requires reversible expand migration `0026_opening_gate_overrides_and_numbering_expand` (`CORE_REQUIRED_SCHEMA_VERSION = '0026'`) and two-tenant PostgreSQL + concurrency + tampered-ID + crafted-payload tests.
