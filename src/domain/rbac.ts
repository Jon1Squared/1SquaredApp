/**
 * Host Application RBAC Bridge (`src/domain/rbac.ts`).
 *
 * Bridges host domain entities (`Person`, `Team`, `Matter`) into the single central
 * `@platform/core` permission registry and resolver (`resolvePermissions`, `hasPermission`,
 * `requirePermission`, `canAccessMatter`, `validateUserOverrideOrRoleMutation`).
 *
 * Implements ADR-0010 through ADR-0016:
 * - Zero hardcoded `DEPT-*` or `P-00000*` identifiers in domain code.
 * - Zero free-text `jobTitle` or mutable display-label substring checks.
 * - Strictly ignores `activeViewingRole` ("Viewing as") for access control.
 * - Supports unified `Person.permissionOverrides` (`{ grant, revoke }`) and lossless
 *   migration from legacy `employeePermissions` / `documentPermissions`.
 */

import {
  ALL_BUILTIN_ROLE_KEYS,
  ALL_DOCUMENT_PERMISSIONS,
  ALL_EMPLOYEE_PERMISSIONS,
  ALL_PERMISSION_KEYS,
  AuthorisationError,
  canAccessMatter,
  clearPermissionRequestCache,
  createDefaultRbacConfig,
  DEFAULT_RBAC_IDENTITY_MAPPING,
  DEFAULT_RBAC_RELATIONSHIP_GRANTS,
  DEFAULT_RBAC_ROLES,
  getPermissionRegistryEntry,
  hasPermission,
  isEntraMfaVerified,
  isRegisteredPermissionKey,
  mapEntraTokenClaimsToVerifiedOidcToken,
  migrateLegacyPersonOverrides,
  PERMISSION_REGISTRY,
  requirePermission,
  resolveAuthoritativeRoles,
  resolvePermissions,
  validateRbacConfig,
  validateUserOverrideOrRoleMutation,
  type EntraIdRawTokenClaims,
  type PermissionKey,
  type PermissionRegistryEntry,
  type PersonPermissionOverrides,
  type RbacConfiguration,
  type RbacRoleDefinition,
  type ResolvedPermissionSet,
  type TenantConfiguration,
  type TenantContext,
  type VerifiedOidcTokenClaims,
} from '@platform/core';
import type { Matter, Person, Team } from './types';

type ServerTenantConfigReader = () => Pick<
  TenantConfiguration,
  'tenantId' | 'displayName' | 'branding' | 'rbac'
>;

let serverTenantConfigReader: ServerTenantConfigReader | null = null;

/**
 * Registers the server-only tenant configuration reader from `src/platform/tenantRuntime.ts`.
 * Never registered in browser bundles (`src/platform/tenantRuntime.ts` is guarded by `import 'server-only'`).
 */
export function registerServerTenantConfigReader(
  reader: ServerTenantConfigReader,
): void {
  serverTenantConfigReader = reader;
}

export function getServerTenantConfiguration(): Pick<
  TenantConfiguration,
  'tenantId' | 'displayName' | 'branding' | 'rbac'
> {
  if (typeof window !== 'undefined' || !serverTenantConfigReader) {
    throw new Error(
      'TENANT_CONFIG_ERROR: Tenant configuration is server-only and is not available in this context.',
    );
  }
  return serverTenantConfigReader();
}

/**
 * Immutable taxonomy ID mapping (`employee_role.<slug>` -> canonical `HomeRoleKey`).
 * Used only as a deterministic fallback when `person.roles` is empty (ADR-0012).
 * Never inspects mutable display labels or free-text `jobTitle`.
 */
export const IMMUTABLE_EMPLOYEE_ROLE_ID_TO_ROLE_KEY: Readonly<
  Record<string, string>
> = {
  'employee_role.fee_earner': 'fee_earner',
  'employee_role.solicitor': 'fee_earner',
  'employee_role.senior_associate': 'fee_earner',
  'employee_role.associate': 'fee_earner',
  'employee_role.trainee_solicitor': 'fee_earner',
  'employee_role.paralegal': 'fee_earner',
  'employee_role.partner': 'partner',
  'employee_role.support_staff': 'legal_secretary',
  'employee_role.legal_secretary': 'legal_secretary',
  'employee_role.enquiries_coordinator': 'enquiries_coordinator',
  'employee_role.finance': 'finance',
  'employee_role.risk_and_compliance': 'risk_compliance',
  'employee_role.practice_manager': 'managing_partner',
  'employee_role.managing_partner': 'managing_partner',
  'employee_role.system_administrator': 'admin',
};

