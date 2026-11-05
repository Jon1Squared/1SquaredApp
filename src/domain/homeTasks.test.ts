import { describe, expect, it } from 'vitest';
import { selectHomeCandidateTasks } from './homeTasks';
import type { Task } from './types';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    reference: overrides.reference ?? `TSK-${overrides.id}`,
    title: overrides.title ?? `Task ${overrides.id}`,
    description: '',
    taskTypeId: 'task_type.follow_up',
    priorityId: 'task_priority.normal',
    dueAt: overrides.dueAt ?? '2026-10-14',
    assignedTeamId: overrides.assignedTeamId ?? null,
    assignedPersonId: overrides.assignedPersonId ?? null,
    status: overrides.status ?? 'To do',
    linkedRecords: [],
    createdById: 'P-000001',
    createdAt: '2026-10-01T09:00:00Z',
    updatedById: 'P-000001',
    updatedAt: '2026-10-01T09:00:00Z',
    completedById: null,
    completedAt: null,
    comments: [],
  };
}

describe('selectHomeCandidateTasks (R219)', () => {
  const sampleTasks: Task[] = [
    makeTask({
      id: '1',
      assignedPersonId: 'P-000002',
      assignedTeamId: 'TM-000001',
      dueAt: '2026-10-15',
    }),
    makeTask({
      id: '2',
      assignedPersonId: 'P-000002',
      assignedTeamId: 'TM-000001',
      dueAt: '2026-10-14',
    }),
    makeTask({
      id: '3',
      assignedPersonId: 'P-000002',
      assignedTeamId: 'TM-000001',
      status: 'Done',
      dueAt: '2026-10-13',
    }),
    makeTask({
      id: '4',
      assignedPersonId: 'P-000005',
      assignedTeamId: 'TM-000002',
      dueAt: '2026-10-14',
    }),
    makeTask({
      id: '5',
      assignedPersonId: null,
      assignedTeamId: 'TM-000003',
      dueAt: '2026-10-14',
    }),
  ];

  it('returns only the user’s own open tasks (sorted by dueAt) when the user has assigned open tasks', () => {
    const result = selectHomeCandidateTasks({
      tasks: sampleTasks,
      currentUserId: 'P-000002',
      myTeamIds: new Set(['TM-000001', 'TM-000002']),
    });
    expect(result.map((t) => t.id)).toEqual(['2', '1']);
  });

  it('falls back to open tasks assigned to the user’s teams when the user has no directly assigned open tasks', () => {
    const result = selectHomeCandidateTasks({
      tasks: sampleTasks,
      currentUserId: 'P-000099',
      myTeamIds: new Set(['TM-000002']),
    });
    expect(result.map((t) => t.id)).toEqual(['4']);
  });

  it('falls back to all open visible firm tasks when the user has no directly assigned open tasks and belongs to no teams', () => {
    const result = selectHomeCandidateTasks({
      tasks: sampleTasks,
      currentUserId: 'P-000004',
      myTeamIds: new Set(),
    });
    expect(result.map((t) => t.id)).toEqual(['1', '2', '4', '5']);
  });
});
