# ADR-0013: "Viewing As" Role as Presentation Only and Permission-Driven Navigation

- **Date:** 2026-11-01
- **Status:** Proposed

## Context

In the current codebase, the Home page and top bar allow a multi-role user to switch their active `"Viewing as"` role (`activeViewingRole` / `lastViewingRoleByUserId`). Discovery revealed three security and architectural defects with how `"Viewing as"` and left-rail navigation work today:

1. **Privilege Escalation Bug in `switchViewingRoleAction` (`src/app/actions.ts` lines 555–566):**
   - When `switchViewingRole(userId, roleKey)` returns an error because the user does not hold `roleKey`, `switchViewingRoleAction` contains a fallback that **permanently adds `roleKey` to the user's stored `person.roles`** if `roleKey === 'risk_compliance' || roleKey === 'fee_earner'`. Any user can invoke this server action to grant themselves the `risk_compliance` role!
2. **UI Visibility Used as Access Control (`getLeftRailVisibility` in `src/domain/homeConfig.ts`):**
   - Left-rail visibility (`finance`, `risk`, `admin`, `enquiries`, `matters`, `contacts`) is computed primarily from `activeViewingRole` rather than the user's resolved `PermissionSet`.
   - In `getAppSnapshot` (`src/server/services.ts` lines 375–378), `canViewFinance` is computed as `canUserViewFinance(user, store.teams, store.values) || leftRailVisibility.finance || leftRailVisibility.risk`, coupling data access to the transient `"Viewing as"` selector.
   - Meanwhile, the server routes (`/finance`, `/risk`, `/admin`) and server actions (`saveListItemAction`, `saveOrgStructureAction`, `saveHomePagesConfigAction`, etc.) do not enforce server-side permissions at all—relying only on the left rail hiding the link.
3. **Need to Preserve Legitimate Presentation Switching:**
   - Multi-role users (e.g., a Partner who is also MLRO/Risk or a Legal Secretary who is also an Enquiries Coordinator) legitimately use `"Viewing as"` to switch their Home dashboard layout (`headlineCardIds`, `primaryPanels`, `summaryPanels`) and default list filter presets (`HomeClient.tsx`).

## Decision

### 1. `"Viewing As"` (`activeViewingRole`) Is Strictly Presentation-Only

- `activeViewingRole` may **only** control:
  1. Which `RoleHomeConfig` layout (headline cards, primary panels, summary panels, and default scope toggle) is rendered on the Home screen (`HomeClient.tsx`).
  2. Default filter/sort presets on list views (e.g., defaulting the Enquiries queue to intake view when viewing as `enquiries_coordinator`, or defaulting template picker highlights).
- `activeViewingRole` is **never** passed to `resolvePermissions`, `hasPermission`, `requirePermission`, data-redaction helpers, or API/action authorisation gates. Server-side authorisation always evaluates the user's full `PermissionSet`.

### 2. Remove Self-Role Mutation from `switchViewingRoleAction`

- The fallback in `src/app/actions.ts` (lines 555–566) that calls `updateEmployeeRolesAndSupports` when `switchViewingRole` fails is **deleted immediately**.
- `switchViewingRole` strictly verifies that `roleKey` is a member of the user's authoritative assigned roles (or that `demoMode` is explicitly enabled for a demo persona) and only updates `lastViewingRoleByUserId[userId]`.

### 3. Left-Rail Navigation and Route Guards Derived from `PermissionSet`

- `getLeftRailVisibility` is updated to derive access-gated navigation items from the user's resolved `PermissionSet` (`hasPermission`):
  - **Finance (`/finance`):** Requires `finance:view`.
  - **Risk (`/risk`):** Requires `risk:view`.
  - **Admin (`/admin`):** Requires `admin:access` (or `document_template:view` / `document_template:build` / `document_template:approve` for the Document Templates admin section).
  - **Enquiries (`/enquiries`), Tasks (`/tasks`), Matters (`/matters`), Contacts (`/organisations`, `/people`):** Visible based on core role/permission defaults, with `activeViewingRole` only affecting whether a multi-role user chooses a focused workspace layout in the UI—never granting a rail item the user's `PermissionSet` does not allow.
- Every server page/route (`/finance`, `/risk`, `/admin`, `/people/[id]/edit`, `/matters/[id]`) and every server action in `src/app/actions.ts` and `src/server/services.ts` enforces the corresponding permission via `requirePermission` on the server.

## Consequences

- Switching `"Viewing as"` in the UI can never grant or revoke server-side permissions or expose unauthorized data.
- The privilege escalation bug in `switchViewingRoleAction` is eliminated.
- UI navigation and server-side route/action enforcement are guaranteed to stay in sync because both read from `PermissionSet`.