const tenantRbacConfigCacheByTenant = new Map<string, RbacConfiguration>();
const runtimeRbacConfigOverrideByTenant = new Map<
  string,
  Partial<RbacConfiguration>
>();

export function mergeRbacConfigOverlay(
  base: RbacConfiguration,
  overlay?: Partial<RbacConfiguration> | null,
): RbacConfiguration {
  if (!overlay) return base;
  const mergedRoles: Record<string, RbacRoleDefinition> = { ...base.roles };
  if (overlay.roles) {
    for (const [k, v] of Object.entries(overlay.roles)) {
      if (v) {
        mergedRoles[k] = {
          ...v,
          permissions: (v.permissions ?? []).filter(isRegisteredPermissionKey),
        };
      }
    }
  }
  const mergedDeptGrants: Record<string, PermissionKey[]> = {
    ...base.departmentGrants,
  };
  if (overlay.departmentGrants) {
    for (const [deptId, perms] of Object.entries(overlay.departmentGrants)) {
      if (Array.isArray(perms)) {
        mergedDeptGrants[deptId] = perms.filter(isRegisteredPermissionKey);
      }
    }
  }
  return {
    roles: mergedRoles,
    departmentGrants: mergedDeptGrants,
    relationshipGrants: overlay.relationshipGrants ?? base.relationshipGrants,
    identityMapping: overlay.identityMapping
      ? {
          ...base.identityMapping,
          ...overlay.identityMapping,
          entraGroupToRoleKey: {
            ...base.identityMapping.entraGroupToRoleKey,
            ...(overlay.identityMapping.entraGroupToRoleKey ?? {}),
          },
          entraAppRoleToRoleKey: {
            ...base.identityMapping.entraAppRoleToRoleKey,
            ...(overlay.identityMapping.entraAppRoleToRoleKey ?? {}),
          },
        }
      : base.identityMapping,
  };
}

export function setRuntimeRbacConfigOverride(
  override: Partial<RbacConfiguration> | null | undefined,
  tenantId?: string,
): void {
  const activeCfg = getServerTenantConfiguration();
  const activeTenantId = tenantId?.trim() || activeCfg.tenantId;
  if (!override) {
    runtimeRbacConfigOverrideByTenant.delete(activeTenantId);
  } else {
    const baseCfg =
      activeTenantId === activeCfg.tenantId
        ? activeCfg.rbac
        : createDefaultRbacConfig();
    const merged = mergeRbacConfigOverlay(baseCfg, override);
    const validated = validateRbacConfig(merged);
    runtimeRbacConfigOverrideByTenant.set(activeTenantId, validated);
  }
  tenantRbacConfigCacheByTenant.delete(activeTenantId);
  clearPermissionRequestCache();
}

export function getDefaultTenantRbacConfig(tenantId?: string): RbacConfiguration {
  const activeCfg = getServerTenantConfiguration();
  const targetTenantId = tenantId?.trim() || activeCfg.tenantId;
  const cached = tenantRbacConfigCacheByTenant.get(targetTenantId);
  if (cached) {
    return cached;
  }

  const base =
    targetTenantId === activeCfg.tenantId
      ? activeCfg.rbac
      : createDefaultRbacConfig();
  const runtimeOverride = runtimeRbacConfigOverrideByTenant.get(targetTenantId);
  const withRuntime = mergeRbacConfigOverlay(base, runtimeOverride);
  tenantRbacConfigCacheByTenant.set(targetTenantId, withRuntime);
  return withRuntime;
}

/**
 * Resolves the authoritative role keys for a `Person` without inspecting free-text `jobTitle`
 * or mutable display labels (ADR-0012).
 */
