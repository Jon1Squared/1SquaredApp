'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { saveTaskAction, takeTaskAction } from '@/app/actions';
import { formatDate, formatDateTime, toIsoDate } from '@/domain/dates';
import { resolveLabel, valuesForList } from '@/domain/lists';
import { personDisplayName } from '@/domain/names';
import {
  canUserTakeTask,
  isTaskOpen,
  isTaskOverdue,
  tasksForRecord,
} from '@/domain/tasks';
import type {
  ChoiceValue,
  Person,
  Task,
  TaskLinkedRecordType,
  TaskStatus,
  Team,
} from '@/domain/types';
import {
  CreateTaskModal,
  type CreateTaskSubmitPayload,
  type SuggestedTaskAssignee,
} from './CreateTaskModal';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  recordType: TaskLinkedRecordType;
  recordId: string;
  recordLabel: string;
  defaultTeamId?: string | null;
  defaultPersonId?: string | null;
  tasks: Task[];
  teams: Team[];
  people: Person[];
  values: ChoiceValue[];
  currentUserId: string;
  canClaimAnyTask?: boolean;
  canTakeByTaskId?: Record<string, boolean>;
}

export function RecordTasksSection({
  recordType,
  recordId,
  recordLabel,
  defaultTeamId,
  defaultPersonId,
  tasks,
  teams,
  people,
  values,
  currentUserId,
  canClaimAnyTask = false,
  canTakeByTaskId,
}: Props) {
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [showCompleted, setShowCompleted] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const taskTypes = useMemo(
    () => valuesForList(values, 'task_type').filter((v) => v.active),
    [values],
  );
  const taskPriorities = useMemo(
    () => valuesForList(values, 'task_priority').filter((v) => v.active),
    [values],
  );
  const employees = useMemo(
    () =>
      people
        .filter((p) => p.isEmployee && !p.mergedIntoId)
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b))),
    [people],
  );
  const activeTeams = useMemo(() => teams.filter((t) => t.active), [teams]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [taskTypeId, setTaskTypeId] = useState(
    () => taskTypes.find((t) => t.label === 'General')?.id ?? taskTypes[0]?.id ?? '',
  );
  const [priorityId, setPriorityId] = useState(
    () => taskPriorities.find((p) => p.label === 'Normal')?.id ?? taskPriorities[0]?.id ?? '',
  );
  const [dueAt, setDueAt] = useState(() => toIsoDate(new Date()));
  const [assignedTeamId, setAssignedTeamId] = useState<string>(defaultTeamId ?? '');
  const [assignedPersonId, setAssignedPersonId] = useState<string>(
    defaultPersonId ?? currentUserId,
  );

  const recordTasks = useMemo(
    () => tasksForRecord(tasks, recordType, recordId),
    [tasks, recordType, recordId],
  );
  const openTasks = useMemo(() => recordTasks.filter(isTaskOpen), [recordTasks]);
  const completedTasks = useMemo(() => recordTasks.filter((t) => !isTaskOpen(t)), [recordTasks]);

  const nameOfPerson = (id: string | null | undefined) => {
    if (!id) return '';
    const p = people.find((x) => x.id === id);
    return p ? personDisplayName(p) : id;
  };
  const nameOfTeam = (id: string | null | undefined) => {
    if (!id) return '';
    const tm = teams.find((x) => x.id === id);
    return tm ? tm.name : id;
  };

  const openNewModal = () => {
    setModalOpen(true);
  };

  const suggestedAssignees = useMemo<SuggestedTaskAssignee[]>(() => {
    const seen = new Set<string>();
    const list: SuggestedTaskAssignee[] = [];
    const addPerson = (personId: string | null | undefined, badgeLabel: string) => {
      if (!personId || seen.has(personId)) return;
      const emp = employees.find((e) => e.id === personId);
      if (!emp) return;
      seen.add(personId);
      list.push({ person: emp, badgeLabel });
    };

    addPerson(defaultPersonId ?? currentUserId, 'Fee earner');
    const leadEmp = employees.find((e) => e.id === (defaultPersonId ?? currentUserId));
    if (leadEmp?.employment?.supervisingPartnerId) {
      addPerson(leadEmp.employment.supervisingPartnerId, 'Supervising partner');
    }
    const colpEmp =
      employees.find((e) => e.id === 'P-000003') ??
      employees.find((e) =>
        (e.employment?.jobTitle || e.jobTitle || '').toLowerCase().includes('colp'),
      );
    if (colpEmp) addPerson(colpEmp.id, 'COLP');

    const practiceMgrEmp = employees.find((e) =>
      (e.employment?.jobTitle || e.jobTitle || '').toLowerCase().includes('practice manager'),
    );
    if (practiceMgrEmp) addPerson(practiceMgrEmp.id, 'Practice manager');

    return list;
  }, [employees, defaultPersonId, currentUserId]);

  const handleCreateTask = (payload: CreateTaskSubmitPayload) => {
    startTransition(async () => {
      const res = await saveTaskAction({
        title: payload.title,
        description: payload.details || undefined,
        taskTypeId,
        priorityId,
        dueAt: payload.dueAtIso,
        assignedTeamId: defaultTeamId || null,
        assignedPersonId: payload.assignedPersonIds[0] ?? null,
        assignedPersonIds: payload.assignedPersonIds,
        multiAssigneeMode: payload.multiAssigneeMode,
        linkedRecords: [{ recordType, recordId }],
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setModalOpen(false);
      showToast('Task created');
    });
  };

  const handleQuickStatus = (task: Task, status: TaskStatus) => {
    startTransition(async () => {
      await saveTaskAction({
        id: task.id,
        title: task.title,
        description: task.description,
        taskTypeId: task.taskTypeId,
        priorityId: task.priorityId,
        dueAt: task.dueAt,
        assignedTeamId: task.assignedTeamId,
        assignedPersonId: task.assignedPersonId || currentUserId,
        status,
        linkedRecords: task.linkedRecords,
      });
      showToast(status === 'Done' ? 'Task completed' : `Task marked ${status}`);
    });
  };

  const handleTakeTask = (task: Task) => {
    startTransition(async () => {
      await takeTaskAction(task.id);
      showToast('Task claimed');
    });
  };

  const priorityTone = (label: string): 'warning' | 'neutral' | 'positive' => {
    const l = label.toLowerCase();
    if (l === 'urgent' || l === 'high') return 'warning';
    return 'neutral';
  };

  const renderTaskRow = (t: Task) => {
    const overdue = isTaskOverdue(t);
    const prioLabel = resolveLabel(values, t.priorityId) || 'Normal';
    const typeLabel = resolveLabel(values, t.taskTypeId) || 'General';
    const assigneeLabel = [
      t.assignedTeamId ? nameOfTeam(t.assignedTeamId) : '',
      t.assignedPersonId ? nameOfPerson(t.assignedPersonId) : 'Unclaimed',
    ]
      .filter(Boolean)
      .join(' · ');
    const canTake =
      canTakeByTaskId && t.id in canTakeByTaskId
        ? Boolean(canTakeByTaskId[t.id])
        : canUserTakeTask(
            currentUserId,
            t,
            teams,
            people,
            values,
            canClaimAnyTask ? ['task:claim_any'] : [],
          );

    return (
      <div key={t.id} className="list-row">
        <div className="list-row__main">
          <div className="list-row__title">
            <Link href={`/tasks/${t.id}`}>
              <span className="muted" style={{ fontWeight: 500, marginRight: 6 }}>
                {t.reference}
              </span>
              {t.title}
            </Link>{' '}
            <StatusPill label={typeLabel} tone="neutral" />{' '}
            <StatusPill label={prioLabel} tone={priorityTone(prioLabel)} />{' '}
            {overdue ? <StatusPill label="Overdue" tone="warning" /> : null}
            {!isTaskOpen(t) ? <StatusPill label={t.status} tone="positive" /> : null}
          </div>
          {t.description ? <div className="list-row__meta">{t.description}</div> : null}
          <div className="list-row__meta">
            Due:{' '}
            <strong style={overdue ? { color: 'var(--warning)' } : undefined}>
              {t.dueAt.includes('T') ? formatDateTime(t.dueAt) : formatDate(t.dueAt)}
            </strong>{' '}
            · Assigned to: {assigneeLabel} · Status: {t.status}
          </div>
        </div>
        <div className="list-row__aside">
          {canTake ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={pending}
              onClick={() => handleTakeTask(t)}
            >
              Take
            </button>
          ) : null}
          {isTaskOpen(t) && t.status === 'To do' ? (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={pending}
              onClick={() => handleQuickStatus(t, 'In progress')}
            >
              Start
            </button>
          ) : null}
          {isTaskOpen(t) ? (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={pending}
              onClick={() => handleQuickStatus(t, 'Done')}
            >
              Complete
            </button>
          ) : null}
          <Link href={`/tasks/${t.id}`} className="btn btn--ghost btn--sm">
            Open
          </Link>
        </div>
      </div>
    );
  };

  return (
    <section className="profile-section" aria-label="Tasks on this record">
      <div className="profile-section__header">
        <h2>
          Tasks ({openTasks.length} open
          {completedTasks.length > 0 ? ` · ${completedTasks.length} done/cancelled` : ''})
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {completedTasks.length > 0 ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setShowCompleted((v) => !v)}
            >
              {showCompleted
                ? 'Hide completed'
                : `Show completed (${completedTasks.length})`}
            </button>
          ) : null}
          <button type="button" className="btn btn--secondary btn--sm" onClick={openNewModal}>
            + New task
          </button>
        </div>
      </div>

      {openTasks.length === 0 && (!showCompleted || completedTasks.length === 0) ? (
        <p className="muted">No open tasks linked to this record.</p>
      ) : (
        <div>
          {openTasks.map(renderTaskRow)}
          {showCompleted && completedTasks.map(renderTaskRow)}
        </div>
      )}

      <CreateTaskModal
        open={modalOpen}
        headerTitle="Create task"
        headerSubtitle={`Create a task on ${recordLabel} and assign it to one or more people.`}
        peopleSectionLabel={
          recordType === 'matter' ? 'PEOPLE ON THIS MATTER' : 'PEOPLE ON THIS RECORD'
        }
        initialTaskName=""
        taskNamePlaceholder={`Task for ${recordLabel}`}
        suggestedPeople={suggestedAssignees}
        initialSelectedPersonIds={[defaultPersonId ?? currentUserId]}
        employees={employees}
        values={values}
        defaultDueHoursFromNow={48}
        submitting={pending}
        submitLabel="Create task"
        onClose={() => setModalOpen(false)}
        onSubmit={handleCreateTask}
      />
    </section>
  );
}
