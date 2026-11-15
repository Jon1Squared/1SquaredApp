# ADR 0032: Configuration-Driven Registers, Approvals and Reminders Engine

- **Date:** 2026-11-15
- **Status:** Accepted
- **Roadmap:** Stage 0 decision D7, slice S0-24 (`docs/roadmap/stage-0-plan.md`); backlog item 31 (and foundation for items 12, 15, 17, 18, 19, 20, 24)
- **Builds on:** [ADR 0025](./0025-permission-enforcement-pattern.md) (permission enforcement), [ADR 0028](./0028-tenant-database-and-repositories.md) (tenant databases and repositories), [ADR 0030](./0030-tenant-aware-scheduler.md) (tenant-aware scheduler)

## Context

Backlog item 31 requires a single reusable core engine for compliance and operational registers — records that have a configured lifecycle, an owner, due dates, approval rules, scheduled reminders/escalations, extension hooks, and an immutable audit trail.

At commit `6940cdc` on `develop`, three separate mechanisms exist:
1. **Sign-offs (`public.sign_offs` in `core/src/tenancy/taskWorkflowRepository.ts:96-113, 1214-1415` and `src/server/services.ts:12993-13195`):**
   - Currently supports three hard-coded kinds (`'write_off' | 'matter_opening' | 'undertaking'`, `src/domain/types.ts:1634`) and three hard-coded statuses (`'Pending' | 'Approved' | 'Discussing'`). Per the product owner's decision (15 November 2026), undertakings do not require two-person partner approval, so `'undertaking'` is removed from two-person `sign_off` approvals in `S0-24`.
   - Enforces `signoff:approve`, matter visibility (`canPersonAccessMatter` / `SIGN_OFF_VISIBLE_SQL_PREDICATE`), assigned-partner matching (`assignedPartnerId`), and no self-approval (`requestedById !== byId`) in `approveSignOff` and `discussSignOff`, but has no configurable fields, reminder schedule, or extension hooks.
2. **Document template approval (`core/src/tenancy/documentRepository.ts` and `src/server/documentGenerationServices.ts`):**
   - Specific to template versions (`Draft` → `Submitted` → `Active` / `Rejected` / `Retired`).
3. **Key dates (`core/src/tenancy/keyDateRepository.ts` and `src/domain/keyDates.ts`, ADR 0022):**
   - Dedicated limitation calculation, two-step verification, and staged reminder engine.

Later MVP stages require central registers for Undertakings (item 12), File reviews (item 15), Complaints (item 17), Breaches and incidents (item 18), Data protection requests (item 19), Supervision approvals (item 20), and Wills and deeds safe custody (item 24). Building each as a bespoke table and workflow would duplicate state validation, approver resolution, self-approval guards, reminder scheduling, and two-tenant isolation.

## Decision