export function resolvePersonAuthoritativeRoles(
  person: Person | null | undefined,
  teams: readonly Team[] = [],
  customRoleKeys: readonly string[] = [],
): string[] {
  if (!person) return [];

  if (Array.isArray(person.roles)) {
    if (person.roles.length > 0) {
      return Array.from(new Set(person.roles.filter(Boolean)));
    }
    // If roles array is explicitly set to empty (`[]`) on an Entra-linked person or when no legacy appRole/employeeRoleId is used, return []
    if (person.entraObjectId || (!person.appRole && !person.employeeRoleId)) {
      return [];
    }
  }

  // Legacy `appRole` transitional fallback (ADR-0016)
  if (person.appRole === 'admin') {
    return [
      'admin',
      'fee_earner',
      'partner',
      'legal_secretary',
      'enquiries_coordinator',
      'finance',
      'risk_compliance',
      'managing_partner',
    ];
  }
  if (person.appRole === 'call_handler') {
    return ['enquiries_coordinator'];
  }

  if (person.employeeRoleId) {
    const mapped = IMMUTABLE_EMPLOYEE_ROLE_ID_TO_ROLE_KEY[person.employeeRoleId];
    if (mapped) {
      if (
        mapped === 'partner' &&
        teams.some((t) => t.active && t.leadIds.includes(person.id))
      ) {
        return ['partner', 'fee_earner'];
      }
      return [mapped];
    }
    const stripped = person.employeeRoleId.replace(/^employee_role\./, '');
    if (
      ALL_BUILTIN_ROLE_KEYS.includes(
        stripped as (typeof ALL_BUILTIN_ROLE_KEYS)[number],
      ) ||
      customRoleKeys.includes(stripped)
    ) {
      return [stripped];
    }
  }

  const isTeamLead = teams.some(
    (t) => t.active && t.leadIds.includes(person.id),
  );
  if (isTeamLead || person.appRole === 'team_lead') {
    return ['partner', 'fee_earner'];
  }

  return ['fee_earner'];
}

export interface ActiveActorTokenSession {
  tenantId: string;
  personId: string;
  tokenRoles: readonly string[];
  expiresAtMs: number;
  verifiedSession?: unknown;
}

type AsyncLocalStorageLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
};

let actorSessionStorage: AsyncLocalStorageLike<ActiveActorTokenSession | null> | null | undefined;

function getActorSessionAsyncStorage(): AsyncLocalStorageLike<ActiveActorTokenSession | null> | null {
  if (actorSessionStorage !== undefined) {
    return actorSessionStorage;
  }
  if (typeof window !== 'undefined' || typeof process.getBuiltinModule !== 'function') {
    actorSessionStorage = null;
    return null;
  }
  try {
    const asyncHooks = process.getBuiltinModule('node:async_hooks') as
      | typeof import('node:async_hooks')
      | undefined;
    actorSessionStorage = asyncHooks?.AsyncLocalStorage
      ? new asyncHooks.AsyncLocalStorage<ActiveActorTokenSession | null>()
      : null;
  } catch {
    actorSessionStorage = null;
  }
  return actorSessionStorage;
}

export function runWithActiveActorSession<R>(
  session: ActiveActorTokenSession | null,
  fn: () => R,
): R {
  const storage = getActorSessionAsyncStorage();
  if (storage) {
    const scopedSession = session
      ? {
          ...session,
          tokenRoles: [...session.tokenRoles],
        }
      : null;
    return storage.run(scopedSession, fn);
  }
  return fn();
}

export function getActiveActorSession(): ActiveActorTokenSession | undefined {
  const activeActor = getActorSessionAsyncStorage()?.getStore();
  if (!activeActor) {
    return undefined;
  }
  if (activeActor.expiresAtMs <= Date.now()) {
    return undefined;
  }
  return activeActor;
}

export function getStoredActorSessionForPerson(
  personId: string,
  tenantId?: string,
): ActiveActorTokenSession | undefined {
  if (!personId) return undefined;
  const activeActor = getActiveActorSession();
  if (!activeActor || activeActor.personId !== personId) {
    return undefined;
  }
  const targetTenantId =
    tenantId?.trim() ||
    activeActor.tenantId ||
    getServerTenantConfiguration().tenantId;
  if (activeActor.tenantId !== targetTenantId) {
    return undefined;
  }
  return activeActor;
}

export function getActiveSessionTokenRolesForPerson(
  personId: string,
  tenantId?: string,
): readonly string[] | undefined {
  if (!personId) return undefined;
  const activeActor = getActiveActorSession();
  if (!activeActor || activeActor.personId !== personId) {
    return undefined;
  }
  const targetTenantId =
    tenantId?.trim() ||
    activeActor.tenantId ||
    getServerTenantConfiguration().tenantId;
  if (activeActor.tenantId !== targetTenantId) {
    return undefined;
  }
  return activeActor.tokenRoles;
}

