# S1-12: Legacy CMI Status Fix (`R816`) and PMS Money & Retainer Funds in Integer Pence (`B21`)

| | |
|---|---|
| Backlog | `B21` (PMS money stored and summed as floating-point pounds), carry-over `R816` (legacy Active + Pending CMI status parity), and item `6` (money on account integer-pence prerequisite) |
| Decision | Stage 0 exit decision `D6`; Owner decision 3 (26 Nov 2026: convert demo in place, re-seed fallback only with approval); Proposed [ADR 0041](../../decisions/0041-pms-money-as-integer-pence.md) |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP3 (`S1-12`, first slice of WP3) |
| Branch | `s1-12-pms-money-pence`, from `develop` (`a7e606c`), targeting `develop` |
| Change class | Carry-over host domain/repository fix (`R816`); Core `@platform/core-api` money helpers (additive v`2.3.0`, Rule 7); Core tenancy expand migration `0027` + conversion verifier (`afterUpSql`); Core PMS/matter repository reads/writes in integer pence; Host PMS workbook parser, finance roll-ups, and UI formatters; Plain-English Help update (`src/docs/`) |
| Layer | Core API (`core/src/api/`, `core/src/domain/money/`), Core tenancy (`core/src/tenancy/`), PMS importer (`src/pms/`), Host domain/server/UI (`src/`), Help docs (`src/docs/`) |
| Size | `M` (`1.75–2.0` days — includes carry-over `R816` as Commit 1; `payload_json` SQL conversion omitted) |
| Depends on | `S1-02a` (merged), WP2 (`S1-04` / `S1-05`) and PR #83 (`a7e606c` baseline); Proposed [ADR 0041](../../decisions/0041-pms-money-as-integer-pence.md) to be Accepted before coding |
| Blocking manual tasks | None in dev/test; existing Stage 1 §8 manual demo-deploy (`caj-migrate-demo`) converts demo data **in place** when WP3 deploys (re-seed is manual fallback only with owner approval at deploy time) |
| Baseline | `develop` at `a7e606c` |

---

## 1. Change Class and Layer Breakdown

| Part | Change class | Layer |
|---|---|---|
| **Carry-over `R816` (`R819`):** Pass `activeStatusIds` (resolved by `systemKey`) into `TenantMatterRepository` read options; compute `isLegacyCmiIncomplete` inside the repository for every row regardless of viewer permissions *before* CDD redaction; align status pill & SQL filter without seed IDs | Carry-over host domain & repository fix | `core/src/tenancy/matterRepository.ts`, `src/server/pageLoaders.ts`, `src/server/services.ts`, `src/domain/matterStatusDisplay.ts`, `src/domain/types.ts`, `core/tests/matter-cdd-redaction-r812.test.ts` |
| Additive minor-unit helpers (`pgBigIntToMinorUnits`, `minorUnitsToPgBigInt`, `subtractMinorUnits`, `formatMinorUnitsGbp`) and `CORE_API_VERSION = '2.3.0'` | Core extension API (additive, Rule 7) | `core/src/domain/money/index.ts`, `core/src/api/index.ts`, `core/docs/CHANGELOG.md` |
| Migration `0027_pms_money_and_retainer_pence_expand` (20 `BIGINT` `*_pence` PMS columns + `matters.retainer_monies_on_account_pence` + independent `afterUpSql` conversion checks + count/difference-only `migrate` job telemetry; `payload_json` not modified in SQL) | Core tenancy migration & job observability | `core/src/tenancy/migrations/index.ts`, `core/src/tenancy/tenantScopedRepository.ts`, `scripts/run-job.ts` |
| Stop reading 20 `DOUBLE PRECISION` columns; read `*_pence` + dual-write floats during Release N window; read the 12 `payload_json` money fields as exact SQL text via `poundsToMinorUnits`; integer pence `pmsRepository` calculations (`invoice`, `matterFinancials`, `wipBreakdown`, `clientAccount`); `matters.retainer_monies_on_account_pence` parity | Core tenancy repositories | `core/src/tenancy/pmsRepository.ts`, `core/src/tenancy/matterRepository.ts` |
| Exact decimal workbook parsing (`parseMoney` -> `poundsToMinorUnits`), integer roll-ups across domain/services/UI without float sums (`sumMinorUnits` / `subtractMinorUnits` / `formatMinorUnitsGbp`) | PMS importer, host domain, server, & UI | `src/pms/xlsxReader.ts`, `src/pms/importPms.ts`, `src/domain/pms.ts`, `src/server/services.ts`, `src/components/HomeClient.tsx`, `src/components/MatterFinanceTab.tsx`, `src/components/OrganisationProfileClient.tsx`, `src/components/PersonProfileClient.tsx`, `src/components/MatterProfileClient.tsx`, `src/components/QuoteDetailClient.tsx` |
| Plain-English Help note on exact pence calculation (`finance-data-and-permissions.ts`), release notes & technical docs | Help & docs (Rule 11) | `src/docs/articles/finance-data-and-permissions.ts`, `docs/guides/platform-technical-notes.md`, `docs/release-notes.md` |

---

## 2. What Exists Today (`develop` at `a7e606c`)

### 2.1 Carry-over `R816` (legacy Active + CDD Pending status/filter mismatch)
1. **Repository CDD redaction and SQL CMI filter (`core/src/tenancy/matterRepository.ts`):**
   - `redactMatterCddFields` (`:50–89`) overwrites `matter.amlStatus = REDACTED_MATTER_CDD_STATUS` (`'Not available to you'`, `:43`), sets `amlCompletedAt = null` (`:84`), and redacts `fieldValues.matterOpeningSnapshot.complianceOnboarding.amlStatus` (`:75`), invoked inside `applyMatterCddVisibility` (`:1909–1914`) at `:2884–2889` (`listVisibleMattersPageWithCount`) and across other loaders, plus defensively at `withPageShell` / `guardedAction` via `redactMatterCddInBrowserPayload` (`src/server/matterCddBoundary.ts:70–150`).
   - Meanwhile, `listVisibleMattersPageWithCount` (`core/src/tenancy/matterRepository.ts:2739–2758`, called by `loadMattersListPageData` at `src/server/pageLoaders.ts:2296–2364` with `canViewCdd: shell.canViewCdd`) matches legacy CMI-incomplete matters unconditionally in SQL (`:2742–2754`):
     ```sql
     m.status_id = $sIdx
     OR (
       m.status_id = ANY($activeIdx::text[])
       AND COALESCE(m.fields_json->'matterOpeningGate'->>'openedViaGate', 'false') <> 'true'
       AND m.opening_record_json->>'amlStatus' IN ('Pending', 'CMI incomplete')
     )
     ```
