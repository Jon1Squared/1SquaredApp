/**
 * Single Central Permission Resolver (`core/src/domain/rbac/resolver.ts`).
 *
 * Implements ADR-0010, ADR-0011, ADR-0012, ADR-0013, ADR-0014, and ADR-0015:
 * - Resolves authoritative roles from `TenantContext.actorRoles` and `actorRecord.roles`
 *   according to `rbac.identityMapping` (never from `activeViewingRole`, `jobTitle`, or display labels).
 * - Computes base permissions from `rbac.roles`, `rbac.departmentGrants`, and `rbac.relationshipGrants`.
 * - Applies unified `Person.permissionOverrides` (`+grant`, `-revoke`; `revoke` always wins),
 *   plus lossless support for transitional `employeePermissions` / `documentPermissions`.
 * - Enforces `requiresMfa` when `requirePermission` is called.
 * - Evaluates restricted staff-matter access (`canAccessMatter`) via `matter:restricted:access` + named participants.
 * - Provides tenant-scoped request memoization (`tenantId + correlationId + actorUserId`).
 */

import type {
  DocumentPermission,
  EmployeePermission,
  PermissionKey,
  PersonPermissionOverrides,
  RbacConfiguration,
  TenantConfiguration,
  TenantContext,
} from '../../api/index';
import {
  ALL_EMPLOYEE_PERMISSIONS,
  createDefaultRbacConfig,
  DEFAULT_RBAC_ROLES,
  getPermissionRegistryEntry,
  isRegisteredPermissionKey,
} from './registry';

export interface MatterAccessRecord {
  readonly id: string;
  readonly clientId?: string | null;
  readonly isStaffMatter?: boolean;
  readonly restrictedAccessUserIds?: readonly string[];
  readonly responsiblePartnerId?: string | null;
  readonly responsibleSolicitorId?: string | null;
  readonly supervisingPartnerId?: string | null;
  readonly leadFeeEarnerId?: string | null;
  readonly originatingSolicitorId?: string | null;
  readonly teamMemberIds?: readonly string[];
}

export interface PermissionResolutionActor {
  readonly userId: string;
  /** Roles from stored Person.roles (or immutable taxonomy fallback). */
  readonly roles?: readonly string[];
  /** Optional Entra ID group IDs or app-role claims when not already mapped in TenantContext.actorRoles. */
  readonly tokenClaims?: {
    readonly appRoles?: readonly string[];
    readonly groups?: readonly string[];
  };
  /** Optional UI "Viewing as" role — explicitly ignored by permission resolution (ADR-0013). */
  readonly activeViewingRole?: string;
  /** Actor's department ID (`Person.departmentId` or `Person.employment.departmentId`). */
  readonly departmentId?: string | null;
  /** Additional secondary department ID if both `person.departmentId` and `person.employment.departmentId` exist. */
  readonly secondaryDepartmentId?: string | null;
  /** Unified per-person permission overrides (`grant` / `revoke`, ADR-0015). */
  readonly permissionOverrides?: PersonPermissionOverrides | null;
  /**
   * @deprecated Transitional support for legacy full-replacement `Person.employeePermissions`.
   */
  readonly employeePermissions?: readonly EmployeePermission[] | null;
  /**
   * @deprecated Transitional support for legacy additive `Person.documentPermissions`.
   */
  readonly documentPermissions?: readonly DocumentPermission[] | null;
}

export interface PermissionRelationshipContext {
  /** Whether the actor is in `team.leadIds` for at least one active team. */
  readonly isTeamLeadOfAnyTeam?: boolean;
  /** Whether the actor is in `team.leadIds` for the specific target team being accessed/modified. */
  readonly isTeamLeadOfTargetTeam?: boolean;
  /** Whether the actor is the line manager (`lineManagerId === actor.userId`) of the target person. */
  readonly isLineManagerOfTarget?: boolean;
  /** Whether the actor supports (`supportsIds.includes(targetPersonId)`) the target fee earner. */
  readonly isSupportingTargetFeeEarner?: boolean;
}

