/**
 * Inheritance-Based Document Security Model & Permission Compiler (`core/src/domain/documents/security.ts`).
 *
 * Implements Section 3 & ADR-0019:
 * - Library root, department folder, and team folder permission compilation using Entra security groups.
 * - Matter folder permission compilation:
 *   - Inherits by default (`inherit: true`) when open, non-restricted, and all matter team members
 *     belong to the owning team.
 *   - Breaks inheritance (`inherit: false`) ONLY for:
 *     1. Restricted matters (`isRestricted`: removes department & team group grants; grants only
 *        `restrictedAccessUserIds` and `restrictedMatter.groups`).
 *     2. Matter team members outside the owning team (keeps department & team group grants and adds
 *        only the outsider user IDs).
 *     3. Closed matters when `closedMatter` policy is `'read'` (downgrades edit/contribute grants to `'read'`).
 *   - Restores inheritance (`inherit: true`) as soon as all exceptions end.
 * - Scale guard tracking unique permission scopes per library against `uniqueScopeWarningThreshold` (default 4,000).
 */

import type {
  DocumentAccessConfig,
  DocumentAccessLevel,
  DocumentAccessPolicyConfig,
  DocumentPermissionGrant,
} from '../../api/index';
import type {
  IntendedFolderPermissionPlan,
  LibraryScopeScaleStatus,
  MatterRoutingSubject,
} from './types';

export const DEFAULT_UNIQUE_SCOPE_WARNING_THRESHOLD = 4000;
export const SHAREPOINT_RECOMMENDED_UNIQUE_SCOPE_LIMIT = 5000;
export const SHAREPOINT_HARD_UNIQUE_SCOPE_LIMIT = 50000;

export const DEFAULT_DOCUMENT_ACCESS_POLICY: DocumentAccessPolicyConfig = {
  libraryRoot: [],
  owningDepartment: 'read',
  owningTeam: 'edit',
  otherDepartments: 'none',
  matterTeamOutsider: 'edit',
  restrictedMatter: {
    allowedUserLevel: 'edit',
    groups: [],
  },
  closedMatter: 'read',
};

export function resolveStoreAccessPolicy(
  accessConfig: DocumentAccessConfig,
  storeId: string,
): DocumentAccessPolicyConfig {
  return (
    accessConfig.policiesByStore?.[storeId] ??
    accessConfig.defaultPolicy ??
    DEFAULT_DOCUMENT_ACCESS_POLICY
  );
}

/**
 * Resolves the Entra group Object ID for a 1Squared department ID from tenant configuration.
 */
export function resolveDepartmentEntraGroupId(
  accessConfig: DocumentAccessConfig,
  departmentId: string,
): string | null {
  return accessConfig.departmentEntraGroups[departmentId] ?? null;
}

/**
 * Resolves the Entra group Object ID for a 1Squared team ID from tenant configuration.
 */
export function resolveTeamEntraGroupId(
  accessConfig: DocumentAccessConfig,
  teamId: string,
): string | null {
  return accessConfig.teamEntraGroups[teamId] ?? null;
}

/**
 * Compiles the intended permission grants at the document library root.
 */
export function compileLibraryRootPermissions(params: {
  accessConfig: DocumentAccessConfig;
  storeId: string;
}): DocumentPermissionGrant[] {
  const policy = resolveStoreAccessPolicy(params.accessConfig, params.storeId);
  const grants: DocumentPermissionGrant[] = [];

  for (const rule of policy.libraryRoot ?? []) {
    if (rule.level === 'none') continue;
    grants.push({
      principal: {
        principalType: 'group',
        entraObjectId: rule.groupId,
        displayName: rule.description ?? `Library Root Group (${rule.groupId})`,
      },
      level: rule.level,
    });
  }

  return deduplicatePermissionGrants(grants);
}

/**
 * Compiles the intended permission grants on a `{departmentCode}` folder.
 * Breaks inheritance from the library root if `owningDepartment` level is not `'none'` or if
 * libraryRoot grants differ.
 */
