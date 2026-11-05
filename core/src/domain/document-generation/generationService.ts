/**
 * Document Generation & Preview Orchestration Service
 * (`core/src/domain/document-generation/generationService.ts`).
 *
 * Rules enforced (Standard Section 8, 14 & Functional Scope):
 * 1. Generation requires `document:generate` (and `finance:view` if the template uses Financial merge fields).
 * 2. Enforces record-level access (`canActorAccessMatterRecord`) before previewing or generating.
 * 3. Evaluates template availability rules (`sourceContexts`, `practiceAreaKeys`, `matterTypeKeys`,
 *    `clientTypes`, `allowedRoleKeys`).
 * 4. Blocks generation if any required field is empty, returning the exact missing field keys and
 *    recording a `'blocked_missing_required'` usage event (with field keys only, never values).
 * 5. Renders `.docx` via `DocumentGenerationEngine` and converts to `.pdf` via `DocumentPdfConverter`
 *    when `outputFormat === 'pdf'`.
 * 6. Saves the generated document in the tenant's storage container, links it to both the source
 *    Matter and primary Client (plus recipient party), and returns a short-lived scoped download token.
 */

import crypto from 'node:crypto';
import type {
  DocumentGenerationEngine,
  DocumentLinkRecord,
  DocumentOutputFormat,
  DocumentPdfConverter,
  DocumentStorageProvider,
  DocumentTemplateRecord,
  DocumentTemplateVersionRecord,
  FieldCatalogueEntry,
  FieldResolutionContext,
  GeneratedDocumentRecord,
  ScopedDownloadToken,
  TenantConfiguration,
  TenantContext,
} from '../../api/index';
import type { TenantDocumentRepository } from '../../tenancy/documentRepository';
import { resolveCatalogueValues } from './fieldCatalogue';
import { BuiltInOpenXmlPdfConverter } from './pdfConverter';
import {
  canActorAccessGeneratedDocument,
  canActorAccessMatterRecord,
  hasDocumentPermission,
  normaliseActorHomeRoles,
  type DocumentPermissionActor,
  type DocumentRbacConfigInput,
  type MatterAccessSubject,
} from './permissions';
import { recordTemplateUsageEvent } from './usageService';

export function isTemplateAvailableInContext(params: {
  template: DocumentTemplateRecord;
  version?: DocumentTemplateVersionRecord | null;
  actor: DocumentPermissionActor;
  config?: DocumentRbacConfigInput;
  sourceEntityType: 'matter' | 'client';
  practiceAreaKey?: string | null;
  matterTypeKey?: string | null;
  clientType?: 'Organisation' | 'Person' | null;
}): { available: boolean; reason?: string } {
  const {
    template,
    version,
    actor,
    config,
    sourceEntityType,
    practiceAreaKey,
    matterTypeKey,
    clientType,
  } = params;

  if (template.status !== 'Active' || !template.activeVersionId) {
    return { available: false, reason: 'Template is not currently Active.' };
  }

  const rules = template.availabilityRules;
  if (
    rules.sourceContexts?.length &&
    !rules.sourceContexts.includes(sourceEntityType)
  ) {
    return {
      available: false,
      reason: `Template is not available on ${sourceEntityType} records.`,
    };
  }

  if (
    sourceEntityType === 'matter' &&
    rules.practiceAreaKeys?.length &&
    practiceAreaKey &&
    !rules.practiceAreaKeys.includes(practiceAreaKey)
  ) {
    return {
      available: false,
      reason: 'Template is restricted to specific practice areas.',
    };
  }

  if (
    sourceEntityType === 'matter' &&
    rules.matterTypeKeys?.length &&
    matterTypeKey &&
    !rules.matterTypeKeys.includes(matterTypeKey)
  ) {
    return {
      available: false,
      reason: 'Template is restricted to specific matter types.',
    };
  }

  if (
    rules.clientTypes?.length &&
    clientType &&
    !rules.clientTypes.includes(clientType)
  ) {
    return {
      available: false,
      reason: `Template is restricted to ${rules.clientTypes.join('/')} clients.`,
    };
  }

  const actorRoles = new Set(normaliseActorHomeRoles(actor, config));
  if (rules.allowedRoleKeys?.length) {
    const hasRole = rules.allowedRoleKeys.some((r) => actorRoles.has(r));
    if (!hasRole) {
      return {
        available: false,
        reason: 'Actor role is not in the template’s allowed roles.',
      };
    }
  }

  if (version) {
    const usesFinancialField = Object.values(version.fieldMappings).some(
      (m) =>
        m.sourceType === 'catalogue' &&
        m.catalogueKey?.startsWith('financial.'),
    );
    if (
      usesFinancialField &&
      !hasDocumentPermission(actor, 'finance:view', config)
    ) {
      return {
        available: false,
        reason:
          'Template includes financial fields requiring "finance:view" permission.',
      };
    }
  }

  return { available: true };
}

