/**
 * Permission Drift Detection & Reconciliation Service (`core/src/domain/documents/reconciliation.ts`).
 *
 * Implements Section 7:
 * - Scheduled and on-demand tenant-scoped reconciliation job (`reconcileDocumentStorePermissionsJob`).
 * - Compares intended vs actual permissions on department folders, team folders, and matter folders.
 * - Flags:
 *   - `missing_grant`
 *   - `unexpected_grant`
 *   - `inheritance_drift`
 *   - `unexpected_sharing_link`
 *   - `missing_matter_folder`
 *   - `orphan_store_folder`
 *   - `permission_mismatch_store_denied` (recorded when 1Squared allows a user action on a matter
 *     but the document store denies it).
 * - Supports optional automatic remediation (`autoRemediate`, default `false`) and on-demand manual
 *   remediation (`remediateReconciliationFinding`).
 */

import { randomUUID } from 'node:crypto';
import type {
  DocumentPermissionGrant,
  DocumentStoreConfig,
  DocumentStoreProvider,
  ProvisioningAccessContext,
  TenantContext,
} from '../../api/index';
import {
  runTenantBackgroundJob,
  type TenantDocumentStoreRepository,
} from '../../tenancy/index';
import { buildDocumentStoreAuditEvent } from './audit';
import type {
  DocumentReconciliationFindingRecord,
  DocumentStoreFolderScopeRecord,
  MatterDocumentLocationRecord,
} from './types';

export interface ReconciliationDependencies {
  repository: TenantDocumentStoreRepository;
  getProvider: (storeId: string) => DocumentStoreProvider;
  stores: readonly DocumentStoreConfig[];
  autoRemediate?: boolean;
}

function compareGrants(
  intended: readonly DocumentPermissionGrant[],
  actual: readonly DocumentPermissionGrant[],
): {
  missing: DocumentPermissionGrant[];
  unexpected: DocumentPermissionGrant[];
} {
  const intendedByKey = new Map<string, DocumentPermissionGrant>();
  for (const g of intended) {
    if (g.level === 'none') continue;
    intendedByKey.set(
      `${g.principal.principalType}:${g.principal.entraObjectId}`,
      g,
    );
  }

  const actualByKey = new Map<string, DocumentPermissionGrant>();
  for (const g of actual) {
    if (g.level === 'none') continue;
    actualByKey.set(
      `${g.principal.principalType}:${g.principal.entraObjectId}`,
      g,
    );
  }

  const missing: DocumentPermissionGrant[] = [];
  for (const [key, intGrant] of intendedByKey.entries()) {
    const actGrant = actualByKey.get(key);
    if (!actGrant || actGrant.level !== intGrant.level) {
      missing.push(intGrant);
    }
  }

  const unexpected: DocumentPermissionGrant[] = [];
  for (const [key, actGrant] of actualByKey.entries()) {
    if (!intendedByKey.has(key)) {
      unexpected.push(actGrant);
    }
  }

  return { missing, unexpected };
}

/**
 * Records a reconciliation finding when 1Squared allows an action on a matter
 * (RBAC + matter access pass) but the external document store denies the user (`access_denied`).
 */
export function recordStoreAccessDeniedFinding(params: {
  ctx: TenantContext;
  repository: TenantDocumentStoreRepository;
  storeId: string;
  libraryId: string;
  matterId: string;
  providerItemId: string;
  operation: string;
}): DocumentReconciliationFindingRecord {
  const now = new Date().toISOString();
  const finding: DocumentReconciliationFindingRecord =
    params.repository.putReconciliationFinding(params.ctx, {
      id: `finding-${randomUUID()}`,
      tenantId: params.ctx.tenantId,
      storeId: params.storeId,
      libraryId: params.libraryId,
      matterId: params.matterId,
      providerItemId: params.providerItemId,
      scopeIdentifier: `MATTER:${params.matterId}`,
      findingType: 'permission_mismatch_store_denied',
      severity: 'high',
      status: 'open',
      intendedState: {
        actorId: params.ctx.actorId,
        actorEntraObjectId: params.ctx.entraObjectId ?? null,
        matterAccessAllowedIn1Squared: true,
        operation: params.operation,
      },
      actualState: {
        storeOutcome: 'access_denied',
      },
      detectedAt: now,
      remediatedAt: null,
      remediatedByUserId: null,
    });

  params.repository.appendAuditEvent(
    params.ctx,
    buildDocumentStoreAuditEvent({
      context: params.ctx,
      identityUsed: 'user',
      triggerEvent: `store.access_denied.${params.operation}`,
      action: 'reconciliation:store_access_denied',
      matterId: params.matterId,
      storeId: params.storeId,
      libraryId: params.libraryId,
      providerItemId: params.providerItemId,
      outcome: 'denied',
      errorCode: 'access_denied',
      metadata: {
        findingId: finding.id,
        operation: params.operation,
      },
    }),
  );

  return finding;
}

