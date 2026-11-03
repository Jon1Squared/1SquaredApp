/**
 * Domain types for External Document Store Integration (`core/src/domain/documents/types.ts`).
 *
 * Implements ADR-0017 through ADR-0021.
 * Zero client-specific names, URLs, or IDs.
 */

import type {
  DocumentAccessLevel,
  DocumentPermissionGrant,
  DocumentStoreErrorCode,
  MatterFolderNodeAccessOverride,
} from '../../api/index';

export type MatterDocumentProvisioningStatus =
  | 'pending'
  | 'provisioned'
  | 'failed';

export type MatterDocumentLinkMode = 'provisioned' | 'linked_existing';

export interface MatterDocumentLocationRecord {
  id: string;
  tenantId: string;
  matterId: string;
  storeId: string;
  libraryId: string;
  providerSiteId: string;
  providerDriveId: string;
  providerFolderItemId: string;
  webUrl: string;
  relativePath: string;
  /** Map of relative template folder path (e.g. "01 Correspondence") to provider itemId */
  folderItemMap: Record<string, string>;
  templateId: string;
  templateVersion: number;
  provisioningStatus: MatterDocumentProvisioningStatus;
  linkMode: MatterDocumentLinkMode;
  routingMismatchNote: string | null;
  hasUniquePermissions: boolean;
  uniqueScopeCount: number;
  intendedGrants: DocumentPermissionGrant[];
  /** Phase 2 hook: Retention label applied on closure */
  retentionLabelId?: string | null;
  /** Phase 2 hook: Delta sync cursor for activity feed */
  deltaSyncCursor?: string | null;
  lastJobId: string | null;
  lastErrorCode: DocumentStoreErrorCode | string | null;
  lastErrorMessage: string | null;
  provisionedAt: string | null;
  updatedAt: string;
}

export type DocumentFolderScopeType =
  | 'library_root'
  | 'department'
  | 'team'
  | 'matter'
  | 'matter_subfolder';

export interface DocumentStoreFolderScopeRecord {
  id: string;
  tenantId: string;
  storeId: string;
  libraryId: string;
  scopeType: DocumentFolderScopeType;
  /** e.g. 'root', 'DEPT-A', 'DEPT-A/TEAM-A1', or 'MATTER:M-0001' */
  scopeKey: string;
  providerItemId: string;
  hasUniquePermissions: boolean;
  intendedGrants: DocumentPermissionGrant[];
  lastVerifiedAt: string;
}

export type DocumentLifecycleJobType =
  | 'provision_matter'
  | 'link_existing_folder'
  | 'recalculate_permissions'
  | 'move_matter_folder'
  | 'close_matter_folder'
  | 'reopen_matter_folder'
  | 'apply_template_additions'
  | 'reconcile_store_permissions';

