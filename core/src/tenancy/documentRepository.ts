/**
 * Tenant-Scoped Document Generation Repository (`core/src/tenancy/documentRepository.ts`).
 *
 * Rules enforced (Platform Architecture Standard Section 8):
 * 1. All reads and writes require a verified `TenantContext`.
 * 2. Data is isolated per tenant database (`ctx.postgresDatabaseName`) and verified by `tenantId`.
 * 3. Tampered record IDs belonging to another tenant return `null` or throw `TENANCY_ISOLATION_ERROR`.
 */

import type {
  DocumentLinkRecord,
  DocumentTemplateRecord,
  DocumentTemplateVersionRecord,
  GeneratedDocumentRecord,
  TemplateUsageDailySummaryRecord,
  TemplateUsageEventRecord,
  TenantContext,
} from '../api/index';

interface TenantDocumentDatabase {
  templates: Map<string, DocumentTemplateRecord>;
  versions: Map<string, DocumentTemplateVersionRecord>;
  documents: Map<string, GeneratedDocumentRecord>;
  links: Map<string, DocumentLinkRecord>;
  usageEvents: Map<string, TemplateUsageEventRecord>;
  usageSummaries: Map<string, TemplateUsageDailySummaryRecord>;
}

export class TenantDocumentRepository {
  private readonly databases = new Map<string, TenantDocumentDatabase>();

