/**
 * Tenant-Scoped Document Generation PostgreSQL Repository (`core/src/tenancy/documentRepository.ts`).
 *
 * Rules enforced (ADR 0028 & Platform Architecture Standard §8, Owner Decisions 2 & 6, R401, R405):
 * 1. All reads and writes execute against the tenant's dedicated PostgreSQL database inside an explicit
 *    transaction starting with `SET LOCAL ROLE <tenant_role>` (`TenantScopedRepository`).
 * 2. Zero in-memory `Map` simulation; tampered record IDs belonging to another tenant return `null`
 *    or throw `TENANCY_ISOLATION_ERROR`.
 */

import type {
  DocumentGenerationConfig,
  DocumentLinkRecord,
  DocumentOutputFormat,
  DocumentTemplateRecord,
  DocumentTemplateVersionRecord,
  GenerationEngineId,
  GeneratedDocumentRecord,
  PromptedFieldDefinition,
  StorageProviderId,
  TemplateAvailabilityRules,
  TemplatePlaceholderMapping,
  TemplateUsageDailySummaryRecord,
  TemplateUsageEventRecord,
  TemplateUsageEventType,
  TenantContext,
} from '../api/index';
import {
  TenantScopedRepository,
  toIsoString,
  toNullableIsoString,
} from './tenantScopedRepository';

interface DbTemplateRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  output_document_type: string;
  filename_pattern: string;
  availability_rules: TemplateAvailabilityRules;
  active_version_id: string | null;
  status: DocumentTemplateRecord['status'];
  created_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DbTemplateVersionRow {
  id: string;
  tenant_id: string;
  template_id: string;
  version_number: number;
  engine: GenerationEngineId;
  status: DocumentTemplateVersionRecord['status'];
  storage_provider: StorageProviderId;
  blob_key: string;
  file_name: string;
  file_sha256: string;
  file_size_bytes: number;
  scan_status: DocumentTemplateVersionRecord['scanStatus'];
  extracted_placeholders: DocumentTemplateVersionRecord['extractedPlaceholders'];
  field_mappings: Record<string, TemplatePlaceholderMapping>;
  prompted_fields: PromptedFieldDefinition[];
  created_by_user_id: string;
  created_at: Date | string;
  submitted_by_user_id: string | null;
  submitted_at: Date | string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | string | null;
  rejection_reason: string | null;
  change_note: string | null;
}

interface DbDocumentRow {
  id: string;
  tenant_id: string;
  title: string;
  file_name: string;
  document_type: string;
  output_format: DocumentOutputFormat;
  mime_type: string;
  file_size_bytes: number;
  file_sha256: string;
  template_id: string;
  template_name: string;
  template_version_id: string;
  template_version_number: number;
  storage_provider: StorageProviderId;
  storage_key: string;
  external_id: string | null;
  external_version: string | null;
  generated_by_user_id: string;
  generated_by_name: string | null;
  generated_at: Date | string;
  primary_matter_id: string | null;
  primary_client_id: string | null;
  recipient_party_id: string | null;
  is_deleted: boolean;
  deleted_by_user_id: string | null;
  deleted_at: Date | string | null;
}

interface DbDocumentLinkRow {
  id: string;
  tenant_id: string;
  document_id: string;
  entity_type: DocumentLinkRecord['entityType'];
  entity_id: string;
  link_role: DocumentLinkRecord['linkRole'];
  created_at: Date | string;
}

interface DbUsageEventRow {
  id: string;
  tenant_id: string;
  template_id: string;
  template_version_id: string;
  version_number: number;
  event_type: TemplateUsageEventType;
  occurred_at: Date | string;
  actor_user_id: string;
  actor_role_key: string;
  team_id: string | null;
  practice_area_id: string | null;
  matter_type_id: string | null;
  source_entity_type: TemplateUsageEventRecord['sourceEntityType'];
  output_format: DocumentOutputFormat;
  missing_field_keys: string[];
  duration_ms: number;
  correlation_id: string;
}

interface DbUsageSummaryRow {
  tenant_id: string;
  bucket_date: string;
  template_id: string;
  template_version_id: string;
  practice_area_id: string;
  matter_type_id: string;
  team_id: string;
  generated_count: number;
  previewed_count: number;
  blocked_missing_required_count: number;
  blocked_permission_count: number;
  last_generated_at: Date | string | null;
}

