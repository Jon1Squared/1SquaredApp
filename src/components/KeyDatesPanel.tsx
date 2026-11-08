'use client';

import React, { useMemo, useState, useTransition } from 'react';
import {
  acknowledgeKeyDateReminderAction,
  createOrProposeKeyDateAction,
  proposeProvisionalKeyDateAction,
  reassignKeyDateTeamAction,
  recordKeyDateNotApplicableAction,
  rejectProposedKeyDateAction,
  resolveKeyDateOutcomeAction,
  supersedeConfirmedKeyDateAction,
  verifyProposedKeyDateAction,
} from '@/app/actions';
import {
  calculateLimitationDate,
  findBusinessCalendar,
  previewKeyDateCalculation,
} from '@/domain/keyDateCalculator';
import {
  evaluateMatterKeyDateClosureGate,
  evaluateMatterKeyDateOpeningGate,
  resolveMatterDefaultResponsiblePersonIds,
  resolveMatterOwningTeamId,
} from '@/domain/keyDates';
import type {
  KeyDate,
  KeyDateCalendarSync,
  KeyDateNotApplicable,
  KeyDatePermission,
  KeyDateReminderState,
  KeyDatesConfig,
  StandstillPeriod,
} from '@/domain/keyDates.types';
import { personDisplayName } from '@/domain/names';
import type { Enquiry, Matter, Person, Team } from '@/domain/types';

export interface KeyDatesPanelProps {
  matter?: Matter | null;
  enquiry?: Enquiry | null;
  config: KeyDatesConfig;
  keyDates: KeyDate[];
  notApplicableRecords?: KeyDateNotApplicable[];
  reminderStates?: KeyDateReminderState[];
  calendarSyncs?: KeyDateCalendarSync[];
  currentUser: Person;
  userPermissions?: KeyDatePermission[];
  canVerifyByKeyDateId?: Record<string, { allowed: boolean; reason?: string }>;
  teams: Team[];
  employees: Person[];
}

