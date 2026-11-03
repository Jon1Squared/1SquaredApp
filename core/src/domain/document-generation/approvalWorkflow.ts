/**
 * Template Versioning & Approval Workflow State Machine
 * (`core/src/domain/document-generation/approvalWorkflow.ts`).
 *
 * Lifecycle enforced (ADR-0005):
 * - `Draft` -> `Submitted` -> `Active` / `Rejected`
 * - `Active` -> `Retired`
 * - Rollback to a previous approved version (`versionNumber`)
 *
 * Rules enforced:
 * 1. Uploading a template scans for placeholders via `DocumentGenerationEngine`, auto-maps canonical
 *    Field Catalogue keys, and rejects `.docm` / macro / reserved `{% ... %}` syntax.
 * 2. Submitting requires `document_template:build`, `scanStatus === 'clean'`, and zero unmapped placeholders.
 * 3. Approving/rejecting/retiring/rolling back requires `document_template:approve`.
 * 4. When `documentGeneration.approval.allowSelfApproval === false` (default), a builder cannot approve
 *    their own submitted version.
 */

import type {
  DocumentGenerationEngine,
  DocumentStorageProvider,
  DocumentTemplateRecord,
  DocumentTemplateVersionRecord,
  FieldCatalogueEntry,
  HomeRoleKey,
  PromptedFieldDefinition,
  TemplateAvailabilityRules,
  TemplatePlaceholderMapping,
  TenantConfiguration,
  TenantContext,
} from '../../api/index';
import type { TenantDocumentRepository } from '../../tenancy/documentRepository';
import {
  hasDocumentPermission,
  type DocumentPermissionActor,
} from './permissions';

export interface CreateTemplateWithUploadInput {
  templateId?: string;
  code: string;
  name: string;
  description: string;
  category: string;
  tags?: string[];
  outputDocumentType: string;
  filenamePattern: string;
  availabilityRules: TemplateAvailabilityRules;
  fileName: string;
  docxBytes: Uint8Array;
  fieldMappings?: Record<string, TemplatePlaceholderMapping>;
  promptedFields?: PromptedFieldDefinition[];
  changeNote?: string;
}

function assertBuildPermission(
  actor: DocumentPermissionActor,
  config: TenantConfiguration,
): void {
  if (!hasDocumentPermission(actor, 'document_template:build', config)) {
    throw new Error(
      'DOCUMENT_PERMISSION_DENIED: Actor lacks required permission "document_template:build".',
    );
  }
}

function assertApprovePermission(
  actor: DocumentPermissionActor,
  config: TenantConfiguration,
  ctx?: TenantContext,
): void {
  if (!hasDocumentPermission(actor, 'document_template:approve', config)) {
    throw new Error(
      'DOCUMENT_PERMISSION_DENIED: Actor lacks required permission "document_template:approve".',
    );
  }
  const requireMfa =
    config.rbac?.identityMapping?.requireMfaForAdminPermissions ?? true;
  if (ctx && requireMfa && ctx.mfaVerified === false) {
    throw new Error(
      'MFA_REQUIRED: Multi-factor authentication is required for administrative permission "document_template:approve".',
    );
  }
}

function validateAllowedRoleKeys(
  allowedRoleKeys: readonly string[] | undefined,
  config: TenantConfiguration,
): void {
  if (!allowedRoleKeys?.length) return;
  const knownRoles = new Set(Object.keys(config.rbac?.roles ?? {}));
  if (knownRoles.size === 0) return;
  for (const roleKey of allowedRoleKeys) {
    if (!knownRoles.has(roleKey)) {
      throw new Error(
        `TEMPLATE_INVALID_ROLE_KEY: Unknown role key "${roleKey}" in template availabilityRules.allowedRoleKeys.`,
      );
    }
  }
}

function resolveRolesWithFinanceView(
  config: TenantConfiguration,
): HomeRoleKey[] {
  if (config.rbac?.roles) {
    return Object.values(config.rbac.roles)
      .filter((r) => r.permissions.includes('finance:view'))
      .map((r) => r.key as HomeRoleKey);
  }
  return (config.documentGeneration.permissions?.roleDefaults?.[
    'finance:view'
  ] ?? ['finance', 'partner', 'managing_partner', 'admin']) as HomeRoleKey[];
}

