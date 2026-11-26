import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_REGISTER_TYPES,
  CORE_REQUIRED_SCHEMA_VERSION,
  CORE_TENANT_MIGRATIONS,
  DEFAULT_RBAC_ROLES,
  PERMISSION_REGISTRY,
  TenantCatalogueRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantPartyRepository,
  TenantPostgresPoolManager,
  TenantRegisterRepository,
  createDefaultRbacConfig,
  loadAndValidateTenantConfig,
  resolveTenantFromVerifiedToken,
  type RegisterRecord,
  type TenantContext,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import * as actionsModule from '@/app/actions';
import { resolveMatterIntakeComplianceRows } from '@/components/MatterProfileClient';
import { isActionDenied } from '@/domain/actionResult';
import {
  computeMatterOpeningChecklistProgress,
  type MatterOpeningSnapshot,
} from '@/domain/matterOpeningRecord';
import { resolveMatterStatusPill } from '@/domain/matterStatusDisplay';
import { formatOpeningGateActionError } from '@/domain/openingGate';
import type {
  ChoiceValue,
  ConflictCheckRecordInput,
  Matter,
  Person,
} from '@/domain/types';
import { setActiveTenantConfigForTesting } from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import { loadHomePageData, loadMatterDetailPageData } from '@/server/pageLoaders';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import * as servicesModule from '@/server/services';
import {
  approveSignOff,
  completeClientCddRecord,
  createRecordFromPms,
  createRegisterRecordService,
  discussSignOff,
  getMatterOpeningGateStateRecord,
  getMatterPmsViewBundle,
  openProspectiveMatterRecord,
  overrideMatterOpeningPreconditionRecord,
  recordCddChecklistItemRecord,
  resetAllDemoData,
  saveMatterRecord,
  signOffMatterCostsRecord,
  startOrLoadClientCddRecord,
  transitionRegisterRecordService,
  updateMatterConflictRecord,
  updateMatterLifecycleStatusRecord,
} from '@/server/services';
import {
  auditEntriesForRecord,
  getMatterRepository,
  runAsTestActor,
  setAuditAdapterFailureHookForTesting,
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

const HIGH_RISK_ANSWERS: Record<string, string> = {
  ...BASE_LOW_RISK_ANSWERS,
  highRiskJurisdictionLink: 'Yes',
};

const HIGH_RISK_FOLLOW_UPS: Record<string, string> = {
  highRiskJurisdictionLink: 'Simulated high-risk jurisdiction factor for S1-05 test.',
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
        : status === 'Referred'
          ? 'Referred to risk for review'
          : status === 'Approved'
            ? 'Approved by Risk & Compliance'
            : status === 'Declined'
              ? 'Declined by Risk & Compliance'
              : 'Pending',
    declarationConfirmed: true,
    reviewerMessage:
      status === 'Referred' ? 'Referred to Risk & Compliance for review.' : '',
    lastRunAtDisplay: '24 Nov 2026',
    lastRunById: actorId,
    lastRunByName: actorName,
    submittedAtDisplay: '24 Nov 2026',
    submittedByName: actorName,
    parties: [],
    matches: [],
    runs: [],
    comments: [],
  };
}

const actionActorStack: Array<{
  actorId: string;
  options?: { tenantId?: string; mfaVerified?: boolean; roles?: readonly string[] };
}> = [];

async function runAsActionActor<R>(
  actorId: string,
  fn: () => Promise<R>,
  options?: { tenantId?: string; mfaVerified?: boolean; roles?: readonly string[] },
): Promise<R> {
  actionActorStack.push({ actorId, options });
  setTestActorSession(actorId, options);
  try {
    return await runAsTestActor(actorId, fn, options);
  } finally {
    actionActorStack.pop();
    const prev = actionActorStack[actionActorStack.length - 1];
    if (prev) {
      setTestActorSession(prev.actorId, prev.options);
    } else {
      setTestActorSession(null);
    }
  }
}

