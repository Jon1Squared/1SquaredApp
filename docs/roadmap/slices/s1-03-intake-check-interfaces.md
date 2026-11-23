# S1-03: Intake Check Interfaces, Manual Adapters, and Outbox-Held Email Attachments (`S1-D1`, `S1-D11`, `ADR 0038`)

| | |
|---|---|
| Backlog | Item `34` (`P7`, `P8`, `E8`; foundations for items `3`, `4`, `5`, `6`; `S1-D11` email attachments) |
| Decision | [ADR 0038: Core Intake Check Interfaces, Manual Adapters, and Outbox-Held Email Attachments](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md) (`Accepted`, 22 November 2026); `S1-D1`, `S1-D11` |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP1 (`S1-03`) |
| Branch | `s1-03-intake-check-interfaces`, stacked on `s1-01-quick-fixes`, targeting `develop` |
| Change class | Core extension/integration API (`core/src/api/`, `CORE_API_VERSION` `2.1.0`), Core configuration schema & deep-merge (`core/schemas/`, `core/src/config-engine/`), Core tenancy storage, repository & expand migration `0023` (`core/src/tenancy/`), Core manual intake adapters & outbox email drain (`core/src/integrations/`) |
| Layer | Core (`@platform/core-api`, `@platform/core`); **no UI in this slice** (`WP2` and `WP3` consume these interfaces and outbox attachments) |
| Size | M |
| Depends on | `S1-01`; [ADR 0038](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md) (`Accepted`) |
| Blocking manual tasks | Running `caj-migrate-demo` in Azure when deploying WP1 (applies migration `0023`). Live vendor provider accounts remain deferred out of Stage 1; live client document/evidence storage stays gated on `azure-blob` before first hosted client (`ADR 0008`). |
| Baseline | `develop` at `7c2ba3e` |

## What exists today

Checked against `develop` (`7c2ba3e`):

1. **Public API & intake integration adapters (`core/src/api/index.ts`, `core/src/integrations/`):**
   - `CORE_API_VERSION` is `'2.0.0'` (`core/src/api/index.ts:8`).
   - Email and Teams integrations follow a standard pattern (`EmailSender`, `TeamsNotifier`, typed tenant config, runtime resolver, core adapter module). **No intake check interfaces** (`IdentityVerificationProvider`, `SanctionsPepScreeningProvider`, `ESignatureProvider`, `PaymentRequestProvider`) exist yet.
2. **Evidence blob storage constraint (`core/src/api/index.ts:610`, `core/src/tenancy/blobStorage.ts:172`):**
   - `DocumentStorageProvider.putObject` accepts `category: 'templates' | 'documents'` only and lacks `'evidence'`.
3. **Configuration usage CI check & shallow `integrations` merge (`core/tests/tenant-config-usage.test.ts:482-519`, `core/src/config-engine/index.ts:3434-3511`):**
   - `tenant-config-usage.test.ts` requires every non-reserved schema leaf under `core/schemas/tenant-config.schema.json` to be read via a dotted config expression outside `config-engine/` and `api/` (and rejects `x-reserved:S1-*` at `:506`). `loadAndValidateTenantConfig` needs explicit deep-merge for `integrations.intakeChecks` and its four child objects.
4. **Outbox email attachments fail across containers (`B-3`, `S1-D11`):**
   - `public.email_outbox` (`migrations/index.ts:2577`) stores `attachments_json JSONB`, and `CoreEmailDispatcher.send` (`core/src/integrations/email/adapters.ts:364-391`) calls `resolveLoadedAttachments`, which throws `EMAIL_ATTACHMENT_STORAGE_UNAVAILABLE` whenever `storageProvider` is omitted.
   - None of the in-app drain call sites in `src/server/services.ts` (`enqueueNotificationEmailIfEnabled` `:11214`, `drainNotificationOutboxesBestEffort` `:11334`, `sendEnquiryEmailRecord` `:14343`, `runScheduledOutboxDrainJobSweep` `:27229`, `executeNotificationDigestsForTenant` `:27804`) nor `scripts/run-job.ts:603` (`outbox-drain`) receives a `DocumentStorageProvider` — and under Stage 0 decision D4 (`local-fs`), `ca-web` and `caj-outbox-drain` do not share local disk anyway.
   - Nor does `TenantOutboxRepository.enqueueEmail` enforce an attachment size limit or store attachment bytes in PostgreSQL.