export interface ResolvePermissionsInput {
  readonly context?: Pick<
    TenantContext,
    | 'tenantId'
    | 'correlationId'
    | 'actorId'
    | 'actorRoles'
    | 'actorGroups'
    | 'mfaVerified'
  > | null;
  readonly config?:
    | Pick<TenantConfiguration, 'rbac'>
    | { rbac?: RbacConfiguration; documentGeneration?: TenantConfiguration['documentGeneration'] }
    | null;
  readonly actor: PermissionResolutionActor | null | undefined;
  readonly relationships?: PermissionRelationshipContext | null;
}

export interface ResolvedPermissionSet {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly actorUserId: string;
  readonly mfaVerified: boolean;
  readonly requireMfaForAdminPermissions: boolean;
  /** Authoritative role keys resolved for the actor (never includes `activeViewingRole`). */
  readonly authoritativeRoles: readonly string[];
  /** Effective granted permissions (after role, department, relationship, and grant/revoke overrides). */
  readonly permissions: ReadonlySet<PermissionKey>;
  /** Sorted array of effective granted permissions. */
  readonly permissionList: readonly PermissionKey[];
  /** Permissions in `permissions` that require MFA when `mfaVerified` is false. */
  readonly mfaPendingPermissions: ReadonlySet<PermissionKey>;
  has(permission: PermissionKey): boolean;
}

export class AuthorisationError extends Error {
  public readonly code:
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'MFA_REQUIRED'
    | 'SELF_MODIFICATION_FORBIDDEN'
    | 'PRIVILEGE_ESCALATION_FORBIDDEN';
  public readonly tenantId: string;
  public readonly correlationId: string;
  public readonly actorUserId: string;
  public readonly requiredPermission?: PermissionKey;

  constructor(params: {
    code:
      | 'UNAUTHENTICATED'
      | 'FORBIDDEN'
      | 'MFA_REQUIRED'
      | 'SELF_MODIFICATION_FORBIDDEN'
      | 'PRIVILEGE_ESCALATION_FORBIDDEN';
    message: string;
    tenantId: string;
    correlationId: string;
    actorUserId: string;
    requiredPermission?: PermissionKey;
  }) {
    super(`[${params.code}] ${params.message}`);
    this.name = 'AuthorisationError';
    this.code = params.code;
    this.tenantId = params.tenantId;
    this.correlationId = params.correlationId;
    this.actorUserId = params.actorUserId;
    this.requiredPermission = params.requiredPermission;
  }
}

/**
 *Bounded LRU-style request cache keyed by `(tenantId, correlationId, actorCacheKey)`.
 * Prevents cross-tenant or cross-request leakage while avoiding redundant recomputation within a request.
 */
const REQUEST_PERMISSION_CACHE = new Map<string, ResolvedPermissionSet>();
const MAX_CACHE_ENTRIES = 256;

export function clearPermissionRequestCache(): void {
  REQUEST_PERMISSION_CACHE.clear();
}