2. **Client-side status pill reads redacted `amlStatus` (`src/domain/matterStatusDisplay.ts`, `MattersListClient.tsx`, `MatterProfileClient.tsx`):**
   - `isMatterCmiIncompleteStatus` (`src/domain/matterStatusDisplay.ts:35–53`): for a legacy matter with `systemKey === 'active'` (`:46`) and `!isMatterOpenedViaOpeningGate(matter)` (`:47`), line `:50` checks `matter.amlStatus === 'Pending' || matter.amlStatus === 'CMI incomplete'`.
   - For Finance (`core/src/domain/rbac/registry.ts:1082–1108`, no `cdd:view`) and Enquiries / Intake (`:1242–1300`, no `cdd:view`), `matter.amlStatus` is `'Not available to you'`, so `isMatterCmiIncompleteStatus` returns `false` and `resolveMatterStatusPill` (`:62–109`, `:94–109`) returns **`'Open'`** instead of `'CMI incomplete'`.
   - On `/matters` (`src/components/MattersListClient.tsx:311–325, 407, 487, 867`) when filtering by "CMI incomplete", the server SQL returns legacy Active + Pending demo matter `M-000002` (`src/seed/demo.ts:1468`), so Finance sees `M-000002` inside the **"CMI incomplete"** filtered list wearing a green **"Open"** pill, and `MatterProfileClient.tsx:562–565, 1178` also shows **"Open"**.

### 2.2 Every `DOUBLE PRECISION` column in `core/src/tenancy/migrations/index.ts` (correcting B21's "22" count)
All `DOUBLE PRECISION` columns across the entire migration catalogue appear exclusively inside `PMS_PER_TENANT_MIGRATION_0013` (`core/src/tenancy/migrations/index.ts:1556–1881`). B21 (`docs/roadmap/feature-list.md:117`, `docs/roadmap/stage-1-plan.md:139`) counted all **22** `DOUBLE PRECISION` columns, whereas **20 are monetary columns** (19 GBP amounts + 1 GBP/hr charge-out rate) and **2 are non-monetary hours columns**:

| # | Table | Line | Column | Category | Action in `0027` (`S1-12`) |
|---:|---|---|---|---|---|
| 1 | `pms_fee_earners` | `1618` | `charge_out_rate` | Money (GBP/hr) | Expand -> `charge_out_rate_pence BIGINT NOT NULL DEFAULT 0` |
| 2 | `pms_matters` | `1644` | `fee_estimate` | Money (GBP) | Expand -> `fee_estimate_pence BIGINT NOT NULL DEFAULT 0` |
| 3 | `pms_matter_financials` | `1671` | `current_fee_estimate` | Money (GBP) | Expand -> `current_fee_estimate_pence BIGINT NOT NULL DEFAULT 0` |
| 4 | `pms_matter_financials` | `1672` | `wip_hours` | **Hours (non-money)** | **Retain as `DOUBLE PRECISION`** |
| 5 | `pms_matter_financials` | `1673` | `wip_value` | Money (GBP) | Expand -> `wip_value_pence BIGINT NOT NULL DEFAULT 0` |
| 6 | `pms_matter_financials` | `1674` | `total_time_value` | Money (GBP) | Expand -> `total_time_value_pence BIGINT NOT NULL DEFAULT 0` |
| 7 | `pms_matter_financials` | `1675` | `billed_fees_ex_vat` | Money (GBP) | Expand -> `billed_fees_ex_vat_pence BIGINT NOT NULL DEFAULT 0` |
| 8 | `pms_matter_financials` | `1676` | `billed_disb_ex_vat` | Money (GBP) | Expand -> `billed_disb_ex_vat_pence BIGINT NOT NULL DEFAULT 0` |
| 9 | `pms_matter_financials` | `1677` | `billed_vat` | Money (GBP) | Expand -> `billed_vat_pence BIGINT NOT NULL DEFAULT 0` |
| 10 | `pms_matter_financials` | `1678` | `billed_total_inc_vat` | Money (GBP) | Expand -> `billed_total_inc_vat_pence BIGINT NOT NULL DEFAULT 0` |
| 11 | `pms_matter_financials` | `1679` | `cash_received` | Money (GBP) | Expand -> `cash_received_pence BIGINT NOT NULL DEFAULT 0` |
| 12 | `pms_matter_financials` | `1680` | `outstanding_debt` | Money (GBP) | Expand -> `outstanding_debt_pence BIGINT NOT NULL DEFAULT 0` |
| 13 | `pms_matter_financials` | `1681` | `unbilled_disbursements` | Money (GBP) | Expand -> `unbilled_disbursements_pence BIGINT NOT NULL DEFAULT 0` |
| 14 | `pms_matter_financials` | `1682` | `client_account_balance` | Money (GBP) | Expand -> `client_account_balance_pence BIGINT NOT NULL DEFAULT 0` |
| 15 | `pms_fee_estimates` | `1699` | `estimated_fees_ex_vat` | Money (GBP) | Expand -> `estimated_fees_ex_vat_pence BIGINT NOT NULL DEFAULT 0` |
| 16 | `pms_invoices` | `1715` | `total_inc_vat` | Money (GBP) | Expand -> `total_inc_vat_pence BIGINT NOT NULL DEFAULT 0` |
| 17 | `pms_payments` | `1733` | `amount` | Money (GBP) | Expand -> `amount_pence BIGINT NOT NULL DEFAULT 0` |
| 18 | `pms_time_entries` | `1756` | `hours` | **Hours (non-money)** | **Retain as `DOUBLE PRECISION`** |
| 19 | `pms_time_entries` | `1757` | `value` | Money (GBP) | Expand -> `value_pence BIGINT NOT NULL DEFAULT 0` |
| 20 | `pms_disbursements` | `1778` | `amount_ex_vat` | Money (GBP) | Expand -> `amount_ex_vat_pence BIGINT NOT NULL DEFAULT 0` |
| 21 | `pms_client_account_entries` | `1798` | `amount` | Money (GBP) | Expand -> `amount_pence BIGINT NOT NULL DEFAULT 0` |
| 22 | `pms_client_account_entries` | `1799` | `balance_after` | Money (GBP) | Expand -> `balance_after_pence BIGINT NOT NULL DEFAULT 0` |