export interface ResolvePersonPermissionsOptions {
  allPeople?: readonly Person[];
  teams?: readonly Team[];
  targetPersonId?: string | null;
  targetTeamId?: string | null;
  config?:
    | Pick<TenantConfiguration, 'rbac'>
    | {
        rbac?: RbacConfiguration;
        documentGeneration?: TenantConfiguration['documentGeneration'];
      }
    | null;
  context?:
    | (Partial<
        Pick<
          TenantContext,
          | 'correlationId'
          | 'actorId'
          | 'actorRoles'
          | 'actorGroups'
          | 'mfaVerified'
        >
      > & { tenantId: string })
    | null;
  mfaVerified?: boolean;
  tokenRoles?: readonly string[];
}

export function resolveActiveTenantIdForRbac(
  explicitTenantId?: string,
): string {
  if (explicitTenantId && explicitTenantId.trim().length > 0) {
    return explicitTenantId.trim();
  }
  return getServerTenantConfiguration().tenantId;
}

/**
 * Resolves the complete `ResolvedPermissionSet` for a `Person` using the central `@platform/core`
 * `resolvePermissions` engine.
 */
export function resolvePersonPermissionSet(
  user: Person | null | undefined,
  options: ResolvePersonPermissionsOptions = {},
): ResolvedPermissionSet {
  const activeTenantId = resolveActiveTenantIdForRbac(
    options.context?.tenantId,
  );
  if (!user?.id) {
    return resolvePermissions({
      context: {
        tenantId: activeTenantId,
        correlationId: options.context?.correlationId ?? '',
        actorId: '',
        actorRoles: [],
        mfaVerified: false,
      },
      actor: null,
    });
  }

  const teams = options.teams ?? [];
  const allPeople = options.allPeople ?? [];
  const rbacConfig =
    options.config?.rbac ?? getDefaultTenantRbacConfig(activeTenantId);
  const storedRoles = resolvePersonAuthoritativeRoles(
    user,
    teams,
    Object.keys(rbacConfig.roles ?? {}),
  );

  const isTeamLeadOfAnyTeam =
    user.appRole === 'team_lead' ||
    teams.some((t) => t.active && t.leadIds.includes(user.id));

  const isLineManagerOfAnyOrTarget = options.targetPersonId
    ? allPeople.some(
        (p) =>
          p.id === options.targetPersonId &&
          (p.employment?.lineManagerId === user.id ||
            p.employment?.supervisingPartnerId === user.id),
      )
    : allPeople.some(
        (p) =>
          p.employment?.lineManagerId === user.id ||
          p.employment?.supervisingPartnerId === user.id,
      );

  const isTeamLeadOfTargetTeam = options.targetTeamId
    ? teams.some(
        (t) =>
          t.active &&
          t.id === options.targetTeamId &&
          t.leadIds.includes(user.id),
      )
    : false;

  const isSupportingTargetFeeEarner = options.targetPersonId
    ? Boolean(user.supportsIds?.includes(options.targetPersonId))
    : false;

  const mfaVerified =
    options.mfaVerified ?? options.context?.mfaVerified ?? false;
  const isEvaluatingContextActor =
    !options.context?.actorId || options.context.actorId === user.id;
  const sessionTokenRoles = isEvaluatingContextActor
    ? getActiveSessionTokenRolesForPerson(user.id, activeTenantId)
    : undefined;
  const contextActorRoles =
    options.tokenRoles ??
    (isEvaluatingContextActor
      ? sessionTokenRoles
        ? options.context?.actorRoles
          ? Array.from(
              new Set([...options.context.actorRoles, ...sessionTokenRoles]),
            )
          : sessionTokenRoles
        : options.context?.actorRoles
      : undefined) ??
    storedRoles;

  const resolved = resolvePermissions({
    context: options.context
      ? {
          tenantId: activeTenantId,
          correlationId: options.context.correlationId ?? '',
          actorId: user.id,
          actorRoles: contextActorRoles,
          actorGroups: isEvaluatingContextActor
            ? options.context.actorGroups
            : undefined,
          mfaVerified,
        }
      : {
          tenantId: activeTenantId,
          correlationId: '',
          actorId: user.id,
          actorRoles: contextActorRoles,
          mfaVerified,
        },
    config: options.config ?? { rbac: rbacConfig },
    actor: {
      userId: user.id,
      roles: storedRoles,
      departmentId: user.departmentId ?? user.employment?.departmentId ?? null,
      secondaryDepartmentId:
        user.employment?.departmentId &&
        user.employment.departmentId !== user.departmentId
          ? user.employment.departmentId
          : null,
      permissionOverrides: user.permissionOverrides ?? null,
      employeePermissions: user.employeePermissions ?? null,
      documentPermissions: user.documentPermissions ?? null,
    },
    relationships: {
      isTeamLeadOfAnyTeam,
      isTeamLeadOfTargetTeam,
      isLineManagerOfTarget: isLineManagerOfAnyOrTarget,
      isSupportingTargetFeeEarner,
    },
  });

  return resolved;
}