function resolveEffectiveRbacConfig(
  config?: ResolvePermissionsInput['config'],
): RbacConfiguration {
  const base = createDefaultRbacConfig();
  if (!config) {
    return base;
  }

  const rbac = config.rbac;
  if (rbac) {
    const mergedRoles: Record<string, RbacConfiguration['roles'][string]> = {
      ...base.roles,
    };
    for (const [roleKey, roleDef] of Object.entries(rbac.roles ?? {})) {
      mergedRoles[roleKey] = {
        ...roleDef,
        permissions: (roleDef.permissions ?? []).filter(
          isRegisteredPermissionKey,
        ),
      };
    }

    const mergedDeptGrants: Record<string, PermissionKey[]> = {};
    for (const [deptId, perms] of Object.entries(
      rbac.departmentGrants ?? {},
    )) {
      mergedDeptGrants[deptId] = (perms ?? []).filter(
        isRegisteredPermissionKey,
      );
    }

    return {
      roles: mergedRoles,
      departmentGrants: mergedDeptGrants,
      relationshipGrants:
        rbac.relationshipGrants ?? base.relationshipGrants,
      identityMapping: rbac.identityMapping ?? base.identityMapping,
    };
  }

  // Transitional fallback: if a caller passes a partial config with only `documentGeneration.permissions.roleDefaults`,
  // project those roleDefaults into `base.roles` so unmigrated tests continue to work identically.
  if (
    'documentGeneration' in config &&
    config.documentGeneration?.permissions?.roleDefaults
  ) {
    const roleDefaults = config.documentGeneration.permissions.roleDefaults;
    const docManagedPerms = Object.keys(roleDefaults) as DocumentPermission[];
    for (const roleDef of Object.values(base.roles)) {
      roleDef.permissions = roleDef.permissions.filter(
        (p) => !docManagedPerms.includes(p as DocumentPermission),
      );
    }
    for (const [permKey, roleKeys] of Object.entries(roleDefaults)) {
      if (!isRegisteredPermissionKey(permKey) || !Array.isArray(roleKeys)) {
        continue;
      }
      for (const rk of roleKeys) {
        if (!base.roles[rk]) {
          base.roles[rk] = {
            key: rk,
            label: rk,
            isBuiltIn: false,
            permissions: [],
          };
        }
        if (!base.roles[rk].permissions.includes(permKey)) {
          base.roles[rk].permissions.push(permKey);
        }
      }
    }
  }

  return base;
}

/**
 * Resolves the authoritative role keys for an actor (ADR-0012).
 *
 * Strictly ignores `activeViewingRole`, free-text `jobTitle`, and mutable display labels.
 */
export function resolveAuthoritativeRoles(
  actor: PermissionResolutionActor | null | undefined,
  rbacConfig: RbacConfiguration,
  contextActorRoles?: readonly string[],
  contextActorGroups?: readonly string[],
): string[] {
  if (!actor?.userId) {
    return [];
  }

  const knownRoleKeys = new Set<string>([
    ...Object.keys(DEFAULT_RBAC_ROLES),
    ...Object.keys(rbacConfig.roles ?? {}),
  ]);

  const mapClaimToRoles = (claim: string): string[] => {
    const trimmed = claim?.trim();
    if (!trimmed) return [];
    const results: string[] = [];
    if (knownRoleKeys.has(trimmed)) {
      results.push(trimmed);
    }
    const fromAppRole =
      rbacConfig.identityMapping?.entraAppRoleToRoleKey?.[trimmed];
    if (fromAppRole?.length) {
      for (const r of fromAppRole) {
        if (knownRoleKeys.has(r)) results.push(r);
      }
    }
    const fromGroup =
      rbacConfig.identityMapping?.entraGroupToRoleKey?.[trimmed];
    if (fromGroup?.length) {
      for (const r of fromGroup) {
        if (knownRoleKeys.has(r)) results.push(r);
      }
    }
    return results;
  };

  const tokenRoles = new Set<string>();
  for (const raw of contextActorRoles ?? []) {
    for (const mapped of mapClaimToRoles(raw)) {
      tokenRoles.add(mapped);
    }
  }
  for (const raw of contextActorGroups ?? []) {
    for (const mapped of mapClaimToRoles(raw)) {
      tokenRoles.add(mapped);
    }
  }
  for (const raw of actor.tokenClaims?.appRoles ?? []) {
    for (const mapped of mapClaimToRoles(raw)) {
      tokenRoles.add(mapped);
    }
  }
  for (const raw of actor.tokenClaims?.groups ?? []) {
    for (const mapped of mapClaimToRoles(raw)) {
      tokenRoles.add(mapped);
    }
  }

  const storedRoles = new Set<string>();
  for (const raw of actor.roles ?? []) {
    const trimmed = raw?.trim();
    if (trimmed && knownRoleKeys.has(trimmed)) {
      storedRoles.add(trimmed);
    }
  }

  const mode = rbacConfig.identityMapping?.authorityMode ?? 'hybrid';
  if (mode === 'token_only') {
    return Array.from(tokenRoles);
  }
  if (mode === 'store_only') {
    return Array.from(storedRoles);
  }
  // 'hybrid': union of verified token roles and stored roles
  return Array.from(new Set([...tokenRoles, ...storedRoles]));
}

