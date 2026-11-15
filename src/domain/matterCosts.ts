/**
 * Domain logic for Step 2 "Matter Costs" in the Matter Opening Process,
 * including the dual-mode Hourly Rates Table (Application Rates Table + PMS Lookup)
 * and Multi-Client Tenant Customisation Configuration.
 */
import { resolveLabel } from './lists';
import type {
  ChoiceValue,
  CustomGradeRateRow,
  DisbursementPresetItem,
  Matter,
  MatterCostsConfig,
  MatterCostsSnapshot,
  MatterCostWorkBasis,
  MatterDisbursementEntry,
  Quote,
  RateCardEntry,
  RateTableSourceMode,
} from './types';
import type { PmsFeeEarner } from '@/pms/types';
import {
  calculateVatMinorUnits,
  minorUnitsToPounds,
  percentToBasisPoints,
  poundsToMinorUnits,
  sumMinorUnits,
  type TenantConfiguration,
} from '@platform/core-api';

export const WORK_BASIS_OPTIONS: {
  key: MatterCostWorkBasis;
  label: string;
  shortLabel: string;
  description: string;
  showsHourlyRates: boolean;
}[] = [
  {
    key: 'hourly_rates',
    label: 'Hourly rates',
    shortLabel: 'Hourly rates',
    description: 'Charged by time spent using Partner, Associate, and Trainee hourly rates',
    showsHourlyRates: true,
  },
  {
    key: 'fixed_fee',
    label: 'Fixed fee',
    shortLabel: 'Fixed fee',
    description: 'Agreed fixed fee for the defined scope of work',
    showsHourlyRates: false,
  },
  {
    key: 'capped',
    label: 'Capped fee',
    shortLabel: 'Capped',
    description: 'Charged at hourly rates up to an agreed maximum fee cap',
    showsHourlyRates: true,
  },
];

export interface MatterCostsProfileDescriptor {
  clientProfileCode?: string;
  displayName?: string;
  primaryDomain?: string;
}

