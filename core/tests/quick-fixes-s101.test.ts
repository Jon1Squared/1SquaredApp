import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_CARE_DOCUMENT_TYPE,
  CoreEmailDispatcher,
  resolveTenantFromVerifiedToken,
  TenantMigrationRunner,
  type TenantContext,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import {
  getActiveTenantConfiguration,
  getAuditRepository,
  getHrAndRbacRepository,
  getIntakeQuoteRepository,
  getMatterRepository,
  getPartyRepository,
  getTaskWorkflowRepository,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { buildFieldResolutionContextForRecord } from '@/domain/documentGeneration';
import {
  createSignedEntraSessionCookie,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { runWithActiveActorSession } from '@/server/rbacRuntime';
import {
  generateDocumentService,
  getDocumentRepository,
  getInitializedDocGenContext,
} from '@/server/documentGenerationServices';
import { readAndValidateDocxZip } from '../src/domain/document-generation/docxEngine';
import {
  closeEnquiryRecord,
  markEngagementLetterDrafted,
  reopenEnquiryRecord,
  resetAllDemoData,
  saveEnquiryRecord,
} from '@/server/services';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import { testDataResetContext } from '@/test/testTenantContexts';
import type { Enquiry, Matter, NotificationItem, Person, Task } from '@/domain/types';

function makeSession(
  personId: string,
  tenantId: string,
  roles: string[],
  email: string,
  displayName: string,
) {
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const cookie = createSignedEntraSessionCookie({
    personId,
    tenantId,
    oid: `00000000-0000-4000-8000-${personId.replace(/\D/g, '').padStart(12, '0')}`,
    tid: '11111111-2222-3333-4444-000000000000',
    sub: personId,
    email,
    displayName,
    entraRoles: roles,
    mappedRoles: roles,
    entraGroups: [],
    mfaVerified: true,
    amr: ['pwd', 'mfa'],
    authenticatedAt: nowIso,
    expiresAt,
  });
  return verifySignedEntraSessionCookie(cookie)!;
}

function makeServiceCtx(
  tenantId: string,
  actorId: string,
  roles: readonly string[] = ['partner', 'admin', 'fee_earner', 'enquiries_coordinator'],
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      tenantId,
      name: `Actor ${actorId}`,
      email: `${actorId.toLowerCase()}@${tenantId}.example`,
      roles: [...roles],
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s101-${tenantId}-${actorId}`,
  });
}

function wrapActor<T>(
  session: ReturnType<typeof makeSession>,
  fn: () => Promise<T>,
): Promise<T> {
  setTestEntraSessionOverride(session);
  return runWithActiveActorSession(
    {
      personId: session.personId,
      tenantId: session.tenantId,
      tokenRoles: [...session.mappedRoles],
      expiresAtMs: Date.parse(session.expiresAt),
      verifiedSession: session,
    },
    fn,
  );
}

describe('S1-01 quick fixes: B2, non-engagement tasks, R636, R598, and documentGeneration fallbacks', () => {
  afterEach(() => {
    setTestEntraSessionOverride(null);
    setActiveTenantConfigForTesting(null);
    vi.restoreAllMocks();
  });

  it('SG-4 / R661: buildFieldResolutionContextForRecord leaves unset financial fields undefined instead of £0.00/285/1500 fallbacks', () => {
    const store = loadCommittedSeedStore();
    const baseMatter = store.matters.find((m) => !m.isStaffMatter && !m.hasEthicalWall)!;
    const matterNoSnapshot: Matter = {
      ...baseMatter,
      feeEstimateGbp: null,
      agreedFeeCapGbp: null,
      retainerMoniesOnAccountGbp: null,
      fieldValues: {},
    };
    const feeEarnerNoRate: Person = {
      ...store.people.find((p) => p.id === 'P-000002')!,
      employment: undefined,
    };
    const ctx = buildFieldResolutionContextForRecord({
      tenantId: 'not-a-law-firm',
      matter: matterNoSnapshot,
      people: [feeEarnerNoRate],
      organisations: store.organisations,
      values: store.values,
      currentUser: feeEarnerNoRate,
    });

    const financial = ctx.financial as Record<string, unknown> | null;
    expect(financial).not.toBeNull();
    expect(financial?.feeEstimate).toBeUndefined();
    expect(financial?.agreedFeeCap).toBeUndefined();
    expect(financial?.hourlyRate).toBeUndefined();
    expect(financial?.wipBalance).toBeUndefined();
    expect(financial?.unbilledDisbursements).toBeUndefined();
    expect(financial?.billedTotal).toBeUndefined();
    expect(financial?.unpaidInvoiceBalance).toBeUndefined();
    expect(financial?.clientAccountBalance).toBeUndefined();
    expect(financial?.officeAccountBalance).toBeUndefined();
    expect(financial?.retainerAmount).toBeUndefined();

    // Explicit zero still formats as 0 when intentionally set
    const explicitZeroMatter: Matter = {
      ...matterNoSnapshot,
      fieldValues: {
        matterCostsSnapshot: { paymentOnAccountAmountGbp: 0 },
      },
    };
    const zeroCtx = buildFieldResolutionContextForRecord({
      tenantId: 'not-a-law-firm',
      matter: explicitZeroMatter,
      people: [feeEarnerNoRate],
      organisations: store.organisations,
      values: store.values,
      currentUser: feeEarnerNoRate,
    });
    expect(zeroCtx.financial?.retainerAmount).toBe(0);
  });

  it('R661: matter with no payment on account cannot produce a Client Care Letter showing £0.00 and blocks when required', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'not-a-law-firm', environment: 'test' }],
    });
    const nalfCtx = makeServiceCtx('not-a-law-firm', 'P-000001');
    await new TenantMigrationRunner().applyUp(nalfCtx);
    await resetAllDemoData('P-000001', testDataResetContext());
    const baseCfg = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting({
      ...baseCfg,
      featureFlags: { ...baseCfg.featureFlags, enableDemoMode: true },
    });

    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const docRepo = getDocumentRepository();
    const seededPeople = await partyRepo.listAllPeople<Person>(nalfCtx);
    const seedStore = loadCommittedSeedStore();
    const baseMatter = seedStore.matters.find((m) => !m.isStaffMatter && !m.hasEthicalWall)!;
    const partner = seededPeople.find((p) => p.id === 'P-000001')!;
    const partnerSession = makeSession(
      partner.id,
      'not-a-law-firm',
      partner.roles ?? ['partner'],
      'partner@notalawfirm.example',
      'Test Partner',
    );

    const matterNoRetainer: Matter = {
      ...baseMatter,
      id: 'M-R661-NO-POA',
      matterNumber: 'R661-0001',
      title: 'R661 Missing Payment On Account Matter',
      feeEstimateGbp: null,
      agreedFeeCapGbp: null,
      retainerMoniesOnAccountGbp: null,
      fieldValues: {},
      engagementLetterStatus: 'Drafting',
    };
    await matterRepo.createMatter(nalfCtx, matterNoRetainer);

    await wrapActor(partnerSession, () =>
      getInitializedDocGenContext(partner.id, partnerSession),
    );

    const genBlank = await wrapActor(partnerSession, () =>
      generateDocumentService(
        {
          templateId: 'TPL-SEED-CCL',
          sourceEntityType: 'matter',
          matterId: matterNoRetainer.id,
          outputFormat: 'docx',
        },
        partner.id,
        partnerSession,
      ),
    );
    expect(genBlank.status).toBe('generated');
    const docxZip = readAndValidateDocxZip(
      new Uint8Array(Buffer.from(genBlank.fileBase64!, 'base64')),
      10,
    );
    const docXml = new TextDecoder('utf-8').decode(docxZip.get('word/document.xml')!.data);
    expect(docXml).not.toContain('£0.00');
    expect(docXml.toLowerCase()).not.toContain('zero pounds');

    // When financial.retainerAmount is required, generation fails closed with blocked_missing_required
    const tplVer = (await docRepo.getTemplateVersionById(nalfCtx, 'TPL-SEED-CCL-V1'))!;
    try {
      await docRepo.putTemplateVersion(nalfCtx, {
        ...tplVer,
        fieldMappings: {
          ...tplVer.fieldMappings,
          'financial.retainerAmount': {
            ...tplVer.fieldMappings['financial.retainerAmount'],
            placeholder: 'financial.retainerAmount',
            sourceType: 'catalogue',
            catalogueKey: 'financial.retainerAmount',
            required: true,
          },
        },
      });
      const blocked = await wrapActor(partnerSession, () =>
        generateDocumentService(
          {
            templateId: 'TPL-SEED-CCL',
            sourceEntityType: 'matter',
            matterId: matterNoRetainer.id,
            outputFormat: 'docx',
          },
          partner.id,
          partnerSession,
        ),
      );
      expect(blocked.status).toBe('blocked_missing_required');
      expect(blocked.missingRequiredFields).toContain('financial.retainerAmount');
    } finally {
      await docRepo.putTemplateVersion(nalfCtx, tplVer);
    }
  });

  it('R598: CoreEmailDispatcher enforces email.senderAddress over caller message.from on Graph', async () => {
    const sentUrls: string[] = [];
    const sentBodies: Array<Record<string, unknown>> = [];
    const dispatcher = new CoreEmailDispatcher({
      emailConfig: {
        provider: 'graph',
        senderAddress: 'shared-mailbox@notalawfirm.example',
        recipientAllowList: ['@notalawfirm.example'],
        graph: {
          tenantId: 'f8218d9a-e055-463f-add2-f03679aad7f2',
          clientId: 'fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1',
          certificateVaultRef: 'kv://kv-alphafirm-test/graph-cert',
          certificateThumbprint: '0123456789ABCDEF0123456789ABCDEF01234567',
        },
      },
      graphTokenProvider: {
        acquireAppToken: async () => 'mock-graph-token',
      } as never,
      fetchFn: async (url, init) => {
        sentUrls.push(String(url));
        sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response('', {
          status: 202,
          headers: { 'request-id': 'req-r598-1' },
        });
      },
    });

    const ctx = makeServiceCtx('not-a-law-firm', 'P-000001');
    const result = await dispatcher.send(ctx, {
      templateKey: 'test.r598',
      recipients: { to: ['client@notalawfirm.example'] },
      from: 'spoofed-caller@notalawfirm.example',
      subject: 'Sender Precedence Check',
      htmlBody: '<p>Check</p>',
      textBody: 'Check',
    });

    expect(result.status).toBe('sent');
    expect(sentUrls).toHaveLength(1);
    expect(sentUrls[0]).toBe(
      'https://graph.microsoft.com/v1.0/users/shared-mailbox%40notalawfirm.example/sendMail',
    );
    const graphMsg = sentBodies[0]?.message as {
      from?: { emailAddress?: { address?: string } };
    };
    expect(graphMsg?.from?.emailAddress?.address).toBe(
      'shared-mailbox@notalawfirm.example',
    );
  });

  it('B2: generating Client Care Letter advances status on the server without regressing Sent/Signed statuses, with permission and two-tenant isolation', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'not-a-law-firm', environment: 'test' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      ],
    });
    const migrationRunner = new TenantMigrationRunner();
    const nalfAdminCtx = makeServiceCtx('not-a-law-firm', 'P-000001');
    const bravoCtx = makeServiceCtx('tenant-bravo', 'P-BRAVO-1');
    await migrationRunner.applyUp(nalfAdminCtx);
    await migrationRunner.applyUp(bravoCtx);

    await resetAllDemoData('P-000001', testDataResetContext());
    const baseCfg = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting({
      ...baseCfg,
      featureFlags: {
        ...baseCfg.featureFlags,
        enableDemoMode: true,
      },
    });

    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const auditRepo = getAuditRepository();
    const seededPeople = await partyRepo.listAllPeople<Person>(nalfAdminCtx);
    const seedStore = loadCommittedSeedStore();
    const baseOpenMatter = seedStore.matters.find(
      (m) => !m.isStaffMatter && !m.hasEthicalWall,
    )!;

    const partner = seededPeople.find(
      (p) => p.id === 'P-000001' || p.roles?.includes('partner'),
    )!;
    const financeOnly =
      seededPeople.find(
        (p) =>
          p.roles?.includes('finance') &&
          !p.roles?.includes('partner') &&
          !p.roles?.includes('fee_earner') &&
          !p.roles?.includes('admin'),
      ) ?? seededPeople.find((p) => p.id === 'P-000009')!;

    const partnerSession = makeSession(
      partner.id,
      'not-a-law-firm',
      partner.roles ?? ['partner'],
      'partner@notalawfirm.example',
      'Test Partner',
    );
    const financeSession = makeSession(
      financeOnly.id,
      'not-a-law-firm',
      financeOnly.roles ?? ['finance'],
      'finance@notalawfirm.example',
      'Test Finance',
    );

    const draftingMatter: Matter = {
      ...baseOpenMatter,
      id: 'M-S101-DRAFTING',
      matterNumber: 'S101-9001',
      title: 'S101 Drafting Engagement Matter',
      engagementLetterStatus: 'Drafting',
      engagementLetterSentAt: null,
      engagementLetterSignedAt: null,
    };
    const blankLetterMatter: Matter = {
      ...baseOpenMatter,
      id: 'M-S101-BLANK',
      matterNumber: 'S101-9002',
      title: 'S101 Non-CCL Matter',
      engagementLetterStatus: '',
      engagementLetterSentAt: null,
      engagementLetterSignedAt: null,
    };
    const sentMatter: Matter = {
      ...baseOpenMatter,
      id: 'M-S101-SENT',
      matterNumber: 'S101-9003',
      title: 'S101 Sent Engagement Matter',
      engagementLetterStatus: 'Sent',
      engagementLetterSentAt: '2026-11-10T09:00:00.000Z',
      engagementLetterSignedAt: null,
    };
    const sentToClientMatter: Matter = {
      ...baseOpenMatter,
      id: 'M-S101-SENT-CLIENT',
      matterNumber: 'S101-9005',
      title: 'S101 Sent to Client Engagement Matter',
      engagementLetterStatus: 'Sent to client',
      engagementLetterSentAt: '2026-11-10T09:00:00.000Z',
      engagementLetterSignedAt: null,
    };
    const signedMatter: Matter = {
      ...baseOpenMatter,
      id: 'M-S101-SIGNED',
      matterNumber: 'S101-9006',
      title: 'S101 Signed Engagement Matter',
      engagementLetterStatus: 'Signed',
      engagementLetterSentAt: '2026-11-10T09:00:00.000Z',
      engagementLetterSignedAt: '2026-11-12T09:30:00.000Z',
    };
    const signedReturnedMatter: Matter = {
      ...baseOpenMatter,
      id: 'M-S101-SIGNED-RET',
      matterNumber: 'S101-9004',
      title: 'S101 Signed & Returned Engagement Matter',
      engagementLetterStatus: 'Signed & returned',
      engagementLetterSentAt: '2026-11-10T09:00:00.000Z',
      engagementLetterSignedAt: '2026-11-12T10:00:00.000Z',
    };
    for (const m of [
      draftingMatter,
      blankLetterMatter,
      sentMatter,
      sentToClientMatter,
      signedMatter,
      signedReturnedMatter,
    ]) {
      await matterRepo.createMatter(nalfAdminCtx, m);
    }

    const auditCountBeforeDocgen = (
      await auditRepo.listAuditEntriesForRecord(
        nalfAdminCtx,
        'matter',
        draftingMatter.id,
      )
    ).length;

    await wrapActor(partnerSession, () =>
      getInitializedDocGenContext(partner.id, partnerSession),
    );

    const cclGen = await wrapActor(partnerSession, () =>
      generateDocumentService(
        {
          templateId: 'TPL-SEED-CCL',
          sourceEntityType: 'matter',
          matterId: draftingMatter.id,
          outputFormat: 'docx',
        },
        partner.id,
        partnerSession,
      ),
    );
    expect(cclGen.status).toBe('generated');
    expect(cclGen.document?.documentType).toBe(CLIENT_CARE_DOCUMENT_TYPE);

    const matterAfterCcl = await matterRepo.getMatterById<Matter>(
      nalfAdminCtx,
      draftingMatter.id,
      { viewerUserId: partner.id, hasRestrictedMatterAccess: true },
    );
    expect(matterAfterCcl?.engagementLetterStatus).toBe('Drafted');

    const auditsAfterDocgen = await auditRepo.listAuditEntriesForRecord(
      nalfAdminCtx,
      'matter',
      draftingMatter.id,
    );
    expect(auditsAfterDocgen.length).toBeGreaterThan(auditCountBeforeDocgen);
    expect(
      auditsAfterDocgen.some(
        (a) =>
          a.field === 'Engagement letter status' && a.newValue === 'Drafted',
      ),
    ).toBe(true);

    // Non-client_care template must NOT touch engagementLetterStatus
    const corrGen = await wrapActor(partnerSession, () =>
      generateDocumentService(
        {
          templateId: 'TPL-SEED-CORR',
          sourceEntityType: 'matter',
          matterId: blankLetterMatter.id,
          outputFormat: 'docx',
          promptedValues: {
            letterBody: 'Update regarding your matter progress.',
          },
        },
        partner.id,
        partnerSession,
      ),
    );
    expect(corrGen.status).toBe('generated');
    expect(corrGen.document?.documentType).not.toBe(CLIENT_CARE_DOCUMENT_TYPE);
    const blankAfterCorr = await matterRepo.getMatterById<Matter>(
      nalfAdminCtx,
      blankLetterMatter.id,
      { viewerUserId: partner.id, hasRestrictedMatterAccess: true },
    );
    expect(blankAfterCorr?.engagementLetterStatus).toBe('');

    // Non-regression guard ('Sent', 'Sent to client', 'Signed', and 'Signed & returned')
    for (const protectedId of [
      sentMatter.id,
      sentToClientMatter.id,
      signedMatter.id,
      signedReturnedMatter.id,
    ]) {
      const before = (await matterRepo.getMatterById<Matter>(
        nalfAdminCtx,
        protectedId,
        { viewerUserId: partner.id, hasRestrictedMatterAccess: true },
      ))!;
      const directRes = await wrapActor(partnerSession, () =>
        markEngagementLetterDrafted(protectedId, partner.id),
      );
      expect(directRes.errors).toBeUndefined();
      expect(directRes.matter?.engagementLetterStatus).toBe(
        before.engagementLetterStatus,
      );
      expect(directRes.matter?.rowVersion).toBe(before.rowVersion);

      await wrapActor(partnerSession, () =>
        generateDocumentService(
          {
            templateId: 'TPL-SEED-CCL',
            sourceEntityType: 'matter',
            matterId: protectedId,
            outputFormat: 'docx',
          },
          partner.id,
          partnerSession,
        ),
      );
      const afterProtected = await matterRepo.getMatterById<Matter>(
        nalfAdminCtx,
        protectedId,
        { viewerUserId: partner.id, hasRestrictedMatterAccess: true },
      );
      expect(afterProtected?.engagementLetterStatus).toBe(
        before.engagementLetterStatus,
      );
    }

    // Permission check: finance user without matter:edit cannot mark drafted directly or via docgen
    const noEditRes = await wrapActor(financeSession, () =>
      markEngagementLetterDrafted(blankLetterMatter.id, financeOnly.id),
    );
    expect(noEditRes.matter).toBeNull();
    expect(noEditRes.errors?.permission).toMatch(/matter:edit/i);

    const financeDocGen = await wrapActor(financeSession, () =>
      generateDocumentService(
        {
          templateId: 'TPL-SEED-CCL',
          sourceEntityType: 'matter',
          matterId: blankLetterMatter.id,
          outputFormat: 'docx',
        },
        financeOnly.id,
        financeSession,
      ),
    );
    expect(financeDocGen.status).toBe('generated');
    const afterFinanceDocGen = await matterRepo.getMatterById<Matter>(
      nalfAdminCtx,
      blankLetterMatter.id,
      { viewerUserId: partner.id, hasRestrictedMatterAccess: true },
    );
    expect(afterFinanceDocGen?.engagementLetterStatus).toBe('');

    // Cross-tenant isolation + tampered matterId + forged TenantContext claim
    await matterRepo.clearTenantData(bravoCtx, { resetMatterNumberSequences: true });
    await partyRepo.clearTenantData(bravoCtx);
    const bravoMatter: Matter = {
      ...blankLetterMatter,
      id: 'M-BRAVO-S101',
      matterNumber: 'BRV-0001',
      engagementLetterStatus: 'Drafting',
    };
    await matterRepo.createMatter(bravoCtx, bravoMatter);

    const tamperedMatterRes = await wrapActor(partnerSession, () =>
      markEngagementLetterDrafted('M-BRAVO-S101', partner.id),
    );
    expect(tamperedMatterRes.matter).toBeNull();
    expect(
      (
        await matterRepo.getMatterById<Matter>(bravoCtx, 'M-BRAVO-S101', {
          includeRestricted: true,
        })
      )?.engagementLetterStatus,
    ).toBe('Drafting');

    const forgedSession = makeSession(
      partner.id,
      'tenant-bravo',
      ['partner', 'admin'],
      'partner@tenant-bravo.example',
      'Forged Actor',
    );
    const forgedMatterRes = await wrapActor(forgedSession, () =>
      markEngagementLetterDrafted(blankLetterMatter.id, partner.id),
    );
    expect(forgedMatterRes.matter).toBeNull();
  });

  it('non_engagement_letter: closeEnquiryRecord raises task after orphan cleanup, skips Draft/went_elsewhere, avoids duplicates, and enforces tampered-ID rejection', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'not-a-law-firm', environment: 'test' }],
    });
    await new TenantMigrationRunner().applyUp(
      makeServiceCtx('not-a-law-firm', 'P-000001'),
    );
    await resetAllDemoData('P-000001', testDataResetContext());
    const baseCfg = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting({
      ...baseCfg,
      featureFlags: {
        ...baseCfg.featureFlags,
        enableDemoMode: true,
      },
    });

    const nalfCtx = makeServiceCtx('not-a-law-firm', 'P-000001');
    const partyRepo = getPartyRepository();
    const intakeRepo = getIntakeQuoteRepository();
    const taskRepo = getTaskWorkflowRepository();
    const seededPeople = await partyRepo.listAllPeople<Person>(nalfCtx);
    const coordinator =
      seededPeople.find(
        (p) =>
          p.roles?.includes('enquiries_coordinator') ||
          p.roles?.includes('fee_earner'),
      ) ?? seededPeople[0]!;
    const coordSession = makeSession(
      coordinator.id,
      'not-a-law-firm',
      coordinator.roles ?? ['enquiries_coordinator', 'fee_earner'],
      'coordinator@notalawfirm.example',
      'Test Coordinator',
    );
    const enquiries = await intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(nalfCtx);
    const samplePracticeAreaId = enquiries[0]!.practiceAreaId;

    const orphanPersonId = 'P-S101-ORPHAN-1';
    const baseSeedPerson = seededPeople.find((p) => !p.isEmployee)!;
    await partyRepo.putPerson(nalfCtx, {
      ...baseSeedPerson,
      id: orphanPersonId,
      firstName: 'Celyn',
      lastName: 'Pritchard',
      fullName: 'Celyn Pritchard',
      displayName: 'Celyn Pritchard',
      isEmployee: false,
      demo: false,
    });

    const createForDecline = await wrapActor(coordSession, () =>
      saveEnquiryRecord(
        {
          firstName: 'Celyn',
          lastName: 'Pritchard',
          email: 'celyn.pritchard@invented.example',
          phone: '029 2018 0991',
          channelId: enquiries[0]!.channelId,
          practiceAreaId: samplePracticeAreaId,
          urgencyId: enquiries[0]!.urgencyId,
          sourceId: enquiries[0]!.sourceId,
          summary: 'S1-01 non-engagement conflict decline test',
          notes: 'Caller reported potential adverse dispute requiring conflict check.',
          privacyNoticeGiven: true,
          linkedPersonId: orphanPersonId,
        },
        { asDraft: false, byId: coordinator.id },
      ),
    );
    expect(createForDecline.errors).toBeUndefined();
    expect(createForDecline.enquiry?.linkedPersonId).toBe(orphanPersonId);
    const declinedEnq = createForDecline.enquiry!;
    const createdOrphanPersonId = declinedEnq.linkedPersonId!;
    await partyRepo.putPerson(nalfCtx, {
      ...baseSeedPerson,
      id: orphanPersonId,
      firstName: 'Celyn',
      lastName: 'Pritchard',
      fullName: 'Celyn Pritchard',
      displayName: 'Celyn Pritchard',
      isEmployee: false,
      demo: false,
      createdFromEnquiryId: declinedEnq.id,
    });

    const declineRes = await wrapActor(coordSession, () =>
      closeEnquiryRecord(
        declinedEnq.id,
        {
          targetStatus: 'Declined',
          closeReasonId: 'enquiry_close_reason.conflict',
          closeNotes: 'Actual adverse conflict identified.',
        },
        coordinator.id,
      ),
    );
    expect(declineRes.error).toBeUndefined();
    expect(declineRes.enquiry?.linkedPersonId).toBeNull();
    const raisedTask = (
      declineRes as { nonEngagementTask?: Task | null }
    ).nonEngagementTask;
    expect(raisedTask).toBeTruthy();
    expect(raisedTask?.autoTrigger).toBe('non_engagement_letter');
    expect(raisedTask?.title).toContain('Celyn Pritchard');
    expect(
      raisedTask?.linkedRecords.some(
        (lr) => lr.recordType === 'person' && lr.recordId === createdOrphanPersonId,
      ),
    ).toBe(false);
    expect(
      raisedTask?.linkedRecords.some(
        (lr) => lr.recordType === 'enquiry' && lr.recordId === declinedEnq.id,
      ),
    ).toBe(true);

    // Reopen and re-close must NOT duplicate the open non_engagement_letter task
    await wrapActor(coordSession, () =>
      reopenEnquiryRecord(declinedEnq.id, coordinator.id),
    );
    const recloseRes = await wrapActor(coordSession, () =>
      closeEnquiryRecord(
        declinedEnq.id,
        {
          targetStatus: 'Declined',
          closeReasonId: 'enquiry_close_reason.not_commercially_viable',
          closeNotes: 'Re-closed.',
        },
        coordinator.id,
      ),
    );
    expect(
      (recloseRes as { nonEngagementTask?: Task | null }).nonEngagementTask,
    ).toBeNull();
    const allTasksAfterReclose = await taskRepo.listAllTasksUnfiltered<Task>(nalfCtx);
    expect(
      allTasksAfterReclose.filter(
        (t) =>
          t.autoTrigger === 'non_engagement_letter' &&
          t.linkedRecords.some(
            (lr) => lr.recordType === 'enquiry' && lr.recordId === declinedEnq.id,
          ),
      ),
    ).toHaveLength(1);

    // Draft / went_elsewhere must raise ZERO non_engagement_letter tasks
    const draftSaved = await wrapActor(coordSession, () =>
      saveEnquiryRecord(
        {
          firstName: 'Gareth',
          lastName: 'DraftOnly',
          email: 'gareth.draft@invented.example',
          practiceAreaId: samplePracticeAreaId,
          summary: 'Draft enquiry close check',
          privacyNoticeGiven: true,
        },
        { asDraft: true, byId: coordinator.id },
      ),
    );
    const draftClose = await wrapActor(coordSession, () =>
      closeEnquiryRecord(
        draftSaved.enquiry!.id,
        {
          targetStatus: 'Declined',
          closeReasonId: 'enquiry_close_reason.not_commercially_viable',
        },
        coordinator.id,
      ),
    );
    expect(
      (draftClose as { nonEngagementTask?: Task | null }).nonEngagementTask,
    ).toBeNull();

    const wentElsewhereSaved = await wrapActor(coordSession, () =>
      saveEnquiryRecord(
        {
          firstName: 'Nia',
          lastName: 'Elsewhere',
          email: 'nia.elsewhere@invented.example',
          channelId: enquiries[0]!.channelId,
          practiceAreaId: samplePracticeAreaId,
          urgencyId: enquiries[0]!.urgencyId,
          sourceId: enquiries[0]!.sourceId,
          summary: 'Client went elsewhere test',
          notes: 'Caller confirmed they instructed another firm.',
          privacyNoticeGiven: true,
        },
        { asDraft: false, byId: coordinator.id },
      ),
    );
    expect(wentElsewhereSaved.errors).toBeUndefined();
    const wentElsewhereClose = await wrapActor(coordSession, () =>
      closeEnquiryRecord(
        wentElsewhereSaved.enquiry!.id,
        {
          targetStatus: 'Declined',
          closeReasonId: 'enquiry_close_reason.client_went_elsewhere',
        },
        coordinator.id,
      ),
    );
    expect(
      (wentElsewhereClose as { nonEngagementTask?: Task | null }).nonEngagementTask,
    ).toBeNull();

    // Tampered enquiryId rejects
    const tamperedClose = await wrapActor(coordSession, () =>
      closeEnquiryRecord(
        'ENQ-BRAVO-999999',
        { targetStatus: 'Declined', closeReasonId: 'enquiry_close_reason.conflict' },
        coordinator.id,
      ),
    );
    expect(tamperedClose.enquiry).toBeUndefined();
    expect(tamperedClose.code).toBe('FORBIDDEN');
  });

  it('R636: unmapped-enquiry admin warning deduplicates on stable key rather than title text', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'not-a-law-firm', environment: 'test' }],
    });
    await new TenantMigrationRunner().applyUp(
      makeServiceCtx('not-a-law-firm', 'P-000001'),
    );
    await resetAllDemoData('P-000001', testDataResetContext());
    const baseCfg = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting({
      ...baseCfg,
      featureFlags: {
        ...baseCfg.featureFlags,
        enableDemoMode: true,
      },
    });

    const nalfCtx = makeServiceCtx('not-a-law-firm', 'P-000001');
    const partyRepo = getPartyRepository();
    const intakeRepo = getIntakeQuoteRepository();
    const taskRepo = getTaskWorkflowRepository();
    const seededPeople = await partyRepo.listAllPeople<Person>(nalfCtx);
    const coordinator =
      seededPeople.find(
        (p) =>
          p.roles?.includes('enquiries_coordinator') ||
          p.roles?.includes('fee_earner'),
      ) ?? seededPeople[0]!;
    const coordSession = makeSession(
      coordinator.id,
      'not-a-law-firm',
      coordinator.roles ?? ['enquiries_coordinator', 'fee_earner'],
      'coordinator@notalawfirm.example',
      'Test Coordinator',
    );
    const enquiries = await intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(nalfCtx);
    const samplePracticeAreaId = enquiries[0]!.practiceAreaId;

    const allTeams = await getHrAndRbacRepository().listAllTeams(nalfCtx);
    const origTeams = allTeams.map((t) => ({ ...t }));
    const cfg = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting({
      ...cfg,
      enquiries: { fallbackTeamId: undefined },
    });
    for (const t of allTeams) {
      await getHrAndRbacRepository().putTeam(nalfCtx, {
        ...t,
        active: false,
        systemKey: undefined,
      });
    }
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const save1 = await wrapActor(coordSession, () =>
        saveEnquiryRecord(
          {
            firstName: 'Sian',
            lastName: 'UnroutedOne',
            email: 'sian.one@invented.example',
            channelId: enquiries[0]!.channelId,
            practiceAreaId: samplePracticeAreaId,
            urgencyId: enquiries[0]!.urgencyId,
            sourceId: enquiries[0]!.sourceId,
            summary: 'Unrouted 1',
            notes: 'First unrouted enquiry notes for R636 check.',
            privacyNoticeGiven: true,
          },
          { asDraft: false, byId: coordinator.id },
        ),
      );
      expect(save1.errors).toBeUndefined();

      const notifs1 = await taskRepo.listAllNotificationsUnfiltered<NotificationItem>(
        nalfCtx,
      );
      const unroutedNotifs1 = notifs1.filter(
        (n) => n.href === '/admin/enquiry-settings',
      );
      expect(unroutedNotifs1.length).toBeGreaterThan(0);
      expect(unroutedNotifs1[0]!.recordId).toBe(
        'system:enquiry_unrouted_no_fallback_team',
      );
      await taskRepo.withTenantTransaction(nalfCtx, async (tx) => {
        await tx.query(
          `UPDATE public.notifications
              SET title = 'Customised Admin Warning Title'
            WHERE tenant_id = $1
              AND record_id = $2`,
          [nalfCtx.tenantId, 'system:enquiry_unrouted_no_fallback_team'],
        );
      });

      const save2 = await wrapActor(coordSession, () =>
        saveEnquiryRecord(
          {
            firstName: 'Sian',
            lastName: 'UnroutedTwo',
            email: 'sian.two@invented.example',
            channelId: enquiries[0]!.channelId,
            practiceAreaId: samplePracticeAreaId,
            urgencyId: enquiries[0]!.urgencyId,
            sourceId: enquiries[0]!.sourceId,
            summary: 'Unrouted 2',
            notes: 'Second unrouted enquiry notes for R636 check.',
            privacyNoticeGiven: true,
          },
          { asDraft: false, byId: coordinator.id },
        ),
      );
      expect(save2.errors).toBeUndefined();
      const notifs2 = await taskRepo.listAllNotificationsUnfiltered<NotificationItem>(
        nalfCtx,
      );
      expect(
        notifs2.filter(
          (n) => n.recordId === 'system:enquiry_unrouted_no_fallback_team',
        ).length,
      ).toBe(unroutedNotifs1.length);
    } finally {
      for (const t of origTeams) {
        await getHrAndRbacRepository().putTeam(nalfCtx, t);
      }
      setActiveTenantConfigForTesting(null);
    }
  });
});