/**
 * Converts legacy `Person.employeePermissions` (full replacement) and `Person.documentPermissions` (additive)
 * into a unified `PersonPermissionOverrides` (`{ grant, revoke }`) relative to the person's base permissions (ADR-0015).
 */
export function migrateLegacyPersonOverrides(params: {
  basePermissions: ReadonlySet<PermissionKey>;
  existingOverrides?: PersonPermissionOverrides | null;
  legacyEmployeePermissions?: readonly EmployeePermission[] | null;
  legacyDocumentPermissions?: readonly DocumentPermission[] | null;
}): PersonPermissionOverrides {
  const grant = new Set<PermissionKey>(
    (params.existingOverrides?.grant ?? []).filter(isRegisteredPermissionKey),
  );
  const revoke = new Set<PermissionKey>(
    (params.existingOverrides?.revoke ?? []).filter(isRegisteredPermissionKey),
  );

  if (Array.isArray(params.legacyDocumentPermissions)) {
    for (const perm of params.legacyDocumentPermissions) {
      if (isRegisteredPermissionKey(perm)) {
        grant.add(perm);
        revoke.delete(perm);
      }
    }
  }

  if (Array.isArray(params.legacyEmployeePermissions)) {
    const targetEmpSet = new Set<EmployeePermission>(
      params.legacyEmployeePermissions,
    );
    for (const empPerm of ALL_EMPLOYEE_PERMISSIONS) {
      if (targetEmpSet.has(empPerm)) {
        if (!params.basePermissions.has(empPerm)) {
          grant.add(empPerm);
        }
        revoke.delete(empPerm);
      } else if (params.basePermissions.has(empPerm)) {
        revoke.add(empPerm);
        grant.delete(empPerm);
      }
    }
  }

  return {
    grant: Array.from(grant),
    revoke: Array.from(revoke),
    ...(params.existingOverrides?.reason
      ? { reason: params.existingOverrides.reason }
      : {}),
    ...(params.existingOverrides?.updatedAt
      ? { updatedAt: params.existingOverrides.updatedAt }
      : {}),
    ...(params.existingOverrides?.updatedByUserId
      ? { updatedByUserId: params.existingOverrides.updatedByUserId }
      : {}),
  };
}

/**
 * Resolves the complete `ResolvedPermissionSet` for an actor (ADR-0010).
 */