*(No other `REAL`, `FLOAT`, or `DOUBLE PRECISION` columns exist anywhere in `core/src/tenancy/migrations/index.ts`. Twelve additional PMS monetary values live inside `payload_json` JSONB — `annual_target_fees`, `credit_limit`, `fixed_fee_amount`, `disbursements_estimate`, `fees_net`, `disbursements_net`, `vat`, `rate`, `billed_value`, `write_off_value`, `vat_amount`, `gross_amount`. Because PostgreSQL `JSONB` stores JSON numbers as exact decimals, `TenantPmsRepository` reads them as SQL decimal text `payload_json->>'<key>'` and converts them via `poundsToMinorUnits` on read rather than rewriting `payload_json` in migration `0027`.)*

### 2.3 Complete inventory of `retainerMoniesOnAccountGbp`
- **`public.matters` (`core/src/tenancy/migrations/index.ts:941–988`):** **no dedicated SQL column**; persisted solely in JSONB (`costs_json` and `opening_record_json`).
- **`core/src/tenancy/matterRepository.ts`:** `TenantMatterRecord` (`:227`), `mapMatterRow` (`:486–489`: reads `costs_json.retainerMoniesOnAccountGbp ?? opening_record_json.retainerMoniesOnAccountGbp ?? null`), `buildMatterDbParameters` (`:601` writes `costs_json`; `:658` duplicates into `opening_record_json`).
- **`src/` domain, server & API:** `src/domain/types.ts:1011`, `src/domain/documentGeneration.ts:902`, `src/domain/matterCosts.ts:1029, 1035, 1094`, `src/domain/matterOpeningRecord.ts:422, 926, 950, 1726–1728, 2154`, `src/domain/openingGate.ts:192`, `src/domain/matterAiExtract.ts:85, 131, 228`, `src/app/api/matters/extract/route.ts:1294, 1307, 1528–1529, 1657, 1711`, `src/server/services.ts:8563–8566`.
- **`src/components/` UI:** `HomeClient.tsx:2618`, `MatterFormClient.tsx:1171–1173, 1536–1538, 2345–2346, 2818, 2842, 4714–4715, 4828–4829, 5090–5091, 5227–5228, 5312–5313, 8990, 11900`, `MatterProfileClient.tsx:696, 730, 755`.
- **Fixtures & tests:** `src/seed/demo.ts:1361–2625`, `data/seed-not-a-law-firm.json:18534–20500`, `core/tests/quick-fixes-s101.test.ts:136–518`, `core/tests/cdd-workflow-s104.test.ts:350, 1278`, `src/domain/__tests__/matterParties.test.ts:223`, `src/domain/__tests__/openingGate.test.ts:23, 70`.

### 2.4 Float conversions & raw float sums across repository, domain, services & UI
1. **`core/src/tenancy/pmsRepository.ts`:**
   - `round2(n)` (`:53–55`) uses `Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100`.
   - `computeDerivedInvoiceBalances` (`:514–625`): `Math.round(p.amount * 100)` (`:526`), `Math.round(inv.total * 100)` (`:536`), re-multiplies rounded floats (`:542–554`), float threshold checks `<= 0.005` / `> 0.005` (`:560, 567, 584, 586`), `round2(...)` (`:603–606`).
   - `computeDerivedMatterFinancials` (`:627–813`): `Math.round(ca.amount * 100)` (`:679`), `Math.round(te.value * 100)` (`:714–717`), `ib.outstanding > 0.005` (`:743`), double conversion `round2((Math.round(totalInvoicedIncVat * 100) - Math.round(totalPaid * 100)) / 100)` (`:753–760`), float division (`:774`), `round2` (`:700–702, 727–729, 769–772, 788`).
   - `computeDerivedMatterWipBreakdown` (`:815–896`): duplicate `Math.round(te.value * 100)` (`:857, 860`) and `round2` (`:879–880, 890–893`).
   - `importExtractDataset` (`:1382–1848`): writes floats via `round2(...)` (`:1489, 1549, 1620–1631, 1661, 1691, 1718, 1747, 1774, 1806–1811`) including raw float subtraction `round2(mf.total_invoiced_inc_vat - mf.fees_billed - mf.disbursements_billed)` (`:1604–1606`).
   - Row mappers (`:1850–2122`): `mapFeeEarnerRows` (`:1865–1869`, reads `payload_json` before SQL column), `mapClientRows` (`:1895`), `mapMatterRows` (`:1930–1931`), `mapFeeEstimateRows` (`:1964–1967`), `mapInvoiceRows` (`:1995–1998`), `mapPaymentRows` (`:2018`), `mapTimeEntryRows` (`:2049–2060`), `mapDisbursementRows` (`:2079–2081`), `mapClientAccountRows` (`:2105–2119`, recomputes `running_balance` from `row.amount` instead of trusting `balance_after`).
