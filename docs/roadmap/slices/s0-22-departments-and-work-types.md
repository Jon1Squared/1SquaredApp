# S0-22 — Departments and Work Types (Schema-Driven Tasks, Risk Scoring and Retention Dates)

| Field | Value |
|---|---|
| Slice | `S0-22` |
| Stage / Work package | Stage 0C — Make it shared (`WP5a`) |
| Status | Planned (ready to build on `s0-22-departments-and-work-types`) |
| Branch | `s0-22-departments-and-work-types` (target `develop`) |
| Depends on | `S0-17c`, `S0-08` (both already merged on `develop`) |
| Size | `L` |
| Backlog IDs | `29` (also advances `4`, `9`, `21`, `23` and addresses `P13`; cross-cutting `P10`, `P11`) |
| Decision record(s) | None required (configuration schema + domain wiring extending `S0-08`, `S0-17c`, `S0-20`) |
| Spec / standards references | Architecture Standard sections 4, 5, 6, 7, 10, 12; [RBAC Reference](../rbac-reference.md) |

---

## 1. Purpose

Close Stage 0 backlog item `29` (*Departments and work types*) to the strict **Completed** bar by making tenant-configured work types (backed by JSON schema validation and Admin UI configuration, with zero client-specific code in core) drive three live platform behaviours:

1. **(a) Automatic task templates:** selected by work type when a matter opens.
2. **(b) Work-type risk questionnaire:** work-type-specific risk sections/questions building on `S0-08`'s server-side risk scoring (`buildMatterRiskAssessmentSnapshot` / `validateMatterRiskAssessmentInput`).
3. **(c) Retention periods on matter closure:** work-type retention rules setting `public.matters.destruction_date` when a matter transitions to closed. **(Explicit scope boundary: `S0-22` computes and stores `destruction_date` only; no automatic destruction or deletion background job is built in `S0-22`.)**

It also reconciles `DEFAULT_ORG_DEPARTMENTS` / practice-area work-type configuration consistency across Admin, Intake, Quotes and Matters (`4`, `9`, `21`, `23` and `P13`).

---

## 2. Classification & Architectural Layer

- **Classification:** Configuration schema (`core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`) + core/host domain wiring + tenant-scoped Admin UI + seeded config in `client-not-a-law-firm/config/base.json`.
- **Single-tenant and multi-tenant operation:** Identical build. Work-type rules come from schema-validated tenant configuration and `TenantCatalogueRepository` (`'work_type_profiles'`) in the tenant's PostgreSQL database, with backwards-compatible core defaults when optional per-work-type overrides are omitted.

---

## 3. Existing Code & Schema

- **Database schema version on `develop`:** `0015` (`CORE_REQUIRED_SCHEMA_VERSION = '0015'` in `core/src/tenancy/tenantScopedRepository.ts:26`). `public.matters.destruction_date` already exists in migration `0001` (`core/src/tenancy/migrations/index.ts:959`) and is persisted by `TenantMatterRepository` (`core/src/tenancy/matterRepository.ts:175, 389, 914, 965, 1133`).
- **Catalogue & profiles:** `TenantCatalogueRepository` (`core/src/tenancy/catalogueRepository.ts:45, 313` — `'work_type_profiles'`), `WORK_TYPE_PROFILES` & helpers (`src/domain/matterParties.ts:27, 637, 728, 817`), `updateWorkTypeProfiles` (`src/server/services.ts:13956`), `updateWorkTypeProfilesAction` (`src/app/actions.ts:1065`).
- **Org structure & departments:** `DEFAULT_ORG_DEPARTMENTS` and `resolveOrgDepartment` (`src/domain/orgStructure.ts:22-100, 496`), `QuoteFormClient` practice-area/work-type filtering (`src/components/QuoteFormClient.tsx:175-192, 1349`).
- **Risk assessment (S0-08):** `MATTER_RISK_SECTIONS`, `buildMatterRiskAssessmentSnapshot` and `validateMatterRiskAssessmentInput` (`src/domain/matterOpeningRecord.ts:46, 421, 567`), invoked during `saveMatterRecord` (`src/server/services.ts:4576, 5724`).
- **Auto tasks:** `AutoTaskTrigger` (`src/domain/types.ts:1051`), `createAutoTasksForTrigger` (`src/server/services.ts:8633, 9227`), `complete_matter_opening` trigger handling (`:10980`).

