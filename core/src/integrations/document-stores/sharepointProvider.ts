/**
 * SharePoint Online Document Store Provider (`core/src/integrations/document-stores/sharepointProvider.ts`).
 *
 * Implements Section 1 & Section 9:
 * - Single-place role mapping (`SHAREPOINT_ROLE_MAPPING`) from abstract levels (`read`, `contribute`,
 *   `edit`, `manage`) to Microsoft Graph roles and SharePoint REST role definition names/IDs.
 * - Microsoft Graph v1.0 for site, drive, item CRUD, resumable upload sessions (`createUploadSession`),
 *   and permission grants.
 * - SharePoint REST API strictly for `breakroleinheritance` and `resetroleinheritance`.
 * - Bounded exponential backoff with jitter and `Retry-After` handling on HTTP 429 / 503.
 * - Per-tenant concurrency semaphore and request timeouts.
 * - Strict runtime enforcement of `UserAccessContext` (OBO token) vs `ProvisioningAccessContext` (app token).
 */

import { randomUUID } from 'node:crypto';
import type {
  DocumentAccessContext,
  DocumentAccessLevel,
  DocumentEffectiveAccess,
  DocumentFolderEnsureResult,
  DocumentLocationResolutionInput,
  DocumentLocationResolutionResult,
  DocumentPermissionGrant,
  DocumentPermissionSnapshot,
  DocumentPrincipalLookupInput,
  DocumentPrincipalRef,
  DocumentStoreCapabilities,
  DocumentStoreConnectionTestResult,
  DocumentStoreConfig,
  DocumentStoreContainerRef,
  DocumentStoreErrorCode,
  DocumentStoreErrorReason,
  DocumentStoreFolderTreeNode,
  DocumentStoreItem,
  DocumentStoreItemRef,
  DocumentStoreListPage,
  DocumentStorePagingOptions,
  DocumentStoreProvider,
  DocumentUploadOptions,
  ProvisioningAccessContext,
  TenantContext,
  UserAccessContext,
} from '../../api/index';
import { runTenantBackgroundJob } from '../../tenancy/index';
import {
  MockSharePointGraphBackend,
  createMockGraphError,
  type MockCallerIdentity,
} from './mockSharePointGraph';
import { parseSharePointLocationUrl } from './sharepointUrlParser';
import {
  DocumentStoreTokenService,
  verifyTokenClaimsForSitesSelected,
} from './tokenCache';

export interface SharePointRoleDescriptor {
  readonly abstractLevel: Exclude<DocumentAccessLevel, 'none'>;
  readonly graphRole: 'read' | 'write' | 'owner';
  readonly sharePointRoleDefinitionName:
    | 'Read'
    | 'Contribute'
    | 'Edit'
    | 'Full Control';
  readonly sharePointRoleDefinitionId: number;
}

/**
 * Single source of truth mapping 1Squared abstract access levels to Microsoft Graph roles
 * and SharePoint REST role definitions (Section 9).
 */
export const SHAREPOINT_ROLE_MAPPING: Readonly<
  Record<Exclude<DocumentAccessLevel, 'none'>, SharePointRoleDescriptor>
> = Object.freeze({
  read: {
    abstractLevel: 'read',
    graphRole: 'read',
    sharePointRoleDefinitionName: 'Read',
    sharePointRoleDefinitionId: 1073741826,
  },
  contribute: {
    abstractLevel: 'contribute',
    graphRole: 'write',
    sharePointRoleDefinitionName: 'Contribute',
    sharePointRoleDefinitionId: 1073741827,
  },
  edit: {
    abstractLevel: 'edit',
    graphRole: 'write',
    sharePointRoleDefinitionName: 'Edit',
    sharePointRoleDefinitionId: 1073741830,
  },
  manage: {
    abstractLevel: 'manage',
    graphRole: 'owner',
    sharePointRoleDefinitionName: 'Full Control',
    sharePointRoleDefinitionId: 1073741829,
  },
});

export const SHAREPOINT_CAPABILITIES: DocumentStoreCapabilities = Object.freeze({
  versions: true,
  checkInOut: true,
  uniqueFolderPermissions: true,
  metadataColumns: true,
  retentionLabels: true,
  changeTracking: true,
  resumableLargeUpload: true,
  deepLinkCoAuthoring: true,
  maxPathLengthChars: 400,
  maxSegmentLengthChars: 120,
});

export const GRAPH_RESUMABLE_UPLOAD_THRESHOLD_BYTES = 4 * 1024 * 1024; // 4 MiB
export const GRAPH_UPLOAD_CHUNK_SIZE_BYTES = 320 * 1024 * 10; // 3.2 MiB (multiple of 320 KiB)

export class SharePointDocumentStoreProvider implements DocumentStoreProvider {
  public readonly providerType = 'sharepoint' as const;
  public readonly storeId: string;
  public readonly capabilities: DocumentStoreCapabilities =
    SHAREPOINT_CAPABILITIES;

  private readonly tenantContext: TenantContext;
  private readonly storeConfig: DocumentStoreConfig;
  private readonly tokenService: DocumentStoreTokenService;
  private readonly backend: MockSharePointGraphBackend;
  private activeConcurrentRequests = 0;
  private readonly maxConcurrentRequests = 16;
  private readonly maxRetryAttempts = 3;

  public constructor(params: {
    tenantContext: TenantContext;
    storeConfig: DocumentStoreConfig;
    tokenService: DocumentStoreTokenService;
    backend: MockSharePointGraphBackend;
  }) {
    if (!params.tenantContext?.tenantId) {
      throw createMockGraphError(
        'misconfigured',
        'SharePointDocumentStoreProvider requires a tenant-scoped TenantContext.',
      );
    }
    this.tenantContext = params.tenantContext;
    this.storeConfig = params.storeConfig;
    this.storeId = params.storeConfig.storeId;
    this.tokenService = params.tokenService;
    this.backend = params.backend;

    // Seed configured libraries into the tenant's partition idempotently
    if (params.storeConfig.sharepoint) {
      const sp = params.storeConfig.sharepoint;
      const siteId = sp.siteId ?? `site-${this.storeId}`;
      for (const lib of sp.libraries) {
        const driveId = lib.driveId ?? `drive-${this.storeId}-${lib.libraryId}`;
        this.backend.ensureDrivePartition({
          tenantId: this.tenantContext.tenantId,
          storeId: this.storeId,
          siteId,
          driveId,
          hostname: sp.hostname,
          siteRelativePath: sp.siteRelativePath,
          libraryUrlSegment: lib.libraryUrlSegment,
        });
      }
    }
  }

