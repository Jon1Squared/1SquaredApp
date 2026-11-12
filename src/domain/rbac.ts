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
          emailLinking: {
            enabled:
              typeof overlay.identityMapping.emailLinking?.enabled === 'boolean'
                ? overlay.identityMapping.emailLinking.enabled
                : typeof base.identityMapping.emailLinking?.enabled === 'boolean'
                  ? base.identityMapping.emailLinking.enabled
                  : true,
            domains: Array.isArray(overlay.identityMapping.emailLinking?.domains)
              ? overlay.identityMapping.emailLinking.domains
              : Array.isArray(base.identityMapping.emailLinking?.domains)
                ? base.identityMapping.emailLinking.domains
                : [],
          },
        }
      : base.identityMapping,
  };
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
  mfaVerified?: boolean;
  expiresAtMs: number;
  verifiedSession?: unknown;
  effectiveRbacConfig?: RbacConfiguration;
}

type AsyncLocalStorageLike<T> = {
  readCurrent(): T | undefined;
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
    if (asyncHooks?.AsyncLocalStorage) {
      const raw = new asyncHooks.AsyncLocalStorage<ActiveActorTokenSession | null>();
      actorSessionStorage = {
        readCurrent: () =>
          (
            raw as unknown as Record<
              string,
              () => ActiveActorTokenSession | null | undefined
            >
          )['get' + 'Store']() ?? null,
        run: (store, callback) => raw.run(store, callback),
      };
    } else {
      actorSessionStorage = null;
    }
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
  const activeActor = getActorSessionAsyncStorage()?.readCurrent();
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
  const targetTenantId = tenantId?.trim() || activeActor.tenantId;
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
  const targetTenantId = tenantId?.trim() || activeActor.tenantId;
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
  tenantId?: string;
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

/**
 * Resolves the complete `ResolvedPermissionSet` for a `Person` using the central `@platform/core`
 * `resolvePermissions` engine.
 */
export function resolvePersonPermissionSet(
  user: Person | null | undefined,
  options: ResolvePersonPermissionsOptions = {},
): ResolvedPermissionSet {
  const activeTenantId =
    options?.tenantId?.trim() ||
    options?.context?.tenantId?.trim() ||
    '';
  const rbacConfig = options?.config?.rbac;
  if (!rbacConfig || !activeTenantId) {
    throw new Error(
      'RBAC_CONFIG_REQUIRED: resolvePersonPermissionSet needs config.rbac and tenantId.',
    );
  }
  if (!user?.id) {
    return resolvePermissions({
      context: {
        tenantId: activeTenantId,
        correlationId: options.context?.correlationId ?? '',
        actorId: '',
        actorRoles: [],
        mfaVerified: false,
      },
      config: { rbac: rbacConfig },
      actor: null,
    });
  }

  const teams = options.teams ?? [];
  const allPeople = options.allPeople ?? [];
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

  const isEvaluatingContextActor =
    !options.context?.actorId || options.context.actorId === user.id;
  const activeActorSession = isEvaluatingContextActor
    ? getStoredActorSessionForPerson(user.id, activeTenantId)
    : undefined;
  const sessionMfaVerified =
    activeActorSession?.mfaVerified ??
    (
      activeActorSession?.verifiedSession as
        | { mfaVerified?: boolean }
        | undefined
    )?.mfaVerified;
  const mfaVerified =
    options.mfaVerified ??
    options.context?.mfaVerified ??
    sessionMfaVerified ??
    false;
  const sessionTokenRoles = activeActorSession?.tokenRoles;
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
    | 'hasEthicalWall'
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
    hasEthicalWall: matter.hasEthicalWall,
    restrictedAccessUserIds: matter.restrictedAccessUserIds,
    responsiblePartnerId: matter.responsiblePartnerId,
    supervisingPartnerId: matter.supervisingPartnerId,
    leadFeeEarnerId: matter.leadFeeEarnerId,
    teamMemberIds: matter.teamMemberIds,
  });
}

