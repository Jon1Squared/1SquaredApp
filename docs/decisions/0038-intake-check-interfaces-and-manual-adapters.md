# ADR 0038: Core Intake Check Interfaces, Manual Adapters, and Outbox-Held Email Attachments

- **Date:** 2026-11-22
- **Status:** Accepted (22 November 2026)
- **Roadmap:** Stage 1 decisions `S1-D1` and `S1-D11`, slice `S1-03` ([stage-1-plan.md](../roadmap/stage-1-plan.md)); backlog item `34` (and foundation for items `3`, `4`, `5`, `6`)
- **Builds on:** [ADR 0008](./0008-document-storage-provider-abstraction.md) (document storage), [ADR 0020](./0020-document-references-and-zero-content-storage.md) (document references & zero-PII telemetry), [ADR 0027](./0027-email-sender-interface.md) (per-tenant email outbox & adapter configuration), [ADR 0028](./0028-tenant-database-and-repositories.md) (tenant databases & repositories), [ADR 0035](./0035-digests-and-teams-delivery.md) (outbox drain & notifications), [ADR 0037](./0037-extension-api-v2-least-privilege-config-context.md) (extension API v2.0.0)

## Context

1. **Manual-first intake check contracts (`S1-D1`):** Stage 1 introduces client due diligence (item `4`), engagement letter execution (item `5`), quoting (item `3`), and money on account (item `6`). Following the product owner's decision (22 November 2026), Stage 1 ships **zero third-party integrations**: ID verification providers, sanctions/PEP screening APIs, e-signature providers, payment links, and live Companies House lookups are deferred to named backlog items (`F17`, `F24`–`F28`). However, coupling WP2 and WP3 (`S1-04`, `S1-06`, `S1-08`) to ad-hoc UI flags would force costly rewrites when live providers are added later, whereas shipping unconfigured "sandbox" or simulated stubs risks misrepresenting manual staff records as automated screening (plan Risk `R1`, Architecture Standard §10).
2. **Email attachments without shared disk or Azure Blob (`S1-D11`):** Stage 1 Plan §2 requires quoting (`S1-07`) and engagement (`S1-06`) to send generated quote and client-care PDFs via the transactional email outbox (`public.email_outbox`, ADR 0027). In today's code (`core/src/integrations/email/adapters.ts`), `resolveLoadedAttachments` throws `EMAIL_ATTACHMENT_STORAGE_UNAVAILABLE` whenever `storageProvider` is omitted, and none of the production outbox drain call sites in `src/server/services.ts` or `scripts/run-job.ts` passes one. Worse, under Stage 0 decision D4 (`local-fs`, demo only, one web replica), the web container (`ca-web`) and background drain job container (`caj-outbox-drain`) have **separate** local disks — so even wiring `local-fs` into the drain job would fail on background retries whenever the attachment was written on `ca-web`. By owner decision (`S1-D11`, revised 22 November 2026), Azure Blob (`azure-blob`) is **not** built in Stage 1 and remains on the "Before the first hosted client" list; transient outbound email attachment bytes must instead live in the tenant's PostgreSQL outbox.

## Decision

### 1. Narrow provider interfaces and additive `CORE_API_VERSION = '2.1.0'` (`core/src/api/index.ts`)

Add four provider interfaces and shared contract types to `@platform/core-api` (`core/src/api/index.ts`). Because all WP1 public-API additions (`S1-01` `CLIENT_CARE_DOCUMENT_TYPE`, `S1-03` intake checks + `'evidence'` storage category + outbox inline attachment types, and `S1-10` optional `tenantId` / `correlationId` on `DocumentPdfConverter.convertDocxToPdf`) are strictly additive and backward-compatible within `2.x` per Rule 7:

- Raise **`CORE_API_VERSION`** from `'2.0.0'` to **`'2.1.0'`** in `S1-03` and document the additions in [`core/docs/CHANGELOG.md`](../../core/docs/CHANGELOG.md).
- Existing extension manifests declaring `^2.0.0` continue to satisfy semver range validation unchanged.

The four intake check contracts:

