# ADR 0034: Fee Arrangements, Negotiated Rate Precedence, CFA/DBA Caps and Money Handling

- **Date:** 2026-11-15
- **Status:** Proposed
- **Roadmap:** Stage 0 decision D10, slices S0-23 and S0-28 (`docs/roadmap/stage-0-plan.md`); backlog item 30
- **Builds on:** [ADR 0028](./0028-tenant-database-and-repositories.md) (tenant databases and repositories), S0-17c (catalogue and costs configuration in PostgreSQL), S0-22 (work-type configuration)

## Context

Backlog item 30 (*Rates and charging arrangements*) requires:
- configurable VAT rate (`matterCosts.vatRatePercent`) and deterministic money/VAT maths for quotes and matter costs (`S0-23`),
- immutable costs snapshots on matters and quotes so subsequent rate-card changes do not alter already-agreed snapshots (`S0-23`),
- client- and matter-level negotiated rate overrides with effective dates, overlap prevention, fixed precedence, and an audit trail (`S0-28`), and
- Conditional Fee Agreement (`CFA`) and Damages-Based Agreement (`DBA`) fee bases with statutory maximums, firm caps, and per-work-type cap overrides (`S0-28`).

At commit `6940cdc` on `develop`:
- `src/domain/matterCosts.ts:21-49, 318-380` supports only three work bases (`'hourly_rates' | 'fixed_fee' | 'capped'`) and looks up rates only from `MatterCostsConfig.rateCards` by practice area (`RC-DEFAULT`, `RC-CORP`, `RC-PROP`, `RC-EMP`, `RC-LIT`, `RC-PC`).
- Quotes (`src/domain/quotes.ts` and `src/domain/types.ts:1228-1336`) hard-code VAT at 20% (`0.2`) using floating-point arithmetic and support only `'Fixed fee' | 'Estimate' | 'Capped fee' | 'Hourly rate with estimate'`.
- `matterCosts.rateCards`, `matterCosts.disbursementPresets`, `matterCosts.rateSourceMode`, `matterCosts.allowMatterRateOverrides`, and `matterCosts.defaultPaymentOnAccount` in `core/schemas/tenant-config.schema.json` are marked `[x-reserved:S0-23]`.

On 12 November 2026, the product owner confirmed the CFA and DBA cap values and rules (`WP5-owner-decisions.md`), closing the stage plan §8 manual task *"Confirm the CFA and DBA cap values to use as configuration defaults"*.

## Decision

### 1. Money handling and VAT configuration (`S0-23` and `S0-28`)
- **Integer minor units (pence), never floating-point arithmetic:**
  - All monetary calculations (hourly rate multiplication, disbursement sums, VAT calculation, fee caps, CFA uplift calculations, and DBA damages shares) execute in integer minor units (pence, `1 GBP = 100 pence`) inside a single shared pure module (`core/src/domain/money/index.ts`, re-exported from `@platform/core-api` and consumed by `src/domain/matterCosts.ts` and `src/domain/quotes.ts`).
  - Conversion from GBP inputs (`poundsToMinorUnits`) parses fixed-decimal strings or finite numbers to integer pence using commercial half-up rounding (`Math.sign(x) * Math.floor(Math.abs(x) * 100 + 0.5 + 1e-9)`), and `minorUnitsToPounds` formats back to two decimal places (`number` / `string` for display and JSON serialization) only at the boundary.
- **Single rounding rule in one place:**
  - Percentage calculations (VAT, CFA success fee uplift, DBA payment share) multiply integer minor units by integer basis points (`1% = 100 bps`, e.g. `20% = 2000 bps`) and round to the nearest penny using **commercial half-up rounding** (`roundHalfUpFromBasisPoints(amountMinorUnits, basisPoints)`):
    $$\text{resultMinorUnits} = \left\lfloor \frac{\text{amountMinorUnits} \times \text{basisPoints} + 5000}{10000} \right\rfloor$$
  - Line-item VAT is rounded per taxable line item (legal fee ex-VAT and each VAT-applicable disbursement), and `totalIncVatMinorUnits = subtotalExVatMinorUnits + totalVatMinorUnits`.