export function resolvePermissions(
  input: ResolvePermissionsInput,
): ResolvedPermissionSet {
  const tenantId = input.context?.tenantId?.trim() ?? '';
  if (!tenantId) {
    throw new Error(
      'RBAC_TENANT_REQUIRED: resolvePermissions requires a non-empty tenantId in context.',
    );
  }
  const correlationId = input.context?.correlationId || '';
  const actor = input.actor;
  const actorUserId = actor?.userId || input.context?.actorId || '';
  const mfaVerified = input.context?.mfaVerified ?? false;

  if (!actorUserId) {
    const emptySet = new Set<PermissionKey>();
    return {
      tenantId,
      correlationId,
      actorUserId: '',
      mfaVerified: false,
      requireMfaForAdminPermissions: true,
      authoritativeRoles: [],
      permissions: emptySet,
      permissionList: [],
      mfaPendingPermissions: emptySet,
      has: () => false,
    };
  }

  const rbacConfig = resolveEffectiveRbacConfig(input.config);
  const authoritativeRoles = resolveAuthoritativeRoles(
    actor,
    rbacConfig,
    input.context?.actorRoles,
    input.context?.actorGroups,
  );

  // 1. Role grants
  const baseGranted = new Set<PermissionKey>();
  for (const roleKey of authoritativeRoles) {
    const roleDef =
      rbacConfig.roles[roleKey] ??
      DEFAULT_RBAC_ROLES[roleKey as keyof typeof DEFAULT_RBAC_ROLES];
    if (roleDef?.permissions) {
      for (const perm of roleDef.permissions) {
        if (isRegisteredPermissionKey(perm)) {
          baseGranted.add(perm);
        }
      }
    }
  }

  // 2. Department grants (`rbac.departmentGrants`)
  const deptIds = [actor?.departmentId, actor?.secondaryDepartmentId].filter(
    (d): d is string => Boolean(d && d.trim()),
  );
  for (const deptId of deptIds) {
    const deptPerms = rbacConfig.departmentGrants[deptId];
    if (deptPerms?.length) {
      for (const perm of deptPerms) {
        if (isRegisteredPermissionKey(perm)) {
          baseGranted.add(perm);
        }
      }
    }
  }

  // 3. Relationship grants (`rbac.relationshipGrants`)
  const rel = input.relationships;
  if (rel && rbacConfig.relationshipGrants?.length) {
    for (const rule of rbacConfig.relationshipGrants) {
      const matches =
        (rule.relationship === 'is_team_lead_of_any_team' &&
          rel.isTeamLeadOfAnyTeam) ||
        (rule.relationship === 'is_team_lead_of_target_team' &&
          rel.isTeamLeadOfTargetTeam) ||
        (rule.relationship === 'is_line_manager_of_target' &&
          rel.isLineManagerOfTarget) ||
        (rule.relationship === 'is_supporting_target_fee_earner' &&
          rel.isSupportingTargetFeeEarner);
      if (matches) {
        for (const perm of rule.permissions) {
          if (isRegisteredPermissionKey(perm)) {
            baseGranted.add(perm);
          }
        }
      }
    }
  }

  // 4. Per-person overrides (`permissionOverrides` + transitional legacy fields; `revoke` always wins)
  const effectiveOverrides = migrateLegacyPersonOverrides({
    basePermissions: baseGranted,
    existingOverrides: actor?.permissionOverrides,
    legacyEmployeePermissions: actor?.employeePermissions,
    legacyDocumentPermissions: actor?.documentPermissions,
  });

  const finalPermissions = new Set<PermissionKey>(baseGranted);
  for (const g of effectiveOverrides.grant) {
    if (isRegisteredPermissionKey(g)) {
      finalPermissions.add(g);
    }
  }
  for (const r of effectiveOverrides.revoke) {
    finalPermissions.delete(r);
  }

  // 5. Compute MFA-pending permissions when `mfaVerified` is false
  const requireMfaForAdminPermissions =
    rbacConfig.identityMapping?.requireMfaForAdminPermissions ?? true;
  const mfaPendingPermissions = new Set<PermissionKey>();
  if (requireMfaForAdminPermissions && !mfaVerified) {
    for (const perm of finalPermissions) {
      const entry = getPermissionRegistryEntry(perm);
      if (entry?.requiresMfa) {
        mfaPendingPermissions.add(perm);
      }
    }
  }

  const permissionList = Array.from(finalPermissions);
  const resolved: ResolvedPermissionSet = {
    tenantId,
    correlationId,
    actorUserId,
    mfaVerified,
    requireMfaForAdminPermissions,
    authoritativeRoles,
    permissions: finalPermissions,
    permissionList,
    mfaPendingPermissions,
    has(permission: PermissionKey): boolean {
      return finalPermissions.has(permission);
    },
  };

  if (correlationId) {
    const cacheKey = `${tenantId}:${correlationId}:${actorUserId}:${authoritativeRoles.join(',')}:${deptIds.join(',')}:${Boolean(rel?.isTeamLeadOfAnyTeam)}:${Boolean(rel?.isTeamLeadOfTargetTeam)}:${effectiveOverrides.grant.join(',')}:${effectiveOverrides.revoke.join(',')}:${mfaVerified}`;
    if (REQUEST_PERMISSION_CACHE.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = REQUEST_PERMISSION_CACHE.keys().next().value;
      if (oldestKey) REQUEST_PERMISSION_CACHE.delete(oldestKey);
    }
    REQUEST_PERMISSION_CACHE.set(cacheKey, resolved);
  }

  return resolved;
}

