import { describe, expect, it } from 'vitest';
import {
  evaluateOpeningPreconditions,
  formatOpeningGateActionError,
} from '../openingGate';
import {
  clearWorkTypeOpeningGateSetting,
  DEFAULT_WORK_TYPES_CONFIG,
  resolveInheritedOpeningGateSetting,
} from '../workTypeConfig';

describe('openingGate domain logic (R761, R763, R785, R793, R794, R796, R798, S10)', () => {
  it('R785 & R796: checks cddMasked before cddRawSatisfied, emits rawSatisfied=null, canOverride=false, neutral blocking text, and displays a neutral summary when viewer cannot see CDD', () => {
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
        allowConflictOverride: true,
        requireCddComplete: true,
        allowCddOverride: true,
        requireEngagementSigned: false,
        requireFundsOnAccount: false,
      },
      cddStatus: {
        status: 'not_started',
        isExpired: false,
        visibleToViewer: false,
      },
      activeOverrides: [
        {
          id: 'OVR-1',
          preconditionKey: 'cdd_complete',
          reason: 'Should not leak when CDD is masked',
          overriddenByPersonId: 'P-000001',
          overriddenByName: 'Rhian Morgan',
          overriddenAt: '2026-11-26T00:00:00.000Z',
        },
      ],
      requiresHighRiskApproval: false,
    });

    const cddCheck = evalMasked.preconditions.find((p) => p.key === 'cdd_complete');
    expect(cddCheck).toBeDefined();
    expect(cddCheck?.rawSatisfied).toBeNull();
    expect(cddCheck?.canOverride).toBe(false);
    expect(cddCheck?.overridden).toBe(false);
    expect(cddCheck?.activeOverride).toBeNull();
    expect(cddCheck?.statusSummary).toBe('Not available to you');
    expect(cddCheck?.statusSummary).not.toMatch(/Recorded and valid/i);
    expect(evalMasked.canOpen).toBe(true);
    expect(evalMasked.activeOverrides).toEqual([]);
  });

  it('R793, R794 & Suggestion 10: blocks HRO compliance approver matching lead/responsible, blocks conflict override when allowConflictOverride=false, and drops legacy conflictCheckStatus Clear fallback', () => {
    const blockedByHroAndConflictPolicy = evaluateOpeningPreconditions({
      matter: {
        conflictCheckRecord: undefined,
        conflictCheckStatus: 'Clear',
        engagementLetterStatus: 'Signed',
        engagementLetterSignedAt: '2026-11-26T00:00:00.000Z',
        retainerMoniesOnAccountGbp: null,
        riskRatingId: 'risk_rating.high',
        leadFeeEarnerId: 'P-000002',
        responsiblePartnerId: 'P-000005',
      },
      gateConfig: {
        allowConflictOverride: false,
        requireCddComplete: false,
        allowCddOverride: true,
        requireEngagementSigned: true,
        requireFundsOnAccount: false,
      },
      cddStatus: {
        status: 'recorded',
        isExpired: false,
        visibleToViewer: true,
      },
      activeOverrides: [
        {
          id: 'OVR-CONFLICT',
          preconditionKey: 'conflict_cleared',
          reason: 'Should be ignored when allowConflictOverride is false',
          overriddenByPersonId: 'P-000001',
          overriddenByName: 'Rhian Morgan',
          overriddenAt: '2026-11-26T00:00:00.000Z',
        },
      ],
      highRiskRecord: {
        id: 'REG-1',
        reference: 'HRO-0001',
        status: 'approved',
        decidedById: 'P-000005',
        decidedAt: '2026-11-26T00:00:00.000Z',
      },
      highRiskPartnerApprover: {
        actorId: 'P-000001',
        actorName: 'Rhian Morgan',
        transitionedAt: '2026-11-26T00:00:00.000Z',
      },
      requiresHighRiskApproval: true,
    });

    const conflictCheck = blockedByHroAndConflictPolicy.preconditions.find(
      (p) => p.key === 'conflict_cleared',
    );
    expect(conflictCheck?.rawSatisfied).toBe(false);
    expect(conflictCheck?.statusSummary).toMatch(/Not cleared \(Not started\)/);
    expect(conflictCheck?.canOverride).toBe(false);
    expect(conflictCheck?.satisfied).toBe(false);
    expect(blockedByHroAndConflictPolicy.highRisk.satisfied).toBe(false);
    expect(blockedByHroAndConflictPolicy.canOpen).toBe(false);
  });

  it('R798: clearWorkTypeOpeningGateSetting removes a single overridden setting while preserving others and resolves inherited preview', () => {
    const afterOneCleared = clearWorkTypeOpeningGateSetting(
      { requireCddComplete: true, allowConflictOverride: false },
      'allowConflictOverride',
    );
    expect(afterOneCleared).toEqual({ requireCddComplete: true });

    const afterLastCleared = clearWorkTypeOpeningGateSetting(
      afterOneCleared,
      'requireCddComplete',
    );
    expect(afterLastCleared).toBeUndefined();

    const inherited = resolveInheritedOpeningGateSetting(
      {
        ...DEFAULT_WORK_TYPES_CONFIG,
        defaults: {
          ...DEFAULT_WORK_TYPES_CONFIG.defaults,
          openingGate: { allowConflictOverride: false },
        },
        items: [
          {
            workTypeId: 'work_type.corporate_and_commercial',
            openingGate: { requireCddComplete: true },
          },
        ],
      },
      { practiceAreaId: 'work_type.corporate_and_commercial' },
      'requireCddComplete',
    );
    expect(inherited).toEqual({ value: true, source: 'practice_area' });
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
