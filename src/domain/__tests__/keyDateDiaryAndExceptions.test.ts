import { describe, expect, it } from 'vitest';
import exampleConfig from '../../../schemas/keyDates.config.example.json';
import type {
  KeyDate,
  KeyDateCalendarSync,
  KeyDateExceptionKind,
  KeyDateReminderState,
  KeyDatesConfig,
} from '../keyDates.types';
import type { Matter, Person, Team } from '../types';
import {
  computeKeyDateExceptions,
  queryTeamDiaryEntries,
} from '../keyDateDiary';
import { canUserAccessMatter } from '@/server/rbacRuntime';
import { canViewerAccessMatterKeyDates } from '../keyDates';
import {
  exportKeyDateExceptionsReportRecord,
  getAppSnapshot,
  getKeyDateExceptionsReportRecord,
  verifyProposedKeyDateRecord,
} from '@/server/services';
import { getStore, resetStore } from '@/server/store';
import {
  auditEntriesForRecord,
  getKeyDateRepository,
  markAuditPosition,
  testTenantCtx,
} from '@/server/testSupport/auditTestSupport';

const config = exampleConfig as unknown as KeyDatesConfig;

const teams: Team[] = [
  {
    id: 'TM-LIT',
    name: 'Dispute Resolution Team',
    description: '',
    practiceAreaIds: [],
    leadIds: ['P-LEAD-LIT'],
    memberIds: ['P-LEAD-LIT', 'P-FEE-LIT'],
    active: true,
    createdById: 'P-LEAD-LIT',
    createdAt: '2026-01-01T00:00:00Z',
    updatedById: 'P-LEAD-LIT',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'TM-PROP',
    name: 'Property Team',
    description: '',
    practiceAreaIds: [],
    leadIds: ['P-LEAD-PROP'],
    memberIds: ['P-LEAD-PROP', 'P-FEE-PROP'],
    active: true,
    createdById: 'P-LEAD-PROP',
    createdAt: '2026-01-01T00:00:00Z',
    updatedById: 'P-LEAD-PROP',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const litFeeEarner = {
  id: 'P-FEE-LIT',
  firstName: 'Eleanor',
  surname: 'Vance',
  isEmployee: true,
  employeeRoleId: 'emp_role.solicitor',
  appRole: 'fee_earner',
  homeRoles: ['fee_earner'],
  mergedIntoId: null,
} as unknown as Person;

const riskComplianceUser = {
  id: 'P-RISK',
  firstName: 'Clara',
  surname: 'Pembroke',
  isEmployee: true,
  employeeRoleId: 'emp_role.risk_compliance',
  homeRoles: ['risk_compliance'],
  mergedIntoId: null,
} as unknown as Person;

const authorisedStaffViewer = {
  id: 'P-AUTH-RISK',
  firstName: 'Arthur',
  surname: 'Sterling',
  isEmployee: true,
  employeeRoleId: 'emp_role.managing_partner',
  homeRoles: ['managing_partner'],
  mergedIntoId: null,
} as unknown as Person;

const people = [litFeeEarner, riskComplianceUser, authorisedStaffViewer];

describe('Team Diary & Compliance Exceptions (§5, §6)', () => {
  it('scopes regular users to their own teams by default and allows keydate:view_any_team users to select multiple teams', () => {
    const kdLit: KeyDate = {
      id: 'KD-LIT-1',
      matterId: 'MAT-LIT-1',
      keyDateTypeId: 'limitation',
      category: 'limitation',
      title: 'Litigation Limitation',
      dueDate: '2026-06-15',
      isCritical: true,
      status: 'confirmed',
      source: 'calculated',
      teamId: 'TM-LIT',
      responsiblePersonIds: ['P-FEE-LIT'],
      verification: { required: true },
      createdById: 'P-FEE-LIT',
      createdAt: '2026-01-01T00:00:00Z',
      updatedById: 'P-FEE-LIT',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 1,
    };

    const kdProp: KeyDate = {
      ...kdLit,
      id: 'KD-PROP-1',
      matterId: 'MAT-PROP-1',
      keyDateTypeId: 'completion',
      category: 'contractual',
      title: 'Property Completion',
      dueDate: '2026-06-20',
      isCritical: true,
      status: 'awaiting_verification',
      teamId: 'TM-PROP',
    };

    const mattersForDiary: Matter[] = [
      {
        id: 'MAT-LIT-1',
        reference: 'NALF-LIT-1',
        title: 'Litigation Matter',
        isStaffMatter: false,
      } as unknown as Matter,
      {
        id: 'MAT-PROP-1',
        reference: 'NALF-PROP-1',
        title: 'Property Matter',
        isStaffMatter: false,
      } as unknown as Matter,
    ];

    // Regular fee earner in TM-LIT only sees TM-LIT even if requesting TM-PROP
    const feeEarnerDefault = queryTeamDiaryEntries({
      viewer: litFeeEarner,
      query: { from: '2026-06-01', to: '2026-06-30' },
      todayIso: '2026-06-01',
      config,
      keyDates: [kdLit, kdProp],
      matters: mattersForDiary,
      teams,
      people,
    });
    expect(feeEarnerDefault.map((e) => e.keyDateId)).toEqual(['KD-LIT-1']);

    const feeEarnerRequestOther = queryTeamDiaryEntries({
      viewer: litFeeEarner,
      query: { teamIds: ['TM-PROP'], from: '2026-06-01', to: '2026-06-30' },
      todayIso: '2026-06-01',
      config,
      keyDates: [kdLit, kdProp],
      matters: mattersForDiary,
      teams,
      people,
    });
    expect(feeEarnerRequestOther).toHaveLength(0);

    // Risk & compliance user (keydate:view_any_team) sees both teams when selecting multiple teams
    const complianceBoth = queryTeamDiaryEntries({
      viewer: riskComplianceUser,
      query: {
        teamIds: ['TM-LIT', 'TM-PROP'],
        from: '2026-06-01',
        to: '2026-06-30',
      },
      todayIso: '2026-06-01',
      config,
      keyDates: [kdLit, kdProp],
      matters: mattersForDiary,
      teams,
      people,
    });
    expect(complianceBoth.map((e) => e.keyDateId)).toEqual([
      'KD-LIT-1',
      'KD-PROP-1',
    ]);

    // Filter awaitingVerificationOnly
    const awaitingOnly = queryTeamDiaryEntries({
      viewer: riskComplianceUser,
      query: {
        from: '2026-06-01',
        to: '2026-06-30',
        awaitingVerificationOnly: true,
      },
      todayIso: '2026-06-01',
      config,
      keyDates: [kdLit, kdProp],
      matters: mattersForDiary,
      teams,
      people,
    });
    expect(awaitingOnly.map((e) => e.keyDateId)).toEqual(['KD-PROP-1']);
  });

  it('omits restricted (staff) matters completely in the data layer unless viewer is in matter.restrictedAccessUserIds', () => {
    const staffMatter: Matter = {
      id: 'MAT-STAFF-DIARY',
      reference: 'NALF-STAFF-99',
      title: 'Staff Restricted Matter',
      clientId: 'P-CLI-STAFF',
      practiceAreaId: 'work_type.dispute_resolution',
      matterTypeId: 'matter_type.litigation',
      owningTeamId: 'TM-LIT',
      responsiblePartnerId: 'P-AUTH-RISK',
      supervisingPartnerId: 'P-AUTH-RISK',
      leadFeeEarnerId: 'P-FEE-LIT',
      teamMemberIds: ['P-AUTH-RISK'],
      isStaffMatter: true,
      restrictedAccessUserIds: ['P-AUTH-RISK'], // P-RISK is NOT included!
      status: 'Active',
      openDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as unknown as Matter;

    const staffKd: KeyDate = {
      id: 'KD-STAFF-DIARY',
      matterId: staffMatter.id,
      keyDateTypeId: 'limitation',
      category: 'limitation',
      title: 'Restricted Limitation Date',
      dueDate: '2026-06-15',
      isCritical: true,
      status: 'confirmed',
      source: 'manual',
      teamId: 'TM-LIT',
      responsiblePersonIds: ['P-AUTH-RISK'],
      verification: { required: false },
      createdById: 'P-AUTH-RISK',
      createdAt: '2026-01-01T00:00:00Z',
      updatedById: 'P-AUTH-RISK',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 1,
    };

    // Unlisted risk_compliance user receives 0 entries (no placeholder)
    const unlistedResult = queryTeamDiaryEntries({
      viewer: riskComplianceUser,
      query: { from: '2026-06-01', to: '2026-06-30' },
      todayIso: '2026-06-01',
      config,
      keyDates: [staffKd],
      matters: [staffMatter],
      teams,
      people,
    });
    expect(unlistedResult).toHaveLength(0);

    // Listed managing_partner in restrictedAccessUserIds receives the entry
    const listedResult = queryTeamDiaryEntries({
      viewer: authorisedStaffViewer,
      query: { from: '2026-06-01', to: '2026-06-30' },
      todayIso: '2026-06-01',
      config,
      keyDates: [staffKd],
      matters: [staffMatter],
      teams,
      people,
    });
    expect(listedResult).toHaveLength(1);
    expect(listedResult[0]!.keyDateId).toBe('KD-STAFF-DIARY');
  });

  it('computes all 8 KeyDateExceptionKind compliance exceptions for keydate:view_any_team users and omits restricted matters', () => {
    const todayIso = '2026-06-15';

    // Matter 1: Open litigation matter missing required 'limitation' date -> `matter_missing_required_date`
    const openLitMatterMissingReq = {
      id: 'MAT-EX-1',
      reference: 'NALF-EX-001',
      title: 'Missing Limitation Matter',
      practiceAreaId: 'work_type.dispute_resolution',
      matterTypeId: 'matter_type.litigation',
      owningTeamId: 'TM-LIT',
      matterStatusId: 'matter_status.active',
      updatedAt: '2026-06-01T00:00:00Z',
    } as unknown as Matter;

    // Matter 2: Closed matter with an open date -> `closed_matter_open_dates`
    const closedMatterWithOpenDate = {
      id: 'MAT-EX-2',
      reference: 'NALF-EX-002',
      title: 'Closed Matter With Open Date',
      practiceAreaId: 'work_type.conveyancing',
      matterTypeId: 'matter_type.residential_conveyancing',
      owningTeamId: 'TM-PROP',
      matterStatusId: 'matter_status.closed',
      updatedAt: '2026-05-01T00:00:00Z',
    } as unknown as Matter;

    // Matter 3: Normal active matter for key-date-level exceptions
    const activeMatter = {
      id: 'MAT-EX-3',
      reference: 'NALF-EX-003',
      title: 'Active Litigation Matter',
      practiceAreaId: 'work_type.dispute_resolution',
      matterTypeId: 'matter_type.litigation',
      owningTeamId: 'TM-LIT',
      matterStatusId: 'matter_status.active',
      updatedAt: '2026-04-01T00:00:00Z', // > 30 days before todayIso (2026-06-15)
    } as unknown as Matter;

    // Matter 4: Restricted staff matter with missing required date (should be OMITTED for riskComplianceUser)
    const restrictedMatter = {
      id: 'MAT-EX-STAFF',
      reference: 'NALF-STAFF-EX',
      title: 'Restricted Matter',
      practiceAreaId: 'work_type.dispute_resolution',
      matterTypeId: 'matter_type.litigation',
      owningTeamId: 'TM-LIT',
      matterStatusId: 'matter_status.active',
      isStaffMatter: true,
      restrictedAccessUserIds: ['P-AUTH-RISK'],
      updatedAt: '2026-06-01T00:00:00Z',
    } as unknown as Matter;

    const keyDates: KeyDate[] = [
      // Closed matter open date (`closed_matter_open_dates`)
      {
        id: 'KD-EX-CLOSED',
        matterId: closedMatterWithOpenDate.id,
        keyDateTypeId: 'completion',
        category: 'contractual',
        title: 'Unresolved Completion',
        dueDate: '2026-07-01',
        isCritical: true,
        status: 'confirmed',
        source: 'manual',
        teamId: 'TM-PROP',
        responsiblePersonIds: ['P-FEE-PROP'],
        verification: { required: false },
        createdById: 'P-FEE-PROP',
        createdAt: '2026-05-01T00:00:00Z',
        updatedById: 'P-FEE-PROP',
        updatedAt: '2026-05-01T00:00:00Z',
        version: 1,
      },
      // Awaiting verification for > 3 days (`verification_overdue`) AND `calculated_from_unreviewed_rules`
      {
        id: 'KD-EX-VERIFY-UNREV',
        matterId: activeMatter.id,
        keyDateTypeId: 'limitation',
        category: 'limitation',
        title: 'Primary Limitation',
        dueDate: '2027-01-01',
        isCritical: true,
        status: 'awaiting_verification',
        source: 'calculated',
        teamId: 'TM-LIT',
        responsiblePersonIds: ['P-FEE-LIT'],
        calculation: {
          ruleSetId: 'ew-statute-of-limitations',
          ruleSetVersion: 1,
          ruleSetReviewStatus: 'unreviewed',
          ruleId: 'contract-simple',
          triggers: { accrualDate: '2021-01-01' },
          calculatedDate: '2027-01-01',
          explanation: ['6 years'],
          overridden: false,
        },
        verification: {
          required: true,
          proposedById: 'P-FEE-LIT',
          proposedAt: '2026-06-01T09:00:00Z', // 14 days ago (>= 3 days)
        },
        createdById: 'P-FEE-LIT',
        createdAt: '2026-06-01T09:00:00Z',
        updatedById: 'P-FEE-LIT',
        updatedAt: '2026-06-01T09:00:00Z',
        version: 1,
      },
      // Critical date due within 90 days with no activity for >= 30 days (`critical_date_no_recent_activity`),
      // plus escalated unacknowledged reminder (`reminder_escalated_unacknowledged`),
      // plus failed calendar sync (`calendar_sync_failed`)
      {
        id: 'KD-EX-CRIT-INACTIVE',
        matterId: activeMatter.id,
        keyDateTypeId: 'court_hearing',
        category: 'court_deadline',
        title: 'CMC Hearing',
        dueDate: '2026-07-15', // 30 days from todayIso (within 90d window)
        isCritical: true,
        status: 'confirmed',
        source: 'manual',
        teamId: 'TM-LIT',
        responsiblePersonIds: ['P-FEE-LIT'],
        verification: { required: true },
        createdById: 'P-FEE-LIT',
        createdAt: '2026-04-01T09:00:00Z',
        updatedById: 'P-FEE-LIT',
        updatedAt: '2026-04-01T09:00:00Z', // 75 days ago (>= 30 days)
        version: 1,
      },
      // Past due confirmed date (`past_due_unresolved`)
      {
        id: 'KD-EX-PASTDUE',
        matterId: activeMatter.id,
        keyDateTypeId: 'service_of_claim',
        category: 'court_deadline',
        title: 'Service of Claim Form',
        dueDate: '2026-06-10', // 5 days before todayIso
        isCritical: true,
        status: 'confirmed',
        source: 'manual',
        teamId: 'TM-LIT',
        responsiblePersonIds: ['P-FEE-LIT'],
        verification: { required: true },
        createdById: 'P-FEE-LIT',
        createdAt: '2026-05-01T09:00:00Z',
        updatedById: 'P-FEE-LIT',
        updatedAt: '2026-06-05T09:00:00Z',
        version: 1,
      },
    ];

    const reminderStates: KeyDateReminderState[] = [
      {
        keyDateId: 'KD-EX-CRIT-INACTIVE',
        taskId: 'TSK-EX-1',
        idempotencyKey: 'keydate-reminder:KD-EX-CRIT-INACTIVE',
        reminderScheduleId: 'critical',
        currentStageDaysBefore: 30,
        stageEnteredAt: '2026-06-10T08:00:00Z',
        escalationLevel: 1,
        lastNotifiedAt: '2026-06-12T08:00:00Z',
      },
    ];

    const calendarSyncs: KeyDateCalendarSync[] = [
      {
        keyDateId: 'KD-EX-CRIT-INACTIVE',
        externalEvents: [{ target: 'TM-LIT', eventId: 'evt-1' }],
        state: 'failed',
        attempts: 3,
        lastError: 'Mailbox quota exceeded (HTTP 507)',
      },
    ];

    // Regular fee earner without keydate:view_any_team gets empty exceptions
    expect(
      computeKeyDateExceptions({
        viewer: litFeeEarner,
        todayIso,
        config,
        keyDates,
        reminderStates,
        calendarSyncs,
        matters: [
          openLitMatterMissingReq,
          closedMatterWithOpenDate,
          activeMatter,
          restrictedMatter,
        ],
        teams,
        people,
      }),
    ).toHaveLength(0);

    // Risk & compliance user gets all 8 exception kinds, with restrictedMatter omitted
    const exceptions = computeKeyDateExceptions({
      viewer: riskComplianceUser,
      todayIso,
      config,
      keyDates,
      reminderStates,
      calendarSyncs,
      matters: [
        openLitMatterMissingReq,
        closedMatterWithOpenDate,
        activeMatter,
        restrictedMatter,
      ],
      teams,
      people,
    });

    const allExpectedKinds: KeyDateExceptionKind[] = [
      'matter_missing_required_date',
      'verification_overdue',
      'critical_date_no_recent_activity',
      'closed_matter_open_dates',
      'calculated_from_unreviewed_rules',
      'reminder_escalated_unacknowledged',
      'calendar_sync_failed',
      'past_due_unresolved',
    ];

    const foundKinds = new Set(exceptions.map((e) => e.kind));
    for (const kind of allExpectedKinds) {
      expect(foundKinds.has(kind)).toBe(true);
    }

    // Verify restricted matter was completely omitted
    expect(exceptions.some((e) => e.matterId === restrictedMatter.id)).toBe(
      false,
    );
  });

  it('agrees with canUserAccessMatter for risk_compliance users (R37), compares stable status keys on renamed labels (R42), audits exports as keydate-export (R41), and scopes getAppSnapshot by team (R32)', async () => {
    const todayIso = '2026-06-15';

    // R37: A risk_compliance user granted matter:restricted:access gets the same answer from canUserAccessMatter and from key dates diary & exceptions
    const privilegedComplianceUser = {
      ...riskComplianceUser,
      id: 'P-RISK-PRIV',
      permissionOverrides: {
        grant: ['matter:restricted:access'],
        revoke: [],
      },
    } as unknown as Person;
    const allTestPeople = [...people, privilegedComplianceUser];

    const staffMatter: Matter = {
      id: 'MAT-STAFF-R37',
      reference: 'NALF-STAFF-R37',
      title: 'Staff Matter For R37',
      clientId: 'P-CLI-STAFF',
      practiceAreaId: 'work_type.dispute_resolution',
      matterTypeId: 'matter_type.litigation',
      owningTeamId: 'TM-LIT',
      responsiblePartnerId: 'P-AUTH-RISK',
      supervisingPartnerId: 'P-AUTH-RISK',
      leadFeeEarnerId: 'P-AUTH-RISK',
      teamMemberIds: ['P-AUTH-RISK'],
      isStaffMatter: true,
      restrictedAccessUserIds: ['P-AUTH-RISK'],
      matterStatusId: 'matter_status.active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-06-01T00:00:00Z',
    } as unknown as Matter;

    expect(
      canUserAccessMatter(
        staffMatter,
        privilegedComplianceUser.id,
        privilegedComplianceUser,
      ),
    ).toBe(true);
    expect(
      canViewerAccessMatterKeyDates(
        staffMatter,
        privilegedComplianceUser.id,
        privilegedComplianceUser,
        allTestPeople,
      ),
    ).toBe(true);

    // R37 negative case: riskComplianceUser (without matter:restricted:access and not on restrictedAccessUserIds) gets false and is excluded from diary & exceptions
    expect(
      canUserAccessMatter(
        staffMatter,
        riskComplianceUser.id,
        riskComplianceUser,
      ),
    ).toBe(false);
    expect(
      canViewerAccessMatterKeyDates(
        staffMatter,
        riskComplianceUser.id,
        riskComplianceUser,
        allTestPeople,
      ),
    ).toBe(false);

    const staffKeyDate: KeyDate = {
      id: 'KD-STAFF-R37-R99',
      matterId: staffMatter.id,
      keyDateTypeId: 'limitation',
      category: 'limitation',
      title: 'Staff Limitation Date',
      dueDate: '2026-06-10', // past due so past_due_unresolved triggers
      isCritical: true,
      status: 'confirmed',
      source: 'manual',
      teamId: 'TM-LIT',
      responsiblePersonIds: ['P-OUTSIDER-NO-ACCESS'],
      verification: { required: false },
      createdById: 'P-AUTH-RISK',
      createdAt: '2026-05-01T00:00:00Z',
      updatedById: 'P-AUTH-RISK',
      updatedAt: '2026-06-05T00:00:00Z',
      version: 1,
    };
    const staffReminderStates: KeyDateReminderState[] = [
      {
        keyDateId: staffKeyDate.id,
        taskId: '',
        idempotencyKey: 'keydate-reminder:tenant-nalf-test:KD-STAFF-R37-R99',
        reminderScheduleId: 'critical',
        currentStageDaysBefore: 30,
        stageEnteredAt: '2026-06-01T08:00:00Z',
        escalationLevel: 1,
        lastSkippedReason: 'no_permitted_assignees',
      },
    ];

    const privDiary = queryTeamDiaryEntries({
      viewer: privilegedComplianceUser,
      query: {},
      todayIso,
      config,
      keyDates: [staffKeyDate],
      matters: [staffMatter],
      teams,
      people: allTestPeople,
    });
    expect(privDiary.some((e) => e.keyDateId === staffKeyDate.id)).toBe(true);

    const unprivDiary = queryTeamDiaryEntries({
      viewer: riskComplianceUser,
      query: {},
      todayIso,
      config,
      keyDates: [staffKeyDate],
      matters: [staffMatter],
      teams,
      people: allTestPeople,
    });
    expect(unprivDiary.some((e) => e.keyDateId === staffKeyDate.id)).toBe(false);

    const privExceptions = computeKeyDateExceptions({
      viewer: privilegedComplianceUser,
      todayIso,
      config,
      keyDates: [staffKeyDate],
      reminderStates: staffReminderStates,
      matters: [staffMatter],
      teams,
      people: allTestPeople,
    });
    expect(privExceptions.some((e) => e.matterId === staffMatter.id)).toBe(true);
    // R99 & R115: restricted_matter_no_permitted_assignee is reported to permitted viewer when reminder was skipped due to no permitted assignees, and NOT duplicated as reminder_escalated_unacknowledged
    expect(
      privExceptions.filter(
        (e) =>
          e.keyDateId === staffKeyDate.id &&
          e.kind === 'restricted_matter_no_permitted_assignee',
      ),
    ).toHaveLength(1);
    expect(
      privExceptions.some(
        (e) =>
          e.keyDateId === staffKeyDate.id &&
          e.kind === 'reminder_escalated_unacknowledged',
      ),
    ).toBe(false);

    // R115: An orphan key date whose matter is missing appears once under orphan_key_date_missing_matter for an admin (keydate:configure) with keyDateId only, and is omitted for non-admins
    const orphanKeyDate: KeyDate = {
      ...staffKeyDate,
      id: 'KD-ORPHAN-MISSING-MATTER',
      matterId: 'MAT-DOES-NOT-EXIST',
    };
    const orphanReminderState: KeyDateReminderState = {
      ...staffReminderStates[0]!,
      keyDateId: orphanKeyDate.id,
      lastSkippedReason: 'missing_matter' as const,
      escalationLevel: 1,
    };
    const provisionalOrphanKeyDate: KeyDate = {
      ...orphanKeyDate,
      id: 'KD-ORPHAN-PROVISIONAL-NO-REMINDER',
      status: 'provisional',
    };
    const adminViewer: Person = {
      ...privilegedComplianceUser,
      id: 'P-ADMIN-VIEWER',
      roles: ['admin'],
      appRole: 'admin',
    };
    const adminOrphanExceptions = computeKeyDateExceptions({
      viewer: adminViewer,
      todayIso,
      config,
      keyDates: [orphanKeyDate, provisionalOrphanKeyDate],
      reminderStates: [orphanReminderState],
      matters: [staffMatter],
      teams,
      people: [...allTestPeople, adminViewer],
    });
    const orphanMatches = adminOrphanExceptions.filter(
      (e) => e.keyDateId === orphanKeyDate.id,
    );
    expect(
      adminOrphanExceptions.filter(
        (e) =>
          e.keyDateId === provisionalOrphanKeyDate.id &&
          e.kind === 'orphan_key_date_missing_matter',
      ),
    ).toHaveLength(1);
    expect(orphanMatches).toHaveLength(1);
    expect(orphanMatches[0]?.kind).toBe('orphan_key_date_missing_matter');
    expect(orphanMatches[0]?.matterId).toBeUndefined();

    const nonAdminOrphanExceptions = computeKeyDateExceptions({
      viewer: riskComplianceUser,
      todayIso,
      config,
      keyDates: [orphanKeyDate],
      reminderStates: [orphanReminderState],
      matters: [staffMatter],
      teams,
      people: allTestPeople,
    });
    expect(
      nonAdminOrphanExceptions.some((e) => e.keyDateId === orphanKeyDate.id),
    ).toBe(false);

    const unprivExceptions = computeKeyDateExceptions({
      viewer: riskComplianceUser,
      todayIso,
      config,
      keyDates: [staffKeyDate],
      reminderStates: staffReminderStates,
      matters: [staffMatter],
      teams,
      people: allTestPeople,
    });
    expect(unprivExceptions.some((e) => e.matterId === staffMatter.id)).toBe(false);

    // R42: After a status label is renamed (e.g. 'Active' -> 'Live Casework'), the exceptions report gives the same results based on stable matterStatusId / systemKey
    const matterWithCustomStatusId = {
      id: 'MAT-CUSTOM-STATUS',
      reference: 'NALF-STATUS-001',
      title: 'Renamed Status Matter',
      practiceAreaId: 'work_type.dispute_resolution',
      matterTypeId: 'matter_type.litigation',
      owningTeamId: 'TM-LIT',
      matterStatusId: 'val-status-live',
      updatedAt: '2026-06-01T00:00:00Z',
    } as unknown as Matter;

    const valuesBeforeRename = [
      {
        id: 'val-status-live',
        listKey: 'matter_status',
        systemKey: 'active',
        label: 'Active',
        sortOrder: 1,
        active: true,
      },
    ];
    const valuesAfterRename = [
      {
        id: 'val-status-live',
        listKey: 'matter_status',
        systemKey: 'active',
        label: 'In Progress — Renamed Label',
        sortOrder: 1,
        active: true,
      },
    ];

    const exBefore = computeKeyDateExceptions({
      viewer: riskComplianceUser,
      todayIso,
      config,
      keyDates: [],
      matters: [matterWithCustomStatusId],
      teams,
      people: allTestPeople,
      values: valuesBeforeRename as never,
    });
    const exAfter = computeKeyDateExceptions({
      viewer: riskComplianceUser,
      todayIso,
      config,
      keyDates: [],
      matters: [matterWithCustomStatusId],
      teams,
      people: allTestPeople,
      values: valuesAfterRename as never,
    });
    expect(exAfter).toEqual(exBefore);
    expect(exAfter.some((e) => e.kind === 'matter_missing_required_date')).toBe(
      true,
    );

    // R42: A matter with no matterStatusId and a legacy status label of 'Active' is NOT treated as open
    const matterWithLegacyLabelOnly = {
      id: 'MAT-LEGACY-LABEL-ONLY',
      reference: 'NALF-LEGACY-001',
      title: 'Legacy Label Only Matter',
      practiceAreaId: 'work_type.dispute_resolution',
      matterTypeId: 'matter_type.litigation',
      owningTeamId: 'TM-LIT',
      matterStatusId: '',
      status: 'Active',
      updatedAt: '2026-06-01T00:00:00Z',
    } as unknown as Matter;
    const exLegacyLabel = computeKeyDateExceptions({
      viewer: riskComplianceUser,
      todayIso,
      config,
      keyDates: [],
      matters: [matterWithLegacyLabelOnly],
      teams,
      people: allTestPeople,
      values: valuesBeforeRename as never,
    });
    expect(
      exLegacyLabel.some(
        (e) =>
          e.matterId === 'MAT-LEGACY-LABEL-ONLY' &&
          e.kind === 'matter_missing_required_date',
      ),
    ).toBe(false);

    // R41: After exportKeyDateExceptionsReportRecord, an audit entry has action === 'keydate-export'
    resetStore();
    const store = getStore();
    const managingPartner = store.people.find(
      (p) => p.isEmployee && p.roles?.includes('managing_partner'),
    )!;
    const exportAuditMark = await markAuditPosition();
    const exportRes = await exportKeyDateExceptionsReportRecord(
      { format: 'csv' },
      managingPartner.id,
      todayIso,
    );
    expect(exportRes.ok).toBe(true);
    const exportAudit = await auditEntriesForRecord(
      'key_date',
      'KEY-DATE-EXCEPTIONS-EXPORT',
      exportAuditMark,
    );
    expect(exportAudit[0]?.action).toBe('keydate-export');

    // R29: A staff matter with no permitted assignee, updated through the services, writes an audit entry and produces an exceptions-report entry
    const unpermittedAssignee = store.people.find(
      (p) => p.isEmployee && !p.mergedIntoId && p.id !== managingPartner.id,
    )!;
    const staffMatterNoAssignee: Matter = {
      ...store.matters[0]!,
      id: 'M-R29-NO-ASSIGNEE',
      matterNumber: 'NALF-R29-001',
      title: 'Staff Matter With Unpermitted Responsible Person',
      isStaffMatter: true,
      restrictedAccessUserIds: [managingPartner.id],
      responsiblePartnerId: managingPartner.id,
      supervisingPartnerId: managingPartner.id,
      leadFeeEarnerId: managingPartner.id,
      teamMemberIds: [managingPartner.id],
    };
    store.matters.push(staffMatterNoAssignee);
    const activeTeamId = store.teams.find((t) => t.active)!.id;
    const kdRepo = getKeyDateRepository();
    const partnerCtx = testTenantCtx(managingPartner.id);
    const baseKd = (await kdRepo.listAllVisibleKeyDates(partnerCtx)).find((k) =>
      Boolean(k.matterId),
    )!;
    expect(baseKd).toBeDefined();
    await kdRepo.setMatterRestriction(partnerCtx, {
      matterId: staffMatterNoAssignee.id,
      isRestricted: true,
      restrictedAccessUserIds: [managingPartner.id],
    });
    await kdRepo.putKeyDate(partnerCtx, {
      ...baseKd,
      id: 'KD-R29-NO-ASSIGNEE',
      matterId: staffMatterNoAssignee.id,
      enquiryId: undefined,
      title: 'Staff Matter Unassignable Deadline',
      dueDate: '2026-12-01',
      status: 'awaiting_verification',
      teamId: activeTeamId,
      responsiblePersonIds: [unpermittedAssignee.id],
      verification: {
        required: true,
        proposedById: unpermittedAssignee.id,
        proposedAt: '2026-11-01T10:00:00.000Z',
      },
    });
    const verifyAuditMark = await markAuditPosition();
    const verifyStaffRes = await verifyProposedKeyDateRecord(
      'KD-R29-NO-ASSIGNEE',
      managingPartner.id,
    );
    expect(verifyStaffRes.ok).toBe(true);
    expect(
      (await auditEntriesForRecord('key_date', 'KD-R29-NO-ASSIGNEE', verifyAuditMark)).some(
        (a) =>
          a.recordId === 'KD-R29-NO-ASSIGNEE' &&
          a.action === 'keydate-reminder-escalate' &&
          a.newValue === 'no_permitted_assignees',
      ),
    ).toBe(true);
    const exceptionsForPartner = await getKeyDateExceptionsReportRecord(
      {},
      managingPartner.id,
      todayIso,
    );
    expect(
      exceptionsForPartner.some(
        (ex) =>
          ex.keyDateId === 'KD-R29-NO-ASSIGNEE' &&
          ex.kind === 'restricted_matter_no_permitted_assignee',
      ),
    ).toBe(true);

    // R32: getAppSnapshot for a fee earner without keydate:view_any_team contains no other team's key dates
    const feeEarner = store.people.find(
      (p) =>
        p.isEmployee &&
        p.roles?.includes('fee_earner') &&
        !p.roles?.includes('managing_partner') &&
        !p.roles?.includes('admin') &&
        !p.roles?.includes('risk_compliance'),
    )!;
    const ownTeamIds = new Set(
      store.teams
        .filter(
          (t) =>
            t.active &&
            (t.memberIds.includes(feeEarner.id) ||
              t.leadIds.includes(feeEarner.id)),
        )
        .map((t) => t.id),
    );
    const otherTeam = store.teams.find(
      (t) => t.active && !ownTeamIds.has(t.id),
    )!;
    await kdRepo.putKeyDate(partnerCtx, {
      ...baseKd,
      id: 'KD-OTHER-TEAM-999',
      teamId: otherTeam.id,
      title: 'Other Team Key Date',
    });
    const snap = await getAppSnapshot(feeEarner.id);
    expect(snap.keyDates.some((kd) => kd.id === 'KD-OTHER-TEAM-999')).toBe(
      false,
    );
    expect(snap.keyDates.every((kd) => ownTeamIds.has(kd.teamId))).toBe(true);
  });
});
