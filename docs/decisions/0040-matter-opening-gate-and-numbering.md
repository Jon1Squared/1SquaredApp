# ADR 0040: Work-Type Matter Opening Gate, Audited Overrides, and Configurable Matter Numbering

- **Date:** 2026-11-24
- **Status:** Proposed
- **Roadmap:** Stage 1 decisions `S1-D6`, `S1-D7`, `S1-D8`, `S1-D10`; Work Package 2 slice `S1-05` ([stage-1-plan.md](../roadmap/stage-1-plan.md)); backlog items `4` and `B6`
- **Builds on:** [ADR 0014](./0014-staff-matter-access-by-permission.md) (restricted matters), [ADR 0022](./0022-key-dates-and-limitation-module.md) (key dates opening gate), [ADR 0025](./0025-permission-enforcement-pattern.md) (permission enforcement), [ADR 0028](./0028-tenant-database-and-repositories.md) (tenant databases & repositories), [ADR 0032](./0032-registers-engine.md) (registers engine), [ADR 0034](./0034-fee-arrangements-and-caps.md) (work-type config overrides), [ADR 0039](./0039-registers-engine-extensions-cdd-high-risk.md) (high-risk opening & CDD registers)

## Context

In the current codebase (`develop` at `1093e45`), matter opening and matter numbering have four structural gaps that `S1-05` (decisions `S1-D6`, `S1-D7`, `S1-D8`) and downstream `S1-06` / `S1-08` depend on:

1. **Fragmented, out-of-transaction opening gate (`src/server/services.ts`):**
   - Matter opening can transition `prospective` → `active` in three distinct paths: `saveMatterRecord` (`:6067-8571`), `updateMatterConflictRecord` (`:9007-9451`, when a referred conflict is approved), and `signOffMatterCostsRecord` (`:9453-9900+`, when fee estimates are approved). `S1-05` adds a fourth opening trigger when a `high_risk_opening` register record completes final `compliance_approve`.
   - `runMatterOpeningGate` (`:5509-5672`) runs **outside** `withTenantTransaction` (`:7762`) and checks only extension hooks, Key Dates, and partner cost sign-off — not conflict clearance, client CDD, engagement letter signature, funds on account, or High-risk approval. Worse, lines `:5659-5660` treat `openGovernance === null` (when `enableMatterCostsGovernance` is disabled) as `allowProceed = false`.
2. **No audited override mechanism for opening pre-conditions (`S1-D6`):**
   - Owner decisions require configurable pre-conditions per work type (with firm-wide default `"not required"`), an explicit audited partner override with reason for overridable pre-conditions, and a hard block (`allowCddOverride: false`) against overriding CDD on conveyancing and other high money-laundering-risk work types.
3. **Concurrent approval / override / CDD race surface:**
   - Without unified in-transaction locking (`SELECT ... FOR UPDATE`), two concurrent requests (e.g., partner granting or revoking an override while a fee earner submits opening, or compliance approving a `high_risk_opening` record while client CDD expires or changes) can observe stale snapshots and open a non-compliant matter.
4. **Hardcoded matter number format tightly coupled to `matter_number_sequences.prefix` (`S1-D8`, `B6`):**
   - `generateMatterNumber` (`src/server/services.ts:5006-5026`) hardcodes client-derived prefix (`PEN001` / `MAT001`) and `TenantMatterRepository.allocateNextMatterNumber` (`core/src/tenancy/matterRepository.ts:714-768`) hardcodes `${cleanPrefix}-${String(nextNum).padStart(4, '0')}` (`PEN001-0005`), storing the rendered prefix itself in `matter_number_sequences(tenant_id, prefix)`.
   - `advanceMatterNumberHighWaterInTx` (`matterRepository.ts:877-896`) regex-parses `/^([A-Z0-9_-]+)-(\d+)$/i` from rendered `matter_number` strings, which breaks for configurable token patterns such as `{YYYY}/{DEPT}/{SEQ:4}` or `{CLIENT_REF}-{YY}-{SEQ:5}`.
   - Additionally, `saveMatterRecord` currently allocates a permanent matter number at `:6645-6657` **before** running validation/gate checks, burning sequence numbers on validation rejections (`R4`/`B6` clarification needed for blocked vs pending openings).

