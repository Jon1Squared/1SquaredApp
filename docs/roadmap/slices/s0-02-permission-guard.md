# S0-02: Permission enforcement pattern, registry and guard

| | |
|---|---|
| Backlog | P1 |
| Decision | D2, [ADR 0025](../../decisions/0025-permission-enforcement-pattern.md). **Accepted** 6 November 2026, together with ADR 0010 (amended). |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0A |
| Branch | `s0-02-permission-guard`, targeting `develop` |
| Change class | Host security infrastructure; no new feature. Layer: `src/server` and `src/app`. Uses core `requirePermission` and `PERMISSION_REGISTRY` without changing them. |
| Size | M |
| Depends on | No other slice. |
| Blocking manual tasks | None. |
| Baseline | `fix/testing-fixes`, commit `a0a5534` |

## What exists today

- **Actions:** 106 exported server actions, all in `src/app/actions.ts`. Every one wraps `withActorId` (`actions.ts:149`) or `withAuthenticatedActor` (`src/server/services.ts:378`), which check only that someone is signed in.
  - About 52 actions call services that check a permission. Examples: matters (`services.ts:2992–3091`), key dates, document generation, RBAC and Home admin, and HR reveals.
  - `savePersonAction` checks permissions only when employment data is sent, and copies roles and permission overrides from the request (B11). It counts as a gap, closed in S0-03.
  - About 53 actions call services that check none. Examples: data reset and clear, sign-off approve and discuss, merge, Admin saves, tasks, enquiries, quotes, PMS links. Some of these are self-scoped, for example notifications.
- **Routes:** 7 API route files with 10 exported handlers: `GET` on auth login, auth callback and document download; `GET` and `POST` on auth logout (its `GET` returns 405), document stores and matter documents; `POST` on matter extraction.
  - `api/matters/extract` checks only sign-in.
  - The document routes check permissions inside their services.
  - The auth routes are public by design.
- **Helpers:**
  - Core: `requirePermission`, `hasPermission`, `AuthorisationError` and `canAccessMatter` in `core/src/domain/rbac/resolver.ts`, and `PERMISSION_REGISTRY` in `core/src/domain/rbac/registry.ts`.
  - Host: `resolvePersonPermissionSet`, `hasPersonPermission` and `requirePersonPermission` in `src/server/rbacRuntime.ts`, and `resolveCurrentTenantContext` in `src/platform/tenantRuntime.ts:509`.
- **Gaps in the plumbing:**
  - `withActorId` passes on only the person ID, so services resolve permissions with MFA treated as unverified.
  - No list maps actions to permissions, and no test enumerates the actions.

## Files

- **`src/server/authorize.ts`** (new, `server-only`):
  - Provides `guardedAction(name, fn)`, `guardedRoute(name, handler)` and `authorizeResource(permissions, resource)`.
  - Builds the `TenantContext` from the verified session through `resolveCurrentTenantContext`.
  - Resolves permissions with `resolvePersonPermissionSet`, passing `mfaVerified` and `tokenRoles`.
  - Enforces `enforcedBy: 'action'` policies with core `requirePermission`, and maps `AuthorisationError` to `ActionDenied` **only for those policies**. For `enforcedBy: 'service'`, `authenticated` and `gap` policies, and for a missing session, it keeps today's behaviour: service results and thrown errors pass through unchanged (review finding AG5).
  - `guardedRoute` passes the Next.js route context (`params`) through to the handler. For routes whose checks are in their services (document stores, matter documents, document download), it keeps their existing 401/403 bodies, `x-correlation-id` headers and structured logs (AG6).
  - Logs each denial with correlation ID, tenant ID, action name and code, and no personal data.
  - Runs `fn` inside the existing `runWithActiveActorSession`, so services work unchanged.
- **`src/domain/actionResult.ts`** (new; safe to import from client components): the `ActionDenied` type, `{ ok: false, denied: true, code, message, error }`, where `error` is `` `${code}: ${message}` `` so existing screens and tests that read `error` keep working, and `isActionDenied()`.
- **`src/domain/rbac.ts`:** in `resolvePersonPermissionSet` (line 389), when no `mfaVerified` or context is passed and the user is the active session's actor, read `mfaVerified` from the active verified session instead of defaulting to `false`. This applies the real MFA state to the actions whose services resolve permissions themselves (AG2).
- **`src/server/actionPermissions.ts`** (new): a policy for every action and route method (types per ADR 0025).
  - **`gap`:** each action whose service checks nothing, plus `POST /api/matters/extract`. Each is tagged with the slice that closes it:
    - S0-03: data reset and clear, sign-off approve and discuss, enquiry anonymisation, compliance reminder, person save (B11)
    - S0-04: lists and choice values, custom fields, teams, enquiry and task settings, org structure, party taxonomy, matter costs config and rate sync, PMS links
    - S0-05: tasks, enquiries (save, assign, contact log, email, close, reopen), organisation save, links, notes, duplicates and merge, leaver reassignment, quotes
    - S0-06: AI extraction
    - S0-07: enquiry and quote conversion
    - S0-10: bill request, write-off and credit-control actions (matter access only today)
  - **`permission` with `enforcedBy: 'service'`:** the actions whose services already check, with the key they check (documents, key dates, matters, RBAC and Home admin, HR reveals).
  - **`authenticated` with a reason:** marking own notifications read (two actions), `switchViewingRoleAction` (role membership only, ADR 0013), and the demo persona switch (demo mode only).
  - **`public` with a reason:** the three auth routes.
  - **`MAX_KNOWN_GAPS`:** set to the exact gap count when building. It is expected to be about 52.
