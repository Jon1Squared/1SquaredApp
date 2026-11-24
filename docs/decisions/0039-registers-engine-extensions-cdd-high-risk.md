# ADR 0039: Registers Engine Extensions for Client-Subject CDD and High-Risk Opening Approval

- **Date:** 2026-11-24
- **Status:** Proposed
- **Roadmap:** Stage 1 decisions `S1-D5`, `S1-D7`, `S1-D10`; Work Package 2 slices `S1-04` and `S1-05` ([stage-1-plan.md](../roadmap/stage-1-plan.md)); backlog item `4`
- **Builds on:** [ADR 0014](./0014-staff-matter-access-by-permission.md) (staff-matter & restricted access), [ADR 0025](./0025-permission-enforcement-pattern.md) (permission enforcement), [ADR 0028](./0028-tenant-database-and-repositories.md) (tenant databases & repositories), [ADR 0030](./0030-tenant-aware-scheduler.md) (tenant-aware scheduler), [ADR 0032](./0032-registers-engine.md) (registers engine), [ADR 0038](./0038-intake-check-interfaces-and-manual-adapters.md) (intake check interfaces & `'evidence'` storage category)

## Context

[ADR 0032](./0032-registers-engine.md) established `core/src/domain/registers/` and `core/src/tenancy/registerRepository.ts` (`TenantRegisterRepository`) as the single configuration-driven engine for registers, approvals, and scheduled reminders (`sign_off`, `undertaking`, `complaint`, `breach`). Stage 1 Work Package 2 introduces two compliance workflows on top of that engine — **Client Due Diligence (`cdd` in `S1-04`, decision `S1-D5`)** and **High-Risk Matter Opening Approval (`high_risk_opening` in `S1-05`, decision `S1-D7`)** — which require generic extensions that do not exist in the engine today:

1. **Subject scoping beyond matters (`person_id` / `organisation_id`):**
   - `public.register_records` already declares nullable `person_id` and `organisation_id` columns (`core/src/tenancy/migrations/index.ts:2048-2051`), yet `0017_registers_engine_expand` only indexes `matter_id`, `due_at`, and `review_at`, and `TenantRegisterRepository.listVisibleRegisterRecords` (`core/src/tenancy/registerRepository.ts:516-572`) and `listRegistersWorkspaceDataRecord` (`src/server/services.ts:27066-27190`) filter only by `matterId` and `enquiryId`. CDD lives on the **client** (`Person` or `Organisation`), reused across their matters while valid.
   - In addition, `REGISTER_RECORD_VISIBLE_SQL_PREDICATE` (`core/src/tenancy/registerRepository.ts:39-52`) diverges from `buildMatterHiddenFromViewerSql` (`core/src/tenancy/intakeQuoteRepository.ts:812-842`): it lacks the empty-allow-list participant fallback and `restrictedAccessUserIdsFallback`, and `listRegistersWorkspaceDataRecord` (`src/server/services.ts:27111-27117`) omits `hasRestrictedMatterAccess` when calling `listVisibleRegisterRecords`.
2. **Checklist and evidence fields:**
   - `RegisterFieldType` (`core/src/api/registers.types.ts:29-37`) supports scalar fields (`'text' | 'textarea' | 'number' | 'currency_gbp' | 'boolean' | 'date' | 'select' | 'person'`), but has no structured checklist item array or verified evidence-attachment field linked to the S1-03 `'evidence'` blob category and `public.intake_check_records`.
   - Furthermore, `/api/documents/download` (`src/app/api/documents/download/route.ts:43-86`) requires a `public.documents` row (`verified.documentId`) and only sets PDF/DOCX MIME types, so raw uploaded CDD evidence blobs (`tenant-<tenantId>-<env>/evidence/<objectId>/<fileName>`) cannot be downloaded through it.
