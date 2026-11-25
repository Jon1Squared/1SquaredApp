import { describe, expect, it } from 'vitest';
import { evaluateOpeningPreconditions } from '../openingGate';

describe('openingGate domain logic (R761, R763, R785)', () => {
  it('R785: checks cddMasked before cddRawSatisfied and displays a neutral summary when viewer cannot see CDD', () => {
    const evalMasked = evaluateOpeningPreconditions({
      matter: {
        conflictCheckRecord: { status: 'Cleared' } as never,
        conflictCheckStatus: 'Cleared',
        engagementLetterStatus: 'Drafting',
        engagementLetterSignedAt: null,
        retainerMoniesOnAccountGbp: null,
        riskRatingId: 'risk_rating.low',
      },
      gateConfig: {
        requireConflictCleared: true,
        requireCddComplete: true,
        allowCddOverride: false,
        requireEngagementSigned: false,
        requireFundsOnAccount: false,
      },
      cddStatus: {
        status: 'recorded',
        isExpired: false,
        visibleToViewer: false,
      },
      activeOverrides: [],
      requiresHighRiskApproval: false,
    });

    const cddCheck = evalMasked.preconditions.find((p) => p.key === 'cdd_complete');
    expect(cddCheck).toBeDefined();
    expect(cddCheck?.statusSummary).toBe('Not available to you');
    expect(cddCheck?.statusSummary).not.toMatch(/Recorded and valid/i);
  });
});
