# S0-28 — Negotiated Rates and CFA/DBA (Four-Tier Rate Resolution and Statutory Fee Caps)

| Field | Value |
|---|---|
| Slice | `S0-28a` (`M`: negotiated overrides + `0016`) + `S0-28b` (`M`: CFA/DBA & statutory caps) — split from `S0-28` per owner approval 15 Nov 2026 |
| Stage / Work package | Stage 0C — Make it shared (`WP5b`) |
| Status | Planned (awaiting build after `WP5a`) |
| Branch | Stacked `s0-28a-negotiated-rates` -> `s0-28b-cfa-dba-and-caps` (target `develop`) |
| Depends on | `S0-23` (then `S0-28b` depends on `S0-28a`) |
| Size | `S0-28a`: `M`; `S0-28b`: `M` (split from `L` per owner approval 15 Nov 2026) |
| Backlog IDs | `30` (`Partly built` -> `Completed`; advances `3`, `F1`; cross-cutting `P8`, `P10`, `P11`) |
| Decision record(s) | `D10` — [ADR 0034](../decisions/0034-fee-arrangements-and-caps.md) (`Accepted`); [WP5 Owner Decisions](../../../../PlanReviews/WP5-owner-decisions.md) (12 & 15 Nov 2026) |
| Spec / standards references | Architecture Standard sections 4, 5, 6, 7, 8.7, 10, 12; [RBAC Reference](../rbac-reference.md) |

---

## 1. Purpose

Complete Stage 0 backlog item `30` (*Rates and charging*) under [ADR 0034](../decisions/0034-fee-arrangements-and-caps.md) (`D10`):

1. **`S0-28a` scope — Negotiated rates & 4-tier lookup:** Add effective-dated client, client-group (`F1` parent organisation) and matter rate overrides in PostgreSQL (`public.client_rate_overrides` and `public.matter_rate_overrides`) with overlap rejection (`'RATE_OVERRIDE_DATE_OVERLAP'`), a fixed 4-tier `resolveApplicableRates` precedence chain, UI management and same-transaction audit entries.
2. **`S0-28b` scope — CFA/DBA fee bases & caps:** Add Conditional Fee Agreement (`CFA`) and Damages-Based Agreement (`DBA`) fee bases to Matter Costs and Quotes, ship core statutory cap limits in `core/src/domain/costs/statutory-fee-caps.json`, validate configurable firm caps (`matterCosts.feeArrangementCaps`) and work-type overrides (`workTypeCapOverrides`, permitted above or below firm cap up to `statutoryMax` per `R486`), and enforce caps fail-closed inside the Postgres transaction with zero override path.

---

## 2. Classification & Architectural Layer

- **Classification:** Core tenancy migration (`0016`) + core domain reference data (`core/src/domain/costs/`) + tenant config schema (`matterCosts.feeArrangementCaps` / `workTypeCapOverrides`) + host Quote/Matter/Admin integration.
- **Single-tenant and multi-tenant operation:** Identical build. Statutory caps live in immutable core data (`core/src/domain/costs/statutory-fee-caps.json`), whereas negotiated rates and firm/work-type cap settings live per tenant in that tenant's PostgreSQL database.

---

## 3. Existing Code & Schema

- **Database schema version entering `S0-28`:** `0015` (from `develop` / `S0-23`, `CORE_REQUIRED_SCHEMA_VERSION = '0015'`).
- **Baseline built in `S0-23`:** `core/src/domain/money/index.ts`, `matterCosts.vatRatePercent`, integer minor units and immutable snapshot guarantees on `MatterCostsSnapshot` and `Quote`.
- **Host rate & quote modules:** `src/domain/matterCosts.ts:318-536` (`lookupRatesForMatter`, `resolveMatterCostsSnapshot`), `src/domain/quotes.ts:22-100` (`QUOTE_FEE_BASES`, `calculateQuoteTotals`), `src/domain/types.ts:1698-1754`, `src/components/MatterFormClient.tsx`, `src/components/QuoteFormClient.tsx`, `src/server/services.ts:4576, 6933` (`saveMatterRecord`, `signOffMatterCostsRecord`).

---

## 4. Scope & Exact Changes

### 4.1 Migration `0016_negotiated_rates_expand` & repository methods (`S0-28a`)

Bump `CORE_REQUIRED_SCHEMA_VERSION` from `'0015'` to `'0016'` and add `0016_negotiated_rates_expand` (with reversible down SQL) in `core/src/tenancy/migrations/index.ts`:

