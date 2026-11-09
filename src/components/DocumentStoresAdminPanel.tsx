'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DocumentAccessConfig,
  DocumentAccessLevel,
  DocumentReconciliationFindingRecord,
  DocumentRoutingRule,
  DocumentStoreConnectionTestResult,
  DocumentStoreConfig,
  LibraryScopeScaleStatus,
  MatterFolderTemplateNode,
  MatterFolderTemplatesConfig,
  ResolvedMatterFolderTemplate,
} from '@platform/core';
import type { DocumentStoresAdminDashboardData } from '@/server/documentStoreServices';

export type DocumentAdminSubView =
  | 'stores'
  | 'routing_and_access'
  | 'templates'
  | 'access_review';

interface DocumentStoresAdminPanelProps {
  initialSubView?: DocumentAdminSubView;
}

const ACCESS_LEVEL_OPTIONS: { value: DocumentAccessLevel; label: string }[] = [
  { value: 'none', label: 'None (No access)' },
  { value: 'read', label: 'Read (View & download only)' },
  { value: 'contribute', label: 'Contribute (View, upload & edit files)' },
  { value: 'edit', label: 'Edit (Upload, rename, move & delete)' },
  { value: 'manage', label: 'Manage (Full Control / permissions)' },
];

export function DocumentStoresAdminPanel({
  initialSubView = 'stores',
}: DocumentStoresAdminPanelProps) {
  const [subView, setSubView] = useState<DocumentAdminSubView>(initialSubView);
  const [dashboard, setDashboard] =
    useState<DocumentStoresAdminDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [bannerMessage, setBannerMessage] = useState<{
    kind: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  // Store connection test & URL resolver state
  const [testingStoreId, setTestingStoreId] = useState<string | null>(null);
  const [connectionResults, setConnectionResults] = useState<
    Record<string, DocumentStoreConnectionTestResult>
  >({});
  const [pasteUrlInput, setPasteUrlInput] = useState('');
  const [resolvedUrlResult, setResolvedUrlResult] = useState<{
    valid: boolean;
    hostname?: string;
    siteRelativePath?: string;
    libraryUrlSegment?: string;
    folderRelativePath?: string;
    normalizedWebUrl?: string;
    errorReason?: string;
    siteId?: string;
    driveId?: string;
  } | null>(null);

  // Editable config drafts
  const [storesDraft, setStoresDraft] = useState<DocumentStoreConfig[]>([]);
  const [routingDraft, setRoutingDraft] = useState<DocumentRoutingRule[]>([]);
  const [folderNameTemplateDraft, setFolderNameTemplateDraft] = useState(
    '{matterNumber} - {matterDescription}',
  );
  const [accessDraft, setAccessDraft] = useState<DocumentAccessConfig>({
    departmentEntraGroups: {},
    teamEntraGroups: {},
  });
  const [templatesDraft, setTemplatesDraft] =
    useState<MatterFolderTemplatesConfig>({
      default: {
        templateId: 'tpl-firm-default',
        version: 1,
        mode: 'replaces',
        nodes: [],
      },
    });

  // Template preview state
  const [previewDeptId, setPreviewDeptId] = useState<string>('');
  const [previewWorkTypeId, setPreviewWorkTypeId] = useState<string>(
    'work_type.real_estate_and_property_residential_conveyancing',
  );
  const [compiledPreview, setCompiledPreview] =
    useState<ResolvedMatterFolderTemplate | null>(null);
  const [newWorkTypeNodeName, setNewWorkTypeNodeName] = useState('');
  const [selectedTemplateTarget, setSelectedTemplateTarget] =
    useState<string>('default');

  // Access review filters
  const [findingStatusFilter, setFindingStatusFilter] = useState<
    'all' | 'open' | 'remediated'
  >('all');
  const [runningScan, setRunningScan] = useState(false);

  const hydrateDrafts = useCallback(
    (data: DocumentStoresAdminDashboardData) => {
      setDashboard(data);
      setStoresDraft(structuredClone(data.config.documentStores));
      setRoutingDraft(structuredClone(data.config.documentRouting));
      setFolderNameTemplateDraft(data.config.matterFolderNameTemplate);
      setAccessDraft(structuredClone(data.config.documentAccess));
      setTemplatesDraft(structuredClone(data.config.matterFolderTemplates));
    },
    [],
  );

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/document-stores', { cache: 'no-store' });
      const json = await res.json();
      if (json.ok && json.dashboard) {
        hydrateDrafts(json.dashboard);
      } else {
        setBannerMessage({
          kind: 'error',
          text: json.error || 'Failed to load document store configuration.',
        });
      }
    } catch (err) {
      setBannerMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Network error.',
      });
    } finally {
      setLoading(false);
    }
  }, [hydrateDrafts]);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchDashboard();
    });
  }, [fetchDashboard]);

  useEffect(() => {
    queueMicrotask(() => {
      setSubView(initialSubView);
    });
  }, [initialSubView]);

  const refreshTemplatePreview = useCallback(
    async (
      deptId: string,
      wtId: string,
      tplCfg: MatterFolderTemplatesConfig,
    ) => {
      try {
        const res = await fetch('/api/document-stores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'preview_template',
            departmentId: deptId || undefined,
            workTypeId: wtId || undefined,
            templatesConfig: tplCfg,
          }),
        });
        const json = await res.json();
        if (json.ok && json.preview) {
          setCompiledPreview(json.preview);
        }
      } catch {
        // Ignore preview error while typing
      }
    },
    [],
  );

  useEffect(() => {
    if (dashboard) {
      queueMicrotask(() => {
        void refreshTemplatePreview(
          previewDeptId,
          previewWorkTypeId,
          templatesDraft,
        );
      });
    }
  }, [
    dashboard,
    previewDeptId,
    previewWorkTypeId,
    templatesDraft,
    refreshTemplatePreview,
  ]);

  const handleTestConnection = async (storeId: string) => {
    setTestingStoreId(storeId);
    setBannerMessage(null);
    try {
      const res = await fetch('/api/document-stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test_connection', storeId }),
      });
      const json = await res.json();
      if (json.ok && json.result) {
        setConnectionResults((prev) => ({ ...prev, [storeId]: json.result }));
        if (json.dashboard) hydrateDrafts(json.dashboard);
        setBannerMessage({
          kind: json.result.ok ? 'success' : 'error',
          text: json.result.ok
            ? `Connection to "${storeId}" verified (${json.result.latencyMs}ms).`
            : `Connection check failed: ${json.result.errorReason}`,
        });
      }
    } finally {
      setTestingStoreId(null);
    }
  };

  const handleResolveUrl = async () => {
    if (!pasteUrlInput.trim()) return;
    setBannerMessage(null);
    const res = await fetch('/api/document-stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'resolve_location',
        rawUrlOrPath: pasteUrlInput.trim(),
        storeId: storesDraft[0]?.storeId,
      }),
    });
    const json = await res.json();
    if (json.ok) {
      setResolvedUrlResult({
        ...json.parsed,
        siteId: json.resolution?.siteId,
        driveId: json.resolution?.driveId,
      });
    } else {
      setBannerMessage({
        kind: 'error',
        text: json.error || 'Could not resolve SharePoint URL.',
      });
    }
  };

  const handleSaveSection = async (
    section: 'stores' | 'routing_and_access' | 'templates',
  ) => {
    setBannerMessage(null);
    const res = await fetch('/api/document-stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save_config',
        section,
        documentStores: section === 'stores' ? storesDraft : undefined,
        documentRouting:
          section === 'routing_and_access' ? routingDraft : undefined,
        matterFolderNameTemplate:
          section === 'routing_and_access' ? folderNameTemplateDraft : undefined,
        documentAccess:
          section === 'routing_and_access' ? accessDraft : undefined,
        matterFolderTemplates:
          section === 'templates' ? templatesDraft : undefined,
      }),
    });
    const json = await res.json();
    if (json.ok && json.dashboard) {
      hydrateDrafts(json.dashboard);
      setBannerMessage({
        kind: 'success',
        text: 'Document store configuration saved and validated.',
      });
    } else {
      setBannerMessage({
        kind: 'error',
        text: json.error || 'Validation failed.',
      });
    }
  };

  const handleApplyTemplateAdditions = async () => {
    setBannerMessage(null);
    const res = await fetch('/api/document-stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'apply_template_additions' }),
    });
    const json = await res.json();
    if (json.ok) {
      if (json.dashboard) hydrateDrafts(json.dashboard);
      setBannerMessage({
        kind: 'success',
        text: `Applied additive folder template updates across ${json.applied.updatedMatterCount} open matter(s) without modifying or deleting existing folders.`,
      });
    } else {
      setBannerMessage({
        kind: 'error',
        text: json.error || 'Failed to apply template additions.',
      });
    }
  };

  const handleRunReconciliationScan = async (autoRemediate = false) => {
    setRunningScan(true);
    setBannerMessage(null);
    try {
      const res = await fetch('/api/document-stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run_reconciliation',
          autoRemediate,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        if (json.dashboard) hydrateDrafts(json.dashboard);
        setBannerMessage({
          kind: 'info',
          text: `Permission reconciliation scan completed: ${json.scan.findings.length} finding(s) detected, ${json.scan.remediatedCount} auto-remediated.`,
        });
      } else {
        setBannerMessage({
          kind: 'error',
          text: json.error || 'Reconciliation scan failed.',
        });
      }
    } finally {
      setRunningScan(false);
    }
  };

  const handleRemediateFinding = async (findingId: string) => {
    setBannerMessage(null);
    const res = await fetch('/api/document-stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remediate_finding', findingId }),
    });
    const json = await res.json();
    if (json.ok && json.dashboard) {
      hydrateDrafts(json.dashboard);
      setBannerMessage({
        kind: 'success',
        text: `Remediated finding ${findingId} by reapplying intended SharePoint permissions.`,
      });
    } else {
      setBannerMessage({
        kind: 'error',
        text: json.error || 'Failed to remediate finding.',
      });
    }
  };

  const sampleRenderedMatterFolderName = useMemo(() => {
    return folderNameTemplateDraft
      .replace(/\{matterNumber\}/g, 'ABC123-0001')
      .replace(/\{matterDescription\}/g, 'Acquisition of 14 Chancery Lane')
      .replace(/\{clientNumber\}/g, 'CLI-0042')
      .replace(/\{departmentCode\}/g, 'RE')
      .replace(/\{teamCode\}/g, 'COMM')
      .replace(/\{workTypeCode\}/g, 'CONV');
  }, [folderNameTemplateDraft]);

  const filteredFindings = useMemo(() => {
    const all = dashboard?.reconciliationFindings ?? [];
    if (findingStatusFilter === 'all') return all;
    return all.filter((f) => f.status === findingStatusFilter);
  }, [dashboard, findingStatusFilter]);

  if (loading && !dashboard) {
    return (
      <div className="card" style={{ padding: 24 }}>
        Loading external document store configuration…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Sub-navigation bar matching Section 10 */}
      <div
        className="card"
        style={{
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
            External Document Stores & SharePoint Integration
          </h2>
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 13,
              color: 'var(--text-muted, #64748b)',
            }}
          >
            Delegated per-user access (OBO) · Application-identity provisioning (
            <code>Sites.Selected</code>) · Inheritance-based security · Matter
            folder templates
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(
            [
              {
                key: 'stores',
                label: '1. Document stores',
                subtitle: 'Integrations → Document stores',
              },
              {
                key: 'routing_and_access',
                label: '2. Routing & access',
                subtitle: 'Documents → Routing and access',
              },
              {
                key: 'templates',
                label: '3. Folder templates',
                subtitle: 'Documents → Folder templates',
              },
              {
                key: 'access_review',
                label: `4. Access review (${(dashboard?.reconciliationFindings ?? []).filter((f) => f.status === 'open').length})`,
                subtitle: 'Documents → Access review',
              },
            ] as const
          ).map((tab) => {
            const active = subView === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                className={active ? 'btn btn-primary' : 'btn'}
                onClick={() => setSubView(tab.key)}
                title={tab.subtitle}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {bannerMessage && (
        <div
          className="card"
          style={{
            padding: '10px 14px',
            borderLeft: `4px solid ${
              bannerMessage.kind === 'success'
                ? '#16a34a'
                : bannerMessage.kind === 'error'
                  ? '#dc2626'
                  : '#2563eb'
            }`,
            background:
              bannerMessage.kind === 'success'
                ? '#f0fdf4'
                : bannerMessage.kind === 'error'
                  ? '#fef2f2'
                  : '#eff6ff',
            fontSize: 13,
          }}
        >
          {bannerMessage.text}
        </div>
      )}

      {/* =====================================================================
          1. Admin -> Integrations -> Document stores
         ===================================================================== */}
      {subView === 'stores' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: 18 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 14,
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: 16 }}>
                  Configured Document Stores
                </h3>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
                  Connect SharePoint Online sites and document libraries. At most
                  one store may be marked as the tenant default.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleSaveSection('stores')}
              >
                Save stores configuration
              </button>
            </div>

            {storesDraft.map((store, sIdx) => {
              const testRes = connectionResults[store.storeId];
              return (
                <div
                  key={store.storeId}
                  style={{
                    border: '1px solid #e2e8f0',
                    borderRadius: 8,
                    padding: 16,
                    marginBottom: 14,
                    background: '#f8fafc',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: 10,
                      marginBottom: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ fontSize: 15 }}>{store.displayName}</strong>
                      <span
                        className="pill"
                        style={{
                          background: '#dbeafe',
                          color: '#1e40af',
                          fontSize: 11,
                          padding: '2px 8px',
                          borderRadius: 999,
                        }}
                      >
                        Provider: {store.providerType}
                      </span>
                      {store.isDefault && (
                        <span
                          className="pill"
                          style={{
                            background: '#dcfce7',
                            color: '#166534',
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 999,
                          }}
                        >
                          Default Store
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="btn"
                        disabled={testingStoreId === store.storeId}
                        onClick={() => handleTestConnection(store.storeId)}
                      >
                        {testingStoreId === store.storeId
                          ? 'Testing connection…'
                          : 'Test connection'}
                      </button>
                    </div>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                      gap: 12,
                      fontSize: 13,
                    }}
                  >
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontWeight: 600 }}>Display Name</span>
                      <input
                        className="input"
                        value={store.displayName}
                        onChange={(e) => {
                          const next = [...storesDraft];
                          next[sIdx] = { ...store, displayName: e.target.value };
                          setStoresDraft(next);
                        }}
                      />
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontWeight: 600 }}>SharePoint Hostname</span>
                      <input
                        className="input"
                        value={store.sharepoint?.hostname ?? ''}
                        onChange={(e) => {
                          if (!store.sharepoint) return;
                          const next = [...storesDraft];
                          next[sIdx] = {
                            ...store,
                            sharepoint: {
                              ...store.sharepoint,
                              hostname: e.target.value,
                            },
                          };
                          setStoresDraft(next);
                        }}
                      />
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontWeight: 600 }}>Site Relative Path</span>
                      <input
                        className="input"
                        value={store.sharepoint?.siteRelativePath ?? ''}
                        onChange={(e) => {
                          if (!store.sharepoint) return;
                          const next = [...storesDraft];
                          next[sIdx] = {
                            ...store,
                            sharepoint: {
                              ...store.sharepoint,
                              siteRelativePath: e.target.value,
                            },
                          };
                          setStoresDraft(next);
                        }}
                      />
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontWeight: 600 }}>
                        Key Vault Certificate Secret Ref
                      </span>
                      <input
                        className="input"
                        value={store.auth.certificateKeyVaultSecretRef ?? ''}
                        onChange={(e) => {
                          const next = [...storesDraft];
                          next[sIdx] = {
                            ...store,
                            auth: {
                              ...store.auth,
                              certificateKeyVaultSecretRef: e.target.value,
                            },
                          };
                          setStoresDraft(next);
                        }}
                      />
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontWeight: 600 }}>
                        Delegated Permission Scope
                      </span>
                      <select
                        className="input"
                        value={
                          store.auth.delegatedPermissionScope ??
                          'Files.ReadWrite.All'
                        }
                        onChange={(e) => {
                          const next = [...storesDraft];
                          next[sIdx] = {
                            ...store,
                            auth: {
                              ...store.auth,
                              delegatedPermissionScope: e.target.value as
                                | 'Sites.Selected'
                                | 'Files.ReadWrite.All',
                            },
                          };
                          setStoresDraft(next);
                        }}
                      >
                        <option value="Sites.Selected">
                          Sites.Selected (Least-privilege — Recommended)
                        </option>
                        <option value="Files.ReadWrite.All">
                          Files.ReadWrite.All (Legacy — Deprecated)
                        </option>
                      </select>
                    </label>
                  </div>

                  {/* Libraries table */}
                  <div style={{ marginTop: 12 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: '#475569',
                        marginBottom: 6,
                      }}
                    >
                      Document Libraries ({store.sharepoint?.libraries.length ?? 0})
                    </div>
                    <table
                      style={{
                        width: '100%',
                        borderCollapse: 'collapse',
                        fontSize: 13,
                        background: '#fff',
                      }}
                    >
                      <thead>
                        <tr style={{ borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                          <th style={{ padding: 8 }}>Library ID</th>
                          <th style={{ padding: 8 }}>Display Name</th>
                          <th style={{ padding: 8 }}>URL Segment</th>
                          <th style={{ padding: 8 }}>Resolved Drive ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(store.sharepoint?.libraries ?? []).map((lib) => (
                          <tr
                            key={lib.libraryId}
                            style={{ borderBottom: '1px solid #f1f5f9' }}
                          >
                            <td style={{ padding: 8 }}>
                              <code>{lib.libraryId}</code>
                            </td>
                            <td style={{ padding: 8 }}>{lib.displayName}</td>
                            <td style={{ padding: 8 }}>{lib.libraryUrlSegment}</td>
                            <td style={{ padding: 8 }}>
                              <code>{lib.driveId ?? 'Auto-resolved'}</code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Connection Test Diagnostics */}
                  {testRes && (
                    <div
                      style={{
                        marginTop: 12,
                        padding: 12,
                        borderRadius: 6,
                        background: testRes.ok ? '#f0fdf4' : '#fef2f2',
                        border: `1px solid ${testRes.ok ? '#bbf7d0' : '#fecaca'}`,
                        fontSize: 12,
                      }}
                    >
                      <strong>
                        Connection Test ({testRes.latencyMs}ms at{' '}
                        {new Date(testRes.checkedAt).toLocaleTimeString()}):
                      </strong>
                      <div
                        style={{
                          display: 'flex',
                          gap: 16,
                          flexWrap: 'wrap',
                          marginTop: 6,
                        }}
                      >
                        <span>
                          {testRes.checks.credentialsValid ? '✓' : '✗'} Credentials
                          valid
                        </span>
                        <span>
                          {testRes.checks.targetSiteReachable ? '✓' : '✗'} Target
                          SharePoint site reachable
                        </span>
                        <span>
                          {testRes.checks.librariesFound ? '✓' : '✗'} Document
                          libraries resolved
                        </span>
                        <span>
                          {testRes.checks.permissionManagementSupported
                            ? '✓'
                            : testRes.roleVerificationStatus === 'not_verified'
                              ? '⚠'
                              : '✗'}{' '}
                          {testRes.roleVerificationStatus === 'not_verified'
                            ? 'Sites.Selected role not verified (403 on /permissions)'
                            : 'Sites.Selected fullcontrol verified'}
                        </span>
                      </div>
                      {testRes.warnings && testRes.warnings.length > 0 && (
                        <div
                          style={{
                            marginTop: 8,
                            color: '#92400e',
                            background: '#fef3c7',
                            padding: '6px 10px',
                            borderRadius: 4,
                          }}
                        >
                          {testRes.warnings.join(' ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Paste-a-URL SharePoint Location Resolver */}
          <div className="card" style={{ padding: 18 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>
              Paste-a-URL SharePoint Location Resolver
            </h3>
            <p style={{ margin: '4px 0 12px', fontSize: 13, color: '#64748b' }}>
              Paste any SharePoint library or folder URL (including{' '}
              <code>/Forms/AllItems.aspx</code> view links or encoded spaces) to
              resolve its hostname, site path, library segment, and Graph IDs.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="https://1squared1.sharepoint.com/sites/NotALawFirm/Not%20A%20Law%20Firm%20Document%20Repository/Forms/AllItems.aspx"
                value={pasteUrlInput}
                onChange={(e) => setPasteUrlInput(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                onClick={handleResolveUrl}
              >
                Resolve URL
              </button>
            </div>

            {resolvedUrlResult && (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 6,
                  background: resolvedUrlResult.valid ? '#f8fafc' : '#fef2f2',
                  border: '1px solid #e2e8f0',
                  fontSize: 13,
                }}
              >
                {resolvedUrlResult.valid ? (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                      gap: 8,
                    }}
                  >
                    <div>
                      <strong>Hostname:</strong>{' '}
                      <code>{resolvedUrlResult.hostname}</code>
                    </div>
                    <div>
                      <strong>Site Path:</strong>{' '}
                      <code>{resolvedUrlResult.siteRelativePath}</code>
                    </div>
                    <div>
                      <strong>Library Segment:</strong>{' '}
                      <code>{resolvedUrlResult.libraryUrlSegment}</code>
                    </div>
                    <div>
                      <strong>Subfolder Path:</strong>{' '}
                      <code>{resolvedUrlResult.folderRelativePath || '(Library root)'}</code>
                    </div>
                    {resolvedUrlResult.siteId && (
                      <div>
                        <strong>Graph Site ID:</strong>{' '}
                        <code>{resolvedUrlResult.siteId}</code>
                      </div>
                    )}
                    {resolvedUrlResult.driveId && (
                      <div>
                        <strong>Graph Drive ID:</strong>{' '}
                        <code>{resolvedUrlResult.driveId}</code>
                      </div>
                    )}
                  </div>
                ) : (
                  <span style={{ color: '#dc2626' }}>
                    {resolvedUrlResult.errorReason}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          2. Admin -> Documents -> Routing and access
         ===================================================================== */}
      {subView === 'routing_and_access' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Library Scope Scale Counter */}
          <div className="card" style={{ padding: 18 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>
              SharePoint Unique Permission Scope Monitor (5,000-Scope Guard)
            </h3>
            <p style={{ margin: '4px 0 12px', fontSize: 13, color: '#64748b' }}>
              Standard matters inherit permissions from their{' '}
              <code>{'{departmentCode}/{teamCode}'}</code> folder and consume{' '}
              <strong>0 unique scopes</strong>. Only department folders, team
              folders, restricted matters, cross-team outsiders, and closed matters
              consume unique scopes.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {(dashboard?.libraryScaleStatuses ?? []).map(
                (stat: LibraryScopeScaleStatus) => (
                  <div
                    key={`${stat.storeId}:${stat.libraryId}`}
                    style={{
                      flex: '1 1 300px',
                      padding: 12,
                      borderRadius: 8,
                      border: `1px solid ${
                        stat.exceedsWarningThreshold ? '#f59e0b' : '#cbd5e1'
                      }`,
                      background: stat.exceedsWarningThreshold
                        ? '#fffbeb'
                        : '#f8fafc',
                      fontSize: 13,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontWeight: 600,
                      }}
                    >
                      <span>Library: {stat.libraryId}</span>
                      <span>
                        {stat.uniqueScopeCount} / {stat.warningThreshold} warning
                        threshold (Max rec: {stat.recommendedLimit})
                      </span>
                    </div>
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 12,
                        color: '#475569',
                        display: 'flex',
                        gap: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span>Dept scopes: {stat.breakdown.departmentScopes}</span>
                      <span>Team scopes: {stat.breakdown.teamScopes}</span>
                      <span>
                        Matter exception scopes:{' '}
                        {stat.breakdown.matterExceptionScopes}
                      </span>
                      <span>
                        Template override scopes:{' '}
                        {stat.breakdown.templateOverrideScopes}
                      </span>
                    </div>
                    {stat.warningMessage && (
                      <div style={{ marginTop: 6, color: '#b45309', fontSize: 12 }}>
                        ⚠ {stat.warningMessage}
                      </div>
                    )}
                  </div>
                ),
              )}
            </div>
          </div>

          {/* Storage Routing & Matter Folder Naming Template */}
          <div className="card" style={{ padding: 18 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <h3 style={{ margin: 0, fontSize: 15 }}>
                Storage Routing & Matter Folder Naming
              </h3>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleSaveSection('routing_and_access')}
              >
                Save routing & access policy
              </button>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: 12,
                marginBottom: 14,
                fontSize: 13,
              }}
            >
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontWeight: 600 }}>
                  Matter Folder Name Template
                </span>
                <input
                  className="input"
                  value={folderNameTemplateDraft}
                  onChange={(e) => setFolderNameTemplateDraft(e.target.value)}
                />
              </label>
              <div
                style={{
                  padding: 10,
                  borderRadius: 6,
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                }}
              >
                <div style={{ fontSize: 11, color: '#64748b' }}>
                  Live Preview (Sanitised SharePoint Path):
                </div>
                <code style={{ fontSize: 13, fontWeight: 600 }}>
                  RE/COMM/{sampleRenderedMatterFolderName}
                </code>
              </div>
            </div>

            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                  <th style={{ padding: 8 }}>Order</th>
                  <th style={{ padding: 8 }}>Match Criteria</th>
                  <th style={{ padding: 8 }}>Target Store</th>
                  <th style={{ padding: 8 }}>Target Library</th>
                  <th style={{ padding: 8 }}>Base Path Template</th>
                </tr>
              </thead>
              <tbody>
                {routingDraft.map((rule, idx) => (
                  <tr
                    key={rule.ruleId ?? idx}
                    style={{ borderBottom: '1px solid #f1f5f9' }}
                  >
                    <td style={{ padding: 8 }}>#{idx + 1}</td>
                    <td style={{ padding: 8 }}>
                      {rule.match === 'default' ? (
                        <span className="pill">Default fallback (Required)</span>
                      ) : (
                        <code>{JSON.stringify(rule.match)}</code>
                      )}
                    </td>
                    <td style={{ padding: 8 }}>
                      <code>{rule.storeId}</code>
                    </td>
                    <td style={{ padding: 8 }}>
                      <code>{rule.libraryId}</code>
                    </td>
                    <td style={{ padding: 8 }}>
                      <input
                        className="input"
                        value={rule.basePath}
                        onChange={(e) => {
                          const next = [...routingDraft];
                          next[idx] = { ...rule, basePath: e.target.value };
                          setRoutingDraft(next);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Access Policy Matrix */}
          <div className="card" style={{ padding: 18 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>
              Inheritance-Based Access Policy
            </h3>
            <p style={{ margin: '4px 0 12px', fontSize: 13, color: '#64748b' }}>
              Defines the abstract permission level mapped to SharePoint roles at
              each folder layer.
            </p>

            {accessDraft.defaultPolicy && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 12,
                  fontSize: 13,
                }}
              >
                {(
                  [
                    {
                      key: 'owningDepartment',
                      label: 'Owning Department Group',
                    },
                    { key: 'owningTeam', label: 'Owning Team Group' },
                    { key: 'otherDepartments', label: 'Other Departments' },
                    {
                      key: 'matterTeamOutsider',
                      label: 'Matter Team Outsiders',
                    },
                    { key: 'closedMatter', label: 'Closed Matter Policy' },
                  ] as const
                ).map((field) => (
                  <label
                    key={field.key}
                    style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                  >
                    <span style={{ fontWeight: 600 }}>{field.label}</span>
                    <select
                      className="input"
                      value={accessDraft.defaultPolicy![field.key]}
                      onChange={(e) => {
                        setAccessDraft({
                          ...accessDraft,
                          defaultPolicy: {
                            ...accessDraft.defaultPolicy!,
                            [field.key]: e.target.value as DocumentAccessLevel,
                          },
                        });
                      }}
                    >
                      {ACCESS_LEVEL_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Department & Team -> Entra Security Group Mapping */}
          <div className="card" style={{ padding: 18 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>
              Department & Team Microsoft Entra ID Security Group Mappings
            </h3>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
                gap: 16,
                marginTop: 12,
              }}
            >
              <div>
                <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>
                  Departments ({dashboard?.catalog.departments.length ?? 0})
                </h4>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 12,
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                      <th style={{ padding: 6 }}>Department</th>
                      <th style={{ padding: 6 }}>Entra Group Object ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dashboard?.catalog.departments ?? []).map((dept) => (
                      <tr
                        key={dept.id}
                        style={{ borderBottom: '1px solid #f1f5f9' }}
                      >
                        <td style={{ padding: 6 }}>
                          <strong>{dept.code}</strong> · {dept.name}
                        </td>
                        <td style={{ padding: 6 }}>
                          <input
                            className="input"
                            style={{ fontSize: 12, padding: '4px 6px' }}
                            value={
                              accessDraft.departmentEntraGroups[dept.id] ?? ''
                            }
                            onChange={(e) => {
                              setAccessDraft({
                                ...accessDraft,
                                departmentEntraGroups: {
                                  ...accessDraft.departmentEntraGroups,
                                  [dept.id]: e.target.value,
                                },
                              });
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>
                  Practice Group Teams ({dashboard?.catalog.teams.length ?? 0})
                </h4>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 12,
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                      <th style={{ padding: 6 }}>Team</th>
                      <th style={{ padding: 6 }}>Entra Group Object ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dashboard?.catalog.teams ?? []).map((team) => (
                      <tr
                        key={team.id}
                        style={{ borderBottom: '1px solid #f1f5f9' }}
                      >
                        <td style={{ padding: 6 }}>
                          <strong>{team.code}</strong> · {team.name}
                        </td>
                        <td style={{ padding: 6 }}>
                          <input
                            className="input"
                            style={{ fontSize: 12, padding: '4px 6px' }}
                            value={accessDraft.teamEntraGroups[team.id] ?? ''}
                            onChange={(e) => {
                              setAccessDraft({
                                ...accessDraft,
                                teamEntraGroups: {
                                  ...accessDraft.teamEntraGroups,
                                  [team.id]: e.target.value,
                                },
                              });
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          3. Admin -> Documents -> Folder templates
         ===================================================================== */}
      {subView === 'templates' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: 18 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 10,
                marginBottom: 14,
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: 15 }}>
                  Matter Folder Templates & Inheritance Compiler
                </h3>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
                  Resolution chain: <strong>Work Type</strong> →{' '}
                  <strong>Department</strong> → <strong>Firm Default</strong>.
                  Templates can either extend or replace their parent template.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={handleApplyTemplateAdditions}
                >
                  Apply additions to open matters
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleSaveSection('templates')}
                >
                  Save folder templates
                </button>
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
                gap: 16,
              }}
            >
              {/* Left: Template Editor */}
              <div
                style={{
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  padding: 14,
                  background: '#f8fafc',
                }}
              >
                <label
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    fontSize: 13,
                    marginBottom: 12,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>
                    Select Template to Inspect / Edit
                  </span>
                  <select
                    className="input"
                    value={selectedTemplateTarget}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSelectedTemplateTarget(val);
                      if (val !== 'default') {
                        setPreviewWorkTypeId(val);
                      }
                    }}
                  >
                    <option value="default">
                      Firm Default Template ({templatesDraft.default.templateId} · v
                      {templatesDraft.default.version})
                    </option>
                    {Object.entries(templatesDraft.byWorkType ?? {}).map(
                      ([wtId, def]) => (
                        <option key={wtId} value={wtId}>
                          Work Type: {wtId} ({def.templateId} · mode: {def.mode} ·
                          v{def.version})
                        </option>
                      ),
                    )}
                  </select>
                </label>

                {selectedTemplateTarget === 'default' ? (
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        marginBottom: 8,
                      }}
                    >
                      Base Folders in Firm Default:
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                      {(templatesDraft.default.nodes ?? []).map(
                        (node: MatterFolderTemplateNode) => (
                          <li key={node.name} style={{ marginBottom: 6 }}>
                            <strong>{node.name}</strong>
                            {node.description && (
                              <span style={{ color: '#64748b' }}>
                                {' '}
                                — {node.description}
                              </span>
                            )}
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                ) : (
                  (() => {
                    const wtDef =
                      templatesDraft.byWorkType?.[selectedTemplateTarget];
                    if (!wtDef) return null;
                    return (
                      <div style={{ fontSize: 13 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            marginBottom: 10,
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>
                            Inheritance Mode:
                          </span>
                          <select
                            className="input"
                            value={wtDef.mode}
                            onChange={(e) => {
                              const nextMode = e.target.value as
                                | 'extends'
                                | 'replaces';
                              setTemplatesDraft({
                                ...templatesDraft,
                                byWorkType: {
                                  ...(templatesDraft.byWorkType ?? {}),
                                  [selectedTemplateTarget]: {
                                    ...wtDef,
                                    mode: nextMode,
                                    nodes:
                                      nextMode === 'replaces' && !wtDef.nodes
                                        ? [
                                            ...(templatesDraft.default.nodes ??
                                              []),
                                          ]
                                        : wtDef.nodes,
                                  },
                                },
                              });
                            }}
                          >
                            <option value="extends">
                              extends (Inherits parent folders + applies
                              operations)
                            </option>
                            <option value="replaces">
                              replaces (Full standalone folder list)
                            </option>
                          </select>
                        </div>

                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            marginBottom: 6,
                          }}
                        >
                          Operations ({wtDef.operations?.length ?? 0}):
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {(wtDef.operations ?? []).map((op, opIdx) => (
                            <li key={opIdx} style={{ marginBottom: 4 }}>
                              <code>{op.op}</code>:{' '}
                              <strong>
                                {op.node?.name ?? op.newName ?? op.path}
                              </strong>{' '}
                              {op.parentPath ? `(under ${op.parentPath})` : ''}
                            </li>
                          ))}
                        </ul>

                        <div
                          style={{
                            display: 'flex',
                            gap: 8,
                            marginTop: 12,
                          }}
                        >
                          <input
                            className="input"
                            style={{ flex: 1 }}
                            placeholder="Add subfolder name (e.g. 03d Expert Reports)"
                            value={newWorkTypeNodeName}
                            onChange={(e) =>
                              setNewWorkTypeNodeName(e.target.value)
                            }
                          />
                          <button
                            type="button"
                            className="btn"
                            onClick={() => {
                              const trimmed = newWorkTypeNodeName.trim();
                              if (!trimmed) return;
                              setTemplatesDraft({
                                ...templatesDraft,
                                byWorkType: {
                                  ...(templatesDraft.byWorkType ?? {}),
                                  [selectedTemplateTarget]: {
                                    ...wtDef,
                                    version: wtDef.version + 1,
                                    operations: [
                                      ...(wtDef.operations ?? []),
                                      {
                                        op: 'add',
                                        parentPath: '/',
                                        node: { name: trimmed },
                                      },
                                    ],
                                  },
                                },
                              });
                              setNewWorkTypeNodeName('');
                            }}
                          >
                            + Add Folder Operation
                          </button>
                        </div>
                      </div>
                    );
                  })()
                )}
              </div>

              {/* Right: Live Compiled Tree Preview */}
              <div
                style={{
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  padding: 14,
                  background: '#fff',
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    marginBottom: 10,
                  }}
                >
                  Compiled Folder Tree Preview
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 8,
                    marginBottom: 12,
                    fontSize: 12,
                  }}
                >
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span>Department</span>
                    <select
                      className="input"
                      value={previewDeptId}
                      onChange={(e) => setPreviewDeptId(e.target.value)}
                    >
                      <option value="">(Any / None)</option>
                      {(dashboard?.catalog.departments ?? []).map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.code} — {d.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span>Work Type</span>
                    <select
                      className="input"
                      value={previewWorkTypeId}
                      onChange={(e) => setPreviewWorkTypeId(e.target.value)}
                    >
                      <option value="">(Firm Default Only)</option>
                      {Object.keys(templatesDraft.byWorkType ?? {}).map((wt) => (
                        <option key={wt} value={wt}>
                          {wt}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {compiledPreview && (
                  <div style={{ fontSize: 13 }}>
                    <div
                      style={{
                        marginBottom: 8,
                        fontSize: 12,
                        color: '#475569',
                      }}
                    >
                      Effective Template:{' '}
                      <code>{compiledPreview.templateId}</code> (v
                      {compiledPreview.version}) · Chain:{' '}
                      <code>{compiledPreview.resolutionChain.join(' → ')}</code>
                    </div>

                    {compiledPreview.scaleWarnings.map((warn, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: 8,
                          borderRadius: 6,
                          background: '#fffbeb',
                          border: '1px solid #f59e0b',
                          color: '#b45309',
                          fontSize: 12,
                          marginBottom: 8,
                        }}
                      >
                        ⚠ {warn}
                      </div>
                    ))}

                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {compiledPreview.nodes.map((node) => (
                        <li key={node.relativePath} style={{ marginBottom: 6 }}>
                          <span>📁 {node.renderedName}</span>{' '}
                          <span
                            className="pill"
                            style={{
                              fontSize: 10,
                              padding: '1px 6px',
                              borderRadius: 999,
                              background:
                                node.inheritedFrom === 'default'
                                  ? '#f1f5f9'
                                  : '#dbeafe',
                              color:
                                node.inheritedFrom === 'default'
                                  ? '#475569'
                                  : '#1e40af',
                            }}
                          >
                            from {node.inheritedFrom}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          4. Admin -> Documents -> Access review
         ===================================================================== */}
      {subView === 'access_review' && (
        <div className="card" style={{ padding: 18 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 10,
              marginBottom: 14,
            }}
          >
            <div>
              <h3 style={{ margin: 0, fontSize: 15 }}>
                Permission Drift & Access Review
              </h3>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
                Compares intended 1Squared security policy against actual
                SharePoint folder permissions, inheritance state, and unexpected
                sharing links.
              </p>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select
                className="input"
                value={findingStatusFilter}
                onChange={(e) =>
                  setFindingStatusFilter(
                    e.target.value as 'all' | 'open' | 'remediated',
                  )
                }
              >
                <option value="all">All findings</option>
                <option value="open">Open findings only</option>
                <option value="remediated">Remediated findings</option>
              </select>

              <button
                type="button"
                className="btn"
                disabled={runningScan}
                onClick={() => handleRunReconciliationScan(false)}
              >
                {runningScan ? 'Scanning SharePoint…' : 'Run reconciliation scan'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={runningScan}
                onClick={() => handleRunReconciliationScan(true)}
              >
                Scan & auto-remediate all
              </button>
            </div>
          </div>

          {filteredFindings.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                background: '#f8fafc',
                borderRadius: 8,
                fontSize: 13,
                color: '#475569',
              }}
            >
              No permission drift or reconciliation findings match the current
              filter. All verified SharePoint folders match their intended
              1Squared access policy.
            </div>
          ) : (
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                  <th style={{ padding: 8 }}>Scope</th>
                  <th style={{ padding: 8 }}>Finding Type</th>
                  <th style={{ padding: 8 }}>Severity</th>
                  <th style={{ padding: 8 }}>Status</th>
                  <th style={{ padding: 8 }}>Detected At</th>
                  <th style={{ padding: 8 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredFindings.map(
                  (finding: DocumentReconciliationFindingRecord) => (
                    <tr
                      key={finding.id}
                      style={{ borderBottom: '1px solid #f1f5f9' }}
                    >
                      <td style={{ padding: 8 }}>
                        <code>{finding.scopeIdentifier}</code>
                      </td>
                      <td style={{ padding: 8 }}>
                        <code>{finding.findingType}</code>
                      </td>
                      <td style={{ padding: 8 }}>
                        <span
                          className="pill"
                          style={{
                            background:
                              finding.severity === 'high' ? '#fef2f2' : '#fffbeb',
                            color:
                              finding.severity === 'high' ? '#dc2626' : '#b45309',
                            padding: '2px 8px',
                            borderRadius: 999,
                            fontSize: 11,
                          }}
                        >
                          {finding.severity}
                        </span>
                      </td>
                      <td style={{ padding: 8 }}>
                        <span
                          className="pill"
                          style={{
                            background:
                              finding.status === 'remediated'
                                ? '#dcfce7'
                                : '#fee2e2',
                            color:
                              finding.status === 'remediated'
                                ? '#166534'
                                : '#991b1b',
                            padding: '2px 8px',
                            borderRadius: 999,
                            fontSize: 11,
                          }}
                        >
                          {finding.status}
                        </span>
                      </td>
                      <td style={{ padding: 8 }}>
                        {new Date(finding.detectedAt).toLocaleString()}
                      </td>
                      <td style={{ padding: 8 }}>
                        {finding.status === 'open' ? (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => handleRemediateFinding(finding.id)}
                          >
                            Remediate
                          </button>
                        ) : (
                          <span style={{ fontSize: 12, color: '#64748b' }}>
                            Remediated by {finding.remediatedByUserId}
                          </span>
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
