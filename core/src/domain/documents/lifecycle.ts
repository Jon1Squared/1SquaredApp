/**
 * Matter Document Lifecycle Service & Idempotent Background Jobs (`core/src/domain/documents/lifecycle.ts`).
 *
 * Implements Section 6:
 * - Creation (`provisionMatterDocumentsJob`)
 * - Existing folder linking (`linkExistingMatterFolderJob`)
 * - Team, restriction or department change (`recalculateMatterPermissionsJob`, `moveMatterFolderJob`)
 * - Closure (`closeMatterFolderJob`) and reopening (`reopenMatterFolderJob`)
 * - Apply template additions to open matters (`applyTemplateAdditionsToOpenMattersJob`)
 *
 * Rules enforced:
 * - Every job runs through `runTenantBackgroundJob` and refuses to execute without a `tenantId` and `correlationId`.
 * - Every provider call uses an explicit `ProvisioningAccessContext` (`kind: 'provisioning'`).
 * - Provisioning is idempotent: re-running after a partial failure completes the missing steps without duplicating folders.
 */

import { randomUUID } from 'node:crypto';
import type {
  DocumentAccessConfig,
  DocumentRoutingRule,
  DocumentStoreConfig,
  DocumentStoreErrorCode,
  DocumentStoreProvider,
  MatterFolderTemplatesConfig,
  ProvisioningAccessContext,
  TenantContext,
} from '../../api/index';
import {
  runTenantBackgroundJob,
  type TenantDocumentStoreRepository,
} from '../../tenancy/index';
import { buildDocumentStoreAuditEvent } from './audit';
import { resolveMatterDocumentRoute } from './routing';
import {
  compileDepartmentFolderPermissions,
  compileLibraryRootPermissions,
  compileMatterFolderPermissions,
  compileTeamFolderPermissions,
  evaluateLibraryScopeScaleStatus,
} from './security';
import {
  computeAdditiveTemplateDiff,
  resolveMatterFolderTemplate,
  toProviderFolderTreeNodes,
} from './templates';
import type {
  CompiledFolderTemplateNode,
  DocumentLifecycleJobRecord,
  LibraryScopeScaleStatus,
  MatterDocumentLocationRecord,
  MatterRoutingSubject,
} from './types';

export type DepartmentChangeStrategy = 'repermission_in_place' | 'move_folder';

export interface DocumentLifecycleDependencies {
  repository: TenantDocumentStoreRepository;
  getProvider: (storeId: string) => DocumentStoreProvider;
  stores: readonly DocumentStoreConfig[];
  routingRules: readonly DocumentRoutingRule[];
  accessConfig: DocumentAccessConfig;
  templatesConfig: MatterFolderTemplatesConfig;
  matterFolderNameTemplate: string;
  resolveUserEntraObjectId: (
    ctx: TenantContext,
    userId: string,
  ) => {
    entraObjectId: string;
    upn?: string;
    displayName?: string;
  } | null;
  protectedContainerPaths?: readonly string[];
  onAfterMatterDocumentsProvisioned?: (payload: {
    ctx: TenantContext;
    matterId: string;
    location: MatterDocumentLocationRecord;
  }) => Promise<void> | void;
  onBeforeMatterDocumentsClose?: (payload: {
    ctx: TenantContext;
    matterId: string;
    location: MatterDocumentLocationRecord;
  }) => Promise<{ retentionLabelId?: string | null } | void> | { retentionLabelId?: string | null } | void;
}

function createProvisioningContext(
  ctx: TenantContext,
  triggerEvent: string,
): ProvisioningAccessContext {
  return {
    kind: 'provisioning',
    tenantContext: ctx,
    triggeredByUserId: ctx.actorId || undefined,
    triggerEvent,
  };
}

function collectNodesWithAccessOverrides(
  nodes: readonly CompiledFolderTemplateNode[],
): CompiledFolderTemplateNode[] {
  const result: CompiledFolderTemplateNode[] = [];
  for (const node of nodes) {
    if (node.accessOverride) {
      result.push(node);
    }
    if (node.children.length > 0) {
      result.push(...collectNodesWithAccessOverrides(node.children));
    }
  }
  return result;
}

/**
 * Ensures the library root, `{departmentCode}` folder, and `{departmentCode}/{teamCode}` folder exist
 * and have their group permissions set idempotently. Returns the parent folder reference where
 * the matter root folder should be placed.
 */
