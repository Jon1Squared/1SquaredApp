# ADR 0022: Key Dates and Limitation Module

- **Date:** 2026-11-03
- **Status:** Proposed

## Context

Legal matters and enquiries carry time-critical obligations—most critically statutory or contractual limitation dates, procedural court deadlines, regulatory filings, and matter-specific undertakings. Missing a limitation date is a severe professional negligence and regulatory risk.

We need a first-class **Key Dates & Limitation** module across the platform that:

1. Captures, calculates, verifies, reminds on, and reports on key dates for both enquiries and matters.
2. Enforces the principle that **the system suggests dates while a qualified person confirms them** (including extracted dates from documents, which always land as `provisional`).
3. Provides a pure, deterministic **limitation calculator** driven entirely by tenant configuration (with zero statutory periods hardcoded in core code) and a step-by-step calculation breakdown.
4. Supports configurable **two-step verification** per matter type (or unconditionally when a rule set is marked `reviewStatus: 'unreviewed'`), ensuring the proposer can never verify their own date.
5. Drives reminders through a **single-task, non-stacking reminder state machine** in the existing tasks domain (`src/domain/tasks.ts`), updating one linked task in place as reminder stages progress or escalate.
6. Provides a **Team Diary** (month, week, and list views) where each key date belongs to a team diary (`teamId`) as its backup owner, alongside an **Exceptions report** for compliance oversight.
7. Enforces strict **staff/restricted matter isolation** in the data layer across the diary, reminders, exceptions, and calendar sync.
8. Defines the contract and state model (`KeyDateCalendarSync`) for **one-way calendar sync** to Microsoft Outlook via Microsoft Graph (not available in Phase 1; records remain in state `'disabled'` until a live Microsoft Graph adapter is delivered), with the platform as the sole source of truth.
9. Exposes additive extension points (`keyDate.beforeCreate`, `keyDate.afterStatusChange`, `keyDate.calculateCustomRule`) and extension permissions (`keydate:read`, `keydate:write`) in `@platform/core-api`.

During design inspection against `docs/architecture-standard.md` and existing ADRs (notably ADR-0001, ADR-0010, ADR-0011, ADR-0014, and ADR-0016), several structural integration questions arose between the module specification and the existing codebase. This ADR records our architectural decisions for those integration points.

## Decision

### 1. Core Feature Behind `keyDates.enabled` (`false` by default)

The Key Dates & Limitation module is implemented as a **Core feature** (Section 14 of `docs/architecture-standard.md`), gated behind the tenant configuration flag `keyDates.enabled` (default `false`).

- No client names, matter type IDs, or statutory limitation periods appear in core code.
- All key date types, limitation rules, business calendars, reminder schedules, matter-type verification policies, and calendar sync settings are loaded from schema-validated tenant configuration (`schemas/keyDates.config.schema.json` and `core/src/config-engine/index.ts`).
- The same build runs unchanged in single-tenant (client Azure) and multi-tenant (hosted) deployments.

### 2. Tenant-Scoped Data Layer and Expand-Then-Contract Migration

In alignment with Rule 4 and Rule 8 of the Platform Architecture Standard and ADR-0001:

