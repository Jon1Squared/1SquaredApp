import { describe, expect, it } from 'vitest';
import {
  evaluateOpeningPreconditions,
  formatOpeningGateActionError,
} from '../openingGate';

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

  it('R784: formatOpeningGateActionError strips colon-separated permission keys and engine diagnostics into plain British English', () => {
    const cases = [
      {
        code: 'FORBIDDEN',
        message:
          "[FORBIDDEN] Permission 'matter:opening_gate:override' is required to overrideMatterOpeningPreconditionAction.",
      },
      {
        code: 'REGISTER_APPROVER_MISMATCH',
        message:
          'Actor roles [admin] do not satisfy allowedRoles for transition "partner_approve" on "high_risk_opening".',
      },
      {
        code: 'REGISTER_DISTINCT_APPROVER_REQUIRED',
        message: 'Transition "compliance_approve" requires a different approver.',
      },
      {
        code: 'MATTER_CONCURRENCY_CONFLICT',
        message: 'Raw conflict',
      },
      {
        message: 'You do not have permission (matter:edit) to continue.',
      },
    ];

    for (const input of cases) {
      const formatted = formatOpeningGateActionError(input);
      expect(formatted.length).toBeGreaterThan(0);
      expect(formatted).not.toMatch(/[a-z_]+:[a-z_:]+/);
      expect(formatted).not.toMatch(/allowedRoles/i);
    }
  });
});