async function ensureHierarchyAndGroupScopes(params: {
  ctx: TenantContext;
  provCtx: ProvisioningAccessContext;
  deps: DocumentLifecycleDependencies;
  provider: DocumentStoreProvider;
  store: DocumentStoreConfig;
  libraryId: string;
  siteId: string;
  driveId: string;
  basePathSegments: readonly string[];
  subject: MatterRoutingSubject;
}): Promise<{
  parentItemId: string;
}> {
  const {
    ctx,
    provCtx,
    deps,
    provider,
    store,
    libraryId,
    siteId,
    driveId,
    basePathSegments,
    subject,
  } = params;

  // Ensure library root permissions if configured
  const rootGrants = compileLibraryRootPermissions({
    accessConfig: deps.accessConfig,
    storeId: store.storeId,
  });
  if (rootGrants.length > 0) {
    await provider.setPermissions(
      provCtx,
      { storeId: store.storeId, siteId, driveId, itemId: 'root' },
      rootGrants,
      { inherit: false },
    );
    const existingRootScope = await deps.repository.findFolderScope(ctx, {
      storeId: store.storeId,
      libraryId,
      scopeType: 'library_root',
      scopeKey: 'root',
    });
    await deps.repository.putFolderScope(ctx, {
      id: existingRootScope?.id ?? `scope-${randomUUID()}`,
      tenantId: ctx.tenantId,
      storeId: store.storeId,
      libraryId,
      scopeType: 'library_root',
      scopeKey: 'root',
      providerItemId: 'root',
      hasUniquePermissions: true,
      intendedGrants: rootGrants,
      lastVerifiedAt: new Date().toISOString(),
    });
  }

  if (basePathSegments.length === 0) {
    return { parentItemId: 'root' };
  }

  // Create basePath folder chain idempotently
  let treeNodes: {
    name: string;
    relativePath: string;
    children?: typeof treeNodes;
  }[] = [];
  for (let i = basePathSegments.length - 1; i >= 0; i--) {
    const seg = basePathSegments[i]!;
    const relPath = basePathSegments.slice(0, i + 1).join('/');
    treeNodes = [
      {
        name: seg,
        relativePath: relPath,
        children: treeNodes,
      },
    ];
  }

  const ensuredBase = await provider.ensureFolderTree(
    provCtx,
    {
      storeId: store.storeId,
      libraryId,
      siteId,
      driveId,
      folderItemId: 'root',
    },
    treeNodes,
  );

  // First segment corresponds to department folder
  const deptRelPath = basePathSegments[0]!;
  const deptItemId = ensuredBase.folderItemMap[deptRelPath];
  if (deptItemId) {
    const deptPlan = compileDepartmentFolderPermissions({
      accessConfig: deps.accessConfig,
      storeId: store.storeId,
      departmentId: subject.departmentId,
    });
    await provider.setPermissions(
      provCtx,
      { storeId: store.storeId, siteId, driveId, itemId: deptItemId },
      deptPlan.grants,
      { inherit: deptPlan.inherit },
    );
    const existingDeptScope = await deps.repository.findFolderScope(ctx, {
      storeId: store.storeId,
      libraryId,
      scopeType: 'department',
      scopeKey: subject.departmentId,
    });
    await deps.repository.putFolderScope(ctx, {
      id: existingDeptScope?.id ?? `scope-${randomUUID()}`,
      tenantId: ctx.tenantId,
      storeId: store.storeId,
      libraryId,
      scopeType: 'department',
      scopeKey: subject.departmentId,
      providerItemId: deptItemId,
      hasUniquePermissions: !deptPlan.inherit,
      intendedGrants: deptPlan.grants,
      lastVerifiedAt: new Date().toISOString(),
    });
  }

  // Second segment corresponds to team folder (when present)
  if (basePathSegments.length >= 2) {
    const teamRelPath = basePathSegments.slice(0, 2).join('/');
    const teamItemId = ensuredBase.folderItemMap[teamRelPath];
    if (teamItemId) {
      const teamPlan = compileTeamFolderPermissions({
        accessConfig: deps.accessConfig,
        storeId: store.storeId,
        departmentId: subject.departmentId,
        teamId: subject.teamId,
      });
      await provider.setPermissions(
        provCtx,
        { storeId: store.storeId, siteId, driveId, itemId: teamItemId },
        teamPlan.grants,
        { inherit: teamPlan.inherit },
      );
      const teamScopeKey = `${subject.departmentId}/${subject.teamId}`;
      const existingTeamScope = await deps.repository.findFolderScope(ctx, {
        storeId: store.storeId,
        libraryId,
        scopeType: 'team',
        scopeKey: teamScopeKey,
      });
      await deps.repository.putFolderScope(ctx, {
        id: existingTeamScope?.id ?? `scope-${randomUUID()}`,
        tenantId: ctx.tenantId,
        storeId: store.storeId,
        libraryId,
        scopeType: 'team',
        scopeKey: teamScopeKey,
        providerItemId: teamItemId,
        hasUniquePermissions: !teamPlan.inherit,
        intendedGrants: teamPlan.grants,
        lastVerifiedAt: new Date().toISOString(),
      });
    }
  }

  const deepestBaseRelPath = basePathSegments.join('/');
  const parentItemId = ensuredBase.folderItemMap[deepestBaseRelPath] ?? 'root';
  return { parentItemId };
}

/**
 * Provisions a matter's folder tree and security permissions idempotently in its routed document store.
 * Safe to retry on partial failure.
 */
