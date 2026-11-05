/**
 * Document generation RBAC & record-level access enforcement (`core/src/domain/document-generation/permissions.ts`).
 *
 * Rules enforced (ADR-0004, ADR-0010, ADR-0011, ADR-0014, ADR-0015 & Platform Architecture Standard):
 * 1. Delegates all permission resolution to the single central resolver (`resolvePermissions` in `core/src/domain/rbac/`).
 * 2. Resolves permissions from the user's FULL authenticated role set (`actorRoles` / `roles`),
 *    NEVER from the transient UI "Viewing as" role (`activeViewingRole`).
 * 3. Role-to-permission mappings come from `TenantConfiguration.rbac.roles` (with transitional fallback for
 *    deprecated `documentGeneration.permissions.roleDefaults`).
 * 4. Record-level access respects restricted staff matters (`matter:restricted:access` + named participants via `canAccessMatter`),
 *    and documents linked to a restricted matter inherit that restriction even on Client screens.
 */

import type {
  DocumentGenerationConfig,
  DocumentPermission,
  GeneratedDocumentRecord,
  HomeRoleKey,
  PersonPermissionOverrides,
  RbacConfiguration,
  TenantConfiguration,
} from '../../api/index';
import { ALL_HOME_ROLE_KEYS } from '../../config-engine/index';
import {
  ALL_DOCUMENT_PERMISSIONS,
  canAccessMatter,
  resolveAuthoritativeRoles,
  resolvePermissions,
  createDefaultRbacConfig,
} from '../rbac/index';

export { ALL_DOCUMENT_PERMISSIONS };

export interface DocumentPermissionActor {
  readonly id: string;
  /** Required tenant ID for tenant-scoped RBAC resolution. */
  readonly tenantId: string;
  /** Stored role keys for the user (from Person.roles). */
  readonly roles?: readonly string[];
  /** Verified token role claims (from TenantContext.actorRoles). */
  readonly tokenRoles?: readonly string[];
  /** Unified per-person permission overrides (`grant` / `revoke`, ADR-0015). */
  readonly permissionOverrides?: PersonPermissionOverrides | null;
  /**
   * @deprecated Transitional explicit per-user permission override (`Person.documentPermissions`).
   * Automatically migrated to `permissionOverrides.grant` by `resolvePermissions`.
   */
  readonly documentPermissions?: readonly DocumentPermission[];
  /** Optional department ID for department-granted permissions (`rbac.departmentGrants`). */
  readonly departmentId?: string | null;
  /** Optional MFA verification flag for critical permissions. */
  readonly mfaVerified?: boolean;
  /**
   * Optional UI-only "Viewing as" role. Explicitly ignored by permission resolution
   * to guarantee authorization always uses the actor's true underlying role set (ADR-0013).
   */
  readonly activeViewingRole?: string;
}

export interface MatterAccessSubject {
  readonly id: string;
  readonly clientId?: string | null;
  readonly isStaffMatter?: boolean;
  readonly restrictedAccessUserIds?: readonly string[];
  readonly responsiblePartnerId?: string | null;
  readonly responsibleSolicitorId?: string | null;
  readonly originatingSolicitorId?: string | null;
  readonly supervisingPartnerId?: string | null;
  readonly leadFeeEarnerId?: string | null;
  readonly teamMemberIds?: readonly string[];
}

export type DocumentRbacConfigInput =
  | Pick<TenantConfiguration, 'rbac' | 'documentGeneration'>
  | Pick<TenantConfiguration, 'rbac'>
  | Pick<TenantConfiguration, 'documentGeneration'>
  | DocumentGenerationConfig
  | null
  | undefined;

function normaliseConfigForResolver(config?: DocumentRbacConfigInput): {
  rbac?: RbacConfiguration;
  documentGeneration?: TenantConfiguration['documentGeneration'];
} | null {
  if (!config) return null;
  if ('rbac' in config || 'documentGeneration' in config) {
    return config as {
      rbac?: RbacConfiguration;
      documentGeneration?: TenantConfiguration['documentGeneration'];
    };
  }
  if ('permissions' in config) {
    return {
      documentGeneration: config as TenantConfiguration['documentGeneration'],
    };
  }
  return null;
}

export function normaliseActorHomeRoles(
  actor: DocumentPermissionActor | null | undefined,
  config?: DocumentRbacConfigInput,
): HomeRoleKey[] {
  if (!actor) {
    return [];
  }
  const normalisedConfig = normaliseConfigForResolver(config);
  const rbacConfig = normalisedConfig?.rbac ?? createDefaultRbacConfig();
  const validRoleSet = new Set<string>([
    ...ALL_HOME_ROLE_KEYS,
    ...Object.keys(rbacConfig.roles ?? {}),
  ]);
  const authoritative = resolveAuthoritativeRoles(
    {
      userId: actor.id,
      roles: actor.roles,
    },
    rbacConfig,
    actor.tokenRoles ?? [],
  );
  return authoritative.filter((r) => validRoleSet.has(r)) as HomeRoleKey[];
}

