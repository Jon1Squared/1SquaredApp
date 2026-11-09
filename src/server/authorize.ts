import 'server-only';

/**
 * Central authorisation wrappers for server actions, API routes, and resources
 * (`src/server/authorize.ts`, ADR 0025 / Slice S0-02).
 */

// Central authorisation wrappers
import { NextResponse } from 'next/server';
import {
  AuthorisationError,
  canAccessMatter,
  requirePermission,
  type MatterAccessRecord,
  type PermissionKey,
  type ResolvedPermissionSet,
  type TenantContext,
} from '@platform/core';
import { buildActionDenied, type ActionDenied } from '@/domain/actionResult';
import { runWithActiveActorSession } from '@/domain/rbac';
import {
  getActiveTenantConfiguration,
  resolveCurrentTenantContext,
} from '@/platform/tenantRuntime';
import {
  ACTION_PERMISSIONS,
  ROUTE_PERMISSIONS,
  type ActionPolicy,
  type PolicyPermissionRequirement,
  type RegisteredActionName,
  type RegisteredRouteName,
} from './actionPermissions';
import { createVerifiedSessionActorFromEntraSession } from './entraAuth';
import { resolveRequestCorrelationId } from './correlationId';
import {
  emitTenantTelemetryEvent,
  resolveCurrentRequestCorrelationId,
} from './telemetry';
import { resolvePersonPermissionSet } from './rbacRuntime';
import {
  requireAuthenticatedActor,
  type AuthenticatedActorContext,
} from './services';
import { getStore } from './store';

export interface GuardedActorContext extends AuthenticatedActorContext {
  readonly tenantContext: TenantContext;
  readonly permissions: ResolvedPermissionSet;
}

export type AuthorizableResource =
  | {
      readonly kind: 'matter';
      readonly matter: MatterAccessRecord | null | undefined;
    }
  | (MatterAccessRecord & { readonly kind?: 'matter' });

function logAuthorisationDenial(params: {
  correlationId: string;
  tenantId: string;
  action: string;
  code: string;
  requiredPermission?: string;
}): void {
  emitTenantTelemetryEvent({
    eventName: 'authorisation.denied',
    severity: 'warn',
    tenantId: params.tenantId,
    correlationId: resolveRequestCorrelationId(
      params.correlationId,
      'corr-auth',
    ),
    properties: {
      action: params.action,
      code: params.code,
      ...(params.requiredPermission
        ? { requiredPermission: params.requiredPermission }
        : {}),
    },
  });
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'authorisation.denied',
      correlationId: params.correlationId,
      tenantId: params.tenantId,
      action: params.action,
      code: params.code,
      ...(params.requiredPermission
        ? { requiredPermission: params.requiredPermission }
        : {}),
    }),
  );
}

export function requirePermissionForPolicy(
  permissions: ResolvedPermissionSet,
  requirement: PolicyPermissionRequirement,
  actionName: string,
): ResolvedPermissionSet {
  if (typeof requirement === 'string') {
    return requirePermission(permissions, requirement, actionName);
  }
  const candidates = requirement.anyOf;
  if (candidates.length === 0) {
    throw new Error(`Policy for "${actionName}" has an empty anyOf array.`);
  }
  if (!permissions.actorUserId) {
    return requirePermission(permissions, candidates[0], actionName);
  }
  const grantedCandidates = candidates.filter((perm) =>
    permissions.permissions.has(perm),
  );
  if (grantedCandidates.length === 0) {
    return requirePermission(permissions, candidates[0], actionName);
  }
  const satisfiedCandidate = grantedCandidates.find(
    (perm) => !permissions.mfaPendingPermissions.has(perm),
  );
  if (satisfiedCandidate) {
    return permissions;
  }
  return requirePermission(permissions, grantedCandidates[0], actionName);
}

function mapAuthorisationErrorToActionDenied(
  err: AuthorisationError,
): ActionDenied {
  const mappedCode: ActionDenied['code'] =
    err.code === 'UNAUTHENTICATED' || err.code === 'MFA_REQUIRED'
      ? err.code
      : 'FORBIDDEN';
  return buildActionDenied(mappedCode, err.message);
}

