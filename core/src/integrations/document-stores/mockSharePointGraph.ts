/**
 * Stateful Mocked Microsoft Graph & SharePoint REST Backend (`core/src/integrations/document-stores/mockSharePointGraph.ts`).
 *
 * Designed for deterministic unit, contract, security, lifecycle, and two-tenant isolation tests,
 * as well as local development when live SharePoint credentials are not active.
 *
 * Features:
 * - Enforces tenant isolation (`tenantId`), SharePoint folder inheritance (`inheritsFromParent`),
 *   and per-user effective permissions (`callerEntraObjectId` + `callerGroups`) on every user-context call.
 * - Tracks every API call with the exact identity used (`user` vs `provisioning`), operation, and token prefix.
 * - Supports chunked upload sessions (`createUploadSession`), conflict behaviours (`fail`, `rename`, `replace`),
 *   SharePoint REST `breakroleinheritance` / `resetroleinheritance`, sharing link injection (for drift tests),
 *   and simulated HTTP 429 throttling with `Retry-After`.
 */

import { randomUUID } from 'node:crypto';
import type {
  DocumentAccessLevel,
  DocumentConflictBehavior,
  DocumentEffectiveAccess,
  DocumentPermissionGrant,
  DocumentPermissionSharingLink,
  DocumentPrincipalRef,
  DocumentStoreConnectionTestResult,
  DocumentStoreErrorCode,
  DocumentStoreErrorReason,
  DocumentStoreItem,
  TenantContext,
} from '../../api/index';
import { buildTenantCacheKey } from '../../tenancy/index';

export type SharePointSiteGrantRole =
  | 'none'
  | 'read'
  | 'write'
  | 'fullcontrol';

export interface MockGraphCallLogEntry {
  timestamp: string;
  tenantId: string;
  storeId: string;
  identityKind: 'user' | 'provisioning';
  callerEntraObjectId?: string;
  callerGroups?: readonly string[];
  accessTokenPrefix: string;
  apiSurface: 'graph_v1' | 'sp_rest';
  operation: string;
  driveId?: string;
  itemId?: string;
}

export interface MockStoredItem {
  itemId: string;
  tenantId: string;
  storeId: string;
  siteId: string;
  driveId: string;
  parentItemId: string | null;
  itemType: 'file' | 'folder';
  name: string;
  relativePath: string;
  webUrl: string;
  sizeBytes: number;
  mimeType?: string;
  eTag: string;
  versionLabel: string;
  createdAt: string;
  createdByDisplayName: string;
  lastModifiedAt: string;
  lastModifiedByDisplayName: string;
  contentBytes?: Uint8Array;
  inheritsFromParent: boolean;
  directGrants: DocumentPermissionGrant[];
  sharingLinks: DocumentPermissionSharingLink[];
}

export interface MockCallerIdentity {
  tenantId: string;
  storeId: string;
  identityKind: 'user' | 'provisioning';
  accessToken: string;
  callerEntraObjectId?: string;
  callerDisplayName?: string;
  callerUpn?: string;
  callerGroups?: readonly string[];
}

interface MockDrivePartition {
  tenantId: string;
  storeId: string;
  siteId: string;
  driveId: string;
  hostname: string;
  siteRelativePath: string;
  libraryUrlSegment: string;
  items: Map<string, MockStoredItem>;
}

const LEVEL_RANK: Record<DocumentAccessLevel, number> = {
  none: 0,
  read: 1,
  contribute: 2,
  edit: 3,
  manage: 4,
};

export function createMockGraphError(
  code: DocumentStoreErrorCode,
  message: string,
  retryAfterMs?: number,
  reason?: DocumentStoreErrorReason,
): Error & {
  code: DocumentStoreErrorCode;
  retryAfterMs?: number;
  reason?: DocumentStoreErrorReason;
} {
  const err = new Error(message) as Error & {
    code: DocumentStoreErrorCode;
    retryAfterMs?: number;
    reason?: DocumentStoreErrorReason;
  };
  err.code = code;
  if (retryAfterMs !== undefined) {
    err.retryAfterMs = retryAfterMs;
  }
  if (reason !== undefined) {
    err.reason = reason;
  }
  return err;
}

