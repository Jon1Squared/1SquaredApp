# S1-03: Intake Check Interfaces and Manual Implementations (S1-D1, ADR 0038)

| | |
|---|---|
| Backlog | Item `34` (`P7`, `P8`, `E8`; foundations for items `4`, `5`, `6`) |
| Decision | [ADR 0038: Small Core Intake Check Interfaces with Manual Evidence-Backed Implementations](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md) (`S1-D1`, set to `Accepted` once approved in Phase 1) |
| Stage plan | `docs/roadmap/stage-1-plan.md`, WP1 (`S1-03`) |
| Branch | `s1-03-intake-check-interfaces`, stacked on `s1-02-scoped-queries`, targeting `develop` |
| Change class | Core extension/integration API (`core/src/api/`), Core configuration schema & engine (`core/schemas/`, `core/src/config-engine/`), Core tenancy repository & migration (`core/src/tenancy/`), Core manual adapters (`core/src/integrations/intake-checks/`) |
| Layer | Core (`@platform/core-api`, `@platform/core`); **no UI in this slice** (`WP2` and `WP3` consume these interfaces) |
| Size | S |
| Depends on | `S1-D1` (`ADR 0038` acceptance), stacked on `S1-02` |
| Blocking manual tasks | Live third-party provider accounts/keys are deferred out of Stage 1 by owner decision (`22 November 2026`); no live external setup blocks `S1-03`. Live client evidence hosting remains blocked on `azure-blob` (`ADR 0008` Stage 0 exception) before first hosted client. |
| Baseline | `develop` at `7c2ba3e` |

## What exists today

Checked against `develop` (`7c2ba3e`):

1. **Public API & integration adapter conventions (`core/src/api/index.ts`, `core/src/integrations/email/adapters.ts`, `core/src/integrations/teams/adapters.ts`):**
   - Email and Teams integrations define small interfaces in `@platform/core-api` (`EmailSender`, `TeamsNotifier`), a config type (`TenantEmailIntegrationConfig`, `TenantTeamsIntegrationConfig`), a runtime resolver (`resolveEmailIntegrationConfig`, `resolveTeamsIntegrationConfig`), and core implementations in `core/src/integrations/`.
   - **No intake check interfaces** (ID verification, sanctions/PEP screening, e-signature, payment request) exist anywhere in `core/src/api/index.ts` or `core/src/integrations/` yet.
2. **Evidence blob storage constraint (`core/src/api/index.ts:605-649`, `core/src/tenancy/blobStorage.ts:58-263`):**
   - `DocumentStorageProvider.putObject` (`core/src/api/index.ts:610`, `blobStorage.ts:172`) currently accepts `category: 'templates' | 'documents'` only — it lacks an `'evidence'` category prefix.
   - `assertBlobKeyBelongsToTenant(ctx, blobKey)` (`blobStorage.ts:58-79`), `scanBytesForMalwareAndMacros` (`:84-102`), `getObjectBytes` quarantine check (`:222-227`), and short-lived scoped tokens (`:265-362`) are already implemented and tenant-scoped.
3. **Configuration usage CI check & shallow `integrations` merge trap (`core/tests/tenant-config-usage.test.ts:482-519`, `core/src/config-engine/index.ts:3434-3511`):**
   - Adding non-reserved keys under `integrations.intakeChecks` in `core/schemas/tenant-config.schema.json` requires every leaf key to be accessed via `config.integrations.intakeChecks...` in runtime code outside `core/src/api/` and `core/src/config-engine/`, otherwise `tenant-config-usage.test.ts` fails CI (`:506` also rejects `x-reserved:S1-*`).
   - `loadAndValidateTenantConfig` (`core/src/config-engine/index.ts:3434-3511`) shallow-merges `integrations` except explicit sub-objects (`pmsSync`, `email`, `teams`), so `intakeChecks` and its four child objects require explicit nested deep-merging.

## Files and changes