function buildGuardedActorContext(
  actor: AuthenticatedActorContext,
  correlationId: string,
): GuardedActorContext {
  const tenantCfg = getActiveTenantConfiguration();
  const verifiedActor = createVerifiedSessionActorFromEntraSession(
    actor.session,
    { correlationId },
  );
  const tenantContext = resolveCurrentTenantContext(verifiedActor, tenantCfg);
  const store = getStore();
  const permissions = resolvePersonPermissionSet(actor.person, {
    allPeople: store.people,
    teams: store.teams,
    tenantId: tenantContext.tenantId,
    context: tenantContext,
    mfaVerified: tenantContext.mfaVerified,
    tokenRoles: tenantContext.actorRoles,
  });

  return {
    ...actor,
    tenantId: tenantContext.tenantId,
    mfaVerified: tenantContext.mfaVerified,
    tenantContext,
    permissions,
  };
}

/**
 * Wraps a server action with policy lookup, authentication, `TenantContext`
 * resolution from verified session claims, and central permission resolution.
 *
 * - When `policy` is `{ kind: 'permission', enforcedBy: 'action' }`, enforces
 *   the required permission via `@platform/core` `requirePermission` and maps
 *   any `AuthorisationError` (including `UNAUTHENTICATED`, `FORBIDDEN`, and
 *   `MFA_REQUIRED`) to `ActionDenied` without calling `fn`.
 * - During the Stage 0 transition, for `enforcedBy: 'service'`, `authenticated`,
 *   and `gap` policies, `guardedAction` still requires sign-in, resolves the
 *   session's real `mfaVerified` state into the active actor session, and lets
 *   service return values and thrown errors pass through unchanged (ADR 0025 §4).
 */
export async function guardedAction<R>(
  name: RegisteredActionName,
  fn: (actor: GuardedActorContext) => Promise<R> | R,
): Promise<R> {
  const policy = (
    ACTION_PERMISSIONS as Record<string, ActionPolicy | undefined>
  )[name];
  if (!policy) {
    throw new Error(
      `UNREGISTERED_ACTION_POLICY: Server action "${name}" has no entry in ACTION_PERMISSIONS.`,
    );
  }

  const correlationId = await resolveCurrentRequestCorrelationId('corr-act');
  const isEnforcedByAction =
    policy.kind === 'permission' && policy.enforcedBy === 'action';

  let actor: AuthenticatedActorContext;
  try {
    actor = await requireAuthenticatedActor();
  } catch (err) {
    if (err instanceof AuthorisationError) {
      logAuthorisationDenial({
        correlationId,
        tenantId: err.tenantId || getActiveTenantConfiguration().tenantId,
        action: name,
        code: err.code,
        requiredPermission: err.requiredPermission,
      });
      if (isEnforcedByAction) {
        return mapAuthorisationErrorToActionDenied(err) as unknown as R;
      }
    }
    throw err;
  }

  return runWithActiveActorSession(
    {
      tenantId: actor.tenantId,
      personId: actor.personId,
      tokenRoles: actor.session.mappedRoles,
      mfaVerified: actor.mfaVerified,
      expiresAtMs: new Date(actor.session.expiresAt).getTime(),
      verifiedSession: actor.session,
    },
    async () => {
      const guardedActor = buildGuardedActorContext(actor, correlationId);

      if (isEnforcedByAction) {
        try {
          requirePermissionForPolicy(
            guardedActor.permissions,
            policy.key,
            name,
          );
          return await fn(guardedActor);
        } catch (err) {
          if (err instanceof AuthorisationError) {
            logAuthorisationDenial({
              correlationId: guardedActor.tenantContext.correlationId,
              tenantId: guardedActor.tenantContext.tenantId,
              action: name,
              code: err.code,
              requiredPermission: err.requiredPermission,
            });
            return mapAuthorisationErrorToActionDenied(err) as unknown as R;
          }
          throw err;
        }
      }

      return await fn(guardedActor);
    },
  );
}

