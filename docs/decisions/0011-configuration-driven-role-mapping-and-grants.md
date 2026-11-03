# ADR-0011: Configuration-Driven Role Mapping, Department Grants, and Relationship Grants

- **Date:** 2026-11-01
- **Status:** Accepted
- **Supersedes:** Configuration schema aspects of [ADR-0004](./0004-document-permissions-and-finance-view.md)

## Context

Today, role-to-permission rules are split across:
- Hardcoded TypeScript branches in `src/domain/employment.ts` (`resolveEmployeePermissions`, including hardcoded department IDs `DEPT-HR`, `DEPT-FIN`, `DEPT-RISK`, `department.finance`, `department.risk_and_compliance`, and team lead checks).
- Hardcoded left-rail visibility rules in `src/domain/homeConfig.ts` (`getLeftRailVisibility`).
- `documentGeneration.permissions.roleDefaults` in `core/src/config-engine/index.ts` and `client-not-a-law-firm/config/base.json`.
- Mutable runtime Home roles stored in `store.homePagesConfig.roles` (`addHomeRole` in `src/server/services.ts`).

Section 4 and Section 9 of `docs/architecture-standard.md` forbid hardcoded tenant department IDs (`DEPT-*`) and hardcoded role-to-permission mappings in domain code, requiring schema-validated tenant configuration with backward-compatible deprecation (`Section 5` & `Section 7`).

## Decision

### 1. Schema-Validated `rbac` Section in `TenantConfiguration`

We add a top-level `rbac` section to `TenantConfiguration` (`core/src/api/index.ts`, `core/src/config-engine/index.ts`, and `core/schemas/tenant-config.schema.json`):

```ts
export type RelationshipRuleKey =
  | 'is_team_lead_of_any_team'
  | 'is_team_lead_of_target_team'
  | 'is_line_manager_of_target'
  | 'is_supporting_target_fee_earner';

export interface RbacRoleDefinition {
  key: string;
  label: string;
  shortLabel?: string;
  description?: string;
  isBuiltIn?: boolean;
  permissions: PermissionKey[];
}

export interface RbacRelationshipGrantRule {
  relationship: RelationshipRuleKey;
  permissions: PermissionKey[];
  description?: string;
}

export interface RbacIdentityMappingConfig {
  authorityMode: 'token_only' | 'hybrid' | 'store_only';
  entraGroupToRoleKey: Record<string, string[]>;
  entraAppRoleToRoleKey: Record<string, string[]>;
  requireMfaForAdminPermissions: boolean;
}

export interface RbacConfiguration {
  roles: Record<string, RbacRoleDefinition>;
  departmentGrants: Record<string, PermissionKey[]>;
  relationshipGrants: RbacRelationshipGrantRule[];
  identityMapping: RbacIdentityMappingConfig;
}
```

### 2. Core Built-In Role Defaults

The core ships 9 built-in role keys (`ALL_HOME_ROLE_KEYS`: `'fee_earner' | 'supervisor' | 'partner' | 'legal_secretary' | 'intake' | 'enquiries_coordinator' | 'finance' | 'risk_compliance' | 'managing_partner' | 'admin'`). Their default permission sets reproduce the baseline effective access matrix from Phase 1:

- **`admin`**: All permissions in `PERMISSION_REGISTRY`.
- **`managing_partner`**: All permissions (`employee:view_core`, `employee:edit_core`, `employee:hr_restricted`, `employee:payroll`, `employee:sensitive`, all `document_template:*`, all `document:*`, `finance:view`, `finance:view_matter`, `finance:credit_control`, `risk:view`, `matter:restricted:access`, `task:claim_any`, `task:reassign_any`, `admin:access`), excluding `rbac:manage_config`, `rbac:manage_user_overrides`, and `finance:manage_links` unless granted by tenant config.
- **`partner`**: `employee:view_core`, `employee:edit_core`, `employee:hr_restricted`, `document_template:view`, `document_template:approve`, `document_template:view_usage`, `document:generate`, `document:delete`, `finance:view`, `finance:view_matter`, `finance:credit_control`, `task:claim_any`, `task:reassign_any`, `admin:access`.
- **`risk_compliance`**: `employee:view_core`, `employee:hr_restricted`, `document_template:view`, `document_template:build`, `document_template:approve`, `document_template:view_usage`, `document:generate`, `finance:view_matter`, `risk:view`, `matter:restricted:access`.
- **`finance`**: `employee:view_core`, `employee:payroll`, `document:generate`, `finance:view`, `finance:view_matter`, `finance:credit_control`.
- **`fee_earner`**: `employee:view_core`, `document_template:view`, `document:generate`, `finance:view_matter`.
- **`supervisor`**: `employee:view_core`, `employee:edit_core`, `employee:hr_restricted`, `document_template:view`, `document:generate`, `finance:view_matter`, `task:claim_any`, `task:reassign_any`.
- **`legal_secretary`**: `employee:view_core`, `document_template:view`, `document:generate`, `finance:view_matter`.
- **`enquiries_coordinator`** (and alias **`intake`**): `employee:view_core`, `enquiry:intake_view` (plus any tenant-configured permissions such as `document_template:view` and `document:generate` in `client-not-a-law-firm`).