### 1. Register types as schema-validated configuration (single source of truth)
- **Authoritative configuration model (`public.tenant_module_configs['registers']`):**
  - Register type definitions follow the same single-source-of-truth pattern as `S0-17c` (`TenantCatalogueRepository` in `core/src/tenancy/catalogueRepository.ts`): runtime administrator-managed register configuration is persisted solely in `public.tenant_module_configs` under `config_key = 'registers'` (`'registers'` added to `TenantModuleConfigKey`), schema-validated against `core/schemas/registers.config.schema.json` on read and write (`admin:access` + MFA, audited in the same transaction).
  - Effective register types are resolved inside the transaction by `resolveEffectiveRegisterTypes` in three deterministic layers:
    1. **Core built-in defaults (`CORE_REGISTER_TYPES`):** shipped in core (`sign_off` in Stage 0; `undertaking`, `complaint`, `breach`, `data_request`, `file_review`, `safe_custody` in Stages 2–4), including core-locked invariants that tenant configuration cannot weaken.
    2. **Declarative tenant package baseline (`tenantConfig.registers`):** optional version-controlled baseline in `client-<slug>/config/`, validated by `core/schemas/tenant-config.schema.json` and `core/src/config-engine/index.ts`.
    3. **Authoritative runtime admin configuration (`public.tenant_module_configs['registers']`):** authoritative when present for a `registerTypeKey`, overriding `tenantConfig.registers` and merging additively over `CORE_REGISTER_TYPES` (allowing custom fields, tenant-defined register types, and reminder schedules while preserving core-locked states, self-approval prohibition, and permission-key rules).
  - There is no separate `public.register_configs` table.
  - Each `RegisterTypeDefinition` specifies:
    - `key`: stable identifier (`^[a-z][a-z0-9_]{1,63}$`, e.g. `'sign_off'`).
    - `label`, `description`, `referencePrefix` (e.g. `'SO'` for `sign_off`, `'REG'` default) and `active: boolean`.
    - `linkedEntityRules`: whether a record may or must link to a `matter`, `person`, `organisation`, or `enquiry`.
    - `fields`: typed custom/domain field descriptors (`key`, `label`, `fieldType`: `'text' | 'longText' | 'number' | 'moneyMinorUnits' | 'date' | 'boolean' | 'choice' | 'personRef'`, `required`, `requiredInStates`, `options`).
    - `states`: array of `{ key, label, category: 'open' | 'pending_approval' | 'discussing' | 'approved' | 'rejected' | 'closed', isInitial?: boolean, isTerminal?: boolean }`.
    - `transitions`: array of `{ key, label, fromStates: string[], toState: string, kind: 'submit' | 'approve' | 'discuss' | 'reject' | 'resolve' | 'reopen' | 'update', requiresNote?: boolean, createsFollowUpTask?: boolean }`.
    - `approvalRules`: declarative approver rules (point 3).
    - `dueDateRules` and `reminderSchedule`: optional due-date offset and staged reminder/escalation rules (point 4).

### 2. Record lifecycle and states
- Every register record (`RegisterRecord` in `@platform/core-api`) holds:
  - `id` (allocated from per-tenant sequence), `tenantId`, `registerTypeKey`, `reference`, `kind` (subtype key within the register, e.g. `'write_off' | 'matter_opening'` for `sign_off`), `status` (state key), `title`, `subtitle`, `summary`.
  - Optional linked scope: `matterId`, `matterNumber`, `personId`, `organisationId`, `enquiryId`.
  - Actors and timestamps: `requestedById`, `requestedAt`, `ownerId`, `assignedApproverId`, `decidedById`, `decidedAt`, `dueAt`, `closedAt`, `updatedAt`, `rowVersion`.
  - Structured values: `amountMinorUnits` (`bigint` / integer pence, with compatibility getter for `amountGbp` on `sign_off`), `discussionNote`, and `fieldValues: Record<string, unknown>` validated against the register type's `fields` definition.
- **Lifecycle enforcement in core (`core/src/domain/registers/`):**
  - Creating a record places it in the register type's configured initial state (`'pending_approval'` for `sign_off`, or `'open'` directly without an approval gate for register types whose `approvalRules` is `null`, such as undertakings) and validates all required initial fields.
  - Every state change executes a named transition from `transitions`. Transitions not permitted from the current `status`, or missing required state fields or notes (`requiresNote: true`), fail closed with `REGISTER_INVALID_TRANSITION` or `REGISTER_VALIDATION_ERROR`.

### 3. Approvals: no self-approval, and permission keys (never labels)
- **Unconditional self-approval prohibition:**
  - Any transition of kind `'approve'`, `'discuss'`, or `'reject'` (or any transition governed by `approvalRules`) rejects when `actorId === record.requestedById` (or `actorId === record.createdById` when `requestedById` is unset) with stable error code `REGISTER_SELF_APPROVAL_FORBIDDEN`.
  - Tenants cannot disable the self-approval guard on register approvals.
