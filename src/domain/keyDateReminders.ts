/**
 * Single-Task Non-Stacking Reminder State Machine & Daily Tenant Scheduler (`src/domain/keyDateReminders.ts`).
 *
 * Classification: Core feature (Platform Architecture Standard §14).
 * - One reminder task per confirmed key date (`idempotencyKey = keydate-reminder:${tenantId}:${keyDateId}`).
 * - Never stacks tasks: crossing into a closer stage updates the existing Task in place,
 *   resets acknowledgement, and sends a single notification.
 * - Superseding a confirmed date transfers the existing Task to the superseding key date.
 * - Resolving a date (`met`, `missed`, `waived`) closes the linked Task.
 * - Daily scheduler job requires `tenantId` in its job context and refuses to run without it.
 * - Enforces restricted (staff) matter isolation (`matter.restrictedAccessUserIds.includes(userId)`).
 */

import { runTenantBackgroundJob } from '@platform/core';
import {
  buildKeyDateReminderIdempotencyKey,
  canViewerAccessMatterKeyDates,
  isMatterRestrictedForKeyDates,
  resolveReminderScheduleForKeyDate,
  resolveUserRoleKeysForKeyDates,
} from './keyDates';
import { diffCalendarDays } from './keyDateCalculator';
import type {
  IsoDate,
  IsoDateTime,
  KeyDate,
  KeyDateId,
  KeyDateReminderState,
  KeyDatesConfig,
  PersonId,
  ReminderPriority,
  ReminderScheduleConfig,
} from './keyDates.types';
import type {
  AuditEntry,
  Matter,
  NotificationItem,
  Person,
  Task,
  Team,
} from './types';

export { buildKeyDateReminderIdempotencyKey };

export function mapReminderPriorityToTaskPriorityId(
  priority: ReminderPriority | undefined,
): string {
  switch (priority) {
    case 'urgent':
      return 'task_priority.urgent';
    case 'high':
      return 'task_priority.high';
    case 'normal':
    default:
      return 'task_priority.normal';
  }
}

export interface EvaluatedReminderStage {
  stageDaysBefore: number;
  priority: ReminderPriority;
  isPastDue: boolean;
  daysRemaining: number;
  stageLabel: string;
}

/**
 * Evaluates the current reminder stage for a key date as of `todayIso`.
 * - If `daysRemaining < 0` (the confirmed date has passed without resolution), returns
 *   `stageDaysBefore = -1` ("Past due, unresolved") at `'urgent'` priority.
 * - Otherwise picks the closest stage whose `daysBefore >= daysRemaining`.
 */
export function evaluateActiveReminderStage(
  schedule: ReminderScheduleConfig | undefined,
  dueDate: IsoDate,
  todayIso: IsoDate,
): EvaluatedReminderStage {
  const daysRemaining = diffCalendarDays(todayIso, dueDate);
  if (daysRemaining < 0) {
    return {
      stageDaysBefore: -1,
      priority: 'urgent',
      isPastDue: true,
      daysRemaining,
      stageLabel: 'Past due, unresolved',
    };
  }

  const sortedStages = [...(schedule?.stages ?? [{ daysBefore: 30, priority: 'normal' }])]
    .sort((a, b) => b.daysBefore - a.daysBefore);

  // Find the smallest `daysBefore` that `daysRemaining` has reached (`daysRemaining <= stage.daysBefore`)
  let matched = sortedStages[0]!;
  for (const stage of sortedStages) {
    if (daysRemaining <= stage.daysBefore) {
      matched = stage;
    }
  }

  const priority = matched.priority ?? 'normal';
  const stageLabel =
    matched.daysBefore === 0
      ? 'Due today'
      : `${matched.daysBefore}-day reminder stage`;

  return {
    stageDaysBefore: matched.daysBefore,
    priority,
    isPastDue: false,
    daysRemaining,
    stageLabel,
  };
}