Because this establishes a platform-wide transactional gate invariant, an audited persistence table shared by WP2 and WP3 (`S1-06`, `S1-08`), and a schema/sequence-key boundary on `public.matters`, it is structural and requires this ADR before `S1-05` coding starts (`CLAUDE.md`).

## Decision

### 1. Per-work-type opening pre-conditions (two-level configuration resolution)
- Extend `WorkTypesConfigSchema` (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `core/src/api/index.ts`) and `tenant_module_configs['work_type_configs']` additively with an optional `openingGate` block on `workTypes.defaults` and each `workTypes.items[]`:
  ```ts
  export interface WorkTypeOpeningGateConfig {
    readonly requireConflictCleared?: boolean;
    readonly requireCddComplete?: boolean;
    readonly allowCddOverride?: boolean;
    readonly requireEngagementSigned?: boolean;
    readonly requireFundsOnAccount?: boolean;
  }
  ```
- **Firm-wide core defaults (`S1-D6`):** Every pre-condition boolean defaults to **`false`** (`"not required"`), and `allowCddOverride` defaults to **`true`**. Tenants opt in per work type via `client-<slug>/config/base.json` (demo defaults listed in `S1-05`) and runtime **Administration → Work Types** (`saveWorkTypesConfigAction`, requiring `admin:access` + `mfaVerified === true`).
- **Resolution order (`resolveWorkTypeOpeningGate(config, { workTypeSubcategoryId, practiceAreaId })`):**
  1. Subcategory override in `workTypes.items[]` (per-property inheritance when defined),
  2. Parent practice area entry in `workTypes.items[]` (when present),
  3. `workTypes.defaults.openingGate`,
  4. Core fallback (all pre-conditions `false`, `allowCddOverride: true`).
- **High-risk approval invariant (`S1-D7`):** Whenever the server-derived `matter.riskRatingId` matches `isHighOrCriticalRiskRating` (`risk_rating` `systemKey` `'high'` or `'critical'`, `src/domain/matterOpeningRecord.ts:856-869`), **High-risk opening approval (`high_risk_opening` register record in state `'approved'`) is ALWAYS required before the matter transitions to active**, regardless of work-type settings, and cannot be disabled or overridden.
- **Pre-condition evaluation semantics (`WP2` + forward `WP3` compatibility):**
  - `requireConflictCleared`: satisfied only when `matter.conflictCheckRecord?.status === 'Approved'` (explicitly excluding `'Draft'`, `'Pending'`, and `'Rejected'`).
  - `requireCddComplete`: satisfied only when **every** client (`clientId` + `additionalClientIds`) has an active, non-expired `cdd` register record in state `'recorded'` (or `'approved'` if tenant configures CDD review) with `riskTier` at least matching the matter's risk tier (`standard` satisfies `low`/`medium`; `high` required when matter or client risk is `high`/`critical`/`sensitive`).
  - `requireEngagementSigned`: before `S1-06` ships the engagement-letter outbox/signature workflow, satisfied when `Boolean(matter.engagementLetterSignedAt) || matter.engagementLetterStatus === 'Signed' || matter.engagementLetterStatus === 'Signed & returned'` (`src/components/MatterProfileClient.tsx:246-249`, `src/domain/matterOpeningRecord.ts:940-942`), ignoring empty or `'Drafting' | 'Drafted' | 'Sent' | 'Sent to client'`. Once `S1-06` lands, `S1-06` replaces/backs this with the verified `ESignatureEnvelopeRecord` outcome without changing the config key or gate interface.
  - `requireFundsOnAccount`: key is defined, schema-validated, and checked read-only by the evaluator in `S1-05` (defaulting `false` everywhere in demo config, and returning `{ satisfied: false, reasonCode: 'FUNDS_ON_ACCOUNT_NOT_CONFIGURED_FOR_S1_08' }` unless satisfied once `S1-08` wires receipt matching). Leaving it `false` in `S1-05` demo config keeps every demo work type openable while establishing the configuration schema.

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
  Plus partial unique index `uq_matter_opening_gate_overrides_active ON public.matter_opening_gate_overrides (tenant_id, matter_id, precondition_key) WHERE revoked_at IS NULL` so each precondition has at most one active override at a time.