- **`src/app/actions.ts`:** replace `withActorId(fn)` and `withAuthenticatedActor(fn)` with `guardedAction('<exportName>', fn)` in all 106 exports. This is mechanical, and every signature stays the same.
- **`src/app/api/**/route.ts`** (7 files, 10 handlers): wrap each exported method in `guardedRoute('<METHOD> /api/…', …)`, including logout's `GET` (still 405).
- **Pilot conversion:** move `updateTenantRbacConfigAction` to `enforcedBy: 'action'`. Its service already calls `requirePermission('rbac:manage_config')` at `services.ts:8700`. Its service already returns `{ ok: false, code, error }` rather than throwing, and `ActionDenied` keeps the same `code` and `error`, so the Admin screen (`RbacAdminSection.tsx`) and test R53 keep working. This proves the path end to end without changing behaviour.
- **Documentation:**
  - `docs/rbac-reference.md`: a new section, "Enforcing permissions in actions and routes".
  - `src/docs/articles/authentication-rbac-and-mfa.ts`: a short "How access is enforced" paragraph. Mention only permission keys already in `PERMISSION_REGISTRY`: test R10 in `core/tests/document-store.test.ts` fails on any backticked key that isn't registered. New keys are documented by the slices that add them (AG11).
  - `CLAUDE.md` and `AGENTS.md`, "Roles and permissions": add "Every server action and API route uses `guardedAction` / `guardedRoute` and has a policy in `src/server/actionPermissions.ts`."
  - `docs/release-notes.md`.
  - `docs/roadmap/feature-list.md`: P1 "What exists" gains the registry, guard and baseline. The status stays Partly built.

## Tests

**`src/server/__tests__/actionPermissionGuard.test.ts`** (static source scan, following the precedent in `core/tests/document-store.test.ts`, check R10). It fails when:
- an `actions.ts` export has no policy
- an export does not call `guardedAction('<its own name>'`
- a route method has no policy, or does not use `guardedRoute`
- a policy names an unregistered permission key, or an action or route that doesn't exist
- the number of `gap` entries exceeds `MAX_KNOWN_GAPS`
- an `authenticated` or `public` policy has no reason

A fixture-string case proves that the guard catches an unlisted action.

**`src/server/__tests__/authorize.test.ts`** (runtime; uses `setTestEntraSessionOverride` and `setActiveTenantConfigForTesting`):
- no session gives `UNAUTHENTICATED`, and `fn` is not called
- a missing permission gives `FORBIDDEN`, and `fn` is not called
- an MFA-required key with `mfaVerified: false` gives `MFA_REQUIRED`
- a viewing-as role or `previewRole` never grants a permission
- the tenant context comes from the session, and a `tenantId` passed in arguments is ignored (forged tenant claim)
- `gap` and `enforcedBy: 'service'` policies still require sign-in, and otherwise behave exactly as before, including thrown errors
- a service that resolves permissions without passing `mfaVerified` sees the session's real MFA state
- `guardedRoute` passes `params` through, and the matter documents route's existing 401/403 responses are unchanged
- the denial log contains no name or email address

**No regressions:** the existing `rbac`, `isolation`, `entra-auth`, `home`, key dates and document generation suites pass unchanged.

## Acceptance criteria

1. All 106 actions and all 10 route handlers go through the wrappers and have a policy. The guard test fails for any new action without one.
2. The baseline lists exactly the known gaps, each tagged with the slice that closes it, and `MAX_KNOWN_GAPS` equals that count. It can only go down.
3. Permissions are resolved with the session's real `mfaVerified` value.
4. No user-visible behaviour changes. The pilot action returns `ActionDenied` with the same `code` and `error` as today.
5. `npm run ci` passes.
6. The developer docs, help article and release notes are updated (ADR 0025 is already accepted).

## Pull request description must state

- **Change class:** host security infrastructure.
- **Both hosting models:** the tenant always comes from the verified session, and nothing depends on the hosting mode.
- **Migration and rollback:** no data migration. Roll back by reverting the PR.
- **Gap baseline:** the gap list and its owning slices.
