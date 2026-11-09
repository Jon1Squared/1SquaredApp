import { describe, expect, it } from 'vitest';
import {
  HIGH_RISK_RATING_IDS,
  isHighOrCriticalRiskRating,
  isMatterConflictCheckAwaitingDecision,
} from '../matterOpeningRecord';
import type { ChoiceValue } from '../types';

describe('matterOpeningRecord domain helpers (R345, R365, R367, R372)', () => {
  it('isHighOrCriticalRiskRating matches High and Critical by canonical ID or systemKey and rejects decoy IDs containing "high" (R345, R372)', () => {
    expect(HIGH_RISK_RATING_IDS.has('risk_rating.high')).toBe(true);
    expect(HIGH_RISK_RATING_IDS.has('risk_rating.critical')).toBe(true);

    const customValues: ChoiceValue[] = [
      {
        id: 'risk_rating.custom_critical_tier',
        listKey: 'risk_rating',
        label: 'Severe / Critical',
        systemKey: 'critical',
        sortOrder: 1,
        active: true,
      },
      {
        id: 'risk_rating.custom_highway',
        listKey: 'risk_rating',
        label: 'Highway infrastructure (low)',
        systemKey: 'low',
        sortOrder: 2,
        active: true,
      },
    ];

    expect(isHighOrCriticalRiskRating('risk_rating.high', customValues)).toBe(true);
    expect(isHighOrCriticalRiskRating('risk_rating.critical', customValues)).toBe(true);
    expect(isHighOrCriticalRiskRating('risk_rating.custom_critical_tier', customValues)).toBe(true);
    expect(isHighOrCriticalRiskRating('risk_rating.custom_highway', customValues)).toBe(false);
    expect(isHighOrCriticalRiskRating('risk_rating.medium', customValues)).toBe(false);
    expect(isHighOrCriticalRiskRating('risk_rating.low', customValues)).toBe(false);
    expect(isHighOrCriticalRiskRating('', customValues)).toBe(false);
    expect(isHighOrCriticalRiskRating(null, customValues)).toBe(false);
  });

  it('isMatterConflictCheckAwaitingDecision checks conflictCheckRecord.status === "Referred" and falls back to conflictStatusPillFromLegacy(conflictCheckStatus) === "Referred" with !conflictDecision when conflictCheckRecord is absent (R365, R367)', () => {
    const baseRecord = {
      status: 'Referred' as const,
      outcomeLabel: 'Referred to risk for review' as const,
      declarationConfirmed: true,
      reviewerMessage: 'Awaiting review',
      lastRunAtDisplay: '2026-10-16',
      lastRunById: 'P-000002',
      lastRunByName: 'Dafydd Evans',
      parties: [],
      matches: [],
      runs: [],
      comments: [],
    };

    // 1. Structured conflictCheckRecord with status 'Referred' -> true
    expect(
      isMatterConflictCheckAwaitingDecision({
        conflictCheckRecord: baseRecord,
        conflictDecision: null,
      }),
    ).toBe(true);

    // 2. Structured conflictCheckRecord with status 'Cleared' -> false even if conversion conflictDecision had Potential conflict
    expect(
      isMatterConflictCheckAwaitingDecision({
        conflictCheckRecord: {
          ...baseRecord,
          status: 'Cleared',
          outcomeLabel: 'Cleared by fee earner',
        },
        conflictDecision: {
          outcome: 'Potential conflict',
          summary: 'Conversion warning',
          decidedById: 'P-000002',
          decidedByName: 'Dafydd Evans',
          decidedAt: '2026-10-10',
          sourceRecordId: 'ENQ-000001',
          matchesCount: 1,
        },
      }),
    ).toBe(false);

    // 3. Legacy matter with conflictCheckStatus: 'Potential conflict — escalated', no conflictCheckRecord, and no conflictDecision -> true
    expect(
      isMatterConflictCheckAwaitingDecision({
        conflictCheckStatus: 'Potential conflict — escalated',
        conflictCheckRecord: undefined,
        conflictDecision: null,
      }),
    ).toBe(true);

    // 4. Legacy matter with conflictCheckStatus: 'Potential conflict — escalated', no conflictCheckRecord, and a recorded conflictDecision -> false
    expect(
      isMatterConflictCheckAwaitingDecision({
        conflictCheckStatus: 'Potential conflict — escalated',
        conflictCheckRecord: undefined,
        conflictDecision: {
          outcome: 'Cleared',
          summary: 'Cleared by COLP',
          decidedById: 'P-000003',
          decidedByName: 'Bethan Rees',
          decidedAt: '2026-10-16',
          sourceRecordId: 'M-000006',
          matchesCount: 0,
        },
      }),
    ).toBe(false);

    // 5. Legacy matter with conflictCheckStatus: 'Clear' -> false
    expect(
      isMatterConflictCheckAwaitingDecision({
        conflictCheckStatus: 'Clear',
        conflictCheckRecord: undefined,
        conflictDecision: null,
      }),
    ).toBe(false);
  });
});
