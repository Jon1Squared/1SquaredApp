'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Calendar } from 'lucide-react';
import type { PillTone, UrgencyEdgeKind } from '@/domain/badges';
import { formatDate, formatDateTime, formatKeyDateSummary } from '@/domain/dates';
import { enquiryDisplayName } from '@/domain/enquiries';
import { resolveLabel, valuesForList } from '@/domain/lists';
import { hrefForId, personDisplayName } from '@/domain/names';
import { quoteClientDisplayName } from '@/domain/quotes';
import {
  isTaskOpen,
  isTaskOverdue,
  isUserTeamLeadFor,
  userTeams,
} from '@/domain/tasks';
import type {
  ChoiceValue,
  Enquiry,
  Matter,
  Organisation,
  Person,
  Quote,
  Task,
  Team,
} from '@/domain/types';
import {
  DataList,
  DataListFilterBar,
  PersonChip,
  useListDensity,
  type ActiveFilterChipItem,
  type DataListColumn,
  type DataListSortState,
} from './DataList';
import { StatusPill } from './SearchBox';

interface Props {
  tasks: Task[];
  teams: Team[];
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
  enquiries: Enquiry[];
  quotes?: Quote[];
  values: ChoiceValue[];
  currentUserId: string;
  currentUserRole?: import('@/domain/types').AppRole;
}

type TasksTab = 'my' | 'team' | 'created' | 'all';

const PRIORITY_RANK: Record<string, number> = {
  urgent: 1,
  high: 2,
  normal: 3,
  standard: 3,
  low: 4,
};

const STATUS_SORT_ORDER: Record<Task['status'], number> = {
  'In progress': 1,
  'To do': 2,
  Waiting: 3,
  Done: 4,
  Cancelled: 5,
};

function priorityRankFor(label: string): number {
  const l = label.toLowerCase();
  for (const [k, rank] of Object.entries(PRIORITY_RANK)) {
    if (l.includes(k)) return rank;
  }
  return 3;
}

function isExceptionalTaskPriority(label: string): boolean {
  const l = label.toLowerCase();
  return l.includes('urgent') || l.includes('high');
}

function taskPriorityTone(label: string): PillTone {
  const l = label.toLowerCase();
  if (l.includes('urgent')) return 'alert';
  if (l.includes('high')) return 'warning';
  return 'neutral';
}

function taskStatusTone(task: Task, overdue: boolean): PillTone {
  if (overdue) return 'alert';
  if (task.status === 'Done') return 'positive';
  if (task.status === 'In progress') return 'warning';
  return 'neutral';
}

function taskUrgencyEdge(task: Task, prioLabel: string): UrgencyEdgeKind {
  if (isTaskOverdue(task)) return 'emergency';
  if (!isTaskOpen(task)) return null;
  const l = prioLabel.toLowerCase();
  if (l.includes('urgent')) return 'emergency';
  if (l.includes('high')) return 'urgent';
  return null;
}

