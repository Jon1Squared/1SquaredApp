/**
 * Pure four-tier negotiated rate resolution domain logic (`core/src/domain/costs/rates.ts`, ADR 0034 §2 / S0-28a).
 *
 * Precedence order (`resolveApplicableRatesFromData`):
 * 1. Tier 1 — Matter rate override (`public.matter_rate_overrides`), when `allowMatterRateOverrides === true`.
 * 2. Tier 2 — Direct client rate override (`public.client_rate_overrides`), preferring matching `practiceAreaId`
 *             over firm-wide (`practiceAreaId === null`) client override.
 * 3. Tier 3 — Client group rate override (`public.client_rate_overrides`) inherited along active
 *             (`merged_into_id IS NULL`) `parentOrganisationId` chain, preferring matching `practiceAreaId`
 *             over firm-wide (`practiceAreaId === null`).
 * 4. Tier 4 — Tenant rate card (`MatterCostsConfig.rateCards`), matching `practiceAreaId` or default rate card,
 *             using `app_table` or `pms` rates per `rateSourceMode`.
 *
 * All rates are held and resolved in integer minor units (pence) with zero client-specific logic in core.
 */

import { minorUnitsToPounds, poundsToMinorUnits, type MinorUnits } from '../money/index';

export const RATE_OVERRIDE_DATE_OVERLAP_CODE = 'RATE_OVERRIDE_DATE_OVERLAP' as const;
export const RATE_OVERRIDE_INVALID_DATE_RANGE_CODE = 'RATE_OVERRIDE_INVALID_DATE_RANGE' as const;
export const RATE_OVERRIDE_VALIDATION_ERROR_CODE = 'RATE_OVERRIDE_VALIDATION_ERROR' as const;

export type RateOverrideGradeKey = 'partner' | 'associate' | 'trainee' | (string & {});

export type ClientRateOverrideClientType = 'person' | 'organisation';

export type ResolvedRateTier = 1 | 2 | 3 | 4;

export type ResolvedRateSource =
  | 'matter_override'
  | 'client_override'
  | 'client_group_override'
  | 'app_table'
  | 'pms';

export interface ClientRateOverrideRecord {
  id: string;
  tenantId: string;
  clientType: ClientRateOverrideClientType;
  clientId: string;
  practiceAreaId: string | null;
  gradeKey: RateOverrideGradeKey;
  rateMinorUnits: MinorUnits;
  rateGbp: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string;
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
}

export interface MatterRateOverrideRecord {
  id: string;
  tenantId: string;
  matterId: string;
  gradeKey: RateOverrideGradeKey;
  rateMinorUnits: MinorUnits;
  rateGbp: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string;
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
}

export interface RateCardFallbackGrade {
  id: string;
  label: string;
  hourlyRateGbp: number;
  pmsRateGbp?: number | null;
}

export interface RateCardFallbackEntry {
  id: string;
  name: string;
  practiceAreaId: string | null;
  partnerRateGbp: number;
  associateRateGbp: number;
  traineeRateGbp: number;
  pmsPartnerRateGbp?: number | null;
  pmsAssociateRateGbp?: number | null;
  pmsTraineeRateGbp?: number | null;
  customGrades?: readonly RateCardFallbackGrade[];
  active: boolean;
}

export interface RateCardFallbackConfig {
  rateSourceMode: 'app_table' | 'pms_when_linked' | 'pms_only';
  pmsLinkActive: boolean;
  allowMatterRateOverrides: boolean;
  rateCards: readonly RateCardFallbackEntry[];
}

export interface ParentChainNodeSummary {
  id: string;
  legalName: string;
  parentOrganisationId: string | null;
}

export interface ParentOrganisationOverridesNode {
  parentOrganisationId: string;
  parentOrganisationName?: string | null;
  overrides: readonly ClientRateOverrideRecord[];
}

