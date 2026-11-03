# ADR-0004: Document Generation Permissions and Introduction of `finance:view`

- **Date:** 2026-04-20
- **Status:** Superseded by [ADR-0010](./0010-central-permission-registry-and-resolver.md), [ADR-0011](./0011-configuration-driven-role-mapping-and-grants.md), [ADR-0012](./0012-role-source-of-truth-and-entra-identity-mapping.md), [ADR-0013](./0013-viewing-as-role-presentation-only.md), [ADR-0014](./0014-staff-matter-access-by-permission.md), and [ADR-0015](./0015-unified-per-person-permission-overrides.md)

> **Supersedence Note (2026-11-01):** This ADR remains the historical record of how Document Generation permissions (`document:*`, `document_template:*`, and `finance:view`), `resolveDocumentPermissions`, `Person.documentPermissions`, and `documentGeneration.permissions.roleDefaults` were originally introduced. Under the Central Configuration-Driven RBAC refactor:
> - All permissions (`document:*`, `document_template:*`, `employee:*`, `finance:*`, `risk:*`, `admin:*`, `rbac:*`, `matter:restricted:access`, `task:*`, `enquiry:*`) are consolidated into a single core **Permission Registry** and resolved by a single **`resolvePermissions`** function ([ADR-0010](./0010-central-permission-registry-and-resolver.md)).
> - `documentGeneration.permissions.roleDefaults` is **deprecated** in favour of `rbac.roles` ([ADR-0011](./0011-configuration-driven-role-mapping-and-grants.md)).
> - `Person.documentPermissions` (additive) and `Person.employeePermissions` (full replacement) are replaced by unified `Person.permissionOverrides: { grant, revoke }` ([ADR-0015](./0015-unified-per-person-permission-overrides.md)).
> - Restricted staff-matter access (`canActorAccessMatterRecord`) transitions from stored role holders in `restrictedAccessUserIds` to the dynamic `matter:restricted:access` permission plus named matter participants ([ADR-0014](./0014-staff-matter-access-by-permission.md)).

## Context

The platform currently implements Role-Based Access Control across four layers (documented in `docs/rbac-reference.md`):

1. **Home Role Keys (`HomeRoleKey`):** `'fee_earner' | 'supervisor' | 'partner' | 'legal_secretary' | 'intake' | 'enquiries_coordinator' | 'finance' | 'risk_compliance' | 'managing_partner' | 'admin'`, plus tenant-configured roles.
2. **Task/Routing `AppRole`:** `'admin' | 'team_lead' | 'fee_earner' | 'call_handler'`.
3. **Granular Employee Permissions (`EmployeePermission`):** `'employee:view_core' | 'employee:edit_core' | 'employee:hr_restricted' | 'employee:payroll' | 'employee:sensitive'`.
4. **Restricted Staff Matters:** `matter.isStaffMatter` and `matter.restrictedAccessUserIds`.

Notably, financial access in the existing codebase is controlled only via left-rail visibility (`getLeftRailVisibility` in `src/domain/homeConfig.ts`) and `canUserViewFinance` (`src/domain/pms.ts`), rather than a named `resource:action` permission token.

For Basic Document Generation, Section 9 of `docs/architecture-standard.md` and the architectural brief require explicit `resource:action` permissions in the core, mapped to client roles via configuration, enforced on every server action/API route, and respecting restricted staff matters and active vs. full role assignments.

## Decision

### 1. New Core Permission Tokens (`DocumentPermission`)

We define the following canonical permission tokens in `@platform/core-api` (`core/src/api/index.ts`):