- **PostgreSQL Tenant Data Layer (`core/src/tenancy/`):** We add reversible, expand-first migration `0003` (`version: '0003'`, `name: '0003_key_dates_expand'`) creating tenant-scoped tables (`key_dates`, `key_date_not_applicable`, `key_date_reminder_states`, `key_date_calendar_syncs`, and `key_date_audit_events`), plus reversible, expand-first migration `0004` (`version: '0004'`, `name: '0004_key_date_reminder_last_skipped_reason_expand'`, adding the nullable `last_skipped_reason` column with a `CHECK (last_skipped_reason IS NULL OR last_skipped_reason IN ('no_permitted_assignees', 'missing_matter'))` constraint to `key_date_reminder_states`), together with `TenantKeyDateRepository` (validated in `core/tests/key-dates-isolation.test.ts` for the target PostgreSQL database-per-tenant architecture). In the current transitional phase (per ADR-0001), the running Next.js application in `src/server/services.ts` reads and writes key date records through the transitional `FirmStore` (`src/server/store.ts`) rather than `TenantKeyDateRepository`; full cut-over of `src/server/services.ts` to `TenantKeyDateRepository` is scheduled alongside the broader `FirmStore` → PostgreSQL cut-over.
- **Rollback Procedure for Migrations `0003` and `0004` (`dependsOn`):** `TenantMigrationDefinition` includes an optional `dependsOn?: readonly string[]` list of prerequisite migration versions (`0004` declares `dependsOn: ['0003']`), so `TenantMigrationRunner` enforces dependency order on both `applyUp` (`MIGRATION_DEPENDENCY_ERROR` if `0003` is not applied before `0004`) and `rollbackVersion` (`MIGRATION_ROLLBACK_ORDER_ERROR` if `0004` is still applied when rolling back `0003`, without blocking rollback of unrelated earlier migrations such as `0002`). First call `rollbackVersion(ctx, '0004')` (or `'0004_key_date_reminder_last_skipped_reason_expand'`), which drops the `last_skipped_reason` column and its `CHECK` constraint from `key_date_reminder_states` while retaining `key_date_reminder_states` and all other key date tables intact. Then call `rollbackVersion(ctx, '0003')` (or `'0003_key_dates_expand'`), which drops the operational tables (`key_date_calendar_syncs`, `key_date_reminder_states`, `key_date_not_applicable`, `key_dates`) while **retaining `key_date_audit_events`** intact so immutable compliance audit history is never destroyed during a schema rollback.
- **Transitional Host Store (`src/server/store.ts` & `src/server/services.ts`):** During the ADR-0001 transitional phase, the Next.js host persists `keyDates`, `keyDateNotApplicable`, `keyDateReminderStates`, and `keyDateCalendarSyncs` in `FirmStore` (normalised safely on load), while `src/server/services.ts` resolves `keyDates` configuration through `getActiveTenantConfiguration()` in `src/platform/tenantRuntime.ts`, enforces matter access (`canViewerAccessMatterKeyDates`) and team diary scoping (`resolvePermittedDiaryTeamIds`) before returning snapshots or mutating state, and runs the reminder scheduler through `runTenantBackgroundJob`.
- **Immutability & Superseding:** Key dates are never deleted. Modifying the date of a `confirmed` record creates a new `KeyDate` record (`supersedesKeyDateId` pointing to the prior record) and transitions the old record to `superseded` with a mandatory `supersededByKeyDateId` and `supersededReason`. Converting a `confirmed` calculated key date to a manual override (`source: 'manual'`, clearing `calculation`) likewise supersedes the prior confirmed record with a new record carrying `supersedesKeyDateId` and transitions the prior record to `superseded`.

### 3. Pure Limitation Calculator Engine (`src/domain/keyDateCalculator.ts`)

The limitation calculator is a pure function with zero I/O:

- Inputs: `LimitationRuleConfig`, `CalculationInputValues`, `BusinessCalendarConfig`, and calculation timestamp.
- Supports `single` and `later_of` triggers (`triggerDate` and `dateOfKnowledge`), `years` / `months` / `days` (including negative days), `calendar` / `business_days` / `clear_days` counting modes, `nonWorkingDayAdjustment` (`none`, `next_business_day`, `previous_business_day`), minority adjustment (computing the age-of-majority date from `claimantDateOfBirth` only when `minorityAdjustment.enabled` is true), standstill period additions, and longstop caps (taking the earlier of the primary date and the longstop date).
- Produces a `CalculationResult` containing the `calculatedDate`, `effectiveTriggerUsed`, `longstopEffective`, `standstillDaysAdded`, `minorityAdjusted`, and an ordered `steps: CalculationStep[]` breakdown, plus the mandatory warning `"This calculation is a guide. A solicitor must confirm the date."`
- Dates of birth (`claimantDateOfBirth`) are treated as personal data under §11 of the standard: they are only accepted and stored in `CalculationInputValues` when the selected rule has `minorityAdjustment.enabled === true`, and are never written to application logs or synced to external calendars.

### 4. RBAC Integration: Central `PERMISSION_REGISTRY` + `keyDates.permissions.roleGrants`

To reconcile `keyDates.permissions.roleGrants` from the module specification with ADR-0010 (Central Permission Registry & Resolver) and ADR-0016 (`HomeRoleKey` unification):

- All eight `KeyDatePermission` keys (`keydate:view`, `keydate:view_any_team`, `keydate:edit`, `keydate:verify`, `keydate:resolve`, `keydate:waive`, `keydate:override_calculation`, `keydate:configure`) are registered in `PERMISSION_REGISTRY` (`core/src/domain/rbac/registry.ts`). `keydate:configure` is marked `requiresMfa: true`.
- `DEFAULT_RBAC_ROLES` in `core/src/domain/rbac/resolver.ts` includes default grants matching the specification. Because `team_lead` in `AppRole` was unified into `supervisor` (`HomeRoleKey`) and the `is_team_lead_of_any_team` relationship rule in ADR-0016, `keyDates.permissions.roleGrants['team_lead']` maps cleanly to `supervisor`, legacy `appRole === 'team_lead'`, and `isTeamLeadOfAnyTeam` relationship grants.
- `resolveKeyDatePermissions` and `hasKeyDatePermission` in `src/domain/keyDates.ts` evaluate the user's effective `HomeRoleKey[]`, legacy `AppRole`, `keyDates.permissions.roleGrants` tenant configuration, and per-person `permissionOverrides` (`grant`/`revoke`).

### 5. Single-Task Non-Stacking Reminder Engine