- **Configurable VAT rate (`matterCosts.vatRatePercent`):**
  - `matterCosts.vatRatePercent` is added to `core/schemas/tenant-config.schema.json` and `MatterCostsConfig` with `type: 'number'`, `minimum: 0`, `maximum: 100`, `default: 20`, and description `'Standard UK VAT percentage applied to legal fees and taxable disbursements unless overridden on a line'`.
  - Quotes and matter costs snapshots record the `vatRatePercent` in force when the quote version or costs snapshot is created, and allow per-disbursement VAT applicability (`vatApplicable: boolean`) and explicit VAT amount override (`vatOverridden: boolean`).
- **Immutable costs snapshots:**
  - When a `MatterCostsSnapshot` or `QuoteVersionSnapshot` is saved, the resolved rates (`partnerRateGbp`, `associateRateGbp`, `traineeRateGbp`, `customGrades`), `vatRatePercent`, rate source provenance (`'matter_override' | 'client_override' | 'client_group_override' | 'app_table' | 'pms'`), and agreed CFA/DBA terms are frozen in the snapshot (`capturedAt`). Subsequent changes to tenant rate cards, negotiated client rates, or VAT rates do not mutate existing snapshots unless the user explicitly triggers a rate refresh or creates a new quote version.

### 2. Rate lookup precedence and effective dates (`S0-28`)
- **Fixed four-tier resolution order (`resolveApplicableRates`):**
  For a given `tenantId`, `asAtDate` (`YYYY-MM-DD`, defaulting to the server's current date in `tenantConfig.timeZone`), `matterId`, `clientId` (person or organisation), `practiceAreaId`, and `gradeKey` (`'partner' | 'associate' | 'trainee'` or custom grade ID):
  1. **Matter rate override (`public.matter_rate_overrides`):** active row for `(tenant_id, matter_id, grade_key)` where `effective_from <= asAtDate AND (effective_to IS NULL OR effective_to >= asAtDate)`. (Requires `matterCostsConfig.allowMatterRateOverrides === true`.)
  2. **Client rate override (`public.client_rate_overrides` — direct client):** active row for `(tenant_id, client_id, grade_key)` matching the matter's `practiceAreaId` (or `practice_area_id IS NULL` firm-wide client override) where `effective_from <= asAtDate AND (effective_to IS NULL OR effective_to >= asAtDate)`.
  3. **Client group rate override (`public.client_rate_overrides` — parent organisation):** when `clientId` is an `Organisation` with a `parentOrganisationId` (`F1`), active row for `(tenant_id, parent_organisation_id, grade_key)` matching `practiceAreaId` (or `practice_area_id IS NULL`) effective on `asAtDate`.
  4. **Rate card (`MatterCostsConfig.rateCards`):** active rate card matching `practiceAreaId`, else the firm default rate card (`practiceAreaId === null` / `'RC-DEFAULT'`), selecting `app_table` or `pms` rates per `rateSourceMode`.
- **Effective dates and overlap rejection:**
  - Every negotiated rate row in `public.client_rate_overrides` and `public.matter_rate_overrides` has `effective_from DATE NOT NULL` and `effective_to DATE NULL` (`CHECK (effective_to IS NULL OR effective_to >= effective_from)`).
  - Overlapping effective date ranges for the same `(tenant_id, client_id, COALESCE(practice_area_id, ''), grade_key)` on client overrides or `(tenant_id, matter_id, grade_key)` on matter overrides (`[effective_from, COALESCE(effective_to, '9999-12-31')]`) are rejected inside the transaction before commit with stable error code `'RATE_OVERRIDE_DATE_OVERLAP'` and a descriptive message naming the conflicting range.

### 3. CFA and DBA fee bases and owner cap decisions (`S0-28`, 12 November 2026)
- **Fee bases (`MatterCostWorkBasis` and `QuoteFeeBasis`):**
  - `MatterCostWorkBasis` gains `'conditional_fee_agreement'` (`CFA`) and `'damages_based_agreement'` (`DBA`) alongside `'hourly_rates'`, `'fixed_fee'`, and `'capped'`.
  - `QuoteFeeBasis` gains `'Conditional fee agreement (CFA)'` and `'Damages-based agreement (DBA)'` alongside `'Fixed fee'`, `'Estimate'`, `'Capped fee'`, and `'Hourly rate with estimate'`.
- **Owner cap values and bases (confirmed 12 November 2026 in `WP5-owner-decisions.md`; product configuration decision, not legal advice):**

  | Setting (`capCategoryKey`) | Fee basis | Case / work-type category | Statutory maximum (`maxPercent`) | Defined base (`capBaseKey` & `capBaseDescription`) | Firm default (`defaultPercent`) |
  |---|---|---|---|---|---|
  | `'cfa_general_civil'` | `'conditional_fee_agreement'` | General civil | `100%` | `'base_costs'` — *"100% of base costs"* | `100%` |
  | `'cfa_personal_injury'` | `'conditional_fee_agreement'` | Personal injury (first instance) | `25%` | `'general_damages_and_past_pecuniary_losses_net_of_benefits'` — *"25% of general damages for pain, suffering and loss of amenity plus past pecuniary losses, net of benefits recovered"* | `25%` |
  | `'dba_general_civil'` | `'damages_based_agreement'` | General civil | `50%` | `'sums_recovered_inc_vat'` — *"50% of sums recovered, including VAT"* | `50%` |
  | `'dba_employment'` | `'damages_based_agreement'` | Employment | `35%` | `'sums_recovered_inc_vat'` — *"35% of sums recovered, including VAT"* | `35%` |
  | `'dba_personal_injury'` | `'damages_based_agreement'` | Personal injury | `25%` | `'general_damages_and_past_losses_inc_vat'` — *"25% of general damages plus past losses, including VAT"* | `25%` |

- **How caps are structured and enforced:**
  1. **Statutory maximums are core data (`CORE_STATUTORY_FEE_CAPS` in `core/src/domain/costs/statutoryCaps.ts`), not tenant configuration:**
     - Held as a versioned, effective-dated table (`rowId`, `capCategoryKey`, `feeBasis`, `maxPercent`, `capBaseKey`, `capBaseDescription`, `effectiveFrom: string`, `effectiveTo: string | null`, `legislationRef`).
     - A change in the law is a data row addition with a new `effectiveFrom` date (or seeded into a read-only core reference table), requiring no change to validation logic.
     - **The base is always stored with the percentage** (`capBaseKey` + `capBaseDescription`) on the statutory row, firm configuration, work-type override, quote, and matter costs snapshot. A bare percentage without its base is rejected.
     - Tenants cannot raise or override statutory maximums.
  2. **Firm caps are tenant configuration (`matterCosts.feeArrangementCaps`):**
     - Schema-validated in `core/schemas/tenant-config.schema.json` and `core/src/config-engine/index.ts`, and editable in Administration (`public.tenant_module_configs` `'matter_costs'`).
     - Each of the five categories (`cfa_general_civil`, `cfa_personal_injury`, `dba_general_civil`, `dba_employment`, `dba_personal_injury`) has a schema entry with `maxPercent` (`0` up to the statutory maximum for that category) and `capBaseKey` (locked to the statutory base for that category).
     - **Defaults equal the statutory maximums (`100%`, `25%`, `50%`, `35%`, `25%`)** — there is no lower house limit out of the box (Decision 1).
     - Schema and service validation reject any firm cap above the statutory maximum (`FEE_CAP_CONFIG_EXCEEDS_STATUTORY`).
  3. **Work-type cap overrides (`workTypes.items[].feeArrangementCapOverrides` / `MatterCostsConfig.workTypeCapOverrides`):**
     - Building on S0-22's work-type configuration, a firm can set an optional cap override per work type (`workTypeId`, `capCategoryKey`, `maxPercent`, `capBaseKey`) (Decision 2).
     - **Cap resolution precedence:**
       $$\text{applicableCap} = \text{workTypeCap} \;\text{??}\; \text{firmCap} \;\text{??}\; \text{statutoryMax}$$
       and in all cases capped by $\min(\text{resolved}, \text{statutoryMax})$.
     - Validation at configuration save time rejects any work-type cap override above the statutory maximum (`FEE_CAP_CONFIG_EXCEEDS_STATUTORY`) or above the firm cap (`FEE_CAP_CONFIG_EXCEEDS_FIRM`).
  4. **Server-side enforcement with no override path (Decision 3):**
     - Wherever CFA or DBA terms are created or updated — on a **matter** (`saveMatterRecord`), a **quote** (`saveQuoteRecord`), or a **matter costs snapshot / sign-off** (`signOffMatterCosts`) — the server resolves the applicable cap inside the PostgreSQL transaction (reading work-type settings, firm caps, and statutory caps inside the transaction) and validates the proposed percentage and base.
     - Any value above the applicable cap is **blocked with no override path** (no Risk & Compliance sign-off override exists).
     - The server returns a stable error code (`'FEE_CAP_EXCEEDED_WORK_TYPE'`, `'FEE_CAP_EXCEEDED_FIRM'`, or `'FEE_CAP_EXCEEDED_STATUTORY'`) and a message stating the submitted percentage, the applicable cap percentage, the cap level (`work type`, `firm`, or `statutory`), and the defined base.

### 4. Audit trail in the same transaction
- Every creation, update, or removal of:
  - `MatterCostsConfig` (rate cards, VAT rate, firm CFA/DBA caps, work-type CFA/DBA caps),
  - a client negotiated rate (`public.client_rate_overrides`),
  - a matter negotiated rate (`public.matter_rate_overrides`), or
  - a matter or quote's fee arrangement (`MatterCostsSnapshot`, `Quote`)
  writes a structured `public.audit_entries` record (with before/after values, actor, and timestamp) inside the **same PostgreSQL transaction** as the data change.

## Alternatives Considered

- **Allowing a Risk & Compliance partner sign-off to override a firm's own cap (up to the statutory maximum).** Explicitly rejected by the product owner on 12 November 2026 (`WP5-owner-decisions.md` Decision 3): exceeding a firm's own cap or work-type cap is always blocked.
- **Storing only a bare cap percentage without its calculation base.** Rejected (`WP5-owner-decisions.md`): 25% of base costs is fundamentally different from 25% of general damages and past pecuniary losses net of benefits recovered; the base key and description must be stored and validated alongside every percentage.
- **Using IEEE 754 floating-point numbers for quote and costs arithmetic.** Rejected: floating-point rounding causes penny discrepancies on VAT and percentage caps.

## Consequences

- `S0-23` unreserves the five `[x-reserved:S0-23]` `matterCosts.*` keys in `core/schemas/tenant-config.schema.json`, adds `matterCosts.vatRatePercent`, introduces `core/src/domain/money/index.ts`, and locks immutable costs snapshots.
- `S0-28` adds migration `0017_negotiated_rates_and_fee_arrangements_expand` (`public.client_rate_overrides`, `public.matter_rate_overrides`), `CORE_STATUTORY_FEE_CAPS`, firm and work-type cap configuration, CFA/DBA support on matters and quotes, two-tenant isolation tests, and Help articles (`rates-and-charging`, `matter-opening-and-risk`).
- Stage plan §8 row *"Confirm the CFA and DBA cap values to use as configuration defaults"* is marked **Done (12 November 2026)**.
