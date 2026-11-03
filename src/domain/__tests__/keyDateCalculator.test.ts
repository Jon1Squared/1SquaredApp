import { describe, expect, it } from 'vitest';
import {
  buildKeyDateCalculation,
  calculateLimitationDate,
  LIMITATION_CALCULATOR_DISCLAIMER,
  sanitizeTriggerValuesForRule,
} from '../keyDateCalculator';
import type {
  BusinessCalendarConfig,
  LimitationRuleConfig,
} from '../keyDates.types';
import type { Person } from '../types';

const ewCalendar: BusinessCalendarConfig = {
  id: 'england-and-wales',
  label: 'England and Wales',
  weekendDays: [0, 6],
  source: 'manual',
  nonWorkingDates: [
    '2026-01-01',
    '2026-04-03',
    '2026-04-06',
    '2026-05-04',
    '2026-05-25',
    '2026-08-31',
    '2026-12-25',
    '2026-12-28',
  ],
};

describe('Pure Limitation Calculator Engine (Phase 2)', () => {
  it('calculates single trigger with years, months, and positive/negative days, including guidanceNote and mandatory disclaimer', () => {
    const rule: LimitationRuleConfig = {
      id: 'contract-simple',
      label: 'Simple contract',
      guidanceNote: 'Check deed vs simple contract before confirming.',
      trigger: { kind: 'single', field: 'accrualDate' },
      period: { years: 6, months: 0, days: 0 },
    };

    const res = calculateLimitationDate(rule, { accrualDate: '2020-05-15' });
    expect(res.date).toBe('2026-05-15');
    expect(res.explanation).toContain(
      'Guidance note: Check deed vs simple contract before confirming.',
    );
    expect(res.explanation).toContain(LIMITATION_CALCULATOR_DISCLAIMER);

    // Negative days (e.g. 14 days before a hearing date or -1 day)
    const preHearingRule: LimitationRuleConfig = {
      id: 'skeleton-argument',
      label: 'Skeleton argument',
      trigger: { kind: 'single', field: 'custom.hearingDate' },
      period: { days: -14 },
      countMethod: 'calendar',
    };
    const negRes = calculateLimitationDate(preHearingRule, {
      custom: { hearingDate: '2026-06-20' },
    });
    expect(negRes.date).toBe('2026-06-06');
  });

  it('handles leap-year clamping (29 Feb + years/months)', () => {
    const rule: LimitationRuleConfig = {
      id: 'leap-test',
      label: 'Leap year test',
      trigger: { kind: 'single', field: 'accrualDate' },
      period: { years: 3 },
    };
    const res = calculateLimitationDate(rule, { accrualDate: '2024-02-29' });
    expect(res.date).toBe('2027-02-28');
  });

  it('resolves later_of trigger selecting the later of accrualDate and dateOfKnowledge', () => {
    const rule: LimitationRuleConfig = {
      id: 'pi-rule',
      label: 'Personal injury',
      trigger: {
        kind: 'later_of',
        fields: ['accrualDate', 'dateOfKnowledge'],
      },
      period: { years: 3 },
    };

    // dateOfKnowledge is later
    const res1 = calculateLimitationDate(rule, {
      accrualDate: '2023-01-10',
      dateOfKnowledge: '2024-06-15',
    });
    expect(res1.date).toBe('2027-06-15');
    expect(
      res1.explanation.some((s) =>
        s.includes('ran from later date dateOfKnowledge (2024-06-15)'),
      ),
    ).toBe(true);

    // accrualDate is later
    const res2 = calculateLimitationDate(rule, {
      accrualDate: '2024-09-01',
      dateOfKnowledge: '2024-06-15',
    });
    expect(res2.date).toBe('2027-09-01');
  });

  it('counts business_days and clear_days accurately across weekends and bank holidays', () => {
    const businessRule: LimitationRuleConfig = {
      id: 'biz-days-rule',
      label: '5 business days',
      trigger: { kind: 'single', field: 'accrualDate' },
      period: { days: 5 },
      countMethod: 'business_days',
      calendarId: 'england-and-wales',
    };

    // 2026-04-01 (Wed):
    // +1 = Thu 2026-04-02
    // Fri 2026-04-03 is Good Friday (bank holiday)
    // Sat/Sun 4/5 Apr weekend
    // Mon 2026-04-06 is Easter Monday (bank holiday)
    // +2 = Tue 2026-04-07
    // +3 = Wed 2026-04-08
    // +4 = Thu 2026-04-09
    // +5 = Fri 2026-04-10
    const bizRes = calculateLimitationDate(
      businessRule,
      { accrualDate: '2026-04-01' },
      ewCalendar,
    );
    expect(bizRes.date).toBe('2026-04-10');

    // Negative business days: -2 business days from Tue 2026-04-07 -> skips Easter Mon, Sun, Sat, Good Fri -> Wed 2026-04-01
    const negBusinessRule: LimitationRuleConfig = {
      ...businessRule,
      period: { days: -2 },
    };
    const negBizRes = calculateLimitationDate(
      negBusinessRule,
      { accrualDate: '2026-04-07' },
      ewCalendar,
    );
    expect(negBizRes.date).toBe('2026-04-01');

    // Clear days: 3 clear days from 2026-06-01 excludes 1 Jun and the event day (2, 3, 4 Jun clear -> 5 Jun)
    const clearRule: LimitationRuleConfig = {
      id: 'clear-days-rule',
      label: '3 clear days',
      trigger: { kind: 'single', field: 'accrualDate' },
      period: { days: 3 },
      countMethod: 'clear_days',
    };
    const clearRes = calculateLimitationDate(clearRule, {
      accrualDate: '2026-06-01',
    });
    expect(clearRes.date).toBe('2026-06-05');
  });

  it('applies nonWorkingDayAdjustment (next_working_day and previous_working_day)', () => {
    const nextWorkingRule: LimitationRuleConfig = {
      id: 'roll-forward',
      label: 'Roll forward rule',
      trigger: { kind: 'single', field: 'accrualDate' },
      period: { years: 1 },
      nonWorkingDayAdjustment: 'next_working_day',
    };

    // 2025-12-25 + 1 year = 2026-12-25 (Fri bank holiday), Sat 26, Sun 27, Mon 28 (boxing day substitute bank holiday) -> Tue 2026-12-29
    const forwardRes = calculateLimitationDate(
      nextWorkingRule,
      { accrualDate: '2025-12-25' },
      ewCalendar,
    );
    expect(forwardRes.date).toBe('2026-12-29');
    expect(
      forwardRes.explanation.some((s) =>
        s.includes('Rolled forward') && s.includes('2026-12-29'),
      ),
    ).toBe(true);

    const prevWorkingRule: LimitationRuleConfig = {
      ...nextWorkingRule,
      nonWorkingDayAdjustment: 'previous_working_day',
    };
    const backwardRes = calculateLimitationDate(
      prevWorkingRule,
      { accrualDate: '2025-12-25' },
      ewCalendar,
    );
    expect(backwardRes.date).toBe('2026-12-24');
  });

  it('applies minority adjustment when claimant is a minor at trigger, and strips DOB when minorityAdjustment is disabled', () => {
    const minorityRule: LimitationRuleConfig = {
      id: 'pi-minority',
      label: 'PI with minority',
      trigger: { kind: 'single', field: 'accrualDate' },
      period: { years: 3 },
      minorityAdjustment: { enabled: true, ageOfMajority: 18 },
    };

    // Born 2012-03-10 -> turns 18 on 2030-03-10 (after accrualDate 2025-05-01). + 3 years = 2033-03-10
    const minorRes = calculateLimitationDate(minorityRule, {
      accrualDate: '2025-05-01',
      claimantDateOfBirth: '2012-03-10',
    });
    expect(minorRes.date).toBe('2033-03-10');
    expect(
      minorRes.explanation.some((s) =>
        s.includes('Minority: ran from 18th birthday (2030-03-10)'),
      ),
    ).toBe(true);

    // Adult at trigger (born 1990-01-01, turns 18 on 2008-01-01 <= 2025-05-01) -> 2028-05-01
    const adultRes = calculateLimitationDate(minorityRule, {
      accrualDate: '2025-05-01',
      claimantDateOfBirth: '1990-01-01',
    });
    expect(adultRes.date).toBe('2028-05-01');

    // Rule without minorityAdjustment strips claimantDateOfBirth for personal data protection
    const noMinorityRule: LimitationRuleConfig = {
      id: 'commercial-claim',
      label: 'Commercial claim',
      trigger: { kind: 'single', field: 'accrualDate' },
      period: { years: 6 },
    };
    const sanitized = sanitizeTriggerValuesForRule(noMinorityRule, {
      accrualDate: '2025-05-01',
      claimantDateOfBirth: '1990-01-01',
    });
    expect(sanitized.strippedDateOfBirth).toBe(true);
    expect(sanitized.sanitized.claimantDateOfBirth).toBeUndefined();
  });

  it('adds standstill periods and caps at longstop when longstop is earlier', () => {
    const latentDamageRule: LimitationRuleConfig = {
      id: 'latent-damage',
      label: 'Latent damage with 15-year longstop',
      trigger: {
        kind: 'later_of',
        fields: ['accrualDate', 'dateOfKnowledge'],
      },
      period: { years: 3 },
      applyStandstillPeriods: true,
      longstop: {
        field: 'accrualDate',
        period: { years: 15 },
      },
    };

    // Case A: Standstill extends date, still within 15-year longstop
    // accrual: 2020-01-01, knowledge: 2024-01-01 -> +3y = 2027-01-01 -> +30d standstill = 2027-01-31 (< longstop 2035-01-01)
    const withinLongstop = calculateLimitationDate(latentDamageRule, {
      accrualDate: '2020-01-01',
      dateOfKnowledge: '2024-01-01',
      standstillPeriods: [
        {
          from: '2026-06-01',
          to: '2026-07-01',
          reference: 'Standstill Agreement #1',
        },
      ],
    });
    expect(withinLongstop.date).toBe('2027-01-31');

    // Case B: Late knowledge + standstill exceeds 15-year longstop from accrualDate -> longstop wins!
    // accrual: 2012-05-01 (15y longstop = 2027-05-01), knowledge: 2025-09-01 (+3y = 2028-09-01) -> capped at 2027-05-01
    const cappedByLongstop = calculateLimitationDate(latentDamageRule, {
      accrualDate: '2012-05-01',
      dateOfKnowledge: '2025-09-01',
    });
    expect(cappedByLongstop.date).toBe('2027-05-01');
    expect(
      cappedByLongstop.explanation.some((s) =>
        s.includes('Longstop: capped at 2027-05-01'),
      ),
    ).toBe(true);
  });

  it('flags unreviewed rule sets with a warning and enforces keydate:override_calculation + reason on overrides while keeping both dates', () => {
    const rule: LimitationRuleConfig = {
      id: 'contract-simple',
      label: 'Simple contract',
      trigger: { kind: 'single', field: 'accrualDate' },
      period: { years: 6 },
    };

    const feeEarner = {
      id: 'P-FE',
      roles: ['fee_earner'],
    } as unknown as Person;
    const partner = {
      id: 'P-PART',
      roles: ['partner'],
    } as unknown as Person;

    // Fee earner without keydate:override_calculation cannot override
    expect(() =>
      buildKeyDateCalculation({
        ruleSet: { id: 'ew-sample', version: 1, reviewStatus: 'unreviewed' },
        rule,
        triggers: { accrualDate: '2020-06-01' },
        override: {
          overriddenDate: '2026-05-01',
          reason: 'Conservative contractual interpretation',
          actor: feeEarner,
        },
      }),
    ).toThrow(/KEY_DATE_PERMISSION_ERROR/);

    // Partner without reason cannot override
    expect(() =>
      buildKeyDateCalculation({
        ruleSet: { id: 'ew-sample', version: 1, reviewStatus: 'unreviewed' },
        rule,
        triggers: { accrualDate: '2020-06-01' },
        override: {
          overriddenDate: '2026-05-01',
          reason: '   ',
          actor: partner,
        },
      }),
    ).toThrow(/KEY_DATE_OVERRIDE_REASON_REQUIRED/);

    // Partner with reason overrides cleanly, keeping both calculatedDate and effectiveDueDate
    const built = buildKeyDateCalculation({
      ruleSet: { id: 'ew-sample', version: 1, reviewStatus: 'unreviewed' },
      rule,
      triggers: { accrualDate: '2020-06-01' },
      override: {
        overriddenDate: '2026-05-01',
        reason: 'Conservative contractual interpretation',
        actor: partner,
      },
    });
    expect(built.calculation.calculatedDate).toBe('2026-06-01');
    expect(built.effectiveDueDate).toBe('2026-05-01');
    expect(built.calculation.overridden).toBe(true);
    expect(built.calculation.overrideReason).toBe(
      'Conservative contractual interpretation',
    );
    expect(built.calculation.ruleSetReviewStatus).toBe('unreviewed');
    expect(built.warnings.some((w) => w.includes('unreviewed'))).toBe(true);
  });
});
