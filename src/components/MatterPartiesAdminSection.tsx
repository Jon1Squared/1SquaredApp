'use client';

import React, { useMemo, useState, useTransition } from 'react';
import {
  deleteMatterPartyCapacityAction,
  deleteMatterPartyRelationshipAction,
  reorderMatterPartyRelationshipAction,
  saveMatterPartyCapacityAction,
  saveMatterPartyRelationshipAction,
  updateWorkTypeProfilesAction,
} from '@/app/actions';
import {
  CAPACITY_GROUPS,
  computeMatterPartyUsageCounts,
  getProfilesForWorkType,
  WORK_TYPE_PROFILES,
} from '@/domain/matterParties';
import type {
  CapacityGroupName,
  ChoiceValue,
  Matter,
  MatterPartyCapacityDef,
  MatterPartyMigrationReport,
  MatterPartyRelationshipDef,
  MatterPartyTaxonomy,
  WorkTypeProfileCode,
} from '@/domain/types';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface MatterPartiesAdminSectionProps {
  taxonomy: MatterPartyTaxonomy;
  migrationReport?: MatterPartyMigrationReport;
  values: ChoiceValue[];
  matters: Matter[];
}

type SubTab = 'relationships' | 'capacities' | 'work_type_profiles';

const MATRIX_PROFILES: WorkTypeProfileCode[] = [
  'LIT',
  'EMP',
  'PROP',
  'CORP',
  'PC',
  'FAM',
  'INS',
  'REG',
  'CRIM',
  'CON',
];