3. **Two-stage high-risk approval (`S1-D7`):**
   - `CORE_REGISTER_TYPES` (`core/src/domain/registers/index.ts:67-437`) supports only type-wide `approvalRules.allowedApproverRoles`, enforces no distinction between sequential approvers (checking only `ownerId` / `createdById` and optional `assignedApproverId`), and explicitly allows `'admin'` to bypass `allowedApproverRoles` (`core/src/domain/registers/index.ts:1010-1023`, line `:1013`).
   - Owner decisions for Stage 1 require a High risk matter to be approved **first** by a Partner (`'partner'`, `'managing_partner'`), and **second** by a **different** person holding `'risk_compliance'`, with **zero admin bypass** unless that individual legitimately holds the required role and differs from the previous approver.

Because modifying `RegisterFieldType`, `RegisterTransitionDefinition`, `RegisterApprovalRules`, and core transition invariants changes public contracts in `@platform/core-api` (`core/src/api/registers.types.ts`) and core engine semantics, this ADR is required before `S1-04` and `S1-05` implementation begins (`CLAUDE.md`).

## Decision

### 1. Client-subject registers (`subjectScope`) and client visibility indexes
- **Additive `subjectScope` on `RegisterTypeDefinition` (`core/src/api/registers.types.ts`):**
  - Add optional `subjectScope?: 'matter' | 'client' | 'any'` (default `'any'`, retaining `requireMatterLink?: boolean` unchanged).
  - Register types with `subjectScope: 'client'` (such as core `'cdd'`) enforce inside `validateRegisterCreateInput` and `TenantRegisterRepository.createRegisterRecord`:
    - exactly one of `personId` or `organisationId` must be set (and not both, unless explicitly configured otherwise), while `matterId` stays `null` (client CDD records belong to the client, not a single matter);
    - `TenantPartyRepository` (`getPersonById` / `getOrganisationById`) verifies inside `withTenantTransaction` that the target subject exists in the caller's tenant and is not merged (`mergedIntoId == null`), failing closed with `NOT_FOUND` on non-existent or cross-tenant IDs;
    - employee records (`person.isEmployee === true`) remain valid CDD subjects for staff matters, but viewing/downloading their `'evidence'` files or detailed `'checklist'` notes requires `'risk:view'` or `'matter:restricted:access'` so staff personal ID documents are not exposed to all fee earners. (Non-sensitive CDD status summaries — `'recorded' | 'pending' | 'expired' | 'not_started'` and `"Recorded manually by <person> on <date>"` — remain visible to permitted staff opening matters for that client.)
- **PostgreSQL indexes and repository filters (expand migration `0025`):**
  - Add partial indexes on `public.register_records`:
    - `idx_register_records_tenant_person ON public.register_records (tenant_id, person_id, register_type_key, status) WHERE person_id IS NOT NULL`
    - `idx_register_records_tenant_organisation ON public.register_records (tenant_id, organisation_id, register_type_key, status) WHERE organisation_id IS NOT NULL`
  - Extend `ListVisibleRegisterRecordsOptions` (`core/src/tenancy/registerRepository.ts`) with optional `personId`, `personIds`, `organisationId`, and `organisationIds` filters.
  - Extend `updateRegisterRecordDetails` in `src/server/services.ts` only for explicit admin/staff correction when `subjectScope` permits, while keeping existing `executeMergeInTransaction` (`core/src/tenancy/partyRepository.ts:3713-3757`) repointing `person_id`, `organisation_id`, and `field_values_json` links atomically.
- **SQL matter-visibility convergence & barrier readiness (`S1-09` composition):**
  - Replace the duplicate SQL check in `REGISTER_RECORD_VISIBLE_SQL_PREDICATE` (`core/src/tenancy/registerRepository.ts:39-52`) with the shared `buildMatterHiddenFromViewerSql` helper (`core/src/tenancy/intakeQuoteRepository.ts:812-842`), and pass `hasRestrictedMatterAccess` in both `listRegistersWorkspaceDataRecord` (`src/server/services.ts:27111-27117`) and `listTransitionsForRecord` inside `getRegisterRecordDetailRecord` (`src/server/services.ts:27249-27251`).
  - Client-subject records (`matter_id IS NULL`) initially pass matter visibility filters and apply employee-evidence scoping; once `S1-09` adds core information barrier tables (`information_barriers`, `information_barrier_targets`, `information_barrier_principals`), `buildClientRegisterVisibleSql` will compose cleanly via `NOT EXISTS (...)` on `person_id` / `organisation_id` / active barrier principals without schema rework.