export function formatReminderTaskTitle(
  keyDate: Pick<KeyDate, 'title' | 'dueDate'>,
  evaluated: EvaluatedReminderStage,
): string {
  if (evaluated.isPastDue) {
    return `[Past due, unresolved] ${keyDate.title} (${keyDate.dueDate})`;
  }
  if (evaluated.stageDaysBefore === 0) {
    return `[Due today] ${keyDate.title} (${keyDate.dueDate})`;
  }
  return `[Key date – ${evaluated.stageDaysBefore}d] ${keyDate.title} (${keyDate.dueDate})`;
}

export function formatReminderTaskDescription(
  keyDate: Pick<KeyDate, 'title' | 'dueDate' | 'category' | 'notes'>,
  evaluated: EvaluatedReminderStage,
  escalationLevel: number = 0,
): string {
  const parts: string[] = [
    `Key date: ${keyDate.title}`,
    `Category: ${keyDate.category}`,
    `Due date: ${keyDate.dueDate}`,
    `Current reminder stage: ${evaluated.stageLabel}`,
  ];
  if (evaluated.isPastDue) {
    parts.push(
      'STATUS: Past due, unresolved. This key date has passed while still confirmed and remains at the top stage until resolved as met or missed.',
    );
  }
  if (escalationLevel > 0) {
    parts.push(`Escalation level: ${escalationLevel} (unacknowledged reminder)`);
  }
  if (keyDate.notes) {
    parts.push(`Notes: ${keyDate.notes}`);
  }
  return parts.join('\n');
}

/**
 * Filters a list of candidate recipient person IDs for a matter so that restricted (staff)
 * matters ONLY notify users in `matter.restrictedAccessUserIds`.
 */
export function filterRecipientsForMatterRestriction(
  candidatePersonIds: readonly PersonId[],
  matter:
    | Pick<Matter, 'id' | 'isStaffMatter' | 'restrictedAccessUserIds'>
    | null
    | undefined,
  people?: readonly Person[],
): PersonId[] {
  const unique = Array.from(new Set(candidatePersonIds.filter(Boolean)));
  if (!isMatterRestrictedForKeyDates(matter)) {
    return unique;
  }
  if (!matter || !matter.id) return [];
  return unique.filter((pid) =>
    canViewerAccessMatterKeyDates(
      matter,
      pid,
      undefined,
      people,
    ),
  );
}

/**
 * Resolves escalation target person IDs for a given escalation level token
 * (`'team_leads'` or `'role:<roleKey>'`), filtered by restricted matter access.
 */
export function resolveEscalationRecipientIds(
  levelSpec: string,
  keyDate: Pick<KeyDate, 'teamId'> & { matterId?: string },
  teams: readonly Team[],
  people: readonly Person[],
  matter:
    | Pick<Matter, 'id' | 'isStaffMatter' | 'restrictedAccessUserIds'>
    | null
    | undefined,
): PersonId[] {
  if (keyDate.matterId && !matter) {
    return [];
  }
  const candidates: PersonId[] = [];
  if (levelSpec === 'team_leads') {
    const team = teams.find((t) => t.id === keyDate.teamId);
    if (team) {
      candidates.push(...team.leadIds);
    }
  } else if (levelSpec.startsWith('role:')) {
    const roleKey = levelSpec.slice('role:'.length);
    for (const p of people) {
      if (!p.isEmployee || p.mergedIntoId) continue;
      const roles = resolveUserRoleKeysForKeyDates(p, teams);
      if (roles.includes(roleKey)) {
        candidates.push(p.id);
      }
    }
  }
  return filterRecipientsForMatterRestriction(candidates, matter, people);
}

