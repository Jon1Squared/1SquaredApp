'use client';

import React, { useState } from 'react';
import type {
  RegistersConfiguration,
  RegisterTypeDefinition,
} from '@platform/core-api';
import { saveRegistersConfigAction } from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { useToast } from './Toast';

interface RegistersAdminPanelProps {
  initialConfig: RegistersConfiguration;
  registerTypes: RegisterTypeDefinition[];
  canConfigure: boolean;
  hasMfaVerified: boolean;
}

export function RegistersAdminPanel({
  initialConfig,
  registerTypes,
  canConfigure,
  hasMfaVerified,
}: RegistersAdminPanelProps) {
  const { showToast } = useToast();
  const [config, setConfig] = useState<RegistersConfiguration>(() => ({
    defaultReminderHourLocal: initialConfig.defaultReminderHourLocal ?? 8,
    defaultDueDaysBefore: initialConfig.defaultDueDaysBefore ?? [14, 7, 1, 0, -1, -7],
    defaultReviewDaysBefore: initialConfig.defaultReviewDaysBefore ?? [14, 7, 0],
    customTypes: [...(initialConfig.customTypes ?? [])],
    typeOverrides: { ...(initialConfig.typeOverrides ?? {}) },
  }));
  const [dueOffsetsText, setDueOffsetsText] = useState<string>(
    (initialConfig.defaultDueDaysBefore ?? [14, 7, 1, 0, -1, -7]).join(', '),
  );
  const [reviewOffsetsText, setReviewOffsetsText] = useState<string>(
    (initialConfig.defaultReviewDaysBefore ?? [14, 7, 0]).join(', '),
  );
  const [reason, setReason] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);

  // Add custom register form
  const [customKey, setCustomKey] = useState<string>('');
  const [customLabel, setCustomLabel] = useState<string>('');
  const [customPlural, setCustomPlural] = useState<string>('');
  const [customPrefix, setCustomPrefix] = useState<string>('REG');
  const [customDescription, setCustomDescription] = useState<string>('');
  const [customRequireApproval, setCustomRequireApproval] = useState<boolean>(false);

  const canSave = canConfigure && hasMfaVerified;

  function parseOffsets(raw: string, fallback: readonly number[]): number[] {
    const parsed = raw
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= -365 && n <= 365);
    return parsed.length > 0 ? parsed : [...fallback];
  }

  function handleAddCustomType() {
    const cleanKey = customKey.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const cleanPrefix = customPrefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (!cleanKey || !customLabel.trim() || !customPlural.trim() || cleanPrefix.length < 2) {
      showToast('Provide a valid snake_case key, singular/plural labels, and 2-6 character prefix.');
      return;
    }
    const newType: RegisterTypeDefinition = {
      key: cleanKey,
      label: customLabel.trim(),
      pluralLabel: customPlural.trim(),
      description: customDescription.trim() || `Custom firm register: ${customLabel.trim()}.`,
      isCore: false,
      enabled: true,
      referencePrefix: cleanPrefix,
      initialStatus: customRequireApproval ? 'pending_approval' : 'open',
      createPermission: 'register:create',
      editPermission: 'register:edit',
      requireMatterLink: false,
      approvalRules: customRequireApproval
        ? {
            requireTwoPersonApproval: true,
            forbidSelfApproval: true,
            allowedApproverRoles: ['partner', 'managing_partner', 'risk_compliance'],
            requireAssignedApproverMatch: false,
          }
        : null,
      reminderSchedule: {
        enabled: true,
        dueDaysBefore: parseOffsets(dueOffsetsText, [14, 7, 1, 0]),
        reviewDaysBefore: parseOffsets(reviewOffsetsText, [14, 7, 0]),
        recipientMode: 'owner_and_approver',
      },
      states: customRequireApproval
        ? [
            { key: 'pending_approval', label: 'Pending approval', isTerminal: false, tone: 'warning' },
            { key: 'approved', label: 'Approved', isTerminal: true, tone: 'success' },
            { key: 'rejected', label: 'Rejected', isTerminal: true, tone: 'danger' },
          ]
        : [
            { key: 'open', label: 'Open', isTerminal: false, tone: 'info' },
            { key: 'closed', label: 'Closed', isTerminal: true, tone: 'success' },
          ],
      transitions: customRequireApproval
        ? [
            {
              key: 'approve',
              label: 'Approve',
              fromStatuses: ['pending_approval'],
              toStatus: 'approved',
              requiredPermission: 'register:approve',
              forbidSelfAction: true,
              setsDecidedAt: true,
            },
            {
              key: 'reject',
              label: 'Reject',
              fromStatuses: ['pending_approval'],
              toStatus: 'rejected',
              requiredPermission: 'register:approve',
              requiresComment: true,
              forbidSelfAction: true,
              setsDecidedAt: true,
            },
          ]
        : [
            {
              key: 'close',
              label: 'Close entry',
              fromStatuses: ['open'],
              toStatus: 'closed',
              requiredPermission: 'register:edit',
              setsDecidedAt: true,
            },
          ],
      fields: [
        {
          key: 'summaryNotes',
          label: 'Summary details',
          type: 'textarea',
          required: false,
        },
      ],
      showInNavigation: true,
    };

    setConfig((prev) => ({
      ...prev,
      customTypes: [
        ...(prev.customTypes ?? []).filter((t) => t.key !== newType.key),
        newType,
      ],
    }));
    setCustomKey('');
    setCustomLabel('');
    setCustomPlural('');
    setCustomDescription('');
    showToast(`Staged custom register "${newType.label}". Enter a reason and save to persist.`);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const nextPayload: RegistersConfiguration = {
        ...config,
        defaultDueDaysBefore: parseOffsets(dueOffsetsText, [14, 7, 1, 0, -1, -7]),
        defaultReviewDaysBefore: parseOffsets(reviewOffsetsText, [14, 7, 0]),
      };
      const res = await saveRegistersConfigAction(nextPayload, reason);
      if (isActionDenied(res) || !res.ok) {
        showToast(res.message || res.error || 'Could not save register configuration.');
        return;
      }
      setConfig(res.config);
      setReason('');
      showToast('Registers configuration saved and audited.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!hasMfaVerified ? (
        <div className="home-panel" style={{ padding: 14 }}>
          <strong>Multi-factor authentication required:</strong> Modifying registers configuration requires an MFA-verified session (`register:configure`).
        </div>
      ) : null}

      <section className="home-panel">
        <div className="panel-header">
          <div className="panel-title-group">
            <h2 className="panel-title">Reminder schedule &amp; register overrides</h2>
          </div>
        </div>
        <form className="panel-body padded" onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kv-label">Daily reminder sweep start hour (local)</span>
              <input
                type="number"
                min={0}
                max={23}
                className="form-input"
                value={config.defaultReminderHourLocal ?? 8}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    defaultReminderHourLocal: Number.parseInt(e.target.value, 10) || 0,
                  }))
                }
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kv-label">Default due offsets (days, comma-separated)</span>
              <input
                type="text"
                className="form-input"
                value={dueOffsetsText}
                onChange={(e) => setDueOffsetsText(e.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kv-label">Default review offsets (days, comma-separated)</span>
              <input
                type="text"
                className="form-input"
                value={reviewOffsetsText}
                onChange={(e) => setReviewOffsetsText(e.target.value)}
              />
            </label>
          </div>

          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>
              Active core &amp; custom registers ({registerTypes.length + (config.customTypes ?? []).filter((ct) => !registerTypes.some((rt) => rt.key === ct.key)).length})
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {registerTypes.map((rt) => {
                const override = config.typeOverrides?.[rt.key] ?? {};
                const effectiveEnabled = override.enabled ?? rt.enabled;
                return (
                  <div
                    key={rt.key}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '8px 12px',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 6,
                      gap: 12,
                    }}
                  >
                    <div>
                      <strong>{rt.pluralLabel}</strong> ({rt.key} · prefix {rt.referencePrefix})
                      <div className="muted" style={{ fontSize: 12 }}>{rt.description}</div>
                    </div>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={effectiveEnabled}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            typeOverrides: {
                              ...(prev.typeOverrides ?? {}),
                              [rt.key]: {
                                ...(prev.typeOverrides?.[rt.key] ?? {}),
                                enabled: e.target.checked,
                              },
                            },
                          }))
                        }
                      />
                      <span>Enabled</span>
                    </label>
                  </div>
                );
              })}
              {(config.customTypes ?? [])
                .filter((ct) => !registerTypes.some((rt) => rt.key === ct.key))
                .map((ct) => (
                  <div
                    key={ct.key}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '8px 12px',
                      border: '1px dashed var(--border-subtle)',
                      borderRadius: 6,
                    }}
                  >
                    <div>
                      <strong>{ct.pluralLabel}</strong> ({ct.key} · staged custom)
                      <div className="muted" style={{ fontSize: 12 }}>{ct.description}</div>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>Add custom register</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              <input
                type="text"
                className="form-input"
                placeholder="Key (e.g. gifts_hospitality)"
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
              />
              <input
                type="text"
                className="form-input"
                placeholder="Singular label (e.g. Gift declaration)"
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
              />
              <input
                type="text"
                className="form-input"
                placeholder="Plural title (e.g. Gifts & hospitality)"
                value={customPlural}
                onChange={(e) => setCustomPlural(e.target.value)}
              />
              <input
                type="text"
                className="form-input"
                placeholder="Prefix (e.g. GFT)"
                value={customPrefix}
                onChange={(e) => setCustomPrefix(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                className="form-input"
                placeholder="Short regulatory description"
                value={customDescription}
                onChange={(e) => setCustomDescription(e.target.value)}
                style={{ flex: 1, minWidth: 220 }}
              />
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={customRequireApproval}
                  onChange={(e) => setCustomRequireApproval(e.target.checked)}
                />
                <span>Require two-person approval</span>
              </label>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={handleAddCustomType}
              >
                + Stage custom register
              </button>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              required
              className="form-input"
              placeholder="Audited change reason (required)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              style={{ flex: 1, minWidth: 240 }}
            />
            <button
              type="submit"
              className="btn btn--primary btn--sm"
              disabled={!canSave || saving || !reason.trim()}
            >
              {saving ? 'Saving…' : 'Save registers configuration'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