/**
 * Automatically maps extracted placeholders whose identifier matches a canonical Field Catalogue key
 * or a defined Prompted Field key.
 */
export function buildAutoMappingsForPlaceholders(
  extractedIdentifiers: readonly string[],
  catalogue: readonly FieldCatalogueEntry[],
  existingMappings: Record<string, TemplatePlaceholderMapping> = {},
  promptedFields: readonly PromptedFieldDefinition[] = [],
): Record<string, TemplatePlaceholderMapping> {
  const catalogueMap = new Map(catalogue.map((c) => [c.key, c]));
  const promptedMap = new Map(promptedFields.map((p) => [p.key, p]));
  const result: Record<string, TemplatePlaceholderMapping> = {
    ...existingMappings,
  };

  for (const identifier of extractedIdentifiers) {
    if (result[identifier]) continue;

    if (catalogueMap.has(identifier)) {
      const catEntry = catalogueMap.get(identifier)!;
      result[identifier] = {
        placeholder: identifier,
        sourceType: 'catalogue',
        catalogueKey: identifier,
        formatFilter:
          catEntry.dataType === 'currency'
            ? 'currency'
            : catEntry.dataType === 'date'
              ? 'date'
              : catEntry.dataType === 'address'
                ? 'address_single'
                : undefined,
        required: identifier === 'matter.reference' || identifier === 'client.name',
      };
      continue;
    }

    const strippedPrompted = identifier.replace(/^prompted\./, '');
    if (promptedMap.has(strippedPrompted)) {
      const pf = promptedMap.get(strippedPrompted)!;
      result[identifier] = {
        placeholder: identifier,
        sourceType: 'prompted',
        promptedKey: pf.key,
        required: pf.required,
      };
    }
  }

  return result;
}

/**
 * Returns the list of placeholder identifiers in a template version that are not yet mapped
 * to either a valid Field Catalogue key or a defined Prompted Field.
 */
export function findUnmappedPlaceholders(
  version: Pick<
    DocumentTemplateVersionRecord,
    'extractedPlaceholders' | 'fieldMappings' | 'promptedFields'
  >,
  catalogue: readonly FieldCatalogueEntry[],
): string[] {
  const catalogueKeys = new Set(catalogue.map((c) => c.key));
  const promptedKeys = new Set(version.promptedFields.map((p) => p.key));
  const unmapped: string[] = [];

  for (const ph of version.extractedPlaceholders) {
    const mapping = version.fieldMappings[ph.identifier];
    if (!mapping) {
      unmapped.push(ph.identifier);
      continue;
    }
    if (mapping.sourceType === 'catalogue') {
      if (!mapping.catalogueKey || !catalogueKeys.has(mapping.catalogueKey)) {
        unmapped.push(ph.identifier);
      }
    } else if (mapping.sourceType === 'prompted') {
      if (!mapping.promptedKey || !promptedKeys.has(mapping.promptedKey)) {
        unmapped.push(ph.identifier);
      }
    } else {
      unmapped.push(ph.identifier);
    }
  }

  return unmapped;
}

/**
 * Uploads a `.docx` template to create a new template (with v1 `Draft`) or a new `Draft` version
 * on an existing template.
 */
