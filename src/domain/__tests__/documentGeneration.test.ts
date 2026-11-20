import { describe, expect, it, vi } from 'vitest';
import {
  BasicMergeEngine,
  canActorAccessGeneratedDocument,
  createDocumentStorageProvider,
  loadAndValidateTenantConfig,
  resolveDocumentPermissions,
  TenantDocumentRepository,
} from '@platform/core';
import { isActionDenied } from '@/domain/actionResult';
import {
  buildDocumentActorFromPerson,
  buildFieldResolutionContextForRecord,
  buildFullCatalogueFromStoreCustomFields,
  buildSeedClientCareTemplateDocxBytes,
  buildSeedGeneralCorrespondenceDocxBytes,
  hasPersonDocumentPermission,
  listPartyCandidatesForRecord,
  resolvePersonDocumentPermissions,
} from '@/domain/documentGeneration';
import {
  downloadGeneratedDocumentService,
  generateDocumentService,
  getDocumentGenerationSnapshotForUser,
  getDocumentStorage,
  getInitializedDocGenContext,
  getTemplateUsageReportService,
  resolveTenantBlobSigningKey,
} from '@/server/documentGenerationServices';
import { getMatterRepository, getPartyRepository } from '@/server/services';
import { resolveEmployeeRoles } from '@/domain/homeConfig';
import { runWithActiveActorSession } from '@/domain/rbac';
import {
  getActiveTenantConfiguration,
  resolveCurrentTenantContext,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import {
  createSignedEntraSessionCookie,
  createVerifiedSessionActorFromEntraSession,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import notALawFirmBaseConfig from '../../../client-not-a-law-firm/config/base.json';
import notALawFirmDevOverlay from '../../../client-not-a-law-firm/config/environments/dev.json';

describe('Host Document Generation Domain & Server Services', () => {
  it('generates valid pre-seeded Client Care and General Correspondence DOCX templates', async () => {
    const engine = new BasicMergeEngine();
    const clientCareBytes = buildSeedClientCareTemplateDocxBytes();
    const scan1 = await engine.extractPlaceholders(clientCareBytes);
    expect(scan1.validationErrors.length).toBe(0);
    expect(
      scan1.placeholders.some((p) => p.identifier === 'matter.reference'),
    ).toBe(true);
    expect(
      scan1.placeholders.some((p) => p.identifier === 'financial.feeEstimate'),
    ).toBe(true);

    const corrBytes = buildSeedGeneralCorrespondenceDocxBytes();
    const scan2 = await engine.extractPlaceholders(corrBytes);
    expect(scan2.validationErrors.length).toBe(0);
    expect(
      scan2.placeholders.some((p) => p.identifier === 'party.recipient.name'),
    ).toBe(true);
  });

  it('resolves DocumentPermission from full role set and ignores Viewing-as role', () => {
    const store = loadCommittedSeedStore();
    const managingPartner = store.people.find((p) =>
      p.roles?.includes('managing_partner'),
    );
    const legalSec = store.people.find((p) =>
      p.roles?.includes('legal_secretary'),
    );

    if (managingPartner) {
      const perms = resolvePersonDocumentPermissions(
        managingPartner,
        undefined,
        { tenantId: 'not-a-law-firm' },
      );
      expect(perms).toContain('document_template:build');
      expect(perms).toContain('document_template:approve');
      expect(perms).toContain('finance:view');
      expect(
        hasPersonDocumentPermission(
          managingPartner,
          'document_template:build',
          undefined,
          { tenantId: 'not-a-law-firm' },
        ),
      ).toBe(true);
    }

    if (legalSec && !legalSec.roles?.includes('admin')) {
      expect(
        hasPersonDocumentPermission(
          legalSec,
          'document_template:build',
          undefined,
          { tenantId: 'not-a-law-firm' },
        ),
      ).toBe(false);
      expect(
        hasPersonDocumentPermission(
          legalSec,
          'document:generate',
          undefined,
          { tenantId: 'not-a-law-firm' },
        ),
      ).toBe(true);
    }
  });

  it('resolves field context, custom fields, and generates both DOCX and PDF documents via server service', async () => {
    const store = loadCommittedSeedStore();
    const matter = store.matters[0];
    expect(matter).toBeDefined();

    const catalogue = buildFullCatalogueFromStoreCustomFields(
      store.customFields,
    );
    expect(catalogue.some((f) => f.key === 'matter.reference')).toBe(true);

    const parties = listPartyCandidatesForRecord({
      matter,
      people: store.people,
      organisations: store.organisations,
      values: store.values,
    });
    expect(parties.length).toBeGreaterThan(0);

    const ctx = buildFieldResolutionContextForRecord({
      tenantId: 'tenant-pembroke-vaughan-prod',
      matter,
      people: store.people,
      organisations: store.organisations,
      values: store.values,
    });
    expect(ctx.matter?.reference).toBe(matter.matterNumber);

    const tenantId = getActiveTenantConfiguration().tenantId;
    const emp = store.people.find((p) => p.id === 'P-000001')!;
    const roles = resolveEmployeeRoles(emp, store.teams);
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    const signed = createSignedEntraSessionCookie({
      personId: emp.id,
      oid: emp.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
      tid: '00000000-0000-4000-8000-000000000099',
      tenantId,
      sub: emp.id,
      email: emp.emails?.[0]?.address ?? 'p1@notalawfirm.example',
      displayName: `${emp.firstName ?? ''} ${emp.surname ?? ''}`.trim() || emp.id,
      entraRoles: roles,
      mappedRoles: roles,
      entraGroups: [],
      mfaVerified: true,
      amr: ['pwd', 'mfa'],
      authenticatedAt: nowIso,
      expiresAt,
    });
    const verified = verifySignedEntraSessionCookie(signed)!;

    setActiveTenantConfigForTesting(null, {
      environment: 'demo',
      featureFlags: { enableDemoMode: true },
    });
    try {
      await runWithActiveActorSession(
        {
          personId: emp.id,
          tenantId,
          tokenRoles: roles,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession: verified,
        },
        async () => {
          const snap = await getDocumentGenerationSnapshotForUser('P-000001');
          expect(isActionDenied(snap)).toBe(false);
          if (isActionDenied(snap)) throw new Error(snap.message);
          expect(snap.templates.length).toBeGreaterThanOrEqual(2);
          const clientCareTpl = snap.templates.find((t) => t.code === 'CCL-ENG-01');
          expect(clientCareTpl).toBeDefined();

          // Generate DOCX
          const docxRes = await generateDocumentService(
            {
              templateId: clientCareTpl!.id,
              sourceEntityType: 'matter',
              matterId: matter.id,
              promptedValues: {
                specialScopeNotes: 'Advising on commercial lease renewal.',
              },
              outputFormat: 'docx',
            },
            'P-000001',
          );
          expect(docxRes.status).toBe('generated');
          expect(docxRes.document?.outputFormat).toBe('docx');

          // Generate PDF (day-one PDF conversion active)
          const pdfRes = await generateDocumentService(
            {
              templateId: clientCareTpl!.id,
              sourceEntityType: 'matter',
              matterId: matter.id,
              promptedValues: {
                specialScopeNotes: 'Advising on commercial lease renewal.',
              },
              outputFormat: 'pdf',
            },
            'P-000001',
          );
          expect(pdfRes.status).toBe('generated');
          expect(pdfRes.document?.outputFormat).toBe('pdf');
          expect(pdfRes.document?.fileName.endsWith('.pdf')).toBe(true);

          // Download generated PDF via scoped token verification
          const dlRes = await downloadGeneratedDocumentService(
            pdfRes.document!.id,
            'P-000001',
          );
          expect(dlRes.mimeType).toBe('application/pdf');
          expect(dlRes.downloadToken).toBeDefined();
          expect(dlRes.fileBase64.length).toBeGreaterThan(100);

          // Verify usage report recorded both generations
          const usage = await getTemplateUsageReportService({}, 'P-000001');
          expect(usage.totalGeneratedCount).toBeGreaterThanOrEqual(2);
          expect(usage.csvContent).toContain('Template Code');
        },
      );
    } finally {
      setActiveTenantConfigForTesting(null);
    }
  });

  it('enforces R119 & R122: requires actor.tenantId (rejecting empty or mismatched tenantId) and honours hybrid tokenRoles in resolveDocumentPermissions and canActorAccessGeneratedDocument', () => {
    const cfg = loadAndValidateTenantConfig(
      notALawFirmBaseConfig,
      notALawFirmDevOverlay,
      'dev',
      'multi_tenant',
    );

    // R119: Empty tenantId throws RBAC_TENANT_REQUIRED; mismatched tenantId throws DOCUMENT_TENANCY_ERROR
    expect(() =>
      resolveDocumentPermissions(
        { id: 'P-1', tenantId: '', roles: ['fee_earner'] },
        cfg,
      ),
    ).toThrow(/RBAC_TENANT_REQUIRED/);
    expect(() =>
      resolveDocumentPermissions(
        { id: 'P-1', tenantId: 'other-tenant', roles: ['fee_earner'] },
        cfg,
      ),
    ).toThrow(/DOCUMENT_TENANCY_ERROR/);

    // R122: Under token_only, a person with a stored admin role and no token roles gets no document permissions
    const tokenOnlyCfg = {
      ...cfg,
      rbac: {
        ...cfg.rbac!,
        identityMapping: {
          ...cfg.rbac!.identityMapping,
          authorityMode: 'token_only' as const,
        },
      },
    };
    expect(
      resolveDocumentPermissions(
        {
          id: 'P-STORED-ADMIN',
          tenantId: cfg.tenantId,
          roles: ['admin'],
          tokenRoles: [],
          mfaVerified: true,
        },
        tokenOnlyCfg,
      ),
    ).toEqual([]);

    // R122: In hybrid mode, tokenRoles grant document permissions and restricted matter access even when stored roles are empty
    const hybridActor = {
      id: 'P-HYBRID-RISK',
      tenantId: cfg.tenantId,
      roles: [] as string[],
      tokenRoles: ['risk_compliance', 'admin'],
      mfaVerified: true,
    };
    const hybridPerms = resolveDocumentPermissions(hybridActor, cfg);
    expect(hybridPerms).toContain('document_template:build');
    expect(hybridPerms).toContain('document_template:approve');

    const staffMatterDoc = {
      id: 'DOC-STAFF-1',
      tenantId: cfg.tenantId,
      templateId: 'TPL-1',
      templateCode: 'TPL-1',
      templateVersionId: 'VER-1',
      templateVersionNumber: 1,
      title: 'Staff Doc',
      fileName: 'staff.docx',
      outputFormat: 'docx' as const,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 100,
      sha256: 'abc',
      storageProvider: 'local' as const,
      storageKey: 'k1',
      documentTypeKey: 'general_correspondence',
      sourceEntityType: 'matter' as const,
      sourceEntityId: 'M-STAFF-1',
      primaryMatterId: 'M-STAFF-1',
      primaryClientId: null,
      primaryClientEntityType: null,
      generatedByUserId: 'P-1',
      generatedAt: '2026-11-04T00:00:00Z',
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      isDeleted: false,
    };
    const staffMatterSubject = {
      id: 'M-STAFF-1',
      isStaffMatter: true,
      restrictedAccessUserIds: ['P-OTHER'],
    };
    expect(
      canActorAccessGeneratedDocument(
        { id: 'P-HYBRID-RISK', tenantId: cfg.tenantId, roles: [] },
        staffMatterDoc,
        [staffMatterSubject],
        cfg,
      ),
    ).toBe(false);
    expect(
      canActorAccessGeneratedDocument(
        hybridActor,
        staffMatterDoc,
        [staffMatterSubject],
        cfg,
      ),
    ).toBe(true);

    // R151: buildDocumentActorFromPerson throws RBAC_TENANT_REQUIRED when called with no ctx and no active actor session
    const samplePerson = loadCommittedSeedStore().people[0]!;
    expect(() =>
      runWithActiveActorSession(null, () =>
        buildDocumentActorFromPerson(samplePerson),
      ),
    ).toThrow(/RBAC_TENANT_REQUIRED/);
  });

  it('R519 & R549: getDocumentGenerationSnapshotForUser gates templates on document_template:view and generated documents on document:view (plus matter access), denies only when neither is held, and isolates two tenants', async () => {
    const store = loadCommittedSeedStore();
    const fe = store.people.find((p) => p.id === 'P-000002')!;
    const admin = store.people.find((p) => p.id === 'P-000001')!;
    const cfg = getActiveTenantConfiguration();
    const adminCtx = {
      tenantId: cfg.tenantId,
      actorId: admin.id,
      actorName: 'Rhian Morgan',
      actorEmail: 'rhian.morgan@notalawfirm.example',
      actorRoles: ['partner', 'managing_partner', 'admin'],
      mfaVerified: true,
      hostingMode: cfg.hostingMode,
      environment: cfg.environment,
      correlationId: 'corr-r549-admin',
      postgresDatabaseName: 'pg_tenant_not_a_law_firm_test',
      blobContainerName: 'tenant-not-a-law-firm-docs',
      keyVaultSecretPrefix: 'kv-not-a-law-firm-test',
    };
    const alphaSetupSession = verifySignedEntraSessionCookie(
      createSignedEntraSessionCookie({
        personId: 'P-ALPHA-DOC',
        tenantId: 'tenant-alpha',
        oid: '00000000-0000-4000-8000-00000000a001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: 'P-ALPHA-DOC',
        email: 'alpha@tenant-alpha.example',
        displayName: 'Alpha Doc Viewer',
        entraRoles: ['fee_earner'],
        mappedRoles: ['fee_earner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    )!;
    const alphaCtx = resolveCurrentTenantContext(
      createVerifiedSessionActorFromEntraSession(alphaSetupSession, {
        correlationId: 'corr-r549-alpha',
      }),
      {
        ...cfg,
        tenantId: 'tenant-alpha',
        hostingMode: 'multi_tenant',
        environment: 'test',
      },
    );
    const bravoSetupSession = verifySignedEntraSessionCookie(
      createSignedEntraSessionCookie({
        personId: 'P-BRAVO-DOC',
        tenantId: 'tenant-bravo',
        oid: '00000000-0000-4000-8000-00000000b001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: 'P-BRAVO-DOC',
        email: 'bravo@tenant-bravo.example',
        displayName: 'Bravo Doc Viewer',
        entraRoles: ['fee_earner'],
        mappedRoles: ['fee_earner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    )!;
    const bravoCtx = resolveCurrentTenantContext(
      createVerifiedSessionActorFromEntraSession(bravoSetupSession, {
        correlationId: 'corr-r549-bravo',
      }),
      {
        ...cfg,
        tenantId: 'tenant-bravo',
        hostingMode: 'multi_tenant',
        environment: 'test',
      },
    );

    const origOverrides = fe.permissionOverrides;
    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const docRepo = new TenantDocumentRepository();
    const adminCookie = createSignedEntraSessionCookie({
      personId: admin.id,
      tenantId: cfg.tenantId,
      oid: '00000000-0000-4000-8000-000000000001',
      tid: '11111111-2222-3333-4444-000000000000',
      sub: admin.id,
      email: 'rhian.morgan@notalawfirm.example',
      displayName: 'Rhian Morgan',
      entraRoles: ['partner', 'managing_partner', 'admin'],
      mappedRoles: ['partner', 'managing_partner', 'admin'],
      entraGroups: [],
      mfaVerified: true,
      amr: ['pwd', 'mfa'],
      authenticatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const adminSession = verifySignedEntraSessionCookie(adminCookie)!;
    const initAdmin = await getInitializedDocGenContext(admin.id, adminSession);
    const openMatter = store.matters.find((m) => !m.isStaffMatter && !m.hasEthicalWall)!;
    const restrictedMatterId = 'M-R549-STAFF';
    const openDocId = 'DOC-R549-OPEN';
    const restrictedDocId = 'DOC-R549-STAFF';

    try {
      await matterRepo.putMatter(
        adminCtx,
        {
          ...structuredClone(openMatter),
          id: restrictedMatterId,
          matterNumber: 'MAT-R549-STAFF',
          title: 'R549 Restricted Staff Matter',
          isStaffMatter: true,
          restrictedAccessUserIds: [admin.id],
          teamMemberIds: [admin.id],
          responsiblePartnerId: admin.id,
          supervisingPartnerId: admin.id,
          leadFeeEarnerId: admin.id,
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [admin.id] },
      );

      const baseDocTemplate = {
        tenantId: cfg.tenantId,
        templateId: 'TPL-1',
        templateName: 'Client Care',
        templateVersionId: 'TPLV-1',
        templateVersionNumber: 1,
        documentType: 'client_care_letter',
        outputFormat: 'docx' as const,
        storageProvider: 'local-fs' as const,
        fileSizeBytes: 128,
        fileSha256: 'sha-r549',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        generatedByUserId: admin.id,
        generatedByName: 'Rhian Morgan',
        generatedAt: '2026-11-19T12:00:00Z',
        fieldValuesUsed: {},
        promptedValuesUsed: {},
        isDeleted: false,
      };
      await initAdmin.repo.putDocument(adminCtx, {
        ...baseDocTemplate,
        id: openDocId,
        title: 'R549 Open Doc',
        storageKey: 'docs/r549-open.docx',
        fileName: 'r549-open.docx',
        primaryMatterId: openMatter.id,
      });
      await initAdmin.repo.putDocument(adminCtx, {
        ...baseDocTemplate,
        id: restrictedDocId,
        title: 'R549 Staff Doc',
        storageKey: 'docs/r549-staff.docx',
        fileName: 'r549-staff.docx',
        primaryMatterId: restrictedMatterId,
      });

      const makeFeSession = () => {
        const cookie = createSignedEntraSessionCookie({
          personId: 'P-000002',
          tenantId: cfg.tenantId,
          oid: '00000000-0000-4000-8000-000000000002',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000002',
          email: 'dafydd.evans@notalawfirm.example',
          displayName: 'Dafydd Evans',
          entraRoles: ['fee_earner'],
          mappedRoles: ['fee_earner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        return verifySignedEntraSessionCookie(cookie)!;
      };

      // 1. Role with document:view ONLY (document_template:view revoked):
      //    succeeds and returns accessible matter-scoped generated documents, with empty template metadata
      await partyRepo.putPerson(adminCtx, {
        ...fe,
        permissionOverrides: {
          grant: [],
          revoke: ['document_template:view'],
          reason: 'R549 docs-only role',
        },
      });
      const docsOnlySnap = await getDocumentGenerationSnapshotForUser(
        'P-000002',
        makeFeSession(),
      );
      expect(isActionDenied(docsOnlySnap)).toBe(false);
      if (isActionDenied(docsOnlySnap)) throw new Error(docsOnlySnap.message);
      expect(docsOnlySnap.documents.some((d) => d.id === openDocId)).toBe(true);
      expect(docsOnlySnap.documents.some((d) => d.id === restrictedDocId)).toBe(false);
      expect(docsOnlySnap.templates).toEqual([]);
      expect(docsOnlySnap.versions).toEqual([]);
      expect(docsOnlySnap.readableCatalogueFields).toEqual([]);
      expect(docsOnlySnap.permittedTemplateIds).toEqual([]);
      expect(docsOnlySnap.pendingApprovalsCount).toBe(0);

      // 2. Role with document_template:view ONLY (document:view revoked):
      //    succeeds and returns templates/catalogue, with empty generated documents
      await partyRepo.putPerson(adminCtx, {
        ...fe,
        permissionOverrides: {
          grant: [],
          revoke: ['document:view'],
          reason: 'R549 templates-only role',
        },
      });
      const templatesOnlySnap = await getDocumentGenerationSnapshotForUser(
        'P-000002',
        makeFeSession(),
      );
      expect(isActionDenied(templatesOnlySnap)).toBe(false);
      if (isActionDenied(templatesOnlySnap)) {
        throw new Error(templatesOnlySnap.message);
      }
      expect(templatesOnlySnap.templates.length).toBeGreaterThanOrEqual(2);
      expect(templatesOnlySnap.readableCatalogueFields.length).toBeGreaterThan(0);
      expect(templatesOnlySnap.documents).toEqual([]);
      expect(templatesOnlySnap.documentLinks).toEqual([]);

      // 3. Role holding NEITHER document:view NOR document_template:view -> FORBIDDEN
      await partyRepo.putPerson(adminCtx, {
        ...fe,
        permissionOverrides: {
          grant: [],
          revoke: ['document_template:view', 'document:view'],
          reason: 'R549 neither permission',
        },
      });
      const neitherDenied = await getDocumentGenerationSnapshotForUser(
        'P-000002',
        makeFeSession(),
      );
      expect(isActionDenied(neitherDenied)).toBe(true);
      if (isActionDenied(neitherDenied)) {
        expect(neitherDenied.code).toBe('FORBIDDEN');
      }

      // 4. Two-tenant isolation for docs-only role: Tenant Alpha viewer sees only Alpha doc, never Bravo doc
      await docRepo.offboardTenantData(alphaCtx).catch(() => undefined);
      await docRepo.offboardTenantData(bravoCtx).catch(() => undefined);
      await partyRepo.clearTenantData(alphaCtx).catch(() => undefined);
      await partyRepo.clearTenantData(bravoCtx).catch(() => undefined);
      await matterRepo.clearTenantData(alphaCtx).catch(() => undefined);
      await matterRepo.clearTenantData(bravoCtx).catch(() => undefined);

      await partyRepo.putPerson(alphaCtx, {
        ...fe,
        id: 'P-ALPHA-DOC',
        permissionOverrides: {
          grant: [],
          revoke: ['document_template:view'],
          reason: 'Alpha docs only',
        },
      });
      await partyRepo.putPerson(bravoCtx, {
        ...fe,
        id: 'P-BRAVO-DOC',
        permissionOverrides: undefined,
      });
      await matterRepo.putMatter(
        alphaCtx,
        {
          ...structuredClone(openMatter),
          id: 'M-ALPHA-DOC',
          matterNumber: 'ALP-DOC-1',
          leadFeeEarnerId: 'P-ALPHA-DOC',
          teamMemberIds: ['P-ALPHA-DOC'],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );
      await matterRepo.putMatter(
        bravoCtx,
        {
          ...structuredClone(openMatter),
          id: 'M-BRAVO-DOC',
          matterNumber: 'BRV-DOC-1',
          leadFeeEarnerId: 'P-BRAVO-DOC',
          teamMemberIds: ['P-BRAVO-DOC'],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );
      await docRepo.putDocument(alphaCtx, {
        ...baseDocTemplate,
        id: 'DOC-ALPHA-ONLY',
        tenantId: 'tenant-alpha',
        title: 'Alpha Only Doc',
        storageKey: 'docs/alpha-only.docx',
        fileName: 'alpha-only.docx',
        primaryMatterId: 'M-ALPHA-DOC',
      });
      await docRepo.putDocument(bravoCtx, {
        ...baseDocTemplate,
        id: 'DOC-BRAVO-ONLY',
        tenantId: 'tenant-bravo',
        title: 'Bravo Only Doc',
        storageKey: 'docs/bravo-only.docx',
        fileName: 'bravo-only.docx',
        primaryMatterId: 'M-BRAVO-DOC',
      });

      const rawBase = JSON.parse(JSON.stringify(notALawFirmBaseConfig));
      setActiveTenantConfigForTesting(
        { ...rawBase, tenantId: 'tenant-alpha', hostingMode: 'multi_tenant' },
        { tenantId: 'tenant-alpha', environment: 'test' },
      );
      const alphaSession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-ALPHA-DOC',
          tenantId: 'tenant-alpha',
          oid: '00000000-0000-4000-8000-00000000a001',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-ALPHA-DOC',
          email: 'alpha@tenant-alpha.example',
          displayName: 'Alpha Doc Viewer',
          entraRoles: ['fee_earner'],
          mappedRoles: ['fee_earner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;
      setTestEntraSessionOverride(alphaSession);
      const alphaSnap = await getDocumentGenerationSnapshotForUser(
        'P-ALPHA-DOC',
        alphaSession,
      );
      expect(isActionDenied(alphaSnap)).toBe(false);
      if (isActionDenied(alphaSnap)) throw new Error(alphaSnap.message);
      expect(alphaSnap.documents.map((d) => d.id)).toContain('DOC-ALPHA-ONLY');
      expect(alphaSnap.documents.map((d) => d.id)).not.toContain('DOC-BRAVO-ONLY');
    } finally {
      setTestEntraSessionOverride(undefined);
      setActiveTenantConfigForTesting(null);
      await partyRepo.putPerson(adminCtx, {
        ...fe,
        permissionOverrides: origOverrides,
      }).catch(() => undefined);
      await docRepo.offboardTenantData(alphaCtx).catch(() => undefined);
      await docRepo.offboardTenantData(bravoCtx).catch(() => undefined);
      await matterRepo.clearTenantData(alphaCtx).catch(() => undefined);
      await matterRepo.clearTenantData(bravoCtx).catch(() => undefined);
      await partyRepo.clearTenantData(alphaCtx).catch(() => undefined);
      await partyRepo.clearTenantData(bravoCtx).catch(() => undefined);
    }
  });

  it('R520 & R562: refuses deterministic test signing keys and in-memory storage in live even when VITEST is set, and caches live providers by cacheKey', () => {
    const baseCfg = getActiveTenantConfiguration();
    // Warm up test storage singleton first to prove getDocumentStorage never reuses a test instance for live
    getDocumentStorage(baseCfg);

    vi.stubEnv('VITEST', 'true');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PLATFORM_ENVIRONMENT', 'live');
    vi.stubEnv('PLATFORM_BLOB_SIGNING_KEY', '');
    try {
      expect(() =>
        createDocumentStorageProvider('local-fs', {
          inMemoryOnly: true,
          environment: 'live',
        } as never),
      ).toThrow(/STORAGE_CONFIG_ERROR/);

      // R562: either source saying 'live' (e.g. PLATFORM_ENVIRONMENT='live' even with environment='test') means live
      expect(() =>
        createDocumentStorageProvider('local-fs', {
          inMemoryOnly: true,
          environment: 'test',
        } as never),
      ).toThrow(/STORAGE_CONFIG_ERROR/);

      expect(() => resolveTenantBlobSigningKey('not-a-law-firm', 'test')).toThrow(
        /STORAGE_CONFIG_ERROR/,
      );

      expect(() => resolveTenantBlobSigningKey('not-a-law-firm')).toThrow(
        /STORAGE_CONFIG_ERROR/,
      );

      expect(() =>
        getDocumentStorage({
          ...baseCfg,
          environment: 'live',
        }),
      ).toThrow(/STORAGE_CONFIG_ERROR/);

      // R562: when live signing key is configured, getDocumentStorage caches the live provider instance per cacheKey
      vi.stubEnv(
        'PLATFORM_BLOB_SIGNING_KEY',
        'live-blob-signing-key-for-r562-cache-test-01',
      );
      const liveCfg = { ...baseCfg, environment: 'live' as const };
      const firstLive = getDocumentStorage(liveCfg);
      const secondLive = getDocumentStorage(liveCfg);
      expect(secondLive).toBe(firstLive);

      const otherTenantLive = getDocumentStorage({
        ...liveCfg,
        tenantId: 'tenant-alpha',
      });
      expect(otherTenantLive).not.toBe(firstLive);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
