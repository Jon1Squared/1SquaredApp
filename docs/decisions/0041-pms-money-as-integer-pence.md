# ADR 0041: PMS Money and Retainer Funds as Integer Pence (`B21`)

- **Date:** 2026-11-26
- **Status:** Proposed
- **Roadmap:** Stage 1 Work Package 3, slice `S1-12` ([docs/roadmap/slices/s1-12-pms-money-pence.md](../roadmap/slices/s1-12-pms-money-pence.md)); Stage 0 exit decision D6; backlog `B21` and item `6`
- **Builds on:** [ADR 0028](./0028-tenant-database-and-repositories.md) (per-tenant PostgreSQL databases and migrations), [ADR 0029](./0029-tenant-finance-and-pms-isolation.md) (per-tenant PMS data store), [ADR 0034](./0034-fee-arrangements-and-caps.md) (integer minor units on quotes and costs), [ADR 0038](./0038-intake-check-interfaces-and-manual-adapters.md) (`PaymentRequestRecord.amountMinorUnits` as `bigint` pence)

## Context

In Stage 0, quotes and matter costs moved onto pure integer minor-unit (`MinorUnits`, pence) arithmetic using `@platform/core-api` (`core/src/domain/money/index.ts:1–175`, re-exported at `core/src/api/index.ts:1946`). By contrast, the Practice Management System (PMS) persistence layer and finance roll-ups still store and aggregate money as IEEE-754 floating-point pounds (backlog `B21`):

1. **PostgreSQL schema (`PMS_PER_TENANT_MIGRATION_0013`, `core/src/tenancy/migrations/index.ts:1556–1881`):**
   - Migration `0013` defines **22 `DOUBLE PRECISION` columns** across 9 `pms_*` tables (`:1618` to `:1799`).
   - Direct code inspection shows **20 are monetary columns** (19 GBP amount columns and 1 GBP/hour charge-out rate column) and **2 are non-monetary quantity columns** (`pms_matter_financials.wip_hours` at `:1672` and `pms_time_entries.hours` at `:1756`), which represent decimal hours rather than currency and must remain `DOUBLE PRECISION`.
   - Twelve additional monetary fields live inside `pms_*.payload_json` JSONB (`annual_target_fees`, `credit_limit`, `fixed_fee_amount`, `disbursements_estimate`, `fees_net`, `disbursements_net`, `vat`, `rate`, `billed_value`, `write_off_value`, `vat_amount`, `gross_amount`).
   - Separately, `public.matters` (`migrations/index.ts:941–988`) has no dedicated column for `retainerMoniesOnAccountGbp`; it persists only inside JSONB (`costs_json` and `opening_record_json` in `core/src/tenancy/matterRepository.ts:227, 486–489, 601, 658`) as a JavaScript number.
2. **Float conversions and raw float sums across persistence, domain, and UI:**
   - `core/src/tenancy/pmsRepository.ts:53–55` defines `round2(n)` as `Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100`, which biases half-way values away from even/exact decimal boundaries (notably breaking negative half-way rounding and binary float inputs), and applies it alongside `Math.round(x * 100)` across `computeDerivedInvoiceBalances` (`:526–606`), `computeDerivedMatterFinancials` (`:679–789`), `computeDerivedMatterWipBreakdown` (`:857–893`), `importExtractDataset` (`:1489–1811`, including float subtraction `total_invoiced_inc_vat - fees_billed - disbursements_billed` at `:1604–1606`), and row mappers (`:1865–2119`, where `mapClientAccountRows` also recomputes `running_balance` from `row.amount` rather than reading `balance_after`).
   - `src/pms/xlsxReader.ts:148–153` (`parseMoney`) converts workbook cells through `Number(val)` + `Number.EPSILON` rather than exact decimal string parsing.
   - `src/domain/pms.ts:51–63, 548–562, 718–733, 885–1001`, `src/server/services.ts:18338–18364` (12 corporate-group sums in `getClientPmsViewBundle`), `src/components/HomeClient.tsx:460–484, 1008–1013, 4048–4056`, `src/components/MatterFinanceTab.tsx:68–79, 218, 408, 448, 452, 543, 1052–1054`, `src/components/OrganisationProfileClient.tsx:471–473`, `src/components/PersonProfileClient.tsx:634–643`, `src/components/MatterProfileClient.tsx:719–725`, and `src/components/QuoteDetailClient.tsx:797, 830` sum floating-point pound values before rounding.