export function createDefaultMatterCostsConfig(
  values: ChoiceValue[] = [],
  nowIsoOrProfile?: string | MatterCostsProfileDescriptor,
  profileArg?: MatterCostsProfileDescriptor,
): MatterCostsConfig {
  const nowIso =
    typeof nowIsoOrProfile === 'string'
      ? nowIsoOrProfile
      : new Date().toISOString();
  const profile =
    typeof nowIsoOrProfile === 'object' && nowIsoOrProfile !== null
      ? nowIsoOrProfile
      : profileArg;
  const practiceAreas = values.filter(
    (v) => v.listKey === 'work_type' && !v.parentId && v.active,
  );

  const findPaId = (keyword: string): string | null => {
    const kw = keyword.toLowerCase();
    return (
      practiceAreas.find((p) => p.label.toLowerCase().includes(kw))?.id ?? null
    );
  };

  const corpId = findPaId('corporate') ?? 'work_type.corporate_and_commercial';
  const propId = findPaId('real estate') ?? findPaId('property') ?? 'work_type.real_estate_and_property';
  const empId = findPaId('employment') ?? 'work_type.employment_and_hr';
  const litId = findPaId('dispute') ?? findPaId('litigation') ?? 'work_type.dispute_resolution_and_litigation';
  const pcId = findPaId('private client') ?? findPaId('wills') ?? 'work_type.private_client_wills_and_probate';

  const rateCards: RateCardEntry[] = [
    {
      id: 'RC-DEFAULT',
      name: 'Firm Standard Rate Card',
      practiceAreaId: null,
      pmsDepartmentCode: 'Standard',
      partnerRateGbp: 350,
      associateRateGbp: 250,
      traineeRateGbp: 145,
      pmsPartnerRateGbp: 365,
      pmsAssociateRateGbp: 260,
      pmsTraineeRateGbp: 150,
      pmsLastSyncedAt: nowIso,
      customGrades: [],
      active: true,
    },
    {
      id: 'RC-CORP',
      name: 'Corporate & Commercial Rate Card',
      practiceAreaId: corpId,
      pmsDepartmentCode: 'Corporate & Commercial',
      partnerRateGbp: 395,
      associateRateGbp: 285,
      traineeRateGbp: 160,
      pmsPartnerRateGbp: 400,
      pmsAssociateRateGbp: 290,
      pmsTraineeRateGbp: 165,
      pmsLastSyncedAt: nowIso,
      customGrades: [],
      active: true,
    },
    {
      id: 'RC-PROP',
      name: 'Real Estate & Property Rate Card',
      practiceAreaId: propId,
      pmsDepartmentCode: 'Real Estate & Property',
      partnerRateGbp: 360,
      associateRateGbp: 255,
      traineeRateGbp: 145,
      pmsPartnerRateGbp: 370,
      pmsAssociateRateGbp: 265,
      pmsTraineeRateGbp: 150,
      pmsLastSyncedAt: nowIso,
      customGrades: [],
      active: true,
    },
    {
      id: 'RC-EMP',
      name: 'Employment & HR Rate Card',
      practiceAreaId: empId,
      pmsDepartmentCode: 'Employment & HR',
      partnerRateGbp: 365,
      associateRateGbp: 260,
      traineeRateGbp: 150,
      pmsPartnerRateGbp: 375,
      pmsAssociateRateGbp: 265,
      pmsTraineeRateGbp: 150,
      pmsLastSyncedAt: nowIso,
      customGrades: [],
      active: true,
    },
    {
      id: 'RC-LIT',
      name: 'Dispute Resolution & Litigation Rate Card',
      practiceAreaId: litId,
      pmsDepartmentCode: 'Dispute Resolution',
      partnerRateGbp: 375,
      associateRateGbp: 265,
      traineeRateGbp: 150,
      pmsPartnerRateGbp: 385,
      pmsAssociateRateGbp: 275,
      pmsTraineeRateGbp: 155,
      pmsLastSyncedAt: nowIso,
      customGrades: [],
      active: true,
    },
    {
      id: 'RC-PC',
      name: 'Private Client, Wills & Probate Rate Card',
      practiceAreaId: pcId,
      pmsDepartmentCode: 'Private Client',
      partnerRateGbp: 325,
      associateRateGbp: 230,
      traineeRateGbp: 135,
      pmsPartnerRateGbp: 335,
      pmsAssociateRateGbp: 240,
      pmsTraineeRateGbp: 140,
      pmsLastSyncedAt: nowIso,
      customGrades: [],
      active: true,
    },
  ];

  const disbursementPresets: DisbursementPresetItem[] = [
    {
      id: 'DISB-COUNSEL',
      description: "Counsel's advice / hearing fee",
      defaultAmountGbp: 1500,
      practiceAreaId: null,
    },
    {
      id: 'DISB-COURT',
      description: 'Court / Tribunal filing fee',
      defaultAmountGbp: 255,
      practiceAreaId: null,
    },
    {
      id: 'DISB-LR',
      description: 'HM Land Registry & property search pack',
      defaultAmountGbp: 350,
      practiceAreaId: propId,
    },
    {
      id: 'DISB-CH',
      description: 'Companies House filing & search fees',
      defaultAmountGbp: 100,
      practiceAreaId: corpId,
    },
    {
      id: 'DISB-EXPERT',
      description: 'Independent expert / medical report fee',
      defaultAmountGbp: 750,
      practiceAreaId: null,
    },
  ];

  const profileCode = profile?.clientProfileCode?.trim() || 'DEFAULT';
  const profileName =
    profile?.displayName && profile?.primaryDomain
      ? `${profile.displayName} — Client Configuration (${profile.primaryDomain})`
      : profile?.displayName || 'Standard Matter Costs Configuration';

  return {
    clientProfileCode: profileCode,
    clientProfileName: profileName,
    sectionTitle: 'Matter Costs',
    rateSourceMode: 'pms_when_linked',
    pmsLinkActive: false,
    allowMatterRateOverrides: true,
    partnerSignOffThresholdGbp: 25000,
    vatRatePercent: 20,
    defaultPaymentOnAccount: '',
    rateCards,
    disbursementPresets,
    updatedAt: nowIso,
    updatedById: 'system',
  };
}

/**
 * Pulls/syncs Partner, Associate, and Trainee hourly rates from the PMS fee earners table
 * into the MatterCostsConfig rate cards.
 */
