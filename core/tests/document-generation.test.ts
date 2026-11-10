import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import {
  approveTemplateVersion,
  BasicMergeEngine,
  buildFullFieldCatalogueForTenant,
  BuiltInOpenXmlPdfConverter,
  buildValidDocxArchive,
  CORE_API_VERSION,
  CORE_FIELD_CATALOGUE,
  createOrUploadDraftTemplateVersion,
  deleteGeneratedDocument,
  executeUsageRetentionPurgeJob,
  exportTemplatePackage,
  exportTemplateUsageReportCsv,
  ExtensionHost,
  generateDocumentFromTemplate,
  getReadableCatalogueFieldsForActor,
  hasDocumentPermission,
  importTemplatePackage,
  isExcludedSensitiveEmployeeFieldKey,
  listAccessibleDocumentsForEntity,
  loadAndValidateTenantConfig,
  LocalTenantStorageProvider,
  previewTemplateVersion,
  queryTemplateUsageReport,
  rejectTemplateVersion,
  resolveDocumentPermissions,
  resolveTenantFromVerifiedToken,
  retireTemplate,
  rollbackTemplateToVersion,
  submitTemplateVersionForApproval,
  TenantDocumentRepository,
  TenantMigrationRunner,
  updateDraftTemplateVersion,
  createDocumentStorageProvider,
  type PlatformExtension,
} from '@platform/core';
import { GET as getDocumentDownloadRoute } from '@/app/api/documents/download/route';
import { GET as getMatterDocumentsRoute } from '@/app/api/matters/[id]/documents/route';
import { toMatterAccessSubject } from '@/domain/documentGeneration';
import { resolveEmployeeRoles } from '@/domain/homeConfig';
import { runWithActiveActorSession } from '@/domain/rbac';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import {
  getDocumentGenerationSnapshotForUser,
  getInitializedDocGenContext,
  resolveTenantBlobSigningKey,
  updateDocumentGenerationConfigService,
} from '@/server/documentGenerationServices';
import {
  createSignedEntraSessionCookie,
  isVerifiedEntraSessionPayload,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { getStore, saveStore } from '@/server/store';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import notALawFirmDevOverlay from '../../client-not-a-law-firm/config/environments/dev.json';

function buildTestSessionScopeForEmployee(personId: string) {
  const store = getStore();
  const tenantId = getActiveTenantConfiguration().tenantId;
  const emp = store.people.find((p) => p.id === personId);
  if (!emp) return null;
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const roles = resolveEmployeeRoles(emp, store.teams);
  const signed = createSignedEntraSessionCookie({
    personId: emp.id,
    oid:
      emp.entraObjectId ??
      `00000000-0000-4000-8000-${emp.id.replace(/\D/g, '').padStart(12, '0')}`,
    tid: '00000000-0000-4000-8000-000000000099',
    tenantId,
    sub: emp.id,
    email:
      emp.emails?.[0]?.address ?? `${emp.id.toLowerCase()}@notalawfirm.example`,
    displayName:
      `${emp.firstName ?? ''} ${emp.surname ?? ''}`.trim() || emp.id,
    entraRoles: roles,
    mappedRoles: roles,
    entraGroups: [],
    mfaVerified: true,
    amr: ['pwd', 'mfa'],
    authenticatedAt: nowIso,
    expiresAt,
  });
  const verified = verifySignedEntraSessionCookie(signed);
  if (!verified) return null;
  return {
    personId: emp.id,
    tenantId,
    tokenRoles: roles,
    expiresAtMs: Date.parse(expiresAt),
    verifiedSession: verified,
  };
}

function runAsTestEmployee<T>(personId: string, fn: () => T): T {
  const scope = buildTestSessionScopeForEmployee(personId);
  if (!scope) return fn();
  return runWithActiveActorSession(scope, fn);
}

describe('Document Generation — Unit, Contract, Isolation, Record-Access & Security Suite', () => {
  const baseTenantConfig = loadAndValidateTenantConfig(
    notALawFirmBaseConfig,
    notALawFirmDevOverlay,
    'dev',
    'multi_tenant',
  );

  const tenantAAdminToken = {
    __verifiedByOidcMiddleware: true as const,
    sub: 'P-ADMIN-1',
    tenantId: 'not-a-law-firm',
    email: 'admin@notalawfirm.example',
    name: 'Alice Vance',
    roles: ['admin', 'partner'],
    mfaVerified: true,
  };

  const tenantBAdminToken = {
    __verifiedByOidcMiddleware: true as const,
    sub: 'P-ADMIN-B1',
    tenantId: 'pembroke-vaughan',
    email: 'admin@pembrokevaughan.example',
    name: 'Bernard Sterling',
    roles: ['admin', 'managing_partner'],
    mfaVerified: true,
  };

  const ctxA = resolveTenantFromVerifiedToken({
    verifiedToken: tenantAAdminToken,
    hostingMode: 'multi_tenant',
    environment: 'dev',
    correlationId: 'corr-docgen-a',
  });

  const ctxB = resolveTenantFromVerifiedToken({
    verifiedToken: tenantBAdminToken,
    hostingMode: 'multi_tenant',
    environment: 'dev',
    correlationId: 'corr-docgen-b',
  });

  const configB = loadAndValidateTenantConfig(
    {
      ...notALawFirmBaseConfig,
      tenantId: 'pembroke-vaughan',
      displayName: 'Pembroke Vaughan LLP',
    },
    notALawFirmDevOverlay,
    'dev',
    'multi_tenant',
  );

  it('1. Coalesces split runs in Word XML, applies all filters, and escapes XML special characters', async () => {
    const engine = new BasicMergeEngine();

    // Construct a .docx where `{{ matter.reference | upper }}` and `{{ client.name }}` are split across <w:r> runs with <w:proofErr/>
    const splitRunDocx = buildValidDocxArchive({
      headerText: 'Ref: {{ matter.reference | upper }}',
      footerText: 'Generated on {{ date.today | date:"d MMMM yyyy" }}',
      paragraphs: [
        {
          rawRunsXml: [
            '<w:r><w:rPr><w:b/></w:rPr><w:t>{{</w:t></w:r>',
            '<w:proofErr w:type="spellStart"/>',
            '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> client.</w:t></w:r>',
            '<w:r><w:rPr><w:b/></w:rPr><w:t>name</w:t></w:r>',
            '<w:proofErr w:type="spellEnd"/>',
            '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> }}</w:t></w:r>',
          ].join(''),
        },
        {
          text: 'Fee Estimate: {{ financial.feeEstimate | currency }} ({{ financial.feeEstimate | words }})',
        },
        {
          text: 'Matter Title: {{ matter.title | title }}',
        },
        {
          text: 'Address Single: {{ client.primaryAddress | address_single }}',
        },
        {
          text: 'Address Multi:\n{{ client.primaryAddress | address_multi }}',
        },
      ],
    });

    const extracted = await engine.extractPlaceholders(splitRunDocx);
    expect(extracted.validationErrors).toHaveLength(0);
    const ids = extracted.placeholders.map((p) => p.identifier);
    expect(ids).toContain('matter.reference');
    expect(ids).toContain('date.today');
    expect(ids).toContain('client.name');
    expect(ids).toContain('financial.feeEstimate');
    expect(ids).toContain('matter.title');
    expect(ids).toContain('client.primaryAddress');

    const rendered = await engine.render({
      docxBytes: splitRunDocx,
      resolvedValues: {
        'matter.reference': 'pv-2026-0099',
        'date.today': '2026-04-20',
        'client.name': 'A & B <Holdings> "UK" Ltd',
        'financial.feeEstimate': 1250.5,
        'matter.title': 'share purchase agreement',
        'client.primaryAddress': {
          line1: '10 Bishopsgate',
          city: 'London',
          postcode: 'EC2N 4BQ',
        },
      },
      mappings: {},
    });

    expect(rendered.missingRequiredFields).toHaveLength(0);
    expect(rendered.outputBytes.length).toBeGreaterThan(200);

    // Convert to PDF using BuiltInOpenXmlPdfConverter and verify PDF header & content
    const pdfConverter = new BuiltInOpenXmlPdfConverter();
    const pdfBytes = await pdfConverter.convertDocxToPdf({
      docxBytes: rendered.outputBytes,
      title: 'Test Letter',
    });
    const pdfText = new TextDecoder('latin1').decode(pdfBytes);
    expect(pdfText.startsWith('%PDF-1.4')).toBe(true);
    expect(pdfText).toContain('PV-2026-0099');
    expect(pdfText).toContain('20 April 2026');
    expect(pdfText).toContain('A & B <Holdings> "UK" Ltd');
    expect(pdfText).toContain('1,250.50');
    expect(pdfText).toContain(
      'one thousand two hundred and fifty pounds and fifty pence',
    );
    expect(pdfText).toContain('Share Purchase Agreement');
    expect(pdfText).toContain('10 Bishopsgate, London, EC2N 4BQ');
  });

  it('2. Rejects reserved {% ... %} block syntax, .docm macros, and non-ZIP files', async () => {
    const engine = new BasicMergeEngine();

    const blockDocx = buildValidDocxArchive({
      paragraphs: [
        {
          text: '{% if matter.isHighValue %}High value clause{% endif %}',
        },
      ],
    });

    const extraction = await engine.extractPlaceholders(blockDocx);
    expect(extraction.validationErrors.length).toBeGreaterThan(0);
    expect(extraction.validationErrors[0]?.code).toBe(
      'RESERVED_BLOCK_SYNTAX_UNSUPPORTED',
    );

    await expect(
      engine.render({
        docxBytes: blockDocx,
        resolvedValues: {},
        mappings: {},
      }),
    ).rejects.toThrow(/RESERVED_BLOCK_SYNTAX_UNSUPPORTED/);

    // Macro archive containing word/vbaProject.bin is rejected
    const macroDocx = buildValidDocxArchive({
      paragraphs: [{ text: 'Hello {{ client.name }}' }],
      extraEntries: [
        {
          fileName: 'word/vbaProject.bin',
          data: new Uint8Array([1, 2, 3, 4]),
        },
      ],
    });

    await expect(engine.extractPlaceholders(macroDocx)).rejects.toThrow(
      /DOCX_MACRO_REJECTED/,
    );

    // Non-ZIP bytes rejected
    await expect(
      engine.extractPlaceholders(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])),
    ).rejects.toThrow(/DOCX_INVALID_SIGNATURE/);
  });

  it('3. Excludes all HR, payroll, and sensitive employee fields from the Field Catalogue and extensions', async () => {
    const forbiddenSamples = [
      'employee.salary',
      'feeEarner.payrollId',
      'feeEarner.bankAccountNumber',
      'feeEarner.sortCode',
      'feeEarner.niNumber',
      'feeEarner.taxCode',
      'feeEarner.rightToWorkStatus',
      'feeEarner.emergencyContactName',
      'feeEarner.homeAddress',
      'feeEarner.personalEmail',
      'feeEarner.diversityEthnicity',
      'feeEarner.disabilityStatus',
      'feeEarner.reasonableAdjustments',
      'user.salaryGbp',
      'user.sicknessDays',
      'user.disciplinaryRecord',
    ];

    for (const sample of forbiddenSamples) {
      expect(isExcludedSensitiveEmployeeFieldKey(sample)).toBe(true);
    }

    for (const entry of CORE_FIELD_CATALOGUE) {
      expect(isExcludedSensitiveEmployeeFieldKey(entry.key)).toBe(false);
      expect(['document:generate', 'finance:view', 'employee:view_core']).toContain(
        entry.requiredPermission,
      );
    }

    // Verify FieldProvider extension host blocks sensitive employee fields and enforces permissions
    const host = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });

    const unauthorizedExt: PlatformExtension = {
      manifest: {
        id: 'unauth-field-ext',
        name: 'Missing Permission Extension',
        version: '1.0.0',
        description: 'Tries to provide fields without document:fields:provide',
        supportedCoreApiRange: '^1.0.0',
        permissions: ['matter:read'],
        hooks: ['provideDocumentFields'],
      },
      hooks: {},
    };

    expect(() => host.registerExtension(unauthorizedExt)).toThrow(
      /EXTENSION_PERMISSION_ERROR/,
    );

    const validFieldExt: PlatformExtension = {
      manifest: {
        id: 'corp-completion-fields',
        name: 'Corporate Completion Field Provider',
        version: '1.0.0',
        description: 'Provides calculated completion fields and tests HR blocklist',
        supportedCoreApiRange: '^1.0.0',
        permissions: ['document:fields:provide', 'matter:read'],
        hooks: ['provideDocumentFields'],
      },
      hooks: {
        provideDocumentFields(_ctx, input) {
          return {
            definitions: [
              {
                key: 'completionLongStopDate',
                displayName: 'Completion Long-Stop Date',
                description: 'Calculated long-stop date from matter opening',
                group: 'Matter',
                dataType: 'date',
                requiredPermission: 'document:generate',
                requiredEntityPermission: 'matter:read',
              },
              {
                key: 'feeEarner.salary', // Should be blocked by security filter!
                displayName: 'Leaked Salary',
                description: 'Should never pass',
                group: 'Fee Earner',
                dataType: 'currency',
                requiredPermission: 'employee:view_core',
                requiredEntityPermission: 'matter:read',
              },
            ],
            values: {
              completionLongStopDate: '2026-09-30',
              'feeEarner.salary': 120000,
              echoMatterId: input.matterId,
            },
          };
        },
      },
    };

    host.registerExtension(validFieldExt);
    const extResult = await host.executeFieldProviders(
      ctxA,
      {
        ...baseTenantConfig,
        enabledExtensions: ['corp-completion-fields'],
      },
      {
        sourceEntityType: 'matter',
        matterId: 'M-0001',
        matter: { id: 'M-0001' },
      },
    );

    expect(extResult.catalogueEntries).toHaveLength(1);
    expect(extResult.catalogueEntries[0]?.key).toBe(
      'ext.corp-completion-fields.completionLongStopDate',
    );
    expect(
      extResult.resolvedValues[
        'ext.corp-completion-fields.completionLongStopDate'
      ],
    ).toBe('2026-09-30');
    expect(
      extResult.resolvedValues['ext.corp-completion-fields.feeEarner.salary'],
    ).toBeUndefined();
    expect(extResult.isolatedErrors[0]).toContain('restricted HR/payroll');
  });

  it('4. Enforces DocumentPermission resolution from full role set (ignoring Viewing-As role) and finance:view gating', () => {
    const partnerViewingAsSecretary = {
      id: 'P-PARTNER-1',
      tenantId: baseTenantConfig.tenantId,
      roles: ['partner'],
      activeViewingRole: 'legal_secretary', // UI "Viewing as" switcher
    };

    const secretaryActor = {
      id: 'P-SEC-1',
      tenantId: baseTenantConfig.tenantId,
      roles: ['legal_secretary'],
    };

    // Partner still holds finance:view and document_template:view_usage despite "Viewing as" legal_secretary
    const partnerPerms = resolveDocumentPermissions(
      partnerViewingAsSecretary,
      baseTenantConfig,
    );
    expect(partnerPerms).toContain('finance:view');
    expect(partnerPerms).toContain('document_template:view_usage');

    // Legal secretary has document:generate and document:view, but NOT finance:view or document_template:build
    expect(
      hasDocumentPermission(secretaryActor, 'document:generate', baseTenantConfig),
    ).toBe(true);
    expect(
      hasDocumentPermission(secretaryActor, 'finance:view', baseTenantConfig),
    ).toBe(false);
    expect(
      hasDocumentPermission(
        secretaryActor,
        'document_template:build',
        baseTenantConfig,
      ),
    ).toBe(false);

    // Readable catalogue fields exclude Financial group for secretaryActor
    const secretaryFields = getReadableCatalogueFieldsForActor(
      secretaryActor,
      CORE_FIELD_CATALOGUE,
      baseTenantConfig,
    );
    expect(secretaryFields.some((f) => f.group === 'Financial')).toBe(false);

    const partnerFields = getReadableCatalogueFieldsForActor(
      partnerViewingAsSecretary,
      CORE_FIELD_CATALOGUE,
      baseTenantConfig,
    );
    expect(partnerFields.some((f) => f.group === 'Financial')).toBe(true);
  });

  it('5. Enforces approval workflow, blocks unmapped placeholders & self-approval, and supports rollback & package transfer', async () => {
    const repo = new TenantDocumentRepository();
    const storage = new LocalTenantStorageProvider({ inMemoryOnly: true });
    const engine = new BasicMergeEngine();
    const catalogue = buildFullFieldCatalogueForTenant({
      customFields: baseTenantConfig.customFields,
    });

    const builderActor = {
      id: 'P-BUILDER-1',
      tenantId: ctxA.tenantId,
      roles: ['admin', 'managing_partner'],
    };
    const secondApproverActor = {
      id: 'P-APPROVER-2',
      tenantId: ctxA.tenantId,
      roles: ['risk_compliance'],
    };

    const docxV1 = buildValidDocxArchive({
      paragraphs: [
        { text: 'Our Ref: {{ matter.reference }}' },
        { text: 'Client: {{ client.name }}' },
        { text: 'Custom Unmapped Token: {{ CustomRefToken }}' },
      ],
    });

    const draft1 = await createOrUploadDraftTemplateVersion({
      ctx: ctxA,
      repo,
      storage,
      engine,
      catalogue,
      actor: builderActor,
      config: baseTenantConfig,
      input: {
        code: 'ENG-LETTER-01',
        name: 'Standard Engagement Letter',
        description: 'Client engagement letter',
        category: 'Client Care',
        outputDocumentType: 'client_care',
        filenamePattern: '{{matter.reference}} - Engagement Letter',
        availabilityRules: {
          sourceContexts: ['matter'],
        },
        fileName: 'engagement-letter.docx',
        docxBytes: docxV1,
      },
    });

    // `matter.reference` and `client.name` auto-map, while `CustomRefToken` is flagged as unmapped
    expect(draft1.unmappedPlaceholders).toEqual(['CustomRefToken']);

    // Submitting while `CustomRefToken` is unmapped is blocked
    await expect(submitTemplateVersionForApproval({
        ctx: ctxA,
        repo,
        catalogue,
        actor: builderActor,
        config: baseTenantConfig,
        versionId: draft1.version.id,
      })).rejects.toThrow(/TEMPLATE_UNMAPPED_PLACEHOLDERS/);

    // Map `CustomRefToken` as a Prompted Field
    await updateDraftTemplateVersion({
      ctx: ctxA,
      repo,
      catalogue,
      actor: builderActor,
      config: baseTenantConfig,
      versionId: draft1.version.id,
      promptedFields: [
        {
          key: 'specialInstructionNote',
          label: 'Special Instruction Note',
          fieldType: 'text',
          required: true,
        },
      ],
      fieldMappings: {
        ...draft1.version.fieldMappings,
        CustomRefToken: {
          placeholder: 'CustomRefToken',
          sourceType: 'prompted',
          promptedKey: 'specialInstructionNote',
          required: true,
        },
      },
    });

    // Now submit succeeds
    const submitted1 = await submitTemplateVersionForApproval({
      ctx: ctxA,
      repo,
      catalogue,
      actor: builderActor,
      config: baseTenantConfig,
      versionId: draft1.version.id,
    });
    expect(submitted1.version.status).toBe('Submitted');

    // Self-approval by `builderActor` is blocked when `allowSelfApproval` is false (default)
    await expect(approveTemplateVersion({
        ctx: ctxA,
        repo,
        actor: builderActor,
        config: baseTenantConfig,
        versionId: draft1.version.id,
      })).rejects.toThrow(/TEMPLATE_SELF_APPROVAL_FORBIDDEN/);

    // Second approver (`secondApproverActor`) approves v1 -> Active
    const approved1 = await approveTemplateVersion({
      ctx: ctxA,
      repo,
      actor: secondApproverActor,
      config: baseTenantConfig,
      versionId: draft1.version.id,
    });
    expect(approved1.version.status).toBe('Active');
    expect(approved1.template.activeVersionId).toBe(approved1.version.id);

    // Upload v2, submit, approve -> v1 becomes Retired, v2 becomes Active
    const docxV2 = buildValidDocxArchive({
      paragraphs: [
        { text: 'Our Ref: {{ matter.reference }} (v2)' },
        { text: 'Client: {{ client.name }}' },
      ],
    });
    const draft2 = await createOrUploadDraftTemplateVersion({
      ctx: ctxA,
      repo,
      storage,
      engine,
      catalogue,
      actor: builderActor,
      config: baseTenantConfig,
      input: {
        templateId: approved1.template.id,
        code: 'ENG-LETTER-01',
        name: 'Standard Engagement Letter',
        description: 'Client engagement letter v2',
        category: 'Client Care',
        outputDocumentType: 'client_care',
        filenamePattern: '{{matter.reference}} - Engagement Letter',
        availabilityRules: { sourceContexts: ['matter'] },
        fileName: 'engagement-letter-v2.docx',
        docxBytes: docxV2,
      },
    });
    await submitTemplateVersionForApproval({
      ctx: ctxA,
      repo,
      catalogue,
      actor: builderActor,
      config: baseTenantConfig,
      versionId: draft2.version.id,
    });
    const approved2 = await approveTemplateVersion({
      ctx: ctxA,
      repo,
      actor: secondApproverActor,
      config: baseTenantConfig,
      versionId: draft2.version.id,
    });
    expect(approved2.template.activeVersionId).toBe(draft2.version.id);
    expect((await repo.getTemplateVersionById(ctxA, draft1.version.id))?.status).toBe(
      'Retired',
    );

    // Roll back from v2 to v1
    const rolledBack = await rollbackTemplateToVersion({
      ctx: ctxA,
      repo,
      actor: secondApproverActor,
      config: baseTenantConfig,
      templateId: approved1.template.id,
      targetVersionId: draft1.version.id,
    });
    expect(rolledBack.template.activeVersionId).toBe(draft1.version.id);
    expect(rolledBack.activeVersion.status).toBe('Active');

    // Export package from Tenant A and import into Tenant B -> arrives in Tenant B as `Draft`
    const exportedPkg = await exportTemplatePackage({
      ctx: ctxA,
      repo,
      storage,
      actor: builderActor,
      config: baseTenantConfig,
      templateId: approved1.template.id,
    });
    const importedInB = await importTemplatePackage({
      ctx: ctxB,
      repo,
      storage,
      engine,
      catalogue,
      actor: { id: 'P-ADMIN-B1', tenantId: ctxB.tenantId, roles: ['admin'] },
      config: configB,
      pkg: exportedPkg,
    });
    expect(importedInB.version.status).toBe('Draft');
    expect(importedInB.template.status).toBe('Draft');
  });

  it('6. Enforces two-tenant isolation and restricted staff-matter inheritance across Matter and Client screens', async () => {
    const repo = new TenantDocumentRepository();
    const storage = new LocalTenantStorageProvider({ inMemoryOnly: true });
    const engine = new BasicMergeEngine();
    const catalogue = buildFullFieldCatalogueForTenant();

    const builderA = { id: 'P-BUILD-A', tenantId: ctxA.tenantId, roles: ['admin'] };
    await repo.offboardTenantData(ctxA);
    await repo.offboardTenantData(ctxB);
    const approverA = { id: 'P-APP-A', tenantId: ctxA.tenantId, roles: ['risk_compliance'] };
    const feeEarnerAssigned = { id: 'P-FE-ASSIGNED', tenantId: ctxA.tenantId, roles: ['fee_earner'] };
    const feeEarnerUnassigned = { id: 'P-FE-OTHER', tenantId: ctxA.tenantId, roles: ['fee_earner'] };

    const docxBytes = buildValidDocxArchive({
      paragraphs: [
        { text: 'Matter Ref: {{ matter.reference }}' },
        { text: 'Client Name: {{ client.name }}' },
        { text: 'Special Prompt: {{ prompted.specialTerm }}' },
      ],
    });

    const created = await createOrUploadDraftTemplateVersion({
      ctx: ctxA,
      repo,
      storage,
      engine,
      catalogue,
      actor: builderA,
      config: baseTenantConfig,
      input: {
        code: 'MATTER-LETTER',
        name: 'Matter Advice Letter',
        description: 'General advice letter',
        category: 'Correspondence',
        outputDocumentType: 'letter',
        filenamePattern: '{{matter.reference}} - Advice Letter',
        availabilityRules: { sourceContexts: ['matter', 'client'] },
        fileName: 'advice.docx',
        docxBytes,
        promptedFields: [
          {
            key: 'specialTerm',
            label: 'Special Term',
            fieldType: 'text',
            required: true,
          },
        ],
        fieldMappings: {
          'matter.reference': {
            placeholder: 'matter.reference',
            sourceType: 'catalogue',
            catalogueKey: 'matter.reference',
            required: true,
          },
          'client.name': {
            placeholder: 'client.name',
            sourceType: 'catalogue',
            catalogueKey: 'client.name',
            required: true,
          },
          'prompted.specialTerm': {
            placeholder: 'prompted.specialTerm',
            sourceType: 'prompted',
            promptedKey: 'specialTerm',
            required: true,
          },
        },
      },
    });

    await submitTemplateVersionForApproval({
      ctx: ctxA,
      repo,
      catalogue,
      actor: builderA,
      config: baseTenantConfig,
      versionId: created.version.id,
    });
    await approveTemplateVersion({
      ctx: ctxA,
      repo,
      actor: approverA,
      config: baseTenantConfig,
      versionId: created.version.id,
    });

    const restrictedMatter = {
      id: 'MAT-STAFF-01',
      clientId: 'CLI-STAFF-01',
      isStaffMatter: true,
      restrictedAccessUserIds: ['P-FE-ASSIGNED'],
      responsibleSolicitorId: 'P-FE-ASSIGNED',
    };

    // Unassigned fee earner is blocked from generating on the restricted staff matter
    await expect(
      generateDocumentFromTemplate({
        ctx: ctxA,
        repo,
        storage,
        engine,
        catalogue,
        actor: feeEarnerUnassigned,
        config: baseTenantConfig,
        templateId: created.template.id,
        sourceEntityType: 'matter',
        matterAccessSubject: restrictedMatter,
        primaryClientId: 'CLI-STAFF-01',
        primaryClientEntityType: 'person',
        resolutionContext: {
          tenantId: ctxA.tenantId,
          matter: { id: 'MAT-STAFF-01', reference: 'PV-STAFF-01' },
          client: { id: 'CLI-STAFF-01', name: 'Staff Member Client' },
          promptedValues: { specialTerm: 'Confidential term' },
        },
      }),
    ).rejects.toThrow(/DOCUMENT_RECORD_ACCESS_DENIED/);

    // Assigned fee earner attempting generation with missing required prompted field gets `blocked_missing_required`
    const blockedAttempt = await generateDocumentFromTemplate({
      ctx: ctxA,
      repo,
      storage,
      engine,
      catalogue,
      actor: feeEarnerAssigned,
      config: baseTenantConfig,
      templateId: created.template.id,
      sourceEntityType: 'matter',
      matterAccessSubject: restrictedMatter,
      primaryClientId: 'CLI-STAFF-01',
      primaryClientEntityType: 'person',
      resolutionContext: {
        tenantId: ctxA.tenantId,
        matter: { id: 'MAT-STAFF-01', reference: 'PV-STAFF-01' },
        client: { id: 'CLI-STAFF-01', name: 'Staff Member Client' },
        promptedValues: { specialTerm: '' }, // Empty required field!
      },
    });
    expect(blockedAttempt.status).toBe('blocked_missing_required');
    expect(blockedAttempt.missingRequiredFields).toContain(
      'prompted.specialTerm',
    );

    // Assigned fee earner generates PDF document with all required fields populated
    const generatedRes = await generateDocumentFromTemplate({
      ctx: ctxA,
      repo,
      storage,
      engine,
      catalogue,
      actor: feeEarnerAssigned,
      config: baseTenantConfig,
      templateId: created.template.id,
      sourceEntityType: 'matter',
      matterAccessSubject: restrictedMatter,
      primaryClientId: 'CLI-STAFF-01',
      primaryClientEntityType: 'person',
      practiceAreaId: 'Employment',
      matterTypeId: 'Executive Severance',
      teamId: 'TEAM-EMP',
      outputFormat: 'pdf',
      resolutionContext: {
        tenantId: ctxA.tenantId,
        matter: { id: 'MAT-STAFF-01', reference: 'PV-STAFF-01' },
        client: { id: 'CLI-STAFF-01', name: 'Staff Member Client' },
        promptedValues: { specialTerm: 'Agreed settlement clause' },
      },
    });

    expect(generatedRes.status).toBe('generated');
    expect(generatedRes.document?.outputFormat).toBe('pdf');
    expect(generatedRes.document?.fileName).toBe(
      'PV-STAFF-01 - Advice Letter.pdf',
    );

    const resolveMatter = (id: string) =>
      id === 'MAT-STAFF-01' ? restrictedMatter : null;

    // Assigned fee earner sees the document on BOTH the Matter screen and the Client screen
    expect(
      await listAccessibleDocumentsForEntity({
        ctx: ctxA,
        repo,
        actor: feeEarnerAssigned,
        config: baseTenantConfig,
        entityType: 'matter',
        entityId: 'MAT-STAFF-01',
        resolveMatterSubject: resolveMatter,
      }),
    ).toHaveLength(1);

    expect(
      await listAccessibleDocumentsForEntity({
        ctx: ctxA,
        repo,
        actor: feeEarnerAssigned,
        config: baseTenantConfig,
        entityType: 'person',
        entityId: 'CLI-STAFF-01',
        resolveMatterSubject: resolveMatter,
      }),
    ).toHaveLength(1);

    // Unassigned fee earner CANNOT see the document on the Matter screen OR on the Client (`person`) screen!
    expect(
      await listAccessibleDocumentsForEntity({
        ctx: ctxA,
        repo,
        actor: feeEarnerUnassigned,
        config: baseTenantConfig,
        entityType: 'matter',
        entityId: 'MAT-STAFF-01',
        resolveMatterSubject: resolveMatter,
      }),
    ).toHaveLength(0);

    expect(
      await listAccessibleDocumentsForEntity({
        ctx: ctxA,
        repo,
        actor: feeEarnerUnassigned,
        config: baseTenantConfig,
        entityType: 'person',
        entityId: 'CLI-STAFF-01',
        resolveMatterSubject: resolveMatter,
      }),
    ).toHaveLength(0);

    // TWO-TENANT ISOLATION: Tenant B cannot read Tenant A's template, document, blob, or download token
    expect(await repo.getTemplateById(ctxB, created.template.id)).toBeNull();
    expect(
      await repo.getDocumentById(ctxB, generatedRes.document!.id),
    ).toBeNull();
    await expect(
      storage.getObjectBytes(ctxB, {
        blobKey: generatedRes.document!.storageKey,
      }),
    ).rejects.toThrow(/STORAGE_TENANCY_ISOLATION_ERROR/);
    await expect(
      storage.verifyScopedDownloadToken(
        ctxB,
        generatedRes.downloadToken!.token,
      ),
    ).rejects.toThrow(/STORAGE_TOKEN_FORGERY/);

    // Usage reporting & dual user-level gate (`document_template:view_usage_by_user` + `showUserLevelDetail`)
    const partnerActor = { id: 'P-PARTNER-1', tenantId: ctxA.tenantId, roles: ['partner'] };
    const partnerReport = await queryTemplateUsageReport({
      ctx: ctxA,
      repo,
      actor: partnerActor,
      config: baseTenantConfig,
    });
    expect(partnerReport.totalGeneratedCount).toBe(1);
    expect(partnerReport.totalBlockedMissingRequiredCount).toBe(1);
    expect(partnerReport.userLevelDetailPermitted).toBe(false);
    expect(partnerReport.byUser).toBeUndefined();

    const adminReport = await queryTemplateUsageReport({
      ctx: ctxA,
      repo,
      actor: builderA, // Admin has `document_template:view_usage_by_user`
      config: baseTenantConfig,
    });
    expect(adminReport.userLevelDetailPermitted).toBe(true);
    expect(adminReport.byUser).toHaveLength(1);
    expect(adminReport.byUser?.[0]?.userId).toBe('P-FE-ASSIGNED');

    const csv = exportTemplateUsageReportCsv(adminReport, true);
    expect(csv).toContain('MATTER-LETTER');
    expect(csv).toContain('P-FE-ASSIGNED');

    // When `showUserLevelDetail` is false in tenant config, even Admin cannot see `byUser`
    const adminReportPrivacyOff = await queryTemplateUsageReport({
      ctx: ctxA,
      repo,
      actor: builderA,
      config: {
        ...baseTenantConfig,
        documentGeneration: {
          ...baseTenantConfig.documentGeneration,
          usage: {
            ...baseTenantConfig.documentGeneration.usage,
            showUserLevelDetail: false,
          },
        },
      },
    });
    expect(adminReportPrivacyOff.userLevelDetailPermitted).toBe(false);
    expect(adminReportPrivacyOff.byUser).toBeUndefined();

    // Retention purge background job & delete document
    const purgeResult = await executeUsageRetentionPurgeJob(ctxA, repo, {
      jobId: 'JOB-RETENTION-1',
      tenantId: ctxA.tenantId,
      correlationId: ctxA.correlationId,
      payload: {
        retentionMonths: 12,
        nowIso: '2029-01-01T00:00:00Z',
      },
    });
    expect(purgeResult.purgedEventsCount).toBe(2);

    await deleteGeneratedDocument({
      ctx: ctxA,
      repo,
      storage,
      actor: builderA,
      config: baseTenantConfig,
      documentId: generatedRes.document!.id,
      resolveMatterSubject: resolveMatter,
    });
    expect(
      (await repo.getDocumentById(ctxA, generatedRes.document!.id))?.isDeleted,
    ).toBe(true);
  });

  it('7. Verifies per-tenant reversible database migrations (up, rollback, re-apply)', async () => {
    const runner = new TenantMigrationRunner();
    try {
      await runner.applyUp(ctxA);
      expect(await runner.listAppliedMigrations(ctxA)).toHaveLength(6);
      expect(await runner.getActiveTables(ctxA)).toContain('document_templates');
      expect(await runner.getActiveTables(ctxA)).toContain('template_usage_daily_summaries');
      expect(await runner.getActiveTables(ctxA)).toContain('matter_document_locations');
      expect(await runner.getActiveTables(ctxA)).toContain('key_dates');

      // Roll back migrations in reverse order down to 0001 on Tenant A (leaving Tenant B untouched!)
      expect(await runner.rollbackVersion(ctxA, '0006')).toBe(true);
      expect(await runner.rollbackVersion(ctxA, '0005')).toBe(true);
      expect(await runner.rollbackVersion(ctxA, '0004')).toBe(true);
      expect(await runner.rollbackVersion(ctxA, '0003')).toBe(true);
      expect(await runner.rollbackVersion(ctxA, '0002')).toBe(true);
      const rolledBack = await runner.rollbackVersion(ctxA, '0001');
      expect(rolledBack).toBe(true);
      expect(await runner.getActiveTables(ctxA)).not.toContain('document_templates');
      expect(await runner.getActiveTables(ctxB)).toContain('document_templates');

      // Re-apply cleanly
      const reapplied = await runner.applyUp(ctxA);
      expect(reapplied).toHaveLength(6);
      expect(await runner.getActiveTables(ctxA)).toContain('documents');
    } finally {
      await runner.applyUp(ctxA);
    }
  });

  it('8. Enforces R1, R15, R17, R24: requires explicit signing key, binds download tokens to sub and documentId, uses timingSafeEqual, and rejects unimplemented azure_blob provider', async () => {
    // R1: Missing or short signing key must throw STORAGE_CONFIG_ERROR
    expect(() => new LocalTenantStorageProvider('')).toThrow(
      /STORAGE_CONFIG_ERROR/,
    );
    expect(() => new LocalTenantStorageProvider('short-key')).toThrow(
      /STORAGE_CONFIG_ERROR/,
    );

    // R15: azure_blob must throw STORAGE_PROVIDER_NOT_SUPPORTED rather than writing to local disk
    expect(() =>
      createDocumentStorageProvider(
        'azure_blob',
        'test-signing-key-at-least-16-chars',
      ),
    ).toThrow(/STORAGE_PROVIDER_NOT_SUPPORTED/);

    // R17 & R24: Scoped download token binds sub (actorId) and documentId, and rejects another user or tampered signature
    const storage = new LocalTenantStorageProvider({
      inMemoryOnly: true,
      tokenSigningKey: 'tenant-a-secret-signing-key-32bytes!',
    });
    const ctxUserA = resolveTenantFromVerifiedToken({
      verifiedToken: {
        ...tenantAAdminToken,
        sub: 'P-USER-A',
      },
      hostingMode: 'multi_tenant',
      environment: 'dev',
      correlationId: 'corr-dl-a',
    });
    const ctxUserB = resolveTenantFromVerifiedToken({
      verifiedToken: {
        ...tenantAAdminToken,
        sub: 'P-USER-B',
      },
      hostingMode: 'multi_tenant',
      environment: 'dev',
      correlationId: 'corr-dl-b',
    });

    const stored = await storage.putObject(ctxUserA, {
      category: 'documents',
      objectId: 'DOC-100',
      fileName: 'letter.docx',
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });

    const issued = await storage.issueScopedDownloadToken(
      ctxUserA,
      {
        blobKey: stored.blobKey,
        fileName: 'letter.docx',
        documentId: 'DOC-100',
      },
      300,
    );

    const verifiedA = await storage.verifyScopedDownloadToken(
      ctxUserA,
      issued.token,
    );
    expect(verifiedA.sub).toBe('P-USER-A');
    expect(verifiedA.documentId).toBe('DOC-100');
    expect(verifiedA.blobKey).toBe(stored.blobKey);

    // User B in the same tenant cannot redeem User A's download token
    await expect(
      storage.verifyScopedDownloadToken(ctxUserB, issued.token),
    ).rejects.toThrow(/STORAGE_TOKEN_ACTOR_MISMATCH|STORAGE_TOKEN_FORGERY/);

    // Tampered signature of different or same length is rejected
    const [payloadPart, sigPart] = issued.token.split('.');
    await expect(
      storage.verifyScopedDownloadToken(ctxUserA, `${payloadPart}.deadbeef`),
    ).rejects.toThrow(/STORAGE_TOKEN_FORGERY/);

    // R24: Flipping a single hex character in a valid token's signature (keeping the same length) is rejected
    const flippedFirstChar = sigPart![0] === 'a' ? 'b' : 'a';
    const sameLengthTamperedSig = `${flippedFirstChar}${sigPart!.slice(1)}`;
    expect(sameLengthTamperedSig.length).toBe(sigPart!.length);
    await expect(
      storage.verifyScopedDownloadToken(
        ctxUserA,
        `${payloadPart}.${sameLengthTamperedSig}`,
      ),
    ).rejects.toThrow(/STORAGE_TOKEN_FORGERY/);

    // R1 & R22: Token hand-signed with the old constant 'platform-scoped-blob-token-key-v1:<tenantId>' is rejected by both core storage and host getDocumentStorage()
    const oldSigningSecret = `platform-scoped-blob-token-key-v1:${ctxUserA.tenantId}`;
    const forgedSigWithOldKey = crypto
      .createHmac('sha256', oldSigningSecret)
      .update(payloadPart!)
      .digest('hex');
    await expect(
      storage.verifyScopedDownloadToken(
        ctxUserA,
        `${payloadPart}.${forgedSigWithOldKey}`,
      ),
    ).rejects.toThrow(/STORAGE_TOKEN_FORGERY/);

    const hostInit = await runAsTestEmployee('P-000004', () =>
      getInitializedDocGenContext('P-000004'),
    );
    const hostIssued = await hostInit.storage.issueScopedDownloadToken(
      hostInit.ctx,
      {
        blobKey: `${hostInit.ctx.blobContainerName}/documents/DOC-HOST-1/v1.docx`,
        fileName: 'host-letter.docx',
        documentId: 'DOC-HOST-1',
      },
      300,
    );
    const [hostPayloadPart] = hostIssued.token.split('.');
    const hostForgedSigWithOldKey = crypto
      .createHmac(
        'sha256',
        `platform-scoped-blob-token-key-v1:${hostInit.ctx.tenantId}`,
      )
      .update(hostPayloadPart!)
      .digest('hex');
    await expect(
      hostInit.storage.verifyScopedDownloadToken(
        hostInit.ctx,
        `${hostPayloadPart}.${hostForgedSigWithOldKey}`,
      ),
    ).rejects.toThrow(/STORAGE_TOKEN_FORGERY/);

    // R1 & R213: Outside test mode, resolveTenantBlobSigningKey throws when PLATFORM_BLOB_SIGNING_KEY is unset in production/live/training, and uses an ephemeral per-process key in development (dev/test only)
    const prevKey = process.env.PLATFORM_BLOB_SIGNING_KEY;
    const prevAuth = process.env.AUTH_SECRET;
    const prevVitest = process.env.VITEST;
    const prevNodeEnv = process.env.NODE_ENV;
    const prevPlatformEnv = process.env.PLATFORM_ENVIRONMENT;
    try {
      delete process.env.PLATFORM_BLOB_SIGNING_KEY;
      process.env.AUTH_SECRET = 'some-auth-secret-that-must-not-be-used';
      delete process.env.VITEST;

      // 1. NODE_ENV=development + environment 'live' throws STORAGE_CONFIG_ERROR
      (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
      process.env.PLATFORM_ENVIRONMENT = 'live';
      expect(() => resolveTenantBlobSigningKey('not-a-law-firm')).toThrow(
        /STORAGE_CONFIG_ERROR/,
      );

      // 2. NODE_ENV=development + environment 'training' throws STORAGE_CONFIG_ERROR
      process.env.PLATFORM_ENVIRONMENT = 'training';
      expect(() => resolveTenantBlobSigningKey('not-a-law-firm')).toThrow(
        /STORAGE_CONFIG_ERROR/,
      );

      // 3 & 4. NODE_ENV=development + environment 'dev' returns a 64-char hex key not derived from the test literal, and stays consistent across calls in the same process
      process.env.PLATFORM_ENVIRONMENT = 'dev';
      const testLiteralKey = crypto
        .createHmac('sha256', 'test-host-blob-signing-key-from-vault')
        .update('tenant-blob-signing:not-a-law-firm')
        .digest('hex');
      const devKey1 = resolveTenantBlobSigningKey('not-a-law-firm');
      const devKey2 = resolveTenantBlobSigningKey('not-a-law-firm');
      expect(devKey1).toMatch(/^[0-9a-f]{64}$/);
      expect(devKey1).not.toBe(testLiteralKey);
      expect(devKey2).toBe(devKey1);

      // 5. NODE_ENV=production throws STORAGE_CONFIG_ERROR
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      expect(() => resolveTenantBlobSigningKey('not-a-law-firm')).toThrow(
        /STORAGE_CONFIG_ERROR/,
      );
    } finally {
      if (prevKey === undefined) delete process.env.PLATFORM_BLOB_SIGNING_KEY;
      else process.env.PLATFORM_BLOB_SIGNING_KEY = prevKey;
      if (prevAuth === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = prevAuth;
      if (prevVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = prevVitest;
      (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
      if (prevPlatformEnv === undefined) delete process.env.PLATFORM_ENVIRONMENT;
      else process.env.PLATFORM_ENVIRONMENT = prevPlatformEnv;
    }

    // Verified Entra session payload is a plain object without Symbol properties (safe for React Server-to-Client component serialization)
    const signedCookie = createSignedEntraSessionCookie({
      personId: 'P-000001',
      tenantId: 'not-a-law-firm',
      oid: '00000000-0000-0000-0000-000000000001',
      tid: '00000000-0000-0000-0000-000000000099',
      sub: 'sub-p-000001',
      email: 'rhian.morgan@notalawfirm.example',
      displayName: 'Rhian Morgan',
      entraRoles: ['partner'],
      mappedRoles: ['partner'],
      entraGroups: [],
      mfaVerified: true,
      amr: ['pwd', 'mfa'],
      authenticatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const verifiedSession = verifySignedEntraSessionCookie(signedCookie);
    expect(verifiedSession).not.toBeNull();
    expect(isVerifiedEntraSessionPayload(verifiedSession)).toBe(true);
    expect(Object.getOwnPropertySymbols(verifiedSession!)).toHaveLength(0);

    // R22: Forged untrustedRequestTenantOverride is rejected with TENANCY_FORGERY_DETECTED
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: tenantAAdminToken,
        hostingMode: 'multi_tenant',
        environment: 'dev',
        correlationId: 'corr-forged',
        untrustedRequestTenantOverride: 'forged-other-tenant',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);
  });

  it('9. Enforces R6 & R11: custom tenant role config in canActorAccessMatterRecord and hasEthicalWall restriction in document generation', async () => {
    const repo = new TenantDocumentRepository();
    const storage = new LocalTenantStorageProvider({
      inMemoryOnly: true,
      tokenSigningKey: 'tenant-a-secret-signing-key-32bytes!',
    });
    const engine = new BasicMergeEngine();
    const catalogue = buildFullFieldCatalogueForTenant();

    // R6: Tenant config that removes `matter:restricted:access` from `partner`
    const partnerPermsWithoutRestricted = (
      baseTenantConfig.rbac?.roles.partner?.permissions ?? []
    ).filter((p) => p !== 'matter:restricted:access');

    const customPartnerConfig = {
      ...baseTenantConfig,
      rbac: {
        ...baseTenantConfig.rbac!,
        roles: {
          ...baseTenantConfig.rbac!.roles,
          partner: {
            ...baseTenantConfig.rbac!.roles.partner!,
            key: 'partner',
            label: 'Partner',
            isBuiltIn: true,
            permissions: partnerPermsWithoutRestricted,
          },
        },
      },
    };

    const builder = { id: 'P-ADMIN-1', tenantId: ctxA.tenantId, roles: ['admin'] };
    const unnamedPartner = { id: 'P-PARTNER-UNNAMED', tenantId: ctxA.tenantId, roles: ['partner'] };
    const namedPartner = { id: 'P-PARTNER-NAMED', tenantId: ctxA.tenantId, roles: ['partner'] };

    const docxBytes = buildValidDocxArchive({
      paragraphs: [{ text: 'Hello {{ client.name }}' }],
    });
    const created = await createOrUploadDraftTemplateVersion({
      ctx: ctxA,
      repo,
      storage,
      engine,
      catalogue,
      actor: builder,
      config: customPartnerConfig,
      input: {
        code: 'STAFF-CONFIG-TPL',
        name: 'Staff Matter Template',
        description: 'Custom RBAC config test template',
        category: 'General',
        outputDocumentType: 'letter',
        filenamePattern: '{{matter.reference}} - Staff Letter',
        availabilityRules: { sourceContexts: ['matter'] },
        fileName: 'staff-letter.docx',
        docxBytes,
        fieldMappings: {
          'client.name': {
            placeholder: 'client.name',
            sourceType: 'catalogue',
            catalogueKey: 'client.name',
            required: true,
          },
        },
      },
    });
    await submitTemplateVersionForApproval({
      ctx: ctxA,
      repo,
      catalogue,
      actor: builder,
      config: customPartnerConfig,
      versionId: created.version.id,
    });
    await approveTemplateVersion({
      ctx: ctxA,
      repo,
      actor: { id: 'P-RISK-APPROVER', tenantId: ctxA.tenantId, roles: ['risk_compliance'] },
      config: customPartnerConfig,
      versionId: created.version.id,
    });

    const staffMatterSubject = {
      id: 'M-STAFF-CFG-1',
      clientId: 'CLI-1',
      isStaffMatter: true,
      restrictedAccessUserIds: ['P-PARTNER-NAMED'],
      responsiblePartnerId: 'P-PARTNER-NAMED',
      teamMemberIds: ['P-PARTNER-NAMED'],
    };
    const resolveStaffMatter = (matterId: string) =>
      matterId === 'M-STAFF-CFG-1' ? staffMatterSubject : null;

    // R6: Unnamed partner is refused by previewTemplateVersion and generateDocumentFromTemplate when tenant config removes matter:restricted:access from partner
    await expect(
      previewTemplateVersion({
        ctx: ctxA,
        repo,
        storage,
        engine,
        catalogue,
        actor: unnamedPartner,
        config: customPartnerConfig,
        versionId: created.version.id,
        matterAccessSubject: staffMatterSubject,
        resolutionContext: {
          tenantId: ctxA.tenantId,
          matter: { id: 'M-STAFF-CFG-1', reference: 'MAT-STAFF-1' },
          client: { id: 'CLI-1', name: 'Acme Ltd' },
        },
      }),
    ).rejects.toThrow(/DOCUMENT_RECORD_ACCESS_DENIED/);

    await expect(
      generateDocumentFromTemplate({
        ctx: ctxA,
        repo,
        storage,
        engine,
        catalogue,
        actor: unnamedPartner,
        config: customPartnerConfig,
        templateId: created.template.id,
        sourceEntityType: 'matter',
        matterAccessSubject: staffMatterSubject,
        resolutionContext: {
          tenantId: ctxA.tenantId,
          matter: { id: 'M-STAFF-CFG-1', reference: 'MAT-STAFF-1' },
          client: { id: 'CLI-1', name: 'Acme Ltd' },
        },
      }),
    ).rejects.toThrow(/DOCUMENT_RECORD_ACCESS_DENIED/);

    // Named partner on the staff matter succeeds
    const genOk = await generateDocumentFromTemplate({
      ctx: ctxA,
      repo,
      storage,
      engine,
      catalogue,
      actor: namedPartner,
      config: customPartnerConfig,
      templateId: created.template.id,
      sourceEntityType: 'matter',
      matterAccessSubject: staffMatterSubject,
      resolutionContext: {
        tenantId: ctxA.tenantId,
        matter: { id: 'M-STAFF-CFG-1', reference: 'MAT-STAFF-1' },
        client: { id: 'CLI-1', name: 'Acme Ltd' },
      },
    });
    expect(genOk.document).toBeDefined();

    // Unnamed partner cannot list or delete the generated document
    expect(
      await listAccessibleDocumentsForEntity({
        ctx: ctxA,
        repo,
        actor: unnamedPartner,
        config: customPartnerConfig,
        entityType: 'matter',
        entityId: 'M-STAFF-CFG-1',
        resolveMatterSubject: resolveStaffMatter,
      }),
    ).toHaveLength(0);

    await expect(
      deleteGeneratedDocument({
        ctx: ctxA,
        repo,
        storage,
        actor: unnamedPartner,
        config: customPartnerConfig,
        documentId: genOk.document!.id,
        resolveMatterSubject: resolveStaffMatter,
      }),
    ).rejects.toThrow(/DOCUMENT_RECORD_ACCESS_DENIED/);

    // R11 / B12: toMatterAccessSubject maps hasEthicalWall: true to hasEthicalWall: true (leaving isStaffMatter: false)
    const ethicalWallSubject = toMatterAccessSubject({
      id: 'M-WALL-1',
      isStaffMatter: false,
      hasEthicalWall: true,
      restrictedAccessUserIds: ['P-PARTNER-NAMED'],
      leadFeeEarnerId: 'P-PARTNER-NAMED',
    } as never);
    expect(ethicalWallSubject?.isStaffMatter).toBe(false);
    expect(ethicalWallSubject?.hasEthicalWall).toBe(true);

    // R11: getDocumentGenerationSnapshotForUser omits a document linked to a matter with hasEthicalWall: true (even when isStaffMatter: false) for an excluded employee
    const store = getStore();
    const snapshotMatters = structuredClone(store.matters);
    try {
      const wallMatter = store.matters.find((m) => m.id === 'M-000002')!;
      wallMatter.isStaffMatter = false;
      wallMatter.hasEthicalWall = true;
      wallMatter.restrictedAccessUserIds = ['P-000001'];
      wallMatter.leadFeeEarnerId = 'P-000001';
      wallMatter.supervisingPartnerId = 'P-000001';
      wallMatter.responsiblePartnerId = 'P-000001';
      wallMatter.teamMemberIds = ['P-000001'];

      const { ctx, repo: hostRepo } = await runAsTestEmployee('P-000001', () =>
        getInitializedDocGenContext('P-000001'),
      );
      const docRecord = {
        id: 'DOC-WALL-R11',
        tenantId: ctx.tenantId,
        templateId: 'TPL-1',
        templateName: 'TPL-1',
        templateVersionId: 'TPLV-1',
        templateVersionNumber: 1,
        title: 'Ethical Wall Document',
        fileName: 'wall.docx',
        documentType: 'letter',
        outputFormat: 'docx' as const,
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileSizeBytes: 10,
        fileSha256: 'abc',
        storageProvider: 'local-fs' as const,
        storageKey: 'key-wall-r11',
        primaryMatterId: 'M-000002',
        generatedByUserId: 'P-000001',
        generatedAt: '2026-11-03T10:00:00.000Z',
        isDeleted: false,
      };
      await hostRepo.putDocument(ctx, docRecord);

      // P-000007 is an excluded fee earner (not on M-000002's ethical wall allow-list)
      const excludedSnap = await runAsTestEmployee('P-000007', () =>
        getDocumentGenerationSnapshotForUser('P-000007'),
      );
      expect(
        excludedSnap.documents.some((d) => d.id === 'DOC-WALL-R11'),
      ).toBe(false);

      // P-000001 (on the allow-list) sees the document
      const allowedSnap = await runAsTestEmployee('P-000001', () =>
        getDocumentGenerationSnapshotForUser('P-000001'),
      );
      expect(
        allowedSnap.documents.some((d) => d.id === 'DOC-WALL-R11'),
      ).toBe(true);
    } finally {
      store.matters = snapshotMatters;
      saveStore(store);
    }
  });

  it('10. Enforces R16, R19, R22, R51 & R78: schema validation on updateDocumentGenerationConfigService, UNAUTHENTICATED on unknown userId, and download route soft-delete & auth checks', async () => {
    const store = getStore();
    const snapshotOverride = structuredClone(store.documentGenerationConfigOverride);
    const snapshotAudit = structuredClone(store.audit);
    const snapshotMatters = structuredClone(store.matters);
    try {
      await expect(
        getDocumentGenerationSnapshotForUser('NON-EXISTENT-USER'),
      ).rejects.toThrow(/UNAUTHENTICATED/);

      const initCtx = await runAsTestEmployee('P-000001', () => getInitializedDocGenContext('P-000001'));
      const beforeInvalidSave = await initCtx.repo.getDocumentGenerationTenantConfig(initCtx.ctx);
      await expect(
        runAsTestEmployee('P-000001', () =>
          updateDocumentGenerationConfigService(
            {
              customDocumentTypes: [
                { key: 'INVALID UPPERCASE KEY!', label: 'Invalid' },
              ],
            },
            'P-000001',
          ),
        ),
      ).rejects.toThrow();
      // R16: Stored PostgreSQL settings remain unchanged when validation rejects the update
      expect(await initCtx.repo.getDocumentGenerationTenantConfig(initCtx.ctx)).toEqual(beforeInvalidSave);

      await expect(
        runAsTestEmployee('P-000001', () =>
          updateDocumentGenerationConfigService(
            {
              storageProvider: 'invalid-provider' as never,
            },
            'P-000001',
          ),
        ),
      ).rejects.toThrow();
      expect(await initCtx.repo.getDocumentGenerationTenantConfig(initCtx.ctx)).toEqual(beforeInvalidSave);

      // R22: Excluded user calling GET /api/matters/[id]/documents route handler on a staff matter gets access_denied and empty locations
      const staffMatter = store.matters.find((m) => m.id === 'M-000002')!;
      staffMatter.isStaffMatter = true;
      staffMatter.restrictedAccessUserIds = ['P-000001'];
      setTestEntraSessionOverride({
        sub: 'P-000007',
        tenantId: 'not-a-law-firm',
        oid: '00000000-0000-0000-0000-000000000007',
        tid: '11111111-2222-3333-4444-555555555555',
        displayName: 'Excluded Solicitor',
        email: 'excluded@notalawfirm.example',
        personId: 'P-000007',
        entraRoles: ['fee_earner'],
        mappedRoles: ['fee_earner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      try {
        const staffRouteReq = new NextRequest(
          'http://localhost:3000/api/matters/M-000002/documents',
          { method: 'GET' },
        );
        const staffRouteResp = await getMatterDocumentsRoute(staffRouteReq, {
          params: Promise.resolve({ id: 'M-000002' }),
        });
        const staffRouteBody = (await staffRouteResp.json()) as {
          errorCode?: string;
          locations?: unknown[];
        };
        expect(staffRouteBody.errorCode).toBe('access_denied');
        expect(staffRouteBody.locations).toEqual([]);
      } finally {
        setTestEntraSessionOverride(undefined);
      }

      // R78: GET /api/documents/download rejects a valid token for a soft-deleted document (404) and a token without documentId (404)
      const {
        ctx,
        repo: hostRepo,
        storage: hostStorage,
      } = await runAsTestEmployee('P-000001', () =>
        getInitializedDocGenContext('P-000001'),
      );

      const storedBlob = await hostStorage.putObject(ctx, {
        category: 'documents',
        objectId: 'DOC-SOFT-DEL-78',
        fileName: 'deleted-doc.docx',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: new Uint8Array([10, 20, 30]),
      });

      const deletedDoc = {
        id: 'DOC-SOFT-DEL-78',
        tenantId: ctx.tenantId,
        templateId: 'TPL-1',
        templateCode: 'TPL-1',
        templateVersionId: 'TPLV-1',
        templateVersionNumber: 1,
        title: 'Deleted Document',
        fileName: 'deleted-doc.docx',
        documentType: 'letter',
        templateName: 'TPL-1',
        outputFormat: 'docx' as const,
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileSizeBytes: 3,
        fileSha256: storedBlob.sha256,
        storageProvider: 'local-fs' as const,
        storageKey: storedBlob.blobKey,
        primaryMatterId: 'M-000001',
        generatedByUserId: 'P-000001',
        generatedAt: '2026-11-03T10:00:00.000Z',
        isDeleted: true,
        deletedAt: '2026-11-03T11:00:00.000Z',
        deletedByUserId: 'P-000001',
      };
      await hostRepo.putDocument(ctx, deletedDoc);

      const tokenForDeleted = await hostStorage.issueScopedDownloadToken(
        ctx,
        {
          blobKey: storedBlob.blobKey,
          fileName: 'deleted-doc.docx',
          documentId: 'DOC-SOFT-DEL-78',
        },
        300,
      );
      setTestEntraSessionOverride({
        sub: 'P-000001',
        tenantId: 'not-a-law-firm',
        oid: '00000000-0000-0000-0000-000000000001',
        tid: '11111111-2222-3333-4444-555555555555',
        displayName: 'Admin User',
        email: 'admin@notalawfirm.example',
        personId: 'P-000001',
        entraRoles: ['admin'],
        mappedRoles: ['admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      try {
        const delDlResp = await getDocumentDownloadRoute(
          new NextRequest(
            `http://localhost:3000/api/documents/download?token=${encodeURIComponent(tokenForDeleted.token)}`,
          ),
        );
        expect(delDlResp.status).toBe(404);

        const tokenWithoutDocId = await hostStorage.issueScopedDownloadToken(
          ctx,
          {
            blobKey: storedBlob.blobKey,
            fileName: 'deleted-doc.docx',
          },
          300,
        );
        const noDocIdResp = await getDocumentDownloadRoute(
          new NextRequest(
            `http://localhost:3000/api/documents/download?token=${encodeURIComponent(tokenWithoutDocId.token)}`,
          ),
        );
        expect(noDocIdResp.status).toBe(404);
      } finally {
        setTestEntraSessionOverride(undefined);
      }

      // R51: Calling GET /api/documents/download with no session returns 401
      setTestEntraSessionOverride(null);
      try {
        const unauthDlResp = await getDocumentDownloadRoute(
          new NextRequest(
            `http://localhost:3000/api/documents/download?token=${encodeURIComponent(tokenForDeleted.token)}`,
          ),
        );
        expect(unauthDlResp.status).toBe(401);
      } finally {
        setTestEntraSessionOverride(undefined);
      }
    } finally {
      store.documentGenerationConfigOverride = snapshotOverride;
      store.audit = snapshotAudit;
      store.matters = snapshotMatters;
      saveStore(store);
    }
  });
});