3. **Downstream WP3 dependency (`S1-08` Money on Account):** `S1-08` matches client account receipts in `pms_client_account_entries` against `PaymentRequestRecord` (`amountMinorUnits: bigint` pence) inside transactional opening-gate checks. Exact integer pence in PMS storage is a hard prerequisite for `S1-08`.

Because changing tenant database column types across two releases, setting the canonical rounding rule, defining the repository conversion boundary, and adding `@platform/core-api` helpers affect shared platform contracts and rollback safety (Architecture Standard §§4, 7, 8, 12; Rule 7 & Rule 8), this decision requires an ADR before WP3 implementation begins.

## Decision

### 1. Column types: signed `BIGINT` integer pence (`0027_pms_money_and_retainer_pence_expand`)

Reversible expand migration **`0027_pms_money_and_retainer_pence_expand`** adds `BIGINT` (`INT8`) integer-pence columns alongside the existing columns without altering or dropping the old columns yet:

1. **All 20 PMS monetary columns (`BIGINT NOT NULL DEFAULT 0`):**
   - `pms_fee_earners`: `charge_out_rate_pence` (from `charge_out_rate`)
   - `pms_matters`: `fee_estimate_pence` (from `fee_estimate`)
   - `pms_matter_financials` (11 columns; **`wip_hours` remains `DOUBLE PRECISION`**): `current_fee_estimate_pence`, `wip_value_pence`, `total_time_value_pence`, `billed_fees_ex_vat_pence`, `billed_disb_ex_vat_pence`, `billed_vat_pence`, `billed_total_inc_vat_pence`, `cash_received_pence`, `outstanding_debt_pence`, `unbilled_disbursements_pence`, `client_account_balance_pence`
   - `pms_fee_estimates`: `estimated_fees_ex_vat_pence` (from `estimated_fees_ex_vat`)
   - `pms_invoices`: `total_inc_vat_pence` (from `total_inc_vat`)
   - `pms_payments`: `amount_pence` (from `amount`)
   - `pms_time_entries` (1 column; **`hours` remains `DOUBLE PRECISION`**): `value_pence` (from `value`)
   - `pms_disbursements`: `amount_ex_vat_pence` (from `amount_ex_vat`)
   - `pms_client_account_entries`: `amount_pence` (from `amount`), `balance_after_pence` (from `balance_after`)
   - Signed `BIGINT` is used rather than unsigned checks on PMS ledger/balance columns because credit notes, client account reversals, overpayments, and `Payment`/`Transfer to office` rows legitimately carry negative values (`±£90,000,000,000,000` range, bounded in JS by `Number.MAX_SAFE_INTEGER` via `@platform/core-api`).
2. **Additional PMS `payload_json` fields:** Normalized in SQL during `0027` and stored as integer `*_pence` sibling keys alongside existing JSON fields during PMS import (`annual_target_fees_pence`, `credit_limit_pence`, `fixed_fee_amount_pence`, `disbursements_estimate_pence`, `fees_net_pence`, `disbursements_net_pence`, `vat_pence`, `rate_pence`, `billed_value_pence`, `write_off_value_pence`, `vat_amount_pence`, `gross_amount_pence`, plus `pms_matter_financials.payload_json` derived snapshot totals).
3. **`public.matters.retainer_monies_on_account_pence`:** Add `retainer_monies_on_account_pence BIGINT NULL CHECK (retainer_monies_on_account_pence IS NULL OR retainer_monies_on_account_pence >= 0)` on `public.matters`, backfilled in `0027` from `COALESCE(costs_json->>'retainerMoniesOnAccountGbp', opening_record_json->>'retainerMoniesOnAccountGbp')` when non-empty.

### 2. Canonical conversion rule: round half away from zero

