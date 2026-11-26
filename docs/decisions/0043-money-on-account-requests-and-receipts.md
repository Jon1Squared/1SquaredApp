# ADR 0043: Money on Account Requests, Payment References, and Receipts (`S1-08`)

- **Date:** 2026-11-26
- **Status:** Accepted — Accepted by the owner, 26 Nov 2026
- **Roadmap:** Stage 1 Work Package 3, slice `S1-08` ([docs/roadmap/slices/s1-08-money-on-account.md](../roadmap/slices/s1-08-money-on-account.md)); Stage 1 decisions `S1-D1`, `S1-D4`, `S1-D6`, `S1-D10`; backlog item `6` (and item `4` opening gate completion)
- **Builds on:** [ADR 0028](./0028-tenant-database-and-repositories.md) (tenant databases & repositories), [ADR 0029](./0029-tenant-finance-and-pms-isolation.md) (per-tenant PMS data), [ADR 0038](./0038-intake-check-interfaces-and-manual-adapters.md) (`PaymentRequestProvider` interface & `public.intake_check_records`), [ADR 0040](./0040-matter-opening-gate-and-numbering.md) (`funds_on_account` work-type opening gate & overrides), [ADR 0041](./0041-pms-money-as-integer-pence.md) (PMS & retainer money in integer pence), [ADR 0042](./0042-generic-communication-chasing-mechanism.md) (generic chasing mechanism)

## Context

Today, Money on Account exists only as passive estimate/configuration numbers:

1. **Matter & Quote fields (`src/domain/types.ts`):** `MatterCostsConfig` (`:1843–1860`) and `MatterCostsSnapshot` (`:1804–1836`) hold `defaultPaymentOnAccount` / `paymentOnAccountRequired` / `paymentOnAccountAmountGbp`, `Matter.retainerMoniesOnAccountGbp` (`:1011`, converted to integer pence `retainer_monies_on_account_pence` in `S1-12`), and `public.quotes` carries an unused `payment_on_account_gbp` column (`core/src/tenancy/migrations/index.ts:1186`, hardcoded `null` at `core/src/tenancy/intakeQuoteRepository.ts:2036`; wired as `payment_on_account_pence` in `S1-07`). No request record, client bank-details configuration, payment reference, email dispatch, receipt log, or PMS ledger reconciliation exists.
2. **PMS client ledger (`public.pms_client_account_entries`, `migrations/index.ts:1791–1811`):** Holds read-only imported PMS rows with `transaction_id` (`C00001`–`C00015`), `matter_code`, `direction` (`'Receipt'`, `'Payment'`, `'Transfer to office'`), and — after `S1-12` — exact integer `amount_pence` and `balance_after_pence`. Only `'Receipt'` rows with positive `amount_pence > 0` represent incoming client funds (`'Payment'` and `'Transfer to office'` are negative outflows). `TenantPmsRepository` (`core/src/tenancy/pmsRepository.ts:2857–2990`) has no public `*InTx` methods for transactional gate or receipt matching.
3. **Opening gate stub (`src/server/services.ts`):** `fundsOnAccountSatisfied` is hard-coded to **`false`** inside both `evaluateOpeningGateForServerInTx` (`:6438`) and `getMatterOpeningGateStateRecord` (`:36377`), and `client-not-a-law-firm/config/base.json` sets `requireFundsOnAccount: false` on defaults and all 76 work types (`:982, 996–2129`), even though `public.matter_opening_gate_overrides` (`migrations/index.ts:3510`) and `MatterProfileClient.tsx:1695–2085` already support `'funds_on_account'` overrides from `S1-05`.
4. **ADR 0038 `PaymentRequestProvider` (`core/src/api/index.ts:2419–2481`, `core/src/integrations/intake-checks/manualProviders.ts:435–519`):** Defines `ManualPaymentRequestProvider` backed by append-only `public.intake_check_records` (`migrations/index.ts:3049–3077`), which is not yet wired into any `src/` service, allows `0n`, lacks cancellation and subject-listing helpers, lacks `*InTx` transaction methods, and does not enforce unique PMS `transaction_id` matching or track generic chase state.

