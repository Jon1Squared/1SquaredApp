/**
 * Domain logic for Tasks and Teams: assignment rules, overdue checks,
 * permission helpers, and grouping for My Tasks / Team Tasks / Created by me.
 */
import { toIsoDate } from './dates';
import { resolveLabel, valueBySystemKey } from './lists';
import {
  IMMUTABLE_EMPLOYEE_ROLE_ID_TO_ROLE_KEY,
  resolvePersonAuthoritativeRoles,
  resolvePersonPermissionSet,
  type ResolvePersonPermissionsOptions,
} from './rbac';
import type {
  AppRole,
  ChoiceValue,
  Person,
  Task,
  TaskLinkedRecordType,
  TaskStatus,
  Team,
} from './types';

export const OPEN_TASK_STATUSES = new Set<TaskStatus>(['To do', 'In progress', 'Waiting']);

export function isTaskOpen(task: Task): boolean {
  return OPEN_TASK_STATUSES.has(task.status);
}

function parseDueDate(dueAt: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) {
    const [y, m, d] = dueAt.split('-').map(Number);
    // Date-only due dates expire at the end of the day (17:30)
    return new Date(y, m - 1, d, 17, 30, 0, 0);
  }
  return new Date(dueAt);
}

/** A task past its due time and not Done or Cancelled is overdue. */
export function isTaskOverdue(task: Task, now: Date = new Date()): boolean {
  if (!isTaskOpen(task) || !task.dueAt) return false;
  const due = parseDueDate(task.dueAt);
  return !isNaN(due.getTime()) && due.getTime() < now.getTime();
}

export function isTaskDueToday(task: Task, now: Date = new Date()): boolean {
  if (!isTaskOpen(task) || !task.dueAt) return false;
  const dueIso = task.dueAt.slice(0, 10);
  const todayIso = toIsoDate(now);
  return dueIso === todayIso && !isTaskOverdue(task, now);
}

export function isTaskDueThisWeek(task: Task, now: Date = new Date()): boolean {
  if (!isTaskOpen(task) || !task.dueAt) return false;
  if (isTaskOverdue(task, now) || isTaskDueToday(task, now)) return false;
  const due = parseDueDate(task.dueAt);
  const endOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, 23, 59, 59);
  return due.getTime() <= endOfWeek.getTime();
}

export function isTaskAssignedToPerson(task: Task, userId: string): boolean {
  if (task.assignedPersonId === userId) return true;
  if (Array.isArray(task.assignedPersonIds) && task.assignedPersonIds.includes(userId)) {
    return true;
  }
  return false;
}

/** Count of user's open tasks that are overdue or due today (for the left-rail badge). */
export function countMyUrgentBadgeTasks(
  tasks: Task[],
  userId: string,
  now: Date = new Date(),
): number {
  return tasks.filter(
    (t) =>
      isTaskAssignedToPerson(t, userId) &&
      isTaskOpen(t) &&
      (isTaskOverdue(t, now) || isTaskDueToday(t, now)),
  ).length;
}

export interface MyTasksBuckets {
  overdue: Task[];
  today: Task[];
  dueToday: Task[];
  thisWeek: Task[];
  dueThisWeek: Task[];
  later: Task[];
  done: Task[];
}

export function groupMyTasks(
  tasks: Task[],
  userId: string,
  now: Date = new Date(),
): MyTasksBuckets {
  const mine = tasks
    .filter((t) => isTaskAssignedToPerson(t, userId))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  const overdue: Task[] = [];
  const today: Task[] = [];
  const thisWeek: Task[] = [];
  const later: Task[] = [];
  const done: Task[] = [];

  for (const t of mine) {
    if (!isTaskOpen(t)) {
      done.push(t);
    } else if (isTaskOverdue(t, now)) {
      overdue.push(t);
    } else if (isTaskDueToday(t, now)) {
      today.push(t);
    } else if (isTaskDueThisWeek(t, now)) {
      thisWeek.push(t);
    } else {
      later.push(t);
    }
  }

  done.sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt));
  return { overdue, today, dueToday: today, thisWeek, dueThisWeek: thisWeek, later, done };
}

/**
 * Resolve legacy coarse application role (`AppRole`) for an employee from
 * authoritative RBAC role keys and permissions (never from display labels).
 * @deprecated Prefer `hasPersonPermission` / `resolvePersonPermissionSet`.
 */
export function resolveUserAppRole(
  person: Person | null | undefined,
  teams: Team[],
  _values: ChoiceValue[] = [],
  rbacOptions?: ResolvePersonPermissionsOptions,
): AppRole {
  if (!person) return 'fee_earner';
  if (person.appRole) return person.appRole;
  const roles = resolvePersonAuthoritativeRoles(person, teams);
  const perms = resolvePersonPermissionSet(person, {
    ...rbacOptions,
    teams,
  });
  if (roles.includes('admin') || person.employeeRoleId === 'employee_role.system_administrator') {
    return 'admin';
  }
  if (teams.some((tm) => tm.active && tm.leadIds.includes(person.id))) return 'team_lead';
  if (
    roles.includes('partner') ||
    roles.includes('managing_partner') ||
    (person.employeeRoleId != null &&
      (IMMUTABLE_EMPLOYEE_ROLE_ID_TO_ROLE_KEY[person.employeeRoleId] === 'partner' ||
        IMMUTABLE_EMPLOYEE_ROLE_ID_TO_ROLE_KEY[person.employeeRoleId] === 'managing_partner'))
  ) {
    return 'team_lead';
  }
  if (
    roles.includes('enquiries_coordinator') ||
    roles.includes('intake') ||
    person.employeeRoleId === 'employee_role.support_staff' ||
    (!perms.has('finance:view_matter') && !perms.has('finance:view'))
  ) {
    return 'call_handler';
  }
  return 'fee_earner';
}

