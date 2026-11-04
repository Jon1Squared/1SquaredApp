/**
 * Server Services for Core Document Generation (`src/server/documentGenerationServices.ts`).
 *
 * Bridges Next.js server actions and API routes to `@platform/core` Document Generation:
 * - Resolves `TenantContext` from the authenticated user's full role set.
 * - Uses `LocalTenantStorageProvider` (`local-fs` under `data/storage/tenant-<slug>-<env>/`) by default.
 * - Persists template/version/document/link/usage records in `TenantDocumentRepository` synced with `FirmStore`.
 * - Seeds default approved templates (**Client Care & Engagement Letter** and **General Correspondence Letter**)
 *   plus a sample **Submitted** template in the Approval Queue for demo deployments.
 */

import crypto from 'node:crypto';
import {
  approveTemplateVersion,
  BasicMergeEngine,
  buildAutoMappingsForPlaceholders,
  BuiltInOpenXmlPdfConverter,
  buildValidDocxArchive,
  canActorAccessGeneratedDocument,
  createDocumentStorageProvider,
  createOrUploadDraftTemplateVersion,
  deleteGeneratedDocument,
  DocumentGenerationConfigSchema,
  exportTemplatePackage,
  exportTemplateUsageReportCsv,
  findUnmappedPlaceholders,
  generateDocumentFromTemplate,
  getReadableCatalogueFieldsForActor,
  hasDocumentPermission,
  hasPermission,
  importTemplatePackage,
  previewTemplateVersion,
  queryTemplateUsageReport,
  rejectTemplateVersion,
  resolveDocumentPermissions,
  retireTemplate,
  rollbackTemplateToVersion,
  submitTemplateVersionForApproval,
  TenantDocumentRepository,
  updateDraftTemplateVersion,
  type DocumentGenerationConfig,
  type DocumentLinkRecord,
  type DocumentOutputFormat,
  type DocumentPermission,
  type DocumentStorageProvider,
  type DocumentTemplateRecord,
  type DocumentTemplateVersionRecord,
  type FieldDataType,
  type FieldGroup,
  type FieldRequiredPermission,
  type GeneratedDocumentRecord,
  type PromptedFieldDefinition,
  type ScopedDownloadToken,
  type TemplateAvailabilityRules,
  type DocumentPermissionActor,
  type RbacConfiguration,
  type TemplatePackageManifest,
  type TemplatePlaceholderMapping,
  type TemplateUsageReportFilter,
  type TemplateUsageReportResult,
  type TenantConfiguration,
  type TenantContext,
} from '@platform/core';
import {
  buildDocumentActorFromPerson,
  buildFieldResolutionContextForRecord,
  buildFullCatalogueFromStoreCustomFields,
  buildSeedClientCareTemplateDocxBytes,
  buildSeedGeneralCorrespondenceDocxBytes,
  toMatterAccessSubject,
} from '@/domain/documentGeneration';
import {
  getActiveActorSession,
  hasPersonPermission,
} from '@/domain/rbac';
import type { Person } from '@/domain/types';
import {
  getActiveTenantConfiguration,
  resolveCurrentTenantContext,
} from '@/platform/tenantRuntime';
import {
  createVerifiedSessionActorFromEntraSession,
  type VerifiedEntraSessionPayload,
} from './entraAuth';
import {
  getStore,
  nextId,
  saveStore,
  type FirmStore,
} from './store';

export interface SerializableCatalogueField {
  key: string;
  displayName: string;
  description: string;
  group: FieldGroup;
  dataType: FieldDataType;
  requiredPermission: FieldRequiredPermission;
  sinceVersion: string;
  sampleValue?: string;
}

export interface DocumentGenerationClientSnapshot {
  config: DocumentGenerationConfig;
  rbac?: RbacConfiguration;
  actor: DocumentPermissionActor;
  userPermissions: DocumentPermission[];
  readableCatalogueFields: SerializableCatalogueField[];
  templates: DocumentTemplateRecord[];
  versions: DocumentTemplateVersionRecord[];
  pendingApprovalsCount: number;
  documents: GeneratedDocumentRecord[];
  documentLinks: DocumentLinkRecord[];
}

declare global {
  var __oneSquaredDocRepo: TenantDocumentRepository | undefined;
  var __oneSquaredDocStorage: DocumentStorageProvider | undefined;
}

function isTestEnv(): boolean {
  return Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
}

export function resolveTenantBlobSigningKey(tenantId: string): string {
  const baseSecret =
    process.env.PLATFORM_BLOB_SIGNING_KEY?.trim() ||
    (isTestEnv() ? 'test-host-blob-signing-key-from-vault' : '');
  if (!baseSecret || (baseSecret.startsWith('<') && baseSecret.endsWith('>'))) {
    throw new Error(
      'STORAGE_CONFIG_ERROR: PLATFORM_BLOB_SIGNING_KEY must be configured in Key Vault / environment.',
    );
  }
  return crypto
    .createHmac('sha256', baseSecret)
    .update(`tenant-blob-signing:${tenantId}`)
    .digest('hex');
}

export function getDocumentStorage(
  config: TenantConfiguration,
): DocumentStorageProvider {
  if (!global.__oneSquaredDocStorage) {
    global.__oneSquaredDocStorage = createDocumentStorageProvider(
      config.documentGeneration.storageProvider,
      {
        inMemoryOnly: isTestEnv(),
        tokenSigningKey: resolveTenantBlobSigningKey(config.tenantId),
      },
    );
  }
  return global.__oneSquaredDocStorage;
}