export function syncRateCardsWithPmsFeeEarners(
  config: MatterCostsConfig,
  pmsFeeEarners: PmsFeeEarner[],
  values: ChoiceValue[],
  nowIso: string = new Date().toISOString(),
): MatterCostsConfig {
  const activeFe = pmsFeeEarners.filter((fe) => fe.active !== 'No' && fe.standard_hourly_rate > 0);

  const computeAverage = (items: PmsFeeEarner[], fallback: number): number => {
    if (items.length === 0) return fallback;
    const sum = items.reduce((acc, item) => acc + item.standard_hourly_rate, 0);
    return Math.round(sum / items.length / 5) * 5;
  };

  const isPartnerGrade = (grade: string) => /partner|director|member/i.test(grade);
  const isTraineeGrade = (grade: string) => /trainee|paralegal|apprentice|assistant/i.test(grade);
  const isAssociateGrade = (grade: string) =>
    !isPartnerGrade(grade) && !isTraineeGrade(grade);

  const allPartners = activeFe.filter((f) => isPartnerGrade(f.grade));
  const allAssociates = activeFe.filter((f) => isAssociateGrade(f.grade));
  const allTrainees = activeFe.filter((f) => isTraineeGrade(f.grade));

  const firmPmsPartner = computeAverage(allPartners, 365);
  const firmPmsAssociate = computeAverage(allAssociates, 260);
  const firmPmsTrainee = computeAverage(allTrainees, 150);

  const updatedCards: RateCardEntry[] = config.rateCards.map((card) => {
    if (!card.practiceAreaId) {
      return {
        ...card,
        pmsPartnerRateGbp: firmPmsPartner,
        pmsAssociateRateGbp: firmPmsAssociate,
        pmsTraineeRateGbp: firmPmsTrainee,
        pmsLastSyncedAt: nowIso,
      };
    }

    const paLabel = resolveLabel(values, card.practiceAreaId).toLowerCase();
    const deptKey = (card.pmsDepartmentCode || paLabel).toLowerCase();
    const firstWord = deptKey.split(/[\s&,/]+/)[0] || '';

    const deptFe = activeFe.filter((fe) => {
      const d = fe.department.toLowerCase();
      return d.includes(firstWord) || firstWord.includes(d);
    });

    const deptPartners = deptFe.filter((f) => isPartnerGrade(f.grade));
    const deptAssociates = deptFe.filter((f) => isAssociateGrade(f.grade));
    const deptTrainees = deptFe.filter((f) => isTraineeGrade(f.grade));

    return {
      ...card,
      pmsPartnerRateGbp: computeAverage(
        deptPartners,
        card.pmsPartnerRateGbp ?? card.partnerRateGbp,
      ),
      pmsAssociateRateGbp: computeAverage(
        deptAssociates,
        card.pmsAssociateRateGbp ?? card.associateRateGbp,
      ),
      pmsTraineeRateGbp: computeAverage(
        deptTrainees,
        card.pmsTraineeRateGbp ?? card.traineeRateGbp,
      ),
      pmsLastSyncedAt: nowIso,
    };
  });

  return {
    ...config,
    rateCards: updatedCards,
    updatedAt: nowIso,
  };
}

/**
 * Looks up the hourly rates for Partner, Associate, and Trainee for a given department / rate card,
 * using either the Application Rates Table or the PMS Rate Table depending on configuration & preference.
 */
export function lookupRatesForMatter(params: {
  config: MatterCostsConfig;
  practiceAreaId?: string | null;
  rateCardId?: string | null;
  preferredSource?: 'auto' | 'app_table' | 'pms';
}): {
  rateCard: RateCardEntry;
  activeSource: 'app_table' | 'pms';
  partnerRateGbp: number;
  associateRateGbp: number;
  traineeRateGbp: number;
  customGrades: CustomGradeRateRow[];
} {
  const { config, practiceAreaId, rateCardId, preferredSource = 'auto' } = params;
  const activeCards = config.rateCards.filter((c) => c.active);
  const defaultCard =
    activeCards.find((c) => !c.practiceAreaId) ??
    activeCards[0] ??
    createDefaultMatterCostsConfig().rateCards[0];

  const matchedCard =
    (rateCardId ? activeCards.find((c) => c.id === rateCardId) : undefined) ??
    (practiceAreaId
      ? activeCards.find((c) => c.practiceAreaId === practiceAreaId)
      : undefined) ??
    defaultCard;

  let usePms = false;
  if (preferredSource === 'pms') {
    usePms = true;
  } else if (preferredSource === 'app_table') {
    usePms = false;
  } else {
    if (config.rateSourceMode === 'pms_only') {
      usePms = true;
    } else if (config.rateSourceMode === 'pms_when_linked' && config.pmsLinkActive) {
      usePms = true;
    }
  }

  const partnerRateGbp = usePms
    ? (matchedCard.pmsPartnerRateGbp ?? matchedCard.partnerRateGbp)
    : matchedCard.partnerRateGbp;
  const associateRateGbp = usePms
    ? (matchedCard.pmsAssociateRateGbp ?? matchedCard.associateRateGbp)
    : matchedCard.associateRateGbp;
  const traineeRateGbp = usePms
    ? (matchedCard.pmsTraineeRateGbp ?? matchedCard.traineeRateGbp)
    : matchedCard.traineeRateGbp;

  return {
    rateCard: matchedCard,
    activeSource: usePms ? 'pms' : 'app_table',
    partnerRateGbp,
    associateRateGbp,
    traineeRateGbp,
    customGrades: matchedCard.customGrades ? [...matchedCard.customGrades] : [],
  };
}

