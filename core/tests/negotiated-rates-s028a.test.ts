import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_REQUIRED_SCHEMA_VERSION,
  INVALID_PARENT_ORGANISATION_CODE,
  ORGANISATION_PARENT_CYCLE_CODE,
  RATE_OVERRIDE_DATE_OVERLAP_CODE,
  RATE_OVERRIDE_INVALID_DATE_RANGE_CODE,
  TenantAuditRepository,
  TenantIntakeQuoteRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantPartyRepository,
  TenantPostgresPoolManager,
  TenantRateOverrideRepository,
  doEffectiveDateRangesOverlap,
  loadAndValidateTenantConfig,
  resolveApplicableRatesFromData,
  resolveTenantFromVerifiedToken,
  type ClientRateOverrideRecord,
  type MatterRateOverrideRecord,
  type RateCardFallbackConfig,
  type TenantContext,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import {
  deleteClientRateOverrideAction,
  deleteMatterRateOverrideAction,
  listClientRateOverridesAction,
  listMatterRateOverridesAction,
  resolveApplicableRatesAction,
  reviseQuoteAction,
  saveClientRateOverrideAction,
  saveMatterAction,
  saveMatterCostsConfigAction,
  saveMatterRateOverrideAction,
  saveQuoteAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { createDefaultMatterCostsConfig } from '@/domain/matterCosts';
import type {
  Matter,
  MatterCostsSnapshot,
  Organisation,
  Person,
  Quote,
} from '@/domain/types';
import {
  getActiveTenantRawBaseConfig,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import {
  executeMerge,
  resetAllDemoData,
  saveMatterRecord,
  saveOrganisationRecord,
  signOffMatterCostsRecord,
} from '@/server/services';
import { getAppSnapshot } from '@/server/__tests__/testAppSnapshot';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import {
  auditEntriesSince,
  markAuditPosition,
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

function makeVerifiedTenantCtx(
  tenantId: string,
  actorId = 'P-000004',
  roles: readonly string[] = ['admin', 'partner', 'fee_earner', 'risk_compliance'],
  mfaVerified = true,
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      name: `Test Actor ${actorId}`,
      email: `${actorId.toLowerCase()}@${tenantId}.example`,
      tenantId,
      roles,
      mfaVerified,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s028a-${tenantId}-${actorId}`,
  });
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

describe('S0-28a: Negotiated Client & Parent-Group Rates + 4-Tier Lookup (ADR 0034 §2)', () => {
  const openPoolManagers: TenantPostgresPoolManager[] = [];

  afterEach(async () => {
    setTestActorSession(null);
    setActiveTenantConfigForTesting(null);
    while (openPoolManagers.length > 0) {
      const mgr = openPoolManagers.pop();
      if (mgr) {
        await mgr.closeAllPools();
      }
    }
  });

  it('1. Pure 4-tier rate resolution & effective-date window boundary evaluation', () => {
    const fallbackConfig: RateCardFallbackConfig = {
      rateSourceMode: 'app_table',
      pmsLinkActive: false,
      allowMatterRateOverrides: true,
      rateCards: [
        {
          id: 'RC-DEFAULT',
          name: 'Firm Standard',
          practiceAreaId: null,
          partnerRateGbp: 450,
          associateRateGbp: 300,
          traineeRateGbp: 180,
          customGrades: [{ id: 'counsel', label: 'Senior Counsel', hourlyRateGbp: 550 }],
          active: true,
        },
        {
          id: 'RC-CORP',
          name: 'Corporate Card',
          practiceAreaId: 'work_type.corporate',
          partnerRateGbp: 475,
          associateRateGbp: 325,
          traineeRateGbp: 190,
          customGrades: [{ id: 'counsel', label: 'Senior Counsel', hourlyRateGbp: 600 }],
          active: true,
        },
      ],
    };

    const makeClientOvr = (
      id: string,
      clientId: string,
      practiceAreaId: string | null,
      gradeKey: string,
      rateGbp: number,
      effectiveFrom: string,
      effectiveTo: string | null,
    ): ClientRateOverrideRecord => ({
      id,
      tenantId: 't1',
      clientType: 'organisation',
      clientId,
      practiceAreaId,
      gradeKey,
      rateMinorUnits: Math.round(rateGbp * 100),
      rateGbp,
      currency: 'GBP',
      effectiveFrom,
      effectiveTo,
      notes: '',
      createdById: 'P-000004',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedById: 'P-000004',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const makeMatterOvr = (
      id: string,
      gradeKey: string,
      rateGbp: number,
      effectiveFrom: string,
      effectiveTo: string | null,
    ): MatterRateOverrideRecord => ({
      id,
      tenantId: 't1',
      matterId: 'M-1',
      gradeKey,
      rateMinorUnits: Math.round(rateGbp * 100),
      rateGbp,
      currency: 'GBP',
      effectiveFrom,
      effectiveTo,
      notes: '',
      createdById: 'P-000004',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedById: 'P-000004',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const parentNodes = [
      {
        parentOrganisationId: 'O-PARENT',
        parentOrganisationName: 'Albion Holdings PLC',
        overrides: [
          makeClientOvr('CRO-P1', 'O-PARENT', 'work_type.corporate', 'partner', 400, '2026-01-01', null),
          makeClientOvr('CRO-P2', 'O-PARENT', null, 'associate', 280, '2026-01-01', null),
          makeClientOvr('CRO-P3', 'O-PARENT', null, 'trainee', 160, '2026-01-01', '2026-06-30'),
        ],
      },
      {
        parentOrganisationId: 'O-GRAND',
        parentOrganisationName: 'Albion Global Group',
        overrides: [
          makeClientOvr('CRO-G1', 'O-GRAND', null, 'trainee', 155, '2026-01-01', null),
        ],
      },
    ];

    const directOverrides = [
      // Practice-area specific beats client-wide null
      makeClientOvr('CRO-D1', 'O-CHILD', 'work_type.corporate', 'partner', 360, '2026-03-01', '2026-06-30'),
      makeClientOvr('CRO-D2', 'O-CHILD', null, 'partner', 385, '2026-01-01', null),
      makeClientOvr('CRO-D3', 'O-CHILD', null, 'counsel', 512.55, '2026-01-01', null),
    ];

    const matterOverrides = [
      makeMatterOvr('MRO-1', 'partner', 340, '2026-04-01', '2026-04-30'),
    ];

    // On 2026-04-01 (effectiveFrom exact boundary): Partner hits Tier 1 (340),
    // Associate hits Tier 3 parent org (280), Trainee hits Tier 3 parent org (160),
    // Counsel hits Tier 2 direct client override (512.55 exact pence).
    const onAprilStart = resolveApplicableRatesFromData({
      asAtDate: '2026-04-01',
      practiceAreaId: 'work_type.corporate',
      config: fallbackConfig,
      matterOverrides,
      directClientOverrides: directOverrides,
      parentChainOverrides: parentNodes,
    });
    expect(onAprilStart.grades['partner']).toMatchObject({
      tier: 1,
      source: 'matter_override',
      rateGbp: 340,
      rateMinorUnits: 34000,
      overrideId: 'MRO-1',
    });
    expect(onAprilStart.grades['associate']).toMatchObject({
      tier: 3,
      source: 'client_group_override',
      rateGbp: 280,
      inheritedFromParentOrganisationId: 'O-PARENT',
      inheritedFromParentOrganisationName: 'Albion Holdings PLC',
    });
    expect(onAprilStart.grades['trainee']).toMatchObject({
      tier: 3,
      source: 'client_group_override',
      rateGbp: 160,
      inheritedFromParentOrganisationId: 'O-PARENT',
    });
    expect(onAprilStart.grades['counsel']).toMatchObject({
      tier: 2,
      source: 'client_override',
      rateGbp: 512.55,
      rateMinorUnits: 51255,
    });

    // When allowMatterRateOverrides === false, Tier 1 is bypassed -> Partner drops to Tier 2 PA-specific (360)
    const matterOverridesOff = resolveApplicableRatesFromData({
      asAtDate: '2026-04-30', // exact effectiveTo boundary
      practiceAreaId: 'work_type.corporate',
      config: { ...fallbackConfig, allowMatterRateOverrides: false },
      matterOverrides,
      directClientOverrides: directOverrides,
      parentChainOverrides: parentNodes,
    });
    expect(matterOverridesOff.grades['partner']).toMatchObject({
      tier: 2,
      source: 'client_override',
      rateGbp: 360,
      overrideId: 'CRO-D1',
      overrideScopePracticeAreaId: 'work_type.corporate',
    });

    // On 2026-07-01: CRO-D1 (ended 2026-06-30) expired -> Partner falls back to Tier 2 client-wide null (385);
    // CRO-P3 expired -> Trainee falls back to Grandparent O-GRAND (155);
    // Switching to another practice area without overrides drops non-overridden grades to Tier 4 card.
    const onJuly = resolveApplicableRatesFromData({
      asAtDate: '2026-07-01',
      practiceAreaId: 'work_type.corporate',
      config: fallbackConfig,
      matterOverrides,
      directClientOverrides: directOverrides,
      parentChainOverrides: parentNodes,
    });
    expect(onJuly.grades['partner']).toMatchObject({
      tier: 2,
      source: 'client_override',
      rateGbp: 385,
      overrideId: 'CRO-D2',
      overrideScopePracticeAreaId: null,
    });
    expect(onJuly.grades['trainee']).toMatchObject({
      tier: 3,
      source: 'client_group_override',
      rateGbp: 155,
      inheritedFromParentOrganisationId: 'O-GRAND',
    });

    const tier4Only = resolveApplicableRatesFromData({
      asAtDate: '2026-07-01',
      practiceAreaId: 'work_type.corporate',
      config: fallbackConfig,
      matterOverrides: [],
      directClientOverrides: [],
      parentChainOverrides: [],
    });
    expect(tier4Only.dominantTier).toBe(4);
    expect(tier4Only.dominantSource).toBe('app_table');
    expect(tier4Only.partnerRateGbp).toBe(475);
    expect(tier4Only.associateRateGbp).toBe(325);

    // Date overlap helper checks (adjacent allowed, inclusive boundary overlaps)
    expect(doEffectiveDateRangesOverlap('2026-01-01', '2026-06-30', '2026-07-01', null)).toBe(false);
    expect(doEffectiveDateRangesOverlap('2026-01-01', '2026-06-30', '2026-06-30', '2026-12-31')).toBe(true);
    expect(doEffectiveDateRangesOverlap('2026-01-01', null, '2027-05-01', '2027-06-01')).toBe(true);
  });

  it('2. PostgreSQL CRUD, concurrency-safe RATE_OVERRIDE_DATE_OVERLAP, and parent-org cycle / merged guards', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const rateRepo = new TenantRateOverrideRepository();
    const partyRepo = new TenantPartyRepository();
    const seed = createSeedStore();
    const orgChild = seed.organisations.find((o) => !o.mergedIntoId)!;
    const personClient = seed.people.find((p) => !p.isEmployee && !p.mergedIntoId)!;

    // Invalid date order rejected with explicit code + message
    await expect(
      rateRepo.upsertClientRateOverride(ctx, {
        clientType: 'organisation',
        clientId: orgChild.id,
        practiceAreaId: null,
        gradeKey: 'partner',
        rateGbp: 350,
        effectiveFrom: '2026-06-01',
        effectiveTo: '2026-05-31',
        byId: 'P-000004',
      }),
    ).rejects.toMatchObject({
      code: RATE_OVERRIDE_INVALID_DATE_RANGE_CODE,
      message: expect.stringContaining(RATE_OVERRIDE_INVALID_DATE_RANGE_CODE),
    });

    await runAsActionActor(
      'P-000004',
      async () => {
        // Save valid client override for Organisation and adjacent second window
        const first = await saveClientRateOverrideAction({
          clientType: 'organisation',
          clientId: orgChild.id,
          practiceAreaId: 'work_type.corporate_and_commercial',
          gradeKey: 'partner',
          rateGbp: 345,
          effectiveFrom: '2026-01-01',
          effectiveTo: '2026-06-30',
          notes: 'H1 2026 framework rate',
        });
        expect(isActionDenied(first)).toBe(false);
        expect(first.override?.rateMinorUnits).toBe(34500);

        const adjacent = await saveClientRateOverrideAction({
          clientType: 'organisation',
          clientId: orgChild.id,
          practiceAreaId: 'work_type.corporate_and_commercial',
          gradeKey: 'partner',
          rateGbp: 360,
          effectiveFrom: '2026-07-01',
          effectiveTo: null,
          notes: 'H2 2026 onwards',
        });
        expect(adjacent.error).toBeUndefined();
        expect(adjacent.override?.rateGbp).toBe(360);

        // Overlapping date window for same (clientId, practiceAreaId, gradeKey) rejected with RATE_OVERRIDE_DATE_OVERLAP
        const overlap = await saveClientRateOverrideAction({
          clientType: 'organisation',
          clientId: orgChild.id,
          practiceAreaId: 'work_type.corporate_and_commercial',
          gradeKey: 'partner',
          rateGbp: 340,
          effectiveFrom: '2026-06-15',
          effectiveTo: '2026-08-01',
        });
        expect(overlap.override).toBeUndefined();
        expect(overlap.code).toBe(RATE_OVERRIDE_DATE_OVERLAP_CODE);
        expect(overlap.message).toContain(RATE_OVERRIDE_DATE_OVERLAP_CODE);

        // Different practiceAreaId (including null client-wide) does NOT collide
        const clientDefault = await saveClientRateOverrideAction({
          clientType: 'organisation',
          clientId: orgChild.id,
          practiceAreaId: null,
          gradeKey: 'partner',
          rateGbp: 380,
          effectiveFrom: '2026-01-01',
          effectiveTo: null,
        });
        expect(clientDefault.error).toBeUndefined();

        // Overlapping null-scope client override collides with clientDefault
        const nullOverlap = await saveClientRateOverrideAction({
          clientType: 'organisation',
          clientId: orgChild.id,
          practiceAreaId: null,
          gradeKey: 'partner',
          rateGbp: 375,
          effectiveFrom: '2026-05-01',
          effectiveTo: '2026-12-31',
        });
        expect(nullOverlap.code).toBe(RATE_OVERRIDE_DATE_OVERLAP_CODE);

        // Individual Person client override works too
        const personOvr = await saveClientRateOverrideAction({
          clientType: 'person',
          clientId: personClient.id,
          practiceAreaId: null,
          gradeKey: 'associate',
          rateGbp: 225,
          effectiveFrom: '2026-01-01',
          effectiveTo: null,
        });
        expect(personOvr.override?.clientType).toBe('person');
        expect(personOvr.override?.rateMinorUnits).toBe(22500);
      },
      { mfaVerified: true },
    );

    // Concurrency test: two simultaneous overlapping inserts -> exactly one succeeds and one rejects with RATE_OVERRIDE_DATE_OVERLAP
    const concurrentResults = await Promise.allSettled([
      rateRepo.upsertClientRateOverride(ctx, {
        clientType: 'organisation',
        clientId: orgChild.id,
        practiceAreaId: null,
        gradeKey: 'trainee',
        rateGbp: 145,
        effectiveFrom: '2026-02-01',
        effectiveTo: '2026-10-31',
        byId: 'P-000004',
      }),
      rateRepo.upsertClientRateOverride(ctx, {
        clientType: 'organisation',
        clientId: orgChild.id,
        practiceAreaId: null,
        gradeKey: 'trainee',
        rateGbp: 150,
        effectiveFrom: '2026-04-01',
        effectiveTo: '2026-12-31',
        byId: 'P-000004',
      }),
    ]);
    const fulfilledCount = concurrentResults.filter((r) => r.status === 'fulfilled').length;
    const rejectedOverlap = concurrentResults.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilledCount).toBe(1);
    expect(rejectedOverlap).toHaveLength(1);
    expect((rejectedOverlap[0]!.reason as { code?: string }).code).toBe(
      RATE_OVERRIDE_DATE_OVERLAP_CODE,
    );

    // Parent-org cycle, self-parenting & merged-parent checks + Tier 3 merged_into_id IS NULL filtering
    await runAsActionActor(
      'P-000004',
      async () => {
        const gpSave = await saveOrganisationRecord(
          { legalName: 'Albion Grandparent Holdings Ltd' },
          { byId: 'P-000004' },
        );
        expect(gpSave.errors).toBeUndefined();
        const gpOrg = gpSave.organisation;

        const parentSave = await saveOrganisationRecord(
          {
            legalName: 'Albion Intermediate Parent Ltd',
            parentOrganisationId: gpOrg.id,
          },
          { byId: 'P-000004' },
        );
        expect(parentSave.errors).toBeUndefined();
        const midParent = parentSave.organisation;

        const childSave = await saveOrganisationRecord(
          {
            legalName: 'Albion Operating Subsidiary Ltd',
            parentOrganisationId: midParent.id,
          },
          { byId: 'P-000004' },
        );
        expect(childSave.errors).toBeUndefined();
        const childSub = childSave.organisation;

        // Self-parenting rejected
        const selfParentRes = await saveOrganisationRecord(
          {
            ...gpOrg,
            parentOrganisationId: gpOrg.id,
          },
          { id: gpOrg.id, byId: 'P-000004' },
        );
        expect(selfParentRes.code).toBe(ORGANISATION_PARENT_CYCLE_CODE);
        expect(selfParentRes.errors?.parentOrganisationId).toContain(
          ORGANISATION_PARENT_CYCLE_CODE,
        );

        // Transitive cycle (gpOrg -> childSub -> midParent -> gpOrg) rejected
        const cycleRes = await saveOrganisationRecord(
          {
            ...gpOrg,
            parentOrganisationId: childSub.id,
          },
          { id: gpOrg.id, byId: 'P-000004' },
        );
        expect(cycleRes.code).toBe(ORGANISATION_PARENT_CYCLE_CODE);

        // Tier 3 resolves from midParent while active, and skips merged parent if marked merged_into_id
        await rateRepo.upsertClientRateOverride(ctx, {
          clientType: 'organisation',
          clientId: midParent.id,
          practiceAreaId: null,
          gradeKey: 'associate',
          rateGbp: 240,
          effectiveFrom: '2026-01-01',
          effectiveTo: null,
          byId: 'P-000004',
        });
        const resolvedBeforeMerge = await rateRepo.resolveApplicableRates(ctx, {
          clientId: childSub.id,
          asAtDate: '2026-06-01',
        });
        expect(resolvedBeforeMerge.grades['associate']).toMatchObject({
          tier: 3,
          source: 'client_group_override',
          rateGbp: 240,
          inheritedFromParentOrganisationId: midParent.id,
        });

        // Soft-delete / merge midParent directly in DB -> Tier 3 ignores merged parent org
        // AND linking a merged parent fails closed with INVALID_PARENT_ORGANISATION
        await partyRepo.putOrganisation(ctx, {
          ...midParent,
          mergedIntoId: gpOrg.id,
        });
        const resolvedWithMergedParent = await rateRepo.resolveApplicableRates(ctx, {
          clientId: childSub.id,
          asAtDate: '2026-06-01',
        });
        expect(resolvedWithMergedParent.grades['associate']?.tier).toBe(4);

        const linkMergedParent = await saveOrganisationRecord(
          {
            legalName: 'Invalid Child Linking Merged Parent Ltd',
            parentOrganisationId: midParent.id,
          },
          { byId: 'P-000004' },
        );
        expect(linkMergedParent.code).toBe(INVALID_PARENT_ORGANISATION_CODE);
        expect(linkMergedParent.message).toContain(INVALID_PARENT_ORGANISATION_CODE);
      },
      { mfaVerified: true },
    );
  });

  it('3. Permission enforcement, restricted/ethical-wall matter denial, allowMatterRateOverrides toggle & same-TX audit rollback', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const seed = createSeedStore();
    const rateRepo = new TenantRateOverrideRepository();
    const targetOrg = seed.organisations.find((o) => !o.mergedIntoId)!;
    const partner = seed.people.find((p) => p.id === 'P-000001')!;
    const feeEarner = seed.people.find((p) => p.id === 'P-000002')!;
    const enquiriesCoord = seed.people.find((p) => p.id === 'P-000042')!;

    // Enquiries Coordinator (quote:view only, no finance:view_matter/finance:view/admin:access)
    // is denied listing or mutating client/matter rate override schedules, whilst allowed to resolve rates for quotes
    await runAsActionActor(enquiriesCoord.id, async () => {
      const deniedList = await listClientRateOverridesAction({
        clientType: 'organisation',
        clientId: targetOrg.id,
      });
      expect(isActionDenied(deniedList)).toBe(true);

      const deniedSave = await saveClientRateOverrideAction({
        clientType: 'organisation',
        clientId: targetOrg.id,
        practiceAreaId: null,
        gradeKey: 'partner',
        rateGbp: 150,
        effectiveFrom: '2026-01-01',
      });
      expect(isActionDenied(deniedSave)).toBe(true);

      const deniedMatterList = await listMatterRateOverridesAction('M-000011');
      expect(isActionDenied(deniedMatterList)).toBe(true);

      const okResolveForQuote = await resolveApplicableRatesAction({
        clientId: targetOrg.id,
        clientType: 'organisation',
        practiceAreaId: 'work_type.corporate_and_commercial',
      });
      expect(isActionDenied(okResolveForQuote)).toBe(false);
    });

    // Fee earner CAN list/resolve client rates, CANNOT create/delete client overrides
    let createdOverrideId = '';
    await runAsActionActor(feeEarner.id, async () => {
      const okList = await listClientRateOverridesAction({
        clientType: 'organisation',
        clientId: targetOrg.id,
      });
      expect(isActionDenied(okList)).toBe(false);

      const okResolve = await resolveApplicableRatesAction({
        clientId: targetOrg.id,
        clientType: 'organisation',
        practiceAreaId: 'work_type.corporate_and_commercial',
      });
      expect(isActionDenied(okResolve)).toBe(false);

      const deniedClientSave = await saveClientRateOverrideAction({
        clientType: 'organisation',
        clientId: targetOrg.id,
        practiceAreaId: null,
        gradeKey: 'partner',
        rateGbp: 200,
        effectiveFrom: '2026-01-01',
      });
      expect(isActionDenied(deniedClientSave)).toBe(true);
    });

    // Partner CAN create, update, and delete client overrides and writes same-TX audit_entries
    const markBeforeCrud = await markAuditPosition();
    await runAsActionActor(partner.id, async () => {
      const saved = await saveClientRateOverrideAction({
        clientType: 'organisation',
        clientId: targetOrg.id,
        practiceAreaId: null,
        gradeKey: 'partner',
        rateGbp: 330,
        effectiveFrom: '2026-01-01',
        notes: 'Partner approved client schedule',
      });
      expect(isActionDenied(saved)).toBe(false);
      expect(saved.override?.rateGbp).toBe(330);
      createdOverrideId = saved.override!.id;
    });

    const auditsAfterCreate = await auditEntriesSince(markBeforeCrud);
    expect(
      auditsAfterCreate.some(
        (a) =>
          a.recordType === 'client_rate_override' &&
          a.recordId === createdOverrideId &&
          a.action === 'create',
      ),
    ).toBe(true);
    expect(
      auditsAfterCreate.some(
        (a) =>
          a.recordType === 'organisation' &&
          a.recordId === targetOrg.id &&
          a.action === 'rate-override-upsert',
      ),
    ).toBe(true);

    // Same-TX atomicity: forced error rolls back BOTH override write and audit entry
    const markBeforeRollback = await markAuditPosition();
    const countBefore = await rateRepo.countAllTenantRateOverrideRows(ctx);
    await expect(
      rateRepo.withTenantTransaction(ctx, async () => {
        await rateRepo.upsertClientRateOverride(
          ctx,
          {
            clientType: 'organisation',
            clientId: targetOrg.id,
            practiceAreaId: null,
            gradeKey: 'trainee',
            rateGbp: 120,
            effectiveFrom: '2026-01-01',
            byId: partner.id,
          },
          [
            {
              recordType: 'client_rate_override',
              recordId: 'CRO-SHOULD-ROLLBACK',
              action: 'create',
              field: 'Rollback test',
              oldValue: null,
              newValue: 'should roll back',
              byId: partner.id,
              at: new Date().toISOString(),
            },
          ],
        );
        throw new Error('SIMULATED_TX_FAILURE');
      }),
    ).rejects.toThrow(/SIMULATED_TX_FAILURE/);

    const countAfter = await rateRepo.countAllTenantRateOverrideRows(ctx);
    expect(countAfter).toEqual(countBefore);
    const auditsAfterRollback = await auditEntriesSince(markBeforeRollback);
    expect(
      auditsAfterRollback.some((a) => a.recordId === 'CRO-SHOULD-ROLLBACK'),
    ).toBe(false);

    // Restricted staff/ethical-wall matter access check on matter_rate_overrides
    const templateMatter = seed.matters.find((m) => m.id === 'M-000011')!;
    const { id: _omitId, ...matterBase } = templateMatter;
    void _omitId;
    const staffMatterRaw = await runAsActionActor(
      partner.id,
      async () => {
        const staffMatterRes = await saveMatterRecord(
          {
            ...matterBase,
            matterNumber: 'DRAFT',
            openedAt: null,
            engagementLetterStatus: 'Sent',
            engagementLetterSignedAt: null,
            title: 'Restricted Ethical Wall Rate Matter',
            clientId: partner.id,
            leadFeeEarnerId: partner.id,
            responsiblePartnerId: partner.id,
            supervisingPartnerId: partner.id,
            relationshipPartnerId: partner.id,
            teamMemberIds: [partner.id],
            fieldValues: {
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
            },
          },
          { byId: partner.id, saveMode: 'draft' },
        );
        expect(staffMatterRes.matter).not.toBeNull();
        return staffMatterRes.matter!;
      },
      { mfaVerified: true },
    );
    const matterRepo = new TenantMatterRepository();
    const staffMatter = await matterRepo.putMatter<Matter>(
      ctx,
      {
        ...staffMatterRaw,
        isStaffMatter: true,
        hasEthicalWall: true,
        restrictedAccessUserIds: [partner.id],
      },
      {
        expectedRowVersion: staffMatterRaw.rowVersion,
        sqlRestrictedAccessUserIds: [partner.id],
      },
    );

    // Excluded feeEarner (P-000002) MUST be denied on restricted matter rate overrides
    await runAsActionActor(feeEarner.id, async () => {
      const deniedList = await listMatterRateOverridesAction(staffMatter.id);
      expect(isActionDenied(deniedList)).toBe(true);

      const deniedSave = await saveMatterRateOverrideAction({
        matterId: staffMatter.id,
        gradeKey: 'partner',
        rateGbp: 250,
        effectiveFrom: '2026-01-01',
      });
      expect(isActionDenied(deniedSave)).toBe(true);

      const deniedResolve = await resolveApplicableRatesAction({
        matterId: staffMatter.id,
      });
      expect(isActionDenied(deniedResolve)).toBe(true);
    });

    // Permitted partner CAN create Tier 1 matter rate override, overlap fails with RATE_OVERRIDE_DATE_OVERLAP,
    // and disabling allowMatterRateOverrides blocks new matter rate overrides while preserving Tier 2 client rates.
    await runAsActionActor(
      partner.id,
      async () => {
        const mOvr1 = await saveMatterRateOverrideAction({
          matterId: staffMatter.id,
          gradeKey: 'partner',
          rateGbp: 295,
          effectiveFrom: '2026-01-01',
          effectiveTo: null,
        });
        expect(isActionDenied(mOvr1)).toBe(false);
        expect(mOvr1.override?.rateGbp).toBe(295);

        const mOverlap = await saveMatterRateOverrideAction({
          matterId: staffMatter.id,
          gradeKey: 'partner',
          rateGbp: 290,
          effectiveFrom: '2026-05-01',
        });
        expect(mOverlap.code).toBe(RATE_OVERRIDE_DATE_OVERLAP_CODE);

        const resolvedWithTier1 = await resolveApplicableRatesAction({
          matterId: staffMatter.id,
        });
        expect(resolvedWithTier1.resolved?.grades['partner']).toMatchObject({
          tier: 1,
          source: 'matter_override',
          rateGbp: 295,
        });

        const delOvr = await deleteMatterRateOverrideAction(mOvr1.override!.id);
        expect(delOvr.deleted).toBe(true);
      },
      { mfaVerified: true },
    );

    // Disable allowMatterRateOverrides -> saving matter rate override fails with MATTER_RATE_OVERRIDES_DISABLED
    const baseCfg = createDefaultMatterCostsConfig(seed.values, {
      clientProfileCode: 'not-a-law-firm',
    });
    await runAsActionActor(
      'P-000004',
      async () => {
        await saveMatterCostsConfigAction({
          ...baseCfg,
          allowMatterRateOverrides: false,
        });
      },
      { mfaVerified: true },
    );

    await runAsActionActor(partner.id, async () => {
      const blockedMatterOvr = await saveMatterRateOverrideAction({
        matterId: staffMatter.id,
        gradeKey: 'partner',
        rateGbp: 295,
        effectiveFrom: '2026-01-01',
      });
      expect(blockedMatterOvr.code).toBe('MATTER_RATE_OVERRIDES_DISABLED');

      const delClientRes = await deleteClientRateOverrideAction(createdOverrideId);
      expect(delClientRes.deleted).toBe(true);
    });
  });

  it('4. Quotes, Matter Costs, Sign-Off integration & immutable snapshots (S0-23 + S0-28a)', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const seed = createSeedStore();
    const rateRepo = new TenantRateOverrideRepository();

    const { parentOrg, childOrg } = await runAsActionActor('P-000004', async () => {
      const parentOrgRes = await saveOrganisationRecord(
        { legalName: 'Pennine Parent Holdings Ltd' },
        { byId: 'P-000004' },
      );
      const pOrg = parentOrgRes.organisation;
      const childOrgRes = await saveOrganisationRecord(
        {
          legalName: 'Pennine Freight Operations Ltd',
          parentOrganisationId: pOrg.id,
        },
        { byId: 'P-000004' },
      );
      return { parentOrg: pOrg, childOrg: childOrgRes.organisation };
    });

    // Tier 3 Associate rate on parent (235) & Tier 2 Partner rate directly on child (315)
    const parentAssocOvr = await rateRepo.upsertClientRateOverride(ctx, {
      clientType: 'organisation',
      clientId: parentOrg.id,
      practiceAreaId: null,
      gradeKey: 'associate',
      rateGbp: 235,
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      byId: 'P-000004',
    });
    const childPartnerOvr = await rateRepo.upsertClientRateOverride(ctx, {
      clientType: 'organisation',
      clientId: childOrg.id,
      practiceAreaId: 'work_type.corporate_and_commercial',
      gradeKey: 'partner',
      rateGbp: 315,
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      byId: 'P-000004',
    });

    // Create Hourly Quote without specifying hourlyRateGbp -> automatically picks up Tier 3 Associate £235
    let quoteId = '';
    await runAsActionActor('P-000004', async () => {
      const qRes = await saveQuoteAction({
        clientType: 'existing',
        linkedOrganisationId: childOrg.id,
        practiceAreaId: 'work_type.corporate_and_commercial',
        scope: 'Negotiated commercial contract review',
        feeBasis: 'Hourly rate with estimate',
        feeAmountExVat: 4700,
        disbursements: [],
        validUntil: '2026-12-31',
        feeEarnerId: 'P-000001',
        followUpAfterDays: 7,
        rateGradeKey: 'associate',
      });
      expect(qRes.error).toBeUndefined();
      expect(qRes.quote).toBeDefined();
      quoteId = qRes.quote!.id;
      expect(qRes.quote!.hourlyRateGbp).toBe(235);
      expect(qRes.quote!.rateSource).toBe('client_group_override');
      expect(qRes.quote!.rateTier).toBe(3);
      expect(qRes.quote!.rateProvenanceByGrade?.['partner']).toMatchObject({
        tier: 2,
        rateGbp: 315,
      });
    });

    // Fresh DB readback verifies pricing_breakdown_json persistence
    const freshQuoteRepo = new TenantIntakeQuoteRepository();
    const persistedQuote = (await freshQuoteRepo.getQuoteById<Quote>(ctx, quoteId))!;
    expect(persistedQuote.hourlyRateGbp).toBe(235);
    expect(persistedQuote.rateSource).toBe('client_group_override');
    expect(persistedQuote.rateTier).toBe(3);

    // Update parent associate override to £255 -> existing quote remains frozen at £235,
    // while revising quote with Partner grade picks up Tier 2 £315 and archives v1 Tier 3 provenance
    await rateRepo.upsertClientRateOverride(ctx, {
      id: parentAssocOvr.id,
      clientType: 'organisation',
      clientId: parentOrg.id,
      practiceAreaId: null,
      gradeKey: 'associate',
      rateGbp: 255,
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      byId: 'P-000004',
    });

    const quoteAfterRateChange = (await freshQuoteRepo.getQuoteById<Quote>(ctx, quoteId))!;
    expect(quoteAfterRateChange.hourlyRateGbp).toBe(235);

    await runAsActionActor('P-000004', async () => {
      const revised = await reviseQuoteAction(quoteId, {
        feeBasis: 'Hourly rate with estimate',
        feeAmountExVat: 6300,
        rateGradeKey: 'partner',
        scope: 'Partner-led review',
        revisionNote: 'Upgraded to Partner rate',
        refreshRates: true,
      });
      expect(revised.error).toBeUndefined();
      expect(revised.quote?.hourlyRateGbp).toBe(315);
      expect(revised.quote?.rateTier).toBe(2);
      expect(revised.quote?.rateSource).toBe('client_override');
      expect(revised.quote?.versionHistory[0]?.hourlyRateGbp).toBe(235);
      expect(revised.quote?.versionHistory[0]?.rateTier).toBe(3);
      expect(revised.quote?.versionHistory[0]?.rateSource).toBe('client_group_override');
    });

    // Disable allowMatterRateOverrides -> Matter save STILL accepts Tier 2/3 negotiated baseline (partner=315, associate=235)
    const baseCfg = createDefaultMatterCostsConfig(seed.values, {
      clientProfileCode: 'not-a-law-firm',
    });
    await runAsActionActor(
      'P-000004',
      async () => {
        await saveMatterCostsConfigAction({
          ...baseCfg,
          allowMatterRateOverrides: false,
        });
      },
      { mfaVerified: true },
    );

    const templateMatter = seed.matters.find((m) => m.id === 'M-000011')!;
    const { id: _omitId, ...matterBase } = templateMatter;
    void _omitId;
    const lookedUpCard = (await rateRepo.resolveApplicableRates(ctx, {
      clientId: childOrg.id,
      practiceAreaId: 'work_type.corporate_and_commercial',
    }));

    let matterId = '';
    await runAsActionActor('P-000004', async () => {
      const mRes = await saveMatterAction(
        {
          ...matterBase,
          matterNumber: 'DRAFT',
          openedAt: null,
          engagementLetterStatus: 'Sent',
          engagementLetterSignedAt: null,
          title: 'Pennine Freight Negotiated Matter',
          clientId: childOrg.id,
          practiceAreaId: 'work_type.corporate_and_commercial',
          leadFeeEarnerId: 'P-000001',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          teamMemberIds: ['P-000001'],
          feeEstimateGbp: 8000,
          fieldValues: {
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
            matterCosts: {
              workBasis: 'hourly_rates',
              rateCardId: lookedUpCard.rateCardId,
              rateCardName: lookedUpCard.rateCardName,
              rateSource: lookedUpCard.dominantSource,
              partnerRateGbp: lookedUpCard.partnerRateGbp,
              associateRateGbp: lookedUpCard.associateRateGbp,
              traineeRateGbp: lookedUpCard.traineeRateGbp,
              customGrades: [],
              totalEstimateGbp: 8000,
              agreedCapGbp: null,
              disbursements: [],
              disbursementsTotalGbp: 0,
              paymentOnAccountRequired: 'No',
              paymentOnAccountAmountGbp: null,
            } satisfies Partial<MatterCostsSnapshot>,
          },
        },
        { saveMode: 'draft' },
      );
      expect(isActionDenied(mRes)).toBe(false);
      expect((mRes as { errors?: Record<string, string> }).errors).toBeUndefined();
      const savedMatter = (mRes as { matter: Matter | null }).matter!;
      expect(savedMatter).not.toBeNull();
      matterId = savedMatter.id;
      const costsSnap = savedMatter.fieldValues['matterCosts'] as MatterCostsSnapshot;
      expect(costsSnap.partnerRateGbp).toBe(315);
      expect(costsSnap.associateRateGbp).toBe(255);
      expect(costsSnap.rateTier).toBe(2);
      expect(costsSnap.rateSource).toBe('client_override');
    });

    // Sign off costs, then change child Partner override to £390 -> frozen signed-off snapshot stays £315
    await runAsActionActor(
      'P-000004',
      async () => {
        const signOffRes = await signOffMatterCostsRecord(
          matterId,
          'P-000004',
          'Signed off at negotiated Tier 2/3 rates',
        );
        expect(signOffRes.errors).toBeUndefined();
      },
      { mfaVerified: true },
    );

    await rateRepo.upsertClientRateOverride(ctx, {
      id: childPartnerOvr.id,
      clientType: 'organisation',
      clientId: childOrg.id,
      practiceAreaId: 'work_type.corporate_and_commercial',
      gradeKey: 'partner',
      rateGbp: 390,
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      byId: 'P-000004',
    });

    const freshMatterRepo = new TenantMatterRepository();
    const matterAfterUpdate = (await freshMatterRepo.getMatterById<Matter>(ctx, matterId))!;
    const frozenCosts = matterAfterUpdate.fieldValues['matterCosts'] as MatterCostsSnapshot;
    expect(frozenCosts.partnerRateGbp).toBe(315);
    expect(frozenCosts.rateSource).toBe('client_override');
  });

  it('5. executeMerge reconciles colliding & non-colliding client_rate_overrides for Organisations and People', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const rateRepo = new TenantRateOverrideRepository();

    const { survOrg, mergedOrg } = await runAsActionActor('P-000004', async () => {
      const survOrgRes = await saveOrganisationRecord(
        { legalName: 'Cumbria Engineering Group Ltd' },
        { byId: 'P-000004' },
      );
      const mergedOrgRes = await saveOrganisationRecord(
        { legalName: 'Cumbria Engineering Legacy Ltd' },
        { byId: 'P-000004' },
      );
      return { survOrg: survOrgRes.organisation, mergedOrg: mergedOrgRes.organisation };
    });

    // Colliding survivor + merged overrides on (null, 'partner', 2026) -> survivor £340 kept, merged £299 removed
    await rateRepo.upsertClientRateOverride(ctx, {
      clientType: 'organisation',
      clientId: survOrg.id,
      practiceAreaId: null,
      gradeKey: 'partner',
      rateGbp: 340,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      notes: 'Survivor negotiated rate',
      byId: 'P-000004',
    });
    const collidingMerged = await rateRepo.upsertClientRateOverride(ctx, {
      clientType: 'organisation',
      clientId: mergedOrg.id,
      practiceAreaId: null,
      gradeKey: 'partner',
      rateGbp: 299,
      effectiveFrom: '2026-06-01',
      effectiveTo: '2026-12-31',
      notes: 'Colliding merged rate',
      byId: 'P-000004',
    });
    // Non-overlapping override on mergedOrg (trainee grade) -> repointed to survOrg
    const repointedMerged = await rateRepo.upsertClientRateOverride(ctx, {
      clientType: 'organisation',
      clientId: mergedOrg.id,
      practiceAreaId: null,
      gradeKey: 'trainee',
      rateGbp: 140,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      notes: 'Repointed trainee override',
      byId: 'P-000004',
    });

    const mergeRes = await runAsActionActor('P-000004', () =>
      executeMerge('organisation', survOrg.id, mergedOrg.id, 'P-000004'),
    );
    expect(mergeRes.code).toBeUndefined();

    const survOverrides = await rateRepo.listClientRateOverrides(ctx, {
      clientId: survOrg.id,
      clientType: 'organisation',
    });
    const mergedOverridesAfter = await rateRepo.listClientRateOverrides(ctx, {
      clientId: mergedOrg.id,
    });
    expect(mergedOverridesAfter).toHaveLength(0);
    expect(survOverrides.find((o) => o.gradeKey === 'partner')?.rateGbp).toBe(340);
    expect(survOverrides.find((o) => o.id === collidingMerged.id)).toBeUndefined();
    expect(survOverrides.find((o) => o.id === repointedMerged.id)).toMatchObject({
      clientId: survOrg.id,
      gradeKey: 'trainee',
      rateGbp: 140,
    });

    const auditRepo = new TenantAuditRepository();
    const orgAudits = await auditRepo.listAuditEntriesForRecord(ctx, 'organisation', survOrg.id);
    expect(
      orgAudits.some(
        (a) => a.action === 'merge' && a.field === 'clientRateOverrides',
      ),
    ).toBe(true);

    // Person merge reconciliation (`client_type = 'person'`)
    const partyRepo = new TenantPartyRepository();
    const seedStore = createSeedStore();
    const basePerson = seedStore.people.find((p) => !p.isEmployee && !p.mergedIntoId)!;
    const personSurv: Person = {
      ...basePerson,
      id: 'P-S028A-SURV',
      firstName: 'Arthur',
      surname: 'Pendelton',
      emails: [{ id: 'em-s', address: 'arthur.surv@example.test', isPrimary: true, typeId: null }],
    };
    const personMerged: Person = {
      ...basePerson,
      id: 'P-S028A-MERG',
      firstName: 'Art',
      surname: 'Pendelton',
      emails: [{ id: 'em-m', address: 'arthur.merg@example.test', isPrimary: true, typeId: null }],
    };
    await partyRepo.putPeople(ctx, [personSurv, personMerged]);
    const personOvr = await rateRepo.upsertClientRateOverride(ctx, {
      clientType: 'person',
      clientId: personMerged.id,
      practiceAreaId: null,
      gradeKey: 'associate',
      rateGbp: 215,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      byId: 'P-000004',
    });
    const personMergeRes = await runAsActionActor('P-000004', () =>
      executeMerge('person', personSurv.id, personMerged.id, 'P-000004'),
    );
    expect(personMergeRes.code).toBeUndefined();
    const personSurvOvrs = await rateRepo.listClientRateOverrides(ctx, {
      clientId: personSurv.id,
      clientType: 'person',
    });
    expect(personSurvOvrs.find((o) => o.id === personOvr.id)).toMatchObject({
      clientId: personSurv.id,
      clientType: 'person',
      rateGbp: 215,
    });
  });

  it('6. Two-tenant PostgreSQL isolation (P8): fresh-connection checks, tampered override IDs, cross-tenant parent org & forged TenantContext', async () => {
    const tenantAlpha = 's028a-alpha';
    const tenantBravo = 's028a-bravo';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });

    const ctxAlpha = makeVerifiedTenantCtx(tenantAlpha, 'P-000004');
    const ctxBravo = makeVerifiedTenantCtx(tenantBravo, 'P-000004');

    const migrationRunner = new TenantMigrationRunner();
    await migrationRunner.applyUp(ctxAlpha);
    await migrationRunner.applyUp(ctxBravo);
    expect(Number(CORE_REQUIRED_SCHEMA_VERSION)).toBeGreaterThanOrEqual(22);

    const alphaRaw = {
      ...getActiveTenantRawBaseConfig(),
      tenantId: tenantAlpha,
      displayName: 'Alpha Legal LLP',
      environment: 'test' as const,
      hostingMode: 'multi_tenant' as const,
    };
    const bravoRaw = {
      ...getActiveTenantRawBaseConfig(),
      tenantId: tenantBravo,
      displayName: 'Bravo Solicitors LLP',
      environment: 'test' as const,
      hostingMode: 'multi_tenant' as const,
    };
    const alphaValidated = loadAndValidateTenantConfig(alphaRaw, {}, 'test', 'multi_tenant');
    const bravoValidated = loadAndValidateTenantConfig(bravoRaw, {}, 'test', 'multi_tenant');

    const alphaSeed = createSeedStore();
    const bravoSeed = createSeedStore();
    await importFirmStoreModulesToPostgres({
      ctx: ctxAlpha,
      tenantConfig: alphaValidated,
      store: alphaSeed,
      clearFirst: true,
    });
    await importFirmStoreModulesToPostgres({
      ctx: ctxBravo,
      tenantConfig: bravoValidated,
      store: bravoSeed,
      clearFirst: true,
    });

    const rateRepo = new TenantRateOverrideRepository();

    const alphaOrg = alphaSeed.organisations.find((o) => !o.mergedIntoId)!;
    const bravoOrg = bravoSeed.organisations.find((o) => !o.mergedIntoId)!;

    // Seed Alpha negotiated rate overrides (second override CRO-000002 has an ID not present in Bravo)
    await rateRepo.upsertClientRateOverride(
      ctxAlpha,
      {
        clientType: 'organisation',
        clientId: alphaOrg.id,
        practiceAreaId: null,
        gradeKey: 'associate',
        rateGbp: 210,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        byId: 'P-000004',
      },
    );
    const alphaOverride = await rateRepo.upsertClientRateOverride(
      ctxAlpha,
      {
        clientType: 'organisation',
        clientId: alphaOrg.id,
        practiceAreaId: null,
        gradeKey: 'partner',
        rateGbp: 275,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        notes: 'Alpha strictly isolated rate',
        byId: 'P-000004',
      },
      [
        {
          recordType: 'client_rate_override',
          recordId: 'CRO-ALPHA-AUDIT',
          action: 'create',
          field: 'Negotiated rate',
          oldValue: null,
          newValue: '£275/hr',
          byId: 'P-000004',
          at: new Date().toISOString(),
        },
      ],
    );

    // Seed distinct Bravo negotiated rate override
    await rateRepo.upsertClientRateOverride(ctxBravo, {
      clientType: 'organisation',
      clientId: bravoOrg.id,
      practiceAreaId: null,
      gradeKey: 'partner',
      rateGbp: 410,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      notes: 'Bravo strictly isolated rate',
      byId: 'P-000004',
    });

    // Fresh pool manager reads on separate connections verify complete isolation
    const freshPoolMgr = new TenantPostgresPoolManager();
    openPoolManagers.push(freshPoolMgr);
    const freshRateRepo = new TenantRateOverrideRepository({ poolManager: freshPoolMgr });
    const freshAuditRepo = new TenantAuditRepository({ poolManager: freshPoolMgr });
    const freshPartyRepo = new TenantPartyRepository({ poolManager: freshPoolMgr });

    const alphaResolved = await freshRateRepo.resolveApplicableRates(ctxAlpha, {
      clientId: alphaOrg.id,
      asAtDate: '2026-06-01',
    });
    const bravoResolved = await freshRateRepo.resolveApplicableRates(ctxBravo, {
      clientId: bravoOrg.id,
      asAtDate: '2026-06-01',
    });
    expect(alphaResolved.partnerRateGbp).toBe(275);
    expect(alphaResolved.dominantTier).toBe(2);
    expect(bravoResolved.partnerRateGbp).toBe(410);
    expect(bravoResolved.dominantTier).toBe(2);

    // Tampered record ID from Alpha cannot be read, updated, or deleted from Bravo
    expect(await freshRateRepo.getClientRateOverrideById(ctxBravo, alphaOverride.id)).toBeNull();
    expect(await freshRateRepo.deleteClientRateOverride(ctxBravo, alphaOverride.id)).toBe(false);
    await expect(
      freshRateRepo.upsertClientRateOverride(ctxBravo, {
        id: alphaOverride.id,
        clientType: 'organisation',
        clientId: bravoOrg.id,
        practiceAreaId: null,
        gradeKey: 'partner',
        rateGbp: 199,
        effectiveFrom: '2026-01-01',
        byId: 'P-000004',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Alpha's override & audit entries remain intact and invisible in Bravo
    const alphaReadBack = await freshRateRepo.getClientRateOverrideById(ctxAlpha, alphaOverride.id);
    expect(alphaReadBack?.rateGbp).toBe(275);
    const bravoAudits = await freshAuditRepo.listAuditEntriesForRecord(
      ctxBravo,
      'client_rate_override',
      'CRO-ALPHA-AUDIT',
    );
    expect(bravoAudits).toHaveLength(0);

    // Cross-tenant parent organisation ID link attempt fails closed
    const alphaOnlyOrg = await freshPartyRepo.putOrganisation<Organisation>(ctxAlpha, {
      ...alphaOrg,
      id: 'O-ALPHA-PARENT-ONLY',
      legalName: 'Alpha Only Holding Group Ltd',
      parentOrganisationId: null,
    });
    await expect(
      freshPartyRepo.validateOrganisationParentLink(ctxBravo, bravoOrg.id, alphaOnlyOrg.id),
    ).rejects.toMatchObject({
      code: INVALID_PARENT_ORGANISATION_CODE,
    });

    // Forged TenantContext (tenantId swapped to Bravo while targeting Alpha's claims) fails closed
    const forgedCtx = Object.freeze({
      ...ctxAlpha,
      tenantId: tenantBravo,
    }) as TenantContext;
    await expect(
      freshRateRepo.listClientRateOverrides(forgedCtx, { clientId: alphaOrg.id }),
    ).rejects.toThrow();

    // Also verify getAppSnapshot in host context runs cleanly after all operations
    setActiveTenantConfigForTesting(alphaRaw);
    await runAsActionActor(
      'P-000004',
      async () => {
        const snap = await getAppSnapshot('P-000004');
        expect(snap.tenantId).toBe(tenantAlpha);
      },
      { tenantId: tenantAlpha },
    );

    // R643 (D9 = a): Role & MFA gating on matter and client overrides inside the two-tenant suite
    const alphaAccessibleMatter = alphaSeed.matters.find(
      (m) => !m.isStaffMatter && !m.hasEthicalWall && !m.mergedIntoId,
    )!;
    const partnerCreatedMatterOvr = await runAsActionActor(
      'P-000001',
      () =>
        saveMatterRateOverrideAction({
          matterId: alphaAccessibleMatter.id,
          gradeKey: 'partner',
          rateGbp: 345,
          effectiveFrom: '2026-01-01',
          notes: 'R643 partner matter override',
        }),
      { tenantId: tenantAlpha, roles: ['partner', 'fee_earner'], mfaVerified: false },
    );
    expect(isActionDenied(partnerCreatedMatterOvr)).toBe(false);
    expect(partnerCreatedMatterOvr.override?.rateGbp).toBe(345);
    const partnerMatterOvrId = partnerCreatedMatterOvr.override!.id;

    // Legal secretary (P-000010) and Fee earner (P-000002) are refused on an accessible matter
    for (const actorSpec of [
      { id: 'P-000010', roles: ['legal_secretary'] as const },
      { id: 'P-000002', roles: ['fee_earner'] as const },
    ]) {
      await runAsActionActor(
        actorSpec.id,
        async () => {
          const deniedSave = await saveMatterRateOverrideAction({
            matterId: alphaAccessibleMatter.id,
            gradeKey: 'associate',
            rateGbp: 185,
            effectiveFrom: '2026-01-01',
          });
          expect(isActionDenied(deniedSave)).toBe(true);
          if (isActionDenied(deniedSave)) {
            expect(deniedSave.code).toBe('FORBIDDEN');
          }

          const deniedDel = await deleteMatterRateOverrideAction(partnerMatterOvrId);
          expect(isActionDenied(deniedDel)).toBe(true);
          if (isActionDenied(deniedDel)) {
            expect(deniedDel.code).toBe('FORBIDDEN');
          }
        },
        { tenantId: tenantAlpha, roles: actorSpec.roles, mfaVerified: true },
      );
    }

    // Disabling allowMatterRateOverrides still allows deleting an existing matter rate override (R643)
    const alphaBaseCostsCfg = createDefaultMatterCostsConfig(alphaSeed.values, {
      clientProfileCode: tenantAlpha,
    });
    await runAsActionActor(
      'P-000004',
      () =>
        saveMatterCostsConfigAction({
          ...alphaBaseCostsCfg,
          allowMatterRateOverrides: false,
        }),
      { tenantId: tenantAlpha, mfaVerified: true },
    );
    const delWhenDisabled = await runAsActionActor(
      'P-000001',
      () => deleteMatterRateOverrideAction(partnerMatterOvrId),
      { tenantId: tenantAlpha, roles: ['partner', 'fee_earner'], mfaVerified: false },
    );
    expect(delWhenDisabled.deleted).toBe(true);

    // Client rate override writes require MFA (even for partner / finance) and reject finance:view-only
    const noMfaClientSave = await runAsActionActor(
      'P-000001',
      () =>
        saveClientRateOverrideAction({
          clientType: 'organisation',
          clientId: alphaOrg.id,
          practiceAreaId: null,
          gradeKey: 'associate',
          rateGbp: 225,
          effectiveFrom: '2026-02-01',
        }),
      { tenantId: tenantAlpha, roles: ['partner', 'fee_earner'], mfaVerified: false },
    );
    expect(isActionDenied(noMfaClientSave)).toBe(true);
    if (isActionDenied(noMfaClientSave)) {
      expect(noMfaClientSave.code).toBe('MFA_REQUIRED');
    }

    const noMfaClientDelete = await runAsActionActor(
      'P-000009',
      () => deleteClientRateOverrideAction(alphaOverride.id),
      { tenantId: tenantAlpha, roles: ['finance'], mfaVerified: false },
    );
    expect(isActionDenied(noMfaClientDelete)).toBe(true);
    if (isActionDenied(noMfaClientDelete)) {
      expect(noMfaClientDelete.code).toBe('MFA_REQUIRED');
    }

    // User holding only finance:view (via override revoking finance:credit_control) is refused
    await freshPartyRepo.putPerson(ctxAlpha, {
      ...alphaSeed.people.find((p) => p.id === 'P-000009')!,
      permissionOverrides: {
        grant: ['finance:view'],
        revoke: ['finance:credit_control'],
      },
    });
    const financeViewOnlySave = await runAsActionActor(
      'P-000009',
      () =>
        saveClientRateOverrideAction({
          clientType: 'organisation',
          clientId: alphaOrg.id,
          practiceAreaId: null,
          gradeKey: 'trainee',
          rateGbp: 135,
          effectiveFrom: '2026-02-01',
        }),
      { tenantId: tenantAlpha, roles: ['finance'], mfaVerified: true },
    );
    expect(isActionDenied(financeViewOnlySave)).toBe(true);
    if (isActionDenied(financeViewOnlySave)) {
      expect(financeViewOnlySave.code).toBe('FORBIDDEN');
    }

    // Partner with MFA succeeds in Alpha and remains isolated from Bravo
    const mfaClientSave = await runAsActionActor(
      'P-000001',
      () =>
        saveClientRateOverrideAction({
          clientType: 'organisation',
          clientId: alphaOrg.id,
          practiceAreaId: null,
          gradeKey: 'trainee',
          rateGbp: 135,
          effectiveFrom: '2026-02-01',
        }),
      { tenantId: tenantAlpha, roles: ['partner', 'fee_earner'], mfaVerified: true },
    );
    expect(isActionDenied(mfaClientSave)).toBe(false);
    expect(mfaClientSave.override?.rateGbp).toBe(135);
    expect(await freshRateRepo.getClientRateOverrideById(ctxBravo, mfaClientSave.override!.id)).toBeNull();
  });
});
