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
  isJobOnlyPermissionKey,
  loadActiveTenantRegistry,
  requirePermission,
  sanitizeJobErrorCode,
  sanitizeJobSummaryCounts,
  type MatterAccessRecord,
  type PermissionKey,
  type RbacConfiguration,
  type ResolvedPermissionSet,
  type TenantContext,
  type TenantRegistry,
  type TenantRegistryEntry,
} from '@platform/core';
import { buildActionDenied, type ActionDenied } from '@/domain/actionResult';
import {
  getActiveActorSession,
  runWithActiveActorSession,
} from '@/domain/rbac';
import {
  getActiveTenantConfiguration,
  getHrAndRbacRepository,
  getPartyRepository,
  resolveCurrentTenantContext,
  resolveJobTenantContext,
} from '@/platform/tenantRuntime';
import {
  ACTION_PERMISSIONS,
  JOB_PERMISSIONS,
  ROUTE_PERMISSIONS,
  type ActionPolicy,
  type JobPolicy,
  type PolicyPermissionRequirement,
  type RegisteredActionName,
  type RegisteredJobName,
  type RegisteredRouteName,
} from './actionPermissions';
import { createVerifiedSessionActorFromEntraSession } from './entraAuth';
import { resolveRequestCorrelationId } from './correlationId';
import {
  emitTenantTelemetryEvent,
  emitTenantTelemetryException,
  resolveCurrentRequestCorrelationId,
} from './telemetry';
import {
  getDefaultTenantRbacConfig,
  mergeRbacConfigOverlay,
  resolvePersonPermissionSet,
} from './rbacRuntime';
import {
  requireAuthenticatedActor,
  type AuthenticatedActorContext,
} from './services';
import type { Person, Team } from '@/domain/types';

export interface GuardedActorContext extends AuthenticatedActorContext {
  readonly tenantContext: TenantContext;
  readonly permissions: ResolvedPermissionSet;
  readonly rbacConfig: RbacConfiguration;
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
  // Telemetry must never change the outcome of a denial: if the emitter throws
  // (for example on an empty tenant), the caller still gets the original 401/403 (R432).
  try {
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
  } catch (telemetryError) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'telemetry.emit_failed',
        correlationId: params.correlationId,
        tenantId: params.tenantId,
        action: params.action,
        errorName:
          telemetryError instanceof Error ? telemetryError.name : 'Error',
      }),
    );
  }
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

