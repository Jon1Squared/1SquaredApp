# ADR 0025: One Permission Enforcement Pattern for Server Actions and Routes

- **Date:** 2026-11-06
- **Status:** Accepted (6 November 2026)
- **Builds on:** [ADR 0010](./0010-central-permission-registry-and-resolver.md) (registry and resolver), [ADR 0013](./0013-viewing-as-role-presentation-only.md) (viewing-as is presentation only), [ADR 0014](./0014-staff-matter-access-by-permission.md) (restricted matters)
- **Roadmap:** Stage 0 decision D2, slice S0-02 (`docs/roadmap/stage-0-plan.md`); backlog gap P1

## Context

The host application has 106 exported server actions, all in `src/app/actions.ts`, and 7 API route handlers under `src/app/api/`. At commit `a0a5534`:

- **Every action checks only that someone is signed in** (`withActorId` or `withAuthenticatedActor`). Where a permission check exists, it is inside the service the action calls. The checks take several forms: core `requirePermission`, `hasPersonPermission` / `requirePersonPermission`, `hasDocumentPermission`, `hasKeyDatePermission` and `canPersonAccessMatter`.
- **53 actions call services that check no permission at all.** These include clearing all data, approving sign-offs, merging records and saving Admin settings. This is backlog gap P1.
- **Services report denial in at least five ways:** returning `{ errors }`, returning `{ ok: false, code }`, throwing `AuthorisationError`, or throwing a plain `Error` with a prefix.
- **`withActorId` passes on only the person ID.** Services that resolve permissions therefore treat MFA as unverified. This is harmless today only because `hasPermission` skips the MFA gate by default.
- **Nothing records which permission an action needs,** so a new action can ship without a check and nobody would notice.

## Decision

1. **One registry of policies for actions and routes.** `src/server/actionPermissions.ts` maps every server action name, and every route as `METHOD /api/path`, to one policy:
   - `{ kind: 'permission', key, enforcedBy: 'action' | 'service' }`: `key` is a `PermissionKey` from `PERMISSION_REGISTRY`, or `{ anyOf: [...] }`.
   - `{ kind: 'authenticated', reason }`: sign-in is enough (for example address lookup, or marking your own notifications read). A reason is required.
   - `{ kind: 'public', reason }`: only for the sign-in routes.
   - `{ kind: 'gap', slice }`: a known gap, part of the starting baseline, tagged with the stage 0 slice that closes it.

   The host registry lives in `src/`, because the actions do. Permission keys come only from the core registry, never from the duplicate union in `src/domain/types.ts`.

2. **One wrapper for actions and one for routes.** `guardedAction(name, fn)` and `guardedRoute(name, handler)` in `src/server/authorize.ts`:
   - authenticate the actor
   - build the `TenantContext` from the verified session only (architecture rule 4)
   - resolve permissions once per request, passing through `mfaVerified` and token roles
   - look up the policy and, when it is `enforcedBy: 'action'`, call core `requirePermission`, so MFA is enforced from the registry's `requiresMfa`
   - run `fn` with `{ personId, permissions, tenantContext }`, inside the existing active-actor session so that services keep working unchanged

   `activeViewingRole` is never an input (ADR 0013).

3. **Resource checks stay next to the data.** Matter access, the assigned partner and the no-self-approval rule all need the record, so they stay in the services. Services use one helper, `authorizeResource(permissions, resource)`, which wraps core `canAccessMatter` and is extended per record type. The action policy is the first gate and the resource check is the second.

4. **One denial shape.**
   - Actions return `ActionDenied = { ok: false, denied: true, code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'MFA_REQUIRED', message }` and never throw for a denial. Next.js hides thrown error messages in production builds.
   - Routes return 401 or 403 with `{ error, code }`.
   - Client components check with `isActionDenied(result)` and show the message.
   - Services raise `AuthorisationError`, and the wrapper converts it to `ActionDenied`.
   - Every denial is logged with the correlation ID, tenant ID, action name and code. It never includes personal data.

5. **A guard test that fails the build.** `src/server/__tests__/actionPermissionGuard.test.ts` reads the exports of `actions.ts` and the handlers in every `route.ts`. It fails when:
   - an export has no policy, or does not call `guardedAction` / `guardedRoute` with its own name
   - a policy names a permission key that isn't registered, or an action or route that doesn't exist
   - an `authenticated` or `public` policy has no reason
   - the number of `gap` entries exceeds `MAX_KNOWN_GAPS`, which starts at the baseline and may only go down

6. **New permission keys follow ADR 0010** (additive, versioned). Each one is added by the slice that first enforces it. Expected keys, with final names settled in each slice:
   - `quote:view`, `quote:edit`
   - `signoff:approve`
   - `enquiry:create`, `enquiry:edit`, `enquiry:assign`, `enquiry:close`, `enquiry:reopen`, `enquiry:anonymise`
   - `admin:data_reset` (MFA required)
   - `record:merge`
   - `task:edit`, `task:comment`

7. **Background jobs** call services through the same policies, using a system actor whose permissions are set by the job definition (decision D6).

## Alternatives Considered

- **Checks inside each service only (the current approach).** Rejected: the checks are invisible to review, and gaps go unnoticed.
- **Next.js middleware.** Rejected: it cannot see server action names or record context, and it runs on the edge runtime.
- **A custom ESLint rule instead of a test.** Rejected for now: there is no custom lint infrastructure. A test follows the existing source-scanning precedent (`core/tests/document-store.test.ts`, check R10) and can also check the registry and the gap count.

## Consequences

- Every action is listed against its permission, so a reviewer can see the whole surface in one file, and a new action cannot merge without a policy.
- Slices S0-03 to S0-07 and S0-10 close the gaps. Each one switches entries to `enforcedBy: 'action'`, lowers `MAX_KNOWN_GAPS`, and updates the affected screens to handle `ActionDenied`.
- Services may keep their own checks as defence in depth. Over time, `enforcedBy: 'service'` entries move to the wrapper.
- ADR 0010 was accepted alongside this decision (with an amendment making `core/src/domain/rbac/registry.ts` the authoritative list of permissions), because this pattern depends on its registry and `requirePermission`.