export async function createOrUploadDraftTemplateVersion(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  storage: DocumentStorageProvider;
  engine: DocumentGenerationEngine;
  catalogue: readonly FieldCatalogueEntry[];
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  input: CreateTemplateWithUploadInput;
}): Promise<{
  template: DocumentTemplateRecord;
  version: DocumentTemplateVersionRecord;
  unmappedPlaceholders: string[];
}> {
  const { ctx, repo, storage, engine, catalogue, actor, config, input } =
    params;
  assertBuildPermission(actor, config);

  if (!/\.docx$/i.test(input.fileName)) {
    throw new Error(
      'TEMPLATE_INVALID_EXTENSION: Only .docx Word templates are allowed (.docm and non-DOCX files are rejected).',
    );
  }

  const maxBytes = config.documentGeneration.maxTemplateSizeMb * 1024 * 1024;
  if (input.docxBytes.length > maxBytes) {
    throw new Error(
      `TEMPLATE_SIZE_EXCEEDED: File size exceeds configured limit of ${config.documentGeneration.maxTemplateSizeMb} MB.`,
    );
  }

  // Extract placeholders and validate against reserved `{% ... %}` syntax
  const extraction = await engine.extractPlaceholders(input.docxBytes);
  if (extraction.validationErrors.length > 0) {
    const firstErr = extraction.validationErrors[0]!;
    throw new Error(`${firstErr.code}: ${firstErr.message}`);
  }

  const nowIso = new Date().toISOString();
  const existingTemplate = input.templateId
    ? repo.getTemplateById(ctx, input.templateId)
    : repo.getTemplateByCode(ctx, input.code);

  const templateId =
    existingTemplate?.id ??
    input.templateId ??
    `TPL-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const existingVersions = repo.listVersionsForTemplate(ctx, templateId);
  const nextVersionNumber =
    existingVersions.reduce((max, v) => Math.max(max, v.versionNumber), 0) + 1;
  const versionId = `${templateId}-V${nextVersionNumber}`;

  const storedBlob = await storage.putObject(ctx, {
    category: 'templates',
    objectId: versionId,
    fileName: input.fileName,
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: input.docxBytes,
  });

  if (storedBlob.scanStatus === 'infected') {
    await storage.deleteObject(ctx, { blobKey: storedBlob.blobKey });
    throw new Error(
      'TEMPLATE_MALWARE_DETECTED: Uploaded template failed malware/macro security scan and was rejected.',
    );
  }

  const promptedFields = input.promptedFields ?? [];
  const autoMappings = buildAutoMappingsForPlaceholders(
    extraction.placeholders.map((p) => p.identifier),
    catalogue,
    input.fieldMappings,
    promptedFields,
  );

  validateAllowedRoleKeys(input.availabilityRules?.allowedRoleKeys, config);

  // If any mapped catalogue field belongs to the Financial group and allowedRoleKeys is not explicitly set,
  // restrict default availability to roles with `finance:view`
  const usesFinancialFields = Object.values(autoMappings).some(
    (m) =>
      m.sourceType === 'catalogue' &&
      m.catalogueKey?.startsWith('financial.'),
  );
  const availabilityRules: TemplateAvailabilityRules = {
    ...input.availabilityRules,
    allowedRoleKeys:
      input.availabilityRules.allowedRoleKeys ??
      (usesFinancialFields ? resolveRolesWithFinanceView(config) : undefined),
  };

  const template: DocumentTemplateRecord = existingTemplate
    ? {
        ...existingTemplate,
        name: input.name,
        description: input.description,
        category: input.category,
        tags: input.tags ?? existingTemplate.tags,
        outputDocumentType: input.outputDocumentType,
        filenamePattern: input.filenamePattern,
        availabilityRules,
        updatedAt: nowIso,
      }
    : {
        id: templateId,
        tenantId: ctx.tenantId,
        code: input.code,
        name: input.name,
        description: input.description,
        category: input.category,
        tags: input.tags ?? [],
        outputDocumentType: input.outputDocumentType,
        filenamePattern: input.filenamePattern,
        availabilityRules,
        activeVersionId: null,
        status: 'Draft',
        createdByUserId: actor.id,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

  const version: DocumentTemplateVersionRecord = {
    id: versionId,
    tenantId: ctx.tenantId,
    templateId,
    versionNumber: nextVersionNumber,
    engine: engine.engineId,
    status: 'Draft',
    storageProvider: storedBlob.storageProvider,
    blobKey: storedBlob.blobKey,
    fileName: input.fileName,
    fileSha256: storedBlob.sha256,
    fileSizeBytes: storedBlob.sizeBytes,
    scanStatus: storedBlob.scanStatus,
    extractedPlaceholders: extraction.placeholders,
    fieldMappings: autoMappings,
    promptedFields,
    createdByUserId: actor.id,
    createdAt: nowIso,
    changeNote: input.changeNote ?? `Version ${nextVersionNumber} draft`,
  };

  repo.putTemplate(ctx, template);
  repo.putTemplateVersion(ctx, version);

  const unmappedPlaceholders = findUnmappedPlaceholders(version, catalogue);
  return { template, version, unmappedPlaceholders };
}

/**
 * Updates placeholder mappings, prompted fields, or metadata on a `Draft` template version.
 */
export function updateDraftTemplateVersion(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  catalogue: readonly FieldCatalogueEntry[];
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  versionId: string;
  fieldMappings: Record<string, TemplatePlaceholderMapping>;
  promptedFields: PromptedFieldDefinition[];
  templateMetadata?: Partial<
    Pick<
      DocumentTemplateRecord,
      | 'name'
      | 'description'
      | 'category'
      | 'tags'
      | 'outputDocumentType'
      | 'filenamePattern'
      | 'availabilityRules'
    >
  >;
  changeNote?: string;
}): {
  template: DocumentTemplateRecord;
  version: DocumentTemplateVersionRecord;
  unmappedPlaceholders: string[];
} {
  const { ctx, repo, catalogue, actor, config, versionId } = params;
  assertBuildPermission(actor, config);
  validateAllowedRoleKeys(
    params.templateMetadata?.availabilityRules?.allowedRoleKeys,
    config,
  );

  const version = repo.getTemplateVersionById(ctx, versionId);
  if (!version) {
    throw new Error('TEMPLATE_VERSION_NOT_FOUND: Template version not found.');
  }
  if (version.status !== 'Draft') {
    throw new Error(
      `TEMPLATE_VERSION_IMMUTABLE: Cannot modify version in status "${version.status}". Create a new Draft version instead.`,
    );
  }

  const template = repo.getTemplateById(ctx, version.templateId);
  if (!template) {
    throw new Error('TEMPLATE_NOT_FOUND: Parent template not found.');
  }

  const nowIso = new Date().toISOString();
  const updatedVersion: DocumentTemplateVersionRecord = {
    ...version,
    fieldMappings: { ...params.fieldMappings },
    promptedFields: [...params.promptedFields],
    changeNote: params.changeNote ?? version.changeNote,
  };

  const updatedTemplate: DocumentTemplateRecord = {
    ...template,
    ...(params.templateMetadata ?? {}),
    updatedAt: nowIso,
  };

  repo.putTemplate(ctx, updatedTemplate);
  repo.putTemplateVersion(ctx, updatedVersion);

  return {
    template: updatedTemplate,
    version: updatedVersion,
    unmappedPlaceholders: findUnmappedPlaceholders(updatedVersion, catalogue),
  };
}

/**
 * Submits a `Draft` template version for approval (`Draft` -> `Submitted`).
 * Blocked if any placeholder is unmapped or if `scanStatus !== 'clean'`.
 */
export function submitTemplateVersionForApproval(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  catalogue: readonly FieldCatalogueEntry[];
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  versionId: string;
  changeNote?: string;
}): {
  template: DocumentTemplateRecord;
  version: DocumentTemplateVersionRecord;
} {
  const { ctx, repo, catalogue, actor, config, versionId } = params;
  assertBuildPermission(actor, config);

  const version = repo.getTemplateVersionById(ctx, versionId);
  if (!version) {
    throw new Error('TEMPLATE_VERSION_NOT_FOUND: Template version not found.');
  }
  if (version.status !== 'Draft') {
    throw new Error(
      `TEMPLATE_INVALID_TRANSITION: Only a Draft version can be submitted (current status: "${version.status}").`,
    );
  }

  if (version.scanStatus !== 'clean') {
    throw new Error(
      `TEMPLATE_MALWARE_GATE: Template version cannot be submitted while malware scan status is "${version.scanStatus}".`,
    );
  }

  const unmapped = findUnmappedPlaceholders(version, catalogue);
  if (unmapped.length > 0) {
    throw new Error(
      `TEMPLATE_UNMAPPED_PLACEHOLDERS: Cannot submit template while placeholders remain unmapped: ${unmapped.join(', ')}`,
    );
  }

  const template = repo.getTemplateById(ctx, version.templateId);
  if (!template) {
    throw new Error('TEMPLATE_NOT_FOUND: Parent template not found.');
  }

  const nowIso = new Date().toISOString();
  const submittedVersion: DocumentTemplateVersionRecord = {
    ...version,
    status: 'Submitted',
    submittedByUserId: actor.id,
    submittedAt: nowIso,
    changeNote: params.changeNote ?? version.changeNote,
  };

  const updatedTemplate: DocumentTemplateRecord = {
    ...template,
    status: template.activeVersionId ? template.status : 'Submitted',
    updatedAt: nowIso,
  };

  repo.putTemplateVersion(ctx, submittedVersion);
  repo.putTemplate(ctx, updatedTemplate);

  return { template: updatedTemplate, version: submittedVersion };
}

/**
 * Approves a `Submitted` template version (`Submitted` -> `Active`), retiring any previously
 * active version of the same template. Enforces `allowSelfApproval`.
 */
export function approveTemplateVersion(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  versionId: string;
}): {
  template: DocumentTemplateRecord;
  version: DocumentTemplateVersionRecord;
} {
  const { ctx, repo, actor, config, versionId } = params;
  assertApprovePermission(actor, config, ctx);

  const version = repo.getTemplateVersionById(ctx, versionId);
  if (!version) {
    throw new Error('TEMPLATE_VERSION_NOT_FOUND: Template version not found.');
  }
  if (version.status !== 'Submitted') {
    throw new Error(
      `TEMPLATE_INVALID_TRANSITION: Only a Submitted version can be approved (current status: "${version.status}").`,
    );
  }

  if (version.scanStatus !== 'clean') {
    throw new Error(
      `TEMPLATE_MALWARE_GATE: Cannot approve version with scan status "${version.scanStatus}".`,
    );
  }

  const allowSelfApproval =
    config.documentGeneration.approval.allowSelfApproval;
  if (
    !allowSelfApproval &&
    (version.submittedByUserId === actor.id ||
      version.createdByUserId === actor.id)
  ) {
    throw new Error(
      'TEMPLATE_SELF_APPROVAL_FORBIDDEN: Self-approval is disabled for this tenant. Another approver with document_template:approve must review this version.',
    );
  }

  const template = repo.getTemplateById(ctx, version.templateId);
  if (!template) {
    throw new Error('TEMPLATE_NOT_FOUND: Parent template not found.');
  }

  const nowIso = new Date().toISOString();

  // Retire any previously Active version of this template
  for (const existingVer of repo.listVersionsForTemplate(ctx, template.id)) {
    if (existingVer.id !== version.id && existingVer.status === 'Active') {
      repo.putTemplateVersion(ctx, {
        ...existingVer,
        status: 'Retired',
      });
    }
  }

  const approvedVersion: DocumentTemplateVersionRecord = {
    ...version,
    status: 'Active',
    reviewedByUserId: actor.id,
    reviewedAt: nowIso,
    rejectionReason: null,
  };

  const updatedTemplate: DocumentTemplateRecord = {
    ...template,
    activeVersionId: approvedVersion.id,
    status: 'Active',
    updatedAt: nowIso,
  };

  repo.putTemplateVersion(ctx, approvedVersion);
  repo.putTemplate(ctx, updatedTemplate);

  return { template: updatedTemplate, version: approvedVersion };
}

/**
 * Rejects a `Submitted` template version (`Submitted` -> `Rejected`) with a mandatory reason.
 */
export function rejectTemplateVersion(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  versionId: string;
  rejectionReason: string;
}): {
  template: DocumentTemplateRecord;
  version: DocumentTemplateVersionRecord;
} {
  const { ctx, repo, actor, config, versionId, rejectionReason } = params;
  assertApprovePermission(actor, config, ctx);

  if (!rejectionReason || !rejectionReason.trim()) {
    throw new Error(
      'TEMPLATE_REJECTION_REASON_REQUIRED: A rejection reason is required when rejecting a submitted template.',
    );
  }

  const version = repo.getTemplateVersionById(ctx, versionId);
  if (!version) {
    throw new Error('TEMPLATE_VERSION_NOT_FOUND: Template version not found.');
  }
  if (version.status !== 'Submitted') {
    throw new Error(
      `TEMPLATE_INVALID_TRANSITION: Only a Submitted version can be rejected (current status: "${version.status}").`,
    );
  }

  const template = repo.getTemplateById(ctx, version.templateId);
  if (!template) {
    throw new Error('TEMPLATE_NOT_FOUND: Parent template not found.');
  }

  const nowIso = new Date().toISOString();
  const rejectedVersion: DocumentTemplateVersionRecord = {
    ...version,
    status: 'Rejected',
    reviewedByUserId: actor.id,
    reviewedAt: nowIso,
    rejectionReason: rejectionReason.trim(),
  };

  const updatedTemplate: DocumentTemplateRecord = {
    ...template,
    status: template.activeVersionId ? 'Active' : 'Rejected',
    updatedAt: nowIso,
  };

  repo.putTemplateVersion(ctx, rejectedVersion);
  repo.putTemplate(ctx, updatedTemplate);

  return { template: updatedTemplate, version: rejectedVersion };
}

/**
 * Retires an active template so it can no longer be used for new document generation.
 */
export function retireTemplate(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  templateId: string;
}): DocumentTemplateRecord {
  const { ctx, repo, actor, config, templateId } = params;
  assertApprovePermission(actor, config, ctx);

  const template = repo.getTemplateById(ctx, templateId);
  if (!template) {
    throw new Error('TEMPLATE_NOT_FOUND: Template not found.');
  }

  const nowIso = new Date().toISOString();
  for (const ver of repo.listVersionsForTemplate(ctx, template.id)) {
    if (ver.status === 'Active') {
      repo.putTemplateVersion(ctx, {
        ...ver,
        status: 'Retired',
      });
    }
  }

  const retiredTemplate: DocumentTemplateRecord = {
    ...template,
    activeVersionId: null,
    status: 'Retired',
    updatedAt: nowIso,
  };

  return repo.putTemplate(ctx, retiredTemplate);
}

/**
 * Rolls a template back to a previously approved version (`versionId` or `versionNumber`),
 * retiring the current active version and reactivating the selected prior approved version.
 */
export function rollbackTemplateToVersion(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  templateId: string;
  targetVersionId: string;
}): {
  template: DocumentTemplateRecord;
  activeVersion: DocumentTemplateVersionRecord;
} {
  const { ctx, repo, actor, config, templateId, targetVersionId } = params;
  assertApprovePermission(actor, config, ctx);

  const template = repo.getTemplateById(ctx, templateId);
  if (!template) {
    throw new Error('TEMPLATE_NOT_FOUND: Template not found.');
  }

  const targetVersion = repo.getTemplateVersionById(ctx, targetVersionId);
  if (!targetVersion || targetVersion.templateId !== template.id) {
    throw new Error(
      'TEMPLATE_VERSION_NOT_FOUND: Target rollback version not found for this template.',
    );
  }

  if (!targetVersion.reviewedByUserId || targetVersion.status === 'Draft' || targetVersion.status === 'Rejected') {
    throw new Error(
      'TEMPLATE_ROLLBACK_INVALID: Can only roll back to a version that was previously approved.',
    );
  }

  const nowIso = new Date().toISOString();
  for (const ver of repo.listVersionsForTemplate(ctx, template.id)) {
    if (ver.id !== targetVersion.id && ver.status === 'Active') {
      repo.putTemplateVersion(ctx, {
        ...ver,
        status: 'Retired',
      });
    }
  }

  const reactivatedVersion: DocumentTemplateVersionRecord = {
    ...targetVersion,
    status: 'Active',
  };

  const updatedTemplate: DocumentTemplateRecord = {
    ...template,
    activeVersionId: reactivatedVersion.id,
    status: 'Active',
    updatedAt: nowIso,
  };

  repo.putTemplateVersion(ctx, reactivatedVersion);
  repo.putTemplate(ctx, updatedTemplate);

  return { template: updatedTemplate, activeVersion: reactivatedVersion };
}