1. **Core public API contracts (`core/src/api/index.ts`):**
   - Export additive interfaces & types (no breaking change to `CORE_API_VERSION = '2.0.0'`, Rule 7):
     - `IntakeCheckProviderMode = 'manual'`
     - `IntakeEvidenceArtifactRef`: `{ blobKey: string; sha256: string; contentType: string; sizeBytes: number; scanStatus: 'clean' | 'pending' | 'quarantined' }`
     - `IdentityVerificationProvider` (`recordManualCheck`, `getLatestCheckForSubject`)
     - `SanctionsPepScreeningProvider` (`recordManualScreening`, `getLatestScreeningForSubject`)
     - `ESignatureProvider` (`recordManualRequest`, `recordManualSignedDocument`, `getLatestEnvelope`)
     - `PaymentRequestProvider` (`recordManualPaymentRequest`, `recordManualReceipt`, `getPaymentRequest`, using `bigint` integer minor units strictly)
     - `TenantIntakeChecksIntegrationConfig`
   - Widen `DocumentStorageProvider.putObject`'s `category` union additively to `'templates' | 'documents' | 'evidence'`.
   - Accept [ADR 0038](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md) once approved in Phase 1 review.
2. **Per-tenant storage, migration `0024` & repository (`core/src/tenancy/`):**
   - `core/src/tenancy/blobStorage.ts`: support `category: 'evidence'` under `${ctx.blobContainerName}/evidence/...`, retaining full `assertBlobKeyBelongsToTenant`, SHA-256, and malware scan gates.
   - `core/src/tenancy/migrations/index.ts`: reversible expand migration **`0024_intake_check_records_expand`** (`CORE_REQUIRED_SCHEMA_VERSION = '0024'`, `downSql` drops `public.intake_check_records` cleanly per Rule 8) storing `id`, `tenant_id`, `check_kind`, `provider` (`'manual'`), `subject_type` (`'person' | 'organisation' | 'matter' | 'quote'`), `subject_id`, `outcome`, `amount_minor_units BIGINT NULL`, `reference_code TEXT NULL`, `metadata_json JSONB`, `evidence_refs_json JSONB`, `recorded_by_person_id`, `recorded_at TIMESTAMPTZ`, and `correlation_id`.
   - `core/src/tenancy/intakeCheckRepository.ts`: `TenantIntakeCheckRepository extends TenantScopedRepository` enforcing `SET LOCAL ROLE`, composite `(tenant_id, ...)` lookups, tampered cross-tenant ID rejection (`assertRowTenant`), and same-transaction `audit_entries` writes with zero PII / zero filenames (`ADR 0020`).
3. **Manual-only provider implementations & runtime config resolver (`core/src/integrations/intake-checks/`):**
   - `core/src/integrations/intake-checks/manualProviders.ts`: implement `ManualIdentityVerificationProvider`, `ManualSanctionsPepScreeningProvider`, `ManualESignatureProvider`, and `ManualPaymentRequestProvider` (no sandbox or simulated adapters).
     - Before writing, verify every attached `IntakeEvidenceArtifactRef`: call `assertBlobKeyBelongsToTenant` / `assertTenantOwnsBlobKey`, verify the object exists in `DocumentStorageProvider` for `ctx`, verify `scanStatus === 'clean'` (refusing missing, `'pending'`, `'quarantined'`, or cross-tenant blob keys fail-closed), and link the immutable record.
     - Stamp server-side `recordedByPersonId` (`ctx.actorId`) and `recordedAt` (`new Date().toISOString()`).
   - `core/src/integrations/intake-checks/adapters.ts` & `core/src/index.ts`: implement and export `resolveIntakeChecksIntegrationConfig(tenantConfig)` and `createTenantIntakeCheckProviders(...)` reading every leaf under `tenantConfig.integrations?.intakeChecks` (`idVerification.provider`, `sanctionsPep.provider`, `eSignature.provider`, `payments.provider`), throwing fail-closed on any unsupported provider string.