export interface SyncReminderForConfirmedKeyDateParams {
  tenantId: string;
  keyDate: KeyDate;
  config: KeyDatesConfig;
  tasks: Task[];
  reminderStates: KeyDateReminderState[];
  matters?: readonly Matter[];
  people?: readonly Person[];
  audit?: AuditEntry[];
  nextAuditId?: () => string;
  todayIso: IsoDate;
  nowIso: IsoDateTime;
  actorId: PersonId;
  nextTaskId: () => string;
  /** When `keyDate` supersedes an existing key date, pass the superseded ID to hand over its Task. */
  transferredFromKeyDateId?: KeyDateId;
}

/**
 * Creates or updates the single reminder task and `KeyDateReminderState` when a key date
 * is confirmed (or supersedes a prior confirmed key date).
 * Never creates a second task for the same key date.
 */
export function syncReminderForConfirmedKeyDate(
  params: SyncReminderForConfirmedKeyDateParams,
): {
  task: Task | null;
  reminderState: KeyDateReminderState;
} {
  const {
    tenantId,
    keyDate,
    config,
    tasks,
    reminderStates,
    matters = [],
    people,
    audit,
    nextAuditId = () => `AU-KD-${Date.now()}-${Math.random()}`,
    todayIso,
    nowIso,
    actorId,
    nextTaskId,
    transferredFromKeyDateId,
  } = params;

  const schedule = resolveReminderScheduleForKeyDate(
    config,
    keyDate.keyDateTypeId,
  );
  const scheduleId = schedule?.id ?? 'standard';
  const idempotencyKey = buildKeyDateReminderIdempotencyKey(
    keyDate.id,
    tenantId,
  );
  const evaluated = evaluateActiveReminderStage(
    schedule,
    keyDate.dueDate,
    todayIso,
  );
  const matter = keyDate.matterId
    ? matters.find((m) => m.id === keyDate.matterId)
    : undefined;
  const isMissingMatter = Boolean(keyDate.matterId && !matter);
  const permittedAssignees = isMissingMatter
    ? []
    : filterRecipientsForMatterRestriction(
        keyDate.responsiblePersonIds,
        matter,
        people,
      );
  // R29 & R97: Never fall back to unfiltered responsiblePersonIds on a restricted or missing matter!
  const effectiveAssignees = permittedAssignees;
  const isRestrictedWithNoPermittedAssignees =
    (isMissingMatter ||
      Boolean(matter && isMatterRestrictedForKeyDates(matter))) &&
    effectiveAssignees.length === 0;

  // Check if there is an existing reminder state for this keyDate OR a superseded keyDate handing over its task
  let existingState = reminderStates.find((s) => s.keyDateId === keyDate.id);
  let existingTask: Task | undefined;

  if (!existingState && transferredFromKeyDateId) {
    const oldStateIdx = reminderStates.findIndex(
      (s) => s.keyDateId === transferredFromKeyDateId,
    );
    if (oldStateIdx >= 0) {
      const oldState = reminderStates[oldStateIdx]!;
      existingTask = tasks.find((t) => t.id === oldState.taskId);
      // Remove the old reminder state so the superseding key date takes over the same task
      reminderStates.splice(oldStateIdx, 1);
    }
  }

  if (!existingTask && existingState) {
    existingTask = tasks.find(
      (t) =>
        t.id === existingState!.taskId &&
        (!t.idempotencyKey || t.idempotencyKey === idempotencyKey),
    );
  }
  if (!existingTask) {
    existingTask = tasks.find((t) => t.idempotencyKey === idempotencyKey);
  }

  const linkedRecords: Task['linkedRecords'] = [];
  if (keyDate.matterId) {
    linkedRecords.push({ recordType: 'matter', recordId: keyDate.matterId });
  } else if (keyDate.enquiryId) {
    linkedRecords.push({ recordType: 'enquiry', recordId: keyDate.enquiryId });
  }

  if (isRestrictedWithNoPermittedAssignees) {
    if (existingTask) {
      const idx = tasks.indexOf(existingTask);
      if (idx >= 0) tasks.splice(idx, 1);
      existingTask = undefined;
    }
    if (audit) {
      audit.unshift({
        id: nextAuditId(),
        at: nowIso,
        byId: actorId || 'system',
        recordType: 'key_date',
        recordId: keyDate.id,
        action: 'keydate-reminder-escalate',
        field: 'responsiblePersonIds',
        oldValue: null,
        newValue: 'no_permitted_assignees',
        reason: isMissingMatter
          ? 'Skipped reminder task creation because the linked matter was not found.'
          : 'Skipped reminder task creation because no responsible person is permitted to access the restricted matter.',
      });
    }
  } else if (existingTask) {
    existingTask.title = formatReminderTaskTitle(keyDate, evaluated);
    existingTask.description = formatReminderTaskDescription(
      keyDate,
      evaluated,
      0,
    );
    existingTask.priorityId = mapReminderPriorityToTaskPriorityId(
      evaluated.priority,
    );
    existingTask.dueAt = keyDate.dueDate;
    existingTask.assignedTeamId = keyDate.teamId;
    existingTask.assignedPersonIds = [...effectiveAssignees];
    existingTask.assignedPersonId = effectiveAssignees[0] ?? null;
    existingTask.multiAssigneeMode = 'shared';
    existingTask.linkedRecords = linkedRecords;
    existingTask.linkedKeyDateId = keyDate.id;
    existingTask.idempotencyKey = idempotencyKey;
    if (existingTask.status === 'Done' || existingTask.status === 'Cancelled') {
      existingTask.status = 'To do';
      existingTask.completedAt = null;
      existingTask.completedById = null;
    }
    existingTask.updatedById = actorId;
    existingTask.updatedAt = nowIso;
  } else {
    const newId = nextTaskId();
    existingTask = {
      id: newId,
      reference: newId,
      title: formatReminderTaskTitle(keyDate, evaluated),
      description: formatReminderTaskDescription(keyDate, evaluated, 0),
      taskTypeId: 'task_type.filing_deadline',
      priorityId: mapReminderPriorityToTaskPriorityId(evaluated.priority),
      dueAt: keyDate.dueDate,
      assignedTeamId: keyDate.teamId,
      assignedPersonId: effectiveAssignees[0] ?? null,
      assignedPersonIds: [...effectiveAssignees],
      multiAssigneeMode: 'shared',
      status: 'To do',
      linkedRecords,
      linkedKeyDateId: keyDate.id,
      idempotencyKey,
      createdById: actorId,
      createdAt: nowIso,
      updatedById: actorId,
      updatedAt: nowIso,
      completedById: null,
      completedAt: null,
      comments: [],
    };
    tasks.push(existingTask);
  }

  const assignedTaskId = existingTask?.id ?? '';
  if (existingState) {
    existingState.taskId = assignedTaskId;
    existingState.idempotencyKey = idempotencyKey;
    existingState.reminderScheduleId = scheduleId;
    existingState.currentStageDaysBefore = evaluated.stageDaysBefore;
    existingState.stageEnteredAt = nowIso;
    existingState.acknowledgedById = undefined;
    existingState.acknowledgedAt = undefined;
    existingState.escalationLevel = isRestrictedWithNoPermittedAssignees ? 1 : 0;
    existingState.lastNotifiedAt = isRestrictedWithNoPermittedAssignees
      ? undefined
      : nowIso;
    existingState.lastSkippedReason = isRestrictedWithNoPermittedAssignees
      ? isMissingMatter
        ? 'missing_matter'
        : 'no_permitted_assignees'
      : undefined;
  } else {
    existingState = {
      keyDateId: keyDate.id,
      taskId: assignedTaskId,
      idempotencyKey,
      reminderScheduleId: scheduleId,
      currentStageDaysBefore: evaluated.stageDaysBefore,
      stageEnteredAt: nowIso,
      escalationLevel: isRestrictedWithNoPermittedAssignees ? 1 : 0,
      lastNotifiedAt: isRestrictedWithNoPermittedAssignees ? undefined : nowIso,
      ...(isRestrictedWithNoPermittedAssignees
        ? {
            lastSkippedReason: isMissingMatter
              ? ('missing_matter' as const)
              : ('no_permitted_assignees' as const),
          }
        : {}),
    };
    reminderStates.push(existingState);
  }

  return {
    task: existingTask ?? null,
    reminderState: existingState,
  };
}