/**
 * Executes a tenant-scoped permission drift and folder integrity reconciliation scan across
 * configured document stores (or a specific `storeId`), recording findings and optionally
 * auto-remediating when `autoRemediate: true`.
 */
export async function reconcileDocumentStorePermissionsJob(params: {
  ctx: TenantContext;
  deps: ReconciliationDependencies;
  storeId?: string;
  autoRemediate?: boolean;
  triggerEvent?: string;
}): Promise<{
  findings: DocumentReconciliationFindingRecord[];
  remediatedCount: number;
}> {
  const {
    ctx,
    deps,
    storeId,
    autoRemediate = deps.autoRemediate ?? false,
    triggerEvent = 'reconciliation.scheduled',
  } = params;

  return runTenantBackgroundJob(
    {
      jobId: `job-recon-${randomUUID()}`,
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      payload: { storeId: storeId ?? 'all', autoRemediate },
    },
    async () => {
      const provCtx: ProvisioningAccessContext = {
        kind: 'provisioning',
        tenantContext: ctx,
        triggeredByUserId: ctx.actorId || undefined,
        triggerEvent,
      };

      const targetStores = storeId
        ? deps.stores.filter((s) => s.storeId === storeId)
        : deps.stores;

      const createdFindings: DocumentReconciliationFindingRecord[] = [];
      let remediatedCount = 0;
      const now = new Date().toISOString();

      for (const store of targetStores) {
        const provider = deps.getProvider(store.storeId);
        const siteId =
          store.sharepoint?.siteId ?? `site-${store.storeId}`;

        // 1. Reconcile department and team folder scopes
        const scopes = deps.repository
          .listFolderScopes(ctx, store.storeId)
          .filter(
            (s) => s.scopeType === 'department' || s.scopeType === 'team',
          );

        for (const scope of scopes) {
          const libCfg = store.sharepoint?.libraries.find(
            (l) => l.libraryId === scope.libraryId,
          );
          const driveId =
            libCfg?.driveId ?? `drive-${store.storeId}-${scope.libraryId}`;

          await inspectFolderScopeDrift({
            ctx,
            provCtx,
            deps,
            provider,
            storeId: store.storeId,
            libraryId: scope.libraryId,
            siteId,
            driveId,
            matterId: null,
            providerItemId: scope.providerItemId,
            scopeIdentifier: `${scope.scopeType.toUpperCase()}:${scope.scopeKey}`,
            intendedHasUniquePermissions: scope.hasUniquePermissions,
            intendedGrants: scope.intendedGrants,
            autoRemediate,
            now,
            createdFindings,
            onRemediated: () => {
              remediatedCount += 1;
            },
          });

          // If this is a team folder, also check for orphan folders under the team folder
          if (scope.scopeType === 'team') {
            try {
              const children = await provider.listItems(
                provCtx,
                {
                  storeId: store.storeId,
                  libraryId: scope.libraryId,
                  siteId,
                  driveId,
                  folderItemId: scope.providerItemId,
                },
                { pageSize: 200 },
              );
              const knownMatterFolderIds = new Set(
                deps.repository
                  .listAllMatterLocations(ctx, store.storeId)
                  .map((l) => l.providerFolderItemId),
              );

              for (const child of children.items) {
                if (
                  child.itemType === 'folder' &&
                  !knownMatterFolderIds.has(child.itemId)
                ) {
                  const orphanFinding =
                    deps.repository.putReconciliationFinding(ctx, {
                      id: `finding-${randomUUID()}`,
                      tenantId: ctx.tenantId,
                      storeId: store.storeId,
                      libraryId: scope.libraryId,
                      matterId: null,
                      providerItemId: child.itemId,
                      scopeIdentifier: `TEAM:${scope.scopeKey}/ORPHAN:${child.itemId}`,
                      findingType: 'orphan_store_folder',
                      severity: 'warning',
                      status: 'open',
                      intendedState: { trackedIn1Squared: false },
                      actualState: { providerItemId: child.itemId },
                      detectedAt: now,
                      remediatedAt: null,
                      remediatedByUserId: null,
                    });
                  createdFindings.push(orphanFinding);
                }
              }
            } catch {
              // Ignore listing errors if the team folder itself was missing (already reported above)
            }
          }
        }

        // 2. Reconcile provisioned matter folders
        const matterLocations = deps.repository
          .listAllMatterLocations(ctx, store.storeId)
          .filter((l) => l.provisioningStatus === 'provisioned');

        for (const loc of matterLocations) {
          // Verify folder still exists
          try {
            await provider.getItem(provCtx, {
              storeId: loc.storeId,
              siteId: loc.providerSiteId,
              driveId: loc.providerDriveId,
              itemId: loc.providerFolderItemId,
            });
          } catch (err) {
            if ((err as { code?: string })?.code === 'not_found') {
              const missingFinding = deps.repository.putReconciliationFinding(
                ctx,
                {
                  id: `finding-${randomUUID()}`,
                  tenantId: ctx.tenantId,
                  storeId: loc.storeId,
                  libraryId: loc.libraryId,
                  matterId: loc.matterId,
                  providerItemId: loc.providerFolderItemId,
                  scopeIdentifier: `MATTER:${loc.matterId}`,
                  findingType: 'missing_matter_folder',
                  severity: 'high',
                  status: 'open',
                  intendedState: {
                    providerFolderItemId: loc.providerFolderItemId,
                    exists: true,
                  },
                  actualState: { exists: false },
                  detectedAt: now,
                  remediatedAt: null,
                  remediatedByUserId: null,
                },
              );
              createdFindings.push(missingFinding);
              continue;
            }
          }

          await inspectFolderScopeDrift({
            ctx,
            provCtx,
            deps,
            provider,
            storeId: loc.storeId,
            libraryId: loc.libraryId,
            siteId: loc.providerSiteId,
            driveId: loc.providerDriveId,
            matterId: loc.matterId,
            providerItemId: loc.providerFolderItemId,
            scopeIdentifier: `MATTER:${loc.matterId}`,
            intendedHasUniquePermissions: loc.hasUniquePermissions,
            intendedGrants: loc.intendedGrants,
            autoRemediate,
            now,
            createdFindings,
            onRemediated: () => {
              remediatedCount += 1;
            },
          });
        }
      }

      deps.repository.appendAuditEvent(
        ctx,
        buildDocumentStoreAuditEvent({
          context: ctx,
          identityUsed: 'provisioning',
          triggerEvent,
          action: 'reconciliation:executed',
          storeId: storeId ?? null,
          outcome: 'succeeded',
          metadata: {
            findingsCount: createdFindings.length,
            remediatedCount,
            autoRemediate,
          },
        }),
      );

      return { findings: createdFindings, remediatedCount };
    },
  );
}