export async function provisionMatterDocumentsJob(params: {
  ctx: TenantContext;
  deps: DocumentLifecycleDependencies;
  subject: MatterRoutingSubject;
  triggerEvent?: string;
  existingJobId?: string;
}): Promise<{
  job: DocumentLifecycleJobRecord;
  location: MatterDocumentLocationRecord;
}> {
  const {
    ctx,
    deps,
    subject,
    triggerEvent = 'matter.opened',
    existingJobId,
  } = params;

  return runTenantBackgroundJob(
    {
      jobId: existingJobId ?? `job-prov-${randomUUID()}`,
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      payload: { matterId: subject.matterId },
    },
    async (bgJob) => {
      const compiledTemplate = resolveMatterFolderTemplate({
        templatesConfig: deps.templatesConfig,
        departmentId: subject.departmentId,
        workTypeId: subject.workTypeId,
        practiceAreaId: subject.practiceAreaId,
        subject,
      });

      const deepestSubpath = compiledTemplate.flatRelativePaths.reduce(
        (longest, cur) => (cur.length > longest.length ? cur : longest),
        '',
      );

      const route = resolveMatterDocumentRoute({
        subject,
        stores: deps.stores,
        routingRules: deps.routingRules,
        matterFolderNameTemplate: deps.matterFolderNameTemplate,
        deepestTemplateSubpath: deepestSubpath,
      });

      const provider = deps.getProvider(route.store.storeId);
      const libraryCfg = route.store.sharepoint?.libraries.find(
        (l) => l.libraryId === route.libraryId,
      );
      const siteId =
        route.store.sharepoint?.siteId ?? `site-${route.store.storeId}`;
      const driveId =
        libraryCfg?.driveId ?? `drive-${route.store.storeId}-${route.libraryId}`;

      const existingLocations = await deps.repository.listMatterLocationsByMatterId(
        ctx,
        subject.matterId,
      );
      const existingLoc = existingLocations.find(
        (l) => l.storeId === route.store.storeId && l.libraryId === route.libraryId,
      );

      const now = new Date().toISOString();
      const existingJob = existingJobId
        ? await deps.repository.getLifecycleJobById(ctx, existingJobId)
        : null;

      let jobRecord: DocumentLifecycleJobRecord = await deps.repository.putLifecycleJob(
        ctx,
        {
          id: bgJob.jobId,
          tenantId: ctx.tenantId,
          correlationId: ctx.correlationId,
          storeId: route.store.storeId,
          matterId: subject.matterId,
          jobType: 'provision_matter',
          status: 'running',
          attemptCount: (existingJob?.attemptCount ?? 0) + 1,
          maxAttempts: existingJob?.maxAttempts ?? 3,
          triggeredByUserId: ctx.actorId || null,
          triggerEvent,
          payload: {
            matterId: subject.matterId,
            libraryId: route.libraryId,
            templateId: compiledTemplate.templateId,
          },
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt: existingJob?.createdAt ?? now,
          updatedAt: now,
        },
      );

      // Put pending location record so the matter can open even if provisioning fails mid-flight
      let locationRecord: MatterDocumentLocationRecord =
        await deps.repository.putMatterLocation(ctx, {
          id: existingLoc?.id ?? `loc-${randomUUID()}`,
          tenantId: ctx.tenantId,
          matterId: subject.matterId,
          storeId: route.store.storeId,
          libraryId: route.libraryId,
          providerSiteId: siteId,
          providerDriveId: driveId,
          providerFolderItemId: existingLoc?.providerFolderItemId ?? '',
          webUrl: existingLoc?.webUrl ?? '',
          relativePath: route.matterRelativePath,
          folderItemMap: existingLoc?.folderItemMap ?? {},
          templateId: compiledTemplate.templateId,
          templateVersion: compiledTemplate.version,
          provisioningStatus: 'pending',
          linkMode: 'provisioned',
          routingMismatchNote: null,
          hasUniquePermissions: false,
          uniqueScopeCount: 0,
          intendedGrants: [],
          lastJobId: jobRecord.id,
          lastErrorCode: null,
          lastErrorMessage: null,
          provisionedAt: existingLoc?.provisionedAt ?? null,
          updatedAt: now,
        });

      const provCtx = createProvisioningContext(ctx, triggerEvent);

      try {
        // 1. Ensure department and team folders + group permissions
        const { parentItemId } = await ensureHierarchyAndGroupScopes({
          ctx,
          provCtx,
          deps,
          provider,
          store: route.store,
          libraryId: route.libraryId,
          siteId,
          driveId,
          basePathSegments: route.basePathSegments,
          subject,
        });

        // 2. Ensure matter root folder and template subfolder tree idempotently
        function prefixTreeRelativePaths(
          nodes: ReturnType<typeof toProviderFolderTreeNodes>,
          rootPrefix: string,
        ): ReturnType<typeof toProviderFolderTreeNodes> {
          return nodes.map((node) => ({
            ...node,
            relativePath: `${rootPrefix}/${node.relativePath}`,
            children: node.children
              ? prefixTreeRelativePaths(node.children, rootPrefix)
              : undefined,
          }));
        }

        const matterTree = [
          {
            name: route.matterFolderName,
            relativePath: route.matterFolderName,
            children: prefixTreeRelativePaths(
              toProviderFolderTreeNodes(compiledTemplate.nodes),
              route.matterFolderName,
            ),
          },
        ];

        const ensuredMatter = await provider.ensureFolderTree(
          provCtx,
          {
            storeId: route.store.storeId,
            libraryId: route.libraryId,
            siteId,
            driveId,
            folderItemId: parentItemId,
          },
          matterTree,
        );

        const matterFolderItemId =
          ensuredMatter.folderItemMap[route.matterFolderName] ??
          ensuredMatter.rootFolderItemId;

        const cleanSubfolderMap: Record<string, string> = {};
        const prefix = `${route.matterFolderName}/`;
        for (const [key, itemId] of Object.entries(ensuredMatter.folderItemMap)) {
          if (key.startsWith(prefix)) {
            cleanSubfolderMap[key.slice(prefix.length)] = itemId;
          }
        }

        // 3. Compile and apply matter folder permissions
        const permPlan = compileMatterFolderPermissions({
          accessConfig: deps.accessConfig,
          storeId: route.store.storeId,
          subject,
          resolveUserEntraObjectId: (userId) =>
            deps.resolveUserEntraObjectId(ctx, userId),
        });

        await provider.setPermissions(
          provCtx,
          {
            storeId: route.store.storeId,
            siteId,
            driveId,
            itemId: matterFolderItemId,
          },
          permPlan.grants,
          { inherit: permPlan.inherit },
        );

        const matterScopeKey = `MATTER:${subject.matterId}`;
        const existingMatterScope = await deps.repository.findFolderScope(ctx, {
          storeId: route.store.storeId,
          libraryId: route.libraryId,
          scopeType: 'matter',
          scopeKey: matterScopeKey,
        });
        await deps.repository.putFolderScope(ctx, {
          id: existingMatterScope?.id ?? `scope-${randomUUID()}`,
          tenantId: ctx.tenantId,
          storeId: route.store.storeId,
          libraryId: route.libraryId,
          scopeType: 'matter',
          scopeKey: matterScopeKey,
          providerItemId: matterFolderItemId,
          hasUniquePermissions: !permPlan.inherit,
          intendedGrants: permPlan.grants,
          lastVerifiedAt: new Date().toISOString(),
        });

        // 4. Apply any subfolder access overrides from the template
        const overrideNodes = collectNodesWithAccessOverrides(
          compiledTemplate.nodes,
        );
        let subfolderUniqueScopes = 0;
        for (const overrideNode of overrideNodes) {
          const subItemId = cleanSubfolderMap[overrideNode.relativePath];
          if (!subItemId || !overrideNode.accessOverride) continue;
          const subGrants = (overrideNode.accessOverride.grants ?? []).map(
            (g) => ({
              principal: {
                principalType: g.principalType,
                entraObjectId: g.principalId,
                displayName: g.principalId,
              },
              level: g.level,
            }),
          );
          await provider.setPermissions(
            provCtx,
            {
              storeId: route.store.storeId,
              siteId,
              driveId,
              itemId: subItemId,
            },
            subGrants,
            { inherit: overrideNode.accessOverride.inherit },
          );
          if (!overrideNode.accessOverride.inherit) {
            subfolderUniqueScopes += 1;
          }
        }

        const totalMatterUniqueScopes =
          (permPlan.consumesUniqueScope ? 1 : 0) + subfolderUniqueScopes;

        const completedAt = new Date().toISOString();
        locationRecord = await deps.repository.putMatterLocation(ctx, {
          ...locationRecord,
          providerFolderItemId: matterFolderItemId,
          webUrl: ensuredMatter.rootWebUrl,
          folderItemMap: cleanSubfolderMap,
          provisioningStatus: 'provisioned',
          hasUniquePermissions: !permPlan.inherit,
          uniqueScopeCount: totalMatterUniqueScopes,
          intendedGrants: permPlan.grants,
          lastErrorCode: null,
          lastErrorMessage: null,
          provisionedAt: completedAt,
          updatedAt: completedAt,
        });

        jobRecord = await deps.repository.putLifecycleJob(ctx, {
          ...jobRecord,
          status: 'succeeded',
          result: {
            locationId: locationRecord.id,
            providerFolderItemId: matterFolderItemId,
            hasUniquePermissions: !permPlan.inherit,
            subfolderCount: Object.keys(cleanSubfolderMap).length,
          },
          updatedAt: completedAt,
        });

        await deps.repository.appendAuditEvent(
          ctx,
          buildDocumentStoreAuditEvent({
            context: ctx,
            identityUsed: 'provisioning',
            triggerEvent,
            action: 'lifecycle:matter:provisioned',
            matterId: subject.matterId,
            storeId: route.store.storeId,
            libraryId: route.libraryId,
            providerItemId: matterFolderItemId,
            outcome: 'succeeded',
            metadata: {
              templateId: compiledTemplate.templateId,
              templateVersion: compiledTemplate.version,
              hasUniquePermissions: !permPlan.inherit,
              permissionReason: permPlan.reason,
              subfolderCount: Object.keys(cleanSubfolderMap).length,
            },
          }),
        );

        if (deps.onAfterMatterDocumentsProvisioned) {
          await deps.onAfterMatterDocumentsProvisioned({
            ctx,
            matterId: subject.matterId,
            location: locationRecord,
          });
        }

        return { job: jobRecord, location: locationRecord };
      } catch (err) {
        const failedAt = new Date().toISOString();
        const errorCode =
          (err as { code?: string })?.code ?? 'unavailable';

        locationRecord = await deps.repository.putMatterLocation(ctx, {
          ...locationRecord,
          provisioningStatus: 'failed',
          lastErrorCode: errorCode,
          lastErrorMessage: errorCode,
          updatedAt: failedAt,
        });

        jobRecord = await deps.repository.putLifecycleJob(ctx, {
          ...jobRecord,
          status: 'failed',
          lastErrorCode: errorCode,
          lastErrorMessage: errorCode,
          updatedAt: failedAt,
        });

        await deps.repository.appendAuditEvent(
          ctx,
          buildDocumentStoreAuditEvent({
            context: ctx,
            identityUsed: 'provisioning',
            triggerEvent,
            action: 'lifecycle:matter:provisioned',
            matterId: subject.matterId,
            storeId: route.store.storeId,
            libraryId: route.libraryId,
            providerItemId: locationRecord.providerFolderItemId || null,
            outcome: 'failed',
            errorCode,
            metadata: {
              attemptCount: jobRecord.attemptCount,
            },
          }),
        );

        return { job: jobRecord, location: locationRecord };
      }
    },
  );
}