/**
 * Closes the linked reminder task when a key date transitions to `met`, `missed`, `waived`,
 * or `superseded` (when not handed over to a confirmed superseding key date).
 */
export function closeReminderTaskForKeyDate(params: {
  keyDateId: KeyDateId;
  tenantId: string;
  tasks: Task[];
  reminderStates: KeyDateReminderState[];
  nowIso: IsoDateTime;
  actorId: PersonId;
}): Task | null {
  const { keyDateId, tenantId, tasks, reminderStates, nowIso, actorId } = params;
  const expectedIdempotencyKey = buildKeyDateReminderIdempotencyKey(
    keyDateId,
    tenantId,
  );
  const state = reminderStates.find(
    (s) =>
      s.keyDateId === keyDateId &&
      (!s.idempotencyKey || s.idempotencyKey === expectedIdempotencyKey),
  );
  const task = state
    ? tasks.find(
        (t) =>
          t.id === state.taskId &&
          (!t.idempotencyKey || t.idempotencyKey === expectedIdempotencyKey),
      )
    : tasks.find((t) => t.idempotencyKey === expectedIdempotencyKey);

  if (!task) return null;
  if (task.status !== 'Done') {
    task.status = 'Done';
    task.completedAt = nowIso;
    task.completedById = actorId;
    task.updatedAt = nowIso;
    task.updatedById = actorId;
  }
  return task;
}