export type DocumentLifecycleJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface DocumentLifecycleJobRecord {
  id: string;
  tenantId: string;
  correlationId: string;
  storeId: string;
  matterId: string | null;
  jobType: DocumentLifecycleJobType;
  status: DocumentLifecycleJobStatus;
  attemptCount: number;
  maxAttempts: number;
  triggeredByUserId: string | null;
  triggerEvent: string;
  payload: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DocumentReconciliationFindingType =
  | 'missing_grant'
  | 'unexpected_grant'
  | 'inheritance_drift'
  | 'unexpected_sharing_link'
  | 'missing_matter_folder'
  | 'orphan_store_folder'
  | 'permission_mismatch_store_denied';

export interface DocumentReconciliationFindingRecord {
  id: string;
  tenantId: string;
  storeId: string;
  libraryId: string;
  matterId: string | null;
  providerItemId: string | null;
  /** Non-sensitive identifier (e.g. department ID, team ID, or matter ID — never file/client names) */
  scopeIdentifier: string;
  findingType: DocumentReconciliationFindingType;
  severity: 'info' | 'warning' | 'high';
  status: 'open' | 'remediated' | 'ignored';
  intendedState: Record<string, unknown>;
  actualState: Record<string, unknown>;
  detectedAt: string;
  remediatedAt: string | null;
  remediatedByUserId: string | null;
}

export type DocumentStoreAuditAction =
  | 'config:stores:updated'
  | 'config:routing:updated'
  | 'config:access:updated'
  | 'config:templates:updated'
  | 'store:connection:tested'
  | 'store:location:resolved'
  | 'lifecycle:matter:provisioned'
  | 'lifecycle:matter:linked'
  | 'lifecycle:matter:moved'
  | 'lifecycle:matter:closed'
  | 'lifecycle:matter:reopened'
  | 'lifecycle:matter:permissions_updated'
  | 'lifecycle:templates:additions_applied'
  | 'reconciliation:executed'
  | 'reconciliation:remediated'
  | 'reconciliation:store_access_denied'
  | 'document:listed'
  | 'document:downloaded'
  | 'document:uploaded'
  | 'document:folder_created'
  | 'document:renamed'
  | 'document:moved'
  | 'document:deleted';

export interface DocumentStoreAuditEventRecord {
  id: string;
  tenantId: string;
  correlationId: string;
  occurredAt: string;
  actorUserId: string | null;
  identityUsed: 'user' | 'provisioning';
  triggerEvent: string;
  action: DocumentStoreAuditAction;
  matterId: string | null;
  storeId: string | null;
  libraryId: string | null;
  providerItemId: string | null;
  outcome: 'succeeded' | 'denied' | 'failed';
  errorCode: string | null;
  /** Structured non-sensitive audit details. Never contains file names, folder names, or paths. */
  metadata: Record<string, unknown>;
}

export interface MatterRoutingSubject {
  matterId: string;
  matterNumber: string;
  clientNumber: string;
  matterDescription: string;
  departmentId: string;
  departmentCode: string;
  teamId: string;
  teamCode: string;
  workTypeId: string;
  practiceAreaId?: string;
  workTypeCode?: string;
  /** True when `matter.isStaffMatter` or `matter.hasEthicalWall` is true */
  isRestricted: boolean;
  /** Explicit user IDs permitted on a restricted matter (plus named participants) */
  restrictedAccessUserIds: string[];
  /** User IDs belonging to the owning team */
  owningTeamMemberIds: string[];
  /** All user IDs on the matter team (responsible/supervising partner, lead fee earner, teamMemberIds) */
  matterTeamMemberIds: string[];
  /** True when the matter status is Closed / Completed / Archived */
  isClosed: boolean;
}

export interface CompiledFolderTemplateNode {
  name: string;
  renderedName: string;
  relativePath: string;
  description?: string;
  orderPrefix: 'none' | 'two_digit';
  accessOverride: MatterFolderNodeAccessOverride | null;
  filingAliases: string[];
  inheritedFrom: 'default' | 'department' | 'work_type';
  children: CompiledFolderTemplateNode[];
}

export interface ResolvedMatterFolderTemplate {
  templateId: string;
  version: number;
  resolutionChain: string[];
  nodes: CompiledFolderTemplateNode[];
  flatRelativePaths: string[];
  accessOverrideScopeCount: number;
  scaleWarnings: string[];
}

export interface IntendedFolderPermissionPlan {
  inherit: boolean;
  reason: 'inherited_standard' | 'restricted_matter' | 'matter_team_outsiders' | 'closed_matter_readonly';
  grants: DocumentPermissionGrant[];
  outsiderUserIds: string[];
  consumesUniqueScope: boolean;
}

export interface LibraryScopeScaleStatus {
  storeId: string;
  libraryId: string;
  uniqueScopeCount: number;
  warningThreshold: number;
  hardLimit: number;
  recommendedLimit: number;
  exceedsWarningThreshold: boolean;
  breakdown: {
    departmentScopes: number;
    teamScopes: number;
    matterExceptionScopes: number;
    templateOverrideScopes: number;
  };
  warningMessage: string | null;
}

export type UnusedLevelRef = DocumentAccessLevel;
