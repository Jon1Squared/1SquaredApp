/**
 * Tenant-Scoped Document Store PostgreSQL Repository (`core/src/tenancy/documentStoreRepository.ts`).
 *
 * Rules enforced (ADR 0028 & Platform Architecture Standard §8, Owner Decisions 2 & 6, R401, R405):
 * 1. All reads and writes execute against the tenant's dedicated PostgreSQL database inside an explicit
 *    transaction starting with `SET LOCAL ROLE <tenant_role>` (`TenantScopedRepository`).
 * 2. Zero in-memory `Map` simulation; tampered record IDs belonging to another tenant return `null`
 *    or throw `TENANCY_ISOLATION_ERROR`.
 * 3. Stores only external DMS references (`siteId`, `driveId`, `itemId`, `webUrl`) — never document bytes.
 */

import type {
  DocumentAccessConfig,
  DocumentPermissionGrant,
  DocumentRoutingRule,
  DocumentStoreConfig,
  MatterFolderTemplatesConfig,
  TenantContext,
} from '../api/index';
import type {
  DocumentLifecycleJobRecord,
  DocumentReconciliationFindingRecord,
  DocumentStoreAuditEventRecord,
  DocumentStoreFolderScopeRecord,
  MatterDocumentLocationRecord,
} from '../domain/documents/types';
import {
  TenantScopedRepository,
  toIsoString,
  toNullableIsoString,
} from './tenantScopedRepository';

export interface PersonEntraIdentityRecord {
  tenantId: string;
  personId: string;
  entraObjectId: string;
  upn?: string;
  populatedSource: 'oidc_signin' | 'upn_lookup' | 'admin_provisioned';
  updatedAt: string;
}

export interface DocumentStoreTenantConfigOverride {
  documentStores?: DocumentStoreConfig[];
  documentRouting?: DocumentRoutingRule[];
  matterFolderNameTemplate?: string;
  documentAccess?: DocumentAccessConfig;
  matterFolderTemplates?: MatterFolderTemplatesConfig;
}

interface DbPersonEntraRow {
  tenant_id: string;
  person_id: string;
  entra_object_id: string;
  upn: string | null;
  populated_source: PersonEntraIdentityRecord['populatedSource'];
  updated_at: Date | string;
}

interface DbMatterLocationRow {
  id: string;
  tenant_id: string;
  matter_id: string;
  store_id: string;
  library_id: string;
  provider_site_id: string;
  provider_drive_id: string;
  provider_folder_item_id: string;
  web_url: string;
  relative_path: string;
  folder_item_map: Record<string, string>;
  template_id: string;
  template_version: number;
  provisioning_status: MatterDocumentLocationRecord['provisioningStatus'];
  link_mode: MatterDocumentLocationRecord['linkMode'];
  routing_mismatch_note: string | null;
  has_unique_permissions: boolean;
  unique_scope_count: number;
  intended_grants: DocumentPermissionGrant[];
  retention_label_id: string | null;
  delta_sync_cursor: string | null;
  last_job_id: string | null;
  last_error_code: MatterDocumentLocationRecord['lastErrorCode'];
  last_error_message: string | null;
  provisioned_at: Date | string | null;
  updated_at: Date | string;
}

interface DbFolderScopeRow {
  id: string;
  tenant_id: string;
  store_id: string;
  library_id: string;
  scope_type: DocumentStoreFolderScopeRecord['scopeType'];
  scope_key: string;
  provider_item_id: string;
  has_unique_permissions: boolean;
  intended_grants: DocumentPermissionGrant[];
  last_verified_at: Date | string;
}