1. `IdentityVerificationProvider` (`kind: 'identity_verification'`): records manual identity verification outcomes (`'verified' | 'failed' | 'pending' | 'expired'`), verification method, reference, expiry date, reviewer `actorId`, and verified `IntakeEvidenceArtifactRef[]`.
2. `SanctionsPepScreeningProvider` (`kind: 'sanctions_pep'`): records manual sanctions/PEP screening checks (`'clear' | 'match_flagged' | 'pending'`), screening scope, reviewer `actorId`, server timestamp, and verified `IntakeEvidenceArtifactRef[]`. Display helpers always label manual records explicitly (`"Recorded manually by <person> on <date>"`), never `"screened by provider"`.
3. `ESignatureProvider` (`kind: 'e_signature'`): records manual engagement letter dispatch and uploaded signed-copy outcomes (`'requested_manual' | 'signed_uploaded' | 'declined'`), signed document/evidence reference, actor, and timestamp.
4. `PaymentRequestProvider` (`kind: 'payment_request'`): records manual client-account payment requests and manual receipt confirmations (`amountMinorUnits` as `bigint` pence, currency `'GBP'`, client-account reference, actor, timestamp, and optional evidence reference). Never computes with floating-point pounds.

### 2. Shared `'evidence'` storage category & tenant-scoped intake check persistence

1. **`'evidence'` storage category (`DocumentStorageProvider.putObject`):** Add `'evidence'` additively to `DocumentStorageProvider.putObject`'s `category` union (`'templates' | 'documents' | 'evidence'` in `core/src/api/index.ts` and `core/src/tenancy/blobStorage.ts`). Uploaded intake and CDD evidence objects live inside the active tenant's own container under `${ctx.blobContainerName}/evidence/<objectId>/<fileName>`, hashed (SHA-256) and malware-scanned identically to documents (`ADR 0008`), with short-lived download tokens scoped to `(tenantId, actorId, documentId)`. Per Stage 0 exit decision D4, `local-fs` remains restricted to non-live single-replica demos and `live` environments fail closed until `azure-blob` is implemented before the first hosted client.
2. **Per-tenant PostgreSQL table (`public.intake_check_records`):** Created by reversible expand migration `0023_intake_checks_and_outbox_attachments_expand` (`downSql` drops the table, child attachment table, and indexes cleanly per Rule 8) and served by `TenantIntakeCheckRepository extends TenantScopedRepository` (`SET LOCAL ROLE` over `NOINHERIT` `runtime_login`). Every manual provider validates:
   - verified `TenantContext` (`TENANCY_FORGERY_DETECTED` / `UNAUTHENTICATED`);
   - non-empty `actorId` and valid subject scope (`'person' | 'organisation' | 'matter' | 'quote'`);
   - every attached `IntakeEvidenceArtifactRef` belongs to the caller's tenant container (`assertBlobKeyBelongsToTenant`), passes malware scan (`scanStatus === 'clean'`), and rejects missing, quarantined, pending, or cross-tenant blob keys or tampered IDs before any write inside `withTenantTransaction`;
   - appends an `audit_entries` row in the **same transaction** containing check kind, record ID, actor ID, outcome, `correlationId`, and `tenantId` — zero PII, zero client names, and zero original filenames (`ADR 0020`).
3. **No sandbox or simulated adapters:** Stage 1 ships only `'manual'` implementations behind `resolveIntakeChecksIntegrationConfig` and `createTenantIntakeCheckProviders` (`core/src/integrations/intake-checks/`). Future automated providers add new adapter values without changing workflow services or core entity schemas, and must read secrets exclusively from Key Vault (`assertTenantOwnsKeyVaultSecretRef`).

### 3. Outbox-held email attachments (`S1-D11`)

