# S0-24 — Registers Engine in the Core (Declarative Registers, Sign-Off Migration and Extension Points)

| Field | Value |
|---|---|
| Slice | `S0-24` |
| Stage / Work package | Stage 0C — Make it shared (`WP5b`) |
| Status | Planned (awaiting build; migration `0017` after `0016`) |
| Branch | `s0-24-registers-engine` (target `develop`) |
| Depends on | `S0-17a`, `S0-19` (on `develop`; stacked on `0016` if built sequentially in `WP5b`) |
| Size | `L` |
| Backlog IDs | `31` (`Built differently` -> `Completed`; advances `20`, `E8`; cross-cutting `P8`, `P10`, `P11`) |
| Decision record(s) | `D7` — [ADR 0032](../decisions/0032-registers-engine.md) (`Accepted`, with 15 Nov 2026 owner undertaking rules) |
| Spec / standards references | Architecture Standard sections 4, 6, 7, 10, 12; [ADR 0030](../decisions/0030-tenant-aware-scheduler.md); [RBAC Reference](../rbac-reference.md) |

---

## 1. Purpose

Replace ad-hoc per-register storage with one generic, schema-driven **Registers Engine** in `@platform/core` (`ADR 0032`, `D7`), close backlog item `31` (*Registers engine*, currently `Built differently` -> `Completed`), migrate the existing partner `sign_off` queue onto it as the first live consumer, wire scheduler reminders (`S0-19`) and public extension hooks, and prove multi-tenant isolation.

Key owner-approved domain rules (15 November 2026):
- `'undertaking:manage'` is granted by default **only** to the four fee-earner roles: `'fee_earner'`, `'supervisor'`, `'partner'`, `'managing_partner'` — **never `'admin'`**.
- **No two-person approval for creating undertakings:** any fee earner holding `'undertaking:manage'` can create/record an undertaking directly without prior approval (optional approval rules are per-register configuration: `sign_off` configures approval + no self-approval, while generic undertakings allow direct fee-earner creation).
- **Core engine scope only in `S0-24`:** full Stage 2 undertakings UI/registers and Stage 3 registers (`20`, `E8`) remain in Stage 2/3, built on top of this engine.

---

## 2. Classification & Architectural Layer

- **Classification:** Core domain module (`core/src/domain/registers/`), core migration (`0017`), core extension points (`core/src/api/`, `core/src/extension-host/index.ts`), Bicep scheduler job + CLI job handler (`register-reminders`), and host sign-off migration (`src/server/services.ts`).
- **Single-tenant and multi-tenant operation:** Identical build. Register type definitions (`CORE_REGISTER_TYPES` + tenant config in `public.tenant_module_configs['registers']`) and register records/transitions/reminders are stored per tenant inside that tenant's PostgreSQL database.

---

## 3. Existing Code & Schema

- **Database schema version entering `S0-24`:** `0016` (if stacked after `S0-28`/`S0-28a`) or `0015` (ensure sequential numbering `0017` when landing in `WP5b`).
- **Current `sign_offs` implementation to migrate:** `SignOffKind` (`src/domain/types.ts:1634`), `TenantTaskWorkflowRepository` & `SIGN_OFF_VISIBLE_SQL_PREDICATE` (`core/src/tenancy/taskWorkflowRepository.ts:484, 495, 1342-1370`), `approveSignOff` (`src/server/services.ts:12993`), `approveSignOffAction` (`src/app/actions.ts:948`).
- **Demo fixture to remove (`ADR 0032`):** `'SO-000003'` in `src/seed/demo.ts:4022` and its assertion in `src/domain/home.test.ts:479`.
- **Scheduler, jobs & Bicep contracts:** `JOB_PERMISSIONS` (`src/server/actionPermissions.ts:706-768`, `MAX_KNOWN_GAPS = 0`), `REGISTERED_CLI_JOBS` (`scripts/run-job.ts:44-85`), `ExtensionHost` (`core/src/extension-host/index.ts:73`), `core/infra/modules/platform.bicep:1380-1475`, `core/tests/infra-bicep-contract.test.ts:327-336`.

---

## 4. Scope & Exact Changes

### 4.1 Migration `0017_registers_engine_expand` & sign-off backfill

Bump `CORE_REQUIRED_SCHEMA_VERSION` to `'0017'` and add `0017_registers_engine_expand` (expand-first, reversible):