export interface GradeRateResolution {
  gradeKey: string;
  tier: ResolvedRateTier;
  source: ResolvedRateSource;
  rateMinorUnits: MinorUnits;
  rateGbp: number;
  currency: string;
  overrideId: string | null;
  overrideScopePracticeAreaId: string | null;
  inheritedFromParentOrganisationId: string | null;
  inheritedFromParentOrganisationName: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  rateCardId: string | null;
  rateCardName: string | null;
}

export interface ResolvedCustomGradeRate {
  id: string;
  label: string;
  hourlyRateGbp: number;
  hourlyRateMinorUnits: MinorUnits;
  resolution: GradeRateResolution;
}

export interface ResolvedApplicableRatesResult {
  asAtDate: string;
  practiceAreaId: string | null;
  rateCardId: string;
  rateCardName: string;
  defaultCardSource: 'app_table' | 'pms';
  dominantTier: ResolvedRateTier;
  dominantSource: ResolvedRateSource;
  partnerRateMinorUnits: MinorUnits;
  partnerRateGbp: number;
  associateRateMinorUnits: MinorUnits;
  associateRateGbp: number;
  traineeRateMinorUnits: MinorUnits;
  traineeRateGbp: number;
  customGrades: ResolvedCustomGradeRate[];
  grades: Record<string, GradeRateResolution>;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OPEN_ENDED_EFFECTIVE_TO = '9999-12-31';

export function isValidIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) {
    return false;
  }
  const [yStr, mStr, dStr] = value.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

export function normaliseEffectiveDateBounds(params: {
  effectiveFrom: string;
  effectiveTo?: string | null;
}): { effectiveFrom: string; effectiveTo: string | null } {
  const effectiveFrom = (params.effectiveFrom ?? '').trim();
  if (!isValidIsoCalendarDate(effectiveFrom)) {
    const err = new Error(
      `${RATE_OVERRIDE_INVALID_DATE_RANGE_CODE}: Effective from date must be a valid YYYY-MM-DD calendar date.`,
    ) as Error & { code: string };
    err.code = RATE_OVERRIDE_INVALID_DATE_RANGE_CODE;
    throw err;
  }
  const rawTo =
    params.effectiveTo === undefined || params.effectiveTo === null
      ? ''
      : params.effectiveTo.trim();
  const effectiveTo = rawTo.length > 0 ? rawTo : null;
  if (effectiveTo !== null && !isValidIsoCalendarDate(effectiveTo)) {
    const err = new Error(
      `${RATE_OVERRIDE_INVALID_DATE_RANGE_CODE}: Effective to date must be a valid YYYY-MM-DD calendar date or omitted.`,
    ) as Error & { code: string };
    err.code = RATE_OVERRIDE_INVALID_DATE_RANGE_CODE;
    throw err;
  }
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    const err = new Error(
      `${RATE_OVERRIDE_INVALID_DATE_RANGE_CODE}: Effective to date (${effectiveTo}) cannot precede effective from date (${effectiveFrom}).`,
    ) as Error & { code: string };
    err.code = RATE_OVERRIDE_INVALID_DATE_RANGE_CODE;
    throw err;
  }
  return { effectiveFrom, effectiveTo };
}

/**
 * Checks whether two inclusive effective-date ranges `[from, to ?? '9999-12-31']` overlap.
 */
export function doEffectiveDateRangesOverlap(
  aFrom: string,
  aTo: string | null | undefined,
  bFrom: string,
  bTo: string | null | undefined,
): boolean {
  const endA = aTo ?? OPEN_ENDED_EFFECTIVE_TO;
  const endB = bTo ?? OPEN_ENDED_EFFECTIVE_TO;
  return aFrom <= endB && endA >= bFrom;
}

export function isRateOverrideEffectiveOnDate(
  override: { effectiveFrom: string; effectiveTo: string | null },
  asAtDate: string,
): boolean {
  if (!isValidIsoCalendarDate(asAtDate)) {
    return false;
  }
  return (
    override.effectiveFrom <= asAtDate &&
    (override.effectiveTo === null || override.effectiveTo >= asAtDate)
  );
}

