import { isTaskOpen } from './tasks';
import type { Task } from './types';

/**
 * Selects the candidate open tasks for a user's Home page KPI card (`fe_tasks_due`)
 * and `To Do` panel:
 * 1. If the user (or effective work person) has open tasks directly assigned to them,
 *    returns those open tasks sorted by `dueAt`.
 * 2. Otherwise, falls back to open tasks assigned to any of `myTeamIds`, or all open
 *    tasks in `tasks` when `myTeamIds.size === 0`.
 *
 * `tasks` must be the already server-filtered `visibleTasks` (`snap.tasks`) so
 * restricted/staff-matter isolation is preserved.
 */
export function selectHomeCandidateTasks(params: {
  tasks: readonly Task[];
  currentUserId: string;
  effectiveWorkPersonId?: string;
  myTeamIds: ReadonlySet<string>;
}): Task[] {
  const effectiveId = params.effectiveWorkPersonId ?? params.currentUserId;
  const myOpenTasks = params.tasks
    .filter(
      (t) =>
        isTaskOpen(t) &&
        (t.assignedPersonId === effectiveId || t.assignedPersonId === params.currentUserId),
    )
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  if (myOpenTasks.length > 0) {
    return myOpenTasks;
  }

  return params.tasks.filter(
    (t) =>
      isTaskOpen(t) &&
      (params.myTeamIds.size === 0 ||
        (t.assignedTeamId !== null && params.myTeamIds.has(t.assignedTeamId))),
  );
}
