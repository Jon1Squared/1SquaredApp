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
  resolveConfiguredFirmPrimaryDomain as domainResolveConfiguredFirmPrimaryDomain,
} from '@/domain/employment';
import {
  resolvePersonForEntraClaims as domainResolvePersonForEntraClaims,
  resolvePersonPermissionSet as domainResolvePersonPermissionSet,
  getActiveActorSession,
  getRbacRuntimeCacheMaps,
  mergeRbacConfigOverlay,
  type ResolvePersonPermissionsOptions,
} from '@/domain/rbac';
import type { Matter, Person, Team } from '@/domain/types';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';

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
  const { tenantRbacConfigCacheByTenant, runtimeRbacConfigOverrideByTenant } =
    getRbacRuntimeCacheMaps();
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
  const { tenantRbacConfigCacheByTenant, runtimeRbacConfigOverrideByTenant } =
    getRbacRuntimeCacheMaps();
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

function withActiveTenantRbacOptions(
  options: ResolvePersonPermissionsOptions = {},
): ResolvePersonPermissionsOptions {
  const activeTenantId = resolveActiveTenantIdForRbac(
    options.context?.tenantId,
  );
  const rbacConfig =
    options.config?.rbac ?? getDefaultTenantRbacConfig(activeTenantId);
  return {
    ...options,
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

export * from '@/domain/rbac';