interface DbLifecycleJobRow {
  id: string;
  tenant_id: string;
  correlation_id: string;
  store_id: string;
  matter_id: string | null;
  job_type: DocumentLifecycleJobRecord['jobType'];
  status: DocumentLifecycleJobRecord['status'];
  attempt_count: number;
  max_attempts: number;
  triggered_by_user_id: string | null;
  trigger_event: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  last_error_code: DocumentLifecycleJobRecord['lastErrorCode'];
  last_error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DbReconciliationFindingRow {
  id: string;
  tenant_id: string;
  store_id: string;
  library_id: string;
  matter_id: string | null;
  provider_item_id: string | null;
  scope_identifier: string;
  finding_type: DocumentReconciliationFindingRecord['findingType'];
  severity: DocumentReconciliationFindingRecord['severity'];
  status: DocumentReconciliationFindingRecord['status'];
  intended_state: Record<string, unknown>;
  actual_state: Record<string, unknown>;
  detected_at: Date | string;
  remediated_at: Date | string | null;
  remediated_by_user_id: string | null;
}

interface DbDocStoreAuditRow {
  id: string;
  tenant_id: string;
  correlation_id: string;
  occurred_at: Date | string;
  actor_user_id: string | null;
  identity_used: DocumentStoreAuditEventRecord['identityUsed'];
  trigger_event: string;
  action: string;
  matter_id: string | null;
  store_id: string | null;
  library_id: string | null;
  provider_item_id: string | null;
  outcome: DocumentStoreAuditEventRecord['outcome'];
  error_code: DocumentStoreAuditEventRecord['errorCode'];
  metadata: Record<string, unknown>;
}

function cloneGrants(
  grants: readonly DocumentPermissionGrant[] | undefined,
): DocumentPermissionGrant[] {
  return Array.isArray(grants)
    ? grants.map((g) => ({
        principal: { ...g.principal },
        level: g.level,
      }))
    : [];
}

function mapLocationRow(row: DbMatterLocationRow): MatterDocumentLocationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    matterId: row.matter_id,
    storeId: row.store_id,
    libraryId: row.library_id,
    providerSiteId: row.provider_site_id,
    providerDriveId: row.provider_drive_id,
    providerFolderItemId: row.provider_folder_item_id,
    webUrl: row.web_url,
    relativePath: row.relative_path,
    folderItemMap: { ...(row.folder_item_map ?? {}) },
    templateId: row.template_id,
    templateVersion: Number(row.template_version),
    provisioningStatus: row.provisioning_status,
    linkMode: row.link_mode,
    routingMismatchNote: row.routing_mismatch_note,
    hasUniquePermissions: Boolean(row.has_unique_permissions),
    uniqueScopeCount: Number(row.unique_scope_count),
    intendedGrants: cloneGrants(row.intended_grants),
    retentionLabelId: row.retention_label_id,
    deltaSyncCursor: row.delta_sync_cursor,
    lastJobId: row.last_job_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    provisionedAt: toNullableIsoString(row.provisioned_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapFolderScopeRow(
  row: DbFolderScopeRow,
): DocumentStoreFolderScopeRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    storeId: row.store_id,
    libraryId: row.library_id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    providerItemId: row.provider_item_id,
    hasUniquePermissions: Boolean(row.has_unique_permissions),
    intendedGrants: cloneGrants(row.intended_grants),
    lastVerifiedAt: toIsoString(row.last_verified_at),
  };
}

function mapLifecycleJobRow(
  row: DbLifecycleJobRow,
): DocumentLifecycleJobRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    correlationId: row.correlation_id,
    storeId: row.store_id,
    matterId: row.matter_id,
    jobType: row.job_type,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    triggeredByUserId: row.triggered_by_user_id,
    triggerEvent: row.trigger_event,
    payload: { ...(row.payload ?? {}) },
    result: row.result ? { ...row.result } : null,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapFindingRow(
  row: DbReconciliationFindingRow,
): DocumentReconciliationFindingRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    storeId: row.store_id,
    libraryId: row.library_id,
    matterId: row.matter_id,
    providerItemId: row.provider_item_id,
    scopeIdentifier: row.scope_identifier,
    findingType: row.finding_type,
    severity: row.severity,
    status: row.status,
    intendedState: { ...(row.intended_state ?? {}) },
    actualState: { ...(row.actual_state ?? {}) },
    detectedAt: toIsoString(row.detected_at),
    remediatedAt: toNullableIsoString(row.remediated_at),
    remediatedByUserId: row.remediated_by_user_id,
  };
}

