# ADR-0016: Transition and Retirement of `AppRole`

- **Date:** 2026-11-01
- **Status:** Accepted

## Context

The codebase currently has a four-value `AppRole` type (`'admin' | 'team_lead' | 'fee_earner' | 'call_handler'`) defined in `src/domain/types.ts` and resolved by `resolveUserAppRole` in `src/domain/tasks.ts` (lines 120–140).

Discovery found that `AppRole` is used in only five places across the entire application:
1. **Task Reassignment (`canUserReassignTask` in `src/domain/tasks.ts`):** Checks `role === 'admin'` or team lead of the task's team or current assignee.
2. **Task Claiming (`canUserTakeTask` in `src/domain/tasks.ts`):** Checks `role === 'admin' || role === 'team_lead'` or member of the task's team.
3. **Enquiries Default View (`defaultEnquiryViewForUser` in `src/domain/enquiries.ts`):** Checks `role === 'call_handler'`, `'team_lead'`, `'admin'`, or `'fee_earner'` to pick the initial filter tab on `/enquiries`.
4. **Finance Visibility (`canUserViewFinance` in `src/domain/pms.ts`):** Checks `appRole === 'call_handler'` or `empRoleLabel.includes('support staff')` to deny finance visibility.
5. **PMS Link/Unlink Buttons in UI (`MatterFinanceTab.tsx` and `ClientFinanceSection.tsx`):** Checks `currentUserRole === 'admin'` to show/hide PMS code linking controls.

Meanwhile, `resolveUserAppRole` derives `AppRole` by checking `user.appRole`, whether the user is in any `team.leadIds`, or whether the display label of `user.employeeRoleId` includes `'system administrator'`, `'partner'`, `'practice manager'`, or `'support staff'`. Having `AppRole` alongside `HomeRoleKey` and `PermissionKey` creates confusion over which role type governs authorisation.

## Decision

### 1. Replace All Access-Control Uses of `AppRole` with Granular Permissions

Each access decision previously gated by `AppRole` is replaced by a permission check from `PERMISSION_REGISTRY` ([ADR-0010](./0010-central-permission-registry-and-resolver.md)):
1. **Task Reassignment (`canUserReassignTask`):** Checks `hasPermission(perms, 'task:reassign_any')` OR actor is current assignee OR actor is team lead of the task's assigned team (`team.leadIds.includes(userId)`).
2. **Task Claiming (`canUserTakeTask`):** Checks `hasPermission(perms, 'task:claim_any')` OR actor is current assignee OR actor is a member/lead of the task's assigned team.
3. **PMS Link/Unlink (`linkPmsRecord`, `unlinkPmsRecord`, `MatterFinanceTab.tsx`, `ClientFinanceSection.tsx`):** Checks `hasPermission(perms, 'finance:manage_links')` on both the server and UI.
4. **Finance Visibility (`canUserViewFinance`):** Replaced by `hasPermission(perms, 'finance:view_matter')` (for matter/client finance tabs) and `hasPermission(perms, 'finance:view')` (for firm-wide `/finance` workspace and `financial.*` document merge fields).
5. **Enquiries Default View (`defaultEnquiryViewForUser`):** Uses `hasPermission(perms, 'enquiry:intake_view')` and team-lead membership (`isUserTeamLead`) for presentation filter defaults.

### 2. Transitional Compatibility & Deprecation of `AppRole`

- During Phase 2, `resolveUserAppRole` is kept as a `@deprecated` compatibility shim for any UI badge or legacy test that still reads `snap.currentUserRole`, but its implementation is rewritten to derive `AppRole` purely from resolved permissions and team-lead relationships (**zero display-label `.includes(...)` matching**):
  - `hasPermission(perms, 'admin:access')` (with `'admin'` role) → `'admin'`
  - `teams.some(t => t.active && t.leadIds.includes(user.id))` → `'team_lead'`
  - `hasPermission(perms, 'enquiry:intake_view') && !hasPermission(perms, 'finance:view_matter')` → `'call_handler'`
  - Otherwise → `'fee_earner'`
- `Person.appRole` and `AppRole` are marked `@deprecated` in `src/domain/types.ts` and scheduled for removal once all UI props (`currentUserRole`) are replaced by `currentUserPermissions` in Phase 2 PR 5.

## Consequences

- Display-label matching (`'system administrator'`, `'partner'`, `'practice manager'`, `'support staff'`) in `resolveUserAppRole` is eliminated immediately.
- Task claiming, task reassignment, PMS linking, finance tabs, and enquiry intake defaults are governed by explicit, configurable permissions in `rbac.roles` and `rbac.relationshipGrants`.
- The redundant `AppRole` layer is cleanly retired.
