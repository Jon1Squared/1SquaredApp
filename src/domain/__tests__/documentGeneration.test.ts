import { describe, expect, it } from 'vitest';
import {
  BasicMergeEngine,
  canActorAccessGeneratedDocument,
  loadAndValidateTenantConfig,
  resolveDocumentPermissions,
} from '@platform/core';
import {
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
  getTemplateUsageReportService,
} from '@/server/documentGenerationServices';
import { resolveEmployeeRoles } from '@/domain/homeConfig';
import {
  runWithActiveActorSession,
  setActiveSessionTokenRolesForPerson,
} from '@/domain/rbac';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import {
  createSignedEntraSessionCookie,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { getStore, resetStore } from '@/server/store';
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
    const store = getStore();
    const managingPartner = store.people.find((p) =>
      p.roles?.includes('managing_partner'),
    );
    const legalSec = store.people.find((p) =>
      p.roles?.includes('legal_secretary'),
    );

    if (managingPartner) {
      const perms = resolvePersonDocumentPermissions(managingPartner);
      expect(perms).toContain('document_template:build');
      expect(perms).toContain('document_template:approve');
      expect(perms).toContain('finance:view');
      expect(
        hasPersonDocumentPermission(managingPartner, 'document_template:build'),
      ).toBe(true);
    }

    if (legalSec && !legalSec.roles?.includes('admin')) {
      expect(
        hasPersonDocumentPermission(legalSec, 'document_template:build'),
      ).toBe(false);
      expect(hasPersonDocumentPermission(legalSec, 'document:generate')).toBe(
        true,
      );
    }
  });

  it('resolves field context, custom fields, and generates both DOCX and PDF documents via server service', async () => {
    const store = getStore();
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
    setActiveSessionTokenRolesForPerson(emp.id, roles, {
      tenantId,
      expiresAt,
      verifiedSession: verified,
    });

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
    resetStore();
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
  });
});
