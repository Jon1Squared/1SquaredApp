/**
 * Core Document Store Domain Module (`core/src/domain/documents/index.ts`).
 *
 * Exports types, routing, folder templates, inheritance-based security, audit helpers,
 * lifecycle jobs, permission reconciliation, and user-context matter document operations.
 */

import type {
  DocumentPermission,
  DocumentStoreErrorCode,
  DocumentStoreProvider,
  TenantContext,
  UserAccessContext,
} from '../../api/index';
import type { TenantDocumentStoreRepository } from '../../tenancy/index';
import { buildDocumentStoreAuditEvent } from './audit';
import { recordStoreAccessDeniedFinding } from './reconciliation';
import type {
  DocumentStoreAuditAction,
  MatterDocumentLocationRecord,
} from './types';

export * from './types';
export * from './routing';
export * from './templates';
export * from './security';
export * from './audit';
export * from './lifecycle';
export * from './reconciliation';

export interface UserMatterDocumentGuardInput {
  ctx: TenantContext;
  userBearerToken?: string;
  requiredPermission: DocumentPermission;
  grantedPermissions: ReadonlySet<string> | readonly string[];
  matterId: string;
  canAccessMatterIn1Squared: boolean;
  isRestrictedMatter?: boolean;
  isUserOnRestrictedAllowlist?: boolean;
  storeId: string;
  libraryId: string;
  providerItemId?: string | null;
  locationId?: string | null;
  location: MatterDocumentLocationRecord | null;
  targetItemIds?: readonly (string | null | undefined)[];
  verifyItemInMatterTree: (
    userCtx: UserAccessContext,
    itemId: string,
    location: MatterDocumentLocationRecord,
  ) => Promise<boolean>;
  auditAction: DocumentStoreAuditAction;
  repository: TenantDocumentStoreRepository;
}

/**
 * Enforces 1Squared RBAC + matter access + Entra identity check, constructs a strict `UserAccessContext`
 * (`kind: 'user'`), executes the delegated provider operation, records zero-PII audit events, and
 * automatically records a `permission_mismatch_store_denied` reconciliation finding if 1Squared allowed
 * the operation but the external document store returned `access_denied`.
 */
