# 1Squared — Central Configuration-Driven RBAC Reference

This document is the authoritative reference for Role-Based Access Control (RBAC), permissions, tenant configuration, overrides, and record-level access rules across `@platform/core` and the 1Squared host application.

Related Architecture Decision Records:
- [ADR-0010: Central Permission Registry and Single Resolver](./decisions/0010-central-permission-registry-and-resolver.md)
- [ADR-0011: Configuration-Driven Role Mapping, Department Grants, and Relationship Grants](./decisions/0011-configuration-driven-role-mapping-and-grants.md)
- [ADR-0012: Role Source of Truth and Entra ID Identity Mapping](./decisions/0012-role-source-of-truth-and-entra-identity-mapping.md)
- [ADR-0013: "Viewing As" Role Strictly for Presentation](./decisions/0013-viewing-as-role-presentation-only.md)
- [ADR-0014: Dynamic Staff-Matter Access by Permission](./decisions/0014-staff-matter-access-by-permission.md)
- [ADR-0015: Unified Per-Person Permission Overrides (`grant` / `revoke`)](./decisions/0015-unified-per-person-permission-overrides.md)
- [ADR-0016: `AppRole` Transition and Retirement](./decisions/0016-approle-transition-and-retirement.md)
- [ADR-0017: Document Store Provider Abstraction](./decisions/0017-document-store-provider-abstraction.md)
- [ADR-0018: Two-Identity Authentication Model](./decisions/0018-two-identity-authentication-model.md)
- [ADR-0019: Inheritance-Based Document Permission Model](./decisions/0019-inheritance-based-document-permission-model.md)
- [ADR-0020: Document References and Zero-Content Storage](./decisions/0020-document-references-and-zero-content-storage.md)
- [ADR-0021: Matter Folder Template Inheritance Model](./decisions/0021-matter-folder-template-inheritance-model.md)
- [ADR-0025: One Permission Enforcement Pattern for Server Actions and Routes](./decisions/0025-permission-enforcement-pattern.md)

---

## 1. Central Permission Registry (`PERMISSION_REGISTRY`)

Defined in `core/src/domain/rbac/registry.ts` and exported from `@platform/core`.
Every permission uses the `resource:action` naming convention, carries a sensitivity classification (`standard | confidential | restricted | critical`), and states whether multi-factor authentication (`requiresMfa`) is required.