export function resolvePersonPermissions(
  user: Person | null | undefined,
  options: ResolvePersonPermissionsOptions = {},
): PermissionKey[] {
  return [...resolvePersonPermissionSet(user, options).permissionList];
}

export function hasPersonPermission(
  user: Person | null | undefined,
  permission: PermissionKey,
  options: ResolvePersonPermissionsOptions & { enforceMfa?: boolean } = {},
): boolean {
  const set = resolvePersonPermissionSet(user, options);
  return hasPermission(set, permission, { enforceMfa: options.enforceMfa });
}

export function requirePersonPermission(
  user: Person | null | undefined,
  permission: PermissionKey,
  actionDescription?: string,
  options: ResolvePersonPermissionsOptions = {},
): ResolvedPermissionSet {
  const set = resolvePersonPermissionSet(user, options);
  return requirePermission(set, permission, actionDescription);
}

/**
 * Evaluates whether a `Person` can access a `Matter` record, enforcing restricted staff-matter rules
 * via `matter:restricted:access` + named matter participants (ADR-0014).
 */
export function canPersonAccessMatter(
  matter: Pick<
    Matter,
    | 'id'
    | 'clientId'
    | 'isStaffMatter'
    | 'restrictedAccessUserIds'
    | 'responsiblePartnerId'
    | 'supervisingPartnerId'
    | 'leadFeeEarnerId'
    | 'teamMemberIds'
  > | null | undefined,
  userId: string,
  user?: Person | null,
  options: ResolvePersonPermissionsOptions = {},
): boolean {
  if (!matter) return false;
  if (!userId) return false;

  const effectiveUser: Person = user ?? {
    id: userId,
    recordType: 'person',
    recordOwnerId: null,
    recordStatusId: 'record_status.active',
    createdById: userId,
    createdAt: '',
    updatedById: userId,
    updatedAt: '',
    sourceId: null,
    lastVerifiedAt: null,
    tags: [],
    duplicateStatusId: 'duplicate_status.unique',
    notDuplicateOf: [],
    possibleMatchIds: [],
    mergedIntoId: null,
    lastInteractionAt: null,
    customFields: {},
    titleId: null,
    firstName: '',
    middleNames: '',
    surname: '',
    preferredName: '',
    otherNames: [],
    jobTitle: '',
    emails: [],
    phones: [],
    preferredContactMethodId: null,
    preferredLanguageId: null,
    addresses: [],
    website: '',
    relationshipOwnerId: null,
    relationshipStatusId: null,
    relationshipStandingId: null,
    relationshipRoleIds: [],
    originId: null,
    firstKnownAt: null,
    engagementLevelId: null,
    interests: '',
    relationshipNotes: '',
    marketingConsentId: null,
    consentRecord: '',
    verificationStatusId: null,
    verifiedAt: null,
    verificationMethodId: null,
    verificationReviewerId: null,
    riskReferences: '',
    isEmployee: true,
    employeeRoleId: null,
    departmentId: null,
    roles: [],
  };

  const permSet = resolvePersonPermissionSet(effectiveUser, options);
  return canAccessMatter(permSet, {
    id: matter.id,
    clientId: matter.clientId,
    isStaffMatter: matter.isStaffMatter,
    restrictedAccessUserIds: matter.restrictedAccessUserIds,
    responsiblePartnerId: matter.responsiblePartnerId,
    supervisingPartnerId: matter.supervisingPartnerId,
    leadFeeEarnerId: matter.leadFeeEarnerId,
    teamMemberIds: matter.teamMemberIds,
  });
}

/**
 * Matches a Microsoft Entra ID v2.0 JWT claim set (`oid`, `preferred_username`, `upn`, `email`, `roles`, `groups`, `amr`)
 * to an active employee `Person` in the tenant store and resolves their `VerifiedOidcTokenClaims` + `ResolvedPermissionSet`.
 */