Every GBP-to-pence conversion — in SQL migrations, PMS workbook parsing, `pmsRepository`, and domain helpers — uses **exact symmetric round half away from zero**:

- `+£0.005` (`0.005`) -> `+1p` (`1`); `-£0.005` (`-0.005`) -> `-1p` (`-1`).
- `+£19.995` -> `+2000p`; `-£19.995` -> `-2000p`.
- Normalized zero: `-0.00` or `-0` always converts to `0` (`0n`).
- **PostgreSQL migration SQL expression:**
  ```sql
  ROUND((col::numeric) * 100)::bigint
  ```
  Wait-free and deterministic in PostgreSQL 16 (`numeric` `ROUND(x)` rounds ties `x.5` away from zero in PostgreSQL for both positive and negative values, unlike `DOUBLE PRECISION` IEEE-754 `ROUND`, which uses round-half-to-even). Non-finite IEEE-754 values (`NaN`, `Infinity`, `-Infinity`) and out-of-safe-range magnitudes (`ABS(col) > 90071992547409.91`) are explicitly rejected in `0027` before conversion so corrupt floats fail closed rather than overflowing.
- **TypeScript expression:** `poundsToMinorUnits` (`core/src/domain/money/index.ts:83–86`), which parses canonical decimal strings with `BigInt` (`parseScaledHundredths`, `:36–77`, symmetric half-away-from-zero) — never binary multiplication `Math.round((x + Number.EPSILON) * 100)`.
- **Automated conversion check in `0027` (`afterUpSql`):** Within the same migration transaction (`TenantMigrationRunner.applyUp`), run an automated verification query across all 20 monetary columns across the 9 `pms_*` tables, all backfilled `payload_json` monetary keys, and `public.matters.retainer_monies_on_account_pence`: compare every converted `BIGINT` column against `ROUND((original_float::numeric) * 100)::bigint`, verify `mismatchCount = 0`, `nonFiniteCount = 0`, and `outOfSafeRangeCount = 0`, throw `PMS_PENCE_CONVERSION_MISMATCH` to abort and roll back the migration if any row disagrees, and emit one zero-PII structured log record (`job.migrate.pms_pence_verified`, containing only `tenantId`, `correlationId`, per-table row counts, total fields checked, and `mismatchCount: 0`).
- **Demo in-place conversion (Owner decision, 26 Nov 2026):** The demo tenant converts its existing PMS and matter data **in place** via `caj-migrate-demo` without re-seeding; re-seeding is used only as a manual fallback if conversion verification fails, and only with owner approval at deploy time.

### 3. Expand-then-contract sequence across releases (Rule 8)

To support zero-downtime deployment and lossless rollback without losing precision:

1. **Release N (`S1-12`, migration `0027_pms_money_and_retainer_pence_expand`, status: Stage 1 WP3):**
   - **Expand (`upSql`):** Add the 20 `*_pence BIGINT` columns and `matters.retainer_monies_on_account_pence BIGINT NULL`, backfill via `ROUND((col::numeric) * 100)::bigint`, backfill `payload_json` `*_pence` fields and `matters.retainer_monies_on_account_pence`, and verify every row in `afterUpSql`.
   - **Reads:** As soon as `S1-12` code is deployed, `TenantPmsRepository` and `TenantMatterRepository` **stop reading the 20 old `DOUBLE PRECISION` columns** (`charge_out_rate`, `fee_estimate`, etc.) and stop reading float JSONB values as authoritative; all reads source strictly from `*_pence` columns and integer `*_pence` JSONB keys (asserting safe integer bounds via `pgBigIntToMinorUnits`).
   - **Dual-write during compatibility window:** During Release N, `TenantPmsRepository.importExtractDataset` and `TenantMatterRepository` continue populating the legacy `DOUBLE PRECISION` columns (`minorUnitsToPounds(pence)`) and `retainerMoniesOnAccountGbp` JSONB key derived deterministically from integer pence so rolling back the application container before Release N+1 leaves consistent tables. Rolling back migration `0027` (`downSql`) drops only the newly added `*_pence` columns and strips backfilled JSONB `*_pence` keys (tracked in `migration_0027_backfill_audit` matching migrations `0021`/`0025`).