export class MockSharePointGraphBackend {
  private readonly drives = new Map<string, MockDrivePartition>();
  private readonly directoryPrincipals = new Map<
    string,
    Map<string, DocumentPrincipalRef>
  >();
  private readonly callLog: MockGraphCallLogEntry[] = [];
  private remainingThrottleResponses = 0;
  private throttleRetryAfterMs = 10;
  private simulateMissingSiteGrantsForStore = new Set<string>();
  private readonly siteGrantRoles = new Map<string, SharePointSiteGrantRole>();
  private readonly sitePermissionsReadForbidden = new Set<string>();
  private readonly simulatedTokenClaims = new Map<
    string,
    { appRoles?: readonly string[]; delegatedScopes?: readonly string[] }
  >();
  private readonly healthCache = new Map<
    string,
    { tenantId: string; storeId: string; result: DocumentStoreConnectionTestResult }
  >();

  public getCallLog(): readonly MockGraphCallLogEntry[] {
    return this.callLog;
  }

  public clearCallLog(): void {
    this.callLog.length = 0;
  }

  public simulateThrottling(count: number, retryAfterMs = 10): void {
    this.remainingThrottleResponses = count;
    this.throttleRetryAfterMs = retryAfterMs;
  }

  public setSimulateMissingSiteGrant(
    storeId: string,
    missing: boolean,
    tenantId?: string,
  ): void {
    const key = tenantId ? `${tenantId}::${storeId}` : storeId;
    if (missing) {
      this.simulateMissingSiteGrantsForStore.add(key);
      this.siteGrantRoles.set(key, 'none');
    } else {
      this.simulateMissingSiteGrantsForStore.delete(key);
      this.siteGrantRoles.delete(key);
    }
  }

  public setSitePermissionGrant(params: {
    tenantId?: string;
    storeId?: string;
    siteId?: string;
    role: SharePointSiteGrantRole;
  }): void {
    const t = params.tenantId ?? '*';
    if (params.storeId) {
      const storeKey = `${t}::store::${params.storeId}`;
      this.siteGrantRoles.set(storeKey, params.role);
      if (params.role === 'none') {
        this.simulateMissingSiteGrantsForStore.add(
          params.tenantId ? `${params.tenantId}::${params.storeId}` : params.storeId,
        );
      } else {
        this.simulateMissingSiteGrantsForStore.delete(
          params.tenantId ? `${params.tenantId}::${params.storeId}` : params.storeId,
        );
        this.simulateMissingSiteGrantsForStore.delete(params.storeId);
      }
    }
    if (params.siteId) {
      const siteKey = `${t}::site::${params.siteId}`;
      this.siteGrantRoles.set(siteKey, params.role);
    }
  }

  public getSitePermissionGrantRole(params: {
    tenantId: string;
    storeId: string;
    siteId?: string;
  }): SharePointSiteGrantRole {
    if (
      this.simulateMissingSiteGrantsForStore.has(
        `${params.tenantId}::${params.storeId}`,
      ) ||
      this.simulateMissingSiteGrantsForStore.has(params.storeId)
    ) {
      return 'none';
    }

    if (params.siteId) {
      const byTenantSite = this.siteGrantRoles.get(
        `${params.tenantId}::site::${params.siteId}`,
      );
      if (byTenantSite !== undefined) return byTenantSite;

      // If another tenant explicitly registered a grant on its site, do not grant it to this tenant
      for (const [k] of this.siteGrantRoles.entries()) {
        if (
          k.endsWith(`::site::${params.siteId}`) &&
          !k.startsWith(`${params.tenantId}::`) &&
          !k.startsWith('*::')
        ) {
          return 'none';
        }
      }

      const byWildcardSite = this.siteGrantRoles.get(
        `*::site::${params.siteId}`,
      );
      if (byWildcardSite !== undefined) return byWildcardSite;
    }

    const byTenantStore = this.siteGrantRoles.get(
      `${params.tenantId}::store::${params.storeId}`,
    );
    if (byTenantStore !== undefined) return byTenantStore;

    for (const [k] of this.siteGrantRoles.entries()) {
      if (
        k.endsWith(`::store::${params.storeId}`) &&
        !k.startsWith(`${params.tenantId}::`) &&
        !k.startsWith('*::')
      ) {
        return 'none';
      }
    }

    const byWildcardStore = this.siteGrantRoles.get(
      `*::store::${params.storeId}`,
    );
    if (byWildcardStore !== undefined) return byWildcardStore;

    return 'fullcontrol';
  }