export async function executeUserMatterDocumentOperation<TResult>(
  guard: UserMatterDocumentGuardInput,
  operation: (userCtx: UserAccessContext) => Promise<TResult>,
): Promise<TResult> {
  const {
    ctx,
    userBearerToken = 'obo-delegated-session-assertion',
    requiredPermission,
    grantedPermissions,
    matterId,
    canAccessMatterIn1Squared,
    isRestrictedMatter = false,
    isUserOnRestrictedAllowlist = false,
    storeId,
    libraryId,
    providerItemId = null,
    auditAction,
    repository,
  } = guard;

  const permSet =
    grantedPermissions instanceof Set
      ? grantedPermissions
      : new Set(grantedPermissions);

  // 1. Check 1Squared RBAC permission
  if (!permSet.has(requiredPermission)) {
    await repository.appendAuditEvent(
      ctx,
      buildDocumentStoreAuditEvent({
        context: ctx,
        identityUsed: 'user',
        triggerEvent: `user.${auditAction}`,
        action: auditAction,
        matterId,
        storeId,
        libraryId,
        providerItemId,
        outcome: 'denied',
        errorCode: 'rbac_denied',
        metadata: { requiredPermission },
      }),
    );
    const err = new Error(
      `PERMISSION_DENIED: Missing required permission "${requiredPermission}".`,
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'access_denied';
    throw err;
  }

  // 2. Check restricted matter access in 1Squared
  if (
    isRestrictedMatter &&
    !isUserOnRestrictedAllowlist &&
    !permSet.has('matter:restricted:access')
  ) {
    await repository.appendAuditEvent(
      ctx,
      buildDocumentStoreAuditEvent({
        context: ctx,
        identityUsed: 'user',
        triggerEvent: `user.${auditAction}`,
        action: auditAction,
        matterId,
        storeId,
        libraryId,
        providerItemId,
        outcome: 'denied',
        errorCode: 'restricted_matter_denied',
      }),
    );
    const err = new Error(
      'PERMISSION_DENIED: You do not have access to this restricted matter.',
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'access_denied';
    throw err;
  }

  // 3. Check 1Squared matter access
  if (!canAccessMatterIn1Squared) {
    await repository.appendAuditEvent(
      ctx,
      buildDocumentStoreAuditEvent({
        context: ctx,
        identityUsed: 'user',
        triggerEvent: `user.${auditAction}`,
        action: auditAction,
        matterId,
        storeId,
        libraryId,
        providerItemId,
        outcome: 'denied',
        errorCode: 'matter_access_denied',
      }),
    );
    const err = new Error(
      'PERMISSION_DENIED: You do not have access to this matter in 1Squared.',
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'access_denied';
    throw err;
  }

  // 4. Verify location belongs to the requested matter and target items do not belong to another matter
  const resolvedLocation =
    guard.location ??
    (guard.locationId
      ? await repository.getMatterLocationById(ctx, guard.locationId)
      : null);

  if (!resolvedLocation || resolvedLocation.matterId !== matterId) {
    await repository.appendAuditEvent(
      ctx,
      buildDocumentStoreAuditEvent({
        context: ctx,
        identityUsed: 'user',
        triggerEvent: `user.${auditAction}`,
        action: auditAction,
        matterId,
        storeId,
        libraryId,
        providerItemId,
        outcome: 'denied',
        errorCode: 'location_matter_mismatch',
      }),
    );
    const err = new Error(
      'PERMISSION_DENIED: Document location does not belong to this matter.',
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'access_denied';
    throw err;
  }

  const itemIdsToCheck = Array.from(
    new Set(
      [providerItemId, ...(guard.targetItemIds ?? [])].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  );

  if (itemIdsToCheck.length > 0) {
    const allLocations = await repository.listAllMatterLocations(ctx);
    const folderScopes = await repository.listFolderScopes(ctx);
    for (const candidateItemId of itemIdsToCheck) {
      const ownedByOtherMatter = allLocations.some(
        (otherLoc) =>
          otherLoc.matterId !== matterId &&
          (otherLoc.providerFolderItemId === candidateItemId ||
            Object.values(otherLoc.folderItemMap ?? {}).includes(
              candidateItemId,
            )),
      );
      const isSharedScopeOutsideMatter =
        resolvedLocation &&
        resolvedLocation.providerFolderItemId !== candidateItemId &&
        (candidateItemId === 'root' ||
          folderScopes.some((s) => s.providerItemId === candidateItemId));

      if (ownedByOtherMatter || isSharedScopeOutsideMatter) {
        await repository.appendAuditEvent(
          ctx,
          buildDocumentStoreAuditEvent({
            context: ctx,
            identityUsed: 'user',
            triggerEvent: `user.${auditAction}`,
            action: auditAction,
            matterId,
            storeId,
            libraryId,
            providerItemId: candidateItemId,
            outcome: 'denied',
            errorCode: 'item_outside_matter_folder',
          }),
        );
        const err = new Error(
          'PERMISSION_DENIED: Target item is outside the matter folder hierarchy.',
        ) as Error & { code: DocumentStoreErrorCode };
        err.code = 'access_denied';
        throw err;
      }
    }
  }

  // 5. Verify the signed-in user has a firm Entra Object ID (required for delegated OBO access)
  if (!ctx.entraObjectId) {
    const err = new Error(
      'ENTRA_IDENTITY_REQUIRED: Document store features require you to sign in with your firm Microsoft Entra ID account.',
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'reauthentication_required';
    throw err;
  }

  // 6. Construct strict UserAccessContext (never ProvisioningAccessContext)
  const userCtx: UserAccessContext = Object.freeze({
    kind: 'user',
    tenantContext: ctx,
    actorUserId: ctx.actorId,
    entraObjectId: ctx.entraObjectId,
    userUpn: ctx.actorUpn ?? ctx.actorEmail,
    userAssertionToken: userBearerToken,
  });

  if (itemIdsToCheck.length > 0) {
    const knownMatterIds = new Set<string>([
      resolvedLocation.providerFolderItemId,
      ...Object.values(resolvedLocation.folderItemMap ?? {}),
    ]);
    for (const candidateItemId of itemIdsToCheck) {
      if (knownMatterIds.has(candidateItemId)) continue;
      let isInsideTree = false;
      try {
        isInsideTree = await guard.verifyItemInMatterTree(
          userCtx,
          candidateItemId,
          resolvedLocation,
        );
      } catch {
        isInsideTree = false;
      }
      if (!isInsideTree) {
        await repository.appendAuditEvent(
          ctx,
          buildDocumentStoreAuditEvent({
            context: ctx,
            identityUsed: 'user',
            triggerEvent: `user.${auditAction}`,
            action: auditAction,
            matterId,
            storeId,
            libraryId,
            providerItemId: candidateItemId,
            outcome: 'denied',
            errorCode: 'item_outside_matter_folder',
          }),
        );
        const err = new Error(
          'PERMISSION_DENIED: Target item is outside the matter folder hierarchy.',
        ) as Error & { code: DocumentStoreErrorCode };
        err.code = 'access_denied';
        throw err;
      }
    }
  }

  try {
    const result = await operation(userCtx);
    await repository.appendAuditEvent(
      ctx,
      buildDocumentStoreAuditEvent({
        context: ctx,
        identityUsed: 'user',
        triggerEvent: `user.${auditAction}`,
        action: auditAction,
        matterId,
        storeId,
        libraryId,
        providerItemId,
        outcome: 'succeeded',
      }),
    );
    return result;
  } catch (err) {
    const code =
      (err as { code?: DocumentStoreErrorCode })?.code ?? 'unavailable';

    // Section 3: If 1Squared allows an action but the store denies it, record a reconciliation finding!
    if (code === 'access_denied') {
      await recordStoreAccessDeniedFinding({
        ctx,
        repository,
        storeId,
        libraryId,
        matterId,
        providerItemId: providerItemId ?? 'matter-root',
        operation: auditAction,
      });
    } else {
      await repository.appendAuditEvent(
        ctx,
        buildDocumentStoreAuditEvent({
          context: ctx,
          identityUsed: 'user',
          triggerEvent: `user.${auditAction}`,
          action: auditAction,
          matterId,
          storeId,
          libraryId,
          providerItemId,
          outcome: 'failed',
          errorCode: code,
        }),
      );
    }

    throw err;
  }
}

export type UnusedProviderTypeRef = DocumentStoreProvider;
