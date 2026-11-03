/**
 * Tenant-Scoped Document Store Repository (`core/src/tenancy/documentStoreRepository.ts`).
 *
 * Rules enforced (Platform Architecture Standard Section 8):
 * 1. All reads and writes require a verified `TenantContext`.
 * 2. Data is isolated per tenant database (`ctx.postgresDatabaseName`) and verified by `tenantId`.
 * 3. Tampered record IDs belonging to another tenant return `null` or throw `TENANCY_ISOLATION_ERROR`.
 * 4. Stores only external DMS references (`siteId`, `driveId`, `itemId`, `webUrl`) — never document bytes.
 */

import type { TenantContext } from '../api/index';
import type {
  DocumentLifecycleJobRecord,
  DocumentReconciliationFindingRecord,
  DocumentStoreAuditEventRecord,
  DocumentStoreFolderScopeRecord,
  MatterDocumentLocationRecord,
} from '../domain/documents/types';

export interface PersonEntraIdentityRecord {
  tenantId: string;
  personId: string;
  entraObjectId: string;
  upn?: string;
  populatedSource: 'oidc_signin' | 'upn_lookup' | 'admin_provisioned';
  updatedAt: string;
}

interface TenantDocumentStoreDatabase {
  matterLocations: Map<string, MatterDocumentLocationRecord>;
  folderScopes: Map<string, DocumentStoreFolderScopeRecord>;
  lifecycleJobs: Map<string, DocumentLifecycleJobRecord>;
  reconciliationFindings: Map<string, DocumentReconciliationFindingRecord>;
  auditEvents: Map<string, DocumentStoreAuditEventRecord>;
  personEntraIdentities: Map<string, PersonEntraIdentityRecord>;
}

export class TenantDocumentStoreRepository {
  private readonly databases = new Map<string, TenantDocumentStoreDatabase>();