1. **Child table `public.email_outbox_attachments` (migration `0023`):** Reversible expand migration `0023_intake_checks_and_outbox_attachments_expand` (raising `CORE_REQUIRED_SCHEMA_VERSION = '0023'`) creates `public.email_outbox_attachments` keyed by `(tenant_id, outbox_id, ordinal)` referencing `public.email_outbox (tenant_id, id) ON DELETE CASCADE`, storing `file_name`, `content_type`, `byte_size`, `sha256`, `content_bytes BYTEA NOT NULL`, and `created_at`. Keeping `BYTEA` payloads in a child table prevents every outbox status scan, claim batch, or `listOutboxRecords` query on `public.email_outbox` from reading multi-megabyte TOAST blobs unnecessarily, while cascading deletes and clean rollback (`downSql`) via one table drop.
2. **Size cap enforced at enqueue (`MAX_EMAIL_TOTAL_ATTACHMENT_BYTES = 3_000_000`):** Total raw attachment bytes across all attachments on a single queued email must not exceed **`3_000_000` bytes (~3 MB)** — staying safely within Microsoft Graph's 4 MiB inline `sendMail` JSON payload ceiling after base64 expansion (~4.0 MB) + JSON/headers. `TenantOutboxRepository.enqueueEmail` validates both individual attachment non-empty size (`contentBytes instanceof Uint8Array`, valid `fileName`/`contentType`) and total sum `<= 3_000_000` **before** inserting any row, throwing `EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED` fail-closed. `CoreEmailDispatcher.send` enforces the same ceiling as a defence-in-depth guard.
3. **Transactional enqueue & metadata projection:** `OutgoingEmail.attachments` and `EnqueueEmailOutboxInput.attachments` widen backward-compatibly to support inline `EmailInlineAttachment` payloads (`{ kind: 'inline', fileName, contentType, contentBytes }`) alongside legacy `EmailAttachmentRef` (`{ blobKey, ... }`). On production outbox enqueue (`enqueueEmail`), inline attachment bytes are inserted into `public.email_outbox_attachments` inside the same `withTenantTransaction` as `public.email_outbox`, while `public.email_outbox.attachments_json` stores non-byte metadata (`source: 'outbox'`, `ordinal`, `fileName`, `contentType`, `byteSize`, `sha256`). Idempotency deduplication on `(tenant_id, idempotency_key)` skips duplicate attachment inserts cleanly. Outbox rows are prohibited from relying on local disk (`blobKey` without outbox bytes fails cleanly on drain unless a caller explicitly supplies a `storageProvider` for direct unit dispatch).
4. **Every drain reads from the outbox (`outboxDrain.ts`):** During `drainEmailOutboxForTenant`:
   - For each claimed row (under `status = 'sending'` and matching `claimToken`), when `attachments_json` metadata indicates outbox-held attachments, `TenantOutboxRepository.getClaimedOutboxAttachmentBytes(ctx, { outboxId: row.id, claimToken: row.claimToken })` loads the ordered `content_bytes` rows from `public.email_outbox_attachments` over `SET LOCAL ROLE`, asserting `tenant_id = $1`, `status = 'sending'`, `claim_token = $3`, matching `sha256`, and `assertRowTenant`.
   - It passes those inline bytes directly into `CoreEmailDispatcher.send(...)`, whose `resolveLoadedAttachments` reads inline bytes in memory without needing `DocumentStorageProvider`.
   - Therefore, **all** production drain call sites — the immediate/best-effort in-app drains (`enqueueNotificationEmailIfEnabled`, `drainNotificationOutboxesBestEffort`, `sendEnquiryEmailRecord`, `executeNotificationDigestsForTenant` in `src/server/services.ts`) and the scheduled `outbox-drain` sweep (`runScheduledOutboxDrainJobSweep` / `scripts/run-job.ts`) — deliver quote and engagement PDFs without shared disk or `DocumentStorageProvider`.
5. **Retention scrubbing (`outboxContentRetentionDays`):** `TenantOutboxRepository.scrubExpiredOutboxContent` deletes matching rows from `public.email_outbox_attachments` inside the **same** advisory-locked transaction (`onesquared_outbox_scrub:${ctx.tenantId}`) that nulls `subject`, `html_body`, `text_body`, clears `recipients_json = '{"to":[]}'::jsonb`, resets `attachments_json = '[]'::jsonb`, and stamps `content_scrubbed_at` on `public.email_outbox`.
6. **Zero attachment bytes in logs, telemetry, or audit entries:** Attachment bytes, base64 strings, and original attachment filenames are never logged, emitted to telemetry (`emitTenantTelemetryEvent` / `emitTenantTelemetryException`), or written to `audit_entries` (`ADR 0020`, Standard §§8, 10, 13).