async function inspectFolderScopeDrift(params: {
  ctx: TenantContext;
  provCtx: ProvisioningAccessContext;
  deps: ReconciliationDependencies;
  provider: DocumentStoreProvider;
  storeId: string;
  libraryId: string;
  siteId: string;
  driveId: string;
  matterId: string | null;
  providerItemId: string;
  scopeIdentifier: string;
  intendedHasUniquePermissions: boolean;
  intendedGrants: readonly DocumentPermissionGrant[];
  autoRemediate: boolean;
  now: string;
  createdFindings: DocumentReconciliationFindingRecord[];
  onRemediated: () => void;
}): Promise<void> {
  const {
    ctx,
    provCtx,
    deps,
    provider,
    storeId,
    libraryId,
    siteId,
    driveId,
    matterId,
    providerItemId,
    scopeIdentifier,
    intendedHasUniquePermissions,
    intendedGrants,
    autoRemediate,
    now,
    createdFindings,
    onRemediated,
  } = params;

  let actualPerms;
  try {
    actualPerms = await provider.getPermissions(provCtx, {
      storeId,
      siteId,
      driveId,
      itemId: providerItemId,
    });
  } catch {
    return;
  }

  const intendedInherit = !intendedHasUniquePermissions;

  // Check inheritance drift
  if (actualPerms.inheritsFromParent !== intendedInherit) {
    let status: 'open' | 'remediated' = 'open';
    let remediatedAt: string | null = null;
    if (autoRemediate) {
      await provider.setPermissions(
        provCtx,
        { storeId, siteId, driveId, itemId: providerItemId },
        intendedGrants,
        { inherit: intendedInherit },
      );
      status = 'remediated';
      remediatedAt = now;
      onRemediated();
    }

    createdFindings.push(
      deps.repository.putReconciliationFinding(ctx, {
        id: `finding-${randomUUID()}`,
        tenantId: ctx.tenantId,
        storeId,
        libraryId,
        matterId,
        providerItemId,
        scopeIdentifier,
        findingType: 'inheritance_drift',
        severity: 'high',
        status,
        intendedState: {
          inheritsFromParent: intendedInherit,
          grantsCount: intendedGrants.length,
        },
        actualState: {
          inheritsFromParent: actualPerms.inheritsFromParent,
          grantsCount: actualPerms.grants.length,
        },
        detectedAt: now,
        remediatedAt,
        remediatedByUserId: autoRemediate ? 'system:auto_remediate' : null,
      }),
    );
  }

  // Check unexpected sharing links
  if (actualPerms.sharingLinks.length > 0) {
    let status: 'open' | 'remediated' = 'open';
    let remediatedAt: string | null = null;
    if (autoRemediate) {
      await provider.setPermissions(
        provCtx,
        { storeId, siteId, driveId, itemId: providerItemId },
        intendedGrants,
        { inherit: intendedInherit },
      );
      status = 'remediated';
      remediatedAt = now;
      onRemediated();
    }

    createdFindings.push(
      deps.repository.putReconciliationFinding(ctx, {
        id: `finding-${randomUUID()}`,
        tenantId: ctx.tenantId,
        storeId,
        libraryId,
        matterId,
        providerItemId,
        scopeIdentifier,
        findingType: 'unexpected_sharing_link',
        severity: 'high',
        status,
        intendedState: { sharingLinkCount: 0 },
        actualState: {
          sharingLinkCount: actualPerms.sharingLinks.length,
          linkScopes: actualPerms.sharingLinks.map((l) => l.scope),
        },
        detectedAt: now,
        remediatedAt,
        remediatedByUserId: autoRemediate ? 'system:auto_remediate' : null,
      }),
    );
  }

  // When the folder is intended to have unique permissions, compare intended vs actual grants
  if (intendedHasUniquePermissions) {
    const { missing, unexpected } = compareGrants(
      intendedGrants,
      actualPerms.grants,
    );

    if (missing.length > 0) {
      let status: 'open' | 'remediated' = 'open';
      let remediatedAt: string | null = null;
      if (autoRemediate) {
        await provider.setPermissions(
          provCtx,
          { storeId, siteId, driveId, itemId: providerItemId },
          intendedGrants,
          { inherit: false },
        );
        status = 'remediated';
        remediatedAt = now;
        onRemediated();
      }

      createdFindings.push(
        deps.repository.putReconciliationFinding(ctx, {
          id: `finding-${randomUUID()}`,
          tenantId: ctx.tenantId,
          storeId,
          libraryId,
          matterId,
          providerItemId,
          scopeIdentifier,
          findingType: 'missing_grant',
          severity: 'warning',
          status,
          intendedState: {
            missingPrincipals: missing.map((m) => ({
              type: m.principal.principalType,
              entraObjectId: m.principal.entraObjectId,
              level: m.level,
            })),
          },
          actualState: {
            actualGrantCount: actualPerms.grants.length,
          },
          detectedAt: now,
          remediatedAt,
          remediatedByUserId: autoRemediate ? 'system:auto_remediate' : null,
        }),
      );
    }

    if (unexpected.length > 0) {
      let status: 'open' | 'remediated' = 'open';
      let remediatedAt: string | null = null;
      if (autoRemediate) {
        await provider.setPermissions(
          provCtx,
          { storeId, siteId, driveId, itemId: providerItemId },
          intendedGrants,
          { inherit: false },
        );
        status = 'remediated';
        remediatedAt = now;
        onRemediated();
      }

      createdFindings.push(
        deps.repository.putReconciliationFinding(ctx, {
          id: `finding-${randomUUID()}`,
          tenantId: ctx.tenantId,
          storeId,
          libraryId,
          matterId,
          providerItemId,
          scopeIdentifier,
          findingType: 'unexpected_grant',
          severity: 'high',
          status,
          intendedState: {
            intendedGrantCount: intendedGrants.length,
          },
          actualState: {
            unexpectedPrincipals: unexpected.map((u) => ({
              type: u.principal.principalType,
              entraObjectId: u.principal.entraObjectId,
              level: u.level,
            })),
          },
          detectedAt: now,
          remediatedAt,
          remediatedByUserId: autoRemediate ? 'system:auto_remediate' : null,
        }),
      );
    }
  }
}

