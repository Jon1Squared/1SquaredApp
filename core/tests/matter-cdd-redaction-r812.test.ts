import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  REDACTED_MATTER_CDD_STATUS,
  TenantIntakeQuoteRepository,
  TenantKeyDateRepository,
  TenantMatterRepository,
  TenantPartyRepository,
  TenantTaskWorkflowRepository,
  type KeyDate,
} from '../src/index';
import {
  liftMatterRestrictionAction,
  listClientPriorMattersAction,
  listRegistersWorkspaceAction,
  openProspectiveMatterAction,
  recordEngagementLetterSignedAction,
  runMatterConflictSearchAction,
  saveMatterAction,
  signOffMatterCostsAction,
  updateMatterConflictRecordAction,
  updateMatterLifecycleStatusAction,
} from '@/app/actions';
import {
  isMatterCmiIncompleteStatus,
  resolveMatterStatusPill,
} from '@/domain/matterStatusDisplay';
import type {
  ClientPriorMatterSummary,
  MatterOpeningSnapshot,
} from '@/domain/matterOpeningRecord';
import { redactMatterCddInBrowserPayload } from '@/server/matterCddBoundary';
import type {
  ConflictCheckRecordInput,
  Enquiry,
  Matter,
  Person,
  Quote,
  Task,
} from '@/domain/types';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import {
  loadEnquiriesListPageData,
  loadEnquiryDetailPageData,
  loadHomePageData,
  loadKeyDatesPageData,
  loadMatterDetailPageData,
  loadMatterFormPageData,
  loadMattersListPageData,
  loadOrganisationDetailPageData,
  loadPersonDetailPageData,
  loadPersonFormPageData,
  loadQuoteDetailPageData,
  loadRegistersPageData,
  loadShellContext,
  loadTaskDetailPageData,
  loadTaskFormPageData,
  loadTasksListPageData,
} from '@/server/pageLoaders';
import {
  completeClientCddRecord,
  createRegisterRecordService,
  recordCddChecklistItemRecord,
  resetAllDemoData,
  saveMatterRecord,
  startOrLoadClientCddRecord,
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
    outcomeLabel:
      status === 'Cleared'
        ? 'Cleared by fee earner'
        : status === 'Approved'
          ? 'Approved by Risk & Compliance'
          : 'Pending',
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

const actorStack: Array<{
  actorId: string;
  options?: { tenantId?: string; mfaVerified?: boolean; roles?: readonly string[] };
}> = [];

async function runAsActionActor<R>(
  actorId: string,
  fn: () => Promise<R>,
  options?: { tenantId?: string; mfaVerified?: boolean; roles?: readonly string[] },
): Promise<R> {
  actorStack.push({ actorId, options });
  setTestActorSession(actorId, options);
  try {
    return await runAsTestActor(actorId, fn, options);
  } finally {
    actorStack.pop();
    const prev = actorStack[actorStack.length - 1];
    if (prev) {
      setTestActorSession(prev.actorId, prev.options);
    } else {
      setTestActorSession(null);
    }
  }
}

interface ExtractedPayloads {
  matters: Matter[];
  priorSummaries: ClientPriorMatterSummary[];
}

function collectMattersAndSummaries(root: unknown): ExtractedPayloads {
  const matters: Matter[] = [];
  const priorSummaries: ClientPriorMatterSummary[] = [];
  const seen = new WeakSet<object>();

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const rec = node as Record<string, unknown>;
    if (
      rec.recordType === 'matter' &&
      typeof rec.id === 'string' &&
      'matterStatusId' in rec &&
      'amlStatus' in rec
    ) {
      matters.push(node as Matter);
      return;
    }
    if (
      typeof rec.id === 'string' &&
      typeof rec.clientId === 'string' &&
      rec.recordType === undefined &&
      !('matterStatusId' in rec)
    ) {
      priorSummaries.push(node as ClientPriorMatterSummary);
      return;
    }

    for (const [key, val] of Object.entries(rec)) {
      if (key === 'shell' || key === 'ctx' || key === 'store') continue;
      visit(val);
    }
  };

  visit(root);
  return { matters, priorSummaries };
}

function assertAllMattersAndSummariesRedacted(
  payload: unknown,
  opts?: { expectedMatterId?: string; expectedPriorSummaryMatterId?: string },
): void {
  const { matters, priorSummaries } = collectMattersAndSummaries(payload);
  for (const m of matters) {
    expect(m.amlStatus).toBe(REDACTED_MATTER_CDD_STATUS);
    expect(m.amlCompletedAt).toBeNull();
    const snap = m.fieldValues?.['matterOpeningSnapshot'] as
      | MatterOpeningSnapshot
      | undefined;
    if (snap?.complianceOnboarding) {
      expect(snap.complianceOnboarding.amlStatus).toBe(REDACTED_MATTER_CDD_STATUS);
    }
  }
  for (const s of priorSummaries) {
    expect(s.amlStatus).toBeUndefined();
    expect('amlStatus' in s).toBe(false);
  }
  if (opts?.expectedMatterId) {
    expect(matters.some((m) => m.id === opts.expectedMatterId)).toBe(true);
  }
  if (opts?.expectedPriorSummaryMatterId) {
    expect(
      priorSummaries.some((s) => s.id === opts.expectedPriorSummaryMatterId),
    ).toBe(true);
  }
}

function assertTargetShowsVerified(
  payload: unknown,
  opts: {
    expectedMatterId?: string;
    expectedMatterAmlStatus?: string;
    expectedPriorSummaryMatterId?: string;
    requireSnapshotVerified?: boolean;
  },
): void {
  const { matters, priorSummaries } = collectMattersAndSummaries(payload);
  if (opts.expectedMatterId) {
    const target = matters.find((m) => m.id === opts.expectedMatterId);
    expect(target).toBeDefined();
    const expectedStatus = opts.expectedMatterAmlStatus ?? 'Verified';
    expect(target!.amlStatus).toBe(expectedStatus);
    if (expectedStatus === 'Verified') {
      expect(target!.amlCompletedAt).toBeTruthy();
      if (opts.requireSnapshotVerified !== false) {
        const snap = target!.fieldValues?.['matterOpeningSnapshot'] as
          | MatterOpeningSnapshot
          | undefined;
        expect(snap?.complianceOnboarding.amlStatus).toBe('Verified');
      }
    }
  }
  if (opts.expectedPriorSummaryMatterId) {
    const targetSummary = priorSummaries.find(
      (s) => s.id === opts.expectedPriorSummaryMatterId,
    );
    expect(targetSummary).toBeDefined();
    expect(targetSummary!.amlStatus).toBe('Verified');
  }
}

