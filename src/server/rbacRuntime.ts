import 'server-only';

/**
 * Server-only RBAC runtime helpers (`src/server/rbacRuntime.ts`).
 *
 * Reads the active tenant configuration from `src/platform/tenantRuntime.ts`
 * directly without relying on side-effect registration callbacks.
 */

import {
  canAccessMatter,
  clearPermissionRequestCache,
  createDefaultRbacConfig,
  hasPermission,
  requirePermission,
  validateRbacConfig,
  type EntraIdRawTokenClaims,
  type PermissionKey,
  type RbacConfiguration,
  type ResolvedPermissionSet,
  type TenantConfiguration,
  type VerifiedOidcTokenClaims,
} from '@platform/core';
import {
  canUserAccessMatter as domainCanUserAccessMatter,
  filterEmploymentForUser as domainFilterEmploymentForUser,
  hasEmployeePermission as domainHasEmployeePermission,
  resolveConfiguredFirmPrimaryDomain as domainResolveConfiguredFirmPrimaryDomain,
  resolveEmployeePermissions as domainResolveEmployeePermissions,
} from '@/domain/employment';
import {
  canUserReopenEnquiry as domainCanUserReopenEnquiry,
} from '@/domain/enquiries';
import {
  getLeftRailVisibility as domainGetLeftRailVisibility,
  type LeftRailVisibility,
} from '@/domain/homeConfig';
import type {
  KeyDate,
  KeyDatePermission,
  KeyDatesConfig,
} from '@/domain/keyDates.types';
import {
  canUserVerifyKeyDate as domainCanUserVerifyKeyDate,
  canViewerAccessMatterKeyDates as domainCanViewerAccessMatterKeyDates,
  hasKeyDatePermission as domainHasKeyDatePermission,
  resolveKeyDatePermissions as domainResolveKeyDatePermissions,
  type ResolveKeyDatePermissionsOptions,
} from '@/domain/keyDates';
import {
  canUserViewFinance as domainCanUserViewFinance,
} from '@/domain/pms';
import {
  resolvePersonForEntraClaims as domainResolvePersonForEntraClaims,
  resolvePersonPermissionSet as domainResolvePersonPermissionSet,
  getActiveActorSession,
  mergeRbacConfigOverlay,
  type ResolvePersonPermissionsOptions,
} from '@/domain/rbac';
import {
  canUserReassignTask as domainCanUserReassignTask,
  canUserTakeTask as domainCanUserTakeTask,
  resolveUserAppRole as domainResolveUserAppRole,
} from '@/domain/tasks';
import type {
  AppRole,
  ChoiceValue,
  EmployeePermission,
  EmploymentRecord,
  Enquiry,
  Matter,
  OrgStructureCatalogue,
  Person,
  Task,
  Team,
} from '@/domain/types';

type PersonId = string;
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';

const tenantRbacConfigCacheByTenant = new Map<string, RbacConfiguration>();
const runtimeRbacConfigOverrideByTenant = new Map<string, RbacConfiguration>();

export function getServerTenantConfiguration(): Pick<
  TenantConfiguration,
  'tenantId' | 'displayName' | 'branding' | 'rbac'
> {
  return getActiveTenantConfiguration();
}