export function compileDepartmentFolderPermissions(params: {
  accessConfig: DocumentAccessConfig;
  storeId: string;
  departmentId: string;
}): {
  inherit: boolean;
  grants: DocumentPermissionGrant[];
} {
  const policy = resolveStoreAccessPolicy(params.accessConfig, params.storeId);
  const grants: DocumentPermissionGrant[] = [
    ...compileLibraryRootPermissions(params),
  ];

  const deptGroupId = resolveDepartmentEntraGroupId(
    params.accessConfig,
    params.departmentId,
  );
  if (deptGroupId && policy.owningDepartment !== 'none') {
    grants.push({
      principal: {
        principalType: 'group',
        entraObjectId: deptGroupId,
         internalId: params.departmentId,
        displayName: `Department ${params.departmentId}`,
      },
      level: policy.owningDepartment,
    });
  }

  if (policy.otherDepartments !== 'none') {
    for (const [otherDeptId, otherGroupId] of Object.entries(
      params.accessConfig.departmentEntraGroups,
    )) {
      if (otherDeptId === params.departmentId) continue;
      grants.push({
        principal: {
          principalType: 'group',
          entraObjectId: otherGroupId,
          internalId: otherDeptId,
          displayName: `Department ${otherDeptId}`,
        },
        level: policy.otherDepartments,
      });
    }
  }

  return {
    inherit: false,
    grants: deduplicatePermissionGrants(grants),
  };
}

/**
 * Compiles the intended permission grants on a `{departmentCode}/{teamCode}` folder.
 */
export function compileTeamFolderPermissions(params: {
  accessConfig: DocumentAccessConfig;
  storeId: string;
  departmentId: string;
  teamId: string;
}): {
  inherit: boolean;
  grants: DocumentPermissionGrant[];
} {
  const policy = resolveStoreAccessPolicy(params.accessConfig, params.storeId);
  const deptPlan = compileDepartmentFolderPermissions({
    accessConfig: params.accessConfig,
    storeId: params.storeId,
    departmentId: params.departmentId,
  });

  const grants: DocumentPermissionGrant[] = [...deptPlan.grants];
  const teamGroupId = resolveTeamEntraGroupId(
    params.accessConfig,
    params.teamId,
  );

  if (teamGroupId && policy.owningTeam !== 'none') {
    grants.push({
      principal: {
        principalType: 'group',
        entraObjectId: teamGroupId,
        internalId: params.teamId,
        displayName: `Team ${params.teamId}`,
      },
      level: policy.owningTeam,
    });
  }

  return {
    inherit: false,
    grants: deduplicatePermissionGrants(grants),
  };
}

/**
 * Determines which members of `matterTeamMemberIds` are outside the owning team (`owningTeamMemberIds`).
 */
export function findMatterTeamOutsiderUserIds(
  owningTeamMemberIds: readonly string[],
  matterTeamMemberIds: readonly string[],
): string[] {
  const owningSet = new Set(owningTeamMemberIds);
  const outsiders: string[] = [];
  const seen = new Set<string>();

  for (const userId of matterTeamMemberIds) {
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    if (!owningSet.has(userId)) {
      outsiders.push(userId);
    }
  }

  return outsiders;
}

function downgradeToReadIfClosed(
  level: DocumentAccessLevel,
  isClosed: boolean,
  closedPolicy: DocumentAccessLevel,
): DocumentAccessLevel {
  if (!isClosed || closedPolicy === 'none') return level;
  if (level === 'manage') return 'manage';
  return closedPolicy;
}