function mapConfigRateSourceMode(
  mode: TenantConfiguration['matterCosts']['rateSourceMode'] | undefined,
): RateTableSourceMode {
  if (mode === 'application_table') return 'app_table';
  if (mode === 'pms_when_linked') return 'pms_when_linked';
  return 'pms_when_linked';
}

function resolvePracticeAreaIdFromKey(
  practiceAreaKey: string | null | undefined,
  values: ChoiceValue[],
): string | null {
  if (!practiceAreaKey) return null;
  const match = values.find(
    (v) =>
      v.listKey === 'work_type' &&
      (v.id === practiceAreaKey || v.systemKey === practiceAreaKey),
  );
  return match?.id ?? practiceAreaKey;
}

/**
 * Resolves the effective MatterCostsConfig by combining schema-validated
 * tenant configuration defaults (`tenantConfig.matterCosts`) with an optional
 * runtime module configuration override (`dbOverride`) stored per tenant.
 */
export function resolveEffectiveMatterCostsConfig(
  tenantConfig?: Pick<TenantConfiguration, 'matterCosts'> | null,
  dbOverride?: MatterCostsConfig | null,
  options?: {
    values?: ChoiceValue[];
    clientProfileCode?: string;
    displayName?: string;
    primaryDomain?: string;
  },
): MatterCostsConfig {
  const cfgRateSourceMode = tenantConfig?.matterCosts?.rateSourceMode;
  const cfgAllowMatterRateOverrides = tenantConfig?.matterCosts?.allowMatterRateOverrides;
  const cfgPartnerSignOffThresholdGbp =
    tenantConfig?.matterCosts?.partnerSignOffThresholdGbp;
  const cfgVatRatePercent = tenantConfig?.matterCosts?.vatRatePercent;
  const cfgRateCards = tenantConfig?.matterCosts?.rateCards;
  const cfgDisbursementPresets = tenantConfig?.matterCosts?.disbursementPresets;

  const values = options?.values ?? [];
  const resolvedRateSourceMode = mapConfigRateSourceMode(cfgRateSourceMode);
  const resolvedAllowOverrides =
    typeof cfgAllowMatterRateOverrides === 'boolean' ? cfgAllowMatterRateOverrides : true;
  const resolvedThreshold =
    typeof cfgPartnerSignOffThresholdGbp === 'number' &&
    Number.isFinite(cfgPartnerSignOffThresholdGbp) &&
    cfgPartnerSignOffThresholdGbp >= 0
      ? cfgPartnerSignOffThresholdGbp
      : 25000;
  const resolvedVatRate =
    typeof cfgVatRatePercent === 'number' &&
    Number.isFinite(cfgVatRatePercent) &&
    cfgVatRatePercent >= 0 &&
    cfgVatRatePercent <= 100
      ? cfgVatRatePercent
      : 20;

  const mappedCfgRateCards: RateCardEntry[] = Array.isArray(cfgRateCards)
    ? cfgRateCards.map((rc) => ({
        id: rc.id,
        name: rc.name,
        practiceAreaId: resolvePracticeAreaIdFromKey(rc.practiceAreaKey, values),
        pmsDepartmentCode: rc.pmsDepartmentCode ?? null,
        partnerRateGbp: Number(rc.partnerRateGbp) || 0,
        associateRateGbp: Number(rc.associateRateGbp) || 0,
        traineeRateGbp: Number(rc.traineeRateGbp) || 0,
        customGrades: Array.isArray(rc.customGrades) ? rc.customGrades : [],
        active: Boolean(rc.active),
      }))
    : [];

  const mappedCfgPresets: DisbursementPresetItem[] = Array.isArray(cfgDisbursementPresets)
    ? cfgDisbursementPresets.map((p) => ({
        id: p.id,
        description: p.description,
        defaultAmountGbp: Number(p.defaultAmountGbp) || 0,
        vatApplicable: Boolean(p.vatApplicable),
        practiceAreaId: resolvePracticeAreaIdFromKey(p.practiceAreaKey, values),
      }))
    : [];

  if (dbOverride) {
    return {
      ...dbOverride,
      rateSourceMode: dbOverride.rateSourceMode ?? resolvedRateSourceMode,
      allowMatterRateOverrides:
        typeof dbOverride.allowMatterRateOverrides === 'boolean'
          ? dbOverride.allowMatterRateOverrides
          : resolvedAllowOverrides,
      partnerSignOffThresholdGbp:
        typeof dbOverride.partnerSignOffThresholdGbp === 'number' &&
        Number.isFinite(dbOverride.partnerSignOffThresholdGbp) &&
        dbOverride.partnerSignOffThresholdGbp >= 0
          ? dbOverride.partnerSignOffThresholdGbp
          : resolvedThreshold,
      vatRatePercent:
        typeof dbOverride.vatRatePercent === 'number' &&
        Number.isFinite(dbOverride.vatRatePercent) &&
        dbOverride.vatRatePercent >= 0 &&
        dbOverride.vatRatePercent <= 100
          ? dbOverride.vatRatePercent
          : resolvedVatRate,
      rateCards: Array.isArray(dbOverride.rateCards)
        ? dbOverride.rateCards
        : mappedCfgRateCards,
      disbursementPresets: Array.isArray(dbOverride.disbursementPresets)
        ? dbOverride.disbursementPresets
        : mappedCfgPresets,
    };
  }

  const defaults = createDefaultMatterCostsConfig(values, {
    clientProfileCode: options?.clientProfileCode,
    displayName: options?.displayName,
    primaryDomain: options?.primaryDomain,
  });

  return {
    ...defaults,
    rateSourceMode: resolvedRateSourceMode,
    allowMatterRateOverrides: resolvedAllowOverrides,
    partnerSignOffThresholdGbp: resolvedThreshold,
    vatRatePercent: resolvedVatRate,
    rateCards: mappedCfgRateCards.length > 0 ? mappedCfgRateCards : defaults.rateCards,
    disbursementPresets:
      mappedCfgPresets.length > 0 ? mappedCfgPresets : defaults.disbursementPresets,
  };
}