function mapTemplateRow(row: DbTemplateRow): DocumentTemplateRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    category: row.category,
    tags: Array.isArray(row.tags) ? [...row.tags] : [],
    outputDocumentType: row.output_document_type,
    filenamePattern: row.filename_pattern,
    availabilityRules: {
      ...row.availability_rules,
      sourceContexts: [...(row.availability_rules?.sourceContexts ?? [])],
      ...(row.availability_rules?.practiceAreaKeys
        ? { practiceAreaKeys: [...row.availability_rules.practiceAreaKeys] }
        : {}),
      ...(row.availability_rules?.matterTypeKeys
        ? { matterTypeKeys: [...row.availability_rules.matterTypeKeys] }
        : {}),
      ...(row.availability_rules?.clientTypes
        ? { clientTypes: [...row.availability_rules.clientTypes] }
        : {}),
      ...(row.availability_rules?.allowedRoleKeys
        ? { allowedRoleKeys: [...row.availability_rules.allowedRoleKeys] }
        : {}),
    },
    activeVersionId: row.active_version_id,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapTemplateVersionRow(
  row: DbTemplateVersionRow,
): DocumentTemplateVersionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    templateId: row.template_id,
    versionNumber: Number(row.version_number),
    engine: row.engine,
    status: row.status,
    storageProvider: row.storage_provider,
    blobKey: row.blob_key,
    fileName: row.file_name,
    fileSha256: row.file_sha256,
    fileSizeBytes: Number(row.file_size_bytes),
    scanStatus: row.scan_status,
    extractedPlaceholders: Array.isArray(row.extracted_placeholders)
      ? row.extracted_placeholders.map((p) => ({
          ...p,
          locations: [...(p.locations ?? [])],
        }))
      : [],
    fieldMappings: { ...(row.field_mappings ?? {}) },
    promptedFields: Array.isArray(row.prompted_fields)
      ? row.prompted_fields.map((pf) => ({
          ...pf,
          ...(pf.options ? { options: [...pf.options] } : {}),
        }))
      : [],
    createdByUserId: row.created_by_user_id,
    createdAt: toIsoString(row.created_at),
    ...(row.submitted_by_user_id !== null
      ? { submittedByUserId: row.submitted_by_user_id }
      : {}),
    ...(row.submitted_at !== null
      ? { submittedAt: toIsoString(row.submitted_at) }
      : {}),
    ...(row.reviewed_by_user_id !== null
      ? { reviewedByUserId: row.reviewed_by_user_id }
      : {}),
    ...(row.reviewed_at !== null
      ? { reviewedAt: toIsoString(row.reviewed_at) }
      : {}),
    rejectionReason: row.rejection_reason,
    ...(row.change_note !== null ? { changeNote: row.change_note } : {}),
  };
}

function mapDocumentRow(row: DbDocumentRow): GeneratedDocumentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    fileName: row.file_name,
    documentType: row.document_type,
    outputFormat: row.output_format,
    mimeType: row.mime_type,
    fileSizeBytes: Number(row.file_size_bytes),
    fileSha256: row.file_sha256,
    templateId: row.template_id,
    templateName: row.template_name,
    templateVersionId: row.template_version_id,
    templateVersionNumber: Number(row.template_version_number),
    storageProvider: row.storage_provider,
    storageKey: row.storage_key,
    externalId: row.external_id,
    externalVersion: row.external_version,
    generatedByUserId: row.generated_by_user_id,
    generatedByName: row.generated_by_name ?? '',
    generatedAt: toIsoString(row.generated_at),
    primaryMatterId: row.primary_matter_id,
    primaryClientId: row.primary_client_id,
    recipientPartyId: row.recipient_party_id,
    isDeleted: Boolean(row.is_deleted),
    ...(row.deleted_by_user_id !== null
      ? { deletedByUserId: row.deleted_by_user_id }
      : {}),
    ...(row.deleted_at !== null
      ? { deletedAt: toIsoString(row.deleted_at) }
      : {}),
  };
}

function mapDocumentLinkRow(row: DbDocumentLinkRow): DocumentLinkRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    documentId: row.document_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    linkRole: row.link_role,
    createdAt: toIsoString(row.created_at),
  };
}

function mapUsageEventRow(row: DbUsageEventRow): TemplateUsageEventRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    versionNumber: Number(row.version_number),
    eventType: row.event_type,
    occurredAt: toIsoString(row.occurred_at),
    actorUserId: row.actor_user_id,
    actorRoleKey: row.actor_role_key,
    teamId: row.team_id,
    practiceAreaId: row.practice_area_id,
    matterTypeId: row.matter_type_id,
    sourceEntityType: row.source_entity_type,
    outputFormat: row.output_format,
    missingFieldKeys: Array.isArray(row.missing_field_keys)
      ? [...row.missing_field_keys]
      : [],
    durationMs: Number(row.duration_ms),
    correlationId: row.correlation_id,
  };
}