- **Approver rules use stable `PermissionKey` values and relationship keys, never display labels (Architecture Standard §9, CLAUDE.md):**
  - Each register type (and optional `kind` override) declares `approvalRules` (or `null` when creation does not require two-person approval):
    - `requiredPermission`: a registered `PermissionKey` (e.g. `'signoff:approve'` for `'write_off'` and `'matter_opening'` sign-offs, `'register:approve'` for general registers requiring approval).
    - `requireMfa`: boolean (defaults to the permission's `requiresMfa` in `PERMISSION_REGISTRY`).
    - `allowedApproverScopes`: array of `'assigned_approver' | 'matter_supervising_partner' | 'matter_responsible_partner' | 'team_lead' | 'any_with_permission'`.
  - When `record.assignedApproverId` is set and `allowedApproverScopes` restricts approval to `'assigned_approver'`, only that person (holding `requiredPermission` and not being `requestedById`) may approve or discuss (`REGISTER_APPROVER_MISMATCH`).
- **Undertakings rules (Owner decisions, 15 November 2026):**
  - **Fee-earner roles only (`'undertaking:manage'` excludes `'admin'`):** A dedicated user permission `'undertaking:manage'` (domain `'undertaking'`, sensitivity `'standard'`, `requiresMfa: false`) is registered in `PERMISSION_REGISTRY` and granted by default in `DEFAULT_RBAC_ROLES` **only** to the four fee-earner roles identified by their **stable `HomeRoleKey`** (`'fee_earner'`, `'supervisor'`, `'partner'`, `'managing_partner'`) — never to `'admin'` (`DEFAULT_RBAC_ROLES.admin.permissions` filters out `'undertaking:manage'` from `ALL_USER_PERMISSION_KEYS`, `src/server/documentStoreServices.ts:323-326` uses resolved permissions rather than spreading `ALL_USER_PERMISSION_KEYS`, legacy `appRole === 'admin'` fallback expansion in `src/domain/rbac.ts:172-183` and `src/server/services.ts:8494-8504` does not bypass role exclusions, and `validateUserOverrideOrRoleMutation` in `core/src/domain/rbac/resolver.ts:746-774` allows an MFA-verified administrator holding both `'rbac:manage_user_overrides'` and `'rbac:manage_config'` to assign configured roles to other employees while blocking self-assignment and direct grant of unheld permissions).
  - **No two-person approval for undertakings:** **Any fee earner (`'undertaking:manage'`) may create/give (and in Stage 2 item 12 discharge) an undertaking directly without a partner or two-person approval step** (subject to `canPersonAccessMatter` when linked to a matter). Register types without an approval gate declare `approvalRules: null` and enter `'open'` directly on creation. Accordingly, `'undertaking'` is removed from two-person `sign_off` approvals in `S0-24`: `SignOffKind` (`src/domain/types.ts:1634`) narrows to `'write_off' | 'matter_opening'`, `approveSignOffAction` and `discussSignOffAction` remain governed solely by `'signoff:approve'`, and the seeded pending undertaking sign-off `SO-000003` (`src/seed/demo.ts:4022-4032`) is removed from `signOffs`.
- **Matter visibility and ethical walls (Rule 9, B12):**
  - When `record.matterId` is set, both the SQL repository (`REGISTER_RECORD_VISIBLE_SQL_PREDICATE` checking `matters.is_staff_matter`, `matters.has_ethical_wall`, and `matters.restricted_access_user_ids_json`) and the service layer verify `canPersonAccessMatter` before returning or mutating the record.

### 4. Reminders through the scheduler (`guardedJob`, job-only permission)
- Register types with `reminderSchedule` enabled define stages (`daysBeforeDue`, `overdueRepeatDays`, `priority`) and escalation targets (`owner`, `assigned_approver`, `team_lead`).
- Scheduled evaluation runs via a tenant-aware job (`jobKey = 'register-reminders'`) following ADR 0030:
  - Invoked through `guardedJob('register-reminders', ...)` requiring the new job-only permission `'register:run_reminders'` (`jobOnly: true` in `PERMISSION_REGISTRY`).
  - `'register:run_reminders'` is granted to **no** role (including `'admin'`), excluded from `ALL_USER_PERMISSION_KEYS`, and rejected by `resolvePersonPermissionSet`, `updatePersonPermissionOverrides`, and `updateTenantRbacConfig`.
  - Executes as actor `'system:register-reminders'` inside `withTenantTransaction` with `pg_try_advisory_xact_lock`, evaluating once per local business day at or after `02:00` in `tenantConfig.timeZone` using the server clock and recording completion in `public.job_runs`.
  - Advances per-record reminder state in `public.register_reminder_states`, creates in-app `public.notifications` (and email outbox entries once S0-26 lands), and writes `public.audit_entries` in the same transaction.
- **Key dates stay separate:** Key dates (`ADR 0022`) retain their existing tables, limitation calculator, and `key-date-reminders` job.

### 5. Same-transaction audit, side effects, and pre-/post-transaction boundaries
- **Pre-hooks (`beforeCreate`, `beforeTransition`):** Run **before** `withTenantTransaction` opens, with **no** PostgreSQL connection or transaction lock held (`R490`).
- **Single atomic transaction (`withTenantTransaction` over `SET LOCAL ROLE` on `TenantRegisterRepository`):** Every register create, field update, state transition, approval, discussion, and reminder runs inside one PostgreSQL transaction:
  - Inside the transaction, the core **re-reads and re-validates** everything used to decide the operation (`R478`, `R479`): the current `public.register_records` row and `row_version`, linked matter access metadata (`is_staff_matter`, `has_ethical_wall`, `restricted_access_user_ids_json`), people, teams, RBAC configuration, effective register configuration resolved from `public.tenant_module_configs['registers']`, and any `fieldValues` enriched or returned by a `beforeCreate` / `beforeTransition` hook.
  - Writes `public.register_records` and appends an immutable row to `public.register_transitions`.
  - Writes any follow-up task (such as the discussion follow-up task on `discussSignOff`) to `public.tasks` / `public.task_linked_records` using the same `tx` client.
  - Appends the `public.audit_entries` row(s) in the same transaction.
  - Uses zero compensation or "undo" logic.
- **Post-hooks (`afterTransition`):** Run **only after `withTenantTransaction` commits** (`R490`). An `afterTransition` error or timeout never rolls back or alters the committed record, transitions, follow-up tasks, or `audit_entries`.

### 6. Extension points and their contract
- Three generic register extension hooks are added to `PlatformExtension['hooks']` in `@platform/core-api` and `ExtensionHost` (`core/src/extension-host/index.ts`):
  1. `'register.beforeCreate'`: `(ctx: ExtensionExecutionContext, input: RegisterBeforeCreateHookInput) => Promise<RegisterBeforeCreateHookResult> | RegisterBeforeCreateHookResult`
     - Requires extension manifest permission `'register:write'`.
     - Executes **before** `withTenantTransaction` opens (with no database connection held) under `hookTimeoutMs` (default `2000ms`).
     - May enrich allowed `fieldValues` (which the core re-validates inside the subsequent transaction against `registers.config.schema.json`) or veto creation (`allowProceed: false`, `rejectionReason`).
     - **Fail-closed:** if an enabled extension throws or exceeds `hookTimeoutMs`, `ExtensionHost` catches the error, isolates it, and returns `allowProceed: false` so unvalidated records are never created and no transaction is opened.
  2. `'register.beforeTransition'`: `(ctx: ExtensionExecutionContext, input: RegisterBeforeTransitionHookInput) => Promise<RegisterBeforeTransitionHookResult> | RegisterBeforeTransitionHookResult`
     - Requires `'register:write'`.
     - Executes **before** `withTenantTransaction` opens (with no database connection held) under `hookTimeoutMs` (default `2000ms`), after which the core re-reads the current record and re-validates transition preconditions and returned `fieldValues` inside the transaction (`R478`, `R479`).
     - **Fail-closed:** timeout or thrown error blocks the transition (`allowProceed: false`).
  3. `'register.afterTransition'`: `(ctx: ExtensionExecutionContext, input: RegisterAfterTransitionHookInput) => Promise<void> | void`
     - Requires `'register:read'` or `'register:write'`.
     - Executes **only after `withTenantTransaction` commits** under `hookTimeoutMs` (default `2000ms`).
     - **Fail-safe advisory:** timeout or thrown error is isolated and logged with `tenantId` and `correlationId` (no personal data) without affecting the committed record or aborting the caller's response.
- Extensions receive only the frozen `ExtensionExecutionContext` (`tenant` + `config`), never a database client or another tenant's data. Contract tests in `S0-24` verify all three transaction boundaries (no DB connection held during `before*`, in-transaction re-read and re-validation, and post-commit failure isolation on `afterTransition`).

### 7. Migrating sign-offs onto the engine (expand migration and rollback)
- **Tables (expand migration, numbered in build order in the `S0-24` slice plan):**
  - `public.register_records`: `(tenant_id, id, register_type_key, reference, kind, status, matter_id, matter_number, person_id, organisation_id, enquiry_id, title, subtitle, summary, requested_by_id, owner_id, assigned_approver_id, decided_by_id, amount_minor_units, amount_gbp, requested_at, due_at, decided_at, closed_at, discussion_note, field_values_json, payload_json, row_version, updated_at, PRIMARY KEY (tenant_id, id))` with indexes on `(tenant_id, register_type_key, status, requested_at DESC)` and `(tenant_id, matter_id)`.
  - `public.register_transitions`: `(tenant_id, id, register_record_id, register_type_key, transition_key, from_status, to_status, actor_id, note, occurred_at, metadata_json, PRIMARY KEY (tenant_id, id))`.
  - `public.register_reminder_states`: `(tenant_id, register_record_id, schedule_id, last_stage_days_before, escalated_at, acknowledged_at, acknowledged_by_id, updated_at, PRIMARY KEY (tenant_id, register_record_id))`.
  - `GRANT SELECT, INSERT, UPDATE, DELETE` on these tables to the tenant role.
- **Data migration in `upSql`:**
  - Copies all two-person partner sign-off rows (`WHERE kind IN ('write_off', 'matter_opening')`) from `public.sign_offs` into `public.register_records` with `register_type_key = 'sign_off'`, `reference = id`, `amount_minor_units = ROUND(amount_gbp * 100)::bigint`, preserving all IDs (`SO-xxxxxx`), timestamps, `assigned_approver_id`, `decided_by_id`, `discussion_note`, and `payload_json` (`ON CONFLICT (tenant_id, id) DO NOTHING`).
  - `TenantTaskWorkflowRepository` sign-off methods (`getSignOffById`, `listVisibleSignOffs`, `putSignOff`, `upsertSignOffInTx`) delegate to or read/write `public.register_records` (`register_type_key = 'sign_off'`) so `approveSignOffAction`, `discussSignOffAction`, `flagMatterWriteOffAction`, and `AppSnapshot.signOffs` preserve their exact public contract (`'signoff:approve'`), no-self-approval checks, and audit behaviour for `'write_off'` and `'matter_opening'` while running on the registers engine.
  - Because migrations are expand-then-contract (Rule 8), `public.sign_offs` is retained in the expand migration (synced or backfilled on `downSql` from `register_records WHERE register_type_key = 'sign_off'`) before dropping the register tables in `downSql`, guaranteeing a lossless `up -> down -> up` round-trip.

## Alternatives Considered

- **Keep `public.sign_offs` separate and use the registers engine only for new Stage 2–4 modules.** Rejected: stage plan section 5 (`S0-24`) explicitly requires migrating sign-offs onto the registers engine as its first consumer so the engine is proven in production before Stage 2 undertakings and Stage 3 compliance registers build on it.
- **Move key dates onto the registers engine in Stage 0.** Rejected (D7): key dates have specialised limitation rules, business-day calendars, and two-person verification already hardened in `S0-15` and `S0-19`; they stay separate for now.
- **Identify approvers by role display labels (e.g. `"Partner"`).** Rejected: breaks RBAC rule ("New code compares stable keys, never display labels").

## Consequences

- `core/src/tenancy/registerRepository.ts` (`TenantRegisterRepository`) and `core/src/domain/registers/` become the single core implementation for register records, state transitions, approval checks, and reminder scheduling, reading runtime admin register configuration solely from `public.tenant_module_configs['registers']` via `resolveEffectiveRegisterTypes`.
- New permissions `'register:view'`, `'register:create'`, `'register:edit'`, `'register:approve'`, `'register:configure'`, `'undertaking:manage'` (granted **only** to the four fee-earner roles by `HomeRoleKey`: `'fee_earner'`, `'supervisor'`, `'partner'`, `'managing_partner'`, excluding `'admin'`), and `'register:run_reminders'` (`jobOnly: true`) are registered in `PERMISSION_REGISTRY`. On `sign_off`, `'signoff:approve'` continues to govern `'write_off'` and `'matter_opening'`, while undertakings have no two-person approval step (`SignOffKind = 'write_off' | 'matter_opening'`).
- Two-tenant isolation tests in `core/tests/isolation.test.ts` (including forged tenant claims and tampered `SO-xxxxxx` / `REG-xxxxxx` IDs) and extension hook contract tests cover the engine end to end.