export function KeyDatesPanel({
  matter,
  enquiry,
  config,
  keyDates,
  notApplicableRecords = [],
  reminderStates = [],
  calendarSyncs = [],
  currentUser,
  userPermissions = [],
  canVerifyByKeyDateId,
  teams,
  employees,
}: KeyDatesPanelProps) {
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);

  // Filter records for this matter or enquiry
  const entityKeyDates = useMemo(() => {
    return keyDates
      .filter((kd) =>
        matter ? kd.matterId === matter.id : enquiry ? kd.enquiryId === enquiry.id : false,
      )
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }, [keyDates, matter, enquiry]);

  const entityNotApplicable = useMemo(() => {
    if (!matter) return [];
    return notApplicableRecords.filter((na) => na.matterId === matter.id);
  }, [notApplicableRecords, matter]);

  const permSet = useMemo(() => new Set(userPermissions), [userPermissions]);

  const canView = permSet.has('keydate:view');
  const canEdit = permSet.has('keydate:edit');
  const canVerify = permSet.has('keydate:verify');
  const canOverrideCalc = permSet.has('keydate:override_calculation');
  const canResolve = permSet.has('keydate:resolve');
  const canWaive = permSet.has('keydate:waive');

  const defaultTeamId = useMemo(() => {
    if (matter) return resolveMatterOwningTeamId(matter, teams);
    if (enquiry?.assignedTeamId) return enquiry.assignedTeamId;
    return teams.find((t) => t.active)?.id ?? teams[0]?.id ?? '';
  }, [matter, enquiry, teams]);

  const defaultResponsibleIds = useMemo(() => {
    if (matter) return resolveMatterDefaultResponsiblePersonIds(matter);
    if (enquiry?.assignedToId) return [enquiry.assignedToId];
    return [currentUser.id];
  }, [matter, enquiry, currentUser.id]);

  const keyDateTypes = config.keyDateTypes ?? [];
  const limitationRuleSets = config.limitationRuleSets ?? [];

  // Add / Calculator form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [entryMode, setEntryMode] = useState<'manual' | 'calculator'>('manual');
  const [keyDateTypeId, setKeyDateTypeId] = useState(
    keyDateTypes[0]?.id ?? 'limitation',
  );
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [isCritical, setIsCritical] = useState<boolean>(
    keyDateTypes[0]?.defaultCritical ?? true,
  );
  const [teamId, setTeamId] = useState(defaultTeamId);
  const [responsiblePersonIds, setResponsiblePersonIds] = useState<string[]>(
    defaultResponsibleIds,
  );
  const [notes, setNotes] = useState('');
  const [intent, setIntent] = useState<'provisional' | 'propose'>('propose');

  // Calculator state
  const [selectedRuleSetId, setSelectedRuleSetId] = useState(
    limitationRuleSets[0]?.id ?? '',
  );
  const selectedRuleSet = useMemo(
    () =>
      limitationRuleSets.find((rs) => rs.id === selectedRuleSetId) ??
      limitationRuleSets[0],
    [limitationRuleSets, selectedRuleSetId],
  );
  const [selectedRuleId, setSelectedRuleId] = useState(
    selectedRuleSet?.rules[0]?.id ?? '',
  );
  const selectedRule = useMemo(
    () =>
      selectedRuleSet?.rules.find((r) => r.id === selectedRuleId) ??
      selectedRuleSet?.rules[0],
    [selectedRuleSet, selectedRuleId],
  );
  const [triggerValues, setTriggerValues] = useState<Record<string, string>>({});
  const [standstillPeriods, setStandstillPeriods] = useState<StandstillPeriod[]>([]);
  const [useOverride, setUseOverride] = useState(false);
  const [overrideDate, setOverrideDate] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  // Supersede modal state
  const [supersedingKd, setSupersedingKd] = useState<KeyDate | null>(null);
  const [supersedeDueDate, setSupersedeDueDate] = useState('');
  const [supersedeTitle, setSupersedeTitle] = useState('');
  const [supersedeReason, setSupersedeReason] = useState('');
  const [supersedeNotes, setSupersedeNotes] = useState('');

  // Reject modal state
  const [rejectingKd, setRejectingKd] = useState<KeyDate | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // Resolve modal state
  const [resolvingKd, setResolvingKd] = useState<KeyDate | null>(null);
  const [resolveKind, setResolveKind] = useState<'met' | 'missed' | 'waived'>('met');
  const [resolveNote, setResolveNote] = useState('');

  // Not applicable modal state
  const [naTypeId, setNaTypeId] = useState<string | null>(null);
  const [naReason, setNaReason] = useState('');

  // Show superseded history toggle
  const [showSuperseded, setShowSuperseded] = useState(false);

  // Live calculation result
  const liveCalcPreview = useMemo(() => {
    if (entryMode !== 'calculator' || !selectedRuleSet || !selectedRule) {
      return null;
    }
    try {
      const calCode =
        selectedRule.calendarId || config.businessCalendars?.[0]?.id;
      const calendar = findBusinessCalendar(config, calCode);
      const res = calculateLimitationDate(
        selectedRule,
        {
          ...triggerValues,
          ...(standstillPeriods.length > 0 ? { standstillPeriods } : {}),
        },
        calendar,
        { ruleSetReviewStatus: selectedRuleSet.reviewStatus },
      );
      return { ok: true as const, result: res };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : 'Enter trigger dates to calculate.',
      };
    }
  }, [
    entryMode,
    selectedRuleSet,
    selectedRule,
    triggerValues,
    standstillPeriods,
    config,
  ]);

  if (!config?.enabled) {
    return null;
  }

  if (!canView) {
    return null;
  }

  const matterTypeId =
    matter?.matterTypeId || matter?.practiceAreaId || enquiry?.practiceAreaId || '';
  const openingGate = matter
    ? evaluateMatterKeyDateOpeningGate(
        config,
        matterTypeId,
        entityKeyDates,
        entityNotApplicable,
      )
    : null;
  const closureGate = matter
    ? evaluateMatterKeyDateClosureGate(config, matterTypeId, entityKeyDates)
    : null;

  const teamNameOf = (tid: string) =>
    teams.find((t) => t.id === tid)?.name ?? tid;
  const personNameOf = (pid: string) => {
    const p = employees.find((e) => e.id === pid);
    return p ? personDisplayName(p) : pid;
  };

  const visibleDates = entityKeyDates.filter(
    (kd) => showSuperseded || kd.status !== 'superseded',
  );

  function handleSelectKeyDateType(nextTypeId: string) {
    setKeyDateTypeId(nextTypeId);
    const kdType = keyDateTypes.find((t) => t.id === nextTypeId);
    if (kdType) {
      setIsCritical(Boolean(kdType.defaultCritical));
      if (!title) setTitle(kdType.label);
      if (kdType.allowCalculation || kdType.allowManualEntry === false) {
        setEntryMode('calculator');
      }
    }
  }

  function handleCreateKeyDate(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);

    let effectiveDueDate = dueDate;
    let calculationPayload = undefined;

    if (entryMode === 'calculator') {
      if (!liveCalcPreview?.ok || !selectedRuleSet || !selectedRule) {
        setFeedback({
          kind: 'err',
          text: liveCalcPreview?.error || 'Please complete all required trigger dates.',
        });
        return;
      }
      try {
        const built = previewKeyDateCalculation(
          {
            ruleSet: selectedRuleSet,
            rule: selectedRule,
            triggers: {
              ...triggerValues,
              ...(standstillPeriods.length > 0 ? { standstillPeriods } : {}),
            },
            calendar: findBusinessCalendar(
              config,
              selectedRule.calendarId || config.businessCalendars?.[0]?.id,
            ),
            override: useOverride
              ? {
                  overriddenDate: overrideDate,
                  reason: overrideReason,
                }
              : undefined,
          },
          { overrideAllowed: canOverrideCalc },
        );
        calculationPayload = built.calculation;
        effectiveDueDate = built.effectiveDueDate;
      } catch (err) {
        setFeedback({
          kind: 'err',
          text: err instanceof Error ? err.message : 'Invalid calculation override.',
        });
        return;
      }
    }

    if (!effectiveDueDate) {
      setFeedback({ kind: 'err', text: 'Due date is required.' });
      return;
    }

    startTransition(async () => {
      const res = await createOrProposeKeyDateAction({
        matterId: matter?.id,
        enquiryId: enquiry?.id,
        keyDateTypeId,
        title: title.trim() || undefined,
        dueDate: effectiveDueDate,
        dueTime: dueTime.trim() || undefined,
        isCritical,
        source: entryMode === 'calculator' ? 'calculated' : 'manual',
        teamId,
        responsiblePersonIds,
        calculation: calculationPayload,
        notes: notes.trim() || undefined,
        intent,
      });
      if (!res.ok) {
        setFeedback({ kind: 'err', text: res.error || 'Could not save key date.' });
      } else {
        setFeedback({
          kind: 'ok',
          text: `Key date "${res.keyDate?.title}" saved (${res.keyDate?.status}).`,
        });
        setShowAddForm(false);
        setTitle('');
        setDueDate('');
        setDueTime('');
        setNotes('');
        setUseOverride(false);
        setOverrideDate('');
        setOverrideReason('');
      }
    });
  }

  return (
    <div
      className="card"
      style={{
        marginTop: 16,
        padding: 18,
        border: '1px solid var(--border, #d8dee9)',
        borderRadius: 10,
        background: 'var(--surface, #ffffff)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          marginBottom: 12,
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            Key Dates &amp; Limitation
          </h3>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: '#556' }}>
            The system suggests dates; a solicitor confirms them. Every date belongs to a team diary and has one non-stacking reminder task.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={showSuperseded}
              onChange={(e) => setShowSuperseded(e.target.checked)}
            />
            Show superseded history
          </label>
          {canEdit && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: 12, padding: '6px 12px' }}
              onClick={() => setShowAddForm((v) => !v)}
            >
              {showAddForm ? 'Cancel' : '+ Add / Calculate Key Date'}
            </button>
          )}
        </div>
      </div>

      {feedback && (
        <div
          style={{
            padding: '8px 12px',
            marginBottom: 12,
            borderRadius: 6,
            fontSize: 13,
            background: feedback.kind === 'ok' ? '#ecfdf5' : '#fef2f2',
            color: feedback.kind === 'ok' ? '#065f46' : '#991b1b',
            border: `1px solid ${feedback.kind === 'ok' ? '#a7f3d0' : '#fecaca'}`,
          }}
        >
          {feedback.text}
        </div>
      )}

      {/* Matter Opening Gate & Closure Block Status Banners */}
      {matter && openingGate && !openingGate.canOpen && (
        <div
          style={{
            padding: '10px 12px',
            marginBottom: 12,
            borderRadius: 6,
            background: '#fffbeb',
            border: '1px solid #fde68a',
            fontSize: 13,
            color: '#92400e',
          }}
        >
          <strong>Matter Opening Gate:</strong> This matter type requires the following key date(s) before opening:{' '}
          {openingGate.missingKeyDateTypes.map((m) => (
            <span key={m.id} style={{ marginRight: 8 }}>
              <strong>{m.label}</strong>
              {canEdit && (
                <button
                  type="button"
                  style={{
                    marginLeft: 6,
                    fontSize: 11,
                    padding: '2px 6px',
                    borderRadius: 4,
                    border: '1px solid #d97706',
                    background: '#fff',
                    color: '#92400e',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setNaTypeId(m.id);
                    setNaReason('');
                  }}
                >
                  Mark not applicable…
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {matter && entityNotApplicable.length > 0 && (
        <div
          style={{
            padding: '6px 10px',
            marginBottom: 10,
            borderRadius: 6,
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            fontSize: 12,
            color: '#475569',
          }}
        >
          <strong>Recorded as Not Applicable:</strong>{' '}
          {entityNotApplicable.map((na) => (
            <span key={na.keyDateTypeId} style={{ marginRight: 12 }}>
              <code>{na.keyDateTypeId}</code> — &ldquo;{na.reason}&rdquo; (by{' '}
              {personNameOf(na.recordedById)})
            </span>
          ))}
        </div>
      )}

      {matter && closureGate && !closureGate.canClose && (
        <div
          style={{
            padding: '8px 12px',
            marginBottom: 12,
            borderRadius: 6,
            background: '#f1f5f9',
            border: '1px solid #cbd5e1',
            fontSize: 12,
            color: '#334155',
          }}
        >
          <strong>Matter Closure Guard:</strong> Closure is blocked while{' '}
          {closureGate.openKeyDates.length} key date(s) remain open (
          <code>provisional</code>, <code>awaiting_verification</code>, or{' '}
          <code>confirmed</code>).
        </div>
      )}

      {/* Record Not Applicable Modal */}
      {naTypeId && matter && (
        <div
          style={{
            padding: 12,
            marginBottom: 12,
            borderRadius: 8,
            background: '#fffbeb',
            border: '1px solid #fcd34d',
          }}
        >
          <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>
            Record &ldquo;{naTypeId}&rdquo; as Not Applicable
          </h4>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Audited reason why this required key date does not apply..."
              value={naReason}
              onChange={(e) => setNaReason(e.target.value)}
              style={{ flex: 1, padding: '6px 8px', fontSize: 12 }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={isPending || !naReason.trim()}
              style={{ fontSize: 12, padding: '6px 10px' }}
              onClick={() => {
                startTransition(async () => {
                  const res = await recordKeyDateNotApplicableAction({
                    matterId: matter.id,
                    keyDateTypeId: naTypeId,
                    reason: naReason,
                  });
                  if (!res.ok) {
                    setFeedback({ kind: 'err', text: res.error || 'Failed.' });
                  } else {
                    setFeedback({
                      kind: 'ok',
                      text: `Recorded "${naTypeId}" as not applicable.`,
                    });
                    setNaTypeId(null);
                  }
                });
              }}
            >
              Save Reason
            </button>
            <button
              type="button"
              className="btn"
              style={{ fontSize: 12, padding: '6px 10px' }}
              onClick={() => setNaTypeId(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Add / Calculate Key Date Form */}
      {showAddForm && (
        <form
          onSubmit={handleCreateKeyDate}
          style={{
            padding: 14,
            marginBottom: 16,
            borderRadius: 8,
            background: '#f8fafc',
            border: '1px solid #cbd5e1',
          }}
        >
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button
              type="button"
              className={entryMode === 'manual' ? 'btn btn-primary' : 'btn'}
              style={{ fontSize: 12, padding: '5px 10px' }}
              onClick={() => setEntryMode('manual')}
            >
              Manual Date Entry
            </button>
            <button
              type="button"
              className={entryMode === 'calculator' ? 'btn btn-primary' : 'btn'}
              style={{ fontSize: 12, padding: '5px 10px' }}
              onClick={() => setEntryMode('calculator')}
            >
              Limitation Calculator
            </button>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 10,
              marginBottom: 12,
            }}
          >
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                Key Date Type *
              </label>
              <select
                value={keyDateTypeId}
                onChange={(e) => handleSelectKeyDateType(e.target.value)}
                style={{ width: '100%', padding: 6, fontSize: 12 }}
              >
                {keyDateTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} ({t.category})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                Title / Description
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Defaults to type label"
                style={{ width: '100%', padding: 6, fontSize: 12 }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                Team Diary (Backup Owner) *
              </label>
              <select
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                style={{ width: '100%', padding: 6, fontSize: 12 }}
              >
                {teams
                  .filter((t) => t.active)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                Submission Intent
              </label>
              <select
                value={intent}
                onChange={(e) =>
                  setIntent(e.target.value as 'provisional' | 'propose')
                }
                style={{ width: '100%', padding: 6, fontSize: 12 }}
              >
                <option value="propose">
                  Propose / Confirm (routes to verification if required)
                </option>
                <option value="provisional">Save as Provisional Draft</option>
              </select>
            </div>
          </div>

          {entryMode === 'manual' ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 10,
                marginBottom: 12,
              }}
            >
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                  Due Date (YYYY-MM-DD) *
                </label>
                <input
                  type="date"
                  required
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  style={{ width: '100%', padding: 6, fontSize: 12 }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                  Due Time (optional HH:MM)
                </label>
                <input
                  type="time"
                  value={dueTime}
                  onChange={(e) => setDueTime(e.target.value)}
                  style={{ width: '100%', padding: 6, fontSize: 12 }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', paddingTop: 18 }}>
                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={isCritical}
                    onChange={(e) => setIsCritical(e.target.checked)}
                  />
                  Critical date
                </label>
              </div>
            </div>
          ) : (
            /* Pure Limitation Calculator Section (§2) */
            <div
              style={{
                padding: 12,
                marginBottom: 12,
                borderRadius: 6,
                background: '#ffffff',
                border: '1px solid #e2e8f0',
              }}
            >
              <div
                style={{
                  padding: '8px 10px',
                  marginBottom: 10,
                  borderRadius: 6,
                  background: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  fontSize: 12,
                  color: '#1e3a8a',
                  fontWeight: 600,
                }}
              >
                This calculation is a guide. A solicitor must confirm the date.
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 10,
                  marginBottom: 10,
                }}
              >
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                    Limitation Rule Set
                  </label>
                  <select
                    value={selectedRuleSet?.id ?? ''}
                    onChange={(e) => {
                      const nextRs = limitationRuleSets.find(
                        (rs) => rs.id === e.target.value,
                      );
                      setSelectedRuleSetId(e.target.value);
                      setSelectedRuleId(nextRs?.rules[0]?.id ?? '');
                      setTriggerValues({});
                    }}
                    style={{ width: '100%', padding: 6, fontSize: 12 }}
                  >
                    {limitationRuleSets.map((rs) => (
                      <option key={rs.id} value={rs.id}>
                        {rs.label} (v{rs.version} · {rs.reviewStatus})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                    Limitation Rule
                  </label>
                  <select
                    value={selectedRule?.id ?? ''}
                    onChange={(e) => {
                      setSelectedRuleId(e.target.value);
                      setTriggerValues({});
                    }}
                    style={{ width: '100%', padding: 6, fontSize: 12 }}
                  >
                    {(selectedRuleSet?.rules ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {selectedRuleSet?.reviewStatus === 'unreviewed' && (
                <div
                  style={{
                    padding: '8px 10px',
                    marginBottom: 10,
                    borderRadius: 6,
                    background: '#fffbeb',
                    border: '1px solid #f59e0b',
                    fontSize: 12,
                    color: '#92400e',
                  }}
                >
                  <strong>Warning — Unreviewed Rule Set:</strong> Rule set &ldquo;
                  {selectedRuleSet.label}&rdquo; has status <code>unreviewed</code>. Any date calculated from this rule set must undergo two-step verification even if the matter type does not otherwise require it.
                </div>
              )}

              {selectedRule?.guidanceNote && (
                <div
                  style={{
                    padding: '6px 10px',
                    marginBottom: 10,
                    borderRadius: 4,
                    background: '#f8fafc',
                    borderLeft: '3px solid #64748b',
                    fontSize: 12,
                    color: '#334155',
                  }}
                >
                  <strong>Rule Guidance:</strong> {selectedRule.guidanceNote}
                </div>
              )}

              {/* Trigger inputs */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: 10,
                  marginBottom: 10,
                }}
              >
                {(selectedRule
                  ? selectedRule.trigger.kind === 'single'
                    ? [selectedRule.trigger.field]
                    : selectedRule.trigger.fields
                  : []
                ).map((fieldKey: string) => (
                  <div key={fieldKey}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                      {fieldKey} ({selectedRule?.trigger.kind === 'later_of' ? 'later_of' : 'required'})
                    </label>
                    <input
                      type="date"
                      value={triggerValues[fieldKey] ?? ''}
                      onChange={(e) =>
                        setTriggerValues((prev) => ({
                          ...prev,
                          [fieldKey]: e.target.value,
                        }))
                      }
                      style={{ width: '100%', padding: 6, fontSize: 12 }}
                    />
                  </div>
                ))}

                {selectedRule?.minorityAdjustment?.enabled && (
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                      Claimant Date of Birth (optional — minority adjustment, age{' '}
                      {selectedRule.minorityAdjustment.ageOfMajority ?? 18})
                    </label>
                    <input
                      type="date"
                      value={triggerValues.claimantDateOfBirth ?? ''}
                      onChange={(e) =>
                        setTriggerValues((prev) => ({
                          ...prev,
                          claimantDateOfBirth: e.target.value,
                        }))
                      }
                      style={{ width: '100%', padding: 6, fontSize: 12 }}
                    />
                  </div>
                )}
              </div>

              {/* Standstill periods */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>
                    Standstill Periods ({standstillPeriods.length})
                  </span>
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={() =>
                      setStandstillPeriods((prev) => [
                        ...prev,
                        { from: '', to: '', reference: 'Standstill agreement' },
                      ])
                    }
                  >
                    + Add Standstill Period
                  </button>
                </div>
                {standstillPeriods.map((sp, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      gap: 8,
                      marginTop: 6,
                      alignItems: 'center',
                    }}
                  >
                    <input
                      type="date"
                      value={sp.from}
                      onChange={(e) =>
                        setStandstillPeriods((prev) =>
                          prev.map((item, i) =>
                            i === idx ? { ...item, from: e.target.value } : item,
                          ),
                        )
                      }
                      style={{ padding: 4, fontSize: 12 }}
                    />
                    <span style={{ fontSize: 12 }}>to</span>
                    <input
                      type="date"
                      value={sp.to}
                      onChange={(e) =>
                        setStandstillPeriods((prev) =>
                          prev.map((item, i) =>
                            i === idx ? { ...item, to: e.target.value } : item,
                          ),
                        )
                      }
                      style={{ padding: 4, fontSize: 12 }}
                    />
                    <input
                      type="text"
                      placeholder="Standstill reference"
                      value={sp.reference}
                      onChange={(e) =>
                        setStandstillPeriods((prev) =>
                          prev.map((item, i) =>
                            i === idx ? { ...item, reference: e.target.value } : item,
                          ),
                        )
                      }
                      style={{ flex: 1, padding: 4, fontSize: 12 }}
                    />
                    <button
                      type="button"
                      className="btn"
                      style={{ fontSize: 11, padding: '2px 6px' }}
                      onClick={() =>
                        setStandstillPeriods((prev) =>
                          prev.filter((_, i) => i !== idx),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>

              {/* Calculation Result & Explanation */}
              {liveCalcPreview?.ok ? (
                <div
                  style={{
                    padding: 10,
                    borderRadius: 6,
                    background: '#f0fdf4',
                    border: '1px solid #bbf7d0',
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#166534' }}>
                    Calculated Limitation Date: {liveCalcPreview.result.date}
                  </div>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: '#14532d' }}>
                    {liveCalcPreview.result.explanation.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  {liveCalcPreview?.error}
                </div>
              )}

              {/* Calculation Override (`keydate:override_calculation`) */}
              {canOverrideCalc && liveCalcPreview?.ok && (
                <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #cbd5e1' }}>
                  <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={useOverride}
                      onChange={(e) => setUseOverride(e.target.checked)}
                    />
                    Override calculated date (keeps both calculated and overridden dates)
                  </label>
                  {useOverride && (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '180px 1fr',
                        gap: 8,
                        marginTop: 8,
                      }}
                    >
                      <input
                        type="date"
                        required
                        value={overrideDate}
                        onChange={(e) => setOverrideDate(e.target.value)}
                        style={{ padding: 6, fontSize: 12 }}
                      />
                      <input
                        type="text"
                        required
                        placeholder="Mandatory reason for overriding the calculated date..."
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        style={{ padding: 6, fontSize: 12 }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Responsible persons multi-select & notes */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
              marginBottom: 12,
            }}
          >
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                Responsible Employees (defaults to matter employees)
              </label>
              <select
                multiple
                value={responsiblePersonIds}
                onChange={(e) => {
                  const selected = Array.from(e.target.selectedOptions).map(
                    (o) => o.value,
                  );
                  if (selected.length > 0) setResponsiblePersonIds(selected);
                }}
                style={{ width: '100%', height: 68, padding: 4, fontSize: 12 }}
              >
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {personDisplayName(emp)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
                Notes / Source Evidence
              </label>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional context or reference to court order / contract clause..."
                style={{ width: '100%', padding: 6, fontSize: 12 }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              className="btn"
              style={{ fontSize: 12, padding: '6px 12px' }}
              onClick={() => setShowAddForm(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isPending}
              style={{ fontSize: 12, padding: '6px 14px' }}
            >
              {isPending ? 'Saving…' : 'Save Key Date'}
            </button>
          </div>
        </form>
      )}

      {/* Key Dates Table / Cards */}
      {visibleDates.length === 0 ? (
        <div
          style={{
            padding: 16,
            textAlign: 'center',
            color: '#64748b',
            fontSize: 13,
            background: '#f8fafc',
            borderRadius: 6,
          }}
        >
          No key dates recorded yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visibleDates.map((kd) => {
            const verifyCheck =
              canVerifyByKeyDateId?.[kd.id] ?? {
                allowed: false,
                reason:
                  'Verification permission was not precomputed for this key date.',
              };
            const reminder = reminderStates.find((r) => r.keyDateId === kd.id);
            const syncState = calendarSyncs.find((s) => s.keyDateId === kd.id);

            return (
              <div
                key={kd.id}
                style={{
                  padding: 12,
                  borderRadius: 8,
                  border: kd.isCritical
                    ? '1px solid #fca5a5'
                    : '1px solid #e2e8f0',
                  background:
                    kd.status === 'superseded'
                      ? '#f8fafc'
                      : kd.isCritical
                        ? '#fffafa'
                        : '#ffffff',
                  opacity: kd.status === 'superseded' ? 0.72 : 1,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 14 }}>{kd.title}</strong>
                      <span
                        style={{
                          fontSize: 11,
                          padding: '2px 7px',
                          borderRadius: 999,
                          fontWeight: 600,
                          background:
                            kd.status === 'confirmed'
                              ? '#dcfce7'
                              : kd.status === 'awaiting_verification'
                                ? '#fef3c7'
                                : kd.status === 'missed'
                                  ? '#fee2e2'
                                  : '#e2e8f0',
                          color:
                            kd.status === 'confirmed'
                              ? '#166534'
                              : kd.status === 'awaiting_verification'
                                ? '#92400e'
                                : kd.status === 'missed'
                                  ? '#991b1b'
                                  : '#334155',
                        }}
                      >
                        {kd.status.replace('_', ' ')}
                      </span>
                      {kd.isCritical && (
                        <span
                          style={{
                            fontSize: 11,
                            padding: '2px 6px',
                            borderRadius: 4,
                            background: '#fee2e2',
                            color: '#991b1b',
                            fontWeight: 700,
                          }}
                        >
                          CRITICAL
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: '#64748b' }}>
                        {kd.category} · Source: <code>{kd.source}</code>
                      </span>
                    </div>

                    <div style={{ fontSize: 12, color: '#334155', marginTop: 4 }}>
                      <strong>Due:</strong> {kd.dueDate}
                      {kd.dueTime ? ` at ${kd.dueTime}` : ''} ·{' '}
                      <strong>Team Diary:</strong> {teamNameOf(kd.teamId)} ·{' '}
                      <strong>Responsible:</strong>{' '}
                      {kd.responsiblePersonIds.map(personNameOf).join(', ')}
                    </div>

                    {kd.calculation && (
                      <div
                        style={{
                          marginTop: 6,
                          padding: '6px 8px',
                          borderRadius: 4,
                          background: '#f8fafc',
                          fontSize: 11,
                          color: '#475569',
                        }}
                      >
                        <div>
                          <strong>Calculated:</strong> {kd.calculation.calculatedDate} (Rule{' '}
                          <code>{kd.calculation.ruleId}</code> · Rule set{' '}
                          <code>{kd.calculation.ruleSetId}</code> v{kd.calculation.ruleSetVersion} [
                          {kd.calculation.ruleSetReviewStatus}])
                          {kd.calculation.overridden && (
                            <span style={{ color: '#b45309', marginLeft: 6 }}>
                              · Overridden to {kd.dueDate} (&ldquo;
                              {kd.calculation.overrideReason}&rdquo;)
                            </span>
                          )}
                        </div>
                        {kd.calculation.ruleSetReviewStatus === 'unreviewed' && (
                          <div style={{ color: '#b45309', fontWeight: 600 }}>
                            ⚠ Calculated from an unreviewed rule set — requires two-step verification.
                          </div>
                        )}
                      </div>
                    )}

                    {kd.verification.rejectionReason && kd.status === 'provisional' && (
                      <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>
                        <strong>Verification rejected:</strong> &ldquo;
                        {kd.verification.rejectionReason}&rdquo; (by{' '}
                        {kd.verification.rejectedById
                          ? personNameOf(kd.verification.rejectedById)
                          : 'Verifier'}
                        )
                      </div>
                    )}

                    {kd.supersedesKeyDateId && (
                      <div style={{ marginTop: 4, fontSize: 11, color: '#475569' }}>
                        Supersedes prior key date <code>{kd.supersedesKeyDateId}</code>
                      </div>
                    )}
                    {kd.supersededByKeyDateId && (
                      <div style={{ marginTop: 4, fontSize: 11, color: '#475569' }}>
                        Superseded by key date <code>{kd.supersededByKeyDateId}</code>
                      </div>
                    )}

                    {kd.outcome && (
                      <div style={{ marginTop: 4, fontSize: 12, color: '#334155' }}>
                        <strong>Outcome ({kd.outcome.kind}):</strong>{' '}
                        {kd.outcome.note || 'Resolved'} (by{' '}
                        {personNameOf(kd.outcome.resolvedById)})
                      </div>
                    )}

                    {reminder && (
                      <div style={{ marginTop: 4, fontSize: 11, color: '#475569' }}>
                        <strong>Reminder task:</strong> <code>{reminder.taskId}</code> · Stage:{' '}
                        {reminder.currentStageDaysBefore === -1
                          ? 'Past due, unresolved'
                          : `${reminder.currentStageDaysBefore}d before`}{' '}
                        ·{' '}
                        {reminder.acknowledgedAt
                          ? `Acknowledged by ${personNameOf(reminder.acknowledgedById!)}`
                          : `Unacknowledged (Escalation L${reminder.escalationLevel})`}
                      </div>
                    )}

                    {syncState && (
                      <div style={{ marginTop: 2, fontSize: 11, color: '#64748b' }}>
                        <strong>Outlook Calendar Sync:</strong> {syncState.state}
                        {syncState.lastError ? ` (${syncState.lastError})` : ''}
                      </div>
                    )}
                  </div>

                  {/* Lifecycle Action Buttons */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {kd.status === 'provisional' && canEdit && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={isPending}
                        style={{ fontSize: 11, padding: '4px 8px' }}
                        onClick={() => {
                          startTransition(async () => {
                            const res = await proposeProvisionalKeyDateAction(kd.id);
                            if (!res.ok) {
                              setFeedback({ kind: 'err', text: res.error || 'Failed.' });
                            } else {
                              setFeedback({
                                kind: 'ok',
                                text: `Key date "${kd.title}" moved to ${res.keyDate?.status}.`,
                              });
                            }
                          });
                        }}
                      >
                        Propose / Confirm
                      </button>
                    )}

                    {kd.status === 'awaiting_verification' && canVerify && (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={isPending || !verifyCheck.allowed}
                          title={verifyCheck.reason || 'Verify and confirm this key date'}
                          style={{ fontSize: 11, padding: '4px 8px' }}
                          onClick={() => {
                            startTransition(async () => {
                              const res = await verifyProposedKeyDateAction(kd.id);
                              if (!res.ok) {
                                setFeedback({
                                  kind: 'err',
                                  text: res.error || 'Verification failed.',
                                });
                              } else {
                                setFeedback({
                                  kind: 'ok',
                                  text: `Verified and confirmed "${kd.title}".`,
                                });
                              }
                            });
                          }}
                        >
                          Verify Date
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={isPending || !verifyCheck.allowed}
                          title={verifyCheck.reason || 'Reject with reason'}
                          style={{ fontSize: 11, padding: '4px 8px' }}
                          onClick={() => {
                            setRejectingKd(kd);
                            setRejectReason('');
                          }}
                        >
                          Reject…
                        </button>
                      </>
                    )}

                    {kd.status === 'confirmed' && canEdit && (
                      <button
                        type="button"
                        className="btn"
                        style={{ fontSize: 11, padding: '4px 8px' }}
                        onClick={() => {
                          setSupersedingKd(kd);
                          setSupersedeTitle(kd.title);
                          setSupersedeDueDate(kd.dueDate);
                          setSupersedeNotes(kd.notes ?? '');
                          setSupersedeReason('');
                        }}
                      >
                        Supersede (Edit Date)…
                      </button>
                    )}

                    {kd.status === 'confirmed' && reminder && !reminder.acknowledgedAt && (
                      <button
                        type="button"
                        className="btn"
                        disabled={isPending}
                        style={{ fontSize: 11, padding: '4px 8px' }}
                        onClick={() => {
                          startTransition(async () => {
                            const res = await acknowledgeKeyDateReminderAction(kd.id);
                            if (!res.ok) {
                              setFeedback({ kind: 'err', text: res.error || 'Failed.' });
                            } else {
                              setFeedback({
                                kind: 'ok',
                                text: `Acknowledged reminder stage for "${kd.title}".`,
                              });
                            }
                          });
                        }}
                      >
                        Acknowledge Reminder
                      </button>
                    )}

                    {(kd.status === 'confirmed' ||
                      kd.status === 'provisional' ||
                      kd.status === 'awaiting_verification') &&
                      (canResolve || canWaive) && (
                        <button
                          type="button"
                          className="btn"
                          style={{ fontSize: 11, padding: '4px 8px' }}
                          onClick={() => {
                            setResolvingKd(kd);
                            setResolveKind('met');
                            setResolveNote('');
                          }}
                        >
                          Resolve (Met / Missed / Waive)…
                        </button>
                      )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Reject Modal */}
      {rejectingKd && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 8,
            background: '#fef2f2',
            border: '1px solid #fecaca',
          }}
        >
          <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>
            Reject Proposed Key Date: {rejectingKd.title} ({rejectingKd.dueDate})
          </h4>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              placeholder="Reason for rejection (required)..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              style={{ flex: 1, padding: 6, fontSize: 12 }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={isPending || !rejectReason.trim()}
              style={{ fontSize: 12, padding: '6px 10px' }}
              onClick={() => {
                startTransition(async () => {
                  const res = await rejectProposedKeyDateAction(
                    rejectingKd.id,
                    rejectReason,
                  );
                  if (!res.ok) {
                    setFeedback({ kind: 'err', text: res.error || 'Reject failed.' });
                  } else {
                    setFeedback({
                      kind: 'ok',
                      text: `Rejected "${rejectingKd.title}" back to provisional.`,
                    });
                    setRejectingKd(null);
                  }
                });
              }}
            >
              Confirm Rejection
            </button>
            <button
              type="button"
              className="btn"
              style={{ fontSize: 12, padding: '6px 10px' }}
              onClick={() => setRejectingKd(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Supersede Confirmed Key Date Modal */}
      {supersedingKd && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 8,
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
          }}
        >
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>
            Supersede Confirmed Key Date: {supersedingKd.title}
          </h4>
          <p style={{ margin: '0 0 8px', fontSize: 11, color: '#1e3a8a' }}>
            Confirmed dates are never deleted. Saving creates a new key date that supersedes{' '}
            <code>{supersedingKd.id}</code> and takes over its single reminder task.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <input
              type="text"
              value={supersedeTitle}
              onChange={(e) => setSupersedeTitle(e.target.value)}
              placeholder="Title"
              style={{ padding: 6, fontSize: 12 }}
            />
            <input
              type="date"
              value={supersedeDueDate}
              onChange={(e) => setSupersedeDueDate(e.target.value)}
              style={{ padding: 6, fontSize: 12 }}
            />
            <input
              type="text"
              value={supersedeReason}
              onChange={(e) => setSupersedeReason(e.target.value)}
              placeholder="Audited reason for superseding (required)..."
              style={{ padding: 6, fontSize: 12 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn"
              style={{ fontSize: 12, padding: '5px 10px' }}
              onClick={() => setSupersedingKd(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={isPending || !supersedeDueDate || !supersedeReason.trim()}
              style={{ fontSize: 12, padding: '5px 10px' }}
              onClick={() => {
                startTransition(async () => {
                  const res = await supersedeConfirmedKeyDateAction(
                    supersedingKd.id,
                    {
                      title: supersedeTitle,
                      dueDate: supersedeDueDate,
                      notes: supersedeNotes,
                    },
                    supersedeReason,
                  );
                  if (!res.ok) {
                    setFeedback({
                      kind: 'err',
                      text: res.error || 'Supersede failed.',
                    });
                  } else {
                    setFeedback({
                      kind: 'ok',
                      text: `Superseded ${supersedingKd.id} with ${res.replacementKeyDate?.id}.`,
                    });
                    setSupersedingKd(null);
                  }
                });
              }}
            >
              Supersede Key Date
            </button>
          </div>
        </div>
      )}

      {/* Resolve Modal */}
      {resolvingKd && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 8,
            background: '#f8fafc',
            border: '1px solid #cbd5e1',
          }}
        >
          <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>
            Resolve Key Date: {resolvingKd.title} ({resolvingKd.dueDate})
          </h4>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              value={resolveKind}
              onChange={(e) =>
                setResolveKind(e.target.value as 'met' | 'missed' | 'waived')
              }
              style={{ padding: 6, fontSize: 12 }}
            >
              {canResolve && <option value="met">Met</option>}
              {canResolve && <option value="missed">Missed (reason required)</option>}
              {canWaive && <option value="waived">Waived (reason required)</option>}
            </select>
            <input
              type="text"
              placeholder={
                resolveKind === 'met'
                  ? 'Optional outcome note...'
                  : 'Mandatory reason / outcome note...'
              }
              value={resolveNote}
              onChange={(e) => setResolveNote(e.target.value)}
              style={{ flex: 1, padding: 6, fontSize: 12 }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                isPending ||
                ((resolveKind === 'missed' || resolveKind === 'waived') &&
                  !resolveNote.trim())
              }
              style={{ fontSize: 12, padding: '6px 10px' }}
              onClick={() => {
                startTransition(async () => {
                  const res = await resolveKeyDateOutcomeAction(resolvingKd.id, {
                    kind: resolveKind,
                    note: resolveNote,
                  });
                  if (!res.ok) {
                    setFeedback({ kind: 'err', text: res.error || 'Resolve failed.' });
                  } else {
                    setFeedback({
                      kind: 'ok',
                      text: `Marked "${resolvingKd.title}" as ${resolveKind}.`,
                    });
                    setResolvingKd(null);
                  }
                });
              }}
            >
              Confirm Outcome
            </button>
            <button
              type="button"
              className="btn"
              style={{ fontSize: 12, padding: '6px 10px' }}
              onClick={() => setResolvingKd(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
