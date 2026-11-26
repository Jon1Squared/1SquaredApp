import { afterEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  forceCanOpen: false,
}));

vi.mock('@/domain/openingGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/domain/openingGate')>();
  return {
    ...actual,
    evaluateOpeningPreconditions: (
      ...args: Parameters<typeof actual.evaluateOpeningPreconditions>
    ) => {
      const result = actual.evaluateOpeningPreconditions(...args);
      if (!mockState.forceCanOpen) {
        return result;
      }
      return {
        ...result,
        canOpen: true,
        blockingReasons: [],
      };
    },
  };
});

import { TenantMatterRepository } from '../src/index';
import {
  OPENING_GATE_INCONSISTENT_CODE,
  OPENING_GATE_INCONSISTENT_USER_MESSAGE,
} from '@/domain/openingGate';
import type { ConflictCheckRecordInput, Matter } from '@/domain/types';
import {
  openProspectiveMatterRecord,
  recordEngagementLetterSignedRecord,
  resetAllDemoData,
  saveMatterRecord,
  updateMatterConflictRecord,
  uploadEvidenceArtifactRecord,
} from '@/server/services';
import {
  runAsTestActor,
  setTestActorSession,
  testTenantCtx,
} from '@/server/testSupport/auditTestSupport';
import { testDataResetContext } from '@/test/testTenantContexts';

