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
  loadAndValidateTenantConfig,
  resolveTenantFromVerifiedToken,
  type RegisterRecord,
  type TenantContext,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import * as actionsModule from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import type { ConflictCheckRecordInput, Matter, Person } from '@/domain/types';
import { setActiveTenantConfigForTesting } from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import * as servicesModule from '@/server/services';
import {
  approveSignOff,
  createRecordFromPms,
  createRegisterRecordService,
  discussSignOff,
  getMatterPmsViewBundle,
  openProspectiveMatterRecord,
  overrideMatterOpeningPreconditionRecord,
  resetAllDemoData,
  saveMatterRecord,
  signOffMatterCostsRecord,
  transitionRegisterRecordService,
  updateMatterConflictRecord,
  updateMatterLifecycleStatusRecord,
} from '@/server/services';
import {
  auditEntriesForRecord,
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
        // Server chooses cmi_incomplete, NOT crafted active/closed!
        expect(nullGovOpen.matter!.matterStatusId).toBe('matter_status.cmi_incomplete');

        // (c) Via saveMatterAction: crafted matterNumber and matterStatusId also ignored
        const actionSaveRes = (await actionsModule.saveMatterAction(
          {
            title: 'S1-05 Action Crafted Bypass Test',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            matterNumber: 'HIJACK-7777',
            matterStatusId: 'matter_status.active',
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
        expect(actionSaveRes.matter!.matterStatusId).toBe('matter_status.cmi_incomplete');

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
        expect(fintechOpen.matter?.matterStatusId).toBe('matter_status.cmi_incomplete');

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
        expect(litOpened.matter?.matterStatusId).toBe('matter_status.cmi_incomplete');
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
        expect(openNow.matter!.matterStatusId).toBe('matter_status.cmi_incomplete');

        // R741: Moving opened matter cmi_incomplete -> active, and Close -> Reopen (closed -> active) are NOT openings and remain ungated!
        const activateRes = await saveMatterRecord(
          {
            title: openNow.matter!.title,
            clientId: openNow.matter!.clientId,
            practiceAreaId: openNow.matter!.practiceAreaId,
            workTypeSubcategoryId: openNow.matter!.workTypeSubcategoryId,
            matterStatusId: 'matter_status.active',
            rowVersion: openNow.matter!.rowVersion,
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
    expect(raceMatterFinal?.matterStatusId).toBe('matter_status.cmi_incomplete');

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
});