export function getEffectiveTenantConfig(
  store: FirmStore,
): TenantConfiguration {
  const baseCfg = getActiveTenantConfiguration();
  const override = store.documentGenerationConfigOverride;
  if (!override) {
    return baseCfg;
  }
  return {
    ...baseCfg,
    documentGeneration: {
      ...baseCfg.documentGeneration,
      ...override,
      approval: {
        ...baseCfg.documentGeneration.approval,
        ...(override.approval ?? {}),
      },
      usage: {
        ...baseCfg.documentGeneration.usage,
        ...(override.usage ?? {}),
      },
      permissions: {
        roleDefaults: {
          ...(baseCfg.documentGeneration.permissions?.roleDefaults ?? {}),
          ...(override.permissions?.roleDefaults ?? {}),
        },
      },
      customDocumentTypes:
        override.customDocumentTypes ??
        baseCfg.documentGeneration.customDocumentTypes,
    },
  };
}

export function resolveTenantContextForStoreUser(
  store: FirmStore,
  userId: string,
  session?: VerifiedEntraSessionPayload,
): { ctx: TenantContext; user: Person } {
  const user = store.people.find(
    (p) => p.id === userId && p.isEmployee && !p.mergedIntoId,
  );
  if (!user) {
    throw new Error(
      `UNAUTHENTICATED: User "${userId}" was not found or is not an active employee.`,
    );
  }

  const verifiedSession =
    session ??
    (getActiveActorSession()?.verifiedSession as
      | VerifiedEntraSessionPayload
      | undefined);
  if (!verifiedSession) {
    throw new Error(
      `UNAUTHENTICATED: Verified Entra ID session is required for user "${user.id}".`,
    );
  }
  if (verifiedSession.personId !== user.id) {
    throw new Error(
      `TENANCY_ACTOR_MISMATCH: Verified session personId "${verifiedSession.personId}" does not match requested user "${user.id}".`,
    );
  }

  const ctx = resolveCurrentTenantContext(
    createVerifiedSessionActorFromEntraSession(verifiedSession),
  );

  return { ctx, user };
}

function syncStoreToRepository(
  ctx: TenantContext,
  store: FirmStore,
  repo: TenantDocumentRepository,
  storage: DocumentStorageProvider,
): void {
  for (const t of store.documentTemplates ?? []) {
    if (t.tenantId === ctx.tenantId) {
      repo.putTemplate(ctx, t);
    }
  }
  for (const v of store.documentTemplateVersions ?? []) {
    if (v.tenantId === ctx.tenantId) {
      repo.putTemplateVersion(ctx, v);
    }
  }
  for (const d of store.documents ?? []) {
    if (d.tenantId === ctx.tenantId) {
      repo.putDocument(ctx, d);
    }
  }
  for (const l of store.documentLinks ?? []) {
    if (l.tenantId === ctx.tenantId) {
      repo.putDocumentLink(ctx, l);
    }
  }
  const existingEventIds = new Set(
    repo.listUsageEvents(ctx).map((e) => e.id),
  );
  for (const ev of store.templateUsageEvents ?? []) {
    if (ev.tenantId === ctx.tenantId && !existingEventIds.has(ev.id)) {
      repo.putUsageEvent(ctx, ev);
    }
  }

  // Ensure seeded template binaries exist in storage even after a cold restart or in-memory test reset
  const cclVersion = repo.getTemplateVersionById(ctx, 'TPL-SEED-CCL-V1');
  if (cclVersion) {
    void storage
      .getObjectBytes(ctx, { blobKey: cclVersion.blobKey })
      .catch(async () => {
        await storage.putObject(ctx, {
          category: 'templates',
          objectId: cclVersion.id,
          fileName: cclVersion.fileName,
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          bytes: buildSeedClientCareTemplateDocxBytes(),
        });
      });
  }

  const corrVersion = repo.getTemplateVersionById(ctx, 'TPL-SEED-CORR-V1');
  if (corrVersion) {
    void storage
      .getObjectBytes(ctx, { blobKey: corrVersion.blobKey })
      .catch(async () => {
        await storage.putObject(ctx, {
          category: 'templates',
          objectId: corrVersion.id,
          fileName: corrVersion.fileName,
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          bytes: buildSeedGeneralCorrespondenceDocxBytes(),
        });
      });
  }
}

function persistRepositoryToStore(
  ctx: TenantContext,
  store: FirmStore,
  repo: TenantDocumentRepository,
): void {
  store.documentTemplates = repo.listTemplates(ctx);
  store.documentTemplateVersions = repo.listAllTemplateVersions(ctx);
  store.documents = repo.listDocuments(ctx, { includeDeleted: true });
  const allLinks: DocumentLinkRecord[] = [];
  for (const doc of store.documents) {
    allLinks.push(...repo.listLinksForDocument(ctx, doc.id));
  }
  store.documentLinks = allLinks;
  store.templateUsageEvents = repo.listUsageEvents(ctx);
  saveStore(store);
}

/**
 * Seeds default templates on non-clean demo stores so users immediately have:
 * 1. **Client Care & Engagement Letter** (`Active`, v1 approved)
 * 2. **General Client Correspondence Letter** (`Active`, v1 approved)
 * 3. **File Attendance & Hearing Note** (`Submitted`, awaiting approval in the Approval Queue)
 */