5. **Migration coordination in WP1 (`S1-01` -> `S1-03` -> `S1-02a` -> `S1-10`):**
   - `CORE_REQUIRED_SCHEMA_VERSION` is `'0022'`. Because `S1-03` precedes `S1-02a` in WP1 v3.1, **`S1-03` claims migration `0023`** (`0023_intake_checks_and_outbox_attachments_expand`, raising `CORE_REQUIRED_SCHEMA_VERSION` to `'0023'`), leaving **`0024`** for `S1-02a` if indexes are added.

## Files and changes

1. **Core public API contracts & additive `2.1.0` bump (`core/src/api/index.ts`, `core/docs/CHANGELOG.md`):**
   - Raise `CORE_API_VERSION` from `'2.0.0'` to **`'2.1.0'`** (additive minor bump per Rule 7 and `ADR 0038`; `^2.0.0` extension manifests remain compatible) and record WP1 `2.1.0` additions in `core/docs/CHANGELOG.md`.
   - Export intake check types & interfaces:
     - `IntakeCheckProviderMode = 'manual'`
     - `IntakeEvidenceArtifactRef`: `{ blobKey: string; sha256: string; contentType: string; sizeBytes: number; scanStatus: 'clean' | 'pending' | 'quarantined' }`
     - `IdentityVerificationProvider` (`recordManualCheck`, `getLatestCheckForSubject`)
     - `SanctionsPepScreeningProvider` (`recordManualScreening`, `getLatestScreeningForSubject`)
     - `ESignatureProvider` (`recordManualRequest`, `recordManualSignedDocument`, `getLatestEnvelope`)
     - `PaymentRequestProvider` (`recordManualPaymentRequest`, `recordManualReceipt`, `getPaymentRequest`, strictly using `bigint` integer minor units)
     - `TenantIntakeChecksIntegrationConfig`
   - Widen `DocumentStorageProvider.putObject`'s `category` union additively to `'templates' | 'documents' | 'evidence'`.
   - Add additive outbox attachment contracts & constants:
     - `MAX_EMAIL_TOTAL_ATTACHMENT_BYTES = 3_000_000` (3 MB per message)
     - `EmailInlineAttachment` (`{ readonly kind: 'inline'; readonly fileName: string; readonly contentType: string; readonly contentBytes: Uint8Array; readonly sha256?: string; readonly byteSize?: number }`)
     - `EmailOutboxAttachmentMetadata` (`{ readonly source: 'outbox'; readonly ordinal: number; readonly fileName: string; readonly contentType: string; readonly byteSize: number; readonly sha256: string }`)
     - Widen `OutgoingEmail.attachments` (`readonly (EmailAttachmentRef | EmailInlineAttachment)[]`) and `EmailOutboxRecord.attachments` (`readonly (EmailAttachmentRef | EmailOutboxAttachmentMetadata)[]`) backward-compatibly.
