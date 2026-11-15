# S0-23 — Rates and Charging (Core Money Helpers, Configurable VAT Rate and Immutable Snapshots)

| Field | Value |
|---|---|
| Slice | `S0-23` |
| Stage / Work package | Stage 0C — Make it shared (`WP5a`) |
| Status | Planned (ready to build on `s0-23-rates-and-charging`) |
| Branch | `s0-23-rates-and-charging` (target `develop`) |
| Depends on | `S0-17c` (already merged on `develop`) |
| Size | `M` |
| Backlog IDs | `30` (remains `Partly built` until `S0-28` delivers negotiated overrides and CFA/DBA; advances `3`, `7`, `44`, `P7`; cross-cutting `P10`, `P11`) |
| Decision record(s) | `D10` — [ADR 0034 §1](../decisions/0034-fee-arrangements-and-caps.md#1-integer-minor-unit-money-helpers-configurable-vat-and-immutable-snapshots-s0-23) (`Accepted`) |
| Spec / standards references | Architecture Standard sections 4, 5, 6, 7, 10, 12; [RBAC Reference](../rbac-reference.md) |

---

## 1. Purpose

Deliver the `S0-23` foundation for backlog item `30` (*Rates and charging*) and activate the `[x-reserved:S0-23]` `matterCosts` tenant configuration keys (`P7`):

- Extract integer minor-unit money maths into a shared pure core helper module (`core/src/domain/money/index.ts`) using `BigInt` rounding (`roundHalfAwayFromZeroFromBasisPoints`).
- Make the standard UK VAT percentage (`matterCosts.vatRatePercent`, default `20`, range `0..100`) tenant-configurable rather than hardcoded `20%`, flowing cleanly into Quotes and Matter Costs.
- Retire all `[x-reserved:S0-23]` schema markers on `matterCosts` settings and cover rate lookup, costs snapshots, quote maths and **immutable saved/signed-off snapshots** with thorough unit, RBAC and two-tenant tests plus Help updates.

Item `30` remains `Partly built` on `feature-list.md` until `S0-28` completes 4-tier negotiated rate overrides and CFA/DBA terms.

---

## 2. Classification & Architectural Layer

- **Classification:** Core pure domain module (`core/src/domain/money/index.ts`) + configuration schema activation (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`) + host domain/service wiring (`src/domain/matterCosts.ts`, `src/domain/quotes.ts`).
- **Single-tenant and multi-tenant operation:** Identical build. All money calculations are pure functions in core, and `matterCosts` config lives per tenant in `public.tenant_module_configs` (`TenantCatalogueRepository.getMatterCostsConfig` / `putMatterCostsConfig`).

---

## 3. Existing Code & Schema

- **Database schema version on `develop`:** `0015` (`CORE_REQUIRED_SCHEMA_VERSION = '0015'` in `core/src/tenancy/tenantScopedRepository.ts:26`).
- **Reserved `matterCosts` schema keys:** `core/schemas/tenant-config.schema.json:178-235` carries `[x-reserved:S0-23]` metadata; read/merged in `core/src/config-engine/index.ts:707-745` and asserted by `core/tests/tenant-config-usage.test.ts:1-250`.
- **Matter costs domain & repo:** `lookupRatesForMatter` (`src/domain/matterCosts.ts:318`), `calculateDisbursementsTotal` (`:378`), `resolveMatterCostsSnapshot` (`:418`), `TenantCatalogueRepository.getMatterCostsConfig` / `putMatterCostsConfig` (`core/src/tenancy/catalogueRepository.ts:1148-1154`), `signOffMatterCostsRecord` (`src/server/services.ts:6933`), `signOffMatterCostsAction` (`src/app/actions.ts:343`).
- **Quote maths:** `QUOTE_FEE_BASES`, `roundCurrency`, `calculateQuoteTotals` (`src/domain/quotes.ts:22-100`).
- **Extension alignment:** Check `client-not-a-law-firm/extensions/nalf-matter-costs-governance/src/index.ts:22` consumes the same public rates/snapshot shape cleanly.

---

## 4. Scope & Exact Changes

### 4.1 Pure integer-minor-unit money helpers (`core/src/domain/money/index.ts`)

- Create `core/src/domain/money/index.ts` (and re-export needed public helpers from `@platform/core` / `@platform/core-api` as appropriate):
  - Integer minor-unit (pence) conversion helpers (`gbpToPence`, `penceToGbp`, formatting/parsing without IEEE-754 float drift).
  - Exact **`roundHalfAwayFromZeroFromBasisPoints`** using native JavaScript `BigInt` (`(amountMinorUnits * basisPoints) / 10_000n` with half-away-from-zero remainder handling — handles positive, zero and negative minor units identically without floating-point inaccuracy).
  - VAT calculation helper in minor units (`calculateVatMinorUnits`) taking `(netMinorUnits, vatRateBasisPoints)`.

### 4.2 Activate `matterCosts.vatRatePercent` and retire `[x-reserved:S0-23]` (`P7`)

- Add `matterCosts.vatRatePercent` (`type: 'number'`, `minimum: 0`, `maximum: 100`, `default: 20`, clear description) in `core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `MatterCostsConfig` (`src/domain/types.ts:1722`) and `createDefaultMatterCostsConfig` (`src/domain/matterCosts.ts:57`).
- Activate all `[x-reserved:S0-23]` keys in `matterCosts.*` (`core/schemas/tenant-config.schema.json:178-235`), wire them cleanly at runtime where applicable, remove `[x-reserved:S0-23]` tags in schema + `core/src/config-engine/index.ts:707-745`, and update `core/tests/tenant-config-usage.test.ts` so the reserved-key ledger passes cleanly.
- Wire configurable `vatRatePercent` into Admin Matter Costs config UI (with MFA check on save) and default rate/VAT resolution.

### 4.3 Quote maths, costs snapshot and immutability guarantees (`ADR 0034 §1`)

- Replace hardcoded `20%` VAT maths in `calculateQuoteTotals` (`src/domain/quotes.ts`) and `calculateDisbursementsTotal` / `resolveMatterCostsSnapshot` (`src/domain/matterCosts.ts`) with integer-minor-unit calculations using the snapshot's or tenant config's `vatRatePercent` (supporting per-disbursement `vatApplicable` and explicit `vatOverridden`).
- Persist `vatRatePercent` (and `capturedAt` / resolved rate provenance) on saved/signed-off `MatterCostsSnapshot` and `Quote` version snapshots.
- **Immutability invariant:** Once a `MatterCostsSnapshot` or `Quote` version is saved or signed off, changing `matterCosts.vatRatePercent` or rate card hourly rates in tenant settings MUST NOT retroactively recalculate or alter those saved/signed-off records unless the user explicitly initiates a rate refresh / new quote version.

### 4.4 Out of Scope

- Four-tier negotiated override tables (`public.client_rate_overrides`, `public.matter_rate_overrides`) and CFA/DBA fee bases & statutory caps (`S0-28`).
- Any PostgreSQL schema migration (`0015` stands; negotiated override tables arrive in `0016` during `S0-28`).

---

## 5. Migrations & Backwards Compatibility

- **Migration required:** `None`. `CORE_REQUIRED_SCHEMA_VERSION` stays `'0015'`.
- Existing quotes and matter costs records without a stored `vatRatePercent` default cleanly to `20` on read without altering historical totals.

---

## 6. Security, Tenancy & Permissions

- Saving `matterCosts` config requires admin/finance config permission + `mfaVerified === true` via `guardedAction`.
- `signOffMatterCostsAction` (`src/app/actions.ts:343`) and quote/matter save actions enforce existing RBAC (`finance:view` / `matter:edit` / `canAccessMatter` on restricted staff & ethical-wall matters) and write audit entries inside the tenant transaction.
- `client-not-a-law-firm/extensions/nalf-matter-costs-governance` uses `@platform/core-api` types only (Rule 3).

---

## 7. Tests Required

1. **Money & `BigInt` rounding tests (`core/tests/money.test.ts`):** Verify `roundHalfAwayFromZeroFromBasisPoints` across exact `.5` ties (`0.005` -> `0.01`, `-0.005` -> `-0.01`), large multi-million-pound values (no IEEE-754 overflow/drift), 0%, 5%, 17.5%, 20% and fractional basis points.
2. **Rate lookup, costs snapshot & quote maths tests:** `lookupRatesForMatter` department/practice-area vs default rate card fallback (`RC-DEFAULT`), `resolveMatterCostsSnapshot`, `calculateDisbursementsTotal` and `calculateQuoteTotals` under 0%, 5% and 20% `matterCosts.vatRatePercent` + per-disbursement VAT overrides.
3. **Immutable snapshot test:** Save a quote and a signed-off `MatterCostsSnapshot` at `20%` VAT / initial rate card; update tenant `matterCosts.vatRatePercent` to `15%` and raise partner hourly rates; assert the saved quote and signed-off matter costs snapshot still return their original `20%` VAT and original partner rate and totals unchanged.
4. **Schema & config usage tests:** Verify `core/tests/tenant-config-usage.test.ts` passes with zero `[x-reserved:S0-23]` tags remaining and rejects negative / `> 100` `vatRatePercent`.
5. **Two-tenant isolation tests (`P8`):** Tenant A changing `matterCosts.vatRatePercent` or rate cards never affects Tenant B quotes, matter costs or snapshots; tampered IDs / forged tenant claims fail closed.

---

## 8. Documentation, Help & Backlog Updates

- **Help & documentation (`Rule 11`, `P11`):**
  - Update [finance-data-and-permissions.ts](file:///c:/1Squared/App/src/docs/articles/finance-data-and-permissions.ts) (rate lookup, VAT rate setting, immutable snapshots on matters and quotes).
  - Update [tenant-settings.ts](file:///c:/1Squared/App/src/docs/articles/tenant-settings.ts) (`matterCosts.vatRatePercent` and rate card settings).
- **Release notes:** Add an `S0-23` entry in `docs/release-notes.md`.
- **Backlog updates (`docs/roadmap/feature-list.md`):**
  - Item `30` (*Rates and charging*): remains `Partly built` (record `S0-23` delivered money helpers, configurable `vatRatePercent`, immutable snapshots and tests; *"What's missing"*: `S0-28` negotiated client/matter overrides and CFA/DBA caps).
  - Update advances on `3` (Quotes), `7` (Matter costs), `44` (VAT / money config) and `P7` (`[x-reserved:S0-23]` retired); record `P10`, `P11`.

---

## 9. Manual Setup / External Blockers

- `None`.

---

## 10. Acceptance Criteria

- [ ] `core/src/domain/money/index.ts` implements `BigInt`-based integer-minor-unit helpers including `roundHalfAwayFromZeroFromBasisPoints`.
- [ ] `matterCosts.vatRatePercent` (`0..100`, default `20`) is schema-validated, editable in Admin with MFA and drives Quote and Matter Costs calculations.
- [ ] All `[x-reserved:S0-23]` markers are retired cleanly (`core/tests/tenant-config-usage.test.ts` passes).
- [ ] Saved quotes and saved/signed-off `MatterCostsSnapshot` records remain immutable after subsequent changes to `vatRatePercent` or rate cards.
- [ ] Rate lookup, quote maths, costs snapshot, RBAC and two-tenant isolation tests pass, plus `npm run ci`.
- [ ] Help articles, `docs/release-notes.md` and `docs/roadmap/feature-list.md` (`30` kept `Partly built` noting `S0-28` dependency) are updated in the same PR.

---

## 11. Re-plan Signs & Risks

- **Re-plan if:**
  - Any legacy JSON-blob column inside `quotes` or `matters` stores pre-formatted floats that cannot round-trip cleanly into integer minor units without breaking existing seed tests;
  - `nalf-matter-costs-governance` extension expects a core internal import not exposed on `@platform/core-api` (must expose cleanly on `@platform/core-api` under Rule 3).