---

## 4. Scope & Exact Changes

### 4.1 Schema & configuration model for the three work-type drivers (`core/schemas/tenant-config.schema.json` + `core/src/config-engine/index.ts`)

Add additive, backwards-compatible configuration schema entries (with `type`, `default`, `description` and validation) so work-type behaviour is driven by tenant configuration rather than hardcoded client branches:

1. **Auto-task templates by work type:** map work-type keys (with optional practice-area / firm fallback) to template items instantiated on matter opening / `complete_matter_opening` (`title`, `dueWorkingDaysOffset`, `priorityId`, `ownerRoleKey`). Invalid triggers, negative offsets or unknown role keys fail schema and service validation.
2. **Risk questionnaire variations by work type (`S0-08` extension):** per-work-type additional/overridden risk questions or section weights building cleanly on `MATTER_RISK_SECTIONS`, validated by schema. Client UI renders the work type's active questions, while `buildMatterRiskAssessmentSnapshot` and `validateMatterRiskAssessmentInput` enforce answers and compute final scores **strictly server-side** during `saveMatterRecord` (ignoring any tampered client-submitted total score or risk rating).
3. **Retention periods on matter closure:** per-work-type `retentionYears` (integer `>= 1`, bounded) plus baseline (`closed_on` or statutory rule metadata) stored in validated configuration. When a matter transitions to `closed` (`closed_on` set), server logic computes and writes `public.matters.destruction_date` (respecting leap-year calendar arithmetic and optional documented override rules where permitted) in the same Postgres transaction and writes an audit entry.
   - **Explicit non-goal:** **No automatic deletion, purge or destruction background job is added in `S0-22`.** `destruction_date` is metadata ready for Stage 3 retention/archiving workflows.

### 4.2 Work-type & department synchronisation (`4`, `9`, `21`, `23`, `P13`)

- Reconcile `DEFAULT_ORG_DEPARTMENTS` (`src/domain/orgStructure.ts:22-100`), `choice_values` (`practice_area` / `work_type`) and `work_type_profiles` so configuring departments, practice areas and work types in Admin drives Intake, Quotes (`QuoteFormClient.tsx`), Matters, Risk Assessment, Auto-Tasks and Retention consistently without client-specific code paths in core.
- Document and verify `P13` behaviour (adding/updating/deactivating a work type in Admin reflects consistently across practice areas, quotes and matters).

### 4.3 Admin UI & validation

- Extend Administration (`AdminClient.tsx` / `WorkTypesSettingsSection` / Org Structure settings) so authorised admins with MFA (`mfaVerified === true`) can view and edit work-type task templates, work-type risk questionnaire additions and work-type retention years, backed by `guardedAction` server actions in `src/app/actions.ts` and `src/server/actionPermissions.ts`.
- Keep invented defaults in `client-not-a-law-firm/config/base.json` cleanly aligned and valid under `node scripts/verify-invented-fixtures.mjs`.

---

## 5. Migrations & Backwards Compatibility

- **Migration required:** `None`. `CORE_REQUIRED_SCHEMA_VERSION` stays `'0015'` (`public.matters.destruction_date` and `public.tenant_module_configs` already exist).
- Existing work types or tenants omitting the new schema blocks fall back safely to backwards-compatible firm defaults (standard `MATTER_RISK_SECTIONS`, default matter-opening auto-tasks, default/unset retention when unconfigured).

---

## 6. Security, Tenancy & Permissions

- Admin config writes (`updateWorkTypeProfilesAction` and any new work-type config actions) require `guardedAction`, explicit permissions in `src/server/actionPermissions.ts` (`MAX_KNOWN_GAPS = 0`) and `mfaVerified === true`.
- Risk assessment scores (`S0-08`) are computed exclusively server-side; client-supplied score totals are ignored.
- Matter opening auto-tasks and closure `destruction_date` calculation check `canAccessMatter` and run inside the tenant's PostgreSQL transaction, writing structured audit entries (`tenantId` + `correlationId`, no PII in logs).

---

## 7. Tests Required