- **Permission & strict non-admin/role boundary:**
  - Introduce permission `'matter:opening_gate:override'` (`sensitivity: 'restricted'`, `requiresMfa: false`), granted by default **only** to `'partner'` and `'managing_partner'` (`HomeRoleKey`) — explicitly **excluded from `'admin'`**, `'risk_compliance'`, `'fee_earner'`, and `'supervisor'`.
  - Authoritative actor check also verifies matter visibility (`canAccessMatter`) before granting or revoking an override.
- **Hard override prohibitions (fail closed with `OPENING_GATE_OVERRIDE_FORBIDDEN`):**
  - `cdd_complete` cannot be overridden whenever the resolved work type sets `allowCddOverride === false` (conveyancing and high money-laundering risk work types).
  - `high_risk_approval` is not even in the `precondition_key` enum and can never be overridden.
  - A formally `'Rejected'` conflict check (`matter.conflictCheckRecord?.status === 'Rejected'`) cannot be overridden (only uncompleted `'Pending'`/`'Draft'` checks may be overridden if policy permits; rejected conflicts must be resolved through conflict review).
- **Same-transaction audit:** Granting or revoking an override runs inside `withTenantTransaction` over `SELECT ... FROM public.matters ... FOR UPDATE`, checks `expectedRowVersion`, bumps `matters.row_version`, inserts/updates `matter_opening_gate_overrides`, and writes an immutable `audit_entries` record containing `matterId`, `preconditionKey`, actor, correlation ID, and reason (never client secrets/personal data). Overrides apply strictly to that matter (`matter_id`), never across matters.

### 3. In-transaction re-checking and lock ordering (`evaluateAndEnforceOpeningGateInTx`)
- Extract a single core-integrated service helper `evaluateAndEnforceOpeningGateInTx(tx, ctx, { matter, actorId, actorPermissions, preHooksResult, expectedWorkTypeConfig })` invoked inside `withTenantTransaction` at the opening commit point of **all four** matter-opening paths:
  1. `saveMatterRecord` (when `nextStatus` transitions out of `prospective`/`draft`-like to open/active),
  2. `updateMatterConflictRecord` (when conflict decision `'Approved'` unblocks opening),
  3. `signOffMatterCostsRecord` (when partner cost sign-off completes and all other conditions are met),
  4. `transitionRegisterRecordService` on `high_risk_opening` `compliance_approve` (when compliance approval completes and all remaining conditions are met).
- **Transaction boundary split (preserving `R490`):**
  - Extension pre-hooks (`beforeMatterOpen` for governance/extensions) and Key Dates preview stay **outside** the PostgreSQL write transaction (`no DB lock held during extension timeout`). Note: fix `runMatterOpeningGate` (`src/server/services.ts:5659-5660`) so an unconfigured/disabled `nalf-matter-costs-governance` extension (`openGovernance === null`) does not force `allowProceed = false`.
  - Every database-backed gate check (matter conflict status + work type + `risk_rating_id`, resolved `work_type_configs`, active `cdd` register records for all primary/additional clients, active `high_risk_opening` register record, `matter_opening_gate_overrides`, engagement status, funds on account when enabled in `S1-08`, and Key Dates mandatory opening rule) is **re-read and evaluated inside `withTenantTransaction`**.
- **Deadlock-free locking discipline (`READ COMMITTED`):**
  1. Lock target matter row first: `SELECT * FROM public.matters WHERE tenant_id = $1 AND id = $2 FOR UPDATE` (verify `row_version`).
  2. Lock relevant `public.register_records` in deterministic `(register_type_key, id)` ascending order (`FOR UPDATE` when transitioning `high_risk_opening` or creating it; `FOR SHARE` on `cdd` client records so concurrent CDD expiry/fail modifications serialise cleanly).
  3. Read `public.matter_opening_gate_overrides WHERE tenant_id = $1 AND matter_id = $2 AND revoked_at IS NULL FOR UPDATE`.
  4. Read `public.tenant_module_configs` (`work_type_configs`, `registers`).
  - If any required check is unsatisfied and lacks a valid active override, the opening transition either leaves/creates the matter in `'prospective'` (`status_id` prospective/pending opening) cleanly with explicit blocking reasons + raises/links the `high_risk_opening` register record when High-risk is required, or rejects an explicit direct `"open now"` call with structured gate errors (`MATTER_OPENING_GATE_BLOCKED`). No partial active matter can ever commit while a check fails concurrently.