  private assertSameTenant(ctx: DocumentAccessContext): void {
    if (
      !ctx?.tenantContext?.tenantId ||
      ctx.tenantContext.tenantId !== this.tenantContext.tenantId
    ) {
      throw createMockGraphError(
        'access_denied',
        'TENANCY_ISOLATION_ERROR: AccessContext tenantId does not match provider tenantId.',
      );
    }
  }

  private assertUserContext(ctx: DocumentAccessContext): UserAccessContext {
    this.assertSameTenant(ctx);
    if (ctx.kind !== 'user') {
      throw createMockGraphError(
        'access_denied',
        'IDENTITY_VIOLATION: User-facing document operation refused to execute with a provisioning identity.',
      );
    }
    return ctx;
  }

  private assertProvisioningContext(
    ctx: DocumentAccessContext,
  ): ProvisioningAccessContext {
    this.assertSameTenant(ctx);
    if (ctx.kind !== 'provisioning') {
      throw createMockGraphError(
        'access_denied',
        'IDENTITY_VIOLATION: Provisioning operation requires a ProvisioningAccessContext.',
      );
    }
    return ctx;
  }

  private assertStoreTargetScope(ref: {
    siteId: string;
    driveId: string;
  }): void {
    const sp = this.storeConfig.sharepoint;
    if (!sp) {
      throw createMockGraphError(
        'misconfigured',
        'Documents for this matter are unavailable. Please contact your administrator.',
        undefined,
        'site_or_drive_mismatch',
      );
    }
    const expectedSiteId = sp.siteId ?? `site-${this.storeId}`;
    if (!ref.siteId || ref.siteId !== expectedSiteId) {
      throw createMockGraphError(
        'access_denied',
        'Documents for this matter are unavailable. Please contact your administrator.',
        undefined,
        'site_or_drive_mismatch',
      );
    }
    const configuredDriveIds = new Set(
      sp.libraries.map(
        (lib) => lib.driveId ?? `drive-${this.storeId}-${lib.libraryId}`,
      ),
    );
    if (!ref.driveId || !configuredDriveIds.has(ref.driveId)) {
      throw createMockGraphError(
        'access_denied',
        'Documents for this matter are unavailable. Please contact your administrator.',
        undefined,
        'site_or_drive_mismatch',
      );
    }
  }

  private assertCachedStoreHealth(ctx: DocumentAccessContext): void {
    const cachedHealth = this.backend.getStoreHealthResult(
      this.tenantContext,
      this.storeId,
    );
    if (cachedHealth && !cachedHealth.ok) {
      const code = cachedHealth.errorCode ?? 'access_denied';
      const reason = cachedHealth.errorReasonCode;
      const message =
        ctx.kind === 'user'
          ? 'Documents for this matter are unavailable. Please contact your administrator.'
          : (cachedHealth.errorReason ??
            'Documents for this matter are unavailable. Please contact your administrator.');
      throw createMockGraphError(code, message, undefined, reason);
    }
  }

  private assertTokenClaimsLeastPrivilege(
    ctx: DocumentAccessContext,
    options: { appToken?: string; oboToken?: string },
  ): void {
    const effectiveDelegatedScope =
      this.storeConfig.auth.delegatedPermissionScope ?? 'Files.ReadWrite.All';
    if (effectiveDelegatedScope !== 'Sites.Selected') {
      return;
    }

    const check = verifyTokenClaimsForSitesSelected({
      appToken: options.appToken,
      oboToken: options.oboToken,
    });

    if (!check.valid) {
      const msg =
        ctx.kind === 'user'
          ? 'Documents for this matter are unavailable. Please contact your administrator.'
          : `SharePoint store "${this.storeId}" is configured for Sites.Selected, but broader Microsoft Graph permissions (${check.excessPermissions.join(', ')}) remain consented in Microsoft Entra ID.`;
      throw createMockGraphError(
        'misconfigured',
        msg,
        undefined,
        'excess_permissions_consented',
      );
    }
  }

  private async resolveCallerIdentity(
    ctx: DocumentAccessContext,
    scope?: string,
    skipCachedHealthGuard = false,
  ): Promise<MockCallerIdentity> {
    this.assertSameTenant(ctx);
    if (!skipCachedHealthGuard) {
      this.assertCachedStoreHealth(ctx);
    }
    if (ctx.kind === 'user') {
      const accessToken = await this.tokenService.acquireDelegatedUserToken({
        accessContext: ctx,
        storeId: this.storeId,
        authConfig: this.storeConfig.auth,
        scope,
      });
      this.assertTokenClaimsLeastPrivilege(ctx, { oboToken: accessToken });
      return {
        tenantId: this.tenantContext.tenantId,
        storeId: this.storeId,
        identityKind: 'user',
        accessToken,
        callerEntraObjectId: ctx.entraObjectId,
        callerDisplayName: ctx.tenantContext.actorName,
        callerUpn: ctx.userUpn,
        callerGroups: ctx.tenantContext.actorGroups,
      };
    }

    const accessToken = await this.tokenService.acquireProvisioningToken({
      accessContext: ctx,
      storeId: this.storeId,
      authConfig: this.storeConfig.auth,
      scope,
    });
    if (!skipCachedHealthGuard) {
      this.assertTokenClaimsLeastPrivilege(ctx, { appToken: accessToken });
    }
    return {
      tenantId: this.tenantContext.tenantId,
      storeId: this.storeId,
      identityKind: 'provisioning',
      accessToken,
      callerDisplayName: '1Squared Provisioning App',
    };
  }