/**
 * Links an existing folder in a configured document store to a matter, verifies whether its path
 * matches the expected routing layout, and optionally creates missing template folders.
 */
export async function linkExistingMatterFolderJob(params: {
  ctx: TenantContext;
  deps: DocumentLifecycleDependencies;
  subject: MatterRoutingSubject;
  storeId: string;
  libraryId: string;
  folderUrlOrPath: string;
  applyMissingTemplateFolders?: boolean;
  allowRoutingMismatchOverride?: boolean;
  triggerEvent?: string;
}): Promise<{
  job: DocumentLifecycleJobRecord;
  location: MatterDocumentLocationRecord;
}> {
  const {
    ctx,
    deps,
    subject,
    storeId,
    libraryId,
    folderUrlOrPath,
    applyMissingTemplateFolders = true,
    allowRoutingMismatchOverride = false,
    triggerEvent = 'matter.folder.linked',
  } = params;

  return runTenantBackgroundJob(
    {
      jobId: `job-link-${randomUUID()}`,
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      payload: { matterId: subject.matterId, storeId, libraryId },
    },
    async (bgJob) => {
      const provider = deps.getProvider(storeId);
      const provCtx = createProvisioningContext(ctx, triggerEvent);

      const expectedRoute = resolveMatterDocumentRoute({
        subject,
        stores: deps.stores,
        routingRules: deps.routingRules,
        matterFolderNameTemplate: deps.matterFolderNameTemplate,
      });

      const compiledTemplate = resolveMatterFolderTemplate({
        templatesConfig: deps.templatesConfig,
        departmentId: subject.departmentId,
        workTypeId: subject.workTypeId,
        practiceAreaId: subject.practiceAreaId,
        subject,
      });

      const resolvedLoc = await provider.resolveLocation(provCtx, {
        storeId,
        libraryId,
        rawUrlOrPath: folderUrlOrPath,
      });

      if (
        resolvedLoc.libraryId &&
        resolvedLoc.libraryId.toLowerCase() !== libraryId.toLowerCase()
      ) {
        const err = new Error(
          `INVALID_PATH: Resolved library "${resolvedLoc.libraryId}" does not match requested library "${libraryId}".`,
        ) as Error & { code: DocumentStoreErrorCode };
        err.code = 'invalid_path';
        throw err;
      }

      if (!resolvedLoc.resolved || !resolvedLoc.folderItemId) {
        const err = new Error(
          resolvedLoc.errorMessage ??
            'Could not resolve the existing folder in the document store.',
        ) as Error & { code?: DocumentStoreErrorCode };
        if (resolvedLoc.errorCode) {
          err.code = resolvedLoc.errorCode;
        }
        throw err;
      }

      const actualRelPath = resolvedLoc.relativePath ?? '';
      const conflictingLocation = (await deps.repository
        .listAllMatterLocations(ctx))
        .find((otherLoc) => {
          if (otherLoc.matterId === subject.matterId || otherLoc.storeId !== storeId) {
            return false;
          }
          if (
            otherLoc.providerFolderItemId === resolvedLoc.folderItemId ||
            Object.values(otherLoc.folderItemMap ?? {}).includes(
              resolvedLoc.folderItemId!,
            )
          ) {
            return true;
          }
          if (actualRelPath && otherLoc.relativePath) {
            const actualLower = actualRelPath.toLowerCase().replace(/^\/+|\/+$/g, '');
            const otherLower = otherLoc.relativePath
              .toLowerCase()
              .replace(/^\/+|\/+$/g, '');
            if (
              actualLower === otherLower ||
              actualLower.startsWith(`${otherLower}/`) ||
              otherLower.startsWith(`${actualLower}/`)
            ) {
              return true;
            }
          }
          return false;
        });

      if (conflictingLocation) {
        await deps.repository.appendAuditEvent(
          ctx,
          buildDocumentStoreAuditEvent({
            context: ctx,
            identityUsed: 'provisioning',
            triggerEvent,
            action: 'lifecycle:matter:linked',
            matterId: subject.matterId,
            storeId,
            libraryId,
            providerItemId: resolvedLoc.folderItemId,
            outcome: 'denied',
            errorCode: 'folder_owned_by_another_matter',
          }),
        );
        const err = new Error(
          'PERMISSION_DENIED: The requested folder is already linked to another matter.',
        ) as Error & { code: DocumentStoreErrorCode };
        err.code = 'access_denied';
        throw err;
      }

      const actualNormalized = actualRelPath
        .toLowerCase()
        .replace(/^\/+|\/+$/g, '');
      const expectedBaseNormalized = (expectedRoute.renderedBasePath ?? '')
        .toLowerCase()
        .replace(/^\/+|\/+$/g, '');

      const matchesContainerScope = (await deps.repository
        .listFolderScopes(ctx))
        .some(
          (s) =>
            s.storeId === storeId &&
            s.libraryId === libraryId &&
            (s.scopeType === 'library_root' ||
              s.scopeType === 'department' ||
              s.scopeType === 'team') &&
            s.providerItemId === resolvedLoc.folderItemId,
        );

      const ruleBasePrefixes: string[] = [];
      for (const rule of deps.routingRules ?? []) {
        if (rule.basePath) {
          const cleaned = rule.basePath.trim().replace(/^\/+|\/+$/g, '');
          let prefix = '';
          for (const seg of cleaned.split('/').filter(Boolean)) {
            if (seg.includes('{')) break;
            prefix = prefix ? `${prefix}/${seg}` : seg;
            ruleBasePrefixes.push(prefix);
          }
        }
      }

      const matchesProtectedContainerPath = [
        ...(deps.protectedContainerPaths ?? []),
        ...ruleBasePrefixes,
      ].some((rawPath) => {
        const norm = rawPath.toLowerCase().replace(/^\/+|\/+$/g, '');
        return (
          Boolean(norm) &&
          (actualNormalized === norm || norm.startsWith(`${actualNormalized}/`))
        );
      });

      // Never allow linking the library root or any configured department/team container folder itself (R3, R92, R114)
      if (
        !actualNormalized ||
        matchesContainerScope ||
        matchesProtectedContainerPath ||
        (expectedBaseNormalized &&
          (actualNormalized === expectedBaseNormalized ||
            expectedBaseNormalized.startsWith(`${actualNormalized}/`)))
      ) {
        await deps.repository.appendAuditEvent(
          ctx,
          buildDocumentStoreAuditEvent({
            context: ctx,
            identityUsed: 'provisioning',
            triggerEvent,
            action: 'lifecycle:matter:linked',
            matterId: subject.matterId,
            storeId,
            libraryId,
            providerItemId: resolvedLoc.folderItemId,
            outcome: 'denied',
            errorCode: 'routing_path_mismatch',
          }),
        );
        const err = new Error(
          'PERMISSION_DENIED: Cannot link a department, team, or library root container folder directly to a matter.',
        ) as Error & { code: DocumentStoreErrorCode };
        err.code = 'access_denied';
        throw err;
      }

      let routingMismatchNote: string | null = null;
      if (
        expectedBaseNormalized &&
        !actualNormalized.startsWith(`${expectedBaseNormalized}/`)
      ) {
        if (!allowRoutingMismatchOverride || !ctx.mfaVerified) {
          await deps.repository.appendAuditEvent(
            ctx,
            buildDocumentStoreAuditEvent({
              context: ctx,
              identityUsed: 'provisioning',
              triggerEvent,
              action: 'lifecycle:matter:linked',
              matterId: subject.matterId,
              storeId,
              libraryId,
              providerItemId: resolvedLoc.folderItemId,
              outcome: 'denied',
              errorCode: 'routing_path_mismatch',
            }),
          );
          const err = new Error(
            `PERMISSION_DENIED: Linked folder path "${actualRelPath}" is outside the routed department/team path "${expectedRoute.renderedBasePath}".`,
          ) as Error & { code: DocumentStoreErrorCode };
          err.code = 'access_denied';
          throw err;
        }
        routingMismatchNote = `Linked folder path "${actualRelPath}" is outside the routed department/team path "${expectedRoute.renderedBasePath}".`;
      }

      let folderItemMap: Record<string, string> = {};
      if (applyMissingTemplateFolders) {
        const ensured = await provider.ensureFolderTree(
          provCtx,
          {
            storeId,
            libraryId,
            siteId: resolvedLoc.siteId!,
            driveId: resolvedLoc.driveId!,
            folderItemId: resolvedLoc.folderItemId,
          },
          toProviderFolderTreeNodes(compiledTemplate.nodes),
        );
        folderItemMap = ensured.folderItemMap;
      }

      const permPlan = compileMatterFolderPermissions({
        accessConfig: deps.accessConfig,
        storeId,
        subject,
        resolveUserEntraObjectId: (userId) =>
          deps.resolveUserEntraObjectId(ctx, userId),
      });

      await provider.setPermissions(
        provCtx,
        {
          storeId,
          siteId: resolvedLoc.siteId!,
          driveId: resolvedLoc.driveId!,
          itemId: resolvedLoc.folderItemId,
        },
        permPlan.grants,
        { inherit: permPlan.inherit },
      );

      const now = new Date().toISOString();
      const location = await deps.repository.putMatterLocation(ctx, {
        id: `loc-${randomUUID()}`,
        tenantId: ctx.tenantId,
        matterId: subject.matterId,
        storeId,
        libraryId,
        providerSiteId: resolvedLoc.siteId!,
        providerDriveId: resolvedLoc.driveId!,
        providerFolderItemId: resolvedLoc.folderItemId,
        webUrl: resolvedLoc.webUrl ?? folderUrlOrPath,
        relativePath: actualRelPath || expectedRoute.matterRelativePath,
        folderItemMap,
        templateId: compiledTemplate.templateId,
        templateVersion: compiledTemplate.version,
        provisioningStatus: 'provisioned',
        linkMode: 'linked_existing',
        routingMismatchNote,
        hasUniquePermissions: !permPlan.inherit,
        uniqueScopeCount: permPlan.consumesUniqueScope ? 1 : 0,
        intendedGrants: permPlan.grants,
        lastJobId: bgJob.jobId,
        lastErrorCode: null,
        lastErrorMessage: null,
        provisionedAt: now,
        updatedAt: now,
      });

      const job = await deps.repository.putLifecycleJob(ctx, {
        id: bgJob.jobId,
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        storeId,
        matterId: subject.matterId,
        jobType: 'link_existing_folder',
        status: 'succeeded',
        attemptCount: 1,
        maxAttempts: 3,
        triggeredByUserId: ctx.actorId || null,
        triggerEvent,
        payload: { storeId, libraryId },
        result: {
          locationId: location.id,
          hasRoutingMismatch: Boolean(routingMismatchNote),
        },
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: now,
        updatedAt: now,
      });

      await deps.repository.appendAuditEvent(
        ctx,
        buildDocumentStoreAuditEvent({
          context: ctx,
          identityUsed: 'provisioning',
          triggerEvent,
          action: 'lifecycle:matter:linked',
          matterId: subject.matterId,
          storeId,
          libraryId,
          providerItemId: resolvedLoc.folderItemId,
          outcome: 'succeeded',
          metadata: {
            applyMissingTemplateFolders,
            hasRoutingMismatch: Boolean(routingMismatchNote),
          },
        }),
      );

      return { job, location };
    },
  );
}