export function renderFilenameFromPattern(
  pattern: string,
  templateName: string,
  resolvedValues: Record<string, unknown>,
  outputFormat: DocumentOutputFormat,
): string {
  const basePattern = pattern?.trim() || '{{matter.reference}} - {{template.name}}';
  const substituted = basePattern.replace(
    /\{\{\s*([^}]+?)\s*\}\}/g,
    (_m, rawKey: string) => {
      const key = rawKey.trim();
      if (key === 'template.name') return templateName;
      const val = resolvedValues[key];
      return val !== undefined && val !== null && String(val).trim() !== ''
        ? String(val).trim()
        : '';
    },
  );

  const cleaned = substituted
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s-]+|[\s-]+$/g, '');

  const stem = cleaned || templateName.replace(/[^a-zA-Z0-9_-]/g, '-');
  const ext = outputFormat === 'pdf' ? '.pdf' : '.docx';
  return stem.toLowerCase().endsWith(ext) ? stem : `${stem}${ext}`;
}

export async function previewTemplateVersion(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  storage: DocumentStorageProvider;
  engine: DocumentGenerationEngine;
  pdfConverter?: DocumentPdfConverter;
  catalogue: readonly FieldCatalogueEntry[];
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  versionId: string;
  resolutionContext: FieldResolutionContext;
  matterAccessSubject?: MatterAccessSubject | null;
  outputFormat?: DocumentOutputFormat;
}): Promise<{
  outputBytes: Uint8Array;
  fileName: string;
  mimeType: string;
  missingRequiredFields: string[];
}> {
  const {
    ctx,
    repo,
    storage,
    engine,
    catalogue,
    actor,
    config,
    versionId,
    resolutionContext,
  } = params;

  const canPreview =
    hasDocumentPermission(actor, 'document_template:build', config) ||
    hasDocumentPermission(actor, 'document_template:approve', config) ||
    hasDocumentPermission(actor, 'document:generate', config);
  if (!canPreview) {
    throw new Error(
      'DOCUMENT_PERMISSION_DENIED: Actor is not permitted to preview templates.',
    );
  }

  if (
    params.matterAccessSubject &&
    !canActorAccessMatterRecord(actor, params.matterAccessSubject, config)
  ) {
    throw new Error(
      'DOCUMENT_RECORD_ACCESS_DENIED: Actor is not authorised to access the selected matter record.',
    );
  }

  const version = repo.getTemplateVersionById(ctx, versionId);
  if (!version) {
    throw new Error('TEMPLATE_VERSION_NOT_FOUND: Template version not found.');
  }

  if (version.scanStatus !== 'clean') {
    throw new Error(
      `TEMPLATE_MALWARE_GATE: Cannot preview template with scan status "${version.scanStatus}".`,
    );
  }

  const template = repo.getTemplateById(ctx, version.templateId);
  if (!template) {
    throw new Error('TEMPLATE_NOT_FOUND: Template not found.');
  }

  const startMs = Date.now();
  const docxBytes = await storage.getObjectBytes(ctx, {
    blobKey: version.blobKey,
  });

  const { values: resolvedValues } = resolveCatalogueValues(
    resolutionContext,
    catalogue,
    actor,
    config,
  );

  const rendered = await engine.render({
    docxBytes,
    resolvedValues,
    mappings: version.fieldMappings,
  });

  const format: DocumentOutputFormat =
    params.outputFormat ?? config.documentGeneration.defaultOutputFormat;

  recordTemplateUsageEvent(ctx, repo, {
    templateId: template.id,
    templateVersionId: version.id,
    versionNumber: version.versionNumber,
    eventType: 'previewed',
    actor,
    sourceEntityType: 'template_builder',
    outputFormat: format,
    missingFieldKeys: rendered.missingRequiredFields,
    durationMs: Date.now() - startMs,
  });

  if (rendered.missingRequiredFields.length > 0) {
    return {
      outputBytes: new Uint8Array(0),
      fileName: '',
      mimeType: '',
      missingRequiredFields: rendered.missingRequiredFields,
    };
  }

  const fileName = renderFilenameFromPattern(
    template.filenamePattern,
    template.name,
    resolvedValues,
    format,
  );

  if (format === 'pdf') {
    const converter = params.pdfConverter ?? new BuiltInOpenXmlPdfConverter();
    const pdfBytes = await converter.convertDocxToPdf({
      docxBytes: rendered.outputBytes,
      title: template.name,
      authorName: ctx.actorName,
    });
    return {
      outputBytes: pdfBytes,
      fileName,
      mimeType: 'application/pdf',
      missingRequiredFields: [],
    };
  }

  return {
    outputBytes: rendered.outputBytes,
    fileName,
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    missingRequiredFields: [],
  };
}