function gbpToMinorUnitsSafe(gbp: number | null | undefined): MinorUnits {
  if (typeof gbp !== 'number' || !Number.isFinite(gbp) || gbp <= 0) {
    return 0;
  }
  if (gbp < 1e-6) {
    return 0;
  }
  const raw = String(gbp);
  if (/[eE]/.test(raw)) {
    return poundsToMinorUnits(gbp.toFixed(4));
  }
  return poundsToMinorUnits(raw);
}

function selectTier4RateCard(params: {
  config: RateCardFallbackConfig;
  practiceAreaId: string | null;
  rateCardId?: string | null;
  preferredSource?: 'auto' | 'app_table' | 'pms';
}): {
  card: RateCardFallbackEntry;
  activeSource: 'app_table' | 'pms';
  usePms: boolean;
} {
  const { config, practiceAreaId, rateCardId, preferredSource = 'auto' } = params;
  const activeCards = config.rateCards.filter((c) => c.active);
  const fallbackCard: RateCardFallbackEntry = activeCards.find((c) => !c.practiceAreaId) ??
    activeCards[0] ?? {
      id: 'RC-DEFAULT',
      name: 'Standard Rate Card',
      practiceAreaId: null,
      partnerRateGbp: 0,
      associateRateGbp: 0,
      traineeRateGbp: 0,
      customGrades: [],
      active: true,
    };

  const card =
    (rateCardId ? activeCards.find((c) => c.id === rateCardId) : undefined) ??
    (practiceAreaId ? activeCards.find((c) => c.practiceAreaId === practiceAreaId) : undefined) ??
    fallbackCard;

  let usePms = false;
  if (preferredSource === 'pms') {
    usePms = true;
  } else if (preferredSource === 'app_table') {
    usePms = false;
  } else if (config.rateSourceMode === 'pms_only') {
    usePms = true;
  } else if (config.rateSourceMode === 'pms_when_linked' && config.pmsLinkActive) {
    usePms = true;
  }

  return {
    card,
    activeSource: usePms ? 'pms' : 'app_table',
    usePms,
  };
}

function findBestClientOverrideForGrade(params: {
  overrides: readonly ClientRateOverrideRecord[];
  practiceAreaId: string | null;
  gradeKey: string;
  asAtDate: string;
}): ClientRateOverrideRecord | null {
  const activeForGrade = params.overrides.filter(
    (o) => o.gradeKey === params.gradeKey && isRateOverrideEffectiveOnDate(o, params.asAtDate),
  );
  if (activeForGrade.length === 0) {
    return null;
  }
  if (params.practiceAreaId) {
    const specificMatch = activeForGrade.find(
      (o) => o.practiceAreaId === params.practiceAreaId,
    );
    if (specificMatch) {
      return specificMatch;
    }
  }
  return activeForGrade.find((o) => o.practiceAreaId === null) ?? null;
}

export interface ResolveApplicableRatesDataInput {
  asAtDate: string;
  practiceAreaId?: string | null;
  rateCardId?: string | null;
  preferredSource?: 'auto' | 'app_table' | 'pms';
  gradeKey?: string | null;
  config: RateCardFallbackConfig;
  matterOverrides?: readonly MatterRateOverrideRecord[];
  directClientOverrides?: readonly ClientRateOverrideRecord[];
  parentChainOverrides?: readonly ParentOrganisationOverridesNode[];
}

/**
 * Resolves hourly rates using the fixed four-tier precedence chain (ADR 0034 §2):
 * 1. Matter override (`matter_rate_overrides`, when `config.allowMatterRateOverrides === true`)
 * 2. Direct client override (`client_rate_overrides` for client, matching `practiceAreaId` else `null`)
 * 3. Client group override (`client_rate_overrides` along active parent org chain, matching `practiceAreaId` else `null`)
 * 4. Rate card fallback (`config.rateCards`)
 */
