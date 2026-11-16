import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_REQUIRED_SCHEMA_VERSION,
  TenantAuditRepository,
  TenantCatalogueRepository,
  TenantIntakeQuoteRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantPostgresPoolManager,
  loadAndValidateTenantConfig,
  resolveTenantFromVerifiedToken,
  type TenantContext,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import { createDirectMigrationClient } from '../src/tenancy/postgresPoolManager';
import {
  reviseQuoteAction,
  saveMatterCostsConfigAction,
  saveQuoteAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import {
  applyEffectiveMatterCostsToTenantConfig,
  calculateDisbursementsTotal,
  calculateMatterDisbursementsBreakdown,
  calculateMatterSnapshotTotals,
  createDefaultMatterCostsConfig,
  lookupRatesForMatter,
  resolveEffectiveMatterCostsConfig,
} from '@/domain/matterCosts';
import { calculateQuoteTotals, roundCurrency } from '@/domain/quotes';
import type { Matter, MatterCostsConfig, MatterCostsSnapshot, Quote } from '@/domain/types';
import {
  getActiveTenantRawBaseConfig,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import {
  getAppSnapshot,
  resetAllDemoData,
  reviseQuoteRecord,
  saveMatterCostsConfig,
  saveMatterRecord,
  saveQuoteRecord,
  signOffMatterCostsRecord,
} from '@/server/services';
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
    correlationId: `corr-s023-${tenantId}-${actorId}`,
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

async function queryDirectSql<T extends Record<string, unknown>>(
  ctx: TenantContext,
  sqlText: string,
  params: readonly unknown[],
): Promise<T[]> {
  const client = await createDirectMigrationClient({ ctx });
  try {
    const res = await client.query<T>(sqlText, [...params]);
    return res.rows;
  } finally {
    await client.end();
  }
}

describe('S0-23: Rates & Charging (Money Maths, Configurable VAT Rate & Immutable Snapshots)', () => {
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

  it('1. Rate lookup, pure minor-unit quote/matter VAT maths (0%, 5%, 17.5%, 20%), overrides & float-drift prevention', () => {
    // Prevent IEEE-754 float drift on classic binary decimals
    expect(roundCurrency(0.1 + 0.2)).toBe(0.3);
    expect(
      calculateDisbursementsTotal([
        { id: 'd1', description: 'Search A', amountGbp: 0.1, vatApplicable: false },
        { id: 'd2', description: 'Search B', amountGbp: 0.2, vatApplicable: false },
      ]),
    ).toBe(0.3);

    // Quote VAT calculations across 0%, 5%, 17.5%, 20% and per-disbursement overrides
    expect(
      calculateQuoteTotals(
        100.01,
        null,
        [
          { id: 'qd1', description: 'Land Registry', amountExVat: 40, vatApplicable: false },
          { id: 'qd2', description: 'Courier', amountExVat: 19.99, vatApplicable: true },
        ],
        0,
      ),
    ).toEqual({
      feeAmountExVat: 100.01,
      vatOnFee: 0,
      disbursementsExVat: 59.99,
      vatOnDisbursements: 0,
      totalExVat: 160,
      totalVat: 0,
      totalIncVat: 160,
    });

    // 5% of £10.05 = £0.5025 -> £0.50; 5% of £10.10 = £0.505 -> half away from zero -> £0.51
    expect(
      calculateQuoteTotals(
        10.1,
        null,
        [{ id: 'qd3', description: 'Search', amountExVat: 20, vatApplicable: true }],
        5,
      ),
    ).toEqual({
      feeAmountExVat: 10.1,
      vatOnFee: 0.51,
      disbursementsExVat: 20,
      vatOnDisbursements: 1,
      totalExVat: 30.1,
      totalVat: 1.51,
      totalIncVat: 31.61,
    });

    // 17.5% of £1.00 = £0.175 -> half away from zero -> £0.18
    expect(
      calculateQuoteTotals(
        1,
        null,
        [
          {
            id: 'qd4',
            description: 'Counsel',
            amountExVat: 100,
            vatApplicable: true,
            vatOverridden: true,
            vatAmount: 12.34,
          },
        ],
        17.5,
      ),
    ).toEqual({
      feeAmountExVat: 1,
      vatOnFee: 0.18,
      disbursementsExVat: 100,
      vatOnDisbursements: 12.34,
      totalExVat: 101,
      totalVat: 12.52,
      totalIncVat: 113.52,
    });

    // 20% fee VAT override respected cleanly
    expect(
      calculateQuoteTotals(
        2500,
        400,
        [{ id: 'qd5', description: 'Counsel', amountExVat: 500, vatApplicable: true }],
        20,
      ),
    ).toEqual({
      feeAmountExVat: 2500,
      vatOnFee: 400,
      disbursementsExVat: 500,
      vatOnDisbursements: 100,
      totalExVat: 3000,
      totalVat: 500,
      totalIncVat: 3500,
    });

    // Matter disbursements breakdown and snapshot totals in minor units
    const disbBreakdown = calculateMatterDisbursementsBreakdown(
      [
        { id: 'md1', description: 'Search 1', amountGbp: 10.1, vatApplicable: true },
        {
          id: 'md2',
          description: 'Search 2',
          amountGbp: 50,
          vatApplicable: true,
          vatOverridden: true,
          vatAmountGbp: 2.5,
        },
        { id: 'md3', description: 'Court Fee', amountGbp: 455, vatApplicable: false },
      ],
      5,
    );
    expect(disbBreakdown.netGbp).toBe(515.1);
    expect(disbBreakdown.vatGbp).toBe(3.01); // 0.51 + 2.50 + 0
    expect(disbBreakdown.totalIncVatGbp).toBe(518.11);

    const matterTotals = calculateMatterSnapshotTotals({
      totalEstimateGbp: 1000,
      disbursements: disbBreakdown.lines,
      vatRatePercent: 5,
    });
    expect(matterTotals).toEqual({
      disbursementsTotalGbp: 515.1,
      disbursementsVatGbp: 3.01,
      disbursementsTotalIncVatGbp: 518.11,
      estimatedFeeVatGbp: 50,
      totalIncVatGbp: 1568.11,
      combinedExVatGbp: 1515.1,
      combinedVatGbp: 53.01,
      combinedIncVatGbp: 1568.11,
    });

    // Rate lookup respects rateSourceMode & PMS vs App table preference
    const rawBase = getActiveTenantRawBaseConfig();
    const tenantCfg = loadAndValidateTenantConfig(rawBase, {}, 'test', 'multi_tenant');
    const resolvedDefaults = resolveEffectiveMatterCostsConfig(tenantCfg, null);
    expect(resolvedDefaults.vatRatePercent).toBe(20);
    expect(resolvedDefaults.partnerSignOffThresholdGbp).toBe(25000);
    expect(resolvedDefaults.rateCards.length).toBeGreaterThanOrEqual(2);

    const corpCard = resolvedDefaults.rateCards.find(
      (rc) => rc.practiceAreaId === 'work_type.corporate_and_commercial',
    )!;
    expect(corpCard).toBeDefined();

    const appLookup = lookupRatesForMatter({
      config: { ...resolvedDefaults, rateSourceMode: 'app_table', pmsLinkActive: false },
      practiceAreaId: 'work_type.corporate_and_commercial',
    });
    expect(appLookup.activeSource).toBe('app_table');
    expect(appLookup.partnerRateGbp).toBe(corpCard.partnerRateGbp);

    const pmsLookup = lookupRatesForMatter({
      config: {
        ...resolvedDefaults,
        rateSourceMode: 'pms_only',
        pmsLinkActive: true,
        rateCards: resolvedDefaults.rateCards.map((rc) =>
          rc.id === corpCard.id
            ? {
                ...rc,
                pmsPartnerRateGbp: 495,
                pmsAssociateRateGbp: 345,
                pmsTraineeRateGbp: 185,
              }
            : rc,
        ),
      },
      practiceAreaId: 'work_type.corporate_and_commercial',
    });
    expect(pmsLookup.activeSource).toBe('pms');
    expect(pmsLookup.partnerRateGbp).toBe(495);

    const mergedTenantCfg = applyEffectiveMatterCostsToTenantConfig(tenantCfg, {
      ...resolvedDefaults,
      partnerSignOffThresholdGbp: 5000,
      vatRatePercent: 5,
      allowMatterRateOverrides: false,
    });
    expect(mergedTenantCfg.matterCosts.partnerSignOffThresholdGbp).toBe(5000);
    expect(mergedTenantCfg.matterCosts.vatRatePercent).toBe(5);
    expect(mergedTenantCfg.matterCosts.allowMatterRateOverrides).toBe(false);
  });

  it('2. Admin saveMatterCostsConfigAction: RBAC/MFA enforcement, validation, runtime threshold wiring & before/after audit log', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const seed = createSeedStore();
    const nonAdmin = seed.people.find((p) => p.id === 'P-000002')!;
    expect(nonAdmin).toBeDefined();
    const baseCfg = createDefaultMatterCostsConfig(seed.values, { clientProfileCode: 'not-a-law-firm' });

    // Unauthenticated denied
    setTestActorSession(null);
    const unauthRes = await saveMatterCostsConfigAction({
      ...baseCfg,
      vatRatePercent: 5,
    });
    expect(isActionDenied(unauthRes)).toBe(true);
    if (isActionDenied(unauthRes)) {
      expect(unauthRes.code).toBe('UNAUTHENTICATED');
    }

    // Non-admin denied (FORBIDDEN)
    const nonAdminRes = await runAsActionActor(
      nonAdmin.id,
      () => saveMatterCostsConfigAction({ ...baseCfg, vatRatePercent: 5 }),
      { roles: ['fee_earner'], mfaVerified: true },
    );
    expect(isActionDenied(nonAdminRes)).toBe(true);
    if (isActionDenied(nonAdminRes)) {
      expect(nonAdminRes.code).toBe('FORBIDDEN');
    }

    // Admin without MFA denied (MFA_REQUIRED)
    const noMfaRes = await runAsActionActor(
      'P-000004',
      () => saveMatterCostsConfigAction({ ...baseCfg, vatRatePercent: 5 }),
      { mfaVerified: false },
    );
    expect(isActionDenied(noMfaRes)).toBe(true);
    if (isActionDenied(noMfaRes)) {
      expect(noMfaRes.code).toBe('MFA_REQUIRED');
    }

    // Invalid VAT rate and negative threshold rejected cleanly
    await runAsActionActor(
      'P-000004',
      async () => {
        await expect(
          saveMatterCostsConfig({ ...baseCfg, vatRatePercent: -1 }, 'P-000004'),
        ).rejects.toThrow(/Standard VAT rate/);
        await expect(
          saveMatterCostsConfig({ ...baseCfg, vatRatePercent: 101 }, 'P-000004'),
        ).rejects.toThrow(/Standard VAT rate/);
        await expect(
          saveMatterCostsConfig({ ...baseCfg, partnerSignOffThresholdGbp: -100 }, 'P-000004'),
        ).rejects.toThrow(/Partner cost sign-off threshold/);
      },
      { mfaVerified: true },
    );

    // Valid MFA-verified admin update writes single before/after audit entry
    const watermark = await markAuditPosition();
    const saved = await runAsActionActor(
      'P-000004',
      () =>
        saveMatterCostsConfigAction({
          ...baseCfg,
          vatRatePercent: 5,
          partnerSignOffThresholdGbp: 5000,
          allowMatterRateOverrides: false,
        }),
      { mfaVerified: true },
    );
    expect(isActionDenied(saved)).toBe(false);
    if (!isActionDenied(saved)) {
      expect(saved.vatRatePercent).toBe(5);
      expect(saved.partnerSignOffThresholdGbp).toBe(5000);
      expect(saved.allowMatterRateOverrides).toBe(false);
    }

    const audits = await auditEntriesSince(watermark);
    const costsAudits = audits.filter((a) => a.recordId === 'FIRM-MATTER-COSTS-CONFIG');
    expect(costsAudits).toHaveLength(1);
    expect(costsAudits[0]?.newValue).toContain('threshold=£5000');
    expect(costsAudits[0]?.newValue).toContain('vat=5%');
    expect(costsAudits[0]?.newValue).toContain('overrides=false');

    const snapAfter = await runAsActionActor(
      'P-000004',
      () => getAppSnapshot('P-000004'),
      { mfaVerified: true },
    );
    expect(snapAfter.matterCostsConfig.vatRatePercent).toBe(5);
    expect(snapAfter.matterCostsConfig.partnerSignOffThresholdGbp).toBe(5000);
    expect(snapAfter.matterCostsConfig.allowMatterRateOverrides).toBe(false);
  });

  it('3. Server enforcement: allowMatterRateOverrides=false blocks client rate overrides & dynamic partnerSignOffThresholdGbp drives beforeMatterOpen', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const seed = createSeedStore();
    const baseCfg = createDefaultMatterCostsConfig(seed.values, { clientProfileCode: 'not-a-law-firm' });
    const feeEarner = seed.people.find((p) => p.id === 'P-000002')!;
    const partner = seed.people.find((p) => p.id === 'P-000001')!;
    const templateMatter = seed.matters.find((m) => m.id === 'M-000011')!;
    const { id: _omitId, ...matterBase } = templateMatter;
    void _omitId;

    await runAsActionActor(
      'P-000004',
      async () => {
        const cfgSave = await saveMatterCostsConfigAction({
          ...baseCfg,
          allowMatterRateOverrides: false,
          partnerSignOffThresholdGbp: 5000,
          vatRatePercent: 5,
        });
        expect(isActionDenied(cfgSave)).toBe(false);
      },
      { mfaVerified: true },
    );

    const lookedUp = lookupRatesForMatter({
      config: { ...baseCfg, allowMatterRateOverrides: false },
      practiceAreaId: matterBase.practiceAreaId,
    });

    await runAsActionActor(
      feeEarner.id,
      async () => {
        // Attempting to override hourly rates when allowMatterRateOverrides=false fails server-side
        const overrideRes = await saveMatterRecord(
          {
            ...matterBase,
            matterNumber: 'DRAFT',
            openedAt: null,
            title: 'Blocked Custom Rate Matter',
            leadFeeEarnerId: feeEarner.id,
            responsiblePartnerId: partner.id,
            supervisingPartnerId: partner.id,
            teamMemberIds: [feeEarner.id, partner.id],
            feeEstimateGbp: 6000,
            fieldValues: {
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
              matterCosts: {
                workBasis: 'hourly_rates',
                rateCardId: lookedUp.rateCard.id,
                rateCardName: lookedUp.rateCard.name,
                rateSource: 'custom_override',
                partnerRateGbp: lookedUp.partnerRateGbp + 125,
                associateRateGbp: lookedUp.associateRateGbp,
                traineeRateGbp: lookedUp.traineeRateGbp,
                customGrades: [],
                totalEstimateGbp: 6000,
                agreedCapGbp: null,
                disbursements: [],
                disbursementsTotalGbp: 0,
                paymentOnAccountRequired: 'Yes',
                paymentOnAccountAmountGbp: 1000,
              } satisfies Partial<MatterCostsSnapshot>,
            },
          },
          { byId: feeEarner.id, saveMode: 'draft' },
        );
        expect(overrideRes.matter).toBeNull();
        expect(overrideRes.errors?.matterCosts).toContain(
          'Matter-level hourly rate overrides are disabled',
        );

        // Matching card rates succeeds as draft, and submitting at £6,000 hits dynamic £5,000 threshold
        const submitBlocked = await saveMatterRecord(
          {
            ...matterBase,
            matterNumber: 'DRAFT',
            openedAt: null,
            title: 'Dynamic £5k Threshold Matter',
            leadFeeEarnerId: feeEarner.id,
            responsiblePartnerId: partner.id,
            supervisingPartnerId: partner.id,
            teamMemberIds: [feeEarner.id, partner.id],
            feeEstimateGbp: 6000,
            fieldValues: {
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
              matterCosts: {
                workBasis: 'hourly_rates',
                rateCardId: lookedUp.rateCard.id,
                rateCardName: lookedUp.rateCard.name,
                rateSource: lookedUp.activeSource,
                partnerRateGbp: lookedUp.partnerRateGbp,
                associateRateGbp: lookedUp.associateRateGbp,
                traineeRateGbp: lookedUp.traineeRateGbp,
                customGrades: lookedUp.customGrades,
                totalEstimateGbp: 6000,
                agreedCapGbp: null,
                disbursements: [
                  { id: 'd1', description: 'Search fee', amountGbp: 100, vatApplicable: true },
                ],
                disbursementsTotalGbp: 100,
                paymentOnAccountRequired: 'Yes',
                paymentOnAccountAmountGbp: 1000,
              } satisfies Partial<MatterCostsSnapshot>,
            },
          },
          { byId: feeEarner.id, saveMode: 'submit_cleared' },
        );
        expect(submitBlocked.matter).toBeNull();
        expect(submitBlocked.errors?.costsGovernance).toContain('£5,000');

        // Draft saves cleanly with frozen 5% VAT snapshot
        const draftOk = await saveMatterRecord(
          {
            ...matterBase,
            matterNumber: 'DRAFT',
            openedAt: null,
            title: 'Dynamic £5k Threshold Matter',
            leadFeeEarnerId: feeEarner.id,
            responsiblePartnerId: partner.id,
            supervisingPartnerId: partner.id,
            teamMemberIds: [feeEarner.id, partner.id],
            feeEstimateGbp: 6000,
            fieldValues: {
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
              matterCosts: {
                workBasis: 'hourly_rates',
                rateCardId: lookedUp.rateCard.id,
                rateCardName: lookedUp.rateCard.name,
                rateSource: lookedUp.activeSource,
                partnerRateGbp: lookedUp.partnerRateGbp,
                associateRateGbp: lookedUp.associateRateGbp,
                traineeRateGbp: lookedUp.traineeRateGbp,
                customGrades: lookedUp.customGrades,
                totalEstimateGbp: 6000,
                agreedCapGbp: null,
                disbursements: [
                  { id: 'd1', description: 'Search fee', amountGbp: 100, vatApplicable: true },
                ],
                disbursementsTotalGbp: 100,
                paymentOnAccountRequired: 'Yes',
                paymentOnAccountAmountGbp: 1000,
              } satisfies Partial<MatterCostsSnapshot>,
            },
          },
          { byId: feeEarner.id, saveMode: 'draft' },
        );
        expect(draftOk.errors).toBeUndefined();
        expect(draftOk.matter).not.toBeNull();
        const savedSnap = draftOk.matter!.fieldValues['matterCosts'] as MatterCostsSnapshot;
        expect(savedSnap.vatRatePercent).toBe(5);
        expect(savedSnap.estimatedFeeVatGbp).toBe(300);
        expect(savedSnap.disbursementsVatGbp).toBe(5);
        expect(savedSnap.totalIncVatGbp).toBe(6405);
      },
      { mfaVerified: true },
    );
  });

  it('4. Immutable snapshots: Quotes preserve v1 VAT across firm rate changes & revisions; legacy fallback defaults to 20% without mutating totals', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const seed = createSeedStore();
    const intakeRepo = new TenantIntakeQuoteRepository();

    let quoteId = '';
    let v1CapturedAt = '';

    await runAsActionActor(
      'P-000004',
      async () => {
        // Admin VAT starts at 20%
        const qRes = await saveQuoteAction({
          clientType: 'prospect',
          prospectName: 'Olivia Carter',
          prospectEmail: 'olivia.carter@example.test',
          practiceAreaId: 'work_type.corporate_and_commercial',
          scope: 'Commercial agreement review',
          feeBasis: 'Fixed fee',
          feeAmountExVat: 1000,
          disbursements: [
            { id: 'qdisb-1', description: 'Registry filing', amountExVat: 100, vatApplicable: true },
          ],
          validUntil: '2026-12-31',
          feeEarnerId: 'P-000004',
          followUpAfterDays: 7,
        });
        expect(qRes.error).toBeUndefined();
        const q1 = qRes.quote!;
        quoteId = q1.id;
        expect(q1.vatRatePercent).toBe(20);
        expect(q1.vatAmount).toBe(200);
        expect(q1.totalIncVat).toBe(1320); // 1000 + 200 + 100 + 20
        expect(q1.capturedAt).toBeTruthy();
        v1CapturedAt = q1.capturedAt!;

        // Change tenant VAT rate to 5%
        const baseCfg = createDefaultMatterCostsConfig(seed.values, { clientProfileCode: 'not-a-law-firm' });
        const cfgSaved = await saveMatterCostsConfigAction({
          ...baseCfg,
          vatRatePercent: 5,
        });
        expect(isActionDenied(cfgSaved)).toBe(false);

        // Re-read v1 directly -> untouched at 20% and £1,320
        const v1Read = await intakeRepo.getQuoteById<Quote>(ctx, quoteId);
        expect(v1Read?.vatRatePercent).toBe(20);
        expect(v1Read?.vatAmount).toBe(200);
        expect(v1Read?.totalIncVat).toBe(1320);

        // Editing v1 without refreshVatRate preserves 20% and original capturedAt
        const v1Edited = await saveQuoteAction(
          {
            clientType: 'prospect',
            prospectName: 'Olivia Carter',
            prospectEmail: 'olivia.carter@example.test',
            practiceAreaId: 'work_type.corporate_and_commercial',
            scope: 'Commercial agreement review (clarified)',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1000,
            disbursements: [
              {
                id: 'qdisb-1',
                description: 'Registry filing',
                amountExVat: 100,
                vatApplicable: true,
              },
            ],
            validUntil: '2026-12-31',
            feeEarnerId: 'P-000004',
            followUpAfterDays: 7,
          },
          { id: quoteId, refreshVatRate: false },
        );
        expect(v1Edited.quote?.vatRatePercent).toBe(20);
        expect(v1Edited.quote?.totalIncVat).toBe(1320);
        expect(v1Edited.quote?.capturedAt).toBe(v1CapturedAt);

        // Revise quote to v2 -> v1 frozen in versionHistory @ 20%, v2 captures 5%
        const revRes = await reviseQuoteAction(quoteId, {
          feeBasis: 'Fixed fee',
          feeAmountExVat: 1000,
          disbursements: [
            { id: 'qdisb-1', description: 'Registry filing', amountExVat: 100, vatApplicable: true },
          ],
          scope: 'Commercial agreement review (revised scope)',
          revisionNote: 'Revised under 5% reduced VAT rate',
        });
        expect(revRes.error).toBeUndefined();
        const q2 = revRes.quote!;
        expect(q2.version).toBe(2);
        expect(q2.vatRatePercent).toBe(5);
        expect(q2.vatAmount).toBe(50);
        expect(q2.totalIncVat).toBe(1155); // 1000 + 50 + 100 + 5
        expect(q2.versionHistory).toHaveLength(1);
        expect(q2.versionHistory[0]?.version).toBe(1);
        expect(q2.versionHistory[0]?.vatRatePercent).toBe(20);
        expect(q2.versionHistory[0]?.vatAmount).toBe(200);
        expect(q2.versionHistory[0]?.totalIncVat).toBe(1320);
        expect(q2.versionHistory[0]?.capturedAt).toBe(v1CapturedAt);

        // Legacy fallback: simulate a stored pre-S0-23 quote row missing vatRatePercent in JSONB
        await queryDirectSql(
          ctx,
          `UPDATE public.quotes
              SET pricing_breakdown_json = pricing_breakdown_json - 'vatRatePercent' - 'capturedAt',
                  profile_json = profile_json - 'vatRatePercent' - 'capturedAt'
            WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, quoteId],
        );
        const legacyHydrated = await intakeRepo.getQuoteById<Quote>(ctx, quoteId);
        expect(legacyHydrated?.vatRatePercent).toBe(20);
        expect(legacyHydrated?.vatAmount).toBe(50); // stored totals preserved unchanged
        expect(legacyHydrated?.totalIncVat).toBe(1155);
      },
      { mfaVerified: true },
    );
  });

  it('5. Immutable matter costs snapshots: signed-off matter retains 20% VAT, £350 card rate & capturedAt across config changes and unrelated edits', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const seed = createSeedStore();
    const baseCfg = createDefaultMatterCostsConfig(seed.values, { clientProfileCode: 'not-a-law-firm' });
    const customCard = {
      ...baseCfg.rateCards[0]!,
      id: 'RC-FROZEN-TEST',
      practiceAreaId: 'work_type.corporate_and_commercial',
      partnerRateGbp: 350,
      associateRateGbp: 240,
      traineeRateGbp: 140,
    };

    const templateMatter = seed.matters.find((m) => m.id === 'M-000011')!;
    const partner = seed.people.find((p) => p.id === 'P-000004')!;
    const { id: _omitId, ...matterBase } = templateMatter;
    void _omitId;

    await runAsActionActor(
      'P-000004',
      async () => {
        const initCfg = await saveMatterCostsConfigAction({
          ...baseCfg,
          vatRatePercent: 20,
          partnerSignOffThresholdGbp: 5000,
          rateSourceMode: 'app_table',
          rateCards: [customCard, ...baseCfg.rateCards.slice(1)],
        });
        expect(isActionDenied(initCfg)).toBe(false);

        const draftRes = await saveMatterRecord(
          {
            ...matterBase,
            matterNumber: 'DRAFT',
            openedAt: null,
            title: 'Immutable Snapshot Matter',
            practiceAreaId: 'work_type.corporate_and_commercial',
            leadFeeEarnerId: partner.id,
            responsiblePartnerId: partner.id,
            supervisingPartnerId: partner.id,
            teamMemberIds: [partner.id],
            feeEstimateGbp: 10000,
            fieldValues: {
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
              matterCosts: {
                workBasis: 'hourly_rates',
                rateCardId: 'RC-FROZEN-TEST',
                rateCardName: customCard.name,
                rateSource: 'app_table',
                partnerRateGbp: 350,
                associateRateGbp: 240,
                traineeRateGbp: 140,
                customGrades: [],
                totalEstimateGbp: 10000,
                agreedCapGbp: null,
                disbursements: [
                  { id: 'd1', description: 'Filing', amountGbp: 200, vatApplicable: true },
                ],
                disbursementsTotalGbp: 200,
                paymentOnAccountRequired: 'Yes',
                paymentOnAccountAmountGbp: 1500,
              } satisfies Partial<MatterCostsSnapshot>,
            },
          },
          { byId: 'P-000004', saveMode: 'draft' },
        );
        expect(draftRes.errors).toBeUndefined();
        expect(draftRes.matter).not.toBeNull();
        const m1 = draftRes.matter!;
        const signedRes = await signOffMatterCostsRecord(
          m1.id,
          'P-000004',
          'Approved at 20% VAT / £350',
        );
        expect(signedRes.errors).toBeUndefined();
        const signedSnap = signedRes.matter!.fieldValues['matterCosts'] as MatterCostsSnapshot;
        expect(signedSnap.vatRatePercent).toBe(20);
        expect(signedSnap.partnerRateGbp).toBe(350);
        expect(signedSnap.estimatedFeeVatGbp).toBe(2000);
        expect(signedSnap.disbursementsVatGbp).toBe(40);
        expect(signedSnap.totalIncVatGbp).toBe(12240);
        const capturedAtOriginal = signedSnap.capturedAt;
        expect(capturedAtOriginal).toBeTruthy();

        // Update firm VAT to 5% and raise partner rate to £500
        await saveMatterCostsConfigAction({
          ...baseCfg,
          vatRatePercent: 5,
          partnerSignOffThresholdGbp: 5000,
          rateSourceMode: 'app_table',
          rateCards: [{ ...customCard, partnerRateGbp: 500 }, ...baseCfg.rateCards.slice(1)],
        });

        // Re-save an unrelated field (matter title) -> frozen snapshot must not drift
        const reloaded = signedRes.matter!;
        const editRes = await saveMatterRecord(
          {
            ...reloaded,
            title: 'Immutable Snapshot Matter — Renamed Only',
          },
          {
            id: reloaded.id,
            byId: 'P-000004',
            saveMode: 'draft',
            expectedRowVersion: reloaded.rowVersion ?? 1,
          },
        );
        expect(editRes.errors).toBeUndefined();
        expect(editRes.matter).not.toBeNull();
        const preservedSnap = editRes.matter!.fieldValues['matterCosts'] as MatterCostsSnapshot;
        expect(preservedSnap.vatRatePercent).toBe(20);
        expect(preservedSnap.partnerRateGbp).toBe(350);
        expect(preservedSnap.capturedAt).toBe(capturedAtOriginal);
        expect(preservedSnap.estimatedFeeVatGbp).toBe(2000);
        expect(preservedSnap.totalIncVatGbp).toBe(12240);
      },
      { mfaVerified: true },
    );
  });

  it('6. Real two-tenant PostgreSQL isolation (tenant-alpha vs tenant-bravo): VAT rates, thresholds, quotes, snapshots, forged claims & tampered IDs', async () => {
    const tenantAlpha = 'tenant-alpha';
    const tenantBravo = 'tenant-bravo';

    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });

    const ctxAlpha = makeVerifiedTenantCtx(tenantAlpha, 'P-000004', [
      'admin',
      'partner',
      'fee_earner',
      'risk_compliance',
    ]);
    const ctxBravo = makeVerifiedTenantCtx(tenantBravo, 'P-000004', [
      'admin',
      'partner',
      'fee_earner',
      'risk_compliance',
    ]);

    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctxAlpha);
    await runner.applyUp(ctxBravo);

    // Forged claim checks assert explicit error type & message
    try {
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000004',
          name: 'Forged Actor',
          email: 'forged@alpha.example',
          tenantId: tenantAlpha,
          roles: ['admin'],
          mfaVerified: true,
        },
        untrustedRequestTenantOverride: tenantBravo,
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged-s023',
      });
      expect.fail('Expected TENANCY_FORGERY_DETECTED');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/^TENANCY_FORGERY_DETECTED:.*override/i);
    }

    const rawBase = getActiveTenantRawBaseConfig();
    const alphaRaw = {
      ...structuredClone(rawBase),
      tenantId: tenantAlpha,
      displayName: 'Tenant Alpha LLP',
      matterCosts: {
        ...(rawBase.matterCosts as Record<string, unknown>),
        vatRatePercent: 5,
        partnerSignOffThresholdGbp: 5000,
        allowMatterRateOverrides: false,
      },
    };
    const bravoRaw = {
      ...structuredClone(rawBase),
      tenantId: tenantBravo,
      displayName: 'Tenant Bravo LLP',
      matterCosts: {
        ...(rawBase.matterCosts as Record<string, unknown>),
        vatRatePercent: 20,
        partnerSignOffThresholdGbp: 40000,
        allowMatterRateOverrides: true,
      },
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

    // Save distinct matter_costs module configs & quotes/matters per tenant
    let alphaQuoteId = '';
    let alphaUniqueQuoteId = '';
    let alphaMatterId = '';

    setActiveTenantConfigForTesting(alphaRaw);
    setTestActorSession('P-000004', { tenantId: tenantAlpha, mfaVerified: true });
    await runAsActionActor(
      'P-000004',
      async () => {
        const alphaBaseCosts = createDefaultMatterCostsConfig(alphaSeed.values, {
          clientProfileCode: tenantAlpha,
          displayName: 'Alpha Law',
        });
        const savedAlphaCfg = await saveMatterCostsConfigAction({
          ...alphaBaseCosts,
          vatRatePercent: 5,
          partnerSignOffThresholdGbp: 5000,
          allowMatterRateOverrides: false,
        });
        expect(isActionDenied(savedAlphaCfg)).toBe(false);

        const qAlpha = await saveQuoteAction({
          clientType: 'prospect',
          prospectName: 'Alpha Only Client',
          prospectEmail: 'alpha.client@example.test',
          practiceAreaId: 'work_type.corporate_and_commercial',
          scope: 'Alpha isolated scope',
          feeBasis: 'Fixed fee',
          feeAmountExVat: 2000,
          disbursements: [
            { id: 'da1', description: 'Alpha Fee', amountExVat: 100, vatApplicable: true },
          ],
          validUntil: '2026-12-31',
          feeEarnerId: 'P-000004',
          followUpAfterDays: 7,
        });
        expect(qAlpha.quote?.vatRatePercent).toBe(5);
        expect(qAlpha.quote?.totalIncVat).toBe(2205); // 2000 + 100 + 100 + 5
        alphaQuoteId = qAlpha.quote!.id;

        const qAlphaUnique = await saveQuoteAction({
          clientType: 'prospect',
          prospectName: 'Alpha Unique Client',
          prospectEmail: 'alpha.unique@example.test',
          practiceAreaId: 'work_type.corporate_and_commercial',
          scope: 'Alpha unique isolated scope',
          feeBasis: 'Fixed fee',
          feeAmountExVat: 1500,
          disbursements: [],
          validUntil: '2026-12-31',
          feeEarnerId: 'P-000004',
          followUpAfterDays: 7,
        });
        expect(qAlphaUnique.error).toBeUndefined();
        alphaUniqueQuoteId = qAlphaUnique.quote!.id;

        const mTemplate = alphaSeed.matters.find((m) => m.id === 'M-000011')!;
        const { id: _omit, ...mData } = mTemplate;
        void _omit;
        const alphaLookedUp = lookupRatesForMatter({
          config: alphaBaseCosts,
          practiceAreaId: mData.practiceAreaId,
        });
        const mAlpha = await saveMatterRecord(
          {
            ...mData,
            matterNumber: 'DRAFT',
            openedAt: null,
            title: 'Alpha Isolated Costed Matter',
            leadFeeEarnerId: 'P-000004',
            responsiblePartnerId: 'P-000004',
            supervisingPartnerId: 'P-000004',
            teamMemberIds: ['P-000004'],
            feeEstimateGbp: 6000,
            fieldValues: {
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
              matterCosts: {
                workBasis: 'hourly_rates',
                rateCardId: alphaLookedUp.rateCard.id,
                rateCardName: alphaLookedUp.rateCard.name,
                rateSource: alphaLookedUp.activeSource,
                partnerRateGbp: alphaLookedUp.partnerRateGbp,
                associateRateGbp: alphaLookedUp.associateRateGbp,
                traineeRateGbp: alphaLookedUp.traineeRateGbp,
                customGrades: alphaLookedUp.customGrades,
                totalEstimateGbp: 6000,
                agreedCapGbp: null,
                disbursements: [
                  { id: 'da-m1', description: 'Alpha search', amountGbp: 100, vatApplicable: true },
                ],
                disbursementsTotalGbp: 100,
                paymentOnAccountRequired: 'Yes',
                paymentOnAccountAmountGbp: 1000,
              } satisfies Partial<MatterCostsSnapshot>,
            },
          },
          { byId: 'P-000004', saveMode: 'draft' },
        );
        expect(mAlpha.errors).toBeUndefined();
        expect(mAlpha.matter).not.toBeNull();
        alphaMatterId = mAlpha.matter!.id;
        const alphaMatterSnap = mAlpha.matter!.fieldValues['matterCosts'] as MatterCostsSnapshot;
        expect(alphaMatterSnap.vatRatePercent).toBe(5);
        expect(alphaMatterSnap.estimatedFeeVatGbp).toBe(300);
        expect(alphaMatterSnap.totalIncVatGbp).toBe(6405);
      },
      { tenantId: tenantAlpha, mfaVerified: true },
    );

    // Tenant Bravo retains 20% VAT / £40,000 threshold and cannot see or touch Alpha's quote or matter
    setActiveTenantConfigForTesting(bravoRaw);
    setTestActorSession('P-000004', { tenantId: tenantBravo, mfaVerified: true });
    await runAsActionActor(
      'P-000004',
      async () => {
        const bravoBaseCosts = createDefaultMatterCostsConfig(bravoSeed.values, {
          clientProfileCode: tenantBravo,
          displayName: 'Bravo Law',
        });
        const savedBravoCfg = await saveMatterCostsConfigAction({
          ...bravoBaseCosts,
          vatRatePercent: 20,
          partnerSignOffThresholdGbp: 40000,
          allowMatterRateOverrides: true,
        });
        expect(isActionDenied(savedBravoCfg)).toBe(false);

        const qBravo = await saveQuoteAction({
          clientType: 'prospect',
          prospectName: 'Bravo Only Client',
          prospectEmail: 'bravo.client@example.test',
          practiceAreaId: 'work_type.corporate_and_commercial',
          scope: 'Bravo isolated scope',
          feeBasis: 'Fixed fee',
          feeAmountExVat: 2000,
          disbursements: [],
          validUntil: '2026-12-31',
          feeEarnerId: 'P-000004',
          followUpAfterDays: 7,
        });
        expect(qBravo.quote?.vatRatePercent).toBe(20);
        expect(qBravo.quote?.totalIncVat).toBe(2400);

        // Tampered / cross-tenant IDs fail closed via service layer
        const crossQuoteSave = await saveQuoteRecord(
          {
            clientType: 'prospect',
            prospectName: 'Tamper',
            practiceAreaId: 'work_type.corporate_and_commercial',
            scope: 'Tamper',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 500,
          },
          { id: alphaUniqueQuoteId, byId: 'P-000004' },
        );
        expect(crossQuoteSave.error).toContain('Quote not found');

        const crossRevision = await reviseQuoteRecord(
          alphaUniqueQuoteId,
          {
            feeBasis: 'Fixed fee',
            feeAmountExVat: 500,
            scope: 'Tamper revise',
          },
          'P-000004',
        );
        expect(crossRevision.error).toContain('Quote not found');

        const tamperedSignOff = await signOffMatterCostsRecord(
          alphaMatterId,
          'P-000004',
          'Cross-tenant attempt',
        );
        expect(tamperedSignOff.matter).toBeNull();
        expect(tamperedSignOff.errors?.permission).toContain('Matter not found or restricted');
      },
      { tenantId: tenantBravo, mfaVerified: true },
    );

    // Fresh TenantPostgresPoolManager proves complete PostgreSQL DB separation
    const freshPoolMgr = new TenantPostgresPoolManager();
    openPoolManagers.push(freshPoolMgr);
    const freshCatRepo = new TenantCatalogueRepository({ poolManager: freshPoolMgr });
    const freshIntakeRepo = new TenantIntakeQuoteRepository({ poolManager: freshPoolMgr });
    const freshMatterRepo = new TenantMatterRepository({ poolManager: freshPoolMgr });
    const freshAuditRepo = new TenantAuditRepository({ poolManager: freshPoolMgr });

    const alphaCostsDb = await freshCatRepo.getMatterCostsConfig<MatterCostsConfig>(ctxAlpha);
    const bravoCostsDb = await freshCatRepo.getMatterCostsConfig<MatterCostsConfig>(ctxBravo);
    expect(alphaCostsDb?.vatRatePercent).toBe(5);
    expect(alphaCostsDb?.partnerSignOffThresholdGbp).toBe(5000);
    expect(bravoCostsDb?.vatRatePercent).toBe(20);
    expect(bravoCostsDb?.partnerSignOffThresholdGbp).toBe(40000);

    const alphaSameIdQuote = await freshIntakeRepo.getQuoteById<Quote>(ctxAlpha, alphaQuoteId);
    const bravoSameIdQuote = await freshIntakeRepo.getQuoteById<Quote>(ctxBravo, alphaQuoteId);
    expect(alphaSameIdQuote?.prospectName).toBe('Alpha Only Client');
    expect(alphaSameIdQuote?.vatRatePercent).toBe(5);
    expect(bravoSameIdQuote?.prospectName).toBe('Bravo Only Client');
    expect(bravoSameIdQuote?.vatRatePercent).toBe(20);

    expect(
      await freshIntakeRepo.getQuoteById<Quote>(ctxAlpha, alphaUniqueQuoteId),
    ).not.toBeNull();
    expect(
      await freshIntakeRepo.getQuoteById<Quote>(ctxBravo, alphaUniqueQuoteId),
    ).toBeNull();
    expect(await freshIntakeRepo.getQuoteById<Quote>(ctxAlpha, 'QTE-TAMPERED-999')).toBeNull();

    expect(await freshMatterRepo.getMatterById<Matter>(ctxAlpha, alphaMatterId)).not.toBeNull();
    expect(await freshMatterRepo.getMatterById<Matter>(ctxBravo, alphaMatterId)).toBeNull();
    expect(await freshMatterRepo.getMatterById<Matter>(ctxAlpha, 'M-TAMPERED-999')).toBeNull();

    const alphaAudits = await freshAuditRepo.listAuditEntriesForRecord(
      ctxAlpha,
      'quote',
      alphaUniqueQuoteId,
    );
    const bravoAudits = await freshAuditRepo.listAuditEntriesForRecord(
      ctxBravo,
      'quote',
      alphaUniqueQuoteId,
    );
    expect(alphaAudits.length).toBeGreaterThanOrEqual(1);
    expect(bravoAudits).toHaveLength(0);

    // Forged TenantContext (tenantId swapped to Bravo while targeting Alpha's context) fails closed
    const forgedCtx = Object.freeze({
      ...ctxAlpha,
      tenantId: tenantBravo,
    }) as TenantContext;
    await expect(freshCatRepo.getMatterCostsConfig(forgedCtx)).rejects.toThrow();

    expect(CORE_REQUIRED_SCHEMA_VERSION).toBe('0017');
  });

  it('7. S2: sums matter snapshot fee, multi-disbursement net, VAT, and combined totals strictly in integer minor units without float round-trips', () => {
    const multiDisbursements = [
      // 17.5% of £1.00 = £0.175 -> 18p per line; float hazards 0.1 + 0.2
      { id: 's2-d1', description: 'Search A', amountGbp: 1.0, vatApplicable: true },
      { id: 's2-d2', description: 'Search B', amountGbp: 1.0, vatApplicable: true },
      { id: 's2-d3', description: 'Copy A', amountGbp: 0.1, vatApplicable: true },
      { id: 's2-d4', description: 'Copy B', amountGbp: 0.2, vatApplicable: true },
    ];

    const breakdown = calculateMatterDisbursementsBreakdown(multiDisbursements, 17.5);
    expect(breakdown.netMinor).toBe(230); // 100 + 100 + 10 + 20 pence
    expect(breakdown.vatMinor).toBe(42); // 18 + 18 + 2 (1.75p->2p) + 4 (3.5p->4p)
    expect(breakdown.totalIncVatMinor).toBe(272);
    expect(breakdown.netGbp).toBe(2.3);
    expect(breakdown.vatGbp).toBe(0.42);
    expect(breakdown.totalIncVatGbp).toBe(2.72);

    // Fee £10.10 at 17.5% = 176.75p -> 177p (£1.77)
    const totalsWithFee = calculateMatterSnapshotTotals({
      totalEstimateGbp: 10.1,
      disbursements: multiDisbursements,
      vatRatePercent: 17.5,
    });
    expect(totalsWithFee).toEqual({
      disbursementsTotalGbp: 2.3,
      disbursementsVatGbp: 0.42,
      disbursementsTotalIncVatGbp: 2.72,
      estimatedFeeVatGbp: 1.77,
      totalIncVatGbp: 14.59,
      combinedExVatGbp: 12.4, // 1010p + 230p = 1240p
      combinedVatGbp: 2.19, // 177p + 42p = 219p
      combinedIncVatGbp: 14.59,
    });

    // When fee estimate is null, disbursements drive combined totals directly in minor units
    const totalsWithoutFee = calculateMatterSnapshotTotals({
      totalEstimateGbp: null,
      disbursements: multiDisbursements,
      vatRatePercent: 17.5,
    });
    expect(totalsWithoutFee).toEqual({
      disbursementsTotalGbp: 2.3,
      disbursementsVatGbp: 0.42,
      disbursementsTotalIncVatGbp: 2.72,
      estimatedFeeVatGbp: null,
      totalIncVatGbp: 2.72,
      combinedExVatGbp: 2.3,
      combinedVatGbp: 0.42,
      combinedIncVatGbp: 2.72,
    });

    // Empty disbursements and null fee estimate produce zero combined totals and null totalIncVatGbp
    const emptyTotals = calculateMatterSnapshotTotals({
      totalEstimateGbp: null,
      disbursements: [],
      vatRatePercent: 20,
    });
    expect(emptyTotals).toEqual({
      disbursementsTotalGbp: 0,
      disbursementsVatGbp: 0,
      disbursementsTotalIncVatGbp: 0,
      estimatedFeeVatGbp: null,
      totalIncVatGbp: null,
      combinedExVatGbp: 0,
      combinedVatGbp: 0,
      combinedIncVatGbp: 0,
    });
  });
});