  private async executeWithResilience<T>(
    operation: () => Promise<T> | T,
  ): Promise<T> {
    if (this.activeConcurrentRequests >= this.maxConcurrentRequests) {
      throw createMockGraphError(
        'throttled',
        `Per-tenant SharePoint concurrency limit (${this.maxConcurrentRequests}) exceeded.`,
        50,
      );
    }

    this.activeConcurrentRequests += 1;
    try {
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          return await operation();
        } catch (err) {
          const code = (err as { code?: DocumentStoreErrorCode })?.code;
          const retryAfterMs =
            (err as { retryAfterMs?: number })?.retryAfterMs ??
            Math.min(200, 15 * Math.pow(2, attempt - 1)) +
              Math.floor(Math.random() * 10);

          if (
            (code === 'throttled' || code === 'unavailable') &&
            attempt <= this.maxRetryAttempts
          ) {
            await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
            continue;
          }
          throw err;
        }
      }
    } finally {
      this.activeConcurrentRequests -= 1;
    }
  }

  // ============================================================================
  // User & Dual-Context Operations
  // ============================================================================

  public async listItems(
    context: DocumentAccessContext,
    containerRef: DocumentStoreContainerRef,
    paging?: DocumentStorePagingOptions,
  ): Promise<DocumentStoreListPage> {
    const caller = await this.resolveCallerIdentity(context);
    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(containerRef);
      const folderItemId = containerRef.folderItemId ?? 'root';
      this.backend.recordCall(
        caller,
        'graph_v1',
        'listItems',
        containerRef.driveId,
        folderItemId,
      );

      const { partition, item: folder } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        containerRef.siteId,
        containerRef.driveId,
        folderItemId,
      );
      this.backend.assertCallerAccess(caller, partition, folder, 'read');

      const allChildren: DocumentStoreItem[] = [];
      for (const candidate of partition.items.values()) {
        if (candidate.parentItemId === folder.itemId) {
          // Only include items the caller has at least read access to
          const childLevel = this.backend.computeUserEffectiveLevel(
            caller,
            partition,
            candidate,
          );
          if (childLevel !== 'none') {
            allChildren.push(
              this.backend.toDocumentStoreItem(partition, candidate),
            );
          }
        }
      }

      // Sort folders first, then alphabetically by name
      allChildren.sort((a, b) => {
        if (a.itemType !== b.itemType) {
          return a.itemType === 'folder' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      const pageSize = Math.max(1, Math.min(200, paging?.pageSize ?? 50));
      const startOffset = paging?.cursor
        ? Number.parseInt(paging.cursor, 10) || 0
        : 0;
      const slice = allChildren.slice(startOffset, startOffset + pageSize);
      const nextOffset = startOffset + pageSize;

      return {
        items: slice,
        nextCursor:
          nextOffset < allChildren.length ? String(nextOffset) : null,
        totalCount: allChildren.length,
      };
    });
  }

  public async getItem(
    context: DocumentAccessContext,
    itemRef: DocumentStoreItemRef,
  ): Promise<DocumentStoreItem> {
    const caller = await this.resolveCallerIdentity(context);
    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(itemRef);
      this.backend.recordCall(
        caller,
        'graph_v1',
        'getItem',
        itemRef.driveId,
        itemRef.itemId,
      );
      const { partition, item } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        itemRef.siteId,
        itemRef.driveId,
        itemRef.itemId,
      );
      this.backend.assertCallerAccess(caller, partition, item, 'read');
      return this.backend.toDocumentStoreItem(partition, item);
    });
  }

  public async downloadContent(
    context: UserAccessContext,
    itemRef: DocumentStoreItemRef,
  ): Promise<{
    stream: ReadableStream<Uint8Array>;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    eTag?: string;
  }> {
    const userCtx = this.assertUserContext(context);
    const caller = await this.resolveCallerIdentity(userCtx);
    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(itemRef);
      this.backend.recordCall(
        caller,
        'graph_v1',
        'downloadContent',
        itemRef.driveId,
        itemRef.itemId,
      );
      const { partition, item } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        itemRef.siteId,
        itemRef.driveId,
        itemRef.itemId,
      );
      this.backend.assertCallerAccess(caller, partition, item, 'read');
      if (item.itemType !== 'file') {
        throw createMockGraphError(
          'not_found',
          'Cannot download content of a folder item.',
        );
      }

      const bytes = item.contentBytes ?? new Uint8Array(0);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });

      return {
        stream,
        fileName: item.name,
        mimeType: item.mimeType ?? 'application/octet-stream',
        sizeBytes: bytes.byteLength,
        eTag: item.eTag,
      };
    });
  }

  public async uploadContent(
    context: DocumentAccessContext,
    containerRef: DocumentStoreContainerRef,
    name: string,
    stream: ReadableStream<Uint8Array> | Uint8Array,
    sizeBytes: number,
    options?: DocumentUploadOptions,
  ): Promise<DocumentStoreItem> {
    const caller = await this.resolveCallerIdentity(context);

    // Collect stream bytes into memory buffer (chunked if >= 4 MiB)
    let fullBytes: Uint8Array;
    if (stream instanceof Uint8Array) {
      fullBytes = new Uint8Array(stream);
    } else {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      fullBytes = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        fullBytes.set(c, offset);
        offset += c.byteLength;
      }
    }

    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(containerRef);
      const folderItemId = containerRef.folderItemId ?? 'root';
      const { partition, item: parentFolder } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        containerRef.siteId,
        containerRef.driveId,
        folderItemId,
      );
      this.backend.assertCallerAccess(
        caller,
        partition,
        parentFolder,
        'contribute',
      );

      const effectiveSize = Math.max(sizeBytes, fullBytes.byteLength);
      if (effectiveSize >= GRAPH_RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
        this.backend.recordCall(
          caller,
          'graph_v1',
          'createUploadSession',
          containerRef.driveId,
          folderItemId,
        );
        const chunkCount = Math.ceil(
          effectiveSize / GRAPH_UPLOAD_CHUNK_SIZE_BYTES,
        );
        for (let c = 0; c < chunkCount; c++) {
          this.backend.recordCall(
            caller,
            'graph_v1',
            'uploadChunk',
            containerRef.driveId,
            folderItemId,
          );
        }
      } else {
        this.backend.recordCall(
          caller,
          'graph_v1',
          'uploadContent',
          containerRef.driveId,
          folderItemId,
        );
      }

      const conflictBehavior = options?.conflictBehavior ?? 'rename';
      let targetName = name.trim();
      const existing = this.backend.findChildByName(
        partition,
        parentFolder.itemId,
        targetName,
      );

      const now = new Date().toISOString();
      const actorDisplay =
        caller.callerDisplayName ?? context.tenantContext.actorName;

      if (existing) {
        if (conflictBehavior === 'fail') {
          throw createMockGraphError(
            'conflict',
            `A file named "${targetName}" already exists in this folder.`,
          );
        }
        if (conflictBehavior === 'replace') {
          if (
            options?.ifMatchETag &&
            options.ifMatchETag !== existing.eTag
          ) {
            throw createMockGraphError(
              'conflict',
              `ETag mismatch when replacing "${targetName}".`,
            );
          }
          const nextVer =
            (Number.parseFloat(existing.versionLabel) || 1) + 1;
          existing.sizeBytes = fullBytes.byteLength;
          existing.contentBytes = fullBytes;
          existing.mimeType =
            options?.mimeType ??
            existing.mimeType ??
            'application/octet-stream';
          existing.lastModifiedAt = now;
          existing.lastModifiedByDisplayName = actorDisplay;
          existing.versionLabel = `${nextVer}.0`;
          existing.eTag = `"etag-${existing.itemId}-${nextVer}"`;
          return this.backend.toDocumentStoreItem(partition, existing);
        }

        // 'rename' conflict behavior
        const dotIdx = targetName.lastIndexOf('.');
        const stem = dotIdx > 0 ? targetName.slice(0, dotIdx) : targetName;
        const ext = dotIdx > 0 ? targetName.slice(dotIdx) : '';
        let suffix = 1;
        while (
          this.backend.findChildByName(
            partition,
            parentFolder.itemId,
            `${stem} (${suffix})${ext}`,
          )
        ) {
          suffix += 1;
        }
        targetName = `${stem} (${suffix})${ext}`;
      }

      const itemId = `sp-file-${randomUUID()}`;
      const relativePath = parentFolder.relativePath
        ? `${parentFolder.relativePath}/${targetName}`
        : targetName;
      const webUrl = `${parentFolder.webUrl}/${encodeURIComponent(targetName)}`;

      const created = {
        itemId,
        tenantId: partition.tenantId,
        storeId: partition.storeId,
        siteId: partition.siteId,
        driveId: partition.driveId,
        parentItemId: parentFolder.itemId,
        itemType: 'file' as const,
        name: targetName,
        relativePath,
        webUrl,
        sizeBytes: fullBytes.byteLength,
        mimeType: options?.mimeType ?? 'application/octet-stream',
        eTag: `"etag-${itemId}-1"`,
        versionLabel: '1.0',
        createdAt: now,
        createdByDisplayName: actorDisplay,
        lastModifiedAt: now,
        lastModifiedByDisplayName: actorDisplay,
        contentBytes: fullBytes,
        inheritsFromParent: true,
        directGrants: [],
        sharingLinks: [],
      };
      partition.items.set(itemId, created);
      return this.backend.toDocumentStoreItem(partition, created);
    });
  }

  public async createFolder(
    context: UserAccessContext,
    containerRef: DocumentStoreContainerRef,
    name: string,
    conflictBehavior: 'fail' | 'rename' | 'replace' = 'fail',
  ): Promise<DocumentStoreItem> {
    const userCtx = this.assertUserContext(context);
    const caller = await this.resolveCallerIdentity(userCtx);
    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(containerRef);
      const folderItemId = containerRef.folderItemId ?? 'root';
      this.backend.recordCall(
        caller,
        'graph_v1',
        'createFolder',
        containerRef.driveId,
        folderItemId,
      );

      const { partition, item: parentFolder } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        containerRef.siteId,
        containerRef.driveId,
        folderItemId,
      );
      this.backend.assertCallerAccess(
        caller,
        partition,
        parentFolder,
        'contribute',
      );

      const created = this.backend.createChildFolder({
        partition,
        parent: parentFolder,
        name: name.trim(),
        actorDisplayName:
          caller.callerDisplayName ?? userCtx.tenantContext.actorName,
        conflictBehavior,
      });

      return this.backend.toDocumentStoreItem(partition, created);
    });
  }

  public async renameItem(
    context: UserAccessContext,
    itemRef: DocumentStoreItemRef,
    newName: string,
  ): Promise<DocumentStoreItem> {
    const userCtx = this.assertUserContext(context);
    const caller = await this.resolveCallerIdentity(userCtx);
    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(itemRef);
      this.backend.recordCall(
        caller,
        'graph_v1',
        'renameItem',
        itemRef.driveId,
        itemRef.itemId,
      );
      const { partition, item } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        itemRef.siteId,
        itemRef.driveId,
        itemRef.itemId,
      );
      this.backend.assertCallerAccess(caller, partition, item, 'edit');

      const trimmed = newName.trim();
      if (item.parentItemId) {
        const sibling = this.backend.findChildByName(
          partition,
          item.parentItemId,
          trimmed,
        );
        if (sibling && sibling.itemId !== item.itemId) {
          throw createMockGraphError(
            'conflict',
            `An item named "${trimmed}" already exists in the parent folder.`,
          );
        }
      }

      const parent = item.parentItemId
        ? partition.items.get(item.parentItemId)
        : null;
      item.name = trimmed;
      item.relativePath = parent?.relativePath
        ? `${parent.relativePath}/${trimmed}`
        : trimmed;
      item.webUrl = parent
        ? `${parent.webUrl}/${encodeURIComponent(trimmed)}`
        : item.webUrl;
      item.lastModifiedAt = new Date().toISOString();
      item.lastModifiedByDisplayName =
        caller.callerDisplayName ?? userCtx.tenantContext.actorName;

      return this.backend.toDocumentStoreItem(partition, item);
    });
  }

  public async moveItem(
    context: DocumentAccessContext,
    itemRef: DocumentStoreItemRef,
    destinationContainerRef: DocumentStoreContainerRef,
    newName?: string,
  ): Promise<DocumentStoreItem> {
    const caller = await this.resolveCallerIdentity(context);
    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(itemRef);
      this.assertStoreTargetScope(destinationContainerRef);
      this.backend.recordCall(
        caller,
        'graph_v1',
        'moveItem',
        itemRef.driveId,
        itemRef.itemId,
      );
      const { partition, item } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        itemRef.siteId,
        itemRef.driveId,
        itemRef.itemId,
      );
      this.backend.assertCallerAccess(caller, partition, item, 'edit');

      const destFolderId = destinationContainerRef.folderItemId ?? 'root';
      const { item: destParent } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        destinationContainerRef.siteId,
        destinationContainerRef.driveId,
        destFolderId,
      );
      this.backend.assertCallerAccess(caller, partition, destParent, 'edit');

      const targetName = (newName ?? item.name).trim();
      const collision = this.backend.findChildByName(
        partition,
        destParent.itemId,
        targetName,
      );
      if (collision && collision.itemId !== item.itemId) {
        throw createMockGraphError(
          'conflict',
          `An item named "${targetName}" already exists in the destination folder.`,
        );
      }

      item.parentItemId = destParent.itemId;
      item.name = targetName;
      item.relativePath = destParent.relativePath
        ? `${destParent.relativePath}/${targetName}`
        : targetName;
      item.webUrl = `${destParent.webUrl}/${encodeURIComponent(targetName)}`;
      item.lastModifiedAt = new Date().toISOString();
      item.lastModifiedByDisplayName =
        caller.callerDisplayName ?? '1Squared User';

      return this.backend.toDocumentStoreItem(partition, item);
    });
  }

  public async deleteItem(
    context: UserAccessContext,
    itemRef: DocumentStoreItemRef,
  ): Promise<void> {
    const userCtx = this.assertUserContext(context);
    const caller = await this.resolveCallerIdentity(userCtx);
    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(itemRef);
      this.backend.recordCall(
        caller,
        'graph_v1',
        'deleteItem',
        itemRef.driveId,
        itemRef.itemId,
      );
      const { partition, item } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        itemRef.siteId,
        itemRef.driveId,
        itemRef.itemId,
      );
      this.backend.assertCallerAccess(caller, partition, item, 'edit');

      // Delete item and any descendants
      const toDelete = [item.itemId];
      while (toDelete.length > 0) {
        const curId = toDelete.pop()!;
        for (const child of partition.items.values()) {
          if (child.parentItemId === curId) {
            toDelete.push(child.itemId);
          }
        }
        partition.items.delete(curId);
      }
    });
  }

  public async getWebUrl(
    context: UserAccessContext,
    itemRef: DocumentStoreItemRef,
  ): Promise<{ webUrl: string; openInAppUrl?: string }> {
    const userCtx = this.assertUserContext(context);
    const caller = await this.resolveCallerIdentity(userCtx);
    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(itemRef);
      this.backend.recordCall(
        caller,
        'graph_v1',
        'getWebUrl',
        itemRef.driveId,
        itemRef.itemId,
      );
      const { partition, item } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        itemRef.siteId,
        itemRef.driveId,
        itemRef.itemId,
      );
      this.backend.assertCallerAccess(caller, partition, item, 'read');

      const lower = item.name.toLowerCase();
      let openInAppUrl: string | undefined;
      if (lower.endsWith('.docx') || lower.endsWith('.doc')) {
        openInAppUrl = `ms-word:ofe|u|${item.webUrl}`;
      } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        openInAppUrl = `ms-excel:ofe|u|${item.webUrl}`;
      } else if (lower.endsWith('.pptx') || lower.endsWith('.ppt')) {
        openInAppUrl = `ms-powerpoint:ofe|u|${item.webUrl}`;
      }

      return { webUrl: item.webUrl, openInAppUrl };
    });
  }

  public async getEffectiveAccess(
    context: UserAccessContext,
    itemRef: DocumentStoreItemRef,
  ): Promise<DocumentEffectiveAccess> {
    const userCtx = this.assertUserContext(context);
    const caller = await this.resolveCallerIdentity(userCtx);
    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(itemRef);
      this.backend.recordCall(
        caller,
        'graph_v1',
        'getEffectiveAccess',
        itemRef.driveId,
        itemRef.itemId,
      );
      const { partition, item } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        itemRef.siteId,
        itemRef.driveId,
        itemRef.itemId,
      );
      const level = this.backend.computeUserEffectiveLevel(
        caller,
        partition,
        item,
      );
      return this.backend.toEffectiveAccessObject(level);
    });
  }

  // ============================================================================
  // Provisioning-Context Operations
  // ============================================================================

  public async testConnection(
    context: ProvisioningAccessContext,
  ): Promise<DocumentStoreConnectionTestResult> {
    const provCtx = this.assertProvisioningContext(context);
    const startMs = Date.now();
    try {
      const caller = await this.resolveCallerIdentity(provCtx, undefined, true);
      const sp = this.storeConfig.sharepoint;
      if (!sp) {
        const missingSpResult: DocumentStoreConnectionTestResult = {
          ok: false,
          providerType: 'sharepoint',
          storeId: this.storeId,
          checkedAt: new Date().toISOString(),
          latencyMs: Math.max(1, Date.now() - startMs),
          errorCode: 'misconfigured',
          errorReason: 'SharePoint site and library settings are missing.',
          checks: {
            credentialsValid: true,
            targetSiteReachable: false,
            librariesFound: false,
            permissionManagementSupported: false,
          },
        };
        this.backend.setStoreHealthResult(
          this.tenantContext,
          this.storeId,
          missingSpResult,
        );
        return missingSpResult;
      }

      this.assertTokenClaimsLeastPrivilege(provCtx, {
        appToken: caller.accessToken,
      });

      this.backend.recordCall(caller, 'graph_v1', 'testConnection');

      const siteId = sp.siteId ?? `site-${this.storeId}`;
      for (const lib of sp.libraries) {
        const driveId = lib.driveId ?? `drive-${this.storeId}-${lib.libraryId}`;
        this.backend.ensureDrivePartition({
          tenantId: this.tenantContext.tenantId,
          storeId: this.storeId,
          siteId,
          driveId,
          hostname: sp.hostname,
          siteRelativePath: sp.siteRelativePath,
          libraryUrlSegment: lib.libraryUrlSegment,
        });
      }

      if (
        this.backend.isSitePermissionsReadForbidden({
          tenantId: this.tenantContext.tenantId,
          storeId: this.storeId,
          siteId,
        })
      ) {
        const unverifiedResult: DocumentStoreConnectionTestResult = {
          ok: true,
          providerType: 'sharepoint',
          storeId: this.storeId,
          checkedAt: new Date().toISOString(),
          latencyMs: Math.max(1, Date.now() - startMs),
          roleVerificationStatus: 'not_verified',
          warnings: [
            `SharePoint site permission grant role could not be verified because GET /sites/${siteId}/permissions returned 403 Forbidden. Confirm that the site grant includes "fullcontrol" before provisioning folder permissions.`,
          ],
          checks: {
            credentialsValid: true,
            targetSiteReachable: true,
            librariesFound: sp.libraries.length > 0,
            permissionManagementSupported: false,
          },
        };
        this.backend.setStoreHealthResult(
          this.tenantContext,
          this.storeId,
          unverifiedResult,
        );
        return unverifiedResult;
      }

      const grantRole = this.backend.getSitePermissionGrantRole({
        tenantId: this.tenantContext.tenantId,
        storeId: this.storeId,
        siteId,
      });
      if (grantRole !== 'fullcontrol') {
        const insufficientResult: DocumentStoreConnectionTestResult = {
          ok: false,
          providerType: 'sharepoint',
          storeId: this.storeId,
          checkedAt: new Date().toISOString(),
          latencyMs: Math.max(1, Date.now() - startMs),
          errorCode: 'access_denied',
          errorReasonCode: 'site_grant_role_insufficient',
          roleVerificationStatus: 'insufficient',
          errorReason: `SharePoint site permission grant role "${grantRole}" on site "${siteId}" (store "${this.storeId}") is insufficient. Folder permission management requires "fullcontrol".`,
          checks: {
            credentialsValid: true,
            targetSiteReachable: true,
            librariesFound: sp.libraries.length > 0,
            permissionManagementSupported: false,
          },
        };
        this.backend.setStoreHealthResult(
          this.tenantContext,
          this.storeId,
          insufficientResult,
        );
        return insufficientResult;
      }

      const okResult: DocumentStoreConnectionTestResult = {
        ok: true,
        providerType: 'sharepoint',
        storeId: this.storeId,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.max(1, Date.now() - startMs),
        roleVerificationStatus: 'verified',
        checks: {
          credentialsValid: true,
          targetSiteReachable: true,
          librariesFound: sp.libraries.length > 0,
          permissionManagementSupported: true,
        },
      };
      this.backend.setStoreHealthResult(
        this.tenantContext,
        this.storeId,
        okResult,
      );
      return okResult;
    } catch (err) {
      const code =
        (err as { code?: DocumentStoreErrorCode })?.code ?? 'unavailable';
      const reasonCode = (err as { reason?: DocumentStoreErrorReason })?.reason;
      const siteIdForDiag =
        this.storeConfig.sharepoint?.siteId ?? `site-${this.storeId}`;
      const reason =
        reasonCode === 'site_access_not_granted'
          ? `SharePoint access not granted for site "${siteIdForDiag}" (store "${this.storeId}"). Grant Sites.Selected permissions to the application before use.`
          : err instanceof Error
            ? err.message
            : 'Connection check failed.';
      const failedResult: DocumentStoreConnectionTestResult = {
        ok: false,
        providerType: 'sharepoint',
        storeId: this.storeId,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.max(1, Date.now() - startMs),
        errorCode: code,
        ...(reasonCode ? { errorReasonCode: reasonCode } : {}),
        errorReason: reason,
        checks: {
          credentialsValid: code !== 'misconfigured',
          targetSiteReachable:
            code !== 'not_found' &&
            code !== 'unavailable' &&
            reasonCode !== 'site_access_not_granted',
          librariesFound: false,
          permissionManagementSupported:
            code !== 'access_denied' && code !== 'misconfigured',
        },
      };
      this.backend.setStoreHealthResult(
        this.tenantContext,
        this.storeId,
        failedResult,
      );
      return failedResult;
    }
  }

  public async resolveLocation(
    context: ProvisioningAccessContext,
    input: DocumentLocationResolutionInput,
  ): Promise<DocumentLocationResolutionResult> {
    const provCtx = this.assertProvisioningContext(context);
    const caller = await this.resolveCallerIdentity(provCtx);
    return this.executeWithResilience(() => {
      this.backend.recordCall(caller, 'graph_v1', 'resolveLocation');
      const sp = this.storeConfig.sharepoint;
      const parsed = parseSharePointLocationUrl(
        input.rawUrlOrPath,
        sp?.hostname,
        sp?.siteRelativePath,
      );

      if (!parsed.valid || !parsed.libraryUrlSegment) {
        return {
          resolved: false,
          errorCode: 'not_found',
          errorMessage:
            parsed.errorReason ?? 'Could not parse SharePoint URL.',
        };
      }

      const siteId = sp?.siteId ?? `site-${this.storeId}`;
      const requestedLib = input.libraryId
        ? sp?.libraries.find(
            (l) =>
              l.libraryId?.toLowerCase() === input.libraryId!.toLowerCase() ||
              l.libraryUrlSegment?.toLowerCase() ===
                input.libraryId!.toLowerCase() ||
              l.displayName?.toLowerCase() === input.libraryId!.toLowerCase(),
          )
        : undefined;
      if (input.libraryId && sp?.libraries?.length && !requestedLib) {
        return {
          resolved: false,
          libraryId: input.libraryId,
          errorCode: 'not_found',
          errorMessage: `Requested library "${input.libraryId}" does not exist in store "${this.storeId}".`,
        };
      }
      const directMatchedLib = sp?.libraries.find(
        (l) =>
          l.libraryUrlSegment?.toLowerCase() ===
            parsed.libraryUrlSegment!.toLowerCase() ||
          l.displayName?.toLowerCase() ===
            parsed.libraryUrlSegment!.toLowerCase() ||
          l.libraryId?.toLowerCase() ===
            parsed.libraryUrlSegment!.toLowerCase(),
      );
      if (
        input.libraryId &&
        directMatchedLib &&
        directMatchedLib.libraryId.toLowerCase() !==
          (requestedLib?.libraryId ?? input.libraryId).toLowerCase()
      ) {
        return {
          resolved: false,
          libraryId: directMatchedLib.libraryId,
          errorCode: 'invalid_path',
          errorMessage: `Resolved library "${directMatchedLib.libraryId}" does not match requested library "${input.libraryId}".`,
        };
      }
      const isRelativeInput = !/^https?:\/\//i.test(input.rawUrlOrPath.trim());
      const matchedLib =
        directMatchedLib ??
        (isRelativeInput
          ? requestedLib ??
            (!input.libraryId && sp?.libraries?.length === 1
              ? sp.libraries[0]
              : undefined)
          : undefined);
      const effectiveFolderRelativePath =
        !directMatchedLib && matchedLib
          ? [parsed.libraryUrlSegment, parsed.folderRelativePath]
              .filter(Boolean)
              .join('/')
          : parsed.folderRelativePath;

      const libraryId =
        matchedLib?.libraryId ??
        requestedLib?.libraryId ??
        parsed.libraryUrlSegment.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const driveId =
        matchedLib?.driveId ?? `drive-${this.storeId}-${libraryId}`;

      const partition = this.backend.ensureDrivePartition({
        tenantId: this.tenantContext.tenantId,
        storeId: this.storeId,
        siteId,
        driveId,
        hostname: parsed.hostname ?? sp?.hostname ?? 'contoso.sharepoint.com',
        siteRelativePath:
          parsed.siteRelativePath ?? sp?.siteRelativePath ?? '/sites/Default',
        libraryUrlSegment:
          matchedLib?.libraryUrlSegment ?? parsed.libraryUrlSegment,
      });

      if (!effectiveFolderRelativePath) {
        const rootItem = partition.items.get('root')!;
        return {
          resolved: true,
          libraryId,
          siteId,
          driveId,
          libraryName: matchedLib?.displayName ?? parsed.libraryUrlSegment,
          folderItemId: 'root',
          relativePath: '',
          webUrl: rootItem.webUrl,
        };
      }

      const folderItem = this.backend.findFolderByRelativePath(
        partition,
        effectiveFolderRelativePath,
      );
      if (!folderItem) {
        return {
          resolved: false,
          libraryId,
          siteId,
          driveId,
          libraryName: matchedLib?.displayName ?? parsed.libraryUrlSegment,
          errorCode: 'not_found',
          errorMessage: `Folder "${effectiveFolderRelativePath}" does not exist in library "${matchedLib?.libraryUrlSegment ?? parsed.libraryUrlSegment}".`,
        };
      }

      return {
        resolved: true,
        libraryId,
        siteId,
        driveId,
        libraryName: matchedLib?.displayName ?? parsed.libraryUrlSegment,
        folderItemId: folderItem.itemId,
        relativePath: folderItem.relativePath,
        webUrl: folderItem.webUrl,
      };
    });
  }

  public async ensureFolderTree(
    context: ProvisioningAccessContext,
    rootRef: DocumentStoreContainerRef,
    tree: readonly DocumentStoreFolderTreeNode[],
  ): Promise<DocumentFolderEnsureResult> {
    const provCtx = this.assertProvisioningContext(context);
    const caller = await this.resolveCallerIdentity(provCtx);
    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(rootRef);
      const rootFolderId = rootRef.folderItemId ?? 'root';
      this.backend.recordCall(
        caller,
        'graph_v1',
        'ensureFolderTree',
        rootRef.driveId,
        rootFolderId,
      );

      const { partition, item: rootFolder } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        rootRef.siteId,
        rootRef.driveId,
        rootFolderId,
      );

      const folderItemMap: Record<string, string> = {};
      let firstCreatedOrFoundRoot = rootFolder;

      const ensureNodesRecursive = (
        parentItem: typeof rootFolder,
        nodes: readonly DocumentStoreFolderTreeNode[],
        isTopLevel: boolean,
      ) => {
        for (const node of nodes) {
          let folder = this.backend.findChildByName(
            partition,
            parentItem.itemId,
            node.name,
          );
          if (!folder) {
            folder = this.backend.createChildFolder({
              partition,
              parent: parentItem,
              name: node.name,
              actorDisplayName: '1Squared Provisioning App',
              conflictBehavior: 'replace',
            });
          }
          if (isTopLevel && nodes.length === 1) {
            firstCreatedOrFoundRoot = folder;
          }
          folderItemMap[node.relativePath] = folder.itemId;
          if (node.children && node.children.length > 0) {
            ensureNodesRecursive(folder, node.children, false);
          }
        }
      };

      ensureNodesRecursive(rootFolder, tree, true);

      return {
        rootFolderItemId: firstCreatedOrFoundRoot.itemId,
        rootWebUrl: firstCreatedOrFoundRoot.webUrl,
        folderItemMap,
      };
    });
  }

  public async getPermissions(
    context: ProvisioningAccessContext,
    itemRef: DocumentStoreItemRef,
  ): Promise<DocumentPermissionSnapshot> {
    const provCtx = this.assertProvisioningContext(context);
    const caller = await this.resolveCallerIdentity(provCtx);
    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(itemRef);
      this.backend.recordCall(
        caller,
        'graph_v1',
        'getPermissions',
        itemRef.driveId,
        itemRef.itemId,
      );
      const { partition, item } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        itemRef.siteId,
        itemRef.driveId,
        itemRef.itemId,
      );
      const { grants: effectiveGrants } =
        this.backend.getEffectiveGrantsForItem(partition, item);

      const sourceGrants = item.inheritsFromParent
        ? effectiveGrants
        : item.directGrants;

      return {
        itemId: item.itemId,
        inheritsFromParent: item.inheritsFromParent,
        grants: sourceGrants.map((g) => ({
          principal: { ...g.principal },
          level: g.level,
        })),
        sharingLinks: item.sharingLinks.map((l) => ({ ...l })),
      };
    });
  }

  public async setPermissions(
    context: ProvisioningAccessContext,
    itemRef: DocumentStoreItemRef,
    intendedGrants: readonly DocumentPermissionGrant[],
    options: { inherit: boolean },
  ): Promise<DocumentPermissionSnapshot> {
    const provCtx = this.assertProvisioningContext(context);
    const caller = await this.resolveCallerIdentity(provCtx);
    return this.executeWithResilience(() => {
      this.assertStoreTargetScope(itemRef);
      const { partition, item } = this.backend.getItemOrThrow(
        this.tenantContext.tenantId,
        itemRef.siteId,
        itemRef.driveId,
        itemRef.itemId,
      );

      if (options.inherit) {
        // SharePoint REST API: resetroleinheritance
        this.backend.recordCall(
          caller,
          'sp_rest',
          'resetRoleInheritance',
          itemRef.driveId,
          itemRef.itemId,
        );
        item.inheritsFromParent = true;
        item.directGrants = [];
        item.sharingLinks = [];
      } else {
        const mappedGrants: DocumentPermissionGrant[] = [];
        for (const grant of intendedGrants) {
          if (grant.level === 'none') continue;
          const roleDescriptor = SHAREPOINT_ROLE_MAPPING[grant.level];
          if (!roleDescriptor) {
            throw createMockGraphError(
              'misconfigured',
              `Unsupported abstract access level "${grant.level}".`,
            );
          }
          mappedGrants.push({
            principal: { ...grant.principal },
            level: roleDescriptor.abstractLevel,
          });
        }

        // SharePoint REST API: breakroleinheritance(copyRoleAssignments=false, clearSubscopes=false)
        this.backend.recordCall(
          caller,
          'sp_rest',
          'breakRoleInheritance',
          itemRef.driveId,
          itemRef.itemId,
        );
        // Microsoft Graph v1.0: apply mapped role grants
        this.backend.recordCall(
          caller,
          'graph_v1',
          'setPermissions',
          itemRef.driveId,
          itemRef.itemId,
        );

        item.inheritsFromParent = false;
        item.directGrants = mappedGrants;
        item.sharingLinks = [];
      }

      const { grants: effectiveGrants } =
        this.backend.getEffectiveGrantsForItem(partition, item);
      const activeGrants = item.inheritsFromParent
        ? effectiveGrants
        : item.directGrants;

      return {
        itemId: item.itemId,
        inheritsFromParent: item.inheritsFromParent,
        grants: activeGrants.map((g) => ({
          principal: { ...g.principal },
          level: g.level,
        })),
        sharingLinks: [],
      };
    });
  }

  public async resolvePrincipal(
    context: ProvisioningAccessContext,
    lookup: DocumentPrincipalLookupInput,
  ): Promise<DocumentPrincipalRef | null> {
    const provCtx = this.assertProvisioningContext(context);
    const caller = await this.resolveCallerIdentity(provCtx);
    return this.executeWithResilience(() => {
      this.backend.recordCall(caller, 'graph_v1', 'resolvePrincipal');
      return this.backend.resolveDirectoryPrincipal(
        this.tenantContext.tenantId,
        lookup,
      );
    });
  }
}