| Permission Token | Purpose | Default Built-In Roles |
|---|---|---|
| `'document_template:view'` | View templates, versions, and field mappings in the template library | `admin`, `managing_partner`, `partner`, `risk_compliance`, `fee_earner`, `supervisor`, `legal_secretary` |
| `'document_template:build'` | Upload `.docx` templates, map placeholders, configure prompted fields, create new draft versions, export/import template packages, and submit drafts for approval | `admin`, `managing_partner`, `risk_compliance` |
| `'document_template:approve'` | Approve or reject submitted template versions, retire active templates, and roll back to a prior approved version | `admin`, `managing_partner`, `partner`, `risk_compliance` |
| `'document_template:view_usage'` | View aggregate template usage dashboards, 30/90-day metrics, low-use retirement candidates, and blocked-field diagnostics | `admin`, `managing_partner`, `partner`, `risk_compliance` |
| `'document_template:view_usage_by_user'` | View and export per-user template usage breakdowns (only when `documentGeneration.usage.showUserLevelDetail` is also `true`) | `admin`, `managing_partner` |
| `'document:generate'` | Preview and generate documents from active templates on accessible matters and clients | `admin`, `managing_partner`, `partner`, `fee_earner`, `supervisor`, `legal_secretary`, `risk_compliance`, `finance` |
| `'document:delete'` | Delete a saved generated document from a matter or client (subject to audit logging) | `admin`, `managing_partner`, `partner` |
| `'finance:view'` | View and merge `Financial` group fields (`financial.*`) in the field chooser, preview, and document generation | `finance`, `partner`, `managing_partner`, `admin` |

### 2. Tenant-Configurable Role Mapping (`documentGeneration.permissions.roleDefaults`)

Under Section 9 of the Standard (*"RBAC is defined in the core; clients map their own roles to core permissions through configuration"*):

- `core/src/config-engine/index.ts` and `core/schemas/tenant-config.schema.json` include `documentGeneration.permissions.roleDefaults`, mapping each permission token to an array of role keys (`HomeRoleKey` or tenant-defined role keys).
- If a tenant does not override `roleDefaults`, the core defaults in the table above apply.
- Additionally, `Person.documentPermissions?: DocumentPermission[]` allows explicit per-person permission overrides on top of role defaults, mirroring `Person.employeePermissions`.

### 3. Resolution Against Full `Person.roles` vs. Active "Viewing As" Role

- **Server-side Authorisation (`resolveDocumentPermissions` / `hasDocumentPermission`):** Always evaluates the user's **full assigned role set** (`resolveEmployeeRoles(user, teams)` / `ctx.actorRoles`) plus any explicit `user.documentPermissions` overrides, never the transient UI `activeViewingRole`. A partner who temporarily switches their Home "Viewing as" selector to `fee_earner` does not lose server-side permission, nor can a user escalate privileges by manipulating a client-side role parameter.
- **Template Availability Filtering:** When a template specifies `availableToRoleKeys: string[]` (optional restriction of which roles see the template in the generation picker), a template is available if `availableToRoleKeys` is empty/unset OR intersects with the user's assigned roles. In the UI, the picker defaults to highlighting templates relevant to the user's `activeViewingRole` with a toggle to show all templates available across all of their assigned roles.

### 4. Restricted Staff Matter Enforcement (`isStaffMatter`)

- No user—even with `document:generate` or `document_template:build`—may preview, generate, list, or download a document linked to a restricted staff matter (`matter.isStaffMatter === true`) unless `canUserAccessMatter(matter, user.id, user)` returns `true` (i.e., `user.id` is in `matter.restrictedAccessUserIds` or the user holds an authorised oversight role `'admin' | 'managing_partner' | 'risk_compliance'`).
- In the Template Builder's **Test Preview** selector, restricted staff matters are filtered out for any builder who does not pass `canUserAccessMatter`.

### 5. `finance:view` Enforcement Across Field Chooser, Preview, and Generation

- When a template builder without `finance:view` opens the Field Catalogue chooser, `Financial` group fields are shown as locked/disabled with an explanatory badge (`Requires finance:view`) or hidden from value preview.
- When a user generates or previews a template that contains `financial.*` placeholders:
  - If the generating user lacks `finance:view`, generation is blocked before rendering if any `financial.*` placeholder is marked `required`, or resolved to the mapping's `fallbackText` / redacted placeholder if optional, and a `'blocked_permission'` usage event is recorded when blocked.

## Consequences

- `finance:view` establishes a clean, reusable core permission token that aligns with the existing left-rail finance roles (`finance`, `partner`, `managing_partner`, `admin`) and can be adopted incrementally by other financial endpoints in future refactors.
- All document generation and template management operations are protected by server-side permission checks in both `@platform/core` and the Next.js server boundary.