- **`public.client_rate_overrides`**: holds direct client (`organisation` / `person`) and parent-organisation (`client_group`, linked via `parentOrganisationId`, `F1`) effective-dated overrides (`id`, `tenant_id`, `client_id`, `practice_area_id` nullable for firm-wide client rate, `grade_key`, `rate_minor_units BIGINT NOT NULL CHECK (>= 0)`, `currency`, `effective_from DATE NOT NULL`, `effective_to DATE NULL`, `CHECK (effective_to IS NULL OR effective_to >= effective_from)`, audit metadata columns).
- **`public.matter_rate_overrides`**: holds matter-level effective-dated overrides (`id`, `tenant_id`, `matter_id`, `grade_key`, `rate_minor_units BIGINT NOT NULL CHECK (>= 0)`, `currency`, `effective_from DATE NOT NULL`, `effective_to DATE NULL`, `CHECK (effective_to IS NULL OR effective_to >= effective_from)`, audit metadata columns).
- Enforce non-overlapping effective-date ranges (`[effective_from, COALESCE(effective_to, '9999-12-31')]`) per `(tenant_id, client_id, COALESCE(practice_area_id, ''), grade_key)` in `public.client_rate_overrides` and `(tenant_id, matter_id, grade_key)` in `public.matter_rate_overrides`, rejecting overlaps inside the transaction before commit with stable error code **`'RATE_OVERRIDE_DATE_OVERLAP'`**.

### 4.2 Fixed 4-tier `resolveApplicableRates` precedence (`S0-28a`)

Implement `resolveApplicableRates` for `(tenantId, asAtDate, matterId, clientId, practiceAreaId, gradeKey)`:

1. **Tier 1 — Matter rate override (`public.matter_rate_overrides`):** active row where `effective_from <= asAtDate AND (effective_to IS NULL OR effective_to >= asAtDate)` (when `matterCostsConfig.allowMatterRateOverrides === true`).
2. **Tier 2 — Direct client override (`public.client_rate_overrides`):** active row for `clientId` matching `practiceAreaId` (preferring specific `practiceAreaId` before `practice_area_id IS NULL` firm-wide client override).
3. **Tier 3 — Client group override (`public.client_rate_overrides`):** when `clientId` is an `Organisation` with a `parentOrganisationId` (`F1`), active row for `parentOrganisationId` matching `practiceAreaId` (else `practice_area_id IS NULL`).
4. **Tier 4 — Rate card (`MatterCostsConfig.rateCards`):** matching `practiceAreaId` card, else `'RC-DEFAULT'` (`app_table` or `pms`).

Wire `resolveApplicableRates` into quotes, matter costs estimation and costs snapshot creation, preserving immutable snapshots once saved/signed off (`S0-23`).

### 4.3 Core statutory caps & configurable firm/work-type caps (`S0-28b`)

- Ship immutable core reference data in **`core/src/domain/costs/statutory-fee-caps.json`**, validated against **`core/schemas/statutory-fee-caps.schema.json`** and queried by **`core/src/domain/costs/statutoryCaps.ts`**, encoding all **5 exact `capCategoryKey` rows**:
  1. `'cfa_general_civil'` (`'conditional_fee_agreement'`): `maxPercent: 100`, `capBaseKey: 'base_costs'` (*"100% of base costs"*).
  2. `'cfa_personal_injury'` (`'conditional_fee_agreement'`): `maxPercent: 25`, `capBaseKey: 'general_damages_and_past_pecuniary_losses_net_of_benefits'` (*"25% of general damages for pain, suffering and loss of amenity plus past pecuniary losses, net of benefits recovered"*).
  3. `'dba_general_civil'` (`'damages_based_agreement'`): `maxPercent: 50`, `capBaseKey: 'sums_recovered_inc_vat'` (*"50% of sums recovered, including VAT"*).
  4. `'dba_employment'` (`'damages_based_agreement'`): `maxPercent: 35`, `capBaseKey: 'sums_recovered_inc_vat'` (*"35% of sums recovered, including VAT"*).
  5. `'dba_personal_injury'` (`'damages_based_agreement'`): `maxPercent: 25`, `capBaseKey: 'general_damages_and_past_losses_inc_vat'` (*"25% of general damages plus past losses, including VAT"*).