### 3. Moving `DEPT-*` from Core Code to Tenant Configuration (`rbac.departmentGrants`)

- All hardcoded checks for `DEPT-HR`, `DEPT-FIN`, `DEPT-RISK`, `department.finance`, and `department.risk_and_compliance` are removed from `src/domain/employment.ts`.
- In `client-not-a-law-firm/config/base.json` (and the default seeded tenant config for `Pembroke Vaughan`), `rbac.departmentGrants` maps:
  - `"DEPT-HR"`: `["employee:view_core", "employee:edit_core", "employee:hr_restricted", "employee:payroll", "employee:sensitive"]`
  - `"DEPT-FIN"` & `"department.finance"`: `["employee:view_core", "employee:payroll"]`
  - `"DEPT-RISK"` & `"department.risk_and_compliance"`: `["employee:view_core", "employee:hr_restricted"]`
- Similarly, `resolveDefaultDepartmentPartnerId` in `src/domain/employment.ts` (which hardcoded `DEPT-PC`, `DEPT-CORP`, `DEPT-EMP`, `DEPT-RISK` and person IDs `P-000001`..`P-000007`) is replaced by looking up the department's `headPersonId` from the tenant's `OrgStructureCatalogue` (`store.orgStructure.departments`) or team leads (`store.teams`), with zero hardcoded IDs in core/domain code.

### 4. Configurable Relationship Grants (`rbac.relationshipGrants`)

- Core default `rbac.relationshipGrants` includes:
  ```json
  [
    {
      "relationship": "is_team_lead_of_any_team",
      "permissions": ["employee:view_core", "employee:edit_core", "employee:hr_restricted", "task:claim_any", "task:reassign_any"],
      "description": "Team leads can manage core and HR-restricted employment fields and reassign/claim tasks."
    }
  ]
  ```
- Additional relationship rules (`is_line_manager_of_target`, `is_team_lead_of_target_team`, `is_supporting_target_fee_earner`) are supported in the schema and resolver so tenants can configure target-scoped relationship permissions without code changes.

### 5. Validation, Deprecation of `documentGeneration.permissions.roleDefaults`, and Audit Logging

- **Strict Validation:** `validateTenantConfiguration` rejects any unknown `PermissionKey` in `rbac.roles`, `rbac.departmentGrants`, or `rbac.relationshipGrants`, and rejects any unknown `availableToRoleKeys` on templates that is not in `Object.keys(config.rbac.roles)`.
- **Deprecation of `documentGeneration.permissions.roleDefaults`:**
  - `documentGeneration.permissions.roleDefaults` is marked `@deprecated` in `TenantConfiguration` and `core/schemas/tenant-config.schema.json`.
  - `client-not-a-law-firm/config/base.json` is migrated to `rbac.roles`.
  - If a tenant configuration still supplies `documentGeneration.permissions.roleDefaults`, `validateTenantConfiguration` emits a structured `deprecationWarnings` entry (`"documentGeneration.permissions.roleDefaults is deprecated and ignored when rbac.roles is present; remove before v1.0.0"`). During the v0.x transition, if a tenant omits `rbac.roles`, the config loader automatically projects `documentGeneration.permissions.roleDefaults` into `rbac.roles` so unmigrated configs never break.
- **Syncing Custom Roles with `FirmStore`:** When a custom role is defined in `rbac.roles` (or created via `addHomeRole` in transitional local mode), `rbac.roles` is the single source of truth for its permissions, while `HomePagesConfig.roles` stores only presentation layout (`headlineCardIds`, `primaryPanels`, `summaryPanels`).
- **Configuration Audit:** Every change to `rbac.*` or `documentGeneration.*` writes an immutable `AuditEntry` recording `tenantId`, `correlationId`, `actorUserId`, and JSON `oldValue` / `newValue`.

## Consequences

- Zero tenant-specific department IDs (`DEPT-*`) or person IDs (`P-00000*`) remain in `core/` or `src/domain/`.
- Tenants can customize role permissions, custom roles, department grants, and relationship grants purely via schema-validated configuration.