  public setSimulateSitePermissionsReadForbidden(
    storeOrSiteIdOrParams:
      | string
      | {
          tenantId?: string;
          storeId?: string;
          siteId?: string;
          forbidden: boolean;
        },
    forbidden?: boolean,
    tenantId?: string,
  ): void {
    if (typeof storeOrSiteIdOrParams === 'object') {
      const p = storeOrSiteIdOrParams;
      const targets = [p.storeId, p.siteId].filter(Boolean) as string[];
      for (const t of targets) {
        const key = p.tenantId ? `${p.tenantId}::${t}` : t;
        if (p.forbidden) {
          this.sitePermissionsReadForbidden.add(key);
        } else {
          this.sitePermissionsReadForbidden.delete(key);
        }
      }
      return;
    }
    const key = tenantId
      ? `${tenantId}::${storeOrSiteIdOrParams}`
      : storeOrSiteIdOrParams;
    if (forbidden) {
      this.sitePermissionsReadForbidden.add(key);
    } else {
      this.sitePermissionsReadForbidden.delete(key);
    }
  }

  public isSitePermissionsReadForbidden(params: {
    tenantId: string;
    storeId: string;
    siteId: string;
  }): boolean {
    return (
      this.sitePermissionsReadForbidden.has(
        `${params.tenantId}::${params.storeId}`,
      ) ||
      this.sitePermissionsReadForbidden.has(
        `${params.tenantId}::${params.siteId}`,
      ) ||
      this.sitePermissionsReadForbidden.has(params.storeId) ||
      this.sitePermissionsReadForbidden.has(params.siteId)
    );
  }

  public setSimulatedTokenClaims(params: {
    tenantId?: string;
    storeId: string;
    appRoles?: readonly string[];
    delegatedScopes?: readonly string[];
  }): void {
    const key = `${params.tenantId ?? '*'}::${params.storeId}`;
    this.simulatedTokenClaims.set(key, {
      appRoles: params.appRoles ? [...params.appRoles] : undefined,
      delegatedScopes: params.delegatedScopes
        ? [...params.delegatedScopes]
        : undefined,
    });
  }

  public getSimulatedTokenClaims(
    tenantId: string,
    storeId: string,
  ): { appRoles?: readonly string[]; delegatedScopes?: readonly string[] } | undefined {
    return (
      this.simulatedTokenClaims.get(`${tenantId}::${storeId}`) ??
      this.simulatedTokenClaims.get(`*::${storeId}`)
    );
  }

  public setStoreHealthResult(
    ctx: Pick<TenantContext, 'tenantId'>,
    storeId: string,
    result: DocumentStoreConnectionTestResult,
  ): string {
    const cacheKey = buildTenantCacheKey(ctx, 'docstore-health', storeId);
    this.healthCache.set(cacheKey, {
      tenantId: ctx.tenantId,
      storeId,
      result,
    });
    return cacheKey;
  }

