'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { addTaskCommentAction, saveTaskAction, takeTaskAction } from '@/app/actions';
import { formatDate, formatDateTime } from '@/domain/dates';
import { enquiryDisplayName } from '@/domain/enquiries';
import { resolveLabel, valuesForList } from '@/domain/lists';
import { hrefForId, personDisplayName } from '@/domain/names';
import { canUserReassignTask, canUserTakeTask, isTaskOpen, isTaskOverdue } from '@/domain/tasks';
import type {
  AuditEntry,
  ChoiceValue,
  Enquiry,
  Matter,
  Organisation,
  Person,
  Task,
  TaskLinkedRecord,
  TaskLinkedRecordType,
  TaskStatus,
  Team,
} from '@/domain/types';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  task: Task;
  teams: Team[];
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
  enquiries: Enquiry[];
  values: ChoiceValue[];
  audit: AuditEntry[];
  currentUserId: string;
}

export function TaskDetailClient({
  task,
  teams,
  people,
  organisations,
  matters,
  enquiries,
  values,
  audit,
  currentUserId,
}: Props) {
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [taskTypeId, setTaskTypeId] = useState(task.taskTypeId);
  const [priorityId, setPriorityId] = useState(task.priorityId);
  const [dueAt, setDueAt] = useState(task.dueAt.slice(0, 10));
  const [assignedTeamId, setAssignedTeamId] = useState(task.assignedTeamId ?? '');
  const [assignedPersonId, setAssignedPersonId] = useState(task.assignedPersonId ?? '');
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [linkedRecords, setLinkedRecords] = useState<TaskLinkedRecord[]>(task.linkedRecords);
  const [linkRecordType, setLinkRecordType] = useState<TaskLinkedRecordType>('enquiry');
  const [linkRecordId, setLinkRecordId] = useState('');

  const [commentText, setCommentText] = useState('');

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

  const resolveLinkedRecordTitle = (lr: TaskLinkedRecord) => {
    if (lr.recordType === 'enquiry') {
      const e = enquiries.find((x) => x.id === lr.recordId);
      return e
        ? `Enquiry: ${e.reference} — ${enquiryDisplayName(e)} (${e.summary})`
        : `Enquiry: ${lr.recordId}`;
    }
    if (lr.recordType === 'matter') {
      const m = matters.find((x) => x.id === lr.recordId);
      return m ? `Matter: ${m.matterNumber} — ${m.title}` : `Matter: ${lr.recordId}`;
    }
    if (lr.recordType === 'person') {
      const p = people.find((x) => x.id === lr.recordId);
      return p ? `Person: ${personDisplayName(p)} (${p.id})` : `Person: ${lr.recordId}`;
    }
    const o = organisations.find((x) => x.id === lr.recordId);
    return o ? `Organisation: ${o.legalName} (${o.id})` : `Organisation: ${lr.recordId}`;
  };

  const availableRecordsForType = useMemo(() => {
    if (linkRecordType === 'enquiry') {
      return enquiries.map((e) => ({
        id: e.id,
        label: `${e.reference} — ${enquiryDisplayName(e)} (${e.summary})`,
      }));
    }
    if (linkRecordType === 'matter') {
      return matters.map((m) => ({
        id: m.id,
        label: `${m.matterNumber} — ${m.title}`,
      }));
    }
    if (linkRecordType === 'person') {
      return people
        .filter((p) => !p.mergedIntoId)
        .map((p) => ({
          id: p.id,
          label: `${personDisplayName(p)} (${p.id})`,
        }));
    }
    return organisations
      .filter((o) => !o.mergedIntoId)
      .map((o) => ({
        id: o.id,
        label: `${o.legalName} (${o.id})`,
      }));
  }, [linkRecordType, enquiries, matters, people, organisations]);

  const overdue = isTaskOverdue(task);
  const canTake = canUserTakeTask(currentUserId, task, teams, people, values);
  const canReassign = canUserReassignTask(currentUserId, task, teams, people, values);
  const prioLabel = resolveLabel(values, task.priorityId) || 'Normal';
  const typeLabel = resolveLabel(values, task.taskTypeId) || 'General';

  const handleQuickStatus = (nextStatus: TaskStatus) => {
    startTransition(async () => {
      const res = await saveTaskAction({
        id: task.id,
        title: task.title,
        description: task.description,
        taskTypeId: task.taskTypeId,
        priorityId: task.priorityId,
        dueAt: task.dueAt,
        assignedTeamId: task.assignedTeamId,
        assignedPersonId: task.assignedPersonId || currentUserId,
        status: nextStatus,
        linkedRecords: task.linkedRecords,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setStatus(nextStatus);
      showToast(`Task marked ${nextStatus}`);
    });
  };

  const handleTake = () => {
    startTransition(async () => {
      await takeTaskAction(task.id);
      setAssignedPersonId(currentUserId);
      showToast('Task claimed');
    });
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (!assignedTeamId && !assignedPersonId) {
      showToast('Assign the task to a team, a person, or both');
      return;
    }
    startTransition(async () => {
      const res = await saveTaskAction({
        id: task.id,
        title: title.trim(),
        description: description.trim(),
        taskTypeId,
        priorityId,
        dueAt,
        assignedTeamId: assignedTeamId || null,
        assignedPersonId: assignedPersonId || null,
        status,
        linkedRecords,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setEditing(false);
      showToast('Task updated');
    });
  };

  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    startTransition(async () => {
      const res = await addTaskCommentAction(task.id, commentText.trim());
      if (res.error) {
        showToast(res.error);
        return;
      }
      setCommentText('');
      showToast('Comment added');
    });
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
            <Link href="/tasks">← Back to Tasks</Link>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h1>{task.title}</h1>
            <StatusPill label={task.reference} tone="neutral" />
            <StatusPill label={typeLabel} tone="neutral" />
            <StatusPill
              label={prioLabel}
              tone={
                prioLabel.toLowerCase() === 'urgent' || prioLabel.toLowerCase() === 'high'
                  ? 'warning'
                  : 'neutral'
              }
            />
            <StatusPill
              label={task.status}
              tone={task.status === 'Done' ? 'positive' : overdue ? 'warning' : 'neutral'}
            />
            {overdue ? <StatusPill label="Overdue" tone="warning" /> : null}
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            Due:{' '}
            <strong style={overdue ? { color: 'var(--warning)' } : undefined}>
              {task.dueAt.includes('T') ? formatDateTime(task.dueAt) : formatDate(task.dueAt)}
            </strong>{' '}
            · Assigned to:{' '}
            {[
              task.assignedTeamId ? nameOfTeam(task.assignedTeamId) : '',
              task.assignedPersonId ? nameOfPerson(task.assignedPersonId) : 'Unclaimed',
            ]
              .filter(Boolean)
              .join(' · ')}
            {task.completedAt && task.completedById
              ? ` · Completed by ${nameOfPerson(task.completedById)} on ${formatDateTime(task.completedAt)}`
              : ''}
          </div>
        </div>

        <div className="page-header__actions">
          {canTake ? (
            <button
              type="button"
              className="btn btn--primary"
              disabled={pending}
              onClick={handleTake}
            >
              Take task
            </button>
          ) : null}
          {isTaskOpen(task) && task.status === 'To do' ? (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={pending}
              onClick={() => handleQuickStatus('In progress')}
            >
              Start task
            </button>
          ) : null}
          {isTaskOpen(task) ? (
            <button
              type="button"
              className="btn btn--primary"
              disabled={pending}
              onClick={() => handleQuickStatus('Done')}
            >
              Complete task
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={pending}
              onClick={() => handleQuickStatus('To do')}
            >
              Reopen task
            </button>
          )}
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? 'Cancel edit' : 'Edit details'}
          </button>
        </div>
      </div>

      {/* EDIT FORM */}
      {editing ? (
        <form onSubmit={handleSaveEdit} className="form-section" style={{ marginBottom: 24 }}>
          <div className="form-section__header">
            <h2>Edit task</h2>
          </div>
          <div className="form-grid">
            <div className="field-group field-group--full">
              <label className="field-label" htmlFor="edit-task-title">
                Title *
              </label>
              <input
                id="edit-task-title"
                type="text"
                required
                className="field-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="edit-task-type">
                Task type
              </label>
              <select
                id="edit-task-type"
                className="field-select"
                value={taskTypeId}
                onChange={(e) => setTaskTypeId(e.target.value)}
              >
                {taskTypes.map((tt) => (
                  <option key={tt.id} value={tt.id}>
                    {tt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="edit-task-prio">
                Priority
              </label>
              <select
                id="edit-task-prio"
                className="field-select"
                value={priorityId}
                onChange={(e) => setPriorityId(e.target.value)}
              >
                {taskPriorities.map((tp) => (
                  <option key={tp.id} value={tp.id}>
                    {tp.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="edit-task-due">
                Due date *
              </label>
              <input
                id="edit-task-due"
                type="date"
                required
                className="field-input"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="edit-task-status">
                Status
              </label>
              <select
                id="edit-task-status"
                className="field-select"
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
              >
                <option value="To do">To do</option>
                <option value="In progress">In progress</option>
                <option value="Done">Done</option>
                <option value="Cancelled">Cancelled</option>
              </select>
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="edit-task-team">
                Assigned team
              </label>
              <select
                id="edit-task-team"
                className="field-select"
                disabled={!canReassign && task.assignedTeamId !== null}
                value={assignedTeamId}
                onChange={(e) => setAssignedTeamId(e.target.value)}
              >
                <option value="">— None —</option>
                {activeTeams.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="edit-task-person">
                Assigned person
              </label>
              <select
                id="edit-task-person"
                className="field-select"
                disabled={!canReassign && task.assignedPersonId !== null}
                value={assignedPersonId}
                onChange={(e) => setAssignedPersonId(e.target.value)}
              >
                <option value="">— Unclaimed (team queue) —</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {personDisplayName(emp)} ({resolveLabel(values, emp.employeeRoleId)})
                  </option>
                ))}
              </select>
            </div>
            <div className="field-group field-group--full">
              <label className="field-label" htmlFor="edit-task-desc">
                Description / notes
              </label>
              <textarea
                id="edit-task-desc"
                rows={4}
                className="field-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="field-group field-group--full">
              <div className="field-label">Linked records</div>
              {linkedRecords.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                  {linkedRecords.map((lr) => (
                    <span key={`${lr.recordType}-${lr.recordId}`} className="tag-chip">
                      {resolveLinkedRecordTitle(lr)}
                      <button
                        type="button"
                        onClick={() =>
                          setLinkedRecords((prev) =>
                            prev.filter(
                              (x) =>
                                !(
                                  x.recordType === lr.recordType && x.recordId === lr.recordId
                                ),
                            ),
                          )
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  className="field-select"
                  style={{ maxWidth: 160 }}
                  value={linkRecordType}
                  onChange={(e) => {
                    setLinkRecordType(e.target.value as TaskLinkedRecordType);
                    setLinkRecordId('');
                  }}
                >
                  <option value="enquiry">Enquiry</option>
                  <option value="matter">Matter</option>
                  <option value="person">Person</option>
                  <option value="organisation">Organisation</option>
                </select>
                <select
                  className="field-select"
                  value={linkRecordId}
                  onChange={(e) => setLinkRecordId(e.target.value)}
                >
                  <option value="">Select record…</option>
                  {availableRecordsForType.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => {
                    if (!linkRecordId) return;
                    if (
                      !linkedRecords.some(
                        (x) =>
                          x.recordType === linkRecordType && x.recordId === linkRecordId,
                      )
                    ) {
                      setLinkedRecords((prev) => [
                        ...prev,
                        { recordType: linkRecordType, recordId: linkRecordId },
                      ]);
                    }
                    setLinkRecordId('');
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          </div>

          <div className="form-actions" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={pending}>
              Save changes
            </button>
          </div>
        </form>
      ) : null}

      {/* TASK SUMMARY */}
      <section className="profile-section">
        <div className="profile-section__header">
          <h2>Task overview</h2>
        </div>
        <dl className="kv-grid">
          <div>
            <dt>Reference</dt>
            <dd>{task.reference}</dd>
          </div>
          <div>
            <dt>Task type</dt>
            <dd>{typeLabel}</dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>{prioLabel}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{task.status}</dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>
              {task.dueAt.includes('T') ? formatDateTime(task.dueAt) : formatDate(task.dueAt)}
            </dd>
          </div>
          <div>
            <dt>Assigned team</dt>
            <dd>{task.assignedTeamId ? nameOfTeam(task.assignedTeamId) : '—'}</dd>
          </div>
          <div>
            <dt>Assigned person</dt>
            <dd>
              {task.assignedPersonId ? (
                <Link href={`/people/${task.assignedPersonId}`}>
                  {nameOfPerson(task.assignedPersonId)}
                </Link>
              ) : (
                'Unclaimed (team queue)'
              )}
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              {formatDateTime(task.createdAt)} by {nameOfPerson(task.createdById)}
            </dd>
          </div>
          {task.description ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <dt>Description / notes</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{task.description}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      {/* LINKED RECORDS */}
      <section className="profile-section">
        <div className="profile-section__header">
          <h2>Linked records ({task.linkedRecords.length})</h2>
        </div>
        {task.linkedRecords.length === 0 ? (
          <p className="muted">No linked records on this task.</p>
        ) : (
          <div>
            {task.linkedRecords.map((lr) => (
              <div key={`${lr.recordType}-${lr.recordId}`} className="list-row">
                <div className="list-row__main">
                  <div className="list-row__title">
                    <Link href={hrefForId(lr.recordId)}>{resolveLinkedRecordTitle(lr)}</Link>
                  </div>
                </div>
                <div className="list-row__aside">
                  <Link href={hrefForId(lr.recordId)} className="btn btn--secondary btn--sm">
                    Open record →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* COMMENTS */}
      <section className="profile-section">
        <div className="profile-section__header">
          <h2>Comments ({task.comments.length})</h2>
        </div>

        <form onSubmit={handleAddComment} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              className="field-input"
              placeholder="Add a comment or update on this task…"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
            />
            <button type="submit" className="btn btn--primary btn--sm" disabled={pending}>
              Post comment
            </button>
          </div>
        </form>

        {task.comments.length === 0 ? (
          <p className="muted">No comments yet.</p>
        ) : (
          <div>
            {[...task.comments]
              .sort((a, b) => b.at.localeCompare(a.at))
              .map((c) => (
                <div key={c.id} className="note-item">
                  <div className="note-item__meta">
                    <strong>{nameOfPerson(c.authorId)}</strong> · {formatDateTime(c.at)}
                  </div>
                  <div className="note-item__text">{c.text}</div>
                </div>
              ))}
          </div>
        )}
      </section>

      {/* AUDIT TRAIL */}
      <section className="profile-section">
        <div className="profile-section__header">
          <h2>Audit trail ({audit.length})</h2>
        </div>
        {audit.length === 0 ? (
          <p className="muted">No audit entries recorded yet.</p>
        ) : (
          <div className="audit-list">
            {audit.map((a) => (
              <div key={a.id} className="audit-row">
                <div className="audit-row__main">
                  <strong>{a.field ?? a.action}</strong>
                  {a.oldValue || a.newValue ? (
                    <span className="muted">
                      {' '}
                      — {a.oldValue ? `${a.oldValue} → ` : ''}
                      {a.newValue ?? ''}
                    </span>
                  ) : null}
                </div>
                <div className="audit-row__meta">
                  {nameOfPerson(a.byId)} · {formatDateTime(a.at)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
