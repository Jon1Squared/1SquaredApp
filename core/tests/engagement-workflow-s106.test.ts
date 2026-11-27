import { afterEach, describe, expect, it, vi } from 'vitest';
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
  selectDocumentPdfConverter,
  type DocumentPdfConverter,
  type DocumentStorageProvider,
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
  sendNonEngagementLetterRecord,
  startOrLoadClientCddRecord,
  stopCommunicationChaseRecord,
  updateMatterLifecycleStatusRecord,
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
      () => stopCommunicationChaseAction({ chaseId: chaseB1 }),
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
            closeReasonId: vid('enquiry_close_reason', 'Conflict'),
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
            { chaseId: alphaSend.chase!.id },
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

  it('8. R834: sendNonEngagementLetter refuses open & Converted enquiries and ignores forged closeReasonSystemKey', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000002');
    const intakeRepo = new (await import('../src/tenancy/intakeQuoteRepository')).TenantIntakeQuoteRepository();

    // 1. Open enquiry must be rejected with VALIDATION_ERROR
    const openRes = await runAsActionActor(
      'P-000002',
      () =>
        saveEnquiryRecord(
          {
            firstName: 'Open',
            lastName: 'Enquirer',
            email: 'open.enq@1squared.co.uk',
            phone: '029 2000 0111',
            channelId: 'enquiry_channel.phone',
            practiceAreaId: 'work_type.employment_and_hr',
            summary: 'Open enquiry test',
            notes: 'Required intake notes for open enquiry test.',
            privacyNoticeGiven: true,
          },
          { byId: 'P-000002' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(openRes.errors).toBeUndefined();
    const openEnqId = openRes.enquiry!.id;

    const sendOpen = await runAsActionActor(
      'P-000002',
      () => sendNonEngagementLetterAction({ enquiryId: openEnqId }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(sendOpen).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    // 2. Converted enquiry must also be rejected with VALIDATION_ERROR
    const convSave = await runAsActionActor(
      'P-000002',
      () =>
        saveEnquiryRecord(
          {
            firstName: 'Converted',
            lastName: 'Client',
            email: 'converted@1squared.co.uk',
            phone: '029 2000 0222',
            channelId: 'enquiry_channel.phone',
            practiceAreaId: 'work_type.employment_and_hr',
            summary: 'Converted enquiry test',
            notes: 'Required intake notes for converted enquiry test.',
            privacyNoticeGiven: true,
          },
          { byId: 'P-000002' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const convEnq = convSave.enquiry!;
    await intakeRepo.putEnquiry(ctx, { ...convEnq, status: 'Converted' });
    const sendConv = await runAsActionActor(
      'P-000002',
      () => sendNonEngagementLetterAction({ enquiryId: convEnq.id }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(sendConv).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    // 3. Closed as 'outside_expertise' -> forged closeReasonSystemKey: 'conflict' in input is dropped/ignored
    await runAsActionActor(
      'P-000002',
      () =>
        closeEnquiryRecord(
          openEnqId,
          {
            targetStatus: 'Declined',
            closeReasonId: vid('enquiry_close_reason', 'Outside our expertise'),
            closeNotes: 'Requires maritime specialist.',
          },
          'P-000002',
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const sendForged = await runAsActionActor(
      'P-000002',
      () =>
        sendNonEngagementLetterAction({
          enquiryId: openEnqId,
          closeReasonSystemKey: 'conflict',
        } as unknown as { enquiryId: string }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(sendForged.ok).toBe(true);
    if (!sendForged.ok) return;
    // Subject comes from stored 'outside_expertise' template, NOT forged 'conflict'
    expect(sendForged.outboxRecord.subject).not.toContain('unable to act');
    expect(sendForged.outboxRecord.subject).toContain('Not A Law Firm LLP');
  }, 45_000);

  it('9. R835: engagement & non-engagement sends are end-to-end idempotent across retries and concurrent races', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const engRepo = new TenantEngagementRepository();
    const outboxRepo = new TenantOutboxRepository();
    const checkRepo = new TenantIntakeCheckRepository();
    const auditRepo = new TenantAuditRepository();
    const chasingRepo = new TenantChasingRepository();

    const activeCfg = getActiveTenantConfiguration();
    const chaseEnabledCfg = loadAndValidateTenantConfig(
      {
        ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
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
            enabled: false,
            sendEmails: false,
            firstChaseDays: 7,
            secondChaseDays: 14,
            escalateTaskDays: 21,
          },
          moneyOnAccount: {
            enabled: false,
            sendEmails: false,
            firstChaseDays: 7,
            secondChaseDays: 14,
            escalateTaskDays: 21,
          },
        },
      },
      { tenantId: 'not-a-law-firm', environment: 'test' },
      'test',
    );

    // 1. Sequential retry idempotency on Client Care send
    let matterSeqId = '';
    let matterRaceId = '';
    await runAsActionActor(
      'P-000001',
      async () => {
        for (const label of ['Seq', 'Race']) {
          const m = await saveMatterRecord(
            {
              title: `R835 Idempotent Matter ${label}`,
              clientId: 'O-000001',
              practiceAreaId: 'work_type.employment_and_hr',
              workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
              responsiblePartnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              leadFeeEarnerId: 'P-000002',
              teamMemberIds: ['P-000001', 'P-000002'],
              conflictCheckRecord: makeConflictRecord('P-000001', `R835 ${label}`),
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
            },
            { byId: 'P-000001', saveMode: 'submit_cleared' },
          );
          expect(m.errors).toBeUndefined();
          if (label === 'Seq') matterSeqId = m.matter!.id;
          else matterRaceId = m.matter!.id;
        }
      },
      { roles: ['partner'], mfaVerified: false },
    );

    const realPdf = selectDocumentPdfConverter(activeCfg, {
      converterUrl: process.env.DOC_CONVERTER_URL,
    });
    const realStorage = getDocumentStorage(activeCfg);

    let seqConvertCalls = 0;
    let seqPutObjectCalls = 0;
    const spyPdf: DocumentPdfConverter = {
      converterId: realPdf.converterId,
      convertDocxToPdf: async (req) => {
        seqConvertCalls += 1;
        return realPdf.convertDocxToPdf(req);
      },
    };
    const spyStorage: DocumentStorageProvider = {
      providerId: realStorage.providerId,
      putObject: async (c, req) => {
        seqPutObjectCalls += 1;
        return realStorage.putObject(c, req);
      },
      getObjectBytes: (c, ref) => realStorage.getObjectBytes(c, ref),
      issueScopedDownloadToken: (c, ref, ttl) =>
        realStorage.issueScopedDownloadToken(c, ref, ttl),
      verifyScopedDownloadToken: (c, tok) =>
        realStorage.verifyScopedDownloadToken(c, tok),
      deleteObject: (c, ref) => realStorage.deleteObject(c, ref),
      getMalwareScanStatus: (c, key) => realStorage.getMalwareScanStatus(c, key),
    };

    const sharedKeySeq = 'r835-seq-ccl-key-1';
    const sendSeq1 = await runAsActionActor(
      'P-000001',
      () =>
        sendEngagementLetterRecord(
          {
            matterId: matterSeqId,
            recipientEmail: 'r835-seq@example.test',
            idempotencyKey: sharedKeySeq,
          },
          'P-000001',
          {
            tenantConfig: chaseEnabledCfg,
            pdfConverter: spyPdf,
            storageProvider: spyStorage,
            drainAfterCommit: false,
          },
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(sendSeq1.ok).toBe(true);
    if (!sendSeq1.ok) return;

    const sendSeq2 = await runAsActionActor(
      'P-000001',
      () =>
        sendEngagementLetterRecord(
          {
            matterId: matterSeqId,
            recipientEmail: 'r835-seq@example.test',
            idempotencyKey: sharedKeySeq,
          },
          'P-000001',
          {
            tenantConfig: chaseEnabledCfg,
            pdfConverter: spyPdf,
            storageProvider: spyStorage,
            drainAfterCommit: false,
          },
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(sendSeq2.ok).toBe(true);
    if (!sendSeq2.ok) return;

    expect(sendSeq2.documentId).toBe(sendSeq1.documentId);
    expect(sendSeq2.dispatch.id).toBe(sendSeq1.dispatch.id);
    expect(sendSeq2.outboxRecord.id).toBe(sendSeq1.outboxRecord.id);
    expect(sendSeq2.chase?.id).toBe(sendSeq1.chase?.id);
    // Second call returns early pre-TX with ZERO extra PDF/blob work
    expect(seqConvertCalls).toBe(1);
    expect(seqPutObjectCalls).toBe(1);

    const direct = await createDirectMigrationClient({ ctx });
    try {
      const docCountRes = await direct.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM public.documents WHERE tenant_id = $1 AND primary_matter_id = $2`,
        [ctx.tenantId, matterSeqId],
      );
      expect(Number(docCountRes.rows[0]?.cnt)).toBe(1);

      const linkCountRes = await direct.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM public.document_links WHERE tenant_id = $1 AND entity_type = 'matter' AND entity_id = $2`,
        [ctx.tenantId, matterSeqId],
      );
      expect(Number(linkCountRes.rows[0]?.cnt)).toBe(1);

      const outboxCountRes = await direct.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM public.email_outbox WHERE tenant_id = $1 AND matter_id = $2`,
        [ctx.tenantId, matterSeqId],
      );
      expect(Number(outboxCountRes.rows[0]?.cnt)).toBe(1);

      const dispSeq = await engRepo.listDispatchesForMatter(ctx, matterSeqId);
      expect(dispSeq).toHaveLength(1);

      const checksSeq = await checkRepo.listChecksForSubject(ctx, {
        subjectType: 'matter',
        subjectId: matterSeqId,
      });
      expect(
        checksSeq.filter(
          (c) => c.checkKind === 'e_signature' && c.outcome === 'requested_manual',
        ),
      ).toHaveLength(1);

      const chasesSeq = await chasingRepo.listChasesForMatter(ctx, matterSeqId);
      expect(chasesSeq).toHaveLength(1);

      const matterAuditsSeq = await auditRepo.listAuditEntriesForRecord(
        ctx,
        'matter',
        matterSeqId,
        { limit: 100 },
      );
      expect(
        matterAuditsSeq.filter((a) => a.field === 'Engagement letter sent'),
      ).toHaveLength(1);

      // 2. Concurrent race idempotency on Client Care send (in-TX FOR UPDATE + early return)
      const sharedKeyRace = 'r835-race-ccl-key-1';
      const [race1, race2] = await Promise.all([
        runAsActionActor(
          'P-000001',
          () =>
            sendEngagementLetterRecord(
              {
                matterId: matterRaceId,
                recipientEmail: 'r835-race@example.test',
                idempotencyKey: sharedKeyRace,
              },
              'P-000001',
              { tenantConfig: chaseEnabledCfg, drainAfterCommit: false },
            ),
          { roles: ['partner'], mfaVerified: false },
        ),
        runAsActionActor(
          'P-000001',
          () =>
            sendEngagementLetterRecord(
              {
                matterId: matterRaceId,
                recipientEmail: 'r835-race@example.test',
                idempotencyKey: sharedKeyRace,
              },
              'P-000001',
              { tenantConfig: chaseEnabledCfg, drainAfterCommit: false },
            ),
          { roles: ['partner'], mfaVerified: false },
        ),
      ]);
      expect(race1.ok).toBe(true);
      expect(race2.ok).toBe(true);
      if (race1.ok && race2.ok) {
        expect(race2.documentId).toBe(race1.documentId);
        expect(race2.dispatch.id).toBe(race1.dispatch.id);
        expect(race2.outboxRecord.id).toBe(race1.outboxRecord.id);
      }
      expect(await engRepo.listDispatchesForMatter(ctx, matterRaceId)).toHaveLength(1);
      const raceChecks = await checkRepo.listChecksForSubject(ctx, {
        subjectType: 'matter',
        subjectId: matterRaceId,
      });
      expect(
        raceChecks.filter(
          (c) => c.checkKind === 'e_signature' && c.outcome === 'requested_manual',
        ),
      ).toHaveLength(1);

      // 3. Non-engagement letter idempotency (incl. single doc, single task closure, single audit)
      const enqSave = await runAsActionActor(
        'P-000002',
        () =>
          saveEnquiryRecord(
            {
              firstName: 'R835',
              lastName: 'NonEng',
              email: 'r835-noneng@example.test',
              phone: '029 2000 0835',
              channelId: 'enquiry_channel.phone',
              practiceAreaId: 'work_type.employment_and_hr',
              summary: 'Idempotency test enquiry',
              notes: 'Notes for R835 idempotent non-engagement.',
              privacyNoticeGiven: true,
            },
            { byId: 'P-000002' },
          ),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(enqSave.errors).toBeUndefined();
      const enqId = enqSave.enquiry!.id;

      const closeRes = await runAsActionActor(
        'P-000002',
        () =>
          closeEnquiryRecord(
            enqId,
            {
              targetStatus: 'Declined',
              closeReasonId: vid('enquiry_close_reason', 'Outside our expertise'),
              closeNotes: 'Not within current expertise.',
            },
            'P-000002',
          ),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(closeRes.error).toBeUndefined();
      const nonEngTaskId = closeRes.nonEngagementTask!.id;

      let nonEngConvertCalls = 0;
      let nonEngPutObjectCalls = 0;
      const nonEngSpyPdf: DocumentPdfConverter = {
        converterId: realPdf.converterId,
        convertDocxToPdf: async (req) => {
          nonEngConvertCalls += 1;
          return realPdf.convertDocxToPdf(req);
        },
      };
      const nonEngSpyStorage: DocumentStorageProvider = {
        ...spyStorage,
        putObject: async (c, req) => {
          nonEngPutObjectCalls += 1;
          return realStorage.putObject(c, req);
        },
      };

      const sharedNonEngKey = 'r835-noneng-key-1';
      const ne1 = await runAsActionActor(
        'P-000002',
        () =>
          sendNonEngagementLetterRecord(
            { enquiryId: enqId, idempotencyKey: sharedNonEngKey },
            'P-000002',
            {
              pdfConverter: nonEngSpyPdf,
              storageProvider: nonEngSpyStorage,
              drainAfterCommit: false,
            },
          ),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(ne1.ok).toBe(true);
      if (!ne1.ok) return;
      expect(ne1.closedTaskIds).toEqual([nonEngTaskId]);

      const ne2 = await runAsActionActor(
        'P-000002',
        () =>
          sendNonEngagementLetterRecord(
            { enquiryId: enqId, idempotencyKey: sharedNonEngKey },
            'P-000002',
            {
              pdfConverter: nonEngSpyPdf,
              storageProvider: nonEngSpyStorage,
              drainAfterCommit: false,
            },
          ),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(ne2.ok).toBe(true);
      if (!ne2.ok) return;

      expect(ne2.documentId).toBe(ne1.documentId);
      expect(ne2.dispatch.id).toBe(ne1.dispatch.id);
      expect(ne2.outboxRecord.id).toBe(ne1.outboxRecord.id);
      expect(ne2.closedTaskIds).toEqual([]);
      expect(nonEngConvertCalls).toBe(1);
      expect(nonEngPutObjectCalls).toBe(1);

      const neDocCount = await direct.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM public.documents WHERE tenant_id = $1 AND primary_enquiry_id = $2`,
        [ctx.tenantId, enqId],
      );
      expect(Number(neDocCount.rows[0]?.cnt)).toBe(1);
      const neLinkCount = await direct.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM public.document_links WHERE tenant_id = $1 AND entity_type = 'enquiry' AND entity_id = $2`,
        [ctx.tenantId, enqId],
      );
      expect(Number(neLinkCount.rows[0]?.cnt)).toBe(1);
      expect(await engRepo.listDispatchesForEnquiry(ctx, enqId)).toHaveLength(1);

      const neOutboxCount = await direct.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM public.email_outbox WHERE tenant_id = $1 AND enquiry_id = $2`,
        [ctx.tenantId, enqId],
      );
      expect(Number(neOutboxCount.rows[0]?.cnt)).toBe(1);
      const loadedOutbox = await outboxRepo.getOutboxRecordById(
        ctx,
        ne1.outboxRecord.id,
      );
      expect(loadedOutbox?.id).toBe(ne1.outboxRecord.id);

      const enqAudits = await auditRepo.listAuditEntriesForRecord(
        ctx,
        'enquiry',
        enqId,
        { limit: 100 },
      );
      expect(
        enqAudits.filter((a) => a.field === 'Non-engagement letter sent'),
      ).toHaveLength(1);

      const taskAudits = await auditRepo.listAuditEntriesForRecord(
        ctx,
        'task',
        nonEngTaskId,
        { limit: 100 },
      );
      expect(
        taskAudits.filter(
          (a) => a.field === 'Task completed on non-engagement letter dispatch',
        ),
      ).toHaveLength(1);
    } finally {
      await direct.end();
    }
  }, 60_000);

  it('10. R836: stopCommunicationChase ignores forged reasons, is idempotent on repeat stop, and returns uniform NOT_FOUND for quote-only callers', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const partyRepo = new TenantPartyRepository();
    const auditRepo = new TenantAuditRepository();
    const chasingRepo = new TenantChasingRepository();

    const chaseEnabledCfg = loadAndValidateTenantConfig(
      {
        ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
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
            enabled: false,
            sendEmails: false,
            firstChaseDays: 7,
            secondChaseDays: 14,
            escalateTaskDays: 21,
          },
          moneyOnAccount: {
            enabled: false,
            sendEmails: false,
            firstChaseDays: 7,
            secondChaseDays: 14,
            escalateTaskDays: 21,
          },
        },
      },
      { tenantId: 'not-a-law-firm', environment: 'test' },
      'test',
    );

    let matterId = '';
    await runAsActionActor(
      'P-000001',
      async () => {
        const m = await saveMatterRecord(
          {
            title: 'R836 Chase Stop Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'R836 Client'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(m.errors).toBeUndefined();
        matterId = m.matter!.id;
      },
      { roles: ['partner'], mfaVerified: false },
    );

    const sent = await runAsActionActor(
      'P-000001',
      () =>
        sendEngagementLetterRecord(
          { matterId, recipientEmail: 'r836@example.test' },
          'P-000001',
          { tenantConfig: chaseEnabledCfg, drainAfterCommit: false },
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.chase) return;
    const realChaseId = sent.chase.id;

    // 1. User holding quote:edit ONLY (enquiries_coordinator without matter:edit) gets the exact same
    // opaque NOT_FOUND for a real engagement_letter chase ID as for a made-up chase ID
    const people = await partyRepo.listAllPeople<Person>(ctx, {
      employeesAndLeaversOnly: true,
    });
    const quoteOnlyUser = people.find(
      (p: Person) =>
        p.isEmployee &&
        p.roles?.includes('enquiries_coordinator') &&
        !p.roles?.includes('fee_earner') &&
        !p.roles?.includes('partner') &&
        !p.roles?.includes('legal_secretary'),
    );
    expect(quoteOnlyUser).toBeDefined();
    if (!quoteOnlyUser) return;

    const realIdRefusal = await runAsActionActor(
      quoteOnlyUser.id,
      () => stopCommunicationChaseAction({ chaseId: realChaseId }),
      { roles: ['enquiries_coordinator'], mfaVerified: false },
    );
    const fakeIdRefusal = await runAsActionActor(
      quoteOnlyUser.id,
      () => stopCommunicationChaseAction({ chaseId: 'CHS-DOES-NOT-EXIST' }),
      { roles: ['enquiries_coordinator'], mfaVerified: false },
    );
    expect(realIdRefusal).toEqual(fakeIdRefusal);
    expect(realIdRefusal).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Communication chase was not found.',
    });

    // Chase remains active after quote-only probe
    const stillActive = await chasingRepo.getChaseById(ctx, realChaseId);
    expect(stillActive?.status).toBe('active');

    // 2. Forged runtime reason='signed' is dropped; stoppedReason is forced to 'manual_stop'
    const firstStop = await runAsActionActor(
      'P-000001',
      () =>
        stopCommunicationChaseAction({
          chaseId: realChaseId,
          reason: 'signed',
        } as unknown as { chaseId: string }),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(firstStop.ok).toBe(true);
    if (!firstStop.ok) return;
    expect(firstStop.chase.status).toBe('stopped');
    expect(firstStop.chase.stoppedReason).toBe('manual_stop');
    expect(firstStop.chase.nextActionAt).toBeNull();

    // 3. Second stop returns success with ZERO extra audit entries
    const secondStop = await runAsActionActor(
      'P-000001',
      () => stopCommunicationChaseAction({ chaseId: realChaseId }),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(secondStop.ok).toBe(true);
    if (!secondStop.ok) return;
    expect(secondStop.chase.status).toBe('stopped');
    expect(secondStop.chase.stoppedReason).toBe('manual_stop');

    const chaseAudits = await auditRepo.listAuditEntriesForRecord(
      ctx,
      'communication_chase',
      realChaseId,
      { limit: 100 },
    );
    expect(
      chaseAudits.filter((a) => a.field === 'Communication chase stopped'),
    ).toHaveLength(1);
  }, 45_000);

  it('11. R838: closing, archiving, or deleting a matter stops active chases in the same transaction, and missing-matter backstop records entity_missing', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const matterRepo = new TenantMatterRepository();
    const chasingRepo = new TenantChasingRepository();
    const auditRepo = new TenantAuditRepository();

    const chaseEnabledCfg = loadAndValidateTenantConfig(
      {
        ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
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
            enabled: false,
            sendEmails: false,
            firstChaseDays: 7,
            secondChaseDays: 14,
            escalateTaskDays: 21,
          },
          moneyOnAccount: {
            enabled: false,
            sendEmails: false,
            firstChaseDays: 7,
            secondChaseDays: 14,
            escalateTaskDays: 21,
          },
        },
      },
      { tenantId: 'not-a-law-firm', environment: 'test' },
      'test',
    );

    // Ensure O-000001 has complete CDD so employment_and_hr matters open immediately
    await runAsActionActor(
      'P-000001',
      async () => {
        const cddLoad = await startOrLoadClientCddRecord(
          { subjectType: 'organisation', subjectId: 'O-000001', createIfMissing: true },
          'P-000001',
        );
        expect(cddLoad.ok).toBe(true);
        if (!cddLoad.ok) return;
        const cddUp = await uploadEvidenceArtifactRecord(
          {
            subjectType: 'organisation',
            subjectId: 'O-000001',
            purpose: 'cdd',
            fileName: 'cdd-r838.pdf',
            contentType: 'application/pdf',
            bytes: Buffer.from('%PDF-1.4\n% CDD R838\n%%EOF\n'),
          },
          'P-000001',
        );
        expect(cddUp.ok).toBe(true);
        if (!cddUp.ok) return;
        await recordManualSanctionsPepRecord(
          {
            subjectType: 'organisation',
            subjectId: 'O-000001',
            outcome: 'clear',
            screeningScope: 'UK Sanctions list',
            referenceCode: 'SP-R838',
          },
          'P-000001',
        );
        for (const item of cddLoad.summary.checklistItems) {
          await recordCddChecklistItemRecord(
            {
              recordId: cddLoad.summary.recordId!,
              itemKey: item.itemKey,
              status: 'recorded',
              evidenceRefs: [cddUp.evidenceRef],
            },
            'P-000001',
          );
        }
        const comp = await completeClientCddRecord(
          { recordId: cddLoad.summary.recordId! },
          'P-000001',
        );
        expect(comp.ok).toBe(true);
      },
      { roles: ['partner'], mfaVerified: false },
    );

    const matterIds: string[] = [];
    const chaseIds: string[] = [];
    await runAsActionActor(
      'P-000001',
      async () => {
        for (const label of ['Close', 'Archive', 'Delete']) {
          const m = await saveMatterRecord(
            {
              title: `R838 ${label} Matter`,
              clientId: 'O-000001',
              practiceAreaId: 'work_type.employment_and_hr',
              workTypeSubcategoryId: 'work_type.employment_and_hr_employment_contracts',
              responsiblePartnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              leadFeeEarnerId: 'P-000002',
              teamMemberIds: ['P-000001', 'P-000002'],
              conflictCheckRecord: makeConflictRecord('P-000001', `R838 ${label}`),
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
            },
            { byId: 'P-000001', saveMode: 'submit_cleared' },
          );
          expect(m.errors).toBeUndefined();
          expect(m.matter?.matterStatusId).toBe('matter_status.active');
          matterIds.push(m.matter!.id);
        }
      },
      { roles: ['partner'], mfaVerified: false },
    );

    for (let i = 0; i < matterIds.length; i++) {
      const sent = await runAsActionActor(
        'P-000001',
        () =>
          sendEngagementLetterRecord(
            { matterId: matterIds[i]!, recipientEmail: `r838-${i}@example.test` },
            'P-000001',
            { tenantConfig: chaseEnabledCfg, drainAfterCommit: false },
          ),
        { roles: ['partner'], mfaVerified: false },
      );
      expect(sent.ok).toBe(true);
      if (!sent.ok || !sent.chase) return;
      chaseIds.push(sent.chase.id);
    }

    const [mCloseId, mArchiveId, mDeleteId] = matterIds as [string, string, string];
    const [cCloseId, cArchiveId, cDeleteId] = chaseIds as [string, string, string];

    // 1. Closing via updateMatterLifecycleStatusRecord stops the chase in the SAME TX (zero job run needed)
    const mCloseFresh = await matterRepo.getMatterById<Matter>(ctx, mCloseId, {
      includeRestricted: true,
    });
    const closedRes = await runAsActionActor(
      'P-000001',
      () =>
        updateMatterLifecycleStatusRecord(
          mCloseId,
          'close',
          {
            reason: 'Matter concluded prior to signing',
            expectedRowVersion: mCloseFresh?.rowVersion ?? null,
          },
          'P-000001',
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(closedRes.errors).toBeUndefined();
    expect(closedRes.matter).toBeTruthy();

    const chaseAfterClose = await chasingRepo.getChaseById(ctx, cCloseId);
    expect(chaseAfterClose?.status).toBe('stopped');
    expect(chaseAfterClose?.stoppedReason).toBe('matter_closed');
    expect(chaseAfterClose?.nextActionAt).toBeNull();

    const closeAudits = await auditRepo.listAuditEntriesForRecord(
      ctx,
      'communication_chase',
      cCloseId,
      { limit: 50 },
    );
    expect(
      closeAudits.some(
        (a) =>
          a.field === 'Communication chase stopped' &&
          a.newValue === 'stopped (matter_closed)',
      ),
    ).toBe(true);

    // 2. Archiving via saveMatterRecord stops the chase in the SAME TX with stoppedReason: 'matter_closed'
    const mArchiveFresh = await matterRepo.getMatterById<Matter>(ctx, mArchiveId, {
      includeRestricted: true,
    });
    const archiveSave = await runAsActionActor(
      'P-000001',
      () =>
        saveMatterRecord(
          {
            ...mArchiveFresh!,
            closedAt: undefined,
            matterStatusId: vid('matter_status', 'Archived'),
          },
          {
            id: mArchiveId,
            byId: 'P-000001',
            expectedRowVersion: mArchiveFresh?.rowVersion ?? undefined,
          },
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(archiveSave.errors).toBeUndefined();

    const chaseAfterArchive = await chasingRepo.getChaseById(ctx, cArchiveId);
    expect(chaseAfterArchive?.status).toBe('stopped');
    expect(chaseAfterArchive?.stoppedReason).toBe('matter_closed');
    expect(chaseAfterArchive?.nextActionAt).toBeNull();

    const archiveAudits = await auditRepo.listAuditEntriesForRecord(
      ctx,
      'communication_chase',
      cArchiveId,
      { limit: 50 },
    );
    expect(
      archiveAudits.some(
        (a) =>
          a.field === 'Communication chase stopped' &&
          a.newValue === 'stopped (matter_closed)',
      ),
    ).toBe(true);

    // 3. Deleting a matter via deleteMatterById stops active chases in the SAME TX with entity_missing
    const deleted = await matterRepo.deleteMatterById(ctx, mDeleteId);
    expect(deleted).toBe(true);
    const chaseAfterDelete = await chasingRepo.getChaseById(ctx, cDeleteId);
    expect(chaseAfterDelete?.status).toBe('stopped');
    expect(chaseAfterDelete?.stoppedReason).toBe('entity_missing');
    expect(chaseAfterDelete?.nextActionAt).toBeNull();

    // 4. Job backstop: a due active chase pointing to a non-existent matter records entity_missing (never 'withdrawn')
    const sweepNow = new Date();
    const orphanSentAt = addDays(sweepNow, -10).toISOString();
    const orphanDueAt = addDays(sweepNow, -2).toISOString();
    const { chase: orphanChase } = await chasingRepo.withTenantTransaction(ctx, (tx) =>
      chasingRepo.startOrReplaceChaseInTx(tx, ctx, {
        entityKind: 'engagement_letter',
        entityId: 'M-NON-EXISTENT-R838',
        matterId: 'M-NON-EXISTENT-R838',
        recipientEmail: 'orphan@example.test',
        recipientName: 'Orphan Prospect',
        sentAt: orphanSentAt,
        nextActionAt: orphanDueAt,
        createdByPersonId: 'P-000001',
      }),
    );

    const sweepRes = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseEnabledCfg,
      drainAfterCommit: false,
      now: sweepNow,
    });
    expect(sweepRes.outcome).toBe('executed');

    const orphanAfterJob = await chasingRepo.getChaseById(ctx, orphanChase.id);
    expect(orphanAfterJob?.status).toBe('stopped');
    expect(orphanAfterJob?.stoppedReason).toBe('entity_missing');
    expect(orphanAfterJob?.nextActionAt).toBeNull();
  }, 60_000);

  it('12. R843 & R844: moa_receipt is refused until S1-08 and invalid/expired/cross-tenant/cross-user download tokens return opaque 404 matching missing artifacts', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const evidenceRepo = new TenantEvidenceArtifactRepository();

    let matterId = '';
    await runAsActionActor(
      'P-000001',
      async () => {
        const m = await saveMatterRecord(
          {
            title: 'R843 R844 Evidence Security Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_employment_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'R843 R844'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(m.errors).toBeUndefined();
        matterId = m.matter!.id;
      },
      { roles: ['partner'], mfaVerified: false },
    );

    const buildUploadReq = async (purpose: string) => {
      const form = new FormData();
      form.set('subjectType', 'matter');
      form.set('subjectId', matterId);
      form.set('purpose', purpose);
      form.set(
        'file',
        new File(
          [new TextEncoder().encode('%PDF-1.4\n% Sample\n%%EOF\n')],
          `${purpose}.pdf`,
          { type: 'application/pdf' },
        ),
      );
      const tmp = new Response(form);
      const rawBytes = await tmp.arrayBuffer();
      return new Request('http://localhost/api/evidence/upload', {
        method: 'POST',
        headers: {
          'content-type': tmp.headers.get('content-type')!,
          'content-length': String(rawBytes.byteLength),
        },
        body: rawBytes,
      });
    };

    // R843: moa_receipt upload returns exact same refusal as any other disallowed purpose
    const moaUploadReq = await buildUploadReq('moa_receipt');
    const unknownUploadReq = await buildUploadReq('general');
    const moaUploadRes = await runAsActionActor(
      'P-000001',
      () => evidenceUploadRoute.POST(moaUploadReq),
      { roles: ['partner'], mfaVerified: false },
    );
    const unknownUploadRes = await runAsActionActor(
      'P-000001',
      () => evidenceUploadRoute.POST(unknownUploadReq),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(moaUploadRes.status).toBe(400);
    expect(unknownUploadRes.status).toBe(400);
    const moaUploadJson = (await moaUploadRes.json()) as { ok: boolean; code: string };
    const unknownUploadJson = (await unknownUploadRes.json()) as {
      ok: boolean;
      code: string;
    };
    expect(moaUploadJson.code).toBe('VALIDATION_ERROR');
    expect(unknownUploadJson.code).toBe('VALIDATION_ERROR');
    expect(
      await evidenceRepo.listArtifactsForSubject(ctx, {
        subjectType: 'matter',
        subjectId: matterId,
      }),
    ).toHaveLength(0);

    // Upload a real clean engagement_signed artifact and seed a stored moa_receipt artifact
    const signedBytes = Buffer.from('%PDF-1.4\n% Valid signed copy\n%%EOF\n');
    const validUpload = await runAsActionActor(
      'P-000001',
      () =>
        uploadEvidenceArtifactRecord(
          {
            subjectType: 'matter',
            subjectId: matterId,
            purpose: 'engagement_signed',
            fileName: 'signed-copy.pdf',
            contentType: 'application/pdf',
            bytes: signedBytes,
          },
          'P-000001',
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(validUpload.ok).toBe(true);
    if (!validUpload.ok) return;

    const activeCfg = getActiveTenantConfiguration();
    const storage = getDocumentStorage(activeCfg);

    const moaBlob = await storage.putObject(ctx, {
      category: 'evidence',
      objectId: `moa-r843-${matterId}`,
      fileName: 'moa-receipt.pdf',
      contentType: 'application/pdf',
      bytes: signedBytes,
    });
    const moaArtifact = await evidenceRepo.createArtifact(ctx, {
      blobKey: moaBlob.blobKey,
      subjectType: 'matter',
      subjectId: matterId,
      purpose: 'moa_receipt',
      fileName: 'moa-receipt.pdf',
      contentType: 'application/pdf',
      byteSize: signedBytes.byteLength,
      sha256: validUpload.artifact.sha256,
      scanStatus: 'clean',
      uploadedByPersonId: 'P-000001',
      uploadedAt: new Date().toISOString(),
    });
    const moaToken = await storage.issueScopedDownloadToken(ctx, {
      blobKey: moaArtifact.blobKey,
      fileName: moaArtifact.fileName,
      documentId: moaArtifact.id,
    });

    // (a) Baseline missing-artifact download (valid signature, non-existent documentId)
    const missingToken = await storage.issueScopedDownloadToken(ctx, {
      blobKey: validUpload.artifact.blobKey,
      fileName: 'missing.pdf',
      documentId: 'EVD-MISSING-R844',
    });
    const missingRes = await runAsActionActor(
      'P-000001',
      () =>
        evidenceDownloadRoute.GET(
          new Request(
            `http://localhost/api/evidence/download?token=${encodeURIComponent(missingToken.token)}`,
            { method: 'GET' },
          ),
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(missingRes.status).toBe(404);
    const missingBody = await missingRes.json();
    expect(missingBody).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      error: 'Evidence file not found or access denied.',
    });

    // R843: stored moa_receipt artifact returns identical 404 as missing artifact
    const moaDownloadRes = await runAsActionActor(
      'P-000001',
      () =>
        evidenceDownloadRoute.GET(
          new Request(
            `http://localhost/api/evidence/download?token=${encodeURIComponent(moaToken.token)}`,
            { method: 'GET' },
          ),
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(moaDownloadRes.status).toBe(404);
    expect(await moaDownloadRes.json()).toEqual(missingBody);

    // R844: invalid, expired, cross-tenant, and cross-user tokens return identical 404
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // (b) Tampered / invalid token
      const invalidRes = await runAsActionActor(
        'P-000001',
        () =>
          evidenceDownloadRoute.GET(
            new Request(
              `http://localhost/api/evidence/download?token=${encodeURIComponent(`${validUpload.downloadUrl.split('token=')[1]!}tamper`)}`,
              { method: 'GET' },
            ),
          ),
        { roles: ['partner'], mfaVerified: false },
      );
      expect(invalidRes.status).toBe(404);
      expect(await invalidRes.json()).toEqual(missingBody);

      // (c) Expired token
      const realNow = Date.now();
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow - 30_000);
      let expiredTokenStr = '';
      try {
        const expTok = await storage.issueScopedDownloadToken(
          ctx,
          {
            blobKey: validUpload.artifact.blobKey,
            fileName: validUpload.artifact.fileName,
            documentId: validUpload.artifact.id,
          },
          10,
        );
        expiredTokenStr = expTok.token;
      } finally {
        dateSpy.mockRestore();
      }
      const expiredRes = await runAsActionActor(
        'P-000001',
        () =>
          evidenceDownloadRoute.GET(
            new Request(
              `http://localhost/api/evidence/download?token=${encodeURIComponent(expiredTokenStr)}`,
              { method: 'GET' },
            ),
          ),
        { roles: ['partner'], mfaVerified: false },
      );
      expect(expiredRes.status).toBe(404);
      expect(await expiredRes.json()).toEqual(missingBody);

      // (d) Other-tenant token
      const otherCtx = resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000001',
          name: 'Bravo Partner',
          email: 'partner@tenant-bravo.example',
          tenantId: 'tenant-bravo',
          roles: ['partner'],
          mfaVerified: false,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'r844-other-tenant',
      });
      const otherBlob = await storage.putObject(otherCtx, {
        category: 'evidence',
        objectId: 'other-tenant-r844',
        fileName: 'other-secret.pdf',
        contentType: 'application/pdf',
        bytes: signedBytes,
      });
      const otherTenantToken = await storage.issueScopedDownloadToken(otherCtx, {
        blobKey: otherBlob.blobKey,
        fileName: 'other-secret.pdf',
      });
      await storage.deleteObject(otherCtx, { blobKey: otherBlob.blobKey });
      const otherTenantRes = await runAsActionActor(
        'P-000001',
        () =>
          evidenceDownloadRoute.GET(
            new Request(
              `http://localhost/api/evidence/download?token=${encodeURIComponent(otherTenantToken.token)}`,
              { method: 'GET' },
            ),
          ),
        { roles: ['partner'], mfaVerified: false },
      );
      expect(otherTenantRes.status).toBe(404);
      expect(await otherTenantRes.json()).toEqual(missingBody);

      // (e) Other-user token (issued to P-000001, presented by P-000002)
      const otherUserRes = await runAsActionActor(
        'P-000002',
        () =>
          evidenceDownloadRoute.GET(
            new Request(`http://localhost${validUpload.downloadUrl}`, {
              method: 'GET',
            }),
          ),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(otherUserRes.status).toBe(404);
      expect(await otherUserRes.json()).toEqual(missingBody);

      // Verify IDs-only structured warning logs
      const warnPayloads = warnSpy.mock.calls
        .map((c) => String(c[0] ?? ''))
        .filter((s) => s.includes('evidence.download_denied'));
      expect(warnPayloads).toHaveLength(4);
      for (const raw of warnPayloads) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        expect(parsed['tenantId']).toBe('not-a-law-firm');
        expect(typeof parsed['correlationId']).toBe('string');
        expect(typeof parsed['actorId']).toBe('string');
        expect(typeof parsed['reason']).toBe('string');
        expect(raw).not.toContain('signed-copy.pdf');
        expect(raw).not.toContain('other-secret.pdf');
        expect(raw).not.toContain(expiredTokenStr);
        expect(raw).not.toContain(otherTenantToken.token);
      }
    } finally {
      warnSpy.mockRestore();
    }
  }, 45_000);

  it('13. R840 (Rule 9): rejects forged tenant claims across all 7 S1-06 surfaces and hides restricted/ethical-wall engagement_signed copies with opaque 404', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctxP1 = testTenantCtx('P-000001');
    const matterRepo = new TenantMatterRepository();
    const engRepo = new TenantEngagementRepository();
    const chasingRepo = new TenantChasingRepository();
    const auditRepo = new TenantAuditRepository();

    const chaseEnabledRaw = {
      ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
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
          enabled: false,
          sendEmails: false,
          firstChaseDays: 7,
          secondChaseDays: 14,
          escalateTaskDays: 21,
        },
        moneyOnAccount: {
          enabled: false,
          sendEmails: false,
          firstChaseDays: 7,
          secondChaseDays: 14,
          escalateTaskDays: 21,
        },
      },
    };
    setActiveTenantConfigForTesting(chaseEnabledRaw, {});

    try {
      // Seed accessible matter + Client Care dispatch + active chase + signed artifact,
      // closed declined enquiry, staff matter + ethical-wall matter
      let openMatterId = '';
      let staffMatterId = '';
      let wallMatterId = '';
      await runAsActionActor(
        'P-000001',
        async () => {
          for (const [key, title] of [
            ['open', 'R840 Open Matter'],
            ['staff', 'R840 Staff Matter'],
            ['wall', 'R840 Ethical Wall Matter'],
          ] as const) {
            const m = await saveMatterRecord(
              {
                title,
                clientId: 'O-000001',
                practiceAreaId: 'work_type.employment_and_hr',
                workTypeSubcategoryId: 'work_type.employment_and_hr_employment_contracts',
                responsiblePartnerId: 'P-000001',
                supervisingPartnerId: 'P-000001',
                leadFeeEarnerId: 'P-000001',
                teamMemberIds: ['P-000001'],
                conflictCheckRecord: makeConflictRecord('P-000001', title),
                riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
              },
              { byId: 'P-000001', saveMode: 'submit_cleared' },
            );
            expect(m.errors).toBeUndefined();
            if (key === 'open') openMatterId = m.matter!.id;
            else if (key === 'staff') staffMatterId = m.matter!.id;
            else wallMatterId = m.matter!.id;
          }
        },
        { roles: ['partner'], mfaVerified: false },
      );

      // Mark staffMatterId as isStaffMatter and wallMatterId as hasEthicalWall (insider P-000001 only)
      const staffPre = (await matterRepo.getMatterById<Matter>(ctxP1, staffMatterId, {
        includeRestricted: true,
      }))!;
      const wallPre = (await matterRepo.getMatterById<Matter>(ctxP1, wallMatterId, {
        includeRestricted: true,
      }))!;
      await matterRepo.withTenantTransaction(ctxP1, async () => {
        await matterRepo.putMatter(
          ctxP1,
          {
            ...staffPre,
            isStaffMatter: true,
            restrictedAccessUserIds: ['P-000001'],
          },
          {
            expectedRowVersion: null,
            sqlRestrictedAccessUserIds: ['P-000001'],
          },
        );
        await matterRepo.putMatter(
          ctxP1,
          {
            ...wallPre,
            hasEthicalWall: true,
            restrictedAccessUserIds: ['P-000001'],
          },
          {
            expectedRowVersion: null,
            sqlRestrictedAccessUserIds: ['P-000001'],
          },
        );
      });

      const sendOpen = await runAsActionActor(
        'P-000001',
        () =>
          sendEngagementLetterAction({
            matterId: openMatterId,
            recipientEmail: 'r840-open@example.test',
          }),
        { roles: ['partner'], mfaVerified: false },
      );
      expect(sendOpen.ok).toBe(true);
      if (!sendOpen.ok || !sendOpen.chase) return;
      const openChaseId = sendOpen.chase.id;
      const openOutboxId = sendOpen.outboxRecord.id;

      const openSignedUp = await runAsActionActor(
        'P-000001',
        () => createSignedEngagementPdfArtifact(openMatterId, 'P-000001', ctxP1),
        { roles: ['partner'], mfaVerified: false },
      );
      expect(openSignedUp.ok).toBe(true);
      if (!openSignedUp.ok) return;

      const enqSave = await runAsActionActor(
        'P-000002',
        () =>
          saveEnquiryRecord(
            {
              firstName: 'R840',
              lastName: 'ForgedClaim',
              email: 'r840-enq@example.test',
              phone: '029 2000 0840',
              channelId: 'enquiry_channel.phone',
              practiceAreaId: 'work_type.employment_and_hr',
              summary: 'R840 enquiry',
              notes: 'Notes for R840 closed enquiry.',
              privacyNoticeGiven: true,
            },
            { byId: 'P-000002' },
          ),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(enqSave.errors).toBeUndefined();
      const declinedEnquiryId = enqSave.enquiry!.id;
      const closedEnq = await runAsActionActor(
        'P-000002',
        () =>
          closeEnquiryRecord(
            declinedEnquiryId,
            {
              targetStatus: 'Declined',
              closeReasonId: vid('enquiry_close_reason', 'Outside our expertise'),
              closeNotes: 'Not within current expertise.',
            },
            'P-000002',
          ),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(closedEnq.error).toBeUndefined();

      // 1. Forged tenant claim (session claims tenant-bravo against active not-a-law-firm IDs)
      //    must fail closed across ALL 7 S1-06 surfaces without modifying active tenant rows
      const expectForgedRefused = async (fn: () => Promise<unknown>) => {
        await expect(
          runAsActionActor('P-000001', fn, {
            tenantId: 'tenant-bravo',
            roles: ['partner', 'admin'],
            mfaVerified: true,
          }),
        ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      };

      await expectForgedRefused(() =>
        sendEngagementLetterAction({
          matterId: openMatterId,
          recipientEmail: 'forged@example.test',
        }),
      );
      await expectForgedRefused(() =>
        recordEngagementLetterSignedAction({
          matterId: openMatterId,
          evidenceArtifactId: openSignedUp.artifact.id,
          status: 'Signed & returned',
        }),
      );
      await expectForgedRefused(() =>
        stopCommunicationChaseAction({ chaseId: openChaseId }),
      );
      await expectForgedRefused(() =>
        sendNonEngagementLetterAction({ enquiryId: declinedEnquiryId }),
      );
      await expectForgedRefused(() =>
        listOutboxMessagesForAdminAction({ limit: 50 }),
      );
      await expectForgedRefused(() =>
        getOutboxMessageForAdminAction({ outboxId: openOutboxId }),
      );
      await expectForgedRefused(() =>
        outboxAttachmentRoute.GET(
          new Request(
            `http://localhost/api/admin/outbox/${encodeURIComponent(openOutboxId)}/attachments/0`,
            { method: 'GET' },
          ),
          {
            params: Promise.resolve({
              id: openOutboxId,
              ordinal: '0',
            }),
          },
        ),
      );

      // Verify zero writes landed in active tenant from any of the 7 forged calls
      expect(await engRepo.listDispatchesForMatter(ctxP1, openMatterId)).toHaveLength(1);
      expect(
        await engRepo.listDispatchesForEnquiry(ctxP1, declinedEnquiryId),
      ).toHaveLength(0);
      const chaseUnchanged = await chasingRepo.getChaseById(ctxP1, openChaseId);
      expect(chaseUnchanged?.status).toBe('active');
      const matterUnchanged = await matterRepo.getMatterById<Matter>(ctxP1, openMatterId, {
        includeRestricted: true,
      });
      expect(matterUnchanged?.engagementLetterSignedAt).toBeNull();
      const outboxAudits = await auditRepo.listAuditEntriesForRecord(
        ctxP1,
        'email_outbox',
        openOutboxId,
        { limit: 50 },
      );
      expect(outboxAudits).toHaveLength(0);

      // 2. Staff-matter AND ethical-wall engagement_signed downloads by document:view users NOT in
      //    restrictedAccessUserIds must return the exact same opaque 404 as a missing artifact
      const staffSignedUp = await runAsActionActor(
        'P-000001',
        () => createSignedEngagementPdfArtifact(staffMatterId, 'P-000001', ctxP1),
        { roles: ['partner'], mfaVerified: false },
      );
      const wallSignedUp = await runAsActionActor(
        'P-000001',
        () => createSignedEngagementPdfArtifact(wallMatterId, 'P-000001', ctxP1),
        { roles: ['partner'], mfaVerified: false },
      );
      expect(staffSignedUp.ok).toBe(true);
      expect(wallSignedUp.ok).toBe(true);
      if (!staffSignedUp.ok || !wallSignedUp.ok) return;

      const storage = getDocumentStorage(getActiveTenantConfiguration());
      const missingBaselineToken = await storage.issueScopedDownloadToken(ctxP1, {
        blobKey: staffSignedUp.artifact.blobKey,
        fileName: 'missing.pdf',
        documentId: 'EVD-MISSING-R840',
      });
      const baselineRes = await runAsActionActor(
        'P-000001',
        () =>
          evidenceDownloadRoute.GET(
            new Request(
              `http://localhost/api/evidence/download?token=${encodeURIComponent(missingBaselineToken.token)}`,
              { method: 'GET' },
            ),
          ),
        { roles: ['partner'], mfaVerified: false },
      );
      expect(baselineRes.status).toBe(404);
      const baselineBody = await baselineRes.json();

      // Insider P-000001 downloads both cleanly
      for (const dlUrl of [staffSignedUp.downloadUrl, wallSignedUp.downloadUrl]) {
        const insiderDl = await runAsActionActor(
          'P-000001',
          () =>
            evidenceDownloadRoute.GET(
              new Request(`http://localhost${dlUrl}`, { method: 'GET' }),
            ),
          { roles: ['partner'], mfaVerified: false },
        );
        expect(insiderDl.status).toBe(200);
      }

      // Outsiders holding document:view (P-000009 finance and P-000006 fee_earner) are NOT on restrictedAccessUserIds
      for (const [outsiderId, outsiderRole] of [
        ['P-000009', 'finance'],
        ['P-000006', 'fee_earner'],
      ] as const) {
        const outsiderCtx = makeVerifiedTenantCtx(
          'not-a-law-firm',
          outsiderId,
          [outsiderRole],
          false,
        );
        for (const art of [staffSignedUp.artifact, wallSignedUp.artifact]) {
          const outsiderToken = await storage.issueScopedDownloadToken(outsiderCtx, {
            blobKey: art.blobKey,
            fileName: art.fileName,
            documentId: art.id,
          });
          const res = await runAsActionActor(
            outsiderId,
            () =>
              evidenceDownloadRoute.GET(
                new Request(
                  `http://localhost/api/evidence/download?token=${encodeURIComponent(outsiderToken.token)}`,
                  { method: 'GET' },
                ),
              ),
            { roles: [outsiderRole], mfaVerified: false },
          );
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual(baselineBody);
        }
      }
    } finally {
      setTestActorSession(null);
      setActiveTenantConfigForTesting(null);
    }
  }, 60_000);
});