### 4. Configurable token-based matter number format & decoupled sequence keys (`S1-D8`, `B6`)
- **Configuration (`TenantConfiguration.matterNumbering`, overridable via `public.tenant_module_configs['matter_numbering']`):**
  ```ts
  export type MatterNumberSequenceScope =
    | 'firm'
    | 'year'
    | 'department'
    | 'work_type'
    | 'client'
    | 'entity';

  export interface MatterNumberingConfiguration {
    readonly pattern: string;                    // default: '{CLIENT_REF}-{SEQ:4}'
    readonly sequenceScope: MatterNumberSequenceScope; // default: 'client'
    readonly emptyTokenFallback: string;         // default: 'MAT'
    readonly previewSampleClientRef?: string;    // optional preview helper default
  }
  ```
- **Default parity invariant (owner decision 5):**
  - Default `pattern = "{CLIENT_REF}-{SEQ:4}"` and `sequenceScope = "client"`.
  - `{CLIENT_REF}` resolves identically to today's `generateMatterNumber` (`src/server/services.ts:5006-5026`): `org.clientReference.trim().toUpperCase()`, else `org.legalName` first 3 A–Z chars (padded with `'X'`) + `'001'`, else `person.surname` first 3 A–Z chars (padded with `'X'`) + `'001'`, else `'MAT001'`, sanitised via `[^A-Z0-9_-]`.
  - Therefore, with default settings, newly opened matters render **byte-for-byte identical numbers** to today (e.g. `PEN001-0005`, `MAT001-0001`).