1. **Schema & config validation tests:** Valid work-type configs pass; negative `retentionYears`, invalid task offsets, malformed risk questions or unknown role keys are rejected by `core/src/config-engine/index.ts` and `core/tests/tenant-config-usage.test.ts`.
2. **Driver (a) Auto-tasks by work type tests:** Opening two matters with distinct work types instantiates each work type's configured task templates accurately (and falls back cleanly when unconfigured).
3. **Driver (b) Work-type risk questionnaire & S0-08 server scoring tests:** Varying risk questions appear per work type; submitting tampered scores/levels from client payload is overridden by server-side `buildMatterRiskAssessmentSnapshot`.
4. **Driver (c) Retention period & `destruction_date` tests:** Closing a matter computes and stores `public.matters.destruction_date` from `closed_on` + work-type `retentionYears` (including 29 Feb leap-year handling); explicitly test that no matter records are deleted and reopening clears or recalculates per rule with audit entry.
5. **Admin RBAC/MFA & P13 sync tests:** Non-admin or un-MFA'd callers are rejected (`403`/error); configuring a work type in Admin updates available choices in Quote/Matter creation cleanly.
6. **Two-tenant isolation tests (`P8`):** Tenant A's work-type task templates, risk questions and retention periods never leak to or affect Tenant B's matters, quotes or `destruction_date` calculations; forged `tenantId` or tampered `workTypeId` fails closed.

---

## 8. Documentation, Help & Backlog Updates

- **Help & documentation (`Rule 11`, `P11`):**
  - Update [matter-opening-and-risk.ts](file:///c:/1Squared/App/src/docs/articles/matter-opening-and-risk.ts) (work-type risk questions + server-side scoring + auto-tasks on opening).
  - Update [data-administration-and-retention.ts](file:///c:/1Squared/App/src/docs/articles/data-administration-and-retention.ts) (work-type retention periods setting `destruction_date` on closure; clarify no automatic purge job exists yet).
  - Update [tenant-settings.ts](file:///c:/1Squared/App/src/docs/articles/tenant-settings.ts) and [matters-enquiries-tasks-and-navigation.ts](file:///c:/1Squared/App/src/docs/articles/matters-enquiries-tasks-and-navigation.ts).
- **Release notes:** Add an `S0-22` entry in `docs/release-notes.md`.
- **Backlog updates (`docs/roadmap/feature-list.md`):**
  - Item `29` (*Departments and work types*): `Partly built` -> `Completed`.
  - Update *"What exists"* notes for `4` (Department & Team), `9` (Risk Assessment), `21` (Retention), `23` (Tasks) and `P13` (Work-type/practice-area uniformity), recording `P10` and `P11`.

---

## 9. Manual Setup / External Blockers

- `None`.

---

## 10. Acceptance Criteria

- [ ] Tenant config schema (`core/schemas/tenant-config.schema.json`) defines `type`, `default`, `description` and validation for work-type auto-tasks, work-type risk questions and work-type retention periods with zero client-specific core branches.
- [ ] Opening a matter creates work-type-specific auto-tasks inside the opening transaction.
- [ ] Matter risk assessment varies by work type and always computes scores server-side (`S0-08` preserved).
- [ ] Closing a matter sets `public.matters.destruction_date` from the work type's retention period (without building any automated deletion job).
- [ ] Departments, practice areas, work types and Admin config stay synchronised across Quotes, Intake, Matters and Admin (`P13` addressed).
- [ ] All unit, config validation, permission/MFA and two-tenant isolation tests pass, plus `npm run ci`.
- [ ] Help articles, `docs/release-notes.md` and `docs/roadmap/feature-list.md` (`29` -> `Completed`; advances on `4`, `9`, `21`, `23`, `P13`) are updated in the same PR.

---

## 11. Re-plan Signs & Risks

- **Re-plan if:**
  - Closing matters is blocked cleanly without knowing how existing closed seeded matters handle missing `destruction_date` -> backfill rule or closure-only calculation must be kept non-breaking for existing rows;
  - Work-type risk additions conflict with `S0-08` immutable risk score storage in PostgreSQL without a schema tweak;
  - `P13` reveals deeper refactoring needed inside `DEFAULT_ORG_DEPARTMENTS` beyond work-type sync (`feature-list.md` backlog item `P13` flagged in Stage Plan callout).