2. **Reversible expand migration `0023` (`core/src/tenancy/migrations/index.ts`):**
   - Add `INTAKE_CHECKS_AND_OUTBOX_ATTACHMENTS_MIGRATION_0023` (`0023_intake_checks_and_outbox_attachments_expand`, `dependsOn: ['0007', '0019']` — scoped directly to the migrations providing `public.audit_entries` and `public.email_outbox` so `0022` can still roll back independently as exercised in `migrations-postgres.test.ts`; `CORE_REQUIRED_SCHEMA_VERSION = '0023'`, `downSql` drops added tables/indexes cleanly per Rule 8):
     - **`public.intake_check_records`:** `tenant_id`, `id`, `check_kind`, `provider` (`'manual'`), `subject_type` (`'person' | 'organisation' | 'matter' | 'quote'`), `subject_id`, `outcome` (per-kind `CHECK` constraint `chk_intake_check_records_outcome_by_kind` enforcing the published outcome enums), `amount_minor_units BIGINT NULL`, `reference_code TEXT NULL`, `metadata_json JSONB`, `evidence_refs_json JSONB`, `recorded_by_person_id`, `recorded_at TIMESTAMPTZ`, `correlation_id`, indexed by `(tenant_id, subject_type, subject_id, check_kind, recorded_at DESC)`.
     - **`public.email_outbox_attachments`:** `tenant_id TEXT NOT NULL`, `outbox_id TEXT NOT NULL`, `ordinal INTEGER NOT NULL CHECK (ordinal >= 0)`, `file_name TEXT NOT NULL`, `content_type TEXT NOT NULL`, `byte_size INTEGER NOT NULL CHECK (byte_size > 0)`, `sha256 TEXT NOT NULL`, `content_bytes BYTEA NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `PRIMARY KEY (tenant_id, outbox_id, ordinal)`, `FOREIGN KEY (tenant_id, outbox_id) REFERENCES public.email_outbox (tenant_id, id) ON DELETE CASCADE`.
   - Ensure `tablesChanged` includes `['intake_check_records', 'email_outbox_attachments']` so `TenantMigrationRunner` grants tenant role CRUD privileges cleanly.
3. **Outbox-held attachments in repository, drain & dispatcher (`core/src/tenancy/outboxRepository.ts`, `core/src/integrations/email/outboxDrain.ts`, `core/src/integrations/email/adapters.ts`):**
   - **`TenantOutboxRepository.enqueueEmail` (`outboxRepository.ts`):**
     - Accept `EmailInlineAttachment` items (`kind: 'inline'`), validate filename, MIME type, non-empty `Uint8Array`, and enforce cumulative message size `<= MAX_EMAIL_TOTAL_ATTACHMENT_BYTES` (`3_000_000` bytes) **at enqueue** (before inserting rows, throwing `EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED`).
     - Inside the same `withTenantTransaction` as `INSERT INTO public.email_outbox`, insert each attachment's raw `Buffer` into `public.email_outbox_attachments` (skipped automatically when `idempotency_key` deduplicates an existing message) and store lightweight `EmailOutboxAttachmentMetadata` entries in `attachments_json`.
   - **`TenantOutboxRepository.getClaimedOutboxAttachmentBytes` (`outboxRepository.ts`):**
     - New tenant-scoped reader verifying `tenant_id = $1`, `o.id = $2`, `o.status = 'sending'`, `o.claim_token = $3`, and `o.content_scrubbed_at IS NULL`, checking `assertRowTenant`, verifying `sha256` digest integrity, and returning ordered `EmailInlineAttachment[]`.
   - **`drainEmailOutboxForTenant` (`outboxDrain.ts`):**
     - For every claimed row carrying outbox-stored attachments, load bytes via `outboxRepo.getClaimedOutboxAttachmentBytes(ctx, { outboxId: row.id, claimToken: row.claimToken })`, resolve strictly by `ordinal` (throwing `EMAIL_OUTBOX_ATTACHMENT_MISSING` on missing ordinals and `EMAIL_OUTBOX_ATTACHMENT_CORRUPTED` if metadata `sha256` differs from stored bytes, with zero positional fallback, `R674`), and pass them in `attachments` to `sender.send(...)` — requiring **zero** `DocumentStorageProvider`. Because all in-app drain helpers (`src/server/services.ts:11214, 11334, 14343, 27229, 27804`) and `scripts/run-job.ts:603` invoke `drainEmailOutboxForTenant` / `drainOutboxForTenant`, every drain entry point works identically without a shared filesystem or storage provider.
   - **`CoreEmailDispatcher` (`adapters.ts`):**
     - Update `resolveLoadedAttachments` so `kind: 'inline'` attachments encode `contentBytes` directly to base64 (still enforcing `MAX_EMAIL_TOTAL_ATTACHMENT_BYTES` defence-in-depth) without requiring `storageProvider`, while preserving existing `blobKey` resolution when `storageProvider` is supplied.
   - **`TenantOutboxRepository.scrubExpiredOutboxContent` (`outboxRepository.ts`):**
     - Inside the existing advisory-locked retention transaction (`outboxContentRetentionDays`), execute `DELETE FROM public.email_outbox_attachments WHERE tenant_id = $1 AND outbox_id = ANY($2)` for the scrubbed `id`s alongside clearing `attachments_json = '[]'::jsonb`, `recipients_json`, `subject`, `html_body`, and `text_body`.
   - **Zero-PII telemetry/logging:** Audit, log, and telemetry fields omit filenames, base64 payloads, and raw bytes (log only numeric `attachmentCount` / `attachmentBytes` when helpful).
4. **Evidence storage, `TenantIntakeCheckRepository` & manual providers (`core/src/tenancy/blobStorage.ts`, `core/src/tenancy/intakeCheckRepository.ts`, `core/src/integrations/intake-checks/`):**
   - `blobStorage.ts`: support `category: 'evidence'` under `${ctx.blobContainerName}/evidence/...`, retaining exact `expectedBlobContainerName(ctx.tenantId, ctx.environment)` validation (`R672`, preventing tenant-ID prefix and environment bypasses), `assertBlobKeyBelongsToTenant`, SHA-256, and malware scan gates.
   - `intakeCheckRepository.ts`: `TenantIntakeCheckRepository extends TenantScopedRepository` enforcing `SET LOCAL ROLE`, composite `(tenant_id, ...)` queries, tampered ID rejection (`assertRowTenant`), and same-transaction `audit_entries` writes with zero PII / zero filenames (`ADR 0020`).
   - `core/src/integrations/intake-checks/manualProviders.ts` & `adapters.ts` (re-exported via `core/src/index.ts`):
     - `ManualIdentityVerificationProvider`, `ManualSanctionsPepScreeningProvider`, `ManualESignatureProvider`, `ManualPaymentRequestProvider` verifying every `IntakeEvidenceArtifactRef` belongs to `ctx`'s tenant container (`assertBlobKeyBelongsToTenant`), exists in `DocumentStorageProvider`, and has `scanStatus === 'clean'`, stamping server `actorId` and `recordedAt` and appending `audit_entries`.
     - `resolveIntakeChecksIntegrationConfig` and `createTenantIntakeCheckProviders` reading all four config leaves (`idVerification.provider`, `sanctionsPep.provider`, `eSignature.provider`, `payments.provider`), failing closed on any unknown provider string. No sandbox/simulated adapters.
5. **Configuration schema & deep merge (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`):**
   - Add `integrations.intakeChecks` (`idVerification`, `sanctionsPep`, `eSignature`, `payments`, enum `['manual']`, default `'manual'`, `additionalProperties: false`).
   - Update `TenantConfigurationSchema` and nested deep-merging inside `loadAndValidateTenantConfig` so overlay overrides preserve sibling `base.json` keys.