/**
 * Compiles the intended permission plan for a matter folder:
 * - Standard open matter with no outsiders and not restricted -> `inherit: true` (0 unique scopes consumed).
 * - Restricted matter (`subject.isRestricted`) -> `inherit: false`, removes department/team groups,
 *   grants only `restrictedAccessUserIds` + `restrictedMatter.groups`.
 * - Matter team outsiders (`outsiderUserIds.length > 0`) -> `inherit: false`, keeps department/team group
 *   grants and adds individual outsider user grants.
 * - Closed matter (`subject.isClosed`) -> `inherit: false`, downgrades write grants to `policy.closedMatter` (`'read'`).
 */
export function compileMatterFolderPermissions(params: {
  accessConfig: DocumentAccessConfig;
  storeId: string;
  subject: MatterRoutingSubject;
  resolveUserEntraObjectId: (userId: string) => {
    entraObjectId: string;
    upn?: string;
    displayName?: string;
  } | null;
}): IntendedFolderPermissionPlan {
  const { accessConfig, storeId, subject, resolveUserEntraObjectId } = params;
  const policy = resolveStoreAccessPolicy(accessConfig, storeId);

  const outsiderUserIds = findMatterTeamOutsiderUserIds(
    subject.owningTeamMemberIds,
    subject.matterTeamMemberIds,
  );

  // Case 1: Restricted matter (highest precedence — ethical wall or staff matter)
  if (subject.isRestricted) {
    const restrictedGrants: DocumentPermissionGrant[] = [];
    const allowedUserLevel = downgradeToReadIfClosed(
      policy.restrictedMatter.allowedUserLevel,
      subject.isClosed,
      policy.closedMatter,
    );

    const allowedUsers = new Set<string>([
      ...subject.restrictedAccessUserIds,
      ...subject.matterTeamMemberIds,
    ]);

    if (allowedUserLevel !== 'none') {
      for (const userId of allowedUsers) {
        const resolved = resolveUserEntraObjectId(userId);
        if (!resolved) continue;
        restrictedGrants.push({
          principal: {
            principalType: 'user',
            entraObjectId: resolved.entraObjectId,
            internalId: userId,
            upn: resolved.upn,
            displayName: resolved.displayName ?? userId,
          },
          level: allowedUserLevel,
        });
      }
    }

    for (const groupRule of policy.restrictedMatter.groups ?? []) {
      if (groupRule.level === 'none') continue;
      restrictedGrants.push({
        principal: {
          principalType: 'group',
          entraObjectId: groupRule.groupId,
          displayName:
            groupRule.description ??
            `Restricted Oversight Group (${groupRule.groupId})`,
        },
        level: downgradeToReadIfClosed(
          groupRule.level,
          subject.isClosed,
          policy.closedMatter,
        ),
      });
    }

    return {
      inherit: false,
      reason: 'restricted_matter',
      grants: deduplicatePermissionGrants(restrictedGrants),
      outsiderUserIds,
      consumesUniqueScope: true,
    };
  }

  // Case 2: Standard inherited permissions (not restricted, not closed, no outsiders)
  if (!subject.isClosed && outsiderUserIds.length === 0) {
    const inheritedTeamPlan = compileTeamFolderPermissions({
      accessConfig,
      storeId,
      departmentId: subject.departmentId,
      teamId: subject.teamId,
    });

    return {
      inherit: true,
      reason: 'inherited_standard',
      grants: inheritedTeamPlan.grants,
      outsiderUserIds: [],
      consumesUniqueScope: false,
    };
  }

  // Case 3 or 4: Matter has team outsiders and/or is closed
  const baseTeamPlan = compileTeamFolderPermissions({
    accessConfig,
    storeId,
    departmentId: subject.departmentId,
    teamId: subject.teamId,
  });

  const grants: DocumentPermissionGrant[] = baseTeamPlan.grants.map((g) => ({
    principal: g.principal,
    level: downgradeToReadIfClosed(
      g.level,
      subject.isClosed,
      policy.closedMatter,
    ),
  }));

  if (outsiderUserIds.length > 0 && policy.matterTeamOutsider !== 'none') {
    const outsiderLevel = downgradeToReadIfClosed(
      policy.matterTeamOutsider,
      subject.isClosed,
      policy.closedMatter,
    );

    for (const outsiderId of outsiderUserIds) {
      const resolved = resolveUserEntraObjectId(outsiderId);
      if (!resolved) continue;
      grants.push({
        principal: {
          principalType: 'user',
          entraObjectId: resolved.entraObjectId,
          internalId: outsiderId,
          upn: resolved.upn,
          displayName: resolved.displayName ?? outsiderId,
        },
        level: outsiderLevel,
      });
    }
  }

  return {
    inherit: false,
    reason: subject.isClosed
      ? 'closed_matter_readonly'
      : 'matter_team_outsiders',
    grants: deduplicatePermissionGrants(grants),
    outsiderUserIds,
    consumesUniqueScope: true,
  };
}