Because this defines new per-tenant transactional financial tables, UK Faster Payments-compatible reference formatting, PMS ledger reconciliation invariants (no double-matching), opening-gate transaction locking, and integration with `ADR 0038`'s `PaymentRequestProvider`, it is structural and requires an ADR before WP3 implementation begins.

## Decision

### 1. Per-tenant data model (`0030_money_on_account_expand`, integer pence `BIGINT`)

1. **`public.tenant_moa_request_id_seq`** (`'MOA-000001'`) and **`public.tenant_moa_receipt_id_seq`** (`'MOAR-000001'`).
2. **`public.money_on_account_requests`:**
   - `tenant_id TEXT NOT NULL`, `id TEXT NOT NULL`
   - `matter_id TEXT NOT NULL REFERENCES public.matters` (`ON DELETE CASCADE`)
   - `quote_id TEXT NULL` *(provenance link if converted from a quote with POA)*
   - `payment_reference TEXT NOT NULL` *(unique per tenant — see §2)*
   - `requested_amount_pence BIGINT NOT NULL CHECK (requested_amount_pence > 0)`
   - `currency TEXT NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP')`
   - `recipient_email TEXT NOT NULL`, `recipient_name TEXT NOT NULL`
   - `status TEXT NOT NULL CHECK (status IN ('draft', 'requested', 'part_received', 'received', 'cancelled'))`
   - `requested_at TIMESTAMPTZ NULL`, `requested_by_person_id TEXT NULL`
   - `outbox_email_id TEXT NULL` *(links `public.email_outbox.id`; the enqueued `email_outbox` row also records nullable `matter_id` and `quote_id` via `0028` for `R823` outbox visibility filtering)*
   - `bank_details_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb` *(immutable snapshot of client-account bank details sent to the client)*
   - `intake_check_record_id TEXT NULL` *(links ADR 0038 `public.intake_check_records.id` for `recordManualPaymentRequest`)*
   - `notes TEXT NULL`
   - `cancelled_at TIMESTAMPTZ NULL`, `cancelled_by_person_id TEXT NULL`, `cancellation_reason TEXT NULL`
   - `row_version INTEGER NOT NULL DEFAULT 1`
   - `created_by_person_id TEXT NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `PRIMARY KEY (tenant_id, id)`
   - `CONSTRAINT uq_moa_requests_payment_ref UNIQUE (tenant_id, payment_reference)`
   - `CREATE INDEX idx_moa_requests_tenant_matter ON public.money_on_account_requests (tenant_id, matter_id, status, updated_at DESC);`
3. **`public.money_on_account_receipts` (append-only financial ledger of matched receipts and explicit reversals):**
   - `tenant_id TEXT NOT NULL`, `id TEXT NOT NULL`
   - `request_id TEXT NOT NULL` (`FOREIGN KEY (tenant_id, request_id) REFERENCES public.money_on_account_requests (tenant_id, id) ON DELETE RESTRICT`)
   - `matter_id TEXT NOT NULL` (`FOREIGN KEY (tenant_id, matter_id) REFERENCES public.matters (tenant_id, id) ON DELETE CASCADE`)
   - `source TEXT NOT NULL CHECK (source IN ('manual', 'pms_ledger'))`
   - `amount_pence BIGINT NOT NULL CHECK (amount_pence > 0)`
   - `received_date TEXT NOT NULL` *(YYYY-MM-DD)*
   - `bank_reference TEXT NULL`, `notes TEXT NULL`
   - `pms_transaction_id TEXT NULL` *(non-null when `source = 'pms_ledger'`, pointing to `pms_client_account_entries.transaction_id`)*
   - `pms_matter_code TEXT NULL`
   - `intake_check_record_id TEXT NULL` *(links ADR 0038 `public.intake_check_records.id` for `recordManualReceipt`)*
   - `evidence_artifact_id TEXT NULL` *(optional remittance slip in `public.evidence_artifacts`)*
   - `recorded_by_person_id TEXT NOT NULL`, `recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `reversed_at TIMESTAMPTZ NULL`, `reversed_by_person_id TEXT NULL`, `reversal_reason TEXT NULL` *(reversals stamp these columns rather than deleting rows, preserving audit integrity and allowing legitimate un-matching/re-matching if an entry was matched in error)*
   - `PRIMARY KEY (tenant_id, id)`
   - `CREATE INDEX idx_moa_receipts_request ON public.money_on_account_receipts (tenant_id, request_id, recorded_at DESC);`
   - `CREATE INDEX idx_moa_receipts_matter ON public.money_on_account_receipts (tenant_id, matter_id, recorded_at DESC);`
   - **Database-enforced no-double-match invariant:**
     ```sql
     CREATE UNIQUE INDEX IF NOT EXISTS uq_moa_receipts_tenant_pms_tx
       ON public.money_on_account_receipts (tenant_id, pms_transaction_id)
       WHERE pms_transaction_id IS NOT NULL AND reversed_at IS NULL;
     ```
     guarantees at PostgreSQL level that an imported PMS client ledger row can **never** be actively matched twice, even across concurrent requests or different MoA requests.