async function ensureSeedDocumentTemplates(
  ctx: TenantContext,
  store: FirmStore,
  repo: TenantDocumentRepository,
  storage: DocumentStorageProvider,
): Promise<void> {
  if (repo.listTemplates(ctx).length > 0) return;

  const catalogue = buildFullCatalogueFromStoreCustomFields(store.customFields);
  const engine = new BasicMergeEngine();
  const nowIso = '2026-04-01T09:00:00.000Z';

  // 1. Client Care & Engagement Letter (Active)
  const cclBytes = buildSeedClientCareTemplateDocxBytes();
  const cclExtracted = await engine.extractPlaceholders(cclBytes);
  const cclPrompted: PromptedFieldDefinition[] = [
    {
      key: 'specialScopeNotes',
      label: 'Special Instructions / Scope Assumptions',
      fieldType: 'text',
      required: false,
      defaultValue: 'Standard firm terms of business apply.',
      helpText: 'Optional matter-specific assumptions included in Section 1.',
    },
  ];
  const cclMappings = buildAutoMappingsForPlaceholders(
    cclExtracted.placeholders.map((p) => p.identifier),
    catalogue,
    {},
    cclPrompted,
  );
  const cclStored = await storage.putObject(ctx, {
    category: 'templates',
    objectId: 'TPL-SEED-CCL-V1',
    fileName: 'Client-Care-Engagement-Letter.docx',
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: cclBytes,
  });

  repo.putTemplate(ctx, {
    id: 'TPL-SEED-CCL',
    tenantId: ctx.tenantId,
    code: 'CCL-ENG-01',
    name: 'Client Care & Engagement Letter',
    description:
      'Standard SRA-compliant Client Care & Engagement Letter including scope of work, fee earner details, fee estimate, and complaints procedure.',
    category: 'Client Care',
    tags: ['client-care', 'engagement', 'onboarding'],
    outputDocumentType: 'client_care',
    filenamePattern: '{{matter.reference}} - Client Care Letter - {{client.name}}',
    availabilityRules: {
      sourceContexts: ['matter'],
    },
    activeVersionId: 'TPL-SEED-CCL-V1',
    status: 'Active',
    createdByUserId: 'P-000001',
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  repo.putTemplateVersion(ctx, {
    id: 'TPL-SEED-CCL-V1',
    tenantId: ctx.tenantId,
    templateId: 'TPL-SEED-CCL',
    versionNumber: 1,
    engine: 'basic-merge',
    status: 'Active',
    storageProvider: cclStored.storageProvider,
    blobKey: cclStored.blobKey,
    fileName: 'Client-Care-Engagement-Letter.docx',
    fileSha256: cclStored.sha256,
    fileSizeBytes: cclStored.sizeBytes,
    scanStatus: 'clean',
    extractedPlaceholders: cclExtracted.placeholders,
    fieldMappings: cclMappings,
    promptedFields: cclPrompted,
    createdByUserId: 'P-000001',
    createdAt: nowIso,
    submittedByUserId: 'P-000001',
    submittedAt: nowIso,
    reviewedByUserId: 'P-000002',
    reviewedAt: nowIso,
    changeNote: 'Initial approved firm-wide Client Care & Engagement Letter',
  });

  // 2. General Client Correspondence Letter (Active, no Financial fields so usable by all roles)
  const corrBytes = buildSeedGeneralCorrespondenceDocxBytes();
  const corrExtracted = await engine.extractPlaceholders(corrBytes);
  const corrPrompted: PromptedFieldDefinition[] = [
    {
      key: 'letterBody',
      label: 'Letter Body Paragraph',
      fieldType: 'text',
      required: true,
      defaultValue:
        'We write to provide an update on the progress of your matter and confirm the next steps agreed.',
    },
  ];
  const corrMappings = buildAutoMappingsForPlaceholders(
    corrExtracted.placeholders.map((p) => p.identifier),
    catalogue,
    {},
    corrPrompted,
  );
  const corrStored = await storage.putObject(ctx, {
    category: 'templates',
    objectId: 'TPL-SEED-CORR-V1',
    fileName: 'General-Client-Correspondence.docx',
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: corrBytes,
  });

  repo.putTemplate(ctx, {
    id: 'TPL-SEED-CORR',
    tenantId: ctx.tenantId,
    code: 'CORR-GEN-01',
    name: 'General Client Correspondence Letter',
    description:
      'Formal letterhead template for client and party correspondence from a Matter or Client record.',
    category: 'Correspondence',
    tags: ['letter', 'correspondence', 'general'],
    outputDocumentType: 'letter',
    filenamePattern: '{{matter.reference}} - Letter to {{party.recipient.name}}',
    availabilityRules: {
      sourceContexts: ['matter', 'client'],
    },
    activeVersionId: 'TPL-SEED-CORR-V1',
    status: 'Active',
    createdByUserId: 'P-000001',
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  repo.putTemplateVersion(ctx, {
    id: 'TPL-SEED-CORR-V1',
    tenantId: ctx.tenantId,
    templateId: 'TPL-SEED-CORR',
    versionNumber: 1,
    engine: 'basic-merge',
    status: 'Active',
    storageProvider: corrStored.storageProvider,
    blobKey: corrStored.blobKey,
    fileName: 'General-Client-Correspondence.docx',
    fileSha256: corrStored.sha256,
    fileSizeBytes: corrStored.sizeBytes,
    scanStatus: 'clean',
    extractedPlaceholders: corrExtracted.placeholders,
    fieldMappings: corrMappings,
    promptedFields: corrPrompted,
    createdByUserId: 'P-000001',
    createdAt: nowIso,
    submittedByUserId: 'P-000001',
    submittedAt: nowIso,
    reviewedByUserId: 'P-000002',
    reviewedAt: nowIso,
    changeNote: 'Approved general correspondence letterhead',
  });

  // 3. Attendance & File Note (Submitted — ready in Approval Queue)
  const attBytes = buildValidDocxArchive({
    headerText: '{{ firm.registeredName }} | File Attendance Note',
    footerText: 'Matter: {{ matter.reference }} | Author: {{ user.fullName }}',
    paragraphs: [
      {
        text: 'Attendance & File Note — {{ matter.reference }}',
        heading: 'Heading1',
        bold: true,
      },
      { text: 'Date: {{ date.today | date:"d MMMM yyyy" }}' },
      { text: 'Client: {{ client.name }}' },
      { text: 'Matter: {{ matter.title }}' },
      { text: 'Fee Earner: {{ feeEarner.fullName }} ({{ feeEarner.jobTitle }})' },
      {
        text: 'Summary of Attendance / Advice Given:',
        heading: 'Heading2',
        bold: true,
      },
      { text: '{{ prompted.attendanceSummary }}' },
    ],
  });
  const attExtracted = await engine.extractPlaceholders(attBytes);
  const attPrompted: PromptedFieldDefinition[] = [
    {
      key: 'attendanceSummary',
      label: 'Attendance Note Summary',
      fieldType: 'text',
      required: true,
      defaultValue: 'Attended client by telephone to review key milestones.',
    },
  ];
  const attMappings = buildAutoMappingsForPlaceholders(
    attExtracted.placeholders.map((p) => p.identifier),
    catalogue,
    {},
    attPrompted,
  );
  const attStored = await storage.putObject(ctx, {
    category: 'templates',
    objectId: 'TPL-SEED-ATT-V1',
    fileName: 'Matter-Attendance-Note.docx',
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: attBytes,
  });

  repo.putTemplate(ctx, {
    id: 'TPL-SEED-ATT',
    tenantId: ctx.tenantId,
    code: 'ATT-NOTE-01',
    name: 'Matter File & Telephone Attendance Note',
    description:
      'Structured attendance note template for recording client meetings, calls, and advice on the file.',
    category: 'File Notes',
    tags: ['attendance-note', 'file-note'],
    outputDocumentType: 'attendance_note',
    filenamePattern: '{{matter.reference}} - Attendance Note - {{date.today}}',
    availabilityRules: {
      sourceContexts: ['matter', 'client'],
    },
    activeVersionId: null,
    status: 'Submitted',
    createdByUserId: 'P-000007',
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  repo.putTemplateVersion(ctx, {
    id: 'TPL-SEED-ATT-V1',
    tenantId: ctx.tenantId,
    templateId: 'TPL-SEED-ATT',
    versionNumber: 1,
    engine: 'basic-merge',
    status: 'Submitted',
    storageProvider: attStored.storageProvider,
    blobKey: attStored.blobKey,
    fileName: 'Matter-Attendance-Note.docx',
    fileSha256: attStored.sha256,
    fileSizeBytes: attStored.sizeBytes,
    scanStatus: 'clean',
    extractedPlaceholders: attExtracted.placeholders,
    fieldMappings: attMappings,
    promptedFields: attPrompted,
    createdByUserId: 'P-000007',
    createdAt: nowIso,
    submittedByUserId: 'P-000007',
    submittedAt: nowIso,
    changeNote: 'Submitted for Risk & Compliance / Partner approval',
  });

  persistRepositoryToStore(ctx, store, repo);
}

export async function getInitializedDocGenContext(
  userId: string,
  session?: VerifiedEntraSessionPayload,
): Promise<{
  store: FirmStore;
  ctx: TenantContext;
  user: Person;
  config: TenantConfiguration;
  repo: TenantDocumentRepository;
  storage: DocumentStorageProvider;
}> {
  const store = getStore();
  const config = getEffectiveTenantConfig(store);
  const { ctx, user } = resolveTenantContextForStoreUser(
    store,
    userId,
    session,
  );

  if (!global.__oneSquaredDocRepo) {
    global.__oneSquaredDocRepo = new TenantDocumentRepository();
  }
  const repo = global.__oneSquaredDocRepo;
  const storage = getDocumentStorage(config);

  syncStoreToRepository(ctx, store, repo, storage);
  await ensureSeedDocumentTemplates(ctx, store, repo, storage);

  return { store, ctx, user, config, repo, storage };
}

export async function getDocumentGenerationSnapshotForUser(
  userId: string,
  session?: VerifiedEntraSessionPayload,
): Promise<DocumentGenerationClientSnapshot> {
  const { store, ctx, user, config, repo } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);
  const userPermissions = resolveDocumentPermissions(actor, config);
  const fullCatalogue = buildFullCatalogueFromStoreCustomFields(
    store.customFields,
  );
  const readableFields = getReadableCatalogueFieldsForActor(
    actor,
    fullCatalogue,
    config,
  );

  const serializableCatalogue: SerializableCatalogueField[] = readableFields.map(
    (f) => ({
      key: f.key,
      displayName: f.displayName,
      description: f.description,
      group: f.group,
      dataType: f.dataType,
      requiredPermission: f.requiredPermission,
      sinceVersion: f.sinceVersion,
      sampleValue: f.sampleValue,
    }),
  );

  const templates = repo.listTemplates(ctx);
  const versions = repo.listAllTemplateVersions(ctx);
  const pendingApprovalsCount = versions.filter(
    (v) => v.status === 'Submitted',
  ).length;

  const mattersById = new Map(
    store.matters.map((m) => [m.id, toMatterAccessSubject(m)!]),
  );

  const allDocs = repo.listDocuments(ctx);
  const accessibleDocs = allDocs.filter((doc) => {
    const linkedMatters = [];
    if (doc.primaryMatterId && mattersById.has(doc.primaryMatterId)) {
      linkedMatters.push(mattersById.get(doc.primaryMatterId)!);
    }
    for (const l of repo.listLinksForDocument(ctx, doc.id)) {
      if (l.entityType === 'matter' && mattersById.has(l.entityId)) {
        const m = mattersById.get(l.entityId)!;
        if (!linkedMatters.some((x) => x.id === m.id)) {
          linkedMatters.push(m);
        }
      }
    }
    return canActorAccessGeneratedDocument(actor, doc, linkedMatters, config);
  });

  const accessibleDocIds = new Set(accessibleDocs.map((d) => d.id));
  const documentLinks: DocumentLinkRecord[] = [];
  for (const docId of accessibleDocIds) {
    documentLinks.push(...repo.listLinksForDocument(ctx, docId));
  }

  return {
    config: config.documentGeneration,
    rbac: config.rbac,
    actor,
    userPermissions,
    readableCatalogueFields: serializableCatalogue,
    templates,
    versions,
    pendingApprovalsCount,
    documents: accessibleDocs,
    documentLinks,
  };
}

function appendAudit(
  store: FirmStore,
  entry: {
    recordType: 'matter' | 'organisation' | 'person';
    recordId: string;
    action: 'create' | 'update' | 'delete';
    field: string;
    oldValue: string | null;
    newValue: string | null;
    byId: string;
  },
): void {
  store.audit.unshift({
    id: nextId(store, 'AU'),
    recordType: entry.recordType,
    recordId: entry.recordId,
    action: entry.action === 'delete' ? 'update' : entry.action,
    field: entry.field,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    byId: entry.byId,
    at: new Date().toISOString(),
  });
}

export async function uploadTemplateDraftService(
  input: {
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
    docxBase64: string;
    fieldMappings?: Record<string, TemplatePlaceholderMapping>;
    promptedFields?: PromptedFieldDefinition[];
    changeNote?: string;
  },
  userId: string,
  session?: VerifiedEntraSessionPayload,
) {
  const { store, ctx, user, config, repo, storage } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);
  const catalogue = buildFullCatalogueFromStoreCustomFields(store.customFields);
  const engine = new BasicMergeEngine({
    maxTemplateSizeMb: config.documentGeneration.maxTemplateSizeMb,
  });

  const buf = Buffer.from(input.docxBase64, 'base64');
  const docxBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  const result = await createOrUploadDraftTemplateVersion({
    ctx,
    repo,
    storage,
    engine,
    catalogue,
    actor,
    config,
    input: {
      templateId: input.templateId,
      code: input.code,
      name: input.name,
      description: input.description,
      category: input.category,
      tags: input.tags,
      outputDocumentType: input.outputDocumentType,
      filenamePattern: input.filenamePattern,
      availabilityRules: input.availabilityRules,
      fileName: input.fileName,
      docxBytes,
      fieldMappings: input.fieldMappings,
      promptedFields: input.promptedFields,
      changeNote: input.changeNote,
    },
  });

  appendAudit(store, {
    recordType: 'matter',
    recordId: result.template.id,
    action: 'create',
    field: `Document Template Draft Uploaded (${result.template.code} v${result.version.versionNumber})`,
    oldValue: null,
    newValue: `${result.template.name} · ${result.version.extractedPlaceholders.length} placeholders (${result.unmappedPlaceholders.length} unmapped)`,
    byId: user.id,
  });

  persistRepositoryToStore(ctx, store, repo);
  return result;
}

export async function updateTemplateDraftService(
  input: {
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
  },
  userId: string,
  session?: VerifiedEntraSessionPayload,
) {
  const { store, ctx, user, config, repo } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);
  const catalogue = buildFullCatalogueFromStoreCustomFields(store.customFields);

  const result = updateDraftTemplateVersion({
    ctx,
    repo,
    catalogue,
    actor,
    config,
    versionId: input.versionId,
    fieldMappings: input.fieldMappings,
    promptedFields: input.promptedFields,
    templateMetadata: input.templateMetadata,
    changeNote: input.changeNote,
  });

  persistRepositoryToStore(ctx, store, repo);
  return result;
}

export async function submitTemplateVersionService(
  versionId: string,
  changeNote: string | undefined,
  userId: string,
  session?: VerifiedEntraSessionPayload,
) {
  const { store, ctx, user, config, repo } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);
  const catalogue = buildFullCatalogueFromStoreCustomFields(store.customFields);

  const result = submitTemplateVersionForApproval({
    ctx,
    repo,
    catalogue,
    actor,
    config,
    versionId,
    changeNote,
  });

  appendAudit(store, {
    recordType: 'matter',
    recordId: result.template.id,
    action: 'update',
    field: `Document Template Submitted for Approval (${result.template.code} v${result.version.versionNumber})`,
    oldValue: 'Draft',
    newValue: 'Submitted',
    byId: user.id,
  });

  persistRepositoryToStore(ctx, store, repo);
  return result;
}

export async function approveTemplateVersionService(
  versionId: string,
  userId: string,
  session?: VerifiedEntraSessionPayload,
) {
  const { store, ctx, user, config, repo } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);

  const result = approveTemplateVersion({
    ctx,
    repo,
    actor,
    config,
    versionId,
  });

  appendAudit(store, {
    recordType: 'matter',
    recordId: result.template.id,
    action: 'update',
    field: `Document Template Approved (${result.template.code} v${result.version.versionNumber})`,
    oldValue: 'Submitted',
    newValue: 'Active',
    byId: user.id,
  });

  persistRepositoryToStore(ctx, store, repo);
  return result;
}

export async function rejectTemplateVersionService(
  versionId: string,
  rejectionReason: string,
  userId: string,
  session?: VerifiedEntraSessionPayload,
) {
  const { store, ctx, user, config, repo } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);

  const result = rejectTemplateVersion({
    ctx,
    repo,
    actor,
    config,
    versionId,
    rejectionReason,
  });

  appendAudit(store, {
    recordType: 'matter',
    recordId: result.template.id,
    action: 'update',
    field: `Document Template Rejected (${result.template.code} v${result.version.versionNumber})`,
    oldValue: 'Submitted',
    newValue: `Rejected: ${rejectionReason}`,
    byId: user.id,
  });

  persistRepositoryToStore(ctx, store, repo);
  return result;
}