export function isUserTeamLeadFor(userId: string, teamId: string | null, teams: Team[]): boolean {
  if (!teamId) return false;
  const tm = teams.find((t) => t.id === teamId);
  return Boolean(tm && tm.leadIds.includes(userId));
}

export function userTeams(userId: string, teams: Team[]): Team[] {
  return teams.filter((t) => t.active && (t.memberIds.includes(userId) || t.leadIds.includes(userId)));
}

/**
 * Assignment rule 4: The creator, the assignee, a lead of the assigned team, or a holder of `task:reassign_any` can reassign.
 */
export function canUserReassignTask(
  userId: string,
  task: Task,
  teams: Team[],
  people: Person[],
  _values: ChoiceValue[] = [],
  userPermissions?: Iterable<string>,
  rbacOptions?: ResolvePersonPermissionsOptions,
): boolean {
  if (userPermissions) {
    const perms = new Set(userPermissions);
    if (perms.has('task:reassign_any')) return true;
  } else {
    const user = people.find((p) => p.id === userId) ?? null;
    if (user) {
      const perms = resolvePersonPermissionSet(user, {
        ...rbacOptions,
        allPeople: people,
        teams,
      });
      if (perms.has('task:reassign_any')) return true;
    }
  }
  if (task.createdById === userId || isTaskAssignedToPerson(task, userId)) return true;
  if (isUserTeamLeadFor(userId, task.assignedTeamId, teams)) return true;
  return false;
}

/**
 * Assignment rule 1: Any member of the assigned team (or a holder of `task:claim_any`) can Take an unclaimed team task.
 */
export function canUserTakeTask(
  userId: string,
  task: Task,
  teams: Team[],
  people: Person[],
  _values: ChoiceValue[] = [],
  userPermissions?: Iterable<string>,
  rbacOptions?: ResolvePersonPermissionsOptions,
): boolean {
  if (task.assignedPersonId) return false;
  if (!task.assignedTeamId) return true;
  if (userPermissions) {
    const perms = new Set(userPermissions);
    if (perms.has('task:claim_any')) return true;
  } else {
    const user = people.find((p) => p.id === userId) ?? null;
    if (user) {
      const perms = resolvePersonPermissionSet(user, {
        ...rbacOptions,
        allPeople: people,
        teams,
      });
      if (perms.has('task:claim_any')) return true;
    }
  }
  const team = teams.find((t) => t.id === task.assignedTeamId);
  if (!team) return false;
  return team.memberIds.includes(userId) || team.leadIds.includes(userId);
}

/** Return tasks linked to a specific record. */
export function tasksForRecord(
  tasks: Task[],
  recordType: TaskLinkedRecordType,
  recordId: string,
): Task[] {
  return tasks
    .filter((t) =>
      t.linkedRecords.some((lr) => lr.recordType === recordType && lr.recordId === recordId),
    )
    .sort((a, b) => {
      const aOpen = isTaskOpen(a) ? 0 : 1;
      const bOpen = isTaskOpen(b) ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return a.dueAt.localeCompare(b.dueAt);
    });
}

/** Detect practice area routing clashes across active teams. */
export function findPracticeAreaRoutingClashes(
  teams: Team[],
  values: ChoiceValue[] = [],
): { practiceAreaId: string; practiceAreaLabel: string; teamIds: string[]; teamNames: string[] }[] {
  const map = new Map<string, { ids: string[]; names: string[] }>();
  for (const t of teams) {
    if (!t.active) continue;
    for (const paId of t.practiceAreaIds) {
      const existing = map.get(paId) ?? { ids: [], names: [] };
      existing.ids.push(t.id);
      existing.names.push(t.name);
      map.set(paId, existing);
    }
  }
  const clashes: { practiceAreaId: string; practiceAreaLabel: string; teamIds: string[]; teamNames: string[] }[] = [];
  for (const [paId, entry] of map.entries()) {
    if (entry.names.length > 1) {
      clashes.push({
        practiceAreaId: paId,
        practiceAreaLabel: resolveLabel(values, paId) || paId,
        teamIds: entry.ids,
        teamNames: entry.names,
      });
    }
  }
  return clashes;
}

/** Find the active team routed for a practice area, or fallback to the Intake team. */
export function resolveRoutedTeam(
  practiceAreaId: string,
  teams: Team[],
): { team: Team | null; isFallbackIntake: boolean } {
  const activeTeams = teams.filter((t) => t.active);
  const matched = activeTeams.find((t) => t.practiceAreaIds.includes(practiceAreaId));
  if (matched) {
    return { team: matched, isFallbackIntake: false };
  }
  const intake =
    activeTeams.find((t) => t.name.toLowerCase() === 'intake') ??
    activeTeams.find((t) => t.name.toLowerCase().includes('intake')) ??
    null;
  return { team: intake, isFallbackIntake: true };
}

/**
 * Returns true when a task is a compliance or matter-opening task, resolving
 * `task_type` values strictly by `systemKey` (`conflict_check`,
 * `complete_matter_opening`) via `valueBySystemKey` (R352, R372).
 */
export function isComplianceOrOnboardingTask(
  task: Pick<Task, 'taskTypeId'>,
  values: ChoiceValue[] = [],
): boolean {
  if (!task.taskTypeId) return false;
  const conflictCheckTypeId = valueBySystemKey(values, 'task_type', 'conflict_check')?.id;
  const completeOpeningTypeId = valueBySystemKey(
    values,
    'task_type',
    'complete_matter_opening',
  )?.id;
  return (
    (conflictCheckTypeId !== undefined && task.taskTypeId === conflictCheckTypeId) ||
    (completeOpeningTypeId !== undefined && task.taskTypeId === completeOpeningTypeId)
  );
}
