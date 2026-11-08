/**
 * Pure Limitation & Key Date Calculation Engine (`src/domain/keyDateCalculator.ts`).
 *
 * Classification: Core feature (Platform Architecture Standard §14).
 * - Pure functions only: zero I/O, zero database or network calls.
 * - Zero statutory limitation periods in core code: all rules come from tenant configuration.
 * - Treats `claimantDateOfBirth` as personal data: only captured/retained when a rule uses
 *   `minorityAdjustment.enabled === true`.
 */

import {
  hasKeyDatePermission,
  type ResolveKeyDatePermissionsOptions,
} from './keyDates';

export function findBusinessCalendar(
  config: KeyDatesConfig | null | undefined,
  calendarId?: string | null,
): BusinessCalendarConfig | undefined {
  const cals = config?.businessCalendars ?? [];
  if (calendarId) {
    const found = cals.find((c) => c.id === calendarId);
    if (found) return found;
  }
  return cals[0];
}

export function findLimitationRule(
  config: KeyDatesConfig | null | undefined,
  ruleSetId: string,
  ruleId: string,
): { ruleSet: LimitationRuleSetConfig; rule: LimitationRuleConfig } | undefined {
  const rs = config?.limitationRuleSets?.find((s) => s.id === ruleSetId);
  if (!rs) return undefined;
  const limitationRule = rs.rules.find((r) => r.id === ruleId);
  if (!limitationRule) return undefined;
  return { ruleSet: rs, rule: limitationRule };
}
import type {
  BusinessCalendarConfig,
  CalculationResult,
  IsoDate,
  KeyDateCalculation,
  KeyDatesConfig,
  KeyDateTriggerValues,
  LimitationPeriodConfig,
  LimitationRuleConfig,
  LimitationRuleSetConfig,
  TriggerFieldKey,
} from './keyDates.types';
import type { Person } from './types';

export const LIMITATION_CALCULATOR_DISCLAIMER =
  'This calculation is a guide. A solicitor must confirm the date.';

export interface CalculateLimitationDateOptions {
  rule: LimitationRuleConfig;
  triggers: KeyDateTriggerValues;
  calendar?: BusinessCalendarConfig | null;
  ruleSetReviewStatus?: 'reviewed' | 'unreviewed';
}

interface UtcCalendarDate {
  y: number;
  m: number; // 1..12
  d: number; // 1..31
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDateStrict(iso: string | undefined | null): UtcCalendarDate | null {
  if (!iso || typeof iso !== 'string' || !ISO_DATE_RE.test(iso.trim())) {
    return null;
  }
  const [y, m, d] = iso.trim().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() + 1 !== m ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m, d };
}