### 2. Checklist and evidence field types & `'evidence'` artifact indexing
- **Additive `RegisterFieldType` members (`core/src/api/registers.types.ts`):**
  - Widen `RegisterFieldType` to include `'checklist' | 'evidence'`.
  - **`'checklist'` field value contract:** stores a validated JSON array of checklist item entries (`RegisterChecklistItemValue[]`):
    - `itemKey: string` (matches configured template key from client type × risk tier, plus ad-hoc additional items if allowed);
    - `label: string`;
    - `required: boolean`;
    - `status: 'pending' | 'recorded' | 'not_applicable' | 'failed'`;
    - `recordedById: string | null`, `recordedByName?: string`, `recordedAt: string | null` (server-stamped ISO timestamp);
    - `note?: string` (trimmed free text; mandatory when `status === 'not_applicable'` or `'failed'`);
    - `evidenceRefs: IntakeEvidenceArtifactRef[]`;
    - `intakeCheckRecordId?: string | null` (links to `public.intake_check_records.id` `ICHK-*` when backed by S1-03 `IdentityVerificationProvider` or `SanctionsPepScreeningProvider`).
  - **`'evidence'` field value contract:** stores `IntakeEvidenceArtifactRef[]` (`blobKey`, `fileName`, `contentType`, `sizeBytes`, `sha256`, `scanStatus`, `uploadedByActorId`, `uploadedAt`).