  private getDb(ctx: TenantContext): TenantDocumentDatabase {
    if (!ctx?.tenantId || !ctx?.postgresDatabaseName) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Repository operation requires a valid TenantContext.',
      );
    }
    let db = this.databases.get(ctx.postgresDatabaseName);
    if (!db) {
      db = {
        templates: new Map(),
        versions: new Map(),
        documents: new Map(),
        links: new Map(),
        usageEvents: new Map(),
        usageSummaries: new Map(),
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
  // Templates
  // ============================================================================

  public putTemplate(
    ctx: TenantContext,
    template: DocumentTemplateRecord,
  ): DocumentTemplateRecord {
    this.assertRecordTenant(ctx, template.tenantId, 'DocumentTemplateRecord');
    const db = this.getDb(ctx);
    const copy: DocumentTemplateRecord = {
      ...template,
      tags: [...template.tags],
      availabilityRules: {
        ...template.availabilityRules,
        sourceContexts: [...template.availabilityRules.sourceContexts],
        practiceAreaKeys: template.availabilityRules.practiceAreaKeys
          ? [...template.availabilityRules.practiceAreaKeys]
          : undefined,
        matterTypeKeys: template.availabilityRules.matterTypeKeys
          ? [...template.availabilityRules.matterTypeKeys]
          : undefined,
        clientTypes: template.availabilityRules.clientTypes
          ? [...template.availabilityRules.clientTypes]
          : undefined,
        allowedRoleKeys: template.availabilityRules.allowedRoleKeys
          ? [...template.availabilityRules.allowedRoleKeys]
          : undefined,
      },
    };
    db.templates.set(copy.id, copy);
    return copy;
  }

  public getTemplateById(
    ctx: TenantContext,
    templateId: string,
  ): DocumentTemplateRecord | null {
    const db = this.getDb(ctx);
    const found = db.templates.get(templateId);
    if (!found || found.tenantId !== ctx.tenantId) {
      return null;
    }
    return found;
  }

  public getTemplateByCode(
    ctx: TenantContext,
    code: string,
  ): DocumentTemplateRecord | null {
    const db = this.getDb(ctx);
    for (const t of db.templates.values()) {
      if (
        t.tenantId === ctx.tenantId &&
        t.code.toLowerCase() === code.toLowerCase()
      ) {
        return t;
      }
    }
    return null;
  }

  public listTemplates(ctx: TenantContext): DocumentTemplateRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.templates.values())
      .filter((t) => t.tenantId === ctx.tenantId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ============================================================================
  // Template Versions
  // ============================================================================

  public putTemplateVersion(
    ctx: TenantContext,
    version: DocumentTemplateVersionRecord,
  ): DocumentTemplateVersionRecord {
    this.assertRecordTenant(
      ctx,
      version.tenantId,
      'DocumentTemplateVersionRecord',
    );
    const db = this.getDb(ctx);
    const copy: DocumentTemplateVersionRecord = {
      ...version,
      extractedPlaceholders: version.extractedPlaceholders.map((p) => ({
        ...p,
        locations: [...p.locations],
      })),
      fieldMappings: { ...version.fieldMappings },
      promptedFields: version.promptedFields.map((pf) => ({
        ...pf,
        options: pf.options ? [...pf.options] : undefined,
      })),
    };
    db.versions.set(copy.id, copy);
    return copy;
  }

  public getTemplateVersionById(
    ctx: TenantContext,
    versionId: string,
  ): DocumentTemplateVersionRecord | null {
    const db = this.getDb(ctx);
    const found = db.versions.get(versionId);
    if (!found || found.tenantId !== ctx.tenantId) {
      return null;
    }
    return found;
  }

  public listVersionsForTemplate(
    ctx: TenantContext,
    templateId: string,
  ): DocumentTemplateVersionRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.versions.values())
      .filter(
        (v) => v.tenantId === ctx.tenantId && v.templateId === templateId,
      )
      .sort((a, b) => b.versionNumber - a.versionNumber);
  }

  public listAllTemplateVersions(
    ctx: TenantContext,
  ): DocumentTemplateVersionRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.versions.values())
      .filter((v) => v.tenantId === ctx.tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ============================================================================
  // Generated Documents & Links
  // ============================================================================

  public putDocument(
    ctx: TenantContext,
    doc: GeneratedDocumentRecord,
  ): GeneratedDocumentRecord {
    this.assertRecordTenant(ctx, doc.tenantId, 'GeneratedDocumentRecord');
    const db = this.getDb(ctx);
    const copy: GeneratedDocumentRecord = { ...doc };
    db.documents.set(copy.id, copy);
    return copy;
  }

  public getDocumentById(
    ctx: TenantContext,
    documentId: string,
  ): GeneratedDocumentRecord | null {
    const db = this.getDb(ctx);
    const found = db.documents.get(documentId);
    if (!found || found.tenantId !== ctx.tenantId) {
      return null;
    }
    return found;
  }

  public listDocuments(
    ctx: TenantContext,
    options?: { includeDeleted?: boolean },
  ): GeneratedDocumentRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.documents.values())
      .filter(
        (d) =>
          d.tenantId === ctx.tenantId &&
          (options?.includeDeleted ? true : !d.isDeleted),
      )
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  public putDocumentLink(
    ctx: TenantContext,
    link: DocumentLinkRecord,
  ): DocumentLinkRecord {
    this.assertRecordTenant(ctx, link.tenantId, 'DocumentLinkRecord');
    const db = this.getDb(ctx);
    const copy: DocumentLinkRecord = { ...link };
    db.links.set(copy.id, copy);
    return copy;
  }

  public listLinksForDocument(
    ctx: TenantContext,
    documentId: string,
  ): DocumentLinkRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.links.values()).filter(
      (l) => l.tenantId === ctx.tenantId && l.documentId === documentId,
    );
  }

  public listDocumentsForEntity(
    ctx: TenantContext,
    entityType: 'matter' | 'organisation' | 'person',
    entityId: string,
  ): GeneratedDocumentRecord[] {
    const db = this.getDb(ctx);
    const linkedDocIds = new Set<string>();
    for (const l of db.links.values()) {
      if (
        l.tenantId === ctx.tenantId &&
        l.entityType === entityType &&
        l.entityId === entityId
      ) {
        linkedDocIds.add(l.documentId);
      }
    }

    return Array.from(db.documents.values())
      .filter((d) => {
        if (d.tenantId !== ctx.tenantId || d.isDeleted) return false;
        if (linkedDocIds.has(d.id)) return true;
        if (entityType === 'matter' && d.primaryMatterId === entityId) {
          return true;
        }
        if (
          (entityType === 'organisation' || entityType === 'person') &&
          (d.primaryClientId === entityId || d.recipientPartyId === entityId)
        ) {
          return true;
        }
        return false;
      })
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  public repointMergedEntity(
    ctx: TenantContext,
    entityType: 'organisation' | 'person',
    mergedId: string,
    survivorId: string,
  ): number {
    const db = this.getDb(ctx);
    let updatedCount = 0;

    for (const [docId, doc] of db.documents.entries()) {
      if (doc.tenantId !== ctx.tenantId) continue;
      let changed = false;
      const copy: GeneratedDocumentRecord = { ...doc };
      if (copy.primaryClientId === mergedId) {
        copy.primaryClientId = survivorId;
        changed = true;
      }
      if (copy.recipientPartyId === mergedId) {
        copy.recipientPartyId = survivorId;
        changed = true;
      }
      if (changed) {
        db.documents.set(docId, copy);
        updatedCount++;
      }
    }

    const toDelete: string[] = [];
    for (const [linkId, link] of db.links.entries()) {
      if (
        link.tenantId !== ctx.tenantId ||
        link.entityType !== entityType ||
        link.entityId !== mergedId
      ) {
        continue;
      }
      const duplicateExists = Array.from(db.links.values()).some(
        (other) =>
          other.id !== linkId &&
          other.tenantId === ctx.tenantId &&
          other.documentId === link.documentId &&
          other.entityType === entityType &&
          other.entityId === survivorId &&
          other.linkRole === link.linkRole,
      );
      if (duplicateExists) {
        toDelete.push(linkId);
      } else {
        db.links.set(linkId, {
          ...link,
          entityId: survivorId,
        });
        updatedCount++;
      }
    }
    for (const linkId of toDelete) {
      db.links.delete(linkId);
    }

    return updatedCount;
  }

  public snapshotTenantDocumentsAndLinks(ctx: TenantContext): {
    documents: GeneratedDocumentRecord[];
    links: DocumentLinkRecord[];
  } {
    const db = this.getDb(ctx);
    return {
      documents: Array.from(db.documents.values())
        .filter((d) => d.tenantId === ctx.tenantId)
        .map((d) => ({ ...d })),
      links: Array.from(db.links.values())
        .filter((l) => l.tenantId === ctx.tenantId)
        .map((l) => ({ ...l })),
    };
  }

  public restoreTenantDocumentsAndLinks(
    ctx: TenantContext,
    snapshot: {
      documents: GeneratedDocumentRecord[];
      links: DocumentLinkRecord[];
    },
  ): void {
    const db = this.getDb(ctx);
    for (const [docId, doc] of db.documents.entries()) {
      if (doc.tenantId === ctx.tenantId) {
        db.documents.delete(docId);
      }
    }
    for (const [linkId, link] of db.links.entries()) {
      if (link.tenantId === ctx.tenantId) {
        db.links.delete(linkId);
      }
    }
    for (const doc of snapshot.documents) {
      this.assertRecordTenant(ctx, doc.tenantId, 'GeneratedDocumentRecord');
      db.documents.set(doc.id, { ...doc });
    }
    for (const link of snapshot.links) {
      this.assertRecordTenant(ctx, link.tenantId, 'DocumentLinkRecord');
      db.links.set(link.id, { ...link });
    }
  }

  // ============================================================================
  // Template Usage Events & Daily Summaries
  // ============================================================================

  public putUsageEvent(
    ctx: TenantContext,
    event: TemplateUsageEventRecord,
  ): TemplateUsageEventRecord {
    this.assertRecordTenant(ctx, event.tenantId, 'TemplateUsageEventRecord');
    const db = this.getDb(ctx);
    const copy: TemplateUsageEventRecord = {
      ...event,
      missingFieldKeys: [...event.missingFieldKeys],
    };
    db.usageEvents.set(copy.id, copy);

    // Synchronously update daily summary rollup
    const bucketDate = copy.occurredAt.slice(0, 10);
    const practiceAreaKey = copy.practiceAreaId ?? '';
    const matterTypeKey = copy.matterTypeId ?? '';
    const teamKey = copy.teamId ?? '';
    const summaryCompositeKey = [
      ctx.tenantId,
      bucketDate,
      copy.templateId,
      copy.templateVersionId,
      practiceAreaKey,
      matterTypeKey,
      teamKey,
    ].join('::');

    const existingSummary = db.usageSummaries.get(summaryCompositeKey) ?? {
      tenantId: ctx.tenantId,
      bucketDate,
      templateId: copy.templateId,
      templateVersionId: copy.templateVersionId,
      practiceAreaId: practiceAreaKey,
      matterTypeId: matterTypeKey,
      teamId: teamKey,
      generatedCount: 0,
      previewedCount: 0,
      blockedMissingRequiredCount: 0,
      blockedPermissionCount: 0,
      lastGeneratedAt: null,
    };

    if (copy.eventType === 'generated') {
      existingSummary.generatedCount += 1;
      if (
        !existingSummary.lastGeneratedAt ||
        copy.occurredAt > existingSummary.lastGeneratedAt
      ) {
        existingSummary.lastGeneratedAt = copy.occurredAt;
      }
    } else if (copy.eventType === 'previewed') {
      existingSummary.previewedCount += 1;
    } else if (copy.eventType === 'blocked_missing_required') {
      existingSummary.blockedMissingRequiredCount += 1;
    } else if (copy.eventType === 'blocked_permission') {
      existingSummary.blockedPermissionCount += 1;
    }

    db.usageSummaries.set(summaryCompositeKey, existingSummary);
    return copy;
  }

  public listUsageEvents(ctx: TenantContext): TemplateUsageEventRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.usageEvents.values())
      .filter((e) => e.tenantId === ctx.tenantId)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  public listUsageSummaries(
    ctx: TenantContext,
  ): TemplateUsageDailySummaryRecord[] {
    const db = this.getDb(ctx);
    return Array.from(db.usageSummaries.values()).filter(
      (s) => s.tenantId === ctx.tenantId,
    );
  }

  public purgeUsageOlderThan(
    ctx: TenantContext,
    cutoffIso: string,
  ): { purgedEventsCount: number; purgedSummaryBucketsCount: number } {
    const db = this.getDb(ctx);
    const cutoffDate = cutoffIso.slice(0, 10);
    let purgedEventsCount = 0;
    let purgedSummaryBucketsCount = 0;

    for (const [id, ev] of db.usageEvents.entries()) {
      if (ev.tenantId === ctx.tenantId && ev.occurredAt < cutoffIso) {
        db.usageEvents.delete(id);
        purgedEventsCount += 1;
      }
    }

    for (const [key, sum] of db.usageSummaries.entries()) {
      if (sum.tenantId === ctx.tenantId && sum.bucketDate < cutoffDate) {
        db.usageSummaries.delete(key);
        purgedSummaryBucketsCount += 1;
      }
    }

    return { purgedEventsCount, purgedSummaryBucketsCount };
  }

  /**
   * Permanently deletes all templates, versions, generated documents, links, and usage data
   * for the specified tenant on offboarding.
   */
  public offboardTenantData(ctx: TenantContext): void {
    if (!ctx?.tenantId || !ctx?.postgresDatabaseName) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Offboarding requires a valid TenantContext.',
      );
    }
    this.databases.delete(ctx.postgresDatabaseName);
  }
}