/**
 * Acknowledges the current reminder stage for a key date and writes a `keydate-reminder-acknowledge` audit log entry.
 */
export function acknowledgeKeyDateReminderStage(params: {
  keyDateId: KeyDateId;
  actorId: PersonId;
  nowIso: IsoDateTime;
  reminderStates: KeyDateReminderState[];
  audit: AuditEntry[];
  nextAuditId: () => string;
}): KeyDateReminderState {
  const { keyDateId, actorId, nowIso, reminderStates, audit, nextAuditId } =
    params;
  const state = reminderStates.find((s) => s.keyDateId === keyDateId);
  if (!state) {
    throw new Error(
      `KEY_DATE_REMINDER_NOT_FOUND: No active reminder state found for key date "${keyDateId}".`,
    );
  }
  const beforeSnapshot = { ...state };
  state.acknowledgedById = actorId;
  state.acknowledgedAt = nowIso;

  audit.push({
    id: nextAuditId(),
    recordType: 'key_date',
    recordId: keyDateId,
    action: 'keydate-reminder-acknowledge',
    field: 'acknowledgedAt',
    oldValue: beforeSnapshot.acknowledgedAt ?? null,
    newValue: nowIso,
    byId: actorId,
    at: nowIso,
    snapshot: { before: beforeSnapshot, after: { ...state } },
  });

  return state;
}

export interface RunTenantKeyDateReminderJobInput {
  /** Required: scheduler job refuses to run without `tenantId`. */
  tenantId: string;
  correlationId?: string;
  /** Actor ID recorded on reminder tasks, notifications, and audit entries (`'system:key-date-reminders'` or manual `actor.personId`). */
  actorId?: PersonId;
  todayIso: IsoDate;
  nowIso?: IsoDateTime;
  config: KeyDatesConfig;
  keyDates: KeyDate[];
  reminderStates: KeyDateReminderState[];
  tasks: Task[];
  matters?: readonly Matter[];
  teams?: readonly Team[];
  people?: readonly Person[];
  notifications?: NotificationItem[];
  audit?: AuditEntry[];
  nextTaskId: () => string;
  nextNotificationId?: () => string;
  nextAuditId?: () => string;
}

