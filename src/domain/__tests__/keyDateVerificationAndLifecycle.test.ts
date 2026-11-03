import { describe, expect, it } from 'vitest';
import exampleConfig from '../../../schemas/keyDates.config.example.json';
import type { KeyDatesConfig } from '../keyDates.types';
import type { AuditEntry, Enquiry, Matter, Person, Team } from '../types';
import {
  carryEnquiryKeyDatesToMatter,
  createOrProposeKeyDate,
  evaluateMatterKeyDateClosureGate,
  evaluateMatterKeyDateOpeningGate,
  proposeProvisionalKeyDate,
  reassignKeyDateTeamAndOwners,
  recordKeyDateNotApplicable,
  rejectProposedKeyDate,
  resolveKeyDateOutcome,
  supersedeConfirmedKeyDate,
  verifyProposedKeyDate,
} from '../keyDates';

const config = exampleConfig as unknown as KeyDatesConfig;

const teams: Team[] = [
  {
    id: 'TM-LIT',
    name: 'Dispute Resolution Team',
    description: '',
    practiceAreaIds: [],
    leadIds: ['P-SUP'],
    memberIds: ['P-SUP', 'P-FEE', 'P-PARALEGAL'],
    active: true,
    createdById: 'P-SUP',
    createdAt: '2026-01-01T00:00:00Z',
    updatedById: 'P-SUP',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const feeEarner = {
  id: 'P-FEE',
  firstName: 'Eleanor',
  surname: 'Vance',
  isEmployee: true,
  employeeRoleId: 'emp_role.solicitor',
  appRole: 'fee_earner',
  homeRoles: ['fee_earner'],
  mergedIntoId: null,
} as unknown as Person;

const supervisor = {
  id: 'P-SUP',
  firstName: 'Julian',
  surname: 'Vance-Sterling',
  isEmployee: true,
  employeeRoleId: 'emp_role.partner',
  appRole: 'team_lead',
  homeRoles: ['supervisor'],
  mergedIntoId: null,
} as unknown as Person;

const litMatter = {
  id: 'MAT-000100',
  matterNumber: 'NALF-2026-0100',
  title: 'Pembroke v Sterling Corp',
  clientId: 'P-CLI-1',
  practiceAreaId: 'work_type.dispute_resolution',
  matterTypeId: 'matter_type.litigation',
  owningTeamId: 'TM-LIT',
  responsiblePartnerId: 'P-SUP',
  supervisingPartnerId: 'P-SUP',
  leadFeeEarnerId: 'P-FEE',
  teamMemberIds: ['P-FEE', 'P-SUP'],
  matterStatusId: 'Draft',
  openedAt: '2026-01-15',
  createdAt: '2026-01-15T09:00:00Z',
  updatedAt: '2026-01-15T09:00:00Z',
} as unknown as Matter;

const conveyancingMatter = {
  ...litMatter,
  id: 'MAT-000101',
  matterNumber: 'NALF-2026-0101',
  title: 'Purchase of 14 High Street',
  practiceAreaId: 'work_type.conveyancing',
  matterTypeId: 'matter_type.residential_conveyancing',
} as unknown as Matter;

describe('Key Dates Verification & Lifecycle (§1, §3, §9)', () => {
  it('defaults teamId to the matter owning team and responsiblePersonIds to matter employees', () => {
    const audit: AuditEntry[] = [];
    let seq = 1;
    const kd = createOrProposeKeyDate({
      id: 'KD-000001',
      matter: conveyancingMatter,
      keyDateTypeId: 'completion',
      dueDate: '2026-06-30',
      actor: feeEarner,
      nowIso: '2026-02-01T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });

    expect(kd.teamId).toBe('TM-LIT');
    expect(kd.responsiblePersonIds).toEqual(expect.arrayContaining(['P-FEE', 'P-SUP']));
    expect(kd.responsiblePersonIds.length).toBeGreaterThanOrEqual(2);
    // Residential conveyancing does not require verification -> status is confirmed immediately
    expect(kd.status).toBe('confirmed');
  });

  it('always lands dates with source="document_extraction" as provisional', () => {
    const audit: AuditEntry[] = [];
    const kd = createOrProposeKeyDate({
      id: 'KD-000002',
      matter: conveyancingMatter,
      keyDateTypeId: 'completion',
      dueDate: '2026-06-30',
      source: 'document_extraction',
      intent: 'propose',
      actor: feeEarner,
      nowIso: '2026-02-01T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => 'AUD-1',
    });

    expect(kd.status).toBe('provisional');
  });

  it('enforces two-step verification on litigation critical dates and prevents self-verification', () => {
    const audit: AuditEntry[] = [];
    let seq = 1;

    // 1. Propose a limitation date on a litigation matter (verification required for critical_only)
    const kd = createOrProposeKeyDate({
      id: 'KD-000003',
      matter: litMatter,
      keyDateTypeId: 'limitation',
      dueDate: '2032-01-15',
      actor: supervisor, // Supervisor proposes the date
      nowIso: '2026-02-01T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });

    expect(kd.status).toBe('awaiting_verification');
    expect(kd.verification.required).toBe(true);
    expect(kd.verification.proposedById).toBe(supervisor.id);

    // 2. Proposer (even holding keydate:verify) can NEVER verify their own date
    expect(() =>
      verifyProposedKeyDate({
        keyDate: kd,
        verifier: supervisor,
        nowIso: '2026-02-01T11:00:00Z',
        config,
        teams,
        people: [feeEarner, supervisor],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/proposer of a key date cannot verify their own date/i);

    // 3. Fee earner without keydate:verify cannot verify
    expect(() =>
      verifyProposedKeyDate({
        keyDate: kd,
        verifier: feeEarner,
        nowIso: '2026-02-01T11:05:00Z',
        config,
        teams,
        people: [feeEarner, supervisor],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/do not have permission/i);

    // 4. Another verifier can reject with a reason (reason required)
    const secondSupervisor = {
      ...supervisor,
      id: 'P-SUP-2',
    } as unknown as Person;
    expect(() =>
      rejectProposedKeyDate({
        keyDate: kd,
        verifier: secondSupervisor,
        reason: '   ',
        nowIso: '2026-02-01T11:10:00Z',
        config,
        teams,
        people: [feeEarner, supervisor, secondSupervisor],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/reason is required/i);

    const rejected = rejectProposedKeyDate({
      keyDate: kd,
      verifier: secondSupervisor,
      reason: 'Date of knowledge trigger should be checked against expert report.',
      nowIso: '2026-02-01T11:15:00Z',
      config,
      teams,
      people: [feeEarner, supervisor, secondSupervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });
    expect(rejected.status).toBe('provisional');
    expect(rejected.verification.rejectionReason).toContain('expert report');

    // 5. Re-propose by fee earner and verify by supervisor
    proposeProvisionalKeyDate({
      keyDate: kd,
      actor: feeEarner,
      nowIso: '2026-02-01T12:00:00Z',
      config,
      matter: litMatter,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });
    expect(kd.status).toBe('awaiting_verification');

    const verified = verifyProposedKeyDate({
      keyDate: kd,
      verifier: supervisor,
      nowIso: '2026-02-01T12:30:00Z',
      config,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });
    expect(verified.status).toBe('confirmed');
    expect(verified.verification.verifiedById).toBe(supervisor.id);
    expect(audit.some((a) => a.action === 'keydate-verify')).toBe(true);
  });

  it('requires verification for dates calculated from an unreviewed rule set even if matter type does not require it', () => {
    const audit: AuditEntry[] = [];
    const kd = createOrProposeKeyDate({
      id: 'KD-UNREV',
      matter: conveyancingMatter, // residential_conveyancing has verification.required = false
      keyDateTypeId: 'completion',
      dueDate: '2028-05-01',
      calculation: {
        ruleSetId: 'ew-sample',
        ruleSetVersion: 1,
        ruleSetReviewStatus: 'unreviewed',
        ruleId: 'contract-simple',
        triggers: { accrualDate: '2022-05-01' },
        calculatedDate: '2028-05-01',
        explanation: ['Unreviewed test rule'],
        overridden: false,
      },
      actor: feeEarner,
      nowIso: '2026-02-01T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => 'AUD-UNREV',
    });

    expect(kd.verification.required).toBe(true);
    expect(kd.status).toBe('awaiting_verification');
  });

  it('never deletes confirmed dates: editing creates a superseding date with a reason and links both records', () => {
    const audit: AuditEntry[] = [];
    let seq = 1;

    const original = createOrProposeKeyDate({
      id: 'KD-ORIG',
      matter: conveyancingMatter,
      keyDateTypeId: 'completion',
      dueDate: '2026-06-30',
      actor: feeEarner,
      nowIso: '2026-02-01T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });
    expect(original.status).toBe('confirmed');

    // Supersede requires a reason
    expect(() =>
      supersedeConfirmedKeyDate({
        existingKeyDate: original,
        newKeyDateId: 'KD-NEW',
        updates: { dueDate: '2026-07-15' },
        reason: '',
        actor: feeEarner,
        nowIso: '2026-02-10T10:00:00Z',
        config,
        matter: conveyancingMatter,
        teams,
        people: [feeEarner, supervisor],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/reason is required/i);

    const { supersededKeyDate, replacementKeyDate } = supersedeConfirmedKeyDate({
      existingKeyDate: original,
      newKeyDateId: 'KD-NEW',
      updates: { dueDate: '2026-07-15', notes: 'Completion moved by agreement' },
      reason: 'Completion deferred by supplemental agreement.',
      actor: feeEarner,
      nowIso: '2026-02-10T10:00:00Z',
      config,
      matter: conveyancingMatter,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });

    expect(supersededKeyDate.id).toBe('KD-ORIG');
    expect(supersededKeyDate.status).toBe('superseded');
    expect(supersededKeyDate.supersededByKeyDateId).toBe('KD-NEW');
    expect(replacementKeyDate.id).toBe('KD-NEW');
    expect(replacementKeyDate.supersedesKeyDateId).toBe('KD-ORIG');
    expect(replacementKeyDate.dueDate).toBe('2026-07-15');
    expect(audit.some((a) => a.action === 'keydate-supersede' && a.reason?.includes('supplemental'))).toBe(true);
  });

  it('enforces permissions and required notes when resolving as met, missed, or waived', () => {
    const audit: AuditEntry[] = [];
    let seq = 1;

    const kd1 = createOrProposeKeyDate({
      id: 'KD-RES-1',
      matter: conveyancingMatter,
      keyDateTypeId: 'completion',
      dueDate: '2026-06-30',
      actor: feeEarner,
      nowIso: '2026-02-01T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });

    // Fee earner cannot waive (requires keydate:waive)
    expect(() =>
      resolveKeyDateOutcome({
        keyDate: kd1,
        kind: 'waived',
        note: 'Client instructed not to proceed.',
        actor: feeEarner,
        nowIso: '2026-03-01T10:00:00Z',
        config,
        teams,
        people: [feeEarner, supervisor],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/keydate:waive/i);

    // Supervisor can waive, but requires a note
    expect(() =>
      resolveKeyDateOutcome({
        keyDate: kd1,
        kind: 'waived',
        note: '   ',
        actor: supervisor,
        nowIso: '2026-03-01T10:00:00Z',
        config,
        teams,
        people: [feeEarner, supervisor],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/reason\/outcome note is required/i);

    const waived = resolveKeyDateOutcome({
      keyDate: kd1,
      kind: 'waived',
      note: 'Transaction aborted prior to exchange.',
      actor: supervisor,
      nowIso: '2026-03-01T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });
    expect(waived.status).toBe('waived');
    expect(waived.outcome?.kind).toBe('waived');
    expect( audit.some((a) => a.action === 'keydate-waive')).toBe(true);
  });

  it('carries enquiry key dates onto the converted matter with source="carried_from_enquiry"', () => {
    const audit: AuditEntry[] = [];
    let seq = 1;
    const enquiry = {
      id: 'ENQ-000010',
      reference: 'ENQ-000010',
      summary: 'Potential Breach of Contract Claim',
      practiceAreaId: 'matter_type.litigation',
      assignedTeamId: 'TM-LIT',
      assignedToId: 'P-FEE',
      createdAt: '2026-01-10T09:00:00Z',
      updatedAt: '2026-01-10T09:00:00Z',
    } as unknown as Enquiry;

    const enqKd = createOrProposeKeyDate({
      id: 'KD-ENQ-1',
      enquiry,
      keyDateTypeId: 'limitation',
      dueDate: '2026-09-01',
      intent: 'provisional',
      actor: feeEarner,
      nowIso: '2026-01-10T09:30:00Z',
      config,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });

    const keyDates = [enqKd];
    const carried = carryEnquiryKeyDatesToMatter({
      enquiry,
      matter: litMatter,
      keyDates,
      teams,
      config,
      actorId: feeEarner.id,
      nowIso: '2026-01-15T09:00:00Z',
      nextKeyDateId: () => 'KD-CARRIED',
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });

    expect(carried).toHaveLength(1);
    expect(enqKd.matterId).toBe(litMatter.id);
    expect(enqKd.enquiryId).toBeUndefined();
    expect(enqKd.source).toBe('carried_from_enquiry');
    expect(enqKd.responsiblePersonIds).toEqual(expect.arrayContaining(['P-FEE', 'P-SUP']));
  });

  it('enforces the matter opening gate (requiredKeyDateTypeIds + KeyDateNotApplicable) and closure gate (blockClosureWithOpenDates)', () => {
    const audit: AuditEntry[] = [];
    let seq = 1;
    const notApplicableList: ReturnType<typeof recordKeyDateNotApplicable>[] = [];

    // Litigation requires ['limitation']
    const gateBefore = evaluateMatterKeyDateOpeningGate(
      config,
      litMatter.matterTypeId,
      [],
      notApplicableList,
    );
    expect(gateBefore.canOpen).toBe(false);
    expect(gateBefore.missingKeyDateTypes.map((m) => m.id)).toContain('limitation');

    // Recording limitation as not applicable with a reason satisfies the opening gate for litigation
    recordKeyDateNotApplicable({
      matterId: litMatter.id,
      matterTypeId: litMatter.matterTypeId,
      keyDateTypeId: 'limitation',
      reason: 'Declaratory relief sought with no statutory limitation period.',
      actor: feeEarner,
      nowIso: '2026-02-01T10:00:00Z',
      config,
      notApplicableList,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });

    const gateAfterNA = evaluateMatterKeyDateOpeningGate(
      config,
      litMatter.matterTypeId,
      [],
      notApplicableList,
    );
    expect(gateAfterNA.canOpen).toBe(true);

    // Matter type with allowNotApplicable = false -> recording not applicable is rejected
    const strictPiConfig: KeyDatesConfig = {
      ...config,
      matterTypes: (config.matterTypes ?? []).map((mt) =>
        mt.matterTypeId === 'matter_type.personal_injury'
          ? { ...mt, allowNotApplicable: false }
          : mt,
      ),
    };
    expect(() =>
      recordKeyDateNotApplicable({
        matterId: 'MAT-PI',
        matterTypeId: 'matter_type.personal_injury',
        keyDateTypeId: 'limitation',
        reason: 'Trying to skip limitation on PI',
        actor: feeEarner,
        nowIso: '2026-02-01T10:00:00Z',
        config: strictPiConfig,
        notApplicableList,
        teams,
        people: [feeEarner, supervisor],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/does not allow marking required key dates as not applicable/i);

    // Closure gate: blocks closure while any key date is provisional, awaiting_verification, or confirmed
    const openKd = createOrProposeKeyDate({
      id: 'KD-OPEN',
      matter: litMatter,
      keyDateTypeId: 'court_hearing',
      dueDate: '2026-10-01',
      actor: feeEarner,
      nowIso: '2026-02-01T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });

    const closeBlocked = evaluateMatterKeyDateClosureGate(
      config,
      litMatter.matterTypeId,
      [openKd],
    );
    expect(closeBlocked.canClose).toBe(false);
    expect(closeBlocked.openKeyDates).toHaveLength(1);

    // Once resolved as met, closure is allowed
    resolveKeyDateOutcome({
      keyDate: openKd,
      kind: 'met',
      note: 'Hearing attended and order made.',
      actor: feeEarner,
      nowIso: '2026-10-01T16:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });

    const closeAllowed = evaluateMatterKeyDateClosureGate(
      config,
      litMatter.matterTypeId,
      [openKd],
    );
    expect(closeAllowed.canClose).toBe(true);
  });

  it('recalculates limitation dates server-side from tenant config, ignores forged ruleSetReviewStatus, rejects fee earner overrides, and audits partner overrides (R28)', () => {
    const audit: AuditEntry[] = [];
    let seq = 1;
    const partner = {
      ...supervisor,
      id: 'P-PARTNER-1',
      appRole: 'partner',
      homeRoles: ['partner'],
    } as unknown as Person;

    // 1. Forged ruleSetReviewStatus: 'reviewed' on unreviewed ruleSet 'ew-sample' still lands as awaiting_verification
    const kdForgedStatus = createOrProposeKeyDate({
      id: 'KD-FORGED-REV',
      matter: conveyancingMatter, // residential_conveyancing has verification.required = false
      keyDateTypeId: 'completion',
      dueDate: '2028-05-01', // 2022-05-01 + 6y = 2028-05-01
      calculation: {
        ruleSetId: 'ew-sample',
        ruleSetVersion: 1,
        ruleSetReviewStatus: 'reviewed', // Forged by client! Config says 'unreviewed'
        ruleId: 'contract-simple',
        triggers: { accrualDate: '2022-05-01' },
        calculatedDate: '2028-05-01',
        explanation: ['Client supplied'],
        overridden: false,
      },
      actor: feeEarner,
      nowIso: '2026-02-01T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor, partner],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });
    expect(kdForgedStatus.calculation?.ruleSetReviewStatus).toBe('unreviewed');
    expect(kdForgedStatus.status).toBe('awaiting_verification');

    // 2. Fee earner posting a different dueDate than calculatedDate is rejected
    expect(() =>
      createOrProposeKeyDate({
        id: 'KD-FE-OVERRIDE',
        matter: litMatter,
        keyDateTypeId: 'limitation',
        dueDate: '2029-01-01', // Differs from calculated 2028-05-01
        calculation: {
          ruleSetId: 'ew-sample',
          ruleSetVersion: 1,
          ruleSetReviewStatus: 'unreviewed',
          ruleId: 'contract-simple',
          triggers: { accrualDate: '2022-05-01' },
          calculatedDate: '2029-01-01', // Even if client lies about calculatedDate!
          explanation: [],
          overridden: false,
        },
        actor: feeEarner,
        nowIso: '2026-02-01T10:00:00Z',
        config,
        teams,
        people: [feeEarner, supervisor, partner],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/KEY_DATE_PERMISSION_ERROR/);

    // 3. Partner override with reason succeeds and writes keydate-override-calculation audit entry
    const partnerOverrideKd = createOrProposeKeyDate({
      id: 'KD-PARTNER-OVERRIDE',
      matter: litMatter,
      keyDateTypeId: 'limitation',
      dueDate: '2028-04-15',
      calculation: {
        ruleSetId: 'ew-sample',
        ruleSetVersion: 1,
        ruleSetReviewStatus: 'unreviewed',
        ruleId: 'contract-simple',
        triggers: { accrualDate: '2022-05-01' },
        calculatedDate: '2028-05-01',
        explanation: [],
        overridden: false, // Even if client omits overridden: true, server detects dueDate !== calculatedDate
        overrideReason: 'Earlier contractual standstill expiry agreed by counsel.',
      },
      actor: partner,
      nowIso: '2026-02-01T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor, partner],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });
    expect(partnerOverrideKd.calculation?.overridden).toBe(true);
    expect(
      audit.some(
        (a) =>
          a.action === 'keydate-override-calculation' &&
          a.recordId === 'KD-PARTNER-OVERRIDE',
      ),
    ).toBe(true);

    // 4. Creating with a forged unknown ruleSetId / ruleId and 'reviewed' is rejected with KEY_DATE_VALIDATION_ERROR
    expect(() =>
      createOrProposeKeyDate({
        id: 'KD-FORGED-UNKNOWN-RULE',
        matter: conveyancingMatter,
        keyDateTypeId: 'completion',
        dueDate: '2028-05-01',
        calculation: {
          ruleSetId: 'forged-unknown-ruleset',
          ruleSetVersion: 1,
          ruleSetReviewStatus: 'reviewed',
          ruleId: 'forged-unknown-rule',
          triggers: { accrualDate: '2022-05-01' },
          calculatedDate: '2028-05-01',
          explanation: ['Forged rule'],
          overridden: false,
        },
        actor: feeEarner,
        nowIso: '2026-02-01T10:00:00Z',
        config,
        teams,
        people: [feeEarner, supervisor, partner],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/KEY_DATE_VALIDATION_ERROR/);

    // 5. Fee earner superseding a calculated date to a different dueDate with no calculation supplied is rejected
    verifyProposedKeyDate({
      keyDate: kdForgedStatus,
      verifier: supervisor,
      nowIso: '2026-02-02T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor, partner],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });
    expect(kdForgedStatus.status).toBe('confirmed');

    expect(() =>
      supersedeConfirmedKeyDate({
        existingKeyDate: kdForgedStatus,
        newKeyDateId: 'KD-SUPERSEDED-BY-FE',
        updates: {
          dueDate: '2030-01-01', // Different from calculated 2028-05-01, with no updates.calculation supplied
        },
        reason: 'Trying to move calculated limitation date without override permission.',
        actor: feeEarner,
        nowIso: '2026-02-03T10:00:00Z',
        config,
        matter: conveyancingMatter,
        teams,
        people: [feeEarner, supervisor, partner],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/KEY_DATE_PERMISSION_ERROR/);
    expect(kdForgedStatus.status).toBe('confirmed');

    // Partner superseding a calculated date to a different dueDate with no calculation carries the calculation forward and writes keydate-override-calculation audit entry
    const { replacementKeyDate: partnerSupersededCalc } = supersedeConfirmedKeyDate({
      existingKeyDate: kdForgedStatus,
      newKeyDateId: 'KD-SUPERSEDED-BY-PARTNER',
      updates: {
        dueDate: '2028-06-15',
      },
      reason: 'Standstill agreement extended limitation by 45 days.',
      actor: partner,
      nowIso: '2026-02-03T11:00:00Z',
      config,
      matter: conveyancingMatter,
      teams,
      people: [feeEarner, supervisor, partner],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });
    expect(partnerSupersededCalc.calculation?.overridden).toBe(true);
    expect(partnerSupersededCalc.calculation?.calculatedDate).toBe('2028-05-01');
    expect(
      audit.some(
        (a) =>
          a.action === 'keydate-override-calculation' &&
          a.recordId === 'KD-SUPERSEDED-BY-PARTNER',
      ),
    ).toBe(true);

    // 6. R98: Matching only on (ruleSetId, ruleId) pair — supplying a valid ruleId with a mismatched ruleSetId is rejected with KEY_DATE_VALIDATION_ERROR
    expect(() =>
      createOrProposeKeyDate({
        id: 'KD-MISMATCHED-RULESET-PAIR',
        matter: conveyancingMatter,
        keyDateTypeId: 'completion',
        dueDate: '2028-05-01',
        calculation: {
          ruleSetId: 'mismatched-ruleset-id',
          ruleSetVersion: 1,
          ruleSetReviewStatus: 'reviewed',
          ruleId: 'contract-simple',
          triggers: { accrualDate: '2022-05-01' },
          calculatedDate: '2028-05-01',
          explanation: ['Mismatched ruleSetId with valid ruleId'],
          overridden: false,
        },
        actor: feeEarner,
        nowIso: '2026-02-04T10:00:00Z',
        config,
        teams,
        people: [feeEarner, supervisor, partner],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/KEY_DATE_VALIDATION_ERROR/);

    // 7. R94: When a confirmed calculated key date's rule set is later removed from config, superseding without a new calculation requires keydate:override_calculation, converts replacement to manual, and writes a keydate-override-calculation audit entry
    const kdForRemovedRuleSet = createOrProposeKeyDate({
      id: 'KD-CALC-REMOVED-RULESET',
      matter: conveyancingMatter,
      keyDateTypeId: 'completion',
      dueDate: '2028-05-01',
      calculation: {
        ruleSetId: 'ew-sample',
        ruleSetVersion: 1,
        ruleSetReviewStatus: 'reviewed',
        ruleId: 'contract-simple',
        triggers: { accrualDate: '2022-05-01' },
        calculatedDate: '2028-05-01',
        explanation: ['6 years from accrual'],
        overridden: false,
      },
      actor: feeEarner,
      nowIso: '2026-02-04T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor, partner],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });
    verifyProposedKeyDate({
      keyDate: kdForRemovedRuleSet,
      verifier: supervisor,
      nowIso: '2026-02-04T11:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor, partner],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });
    const configWithRuleSetRemoved = {
      ...config,
      limitationRuleSets: [],
    };

    expect(() =>
      supersedeConfirmedKeyDate({
        existingKeyDate: kdForRemovedRuleSet,
        newKeyDateId: 'KD-REMOVED-RULESET-FE',
        updates: {
          dueDate: '2028-05-01',
          title: 'Fee earner trying to supersede after rule set removed',
        },
        reason: 'Rule set removed from config',
        actor: feeEarner,
        nowIso: '2026-02-05T10:00:00Z',
        config: configWithRuleSetRemoved,
        matter: conveyancingMatter,
        teams,
        people: [feeEarner, supervisor, partner],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/KEY_DATE_PERMISSION_ERROR/);
    expect(kdForRemovedRuleSet.status).toBe('confirmed');

    const { replacementKeyDate: partnerReplacedAfterRuleRemoved } =
      supersedeConfirmedKeyDate({
        existingKeyDate: kdForRemovedRuleSet,
        newKeyDateId: 'KD-REMOVED-RULESET-PARTNER',
        updates: {
          dueDate: '2028-07-01',
        },
        reason: 'Rule set retired; partner overriding to manual date.',
        actor: partner,
        nowIso: '2026-02-05T11:00:00Z',
        config: configWithRuleSetRemoved,
        matter: conveyancingMatter,
        teams,
        people: [feeEarner, supervisor, partner],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      });
    expect(partnerReplacedAfterRuleRemoved.source).toBe('manual');
    expect(partnerReplacedAfterRuleRemoved.calculation).toBeUndefined();
    expect(
      audit.some(
        (a) =>
          a.action === 'keydate-override-calculation' &&
          a.recordId === 'KD-REMOVED-RULESET-PARTNER',
      ),
    ).toBe(true);
  });

  it('rejects forged/inactive teams and non-employee responsiblePersonIds on create and reassign (R38, R44)', () => {
    const audit: AuditEntry[] = [];
    let seq = 1;

    // R44: No active teams throws KEY_DATE_VALIDATION_ERROR
    expect(() =>
      createOrProposeKeyDate({
        id: 'KD-NO-TEAMS',
        matter: { ...conveyancingMatter, owningTeamId: undefined } as unknown as Matter,
        keyDateTypeId: 'completion',
        dueDate: '2026-06-30',
        actor: feeEarner,
        nowIso: '2026-02-01T10:00:00Z',
        config,
        teams: [{ ...teams[0]!, active: false }],
        people: [feeEarner, supervisor],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/KEY_DATE_VALIDATION_ERROR/);

    const validKd = createOrProposeKeyDate({
      id: 'KD-VALID-REASSIGN',
      matter: conveyancingMatter,
      keyDateTypeId: 'completion',
      dueDate: '2026-06-30',
      actor: feeEarner,
      nowIso: '2026-02-01T10:00:00Z',
      config,
      teams,
      people: [feeEarner, supervisor],
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });

    // R38: Reassigning to TM-FORGED or P-FORGED throws KEY_DATE_VALIDATION_ERROR and leaves record unchanged
    expect(() =>
      reassignKeyDateTeamAndOwners({
        keyDate: validKd,
        teamId: 'TM-FORGED',
        actor: supervisor,
        nowIso: '2026-02-02T10:00:00Z',
        config,
        teams,
        people: [feeEarner, supervisor],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/KEY_DATE_VALIDATION_ERROR/);
    expect(validKd.teamId).toBe('TM-LIT');

    expect(() =>
      reassignKeyDateTeamAndOwners({
        keyDate: validKd,
        teamId: 'TM-LIT',
        responsiblePersonIds: ['P-FORGED'],
        actor: supervisor,
        nowIso: '2026-02-02T10:00:00Z',
        config,
        teams,
        people: [feeEarner, supervisor],
        audit,
        nextAuditId: () => `AUD-${seq++}`,
      }),
    ).toThrow(/KEY_DATE_VALIDATION_ERROR/);
    expect(validKd.responsiblePersonIds).toEqual(
      expect.arrayContaining(['P-FEE', 'P-SUP']),
    );
  });
});
