'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  resetHomePagesConfigAction,
  saveHomePagesConfigAction,
} from '@/app/actions';
import {
  HEADLINE_CARD_DEFINITIONS,
  PANEL_DEFINITIONS,
  setRolePanelPlacement,
  syncHomeRolesWithEmployeeRoles,
} from '@/domain/homeConfig';
import type {
  ChoiceValue,
  HomePagesConfig,
  HomeRoleKey,
  PanelCategory,
  PanelId,
  Person,
  RoleHomeConfig,
  Team,
} from '@/domain/types';
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
  defaultRoleConfigs?: RoleHomeConfig[];
  activeViewingRole?: string;
  rolesByPersonId?: Record<string, HomeRoleKey[]>;
  people: Person[];
  teams: Team[];
  values?: ChoiceValue[];
  onNavigateToEmployeeRoles?: () => void;
}

export function HomePagesAdminSection({
  initialConfig,
  defaultRoleConfigs,
  activeViewingRole,
  rolesByPersonId = {},
  people,
  teams: _teams,
  values = [],
  onNavigateToEmployeeRoles,
}: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  const syncedInitialRoles = useMemo(
    () => syncHomeRolesWithEmployeeRoles(initialConfig.roles, values, defaultRoleConfigs),
    [initialConfig.roles, values, defaultRoleConfigs],
  );

  const [rawRoles, setRoles] = useState<RoleHomeConfig[]>(syncedInitialRoles);
  const roles = useMemo(
    () => syncHomeRolesWithEmployeeRoles(rawRoles, values, defaultRoleConfigs),
    [rawRoles, values, defaultRoleConfigs],
  );
  const [firmSettings, setFirmSettings] = useState(() => ({
    ...initialConfig.firmSettings,
    demoMode: false,
  }));

  const [selectedRoleKey, setSelectedRoleKey] = useState<string>(() => {
    if (
      activeViewingRole &&
      syncedInitialRoles.some((r) => r.key === activeViewingRole)
    ) {
      return activeViewingRole;
    }
    return syncedInitialRoles[0]?.key ?? 'fee_earner';
  });

  const persistConfig = (
    nextRoles: RoleHomeConfig[],
    nextSettings = firmSettings,
    toastMessage?: string,
  ) => {
    startTransition(async () => {
      await saveHomePagesConfigAction({
        roles: nextRoles,
        firmSettings: { ...nextSettings, demoMode: false },
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

  const userCountByRole = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of roles) counts[r.key] = 0;
    for (const emp of realEmployees) {
      const empRoles = rolesByPersonId[emp.id] ?? emp.roles ?? [];
      for (const rk of empRoles) {
        counts[rk] = (counts[rk] ?? 0) + 1;
      }
    }
    return counts;
  }, [roles, realEmployees, rolesByPersonId]);

  const selectedRole = useMemo(
    () => roles.find((r) => r.key === selectedRoleKey) ?? roles[0],
    [roles, selectedRoleKey],
  );

  const handlePurposeChange = (roleKey: string, purpose: string) => {
    setRoles((prev) => prev.map((r) => (r.key === roleKey ? { ...r, purpose } : r)));
  };

  // ---------------- Headline KPI strip actions (left-to-right dual list) ----------------
  const handleAddHeadlineCard = (roleKey: string, cardId: string) => {
    const currentRole = roles.find((r) => r.key === roleKey);
    if (!currentRole) return;
    if (currentRole.headlineCardIds.includes(cardId)) return;
    if (currentRole.headlineCardIds.length >= 5) {
      showToast('Up to 5 headline KPI cards can be chosen per role');
      return;
    }
    const nextRoles = roles.map((r) =>
      r.key === roleKey
        ? { ...r, headlineCardIds: [...r.headlineCardIds, cardId] }
        : r,
    );
    setRoles(nextRoles);
    persistConfig(nextRoles, firmSettings);
  };

  const handleRemoveHeadlineCard = (roleKey: string, cardId: string) => {
    const nextRoles = roles.map((r) =>
      r.key === roleKey
        ? { ...r, headlineCardIds: r.headlineCardIds.filter((id) => id !== cardId) }
        : r,
    );
    setRoles(nextRoles);
    persistConfig(nextRoles, firmSettings);
  };

  const handleMoveHeadlineCard = (
    roleKey: string,
    index: number,
    delta: -1 | 1,
  ) => {
    const currentRole = roles.find((r) => r.key === roleKey);
    if (!currentRole) return;
    const list = [...currentRole.headlineCardIds];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const [item] = list.splice(index, 1);
    list.splice(target, 0, item);
    const nextRoles = roles.map((r) =>
      r.key === roleKey ? { ...r, headlineCardIds: list } : r,
    );
    setRoles(nextRoles);
    persistConfig(nextRoles, firmSettings);
  };

  // ---------------- Panel placement & column ordering actions ----------------
  const handleSetPanelPlacement = (
    roleKey: string,
    panelId: PanelId,
    placement: 'primary' | 'summary' | 'off',
  ) => {
    const nextRoles = roles.map((r) =>
      r.key === roleKey ? setRolePanelPlacement(r, panelId, placement) : r,
    );
    setRoles(nextRoles);
    persistConfig(nextRoles, firmSettings);
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

  const handlePreviewRole = (role: RoleHomeConfig) => {
    startTransition(async () => {
      await saveHomePagesConfigAction({
        roles,
        firmSettings: { ...firmSettings, demoMode: false },
      });
      router.push(`/?previewRole=${encodeURIComponent(role.key)}`);
    });
  };

  const handleSaveChanges = () => {
    startTransition(async () => {
      const res = await saveHomePagesConfigAction({
        roles,
        firmSettings: { ...firmSettings, demoMode: false },
      });
      if (res.config) {
        setRoles(syncHomeRolesWithEmployeeRoles(res.config.roles, values, defaultRoleConfigs));
        setFirmSettings({ ...res.config.firmSettings, demoMode: false });
      }
      showToast('Home pages configuration saved');
    });
  };

  const handleResetDefaults = () => {
    startTransition(async () => {
      const res = await resetHomePagesConfigAction();
      if (res.config) {
        setRoles(syncHomeRolesWithEmployeeRoles(res.config.roles, values, defaultRoleConfigs));
        setFirmSettings({ ...res.config.firmSettings, demoMode: false });
      }
      showToast('Home pages reset to firm defaults');
    });
  };

  const availableHeadlineCards = useMemo(() => {
    if (!selectedRole) return HEADLINE_CARD_DEFINITIONS;
    return HEADLINE_CARD_DEFINITIONS.filter(
      (c) => !selectedRole.headlineCardIds.includes(c.id),
    );
  }, [selectedRole]);

  const chosenHeadlineCards = useMemo(() => {
    if (!selectedRole) return [];
    return selectedRole.headlineCardIds
      .map((id) => HEADLINE_CARD_DEFINITIONS.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
  }, [selectedRole]);

  const availablePanelsByCategory = useMemo(() => {
    if (!selectedRole) return [];
    const chosenSet = new Set<PanelId>([
      ...selectedRole.primaryPanels,
      ...selectedRole.summaryPanels,
    ]);
    return PANEL_CATEGORIES.map((category) => ({
      category,
      panels: PANEL_DEFINITIONS.filter(
        (p) => p.category === category && !chosenSet.has(p.id),
      ),
    })).filter((group) => group.panels.length > 0);
  }, [selectedRole]);

  const totalAvailablePanelsCount = useMemo(
    () => availablePanelsByCategory.reduce((acc, g) => acc + g.panels.length, 0),
    [availablePanelsByCategory],
  );

  if (!selectedRole) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* 1. Role Selector Dropdown Bar (linked to People › Employee Roles in Taxonomy) */}
      <div className="subcard">
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', flex: 1 }}>
            <div style={{ minWidth: 280 }}>
              <label
                className="field-label"
                style={{ marginBottom: 6, display: 'block' }}
                htmlFor="select-role-config"
              >
                Employee role screen to update
              </label>
              <select
                id="select-role-config"
                className="field-select"
                style={{ width: '100%' }}
                value={selectedRole.key}
                onChange={(e) => setSelectedRoleKey(e.target.value)}
              >
                {roles.map((r) => {
                  const count = userCountByRole[r.key] ?? 0;
                  return (
                    <option key={r.key} value={r.key}>
                      {r.label} ({count} {count === 1 ? 'employee' : 'employees'})
                    </option>
                  );
                })}
              </select>
            </div>

            <div style={{ flex: 1, minWidth: 260 }}>
              <label
                className="field-label"
                style={{ marginBottom: 6, display: 'block' }}
                htmlFor="selected-role-purpose"
              >
                Role subtitle / purpose
              </label>
              <input
                id="selected-role-purpose"
                type="text"
                className="field-input"
                value={selectedRole.purpose}
                onChange={(e) => handlePurposeChange(selectedRole.key, e.target.value)}
                onBlur={() => persistConfig(roles, firmSettings)}
              />
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {onNavigateToEmployeeRoles ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={onNavigateToEmployeeRoles}
                title="Manage Employee roles in Taxonomy › People"
              >
                People › Employee roles in Taxonomy →
              </button>
            ) : (
              <Link
                href="/admin/lists?list=employee_role"
                className="btn btn--ghost btn--sm"
              >
                People › Employee roles in Taxonomy →
              </Link>
            )}
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={pending}
              onClick={() => handlePreviewRole(selectedRole)}
            >
              Preview →
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
      </div>

      {/* 2. Headline KPI Strip Section (separated from Column Order; left = Available, right = Chosen) */}
      <div className="subcard">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 14,
          }}
        >
          <div>
            <div className="section-label">HEADLINE KPI STRIP · {selectedRole.label.toUpperCase()}</div>
            <h3 style={{ fontSize: 17, fontWeight: 800, margin: '2px 0 0' }}>
              Headline KPI strip cards ({chosenHeadlineCards.length} of 5 chosen)
            </h3>
          </div>
          <span className="muted" style={{ fontSize: 12.5 }}>
            Move items from Available on the left to Chosen on the right (up to 5 cards).
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: 16,
            alignItems: 'start',
          }}
        >
          {/* Left-hand list: Available KPI options */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 12,
              background: 'var(--surface-soft)',
            }}
          >
            <div className="section-label" style={{ marginBottom: 8 }}>
              AVAILABLE KPI OPTIONS ({availableHeadlineCards.length})
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                maxHeight: 320,
                overflowY: 'auto',
                paddingRight: 4,
              }}
            >
              {availableHeadlineCards.length === 0 ? (
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                  All available KPI options have been chosen.
                </p>
              ) : (
                availableHeadlineCards.map((card) => (
                  <div
                    key={card.id}
                    className="list-row"
                    style={{
                      padding: '7px 10px',
                      marginBottom: 0,
                      background: 'var(--surface)',
                    }}
                  >
                    <div className="list-row__main">
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        {card.label}{' '}
                        <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>
                          ({card.source})
                        </span>
                      </div>
                    </div>
                    <div className="list-row__aside">
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        style={{ padding: '3px 10px', fontSize: 12 }}
                        disabled={chosenHeadlineCards.length >= 5}
                        aria-label={`Choose ${card.label}`}
                        onClick={() => handleAddHeadlineCard(selectedRole.key, card.id)}
                      >
                        Choose →
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right-hand list: Chosen KPI options */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 12,
              background: 'var(--surface-soft)',
            }}
          >
            <div className="section-label" style={{ marginBottom: 8 }}>
              CHOSEN KPI OPTIONS ({chosenHeadlineCards.length} OF 5)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {chosenHeadlineCards.length === 0 ? (
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                  No KPI cards chosen for this role. Select options from the left-hand list.
                </p>
              ) : (
                chosenHeadlineCards.map((card, idx) => (
                  <div
                    key={card.id}
                    className="list-row"
                    style={{
                      padding: '7px 10px',
                      marginBottom: 0,
                      background: 'var(--surface)',
                    }}
                  >
                    <div className="list-row__main">
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        {idx + 1}. {card.label}{' '}
                        <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>
                          ({card.source})
                        </span>
                      </div>
                    </div>
                    <div className="list-row__aside" style={{ gap: 4 }}>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        style={{ padding: '2px 6px' }}
                        aria-label={`Move ${card.label} up`}
                        disabled={idx === 0}
                        onClick={() => handleMoveHeadlineCard(selectedRole.key, idx, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        style={{ padding: '2px 6px' }}
                        aria-label={`Move ${card.label} down`}
                        disabled={idx === chosenHeadlineCards.length - 1}
                        onClick={() => handleMoveHeadlineCard(selectedRole.key, idx, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        style={{ padding: '2px 8px', fontSize: 12 }}
                        aria-label={`Remove ${card.label}`}
                        onClick={() => handleRemoveHeadlineCard(selectedRole.key, card.id)}
                      >
                        ← Remove
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 3. Column Order & Panel Selection (Available Options next to Primary Column and Summary Side Column) */}
      <div className="subcard">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 14,
          }}
        >
          <div>
            <div className="section-label">
              HOME PAGE PANELS &amp; COLUMN ORDER · {selectedRole.label.toUpperCase()}
            </div>
            <h3 style={{ fontSize: 17, fontWeight: 800, margin: '2px 0 0' }}>
              Available panels, Primary column &amp; Summary side column
            </h3>
          </div>
          <span className="muted" style={{ fontSize: 12.5 }}>
            Add available panels to the Primary column or Summary side column and reorder them in place.
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))',
            gap: 16,
            alignItems: 'start',
          }}
        >
          {/* Left list: Available options */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 12,
              background: 'var(--surface-soft)',
            }}
          >
            <div className="section-label" style={{ marginBottom: 8 }}>
              AVAILABLE OPTIONS ({totalAvailablePanelsCount})
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                maxHeight: 540,
                overflowY: 'auto',
                paddingRight: 4,
              }}
            >
              {availablePanelsByCategory.length === 0 ? (
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                  All panels have been added to the Primary or Summary columns.
                </p>
              ) : (
                availablePanelsByCategory.map(({ category, panels }) => (
                  <div key={category}>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: 'var(--muted)',
                        marginBottom: 6,
                      }}
                    >
                      {category}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {panels.map((panel) => (
                        <div
                          key={panel.id}
                          className="list-row"
                          style={{
                            padding: '8px 10px',
                            marginBottom: 0,
                            background: 'var(--surface)',
                            flexDirection: 'column',
                            alignItems: 'stretch',
                            gap: 6,
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{panel.name}</div>
                            <div className="muted" style={{ fontSize: 11.5 }}>
                              {panel.sourceLabel}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              aria-label={`Add ${panel.name} to Primary column`}
                              onClick={() =>
                                handleSetPanelPlacement(selectedRole.key, panel.id, 'primary')
                              }
                            >
                              + Primary →
                            </button>
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              aria-label={`Add ${panel.name} to Summary side column`}
                              onClick={() =>
                                handleSetPanelPlacement(selectedRole.key, panel.id, 'summary')
                              }
                            >
                              + Summary →
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Middle list: Primary column order */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 12,
              background: 'var(--surface-soft)',
            }}
          >
            <div className="section-label" style={{ marginBottom: 8 }}>
              ● PRIMARY COLUMN ({selectedRole.primaryPanels.length})
            </div>
            {selectedRole.primaryPanels.length === 0 ? (
              <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                No primary panels chosen. Click <strong>+ Primary →</strong> on an available option to add one.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {selectedRole.primaryPanels.map((pid, idx) => {
                  const def = PANEL_DEFINITIONS.find((d) => d.id === pid);
                  return (
                    <div
                      key={pid}
                      className="list-row"
                      style={{
                        padding: '8px 10px',
                        marginBottom: 0,
                        background: 'var(--surface)',
                        flexDirection: 'column',
                        alignItems: 'stretch',
                        gap: 6,
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        {idx + 1}. {def?.name ?? pid}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            style={{ padding: '2px 6px' }}
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
                            style={{ padding: '2px 6px' }}
                            aria-label={`Move ${def?.name ?? pid} down`}
                            disabled={idx === selectedRole.primaryPanels.length - 1}
                            onClick={() =>
                              handleMovePanelInRole(selectedRole.key, 'primary', idx, 1)
                            }
                          >
                            ↓
                          </button>
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            style={{ padding: '2px 8px', fontSize: 11.5 }}
                            title="Move to Summary side column"
                            onClick={() =>
                              handleSetPanelPlacement(selectedRole.key, pid, 'summary')
                            }
                          >
                            → Summary
                          </button>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            style={{ padding: '2px 8px', fontSize: 11.5 }}
                            aria-label={`Remove ${def?.name ?? pid}`}
                            onClick={() =>
                              handleSetPanelPlacement(selectedRole.key, pid, 'off')
                            }
                          >
                            ← Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right list: Summary side column order */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 12,
              background: 'var(--surface-soft)',
            }}
          >
            <div className="section-label" style={{ marginBottom: 8 }}>
              ○ SUMMARY / SIDE COLUMN ({selectedRole.summaryPanels.length})
            </div>
            {selectedRole.summaryPanels.length === 0 ? (
              <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                No summary panels chosen. Click <strong>+ Summary →</strong> on an available option to add one.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {selectedRole.summaryPanels.map((pid, idx) => {
                  const def = PANEL_DEFINITIONS.find((d) => d.id === pid);
                  return (
                    <div
                      key={pid}
                      className="list-row"
                      style={{
                        padding: '8px 10px',
                        marginBottom: 0,
                        background: 'var(--surface)',
                        flexDirection: 'column',
                        alignItems: 'stretch',
                        gap: 6,
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        {idx + 1}. {def?.name ?? pid}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            style={{ padding: '2px 6px' }}
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
                            style={{ padding: '2px 6px' }}
                            aria-label={`Move ${def?.name ?? pid} down`}
                            disabled={idx === selectedRole.summaryPanels.length - 1}
                            onClick={() =>
                              handleMovePanelInRole(selectedRole.key, 'summary', idx, 1)
                            }
                          >
                            ↓
                          </button>
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            style={{ padding: '2px 8px', fontSize: 11.5 }}
                            title="Move to Primary column"
                            onClick={() =>
                              handleSetPanelPlacement(selectedRole.key, pid, 'primary')
                            }
                          >
                            ← Primary
                          </button>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            style={{ padding: '2px 8px', fontSize: 11.5 }}
                            aria-label={`Remove ${def?.name ?? pid}`}
                            onClick={() =>
                              handleSetPanelPlacement(selectedRole.key, pid, 'off')
                            }
                          >
                            ← Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 4. Firm settings for Home pages (without Demo Mode) */}
      <div className="subcard">
        <div className="section-label" style={{ marginBottom: 4 }}>
          FIRM SETTINGS FOR HOME PAGES
        </div>
        <h3 style={{ fontSize: 17, fontWeight: 800, margin: '0 0 14px' }}>
          Chargeable pace &amp; attention thresholds
        </h3>

        <div className="form-grid">
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
    </div>
  );
}