const LEVEL_RANK: Record<DocumentAccessLevel, number> = {
  none: 0,
  read: 1,
  contribute: 2,
  edit: 3,
  manage: 4,
};

/**
 * Deduplicates grants by `(principalType, entraObjectId)`, keeping the highest access level when
 * a principal appears more than once (for example, both in library root and department).
 */
export function deduplicatePermissionGrants(
  grants: readonly DocumentPermissionGrant[],
): DocumentPermissionGrant[] {
  const byKey = new Map<string, DocumentPermissionGrant>();
  for (const grant of grants) {
    if (grant.level === 'none') continue;
    const key = `${grant.principal.principalType}:${grant.principal.entraObjectId}`;
    const existing = byKey.get(key);
    if (!existing || LEVEL_RANK[grant.level] > LEVEL_RANK[existing.level]) {
      byKey.set(key, grant);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Evaluates a library's unique permission scope count against the configured warning threshold
 * (default 4,000) and SharePoint's 5,000 recommended / 50,000 hard limits.
 */
export function evaluateLibraryScopeScaleStatus(params: {
  storeId: string;
  libraryId: string;
  warningThreshold?: number;
  departmentScopes: number;
  teamScopes: number;
  matterExceptionScopes: number;
  templateOverrideScopes: number;
}): LibraryScopeScaleStatus {
  const warningThreshold =
    params.warningThreshold ?? DEFAULT_UNIQUE_SCOPE_WARNING_THRESHOLD;
  const uniqueScopeCount =
    params.departmentScopes +
    params.teamScopes +
    params.matterExceptionScopes +
    params.templateOverrideScopes;
  const exceedsWarningThreshold = uniqueScopeCount >= warningThreshold;

  let warningMessage: string | null = null;
  if (uniqueScopeCount >= SHAREPOINT_RECOMMENDED_UNIQUE_SCOPE_LIMIT) {
    warningMessage = `Library "${params.libraryId}" has ${uniqueScopeCount} unique permission scopes, exceeding SharePoint's recommended limit of ${SHAREPOINT_RECOMMENDED_UNIQUE_SCOPE_LIMIT}. Split routing across additional document libraries or reduce per-matter permission exceptions.`;
  } else if (exceedsWarningThreshold) {
    warningMessage = `Library "${params.libraryId}" has ${uniqueScopeCount} unique permission scopes, approaching the warning threshold of ${warningThreshold} (SharePoint recommended limit: ${SHAREPOINT_RECOMMENDED_UNIQUE_SCOPE_LIMIT}).`;
  }

  return {
    storeId: params.storeId,
    libraryId: params.libraryId,
    uniqueScopeCount,
    warningThreshold,
    hardLimit: SHAREPOINT_HARD_UNIQUE_SCOPE_LIMIT,
    recommendedLimit: SHAREPOINT_RECOMMENDED_UNIQUE_SCOPE_LIMIT,
    exceedsWarningThreshold,
    breakdown: {
      departmentScopes: params.departmentScopes,
      teamScopes: params.teamScopes,
      matterExceptionScopes: params.matterExceptionScopes,
      templateOverrideScopes: params.templateOverrideScopes,
    },
    warningMessage,
  };
}