- **Allowed tokens and validation (`core/src/domain/matterNumbering/index.ts`, strict Zod + runtime guard):**
  - `{CLIENT_REF}`: client reference token (same derivation as above; fallback `{emptyTokenFallback}` + `001` or `MAT001`).
  - `{SEQ}` or `{SEQ:N}` (`1 <= N <= 8`): zero-padded monotonic sequence integer (`{SEQ}` unpadded if no width, `{SEQ:4}` 4+ digits preserving overflow cleanly e.g. `10000`). **Exactly one** `{SEQ...}` token is mandatory in `pattern`.
  - `{YYYY}`: 4-digit year in tenant timezone (`tenantConfig.timeZone || 'Europe/London'`).
  - `{YY}`: 2-digit year in tenant timezone.
  - `{DEPT}`: department code/short key (derived from `departmentId` or practice area's department sanitised uppercase alphanumeric, fallback `emptyTokenFallback`).
  - `{WORK_TYPE}`: work type / practice area short code (sanitised uppercase key, fallback `emptyTokenFallback`).
  - `{ENTITY}`: legal entity short code (`entityId` sanitised uppercase key, fallback `emptyTokenFallback`).
  - Allowed literal separators: `-`, `/`, `.`, `_` and uppercase ASCII `A-Z0-9`; maximum rendered length `64`; rejects empty tokens (`{}`), unknown tokens, consecutive separators, and directory traversal (`..`).
- **Sequence key separation (`B6` monotonicity):**
  - The counter row key in `public.matter_number_sequences(tenant_id, prefix)` is computed solely from **`sequenceScope`** + structural date/scope inputs (NOT by parsing the rendered `matter_number`):
    - `'client'` → `{CLIENT_REF}` (matches existing `PEN001`, `MAT001` rows in `public.matter_number_sequences` directly with **zero data reset**!);
    - `'firm'` → `'FIRM'`;
    - `'year'` → `'YR:' + YYYY`;
    - `'department'` → `'DEPT:' + deptCode`;
    - `'work_type'` → `'WT:' + workTypeCode`;
    - `'entity'` → `'ENT:' + entityCode`.
  - Allocation still runs inside `this.withAutonomousTenantTransaction(ctx, ...)` (`core/src/tenancy/matterRepository.ts:724`) so rolled-back outer transactions, deleted matters, or `resetAllDemoData` (`resetMatterNumberSequences` unset) **never** roll back or reuse an allocated sequence integer (`B6`).
  - Persist `number_sequence_key TEXT NULL` and `number_sequence_value BIGINT NULL` on `public.matters` (migration `0026`), plus partial unique index `uq_matters_tenant_matter_number_non_draft ON public.matters (tenant_id, matter_number) WHERE matter_number <> '' AND matter_number <> 'DRAFT'`.
  - `allocateNextMatterNumber` computes `maxExisting` using `WHERE tenant_id = $1 AND number_sequence_key = $2` (`MAX(number_sequence_value)`), unified cleanly with legacy regex `MAX` fallback for rows created prior to `0026` under `'client'` scope (`~ '^' || prefix || '-[0-9]+$'`). `advanceMatterNumberHighWaterInTx` prefers explicit `(numberSequenceKey, numberSequenceValue)` on the `Matter` record, falling back to legacy regex only when absent on imports.
  - Changing `matterNumbering.pattern` or `sequenceScope` applies **strictly to newly numbered matters**; existing `matters.matter_number` values are immutable once assigned (`MATTER_NUMBER_IMMUTABLE` guard on existing non-draft matters).
  - Number allocation moves **after** input/conflict/gate readiness validation (except when saving a `submit_referred` conflict review which legitimately persists a numbered `prospective` matter awaiting review — and even then, if an existing non-draft matter already has a number, keep it unchanged).

### 5. Behaviour across both hosting models (Rule 6)
- **Model A (`single_tenant`):** Single tenant database stores `public.matter_opening_gate_overrides`, `public.tenant_module_configs['work_type_configs']`, `public.tenant_module_configs['matter_numbering']`, `public.matter_number_sequences`, and `public.matters`. Every override, gate evaluation, and number allocation still checks verified `TenantContext` (`SET LOCAL ROLE`).
- **Model B (`multi_tenant`):** Every tenant database has independent `workTypes.openingGate`, `matterNumbering`, `matter_opening_gate_overrides`, and `matter_number_sequences`. Pattern changes, partner overrides, and high-risk approvals in tenant Alpha have zero effect on tenant Bravo, enforced via `SET LOCAL ROLE`, `assertRowTenant`, and two-tenant PostgreSQL tests (`core/tests/opening-gate-numbering-s105.test.ts`).

## Alternatives Considered

1. **Handle high-risk opening purely with a boolean flag on `matters` instead of `high_risk_opening` register type:** Rejected (`S1-D7`). Using the extended registers engine (`ADR 0039`) provides multi-stage workflow states, transition logs, distinct-approver locking, scheduled reminders (`register-reminders`), and unified compliance reporting.
2. **Parse `{SEQ}` dynamically back out of existing `matters.matter_number` on every allocation:** Rejected (`S1-D8`). Configurable multi-token formats (`{YYYY}/{DEPT}/{SEQ:4}`, `/` separators, changing patterns mid-year) make regex parsing ambiguous and fragile; storing `(number_sequence_key, number_sequence_value)` on `public.matters` guarantees exact `B6` monotonicity across pattern changes without modifying historical `matter_number` values.
3. **Allow `admin` to grant opening gate overrides or sign off high-risk matters:** Rejected by owner decision 3 (24 November 2026); compliance overrides and high-risk approvals belong strictly to practising partners (`partner`, `managing_partner`) and Risk & Compliance (`risk_compliance`).

## Consequences

- Every matter opening path in the platform converges on one transactional gate evaluator (`evaluateAndEnforceOpeningGateInTx`) inside `withTenantTransaction`, closing TOCTOU gaps across `saveMatterRecord`, conflict clearance, partner cost sign-off, and compliance sign-off.
- `S1-06` (`requireEngagementSigned` backed by uploaded signed client care copy) and `S1-08` (`requireFundsOnAccount` backed by pence ledger receipts) plug directly into `evaluateAndEnforceOpeningGateInTx` without redefining `WorkTypesConfigSchema` or `matter_opening_gate_overrides`.
- Requires reversible expand migration `0026_opening_gate_overrides_and_numbering_expand` (`CORE_REQUIRED_SCHEMA_VERSION = '0026'`) and two-tenant PostgreSQL + concurrency + tampered-ID tests.