export async function retireTemplateService(
  templateId: string,
  userId: string,
  session?: VerifiedEntraSessionPayload,
) {
  const { store, ctx, user, config, repo } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);

  const result = retireTemplate({
    ctx,
    repo,
    actor,
    config,
    templateId,
  });

  appendAudit(store, {
    recordType: 'matter',
    recordId: result.id,
    action: 'update',
    field: `Document Template Retired (${result.code})`,
    oldValue: 'Active',
    newValue: 'Retired',
    byId: user.id,
  });

  persistRepositoryToStore(ctx, store, repo);
  return result;
}

export async function rollbackTemplateVersionService(
  templateId: string,
  targetVersionId: string,
  userId: string,
  session?: VerifiedEntraSessionPayload,
) {
  const { store, ctx, user, config, repo } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);

  const result = rollbackTemplateToVersion({
    ctx,
    repo,
    actor,
    config,
    templateId,
    targetVersionId,
  });

  appendAudit(store, {
    recordType: 'matter',
    recordId: result.template.id,
    action: 'update',
    field: `Document Template Rolled Back (${result.template.code} -> v${result.activeVersion.versionNumber})`,
    oldValue: null,
    newValue: `Active v${result.activeVersion.versionNumber}`,
    byId: user.id,
  });

  persistRepositoryToStore(ctx, store, repo);
  return result;
}

