import { describe, expect, it } from 'vitest';
import exampleConfig from '../../../schemas/keyDates.config.example.json';
import type {
  KeyDate,
  KeyDateReminderState,
  KeyDatesConfig,
} from '../keyDates.types';
import type {
  AuditEntry,
  Matter,
  NotificationItem,
  Person,
  Task,
  Team,
} from '../types';
import {
  acknowledgeKeyDateReminderStage,
  buildKeyDateReminderIdempotencyKey,
  closeReminderTaskForKeyDate,
  runTenantKeyDateReminderJob,
  syncReminderForConfirmedKeyDate,
} from '../keyDateReminders';
import {
  reassignKeyDateTeamAndOwners,
  resolveKeyDateOutcome,
  supersedeConfirmedKeyDate,
} from '../keyDates';

const config = exampleConfig as unknown as KeyDatesConfig;

const teams: Team[] = [
  {
    id: 'TM-LIT',
    name: 'Dispute Resolution Team',
    description: '',
    practiceAreaIds: [],
    leadIds: ['P-LEAD'],
    memberIds: ['P-LEAD', 'P-FEE', 'P-SECOND'],
    active: true,
    createdById: 'P-LEAD',
    createdAt: '2026-01-01T00:00:00Z',
    updatedById: 'P-LEAD',
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

const teamLead = {
  id: 'P-LEAD',
  firstName: 'Julian',
  surname: 'Sterling',
  isEmployee: true,
  employeeRoleId: 'emp_role.partner',
  appRole: 'team_lead',
  homeRoles: ['supervisor'],
  mergedIntoId: null,
} as unknown as Person;

const riskComplianceOfficer = {
  id: 'P-RISK',
  firstName: 'Clara',
  surname: 'Pembroke',
  isEmployee: true,
  employeeRoleId: 'emp_role.risk_compliance',
  homeRoles: ['risk_compliance'],
  mergedIntoId: null,
} as unknown as Person;

const people = [feeEarner, teamLead, riskComplianceOfficer];

function makeConfirmedKeyDate(overrides?: Partial<KeyDate>): KeyDate {
  return {
    id: 'KD-REM-1',
    matterId: 'MAT-000200',
    keyDateTypeId: 'limitation',
    category: 'limitation',
    title: 'Primary Limitation Date',
    dueDate: '2026-10-01',
    isCritical: true,
    status: 'confirmed',
    source: 'calculated',
    teamId: 'TM-LIT',
    responsiblePersonIds: ['P-FEE', 'P-LEAD'],
    verification: {
      required: true,
      proposedById: 'P-FEE',
      proposedAt: '2026-01-10T09:00:00Z',
      verifiedById: 'P-LEAD',
      verifiedAt: '2026-01-10T10:00:00Z',
    },
    createdById: 'P-FEE',
    createdAt: '2026-01-10T09:00:00Z',
    updatedById: 'P-LEAD',
    updatedAt: '2026-01-10T10:00:00Z',
    version: 1,
    ...overrides,
  };
}

describe('Single-Task Non-Stacking Reminders & Daily Scheduler (§4)', () => {
  it('refuses to run the scheduler job without a tenantId', () => {
    expect(() =>
      runTenantKeyDateReminderJob({
        tenantId: '   ',
        todayIso: '2026-06-01',
        config,
        keyDates: [],
        reminderStates: [],
        tasks: [],
        nextTaskId: () => 'TSK-1',
      }),
    ).toThrow(/refused to run without tenantId/i);
  });

  it('creates exactly one task per confirmed key date and updates the SAME task across stages without stacking', () => {
    const keyDate = makeConfirmedKeyDate({ dueDate: '2026-10-01' });
    const tasks: Task[] = [];
    const reminderStates: KeyDateReminderState[] = [];
    const notifications: NotificationItem[] = [];
    const audit: AuditEntry[] = [];
    let taskSeq = 1;

    // 1. Run job at 90 days before due date (2026-07-03 is 90 days before 2026-10-01)
    const run90 = runTenantKeyDateReminderJob({
      tenantId: 'tenant-nalf-test',
      todayIso: '2026-07-03',
      config,
      keyDates: [keyDate],
      reminderStates,
      tasks,
      teams,
      people,
      notifications,
      audit,
      nextTaskId: () => `TSK-REM-${taskSeq++}`,
    });

    expect(run90.evaluatedCount).toBe(1);
    expect(run90.stagesAdvancedCount).toBe(1);
    expect(tasks).toHaveLength(1);
    expect(reminderStates).toHaveLength(1);
    const taskId = tasks[0]!.id;
    expect(
      buildKeyDateReminderIdempotencyKey('KD-REM-1', 'tenant-nalf-test'),
    ).toBe('keydate-reminder:tenant-nalf-test:KD-REM-1');
    expect(tasks[0]!.idempotencyKey).toBe(
      'keydate-reminder:tenant-nalf-test:KD-REM-1',
    );
    expect(tasks[0]!.assignedTeamId).toBe('TM-LIT');
    expect(tasks[0]!.assignedPersonIds).toEqual(['P-FEE', 'P-LEAD']);
    expect(reminderStates[0]!.currentStageDaysBefore).toBe(90);

    // 2. Re-running on the same day is idempotent: no new task, no extra notification
    const run90Repeat = runTenantKeyDateReminderJob({
      tenantId: 'tenant-nalf-test',
      todayIso: '2026-07-03',
      config,
      keyDates: [keyDate],
      reminderStates,
      tasks,
      teams,
      people,
      notifications,
      audit,
      nextTaskId: () => `TSK-REM-${taskSeq++}`,
    });
    expect(run90Repeat.stagesAdvancedCount).toBe(0);
    expect(tasks).toHaveLength(1);
    expect(notifications).toHaveLength(1);

    // 3. Acknowledge the 90-day stage
    acknowledgeKeyDateReminderStage({
      keyDateId: keyDate.id,
      actorId: feeEarner.id,
      nowIso: '2026-07-03T11:00:00Z',
      reminderStates,
      audit,
      nextAuditId: () => 'AUD-ACK-1',
    });
    expect(reminderStates[0]!.acknowledgedById).toBe(feeEarner.id);

    // 4. Advance to 60 days before due date (2026-08-02): updates the SAME task in place, resets acknowledgement
    const run60 = runTenantKeyDateReminderJob({
      tenantId: 'tenant-nalf-test',
      todayIso: '2026-08-02',
      config,
      keyDates: [keyDate],
      reminderStates,
      tasks,
      teams,
      people,
      notifications,
      audit,
      nextTaskId: () => `TSK-REM-${taskSeq++}`,
    });

    expect(run60.stagesAdvancedCount).toBe(1);
    expect(tasks).toHaveLength(1); // Still only 1 task!
    expect(tasks[0]!.id).toBe(taskId);
    expect(tasks[0]!.title).toContain('60d');
    expect(reminderStates[0]!.currentStageDaysBefore).toBe(60);
    expect(reminderStates[0]!.acknowledgedAt).toBeUndefined();
    expect(notifications).toHaveLength(2);
  });

  it('escalates an unacknowledged stage through escalation.levels on the same task without creating a second task', () => {
    // 'critical' schedule has afterUnacknowledgedDays = 2, levels = ['team_leads', 'role:risk_compliance']
    const keyDate = makeConfirmedKeyDate({ dueDate: '2026-08-31' }); // 30 days from 2026-08-01
    const tasks: Task[] = [];
    const reminderStates: KeyDateReminderState[] = [];
    const notifications: NotificationItem[] = [];
    const audit: AuditEntry[] = [];

    // Day 0 of 30-day stage (2026-08-01)
    runTenantKeyDateReminderJob({
      tenantId: 'tenant-nalf-test',
      todayIso: '2026-08-01',
      config,
      keyDates: [keyDate],
      reminderStates,
      tasks,
      teams,
      people,
      notifications,
      audit,
      nextTaskId: () => 'TSK-ESC-1',
    });
    expect(reminderStates[0]!.currentStageDaysBefore).toBe(30);
    expect(reminderStates[0]!.escalationLevel).toBe(0);

    // Day 2 unacknowledged (2026-08-03) -> Escalates to Level 1 ('team_leads')
    const esc1 = runTenantKeyDateReminderJob({
      tenantId: 'tenant-nalf-test',
      todayIso: '2026-08-03',
      config,
      keyDates: [keyDate],
      reminderStates,
      tasks,
      teams,
      people,
      notifications,
      audit,
      nextTaskId: () => 'TSK-ESC-NEVER',
    });
    expect(esc1.escalationsTriggeredCount).toBe(1);
    expect(tasks).toHaveLength(1);
    expect(reminderStates[0]!.escalationLevel).toBe(1);
    expect(audit.some((a) => a.action === 'keydate-reminder-escalate')).toBe(true);

    // Day 4 unacknowledged (2026-08-05) -> Escalates to Level 2 ('role:risk_compliance')
    const esc2 = runTenantKeyDateReminderJob({
      tenantId: 'tenant-nalf-test',
      todayIso: '2026-08-05',
      config,
      keyDates: [keyDate],
      reminderStates,
      tasks,
      teams,
      people,
      notifications,
      audit,
      nextTaskId: () => 'TSK-ESC-NEVER',
    });
    expect(esc2.escalationsTriggeredCount).toBe(1);
    expect(tasks).toHaveLength(1);
    expect(reminderStates[0]!.escalationLevel).toBe(2);
    expect(tasks[0]!.assignedPersonIds).toContain('P-RISK');
  });

  it('moves a confirmed date that passes without resolution to "past due, unresolved" at the top stage', () => {
    const keyDate = makeConfirmedKeyDate({ dueDate: '2026-05-01' });
    const tasks: Task[] = [];
    const reminderStates: KeyDateReminderState[] = [];

    runTenantKeyDateReminderJob({
      tenantId: 'tenant-nalf-test',
      todayIso: '2026-05-05', // 4 days past due
      config,
      keyDates: [keyDate],
      reminderStates,
      tasks,
      teams,
      people,
      nextTaskId: () => 'TSK-PASTDUE',
    });

    expect(tasks).toHaveLength(1);
    expect(reminderStates[0]!.currentStageDaysBefore).toBe(-1);
    expect(tasks[0]!.title).toContain('[Past due, unresolved]');
    expect(tasks[0]!.priorityId).toBe('task_priority.urgent');
  });

  it('hands over the same reminder task on supersede and closes the task on resolution (met/missed/waived)', () => {
    const original = makeConfirmedKeyDate({
      id: 'KD-ORIG-TASK',
      keyDateTypeId: 'completion',
      category: 'contractual',
      dueDate: '2026-07-01',
    });
    const tasks: Task[] = [];
    const reminderStates: KeyDateReminderState[] = [];
    const audit: AuditEntry[] = [];
    let seq = 1;

    const syncedOrig = syncReminderForConfirmedKeyDate({
      keyDate: original,
      config,
      tasks,
      reminderStates,
      todayIso: '2026-06-01',
      nowIso: '2026-06-01T09:00:00Z',
      actorId: feeEarner.id,
      nextTaskId: () => `TSK-HANDOVER-${seq++}`,
    });
    const originalTaskId = syncedOrig.task!.id;
    expect(tasks).toHaveLength(1);

    // Supersede original key date (on residential_conveyancing so replacement is immediately confirmed)
    const conveyancingMatter = {
      id: 'MAT-000200',
      matterNumber: 'NALF-2026-0200',
      title: 'Conveyancing Matter',
      clientId: 'P-CLI-1',
      practiceAreaId: 'work_type.conveyancing',
      matterTypeId: 'matter_type.residential_conveyancing',
      owningTeamId: 'TM-LIT',
      responsiblePartnerId: 'P-LEAD',
      supervisingPartnerId: 'P-LEAD',
      leadFeeEarnerId: 'P-FEE',
      teamMemberIds: ['P-FEE', 'P-LEAD'],
      matterStatusId: 'Open',
      openedAt: '2026-01-10',
      createdAt: '2026-01-10T09:00:00Z',
      updatedAt: '2026-01-10T09:00:00Z',
    } as unknown as Matter;

    const { replacementKeyDate } = supersedeConfirmedKeyDate({
      existingKeyDate: original,
      newKeyDateId: 'KD-REPLACEMENT-TASK',
      updates: { dueDate: '2026-08-01' },
      reason: 'Completion date moved by agreement.',
      actor: feeEarner,
      nowIso: '2026-06-15T10:00:00Z',
      config,
      matter: conveyancingMatter,
      teams,
      people,
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });

    // Hand over the task to the replacement key date
    const syncedReplacement = syncReminderForConfirmedKeyDate({
      keyDate: replacementKeyDate,
      config,
      tasks,
      reminderStates,
      todayIso: '2026-06-15',
      nowIso: '2026-06-15T10:00:00Z',
      actorId: feeEarner.id,
      nextTaskId: () => `TSK-HANDOVER-${seq++}`,
      transferredFromKeyDateId: original.id,
    });

    expect(tasks).toHaveLength(1);
    expect(syncedReplacement.task!.id).toBe(originalTaskId);
    expect(syncedReplacement.task!.linkedKeyDateId).toBe('KD-REPLACEMENT-TASK');
    expect(syncedReplacement.task!.dueAt).toBe('2026-08-01');
    expect(reminderStates).toHaveLength(1);
    expect(reminderStates[0]!.keyDateId).toBe('KD-REPLACEMENT-TASK');

    // Resolve the replacement date as met -> closes the task
    resolveKeyDateOutcome({
      keyDate: replacementKeyDate,
      kind: 'met',
      note: 'Completion completed on time.',
      actor: feeEarner,
      nowIso: '2026-08-01T14:00:00Z',
      config,
      teams,
      people,
      audit,
      nextAuditId: () => `AUD-${seq++}`,
    });

    closeReminderTaskForKeyDate({
      keyDateId: replacementKeyDate.id,
      tasks,
      reminderStates,
      nowIso: '2026-08-01T14:00:00Z',
      actorId: feeEarner.id,
    });

    expect(tasks[0]!.status).toBe('Done');
    expect(tasks[0]!.completedById).toBe(feeEarner.id);
  });

  it('filters reminder recipients on restricted (staff) matters so only restrictedAccessUserIds receive notifications, and never creates a task when no responsible person is permitted (R29)', () => {
    const restrictedMatter = {
      id: 'MAT-STAFF-1',
      matterNumber: 'NALF-STAFF-001',
      title: 'Confidential Staff Matter',
      clientId: 'P-CLI-STAFF',
      practiceAreaId: 'work_type.dispute_resolution',
      matterTypeId: 'matter_type.litigation',
      owningTeamId: 'TM-LIT',
      responsiblePartnerId: 'P-LEAD',
      supervisingPartnerId: 'P-LEAD',
      leadFeeEarnerId: 'P-LEAD',
      teamMemberIds: ['P-LEAD'],
      isStaffMatter: true,
      restrictedAccessUserIds: ['P-LEAD'], // P-FEE and P-RISK are NOT permitted on this staff matter
      matterStatusId: 'Open',
      openedAt: '2026-01-10',
      createdAt: '2026-01-10T09:00:00Z',
      updatedAt: '2026-01-10T09:00:00Z',
    } as unknown as Matter;

    const keyDate = makeConfirmedKeyDate({
      id: 'KD-STAFF-REM',
      matterId: restrictedMatter.id,
      dueDate: '2026-08-31',
      responsiblePersonIds: ['P-FEE', 'P-LEAD'],
    });

    const tasks: Task[] = [];
    const reminderStates: KeyDateReminderState[] = [];
    const notifications: NotificationItem[] = [];

    runTenantKeyDateReminderJob({
      tenantId: 'tenant-nalf-test',
      todayIso: '2026-08-01',
      config,
      keyDates: [keyDate],
      reminderStates,
      tasks,
      matters: [restrictedMatter],
      teams,
      people,
      notifications,
      nextTaskId: () => 'TSK-STAFF-REM',
    });

    expect(tasks[0]!.assignedPersonIds).toEqual(['P-LEAD']);
    expect(notifications).toHaveLength(1);
    expect(
      (notifications[0] as unknown as { recipientId?: string }).recipientId,
    ).toBe('P-LEAD');

    // R29: If all responsiblePersonIds on a staff-matter key date are outside the permitted list,
    // no task is created for an unpermitted person (both after sync and after stage advance), and audit records an escalation
    const allUnpermittedKd = makeConfirmedKeyDate({
      id: 'KD-STAFF-NONE-PERMITTED',
      matterId: restrictedMatter.id,
      dueDate: '2026-08-31',
      responsiblePersonIds: ['P-FEE'], // P-FEE cannot access restrictedMatter
    });
    const zeroTasks: Task[] = [];
    const zeroStates: KeyDateReminderState[] = [];
    const zeroNotifications: NotificationItem[] = [];
    const zeroAudit: AuditEntry[] = [];

    const syncRes = syncReminderForConfirmedKeyDate({
      keyDate: allUnpermittedKd,
      config,
      tasks: zeroTasks,
      reminderStates: zeroStates,
      matters: [restrictedMatter],
      people,
      audit: zeroAudit,
      todayIso: '2026-06-02',
      nowIso: '2026-06-02T08:00:00Z',
      actorId: 'P-LEAD',
      tenantId: 'tenant-nalf-test',
      nextTaskId: () => 'TSK-SHOULD-NOT-EXIST',
    });
    expect(syncRes?.task).toBeNull();
    expect(zeroTasks).toHaveLength(0);
    expect(
      zeroAudit.some((a) => a.action === 'keydate-reminder-escalate'),
    ).toBe(true);

    runTenantKeyDateReminderJob({
      tenantId: 'tenant-nalf-test',
      todayIso: '2026-08-01',
      config,
      keyDates: [allUnpermittedKd],
      reminderStates: zeroStates,
      tasks: zeroTasks,
      matters: [restrictedMatter],
      teams,
      people,
      notifications: zeroNotifications,
      audit: zeroAudit,
      nextTaskId: () => 'TSK-SHOULD-NOT-EXIST-2',
    });
    expect(zeroTasks).toHaveLength(0);
    expect(zeroNotifications).toHaveLength(0);

    // R29: Reassigning to an unpermitted person on a restricted matter is rejected
    expect(() =>
      reassignKeyDateTeamAndOwners({
        keyDate,
        teamId: 'TM-LIT',
        responsiblePersonIds: ['P-FEE'],
        actor: people.find((p) => p.id === 'P-LEAD')!,
        nowIso: '2026-08-02T10:00:00Z',
        config,
        matter: restrictedMatter,
        teams,
        people,
        audit: zeroAudit,
        nextAuditId: () => 'AU-REASSIGN-DENIED',
      }),
    ).toThrow(/does not have access to restricted matter/i);
  });
});