2. **Release N+1 (post-WP3 contract release, tracked in `feature-list.md` as backlog `B34`):**
   - Stop dual-writing the 20 legacy `DOUBLE PRECISION` columns and `retainerMoniesOnAccountGbp` float JSONB keys in repository writers.
   - Apply reversible contract migration **`0031+`** dropping the 20 deprecated `DOUBLE PRECISION` PMS columns (**explicitly retaining** `pms_matter_financials.wip_hours` and `pms_time_entries.hours` as `DOUBLE PRECISION`) after a release cycle confirms Release N requires no rollback.

### 4. Repository boundary conversion and `@platform/core-api` money helpers

1. **Additive `@platform/core-api` helpers (`core/src/domain/money/index.ts`, re-exported at `core/src/api/index.ts:1946`):**
   Because `node-postgres` (`pg`) returns SQL `BIGINT` values as decimal strings (whereas `PaymentRequestRecord` uses `bigint` and `MinorUnits` uses safe integer `number`), add and export four additive functions in `core/src/domain/money/index.ts`, bumping `CORE_API_VERSION` from `'2.2.0'` to `'2.3.0'`:
   - `pgBigIntToMinorUnits(value: string | number | bigint, label?: string): MinorUnits` — parses integer decimal strings (`/^[-+]?\d+$/`), `bigint`, or safe integer `number` into a safe `MinorUnits` integer (`-0` normalised to `0`); rejects fractional decimals, floats, `NaN`, or out-of-safe-range values cleanly.
   - `minorUnitsToPgBigInt(minorUnits: MinorUnits): string` — validates safe integer and formats as canonical SQL `BIGINT` parameter string.
   - `subtractMinorUnits(minuend: MinorUnits, subtrahend: MinorUnits): MinorUnits` — `BigInt` exact difference checked within safe range.
   - `formatMinorUnitsGbp(minorUnits: MinorUnits, options?: { accountingBrackets?: boolean; omitZeroPence?: boolean }): string` — formats exact integer pence to GBP strings without ever converting to float (`accountingBrackets: true` formats negatives as `(£12.34)` matching `src/domain/pms.ts:51–63`; default uses `-£12.34`; `omitZeroPence: true` formats whole pounds as `£1,200` matching `src/domain/quotes.ts:90–100`).
2. **Zero float sums anywhere inside `pmsRepository`, domain roll-ups, services, or UI:**
   - **PMS import (`src/pms/xlsxReader.ts:148–153`, `src/pms/importPms.ts`):** `parseMoney` delegates to `poundsToMinorUnits` on raw decimal/number cells, preserving string decimals before float coercion whenever spreadsheet cells are text. `importExtractDataset` accepts integer `*Pence` inputs (converting boundary GBP numbers via `poundsToMinorUnits` only if integer pence are absent), computes `billedVatPence = subtractMinorUnits(totalInvoicedIncVatPence, sumMinorUnits([feesBilledPence, disbursementsBilledPence]))` in exact integer pence, accumulates `pms_client_account_entries.balance_after_pence` in `BigInt`/`MinorUnits`, and writes `*_pence` columns + dual-writes legacy float columns.
   - **Repository reads & boundary (`core/src/tenancy/pmsRepository.ts`):** Row mappers parse SQL `*_pence` columns via `pgBigIntToMinorUnits`, perform every invoice balance (`totalIncVatPence - paidPence + creditNotesPence`, checking `> 0` instead of `> 0.005`), matter summary, WIP breakdown, and running client balance calculation exclusively in `MinorUnits` using `sumMinorUnits` / `subtractMinorUnits`, populate additive `*Pence` properties on PMS domain types (`TenantPmsMatterFinancials`, `TenantPmsInvoice`, `TenantPmsPayment`, `TenantPmsTimeEntry`, `TenantPmsDisbursement`, `TenantPmsClientAccountEntry`, `TenantPmsFeeEarner`, `TenantPmsFeeEstimate`), and emit boundary decimal GBP fields exclusively via `minorUnitsToPounds(pence)` at the final edge. `mapClientAccountRows` uses persisted `row.balance_after_pence` (verified consistent) rather than recomputing from floats.
   - **Domain, server, and UI roll-ups:** `src/domain/pms.ts`, `src/server/services.ts` (`getClientPmsViewBundle`), `src/components/HomeClient.tsx`, `src/components/MatterFinanceTab.tsx`, `src/components/OrganisationProfileClient.tsx`, `src/components/PersonProfileClient.tsx`, `src/components/MatterProfileClient.tsx`, and `src/components/QuoteDetailClient.tsx` replace every float accumulation and subtraction with `sumMinorUnits`, `subtractMinorUnits`, and `formatMinorUnitsGbp` (converting via `poundsToMinorUnits` when reading legacy optional GBP inputs until all callers pass `*Pence` directly).