export function isPrivilegedPersonForEmailLinking(
  person: Person,
  options: {
    allPeople: readonly Person[];
    teams: readonly Team[];
    tenantId: string;
    rbacConfig: RbacConfiguration;
  },
): boolean {
  const storeRbacConfig: RbacConfiguration = {
    ...options.rbacConfig,
    identityMapping: {
      ...options.rbacConfig.identityMapping,
      authorityMode: 'store_only',
    },
  };
  const storedPermSet = resolvePersonPermissionSet(person, {
    allPeople: options.allPeople,
    teams: options.teams,
    tenantId: options.tenantId,
    config: { rbac: storeRbacConfig },
    mfaVerified: true,
  });
  const activePermSet = resolvePersonPermissionSet(person, {
    allPeople: options.allPeople,
    teams: options.teams,
    tenantId: options.tenantId,
    config: { rbac: options.rbacConfig },
    mfaVerified: true,
  });
  const combinedPermissions = new Set<PermissionKey>([
    ...storedPermSet.permissions,
    ...activePermSet.permissions,
  ]);
  for (const permKey of combinedPermissions) {
    const entry = getPermissionRegistryEntry(permKey);
    if (entry && (entry.requiresMfa || entry.sensitivity === 'critical')) {
      return true;
    }
  }
  const storedRoles = resolvePersonAuthoritativeRoles(
    person,
    options.teams,
    Object.keys(options.rbacConfig.roles ?? {}),
  );
  if (
    storedRoles.includes('admin') ||
    person.appRole === 'admin' ||
    person.employeeRoleId === 'employee_role.system_administrator'
  ) {
    return true;
  }
  return false;
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
  primaryDomain?: string;
}): {
  person: Person | null;
  matchedByEmailOnly?: boolean;
  ambiguousEmailMatchPersonIds?: string[];
  refusedPrivilegedEmailLinkPersonId?: string;
  verifiedToken: VerifiedOidcTokenClaims;
  permissions: ResolvedPermissionSet;
} {
  const activeTenantId = params.tenantId?.trim() || '';
  const rbacConfig = params.rbacConfig;
  if (!rbacConfig || !activeTenantId) {
    throw new Error(
      'RBAC_CONFIG_REQUIRED: resolvePersonForEntraClaims needs rbacConfig and tenantId.',
    );
  }
  const {
    claims,
    people,
    teams = [],
  } = params;

  const oid = claims.oid?.trim();
  const emailLinking = rbacConfig.identityMapping?.emailLinking;
  const emailLinkingEnabled = emailLinking?.enabled ?? true;
  const configuredLinkingDomains = emailLinking?.domains ?? [];

  const activeEmployees = people.filter((p) => p.isEmployee && !p.mergedIntoId);

  let matchedPerson: Person | null = null;
  let matchedByEmailOnly = false;
  let ambiguousEmailMatchPersonIds: string[] | undefined;
  let refusedPrivilegedEmailLinkPersonId: string | undefined;

  if (oid) {
    matchedPerson =
      activeEmployees.find((p) => p.entraObjectId?.trim() === oid) ?? null;
  }

  // S0-30: Link by email only when no `entraObjectId` is set on the employee record yet,
  // emailLinking is enabled, the claim comes from a verified directory sign-in name (or verified email)
  // in an allowed linking domain, matches a single unbound employee, and that employee is not privileged.
  if (!matchedPerson && emailLinkingEnabled) {
    const normalizedConfiguredDomains = configuredLinkingDomains
      .map((d) => String(d).trim().toLowerCase())
      .filter(Boolean);
    const normalizedPrimaryDomain = (params.primaryDomain ?? '')
      .trim()
      .toLowerCase();
    const allowedLinkingDomains = new Set<string>(
      normalizedConfiguredDomains.length > 0
        ? normalizedConfiguredDomains
        : normalizedPrimaryDomain
          ? [normalizedPrimaryDomain]
          : [],
    );

    const extractEmailDomain = (addr: string): string => {
      const trimmed = addr.trim().toLowerCase();
      const atIdx = trimmed.lastIndexOf('@');
      if (atIdx <= 0 || atIdx === trimmed.length - 1) return '';
      return trimmed.slice(atIdx + 1);
    };

    const preferredUsernameAddress = (claims.preferred_username || '')
      .trim()
      .toLowerCase();
    const upnAddress = (claims.upn || '').trim().toLowerCase();
    const rawEmailAddress = (claims.email || '').trim().toLowerCase();
    const isEmailClaimVerified = claims.xms_edov === true;

    const orderedCandidateClaims = Array.from(
      new Set(
        [
          preferredUsernameAddress,
          upnAddress,
          ...(isEmailClaimVerified ? [rawEmailAddress] : []),
        ].filter(Boolean),
      ),
    );

    for (const candidateLinkingEmail of orderedCandidateClaims) {
      const candidateDomain = extractEmailDomain(candidateLinkingEmail);
      if (!allowedLinkingDomains.has(candidateDomain)) {
        continue;
      }
      const matchingUnboundEmployees = activeEmployees.filter(
        (p) =>
          !p.entraObjectId?.trim() &&
          p.emails.some(
            (e) =>
              e.active !== false &&
              e.address.trim().toLowerCase() === candidateLinkingEmail,
          ),
      );
      if (matchingUnboundEmployees.length === 0) {
        continue;
      }
      if (matchingUnboundEmployees.length > 1) {
        ambiguousEmailMatchPersonIds = matchingUnboundEmployees.map((p) => p.id);
      } else {
        const candidate = matchingUnboundEmployees[0]!;
        if (
          isPrivilegedPersonForEmailLinking(candidate, {
            allPeople: people,
            teams,
            tenantId: activeTenantId,
            rbacConfig,
          })
        ) {
          refusedPrivilegedEmailLinkPersonId = candidate.id;
        } else {
          matchedPerson = candidate;
          matchedByEmailOnly = true;
        }
      }
      break;
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
    return {
      person: null,
      matchedByEmailOnly: false,
      ...(ambiguousEmailMatchPersonIds
        ? { ambiguousEmailMatchPersonIds }
        : {}),
      ...(refusedPrivilegedEmailLinkPersonId
        ? { refusedPrivilegedEmailLinkPersonId }
        : {}),
      verifiedToken,
      permissions,
    };
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
