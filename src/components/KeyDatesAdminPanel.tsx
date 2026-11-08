'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import { saveKeyDatesConfigAction } from '@/app/actions';
import type {
  KeyDateCategory,
  KeyDatePermission,
  KeyDatesConfig,
  KeyDateTypeConfig,
  MatterTypeKeyDateConfig,
} from '@/domain/keyDates.types';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface KeyDatesAdminPanelProps {
  initialConfig: KeyDatesConfig;
  userPermissions: KeyDatePermission[];
}

export function KeyDatesAdminPanel({
  initialConfig,
  userPermissions,
}: KeyDatesAdminPanelProps) {
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  const canConfigure = userPermissions.includes('keydate:configure');

  const [draft, setDraft] = useState<KeyDatesConfig>(() =>
    JSON.parse(JSON.stringify(initialConfig)),
  );
  const [subTab, setSubTab] = useState<
    'defaults' | 'types' | 'matterTypes' | 'reminders' | 'rules' | 'calendars'
  >('defaults');
  const [changeReason, setChangeReason] = useState<string>('');

  // New Key Date Type form
  const [newTypeId, setNewTypeId] = useState('');
  const [newTypeLabel, setNewTypeLabel] = useState('');
  const [newTypeCategory, setNewTypeCategory] = useState<KeyDateCategory>('court_deadline');
  const [newTypeCritical, setNewTypeCritical] = useState(false);

  // New Matter Type Policy form
  const [newMatterTypeId, setNewMatterTypeId] = useState('');
  const [newMtVerifyRequired, setNewMtVerifyRequired] = useState(true);
  const [newMtVerifyAppliesTo, setNewMtVerifyAppliesTo] = useState<
    'all' | 'critical_only' | 'limitation_only'
  >('critical_only');
  const [newMtBlockClosure, setNewMtBlockClosure] = useState(true);
  const [newMtCalSync, setNewMtCalSync] = useState(true);

  // New Holiday form
  const [selectedCalId, setSelectedCalId] = useState<string>(
    initialConfig.businessCalendars?.[0]?.id ?? 'england_wales',
  );
  const [newHolidayIso, setNewHolidayIso] = useState('');

  const handleSaveAll = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canConfigure) {
      showToast('You do not hold the keydate:configure permission.');
      return;
    }
    if (!changeReason.trim()) {
      showToast('Please enter an audit reason before saving configuration changes.');
      return;
    }
    startTransition(async () => {
      const res = await saveKeyDatesConfigAction(draft, changeReason.trim());
      if (!res.ok) {
        showToast(res.error ?? 'Failed to save configuration.');
        return;
      }
      if (res.config) {
        setDraft(res.config);
      }
      setChangeReason('');
      showToast('Key dates configuration saved and audited.');
    });
  };

  const handleAddKeyDateType = () => {
    if (!newTypeId.trim() || !newTypeLabel.trim()) return;
    const nextType: KeyDateTypeConfig = {
      id: newTypeId.trim(),
      label: newTypeLabel.trim(),
      category: newTypeCategory,
      defaultCritical: newTypeCritical,
      active: true,
    };
    setDraft((prev) => ({
      ...prev,
      keyDateTypes: [...(prev.keyDateTypes ?? []).filter((t) => t.id !== nextType.id), nextType],
    }));
    setNewTypeId('');
    setNewTypeLabel('');
    setNewTypeCritical(false);
  };

  const handleAddMatterTypePolicy = () => {
    if (!newMatterTypeId.trim()) return;
    const nextMt: MatterTypeKeyDateConfig = {
      matterTypeId: newMatterTypeId.trim(),
      requiredKeyDateTypeIds: [],
      blockClosureWithOpenDates: newMtBlockClosure,
      verification: {
        required: newMtVerifyRequired,
        appliesTo: newMtVerifyAppliesTo,
      },
      calendarSync: {
        enabled: newMtCalSync,
      },
    };
    setDraft((prev) => ({
      ...prev,
      matterTypes: [
        ...(prev.matterTypes ?? []).filter((m) => m.matterTypeId !== nextMt.matterTypeId),
        nextMt,
      ],
    }));
    setNewMatterTypeId('');
  };

  const handleToggleRuleSetReviewed = (ruleSetId: string) => {
    setDraft((prev) => ({
      ...prev,
      limitationRuleSets: (prev.limitationRuleSets ?? []).map((rs) =>
        rs.id === ruleSetId
          ? {
              ...rs,
              reviewStatus: rs.reviewStatus === 'reviewed' ? 'unreviewed' : 'reviewed',
              reviewedBy:
                rs.reviewStatus === 'reviewed' ? undefined : rs.reviewedBy,
              reviewedOn:
                rs.reviewStatus === 'reviewed' ? undefined : new Date().toISOString().slice(0, 10),
            }
          : rs,
      ),
    }));
  };

  const handleAddHoliday = () => {
    if (!newHolidayIso) return;
    setDraft((prev) => ({
      ...prev,
      businessCalendars: (prev.businessCalendars ?? []).map((cal) => {
        const dates = cal.nonWorkingDates ?? [];
        if (cal.id === selectedCalId && !dates.includes(newHolidayIso)) {
          return { ...cal, nonWorkingDates: [...dates, newHolidayIso].sort() };
        }
        return cal;
      }),
    }));
    setNewHolidayIso('');
  };

  const keyDateTypes = draft.keyDateTypes ?? [];
  const matterTypes = draft.matterTypes ?? [];
  const reminderSchedules = draft.reminderSchedules ?? [];
  const limitationRuleSets = draft.limitationRuleSets ?? [];
  const businessCalendars = draft.businessCalendars ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        className="card"
        style={{
          padding: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Key Dates &amp; Limitation Configuration</h2>
          <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
            Schema-validated tenant configuration for key date types, matter type verification and
            closure gates, reminder schedules, limitation rule sets, and business calendars. Every
            change is written to the immutable audit log with before and after snapshots.
          </p>
        </div>
        <Link href="/docs/key-dates-administration" className="btn btn--ghost btn--sm">
          Administration guide
        </Link>
      </div>

      {!canConfigure ? (
        <div className="card" style={{ padding: 16 }}>
          <p className="muted">
            Read-only view: you need the <code>keydate:configure</code> permission to edit key dates
            configuration.
          </p>
        </div>
      ) : null}

      <div className="tabs-bar" role="tablist" aria-label="Key dates admin sections">
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'defaults'}
          className={`tab-btn ${subTab === 'defaults' ? 'tab-btn--active' : ''}`}
          onClick={() => setSubTab('defaults')}
        >
          Module &amp; defaults
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'types'}
          className={`tab-btn ${subTab === 'types' ? 'tab-btn--active' : ''}`}
          onClick={() => setSubTab('types')}
        >
          Key date types ({keyDateTypes.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'matterTypes'}
          className={`tab-btn ${subTab === 'matterTypes' ? 'tab-btn--active' : ''}`}
          onClick={() => setSubTab('matterTypes')}
        >
          Matter type settings ({matterTypes.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'reminders'}
          className={`tab-btn ${subTab === 'reminders' ? 'tab-btn--active' : ''}`}
          onClick={() => setSubTab('reminders')}
        >
          Reminder schedules ({reminderSchedules.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'rules'}
          className={`tab-btn ${subTab === 'rules' ? 'tab-btn--active' : ''}`}
          onClick={() => setSubTab('rules')}
        >
          Limitation rule sets ({limitationRuleSets.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'calendars'}
          className={`tab-btn ${subTab === 'calendars' ? 'tab-btn--active' : ''}`}
          onClick={() => setSubTab('calendars')}
        >
          Business calendars ({businessCalendars.length})
        </button>
      </div>

      {/* Sub-tab 1: Defaults */}
      {subTab === 'defaults' ? (
        <div className="card" style={{ padding: 16 }}>
          <div className="form-grid" style={{ gap: 16 }}>
            <div className="field-group">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  disabled={!canConfigure}
                  checked={draft.enabled}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, enabled: e.target.checked }))
                  }
                />
                <strong>Enable Key Dates &amp; Limitation module (`keyDates.enabled`)</strong>
              </label>
            </div>
            <div className="field-group">
              <label className="field-label">Default reminder schedule</label>
              <select
                className="field-select"
                disabled={!canConfigure}
                value={draft.defaults?.reminderScheduleId ?? reminderSchedules[0]?.id ?? ''}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    defaults: {
                      ...prev.defaults,
                      reminderScheduleId: e.target.value,
                    },
                  }))
                }
              >
                {reminderSchedules.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} ({s.id})
                  </option>
                ))}
              </select>
            </div>
            <div className="field-group">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  disabled={!canConfigure}
                  checked={draft.defaults?.verification?.required ?? false}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      defaults: {
                        ...prev.defaults,
                        verification: {
                          ...prev.defaults?.verification,
                          required: e.target.checked,
                        },
                      },
                    }))
                  }
                />
                <span>Default two-step verification required</span>
              </label>
            </div>
            <div className="field-group">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  disabled={!canConfigure}
                  checked={draft.defaults?.calendarSync?.enabled ?? true}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      defaults: {
                        ...prev.defaults,
                        calendarSync: {
                          ...prev.defaults?.calendarSync,
                          enabled: e.target.checked,
                        },
                      },
                    }))
                  }
                />
                <span>Default one-way Outlook calendar sync enabled</span>
              </label>
            </div>
          </div>
        </div>
      ) : null}

      {/* Sub-tab 2: Key Date Types */}
      {subTab === 'types' ? (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {keyDateTypes.map((t) => (
              <div key={t.id} className="list-row" style={{ padding: 10 }}>
                <div className="list-row__main">
                  <strong>{t.label}</strong> <code>({t.id})</code> ·{' '}
                  <StatusPill label={t.category} tone="neutral" />{' '}
                  {t.defaultCritical ? (
                    <StatusPill label="Critical by default" tone="alert" />
                  ) : null}{' '}
                  {t.active === false ? <StatusPill label="Inactive" tone="neutral" /> : null}
                </div>
                {canConfigure ? (
                  <div className="list-row__aside">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          keyDateTypes: (prev.keyDateTypes ?? []).map((item) =>
                            item.id === t.id
                              ? { ...item, active: item.active === false ? true : false }
                              : item,
                          ),
                        }))
                      }
                    >
                      {t.active === false ? 'Activate' : 'Deactivate'}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {canConfigure ? (
            <div
              className="form-grid"
              style={{
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 8,
                alignItems: 'end',
              }}
            >
              <div className="field-group">
                <label className="field-label">Type ID</label>
                <input
                  type="text"
                  className="field-input"
                  value={newTypeId}
                  onChange={(e) => setNewTypeId(e.target.value)}
                  placeholder="e.g. court_hearing"
                />
              </div>
              <div className="field-group">
                <label className="field-label">Label</label>
                <input
                  type="text"
                  className="field-input"
                  value={newTypeLabel}
                  onChange={(e) => setNewTypeLabel(e.target.value)}
                  placeholder="e.g. Court hearing date"
                />
              </div>
              <div className="field-group">
                <label className="field-label">Category</label>
                <select
                  className="field-select"
                  value={newTypeCategory}
                  onChange={(e) => setNewTypeCategory(e.target.value as KeyDateCategory)}
                >
                  <option value="limitation">Limitation</option>
                  <option value="court_deadline">Court deadline</option>
                  <option value="contractual">Contractual</option>
                  <option value="undertaking">Undertaking</option>
                  <option value="compliance">Compliance</option>
                  <option value="internal_milestone">Internal milestone</option>
                </select>
              </div>
              <div className="field-group">
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={newTypeCritical}
                    onChange={(e) => setNewTypeCritical(e.target.checked)}
                  />
                  <span>Critical by default</span>
                </label>
              </div>
              <div>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={handleAddKeyDateType}
                >
                  Add key date type
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Sub-tab 3: Matter Type Policies */}
      {subTab === 'matterTypes' ? (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {matterTypes.map((mt) => (
              <div key={mt.matterTypeId} className="list-row" style={{ padding: 10 }}>
                <div className="list-row__main">
                  <strong>Matter Type: {mt.matterTypeId}</strong>
                  <div className="list-row__meta">
                    Required types:{' '}
                    {(mt.requiredKeyDateTypeIds?.length ?? 0) > 0
                      ? mt.requiredKeyDateTypeIds?.join(', ')
                      : 'None'}{' '}
                    · Block closure with open dates:{' '}
                    {mt.blockClosureWithOpenDates ? 'Yes' : 'No'} · Verification:{' '}
                    {mt.verification?.required
                      ? `Required (${mt.verification.appliesTo ?? 'all'})`
                      : 'Default'}{' '}
                    · Calendar sync:{' '}
                    {mt.calendarSync?.enabled === false ? 'Disabled' : 'Enabled'}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {canConfigure ? (
            <div
              className="form-grid"
              style={{
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 8,
                alignItems: 'end',
              }}
            >
              <div className="field-group">
                <label className="field-label">Matter type ID</label>
                <input
                  type="text"
                  className="field-input"
                  value={newMatterTypeId}
                  onChange={(e) => setNewMatterTypeId(e.target.value)}
                  placeholder="e.g. commercial_disputes"
                />
              </div>
              <div className="field-group">
                <label className="field-label">Verification scope</label>
                <select
                  className="field-select"
                  value={newMtVerifyAppliesTo}
                  onChange={(e) =>
                    setNewMtVerifyAppliesTo(
                      e.target.value as 'all' | 'critical_only' | 'limitation_only',
                    )
                  }
                >
                  <option value="critical_only">Critical only</option>
                  <option value="limitation_only">Limitation only</option>
                  <option value="all">All key dates</option>
                </select>
              </div>
              <div className="field-group">
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={newMtVerifyRequired}
                    onChange={(e) => setNewMtVerifyRequired(e.target.checked)}
                  />
                  <span>Require verification</span>
                </label>
              </div>
              <div className="field-group">
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={newMtBlockClosure}
                    onChange={(e) => setNewMtBlockClosure(e.target.checked)}
                  />
                  <span>Block closure with open dates</span>
                </label>
              </div>
              <div className="field-group">
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={newMtCalSync}
                    onChange={(e) => setNewMtCalSync(e.target.checked)}
                  />
                  <span>Enable Outlook sync</span>
                </label>
              </div>
              <div>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={handleAddMatterTypePolicy}
                >
                  Save matter type policy
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Sub-tab 4: Reminder Schedules */}
      {subTab === 'reminders' ? (
        <div className="card" style={{ padding: 16 }}>
          {reminderSchedules.map((sched) => (
            <div
              key={sched.id}
              style={{
                padding: 12,
                border: '1px solid var(--border-subtle, #e2e8f0)',
                borderRadius: 8,
                marginBottom: 12,
              }}
            >
              <strong>
                {sched.label} <code>({sched.id})</code>
              </strong>
              <div className="list-row__meta" style={{ marginTop: 4 }}>
                Stages (days before due):{' '}
                {sched.stages
                  .map((s) => `${s.daysBefore}d (${s.priority ?? 'normal'})`)
                  .join(' → ')}
              </div>
              <div className="list-row__meta" style={{ marginTop: 2 }}>
                Escalation after {sched.escalation?.afterUnacknowledgedDays ?? 2} unacknowledged
                days:{' '}
                {(sched.escalation?.levels ?? []).map((l, idx) => `L${idx + 1}: ${l}`).join(' → ')}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* Sub-tab 5: Limitation Rule Sets */}
      {subTab === 'rules' ? (
        <div className="card" style={{ padding: 16 }}>
          {limitationRuleSets.map((rs) => (
            <div
              key={rs.id}
              style={{
                padding: 12,
                border: '1px solid var(--border-subtle, #e2e8f0)',
                borderRadius: 8,
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <div>
                  <strong>{rs.label}</strong> <code>({rs.id})</code> · Jurisdiction:{' '}
                  <code>{rs.jurisdiction}</code> · Version: {rs.version}{' '}
                  <StatusPill
                    label={
                      rs.reviewStatus === 'reviewed'
                        ? `Reviewed (${rs.reviewedOn ?? 'verified'}${rs.reviewedBy ? ` by ${rs.reviewedBy}` : ''})`
                        : 'Unreviewed (forces two-step verification)'
                    }
                    tone={rs.reviewStatus === 'reviewed' ? 'positive' : 'warning'}
                  />
                </div>
                {canConfigure ? (
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => handleToggleRuleSetReviewed(rs.id)}
                  >
                    Mark as {rs.reviewStatus === 'reviewed' ? 'unreviewed' : 'reviewed'}
                  </button>
                ) : null}
              </div>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rs.rules.map((r) => (
                  <div key={r.id} className="list-row__meta">
                    • <strong>{r.label}</strong> (<code>{r.id}</code>): {r.guidanceNote}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* Sub-tab 6: Business Calendars */}
      {subTab === 'calendars' ? (
        <div className="card" style={{ padding: 16 }}>
          {businessCalendars.map((cal) => (
            <div
              key={cal.id}
              style={{
                padding: 12,
                border: '1px solid var(--border-subtle, #e2e8f0)',
                borderRadius: 8,
                marginBottom: 12,
              }}
            >
              <strong>
                {cal.label} <code>({cal.id})</code>
              </strong>
              <div className="list-row__meta" style={{ marginTop: 4 }}>
                Configured holidays ({cal.nonWorkingDates?.length ?? 0}):{' '}
                {(cal.nonWorkingDates ?? []).join(', ') || 'None'}
              </div>
            </div>
          ))}
          {canConfigure ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="field-group">
                <label className="field-label">Calendar</label>
                <select
                  className="field-select"
                  value={selectedCalId}
                  onChange={(e) => setSelectedCalId(e.target.value)}
                >
                  {businessCalendars.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-group">
                <label className="field-label">Add bank holiday (YYYY-MM-DD)</label>
                <input
                  type="date"
                  className="field-input"
                  value={newHolidayIso}
                  onChange={(e) => setNewHolidayIso(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={handleAddHoliday}
              >
                Add holiday
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Audit & Save Bar */}
      {canConfigure ? (
        <form onSubmit={handleSaveAll} className="card" style={{ padding: 16 }}>
          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'flex-end',
              flexWrap: 'wrap',
            }}
          >
            <div className="field-group" style={{ flex: 1, minWidth: 260 }}>
              <label className="field-label" htmlFor="kd-config-audit-reason">
                Audit reason for configuration change (required)
              </label>
              <input
                id="kd-config-audit-reason"
                type="text"
                required
                className="field-input"
                value={changeReason}
                onChange={(e) => setChangeReason(e.target.value)}
                placeholder="e.g. Reviewed England & Wales limitation rule set with COLP"
              />
            </div>
            <button type="submit" className="btn btn--primary" disabled={pending}>
              Save &amp; audit configuration
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