2. **Importer (`src/pms/xlsxReader.ts:148–153`, `src/pms/importPms.ts:210–524`):** `parseMoney` runs `Math.round((Number(val) + Number.EPSILON) * 100) / 100` across all 19 monetary workbook fields (`importPms.ts:210–524`), whereas `seedStoreBuilder.ts` (`:52, 211, 280`) and `storePostgresImport.ts` (`:849, 856`) delegate cleanly through `importPms` + `pmsRepo.importExtractDataset`.
3. **Domain & server roll-ups (`src/domain/pms.ts`, `src/server/financeServices.ts`, `src/server/services.ts`):**
   - `src/domain/pms.ts`: `formatGbp` (`:51–63`, float + `Number.EPSILON` & `n < -0.004`), `roundMoney2` (`:548–551`), float-to-pence `sumMoneyPence` (`:553–562`, called in `buildClientFinancialsFromRows` `:579–611` and `allFeeEarnerPerformance` `:829–842`), and raw float accumulations before rounding in `buildFeeEarnerWeeklyTime` (`:718, 733`) and `buildFirmFinanceRollups` (`:885, 910, 921–931, 948–971, 998–1001`).
   - `src/server/financeServices.ts`: delegates all calculations to `pmsRepo`, `buildFirmFinanceRollups`, and `buildFeeEarnerWeeklyTime` (`:488, 602, 617, 638, 705, 740`).
   - `src/server/services.ts:18338–18364` (`getClientPmsViewBundle`): sums 12 corporate-group fields via `round2(companies.reduce((acc, c) => acc + (c.financials ? fn(c.financials) : 0), 0))`.
4. **UI roll-ups & formatters:**
   - `src/components/HomeClient.tsx:460–484` (`firmWipTotal`, `firmTotalDebt`, `firmOverdueDebt`, `firmClientAccountHeld`, `firmUnbilledDisbNet`), `:1008–1013` (`notYetDueTotal`), `:4048–4056` (`aged_debt_by_age_band` sums).
   - `src/components/MatterFinanceTab.tsx:68–79` (`filteredTimeTotals`), `:218`, `:408` (`time_value_recorded - fixed_fee_amount`), `:448` (`fees_billed + unbilled_wip`), `:452, 543` (`currentEst * alertPct`), `:1052–1054` (unrounded `.reduce()`).
   - `OrganisationProfileClient.tsx:471–473`, `PersonProfileClient.tsx:634–643`, `MatterProfileClient.tsx:719–725`, `QuoteDetailClient.tsx:797, 830`.
5. **Existing core money helpers (`core/src/domain/money/index.ts:1–175`, re-exported at `core/src/api/index.ts:1946`):**
   Already provides `MinorUnits`, `BasisPoints`, `poundsToMinorUnits` (`gbpToPence`), `minorUnitsToPoundsString`, `minorUnitsToPounds` (`penceToGbp`), `percentToBasisPoints`, `roundHalfAwayFromZeroFromBasisPoints`, `calculateVatMinorUnits`, `sumMinorUnits` (exact decimal parser + `BigInt` symmetric half-away-from-zero). Missing PostgreSQL `BIGINT` parsing (`pg` returns `BIGINT` as decimal string), integer subtraction, and formatted GBP string helper.

---

## 3. Design & Functional Specification