/**
 * Checks whether a `ResolvedPermissionSet` (or `ResolvePermissionsInput`) grants `permission`.
 * When `options.enforceMfa` is true, also verifies MFA if the permission has `requiresMfa: true`.
 */
export function hasPermission(
  resolvedOrInput: ResolvedPermissionSet | ResolvePermissionsInput,
  permission: PermissionKey,
  options?: { enforceMfa?: boolean },
): boolean {
  const resolved =
    'permissions' in resolvedOrInput
      ? resolvedOrInput
      : resolvePermissions(resolvedOrInput);
  if (!resolved.permissions.has(permission)) {
    return false;
  }
  if (options?.enforceMfa && resolved.mfaPendingPermissions.has(permission)) {
    return false;
  }
  return true;
}

/**
 * Server-side enforcement gate (Standard Section 9 & ADR-0010).
 * Throws `AuthorisationError` (`UNAUTHENTICATED`, `FORBIDDEN`, or `MFA_REQUIRED`) if the actor
 * does not hold `permission` or has not completed MFA for an MFA-required permission.
 */
export function requirePermission(
  resolvedOrInput: ResolvedPermissionSet | ResolvePermissionsInput,
  permission: PermissionKey,
  actionDescription?: string,
): ResolvedPermissionSet {
  const resolved =
    'permissions' in resolvedOrInput
      ? resolvedOrInput
      : resolvePermissions(resolvedOrInput);

  if (!resolved.actorUserId) {
    throw new AuthorisationError({
      code: 'UNAUTHENTICATED',
      message: `Authentication is required${actionDescription ? ` to ${actionDescription}` : ''}.`,
      tenantId: resolved.tenantId,
      correlationId: resolved.correlationId,
      actorUserId: '',
      requiredPermission: permission,
    });
  }

  if (!resolved.permissions.has(permission)) {
    throw new AuthorisationError({
      code: 'FORBIDDEN',
      message: `Permission '${permission}' is required${actionDescription ? ` to ${actionDescription}` : ''}.`,
      tenantId: resolved.tenantId,
      correlationId: resolved.correlationId,
      actorUserId: resolved.actorUserId,
      requiredPermission: permission,
    });
  }

  if (resolved.mfaPendingPermissions.has(permission)) {
    throw new AuthorisationError({
      code: 'MFA_REQUIRED',
      message: `Multi-factor authentication (MFA) is required for administrative permission '${permission}'${actionDescription ? ` (${actionDescription})` : ''}.`,
      tenantId: resolved.tenantId,
      correlationId: resolved.correlationId,
      actorUserId: resolved.actorUserId,
      requiredPermission: permission,
    });
  }

  return resolved;
}

/**
 * Evaluates whether an actor can access a matter record, enforcing restricted staff-matter rules
 * via the `matter:restricted:access` permission plus named matter participants (ADR-0014).
 */
