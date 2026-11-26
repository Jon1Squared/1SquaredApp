# S1-08: Money on Account Requests, Chasing, Manual & PMS Ledger Receipts, and Opening Gate Funds Check

| | |
|---|---|
| Backlog | Row `6` (Money on account — moving to `Completed`), row `4` (Client and matter inception — final Stage 1 gate pre-condition completed, deferred live providers on `F24`–`F27`), and stage exit item `6` |
| Decision | Stage 1 decisions `S1-D1`, `S1-D4`, `S1-D6`, `S1-D10`, `S1-D11`; Owner decisions 1, 2, 4 & Q1–Q9 (26 Nov 2026); [ADR 0038](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md), [ADR 0040](../../decisions/0040-matter-opening-gate-and-numbering.md), [ADR 0041](../../decisions/0041-pms-money-as-integer-pence.md), [ADR 0042](../../decisions/0042-generic-communication-chasing-mechanism.md), Proposed [ADR 0043](../../decisions/0043-money-on-account-requests-and-receipts.md) |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP3 (`S1-08`, top branch of WP3) |
| Branch | `s1-08-money-on-account`, stacked on `s1-07-quotes`, targeting `develop` |
| Change class | Core extension API (additive v`2.6.0`, Rule 7); Core RBAC permissions (`money_on_account:view`, `money_on_account:request`, `money_on_account:record_receipt`); Core tenancy expand migration `0030` + repositories; Core config schema (`moneyOnAccount.*`), live bank-details guard & MFA/masked audit (`R824`); Host transactional funds-on-account gate (`R822` / Q8), payment-request/receipt services, `'money_on_account'` chasing handler (`R818`), & UI (`MatterProfileClient`, `MatterFinanceTab`, `AdminClient`); Demo config (`client-not-a-law-firm/config/base.json`); Plain-English Help (`src/docs/`); Consolidated WP3 E2E journey & full CI check |
| Layer | Core API (`core/src/api/`, `core/src/integrations/intake-checks/`), Core RBAC (`core/src/domain/rbac/`), Core tenancy (`core/src/tenancy/`), Core config (`core/schemas/`, `core/src/config-engine/`), Host server/UI (`src/`), Client config (`client-not-a-law-firm/`) |
| Size | `M` (`1.75–2.0` days — Lever 1 applied, `B35`) |
| Depends on | `S1-03` (`PaymentRequestProvider`), `S1-05` (opening gate & overrides), `S1-12` (PMS client ledger integer pence), `S1-06` (`ADR 0042` generic chasing engine & `0028`), `S1-07` (quote POA carry-over); Proposed [ADR 0043](../../decisions/0043-money-on-account-requests-and-receipts.md) to be Accepted before coding |
| Blocking manual tasks | None in dev/test; **live email delivery blocked by Stage 1 §8 task** (in the `S1-06` build, `demo.json` sets `integrations.email.provider` to `"disabled"` so queued requests stay `'pending'` and readable in **Administration → Email Outbox**; switching it back on alongside a demo mailbox and confirming live bank details before hosted firm onboarding are §8 manual tasks) |
| Baseline | `develop` at `a7e606c` (stacked atop `s1-12`, `s1-06`, `s1-07`) |

---

## 1. Change Class and Layer Breakdown