export function resolvePersonForEntraClaims(params: {
  claims: EntraIdRawTokenClaims;
  people: readonly Person[];
  teams?: readonly Team[];
  tenantId?: string;
  rbacConfig?: RbacConfiguration;
}): {
  person: Person | null;
  matchedByEmailOnly?: boolean;
  verifiedToken: VerifiedOidcTokenClaims;
  permissions: ResolvedPermissionSet;
} {
  const activeTenantId =
    params.tenantId?.trim() || getServerTenantConfiguration().tenantId;
  const {
    claims,
    people,
    teams = [],
    rbacConfig = getDefaultTenantRbacConfig(activeTenantId),
  } = params;

  const oid = claims.oid?.trim();
  const claimEmail = (
    claims.email ||
    claims.preferred_username ||
    claims.upn ||
    ''
  )
    .trim()
    .toLowerCase();

  const activeEmployees = people.filter((p) => p.isEmployee && !p.mergedIntoId);

  let matchedPerson: Person | null = null;
  let matchedByEmailOnly = false;
  if (oid) {
    matchedPerson =
      activeEmployees.find((p) => p.entraObjectId?.trim() === oid) ?? null;
  }
  // Link by email only when no `entraObjectId` is set on the employee record yet (R61)
  if (!matchedPerson && claimEmail) {
    matchedPerson =
      activeEmployees.find(
        (p) =>
          !p.entraObjectId?.trim() &&
          p.emails.some(
            (e) =>
              e.active !== false && e.address.trim().toLowerCase() === claimEmail,
          ),
      ) ?? null;
    if (matchedPerson) {
      matchedByEmailOnly = true;
    }
  }

  const verifiedToken = mapEntraTokenClaimsToVerifiedOidcToken({
    claims,
    tenantId: activeTenantId,
    rbacConfig,
    fallbackActorId: matchedPerson?.id ?? oid ?? claims.sub ?? 'unmatched-entra-user',
  });

  if (!matchedPerson) {
    const permissions = resolvePermissions({
      context: {
        tenantId: verifiedToken.tenantId,
        correlationId: '',
        actorId: verifiedToken.sub,
        actorRoles: verifiedToken.roles,
        actorGroups: verifiedToken.groups,
        mfaVerified: verifiedToken.mfaVerified,
      },
      config: { rbac: rbacConfig },
      actor: {
        userId: verifiedToken.sub,
        roles: [...verifiedToken.roles],
        tokenClaims: {
          appRoles: claims.roles,
          groups: claims.groups,
        },
      },
    });
    return { person: null, matchedByEmailOnly: false, verifiedToken, permissions };
  }

  const storedRoles = resolvePersonAuthoritativeRoles(
    matchedPerson,
    teams,
    Object.keys(rbacConfig.roles ?? {}),
  );

  const permissions = resolvePersonPermissionSet(
    {
      ...matchedPerson,
      roles: storedRoles,
    },
    {
      allPeople: people,
      teams,
      config: { rbac: rbacConfig },
      mfaVerified: verifiedToken.mfaVerified,
      context: {
        tenantId: verifiedToken.tenantId,
        correlationId: '',
        actorId: matchedPerson.id,
        actorRoles: verifiedToken.roles,
        actorGroups: verifiedToken.groups,
        mfaVerified: verifiedToken.mfaVerified,
      },
    },
  );

  return {
    person: matchedPerson,
    matchedByEmailOnly,
    verifiedToken,
    permissions,
  };
}

export {
  ALL_BUILTIN_ROLE_KEYS,
  ALL_DOCUMENT_PERMISSIONS,
  ALL_EMPLOYEE_PERMISSIONS,
  ALL_PERMISSION_KEYS,
  AuthorisationError,
  canAccessMatter,
  clearPermissionRequestCache,
  createDefaultRbacConfig,
  DEFAULT_RBAC_IDENTITY_MAPPING,
  DEFAULT_RBAC_RELATIONSHIP_GRANTS,
  DEFAULT_RBAC_ROLES,
  getPermissionRegistryEntry,
  hasPermission,
  isEntraMfaVerified,
  isRegisteredPermissionKey,
  mapEntraTokenClaimsToVerifiedOidcToken,
  migrateLegacyPersonOverrides,
  PERMISSION_REGISTRY,
  requirePermission,
  resolveAuthoritativeRoles,
  resolvePermissions,
  validateUserOverrideOrRoleMutation,
  type EntraIdRawTokenClaims,
  type PermissionKey,
  type PermissionRegistryEntry,
  type PersonPermissionOverrides,
  type RbacConfiguration,
  type RbacRoleDefinition,
  type ResolvedPermissionSet,
  type VerifiedOidcTokenClaims,
};