interface TestFixtureIds {
  verifiedMatterId: string;
  closableVerifiedMatterId: string;
  closableVerifiedOpenedAt: string;
  draftMatterId: string;
  enquiryId: string;
  quoteId: string;
  taskId: string;
  keyDateId: string;
  prospectiveOpenMatterId: string;
  ethicalWallMatterId: string;
  employeeClientMatterId: string;
  personContactId: string;
  personFeeEarnerId: string;
  clientOrgId: string;
  enquiriesActorId: string;
  adminActorId: string;
}

async function seedR812Fixture(): Promise<TestFixtureIds> {
  await resetAllDemoData('P-000004', testDataResetContext());
  const ctxPartner = testTenantCtx('P-000001');
  const matterRepo = new TenantMatterRepository();
  const partyRepo = new TenantPartyRepository();
  const intakeRepo = new TenantIntakeQuoteRepository();
  const taskRepo = new TenantTaskWorkflowRepository();
  const keyDateRepo = new TenantKeyDateRepository();
  const seed = createSeedStore();

  const clientOrgId = 'O-000001';
  const personContactId = 'P-000011';
  const personFeeEarnerId = 'P-000002';
  const enquiriesActorId = 'P-R812-ENQ';
  const adminActorId = 'P-R812-ADM';

  const baseEmp = await partyRepo.getPersonById<Person>(ctxPartner, 'P-000009');
  expect(baseEmp).not.toBeNull();
  const enqActor: Person = {
    ...structuredClone(baseEmp!),
    id: enquiriesActorId,
    firstName: 'Nadia',
    surname: 'Evans',
    jobTitle: 'Enquiries Coordinator (R812)',
    employeeRoleId: 'employee_role.business_development',
    departmentId: 'department.business_development',
    entraObjectId: '00000000-0000-4000-8000-000000000812',
    roles: ['enquiries_coordinator'],
    emails: [
      {
        id: 'e-r812-enq',
        address: 'nadia.evans@notalawfirm.example',
        typeId: 'email_type.work',
        isPrimary: true,
        firmIssued: true,
        active: true,
      },
    ],
    employment: baseEmp!.employment
      ? {
          ...structuredClone(baseEmp!.employment),
          id: 'EREC-P-R812-ENQ',
          personId: enquiriesActorId,
          employeeNumber: 'EMP-8121',
          jobTitle: 'Enquiries Coordinator (R812)',
          departmentId: 'DEPT-BD',
          systems: baseEmp!.employment.systems
            ? {
                ...baseEmp!.employment.systems,
                networkLogin: 'nadia.evans',
                buildingPassNumber: 'BP-8121',
                firmWorkEmail: 'nadia.evans@notalawfirm.example',
              }
            : null,
        }
      : null,
  };
  const adminActor: Person = {
    ...structuredClone(baseEmp!),
    id: adminActorId,
    firstName: 'Tudur',
    surname: 'Pritchard',
    jobTitle: 'System Administrator (R812)',
    employeeRoleId: 'employee_role.system_administrator',
    departmentId: 'department.it_and_systems',
    entraObjectId: '00000000-0000-4000-8000-000000000813',
    roles: ['admin'],
    emails: [
      {
        id: 'e-r812-adm',
        address: 'tudur.pritchard@notalawfirm.example',
        typeId: 'email_type.work',
        isPrimary: true,
        firmIssued: true,
        active: true,
      },
    ],
    employment: baseEmp!.employment
      ? {
          ...structuredClone(baseEmp!.employment),
          id: 'EREC-P-R812-ADM',
          personId: adminActorId,
          employeeNumber: 'EMP-8122',
          jobTitle: 'System Administrator (R812)',
          departmentId: 'DEPT-IT',
          systems: baseEmp!.employment.systems
            ? {
                ...baseEmp!.employment.systems,
                networkLogin: 'tudur.pritchard',
                buildingPassNumber: 'BP-8122',
                firmWorkEmail: 'tudur.pritchard@notalawfirm.example',
              }
            : null,
        }
      : null,
  };
  await partyRepo.putPeople(ctxPartner, [enqActor, adminActor]);

  await runAsActionActor(
    'P-000003',
    async () => {
      for (const subject of [
        { subjectType: 'organisation' as const, subjectId: clientOrgId },
        { subjectType: 'person' as const, subjectId: 'P-000010' },
      ]) {
        const cddStart = await startOrLoadClientCddRecord(
          {
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            createIfMissing: true,
          },
          'P-000003',
        );
        expect(cddStart.ok).toBe(true);
        if (cddStart.ok && cddStart.summary.record && cddStart.summary.status !== 'recorded') {
          for (const item of cddStart.summary.checklistItems) {
            if (item.status !== 'recorded') {
              await recordCddChecklistItemRecord(
                {
                  recordId: cddStart.summary.record.id,
                  itemKey: item.itemKey,
                  status: 'recorded',
                  note: 'Verified for R812 test',
                },
                'P-000003',
              );
            }
          }
          const completed = await completeClientCddRecord(
            { recordId: cddStart.summary.record.id },
            'P-000003',
          );
          expect(completed.ok).toBe(true);
        }
      }
    },
    { roles: ['risk_compliance'], mfaVerified: true },
  );

  const enquiryId = 'ENQ-R812-01';
  const quoteId = 'QUO-R812-01';
  const taskId = 'TSK-R812-01';
  const keyDateId = 'KD-R812-01';

  let verifiedMatterId = '';
  let closableVerifiedMatterId = '';
  let closableVerifiedOpenedAt = '';
  let draftMatterId = '';
  let prospectiveOpenMatterId = '';
  let ethicalWallMatterId = '';
  let employeeClientMatterId = '';

  await runAsActionActor(
    'P-000001',
    async () => {
      const saveMain = await saveMatterRecord(
        {
          title: 'R812 Primary Verified Gate Matter',
          clientId: clientOrgId,
          instructingContactId: personContactId,
          practiceAreaId: 'work_type.employment_and_hr',
          workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: personFeeEarnerId,
          teamMemberIds: ['P-000001', personFeeEarnerId],
          conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
          riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
        },
        { byId: 'P-000001', saveMode: 'submit_cleared' },
      );
      expect(saveMain.errors).toBeUndefined();
      verifiedMatterId = saveMain.matter!.id;

      await recordEngagementLetterSignedAction({
        matterId: verifiedMatterId,
        status: 'Signed & returned',
      });
      const openedMain = (await openProspectiveMatterAction(verifiedMatterId)) as {
        ok: boolean;
        matter?: Matter;
      };
      expect(openedMain.ok).toBe(true);
      expect(openedMain.matter!.amlStatus).toBe('Verified');

      const saveClosable = await saveMatterRecord(
        {
          title: 'R812 Closable Verified Gate Matter (No Key Dates)',
          clientId: clientOrgId,
          practiceAreaId: 'work_type.employment_and_hr',
          workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: personFeeEarnerId,
          teamMemberIds: ['P-000001', personFeeEarnerId],
          conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
          riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
        },
        { byId: 'P-000001', saveMode: 'submit_cleared' },
      );
      expect(saveClosable.errors).toBeUndefined();
      closableVerifiedMatterId = saveClosable.matter!.id;
      await recordEngagementLetterSignedAction({
        matterId: closableVerifiedMatterId,
        status: 'Signed & returned',
      });
      const openedClosable = (await openProspectiveMatterAction(closableVerifiedMatterId)) as {
        ok: boolean;
        matter?: Matter;
      };
      expect(openedClosable.ok).toBe(true);
      expect(openedClosable.matter!.amlStatus).toBe('Verified');
      closableVerifiedOpenedAt = openedClosable.matter!.openedAt!;

      const saveDraft = await saveMatterRecord(
        {
          title: 'R812 Draft Matter For Form Branch',
          clientId: clientOrgId,
          practiceAreaId: 'work_type.employment_and_hr',
          workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: personFeeEarnerId,
          teamMemberIds: ['P-000001', personFeeEarnerId],
        },
        { byId: 'P-000001', saveMode: 'draft' },
      );
      expect(saveDraft.matter).not.toBeNull();
      draftMatterId = saveDraft.matter!.id;

      const saveProspectiveOpen = await saveMatterRecord(
        {
          title: 'R812 Prospective Ready To Open',
          clientId: clientOrgId,
          practiceAreaId: 'work_type.employment_and_hr',
          workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: personFeeEarnerId,
          teamMemberIds: ['P-000001', personFeeEarnerId],
          conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
          riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
        },
        { byId: 'P-000001', saveMode: 'submit_cleared' },
      );
      expect(saveProspectiveOpen.matter).not.toBeNull();
      prospectiveOpenMatterId = saveProspectiveOpen.matter!.id;
      await recordEngagementLetterSignedAction({
        matterId: prospectiveOpenMatterId,
        status: 'Signed & returned',
      });

      const saveWall = await saveMatterRecord(
        {
          title: 'R812 Ethical Wall Verified Matter',
          clientId: clientOrgId,
          practiceAreaId: 'work_type.employment_and_hr',
          workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: personFeeEarnerId,
          teamMemberIds: ['P-000001', personFeeEarnerId],
          hasEthicalWall: true,
          restrictedAccessUserIds: ['P-000001', 'P-000003', adminActorId],
          conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
          riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
        },
        { byId: 'P-000001', saveMode: 'submit_cleared' },
      );
      expect(saveWall.matter).not.toBeNull();
      ethicalWallMatterId = saveWall.matter!.id;
      await recordEngagementLetterSignedAction({
        matterId: ethicalWallMatterId,
        status: 'Signed & returned',
      });
      const openedWall = (await openProspectiveMatterAction(ethicalWallMatterId)) as {
        ok: boolean;
        matter?: Matter;
      };
      expect(openedWall.ok).toBe(true);
      expect(openedWall.matter!.amlStatus).toBe('Verified');

      const saveEmpClient = await saveMatterRecord(
        {
          title: 'R812 Employee Client Verified Matter',
          clientId: clientOrgId,
          additionalClientIds: ['P-000010'],
          practiceAreaId: 'work_type.employment_and_hr',
          workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: 'P-000001',
          teamMemberIds: ['P-000001'],
          conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
          riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
        },
        { byId: 'P-000001', saveMode: 'submit_cleared' },
      );
      expect(saveEmpClient.matter).not.toBeNull();
      employeeClientMatterId = saveEmpClient.matter!.id;
      await recordEngagementLetterSignedAction({
        matterId: employeeClientMatterId,
        status: 'Signed & returned',
      });
      const openedEmp = (await openProspectiveMatterAction(employeeClientMatterId)) as {
        ok: boolean;
        matter?: Matter;
      };
      expect(openedEmp.ok).toBe(true);
      expect(openedEmp.matter!.amlStatus).toBe('Verified');
    },
    { roles: ['partner'], mfaVerified: false },
  );

  // Lift staff_matter restriction on employeeClientMatterId so non-participant cdd:view
  // fee earner P-000006 can open the matter page/form while R747/R792 masks employee CDD
  await runAsActionActor(
    'P-000004',
    async () => {
      const liftRes = (await liftMatterRestrictionAction(
        employeeClientMatterId,
        'staff_matter',
        'R812 joint-client matter staff restriction lifted for general handling.',
      )) as { matter: Matter | null; errors?: Record<string, string> };
      expect(liftRes.errors).toBeUndefined();
      expect(liftRes.matter?.isStaffMatter).toBe(false);
    },
    { roles: ['managing_partner'], mfaVerified: true },
  );

  const templateEnq = seed.enquiries[0]!;
  const convertedEnq: Enquiry = {
    ...structuredClone(templateEnq),
    id: enquiryId,
    reference: 'ENQ-R812-01',
    status: 'Converted',
    createdById: enquiriesActorId,
    takenById: enquiriesActorId,
    assignedTeamId: seed.teams[0]?.id ?? 'TM-000001',
    assignedToId: enquiriesActorId,
    linkedPersonId: personContactId,
    linkedOrganisationId: clientOrgId,
    convertedMatterId: verifiedMatterId,
    summary: 'R812 Converted Enquiry Linked To Verified Matter',
    receivedAt: '2026-11-26T09:00:00.000Z',
  };
  await intakeRepo.putEnquiry(ctxPartner, convertedEnq);

  const templateQuote = seed.quotes[0]!;
  const convertedQuote: Quote = {
    ...structuredClone(templateQuote),
    id: quoteId,
    reference: 'QUO-R812-01',
    status: 'Accepted',
    prospectName: 'R812 Quote Linked To Verified Matter',
    linkedOrganisationId: clientOrgId,
    linkedPersonId: personContactId,
    linkedEnquiryId: enquiryId,
    convertedMatterId: verifiedMatterId,
    feeEarnerId: personFeeEarnerId,
  };
  await intakeRepo.putQuote(ctxPartner, convertedQuote);

  const mainMatter = await matterRepo.getMatterById<Matter>(ctxPartner, verifiedMatterId, {
    includeRestricted: true,
  });
  expect(mainMatter).not.toBeNull();
  await matterRepo.putMatter(
    ctxPartner,
    {
      ...mainMatter!,
      sourceEnquiryId: enquiryId,
      sourceQuoteId: quoteId,
    },
    { expectedRowVersion: mainMatter!.rowVersion ?? 1 },
  );

  const templateTask = seed.tasks[0]!;
  const linkedTask: Task = {
    ...structuredClone(templateTask),
    id: taskId,
    title: 'R812 Task Linked To Verified Matter',
    status: 'To do',
    dueAt: '2026-12-15',
    assignedPersonId: 'P-000009',
    assignedPersonIds: ['P-000009', enquiriesActorId, adminActorId, 'P-000001'],
    linkedRecords: [{ recordType: 'matter', recordId: verifiedMatterId }],
  };
  await taskRepo.putTask(ctxPartner, linkedTask);

  const partnerTeamId =
    seed.teams.find((t) => t.memberIds.includes('P-000001'))?.id ??
    seed.teams[0]?.id ??
    'TM-000001';
  const linkedKd: KeyDate = {
    id: keyDateId,
    matterId: verifiedMatterId,
    keyDateTypeId: 'limitation',
    category: 'limitation',
    title: 'R812 Key Date On Verified Matter',
    dueDate: '2026-12-20',
    status: 'confirmed',
    source: 'manual',
    isCritical: false,
    responsiblePersonIds: ['P-000001', adminActorId],
    teamId: partnerTeamId,
    verification: {
      required: false,
      verifiedById: 'P-000001',
      verifiedAt: '2026-11-26T09:00:00.000Z',
    },
    version: 1,
    createdById: 'P-000001',
    createdAt: '2026-11-26T09:00:00.000Z',
    updatedById: 'P-000001',
    updatedAt: '2026-11-26T09:00:00.000Z',
  };
  await keyDateRepo.putKeyDate(ctxPartner, linkedKd, { expectedVersion: null });

  await runAsActionActor(
    'P-000001',
    async () => {
      const regRes = await createRegisterRecordService(
        {
          registerTypeKey: 'complaint',
          title: 'R812 Complaint Linked To Verified Matter',
          matterId: verifiedMatterId,
          fieldValues: {
            complainantName: 'Invented Complainant',
            complaintSummary: 'Testing R812 redaction on Registers workspace.',
          },
        },
        'P-000001',
      );
      expect(regRes.ok).toBe(true);
    },
    { roles: ['partner'], mfaVerified: false },
  );

  // Sanity-check actor cdd:view permissions before running tables
  for (const check of [
    { id: 'P-000009', roles: ['finance'], mfa: false, expected: false },
    { id: enquiriesActorId, roles: ['enquiries_coordinator'], mfa: false, expected: false },
    { id: adminActorId, roles: ['admin'], mfa: true, expected: false },
    { id: 'P-000001', roles: ['partner'], mfa: false, expected: true },
    { id: 'P-000003', roles: ['risk_compliance'], mfa: true, expected: true },
    { id: 'P-000006', roles: ['fee_earner'], mfa: false, expected: true },
  ]) {
    const shell = await runAsActionActor(
      check.id,
      () => loadShellContext(check.id),
      { roles: check.roles, mfaVerified: check.mfa },
    );
    expect(shell.canViewCdd).toBe(check.expected);
  }

  return {
    verifiedMatterId,
    closableVerifiedMatterId,
    closableVerifiedOpenedAt,
    draftMatterId,
    enquiryId,
    quoteId,
    taskId,
    keyDateId,
    prospectiveOpenMatterId,
    ethicalWallMatterId,
    employeeClientMatterId,
    personContactId,
    personFeeEarnerId,
    clientOrgId,
    enquiriesActorId,
    adminActorId,
  };
}

