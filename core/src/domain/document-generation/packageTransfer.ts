/**
 * Template Package Export & Import (`core/src/domain/document-generation/packageTransfer.ts`).
 *
 * Rules enforced (ADR-0002 & Functional Scope):
 * 1. Allows template builders (`document_template:build`) to export a portable Template Package
 *    (`.docx` binary + metadata + field mappings + prompted fields) to move templates between
 *    non-production and production tenants.
 * 2. Imported packages ALWAYS arrive in the target tenant as a `Draft`, validate all mapped
 *    catalogue fields against the target tenant's Field Catalogue, scan the `.docx` binary,
 *    and require approval in the target tenant before becoming `Active`.
 */

import type {
  DocumentGenerationEngine,
  DocumentStorageProvider,
  DocumentTemplateRecord,
  DocumentTemplateVersionRecord,
  FieldCatalogueEntry,
  TemplatePackageManifest,
  TenantConfiguration,
  TenantContext,
} from '../../api/index';
import type { TenantDocumentRepository } from '../../tenancy/documentRepository';
import { createOrUploadDraftTemplateVersion } from './approvalWorkflow';
import {
  hasDocumentPermission,
  type DocumentPermissionActor,
} from './permissions';

export async function exportTemplatePackage(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  storage: DocumentStorageProvider;
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  templateId: string;
  versionId?: string;
}): Promise<TemplatePackageManifest> {
  const { ctx, repo, storage, actor, config, templateId, versionId } = params;

  if (!hasDocumentPermission(actor, 'document_template:build', config)) {
    throw new Error(
      'DOCUMENT_PERMISSION_DENIED: Exporting a template package requires "document_template:build".',
    );
  }

  const template = await repo.getTemplateById(ctx, templateId);
  if (!template) {
    throw new Error('TEMPLATE_NOT_FOUND: Template not found.');
  }

  const resolvedVersionId =
    versionId ??
    template.activeVersionId ??
    (await repo.listVersionsForTemplate(ctx, template.id))[0]?.id;
  if (!resolvedVersionId) {
    throw new Error(
      'TEMPLATE_VERSION_NOT_FOUND: No template version available to export.',
    );
  }

  const version = await repo.getTemplateVersionById(ctx, resolvedVersionId);
  if (!version) {
    throw new Error('TEMPLATE_VERSION_NOT_FOUND: Template version not found.');
  }

  const docxBytes = await storage.getObjectBytes(ctx, {
    blobKey: version.blobKey,
  });

  return {
    packageFormatVersion: '1.0',
    exportedAt: new Date().toISOString(),
    template: {
      code: template.code,
      name: template.name,
      description: template.description,
      category: template.category,
      tags: [...template.tags],
      outputDocumentType: template.outputDocumentType,
      filenamePattern: template.filenamePattern,
      availabilityRules: { ...template.availabilityRules },
    },
    version: {
      engine: version.engine,
      fileName: version.fileName,
      fileSha256: version.fileSha256,
      docxBase64: Buffer.from(docxBytes).toString('base64'),
      fieldMappings: { ...version.fieldMappings },
      promptedFields: [...version.promptedFields],
      changeNote: version.changeNote ?? undefined,
    },
  };
}

export async function importTemplatePackage(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  storage: DocumentStorageProvider;
  engine: DocumentGenerationEngine;
  catalogue: readonly FieldCatalogueEntry[];
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  pkg: TemplatePackageManifest;
}): Promise<{
  template: DocumentTemplateRecord;
  version: DocumentTemplateVersionRecord;
  unmappedPlaceholders: string[];
  validationWarnings: string[];
}> {
  const { ctx, repo, storage, engine, catalogue, actor, config, pkg } = params;

  if (!hasDocumentPermission(actor, 'document_template:build', config)) {
    throw new Error(
      'DOCUMENT_PERMISSION_DENIED: Importing a template package requires "document_template:build".',
    );
  }

  if (pkg?.packageFormatVersion !== '1.0' || !pkg.version?.docxBase64) {
    throw new Error(
      'TEMPLATE_PACKAGE_INVALID: Invalid or unsupported template package manifest.',
    );
  }

  const catalogueKeys = new Set(catalogue.map((c) => c.key));
  const validationWarnings: string[] = [];
  const sanitizedMappings = { ...pkg.version.fieldMappings };

  // Validate every mapped catalogue key against the target tenant's Field Catalogue
  for (const [ph, mapping] of Object.entries(sanitizedMappings)) {
    if (
      mapping.sourceType === 'catalogue' &&
      mapping.catalogueKey &&
      !catalogueKeys.has(mapping.catalogueKey)
    ) {
      validationWarnings.push(
        `Placeholder "${ph}" was mapped to "${mapping.catalogueKey}", which does not exist in this tenant's Field Catalogue and must be remapped before submission.`,
      );
      delete sanitizedMappings[ph];
    }
  }

  const docxBuf = Buffer.from(pkg.version.docxBase64, 'base64');
  const docxBytes = new Uint8Array(
    docxBuf.buffer,
    docxBuf.byteOffset,
    docxBuf.byteLength,
  );

  // Imported packages always enter the target tenant as a `Draft`
  const created = await createOrUploadDraftTemplateVersion({
    ctx,
    repo,
    storage,
    engine,
    catalogue,
    actor,
    config,
    input: {
      code: pkg.template.code,
      name: pkg.template.name,
      description: pkg.template.description,
      category: pkg.template.category,
      tags: pkg.template.tags,
      outputDocumentType: pkg.template.outputDocumentType,
      filenamePattern: pkg.template.filenamePattern,
      availabilityRules: pkg.template.availabilityRules,
      fileName: pkg.version.fileName,
      docxBytes,
      fieldMappings: sanitizedMappings,
      promptedFields: pkg.version.promptedFields,
      changeNote:
        pkg.version.changeNote ??
        `Imported from template package (${pkg.exportedAt.slice(0, 10)})`,
    },
  });

  return {
    ...created,
    validationWarnings,
  };
}