### 5. Behaviour across both hosting models (Rule 6)

- **Model A (`single_tenant`, dedicated client Azure):** `TenantMigrationRunner` applies `0027` to the firm's single tenant database, verifies every converted row inside `afterUpSql`, and `TenantPmsRepository` / `TenantMatterRepository` execute solely over `SET LOCAL ROLE` against `*_pence` columns.
- **Model B (`multi_tenant`, shared hosted compute):** Every tenant has its own isolated PostgreSQL database (`pg_tenant_<slug>_<env>`). Each tenant database is migrated independently by `migrate` (`guardedJob`), verifies only its own rows, maintains independent dual-write parity during Release N, and executes all pence roll-ups strictly scoped to `ctx.tenantId` (`assertRowTenant`, two-tenant PostgreSQL tests in `core/tests/pms-postgres.test.ts` and `core/tests/isolation.test.ts`).

## Alternatives Considered

1. **Store PMS money as SQL `NUMERIC(12,2)` instead of `BIGINT` pence:** Rejected. `NUMERIC(12,2)` arrives in Node.js as decimal strings (`'19.99'`) that still tempt developers into `Number(row.amount)` and float addition (`a + b`) before display, whereas `BIGINT` integer pence matches `@platform/core-api`'s `MinorUnits` and ADR 0038's `bigint` `amountMinorUnits`, enforces integer arithmetic in PostgreSQL and TypeScript, and cannot accumulate binary representation drift.
2. **Use round-half-to-even (banker's rounding) instead of round-half-away-from-zero:** Rejected. `core/src/domain/money/index.ts` already standardises on symmetric half-away-from-zero (`parseScaledHundredths`, `roundHalfAwayFromZeroFromBasisPoints`), UK VAT/billing conventions on quotes and matter costs use half-away-from-zero, and PostgreSQL's `ROUND(numeric)` natively implements symmetric half-away-from-zero.
3. **Drop the 20 `DOUBLE PRECISION` columns in the same migration (`0027`) rather than expand-then-contract:** Rejected (violates Architecture Standard Rule 8 and Stage 1 Risk `R7`). Dropping columns immediately prevents rollback to pre-WP3 code on a failed deployment and complicates live comparison against original values.
4. **Re-seed the demo tenant instead of migrating its existing data in place:** Rejected per owner decision (26 Nov 2026). In-place migration exercises the real upgrade path on live data before any hosted tenant relies on it; re-seeding remains a manual fallback only if verification fails and only with owner approval.

## Consequences

- **Positive:** All PMS figures, client ledger receipts/balances, corporate group sums, Home totals, and UI summaries become exact in integer pence (`0` float drift), unblocking safe exact-pence receipt matching in `S1-08`.
- **Negative / Costs:** `pms_*` tables carry duplicate `DOUBLE PRECISION` and `BIGINT` monetary columns during Release N until the Release N+1 contract migration (`B34`) drops the deprecated float columns. Row mappers and test fixtures carry additive `*Pence` properties alongside boundary GBP fields.
- **Compatibility:** `@platform/core-api` bumps cleanly from `'2.2.0'` to `'2.3.0'` (backward compatible with `^2.0.0` extension manifests); `CORE_REQUIRED_SCHEMA_VERSION` rises to `'0027'`.
