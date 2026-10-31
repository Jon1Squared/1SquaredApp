'use client';

import React, { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  addHomeRoleAction,
  resetHomePagesConfigAction,
  saveHomePagesConfigAction,
  switchUserAction,
  switchViewingRoleAction,
} from '@/app/actions';
import {
  cyclePanelPlacement,
  getPanelPlacement,
  HEADLINE_CARD_DEFINITIONS,
  PANEL_DEFINITIONS,
  resolveEmployeeRoles,
  setRolePanelPlacement,
} from '@/domain/homeConfig';
import { personDisplayName, primaryEmail } from '@/domain/names';
import type {
  HomePagesConfig,
  PanelCategory,
  PanelId,
  PanelPlacement,
  Person,
  RoleHomeConfig,
  Team,
} from '@/domain/types';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

const PANEL_CATEGORIES: PanelCategory[] = [
  'Tasks, enquiries & daily work',
  'Intake & conversion',
  'Secretarial & matter support',
  'Partner oversight',
  'Finance & credit control',
  'Risk & compliance',
  'Firm-wide executive',
];

interface Props {
  initialConfig: HomePagesConfig;
  activeViewingRole?: string;
  people: Person[];
  teams: Team[];
}

export function HomePagesAdminSection({
  initialConfig,
  activeViewingRole,
  people,
  teams,
}: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  const [roles, setRoles] = useState<RoleHomeConfig[]>(initialConfig.roles);
  const [firmSettings, setFirmSettings] = useState(initialConfig.firmSettings);
  const [selectedRoleKey, setSelectedRoleKey] = useState<string>(() => {
    if (
      activeViewingRole &&
      initialConfig.roles.some((r) => r.key === activeViewingRole)
    ) {
      return activeViewingRole;
    }
    return initialConfig.roles[0]?.key ?? 'fee_earner';
  });

  // Add role modal state
  const [addRoleOpen, setAddRoleOpen] = useState(false);
  const [newRoleLabel, setNewRoleLabel] = useState('');
  const [newRoleShortLabel, setNewRoleShortLabel] = useState('');
  const [newRolePurpose, setNewRolePurpose] = useState('');
  const [copyFromRoleKey, setCopyFromRoleKey] = useState('fee_earner');

  const persistConfig = (
    nextRoles: RoleHomeConfig[],
    nextSettings = firmSettings,
    toastMessage?: string,
  ) => {
    startTransition(async () => {
      await saveHomePagesConfigAction({
        roles: nextRoles,
        firmSettings: nextSettings,
      });
      if (toastMessage) {
        showToast(toastMessage);
      }
    });
  };

  const realEmployees = useMemo(
    () => people.filter((p) => p.isEmployee && !p.demo && !p.mergedIntoId),
    [people],
  );

  const demoEmployees = useMemo(
    () => people.filter((p) => p.isEmployee && p.demo && !p.mergedIntoId),
    [people],
  );

  const userCountByRole = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of roles) counts[r.key] = 0;
    for (const emp of realEmployees) {
      const empRoles = resolveEmployeeRoles(emp, teams);
      for (const rk of empRoles) {
        counts[rk] = (counts[rk] ?? 0) + 1;
      }
    }
    return counts;
  }, [roles, realEmployees, teams]);

  const selectedRole = useMemo(
    () => roles.find((r) => r.key === selectedRoleKey) ?? roles[0],
    [roles, selectedRoleKey],
  );

  const handleCycleCell = (roleKey: string, panelId: PanelId) => {
    const nextRoles = roles.map((r) => {
      if (r.key !== roleKey) return r;
      const current = getPanelPlacement(r, panelId);
      const next = cyclePanelPlacement(current);
      return setRolePanelPlacement(r, panelId, next);
    });
    setRoles(nextRoles);
    persistConfig(nextRoles, firmSettings);
  };

  const handlePurposeChange = (roleKey: string, purpose: string) => {
    setRoles((prev) => prev.map((r) => (r.key === roleKey ? { ...r, purpose } : r)));
  };

  const handleMovePanelInRole = (
    roleKey: string,
    column: 'primary' | 'summary',
    index: number,
    delta: -1 | 1,
  ) => {
    const currentRole = roles.find((r) => r.key === roleKey);
    if (!currentRole) return;
    const list =
      column === 'primary' ? [...currentRole.primaryPanels] : [...currentRole.summaryPanels];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const [item] = list.splice(index, 1);
    list.splice(target, 0, item);
    const nextRoles = roles.map((r) => {
      if (r.key !== roleKey) return r;
      return column === 'primary'
        ? { ...r, primaryPanels: list }
        : { ...r, summaryPanels: list };
    });
    setRoles(nextRoles);
    persistConfig(nextRoles, firmSettings);
  };

  const handleToggleHeadlineCard = (roleKey: string, cardId: string) => {
    const currentRole = roles.find((r) => r.key === roleKey);
    if (!currentRole) return;
    const exists = currentRole.headlineCardIds.includes(cardId);
    if (!exists && currentRole.headlineCardIds.length >= 5) {
      showToast('Up to 5 headline figure cards can be selected per role');
      return;
    }
    const nextRoles = roles.map((r) => {
      if (r.key !== roleKey) return r;
      return {
        ...r,
        headlineCardIds: exists
          ? r.headlineCardIds.filter((id) => id !== cardId)
          : [...r.headlineCardIds, cardId],
      };
    });
    setRoles(nextRoles);
    persistConfig(nextRoles, firmSettings);
  };

  const handlePreviewRole = (role: RoleHomeConfig) => {
    startTransition(async () => {
      await saveHomePagesConfigAction({
        roles,
        firmSettings,
      });
      // Find matching demo user if available
      const demoUser = demoEmployees.find(
        (d) =>
          (role.demoUserEmail && primaryEmail(d)?.toLowerCase() === role.demoUserEmail.toLowerCase()) ||
          (d.roles && d.roles[0] === role.key),
      );
      if (demoUser && firmSettings.demoMode) {
        await switchUserAction(demoUser.id);
        await switchViewingRoleAction(role.key);
        router.push('/');
      } else {
        router.push(`/?previewRole=${encodeURIComponent(role.key)}`);
      }
    });
  };

  const handleSaveChanges = () => {
    startTransition(async () => {
      const res = await saveHomePagesConfigAction({
        roles,
        firmSettings,
      });
      if (res.config) {
        setRoles(res.config.roles);
        setFirmSettings(res.config.firmSettings);
      }
      showToast('Home pages configuration saved');
    });
  };

  const handleResetDefaults = () => {
    startTransition(async () => {
      const res = await resetHomePagesConfigAction();
      if (res.config) {
        setRoles(res.config.roles);
        setFirmSettings(res.config.firmSettings);
      }
      showToast('Home pages reset to firm defaults');
    });
  };

  const handleAddRoleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoleLabel.trim()) return;
    startTransition(async () => {
      const res = await addHomeRoleAction({
        label: newRoleLabel.trim(),
        shortLabel: newRoleShortLabel.trim() || newRoleLabel.trim(),
        purpose:
          newRolePurpose.trim() ||
          `Tailored Home page for ${newRoleLabel.trim()}.`,
        copyFromRoleKey,
      });
      if (!res.ok || !res.role) {
        showToast(res.error ?? 'Could not create role');
        return;
      }
      const createdRole = res.role;
      setRoles((prev) => [...prev, createdRole]);
      setSelectedRoleKey(createdRole.key);
      setAddRoleOpen(false);
      setNewRoleLabel('');
      setNewRoleShortLabel('');
      setNewRolePurpose('');
      showToast(`Role "${createdRole.label}" created`);
    });
  };

  const renderPlacementDot = (placement: PanelPlacement) => {
    if (placement === 'primary') {
      return (
        <span
          className="matrix-dot matrix-dot--primary"
          aria-hidden="true"
          title="Primary (main column)"
        >
          ●
        </span>
      );
    }
    if (placement === 'summary') {
      return (
        <span
          className="matrix-dot matrix-dot--summary"
          aria-hidden="true"
          title="Summary (right column)"
        >
          ○
        </span>
      );
    }
    return (
      <span className="matrix-dot matrix-dot--off" aria-hidden="true" title="Off">
        —
      </span>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Top Intro & Action Bar */}
      <div
        className="subcard"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 16,
        }}
      >
        <div style={{ maxWidth: 760 }}>
          <div className="section-label" style={{ marginBottom: 4 }}>
            ADMINISTRATION · HOME PAGES &amp; ROLE CONFIGURATION
          </div>
          <h2 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 6px' }}>
            One home page, shaped by role
          </h2>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            Everyone lands on Home. What it leads with depends on the job: a fee earner sees
            today’s work and their own numbers; a partner sees the team and sign-offs; finance,
            risk and intake see their queues. People with more than one role switch with{' '}
            <strong>Viewing as</strong> in the header.
          </p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={pending}
            onClick={() => setAddRoleOpen(true)}
          >
            + Add role
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={pending}
            onClick={handleResetDefaults}
          >
            Reset to defaults
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={pending}
            onClick={handleSaveChanges}
          >
            Save changes
          </button>
        </div>
      </div>

      {/* Role Cards Grid (matching 00-overview-admin.html) */}
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 10,
          }}
        >
          <h3 className="section-label" style={{ margin: 0 }}>
            FIRM ROLES ({roles.length}) — CLICK A ROLE TO REORDER PANELS OR PICK HEADLINE FIGURES
          </h3>
        </div>
        <div className="role-cards-grid">
          {roles.map((role, idx) => {
            const count = userCountByRole[role.key] ?? 0;
            const isSelected = role.key === selectedRole?.key;
            const demoPerson = demoEmployees.find(
              (d) =>
                (role.demoUserEmail &&
                  primaryEmail(d)?.toLowerCase() === role.demoUserEmail.toLowerCase()) ||
                (d.roles && d.roles[0] === role.key),
            );
            const showsWorkPerson = demoPerson?.showsWorkOfId
              ? people.find((p) => p.id === demoPerson.showsWorkOfId)
              : null;

            return (
              <div
                key={role.key}
                className={`role-card ${isSelected ? 'role-card--active' : ''}`}
                onClick={() => setSelectedRoleKey(role.key)}
                style={{ cursor: 'pointer' }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <StatusPill
                    label={role.designNumber || String(idx + 1).padStart(2, '0')}
                    tone="positive"
                  />
                  <span className="pill pill--neutral" style={{ fontSize: 12 }}>
                    {count} {count === 1 ? 'user' : 'users'}
                  </span>
                </div>
                <div style={{ fontWeight: 800, fontSize: 17, marginTop: 4 }}>{role.label}</div>
                {showsWorkPerson ? (
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {personDisplayName(showsWorkPerson)} · {showsWorkPerson.jobTitle}
                  </div>
                ) : demoPerson ? (
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    Demo: {personDisplayName(demoPerson)}
                  </div>
                ) : null}
                <input
                  type="text"
                  aria-label={`Purpose for ${role.label}`}
                  className="field-input"
                  style={{ fontSize: 12.5, padding: '6px 8px', marginTop: 4 }}
                  value={role.purpose}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => handlePurposeChange(role.key, e.target.value)}
                  onBlur={() => persistConfig(roles, firmSettings)}
                />
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginTop: 'auto',
                    paddingTop: 8,
                    fontSize: 12,
                  }}
                >
                  <span className="muted">
                    {role.primaryPanels.length} primary · {role.summaryPanels.length} summary
                  </span>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePreviewRole(role);
                    }}
                  >
                    Preview →
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected Role Panel Ordering & Headline Figures */}
      {selectedRole ? (
        <div className="subcard">
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              marginBottom: 14,
            }}
          >
            <div>
              <div className="section-label">ROLE LAYOUT &amp; HEADLINE FIGURES</div>
              <h3 style={{ fontSize: 18, fontWeight: 800, margin: '2px 0 0' }}>
                Customising: {selectedRole.label}
              </h3>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="field-label" style={{ margin: 0 }} htmlFor="select-role-config">
                Switch role:
              </label>
              <select
                id="select-role-config"
                className="field-select"
                style={{ width: 240 }}
                value={selectedRole.key}
                onChange={(e) => setSelectedRoleKey(e.target.value)}
              >
                {roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={pending}
                onClick={handleSaveChanges}
              >
                Save changes
              </button>
            </div>
          </div>

          {/* Headline figure picker (up to 5) */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>
              Headline KPI strip cards ({selectedRole.headlineCardIds.length} of 5 selected)
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {HEADLINE_CARD_DEFINITIONS.map((card) => {
                const active = selectedRole.headlineCardIds.includes(card.id);
                return (
                  <button
                    key={card.id}
                    type="button"
                    className={`btn btn--sm ${active ? 'btn--primary' : 'btn--secondary'}`}
                    onClick={() => handleToggleHeadlineCard(selectedRole.key, card.id)}
                  >
                    {active ? '✓ ' : ''}
                    {card.label}{' '}
                    <span style={{ opacity: 0.75, fontSize: 11 }}>({card.source})</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Two-column ordering for Primary vs Summary panels */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 16,
            }}
          >
            <div>
              <div className="section-label" style={{ marginBottom: 8 }}>
                ● PRIMARY COLUMN ORDER ({selectedRole.primaryPanels.length})
              </div>
              {selectedRole.primaryPanels.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  No primary panels enabled for this role. Click a cell in the matrix below to add
                  one.
                </p>
              ) : (
                selectedRole.primaryPanels.map((pid, idx) => {
                  const def = PANEL_DEFINITIONS.find((d) => d.id === pid);
                  return (
                    <div
                      key={pid}
                      className="list-row"
                      style={{ padding: '8px 10px', marginBottom: 6 }}
                    >
                      <div className="list-row__main">
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                          {idx + 1}. {def?.name ?? pid}
                        </div>
                      </div>
                      <div className="list-row__aside" style={{ gap: 4 }}>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          aria-label={`Move ${def?.name ?? pid} up`}
                          disabled={idx === 0}
                          onClick={() =>
                            handleMovePanelInRole(selectedRole.key, 'primary', idx, -1)
                          }
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          aria-label={`Move ${def?.name ?? pid} down`}
                          disabled={idx === selectedRole.primaryPanels.length - 1}
                          onClick={() =>
                            handleMovePanelInRole(selectedRole.key, 'primary', idx, 1)
                          }
                        >
                          ↓
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div>
              <div className="section-label" style={{ marginBottom: 8 }}>
                ○ SUMMARY / SIDE COLUMN ORDER ({selectedRole.summaryPanels.length})
              </div>
              {selectedRole.summaryPanels.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  No summary panels enabled for this role.
                </p>
              ) : (
                selectedRole.summaryPanels.map((pid, idx) => {
                  const def = PANEL_DEFINITIONS.find((d) => d.id === pid);
                  return (
                    <div
                      key={pid}
                      className="list-row"
                      style={{ padding: '8px 10px', marginBottom: 6 }}
                    >
                      <div className="list-row__main">
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                          {idx + 1}. {def?.name ?? pid}
                        </div>
                      </div>
                      <div className="list-row__aside" style={{ gap: 4 }}>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          aria-label={`Move ${def?.name ?? pid} up`}
                          disabled={idx === 0}
                          onClick={() =>
                            handleMovePanelInRole(selectedRole.key, 'summary', idx, -1)
                          }
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          aria-label={`Move ${def?.name ?? pid} down`}
                          disabled={idx === selectedRole.summaryPanels.length - 1}
                          onClick={() =>
                            handleMovePanelInRole(selectedRole.key, 'summary', idx, 1)
                          }
                        >
                          ↓
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Interactive Panel Configuration Matrix */}
      <div className="subcard">
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div>
            <div className="section-label">WHAT EACH HOME PAGE LEADS WITH</div>
            <h3 style={{ fontSize: 18, fontWeight: 800, margin: '2px 0 0' }}>
              Panel Configuration Matrix ({PANEL_DEFINITIONS.length} panels × {roles.length} roles)
            </h3>
          </div>
          <div style={{ display: 'flex', gap: 16, fontSize: 13, alignItems: 'center' }}>
            <span>
              <strong style={{ color: 'var(--teal)' }}>● Primary</strong> (main column)
            </span>
            <span>
              <strong style={{ color: 'var(--teal)' }}>○ Summary</strong> (right column)
            </span>
            <span className="muted">
              <strong>— Off</strong> (hidden)
            </span>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ minWidth: 280 }}>Panel / Module</th>
                {roles.map((r) => (
                  <th key={r.key} style={{ textAlign: 'center', minWidth: 92 }}>
                    {r.shortLabel || r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PANEL_CATEGORIES.map((category) => {
                const catPanels = PANEL_DEFINITIONS.filter((p) => p.category === category);
                return (
                  <React.Fragment key={category}>
                    <tr>
                      <td
                        colSpan={roles.length + 1}
                        style={{
                          background: 'var(--surface-soft)',
                          fontWeight: 800,
                          fontSize: 11.5,
                          letterSpacing: '0.07em',
                          textTransform: 'uppercase',
                          padding: '8px 10px',
                        }}
                      >
                        {category}
                      </td>
                    </tr>
                    {catPanels.map((panel) => (
                      <tr key={panel.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{panel.name}</div>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {panel.sourceLabel}
                          </div>
                        </td>
                        {roles.map((role) => {
                          const placement = getPanelPlacement(role, panel.id);
                          const placementLabel =
                            placement === 'primary'
                              ? 'Primary'
                              : placement === 'summary'
                                ? 'Summary'
                                : 'Off';
                          return (
                            <td key={role.key} style={{ textAlign: 'center', verticalAlign: 'middle' }}>
                              <button
                                type="button"
                                className={`matrix-dot-btn matrix-dot-btn--${placement}`}
                                aria-label={`${panel.name} for ${role.label}: ${placementLabel}. Click to cycle.`}
                                title={`${role.label}: ${placementLabel} (click to cycle)`}
                                onClick={() => handleCycleCell(role.key, panel.id)}
                              >
                                {renderPlacementDot(placement)}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Firm settings for Home pages */}
      <div className="subcard">
        <div className="section-label" style={{ marginBottom: 4 }}>
          FIRM SETTINGS FOR HOME PAGES
        </div>
        <h3 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 14px' }}>
          Demo mode, chargeable pace &amp; attention thresholds
        </h3>

        <div className="form-grid">
          <div className="field-group field-group--full">
            <label className="checkbox-pill">
              <input
                type="checkbox"
                checked={firmSettings.demoMode}
                onChange={(e) => {
                  const nextSettings = { ...firmSettings, demoMode: e.target.checked };
                  setFirmSettings(nextSettings);
                  persistConfig(roles, nextSettings);
                }}
              />
              <span>
                <strong>Demo mode</strong> — show the &ldquo;Switch to demo user&rdquo; menu in the
                header avatar and display the &ldquo;Demo user: showing &#123;Name&#125;’s work&rdquo;
                banner when viewing as a demo persona.
              </span>
            </label>
          </div>

          <div className="field-group">
            <label className="field-label" htmlFor="home-pace-hours">
              Working day pace (hours / day)
            </label>
            <input
              id="home-pace-hours"
              type="number"
              step="0.1"
              min="1"
              max="12"
              className="field-input"
              placeholder="Auto (annual target ÷ 220 days = 5.5h)"
              value={firmSettings.workingDayPaceHours ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setFirmSettings((prev) => ({
                  ...prev,
                  workingDayPaceHours: v === '' ? null : Math.max(1, Number(v) || 5.5),
                }));
              }}
              onBlur={() => persistConfig(roles, firmSettings)}
            />
            <span className="muted" style={{ fontSize: 12 }}>
              Leave blank to derive from each fee earner’s annual target (1,200h ÷ 220 working days
              = 5.5h/day).
            </span>
          </div>

          <div className="field-group">
            <label className="field-label" htmlFor="home-wip-age-days">
              WIP age warning threshold (days)
            </label>
            <input
              id="home-wip-age-days"
              type="number"
              min={7}
              max={365}
              className="field-input"
              value={firmSettings.wipAgeThresholdDays}
              onChange={(e) =>
                setFirmSettings((prev) => ({
                  ...prev,
                  wipAgeThresholdDays: Math.max(7, Number(e.target.value) || 30),
                }))
              }
              onBlur={() => persistConfig(roles, firmSettings)}
            />
          </div>

          <div className="field-group">
            <label className="field-label" htmlFor="home-debt-overdue-days">
              Debt escalation threshold (days overdue)
            </label>
            <input
              id="home-debt-overdue-days"
              type="number"
              min={7}
              max={365}
              className="field-input"
              value={firmSettings.debtOverdueThresholdDays}
              onChange={(e) =>
                setFirmSettings((prev) => ({
                  ...prev,
                  debtOverdueThresholdDays: Math.max(7, Number(e.target.value) || 90),
                }))
              }
              onBlur={() => persistConfig(roles, firmSettings)}
            />
          </div>

          <div className="field-group">
            <label className="field-label" htmlFor="home-sla-warn-mins">
              Callback SLA warning buffer (minutes)
            </label>
            <input
              id="home-sla-warn-mins"
              type="number"
              min={0}
              max={240}
              className="field-input"
              value={firmSettings.callbackSlaOverdueMinutes}
              onChange={(e) =>
                setFirmSettings((prev) => ({
                  ...prev,
                  callbackSlaOverdueMinutes: Math.max(0, Number(e.target.value) || 0),
                }))
              }
              onBlur={() => persistConfig(roles, firmSettings)}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button
            type="button"
            className="btn btn--primary"
            disabled={pending}
            onClick={handleSaveChanges}
          >
            Save changes
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={pending}
            onClick={handleResetDefaults}
          >
            Reset to defaults
          </button>
        </div>
      </div>

      {/* Add Role Modal */}
      {addRoleOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="modal-header">
              <h2>Add custom Home role</h2>
            </div>
            <form onSubmit={handleAddRoleSubmit}>
              <div className="form-grid">
                <div className="field-group field-group--full">
                  <label className="field-label" htmlFor="new-role-label">
                    Role name *
                  </label>
                  <input
                    id="new-role-label"
                    type="text"
                    required
                    className="field-input"
                    placeholder="e.g. Business Development or Practice Manager"
                    value={newRoleLabel}
                    onChange={(e) => setNewRoleLabel(e.target.value)}
                  />
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="new-role-short">
                    Short column label
                  </label>
                  <input
                    id="new-role-short"
                    type="text"
                    className="field-input"
                    placeholder="e.g. Bus Dev"
                    value={newRoleShortLabel}
                    onChange={(e) => setNewRoleShortLabel(e.target.value)}
                  />
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="copy-from-role">
                    Copy initial panels from
                  </label>
                  <select
                    id="copy-from-role"
                    className="field-select"
                    value={copyFromRoleKey}
                    onChange={(e) => setCopyFromRoleKey(e.target.value)}
                  >
                    {roles.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-group field-group--full">
                  <label className="field-label" htmlFor="new-role-purpose">
                    Purpose / subtitle line
                  </label>
                  <input
                    id="new-role-purpose"
                    type="text"
                    className="field-input"
                    placeholder="Short description of what this role leads with..."
                    value={newRolePurpose}
                    onChange={(e) => setNewRolePurpose(e.target.value)}
                  />
                </div>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setAddRoleOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={pending}>
                  Create role
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
