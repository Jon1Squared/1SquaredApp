'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type {
  ChasingConfiguration,
  EmailOutboxAdminDetail,
  EmailOutboxAdminListItem,
  EmailOutboxStatus,
  EngagementConfiguration,
} from '@platform/core-api';
import {
  getOutboxMessageForAdminAction,
  listOutboxMessagesForAdminAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { formatDateTime } from '@/domain/dates';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface AdminEmailOutboxPanelProps {
  effectiveChasingConfig?: ChasingConfiguration;
  effectiveEngagementConfig?: EngagementConfiguration;
  emailProviderDisabled?: boolean;
  hasMfaVerified?: boolean;
}

function outboxStatusTone(status: EmailOutboxStatus) {
  switch (status) {
    case 'sent':
      return 'positive' as const;
    case 'failed_permanent':
      return 'alert' as const;
    case 'dropped_allowlist':
    case 'pending':
    case 'sending':
    default:
      return 'warning' as const;
  }
}

export function AdminEmailOutboxPanel({
  effectiveChasingConfig,
  effectiveEngagementConfig,
  emailProviderDisabled = false,
  hasMfaVerified = false,
}: AdminEmailOutboxPanelProps) {
  const { showToast } = useToast();
  const [statusFilter, setStatusFilter] = useState<EmailOutboxStatus | ''>('');
  const [messages, setMessages] = useState<EmailOutboxAdminListItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<EmailOutboxAdminDetail | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);

  const loadMessages = useCallback(async (status?: EmailOutboxStatus | '') => {
    setLoadingList(true);
    setListError(null);
    try {
      const res = await listOutboxMessagesForAdminAction({
        ...(status ? { status } : {}),
        limit: 50,
      });
      if (isActionDenied(res)) {
        setListError(res.message);
        setMessages([]);
        return;
      }
      if (!res.ok) {
        setListError(res.message || 'Could not load email outbox messages.');
        return;
      }
      setMessages([...res.messages]);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (!hasMfaVerified) return;
    let cancelled = false;
    void (async () => {
      const res = await listOutboxMessagesForAdminAction({
        ...(statusFilter ? { status: statusFilter } : {}),
        limit: 50,
      });
      if (cancelled) return;
      if (isActionDenied(res)) {
        setListError(res.message);
        setMessages([]);
        return;
      }
      if (!res.ok) {
        setListError(res.message || 'Could not load email outbox messages.');
        return;
      }
      setListError(null);
      setMessages([...res.messages]);
    })();
    return () => {
      cancelled = true;
    };
  }, [hasMfaVerified, statusFilter]);

  const handleInspect = async (outboxId: string) => {
    setLoadingDetailId(outboxId);
    try {
      const res = await getOutboxMessageForAdminAction({ outboxId });
      if (isActionDenied(res)) {
        showToast(res.message);
        return;
      }
      if (!res.ok) {
        showToast(res.message || 'Outbox message could not be opened.');
        return;
      }
      setSelectedDetail(res.message);
    } finally {
      setLoadingDetailId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section className="subcard" data-testid="admin-email-outbox-panel">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            marginBottom: 12,
          }}
        >
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
              Email Outbox
            </h2>
            <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
              Inspect queued, sent, or blocked outbound emails and download attached PDFs for matters and enquiries you are permitted to view. Every message view and download is written to the audit log.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="muted" htmlFor="outbox-status-filter" style={{ fontSize: 12.5 }}>
              Status:
            </label>
            <select
              id="outbox-status-filter"
              className="field-select"
              data-testid="outbox-status-filter"
              style={{ width: 'auto', minWidth: 160 }}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as EmailOutboxStatus | '')}
              disabled={loadingList}
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="sent">Sent</option>
              <option value="dropped_allowlist">Dropped (allow-list)</option>
              <option value="failed_permanent">Failed permanent</option>
            </select>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              data-testid="outbox-refresh-btn"
              disabled={loadingList}
              onClick={() => void loadMessages(statusFilter)}
            >
              {loadingList ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {emailProviderDisabled ? (
          <div
            className="banner banner--warning"
            data-testid="outbox-delivery-paused-banner"
            style={{ marginBottom: 12 }}
          >
            <span>
              Outbound email delivery is currently paused on this environment (provider disabled). Messages generated by letters and follow-ups remain queued in <strong>pending</strong> status here so administrators can inspect recipients, wording, and PDF attachments without sending external mail.
            </span>
          </div>
        ) : null}

        {listError ? (
          <div className="banner banner--warning" role="alert" style={{ marginBottom: 12 }}>
            {listError}
          </div>
        ) : null}

        {messages.length === 0 && !loadingList && !listError ? (
          <p className="muted" style={{ margin: '8px 0', fontSize: 13 }}>
            No visible outbox messages match the selected status filter.
          </p>
        ) : null}

        {messages.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" data-testid="outbox-messages-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Recipients</th>
                  <th>Subject</th>
                  <th>Template</th>
                  <th>Attachments</th>
                  <th>Created</th>
                  <th>Sent</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {messages.map((msg) => (
                  <tr key={msg.id} data-testid={`outbox-row-${msg.id}`}>
                    <td>
                      <StatusPill label={msg.status} tone={outboxStatusTone(msg.status)} />
                    </td>
                    <td>{msg.recipients.to.join(', ') || '—'}</td>
                    <td>{msg.subject || '(no subject)'}</td>
                    <td>{msg.templateKey}</td>
                    <td>{msg.attachments.length}</td>
                    <td>{formatDateTime(msg.createdAt)}</td>
                    <td>{msg.sentAt ? formatDateTime(msg.sentAt) : '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        data-testid={`inspect-outbox-btn-${msg.id}`}
                        disabled={loadingDetailId === msg.id}
                        onClick={() => void handleInspect(msg.id)}
                      >
                        {loadingDetailId === msg.id ? 'Opening…' : 'Inspect'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {selectedDetail ? (
          <div
            className="subcard"
            data-testid="outbox-message-detail"
            style={{ marginTop: 14, background: 'var(--bg-subtle)', display: 'grid', gap: 10 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                {selectedDetail.subject || '(no subject)'}
              </div>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => setSelectedDetail(null)}
              >
                Close
              </button>
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              <strong>To:</strong> {selectedDetail.recipients.to.join(', ') || '—'} &middot;{' '}
              <strong>Status:</strong> {selectedDetail.status} &middot;{' '}
              <strong>Template:</strong> {selectedDetail.templateKey} &middot;{' '}
              <strong>Queued:</strong> {formatDateTime(selectedDetail.createdAt)}
            </div>
            <pre
              data-testid="outbox-message-text-body"
              style={{
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
                fontSize: 13,
                margin: 0,
                padding: 12,
                borderRadius: 8,
                background: 'var(--surface, #fff)',
                border: '1px solid var(--border, #e2e8f0)',
              }}
            >
              {selectedDetail.textBody || '(no plain-text body stored)'}
            </pre>
            {selectedDetail.attachments.length > 0 ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <strong style={{ fontSize: 12.5 }}>Attachments:</strong>
                {selectedDetail.attachments.map((att, idx) => {
                  const ordinal = 'ordinal' in att ? att.ordinal : idx;
                  return (
                    <a
                      key={`${selectedDetail.id}-${ordinal}`}
                      href={`/api/admin/outbox/${encodeURIComponent(selectedDetail.id)}/attachments/${ordinal}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn--secondary btn--sm"
                      data-testid={`outbox-attachment-link-${ordinal}`}
                    >
                      Download {att.fileName}
                    </a>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {effectiveChasingConfig || effectiveEngagementConfig ? (
        <section className="subcard" data-testid="admin-engagement-chasing-summary">
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px' }}>
            Engagement &amp; automated chasing settings (read-only)
          </h3>
          <p className="muted" style={{ fontSize: 12.5, margin: '0 0 12px' }}>
            Current tenant configuration active for engagement letters and scheduled follow-ups. Interactive in-app editors for wording and chase schedules will be added in a future release.
          </p>
          {effectiveChasingConfig ? (
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', marginBottom: 12 }}>
              {(
                [
                  { label: 'Client Care engagement letters', rule: effectiveChasingConfig.engagementLetter },
                  { label: 'Quotes', rule: effectiveChasingConfig.quote },
                  { label: 'Money on account', rule: effectiveChasingConfig.moneyOnAccount },
                ] as const
              ).map((item) => (
                <div key={item.label} className="subcard" style={{ background: 'var(--bg-subtle)' }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{item.label}</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                    Chasing: {item.rule.enabled ? 'Enabled' : 'Disabled'} · Emails:{' '}
                    {item.rule.sendEmails ? 'On' : 'Off'}
                  </div>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    Schedule: Day {item.rule.firstChaseDays} / Day {item.rule.secondChaseDays} / Task Day{' '}
                    {item.rule.escalateTaskDays}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {effectiveEngagementConfig ? (
            <div className="muted" style={{ fontSize: 12.5 }}>
              <strong>Standard terms configured:</strong>{' '}
              {effectiveEngagementConfig.clientCareTermsSummary
                ? 'Client Care introduction, terms summary, signature instruction, and non-engagement wording (conflict, outside expertise, not viable, referred out, default).'
                : 'Using platform fallback wording.'}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
