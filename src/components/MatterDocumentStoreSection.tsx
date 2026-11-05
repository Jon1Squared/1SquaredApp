'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Edit3,
  ExternalLink,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Link2,
  Lock,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface MatterDocumentLocationSummary {
  id: string;
  matterId: string;
  storeId: string;
  providerContainerId: string;
  providerRootItemId: string;
  displayPath: string;
  webUrl: string;
  isPrimary: boolean;
  provisioningStatus: 'pending' | 'provisioned' | 'failed';
  lastProvisionedAt?: string | null;
  lastError?: string | null;
}

interface DocumentStoreItem {
  providerItemId: string;
  name: string;
  kind: 'folder' | 'file';
  sizeBytes: number;
  mimeType?: string;
  etag?: string;
  versionLabel?: string;
  createdAtIso: string;
  modifiedAtIso: string;
  modifiedByDisplayName?: string;
  webUrl?: string;
  parentItemId?: string;
  relativePath?: string;
}

interface EffectiveItemAccess {
  level: 'none' | 'read' | 'contribute' | 'edit' | 'manage';
  canDownload: boolean;
  canUpload: boolean;
  canCreateFolder: boolean;
  canRename: boolean;
  canMove: boolean;
  canDelete: boolean;
  canOpenInWeb: boolean;
  canOpenInClient: boolean;
}

interface BreadcrumbSegment {
  itemId: string;
  label: string;
}

export interface MatterDocumentStoreSectionProps {
  matterId: string;
  matterNumber: string;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatShortIso(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MatterDocumentStoreSection({
  matterId,
  matterNumber,
}: MatterDocumentStoreSectionProps) {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reauthChallenge, setReauthChallenge] = useState<string | null>(null);
  const [requiresEntraSignIn, setRequiresEntraSignIn] = useState(false);

  const [locations, setLocations] = useState<MatterDocumentLocationSummary[]>([]);
  const [activeLocation, setActiveLocation] = useState<MatterDocumentLocationSummary | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbSegment[]>([]);
  const [currentFolderItemId, setCurrentFolderItemId] = useState<string | undefined>(undefined);

  const [items, setItems] = useState<DocumentStoreItem[]>([]);
  const [effectiveAccess, setEffectiveAccess] = useState<EffectiveItemAccess | null>(null);
  const [restrictedAccess, setRestrictedAccess] = useState(false);
  const [isClosed, setIsClosed] = useState(false);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadProgressPct, setUploadProgressPct] = useState(0);
  const [conflictBehavior, setConflictBehavior] = useState<'rename' | 'replace' | 'fail'>('rename');
  const [dragOver, setDragOver] = useState(false);

