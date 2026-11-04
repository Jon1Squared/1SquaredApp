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
} from './types';
import type { PmsFeeEarner } from '@/pms/types';

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

export function calculateDisbursementsTotal(
  disbursements: MatterDisbursementEntry[],
): number {
  return Math.round(
    disbursements.reduce((sum, item) => sum + (Number(item.amountGbp) || 0), 0) * 100,
  ) / 100;
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
    const disbursements = Array.isArray(saved.disbursements)
      ? saved.disbursements.map((d, i) => ({
          id: d.id || `disb-${i}`,
          description: String(d.description ?? ''),
          amountGbp: Number(d.amountGbp) || 0,
        }))
      : [];
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
      totalEstimateGbp:
        saved.totalEstimateGbp !== undefined
          ? saved.totalEstimateGbp
          : (existing?.feeEstimateGbp ?? null),
      agreedCapGbp:
        saved.agreedCapGbp !== undefined
          ? saved.agreedCapGbp
          : (existing?.agreedFeeCapGbp ?? null),
      disbursements,
      disbursementsTotalGbp: calculateDisbursementsTotal(disbursements),
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

  const disbursements: MatterDisbursementEntry[] = initialQuote?.disbursements
    ? initialQuote.disbursements.map((d) => ({
        id: d.id,
        description: d.description,
        amountGbp: d.amountExVat,
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
    disbursements,
    disbursementsTotalGbp: calculateDisbursementsTotal(disbursements),
    paymentOnAccountRequired: poaReq,
    paymentOnAccountAmountGbp: poaAmt,
    notes: '',
  };
}