### 4. Additive tenant configuration (`integrations.intakeChecks`)

Add an optional `integrations.intakeChecks` subtree in `core/schemas/tenant-config.schema.json` and `core/src/config-engine/index.ts`:

```text
integrations.intakeChecks = {
  idVerification: { provider: 'manual' },
  sanctionsPep:   { provider: 'manual' },
  eSignature:     { provider: 'manual' },
  payments:       { provider: 'manual' }
}
```

- `'manual'` is the only valid enum value in Stage 1 and is the default for all four checks; unknown keys are rejected.
- `loadAndValidateTenantConfig` explicitly deep-merges `integrations.intakeChecks` and each child object (`idVerification`, `sanctionsPep`, `eSignature`, `payments`) between `base.json` and environment overlays so setting one check in an overlay never drops siblings from `base.json`.
- Export `resolveIntakeChecksIntegrationConfig` and `createTenantIntakeCheckProviders` in `core/src/integrations/intake-checks/adapters.ts` (outside `config-engine/` and `api/`) so every configuration leaf is genuinely read by runtime provider resolution and satisfies `core/tests/tenant-config-usage.test.ts`.

### 5. Telemetry and logs

Structured log, audit, and telemetry events emit only `tenantId`, `correlationId`, `checkKind` / `templateKey`, `provider`, `outcome`, attachment count/byte total (or opaque `outboxId` / `recordId`) — never personal names, addresses, file names, raw check notes, or attachment bytes (`ADR 0020`, Standard §§8, 10, 13).

## Alternatives Considered

1. **Add simulated/sandbox adapters for third-party APIs in Stage 1:** Rejected by product owner decision (22 November 2026) and Risk `R1`; simulated responses add dead code, complicate audit provenance, and risk users mistaking manual checks for live third-party screening.
2. **Store check outcomes only on ad-hoc CDD/engagement/matter tables with no core interfaces:** Rejected because post-Stage-1 live integrations would have to refactor WP2/WP3 application services rather than adding a new provider behind `integrations.intakeChecks.*.provider`.
3. **Implement `azure-blob` or mount Azure Files for Stage 1 email attachments:** Considered and rejected under revised owner decision `S1-D11` (22 November 2026). `azure-blob` remains on the "Before the first hosted client" list; keeping Stage 1 email attachment bytes in the tenant outbox avoids new Azure storage infrastructure while still fixing cross-container `caj-outbox-drain` delivery reliably.
4. **Store `BYTEA` directly on `public.email_outbox` instead of `public.email_outbox_attachments`:** Storing large `BYTEA` columns inline on `public.email_outbox` bloats row metadata scans (`listOutboxRecords`, retry sweeps) and complicates partial scrubbing; a dedicated child table keeps queue metadata small and allows hard `DELETE` scrubbing of binary bytes on retention.

## Consequences

- WP2 (`S1-04`, `S1-05`) and WP3 (`S1-06`, `S1-07`, `S1-08`) consume stable `@platform/core-api` v`2.1.0` contracts and outbox-held PDF attachments without waiting for vendor accounts, Azure Blob storage, or shared filesystem mounts across Container Apps.
- Adding real third-party intake providers after Stage 1 is an additive schema/adapter change under `integrations.intakeChecks`, requiring zero changes to workflow orchestration or core entity tables.
- Requires reversible expand migration `0023_intake_checks_and_outbox_attachments_expand` (`CORE_REQUIRED_SCHEMA_VERSION = '0023'`) and two-tenant PostgreSQL tests covering evidence blobs, outbox attachments without `DocumentStorageProvider`, size-cap enforcement, retention scrubbing, tampered `outboxId`/`claimToken`, and forged `TenantContext` claims in `S1-03`.