## Tests

*(Record fail-first evidence before implementation in `Stage1-WP1-report.md`.)*

1. **Outbox-held attachments & drain tests (`core/tests/intake-checks-s103.test.ts` & `core/tests/email-notifications-s026.test.ts`):**
   - Fail-first: enqueuing an inline PDF > `MAX_EMAIL_TOTAL_ATTACHMENT_BYTES` (~3 MB) rejects with `EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED` and writes zero DB rows.
   - Enqueuing a valid PDF within limit stores bytes in `public.email_outbox_attachments`, deduplicates on `idempotencyKey`, and delivers MIME attachments via `dev_catcher` and Graph `sendMail` through `drainOutboxForTenant` **with `storageProvider: undefined`** (both on first attempt and after a retry simulation, matching `caj-outbox-drain` + in-app drains), whilst `EMAIL_OUTBOX_ATTACHMENT_MISSING` / `EMAIL_OUTBOX_ATTACHMENT_CORRUPTED` fail closed immediately as `failed_permanent` (`R674`, `R693`).
   - `scrubExpiredOutboxContent` past `outboxContentRetentionDays` deletes rows from `public.email_outbox_attachments` (confirmed `COUNT(*) = 0`) and clears `attachments_json`.
   - Spy on logger/telemetry/audit entries during enqueue, drain, and failure: confirm zero attachment bytes, base64 strings, or filenames appear.
   - Two-tenant PostgreSQL isolation: tampered `outboxId` (Tenant A claiming or calling `getClaimedOutboxAttachmentBytes` with Tenant B's `outboxId`), wrong `claimToken`, and forged `TenantContext` claims all return empty/reject cleanly and leave Tenant B untouched.
2. **Intake check contract, config & isolation tests (`core/tests/intake-checks-s103.test.ts`, `core/tests/tenant-config-usage.test.ts`, `core/tests/migrations-postgres.test.ts`):**
   - Fail-first: each manual provider records outcome, server actor, server timestamp, `amountMinorUnits` (`bigint` pence, rejecting non-integer/negative amounts), and verified `'evidence'` blob references; rejects unknown or simulated provider strings fail-closed.
   - Config deep-merge preserves sibling keys across `base.json` + overlay; `core/tests/tenant-config-usage.test.ts` passes with every new schema leaf read at runtime.
   - `0023` `up -> down -> up` migration round-trip passes (`core/tests/migrations-postgres.test.ts`).
   - Two-tenant PostgreSQL tests: Tenant A passing Tenant B's valid `'evidence'` `blobKey` (or quarantined/missing blob) fails closed and writes zero rows; forged claims and tampered record IDs reject.

## Help and documentation (rule 11)

- `src/docs/articles/tenant-settings.ts`: document `integrations.intakeChecks` (`manual` in Stage 1; live providers deferred).
- `src/docs/articles/deployment-and-security.ts`: document `'evidence'` blob container isolation, outbox-held transient PDF attachments (3 MB limit, retention scrub), and zero-PII logging guarantees (`ADR 0038`, `ADR 0020`).
- `core/docs/CHANGELOG.md`: document `@platform/core-api` v`2.1.0` additive release.
- `docs/roadmap/feature-list.md`: update row `34` (`What exists`), `P7`, `P8`, `E8`.
- `docs/release-notes.md`: add `S1-03` entry under `Unreleased`.

## Acceptance criteria

- `@platform/core-api` (`CORE_API_VERSION = '2.1.0'`) exports the four intake check interfaces, `'evidence'` `putObject` category, and inline outbox attachment contracts without breaking `^2.0.0` extension compatibility.
- Only `'manual'` providers exist (no sandbox/simulated adapters), no UI changes are added in this slice, `enqueueEmail` -> `drainOutboxForTenant` sends attachments cleanly without `storageProvider` across every drain entry point, `outboxContentRetentionDays` deletes attachment bytes, and `tenant-config-usage.test.ts`, migration `0023` round-trip, and two-tenant PostgreSQL + tampered-ID tests all pass.

## Manual blockers

- Executing `caj-migrate-demo` in Azure when deploying WP1 (migration `0023`; Stage 1 plan §8). Live third-party provider accounts remain deferred; live client evidence hosting stays gated on `azure-blob` before first hosted client.

## Rollback

- **Pre-rollback / pre-downgrade outbox drain gate (`R669`):** Before reverting `s1-03-intake-check-interfaces` or executing `downSql` for `0023` (and avoid running mixed `0022` + `0023` drain replicas), **drain or explicitly mark as failed/cancelled every pending row in `public.email_outbox` that has child rows in `public.email_outbox_attachments`**. Pre-`0023` (`0022`) outbox drain workers ignore `public.email_outbox_attachments` and `EmailOutboxAttachmentMetadata` entries without a `blobKey`, which would otherwise dispatch those emails without their PDF attachments.
- Expand migration `0023` drops `public.intake_check_records` and `public.email_outbox_attachments` cleanly via `downSql`; `integrations.intakeChecks` defaults safely; once no pending outbox-attachment rows remain, revert `s1-03-intake-check-interfaces` and execute `downSql` for `0023`.

## Pull request description must state

- **Change class:** Core API v`2.1.0` contracts, manual intake-check adapters, outbox-held email attachment storage & drain (`S1-D11`), config schema + deep-merge, and reversible per-tenant migration `0023` ([ADR 0038](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md)).
- **Both hosting models:** Identical across Model A (`single_tenant`) and Model B (`multi_tenant`); evidence blobs, intake check records, and outbox attachments scope strictly to verified `TenantContext`.
- **Migration and rollback:** Additive expand migration `0023` (`CORE_REQUIRED_SCHEMA_VERSION = '0023'`, `dependsOn: ['0007', '0019']`) reversible via `downSql` + `git revert`. **Rollback prerequisite (`R669`):** drain or fail/cancel all pending `public.email_outbox` rows that carry `public.email_outbox_attachments` bytes *before* reverting to pre-`0023` drain code or running `0023` `downSql` so emails are never sent without their PDFs.