- Ensure `public.tenant_module_configs` supports `module_key = 'registers'` for declarative register type configurations (`fields`, `states`, `transitions`, `owner`, `dueDates`, `approvalRules`, `reminderSchedule`, `CORE_REGISTER_TYPES` baseline + schema validation).
- Add **`public.register_records`** (generic core record table: `id`, `tenant_id`, `register_key`, `reference`, `matter_id NULL`, `person_id NULL`, `owner_person_id`, `status`, `due_at NULL`, `payload_jsonb`, `approval_status`, `created_by_id`, `approved_by_id NULL`, `row_version`, timestamps).
- Add **`public.register_transitions`** (immutable transition history: `from_state`, `to_state`, `actor_person_id`, `note`, `transitioned_at`).
- Add **`public.register_reminder_states`** (tracks next/last reminder stage per `register_record_id` for idempotent reminder dispatch).
- **Backfill `sign_off` from `public.sign_offs`:** Copy existing `public.sign_offs` rows into `public.register_records` (`register_key = 'sign_off'`) idempotently inside `0017` without dropping `public.sign_offs` immediately (keep `public.sign_offs` deprecated for safe rollback per Rule 8; contract drop scheduled after Stage 0 verification).

### 4.2 Core Registers Engine & `sign_off` Consumer Cut-Over

- Build generic core engine (`TenantRegisterRepository` + core service/validation logic):
  - Declarative schema-validated register definition (`CORE_REGISTER_TYPES` including `'sign_off'` with no-self-approval rule preserved and `'undertaking'` baseline schema type with direct creation rule and zero two-person creation gate).
  - State machine transitions, configurable optional approval enforcement (blocks `created_by_id === approverId` whenever an approval rule IS configured on a transition/register type; permits direct fee-earner creation when no approval rule is set, as for undertakings), overdue/due-soon calculation, matter-visibility filtering via `canAccessMatter` / SQL joins against `public.matters`, and same-transaction `audit_entries`.
- Cut `src/server/services.ts` (`approveSignOff`, decline, list, create sign-offs — excluding demo `'SO-000003'`) over to `TenantRegisterRepository` (`register_key = 'sign_off'`), removing `'SO-000003'` from `src/seed/demo.ts:4022` and updating `src/domain/home.test.ts:479`.

### 4.3 RBAC Permission `'undertaking:manage'`

- Register `'undertaking:manage'` in `PERMISSION_REGISTRY` (`core/src/domain/rbac/registry.ts`).
- Grant `'undertaking:manage'` by default **ONLY** to `'fee_earner'`, `'supervisor'`, `'partner'`, `'managing_partner'` in `DEFAULT_RBAC_ROLES` — explicitly **exclude `'admin'`** and all support/secretarial roles (enforced in `core/tests/rbac.test.ts`).

### 4.4 Scheduler Job `register-reminders` (`ADR 0030`)

- Add `register-reminders` job inside `guardedJob('register-reminders', ...)` requiring new `jobOnly: true` permission **`'register:run_reminders'`** in `core/src/domain/rbac/registry.ts` and `JOB_PERMISSIONS` (`src/server/actionPermissions.ts:706-768`, keeping `MAX_KNOWN_GAPS = 0`).
- Register `'register-reminders'` in `REGISTERED_CLI_JOBS` (`scripts/run-job.ts`) and add Container Apps job **`caj-reg-rem-<env>`** in `core/infra/modules/platform.bicep` + update `core/tests/infra-bicep-contract.test.ts:327-336`.
- Execute idempotently via `pg_try_advisory_xact_lock`, `public.job_runs` and `public.register_reminder_states`, emitting in-app notifications (`'register_review_assigned'` / overdue alerts) without duplicating same-day reminders.

### 4.5 Three Public Extension Points (`@platform/core-api` & `ExtensionHost`)

Publish and wire three typed extension hooks in `core/src/api/` and `core/src/extension-host/index.ts` (Rule 3: extensions import `@platform/core-api` only):

1. **`register.beforeCreate`** (can validate/enrich or abort creation with domain error; timeout & error isolated).
2. **`register.beforeTransition`** (can validate preconditions or abort state transition; timeout & error isolated).
3. **`register.afterTransition`** (fire-and-forget / post-commit or structured side-effect hook with timeout & error isolation; failing hook never corrupts committed transition).

### 4.6 Out of Scope

- Full Undertakings end-user workflows/screens (Stage 2, respecting direct fee-earner creation rule established here).
- Stage 3 Compliance / Complaints / Data-Breach registers (`20`, `E8`).
- Migrating `KeyDates` off `TenantKeyDateRepository` (remains separate per ADR 0032).

---

## 5. Migrations & Backwards Compatibility

- **Migration:** `0017_registers_engine_expand` (expand-only; creates `public.register_records`, `public.register_transitions`, `public.register_reminder_states`, adds `registers` config key, backfills `sign_offs`; bumps `CORE_REQUIRED_SCHEMA_VERSION` to `'0017'`).
- **Reversibility & Rule 8:** `public.sign_offs` is retained read-only during Stage 0 as an expand-phase fallback; down SQL removes the new register tables cleanly without deleting historical `sign_offs`. Contract removal happens in a later release after Stage 0 burn-in.

---

## 6. Security, Tenancy & Permissions