### 3.1 Carry-over `R816` (`R819`, Commit 1 of `s1-12-pms-money-pence`)
- **Rule enforced:** Decide on the server, inside `TenantMatterRepository` and **before** CDD redaction runs, whether a legacy matter (not opened through the gate, active status resolved by `systemKey`, `amlStatus` in `{'Pending', 'CMI incomplete'}`) is CMI incomplete, and send ONLY that boolean flag (`isLegacyCmiIncomplete?: boolean`), never the underlying CDD outcome (`amlStatus`, `amlCompletedAt`, `complianceOnboarding.amlStatus`). **No `matter_status.*` literals anywhere** in `core/` or `src/domain/matterStatusDisplay.ts`.
- **Implementation:**
  1. Add optional `readonly isLegacyCmiIncomplete?: boolean` to `Matter` (`src/domain/types.ts`) and `TenantMatterRecord` (`core/src/tenancy/matterRepository.ts`).
  2. Pass `activeStatusIds?: readonly string[]` (resolved by callers from `matter_status` choice values where `systemKey === 'active'`, just as `loadMattersListPageData` in `src/server/pageLoaders.ts:2301–2305, 2358` already resolves `activeStatusIds`) into `TenantMatterRepository` read options (`getMatterById`, `listVisibleMatters`, `listVisibleMattersPageWithCount`, `listVisibleMattersByIds`, and `MatterVisibilityOptions`) and forward `activeStatusIds` to `mapMatterRow`.
  3. Inside `TenantMatterRepository` (`mapMatterRow`), **for every row, whatever the viewer can see** (before `applyMatterCddVisibility` and regardless of `canViewCdd`, so a payload redacted later by `redactMatterCddInBrowserPayload` at `withPageShell` or `guardedAction` still carries the flag), compute:
     - `const isActive = Boolean(activeStatusIds?.length && activeStatusIds.includes(row.status_id ?? ''));`
     - `const openedViaGate = row.is_pms_import !== true && (row.fields_json?.matterOpeningGate as { openedViaGate?: unknown } | undefined)?.openedViaGate === true;`
     - `isLegacyCmiIncomplete = isActive && !openedViaGate && (rawAmlStatus === 'Pending' || rawAmlStatus === 'CMI incomplete')`
     - **When `activeStatusIds` is omitted or empty, `isLegacyCmiIncomplete` is `false`.**
     *(Inside `redactMatterCddFields` `:50–89`, preserve existing `matter.isLegacyCmiIncomplete` untouched without referencing any seed ID.)*
  4. Update `isMatterCmiIncompleteStatus` (`src/domain/matterStatusDisplay.ts:35–53`): on `sysKey === 'active'`, if `isMatterOpenedViaOpeningGate(matter)` is `false`, check `if (typeof matter.isLegacyCmiIncomplete === 'boolean') return matter.isLegacyCmiIncomplete;` before falling back to `matter.amlStatus === 'Pending' || matter.amlStatus === 'CMI incomplete'` (for non-DB unit-test fixtures that don't go through `TenantMatterRepository`).
  5. Result:
     - **Every viewer** (Fee Earner, Partner, Finance, Enquiries) sees the exact same `"CMI incomplete"` warning pill (`MattersListClient.tsx:487, 867`, `MatterProfileClient.tsx:562–565, 1178`) and urgent indicator (`:407`) on seeded legacy Active + Pending matters such as `M-000002`, and `/matters` **"CMI incomplete"** filter agrees with the pill 100%.
     - For Finance and Enquiries, `amlStatus` stays `'Not available to you'`, `amlCompletedAt` stays `null`, and `matterOpeningSnapshot.complianceOnboarding.amlStatus` stays `'Not available to you'` — satisfying `R812`, `R816`, and `R819`. Gate-opened Active matters (`openedViaGate === true`) continue displaying `"Open"` (`R810`).

### 3.2 `@platform/core-api` money helpers (bump `CORE_API_VERSION` to `'2.3.0'`)
Add cleanly in `core/src/domain/money/index.ts` (automatically re-exported by `core/src/api/index.ts:1946` and `core/src/index.ts:10`):
- `pgBigIntToMinorUnits(value: string | number | bigint, label?: string): MinorUnits`
- `minorUnitsToPgBigInt(minorUnits: MinorUnits): string`
- `subtractMinorUnits(minuend: MinorUnits, subtrahend: MinorUnits): MinorUnits`
- `formatMinorUnitsGbp(minorUnits: MinorUnits, options?: { accountingBrackets?: boolean; omitZeroPence?: boolean }): string`

### 3.3 Zero float math across PMS importer, repository, domain, services & UI
1. **Workbook import (`src/pms/xlsxReader.ts:148–153`, `src/pms/importPms.ts`):**
   - Replace `parseMoney` float arithmetic with `poundsToMinorUnits` (exact decimal string parsing, rejecting exponential/corrupt strings and preserving integer `*Pence` fields on `PmsExtractDataset` alongside boundary GBP values via `minorUnitsToPounds`).
2. **Repository boundary (`core/src/tenancy/pmsRepository.ts`, `matterRepository.ts`):**
   - Add additive integer `*Pence` fields onto all PMS extract interfaces (`charge_out_rate_pence`, `fee_estimate_pence`, `wip_value_pence`, `outstanding_debt_pence`, `client_account_balance_pence`, `amount_pence`, etc.) and `TenantMatterRecord.retainerMoniesOnAccountPence` / `Matter.retainerMoniesOnAccountPence`.
   - Update `map*Rows`, `computeDerivedInvoiceBalances`, `computeDerivedMatterFinancials`, `computeDerivedMatterWipBreakdown`, and `importExtractDataset` to operate **solely** in `MinorUnits` using `sumMinorUnits` / `subtractMinorUnits` / `pgBigIntToMinorUnits` / `poundsToMinorUnits` (zero `Math.round(x * 100)` or `round2` calls; thresholds checked as `<= 0` / `> 0` pence instead of `0.005`), reading solely `*_pence` columns on SQL `SELECT`, reading the 12 `payload_json` money fields as exact SQL decimal text (`payload_json->>'<key>'`) converted via `poundsToMinorUnits` on read (no SQL JSONB conversion), and dual-writing both `*_pence` and legacy float columns during Release N.
   - `Matter.retainerMoniesOnAccountPence` persists to `public.matters.retainer_monies_on_account_pence` and syncs `retainerMoniesOnAccountGbp` at boundary via `minorUnitsToPounds`.
3. **Domain, server, and UI roll-ups:**
   - Rewrite `src/domain/pms.ts` (`formatGbp`, `sumMoneyPence` -> `sumMinorUnits`, `buildClientFinancialsFromRows`, `allFeeEarnerPerformance`, `buildFeeEarnerWeeklyTime`, `buildFirmFinanceRollups`), `src/server/services.ts` (`getClientPmsViewBundle`), `HomeClient.tsx`, `MatterFinanceTab.tsx`, `OrganisationProfileClient.tsx`, `PersonProfileClient.tsx`, `MatterProfileClient.tsx`, and `QuoteDetailClient.tsx` to aggregate integer `*Pence` values via `sumMinorUnits` / `subtractMinorUnits` and format via `formatMinorUnitsGbp` (no `reduce((s, x) => s + floatField, 0)` anywhere on currency).

---

## 4. Data Model, Expand Migration `0027`, Verification & Rollback Plan

### 4.1 Expand migration `0027_pms_money_and_retainer_pence_expand`
- **Version:** `'0027'` (`CORE_REQUIRED_SCHEMA_VERSION = '0027'` in `core/src/tenancy/tenantScopedRepository.ts:26`, `dependsOn: ['0009', '0013']`).
- **Default runtime privileges:** Cluster bootstrap covers new `*_pence` columns automatically; no new audit table is needed because `payload_json` is not modified in SQL.
- **`upSql`:**
  1. `ALTER TABLE` on all 9 `pms_*` tables adding the 20 `BIGINT NOT NULL DEFAULT 0` `*_pence` columns listed in §2.2 (explicitly leaving `pms_matter_financials.wip_hours` and `pms_time_entries.hours` untouched as `DOUBLE PRECISION`).
  2. `ALTER TABLE public.matters ADD COLUMN IF NOT EXISTS retainer_monies_on_account_pence BIGINT NULL CHECK (retainer_monies_on_account_pence IS NULL OR retainer_monies_on_account_pence >= 0);`.
  3. Validate no non-finite (`'NaN'`, `'Infinity'`, `'-Infinity'`) or out-of-safe-integer (`ABS(col) > 90071992547409.91`) float exists in any of the 20 PMS columns or `retainerMoniesOnAccountGbp`, then convert in place via PostgreSQL `numeric` symmetric half-away-from-zero:
     `ROUND((col::numeric) * 100)::bigint`.
  4. Backfill `public.matters.retainer_monies_on_account_pence` from `COALESCE(NULLIF(costs_json->>'retainerMoniesOnAccountGbp', ''), NULLIF(opening_record_json->>'retainerMoniesOnAccountGbp', ''))::numeric` (`ROUND(val * 100)::bigint`). (`pms_*.payload_json` is left untouched in SQL and parsed as exact text via `poundsToMinorUnits` on read.)

### 4.2 Independent conversion check & `migrate` job logging (`R820`, Owner Decision 3)
- **`afterUpSql` verification (inside the `0027` migration transaction):**
  - Runs three independent checks across all 20 monetary columns across the 9 `pms_*` tables and `public.matters.retainer_monies_on_account_pence` (no `payload_json` keys checked because `payload_json` is not rewritten in SQL):
    1. **Round-trip check on every non-null row:** verify `ABS((pence_col::numeric / 100.0) - orig_col::numeric) < 0.005` (with exact half-penny ties `ABS((pence_col::numeric / 100.0) - orig_col::numeric) = 0.005` additionally verifying away-from-zero direction `ABS(pence_col::numeric) > ABS(orig_col::numeric) * 100`).
    2. **Per-column totals check:** compare `COALESCE(SUM(pence_col), 0)::bigint` against `COALESCE(ROUND(SUM(orig_col::numeric) * 100), 0)::bigint`, requiring a tolerance of at most **1 penny per non-null row** (`ABS(sum_pence - round_sum_float_pence) <= non_null_count`), and record only the per-column difference (`totalDiffPence`).
    3. **Row count and non-null count parity:** verify that each table's total row count and each `*_pence` column's non-null count match its source column.
  - **Fail-closed:** If any check fails (or any non-finite / out-of-safe-range value is detected), throw `PMS_PENCE_CONVERSION_MISMATCH`, rolling back the entire `0027` transaction atomically so nothing half-converted is ever committed.
- **Structured zero-PII logging on `migrate` (`scripts/run-job.ts:347–420`):**
  - Emits `job.migrate.pms_pence_verified` containing **ONLY counts and per-column differences** (`tenantId`, `correlationId`, `databaseName`, `tablesVerified: 10`, `totalRowsChecked`, `totalNonNullChecked`, `totalColumnsVerified: 21`, `mismatchCount: 0`, `maxColumnTotalDiffPence`, and per-column `{ table, column, rowCount, nonNullCount, totalDiffPence }`) — **never** money sums, client names, matter titles, or money values tied to any row. This output is recorded in the WP3 deploy report to prove the in-place demo conversion was verified cleanly.

### 4.3 Rollback (`R821` Option (b)), Deploy Runbook Steps & Release N+1 Contract Path (Rule 8, Owner Decision 3)
- **`downSql` (reversible):** Drops `retainer_monies_on_account_pence` from `public.matters` and drops the 20 `*_pence` columns from the 9 `pms_*` tables — preserving the original `DOUBLE PRECISION` columns and `payload_json` untouched.
- **App-only rollback rule (`R821` — option (b) chosen over SQL sync trigger):** Rolling the application back to a pre-`S1-12` release after `0027` is applied **always requires running migration `0027` down**, because pre-`S1-12` code writes only the legacy float columns and `retainerMoniesOnAccountGbp` JSONB field, which would otherwise leave `*_pence` columns stale on subsequent redeployment. Re-deploying `S1-12` later runs `0027` up again, re-doing the full backfill and independent verification check from the up-to-date legacy columns.
- **Deploy & rollback runbook steps (documented in `docs/runbooks/demo-deployment.md` in Commit 5):**
  1. **Deploy `S1-12`:** Run `caj-migrate` (`0027` up) -> confirm `job.migrate.pms_pence_verified` logs `mismatchCount: 0` -> deploy the `S1-12` web/job container image.
  2. **Rollback to pre-`S1-12` (if ever needed after `0027`):** (1) Stop traffic / scale web containers to zero; (2) run `0027` down using the **`S1-12`** image (`migrate --down --target 0027 --confirm-rollback` or `PLATFORM_MIGRATE_DOWN_TARGET=0027` + `PLATFORM_MIGRATE_DOWN_CONFIRM=true`); (3) confirm every tenant's schema version is `0026` (`job.migrate.down`); (4) roll web and job containers back to the previous pre-`S1-12` release image and restore scaling. Never leave `0027` applied while running pre-`S1-12` application code, and never run down mode from a pre-`S1-12` image that lacks `0027`'s `downSql`.
  3. **Re-deploy `S1-12` after a rollback:** Run `caj-migrate` (`0027` up) again to re-backfill all 20 PMS monetary columns and `retainer_monies_on_account_pence` and re-run the independent `afterUpSql` checks before bringing `S1-12` containers online.
- **Demo fallback policy (Risk `R7` amended):** On demo deploy (`caj-migrate-demo`), existing data converts **in place**; demo is NOT re-seeded. Re-seeding is an emergency fallback **only** if `0027` verification fails, and **only** with owner approval at deploy time.
- **Release N+1 contract migration (backlog `B34`):** Dropped in a future post-WP3 contract migration once `S1-12` rollback window closes (`wip_hours` and `hours` retained).

---

## 5. Configuration Schema Changes

**None required.** Integer pence representation is a platform data-integrity invariant (`B21`, Architecture Standard §12), not a per-tenant configuration option. `core/schemas/tenant-config.schema.json` and `client-not-a-law-firm/config/base.json` require zero schema changes in `S1-12` (though `client-not-a-law-firm` workbook parsing consumes `poundsToMinorUnits`).

---

## 6. Permissions, Action Policies & Role Matrix

- **No new permissions, actions, routes, or CLI jobs** in `S1-12` (so `PERMISSION_REGISTRY` stays `81 / 71 / 10`, `ACTION_PERMISSIONS` stays `140`, `ROUTE_PERMISSIONS` stays `16` until `S1-06`).
- All existing PMS finance permissions (`finance:view`, `finance:view_matter`, `finance:credit_control`, `finance:manage_links` + `mfaVerified: true`), `matter:create`/`matter:edit`, and `tenant:migrate` remain unchanged.

---

## 7. Visibility, Isolation, `R812` CDD Redaction & `S1-09` Composition

1. **`R812` CDD-redaction compliance:**
   - `R816` computes `isLegacyCmiIncomplete` **before** `redactMatterCddFields` (`core/src/tenancy/matterRepository.ts:50–89`) redacts `amlStatus`, `amlCompletedAt`, and `complianceOnboarding.amlStatus`. The client payload receives ONLY the derived boolean status-pill signal (`isLegacyCmiIncomplete`), never raw `amlStatus` (`'Pending'` / `'Verified'` / `'Failed'`) or CDD timestamps. `redactMatterCddInBrowserPayload` (`src/server/matterCddBoundary.ts:70–150`) remains intact at `withPageShell` and `guardedAction`.
2. **Existing P4/P8 finance isolation preserved:**
   - All six firm/client/FE roll-ups rewritten to integer pence keep the identical `canPersonAccessMatter` / restricted-matter exclusions (`R526`, `R546`, Owner D1 caveat).
   - No whole-tenant loads added anywhere (`PERMANENT_ALLOW_LIST` and `B15_TAIL_ALLOW_LIST` in `noWholeTenantLoadInRequestPaths.test.ts` never grow).
3. **`S1-09` information barrier composition:**
   - No new request-path SQL queries bypass `buildMatterHiddenFromViewerSql` or `canPersonAccessMatter`; pence roll-ups consume already visibility-filtered SQL rows.
4. **Two-tenant & tampered-ID guarantees (Rule 9):**
   - Migration `0027` backfill, conversion verification, dual-writes, and `TenantPmsRepository` queries scope strictly by `ctx.tenantId` + `SET LOCAL ROLE` + `assertRowTenant`.

---

## 8. Help and Documentation (Rule 11 & Stage 1 §6 Rule 6)

Plain British English for firm users (zero code identifiers, column names, or migration numbers in Help copy):
- **Updated Help (`src/docs/articles/finance-data-and-permissions.ts`):** Update the existing finance/PMS section in plain English to explain that PMS figures and matter client-account balances are reconciled to the exact penny with no rounding drift across summaries, and clarify that legacy active matters still awaiting initial CMI checks display consistent `"CMI incomplete"` status badges to fee earners and finance alike (without exposing confidential CDD details to Finance).
- **Technical docs (`docs/guides/platform-technical-notes.md`, `docs/release-notes.md`, `core/docs/CHANGELOG.md`):** Document `ADR 0041`, `@platform/core-api` v`2.3.0` additive money helpers, migration `0027` convert-in-place verification, exact list of 20 monetary vs 2 hours columns, Release N dual-write compatibility, and `R816` legacy CMI status fix.

---

## 9. Tests, Guards & Build-Phase Cadence

1. **Carry-over `R816` (`R819`) tests (`core/tests/matter-cdd-redaction-r812.test.ts`, `src/domain/__tests__/matterStatusDisplay.test.ts`):**
   - Seeded legacy Active + CDD Pending matter (`M-000002`-style without `openedViaGate`) viewed as **`finance`** (no `cdd:view`) shows `"CMI incomplete"` pill, appears under `/matters` `"CMI incomplete"` filter, AND has `amlStatus === 'Not available to you'` and `amlCompletedAt === null`. Positive control: gate-opened Active matter shows `"Open"` (`R810`) and is excluded from `"CMI incomplete"` filter.
   - Verify `TenantMatterRepository` computes `isLegacyCmiIncomplete` for every row regardless of `canViewCdd` (so subsequent `redactMatterCddInBrowserPayload` keeps `isLegacyCmiIncomplete === true`), sets `isLegacyCmiIncomplete = false` when `activeStatusIds` is omitted or empty, and contains **zero `matter_status.*` literals** in `core/` or `src/domain/matterStatusDisplay.ts`.
2. **Money helper & property-style rounding tests (`core/tests/money.test.ts`):**
   - `pgBigIntToMinorUnits`, `minorUnitsToPgBigInt`, `subtractMinorUnits`, `formatMinorUnitsGbp` (brackets, whole-pound formatting, boundaries).
   - Property-style tests (seeded deterministic generator across `10,000+` positive/negative amounts including half-way ties `±0.005`, `±19.995`, large balances up to `£100m`, `-0.00`, classic binary-float pitfalls like `0.1 + 0.2`, `19.99 * 100`, `1.005`) proving exact parity between `poundsToMinorUnits` and PostgreSQL `ROUND((col::numeric) * 100)::bigint`.
3. **Migration `0027` & demo conversion verification (`core/tests/migrations-postgres.test.ts`, `core/tests/pms-postgres.test.ts`):**
   - Full `0027` `up -> down -> up` round-trip test checking 20 converted columns, untouched `wip_hours`/`hours`, `matters.retainer_monies_on_account_pence`, untouched `payload_json` (parsed as exact SQL text via `poundsToMinorUnits` on repository read), and all three independent `afterUpSql` checks (round-trip `< 0.005` + tie direction, per-column totals within 1p/row, row + non-null counts).
   - **Failure / rollback test (`R820`):** corrupt a converted `*_pence` value **after** the backfill (before running the verification check) and prove `PMS_PENCE_CONVERSION_MISMATCH` fails and rolls back `0027` cleanly without modifying the database.
   - Full seeded demo conversion test importing `data/pms/1Squared_PMS_Demo_Data.xlsx` and `data/seed-not-a-law-firm.json` via legacy float path then running `0027`, asserting `mismatchCount === 0` across every row and comparing integer-pence roll-ups (`src/domain/pms.ts`, `getFirmFinance`, `getClientPmsViewBundle`) against exact decimal totals (zero `0.01` drift).
   - Two-tenant PG16 isolation test on `tenant-alpha` vs `tenant-bravo` proving independent `*_pence` conversion, reads, and `retainer_monies_on_account_pence` isolation.
4. **Guards (`src/server/__tests__/noWholeTenantLoadInRequestPaths.test.ts`, `actionPermissionGuard.test.ts`):** Zero new allow-list entries.
5. **Existing test files touched by `S1-12`:**
   `core/tests/migrations-postgres.test.ts` (`:2838` `CORE_REQUIRED_SCHEMA_VERSION`), `core/tests/money.test.ts`, `core/tests/pms-postgres.test.ts`, `src/pms/pms.test.ts`, `src/domain/home.test.ts`, `core/tests/matter-cdd-redaction-r812.test.ts`, `core/tests/quick-fixes-s101.test.ts`, `src/domain/__tests__/matterStatusDisplay.test.ts`.
6. **Build-phase test cadence:**
   - After each commit / at end of `s1-12-pms-money-pence`: run `npx tsc --noEmit`, `npm run lint`, ONLY the changed/new test files (`npx vitest run core/tests/matter-cdd-redaction-r812.test.ts core/tests/money.test.ts core/tests/pms-postgres.test.ts core/tests/migrations-postgres.test.ts src/pms/pms.test.ts src/domain/home.test.ts src/domain/__tests__/matterStatusDisplay.test.ts`), and `npx vitest run isolation`. (Reserve full `npm run ci` and `npm run e2e` for the top WP3 branch `s1-08-money-on-account`.)

---

## 10. Expected `docs/roadmap/feature-list.md` Updates

When `S1-12` lands:
- **`B21`:** Change status from `Not started` to **`Completed`**; update "What exists" to note the 20 monetary PMS columns (leaving `wip_hours` and `hours` as `DOUBLE PRECISION`) + `matters.retainer_monies_on_account_pence` expanded to signed `BIGINT` pence in `0027` (`payload_json` money keys read as SQL text via `poundsToMinorUnits`), automated independent `afterUpSql` checks (round-trip, per-column totals, row/non-null counts), `@platform/core-api` v`2.3.0` integer-pence helpers, zero float sums across repository/domain/UI, two-tenant PostgreSQL/property tests, and `finance-data-and-permissions` Help update; set "What's missing" to `"Release N+1 contract migration to drop deprecated DOUBLE PRECISION columns tracked in B34."`
- **Backlog `B34`:** Already logged in `docs/roadmap/feature-list.md` (`Contract migration to drop 20 deprecated DOUBLE PRECISION PMS monetary columns`, `Stage: Before first hosted client`).
- **Row `6`:** Narrow "What's missing" to remove "(B21 -> S1-12)".

---

## 11. Commit Breakdown (Each Independently Testable)

1. **`fix(r816): resolve activeStatusIds by systemKey and compute isLegacyCmiIncomplete in repository before CDD redaction`** (`core/src/tenancy/matterRepository.ts`, `src/server/pageLoaders.ts`, `src/server/services.ts`, `src/domain/matterStatusDisplay.ts`, `src/domain/types.ts`, `core/tests/matter-cdd-redaction-r812.test.ts`, `src/domain/__tests__/matterStatusDisplay.test.ts`).
2. **`feat(s1-12): add pgBigInt, subtractMinorUnits, and formatMinorUnitsGbp helpers to @platform/core-api v2.3.0`** (`core/src/domain/money/index.ts`, `core/src/api/index.ts`, `core/docs/CHANGELOG.md`, `core/tests/money.test.ts`).
3. **`feat(s1-12): add migration 0027 expanding 20 PMS money columns and retainer funds to BIGINT pence with independent conversion checks`** (`core/src/tenancy/migrations/index.ts`, `core/src/tenancy/tenantScopedRepository.ts`, `scripts/run-job.ts`, `core/tests/migrations-postgres.test.ts`).
4. **`feat(s1-12): move PMS repository (incl. payload_json text parsing), matter retainer storage, workbook parser, and roll-ups/UI onto integer pence`** (`core/src/tenancy/pmsRepository.ts`, `core/src/tenancy/matterRepository.ts`, `src/pms/`, `src/domain/pms.ts`, `src/server/services.ts`, `src/components/`, `core/tests/pms-postgres.test.ts`, `src/pms/pms.test.ts`, `src/domain/home.test.ts`).
5. **`docs(s1-12): update Finance Help article, deploy/rollback runbook, release notes, and feature-list B21`** (`src/docs/articles/finance-data-and-permissions.ts`, `docs/runbooks/demo-deployment.md`, `docs/`).

---

## 12. Draft Owner Spot Checks (Summary — Consolidated Checklist in `S1-08` §12)

- **R816:** Signed in as **Finance**, locate seeded legacy matter `M-000002` (Active + CDD Pending): confirm it displays `"CMI incomplete"` (matching a Fee Earner's view), appears when filtering Matters by **"CMI incomplete"**, and continues showing `Client due diligence: Not available to you`.
- **S1-12:** Review the WP3 deploy report's `job.migrate.pms_pence_verified` log confirming `0` mismatches and only counts/per-column differences across the in-place demo conversion; verify Home PMS totals, Client Finance, Matter Finance Tab, and `Client account balance` render accurately to two decimal places with identical pence totals across tabs.

---

## 13. Risks & Open Questions

- **Risk — Negative/boundary IEEE-754 float mismatch during in-place backfill:** Mitigated by PostgreSQL `ROUND((col::numeric) * 100)::bigint` + pre-check for `NaN`/`Infinity`/safe bounds + fail-closed independent `afterUpSql` checks aborting cleanly before commit (preserving demo data untouched).
- **Risk — Unindexed `WIP hours` confusion:** Mitigated by documenting explicitly in `ADR 0041` and `migration 0027` why 2 of the 22 `DOUBLE PRECISION` columns (`wip_hours`, `hours`) stay floating-point hours.
- **Open questions:** None.

---

## 14. Estimate (`1.75–2.0` days)

- Commit 1 (`R816` / `R819`): `0.25` day.
- Commits 2–3 (`@platform/core-api` v`2.3.0` + `0027` migration without `payload_json` SQL conversion + independent `afterUpSql` verifier + property/PG16 tests): `0.5–0.75` day.
- Commits 4–5 (`pmsRepository` + `payload_json` text parsing + `xlsxReader` + all UI/domain roll-ups + Help + runbook + demo verification test): `1.0` day.
- **Total `S1-12`:** **`1.75–2.0` days**.
