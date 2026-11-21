'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  getMyNotificationPreferencesAction,
  updateMyNotificationPreferencesAction,
} from '@/app/actions';
import type {
  NotificationChannelFrequency,
  NotificationKind,
  UserNotificationPreference,
} from '@platform/core-api';

interface NotificationKindMeta {
  readonly kind: NotificationKind;
  readonly label: string;
  readonly description: string;
  readonly defaultFrequency: NotificationChannelFrequency;
}

const NOTIFICATION_KIND_METADATA: readonly NotificationKindMeta[] = [
  {
    kind: 'task_assigned',
    label: 'Task assigned to you',
    description: 'Immediate notification when an individual task is allocated or reassigned to you.',
    defaultFrequency: 'immediate',
  },
  {
    kind: 'task_overdue',
    label: 'Task overdue',
    description: 'Urgent overdue task reminders requiring immediate action.',
    defaultFrequency: 'immediate',
  },
  {
    kind: 'enquiry_assigned',
    label: 'Enquiry assigned to you',
    description: 'New client enquiries allocated to you for first response.',
    defaultFrequency: 'immediate',
  },
  {
    kind: 'approval_requested',
    label: 'Approval or sign-off requested',
    description: 'Matters, costs, or register sign-offs awaiting your decision.',
    defaultFrequency: 'immediate',
  },
  {
    kind: 'approval_decided',
    label: 'Approval request decided',
    description: 'Outcome of an approval or sign-off request you submitted.',
    defaultFrequency: 'immediate',
  },
  {
    kind: 'register_review_assigned',
    label: 'Register review assigned',
    description: 'Firm compliance register records assigned for your review.',
    defaultFrequency: 'immediate',
  },
  {
    kind: 'team_task_arrived',
    label: 'New task in team queue',
    description: 'Tasks placed in one of your team queues to be claimed.',
    defaultFrequency: 'daily_digest',
  },
  {
    kind: 'task_comment',
    label: 'New comment on a task',
    description: 'Updates and discussions posted on tasks you own or created.',
    defaultFrequency: 'daily_digest',
  },
  {
    kind: 'register_reminder',
    label: 'Register compliance reminder',
    description: 'Scheduled periodic review and due-date reminders on firm registers.',
    defaultFrequency: 'daily_digest',
  },
  {
    kind: 'general',
    label: 'General notifications',
    description: 'Other system and workflow alerts not covered by a specific category.',
    defaultFrequency: 'daily_digest',
  },
];

const WORKING_DAY_OPTIONS: ReadonlyArray<{ readonly value: number; readonly label: string }> = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
];

const EMAIL_FREQUENCY_OPTIONS: ReadonlyArray<{
  readonly value: NotificationChannelFrequency;
  readonly label: string;
}> = [
  { value: 'immediate', label: 'Immediate email' },
  { value: 'daily_digest', label: 'Daily digest (08:00 Mon–Fri)' },
  { value: 'weekly_digest', label: 'Weekly digest' },
  { value: 'none', label: 'Off (none)' },
];

interface EditablePrefRow {
  inAppEnabled: boolean;
  emailFrequency: NotificationChannelFrequency;
  teamsEnabled: boolean;
}

function buildRowMap(
  prefs: readonly UserNotificationPreference[],
): Record<NotificationKind, EditablePrefRow> {
  const map = {} as Record<NotificationKind, EditablePrefRow>;
  const byKind = new Map(prefs.map((p) => [p.notificationKind, p]));
  for (const meta of NOTIFICATION_KIND_METADATA) {
    const existing = byKind.get(meta.kind);
    map[meta.kind] = {
      inAppEnabled: existing?.inAppEnabled ?? true,
      emailFrequency: existing?.emailFrequency ?? meta.defaultFrequency,
      teamsEnabled: existing?.teamsEnabled ?? false,
    };
  }
  return map;
}

function clampWorkingWeekday(raw: number | undefined): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 5) {
    return raw;
  }
  return 1;
}