/**
 * Recalculates and updates a matter's folder permissions when its team members,
 * restriction flag (`isRestricted`), or owning department/team change.
 * Restores inheritance (`inherit: true`) automatically when all exceptions end.
 */
export async function recalculateMatterPermissionsJob(params: {
  ctx: TenantContext;
  deps: DocumentLifecycleDependencies;
  subject: MatterRoutingSubject;
  departmentChangeStrategy?: DepartmentChangeStrategy;
  triggerEvent?: string;
}): Promise<{
  jobs: DocumentLifecycleJobRecord[];
  locations: MatterDocumentLocationRecord[];
}> {
  const {
    ctx,
    deps,
    subject,
    departmentChangeStrategy = 'repermission_in_place',
    triggerEvent = 'matter.permissions.recalculated',
  } = params;

  return runTenantBackgroundJob(
    {
      jobId: `job-recalc-${randomUUID()}`,
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      payload: { matterId: subject.matterId },
    },
    async () => {
      const existingLocations = await deps.repository.listMatterLocationsByMatterId(
        ctx,
        subject.matterId,
      );

      const jobs: DocumentLifecycleJobRecord[] = [];
      const updatedLocations: MatterDocumentLocationRecord[] = [];

      for (const loc of existingLocations) {
        if (loc.provisioningStatus !== 'provisioned') continue;

        let expectedRoute: ReturnType<typeof resolveMatterDocumentRoute> | null =
          null;
        try {
          expectedRoute = resolveMatterDocumentRoute({
            subject,
            stores: deps.stores,
            routingRules: deps.routingRules,
            matterFolderNameTemplate: deps.matterFolderNameTemplate,
          });
        } catch {
          expectedRoute = null;
        }

        const currentBasePath = loc.relativePath
          .split('/')
          .slice(0, -1)
          .join('/');

        // If department/team changed and strategy is 'move_folder', delegate to moveMatterFolderJob
        if (
          departmentChangeStrategy === 'move_folder' &&
          expectedRoute &&
          expectedRoute.store.storeId === loc.storeId &&
          expectedRoute.libraryId === loc.libraryId &&
          currentBasePath.toLowerCase() !==
            expectedRoute.renderedBasePath.toLowerCase()
        ) {
          const moved = await moveMatterFolderJob({
            ctx,
            deps,
            subject,
            locationId: loc.id,
            triggerEvent,
          });
          jobs.push(moved.job);
          updatedLocations.push(moved.location);
          continue;
        }

        const provider = deps.getProvider(loc.storeId);
        const provCtx = createProvisioningContext(ctx, triggerEvent);

        const permPlan = compileMatterFolderPermissions({
          accessConfig: deps.accessConfig,
          storeId: loc.storeId,
          subject,
          resolveUserEntraObjectId: (userId) =>
            deps.resolveUserEntraObjectId(ctx, userId),
        });

        // If repermission_in_place is used after a department/team change on a standard matter,
        // break inheritance on the in-place folder so the new department/team gets access.
        const inPlaceDeptMismatch = Boolean(
          expectedRoute &&
            currentBasePath.toLowerCase() !==
              expectedRoute.renderedBasePath.toLowerCase(),
        );
        const effectiveInherit = inPlaceDeptMismatch ? false : permPlan.inherit;

        try {
          await provider.setPermissions(
            provCtx,
            {
              storeId: loc.storeId,
              siteId: loc.providerSiteId,
              driveId: loc.providerDriveId,
              itemId: loc.providerFolderItemId,
            },
            permPlan.grants,
            { inherit: effectiveInherit },
          );
        } catch (err) {
          const errorCode =
            ((err as { code?: DocumentStoreErrorCode })?.code as
              | DocumentStoreErrorCode
              | undefined) ?? 'unavailable';
          const now = new Date().toISOString();
          console.error(
            JSON.stringify({
              level: 'error',
              correlationId: ctx.correlationId,
              tenantId: ctx.tenantId,
              storeId: loc.storeId,
              code: errorCode,
            }),
          );
          await deps.repository.putLifecycleJob(ctx, {
            id: `job-perm-${randomUUID()}`,
            tenantId: ctx.tenantId,
            correlationId: ctx.correlationId,
            storeId: loc.storeId,
            matterId: subject.matterId,
            jobType: 'recalculate_permissions',
            status: 'failed',
            attemptCount: 1,
            maxAttempts: 3,
            triggeredByUserId: ctx.actorId || null,
            triggerEvent,
            payload: {
              locationId: loc.id,
              inherit: effectiveInherit,
              reason: permPlan.reason,
            },
            result: null,
            lastErrorCode: errorCode,
            lastErrorMessage: errorCode,
            createdAt: now,
            updatedAt: now,
          });
          await deps.repository.putReconciliationFinding(ctx, {
            id: `finding-${randomUUID()}`,
            tenantId: ctx.tenantId,
            storeId: loc.storeId,
            libraryId: loc.libraryId,
            matterId: subject.matterId,
            providerItemId: loc.providerFolderItemId,
            scopeIdentifier: subject.matterId,
            findingType: 'unexpected_grant',
            severity: 'high',
            status: 'open',
            intendedState: {
              inherit: effectiveInherit,
              reason: permPlan.reason,
            },
            actualState: {
              errorCode,
            },
            detectedAt: now,
            remediatedAt: null,
            remediatedByUserId: null,
          });
          await deps.repository.appendAuditEvent(
            ctx,
            buildDocumentStoreAuditEvent({
              context: ctx,
              identityUsed: 'provisioning',
              triggerEvent,
              action: 'lifecycle:matter:permissions_updated',
              matterId: subject.matterId,
              storeId: loc.storeId,
              libraryId: loc.libraryId,
              providerItemId: loc.providerFolderItemId,
              outcome: 'failed',
              errorCode,
            }),
          );
          throw err;
        }

        const now = new Date().toISOString();
        const matterScopeKey = `MATTER:${subject.matterId}`;
        const existingMatterScope = await deps.repository.findFolderScope(ctx, {
          storeId: loc.storeId,
          libraryId: loc.libraryId,
          scopeType: 'matter',
          scopeKey: matterScopeKey,
        });
        await deps.repository.putFolderScope(ctx, {
          id: existingMatterScope?.id ?? `scope-${randomUUID()}`,
          tenantId: ctx.tenantId,
          storeId: loc.storeId,
          libraryId: loc.libraryId,
          scopeType: 'matter',
          scopeKey: matterScopeKey,
          providerItemId: loc.providerFolderItemId,
          hasUniquePermissions: !effectiveInherit,
          intendedGrants: permPlan.grants,
          lastVerifiedAt: now,
        });

        const updatedLoc = await deps.repository.putMatterLocation(ctx, {
          ...loc,
          hasUniquePermissions: !effectiveInherit,
          uniqueScopeCount: !effectiveInherit ? 1 : 0,
          intendedGrants: permPlan.grants,
          updatedAt: now,
        });

        const jobRecord = await deps.repository.putLifecycleJob(ctx, {
          id: `job-perm-${randomUUID()}`,
          tenantId: ctx.tenantId,
          correlationId: ctx.correlationId,
          storeId: loc.storeId,
          matterId: subject.matterId,
          jobType: 'recalculate_permissions',
          status: 'succeeded',
          attemptCount: 1,
          maxAttempts: 3,
          triggeredByUserId: ctx.actorId || null,
          triggerEvent,
          payload: {
            locationId: loc.id,
            inherit: effectiveInherit,
            reason: permPlan.reason,
          },
          result: {
            hasUniquePermissions: !effectiveInherit,
          },
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt: now,
          updatedAt: now,
        });

        await deps.repository.appendAuditEvent(
          ctx,
          buildDocumentStoreAuditEvent({
            context: ctx,
            identityUsed: 'provisioning',
            triggerEvent,
            action: 'lifecycle:matter:permissions_updated',
            matterId: subject.matterId,
            storeId: loc.storeId,
            libraryId: loc.libraryId,
            providerItemId: loc.providerFolderItemId,
            outcome: 'succeeded',
            metadata: {
              inherit: effectiveInherit,
              permissionReason: permPlan.reason,
              grantCount: permPlan.grants.length,
            },
          }),
        );

        jobs.push(jobRecord);
        updatedLocations.push(updatedLoc);
      }

      return { jobs, locations: updatedLocations };
    },
  );
}