function makeVerifiedTenantCtx(
  tenantId: string,
  actorId: string,
  roles: readonly string[],
  mfaVerified = true,
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      name: `Actor ${actorId}`,
      email: `${actorId.toLowerCase()}@${tenantId}.example`,
      tenantId,
      roles,
      mfaVerified,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s105-${tenantId}-${actorId}`,
  });
}

type DynamicAsyncFn = (...args: unknown[]) => Promise<unknown>;

function getDynamicService(name: string): DynamicAsyncFn | undefined {
  return (servicesModule as Record<string, unknown>)[name] as
    | DynamicAsyncFn
    | undefined;
}

function getDynamicAction(name: string): DynamicAsyncFn | undefined {
  return (actionsModule as Record<string, unknown>)[name] as
    | DynamicAsyncFn
    | undefined;
}

describe('S1-05 (ADRs 0039 & 0040): High-risk opening sign-off, transactional work-type gate, engagement stamp & matter numbering', () => {
  const openPoolManagers: TenantPostgresPoolManager[] = [];

  afterEach(async () => {
    setAuditAdapterFailureHookForTesting(null);
    setTestActorSession(null);
    setActiveTenantConfigForTesting(null);
    while (openPoolManagers.length > 0) {
      const mgr = openPoolManagers.pop();
      if (mgr) {
        await mgr.closeAllPools();
      }
    }
  });

  it('1. Fixes runMatterOpeningGate null-governance bug, ignores crafted matterStatusId/matterNumber, enforces post-validation allocation (R741, R744, Owner Answer 7)', async () => {
    expect(Number(CORE_REQUIRED_SCHEMA_VERSION)).toBeGreaterThanOrEqual(26);
    await resetAllDemoData('P-000004', testDataResetContext());

    // Disable enableMatterCostsGovernance in active tenant config so openGovernance === null
    setActiveTenantConfigForTesting(
      {
        ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
        featureFlags: {
          ...(notALawFirmBaseConfig.featureFlags as Record<string, unknown>),
          enableMatterCostsGovernance: false,
        },
      },
      {},
    );

    const matterRepo = new TenantMatterRepository();
    const ctx = testTenantCtx('P-000001');
    const preMatters = await matterRepo.listAllMattersUnfiltered<Matter>(ctx);
    const seqResBefore = await matterRepo.countAllTenantMatterRows(ctx);

    await runAsActionActor(
      'P-000002',
      async () => {
        // (a) Validation failure must consume ZERO matter numbers (Owner Answer 7)
        const invalidSave = await saveMatterRecord(
          {
            title: '',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            matterNumber: 'FAKE-0001',
            matterStatusId: 'matter_status.closed',
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        expect(invalidSave.matter).toBeNull();
        expect(invalidSave.errors?.title).toBeDefined();

        const seqResAfterInvalid = await matterRepo.countAllTenantMatterRows(ctx);
        expect(seqResAfterInvalid.matters).toBe(seqResBefore.matters);

        // (b) Null-governance bug: O-000001 has valid completed CDD; corporate contracts only needs Conflict + CDD.
        //     Crafted matterStatusId ('matter_status.active' / 'matter_status.closed') and crafted matterNumber ('CRAFTED-9999') must be ignored!
        //     Server must open to cmi_incomplete and allocate O-000001's real PEN001-NNNN number cleanly even with openGovernance === null.
        const nullGovOpen = await saveMatterRecord(
          {
            title: 'S1-05 Null Governance & Server Numbering Test',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            matterNumber: 'CRAFTED-9999',
            matterStatusId: 'matter_status.closed',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        expect(nullGovOpen.errors).toBeUndefined();
        expect(nullGovOpen.matter).not.toBeNull();
        expect(nullGovOpen.matter!.matterNumber).toMatch(/^PEN001-\d{4}$/);
        expect(nullGovOpen.matter!.matterNumber).not.toBe('CRAFTED-9999');
        expect(nullGovOpen.matter!.numberSequenceKey).toBe('PEN001');
        expect(nullGovOpen.matter!.numberSequenceValue).toBeGreaterThan(0);
        // Server chooses active (opened via gate with CDD outcome), NOT crafted closed!
        expect(nullGovOpen.matter!.matterStatusId).toBe('matter_status.active');

        // (c) Via saveMatterAction: crafted matterNumber and matterStatusId also ignored
        const actionSaveRes = (await actionsModule.saveMatterAction(
          {
            title: 'S1-05 Action Crafted Bypass Test',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            matterNumber: 'HIJACK-7777',
            matterStatusId: 'matter_status.closed',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          } as never,
          { saveMode: 'submit_cleared' },
        )) as { matter: Matter | null; errors?: Record<string, string> };
        expect(actionSaveRes.errors).toBeUndefined();
        expect(actionSaveRes.matter).not.toBeNull();
        expect(actionSaveRes.matter!.matterNumber).toMatch(/^PEN001-\d{4}$/);
        expect(actionSaveRes.matter!.matterStatusId).toBe('matter_status.active');

        // (d) Rejected validation after a previous allocation must consume ZERO sequence numbers,
        //     whilst Referred conflict submission DOES receive its permanent matter number cleanly (Owner Answer 7).
        const penCountBeforeReferred = Number(nullGovOpen.matter!.numberSequenceValue);
        expect(actionSaveRes.matter!.numberSequenceValue).toBe(penCountBeforeReferred + 1);

        const failedSecond = await saveMatterRecord(
          {
            title: '',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_referred' },
        );
        expect(failedSecond.matter).toBeNull();

        const referredMatterRes = await saveMatterRecord(
          {
            title: 'S1-05 Referred Gets Permanent Number',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            matterNumber: 'SPOOF-1234',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Referred'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_referred' },
        );
        expect(referredMatterRes.errors).toBeUndefined();
        expect(referredMatterRes.matter).not.toBeNull();
        expect(referredMatterRes.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');
        expect(referredMatterRes.matter!.matterNumber).toMatch(/^PEN001-\d{4}$/);
        expect(referredMatterRes.matter!.numberSequenceValue).toBe(penCountBeforeReferred + 2);
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );

    expect(preMatters.some((m) => m.id === 'M-000007' && m.matterNumber === 'BRI001-0001')).toBe(true);
    expect(preMatters.some((m) => m.id === 'M-000010' && m.matterNumber === 'BRI001-0003')).toBe(true);
  }, 30_000);

  it('2. R740, R751, R753, Owner Answers 5 & 6: enforces work-type gate, conflict Cleared/Approved/Referred/Declined, server-stamped engagement, override matrix, and Pro Bono uniformity', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const partyRepo = new TenantPartyRepository();
    const ctxAdmin = testTenantCtx('P-000004');
    const seededPeople = await partyRepo.listAllPeople<Person>(ctxAdmin);
    const baseEmp = seededPeople.find((p) => p.id === 'P-000004')!;
    const pureAdmin: Person = {
      ...baseEmp,
      id: 'P-S105-PURE-ADMIN',
      entraObjectId: undefined,
      firstName: 'Aled',
      surname: 'PureAdmin',
      employeeRoleId: 'employee_role.system_administrator',
      roles: ['admin'],
      appRole: 'admin',
      emails: [
        {
          id: 'em-s105-admin',
          address: 'aled.pureadmin@notalawfirm.example',
          isPrimary: true,
          typeId: null,
        },
      ],
    };
    const pureRc: Person = {
      ...baseEmp,
      id: 'P-S105-PURE-RC',
      entraObjectId: undefined,
      firstName: 'Carys',
      surname: 'PureCompliance',
      employeeRoleId: 'employee_role.compliance_officer',
      roles: ['risk_compliance'],
      appRole: undefined,
      emails: [
        {
          id: 'em-s105-rc',
          address: 'carys.purerc@notalawfirm.example',
          isPrimary: true,
          typeId: null,
        },
      ],
    };
    await partyRepo.putPeople(ctxAdmin, [pureAdmin, pureRc]);

    const openProspectiveAction = getDynamicAction('openProspectiveMatterAction');
    const recordSignedAction = getDynamicAction('recordEngagementLetterSignedAction');
    const overrideAction = getDynamicAction('overrideMatterOpeningPreconditionAction');
    const revokeOverrideAction = getDynamicAction('revokeMatterOpeningOverrideAction');
    const openProspectiveRecord = getDynamicService('openProspectiveMatterRecord');

    expect(typeof openProspectiveAction).toBe('function');
    expect(typeof recordSignedAction).toBe('function');
    expect(typeof overrideAction).toBe('function');
    expect(typeof revokeOverrideAction).toBe('function');
    expect(typeof openProspectiveRecord).toBe('function');

    // Default seeded config has enableMatterCostsGovernance: true -> ensure fee below partner threshold (£25k) or sign off later
    let blockedConveyancingId = '';
    let litigationMatterId = '';
    let fintechMatterId = '';
    let referredMatterId = '';

    await runAsActionActor(
      'P-000002',
      async () => {
        // (a) R753: saveMatterRecord must reject/refuse free-choice Signed / Signed & returned
        const selfCertAttempt = await saveMatterRecord(
          {
            title: 'R753 Self Certification Blocked',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.dispute_resolution',
            workTypeSubcategoryId: 'work_type.dispute_resolution_pre_action_correspondence',
            engagementLetterStatus: 'Signed',
            engagementLetterSignedAt: '2026-11-20T10:00:00.000Z',
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        expect(selfCertAttempt.matter).toBeNull();
        expect(selfCertAttempt.errors?.engagementLetterStatus).toBeDefined();

        // (b) Residential Conveyancing on O-000002 (no CDD): save stays Prospective (blocked by CDD) with permanent HAR001-NNNN number
        const convSave = await saveMatterRecord(
          {
            title: 'S1-05 Residential Conveyancing Unstarted CDD',
            clientId: 'O-000002',
            practiceAreaId: 'work_type.real_estate_and_property',
            workTypeSubcategoryId: 'work_type.real_estate_and_property_residential_conveyancing',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        expect(convSave.errors).toBeUndefined();
        expect(convSave.matter).not.toBeNull();
        expect(convSave.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');
        expect(convSave.matter!.matterNumber).toMatch(/^HAR001-\d{4}$/);
        blockedConveyancingId = convSave.matter!.id;

        // Open matter fails closed with MATTER_OPENING_GATE_BLOCKED
        const blockedOpen = (await openProspectiveAction!(blockedConveyancingId)) as {
          ok: boolean;
          code?: string;
        };
        expect(blockedOpen.ok).toBe(false);
        expect(blockedOpen.code).toBe('MATTER_OPENING_GATE_BLOCKED');

        // (c) Litigation (Pre-action correspondence) with O-000001 (CDD valid) missing Engagement signed -> stays Prospective
        //     EVEN WHEN Pro Bono (`matter_type.pro_bono`, `billing_basis.pro_bono`) is selected (Owner Answer 5)
        const litSave = await saveMatterRecord(
          {
            title: 'S1-05 Pro Bono Litigation Missing Engagement',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.dispute_resolution',
            workTypeSubcategoryId: 'work_type.dispute_resolution_pre_action_correspondence',
            matterTypeId: 'matter_type.pro_bono',
            billingBasisId: 'billing_basis.pro_bono',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        expect(litSave.errors).toBeUndefined();
        expect(litSave.matter).not.toBeNull();
        expect(litSave.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');
        litigationMatterId = litSave.matter!.id;

        // (d) Fintech (O-000002 unstarted CDD, allowCddOverride: true per Owner Answer 6) -> stays Prospective
        const fintechSave = await saveMatterRecord(
          {
            title: 'S1-05 Fintech Overridable CDD',
            clientId: 'O-000002',
            practiceAreaId: 'work_type.technology_and_digital',
            workTypeSubcategoryId: 'work_type.technology_and_digital_fintech_and_payments',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        expect(fintechSave.matter).not.toBeNull();
        expect(fintechSave.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');
        fintechMatterId = fintechSave.matter!.id;

        // (e) Referred conflict matter for R740 test
        const refSave = await saveMatterRecord(
          {
            title: 'S1-05 Referred Non-Overridable Conflict',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Referred'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_referred' },
        );
        referredMatterId = refSave.matter!.id;

        // Fee earner CANNOT override
        const feOverrideRes = (await overrideAction!({
          matterId: litigationMatterId,
          preconditionKey: 'engagement_signed',
          reason: 'Fee earner override attempt should fail RBAC',
        })) as { denied?: boolean; code?: string };
        expect(isActionDenied(feOverrideRes as never)).toBe(true);
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );

    // Pure admin does NOT hold matter:opening_gate:override
    expect(DEFAULT_RBAC_ROLES.admin.permissions).not.toContain('matter:opening_gate:override');
    expect(DEFAULT_RBAC_ROLES.partner.permissions).toContain('matter:opening_gate:override');
    expect(DEFAULT_RBAC_ROLES.managing_partner.permissions).toContain('matter:opening_gate:override');
    await runAsActionActor(
      pureAdmin.id,
      async () => {
        const adminOverrideRes = (await overrideAction!({
          matterId: litigationMatterId,
          preconditionKey: 'engagement_signed',
          reason: 'Admin must not hold opening gate override permission',
        })) as { denied?: boolean; code?: string };
        expect(isActionDenied(adminOverrideRes as never)).toBe(true);
      },
      { roles: ['admin'], mfaVerified: true },
    );

    // Risk & Compliance without partner role cannot override either
    await runAsActionActor(
      pureRc.id,
      async () => {
        const rcOverride = (await overrideAction!({
          matterId: litigationMatterId,
          preconditionKey: 'engagement_signed',
          reason: 'Risk compliance without override permission cannot override',
        })) as { denied?: boolean; code?: string };
        expect(isActionDenied(rcOverride as never)).toBe(true);
      },
      { roles: ['risk_compliance'], mfaVerified: true },
    );

    // Partner checks:
    await runAsActionActor(
      'P-000001',
      async () => {
        // (1) Short reason < 10 chars rejected
        const shortReason = (await overrideAction!({
          matterId: litigationMatterId,
          preconditionKey: 'engagement_signed',
          reason: 'Too short',
        })) as { ok: boolean; code?: string };
        expect(shortReason.ok).toBe(false);

        // (2) Residential Conveyancing refuses CDD override (allowCddOverride: false)
        const convOverride = (await overrideAction!({
          matterId: blockedConveyancingId,
          preconditionKey: 'cdd_complete',
          reason: 'Attempt to override mandatory residential conveyancing CDD',
        })) as { ok: boolean; code?: string };
        expect(convOverride.ok).toBe(false);
        expect(convOverride.code).toBe('OPENING_GATE_OVERRIDE_FORBIDDEN');

        // (3) R740: Referred conflict CANNOT be overridden
        const refOverride = (await overrideAction!({
          matterId: referredMatterId,
          preconditionKey: 'conflict_cleared',
          reason: 'Attempt to override referred conflict check must fail',
        })) as { ok: boolean; code?: string };
        expect(refOverride.ok).toBe(false);
        expect(refOverride.code).toBe('OPENING_GATE_OVERRIDE_FORBIDDEN');

        // (4) Declined conflict CANNOT be overridden
        await runAsActionActor(
          'P-000003',
          () =>
            updateMatterConflictRecord(
              referredMatterId,
              makeConflictRecord('P-000003', 'Bethan Rees', 'Declined'),
              'P-000003',
            ),
          { roles: ['risk_compliance'], mfaVerified: true },
        );
        const declinedOverride = (await overrideAction!({
          matterId: referredMatterId,
          preconditionKey: 'conflict_cleared',
          reason: 'Attempt to override declined conflict check must fail',
        })) as { ok: boolean; code?: string };
        expect(declinedOverride.ok).toBe(false);
        expect(declinedOverride.code).toBe('OPENING_GATE_OVERRIDE_FORBIDDEN');

        // (5) Fintech allows CDD override (Owner Answer 6), stays Prospective until Open matter (R751)
        const fintechOvr = (await overrideAction!({
          matterId: fintechMatterId,
          preconditionKey: 'cdd_complete',
          reason: 'Partner approved urgent Fintech regulatory triage pending CDD upload',
        })) as { ok: boolean; override?: { id: string } };
        expect(fintechOvr.ok).toBe(true);
        const matterRepo = new TenantMatterRepository();
        const fintechStillProsp = await matterRepo.getMatterById<Matter>(
          testTenantCtx('P-000001'),
          fintechMatterId,
        );
        expect(fintechStillProsp?.matterStatusId).toBe('matter_status.prospective_enquiry');

        const fintechOpen = (await openProspectiveAction!(fintechMatterId)) as {
          ok: boolean;
          matter?: Matter;
        };
        expect(fintechOpen.ok).toBe(true);
        expect(fintechOpen.matter?.matterStatusId).toBe('matter_status.active');

        // (6) Override Litigation engagement, revoke it -> still Prospective -> then record server-stamped engagement (R753) -> Open matter!
        const litOvr = (await overrideAction!({
          matterId: litigationMatterId,
          preconditionKey: 'engagement_signed',
          reason: 'Urgent pre-action limitation letter approved by Partner',
        })) as { ok: boolean; override?: { id: string } };
        expect(litOvr.ok).toBe(true);
        const revRes = (await revokeOverrideAction!({
          matterId: litigationMatterId,
          overrideId: litOvr.override!.id,
          reason: 'Wait for client e-signature instead',
        })) as { ok: boolean };
        expect(revRes.ok).toBe(true);

        const openStillBlocked = (await openProspectiveAction!(litigationMatterId)) as {
          ok: boolean;
          code?: string;
        };
        expect(openStillBlocked.ok).toBe(false);
        expect(openStillBlocked.code).toBe('MATTER_OPENING_GATE_BLOCKED');

        // R753: recordEngagementLetterSignedAction stamps server engagementLetterSignedAt & opens on Open matter
        const signRes = (await recordSignedAction!({
          matterId: litigationMatterId,
          status: 'Signed & returned',
          note: 'Received signed copy from client contact.',
        })) as { ok: boolean; matter?: Matter };
        expect(signRes.ok).toBe(true);
        expect(signRes.matter?.engagementLetterStatus).toBe('Signed & returned');
        expect(signRes.matter?.engagementLetterSignedAt).toBeTruthy();

        const litAudit = await auditEntriesForRecord('matter', litigationMatterId);
        expect(
          litAudit.some(
            (e) =>
              e.field?.toLowerCase().includes('engagement') &&
              e.newValue?.includes('Signed & returned'),
          ),
        ).toBe(true);

        const litOpened = (await openProspectiveAction!(litigationMatterId)) as {
          ok: boolean;
          matter?: Matter;
        };
        expect(litOpened.ok).toBe(true);
        expect(litOpened.matter?.matterStatusId).toBe('matter_status.active');
      },
      { roles: ['partner', 'fee_earner'], mfaVerified: false },
    );
  }, 30_000);

  it('3. R741, R742, R744: enforces TX gate on updateMatterConflictRecord (ignoring stale gate) and signOffMatterCostsRecord; keeps cmi_incomplete -> active & closed -> active ungated; exempts createRecordFromPms with audit and allocates fresh number on clash', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const matterRepo = new TenantMatterRepository();

    await runAsActionActor(
      'P-000001',
      async () => {
        // Create prospective Litigation matter on O-000001 with Referred conflict & missing engagement,
        // first below partner cost threshold then raised on draft, and inject stale allowProceed: true
        const refLit = await saveMatterRecord(
          {
            title: 'R742 Conflict Approval Must Re-Check TX Gate',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.dispute_resolution',
            workTypeSubcategoryId: 'work_type.dispute_resolution_pre_action_correspondence',
            matterTypeId: 'matter_type.contentious',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            feeEstimateGbp: 10000,
            agreedFeeCapGbp: 10000,
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Referred'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_referred' },
        );
        expect(refLit.matter).not.toBeNull();
        const mId = refLit.matter!.id;

        const raisedEstimateDraft = await saveMatterRecord(
          {
            ...refLit.matter!,
            feeEstimateGbp: 30000,
            agreedFeeCapGbp: 30000,
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { id: mId, byId: 'P-000001', saveMode: 'draft' },
        );
        expect(raisedEstimateDraft.matter).not.toBeNull();

        // Inject stale matterOpeningGate.allowProceed: true directly in PG to test R742 fix
        const loaded = await matterRepo.getMatterById<Matter>(testTenantCtx('P-000001'), mId);
        await matterRepo.updateMatter(
          testTenantCtx('P-000001'),
          {
            ...loaded!,
            fieldValues: {
              ...(loaded!.fieldValues ?? {}),
              matterOpeningGate: {
                allowProceed: true,
                estimatedFeeGbp: 30000,
                checkedAt: new Date().toISOString(),
              },
            },
          },
          loaded!.rowVersion ?? 1,
        );

        // Path (3): Risk & Compliance approves conflict -> conflict becomes Approved,
        //           yet missing engagement + unapproved costs MUST keep matter Prospective!
        await runAsActionActor(
          'P-000003',
          async () => {
            const approvedConflict = await updateMatterConflictRecord(
              mId,
              makeConflictRecord('P-000003', 'Bethan Rees', 'Approved'),
              'P-000003',
            );
            expect(approvedConflict.matter).not.toBeNull();
            expect(approvedConflict.matter!.conflictCheckRecord?.status).toBe('Approved');
            expect(approvedConflict.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');
          },
          { roles: ['risk_compliance'], mfaVerified: true },
        );

        // Path (4): Partner signs off costs (£30,000) -> engagement still missing -> MUST stay Prospective!
        const signOffStillBlocked = await signOffMatterCostsRecord(mId, 'P-000001', 'Partner costs ok');
        expect(signOffStillBlocked.matter).not.toBeNull();
        expect(signOffStillBlocked.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');

        // Complete engagement stamp -> now Open matter opens cleanly
        const recordSignedAction = getDynamicAction('recordEngagementLetterSignedAction')!;
        await recordSignedAction({ matterId: mId, status: 'Signed & returned' });
        const openNow = (await getDynamicAction('openProspectiveMatterAction')!(mId)) as {
          ok: boolean;
          matter?: Matter;
        };
        expect(openNow.ok).toBe(true);
        expect(openNow.matter!.matterStatusId).toBe('matter_status.active');

        // R741: Moving opened matter active -> cmi_incomplete -> active, and Close -> Reopen (closed -> active) are NOT openings and remain ungated!
        const cmiIncompleteRes = await saveMatterRecord(
          {
            title: openNow.matter!.title,
            clientId: openNow.matter!.clientId,
            practiceAreaId: openNow.matter!.practiceAreaId,
            workTypeSubcategoryId: openNow.matter!.workTypeSubcategoryId,
            matterStatusId: 'matter_status.cmi_incomplete',
            rowVersion: openNow.matter!.rowVersion,
          },
          { id: mId, byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(cmiIncompleteRes.errors).toBeUndefined();
        expect(cmiIncompleteRes.matter?.matterStatusId).toBe('matter_status.cmi_incomplete');

        const activateRes = await saveMatterRecord(
          {
            title: cmiIncompleteRes.matter!.title,
            clientId: cmiIncompleteRes.matter!.clientId,
            practiceAreaId: cmiIncompleteRes.matter!.practiceAreaId,
            workTypeSubcategoryId: cmiIncompleteRes.matter!.workTypeSubcategoryId,
            matterStatusId: 'matter_status.active',
            rowVersion: cmiIncompleteRes.matter!.rowVersion,
          },
          { id: mId, byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(activateRes.errors).toBeUndefined();
        expect(activateRes.matter?.matterStatusId).toBe('matter_status.active');

        const todayYmd = new Date().toISOString().slice(0, 10);
        const closedRes = await updateMatterLifecycleStatusRecord(
          mId,
          'close',
          { closedAt: todayYmd, expectedRowVersion: activateRes.matter?.rowVersion },
          'P-000001',
        );
        expect(closedRes.matter?.matterStatusId).toBe('matter_status.closed');
        const reopenedRes = await updateMatterLifecycleStatusRecord(
          mId,
          'reopen',
          { expectedRowVersion: closedRes.matter?.rowVersion },
          'P-000001',
        );
        expect(reopenedRes.matter?.matterStatusId).toBe('matter_status.active');
      },
      { roles: ['partner', 'fee_earner'], mfaVerified: true },
    );

    // Path (6): PMS import exempt from opening gate, writes required audit entry, and allocates fresh number if pm.matter_code clashes (R742, R744)
    await runAsActionActor(
      'P-000004',
      async () => {
        const pmsBundle = await getMatterPmsViewBundle('M-000001', 'P-000004');
        if (isActionDenied(pmsBundle) || pmsBundle.allUnlinkedPmsMatters.length === 0) {
          throw new Error('Expected at least one unlinked PMS matter.');
        }
        const targetCode = pmsBundle.allUnlinkedPmsMatters[0]!.matter_code;
        // First create a colliding regular matter with a number matching one or import first then create clash test:
        // Put targetCode as matterNumber on an existing matter in PostgreSQL so createRecordFromPms sees a clash!
        const clashMatter = await matterRepo.getMatterById<Matter>(testTenantCtx('P-000004'), 'M-000002');
        const ctxDirect = testTenantCtx('P-000004');
        await matterRepo.withTenantTransaction(ctxDirect, async (tx) => {
          await tx.query(
            `UPDATE public.matters SET matter_number = $3 WHERE tenant_id = $1 AND id = $2`,
            [ctxDirect.tenantId, clashMatter!.id, targetCode],
          );
        });

        const pmsRes = await createRecordFromPms('matter', targetCode, 'P-000004', {
          mfaVerified: true,
        });
        expect(pmsRes.ok).toBe(true);
        expect(pmsRes.createdId).toBeDefined();
        const imported = await matterRepo.getMatterById<Matter>(ctxDirect, pmsRes.createdId!);
        expect(imported).not.toBeNull();
        // Allocated a fresh non-clashing matter number
        expect(imported!.matterNumber).not.toBe(targetCode);
        const audits = await auditEntriesForRecord('matter', imported!.id);
        expect(
          audits.some((a) =>
            (a.newValue ?? '').includes('Opened by PMS import; opening gate not applied') ||
            (a.reason ?? '').includes('Opened by PMS import; opening gate not applied'),
          ),
        ).toBe(true);
      },
      {
        roles: ['admin', 'finance', 'fee_earner', 'partner'],
        mfaVerified: true,
      },
    );
  }, 30_000);

  it('4. ADR 0039, R749, R752, R756, R757: enforces high_risk_opening two-stage distinct approvers, allowAdminBypass=false, auto-withdrawal on down-score/delete (never approved), risk_rating.sensitive exclusion, and Home write-off approver alignment', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const partyRepo = new TenantPartyRepository();
    const matterRepo = new TenantMatterRepository();
    const regRepo = new TenantRegisterRepository();
    const ctxAdmin = testTenantCtx('P-000004');

    const seededPeople = await partyRepo.listAllPeople<Person>(ctxAdmin);
    const baseEmp = seededPeople.find((p) => p.id === 'P-000004')!;
    const pureAdmin: Person = {
      ...baseEmp,
      id: 'P-S105-ADMIN-NO-ROLES',
      entraObjectId: undefined,
      firstName: 'Huw',
      surname: 'AdminNoStageRole',
      employeeRoleId: 'employee_role.system_administrator',
      roles: ['admin'],
      appRole: 'admin',
      emails: [
        {
          id: 'em-s105-admin2',
          address: 'huw.onlyadmin@notalawfirm.example',
          isPrimary: true,
          typeId: null,
        },
      ],
    };
    const supervisorPerson: Person = {
      ...baseEmp,
      id: 'P-S105-SUPERVISOR',
      entraObjectId: undefined,
      firstName: 'Sian',
      surname: 'SupervisorOnly',
      employeeRoleId: 'employee_role.supervisor',
      roles: ['supervisor'],
      appRole: 'team_lead',
      emails: [
        {
          id: 'em-s105-sup',
          address: 'sian.sup@notalawfirm.example',
          isPrimary: true,
          typeId: null,
        },
      ],
    };
    await partyRepo.putPeople(ctxAdmin, [pureAdmin, supervisorPerson]);

    let hroMatterId = '';
    let hroRecordId = '';

    // Fee earner Dafydd (P-000002) submits a High-Risk corporate contracts matter on O-000001 (CDD valid)
    await runAsActionActor(
      'P-000002',
      async () => {
        const highRiskSave = await saveMatterRecord(
          {
            title: 'S1-05 High Risk Jurisdictional Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: {
              answers: HIGH_RISK_ANSWERS,
              followUps: HIGH_RISK_FOLLOW_UPS,
            },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        expect(highRiskSave.errors).toBeUndefined();
        expect(highRiskSave.matter).not.toBeNull();
        expect(highRiskSave.matter!.riskRatingId).toBe('risk_rating.high');
        expect(highRiskSave.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');
        expect(highRiskSave.matter!.matterNumber).toMatch(/^PEN001-\d{4}$/);
        hroMatterId = highRiskSave.matter!.id;
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );

    const hroList = await regRepo.listVisibleRegisterRecords(ctxAdmin, 'P-000004', {
      includeRestricted: true,
      registerTypeKey: 'high_risk_opening',
      matterId: hroMatterId,
    });
    expect(hroList).toHaveLength(1);
    expect(hroList[0]!.status).toBe('pending_partner');
    hroRecordId = hroList[0]!.id;

    // R756 & allowAdminBypass: false -> pureAdmin cannot partner_approve
    await runAsActionActor(
      pureAdmin.id,
      async () => {
        const adminTry = await transitionRegisterRecordService(
          { recordId: hroRecordId, transitionKey: 'partner_approve' },
          pureAdmin.id,
        );
        expect(adminTry.ok).toBe(false);
        if (!adminTry.ok) {
          expect(adminTry.code).toBe('REGISTER_APPROVER_MISMATCH');
        }
      },
      { roles: ['admin'], mfaVerified: true },
    );

    // R757: Home approveSignOff MUST refuse high_risk_opening records!
    await runAsActionActor(
      'P-000001',
      async () => {
        const homeBypassAttempt = await approveSignOff(hroRecordId, 'P-000001');
        expect(isActionDenied(homeBypassAttempt as never)).toBe(true);
      },
      { roles: ['partner'], mfaVerified: false },
    );

    // R752: Re-scoring down to Low BEFORE opening automatically transitions pending_partner -> withdrawn!
    await runAsActionActor(
      'P-000002',
      async () => {
        const downscoreRes = await saveMatterRecord(
          {
            title: 'S1-05 Downscored Below High Before Opening',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            rowVersion: (await matterRepo.getMatterById<Matter>(ctxAdmin, hroMatterId))!.rowVersion,
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { id: hroMatterId, byId: 'P-000002', saveMode: 'draft' },
        );
        expect(downscoreRes.errors).toBeUndefined();
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const withdrawnRec = await regRepo.getRegisterRecordById(ctxAdmin, hroRecordId, {
      includeRestricted: true,
    });
    expect(withdrawnRec?.status).toBe('withdrawn');

    // Re-score back up to High -> starts a FRESH pending_partner cycle
    await runAsActionActor(
      'P-000002',
      async () => {
        const currentM = await matterRepo.getMatterById<Matter>(ctxAdmin, hroMatterId);
        const rescoreHigh = await saveMatterRecord(
          {
            title: 'S1-05 Rescored Back To High',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            rowVersion: currentM!.rowVersion,
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: {
              answers: HIGH_RISK_ANSWERS,
              followUps: HIGH_RISK_FOLLOW_UPS,
            },
          },
          { id: hroMatterId, byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        expect(rescoreHigh.matter?.matterStatusId).toBe('matter_status.prospective_enquiry');
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );

    const hroCycles = await regRepo.listVisibleRegisterRecords(ctxAdmin, 'P-000004', {
      includeRestricted: true,
      registerTypeKey: 'high_risk_opening',
      matterId: hroMatterId,
    });
    expect(hroCycles).toHaveLength(2);
    const activeHro = hroCycles.find((r) => r.status === 'pending_partner')!;
    expect(activeHro).toBeDefined();

    // Dual-role Bethan (P-000003: partner + risk_compliance) runs stage 1 partner_approve, then CANNOT run stage 2 compliance_approve!
    await runAsActionActor(
      'P-000003',
      async () => {
        const step1 = await transitionRegisterRecordService(
          { recordId: activeHro.id, transitionKey: 'partner_approve', comment: 'Partner stage approved.' },
          'P-000003',
        );
        expect(step1.ok).toBe(true);
        if (step1.ok) {
          expect(step1.record.status).toBe('pending_compliance');
        }

        const samePersonStep2 = await transitionRegisterRecordService(
          { recordId: activeHro.id, transitionKey: 'compliance_approve', comment: 'Self step 2 attempt' },
          'P-000003',
        );
        expect(samePersonStep2.ok).toBe(false);
        if (!samePersonStep2.ok) {
          expect(samePersonStep2.code).toBe('REGISTER_DISTINCT_APPROVER_REQUIRED');
        }
      },
      { roles: ['risk_compliance', 'partner', 'fee_earner'], mfaVerified: false },
    );

    // R763: High-risk matter elevates O-000001's derived CDD tier to 'high'; upgrade & complete O-000001 CDD at High before Stage 2 opens the matter.
    await runAsActionActor(
      'P-000001',
      async () => {
        const o1Upgraded = await startOrLoadClientCddRecord(
          {
            subjectType: 'organisation',
            subjectId: 'O-000001',
            upgradeToHighRisk: true,
            reason: 'High-risk jurisdictional matter requires High-tier CDD',
          },
          'P-000001',
        );
        expect(o1Upgraded.ok).toBe(true);
        if (o1Upgraded.ok && o1Upgraded.summary.record) {
          for (const item of o1Upgraded.summary.checklistItems) {
            if (item.status !== 'recorded') {
              const recRes = await recordCddChecklistItemRecord(
                {
                  recordId: o1Upgraded.summary.record.id,
                  itemKey: item.itemKey,
                  status: 'recorded',
                  note: 'Verified Enhanced/High CDD',
                },
                'P-000001',
              );
              expect(recRes.ok).toBe(true);
            }
          }
          const compRes = await completeClientCddRecord(
            { recordId: o1Upgraded.summary.record.id },
            'P-000001',
          );
          expect(compRes.ok).toBe(true);
        }
      },
      { roles: ['partner'], mfaVerified: false },
    );

    // Different Risk & Compliance user Rita (P-000049) executes compliance_approve -> transitions matter to active!
    await runAsActionActor(
      'P-000049',
      async () => {
        const step2 = await transitionRegisterRecordService(
          { recordId: activeHro.id, transitionKey: 'compliance_approve', comment: 'Independent Risk & Compliance sign-off.' },
          'P-000049',
        );
        expect(step2.ok).toBe(true);
        if (step2.ok) {
          expect(step2.record.status).toBe('approved');
        }
      },
      { roles: ['risk_compliance', 'partner'], mfaVerified: false },
    );
    const openedHroMatter = await matterRepo.getMatterById<Matter>(ctxAdmin, hroMatterId);
    expect(openedHroMatter?.matterStatusId).toBe('matter_status.active');

    // Approved HRO record is NEVER withdrawn by deleteMatterById (whereas pending_partner IS withdrawn on delete)
    let pendingDeleteMatterId = '';
    await runAsActionActor(
      'P-000002',
      async () => {
        const resDel = await saveMatterRecord(
          {
            title: 'S1-05 Prospective High Risk To Be Deleted',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: {
              answers: HIGH_RISK_ANSWERS,
              followUps: HIGH_RISK_FOLLOW_UPS,
            },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        pendingDeleteMatterId = resDel.matter!.id;
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );
    await matterRepo.deleteMatterById(ctxAdmin, pendingDeleteMatterId);
    const afterDelHro = await regRepo.listVisibleRegisterRecords(ctxAdmin, 'P-000004', {
      includeRestricted: true,
      registerTypeKey: 'high_risk_opening',
      matterId: pendingDeleteMatterId,
    });
    expect(afterDelHro[0]?.status).toBe('withdrawn');

    // R757: Home write-off sign_off alignment: Risk & Compliance and Supervisor CAN approve write_off via approveSignOff/discussSignOff
    await runAsActionActor(
      'P-000002',
      async () => {
        const createdSo1 = await createRegisterRecordService(
          {
            registerTypeKey: 'sign_off',
            title: 'Write-off for Compliance Home test',
            matterId: hroMatterId,
            fieldValues: {
              signOffKind: 'write_off',
              matterNumber: openedHroMatter!.matterNumber,
              amountGbp: 250,
            },
          },
          'P-000002',
        );
        expect(createdSo1.ok).toBe(true);
        const createdSo2 = await createRegisterRecordService(
          {
            registerTypeKey: 'sign_off',
            title: 'Write-off for Supervisor Home test',
            matterId: hroMatterId,
            fieldValues: {
              signOffKind: 'write_off',
              matterNumber: openedHroMatter!.matterNumber,
              amountGbp: 300,
            },
          },
          'P-000002',
        );
        expect(createdSo2.ok).toBe(true);

        if (createdSo1.ok && createdSo2.ok) {
          // Risk & Compliance discusses then Supervisor approves via Home actions
          await runAsActionActor(
            'P-000049',
            async () => {
              const disc = await discussSignOff(
                createdSo1.record.id,
                'Compliance queried disbursement line before approval.',
                'P-000049',
              );
              expect(disc).toEqual({ ok: true });
            },
            { roles: ['risk_compliance'], mfaVerified: false },
          );
          await runAsActionActor(
            supervisorPerson.id,
            async () => {
              const appr = await approveSignOff(createdSo2.record.id, supervisorPerson.id);
              expect(appr).toEqual({ ok: true });
            },
            { roles: ['supervisor'], mfaVerified: false },
          );
        }
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );

    expect(CORE_REGISTER_TYPES.high_risk_opening.approvalRules?.allowAdminBypass).toBe(false);

    // R749: risk_rating.sensitive maps to high CDD tier in S1-04 and NEVER triggers high_risk_opening
    const { isHighOrCriticalRiskRating } = await import('@/domain/openingGate');
    expect(isHighOrCriticalRiskRating('risk_rating.sensitive')).toBe(false);
    expect(isHighOrCriticalRiskRating('risk_rating.medium')).toBe(false);
    expect(isHighOrCriticalRiskRating('risk_rating.high')).toBe(true);
    expect(isHighOrCriticalRiskRating('risk_rating.critical')).toBe(true);
  }, 30_000);

  it('5. Concurrency races (Promise.all), B6 monotonicity across pattern change/rollback/reset, and Rule 9 two-tenant isolation', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'tenant-alpha', environment: 'test' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      ],
    });
    const poolManager = new TenantPostgresPoolManager();
    openPoolManagers.push(poolManager);
    const runner = new TenantMigrationRunner();
    const ctxAlpha = makeVerifiedTenantCtx('tenant-alpha', 'P-000004', [
      'admin',
      'partner',
      'fee_earner',
      'risk_compliance',
    ]);
    const ctxBravo = makeVerifiedTenantCtx('tenant-bravo', 'P-000004', [
      'admin',
      'partner',
      'fee_earner',
      'risk_compliance',
    ]);
    await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
    await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);

    const alphaCfg = loadAndValidateTenantConfig(
      notALawFirmBaseConfig,
      { tenantId: 'tenant-alpha', environment: 'test' },
      'test',
      'multi_tenant',
    );
    const bravoCfg = loadAndValidateTenantConfig(
      notALawFirmBaseConfig,
      { tenantId: 'tenant-bravo', environment: 'test' },
      'test',
      'multi_tenant',
    );
    await importFirmStoreModulesToPostgres({
      ctx: ctxAlpha,
      tenantConfig: alphaCfg,
      clearFirst: true,
      store: createSeedStore(new Date()),
    });
    await importFirmStoreModulesToPostgres({
      ctx: ctxBravo,
      tenantConfig: bravoCfg,
      clearFirst: true,
      store: createSeedStore(new Date()),
    });

    const catRepo = new TenantCatalogueRepository({ poolManager });
    const matterRepo = new TenantMatterRepository({ poolManager });

    // B6 Monotonicity across configurable pattern changes and demo reset:
    await matterRepo.clearTenantData(ctxAlpha, { resetMatterNumberSequences: true });
    const alloc1 = await matterRepo.allocateNextMatterNumberWithConfig(
      ctxAlpha,
      {
        pattern: 'MAT-{YYYY}-{SEQ:4}',
        sequenceScope: 'year',
        emptyTokenFallback: 'MAT',
      },
      {
        clientRefPrefix: 'PEN001',
        nowDate: new Date('2026-11-25T10:00:00.000Z'),
      },
    );
    expect(alloc1.matterNumber).toBe('MAT-2026-0001');

    // Clear tenant data without resetting sequences -> sequence does NOT go backwards
    await matterRepo.clearTenantData(ctxAlpha);
    const alloc2 = await matterRepo.allocateNextMatterNumberWithConfig(
      ctxAlpha,
      {
        pattern: 'FIRM-{YYYY}-{SEQ:5}',
        sequenceScope: 'year',
        emptyTokenFallback: 'MAT',
      },
      {
        clientRefPrefix: 'PEN001',
        nowDate: new Date('2026-11-25T10:01:00.000Z'),
      },
    );
    expect(alloc2.sequenceValue).toBe(2);
    expect(alloc2.matterNumber).toBe('FIRM-2026-00002');

    // Forged tenant claims rejected
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000001',
          tenantId: 'tenant-alpha',
          name: 'Rhian Morgan',
          email: 'r@tenant-alpha.example',
          roles: ['partner'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged-s105',
        untrustedRequestTenantOverride: 'tenant-bravo',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);

    // saveMatterNumberingConfigAction requires MFA + saves per-tenant without touching Bravo
    const saveNumAction = getDynamicAction('saveMatterNumberingConfigAction');
    expect(typeof saveNumAction).toBe('function');
    const alphaRaw = {
      ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
      tenantId: 'tenant-alpha',
    };
    setActiveTenantConfigForTesting(alphaRaw, { tenantId: 'tenant-alpha' });
    await runAsActionActor(
      'P-000004',
      async () => {
        const noMfaNum = (await saveNumAction!(
          {
            pattern: 'A-{YYYY}-{SEQ:4}',
            sequenceScope: 'year',
            emptyTokenFallback: 'MAT',
          },
          'Update without MFA should fail',
        )) as { ok: boolean; code?: string };
        expect(noMfaNum.ok).toBe(false);
        expect(noMfaNum.code).toBe('MFA_REQUIRED');
      },
      { tenantId: 'tenant-alpha', roles: ['admin'], mfaVerified: false },
    );
    await runAsActionActor(
      'P-000004',
      async () => {
        const withMfaNum = (await saveNumAction!(
          {
            pattern: 'A-{YYYY}-{SEQ:4}',
            sequenceScope: 'year',
            emptyTokenFallback: 'MAT',
          },
          'Configure year-based firm numbering',
        )) as { ok: boolean };
        expect(withMfaNum.ok).toBe(true);
      },
      { tenantId: 'tenant-alpha', roles: ['admin'], mfaVerified: true },
    );
    expect(await catRepo.getMatterNumberingConfig(ctxBravo)).toBeNull();

    // Concurrent override + revoke race on single-tenant default DB
    await resetAllDemoData('P-000004', testDataResetContext());
    setActiveTenantConfigForTesting(null);
    const overrideAction = getDynamicAction('overrideMatterOpeningPreconditionAction')!;

    let raceMatterId = '';
    await runAsActionActor(
      'P-000002',
      async () => {
        const res = await saveMatterRecord(
          {
            title: 'S1-05 Concurrent Override & Open Race',
            clientId: 'O-000002',
            practiceAreaId: 'work_type.technology_and_digital',
            workTypeSubcategoryId: 'work_type.technology_and_digital_fintech_and_payments',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        raceMatterId = res.matter!.id;
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );

    // Concurrent duplicate override attempts by two partners via AsyncLocalStorage-isolated actors:
    // at most one active override row can succeed
    const [ovrA, ovrB] = await Promise.all([
      runAsTestActor(
        'P-000001',
        () =>
          overrideMatterOpeningPreconditionRecord(
            {
              matterId: raceMatterId,
              preconditionKey: 'cdd_complete',
              reason: 'Partner 1 concurrent override request',
            },
            'P-000001',
          ),
        { roles: ['partner'], mfaVerified: false },
      ) as Promise<{ ok: boolean; override?: { id: string } }>,
      runAsTestActor(
        'P-000005',
        () =>
          overrideMatterOpeningPreconditionRecord(
            {
              matterId: raceMatterId,
              preconditionKey: 'cdd_complete',
              reason: 'Partner 2 concurrent override request',
            },
            'P-000005',
          ),
        { roles: ['partner'], mfaVerified: false },
      ) as Promise<{ ok: boolean; override?: { id: string } }>,
    ]);
    const activeCount = (await matterRepo.listOpeningGateOverridesForMatter(
      testTenantCtx('P-000001'),
      raceMatterId,
      { activeOnly: true },
    )).length;
    expect(activeCount).toBe(1);
    expect([ovrA.ok, ovrB.ok].filter(Boolean)).toHaveLength(1);

    // Concurrent Open matter calls: both either see opened or cleanly succeed/fail without double allocation or corruption
    const [openA, openB] = await Promise.all([
      runAsTestActor(
        'P-000001',
        () => openProspectiveMatterRecord(raceMatterId, 'P-000001'),
        {
          roles: ['partner'],
          mfaVerified: false,
        },
      ),
      runAsTestActor(
        'P-000002',
        () => openProspectiveMatterRecord(raceMatterId, 'P-000002'),
        {
          roles: ['fee_earner'],
          mfaVerified: false,
        },
      ),
    ]);
    expect([
      (openA as { ok?: boolean }).ok,
      (openB as { ok?: boolean }).ok,
    ].some(Boolean)).toBe(true);
    const raceMatterFinal = await matterRepo.getMatterById<Matter>(
      testTenantCtx('P-000001'),
      raceMatterId,
    );
    expect(raceMatterFinal?.matterStatusId).toBe('matter_status.active');

    // Forged tenant session mismatch throws TENANCY_FORGERY_DETECTED;
    // valid Bravo session refuses tampered Alpha matter ID against Bravo DB cleanly.
    await expect(
      runAsActionActor(
        'P-000001',
        () =>
          overrideAction({
            matterId: raceMatterId,
            preconditionKey: 'cdd_complete',
            reason: 'Forged tenant override attempt must throw',
          }),
        { tenantId: 'tenant-bravo', roles: ['partner'], mfaVerified: true },
      ),
    ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);

    const bravoRaw = {
      ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
      tenantId: 'tenant-bravo',
    };
    setActiveTenantConfigForTesting(bravoRaw, { tenantId: 'tenant-bravo' });
    const crossOvr = await runAsActionActor(
      'P-000001',
      () =>
        overrideAction({
          matterId: raceMatterId,
          preconditionKey: 'cdd_complete',
          reason: 'Cross-tenant tampered matter ID must be refused',
        }),
      { tenantId: 'tenant-bravo', roles: ['partner'], mfaVerified: true },
    );
    expect((crossOvr as { ok?: boolean }).ok).toBe(false);
  }, 45_000);

  it('6. R761a (Blocking): openProspectiveMatterAction refuses Referred, Declined, Not started without override, and DRAFT matters under firm defaults (allows Not started only with conflict override)', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const openAction = getDynamicAction('openProspectiveMatterAction')!;
    const overrideAction = getDynamicAction('overrideMatterOpeningPreconditionAction')!;
    const matterRepo = getMatterRepository();

    await runAsActionActor(
      'P-000001',
      async () => {
        // Ensure O-000001 has valid CDD (just in case)
        const cddStart = await startOrLoadClientCddRecord(
          { subjectType: 'organisation', subjectId: 'O-000001', createIfMissing: true },
          'P-000001',
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
                  note: 'Verified for R761 test',
                },
                'P-000001',
              );
            }
          }
          await completeClientCddRecord({ recordId: cddStart.summary.record.id }, 'P-000001');
        }

        // Work type inheriting defaults.openingGate (allowConflictOverride === true)
        const mkParams = {
          clientId: 'O-000001',
          practiceAreaId: 'work_type.general_practice',
          workTypeSubcategoryId: 'work_type.general_practice_advisory',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: 'P-000002',
          teamMemberIds: ['P-000001', 'P-000002'],
          riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
        };

        // 1) Referred conflict -> refused even when partner conflict overrides are enabled
        const refSave = await saveMatterRecord(
          {
            ...mkParams,
            title: 'R761a Referred Under Default WorkType',
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Referred'),
          },
          { byId: 'P-000001', saveMode: 'submit_referred' },
        );
        expect(refSave.matter).not.toBeNull();
        const refId = refSave.matter!.id;
        const refOpenRes = (await openAction(refId)) as { ok: boolean; code?: string };
        expect(refOpenRes.ok).toBe(false);

        // 2) Declined conflict -> refused
        await runAsActionActor(
          'P-000003',
          async () => {
            await updateMatterConflictRecord(
              refId,
              makeConflictRecord('P-000003', 'Bethan Rees', 'Declined'),
              'P-000003',
            );
          },
          { roles: ['risk_compliance'], mfaVerified: false },
        );
        const decOpenRes = (await openAction(refId)) as { ok: boolean; code?: string };
        expect(decOpenRes.ok).toBe(false);

        // 3) Not started conflict -> refused without override; succeeds with conflict_cleared override
        const notStartedSave = await saveMatterRecord(
          {
            ...mkParams,
            title: 'R761a Not Started Conflict',
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Referred'),
          },
          { byId: 'P-000001', saveMode: 'submit_referred' },
        );
        expect(notStartedSave.matter).not.toBeNull();
        const nsId = notStartedSave.matter!.id;
        await matterRepo.updateMatter(
          testTenantCtx('P-000001'),
          {
            ...notStartedSave.matter!,
            conflictCheckStatus: 'Not started',
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Not started'),
          },
          notStartedSave.matter!.rowVersion ?? 1,
        );
        const nsBlocked = (await openAction(nsId)) as { ok: boolean };
        expect(nsBlocked.ok).toBe(false);

        const nsOvr = (await overrideAction({
          matterId: nsId,
          preconditionKey: 'conflict_cleared',
          reason: 'Partner emergency conflict override for Not started matter',
        })) as { ok: boolean };
        expect(nsOvr.ok).toBe(true);
        const nsOpened = (await openAction(nsId)) as { ok: boolean; matter?: Matter };
        expect(nsOpened.ok).toBe(true);
        expect(nsOpened.matter?.matterStatusId).toBe('matter_status.active');

        // 4) DRAFT matter -> refused without allocating a permanent number
        const draftSave = await saveMatterRecord(
          {
            ...mkParams,
            title: 'R761a Unsubmitted Draft',
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
          },
          { byId: 'P-000001', saveMode: 'draft' },
        );
        expect(draftSave.matter?.matterNumber).toMatch(/^DRAFT/);
        const draftId = draftSave.matter!.id;
        const draftOpen = (await openAction(draftId)) as { ok: boolean; message?: string };
        expect(draftOpen.ok).toBe(false);
        expect(draftOpen.message).toMatch(/Save and submit this matter before opening it/i);
        const draftAfter = await matterRepo.getMatterById<Matter>(
          testTenantCtx('P-000001'),
          draftId,
        );
        expect(draftAfter?.matterNumber).toMatch(/^DRAFT/);
      },
      { roles: ['partner', 'admin'], mfaVerified: true },
    );
  }, 30_000);

  it('7. R761b (Blocking): signOffMatterCostsRecord refuses opening a prospective matter when conflict is Not started, Referred, or Declined even when conflict overrides are permitted', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const signOffAction = getDynamicAction('signOffMatterCostsAction')!;
    const matterRepo = getMatterRepository();

    await runAsActionActor(
      'P-000001',
      async () => {
        for (const conflictStatus of ['Not started', 'Referred', 'Declined'] as const) {
          const base = await saveMatterRecord(
            {
              title: `R761b SignOff Conflict ${conflictStatus}`,
              clientId: 'O-000001',
              practiceAreaId: 'work_type.general_practice',
              workTypeSubcategoryId: 'work_type.general_practice_advisory',
              responsiblePartnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              leadFeeEarnerId: 'P-000002',
              teamMemberIds: ['P-000001', 'P-000002'],
              feeEstimateGbp: 10000,
              agreedFeeCapGbp: 10000,
              conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Referred'),
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
            },
            { byId: 'P-000001', saveMode: 'submit_referred' },
          );
          expect(base.matter).not.toBeNull();
          const raised = await saveMatterRecord(
            {
              ...base.matter!,
              feeEstimateGbp: 35000,
              agreedFeeCapGbp: 35000,
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
            },
            { id: base.matter!.id, byId: 'P-000001', saveMode: 'draft' },
          );
          expect(raised.matter).not.toBeNull();
          if (conflictStatus !== 'Referred') {
            await matterRepo.updateMatter(
              testTenantCtx('P-000001'),
              {
                ...raised.matter!,
                conflictCheckStatus: conflictStatus,
                conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', conflictStatus),
              },
              raised.matter!.rowVersion ?? 1,
            );
          }
          const signRes = (await signOffAction(
            raised.matter!.id,
            `Partner costs sign-off on ${conflictStatus} matter`,
          )) as { matter: Matter | null };
          expect(signRes.matter).not.toBeNull();
          expect(signRes.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');
        }
      },
      { roles: ['partner'], mfaVerified: false },
    );
  }, 30_000);

  it('8. R762 (Blocking): updateMatterConflictRecord and signOffMatterCostsRecord abort with MATTER_CONCURRENCY_CONFLICT when matter rowVersion changes before FOR UPDATE lock', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const matterRepo = getMatterRepository();

    await runAsActionActor(
      'P-000001',
      async () => {
        // Case A: updateMatterConflictRecord race
        const conflictRaceSave = await saveMatterRecord(
          {
            title: 'R762 Conflict Race Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Referred'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_referred' },
        );
        expect(conflictRaceSave.matter).not.toBeNull();
        const conflictRaceId = conflictRaceSave.matter!.id;

        // Case B: signOffMatterCostsRecord race (Prospective Corporate matter with Cleared conflict, below threshold -> raised on draft; concurrent risk raise to High must abort)
        const signOffBase = await saveMatterRecord(
          {
            title: 'R762 SignOff Race Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.dispute_resolution',
            workTypeSubcategoryId: 'work_type.dispute_resolution_pre_action_correspondence',
            matterTypeId: 'matter_type.contentious',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            feeEstimateGbp: 10000,
            agreedFeeCapGbp: 10000,
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(signOffBase.matter).not.toBeNull();
        const signOffRaceSave = await saveMatterRecord(
          {
            ...signOffBase.matter!,
            feeEstimateGbp: 35000,
            agreedFeeCapGbp: 35000,
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { id: signOffBase.matter!.id, byId: 'P-000001', saveMode: 'draft' },
        );
        expect(signOffRaceSave.matter).not.toBeNull();
        const signOffRaceId = signOffRaceSave.matter!.id;

        const origWithTx = matterRepo.withTenantTransaction.bind(matterRepo);
        try {
          let injectedConflictRace = false;
          matterRepo.withTenantTransaction = (async (txCtx, fn, opts) => {
            if (!injectedConflictRace && opts === undefined && txCtx.tenantId === 'not-a-law-firm') {
              const current = await matterRepo.getMatterById<Matter>(txCtx, conflictRaceId, {
                includeRestricted: true,
              });
              if (current && current.riskRatingId !== 'risk_rating.high') {
                injectedConflictRace = true;
                await matterRepo.updateMatter(
                  txCtx,
                  { ...current, riskRatingId: 'risk_rating.high' },
                  current.rowVersion ?? 1,
                );
              }
            }
            return origWithTx(txCtx, fn, opts);
          }) as typeof matterRepo.withTenantTransaction;

          const conflictRaceRes = (await runAsActionActor(
            'P-000003',
            () =>
              updateMatterConflictRecord(
                conflictRaceId,
                makeConflictRecord('P-000003', 'Bethan Rees', 'Approved'),
                'P-000003',
              ),
            { roles: ['risk_compliance'], mfaVerified: false },
          )) as { matter: Matter | null; code?: string };
          expect(injectedConflictRace).toBe(true);
          expect(conflictRaceRes.code).toBe('MATTER_CONCURRENCY_CONFLICT');
          expect(conflictRaceRes.matter).toBeNull();
          const conflictAfter = await matterRepo.getMatterById<Matter>(
            testTenantCtx('P-000001'),
            conflictRaceId,
          );
          expect(conflictAfter?.matterStatusId).toBe('matter_status.prospective_enquiry');
          expect(conflictAfter?.riskRatingId).toBe('risk_rating.high');

          let injectedSignOffRace = false;
          matterRepo.withTenantTransaction = (async (txCtx, fn, opts) => {
            if (!injectedSignOffRace && txCtx.tenantId === 'not-a-law-firm') {
              const current = await matterRepo.getMatterById<Matter>(txCtx, signOffRaceId, {
                includeRestricted: true,
              });
              if (current && current.riskRatingId !== 'risk_rating.high') {
                injectedSignOffRace = true;
                await matterRepo.updateMatter(
                  txCtx,
                  { ...current, riskRatingId: 'risk_rating.high' },
                  current.rowVersion ?? 1,
                );
              }
            }
            return origWithTx(txCtx, fn, opts);
          }) as typeof matterRepo.withTenantTransaction;

          const signOffRaceRes = (await signOffMatterCostsRecord(
            signOffRaceId,
            'P-000001',
            'Concurrent sign-off must abort cleanly',
          )) as { matter: Matter | null; code?: string };
          expect(injectedSignOffRace).toBe(true);
          expect(signOffRaceRes.code).toBe('MATTER_CONCURRENCY_CONFLICT');
          expect(signOffRaceRes.matter).toBeNull();
          const signOffAfter = await matterRepo.getMatterById<Matter>(
            testTenantCtx('P-000001'),
            signOffRaceId,
          );
          expect(signOffAfter?.matterStatusId).toBe('matter_status.prospective_enquiry');
          expect(signOffAfter?.riskRatingId).toBe('risk_rating.high');
        } finally {
          matterRepo.withTenantTransaction = origWithTx;
        }
      },
      { roles: ['partner'], mfaVerified: false },
    );
  }, 30_000);

  it('9. R763 (Blocking): opening gate checks CDD for every client (clientId + additionalClientIds) including expiry and tier sufficiency', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const openAction = getDynamicAction('openProspectiveMatterAction')!;
    const regRepo = new TenantRegisterRepository();

    await runAsActionActor(
      'P-000001',
      async () => {
        // Ensure O-000001 has valid Standard CDD
        const o1Start = await startOrLoadClientCddRecord(
          { subjectType: 'organisation', subjectId: 'O-000001', createIfMissing: true },
          'P-000001',
        );
        expect(o1Start.ok).toBe(true);
        if (o1Start.ok && o1Start.summary.record && o1Start.summary.status !== 'recorded') {
          for (const item of o1Start.summary.checklistItems) {
            if (item.status !== 'recorded') {
              await recordCddChecklistItemRecord(
                { recordId: o1Start.summary.record.id, itemKey: item.itemKey, status: 'recorded', note: 'Verified' },
                'P-000001',
              );
            }
          }
          await completeClientCddRecord({ recordId: o1Start.summary.record.id }, 'P-000001');
        }

        // Residential Conveyancing requires CDD complete (no override); O-000002 initially has NO CDD
        const jointSave = await saveMatterRecord(
          {
            title: 'R763 Joint Client Conveyancing',
            clientId: 'O-000001',
            additionalClientIds: ['O-000002'],
            practiceAreaId: 'work_type.real_estate_and_property',
            workTypeSubcategoryId: 'work_type.real_estate_and_property_residential_conveyancing',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(jointSave.matter).not.toBeNull();
        expect(jointSave.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');
        const jointId = jointSave.matter!.id;

        const openMissing = (await openAction(jointId)) as { ok: boolean; message?: string };
        expect(openMissing.ok).toBe(false);
        expect(openMissing.message).toMatch(/Harbourline/i);

        // Complete CDD for O-000002, then backdate dueAt to 2020-01-01 to verify expiry blocks
        const o2Start = await startOrLoadClientCddRecord(
          { subjectType: 'organisation', subjectId: 'O-000002', createIfMissing: true },
          'P-000001',
        );
        expect(o2Start.ok).toBe(true);
        if (o2Start.ok && o2Start.summary.record) {
          for (const item of o2Start.summary.checklistItems) {
            if (item.status !== 'recorded') {
              await recordCddChecklistItemRecord(
                { recordId: o2Start.summary.record.id, itemKey: item.itemKey, status: 'recorded', note: 'Verified' },
                'P-000001',
              );
            }
          }
          const completed = await completeClientCddRecord(
            { recordId: o2Start.summary.record.id },
            'P-000001',
          );
          expect(completed.ok).toBe(true);

          const cddCtx = testTenantCtx('P-000001');
          await regRepo.withTenantTransaction(cddCtx, async (tx) => {
            await tx.query(
              `UPDATE public.register_records SET due_at = '2020-01-01T00:00:00.000Z' WHERE tenant_id = $1 AND id = $2`,
              [cddCtx.tenantId, o2Start.summary.record!.id],
            );
          });
          const openExpired = (await openAction(jointId)) as { ok: boolean; message?: string };
          expect(openExpired.ok).toBe(false);

          await regRepo.withTenantTransaction(cddCtx, async (tx) => {
            await tx.query(
              `UPDATE public.register_records SET due_at = '2030-01-01T00:00:00.000Z' WHERE tenant_id = $1 AND id = $2`,
              [cddCtx.tenantId, o2Start.summary.record!.id],
            );
          });
        }

        const openAllValid = (await openAction(jointId)) as { ok: boolean; matter?: Matter };
        expect(openAllValid.ok).toBe(true);
        expect(openAllValid.matter?.matterStatusId).toBe('matter_status.active');

        // R763 tier sufficiency: a High-risk Corporate matter elevates O-000001 to High derived tier -> Standard CDD is insufficient until upgraded
        const highTierMatterSave = await saveMatterRecord(
          {
            title: 'R763 High-Risk Tier Sufficiency Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: HIGH_RISK_ANSWERS, followUps: HIGH_RISK_FOLLOW_UPS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(highTierMatterSave.matter).not.toBeNull();
        const tierGateView = await getMatterOpeningGateStateRecord(
          highTierMatterSave.matter!.id,
          'P-000001',
        );
        expect(tierGateView.ok).toBe(true);
        if (tierGateView.ok) {
          const cddPre = tierGateView.evaluation.preconditions.find(
            (p) => p.key === 'cdd_complete',
          );
          expect(cddPre?.rawSatisfied).toBe(false);
          expect(cddPre?.statusSummary).toMatch(/High-risk CDD|Penarth/i);
        }
      },
      { roles: ['partner'], mfaVerified: false },
    );
  }, 30_000);

  it('10. R764 (Blocking): refuses manual user creation of high_risk_opening for all roles and blocks leadFeeEarnerId/responsiblePartnerId from partner_approve even on system records', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const createRegAction = getDynamicAction('createRegisterRecordAction')!;
    const transitionRegAction = getDynamicAction('transitionRegisterRecordAction')!;

    // 1) Fee earner, secretary, partner cannot manually create high_risk_opening records
    for (const [actorId, role] of [
      ['P-000002', 'fee_earner'],
      ['P-000010', 'legal_secretary'],
      ['P-000001', 'partner'],
    ] as const) {
      const manualAttempt = (await runAsActionActor(
        actorId,
        () =>
          createRegAction({
            registerTypeKey: 'high_risk_opening',
            title: `Manual HRO bypass attempt by ${role}`,
            matterId: 'M-000001',
          }),
        { roles: [role], mfaVerified: true },
      )) as { ok: boolean; code?: string };
      expect(manualAttempt.ok).toBe(false);
    }

    // 2) On a genuine High-risk matter where Partner P-000005 is responsiblePartnerId (not record ownerId!),
    //    submitted by fee earner P-000002, P-000005 must STILL be refused partner_approve!
    let partnerLeadMatterId = '';
    await runAsActionActor(
      'P-000002',
      async () => {
        const res = await saveMatterRecord(
          {
            title: 'R764 Partner Approver Must Not Be Matter Lead or Responsible Partner',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000005',
            supervisingPartnerId: 'P-000005',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000005', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: HIGH_RISK_ANSWERS, followUps: HIGH_RISK_FOLLOW_UPS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        expect(res.matter).not.toBeNull();
        partnerLeadMatterId = res.matter!.id;
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );

    const hroList = await new TenantRegisterRepository().listVisibleRegisterRecords(
      testTenantCtx('P-000001'),
      'P-000001',
      { includeRestricted: true, registerTypeKey: 'high_risk_opening', matterId: partnerLeadMatterId },
    );
    expect(hroList).toHaveLength(1);
    const hroId = hroList[0]!.id;

    // Responsible partner P-000005 (though not HRO creator/owner) must be refused partner_approve!
    const respPartnerTry = (await runAsActionActor(
      'P-000005',
      () =>
        transitionRegAction({
          recordId: hroId,
          transitionKey: 'partner_approve',
          comment: 'Self-partner approval attempt',
        }),
      { roles: ['partner'], mfaVerified: false },
    )) as { ok: boolean; code?: string };
    expect(respPartnerTry.ok).toBe(false);
  }, 30_000);

  it('11. R778, R784 & R789 (Should fix): override revoke guards (>=10 chars & pre-opening only), zero raw permission keys in denials, and slim HRO DTO from getMatterOpeningGateStateRecord', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const overrideAction = getDynamicAction('overrideMatterOpeningPreconditionAction')!;
    const revokeAction = getDynamicAction('revokeMatterOpeningOverrideAction')!;
    const openAction = getDynamicAction('openProspectiveMatterAction')!;

    await runAsActionActor(
      'P-000001',
      async () => {
        const highSave = await saveMatterRecord(
          {
            title: 'R778 & R789 Litigation Gate Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.dispute_resolution',
            workTypeSubcategoryId: 'work_type.dispute_resolution_pre_action_correspondence',
            matterTypeId: 'matter_type.contentious',
            responsiblePartnerId: 'P-000005',
            supervisingPartnerId: 'P-000005',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000005', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: HIGH_RISK_ANSWERS, followUps: HIGH_RISK_FOLLOW_UPS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(highSave.matter).not.toBeNull();
        const mId = highSave.matter!.id;

        // R789: highRiskRecord returned to viewer omits raw fieldValues blob
        const gateView = await runAsActionActor(
          'P-000002',
          () => getMatterOpeningGateStateRecord(mId, 'P-000002'),
          { roles: ['fee_earner'], mfaVerified: false },
        );
        expect(gateView.ok).toBe(true);
        if (gateView.ok) {
          expect(gateView.highRiskRecord).not.toBeNull();
          expect((gateView.highRiskRecord as unknown as Record<string, unknown>)?.fieldValues).toBeUndefined();
        }

        // Override engagement_signed -> short revoke reason (<10 chars) refused (R778)
        const ovr = (await overrideAction({
          matterId: mId,
          preconditionKey: 'engagement_signed',
          reason: 'Urgent partner override for pre-action letter',
        })) as { ok: boolean; override?: { id: string } };
        expect(ovr.ok).toBe(true);
        const ovrId = ovr.override!.id;

        const shortRevoke = (await revokeAction({
          matterId: mId,
          overrideId: ovrId,
          reason: 'short',
        })) as { ok: boolean };
        expect(shortRevoke.ok).toBe(false);

        // R784: No colon-separated permission keys in service denial or formatted UI error for unprivileged user
        const noPermService = (await runAsActionActor(
          'P-000009',
          () => openProspectiveMatterRecord(mId, 'P-000009'),
          { roles: ['finance'], mfaVerified: false },
        )) as { ok: boolean; message?: string; error?: string };
        expect(noPermService.ok).toBe(false);
        expect(noPermService.message ?? '').not.toMatch(/[a-z_]+:[a-z_:]+/);

        const noPermOpen = (await runAsActionActor(
          'P-000009',
          () => openAction(mId),
          { roles: ['finance'], mfaVerified: false },
        )) as { ok: boolean; code?: string; message?: string; error?: string };
        expect(noPermOpen.ok).toBe(false);
        expect(formatOpeningGateActionError(noPermOpen)).not.toMatch(/[a-z_]+:[a-z_:]+/);
      },
      { roles: ['partner'], mfaVerified: false },
    );

    // After matter opens, revoking its override is refused (R778)
    await resetAllDemoData('P-000004', testDataResetContext());
    await runAsActionActor(
      'P-000001',
      async () => {
        const openedLit = await saveMatterRecord(
          {
            title: 'R778 Opened Tribunal Override Revoke Guard',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        const mId = openedLit.matter!.id;
        const ovr = (await overrideAction({
          matterId: mId,
          preconditionKey: 'engagement_signed',
          reason: 'Urgent partner override before opening',
        })) as { ok: boolean; override?: { id: string } };
        expect(ovr.ok).toBe(true);
        const opened = (await openAction(mId)) as { ok: boolean };
        expect(opened.ok).toBe(true);

        const revokeAfterOpen = (await revokeAction({
          matterId: mId,
          overrideId: ovr.override!.id,
          reason: 'Attempted revoke after matter already opened',
        })) as { ok: boolean; message?: string };
        expect(revokeAfterOpen.ok).toBe(false);
        expect(revokeAfterOpen.message).toMatch(/no longer prospective/i);
      },
      { roles: ['partner'], mfaVerified: false },
    );
  }, 30_000);

  it('12. R791 (Blocking): generic updateRegisterRecordAction and transitionRegisterRecordAction fieldUpdates are refused on system HRO records and server-owned marker cannot be forged', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const matterRepo = getMatterRepository();
    const updateRegAction = getDynamicAction('updateRegisterRecordAction')!;
    const transitionRegAction = getDynamicAction('transitionRegisterRecordAction')!;

    // Seed high-risk prospective matter submitted by P-000002 -> sync creates system HRO record
    let highMatterId = '';
    await runAsActionActor(
      'P-000002',
      async () => {
        const highSave = await saveMatterRecord(
          {
            title: 'R791 HRO Integrity Test Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: HIGH_RISK_ANSWERS, followUps: HIGH_RISK_FOLLOW_UPS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        expect(highSave.matter).not.toBeNull();
        highMatterId = highSave.matter!.id;
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );

    const gateBefore = await runAsActionActor(
      'P-000002',
      () => getMatterOpeningGateStateRecord(highMatterId, 'P-000002'),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(gateBefore.ok).toBe(true);
    const hroId = gateBefore.ok ? gateBefore.highRiskRecord?.id ?? '' : '';
    expect(hroId).toMatch(/^REG-/);

    const regRepo = new TenantRegisterRepository();
    const ctx = testTenantCtx('P-000001');
    const beforeRec = await regRepo.getRegisterRecordById(ctx, hroId, { includeRestricted: true });
    expect(beforeRec).not.toBeNull();
    expect(beforeRec?.createdById).toBe('system:matter_opening');
    expect('systemCreated' in (beforeRec?.fieldValues ?? {})).toBe(false);
    expect(beforeRec?.fieldValues?.submittedById).toBe('P-000002');

    // 1) Actor with register:edit tries to unset systemCreated & forge submittedById via updateRegisterRecordAction
    const genericUpdateRes = (await runAsActionActor(
      'P-000004',
      () =>
        updateRegAction({
          recordId: hroId,
          fieldValues: {
            ...(beforeRec!.fieldValues ?? {}),
            systemCreated: false,
            submittedById: 'P-000099',
          },
        }),
      { roles: ['admin'], mfaVerified: true },
    )) as { ok: boolean; code?: string; message?: string };
    expect(genericUpdateRes.ok).toBe(false);
    expect(genericUpdateRes.code).toBe('VALIDATION_ERROR');
    expect(genericUpdateRes.message ?? '').toMatch(/matter-opening workflow/i);

    const afterGenericRec = await regRepo.getRegisterRecordById(ctx, hroId, { includeRestricted: true });
    expect(afterGenericRec?.fieldValues).toEqual(beforeRec?.fieldValues);

    // 2) Independent partner tries to pass fieldUpdates on partner_approve via transitionRegisterRecordAction
    const transitionTamperRes = (await runAsActionActor(
      'P-000038',
      () =>
        transitionRegAction({
          recordId: hroId,
          transitionKey: 'partner_approve',
          comment: 'Partner attempt with tampered riskLevel',
          fieldUpdates: { riskLevel: 'Low' },
        }),
      { roles: ['partner'], mfaVerified: false },
    )) as { ok: boolean; code?: string; message?: string };
    expect(transitionTamperRes.ok).toBe(false);
    expect(transitionTamperRes.code).toBe('VALIDATION_ERROR');
    expect(transitionTamperRes.message ?? '').toMatch(/matter-opening workflow/i);

    const afterTransitionRec = await regRepo.getRegisterRecordById(ctx, hroId, {
      includeRestricted: true,
    });
    expect(afterTransitionRec?.status).toBe('pending_partner');
    expect(afterTransitionRec?.fieldValues).toEqual(beforeRec?.fieldValues);

    // 3) Opening gate still finds the exact same server-owned system HRO record
    const gateAfter = await runAsActionActor(
      'P-000002',
      () => getMatterOpeningGateStateRecord(highMatterId, 'P-000002'),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(gateAfter.ok).toBe(true);
    if (gateAfter.ok) {
      expect(gateAfter.highRiskRecord?.id).toBe(hroId);
    }
    expect(await matterRepo.getMatterById(ctx, highMatterId)).not.toBeNull();
  }, 30_000);

  it('13. R792 & R796 (Blocking): opening gate masks hidden employee-client names when employee has NO CDD record across open, override, cost sign-off, and gate view', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const matterRepo = getMatterRepository();
    const openAction = getDynamicAction('openProspectiveMatterAction')!;
    const overrideAction = getDynamicAction('overrideMatterOpeningPreconditionAction')!;
    const signOffAction = getDynamicAction('signOffMatterCostsAction')!;

    // Complete CDD for primary org O-000001; leave additional employee-client P-000005 (Siân Llewellyn) with NO CDD record at all
    await runAsActionActor(
      'P-000001',
      async () => {
        const o1Start = await startOrLoadClientCddRecord(
          { subjectType: 'organisation', subjectId: 'O-000001', createIfMissing: true },
          'P-000001',
        );
        expect(o1Start.ok).toBe(true);
        if (o1Start.ok && o1Start.summary.record) {
          for (const item of o1Start.summary.checklistItems) {
            if (item.status !== 'recorded') {
              await recordCddChecklistItemRecord(
                {
                  recordId: o1Start.summary.record.id,
                  itemKey: item.itemKey,
                  status: 'recorded',
                  note: 'Verified for joint matter test',
                },
                'P-000001',
              );
            }
          }
          const completed = await completeClientCddRecord(
            { recordId: o1Start.summary.record.id },
            'P-000001',
          );
          expect(completed.ok).toBe(true);
        }
      },
      { roles: ['partner'], mfaVerified: false },
    );

    // Create prospective joint-client matter (Dispute Resolution -> Arbitration: requireCddComplete=true, allowCddOverride=true, requireEngagementSigned=true)
    // Raise fee estimate to £35,000 so costs await partner sign-off; P-000006 and P-000038 are NOT participants on any matter for P-000005
    let jointMatterId = '';
    await runAsActionActor(
      'P-000001',
      async () => {
        const saved = await saveMatterRecord(
          {
            title: 'R792 Masked Joint Employee Matter',
            clientId: 'O-000001',
            additionalClientIds: ['P-000005'],
            practiceAreaId: 'work_type.dispute_resolution',
            workTypeSubcategoryId: 'work_type.dispute_resolution_arbitration',
            matterTypeId: 'matter_type.contentious',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            feeEstimateGbp: 10000,
            agreedFeeCapGbp: 10000,
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(saved.errors).toBeUndefined();
        expect(saved.matter).not.toBeNull();
        expect(saved.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');
        jointMatterId = saved.matter!.id;

        const raised = await saveMatterRecord(
          {
            ...saved.matter!,
            feeEstimateGbp: 35000,
            agreedFeeCapGbp: 35000,
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { id: jointMatterId, byId: 'P-000001', saveMode: 'draft' },
        );
        expect(raised.errors).toBeUndefined();
        expect(raised.matter).not.toBeNull();
      },
      { roles: ['partner'], mfaVerified: false },
    );

    // Lift staff_matter restriction on the joint matter so P-000006 & P-000038 can view/act on the matter
    // without holding risk:view / matter:restricted:access or participating on P-000005's matters
    const liftRes = (await runAsActionActor(
      'P-000050',
      () =>
        actionsModule.liftMatterRestrictionAction(
          jointMatterId,
          'staff_matter',
          'Joint client matter involving external lead client; staff restriction lifted for general handling.',
        ),
      { roles: ['managing_partner'], mfaVerified: true },
    )) as { matter: Matter | null; errors?: Record<string, string> };
    expect(liftRes.errors).toBeUndefined();
    expect(liftRes.matter?.isStaffMatter).toBe(false);

    // 1) Fee earner P-000006 (lacks risk:view / matter:restricted:access, not on matter) calls getMatterOpeningGateStateRecord and openProspectiveMatterAction
    const feGate = await runAsActionActor(
      'P-000006',
      () => getMatterOpeningGateStateRecord(jointMatterId, 'P-000006'),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(feGate.ok).toBe(true);
    expect(JSON.stringify(feGate)).not.toMatch(/Llewellyn|Si[aâ]n/i);
    if (feGate.ok) {
      const cddPre = feGate.evaluation.preconditions.find((p) => p.key === 'cdd_complete');
      expect(cddPre?.rawSatisfied).toBeNull();
      expect(cddPre?.canOverride).toBe(false);
      expect(cddPre?.statusSummary).toBe('Not available to you');
      expect(feGate.evaluation.blockingReasons).toContain(
        'Client due diligence is not complete for one or more clients.',
      );
    }

    const feOpen = (await runAsActionActor(
      'P-000006',
      () => openAction(jointMatterId),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; message?: string; openingGate?: unknown };
    expect(feOpen.ok).toBe(false);
    expect(JSON.stringify(feOpen)).not.toMatch(/Llewellyn|Si[aâ]n/i);

    // 2) Partner P-000045 (holds matter:opening_gate:override & signoff:approve, lacks risk:view / matter:restricted:access)
    const partnerOverrideEng = (await runAsActionActor(
      'P-000045',
      () =>
        overrideAction({
          matterId: jointMatterId,
          preconditionKey: 'engagement_signed',
          reason: 'Partner engagement override on masked joint matter',
        }),
      { roles: ['partner'], mfaVerified: false },
    )) as { ok: boolean; evaluation?: unknown };
    expect(partnerOverrideEng.ok).toBe(true);
    expect(JSON.stringify(partnerOverrideEng)).not.toMatch(/Llewellyn|Si[aâ]n/i);

    const partnerOverrideCdd = (await runAsActionActor(
      'P-000045',
      () =>
        overrideAction({
          matterId: jointMatterId,
          preconditionKey: 'cdd_complete',
          reason: 'Partner attempting override of hidden employee CDD',
        }),
      { roles: ['partner'], mfaVerified: false },
    )) as { ok: boolean; code?: string; message?: string; evaluation?: unknown };
    expect(partnerOverrideCdd.ok).toBe(false);
    expect(partnerOverrideCdd.code).toBe('OPENING_GATE_OVERRIDE_FORBIDDEN');
    expect(JSON.stringify(partnerOverrideCdd)).not.toMatch(/Llewellyn|Si[aâ]n/i);

    const partnerSignOff = (await runAsActionActor(
      'P-000045',
      () => signOffAction(jointMatterId, 'Partner cost sign-off on masked CDD joint matter'),
      { roles: ['partner'], mfaVerified: false },
    )) as { ok?: boolean; matter?: Matter | null; warnings?: string[]; message?: string };
    expect(
      JSON.stringify({
        warnings: partnerSignOff.warnings ?? [],
        message: partnerSignOff.message ?? '',
      }),
    ).not.toMatch(/Llewellyn|Si[aâ]n/i);
    expect(partnerSignOff.warnings ?? []).toContain(
      'Client due diligence is not complete for one or more clients.',
    );

    const persistedMatter = await matterRepo.getMatterById<Matter>(
      testTenantCtx('P-000001'),
      jointMatterId,
    );
    expect(persistedMatter?.matterStatusId).toBe('matter_status.prospective_enquiry');
  }, 30_000);

  it('14. R793 (Should fix): excludes matter leadFeeEarnerId and responsiblePartnerId from HRO compliance_approve', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const partyRepo = new TenantPartyRepository();
    const regRepo = new TenantRegisterRepository();
    const transitionRegAction = getDynamicAction('transitionRegisterRecordAction')!;

    const basePartner = (await partyRepo.getPersonById<Person>(ctx, 'P-000005'))!;
    const dualRp: Person = {
      ...basePartner,
      id: 'P-S105-DUAL-RP',
      entraObjectId: undefined,
      firstName: 'Dual',
      surname: 'Compliance',
      roles: ['partner', 'risk_compliance'],
      employeeRoleId: 'employee_role.partner',
    };
    await partyRepo.putPerson(ctx, dualRp);

    // Sub-case A: responsiblePartnerId holding risk_compliance attempts compliance_approve
    let hroMatterId = '';
    await runAsActionActor(
      'P-000002',
      async () => {
        const res = await saveMatterRecord(
          {
            title: 'R793 Dual-Role Responsible Partner HRO Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: dualRp.id,
            supervisingPartnerId: dualRp.id,
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: [dualRp.id, 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: HIGH_RISK_ANSWERS, followUps: HIGH_RISK_FOLLOW_UPS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        expect(res.matter).not.toBeNull();
        hroMatterId = res.matter!.id;
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );

    const hroList = await regRepo.listVisibleRegisterRecords(testTenantCtx('P-000001'), 'P-000001', {
      includeRestricted: true,
      registerTypeKey: 'high_risk_opening',
      matterId: hroMatterId,
    });
    expect(hroList).toHaveLength(1);
    const hroId = hroList[0]!.id;

    // Independent partner P-000001 gives Stage 1 approval
    const stage1 = (await runAsActionActor(
      'P-000001',
      () =>
        transitionRegAction({
          recordId: hroId,
          transitionKey: 'partner_approve',
          comment: 'Independent stage 1 partner approval',
        }),
      { roles: ['partner'], mfaVerified: false },
    )) as { ok: boolean };
    expect(stage1.ok).toBe(true);

    // Responsible partner dualRp (also holding risk_compliance) is refused Stage 2 compliance_approve
    const stage2SelfRp = (await runAsActionActor(
      dualRp.id,
      () =>
        transitionRegAction({
          recordId: hroId,
          transitionKey: 'compliance_approve',
          comment: 'Responsible partner attempting stage 2 compliance approval',
        }),
      { roles: ['partner', 'risk_compliance'], mfaVerified: false },
    )) as { ok: boolean; code?: string; message?: string };
    expect(stage2SelfRp.ok).toBe(false);
    expect(stage2SelfRp.code).toBe('REGISTER_SELF_APPROVAL_FORBIDDEN');

    // Independent Risk & Compliance officer P-000003 succeeds
    const stage2Clean = (await runAsActionActor(
      'P-000003',
      () =>
        transitionRegAction({
          recordId: hroId,
          transitionKey: 'compliance_approve',
          comment: 'Independent MLRO stage 2 approval',
        }),
      { roles: ['risk_compliance'], mfaVerified: false },
    )) as { ok: boolean };
    expect(stage2Clean.ok).toBe(true);
  }, 30_000);

  it('15. R794 (Should fix): enforces allowConflictOverride work-type policy and inherits firm default', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const matterRepo = getMatterRepository();
    const overrideAction = getDynamicAction('overrideMatterOpeningPreconditionAction')!;
    const openAction = getDynamicAction('openProspectiveMatterAction')!;

    // Complete CDD for O-000001 so conflict check is the sole blocker
    await runAsActionActor(
      'P-000001',
      async () => {
        const cddStart = await startOrLoadClientCddRecord(
          { subjectType: 'organisation', subjectId: 'O-000001', createIfMissing: true },
          'P-000001',
        );
        if (cddStart.ok && cddStart.summary.record && cddStart.summary.status !== 'recorded') {
          for (const item of cddStart.summary.checklistItems) {
            if (item.status !== 'recorded') {
              await recordCddChecklistItemRecord(
                { recordId: cddStart.summary.record.id, itemKey: item.itemKey, status: 'recorded', note: 'OK' },
                'P-000001',
              );
            }
          }
          await completeClientCddRecord({ recordId: cddStart.summary.record.id }, 'P-000001');
        }
      },
      { roles: ['partner'], mfaVerified: false },
    );

    const baseWorkTypes = (notALawFirmBaseConfig as unknown as {
      workTypes: {
        defaults: Record<string, unknown>;
        items: Array<Record<string, unknown>>;
      };
    }).workTypes;
    setActiveTenantConfigForTesting(
      {
        ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
        workTypes: {
          ...baseWorkTypes,
          items: [
            ...baseWorkTypes.items,
            {
              workTypeId: 'work_type.general_practice_advisory',
              practiceAreaId: 'work_type.general_practice',
              active: true,
              autoTaskTemplates: [],
              riskQuestions: [],
              openingGate: {
                allowConflictOverride: false,
              },
            },
          ],
        },
      },
      {},
    );

    await runAsActionActor(
      'P-000001',
      async () => {
        const disallowedSave = await saveMatterRecord(
          {
            title: 'R794 Disallowed Conflict Override Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.general_practice',
            workTypeSubcategoryId: 'work_type.general_practice_advisory',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Referred'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_referred' },
        );
        expect(disallowedSave.matter).not.toBeNull();
        const disallowedId = disallowedSave.matter!.id;

        await matterRepo.updateMatter(
          testTenantCtx('P-000001'),
          {
            ...disallowedSave.matter!,
            conflictCheckStatus: 'Not started',
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Not started'),
          },
          disallowedSave.matter!.rowVersion ?? 1,
        );

        const ovrDenied = (await overrideAction({
          matterId: disallowedId,
          preconditionKey: 'conflict_cleared',
          reason: 'Attempting partner conflict override where policy forbids it',
        })) as { ok: boolean; code?: string };
        expect(ovrDenied.ok).toBe(false);
        expect(ovrDenied.code).toBe('OPENING_GATE_OVERRIDE_FORBIDDEN');

        const stillBlocked = (await openAction(disallowedId)) as { ok: boolean };
        expect(stillBlocked.ok).toBe(false);
        const afterDisallowed = await matterRepo.getMatterById<Matter>(
          testTenantCtx('P-000001'),
          disallowedId,
        );
        expect(afterDisallowed?.matterStatusId).toBe('matter_status.prospective_enquiry');

        // Work type inheriting firm default allowConflictOverride: true allows overriding Not started
        const inheritedSave = await saveMatterRecord(
          {
            title: 'R794 Inherited Firm Default Conflict Override Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Referred'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_referred' },
        );
        const inheritedId = inheritedSave.matter!.id;
        await matterRepo.updateMatter(
          testTenantCtx('P-000001'),
          {
            ...inheritedSave.matter!,
            conflictCheckStatus: 'Not started',
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Not started'),
          },
          inheritedSave.matter!.rowVersion ?? 1,
        );
        const inheritedOvr = (await overrideAction({
          matterId: inheritedId,
          preconditionKey: 'conflict_cleared',
          reason: 'Partner override allowed under firm default policy',
        })) as { ok: boolean };
        expect(inheritedOvr.ok).toBe(true);
      },
      { roles: ['partner'], mfaVerified: false },
    );
  }, 30_000);

  it('16. R795 (Should fix): openProspectiveMatterRecord aborts with MATTER_CONCURRENCY_CONFLICT when matter changes between read and FOR UPDATE', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const matterRepo = getMatterRepository();

    await runAsActionActor(
      'P-000001',
      async () => {
        const baseSave = await saveMatterRecord(
          {
            title: 'R795 Open Matter Stale Read Race',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.dispute_resolution',
            workTypeSubcategoryId: 'work_type.dispute_resolution_pre_action_correspondence',
            matterTypeId: 'matter_type.contentious',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(baseSave.matter).not.toBeNull();
        const raceId = baseSave.matter!.id;

        const origWithTx = matterRepo.withTenantTransaction.bind(matterRepo);
        let injectedOpenRace = false;
        try {
          matterRepo.withTenantTransaction = (async (txCtx, fn, opts) => {
            if (!injectedOpenRace && opts === undefined && txCtx.tenantId === 'not-a-law-firm') {
              const current = await matterRepo.getMatterById<Matter>(txCtx, raceId, {
                includeRestricted: true,
              });
              if (current && current.riskRatingId !== 'risk_rating.high') {
                injectedOpenRace = true;
                await matterRepo.updateMatter(
                  txCtx,
                  { ...current, riskRatingId: 'risk_rating.high' },
                  current.rowVersion ?? 1,
                );
              }
            }
            return origWithTx(txCtx, fn, opts);
          }) as typeof matterRepo.withTenantTransaction;

          const raceRes = (await openProspectiveMatterRecord(raceId, 'P-000001')) as {
            ok: boolean;
            code?: string;
          };
          expect(injectedOpenRace).toBe(true);
          expect(raceRes.ok).toBe(false);
          expect(raceRes.code).toBe('MATTER_CONCURRENCY_CONFLICT');
        } finally {
          matterRepo.withTenantTransaction = origWithTx;
        }

        const afterRace = await matterRepo.getMatterById<Matter>(testTenantCtx('P-000001'), raceId);
        expect(afterRace?.riskRatingId).toBe('risk_rating.high');
        expect(afterRace?.matterStatusId).toBe('matter_status.prospective_enquiry');
      },
      { roles: ['partner'], mfaVerified: false },
    );
  }, 30_000);

  it('17. R797, Suggestion 5 & Suggestion 11: missing approver/override person returns null, revoking on aborted matter says no longer prospective, and saveMatterNumberingConfigAction refuses mismatched scope', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const matterRepo = getMatterRepository();
    const overrideAction = getDynamicAction('overrideMatterOpeningPreconditionAction')!;
    const revokeAction = getDynamicAction('revokeMatterOpeningOverrideAction')!;
    const saveNumAction = getDynamicAction('saveMatterNumberingConfigAction')!;
    const transitionRegAction = getDynamicAction('transitionRegisterRecordAction')!;

    // Suggestion 11: saveMatterNumberingConfigAction refuses mismatched pattern and scope
    const badNumRes = (await runAsActionActor(
      'P-000004',
      () =>
        saveNumAction(
          {
            pattern: '{CLIENT_REF}-{SEQ:4}',
            sequenceScope: 'year',
            emptyTokenFallback: 'MAT',
          },
          'Invalid mismatched numbering test',
        ),
      { roles: ['admin'], mfaVerified: true },
    )) as { ok: boolean; message?: string };
    expect(badNumRes.ok).toBe(false);
    expect(badNumRes.message ?? '').toMatch(/YYYY|YY/);

    // R797 & Suggestion 5: High-risk prospective matter with override & approved HRO whose actors are missing from people list
    await runAsActionActor(
      'P-000002',
      async () => {
        const mSave = await saveMatterRecord(
          {
            title: 'R797 Null Name & Aborted Revoke Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.dispute_resolution',
            workTypeSubcategoryId: 'work_type.dispute_resolution_arbitration',
            matterTypeId: 'matter_type.contentious',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: HIGH_RISK_ANSWERS, followUps: HIGH_RISK_FOLLOW_UPS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        const mId = mSave.matter!.id;

        const ovr = (await runAsActionActor(
          'P-000045',
          () =>
            overrideAction({
              matterId: mId,
              preconditionKey: 'engagement_signed',
              reason: 'Override before missing person name check',
            }),
          { roles: ['partner'], mfaVerified: false },
        )) as { ok: boolean; override?: { id: string } };
        expect(ovr.ok).toBe(true);

        const regRepo = new TenantRegisterRepository();
        const hroRecs = await regRepo.listVisibleRegisterRecords(testTenantCtx('P-000001'), 'P-000001', {
          includeRestricted: true,
          registerTypeKey: 'high_risk_opening',
          matterId: mId,
        });
        const hroId = hroRecs[0]!.id;

        await runAsActionActor(
          'P-000045',
          () =>
            transitionRegAction({
              recordId: hroId,
              transitionKey: 'partner_approve',
              comment: 'Stage 1 partner approve',
            }),
          { roles: ['partner'], mfaVerified: false },
        );
        await runAsActionActor(
          'P-000003',
          () =>
            transitionRegAction({
              recordId: hroId,
              transitionKey: 'compliance_approve',
              comment: 'Stage 2 compliance approve',
            }),
          { roles: ['risk_compliance'], mfaVerified: false },
        );

        // Rewrite transition/override actor IDs in DB to an unknown ID so people lookup misses
        const ctx = testTenantCtx('P-000001');
        await regRepo.withTenantTransaction(ctx, async (tx) => {
          await tx.query(
            `UPDATE public.register_transitions SET actor_id = 'P-UNKNOWN-R797' WHERE tenant_id = $1 AND register_record_id = $2`,
            [ctx.tenantId, hroId],
          );
          await tx.query(
            `UPDATE public.matter_opening_gate_overrides SET overridden_by_person_id = 'P-UNKNOWN-R797' WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, ovr.override!.id],
          );
        });

        const gateWithUnknownActors = await getMatterOpeningGateStateRecord(mId, 'P-000002');
        expect(gateWithUnknownActors.ok).toBe(true);
        if (gateWithUnknownActors.ok) {
          expect(gateWithUnknownActors.highRiskRecord?.partnerApproverName).toBeNull();
          expect(gateWithUnknownActors.highRiskRecord?.complianceApproverName).toBeNull();
          expect(gateWithUnknownActors.evaluation.highRisk.partnerApproverName).toBeNull();
          expect(gateWithUnknownActors.evaluation.activeOverrides[0]?.overriddenByName).toBeNull();
          expect(
            gateWithUnknownActors.evaluation.preconditions
              .find((p) => p.key === 'engagement_signed')
              ?.activeOverride?.overriddenByName,
          ).toBeNull();
          expect(gateWithUnknownActors.evaluation.blockingReasons.join(' ')).not.toContain(
            'P-UNKNOWN-R797',
          );
          expect(
            gateWithUnknownActors.evaluation.preconditions.map((p) => p.statusSummary).join(' '),
          ).not.toContain('P-UNKNOWN-R797');
        }

        // Suggestion 5: Create an aborted prospective matter with override -> revoke refuses with "no longer prospective"
        const abortedSave = await saveMatterRecord(
          {
            title: 'Suggestion 5 Aborted Override Revoke Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.dispute_resolution',
            workTypeSubcategoryId: 'work_type.dispute_resolution_arbitration',
            matterTypeId: 'matter_type.contentious',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        );
        const abortedId = abortedSave.matter!.id;
        const abOvr = (await runAsActionActor(
          'P-000045',
          () =>
            overrideAction({
              matterId: abortedId,
              preconditionKey: 'engagement_signed',
              reason: 'Override prior to prospective abandonment',
            }),
          { roles: ['partner'], mfaVerified: false },
        )) as { ok: boolean; override?: { id: string } };
        expect(abOvr.ok).toBe(true);

        const catRepo = new TenantCatalogueRepository();
        const choiceVals = await catRepo.listChoiceValuesForList(ctx, 'matter_status');
        const abortedChoice = choiceVals.find((v) => v.systemKey === 'aborted')!;
        const loadedAborted = (await matterRepo.getMatterById<Matter>(ctx, abortedId))!;
        await matterRepo.updateMatter(
          ctx,
          { ...loadedAborted, matterStatusId: abortedChoice.id, recordStatusId: abortedChoice.id },
          loadedAborted.rowVersion ?? 1,
        );

        const revokeAborted = (await runAsActionActor(
          'P-000045',
          () =>
            revokeAction({
              matterId: abortedId,
              overrideId: abOvr.override!.id,
              reason: 'Attempting revoke after matter aborted',
            }),
          { roles: ['partner'], mfaVerified: false },
        )) as { ok: boolean; message?: string };
        expect(revokeAborted.ok).toBe(false);
        expect(revokeAborted.message ?? '').toMatch(/no longer prospective/i);
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );
  }, 30_000);

  it('18. R804: system-driven withdrawal succeeds for a firm-defined role with matter:edit and without register:edit while auditing the caller, and still refuses users without matter:edit', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const partyRepo = new TenantPartyRepository();
    const matterRepo = new TenantMatterRepository();
    const regRepo = new TenantRegisterRepository();

    const baseRbac = createDefaultRbacConfig();
    const baseRawRbac = (notALawFirmBaseConfig as unknown as { rbac: Record<string, unknown> }).rbac;
    const baseIdentityMapping = (baseRawRbac.identityMapping ?? baseRbac.identityMapping) as {
      entraAppRoleToRoleKey?: Record<string, string[]>;
      [k: string]: unknown;
    };
    setActiveTenantConfigForTesting(
      {
        ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
        rbac: {
          ...baseRawRbac,
          roles: {
            ...baseRbac.roles,
            matter_editor_no_reg: {
              key: 'matter_editor_no_reg',
              label: 'Matter Editor (No Registers)',
              shortLabel: 'Matter editor',
              description: 'Firm-defined role with matter:edit and without register:edit.',
              isBuiltIn: false,
              permissions: ['employee:view_core', 'matter:edit'],
            },
            matter_viewer_only: {
              key: 'matter_viewer_only',
              label: 'Matter Viewer Only',
              shortLabel: 'Matter viewer',
              description: 'Firm-defined role without matter:edit.',
              isBuiltIn: false,
              permissions: ['employee:view_core'],
            },
          },
          identityMapping: {
            ...baseIdentityMapping,
            entraAppRoleToRoleKey: {
              ...(baseIdentityMapping.entraAppRoleToRoleKey ?? {}),
              'Firm.MatterEditorNoReg': ['matter_editor_no_reg'],
              'Firm.MatterViewerOnly': ['matter_viewer_only'],
            },
          },
        },
      },
      {},
    );

    const seededPeople = await partyRepo.listAllPeople<Person>(ctx);
    const baseEmp = seededPeople.find((p) => p.id === 'P-000002')!;
    const editorPerson: Person = {
      ...baseEmp,
      id: 'P-S105-R804-EDITOR',
      entraObjectId: undefined,
      firstName: 'Nia',
      surname: 'EditorOnly',
      employeeRoleId: 'employee_role.support_staff',
      roles: ['matter_editor_no_reg'],
      appRole: 'call_handler',
      permissionOverrides: undefined,
      emails: [
        {
          id: 'em-s105-r804-editor',
          address: 'nia.editor@notalawfirm.example',
          isPrimary: true,
          typeId: null,
        },
      ],
    };
    const viewerPerson: Person = {
      ...baseEmp,
      id: 'P-S105-R804-VIEWER',
      entraObjectId: undefined,
      firstName: 'Gareth',
      surname: 'ViewerOnly',
      employeeRoleId: 'employee_role.support_staff',
      roles: ['matter_viewer_only'],
      appRole: 'call_handler',
      permissionOverrides: undefined,
      emails: [
        {
          id: 'em-s105-r804-viewer',
          address: 'gareth.viewer@notalawfirm.example',
          isPrimary: true,
          typeId: null,
        },
      ],
    };
    await partyRepo.putPeople(ctx, [editorPerson, viewerPerson]);

    // 1. Partner opens a prospective High-risk matter -> pending_partner HRO record created
    const highSave = await runAsActionActor(
      'P-000001',
      () =>
        saveMatterRecord(
          {
            title: 'R804 HRO Withdrawal Firm Role Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: [
              'P-000001',
              'P-000002',
              editorPerson.id,
              viewerPerson.id,
            ],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: {
              answers: HIGH_RISK_ANSWERS,
              followUps: HIGH_RISK_FOLLOW_UPS,
            },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(highSave.errors).toBeUndefined();
    const matter = highSave.matter!;
    const hroBefore = (
      await regRepo.listVisibleRegisterRecords(ctx, 'P-000001', {
        includeRestricted: true,
        registerTypeKey: 'high_risk_opening',
        matterId: matter.id,
      })
    )[0]!;
    expect(hroBefore.status).toBe('pending_partner');

    const saveAction = getDynamicAction('saveMatterAction')!;

    // 2. Firm-defined role WITHOUT matter:edit is still refused
    const deniedRes = (await runAsActionActor(
      viewerPerson.id,
      () =>
        saveAction(
          {
            title: matter.title,
            clientId: matter.clientId,
            practiceAreaId: matter.practiceAreaId,
            workTypeSubcategoryId: matter.workTypeSubcategoryId,
            responsiblePartnerId: matter.responsiblePartnerId,
            supervisingPartnerId: matter.supervisingPartnerId,
            leadFeeEarnerId: matter.leadFeeEarnerId,
            teamMemberIds: matter.teamMemberIds,
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          {
            id: matter.id,
            saveMode: 'submit_cleared',
            expectedRowVersion: matter.rowVersion,
          },
        ),
      { roles: ['matter_viewer_only'], mfaVerified: false },
    )) as { denied?: boolean; code?: string };
    expect(isActionDenied(deniedRes as never)).toBe(true);

    const hroStillPending = (
      await regRepo.listVisibleRegisterRecords(ctx, 'P-000001', {
        includeRestricted: true,
        registerTypeKey: 'high_risk_opening',
        matterId: matter.id,
      })
    )[0]!;
    expect(hroStillPending.status).toBe('pending_partner');

    // 3. Firm-defined role WITH matter:edit and WITHOUT register:edit lowers risk -> HRO withdrawn & caller audited
    const lowerSave = (await runAsActionActor(
      editorPerson.id,
      () =>
        saveAction(
          {
            title: matter.title,
            clientId: matter.clientId,
            practiceAreaId: matter.practiceAreaId,
            workTypeSubcategoryId: matter.workTypeSubcategoryId,
            responsiblePartnerId: matter.responsiblePartnerId,
            supervisingPartnerId: matter.supervisingPartnerId,
            leadFeeEarnerId: matter.leadFeeEarnerId,
            teamMemberIds: matter.teamMemberIds,
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          {
            id: matter.id,
            saveMode: 'submit_cleared',
            expectedRowVersion: matter.rowVersion,
          },
        ),
      { roles: ['matter_editor_no_reg'], mfaVerified: false },
    )) as { matter: Matter | null; errors?: Record<string, string> };
    expect(isActionDenied(lowerSave as never)).toBe(false);
    expect(lowerSave.errors).toBeUndefined();
    expect(lowerSave.matter).not.toBeNull();

    const updatedMatter = await matterRepo.getMatterById<Matter>(ctx, matter.id, {
      includeRestricted: true,
    });
    expect(updatedMatter).not.toBeNull();

    const hroAfter = (
      await regRepo.listVisibleRegisterRecords(ctx, 'P-000001', {
        includeRestricted: true,
        registerTypeKey: 'high_risk_opening',
        matterId: matter.id,
      })
    )[0]!;
    expect(hroAfter.status).toBe('withdrawn');

    const [regAudits, matterAudits] = await Promise.all([
      auditEntriesForRecord('register_record', hroAfter.id),
      auditEntriesForRecord('matter', matter.id),
    ]);
    expect(
      regAudits.some(
        (e) =>
          e.action === 'status-change' &&
          e.newValue === 'withdrawn' &&
          e.byId === editorPerson.id,
      ),
    ).toBe(true);
    expect(
      matterAudits.some(
        (e) =>
          e.field === 'High-risk opening approval' &&
          e.newValue?.includes('withdrawn') &&
          e.byId === editorPerson.id,
      ),
    ).toBe(true);
  }, 30_000);

  it('19. R810: records gate CDD outcome, opens gate-cleared matters to Active, preserves openedViaGate, excludes them from CMI incomplete, and masks unpermitted viewers', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const matterRepo = new TenantMatterRepository();
    const catRepo = new TenantCatalogueRepository();
    const statusValues = (await catRepo.listChoiceValuesForList(
      ctx,
      'matter_status',
    )) as ChoiceValue[];
    const recordSignedAction = getDynamicAction('recordEngagementLetterSignedAction')!;
    const openAction = getDynamicAction('openProspectiveMatterAction')!;

    // (a) CDD met via gate -> openProspectiveMatterRecord sets Active, Verified, amlCompletedAt, openedViaGate: true, pill "Open"
    let verifiedMatterId = '';
    await runAsActionActor(
      'P-000001',
      async () => {
        const saveRes = await saveMatterRecord(
          {
            title: 'R810 Verified Gate Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(saveRes.errors).toBeUndefined();
        expect(saveRes.matter).not.toBeNull();
        verifiedMatterId = saveRes.matter!.id;
        expect(saveRes.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');
        // (d) Prospective pill takes precedence over default amlStatus ('CMI incomplete')
        expect(resolveMatterStatusPill(saveRes.matter!, statusValues)).toEqual({
          label: 'Prospective',
          tone: 'warning',
          isCmiIncomplete: false,
          isConflictFlagged: false,
        });

        await recordSignedAction({
          matterId: verifiedMatterId,
          status: 'Signed & returned',
        });
        const opened = (await openAction(verifiedMatterId)) as {
          ok: boolean;
          matter?: Matter;
        };
        expect(opened.ok).toBe(true);
        expect(opened.matter).toBeDefined();
        expect(opened.matter!.matterStatusId).toBe('matter_status.active');
        expect(opened.matter!.amlStatus).toBe('Verified');
        expect(opened.matter!.amlCompletedAt).toBeTruthy();
        expect(
          (opened.matter!.fieldValues?.['matterOpeningGate'] as { openedViaGate?: boolean })
            ?.openedViaGate,
        ).toBe(true);
        const snap = opened.matter!.fieldValues?.['matterOpeningSnapshot'] as
          | MatterOpeningSnapshot
          | undefined;
        expect(snap?.complianceOnboarding.amlStatus).toBe('Verified');
        expect(resolveMatterStatusPill(opened.matter!, statusValues)).toEqual({
          label: 'Open',
          tone: 'positive',
          isCmiIncomplete: false,
          isConflictFlagged: false,
        });

        // (a2) Subsequent edit of opened matter preserves openedViaGate & amlStatus
        const editedRes = await saveMatterRecord(
          {
            title: 'R810 Verified Gate Matter Updated',
            clientId: opened.matter!.clientId,
            practiceAreaId: opened.matter!.practiceAreaId,
            workTypeSubcategoryId: opened.matter!.workTypeSubcategoryId,
            matterStatusId: opened.matter!.matterStatusId,
            rowVersion: opened.matter!.rowVersion,
          },
          { id: verifiedMatterId, byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(editedRes.errors).toBeUndefined();
        expect(
          (editedRes.matter!.fieldValues?.['matterOpeningGate'] as { openedViaGate?: boolean })
            ?.openedViaGate,
        ).toBe(true);
        expect(editedRes.matter!.amlStatus).toBe('Verified');
        expect(resolveMatterStatusPill(editedRes.matter!, statusValues).label).toBe('Open');
      },
      { roles: ['partner'], mfaVerified: true },
    );

    // (b) CDD partner override -> Overridden, amlCompletedAt null, openedViaGate true, pill "Open"
    let overriddenMatterId = '';
    await runAsActionActor(
      'P-000001',
      async () => {
        const fintechSave = await saveMatterRecord(
          {
            title: 'R810 CDD Overridden Gate Matter',
            clientId: 'O-000002',
            practiceAreaId: 'work_type.technology_and_digital',
            workTypeSubcategoryId: 'work_type.technology_and_digital_fintech_and_payments',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(fintechSave.matter).not.toBeNull();
        overriddenMatterId = fintechSave.matter!.id;
        expect(fintechSave.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');

        const ovr = await overrideMatterOpeningPreconditionRecord(
          {
            matterId: overriddenMatterId,
            preconditionKey: 'cdd_complete',
            reason: 'Urgent partner-authorised CDD override for R810 verification.',
          },
          'P-000001',
        );
        expect('ok' in ovr && ovr.ok).toBe(true);

        const opened = await openProspectiveMatterRecord(overriddenMatterId, 'P-000001');
        expect('ok' in opened && opened.ok).toBe(true);
        if ('matter' in opened && opened.matter) {
          expect(opened.matter.matterStatusId).toBe('matter_status.active');
          expect(opened.matter.amlStatus).toBe('Overridden');
          expect(opened.matter.amlCompletedAt).toBeNull();
          expect(
            (opened.matter.fieldValues?.['matterOpeningGate'] as { openedViaGate?: boolean })
              ?.openedViaGate,
          ).toBe(true);
          const snap = opened.matter.fieldValues?.['matterOpeningSnapshot'] as
            | MatterOpeningSnapshot
            | undefined;
          expect(snap?.complianceOnboarding.amlStatus).toBe('Overridden');
          expect(resolveMatterStatusPill(opened.matter, statusValues)).toEqual({
            label: 'Open',
            tone: 'positive',
            isCmiIncomplete: false,
            isConflictFlagged: false,
          });
        }
      },
      { roles: ['partner'], mfaVerified: true },
    );

    // (c) CDD not required (defaults work type general_practice_advisory has requireCddComplete: false) -> Not required
    let notRequiredMatterId = '';
    await runAsActionActor(
      'P-000001',
      async () => {
        const gpSave = await saveMatterRecord(
          {
            title: 'R810 CDD Not Required Matter',
            clientId: 'O-000002',
            practiceAreaId: 'work_type.general_practice',
            workTypeSubcategoryId: 'work_type.general_practice_advisory',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(gpSave.errors).toBeUndefined();
        expect(gpSave.matter).not.toBeNull();
        notRequiredMatterId = gpSave.matter!.id;
        expect(gpSave.matter!.matterStatusId).toBe('matter_status.active');
        expect(gpSave.matter!.amlStatus).toBe('Not required');
        expect(gpSave.matter!.amlCompletedAt).toBeNull();
        expect(
          (gpSave.matter!.fieldValues?.['matterOpeningGate'] as { openedViaGate?: boolean })
            ?.openedViaGate,
        ).toBe(true);
        expect(resolveMatterStatusPill(gpSave.matter!, statusValues)).toEqual({
          label: 'Open',
          tone: 'positive',
          isCmiIncomplete: false,
          isConflictFlagged: false,
        });
      },
      { roles: ['partner'], mfaVerified: true },
    );

    // Also create a Prospective matter to confirm repository cmi_incomplete SQL filter excludes it
    let prospectiveMatterId = '';
    await runAsActionActor(
      'P-000001',
      async () => {
        const pSave = await saveMatterRecord(
          {
            title: 'R810 Still Prospective Matter',
            clientId: 'O-000002',
            practiceAreaId: 'work_type.real_estate_and_property',
            workTypeSubcategoryId: 'work_type.real_estate_and_property_residential_conveyancing',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(pSave.matter).not.toBeNull();
        prospectiveMatterId = pSave.matter!.id;
        expect(pSave.matter!.matterStatusId).toBe('matter_status.prospective_enquiry');
      },
      { roles: ['partner'], mfaVerified: true },
    );

    // (e) & (f) Legacy Active + Pending matter shows "CMI incomplete" and is returned by cmi_incomplete filter,
    // while gate-opened and Prospective matters are excluded.
    const legacyPendingMatter = await matterRepo.getMatterById<Matter>(ctx, 'M-000002', {
      includeRestricted: true,
    });
    expect(legacyPendingMatter).not.toBeNull();
    expect(legacyPendingMatter!.matterStatusId).toBe('matter_status.active');
    expect(legacyPendingMatter!.amlStatus).toBe('Pending');
    expect(resolveMatterStatusPill(legacyPendingMatter!, statusValues)).toEqual({
      label: 'CMI incomplete',
      tone: 'warning',
      isCmiIncomplete: true,
      isConflictFlagged: false,
    });

    const cmiFilteredPage = await matterRepo.listVisibleMattersPageWithCount<Matter>(ctx, {
      viewerId: 'P-000001',
      hasRestrictedAccessPermission: true,
      statusId: 'matter_status.cmi_incomplete',
      cmiIncompleteStatusIds: ['matter_status.cmi_incomplete'],
      activeStatusIds: ['matter_status.active'],
      limit: 100,
      offset: 0,
    });
    const cmiIds = new Set(cmiFilteredPage.items.map((m) => m.id));
    expect(cmiIds.has('M-000002')).toBe(true);
    expect(cmiIds.has(verifiedMatterId)).toBe(false);
    expect(cmiIds.has(overriddenMatterId)).toBe(false);
    expect(cmiIds.has(notRequiredMatterId)).toBe(false);
    expect(cmiIds.has(prospectiveMatterId)).toBe(false);

    // (g) computeMatterOpeningChecklistProgress handles Verified, Not required, Overridden
    expect(
      computeMatterOpeningChecklistProgress({
        ...legacyPendingMatter!,
        amlStatus: 'Verified',
      }).amlDone,
    ).toBe(true);
    expect(
      computeMatterOpeningChecklistProgress({
        ...legacyPendingMatter!,
        amlStatus: 'Not required',
      }).amlDone,
    ).toBe(true);
    expect(
      computeMatterOpeningChecklistProgress({
        ...legacyPendingMatter!,
        amlStatus: 'Overridden',
      }).amlDone,
    ).toBe(false);

    // (h) CDD masking for unpermitted viewer (P-000009 finance role without cdd:view)
    await runAsActionActor(
      'P-000009',
      async () => {
        const profile = await loadMatterDetailPageData('P-000009', verifiedMatterId);
        expect(profile).not.toBeNull();
        expect(profile?.kind).toBe('profile');
        if (profile && profile.kind === 'profile') {
          expect(profile.canViewClientCdd).toBe(false);
          expect(profile.matter.amlStatus).toBe('Not available to you');
          expect(profile.matter.amlCompletedAt).toBeNull();
          const maskedSnap = profile.matter.fieldValues?.['matterOpeningSnapshot'] as
            | MatterOpeningSnapshot
            | undefined;
          expect(maskedSnap?.complianceOnboarding.amlStatus).toBe('Not available to you');
          expect(resolveMatterStatusPill(profile.matter, statusValues).label).toBe('Open');
          const rows = resolveMatterIntakeComplianceRows(
            profile.matter,
            { overallRisk: 'Low', completedQuestions: 23, totalQuestions: 23 },
            { canViewClientCdd: profile.canViewClientCdd },
          );
          expect(rows.clientDueDiligence).toEqual({
            verified: false,
            neutral: true,
            label: 'Client due diligence',
            detail: 'Not available to you',
          });
        }

        const homeData = await loadHomePageData('P-000009');
        expect(homeData.canViewCdd).toBe(false);
        const homeVerifiedMatter = homeData.matters.find((m) => m.id === verifiedMatterId);
        expect(homeVerifiedMatter?.amlStatus).toBe('Not available to you');
        expect(homeVerifiedMatter?.amlCompletedAt).toBeNull();
      },
      { roles: ['finance'], mfaVerified: false },
    );
  }, 45_000);
});
