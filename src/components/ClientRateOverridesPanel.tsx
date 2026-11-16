'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Edit3, Plus, Trash2 } from 'lucide-react';
import type {
  ClientRateOverrideRecord,
  ParentChainNodeSummary,
} from '@platform/core-api';
import {
  deleteClientRateOverrideAction,
  listClientRateOverridesAction,
  saveClientRateOverrideAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { formatDate } from '@/domain/dates';
import { resolveLabel, valuesForList } from '@/domain/lists';
import type { ChoiceValue } from '@/domain/types';
import type { InheritedParentRateOverrideView } from '@/server/services';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  clientType: 'organisation' | 'person';
  clientId: string;
  clientLabel: string;
  values: ChoiceValue[];
  customGrades?: Array<{ id: string; label: string }>;
  canManage: boolean;
  initialOverrides: ClientRateOverrideRecord[];
  initialParentChain?: ParentChainNodeSummary[];
  initialInheritedOverrides?: InheritedParentRateOverrideView[];
}

const STANDARD_GRADES: Array<{ id: string; label: string }> = [
  { id: 'partner', label: 'Partner' },
  { id: 'associate', label: 'Associate' },
  { id: 'trainee', label: 'Trainee / Paralegal' },
];

function formatRateGbp(rateGbp: number): string {
  return `£${rateGbp.toLocaleString('en-GB', {
    minimumFractionDigits: rateGbp % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}/hr`;
}

function gradeDisplayLabel(
  gradeKey: string,
  allGrades: Array<{ id: string; label: string }>,
): string {
  return allGrades.find((g) => g.id === gradeKey)?.label ?? gradeKey;
}

