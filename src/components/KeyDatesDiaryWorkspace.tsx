'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  exportKeyDateExceptionsReportAction,
  rejectProposedKeyDateAction,
  runKeyDateReminderSchedulerAction,
  verifyProposedKeyDateAction,
} from '@/app/actions';
import type { TeamDiaryEntry } from '@/domain/keyDateDiary';
import type {
  KeyDateCategory,
  KeyDateException,
  KeyDateExceptionKind,
  KeyDatePermission,
  KeyDatesConfig,
  KeyDateStatus,
} from '@/domain/keyDates.types';
import { personDisplayName } from '@/domain/names';
import type { Enquiry, Matter, Person, Team } from '@/domain/types';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface KeyDatesDiaryWorkspaceProps {
  currentUserId: string;
  userPermissions: KeyDatePermission[];
  keyDatesConfig: KeyDatesConfig;
  initialDiaryEntries: TeamDiaryEntry[];
  initialExceptions: KeyDateException[];
  teams: Team[];
  userDefaultTeamIds: string[];
  matters: Matter[];
  enquiries: Enquiry[];
  people: Person[];
  todayIso: string;
}

const CATEGORY_OPTIONS: { value: KeyDateCategory; label: string }[] = [
  { value: 'limitation', label: 'Limitation' },
  { value: 'court_deadline', label: 'Court deadline' },
  { value: 'contractual', label: 'Contractual' },
  { value: 'undertaking', label: 'Undertaking' },
  { value: 'compliance', label: 'Compliance' },
  { value: 'internal_milestone', label: 'Internal milestone' },
];

const STATUS_OPTIONS: { value: KeyDateStatus; label: string }[] = [
  { value: 'provisional', label: 'Provisional' },
  { value: 'awaiting_verification', label: 'Awaiting verification' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'met', label: 'Met' },
  { value: 'missed', label: 'Missed' },
  { value: 'waived', label: 'Waived' },
  { value: 'superseded', label: 'Superseded' },
];

const EXCEPTION_KIND_LABELS: Record<KeyDateExceptionKind, string> = {
  matter_missing_required_date: 'Open matter missing required key date',
  verification_overdue: 'Verification overdue (> 5 working days)',
  critical_date_no_recent_activity: 'Critical date with no recent matter activity',
  closed_matter_open_dates: 'Closed matter with open key dates',
  calculated_from_unreviewed_rules: 'Calculated from unreviewed rule set',
  reminder_escalated_unacknowledged: 'Reminder escalated without acknowledgement',
  restricted_matter_no_permitted_assignee:
    'Restricted matter key date has no permitted assignee',
  calendar_sync_failed: 'Outlook calendar sync failed',
  past_due_unresolved: 'Past due and unresolved',
};

function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function getStartOfWeekIso(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay(); // 0=Sun..6=Sat
  const diffToMon = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diffToMon);
  return dt.toISOString().slice(0, 10);
}

function getMonthGridDays(yearMonth: string): { dateIso: string; inMonth: boolean }[] {
  const [y, m] = yearMonth.split('-').map(Number);
  const firstDay = new Date(Date.UTC(y, m - 1, 1));
  const startDow = firstDay.getUTCDay();
  const offset = startDow === 0 ? -6 : 1 - startDow;
  const cells: { dateIso: string; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const dt = new Date(Date.UTC(y, m - 1, 1 + offset + i));
    const dateIso = dt.toISOString().slice(0, 10);
    cells.push({ dateIso, inMonth: dt.getUTCMonth() === m - 1 });
  }
  return cells;
}