export async function exportTemplatePackageService(
  templateId: string,
  versionId: string | undefined,
  userId: string,
  session?: VerifiedEntraSessionPayload,
): Promise<TemplatePackageManifest> {
  const { ctx, user, config, repo, storage } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);

  return exportTemplatePackage({
    ctx,
    repo,
    storage,
    actor,
    config,
    templateId,
    versionId,
  });
}

export async function importTemplatePackageService(
  pkg: TemplatePackageManifest,
  userId: string,
  session?: VerifiedEntraSessionPayload,
) {
  const { store, ctx, user, config, repo, storage } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);
  const catalogue = buildFullCatalogueFromStoreCustomFields(store.customFields);
  const engine = new BasicMergeEngine({
    maxTemplateSizeMb: config.documentGeneration.maxTemplateSizeMb,
  });

  const result = await importTemplatePackage({
    ctx,
    repo,
    storage,
    engine,
    catalogue,
    actor,
    config,
    pkg,
  });

  appendAudit(store, {
    recordType: 'matter',
    recordId: result.template.id,
    action: 'create',
    field: `Template Package Imported as Draft (${result.template.code} v${result.version.versionNumber})`,
    oldValue: null,
    newValue: result.template.name,
    byId: user.id,
  });

  persistRepositoryToStore(ctx, store, repo);
  return result;
}