/**
 * Returns a copy of `tenantConfig` whose `matterCosts` settings reflect the
 * effective runtime MatterCostsConfig (used when invoking governance hooks).
 */
export function applyEffectiveMatterCostsToTenantConfig(
  tenantConfig: TenantConfiguration,
  costsConfig: MatterCostsConfig,
): TenantConfiguration {
  return {
    ...tenantConfig,
    matterCosts: {
      ...tenantConfig.matterCosts,
      rateSourceMode:
        costsConfig.rateSourceMode === 'app_table'
          ? 'application_table'
          : 'pms_when_linked',
      allowMatterRateOverrides: costsConfig.allowMatterRateOverrides,
      partnerSignOffThresholdGbp: costsConfig.partnerSignOffThresholdGbp,
      vatRatePercent: costsConfig.vatRatePercent,
    },
  };
}

function toNonNegativeMinorUnitsSafe(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (num < 1e-6) return 0;
  const raw = String(num);
  if (/[eE]/.test(raw)) {
    return poundsToMinorUnits(num.toFixed(4));
  }
  return poundsToMinorUnits(raw);
}

export interface MatterDisbursementBreakdownLine {
  id: string;
  description: string;
  amountGbp: number;
  vatApplicable: boolean;
  vatAmountGbp: number;
  vatOverridden: boolean;
  totalIncVatGbp: number;
}

export interface MatterDisbursementsBreakdown {
  lines: MatterDisbursementBreakdownLine[];
  netGbp: number;
  vatGbp: number;
  totalIncVatGbp: number;
  vatRatePercent: number;
}

export function calculateDisbursementsTotal(
  disbursements: MatterDisbursementEntry[],
): number {
  const minorAmounts = disbursements.map((item) => toNonNegativeMinorUnitsSafe(item.amountGbp));
  return minorUnitsToPounds(sumMinorUnits(minorAmounts));
}

