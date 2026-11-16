import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_REQUIRED_SCHEMA_VERSION,
  FEE_CAP_BASE_MISMATCH_CODE,
  FEE_CAP_CATEGORY_UNMAPPED_CODE,
  FEE_CAP_CONFIG_EXCEEDS_STATUTORY_CODE,
  FEE_CAP_EXCEEDED_FIRM_CODE,
  FEE_CAP_EXCEEDED_STATUTORY_CODE,
  FEE_CAP_EXCEEDED_WORK_TYPE_CODE,
  STATUTORY_FEE_CAPS_TABLE,
  TenantAuditRepository,
  TenantCatalogueRepository,
  TenantIntakeQuoteRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantPostgresPoolManager,
  createDefaultFirmFeeArrangementCaps,
  getStatutoryFeeCap,
  listActiveStatutoryFeeCaps,
  loadAndValidateTenantConfig,
  resolveEffectiveFeeCaps,
  resolveTenantFromVerifiedToken,
  validateFeeArrangementTerms,
  validateFirmFeeCapEntries,
  validateStatutoryFeeCapsTable,
  validateWorkTypeCapOverrides,
  validateWorkTypesConfig,
  type StatutoryFeeCapsTable,
  type TenantContext,
  type WorkTypesConfiguration,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import {
  reviseQuoteAction,
  saveMatterCostsConfigAction,
  saveQuoteAction,
  saveWorkTypesConfigAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import {
  computeCfaSuccessFeeUpliftGbp,
  createDefaultMatterCostsConfig,
} from '@/domain/matterCosts';
import {
  resolveEffectiveWorkTypesConfig,
  resolveWorkTypeFeeArrangementSettings,
} from '@/domain/workTypeConfig';
import type { Matter, MatterCostsSnapshot, Quote } from '@/domain/types';
import {
  getActiveTenantRawBaseConfig,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import {
  getAppSnapshot,
  resetAllDemoData,
  saveMatterCostsConfig,
  saveMatterRecord,
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
  feeBasis: 'CFA or DBA',
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
  roles: readonly string[] = [
    'admin',
    'partner',
    'fee_earner',
    'risk_compliance',
  ],
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
    correlationId: `corr-s028b-${tenantId}-${actorId}`,
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

describe('S0-28b: CFA & DBA Fee Arrangements, Core Statutory Caps & Work-Type Overrides (ADR 0034 §3)', () => {
  const openPoolManagers: TenantPostgresPoolManager[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    setTestActorSession(null);
    setActiveTenantConfigForTesting(null);
    while (openPoolManagers.length > 0) {
      const mgr = openPoolManagers.pop();
      if (mgr) {
        await mgr.closeAllPools();
      }
    }
  });

  it('1. Core statutory fee caps JSON, effective-dated rows, & CFA minor-unit uplift maths', () => {
    const schemaPath = path.join(
      process.cwd(),
      'core',
      'schemas',
      'statutory-fee-caps.schema.json',
    );
    const dataPath = path.join(
      process.cwd(),
      'core',
      'src',
      'domain',
      'costs',
      'statutory-fee-caps.json',
    );
    expect(fs.existsSync(schemaPath)).toBe(true);
    expect(fs.existsSync(dataPath)).toBe(true);

    const parsedJson = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as StatutoryFeeCapsTable;
    const validated = validateStatutoryFeeCapsTable(parsedJson);
    expect(validated.schemaVersion).toBe('1.0.0');
    expect(validated.rows).toHaveLength(5);

    const active = listActiveStatutoryFeeCaps('2026-11-16');
    expect(active).toHaveLength(5);

    const cfaCiv = getStatutoryFeeCap('cfa_general_civil', '2026-11-16');
    expect(cfaCiv).toMatchObject({
      feeBasis: 'conditional_fee_agreement',
      maxPercent: 100,
      capBaseKey: 'base_costs',
      capBaseDescription: 'base costs',
    });

    const cfaPi = getStatutoryFeeCap('cfa_personal_injury', '2026-11-16');
    expect(cfaPi).toMatchObject({
      feeBasis: 'conditional_fee_agreement',
      maxPercent: 25,
      capBaseKey: 'general_damages_and_past_pecuniary_losses_net_of_benefits',
    });
    expect(cfaPi?.capBaseDescription).toContain(
      'general damages for pain, suffering and loss of amenity plus past pecuniary losses, net of benefits recovered',
    );

    const dbaCiv = getStatutoryFeeCap('dba_general_civil', '2026-11-16');
    expect(dbaCiv).toMatchObject({
      feeBasis: 'damages_based_agreement',
      maxPercent: 50,
      capBaseKey: 'sums_recovered_inc_vat',
      capBaseDescription: 'sums recovered, including VAT',
    });

    const dbaEmp = getStatutoryFeeCap('dba_employment', '2026-11-16');
    expect(dbaEmp).toMatchObject({
      feeBasis: 'damages_based_agreement',
      maxPercent: 35,
      capBaseKey: 'sums_recovered_inc_vat',
      capBaseDescription: 'sums recovered, including VAT',
    });

    const dbaPi = getStatutoryFeeCap('dba_personal_injury', '2026-11-16');
    expect(dbaPi).toMatchObject({
      feeBasis: 'damages_based_agreement',
      maxPercent: 25,
      capBaseKey: 'general_damages_and_past_losses_inc_vat',
      capBaseDescription: 'general damages plus past losses, including VAT',
    });

    // Effective-dated law change row resolution without code edits
    const versionedTable: StatutoryFeeCapsTable = {
      schemaVersion: '1.0.0',
      rows: [
        ...STATUTORY_FEE_CAPS_TABLE.rows.filter(
          (r) => r.capCategoryKey !== 'dba_general_civil',
        ),
        {
          rowId: 'STAT-CAP-DBA-CIV-2013',
          capCategoryKey: 'dba_general_civil',
          feeBasis: 'damages_based_agreement',
          caseTypeLabel: 'General civil',
          maxPercent: 50,
          capBaseKey: 'sums_recovered_inc_vat',
          capBaseDescription: 'sums recovered, including VAT',
          effectiveFrom: '2013-04-01',
          effectiveTo: '2027-03-31',
          legislationRef: 'DBA Regs 2013',
        },
        {
          rowId: 'STAT-CAP-DBA-CIV-2027',
          capCategoryKey: 'dba_general_civil',
          feeBasis: 'damages_based_agreement',
          caseTypeLabel: 'General civil',
          maxPercent: 40,
          capBaseKey: 'sums_recovered_inc_vat',
          capBaseDescription: 'sums recovered, including VAT',
          effectiveFrom: '2027-04-01',
          effectiveTo: null,
          legislationRef: 'Updated DBA Regs 2027',
        },
      ],
    };
    validateStatutoryFeeCapsTable(versionedTable);
    expect(
      getStatutoryFeeCap('dba_general_civil', '2027-03-31', versionedTable)
        ?.maxPercent,
    ).toBe(50);
    expect(
      getStatutoryFeeCap('dba_general_civil', '2027-04-01', versionedTable)
        ?.maxPercent,
    ).toBe(40);

    // Reject overlapping statutory effective dates
    expect(() =>
      validateStatutoryFeeCapsTable({
        schemaVersion: '1.0.0',
        rows: [
          ...STATUTORY_FEE_CAPS_TABLE.rows,
          {
            ...cfaCiv!,
            rowId: 'STAT-CAP-OVERLAP',
            effectiveFrom: '2020-01-01',
            effectiveTo: null,
          },
        ],
      }),
    ).toThrow(/Overlapping effective date ranges/);

    // Minor-unit CFA uplift arithmetic
    expect(computeCfaSuccessFeeUpliftGbp(1000.05, 25)).toBe(250.01);
    expect(computeCfaSuccessFeeUpliftGbp(0.01, 50)).toBe(0.01);
  });

  it('2. Config engine defaults, R486 work-type cap precedence (above/below firm cap), & ingestItems preservation', () => {
    const baseRaw = getActiveTenantRawBaseConfig();
    const baseCfg = loadAndValidateTenantConfig(baseRaw, {}, 'test', 'multi_tenant');

    // Default firm caps match all 5 statutory maximums
    expect(baseCfg.matterCosts.feeArrangementCaps).toEqual(
      createDefaultFirmFeeArrangementCaps(),
    );

    // Overlay sets firm cap to 50% on cfa_general_civil AND work-type override to 80% (R486: above firm cap, within statutory 100%)
    const r486Overlaid = loadAndValidateTenantConfig(
      baseRaw,
      {
        matterCosts: {
          feeArrangementCaps: [
            {
              capCategoryKey: 'cfa_general_civil',
              maxPercent: 50,
              capBaseKey: 'base_costs',
            },
          ],
        },
        workTypes: {
          items: [
            {
              workTypeId: 'work_type.dispute_resolution_court_pleadings',
              practiceAreaId: 'work_type.dispute_resolution',
              active: true,
              autoTaskTemplates: [],
              riskQuestions: [],
              feeArrangementCapCategories: {
                conditional_fee_agreement: 'cfa_general_civil',
                damages_based_agreement: 'dba_general_civil',
              },
              workTypeCapOverrides: [
                {
                  capCategoryKey: 'cfa_general_civil',
                  maxPercent: 80,
                  capBaseKey: 'base_costs',
                },
              ],
            },
          ],
        },
      },
      'test',
      'multi_tenant',
    );

    const courtItem = r486Overlaid.workTypes?.items.find(
      (i) => i.workTypeId === 'work_type.dispute_resolution_court_pleadings',
    );
    expect(courtItem?.workTypeCapOverrides).toEqual([
      {
        capCategoryKey: 'cfa_general_civil',
        maxPercent: 80,
        capBaseKey: 'base_costs',
      },
    ]);

    // R486 precedence check: workType (80%) supersedes firm (50%) up to statutory (100%)
    const resolvedWithWtAboveFirm = resolveEffectiveFeeCaps({
      capCategoryKey: 'cfa_general_civil',
      firmCaps: r486Overlaid.matterCosts.feeArrangementCaps,
      workTypeCapOverrides: courtItem?.workTypeCapOverrides,
    });
    expect(resolvedWithWtAboveFirm.ok).toBe(true);
    if (resolvedWithWtAboveFirm.ok) {
      expect(resolvedWithWtAboveFirm.resolution.appliedCapPercent).toBe(80);
      expect(resolvedWithWtAboveFirm.resolution.capLevel).toBe('work_type');
    }

    // Without work-type override, lowered firm cap (50%) applies
    const resolvedFirmOnly = resolveEffectiveFeeCaps({
      capCategoryKey: 'cfa_general_civil',
      firmCaps: r486Overlaid.matterCosts.feeArrangementCaps,
      workTypeCapOverrides: [],
    });
    expect(resolvedFirmOnly.ok).toBe(true);
    if (resolvedFirmOnly.ok) {
      expect(resolvedFirmOnly.resolution.appliedCapPercent).toBe(50);
      expect(resolvedFirmOnly.resolution.capLevel).toBe('firm');
    }

    // Config validation rejects firm cap > statutory max (FEE_CAP_CONFIG_EXCEEDS_STATUTORY)
    expect(() =>
      loadAndValidateTenantConfig(
        baseRaw,
        {
          matterCosts: {
            feeArrangementCaps: [
              {
                capCategoryKey: 'cfa_personal_injury',
                maxPercent: 30,
                capBaseKey:
                  'general_damages_and_past_pecuniary_losses_net_of_benefits',
              },
            ],
          },
        },
        'test',
        'multi_tenant',
      ),
    ).toThrow(FEE_CAP_CONFIG_EXCEEDS_STATUTORY_CODE);

    // Work-type override > statutory max rejected fail closed
    expect(() =>
      validateWorkTypesConfig({
        defaults: r486Overlaid.workTypes!.defaults,
        items: [
          {
            workTypeId: 'work_type.dispute_resolution_court_pleadings',
            practiceAreaId: 'work_type.dispute_resolution',
            active: true,
            autoTaskTemplates: [],
            riskQuestions: [],
            workTypeCapOverrides: [
              {
                capCategoryKey: 'dba_employment',
                maxPercent: 40,
                capBaseKey: 'sums_recovered_inc_vat',
              },
            ],
          },
        ],
      }),
    ).toThrow(FEE_CAP_CONFIG_EXCEEDS_STATUTORY_CODE);

    expect(
      validateWorkTypeCapOverrides([
        {
          capCategoryKey: 'cfa_personal_injury',
          maxPercent: 26,
          capBaseKey:
            'general_damages_and_past_pecuniary_losses_net_of_benefits',
        },
      ]),
    ).toMatchObject({
      ok: false,
      code: FEE_CAP_CONFIG_EXCEEDS_STATUTORY_CODE,
    });

    expect(
      validateFirmFeeCapEntries([
        {
          capCategoryKey: 'dba_employment',
          maxPercent: 30,
          capBaseKey: 'wrong_base_key',
        },
      ]),
    ).toMatchObject({
      ok: false,
      code: FEE_CAP_BASE_MISMATCH_CODE,
    });

    // ingestItems preserves feeArrangementCapCategories and workTypeCapOverrides
    const effectiveWt = resolveEffectiveWorkTypesConfig(r486Overlaid, {
      defaults: r486Overlaid.workTypes!.defaults,
      items: [
        ...r486Overlaid.workTypes!.items,
        {
          workTypeId: 'work_type.dispute_resolution_pre_action_correspondence',
          practiceAreaId: 'work_type.dispute_resolution',
          active: true,
          autoTaskTemplates: [],
          riskQuestions: [],
          feeArrangementCapCategories: {
            conditional_fee_agreement: 'cfa_personal_injury',
          },
          workTypeCapOverrides: [
            {
              capCategoryKey: 'cfa_personal_injury',
              maxPercent: 20,
              capBaseKey:
                'general_damages_and_past_pecuniary_losses_net_of_benefits',
            },
          ],
        },
      ],
    });
    const preActionSettings = resolveWorkTypeFeeArrangementSettings(
      effectiveWt,
      {
        workTypeSubcategoryId:
          'work_type.dispute_resolution_pre_action_correspondence',
        practiceAreaId: 'work_type.dispute_resolution',
      },
    );
    expect(preActionSettings.feeArrangementCapCategories).toEqual({
      conditional_fee_agreement: 'cfa_personal_injury',
    });
    expect(preActionSettings.workTypeCapOverrides).toEqual([
      {
        capCategoryKey: 'cfa_personal_injury',
        maxPercent: 20,
        capBaseKey:
          'general_damages_and_past_pecuniary_losses_net_of_benefits',
      },
    ]);

    // Pure term validation covers every exact failure & boundary path
    expect(
      validateFeeArrangementTerms({
        feeBasis: 'conditional_fee_agreement',
        workTypeId: '',
        workTypeCapCategories: { conditional_fee_agreement: 'cfa_general_civil' },
        submittedPercent: 10,
        submittedCapBaseKey: 'base_costs',
      }),
    ).toMatchObject({ ok: false, code: FEE_CAP_CATEGORY_UNMAPPED_CODE });

    expect(
      validateFeeArrangementTerms({
        feeBasis: 'damages_based_agreement',
        workTypeId: 'work_type.unmapped',
        workTypeCapCategories: {},
        submittedPercent: 10,
        submittedCapBaseKey: 'sums_recovered_inc_vat',
      }),
    ).toMatchObject({ ok: false, code: FEE_CAP_CATEGORY_UNMAPPED_CODE });

    expect(
      validateFeeArrangementTerms({
        feeBasis: 'conditional_fee_agreement',
        workTypeId: 'wt-1',
        workTypeCapCategories: {
          conditional_fee_agreement: 'cfa_general_civil',
        },
        submittedPercent: 25,
        submittedCapBaseKey: 'sums_recovered_inc_vat',
      }),
    ).toMatchObject({ ok: false, code: FEE_CAP_BASE_MISMATCH_CODE });

    expect(
      validateFeeArrangementTerms({
        feeBasis: 'conditional_fee_agreement',
        workTypeId: 'wt-1',
        workTypeCapCategories: {
          conditional_fee_agreement: 'cfa_general_civil',
        },
        submittedPercent: 80.5,
        submittedCapBaseKey: 'base_costs',
        firmCaps: r486Overlaid.matterCosts.feeArrangementCaps,
        workTypeCapOverrides: courtItem?.workTypeCapOverrides,
      }),
    ).toMatchObject({ ok: false, code: FEE_CAP_EXCEEDED_WORK_TYPE_CODE });

    expect(
      validateFeeArrangementTerms({
        feeBasis: 'conditional_fee_agreement',
        workTypeId: 'wt-1',
        workTypeCapCategories: {
          conditional_fee_agreement: 'cfa_general_civil',
        },
        submittedPercent: 55,
        submittedCapBaseKey: 'base_costs',
        firmCaps: r486Overlaid.matterCosts.feeArrangementCaps,
        workTypeCapOverrides: [],
      }),
    ).toMatchObject({ ok: false, code: FEE_CAP_EXCEEDED_FIRM_CODE });

    expect(
      validateFeeArrangementTerms({
        feeBasis: 'conditional_fee_agreement',
        workTypeId: 'wt-1',
        workTypeCapCategories: {
          conditional_fee_agreement: 'cfa_general_civil',
        },
        submittedPercent: 100.5,
        submittedCapBaseKey: 'base_costs',
        firmCaps: r486Overlaid.matterCosts.feeArrangementCaps,
        workTypeCapOverrides: courtItem?.workTypeCapOverrides,
      }),
    ).toMatchObject({ ok: false, code: FEE_CAP_EXCEEDED_STATUTORY_CODE });

    // Exact boundary passes
    expect(
      validateFeeArrangementTerms({
        feeBasis: 'conditional_fee_agreement',
        workTypeId: 'wt-1',
        workTypeCapCategories: {
          conditional_fee_agreement: 'cfa_general_civil',
        },
        submittedPercent: 80,
        submittedCapBaseKey: 'base_costs',
        firmCaps: r486Overlaid.matterCosts.feeArrangementCaps,
        workTypeCapOverrides: courtItem?.workTypeCapOverrides,
      }),
    ).toMatchObject({ ok: true, acceptedPercent: 80 });
  });

  it('3. Server enforcement: Matter, Partner sign-off (no override), Quote create/revise, R486 & same-TX audit rollback', async () => {
    await runAsActionActor(
      'P-000004',
      () => resetAllDemoData('P-000004', testDataResetContext()),
      { mfaVerified: true },
    );

    const baseSnap = await runAsActionActor('P-000004', () =>
      getAppSnapshot('P-000004'),
    );
    const defaultClientOrg = baseSnap.organisations[0]!;
    const templateMatter = baseSnap.matters.find((m) => m.id === 'M-000011') ?? baseSnap.matters[0]!;
    const { id: _omitMatterId, rowVersion: _omitRv, ...matterTemplate } = templateMatter;
    void _omitMatterId;
    void _omitRv;

    // Lower firm cfa_general_civil cap to 50% (audited via saveMatterCostsConfigAction)
    const auditMark = await markAuditPosition();
    const updatedCostsCfg = await runAsActionActor(
      'P-000004',
      () =>
        saveMatterCostsConfigAction({
          ...baseSnap.matterCostsConfig,
          feeArrangementCaps: createDefaultFirmFeeArrangementCaps().map((c) =>
            c.capCategoryKey === 'cfa_general_civil'
              ? { ...c, maxPercent: 50 }
              : c,
          ),
        }),
      { mfaVerified: true },
    );
    expect(isActionDenied(updatedCostsCfg)).toBe(false);
    const firmCapAudits = await auditEntriesSince(auditMark);
    expect(
      firmCapAudits.some(
        (a) =>
          a.recordId === 'FIRM-MATTER-COSTS-CONFIG' &&
          a.newValue?.includes('cfa_general_civil=50%@base_costs'),
      ),
    ).toBe(true);

    // Firm cap > statutory max rejected fail closed on save
    await runAsActionActor(
      'P-000004',
      async () => {
        await expect(
          saveMatterCostsConfig(
            {
              ...baseSnap.matterCostsConfig,
              feeArrangementCaps: createDefaultFirmFeeArrangementCaps().map((c) =>
                c.capCategoryKey === 'cfa_personal_injury'
                  ? { ...c, maxPercent: 26 }
                  : c,
              ),
            },
            'P-000004',
          ),
        ).rejects.toMatchObject({ code: FEE_CAP_CONFIG_EXCEEDS_STATUTORY_CODE });
      },
      { mfaVerified: true },
    );

    // Work type configuration: configure Mediation & ADR unoverridden (inherits 50% firm cap),
    // Court pleadings overridden to 80% (R486 above 50% firm cap, <= 100% statutory max),
    // and Pre-action correspondence as Personal Injury CFA (25% statutory max)
    const wtBase = baseSnap.workTypesConfig!;
    const wtUpdateItems = [
      ...wtBase.items.filter(
        (i) =>
          i.workTypeId !== 'work_type.dispute_resolution_court_pleadings' &&
          i.workTypeId !== 'work_type.dispute_resolution_mediation_and_adr' &&
          i.workTypeId !==
            'work_type.dispute_resolution_pre_action_correspondence',
      ),
      {
        workTypeId: 'work_type.dispute_resolution_mediation_and_adr',
        practiceAreaId: 'work_type.dispute_resolution',
        active: true,
        autoTaskTemplates: [],
        riskQuestions: [],
        feeArrangementCapCategories: {
          conditional_fee_agreement: 'cfa_general_civil',
        },
      },
      {
        workTypeId: 'work_type.dispute_resolution_court_pleadings',
        practiceAreaId: 'work_type.dispute_resolution',
        active: true,
        autoTaskTemplates: [],
        riskQuestions: [],
        feeArrangementCapCategories: {
          conditional_fee_agreement: 'cfa_general_civil',
          damages_based_agreement: 'dba_general_civil',
        },
        workTypeCapOverrides: [
          {
            capCategoryKey: 'cfa_general_civil',
            maxPercent: 80,
            capBaseKey: 'base_costs',
          },
        ],
      },
      {
        workTypeId: 'work_type.dispute_resolution_pre_action_correspondence',
        practiceAreaId: 'work_type.dispute_resolution',
        active: true,
        autoTaskTemplates: [],
        riskQuestions: [],
        feeArrangementCapCategories: {
          conditional_fee_agreement: 'cfa_personal_injury',
          damages_based_agreement: 'dba_personal_injury',
        },
      },
    ];

    // Reject work-type override exceeding statutory max
    const badWtRes = await runAsActionActor(
      'P-000004',
      () =>
        saveWorkTypesConfigAction(
          {
            ...wtBase,
            items: [
              ...wtUpdateItems,
              {
                workTypeId: 'work_type.dispute_resolution_enforcement',
                practiceAreaId: 'work_type.dispute_resolution',
                active: true,
                autoTaskTemplates: [],
                riskQuestions: [],
                workTypeCapOverrides: [
                  {
                    capCategoryKey: 'dba_personal_injury',
                    maxPercent: 30,
                    capBaseKey: 'general_damages_and_past_losses_inc_vat',
                  },
                ],
              },
            ],
          },
          'Excessive work-type cap should fail closed',
        ),
      { mfaVerified: true },
    );
    expect(badWtRes).toMatchObject({
      ok: false,
      code: FEE_CAP_CONFIG_EXCEEDS_STATUTORY_CODE,
    });

    // Accept valid R486 work-type override above firm cap
    const goodWtRes = await runAsActionActor(
      'P-000004',
      () =>
        saveWorkTypesConfigAction(
          { ...wtBase, items: wtUpdateItems },
          'Configure R486 CFA cap override 80% for Court pleadings',
        ),
      { mfaVerified: true },
    );
    expect(goodWtRes).toMatchObject({ ok: true });

    // A. Unmapped work type (Corporate M&A) -> FEE_CAP_CATEGORY_UNMAPPED across Quotes & Matters
    const unmappedQuote = await runAsActionActor('P-000004', () =>
      saveQuoteAction({
        clientType: 'existing',
        linkedOrganisationId: defaultClientOrg.id,
        practiceAreaId: 'work_type.corporate_and_commercial',
        workTypeSubcategoryId:
          'work_type.corporate_and_commercial_mergers_and_acquisitions',
        scope: 'Unmapped CFA attempt',
        feeBasis: 'Conditional fee agreement (CFA)',
        feeAmountExVat: 5000,
        feeArrangementPercent: 25,
        feeArrangementCapBaseKey: 'base_costs',
      }),
    );
    expect(isActionDenied(unmappedQuote)).toBe(false);
    if (!isActionDenied(unmappedQuote)) {
      expect(unmappedQuote.code).toBe(FEE_CAP_CATEGORY_UNMAPPED_CODE);
      expect(unmappedQuote.error).toMatch(/FEE_CAP_CATEGORY_UNMAPPED|mapped CFA/i);
      expect(unmappedQuote.quote).toBeUndefined();
    }

    // B. Wrong calculation base -> FEE_CAP_BASE_MISMATCH
    const badBaseQuote = await runAsActionActor('P-000004', () =>
      saveQuoteAction({
        clientType: 'existing',
        linkedOrganisationId: defaultClientOrg.id,
        practiceAreaId: 'work_type.dispute_resolution',
        workTypeSubcategoryId:
          'work_type.dispute_resolution_pre_action_correspondence',
        scope: 'Wrong base PI CFA',
        feeBasis: 'Conditional fee agreement (CFA)',
        feeAmountExVat: 5000,
        feeArrangementPercent: 20,
        feeArrangementCapBaseKey: 'base_costs',
      }),
    );
    if (!isActionDenied(badBaseQuote)) {
      expect(badBaseQuote.code).toBe(FEE_CAP_BASE_MISMATCH_CODE);
      expect(badBaseQuote.error).toContain(
        'general_damages_and_past_pecuniary_losses_net_of_benefits',
      );
    }

    // C. Firm cap lowered to 50%: Mediation & ADR rejects 55% with FEE_CAP_EXCEEDED_FIRM on Quote
    const overFirmQuote = await runAsActionActor('P-000004', () =>
      saveQuoteAction({
        clientType: 'existing',
        linkedOrganisationId: defaultClientOrg.id,
        practiceAreaId: 'work_type.dispute_resolution',
        workTypeSubcategoryId:
          'work_type.dispute_resolution_mediation_and_adr',
        scope: 'Over firm cap Mediation CFA',
        feeBasis: 'Conditional fee agreement (CFA)',
        feeAmountExVat: 8000,
        feeArrangementPercent: 55,
        feeArrangementCapBaseKey: 'base_costs',
      }),
    );
    if (!isActionDenied(overFirmQuote)) {
      expect(overFirmQuote.code).toBe(FEE_CAP_EXCEEDED_FIRM_CODE);
      expect(overFirmQuote.error).toContain('55%');
      expect(overFirmQuote.error).toContain('50%');
      expect(overFirmQuote.error).toContain('base costs');
    }

    // D. R486: Court pleadings (override 80% > firm 50%) accepts 75% and 80% on Quote, archives on revise, rejects 85% (WORK_TYPE) & 105% (STATUTORY)
    const quoteAuditMark = await markAuditPosition();
    const okR486QuoteRes = await runAsActionActor('P-000004', () =>
      saveQuoteAction({
        clientType: 'existing',
        linkedOrganisationId: defaultClientOrg.id,
        practiceAreaId: 'work_type.dispute_resolution',
        workTypeSubcategoryId: 'work_type.dispute_resolution_court_pleadings',
        scope: 'Court pleadings R486 CFA 75%',
        feeBasis: 'Conditional fee agreement (CFA)',
        feeAmountExVat: 12000,
        feeArrangementCapCategoryKey: 'cfa_general_civil',
        feeArrangementPercent: 75,
        feeArrangementCapBaseKey: 'base_costs',
      }),
    );
    expect(isActionDenied(okR486QuoteRes)).toBe(false);
    const createdQuote = !isActionDenied(okR486QuoteRes)
      ? okR486QuoteRes.quote!
      : undefined!;
    expect(createdQuote).toBeDefined();
    expect(createdQuote.feeArrangementPercent).toBe(75);
    expect(createdQuote.feeArrangementCapBaseKey).toBe('base_costs');
    expect(createdQuote.feeArrangementCapBaseDescription).toBe('base costs');
    expect(createdQuote.feeArrangementAppliedCapPercent).toBe(80);
    expect(createdQuote.feeArrangementCapLevel).toBe('work_type');

    const quoteAudits = await auditEntriesSince(quoteAuditMark);
    expect(
      quoteAudits.some(
        (a) =>
          a.recordId === createdQuote.id &&
          a.field === 'Fee arrangement & cap' &&
          a.newValue?.includes('75% of base costs'),
      ),
    ).toBe(true);

    // Revise attempt above work-type cap (85% > 80%) rejected cleanly without mutating versionHistory
    const badRevise = await runAsActionActor('P-000004', () =>
      reviseQuoteAction(createdQuote.id, {
        feeBasis: 'Conditional fee agreement (CFA)',
        feeAmountExVat: 12000,
        scope: 'Attempt 85% above work-type cap',
        feeArrangementCapCategoryKey: 'cfa_general_civil',
        feeArrangementPercent: 85,
        feeArrangementCapBaseKey: 'base_costs',
      }),
    );
    if (!isActionDenied(badRevise)) {
      expect(badRevise.code).toBe(FEE_CAP_EXCEEDED_WORK_TYPE_CODE);
      expect(badRevise.error).toContain('85%');
      expect(badRevise.error).toContain('80%');
    }

    // Valid revision to DBA (50%) on Court pleadings archives v1 CFA fields in Superseded snapshot
    const dbaRevise = await runAsActionActor('P-000004', () =>
      reviseQuoteAction(createdQuote.id, {
        feeBasis: 'Damages-based agreement (DBA)',
        feeAmountExVat: 0,
        scope: 'Revised to 45% DBA',
        feeArrangementCapCategoryKey: 'dba_general_civil',
        feeArrangementPercent: 45,
        feeArrangementCapBaseKey: 'sums_recovered_inc_vat',
      }),
    );
    if (!isActionDenied(dbaRevise)) {
      expect(dbaRevise.quote?.version).toBe(2);
      expect(dbaRevise.quote?.feeArrangementCapCategoryKey).toBe('dba_general_civil');
      expect(dbaRevise.quote?.feeArrangementPercent).toBe(45);
      expect(dbaRevise.quote?.feeArrangementCapBaseDescription).toBe(
        'sums recovered, including VAT',
      );
      expect(dbaRevise.quote?.versionHistory[0]?.feeArrangementPercent).toBe(75);
      expect(dbaRevise.quote?.versionHistory[0]?.feeArrangementCapBaseKey).toBe(
        'base_costs',
      );
    }

    // E. Matter save & Partner sign-off fail closed (zero override path) + R486 acceptance
    const buildCostsPayload = (
      workBasis: MatterCostsSnapshot['workBasis'],
      percent: number,
      capBaseKey: string,
      capCategoryKey?: string,
    ): MatterCostsSnapshot => ({
      workBasis,
      rateSource: 'app_table',
      rateCardId: 'RC-DEFAULT',
      rateCardName: 'Firm Standard Rate Card',
      partnerRateGbp: 350,
      associateRateGbp: 250,
      traineeRateGbp: 145,
      totalEstimateGbp: 15000,
      agreedCapGbp: null,
      feeArrangementCapCategoryKey: capCategoryKey,
      feeArrangementPercent: percent,
      feeArrangementCapBaseKey: capBaseKey,
      disbursements: [],
      disbursementsTotalGbp: 0,
      paymentOnAccountRequired: 'No',
      paymentOnAccountAmountGbp: null,
    });

    // Save valid 75% CFA on Court pleadings (R486) as a new draft matter
    const matterAuditMark = await markAuditPosition();
    const okMatterSave = await runAsActionActor(
      'P-000004',
      () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            matterNumber: 'DRAFT',
            openedAt: null,
            closedAt: null,
            title: 'S0-28b R486 CFA Matter',
            clientId: defaultClientOrg.id,
            practiceAreaId: 'work_type.dispute_resolution',
            workTypeSubcategoryId: 'work_type.dispute_resolution_court_pleadings',
            responsiblePartnerId: 'P-000004',
            supervisingPartnerId: 'P-000004',
            leadFeeEarnerId: 'P-000004',
            teamMemberIds: ['P-000004'],
            fieldValues: {
              matterCosts: buildCostsPayload(
                'conditional_fee_agreement',
                75,
                'base_costs',
                'cfa_general_civil',
              ),
            },
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000004', saveMode: 'draft' },
        ),
      { mfaVerified: true },
    );
    expect(okMatterSave.errors).toBeUndefined();
    expect(okMatterSave.matter).not.toBeNull();
    const createdMatter = okMatterSave.matter!;
    const savedCosts = createdMatter.fieldValues
      ?.matterCosts as MatterCostsSnapshot;
    expect(savedCosts.feeArrangementPercent).toBe(75);
    expect(savedCosts.feeArrangementAppliedCapPercent).toBe(80);
    expect(savedCosts.feeArrangementCapLevel).toBe('work_type');
    expect(savedCosts.feeArrangementCapBaseKey).toBe('base_costs');
    const matterAudits = await auditEntriesSince(matterAuditMark);
    expect(
      matterAudits.some(
        (a) =>
          a.recordId === createdMatter.id &&
          a.field === 'Fee arrangement & cap' &&
          a.newValue?.includes('75% of base costs'),
      ),
    ).toBe(true);

    // Lower work-type cap below 75% (to 60%) AFTER matter saved, then test Partner sign-off FAILS CLOSED (zero override path!)
    await runAsActionActor(
      'P-000004',
      () =>
        saveWorkTypesConfigAction(
          {
            ...wtBase,
            items: wtUpdateItems.map((it) =>
              it.workTypeId === 'work_type.dispute_resolution_court_pleadings'
                ? {
                    ...it,
                    workTypeCapOverrides: [
                      {
                        capCategoryKey: 'cfa_general_civil',
                        maxPercent: 60,
                        capBaseKey: 'base_costs',
                      },
                    ],
                  }
                : it,
            ),
          },
          'Tighten court pleadings CFA cap to 60%',
        ),
      { mfaVerified: true },
    );

    const blockedSignOff = await runAsActionActor(
      'P-000004',
      () =>
        signOffMatterCostsRecord(
          createdMatter.id,
          'P-000004',
          'Partner attempt to override cap',
        ),
      { mfaVerified: true },
    );
    expect(blockedSignOff.matter).toBeNull();
    expect(blockedSignOff.code).toBe(FEE_CAP_EXCEEDED_WORK_TYPE_CODE);
    expect(blockedSignOff.errors?.matterCosts).toContain('75%');
    expect(blockedSignOff.errors?.matterCosts).toContain('60%');

    // Attempt over statutory max on Matter save (105% > 100%) rejected fail closed
    const overStatutoryMatter = await runAsActionActor(
      'P-000004',
      () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            matterNumber: 'DRAFT',
            openedAt: null,
            closedAt: null,
            title: 'Over statutory CFA',
            clientId: defaultClientOrg.id,
            practiceAreaId: 'work_type.dispute_resolution',
            workTypeSubcategoryId: 'work_type.dispute_resolution_court_pleadings',
            responsiblePartnerId: 'P-000004',
            supervisingPartnerId: 'P-000004',
            leadFeeEarnerId: 'P-000004',
            teamMemberIds: ['P-000004'],
            fieldValues: {
              matterCosts: buildCostsPayload(
                'conditional_fee_agreement',
                105,
                'base_costs',
                'cfa_general_civil',
              ),
            },
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000004', saveMode: 'draft' },
        ),
      { mfaVerified: true },
    );
    expect(overStatutoryMatter.matter).toBeNull();
    expect(overStatutoryMatter.code).toBe(FEE_CAP_EXCEEDED_STATUTORY_CODE);

    // Same-transaction atomicity: if audit append fails inside saveQuoteRecord TX, quote insert rolls back
    const quotesBeforeRollback = await new TenantIntakeQuoteRepository().listAllQuotesUnfiltered<Quote>(
      testTenantCtx('P-000004'),
    );
    const appendSpy = vi
      .spyOn(TenantAuditRepository.prototype, 'appendAuditEntries')
      .mockRejectedValueOnce(new Error('SIMULATED_AUDIT_FAILURE'));
    await expect(
      runAsActionActor('P-000004', () =>
        saveQuoteAction({
          clientType: 'existing',
          linkedOrganisationId: defaultClientOrg.id,
          practiceAreaId: 'work_type.employment_and_hr',
          workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
          scope: 'DBA employment rollback check',
          feeBasis: 'Damages-based agreement (DBA)',
          feeAmountExVat: 0,
          feeArrangementCapCategoryKey: 'dba_employment',
          feeArrangementPercent: 30,
          feeArrangementCapBaseKey: 'sums_recovered_inc_vat',
        }),
      ),
    ).rejects.toThrow(/SIMULATED_AUDIT_FAILURE/);
    appendSpy.mockRestore();
    const quotesAfterRollback = await new TenantIntakeQuoteRepository().listAllQuotesUnfiltered<Quote>(
      testTenantCtx('P-000004'),
    );
    expect(quotesAfterRollback).toHaveLength(quotesBeforeRollback.length);
  });

  it('4. Two-tenant PostgreSQL isolation (P8): independent firm/work-type caps, fresh-connection readback, tampered IDs & forged TenantContext', async () => {
    const tenantAlpha = 's028b-alpha';
    const tenantBravo = 's028b-bravo';
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
    expect(CORE_REQUIRED_SCHEMA_VERSION).toBe('0020');

    const alphaRaw = {
      ...getActiveTenantRawBaseConfig(),
      tenantId: tenantAlpha,
      displayName: 'Alpha Disputes LLP',
      environment: 'test' as const,
      hostingMode: 'multi_tenant' as const,
    };
    const bravoRaw = {
      ...getActiveTenantRawBaseConfig(),
      tenantId: tenantBravo,
      displayName: 'Bravo Litigation LLP',
      environment: 'test' as const,
      hostingMode: 'multi_tenant' as const,
    };

    const alphaValidated = loadAndValidateTenantConfig(
      alphaRaw,
      {
        matterCosts: {
          feeArrangementCaps: [
            {
              capCategoryKey: 'cfa_general_civil',
              maxPercent: 40,
              capBaseKey: 'base_costs',
            },
          ],
        },
        workTypes: {
          items: [
            {
              workTypeId: 'work_type.dispute_resolution_court_pleadings',
              practiceAreaId: 'work_type.dispute_resolution',
              active: true,
              autoTaskTemplates: [],
              riskQuestions: [],
              feeArrangementCapCategories: {
                conditional_fee_agreement: 'cfa_general_civil',
              },
            },
          ],
        },
      },
      'test',
      'multi_tenant',
    );
    const bravoValidated = loadAndValidateTenantConfig(
      bravoRaw,
      {
        matterCosts: {
          feeArrangementCaps: [
            {
              capCategoryKey: 'cfa_general_civil',
              maxPercent: 50,
              capBaseKey: 'base_costs',
            },
          ],
        },
        workTypes: {
          items: [
            {
              workTypeId: 'work_type.dispute_resolution_court_pleadings',
              practiceAreaId: 'work_type.dispute_resolution',
              active: true,
              autoTaskTemplates: [],
              riskQuestions: [],
              feeArrangementCapCategories: {
                conditional_fee_agreement: 'cfa_general_civil',
              },
              workTypeCapOverrides: [
                {
                  capCategoryKey: 'cfa_general_civil',
                  maxPercent: 85,
                  capBaseKey: 'base_costs',
                },
              ],
            },
          ],
        },
      },
      'test',
      'multi_tenant',
    );

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

    const catRepo = new TenantCatalogueRepository();
    await catRepo.putMatterCostsConfig(
      ctxAlpha,
      {
        ...createDefaultMatterCostsConfig(alphaSeed.values),
        feeArrangementCaps: alphaValidated.matterCosts.feeArrangementCaps,
      },
      'P-000004',
    );
    await catRepo.putWorkTypeConfigs(
      ctxAlpha,
      alphaValidated.workTypes!,
      'P-000004',
    );
    await catRepo.putMatterCostsConfig(
      ctxBravo,
      {
        ...createDefaultMatterCostsConfig(bravoSeed.values),
        feeArrangementCaps: bravoValidated.matterCosts.feeArrangementCaps,
      },
      'P-000004',
    );
    await catRepo.putWorkTypeConfigs(
      ctxBravo,
      bravoValidated.workTypes!,
      'P-000004',
    );

    // Tenant Alpha host enforcement rejects 65% (> 40% firm cap) even though Bravo allows 85%
    setActiveTenantConfigForTesting(alphaRaw);
    const alphaOrg = alphaSeed.organisations[0]!;
    const alphaBlocked = await runAsActionActor(
      'P-000004',
      () =>
        saveQuoteAction({
          clientType: 'existing',
          linkedOrganisationId: alphaOrg.id,
          practiceAreaId: 'work_type.dispute_resolution',
          workTypeSubcategoryId: 'work_type.dispute_resolution_court_pleadings',
          scope: 'Alpha blocked above 40%',
          feeBasis: 'Conditional fee agreement (CFA)',
          feeAmountExVat: 9000,
          feeArrangementCapCategoryKey: 'cfa_general_civil',
          feeArrangementPercent: 65,
          feeArrangementCapBaseKey: 'base_costs',
        }),
      { tenantId: tenantAlpha, mfaVerified: true },
    );
    if (!isActionDenied(alphaBlocked)) {
      expect(alphaBlocked.code).toBe(FEE_CAP_EXCEEDED_FIRM_CODE);
    }

    // Tenant Alpha accepts 40% (within Alpha's firm cap) and also creates a second quote unique to Alpha
    const alphaAllowed = await runAsActionActor(
      'P-000004',
      () =>
        saveQuoteAction({
          clientType: 'existing',
          linkedOrganisationId: alphaOrg.id,
          practiceAreaId: 'work_type.dispute_resolution',
          workTypeSubcategoryId: 'work_type.dispute_resolution_court_pleadings',
          scope: 'Alpha isolated CFA quote',
          feeBasis: 'Conditional fee agreement (CFA)',
          feeAmountExVat: 9000,
          feeArrangementCapCategoryKey: 'cfa_general_civil',
          feeArrangementPercent: 40,
          feeArrangementCapBaseKey: 'base_costs',
        }),
      { tenantId: tenantAlpha, mfaVerified: true },
    );
    const alphaQuoteId =
      !isActionDenied(alphaAllowed) && alphaAllowed.quote
        ? alphaAllowed.quote.id
        : '';
    expect(alphaQuoteId).toBeTruthy();

    const alphaOnlyQuoteRes = await runAsActionActor(
      'P-000004',
      () =>
        saveQuoteAction({
          clientType: 'existing',
          linkedOrganisationId: alphaOrg.id,
          practiceAreaId: 'work_type.dispute_resolution',
          workTypeSubcategoryId: 'work_type.dispute_resolution_court_pleadings',
          scope: 'Alpha second quote ID absent from Bravo',
          feeBasis: 'Conditional fee agreement (CFA)',
          feeAmountExVat: 4500,
          feeArrangementCapCategoryKey: 'cfa_general_civil',
          feeArrangementPercent: 35,
          feeArrangementCapBaseKey: 'base_costs',
        }),
      { tenantId: tenantAlpha, mfaVerified: true },
    );
    const alphaOnlyQuoteId =
      !isActionDenied(alphaOnlyQuoteRes) && alphaOnlyQuoteRes.quote
        ? alphaOnlyQuoteRes.quote.id
        : '';
    expect(alphaOnlyQuoteId).toBeTruthy();

    // Tenant Bravo host enforcement accepts 75% (R486 override 85% > firm 50%)
    setActiveTenantConfigForTesting(bravoRaw);
    const bravoOrg = bravoSeed.organisations[0]!;
    const bravoAllowed = await runAsActionActor(
      'P-000004',
      () =>
        saveQuoteAction({
          clientType: 'existing',
          linkedOrganisationId: bravoOrg.id,
          practiceAreaId: 'work_type.dispute_resolution',
          workTypeSubcategoryId: 'work_type.dispute_resolution_court_pleadings',
          scope: 'Bravo isolated R486 CFA quote',
          feeBasis: 'Conditional fee agreement (CFA)',
          feeAmountExVat: 11000,
          feeArrangementCapCategoryKey: 'cfa_general_civil',
          feeArrangementPercent: 75,
          feeArrangementCapBaseKey: 'base_costs',
        }),
      { tenantId: tenantBravo, mfaVerified: true },
    );
    const bravoQuoteId =
      !isActionDenied(bravoAllowed) && bravoAllowed.quote
        ? bravoAllowed.quote.id
        : '';
    expect(bravoQuoteId).toBeTruthy();

    // Fresh pool manager readbacks confirm independent per-tenant configs, quotes & audits
    const freshPoolMgr = new TenantPostgresPoolManager();
    openPoolManagers.push(freshPoolMgr);
    const freshCatRepo = new TenantCatalogueRepository({ poolManager: freshPoolMgr });
    const freshQuoteRepo = new TenantIntakeQuoteRepository({ poolManager: freshPoolMgr });
    const freshMatterRepo = new TenantMatterRepository({ poolManager: freshPoolMgr });
    const freshAuditRepo = new TenantAuditRepository({ poolManager: freshPoolMgr });

    const [alphaWtRead, bravoWtRead, alphaQRead, bravoQRead] = await Promise.all([
      freshCatRepo.getWorkTypeConfigs<WorkTypesConfiguration>(ctxAlpha),
      freshCatRepo.getWorkTypeConfigs<WorkTypesConfiguration>(ctxBravo),
      freshQuoteRepo.getQuoteById<Quote>(ctxAlpha, alphaQuoteId),
      freshQuoteRepo.getQuoteById<Quote>(ctxBravo, bravoQuoteId),
    ]);

    expect(
      alphaWtRead?.items.find(
        (i) => i.workTypeId === 'work_type.dispute_resolution_court_pleadings',
      )?.workTypeCapOverrides,
    ).toBeUndefined();
    expect(
      bravoWtRead?.items.find(
        (i) => i.workTypeId === 'work_type.dispute_resolution_court_pleadings',
      )?.workTypeCapOverrides?.[0]?.maxPercent,
    ).toBe(85);
    expect(alphaQRead?.feeArrangementPercent).toBe(40);
    expect(alphaQRead?.feeArrangementAppliedCapPercent).toBe(40);
    expect(bravoQRead?.feeArrangementPercent).toBe(75);
    expect(bravoQRead?.feeArrangementAppliedCapPercent).toBe(85);

    // Tampered record ID cross-tenant check fails closed
    expect(await freshQuoteRepo.getQuoteById(ctxBravo, alphaOnlyQuoteId)).toBeNull();
    const bravoAuditsForAlphaQuote = await freshAuditRepo.listAuditEntriesForRecord(
      ctxBravo,
      'quote',
      alphaOnlyQuoteId,
    );
    expect(bravoAuditsForAlphaQuote).toHaveLength(0);

    // Tampered sign-off or revision cross-tenant fails closed
    const bravoTamperRevise = await runAsActionActor(
      'P-000004',
      () =>
        reviseQuoteAction(alphaOnlyQuoteId, {
          feeBasis: 'Conditional fee agreement (CFA)',
          feeAmountExVat: 1000,
          scope: 'Tamper',
          feeArrangementCapCategoryKey: 'cfa_general_civil',
          feeArrangementPercent: 10,
          feeArrangementCapBaseKey: 'base_costs',
        }),
      { tenantId: tenantBravo, mfaVerified: true },
    );
    if (!isActionDenied(bravoTamperRevise)) {
      expect(bravoTamperRevise.code).toBe('FORBIDDEN');
    }

    // Forged TenantContext (tenantId swapped) rejects at PostgreSQL layer
    const forgedCtx = Object.freeze({
      ...ctxAlpha,
      tenantId: tenantBravo,
    }) as TenantContext;
    await expect(
      freshMatterRepo.listAllMattersUnfiltered<Matter>(forgedCtx),
    ).rejects.toThrow();
  });
});