- Extend `MatterCostWorkBasis` with `'conditional_fee_agreement'` and `'damages_based_agreement'`, and `QuoteFeeBasis` with `'Conditional fee agreement (CFA)'` and `'Damages-based agreement (DBA)'`.
- Add schema-validated **`matterCosts.feeArrangementCaps`** (firm defaults equal statutory limits `100%`, `25%`, `50%`, `35%`, `25%`; rejected if above `statutoryMax` -> `'FEE_CAP_CONFIG_EXCEEDS_STATUTORY'`) and **`workTypeCapOverrides`** (`workTypeId`, `capCategoryKey`, `maxPercent`, `capBaseKey`), plus per-work-type `feeArrangementCapCategories` mapping (`S0-22` work-type config).
- **Precedence (`R486` owner decision 15 Nov 2026):** `applicableCap = workTypeCap ?? firmCap ?? statutoryMax`, bounded above by `statutoryMax`. A `workTypeCapOverride` may sit **either above or below** the firm cap as long as it does not exceed `statutoryMax`; config save validates work-type caps against **`statutoryMax` only** (`'FEE_CAP_CONFIG_EXCEEDS_STATUTORY'`).

### 4.4 Fail-closed transaction enforcement & audit trail (`S0-28b`)

- Inside the Postgres transaction of `saveMatterRecord`, `saveQuoteRecord` and `signOffMatterCostsRecord`, resolve the matter/quote's `workTypeId` -> `capCategoryKey` and validate percentage + `capBaseKey` with **no override path**:
  - `'FEE_CAP_CATEGORY_UNMAPPED'` (missing `workTypeId` or unmapped category for CFA/DBA — never guesses `"general civil"`).
  - `'FEE_CAP_BASE_MISMATCH'` (submitted `capBaseKey` mismatches category's statutory base).
  - `'FEE_CAP_EXCEEDED_WORK_TYPE'`, `'FEE_CAP_EXCEEDED_FIRM'`, `'FEE_CAP_EXCEEDED_STATUTORY'` (percentage exceeds applicable cap).
- Write structured `public.audit_entries` in the **same transaction** for every negotiated rate CRUD, `MatterCostsConfig` cap change, and CFA/DBA term save on a matter or quote.
- Add Quote, Matter Costs and Admin UI controls for managing negotiated rate overrides and selecting/validating CFA/DBA terms + base descriptions.

### 4.5 Out of Scope

- Amending statutory maximums via tenant configuration (code-reviewed changes to `core/src/domain/costs/statutory-fee-caps.json` only).
- Post-matter-completion billing/time-recording ledger (Stage 2+).

---

## 5. Migrations & Backwards Compatibility

- **Migration:** `0016_negotiated_rates_expand` (expand-only; adds `public.client_rate_overrides` and `public.matter_rate_overrides`; bumps `CORE_REQUIRED_SCHEMA_VERSION` from `'0015'` to `'0016'`).
- **Reversibility:** Reversible down migration drops the two new override tables cleanly without touching existing `matters`, `quotes` or `tenant_module_configs`.
- Existing quotes/matters using hourly/fixed/capped fee bases continue functioning identically.

---

## 6. Security, Tenancy & Permissions

- Every new server action (negotiated rate CRUD, fee-arrangement cap config save) uses `guardedAction` with an explicit policy in `src/server/actionPermissions.ts` (`MAX_KNOWN_GAPS = 0`).
- Admin rate-card / cap-limit mutations require `mfaVerified === true` and `finance` / admin configuration permission.
- Matter rate override CRUD checks `canAccessMatter` so restricted staff and ethical-wall matters cannot be modified or probed by unpermitted actors.
- Same-transaction `audit_entries` record before/after states without client PII in application logs.

---

## 7. Tests Required

1. **4-tier precedence & overlap tests:**
   - Explicit test coverage of Tier 1 (matter override), Tier 2 (direct client override, `practiceAreaId` specific vs null fallback), Tier 3 (parent `client_group` override via `parentOrganisationId`), and Tier 4 (rate card fallback) at effective-date boundaries (`effective_from === asAtDate`, `effective_to === asAtDate`, expired override).
   - Overlap rejection test returning `'RATE_OVERRIDE_DATE_OVERLAP'` across client and matter overrides.
   - Quotes & Matter Costs UI/service consumption tests preserving immutable saved snapshots.
2. **All 5 `capCategoryKey` & `R486` tests:**
   - Validate all 5 categories (`cfa_general_civil`, `cfa_personal_injury`, `dba_general_civil`, `dba_employment`, `dba_personal_injury`), verifying defined `capBaseKey` storage alongside percentage.
   - **Dedicated `R486` test:** Lower firm cap below statutory (e.g. firm `cfa_general_civil` = `50%`, `statutoryMax` = `100%`), configure a `workTypeCapOverride` **above** the firm cap (e.g. `80%`, still `<= 100%`) -> config save **succeeds**, and a matter/quote of that work type succeeds at `75%` and fails at `85%` (`'FEE_CAP_EXCEEDED_WORK_TYPE'`), while saving a work-type override at `101%` fails with `'FEE_CAP_CONFIG_EXCEEDS_STATUTORY'`.
   - Separate test verifying work-type override **below** firm cap tightens cleanly as expected.
3. **Fail-closed cap error tests:** Reject unmapped work type / missing `workTypeId` (`'FEE_CAP_CATEGORY_UNMAPPED'`), wrong base (`'FEE_CAP_BASE_MISMATCH'`), and exceeded cap across `saveMatterRecord`, `saveQuoteRecord` and `signOffMatterCostsRecord` (`'FEE_CAP_EXCEEDED_WORK_TYPE'`, `'FEE_CAP_EXCEEDED_FIRM'`, `'FEE_CAP_EXCEEDED_STATUTORY'`).
4. **Same-transaction rollback & audit tests:** Forced failure rolls back rate override or CFA/DBA save + audit entry together.
5. **Two-tenant isolation tests (`P8`):** Tampered override IDs (`client_rate_overrides` / `matter_rate_overrides`), cross-tenant parent `client_group` links, forged `tenantId` claims and cross-tenant work-type cap leakage fail closed across Tenant A and Tenant B in PostgreSQL.

---

## 8. Documentation, Help & Backlog Updates

- **Help & documentation (`Rule 11`, `P11`):**
  - Update [finance-data-and-permissions.ts](file:///c:/1Squared/App/src/docs/articles/finance-data-and-permissions.ts) (4-tier negotiated rate hierarchy, effective dates, CFA/DBA fee bases, statutory/firm/work-type caps and non-override rule).
  - Update [tenant-settings.ts](file:///c:/1Squared/App/src/docs/articles/tenant-settings.ts) (configuring firm caps and work-type cap overrides up to statutory maximums).
- **Release notes:** Add an `S0-28` entry (or `S0-28a` / `S0-28b` entries if split) in `docs/release-notes.md`.
- **Backlog updates (`docs/roadmap/feature-list.md`):**
  - Item `30` (*Rates and charging*): `Partly built` -> `Completed`.
  - Record advances on `3` (Quotes), `F1` (Client groups / parent org rate overrides), `P8`, `P10`, `P11`.

---

## 9. Manual Setup / External Blockers

- `None` (owner CFA/DBA cap values were decided on 12 Nov 2026 in `WP5-owner-decisions.md` and `R486` on 15 Nov 2026; codified in Accepted `ADR 0034`).

---

## 10. Acceptance Criteria

- [ ] Migration `0016_negotiated_rates_expand` creates `public.client_rate_overrides` and `public.matter_rate_overrides`; `CORE_REQUIRED_SCHEMA_VERSION === '0016'`.
- [ ] `resolveApplicableRates` resolves Tiers 1 -> 2 -> 3 -> 4 accurately and rejects overlapping effective dates with `'RATE_OVERRIDE_DATE_OVERLAP'`.
- [ ] `core/src/domain/costs/statutory-fee-caps.json` encodes all 5 `capCategoryKey` rows and bases cleanly.
- [ ] `workTypeCapOverrides` works both above and below firm cap up to `statutoryMax` (`R486`), validated only against `statutoryMax` on config save.
- [ ] Matters, Quotes and Costs Snapshots fail closed on `'FEE_CAP_CATEGORY_UNMAPPED'`, `'FEE_CAP_BASE_MISMATCH'`, `'FEE_CAP_EXCEEDED_*'` inside the DB transaction with zero override path and same-transaction audit entries.
- [ ] All unit, precedence, CFA/DBA, RBAC/MFA and two-tenant isolation tests pass, plus `npm run ci`.
- [ ] Help articles, `docs/release-notes.md` and `docs/roadmap/feature-list.md` (`30` -> `Completed`) are updated in the same PR.

---

## 11. Re-plan Signs & Risks

- **Re-plan if:**
  - `F1` (`Organisation.parentOrganisationId`) is missing or inconsistently indexed in `TenantPartyRepository` when Tier 3 looks up parent organisation rates;
  - Quote totals calculation requires an extra migration column on `public.quotes` for structured CFA/DBA snapshot metadata beyond existing snapshot JSON columns;
  - Owner approves splitting PR execution into `S0-28a` and `S0-28b` (recommended in stage plan callout to keep diff sizes focused).