export interface RunTenantKeyDateReminderJobResult {
  tenantId: string;
  evaluatedCount: number;
  stagesAdvancedCount: number;
  escalationsTriggeredCount: number;
  notificationsSentCount: number;
}

/**
 * Runs the daily per-tenant key date reminder scheduler job.
 * - Refuses to run without `tenantId`.
 * - Advances stages in place on the single linked `Task` (never creates duplicate tasks).
 * - Resets acknowledgement and sends one notification when crossing into a closer stage.
 * - Escalates unacknowledged stages after `afterUnacknowledgedDays` through `escalation.levels` in order.
 * - Safe and idempotent to re-run on the same day.
 */
export function runTenantKeyDateReminderJob(
  input: RunTenantKeyDateReminderJobInput,
): RunTenantKeyDateReminderJobResult {
  if (!input?.tenantId || !input.tenantId.trim()) {
    throw new Error(
      'TENANCY_JOB_ERROR: Key date reminder scheduler job refused to run without tenantId.',
    );
  }
  runTenantBackgroundJob(
    {
      jobId: `keydate-reminder-job:${input.tenantId}:${input.todayIso || 'today'}`,
      tenantId: input.tenantId,
      correlationId: `corr-kd-rem-${input.tenantId}-${input.todayIso || 'today'}`,
      payload: { todayIso: input.todayIso },
    },
    (job) => job.tenantId,
  );

  const {
    tenantId,
    todayIso,
    nowIso = `${todayIso}T08:00:00.000Z`,
    config,
    keyDates,
    reminderStates,
    tasks,
    matters = [],
    teams = [],
    people = [],
    notifications = [],
    audit = [],
    nextTaskId,
    nextNotificationId = () => `NTF-KD-${Date.now()}-${Math.random()}`,
    nextAuditId = () => `AU-KD-${Date.now()}-${Math.random()}`,
  } = input;
  const effectiveActorId = input.actorId?.trim() || 'system:key-date-reminders';

  if (!config?.enabled) {
    return {
      tenantId,
      evaluatedCount: 0,
      stagesAdvancedCount: 0,
      escalationsTriggeredCount: 0,
      notificationsSentCount: 0,
    };
  }

  let evaluatedCount = 0;
  let stagesAdvancedCount = 0;
  let escalationsTriggeredCount = 0;
  let notificationsSentCount = 0;

  for (const keyDate of keyDates) {
    if (keyDate.status !== 'confirmed') {
      continue;
    }

    evaluatedCount += 1;
    const schedule = resolveReminderScheduleForKeyDate(
      config,
      keyDate.keyDateTypeId,
    );
    const evaluated = evaluateActiveReminderStage(
      schedule,
      keyDate.dueDate,
      todayIso,
    );
    const matter = keyDate.matterId
      ? matters.find((m) => m.id === keyDate.matterId)
      : undefined;
    const isMissingMatter = Boolean(keyDate.matterId && !matter);

    let state = reminderStates.find((s) => s.keyDateId === keyDate.id);
    if (!state) {
      // First time seeing this confirmed date: create its single task and reminder state
      const synced = syncReminderForConfirmedKeyDate({
        tenantId,
        keyDate,
        config,
        tasks,
        reminderStates,
        matters,
        people,
        todayIso,
        nowIso,
        actorId: effectiveActorId,
        nextTaskId,
      });
      state = synced.reminderState;
      stagesAdvancedCount += 1;
      const recipients = isMissingMatter
        ? []
        : filterRecipientsForMatterRestriction(
            keyDate.responsiblePersonIds,
            matter,
            people,
          );
      if (recipients.length > 0 && synced.task) {
        notifications.push({
          id: nextNotificationId(),
          recipientId: recipients[0]!,
          kind: 'task_assigned',
          title: synced.task.title,
          detail: `Reminder stage (${evaluated.stageLabel}) active for ${keyDate.title}.`,
          href: keyDate.matterId
            ? `/matters/${keyDate.matterId}`
            : `/enquiries`,
          recordId: keyDate.matterId ?? keyDate.enquiryId ?? keyDate.id,
          createdAt: nowIso,
          read: false,
          byId: effectiveActorId,
        });
        notificationsSentCount += 1;
      } else if (
        isMissingMatter ||
        (matter && isMatterRestrictedForKeyDates(matter))
      ) {
        audit.push({
          id: nextAuditId(),
          recordType: 'key_date',
          recordId: keyDate.id,
          action: 'keydate-reminder-escalate',
          field: 'responsiblePersonIds',
          oldValue: null,
          newValue: 'no_permitted_assignees',
          byId: effectiveActorId,
          at: nowIso,
          reason: isMissingMatter
            ? 'Reminder skipped task creation because the linked matter was not found.'
            : 'Restricted matter reminder skipped task creation because no responsible person is permitted to access the matter.',
        });
      }
      continue;
    }

    const task =
      tasks.find(
        (t) =>
          t.id === state!.taskId &&
          (!t.idempotencyKey || t.idempotencyKey === state!.idempotencyKey),
      ) ?? tasks.find((t) => t.idempotencyKey === state!.idempotencyKey);

    // Did the date cross into a closer stage (e.g. 90 -> 60 days, or 0 -> -1 past due)?
    if (evaluated.stageDaysBefore < state.currentStageDaysBefore) {
      const permittedAssignees = isMissingMatter
        ? []
        : filterRecipientsForMatterRestriction(
            keyDate.responsiblePersonIds,
            matter,
            people,
          );
      const isRestrictedWithNoPermitted =
        (isMissingMatter ||
          Boolean(matter && isMatterRestrictedForKeyDates(matter))) &&
        permittedAssignees.length === 0;

      state.currentStageDaysBefore = evaluated.stageDaysBefore;
      state.stageEnteredAt = nowIso;
      state.acknowledgedById = undefined;
      state.acknowledgedAt = undefined;
      state.escalationLevel = isRestrictedWithNoPermitted ? 1 : 0;
      state.lastNotifiedAt = isRestrictedWithNoPermitted ? undefined : nowIso;
      state.lastSkippedReason = isRestrictedWithNoPermitted
        ? isMissingMatter
          ? 'missing_matter'
          : 'no_permitted_assignees'
        : undefined;

      if (isRestrictedWithNoPermitted) {
        if (task) {
          const idx = tasks.indexOf(task);
          if (idx >= 0) tasks.splice(idx, 1);
        }
        audit.push({
          id: nextAuditId(),
          recordType: 'key_date',
          recordId: keyDate.id,
          action: 'keydate-reminder-escalate',
          field: 'responsiblePersonIds',
          oldValue: null,
          newValue: 'no_permitted_assignees',
          byId: effectiveActorId,
          at: nowIso,
          reason: isMissingMatter
            ? 'Reminder stage advance skipped task assignment because the linked matter was not found.'
            : 'Restricted matter reminder stage advance skipped task assignment because no responsible person is permitted to access the matter.',
        });
      } else if (task) {
        task.title = formatReminderTaskTitle(keyDate, evaluated);
        task.description = formatReminderTaskDescription(keyDate, evaluated, 0);
        task.priorityId = mapReminderPriorityToTaskPriorityId(
          evaluated.priority,
        );
        task.dueAt = keyDate.dueDate;
        task.assignedTeamId = keyDate.teamId;
        task.assignedPersonIds = [...permittedAssignees];
        task.assignedPersonId = permittedAssignees[0] ?? null;
        if (task.status === 'Done' || task.status === 'Cancelled') {
          task.status = 'To do';
          task.completedAt = null;
          task.completedById = null;
        }
        task.updatedAt = nowIso;
        task.updatedById = effectiveActorId;
      }

      stagesAdvancedCount += 1;

      if (permittedAssignees.length > 0) {
        notifications.push({
          id: nextNotificationId(),
          recipientId: permittedAssignees[0]!,
          kind: 'task_assigned',
          title: formatReminderTaskTitle(keyDate, evaluated),
          detail: `Key date "${keyDate.title}" entered ${evaluated.stageLabel}. Please review and acknowledge.`,
          href: keyDate.matterId
            ? `/matters/${keyDate.matterId}`
            : `/enquiries`,
          recordId: keyDate.matterId ?? keyDate.enquiryId ?? keyDate.id,
          createdAt: nowIso,
          read: false,
          byId: effectiveActorId,
        });
        notificationsSentCount += 1;
      }
      continue;
    }

    // Same stage: check if unacknowledged and due for escalation (skip when linked matter is missing, R97)
    if (
      !isMissingMatter &&
      state.lastSkippedReason !== 'missing_matter' &&
      !state.acknowledgedAt &&
      schedule?.escalation
    ) {
      const stageEnteredDate = state.stageEnteredAt.slice(0, 10);
      const daysUnacknowledged = diffCalendarDays(stageEnteredDate, todayIso);
      const afterDays = schedule.escalation.afterUnacknowledgedDays ?? 2;
      const levels = schedule.escalation.levels ?? ['team_leads'];

      if (
        state.escalationLevel < levels.length &&
        daysUnacknowledged >= afterDays * (state.escalationLevel + 1)
      ) {
        const targetLevel = state.escalationLevel + 1;
        {
          const beforeState = { ...state };
          const levelSpec = levels[targetLevel - 1]!;
          const escalatedRecipients = resolveEscalationRecipientIds(
            levelSpec,
            keyDate,
            teams,
            people,
            matter,
          );

          state.escalationLevel = targetLevel;
          state.lastNotifiedAt = nowIso;

          if (task) {
            const mergedAssignees = Array.from(
              new Set([
                ...(task.assignedPersonIds ?? []),
                ...escalatedRecipients,
              ]),
            );
            task.assignedPersonIds = mergedAssignees;
            task.description = formatReminderTaskDescription(
              keyDate,
              evaluated,
              targetLevel,
            );
            task.updatedAt = nowIso;
            task.updatedById = effectiveActorId;
          }

          audit.push({
            id: nextAuditId(),
            recordType: 'key_date',
            recordId: keyDate.id,
            action: 'keydate-reminder-escalate',
            field: 'escalationLevel',
            oldValue: String(beforeState.escalationLevel),
            newValue: String(targetLevel),
            byId: effectiveActorId,
            at: nowIso,
            reason: `Stage (${state.currentStageDaysBefore}d) unacknowledged after ${daysUnacknowledged} days; escalated to ${levelSpec}.`,
            snapshot: { before: beforeState, after: { ...state } },
          });

          escalationsTriggeredCount += 1;

          const notifyTarget = isMissingMatter
            ? undefined
            : (escalatedRecipients[0] ??
              filterRecipientsForMatterRestriction(
                keyDate.responsiblePersonIds,
                matter,
                people,
              )[0]);
          if (notifyTarget) {
            notifications.push({
              id: nextNotificationId(),
              recipientId: notifyTarget,
              kind: 'task_assigned',
              title: `[Escalation L${targetLevel}] ${keyDate.title}`,
              detail: `Unacknowledged key date reminder escalated to ${levelSpec}.`,
              href: keyDate.matterId
                ? `/matters/${keyDate.matterId}`
                : `/enquiries`,
              recordId: keyDate.matterId ?? keyDate.enquiryId ?? keyDate.id,
              createdAt: nowIso,
              read: false,
              byId: effectiveActorId,
            });
            notificationsSentCount += 1;
          }
        }
      }
    }
  }

  return {
    tenantId,
    evaluatedCount,
    stagesAdvancedCount,
    escalationsTriggeredCount,
    notificationsSentCount,
  };
}
