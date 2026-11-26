import { describe, expect, it } from 'vitest';
import {
  computeClientRelationshipCdd,
  HIGH_RISK_RATING_IDS,
  isHighOrCriticalRiskRating,
  isMatterConflictCheckAwaitingDecision,
  resolveRiskRatingIdForLevel,
  toClientPriorMatterSummary,
} from '../matterOpeningRecord';
import type { ChoiceValue, Organisation, Person } from '../types';

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

  it('R592: resolveRiskRatingIdForLevel resolves by systemKey even when risk_rating labels are renamed', () => {
    const renamedValues: ChoiceValue[] = [
      {
        id: 'risk_rating.custom_low_id',
        listKey: 'risk_rating',
        label: 'Tier 1 Standard',
        systemKey: 'low',
        sortOrder: 1,
        active: true,
      },
      {
        id: 'risk_rating.custom_high_id',
        listKey: 'risk_rating',
        label: 'Elevated Supervision',
        systemKey: 'high',
        sortOrder: 2,
        active: true,
      },
      {
        id: 'risk_rating.decoy_high_prefix',
        listKey: 'risk_rating',
        label: 'High-volume standard',
        systemKey: 'medium',
        sortOrder: 3,
        active: true,
      },
    ];

    expect(resolveRiskRatingIdForLevel(renamedValues, 'Low')).toBe(
      'risk_rating.custom_low_id',
    );
    expect(resolveRiskRatingIdForLevel(renamedValues, 'High')).toBe(
      'risk_rating.custom_high_id',
    );
  });

  it('R698: computeClientRelationshipCdd derives CDD status from visible prior client matters and client verification', () => {
    const values: ChoiceValue[] = [
      {
        id: 'ver_verified',
        listKey: 'verification_status',
        label: 'Verified',
        sortOrder: 1,
        active: true,
      },
      {
        id: 'ver_pending',
        listKey: 'verification_status',
        label: 'Pending',
        sortOrder: 2,
        active: true,
      },
      {
        id: 'rel_prospect',
        listKey: 'relationship_status',
        label: 'Prospect',
        sortOrder: 1,
        active: true,
      },
    ];
    const orgUnverifiedStatus = {
      id: 'O-R698-1',
      legalName: 'Cambria Logistics Ltd',
      verificationStatusId: 'ver_pending',
      relationshipStatusId: 'rel_prospect',
      reviewDate: '2028-01-01',
    } as unknown as Organisation;
    const personProspect = {
      id: 'P-R698-1',
      firstName: 'Carys',
      lastName: 'Morgan',
      verificationStatusId: 'ver_pending',
      relationshipStatusId: 'rel_prospect',
    } as unknown as Person;

    // 1. No prior non-Draft matters -> New client
    expect(
      computeClientRelationshipCdd({
        clientIds: [orgUnverifiedStatus.id],
        priorMatters: [
          toClientPriorMatterSummary({
            id: 'M-DRAFT',
            clientId: orgUnverifiedStatus.id,
            conflictCheckStatus: 'Draft',
            amlStatus: 'Verified',
          }),
          toClientPriorMatterSummary({
            id: 'M-SELF',
            clientId: orgUnverifiedStatus.id,
            conflictCheckStatus: 'Clear',
            amlStatus: 'Verified',
          }),
        ],
        excludeMatterId: 'M-SELF',
        organisations: [orgUnverifiedStatus],
        people: [],
        values,
        today: '2026-11-24',
      }).option,
    ).toBe('New client');

    // 2. Prior matter with Verified AML (even when org verificationStatusId is Pending
    // and verLabel !== Pending? Wait: if org verificationStatusId was not set/verified, check both cases)
    const orgUnsetStatus = {
      id: 'O-R698-2',
      legalName: 'Severn Metals PLC',
      verificationStatusId: '',
      relationshipStatusId: 'rel_prospect',
      reviewDate: '2028-01-01',
    } as unknown as Organisation;
    const verifiedPriorRes = computeClientRelationshipCdd({
      clientIds: [orgUnsetStatus.id],
      priorMatters: [
        toClientPriorMatterSummary({
          id: 'M-PRIOR-VERIFIED',
          clientId: orgUnsetStatus.id,
          conflictCheckStatus: 'Clear',
          amlStatus: 'Verified',
        }),
      ],
      organisations: [orgUnsetStatus],
      people: [],
      values,
      today: '2026-11-24',
    });
    expect(verifiedPriorRes.option).toBe('Existing, CDD current');
    expect(verifiedPriorRes.summary).toContain('CDD verified');

    // 3. Prior matter with Pending AML -> Existing, CDD needs refresh
    const incompletePriorRes = computeClientRelationshipCdd({
      clientIds: [orgUnsetStatus.id],
      priorMatters: [
        toClientPriorMatterSummary({
          id: 'M-PRIOR-INCOMPLETE',
          clientId: 'O-OTHER',
          additionalClientIds: [orgUnsetStatus.id],
          conflictCheckStatus: 'Clear',
          amlStatus: 'Pending',
        }),
      ],
      organisations: [orgUnsetStatus],
      people: [],
      values,
      today: '2026-11-24',
    });
    expect(incompletePriorRes.option).toBe('Existing, CDD needs refresh');

    // 4. Verified person client with prior matter -> Existing, CDD current
    const personVerified = {
      ...personProspect,
      id: 'P-R698-2',
      verificationStatusId: 'ver_verified',
      verifiedAt: '2026-10-01',
    } as unknown as Person;
    expect(
      computeClientRelationshipCdd({
        clientIds: [personVerified.id],
        priorMatters: [
          toClientPriorMatterSummary({
            id: 'M-P-PRIOR',
            clientId: personVerified.id,
            conflictCheckStatus: 'Clear',
            amlStatus: 'Verified',
          }),
        ],
        organisations: [],
        people: [personVerified],
        values,
        today: '2026-11-24',
      }).option,
    ).toBe('Existing, CDD current');

    // 5. S1-04 live CDD summary takes precedence over stale/incomplete legacy fields, while hidden employee CDD is omitted (R747)
    const liveCddRes = computeClientRelationshipCdd({
      clientIds: [orgUnverifiedStatus.id],
      priorMatters: [
        toClientPriorMatterSummary({
          id: 'M-OLD-PENDING',
          clientId: orgUnverifiedStatus.id,
          conflictCheckStatus: 'Clear',
          amlStatus: 'Pending',
        }),
      ],
      organisations: [orgUnverifiedStatus],
      people: [],
      values,
      today: '2026-11-24',
      cddSummaries: {
        [orgUnverifiedStatus.id]: {
          visible: true,
          subjectType: 'organisation',
          subjectId: orgUnverifiedStatus.id,
          hasRecord: true,
          recordId: 'REG-900001',
          status: 'recorded',
          riskTier: 'standard',
          recordedByName: 'Dafydd Evans',
          recordedAt: '2026-11-20T10:00:00.000Z',
          dueAt: '2029-11-20T10:00:00.000Z',
          isExpired: false,
        },
      },
    });
    expect(liveCddRes.option).toBe('Existing, CDD current');
    expect(liveCddRes.summary).toContain('Recorded manually by Dafydd Evans');

    const overdueLiveCddRes = computeClientRelationshipCdd({
      clientIds: [orgUnsetStatus.id],
      priorMatters: [
        toClientPriorMatterSummary({
          id: 'M-PRIOR-OK',
          clientId: orgUnsetStatus.id,
          conflictCheckStatus: 'Clear',
          amlStatus: 'Verified',
        }),
      ],
      organisations: [orgUnsetStatus],
      people: [],
      values,
      today: '2026-11-24',
      cddSummaries: {
        [orgUnsetStatus.id]: {
          visible: true,
          subjectType: 'organisation',
          subjectId: orgUnsetStatus.id,
          hasRecord: true,
          recordId: 'REG-900002',
          status: 'recorded',
          riskTier: 'high',
          recordedByName: 'Rhian Morgan',
          recordedAt: '2025-11-01T10:00:00.000Z',
          dueAt: '2026-11-01T10:00:00.000Z',
          isExpired: false,
        },
      },
    });
    expect(overdueLiveCddRes.option).toBe('Existing, CDD needs refresh');
    expect(overdueLiveCddRes.summary).toContain('Re-check overdue');

    const hiddenEmpCddRes = computeClientRelationshipCdd({
      clientIds: [personVerified.id],
      priorMatters: [],
      organisations: [],
      people: [personVerified],
      values,
      today: '2026-11-24',
      cddSummaries: {
        [personVerified.id]: {
          visible: false,
          subjectType: 'person',
          subjectId: personVerified.id,
          hasRecord: false,
          recordId: null,
          status: 'not_started',
          riskTier: 'standard',
          recordedByName: null,
          recordedAt: null,
          dueAt: null,
          isExpired: false,
        },
      },
    });
    expect(hiddenEmpCddRes.option).toBe('New client');
    expect(hiddenEmpCddRes.summary).not.toContain('Recorded manually');
  });
});