export function formatUtcCalendarDate(parts: UtcCalendarDate): IsoDate {
  const y = String(parts.y).padStart(4, '0');
  const m = String(parts.m).padStart(2, '0');
  const d = String(parts.d).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toUtcMs(iso: IsoDate): number {
  const parsed = parseIsoDateStrict(iso);
  if (!parsed) {
    throw new Error(`CALCULATOR_INVALID_DATE: "${iso}" is not a valid YYYY-MM-DD calendar date.`);
  }
  return Date.UTC(parsed.y, parsed.m - 1, parsed.d);
}

function fromUtcMs(ms: number): IsoDate {
  const dt = new Date(ms);
  return formatUtcCalendarDate({
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
  });
}

function daysInUtcMonth(year: number, month1To12: number): number {
  return new Date(Date.UTC(year, month1To12, 0)).getUTCDate();
}

/**
 * Adds calendar years and months with end-of-month clamping (e.g. 2024-02-29 + 1 year -> 2025-02-28).
 */
export function addYearsAndMonths(
  baseIso: IsoDate,
  years: number,
  months: number,
): IsoDate {
  const parsed = parseIsoDateStrict(baseIso);
  if (!parsed) {
    throw new Error(`CALCULATOR_INVALID_DATE: "${baseIso}" is not a valid YYYY-MM-DD calendar date.`);
  }
  const totalMonths = (parsed.y + years) * 12 + (parsed.m - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth0 = ((totalMonths % 12) + 12) % 12;
  const targetMonth1 = targetMonth0 + 1;
  const maxDay = daysInUtcMonth(targetYear, targetMonth1);
  const targetDay = Math.min(parsed.d, maxDay);
  return formatUtcCalendarDate({
    y: targetYear,
    m: targetMonth1,
    d: targetDay,
  });
}

export function addCalendarDays(baseIso: IsoDate, days: number): IsoDate {
  const ms = toUtcMs(baseIso);
  return fromUtcMs(ms + days * 86_400_000);
}

export function diffCalendarDays(fromIso: IsoDate, toIso: IsoDate): number {
  return Math.round((toUtcMs(toIso) - toUtcMs(fromIso)) / 86_400_000);
}

export function isNonWorkingDate(
  iso: IsoDate,
  calendar?: BusinessCalendarConfig | null,
): { nonWorking: boolean; reason?: string } {
  const weekendDays = calendar?.weekendDays ?? [0, 6];
  const holidays = new Set(calendar?.nonWorkingDates ?? []);
  if (holidays.has(iso)) {
    return { nonWorking: true, reason: `bank holiday / non-working date ${iso}` };
  }
  const dow = new Date(toUtcMs(iso)).getUTCDay();
  if (weekendDays.includes(dow)) {
    const dayNames = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];
    return { nonWorking: true, reason: `weekend (${dayNames[dow]})` };
  }
  return { nonWorking: false };
}

export function addBusinessDaysWithCalendar(
  baseIso: IsoDate,
  businessDays: number,
  calendar?: BusinessCalendarConfig | null,
): IsoDate {
  if (businessDays === 0) return baseIso;
  const step = businessDays > 0 ? 1 : -1;
  let remaining = Math.abs(businessDays);
  let cursor = baseIso;
  while (remaining > 0) {
    cursor = addCalendarDays(cursor, step);
    if (!isNonWorkingDate(cursor, calendar).nonWorking) {
      remaining -= 1;
    }
  }
  return cursor;
}

export function resolveTriggerFieldValue(
  triggers: KeyDateTriggerValues,
  field: TriggerFieldKey | string,
): IsoDate | undefined {
  if (field === 'accrualDate') return triggers.accrualDate;
  if (field === 'dateOfKnowledge') return triggers.dateOfKnowledge;
  if (field === 'claimantDateOfBirth') return triggers.claimantDateOfBirth;
  if (field === 'dateOfDeath') return triggers.dateOfDeath;
  if (field.startsWith('custom.')) {
    const customKey = field.slice('custom.'.length);
    return triggers.custom?.[customKey];
  }
  return triggers.custom?.[field];
}

function formatPeriodDescription(period: LimitationPeriodConfig): string {
  const parts: string[] = [];
  if (period.years) {
    parts.push(`${period.years} ${Math.abs(period.years) === 1 ? 'year' : 'years'}`);
  }
  if (period.months) {
    parts.push(`${period.months} ${Math.abs(period.months) === 1 ? 'month' : 'months'}`);
  }
  if (period.days) {
    parts.push(`${period.days} ${Math.abs(period.days) === 1 ? 'day' : 'days'}`);
  }
  return parts.length > 0 ? parts.join(', ') : '0 days';
}

/**
 * Strips `claimantDateOfBirth` from `KeyDateTriggerValues` when the rule does not use
 * a minority adjustment (and does not use `claimantDateOfBirth` as a trigger field),
 * satisfying the personal data minimisation requirement (§11).
 */
export function sanitizeTriggerValuesForRule(
  limitationRule: LimitationRuleConfig,
  triggers: KeyDateTriggerValues,
): { sanitized: KeyDateTriggerValues; strippedDateOfBirth: boolean } {
  const usesMinority = Boolean(limitationRule.minorityAdjustment?.enabled);
  const triggerUsesDob =
    (limitationRule.trigger.kind === 'single' &&
      limitationRule.trigger.field === 'claimantDateOfBirth') ||
    (limitationRule.trigger.kind === 'later_of' &&
      limitationRule.trigger.fields.includes('claimantDateOfBirth'));

  const clone: KeyDateTriggerValues = {
    ...(triggers.accrualDate ? { accrualDate: triggers.accrualDate } : {}),
    ...(triggers.dateOfKnowledge
      ? { dateOfKnowledge: triggers.dateOfKnowledge }
      : {}),
    ...(triggers.dateOfDeath ? { dateOfDeath: triggers.dateOfDeath } : {}),
    ...(triggers.standstillPeriods
      ? {
          standstillPeriods: triggers.standstillPeriods.map((s) => ({ ...s })),
        }
      : {}),
    ...(triggers.custom ? { custom: { ...triggers.custom } } : {}),
  };

  if (usesMinority || triggerUsesDob) {
    if (triggers.claimantDateOfBirth) {
      clone.claimantDateOfBirth = triggers.claimantDateOfBirth;
    }
    return { sanitized: clone, strippedDateOfBirth: false };
  }

  return {
    sanitized: clone,
    strippedDateOfBirth: Boolean(triggers.claimantDateOfBirth),
  };
}

/**
 * Pure limitation date calculator.
 * Accepts either a single `CalculateLimitationDateOptions` object or positional `(rule, triggers, calendar, opts)`.
 */
export function calculateLimitationDate(
  ruleOrOptions: LimitationRuleConfig | CalculateLimitationDateOptions,
  triggersArg?: KeyDateTriggerValues,
  calendarArg?: BusinessCalendarConfig | null,
  extraOptions?: { ruleSetReviewStatus?: 'reviewed' | 'unreviewed' },
): CalculationResult {
  const opts: CalculateLimitationDateOptions =
    'rule' in ruleOrOptions && 'triggers' in ruleOrOptions
      ? ruleOrOptions
      : {
          rule: ruleOrOptions,
          triggers: triggersArg ?? {},
          calendar: calendarArg ?? null,
          ruleSetReviewStatus: extraOptions?.ruleSetReviewStatus,
        };

  const {
    rule: limitationRule,
    triggers,
    calendar,
    ruleSetReviewStatus,
  } = opts;
  const explanation: string[] = [];
  const warnings: string[] = [];

  if (ruleSetReviewStatus === 'unreviewed') {
    warnings.push(
      'Rule set is unreviewed: a solicitor must verify this date before it can be confirmed.',
    );
  }

  const { strippedDateOfBirth } = sanitizeTriggerValuesForRule(
    limitationRule,
    triggers,
  );
  if (strippedDateOfBirth) {
    warnings.push(
      'Claimant date of birth was ignored because this rule does not use a minority adjustment.',
    );
  }

  // 1. Resolve trigger date (`single` or `later_of`)
  let effectiveStart: IsoDate;
  if (limitationRule.trigger.kind === 'single') {
    const rawVal = resolveTriggerFieldValue(
      triggers,
      limitationRule.trigger.field,
    );
    if (!rawVal || !parseIsoDateStrict(rawVal)) {
      throw new Error(
        `CALCULATOR_MISSING_TRIGGER: Trigger field "${limitationRule.trigger.field}" is required and must be a valid YYYY-MM-DD date.`,
      );
    }
    effectiveStart = rawVal.trim();
    explanation.push(
      `Trigger (${limitationRule.trigger.field}): started from ${effectiveStart}`,
    );
  } else {
    const candidates: Array<{ field: TriggerFieldKey; date: IsoDate }> = [];
    for (const field of limitationRule.trigger.fields) {
      const val = resolveTriggerFieldValue(triggers, field);
      if (val) {
        if (!parseIsoDateStrict(val)) {
          throw new Error(
            `CALCULATOR_INVALID_DATE: Trigger field "${field}" has invalid date "${val}".`,
          );
        }
        candidates.push({ field, date: val.trim() });
      }
    }
    if (candidates.length === 0) {
      throw new Error(
        `CALCULATOR_MISSING_TRIGGER: At least one trigger field from [${limitationRule.trigger.fields.join(', ')}] must be provided.`,
      );
    }
    if (candidates.length < limitationRule.trigger.fields.length) {
      const missing = limitationRule.trigger.fields.filter(
        (f) => !candidates.some((c) => c.field === f),
      );
      warnings.push(
        `Optional/secondary trigger field(s) not supplied: ${missing.join(', ')}.`,
      );
    }
    candidates.sort((a, b) => a.date.localeCompare(b.date));
    const winner = candidates[candidates.length - 1]!;
    effectiveStart = winner.date;
    const summary = candidates.map((c) => `${c.field}=${c.date}`).join(', ');
    explanation.push(
      `Later-of trigger (${summary}): ran from later date ${winner.field} (${effectiveStart})`,
    );
  }

  // 2. Minority adjustment (if enabled and claimantDateOfBirth provided)
  if (
    limitationRule.minorityAdjustment?.enabled &&
    triggers.claimantDateOfBirth
  ) {
    if (!parseIsoDateStrict(triggers.claimantDateOfBirth)) {
      throw new Error(
        `CALCULATOR_INVALID_DATE: claimantDateOfBirth "${triggers.claimantDateOfBirth}" is not a valid YYYY-MM-DD date.`,
      );
    }
    const ageOfMajority =
      limitationRule.minorityAdjustment.ageOfMajority ?? 18;
    const majorityDate = addYearsAndMonths(
      triggers.claimantDateOfBirth,
      ageOfMajority,
      0,
    );
    if (majorityDate > effectiveStart) {
      explanation.push(
        `Minority: ran from ${ageOfMajority}th birthday (${majorityDate}) instead of ${effectiveStart}`,
      );
      effectiveStart = majorityDate;
    } else {
      explanation.push(
        `Minority: claimant turned ${ageOfMajority} on ${majorityDate} (on or before trigger ${effectiveStart}); no adjustment`,
      );
    }
  }

  // 3. Apply period (years, months, days) with countMethod ('calendar' | 'business_days' | 'clear_days')
  let current = effectiveStart;
  const years = limitationRule.period.years ?? 0;
  const months = limitationRule.period.months ?? 0;
  const days = limitationRule.period.days ?? 0;
  const countMethod = limitationRule.countMethod ?? 'calendar';

  if (years !== 0 || months !== 0) {
    const next = addYearsAndMonths(current, years, months);
    explanation.push(
      `Period (${formatPeriodDescription({ years, months })}): ${current} -> ${next}`,
    );
    current = next;
  }

  if (days !== 0) {
    if (countMethod === 'business_days') {
      const next = addBusinessDaysWithCalendar(current, days, calendar);
      explanation.push(
        `Counted ${days} business ${Math.abs(days) === 1 ? 'day' : 'days'} (${calendar?.label ?? 'standard calendar'}): ${current} -> ${next}`,
      );
      current = next;
    } else if (countMethod === 'clear_days') {
      // Clear days exclude both the trigger day and the target event day
      const clearShift = days > 0 ? days + 1 : days - 1;
      const next = addCalendarDays(current, clearShift);
      explanation.push(
        `Counted ${days} clear ${Math.abs(days) === 1 ? 'day' : 'days'} (excluding start and event day): ${current} -> ${next}`,
      );
      current = next;
    } else {
      const next = addCalendarDays(current, days);
      explanation.push(
        `Added ${days} calendar ${Math.abs(days) === 1 ? 'day' : 'days'}: ${current} -> ${next}`,
      );
      current = next;
    }
  } else if (years === 0 && months === 0) {
    explanation.push(`Period (0 days): remained at ${current}`);
  }

  // 4. Standstill periods (add paused days)
  const applyStandstill = limitationRule.applyStandstillPeriods ?? true;
  if (
    applyStandstill &&
    Array.isArray(triggers.standstillPeriods) &&
    triggers.standstillPeriods.length > 0
  ) {
    let totalStandstillDays = 0;
    for (const sp of triggers.standstillPeriods) {
      if (!parseIsoDateStrict(sp.from) || !parseIsoDateStrict(sp.to)) {
        throw new Error(
          `CALCULATOR_INVALID_STANDSTILL: Standstill period "${sp.reference}" has invalid dates (${sp.from} to ${sp.to}).`,
        );
      }
      const pausedDays = diffCalendarDays(sp.from, sp.to);
      if (pausedDays < 0) {
        throw new Error(
          `CALCULATOR_INVALID_STANDSTILL: Standstill period "${sp.reference}" end date (${sp.to}) cannot be before start date (${sp.from}).`,
        );
      }
      totalStandstillDays += pausedDays;
      const next = addCalendarDays(current, pausedDays);
      explanation.push(
        `Standstill (${sp.reference}: ${sp.from} to ${sp.to}): added ${pausedDays} paused ${pausedDays === 1 ? 'day' : 'days'} -> ${next}`,
      );
      current = next;
    }
    if (totalStandstillDays > 0) {
      explanation.push(
        `Total standstill extension: ${totalStandstillDays} ${totalStandstillDays === 1 ? 'day' : 'days'}`,
      );
    }
  }

  // 5. Longstop (the earlier of the calculated date and the longstop wins)
  if (limitationRule.longstop) {
    const longstopTrigger =
      resolveTriggerFieldValue(triggers, limitationRule.longstop.field) ??
      triggers.accrualDate;
    if (longstopTrigger && parseIsoDateStrict(longstopTrigger)) {
      let longstopDate = addYearsAndMonths(
        longstopTrigger,
        limitationRule.longstop.period.years ?? 0,
        limitationRule.longstop.period.months ?? 0,
      );
      if (limitationRule.longstop.period.days) {
        longstopDate = addCalendarDays(
          longstopDate,
          limitationRule.longstop.period.days,
        );
      }
      if (longstopDate < current) {
        explanation.push(
          `Longstop: capped at ${longstopDate} (${formatPeriodDescription(limitationRule.longstop.period)} from ${limitationRule.longstop.field} ${longstopTrigger}), which is earlier than ${current}`,
        );
        current = longstopDate;
      } else {
        explanation.push(
          `Longstop: calculated date ${current} is on or before longstop ${longstopDate} (${formatPeriodDescription(limitationRule.longstop.period)} from ${limitationRule.longstop.field} ${longstopTrigger})`,
        );
      }
    } else {
      warnings.push(
        `Longstop trigger field "${limitationRule.longstop.field}" was not supplied; longstop could not be evaluated.`,
      );
    }
  }

  // 6. Non-working-day adjustment
  const adjustment = limitationRule.nonWorkingDayAdjustment ?? 'none';
  if (adjustment !== 'none') {
    const check = isNonWorkingDate(current, calendar);
    if (check.nonWorking) {
      const original = current;
      const step = adjustment === 'previous_working_day' ? -1 : 1;
      const directionLabel =
        adjustment === 'previous_working_day' ? 'backward' : 'forward';
      while (isNonWorkingDate(current, calendar).nonWorking) {
        current = addCalendarDays(current, step);
      }
      explanation.push(
        `Rolled ${directionLabel} from ${check.reason ?? 'non-working day'} ${original} to working day ${current}`,
      );
    }
  }

  if (limitationRule.guidanceNote) {
    explanation.push(`Guidance note: ${limitationRule.guidanceNote}`);
  }
  explanation.push(LIMITATION_CALCULATOR_DISCLAIMER);

  return {
    date: current,
    explanation,
    warnings,
  };
}

function assembleKeyDateCalculation(
  input: {
    ruleSet: Pick<LimitationRuleSetConfig, 'id' | 'version' | 'reviewStatus'>;
    rule: LimitationRuleConfig;
    triggers: KeyDateTriggerValues;
    calendar?: BusinessCalendarConfig | null;
    override?: {
      overriddenDate: IsoDate;
      reason: string;
    };
  },
  overrideAllowed: boolean,
): {
  calculation: KeyDateCalculation;
  effectiveDueDate: IsoDate;
  warnings: string[];
} {
  const { sanitized } = sanitizeTriggerValuesForRule(input.rule, input.triggers);
  const result = calculateLimitationDate({
    rule: input.rule,
    triggers: sanitized,
    calendar: input.calendar,
    ruleSetReviewStatus: input.ruleSet.reviewStatus,
  });

  if (input.override) {
    if (!overrideAllowed) {
      throw new Error(
        'KEY_DATE_PERMISSION_ERROR: Overriding a calculated date requires the "keydate:override_calculation" permission.',
      );
    }
    const reason = input.override.reason?.trim();
    if (!reason) {
      throw new Error(
        'KEY_DATE_OVERRIDE_REASON_REQUIRED: A reason is required when overriding a calculated date.',
      );
    }
    if (!parseIsoDateStrict(input.override.overriddenDate)) {
      throw new Error(
        `CALCULATOR_INVALID_DATE: Overridden date "${input.override.overriddenDate}" must be a valid YYYY-MM-DD date.`,
      );
    }
    const overriddenDate = input.override.overriddenDate.trim();
    return {
      calculation: {
        ruleSetId: input.ruleSet.id,
        ruleSetVersion: input.ruleSet.version,
        ruleId: input.rule.id,
        ruleSetReviewStatus: input.ruleSet.reviewStatus,
        triggers: sanitized,
        calculatedDate: result.date,
        explanation: [
          ...result.explanation,
          `Calculation overridden from ${result.date} to ${overriddenDate}. Reason: ${reason}`,
        ],
        overridden: true,
        overrideReason: reason,
      },
      effectiveDueDate: overriddenDate,
      warnings: result.warnings,
    };
  }

  return {
    calculation: {
      ruleSetId: input.ruleSet.id,
      ruleSetVersion: input.ruleSet.version,
      ruleId: input.rule.id,
      ruleSetReviewStatus: input.ruleSet.reviewStatus,
      triggers: sanitized,
      calculatedDate: result.date,
      explanation: result.explanation,
      overridden: false,
    },
    effectiveDueDate: result.date,
    warnings: result.warnings,
  };
}

/**
 * Builds a persisted `KeyDateCalculation` record from a rule set, rule, triggers, and optional override.
 * Always enforces `keydate:override_calculation` via `hasKeyDatePermission` and a mandatory non-empty reason when overriding.
 */
export function buildKeyDateCalculation(input: {
  ruleSet: Pick<LimitationRuleSetConfig, 'id' | 'version' | 'reviewStatus'>;
  rule: LimitationRuleConfig;
  triggers: KeyDateTriggerValues;
  calendar?: BusinessCalendarConfig | null;
  override?: {
    overriddenDate: IsoDate;
    reason: string;
    actor?: Person | null | undefined;
    permissionOptions?: ResolveKeyDatePermissionsOptions | KeyDatesConfig | null;
  };
}): {
  calculation: KeyDateCalculation;
  effectiveDueDate: IsoDate;
  warnings: string[];
} {
  const overrideAllowed = input.override
    ? hasKeyDatePermission(
        input.override.actor,
        'keydate:override_calculation',
        input.override.permissionOptions,
      )
    : false;
  return assembleKeyDateCalculation(input, overrideAllowed);
}

/**
 * UI-only preview helper for assembling a `KeyDateCalculation` payload in a client component
 * using a server-precomputed `overrideAllowed` boolean. Server actions re-verify
 * `keydate:override_calculation` authoritatively before persisting.
 */
export function previewKeyDateCalculation(
  input: {
    ruleSet: Pick<LimitationRuleSetConfig, 'id' | 'version' | 'reviewStatus'>;
    rule: LimitationRuleConfig;
    triggers: KeyDateTriggerValues;
    calendar?: BusinessCalendarConfig | null;
    override?: {
      overriddenDate: IsoDate;
      reason: string;
    };
  },
  options: { overrideAllowed: boolean },
): {
  calculation: KeyDateCalculation;
  effectiveDueDate: IsoDate;
  warnings: string[];
} {
  return assembleKeyDateCalculation(input, Boolean(options.overrideAllowed));
}
