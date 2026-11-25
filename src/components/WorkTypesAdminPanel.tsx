'use client';

import React, { useMemo, useState, useTransition } from 'react';
import {
  listActiveStatutoryFeeCaps,
  type HomeRoleKey,
  type WorkTypeAutoTaskTemplateConfig,
  type WorkTypeConfigItem,
  type WorkTypeOpeningGateConfig,
  type WorkTypeRiskQuestionConfig,
  type WorkTypeRiskQuestionOptionConfig,
  type WorkTypesConfiguration,
} from '@platform/core-api';
import { saveWorkTypesConfigAction } from '@/app/actions';
import { valuesForList } from '@/domain/lists';
import {
  isWorkTypeChoiceActive,
  resolveDepartmentForPracticeArea,
} from '@/domain/orgStructure';
import type {
  ChoiceValue,
  MatterCostsConfig,
  OrgStructureCatalogue,
} from '@/domain/types';
import {
  resolveWorkTypeAutoTaskTemplates,
  resolveWorkTypeRetention,
  resolveWorkTypeRiskQuestions,
} from '@/domain/workTypeConfig';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface WorkTypesAdminPanelProps {
  initialConfig: WorkTypesConfiguration;
  values: ChoiceValue[];
  orgStructure?: OrgStructureCatalogue;
  matterCostsConfig?: MatterCostsConfig | null;
  canEdit: boolean;
  hasMfaVerified?: boolean;
}

const ROLE_KEY_OPTIONS: Array<{ key: HomeRoleKey; label: string }> = [
  { key: 'fee_earner', label: 'Lead Fee Earner' },
  { key: 'supervisor', label: 'Supervising Partner' },
  { key: 'partner', label: 'Responsible Partner' },
  { key: 'legal_secretary', label: 'Support / Legal Secretary' },
  { key: 'intake', label: 'Intake Team' },
  { key: 'enquiries_coordinator', label: 'Enquiries Coordinator' },
  { key: 'finance', label: 'Accounts / Finance' },
  { key: 'risk_compliance', label: 'Risk & Compliance' },
  { key: 'managing_partner', label: 'Managing Partner' },
  { key: 'admin', label: 'Administrator' },
];

const PRIORITY_OPTIONS: Array<{
  id: WorkTypeAutoTaskTemplateConfig['priorityId'];
  label: string;
}> = [
  { id: 'task_priority.low', label: 'Low' },
  { id: 'task_priority.normal', label: 'Normal' },
  { id: 'task_priority.high', label: 'High' },
  { id: 'task_priority.urgent', label: 'Urgent' },
];

const SECTION_KEY_OPTIONS: Array<{
  key: WorkTypeRiskQuestionConfig['sectionKey'];
  label: string;
}> = [
  { key: 'work_type', label: 'Work-type risk factors' },
  { key: 'client', label: 'Client due diligence' },
  { key: 'matter', label: 'Matter characteristics' },
  { key: 'jurisdiction', label: 'Jurisdiction & geography' },
  { key: 'delivery', label: 'Delivery channel' },
];

function cloneConfig(cfg: WorkTypesConfiguration): WorkTypesConfiguration {
  return JSON.parse(JSON.stringify(cfg)) as WorkTypesConfiguration;
}