export function canAccessMatter(
  resolvedOrInput: ResolvedPermissionSet | ResolvePermissionsInput,
  matter: MatterAccessRecord | null | undefined,
): boolean {
  const resolved =
    'permissions' in resolvedOrInput
      ? resolvedOrInput
      : resolvePermissions(resolvedOrInput);

  if (!resolved.actorUserId || !matter?.id) {
    return false;
  }

  const hasExplicitAllowList =
    Array.isArray(matter.restrictedAccessUserIds) &&
    matter.restrictedAccessUserIds.length > 0;
  const isRestricted = Boolean(matter.isStaffMatter) || hasExplicitAllowList;

  if (!isRestricted) {
    return true;
  }

  // 1. Dynamic oversight permission (`matter:restricted:access`)
  if (resolved.permissions.has('matter:restricted:access')) {
    return true;
  }

  const userId = resolved.actorUserId;

  // 2. Named matter participants on the matter record
  if (
    matter.responsiblePartnerId === userId ||
    matter.responsibleSolicitorId === userId ||
    matter.supervisingPartnerId === userId ||
    matter.leadFeeEarnerId === userId ||
    matter.originatingSolicitorId === userId
  ) {
    return true;
  }

  if (
    Array.isArray(matter.teamMemberIds) &&
    matter.teamMemberIds.includes(userId)
  ) {
    return true;
  }

  // 3. Explicit per-matter participant allowlist (`restrictedAccessUserIds`)
  if (
    hasExplicitAllowList &&
    matter.restrictedAccessUserIds!.includes(userId)
  ) {
    return true;
  }

  return false;
}

/**
 * Validates a proposed change to a target user's `permissionOverrides` or security `roles` (ADR-0015).
 * Enforces:
 * 1. Actor holds `rbac:manage_user_overrides` with MFA (`mfaVerified === true`).
 * 2. Actor is not modifying their own permissions or roles (`actorUserId !== targetPersonId`).
 * 3. Actor cannot grant a permission they do not themselves hold.
 */
export function validateUserOverrideOrRoleMutation(params: {
  actorPermissions: ResolvedPermissionSet;
  targetPersonId: string;
  addedPermissions?: readonly PermissionKey[];
  addedRoleKeys?: readonly string[];
  rbacConfig?: RbacConfiguration;
}): void {
  const { actorPermissions, targetPersonId } = params;

  requirePermission(
    actorPermissions,
    'rbac:manage_user_overrides',
    'modify user security roles or permission overrides',
  );

  if (actorPermissions.actorUserId === targetPersonId) {
    throw new AuthorisationError({
      code: 'SELF_MODIFICATION_FORBIDDEN',
      message:
        'Users cannot modify their own security roles or permission overrides.',
      tenantId: actorPermissions.tenantId,
      correlationId: actorPermissions.correlationId,
      actorUserId: actorPermissions.actorUserId,
      requiredPermission: 'rbac:manage_user_overrides',
    });
  }

  for (const perm of params.addedPermissions ?? []) {
    if (!actorPermissions.has(perm)) {
      throw new AuthorisationError({
        code: 'PRIVILEGE_ESCALATION_FORBIDDEN',
        message: `Cannot grant permission '${perm}' because the acting user does not hold it.`,
        tenantId: actorPermissions.tenantId,
        correlationId: actorPermissions.correlationId,
        actorUserId: actorPermissions.actorUserId,
        requiredPermission: perm,
      });
    }
  }

  if (params.addedRoleKeys?.length) {
    const rolesMap = params.rbacConfig?.roles ?? DEFAULT_RBAC_ROLES;
    for (const roleKey of params.addedRoleKeys) {
      const roleDef = rolesMap[roleKey as keyof typeof rolesMap];
      if (!roleDef) continue;
      for (const perm of roleDef.permissions) {
        if (!actorPermissions.has(perm)) {
          throw new AuthorisationError({
            code: 'PRIVILEGE_ESCALATION_FORBIDDEN',
            message: `Cannot assign role '${roleKey}' because it grants permission '${perm}' which the acting user does not hold.`,
            tenantId: actorPermissions.tenantId,
            correlationId: actorPermissions.correlationId,
            actorUserId: actorPermissions.actorUserId,
            requiredPermission: perm,
          });
        }
      }
    }
  }
}
