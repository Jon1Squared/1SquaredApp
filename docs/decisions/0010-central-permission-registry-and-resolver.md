# ADR-0010: Central Permission Registry and Single Permission Resolver

- **Date:** 2026-11-01
- **Status:** Accepted
- **Supersedes:** Permission resolution aspects of [ADR-0004](./0004-document-permissions-and-finance-view.md)

## Context

Authorisation across the platform has grown across three parallel mechanisms:
1. Employee permissions (`EmployeePermission` and `resolveEmployeePermissions` in `src/domain/employment.ts`).
2. Document Generation permissions (`DocumentPermission` and `resolveDocumentPermissions` in `core/src/domain/document-generation/permissions.ts`).
3. Ad-hoc role, label, department, and `AppRole` checks (`resolveUserAppRole` in `src/domain/tasks.ts`, `canUserViewFinance` in `src/domain/pms.ts`, `getLeftRailVisibility` in `src/domain/homeConfig.ts`, and `computeStaffMatterStatus` in `src/domain/employment.ts`).

Section 9 of `docs/architecture-standard.md` requires RBAC to be defined in the core, with clients mapping their own roles through configuration, enforced on every API route, background job, search query, and export, and requiring multi-factor authentication (`mfaVerified`) for administrative actions.

## Decision

### 1. Single Canonical Permission Registry in `@platform/core-api`

We define a single versioned **Permission Registry** (`PERMISSION_REGISTRY`) in `core/src/api/index.ts` and `core/src/domain/rbac/registry.ts` using the `resource:action` naming convention.

Each `PermissionRegistryEntry` contains:
- `key: PermissionKey` — Stable `resource:action` identifier.
- `domain: 'employee' | 'document_template' | 'document' | 'finance' | 'risk' | 'matter' | 'task' | 'enquiry' | 'admin' | 'rbac'`
- `description: string` — Human-readable explanation of what the permission grants.
- `sensitivity: 'standard' | 'restricted' | 'confidential' | 'critical'`
- `requiresMfa: boolean` — Whether `TenantContext.mfaVerified === true` is required on the server before granting or executing an action protected by this permission.
- `sinceVersion: string` — SemVer version when introduced.
- `deprecated?: { sinceVersion: string; replacementKey?: PermissionKey; reason: string }`

#### Registered Permissions (`PermissionKey`)

| Permission Key | Domain | Sensitivity | `requiresMfa` | Description |
|---|---|---|---|---|
| `employee:view_core` | `employee` | `standard` | `false` | View core employee directory and business contact fields |
| `employee:edit_core` | `employee` | `restricted` | `false` | Create and edit core employment, role, and team fields |
| `employee:hr_restricted` | `employee` | `confidential` | `false` | View and edit HR restricted fields (contracts, appraisals, leave, right-to-work, personal contact) |
| `employee:payroll` | `employee` | `confidential` | `false` | View and edit payroll, salary, bank, and tax fields |
| `employee:sensitive` | `employee` | `critical` | `false` | View and edit special-category diversity, medical, and criminal check fields |
| `document_template:view` | `document_template` | `standard` | `false` | View document templates, versions, and mappings |
| `document_template:build` | `document_template` | `restricted` | `false` | Create, upload, map, import/export, and submit document template drafts |
| `document_template:approve` | `document_template` | `critical` | `true` | Approve, reject, retire, and roll back document template versions |
| `document_template:view_usage` | `document_template` | `standard` | `false` | View aggregate template usage dashboards and reports |
| `document_template:view_usage_by_user` | `document_template` | `confidential` | `false` | View and export per-user template usage breakdowns (also requires `usage.showUserLevelDetail`) |
| `document:generate` | `document` | `standard` | `false` | Preview and generate documents from active templates on accessible records |
| `document:delete` | `document` | `restricted` | `false` | Delete saved generated documents |
| `finance:view` | `finance` | `restricted` | `false` | Access firm-wide finance workspace, billing/aged-debt queues, and `financial.*` document merge fields |
| `finance:view_matter` | `finance` | `standard` | `false` | View matter and client financial tabs, WIP, client balances, and financial attention alerts on accessible records |
| `finance:credit_control` | `finance` | `restricted` | `false` | Record credit control chase actions, request matter bills, and flag write-offs |
| `finance:manage_links` | `finance` | `critical` | `true` | Link or unlink Practice Management System (PMS) client and matter codes |
| `risk:view` | `risk` | `restricted` | `false` | Access Risk & Compliance workspace, CDD/AML oversight queues, and send compliance reminders |
| `matter:restricted:access` | `matter` | `confidential` | `false` | Oversight access to restricted staff matters (`isStaffMatter`) and their linked documents |
| `task:claim_any` | `task` | `standard` | `false` | Take or claim unassigned tasks across any team |
| `task:reassign_any` | `task` | `restricted` | `false` | Reassign tasks across any user or team |
| `enquiry:intake_view` | `enquiry` | `standard` | `false` | Default to the intake/call-handler view and workflow on the Enquiries queue |
| `admin:access` | `admin` | `critical` | `true` | Access Administration screens and modify firm reference lists, routing rules, org structure, and Home layouts |
| `rbac:manage_config` | `rbac` | `critical` | `true` | Modify tenant RBAC role mappings, department grants, relationship grants, and document generation security settings |
| `rbac:manage_user_overrides` | `rbac` | `critical` | `true` | Grant or revoke per-person permission overrides and modify another user's assigned roles |