const LOW_RISK_ANSWERS: Record<string, string> = {
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

function makeClearedConflict(actorId: string, actorName: string): ConflictCheckRecordInput {
  return {
    status: 'Cleared',
    outcomeLabel: 'Cleared by fee earner',
    declarationConfirmed: true,
    reviewerMessage: 'Conflict check clear',
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

async function runAsPartner<R>(fn: () => Promise<R>): Promise<R> {
  setTestActorSession('P-000001', { roles: ['partner'], mfaVerified: false });
  try {
    return await runAsTestActor('P-000001', fn, {
      roles: ['partner'],
      mfaVerified: false,
    });
  } finally {
    setTestActorSession(null);
  }
}

describe('R813: Opening gate fail-closed guard & PG16 transaction rollback on OPENING_GATE_INCONSISTENT', () => {
  afterEach(() => {
    mockState.forceCanOpen = false;
    setTestActorSession(null);
  });

  it('rolls back opening transactions and returns plain British English OPENING_GATE_INCONSISTENT error when canOpen mismatches unsatisfied CDD', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const matterRepo = new TenantMatterRepository();
    const ctxPartner = testTenantCtx('P-000001');

    // Seed prospective matter on work_type requiring CDD (Employment -> Tribunal claims),
    // leaving O-000002 with NO CDD record and NO override so CDD is raw-unsatisfied.
    let prospectiveId = '';
    const originalTitle = 'R813 Fail-Closed Rollback Prospective Matter';
    await runAsPartner(async () => {
      const saved = await saveMatterRecord(
        {
          title: originalTitle,
          clientId: 'O-000002',
          practiceAreaId: 'work_type.employment_and_hr',
          workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: 'P-000002',
          teamMemberIds: ['P-000001', 'P-000002'],
          conflictCheckRecord: makeClearedConflict('P-000001', 'Rhian Morgan'),
          riskAssessment: { answers: LOW_RISK_ANSWERS },
        },
        { byId: 'P-000001', saveMode: 'submit_cleared' },
      );
      expect(saved.errors).toBeUndefined();
      expect(saved.matter).not.toBeNull();
      prospectiveId = saved.matter!.id;

      const signedCopy = await uploadEvidenceArtifactRecord(
        {
          subjectType: 'matter',
          subjectId: prospectiveId,
          purpose: 'engagement_signed',
          fileName: 'signed-engagement-r813.pdf',
          contentType: 'application/pdf',
          bytes: Buffer.from('%PDF-1.4\n% R813 signed engagement copy\n%%EOF\n'),
        },
        'P-000001',
      );
      if (!signedCopy.ok) throw new Error(signedCopy.message);
      const engRes = await recordEngagementLetterSignedRecord(
        {
          matterId: prospectiveId,
          evidenceArtifactId: signedCopy.artifact.id,
          status: 'Signed & returned',
        },
        'P-000001',
      );
      expect(engRes.ok).toBe(true);
    });

    const beforeMatter = await matterRepo.getMatterById<Matter>(ctxPartner, prospectiveId, {
      includeRestricted: true,
    });
    expect(beforeMatter).not.toBeNull();
    expect(beforeMatter!.matterStatusId).toBe('matter_status.prospective_enquiry');
    expect(beforeMatter!.openedAt).toBeNull();
    expect(beforeMatter!.amlStatus).not.toBe('Verified');
    const beforeRowVersion = beforeMatter!.rowVersion ?? 1;

    // Force evaluateOpeningPreconditions to erroneously report canOpen: true
    // while resolveOpeningGateCddOutcome runs the real fail-closed check inside TX.
    mockState.forceCanOpen = true;

    // 1. openProspectiveMatterRecord must throw inside TX, roll back, and map cleanly
    const openRes = (await runAsPartner(() =>
      openProspectiveMatterRecord(prospectiveId, 'P-000001'),
    )) as { ok: boolean; code?: string; message?: string };
    expect(openRes.ok).toBe(false);
    expect(openRes.code).toBe(OPENING_GATE_INCONSISTENT_CODE);
    expect(openRes.message).toBe(OPENING_GATE_INCONSISTENT_USER_MESSAGE);
    expect(openRes.message).not.toMatch(/\n\s+at\s+/);

    const afterOpenRead = await matterRepo.getMatterById<Matter>(ctxPartner, prospectiveId, {
      includeRestricted: true,
    });
    expect(afterOpenRead!.matterStatusId).toBe('matter_status.prospective_enquiry');
    expect(afterOpenRead!.openedAt).toBeNull();
    expect(afterOpenRead!.amlStatus).not.toBe('Verified');
    expect(afterOpenRead!.title).toBe(originalTitle);
    expect(afterOpenRead!.rowVersion).toBe(beforeRowVersion);

    // 2. saveMatterRecord attempting title edit + opening must also roll back completely
    const saveRes = await runAsPartner(() =>
      saveMatterRecord(
        {
          title: 'R813 Title Mutation Must Roll Back',
          clientId: 'O-000002',
          practiceAreaId: 'work_type.employment_and_hr',
          workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: 'P-000002',
          teamMemberIds: ['P-000001', 'P-000002'],
          riskAssessment: { answers: LOW_RISK_ANSWERS },
        },
        {
          id: prospectiveId,
          byId: 'P-000001',
          saveMode: 'submit_cleared',
          expectedRowVersion: beforeRowVersion,
        },
      ),
    );
    expect(saveRes.matter).toBeNull();
    expect(saveRes.code).toBe(OPENING_GATE_INCONSISTENT_CODE);
    expect(saveRes.message).toBe(OPENING_GATE_INCONSISTENT_USER_MESSAGE);
    expect(saveRes.message).not.toMatch(/\n\s+at\s+/);

    const afterSaveRead = await matterRepo.getMatterById<Matter>(ctxPartner, prospectiveId, {
      includeRestricted: true,
    });
    expect(afterSaveRead!.title).toBe(originalTitle);
    expect(afterSaveRead!.matterStatusId).toBe('matter_status.prospective_enquiry');
    expect(afterSaveRead!.openedAt).toBeNull();
    expect(afterSaveRead!.amlStatus).not.toBe('Verified');
    expect(afterSaveRead!.rowVersion).toBe(beforeRowVersion);

    // 3. updateMatterConflictRecord (Risk & Compliance Approving conflict) must also fail closed and roll back conflict update
    setTestActorSession('P-000003', { roles: ['risk_compliance'], mfaVerified: true });
    const conflictRes = await runAsTestActor(
      'P-000003',
      () =>
        updateMatterConflictRecord(
          prospectiveId,
          {
            ...makeClearedConflict('P-000003', 'Bethan Davies'),
            status: 'Approved',
            outcomeLabel: 'Approved by Risk & Compliance',
            reviewerMessage: 'Conflict update that must roll back',
          },
          'P-000003',
        ),
      { roles: ['risk_compliance'], mfaVerified: true },
    );
    expect(conflictRes.matter).toBeNull();
    expect(conflictRes.code).toBe(OPENING_GATE_INCONSISTENT_CODE);
    expect(conflictRes.message).toBe(OPENING_GATE_INCONSISTENT_USER_MESSAGE);

    const afterConflictRead = await matterRepo.getMatterById<Matter>(ctxPartner, prospectiveId, {
      includeRestricted: true,
    });
    expect(afterConflictRead!.matterStatusId).toBe('matter_status.prospective_enquiry');
    expect(afterConflictRead!.openedAt).toBeNull();
    expect(afterConflictRead!.conflictCheckRecord?.status).toBe('Cleared');
    expect(afterConflictRead!.conflictCheckRecord?.reviewerMessage).not.toBe(
      'Conflict update that must roll back',
    );
    expect(afterConflictRead!.rowVersion).toBe(beforeRowVersion);
  }, 60_000);
});