export function calculateMatterDisbursementsBreakdown(
  disbursements: MatterDisbursementEntry[],
  vatRatePercent = 20,
): MatterDisbursementsBreakdown {
  const safeVatRate =
    typeof vatRatePercent === 'number' && Number.isFinite(vatRatePercent) && vatRatePercent >= 0
      ? vatRatePercent
      : 20;
  const vatBasisPoints = percentToBasisPoints(safeVatRate);

  const netAmountsMinor: number[] = [];
  const vatAmountsMinor: number[] = [];
  const lines: MatterDisbursementBreakdownLine[] = disbursements.map((item, idx) => {
    const netMinor = toNonNegativeMinorUnitsSafe(item.amountGbp);
    const vatApplicable = Boolean(item.vatApplicable);
    const vatOverridden = Boolean(item.vatOverridden);
    const vatMinor =
      vatOverridden &&
      item.vatAmountGbp !== undefined &&
      item.vatAmountGbp !== null &&
      Number.isFinite(Number(item.vatAmountGbp))
        ? toNonNegativeMinorUnitsSafe(item.vatAmountGbp)
        : vatApplicable
          ? calculateVatMinorUnits(netMinor, vatBasisPoints)
          : 0;
    netAmountsMinor.push(netMinor);
    vatAmountsMinor.push(vatMinor);
    return {
      id: item.id || `disb-${idx}`,
      description: String(item.description ?? ''),
      amountGbp: minorUnitsToPounds(netMinor),
      vatApplicable,
      vatAmountGbp: minorUnitsToPounds(vatMinor),
      vatOverridden,
      totalIncVatGbp: minorUnitsToPounds(sumMinorUnits([netMinor, vatMinor])),
    };
  });

  const netMinorTotal = sumMinorUnits(netAmountsMinor);
  const vatMinorTotal = sumMinorUnits(vatAmountsMinor);
  const incVatMinorTotal = sumMinorUnits([netMinorTotal, vatMinorTotal]);

  return {
    lines,
    netGbp: minorUnitsToPounds(netMinorTotal),
    vatGbp: minorUnitsToPounds(vatMinorTotal),
    totalIncVatGbp: minorUnitsToPounds(incVatMinorTotal),
    vatRatePercent: safeVatRate,
  };
}

export function calculateMatterSnapshotTotals(params: {
  totalEstimateGbp: number | null;
  disbursements: MatterDisbursementEntry[];
  vatRatePercent: number;
}): {
  disbursementsTotalGbp: number;
  disbursementsVatGbp: number;
  disbursementsTotalIncVatGbp: number;
  estimatedFeeVatGbp: number | null;
  totalIncVatGbp: number | null;
} {
  const safeVatRate =
    typeof params.vatRatePercent === 'number' &&
    Number.isFinite(params.vatRatePercent) &&
    params.vatRatePercent >= 0
      ? params.vatRatePercent
      : 20;
  const vatBasisPoints = percentToBasisPoints(safeVatRate);
  const disbBreakdown = calculateMatterDisbursementsBreakdown(params.disbursements, safeVatRate);

  if (
    params.totalEstimateGbp !== null &&
    params.totalEstimateGbp !== undefined &&
    Number.isFinite(params.totalEstimateGbp)
  ) {
    const feeNetMinor = toNonNegativeMinorUnitsSafe(params.totalEstimateGbp);
    const feeVatMinor = calculateVatMinorUnits(feeNetMinor, vatBasisPoints);
    const disbNetMinor = toNonNegativeMinorUnitsSafe(disbBreakdown.netGbp);
    const disbVatMinor = toNonNegativeMinorUnitsSafe(disbBreakdown.vatGbp);
    return {
      disbursementsTotalGbp: disbBreakdown.netGbp,
      disbursementsVatGbp: disbBreakdown.vatGbp,
      disbursementsTotalIncVatGbp: disbBreakdown.totalIncVatGbp,
      estimatedFeeVatGbp: minorUnitsToPounds(feeVatMinor),
      totalIncVatGbp: minorUnitsToPounds(
        sumMinorUnits([feeNetMinor, feeVatMinor, disbNetMinor, disbVatMinor]),
      ),
    };
  }

  return {
    disbursementsTotalGbp: disbBreakdown.netGbp,
    disbursementsVatGbp: disbBreakdown.vatGbp,
    disbursementsTotalIncVatGbp: disbBreakdown.totalIncVatGbp,
    estimatedFeeVatGbp: null,
    totalIncVatGbp: params.disbursements.length > 0 ? disbBreakdown.totalIncVatGbp : null,
  };
}

export function mapWorkBasisToBillingBasisId(
  workBasis: MatterCostWorkBasis,
  values: ChoiceValue[],
): string {
  const basisOptions = values.filter((v) => v.listKey === 'billing_basis' && v.active);
  if (workBasis === 'fixed_fee') {
    return (
      basisOptions.find((v) => v.label.toLowerCase().includes('fixed'))?.id ?? ''
    );
  }
  if (workBasis === 'capped') {
    return (
      basisOptions.find((v) => v.label.toLowerCase().includes('cap'))?.id ??
      basisOptions.find((v) => v.label.toLowerCase().includes('hourly'))?.id ??
      ''
    );
  }
  return (
    basisOptions.find((v) => v.label.toLowerCase().includes('hourly'))?.id ?? ''
  );
}