export function ClientRateOverridesPanel({
  clientType,
  clientId,
  clientLabel,
  values,
  customGrades = [],
  canManage,
  initialOverrides,
  initialParentChain = [],
  initialInheritedOverrides = [],
}: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();

  const [overrides, setOverrides] =
    useState<ClientRateOverrideRecord[]>(initialOverrides);
  const [parentChain, setParentChain] =
    useState<ParentChainNodeSummary[]>(initialParentChain);
  const [inheritedOverrides, setInheritedOverrides] =
    useState<InheritedParentRateOverrideView[]>(initialInheritedOverrides);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [gradeKey, setGradeKey] = useState<string>('partner');
  const [practiceAreaId, setPracticeAreaId] = useState<string>('');
  const [rateGbpStr, setRateGbpStr] = useState<string>('');
  const [effectiveFrom, setEffectiveFrom] = useState<string>(
    () => new Date().toISOString().slice(0, 10),
  );
  const [effectiveTo, setEffectiveTo] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);

  const practiceAreas = useMemo(
    () => valuesForList(values, 'work_type').filter((v) => !v.parentId),
    [values],
  );

  const gradeOptions = useMemo(() => {
    const merged = [...STANDARD_GRADES];
    for (const cg of customGrades) {
      if (!merged.some((g) => g.id === cg.id)) {
        merged.push({ id: cg.id, label: cg.label });
      }
    }
    for (const o of overrides) {
      if (o.gradeKey && !merged.some((g) => g.id === o.gradeKey)) {
        merged.push({ id: o.gradeKey, label: o.gradeKey });
      }
    }
    return merged;
  }, [customGrades, overrides]);

  const reloadOverrides = async () => {
    const refreshed = await listClientRateOverridesAction({
      clientType,
      clientId,
    });
    if (!isActionDenied(refreshed) && !refreshed.error) {
      setOverrides(refreshed.overrides);
      setParentChain(refreshed.parentChain);
      setInheritedOverrides(refreshed.inheritedOverrides);
    }
  };

  const openCreateForm = () => {
    setEditingId(null);
    setGradeKey('partner');
    setPracticeAreaId('');
    setRateGbpStr('');
    setEffectiveFrom(new Date().toISOString().slice(0, 10));
    setEffectiveTo('');
    setNotes('');
    setFormError(null);
    setEditorOpen(true);
  };

  const openEditForm = (row: ClientRateOverrideRecord) => {
    setEditingId(row.id);
    setGradeKey(row.gradeKey);
    setPracticeAreaId(row.practiceAreaId ?? '');
    setRateGbpStr(String(row.rateGbp));
    setEffectiveFrom(row.effectiveFrom);
    setEffectiveTo(row.effectiveTo ?? '');
    setNotes(row.notes ?? '');
    setFormError(null);
    setEditorOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsedRate = Number(rateGbpStr);
    if (!Number.isFinite(parsedRate) || parsedRate < 0) {
      setFormError('Please enter a valid non-negative hourly rate (£ ex VAT).');
      return;
    }
    if (!effectiveFrom.trim()) {
      setFormError('Effective from date is required.');
      return;
    }
    if (effectiveTo.trim() && effectiveTo.trim() < effectiveFrom.trim()) {
      setFormError('Effective to date cannot precede the effective from date.');
      return;
    }

    startTransition(async () => {
      const res = await saveClientRateOverrideAction({
        ...(editingId ? { id: editingId } : {}),
        clientType,
        clientId,
        practiceAreaId: practiceAreaId.trim() || null,
        gradeKey,
        rateGbp: parsedRate,
        effectiveFrom: effectiveFrom.trim(),
        effectiveTo: effectiveTo.trim() || null,
        notes: notes.trim(),
      });
      if (isActionDenied(res)) {
        setFormError(res.message);
        return;
      }
      if (res.error || !res.override) {
        setFormError(res.message ?? res.error ?? 'Could not save negotiated rate override.');
        return;
      }
      await reloadOverrides();
      setEditorOpen(false);
      setEditingId(null);
      showToast(
        editingId
          ? `Negotiated rate updated for ${clientLabel}`
          : `Negotiated rate added for ${clientLabel}`,
      );
      router.refresh();
    });
  };

  const handleDelete = (row: ClientRateOverrideRecord) => {
    startTransition(async () => {
      const res = await deleteClientRateOverrideAction(row.id);
      if (isActionDenied(res)) {
        showToast(res.message);
        return;
      }
      if (!res.deleted) {
        showToast(res.message ?? res.error ?? 'Could not remove negotiated rate override.');
        return;
      }
      await reloadOverrides();
      showToast('Negotiated rate override removed');
      router.refresh();
    });
  };

  const hasInherited = inheritedOverrides.some((g) => g.overrides.length > 0);

  return (
    <section
      className="home-panel"
      style={{ marginTop: 18 }}
      aria-label="Negotiated hourly rates"
    >
      <div className="panel-header">
        <div className="panel-title-group">
          <h2 className="panel-title">Negotiated hourly rates</h2>
          <StatusPill label={`${overrides.length} direct`} tone="neutral" />
          {parentChain.length > 0 ? (
            <StatusPill
              label={`Group chain: ${parentChain.length}`}
              tone="positive"
            />
          ) : null}
        </div>
        {canManage ? (
          <div className="panel-actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={openCreateForm}
              disabled={isPending}
            >
              <Plus size={14} aria-hidden="true" />
              <span>Add negotiated rate</span>
            </button>
          </div>
        ) : null}
      </div>

      <div className="panel-body padded" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Effective-dated hourly rates agreed for {clientLabel}. When quoting or opening matters,
          direct client overrides (Tier 2) take precedence over client group rates inherited from
          an active parent organisation (Tier 3) and standard rate cards (Tier 4), whilst
          matter-specific overrides (Tier 1) supersede all lower tiers when enabled.
        </p>

        {editorOpen && canManage ? (
          <form
            onSubmit={handleSubmit}
            style={{
              padding: 14,
              borderRadius: 10,
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-subtle, rgba(15, 23, 42, 0.02))',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              {editingId ? 'Edit negotiated rate override' : 'New negotiated rate override'}
            </div>

            {formError ? (
              <div
                role="alert"
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: '#fef2f2',
                  border: '1px solid #fecaca',
                  color: '#991b1b',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {formError}
              </div>
            ) : null}

            <div className="form-grid-3" style={{ gap: 12 }}>
              <div className="field-group">
                <label className="field-label" htmlFor="cro-grade">
                  Fee earner grade <span className="field-required">*</span>
                </label>
                <select
                  id="cro-grade"
                  className="field-select"
                  value={gradeKey}
                  onChange={(e) => setGradeKey(e.target.value)}
                >
                  {gradeOptions.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="cro-pa">
                  Practice area scope
                </label>
                <select
                  id="cro-pa"
                  className="field-select"
                  value={practiceAreaId}
                  onChange={(e) => setPracticeAreaId(e.target.value)}
                >
                  <option value="">All practice areas (client default)</option>
                  {practiceAreas.map((pa) => (
                    <option key={pa.id} value={pa.id}>
                      {pa.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="cro-rate">
                  Hourly rate (£ ex VAT) <span className="field-required">*</span>
                </label>
                <input
                  id="cro-rate"
                  type="number"
                  min="0"
                  step="0.01"
                  className="field-input"
                  placeholder="e.g. 325"
                  value={rateGbpStr}
                  onChange={(e) => setRateGbpStr(e.target.value)}
                  required
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="cro-from">
                  Effective from <span className="field-required">*</span>
                </label>
                <input
                  id="cro-from"
                  type="date"
                  className="field-input"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  required
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="cro-to">
                  Effective to (optional)
                </label>
                <input
                  id="cro-to"
                  type="date"
                  className="field-input"
                  value={effectiveTo}
                  onChange={(e) => setEffectiveTo(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="cro-notes">
                  Notes / authority
                </label>
                <input
                  id="cro-notes"
                  type="text"
                  className="field-input"
                  placeholder="e.g. 2026 Framework agreement"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => {
                  setEditorOpen(false);
                  setFormError(null);
                }}
                disabled={isPending}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={isPending}
              >
                {isPending ? 'Saving…' : editingId ? 'Save changes' : 'Save negotiated rate'}
              </button>
            </div>
          </form>
        ) : null}

        {overrides.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            No direct negotiated rate overrides recorded for {clientLabel}.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-list__table" style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr className="data-list__head-row">
                  <th className="data-list__th">Grade</th>
                  <th className="data-list__th">Practice area scope</th>
                  <th className="data-list__th data-list__th--right">Rate (ex VAT)</th>
                  <th className="data-list__th">Effective from</th>
                  <th className="data-list__th">Effective to</th>
                  <th className="data-list__th">Notes</th>
                  {canManage ? <th className="data-list__th data-list__th--right">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {overrides.map((row) => (
                  <tr key={row.id} className="data-list__row">
                    <td className="data-list__td" style={{ fontWeight: 600 }}>
                      {gradeDisplayLabel(row.gradeKey, gradeOptions)}
                    </td>
                    <td className="data-list__td">
                      {row.practiceAreaId
                        ? resolveLabel(values, row.practiceAreaId) || row.practiceAreaId
                        : 'All practice areas (client default)'}
                    </td>
                    <td className="data-list__td data-list__td--right" style={{ fontWeight: 700 }}>
                      {formatRateGbp(row.rateGbp)}
                    </td>
                    <td className="data-list__td">{formatDate(row.effectiveFrom)}</td>
                    <td className="data-list__td">
                      {row.effectiveTo ? formatDate(row.effectiveTo) : 'Open-ended'}
                    </td>
                    <td className="data-list__td muted">{row.notes || '—'}</td>
                    {canManage ? (
                      <td className="data-list__td data-list__td--right">
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            aria-label={`Edit negotiated rate ${row.id}`}
                            onClick={() => openEditForm(row)}
                            disabled={isPending}
                          >
                            <Edit3 size={13} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            aria-label={`Remove negotiated rate ${row.id}`}
                            onClick={() => handleDelete(row)}
                            disabled={isPending}
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {clientType === 'organisation' && parentChain.length > 0 ? (
          <div
            style={{
              paddingTop: 12,
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              Inherited parent-group rates (Tier 3)
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              Active group chain:{' '}
              {parentChain.map((node, idx) => (
                <React.Fragment key={node.id}>
                  {idx > 0 ? ' → ' : null}
                  <Link href={`/organisations/${node.id}?tab=compliance`}>
                    {node.legalName}
                  </Link>
                </React.Fragment>
              ))}
            </div>
            {!hasInherited ? (
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                No parent-group rate overrides are configured on ancestor organisations.
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-list__table" style={{ width: '100%', fontSize: 12.5 }}>
                  <thead>
                    <tr className="data-list__head-row">
                      <th className="data-list__th">Parent organisation</th>
                      <th className="data-list__th">Grade</th>
                      <th className="data-list__th">Practice area scope</th>
                      <th className="data-list__th data-list__th--right">Rate (ex VAT)</th>
                      <th className="data-list__th">Effective window</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inheritedOverrides.flatMap((grp) =>
                      grp.overrides.map((ovr) => (
                        <tr key={ovr.id} className="data-list__row">
                          <td className="data-list__td">
                            <Link href={`/organisations/${grp.parentOrganisationId}?tab=compliance`}>
                              {grp.parentOrganisationName}
                            </Link>
                          </td>
                          <td className="data-list__td" style={{ fontWeight: 600 }}>
                            {gradeDisplayLabel(ovr.gradeKey, gradeOptions)}
                          </td>
                          <td className="data-list__td">
                            {ovr.practiceAreaId
                              ? resolveLabel(values, ovr.practiceAreaId) || ovr.practiceAreaId
                              : 'All practice areas (group default)'}
                          </td>
                          <td className="data-list__td data-list__td--right" style={{ fontWeight: 700 }}>
                            {formatRateGbp(ovr.rateGbp)}
                          </td>
                          <td className="data-list__td">
                            {formatDate(ovr.effectiveFrom)} –{' '}
                            {ovr.effectiveTo ? formatDate(ovr.effectiveTo) : 'Open-ended'}
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