export async function generateDocumentFromTemplate(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  storage: DocumentStorageProvider;
  engine: DocumentGenerationEngine;
  pdfConverter?: DocumentPdfConverter;
  catalogue: readonly FieldCatalogueEntry[];
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  templateId: string;
  sourceEntityType: 'matter' | 'client';
  matterAccessSubject?: MatterAccessSubject | null;
  primaryClientId?: string | null;
  primaryClientEntityType?: 'organisation' | 'person' | null;
  recipientPartyId?: string | null;
  recipientPartyEntityType?: 'organisation' | 'person' | null;
  practiceAreaId?: string | null;
  matterTypeId?: string | null;
  teamId?: string | null;
  outputFormat?: DocumentOutputFormat;
  resolutionContext: FieldResolutionContext;
}): Promise<{
  status: 'generated' | 'blocked_missing_required';
  document?: GeneratedDocumentRecord;
  links?: DocumentLinkRecord[];
  downloadToken?: ScopedDownloadToken;
  outputBytes?: Uint8Array;
  missingRequiredFields: string[];
}> {
  const {
    ctx,
    repo,
    storage,
    engine,
    catalogue,
    actor,
    config,
    templateId,
    sourceEntityType,
    matterAccessSubject,
    resolutionContext,
  } = params;

  if (!config.documentGeneration.enabled) {
    throw new Error(
      'DOCUMENT_GENERATION_DISABLED: Document generation is disabled for this tenant.',
    );
  }

  if (!hasDocumentPermission(actor, 'document:generate', config)) {
    throw new Error(
      'DOCUMENT_PERMISSION_DENIED: Actor lacks required permission "document:generate".',
    );
  }

  if (
    matterAccessSubject &&
    !canActorAccessMatterRecord(actor, matterAccessSubject, config)
  ) {
    throw new Error(
      'DOCUMENT_RECORD_ACCESS_DENIED: Actor is not authorised to access or generate documents from this restricted matter.',
    );
  }

  const template = repo.getTemplateById(ctx, templateId);
  if (!template || !template.activeVersionId) {
    throw new Error(
      'TEMPLATE_NOT_ACTIVE: Selected template is not found or does not have an Active approved version.',
    );
  }

  const version = repo.getTemplateVersionById(ctx, template.activeVersionId);
  if (!version || version.status !== 'Active') {
    throw new Error(
      'TEMPLATE_VERSION_NOT_ACTIVE: Active version for template was not found.',
    );
  }

  if (version.scanStatus !== 'clean') {
    throw new Error(
      `TEMPLATE_MALWARE_GATE: Template version scan status is "${version.scanStatus}".`,
    );
  }

  const format: DocumentOutputFormat =
    params.outputFormat && config.documentGeneration.allowUserFormatOverride
      ? params.outputFormat
      : config.documentGeneration.defaultOutputFormat;

  const availability = isTemplateAvailableInContext({
    template,
    version,
    actor,
    config,
    sourceEntityType,
    practiceAreaKey: params.practiceAreaId,
    matterTypeKey: params.matterTypeId,
    clientType:
      params.primaryClientEntityType === 'organisation'
        ? 'Organisation'
        : params.primaryClientEntityType === 'person'
          ? 'Person'
          : null,
  });

  if (!availability.available) {
    recordTemplateUsageEvent(ctx, repo, {
      templateId: template.id,
      templateVersionId: version.id,
      versionNumber: version.versionNumber,
      eventType: 'blocked_permission',
      actor,
      teamId: params.teamId,
      practiceAreaId: params.practiceAreaId,
      matterTypeId: params.matterTypeId,
      sourceEntityType,
      outputFormat: format,
    });
    throw new Error(
      `TEMPLATE_NOT_AVAILABLE_IN_CONTEXT: ${availability.reason}`,
    );
  }

  const startMs = Date.now();
  const { values: resolvedValues } = resolveCatalogueValues(
    resolutionContext,
    catalogue,
    actor,
    config,
  );

  // Check required prompted fields before rendering
  const missingPrompted: string[] = [];
  for (const pf of version.promptedFields) {
    if (!pf.required) continue;
    const val =
      resolutionContext.promptedValues?.[pf.key] ??
      resolvedValues[`prompted.${pf.key}`];
    if (
      val === undefined ||
      val === null ||
      (typeof val === 'string' && val.trim() === '')
    ) {
      missingPrompted.push(`prompted.${pf.key}`);
    }
  }

  const templateDocxBytes = await storage.getObjectBytes(ctx, {
    blobKey: version.blobKey,
  });

  const rendered = await engine.render({
    docxBytes: templateDocxBytes,
    resolvedValues,
    mappings: version.fieldMappings,
  });

  const allMissingRequired = Array.from(
    new Set([...missingPrompted, ...rendered.missingRequiredFields]),
  );

  if (allMissingRequired.length > 0) {
    recordTemplateUsageEvent(ctx, repo, {
      templateId: template.id,
      templateVersionId: version.id,
      versionNumber: version.versionNumber,
      eventType: 'blocked_missing_required',
      actor,
      teamId: params.teamId,
      practiceAreaId: params.practiceAreaId,
      matterTypeId: params.matterTypeId,
      sourceEntityType,
      outputFormat: format,
      missingFieldKeys: allMissingRequired,
      durationMs: Date.now() - startMs,
    });

    return {
      status: 'blocked_missing_required',
      missingRequiredFields: allMissingRequired,
    };
  }

  const fileName = renderFilenameFromPattern(
    template.filenamePattern,
    template.name,
    resolvedValues,
    format,
  );

  let finalBytes = rendered.outputBytes;
  let mimeType =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  if (format === 'pdf') {
    const converter = params.pdfConverter ?? new BuiltInOpenXmlPdfConverter();
    finalBytes = await converter.convertDocxToPdf({
      docxBytes: rendered.outputBytes,
      title: template.name,
      authorName: ctx.actorName,
    });
    mimeType = 'application/pdf';
  }

  const documentId = `DOC-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const storedBlob = await storage.putObject(ctx, {
    category: 'documents',
    objectId: documentId,
    fileName,
    contentType: mimeType,
    bytes: finalBytes,
  });

  const nowIso = new Date().toISOString();
  const sha256 = crypto.createHash('sha256').update(finalBytes).digest('hex');

  const docRecord: GeneratedDocumentRecord = {
    id: documentId,
    tenantId: ctx.tenantId,
    title: fileName.replace(/\.(docx|pdf)$/i, ''),
    fileName,
    documentType: template.outputDocumentType,
    outputFormat: format,
    mimeType,
    fileSizeBytes: finalBytes.length,
    fileSha256: sha256,
    templateId: template.id,
    templateName: template.name,
    templateVersionId: version.id,
    templateVersionNumber: version.versionNumber,
    storageProvider: storedBlob.storageProvider,
    storageKey: storedBlob.blobKey,
    externalId: storedBlob.externalId ?? null,
    externalVersion: storedBlob.externalVersion ?? null,
    generatedByUserId: actor.id,
    generatedByName: ctx.actorName,
    generatedAt: nowIso,
    primaryMatterId: matterAccessSubject?.id ?? null,
    primaryClientId:
      params.primaryClientId ?? matterAccessSubject?.clientId ?? null,
    recipientPartyId: params.recipientPartyId ?? null,
    isDeleted: false,
  };

  repo.putDocument(ctx, docRecord);

  const links: DocumentLinkRecord[] = [];
  if (docRecord.primaryMatterId) {
    links.push(
      repo.putDocumentLink(ctx, {
        id: `${documentId}-LNK-MAT`,
        tenantId: ctx.tenantId,
        documentId,
        entityType: 'matter',
        entityId: docRecord.primaryMatterId,
        linkRole: 'source_matter',
        createdAt: nowIso,
      }),
    );
  }

  if (docRecord.primaryClientId && params.primaryClientEntityType) {
    links.push(
      repo.putDocumentLink(ctx, {
        id: `${documentId}-LNK-CLI`,
        tenantId: ctx.tenantId,
        documentId,
        entityType: params.primaryClientEntityType,
        entityId: docRecord.primaryClientId,
        linkRole: 'primary_client',
        createdAt: nowIso,
      }),
    );
  }

  if (
    params.recipientPartyId &&
    params.recipientPartyEntityType &&
    params.recipientPartyId !== docRecord.primaryClientId
  ) {
    links.push(
      repo.putDocumentLink(ctx, {
        id: `${documentId}-LNK-PTY`,
        tenantId: ctx.tenantId,
        documentId,
        entityType: params.recipientPartyEntityType,
        entityId: params.recipientPartyId,
        linkRole: 'recipient_party',
        createdAt: nowIso,
      }),
    );
  }

  recordTemplateUsageEvent(ctx, repo, {
    templateId: template.id,
    templateVersionId: version.id,
    versionNumber: version.versionNumber,
    eventType: 'generated',
    actor,
    teamId: params.teamId,
    practiceAreaId: params.practiceAreaId,
    matterTypeId: params.matterTypeId,
    sourceEntityType,
    outputFormat: format,
    durationMs: Date.now() - startMs,
    occurredAt: nowIso,
  });

  const downloadToken = await storage.issueScopedDownloadToken(ctx, {
    blobKey: storedBlob.blobKey,
    fileName,
    documentId,
  });

  return {
    status: 'generated',
    document: docRecord,
    links,
    downloadToken,
    outputBytes: finalBytes,
    missingRequiredFields: [],
  };
}

/**
 * Lists generated documents for a Matter or Client (`organisation` | `person`) screen,
 * enforcing both `document:view` and restricted staff matter inheritance (`canActorAccessGeneratedDocument`).
 */
export function listAccessibleDocumentsForEntity(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  entityType: 'matter' | 'organisation' | 'person';
  entityId: string;
  resolveMatterSubject: (matterId: string) => MatterAccessSubject | null | undefined;
}): GeneratedDocumentRecord[] {
  const {
    ctx,
    repo,
    actor,
    config,
    entityType,
    entityId,
    resolveMatterSubject,
  } = params;

  if (!hasDocumentPermission(actor, 'document:view', config)) {
    return [];
  }

  if (entityType === 'matter') {
    const matterSubj = resolveMatterSubject(entityId);
    if (!matterSubj || !canActorAccessMatterRecord(actor, matterSubj, config)) {
      return [];
    }
  }

  const rawDocs = repo.listDocumentsForEntity(ctx, entityType, entityId);
  return rawDocs.filter((doc) => {
    const linkedMatters: MatterAccessSubject[] = [];
    if (doc.primaryMatterId) {
      const m = resolveMatterSubject(doc.primaryMatterId);
      if (m) linkedMatters.push(m);
    }
    for (const link of repo.listLinksForDocument(ctx, doc.id)) {
      if (link.entityType === 'matter') {
        const m = resolveMatterSubject(link.entityId);
        if (m && !linkedMatters.some((x) => x.id === m.id)) {
          linkedMatters.push(m);
        }
      }
    }
    return canActorAccessGeneratedDocument(actor, doc, linkedMatters, config);
  });
}

/**
 * Soft-deletes a generated document and removes its binary from storage,
 * requiring `document:delete` and record-level access to any linked matter.
 */
export async function deleteGeneratedDocument(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  storage: DocumentStorageProvider;
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  documentId: string;
  resolveMatterSubject: (matterId: string) => MatterAccessSubject | null | undefined;
}): Promise<GeneratedDocumentRecord> {
  const {
    ctx,
    repo,
    storage,
    actor,
    config,
    documentId,
    resolveMatterSubject,
  } = params;

  if (!hasDocumentPermission(actor, 'document:delete', config)) {
    throw new Error(
      'DOCUMENT_PERMISSION_DENIED: Deleting generated documents requires "document:delete".',
    );
  }

  const doc = repo.getDocumentById(ctx, documentId);
  if (!doc || doc.isDeleted) {
    throw new Error('DOCUMENT_NOT_FOUND: Document not found.');
  }

  if (doc.primaryMatterId) {
    const m = resolveMatterSubject(doc.primaryMatterId);
    if (m && !canActorAccessMatterRecord(actor, m, config)) {
      throw new Error(
        'DOCUMENT_RECORD_ACCESS_DENIED: Actor cannot delete a document linked to a restricted matter they cannot access.',
      );
    }
  }

  await storage.deleteObject(ctx, { blobKey: doc.storageKey });

  const deleted: GeneratedDocumentRecord = {
    ...doc,
    isDeleted: true,
    deletedByUserId: actor.id,
    deletedAt: new Date().toISOString(),
  };

  return repo.putDocument(ctx, deleted);
}
