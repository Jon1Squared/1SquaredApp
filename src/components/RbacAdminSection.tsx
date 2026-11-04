'use client';

import React, { useMemo, useState, useTransition } from 'react';
import {
  updatePersonPermissionOverridesAction,
  updateTenantRbacConfigAction,
} from '@/app/actions';
import { personDisplayName, primaryEmail } from '@/domain/names';
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_REGISTRY,
  type PermissionKey,
  type RbacConfiguration,
} from '@/domain/rbac';
import type { OrgStructureCatalogue, Person, Team } from '@/domain/types';
import type { EntraEnvStatus, EntraSessionPayload } from '@/server/entraAuth';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface RbacAdminSectionProps {
  currentUserId?: string;
  currentUserPermissions?: PermissionKey[];
  permissionsByPersonId?: Record<string, PermissionKey[]>;
  rbacConfig: RbacConfiguration;
  people: Person[];
  teams: Team[];
  orgStructure: OrgStructureCatalogue;
  entraSession?: EntraSessionPayload | null;
  entraEnvStatus?: EntraEnvStatus;
  authError?: string;
  authSuccess?: boolean;
}

type SubTab = 'matrix' | 'departments' | 'entra' | 'overrides';

export function RbacAdminSection({
  currentUserId = 'P-000001',
  currentUserPermissions = [],
  permissionsByPersonId,
  rbacConfig: rbacConfigProp,
  people,
  teams: _teams,
  orgStructure,
  entraSession = null,
  entraEnvStatus,
  authError,
  authSuccess,
}: RbacAdminSectionProps) {
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [subTab, setSubTab] = useState<SubTab>('matrix');

  const [localRbac, setLocalRbac] = useState<RbacConfiguration>(rbacConfigProp);

  const employees = useMemo(
    () =>
      people
        .filter((p) => p.isEmployee && !p.mergedIntoId && !p.demo)
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b))),
    [people],
  );

  const actorPerms = useMemo(
    () => new Set<PermissionKey>(currentUserPermissions),
    [currentUserPermissions],
  );

  const canManageConfig = actorPerms.has('rbac:manage_config');
  const canManageOverrides = actorPerms.has('rbac:manage_user_overrides');

  // Role Matrix state
  const roleKeys = useMemo(() => Object.keys(localRbac.roles), [localRbac.roles]);
  const [selectedRoleKey, setSelectedRoleKey] = useState<string>(
    roleKeys[0] ?? 'partner',
  );

  // Department grants state
  const [selectedDeptId, setSelectedDeptId] = useState<string>(
    orgStructure.departments[0]?.id ?? 'DEPT-HR',
  );

  // Entra ID new group mapping state
  const [newEntraGroupId, setNewEntraGroupId] = useState('');
  const [newEntraGroupRole, setNewEntraGroupRole] = useState('fee_earner');
  const [newEntraAppRole, setNewEntraAppRole] = useState('');
  const [newEntraAppRoleTarget, setNewEntraAppRoleTarget] = useState('fee_earner');

  // Per-person overrides state
  const defaultTargetEmployee = useMemo(
    () => employees.find((e) => e.id !== currentUserId) ?? employees[0] ?? null,
    [employees, currentUserId],
  );
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>(
    defaultTargetEmployee?.id ?? '',
  );

  const selectedEmployee = useMemo(
    () => employees.find((e) => e.id === selectedEmployeeId) ?? null,
    [employees, selectedEmployeeId],
  );

  const [overrideGrant, setOverrideGrant] = useState<PermissionKey[]>(
    () => selectedEmployee?.permissionOverrides?.grant ?? [],
  );
  const [overrideRevoke, setOverrideRevoke] = useState<PermissionKey[]>(
    () => selectedEmployee?.permissionOverrides?.revoke ?? [],
  );
  const [overrideReason, setOverrideReason] = useState<string>(
    () => selectedEmployee?.permissionOverrides?.reason ?? '',
  );
  const [entraObjectIdInput, setEntraObjectIdInput] = useState<string>(
    () => selectedEmployee?.entraObjectId ?? '',
  );

  const handleSelectEmployee = (empId: string) => {
    setSelectedEmployeeId(empId);
    const emp = employees.find((e) => e.id === empId);
    setOverrideGrant([...(emp?.permissionOverrides?.grant ?? [])]);
    setOverrideRevoke([...(emp?.permissionOverrides?.revoke ?? [])]);
    setOverrideReason(emp?.permissionOverrides?.reason ?? '');
    setEntraObjectIdInput(emp?.entraObjectId ?? '');
  };

  const toggleRolePermission = (roleKey: string, perm: PermissionKey) => {
    setLocalRbac((prev) => {
      const roleDef = prev.roles[roleKey];
      if (!roleDef) return prev;
      const has = roleDef.permissions.includes(perm);
      const nextPerms = has
        ? roleDef.permissions.filter((p) => p !== perm)
        : [...roleDef.permissions, perm];
      return {
        ...prev,
        roles: {
          ...prev.roles,
          [roleKey]: {
            ...roleDef,
            permissions: nextPerms,
          },
        },
      };
    });
  };

  const toggleDeptPermission = (deptId: string, perm: PermissionKey) => {
    setLocalRbac((prev) => {
      const current = prev.departmentGrants[deptId] ?? [];
      const has = current.includes(perm);
      const nextPerms = has
        ? current.filter((p) => p !== perm)
        : [...current, perm];
      return {
        ...prev,
        departmentGrants: {
          ...prev.departmentGrants,
          [deptId]: nextPerms,
        },
      };
    });
  };

  const handleSaveRbacConfig = () => {
    startTransition(async () => {
      const res = await updateTenantRbacConfigAction(localRbac);
      if (!res.ok) {
        showToast(res.error ?? 'Failed to update RBAC configuration');
        return;
      }
      if (res.rbacConfig) {
        setLocalRbac(res.rbacConfig);
      }
      showToast('Tenant RBAC & Entra ID configuration saved and audited');
    });
  };

  const handleAddEntraGroupMapping = () => {
    const trimmed = newEntraGroupId.trim();
    if (!trimmed) return;
    setLocalRbac((prev) => ({
      ...prev,
      identityMapping: {
        ...prev.identityMapping,
        entraGroupToRoleKey: {
          ...prev.identityMapping.entraGroupToRoleKey,
          [trimmed]: Array.from(
            new Set([
              ...(prev.identityMapping.entraGroupToRoleKey[trimmed] ?? []),
              newEntraGroupRole,
            ]),
          ),
        },
      },
    }));
    setNewEntraGroupId('');
  };

  const handleRemoveEntraGroupMapping = (groupId: string) => {
    setLocalRbac((prev) => {
      const next = { ...prev.identityMapping.entraGroupToRoleKey };
      delete next[groupId];
      return {
        ...prev,
        identityMapping: {
          ...prev.identityMapping,
          entraGroupToRoleKey: next,
        },
      };
    });
  };

  const handleAddEntraAppRoleMapping = () => {
    const trimmed = newEntraAppRole.trim();
    if (!trimmed) return;
    setLocalRbac((prev) => ({
      ...prev,
      identityMapping: {
        ...prev.identityMapping,
        entraAppRoleToRoleKey: {
          ...prev.identityMapping.entraAppRoleToRoleKey,
          [trimmed]: Array.from(
            new Set([
              ...(prev.identityMapping.entraAppRoleToRoleKey[trimmed] ?? []),
              newEntraAppRoleTarget,
            ]),
          ),
        },
      },
    }));
    setNewEntraAppRole('');
  };

  const handleSavePersonOverrides = () => {
    if (!selectedEmployee) return;
    startTransition(async () => {
      const res = await updatePersonPermissionOverridesAction(
        selectedEmployee.id,
        {
          grant: overrideGrant,
          revoke: overrideRevoke,
          reason: overrideReason,
          entraObjectId: entraObjectIdInput.trim() || null,
        },
      );
      if (!res.ok) {
        showToast(res.error ?? 'Failed to save permission overrides');
        return;
      }
      showToast(
        `Permission overrides & Entra binding saved for ${personDisplayName(selectedEmployee)}`,
      );
    });
  };

  const selectedEmployeeEffectivePermissions = useMemo(() => {
    if (!selectedEmployee) return new Set<PermissionKey>();
    const baseline = new Set<PermissionKey>(
      permissionsByPersonId?.[selectedEmployee.id] ?? [],
    );
    for (const oldGrant of selectedEmployee.permissionOverrides?.grant ?? []) {
      baseline.delete(oldGrant);
    }
    for (const roleKey of selectedEmployee.roles ?? []) {
      for (const perm of localRbac.roles[roleKey]?.permissions ?? []) {
        baseline.add(perm);
      }
    }
    const deptId =
      selectedEmployee.employment?.departmentId ?? selectedEmployee.departmentId;
    if (deptId) {
      for (const perm of localRbac.departmentGrants[deptId] ?? []) {
        baseline.add(perm);
      }
    }
    for (const g of overrideGrant) baseline.add(g);
    for (const r of overrideRevoke) baseline.delete(r);
    return baseline;
  }, [
    selectedEmployee,
    permissionsByPersonId,
    overrideGrant,
    overrideRevoke,
    localRbac,
  ]);

  const isSelfSelected = selectedEmployee?.id === currentUserId;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ padding: 16 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>
              Central RBAC &amp; 1Squared Entra ID Federation
            </h2>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              Single permission registry ({ALL_PERMISSION_KEYS.length} permissions),
              schema-validated role &amp; department grants, Microsoft Entra ID OIDC
              claim mapping, and MFA-gated per-person overrides.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn btn--sm ${subTab === 'matrix' ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setSubTab('matrix')}
            >
              1. Role &amp; Permission Matrix ({roleKeys.length})
            </button>
            <button
              type="button"
              className={`btn btn--sm ${subTab === 'departments' ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setSubTab('departments')}
            >
              2. Department &amp; Relationship Grants
            </button>
            <button
              type="button"
              className={`btn btn--sm ${subTab === 'entra' ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setSubTab('entra')}
            >
              3. 1Squared Entra ID Mapping
            </button>
            <button
              type="button"
              className={`btn btn--sm ${subTab === 'overrides' ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setSubTab('overrides')}
            >
              4. Per-Employee Overrides
            </button>
          </div>
        </div>
      </div>

      {/* LIVE MICROSOFT ENTRA ID CONNECTION & ACTIVE SESSION CARD */}
      <div
        className="card"
        style={{
          padding: 16,
          borderLeft: `4px solid ${
            authError
              ? '#dc2626'
              : entraSession
                ? '#16a34a'
                : entraEnvStatus?.configured
                  ? '#0D5C63'
                  : '#d97706'
          }`,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>
                Microsoft Entra ID OIDC Federation Status
              </h3>
              {entraSession ? (
                <StatusPill
                  label={
                    entraSession.mfaVerified
                      ? 'Authenticated · MFA Verified'
                      : 'Authenticated · Standard'
                  }
                  tone="positive"
                />
              ) : entraEnvStatus?.configured ? (
                <StatusPill label="Ready (.env.local configured)" tone="neutral" />
              ) : (
                <StatusPill label="Awaiting .env.local credentials" tone="warning" />
              )}
            </div>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
              {entraEnvStatus?.clientId ? (
                <>
                  App ID: <code>{entraEnvStatus.clientId}</code>
                  {entraEnvStatus.tenantId ? (
                    <>
                      {' '}
                      · Tenant ID: <code>{entraEnvStatus.tenantId}</code>
                    </>
                  ) : null}{' '}
                  · Callback: <code>{entraEnvStatus.redirectUri}</code>
                </>
              ) : (
                <>
                  Configure <code>ENTRA_CLIENT_ID</code>, <code>ENTRA_TENANT_ID</code>, and{' '}
                  <code>ENTRA_CLIENT_SECRET</code> in <code>.env.local</code>.
                </>
              )}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <a
              href="/api/auth/login?returnTo=/admin/rbac-and-entra"
              className="btn btn--primary btn--sm"
              style={{ textDecoration: 'none' }}
            >
              {entraSession
                ? 'Re-authenticate with Microsoft Entra ID'
                : 'Sign in with Microsoft Entra ID'}
            </a>
            {entraSession ? (
              <a
                href="/api/auth/logout"
                className="btn btn--ghost btn--sm"
                style={{ textDecoration: 'none' }}
              >
                Sign out
              </a>
            ) : null}
          </div>
        </div>

        {authError ? (
          <div
            role="alert"
            style={{
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 6,
              background: 'rgba(220, 38, 38, 0.08)',
              border: '1px solid rgba(220, 38, 38, 0.25)',
              color: '#b91c1c',
              fontSize: 13,
            }}
          >
            <strong>Entra ID Sign-In Error:</strong> {authError}
          </div>
        ) : null}

        {authSuccess && entraSession ? (
          <div
            role="status"
            style={{
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 6,
              background: 'rgba(22, 163, 74, 0.08)',
              border: '1px solid rgba(22, 163, 74, 0.25)',
              color: '#15803d',
              fontSize: 13,
            }}
          >
            Successfully signed in via Microsoft Entra ID as{' '}
            <strong>{entraSession.displayName}</strong> ({entraSession.email}) and linked to
            employee record <code>{entraSession.personId}</code>.
          </div>
        ) : null}

        {entraSession ? (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 6,
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border-subtle)',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
              gap: 10,
              fontSize: 12.5,
            }}
          >
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                Signed-in Entra Identity
              </div>
              <div style={{ fontWeight: 600 }}>
                {entraSession.displayName}{' '}
                {entraSession.email ? `(${entraSession.email})` : ''}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                Entra Object ID (oid)
              </div>
              <code>{entraSession.oid}</code>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                Token App Roles (roles claim)
              </div>
              <div>
                {entraSession.entraRoles.length > 0 ? (
                  entraSession.entraRoles.map((r) => (
                    <code key={r} style={{ marginRight: 6 }}>
                      {r}
                    </code>
                  ))
                ) : (
                  <span className="muted">None emitted</span>
                )}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                Mapped 1Squared Roles
              </div>
              <div>
                {entraSession.mappedRoles.length > 0 ? (
                  entraSession.mappedRoles.map((r) => (
                    <code key={r} style={{ marginRight: 6 }}>
                      {r}
                    </code>
                  ))
                ) : (
                  <span className="muted">None</span>
                )}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                MFA Claim (amr)
              </div>
              <div>
                <code>
                  {entraSession.amr.length > 0
                    ? entraSession.amr.join(', ')
                    : entraSession.mfaVerified
                      ? 'verified'
                      : 'none'}
                </code>
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                Linked 1Squared Employee
              </div>
              <code>{entraSession.personId}</code>
            </div>
          </div>
        ) : null}
      </div>

      {/* SUB-TAB 1: ROLE & PERMISSION MATRIX */}
      {subTab === 'matrix' && (
        <div className="card" style={{ padding: 16 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              marginBottom: 14,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ fontWeight: 600, fontSize: 13 }}>
                Inspect / edit role:
              </label>
              <select
                className="field-input"
                value={selectedRoleKey}
                onChange={(e) => setSelectedRoleKey(e.target.value)}
                style={{ minWidth: 260 }}
              >
                {roleKeys.map((rk) => {
                  const r = localRbac.roles[rk];
                  return (
                    <option key={rk} value={rk}>
                      {r?.label ?? rk} ({rk}) — {r?.permissions.length ?? 0}{' '}
                      permissions
                    </option>
                  );
                })}
              </select>
            </div>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!canManageConfig || pending}
              title={
                !canManageConfig
                  ? 'Requires rbac:manage_config permission'
                  : undefined
              }
              onClick={handleSaveRbacConfig}
            >
              Save RBAC configuration
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr>
                  <th>Permission Key</th>
                  <th>Domain</th>
                  <th>Sensitivity</th>
                  <th>MFA Required</th>
                  <th>Description</th>
                  <th style={{ textAlign: 'center' }}>
                    Granted on <code>{selectedRoleKey}</code>
                  </th>
                </tr>
              </thead>
              <tbody>
                {ALL_PERMISSION_KEYS.map((permKey) => {
                  const entry = PERMISSION_REGISTRY[permKey];
                  const granted =
                    localRbac.roles[selectedRoleKey]?.permissions.includes(
                      permKey,
                    ) ?? false;
                  return (
                    <tr key={permKey}>
                      <td>
                        <code>{permKey}</code>
                      </td>
                      <td>{entry.domain}</td>
                      <td>
                        <StatusPill
                          label={entry.sensitivity}
                          tone={
                            entry.sensitivity === 'critical'
                              ? 'alert'
                              : entry.sensitivity === 'confidential' ||
                                  entry.sensitivity === 'restricted'
                                ? 'warning'
                                : 'neutral'
                          }
                        />
                      </td>
                      <td>
                        {entry.requiresMfa ? (
                          <StatusPill label="MFA required" tone="warning" />
                        ) : (
                          <span className="muted">Standard session</span>
                        )}
                      </td>
                      <td className="muted">{entry.description}</td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={granted}
                          disabled={!canManageConfig || pending}
                          onChange={() =>
                            toggleRolePermission(selectedRoleKey, permKey)
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB 2: DEPARTMENT & RELATIONSHIP GRANTS */}
      {subTab === 'departments' && (
        <div className="card" style={{ padding: 16 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 14,
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Department:</label>
              <select
                className="field-input"
                value={selectedDeptId}
                onChange={(e) => setSelectedDeptId(e.target.value)}
                style={{ minWidth: 260 }}
              >
                {orgStructure.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.id})
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!canManageConfig || pending}
              onClick={handleSaveRbacConfig}
            >
              Save Department Grants
            </button>
          </div>

          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Department grants replace hardcoded <code>DEPT-*</code> checks in
            domain code. Any employee assigned to <code>{selectedDeptId}</code>{' '}
            receives these additional permissions from tenant configuration:
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 8,
              marginBottom: 20,
            }}
          >
            {ALL_PERMISSION_KEYS.map((permKey) => {
              const checked = (
                localRbac.departmentGrants[selectedDeptId] ?? []
              ).includes(permKey);
              return (
                <label
                  key={permKey}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--border-subtle, #e2e8f0)',
                    fontSize: 12,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!canManageConfig || pending}
                    onChange={() =>
                      toggleDeptPermission(selectedDeptId, permKey)
                    }
                  />
                  <code>{permKey}</code>
                </label>
              );
            })}
          </div>

          <h3 style={{ fontSize: 15, margin: '12px 0 8px' }}>
            Configured Relationship Grant Rules (<code>rbac.relationshipGrants</code>)
          </h3>
          <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr>
                <th>Relationship Rule</th>
                <th>Granted Permissions</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {localRbac.relationshipGrants.map((rule) => (
                <tr key={rule.relationship}>
                  <td>
                    <code>{rule.relationship}</code>
                  </td>
                  <td>
                    {rule.permissions.map((p) => (
                      <code key={p} style={{ marginRight: 6 }}>
                        {p}
                      </code>
                    ))}
                  </td>
                  <td className="muted">{rule.description ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* SUB-TAB 3: 1SQUARED ENTRA ID IDENTITY MAPPING */}
      {subTab === 'entra' && (
        <div className="card" style={{ padding: 16 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 16,
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <div>
              <h3 style={{ margin: 0, fontSize: 16 }}>
                1Squared Microsoft Entra ID OIDC Federation Settings
              </h3>
              <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                Controls how Entra ID v2.0 JWT claims (<code>roles</code>,{' '}
                <code>groups</code>, <code>oid</code>, and <code>amr</code> MFA
                claims) map into 1Squared role keys.
              </p>
            </div>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!canManageConfig || pending}
              onClick={handleSaveRbacConfig}
            >
              Save Entra ID Mapping
            </button>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 16,
              marginBottom: 20,
            }}
          >
            <div>
              <label style={{ display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                Role Authority Mode (<code>rbac.identityMapping.authorityMode</code>)
              </label>
              <select
                className="field-input"
                value={localRbac.identityMapping.authorityMode}
                disabled={!canManageConfig || pending}
                onChange={(e) =>
                  setLocalRbac((prev) => ({
                    ...prev,
                    identityMapping: {
                      ...prev.identityMapping,
                      authorityMode: e.target.value as
                        | 'hybrid'
                        | 'token_only'
                        | 'store_only',
                    },
                  }))
                }
              >
                <option value="hybrid">
                  hybrid — Union of verified Entra token claims + 1Squared Person.roles
                </option>
                <option value="token_only">
                  token_only — Strictly Entra ID token claims (Production SSO)
                </option>
                <option value="store_only">
                  store_only — Strictly 1Squared Person.roles store
                </option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 20 }}>
              <input
                type="checkbox"
                id="require-mfa-admin"
                checked={localRbac.identityMapping.requireMfaForAdminPermissions}
                disabled={!canManageConfig || pending}
                onChange={(e) =>
                  setLocalRbac((prev) => ({
                    ...prev,
                    identityMapping: {
                      ...prev.identityMapping,
                      requireMfaForAdminPermissions: e.target.checked,
                    },
                  }))
                }
              />
              <label htmlFor="require-mfa-admin" style={{ fontSize: 13, fontWeight: 500 }}>
                Require Entra MFA claim (<code>amr: mfa / ngcmfa / fido</code>) for
                critical administrative permissions
              </label>
            </div>
          </div>

          <h4 style={{ fontSize: 14, margin: '16px 0 8px' }}>
            Entra App Role Claim Mappings (<code>entraAppRoleToRoleKey</code>)
          </h4>
          <table className="data-table" style={{ width: '100%', fontSize: 13, marginBottom: 12 }}>
            <thead>
              <tr>
                <th>Entra App Role Value (JWT <code>roles</code> claim)</th>
                <th>Mapped 1Squared Role Keys</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(localRbac.identityMapping.entraAppRoleToRoleKey).map(
                ([appRole, rks]) => (
                  <tr key={appRole}>
                    <td>
                      <code>{appRole}</code>
                    </td>
                    <td>
                      {rks.map((rk) => (
                        <code key={rk} style={{ marginRight: 6 }}>
                          {rk}
                        </code>
                      ))}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
            <input
              type="text"
              className="field-input"
              placeholder="e.g. 1Squared.CostsLawyer"
              value={newEntraAppRole}
              onChange={(e) => setNewEntraAppRole(e.target.value)}
              style={{ maxWidth: 260 }}
            />
            <select
              className="field-input"
              value={newEntraAppRoleTarget}
              onChange={(e) => setNewEntraAppRoleTarget(e.target.value)}
              style={{ maxWidth: 220 }}
            >
              {roleKeys.map((rk) => (
                <option key={rk} value={rk}>
                  {rk}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!canManageConfig || !newEntraAppRole.trim()}
              onClick={handleAddEntraAppRoleMapping}
            >
              + Add App Role Mapping
            </button>
          </div>

          <h4 style={{ fontSize: 14, margin: '16px 0 8px' }}>
            Entra Security Group Object ID Mappings (<code>entraGroupToRoleKey</code>)
          </h4>
          <table className="data-table" style={{ width: '100%', fontSize: 13, marginBottom: 12 }}>
            <thead>
              <tr>
                <th>Entra Security Group Object GUID (JWT <code>groups</code> claim)</th>
                <th>Mapped 1Squared Role Keys</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {Object.entries(localRbac.identityMapping.entraGroupToRoleKey).map(
                ([groupId, rks]) => (
                  <tr key={groupId}>
                    <td>
                      <code>{groupId}</code>
                    </td>
                    <td>
                      {rks.map((rk) => (
                        <code key={rk} style={{ marginRight: 6 }}>
                          {rk}
                        </code>
                      ))}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={!canManageConfig}
                        onClick={() => handleRemoveEntraGroupMapping(groupId)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              className="field-input"
              placeholder="Entra Group Object GUID (e.g. a1b2c3d4-...)"
              value={newEntraGroupId}
              onChange={(e) => setNewEntraGroupId(e.target.value)}
              style={{ maxWidth: 320 }}
            />
            <select
              className="field-input"
              value={newEntraGroupRole}
              onChange={(e) => setNewEntraGroupRole(e.target.value)}
              style={{ maxWidth: 220 }}
            >
              {roleKeys.map((rk) => (
                <option key={rk} value={rk}>
                  {rk}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!canManageConfig || !newEntraGroupId.trim()}
              onClick={handleAddEntraGroupMapping}
            >
              + Map Entra Group GUID
            </button>
          </div>
        </div>
      )}

      {/* SUB-TAB 4: PER-EMPLOYEE OVERRIDES & ENTRA OBJECT ID */}
      {subTab === 'overrides' && (
        <div className="card" style={{ padding: 16 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 16,
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Employee:</label>
              <select
                className="field-input"
                value={selectedEmployeeId}
                onChange={(e) => handleSelectEmployee(e.target.value)}
                style={{ minWidth: 300 }}
              >
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {personDisplayName(emp)} ({primaryEmail(emp) || emp.id})
                    {emp.id === currentUserId ? ' — [You]' : ''}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!canManageOverrides || isSelfSelected || pending}
              title={
                isSelfSelected
                  ? 'Self-modification of permission overrides is forbidden (ADR-0015)'
                  : !canManageOverrides
                    ? 'Requires rbac:manage_user_overrides permission'
                    : undefined
              }
              onClick={handleSavePersonOverrides}
            >
              Save Employee Overrides &amp; Entra Binding
            </button>
          </div>

          {isSelfSelected ? (
            <div
              className="muted"
              style={{
                padding: 12,
                borderRadius: 6,
                background: 'var(--surface-warning, #fffbeb)',
                marginBottom: 14,
                fontSize: 13,
              }}
            >
              <strong>Security policy (ADR-0015):</strong> You cannot modify your
              own permission overrides or security roles. Another administrator
              with <code>rbac:manage_user_overrides</code> and MFA must make
              changes to your account.
            </div>
          ) : null}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Entra ID User Object GUID (<code>oid</code> claim)
              </label>
              <input
                type="text"
                className="field-input"
                placeholder="e.g. 8f2e91c0-4a12-4b9e-9c01-..."
                value={entraObjectIdInput}
                disabled={!canManageOverrides || isSelfSelected || pending}
                onChange={(e) => setEntraObjectIdInput(e.target.value)}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Audit Reason for Override Change
              </label>
              <input
                type="text"
                className="field-input"
                placeholder="Reason logged in immutable audit trail..."
                value={overrideReason}
                disabled={!canManageOverrides || isSelfSelected || pending}
                onChange={(e) => setOverrideReason(e.target.value)}
              />
            </div>
          </div>

          <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr>
                <th>Permission Key</th>
                <th>Override State</th>
                <th>Effective Result</th>
              </tr>
            </thead>
            <tbody>
              {ALL_PERMISSION_KEYS.map((permKey) => {
                const isGranted = overrideGrant.includes(permKey);
                const isRevoked = overrideRevoke.includes(permKey);
                const actorHoldsPerm = actorPerms.has(permKey);
                const effective = selectedEmployeeEffectivePermissions.has(permKey);
                const stateValue = isRevoked
                  ? 'revoke'
                  : isGranted
                    ? 'grant'
                    : 'inherit';

                return (
                  <tr key={permKey}>
                    <td>
                      <code>{permKey}</code>
                    </td>
                    <td>
                      <select
                        className="field-input"
                        value={stateValue}
                        disabled={!canManageOverrides || isSelfSelected || pending}
                        onChange={(e) => {
                          const nextVal = e.target.value;
                          setOverrideGrant((prev) =>
                            nextVal === 'grant'
                              ? Array.from(new Set([...prev, permKey]))
                              : prev.filter((p) => p !== permKey),
                          );
                          setOverrideRevoke((prev) =>
                            nextVal === 'revoke'
                              ? Array.from(new Set([...prev, permKey]))
                              : prev.filter((p) => p !== permKey),
                          );
                        }}
                        style={{ maxWidth: 220 }}
                      >
                        <option value="inherit">Inherit from roles &amp; dept</option>
                        <option value="grant" disabled={!actorHoldsPerm}>
                          + Explicit Grant
                          {!actorHoldsPerm ? ' (unheld by you)' : ''}
                        </option>
                        <option value="revoke">− Explicit Revoke (always wins)</option>
                      </select>
                    </td>
                    <td>
                      <StatusPill
                        label={effective ? 'Allowed' : 'Denied'}
                        tone={effective ? 'positive' : 'neutral'}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