  public getStoreHealthResult(
    ctx: Pick<TenantContext, 'tenantId'>,
    storeId: string,
  ): DocumentStoreConnectionTestResult | null {
    const cacheKey = buildTenantCacheKey(ctx, 'docstore-health', storeId);
    const entry = this.healthCache.get(cacheKey);
    if (!entry) return null;
    if (entry.tenantId !== ctx.tenantId || entry.storeId !== storeId) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Cross-tenant document store health cache access blocked.',
      );
    }
    return entry.result;
  }

  public clearStoreHealthResults(tenantId?: string, storeId?: string): void {
    if (!tenantId && !storeId) {
      this.healthCache.clear();
      return;
    }
    for (const [k, v] of this.healthCache.entries()) {
      if (
        (!tenantId || v.tenantId === tenantId) &&
        (!storeId || v.storeId === storeId)
      ) {
        this.healthCache.delete(k);
      }
    }
  }

  public registerDirectoryPrincipal(
    tenantId: string,
    principal: DocumentPrincipalRef,
  ): void {
    let dir = this.directoryPrincipals.get(tenantId);
    if (!dir) {
      dir = new Map();
      this.directoryPrincipals.set(tenantId, dir);
    }
    dir.set(principal.entraObjectId.toLowerCase(), principal);
    if (principal.upn) {
      dir.set(principal.upn.toLowerCase(), principal);
    }
    if (principal.internalId) {
      dir.set(principal.internalId.toLowerCase(), principal);
    }
  }

  public resolveDirectoryPrincipal(
    tenantId: string,
    lookup: {
      principalType: 'user' | 'group';
      entraObjectId?: string;
      upn?: string;
      internalId?: string;
      displayName?: string;
    },
  ): DocumentPrincipalRef | null {
    const dir = this.directoryPrincipals.get(tenantId);
    if (dir) {
      const candidates = [
        lookup.entraObjectId,
        lookup.upn,
        lookup.internalId,
      ].filter(Boolean) as string[];
      for (const key of candidates) {
        const found = dir.get(key.toLowerCase());
        if (found && found.principalType === lookup.principalType) {
          return { ...found };
        }
      }
    }

    if (lookup.entraObjectId) {
      return {
        principalType: lookup.principalType,
        entraObjectId: lookup.entraObjectId,
        internalId: lookup.internalId,
        upn: lookup.upn,
        displayName:
          lookup.displayName ?? lookup.upn ?? lookup.entraObjectId,
      };
    }

    if (lookup.upn) {
      // Deterministic synthetic object ID from UPN for users who have not yet signed in
      const syntheticOid = `oid-${Buffer.from(`${tenantId}:${lookup.upn}`).toString('hex').slice(0, 24)}`;
      const principal: DocumentPrincipalRef = {
        principalType: lookup.principalType,
        entraObjectId: syntheticOid,
        internalId: lookup.internalId,
        upn: lookup.upn,
        displayName: lookup.displayName ?? lookup.upn,
      };
      this.registerDirectoryPrincipal(tenantId, principal);
      return principal;
    }

    return null;
  }

  public recordCall(
    caller: MockCallerIdentity,
    apiSurface: 'graph_v1' | 'sp_rest',
    operation: string,
    driveId?: string,
    itemId?: string,
  ): void {
    this.callLog.push({
      timestamp: new Date().toISOString(),
      tenantId: caller.tenantId,
      storeId: caller.storeId,
      identityKind: caller.identityKind,
      callerEntraObjectId: caller.callerEntraObjectId,
      callerGroups: caller.callerGroups ? [...caller.callerGroups] : undefined,
      accessTokenPrefix: caller.accessToken.slice(0, 16),
      apiSurface,
      operation,
      driveId,
      itemId,
    });

    if (this.remainingThrottleResponses > 0) {
      this.remainingThrottleResponses -= 1;
      throw createMockGraphError(
        'throttled',
        'HTTP 429 Too Many Requests from Microsoft Graph.',
        this.throttleRetryAfterMs,
      );
    }

    const siteGrantRole = this.getSitePermissionGrantRole({
      tenantId: caller.tenantId,
      storeId: caller.storeId,
    });
    if (siteGrantRole === 'none') {
      throw createMockGraphError(
        'access_denied',
        caller.identityKind === 'user'
          ? 'Documents for this matter are unavailable. Please contact your administrator.'
          : `SharePoint access not granted for site in store "${caller.storeId}".`,
        undefined,
        'site_access_not_granted',
      );
    }
    if (
      siteGrantRole === 'read' &&
      (operation === 'uploadContent' ||
        operation === 'createUploadSession' ||
        operation === 'uploadChunk' ||
        operation === 'createFolder' ||
        operation === 'renameItem' ||
        operation === 'moveItem' ||
        operation === 'deleteItem' ||
        operation === 'ensureFolderTree' ||
        operation === 'setPermissions' ||
        operation === 'breakRoleInheritance' ||
        operation === 'resetRoleInheritance')
    ) {
      throw createMockGraphError(
        'access_denied',
        caller.identityKind === 'user'
          ? 'Documents for this matter are unavailable. Please contact your administrator.'
          : `SharePoint site grant role "read" is insufficient for operation "${operation}" in store "${caller.storeId}".`,
        undefined,
        'site_grant_role_insufficient',
      );
    }
    if (
      siteGrantRole === 'write' &&
      (operation === 'setPermissions' ||
        operation === 'breakRoleInheritance' ||
        operation === 'resetRoleInheritance')
    ) {
      throw createMockGraphError(
        'access_denied',
        `SharePoint site grant role "write" is insufficient for permission management in store "${caller.storeId}"; "fullcontrol" is required.`,
        undefined,
        'site_grant_role_insufficient',
      );
    }
  }

  public ensureDrivePartition(params: {
    tenantId: string;
    storeId: string;
    siteId: string;
    driveId: string;
    hostname: string;
    siteRelativePath: string;
    libraryUrlSegment: string;
  }): MockDrivePartition {
    const key = `${params.tenantId}::${params.siteId}::${params.driveId}`;
    let part = this.drives.get(key);
    if (!part) {
      const now = new Date().toISOString();
      const rootWebUrl = `https://${params.hostname}${params.siteRelativePath}/${encodeURIComponent(params.libraryUrlSegment)}`;
      const rootItem: MockStoredItem = {
        itemId: 'root',
        tenantId: params.tenantId,
        storeId: params.storeId,
        siteId: params.siteId,
        driveId: params.driveId,
        parentItemId: null,
        itemType: 'folder',
        name: params.libraryUrlSegment,
        relativePath: '',
        webUrl: rootWebUrl,
        sizeBytes: 0,
        eTag: `"etag-root-1"`,
        versionLabel: '1.0',
        createdAt: now,
        createdByDisplayName: 'SharePoint System',
        lastModifiedAt: now,
        lastModifiedByDisplayName: 'SharePoint System',
        inheritsFromParent: false,
        directGrants: [],
        sharingLinks: [],
      };
      const items = new Map<string, MockStoredItem>();
      items.set('root', rootItem);
      part = {
        ...params,
        items,
      };
      this.drives.set(key, part);
    }
    return part;
  }

  public getDrivePartitionOrThrow(
    tenantId: string,
    siteId: string,
    driveId: string,
  ): MockDrivePartition {
    // Check if the driveId belongs to a different tenant (tampered ID check)
    for (const part of this.drives.values()) {
      if (part.siteId === siteId && part.driveId === driveId) {
        if (part.tenantId !== tenantId) {
          throw createMockGraphError(
            'access_denied',
            `TENANCY_ISOLATION_ERROR: Cross-tenant SharePoint drive access denied for drive "${driveId}".`,
          );
        }
        return part;
      }
    }
    throw createMockGraphError(
      'not_found',
      `SharePoint drive "${driveId}" on site "${siteId}" was not found.`,
    );
  }

  public getItemOrThrow(
    tenantId: string,
    siteId: string,
    driveId: string,
    itemId: string,
  ): { partition: MockDrivePartition; item: MockStoredItem } {
    // Also check across all partitions in case only itemId was tampered across tenants
    for (const part of this.drives.values()) {
      if (itemId !== 'root' && part.items.has(itemId)) {
        if (part.tenantId !== tenantId) {
          throw createMockGraphError(
            'access_denied',
            `TENANCY_ISOLATION_ERROR: Cross-tenant SharePoint item access denied for item "${itemId}".`,
          );
        }
      }
    }

    const partition = this.getDrivePartitionOrThrow(tenantId, siteId, driveId);
    const item = partition.items.get(itemId);
    if (!item) {
      throw createMockGraphError(
        'not_found',
        `SharePoint item "${itemId}" was not found in drive "${driveId}".`,
      );
    }
    return { partition, item };
  }

  /**
   * Resolves the effective permission grants for an item by walking up its parent chain
   * while `inheritsFromParent === true`.
   */
  public getEffectiveGrantsForItem(
    partition: MockDrivePartition,
    item: MockStoredItem,
  ): {
    definingItem: MockStoredItem;
    grants: DocumentPermissionGrant[];
  } {
    let cursor: MockStoredItem | undefined = item;
    while (
      cursor &&
      cursor.inheritsFromParent &&
      cursor.parentItemId &&
      partition.items.has(cursor.parentItemId)
    ) {
      cursor = partition.items.get(cursor.parentItemId);
    }
    const defining = cursor ?? item;
    return {
      definingItem: defining,
      grants: defining.directGrants,
    };
  }

  /**
   * Computes a user's effective access level on an item based on their `callerEntraObjectId`
   * and `callerGroups` against the item's effective permission scope.
   */
  public computeUserEffectiveLevel(
    caller: MockCallerIdentity,
    partition: MockDrivePartition,
    item: MockStoredItem,
  ): DocumentAccessLevel {
    if (caller.identityKind === 'provisioning') {
      return 'manage';
    }

    const { grants } = this.getEffectiveGrantsForItem(partition, item);

    // If no permissions have been configured on the entire ancestor chain at all (e.g. an unconfigured root),
    // default to 'edit' for authenticated users on the site unless any scope has explicit grants.
    const anyScopeConfiguredInDrive = Array.from(partition.items.values()).some(
      (i) => i.directGrants.length > 0 || !i.inheritsFromParent && i.itemId !== 'root',
    );
    if (!anyScopeConfiguredInDrive && grants.length === 0) {
      return 'edit';
    }

    const userOid = (caller.callerEntraObjectId ?? '').toLowerCase();
    const userGroups = new Set(
      (caller.callerGroups ?? []).map((g) => g.toLowerCase()),
    );

    let bestLevel: DocumentAccessLevel = 'none';
    for (const grant of grants) {
      const targetOid = grant.principal.entraObjectId.toLowerCase();
      const targetInternal = (grant.principal.internalId ?? '').toLowerCase();
      if (
        grant.principal.principalType === 'user' &&
        userOid &&
        (targetOid === userOid || (targetInternal && targetInternal === userOid))
      ) {
        if (LEVEL_RANK[grant.level] > LEVEL_RANK[bestLevel]) {
          bestLevel = grant.level;
        }
      } else if (
        grant.principal.principalType === 'group' &&
        (userGroups.has(targetOid) ||
          (targetInternal && userGroups.has(targetInternal)))
      ) {
        if (LEVEL_RANK[grant.level] > LEVEL_RANK[bestLevel]) {
          bestLevel = grant.level;
        }
      }
    }

    return bestLevel;
  }

  public toEffectiveAccessObject(
    level: DocumentAccessLevel,
  ): DocumentEffectiveAccess {
    const rank = LEVEL_RANK[level];
    return {
      level,
      canRead: rank >= LEVEL_RANK.read,
      canDownload: rank >= LEVEL_RANK.read,
      canUpload: rank >= LEVEL_RANK.contribute,
      canCreateFolder: rank >= LEVEL_RANK.contribute,
      canRename: rank >= LEVEL_RANK.edit,
      canMove: rank >= LEVEL_RANK.edit,
      canDelete: rank >= LEVEL_RANK.edit,
      canManagePermissions: rank >= LEVEL_RANK.manage,
    };
  }

  public assertCallerAccess(
    caller: MockCallerIdentity,
    partition: MockDrivePartition,
    item: MockStoredItem,
    minimumLevel: DocumentAccessLevel,
  ): void {
    const actualLevel = this.computeUserEffectiveLevel(caller, partition, item);
    if (LEVEL_RANK[actualLevel] < LEVEL_RANK[minimumLevel]) {
      throw createMockGraphError(
        'access_denied',
        `SharePoint denied access to item "${item.itemId}" (required "${minimumLevel}", user has "${actualLevel}").`,
      );
    }
  }

  public toDocumentStoreItem(
    partition: MockDrivePartition,
    stored: MockStoredItem,
  ): DocumentStoreItem {
    let childCount = 0;
    if (stored.itemType === 'folder') {
      for (const candidate of partition.items.values()) {
        if (candidate.parentItemId === stored.itemId) {
          childCount += 1;
        }
      }
    }

    return {
      itemId: stored.itemId,
      storeId: stored.storeId,
      siteId: stored.siteId,
      driveId: stored.driveId,
      parentItemId: stored.parentItemId,
      itemType: stored.itemType,
      name: stored.name,
      sizeBytes: stored.sizeBytes,
      mimeType: stored.mimeType,
      webUrl: stored.webUrl,
      eTag: stored.eTag,
      versionLabel: stored.versionLabel,
      createdAt: stored.createdAt,
      createdByDisplayName: stored.createdByDisplayName,
      lastModifiedAt: stored.lastModifiedAt,
      lastModifiedByDisplayName: stored.lastModifiedByDisplayName,
      childCount: stored.itemType === 'folder' ? childCount : undefined,
      hasUniquePermissions: !stored.inheritsFromParent,
    };
  }

  public findChildByName(
    partition: MockDrivePartition,
    parentItemId: string,
    name: string,
  ): MockStoredItem | null {
    const lower = name.toLowerCase();
    for (const item of partition.items.values()) {
      if (
        item.parentItemId === parentItemId &&
        item.name.toLowerCase() === lower
      ) {
        return item;
      }
    }
    return null;
  }

  public findFolderByRelativePath(
    partition: MockDrivePartition,
    relativePath: string,
  ): MockStoredItem | null {
    const cleaned = relativePath
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    if (cleaned.length === 0) {
      return partition.items.get('root') ?? null;
    }

    let currentParentId = 'root';
    let currentItem: MockStoredItem | null = null;
    for (const seg of cleaned) {
      const child = this.findChildByName(partition, currentParentId, seg);
      if (!child || child.itemType !== 'folder') {
        return null;
      }
      currentItem = child;
      currentParentId = child.itemId;
    }
    return currentItem;
  }

  public createChildFolder(params: {
    partition: MockDrivePartition;
    parent: MockStoredItem;
    name: string;
    actorDisplayName: string;
    conflictBehavior: DocumentConflictBehavior;
  }): MockStoredItem {
    const { partition, parent, actorDisplayName, conflictBehavior } = params;
    let folderName = params.name;
    const existing = this.findChildByName(partition, parent.itemId, folderName);

    if (existing) {
      if (conflictBehavior === 'fail') {
        throw createMockGraphError(
          'conflict',
          `A folder named "${folderName}" already exists in parent "${parent.itemId}".`,
        );
      }
      if (conflictBehavior === 'replace' && existing.itemType === 'folder') {
        return existing;
      }
      if (conflictBehavior === 'rename') {
        let suffix = 1;
        while (
          this.findChildByName(
            partition,
            parent.itemId,
            `${folderName} (${suffix})`,
          )
        ) {
          suffix += 1;
        }
        folderName = `${folderName} (${suffix})`;
      }
    }

    const now = new Date().toISOString();
    const itemId = `sp-folder-${randomUUID()}`;
    const relativePath = parent.relativePath
      ? `${parent.relativePath}/${folderName}`
      : folderName;
    const webUrl = `${parent.webUrl}/${encodeURIComponent(folderName)}`;

    const created: MockStoredItem = {
      itemId,
      tenantId: partition.tenantId,
      storeId: partition.storeId,
      siteId: partition.siteId,
      driveId: partition.driveId,
      parentItemId: parent.itemId,
      itemType: 'folder',
      name: folderName,
      relativePath,
      webUrl,
      sizeBytes: 0,
      eTag: `"etag-${itemId}-1"`,
      versionLabel: '1.0',
      createdAt: now,
      createdByDisplayName: actorDisplayName,
      lastModifiedAt: now,
      lastModifiedByDisplayName: actorDisplayName,
      inheritsFromParent: true,
      directGrants: [],
      sharingLinks: [],
    };
    partition.items.set(itemId, created);
    return created;
  }

  /**
   * Test helper: injects an unexpected sharing link or permission drift onto an item
   * so reconciliation tests can detect and remediate it.
   */
  public injectSharingLinkForTesting(params: {
    tenantId: string;
    siteId: string;
    driveId: string;
    itemId: string;
    link: DocumentPermissionSharingLink;
  }): void {
    const { item } = this.getItemOrThrow(
      params.tenantId,
      params.siteId,
      params.driveId,
      params.itemId,
    );
    item.sharingLinks.push(params.link);
  }
}
