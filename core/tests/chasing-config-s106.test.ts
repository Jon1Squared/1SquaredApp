import { describe, expect, it } from 'vitest';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import {
  CORE_API_VERSION,
  getEngagementStatusRank,
  isCoreApiRangeCompatible,
  isEngagementStatusRegression,
  loadAndValidateTenantConfig,
  NON_ENGAGEMENT_DOCUMENT_TYPE,
  renderNonEngagementLetterContent,
  resolveChasingConfiguration,
  resolveChasingScheduleForKind,
  resolveEngagementConfiguration,
  sanitizePostgresError,
  validateChasingConfig,
  validateChasingRuleSchedule,
  validateEngagementConfig,
} from '../src/index';

describe('S1-06: Communication Chasing & Engagement Config Schemas, Defaults & Monotonic B2 Ranking', () => {
  it('1. Bumps CORE_API_VERSION (^2.4.0) and exposes safe core defaults (enabled: false, sendEmails: false, empty wording)', () => {
    expect(isCoreApiRangeCompatible(CORE_API_VERSION, '^2.4.0')).toBe(true);
    expect(NON_ENGAGEMENT_DOCUMENT_TYPE).toBe('non_engagement');

    const safeChasing = resolveChasingConfiguration(null);
    expect(safeChasing.engagementLetter).toEqual({
      enabled: false,
      sendEmails: false,
      firstChaseDays: 7,
      secondChaseDays: 14,
      escalateTaskDays: 21,
    });
    expect(safeChasing.quote).toEqual(safeChasing.engagementLetter);
    expect(safeChasing.moneyOnAccount).toEqual(safeChasing.engagementLetter);

    expect(resolveChasingScheduleForKind(undefined, 'engagement_letter')).toEqual(
      safeChasing.engagementLetter,
    );

    const safeEngagement = resolveEngagementConfiguration(null);
    expect(safeEngagement.clientCareIntroductoryParagraph).toBe('');
    expect(safeEngagement.clientCareTermsSummary).toBe('');
    expect(safeEngagement.clientCareSignatureInstruction).toBe('');
    expect(safeEngagement.nonEngagementWording.conflict.subjectTemplate).toBe('');
    expect(safeEngagement.nonEngagementWording.conflict.bodyParagraphs).toEqual([]);
  });

  it('2. Validates strictly ascending chase schedule days (first < second < escalate) and rejects invalid configs', () => {
    const valid = validateChasingConfig({
      engagementLetter: {
        enabled: true,
        sendEmails: true,
        firstChaseDays: 7,
        secondChaseDays: 14,
        escalateTaskDays: 21,
      },
    });
    expect(valid.engagementLetter.enabled).toBe(true);
    expect(valid.quote.enabled).toBe(false);

    expect(() =>
      validateChasingConfig({
        engagementLetter: {
          enabled: true,
          sendEmails: true,
          firstChaseDays: 14,
          secondChaseDays: 14,
          escalateTaskDays: 21,
        },
      }),
    ).toThrow(/CHASING_CONFIG_INVALID/);

    expect(() =>
      validateChasingConfig({
        quote: {
          enabled: true,
          sendEmails: true,
          firstChaseDays: 7,
          secondChaseDays: 21,
          escalateTaskDays: 21,
        },
      }),
    ).toThrow(/CHASING_CONFIG_INVALID/);

    const directInvalid = validateChasingRuleSchedule(
      {
        enabled: true,
        sendEmails: true,
        firstChaseDays: 10,
        secondChaseDays: 5,
        escalateTaskDays: 21,
      },
      'quote',
    );
    expect(directInvalid.ok).toBe(false);

    expect(() => validateEngagementConfig({ unknownKey: true })).toThrow(
      /ENGAGEMENT_CONFIG_INVALID/,
    );
  });

  it('3. Validates demo tenant package base.json chasing (7/14/21 enabled) and Appendix A Legal Ombudsman wording', () => {
    const validated = loadAndValidateTenantConfig(
      notALawFirmBaseConfig as Record<string, unknown>,
      {},
      'demo',
      'multi_tenant',
    );

    expect(validated.chasing?.engagementLetter).toEqual({
      enabled: true,
      sendEmails: true,
      firstChaseDays: 7,
      secondChaseDays: 14,
      escalateTaskDays: 21,
    });
    expect(validated.chasing?.quote).toEqual(validated.chasing?.engagementLetter);
    expect(validated.chasing?.moneyOnAccount).toEqual(validated.chasing?.engagementLetter);

    expect(validated.engagement?.clientCareIntroductoryParagraph).toContain(
      notALawFirmBaseConfig.displayName,
    );
    expect(validated.engagement?.clientCareTermsSummary).toContain(
      `If our own complaints process does not resolve your complaint within eight weeks, you have the right to complain to the Legal Ombudsman (demonstration wording only — ${notALawFirmBaseConfig.displayName} is a fictional firm).`,
    );
    expect(validated.engagement?.clientCareSignatureInstruction).toContain(
      'scanned copy or clear photograph',
    );
  });

  it('4. Enforces monotonic B2 engagement status rank progression and conflict zero-third-party-leakage wording', () => {
    expect(getEngagementStatusRank('')).toBe(0);
    expect(getEngagementStatusRank('Drafting')).toBe(0);
    expect(getEngagementStatusRank('Drafted')).toBe(1);
    expect(getEngagementStatusRank('Sent')).toBe(2);
    expect(getEngagementStatusRank('Sent to client')).toBe(2);
    expect(getEngagementStatusRank('Signed')).toBe(3);
    expect(getEngagementStatusRank('Signed & returned')).toBe(3);

    expect(isEngagementStatusRegression('Drafted', '')).toBe(true);
    expect(isEngagementStatusRegression('Sent', 'Drafted')).toBe(true);
    expect(isEngagementStatusRegression('Sent to client', 'Drafting')).toBe(true);
    expect(isEngagementStatusRegression('Signed & returned', 'Sent')).toBe(true);
    expect(isEngagementStatusRegression('Drafted', 'Sent')).toBe(false);
    expect(isEngagementStatusRegression('Sent', 'Sent to client')).toBe(false);
    expect(isEngagementStatusRegression('Sent', 'Signed & returned')).toBe(false);

    const conflictRendered = renderNonEngagementLetterContent({
      config: notALawFirmBaseConfig as unknown as Parameters<
        typeof renderNonEngagementLetterContent
      >[0]['config'],
      closeReasonSystemKey: 'conflict',
      recipientName: 'Alex Morgan',
      enquiryReference: 'ENQ-2026-0042',
      matterAreaLabel: 'Secret Conflicting Counterparty Ltd v Client',
      feeEarnerOrSenderName: 'Harriet Vance',
    });

    expect(conflictRendered.reasonKey).toBe('conflict');
    expect(conflictRendered.subject).toBe('Your recent enquiry (ENQ-2026-0042) — unable to act');
    const joined = conflictRendered.paragraphs.join('\n');
    expect(joined).toContain('Dear Alex Morgan,');
    expect(joined).toContain('For reasons of client confidentiality');
    expect(joined).not.toContain('Secret Conflicting Counterparty');

    const expertiseRendered = renderNonEngagementLetterContent({
      config: notALawFirmBaseConfig as unknown as Parameters<
        typeof renderNonEngagementLetterContent
      >[0]['config'],
      closeReasonSystemKey: 'outside_expertise',
      recipientName: 'Alex Morgan',
      enquiryReference: 'ENQ-2026-0043',
      matterAreaLabel: 'Maritime Salvage',
      feeEarnerOrSenderName: 'Harriet Vance',
    });
    expect(expertiseRendered.paragraphs.join('\n')).toContain('Maritime Salvage');
  });

  it('7. R846(c): sanitizePostgresError uses exact domain error allow-list rather than prefix matching', () => {
    const leakByMessage = new Error('MATTER_UNLISTED_SQL_LEAK: relation "public.matters" failed');
    const sanitizedMsgErr = sanitizePostgresError(leakByMessage, 'ctx');
    expect(sanitizedMsgErr.message).toMatch(/^TENANCY_DATABASE_ERROR:/);
    expect(sanitizedMsgErr.message).not.toContain('MATTER_UNLISTED_SQL_LEAK');
    expect(sanitizedMsgErr.message).not.toContain('relation');

    const leakByCode = Object.assign(new Error('raw pg driver failure'), {
      code: 'MATTER_UNLISTED_SQL_LEAK',
    });
    const sanitizedCodeErr = sanitizePostgresError(leakByCode, 'ctx');
    expect(sanitizedCodeErr.message).toMatch(/^TENANCY_DATABASE_ERROR:/);
    expect(sanitizedCodeErr.message).not.toContain('MATTER_UNLISTED_SQL_LEAK');
    expect(sanitizedCodeErr.code).toBeUndefined();

    const allowedByMessage = new Error('MATTER_CONCURRENCY_CONFLICT: stale row');
    expect(sanitizePostgresError(allowedByMessage, 'ctx')).toBe(allowedByMessage);

    const allowedByCode = Object.assign(new Error('validation failed'), {
      code: 'ENGAGEMENT_DISPATCH_INVALID',
    });
    expect(sanitizePostgresError(allowedByCode, 'ctx')).toBe(allowedByCode);
  });
});