/**
 * Moves a matter's folder to a new `{departmentCode}/{teamCode}` parent folder when the
 * owning department or team changes and `move_folder` is selected, then resets/reapplies permissions.
 */
export async function moveMatterFolderJob(params: {
  ctx: TenantContext;
  deps: DocumentLifecycleDependencies;
  subject: MatterRoutingSubject;
  locationId: string;
  triggerEvent?: string;
}): Promise<{
  job: DocumentLifecycleJobRecord;
  location: MatterDocumentLocationRecord;
}> {
  const {
    ctx,
    deps,
    subject,
    locationId,
    triggerEvent = 'matter.department.moved',
  } = params;

  return runTenantBackgroundJob(
    {
      jobId: `job-move-${randomUUID()}`,
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      payload: { matterId: subject.matterId, locationId },
    },
    async (bgJob) => {
      const loc = await deps.repository.getMatterLocationById(ctx, locationId);
      if (!loc) {
        throw new Error(`Matter document location "${locationId}" not found.`);
      }

      const route = resolveMatterDocumentRoute({
        subject,
        stores: deps.stores,
        routingRules: deps.routingRules,
        matterFolderNameTemplate: deps.matterFolderNameTemplate,
      });

      const provider = deps.getProvider(loc.storeId);
      const provCtx = createProvisioningContext(ctx, triggerEvent);

      const { parentItemId } = await ensureHierarchyAndGroupScopes({
        ctx,
        provCtx,
        deps,
        provider,
        store: route.store,
        libraryId: loc.libraryId,
        siteId: loc.providerSiteId,
        driveId: loc.providerDriveId,
        basePathSegments: route.basePathSegments,
        subject,
      });

      const movedItem = await provider.moveItem(
        provCtx,
        {
          storeId: loc.storeId,
          siteId: loc.providerSiteId,
          driveId: loc.providerDriveId,
          itemId: loc.providerFolderItemId,
        },
        {
          storeId: loc.storeId,
          libraryId: loc.libraryId,
          siteId: loc.providerSiteId,
          driveId: loc.providerDriveId,
          folderItemId: parentItemId,
        },
        route.matterFolderName,
      );

      const permPlan = compileMatterFolderPermissions({
        accessConfig: deps.accessConfig,
        storeId: loc.storeId,
        subject,
        resolveUserEntraObjectId: (userId) =>
          deps.resolveUserEntraObjectId(ctx, userId),
      });

      await provider.setPermissions(
        provCtx,
        {
          storeId: loc.storeId,
          siteId: loc.providerSiteId,
          driveId: loc.providerDriveId,
          itemId: loc.providerFolderItemId,
        },
        permPlan.grants,
        { inherit: permPlan.inherit },
      );

      const now = new Date().toISOString();
      const updatedLoc = await deps.repository.putMatterLocation(ctx, {
        ...loc,
        webUrl: movedItem.webUrl,
        relativePath: route.matterRelativePath,
        routingMismatchNote: null,
        hasUniquePermissions: !permPlan.inherit,
        uniqueScopeCount: permPlan.consumesUniqueScope ? 1 : 0,
        intendedGrants: permPlan.grants,
        lastJobId: bgJob.jobId,
        updatedAt: now,
      });

      const job = await deps.repository.putLifecycleJob(ctx, {
        id: bgJob.jobId,
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        storeId: loc.storeId,
        matterId: subject.matterId,
        jobType: 'move_matter_folder',
        status: 'succeeded',
        attemptCount: 1,
        maxAttempts: 3,
        triggeredByUserId: ctx.actorId || null,
        triggerEvent,
        payload: { locationId },
        result: {
          movedToParentItemId: parentItemId,
          inherit: permPlan.inherit,
        },
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: now,
        updatedAt: now,
      });

      await deps.repository.appendAuditEvent(
        ctx,
        buildDocumentStoreAuditEvent({
          context: ctx,
          identityUsed: 'provisioning',
          triggerEvent,
          action: 'lifecycle:matter:moved',
          matterId: subject.matterId,
          storeId: loc.storeId,
          libraryId: loc.libraryId,
          providerItemId: loc.providerFolderItemId,
          outcome: 'succeeded',
          metadata: {
            destinationParentItemId: parentItemId,
            inherit: permPlan.inherit,
          },
        }),
      );

      return { job, location: updatedLoc };
    },
  );
}