export function TasksListClient({
  tasks,
  teams,
  people,
  organisations,
  matters,
  enquiries,
  quotes = [],
  values,
  currentUserId,
  currentUserRole,
}: Props) {
  const router = useRouter();

  const currentUser = useMemo(
    () => people.find((p) => p.id === currentUserId) ?? null,
    [people, currentUserId],
  );
  const appRole = currentUserRole ?? currentUser?.appRole ?? 'fee_earner';
  const myTeams = useMemo(() => userTeams(currentUserId, teams), [currentUserId, teams]);
  const myTeamIds = useMemo(() => new Set(myTeams.map((t) => t.id)), [myTeams]);

  const [tab, setTab] = useState<TasksTab>('my');
  const [searchQuery, setSearchQuery] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('open');
  const [typeFilter, setTypeFilter] = useState('all');
  const [teamFilter, setTeamFilter] = useState('all');
  const [recordTypeFilter, setRecordTypeFilter] = useState('all');
  const [sort, setSort] = useState<DataListSortState | null>(null);
  const [density, setDensity] = useListDensity(currentUserId, 'comfortable');

  const taskTypes = useMemo(
    () => valuesForList(values, 'task_type').filter((v) => v.active),
    [values],
  );
  const taskPriorities = useMemo(
    () => valuesForList(values, 'task_priority').filter((v) => v.active),
    [values],
  );

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

  const resolveLinkedRecordDetails = (
    recordType: string,
    recordId: string,
  ): { title: string; reference: string; typeLabel: string } => {
    if (recordType === 'enquiry') {
      const e = enquiries.find((x) => x.id === recordId);
      return {
        title: e ? enquiryDisplayName(e, 'Unnamed enquiry') : recordId,
        reference: e ? e.reference : recordId,
        typeLabel: 'Enquiry',
      };
    }
    if (recordType === 'quote') {
      const q = quotes.find((x) => x.id === recordId);
      return {
        title: q ? quoteClientDisplayName(q, people, organisations) : recordId,
        reference: q ? q.reference : recordId,
        typeLabel: 'Quote',
      };
    }
    if (recordType === 'matter') {
      const m = matters.find((x) => x.id === recordId);
      return {
        title: m ? m.title : recordId,
        reference: m ? m.matterNumber : recordId,
        typeLabel: 'Matter',
      };
    }
    if (recordType === 'person') {
      const p = people.find((x) => x.id === recordId);
      return {
        title: p ? personDisplayName(p) : recordId,
        reference: recordId,
        typeLabel: 'Person',
      };
    }
    if (recordType === 'organisation') {
      const o = organisations.find((x) => x.id === recordId);
      return {
        title: o ? o.legalName : recordId,
        reference: recordId,
        typeLabel: 'Organisation',
      };
    }
    return { title: recordId, reference: recordId, typeLabel: recordType };
  };

  const tabTasks = useMemo(() => {
    if (tab === 'my') {
      return tasks.filter((t) => t.assignedPersonId === currentUserId);
    }
    if (tab === 'team') {
      return tasks.filter((t) => {
        if (!t.assignedTeamId) return false;
        if (myTeamIds.size > 0 && teamFilter === 'all') {
          return myTeamIds.has(t.assignedTeamId);
        }
        return true;
      });
    }
    if (tab === 'created') {
      return tasks.filter((t) => t.createdById === currentUserId);
    }
    return tasks;
  }, [tasks, tab, currentUserId, myTeamIds, teamFilter]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    const list = tabTasks.filter((t) => {
      if (priorityFilter !== 'all' && t.priorityId !== priorityFilter) return false;
      if (typeFilter !== 'all' && t.taskTypeId !== typeFilter) return false;
      if (teamFilter !== 'all' && t.assignedTeamId !== teamFilter) return false;
      if (
        recordTypeFilter !== 'all' &&
        !t.linkedRecords.some((lr) => lr.recordType === recordTypeFilter)
      ) {
        return false;
      }

      if (statusFilter === 'open' && !isTaskOpen(t)) return false;
      if (statusFilter === 'overdue' && !isTaskOverdue(t)) return false;
      if (statusFilter === 'done' && isTaskOpen(t)) return false;
      if (
        statusFilter !== 'all' &&
        statusFilter !== 'open' &&
        statusFilter !== 'overdue' &&
        statusFilter !== 'done' &&
        t.status !== statusFilter
      ) {
        return false;
      }

      if (q) {
        const linkedText = t.linkedRecords
          .map((lr) => {
            const d = resolveLinkedRecordDetails(lr.recordType, lr.recordId);
            return `${d.title} ${d.reference}`;
          })
          .join(' ');
        const assigneeName = nameOfPerson(t.assignedPersonId);
        const teamName = nameOfTeam(t.assignedTeamId);
        const hay =
          `${t.reference} ${t.title} ${t.description} ${linkedText} ${assigneeName} ${teamName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const defaultSorted = [...list].sort((a, b) => {
      const aOpen = isTaskOpen(a) ? 0 : 1;
      const bOpen = isTaskOpen(b) ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;

      const aOverdue = isTaskOverdue(a) ? 0 : 1;
      const bOverdue = isTaskOverdue(b) ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;

      const pA = priorityRankFor(resolveLabel(values, a.priorityId));
      const pB = priorityRankFor(resolveLabel(values, b.priorityId));
      if (pA !== pB) return pA - pB;

      return a.dueAt.localeCompare(b.dueAt);
    });

    if (!sort) return defaultSorted;

    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...defaultSorted].sort((a, b) => {
      if (sort.columnId === 'priority') {
        const pA = priorityRankFor(resolveLabel(values, a.priorityId));
        const pB = priorityRankFor(resolveLabel(values, b.priorityId));
        if (pA !== pB) return (pA - pB) * dir;
      } else if (sort.columnId === 'status') {
        const sA = isTaskOverdue(a) ? 0 : (STATUS_SORT_ORDER[a.status] ?? 99);
        const sB = isTaskOverdue(b) ? 0 : (STATUS_SORT_ORDER[b.status] ?? 99);
        if (sA !== sB) return (sA - sB) * dir;
      } else if (sort.columnId === 'dueAt') {
        const cmp = a.dueAt.localeCompare(b.dueAt);
        if (cmp !== 0) return cmp * dir;
      }
      return a.dueAt.localeCompare(b.dueAt);
    });
  }, [
    tabTasks,
    priorityFilter,
    typeFilter,
    teamFilter,
    recordTypeFilter,
    statusFilter,
    searchQuery,
    values,
    sort,
    enquiries,
    matters,
    people,
    organisations,
    teams,
  ]);

  const columns = useMemo<DataListColumn<Task>[]>(() => {
    const taskCol: DataListColumn<Task> = {
      id: 'task',
      header: 'Task',
      width: '28%',
      priority: 1,
      renderPrimary: (t) => <Link href={`/tasks/${t.id}`}>{t.title}</Link>,
      renderSecondary: (t) => t.reference,
      tooltip: (t) =>
        `${t.title} (${t.reference})${t.description ? ` — ${t.description}` : ''}`,
    };

    const linkedRecordCol: DataListColumn<Task> = {
      id: 'linkedRecord',
      header: 'Linked record',
      width: '24%',
      priority: 1,
      renderPrimary: (t) => {
        const first = t.linkedRecords[0];
        if (!first) return <span className="muted">—</span>;
        const details = resolveLinkedRecordDetails(first.recordType, first.recordId);
        return <Link href={hrefForId(first.recordId)}>{details.title}</Link>;
      },
      renderSecondary: (t) => {
        const first = t.linkedRecords[0];
        if (!first) return undefined;
        const details = resolveLinkedRecordDetails(first.recordType, first.recordId);
        const extra =
          t.linkedRecords.length > 1 ? ` · +${t.linkedRecords.length - 1} more` : '';
        return `${details.reference} · ${details.typeLabel}${extra}`;
      },
      tooltip: (t) => {
        if (t.linkedRecords.length === 0) return undefined;
        return t.linkedRecords
          .map((lr) => {
            const d = resolveLinkedRecordDetails(lr.recordType, lr.recordId);
            return `${d.title} (${d.reference} · ${d.typeLabel})`;
          })
          .join(', ');
      },
    };

    const priorityCol: DataListColumn<Task> = {
      id: 'priority',
      header: 'Priority',
      width: '110px',
      priority: 1,
      sortable: true,
      renderPrimary: (t) => {
        const prioLabel = resolveLabel(values, t.priorityId) || 'Normal';
        if (!isExceptionalTaskPriority(prioLabel)) return null;
        return <StatusPill label={prioLabel} tone={taskPriorityTone(prioLabel)} />;
      },
    };

    const statusCol: DataListColumn<Task> = {
      id: 'status',
      header: 'Status',
      width: '150px',
      priority: 1,
      sortable: true,
      secondarySortable: { id: 'dueAt', header: 'Due' },
      keepSecondaryInCompact: true,
      renderPrimary: (t) => {
        const overdue = isTaskOverdue(t);
        const label = overdue ? 'Overdue' : t.status;
        return <StatusPill label={label} tone={taskStatusTone(t, overdue)} />;
      },
      renderSecondary: (t) => {
        if (!t.dueAt) return undefined;
        const kd = formatKeyDateSummary(t.dueAt.slice(0, 10));
        const formatted = formatDate(t.dueAt);
        const overdue = isTaskOverdue(t);
        return (
          <span
            className={`key-date-inline ${
              overdue || kd?.isUrgentWeek ? 'key-date-inline--urgent' : ''
            }`}
          >
            <Calendar size={11} aria-hidden="true" />
            <span>Due {formatted}</span>
          </span>
        );
      },
      tooltip: (t) => {
        const dueStr = t.dueAt.includes('T')
          ? formatDateTime(t.dueAt)
          : formatDate(t.dueAt);
        return `${t.status} · Due ${dueStr}`;
      },
    };

    const assignedCol: DataListColumn<Task> = {
      id: 'assignedTo',
      header: 'Assigned to',
      width: '165px',
      priority: 2,
      renderPrimary: (t) => {
        const personLabel = t.assignedPersonId ? nameOfPerson(t.assignedPersonId) : '';
        const teamLabel = t.assignedTeamId ? nameOfTeam(t.assignedTeamId) : '';
        return (
          <PersonChip
            name={personLabel}
            emptyLabel={teamLabel ? `Queue · ${teamLabel}` : 'Unassigned'}
          />
        );
      },
      renderSecondary: (t) =>
        t.assignedPersonId && t.assignedTeamId ? nameOfTeam(t.assignedTeamId) : undefined,
      tooltip: (t) => {
        const parts = [
          t.assignedPersonId ? nameOfPerson(t.assignedPersonId) : 'Unclaimed',
          t.assignedTeamId ? nameOfTeam(t.assignedTeamId) : '',
        ].filter(Boolean);
        return parts.join(' · ');
      },
    };

    const typeCol: DataListColumn<Task> = {
      id: 'taskType',
      header: 'Task type',
      width: '150px',
      priority: 3,
      renderPrimary: (t) =>
        resolveLabel(values, t.taskTypeId) || <span className="muted">—</span>,
      renderSecondary: (t) => (t.autoTrigger ? 'Auto-generated' : 'Manual'),
      tooltip: (t) => {
        const typeLabel = resolveLabel(values, t.taskTypeId) || 'General';
        return `${typeLabel} (${t.autoTrigger ? 'Auto-generated' : 'Manual'})`;
      },
    };

    if (tab === 'my') {
      return [taskCol, linkedRecordCol, priorityCol, statusCol, typeCol];
    }

    return [taskCol, linkedRecordCol, priorityCol, statusCol, assignedCol, typeCol];
  }, [tab, values, people, teams, enquiries, matters, organisations]);

  const myOpenCount = useMemo(
    () => tasks.filter((t) => t.assignedPersonId === currentUserId && isTaskOpen(t)).length,
    [tasks, currentUserId],
  );
  const teamOpenCount = useMemo(
    () =>
      tasks.filter(
        (t) =>
          Boolean(t.assignedTeamId) &&
          (myTeamIds.size === 0 || myTeamIds.has(t.assignedTeamId!)) &&
          isTaskOpen(t),
      ).length,
    [tasks, myTeamIds],
  );
  const createdCount = useMemo(
    () => tasks.filter((t) => t.createdById === currentUserId && isTaskOpen(t)).length,
    [tasks, currentUserId],
  );
  const allOpenCount = useMemo(
    () => tasks.filter((t) => isTaskOpen(t)).length,
    [tasks],
  );

  return (
    <div className="page-list">
      <div className="page-header">
        <div>
          <h1>Tasks</h1>
        </div>
      </div>

      <div className="tabs-bar" role="tablist" aria-label="Task queues">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'my'}
          className={`tab-btn ${tab === 'my' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('my')}
        >
          My tasks ({myOpenCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'team'}
          className={`tab-btn ${tab === 'team' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('team')}
        >
          Team queue ({teamOpenCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'created'}
          className={`tab-btn ${tab === 'created' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('created')}
        >
          Created by me ({createdCount})
        </button>
        {(appRole === 'admin' || appRole === 'team_lead') && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'all'}
            className={`tab-btn ${tab === 'all' ? 'tab-btn--active' : ''}`}
            onClick={() => setTab('all')}
          >
            All open ({allOpenCount})
          </button>
        )}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingBottom: 6,
            flexShrink: 0,
          }}
        >
          <Link href="/tasks/new" className="btn btn--primary">
            + New task
          </Link>
        </div>
      </div>

      <DataListFilterBar
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="Search reference, title, linked record, assignee…"
        searchAriaLabel="Search tasks"
        primaryFilters={
          <>
            <select
              aria-label="Filter by priority"
              className="field-select list-filter-row__select"
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
            >
              <option value="all">All priorities</option>
              {taskPriorities.map((tp) => (
                <option key={tp.id} value={tp.id}>
                  {tp.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by status"
              className="field-select list-filter-row__select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="open">Open tasks</option>
              <option value="overdue">Overdue only</option>
              <option value="To do">To do</option>
              <option value="In progress">In progress</option>
              <option value="Waiting">Waiting</option>
              <option value="done">Done / Cancelled</option>
              <option value="all">All statuses</option>
            </select>
          </>
        }
        moreFiltersActiveCount={
          [
            typeFilter !== 'all',
            teamFilter !== 'all',
            recordTypeFilter !== 'all',
          ].filter(Boolean).length
        }
        moreFiltersContent={
          <>
            <div className="field">
              <label className="field-label" htmlFor="task-filter-type">
                Task type
              </label>
              <select
                id="task-filter-type"
                aria-label="Filter by task type"
                className="field-select"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="all">All task types</option>
                {taskTypes.map((tt) => (
                  <option key={tt.id} value={tt.id}>
                    {tt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="task-filter-team">
                Team
              </label>
              <select
                id="task-filter-team"
                aria-label="Filter by team"
                className="field-select"
                value={teamFilter}
                onChange={(e) => setTeamFilter(e.target.value)}
              >
                <option value="all">All teams</option>
                {teams
                  .filter((t) => t.active)
                  .map((tm) => (
                    <option key={tm.id} value={tm.id}>
                      {tm.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="task-filter-record-type">
                Linked record type
              </label>
              <select
                id="task-filter-record-type"
                aria-label="Filter by linked record type"
                className="field-select"
                value={recordTypeFilter}
                onChange={(e) => setRecordTypeFilter(e.target.value)}
              >
                <option value="all">All record types</option>
                <option value="enquiry">Enquiry</option>
                <option value="quote">Quote</option>
                <option value="matter">Matter</option>
                <option value="person">Person</option>
                <option value="organisation">Organisation</option>
              </select>
            </div>
          </>
        }
        activeChips={[
          ...(priorityFilter !== 'all'
            ? [
                {
                  key: 'priority',
                  label: 'Priority',
                  valueLabel: resolveLabel(values, priorityFilter),
                  onRemove: () => setPriorityFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(statusFilter !== 'open'
            ? [
                {
                  key: 'status',
                  label: 'Status',
                  valueLabel:
                    statusFilter === 'all'
                      ? 'All statuses'
                      : statusFilter === 'done'
                        ? 'Done / Cancelled'
                        : statusFilter === 'overdue'
                          ? 'Overdue'
                          : statusFilter,
                  onRemove: () => setStatusFilter('open'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(typeFilter !== 'all'
            ? [
                {
                  key: 'type',
                  label: 'Task type',
                  valueLabel: resolveLabel(values, typeFilter),
                  onRemove: () => setTypeFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(teamFilter !== 'all'
            ? [
                {
                  key: 'team',
                  label: 'Team',
                  valueLabel: nameOfTeam(teamFilter),
                  onRemove: () => setTeamFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(recordTypeFilter !== 'all'
            ? [
                {
                  key: 'recordType',
                  label: 'Record type',
                  valueLabel:
                    recordTypeFilter.charAt(0).toUpperCase() + recordTypeFilter.slice(1),
                  onRemove: () => setRecordTypeFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
        ]}
        onClearAll={() => {
          setPriorityFilter('all');
          setStatusFilter('open');
          setTypeFilter('all');
          setTeamFilter('all');
          setRecordTypeFilter('all');
          setSearchQuery('');
        }}
        density={density}
        onDensityChange={setDensity}
      />

      {tab === 'team' &&
      teamFilter !== 'all' &&
      isUserTeamLeadFor(currentUserId, teamFilter, teams) ? (
        <div className="banner banner--info" style={{ marginBottom: 12 }}>
          <div>
            <strong>Team lead view:</strong> You are a team lead for{' '}
            {nameOfTeam(teamFilter)}. Open any task to claim or reassign it.
          </div>
        </div>
      ) : null}

      <DataList
        columns={columns}
        rows={filtered}
        getRowId={(t) => t.id}
        getRowUrgency={(t) => taskUrgencyEdge(t, resolveLabel(values, t.priorityId))}
        onRowClick={(t) => router.push(`/tasks/${t.id}`)}
        sort={sort}
        onSortChange={setSort}
        defaultSortLabel="Default order"
        density={density}
        emptyMessage="No tasks match the selected queue and filters."
        ariaLabel="Tasks queue"
        renderMobileCard={(t) => {
          const prioLabel = resolveLabel(values, t.priorityId) || 'Normal';
          const overdue = isTaskOverdue(t);
          const personLabel = t.assignedPersonId ? nameOfPerson(t.assignedPersonId) : '';
          return (
            <>
              <div className="data-list__card-top">
                <Link href={`/tasks/${t.id}`} style={{ fontWeight: 600 }}>
                  {t.title}
                </Link>
                {isExceptionalTaskPriority(prioLabel) ? (
                  <StatusPill label={prioLabel} tone={taskPriorityTone(prioLabel)} />
                ) : null}
              </div>
              <div className="data-list__card-summary">{t.reference}</div>
              <div className="data-list__card-footer">
                <StatusPill
                  label={overdue ? 'Overdue' : t.status}
                  tone={taskStatusTone(t, overdue)}
                />
                <span>Due {formatDate(t.dueAt)}</span>
                <span>·</span>
                <PersonChip name={personLabel} emptyLabel="Unassigned" />
              </div>
            </>
          );
        }}
      />
    </div>
  );
}