  private getDb(ctx: TenantContext): TenantDocumentStoreDatabase {
    if (!ctx?.tenantId || !ctx?.postgresDatabaseName) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Document store repository operation requires a valid TenantContext.',
      );
    }
    let db = this.databases.get(ctx.postgresDatabaseName);
    if (!db) {
      db = {
        matterLocations: new Map(),
        folderScopes: new Map(),
        lifecycleJobs: new Map(),
        reconciliationFindings: new Map(),
        auditEvents: new Map(),
        personEntraIdentities: new Map(),
      };
      this.databases.set(ctx.postgresDatabaseName, db);
    }
    return db;
  }

  private assertRecordTenant(
    ctx: TenantContext,
    recordTenantId: string,
    entityLabel: string,
  ): void {
    if (recordTenantId !== ctx.tenantId) {
      throw new Error(
        `TENANCY_ISOLATION_ERROR: Cannot write or access ${entityLabel} belonging to tenant "${recordTenantId}" under tenant "${ctx.tenantId}".`,
      );
    }
  }

  // ============================================================================
  // Person Entra Identities (populated on sign-in or resolved by UPN)
  // ============================================================================

  public putPersonEntraIdentity(
    ctx: TenantContext,
    record: PersonEntraIdentityRecord,
  ): PersonEntraIdentityRecord {
    this.assertRecordTenant(ctx, record.tenantId, 'PersonEntraIdentityRecord');
    const db = this.getDb(ctx);
    const copy: PersonEntraIdentityRecord = { ...record };
    db.personEntraIdentities.set(copy.personId, copy);
    return copy;
  }

  public getPersonEntraIdentity(
    ctx: TenantContext,
    personId: string,
  ): PersonEntraIdentityRecord | null {
    const db = this.getDb(ctx);
    const found = db.personEntraIdentities.get(personId);
    if (!found || found.tenantId !== ctx.tenantId) {
      return null;
    }
    return { ...found };
  }

  public listPersonEntraIdentities(
    ctx: TenantContext,
  ): PersonEntraIdentityRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.personEntraIdentities.values())
      .filter((r) => r.tenantId === ctx.tenantId)
      .map((r) => ({ ...r }));
  }

  // ============================================================================
  // Matter Document Locations
  // ============================================================================

  public putMatterLocation(
    ctx: TenantContext,
    location: MatterDocumentLocationRecord,
  ): MatterDocumentLocationRecord {
    this.assertRecordTenant(
      ctx,
      location.tenantId,
      'MatterDocumentLocationRecord',
    );
    const db = this.getDb(ctx);
    const copy: MatterDocumentLocationRecord = {
      ...location,
      folderItemMap: { ...location.folderItemMap },
      intendedGrants: location.intendedGrants.map((g) => ({
        principal: { ...g.principal },
        level: g.level,
      })),
    };
    db.matterLocations.set(copy.id, copy);
    return copy;
  }

  public getMatterLocationById(
    ctx: TenantContext,
    locationId: string,
  ): MatterDocumentLocationRecord | null {
    const db = this.getDb(ctx);
    const found = db.matterLocations.get(locationId);
    if (!found || found.tenantId !== ctx.tenantId) {
      return null;
    }
    return {
      ...found,
      folderItemMap: { ...found.folderItemMap },
      intendedGrants: found.intendedGrants.map((g) => ({
        principal: { ...g.principal },
        level: g.level,
      })),
    };
  }

  public listMatterLocationsByMatterId(
    ctx: TenantContext,
    matterId: string,
  ): MatterDocumentLocationRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.matterLocations.values())
      .filter((loc) => loc.tenantId === ctx.tenantId && loc.matterId === matterId)
      .map((loc) => ({
        ...loc,
        folderItemMap: { ...loc.folderItemMap },
        intendedGrants: loc.intendedGrants.map((g) => ({
          principal: { ...g.principal },
          level: g.level,
        })),
      }));
  }

  public listAllMatterLocations(
    ctx: TenantContext,
    storeId?: string,
  ): MatterDocumentLocationRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.matterLocations.values())
      .filter(
        (loc) =>
          loc.tenantId === ctx.tenantId &&
          (!storeId || loc.storeId === storeId),
      )
      .map((loc) => ({
        ...loc,
        folderItemMap: { ...loc.folderItemMap },
        intendedGrants: loc.intendedGrants.map((g) => ({
          principal: { ...g.principal },
          level: g.level,
        })),
      }));
  }

  // ============================================================================
  // Folder Scopes (Library Root, Department, Team, Matter Exception)
  // ============================================================================

  public putFolderScope(
    ctx: TenantContext,
    scope: DocumentStoreFolderScopeRecord,
  ): DocumentStoreFolderScopeRecord {
    this.assertRecordTenant(
      ctx,
      scope.tenantId,
      'DocumentStoreFolderScopeRecord',
    );
    const db = this.getDb(ctx);
    const copy: DocumentStoreFolderScopeRecord = {
      ...scope,
      intendedGrants: scope.intendedGrants.map((g) => ({
        principal: { ...g.principal },
        level: g.level,
      })),
    };
    db.folderScopes.set(copy.id, copy);
    return copy;
  }

  public findFolderScope(
    ctx: TenantContext,
    params: {
      storeId: string;
      libraryId: string;
      scopeType: DocumentStoreFolderScopeRecord['scopeType'];
      scopeKey: string;
    },
  ): DocumentStoreFolderScopeRecord | null {
    const db = this.getDb(ctx);
    for (const s of db.folderScopes.values()) {
      if (
        s.tenantId === ctx.tenantId &&
        s.storeId === params.storeId &&
        s.libraryId === params.libraryId &&
        s.scopeType === params.scopeType &&
        s.scopeKey === params.scopeKey
      ) {
        return {
          ...s,
          intendedGrants: s.intendedGrants.map((g) => ({
            principal: { ...g.principal },
            level: g.level,
          })),
        };
      }
    }
    return null;
  }

  public listFolderScopes(
    ctx: TenantContext,
    storeId?: string,
    libraryId?: string,
  ): DocumentStoreFolderScopeRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.folderScopes.values())
      .filter(
        (s) =>
          s.tenantId === ctx.tenantId &&
          (!storeId || s.storeId === storeId) &&
          (!libraryId || s.libraryId === libraryId),
      )
      .map((s) => ({
        ...s,
        intendedGrants: s.intendedGrants.map((g) => ({
          principal: { ...g.principal },
          level: g.level,
        })),
      }));
  }

  // ============================================================================
  // Lifecycle Jobs
  // ============================================================================

  public putLifecycleJob(
    ctx: TenantContext,
    job: DocumentLifecycleJobRecord,
  ): DocumentLifecycleJobRecord {
    this.assertRecordTenant(ctx, job.tenantId, 'DocumentLifecycleJobRecord');
    const db = this.getDb(ctx);
    const copy: DocumentLifecycleJobRecord = {
      ...job,
      payload: { ...job.payload },
      result: job.result ? { ...job.result } : null,
    };
    db.lifecycleJobs.set(copy.id, copy);
    return copy;
  }

  public getLifecycleJobById(
    ctx: TenantContext,
    jobId: string,
  ): DocumentLifecycleJobRecord | null {
    const db = this.getDb(ctx);
    const found = db.lifecycleJobs.get(jobId);
    if (!found || found.tenantId !== ctx.tenantId) {
      return null;
    }
    return {
      ...found,
      payload: { ...found.payload },
      result: found.result ? { ...found.result } : null,
    };
  }

  public listLifecycleJobs(
    ctx: TenantContext,
    matterId?: string,
  ): DocumentLifecycleJobRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.lifecycleJobs.values())
      .filter(
        (j) =>
          j.tenantId === ctx.tenantId &&
          (!matterId || j.matterId === matterId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ============================================================================
  // Reconciliation Findings
  // ============================================================================

  public putReconciliationFinding(
    ctx: TenantContext,
    finding: DocumentReconciliationFindingRecord,
  ): DocumentReconciliationFindingRecord {
    this.assertRecordTenant(
      ctx,
      finding.tenantId,
      'DocumentReconciliationFindingRecord',
    );
    const db = this.getDb(ctx);
    const copy: DocumentReconciliationFindingRecord = {
      ...finding,
      intendedState: { ...finding.intendedState },
      actualState: { ...finding.actualState },
    };
    db.reconciliationFindings.set(copy.id, copy);
    return copy;
  }

  public getReconciliationFindingById(
    ctx: TenantContext,
    findingId: string,
  ): DocumentReconciliationFindingRecord | null {
    const db = this.getDb(ctx);
    const found = db.reconciliationFindings.get(findingId);
    if (!found || found.tenantId !== ctx.tenantId) {
      return null;
    }
    return {
      ...found,
      intendedState: { ...found.intendedState },
      actualState: { ...found.actualState },
    };
  }

  public listReconciliationFindings(
    ctx: TenantContext,
    options?: { storeId?: string; status?: 'open' | 'remediated' | 'ignored' },
  ): DocumentReconciliationFindingRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.reconciliationFindings.values())
      .filter(
        (f) =>
          f.tenantId === ctx.tenantId &&
          (!options?.storeId || f.storeId === options.storeId) &&
          (!options?.status || f.status === options.status),
      )
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  }

  // ============================================================================
  // Audit Events (Immutable)
  // ============================================================================

  public appendAuditEvent(
    ctx: TenantContext,
    event: DocumentStoreAuditEventRecord,
  ): DocumentStoreAuditEventRecord {
    this.assertRecordTenant(
      ctx,
      event.tenantId,
      'DocumentStoreAuditEventRecord',
    );
    const db = this.getDb(ctx);
    const copy: DocumentStoreAuditEventRecord = Object.freeze({
      ...event,
      metadata: Object.freeze({ ...event.metadata }),
    });
    db.auditEvents.set(copy.id, copy);
    return copy;
  }

  public listAuditEvents(
    ctx: TenantContext,
    options?: { matterId?: string; storeId?: string; limit?: number },
  ): DocumentStoreAuditEventRecord[] {
    const db = this.getDb(ctx);
    const filtered = Array.from(db.auditEvents.values())
      .filter(
        (e) =>
          e.tenantId === ctx.tenantId &&
          (!options?.matterId || e.matterId === options.matterId) &&
          (!options?.storeId || e.storeId === options.storeId),
      )
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

    return options?.limit ? filtered.slice(0, options.limit) : filtered;
  }
}