/**
 * Applies the closed-matter permission policy (typically read-only) when a matter closes,
 * leaving a hook (`onBeforeMatterDocumentsClose`) for Phase 2 retention labels.
 */
export async function closeMatterFolderJob(params: {
  ctx: TenantContext;
  deps: DocumentLifecycleDependencies;
  subject: MatterRoutingSubject;
  triggerEvent?: string;
}): Promise<{
  jobs: DocumentLifecycleJobRecord[];
  locations: MatterDocumentLocationRecord[];
}> {
  const closedSubject: MatterRoutingSubject = {
    ...params.subject,
    isClosed: true,
  };

  const existingLocations =
    await params.deps.repository.listMatterLocationsByMatterId(
      params.ctx,
      params.subject.matterId,
    );

  const retentionByLocId = new Map<string, string | null>();
  if (params.deps.onBeforeMatterDocumentsClose) {
    for (const loc of existingLocations) {
      const hookRes = await params.deps.onBeforeMatterDocumentsClose({
        ctx: params.ctx,
        matterId: params.subject.matterId,
        location: loc,
      });
      if (hookRes && hookRes.retentionLabelId !== undefined) {
        retentionByLocId.set(loc.id, hookRes.retentionLabelId);
      }
    }
  }

  const res = await recalculateMatterPermissionsJob({
    ctx: params.ctx,
    deps: params.deps,
    subject: closedSubject,
    triggerEvent: params.triggerEvent ?? 'matter.closed',
  });

  const updatedLocationsPromises = res.locations.map(async (loc) => {
    const retentionLabelId = retentionByLocId.get(loc.id);
    const updated =
      retentionLabelId !== undefined
        ? await params.deps.repository.putMatterLocation(params.ctx, {
            ...loc,
            retentionLabelId,
          })
        : loc;

    await params.deps.repository.appendAuditEvent(
      params.ctx,
      buildDocumentStoreAuditEvent({
        context: params.ctx,
        identityUsed: 'provisioning',
        triggerEvent: params.triggerEvent ?? 'matter.closed',
        action: 'lifecycle:matter:closed',
        matterId: params.subject.matterId,
        storeId: loc.storeId,
        libraryId: loc.libraryId,
        providerItemId: loc.providerFolderItemId,
        outcome: 'succeeded',
        metadata: {
          retentionLabelId: updated.retentionLabelId ?? null,
        },
      }),
    );

    return updated;
  });

  return { jobs: res.jobs, locations: await Promise.all(updatedLocationsPromises) };
}

/**
 * Restores active permissions (and inheritance if no exceptions remain) when a closed matter is reopened.
 */
