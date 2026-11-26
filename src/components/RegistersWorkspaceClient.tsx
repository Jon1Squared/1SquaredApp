'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import type {
  RegisterFieldDefinition,
  RegisterRecord,
  RegistersConfiguration,
  RegisterTransition,
  RegisterTransitionDefinition,
  RegisterTypeDefinition,
} from '@platform/core-api';
import {
  createRegisterRecordAction,
  transitionRegisterRecordAction,
  updateRegisterRecordAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { formatDate, formatDateTime } from '@/domain/dates';
import { personDisplayName } from '@/domain/names';
import type { Matter, PermissionKey, Person } from '@/domain/types';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface RegistersWorkspaceClientProps {
  currentUserId: string;
  userPermissions: PermissionKey[];
  registerTypes: RegisterTypeDefinition[];
  registersConfig: RegistersConfiguration;
  initialRecords: RegisterRecord[];
  initialTransitionsByRecordId: Record<string, RegisterTransition[]>;
  matters: Matter[];
  people: Person[];
  clientLabelsById?: Record<string, string>;
  initialRecordId?: string;
  initialTypeKey?: string;
  initialOpenCreateTypeKey?: string;
  workspaceRef?: React.Ref<{ openCreatePanel: (preferredTypeKey?: string) => void }>;
  lockedMatterId?: string;
  embedded?: boolean;
}

function buildDefaultFieldValuesForType(
  def: RegisterTypeDefinition | undefined,
  currentUserId: string,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const f of def?.fields ?? []) {
    if (f.defaultValue !== undefined) {
      defaults[f.key] = f.defaultValue;
    } else if (f.type === 'person' && f.required) {
      defaults[f.key] = currentUserId;
    }
  }
  return defaults;
}

function mapToneToPill(
  tone?: string,
): 'neutral' | 'warning' | 'positive' | 'alert' {
  switch (tone) {
    case 'success':
      return 'positive';
    case 'danger':
      return 'alert';
    case 'warning':
      return 'warning';
    case 'info':
    default:
      return 'neutral';
  }
}

function canExecuteTransitionUi(
  userPerms: Set<string>,
  regType: RegisterTypeDefinition,
  transition: RegisterTransitionDefinition,
  record: RegisterRecord,
  currentUserId: string,
  priorTransitions: readonly RegisterTransition[] = [],
): { allowed: boolean; reason?: string } {
  const hasPerm =
    userPerms.has(transition.requiredPermission) ||
    (regType.key === 'sign_off' &&
      transition.requiredPermission === 'register:approve' &&
      userPerms.has('signoff:approve'));
  if (!hasPerm) {
    return { allowed: false, reason: `Requires ${transition.requiredPermission}` };
  }
  const mustBlockSelf =
    transition.forbidSelfAction ||
    Boolean(regType.approvalRules && transition.requiredPermission !== regType.editPermission);
  if (
    mustBlockSelf &&
    (record.ownerId === currentUserId ||
      record.createdById === currentUserId ||
      (regType.key === 'high_risk_opening' &&
        typeof record.fieldValues?.submittedById === 'string' &&
        record.fieldValues.submittedById === currentUserId))
  ) {
    return { allowed: false, reason: 'Self-approval is forbidden' };
  }
  if (
    transition.mustDifferFromPreviousApprover &&
    priorTransitions.some((t) => t.actorId === currentUserId && t.transitionKey !== 'reject_opening')
  ) {
    return {
      allowed: false,
      reason: 'Requires a different approver from the previous stage',
    };
  }
  if (
    (transition.requireAssignedApproverMatch || regType.approvalRules?.requireAssignedApproverMatch) &&
    transition.forbidSelfAction &&
    record.assignedApproverId &&
    record.assignedApproverId !== currentUserId
  ) {
    return { allowed: false, reason: 'Assigned to another approver' };
  }
  return { allowed: true };
}

