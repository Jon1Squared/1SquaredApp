# ADR-0015: Unified Per-Person Permission Overrides, Self-Modification Prevention, and MFA Controls

- **Date:** 2026-11-01
- **Status:** Proposed
- **Supersedes:** Override aspects of [ADR-0004](./0004-document-permissions-and-finance-view.md)

## Context

Today, the codebase has two incompatible per-person permission override mechanisms on `Person` (`src/domain/types.ts` lines 508–510):
1. **`Person.employeePermissions?: EmployeePermission[]`** (`src/domain/employment.ts` lines 160–162): Acts as a **full replacement**—when set to an array, `resolveEmployeePermissions` returns `user.employeePermissions` directly and ignores the user's roles, department, and team-lead status.
2. **`Person.documentPermissions?: DocumentPermission[]`** (`core/src/domain/document-generation/permissions.ts` lines 132–138): Acts as **additive only**—merged via set union with `roleDefaults`, with no way to revoke a default permission from a specific individual.

Furthermore, discovery revealed severe governance gaps around overrides and role assignments:
- In `savePersonRecord` (`src/server/services.ts` lines 1261–1275), `input.employeePermissions`, `input.appRole`, and `input.roles` are saved without checking whether the caller has administrative permission when `employmentSubmitted` is omitted, without blocking self-grant, and without writing a dedicated audit log entry for permission override changes.
- In `src/app/actions.ts`, `updateEmployeeRolesAndSupportsAction` and `updateEmployeeRoleAction` allow any caller to change any employee's `roles` or `employeeRoleId` (including their own) with no server-side permission or MFA check.

## Decision

### 1. Unified `Person.permissionOverrides` Model (`grant` and `revoke`)

We replace `Person.employeePermissions` and `Person.documentPermissions` with a single structured field on `Person` (and `TenantActor` in `@platform/core-api`):

```ts
export interface PersonPermissionOverrides {
  /** Explicit permissions granted to this person in addition to their role/department/relationship grants. */
  grant: PermissionKey[];
  /** Explicit permissions revoked from this person even if granted by their roles, department, or relationships. */
  revoke: PermissionKey[];
  /** Optional reason recorded when the override was last updated. */
  reason?: string;
  updatedAt?: string;
  updatedByUserId?: string;
}
```

- **Evaluation Rule in `resolvePermissions`:**
  1. Compute `basePermissions` = union of Role Grants + Department Grants + Relationship Grants.
  2. Add every key in `permissionOverrides.grant`.
  3. Remove every key in `permissionOverrides.revoke` (**`revoke` always wins** over `basePermissions` and `grant`).
- **Validation:** Every key in `grant` and `revoke` must be a valid `PermissionKey` in `PERMISSION_REGISTRY`. If the same key is passed in both `grant` and `revoke`, validation rejects the payload (or `revoke` takes precedence in read resolution).

### 2. Lossless Migration of Existing Overrides

To satisfy the rule that **no user may gain or lose access as a result of the refactor**:
- For any `Person` with `documentPermissions` set:
  - `permissionOverrides.grant` includes all keys from `documentPermissions`.
- For any `Person` with `employeePermissions` set (which was previously a full replacement):
  - Compute the person's `baseEmployeePermissions` from their roles, department, and relationships.
  - Any permission in `person.employeePermissions` not in `baseEmployeePermissions` is placed in `permissionOverrides.grant`.
  - Any permission in `baseEmployeePermissions` not in `person.employeePermissions` is placed in `permissionOverrides.revoke`.
  - This guarantees the person's effective employee permissions after migration are **bit-for-bit identical** to their effective permissions before migration.
- `Person.employeePermissions` and `Person.documentPermissions` are marked `@deprecated` on `Person`, projected automatically into `permissionOverrides` if encountered in legacy snapshots/tests during transition, and removed once all callers/tests migrate in Phase 2.

### 3. Strict Controls: Permission, MFA, No Self-Grant, No Granting Unheld Permissions, and Audit

Every server mutation that modifies a person's `permissionOverrides`, `roles`, `employeeRoleId`, or `appRole` (`savePersonRecord`, `updateEmployeeRolesAndSupports`, `updateEmployeeRole`, and dedicated override endpoints) must enforce all five security invariants on the server:

1. **Required Permission:** The acting user must hold `rbac:manage_user_overrides` (for `permissionOverrides` and `roles`/`appRole`) or `employee:edit_core` (only for non-privileged directory fields; changing security roles or overrides requires `rbac:manage_user_overrides`).
2. **Multi-Factor Authentication (`mfaVerified`):** Because `rbac:manage_user_overrides` has `requiresMfa: true` in `PERMISSION_REGISTRY`, `requirePermission` rejects the mutation with `MFA_REQUIRED` unless `TenantContext.mfaVerified === true`.
3. **No Self-Escalation:** An actor **cannot** add permissions to `permissionOverrides.grant`, remove permissions from `permissionOverrides.revoke`, or add roles to `roles` / change `employeeRoleId` / `appRole` on their **own** `Person` record (`actorUserId === targetPerson.id`).
4. **No Granting Permissions the Actor Does Not Hold:** An actor cannot add a `PermissionKey` to another user's `permissionOverrides.grant` (or assign a role granting that `PermissionKey`) unless the actor themselves holds that `PermissionKey` in their effective `PermissionSet`.
5. **Mandatory Immutable Audit Entry:** Every change to `permissionOverrides`, `roles`, `employeeRoleId`, or `appRole` writes a dedicated `AuditEntry` recording `tenantId`, `correlationId`, `actorUserId`, `targetPersonId`, `oldValue` (JSON of prior roles/overrides), `newValue` (JSON of new roles/overrides), and `reason`.

## Consequences

- Per-person overrides work identically across employee, document, finance, risk, task, and admin permissions, supporting both exceptions (`grant`) and restrictions (`revoke`).
- Self-privilege escalation via `savePersonRecord`, `updateEmployeeRolesAndSupportsAction`, or `updateEmployeeRoleAction` is blocked on the server.
- Existing users with `employeePermissions` or `documentPermissions` retain their exact effective permissions after migration.