export function resolveApplicableRatesFromData(
  input: ResolveApplicableRatesDataInput,
): ResolvedApplicableRatesResult {
  const asAtDate = input.asAtDate.trim();
  if (!isValidIsoCalendarDate(asAtDate)) {
    const err = new Error(
      `${RATE_OVERRIDE_INVALID_DATE_RANGE_CODE}: asAtDate must be a valid YYYY-MM-DD calendar date.`,
    ) as Error & { code: string };
    err.code = RATE_OVERRIDE_INVALID_DATE_RANGE_CODE;
    throw err;
  }

  const practiceAreaId = input.practiceAreaId?.trim() || null;
  const { card, activeSource, usePms } = selectTier4RateCard({
    config: input.config,
    practiceAreaId,
    rateCardId: input.rateCardId,
    preferredSource: input.preferredSource,
  });

  const matterOverrides = input.config.allowMatterRateOverrides
    ? (input.matterOverrides ?? [])
    : [];
  const directClientOverrides = input.directClientOverrides ?? [];
  const parentChain = input.parentChainOverrides ?? [];

  const cardGradesList: RateCardFallbackGrade[] = card.customGrades
    ? [...card.customGrades]
    : [];

  const allGradeKeys = new Set<string>(['partner', 'associate', 'trainee']);
  for (const cg of cardGradesList) {
    allGradeKeys.add(cg.id);
  }
  for (const mo of matterOverrides) {
    allGradeKeys.add(mo.gradeKey);
  }
  for (const co of directClientOverrides) {
    allGradeKeys.add(co.gradeKey);
  }
  for (const node of parentChain) {
    for (const po of node.overrides) {
      allGradeKeys.add(po.gradeKey);
    }
  }
  if (input.gradeKey?.trim()) {
    allGradeKeys.add(input.gradeKey.trim());
  }

  const resolveTier4MinorForGrade = (gradeKey: string): MinorUnits => {
    if (gradeKey === 'partner') {
      const gbp = usePms ? (card.pmsPartnerRateGbp ?? card.partnerRateGbp) : card.partnerRateGbp;
      return gbpToMinorUnitsSafe(gbp);
    }
    if (gradeKey === 'associate') {
      const gbp = usePms
        ? (card.pmsAssociateRateGbp ?? card.associateRateGbp)
        : card.associateRateGbp;
      return gbpToMinorUnitsSafe(gbp);
    }
    if (gradeKey === 'trainee') {
      const gbp = usePms ? (card.pmsTraineeRateGbp ?? card.traineeRateGbp) : card.traineeRateGbp;
      return gbpToMinorUnitsSafe(gbp);
    }
    const custom = cardGradesList.find((g) => g.id === gradeKey);
    if (!custom) {
      return 0;
    }
    const gbp = usePms ? (custom.pmsRateGbp ?? custom.hourlyRateGbp) : custom.hourlyRateGbp;
    return gbpToMinorUnitsSafe(gbp);
  };

  const resolveSingleGrade = (gradeKey: string): GradeRateResolution => {
    // Tier 1: Matter rate override
    const tier1 = matterOverrides.find(
      (mo) => mo.gradeKey === gradeKey && isRateOverrideEffectiveOnDate(mo, asAtDate),
    );
    if (tier1) {
      return {
        gradeKey,
        tier: 1,
        source: 'matter_override',
        rateMinorUnits: tier1.rateMinorUnits,
        rateGbp: minorUnitsToPounds(tier1.rateMinorUnits),
        currency: tier1.currency || 'GBP',
        overrideId: tier1.id,
        overrideScopePracticeAreaId: null,
        inheritedFromParentOrganisationId: null,
        inheritedFromParentOrganisationName: null,
        effectiveFrom: tier1.effectiveFrom,
        effectiveTo: tier1.effectiveTo,
        rateCardId: card.id,
        rateCardName: card.name,
      };
    }

    // Tier 2: Direct client override
    const tier2 = findBestClientOverrideForGrade({
      overrides: directClientOverrides,
      practiceAreaId,
      gradeKey,
      asAtDate,
    });
    if (tier2) {
      return {
        gradeKey,
        tier: 2,
        source: 'client_override',
        rateMinorUnits: tier2.rateMinorUnits,
        rateGbp: minorUnitsToPounds(tier2.rateMinorUnits),
        currency: tier2.currency || 'GBP',
        overrideId: tier2.id,
        overrideScopePracticeAreaId: tier2.practiceAreaId,
        inheritedFromParentOrganisationId: null,
        inheritedFromParentOrganisationName: null,
        effectiveFrom: tier2.effectiveFrom,
        effectiveTo: tier2.effectiveTo,
        rateCardId: card.id,
        rateCardName: card.name,
      };
    }

    // Tier 3: Parent organisation client-group override (nearest active ancestor first)
    for (const parentNode of parentChain) {
      const tier3 = findBestClientOverrideForGrade({
        overrides: parentNode.overrides,
        practiceAreaId,
        gradeKey,
        asAtDate,
      });
      if (tier3) {
        return {
          gradeKey,
          tier: 3,
          source: 'client_group_override',
          rateMinorUnits: tier3.rateMinorUnits,
          rateGbp: minorUnitsToPounds(tier3.rateMinorUnits),
          currency: tier3.currency || 'GBP',
          overrideId: tier3.id,
          overrideScopePracticeAreaId: tier3.practiceAreaId,
          inheritedFromParentOrganisationId: parentNode.parentOrganisationId,
          inheritedFromParentOrganisationName: parentNode.parentOrganisationName ?? null,
          effectiveFrom: tier3.effectiveFrom,
          effectiveTo: tier3.effectiveTo,
          rateCardId: card.id,
          rateCardName: card.name,
        };
      }
    }

    // Tier 4: Rate card fallback
    const tier4Minor = resolveTier4MinorForGrade(gradeKey);
    return {
      gradeKey,
      tier: 4,
      source: activeSource,
      rateMinorUnits: tier4Minor,
      rateGbp: minorUnitsToPounds(tier4Minor),
      currency: 'GBP',
      overrideId: null,
      overrideScopePracticeAreaId: card.practiceAreaId,
      inheritedFromParentOrganisationId: null,
      inheritedFromParentOrganisationName: null,
      effectiveFrom: null,
      effectiveTo: null,
      rateCardId: card.id,
      rateCardName: card.name,
    };
  };

  const grades: Record<string, GradeRateResolution> = {};
  for (const key of allGradeKeys) {
    grades[key] = resolveSingleGrade(key);
  }

  const partnerRes = grades['partner']!;
  const associateRes = grades['associate']!;
  const traineeRes = grades['trainee']!;

  const customGrades: ResolvedCustomGradeRate[] = cardGradesList.map((cg) => {
    const res = grades[cg.id]!;
    return {
      id: cg.id,
      label: cg.label,
      hourlyRateGbp: res.rateGbp,
      hourlyRateMinorUnits: res.rateMinorUnits,
      resolution: res,
    };
  });

  const targetGrades = input.gradeKey?.trim()
    ? [grades[input.gradeKey.trim()]!]
    : [partnerRes, associateRes, traineeRes, ...customGrades.map((g) => g.resolution)];

  let dominant = targetGrades[0] ?? partnerRes;
  for (const candidate of targetGrades) {
    if (candidate.tier < dominant.tier) {
      dominant = candidate;
    }
  }

  return {
    asAtDate,
    practiceAreaId,
    rateCardId: card.id,
    rateCardName: card.name,
    defaultCardSource: activeSource,
    dominantTier: dominant.tier,
    dominantSource: dominant.source,
    partnerRateMinorUnits: partnerRes.rateMinorUnits,
    partnerRateGbp: partnerRes.rateGbp,
    associateRateMinorUnits: associateRes.rateMinorUnits,
    associateRateGbp: associateRes.rateGbp,
    traineeRateMinorUnits: traineeRes.rateMinorUnits,
    traineeRateGbp: traineeRes.rateGbp,
    customGrades,
    grades,
  };
}