### 2. UK bank payment reference format (`<= 18` chars, zero PII)

UK Faster Payments and CHAPS payment references are typically capped at **18 uppercase alphanumeric/hyphen ASCII characters**. Because references appear on external bank statements (and therefore inside PMS descriptions and bank CSVs), the format contains **no client names or personal data**:

```text
MOA-<MATTER_TOKEN_MAX10>-<NN>
```
- `<MATTER_TOKEN_MAX10>`: derived from `matter.matterNumber` if permanently assigned (not starting with `'DRAFT'`), else `matter.id`, normalised via `.toUpperCase().replace(/[^A-Z0-9]/g, '')` and truncated/trimmed to at most **10 characters** (for example `MAT0010004` for `MAT001-0004` -> `MOA-MAT0010004-01`, `18` characters total; `M000012` -> `MOA-M000012-01`, `14` characters).
- `<NN>`: 2-digit per-matter sequence counter (`01`, `02`, ...) derived monotonically from existing requests for that matter inside `FOR UPDATE` on `public.matters`, guaranteeing strict uniqueness via `uq_moa_requests_payment_ref` even if the matter's `matter_number` was allocated on submission.

### 3. Matching to PMS client ledger lines (`pms_client_account_entries`)

1. **Strict positive-receipt filter:** Candidate ledger lines for matching are queried solely from `public.pms_client_account_entries` for the matter's linked `pms_code` in `public.pms_links` (`entity_type = 'matter'`, resolved after `canPersonAccessMatter`), filtered by:
   - `direction = 'Receipt'` AND `amount_pence > 0` (excluding `'Payment'` and `'Transfer to office'` rows cleanly);
   - `NOT EXISTS` an active unreversed row in `public.money_on_account_receipts` with `pms_transaction_id = pms_client_account_entries.transaction_id`.
2. **Concurrent transactional match:** Matching locks `public.matters FOR UPDATE`, `public.money_on_account_requests FOR UPDATE`, and `public.pms_client_account_entries FOR SHARE`, re-checks eligibility (`direction = 'Receipt'`, `amount_pence > 0`, linked `pms_code` matches `matter_id`, request not `'cancelled'`/`'draft'`), inserts `money_on_account_receipts` (catching `uq_moa_receipts_tenant_pms_tx` cleanly with `MOA_PMS_RECEIPT_ALREADY_MATCHED`), updates total unreversed receipts in exact `BigInt`/`MinorUnits`, transitions `money_on_account_requests.status` (`part_received` if `0 < received < requested`, `received` if `received >= requested`), and when `'received'`, **immediately stops** the active `communication_chases` row (`stopped_reason = 'received'`).
3. **Part-receipts and over-payments:** Multiple manual and/or PMS receipts may sum toward one request. `status` transitions to `'received'` once `SUM(unreversed amount_pence) >= requested_amount_pence`. Negative outflows (`'Payment'`/`'Transfer to office'`) never silently erase a recorded receipt; if a receipt bounces or was matched in error, Finance uses `reverseMoneyOnAccountReceiptAction` (`money_on_account:record_receipt` + mandatory reason) to reverse that receipt and revert request status (`received -> part_received -> requested`), restarting or resuming manual attention cleanly.