/**
 * Wraps a Next.js App Router route handler (`GET`, `POST`, etc.) with policy
 * lookup and passes the route context (`params`) through to `handler`.
 *
 * - For `enforcedBy: 'service'`, `gap`, and `public` policies, delegates
 *   directly to `handler(request, context)` so existing route-specific
 *   401/403 bodies, `x-correlation-id` headers, and structured logs remain
 *   unchanged during the Stage 0 transition (ADR 0025 §4 / AG6).
 * - For `enforcedBy: 'action'` policies, authenticates the actor, resolves
 *   `TenantContext` and `ResolvedPermissionSet`, enforces the permission with
 *   `requirePermission`, and returns 401/403 JSON on denial.
 */
export function guardedRoute<
  Req extends Request = Request,
  Ctx = unknown,
  Res extends Response = Response,
>(
  name: RegisteredRouteName,
  handler: (
    request: Req,
    context: Ctx,
    actor?: GuardedActorContext,
  ) => Promise<Res> | Res,
): (request?: Req, context?: Ctx) => Promise<Res> {
  return async (request?: Req, context?: Ctx): Promise<Res> => {
    const policy = (
      ROUTE_PERMISSIONS as Record<string, ActionPolicy | undefined>
    )[name];
    if (!policy) {
      throw new Error(
        `UNREGISTERED_ROUTE_POLICY: Route "${name}" has no entry in ROUTE_PERMISSIONS.`,
      );
    }

    const isEnforcedByAction =
      policy.kind === 'permission' && policy.enforcedBy === 'action';

    if (!isEnforcedByAction) {
      return await handler(request as Req, context as Ctx);
    }

    const correlationId = resolveRequestCorrelationId(
      request?.headers?.get('x-correlation-id'),
      'corr-rte',
    );
    try {
      const actor = await requireAuthenticatedActor();
      return await runWithActiveActorSession(
        {
          tenantId: actor.tenantId,
          personId: actor.personId,
          tokenRoles: actor.session.mappedRoles,
          mfaVerified: actor.mfaVerified,
          expiresAtMs: new Date(actor.session.expiresAt).getTime(),
          verifiedSession: actor.session,
        },
        async () => {
          const guardedActor = buildGuardedActorContext(actor, correlationId);
          requirePermissionForPolicy(
            guardedActor.permissions,
            policy.key,
            name,
          );
          return await handler(request as Req, context as Ctx, guardedActor);
        },
      );
    } catch (err) {
      if (err instanceof AuthorisationError) {
        logAuthorisationDenial({
          correlationId,
          tenantId: err.tenantId || getActiveTenantConfiguration().tenantId,
          action: name,
          code: err.code,
          requiredPermission: err.requiredPermission,
        });
        const status = err.code === 'UNAUTHENTICATED' ? 401 : 403;
        return NextResponse.json(
          {
            ok: false,
            denied: true,
            code: err.code,
            message: err.message,
            error: `${err.code}: ${err.message}`,
          },
          { status },
        ) as unknown as Res;
      }
      throw err;
    }
  };
}

/**
 * Resource-level authorisation helper for service-layer checks (ADR 0025 §3).
 * Wraps `@platform/core` `canAccessMatter` and throws `AuthorisationError`
 * (`FORBIDDEN`) when the actor cannot access the target record.
 */
export function authorizeResource(
  permissions: ResolvedPermissionSet,
  resource: AuthorizableResource | null | undefined,
): void {
  if (!resource) {
    throw new AuthorisationError({
      code: 'FORBIDDEN',
      message: 'Requested resource was not found or is not accessible.',
      tenantId: permissions.tenantId,
      correlationId: permissions.correlationId,
      actorUserId: permissions.actorUserId,
    });
  }

  const matterRecord: MatterAccessRecord | null | undefined =
    'matter' in resource ? resource.matter : resource;

  if (!matterRecord || !canAccessMatter(permissions, matterRecord)) {
    throw new AuthorisationError({
      code: 'FORBIDDEN',
      message: 'You do not have permission to access this matter.',
      tenantId: permissions.tenantId,
      correlationId: permissions.correlationId,
      actorUserId: permissions.actorUserId,
      requiredPermission: 'matter:restricted:access' as PermissionKey,
    });
  }
}