Every confirmed key date has at most one `KeyDateReminderState` and **one** linked `Task` in `src/domain/tasks.ts`:

- When a key date is confirmed, a single task is created (or updated if carried over from a superseded key date) with tenant-scoped idempotency key `keydate-reminder:{tenantId}:{keyDateId}` (`UNIQUE (tenant_id, idempotency_key)`), `assignedTeamId = keyDate.teamId`, and `assignedPersonIds` filtered to responsible people permitted to access the matter.
- The daily per-tenant scheduler job requires a verified `tenantId` in its job context and refuses to run without one.
- Crossing into a closer reminder stage updates the **same** `Task` in place (priority, due date, stage description), resets `acknowledgedAt` / `acknowledgedByUserId` on `KeyDateReminderState`, and dispatches one notification.
- Unacknowledged stages after `escalation.afterUnacknowledgedDays` step through `escalation.levels` on the same task without creating duplicate tasks.
- When a key date is superseded, the superseding key date takes over the existing `taskId`. When resolved (`met`, `missed`, `waived`), the linked task is completed/closed. If a confirmed date passes without resolution, it remains at the highest reminder stage as past-due/unresolved until explicitly resolved as `met` or `missed`.

### 6. Team Diary, Compliance Exceptions, and Staff Matter Isolation

- Each `KeyDate` requires a `teamId` (`Team.id`), defaulting to the matter's owning team (or the enquiry's `assignedTeamId`), and `responsiblePersonIds` defaulting to the employees on the matter (`responsiblePartnerId`, `supervisingPartnerId`, `leadFeeEarnerId`, `teamMemberIds`).
- **Restricted (staff) matter isolation:** Enforced in the data/service layer before records reach any UI, reminder dispatcher, exception report, or calendar sync job. For any matter where `isStaffMatter === true` or `restrictedAccessUserIds.length > 0`, key dates, reminders, and exceptions are omitted completely (with no placeholder) unless the viewer is authorised (in `matter.restrictedAccessUserIds` or holding `matter:restricted:access`). Restricted matters **never** sync to external calendars under any configuration.

### 7. One-Way Outlook Calendar Sync Contract (Deferred Live Graph Adapter)

- Calendar sync policy is resolved from `matterTypes[].calendarSync.enabled` falling back to `defaults.calendarSync.enabled` (`true`).
- Microsoft Outlook synchronisation via Microsoft Graph is **not available in Phase 1**. Until a live Microsoft Graph calendar adapter is delivered in a subsequent release, no external Graph calls are made by default (`ManagedIdentityGraphCalendarAdapter.isConfigured` is `false`) and every `KeyDateCalendarSync` record remains in state `'disabled'` (never marked `'synced'` without an injected adapter).
- When a calendar adapter is supplied, event titles are rendered from `calendarSync.eventTitleTemplate` (`{matterReference}`, `{keyDateTypeLabel}`, `{title}`, `{category}`) without client names or personal data, and restricted matters are unconditionally excluded. Reassigning a key date re-runs calendar sync and deletes any removed owner's external event. Sync failures are recorded in `KeyDateCalendarSync` (`state: 'failed'`, `lastError` redacted of personal/client content) and surfaced in the compliance exceptions view as `calendar_sync_failed`.

### 8. Extension API v1.1.0

- `@platform/core-api` (`core/src/api/index.ts`) and `core/schemas/extension-manifest.schema.json` are extended additively with `KeyDateExtensionPoint` (`keyDate.beforeCreate`, `keyDate.afterStatusChange`, `keyDate.calculateCustomRule`) and `KeyDateExtensionPermission` (`keydate:read`, `keydate:write`).
- `CORE_API_VERSION` advances from `1.0.0` to `1.1.0` (backward-compatible within major version `1.x`).

## Alternatives Considered

1. **Create a new task per reminder stage (stacking tasks):** Rejected. Stacking tasks floods fee earners' task lists with stale 90/60/30-day tasks for the same deadline and obscures whether the current stage has been acknowledged.
2. **Hardcode statutory limitation periods (e.g. Limitation Act 1980 periods) as fallback defaults in core code:** Rejected. Directly violates the Platform Architecture Standard and functional requirement §2 ("No statutory periods in core code. All rules come from tenant configuration").
3. **Filter restricted/staff matters only in React components:** Rejected. Violates Rule 4/§9 of the standard and requirement §5; restricted matter filtering must occur in the data/query layer so unauthorised callers receive zero rows and zero count leakage.

## Consequences

- **Positive:** Complete lifecycle tracking for limitation and key dates from enquiry through matter closure; zero duplicate reminder tasks; full tenant configurability without code changes; auditable two-step verification and compliance exception reporting.
- **Negative / Trade-offs:** Keeping both transitional store support (`src/server/store.ts`) and PostgreSQL repository/migration support (`core/src/tenancy/`) requires maintaining parity across both persistence adapters until ADR-0001 transitional store retirement is completed.