| Permission Key | Domain | Sensitivity | Requires MFA | Description |
| :--- | :--- | :--- | :--- | :--- |
| `employee:view_core` | `employee` | `standard` | No | View core employee directory and business contact fields |
| `employee:edit_core` | `employee` | `restricted` | No | Create and edit core employment, team membership, and line management fields |
| `employee:hr_restricted` | `employee` | `confidential` | No | View/edit HR-restricted employment fields (contracts, right-to-work, emergency contacts) |
| `employee:payroll` | `employee` | `confidential` | No | View/edit payroll, salary, bank details, NI number, tax code, and pension fields |
| `employee:sensitive` | `employee` | `critical` | No | View/edit diversity monitoring and reasonable adjustments (`EmployeeSensitiveRecord`) |
| `document_template:view` | `document_template` | `standard` | No | View document templates, versions, and placeholder mappings |
| `document_template:build` | `document_template` | `restricted` | No | Upload `.docx` templates, map placeholders, configure prompted fields, submit drafts |
| `document_template:approve` | `document_template` | `critical` | **Yes** | Approve/reject submitted template versions, retire templates, roll back versions |
| `document_template:view_usage` | `document_template` | `standard` | No | View aggregate template usage dashboards and retirement candidates |
| `document_template:view_usage_by_user` | `document_template` | `confidential` | No | View/export per-user template usage breakdowns (when `showUserLevelDetail` is enabled) |
| `document:generate` | `document` | `standard` | No | Preview and generate documents from active templates on accessible matters/clients |
| `document:view` | `document` | `standard` | No | View and download generated documents on accessible matters/clients |
| `document:delete` | `document` | `restricted` | No | Delete saved generated documents from a matter or client record (audited) |
| `document:download` | `document` | `standard` | No | Download or open matter documents from the connected external document store (under the user's delegated Entra identity) |
| `document:upload` | `document` | `standard` | No | Upload documents and create folders in a matter's connected external document store |
| `document:edit` | `document` | `standard` | No | Rename, move, or co-author documents in a matter's connected external document store |
| `document:provision` | `document` | `restricted` | No | Retry matter folder provisioning or link an existing external document store folder to a matter |
| `document_store:configure` | `document` | `critical` | **Yes** | Configure tenant document stores, SharePoint site/library connections, routing rules, and Entra group mappings |
| `document_template:configure` | `document` | `restricted` | No | Configure tenant matter folder templates and work-type folder inheritance |
| `document_access:review` | `document` | `restricted` | No | View and remediate document store permission reconciliation findings |
| `finance:view` | `finance` | `restricted` | No | Access firm-wide Finance workspace, billing/aged-debt queues, and Financial merge fields |
| `finance:view_matter` | `finance` | `standard` | No | View matter/client financial tabs, WIP, client balances, and financial attention alerts |
| `finance:credit_control` | `finance` | `restricted` | No | Record credit control chase actions, request matter bills, and flag write-offs |
| `finance:manage_links` | `finance` | `critical` | **Yes** | Link or unlink Practice Management System (PMS) client and matter codes |
| `risk:view` | `risk` | `restricted` | No | Access Risk & Compliance workspace, CDD/AML oversight queues, and conflict overrides |
| `matter:create` | `matter` | `standard` | No | Create and open new matters, including draft conflict checks and enquiry/quote conversions |
| `matter:edit` | `matter` | `standard` | No | Edit matter details, participants, conflict check records, and commercial fields on accessible matters |
| `matter:reassign_ownership` | `matter` | `restricted` | No | Change the owning department or owning team/practice group on an existing matter (re-permissioning linked document store folders) |
| `matter:restricted:access` | `matter` | `confidential` | No | Oversight access to restricted staff matters (`isStaffMatter`) and linked documents |
| `matter:restriction:lift` | `matter` | `restricted` | **Yes** | Lift a staff-matter or information-barrier restriction on a matter with a mandatory audited reason |
| `matter:costs:sign_off` | `matter` | `restricted` | No | Sign off matter fee estimates that exceed the configured partner cost sign-off threshold |
| `task:claim_any` | `task` | `standard` | No | Take or claim unassigned tasks across any team |
| `task:reassign_any` | `task` | `restricted` | No | Reassign tasks across any user or team |
| `enquiry:intake_view` | `enquiry` | `standard` | No | Default to the intake/call-handler view and workflow on the Enquiries queue |
| `admin:access` | `admin` | `critical` | **Yes** | Access Administration screens and modify lists, routing rules, org structure, and Home layouts |
| `rbac:manage_config` | `rbac` | `critical` | **Yes** | Modify tenant RBAC role mappings, department/relationship grants, and security settings |
| `rbac:manage_user_overrides` | `rbac` | `critical` | **Yes** | Grant/revoke per-person permission overrides and modify another user's security roles |
| `keydate:view` | `keydate` | `standard` | No | View key dates on accessible matters and enquiries, and view own teams' diaries |
| `keydate:view_any_team` | `keydate` | `restricted` | No | Select and view any team diary and access the compliance exceptions report |
| `keydate:edit` | `keydate` | `standard` | No | Create, edit, propose, supersede, and mark key dates as not applicable on accessible matters and enquiries |
| `keydate:verify` | `keydate` | `restricted` | No | Perform second-person verification (confirm or reject) on proposed key dates where the user is not the proposer |
| `keydate:resolve` | `keydate` | `standard` | No | Resolve key dates as met or missed and acknowledge key date reminder stages |
| `keydate:waive` | `keydate` | `restricted` | No | Waive a key date with an audited reason |
| `keydate:override_calculation` | `keydate` | `restricted` | No | Override a rule-calculated limitation or key date with a mandatory audited reason |
| `keydate:configure` | `keydate` | `critical` | **Yes** | Configure key date types, matter type rules, reminder schedules, limitation rule sets, and business calendars |

### Field Catalogue Contract
Every entry in `CORE_FIELD_CATALOGUE` (`core/src/domain/document-generation/fieldCatalogue.ts`) declares a `requiredPermission: PermissionKey`. A contract test in `core/tests/rbac.test.ts` verifies at CI time that every catalogue field's `requiredPermission` is registered in `PERMISSION_REGISTRY`.

---

## 2. Built-In Roles & Default Permission Matrix (`DEFAULT_RBAC_ROLES`)

Built-in `HomeRoleKey` identifiers are stable across tenants:

| `HomeRoleKey` | Immutable `employeeRoleId` | Default Label | Default Permissions |
| :--- | :--- | :--- | :--- |
| `admin` | `employee_role.system_administrator` | System Administrator | All 45 permissions |
| `managing_partner` | `employee_role.practice_manager` | Managing Partner / Practice Manager | All permissions except `finance:manage_links`, `enquiry:intake_view`, `rbac:manage_config`, `rbac:manage_user_overrides`, `keydate:configure` |
| `partner` | `employee_role.partner` | Partner / Head of Department | `employee:view_core`, `employee:edit_core`, `employee:hr_restricted`, `document_template:view`, `document_template:view_usage`, `document_template:configure`, `document:generate`, `document:view`, `document:download`, `document:upload`, `document:edit`, `document:delete`, `document:provision`, `finance:view`, `finance:view_matter`, `finance:credit_control`, `matter:create`, `matter:edit`, `matter:reassign_ownership`, `matter:costs:sign_off`, `task:claim_any`, `admin:access`, `keydate:view`, `keydate:edit`, `keydate:verify`, `keydate:resolve`, `keydate:waive`, `keydate:override_calculation` |
| `risk_compliance` | `employee_role.risk_and_compliance` | Risk & Compliance (MLRO / COLP) | `employee:view_core`, `employee:edit_core`, `employee:hr_restricted`, `employee:sensitive`, `document_template:view`, `document_template:approve`, `document_template:view_usage`, `document_template:configure`, `document:generate`, `document:view`, `document:download`, `document:upload`, `document:edit`, `document:delete`, `document:provision`, `document_access:review`, `finance:view_matter`, `risk:view`, `matter:edit`, `matter:restricted:access`, `matter:restriction:lift`, `keydate:view`, `keydate:view_any_team`, `keydate:verify` |
| `finance` | `employee_role.finance` | Finance / Accounts / Credit Control | `employee:view_core`, `employee:payroll`, `document_template:view`, `document:generate`, `document:view`, `document:download`, `document:upload`, `finance:view`, `finance:view_matter`, `finance:credit_control` |
| `fee_earner` | `employee_role.fee_earner` | Fee Earner | `employee:view_core`, `document_template:view`, `document:generate`, `document:view`, `document:download`, `document:upload`, `document:edit`, `finance:view_matter`, `matter:create`, `matter:edit`, `keydate:view`, `keydate:edit`, `keydate:resolve` |
| `supervisor` | `employee_role.supervisor` | Team Supervisor | `employee:view_core`, `employee:edit_core`, `employee:hr_restricted`, `document_template:view`, `document:generate`, `document:view`, `document:download`, `document:upload`, `document:edit`, `document:delete`, `document:provision`, `finance:view_matter`, `matter:create`, `matter:edit`, `matter:reassign_ownership`, `task:claim_any`, `task:reassign_any`, `keydate:view`, `keydate:edit`, `keydate:verify`, `keydate:resolve`, `keydate:waive` |
| `legal_secretary` | `employee_role.support_staff` | Legal Secretary / PA / Support Staff | `employee:view_core`, `document_template:view`, `document:generate`, `document:view`, `document:download`, `document:upload`, `document:edit`, `document:provision`, `matter:create`, `matter:edit`, `keydate:view`, `keydate:edit` |
| `enquiries_coordinator` | `employee_role.enquiries_coordinator` | Enquiries Coordinator | `employee:view_core`, `document_template:view`, `document:generate`, `document:view`, `document:download`, `matter:create`, `enquiry:intake_view` |
| `intake` | `employee_role.intake` | Intake / Call Handler | `employee:view_core`, `document_template:view`, `document:generate`, `document:view`, `document:download`, `enquiry:intake_view` |

---

## 3. Tenant RBAC Configuration (`rbac.*`)

Configured per tenant in `client-<slug>/config/base.json` and validated by `core/src/config-engine/index.ts` against `core/schemas/tenant-config.schema.json`:

- `rbac.roles`: Built-in roles (starting from `DEFAULT_RBAC_ROLES`) plus optional tenant-defined custom roles.
- `rbac.departmentGrants`: Maps tenant department IDs (e.g. `DEPT-HR`, `DEPT-FIN`, `DEPT-RISK`) to additional `PermissionKey[]`. Core ships `{}` (zero hardcoded department IDs in core code).
- `rbac.relationshipGrants`: Configurable relationship grant rules (`team_lead_of_any_team`, `team_lead_of_target_team`, `line_manager_of_target`, `supporting_target_fee_earner`).
- `rbac.identityMapping`: Configures `authorityMode` (`token_only | hybrid | store_only`), `entraGroupToRoleKey`, `entraAppRoleToRoleKey`, and `requireMfaForAdminPermissions`.

### Deprecation of `documentGeneration.permissions.roleDefaults`
- `documentGeneration.permissions.roleDefaults` is **deprecated** (`ADR-0011`) and replaced by `rbac.roles`.
- If a tenant configuration still includes `documentGeneration.permissions.roleDefaults`, `collectConfigDeprecationWarnings` / `validateTenantConfigWithWarnings` emits a structured deprecation warning, and `resolvePermissions` reads `rbac.roles`.

---

## 4. Single Resolver & Precedence Order (`resolvePermissions`)

Implemented in `core/src/domain/rbac/resolver.ts` (and bridged for host entities in `src/domain/rbac.ts`).

### Precedence Order
1. **Role Grants:** Union of permissions from all of the user's authoritative role keys (`rbac.roles[roleKey].permissions`). Never uses `activeViewingRole`.
2. **Department Grants:** Union of permissions from `rbac.departmentGrants[user.departmentId]`.
3. **Relationship Grants:** Applicable rules from `rbac.relationshipGrants` (e.g., team lead or line manager of target).
4. **Per-Person Additive Grants:** `person.permissionOverrides.grant`.
5. **Per-Person Explicit Revocations (Highest Precedence):** `person.permissionOverrides.revoke` removes any permission granted by steps 1–4.

---

## 5. Unified Per-Person Overrides (`Person.permissionOverrides`)

- Stored on `Person.permissionOverrides?: { grant: PermissionKey[]; revoke: PermissionKey[]; reason?: string; updatedByUserId?: string; updatedAt?: string }`.
- Validated by `validateUserOverrideOrRoleMutation`:
  1. Actor must hold `rbac:manage_user_overrides` with `mfaVerified: true`.
  2. Self-modification (`actorUserId === targetPersonId`) is always rejected (`SELF_MODIFICATION_FORBIDDEN`).
  3. Actor cannot grant a permission or role containing a permission they do not themselves hold (`PRIVILEGE_ESCALATION_FORBIDDEN`).
- Legacy `Person.employeePermissions` (replacement) and `Person.documentPermissions` (additive) are migrated losslessly via `migrateLegacyPersonOverrides`.

---

## 6. "Viewing As" (`activeViewingRole`) Isolation

- Switching `"Viewing as"` only changes Home page layout and left-rail focus (`resolveActiveViewingRole` / `getLeftRailVisibility`).
- Non-admin users may switch `"Viewing as"` only between their own authoritative assigned roles (`userRoles`). Users holding the built-in `admin` role (`canPreviewAnyHomeRole(userRoles)`) may select any configured Home role (`homePagesConfig.roles`) to preview its layout.
- Preview is strictly presentation-only: it never mutates `Person.roles`, never affects `resolvePermissions`, and can never reveal `finance`, `risk`, or `admin` navigation items or widen data access if the user's authoritative `PermissionSet` lacks `finance:view`, `risk:view`, or `admin:access`. Every API endpoint and server action enforces its own permission check.

---

## 7. Dynamic Staff-Matter & Linked-Document Access (`canAccessMatter`)

- When an active firm employee is a client on a matter (`isStaffMatter: true`), `computeStaffMatterStatus` populates `restrictedAccessUserIds` **only** with the named matter participants (`responsiblePartnerId`, `supervisingPartnerId`, `leadFeeEarnerId`, `teamMemberIds`).
- Oversight access is evaluated dynamically via `matter:restricted:access` (`risk_compliance`, `managing_partner`, `admin`), so role changes take effect immediately without stale stored user IDs.
- Generated documents linked to a restricted staff matter inherit the restriction on both Matter and Client (`person` / `organisation`) screens via `canActorAccessGeneratedDocument`.

---

## 8. Default Relationship Grants (`DEFAULT_RBAC_RELATIONSHIP_GRANTS`)

In addition to role-based grants, the RBAC engine evaluates relationship rules (`relationshipGrants`) when resolving permissions:

| Relationship Key | Default Granted Permissions | Description |
|---|---|---|
| `is_team_lead_of_any_team` | `employee:view_core`, `employee:edit_core`, `task:claim_any`, `keydate:view`, `keydate:edit`, `keydate:verify`, `keydate:resolve`, `keydate:waive` | Team leads and line managers can view and edit core employment records, claim unassigned tasks, and verify/manage key dates. Does **not** grant `matter:reassign_ownership` (which is restricted to `supervisor`, `partner`, `managing_partner`, and `admin`). |
| `is_line_manager_of_target` | `employee:view_core`, `employee:edit_core` | Line managers and supervising partners can view and edit core employment records. |

---

## 9. Enforcing permissions in actions and routes (`src/server/authorize.ts` & `src/server/actionPermissions.ts`)

Per [ADR-0025](./decisions/0025-permission-enforcement-pattern.md), every server action in `src/app/actions.ts` and every HTTP method exported from `src/app/api/**/route.ts` goes through the central wrappers in `src/server/authorize.ts` and has a declarative policy in `src/server/actionPermissions.ts`:

- **Policy Registry (`src/server/actionPermissions.ts`):**
  - `ACTION_PERMISSIONS`: maps each exported server action name to `{ kind: 'permission', key, enforcedBy: 'action' | 'service' }`, `{ kind: 'authenticated', reason }`, or `{ kind: 'gap', slice }`.
  - `ROUTE_PERMISSIONS`: maps each `<METHOD> /api/...` route handler to `{ kind: 'permission', key, enforcedBy: 'action' | 'service' }`, `{ kind: 'public', reason }`, or `{ kind: 'gap', slice }`.
  - `MAX_KNOWN_GAPS`: locks the maximum count of `gap` entries so new actions cannot ship without a permission policy and the baseline gap count can only decrease as Stage 0 slices S0-03 to S0-07 and S0-10 close them.
- **Action & Route Wrappers (`src/server/authorize.ts`):**
  - `guardedAction(name, fn)` authenticates the actor from the verified Entra ID session, resolves `TenantContext` via `resolveCurrentTenantContext`, resolves the actor's `ResolvedPermissionSet` with the session's real `mfaVerified` state and token roles, and runs `fn` inside `runWithActiveActorSession`.
  - When a policy has `enforcedBy: 'action'`, `guardedAction` enforces the required permission via `@platform/core` `requirePermission` (including MFA gates where `requiresMfa: true`), logs any denial with `correlationId`, `tenantId`, `action`, and `code` (never personal data), and returns `ActionDenied` (`{ ok: false, denied: true, code, message, error }` in `src/domain/actionResult.ts`) without calling `fn`.
  - `guardedRoute(name, handler)` wraps route handlers and passes Next.js route context (`params`) through to the handler.
  - `authorizeResource(permissions, resource)` wraps `@platform/core` `canAccessMatter` for second-gate record-level access checks in services.
- **Static Guard Test (`src/server/__tests__/actionPermissionGuard.test.ts`):**
  - Scans `src/app/actions.ts` and `src/app/api/**/route.ts` on every test run and fails if any export is missing from `ACTION_PERMISSIONS` / `ROUTE_PERMISSIONS`, does not call `guardedAction` / `guardedRoute` with its own name, references an unregistered permission key, omits a reason on an `authenticated` or `public` entry, or exceeds `MAX_KNOWN_GAPS`.