/**
 * Remediates a single open reconciliation finding on demand by reapplying the intended permissions
 * and inheritance state to the folder in the document store.
 */
export async function remediateReconciliationFinding(params: {
  ctx: TenantContext;
  deps: ReconciliationDependencies;
  findingId: string;
}): Promise<DocumentReconciliationFindingRecord> {
  const { ctx, deps, findingId } = params;
  const finding = deps.repository.getReconciliationFindingById(ctx, findingId);
  if (!finding) {
    throw new Error(`Reconciliation finding "${findingId}" not found.`);
  }

  const provider = deps.getProvider(finding.storeId);
  const store = deps.stores.find((s) => s.storeId === finding.storeId);
  const siteId = store?.sharepoint?.siteId ?? `site-${finding.storeId}`;
  const libCfg = store?.sharepoint?.libraries.find(
    (l) => l.libraryId === finding.libraryId,
  );
  const driveId =
    libCfg?.driveId ?? `drive-${finding.storeId}-${finding.libraryId}`;

  const provCtx: ProvisioningAccessContext = {
    kind: 'provisioning',
    tenantContext: ctx,
    triggeredByUserId: ctx.actorId || undefined,
    triggerEvent: 'reconciliation.manual_remediate',
  };

  let targetScope:
    | DocumentStoreFolderScopeRecord
    | MatterDocumentLocationRecord
    | undefined;
  if (finding.matterId) {
    targetScope = deps.repository
      .listMatterLocationsByMatterId(ctx, finding.matterId)
      .find((l) => l.storeId === finding.storeId);
  } else if (finding.providerItemId) {
    targetScope = deps.repository
      .listFolderScopes(ctx, finding.storeId, finding.libraryId)
      .find((s) => s.providerItemId === finding.providerItemId);
  }

  if (targetScope && finding.providerItemId) {
    await provider.setPermissions(
      provCtx,
      {
        storeId: finding.storeId,
        siteId,
        driveId,
        itemId: finding.providerItemId,
      },
      targetScope.intendedGrants,
      { inherit: !targetScope.hasUniquePermissions },
    );
  }

  const now = new Date().toISOString();
  const updated = deps.repository.putReconciliationFinding(ctx, {
    ...finding,
    status: 'remediated',
    remediatedAt: now,
    remediatedByUserId: ctx.actorId || 'admin',
  });

  deps.repository.appendAuditEvent(
    ctx,
    buildDocumentStoreAuditEvent({
      context: ctx,
      identityUsed: 'provisioning',
      triggerEvent: 'reconciliation.manual_remediate',
      action: 'reconciliation:remediated',
      matterId: finding.matterId,
      storeId: finding.storeId,
      libraryId: finding.libraryId,
      providerItemId: finding.providerItemId,
      outcome: 'succeeded',
      metadata: {
        findingId: finding.id,
        findingType: finding.findingType,
      },
    }),
  );

  return updated;
}
