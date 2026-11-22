# ADR 0038: Small Core Intake Check Interfaces with Manual Evidence-Backed Implementations

- **Date:** 2026-11-22
- **Status:** Proposed
- **Roadmap:** Stage 1 decision S1-D1, slice S1-03 ([stage-1-plan.md](../roadmap/stage-1-plan.md)); backlog item `34` (and foundation for items `4`, `5`, `6`)
- **Builds on:** [ADR 0008](./0008-document-storage-provider-abstraction.md) (document storage), [ADR 0020](./0020-document-references-and-zero-content-storage.md) (document references & zero-PII telemetry), [ADR 0027](./0027-email-sender-interface.md) (per-tenant adapter configuration), [ADR 0028](./0028-tenant-database-and-repositories.md) (tenant databases & repositories), [ADR 0037](./0037-extension-api-v2-least-privilege-config-context.md) (core API v2.0.0)

## Context

Stage 1 introduces client due diligence (item `4`), engagement letter execution (item `5`), and money on account (item `6`) workflows. Following the product owner's decision (22 November 2026), Stage 1 ships **zero live third-party integrations**: identity verification providers, sanctions/PEP screening APIs, e-signature providers, online payment links, and live Companies House lookups are all deferred to named future backlog items.

Yet building Stage 1 directly against ad-hoc UI form flags would couple workflows in WP2 and WP3 (`S1-04`, `S1-06`, `S1-08`) to manual UI state, requiring rework when live providers are introduced later. Conversely, adding unconfigured "sandbox" or simulated provider stubs would risk misrepresenting manual staff records as automated third-party checks (plan risk R1 and Architecture Standard §10).

We therefore need narrow core integration contracts in `@platform/core-api`, backed in Stage 1 solely by **manual** evidence-backed implementations persisted per tenant in PostgreSQL and tenant blob storage.

## Decision

### 1. Narrow provider interfaces in `@platform/core-api` (`core/src/api/index.ts`)

Add four additive provider interfaces and shared reference types to `@platform/core-api` (`CORE_API_VERSION` remains compatible within `2.x` per Rule 7):

1. `IdentityVerificationProvider` (`kind: 'identity_verification'`): records manual identity verification outcomes (`'verified' | 'failed' | 'pending' | 'expired'`), verification method, reference, expiry date, reviewer `actorId`, and evidence artifact references.
2. `SanctionsPepScreeningProvider` (`kind: 'sanctions_pep'`): records manual sanctions/PEP screening checks (`'clear' | 'match_flagged' | 'pending'`), screening scope, reviewer `actorId`, server timestamp, and evidence artifact references. Display helpers always label manual records explicitly (`"Recorded manually by ... on ..."`), never `"screened by provider"`.
3. `ESignatureProvider` (`kind: 'e_signature'`): records manual countersigned engagement letter dispatch/upload outcomes (`'requested_manual' | 'signed_uploaded' | 'declined'`), signed document/evidence reference, actor, and timestamp.
4. `PaymentRequestProvider` (`kind: 'payment_request'`): records manual client-account payment requests and manual receipt confirmations (`amountMinorUnits` as `bigint` pence, currency `'GBP'`, client-account reference, actor, timestamp, and optional evidence reference). Never computes with floating-point pounds.

### 2. Shared `IntakeEvidenceArtifactRef` and tenant-scoped manual persistence

1. **Evidence storage (`DocumentStorageProvider`):** Add `'evidence'` additively to `DocumentStorageProvider.putObject`'s `category` union (`core/src/api/index.ts`, `core/src/tenancy/blobStorage.ts`) so uploaded evidence artifacts live in the active tenant's own container under `${ctx.blobContainerName}/evidence/...`, hashed (SHA-256) and malware-scanned identically to documents (`ADR 0008`), and download-scoped to `(tenantId, actorId, documentId)`. Note per Stage 0 exit decision D4 ([ADR 0008](./0008-document-storage-provider-abstraction.md)), non-live demos use `local-fs`, whereas `live` environments remain fail-closed until `azure-blob` is implemented before the first hosted client.
2. **Per-tenant PostgreSQL persistence (`public.intake_check_records`):** Add reversible expand migration `0024_intake_check_records_expand` (`downSql` drops the table/indexes cleanly per Rule 8) and `TenantIntakeCheckRepository extends TenantScopedRepository` (`SET LOCAL ROLE` over `NOINHERIT` `runtime_login`). Every manual provider validates:
   - verified `TenantContext` (`TENANCY_FORGERY_DETECTED` / `UNAUTHENTICATED`);
   - non-empty actor ID and valid subject scope (`matter` / `person` / `organisation`);
   - every attached `IntakeEvidenceArtifactRef` belongs to the caller's tenant container (`assertBlobKeyBelongsToTenant` / `assertTenantOwnsBlobKey`), passes malware scan (`scanStatus === 'clean'`), and rejects tampered or cross-tenant blob keys or document IDs before writing inside `withTenantTransaction`;
   - writes an append-only `audit_entries` row in the **same transaction** with check kind, check ID, actor ID, outcome, `correlationId`, and `tenantId` — zero PII, zero client names, and zero original filenames (`ADR 0020`).
3. **No sandbox or simulated adapters:** Stage 1 ships only `'manual'` implementations. Future live provider adapters (e.g. third-party IDV, sanctions APIs, e-signature webhooks, payment links) will sit behind the same interfaces in `core/src/integrations/intake-checks/`, reading secrets strictly from Key Vault (`assertTenantOwnsKeyVaultSecretRef`).

### 3. Additive tenant configuration (`integrations.intakeChecks`)

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

### 4. Telemetry and logs

Structured log and telemetry events emit only `tenantId`, `correlationId`, `checkKind`, `provider: 'manual'`, `outcome`, and opaque record IDs — never personal names, addresses, file names, or raw check notes (`ADR 0020`, Standard §§8, 10, 13).

## Alternatives Considered

1. **Add simulated/sandbox adapters for third-party APIs in Stage 1:** Rejected by product owner decision (22 November 2026) and Risk R1; simulated responses add dead code, complicate audit provenance, and risk demos/users mistaking manual checks for live third-party screening.
2. **Store check outcomes only on ad-hoc CDD/engagement/matter tables with no core interfaces:** Rejected because Stage 2+ and future live integrations would have to refactor WP2/WP3 application services rather than adding a new provider behind `integrations.intakeChecks.*.provider`.
3. **Store raw evidence file bytes in PostgreSQL:** Rejected per `ADR 0008` and Standard §8.4 (all binary objects belong in per-tenant container storage with SHA-256 + malware scan + short-lived scoped tokens).

## Consequences

- WP2 (`S1-04`, `S1-05`) and WP3 (`S1-06`, `S1-08`) consume stable `@platform/core-api` interfaces without waiting for vendor procurement, API credentials, or webhooks.
- Adding any real third-party provider after Stage 1 is an additive enum/adapter change under `integrations.intakeChecks`, requiring zero changes to workflow orchestration or core entity tables.
- Requires reversible expand migration `0024_intake_check_records_expand` and two-tenant PostgreSQL isolation + tampered-evidence tests in `S1-03`.