export async function previewTemplateService(
  input: {
    versionId: string;
    matterId?: string | null;
    organisationId?: string | null;
    personId?: string | null;
    recipientPartyId?: string | null;
    promptedValues?: Record<string, unknown>;
    outputFormat?: DocumentOutputFormat;
  },
  userId: string,
  session?: VerifiedEntraSessionPayload,
): Promise<{
  fileBase64: string;
  fileName: string;
  mimeType: string;
  missingRequiredFields: string[];
}> {
  const { store, ctx, user, config, repo, storage } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);
  const catalogue = buildFullCatalogueFromStoreCustomFields(store.customFields);
  const engine = new BasicMergeEngine();
  const pdfConverter = new BuiltInOpenXmlPdfConverter();

  const matter = input.matterId
    ? store.matters.find((m) => m.id === input.matterId)
    : store.matters.find((m) => !m.isStaffMatter) ?? store.matters[0];
  const organisation = input.organisationId
    ? store.organisations.find((o) => o.id === input.organisationId)
    : undefined;
  const person = input.personId
    ? store.people.find((p) => p.id === input.personId)
    : undefined;

  const resolutionContext = buildFieldResolutionContextForRecord({
    tenantId: ctx.tenantId,
    matter,
    organisation,
    person,
    currentUser: user,
    recipientPartyId: input.recipientPartyId,
    promptedValues: input.promptedValues,
    people: store.people,
    organisations: store.organisations,
    values: store.values,
    firm: {
      name: store.firm.shortName,
      legalName: store.firm.name,
    },
  });

  const res = await previewTemplateVersion({
    ctx,
    repo,
    storage,
    engine,
    pdfConverter,
    catalogue,
    actor,
    config,
    versionId: input.versionId,
    resolutionContext,
    matterAccessSubject: matter ? toMatterAccessSubject(matter) : null,
    outputFormat: input.outputFormat,
  });

  persistRepositoryToStore(ctx, store, repo);
  return {
    fileBase64: Buffer.from(res.outputBytes).toString('base64'),
    fileName: res.fileName,
    mimeType: res.mimeType,
    missingRequiredFields: res.missingRequiredFields,
  };
}