export function MatterPartiesAdminSection({
  taxonomy: initialTaxonomy,
  migrationReport,
  values,
  matters,
}: MatterPartiesAdminSectionProps) {
  const { showToast } = useToast();
  const [subTab, setSubTab] = useState<SubTab>('relationships');
  const [taxonomy, setTaxonomy] = useState<MatterPartyTaxonomy>(initialTaxonomy);
  const [pending, startTransition] = useTransition();

  // Relationships state
  const [editingRelCode, setEditingRelCode] = useState<string | null>(null);
  const [editRelLabel, setEditRelLabel] = useState('');
  const [editRelDesc, setEditRelDesc] = useState('');
  const [addRelOpen, setAddRelOpen] = useState(false);
  const [newRelCode, setNewRelCode] = useState('');
  const [newRelLabel, setNewRelLabel] = useState('');
  const [newRelDesc, setNewRelDesc] = useState('');

  // Capacities state
  const [capSearch, setCapSearch] = useState('');
  const [capGroupFilter, setCapGroupFilter] = useState<string>('ALL_GROUPS');
  const [editingCapCode, setEditingCapCode] = useState<string | null>(null);
  const [editCapLabel, setEditCapLabel] = useState('');
  const [editCapGroup, setEditCapGroup] = useState<CapacityGroupName>(CAPACITY_GROUPS[0]);
  const [editCapDesc, setEditCapDesc] = useState('');
  const [addCapOpen, setAddCapOpen] = useState(false);
  const [newCapCode, setNewCapCode] = useState('');
  const [newCapLabel, setNewCapLabel] = useState('');
  const [newCapGroup, setNewCapGroup] = useState<CapacityGroupName>(CAPACITY_GROUPS[0]);
  const [newCapDesc, setNewCapDesc] = useState('');
  const [newCapRels, setNewCapRels] = useState<string[]>(['CC', 'CO', 'TP']);
  const [newCapProfiles, setNewCapProfiles] = useState<WorkTypeProfileCode[]>(['ALL']);

  // Work type profiles matrix state
  const [matrixSearch, setMatrixSearch] = useState('');
  const [showMigrationReport, setShowMigrationReport] = useState(false);

  // Sync when server props change
  React.useEffect(() => {
    setTaxonomy(initialTaxonomy);
  }, [initialTaxonomy]);

  const usageCounts = useMemo(
    () => computeMatterPartyUsageCounts(matters),
    [matters],
  );

  const sortedRelationships = useMemo(
    () => [...taxonomy.relationships].sort((a, b) => a.sortOrder - b.sortOrder),
    [taxonomy.relationships],
  );

  const workTypeTree = useMemo(() => {
    const parents = values
      .filter((v) => v.listKey === 'work_type' && !v.parentId && v.active)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const children = values
      .filter((v) => v.listKey === 'work_type' && Boolean(v.parentId) && v.active)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    return parents.map((parent) => ({
      parent,
      subcategories: children.filter((c) => c.parentId === parent.id),
    }));
  }, [values]);

  const legacyDeactivatedValues = useMemo(
    () => values.filter((v) => v.listKey === 'matter_party_role'),
    [values],
  );

  // ---------------- Relationships handlers ----------------
  function startEditRelationship(rel: MatterPartyRelationshipDef) {
    setEditingRelCode(rel.code);
    setEditRelLabel(rel.label);
    setEditRelDesc(rel.description);
  }

  function handleSaveRelationshipEdit(code: string) {
    if (!editRelLabel.trim()) {
      showToast('Relationship label is required');
      return;
    }
    startTransition(async () => {
      const res = await saveMatterPartyRelationshipAction({
        code,
        label: editRelLabel.trim(),
        description: editRelDesc.trim(),
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setTaxonomy(res.taxonomy);
      setEditingRelCode(null);
      showToast(`Updated relationship ${code}`);
    });
  }

  function handleToggleRelationshipActive(rel: MatterPartyRelationshipDef) {
    startTransition(async () => {
      const res = await saveMatterPartyRelationshipAction({
        code: rel.code,
        label: rel.label,
        description: rel.description,
        active: !rel.active,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setTaxonomy(res.taxonomy);
      showToast(
        `${rel.code} (${rel.label}) ${!rel.active ? 'activated' : 'deactivated'}`,
      );
    });
  }

  function handleReorderRelationship(code: string, direction: -1 | 1) {
    startTransition(async () => {
      const res = await reorderMatterPartyRelationshipAction(code, direction);
      setTaxonomy(res.taxonomy);
    });
  }

  function handleDeleteRelationship(rel: MatterPartyRelationshipDef) {
    const used = usageCounts.byRelationshipCode[rel.code] ?? 0;
    if (used > 0) {
      showToast(
        `Cannot delete "${rel.code}" (${rel.label}): used on ${used} matter party record(s). Deactivate it instead.`,
      );
      return;
    }
    startTransition(async () => {
      const res = await deleteMatterPartyRelationshipAction(rel.code);
      if (res.error) {
        showToast(res.error);
        return;
      }
      setTaxonomy(res.taxonomy);
      showToast(`Deleted relationship ${rel.code}`);
    });
  }

  function handleCreateRelationship(e: React.FormEvent) {
    e.preventDefault();
    const code = newRelCode.trim().toUpperCase();
    const label = newRelLabel.trim();
    if (!code || !label) {
      showToast('Code and label are required');
      return;
    }
    startTransition(async () => {
      const res = await saveMatterPartyRelationshipAction({
        code,
        label,
        description: newRelDesc.trim(),
        active: true,
        isNew: true,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setTaxonomy(res.taxonomy);
      setNewRelCode('');
      setNewRelLabel('');
      setNewRelDesc('');
      setAddRelOpen(false);
      showToast(`Added relationship ${code} — ${label}`);
    });
  }

  // ---------------- Capacities handlers ----------------
  function handleToggleCapacityRelationship(cap: MatterPartyCapacityDef, relCode: string) {
    const has = cap.allowedRelationships.includes(relCode);
    const nextRels = has
      ? cap.allowedRelationships.filter((r) => r !== relCode)
      : [...cap.allowedRelationships, relCode];
    // Optimistic update
    setTaxonomy((prev) => ({
      ...prev,
      capacities: prev.capacities.map((c) =>
        c.code === cap.code ? { ...c, allowedRelationships: nextRels } : c,
      ),
    }));
    startTransition(async () => {
      const res = await saveMatterPartyCapacityAction({
        code: cap.code,
        label: cap.label,
        group: cap.group,
        description: cap.description,
        allowedRelationships: nextRels,
        profiles: cap.profiles,
        active: cap.active,
      });
      if (res.error) {
        showToast(res.error);
      } else {
        setTaxonomy(res.taxonomy);
      }
    });
  }

  function handleToggleCapacityProfile(cap: MatterPartyCapacityDef, profileCode: WorkTypeProfileCode) {
    const has = cap.profiles.includes(profileCode);
    let nextProfiles: WorkTypeProfileCode[];
    if (profileCode === 'ALL') {
      nextProfiles = has ? ['LIT'] : ['ALL'];
    } else {
      const withoutAll = cap.profiles.filter((p) => p !== 'ALL');
      nextProfiles = has
        ? withoutAll.filter((p) => p !== profileCode)
        : [...withoutAll, profileCode];
      if (nextProfiles.length === 0) nextProfiles = ['ALL'];
    }
    setTaxonomy((prev) => ({
      ...prev,
      capacities: prev.capacities.map((c) =>
        c.code === cap.code ? { ...c, profiles: nextProfiles } : c,
      ),
    }));
    startTransition(async () => {
      const res = await saveMatterPartyCapacityAction({
        code: cap.code,
        label: cap.label,
        group: cap.group,
        description: cap.description,
        allowedRelationships: cap.allowedRelationships,
        profiles: nextProfiles,
        active: cap.active,
      });
      if (res.error) {
        showToast(res.error);
      } else {
        setTaxonomy(res.taxonomy);
      }
    });
  }

  function startEditCapacity(cap: MatterPartyCapacityDef) {
    setEditingCapCode(cap.code);
    setEditCapLabel(cap.label);
    setEditCapGroup(cap.group);
    setEditCapDesc(cap.description ?? '');
  }

  function handleSaveCapacityEdit(cap: MatterPartyCapacityDef) {
    if (!editCapLabel.trim()) {
      showToast('Capacity label is required');
      return;
    }
    startTransition(async () => {
      const res = await saveMatterPartyCapacityAction({
        code: cap.code,
        label: editCapLabel.trim(),
        group: editCapGroup,
        description: editCapDesc.trim(),
        allowedRelationships: cap.allowedRelationships,
        profiles: cap.profiles,
        active: cap.active,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setTaxonomy(res.taxonomy);
      setEditingCapCode(null);
      showToast(`Updated capacity ${cap.label}`);
    });
  }

  function handleToggleCapacityActive(cap: MatterPartyCapacityDef) {
    startTransition(async () => {
      const res = await saveMatterPartyCapacityAction({
        code: cap.code,
        label: cap.label,
        group: cap.group,
        description: cap.description,
        allowedRelationships: cap.allowedRelationships,
        profiles: cap.profiles,
        active: !cap.active,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setTaxonomy(res.taxonomy);
      showToast(
        `${cap.label} ${!cap.active ? 'activated' : 'deactivated'}`,
      );
    });
  }

  function handleDeleteCapacity(cap: MatterPartyCapacityDef) {
    const used = usageCounts.byCapacityCode[cap.code] ?? 0;
    if (used > 0) {
      showToast(
        `Cannot delete "${cap.label}": used on ${used} matter party record(s). Deactivate it instead.`,
      );
      return;
    }
    startTransition(async () => {
      const res = await deleteMatterPartyCapacityAction(cap.code);
      if (res.error) {
        showToast(res.error);
        return;
      }
      setTaxonomy(res.taxonomy);
      showToast(`Deleted capacity ${cap.label}`);
    });
  }

  function handleCreateCapacity(e: React.FormEvent) {
    e.preventDefault();
    const label = newCapLabel.trim();
    const code = (
      newCapCode.trim() ||
      `CAP_${label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`
    ).toUpperCase();
    if (!code || !label) {
      showToast('Code and label are required');
      return;
    }
    if (newCapRels.length === 0) {
      showToast('Select at least one allowed relationship');
      return;
    }
    if (newCapProfiles.length === 0) {
      showToast('Select at least one work type profile');
      return;
    }
    startTransition(async () => {
      const res = await saveMatterPartyCapacityAction({
        code,
        label,
        group: newCapGroup,
        description: newCapDesc.trim(),
        allowedRelationships: newCapRels,
        profiles: newCapProfiles,
        active: true,
        isNew: true,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setTaxonomy(res.taxonomy);
      setNewCapCode('');
      setNewCapLabel('');
      setNewCapDesc('');
      setAddCapOpen(false);
      showToast(`Added capacity ${label} (${code})`);
    });
  }

  // ---------------- Work type profile matrix handler ----------------
  function handleToggleWorkTypeProfile(
    workTypeSubcategoryId: string,
    profileCode: WorkTypeProfileCode,
  ) {
    const current = getProfilesForWorkType(taxonomy, workTypeSubcategoryId);
    const has = current.includes(profileCode);
    const next = has
      ? current.filter((p) => p !== profileCode)
      : [...current, profileCode];
    setTaxonomy((prev) => ({
      ...prev,
      workTypeProfiles: {
        ...prev.workTypeProfiles,
        [workTypeSubcategoryId]: next,
      },
    }));
    startTransition(async () => {
      const res = await updateWorkTypeProfilesAction(workTypeSubcategoryId, next);
      setTaxonomy(res.taxonomy);
    });
  }

  // Filtered capacities grouped by group
  const groupedCapacities = useMemo(() => {
    const q = capSearch.trim().toLowerCase();
    const allGroups = Array.from(
      new Set([...CAPACITY_GROUPS, ...taxonomy.capacities.map((c) => c.group)]),
    );
    return allGroups
      .filter((grp) => capGroupFilter === 'ALL_GROUPS' || grp === capGroupFilter)
      .map((grp) => {
        const items = taxonomy.capacities
          .filter((c) => c.group === grp)
          .filter((c) => {
            if (!q) return true;
            return (
              c.label.toLowerCase().includes(q) ||
              c.code.toLowerCase().includes(q) ||
              (c.description ?? '').toLowerCase().includes(q) ||
              c.group.toLowerCase().includes(q)
            );
          })
          .sort((a, b) => a.sortOrder - b.sortOrder);
        return { group: grp, items };
      })
      .filter((g) => g.items.length > 0);
  }, [taxonomy.capacities, capSearch, capGroupFilter]);

  return (
    <div>
      <div className="list-section__header" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700 }}>Matter Parties</h2>
          <p className="muted" style={{ marginTop: 4 }}>
            Two-field matter party model: <strong>Relationship</strong> (whose side the party is on,
            driving conflict outcomes) and <strong>Capacity</strong> (what the party is in the
            matter, filtered by work type profile).
          </p>
          <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
            <strong>Rules:</strong> Codes are immutable · Items in use on any matter can be
            deactivated but not deleted · Deactivated items stay visible on existing matters but are
            not offered for new entries.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {migrationReport ? (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setShowMigrationReport((v) => !v)}
            >
              {showMigrationReport ? 'Hide migration report' : 'View migration report'}
            </button>
          ) : null}
          {subTab === 'relationships' ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setAddRelOpen(true)}
            >
              + Add relationship
            </button>
          ) : null}
          {subTab === 'capacities' ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setAddCapOpen(true)}
            >
              + Add capacity
            </button>
          ) : null}
        </div>
      </div>

      {/* Optional Migration Report Banner */}
      {showMigrationReport && migrationReport ? (
        <div
          className="card"
          style={{
            marginTop: 14,
            padding: '14px 16px',
            background: '#f8fafc',
            border: '1px solid var(--color-border)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 10,
            }}
          >
            <div>
              <strong style={{ fontSize: 14 }}>
                Legacy Third-Party Roles Migration Report
              </strong>
              <div className="muted" style={{ fontSize: 12 }}>
                {legacyDeactivatedValues.length} legacy flat roles marked inactive (preserved, not
                hard-deleted) · {migrationReport.migratedMatterPartiesCount} matter party links
                migrated
              </div>
            </div>
            <StatusPill label="Migrated & Inactive" tone="neutral" />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Existing legacy role</th>
                  <th>Mapped Relationship</th>
                  <th>Mapped Capacity</th>
                  <th>Legacy list status</th>
                  <th style={{ textAlign: 'right' }}>Migrated matter records</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(migrationReport.countsByMapping).map((row) => (
                  <tr key={row.legacyRole}>
                    <td>
                      <strong>{row.legacyRole}</strong>
                    </td>
                    <td>
                      <code>{row.relationshipCode}</code>
                    </td>
                    <td>{row.capacityLabel}</td>
                    <td>
                      <StatusPill label="Inactive" tone="neutral" />
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Three Tabs */}
      <div
        role="tablist"
        aria-label="Matter Parties taxonomy tabs"
        style={{
          display: 'flex',
          gap: 6,
          marginTop: 16,
          borderBottom: '1px solid var(--color-divider)',
          paddingBottom: 8,
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'relationships'}
          className={`btn btn--sm ${
            subTab === 'relationships' ? 'btn--primary' : 'btn--ghost'
          }`}
          onClick={() => setSubTab('relationships')}
        >
          1. Relationships ({taxonomy.relationships.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'capacities'}
          className={`btn btn--sm ${
            subTab === 'capacities' ? 'btn--primary' : 'btn--ghost'
          }`}
          onClick={() => setSubTab('capacities')}
        >
          2. Capacities ({taxonomy.capacities.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'work_type_profiles'}
          className={`btn btn--sm ${
            subTab === 'work_type_profiles' ? 'btn--primary' : 'btn--ghost'
          }`}
          onClick={() => setSubTab('work_type_profiles')}
        >
          3. Work type profiles ({WORK_TYPE_PROFILES.length - 1} profiles)
        </button>
      </div>

      {/* TAB 1: RELATIONSHIPS */}
      {subTab === 'relationships' ? (
        <div style={{ marginTop: 16 }}>
          {addRelOpen ? (
            <form
              onSubmit={handleCreateRelationship}
              className="card"
              style={{ marginBottom: 16, padding: 16 }}
            >
              <div style={{ fontWeight: 700, marginBottom: 10 }}>Add Relationship</div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '140px 1fr 2fr',
                  gap: 10,
                  alignItems: 'end',
                }}
              >
                <div>
                  <label className="field-label">Code (immutable) *</label>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="e.g. GR"
                    maxLength={6}
                    value={newRelCode}
                    onChange={(e) => setNewRelCode(e.target.value.toUpperCase())}
                    required
                  />
                </div>
                <div>
                  <label className="field-label">Label *</label>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="e.g. Group entity"
                    value={newRelLabel}
                    onChange={(e) => setNewRelLabel(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="field-label">Description</label>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="Whose side the party is on…"
                    value={newRelDesc}
                    onChange={(e) => setNewRelDesc(e.target.value)}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button type="submit" className="btn btn--primary btn--sm" disabled={pending}>
                  Save relationship
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => setAddRelOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Code</th>
                  <th style={{ width: 210 }}>Label</th>
                  <th>Description</th>
                  <th style={{ width: 110, textAlign: 'center' }}>Matters using</th>
                  <th style={{ width: 100 }}>Status</th>
                  <th style={{ width: 240, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedRelationships.map((rel, idx) => {
                  const isEditing = editingRelCode === rel.code;
                  const usedCount = usageCounts.byRelationshipCode[rel.code] ?? 0;
                  return (
                    <tr
                      key={rel.code}
                      style={{ opacity: rel.active ? 1 : 0.6 }}
                    >
                      <td>
                        <code
                          style={{
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 4,
                            background: 'var(--bg-subtle, #f1f5f9)',
                          }}
                          title="Code is immutable"
                        >
                          {rel.code}
                        </code>
                      </td>
                      <td>
                        {isEditing ? (
                          <input
                            type="text"
                            className="field-input"
                            value={editRelLabel}
                            onChange={(e) => setEditRelLabel(e.target.value)}
                          />
                        ) : (
                          <strong>{rel.label}</strong>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <input
                            type="text"
                            className="field-input"
                            value={editRelDesc}
                            onChange={(e) => setEditRelDesc(e.target.value)}
                          />
                        ) : (
                          <span className="muted">{rel.description}</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span
                          className="admin-group-toggle__count"
                          title={
                            usedCount > 0
                              ? `Used on ${usedCount} matter party record(s); can be deactivated but not deleted`
                              : 'Not currently used on any matter'
                          }
                        >
                          {usedCount}
                        </span>
                      </td>
                      <td>
                        <StatusPill
                          label={rel.active ? 'Active' : 'Inactive'}
                          tone={rel.active ? 'positive' : 'neutral'}
                        />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {isEditing ? (
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              disabled={pending}
                              onClick={() => handleSaveRelationshipEdit(rel.code)}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              onClick={() => setEditingRelCode(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={idx === 0 || pending}
                              title="Move up"
                              onClick={() => handleReorderRelationship(rel.code, -1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={idx === sortedRelationships.length - 1 || pending}
                              title="Move down"
                              onClick={() => handleReorderRelationship(rel.code, 1)}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              onClick={() => startEditRelationship(rel)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              onClick={() => handleToggleRelationshipActive(rel)}
                            >
                              {rel.active ? 'Deactivate' : 'Activate'}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={usedCount > 0}
                              title={
                                usedCount > 0
                                  ? `In use on ${usedCount} matter record(s) — deactivate instead`
                                  : 'Delete relationship'
                              }
                              onClick={() => handleDeleteRelationship(rel)}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* TAB 2: CAPACITIES */}
      {subTab === 'capacities' ? (
        <div style={{ marginTop: 16 }}>
          {addCapOpen ? (
            <form
              onSubmit={handleCreateCapacity}
              className="card"
              style={{ marginBottom: 16, padding: 16 }}
            >
              <div style={{ fontWeight: 700, marginBottom: 10 }}>Add Capacity</div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '180px 1fr 220px 1fr',
                  gap: 10,
                  alignItems: 'end',
                }}
              >
                <div>
                  <label className="field-label">Code (immutable)</label>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="Auto from label if blank"
                    value={newCapCode}
                    onChange={(e) => setNewCapCode(e.target.value.toUpperCase())}
                  />
                </div>
                <div>
                  <label className="field-label">Label *</label>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="e.g. Planning consultant"
                    value={newCapLabel}
                    onChange={(e) => setNewCapLabel(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="field-label">Group *</label>
                  <select
                    className="field-input"
                    value={newCapGroup}
                    onChange={(e) => setNewCapGroup(e.target.value)}
                  >
                    {CAPACITY_GROUPS.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label">Description (optional)</label>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="Optional note…"
                    value={newCapDesc}
                    onChange={(e) => setNewCapDesc(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <label className="field-label">Allowed relationships *</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
                  {sortedRelationships.map((rel) => {
                    const checked = newCapRels.includes(rel.code);
                    return (
                      <label
                        key={rel.code}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setNewCapRels((prev) =>
                              checked ? prev.filter((x) => x !== rel.code) : [...prev, rel.code],
                            )
                          }
                        />
                        <span>
                          <strong>{rel.code}</strong> ({rel.label})
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <label className="field-label">Work type profiles *</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
                  {WORK_TYPE_PROFILES.map((prof) => {
                    const checked = newCapProfiles.includes(prof.code);
                    return (
                      <label
                        key={prof.code}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                        title={prof.covers}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setNewCapProfiles((prev) =>
                              checked
                                ? prev.filter((x) => x !== prof.code)
                                : [...prev, prof.code],
                            )
                          }
                        />
                        <span>
                          <strong>{prof.code}</strong>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button type="submit" className="btn btn--primary btn--sm" disabled={pending}>
                  Save capacity
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => setAddCapOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              marginBottom: 14,
              flexWrap: 'wrap',
            }}
          >
            <input
              type="search"
              className="field-input"
              style={{ maxWidth: 340 }}
              placeholder="Search capacities by label, code or group…"
              value={capSearch}
              onChange={(e) => setCapSearch(e.target.value)}
            />
            <select
              className="field-input"
              style={{ maxWidth: 280 }}
              aria-label="Filter by capacity group"
              value={capGroupFilter}
              onChange={(e) => setCapGroupFilter(e.target.value)}
            >
              <option value="ALL_GROUPS">All groups ({CAPACITY_GROUPS.length})</option>
              {CAPACITY_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            {capSearch || capGroupFilter !== 'ALL_GROUPS' ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setCapSearch('');
                  setCapGroupFilter('ALL_GROUPS');
                }}
              >
                Clear filters
              </button>
            ) : null}
          </div>

          {groupedCapacities.map(({ group, items }) => (
            <div key={group} className="card" style={{ marginBottom: 16, padding: '14px 16px' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 10,
                }}
              >
                <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{group}</h3>
                <span className="admin-group-toggle__count">
                  {items.length} capacit{items.length === 1 ? 'y' : 'ies'}
                </span>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table className="data-table" style={{ fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 220 }}>Capacity &amp; code</th>
                      <th>Allowed relationships</th>
                      <th>Work type profiles</th>
                      <th style={{ width: 70, textAlign: 'center' }}>Used</th>
                      <th style={{ width: 85 }}>Status</th>
                      <th style={{ width: 150, textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((cap) => {
                      const isEditing = editingCapCode === cap.code;
                      const usedCount = usageCounts.byCapacityCode[cap.code] ?? 0;
                      return (
                        <tr
                          key={cap.code}
                          style={{ opacity: cap.active ? 1 : 0.58 }}
                        >
                          <td>
                            {isEditing ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                <input
                                  type="text"
                                  className="field-input"
                                  value={editCapLabel}
                                  onChange={(e) => setEditCapLabel(e.target.value)}
                                />
                                <select
                                  className="field-input"
                                  value={editCapGroup}
                                  onChange={(e) => setEditCapGroup(e.target.value)}
                                >
                                  {CAPACITY_GROUPS.map((g) => (
                                    <option key={g} value={g}>
                                      {g}
                                    </option>
                                  ))}
                                </select>
                                <input
                                  type="text"
                                  className="field-input"
                                  placeholder="Description (optional)"
                                  value={editCapDesc}
                                  onChange={(e) => setEditCapDesc(e.target.value)}
                                />
                              </div>
                            ) : (
                              <div>
                                <div style={{ fontWeight: 600 }}>{cap.label}</div>
                                <div className="muted" style={{ fontSize: 11 }}>
                                  <code>{cap.code}</code>
                                  {cap.description ? ` · ${cap.description}` : ''}
                                </div>
                              </div>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {sortedRelationships.map((rel) => {
                                const checked = cap.allowedRelationships.includes(rel.code);
                                return (
                                  <label
                                    key={rel.code}
                                    title={`${rel.code}: ${rel.label}`}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 3,
                                      padding: '2px 5px',
                                      borderRadius: 4,
                                      background: checked ? '#eff6ff' : 'transparent',
                                      border: checked
                                        ? '1px solid #bfdbfe'
                                        : '1px solid transparent',
                                      fontSize: 11.5,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() =>
                                        handleToggleCapacityRelationship(cap, rel.code)
                                      }
                                    />
                                    <span>{rel.code}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {WORK_TYPE_PROFILES.map((prof) => {
                                const checked = cap.profiles.includes(prof.code);
                                return (
                                  <label
                                    key={prof.code}
                                    title={`${prof.code}: ${prof.covers}`}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 3,
                                      padding: '2px 5px',
                                      borderRadius: 4,
                                      background: checked
                                        ? prof.code === 'ALL'
                                          ? '#ecfdf5'
                                          : '#f0f9ff'
                                        : 'transparent',
                                      border: checked
                                        ? '1px solid #bae6fd'
                                        : '1px solid transparent',
                                      fontSize: 11.5,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() =>
                                        handleToggleCapacityProfile(cap, prof.code)
                                      }
                                    />
                                    <span>{prof.code}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <span className="admin-group-toggle__count">{usedCount}</span>
                          </td>
                          <td>
                            <StatusPill
                              label={cap.active ? 'Active' : 'Inactive'}
                              tone={cap.active ? 'positive' : 'neutral'}
                            />
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {isEditing ? (
                              <div style={{ display: 'inline-flex', gap: 4 }}>
                                <button
                                  type="button"
                                  className="btn btn--primary btn--sm"
                                  onClick={() => handleSaveCapacityEdit(cap)}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--secondary btn--sm"
                                  onClick={() => setEditingCapCode(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <div style={{ display: 'inline-flex', gap: 4 }}>
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  onClick={() => startEditCapacity(cap)}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  onClick={() => handleToggleCapacityActive(cap)}
                                >
                                  {cap.active ? 'Deactivate' : 'Activate'}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  disabled={usedCount > 0}
                                  title={
                                    usedCount > 0
                                      ? `In use on ${usedCount} matter party record(s) — deactivate instead`
                                      : 'Delete capacity'
                                  }
                                  onClick={() => handleDeleteCapacity(cap)}
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* TAB 3: WORK TYPE PROFILES MATRIX */}
      {subTab === 'work_type_profiles' ? (
        <div style={{ marginTop: 16 }}>
          <div
            className="card"
            style={{
              marginBottom: 14,
              padding: '12px 16px',
              background: '#f8fafc',
              fontSize: 12.5,
            }}
          >
            <strong>Profile key:</strong> Capacities in profile <code>ALL</code> are always offered
            on every work type. Toggle checkboxes below to control which domain profiles apply to
            each work type:
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: '4px 14px',
                marginTop: 8,
              }}
            >
              {WORK_TYPE_PROFILES.map((p) => (
                <div key={p.code}>
                  <code>{p.code}</code>: <span className="muted">{p.covers}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <input
              type="search"
              className="field-input"
              style={{ maxWidth: 360 }}
              placeholder="Search practice areas or work types…"
              value={matrixSearch}
              onChange={(e) => setMatrixSearch(e.target.value)}
            />
            {matrixSearch ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setMatrixSearch('')}
              >
                Clear
              </button>
            ) : null}
          </div>

          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={{ minWidth: 260 }}>Practice area &amp; Work type</th>
                  <th style={{ width: 65, textAlign: 'center' }} title="Every work type">
                    ALL
                  </th>
                  {MATRIX_PROFILES.map((profCode) => {
                    const def = WORK_TYPE_PROFILES.find((p) => p.code === profCode);
                    return (
                      <th
                        key={profCode}
                        style={{ width: 56, textAlign: 'center' }}
                        title={def?.covers}
                      >
                        {profCode}
                      </th>
                    );
                  })}
                  <th style={{ width: 85, textAlign: 'center' }}>Matters</th>
                </tr>
              </thead>
              <tbody>
                {workTypeTree.map(({ parent, subcategories }) => {
                  const q = matrixSearch.trim().toLowerCase();
                  const visibleSubs = subcategories.filter((sub) => {
                    if (!q) return true;
                    return (
                      sub.label.toLowerCase().includes(q) ||
                      parent.label.toLowerCase().includes(q)
                    );
                  });
                  if (visibleSubs.length === 0) return null;

                  return (
                    <React.Fragment key={parent.id}>
                      <tr style={{ background: 'var(--bg-subtle, #f8fafc)' }}>
                        <td
                          colSpan={MATRIX_PROFILES.length + 3}
                          style={{ fontWeight: 700, fontSize: 13 }}
                        >
                          {parent.label}
                        </td>
                      </tr>
                      {visibleSubs.map((sub) => {
                        const activeProfiles = getProfilesForWorkType(taxonomy, sub.id);
                        const usedMattersCount =
                          usageCounts.byWorkTypeSubcategoryId[sub.id] ?? 0;
                        return (
                          <tr key={sub.id}>
                            <td style={{ paddingLeft: 22 }}>
                              <div style={{ fontWeight: 500 }}>{sub.label}</div>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <input
                                type="checkbox"
                                checked
                                disabled
                                title="ALL profile capacities are always included"
                              />
                            </td>
                            {MATRIX_PROFILES.map((profCode) => {
                              const checked = activeProfiles.includes(profCode);
                              return (
                                <td key={profCode} style={{ textAlign: 'center' }}>
                                  <input
                                    type="checkbox"
                                    aria-label={`${sub.label} — ${profCode}`}
                                    checked={checked}
                                    onChange={() =>
                                      handleToggleWorkTypeProfile(sub.id, profCode)
                                    }
                                  />
                                </td>
                              );
                            })}
                            <td style={{ textAlign: 'center' }}>
                              <span className="admin-group-toggle__count">
                                {usedMattersCount}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