let fx!: TestFixtureIds;

describe('R812: Shared CDD redaction choke point across all page loaders & server actions', () => {
  beforeAll(async () => {
    fx = await seedR812Fixture();
  }, 60_000);

  afterEach(() => {
    setTestActorSession(null);
  });

  const LOADER_TABLE: Array<{
    readonly name: string;
    readonly run: (actorId: string) => Promise<unknown>;
    readonly expectTargetForFinance: boolean;
    readonly expectTargetForEnquiries: boolean;
    readonly expectTargetForAdminNoCdd?: boolean;
    readonly targetField?: 'verifiedMatterId' | 'draftMatterId';
    readonly expectedMatterAmlStatus?: string;
    readonly priorSummaryField?: 'verifiedMatterId';
    readonly requireSnapshotVerified?: boolean;
  }> = [
    {
      name: 'loadHomePageData',
      run: (actorId) => loadHomePageData(actorId),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadMattersListPageData',
      run: (actorId) => loadMattersListPageData(actorId, { page: 1, pageSize: 200 }),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadMatterDetailPageData (profile)',
      run: (actorId) => loadMatterDetailPageData(actorId, fx.verifiedMatterId),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadMatterDetailPageData (form / draft branch)',
      run: (actorId) => loadMatterDetailPageData(actorId, fx.draftMatterId),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'draftMatterId',
      expectedMatterAmlStatus: 'CMI incomplete',
      priorSummaryField: 'verifiedMatterId',
      requireSnapshotVerified: false,
    },
    {
      name: 'loadMatterFormPageData (editId)',
      run: (actorId) => loadMatterFormPageData(actorId, { editId: fx.verifiedMatterId }),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadPersonDetailPageData (instructing contact P-000011)',
      run: (actorId) => loadPersonDetailPageData(actorId, fx.personContactId),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadPersonDetailPageData (fee earner P-000002)',
      run: (actorId) => loadPersonDetailPageData(actorId, fx.personFeeEarnerId),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadPersonFormPageData (fee earner P-000002)',
      run: (actorId) => loadPersonFormPageData(actorId, fx.personFeeEarnerId),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadOrganisationDetailPageData (client O-000001)',
      run: (actorId) => loadOrganisationDetailPageData(actorId, fx.clientOrgId),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadEnquiriesListPageData (tab: all)',
      run: (actorId) =>
        loadEnquiriesListPageData(actorId, { tab: 'all', page: 1, pageSize: 200 }),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadEnquiryDetailPageData',
      run: (actorId) => loadEnquiryDetailPageData(actorId, fx.enquiryId),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadQuoteDetailPageData',
      run: (actorId) => loadQuoteDetailPageData(actorId, fx.quoteId),
      expectTargetForFinance: false,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadTasksListPageData (tab: all)',
      run: (actorId) =>
        loadTasksListPageData(actorId, { tab: 'all', page: 1, pageSize: 200 }),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadTaskDetailPageData',
      run: (actorId) => loadTaskDetailPageData(actorId, fx.taskId),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadTaskFormPageData (linked matter)',
      run: (actorId) =>
        loadTaskFormPageData(actorId, {
          recordType: 'matter',
          recordId: fx.verifiedMatterId,
        }),
      expectTargetForFinance: true,
      expectTargetForEnquiries: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadKeyDatesPageData',
      run: (actorId) => loadKeyDatesPageData(actorId),
      expectTargetForFinance: false,
      expectTargetForEnquiries: false,
      expectTargetForAdminNoCdd: true,
      targetField: 'verifiedMatterId',
    },
    {
      name: 'loadRegistersPageData',
      run: (actorId) => loadRegistersPageData(actorId),
      expectTargetForFinance: true,
      expectTargetForEnquiries: false,
      targetField: 'verifiedMatterId',
    },
  ];

  it.each(LOADER_TABLE)(
    'loader $name redacts matter CDD fields for !cdd:view viewers and preserves Verified for cdd:view',
    async (testCase) => {
      const expectedMatterId = testCase.targetField ? fx[testCase.targetField] : undefined;
      const expectedPriorSummaryMatterId = testCase.priorSummaryField
        ? fx[testCase.priorSummaryField]
        : undefined;

      // 1. Finance (P-000009, !cdd:view)
      const financePayload = await runAsActionActor(
        'P-000009',
        () => testCase.run('P-000009'),
        { roles: ['finance'], mfaVerified: false },
      );
      assertAllMattersAndSummariesRedacted(
        financePayload,
        testCase.expectTargetForFinance
          ? { expectedMatterId, expectedPriorSummaryMatterId }
          : undefined,
      );

      // 2. Enquiries coordinator (P-R812-ENQ, !cdd:view)
      const enquiriesPayload = await runAsActionActor(
        fx.enquiriesActorId,
        () => testCase.run(fx.enquiriesActorId),
        { roles: ['enquiries_coordinator'], mfaVerified: false },
      );
      assertAllMattersAndSummariesRedacted(
        enquiriesPayload,
        testCase.expectTargetForEnquiries
          ? { expectedMatterId, expectedPriorSummaryMatterId }
          : undefined,
      );

      // 3. Admin (P-R812-ADM, !cdd:view) when Finance & Enquiries lack module view permission
      if (testCase.expectTargetForAdminNoCdd) {
        const adminPayload = await runAsActionActor(
          fx.adminActorId,
          () => testCase.run(fx.adminActorId),
          { roles: ['admin'], mfaVerified: true },
        );
        assertAllMattersAndSummariesRedacted(adminPayload, {
          expectedMatterId,
          expectedPriorSummaryMatterId,
        });
      }

      // 4. Partner (P-000001, cdd:view) sees exact Verified values
      const partnerPayload = await runAsActionActor(
        'P-000001',
        () => testCase.run('P-000001'),
        { roles: ['partner'], mfaVerified: false },
      );
      assertTargetShowsVerified(partnerPayload, {
        expectedMatterId,
        expectedMatterAmlStatus: testCase.expectedMatterAmlStatus,
        expectedPriorSummaryMatterId,
        requireSnapshotVerified: testCase.requireSnapshotVerified,
      });
    },
    30_000,
  );

  const ACTION_TABLE: Array<{
    readonly name: string;
    readonly run: () => Promise<unknown>;
    readonly unpermittedActors: Array<{
      readonly actorId: string;
      readonly roles: string[];
      readonly mfaVerified: boolean;
      readonly expectReturned: boolean;
    }>;
    readonly permittedActor: {
      readonly actorId: string;
      readonly roles: string[];
      readonly mfaVerified: boolean;
    };
    readonly targetField?:
      | 'verifiedMatterId'
      | 'closableVerifiedMatterId'
      | 'prospectiveOpenMatterId'
      | 'ethicalWallMatterId';
    readonly priorSummaryField?: 'verifiedMatterId';
    readonly checkPersisted?: boolean;
    readonly afterEachReset?: () => Promise<void>;
  }> = [
    {
      name: 'listRegistersWorkspaceAction',
      run: () => listRegistersWorkspaceAction({ matterId: fx.verifiedMatterId }),
      unpermittedActors: [
        { actorId: 'P-000009', roles: ['finance'], mfaVerified: false, expectReturned: true },
        {
          actorId: 'P-R812-ENQ',
          roles: ['enquiries_coordinator'],
          mfaVerified: false,
          expectReturned: false,
        },
      ],
      permittedActor: { actorId: 'P-000001', roles: ['partner'], mfaVerified: false },
      targetField: 'verifiedMatterId',
    },
    {
      name: 'listClientPriorMattersAction',
      run: () => listClientPriorMattersAction([fx.clientOrgId]),
      unpermittedActors: [
        { actorId: 'P-000009', roles: ['finance'], mfaVerified: false, expectReturned: false },
        {
          actorId: 'P-R812-ENQ',
          roles: ['enquiries_coordinator'],
          mfaVerified: false,
          expectReturned: true,
        },
      ],
      permittedActor: { actorId: 'P-000001', roles: ['partner'], mfaVerified: false },
      priorSummaryField: 'verifiedMatterId',
    },
    {
      name: 'runMatterConflictSearchAction',
      run: () =>
        runMatterConflictSearchAction({
          currentMatterId: fx.verifiedMatterId,
          parties: [
            {
              id: 'party-r812-search',
              name: 'Pembroke Search Target',
              role: 'Client',
              entityType: 'organisation',
              linkedRecordId: fx.clientOrgId,
            },
          ],
        }),
      unpermittedActors: [
        { actorId: 'P-000009', roles: ['finance'], mfaVerified: false, expectReturned: false },
        {
          actorId: 'P-R812-ENQ',
          roles: ['enquiries_coordinator'],
          mfaVerified: false,
          expectReturned: true,
        },
      ],
      permittedActor: { actorId: 'P-000001', roles: ['partner'], mfaVerified: false },
      targetField: 'verifiedMatterId',
    },
    {
      name: 'saveMatterAction',
      run: async () => {
        const matterRepo = new TenantMatterRepository();
        const latest = await matterRepo.getMatterById<Matter>(
          testTenantCtx('P-000001'),
          fx.verifiedMatterId,
          { includeRestricted: true },
        );
        return saveMatterAction(
          {
            title: latest!.title,
            clientId: latest!.clientId,
            practiceAreaId: latest!.practiceAreaId,
            workTypeSubcategoryId: latest!.workTypeSubcategoryId,
            responsiblePartnerId: latest!.responsiblePartnerId,
            supervisingPartnerId: latest!.supervisingPartnerId,
            leadFeeEarnerId: latest!.leadFeeEarnerId,
            teamMemberIds: latest!.teamMemberIds,
            fieldValues: latest!.fieldValues,
          },
          {
            id: fx.verifiedMatterId,
            saveMode: 'submit_cleared',
            expectedRowVersion: latest!.rowVersion ?? 1,
          },
        );
      },
      unpermittedActors: [
        { actorId: 'P-000009', roles: ['finance'], mfaVerified: false, expectReturned: false },
        {
          actorId: 'P-R812-ENQ',
          roles: ['enquiries_coordinator'],
          mfaVerified: false,
          expectReturned: false,
        },
        { actorId: 'P-R812-ADM', roles: ['admin'], mfaVerified: true, expectReturned: true },
      ],
      permittedActor: { actorId: 'P-000001', roles: ['partner'], mfaVerified: false },
      targetField: 'verifiedMatterId',
      checkPersisted: true,
    },
    {
      name: 'recordEngagementLetterSignedAction',
      run: () =>
        recordEngagementLetterSignedAction({
          matterId: fx.verifiedMatterId,
          status: 'Signed & returned',
          note: 'R812 test update',
        }),
      unpermittedActors: [
        { actorId: 'P-000009', roles: ['finance'], mfaVerified: false, expectReturned: false },
        {
          actorId: 'P-R812-ENQ',
          roles: ['enquiries_coordinator'],
          mfaVerified: false,
          expectReturned: false,
        },
        { actorId: 'P-R812-ADM', roles: ['admin'], mfaVerified: true, expectReturned: true },
      ],
      permittedActor: { actorId: 'P-000001', roles: ['partner'], mfaVerified: false },
      targetField: 'verifiedMatterId',
      checkPersisted: true,
    },
    {
      name: 'updateMatterConflictRecordAction',
      run: () =>
        updateMatterConflictRecordAction(
          fx.verifiedMatterId,
          makeConflictRecord('P-R812-ADM', 'Tudur Pritchard', 'Cleared'),
        ),
      unpermittedActors: [
        { actorId: 'P-000009', roles: ['finance'], mfaVerified: false, expectReturned: false },
        {
          actorId: 'P-R812-ENQ',
          roles: ['enquiries_coordinator'],
          mfaVerified: false,
          expectReturned: false,
        },
        { actorId: 'P-R812-ADM', roles: ['admin'], mfaVerified: true, expectReturned: true },
      ],
      permittedActor: { actorId: 'P-000001', roles: ['partner'], mfaVerified: false },
      targetField: 'verifiedMatterId',
      checkPersisted: true,
    },
    {
      name: 'signOffMatterCostsAction',
      run: () => signOffMatterCostsAction(fx.verifiedMatterId, 'R812 partner cost sign-off'),
      unpermittedActors: [
        { actorId: 'P-000009', roles: ['finance'], mfaVerified: false, expectReturned: false },
        {
          actorId: 'P-R812-ENQ',
          roles: ['enquiries_coordinator'],
          mfaVerified: false,
          expectReturned: false,
        },
        { actorId: 'P-R812-ADM', roles: ['admin'], mfaVerified: true, expectReturned: true },
      ],
      permittedActor: { actorId: 'P-000001', roles: ['partner'], mfaVerified: false },
      targetField: 'verifiedMatterId',
      checkPersisted: true,
    },
    {
      name: 'updateMatterLifecycleStatusAction',
      run: () =>
        updateMatterLifecycleStatusAction(fx.closableVerifiedMatterId, 'close', {
          closedAt: fx.closableVerifiedOpenedAt,
          reason: 'R812 closure test',
        }),
      unpermittedActors: [
        { actorId: 'P-000009', roles: ['finance'], mfaVerified: false, expectReturned: false },
        {
          actorId: 'P-R812-ENQ',
          roles: ['enquiries_coordinator'],
          mfaVerified: false,
          expectReturned: false,
        },
        { actorId: 'P-R812-ADM', roles: ['admin'], mfaVerified: true, expectReturned: true },
      ],
      permittedActor: { actorId: 'P-000001', roles: ['partner'], mfaVerified: false },
      targetField: 'closableVerifiedMatterId',
      checkPersisted: true,
      afterEachReset: async () => {
        await runAsActionActor(
          'P-000001',
          async () => {
            await updateMatterLifecycleStatusAction(fx.closableVerifiedMatterId, 'reopen', {
              reason: 'Restore active for subsequent cases',
            });
          },
          { roles: ['partner'], mfaVerified: false },
        );
      },
    },
    {
      name: 'openProspectiveMatterAction',
      run: () => openProspectiveMatterAction(fx.prospectiveOpenMatterId),
      unpermittedActors: [
        { actorId: 'P-000009', roles: ['finance'], mfaVerified: false, expectReturned: false },
        {
          actorId: 'P-R812-ENQ',
          roles: ['enquiries_coordinator'],
          mfaVerified: false,
          expectReturned: false,
        },
        { actorId: 'P-R812-ADM', roles: ['admin'], mfaVerified: true, expectReturned: true },
      ],
      permittedActor: { actorId: 'P-000001', roles: ['partner'], mfaVerified: false },
      targetField: 'prospectiveOpenMatterId',
      checkPersisted: true,
    },
    {
      name: 'liftMatterRestrictionAction',
      run: () =>
        liftMatterRestrictionAction(
          fx.ethicalWallMatterId,
          'ethical_wall',
          'R812 barrier lift check',
        ),
      unpermittedActors: [
        { actorId: 'P-000009', roles: ['finance'], mfaVerified: false, expectReturned: false },
        {
          actorId: 'P-R812-ENQ',
          roles: ['enquiries_coordinator'],
          mfaVerified: false,
          expectReturned: false,
        },
        { actorId: 'P-R812-ADM', roles: ['admin'], mfaVerified: true, expectReturned: true },
      ],
      permittedActor: { actorId: 'P-000003', roles: ['risk_compliance'], mfaVerified: true },
      targetField: 'ethicalWallMatterId',
      checkPersisted: true,
    },
  ];

  it.each(ACTION_TABLE)(
    'action $name redacts matter CDD fields for !cdd:view callers without mutating DB state and returns Verified for cdd:view',
    async (actionCase) => {
      const matterRepo = new TenantMatterRepository();
      const ctxPartner = testTenantCtx('P-000001');
      const expectedMatterId = actionCase.targetField ? fx[actionCase.targetField] : undefined;
      const expectedPriorSummaryMatterId = actionCase.priorSummaryField
        ? fx[actionCase.priorSummaryField]
        : undefined;

      for (const actorSpec of actionCase.unpermittedActors) {
        const res = await runAsActionActor(
          actorSpec.actorId,
          () => actionCase.run(),
          { roles: actorSpec.roles, mfaVerified: actorSpec.mfaVerified },
        );
        if (!actorSpec.expectReturned) {
          const { matters, priorSummaries } = collectMattersAndSummaries(res);
          expect(matters).toHaveLength(0);
          expect(priorSummaries).toHaveLength(0);
        } else {
          assertAllMattersAndSummariesRedacted(res, {
            expectedMatterId,
            expectedPriorSummaryMatterId,
          });
          if (actionCase.checkPersisted && expectedMatterId) {
            const dbMatter = await matterRepo.getMatterById<Matter>(
              ctxPartner,
              expectedMatterId,
              { includeRestricted: true },
            );
            expect(dbMatter?.amlStatus).toBe('Verified');
            expect(dbMatter?.amlCompletedAt).toBeTruthy();
          }
          if (actionCase.afterEachReset) {
            await actionCase.afterEachReset();
          }
        }
      }

      const permittedRes = await runAsActionActor(
        actionCase.permittedActor.actorId,
        () => actionCase.run(),
        {
          roles: actionCase.permittedActor.roles,
          mfaVerified: actionCase.permittedActor.mfaVerified,
        },
      );
      assertTargetShowsVerified(permittedRes, {
        expectedMatterId,
        expectedPriorSummaryMatterId,
      });
      if (actionCase.afterEachReset) {
        await actionCase.afterEachReset();
      }
    },
    30_000,
  );

  it('preserves R747/R792 per-employee-client CDD redaction on matter page and matter form even for cdd:view fee earners', async () => {
    await runAsActionActor(
      'P-000006',
      async () => {
        const detail = await loadMatterDetailPageData('P-000006', fx.employeeClientMatterId);
        expect(detail).not.toBeNull();
        expect(detail?.kind).toBe('profile');
        if (detail && detail.kind === 'profile') {
          expect(detail.canViewClientCdd).toBe(false);
          assertAllMattersAndSummariesRedacted(detail, {
            expectedMatterId: fx.employeeClientMatterId,
          });
        }

        const form = await loadMatterFormPageData('P-000006', {
          editId: fx.employeeClientMatterId,
        });
        expect(form).not.toBeNull();
        const formExtracted = collectMattersAndSummaries(form);
        expect(
          formExtracted.matters.some((m) => m.id === fx.employeeClientMatterId),
        ).toBe(true);
        for (const m of formExtracted.matters) {
          expect(m.amlStatus).toBe(REDACTED_MATTER_CDD_STATUS);
          expect(m.amlCompletedAt).toBeNull();
          const snap = m.fieldValues?.['matterOpeningSnapshot'] as
            | MatterOpeningSnapshot
            | undefined;
          if (snap?.complianceOnboarding) {
            expect(snap.complianceOnboarding.amlStatus).toBe(REDACTED_MATTER_CDD_STATUS);
          }
        }
        const empFormSummary = formExtracted.priorSummaries.find(
          (s) => s.id === fx.employeeClientMatterId,
        );
        expect(empFormSummary).toBeDefined();
        expect(empFormSummary!.amlStatus).toBeUndefined();
        expect('amlStatus' in empFormSummary!).toBe(false);
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );

    await runAsActionActor(
      'P-000003',
      async () => {
        const detail = await loadMatterDetailPageData('P-000003', fx.employeeClientMatterId);
        expect(detail).not.toBeNull();
        expect(detail?.kind).toBe('profile');
        if (detail && detail.kind === 'profile') {
          expect(detail.canViewClientCdd).toBe(true);
          assertTargetShowsVerified(detail, {
            expectedMatterId: fx.employeeClientMatterId,
          });
        }

        const form = await loadMatterFormPageData('P-000003', {
          editId: fx.employeeClientMatterId,
        });
        expect(form).not.toBeNull();
        assertTargetShowsVerified(form, {
          expectedMatterId: fx.employeeClientMatterId,
        });
      },
      { roles: ['risk_compliance'], mfaVerified: true },
    );
  }, 30_000);
});

describe('R816 / R819: Legacy active + CMI incomplete pill & filter parity without exposing CDD outcomes', () => {
  afterEach(() => {
    setTestActorSession(null);
  });

  it('computes isLegacyCmiIncomplete in repository regardless of canViewCdd and sets false when activeStatusIds omitted or empty', async () => {
    const matterRepo = new TenantMatterRepository();
    const ctx = testTenantCtx('P-000001');

    const financePartnerList = await runAsActionActor(
      'P-000001',
      () => loadMattersListPageData('P-000001', { page: 1, pageSize: 10 }),
      { roles: ['partner'], mfaVerified: false },
    );
    const activeStatusIds = financePartnerList.shell.values
      .filter((v) => v.listKey === 'matter_status' && v.systemKey === 'active')
      .map((v) => v.id);
    expect(activeStatusIds.length).toBeGreaterThan(0);

    const omittedIds = await matterRepo.getMatterById<Matter>(ctx, 'M-000002', {
      viewerId: 'P-000009',
      canViewCdd: false,
    });
    expect(omittedIds?.isLegacyCmiIncomplete).toBe(false);

    const emptyIds = await matterRepo.getMatterById<Matter>(ctx, 'M-000002', {
      viewerId: 'P-000009',
      canViewCdd: false,
      activeStatusIds: [],
    });
    expect(emptyIds?.isLegacyCmiIncomplete).toBe(false);

    const withCdd = await matterRepo.getMatterById<Matter>(ctx, 'M-000002', {
      viewerId: 'P-000001',
      canViewCdd: true,
      activeStatusIds,
    });
    expect(withCdd?.isLegacyCmiIncomplete).toBe(true);
    expect(withCdd?.amlStatus).toBe('Pending');

    const afterBoundaryRedaction = redactMatterCddInBrowserPayload(withCdd, false);
    expect(afterBoundaryRedaction?.isLegacyCmiIncomplete).toBe(true);
    expect(afterBoundaryRedaction?.amlStatus).toBe(REDACTED_MATTER_CDD_STATUS);

    const redactedDirect = await matterRepo.getMatterById<Matter>(ctx, 'M-000002', {
      viewerId: 'P-000009',
      canViewCdd: false,
      activeStatusIds,
    });
    expect(redactedDirect?.isLegacyCmiIncomplete).toBe(true);
    expect(redactedDirect?.amlStatus).toBe(REDACTED_MATTER_CDD_STATUS);
    expect(redactedDirect?.amlCompletedAt).toBeNull();
  });

  it('shows CMI incomplete pill & /matters filter parity on M-000002 for Finance while redacting CDD, and Open on gate-opened matters', async () => {
    const financeList = await runAsActionActor(
      'P-000009',
      () => loadMattersListPageData('P-000009', { page: 1, pageSize: 200 }),
      { roles: ['finance'], mfaVerified: false },
    );
    const cmiStatusId = financeList.shell.values.find(
      (v) => v.listKey === 'matter_status' && v.systemKey === 'cmi_incomplete',
    )?.id;
    expect(cmiStatusId).toBeTruthy();

    const filteredFinanceList = await runAsActionActor(
      'P-000009',
      () =>
        loadMattersListPageData('P-000009', {
          statusFilter: cmiStatusId,
          page: 1,
          pageSize: 200,
        }),
      { roles: ['finance'], mfaVerified: false },
    );

    const m2Filtered = filteredFinanceList.matters.find((m) => m.id === 'M-000002');
    expect(m2Filtered).toBeDefined();
    expect(m2Filtered!.isLegacyCmiIncomplete).toBe(true);
    expect(m2Filtered!.amlStatus).toBe(REDACTED_MATTER_CDD_STATUS);
    expect(m2Filtered!.amlCompletedAt).toBeNull();
    expect(isMatterCmiIncompleteStatus(m2Filtered!, filteredFinanceList.shell.values)).toBe(true);
    expect(resolveMatterStatusPill(m2Filtered!, filteredFinanceList.shell.values)).toMatchObject({
      label: 'CMI incomplete',
      tone: 'warning',
      isCmiIncomplete: true,
    });

    // Gate-opened Active verified matter shows 'Open' and is excluded from CMI incomplete filter
    expect(filteredFinanceList.matters.some((m) => m.id === fx.verifiedMatterId)).toBe(false);
    const gateOpenedFinance = financeList.matters.find((m) => m.id === fx.verifiedMatterId);
    expect(gateOpenedFinance).toBeDefined();
    expect(gateOpenedFinance!.isLegacyCmiIncomplete).toBe(false);
    expect(resolveMatterStatusPill(gateOpenedFinance!, financeList.shell.values)).toMatchObject({
      label: 'Open',
      tone: 'positive',
      isCmiIncomplete: false,
    });

    // Detail, Home, Person & Organisation loaders all pass activeStatusIds
    const m2DetailFinance = await runAsActionActor(
      'P-000009',
      () => loadMatterDetailPageData('P-000009', 'M-000002'),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(m2DetailFinance?.kind).toBe('profile');
    if (m2DetailFinance?.kind === 'profile') {
      expect(m2DetailFinance.matter.isLegacyCmiIncomplete).toBe(true);
      expect(m2DetailFinance.matter.amlStatus).toBe(REDACTED_MATTER_CDD_STATUS);
      expect(
        resolveMatterStatusPill(m2DetailFinance.matter, m2DetailFinance.shell.values),
      ).toMatchObject({
        label: 'CMI incomplete',
        tone: 'warning',
        isCmiIncomplete: true,
      });
    }

    const homeFinance = await runAsActionActor(
      'P-000009',
      () => loadHomePageData('P-000009'),
      { roles: ['finance'], mfaVerified: false },
    );
    const m2Home = homeFinance.matters.find((m) => m.id === 'M-000002');
    expect(m2Home?.isLegacyCmiIncomplete).toBe(true);
    expect(m2Home?.amlStatus).toBe(REDACTED_MATTER_CDD_STATUS);

    const personDetailFinance = await runAsActionActor(
      'P-000009',
      () => loadPersonDetailPageData('P-000009', 'P-000002'),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(personDetailFinance && 'matters' in personDetailFinance).toBe(true);
    if (personDetailFinance && 'matters' in personDetailFinance) {
      const m2Person = personDetailFinance.matters.find((m) => m.id === 'M-000002');
      expect(m2Person?.isLegacyCmiIncomplete).toBe(true);
      expect(m2Person?.amlStatus).toBe(REDACTED_MATTER_CDD_STATUS);
    }
  }, 30_000);

  it('R819: contains zero matter_status.* literals in core/src (outside migrations) or src/domain/matterStatusDisplay.ts', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const filesToCheck: string[] = [
      path.join(repoRoot, 'src', 'domain', 'matterStatusDisplay.ts'),
    ];
    const walkCoreSrc = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full.endsWith(path.join('tenancy', 'migrations'))) continue;
          walkCoreSrc(full);
        } else if (entry.isFile() && full.endsWith('.ts')) {
          filesToCheck.push(full);
        }
      }
    };
    walkCoreSrc(path.join(repoRoot, 'core', 'src'));

    const offending: string[] = [];
    const pattern = /['"`]matter_status\.[a-z_]+['"`]/;
    for (const filePath of filesToCheck) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (pattern.test(content)) {
        offending.push(path.relative(repoRoot, filePath));
      }
    }
    expect(offending).toEqual([]);
  });
});