### 2. Versioned Contract & Field Catalogue Integrity

- The Permission Registry is part of `@platform/core-api` and follows Section 6 and Section 7 of the Standard (strictly additive within a major version).
- Every `FieldCatalogueEntry.requiredPermission` must reference a valid `PermissionKey` in `PERMISSION_REGISTRY`. Automated unit/contract tests in `core/tests/contract.test.ts` fail CI if any catalogue entry references an unregistered permission key.

### 3. Single Permission Resolver (`resolvePermissions`)

We provide a single pure resolver in `core/src/domain/rbac/resolver.ts` (and exported from `@platform/core` and `@platform/core-api`):

```ts
export interface PermissionResolutionInput {
  context: TenantContext;
  config: TenantConfiguration;
  actorRecord?: {
    userId: string;
    roles?: readonly string[];
    departmentId?: string | null;
    permissionOverrides?: PersonPermissionOverrides | null;
    /** Transitional legacy override fields supported during migration */
    employeePermissions?: readonly EmployeePermission[] | null;
    documentPermissions?: readonly DocumentPermission[] | null;
  };
  relationships?: {
    /** Team IDs where actor is in team.leadIds */
    ledTeamIds?: readonly string[];
    /** Team member Person IDs across teams led by actor */
    teamMemberIdsOfLedTeams?: readonly string[];
    /** Person IDs whose lineManagerId === actor.userId */
    directReportPersonIds?: readonly string[];
    /** Target record context for relationship-scoped checks */
    targetPersonId?: string | null;
    targetTeamId?: string | null;
    targetMatter?: MatterAccessSubject | null;
  };
}
```

Resolution precedence (deterministic and side-effect-free):
1. **Authoritative Roles:** Resolved from `TenantContext.actorRoles` and `actorRecord.roles` via `rbac.identityMapping` ([ADR-0012](./0012-role-source-of-truth-and-entra-identity-mapping.md)). Never reads `activeViewingRole`, `jobTitle`, or display labels.
2. **Role Grants:** Union of permissions configured in `config.rbac.roles[roleKey].permissions` (falling back to core built-in role defaults).
3. **Department Grants:** Union of permissions configured in `config.rbac.departmentGrants[actorRecord.departmentId]`.
4. **Relationship Grants:** Union of permissions triggered by `config.rbac.relationshipGrants` (e.g., `is_team_lead_of_any_team` granting `employee:edit_core` and `employee:hr_restricted`, or target-scoped relationships when evaluating a specific target record).
5. **Per-Person Overrides ([ADR-0015](./0015-unified-per-person-permission-overrides.md)):**
   - Add `permissionOverrides.grant`.
   - Subtract `permissionOverrides.revoke` (**revoke always wins** over role, department, and relationship grants).
6. **MFA Gate for Enforcement (`hasPermission` / `requirePermission`):**
   - `resolvePermissions` computes both `effectivePermissions: ReadonlySet<PermissionKey>` (all granted permissions) and `mfaGatedPermissions: ReadonlySet<PermissionKey>` (permissions in `effectivePermissions` that require MFA when `context.mfaVerified !== true`).
   - `requirePermission(resolved, key)` throws a structured `AuthorisationError` (`code: 'FORBIDDEN'` if not in `effectivePermissions`, or `code: 'MFA_REQUIRED'` if `PERMISSION_REGISTRY[key].requiresMfa && !context.mfaVerified`).

### 4. Request-Scoped Caching and Shadow Mode

- **Request-Scoped Cache:** `resolvePermissions` results are memoized per `(tenantId, correlationId, actorUserId, targetKey)` within a single request/action execution so repeated checks incur zero overhead and never leak across requests or tenants.
- **Transitional Shadow Mode (`rbac.shadowMode`):** During rollout (Phase 2 PRs 2–3), a helper `resolvePermissionsWithShadowCheck` runs both the legacy resolvers (`resolveEmployeePermissions`, `resolveDocumentPermissions`, `canUserViewFinance`, `getLeftRailVisibility`, `canUserAccessMatter`) and the new `resolvePermissions`, logging a structured warning (`tenantId`, `correlationId`, `actorUserId`, `surface`, `legacyResult`, `newResult` — never PII) on any discrepancy.

## Consequences

- Every authorisation check across `core/` and `src/` uses one canonical registry and one resolver.
- Adding a new feature no longer introduces a parallel permission resolver or override field.
- MFA enforcement for high-privilege administrative actions (`document_template:approve`, `admin:access`, `rbac:manage_config`, `rbac:manage_user_overrides`, `finance:manage_links`) is declaratively defined in the registry and enforced centrally.