export async function generateDocumentService(
  input: {
    templateId: string;
    sourceEntityType: 'matter' | 'client';
    matterId?: string | null;
    organisationId?: string | null;
    personId?: string | null;
    recipientPartyId?: string | null;
    recipientPartyEntityType?: 'organisation' | 'person' | null;
    promptedValues?: Record<string, unknown>;
    outputFormat?: DocumentOutputFormat;
  },
  userId: string,
  session?: VerifiedEntraSessionPayload,
): Promise<{
  status: 'generated' | 'blocked_missing_required';
  document?: GeneratedDocumentRecord;
  downloadToken?: ScopedDownloadToken;
  fileBase64?: string;
  missingRequiredFields: string[];
}> {
  const { store, ctx, user, config, repo, storage } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);
  const catalogue = buildFullCatalogueFromStoreCustomFields(store.customFields);
  const engine = new BasicMergeEngine();
  const pdfConverter = new BuiltInOpenXmlPdfConverter();

  const matter = input.matterId
    ? store.matters.find((m) => m.id === input.matterId)
    : null;
  const organisation = input.organisationId
    ? store.organisations.find((o) => o.id === input.organisationId)
    : matter?.clientId
      ? store.organisations.find((o) => o.id === matter.clientId)
      : null;
  const person = input.personId
    ? store.people.find((p) => p.id === input.personId)
    : matter?.clientId
      ? store.people.find((p) => p.id === matter.clientId)
      : null;

  const primaryClientId = organisation?.id ?? person?.id ?? null;
  const primaryClientEntityType: 'organisation' | 'person' | null = organisation
    ? 'organisation'
    : person
      ? 'person'
      : null;

  const practiceAreaLabel = matter?.practiceAreaId
    ? (store.values.find((v) => v.id === matter.practiceAreaId)?.label ??
      matter.practiceAreaId)
    : null;
  const matterTypeLabel = matter?.workTypeSubcategoryId
    ? (store.values.find((v) => v.id === matter.workTypeSubcategoryId)?.label ??
      matter.workTypeSubcategoryId)
    : null;
  const userTeam = store.teams.find(
    (t) => t.memberIds.includes(user.id) || t.leadIds.includes(user.id),
  );

  const resolutionContext = buildFieldResolutionContextForRecord({
    tenantId: ctx.tenantId,
    matter,
    organisation,
    person,
    currentUser: user,
    recipientPartyId: input.recipientPartyId,
    promptedValues: input.promptedValues,
    people: store.people,
    organisations: store.organisations,
    values: store.values,
    firm: {
      name: store.firm.shortName,
      legalName: store.firm.name,
    },
  });

  const res = await generateDocumentFromTemplate({
    ctx,
    repo,
    storage,
    engine,
    pdfConverter,
    catalogue,
    actor,
    config,
    templateId: input.templateId,
    sourceEntityType: input.sourceEntityType,
    matterAccessSubject: matter ? toMatterAccessSubject(matter) : null,
    primaryClientId,
    primaryClientEntityType,
    recipientPartyId: input.recipientPartyId ?? primaryClientId,
    recipientPartyEntityType:
      input.recipientPartyEntityType ?? primaryClientEntityType,
    practiceAreaId: practiceAreaLabel,
    matterTypeId: matterTypeLabel,
    teamId: userTeam?.name ?? null,
    outputFormat: input.outputFormat,
    resolutionContext,
  });

  if (res.status === 'generated' && res.document) {
    appendAudit(store, {
      recordType: matter
        ? 'matter'
        : organisation
          ? 'organisation'
          : 'person',
      recordId: matter?.id ?? primaryClientId ?? res.document.id,
      action: 'create',
      field: `Document Generated (${res.document.templateName} v${res.document.templateVersionNumber})`,
      oldValue: null,
      newValue: `${res.document.fileName} (${res.document.outputFormat.toUpperCase()})`,
      byId: user.id,
    });
  }

  persistRepositoryToStore(ctx, store, repo);
  return {
    status: res.status,
    document: res.document,
    downloadToken: res.downloadToken,
    fileBase64: res.outputBytes
      ? Buffer.from(res.outputBytes).toString('base64')
      : undefined,
    missingRequiredFields: res.missingRequiredFields,
  };
}

export async function downloadGeneratedDocumentService(
  documentId: string,
  userId: string,
  session?: VerifiedEntraSessionPayload,
): Promise<{
  fileBase64: string;
  fileName: string;
  mimeType: string;
  downloadToken: ScopedDownloadToken;
}> {
  const { store, ctx, user, config, repo, storage } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);

  const doc = repo.getDocumentById(ctx, documentId);
  if (!doc || doc.isDeleted) {
    throw new Error('DOCUMENT_NOT_FOUND: Document not found.');
  }

  const linkedMatters = [];
  if (doc.primaryMatterId) {
    const m = store.matters.find((x) => x.id === doc.primaryMatterId);
    if (m) linkedMatters.push(toMatterAccessSubject(m)!);
  }
  for (const link of repo.listLinksForDocument(ctx, doc.id)) {
    if (link.entityType === 'matter') {
      const m = store.matters.find((x) => x.id === link.entityId);
      if (m && !linkedMatters.some((x) => x.id === m.id)) {
        linkedMatters.push(toMatterAccessSubject(m)!);
      }
    }
  }

  if (!canActorAccessGeneratedDocument(actor, doc, linkedMatters, config)) {
    throw new Error(
      'DOCUMENT_ACCESS_DENIED: You do not have permission to view or download this document.',
    );
  }

  const downloadToken = await storage.issueScopedDownloadToken(ctx, {
    blobKey: doc.storageKey,
    fileName: doc.fileName,
    documentId: doc.id,
  });
  const bytes = await storage.getObjectBytes(ctx, {
    blobKey: doc.storageKey,
  });

  return {
    fileBase64: Buffer.from(bytes).toString('base64'),
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    downloadToken,
  };
}