export function mapBillingBasisLabelToWorkBasis(
  label: string,
  hasAgreedCap?: boolean,
): MatterCostWorkBasis {
  const lower = (label || '').toLowerCase();
  if (lower.includes('fixed')) return 'fixed_fee';
  if (lower.includes('cap') || hasAgreedCap) return 'capped';
  return 'hourly_rates';
}

export function resolveMatterCostsSnapshot(params: {
  existing?: Matter | null;
  initialQuote?: Quote | null;
  practiceAreaId?: string | null;
  config: MatterCostsConfig;
  values: ChoiceValue[];
}): MatterCostsSnapshot {
  const { existing, initialQuote, practiceAreaId, config, values } = params;
  const saved = existing?.fieldValues?.['matterCosts'] as
    | Partial<MatterCostsSnapshot>
    | undefined;

  const targetPaId = practiceAreaId ?? existing?.practiceAreaId ?? initialQuote?.practiceAreaId ?? null;
  const lookedUp = lookupRatesForMatter({
    config,
    practiceAreaId: targetPaId,
    rateCardId: saved?.rateCardId ?? null,
  });

  if (saved && typeof saved === 'object' && saved.workBasis) {
    const frozenVatRatePercent =
      typeof saved.vatRatePercent === 'number' && Number.isFinite(saved.vatRatePercent)
        ? saved.vatRatePercent
        : typeof config.vatRatePercent === 'number' && Number.isFinite(config.vatRatePercent)
          ? config.vatRatePercent
          : 20;
    const disbursements: MatterDisbursementEntry[] = Array.isArray(saved.disbursements)
      ? saved.disbursements.map((d, i) => ({
          id: d.id || `disb-${i}`,
          description: String(d.description ?? ''),
          amountGbp: Number(d.amountGbp) || 0,
          ...(d.vatApplicable !== undefined ? { vatApplicable: Boolean(d.vatApplicable) } : {}),
          ...(d.vatOverridden ? { vatOverridden: true } : {}),
          ...(d.vatAmountGbp !== undefined && d.vatAmountGbp !== null
            ? { vatAmountGbp: Number(d.vatAmountGbp) || 0 }
            : {}),
        }))
      : [];
    const totalEstimateGbp =
      saved.totalEstimateGbp !== undefined
        ? saved.totalEstimateGbp
        : (existing?.feeEstimateGbp ?? null);
    const computedTotals = calculateMatterSnapshotTotals({
      totalEstimateGbp,
      disbursements,
      vatRatePercent: frozenVatRatePercent,
    });
    return {
      workBasis: saved.workBasis,
      rateSource: saved.rateSource ?? lookedUp.activeSource,
      rateCardId: saved.rateCardId || lookedUp.rateCard.id,
      rateCardName: saved.rateCardName || lookedUp.rateCard.name,
      partnerRateGbp:
        saved.partnerRateGbp !== undefined ? saved.partnerRateGbp : lookedUp.partnerRateGbp,
      associateRateGbp:
        saved.associateRateGbp !== undefined ? saved.associateRateGbp : lookedUp.associateRateGbp,
      traineeRateGbp:
        saved.traineeRateGbp !== undefined ? saved.traineeRateGbp : lookedUp.traineeRateGbp,
      customGrades: saved.customGrades ?? lookedUp.customGrades,
      totalEstimateGbp,
      agreedCapGbp:
        saved.agreedCapGbp !== undefined
          ? saved.agreedCapGbp
          : (existing?.agreedFeeCapGbp ?? null),
      vatRatePercent: frozenVatRatePercent,
      disbursements,
      disbursementsTotalGbp: computedTotals.disbursementsTotalGbp,
      disbursementsVatGbp:
        typeof saved.disbursementsVatGbp === 'number' && Number.isFinite(saved.disbursementsVatGbp)
          ? saved.disbursementsVatGbp
          : computedTotals.disbursementsVatGbp,
      disbursementsTotalIncVatGbp:
        typeof saved.disbursementsTotalIncVatGbp === 'number' &&
        Number.isFinite(saved.disbursementsTotalIncVatGbp)
          ? saved.disbursementsTotalIncVatGbp
          : computedTotals.disbursementsTotalIncVatGbp,
      estimatedFeeVatGbp:
        saved.estimatedFeeVatGbp !== undefined
          ? saved.estimatedFeeVatGbp
          : computedTotals.estimatedFeeVatGbp,
      totalIncVatGbp:
        saved.totalIncVatGbp !== undefined ? saved.totalIncVatGbp : computedTotals.totalIncVatGbp,
      paymentOnAccountRequired:
        saved.paymentOnAccountRequired ??
        (existing?.retainerMoniesOnAccountGbp && existing.retainerMoniesOnAccountGbp > 0
          ? 'Yes'
          : ''),
      paymentOnAccountAmountGbp:
        saved.paymentOnAccountAmountGbp !== undefined
          ? saved.paymentOnAccountAmountGbp
          : (existing?.retainerMoniesOnAccountGbp ?? null),
      notes: saved.notes ?? '',
      ...(saved.updatedAt ? { updatedAt: saved.updatedAt } : {}),
      ...((saved.capturedAt ?? saved.updatedAt)
        ? { capturedAt: saved.capturedAt ?? saved.updatedAt }
        : {}),
    };
  }

  // Fallback derivation from initialQuote or existing Matter fields
  let workBasis: MatterCostWorkBasis = 'hourly_rates';
  if (initialQuote) {
    if (initialQuote.feeBasis === 'Fixed fee') workBasis = 'fixed_fee';
    else if (initialQuote.feeBasis === 'Capped fee') workBasis = 'capped';
    else workBasis = 'hourly_rates';
  } else if (existing?.billingBasisId) {
    const bbLabel = resolveLabel(values, existing.billingBasisId);
    workBasis = mapBillingBasisLabelToWorkBasis(
      bbLabel,
      Boolean(existing.agreedFeeCapGbp && existing.agreedFeeCapGbp > 0),
    );
  }

  const initialVatRatePercent =
    initialQuote &&
    typeof initialQuote.vatRatePercent === 'number' &&
    Number.isFinite(initialQuote.vatRatePercent)
      ? initialQuote.vatRatePercent
      : typeof config.vatRatePercent === 'number' && Number.isFinite(config.vatRatePercent)
        ? config.vatRatePercent
        : 20;

  const disbursements: MatterDisbursementEntry[] = initialQuote?.disbursements
    ? initialQuote.disbursements.map((d) => ({
        id: d.id,
        description: d.description,
        amountGbp: d.amountExVat,
        vatApplicable: d.vatApplicable,
        ...(d.vatOverridden ? { vatOverridden: true } : {}),
        ...(d.vatAmount !== undefined && d.vatAmount !== null
          ? { vatAmountGbp: d.vatAmount }
          : {}),
      }))
    : [];

  const totalEstimateGbp =
    existing?.feeEstimateGbp ??
    (initialQuote ? initialQuote.feeAmountExVat : null);

  const agreedCapGbp =
    existing?.agreedFeeCapGbp ??
    (initialQuote && initialQuote.feeBasis === 'Capped fee'
      ? initialQuote.feeAmountExVat
      : null);

  const poaAmt = existing?.retainerMoniesOnAccountGbp ?? null;
  const poaReq: 'Yes' | 'No' | '' =
    poaAmt != null && poaAmt > 0 ? 'Yes' : config.defaultPaymentOnAccount;
  const computedTotals = calculateMatterSnapshotTotals({
    totalEstimateGbp,
    disbursements,
    vatRatePercent: initialVatRatePercent,
  });

  return {
    workBasis,
    rateSource: lookedUp.activeSource,
    rateCardId: lookedUp.rateCard.id,
    rateCardName: lookedUp.rateCard.name,
    partnerRateGbp: lookedUp.partnerRateGbp,
    associateRateGbp:
      initialQuote?.hourlyRateGbp && initialQuote.hourlyRateGbp > 0
        ? initialQuote.hourlyRateGbp
        : lookedUp.associateRateGbp,
    traineeRateGbp: lookedUp.traineeRateGbp,
    customGrades: lookedUp.customGrades,
    totalEstimateGbp,
    agreedCapGbp,
    vatRatePercent: initialVatRatePercent,
    disbursements,
    disbursementsTotalGbp: computedTotals.disbursementsTotalGbp,
    disbursementsVatGbp: computedTotals.disbursementsVatGbp,
    disbursementsTotalIncVatGbp: computedTotals.disbursementsTotalIncVatGbp,
    estimatedFeeVatGbp: computedTotals.estimatedFeeVatGbp,
    totalIncVatGbp: computedTotals.totalIncVatGbp,
    paymentOnAccountRequired: poaReq,
    paymentOnAccountAmountGbp: poaAmt,
    notes: '',
  };
}
