import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_TENANT_MIGRATIONS,
  MAX_EMAIL_TOTAL_ATTACHMENT_BYTES,
  TenantAuditRepository,
  TenantChasingRepository,
  TenantDocumentRepository,
  TenantEngagementRepository,
  TenantEvidenceArtifactRepository,
  TenantHrAndRbacRepository,
  TenantIntakeCheckRepository,
  TenantJobRunRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantOutboxRepository,
  TenantPartyRepository,
  TenantPostgresPoolManager,
  TenantTaskWorkflowRepository,
  createDirectMigrationClient,
  loadAndValidateTenantConfig,
  resolveTenantFromVerifiedToken,
  type TenantContext,
} from '../src/index';
import { addDays } from '@/domain/dates';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import {
  getOutboxMessageForAdminAction,
  listOutboxMessagesForAdminAction,
  openProspectiveMatterAction,
  recordEngagementLetterSignedAction,
  saveChasingConfigAction,
  saveEngagementConfigAction,
  sendEngagementLetterAction,
  sendNonEngagementLetterAction,
  stopCommunicationChaseAction,
} from '@/app/actions';
import * as evidenceDownloadRoute from '@/app/api/evidence/download/route';
import * as evidenceUploadRoute from '@/app/api/evidence/upload/route';
import * as outboxAttachmentRoute from '@/app/api/admin/outbox/[id]/attachments/[ordinal]/route';
import { isActionDenied } from '@/domain/actionResult';
import { vid, type ConflictCheckRecordInput, type Matter, type Person, type Task } from '@/domain/types';
import {
  getActiveTenantConfiguration,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { getDocumentStorage } from '@/server/documentGenerationServices';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import {
  closeEnquiryRecord,
  completeClientCddRecord,
  downloadOutboxAttachmentForAdminRecord,
  executeCommunicationChasesForTenant,
  recordCddChecklistItemRecord,
  recordEngagementLetterSignedRecord,
  recordManualSanctionsPepRecord,
  resetAllDemoData,
  saveMatterRecord,
  saveEnquiryRecord,
  sendEngagementLetterRecord,
  startOrLoadClientCddRecord,
  stopCommunicationChaseRecord,
  uploadEvidenceArtifactRecord,
} from '@/server/services';
import {
  runAsTestActor,
  setTestActorSession,
  testTenantCtx,
} from '@/server/testSupport/auditTestSupport';
import { testDataResetContext } from '@/test/testTenantContexts';

const BASE_LOW_RISK_ANSWERS: Record<string, string> = {
  inScopeMlr: 'Yes, in scope',
  instructionMakesSense: 'Yes',
  moveMoneyWithoutTransaction: 'No',
  clientRelationshipStatus: 'Existing, CDD current',
  clientDealingMethod: 'Met in person',
  complexOwnershipStructure: 'No',
  thirdPartyInstructions: 'No',
  highRiskJurisdictionLink: 'No',
  crossBorderFundsOrAssets: 'No',
  holdClientMoney: 'No',
  matterFundingSource: 'The client',
  sourceOfFundsUnderstood: 'Yes',
  unusualPaymentRequests: 'No',
  regularTeamWork: 'Yes',
  capacityAndSupervision: 'Yes',
  imminentDeadlines: 'No',
  feeBasis: 'Fixed fee',
  moneyOnAccountRequested: 'Yes',
  valueOrExposure: 'Within normal range',
  limitationOfLiabilityProposed: 'No',
  reputationOrEthicalConcerns: 'No',
  sensitiveSectorOrMedia: 'No',
  specialCategoryDataOrConfidentiality: 'No',
};

function makeConflictRecord(
  actorId: string,
  actorName: string,
  status: ConflictCheckRecordInput['status'] = 'Cleared',
): ConflictCheckRecordInput {
  return {
    status,
    outcomeLabel: status === 'Cleared' ? 'Cleared by fee earner' : 'Approved by Risk & Compliance',
    declarationConfirmed: true,
    reviewerMessage: '',
    lastRunAtDisplay: '26 Nov 2026',
    lastRunById: actorId,
    lastRunByName: actorName,
    submittedAtDisplay: '26 Nov 2026',
    submittedByName: actorName,
    parties: [],
    matches: [],
    runs: [],
    comments: [],
  };
}

async function runAsActionActor<R>(
  actorId: string,
  fn: () => Promise<R>,
  options?: { tenantId?: string; mfaVerified?: boolean; roles?: readonly string[] },
): Promise<R> {
  setTestActorSession(actorId, options);
  try {
    return await runAsTestActor(actorId, fn, options);
  } finally {
    setTestActorSession(null);
  }
}

function makeVerifiedTenantCtx(
  tenantId: string,
  actorId: string,
  roles: readonly string[] = ['partner'],
  mfaVerified = true,
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      name: `User ${actorId}`,
      email: `${actorId.toLowerCase()}@notalawfirm.example`,
      tenantId,
      roles: [...roles],
      mfaVerified,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s106-${tenantId}-${actorId}`,
  });
}

async function createSignedEngagementPdfArtifact(
  matterId: string,
  actorId: string,
  tenantCtx?: TenantContext,
) {
  return uploadEvidenceArtifactRecord(
    {
      subjectType: 'matter',
      subjectId: matterId,
      purpose: 'engagement_signed',
      fileName: `signed-${matterId}.pdf`,
      contentType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.4\n% Signed Client Care Copy\n%%EOF\n'),
    },
    actorId,
    tenantCtx ? { tenantCtx } : undefined,
  );
}

describe('S1-06: Client Care dispatch, Monotonic B2, R817 purpose decoupling, R818 chasing, R823/R826 outbox viewer & Non-Engagement letters', () => {
  afterEach(() => {
    setTestActorSession(null);
    setActiveTenantConfigForTesting(null);
  });

  it('1. Dispatches Client Care PDF via outbox, enforces 3 MB limit & monotonic B2, requires signed upload, and stops chase immediately', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000002');
    const matterRepo = new TenantMatterRepository();
    const outboxRepo = new TenantOutboxRepository();
    const engRepo = new TenantEngagementRepository();
    const chasingRepo = new TenantChasingRepository();
    const checkRepo = new TenantIntakeCheckRepository();
    const docRepo = new TenantDocumentRepository();
    const auditRepo = new TenantAuditRepository();

    // Ensure O-000001 has complete CDD so we can also prove opening gate unlocks on signed copy upload
    await runAsActionActor(
      'P-000002',
      async () => {
        const cddLoad = await startOrLoadClientCddRecord(
          { subjectType: 'organisation', subjectId: 'O-000001', createIfMissing: true },
          'P-000002',
        );
        expect(cddLoad.ok).toBe(true);
        if (!cddLoad.ok) return;
        const cddUp = await uploadEvidenceArtifactRecord(
          {
            subjectType: 'organisation',
            subjectId: 'O-000001',
            purpose: 'cdd',
            fileName: 'cdd-cert.pdf',
            contentType: 'application/pdf',
            bytes: Buffer.from('%PDF-1.4\n% CDD certificate\n%%EOF\n'),
          },
          'P-000002',
        );
        expect(cddUp.ok).toBe(true);
        if (!cddUp.ok) return;
        await recordManualSanctionsPepRecord(
          {
            subjectType: 'organisation',
            subjectId: 'O-000001',
            outcome: 'clear',
            screeningScope: 'UK Sanctions list',
            referenceCode: 'SP-S106-1',
          },
          'P-000002',
        );
        for (const item of cddLoad.summary.checklistItems) {
          await recordCddChecklistItemRecord(
            {
              recordId: cddLoad.summary.recordId!,
              itemKey: item.itemKey,
              status: 'recorded',
              evidenceRefs: [cddUp.evidenceRef],
            },
            'P-000002',
          );
        }
        const comp = await completeClientCddRecord(
          { recordId: cddLoad.summary.recordId! },
          'P-000002',
        );
        expect(comp.ok).toBe(true);
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );

    // Create Prospective matter on Conveyancing (requires engagement_signed on opening gate)
    let matterId = '';
    await runAsActionActor(
      'P-000002',
      async () => {
        const saved = await saveMatterRecord(
          {
            title: 'S106 Prospective Conveyancing Sale',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.conveyancing',
            workTypeSubcategoryId: 'work_type.conveyancing_residential_sale',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            feeEstimateGbp: 1850,
            agreedFeeCapGbp: 2200,
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        expect(saved.errors).toBeUndefined();
        matterId = saved.matter!.id;
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );

    // Force email provider disabled in active config to assert honest pending outbox queueing
    const disabledCfg = {
      ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
      tenantId: 'not-a-law-firm',
      integrations: {
        ...((notALawFirmBaseConfig as unknown as { integrations: Record<string, unknown> })
          .integrations ?? {}),
        email: { provider: 'disabled' },
      },
    };
    setActiveTenantConfigForTesting(disabledCfg, {});

    // 1(a). 3 MB PDF cap fails BEFORE any outbox/dispatch/status mutation (S1-D11)
    expect(MAX_EMAIL_TOTAL_ATTACHMENT_BYTES).toBe(3_000_000);
    const oversized = await runAsActionActor(
      'P-000002',
      () =>
        sendEngagementLetterRecord(
          {
            matterId,
            recipientEmail: 'client.s106@1squared.co.uk',
            recipientName: 'Ms Client',
          },
          'P-000002',
          {
            pdfConverter: {
              converterId: 'test-oversized',
              convertDocxToPdf: async () => new Uint8Array(MAX_EMAIL_TOTAL_ATTACHMENT_BYTES + 1),
            },
          },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(oversized).toMatchObject({
      ok: false,
      code: 'EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED',
    });
    expect(await engRepo.listDispatchesForMatter(ctx, matterId)).toHaveLength(0);
    const mAfterOversize = await matterRepo.getMatterById<Matter>(ctx, matterId, {
      includeRestricted: true,
    });
    expect(mAfterOversize?.engagementLetterStatus).toBe('Drafting');
    expect(mAfterOversize?.engagementLetterSentAt).toBeNull();

    // 1(b). Send Client Care letter with real built-in PDF generator via server action
    const sendRes = await runAsActionActor(
      'P-000002',
      () =>
        sendEngagementLetterAction({
          matterId,
          recipientEmail: 'client.s106@1squared.co.uk',
          recipientName: 'Ms Client',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(sendRes.ok).toBe(true);
    if (!sendRes.ok) return;

    expect(sendRes.emailProviderDisabled).toBe(true);
    expect(sendRes.matter.engagementLetterStatus).toBe('Sent');
    expect(sendRes.matter.engagementLetterSentAt).toBeTruthy();
    expect(sendRes.dispatch.kind).toBe('client_care');
    expect(sendRes.dispatch.status).toBe('sent');
    expect(sendRes.dispatch.matterId).toBe(matterId);
    expect(sendRes.outboxRecord.status).toBe('pending');
    expect(sendRes.outboxRecord.matterId).toBe(matterId);
    expect(sendRes.chase?.status).toBe('active');
    expect(sendRes.chase?.nextStepIndex).toBe(1);

    // Generated PDF exists in documents + email_outbox_attachments with Legal Ombudsman text & zero CDD strings
    const docRecord = await docRepo.getDocumentById(ctx, sendRes.documentId);
    expect(docRecord).not.toBeNull();
    expect(docRecord?.primaryMatterId).toBe(matterId);
    expect(docRecord?.outputFormat).toBe('pdf');

    const attRes = await runAsActionActor(
      'P-000004',
      () =>
        downloadOutboxAttachmentForAdminRecord(
          { outboxId: sendRes.outboxRecord.id, ordinal: 0 },
          'P-000004',
          { mfaVerified: true },
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(attRes.ok).toBe(true);
    if (attRes.ok) {
      const pdfText = Buffer.from(attRes.attachment.contentBytes).toString('latin1');
      expect(pdfText.startsWith('%PDF-')).toBe(true);
      expect(pdfText).toContain('Legal Ombudsman');
      expect(pdfText).not.toContain('CMI incomplete');
      expect(pdfText).not.toContain('amlStatus');
    }

    // ADR 0038 e_signature 'requested_manual' intake check created
    const checks = await checkRepo.listChecksForSubject(ctx, {
      subjectType: 'matter',
      subjectId: matterId,
      checkKind: 'e_signature',
    });
    expect(checks.some((c) => c.outcome === 'requested_manual')).toBe(true);

    // 1(c). Monotonic B2 guards on saveMatterRecord: Sent -> Drafted blocked & sentAt immutable
    const sentAtOriginal = sendRes.matter.engagementLetterSentAt;
    const regAttempt = await runAsActionActor(
      'P-000002',
      () =>
        saveMatterRecord(
          {
            title: sendRes.matter.title,
            clientId: sendRes.matter.clientId,
            practiceAreaId: sendRes.matter.practiceAreaId,
            workTypeSubcategoryId: sendRes.matter.workTypeSubcategoryId,
            engagementLetterStatus: 'Drafted',
            engagementLetterSentAt: '2020-01-01T00:00:00.000Z',
            rowVersion: sendRes.matter.rowVersion,
          },
          { id: matterId, byId: 'P-000002', saveMode: 'submit_cleared' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(regAttempt.errors?.engagementLetterStatus).toMatch(/backwards/i);
    const untouchedMatter = await matterRepo.getMatterById<Matter>(ctx, matterId, {
      includeRestricted: true,
    });
    expect(untouchedMatter?.engagementLetterStatus).toBe('Sent');
    expect(untouchedMatter?.engagementLetterSentAt).toBe(sentAtOriginal);

    // 1(d). recordEngagementLetterSignedAction requires uploaded signed copy (ENGAGEMENT_SIGNED_COPY_REQUIRED)
    const signWithoutCopy = await runAsActionActor(
      'P-000002',
      () =>
        recordEngagementLetterSignedAction({
          matterId,
          evidenceArtifactId: '',
          status: 'Signed & returned',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(signWithoutCopy).toMatchObject({
      ok: false,
      code: 'ENGAGEMENT_SIGNED_COPY_REQUIRED',
    });

    // 1(e). Upload clean 'engagement_signed' PDF and mark signed -> unlocks opening gate & stops chase
    const signedPdfUp = await runAsActionActor(
      'P-000002',
      () => createSignedEngagementPdfArtifact(matterId, 'P-000002'),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(signedPdfUp.ok).toBe(true);
    if (!signedPdfUp.ok) return;

    const signRes = await runAsActionActor(
      'P-000002',
      () =>
        recordEngagementLetterSignedAction({
          matterId,
          evidenceArtifactId: signedPdfUp.artifact.id,
          status: 'Signed & returned',
          note: 'Client returned countersigned copy',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(signRes.ok).toBe(true);
    if (!signRes.ok) return;
    expect(signRes.matter.engagementLetterStatus).toBe('Signed & returned');
    expect(signRes.matter.engagementLetterSignedAt).toBeTruthy();

    // Chase stopped automatically with reason 'signed' and dispatch marked 'signed'
    expect(
      await chasingRepo.getActiveChaseForEntity(ctx, {
        entityKind: 'engagement_letter',
        entityId: matterId,
      }),
    ).toBeNull();
    const stoppedChase = await chasingRepo.getChaseById(ctx, sendRes.chase!.id);
    expect(stoppedChase?.status).toBe('stopped');
    expect(stoppedChase?.stoppedReason).toBe('signed');

    const dispatchesAfterSign = await engRepo.listDispatchesForMatter(ctx, matterId);
    expect(dispatchesAfterSign[0]?.status).toBe('signed');
    expect(dispatchesAfterSign[0]?.signedEvidenceArtifactId).toBe(
      signedPdfUp.artifact.id,
    );

    const checksAfterSign = await checkRepo.listChecksForSubject(ctx, {
      subjectType: 'matter',
      subjectId: matterId,
      checkKind: 'e_signature',
    });
    expect(checksAfterSign.some((c) => c.outcome === 'signed_uploaded')).toBe(true);

    // Regression Signed -> Sent also blocked
    const regFromSigned = await runAsActionActor(
      'P-000002',
      () =>
        saveMatterRecord(
          {
            title: signRes.matter.title,
            clientId: signRes.matter.clientId,
            practiceAreaId: signRes.matter.practiceAreaId,
            workTypeSubcategoryId: signRes.matter.workTypeSubcategoryId,
            engagementLetterStatus: 'Sent',
            rowVersion: signRes.matter.rowVersion,
          },
          { id: matterId, byId: 'P-000002', saveMode: 'submit_cleared' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(regFromSigned.errors?.engagementLetterStatus).toMatch(/backwards/i);

    // Opening gate now succeeds cleanly on Conveyancing matter
    const openRes = (await runAsActionActor(
      'P-000002',
      () => openProspectiveMatterAction(matterId),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; matter?: Matter };
    expect(openRes.ok).toBe(true);
    expect(openRes.matter?.matterStatusId).toBe('matter_status.active');

    // Verify audit trail recorded send & signed entries and R812 zero CDD fields in dispatches
    const matterAudits = await auditRepo.listAuditEntriesForRecord(
      ctx,
      'matter',
      matterId,
    );
    expect(
      matterAudits.some((e) => e.field === 'Engagement letter sent'),
    ).toBe(true);
    expect(
      matterAudits.some((e) => e.field === 'Engagement letter signed'),
    ).toBe(true);
    const serializedDispatch = JSON.stringify(dispatchesAfterSign);
    expect(serializedDispatch).not.toContain('amlStatus');
    expect(serializedDispatch).not.toContain('amlCompletedAt');
    expect((await outboxRepo.getOutboxRecordById(ctx, sendRes.outboxRecord.id))?.matterId).toBe(
      matterId,
    );
  }, 45_000);

  it('2. R817 stored-purpose isolation: Finance attacking CDD artifact with ?purpose=engagement_signed receives opaque 404 NOT_FOUND, while downloading stored engagement_signed succeeds', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const matterRepo = new TenantMatterRepository();

    // Partner creates a matter and uploads both a CDD artifact (O-000001) and a signed engagement copy (matter)
    let matterId = '';
    let cddArtifactId = '';
    let cddBlobKey = '';
    let cddSha256 = '';
    let engArtifactId = '';
    let engBlobKey = '';
    let engSha256 = '';
    const signedBytes = Buffer.from('%PDF-1.4\n% Finance accessible signed copy\n%%EOF\n');

    await runAsActionActor(
      'P-000001',
      async () => {
        const mSave = await saveMatterRecord(
          {
            title: 'R817 Stored Purpose Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_acquisitions',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        matterId = mSave.matter!.id;

        const cddUp = await uploadEvidenceArtifactRecord(
          {
            subjectType: 'organisation',
            subjectId: 'O-000001',
            purpose: 'cdd',
            fileName: 'r817-cdd.pdf',
            contentType: 'application/pdf',
            bytes: Buffer.from('%PDF-1.4\n% Secret CDD doc\n%%EOF\n'),
          },
          'P-000001',
        );
        expect(cddUp.ok).toBe(true);
        if (!cddUp.ok) return;
        cddArtifactId = cddUp.artifact.id;
        cddBlobKey = cddUp.artifact.blobKey;
        cddSha256 = cddUp.artifact.sha256;

        const engUp = await uploadEvidenceArtifactRecord(
          {
            subjectType: 'matter',
            subjectId: matterId,
            purpose: 'engagement_signed',
            fileName: 'r817-signed.pdf',
            contentType: 'application/pdf',
            bytes: signedBytes,
          },
          'P-000001',
        );
        expect(engUp.ok).toBe(true);
        if (!engUp.ok) return;
        engArtifactId = engUp.artifact.id;
        engBlobKey = engUp.artifact.blobKey;
        engSha256 = engUp.artifact.sha256;
      },
      { roles: ['partner'], mfaVerified: false },
    );

    const activeCfg = getActiveTenantConfiguration();
    const storage = getDocumentStorage(activeCfg);
    const financeCtx = makeVerifiedTenantCtx('not-a-law-firm', 'P-000009', ['finance'], false);

    // Mint 3 Finance-owned tokens:
    // (1) targeting the CDD artifact, (2) targeting a nonexistent artifact, (3) targeting a cross-tenant blobKey
    const cddTokenForFinance = await storage.issueScopedDownloadToken(financeCtx, {
      blobKey: cddBlobKey,
      fileName: 'r817-cdd.pdf',
      documentId: cddArtifactId,
    });
    const orphanStored = await storage.putObject(financeCtx, {
      category: 'documents',
      objectId: 'r817-orphan-test',
      fileName: 'orphan.pdf',
      contentType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.4\n% Orphan test object\n%%EOF\n'),
    });
    const missingTokenForFinance = await storage.issueScopedDownloadToken(financeCtx, {
      blobKey: orphanStored.blobKey,
      fileName: 'missing.pdf',
      documentId: 'EVD-999999',
    });
    const mismatchedBlobTokenForFinance = await storage.issueScopedDownloadToken(
      financeCtx,
      {
        blobKey: orphanStored.blobKey,
        fileName: 'other.pdf',
        documentId: cddArtifactId,
      },
    );

    // Attack: Finance passes ?purpose=engagement_signed to try bypassing cdd:view!
    const [cddAttackRes, missingRes, mismatchRes] = await Promise.all([
      runAsActionActor(
        'P-000009',
        () =>
          evidenceDownloadRoute.GET(
            new Request(
              `http://localhost/api/evidence/download?token=${encodeURIComponent(cddTokenForFinance.token)}&purpose=engagement_signed`,
              { method: 'GET' },
            ),
          ),
        { roles: ['finance'], mfaVerified: false },
      ),
      runAsActionActor(
        'P-000009',
        () =>
          evidenceDownloadRoute.GET(
            new Request(
              `http://localhost/api/evidence/download?token=${encodeURIComponent(missingTokenForFinance.token)}&purpose=engagement_signed`,
              { method: 'GET' },
            ),
          ),
        { roles: ['finance'], mfaVerified: false },
      ),
      runAsActionActor(
        'P-000009',
        () =>
          evidenceDownloadRoute.GET(
            new Request(
              `http://localhost/api/evidence/download?token=${encodeURIComponent(mismatchedBlobTokenForFinance.token)}&purpose=engagement_signed`,
              { method: 'GET' },
            ),
          ),
        { roles: ['finance'], mfaVerified: false },
      ),
    ]);

    expect(cddAttackRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    expect(mismatchRes.status).toBe(404);
    const [cddAttackBody, missingBody, mismatchBody] = await Promise.all([
      cddAttackRes.text(),
      missingRes.text(),
      mismatchRes.text(),
    ]);
    expect(cddAttackBody).toBe(missingBody);
    expect(mismatchBody).toBe(missingBody);
    expect(JSON.parse(cddAttackBody)).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      error: 'Evidence file not found or access denied.',
    });

    // Positive control: Finance CAN download a stored `purpose: 'engagement_signed'` file on an accessible matter
    const engTokenForFinance = await storage.issueScopedDownloadToken(financeCtx, {
      blobKey: engBlobKey,
      fileName: 'r817-signed.pdf',
      documentId: engArtifactId,
    });
    const engDownloadRes = await runAsActionActor(
      'P-000009',
      () =>
        evidenceDownloadRoute.GET(
          new Request(
            `http://localhost/api/evidence/download?token=${encodeURIComponent(engTokenForFinance.token)}`,
            { method: 'GET' },
          ),
        ),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(engDownloadRes.status).toBe(200);
    expect(Buffer.from(await engDownloadRes.arrayBuffer())).toEqual(signedBytes);

    // Cross-purpose upload/attachment guards:
    // (a) Cannot upload 'engagement_signed' referencing a non-matter subject
    const badUploadForm = new FormData();
    badUploadForm.set('subjectType', 'organisation');
    badUploadForm.set('subjectId', 'O-000001');
    badUploadForm.set('purpose', 'engagement_signed');
    badUploadForm.set(
      'file',
      new File([signedBytes], 'signed.pdf', { type: 'application/pdf' }),
    );
    const badFormSerialized = new Response(badUploadForm);
    const badFormBody = await badFormSerialized.arrayBuffer();
    const badPurposeUpload = await runAsActionActor(
      'P-000001',
      () =>
        evidenceUploadRoute.POST(
          new Request('http://localhost/api/evidence/upload', {
            method: 'POST',
            headers: {
              'content-type':
                badFormSerialized.headers.get('content-type') ||
                'multipart/form-data',
              'content-length': String(badFormBody.byteLength),
            },
            body: badFormBody,
          }),
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(badPurposeUpload.status).toBe(400);

    // (b) Cannot attach a 'cdd' artifact to recordEngagementLetterSignedRecord
    const wrongPurposeSign = await runAsActionActor(
      'P-000001',
      () =>
        recordEngagementLetterSignedRecord(
          {
            matterId,
            evidenceArtifactId: cddArtifactId,
            status: 'Signed & returned',
          },
          'P-000001',
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(wrongPurposeSign).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    // (c) Cannot attach an 'engagement_signed' artifact (even if tampered subject) to a CDD record
    const cddLoad = await runAsActionActor(
      'P-000001',
      () =>
        startOrLoadClientCddRecord(
          { subjectType: 'organisation', subjectId: 'O-000001', createIfMissing: true },
          'P-000001',
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    if (cddLoad.ok && cddLoad.summary.recordId && cddLoad.summary.checklistItems[0]) {
      const attachWrongToCdd = await runAsActionActor(
        'P-000001',
        () =>
          recordCddChecklistItemRecord(
            {
              recordId: cddLoad.summary.recordId!,
              itemKey: cddLoad.summary.checklistItems[0]!.itemKey,
              status: 'recorded',
              evidenceRefs: [
                {
                  blobKey: engBlobKey,
                  sha256: engSha256,
                  contentType: 'application/pdf',
                  sizeBytes: signedBytes.byteLength,
                  scanStatus: 'clean',
                },
              ],
            },
            'P-000001',
          ),
        { roles: ['partner'], mfaVerified: false },
      );
      expect(attachWrongToCdd.ok).toBe(false);
    }

    // Confirm matter was not falsely signed or corrupted by negative CDD ref attempt
    const unchangedMatter = await matterRepo.getMatterById<Matter>(
      testTenantCtx('P-000001'),
      matterId,
      { includeRestricted: true },
    );
    expect(unchangedMatter?.engagementLetterSignedAt).toBeNull();
    expect(cddSha256).toHaveLength(64);
  }, 45_000);

  it('3. ADR 0042 communication-chases & R818: day 7/14/21 progression, Promise.all idempotency, stop->resend, zero backfill, and restricted matter safety', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000002');
    const matterRepo = new TenantMatterRepository();
    const chasingRepo = new TenantChasingRepository();
    const outboxRepo = new TenantOutboxRepository();
    const taskRepo = new TenantTaskWorkflowRepository();

    const chaseEnabledCfg = loadAndValidateTenantConfig(
      notALawFirmBaseConfig as unknown as Record<string, unknown>,
      {
        tenantId: 'not-a-law-firm',
        integrations: {
          ...((notALawFirmBaseConfig as unknown as { integrations: Record<string, unknown> })
            .integrations ?? {}),
          email: { provider: 'disabled' },
        },
        chasing: {
          engagementLetter: {
            enabled: true,
            sendEmails: true,
            firstChaseDays: 7,
            secondChaseDays: 14,
            escalateTaskDays: 21,
          },
          quote: {
            enabled: true,
            sendEmails: true,
            firstChaseDays: 7,
            secondChaseDays: 14,
            escalateTaskDays: 21,
          },
          moneyOnAccount: {
            enabled: true,
            sendEmails: true,
            firstChaseDays: 7,
            secondChaseDays: 14,
            escalateTaskDays: 21,
          },
        },
      },
      'test',
    );

    let matterA = '';
    let matterB = '';
    let restrictedMatterId = '';

    await runAsActionActor(
      'P-000001',
      async () => {
        const resA = await saveMatterRecord(
          {
            title: 'Chase Timeline Matter A',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        matterA = resA.matter!.id;

        const resB = await saveMatterRecord(
          {
            title: 'Chase Resend Matter B (R818)',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        matterB = resB.matter!.id;

        // Pre-WP3 legacy 'Sent' matter with NO communication_chases row -> must never be backfilled
        const legacyMatterRes = await saveMatterRecord(
          {
            title: 'Legacy Pre-WP3 Sent Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        const legacyM = legacyMatterRes.matter!;
        await matterRepo.withTenantTransaction(ctx, async () => {
          await matterRepo.putMatter(
            ctx,
            {
              ...legacyM,
              engagementLetterStatus: 'Sent',
              engagementLetterSentAt: '2026-10-01T09:00:00.000Z',
            },
            { expectedRowVersion: null },
          );
        });

        // Restricted ethical-wall matter where leadFeeEarner (P-000002) is NOT on allow-list
        const restrictedRes = await saveMatterRecord(
          {
            title: 'Restricted Ethical Wall Chase Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        restrictedMatterId = restrictedRes.matter!.id;
        await matterRepo.withTenantTransaction(ctx, async () => {
          await matterRepo.putMatter(
            ctx,
            {
              ...restrictedRes.matter!,
              hasEthicalWall: true,
              restrictedAccessUserIds: ['P-000001'],
            },
            {
              expectedRowVersion: null,
              sqlRestrictedAccessUserIds: ['P-000001'],
            },
          );
        });
      },
      { roles: ['partner'], mfaVerified: false },
    );

    const sendA = await runAsActionActor(
      'P-000001',
      () =>
        sendEngagementLetterRecord(
          {
            matterId: matterA,
            recipientEmail: 'chase-a@1squared.co.uk',
            recipientName: 'Chase A Client',
          },
          'P-000001',
          { tenantConfig: chaseEnabledCfg, drainAfterCommit: false },
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(sendA.ok).toBe(true);
    if (!sendA.ok) return;
    const chaseAId = sendA.chase!.id;
    const sentAtDateA = new Date(sendA.chase!.sentAt);

    // Day +6 -> nothing due
    const day6 = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseEnabledCfg,
      drainAfterCommit: false,
      now: addDays(sentAtDateA, 6),
    });
    expect(day6.outcome).toBe('executed');
    if (day6.outcome === 'executed') {
      expect(day6.result.summary.dueEvaluated).toBe(0);
    }

    // Day +7 under Promise.all concurrency -> only 1 execution creates step 1 email (`chase:<chaseId>:step:1`)
    const [run7A, run7B] = await Promise.all([
      executeCommunicationChasesForTenant(ctx, {
        triggerSource: 'manual',
        triggeredById: 'system:communication-chases',
        tenantConfig: chaseEnabledCfg,
        drainAfterCommit: false,
        now: addDays(sentAtDateA, 7),
      }),
      executeCommunicationChasesForTenant(ctx, {
        triggerSource: 'manual',
        triggeredById: 'system:communication-chases',
        tenantConfig: chaseEnabledCfg,
        drainAfterCommit: false,
        now: addDays(sentAtDateA, 7),
      }),
    ]);
    const executed7 = [run7A, run7B].filter((r) => r.outcome === 'executed');
    expect(executed7.length).toBeGreaterThanOrEqual(1);
    const step1Outbox = await outboxRepo.listOutboxRecords(ctx, { limit: 100 });
    const step1Matches = step1Outbox.filter(
      (r) => r.idempotencyKey === `chase:${chaseAId}:step:1`,
    );
    expect(step1Matches).toHaveLength(1);
    expect(step1Matches[0]?.matterId).toBe(matterA);

    // Also prove repository-level concurrent step idempotency (`ON CONFLICT DO NOTHING`)
    const [race1, race2] = await Promise.all([
      chasingRepo.withTenantTransaction(ctx, (tx) =>
        chasingRepo.recordChaseStepEventAndAdvanceInTx(tx, ctx, {
          chaseId: chaseAId,
          stepIndex: 1,
          actionKind: 'chase_email',
          outcome: 'executed',
          executedAt: addDays(sentAtDateA, 7).toISOString(),
          nextActionAt: addDays(sentAtDateA, 14).toISOString(),
        }),
      ),
      chasingRepo.withTenantTransaction(ctx, (tx) =>
        chasingRepo.recordChaseStepEventAndAdvanceInTx(tx, ctx, {
          chaseId: chaseAId,
          stepIndex: 1,
          actionKind: 'chase_email',
          outcome: 'executed',
          executedAt: addDays(sentAtDateA, 7).toISOString(),
          nextActionAt: addDays(sentAtDateA, 14).toISOString(),
        }),
      ),
    ]);
    expect(race1.alreadyExecuted && race2.alreadyExecuted).toBe(true);

    // Day +14 -> step 2 email (`chase:<chaseId>:step:2`)
    const day14 = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseEnabledCfg,
      drainAfterCommit: false,
      now: addDays(sentAtDateA, 14),
    });
    expect(day14.outcome).toBe('executed');
    const step2Matches = (await outboxRepo.listOutboxRecords(ctx, { limit: 100 })).filter(
      (r) => r.idempotencyKey === `chase:${chaseAId}:step:2`,
    );
    expect(step2Matches).toHaveLength(1);

    // Day +21 -> escalation task created for permitted participant, chase completed
    const day21 = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseEnabledCfg,
      drainAfterCommit: false,
      now: addDays(sentAtDateA, 21),
    });
    expect(day21.outcome).toBe('executed');
    const finishedChaseA = await chasingRepo.getChaseById(ctx, chaseAId);
    expect(finishedChaseA?.status).toBe('completed');
    const tasksA = await taskRepo.listTasksLinkedToRecord<Task>(ctx, 'matter', matterA);
    expect(
      tasksA.some((t) => t.autoTrigger === 'communication_chase_escalation' && t.status === 'To do'),
    ).toBe(true);

    // Restricted ethical-wall chase escalation must assign ONLY to permitted partner P-000001 (NOT P-000002)
    const sendRestricted = await runAsActionActor(
      'P-000001',
      () =>
        sendEngagementLetterRecord(
          {
            matterId: restrictedMatterId,
            recipientEmail: 'restricted@1squared.co.uk',
          },
          'P-000001',
          { tenantConfig: chaseEnabledCfg, drainAfterCommit: false },
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(sendRestricted.ok).toBe(true);
    if (!sendRestricted.ok) return;
    const restrictedSent = new Date(sendRestricted.chase!.sentAt);
    for (const dayOffset of [7, 14, 21]) {
      await executeCommunicationChasesForTenant(ctx, {
        triggerSource: 'manual',
        triggeredById: 'system:communication-chases',
        tenantConfig: chaseEnabledCfg,
        drainAfterCommit: false,
        now: addDays(restrictedSent, dayOffset),
      });
    }
    const restrictedTasks = await taskRepo.listTasksLinkedToRecord<Task>(
      ctx,
      'matter',
      restrictedMatterId,
    );
    const escTask = restrictedTasks.find(
      (t) => t.autoTrigger === 'communication_chase_escalation',
    );
    expect(escTask).toBeDefined();
    expect(escTask?.assignedPersonId).toBe('P-000001');

    // R818: send -> stop -> send again on Matter B creates new chaseId -> Day 7 & 14 queue cleanly
    const sendB1 = await runAsActionActor(
      'P-000001',
      () =>
        sendEngagementLetterRecord(
          { matterId: matterB, recipientEmail: 'resend-b@1squared.co.uk' },
          'P-000001',
          { tenantConfig: chaseEnabledCfg, drainAfterCommit: false },
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(sendB1.ok).toBe(true);
    if (!sendB1.ok) return;
    const chaseB1 = sendB1.chase!.id;

    const stopB1 = await runAsActionActor(
      'P-000001',
      () =>
        stopCommunicationChaseAction({ chaseId: chaseB1, reason: 'manual_stop' }),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(stopB1.ok).toBe(true);

    const sendB2 = await runAsActionActor(
      'P-000001',
      () =>
        sendEngagementLetterRecord(
          { matterId: matterB, recipientEmail: 'resend-b@1squared.co.uk' },
          'P-000001',
          { tenantConfig: chaseEnabledCfg, drainAfterCommit: false },
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(sendB2.ok).toBe(true);
    if (!sendB2.ok) return;
    const chaseB2 = sendB2.chase!.id;
    expect(chaseB2).not.toBe(chaseB1);

    const sentDateB2 = new Date(sendB2.chase!.sentAt);
    await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseEnabledCfg,
      drainAfterCommit: false,
      now: addDays(sentDateB2, 7),
    });
    await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseEnabledCfg,
      drainAfterCommit: false,
      now: addDays(sentDateB2, 14),
    });

    const b2Outbox = await outboxRepo.listOutboxRecords(ctx, { limit: 100 });
    expect(
      b2Outbox.filter((r) => r.idempotencyKey === `chase:${chaseB2}:step:1`),
    ).toHaveLength(1);
    expect(
      b2Outbox.filter((r) => r.idempotencyKey === `chase:${chaseB2}:step:2`),
    ).toHaveLength(1);
    expect(
      b2Outbox.filter((r) => r.idempotencyKey.startsWith(`chase:${chaseB1}:`)),
    ).toHaveLength(0);
  }, 45_000);

  it('4. R823 & R826 Admin Outbox Viewer (MFA, audited view/download, unlinked & restricted hidden as 404, zero CDD), Lever 1 MFA saves, and Lever 2 conflict Non-Engagement dispatch', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const outboxRepo = new TenantOutboxRepository();
    const auditRepo = new TenantAuditRepository();
    const taskRepo = new TenantTaskWorkflowRepository();
    const matterRepo = new TenantMatterRepository();

    // Ensure P-000004 holds only 'admin' (no matter:restricted:access) for R823 restricted check,
    // and create one open matter email, one ethical-wall restricted matter email, and one unlinked email.
    let visibleMatterId = '';
    let restrictedMatterId = '';
    await runAsActionActor(
      'P-000001',
      async () => {
        const resVis = await saveMatterRecord(
          {
            title: 'Outbox Visible Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        visibleMatterId = resVis.matter!.id;

        const resWall = await saveMatterRecord(
          {
            title: 'Outbox Walled Matter Hidden From Admin',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000001',
            teamMemberIds: ['P-000001'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        restrictedMatterId = resWall.matter!.id;
        await matterRepo.withTenantTransaction(ctx, async () => {
          await matterRepo.putMatter(
            ctx,
            {
              ...resWall.matter!,
              hasEthicalWall: true,
              restrictedAccessUserIds: ['P-000001'],
            },
            {
              expectedRowVersion: null,
              sqlRestrictedAccessUserIds: ['P-000001'],
            },
          );
        });
      },
      { roles: ['partner'], mfaVerified: false },
    );

    const visibleSend = await runAsActionActor(
      'P-000001',
      () =>
        sendEngagementLetterRecord(
          { matterId: visibleMatterId, recipientEmail: 'vis@1squared.co.uk' },
          'P-000001',
          { drainAfterCommit: false },
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    const walledSend = await runAsActionActor(
      'P-000001',
      () =>
        sendEngagementLetterRecord(
          { matterId: restrictedMatterId, recipientEmail: 'wall@1squared.co.uk' },
          'P-000001',
          { drainAfterCommit: false },
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(visibleSend.ok).toBe(true);
    expect(walledSend.ok).toBe(true);
    if (!visibleSend.ok || !walledSend.ok) return;

    // Enqueue an UNLINKED staff notification/digest email (`matter_id = NULL, quote_id = NULL, enquiry_id = NULL`)
    const unlinkedQueued = await outboxRepo.enqueueEmail(ctx, {
      idempotencyKey: 's106-unlinked-notification-email',
      templateKey: 'notification.digest',
      recipients: { to: ['staff@1squared.co.uk'] },
      subject: 'Internal Staff Digest — Unlinked',
      htmlBody: '<p>Confidential staff digest content</p>',
      textBody: 'Confidential staff digest content',
      attachments: [
        {
          kind: 'inline',
          fileName: 'digest.pdf',
          contentType: 'application/pdf',
          contentBytes: Buffer.from('%PDF-1.4\n% Unlinked digest\n%%EOF\n'),
        },
      ],
      createdByPersonId: 'P-000001',
    });

    // Gate checks: non-admin FORBIDDEN; admin without MFA MFA_REQUIRED
    const feeEarnerAttempt = await runAsActionActor(
      'P-000002',
      () => listOutboxMessagesForAdminAction(),
      { roles: ['fee_earner'], mfaVerified: true },
    );
    expect(isActionDenied(feeEarnerAttempt as never)).toBe(true);
    if ('code' in feeEarnerAttempt) {
      expect(feeEarnerAttempt.code).toBe('FORBIDDEN');
    }

    const adminNoMfa = await runAsActionActor(
      'P-000004',
      () => listOutboxMessagesForAdminAction(),
      { roles: ['admin'], mfaVerified: false },
    );
    expect(isActionDenied(adminNoMfa as never)).toBe(true);
    if ('code' in adminNoMfa) {
      expect(adminNoMfa.code).toBe('MFA_REQUIRED');
    }

    // Create a pure Admin user with roles: ['admin'] only (so P-000004 partner access isn't mixed; also verify R823 on pure admin!)
    const partyRepo = new TenantPartyRepository();
    const baseEmp = (await partyRepo.getPersonById<Person>(ctx, 'P-000004'))!;
    const pureAdmin: Person = {
      ...baseEmp,
      id: 'P-S106-ADMIN',
      firstName: 'Tamsin',
      surname: 'OutboxAdmin',
      employeeRoleId: 'employee_role.system_administrator',
      roles: ['admin'],
      appRole: 'admin',
      entraObjectId: undefined,
      emails: [
        {
          id: 'em-s106-admin',
          address: 'tamsin.admin@notalawfirm.example',
          isPrimary: true,
          typeId: null,
        },
      ],
    };
    await partyRepo.putPeople(ctx, [pureAdmin]);

    // Pure Admin with MFA lists outbox: sees visibleMatter email (with NO body keys & NO CDD keys),
    // and EXCLUDES BOTH walledSend and unlinkedQueued!
    const adminList = await runAsActionActor(
      pureAdmin.id,
      () => listOutboxMessagesForAdminAction({ limit: 50 }),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(adminList.ok).toBe(true);
    if (!adminList.ok) return;
    const listedIds = adminList.messages.map((m) => m.id);
    expect(listedIds).toContain(visibleSend.outboxRecord.id);
    expect(listedIds).not.toContain(walledSend.outboxRecord.id);
    expect(listedIds).not.toContain(unlinkedQueued.record.id);

    const visibleListItem = adminList.messages.find(
      (m) => m.id === visibleSend.outboxRecord.id,
    )!;
    expect('htmlBody' in visibleListItem).toBe(false);
    expect('textBody' in visibleListItem).toBe(false);
    expect(JSON.stringify(adminList.messages)).not.toContain('amlStatus');
    expect(JSON.stringify(adminList.messages)).not.toContain('amlCompletedAt');

    // Opening or downloading hidden walled OR unlinked OR missing -> ALL return identical NOT_FOUND (404)
    const [openWalled, openUnlinked, openMissing] = await runAsActionActor(
      pureAdmin.id,
      () =>
        Promise.all([
          getOutboxMessageForAdminAction({ outboxId: walledSend.outboxRecord.id }),
          getOutboxMessageForAdminAction({ outboxId: unlinkedQueued.record.id }),
          getOutboxMessageForAdminAction({ outboxId: 'EO-999999' }),
        ]),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(openWalled).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(openUnlinked).toEqual(openWalled);
    expect(openMissing).toEqual(openWalled);

    const [dlWalled, dlUnlinked] = await runAsActionActor(
      pureAdmin.id,
      () =>
        Promise.all([
          outboxAttachmentRoute.GET(
            new Request(`http://localhost/api/admin/outbox/${walledSend.outboxRecord.id}/attachments/0`),
            {
              params: Promise.resolve({
                id: walledSend.outboxRecord.id,
                ordinal: '0',
              }),
            },
          ),
          outboxAttachmentRoute.GET(
            new Request(`http://localhost/api/admin/outbox/${unlinkedQueued.record.id}/attachments/0`),
            {
              params: Promise.resolve({
                id: unlinkedQueued.record.id,
                ordinal: '0',
              }),
            },
          ),
        ]),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(dlWalled.status).toBe(404);
    expect(dlUnlinked.status).toBe(404);
    expect(await dlWalled.text()).toBe(await dlUnlinked.text());

    // Open visible outbox message & download PDF non-destructively -> writes 'view' and 'download' audit entries, status remains 'pending'
    const openVisible = await runAsActionActor(
      pureAdmin.id,
      () => getOutboxMessageForAdminAction({ outboxId: visibleSend.outboxRecord.id }),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(openVisible.ok).toBe(true);
    if (!openVisible.ok) return;
    expect(openVisible.message.htmlBody).toContain('Client Care');
    expect(JSON.stringify(openVisible.message)).not.toContain('amlStatus');

    const dlVisibleRes = await runAsActionActor(
      pureAdmin.id,
      () =>
        outboxAttachmentRoute.GET(
          new Request(
            `http://localhost/api/admin/outbox/${visibleSend.outboxRecord.id}/attachments/0`,
          ),
          {
            params: Promise.resolve({
              id: visibleSend.outboxRecord.id,
              ordinal: '0',
            }),
          },
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(dlVisibleRes.status).toBe(200);
    const dlVisibleBytes = new Uint8Array(await dlVisibleRes.arrayBuffer());
    expect(Buffer.from(dlVisibleBytes).toString('latin1').startsWith('%PDF-')).toBe(true);

    // Zero status mutation
    expect(
      (await outboxRepo.getOutboxRecordById(ctx, visibleSend.outboxRecord.id))?.status,
    ).toBe('pending');

    // Audit entries recorded for view & download
    const viewAudits = await auditRepo.listAuditEntriesForRecord(
      ctx,
      'email_outbox',
      visibleSend.outboxRecord.id,
    );
    expect(viewAudits.some((a) => a.action === 'view' && a.byId === pureAdmin.id)).toBe(true);
    const dlAudits = await auditRepo.listAuditEntriesForRecord(
      ctx,
      'email_outbox_attachment',
      `${visibleSend.outboxRecord.id}:0`,
    );
    expect(dlAudits.some((a) => a.action === 'download' && a.byId === pureAdmin.id)).toBe(true);

    // Positive control: adding pureAdmin to restricted matter allow-list reveals the email to pureAdmin
    const currentWallMatter = (await matterRepo.getMatterById<Matter>(
      ctx,
      restrictedMatterId,
      { includeRestricted: true },
    ))!;
    await matterRepo.withTenantTransaction(ctx, async () => {
      await matterRepo.putMatter(
        ctx,
        {
          ...currentWallMatter,
          restrictedAccessUserIds: ['P-000001', pureAdmin.id],
        },
        {
          expectedRowVersion: null,
          sqlRestrictedAccessUserIds: ['P-000001', pureAdmin.id],
        },
      );
    });
    const listAfterAllow = await runAsActionActor(
      pureAdmin.id,
      () => listOutboxMessagesForAdminAction({ limit: 50 }),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(listAfterAllow.ok).toBe(true);
    if (listAfterAllow.ok) {
      expect(listAfterAllow.messages.map((m) => m.id)).toContain(
        walledSend.outboxRecord.id,
      );
    }

    // Lever 1: saveChasingConfigAction & saveEngagementConfigAction require MFA + validate schedules
    const noMfaChase = await runAsActionActor(
      pureAdmin.id,
      () =>
        saveChasingConfigAction(
          {
            engagementLetter: {
              enabled: true,
              sendEmails: true,
              firstChaseDays: 7,
              secondChaseDays: 14,
              escalateTaskDays: 21,
            },
          },
          'Without MFA',
        ),
      { roles: ['admin'], mfaVerified: false },
    );
    expect(isActionDenied(noMfaChase as never)).toBe(true);

    const invalidSchedule = await runAsActionActor(
      pureAdmin.id,
      () =>
        saveChasingConfigAction(
          {
            engagementLetter: {
              enabled: true,
              sendEmails: true,
              firstChaseDays: 14,
              secondChaseDays: 10,
              escalateTaskDays: 21,
            },
          },
          'Invalid ascending days test',
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(invalidSchedule).toMatchObject({
      ok: false,
      code: 'CHASING_VALIDATION_ERROR',
    });

    const validChaseSave = await runAsActionActor(
      pureAdmin.id,
      () =>
        saveChasingConfigAction(
          {
            engagementLetter: {
              enabled: true,
              sendEmails: true,
              firstChaseDays: 5,
              secondChaseDays: 12,
              escalateTaskDays: 20,
            },
          },
          'Configured faster engagement chasing cadence',
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(validChaseSave.ok).toBe(true);

    const validEngSave = await runAsActionActor(
      pureAdmin.id,
      () =>
        saveEngagementConfigAction(
          {
            clientCareIntroductoryParagraph: 'Updated intro paragraph.',
          },
          'Adjusted introductory wording',
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(validEngSave.ok).toBe(true);

    // Lever 2: Conflict-declined enquiry Non-Engagement dispatch reveals zero third-party secrets and closes task
    const enqSave = await runAsActionActor(
      'P-000002',
      () =>
        saveEnquiryRecord(
          {
            firstName: 'Owen',
            lastName: 'Prospect',
            email: 'owen.prospect@1squared.co.uk',
            phone: '029 2000 0999',
            channelId: 'enquiry_channel.phone',
            practiceAreaId: 'work_type.employment_and_hr',
            summary: 'Dismissal dispute with opposing party XYZ',
            otherPartiesNamed: 'SECRET CONFLICTS LTD',
            notes: 'Internal note mentioning SECRET CONFLICTS LTD counterparty.',
            privacyNoticeGiven: true,
          },
          { byId: 'P-000002' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(enqSave.errors).toBeUndefined();
    const enquiryId = enqSave.enquiry!.id;

    const closeRes = await runAsActionActor(
      'P-000002',
      () =>
        closeEnquiryRecord(
          enquiryId,
          {
            targetStatus: 'Declined',
            closeReasonId: vid('enquiry_close_reason', 'Conflict of interest'),
            closeNotes: 'Conflicting existing client Acme Secret Holdings.',
          },
          'P-000002',
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(closeRes.error).toBeUndefined();
    expect(closeRes.nonEngagementTask?.autoTrigger).toBe('non_engagement_letter');
    expect(closeRes.nonEngagementTask?.status).toBe('To do');

    const nonEngSend = await runAsActionActor(
      'P-000002',
      () => sendNonEngagementLetterAction({ enquiryId }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(nonEngSend.ok).toBe(true);
    if (!nonEngSend.ok) return;

    expect(nonEngSend.dispatch.kind).toBe('non_engagement');
    expect(nonEngSend.dispatch.enquiryId).toBe(enquiryId);
    expect(nonEngSend.outboxRecord.enquiryId).toBe(enquiryId);
    expect(nonEngSend.closedTaskIds).toContain(closeRes.nonEngagementTask!.id);

    const outboxDetail = await outboxRepo.getOutboxRecordById(
      ctx,
      nonEngSend.outboxRecord.id,
    );
    expect(outboxDetail?.textBody).not.toContain('SECRET CONFLICTS LTD');
    expect(outboxDetail?.textBody).not.toContain('Acme Secret Holdings');
    expect(outboxDetail?.textBody).not.toContain('Employment');

    const attNonEng = await runAsActionActor(
      pureAdmin.id,
      () =>
        downloadOutboxAttachmentForAdminRecord(
          { outboxId: nonEngSend.outboxRecord.id, ordinal: 0 },
          pureAdmin.id,
          { mfaVerified: true },
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(attNonEng.ok).toBe(true);
    if (attNonEng.ok) {
      const pdfStr = Buffer.from(attNonEng.attachment.contentBytes).toString('latin1');
      expect(pdfStr.startsWith('%PDF-')).toBe(true);
      expect(pdfStr).not.toContain('SECRET CONFLICTS LTD');
      expect(pdfStr).not.toContain('Acme Secret Holdings');
    }

    const updatedTasks = await taskRepo.listTasksLinkedToRecord<Task>(
      ctx,
      'enquiry',
      enquiryId,
    );
    const closedNonEngTask = updatedTasks.find(
      (t) => t.id === closeRes.nonEngagementTask!.id,
    );
    expect(closedNonEngTask?.status).toBe('Done');
    expect(closedNonEngTask?.completedById).toBe('P-000002');
  }, 45_000);

  it('5. Two-tenant isolation: Alpha and Bravo keep dispatches, chases, outbox messages, attachments, and signed evidence strictly separate', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'tenant-alpha', environment: 'test' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      ],
    });
    const poolManager = new TenantPostgresPoolManager();
    const runner = new TenantMigrationRunner();
    const alphaRaw = {
      ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
      tenantId: 'tenant-alpha',
      integrations: {
        ...((notALawFirmBaseConfig as unknown as { integrations: Record<string, unknown> })
          .integrations ?? {}),
        email: { provider: 'disabled' },
      },
    };
    const bravoRaw = {
      ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
      tenantId: 'tenant-bravo',
      integrations: {
        ...((notALawFirmBaseConfig as unknown as { integrations: Record<string, unknown> })
          .integrations ?? {}),
        email: { provider: 'disabled' },
      },
    };
    const ctxAlpha = makeVerifiedTenantCtx('tenant-alpha', 'P-000001', ['partner', 'admin'], true);
    const ctxBravo = makeVerifiedTenantCtx('tenant-bravo', 'P-000001', ['partner', 'admin'], true);
    const alphaCfg = loadAndValidateTenantConfig(
      alphaRaw,
      { tenantId: 'tenant-alpha', environment: 'test' },
      'test',
      'multi_tenant',
    );
    const bravoCfg = loadAndValidateTenantConfig(
      bravoRaw,
      { tenantId: 'tenant-bravo', environment: 'test' },
      'test',
      'multi_tenant',
    );

    try {
      await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
      await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);

      const alphaStore = createSeedStore(new Date());
      const bravoStore = createSeedStore(new Date());
      await importFirmStoreModulesToPostgres({
        ctx: ctxAlpha,
        tenantConfig: alphaCfg,
        store: alphaStore,
        clearFirst: true,
      });
      await importFirmStoreModulesToPostgres({
        ctx: ctxBravo,
        tenantConfig: bravoCfg,
        store: bravoStore,
        clearFirst: true,
      });

      // Alpha partner creates & sends Client Care letter + uploads signed artifact
      setActiveTenantConfigForTesting(alphaRaw, {});
      let alphaMatterId = '';
      await runAsActionActor(
        'P-000001',
        async () => {
          const saveRes = await saveMatterRecord(
            {
              title: 'Alpha Confidential Matter',
              clientId: 'O-000001',
              practiceAreaId: 'work_type.employment_and_hr',
              workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
              responsiblePartnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              leadFeeEarnerId: 'P-000002',
              teamMemberIds: ['P-000001', 'P-000002'],
              conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan'),
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
            },
            { byId: 'P-000001', saveMode: 'submit_cleared' },
          );
          alphaMatterId = saveRes.matter!.id;
        },
        { tenantId: 'tenant-alpha', roles: ['partner'], mfaVerified: true },
      );

      const alphaSend = await runAsActionActor(
        'P-000001',
        () =>
          sendEngagementLetterRecord(
            { matterId: alphaMatterId, recipientEmail: 'alpha-client@1squared.co.uk' },
            'P-000001',
            { tenantCtx: ctxAlpha, tenantConfig: alphaCfg, drainAfterCommit: false },
          ),
        { tenantId: 'tenant-alpha', roles: ['partner'], mfaVerified: true },
      );
      expect(alphaSend.ok).toBe(true);
      if (!alphaSend.ok) return;

      const alphaSignedUp = await runAsActionActor(
        'P-000001',
        () => createSignedEngagementPdfArtifact(alphaMatterId, 'P-000001', ctxAlpha),
        { tenantId: 'tenant-alpha', roles: ['partner'], mfaVerified: true },
      );
      expect(alphaSignedUp.ok).toBe(true);
      if (!alphaSignedUp.ok) return;

      // Switch active config to Bravo and verify ZERO leakage / tampering succeeds
      setActiveTenantConfigForTesting(bravoRaw, {});

      const bravoOpenOutbox = await runAsActionActor(
        'P-000001',
        () =>
          getOutboxMessageForAdminAction({ outboxId: alphaSend.outboxRecord.id }),
        { tenantId: 'tenant-bravo', roles: ['partner', 'admin'], mfaVerified: true },
      );
      expect(bravoOpenOutbox).toMatchObject({ ok: false, code: 'NOT_FOUND' });

      const bravoDlOutbox = await runAsActionActor(
        'P-000001',
        () =>
          downloadOutboxAttachmentForAdminRecord(
            { outboxId: alphaSend.outboxRecord.id, ordinal: 0 },
            'P-000001',
            { tenantCtx: ctxBravo, tenantConfig: bravoCfg, mfaVerified: true },
          ),
        { tenantId: 'tenant-bravo', roles: ['partner', 'admin'], mfaVerified: true },
      );
      expect(bravoDlOutbox).toMatchObject({ ok: false, code: 'NOT_FOUND' });

      const bravoStopChase = await runAsActionActor(
        'P-000001',
        () =>
          stopCommunicationChaseRecord(
            { chaseId: alphaSend.chase!.id, reason: 'manual_stop' },
            'P-000001',
            { tenantCtx: ctxBravo, tenantConfig: bravoCfg },
          ),
        { tenantId: 'tenant-bravo', roles: ['partner'], mfaVerified: true },
      );
      expect(bravoStopChase).toMatchObject({ ok: false, code: 'NOT_FOUND' });

      // Alpha records remain untouched in Alpha DB
      setActiveTenantConfigForTesting(alphaRaw, {});
      const alphaChasing = await new TenantChasingRepository({ poolManager }).getChaseById(
        ctxAlpha,
        alphaSend.chase!.id,
      );
      expect(alphaChasing?.status).toBe('active');
      expect(
        await new TenantEvidenceArtifactRepository({ poolManager }).getArtifactById(
          ctxBravo,
          alphaSignedUp.artifact.id,
        ),
      ).toBeNull();
    } finally {
      setTestActorSession(null);
      setActiveTenantConfigForTesting(null);
      await poolManager.closeAllPools();
    }
  }, 45_000);

  it('6. R833 & R841: savepoint isolates single failing chase (PG trigger), marks partial run, escalates on 3rd failure, and audits every chase step', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const chasingRepo = new TenantChasingRepository();
    const outboxRepo = new TenantOutboxRepository();
    const taskRepo = new TenantTaskWorkflowRepository();
    const auditRepo = new TenantAuditRepository();
    const jobRunRepo = new TenantJobRunRepository();

    const chaseCfg = loadAndValidateTenantConfig(
      notALawFirmBaseConfig as unknown as Record<string, unknown>,
      {
        tenantId: 'not-a-law-firm',
        integrations: {
          ...((notALawFirmBaseConfig as unknown as { integrations: Record<string, unknown> })
            .integrations ?? {}),
          email: { provider: 'disabled' },
        },
        chasing: {
          engagementLetter: {
            enabled: true,
            sendEmails: true,
            firstChaseDays: 7,
            secondChaseDays: 14,
            escalateTaskDays: 21,
          },
          quote: { enabled: false, sendEmails: false, firstChaseDays: 7, secondChaseDays: 14, escalateTaskDays: 21 },
          moneyOnAccount: { enabled: false, sendEmails: false, firstChaseDays: 7, secondChaseDays: 14, escalateTaskDays: 21 },
        },
      },
      'test',
    );

    const matterIds: string[] = [];
    await runAsActionActor(
      'P-000001',
      async () => {
        for (const label of ['One', 'Two-Fail', 'Three']) {
          const mRes = await saveMatterRecord(
            {
              title: `R833 Savepoint Matter ${label}`,
              clientId: 'O-000001',
              practiceAreaId: 'work_type.employment_and_hr',
              workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
              responsiblePartnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              leadFeeEarnerId: 'P-000002',
              teamMemberIds: ['P-000001', 'P-000002'],
              conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan'),
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
            },
            { byId: 'P-000001', saveMode: 'submit_cleared' },
          );
          matterIds.push(mRes.matter!.id);
        }
      },
      { roles: ['partner'], mfaVerified: false },
    );

    const chases = [] as NonNullable<
      Extract<Awaited<ReturnType<typeof sendEngagementLetterRecord>>, { ok: true }>['chase']
    >[];
    for (let i = 0; i < matterIds.length; i++) {
      const sRes = await runAsActionActor(
        'P-000001',
        () =>
          sendEngagementLetterRecord(
            { matterId: matterIds[i]!, recipientEmail: `r833-${i}@example.test` },
            'P-000001',
            { tenantConfig: chaseCfg, drainAfterCommit: false },
          ),
        { roles: ['partner'], mfaVerified: false },
      );
      expect(sRes.ok).toBe(true);
      if (!sRes.ok || !sRes.chase) return;
      chases.push(sRes.chase);
    }

    const [chase1, chase2, chase3] = chases as [
      (typeof chases)[number],
      (typeof chases)[number],
      (typeof chases)[number],
    ];
    const day7Now = addDays(new Date(chase3.sentAt), 8);
    day7Now.setUTCHours(9, 0, 0, 0);

    // Install a temporary PostgreSQL BEFORE INSERT trigger on email_outbox that fails ONLY chase2 step 1
    const direct = await createDirectMigrationClient({ ctx });
    try {
      await direct.query(`
        CREATE OR REPLACE FUNCTION public.test_fail_r833_chase_fn()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.idempotency_key = 'chase:${chase2.id}:step:1' THEN
            RAISE EXCEPTION 'R833_SIMULATED_OUTBOX_FAILURE';
          END IF;
          RETURN NEW;
        END;
        $$;
        DROP TRIGGER IF EXISTS trg_test_fail_r833_chase ON public.email_outbox;
        CREATE TRIGGER trg_test_fail_r833_chase
          BEFORE INSERT ON public.email_outbox
          FOR EACH ROW EXECUTE FUNCTION public.test_fail_r833_chase_fn();
      `);

      const run1 = await executeCommunicationChasesForTenant(ctx, {
        triggerSource: 'scheduled',
        triggeredById: 'system:communication-chases',
        tenantConfig: chaseCfg,
        drainAfterCommit: false,
        now: day7Now,
      });
      expect(run1.outcome).toBe('executed');
      if (run1.outcome === 'executed') {
        expect(run1.result.summary.dueEvaluated).toBe(3);
        expect(run1.result.summary.emailsQueuedCount).toBe(2);
        expect(run1.result.summary.failedCount).toBe(1);
        expect(run1.jobRun.status).toBe('running');
        expect(run1.jobRun.summary.scope).toBe('partial');
      }

      // Chases 1 & 3 succeeded and committed; chase 2 rolled back cleanly and stayed on step 1
      const c1After = await chasingRepo.getChaseById(ctx, chase1.id);
      const c2After1 = await chasingRepo.getChaseById(ctx, chase2.id);
      const c3After = await chasingRepo.getChaseById(ctx, chase3.id);
      expect(c1After?.nextStepIndex).toBe(2);
      expect(c3After?.nextStepIndex).toBe(2);
      expect(c2After1?.status).toBe('active');
      expect(c2After1?.nextStepIndex).toBe(1);
      expect(c2After1?.consecutiveFailureCount).toBe(1);
      expect(c2After1?.lastErrorCode).toBeTruthy();

      const outboxAfter1 = await outboxRepo.listOutboxRecords(ctx, { limit: 100 });
      expect(outboxAfter1.some((r) => r.idempotencyKey === `chase:${chase1.id}:step:1`)).toBe(true);
      expect(outboxAfter1.some((r) => r.idempotencyKey === `chase:${chase3.id}:step:1`)).toBe(true);
      expect(outboxAfter1.some((r) => r.idempotencyKey === `chase:${chase2.id}:step:1`)).toBe(false);

      // Scheduled retry on same day runs because scope === 'partial' -> strike 2, then strike 3 -> 'failed' + 1 task
      const run2 = await executeCommunicationChasesForTenant(ctx, {
        triggerSource: 'scheduled',
        triggeredById: 'system:communication-chases',
        tenantConfig: chaseCfg,
        drainAfterCommit: false,
        now: new Date(day7Now.getTime() + 60_000),
      });
      expect(run2.outcome).toBe('executed');
      expect((await chasingRepo.getChaseById(ctx, chase2.id))?.consecutiveFailureCount).toBe(2);

      const run3 = await executeCommunicationChasesForTenant(ctx, {
        triggerSource: 'scheduled',
        triggeredById: 'system:communication-chases',
        tenantConfig: chaseCfg,
        drainAfterCommit: false,
        now: new Date(day7Now.getTime() + 120_000),
      });
      expect(run3.outcome).toBe('executed');
      const c2Failed = await chasingRepo.getChaseById(ctx, chase2.id);
      expect(c2Failed?.status).toBe('failed');
      expect(c2Failed?.consecutiveFailureCount).toBe(3);

      const failTasks = await taskRepo.listTasksLinkedToRecord<Task>(ctx, 'matter', matterIds[1]!);
      const failureEscTasks = failTasks.filter((t) => t.systemKey === `chase:${chase2.id}:failed_escalation`);
      expect(failureEscTasks).toHaveLength(1);
      expect(failureEscTasks[0]?.assignedPersonId).toBe('P-000002');

      // R841: Verify zero-PII per-step audit entries for queued & failed steps, plus skipped step
      const sendDisabledCfg = loadAndValidateTenantConfig(
        notALawFirmBaseConfig as unknown as Record<string, unknown>,
        {
          tenantId: 'not-a-law-firm',
          integrations: chaseCfg.integrations,
          chasing: {
            ...chaseCfg.chasing!,
            engagementLetter: {
              ...chaseCfg.chasing!.engagementLetter,
              sendEmails: false,
            },
          },
        },
        'test',
      );
      await executeCommunicationChasesForTenant(ctx, {
        triggerSource: 'manual',
        triggeredById: 'system:communication-chases',
        tenantConfig: sendDisabledCfg,
        drainAfterCommit: false,
        now: addDays(new Date(chase3.sentAt), 14),
      });

      const jobRuns = await jobRunRepo.listJobRuns(ctx, { jobKey: 'communication-chases' });
      expect(jobRuns.some((r) => r.status === 'running' && r.summary.scope === 'partial')).toBe(true);

      const c1Audits = await auditRepo.listAuditEntriesForRecord(ctx, 'communication_chase', chase1.id, { limit: 100 });
      expect(c1Audits.map((a) => a.oldValue)).toEqual(expect.arrayContaining(['step=1', 'step=2']));
      for (const a of c1Audits) {
        expect(a.newValue).not.toContain('r833-');
        expect(a.newValue).not.toContain('R833 Savepoint Matter');
      }
      const c2Audits = await auditRepo.listAuditEntriesForRecord(ctx, 'communication_chase', chase2.id, { limit: 100 });
      const c2FailAudits = c2Audits.filter((a) => a.action === 'communication_chase.step_failed');
      expect(c2FailAudits).toHaveLength(3);
    } finally {
      await direct.query(`
        DROP TRIGGER IF EXISTS trg_test_fail_r833_chase ON public.email_outbox;
        DROP FUNCTION IF EXISTS public.test_fail_r833_chase_fn();
      `);
      await direct.end();
    }
  }, 45_000);

  it('7. R837: escalation falls back via supervising partner to owning team lead, and unassigned keeps chase needs_owner with zero-PII audit', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const matterRepo = new TenantMatterRepository();
    const chasingRepo = new TenantChasingRepository();
    const taskRepo = new TenantTaskWorkflowRepository();
    const auditRepo = new TenantAuditRepository();
    const hrRepo = new TenantHrAndRbacRepository();

    const chaseCfg = loadAndValidateTenantConfig(
      notALawFirmBaseConfig as unknown as Record<string, unknown>,
      {
        tenantId: 'not-a-law-firm',
        integrations: {
          ...((notALawFirmBaseConfig as unknown as { integrations: Record<string, unknown> })
            .integrations ?? {}),
          email: { provider: 'disabled' },
        },
        chasing: {
          engagementLetter: { enabled: true, sendEmails: false, firstChaseDays: 7, secondChaseDays: 14, escalateTaskDays: 21 },
          quote: { enabled: false, sendEmails: false, firstChaseDays: 7, secondChaseDays: 14, escalateTaskDays: 21 },
          moneyOnAccount: { enabled: false, sendEmails: false, firstChaseDays: 7, secondChaseDays: 14, escalateTaskDays: 21 },
        },
      },
      'test',
    );

    const allTeams = await hrRepo.listAllTeams<{
      id: string;
      name: string;
      description: string;
      memberIds: string[];
      leadIds: string[];
      practiceAreaIds: string[];
      active: boolean;
      createdById: string;
      createdAt: string;
      updatedById: string;
      updatedAt: string;
    }>(ctx);
    const empTeam =
      allTeams.find(
        (t) =>
          t.active && t.practiceAreaIds.includes('work_type.employment_and_hr'),
      ) ?? allTeams[0]!;
    await hrRepo.putTeam(ctx, {
      ...empTeam,
      memberIds: Array.from(new Set([...empTeam.memberIds, 'P-000001', 'P-000002', 'P-000006'])),
      leadIds: ['P-000006'],
      practiceAreaIds: Array.from(new Set([...empTeam.practiceAreaIds, 'work_type.employment_and_hr'])),
    });

    let teamLeadFallbackMatterId = '';
    let noOwnerMatterId = '';
    await runAsActionActor(
      'P-000001',
      async () => {
        const resTeam = await saveMatterRecord(
          {
            title: 'R837 Team Lead Fallback Walled',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
            responsiblePartnerId: 'P-000002',
            supervisingPartnerId: 'P-000002',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000002', 'P-000006'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        teamLeadFallbackMatterId = resTeam.matter!.id;

        const resNone = await saveMatterRecord(
          {
            title: 'Confidential Zero Owner Secret Title',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
            responsiblePartnerId: 'P-000002',
            supervisingPartnerId: 'P-000002',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        noOwnerMatterId = resNone.matter!.id;
      },
      { roles: ['partner'], mfaVerified: false },
    );

    // Send both while P-000001 can see them, then apply strict ethical walls
    const sendTeam = await runAsActionActor(
      'P-000001',
      () => sendEngagementLetterRecord({ matterId: teamLeadFallbackMatterId, recipientEmail: 'tl@example.test' }, 'P-000001', { tenantConfig: chaseCfg, drainAfterCommit: false }),
      { roles: ['partner'], mfaVerified: false },
    );
    const sendNone = await runAsActionActor(
      'P-000001',
      () => sendEngagementLetterRecord({ matterId: noOwnerMatterId, recipientEmail: 'none@example.test' }, 'P-000001', { tenantConfig: chaseCfg, drainAfterCommit: false }),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(sendTeam.ok && sendNone.ok).toBe(true);
    if (!sendTeam.ok || !sendNone.ok) return;

    const mTeam = (await matterRepo.getMatterById<Matter>(ctx, teamLeadFallbackMatterId, { includeRestricted: true }))!;
    const mNone = (await matterRepo.getMatterById<Matter>(ctx, noOwnerMatterId, { includeRestricted: true }))!;
    await matterRepo.withTenantTransaction(ctx, async () => {
      await matterRepo.putMatter(
        ctx,
        { ...mTeam, hasEthicalWall: true, restrictedAccessUserIds: ['P-000006'] },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: ['P-000006'] },
      );
      // Only P-000005 is permitted (neither lead, partner, supervisor, nor team lead P-000006)
      await matterRepo.putMatter(
        ctx,
        { ...mNone, hasEthicalWall: true, restrictedAccessUserIds: ['P-000005'] },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: ['P-000005'] },
      );
    });

    const baseSent = new Date(sendNone.chase!.sentAt);
    for (const dayOffset of [7, 14, 21]) {
      await executeCommunicationChasesForTenant(ctx, {
        triggerSource: 'manual',
        triggeredById: 'system:communication-chases',
        tenantConfig: chaseCfg,
        drainAfterCommit: false,
        now: addDays(baseSent, dayOffset),
      });
    }

    // Team lead P-000006 received escalation for teamLeadFallbackMatterId
    const teamTasks = await taskRepo.listTasksLinkedToRecord<Task>(ctx, 'matter', teamLeadFallbackMatterId);
    const teamEsc = teamTasks.find((t) => t.autoTrigger === 'communication_chase_escalation');
    expect(teamEsc?.assignedPersonId).toBe('P-000006');

    // No-owner matter: ZERO tasks created, chase stays 'needs_owner', zero-PII unassigned audit written
    const noneTasks = await taskRepo.listTasksLinkedToRecord<Task>(ctx, 'matter', noOwnerMatterId);
    expect(noneTasks.filter((t) => t.autoTrigger === 'communication_chase_escalation')).toHaveLength(0);
    const noneChaseAfter = await chasingRepo.getChaseById(ctx, sendNone.chase!.id);
    expect(noneChaseAfter?.status).toBe('needs_owner');
    expect(noneChaseAfter?.nextActionAt).toBeNull();

    const noneAudits = await auditRepo.listAuditEntriesForRecord(ctx, 'communication_chase', sendNone.chase!.id, { limit: 100 });
    const unassignedAudits = noneAudits.filter(
      (a) => a.action === 'communication_chase.escalation_unassigned',
    );
    expect(unassignedAudits).toHaveLength(1);
    expect(unassignedAudits[0]?.newValue).toContain('outcome=escalation_unassigned');
    expect(unassignedAudits[0]?.newValue).not.toContain('Confidential Zero Owner Secret Title');
    expect(unassignedAudits[0]?.newValue).not.toContain('none@example.test');
  }, 45_000);
});