function mapUsageSummaryRow(
  row: DbUsageSummaryRow,
): TemplateUsageDailySummaryRecord {
  return {
    tenantId: row.tenant_id,
    bucketDate: String(row.bucket_date).slice(0, 10),
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    practiceAreaId: row.practice_area_id,
    matterTypeId: row.matter_type_id,
    teamId: row.team_id,
    generatedCount: Number(row.generated_count),
    previewedCount: Number(row.previewed_count),
    blockedMissingRequiredCount: Number(row.blocked_missing_required_count),
    blockedPermissionCount: Number(row.blocked_permission_count),
    lastGeneratedAt: toNullableIsoString(row.last_generated_at),
  };
}

export class TenantDocumentRepository extends TenantScopedRepository {
  // ============================================================================
  // Tenant Configuration Override (`document_generation_tenant_configs`, 0006)
  // ============================================================================

  public async getDocumentGenerationTenantConfig(
    ctx: TenantContext,
  ): Promise<Partial<DocumentGenerationConfig> | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        config_json: Partial<DocumentGenerationConfig>;
      }>(
        'SELECT tenant_id, config_json FROM document_generation_tenant_configs WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(
        ctx,
        row.tenant_id,
        'DocumentGenerationTenantConfig',
      );
      return structuredClone(row.config_json);
    });
  }

  public async putDocumentGenerationTenantConfig(
    ctx: TenantContext,
    config: Partial<DocumentGenerationConfig> | null,
    updatedById?: string,
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      if (config === null) {
        await tx.query(
          'DELETE FROM document_generation_tenant_configs WHERE tenant_id = $1',
          [ctx.tenantId],
        );
        return;
      }
      await tx.query(
        `INSERT INTO document_generation_tenant_configs (tenant_id, config_json, updated_by_id, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET
           config_json = EXCLUDED.config_json,
           updated_by_id = EXCLUDED.updated_by_id,
           updated_at = NOW()`,
        [ctx.tenantId, JSON.stringify(config), updatedById ?? ctx.actorId],
      );
    });
  }

  // ============================================================================
  // Templates
  // ============================================================================

  public async putTemplate(
    ctx: TenantContext,
    template: DocumentTemplateRecord,
  ): Promise<DocumentTemplateRecord> {
    this.assertRowTenant(ctx, template.tenantId, 'DocumentTemplateRecord');
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbTemplateRow>(
        `INSERT INTO document_templates (
           id, tenant_id, code, name, description, category, tags,
           output_document_type, filename_pattern, availability_rules,
           active_version_id, status, created_by_user_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO UPDATE SET
           code = EXCLUDED.code,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           category = EXCLUDED.category,
           tags = EXCLUDED.tags,
           output_document_type = EXCLUDED.output_document_type,
           filename_pattern = EXCLUDED.filename_pattern,
           availability_rules = EXCLUDED.availability_rules,
           active_version_id = EXCLUDED.active_version_id,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at
         WHERE document_templates.tenant_id = $2
         RETURNING *`,
        [
          template.id,
          ctx.tenantId,
          template.code,
          template.name,
          template.description ?? '',
          template.category ?? 'General',
          JSON.stringify(template.tags ?? []),
          template.outputDocumentType ?? 'letter',
          template.filenamePattern ??
            '{{matter.reference}} - {{template.name}}',
          JSON.stringify(template.availabilityRules),
          template.activeVersionId ?? null,
          template.status,
          template.createdByUserId,
          template.createdAt,
          template.updatedAt,
        ],
      );
      const saved = res.rows[0];
      if (!saved) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Cross-tenant template ID collision rejected.',
        );
      }
      this.assertRowTenant(ctx, saved.tenant_id, 'DocumentTemplateRecord');
      return mapTemplateRow(saved);
    });
  }

  public async getTemplateById(
    ctx: TenantContext,
    templateId: string,
  ): Promise<DocumentTemplateRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbTemplateRow>(
        'SELECT * FROM document_templates WHERE id = $1 AND tenant_id = $2',
        [templateId, ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'DocumentTemplateRecord');
      return mapTemplateRow(row);
    });
  }

  public async getTemplateByCode(
    ctx: TenantContext,
    code: string,
  ): Promise<DocumentTemplateRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbTemplateRow>(
        'SELECT * FROM document_templates WHERE tenant_id = $1 AND LOWER(code) = LOWER($2) LIMIT 1',
        [ctx.tenantId, code],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'DocumentTemplateRecord');
      return mapTemplateRow(row);
    });
  }

  public async listTemplates(
    ctx: TenantContext,
  ): Promise<DocumentTemplateRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbTemplateRow>(
        'SELECT * FROM document_templates WHERE tenant_id = $1 ORDER BY updated_at DESC',
        [ctx.tenantId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'DocumentTemplateRecord');
        return mapTemplateRow(r);
      });
    });
  }

  // ============================================================================
  // Template Versions
  // ============================================================================

  public async putTemplateVersion(
    ctx: TenantContext,
    version: DocumentTemplateVersionRecord,
  ): Promise<DocumentTemplateVersionRecord> {
    this.assertRowTenant(ctx, version.tenantId, 'DocumentTemplateVersionRecord');
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbTemplateVersionRow>(
        `INSERT INTO document_template_versions (
           id, tenant_id, template_id, version_number, engine, status,
           storage_provider, blob_key, file_name, file_sha256, file_size_bytes,
           scan_status, extracted_placeholders, field_mappings, prompted_fields,
           created_by_user_id, created_at, submitted_by_user_id, submitted_at,
           reviewed_by_user_id, reviewed_at, rejection_reason, change_note
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,
           $16,$17,$18,$19,$20,$21,$22,$23
         )
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           scan_status = EXCLUDED.scan_status,
           extracted_placeholders = EXCLUDED.extracted_placeholders,
           field_mappings = EXCLUDED.field_mappings,
           prompted_fields = EXCLUDED.prompted_fields,
           submitted_by_user_id = EXCLUDED.submitted_by_user_id,
           submitted_at = EXCLUDED.submitted_at,
           reviewed_by_user_id = EXCLUDED.reviewed_by_user_id,
           reviewed_at = EXCLUDED.reviewed_at,
           rejection_reason = EXCLUDED.rejection_reason,
           change_note = EXCLUDED.change_note
         WHERE document_template_versions.tenant_id = $2
         RETURNING *`,
        [
          version.id,
          ctx.tenantId,
          version.templateId,
          version.versionNumber,
          version.engine,
          version.status,
          version.storageProvider,
          version.blobKey,
          version.fileName,
          version.fileSha256,
          version.fileSizeBytes,
          version.scanStatus,
          JSON.stringify(version.extractedPlaceholders ?? []),
          JSON.stringify(version.fieldMappings ?? {}),
          JSON.stringify(version.promptedFields ?? []),
          version.createdByUserId,
          version.createdAt,
          version.submittedByUserId ?? null,
          version.submittedAt ?? null,
          version.reviewedByUserId ?? null,
          version.reviewedAt ?? null,
          version.rejectionReason ?? null,
          version.changeNote ?? null,
        ],
      );
      const saved = res.rows[0];
      if (!saved) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Cross-tenant template version ID collision rejected.',
        );
      }
      this.assertRowTenant(
        ctx,
        saved.tenant_id,
        'DocumentTemplateVersionRecord',
      );
      return mapTemplateVersionRow(saved);
    });
  }

  public async getTemplateVersionById(
    ctx: TenantContext,
    versionId: string,
  ): Promise<DocumentTemplateVersionRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbTemplateVersionRow>(
        'SELECT * FROM document_template_versions WHERE id = $1 AND tenant_id = $2',
        [versionId, ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'DocumentTemplateVersionRecord');
      return mapTemplateVersionRow(row);
    });
  }

  public async listVersionsForTemplate(
    ctx: TenantContext,
    templateId: string,
  ): Promise<DocumentTemplateVersionRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbTemplateVersionRow>(
        `SELECT * FROM document_template_versions
         WHERE tenant_id = $1 AND template_id = $2
         ORDER BY version_number DESC`,
        [ctx.tenantId, templateId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'DocumentTemplateVersionRecord');
        return mapTemplateVersionRow(r);
      });
    });
  }

  public async listAllTemplateVersions(
    ctx: TenantContext,
  ): Promise<DocumentTemplateVersionRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbTemplateVersionRow>(
        `SELECT * FROM document_template_versions
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [ctx.tenantId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'DocumentTemplateVersionRecord');
        return mapTemplateVersionRow(r);
      });
    });
  }

  // ============================================================================
  // Generated Documents & Links
  // ============================================================================

  public async putDocument(
    ctx: TenantContext,
    doc: GeneratedDocumentRecord,
  ): Promise<GeneratedDocumentRecord> {
    this.assertRowTenant(ctx, doc.tenantId, 'GeneratedDocumentRecord');
    const legacyShape = doc as GeneratedDocumentRecord & {
      sizeBytes?: number;
      sha256?: string;
      templateCode?: string;
      generatedById?: string;
      deletedById?: string | null;
    };
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbDocumentRow>(
        `INSERT INTO documents (
           id, tenant_id, title, file_name, document_type, output_format, mime_type,
           file_size_bytes, file_sha256, template_id, template_name, template_version_id,
           template_version_number, storage_provider, storage_key, external_id, external_version,
           generated_by_user_id, generated_by_name, generated_at, primary_matter_id,
           primary_client_id, recipient_party_id, is_deleted, deleted_by_user_id, deleted_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
         )
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           file_name = EXCLUDED.file_name,
           document_type = EXCLUDED.document_type,
           output_format = EXCLUDED.output_format,
           mime_type = EXCLUDED.mime_type,
           file_size_bytes = EXCLUDED.file_size_bytes,
           file_sha256 = EXCLUDED.file_sha256,
           storage_provider = EXCLUDED.storage_provider,
           storage_key = EXCLUDED.storage_key,
           external_id = EXCLUDED.external_id,
           external_version = EXCLUDED.external_version,
           primary_matter_id = EXCLUDED.primary_matter_id,
           primary_client_id = EXCLUDED.primary_client_id,
           recipient_party_id = EXCLUDED.recipient_party_id,
           is_deleted = EXCLUDED.is_deleted,
           deleted_by_user_id = EXCLUDED.deleted_by_user_id,
           deleted_at = EXCLUDED.deleted_at
         WHERE documents.tenant_id = $2
         RETURNING *`,
        [
          doc.id,
          ctx.tenantId,
          doc.title,
          doc.fileName,
          doc.documentType ?? 'letter',
          doc.outputFormat ?? 'docx',
          doc.mimeType,
          doc.fileSizeBytes ?? legacyShape.sizeBytes ?? 0,
          doc.fileSha256 ?? legacyShape.sha256 ?? '',
          doc.templateId ?? legacyShape.templateCode ?? 'TPL-LEGACY',
          doc.templateName ?? doc.title ?? 'Template',
          doc.templateVersionId ?? 'TPLV-LEGACY',
          doc.templateVersionNumber ?? 1,
          doc.storageProvider ?? 'local-fs',
          doc.storageKey,
          doc.externalId ?? null,
          doc.externalVersion ?? null,
          doc.generatedByUserId ?? legacyShape.generatedById ?? ctx.actorId,
          doc.generatedByName ?? ctx.actorName ?? '',
          doc.generatedAt,
          doc.primaryMatterId ?? null,
          doc.primaryClientId ?? null,
          doc.recipientPartyId ?? null,
          Boolean(doc.isDeleted),
          doc.deletedByUserId ?? legacyShape.deletedById ?? null,
          doc.deletedAt ?? null,
        ],
      );
      const saved = res.rows[0];
      if (!saved) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Cross-tenant document ID collision rejected.',
        );
      }
      this.assertRowTenant(ctx, saved.tenant_id, 'GeneratedDocumentRecord');
      return mapDocumentRow(saved);
    });
  }

  public async getDocumentById(
    ctx: TenantContext,
    documentId: string,
  ): Promise<GeneratedDocumentRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbDocumentRow>(
        'SELECT * FROM documents WHERE id = $1 AND tenant_id = $2',
        [documentId, ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'GeneratedDocumentRecord');
      return mapDocumentRow(row);
    });
  }

  public async listDocuments(
    ctx: TenantContext,
    options?: { includeDeleted?: boolean },
  ): Promise<GeneratedDocumentRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const sql = options?.includeDeleted
        ? 'SELECT * FROM documents WHERE tenant_id = $1 ORDER BY generated_at DESC'
        : 'SELECT * FROM documents WHERE tenant_id = $1 AND is_deleted = FALSE ORDER BY generated_at DESC';
      const res = await tx.query<DbDocumentRow>(sql, [ctx.tenantId]);
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'GeneratedDocumentRecord');
        return mapDocumentRow(r);
      });
    });
  }

  public async putDocumentLink(
    ctx: TenantContext,
    link: DocumentLinkRecord,
  ): Promise<DocumentLinkRecord> {
    this.assertRowTenant(ctx, link.tenantId, 'DocumentLinkRecord');
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbDocumentLinkRow>(
        `INSERT INTO document_links (
           id, tenant_id, document_id, entity_type, entity_id, link_role, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           entity_type = EXCLUDED.entity_type,
           entity_id = EXCLUDED.entity_id,
           link_role = EXCLUDED.link_role
         WHERE document_links.tenant_id = $2
         RETURNING *`,
        [
          link.id,
          ctx.tenantId,
          link.documentId,
          link.entityType,
          link.entityId,
          link.linkRole,
          link.createdAt,
        ],
      );
      const saved = res.rows[0];
      if (!saved) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Cross-tenant document link ID collision rejected.',
        );
      }
      this.assertRowTenant(ctx, saved.tenant_id, 'DocumentLinkRecord');
      return mapDocumentLinkRow(saved);
    });
  }

  public async listAllDocumentLinks(
    ctx: TenantContext,
  ): Promise<DocumentLinkRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbDocumentLinkRow>(
        'SELECT * FROM document_links WHERE tenant_id = $1 ORDER BY created_at ASC',
        [ctx.tenantId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'DocumentLinkRecord');
        return mapDocumentLinkRow(r);
      });
    });
  }

  public async listLinksForDocument(
    ctx: TenantContext,
    documentId: string,
  ): Promise<DocumentLinkRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbDocumentLinkRow>(
        'SELECT * FROM document_links WHERE tenant_id = $1 AND document_id = $2 ORDER BY created_at ASC',
        [ctx.tenantId, documentId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'DocumentLinkRecord');
        return mapDocumentLinkRow(r);
      });
    });
  }

  public async listDocumentsForEntity(
    ctx: TenantContext,
    entityType: 'matter' | 'organisation' | 'person',
    entityId: string,
  ): Promise<GeneratedDocumentRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbDocumentRow>(
        entityType === 'matter'
          ? `SELECT DISTINCT d.*
             FROM documents d
             LEFT JOIN document_links l
               ON l.document_id = d.id AND l.tenant_id = d.tenant_id
             WHERE d.tenant_id = $1
               AND d.is_deleted = FALSE
               AND (
                 d.primary_matter_id = $3
                 OR (l.entity_type = $2 AND l.entity_id = $3)
               )
             ORDER BY d.generated_at DESC`
          : `SELECT DISTINCT d.*
             FROM documents d
             LEFT JOIN document_links l
               ON l.document_id = d.id AND l.tenant_id = d.tenant_id
             WHERE d.tenant_id = $1
               AND d.is_deleted = FALSE
               AND (
                 d.primary_client_id = $3
                 OR d.recipient_party_id = $3
                 OR (l.entity_type = $2 AND l.entity_id = $3)
               )
             ORDER BY d.generated_at DESC`,
        [ctx.tenantId, entityType, entityId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'GeneratedDocumentRecord');
        return mapDocumentRow(r);
      });
    });
  }

  public async repointMergedEntityWithDelta(
    ctx: TenantContext,
    entityType: 'organisation' | 'person',
    mergedId: string,
    survivorId: string,
  ): Promise<{
    updatedCount: number;
    undoDelta: () => Promise<void>;
  }> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const affectedDocsRes = await tx.query<DbDocumentRow>(
        `SELECT * FROM documents
         WHERE tenant_id = $1
           AND (primary_client_id = $2 OR recipient_party_id = $2)
         FOR UPDATE`,
        [ctx.tenantId, mergedId],
      );
      const originalDocs = affectedDocsRes.rows.map((r) => ({
        id: r.id,
        primaryClientId: r.primary_client_id,
        recipientPartyId: r.recipient_party_id,
      }));

      let updatedCount = 0;
      for (const row of affectedDocsRes.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'GeneratedDocumentRecord');
        const nextPrimary =
          row.primary_client_id === mergedId
            ? survivorId
            : row.primary_client_id;
        const nextRecipient =
          row.recipient_party_id === mergedId
            ? survivorId
            : row.recipient_party_id;
        await tx.query(
          `UPDATE documents
           SET primary_client_id = $1, recipient_party_id = $2
           WHERE id = $3 AND tenant_id = $4`,
          [nextPrimary, nextRecipient, row.id, ctx.tenantId],
        );
        updatedCount += 1;
      }

      const affectedLinksRes = await tx.query<DbDocumentLinkRow>(
        `SELECT * FROM document_links
         WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3
         FOR UPDATE`,
        [ctx.tenantId, entityType, mergedId],
      );
      const originalLinks = affectedLinksRes.rows.map(mapDocumentLinkRow);
      const deletedLinks: DocumentLinkRecord[] = [];
      const repointedLinkIds: string[] = [];

      for (const link of originalLinks) {
        const dupCheck = await tx.query<{ id: string }>(
          `SELECT id FROM document_links
           WHERE tenant_id = $1
             AND id <> $2
             AND document_id = $3
             AND entity_type = $4
             AND entity_id = $5
             AND link_role = $6
           LIMIT 1`,
          [
            ctx.tenantId,
            link.id,
            link.documentId,
            entityType,
            survivorId,
            link.linkRole,
          ],
        );
        if (dupCheck.rows.length > 0) {
          await tx.query(
            'DELETE FROM document_links WHERE id = $1 AND tenant_id = $2',
            [link.id, ctx.tenantId],
          );
          deletedLinks.push(link);
        } else {
          await tx.query(
            `UPDATE document_links SET entity_id = $1 WHERE id = $2 AND tenant_id = $3`,
            [survivorId, link.id, ctx.tenantId],
          );
          repointedLinkIds.push(link.id);
          updatedCount += 1;
        }
      }

      const undoDelta = async () => {
        await this.withTenantTransaction(ctx, async (undoTx) => {
          for (const d of originalDocs) {
            await undoTx.query(
              `UPDATE documents
               SET primary_client_id = $1, recipient_party_id = $2
               WHERE id = $3 AND tenant_id = $4`,
              [d.primaryClientId, d.recipientPartyId, d.id, ctx.tenantId],
            );
          }
          for (const linkId of repointedLinkIds) {
            await undoTx.query(
              `UPDATE document_links SET entity_id = $1 WHERE id = $2 AND tenant_id = $3`,
              [mergedId, linkId, ctx.tenantId],
            );
          }
          for (const dl of deletedLinks) {
            await undoTx.query(
              `INSERT INTO document_links (id, tenant_id, document_id, entity_type, entity_id, link_role, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (id) DO NOTHING`,
              [
                dl.id,
                ctx.tenantId,
                dl.documentId,
                dl.entityType,
                dl.entityId,
                dl.linkRole,
                dl.createdAt,
              ],
            );
          }
        });
      };

      return { updatedCount, undoDelta };
    });
  }

  public async repointMergedEntity(
    ctx: TenantContext,
    entityType: 'organisation' | 'person',
    mergedId: string,
    survivorId: string,
  ): Promise<number> {
    const { updatedCount } = await this.repointMergedEntityWithDelta(
      ctx,
      entityType,
      mergedId,
      survivorId,
    );
    return updatedCount;
  }

  // ============================================================================
  // Template Usage Events & Daily Summaries
  // ============================================================================

  public async putUsageEvent(
    ctx: TenantContext,
    event: TemplateUsageEventRecord,
  ): Promise<TemplateUsageEventRecord> {
    this.assertRowTenant(ctx, event.tenantId, 'TemplateUsageEventRecord');
    return this.withTenantTransaction(ctx, async (tx) => {
      const inserted = await tx.query<DbUsageEventRow>(
        `INSERT INTO template_usage_events (
           id, tenant_id, template_id, template_version_id, version_number,
           event_type, occurred_at, actor_user_id, actor_role_key, team_id,
           practice_area_id, matter_type_id, source_entity_type, output_format,
           missing_field_keys, duration_ms, correlation_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17
         )
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [
          event.id,
          ctx.tenantId,
          event.templateId,
          event.templateVersionId,
          event.versionNumber,
          event.eventType,
          event.occurredAt,
          event.actorUserId,
          event.actorRoleKey,
          event.teamId ?? null,
          event.practiceAreaId ?? null,
          event.matterTypeId ?? null,
          event.sourceEntityType,
          event.outputFormat,
          JSON.stringify(event.missingFieldKeys ?? []),
          event.durationMs ?? 0,
          event.correlationId,
        ],
      );

      if (inserted.rows.length > 0) {
        const bucketDate = event.occurredAt.slice(0, 10);
        const practiceAreaKey = event.practiceAreaId ?? '';
        const matterTypeKey = event.matterTypeId ?? '';
        const teamKey = event.teamId ?? '';
        const genInc = event.eventType === 'generated' ? 1 : 0;
        const prevInc = event.eventType === 'previewed' ? 1 : 0;
        const missInc =
          event.eventType === 'blocked_missing_required' ? 1 : 0;
        const permInc = event.eventType === 'blocked_permission' ? 1 : 0;
        const lastGenAt =
          event.eventType === 'generated' ? event.occurredAt : null;

        await tx.query(
          `INSERT INTO template_usage_daily_summaries (
             tenant_id, bucket_date, template_id, template_version_id,
             practice_area_id, matter_type_id, team_id,
             generated_count, previewed_count,
             blocked_missing_required_count, blocked_permission_count,
             last_generated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (
             tenant_id, bucket_date, template_id, template_version_id,
             practice_area_id, matter_type_id, team_id
           ) DO UPDATE SET
             generated_count = template_usage_daily_summaries.generated_count + EXCLUDED.generated_count,
             previewed_count = template_usage_daily_summaries.previewed_count + EXCLUDED.previewed_count,
             blocked_missing_required_count = template_usage_daily_summaries.blocked_missing_required_count + EXCLUDED.blocked_missing_required_count,
             blocked_permission_count = template_usage_daily_summaries.blocked_permission_count + EXCLUDED.blocked_permission_count,
             last_generated_at = CASE
               WHEN EXCLUDED.last_generated_at IS NULL THEN template_usage_daily_summaries.last_generated_at
               WHEN template_usage_daily_summaries.last_generated_at IS NULL THEN EXCLUDED.last_generated_at
               ELSE GREATEST(template_usage_daily_summaries.last_generated_at, EXCLUDED.last_generated_at)
             END`,
          [
            ctx.tenantId,
            bucketDate,
            event.templateId,
            event.templateVersionId,
            practiceAreaKey,
            matterTypeKey,
            teamKey,
            genInc,
            prevInc,
            missInc,
            permInc,
            lastGenAt,
          ],
        );
        return mapUsageEventRow(inserted.rows[0]!);
      }

      const existing = await tx.query<DbUsageEventRow>(
        'SELECT * FROM template_usage_events WHERE id = $1 AND tenant_id = $2',
        [event.id, ctx.tenantId],
      );
      if (!existing.rows[0]) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Cross-tenant usage event ID collision rejected.',
        );
      }
      return mapUsageEventRow(existing.rows[0]);
    });
  }

  public async listUsageEvents(
    ctx: TenantContext,
  ): Promise<TemplateUsageEventRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbUsageEventRow>(
        `SELECT * FROM template_usage_events
         WHERE tenant_id = $1
         ORDER BY occurred_at DESC`,
        [ctx.tenantId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'TemplateUsageEventRecord');
        return mapUsageEventRow(r);
      });
    });
  }

  public async listUsageSummaries(
    ctx: TenantContext,
  ): Promise<TemplateUsageDailySummaryRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbUsageSummaryRow>(
        `SELECT * FROM template_usage_daily_summaries
         WHERE tenant_id = $1
         ORDER BY bucket_date DESC`,
        [ctx.tenantId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(
          ctx,
          r.tenant_id,
          'TemplateUsageDailySummaryRecord',
        );
        return mapUsageSummaryRow(r);
      });
    });
  }

  public async purgeUsageOlderThan(
    ctx: TenantContext,
    cutoffIso: string,
  ): Promise<{ purgedEventsCount: number; purgedSummaryBucketsCount: number }> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const cutoffDate = cutoffIso.slice(0, 10);
      const evDel = await tx.query(
        'DELETE FROM template_usage_events WHERE tenant_id = $1 AND occurred_at < $2',
        [ctx.tenantId, cutoffIso],
      );
      const sumDel = await tx.query(
        'DELETE FROM template_usage_daily_summaries WHERE tenant_id = $1 AND bucket_date < $2::date',
        [ctx.tenantId, cutoffDate],
      );
      return {
        purgedEventsCount: evDel.rowCount,
        purgedSummaryBucketsCount: sumDel.rowCount,
      };
    });
  }

  public async offboardTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        'DELETE FROM template_usage_daily_summaries WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query('DELETE FROM template_usage_events WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query('DELETE FROM document_links WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query('DELETE FROM documents WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query(
        'DELETE FROM document_template_versions WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query('DELETE FROM document_templates WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query(
        'DELETE FROM document_generation_tenant_configs WHERE tenant_id = $1',
        [ctx.tenantId],
      );
    });
  }
}