| Part | Change class | Layer |
|---|---|---|
| Additive `MoneyOnAccountConfiguration`, `BankAccountDetailsConfig`, additive `recordManualCancellation` + `listPaymentRequestsForSubject` on `PaymentRequestProvider` / `ManualPaymentRequestProvider`, `CORE_API_VERSION = '2.6.0'` | Core extension API & manual adapter (additive, Rule 7) | `core/src/api/index.ts`, `core/src/integrations/intake-checks/manualProviders.ts`, `core/docs/CHANGELOG.md` |
| New permissions `'money_on_account:view'`, `'money_on_account:request'`, `'money_on_account:record_receipt'` (`85/74/11`) | Core RBAC registry | `core/src/domain/rbac/registry.ts` |
| Migration `0030_money_on_account_expand` (`money_on_account_requests`, `money_on_account_receipts` with `uq_moa_receipts_tenant_pms_tx`, sequences), `TenantMoneyOnAccountRepository`, `*InTx` helpers on `TenantPmsRepository` & `TenantIntakeCheckRepository` | Core tenancy schema & repositories | `core/src/tenancy/migrations/index.ts`, `core/src/tenancy/tenantScopedRepository.ts`, `core/src/tenancy/`, `core/src/tenancy/pmsRepository.ts`, `core/src/tenancy/intakeCheckRepository.ts` |
| Config schema `moneyOnAccount` (safe defaults: `enabled: false`, empty bank details; live placeholder refusal; MFA + masked old/new sort code & account number audit trail on `saveMoneyOnAccountConfigAction`, `R824`) + approved demo defaults (`client-not-a-law-firm/config/base.json`, Appendix A + `requireFundsOnAccount: true` on the 9 confirmed demo work types per Q5) | Core config engine & client config | `core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `client-not-a-law-firm/config/base.json` |
| Payment request PDF generator (`<= 3 MB`), request dispatch + outbox PDF (`sendMoneyOnAccountRequestAction`, populating `matter_id`/`quote_id` on `email_outbox` for `R823`), manual receipt (`recordMoneyOnAccountReceiptAction`, requiring stored `purpose: 'moa_receipt'` under `R817`), PMS client ledger matching (`matchPmsClientLedgerReceiptAction`) + reversal, `'money_on_account'` handler on `communication-chases` (`chase:<chaseId>:step:<n>`, `R818`), real transactional opening gate check (`R822` / Q8) replacing `fundsOnAccountSatisfied: false` stubs | Host domain, server services & actions | `src/domain/openingGate.ts`, `src/domain/moneyOnAccount.ts`, `src/server/services.ts`, `src/server/actionPermissions.ts`, `src/app/actions.ts`, `src/server/pageLoaders.ts` |
| Matter Profile **Money on Account** card (request, chase status, receipts, match PMS ledger line, reverse, bank details summary), Opening Gate summary enrichment, Admin Money on Account config panel (Lever 1 summary `B35` + MFA-gated save action with masked audit) | Host UI | `src/components/MatterProfileClient.tsx`, `src/components/MatterFinanceTab.tsx`, `src/components/AdminClient.tsx` |
| Plain-English Help (`money-on-account.ts` new + updates), technical & release notes, full Stage 1 E2E journey | Help & E2E verification | `src/docs/`, `docs/`, `e2e/role-journeys.spec.ts` |

---

## 2. What Exists Today (`develop` at `a7e606c`)

1. **Payment on Account fields on Matter Costs & Matters (passive only):**
   - `MatterCostsConfig` (`src/domain/types.ts:1843–1860`): `defaultPaymentOnAccount: 'Yes' | 'No' | ''` (`:1853`), `defaultPaymentOnAccountAmountGbp?: number` (`:1854`). Zero bank-details or payment-reference fields exist.
   - `MatterCostsSnapshot` (`src/domain/types.ts:1804–1836`): `paymentOnAccountRequired: 'Yes' | 'No' | ''` (`:1831`), `paymentOnAccountAmountGbp: number | null` (`:1832`).
   - `Matter.retainerMoniesOnAccountGbp` (`src/domain/types.ts:1011`, stored in `retainer_monies_on_account_pence` after `S1-12`).
   - `src/domain/matterCosts.ts:286–301, 474–605, 890–1180`, `MatterFormClient.tsx:1171–1173, 1288–1290, 8918–9022, 11894–11903` (captures indicative POA amount/flag on Step 2 and Step 7), and `MatterProfileClient.tsx:696, 730, 755` (renders donut fallback label only; no MOA workflow UI exists).
2. **PMS client ledger (`pms_client_account_entries`) & `pms_links`:**
   - Table `public.pms_client_account_entries` (`core/src/tenancy/migrations/index.ts:1791–1811`, expanded to `amount_pence BIGINT` & `balance_after_pence BIGINT` in `S1-12`) stores imported ledger transactions (`transaction_id`, `matter_code`, `client_code`, `entry_date`, `direction`, `amount_pence`, `balance_after_pence`, `payload_json`), linked to 1Squared matters 1-to-1 via `public.pms_links` (`:1580–1600`, `idx_pms_links_tenant_entity_osid` / `_code`).
   - Verified workbook signs (`src/pms/importPms.ts:499–526`, `data/pms/1Squared_PMS_Demo_Data.xlsx` `client_account` sheet): **`direction = 'Receipt'`** rows carry **positive** amounts (`C00010`: `+300`, `C00015`: `+85000`), while **`'Payment'`** (`C00011`: `-356.4`) and **`'Transfer to office'`** (`C00014`: `-10039.4`) carry **negative** amounts. Matching receipts MUST strictly filter `direction = 'Receipt' AND amount_pence > 0`.
   - `TenantPmsRepository` (`core/src/tenancy/pmsRepository.ts:2857–2990`, `financeServices.ts:350–566`, `MatterFinanceTab.tsx:1145–1202`) reads client ledger entries outside caller transactions (no public `*InTx` methods yet).
3. **Opening gate's hard-coded funds check (`src/server/services.ts`):**
   - `fundsOnAccountSatisfied` is hard-coded **`false`** inside both **`evaluateOpeningGateForServerInTx`** (`src/server/services.ts:6438`) and **`getMatterOpeningGateStateRecord`** (`src/server/services.ts:36377`).
   - All **5 transactional opening paths** call `evaluateOpeningGateForServerInTx` inside `withTenantTransaction`:
     1. `saveMatterRecord` (`:9239`);
     2. `updateMatterConflictRecord` (`:10785`);
     3. `signOffMatterCostsRecord` (`:11440`);
     4. `transitionRegisterRecordService` on `high_risk_opening` `compliance_approve` (`:30086`);
     5. `openProspectiveMatterRecord` (`:36631`, plus override grant/revoke at `:36917, 36993, 37141`).
   - Domain evaluator `src/domain/openingGate.ts:21, 165, 394–416` (`fundsOnAccountSatisfied`, `nonOverridableReason: null`, `canOverride: !fundsRawSatisfied`) and `public.matter_opening_gate_overrides` (`migrations/index.ts:3510`, `'funds_on_account'`) plus override UI modals (`MatterProfileClient.tsx:1695–2085`) are already wired from `S1-05`.
   - `client-not-a-law-firm/config/base.json:982, 996–2129` sets `requireFundsOnAccount: false` on defaults and all 76 work types (`77` occurrences of `false`, `0` of `true`).
4. **ADR 0038 `payment_request` contract & manual adapter:**
   - `PaymentRequestProvider` (`core/src/api/index.ts:2419–2481`), `ManualPaymentRequestProvider` (`core/src/integrations/intake-checks/manualProviders.ts:435–519`), `public.intake_check_records` (`migrations/index.ts:3049–3077`), and `TenantIntakeCheckRepository` (`core/src/tenancy/intakeCheckRepository.ts:108–315`) exist behind `integrations.intakeChecks.payments.provider = 'manual'`, but are unwired in `src/`, permit `amountMinorUnits = 0n`, and lack `recordCheckInTx` / cancellation / subject list methods.

---

## 3. Design & Functional Specification

### 3.1 Money on Account Request Workflow & Payment Reference (`ADR 0043`)
1. **Create & send request (`createAndSendMoneyOnAccountRequestAction` / separate draft + send):**
   - Pre-fills requested amount from `quote.paymentOnAccountPence` -> `matter.costsSnapshot.paymentOnAccountAmountGbp` -> `matter.retainerMoniesOnAccountPence`. Validates strictly `requestedAmountPence > 0`.
   - Validates recipient email (`isValidEmailAddress`, defaulted from instructing contact / primary client email) and enforces `moneyOnAccount` configuration check (failing closed with `MOA_NOT_CONFIGURED` if bank details are missing, or `MOA_LIVE_PLACEHOLDER_BANK_DETAILS_FORBIDDEN` if `environment === 'live'` sees placeholder sort code `00-00-00` or account `00000000`).
   - Allocates unique UK Faster Payments reference `MOA-<MATTER_TOKEN_MAX10>-<NN>` (`<= 18` ASCII chars, zero client PII — e.g. `MOA-MAT0010004-01`, falling back to sanitised matter ID token `MOA-M000012-01` if prospective matter is not yet numbered).
   - **Pre-TX PDF generation & size check:** Builds a clear client-facing Payment on Account Request PDF statement (`src/domain/moneyOnAccount.ts`: firm letterhead, matter ref, client-account name, bank name, sort code, account number, payment reference, exact formatted amount, regulatory wording from Appendix A) converted via `selectDocumentPdfConverter` outside TX and capped strictly at `<= MAX_EMAIL_TOTAL_ATTACHMENT_BYTES` (`3_000_000` bytes).
   - **Atomic TX (`withTenantTransaction`):** Locks `public.matters FOR UPDATE`, creates `money_on_account_requests` (`status = 'requested'`, freezes `bank_details_snapshot_json`), enqueues email + inline PDF (`public.email_outbox` with nullable `matter_id = matter.id` and `quote_id = quoteId ?? null` via `0028` for `R823` + `public.email_outbox_attachments`, idempotency key `'moa:request:<requestId>'`), records ADR 0038 `PaymentRequestProvider` (`'requested_manual'`) in `intake_check_records`, starts generic `communication_chases` (`entity_kind = 'money_on_account'`, `matter_id`, `sent_at`, step `1` due `+7` days when `chasing.moneyOnAccount.enabled === true`), updates `matters.retainer_monies_on_account_pence` if empty, and writes zero-PII audit entry (`'Money on account requested'`). Drains outbox post-commit.
   - **Cancel / withdraw (`cancelMoneyOnAccountRequestAction`):** Transitions `'draft' | 'requested' | 'part_received'` (only when zero unreversed receipts exist; or cancels remaining chase cleanly) to `'cancelled'`, records ADR 0038 `'cancelled'` outcome, and **immediately stops** any active `communication_chases` row (`stopped_reason = 'cancelled'`).

### 3.2 Recording Receipts (Manual & PMS Ledger Match) & Reversals (`ADR 0043`)
1. **Manual receipt (`recordMoneyOnAccountReceiptAction`, Finance/Partner/MP only per Owner Q4):**
   - Validates `amountPence > 0`, valid `receivedDate`, and optional clean uploaded remittance evidence (`POST /api/evidence/upload` with `purpose: 'moa_receipt'`, pre-verified outside TX; `recordMoneyOnAccountReceiptRecord` requires stored `artifact.purpose === 'moa_receipt'`, rejecting `'cdd'` and `'engagement_signed'`, and `GET /api/evidence/download` branches exclusively on stored `evidence_artifacts.purpose` per `R817`).
   - Locks `matters FOR UPDATE` and `money_on_account_requests FOR UPDATE` (must be `'requested' | 'part_received'`), inserts `money_on_account_receipts` (`source = 'manual'`), records ADR 0038 `'receipt_recorded_manual'` in `intake_check_records`, sums unreversed receipts in exact `BigInt`/`MinorUnits`, updates request status to `'part_received'` (`received < requested`) or `'received'` (`received >= requested`), and when `'received'`, **immediately stops** active `communication_chases` (`stopped_reason = 'received'`).
2. **Match PMS client ledger line (`matchPmsClientLedgerReceiptAction`, Finance/Partner/MP only):**
   - Resolves matter access (`canPersonAccessMatter`) first, reads matter's `pms_code` from `public.pms_links`, locks `pms_client_account_entries FOR SHARE`, verifies strictly `pms_entry.matter_code === link.pmsCode`, `pms_entry.direction === 'Receipt'`, and `pms_entry.amount_pence > 0`.
   - Inserts `money_on_account_receipts` (`source = 'pms_ledger'`, `pms_transaction_id`, `amount_pence = pms_entry.amount_pence`, `received_date = pms_entry.entry_date`), protected by DB partial unique index **`uq_moa_receipts_tenant_pms_tx`** (concurrent/duplicate match fails cleanly with `MOA_PMS_RECEIPT_ALREADY_MATCHED`). Records ADR 0038 `'receipt_recorded_manual'`, updates request status, and stops chasing immediately once `'received'`.
3. **Append-only reversal (`reverseMoneyOnAccountReceiptAction`, Finance/Partner/MP only):**
   - Never deletes receipt rows; stamps `reversed_at`, `reversed_by_person_id`, `reversal_reason` inside TX, recalculates request sum/status (`received -> part_received -> requested`), writes audit entry (`'Money on account receipt reversed'`), and releases `pms_transaction_id` in the partial unique index so an erroneously matched PMS transaction can be re-matched to the right request cleanly.

### 3.3 Chasing Plug-in (`communication-chases`) & Real Transactional Opening Gate
- **Generic chaser plug-in (`ADR 0042`):** Registers `'money_on_account'` handler in `executeCommunicationChasesForTenant` (using confirmed **7 / 14 / 21** day defaults per Owner Q3): checks request `status` and `evaluateMatterFundsOnAccountInTx` inside TX; stops immediately if `'received' | 'cancelled'` or matter closed; sends Day `7` (`idempotency_key: 'chase:<chaseId>:step:1'`, `R818`) & Day `14` (`'chase:<chaseId>:step:2'`) reminder emails (re-stating payment reference, amount due, and bank details from `bank_details_snapshot_json`, populating `matter_id`/`quote_id` on `email_outbox` per `R823`), then Day `21` fee-earner escalation task.
- **Transactional Opening Gate (`ADR 0040`, replacing BOTH hard-coded `false` stubs):**
  - Replace `fundsOnAccountSatisfied: false` at **`src/server/services.ts:6438`** and **`:36377`** with `evaluateMatterFundsOnAccountInTx(tx, ctx, matter.id)` returning `{ fundsOnAccountSatisfied: boolean, requestedPence, receivedPence, agreedAmountPence, outstandingPence, statusSummary }`:

    > **Canonical funds-on-account gate rule (`evaluateMatterFundsOnAccountInTx`):**
    > Inside the opening transaction (locking `public.money_on_account_requests` for the matter `FOR SHARE` and summing active unreversed `public.money_on_account_receipts`), funds on account are met (`fundsOnAccountSatisfied === true`) if and only if **all** of the following hold:
    > 1. At least one non-cancelled, non-draft request exists for the matter (`status IN ('requested', 'part_received', 'received')`).
    > 2. Every non-cancelled, non-draft request for the matter has `status = 'received'` (each such request's unreversed receipts total at least its `requested_amount_pence > 0`, leaving no unpaid or part-paid request open).
    > 3. Where the matter has an agreed payment-on-account amount (`agreedAmountPence > 0`, resolved from the matter's costs snapshot or retainer amount, falling back to its converted source quote's payment-on-account amount), the total unreversed receipts across all non-cancelled, non-draft requests for the matter is at least `agreedAmountPence`. Where no agreed amount is set on the matter, conditions (1) and (2) alone constitute the rule.
    >
    > Reversing a receipt **before** the matter opens recalculates request status and receipt totals immediately, so the opening gate blocks again until replacement funds are received or a partner records an audited `funds_on_account` override. Reversing a receipt **after** the matter has already opened does not change the matter's status or reopen the opening gate, because the gate applies only at opening.

  - Because `evaluateOpeningGateForServerInTx` runs inside **all 5 gated opening transactions** (`saveMatterRecord`, `openProspectiveMatterRecord`, `updateMatterConflictRecord`, `signOffMatterCostsRecord`, `high_risk_opening` `compliance_approve`), **Open matter** cannot succeed until the rule above is met or a partner records an audited `'funds_on_account'` override!
  - Update **`client-not-a-law-firm/config/base.json`** to enable `requireFundsOnAccount: true` on the **9 confirmed demo work types** (`8` Dispute Resolution work types + `Residential Conveyancing`, Owner Q5).

---

## 4. Data Model, Expand Migration `0030`, Backfill & Rollback Plan

- **Migration ID:** `0030_money_on_account_expand` (`CORE_REQUIRED_SCHEMA_VERSION = '0030'`, `dependsOn: ['0009', '0010', '0013', '0023', '0027', '0028', '0029']`).
- **`upSql`:**
  1. `CREATE SEQUENCE IF NOT EXISTS public.tenant_moa_request_id_seq START WITH 1 INCREMENT BY 1;`
  2. `CREATE SEQUENCE IF NOT EXISTS public.tenant_moa_receipt_id_seq START WITH 1 INCREMENT BY 1;`
  3. `CREATE TABLE IF NOT EXISTS public.money_on_account_requests (...)` + `uq_moa_requests_payment_ref` + `idx_moa_requests_tenant_matter` ([ADR 0043 §1](../../decisions/0043-money-on-account-requests-and-receipts.md#1-per-tenant-data-model-0030_money_on_account_expand-integer-pence-bigint)).
  4. `CREATE TABLE IF NOT EXISTS public.money_on_account_receipts (...)` + `idx_moa_receipts_request` + `idx_moa_receipts_matter` + **`uq_moa_receipts_tenant_pms_tx`**.
- **Backfill & compatibility:** Existing active/opened matters keep their current status untouched (`ADR 0040` gates only transitions out of `prospective`). Existing prospective demo matters with `requireFundsOnAccount: false` are unaffected; work types enabling `requireFundsOnAccount: true` enforce the gate on future openings cleanly.
- **Reversible `downSql`:** Drops `uq_moa_receipts_tenant_pms_tx`, indexes, `public.money_on_account_receipts`, `public.money_on_account_requests`, and both sequences (`up -> down -> up` tested).

---

## 5. Configuration Schema Changes & Runtime Usage Compliance

- **`moneyOnAccount` subtree (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `tenant_module_configs['money_on_account']`):**
  - `enabled`: `boolean` (**core default `false`**, demo `true`)
  - `clientAccount`: `{ accountName: string, bankName: string, sortCode: string, accountNumber: string, iban: string, bic: string, allowDemoPlaceholderDetails: boolean }` (**core default empty `""`, `allowDemoPlaceholderDetails: false`**; demo `base.json` sets obviously invented `00-00-00` / `00000000` + `allowDemoPlaceholderDetails: true`, still rejected whenever `environment === 'live'`)
  - `requestEmailSubjectTemplate`, `requestWordings`: `{ introductoryParagraph: string, bankTransferInstruction: string, clientMoneyComplianceNote: string }` (core default `""`; demo `base.json` populated from Appendix A)
  - `paymentReferencePrefix`: `string` (`^[A-Z0-9]{2,6}$`, default `'MOA'`)
- Read cleanly in `resolveEffectiveMoneyOnAccountConfig` and `moneyOnAccount.ts` so `core/tests/tenant-config-usage.test.ts` stays 100% green.
- **Approved Lever 1 (`B35`, Owner Q2):** Read-only Administration configuration summary panel + MFA-guarded `saveMoneyOnAccountConfigAction` (`admin:access` + `mfaVerified: true`); rich WYSIWYG template editing deferred to `B35`.
- **Audited bank-detail changes (`R824`):** Even under Lever 1, `saveMoneyOnAccountConfigAction` enforces `admin:access` + `mfaVerified: true` and writes a same-transaction `audit_entries` record for every change containing **who (`byId`), when (`at`), and old and new values masking all but the last 2 digits of `sortCode` and `accountNumber`** (e.g. `**-**-34`, `******78`; plus `iban` masked to its last 2 characters if present).

---

## 6. Permissions, Action/Job Policies, Role Matrix & MFA

### Three new Money on Account permissions (`core/src/domain/rbac/registry.ts`)
- Updates `PERMISSION_REGISTRY` counts from `82/71/11` -> **`85/74/11`** across all 5 RBAC test files:
  1. `'money_on_account:view'` (`domain: 'finance'`, `sensitivity: 'standard'`): granted to `managing_partner`, `partner`, `finance`, `fee_earner`, `supervisor`, `legal_secretary`, `risk_compliance`, `admin` (gated by `canPersonAccessMatter`!).
  2. `'money_on_account:request'` (`domain: 'finance'`, `sensitivity: 'standard'`): granted to `managing_partner`, `partner`, `finance`, `fee_earner`, `supervisor`, `legal_secretary`, `admin` (excluded from `enquiries_coordinator`, `intake`, `risk_compliance`).
  3. **`'money_on_account:record_receipt'`** (`domain: 'finance'`, `sensitivity: 'restricted'`, **confirmed by Owner Q4**): granted **ONLY** to **`finance`**, **`partner`**, and **`managing_partner`** (explicitly excluded from **`admin`** via `DEFAULT_RBAC_ROLES.admin.permissions` filter, as well as excluded from `fee_earner`, `legal_secretary`, `supervisor`, `risk_compliance`, `enquiries_coordinator`, `intake`!).

### Action & Route Policies (`src/server/actionPermissions.ts`, `MAX_KNOWN_GAPS = 0`)
- `createAndSendMoneyOnAccountRequestAction` -> `'money_on_account:request'` (`enforcedBy: 'action'`)
- `cancelMoneyOnAccountRequestAction` -> `'money_on_account:request'` (`enforcedBy: 'action'`)
- `recordMoneyOnAccountReceiptAction` -> `'money_on_account:record_receipt'` (`enforcedBy: 'action'`)
- `matchPmsClientLedgerReceiptAction` -> `{ allOf: ['money_on_account:record_receipt', 'finance:view_matter'] }` (`enforcedBy: 'action'`)
- `reverseMoneyOnAccountReceiptAction` -> `'money_on_account:record_receipt'` (`enforcedBy: 'action'`)
- `saveMoneyOnAccountConfigAction` -> `'admin:access'` + `mfaVerified: true` + masked old/new sort code & account number `audit_entries` (`enforcedBy: 'service'`, `R824`)
- **`POST /api/evidence/upload` & `GET /api/evidence/download` (`R817` stored-purpose rule):** Upload permits `'money_on_account:record_receipt'` for `purpose: 'moa_receipt'` (`subjectType: 'matter'`); download ignores any request `purpose` and branches solely on stored `evidence_artifacts.purpose` (`'moa_receipt'` requires `money_on_account:view` / `money_on_account:record_receipt` / `document:view` + `canPersonAccessMatter`, returning opaque `NOT_FOUND` on mismatch or unauthorised stored `'cdd'` files). `recordMoneyOnAccountReceiptRecord` requires stored `artifact.purpose === 'moa_receipt'`.

| Capability | Finance | Partner / MP | Fee Earner | Supervisor | Legal Secretary | Risk & Compliance | Enquiries / Intake | Admin |
|---|---|---|---|---|---|---|---|---|
| View MOA requests/receipts (`money_on_account:view`) | Yes* | Yes* | Yes* | Yes* | Yes* | Yes* | **No** | Yes* |
| Send / chase / cancel MOA request (`money_on_account:request`) | Yes* | Yes* | Yes* | Yes* | Yes* | **No** | **No** | Yes* |
| Record manual receipt / reverse (`money_on_account:record_receipt`) | **Yes*** | **Yes*** | **No** | **No** | **No** | **No** | **No** | **No** |
| Match PMS client ledger line (`record_receipt` + `finance:view_matter`) | **Yes*** | **Yes*** | **No** | **No** | **No** | **No** | **No** | **No** |
| Override `funds_on_account` gate (`matter:opening_gate:override`) | **No** | **Yes*** | **No** | **No** | **No** | **No** | **No** | **No** |
| Configure Bank Details / Wording (`admin:access` + **MFA**) | No | MP / Partner | No | No | No | No | No | Yes (**MFA**) |

*\*Strictly subject to `canPersonAccessMatter`.*

---

## 7. Visibility, Isolation, `R812` CDD Redaction & `S1-09` Composition

1. **Visibility & `S1-09` composition:**
   - Every MOA read, send, receipt, PMS ledger candidate query, chase task, and opening-gate evaluation enforces `canPersonAccessMatter(user, matter)` (using SQL `buildMatterHiddenFromViewerSql` predicates cleanly — never raw `restricted_access_user_ids_json ?` patterns and never raw `matter_code` PMS lookups without first resolving linked matter access!).
   - Escalation tasks link `matterId` so `canRecipientReceiveNotification` (`services.ts:13040–13381`) suppresses alerts for restricted/walled matters (`B19`).
2. **`R812` CDD-redaction rule compliance:**
   - `MoneyOnAccountRequestRecord`, `MoneyOnAccountReceiptRecord`, MOA PDFs, and `MatterOpeningGateState` MOA summaries **never** embed, copy, or rename `matter.amlStatus` or `amlCompletedAt` or client CDD outcomes.
   - Because `finance` can now receive MOA receipts and see MOA opening-gate blocks (`"Funds on account: Requested £500.00 / Received £0.00"`), UI & server payloads must strictly return **`funds_on_account`**, **`conflict_cleared`**, **`engagement_signed`** state without revealing unpermitted CDD outcome details (`matter` objects stay redacted at `withPageShell` & `guardedAction` via `redactMatterCddInBrowserPayload`, matching `R812` and `R816`). Any new MOA DTO carries zero CDD outcome keys.
3. **Rule 9 two-tenant isolation:**
   - Verified across `tenant-alpha` and `tenant-bravo` for forged `requestId`, `receiptId`, `pmsTransactionId`, `evidenceArtifactId`, and bank-details config isolation.

---

## 8. Help and Documentation (Rule 11 & Stage 1 §6 Rule 6)

Plain British English for firm users (zero code names, error codes, or migration numbers):
- **New article:** `src/docs/articles/money-on-account.ts`: requesting money on account before work starts, what bank details and payment reference clients receive, automatic 7/14-day chases and day-21 fee-earner escalation tasks, why Finance or a Partner matches incoming bank receipts (either manually or against an imported PMS client account receipt), part-payments and reversals, how cleared funds unlock the matter opening gate (or require a partner override), **that reversing a receipt after a matter has already opened does not reopen the opening gate** (the gate applies only when opening a matter; the reversal is recorded in the history for Finance follow-up), and **that changes to client account bank details require multi-factor authentication and are logged in the firm's audit log**.
- **Updated articles:** `src/docs/articles/finance-data-and-permissions.ts` (role separation for recording/matching receipts + PMS ledger reconciliation), `src/docs/articles/matter-opening-and-risk.ts` (`Funds on account` work-type pre-condition, override behaviour, and clarifying that reversing a receipt after opening does not reopen the gate), `src/docs/articles/tenant-settings.ts` (configuring client account bank details, request wording, and MOA chasing schedule, noting MFA and audit logging on bank detail changes).
- **Technical docs:** `docs/guides/platform-technical-notes.md`, `docs/release-notes.md`, `core/docs/CHANGELOG.md` (`ADR 0043`, migration `0030`, `CORE_API_VERSION = '2.6.0'`).

---

## 9. Tests, Guards, Full Stage 1 E2E Journey & Build-Phase Cadence

1. **Migration `0030` round-trip (`core/tests/migrations-postgres.test.ts`):** `up -> down -> up` cleanly after `0029`, verifying `uq_moa_receipts_tenant_pms_tx` and `uq_moa_requests_payment_ref`.
2. **Unit & config (`core/tests/money-on-account-s108.test.ts`, `core/tests/tenant-config-usage.test.ts`):** payment reference generator (`<= 18` ASCII chars, zero PII, unique sequence), live placeholder bank details guard (`00-00-00` refused when `environment === 'live'`), safe core defaults.
3. **Two-tenant PG16 isolation, RBAC, PMS matching, bank audit & gate enforcement (`core/tests/money-on-account-s108.test.ts`):**
   - **Send request & outbox PDF:** verifies `email_outbox` (with `matter_id` / `quote_id` populated for `R823` outbox filtering) + `email_outbox_attachments` (`%PDF-`) containing reference & invented bank details, ADR 0038 `'requested_manual'` in `intake_check_records`, `communication_chases` `'active'`.
   - **Chase re-send key (`R818`):** send request -> stop chase -> send a second/replacement request -> run `communication-chases` -> queued under `chase:<chaseId>:step:<n>` with zero idempotency collision.
   - **Bank detail audit & MFA (`R824`):** `saveMoneyOnAccountConfigAction` fails `MFA_REQUIRED` without MFA; with MFA, writes a same-transaction `audit_entries` record containing old and new values with all but the last 2 digits of `sortCode` and `accountNumber` hidden (and asserting full unmasked values never appear in the audit entry).
   - **Strict receipt RBAC (`R748`-style) & `R817` `moa_receipt` purpose check:** `fee_earner`, `legal_secretary`, `admin`, `risk_compliance` receive `FORBIDDEN` on `recordMoneyOnAccountReceiptAction` and `matchPmsClientLedgerReceiptAction`; `finance`, `partner`, `managing_partner` succeed. `recordMoneyOnAccountReceiptAction` rejects a `'cdd'` or `'engagement_signed'` artifact (`purpose === 'moa_receipt'` required).
   - **PMS client ledger safety & `Promise.all` concurrency:** attempting to match a `'Payment'` (`-356.40`) or `'Transfer to office'` (`-10039.40`) row fails cleanly; matching a positive `'Receipt'` succeeds and concurrent second match (`Promise.all` against same `transaction_id`) fails closed on `uq_moa_receipts_tenant_pms_tx` (`MOA_PMS_RECEIPT_ALREADY_MATCHED`); part-receipt moves to `part_received`, second receipt completes `'received'` and **stops chasing immediately**; reversal reverts status cleanly and allows legitimate rematch.
   - **All 6 canonical funds-on-account gate cases (`R822` + Q8) across all 5 opening gate paths (`saveMatterRecord`, `openProspectiveMatterRecord`, `updateMatterConflictRecord`, `signOffMatterCostsRecord`, `high_risk_opening` `compliance_approve`):**
     1. **No request:** Residential Conveyancing matter with `requireFundsOnAccount: true` and zero requests -> `fundsOnAccountSatisfied === false` (stays `Prospective`);
     2. **Part received:** request £500, receipt £250 (`part_received`) -> `fundsOnAccountSatisfied === false` (blocked);
     3. **Received below agreed amount:** matter/quote has agreed POA £500, £100 request created and paid in full (`status = 'received'`) -> `fundsOnAccountSatisfied === false` (blocked because total £100 < £500 agreed);
     4. **Received in full:** (a) receipts across non-cancelled requests total `>=` £500 agreed amount with no open unpaid request -> `fundsOnAccountSatisfied === true` (opens); (b) matter with **no** agreed POA amount and all non-cancelled requests `'received'` -> `fundsOnAccountSatisfied === true` (opens);
     5. **A cancelled request:** (a) cancelled request only -> `fundsOnAccountSatisfied === false` (blocked); (b) cancelled request alongside a `'received'` request meeting the agreed amount -> `fundsOnAccountSatisfied === true` (opens);
     6. **A reversal before opening:** paid in full, then reversed before **Open matter** -> `fundsOnAccountSatisfied === false` (blocked again until replacement funds are received or partner records audited `'funds_on_account'` override); plus concurrent receipt reversal vs open races safely inside TX (`FOR UPDATE` / `FOR SHARE`). *(Also verify reversal **after** opening: matter stays `Open`, gate does not reopen, reversal audited.)*
   - **Restricted matters & Rule 9:** Finance without restricted-matter access is refused MOA view/request/receipt on staff/walled matter (`FORBIDDEN` / `NOT_FOUND`); tampered `requestId` / `receiptId` / `pmsTransactionId` across tenants fail closed.
4. **Guards (`noWholeTenantLoadInRequestPaths.test.ts`, `actionPermissionGuard.test.ts`, 5 RBAC permission count tests):** ZERO new whole-tenant loads; `actionPermissionGuard` updated for new actions; all 5 RBAC tests updated to `85/74/11`.
5. **Full Stage 1 End-to-End Playwright Journey Breakdown across WP3 (`e2e/role-journeys.spec.ts`):**
   Stage plan §2 exit requires the joined journey **`enquiry -> quote -> CDD -> engagement -> money on account -> open matter`**. Across WP3, each slice adds its step and `S1-08` asserts the complete end-to-end chain in Playwright (since emails stay in outbox on demo, Playwright uses its existing PG helper module to verify `email_outbox` + `email_outbox_attachments` bytes at every email step alongside UI verification!):
   - *Enquiry (`R657` existing)* -> **Quote (`S1-07`):** Enquiries/Fee earner creates quote with £500 POA on Residential Conveyancing (seeing Price Transparency preview), clicks **Send quote by email** -> asserts `email_outbox` row + non-empty `%PDF-` in `email_outbox_attachments`, downloads `/api/quotes/[id]/pdf`, marks Accepted and converts to prospective matter (POA £500 pre-filled) -> *CDD (`S1-04` existing)* -> **Engagement (`S1-06`):** Fee earner generates & clicks **Send Client Care letter** -> asserts `email_outbox` + PDF attachment + `"Sent"`, uploads signed PDF -> asserts `"Signed & returned"` -> **Money on Account (`S1-08`):** Fee earner requests £500 POA -> asserts `email_outbox` + PDF with bank details & `MOA-...` reference -> Finance matches a positive PMS Receipt (or records manual £500 receipt) -> **Open Matter (`S1-05` + `S1-08`):** Fee earner clicks **Open matter**, all 4 gate items (`Conflict`, `CDD`, `Engagement signed`, `Funds on account`) pass, and matter opens cleanly (`Open`)!
6. **Existing test files touched by `S1-08`:**
   `core/tests/migrations-postgres.test.ts`, `src/server/__tests__/actionPermissionGuard.test.ts`, `core/tests/rbac.test.ts`, `core/tests/scheduler.test.ts`, `core/tests/email-notifications-s026.test.ts`, `core/tests/registers-engine-s024.test.ts`, `core/tests/teams-digests-s029.test.ts`, `core/tests/opening-gate-numbering-s105.test.ts`, `core/tests/pms-postgres.test.ts`, `core/tests/tenant-config-usage.test.ts`, `e2e/role-journeys.spec.ts`.
7. **Build-phase test cadence:**
   - Per commit on `s1-08-money-on-account`: `npx tsc --noEmit`, `npm run lint`, targeted `S1-08` / RBAC / gate tests, and `npx vitest run isolation`.
   - **Once on this top WP3 branch (`s1-08-money-on-account`) after all 4 slices pass targeted tests:** run the full **`npm run ci`** locally AND run Playwright `npx playwright test --reporter=line --global-timeout=900000`. Do NOT repeat the full local `npm run ci` after review fixes unless a fix touches migrations or shared data access (`docs/roadmap/stage-1-plan.md` §6 rule 3).

---

## 10. Expected `docs/roadmap/feature-list.md` Updates

When `S1-08` lands (completing WP3):
- **Row `6` (Money on account):** Update status from `Partly built` to **`Completed`** (once `F27` online payment links remain clearly on Future); document `0030` request/receipt model, UK bank ref format, outbox PDF requests, ADR 0042 generic chasing, manual & PMS integer-pence client ledger receipt matching + reversal (`uq_moa_receipts_tenant_pms_tx`), transactional `requireFundsOnAccount` opening gate (`R822` / Q8), MFA + masked audit bank-details config (`R824`), `money-on-account` Help article, two-tenant PG16 & full Stage 1 E2E tests; clear "What's missing" (`–`).
- **Row `4` (Client and matter inception):** Update status from `Partly built` to **`Completed`** (noting that manual adapters sit behind `integrations.intakeChecks` while deferred automated third-party providers remain explicitly tracked on `F24`–`F27`).

---

## 11. Commit Breakdown

1. **`feat(s1-08): extend @platform/core-api (v2.6.0), RBAC money_on_account permissions (85/74/11), and moneyOnAccount config schema + MFA/masked audit + Appendix A demo defaults`**
2. **`feat(s1-08): add migration 0030 (money_on_account_requests, money_on_account_receipts, uq_moa_receipts_tenant_pms_tx) and repository *InTx helpers`**
3. **`feat(s1-08): implement MOA request PDF + outbox dispatch, manual & PMS receipt matching, chaser handler, and transactional opening gate funds check (R822)`**
4. **`feat(s1-08): wire Matter Profile Money on Account workspace, Admin summary, demo requireFundsOnAccount work types, and Stage 1 E2E journey`**
5. **`docs(s1-08): add money-on-account Help article, update gate/finance/settings articles, release notes, and feature-list rows 4 & 6`**

---

## 12. Draft Owner Spot Checks for Demo Sign-Off (Complete WP3 + Carried-Over WP2 Checklist)

*(Covers Owner Decision 4 around verifying tenant outbox contents without a sending mailbox, all 7 carried-over WP2 follow-up checks from `Stage1-WP2-followups-fixes-review.md`, and every WP3 capability.)*

### Part A — Carried-over WP2 Follow-Up Checks
1. **`R810` (Gate opening vs CMI incomplete):** Open a brand-new matter through the opening gate (not High-risk) -> verify it opens immediately as **`Open`** (green pill) and **Home -> Matter openings in progress** does **not** list it as `"CMI incomplete"`. (Also serves as D10 recheck.)
2. **`R805` (Upload validation messages):** On a client profile CDD card, try uploading a disallowed file (e.g. `.txt` or oversized file) -> confirm the error banner shows plain English, with no technical error codes or stack strings.
3. **`R806` (CDD Help wording):** Open **Help -> Client due diligence** -> verify plain British English explanation for firm users with zero developer jargon.
4. **`R804` (Down-scoring pending High-risk opening):** Create a High-risk Prospective matter (seeing Stage 1 Partner approval queued), edit risk answers back down to Medium -> confirm the pending High-risk approval disappears cleanly (`Withdrawn`) from Home queues.
5. **`R812` (CDD outcome hidden from Finance & Enquiries):** Sign in as **`finance`** and separately as **`enquiries_coordinator`** -> confirm no CDD verdict (`Pending`/`Verified`/etc.) appears on Matters list, Client profiles, Enquiries, Quotes, or Tasks.
6. **`R813` (Inconsistent gate diagnostic):** *None to check on the demo* (fires only if an un-opened legacy state disagrees with the opening gate).
7. **`R816` (Legacy CMI incomplete status & filter parity):** Sign in as **Fee Earner**, view legacy matter `M-000002` (Active + CDD Pending), confirm **`"CMI incomplete"`** pill and filter membership. Sign in as **`finance`**, view `M-000002` -> confirm Finance sees the **same `"CMI incomplete"` pill** and `/matters` **"CMI incomplete"** filter matches identically, while CDD details stay `"Not available to you"`.
8. **`R817` (Finance evidence separation — CDD blocked, signed engagement allowed):** Signed in as **Finance**, confirm that CDD evidence files on a client profile are not downloadable (refused with no hint of existence even if requested as another purpose), whereas a signed engagement letter uploaded on an accessible matter **is** downloadable.

### Part B — WP3 Spot Checks (`S1-12`, `S1-06`, `S1-07`, `S1-08` — Outbox Verified)
9. **`S1-12` In-place Demo Conversion & Finance Accuracy:** Review the demo deploy log's `job.migrate.pms_pence_verified` line confirming `0` conversion mismatches (counts and per-column differences only) across all 20 converted PMS columns + `matters`; verify Client Finance, Matter Finance Tab, and `Client account balance` render exact two-decimal totals matching the PMS ledger.
10. **`S1-07` Price Transparency, Quote PDF, POA & Outbox Dispatch:**
    - As **Admin (MFA)**, inspect **Administration -> Work Types -> Residential Conveyancing -> Price Transparency**.
    - As **Fee Earner**, create a Residential Conveyancing quote with **Payment on Account £500**, download the Quote PDF preview, enter recipient email, click **Send quote by email**, and inspect the `'pending'` message in **Administration -> Email Outbox** (with MFA) confirming recipient, message body, and downloadable Quote PDF attachment (showing POA £500 and transparency text). Accept & convert quote -> confirm £500 POA carries into the new matter.
11. **`S1-06` Client Care, Signed Upload, Non-Engagement & Outbox Security:**
    - Generate & send a Client Care letter by email -> confirm status moves to `"Sent"` with timestamp, cannot regress to `"Drafted"`, and **Administration -> Email Outbox** holds the `'pending'` message, recipient, and downloadable PDF attachment. Upload a clean signed PDF -> confirm `"Signed & returned"` clears `Engagement signed` on the opening gate.
    - Close a test enquiry (`"Outside our expertise"`), open the raised `Non-engagement letter` task, send the letter -> confirm **Administration -> Email Outbox** holds the non-engagement PDF for the right recipient and the task closes automatically as `Done`.
    - Confirm that an Admin who is not on a restricted matter's allow-list cannot see outbox messages for that matter, and that viewing a message / downloading an attachment writes an entry to the audit log.
12. **`S1-08` Money on Account Request, Outbox, PMS/Manual Receipt & Gate Unlock:**
    - On a Residential Conveyancing prospective matter (`requireFundsOnAccount: true`), request £500 Money on Account -> confirm UK reference `MOA-...` appears and **Administration -> Email Outbox** holds the `'pending'` message, recipient, invented client bank details (`00-00-00` / `00000000`), and downloadable PDF statement. Confirm **Open matter** stays blocked until paid.
    - Sign in as **Finance**: verify you can record a manual receipt (or match a PMS client ledger `'Receipt'` row) and verify a Fee Earner does **not** see the record/match receipt controls; return as **Fee Earner** -> confirm `Funds on account` turns green and **Open matter** succeeds cleanly (`Open`).
13. **Automated chasing note (Q3):** *The 7, 14 and 21-day chase steps (for engagement letters, quotes, and money on account) are covered by automated tests and can't be seen on the demo within a test session.*

---

## 13. Risks & Open Questions (Resolved Owner Decisions, 26 Nov 2026)

All WP3 open questions (`Q1`–`Q9`) were resolved by the product owner on 26 November 2026:
- **Q1 & Q9 (Outbox Viewer & Demo Provider):** Build **Administration → Email Outbox** (`admin:access` + MFA, `R823`) in `S1-06`; set `client-not-a-law-firm/config/environments/demo.json` `integrations.email.provider` to `"disabled"` in the `S1-06` build (re-enabling live sending is a Stage 1 §8 task).
- **Q2 (Levers 1 & 2):** Approved; deferred items logged as `B34`, `B35`, and `B36` in `docs/roadmap/feature-list.md`.
- **Q3 (Chase timing):** **7, 14 and 21 days** uniformly across engagement letters, quotes, and money on account.
- **Q4 (`money_on_account:record_receipt` Role Matrix):** Confirmed — **`Finance`**, **`Partner`**, and **`Managing Partner`** only.
- **Q5 (9 Demo Work Types Requiring Funds on Account):** Confirmed — **9 demo work types** (`8` Dispute Resolution work types + `Residential Conveyancing`) enable `requireFundsOnAccount: true` in `client-not-a-law-firm/config/base.json`.
- **Q6 (Quotes Offline Button):** Confirmed — keep **`"Record as sent offline"`** (`markQuoteSentOfflineAction`) as a secondary button.
- **Q7 (Compliance Wording):** Confirmed — all draft Appendix A wording approved with one Legal Ombudsman sentence added to Client Care complaints wording (`S1-06`).
- **Q8 (Agreed POA Amount Rule):** Confirmed — written into canonical `R822` rule (`ADR 0043 §5` and `S1-08 §3.3`).
*(No open questions remain.)*

---

## 14. Estimate & Complete WP3 Schedule Check vs `7–9` Days Budget

| Slice | Revised Scope | Revised Estimate |
|---|---|---:|
| `S1-12` (R816/R819 + B21 pence, no SQL `payload_json` conversion) | Carry-over `R816`, `@platform/core-api` v`2.3.0`, `0027`, independent checks, rollback (b) | `1.75–2.0` days |
| `S1-06` (Engagement + generic chaser + Outbox Viewer) | Monotonic B2, outbox PDFs, `R817` stored purpose, `R818` chase keys, Levers 1 & 2 (`B35`, `B36`), Admin Email Outbox viewer (`R823`) + `demo.json` | `2.5–3.0` days |
| `S1-07` (Quotes + PDF + Transparency + generic chaser) | Quote PDF, `/api/quotes/[id]/pdf`, 4 send paths + offline button, `chase:<chaseId>:step:<n>`, plain-textarea Price Transparency editor in `WorkTypesAdminPanel` | `1.75–2.0` days |
| `S1-08` (Money on Account + gate + bank audit + full E2E) | `0030` requests/receipts, PMS integer matching, `R822`/Q8 opening gate, `R824` MFA/masked audit, 9 demo work types, Stage 1 E2E | `1.75–2.0` days |
| **WP3 Total** | **All 4 slices (with Outbox Viewer + Levers 1 & 2)** | **`7.75–9.0` days** *(inside stage plan §5a's `7–9` days budget)* |

---

## Appendix A: Approved Invented Demo Money on Account Wording & Bank Details (`client-not-a-law-firm/config/base.json`)

*(Approved by owner on 26 Nov 2026 per Decision 1 / Q7. All bank details below are **obviously invented** non-real placeholder details.)*

### A.1 Obviously Invented Client Account Bank Details (`moneyOnAccount.clientAccount`)

- **`accountName`:** `Not A Law Firm LLP — Client Account (DEMO ONLY)`
- **`bankName`:** `Example Clearing Bank plc (Fictional Demo Bank)`
- **`sortCode`:** `00-00-00`
- **`accountNumber`:** `00000000`
- **`iban`:** `GB00DEMO00000000000000`
- **`bic`:** `DEMOGB00XXX`
- **`allowDemoPlaceholderDetails`:** `true` *(automatically rejected by server validation if `environment === 'live'`)*

### A.2 Money on Account Request Wording (`moneyOnAccount.requestWordings`)

- **Email subject template (`requestEmailSubjectTemplate`):**
  `Payment on account request ({{paymentReference}}) — {{matterTitle}}`
- **Introductory paragraph (`introductoryParagraph`):**
  > Thank you for instructing Not A Law Firm LLP. To enable us to commence work and cover initial anticipated fees or third-party disbursements on your matter, we require a payment on account of **{{requestedAmountFormatted}}** to be held in our client account.
- **Bank transfer & reference instruction (`bankTransferInstruction`):**
  > Please transfer **{{requestedAmountFormatted}}** by Faster Payments or CHAPS to our client account below. You **must quote the exact payment reference `{{paymentReference}}`** on your transfer so that our Finance team can allocate your funds promptly to your matter and avoid any delay in opening your file.
- **Client money & AML compliance note (`clientMoneyComplianceNote`):**
  > **Important:** Funds must come from a bank account in your own name (or the named client organisation's account) and match our source-of-funds checks where applicable. We do not accept cash payments or unsolicited third-party transfers without prior written verification. For your security, we will never notify you of a change to our client account details by email alone — please telephone your fee earner using our verified published number before sending large transfers if you ever wish to double-check our bank details. (Demonstration environment only: do not send real money to the demo account details shown above.)