- **Uploaded `'evidence'` artifact lifecycle (wiring S1-03 storage end to end):**
  - Introduce `public.evidence_artifacts` in expand migration `0025` (`(tenant_id, id)` PK `EVD-000001`, `blob_key`, `subject_type`, `subject_id`, `file_name`, `content_type`, `byte_size`, `sha256`, `scan_status`, `uploaded_by_person_id`, `uploaded_at`) with a partial index on `(tenant_id, subject_type, subject_id)`.
  - Uploads accept size-capped files (configurable up to a hard platform limit, e.g. `10 MiB`, allowed MIME/extensions: `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.txt`), run `scanBytesForMalwareAndMacros` + `putObject` under `category: 'evidence'` (`tenant-<tenantId>-<env>/evidence/<objectId>/<safeName>`), write the `public.evidence_artifacts` metadata row inside `withTenantTransaction`, and refuse `'infected'` files before storage (`STORAGE_MALWARE_DETECTED`).
  - Attaching an artifact to a register record re-verifies inside the transaction via S1-03 `verifyEvidenceArtifacts` (`core/src/integrations/intake-checks/manualProviders.ts:81-133`): tenant prefix ownership (`assertBlobKeyBelongsToTenant`), clean malware status, live blob presence, and SHA-256 byte integrity.
  - Downloads use a dedicated `GET /api/evidence/download` route (`guardedRoute`, policy `{ kind: 'authenticated', reason: '...' }` — verified via `verifyScopedDownloadToken`, database lookup in `public.evidence_artifacts`, `canAccessEvidenceSubject` checking RBAC + employee-client + restricted-matter access, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`). `/api/documents/download` (`src/app/api/documents/download/route.ts`) stays untouched for `public.documents` generated templates/files.
  - Stage 0 Decision D4 and Risk R3 remain unchanged: `local-fs` is restricted to single-replica non-live demos and fails closed in `'live'` (`STORAGE_LIVE_LOCAL_FS_FORBIDDEN`) until `azure-blob` is implemented before the first hosted client.

### 3. Per-transition `allowedRoles`
- Add optional `allowedRoles?: readonly HomeRoleKey[]` to `RegisterTransitionDefinition` (`core/src/api/registers.types.ts`, mirrored in `core/schemas/registers.config.schema.json` and Zod `core/src/config-engine/index.ts`).
- Precedence inside `validateRegisterTransitionExecution` (`core/src/domain/registers/index.ts`):
  1. When `transition.allowedRoles` is defined and non-empty, the actor's resolved authoritative `HomeRoleKey` set (`actorRoles`) must intersect `transition.allowedRoles`.
  2. When omitted or empty on a transition governed by `approvalRules`, existing `registerType.approvalRules.allowedApproverRoles` applies unchanged.
  3. Values must be valid built-in or tenant-configured role keys (never display labels).

### 4. Distinct-from-previous-approver rule (`mustDifferFromPreviousApprover`)
- Add optional fields to `RegisterTransitionDefinition`:
  - `mustDifferFromPreviousApprover?: boolean` (default `false`);
  - `distinctFromTransitionKeys?: readonly string[]` (optional explicit transition keys whose prior actors in the active approval cycle must differ from the current actor; when omitted and `mustDifferFromPreviousApprover === true`, compares against all prior approval-category / `forbidSelfAction` transitions in the active cycle).
- **Active approval cycle boundary:** All transitions on `register_record_id` occurring **strictly after** the most recent `'reopen'`, `'resubmit'`, `'request_changes'`, or reset-to-initial transition (or since record creation if none). Thus, if a High-risk matter is returned to drafting (`'return'` / `'reject'` then resubmitted), a new approval cycle begins cleanly; within the same cycle, the Risk & Compliance approver cannot be the Partner who executed `partner_approve` — even if one person holds both `partner` and `risk_compliance` roles!
- **Atomic in-transaction enforcement:** `TenantRegisterRepository.lockAndExecuteTransition` acquires `SELECT ... FOR UPDATE` on `public.register_records`, reads the ordered rows from `public.register_transitions WHERE tenant_id = $1 AND register_record_id = $2 ORDER BY transitioned_at ASC, id ASC`, and passes prior cycle actor IDs into `validateRegisterTransitionExecution`. Matching any disallowed prior approver fails closed with stable error code **`REGISTER_DISTINCT_APPROVER_REQUIRED`**.
- Existing `forbidSelfAction` (`actorId === record.ownerId || actorId === record.createdById` → `REGISTER_SELF_APPROVAL_FORBIDDEN`) continues to apply independently so neither the creator/owner nor the prior approver can self-approve or double-hat both steps.

### 5. Explicit `allowAdminBypass` control (eliminating implicit admin bypass on `high_risk_opening`)
- Add optional `allowAdminBypass?: boolean` to `RegisterApprovalRules` (`core/src/api/registers.types.ts`, default `true` when omitted).
- Inside `validateRegisterTransitionExecution` (`core/src/domain/registers/index.ts:1010-1023`):
  - Replace hardcoded `!actorRoles.includes('admin')` with `!(registerType.approvalRules.allowAdminBypass !== false && actorRoles.includes('admin'))`.
  - For existing core types (`sign_off`, `breach`), `allowAdminBypass` remains omitted/`true`, preserving S0-24 broken-glass semantics verbatim.
  - For **`high_risk_opening`**, core sets **`allowAdminBypass: false`** (and **`mergeRegistersConfigurations`** marks `allowAdminBypass: false`, `allowedRoles`, and `mustDifferFromPreviousApprover` on core transitions of `high_risk_opening` as **core-locked invariants** that tenant `typeOverrides` cannot weaken). An administrator who does not genuinely hold the transition's `allowedRoles` is refused with `REGISTER_APPROVER_ROLE_FORBIDDEN` (`FORBIDDEN`), and even a dual-role admin cannot bypass `forbidSelfAction` or `mustDifferFromPreviousApprover`.

### 6. Backward compatibility (Rule 7) and `@platform/core-api` versioning
- Every addition (`subjectScope`, `'checklist'`, `'evidence'`, `allowedRoles`, `mustDifferFromPreviousApprover`, `distinctFromTransitionKeys`, `allowAdminBypass`, `RegisterChecklistItemValue`, `EvidenceArtifactRecord`) is strictly **additive and optional** on existing structures.
- Existing `sign_off`, `undertaking`, `complaint`, `breach`, and any tenant-defined register configurations stored in `client-<slug>/config/` or `public.tenant_module_configs['registers']` validate and execute identically with zero breaking schema or runtime changes.
- Raise `CORE_API_VERSION` from `'2.1.0'` to **`'2.2.0'`** (additive minor bump within `2.x`); existing extension manifests declaring `^2.0.0` remain valid without modification.

### 7. Behaviour across both hosting models (Rule 6)
- **Model A (`single_tenant`):** A single dedicated database and single tenant container store `register_records`, `register_transitions`, `evidence_artifacts`, and `evidence/` blobs; all queries and checks still require `VerifiedOidcTokenClaims`-derived `TenantContext` (`SET LOCAL ROLE`), and `local-fs` remains demo-only until `azure-blob` lands before live client onboarding.
- **Model B (`multi_tenant`):** Each tenant has its own isolated PostgreSQL database (`pg_tenant_<slug>_<env>`) and its own container (`tenant-<tenantId>-<env>/evidence/...`). Every register query, transition lock, download token signature (`tokenSigningKey:tenantId`), audit entry, and reminder job includes and asserts `tenantId` (`assertRowTenant`, `assertBlobKeyBelongsToTenant`), with zero cross-tenant leakage verified by two-tenant tests (`tenant-alpha` vs `tenant-bravo`).

## Alternatives Considered

1. **Create bespoke PostgreSQL tables (`client_cdd_records`, `high_risk_approvals`) outside the registers engine:** Rejected by decisions `S1-D5` and `S1-D7` and ADR 0032. Duplicating state machines, `row_version` locking, audit entries, reminder states, and extension hooks creates parallel maintenance and isolation risk.
2. **Allow `'admin'` bypass everywhere via existing `core/src/domain/registers/index.ts:1013` logic:** Rejected explicitly by owner decision (24 November 2026) and `S1-D7`; high-risk regulatory sign-off requires independent partner + Risk & Compliance approval that `admin` cannot override.
3. **Remove `admin` bypass retroactively from `sign_off` and `breach`:** Rejected under Rule 7 (backward compatibility) and existing S0-24 contract tests; gating opt-out via `allowAdminBypass: false` preserves S0-24 guarantees while locking `high_risk_opening`.
4. **Serve CDD evidence through `/api/documents/download` by inserting fake `public.documents` rows:** Rejected because generated documents (`documents`, templates, SharePoint links) have distinct schemas and access rules (`canActorAccessGeneratedDocument`) from manual verification evidence stored in `evidence/` blobs and `intake_check_records`.

## Consequences

- `S1-04` (`cdd` register type) and `S1-05` (`high_risk_opening` register type) reuse the hardened `TenantRegisterRepository`, `register_transitions` history, `row_version` optimistic concurrency, extension hooks, and `register-reminders` scheduler without building a second workflow engine or Bicep job.
- Requires reversible expand migration `0025_registers_cdd_and_org_type_keys_expand` (`CORE_REQUIRED_SCHEMA_VERSION = '0025'`), `GET /api/evidence/download`, and two-tenant PostgreSQL + tampered-ID tests covering client-subject registers, evidence checksum/tenant checks, sequential distinct approvers, and refusal of `admin` bypass on `high_risk_opening`.
- Existing Stage 1 Risk `R3` remains unchanged: **no live tenant may store real CDD evidence until `azure-blob` replaces `local-fs`.**