export function RegistersWorkspaceClient({
  currentUserId,
  userPermissions,
  registerTypes,
  initialRecords,
  initialTransitionsByRecordId,
  matters,
  people,
  clientLabelsById = {},
  initialRecordId,
  initialTypeKey,
  initialOpenCreateTypeKey,
  workspaceRef,
  lockedMatterId,
  embedded = false,
}: RegistersWorkspaceClientProps) {
  const { showToast } = useToast();
  const permSet = useMemo(() => new Set<string>(userPermissions), [userPermissions]);

  const enabledTypes = useMemo(
    () => registerTypes.filter((t) => t.enabled && t.showInNavigation !== false),
    [registerTypes],
  );
  const typeByKey = useMemo(
    () => new Map(registerTypes.map((t) => [t.key, t] as const)),
    [registerTypes],
  );
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p] as const)), [people]);
  const mattersById = useMemo(() => new Map(matters.map((m) => [m.id, m] as const)), [matters]);

  // Creation form state
  const creatableTypes = useMemo(
    () =>
      enabledTypes.filter(
        (t) =>
          t.key !== 'cdd' &&
          !t.systemCreatedOnly &&
          permSet.has(t.createPermission),
      ),
    [enabledTypes, permSet],
  );
  const resolvedInitialCreateTypeKey =
    initialOpenCreateTypeKey &&
    creatableTypes.some((t) => t.key === initialOpenCreateTypeKey)
      ? initialOpenCreateTypeKey
      : null;

  const [records, setRecords] = useState<RegisterRecord[]>(initialRecords);
  const [transitionsByRecordId, setTransitionsByRecordId] = useState<
    Record<string, RegisterTransition[]>
  >(initialTransitionsByRecordId);
  const [activeTypeFilter, setActiveTypeFilter] = useState<string>(
    resolvedInitialCreateTypeKey ??
      (initialTypeKey && typeByKey.has(initialTypeKey) ? initialTypeKey : 'all'),
  );
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(() => {
    if (initialRecordId && initialRecords.some((r) => r.id === initialRecordId)) {
      return initialRecordId;
    }
    return initialRecords[0]?.id ?? null;
  });

  const defaultCreateTypeKey =
    resolvedInitialCreateTypeKey ??
    (initialTypeKey && creatableTypes.some((t) => t.key === initialTypeKey)
      ? initialTypeKey
      : undefined) ??
    creatableTypes.find((t) => t.key === 'undertaking')?.key ??
    creatableTypes[0]?.key ??
    'undertaking';
  const [showCreateForm, setShowCreateForm] = useState<boolean>(
    Boolean(resolvedInitialCreateTypeKey),
  );
  const [createTypeKey, setCreateTypeKey] = useState<string>(defaultCreateTypeKey);
  const [createTitle, setCreateTitle] = useState<string>('');
  const [createMatterId, setCreateMatterId] = useState<string>(lockedMatterId ?? '');
  const [createApproverId, setCreateApproverId] = useState<string>('');
  const [createDueDate, setCreateDueDate] = useState<string>('');
  const [createReviewDate, setCreateReviewDate] = useState<string>('');
  const [createFieldValues, setCreateFieldValues] = useState<Record<string, unknown>>(() =>
    resolvedInitialCreateTypeKey
      ? buildDefaultFieldValuesForType(
          typeByKey.get(resolvedInitialCreateTypeKey),
          currentUserId,
        )
      : {},
  );
  const [submittingCreate, setSubmittingCreate] = useState<boolean>(false);

  // Transition state
  const [transitionModal, setTransitionModal] = useState<{
    record: RegisterRecord;
    transition: RegisterTransitionDefinition;
  } | null>(null);
  const [transitionComment, setTransitionComment] = useState<string>('');
  const [submittingTransition, setSubmittingTransition] = useState<boolean>(false);

  // Inline edit state
  const [editingRecord, setEditingRecord] = useState<RegisterRecord | null>(null);
  const [editTitle, setEditTitle] = useState<string>('');
  const [editApproverId, setEditApproverId] = useState<string>('');
  const [editDueDate, setEditDueDate] = useState<string>('');
  const [editReviewDate, setEditReviewDate] = useState<string>('');
  const [editFieldValues, setEditFieldValues] = useState<Record<string, unknown>>({});
  const [submittingEdit, setSubmittingEdit] = useState<boolean>(false);

  const selectedCreateType = typeByKey.get(createTypeKey) ?? creatableTypes[0] ?? null;

  const filteredRecords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return records.filter((rec) => {
      if (lockedMatterId && rec.matterId !== lockedMatterId) return false;
      if (activeTypeFilter !== 'all' && rec.registerTypeKey !== activeTypeFilter) return false;
      if (statusFilter !== 'all' && rec.status !== statusFilter) return false;
      if (q) {
        const matter = rec.matterId ? mattersById.get(rec.matterId) : null;
        const hay = `${rec.reference} ${rec.title} ${matter?.matterNumber ?? ''} ${matter?.title ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [records, lockedMatterId, activeTypeFilter, statusFilter, searchQuery, mattersById]);

  const selectedRecord = useMemo(
    () =>
      filteredRecords.find((r) => r.id === selectedRecordId) ??
      records.find((r) => r.id === selectedRecordId) ??
      filteredRecords[0] ??
      null,
    [filteredRecords, records, selectedRecordId],
  );

  const selectedRecordType = selectedRecord
    ? typeByKey.get(selectedRecord.registerTypeKey) ?? null
    : null;

  const openCreatePanel = (preferredTypeKey?: string) => {
    const nextKey =
      preferredTypeKey && creatableTypes.some((t) => t.key === preferredTypeKey)
        ? preferredTypeKey
        : creatableTypes.find((t) => t.key === activeTypeFilter)?.key ??
          creatableTypes.find((t) => t.key === 'undertaking')?.key ??
          creatableTypes[0]?.key ??
          'undertaking';
    const def = typeByKey.get(nextKey);
    const defaults = buildDefaultFieldValuesForType(def, currentUserId);
    setCreateTypeKey(nextKey);
    setCreateTitle('');
    setCreateMatterId(lockedMatterId ?? '');
    setCreateApproverId('');
    setCreateDueDate('');
    setCreateReviewDate('');
    setCreateFieldValues(defaults);
    setShowCreateForm(true);
  };

  React.useImperativeHandle(workspaceRef, () => ({
    openCreatePanel,
  }));

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCreateType || submittingCreate) return;
    setSubmittingCreate(true);
    try {
      const res = await createRegisterRecordAction({
        registerTypeKey: selectedCreateType.key,
        title: createTitle,
        matterId: createMatterId || null,
        assignedApproverId: createApproverId || null,
        dueAt: createDueDate ? `${createDueDate}T17:00:00.000Z` : null,
        reviewAt: createReviewDate ? `${createReviewDate}T09:00:00.000Z` : null,
        fieldValues: createFieldValues,
      });
      if (isActionDenied(res) || !res.ok) {
        showToast(res.message || res.error || 'Could not save register record.');
        return;
      }
      setRecords((prev) => [res.record, ...prev]);
      setSelectedRecordId(res.record.id);
      setShowCreateForm(false);
      showToast(`${res.record.reference} created (${res.record.status}).`);
    } finally {
      setSubmittingCreate(false);
    }
  }

  async function handleTransitionExecute(
    rec: RegisterRecord,
    trDef: RegisterTransitionDefinition,
    commentText: string,
  ) {
    if (submittingTransition) return;
    setSubmittingTransition(true);
    try {
      const res = await transitionRegisterRecordAction({
        recordId: rec.id,
        transitionKey: trDef.key,
        comment: commentText.trim() || null,
        expectedRowVersion: rec.rowVersion,
      });
      if (isActionDenied(res) || !res.ok) {
        showToast(res.message || res.error || 'Could not update status.');
        return;
      }
      setRecords((prev) => prev.map((r) => (r.id === res.record.id ? res.record : r)));
      setTransitionsByRecordId((prev) => ({
        ...prev,
        [res.record.id]: [res.transition, ...(prev[res.record.id] ?? [])],
      }));
      setTransitionModal(null);
      setTransitionComment('');
      showToast(`${res.record.reference} moved to ${res.record.status}.`);
    } finally {
      setSubmittingTransition(false);
    }
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingRecord || submittingEdit) return;
    setSubmittingEdit(true);
    try {
      const res = await updateRegisterRecordAction({
        recordId: editingRecord.id,
        expectedRowVersion: editingRecord.rowVersion,
        title: editTitle,
        assignedApproverId: editApproverId || null,
        dueAt: editDueDate ? `${editDueDate}T17:00:00.000Z` : null,
        reviewAt: editReviewDate ? `${editReviewDate}T09:00:00.000Z` : null,
        fieldValues: editFieldValues,
      });
      if (isActionDenied(res) || !res.ok) {
        showToast(res.message || res.error || 'Could not update record details.');
        return;
      }
      setRecords((prev) => prev.map((r) => (r.id === res.record.id ? res.record : r)));
      setEditingRecord(null);
      showToast(`${res.record.reference} details updated.`);
    } finally {
      setSubmittingEdit(false);
    }
  }

  function renderFieldInput(
    fieldDef: RegisterFieldDefinition,
    value: unknown,
    onChange: (nextVal: unknown) => void,
  ) {
    if (fieldDef.type === 'textarea') {
      return (
        <textarea
          className="form-input"
          rows={3}
          required={fieldDef.required}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    if (fieldDef.type === 'select') {
      return (
        <select
          className="form-input"
          required={fieldDef.required}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Select…</option>
          {(fieldDef.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    if (fieldDef.type === 'person') {
      const activeEmployees = people.filter((p) => p.isEmployee && !p.mergedIntoId);
      return (
        <select
          className="form-input"
          required={fieldDef.required}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Select person…</option>
          {activeEmployees.map((p) => (
            <option key={p.id} value={p.id}>
              {personDisplayName(p)}
            </option>
          ))}
        </select>
      );
    }
    if (fieldDef.type === 'boolean') {
      return (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>Yes</span>
        </label>
      );
    }
    if (fieldDef.type === 'number' || fieldDef.type === 'currency_gbp') {
      return (
        <input
          type="number"
          step={fieldDef.type === 'currency_gbp' ? '0.01' : 'any'}
          className="form-input"
          required={fieldDef.required}
          value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    if (fieldDef.type === 'date') {
      return (
        <input
          type="date"
          className="form-input"
          required={fieldDef.required}
          value={typeof value === 'string' ? value.slice(0, 10) : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    return (
      <input
        type="text"
        className="form-input"
        required={fieldDef.required}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!embedded ? (
        <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 className="page-title">Firm registers &amp; undertakings</h1>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              Track undertakings, partner sign-offs, complaints, regulatory breaches, and firm-configured registers.
            </p>
          </div>
          {creatableTypes.length > 0 ? (
            <div style={{ display: 'flex', gap: 8 }}>
              {permSet.has('undertaking:manage') ? (
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => openCreatePanel('undertaking')}
                >
                  + Record undertaking
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => openCreatePanel()}
              >
                + New register entry
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Link href="/registers" className="panel-link">
              Open full registers workspace →
            </Link>
          </div>
          {creatableTypes.length > 0 ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {permSet.has('undertaking:manage') &&
              creatableTypes.some((t) => t.key === 'undertaking') ? (
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => openCreatePanel('undertaking')}
                >
                  + New undertaking
                </button>
              ) : null}
              {creatableTypes.some((t) => t.key !== 'undertaking') ? (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() =>
                    openCreatePanel(creatableTypes.find((t) => t.key !== 'undertaking')?.key)
                  }
                >
                  + New register entry
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {/* Register type filter pills */}
      <div className="tab-bar" role="tablist" aria-label="Register types" style={{ flexWrap: 'wrap' }}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTypeFilter === 'all'}
          className={`tab-btn ${activeTypeFilter === 'all' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTypeFilter('all')}
        >
          All registers ({records.filter((r) => !lockedMatterId || r.matterId === lockedMatterId).length})
        </button>
        {enabledTypes.map((regType) => {
          const count = records.filter(
            (r) =>
              r.registerTypeKey === regType.key &&
              (!lockedMatterId || r.matterId === lockedMatterId),
          ).length;
          return (
            <button
              key={regType.key}
              type="button"
              role="tab"
              aria-selected={activeTypeFilter === regType.key}
              className={`tab-btn ${activeTypeFilter === regType.key ? 'tab-btn--active' : ''}`}
              onClick={() => {
                setActiveTypeFilter(regType.key);
                setStatusFilter('all');
              }}
            >
              {regType.pluralLabel} ({count})
            </button>
          );
        })}
      </div>

      {/* Create Form */}
      {showCreateForm && selectedCreateType ? (
        <section className="home-panel" aria-label="Create register entry">
          <div className="panel-header">
            <div className="panel-title-group">
              <h2 className="panel-title">New {selectedCreateType.label}</h2>
            </div>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setShowCreateForm(false)}
            >
              Cancel
            </button>
          </div>
          <form className="panel-body padded" onSubmit={handleCreateSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {selectedCreateType.approvalRules === null ? (
              <div
                style={{
                  padding: '8px 12px',
                  borderRadius: 6,
                  background: 'var(--bg-subtle, #f8fafc)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 13,
                }}
              >
                Direct creation: entries in <strong>{selectedCreateType.pluralLabel}</strong> open immediately in{' '}
                <strong>{selectedCreateType.initialStatus}</strong> status without two-person partner sign-off.
              </div>
            ) : null}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="kv-label">Register type</span>
                <select
                  className="form-input"
                  value={selectedCreateType.key}
                  onChange={(e) => openCreatePanel(e.target.value)}
                >
                  {creatableTypes.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="kv-label">Title *</span>
                <input
                  type="text"
                  required
                  className="form-input"
                  placeholder={`Short summary of ${selectedCreateType.label.toLowerCase()}`}
                  value={createTitle}
                  onChange={(e) => setCreateTitle(e.target.value)}
                />
              </label>

              {!lockedMatterId ? (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="kv-label">
                    Linked matter {selectedCreateType.requireMatterLink ? '*' : '(optional)'}
                  </span>
                  <select
                    className="form-input"
                    required={Boolean(selectedCreateType.requireMatterLink)}
                    value={createMatterId}
                    onChange={(e) => setCreateMatterId(e.target.value)}
                  >
                    <option value="">Firm-wide / no matter link</option>
                    {matters.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.matterNumber} — {m.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="kv-label">
                  {selectedCreateType.approvalRules !== null
                    ? 'Designated approver (optional)'
                    : 'Assigned reviewer (optional)'}
                </span>
                <select
                  className="form-input"
                  value={createApproverId}
                  onChange={(e) => setCreateApproverId(e.target.value)}
                >
                  <option value="">
                    {selectedCreateType.approvalRules !== null
                      ? 'Any authorised reviewer'
                      : 'No specific reviewer assigned'}
                  </option>
                  {people
                    .filter((p) => p.isEmployee && !p.mergedIntoId && p.id !== currentUserId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {personDisplayName(p)}
                      </option>
                    ))}
                </select>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="kv-label">Due / compliance deadline</span>
                <input
                  type="date"
                  className="form-input"
                  value={createDueDate}
                  onChange={(e) => setCreateDueDate(e.target.value)}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="kv-label">Periodic review date</span>
                <input
                  type="date"
                  className="form-input"
                  value={createReviewDate}
                  onChange={(e) => setCreateReviewDate(e.target.value)}
                />
              </label>
            </div>

            {selectedCreateType.fields.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                {selectedCreateType.fields.map((f) => (
                  <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="kv-label">
                      {f.label} {f.required ? '*' : ''}
                    </span>
                    {renderFieldInput(f, createFieldValues[f.key], (val) =>
                      setCreateFieldValues((prev) => ({ ...prev, [f.key]: val })),
                    )}
                    {f.description ? (
                      <span className="muted" style={{ fontSize: 12 }}>
                        {f.description}
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            ) : null}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={submittingCreate}
              >
                {submittingCreate ? 'Saving…' : `Create ${selectedCreateType.label}`}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {/* Search & status filters */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="search"
          className="form-input"
          placeholder="Search reference, title, or matter…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{ maxWidth: 280 }}
        />
        <select
          className="form-input"
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ maxWidth: 210 }}
        >
          <option value="all">All statuses</option>
          {Array.from(
            new Set(
              (activeTypeFilter === 'all'
                ? enabledTypes.flatMap((t) => t.states)
                : typeByKey.get(activeTypeFilter)?.states ?? []
              ).map((s) => s.key),
            ),
          ).map((st) => (
            <option key={st} value={st}>
              {st}
            </option>
          ))}
        </select>
      </div>

      {/* Main split layout: Record list + Detail panel */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(280px, 1fr) minmax(340px, 1.35fr)',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <section className="home-panel" aria-label="Register records list">
          <div className="panel-header">
            <div className="panel-title-group">
              <h2 className="panel-title">Entries ({filteredRecords.length})</h2>
            </div>
          </div>
          <div className="panel-body">
            {filteredRecords.length === 0 ? (
              <div className="panel-body padded muted">
                No register entries match the current filters.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {filteredRecords.map((rec) => {
                  const def = typeByKey.get(rec.registerTypeKey);
                  const stateDef = def?.states.find((s) => s.key === rec.status);
                  const matter = rec.matterId ? mattersById.get(rec.matterId) : null;
                  const isSelected = selectedRecord?.id === rec.id;
                  return (
                    <button
                      key={rec.id}
                      type="button"
                      onClick={() => {
                        setSelectedRecordId(rec.id);
                        setEditingRecord(null);
                      }}
                      style={{
                        textAlign: 'left',
                        padding: '12px 14px',
                        border: 'none',
                        borderBottom: '1px solid var(--border-subtle)',
                        background: isSelected ? 'var(--bg-subtle, #f1f5f9)' : 'transparent',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>
                          {rec.reference} · {def?.label ?? rec.registerTypeKey}
                        </span>
                        <StatusPill
                          label={stateDef?.label ?? rec.status}
                          tone={mapToneToPill(stateDef?.tone)}
                        />
                      </div>
                      <div style={{ fontWeight: 500, fontSize: 14 }}>{rec.title}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {matter ? `${matter.matterNumber} · ` : 'Firm-wide · '}
                        {rec.dueAt ? `Due ${formatDate(rec.dueAt.slice(0, 10))}` : 'No due date'}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* Detail card */}
        <section className="home-panel" aria-label="Register record detail">
          {!selectedRecord ? (
            <div className="panel-body padded muted">
              Select a register record to inspect details, transitions, and audit history.
            </div>
          ) : (
            <>
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">
                    {selectedRecord.reference} — {selectedRecord.title}
                  </h2>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <StatusPill
                    label={
                      selectedRecordType?.states.find((s) => s.key === selectedRecord.status)?.label ??
                      selectedRecord.status
                    }
                    tone={mapToneToPill(
                      selectedRecordType?.states.find((s) => s.key === selectedRecord.status)?.tone,
                    )}
                  />
                  {selectedRecordType &&
                  selectedRecord.registerTypeKey !== 'cdd' &&
                  !selectedRecordType.systemCreatedOnly &&
                  permSet.has(selectedRecordType.editPermission) ? (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => {
                        setEditingRecord(selectedRecord);
                        setEditTitle(selectedRecord.title);
                        setEditApproverId(selectedRecord.assignedApproverId ?? '');
                        setEditDueDate(selectedRecord.dueAt ? selectedRecord.dueAt.slice(0, 10) : '');
                        setEditReviewDate(
                          selectedRecord.reviewAt ? selectedRecord.reviewAt.slice(0, 10) : '',
                        );
                        setEditFieldValues({ ...selectedRecord.fieldValues });
                      }}
                    >
                      Edit details
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="panel-body padded" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {editingRecord?.id === selectedRecord.id && selectedRecordType ? (
                  <form onSubmit={handleSaveEdit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span className="kv-label">Title *</span>
                      <input
                        type="text"
                        required
                        className="form-input"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span className="kv-label">
                        {selectedRecordType.approvalRules !== null
                          ? 'Designated approver (optional)'
                          : 'Assigned reviewer (optional)'}
                      </span>
                      <select
                        className="form-input"
                        value={editApproverId}
                        onChange={(e) => setEditApproverId(e.target.value)}
                      >
                        <option value="">
                          {selectedRecordType.approvalRules !== null
                            ? 'Any authorised reviewer'
                            : 'No specific reviewer assigned'}
                        </option>
                        {people
                          .filter(
                            (p) => p.isEmployee && !p.mergedIntoId && p.id !== selectedRecord.ownerId,
                          )
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {personDisplayName(p)}
                            </option>
                          ))}
                      </select>
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span className="kv-label">Due date</span>
                        <input
                          type="date"
                          className="form-input"
                          value={editDueDate}
                          onChange={(e) => setEditDueDate(e.target.value)}
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span className="kv-label">Review date</span>
                        <input
                          type="date"
                          className="form-input"
                          value={editReviewDate}
                          onChange={(e) => setEditReviewDate(e.target.value)}
                        />
                      </label>
                    </div>
                    {selectedRecordType.fields.map((f) => (
                      <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span className="kv-label">
                          {f.label} {f.required ? '*' : ''}
                        </span>
                        {renderFieldInput(f, editFieldValues[f.key], (val) =>
                          setEditFieldValues((prev) => ({ ...prev, [f.key]: val })),
                        )}
                      </label>
                    ))}
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => setEditingRecord(null)}
                      >
                        Cancel
                      </button>
                      <button type="submit" className="btn btn--primary btn--sm" disabled={submittingEdit}>
                        {submittingEdit ? 'Saving…' : 'Save changes'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="kv-grid">
                      <div className="kv-item">
                        <span className="kv-label">Register type</span>
                        <span className="kv-value">
                          {selectedRecordType?.label ?? selectedRecord.registerTypeKey}
                        </span>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label">Owner</span>
                        <span className="kv-value">
                          {selectedRecord.ownerId && peopleById.get(selectedRecord.ownerId)
                            ? personDisplayName(peopleById.get(selectedRecord.ownerId)!)
                            : selectedRecord.ownerId ?? '—'}
                        </span>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label">Linked matter</span>
                        <span className="kv-value">
                          {selectedRecord.matterId && mattersById.get(selectedRecord.matterId) ? (
                            <Link href={`/matters/${selectedRecord.matterId}`}>
                              {mattersById.get(selectedRecord.matterId)!.matterNumber} —{' '}
                              {mattersById.get(selectedRecord.matterId)!.title}
                            </Link>
                          ) : (
                            'None'
                          )}
                        </span>
                      </div>
                      {(selectedRecord.organisationId || selectedRecord.personId) ? (
                        <div className="kv-item">
                          <span className="kv-label">Client subject</span>
                          <span className="kv-value">
                            {selectedRecord.organisationId ? (
                              <Link href={`/organisations/${selectedRecord.organisationId}?tab=compliance`}>
                                {clientLabelsById[selectedRecord.organisationId] ??
                                  selectedRecord.organisationId}
                              </Link>
                            ) : selectedRecord.personId ? (
                              <Link href={`/people/${selectedRecord.personId}?tab=compliance`}>
                                {clientLabelsById[selectedRecord.personId] ??
                                  (peopleById.get(selectedRecord.personId)
                                    ? personDisplayName(peopleById.get(selectedRecord.personId)!)
                                    : selectedRecord.personId)}
                              </Link>
                            ) : null}
                          </span>
                        </div>
                      ) : null}
                      <div className="kv-item">
                        <span className="kv-label">Due / Review dates</span>
                        <span className="kv-value">
                          Due: {selectedRecord.dueAt ? formatDate(selectedRecord.dueAt.slice(0, 10)) : '—'} · Review:{' '}
                          {selectedRecord.reviewAt ? formatDate(selectedRecord.reviewAt.slice(0, 10)) : '—'}
                        </span>
                      </div>
                      {selectedRecord.assignedApproverId ? (
                        <div className="kv-item">
                          <span className="kv-label">Assigned approver</span>
                          <span className="kv-value">
                            {peopleById.get(selectedRecord.assignedApproverId)
                              ? personDisplayName(peopleById.get(selectedRecord.assignedApproverId)!)
                              : selectedRecord.assignedApproverId}
                          </span>
                        </div>
                      ) : null}
                      {selectedRecord.decidedById ? (
                        <div className="kv-item">
                          <span className="kv-label">Completed / decided by</span>
                          <span className="kv-value">
                            {peopleById.get(selectedRecord.decidedById)
                              ? personDisplayName(peopleById.get(selectedRecord.decidedById)!)
                              : selectedRecord.decidedById}{' '}
                            {selectedRecord.decidedAt ? `· ${formatDateTime(selectedRecord.decidedAt)}` : ''}
                          </span>
                        </div>
                      ) : null}
                    </div>

                    {/* Structured field values */}
                    {selectedRecordType && selectedRecordType.fields.length > 0 ? (
                      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
                        <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>Register fields</h3>
                        <div className="kv-grid">
                          {selectedRecordType.fields.map((f) => {
                            const rawVal = selectedRecord.fieldValues[f.key];
                            let displayVal = '—';
                            if (rawVal !== undefined && rawVal !== null && rawVal !== '') {
                              if (f.type === 'person' && typeof rawVal === 'string' && peopleById.has(rawVal)) {
                                displayVal = personDisplayName(peopleById.get(rawVal)!);
                              } else if (f.type === 'currency_gbp' && typeof rawVal === 'number') {
                                displayVal = rawVal.toLocaleString('en-GB', {
                                  style: 'currency',
                                  currency: 'GBP',
                                });
                              } else if (f.type === 'boolean') {
                                displayVal = rawVal ? 'Yes' : 'No';
                              } else if (Array.isArray(rawVal)) {
                                if (f.key === 'checklistItems' || f.type === 'checklist') {
                                  const entries = rawVal as Array<{
                                    label?: string;
                                    status?: string;
                                  }>;
                                  displayVal =
                                    entries.length === 0
                                      ? 'None'
                                      : entries
                                          .map((e) => `${e.label || 'Item'}: ${e.status || 'pending'}`)
                                          .join('\n');
                                } else {
                                  displayVal = `${rawVal.length} attached item${rawVal.length === 1 ? '' : 's'}`;
                                }
                              } else {
                                displayVal = String(rawVal);
                              }
                            }
                            return (
                              <div key={f.key} className="kv-item">
                                <span className="kv-label">{f.label}</span>
                                <span className="kv-value" style={{ whiteSpace: 'pre-wrap' }}>
                                  {displayVal}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}

                    {/* Workflow transitions */}
                    {selectedRecordType ? (
                      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
                        <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>Workflow transitions</h3>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {selectedRecordType.transitions
                            .filter(
                              (t) =>
                                !t.systemOnly && t.fromStatuses.includes(selectedRecord.status),
                            )
                            .map((tr) => {
                              const guard = canExecuteTransitionUi(
                                permSet,
                                selectedRecordType,
                                tr,
                                selectedRecord,
                                currentUserId,
                                transitionsByRecordId[selectedRecord.id] ?? [],
                              );
                              return (
                                <button
                                  key={tr.key}
                                  type="button"
                                  className="btn btn--secondary btn--sm"
                                  disabled={!guard.allowed || submittingTransition}
                                  title={guard.reason}
                                  onClick={() => {
                                    if (tr.requiresComment) {
                                      setTransitionModal({ record: selectedRecord, transition: tr });
                                      setTransitionComment('');
                                    } else {
                                      void handleTransitionExecute(selectedRecord, tr, '');
                                    }
                                  }}
                                >
                                  {tr.label}
                                </button>
                              );
                            })}
                        </div>

                        {transitionModal?.record.id === selectedRecord.id ? (
                          <div
                            style={{
                              marginTop: 12,
                              padding: 12,
                              borderRadius: 6,
                              border: '1px solid var(--border-subtle)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 8,
                            }}
                          >
                            <span className="kv-label">
                              Note / rationale for &ldquo;{transitionModal.transition.label}&rdquo; *
                            </span>
                            <textarea
                              className="form-input"
                              rows={2}
                              value={transitionComment}
                              onChange={(e) => setTransitionComment(e.target.value)}
                              placeholder="Enter recorded rationale…"
                            />
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                onClick={() => setTransitionModal(null)}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className="btn btn--primary btn--sm"
                                disabled={!transitionComment.trim() || submittingTransition}
                                onClick={() =>
                                  void handleTransitionExecute(
                                    transitionModal.record,
                                    transitionModal.transition,
                                    transitionComment,
                                  )
                                }
                              >
                                Confirm {transitionModal.transition.label}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {/* Transition History */}
                    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
                      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>Transition history</h3>
                      {(transitionsByRecordId[selectedRecord.id] ?? []).length === 0 ? (
                        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                          No recorded transitions yet (row version {selectedRecord.rowVersion}).
                        </p>
                      ) : (
                        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                          {(transitionsByRecordId[selectedRecord.id] ?? []).map((tr) => {
                            const trActor = peopleById.get(tr.actorId);
                            return (
                              <li key={tr.id}>
                                <strong>{tr.transitionKey}</strong> ({tr.fromStatus || 'new'} → {tr.toStatus}) by{' '}
                                {trActor ? personDisplayName(trActor) : tr.actorId} ·{' '}
                                <span className="muted">{formatDateTime(tr.transitionedAt)}</span>
                                {tr.comment ? <span> — &ldquo;{tr.comment}&rdquo;</span> : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