export function resolveConfiguredFirmPrimaryDomain(
  configOverride?: { branding?: { primaryDomain?: string } } | null,
): string {
  return domainResolveConfiguredFirmPrimaryDomain(
    configOverride !== undefined ? configOverride : getServerTenantConfiguration(),
  );
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

export function getDefaultTenantRbacConfig(
  tenantId?: string,
): RbacConfiguration {
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

export function resolveActiveTenantIdForRbac(
  explicitTenantId?: string,
): string {
  if (explicitTenantId && explicitTenantId.trim().length > 0) {
    return explicitTenantId.trim();
  }
  const sessionTenantId = getActiveActorSession()?.tenantId?.trim();
  if (sessionTenantId) {
    return sessionTenantId;
  }
  return getServerTenantConfiguration().tenantId;
}

export function withActiveTenantRbacOptions(
  options: ResolvePersonPermissionsOptions = {},
): ResolvePersonPermissionsOptions {
  const activeTenantId = resolveActiveTenantIdForRbac(
    options.tenantId ?? options.context?.tenantId,
  );
  const rbacConfig =
    options.config?.rbac ?? getDefaultTenantRbacConfig(activeTenantId);
  return {
    ...options,
    tenantId: activeTenantId,
    config: options.config ?? { rbac: rbacConfig },
    context: options.context
      ? { ...options.context, tenantId: activeTenantId }
      : { tenantId: activeTenantId },
  };
}

export function resolvePersonPermissionSet(
  user: Person | null | undefined,
  options: ResolvePersonPermissionsOptions = {},
): ResolvedPermissionSet {
  return domainResolvePersonPermissionSet(
    user,
    withActiveTenantRbacOptions(options),
  );
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
  if (!matter || !userId) return false;
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
  const rbacConfig =
    params.rbacConfig ?? getDefaultTenantRbacConfig(activeTenantId);
  return domainResolvePersonForEntraClaims({
    ...params,
    tenantId: activeTenantId,
    rbacConfig,
  });
}

export function resolveEmployeePermissions(
  user: Person | null | undefined,
  allPeople: Person[] = [],
  teams: Team[] = [],
  options: ResolvePersonPermissionsOptions = {},
): EmployeePermission[] {
  return domainResolveEmployeePermissions(
    user,
    allPeople,
    teams,
    withActiveTenantRbacOptions(options),
  );
}

export function hasEmployeePermission(
  user: Person | null | undefined,
  perm: EmployeePermission,
  allPeople: Person[] = [],
  teams: Team[] = [],
  options: ResolvePersonPermissionsOptions = {},
): boolean {
  return domainHasEmployeePermission(
    user,
    perm,
    allPeople,
    teams,
    withActiveTenantRbacOptions(options),
  );
}

export function filterEmploymentForUser(
  employment: EmploymentRecord | null | undefined,
  user: Person | null | undefined,
  allPeople: Person[] = [],
  teams: Team[] = [],
  orgStructure?: OrgStructureCatalogue,
  options: ResolvePersonPermissionsOptions = {},
): EmploymentRecord | null {
  return domainFilterEmploymentForUser(
    employment,
    user,
    allPeople,
    teams,
    orgStructure,
    withActiveTenantRbacOptions(options),
  );
}

export function canUserAccessMatter(
  matter: Matter,
  userId: string,
  user?: Person | null,
  options: ResolvePersonPermissionsOptions = {},
): boolean {
  return domainCanUserAccessMatter(
    matter,
    userId,
    user,
    withActiveTenantRbacOptions(options),
  );
}

export function getLeftRailVisibility(
  activeRole: string,
  userRoles: string[] = [activeRole],
  options: {
    config?: { rbac?: RbacConfiguration };
    tenantId?: string;
  } = {},
): LeftRailVisibility {
  const activeTenantId = resolveActiveTenantIdForRbac(options.tenantId);
  const rbacConfig =
    options.config?.rbac ?? getDefaultTenantRbacConfig(activeTenantId);
  return domainGetLeftRailVisibility(activeRole, userRoles, {
    tenantId: activeTenantId,
    config: { rbac: rbacConfig },
  });
}

export function resolveUserAppRole(
  person: Person | null | undefined,
  teams: Team[],
  values: ChoiceValue[] = [],
  options: ResolvePersonPermissionsOptions = {},
): AppRole {
  return domainResolveUserAppRole(
    person,
    teams,
    values,
    withActiveTenantRbacOptions(options),
  );
}

export function canUserReassignTask(
  userId: string,
  task: Task,
  teams: Team[],
  people: Person[],
  values: ChoiceValue[] = [],
  userPermissions?: Iterable<string>,
  options: ResolvePersonPermissionsOptions = {},
): boolean {
  return domainCanUserReassignTask(
    userId,
    task,
    teams,
    people,
    values,
    userPermissions,
    withActiveTenantRbacOptions(options),
  );
}

export function canUserTakeTask(
  userId: string,
  task: Task,
  teams: Team[],
  people: Person[],
  values: ChoiceValue[] = [],
  userPermissions?: Iterable<string>,
  options: ResolvePersonPermissionsOptions = {},
): boolean {
  return domainCanUserTakeTask(
    userId,
    task,
    teams,
    people,
    values,
    userPermissions,
    withActiveTenantRbacOptions(options),
  );
}

export function canUserViewFinance(
  user: Person | null | undefined,
  teams: Team[],
  values: ChoiceValue[] = [],
  options: ResolvePersonPermissionsOptions = {},
): boolean {
  return domainCanUserViewFinance(
    user,
    teams,
    values,
    withActiveTenantRbacOptions(options),
  );
}

export function canUserReopenEnquiry(
  userId: string,
  enquiry: Enquiry,
  teams: Team[],
  people: Person[],
  values: ChoiceValue[],
  options: ResolvePersonPermissionsOptions = {},
): boolean {
  return domainCanUserReopenEnquiry(
    userId,
    enquiry,
    teams,
    people,
    values,
    withActiveTenantRbacOptions(options),
  );
}

function normalizeKeyDateOptionsForServer(
  secondArg?:
    | ResolveKeyDatePermissionsOptions
    | KeyDatesConfig
    | readonly Person[]
    | null,
  thirdArg?: readonly Team[],
): ResolveKeyDatePermissionsOptions {
  const base: ResolveKeyDatePermissionsOptions = !secondArg
    ? { teams: thirdArg ?? [] }
    : Array.isArray(secondArg)
      ? { allPeople: secondArg, teams: thirdArg ?? [] }
      : 'enabled' in secondArg || 'keyDateTypes' in secondArg
        ? { config: secondArg as KeyDatesConfig, teams: thirdArg ?? [] }
        : (secondArg as ResolveKeyDatePermissionsOptions);
  return {
    ...base,
    rbac: withActiveTenantRbacOptions(base.rbac),
  };
}

export function resolveKeyDatePermissions(
  user: Person | null | undefined,
  optionsOrPeople?:
    | ResolveKeyDatePermissionsOptions
    | KeyDatesConfig
    | readonly Person[]
    | null,
  teamsArg?: readonly Team[],
): KeyDatePermission[] {
  return domainResolveKeyDatePermissions(
    user,
    normalizeKeyDateOptionsForServer(optionsOrPeople, teamsArg),
  );
}

export function hasKeyDatePermission(
  user: Person | null | undefined,
  perm: KeyDatePermission,
  optionsOrPeople?:
    | ResolveKeyDatePermissionsOptions
    | KeyDatesConfig
    | readonly Person[]
    | null,
  teamsArg?: readonly Team[],
): boolean {
  return domainHasKeyDatePermission(
    user,
    perm,
    normalizeKeyDateOptionsForServer(optionsOrPeople, teamsArg),
  );
}

export function canUserVerifyKeyDate(
  verifier: Person | null | undefined,
  keyDate: Pick<KeyDate, 'status' | 'verification' | 'createdById'>,
  options?: ResolveKeyDatePermissionsOptions | KeyDatesConfig | null,
): { allowed: boolean; reason?: string } {
  return domainCanUserVerifyKeyDate(
    verifier,
    keyDate,
    normalizeKeyDateOptionsForServer(options),
  );
}

export function canViewerAccessMatterKeyDates(
  matter:
    | Pick<Matter, 'id' | 'isStaffMatter' | 'restrictedAccessUserIds'>
    | null
    | undefined,
  viewerUserId: PersonId | Person | null | undefined,
  viewerPerson?: Person | null,
  people?: readonly Person[],
  options: ResolvePersonPermissionsOptions = {},
): boolean {
  return domainCanViewerAccessMatterKeyDates(
    matter,
    viewerUserId,
    viewerPerson,
    people,
    withActiveTenantRbacOptions(options),
  );
}

export * from '@/domain/rbac';