### 4. Wiring ADR 0038 `PaymentRequestProvider` & manual adapter

- Services in `src/server/services.ts` wire through `createTenantIntakeCheckProviders(ctx, ...).payments` (resolved via `resolveIntakeChecksIntegrationConfig` so `integrations.intakeChecks.payments.provider` is genuinely executed):
  - Sending a request invokes `ManualPaymentRequestProvider.recordManualPaymentRequest(ctx, { subjectType: 'matter', subjectId: matterId, amountMinorUnits: BigInt(requestedAmountPence), clientAccountReference: paymentReference, referenceCode: outboxId, ... })` (extended additively with in-transaction `recordCheckInTx` support so DB commits stay single-TX atomic while pre-verified evidence refs stay outside TX per ADR 0039) and passes `matterId` (and `quoteId` if linked) when enqueuing to `public.email_outbox` (`0028`).
  - Recording a manual or PMS-matched receipt invokes `ManualPaymentRequestProvider.recordManualReceipt(ctx, { ..., bankStatementReference: pmsTransactionId ?? bankReference })`.
  - Cancelling a request invokes a new additive method `recordManualCancellation` (`outcome: 'cancelled'`, already permitted by `0023`'s DB CHECK constraint `migrations/index.ts:3071`), and `PaymentRequestProvider` adds `listPaymentRequestsForSubject` (additive under `CORE_API_VERSION = '2.6.0'`).
  - `S1-08` domain/service validation enforces `amountMinorUnits > 0n` for requests and receipts, compensating `ManualPaymentRequestProvider`'s `>= 0n` baseline (`manualProviders.ts:471`).
- **Pre-live security guard & audited changes on bank details (`TenantConfiguration.moneyOnAccount`):**
  - Bank details (`accountName`, `bankName`, `sortCode`, `accountNumber`, optional `iban`/`bic`, payment reference instructions, request wording, `allowDemoPlaceholderBankDetails`) live in schema-validated `TenantConfiguration.moneyOnAccount` (safe defaults: `enabled: false`, empty bank details).
  - `client-not-a-law-firm/config/base.json` stores obviously invented demo details (`accountName: "Not A Law Firm LLP — Client Account (DEMO ONLY)"`, `sortCode: "00-00-00"`, `accountNumber: "00000000"`, `iban: "GB00DEMO00000000000000"`).
  - Dispatching a request fails closed if bank details are unconfigured or contain placeholder values (`00-00-00` / `00000000`) when `environment === 'live'` (`MOA_LIVE_PLACEHOLDER_BANK_DETAILS_FORBIDDEN`).
  - **MFA & masked audit trail (`R824`):** `saveMoneyOnAccountConfigAction` requires **`admin:access` + `mfaVerified: true`** and writes a same-transaction `audit_entries` record for every change recording **who (`byId`), when (`at`), and old and new values with all but the last 2 digits of `sortCode` and `accountNumber` masked** (e.g. `**-**-34`, `******78`; plus `iban` masked to its last 2 characters if present). This applies even under Lever 1 where there is no interactive edit screen.

### 5. Real transactional opening gate (`ADR 0040` `funds_on_account`)

- Replace both hard-coded `fundsOnAccountSatisfied: false` sites (`src/server/services.ts:6438` and `:36377`) with a real transactional check (`evaluateMatterFundsOnAccountInTx`):

  > **Canonical funds-on-account gate rule (`evaluateMatterFundsOnAccountInTx`):**
  > Inside the opening transaction (locking `public.money_on_account_requests` for the matter `FOR SHARE` and summing active unreversed `public.money_on_account_receipts`), funds on account are met (`fundsOnAccountSatisfied === true`) if and only if **all** of the following hold:
  > 1. At least one non-cancelled, non-draft request exists for the matter (`status IN ('requested', 'part_received', 'received')`).
  > 2. Every non-cancelled, non-draft request for the matter has `status = 'received'` (each such request's unreversed receipts total at least its `requested_amount_pence > 0`, leaving no unpaid or part-paid request open).
  > 3. Where the matter has an agreed payment-on-account amount (`agreedAmountPence > 0`, resolved from the matter's costs snapshot or retainer amount, falling back to its converted source quote's payment-on-account amount), the total unreversed receipts across all non-cancelled, non-draft requests for the matter is at least `agreedAmountPence`. Where no agreed amount is set on the matter, conditions (1) and (2) alone constitute the rule.
  >
  > Reversing a receipt **before** the matter opens recalculates request status and receipt totals immediately, so the opening gate blocks again until replacement funds are received or a partner records an audited `funds_on_account` override. Reversing a receipt **after** the matter has already opened does not change the matter's status or reopen the opening gate, because the gate applies only at opening.

- If the work type (`resolveWorkTypeOpeningGate`) has `requireFundsOnAccount === true`, prospective matter opening across all 5 gated paths (`saveMatterRecord`, `openProspectiveMatterRecord`, `updateMatterConflictRecord`, `signOffMatterCostsRecord`, `high_risk_opening` `compliance_approve`) blocks unless `fundsOnAccountSatisfied === true` or a partner holds an active audited `'funds_on_account'` override in `public.matter_opening_gate_overrides`.

### 6. Behaviour across both hosting models (Rule 6)

- **Model A (`single_tenant`):** Dedicated client database holds `money_on_account_requests`, `money_on_account_receipts`, `pms_client_account_entries`, and `tenant_module_configs['money_on_account']`. Single bank-details configuration and single isolated `SET LOCAL ROLE` connection pool.
- **Model B (`multi_tenant`):** Every tenant firm owns isolated bank details, payment references (`uq_moa_requests_payment_ref` scoped by `tenant_id`), requests, receipts (`uq_moa_receipts_tenant_pms_tx` scoped by `tenant_id`), outbox attachments, and PMS client ledger rows. Two-tenant PostgreSQL isolation tests verify tampered `requestId`, `receiptId`, `pmsTransactionId`, and `evidenceArtifactId` across tenants fail closed.

## Alternatives Considered

1. **Store requests and receipts solely in `public.intake_check_records.metadata_json` without dedicated tables:** Rejected. `intake_check_records` is an append-only check audit log without `row_version` concurrency, `status` projection, part-receipt summation constraints, foreign keys to `public.matters`, or partial unique index `uq_moa_receipts_tenant_pms_tx` to prevent concurrent double-matching of a PMS ledger line.
2. **Treat `pms_matter_financials.client_account_balance_pence > 0` alone as satisfying the opening gate:** Rejected (`S1-D4`). Imported PMS balances can reflect historical matters, unallocated deposits, or funds received prior to disbursements; an explicit request/receipt record (backed either by manual verification or a specific matched `'Receipt'` ledger row `transaction_id`) provides an auditable trail, clean part-receipt handling, and works for new matters not yet exported to PMS.
3. **Allow fee earners to match/record receipts directly without `finance` / `partner` separation:** Rejected (confirmed by owner decision Q4, 26 Nov 2026). Client account receipt verification is an SRA Accounts Rules financial control (`finance`, `partner`, `managing_partner`) separated from requesting payment (`fee_earner`, `legal_secretary`, etc.).

## Consequences

- `S1-08` completes the final Stage 1 work-type opening gate precondition (`requireFundsOnAccount` + real `fundsOnAccountSatisfied`), moving backlog items `4` and `6` to **Completed** (with deferred live payment links `F27` remaining on the Future list).
- Adds migration `0030_money_on_account_expand` (`CORE_REQUIRED_SCHEMA_VERSION = '0030'`) and three Money on Account RBAC permissions (`money_on_account:view`, `money_on_account:request`, `money_on_account:record_receipt`).
- Future payment-link integrations (`F27`) plug into `integrations.intakeChecks.payments.provider` behind `PaymentRequestProvider` without schema or opening-gate rewrites.
