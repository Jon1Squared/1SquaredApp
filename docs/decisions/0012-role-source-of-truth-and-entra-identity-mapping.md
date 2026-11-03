# ADR-0012: Authoritative Role Source of Truth, Unified `HomeRoleKey`, and Entra ID Identity Mapping

- **Date:** 2026-11-01
- **Status:** Accepted

## Context

Discovery identified four critical issues in how user roles are represented and resolved today:

1. **`HomeRoleKey` Mismatch between `core/` and `src/`:**
   - `src/domain/types.ts` (`BuiltInHomeRoleKey`) defines `'fee_earner' | 'partner' | 'legal_secretary' | 'enquiries_coordinator' | 'finance' | 'risk_compliance' | 'managing_partner' | 'admin'` (8 keys).
   - `core/src/api/index.ts` and `core/src/config-engine/index.ts` (`ALL_HOME_ROLE_KEYS`) define `'fee_earner' | 'supervisor' | 'partner' | 'legal_secretary' | 'intake' | 'finance' | 'risk_compliance' | 'managing_partner' | 'admin'` (9 keys, omitting `'enquiries_coordinator'`).
   - Because `normaliseActorHomeRoles` in `core/src/domain/document-generation/permissions.ts` filters `actor.roles` against `ALL_HOME_ROLE_KEYS`, users holding `'enquiries_coordinator'` (such as Lowri Thomas `P-000008`, Nia Edwards `P-000010`, Lowri Ellis, and demo user Ethel) have their role silently stripped when evaluating Document Generation permissions!
2. **Authorisation Derived from Free-Text `jobTitle` and Display Labels:**
   - `resolveEmployeeRoles` (`src/domain/homeConfig.ts`) derives role keys when `person.roles` is unset by substring-matching `person.jobTitle` (`'managing partner'`, `'compliance'`, `'mlro'`, `'colp'`, `'risk'`, `'credit control'`, `'cashier'`, `'finance'`, `'accounts'`, `'secretary'`, `'pa'`, `'legal assistant'`, `'intake'`, `'enquir'`, `'reception'`, `'partner'`).
   - `resolveUserAppRole` (`src/domain/tasks.ts`) and `canUserViewFinance` (`src/domain/pms.ts`) substring-match the mutable display label of `person.employeeRoleId` (`'system administrator'`, `'partner'`, `'practice manager'`, `'support staff'`).
3. **`practice_manager` vs `managing_partner` Discrepancy:**
   - The taxonomy item `employee_role.practice_manager` (label `"Practice manager"`) maps to `HomeRoleKey` `'managing_partner'` in `src/domain/homeConfig.ts`, which grants all 5 employee permissions in `resolveEmployeePermissions` (line 173), while line 184 separately checks `empRole === 'employee_role.practice_manager'` to grant only 3 permissions (`view_core`, `edit_core`, `hr_restricted`), and `docs/rbac-reference.md` refers to a non-existent `practice_manager` role key.
4. **Ambiguity Between Token Claims (`TenantContext.actorRoles`) and Stored `Person.roles`:**
   - Under `src/platform/tenantRuntime.ts` (ADR-0001 transitional bridge), `actorRoles` in `TenantContext` is populated from `resolveEmployeeRoles(user, store.teams)`, whereas in production Entra ID OIDC sign-in (Standard Section 9), the authenticated JWT carries app-role or group claims.

## Decision

### 1. Unify `BuiltInHomeRoleKey` Across `core/` and `src/`

- `ALL_HOME_ROLE_KEYS` in `core/src/api/index.ts`, `core/src/config-engine/index.ts`, and `src/domain/types.ts` is unified to the canonical 9 built-in keys:
  `'fee_earner' | 'supervisor' | 'partner' | 'legal_secretary' | 'intake' | 'enquiries_coordinator' | 'finance' | 'risk_compliance' | 'managing_partner' | 'admin'`.
- Both `'intake'` and `'enquiries_coordinator'` are valid built-in keys (with identical core default permissions), and tenant-defined custom role keys in `config.rbac.roles` are accepted without being stripped by `normaliseActorHomeRoles`.

### 2. Authoritative Role Source of Truth and `rbac.identityMapping`

Role resolution is controlled by `config.rbac.identityMapping.authorityMode`:
- **`'token_only'` (Production Federated Entra ID Mode):**
  - Authoritative roles come strictly from the verified Entra ID OIDC token claims (`roles` app-role claims and `groups` object IDs) mapped through `rbac.identityMapping.entraAppRoleToRoleKey` and `rbac.identityMapping.entraGroupToRoleKey` into `TenantContext.actorRoles`.
  - Stored `Person.roles` is synchronized as a read-only projection on sign-in for directory display and reporting, and cannot override token claims.
- **`'hybrid'` (Default for Federated Tenants with In-App Role Assignment):**
  - Union of Entra ID mapped token claims (`TenantContext.actorRoles`) and explicit stored `Person.roles` (validated against `config.rbac.roles`).
- **`'store_only'` (Transitional Local / Demo Mode per ADR-0001):**
  - Uses explicit `Person.roles` (or `EMPLOYEE_ROLE_TO_HOME_ROLE[person.employeeRoleId]` by immutable taxonomy ID if `Person.roles` is empty).

### 3. Eliminate Free-Text `jobTitle` and Display-Label Role Derivation

- `resolveEmployeeRoles` in `src/domain/homeConfig.ts` is refactored to resolve roles **only** from:
  1. Explicit `person.roles` (filtered to known keys in `config.rbac.roles`), or
  2. Immutable taxonomy ID mapping (`EMPLOYEE_ROLE_TO_HOME_ROLE[person.employeeRoleId]`) when `person.roles` is empty, plus
  3. Team-lead/partner relationship augmentation only where explicitly configured.
- Free-text `person.jobTitle` substring matching is **completely removed** from authorisation and role resolution. A data-hygiene migration script populates explicit `person.roles` on any person record that previously relied on `jobTitle` fallback before removing the fallback.
- Display-label `.includes(...)` checks in `resolveUserAppRole` and `canUserViewFinance` are **completely removed**.

### 4. Resolve the `practice_manager` Discrepancy

- Built-in `HomeRoleKey` identifiers are not renamed (`'managing_partner'` remains the built-in key).
- The dead/redundant `empRole === 'employee_role.practice_manager'` branch in `resolveEmployeePermissions` and references to `practice_manager` as a role key in `docs/rbac-reference.md` are cleaned up. If a tenant wants a separate Practice Manager role with only `view_core`, `edit_core`, and `hr_restricted` (without `payroll` or `sensitive`), they can define `"practice_manager"` as a custom role in `config.rbac.roles`.

## Consequences

- Editing a taxonomy display label or an employee's free-text `jobTitle` can never grant or revoke privileges.
- Users holding `'enquiries_coordinator'` are properly recognised by `@platform/core` permission resolution.
- Both single-tenant client Azure (Entra ID) and multi-tenant hosted deployments share one deterministic identity-to-role pipeline.