4. **Configuration schema & deep merge (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`):**
   - Add `integrations.intakeChecks` schema entry with `idVerification`, `sanctionsPep`, `eSignature`, `payments`, each `{ type: 'object', additionalProperties: false, properties: { provider: { type: 'string', enum: ['manual'], default: 'manual', description: '...' } } }` and top-level default `{ ... provider: 'manual' }` (Rule 7 backward compatible).
   - Update `TenantConfigurationSchema` Zod schema (`core/src/config-engine/index.ts`) and add nested deep-merging for `integrations.intakeChecks.*` inside `loadAndValidateTenantConfig`.

## Tests

*(Record fail-first evidence before implementation in `Stage1-WP1-report.md`.)*

1. **Contract & schema tests (`core/tests/intake-checks-s103.test.ts` & `core/tests/tenant-config-usage.test.ts`):**
   - Fail-first: each manual provider records outcome, server actor, server timestamp, `amountMinorUnits` (`BigInt` pence, rejecting non-integer/negative amounts), and verified `'evidence'` blob references; rejects unknown provider config values; rejects sandbox/simulated provider config strings fail-closed.
   - Config deep-merge test: partial overlay override in `environments/demo.json` preserves sibling keys from `base.json`.
   - `core/tests/tenant-config-usage.test.ts` passes with every new schema leaf read cleanly in `core/src/integrations/intake-checks/adapters.ts`.
   - `0024` `up -> down -> up` migration round-trip test (`core/tests/migrations-postgres.test.ts`).
2. **Two-tenant PostgreSQL isolation, tampered ID & forged claim tests (`core/tests/intake-checks-s103.test.ts`):**
   - Two real databases (`tenant-alpha` vs `tenant-bravo` over PgBouncer `SET LOCAL ROLE`):
     - Positive control: Tenant A writes and reads its own check records and evidence blobs cleanly.
     - Cross-tenant evidence forgery: passing Tenant B's valid `evidence` `blobKey` (or a non-existent/quarantined `blobKey`) to Tenant A's manual provider fails closed (`STORAGE_TENANT_MISMATCH` / `EVIDENCE_NOT_FOUND` / `EVIDENCE_QUARANTINED`) and writes zero DB rows.
     - Tampered record/subject ID & forged `TenantContext` claim (`TENANCY_FORGERY_DETECTED`) fail closed and leave Tenant B untouched.

## Help and documentation (rule 11)

- `src/docs/articles/tenant-settings.ts`: document `integrations.intakeChecks` configuration options (`manual` in Stage 1; future automated providers deferred).
- `src/docs/articles/deployment-and-security.ts`: note `'evidence'` blob container isolation and zero-PII audit/logging guarantees (`ADR 0038`, `ADR 0020`).
- `docs/roadmap/feature-list.md`: update row `34` (`What exists`), `P7`, `P8`, `E8`.
- `docs/release-notes.md`: add `S1-03` entry under `Unreleased`.

## Acceptance criteria

- `@platform/core-api` exports the four intake check interfaces and `'evidence'` `putObject` category without breaking `@platform/core-api` v2 compatibility.
- Only `'manual'` providers exist (no sandbox/simulated adapters), no UI changes are introduced yet, and `tenant-config-usage.test.ts`, migration round-trip, contract, and two-tenant PostgreSQL + tampered-evidence tests all pass.

## Manual blockers

- Live vendor integrations remain intentionally deferred by owner decision; real-firm hosting of uploaded evidence blobs awaits `azure-blob` (`ADR 0008` Stage 0 exception, pre-hosted client list).

## Rollback

- Expand migration `0024` drops cleanly via `downSql`; `integrations.intakeChecks` config defaults safely; revert `s1-03-intake-check-interfaces` and run `0024` `downSql`.

## Pull request description must state

- **Change class:** Core extension/integration API contracts, manual adapters, configuration schema + deep-merge, and reversible per-tenant migration `0024` ([ADR 0038](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md)).
- **Both hosting models:** Identical across Model A (`single_tenant`) and Model B (`multi_tenant`); evidence blobs and PostgreSQL rows scope strictly to verified `TenantContext`.
- **Migration and rollback:** Additive expand migration `0024` (`CORE_REQUIRED_SCHEMA_VERSION = '0024'`) reversible via `downSql` + `git revert`.