  // Modals / inline actions
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingItem, setRenamingItem] = useState<DocumentStoreItem | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [movingItem, setMovingItem] = useState<DocumentStoreItem | null>(null);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState('');

  // Link existing folder modal
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linkStoreId, setLinkStoreId] = useState('sharepoint-primary');
  const [linkFolderUrl, setLinkFolderUrl] = useState('');
  const [linkingFolder, setLinkingFolder] = useState(false);

  const fetchDocuments = useCallback(
    async (locationId?: string, folderItemId?: string) => {
      setLoading(true);
      setErrorMessage(null);
      setReauthChallenge(null);
      try {
        const params = new URLSearchParams();
        if (locationId) params.set('locationId', locationId);
        if (folderItemId) params.set('folderItemId', folderItemId);

        const res = await fetch(
          `/api/matters/${encodeURIComponent(matterId)}/documents?${params.toString()}`,
          { cache: 'no-store' },
        );
        const data = await res.json();
        if (!res.ok) {
          if (data.code === 'REAUTHENTICATION_REQUIRED') {
            setReauthChallenge(data.claimsChallenge ?? 'MFA / Conditional Access required');
          }
          setErrorMessage(data.error ?? 'Failed to load matter document store');
          setLoading(false);
          return;
        }

        setRequiresEntraSignIn(Boolean(data.requiresEntraSignIn));
        setRestrictedAccess(Boolean(data.matter?.restrictedAccess));
        setIsClosed(Boolean(data.matter?.isClosed));
        const locs: MatterDocumentLocationSummary[] = data.locations ?? [];
        setLocations(locs);
        const actLoc: MatterDocumentLocationSummary | null =
          data.activeLocation ?? locs[0] ?? null;
        setActiveLocation(actLoc);
        setItems(data.items ?? []);
        setEffectiveAccess(data.effectiveAccess ?? null);

        if (actLoc && !folderItemId) {
          setCurrentFolderItemId(actLoc.providerRootItemId);
          setBreadcrumbs([
            {
              itemId: actLoc.providerRootItemId,
              label: actLoc.displayPath || matterNumber,
            },
          ]);
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Error loading documents');
      } finally {
        setLoading(false);
      }
    },
    [matterId, matterNumber],
  );

  useEffect(() => {
    queueMicrotask(() => {
      void fetchDocuments();
    });
  }, [fetchDocuments]);

  function handleNavigateFolder(folderItem: DocumentStoreItem) {
    if (!activeLocation) return;
    setCurrentFolderItemId(folderItem.providerItemId);
    setBreadcrumbs((prev) => [
      ...prev,
      { itemId: folderItem.providerItemId, label: folderItem.name },
    ]);
    void fetchDocuments(activeLocation.id, folderItem.providerItemId);
  }

  function handleBreadcrumbClick(index: number) {
    if (!activeLocation) return;
    const target = breadcrumbs[index];
    if (!target) return;
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
    setCurrentFolderItemId(target.itemId);
    void fetchDocuments(activeLocation.id, target.itemId);
  }

  async function handleRetryProvisioning() {
    setLoading(true);
    try {
      const res = await fetch(`/api/matters/${encodeURIComponent(matterId)}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry_provisioning' }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error ?? 'Provisioning retry failed');
      } else {
        showToast('Matter folders provisioned in SharePoint');
        await fetchDocuments();
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateFolder(e: React.FormEvent) {
    e.preventDefault();
    if (!activeLocation || !newFolderName.trim()) return;
    try {
      const res = await fetch(`/api/matters/${encodeURIComponent(matterId)}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_folder',
          locationId: activeLocation.id,
          parentItemId: currentFolderItemId ?? activeLocation.providerRootItemId,
          name: newFolderName.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error ?? 'Failed to create folder');
        return;
      }
      showToast(`Created folder "${newFolderName.trim()}"`);
      setNewFolderName('');
      setNewFolderOpen(false);
      await fetchDocuments(activeLocation.id, currentFolderItemId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create folder');
    }
  }

  async function handleUploadFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || !activeLocation) return;
    setUploading(true);
    setUploadProgressPct(15);

    try {
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let b = 0; b < bytes.byteLength; b++) {
          binary += String.fromCharCode(bytes[b]);
        }
        const contentBase64 = typeof window !== 'undefined' ? window.btoa(binary) : '';

        setUploadProgressPct(Math.round(((i + 0.5) / fileList.length) * 100));

        const res = await fetch(`/api/matters/${encodeURIComponent(matterId)}/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'upload_file',
            locationId: activeLocation.id,
            parentItemId: currentFolderItemId ?? activeLocation.providerRootItemId,
            name: file.name,
            contentBase64,
            mimeType: file.type || 'application/octet-stream',
            conflictBehavior,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error ?? `Upload failed for ${file.name}`);
        } else {
          showToast(`Uploaded ${data.item?.name ?? file.name} to SharePoint`);
        }
      }
      setUploadProgressPct(100);
      await fetchDocuments(activeLocation.id, currentFolderItemId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setUploadProgressPct(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleRenameSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeLocation || !renamingItem || !renameValue.trim()) return;
    const res = await fetch(`/api/matters/${encodeURIComponent(matterId)}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'rename_item',
        locationId: activeLocation.id,
        itemId: renamingItem.providerItemId,
        newName: renameValue.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? 'Rename failed');
      return;
    }
    showToast(`Renamed to "${renameValue.trim()}"`);
    setRenamingItem(null);
    setRenameValue('');
    await fetchDocuments(activeLocation.id, currentFolderItemId);
  }

  async function handleMoveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeLocation || !movingItem || !moveTargetFolderId) return;
    const res = await fetch(`/api/matters/${encodeURIComponent(matterId)}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'move_item',
        locationId: activeLocation.id,
        itemId: movingItem.providerItemId,
        targetFolderItemId: moveTargetFolderId,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? 'Move failed');
      return;
    }
    showToast(`Moved "${movingItem.name}"`);
    setMovingItem(null);
    setMoveTargetFolderId('');
    await fetchDocuments(activeLocation.id, currentFolderItemId);
  }

  async function handleDeleteItem(item: DocumentStoreItem) {
    if (!activeLocation) return;
    const res = await fetch(`/api/matters/${encodeURIComponent(matterId)}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'delete_item',
        locationId: activeLocation.id,
        itemId: item.providerItemId,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? 'Delete failed');
      return;
    }
    showToast(`Deleted "${item.name}"`);
    await fetchDocuments(activeLocation.id, currentFolderItemId);
  }

  async function handleOpenWebUrl(item: DocumentStoreItem, mode: 'web' | 'desktop') {
    if (!activeLocation) return;
    const res = await fetch(`/api/matters/${encodeURIComponent(matterId)}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'get_web_url',
        locationId: activeLocation.id,
        itemId: item.providerItemId,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? 'Unable to resolve SharePoint link');
      return;
    }
    const targetUrl =
      mode === 'desktop' && data.url?.desktopUrl ? data.url.desktopUrl : data.url?.webUrl;
    if (targetUrl && typeof window !== 'undefined') {
      window.open(targetUrl, '_blank', 'noopener,noreferrer');
    }
  }

  async function handleLinkExistingFolder(e: React.FormEvent) {
    e.preventDefault();
    if (!linkFolderUrl.trim()) return;
    setLinkingFolder(true);
    try {
      const res = await fetch(`/api/matters/${encodeURIComponent(matterId)}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'link_existing_folder',
          storeId: linkStoreId,
          folderUrl: linkFolderUrl.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error ?? 'Failed to link existing folder');
        return;
      }
      showToast(`Linked existing SharePoint folder: ${data.location?.displayPath ?? ''}`);
      setLinkModalOpen(false);
      setLinkFolderUrl('');
      await fetchDocuments(data.location?.id);
    } finally {
      setLinkingFolder(false);
    }
  }

  const folderChoices = items.filter((i) => i.kind === 'folder');
  const canMutate =
    !isClosed &&
    Boolean(
      effectiveAccess?.canUpload ||
        effectiveAccess?.canCreateFolder ||
        effectiveAccess?.canRename ||
        effectiveAccess?.canDelete,
    );

  return (
    <section className="home-panel" style={{ marginBottom: 18 }}>
      <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="panel-title-group" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h2 className="panel-title">SharePoint Document Store ({matterNumber})</h2>
          {activeLocation ? (
            <StatusPill
              label={
                activeLocation.provisioningStatus === 'provisioned'
                  ? 'SharePoint Provisioned'
                  : activeLocation.provisioningStatus === 'pending'
                    ? 'Provisioning Pending'
                    : 'Provisioning Failed'
              }
              tone={
                activeLocation.provisioningStatus === 'provisioned'
                  ? 'positive'
                  : activeLocation.provisioningStatus === 'pending'
                    ? 'warning'
                    : 'alert'
              }
            />
          ) : null}
          {restrictedAccess ? (
            <StatusPill label="Restricted Matter (Broken Inheritance)" tone="warning" />
          ) : (
            <StatusPill label="Inherits Department & Team Groups" tone="neutral" />
          )}
          {isClosed ? <StatusPill label="Matter Closed — Read-Only" tone="neutral" /> : null}
          {effectiveAccess ? (
            <StatusPill
              label={`Effective Access: ${effectiveAccess.level.toUpperCase()}`}
              tone={effectiveAccess.level === 'read' ? 'neutral' : 'positive'}
            />
          ) : null}
        </div>

        <div className="panel-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {locations.length > 1 ? (
            <select
              aria-label="Select linked document store location"
              className="field-select"
              style={{ height: 32, fontSize: 12.5 }}
              value={activeLocation?.id ?? ''}
              onChange={(e) => {
                setCurrentFolderItemId(undefined);
                void fetchDocuments(e.target.value, undefined);
              }}
            >
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.storeId} — {loc.displayPath} {loc.isPrimary ? '(Primary)' : ''}
                </option>
              ))}
            </select>
          ) : null}

          {activeLocation?.provisioningStatus === 'failed' ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={handleRetryProvisioning}
            >
              <RefreshCw size={13} />
              <span>Retry provisioning</span>
            </button>
          ) : null}

          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setLinkModalOpen((prev) => !prev)}
          >
            <Link2 size={13} />
            <span>Link existing folder</span>
          </button>

          {activeLocation?.webUrl ? (
            <a
              href={activeLocation.webUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn--secondary btn--sm"
            >
              <ExternalLink size={13} />
              <span>Open library in SharePoint</span>
            </a>
          ) : null}

          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void fetchDocuments(activeLocation?.id, currentFolderItemId)}
            title="Refresh folder contents"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      <div className="panel-body">
        {/* Entra identity notice */}
        {requiresEntraSignIn ? (
          <div
            className="subcard"
            style={{
              marginBottom: 14,
              borderLeft: '4px solid var(--pill-warning-fg, #b45309)',
              background: 'var(--pill-warning-bg, #fef3c7)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
              <Lock size={16} />
              <span>Microsoft Entra ID Sign-In Required for Live Delegated Access</span>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: 13 }}>
              Document store browsing, uploads and co-authoring execute under your personal
              Microsoft Entra ID identity (On-Behalf-Of flow) so SharePoint enforces your personal
              permissions and records your name in its audit trail. Sign in with your firm Entra ID
              account to use live SharePoint credentials.
            </p>
          </div>
        ) : null}

        {/* Conditional Access / MFA Re-authentication banner */}
        {reauthChallenge ? (
          <div
            className="subcard"
            style={{
              marginBottom: 14,
              borderLeft: '4px solid var(--pill-alert-fg, #b91c1c)',
              background: 'var(--pill-alert-bg, #fee2e2)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <strong>Re-authentication Required (Conditional Access / MFA Challenge)</strong>
                <div style={{ fontSize: 12.5, marginTop: 2 }}>
                  SharePoint requires an updated multi-factor or Conditional Access claim before
                  accessing this matter&apos;s documents.
                </div>
              </div>
              <a href="/api/auth/entra/login" className="btn btn--primary btn--sm">
                Sign in again with Entra ID
              </a>
            </div>
          </div>
        ) : null}

        {/* Error banner */}
        {errorMessage ? (
          <div
            className="subcard"
            style={{
              marginBottom: 14,
              borderLeft: '4px solid var(--pill-alert-fg, #b91c1c)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--pill-alert-fg, #b91c1c)', fontWeight: 600 }}>
              <AlertCircle size={16} />
              <span>{errorMessage}</span>
            </div>
          </div>
        ) : null}

        {/* Link existing folder inline drawer */}
        {linkModalOpen ? (
          <form
            onSubmit={handleLinkExistingFolder}
            className="subcard"
            style={{ marginBottom: 14, background: 'var(--bg-subtle)' }}
          >
            <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 14 }}>
              Link an existing SharePoint folder to {matterNumber}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="text"
                className="field-input"
                style={{ width: 200 }}
                value={linkStoreId}
                onChange={(e) => setLinkStoreId(e.target.value)}
                placeholder="Store ID"
              />
              <input
                type="url"
                required
                className="field-input"
                style={{ flex: 1, minWidth: 280 }}
                value={linkFolderUrl}
                onChange={(e) => setLinkFolderUrl(e.target.value)}
                placeholder="Paste SharePoint folder URL (e.g. https://1squared1.sharepoint.com/sites/NotALawFirm/Shared%20Documents/REAL_ESTATE/RES_CONV/...)"
              />
              <button type="submit" className="btn btn--primary btn--sm" disabled={linkingFolder}>
                {linkingFolder ? 'Linking…' : 'Verify & Link Folder'}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setLinkModalOpen(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {/* Breadcrumb bar + Folder & Upload toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            marginBottom: 12,
            padding: '8px 12px',
            background: 'var(--bg-subtle, #f8fafc)',
            borderRadius: 8,
            border: '1px solid var(--color-divider, #e2e8f0)',
          }}
        >
          <nav aria-label="Matter document folder breadcrumb" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 13 }}>
            <Folder size={15} color="var(--color-primary)" />
            {breadcrumbs.map((crumb, idx) => (
              <React.Fragment key={`${crumb.itemId}-${idx}`}>
                {idx > 0 ? <span className="muted">/</span> : null}
                <button
                  type="button"
                  onClick={() => handleBreadcrumbClick(idx)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    padding: '2px 4px',
                    cursor: 'pointer',
                    fontWeight: idx === breadcrumbs.length - 1 ? 700 : 500,
                    color: idx === breadcrumbs.length - 1 ? 'var(--text-primary)' : 'var(--color-primary)',
                  }}
                >
                  {crumb.label}
                </button>
              </React.Fragment>
            ))}
          </nav>

          {canMutate ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {effectiveAccess?.canCreateFolder ? (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => setNewFolderOpen((prev) => !prev)}
                >
                  <FolderPlus size={13} />
                  <span>New folder</span>
                </button>
              ) : null}

              {effectiveAccess?.canUpload ? (
                <>
                  <select
                    aria-label="Upload conflict behavior"
                    className="field-select"
                    style={{ height: 30, fontSize: 12, width: 'auto' }}
                    value={conflictBehavior}
                    onChange={(e) =>
                      setConflictBehavior(e.target.value as 'rename' | 'replace' | 'fail')
                    }
                  >
                    <option value="rename">On conflict: Auto-rename</option>
                    <option value="replace">On conflict: Replace (new version)</option>
                    <option value="fail">On conflict: Ask / fail</option>
                  </select>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => void handleUploadFiles(e.target.files)}
                  />
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload size={13} />
                    <span>{uploading ? `Uploading (${uploadProgressPct}%)…` : 'Upload files'}</span>
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* New folder inline form */}
        {newFolderOpen ? (
          <form
            onSubmit={handleCreateFolder}
            style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}
          >
            <input
              type="text"
              required
              autoFocus
              className="field-input"
              style={{ maxWidth: 320 }}
              placeholder="New subfolder name…"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
            />
            <button type="submit" className="btn btn--primary btn--sm">
              Create
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setNewFolderOpen(false)}
            >
              Cancel
            </button>
          </form>
        ) : null}

        {/* Rename inline form */}
        {renamingItem ? (
          <form
            onSubmit={handleRenameSubmit}
            className="subcard"
            style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}
          >
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Rename &ldquo;{renamingItem.name}&rdquo;:
            </span>
            <input
              type="text"
              required
              autoFocus
              className="field-input"
              style={{ maxWidth: 320 }}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
            />
            <button type="submit" className="btn btn--primary btn--sm">
              Save
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setRenamingItem(null)}
            >
              Cancel
            </button>
          </form>
        ) : null}

        {/* Move inline form */}
        {movingItem ? (
          <form
            onSubmit={handleMoveSubmit}
            className="subcard"
            style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}
          >
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Move &ldquo;{movingItem.name}&rdquo; to folder:
            </span>
            <select
              required
              className="field-select"
              style={{ maxWidth: 320 }}
              value={moveTargetFolderId}
              onChange={(e) => setMoveTargetFolderId(e.target.value)}
            >
              <option value="">Select destination folder…</option>
              {activeLocation ? (
                <option value={activeLocation.providerRootItemId}>
                  Matter Root ({activeLocation.displayPath})
                </option>
              ) : null}
              {folderChoices
                .filter((f) => f.providerItemId !== movingItem.providerItemId)
                .map((f) => (
                  <option key={f.providerItemId} value={f.providerItemId}>
                    {f.name}
                  </option>
                ))}
            </select>
            <button type="submit" className="btn btn--primary btn--sm">
              Move here
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setMovingItem(null)}
            >
              Cancel
            </button>
          </form>
        ) : null}

        {/* Drag and drop zone + Items table */}
        <div
          onDragOver={(e) => {
            if (!effectiveAccess?.canUpload || isClosed) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            if (!effectiveAccess?.canUpload || isClosed) return;
            e.preventDefault();
            setDragOver(false);
            void handleUploadFiles(e.dataTransfer.files);
          }}
          style={{
            border: dragOver ? '2px dashed var(--color-primary)' : '1px solid var(--color-divider, #e2e8f0)',
            borderRadius: 8,
            overflow: 'hidden',
            transition: 'border-color 0.15s ease',
          }}
        >
          {loading ? (
            <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
              Connecting to SharePoint Document Store…
            </div>
          ) : items.length === 0 ? (
            <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
              This folder is empty.{' '}
              {effectiveAccess?.canUpload && !isClosed
                ? 'Drag and drop files here or click Upload files above.'
                : ''}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
              <thead>
                <tr
                  style={{
                    textAlign: 'left',
                    borderBottom: '1px solid var(--color-divider, #e2e8f0)',
                    background: 'var(--bg-subtle, #f8fafc)',
                  }}
                >
                  <th style={{ padding: '10px 12px' }}>Name</th>
                  <th style={{ padding: '10px 12px' }}>Type</th>
                  <th style={{ padding: '10px 12px' }}>Size</th>
                  <th style={{ padding: '10px 12px' }}>Version</th>
                  <th style={{ padding: '10px 12px' }}>Modified</th>
                  <th style={{ padding: '10px 12px' }}>Modified By</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.providerItemId}
                    style={{ borderBottom: '1px solid var(--color-divider, #e2e8f0)' }}
                  >
                    <td style={{ padding: '10px 12px', fontWeight: 600 }}>
                      {item.kind === 'folder' ? (
                        <button
                          type="button"
                          onClick={() => handleNavigateFolder(item)}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 8,
                            border: 'none',
                            background: 'transparent',
                            padding: 0,
                            cursor: 'pointer',
                            color: 'var(--color-primary)',
                            fontWeight: 600,
                            fontSize: 'inherit',
                          }}
                        >
                          <Folder size={16} color="var(--color-primary)" />
                          <span>{item.name}</span>
                        </button>
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <FileText size={16} color="var(--text-secondary, #475569)" />
                          <span>{item.name}</span>
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      {item.kind === 'folder' ? 'Folder' : item.mimeType || 'Document'}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      {item.kind === 'folder' ? '—' : formatBytes(item.sizeBytes)}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      {item.versionLabel ? (
                        <StatusPill label={`v${item.versionLabel}`} tone="neutral" />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={{ padding: '10px 12px' }}>{formatShortIso(item.modifiedAtIso)}</td>
                    <td style={{ padding: '10px 12px' }}>{item.modifiedByDisplayName || '—'}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {item.kind === 'file' && effectiveAccess?.canDownload && activeLocation ? (
                          <a
                            href={`/api/matters/${encodeURIComponent(
                              matterId,
                            )}/documents?action=download&locationId=${encodeURIComponent(
                              activeLocation.id,
                            )}&itemId=${encodeURIComponent(item.providerItemId)}`}
                            className="btn btn--secondary btn--sm"
                            title="Download via delegated user stream"
                          >
                            <Download size={13} />
                            <span>Download</span>
                          </a>
                        ) : null}

                        {effectiveAccess?.canOpenInWeb ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() => void handleOpenWebUrl(item, 'web')}
                            title="Open in SharePoint / Office for the web"
                          >
                            <ExternalLink size={13} />
                            <span>SharePoint</span>
                          </button>
                        ) : null}

                        {item.kind === 'file' && effectiveAccess?.canOpenInClient ? (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => void handleOpenWebUrl(item, 'desktop')}
                            title="Co-author in Desktop Office app"
                          >
                            <span>App</span>
                          </button>
                        ) : null}

                        {!isClosed && effectiveAccess?.canRename ? (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => {
                              setRenamingItem(item);
                              setRenameValue(item.name);
                            }}
                            title="Rename"
                          >
                            <Edit3 size={13} />
                          </button>
                        ) : null}

                        {!isClosed && effectiveAccess?.canMove ? (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => {
                              setMovingItem(item);
                              setMoveTargetFolderId('');
                            }}
                            title="Move"
                          >
                            <FolderInput size={13} />
                          </button>
                        ) : null}

                        {!isClosed && effectiveAccess?.canDelete ? (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => void handleDeleteItem(item)}
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