export async function deleteGeneratedDocumentService(
  documentId: string,
  userId: string,
  session?: VerifiedEntraSessionPayload,
): Promise<GeneratedDocumentRecord> {
  const { store, ctx, user, config, repo, storage } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);

  const deleted = await deleteGeneratedDocument({
    ctx,
    repo,
    storage,
    actor,
    config,
    documentId,
    resolveMatterSubject: (matterId) => {
      const m = store.matters.find((x) => x.id === matterId);
      return m ? toMatterAccessSubject(m) : null;
    },
  });

  appendAudit(store, {
    recordType: deleted.primaryMatterId ? 'matter' : 'organisation',
    recordId: deleted.primaryMatterId ?? deleted.primaryClientId ?? deleted.id,
    action: 'delete',
    field: 'Generated Document Deleted',
    oldValue: deleted.fileName,
    newValue: 'Deleted',
    byId: user.id,
  });

  persistRepositoryToStore(ctx, store, repo);
  return deleted;
}

export interface EnrichedTemplateUsageReportResult
  extends TemplateUsageReportResult {
  userDisplayNamesById: Record<string, string>;
  csvContent: string;
}

export async function getTemplateUsageReportService(
  filter: TemplateUsageReportFilter = {},
  userId: string,
  session?: VerifiedEntraSessionPayload,
): Promise<EnrichedTemplateUsageReportResult> {
  const { store, ctx, user, config, repo } =
    await getInitializedDocGenContext(userId, session);
  const actor = buildDocumentActorFromPerson(user, ctx);

  const report = queryTemplateUsageReport({
    ctx,
    repo,
    actor,
    config,
    filter,
  });

  const userDisplayNamesById: Record<string, string> = {};
  if (report.userLevelDetailPermitted && report.byUser) {
    for (const u of report.byUser) {
      const found = store.people.find((p) => p.id === u.userId);
      userDisplayNamesById[u.userId] = found
        ? `${found.firstName} ${found.surname}`.trim() || found.id
        : u.userId;
    }
  }

  const csvContent = exportTemplateUsageReportCsv(
    report,
    report.userLevelDetailPermitted,
  );

  return {
    ...report,
    userDisplayNamesById,
    csvContent,
  };
}

export async function updateDocumentGenerationConfigService(
  patch: Partial<DocumentGenerationConfig>,
  userId: string,
  session?: VerifiedEntraSessionPayload,
): Promise<DocumentGenerationConfig> {
  const { store, ctx, user, config } = await getInitializedDocGenContext(
    userId,
    session,
  );
  const actor = buildDocumentActorFromPerson(user, ctx);

  const isSecuritySensitivePatch =
    patch.permissions !== undefined ||
    patch.approval?.allowSelfApproval !== undefined;
  const canUpdateConfig = isSecuritySensitivePatch
    ? hasPersonPermission(user, 'rbac:manage_config', { config }) ||
      hasPersonPermission(user, 'admin:access', { config })
    : hasDocumentPermission(actor, 'document_template:build', config) ||
      hasPersonPermission(user, 'rbac:manage_config', { config });

  if (!canUpdateConfig) {
    throw new Error(
      isSecuritySensitivePatch
        ? 'DOCUMENT_PERMISSION_DENIED: Updating RBAC or approval security settings requires "rbac:manage_config".'
        : 'DOCUMENT_PERMISSION_DENIED: Updating document generation settings requires "document_template:build".',
    );
  }

  const merged: DocumentGenerationConfig = {
    ...config.documentGeneration,
    ...patch,
    approval: {
      ...config.documentGeneration.approval,
      ...(patch.approval ?? {}),
    },
    usage: {
      ...config.documentGeneration.usage,
      ...(patch.usage ?? {}),
    },
    permissions: {
      roleDefaults: {
        ...(config.documentGeneration.permissions?.roleDefaults ?? {}),
        ...(patch.permissions?.roleDefaults ?? {}),
      },
    },
    customDocumentTypes:
      patch.customDocumentTypes ??
      config.documentGeneration.customDocumentTypes,
  };

  const validated = DocumentGenerationConfigSchema.parse(
    merged,
  ) as DocumentGenerationConfig;

  store.documentGenerationConfigOverride = validated;
  appendAudit(store, {
    recordType: 'matter',
    recordId: 'FIRM-DOCGEN-CONFIG',
    action: 'update',
    field: 'Document Generation Configuration Updated',
    oldValue: null,
    newValue: `Storage: ${validated.storageProvider}, Default Format: ${validated.defaultOutputFormat}, Self-Approval: ${validated.approval.allowSelfApproval}`,
    byId: user.id,
  });
  saveStore(store);

  return validated;
}