export async function buildGuardedActorContext(
  actor: AuthenticatedActorContext,
  correlationId: string,
): Promise<GuardedActorContext> {
  const tenantCfg = getActiveTenantConfiguration();
  const verifiedActor = createVerifiedSessionActorFromEntraSession(
    actor.session,
    { correlationId },
  );
  const tenantContext = resolveCurrentTenantContext(verifiedActor, tenantCfg);
  const [allPeople, teams, rbacOverride] = await Promise.all([
    actor.allPeople
      ? Promise.resolve([...actor.allPeople])
      : getPartyRepository().listAllPeople<Person>(tenantContext),
    actor.teams
      ? Promise.resolve([...actor.teams])
      : getHrAndRbacRepository().listAllTeams<Team>(tenantContext),
    getHrAndRbacRepository().getRbacConfigOverride<RbacConfiguration>(
      tenantContext,
    ),
  ]);
  const baseRbacConfig = getDefaultTenantRbacConfig(tenantContext.tenantId);
  const effectiveRbacConfig = rbacOverride
    ? mergeRbacConfigOverlay(baseRbacConfig, rbacOverride)
    : baseRbacConfig;
  const activeSession = getActiveActorSession();
  if (activeSession && activeSession.tenantId === tenantContext.tenantId) {
    activeSession.effectiveRbacConfig = effectiveRbacConfig;
  }
  const permissions = resolvePersonPermissionSet(actor.person, {
    allPeople,
    teams,
    config: { rbac: effectiveRbacConfig },
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
    rbacConfig: effectiveRbacConfig,
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
      const guardedActor = await buildGuardedActorContext(actor, correlationId);

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
          const guardedActor = await buildGuardedActorContext(actor, correlationId);
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

export interface GuardedJobExecutionContext {
  readonly jobKey: RegisteredJobName;
  readonly tenantEntry: TenantRegistryEntry;
  readonly tenantContext: TenantContext;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface GuardedJobOptions {
  readonly registry?: TenantRegistry;
  readonly timeoutMs?: number;
  readonly correlationId?: string;
  /**
   * Optional override strictly for negative tests verifying that `guardedJob`
   * rejects missing or non-jobOnly `jobPermissions` on the minted `TenantContext`.
   */
  readonly overrideJobPermissions?: readonly PermissionKey[];
  /**
   * Optional override strictly for negative tests verifying that `guardedJob`
   * rejects a non-system actor identity (`actorSub`).
   */
  readonly overrideActorSub?: string;
}

export type GuardedJobTenantTarget =
  | string
  | Pick<TenantRegistryEntry, 'tenantId'> & Partial<TenantRegistryEntry>;

function resolveJobRegistryOrFallback(
  providedRegistry?: TenantRegistry,
): TenantRegistry {
  if (providedRegistry) {
    return providedRegistry;
  }
  try {
    return loadActiveTenantRegistry();
  } catch {
    const activeCfg = getActiveTenantConfiguration();
    const slug = activeCfg.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    return {
      schemaVersion: '1.0',
      environment: activeCfg.environment,
      hostingMode: activeCfg.hostingMode,
      tenants: [
        {
          tenantId: activeCfg.tenantId,
          slug,
          environment: activeCfg.environment,
          enabled: true,
          postgresHost:
            activeCfg.database?.dedicatedServerHost ??
            `${activeCfg.tenantId}-pg-${activeCfg.environment}.postgres.database.azure.com`,
          postgresDatabaseName: `pg_tenant_${slug}_${activeCfg.environment}`,
          postgresRoleName: `role_tenant_${slug}_${activeCfg.environment}`,
          keyVaultUri:
            activeCfg.keyVault?.vaultUri ??
            `https://kv-${activeCfg.tenantId}-${activeCfg.environment}.vault.azure.net/`,
          packageDir: 'client-not-a-law-firm',
          timeZone: activeCfg.timeZone || 'Europe/London',
        },
      ],
    };
  }
}

/**
 * Central background job authorisation and per-tenant execution guard
 * (`src/server/authorize.ts`, ADR 0030 §3 / Slice S0-19).
 *
 * Confined strictly to CLI job entry points (`scripts/run-job.ts`) and job sweep
 * runners; never exposed as a web route or server action.
 *
 * 1. Verifies `jobKey` is registered in `JOB_PERMISSIONS` with a `jobOnly: true` permission.
 * 2. Verifies the target tenant is registered and `enabled === true` in the active
 *    `TenantRegistry` (`TENANCY_UNREGISTERED_JOB_TENANT` otherwise).
 * 3. Mints a system job `TenantContext` (`actorId`/`actorSub: 'system:<jobKey>'`,
 *    `actorRoles: []`, `jobPermissions: [policy.permission]`) with a fresh correlation ID.
 * 4. Enforces `policy.permission` against `tenantContext.jobPermissions` (`FORBIDDEN` if missing).
 * 5. Enforces a per-tenant execution deadline (default 120s) via `AbortController`.
 * 6. Emits PII-free telemetry (`job.tenant.started`, `job.tenant.succeeded`, `job.tenant.failed`).
 */
export async function guardedJob<R>(
  jobKey: RegisteredJobName,
  tenantTarget: GuardedJobTenantTarget | null | undefined,
  fn: (ctx: GuardedJobExecutionContext) => Promise<R> | R,
  options?: GuardedJobOptions,
): Promise<R> {
  const policy = (
    JOB_PERMISSIONS as Record<string, JobPolicy | undefined>
  )[jobKey];
  if (!policy) {
    throw new Error(
      `UNREGISTERED_JOB_POLICY: Background job "${String(jobKey)}" has no entry in JOB_PERMISSIONS.`,
    );
  }

  const correlationId = resolveRequestCorrelationId(
    options?.correlationId ?? null,
    `job-${jobKey}`,
  );

  const requestedTenantId =
    typeof tenantTarget === 'string'
      ? tenantTarget.trim()
      : tenantTarget?.tenantId?.trim() ?? '';

  if (!requestedTenantId) {
    const err = new Error(
      'TENANCY_UNREGISTERED_JOB_TENANT: A registered and enabled tenantId is required to execute a background job.',
    );
    (err as Error & { code?: string }).code = 'TENANCY_UNREGISTERED_JOB_TENANT';
    throw err;
  }

  const registry = resolveJobRegistryOrFallback(options?.registry);
  const registeredEntry = registry.tenants.find(
    (t) => t.tenantId === requestedTenantId,
  );
  const explicitlyDisabled =
    typeof tenantTarget === 'object' &&
    tenantTarget !== null &&
    tenantTarget.enabled === false;

  if (!registeredEntry || !registeredEntry.enabled || explicitlyDisabled) {
    logAuthorisationDenial({
      correlationId,
      tenantId: requestedTenantId,
      action: `job:${jobKey}`,
      code: 'TENANCY_UNREGISTERED_JOB_TENANT',
      requiredPermission: policy.permission,
    });
    const err = new Error(
      `TENANCY_UNREGISTERED_JOB_TENANT: Tenant "${requestedTenantId}" is not registered or is disabled in the active tenant registry.`,
    );
    (err as Error & { code?: string }).code = 'TENANCY_UNREGISTERED_JOB_TENANT';
    throw err;
  }

  if (!policy.jobOnly || !isJobOnlyPermissionKey(policy.permission)) {
    logAuthorisationDenial({
      correlationId,
      tenantId: registeredEntry.tenantId,
      action: `job:${jobKey}`,
      code: 'FORBIDDEN',
      requiredPermission: policy.permission,
    });
    throw new AuthorisationError({
      code: 'FORBIDDEN',
      message: `Background job "${jobKey}" requires a jobOnly permission ("${policy.permission}").`,
      tenantId: registeredEntry.tenantId,
      correlationId,
      actorUserId: `system:${jobKey}`,
      requiredPermission: policy.permission,
    });
  }

  const expectedActorSub = `system:${jobKey}`;
  const effectiveActorSub = options?.overrideActorSub ?? expectedActorSub;
  const effectiveJobPermissions =
    options?.overrideJobPermissions ?? [policy.permission];

  const tenantContext = resolveJobTenantContext({
    actorSub: effectiveActorSub,
    jobKey,
    tenantId: registeredEntry.tenantId,
    hostingMode: registry.hostingMode,
    environment: registeredEntry.environment,
    correlationId,
    postgresHost: registeredEntry.postgresHost,
    keyVaultUri: registeredEntry.keyVaultUri,
    jobPermissions: effectiveJobPermissions,
  });

  const targetDatabaseName =
    (typeof tenantTarget === 'object' &&
    tenantTarget !== null &&
    tenantTarget.postgresDatabaseName
      ? tenantTarget.postgresDatabaseName
      : registeredEntry.postgresDatabaseName) ??
    registeredEntry.postgresDatabaseName;

  if (
    registeredEntry.postgresDatabaseName !== tenantContext.postgresDatabaseName ||
    targetDatabaseName !== tenantContext.postgresDatabaseName
  ) {
    const mismatchErr = new Error(
      'TENANT_REGISTRY_DATABASE_MISMATCH: Registry postgresDatabaseName does not match the database derived from the tenant ID.',
    );
    (mismatchErr as Error & { code?: string }).code =
      'TENANT_REGISTRY_DATABASE_MISMATCH';
    emitTenantTelemetryEvent({
      eventName: 'job.tenant.failed',
      severity: 'error',
      tenantId: registeredEntry.tenantId,
      correlationId,
      properties: {
        jobKey,
        durationMs: 0,
        errorCode: 'TENANT_REGISTRY_DATABASE_MISMATCH',
      },
    });
    emitTenantTelemetryException({
      eventName: 'job.tenant.failed',
      tenantId: registeredEntry.tenantId,
      correlationId,
      error: mismatchErr,
      properties: {
        jobKey,
        errorCode: 'TENANT_REGISTRY_DATABASE_MISMATCH',
      },
    });
    throw mismatchErr;
  }

  if (
    tenantContext.actorId !== expectedActorSub ||
    tenantContext.actorSub !== expectedActorSub ||
    tenantContext.actorRoles.length > 0 ||
    !tenantContext.jobPermissions ||
    !tenantContext.jobPermissions.includes(policy.permission)
  ) {
    logAuthorisationDenial({
      correlationId,
      tenantId: tenantContext.tenantId,
      action: `job:${jobKey}`,
      code: 'FORBIDDEN',
      requiredPermission: policy.permission,
    });
    throw new AuthorisationError({
      code: 'FORBIDDEN',
      message: `System job "${jobKey}" is not authorised for permission "${policy.permission}".`,
      tenantId: tenantContext.tenantId,
      correlationId,
      actorUserId: tenantContext.actorId,
      requiredPermission: policy.permission,
    });
  }

  const timeoutMs = Math.max(
    10,
    Math.trunc(options?.timeoutMs ?? policy.timeoutMs ?? 120_000),
  );
  const abortController = new AbortController();
  const startedAtMs = Date.now();

  emitTenantTelemetryEvent({
    eventName: 'job.tenant.started',
    tenantId: tenantContext.tenantId,
    correlationId,
    properties: {
      jobKey,
      timeoutMs,
    },
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race<R>([
      Promise.resolve().then(() =>
        fn({
          jobKey,
          tenantEntry: registeredEntry,
          tenantContext,
          correlationId,
          signal: abortController.signal,
          timeoutMs,
        }),
      ),
      new Promise<R>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          const timeoutErr = new Error(
            `JOB_TENANT_TIMEOUT: Background job "${jobKey}" exceeded per-tenant deadline of ${timeoutMs}ms.`,
          );
          (timeoutErr as Error & { code?: string }).code = 'JOB_TENANT_TIMEOUT';
          reject(timeoutErr);
        }, timeoutMs);
      }),
    ]);

    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const resultRecord =
      typeof result === 'object' && result !== null
        ? (result as Record<string, unknown>)
        : undefined;
    const statusProp =
      typeof resultRecord?.outcome === 'string'
        ? resultRecord.outcome
        : typeof resultRecord?.status === 'string'
          ? resultRecord.status
          : 'succeeded';
    const nestedSummary =
      typeof resultRecord?.jobRun === 'object' &&
      resultRecord.jobRun !== null &&
      typeof (resultRecord.jobRun as Record<string, unknown>).summary === 'object'
        ? ((resultRecord.jobRun as Record<string, unknown>).summary as Record<
            string,
            number
          >)
        : typeof resultRecord?.summary === 'object' &&
            resultRecord.summary !== null
          ? (resultRecord.summary as Record<string, number>)
          : {};
    const rawSummary = sanitizeJobSummaryCounts(nestedSummary);

    emitTenantTelemetryEvent({
      eventName: 'job.tenant.succeeded',
      tenantId: tenantContext.tenantId,
      correlationId,
      properties: {
        jobKey,
        durationMs,
        status: statusProp,
        ...rawSummary,
      },
    });

    return result;
  } catch (err) {
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const errorCode = sanitizeJobErrorCode(err);
    emitTenantTelemetryEvent({
      eventName: 'job.tenant.failed',
      severity: 'error',
      tenantId: tenantContext.tenantId,
      correlationId,
      properties: {
        jobKey,
        durationMs,
        errorCode,
      },
    });
    emitTenantTelemetryException({
      eventName: 'job.tenant.failed',
      tenantId: tenantContext.tenantId,
      correlationId,
      error: err,
      properties: {
        jobKey,
        durationMs,
        errorCode,
      },
    });
    throw err;
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}