export async function reopenMatterFolderJob(params: {
  ctx: TenantContext;
  deps: DocumentLifecycleDependencies;
  subject: MatterRoutingSubject;
  triggerEvent?: string;
}): Promise<{
  jobs: DocumentLifecycleJobRecord[];
  locations: MatterDocumentLocationRecord[];
}> {
  const openSubject: MatterRoutingSubject = {
    ...params.subject,
    isClosed: false,
  };

  const res = await recalculateMatterPermissionsJob({
    ctx: params.ctx,
    deps: params.deps,
    subject: openSubject,
    triggerEvent: params.triggerEvent ?? 'matter.reopened',
  });

  for (const loc of res.locations) {
    await params.deps.repository.appendAuditEvent(
      params.ctx,
      buildDocumentStoreAuditEvent({
        context: params.ctx,
        identityUsed: 'provisioning',
        triggerEvent: params.triggerEvent ?? 'matter.reopened',
        action: 'lifecycle:matter:reopened',
        matterId: params.subject.matterId,
        storeId: loc.storeId,
        libraryId: loc.libraryId,
        providerItemId: loc.providerFolderItemId,
        outcome: 'succeeded',
        metadata: {
          restoredInheritance: !loc.hasUniquePermissions,
        },
      }),
    );
  }

  return res;
}

/**
 * Applies additive folder template changes to open matters ("apply additions to open matters").
 * Never deletes, renames, or moves existing folders on open matters.
 */
export async function applyTemplateAdditionsToOpenMattersJob(params: {
  ctx: TenantContext;
  deps: DocumentLifecycleDependencies;
  openMatterSubjects: readonly MatterRoutingSubject[];
  triggerEvent?: string;
}): Promise<{
  job: DocumentLifecycleJobRecord;
  updatedLocations: MatterDocumentLocationRecord[];
  addedFoldersByMatterId: Record<string, string[]>;
}> {
  const {
    ctx,
    deps,
    openMatterSubjects,
    triggerEvent = 'admin.templates.apply_additions',
  } = params;

  return runTenantBackgroundJob(
    {
      jobId: `job-tpl-add-${randomUUID()}`,
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      payload: { matterCount: openMatterSubjects.length },
    },
    async (bgJob) => {
      const updatedLocations: MatterDocumentLocationRecord[] = [];
      const addedFoldersByMatterId: Record<string, string[]> = {};
      const provCtx = createProvisioningContext(ctx, triggerEvent);

      for (const subject of openMatterSubjects) {
        if (subject.isClosed) continue;
        const locations = await deps.repository.listMatterLocationsByMatterId(
          ctx,
          subject.matterId,
        );
        const compiled = resolveMatterFolderTemplate({
          templatesConfig: deps.templatesConfig,
          departmentId: subject.departmentId,
          workTypeId: subject.workTypeId,
          practiceAreaId: subject.practiceAreaId,
          subject,
        });

        for (const loc of locations) {
          if (loc.provisioningStatus !== 'provisioned') continue;
          const diff = computeAdditiveTemplateDiff(
            compiled,
            loc.folderItemMap,
          );
          if (diff.missingRelativePaths.length === 0) {
            if (loc.templateVersion !== compiled.version) {
              updatedLocations.push(
                await deps.repository.putMatterLocation(ctx, {
                  ...loc,
                  templateId: compiled.templateId,
                  templateVersion: compiled.version,
                  updatedAt: new Date().toISOString(),
                }),
              );
            }
            continue;
          }

          const provider = deps.getProvider(loc.storeId);
          const ensured = await provider.ensureFolderTree(
            provCtx,
            {
              storeId: loc.storeId,
              libraryId: loc.libraryId,
              siteId: loc.providerSiteId,
              driveId: loc.providerDriveId,
              folderItemId: loc.providerFolderItemId,
            },
            diff.additiveTree,
          );

          const mergedMap: Record<string, string> = {
            ...loc.folderItemMap,
            ...ensured.folderItemMap,
          };

          const updatedLoc = await deps.repository.putMatterLocation(ctx, {
            ...loc,
            folderItemMap: mergedMap,
            templateId: compiled.templateId,
            templateVersion: compiled.version,
            updatedAt: new Date().toISOString(),
          });
          updatedLocations.push(updatedLoc);
          addedFoldersByMatterId[subject.matterId] = diff.missingRelativePaths;
        }
      }

      const now = new Date().toISOString();
      const job = await deps.repository.putLifecycleJob(ctx, {
        id: bgJob.jobId,
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        storeId: deps.stores[0]?.storeId ?? 'default',
        matterId: null,
        jobType: 'apply_template_additions',
        status: 'succeeded',
        attemptCount: 1,
        maxAttempts: 3,
        triggeredByUserId: ctx.actorId || null,
        triggerEvent,
        payload: { matterCount: openMatterSubjects.length },
        result: {
          updatedMatterCount: Object.keys(addedFoldersByMatterId).length,
        },
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: now,
        updatedAt: now,
      });

      await deps.repository.appendAuditEvent(
        ctx,
        buildDocumentStoreAuditEvent({
          context: ctx,
          identityUsed: 'provisioning',
          triggerEvent,
          action: 'lifecycle:templates:additions_applied',
          outcome: 'succeeded',
          metadata: {
            updatedMatterCount: Object.keys(addedFoldersByMatterId).length,
          },
        }),
      );

      return { job, updatedLocations, addedFoldersByMatterId };
    },
  );
}

/**
 * Calculates the current unique permission scope count for each configured library in a tenant.
 */
export async function computeTenantLibraryScaleStatuses(params: {
  ctx: TenantContext;
  repository: TenantDocumentStoreRepository;
  stores: readonly DocumentStoreConfig[];
  warningThreshold?: number;
}): Promise<LibraryScopeScaleStatus[]> {
  const { ctx, repository, stores, warningThreshold } = params;
  const results: LibraryScopeScaleStatus[] = [];

  for (const store of stores) {
    for (const lib of store.sharepoint?.libraries ?? []) {
      const scopes = await repository.listFolderScopes(
        ctx,
        store.storeId,
        lib.libraryId,
      );
      const locations = (await repository
        .listAllMatterLocations(ctx, store.storeId))
        .filter((l) => l.libraryId === lib.libraryId);

      const departmentScopes = scopes.filter(
        (s) => s.scopeType === 'department' && s.hasUniquePermissions,
      ).length;
      const teamScopes = scopes.filter(
        (s) => s.scopeType === 'team' && s.hasUniquePermissions,
      ).length;
      const matterExceptionScopes = locations.filter(
        (l) => l.hasUniquePermissions,
      ).length;
      const templateOverrideScopes = locations.reduce(
        (sum, l) =>
          sum + Math.max(0, l.uniqueScopeCount - (l.hasUniquePermissions ? 1 : 0)),
        0,
      );

      results.push(
        evaluateLibraryScopeScaleStatus({
          storeId: store.storeId,
          libraryId: lib.libraryId,
          warningThreshold,
          departmentScopes,
          teamScopes,
          matterExceptionScopes,
          templateOverrideScopes,
        }),
      );
    }
  }

  return results;
}