export interface SharePointHealthCheckJobInput {
  jobId?: string;
  tenantId: string;
  correlationId?: string;
  tenantContext: TenantContext;
  stores: readonly DocumentStoreConfig[];
  tokenService: DocumentStoreTokenService;
  backend: MockSharePointGraphBackend;
}

/**
 * Scheduled per-tenant background health check job (`R195`).
 * Requires a valid `tenantId` via `runTenantBackgroundJob` (throws `TENANCY_JOB_ERROR` without one),
 * verifies `tenantContext.tenantId === tenantId`, and caches the connection test result
 * per `(tenantId, storeId)`.
 */
export async function runTenantSharePointHealthCheckJob(
  input: SharePointHealthCheckJobInput,
): Promise<DocumentStoreConnectionTestResult[]> {
  return runTenantBackgroundJob(
    {
      jobId: input.jobId ?? `sp-health-${randomUUID()}`,
      tenantId: input.tenantId,
      correlationId:
        input.correlationId ??
        input.tenantContext?.correlationId ??
        `corr-health-${randomUUID()}`,
      payload: input,
    },
    async (job) => {
      if (
        !job.payload.tenantContext?.tenantId ||
        job.payload.tenantContext.tenantId !== job.tenantId
      ) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Health check job tenantId must match TenantContext.tenantId.',
        );
      }
      const results: DocumentStoreConnectionTestResult[] = [];
      for (const storeConfig of job.payload.stores) {
        if (!storeConfig.enabled || storeConfig.providerType !== 'sharepoint') {
          continue;
        }
        const provider = new SharePointDocumentStoreProvider({
          tenantContext: job.payload.tenantContext,
          storeConfig,
          tokenService: job.payload.tokenService,
          backend: job.payload.backend,
        });
        const provCtx: ProvisioningAccessContext = {
          kind: 'provisioning',
          tenantContext: job.payload.tenantContext,
          triggerEvent: 'scheduled.store.health_check',
        };
        const res = await provider.testConnection(provCtx);
        results.push(res);
      }
      return results;
    },
  );
}