function resolveDocGenTenantId(
  actor: DocumentPermissionActor | null | undefined,
  config?: DocumentRbacConfigInput,
): string {
  const tenantId = actor?.tenantId?.trim() ?? '';
  if (!tenantId) {
    throw new Error(
      'RBAC_TENANT_REQUIRED: Document permission resolution requires a non-empty tenantId on DocumentPermissionActor.',
    );
  }
  const cfgTenantId =
    config &&
    typeof config === 'object' &&
    'tenantId' in config &&
    typeof (config as { tenantId?: unknown }).tenantId === 'string'
      ? ((config as { tenantId: string }).tenantId ?? '').trim()
      : '';
  if (cfgTenantId && cfgTenantId !== tenantId) {
    throw new Error(
      `DOCUMENT_TENANCY_ERROR: Actor tenantId "${tenantId}" does not match configuration tenantId "${cfgTenantId}".`,
    );
  }
  return tenantId;
}

/**
 * Resolves the effective `DocumentPermission` set for an actor by delegating to the
 * single central `resolvePermissions` engine (`core/src/domain/rbac/resolver.ts`).
 *
 * Never uses `activeViewingRole` ("Viewing as"), role display labels, or hardcoded department IDs.
 */
export function resolveDocumentPermissions(
  actor: DocumentPermissionActor | null | undefined,
  config?: DocumentRbacConfigInput,
): DocumentPermission[] {
  if (!actor) {
    return [];
  }
  const tenantId = resolveDocGenTenantId(actor, config);
  if (!actor.id) {
    return [];
  }

  const resolved = resolvePermissions({
    context: {
      tenantId,
      correlationId: '',
      actorId: actor.id,
      actorRoles: actor.tokenRoles ?? [],
      mfaVerified: Boolean(actor.mfaVerified),
    },
    config: normaliseConfigForResolver(config),
    actor: {
      userId: actor.id,
      roles: actor.roles,
      departmentId: actor.departmentId,
      permissionOverrides: actor.permissionOverrides,
      documentPermissions: actor.documentPermissions,
      activeViewingRole: actor.activeViewingRole,
    },
  });

  return ALL_DOCUMENT_PERMISSIONS.filter((perm) => resolved.has(perm));
}

export function hasDocumentPermission(
  actor: DocumentPermissionActor | null | undefined,
  permission: DocumentPermission,
  config?: DocumentRbacConfigInput,
): boolean {
  if (!actor) return false;
  const tenantId = resolveDocGenTenantId(actor, config);
  if (!actor.id) return false;
  const resolved = resolvePermissions({
    context: {
      tenantId,
      correlationId: '',
      actorId: actor.id,
      actorRoles: actor.tokenRoles ?? [],
      mfaVerified: Boolean(actor.mfaVerified),
    },
    config: normaliseConfigForResolver(config),
    actor: {
      userId: actor.id,
      roles: actor.roles,
      departmentId: actor.departmentId,
      permissionOverrides: actor.permissionOverrides,
      documentPermissions: actor.documentPermissions,
      activeViewingRole: actor.activeViewingRole,
    },
  });
  return resolved.has(permission);
}

/**
 * Evaluates whether an actor can access a matter record, enforcing restricted staff matter rules
 * via `canAccessMatter` (`matter:restricted:access` permission + named matter participants, ADR-0014).
 */
export function canActorAccessMatterRecord(
  actor: DocumentPermissionActor | null | undefined,
  matter: MatterAccessSubject | null | undefined,
  config: DocumentRbacConfigInput,
): boolean {
  if (!actor) {
    return false;
  }
  const tenantId = resolveDocGenTenantId(actor, config);
  if (!actor.id || !matter?.id) {
    return false;
  }

  const resolved = resolvePermissions({
    context: {
      tenantId,
      correlationId: '',
      actorId: actor.id,
      actorRoles: actor.tokenRoles ?? [],
      mfaVerified: Boolean(actor.mfaVerified),
    },
    config: normaliseConfigForResolver(config),
    actor: {
      userId: actor.id,
      roles: actor.roles,
      departmentId: actor.departmentId,
      permissionOverrides: actor.permissionOverrides,
      documentPermissions: actor.documentPermissions,
    },
  });

  return canAccessMatter(resolved, {
    id: matter.id,
    clientId: matter.clientId,
    isStaffMatter: matter.isStaffMatter,
    restrictedAccessUserIds: matter.restrictedAccessUserIds,
    responsiblePartnerId: matter.responsiblePartnerId,
    responsibleSolicitorId: matter.responsibleSolicitorId,
    originatingSolicitorId: matter.originatingSolicitorId,
    supervisingPartnerId: matter.supervisingPartnerId,
    leadFeeEarnerId: matter.leadFeeEarnerId,
    teamMemberIds: matter.teamMemberIds,
  });
}

/**
 * Evaluates whether an actor can view a generated document.
 *
 * Crucial Rule (ADR-0004 & ADR-0014):
 * A document linked to a restricted matter inherits that matter's restriction,
 * including where the document is also linked to and shown on the Client screen.
 */
export function canActorAccessGeneratedDocument(
  actor: DocumentPermissionActor | null | undefined,
  document: Pick<GeneratedDocumentRecord, 'primaryMatterId' | 'isDeleted'>,
  linkedMatters: readonly MatterAccessSubject[],
  config?: DocumentRbacConfigInput,
): boolean {
  if (!actor?.id || document.isDeleted) {
    return false;
  }

  if (!hasDocumentPermission(actor, 'document:view', config)) {
    return false;
  }

  for (const matter of linkedMatters) {
    if (!canActorAccessMatterRecord(actor, matter, config)) {
      return false;
    }
  }

  return true;
}
