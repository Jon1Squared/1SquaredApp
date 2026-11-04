'use client';

import React, { useState, useTransition } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import {
  saveMatterCostsConfigAction,
  syncMatterCostsRatesFromPmsAction,
} from '@/app/actions';
import { createDefaultMatterCostsConfig } from '@/domain/matterCosts';
import type {
  ChoiceValue,
  CustomGradeRateRow,
  DisbursementPresetItem,
  MatterCostsConfig,
  RateCardEntry,
  RateTableSourceMode,
} from '@/domain/types';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  initialConfig?: MatterCostsConfig;
  values: ChoiceValue[];
}

export function MatterCostsAdminSection({ initialConfig, values }: Props) {
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  const [config, setConfig] = useState<MatterCostsConfig>(() =>
    initialConfig ?? createDefaultMatterCostsConfig(values),
  );

  const [newCardName, setNewCardName] = useState('');
  const [newCardPracticeAreaId, setNewCardPracticeAreaId] = useState<string>('');
  const [newCardPartnerRate, setNewCardPartnerRate] = useState<string>('400');
  const [newCardAssociateRate, setNewCardAssociateRate] = useState<string>('285');
  const [newCardTraineeRate, setNewCardTraineeRate] = useState<string>('160');

  const [newCustomGradeCardId, setNewCustomGradeCardId] = useState<string>('');
  const [newCustomGradeLabel, setNewCustomGradeLabel] = useState<string>('');
  const [newCustomGradeRate, setNewCustomGradeRate] = useState<string>('320');

  const [newPresetDesc, setNewPresetDesc] = useState('');
  const [newPresetAmount, setNewPresetAmount] = useState('');
  const [newPresetVat, setNewPresetVat] = useState(true);

  const practiceAreas = values.filter(
    (v) => v.listKey === 'work_type' && !v.parentId && v.active,
  );

  function handleUpdateRateCard(id: string, patch: Partial<RateCardEntry>) {
    setConfig((prev) => ({
      ...prev,
      rateCards: prev.rateCards.map((rc) =>
        rc.id === id ? { ...rc, ...patch } : rc,
      ),
    }));
  }

  function handleAddRateCard() {
    if (!newCardName.trim()) return;
    const pa = practiceAreas.find((p) => p.id === newCardPracticeAreaId);
    setConfig((prev) => {
      const created: RateCardEntry = {
        id: `RC-CUSTOM-${prev.rateCards.length + 1}`,
        name: newCardName.trim(),
        practiceAreaId: pa?.id ?? null,
        pmsDepartmentCode: pa?.label ?? 'Custom / Client Tier',
        partnerRateGbp: Number(newCardPartnerRate) || 375,
        associateRateGbp: Number(newCardAssociateRate) || 265,
        traineeRateGbp: Number(newCardTraineeRate) || 150,
        pmsPartnerRateGbp: null,
        pmsAssociateRateGbp: null,
        pmsTraineeRateGbp: null,
        customGrades: [],
        active: true,
      };
      return {
        ...prev,
        rateCards: [...prev.rateCards, created],
      };
    });
    setNewCardName('');
    setNewCardPracticeAreaId('');
  }

  function handleDeleteRateCard(id: string) {
    if (id === 'RC-DEFAULT') return;
    setConfig((prev) => ({
      ...prev,
      rateCards: prev.rateCards.filter((rc) => rc.id !== id),
    }));
  }

  function handleAddCustomGradeToCard() {
    const targetId = newCustomGradeCardId || config.rateCards[0]?.id;
    if (!targetId || !newCustomGradeLabel.trim()) return;
    const row: CustomGradeRateRow = {
      id: `CG-${Date.now()}`,
      label: newCustomGradeLabel.trim(),
      hourlyRateGbp: Number(newCustomGradeRate) || 250,
      pmsRateGbp: null,
    };
    setConfig((prev) => ({
      ...prev,
      rateCards: prev.rateCards.map((rc) =>
        rc.id === targetId
          ? { ...rc, customGrades: [...(rc.customGrades ?? []), row] }
          : rc,
      ),
    }));
    setNewCustomGradeLabel('');
  }

  function handleRemoveCustomGrade(cardId: string, gradeId: string) {
    setConfig((prev) => ({
      ...prev,
      rateCards: prev.rateCards.map((rc) =>
        rc.id === cardId
          ? {
              ...rc,
              customGrades: (rc.customGrades ?? []).filter(
                (g) => g.id !== gradeId,
              ),
            }
          : rc,
      ),
    }));
  }

  function handleAddDisbursementPreset() {
    if (!newPresetDesc.trim()) return;
    const item: DisbursementPresetItem = {
      id: `DP-${Date.now()}`,
      description: newPresetDesc.trim(),
      defaultAmountGbp: Number(newPresetAmount) || 0,
      vatApplicable: newPresetVat,
    };
    setConfig((prev) => ({
      ...prev,
      disbursementPresets: [...prev.disbursementPresets, item],
    }));
    setNewPresetDesc('');
    setNewPresetAmount('');
  }

  function handleRemoveDisbursementPreset(id: string) {
    setConfig((prev) => ({
      ...prev,
      disbursementPresets: prev.disbursementPresets.filter((p) => p.id !== id),
    }));
  }

  function handleSaveConfig() {
    startTransition(async () => {
      const saved = await saveMatterCostsConfigAction(config);
      setConfig(saved);
      showToast('Matter Costs & Client Rate Cards saved');
    });
  }

  function handleSyncFromPms() {
    startTransition(async () => {
      const synced = await syncMatterCostsRatesFromPmsAction();
      setConfig(synced);
      showToast(
        'Pulled Partner, Associate & Trainee hourly rates from PMS into rate table',
      );
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* 3-Layer Platform Architecture Differentiator */}
      <div
        className="subcard"
        style={{
          borderLeft: '4px solid var(--accent-primary, #1f6feb)',
          background: 'var(--surface-subtle, rgba(31, 111, 235, 0.04))',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>
              Three-Layer Platform Architecture · Active Profile: {config.clientProfileName}
            </strong>
            <StatusPill label="PostgreSQL DB-per-Tenant" tone="positive" />
            <StatusPill label="Model A (Azure Single-Tenant) & Model B (Multi-Tenant)" tone="neutral" />
          </div>
          <code style={{ fontSize: 12 }}>DB-per-Tenant Runtime</code>
        </div>

        <div className="form-grid-3" style={{ gap: 12 }}>
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--border-subtle, #d0d7de)',
              background: 'var(--surface-card, #fff)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Layer 1 · Core Platform
              </span>
              <StatusPill label="@platform/core v1.0.0" tone="neutral" />
            </div>
            <div style={{ fontSize: 12.5 }} className="muted">
              Shared base workflow (`core/`). Contains zero client names or firm-specific branches. Exposes versioned <code>@platform/core-api</code> hooks &amp; UI slots.
            </div>
          </div>

          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--border-subtle, #d0d7de)',
              background: 'var(--surface-card, #fff)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Layer 2 · Tenant Configuration
              </span>
              <StatusPill label="Schema Validated" tone="positive" />
            </div>
            <div style={{ fontSize: 12.5 }} className="muted">
              Declarative tenant JSON configuration (rate cards, custom grades, disbursement presets, PMS sync mode, Key Vault refs).
            </div>
          </div>

          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--border-subtle, #d0d7de)',
              background: 'var(--surface-card, #fff)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Layer 3 · Client Extensions
              </span>
              <StatusPill label="Extension Host Active" tone="warning" />
            </div>
            <div style={{ fontSize: 12.5 }} className="muted">
              Sandboxed tenant extension plugins implementing <code>beforeMatterCostsCalculate</code> &amp; <code>beforeMatterOpen</code> hooks via <code>ExtensionHost</code>.
            </div>
          </div>
        </div>
      </div>

      {/* Top Architecture & Save Bar */}
      <div className="subcard">
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 16,
          }}
        >
          <div style={{ maxWidth: 760 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
                Client Customisation · Matter Costs &amp; Rates Tables
              </h2>
              <StatusPill
                label="Multi-Client Base + Custom Layer"
                tone="positive"
              />
            </div>
            <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
              The base Matter Opening workflow remains identical across all firm deployments, while each client firm can customise its Partner, Associate &amp; Trainee rate cards, add custom fee-earner grades, configure disbursement presets, and either use the built-in Application Rates Table or pull live rates from their PMS when linked.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn btn--secondary"
              disabled={pending}
              onClick={handleSyncFromPms}
            >
              <RefreshCw size={14} />
              <span>Pull / Sync Rates from PMS</span>
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={pending}
              onClick={handleSaveConfig}
            >
              {pending ? 'Saving…' : 'Save configuration'}
            </button>
          </div>
        </div>

        {/* Client Profile & PMS Source Mode */}
        <div
          className="form-grid"
          style={{ marginTop: 18, gap: '14px 16px', alignItems: 'flex-start' }}
        >
          <div className="field-group">
            <label className="field-label">
              Client Customisation Profile Name
            </label>
            <input
              type="text"
              className="field-input"
              value={config.clientProfileName}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  clientProfileName: e.target.value,
                }))
              }
            />
            <span className="field-hint">
              Identifies this client firm&apos;s custom configuration layer on top of the base product.
            </span>
          </div>

          <div className="field-group">
            <label className="field-label">
              Step 2 Section Heading in Matter Opening
            </label>
            <input
              type="text"
              className="field-input"
              value={config.sectionTitle}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  sectionTitle: e.target.value,
                }))
              }
            />
            <span className="field-hint">
              Default: &ldquo;Matter Costs&rdquo; (displayed as 2 · MATTER COSTS after Step 1).
            </span>
          </div>

          <div className="field-group">
            <label className="field-label">
              Hourly Rates Lookup Source Mode
            </label>
            <select
              className="field-select"
              value={config.rateSourceMode}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  rateSourceMode: e.target.value as RateTableSourceMode,
                }))
              }
            >
              <option value="pms_when_linked">
                Hybrid: Use Application Rates Table &amp; pull from PMS when linked (Recommended)
              </option>
              <option value="app_table">
                Application Rates Table Only (Standalone — no PMS link required)
              </option>
              <option value="pms_only">
                PMS Rate Table Primary (Fallback to Application Table if unlinked)
              </option>
            </select>
          </div>

          <div className="field-group">
            <label className="field-label">PMS Rate Link &amp; Override Rules</label>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                paddingTop: 4,
              }}
            >
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={config.pmsLinkActive}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      pmsLinkActive: e.target.checked,
                    }))
                  }
                />
                <span>
                  <strong>PMS Link Active</strong> (enable live PMS rate lookup in Step 2 Matter Costs)
                </span>
              </label>

              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={config.allowMatterRateOverrides}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      allowMatterRateOverrides: e.target.checked,
                    }))
                  }
                />
                <span>
                  Allow fee earners to override Partner / Associate / Trainee rates on a matter
                </span>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Application & PMS Rates Table */}
      <div className="subcard">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>
              Rates Table (Partner, Associate &amp; Trainee + Custom Client Grades)
            </h3>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              Edit the Application Rates Table below. When a PMS link is active, PMS rates are shown alongside Application rates so the firm can use either or both.
            </p>
          </div>
          {config.pmsLastSyncedAt ? (
            <StatusPill
              label={`PMS synced: ${config.pmsLastSyncedAt.slice(0, 16).replace('T', ' ')}`}
              tone="neutral"
            />
          ) : null}
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Rate Card Name</th>
                <th>Department Scope</th>
                <th>Partner (£/hr)</th>
                <th>Associate (£/hr)</th>
                <th>Trainee (£/hr)</th>
                <th>PMS Synced (P / A / T)</th>
                <th>Custom Client Grades</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {config.rateCards.map((rc) => (
                <tr key={rc.id}>
                  <td>
                    <input
                      type="text"
                      className="field-input"
                      style={{ minWidth: 210 }}
                      value={rc.name}
                      onChange={(e) =>
                        handleUpdateRateCard(rc.id, { name: e.target.value })
                      }
                    />
                  </td>
                  <td style={{ fontSize: 13, fontWeight: 600 }}>
                    {rc.pmsDepartmentCode ||
                      practiceAreas.find((p) => p.id === rc.practiceAreaId)?.label ||
                      'Firm-wide Standard'}
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="5"
                      className="field-input"
                      style={{ width: 95, fontWeight: 700 }}
                      value={String(rc.partnerRateGbp)}
                      onChange={(e) =>
                        handleUpdateRateCard(rc.id, {
                          partnerRateGbp: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="5"
                      className="field-input"
                      style={{ width: 95, fontWeight: 700 }}
                      value={String(rc.associateRateGbp)}
                      onChange={(e) =>
                        handleUpdateRateCard(rc.id, {
                          associateRateGbp: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="5"
                      className="field-input"
                      style={{ width: 95, fontWeight: 700 }}
                      value={String(rc.traineeRateGbp)}
                      onChange={(e) =>
                        handleUpdateRateCard(rc.id, {
                          traineeRateGbp: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </td>
                  <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                    {rc.pmsPartnerRateGbp != null
                      ? `£${rc.pmsPartnerRateGbp} / £${rc.pmsAssociateRateGbp ?? '—'} / £${rc.pmsTraineeRateGbp ?? '—'}`
                      : 'Not synced'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {(rc.customGrades ?? []).length === 0 ? (
                        <span className="muted" style={{ fontSize: 12 }}>
                          Standard 3 grades
                        </span>
                      ) : (
                        (rc.customGrades ?? []).map((cg) => (
                          <span
                            key={cg.id}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '2px 8px',
                              borderRadius: 999,
                              fontSize: 11.5,
                              fontWeight: 600,
                              background: 'var(--bg-surface-subtle)',
                              border: '1px solid var(--border-subtle)',
                            }}
                          >
                            {cg.label}: £{cg.hourlyRateGbp}/hr
                            <button
                              type="button"
                              style={{
                                border: 'none',
                                background: 'transparent',
                                cursor: 'pointer',
                                padding: 0,
                                display: 'inline-flex',
                              }}
                              onClick={() => handleRemoveCustomGrade(rc.id, cg.id)}
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td>
                    {rc.id !== 'RC-DEFAULT' ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => handleDeleteRateCard(rc.id)}
                      >
                        Remove
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Add Custom Rate Card or Custom Client Grade */}
        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: '1px solid var(--border-subtle)',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 16,
          }}
        >
          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: 'var(--bg-surface-subtle)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
              + Add Custom Rate Card (e.g. Panel Client / Specialist Team)
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <input
                type="text"
                className="field-input"
                style={{ flex: '1 1 180px' }}
                placeholder="Rate card name (e.g. National Panel Rates)"
                value={newCardName}
                onChange={(e) => setNewCardName(e.target.value)}
              />
              <select
                className="field-select"
                style={{ flex: '1 1 150px' }}
                value={newCardPracticeAreaId}
                onChange={(e) => setNewCardPracticeAreaId(e.target.value)}
              >
                <option value="">All / Firm-wide</option>
                {practiceAreas.map((pa) => (
                  <option key={pa.id} value={pa.id}>
                    {pa.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                className="field-input"
                style={{ width: 85 }}
                placeholder="Partner £"
                value={newCardPartnerRate}
                onChange={(e) => setNewCardPartnerRate(e.target.value)}
              />
              <input
                type="number"
                className="field-input"
                style={{ width: 85 }}
                placeholder="Assoc £"
                value={newCardAssociateRate}
                onChange={(e) => setNewCardAssociateRate(e.target.value)}
              />
              <input
                type="number"
                className="field-input"
                style={{ width: 85 }}
                placeholder="Trainee £"
                value={newCardTraineeRate}
                onChange={(e) => setNewCardTraineeRate(e.target.value)}
              />
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={handleAddRateCard}
              >
                <Plus size={14} />
                <span>Add card</span>
              </button>
            </div>
          </div>

          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: 'var(--bg-surface-subtle)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
              + Add Custom Fee-Earner Grade to Rate Card (Client Customisation)
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <select
                className="field-select"
                style={{ flex: '1 1 160px' }}
                value={newCustomGradeCardId || config.rateCards[0]?.id || ''}
                onChange={(e) => setNewCustomGradeCardId(e.target.value)}
              >
                {config.rateCards.map((rc) => (
                  <option key={rc.id} value={rc.id}>
                    {rc.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                className="field-input"
                style={{ flex: '1 1 150px' }}
                placeholder="Grade (e.g. Senior Associate, Paralegal)"
                value={newCustomGradeLabel}
                onChange={(e) => setNewCustomGradeLabel(e.target.value)}
              />
              <input
                type="number"
                className="field-input"
                style={{ width: 95 }}
                placeholder="£/hr"
                value={newCustomGradeRate}
                onChange={(e) => setNewCustomGradeRate(e.target.value)}
              />
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={handleAddCustomGradeToCard}
              >
                <Plus size={14} />
                <span>Add grade</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Disbursement Presets & Payment on Account Defaults */}
      <div className="subcard">
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px' }}>
          Disbursement Quick-Add Presets &amp; Payment on Account Defaults
        </h3>
        <p className="muted" style={{ margin: '0 0 14px', fontSize: 13 }}>
          Configure common disbursement items that fee earners can add with one click in Step 2 Matter Costs, plus default Payment on Account settings.
        </p>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 12,
          }}
        >
          {config.disbursementPresets.map((p) => (
            <span
              key={p.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 12px',
                borderRadius: 999,
                fontSize: 12.5,
                fontWeight: 600,
                background: 'var(--bg-surface-subtle)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <span>
                {p.description} — £{p.defaultAmountGbp}
                {p.vatApplicable ? ' (+ VAT)' : ' (No VAT)'}
              </span>
              <button
                type="button"
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'inline-flex',
                }}
                onClick={() => handleRemoveDisbursementPreset(p.id)}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            className="field-input"
            style={{ maxWidth: 320 }}
            placeholder="Preset disbursement description…"
            value={newPresetDesc}
            onChange={(e) => setNewPresetDesc(e.target.value)}
          />
          <input
            type="number"
            className="field-input"
            style={{ width: 120 }}
            placeholder="Default £"
            value={newPresetAmount}
            onChange={(e) => setNewPresetAmount(e.target.value)}
          />
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12.5,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={newPresetVat}
              onChange={(e) => setNewPresetVat(e.target.checked)}
            />
            <span>+ VAT</span>
          </label>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={handleAddDisbursementPreset}
          >
            <Plus size={14} />
            <span>Add preset</span>
          </button>
        </div>
      </div>
    </div>
  );
}