export function KeyDatesDiaryWorkspace({
  currentUserId,
  userPermissions,
  initialDiaryEntries,
  initialExceptions,
  teams,
  userDefaultTeamIds,
  matters,
  enquiries,
  people,
  todayIso,
}: KeyDatesDiaryWorkspaceProps) {
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  const canViewAnyTeam = userPermissions.includes('keydate:view_any_team');
  const canVerify = userPermissions.includes('keydate:verify');

  const [workspaceTab, setWorkspaceTab] = useState<'diary' | 'exceptions'>('diary');
  const [viewMode, setViewMode] = useState<'list' | 'month' | 'week'>('list');

  // Diary Filters
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>(
    userDefaultTeamIds.length > 0 ? userDefaultTeamIds : teams.map((t) => t.id),
  );
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [selectedCategories, setSelectedCategories] = useState<KeyDateCategory[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<KeyDateStatus[]>([
    'provisional',
    'awaiting_verification',
    'confirmed',
  ]);
  const [criticalOnly, setCriticalOnly] = useState<boolean>(false);
  const [awaitingVerificationOnly, setAwaitingVerificationOnly] = useState<boolean>(false);

  // Calendar navigation state
  const [activeMonth, setActiveMonth] = useState<string>(todayIso.slice(0, 7));
  const [activeWeekStart, setActiveWeekStart] = useState<string>(getStartOfWeekIso(todayIso));

  // Reject modal state
  const [rejectingDateId, setRejectingDateId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string>('');

  // Exceptions Filters
  const [excTeamIds, setExcTeamIds] = useState<string[]>([]);
  const [excKinds, setExcKinds] = useState<KeyDateExceptionKind[]>([]);

  const teamMap = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const matterMap = useMemo(() => new Map(matters.map((m) => [m.id, m])), [matters]);
  const enquiryMap = useMemo(() => new Map(enquiries.map((e) => [e.id, e])), [enquiries]);
  const personMap = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  const selectableTeams = useMemo(() => {
    if (canViewAnyTeam) return teams;
    return teams.filter((t) => userDefaultTeamIds.includes(t.id));
  }, [canViewAnyTeam, teams, userDefaultTeamIds]);

  const filteredDiaryEntries = useMemo(() => {
    return initialDiaryEntries.filter((entry) => {
      if (selectedTeamIds.length > 0 && !selectedTeamIds.includes(entry.teamId)) {
        return false;
      }
      if (fromDate && entry.dueDate < fromDate) return false;
      if (toDate && entry.dueDate > toDate) return false;
      if (selectedCategories.length > 0 && !selectedCategories.includes(entry.category)) {
        return false;
      }
      if (awaitingVerificationOnly) {
        if (entry.status !== 'awaiting_verification') return false;
      } else if (selectedStatuses.length > 0 && !selectedStatuses.includes(entry.status)) {
        return false;
      }
      if (criticalOnly && !entry.isCritical) return false;
      return true;
    });
  }, [
    initialDiaryEntries,
    selectedTeamIds,
    fromDate,
    toDate,
    selectedCategories,
    selectedStatuses,
    criticalOnly,
    awaitingVerificationOnly,
  ]);

  const awaitingVerificationQueueCount = useMemo(
    () =>
      initialDiaryEntries.filter(
        (e) =>
          e.status === 'awaiting_verification' &&
          (selectedTeamIds.length === 0 || selectedTeamIds.includes(e.teamId)),
      ).length,
    [initialDiaryEntries, selectedTeamIds],
  );

  const filteredExceptions = useMemo(() => {
    return initialExceptions.filter((ex) => {
      if (excTeamIds.length > 0 && (!ex.teamId || !excTeamIds.includes(ex.teamId))) {
        return false;
      }
      if (excKinds.length > 0 && !excKinds.includes(ex.kind)) {
        return false;
      }
      return true;
    });
  }, [initialExceptions, excTeamIds, excKinds]);

  const toggleTeamFilter = (teamId: string) => {
    setSelectedTeamIds((prev) =>
      prev.includes(teamId) ? prev.filter((id) => id !== teamId) : [...prev, teamId],
    );
  };

  const toggleCategoryFilter = (cat: KeyDateCategory) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
  };

  const toggleStatusFilter = (st: KeyDateStatus) => {
    setSelectedStatuses((prev) =>
      prev.includes(st) ? prev.filter((s) => s !== st) : [...prev, st],
    );
  };

  const handleVerify = (keyDateId: string) => {
    startTransition(async () => {
      const res = await verifyProposedKeyDateAction(keyDateId);
      if (!res.ok) {
        showToast(res.error ?? 'Failed to verify key date.');
        return;
      }
      showToast('Key date verified and confirmed');
    });
  };

  const handleRejectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectingDateId || !rejectionReason.trim()) return;
    startTransition(async () => {
      const res = await rejectProposedKeyDateAction(rejectingDateId, rejectionReason.trim());
      if (!res.ok) {
        showToast(res.error ?? 'Failed to reject key date.');
        return;
      }
      setRejectingDateId(null);
      setRejectionReason('');
      showToast('Key date rejected and returned to provisional');
    });
  };

  const handleRunScheduler = () => {
    startTransition(async () => {
      const res = await runKeyDateReminderSchedulerAction();
      if (!res.ok || !res.result) {
        showToast(res.error ?? 'Failed to run reminder scheduler.');
        return;
      }
      showToast(
        `Reminder scheduler completed (${res.result.stagesAdvancedCount} stage advances, ${res.result.escalationsTriggeredCount} escalations, ${res.result.notificationsSentCount} notifications)`,
      );
    });
  };

  const handleExportExceptions = (format: 'csv' | 'json') => {
    startTransition(async () => {
      const res = await exportKeyDateExceptionsReportAction({
        teamIds: excTeamIds.length > 0 ? excTeamIds : undefined,
        format,
      });
      if (!res.ok) {
        showToast(res.error ?? 'Failed to export exceptions.');
        return;
      }
      if (typeof window !== 'undefined' && res.content && res.filename) {
        const blob = new Blob([res.content], {
          type: format === 'csv' ? 'text/csv;charset=utf-8;' : 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.filename;
        a.click();
        URL.revokeObjectURL(url);
      }
      showToast(`Exported ${res.count ?? 0} compliance exceptions (${format.toUpperCase()})`);
    });
  };

  const monthCells = useMemo(() => getMonthGridDays(activeMonth), [activeMonth]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, idx) => addDaysIso(activeWeekStart, idx)),
    [activeWeekStart],
  );

  return (
    <div className="page-wide">
      <div
        className="page-header"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1>Key Dates &amp; Limitation Diary</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Team diary, two-step verification queue, and limitation oversight. Every key date belongs
            to a team diary as its backup owner.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link href="/docs/key-dates-team-diary" className="btn btn--ghost btn--sm">
            Diary guide
          </Link>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={pending}
            onClick={handleRunScheduler}
          >
            Run daily reminder check
          </button>
        </div>
      </div>

      {/* Top-level Workspace Tabs */}
      <div className="tabs-bar" role="tablist" aria-label="Key dates workspace views">
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === 'diary'}
          className={`tab-btn ${workspaceTab === 'diary' ? 'tab-btn--active' : ''}`}
          onClick={() => setWorkspaceTab('diary')}
        >
          Team diary ({filteredDiaryEntries.length})
          {awaitingVerificationQueueCount > 0
            ? ` · ${awaitingVerificationQueueCount} awaiting verification`
            : ''}
        </button>
        {canViewAnyTeam ? (
          <button
            type="button"
            role="tab"
            aria-selected={workspaceTab === 'exceptions'}
            className={`tab-btn ${workspaceTab === 'exceptions' ? 'tab-btn--active' : ''}`}
            onClick={() => setWorkspaceTab('exceptions')}
          >
            Compliance exceptions ({initialExceptions.length})
          </button>
        ) : null}
      </div>

      {workspaceTab === 'diary' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
          {/* Filters Panel */}
          <div className="card" style={{ padding: 16 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 12,
                marginBottom: 12,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="field-label" style={{ margin: 0 }}>
                  View:
                </span>
                <button
                  type="button"
                  className={`btn btn--sm ${viewMode === 'list' ? 'btn--primary' : 'btn--secondary'}`}
                  onClick={() => setViewMode('list')}
                >
                  List
                </button>
                <button
                  type="button"
                  className={`btn btn--sm ${viewMode === 'month' ? 'btn--primary' : 'btn--secondary'}`}
                  onClick={() => setViewMode('month')}
                >
                  Month calendar
                </button>
                <button
                  type="button"
                  className={`btn btn--sm ${viewMode === 'week' ? 'btn--primary' : 'btn--secondary'}`}
                  onClick={() => setViewMode('week')}
                >
                  Week calendar
                </button>
              </div>

              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={criticalOnly}
                    onChange={(e) => setCriticalOnly(e.target.checked)}
                  />
                  <span>Critical only</span>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={awaitingVerificationOnly}
                    onChange={(e) => setAwaitingVerificationOnly(e.target.checked)}
                  />
                  <span>Awaiting verification queue ({awaitingVerificationQueueCount})</span>
                </label>
              </div>
            </div>

            {/* Team Selector */}
            <div style={{ marginBottom: 12 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6,
                }}
              >
                <span className="field-label" style={{ margin: 0 }}>
                  Team diaries{' '}
                  {canViewAnyTeam
                    ? '(All-team compliance selector enabled)'
                    : '(Your teams)'}
                </span>
                {canViewAnyTeam ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setSelectedTeamIds(teams.map((t) => t.id))}
                    >
                      Select all teams
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() =>
                        setSelectedTeamIds(
                          userDefaultTeamIds.length > 0
                            ? userDefaultTeamIds
                            : teams.map((t) => t.id),
                        )
                      }
                    >
                      My teams only
                    </button>
                  </div>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {selectableTeams.map((tm) => {
                  const active = selectedTeamIds.includes(tm.id);
                  return (
                    <button
                      key={tm.id}
                      type="button"
                      className={`btn btn--sm ${active ? 'btn--primary' : 'btn--secondary'}`}
                      onClick={() => toggleTeamFilter(tm.id)}
                    >
                      {tm.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Date range, Category, Status filters */}
            <div
              className="form-grid"
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}
            >
              <div className="field-group">
                <label className="field-label" htmlFor="diary-from-date">
                  Due from
                </label>
                <input
                  id="diary-from-date"
                  type="date"
                  className="field-input"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                />
              </div>
              <div className="field-group">
                <label className="field-label" htmlFor="diary-to-date">
                  Due to
                </label>
                <input
                  id="diary-to-date"
                  type="date"
                  className="field-input"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                />
              </div>
              <div className="field-group">
                <span className="field-label">Categories</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {CATEGORY_OPTIONS.map((c) => {
                    const active = selectedCategories.includes(c.value);
                    return (
                      <button
                        key={c.value}
                        type="button"
                        className={`btn btn--sm ${active ? 'btn--primary' : 'btn--ghost'}`}
                        onClick={() => toggleCategoryFilter(c.value)}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="field-group">
                <span className="field-label">Statuses</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {STATUS_OPTIONS.map((s) => {
                    const active = selectedStatuses.includes(s.value);
                    return (
                      <button
                        key={s.value}
                        type="button"
                        className={`btn btn--sm ${active ? 'btn--primary' : 'btn--ghost'}`}
                        disabled={awaitingVerificationOnly}
                        onClick={() => toggleStatusFilter(s.value)}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Reject Modal */}
          {rejectingDateId ? (
            <form
              onSubmit={handleRejectSubmit}
              className="card"
              style={{ padding: 16, borderLeft: '4px solid var(--danger, #c62828)' }}
            >
              <h3 style={{ marginTop: 0 }}>Reject proposed key date</h3>
              <p className="muted" style={{ fontSize: 13 }}>
                Provide a reason why this key date cannot be verified. The date will return to
                provisional status and the proposer will be notified.
              </p>
              <div className="field-group" style={{ marginTop: 8 }}>
                <label className="field-label" htmlFor="diary-reject-reason">
                  Reason for rejection (required)
                </label>
                <input
                  id="diary-reject-reason"
                  type="text"
                  required
                  className="field-input"
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="e.g. Trigger date should be date of knowledge rather than incident date"
                />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button type="submit" className="btn btn--primary btn--sm" disabled={pending}>
                  Confirm rejection
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    setRejectingDateId(null);
                    setRejectionReason('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {/* View 1: List View */}
          {viewMode === 'list' ? (
            <div className="card" style={{ padding: 16 }}>
              {filteredDiaryEntries.length === 0 ? (
                <p className="muted">No key dates match the current diary filters.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {filteredDiaryEntries.map((entry) => {
                    const team = teamMap.get(entry.teamId);
                    const matter = entry.matterId ? matterMap.get(entry.matterId) : undefined;
                    const enquiry = entry.enquiryId ? enquiryMap.get(entry.enquiryId) : undefined;
                    const isOverdue =
                      entry.status === 'confirmed' && entry.dueDate < todayIso;
                    const canVerifyThis =
                      canVerify && entry.status === 'awaiting_verification';

                    return (
                      <div
                        key={entry.keyDateId}
                        className="list-row"
                        style={{
                          padding: 12,
                          border: '1px solid var(--border-subtle, #e2e8f0)',
                          borderRadius: 8,
                          borderLeft: entry.isCritical
                            ? '4px solid var(--danger, #c62828)'
                            : '4px solid var(--accent, #2563eb)',
                        }}
                      >
                        <div className="list-row__main" style={{ flex: 1 }}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              flexWrap: 'wrap',
                            }}
                          >
                            <strong>{entry.title}</strong>
                            <StatusPill
                              label={
                                isOverdue
                                  ? 'Past due, unresolved'
                                  : entry.status.replace(/_/g, ' ')
                              }
                              tone={
                                isOverdue || entry.status === 'missed'
                                  ? 'alert'
                                  : entry.status === 'confirmed' || entry.status === 'met'
                                    ? 'positive'
                                    : entry.status === 'awaiting_verification'
                                      ? 'warning'
                                      : 'neutral'
                              }
                            />
                            {entry.isCritical ? (
                              <StatusPill label="Critical" tone="alert" />
                            ) : null}
                            <StatusPill label={entry.category} tone="neutral" />
                          </div>
                          <div className="list-row__meta" style={{ marginTop: 4 }}>
                            <strong>Due: {entry.dueDate}</strong> · Team diary:{' '}
                            {team ? team.name : entry.teamId}
                            {matter ? (
                              <>
                                {' '}
                                · Matter:{' '}
                                <Link href={`/matters/${matter.id}`}>
                                  {matter.matterNumber} — {matter.title}
                                </Link>
                              </>
                            ) : null}
                            {enquiry ? (
                              <>
                                {' '}
                                · Enquiry:{' '}
                                <Link href={`/enquiries/${enquiry.id}`}>
                                  {enquiry.reference} — {enquiry.summary}
                                </Link>
                              </>
                            ) : null}
                          </div>
                          <div className="list-row__meta" style={{ marginTop: 2 }}>
                            Responsible:{' '}
                            {entry.responsiblePersonIds
                              .map((pid: string) => {
                                const p = personMap.get(pid);
                                return p ? personDisplayName(p) : pid;
                              })
                              .join(', ')}
                            {entry.reminderStageDaysBefore !== undefined
                              ? ` · Reminder stage: ${entry.reminderStageDaysBefore}d (${
                                  entry.reminderAcknowledged ? 'Acknowledged' : 'Unacknowledged'
                                })`
                              : ''}
                          </div>
                        </div>
                        <div className="list-row__aside" style={{ display: 'flex', gap: 6 }}>
                          {canVerifyThis ? (
                            <>
                              <button
                                type="button"
                                className="btn btn--primary btn--sm"
                                disabled={pending}
                                onClick={() => handleVerify(entry.keyDateId)}
                              >
                                Verify
                              </button>
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                disabled={pending}
                                onClick={() => setRejectingDateId(entry.keyDateId)}
                              >
                                Reject
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {/* View 2: Month Calendar View */}
          {viewMode === 'month' ? (
            <div className="card" style={{ padding: 16 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 12,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <label className="field-label" htmlFor="diary-month-picker" style={{ margin: 0 }}>
                    Month:
                  </label>
                  <input
                    id="diary-month-picker"
                    type="month"
                    className="field-input"
                    value={activeMonth}
                    onChange={(e) => e.target.value && setActiveMonth(e.target.value)}
                  />
                </div>
                <span className="muted" style={{ fontSize: 13 }}>
                  Showing {filteredDiaryEntries.length} filtered key dates
                </span>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
                  gap: 6,
                }}
              >
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                  <div
                    key={d}
                    style={{
                      fontWeight: 600,
                      fontSize: 12,
                      padding: '4px 6px',
                      textAlign: 'center',
                    }}
                  >
                    {d}
                  </div>
                ))}
                {monthCells.map((cell) => {
                  const dayEntries = filteredDiaryEntries.filter(
                    (e) => e.dueDate === cell.dateIso,
                  );
                  return (
                    <div
                      key={cell.dateIso}
                      style={{
                        minHeight: 88,
                        padding: 6,
                        border: '1px solid var(--border-subtle, #e2e8f0)',
                        borderRadius: 6,
                        opacity: cell.inMonth ? 1 : 0.45,
                        background:
                          cell.dateIso === todayIso
                            ? 'var(--surface-subtle, rgba(37, 99, 235, 0.06))'
                            : undefined,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: cell.dateIso === todayIso ? 700 : 500,
                          marginBottom: 4,
                        }}
                      >
                        {cell.dateIso.slice(8, 10)}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {dayEntries.map((entry) => (
                          <div
                            key={entry.keyDateId}
                            style={{
                              fontSize: 11,
                              padding: '2px 4px',
                              borderRadius: 4,
                              background: entry.isCritical
                                ? 'rgba(198, 40, 40, 0.12)'
                                : 'rgba(37, 99, 235, 0.1)',
                              borderLeft: entry.isCritical
                                ? '3px solid #c62828'
                                : '3px solid #2563eb',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={`${entry.title} (${entry.status})`}
                          >
                            {entry.matterId ? (
                              <Link href={`/matters/${entry.matterId}`}>{entry.title}</Link>
                            ) : entry.enquiryId ? (
                              <Link href={`/enquiries/${entry.enquiryId}`}>{entry.title}</Link>
                            ) : (
                              entry.title
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* View 3: Week Calendar View */}
          {viewMode === 'week' ? (
            <div className="card" style={{ padding: 16 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 12,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => setActiveWeekStart(addDaysIso(activeWeekStart, -7))}
                  >
                    ← Previous week
                  </button>
                  <strong>
                    Week of {activeWeekStart} to {addDaysIso(activeWeekStart, 6)}
                  </strong>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => setActiveWeekStart(addDaysIso(activeWeekStart, 7))}
                  >
                    Next week →
                  </button>
                </div>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
                  gap: 8,
                }}
              >
                {weekDays.map((dayIso) => {
                  const dayEntries = filteredDiaryEntries.filter(
                    (e) => e.dueDate === dayIso,
                  );
                  return (
                    <div
                      key={dayIso}
                      style={{
                        minHeight: 160,
                        padding: 8,
                        border: '1px solid var(--border-subtle, #e2e8f0)',
                        borderRadius: 6,
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>
                        {dayIso}
                      </div>
                      {dayEntries.length === 0 ? (
                        <span className="muted" style={{ fontSize: 11 }}>
                          No dates
                        </span>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {dayEntries.map((entry) => (
                            <div
                              key={entry.keyDateId}
                              style={{
                                fontSize: 12,
                                padding: 6,
                                borderRadius: 4,
                                border: '1px solid var(--border-subtle, #cbd5e1)',
                                borderLeft: entry.isCritical
                                  ? '3px solid #c62828'
                                  : '3px solid #2563eb',
                              }}
                            >
                              <div style={{ fontWeight: 600 }}>{entry.title}</div>
                              <div className="muted" style={{ fontSize: 11 }}>
                                {teamMap.get(entry.teamId)?.name ?? entry.teamId}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Compliance Exceptions View */}
      {workspaceTab === 'exceptions' && canViewAnyTeam ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
          <div className="card" style={{ padding: 16 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 12,
                marginBottom: 12,
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>Compliance Exceptions Report</h2>
                <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                  Covers all 8 statutory &amp; operational key date exception kinds across teams.
                  Exports are recorded in the immutable audit log.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={pending}
                  onClick={() => handleExportExceptions('csv')}
                >
                  Export CSV (Audited)
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={pending}
                  onClick={() => handleExportExceptions('json')}
                >
                  Export JSON (Audited)
                </button>
              </div>
            </div>

            {/* Filter by Team */}
            <div style={{ marginBottom: 12 }}>
              <span className="field-label">Filter by team (leave unselected for all teams)</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {teams.map((tm) => {
                  const active = excTeamIds.includes(tm.id);
                  return (
                    <button
                      key={tm.id}
                      type="button"
                      className={`btn btn--sm ${active ? 'btn--primary' : 'btn--ghost'}`}
                      onClick={() =>
                        setExcTeamIds((prev) =>
                          prev.includes(tm.id)
                            ? prev.filter((id) => id !== tm.id)
                            : [...prev, tm.id],
                        )
                      }
                    >
                      {tm.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Filter by Exception Kind */}
            <div>
              <span className="field-label">Filter by exception kind</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {(Object.keys(EXCEPTION_KIND_LABELS) as KeyDateExceptionKind[]).map((kind) => {
                  const active = excKinds.includes(kind);
                  return (
                    <button
                      key={kind}
                      type="button"
                      className={`btn btn--sm ${active ? 'btn--primary' : 'btn--ghost'}`}
                      onClick={() =>
                        setExcKinds((prev) =>
                          prev.includes(kind)
                            ? prev.filter((k) => k !== kind)
                            : [...prev, kind],
                        )
                      }
                    >
                      {EXCEPTION_KIND_LABELS[kind]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 16 }}>
            {filteredExceptions.length === 0 ? (
              <p className="muted">No compliance exceptions match the current filters.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {filteredExceptions.map((ex, idx) => {
                  const team = ex.teamId ? teamMap.get(ex.teamId) : undefined;
                  const matter = ex.matterId ? matterMap.get(ex.matterId) : undefined;
                  return (
                    <div
                      key={`${ex.kind}-${ex.keyDateId ?? ex.matterId ?? idx}`}
                      className="list-row"
                      style={{
                        padding: 12,
                        border: '1px solid var(--border-subtle, #e2e8f0)',
                        borderRadius: 8,
                        borderLeft: '4px solid var(--danger, #c62828)',
                      }}
                    >
                      <div className="list-row__main">
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <StatusPill label={EXCEPTION_KIND_LABELS[ex.kind]} tone="alert" />
                          {team ? <StatusPill label={team.name} tone="neutral" /> : null}
                        </div>
                        <div style={{ marginTop: 6, fontWeight: 500 }}>{ex.detail}</div>
                        <div className="list-row__meta" style={{ marginTop: 4 }}>
                          Detected: {ex.detectedAt.slice(0, 10)}
                          {matter ? (
                            <>
                              {' '}
                              · Matter:{' '}
                              <Link href={`/matters/${matter.id}`}>
                                {matter.matterNumber} — {matter.title}
                              </Link>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