- No-self-approval rule enforced server-side when an approval rule is present (`sign_off`), whereas undertaking creation requires only `'undertaking:manage'` with no two-person gate.
- RBAC asserts `'undertaking:manage'` is never assigned by default to `'admin'`.
- `register-reminders` runs solely via `guardedJob` (`sub: 'system:register-reminders'`, `roles: []`) and `jobOnly: true` permission `'register:run_reminders'`.
- Queries against `public.register_records` join `public.matters` using visibility predicates matching `canAccessMatter` / `SIGN_OFF_VISIBLE_SQL_PREDICATE` so restricted (`isStaffMatter` / `hasEthicalWall`) linked records never leave the repository for unpermitted callers.
- Extensions run through `ExtensionHost` with manifest permission enforcement, timeouts and error isolation (never importing core internals).

---

## 7. Tests Required

1. **Engine & state-machine unit/integration tests:** Declarative register config validation, field validation, allowed/disallowed state transitions, immutable `register_transitions` trail and same-transaction audit entries.
2. **Undertaking & sign-off rule tests:**
   - Assert `'undertaking:manage'` default grants cover `{ fee_earner, supervisor, partner, managing_partner }` and explicitly **exclude `'admin'`** (`core/tests/rbac.test.ts`).
   - Direct undertaking creation succeeds for a single `fee_earner` without two-person approval.
   - `sign_off` enforces no-self-approval (`created_by === approver` rejected) and migrates `public.sign_offs` rows cleanly; assert `'SO-000003'` is absent from `src/seed/demo.ts` and `home.test.ts` updated.
3. **Extension hook contract tests (`core/tests/extensions*.test.ts`):** Verify `register.beforeCreate`, `register.beforeTransition` and `register.afterTransition` invocations, manifest permission gating, `before*` cancellation rollback, `afterTransition` error/timeout isolation and `@platform/core-api`-only imports.
4. **Scheduler & Bicep contract tests:** `register-reminders` two-tenant idempotency (`job_runs` + `register_reminder_states`), `'register:run_reminders'` rejected for interactive users, `infra-bicep-contract.test.ts` passes with `caj-reg-rem-<env>`.
5. **Two-tenant isolation tests (`P8`):** Tampered `registerRecordId`, forged `tenantId` claims, cross-tenant transitions and restricted matter (`isStaffMatter` / `hasEthicalWall`) register records fail closed across Tenant A and Tenant B.

---

## 8. Documentation, Help & Backlog Updates

- **Help & documentation (`Rule 11`, `P11`):**
  - Update [sign-off-queue.ts](file:///c:/1Squared/App/src/docs/articles/sign-off-queue.ts) (backed by core Registers Engine, `'SO-000003'` demo removal).
  - Add/register new core Registers Engine article (registered in `src/docs/registry.ts`) explaining declarative register types, approval rules vs direct fee-earner undertakings, reminder scheduling and extension hooks.
- **Release notes:** Add an `S0-24` entry in `docs/release-notes.md`.
- **Backlog updates (`docs/roadmap/feature-list.md`):**
  - Item `31` (*Registers engine*): `Built differently` -> `Completed`.
  - Record foundation laid for `20` (Registers) and `E8` (Extension points) + `P8`, `P10`, `P11`.

---

## 9. Manual Setup / External Blockers

- `None` (container apps infrastructure deployment of `caj-reg-rem-<env>` happens automatically on Bicep apply).

---

## 10. Acceptance Criteria

- [ ] Migration `0017_registers_engine_expand` creates `public.register_records`, `public.register_transitions`, `public.register_reminder_states` and migrates `public.sign_offs`; `CORE_REQUIRED_SCHEMA_VERSION === '0017'`.
- [ ] `sign_off` queue runs live on the core Registers Engine; demo `'SO-000003'` is removed from `src/seed/demo.ts:4022` and `home.test.ts:479`.
- [ ] `'undertaking:manage'` is granted by default ONLY to `{ fee_earner, supervisor, partner, managing_partner }` (never `'admin'`) and undertaking creation needs no two-person approval.
- [ ] `register-reminders` runs under `guardedJob` with `'register:run_reminders'` and Bicep job `caj-reg-rem-<env>`.
- [ ] All 3 extension hooks (`register.beforeCreate`, `register.beforeTransition`, `register.afterTransition`) pass contract and isolation tests via `@platform/core-api`.
- [ ] Two-tenant isolation tests (tampered record IDs, forged tenant claims, restricted matters) and `npm run ci` pass.
- [ ] Help articles, `src/docs/registry.ts`, `docs/release-notes.md` and `docs/roadmap/feature-list.md` (`31` -> `Completed`) are updated in the same PR.

---

## 11. Re-plan Signs & Risks

- **Re-plan if:**
  - Any `sign_off` workflow relies on legacy JSON keys on `public.sign_offs` without mapping cleanly into `register_records.payload_jsonb`;
  - Adding `caj-reg-rem-<env>` alters existing Bicep module outputs expected by deployment scripts outside `infra-bicep-contract.test.ts`;
  - An existing extension manifest breaks contract validation when adding the 3 new register extension points.