export function NotificationPreferencesPanel({
  personId,
  initialPreferences,
  canManagePreferences,
}: {
  personId: string;
  initialPreferences?: readonly UserNotificationPreference[];
  canManagePreferences?: boolean;
}) {
  const [prevInitialPrefs, setPrevInitialPrefs] = useState(initialPreferences);
  const [rows, setRows] = useState<Record<NotificationKind, EditablePrefRow>>(() =>
    buildRowMap(initialPreferences ?? []),
  );
  const [digestDayOfWeek, setDigestDayOfWeek] = useState<number>(() =>
    clampWorkingWeekday(initialPreferences?.[0]?.digestDayOfWeek),
  );
  const [loading, setLoading] = useState(
    !initialPreferences || initialPreferences.length === 0,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (initialPreferences !== prevInitialPrefs) {
    setPrevInitialPrefs(initialPreferences);
    if (initialPreferences && initialPreferences.length > 0) {
      setRows(buildRowMap(initialPreferences));
      setDigestDayOfWeek(clampWorkingWeekday(initialPreferences[0]?.digestDayOfWeek));
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initialPreferences && initialPreferences.length > 0) {
      return;
    }
    let cancelled = false;
    void getMyNotificationPreferencesAction(personId)
      .then((res) => {
        if (cancelled) return;
        if (res.error) {
          setLoadError(res.error);
        } else if (res.preferences.length > 0) {
          setRows(buildRowMap(res.preferences));
          setDigestDayOfWeek(clampWorkingWeekday(res.preferences[0]?.digestDayOfWeek));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : 'Unable to load notification preferences.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [personId, initialPreferences]);

  const handleSave = () => {
    setSaveMessage(null);
    setSaveError(null);
    startTransition(async () => {
      const updates = NOTIFICATION_KIND_METADATA.map((meta) => ({
        notificationKind: meta.kind,
        inAppEnabled: rows[meta.kind].inAppEnabled,
        emailFrequency: rows[meta.kind].emailFrequency,
        teamsEnabled: rows[meta.kind].teamsEnabled,
      }));
      const res = await updateMyNotificationPreferencesAction({
        personId,
        updates,
        digestDayOfWeek,
      });
      if (res.error || !res.saved) {
        setSaveError(res.error ?? 'Unable to save notification preferences.');
        return;
      }
      if (res.preferences.length > 0) {
        setRows(buildRowMap(res.preferences));
        setDigestDayOfWeek(clampWorkingWeekday(res.preferences[0]?.digestDayOfWeek));
      }
      setSaveMessage('Your notification preferences have been saved.');
    });
  };

  return (
    <section className="card" aria-label="Notification preferences">
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div>
          <h2 className="section-title" style={{ marginBottom: 4 }}>
            Notification preferences
          </h2>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Customise how 1Squared notifies you in-app, by email, and through Microsoft Teams
            activity alerts. By default (Standard S4), urgent events are emailed immediately while
            routine updates are summarised in a weekday morning digest (08:00 local time, Monday to
            Friday). Microsoft Teams activity notifications are opt-in and never include confidential
            client names, matter titles, or narrative content.
          </p>
        </div>
      </div>

      {loadError ? (
        <div
          role="alert"
          style={{
            padding: '10px 12px',
            marginBottom: 12,
            borderRadius: 6,
            border: '1px solid var(--danger, #c53030)',
            fontSize: 13,
          }}
        >
          {loadError}
        </div>
      ) : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          padding: '10px 12px',
          marginBottom: 14,
          borderRadius: 6,
          background: 'var(--bg-subtle, rgba(0, 0, 0, 0.02))',
          border: '1px solid var(--border, rgba(0, 0, 0, 0.08))',
        }}
      >
        <div>
          <label
            htmlFor="notif-weekly-day"
            style={{ fontWeight: 600, fontSize: 13, display: 'block' }}
          >
            Weekly digest day (Monday–Friday)
          </label>
          <span className="muted" style={{ fontSize: 12 }}>
            Applies to any notification category configured for a weekly digest email.
          </span>
        </div>
        <select
          id="notif-weekly-day"
          className="input"
          style={{ width: 170 }}
          value={digestDayOfWeek}
          disabled={loading || isPending || canManagePreferences === false}
          onChange={(e) => {
            setDigestDayOfWeek(Number(e.target.value));
            setSaveMessage(null);
          }}
        >
          {WORKING_DAY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="muted" style={{ fontSize: 13 }}>
          Loading notification preferences...
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Notification category</th>
                <th style={{ textAlign: 'center', width: 96 }}>In-app</th>
                <th style={{ textAlign: 'left', width: 240 }}>Email delivery</th>
                <th style={{ textAlign: 'center', width: 140 }}>Microsoft Teams</th>
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_KIND_METADATA.map((meta) => {
                const row = rows[meta.kind];
                return (
                  <tr key={meta.kind}>
                    <td>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>{meta.label}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {meta.description}
                      </div>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        aria-label={`${meta.label} in-app notifications`}
                        checked={row.inAppEnabled}
                        disabled={isPending || canManagePreferences === false}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setRows((prev) => ({
                            ...prev,
                            [meta.kind]: { ...prev[meta.kind], inAppEnabled: checked },
                          }));
                          setSaveMessage(null);
                        }}
                      />
                    </td>
                    <td>
                      <select
                        className="input"
                        aria-label={`${meta.label} email delivery frequency`}
                        value={row.emailFrequency}
                        disabled={isPending || canManagePreferences === false}
                        onChange={(e) => {
                          const freq = e.target.value as NotificationChannelFrequency;
                          setRows((prev) => ({
                            ...prev,
                            [meta.kind]: { ...prev[meta.kind], emailFrequency: freq },
                          }));
                          setSaveMessage(null);
                        }}
                      >
                        {EMAIL_FREQUENCY_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        aria-label={`${meta.label} Microsoft Teams notifications`}
                        checked={row.teamsEnabled}
                        disabled={isPending || canManagePreferences === false}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setRows((prev) => ({
                            ...prev,
                            [meta.kind]: { ...prev[meta.kind], teamsEnabled: checked },
                          }));
                          setSaveMessage(null);
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {saveError ? (
        <p role="alert" style={{ color: 'var(--danger, #c53030)', fontSize: 13, marginTop: 12 }}>
          {saveError}
        </p>
      ) : null}
      {saveMessage ? (
        <p role="status" style={{ color: 'var(--success, #1f6f43)', fontSize: 13, marginTop: 12 }}>
          {saveMessage}
        </p>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={loading || isPending || canManagePreferences === false}
          onClick={handleSave}
        >
          {isPending ? 'Saving...' : 'Save notification preferences'}
        </button>
      </div>
    </section>
  );
}
