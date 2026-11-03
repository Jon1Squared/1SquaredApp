import { describe, expect, it } from 'vitest';
import { BasicMergeEngine } from '@platform/core';
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
import { setActiveSessionTokenRolesForPerson } from '@/domain/rbac';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import {
  createSignedEntraSessionCookie,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { getStore, resetStore } from '@/server/store';

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
    resetStore();
  });
});