export function WorkTypesAdminPanel({
  initialConfig,
  values,
  orgStructure,
  matterCostsConfig = null,
  canEdit,
  hasMfaVerified = true,
}: WorkTypesAdminPanelProps) {
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<WorkTypesConfiguration>(() =>
    cloneConfig(initialConfig),
  );
  const [subTab, setSubTab] = useState<'items' | 'defaults'>('items');
  const [search, setSearch] = useState('');
  const [selectedWorkTypeId, setSelectedWorkTypeId] = useState<string | null>(null);
  const [changeReason, setChangeReason] = useState('');

  // Auto-task draft inputs (shared between Defaults and selected Item editor)
  const [newTplId, setNewTplId] = useState('');
  const [newTplTitle, setNewTplTitle] = useState('');
  const [newTplOffset, setNewTplOffset] = useState('5');
  const [newTplPriority, setNewTplPriority] =
    useState<WorkTypeAutoTaskTemplateConfig['priorityId']>('task_priority.normal');
  const [newTplRole, setNewTplRole] = useState<HomeRoleKey>('fee_earner');

  // Risk question draft inputs
  const [newQId, setNewQId] = useState('');
  const [newQPrompt, setNewQPrompt] = useState('');
  const [newQSectionKey, setNewQSectionKey] =
    useState<WorkTypeRiskQuestionConfig['sectionKey']>('work_type');
  const [newQWeight, setNewQWeight] = useState('2');
  const [newQRequired, setNewQRequired] = useState(true);
  const [newQLowLabel, setNewQLowLabel] = useState('No');
  const [newQMedLabel, setNewQMedLabel] = useState('Partially / under review');
  const [newQHighLabel, setNewQHighLabel] = useState('Yes (elevated risk)');
  const [newQHighScore, setNewQHighScore] = useState('3');

  const workTypeChoices = useMemo(() => valuesForList(values, 'work_type'), [values]);
  const practiceAreas = useMemo(
    () => workTypeChoices.filter((v) => !v.parentId),
    [workTypeChoices],
  );
  const subcategories = useMemo(
    () => workTypeChoices.filter((v) => Boolean(v.parentId)),
    [workTypeChoices],
  );

  const selectedChoice = useMemo(
    () => workTypeChoices.find((v) => v.id === selectedWorkTypeId) ?? null,
    [workTypeChoices, selectedWorkTypeId],
  );

  const selectedItem = useMemo(
    () =>
      selectedWorkTypeId
        ? draft.items.find((i) => i.workTypeId === selectedWorkTypeId) ?? null
        : null,
    [draft.items, selectedWorkTypeId],
  );

  const filteredPracticeAreas = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return practiceAreas;
    return practiceAreas.filter((pa) => {
      if (pa.label.toLowerCase().includes(q) || pa.id.toLowerCase().includes(q)) {
        return true;
      }
      return subcategories.some(
        (sub) =>
          sub.parentId === pa.id &&
          (sub.label.toLowerCase().includes(q) || sub.id.toLowerCase().includes(q)),
      );
    });
  }, [practiceAreas, subcategories, search]);

  const ensureSelectedItem = (choice: ChoiceValue): WorkTypeConfigItem => {
    const existing = draft.items.find((i) => i.workTypeId === choice.id);
    if (existing) return existing;
    const created: WorkTypeConfigItem = {
      workTypeId: choice.id,
      practiceAreaId: choice.parentId ?? choice.id,
      active: true,
      autoTaskTemplates: [],
      riskQuestions: [],
    };
    setDraft((prev) => ({
      ...prev,
      items: [...prev.items, created],
    }));
    return created;
  };

  const updateSelectedItem = (
    choice: ChoiceValue,
    updater: (item: WorkTypeConfigItem) => WorkTypeConfigItem,
  ) => {
    setDraft((prev) => {
      const idx = prev.items.findIndex((i) => i.workTypeId === choice.id);
      if (idx >= 0) {
        const nextItems = [...prev.items];
        nextItems[idx] = updater(nextItems[idx]!);
        return { ...prev, items: nextItems };
      }
      const blank: WorkTypeConfigItem = {
        workTypeId: choice.id,
        practiceAreaId: choice.parentId ?? choice.id,
        active: true,
        autoTaskTemplates: [],
        riskQuestions: [],
      };
      return { ...prev, items: [...prev.items, updater(blank)] };
    });
  };

  const removeSelectedItemOverride = (workTypeId: string) => {
    setDraft((prev) => ({
      ...prev,
      items: prev.items.filter((i) => i.workTypeId !== workTypeId),
    }));
  };

  const resetTemplateInputs = () => {
    setNewTplId('');
    setNewTplTitle('');
    setNewTplOffset('5');
    setNewTplPriority('task_priority.normal');
    setNewTplRole('fee_earner');
  };

  const buildTemplateFromInputs = (): WorkTypeAutoTaskTemplateConfig | null => {
    const title = newTplTitle.trim();
    if (!title) {
      showToast('Please enter a task template title.');
      return null;
    }
    const id =
      newTplId.trim() ||
      `tpl_${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')}_${Date.now().toString(36)}`;
    const offset = Number.parseInt(newTplOffset, 10);
    if (!Number.isInteger(offset) || offset < 0 || offset > 365) {
      showToast('Due working days offset must be a whole integer between 0 and 365.');
      return null;
    }
    return {
      id,
      title,
      trigger: 'matter_open',
      dueWorkingDaysOffset: offset,
      priorityId: newTplPriority,
      ownerRoleKey: newTplRole,
    };
  };

  const buildQuestionFromInputs = (): WorkTypeRiskQuestionConfig | null => {
    const prompt = newQPrompt.trim();
    if (!prompt) {
      showToast('Please enter a risk question prompt.');
      return null;
    }
    const weight = Number.parseInt(newQWeight, 10);
    if (!Number.isInteger(weight) || weight < 1 || weight > 10) {
      showToast('Risk question weight must be a whole integer between 1 and 10.');
      return null;
    }
    const highScore = Number.parseInt(newQHighScore, 10);
    if (!Number.isInteger(highScore) || highScore < 0 || highScore > 100) {
      showToast('High-risk option score must be an integer between 0 and 100.');
      return null;
    }
    const id =
      newQId.trim() ||
      `rq_${prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32)}_${Date.now().toString(36)}`;

    const options: WorkTypeRiskQuestionOptionConfig[] = [
      {
        value: 'low',
        label: newQLowLabel.trim() || 'No',
        score: 0,
        riskLevel: 'low',
      },
      ...(newQMedLabel.trim()
        ? [
            {
              value: 'medium',
              label: newQMedLabel.trim(),
              score: Math.max(1, Math.floor(highScore / 2)),
              riskLevel: 'medium' as const,
            },
          ]
        : []),
      {
        value: 'high',
        label: newQHighLabel.trim() || 'Yes',
        score: highScore,
        riskLevel: 'high',
      },
    ];

    const secOption = SECTION_KEY_OPTIONS.find((s) => s.key === newQSectionKey);
    return {
      id,
      sectionKey: newQSectionKey,
      sectionTitle: secOption?.label ?? 'Work-type risk factors',
      prompt,
      weight,
      required: newQRequired,
      options,
    };
  };

  const resetQuestionInputs = () => {
    setNewQId('');
    setNewQPrompt('');
    setNewQSectionKey('work_type');
    setNewQWeight('2');
    setNewQRequired(true);
  };

  const handleSaveAll = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) {
      showToast('You do not have permission to edit work-type configuration.');
      return;
    }
    if (!hasMfaVerified) {
      showToast('Multi-factor authentication (MFA) verification is required for admin saves.');
      return;
    }
    if (!changeReason.trim()) {
      showToast('Please enter an audit reason before saving work-type configuration changes.');
      return;
    }
    startTransition(async () => {
      const res = await saveWorkTypesConfigAction(draft, changeReason.trim());
      if (!res.ok) {
        showToast(res.error ?? 'Failed to save work-type configuration.');
        return;
      }
      if (res.config) {
        setDraft(cloneConfig(res.config));
      }
      setChangeReason('');
      showToast('Work-type configuration saved and audited.');
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="subcard">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>
              Work Types — Tasks, Risk Scoring &amp; Retention Rules
            </h2>
            <p className="field-hint" style={{ margin: 0 }}>
              Configure schema-validated automatic matter-opening task templates, work-type risk
              assessment questions, and post-closure file retention periods (computing matter{' '}
              <code>destruction_date</code> upon closure; no automatic purge runs).
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className={`tab-btn ${subTab === 'items' ? 'tab-btn--active' : ''}`}
              onClick={() => setSubTab('items')}
            >
              Practice areas &amp; work types ({draft.items.length} configured)
            </button>
            <button
              type="button"
              className={`tab-btn ${subTab === 'defaults' ? 'tab-btn--active' : ''}`}
              onClick={() => setSubTab('defaults')}
            >
              Firm defaults ({draft.defaults.retention.retentionYears} yrs)
            </button>
          </div>
        </div>

        {!hasMfaVerified ? (
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid #f59e0b',
              background: '#fffbeb',
              fontSize: 13,
              color: '#92400e',
            }}
          >
            MFA verification is required before persisting changes to tenant work-type settings.
          </div>
        ) : null}
      </div>

      {subTab === 'defaults' ? (
        <div className="subcard" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
              Firm Default Retention Policy
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <div className="field-group">
                <label className="field-label" htmlFor="wt-def-ret-years">
                  Default retention period (years from closure)
                </label>
                <input
                  id="wt-def-ret-years"
                  type="number"
                  min={1}
                  max={100}
                  className="field-input"
                  value={draft.defaults.retention.retentionYears}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    setDraft((prev) => ({
                      ...prev,
                      defaults: {
                        ...prev.defaults,
                        retention: {
                          ...prev.defaults.retention,
                          retentionYears: Number.isFinite(n) ? n : 1,
                        },
                      },
                    }));
                  }}
                />
              </div>
              <div className="field-group" style={{ gridColumn: 'span 2' }}>
                <label className="field-label" htmlFor="wt-def-ret-note">
                  Statutory / policy note
                </label>
                <input
                  id="wt-def-ret-note"
                  type="text"
                  className="field-input"
                  value={draft.defaults.retention.statutoryNote ?? ''}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      defaults: {
                        ...prev.defaults,
                        retention: {
                          ...prev.defaults.retention,
                          statutoryNote: e.target.value,
                        },
                      },
                    }))
                  }
                />
              </div>
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 6 }}>
              <input
                type="checkbox"
                checked={Boolean(draft.defaults.retention.allowMatterOverride)}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    defaults: {
                      ...prev.defaults,
                      retention: {
                        ...prev.defaults.retention,
                        allowMatterOverride: e.target.checked,
                      },
                    },
                  }))
                }
              />
              Allow matter-level retention override notes
            </label>
          </div>

          <div
            style={{
              padding: 12,
              border: '1px solid var(--color-divider)',
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
              Firm Default Opening Gate Pre-conditions
            </h3>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Baseline opening checks inherited when a work type does not specify its own opening rules.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
              {(
                [
                  ['requireConflictCleared', 'Require conflict check cleared'],
                  ['requireCddComplete', 'Require CDD complete'],
                  ['allowCddOverride', 'Allow partner CDD override'],
                  ['requireEngagementSigned', 'Require engagement letter signed'],
                  ['requireFundsOnAccount', 'Require funds on account'],
                ] as Array<[keyof WorkTypeOpeningGateConfig, string]>
              ).map(([fieldKey, label]) => {
                const baseGate: WorkTypeOpeningGateConfig = {
                  requireConflictCleared: false,
                  requireCddComplete: false,
                  allowCddOverride: true,
                  requireEngagementSigned: false,
                  requireFundsOnAccount: false,
                  ...(draft.defaults.openingGate ?? {}),
                };
                return (
                  <label
                    key={fieldKey}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
                  >
                    <input
                      type="checkbox"
                      disabled={!canEdit}
                      checked={Boolean(baseGate[fieldKey])}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          defaults: {
                            ...prev.defaults,
                            openingGate: {
                              ...baseGate,
                              ...(prev.defaults.openingGate ?? {}),
                              [fieldKey]: e.target.checked,
                            },
                          },
                        }))
                      }
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--color-divider)' }} />

          <div>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
              Firm Default Auto-Task Templates ({draft.defaults.autoTaskTemplates.length})
            </h3>
            {draft.defaults.autoTaskTemplates.length > 0 ? (
              <table className="data-table" style={{ fontSize: 13, marginBottom: 12 }}>
                <thead>
                  <tr>
                    <th>Template ID</th>
                    <th>Title</th>
                    <th>Due offset (working days)</th>
                    <th>Priority</th>
                    <th>Assignee role</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.defaults.autoTaskTemplates.map((tpl) => (
                    <tr key={tpl.id}>
                      <td><code>{tpl.id}</code></td>
                      <td>{tpl.title}</td>
                      <td>+{tpl.dueWorkingDaysOffset} wd</td>
                      <td>{tpl.priorityId.replace('task_priority.', '')}</td>
                      <td>{tpl.ownerRoleKey}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() =>
                            setDraft((prev) => ({
                              ...prev,
                              defaults: {
                                ...prev.defaults,
                                autoTaskTemplates: prev.defaults.autoTaskTemplates.filter(
                                  (t) => t.id !== tpl.id,
                                ),
                              },
                            }))
                          }
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="field-hint">No default auto-task templates configured.</p>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <input
                type="text"
                className="field-input"
                style={{ width: 150 }}
                placeholder="Template ID (optional)"
                value={newTplId}
                onChange={(e) => setNewTplId(e.target.value)}
              />
              <input
                type="text"
                className="field-input"
                style={{ minWidth: 220, flex: 1 }}
                placeholder="Task title…"
                value={newTplTitle}
                onChange={(e) => setNewTplTitle(e.target.value)}
              />
              <input
                type="number"
                min={0}
                max={365}
                className="field-input"
                style={{ width: 90 }}
                title="Due working days offset"
                value={newTplOffset}
                onChange={(e) => setNewTplOffset(e.target.value)}
              />
              <select
                className="field-select"
                value={newTplPriority}
                onChange={(e) =>
                  setNewTplPriority(
                    e.target.value as WorkTypeAutoTaskTemplateConfig['priorityId'],
                  )
                }
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <select
                className="field-select"
                value={newTplRole}
                onChange={(e) => setNewTplRole(e.target.value as HomeRoleKey)}
              >
                {ROLE_KEY_OPTIONS.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => {
                  const built = buildTemplateFromInputs();
                  if (!built) return;
                  if (draft.defaults.autoTaskTemplates.some((t) => t.id === built.id)) {
                    showToast(`Template ID '${built.id}' already exists in defaults.`);
                    return;
                  }
                  setDraft((prev) => ({
                    ...prev,
                    defaults: {
                      ...prev.defaults,
                      autoTaskTemplates: [...prev.defaults.autoTaskTemplates, built],
                    },
                  }));
                  resetTemplateInputs();
                }}
              >
                + Add default template
              </button>
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--color-divider)' }} />

          <div>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
              Firm Default Risk Questions ({draft.defaults.riskQuestions.length})
            </h3>
            {draft.defaults.riskQuestions.length > 0 ? (
              <table className="data-table" style={{ fontSize: 13, marginBottom: 12 }}>
                <thead>
                  <tr>
                    <th>Question ID</th>
                    <th>Prompt</th>
                    <th>Section</th>
                    <th>Weight</th>
                    <th>Required</th>
                    <th>Options</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.defaults.riskQuestions.map((q) => (
                    <tr key={q.id}>
                      <td><code>{q.id}</code></td>
                      <td>{q.prompt}</td>
                      <td>{q.sectionKey}</td>
                      <td>×{q.weight}</td>
                      <td>{q.required ? 'Yes' : 'Optional'}</td>
                      <td>
                        {q.options.map((o) => `${o.label} (${o.score})`).join(' · ')}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() =>
                            setDraft((prev) => ({
                              ...prev,
                              defaults: {
                                ...prev.defaults,
                                riskQuestions: prev.defaults.riskQuestions.filter(
                                  (rq) => rq.id !== q.id,
                                ),
                              },
                            }))
                          }
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="field-hint">No default supplementary risk questions configured.</p>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <input
                type="text"
                className="field-input"
                style={{ width: 150 }}
                placeholder="Question ID (optional)"
                value={newQId}
                onChange={(e) => setNewQId(e.target.value)}
              />
              <input
                type="text"
                className="field-input"
                style={{ minWidth: 240, flex: 1 }}
                placeholder="Risk question prompt…"
                value={newQPrompt}
                onChange={(e) => setNewQPrompt(e.target.value)}
              />
              <select
                className="field-select"
                value={newQSectionKey}
                onChange={(e) =>
                  setNewQSectionKey(e.target.value as WorkTypeRiskQuestionConfig['sectionKey'])
                }
              >
                {SECTION_KEY_OPTIONS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                max={10}
                className="field-input"
                style={{ width: 75 }}
                title="Weight (1-10)"
                value={newQWeight}
                onChange={(e) => setNewQWeight(e.target.value)}
              />
              <input
                type="number"
                min={0}
                max={100}
                className="field-input"
                style={{ width: 85 }}
                title="High-risk score"
                value={newQHighScore}
                onChange={(e) => setNewQHighScore(e.target.value)}
              />
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={newQRequired}
                  onChange={(e) => setNewQRequired(e.target.checked)}
                />
                Required
              </label>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => {
                  const built = buildQuestionFromInputs();
                  if (!built) return;
                  if (draft.defaults.riskQuestions.some((rq) => rq.id === built.id)) {
                    showToast(`Question ID '${built.id}' already exists in defaults.`);
                    return;
                  }
                  setDraft((prev) => ({
                    ...prev,
                    defaults: {
                      ...prev.defaults,
                      riskQuestions: [...prev.defaults.riskQuestions, built],
                    },
                  }));
                  resetQuestionInputs();
                }}
              >
                + Add default question
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: selectedChoice ? '1.15fr 1fr' : '1fr', gap: 16, alignItems: 'start' }}>
          <div className="subcard">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
                Practice Areas &amp; Work Types
              </h3>
              <input
                type="search"
                className="field-input"
                style={{ maxWidth: 260 }}
                placeholder="Filter practice areas or work types…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filteredPracticeAreas.map((pa) => {
                const dept = resolveDepartmentForPracticeArea(pa.id, orgStructure, values, {
                  includeInactive: true,
                });
                const paActive = isWorkTypeChoiceActive(pa.id, values, orgStructure);
                const paOverride = draft.items.find((i) => i.workTypeId === pa.id);
                const paSubs = subcategories.filter((s) => s.parentId === pa.id);
                const paEffectiveRet = resolveWorkTypeRetention(draft, { practiceAreaId: pa.id });

                return (
                  <div
                    key={pa.id}
                    style={{
                      border: '1px solid var(--color-divider)',
                      borderRadius: 8,
                      padding: 10,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong>{pa.label}</strong>
                        <StatusPill
                          label={paActive ? 'Active' : 'Inactive / dept inactive'}
                          tone={paActive ? 'positive' : 'neutral'}
                        />
                        {dept ? (
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            Dept: {dept.name} ({dept.code})
                          </span>
                        ) : null}
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          · Retention: {paEffectiveRet.retentionYears} yrs
                        </span>
                        {paOverride ? <StatusPill label="Rule override" tone="warning" /> : null}
                      </div>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => setSelectedWorkTypeId(pa.id)}
                      >
                        {selectedWorkTypeId === pa.id
                          ? 'Editing'
                          : paOverride
                            ? 'Edit PA rule'
                            : 'Override PA'}
                      </button>
                    </div>

                    {paSubs.length > 0 ? (
                      <div
                        style={{
                          marginTop: 8,
                          paddingLeft: 14,
                          borderLeft: '2px solid var(--color-divider)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                        }}
                      >
                        {paSubs.map((sub) => {
                          const subOverride = draft.items.find((i) => i.workTypeId === sub.id);
                          const subActive = isWorkTypeChoiceActive(sub.id, values, orgStructure);
                          const subRet = resolveWorkTypeRetention(draft, {
                            workTypeSubcategoryId: sub.id,
                            practiceAreaId: pa.id,
                          });
                          const subTasks = resolveWorkTypeAutoTaskTemplates(draft, {
                            workTypeSubcategoryId: sub.id,
                            practiceAreaId: pa.id,
                          });
                          const subQs = resolveWorkTypeRiskQuestions(draft, {
                            workTypeSubcategoryId: sub.id,
                            practiceAreaId: pa.id,
                          });
                          return (
                            <div
                              key={sub.id}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 8,
                                fontSize: 13,
                                background:
                                  selectedWorkTypeId === sub.id ? 'var(--bg-subtle, #f1f5f9)' : undefined,
                                padding: '4px 6px',
                                borderRadius: 4,
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span>{sub.label}</span>
                                {!subActive ? <StatusPill label="Inactive" tone="neutral" /> : null}
                                {subOverride ? <StatusPill label="Custom" tone="warning" /> : null}
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                  {subTasks.templates.length} tasks · {subQs.length} extra risk Qs ·{' '}
                                  {subRet.retentionYears} yrs
                                </span>
                              </div>
                              <button
                                type="button"
                                className="btn btn--ghost btn--sm"
                                onClick={() => setSelectedWorkTypeId(sub.id)}
                              >
                                {selectedWorkTypeId === sub.id ? 'Editing' : 'Configure'}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {selectedChoice ? (
            <div className="subcard" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div>
                  <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
                    {selectedChoice.label}
                  </h3>
                  <div className="field-hint" style={{ margin: 0 }}>
                    <code>{selectedChoice.id}</code>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {selectedItem ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => removeSelectedItemOverride(selectedChoice.id)}
                    >
                      Remove override
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => ensureSelectedItem(selectedChoice)}
                    >
                      Create rule override
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setSelectedWorkTypeId(null)}
                  >
                    Close
                  </button>
                </div>
              </div>

              <div>
                <h4 style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                  Retention Override (years after closure)
                </h4>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8 }}>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    className="field-input"
                    value={
                      selectedItem?.retention?.retentionYears ??
                      draft.defaults.retention.retentionYears
                    }
                    onChange={(e) => {
                      const n = Number.parseInt(e.target.value, 10);
                      updateSelectedItem(selectedChoice, (item) => ({
                        ...item,
                        retention: {
                          retentionYears: Number.isFinite(n) ? n : draft.defaults.retention.retentionYears,
                          baseline: 'closed_on',
                          allowMatterOverride:
                            item.retention?.allowMatterOverride ??
                            draft.defaults.retention.allowMatterOverride,
                          statutoryNote:
                            item.retention?.statutoryNote ??
                            draft.defaults.retention.statutoryNote,
                        },
                      }));
                    }}
                  />
                  <input
                    type="text"
                    className="field-input"
                    placeholder="Statutory or regulatory retention note…"
                    value={
                      selectedItem?.retention?.statutoryNote ??
                      draft.defaults.retention.statutoryNote ??
                      ''
                    }
                    onChange={(e) =>
                      updateSelectedItem(selectedChoice, (item) => ({
                        ...item,
                        retention: {
                          retentionYears:
                            item.retention?.retentionYears ??
                            draft.defaults.retention.retentionYears,
                          baseline: 'closed_on',
                          allowMatterOverride:
                            item.retention?.allowMatterOverride ??
                            draft.defaults.retention.allowMatterOverride,
                          statutoryNote: e.target.value,
                        },
                      }))
                    }
                  />
                </div>
              </div>

              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 6,
                  }}
                >
                  <h4 style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>
                    Opening Gate Rules
                  </h4>
                  {selectedItem?.openingGate ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={!canEdit}
                      onClick={() =>
                        updateSelectedItem(selectedChoice, (item) => {
                          const next = { ...item };
                          delete next.openingGate;
                          return next;
                        })
                      }
                    >
                      Inherit defaults
                    </button>
                  ) : null}
                </div>
                <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                  {selectedItem?.openingGate
                    ? 'Custom opening gate rules override firm defaults for this work type.'
                    : 'Currently inheriting firm default opening gate rules.'}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                  {(
                    [
                      ['requireConflictCleared', 'Conflict check cleared'],
                      ['requireCddComplete', 'Client Due Diligence (CDD) complete'],
                      ['allowCddOverride', 'Allow partner CDD override'],
                      ['requireEngagementSigned', 'Signed engagement letter'],
                      ['requireFundsOnAccount', 'Funds on account'],
                    ] as Array<[keyof WorkTypeOpeningGateConfig, string]>
                  ).map(([fieldKey, label]) => {
                    const effectiveGate: WorkTypeOpeningGateConfig = {
                      requireConflictCleared: false,
                      requireCddComplete: false,
                      allowCddOverride: true,
                      requireEngagementSigned: false,
                      requireFundsOnAccount: false,
                      ...(draft.defaults.openingGate ?? {}),
                      ...(selectedItem?.openingGate ?? {}),
                    };
                    return (
                      <label
                        key={fieldKey}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
                      >
                        <input
                          type="checkbox"
                          disabled={!canEdit}
                          checked={Boolean(effectiveGate[fieldKey])}
                          onChange={(e) =>
                            updateSelectedItem(selectedChoice, (item) => ({
                              ...item,
                              openingGate: {
                                ...effectiveGate,
                                ...(item.openingGate ?? {}),
                                [fieldKey]: e.target.checked,
                              },
                            }))
                          }
                        />
                        {label}
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <h4 style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                  CFA &amp; DBA Statutory Cap Categories &amp; Work-Type Overrides
                </h4>
                <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                  Map CFA and DBA fee bases to statutory cap categories for this work type (required before saving CFA/DBA matters or quotes). Optional work-type cap overrides take precedence over firm defaults and may sit above or below the firm cap up to the statutory maximum.
                </p>
                {(() => {
                  const statutoryRows = listActiveStatutoryFeeCaps();
                  const cfaRows = statutoryRows.filter(
                    (r) => r.feeBasis === 'conditional_fee_agreement',
                  );
                  const dbaRows = statutoryRows.filter(
                    (r) => r.feeBasis === 'damages_based_agreement',
                  );
                  const mappedCfa =
                    selectedItem?.feeArrangementCapCategories
                      ?.conditional_fee_agreement ?? '';
                  const mappedDba =
                    selectedItem?.feeArrangementCapCategories
                      ?.damages_based_agreement ?? '';
                  const firmCaps = matterCostsConfig?.feeArrangementCaps ?? [];
                  const currentOverrides =
                    selectedItem?.workTypeCapOverrides ?? [];
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <label style={{ fontSize: 12 }}>
                          <span style={{ display: 'block', fontWeight: 600, marginBottom: 3 }}>
                            CFA statutory cap category
                          </span>
                          <select
                            className="field-select"
                            value={mappedCfa}
                            onChange={(e) => {
                              const nextCat = e.target.value;
                              updateSelectedItem(selectedChoice, (item) => {
                                const prevCats =
                                  item.feeArrangementCapCategories ?? {};
                                const nextCats = {
                                  ...(prevCats.damages_based_agreement
                                    ? {
                                        damages_based_agreement:
                                          prevCats.damages_based_agreement,
                                      }
                                    : {}),
                                  ...(nextCat
                                    ? { conditional_fee_agreement: nextCat }
                                    : {}),
                                };
                                return {
                                  ...item,
                                  feeArrangementCapCategories:
                                    Object.keys(nextCats).length > 0
                                      ? nextCats
                                      : undefined,
                                };
                              });
                            }}
                          >
                            <option value="">Unmapped (CFA blocked fail closed)</option>
                            {cfaRows.map((r) => (
                              <option key={r.capCategoryKey} value={r.capCategoryKey}>
                                {r.caseTypeLabel} ({r.maxPercent}% of {r.capBaseDescription})
                              </option>
                            ))}
                          </select>
                        </label>
                        <label style={{ fontSize: 12 }}>
                          <span style={{ display: 'block', fontWeight: 600, marginBottom: 3 }}>
                            DBA statutory cap category
                          </span>
                          <select
                            className="field-select"
                            value={mappedDba}
                            onChange={(e) => {
                              const nextCat = e.target.value;
                              updateSelectedItem(selectedChoice, (item) => {
                                const prevCats =
                                  item.feeArrangementCapCategories ?? {};
                                const nextCats = {
                                  ...(prevCats.conditional_fee_agreement
                                    ? {
                                        conditional_fee_agreement:
                                          prevCats.conditional_fee_agreement,
                                      }
                                    : {}),
                                  ...(nextCat
                                    ? { damages_based_agreement: nextCat }
                                    : {}),
                                };
                                return {
                                  ...item,
                                  feeArrangementCapCategories:
                                    Object.keys(nextCats).length > 0
                                      ? nextCats
                                      : undefined,
                                };
                              });
                            }}
                          >
                            <option value="">Unmapped (DBA blocked fail closed)</option>
                            {dbaRows.map((r) => (
                              <option key={r.capCategoryKey} value={r.capCategoryKey}>
                                {r.caseTypeLabel} ({r.maxPercent}% of {r.capBaseDescription})
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>
                          Work-type cap overrides (leave blank to inherit firm cap)
                        </span>
                        {statutoryRows.map((row) => {
                          const existingOverride = currentOverrides.find(
                            (ov) => ov.capCategoryKey === row.capCategoryKey,
                          );
                          const firmCap =
                            firmCaps.find(
                              (c) => c.capCategoryKey === row.capCategoryKey,
                            )?.maxPercent ?? row.maxPercent;
                          return (
                            <div
                              key={row.capCategoryKey}
                              style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr 120px auto',
                                gap: 8,
                                alignItems: 'center',
                                fontSize: 12,
                              }}
                            >
                              <span>
                                <strong>
                                  {row.feeBasis === 'conditional_fee_agreement'
                                    ? 'CFA'
                                    : 'DBA'}{' '}
                                  — {row.caseTypeLabel}
                                </strong>{' '}
                                <span className="muted">
                                  (Firm cap {firmCap}% · Statutory max {row.maxPercent}% of{' '}
                                  {row.capBaseDescription})
                                </span>
                              </span>
                              <input
                                type="number"
                                className="field-input"
                                min={0}
                                max={row.maxPercent}
                                step={0.5}
                                placeholder={`${firmCap}%`}
                                aria-label={`${row.caseTypeLabel} work-type cap override percentage`}
                                value={
                                  existingOverride
                                    ? String(existingOverride.maxPercent)
                                    : ''
                                }
                                onChange={(e) => {
                                  const raw = e.target.value.trim();
                                  updateSelectedItem(selectedChoice, (item) => {
                                    const filtered = (
                                      item.workTypeCapOverrides ?? []
                                    ).filter(
                                      (ov) =>
                                        ov.capCategoryKey !== row.capCategoryKey,
                                    );
                                    if (!raw) {
                                      return {
                                        ...item,
                                        workTypeCapOverrides:
                                          filtered.length > 0
                                            ? filtered
                                            : undefined,
                                      };
                                    }
                                    const parsed = Number(raw);
                                    if (!Number.isFinite(parsed)) {
                                      return item;
                                    }
                                    return {
                                      ...item,
                                      workTypeCapOverrides: [
                                        ...filtered,
                                        {
                                          capCategoryKey: row.capCategoryKey,
                                          maxPercent: parsed,
                                          capBaseKey: row.capBaseKey,
                                        },
                                      ],
                                    };
                                  });
                                }}
                              />
                              <span className="muted" style={{ fontSize: 11 }}>
                                % max {row.maxPercent}%
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>

              <div>
                <h4 style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                  Auto-Task Templates ({selectedItem?.autoTaskTemplates?.length ?? 0})
                </h4>
                {(selectedItem?.autoTaskTemplates ?? []).map((tpl) => (
                  <div
                    key={tpl.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 12,
                      padding: '4px 6px',
                      borderBottom: '1px solid var(--color-divider)',
                    }}
                  >
                    <span>
                      <strong>{tpl.title}</strong> (+{tpl.dueWorkingDaysOffset} wd ·{' '}
                      {tpl.ownerRoleKey})
                    </span>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() =>
                        updateSelectedItem(selectedChoice, (item) => ({
                          ...item,
                          autoTaskTemplates: (item.autoTaskTemplates ?? []).filter(
                            (t) => t.id !== tpl.id,
                          ),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  <input
                    type="text"
                    className="field-input"
                    style={{ flex: 1, minWidth: 160 }}
                    placeholder="New task title…"
                    value={newTplTitle}
                    onChange={(e) => setNewTplTitle(e.target.value)}
                  />
                  <input
                    type="number"
                    min={0}
                    max={365}
                    className="field-input"
                    style={{ width: 70 }}
                    value={newTplOffset}
                    onChange={(e) => setNewTplOffset(e.target.value)}
                  />
                  <select
                    className="field-select"
                    value={newTplRole}
                    onChange={(e) => setNewTplRole(e.target.value as HomeRoleKey)}
                  >
                    {ROLE_KEY_OPTIONS.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => {
                      const built = buildTemplateFromInputs();
                      if (!built) return;
                      updateSelectedItem(selectedChoice, (item) => ({
                        ...item,
                        autoTaskTemplates: [
                          ...(item.autoTaskTemplates ?? []).filter((t) => t.id !== built.id),
                          built,
                        ],
                      }));
                      resetTemplateInputs();
                    }}
                  >
                    + Add task
                  </button>
                </div>
              </div>

              <div>
                <h4 style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                  Work-Type Risk Questions ({selectedItem?.riskQuestions?.length ?? 0})
                </h4>
                {(selectedItem?.riskQuestions ?? []).map((rq) => (
                  <div
                    key={rq.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 12,
                      padding: '4px 6px',
                      borderBottom: '1px solid var(--color-divider)',
                    }}
                  >
                    <span>
                      <strong>{rq.prompt}</strong> (×{rq.weight}
                      {rq.required ? ' · Required' : ''})
                    </span>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() =>
                        updateSelectedItem(selectedChoice, (item) => ({
                          ...item,
                          riskQuestions: (item.riskQuestions ?? []).filter(
                            (q) => q.id !== rq.id,
                          ),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  <input
                    type="text"
                    className="field-input"
                    style={{ flex: 1, minWidth: 180 }}
                    placeholder="Question prompt…"
                    value={newQPrompt}
                    onChange={(e) => setNewQPrompt(e.target.value)}
                  />
                  <input
                    type="number"
                    min={1}
                    max={10}
                    className="field-input"
                    style={{ width: 65 }}
                    title="Weight"
                    value={newQWeight}
                    onChange={(e) => setNewQWeight(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => {
                      const built = buildQuestionFromInputs();
                      if (!built) return;
                      updateSelectedItem(selectedChoice, (item) => ({
                        ...item,
                        riskQuestions: [
                          ...(item.riskQuestions ?? []).filter((q) => q.id !== built.id),
                          built,
                        ],
                      }));
                      resetQuestionInputs();
                    }}
                  >
                    + Add risk question
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 6 }}>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="Low option label"
                    value={newQLowLabel}
                    onChange={(e) => setNewQLowLabel(e.target.value)}
                  />
                  <input
                    type="text"
                    className="field-input"
                    placeholder="Medium option label (optional)"
                    value={newQMedLabel}
                    onChange={(e) => setNewQMedLabel(e.target.value)}
                  />
                  <input
                    type="text"
                    className="field-input"
                    placeholder="High option label"
                    value={newQHighLabel}
                    onChange={(e) => setNewQHighLabel(e.target.value)}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}

      <form
        onSubmit={handleSaveAll}
        className="subcard"
        style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <input
          type="text"
          className="field-input"
          style={{ flex: 1, minWidth: 260 }}
          placeholder="Audit reason for work-type configuration changes…"
          value={changeReason}
          onChange={(e) => setChangeReason(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={pending || !canEdit || !hasMfaVerified}
        >
          {pending ? 'Saving…' : 'Save & Audit Work-Type Rules'}
        </button>
      </form>
    </div>
  );
}