function mapAuditRow(row: DbDocStoreAuditRow): DocumentStoreAuditEventRecord {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    correlationId: row.correlation_id,
    occurredAt: toIsoString(row.occurred_at),
    actorUserId: row.actor_user_id,
    identityUsed: row.identity_used,
    triggerEvent: row.trigger_event,
    action: row.action as DocumentStoreAuditEventRecord['action'],
    matterId: row.matter_id,
    storeId: row.store_id,
    libraryId: row.library_id,
    providerItemId: row.provider_item_id,
    outcome: row.outcome,
    errorCode: row.error_code,
    metadata: Object.freeze({ ...(row.metadata ?? {}) }),
  });
}

export class TenantDocumentStoreRepository extends TenantScopedRepository {
  // ============================================================================
  // Tenant Configuration Override (`document_store_tenant_configs`, 0006)
  // ============================================================================

  public async getDocumentStoreTenantConfig(
    ctx: TenantContext,
  ): Promise<DocumentStoreTenantConfigOverride | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        config_json: DocumentStoreTenantConfigOverride;
      }>(
        'SELECT tenant_id, config_json FROM document_store_tenant_configs WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'DocumentStoreTenantConfig');
      return structuredClone(row.config_json);
    });
  }

  public async putDocumentStoreTenantConfig(
    ctx: TenantContext,
    override: DocumentStoreTenantConfigOverride | null,
    updatedById?: string,
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      if (override === null) {
        await tx.query(
          'DELETE FROM document_store_tenant_configs WHERE tenant_id = $1',
          [ctx.tenantId],
        );
        return;
      }
      await tx.query(
        `INSERT INTO document_store_tenant_configs (tenant_id, config_json, updated_by_id, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET
           config_json = EXCLUDED.config_json,
           updated_by_id = EXCLUDED.updated_by_id,
           updated_at = NOW()`,
        [ctx.tenantId, JSON.stringify(override), updatedById ?? ctx.actorId],
      );
    });
  }

  // ============================================================================
  // Person Entra Identities
  // ============================================================================

  public async putPersonEntraIdentity(
    ctx: TenantContext,
    record: PersonEntraIdentityRecord,
  ): Promise<PersonEntraIdentityRecord> {
    this.assertRowTenant(ctx, record.tenantId, 'PersonEntraIdentityRecord');
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbPersonEntraRow>(
        `INSERT INTO person_entra_identities (
           tenant_id, person_id, entra_object_id, upn, populated_source, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, person_id) DO UPDATE SET
           entra_object_id = EXCLUDED.entra_object_id,
           upn = EXCLUDED.upn,
           populated_source = EXCLUDED.populated_source,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          ctx.tenantId,
          record.personId,
          record.entraObjectId,
          record.upn ?? null,
          record.populatedSource,
          record.updatedAt,
        ],
      );
      const row = res.rows[0]!;
      this.assertRowTenant(ctx, row.tenant_id, 'PersonEntraIdentityRecord');
      return {
        tenantId: row.tenant_id,
        personId: row.person_id,
        entraObjectId: row.entra_object_id,
        ...(row.upn !== null ? { upn: row.upn } : {}),
        populatedSource: row.populated_source,
        updatedAt: toIsoString(row.updated_at),
      };
    });
  }

  public async getPersonEntraIdentity(
    ctx: TenantContext,
    personId: string,
  ): Promise<PersonEntraIdentityRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbPersonEntraRow>(
        'SELECT * FROM person_entra_identities WHERE tenant_id = $1 AND person_id = $2',
        [ctx.tenantId, personId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'PersonEntraIdentityRecord');
      return {
        tenantId: row.tenant_id,
        personId: row.person_id,
        entraObjectId: row.entra_object_id,
        ...(row.upn !== null ? { upn: row.upn } : {}),
        populatedSource: row.populated_source,
        updatedAt: toIsoString(row.updated_at),
      };
    });
  }

  public async listPersonEntraIdentities(
    ctx: TenantContext,
  ): Promise<PersonEntraIdentityRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbPersonEntraRow>(
        'SELECT * FROM person_entra_identities WHERE tenant_id = $1 ORDER BY person_id ASC',
        [ctx.tenantId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'PersonEntraIdentityRecord');
        return {
          tenantId: row.tenant_id,
          personId: row.person_id,
          entraObjectId: row.entra_object_id,
          ...(row.upn !== null ? { upn: row.upn } : {}),
          populatedSource: row.populated_source,
          updatedAt: toIsoString(row.updated_at),
        };
      });
    });
  }

  // ============================================================================
  // Matter Document Locations
  // ============================================================================

  public async putMatterLocation(
    ctx: TenantContext,
    location: MatterDocumentLocationRecord,
  ): Promise<MatterDocumentLocationRecord> {
    this.assertRowTenant(
      ctx,
      location.tenantId,
      'MatterDocumentLocationRecord',
    );
    return this.withTenantTransaction(ctx, async (tx) => {
      // Remove any stale row with a different id for the same (tenant_id, matter_id, store_id, library_id) unique key
      await tx.query(
        `DELETE FROM matter_document_locations
         WHERE tenant_id = $1 AND matter_id = $2 AND store_id = $3 AND library_id = $4 AND id <> $5`,
        [
          ctx.tenantId,
          location.matterId,
          location.storeId,
          location.libraryId,
          location.id,
        ],
      );
      const res = await tx.query<DbMatterLocationRow>(
        `INSERT INTO matter_document_locations (
           id, tenant_id, matter_id, store_id, library_id,
           provider_site_id, provider_drive_id, provider_folder_item_id,
           web_url, relative_path, folder_item_map, template_id, template_version,
           provisioning_status, link_mode, routing_mismatch_note,
           has_unique_permissions, unique_scope_count, intended_grants,
           retention_label_id, delta_sync_cursor, last_job_id,
           last_error_code, last_error_message, provisioned_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,
           $17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26
         )
         ON CONFLICT (id) DO UPDATE SET
           matter_id = EXCLUDED.matter_id,
           store_id = EXCLUDED.store_id,
           library_id = EXCLUDED.library_id,
           provider_site_id = EXCLUDED.provider_site_id,
           provider_drive_id = EXCLUDED.provider_drive_id,
           provider_folder_item_id = EXCLUDED.provider_folder_item_id,
           web_url = EXCLUDED.web_url,
           relative_path = EXCLUDED.relative_path,
           folder_item_map = EXCLUDED.folder_item_map,
           template_id = EXCLUDED.template_id,
           template_version = EXCLUDED.template_version,
           provisioning_status = EXCLUDED.provisioning_status,
           link_mode = EXCLUDED.link_mode,
           routing_mismatch_note = EXCLUDED.routing_mismatch_note,
           has_unique_permissions = EXCLUDED.has_unique_permissions,
           unique_scope_count = EXCLUDED.unique_scope_count,
           intended_grants = EXCLUDED.intended_grants,
           retention_label_id = EXCLUDED.retention_label_id,
           delta_sync_cursor = EXCLUDED.delta_sync_cursor,
           last_job_id = EXCLUDED.last_job_id,
           last_error_code = EXCLUDED.last_error_code,
           last_error_message = EXCLUDED.last_error_message,
           provisioned_at = EXCLUDED.provisioned_at,
           updated_at = EXCLUDED.updated_at
         WHERE matter_document_locations.tenant_id = $2
         RETURNING *`,
        [
          location.id,
          ctx.tenantId,
          location.matterId,
          location.storeId,
          location.libraryId,
          location.providerSiteId,
          location.providerDriveId,
          location.providerFolderItemId,
          location.webUrl,
          location.relativePath,
          JSON.stringify(location.folderItemMap ?? {}),
          location.templateId,
          location.templateVersion,
          location.provisioningStatus,
          location.linkMode ?? 'provisioned',
          location.routingMismatchNote ?? null,
          Boolean(location.hasUniquePermissions),
          location.uniqueScopeCount ?? 0,
          JSON.stringify(location.intendedGrants ?? []),
          location.retentionLabelId ?? null,
          location.deltaSyncCursor ?? null,
          location.lastJobId ?? null,
          location.lastErrorCode ?? null,
          location.lastErrorMessage ?? null,
          location.provisionedAt ?? null,
          location.updatedAt,
        ],
      );
      const saved = res.rows[0];
      if (!saved) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Cross-tenant matter location ID collision rejected.',
        );
      }
      this.assertRowTenant(ctx, saved.tenant_id, 'MatterDocumentLocationRecord');
      return mapLocationRow(saved);
    });
  }

  public async getMatterLocationById(
    ctx: TenantContext,
    locationId: string,
  ): Promise<MatterDocumentLocationRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbMatterLocationRow>(
        'SELECT * FROM matter_document_locations WHERE id = $1 AND tenant_id = $2',
        [locationId, ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'MatterDocumentLocationRecord');
      return mapLocationRow(row);
    });
  }

  public async listMatterLocationsByMatterId(
    ctx: TenantContext,
    matterId: string,
  ): Promise<MatterDocumentLocationRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbMatterLocationRow>(
        'SELECT * FROM matter_document_locations WHERE tenant_id = $1 AND matter_id = $2 ORDER BY updated_at ASC',
        [ctx.tenantId, matterId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'MatterDocumentLocationRecord');
        return mapLocationRow(r);
      });
    });
  }

  public async listAllMatterLocations(
    ctx: TenantContext,
    storeId?: string,
  ): Promise<MatterDocumentLocationRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = storeId
        ? await tx.query<DbMatterLocationRow>(
            'SELECT * FROM matter_document_locations WHERE tenant_id = $1 AND store_id = $2 ORDER BY updated_at ASC',
            [ctx.tenantId, storeId],
          )
        : await tx.query<DbMatterLocationRow>(
            'SELECT * FROM matter_document_locations WHERE tenant_id = $1 ORDER BY updated_at ASC',
            [ctx.tenantId],
          );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'MatterDocumentLocationRecord');
        return mapLocationRow(r);
      });
    });
  }

  // ============================================================================
  // Folder Scopes
  // ============================================================================

  public async putFolderScope(
    ctx: TenantContext,
    scope: DocumentStoreFolderScopeRecord,
  ): Promise<DocumentStoreFolderScopeRecord> {
    this.assertRowTenant(
      ctx,
      scope.tenantId,
      'DocumentStoreFolderScopeRecord',
    );
    return this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        `DELETE FROM document_store_folder_scopes
         WHERE tenant_id = $1 AND store_id = $2 AND library_id = $3 AND scope_type = $4 AND scope_key = $5 AND id <> $6`,
        [
          ctx.tenantId,
          scope.storeId,
          scope.libraryId,
          scope.scopeType,
          scope.scopeKey,
          scope.id,
        ],
      );
      const res = await tx.query<DbFolderScopeRow>(
        `INSERT INTO document_store_folder_scopes (
           id, tenant_id, store_id, library_id, scope_type, scope_key,
           provider_item_id, has_unique_permissions, intended_grants, last_verified_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         ON CONFLICT (id) DO UPDATE SET
           provider_item_id = EXCLUDED.provider_item_id,
           has_unique_permissions = EXCLUDED.has_unique_permissions,
           intended_grants = EXCLUDED.intended_grants,
           last_verified_at = EXCLUDED.last_verified_at
         WHERE document_store_folder_scopes.tenant_id = $2
         RETURNING *`,
        [
          scope.id,
          ctx.tenantId,
          scope.storeId,
          scope.libraryId,
          scope.scopeType,
          scope.scopeKey,
          scope.providerItemId,
          Boolean(scope.hasUniquePermissions),
          JSON.stringify(scope.intendedGrants ?? []),
          scope.lastVerifiedAt,
        ],
      );
      const saved = res.rows[0];
      if (!saved) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Cross-tenant folder scope ID collision rejected.',
        );
      }
      this.assertRowTenant(
        ctx,
        saved.tenant_id,
        'DocumentStoreFolderScopeRecord',
      );
      return mapFolderScopeRow(saved);
    });
  }

  public async findFolderScope(
    ctx: TenantContext,
    params: {
      storeId: string;
      libraryId: string;
      scopeType: DocumentStoreFolderScopeRecord['scopeType'];
      scopeKey: string;
    },
  ): Promise<DocumentStoreFolderScopeRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbFolderScopeRow>(
        `SELECT * FROM document_store_folder_scopes
         WHERE tenant_id = $1 AND store_id = $2 AND library_id = $3 AND scope_type = $4 AND scope_key = $5
         LIMIT 1`,
        [
          ctx.tenantId,
          params.storeId,
          params.libraryId,
          params.scopeType,
          params.scopeKey,
        ],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(
        ctx,
        row.tenant_id,
        'DocumentStoreFolderScopeRecord',
      );
      return mapFolderScopeRow(row);
    });
  }

  public async listFolderScopes(
    ctx: TenantContext,
    storeId?: string,
    libraryId?: string,
  ): Promise<DocumentStoreFolderScopeRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses = ['tenant_id = $1'];
      const values: unknown[] = [ctx.tenantId];
      if (storeId) {
        values.push(storeId);
        clauses.push(`store_id = $${values.length}`);
      }
      if (libraryId) {
        values.push(libraryId);
        clauses.push(`library_id = $${values.length}`);
      }
      const res = await tx.query<DbFolderScopeRow>(
        `SELECT * FROM document_store_folder_scopes WHERE ${clauses.join(' AND ')} ORDER BY id ASC`,
        values,
      );
      return res.rows.map((r) => {
        this.assertRowTenant(
          ctx,
          r.tenant_id,
          'DocumentStoreFolderScopeRecord',
        );
        return mapFolderScopeRow(r);
      });
    });
  }

  // ============================================================================
  // Lifecycle Jobs
  // ============================================================================

  public async putLifecycleJob(
    ctx: TenantContext,
    job: DocumentLifecycleJobRecord,
  ): Promise<DocumentLifecycleJobRecord> {
    this.assertRowTenant(ctx, job.tenantId, 'DocumentLifecycleJobRecord');
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbLifecycleJobRow>(
        `INSERT INTO document_lifecycle_jobs (
           id, tenant_id, correlation_id, store_id, matter_id, job_type,
           status, attempt_count, max_attempts, triggered_by_user_id, trigger_event,
           payload, result, last_error_code, last_error_message, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17
         )
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           attempt_count = EXCLUDED.attempt_count,
           payload = EXCLUDED.payload,
           result = EXCLUDED.result,
           last_error_code = EXCLUDED.last_error_code,
           last_error_message = EXCLUDED.last_error_message,
           updated_at = EXCLUDED.updated_at
         WHERE document_lifecycle_jobs.tenant_id = $2
         RETURNING *`,
        [
          job.id,
          ctx.tenantId,
          job.correlationId,
          job.storeId,
          job.matterId ?? null,
          job.jobType,
          job.status,
          job.attemptCount,
          job.maxAttempts,
          job.triggeredByUserId ?? null,
          job.triggerEvent,
          JSON.stringify(job.payload ?? {}),
          job.result ? JSON.stringify(job.result) : null,
          job.lastErrorCode ?? null,
          job.lastErrorMessage ?? null,
          job.createdAt,
          job.updatedAt,
        ],
      );
      const saved = res.rows[0];
      if (!saved) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Cross-tenant lifecycle job ID collision rejected.',
        );
      }
      this.assertRowTenant(ctx, saved.tenant_id, 'DocumentLifecycleJobRecord');
      return mapLifecycleJobRow(saved);
    });
  }

  public async getLifecycleJobById(
    ctx: TenantContext,
    jobId: string,
  ): Promise<DocumentLifecycleJobRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbLifecycleJobRow>(
        'SELECT * FROM document_lifecycle_jobs WHERE id = $1 AND tenant_id = $2',
        [jobId, ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'DocumentLifecycleJobRecord');
      return mapLifecycleJobRow(row);
    });
  }

  public async listLifecycleJobs(
    ctx: TenantContext,
    matterId?: string,
  ): Promise<DocumentLifecycleJobRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = matterId
        ? await tx.query<DbLifecycleJobRow>(
            'SELECT * FROM document_lifecycle_jobs WHERE tenant_id = $1 AND matter_id = $2 ORDER BY created_at DESC',
            [ctx.tenantId, matterId],
          )
        : await tx.query<DbLifecycleJobRow>(
            'SELECT * FROM document_lifecycle_jobs WHERE tenant_id = $1 ORDER BY created_at DESC',
            [ctx.tenantId],
          );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'DocumentLifecycleJobRecord');
        return mapLifecycleJobRow(r);
      });
    });
  }

  // ============================================================================
  // Reconciliation Findings
  // ============================================================================

  public async putReconciliationFinding(
    ctx: TenantContext,
    finding: DocumentReconciliationFindingRecord,
  ): Promise<DocumentReconciliationFindingRecord> {
    this.assertRowTenant(
      ctx,
      finding.tenantId,
      'DocumentReconciliationFindingRecord',
    );
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbReconciliationFindingRow>(
        `INSERT INTO document_reconciliation_findings (
           id, tenant_id, store_id, library_id, matter_id, provider_item_id,
           scope_identifier, finding_type, severity, status,
           intended_state, actual_state, detected_at, remediated_at, remediated_by_user_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15
         )
         ON CONFLICT (id) DO UPDATE SET
           severity = EXCLUDED.severity,
           status = EXCLUDED.status,
           intended_state = EXCLUDED.intended_state,
           actual_state = EXCLUDED.actual_state,
           remediated_at = EXCLUDED.remediated_at,
           remediated_by_user_id = EXCLUDED.remediated_by_user_id
         WHERE document_reconciliation_findings.tenant_id = $2
         RETURNING *`,
        [
          finding.id,
          ctx.tenantId,
          finding.storeId,
          finding.libraryId,
          finding.matterId ?? null,
          finding.providerItemId ?? null,
          finding.scopeIdentifier,
          finding.findingType,
          finding.severity,
          finding.status,
          JSON.stringify(finding.intendedState ?? {}),
          JSON.stringify(finding.actualState ?? {}),
          finding.detectedAt,
          finding.remediatedAt ?? null,
          finding.remediatedByUserId ?? null,
        ],
      );
      const saved = res.rows[0];
      if (!saved) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Cross-tenant reconciliation finding ID collision rejected.',
        );
      }
      this.assertRowTenant(
        ctx,
        saved.tenant_id,
        'DocumentReconciliationFindingRecord',
      );
      return mapFindingRow(saved);
    });
  }

  public async getReconciliationFindingById(
    ctx: TenantContext,
    findingId: string,
  ): Promise<DocumentReconciliationFindingRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbReconciliationFindingRow>(
        'SELECT * FROM document_reconciliation_findings WHERE id = $1 AND tenant_id = $2',
        [findingId, ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(
        ctx,
        row.tenant_id,
        'DocumentReconciliationFindingRecord',
      );
      return mapFindingRow(row);
    });
  }

  public async listReconciliationFindings(
    ctx: TenantContext,
    options?: { storeId?: string; status?: 'open' | 'remediated' | 'ignored' },
  ): Promise<DocumentReconciliationFindingRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses = ['tenant_id = $1'];
      const values: unknown[] = [ctx.tenantId];
      if (options?.storeId) {
        values.push(options.storeId);
        clauses.push(`store_id = $${values.length}`);
      }
      if (options?.status) {
        values.push(options.status);
        clauses.push(`status = $${values.length}`);
      }
      const res = await tx.query<DbReconciliationFindingRow>(
        `SELECT * FROM document_reconciliation_findings WHERE ${clauses.join(' AND ')} ORDER BY detected_at DESC`,
        values,
      );
      return res.rows.map((r) => {
        this.assertRowTenant(
          ctx,
          r.tenant_id,
          'DocumentReconciliationFindingRecord',
        );
        return mapFindingRow(r);
      });
    });
  }

  // ============================================================================
  // Audit Events (Immutable)
  // ============================================================================

  public async appendAuditEvent(
    ctx: TenantContext,
    event: DocumentStoreAuditEventRecord,
  ): Promise<DocumentStoreAuditEventRecord> {
    this.assertRowTenant(
      ctx,
      event.tenantId,
      'DocumentStoreAuditEventRecord',
    );
    return this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        `INSERT INTO document_store_audit_events (
           id, tenant_id, correlation_id, occurred_at, actor_user_id,
           identity_used, trigger_event, action, matter_id, store_id,
           library_id, provider_item_id, outcome, error_code, metadata
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          event.id,
          ctx.tenantId,
          event.correlationId,
          event.occurredAt,
          event.actorUserId ?? null,
          event.identityUsed,
          event.triggerEvent,
          event.action,
          event.matterId ?? null,
          event.storeId ?? null,
          event.libraryId ?? null,
          event.providerItemId ?? null,
          event.outcome,
          event.errorCode ?? null,
          JSON.stringify(event.metadata ?? {}),
        ],
      );
      const res = await tx.query<DbDocStoreAuditRow>(
        'SELECT * FROM document_store_audit_events WHERE id = $1 AND tenant_id = $2',
        [event.id, ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Cross-tenant document store audit ID collision rejected.',
        );
      }
      this.assertRowTenant(ctx, row.tenant_id, 'DocumentStoreAuditEventRecord');
      return mapAuditRow(row);
    });
  }

  public async listAuditEvents(
    ctx: TenantContext,
    options?: { matterId?: string; storeId?: string; limit?: number },
  ): Promise<DocumentStoreAuditEventRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses = ['tenant_id = $1'];
      const values: unknown[] = [ctx.tenantId];
      if (options?.matterId) {
        values.push(options.matterId);
        clauses.push(`matter_id = $${values.length}`);
      }
      if (options?.storeId) {
        values.push(options.storeId);
        clauses.push(`store_id = $${values.length}`);
      }
      let sql = `SELECT * FROM document_store_audit_events WHERE ${clauses.join(' AND ')} ORDER BY occurred_at DESC`;
      if (options?.limit && options.limit > 0) {
        values.push(Math.floor(options.limit));
        sql += ` LIMIT $${values.length}`;
      }
      const res = await tx.query<DbDocStoreAuditRow>(sql, values);
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'DocumentStoreAuditEventRecord');
        return mapAuditRow(r);
      });
    });
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        'DELETE FROM document_store_audit_events WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM document_reconciliation_findings WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM document_lifecycle_jobs WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM document_store_folder_scopes WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM matter_document_locations WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM person_entra_identities WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM document_store_tenant_configs WHERE tenant_id = $1',
        [ctx.tenantId],
      );
    });
  }
}
