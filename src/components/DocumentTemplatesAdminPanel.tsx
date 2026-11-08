'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Copy,
  Download,
  FileCheck2,
  FileCode2,
  FilePlus2,
  FileText,
  History,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  approveTemplateVersionAction,
  exportTemplatePackageAction,
  getDocumentGenerationSnapshotAction,
  getTemplateUsageReportAction,
  importTemplatePackageAction,
  previewTemplateAction,
  rejectTemplateVersionAction,
  retireTemplateAction,
  rollbackTemplateVersionAction,
  submitTemplateVersionAction,
  updateDocumentGenerationConfigAction,
  updateTemplateDraftAction,
  uploadTemplateDraftAction,
} from '@/app/actions';
import {
  buildValidDocxArchive,
  findUnmappedPlaceholders,
  type DocumentOutputFormat,
  type DocumentTemplateRecord,
  type DocumentTemplateVersionRecord,
  type PlaceholderFilterName,
  type PromptedFieldDefinition,
  type PromptedFieldType,
  type StorageProviderId,
  type TemplatePackageManifest,
  type TemplatePlaceholderMapping,
} from '@/domain/documentGeneration';
import type {
  DocumentGenerationClientSnapshot,
  EnrichedTemplateUsageReportResult,
} from '@/server/documentGenerationServices';

type AdminDocSubTab =
  | 'templates'
  | 'approval_queue'
  | 'field_chooser'
  | 'usage'
  | 'settings';

function triggerDownload(
  bytes: Uint8Array | string,
  fileName: string,
  mimeType: string,
): void {
  if (typeof window === 'undefined') return;
  const blob =
    typeof bytes === 'string'
      ? new Blob([bytes], { type: mimeType })
      : new Blob([new Uint8Array(bytes)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

function triggerBase64Download(
  base64: string,
  fileName: string,
  mimeType: string,
): void {
  if (typeof window === 'undefined' || !base64) return;
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  triggerDownload(bytes, fileName, mimeType);
}

export function DocumentTemplatesAdminPanel({
  currentUserId,
}: {
  currentUserId: string;
}) {
  const [snapshot, setSnapshot] =
    useState<DocumentGenerationClientSnapshot | null>(null);
  const [usageReport, setUsageReport] =
    useState<EnrichedTemplateUsageReportResult | null>(null);
  const [activeSubTab, setActiveSubTab] =
    useState<AdminDocSubTab>('templates');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  // Upload New Template Form State
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState('Correspondence');
  const [newDescription, setNewDescription] = useState('');
  const [newOutputDocType, setNewOutputDocType] = useState('letter');
  const [newFilenamePattern, setNewFilenamePattern] = useState(
    '{{matter.reference}} - {{template.name}}',
  );
  const [newSourceContexts, setNewSourceContexts] = useState<
    Array<'matter' | 'client'>
  >(['matter', 'client']);
  const [sampleBodyText, setSampleBodyText] = useState(
    'Dear {{ party.recipient.salutation }},\n\nRe: {{ matter.title }} (Our Ref: {{ matter.reference }})\n\nWe write on behalf of {{ client.name }} regarding {{ prompted.customSummary }}.\n\nYours faithfully,\n{{ feeEarner.fullName }}',
  );

  // Draft Editor State
  const [draftMappings, setDraftMappings] = useState<
    Record<string, TemplatePlaceholderMapping>
  >({});
  const [draftPrompted, setDraftPrompted] = useState<PromptedFieldDefinition[]>(
    [],
  );
  const [newPromptedKey, setNewPromptedKey] = useState('');
  const [newPromptedLabel, setNewPromptedLabel] = useState('');
  const [newPromptedType, setNewPromptedType] =
    useState<PromptedFieldType>('text');
  const [newPromptedRequired, setNewPromptedRequired] = useState(true);

  // Rejection Reason State
  const [rejectionReasons, setRejectionReasons] = useState<
    Record<string, string>
  >({});

  // Field Chooser Search
  const [catalogueSearch, setCatalogueSearch] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Usage Filters
  const [usageFromDate, setUsageFromDate] = useState('');
  const [usageToDate, setUsageToDate] = useState('');

  const loadData = useCallback(async () => {
    try {
      const snap = await getDocumentGenerationSnapshotAction();
      setSnapshot(snap);
      if (
        snap.userPermissions.includes('document_template:view_usage')
      ) {
        const rep = await getTemplateUsageReportAction({
          fromDate: usageFromDate || undefined,
          toDate: usageToDate || undefined,
        });
        setUsageReport(rep);
      }
    } catch (err) {
      setBanner({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to load document generation snapshot.',
      });
    }
  }, [usageFromDate, usageToDate]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadData();
    });
  }, [loadData, currentUserId]);

  useEffect(() => {
    if (snapshot && snapshot.templates.length > 0 && !selectedTemplateId) {
      const first = snapshot.templates[0]!;
      queueMicrotask(() => setSelectedTemplateId(first.id));
    }
  }, [snapshot, selectedTemplateId]);

  const selectedTemplate: DocumentTemplateRecord | null = useMemo(
    () =>
      snapshot?.templates.find((t) => t.id === selectedTemplateId) ??
      snapshot?.templates[0] ??
      null,
    [snapshot, selectedTemplateId],
  );

  const versionsForSelectedTemplate = useMemo(
    () =>
      snapshot?.versions
        .filter((v) => v.templateId === selectedTemplate?.id)
        .sort((a, b) => b.versionNumber - a.versionNumber) ?? [],
    [snapshot, selectedTemplate],
  );

  useEffect(() => {
    if (versionsForSelectedTemplate.length > 0) {
      const match = versionsForSelectedTemplate.find(
        (v) => v.id === selectedVersionId,
      );
      if (!match) {
        const nextId = versionsForSelectedTemplate[0]!.id;
        queueMicrotask(() => setSelectedVersionId(nextId));
      }
    } else {
      queueMicrotask(() => setSelectedVersionId(''));
    }
  }, [versionsForSelectedTemplate, selectedVersionId]);

  const selectedVersion: DocumentTemplateVersionRecord | null = useMemo(
    () =>
      versionsForSelectedTemplate.find((v) => v.id === selectedVersionId) ??
      versionsForSelectedTemplate[0] ??
      null,
    [versionsForSelectedTemplate, selectedVersionId],
  );

  useEffect(() => {
    if (selectedVersion) {
      const nextMappings = { ...selectedVersion.fieldMappings };
      const nextPrompted = [...selectedVersion.promptedFields];
      queueMicrotask(() => {
        setDraftMappings(nextMappings);
        setDraftPrompted(nextPrompted);
      });
    }
  }, [selectedVersion]);

  const canBuild =
    snapshot?.userPermissions.includes('document_template:build') ?? false;
  const canApprove =
    snapshot?.userPermissions.includes('document_template:approve') ?? false;
  const canViewUsage =
    snapshot?.userPermissions.includes('document_template:view_usage') ?? false;

  const submittedVersions = useMemo(
    () => snapshot?.versions.filter((v) => v.status === 'Submitted') ?? [],
    [snapshot],
  );

  const unmappedInSelectedVersion = useMemo(() => {
    if (!selectedVersion || !snapshot) return [];
    return findUnmappedPlaceholders(
      {
        extractedPlaceholders: selectedVersion.extractedPlaceholders,
        fieldMappings: draftMappings,
        promptedFields: draftPrompted,
      },
      snapshot.readableCatalogueFields.map((f) => ({
        ...f,
        resolve: () => '',
      })),
    );
  }, [selectedVersion, snapshot, draftMappings, draftPrompted]);

  const usageByTemplateId = useMemo(() => {
    const map = new Map<
      string,
      { last30d: number; last90d: number; lastGeneratedAt: string | null }
    >();
    for (const row of usageReport?.templates ?? []) {
      map.set(row.templateId, {
        last30d: row.last30DaysGeneratedCount,
        last90d: row.last90DaysGeneratedCount,
        lastGeneratedAt: row.lastGeneratedAt,
      });
    }
    return map;
  }, [usageReport]);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setBanner(null);
    try {
      const arrayBuf = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
      }
      const docxBase64 = window.btoa(binary);

      const res = await uploadTemplateDraftAction({
        templateId: showUploadForm ? undefined : selectedTemplate?.id,
        code:
          newCode.trim() ||
          selectedTemplate?.code ||
          `TPL-${Date.now().toString(36).toUpperCase()}`,
        name:
          newName.trim() ||
          selectedTemplate?.name ||
          file.name.replace(/\.docx$/i, ''),
        description:
          newDescription.trim() ||
          selectedTemplate?.description ||
          'Uploaded Word template',
        category: newCategory || selectedTemplate?.category || 'General',
        outputDocumentType:
          newOutputDocType ||
          selectedTemplate?.outputDocumentType ||
          'letter',
        filenamePattern:
          newFilenamePattern ||
          selectedTemplate?.filenamePattern ||
          '{{matter.reference}} - {{template.name}}',
        availabilityRules: {
          sourceContexts: newSourceContexts,
        },
        fileName: file.name,
        docxBase64,
      });

      setSelectedTemplateId(res.template.id);
      setSelectedVersionId(res.version.id);
      setShowUploadForm(false);
      setBanner({
        tone: 'success',
        text: `Uploaded "${file.name}" as Draft v${res.version.versionNumber} (${res.version.extractedPlaceholders.length} placeholders detected, ${res.unmappedPlaceholders.length} unmapped).`,
      });
      await loadData();
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Upload failed.',
      });
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  async function handleCreateQuickDocxDraft() {
    if (!newCode.trim() || !newName.trim()) {
      setBanner({
        tone: 'error',
        text: 'Please provide both a Template Code and Template Name.',
      });
      return;
    }
    setBusy(true);
    setBanner(null);
    try {
      const paragraphs = sampleBodyText
        .split(/\r?\n/)
        .map((line) => ({ text: line }));
      const docxBytes = buildValidDocxArchive({
        headerText: '{{ firm.registeredName }} | Ref: {{ matter.reference }}',
        footerText: 'Generated on {{ date.today | date:"d MMMM yyyy" }}',
        paragraphs,
      });

      let binary = '';
      for (let i = 0; i < docxBytes.length; i++) {
        binary += String.fromCharCode(docxBytes[i]!);
      }
      const docxBase64 = window.btoa(binary);

      const res = await uploadTemplateDraftAction({
        code: newCode.trim().toUpperCase(),
        name: newName.trim(),
        description: newDescription.trim() || newName.trim(),
        category: newCategory,
        outputDocumentType: newOutputDocType,
        filenamePattern: newFilenamePattern,
        availabilityRules: {
          sourceContexts: newSourceContexts,
        },
        fileName: `${newCode.trim().toLowerCase()}.docx`,
        docxBase64,
      });

      setSelectedTemplateId(res.template.id);
      setSelectedVersionId(res.version.id);
      setShowUploadForm(false);
      setBanner({
        tone: 'success',
        text: `Created "${res.template.name}" (v${res.version.versionNumber} Draft) with ${res.version.extractedPlaceholders.length} placeholders.`,
      });
      await loadData();
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Failed to create draft.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDraftMappings() {
    if (!selectedVersion) return;
    setBusy(true);
    setBanner(null);
    try {
      const res = await updateTemplateDraftAction({
        versionId: selectedVersion.id,
        fieldMappings: draftMappings,
        promptedFields: draftPrompted,
      });
      setBanner({
        tone: 'success',
        text: `Saved mappings for v${res.version.versionNumber} (${res.unmappedPlaceholders.length} unmapped remaining).`,
      });
      await loadData();
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Failed to save mappings.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitForApproval() {
    if (!selectedVersion) return;
    setBusy(true);
    setBanner(null);
    try {
      await updateTemplateDraftAction({
        versionId: selectedVersion.id,
        fieldMappings: draftMappings,
        promptedFields: draftPrompted,
      });
      const res = await submitTemplateVersionAction(selectedVersion.id);
      setBanner({
        tone: 'success',
        text:
          res.version.status === 'Active'
            ? `Activated "${res.template.name}" v${res.version.versionNumber} (approval not required).`
            : `Submitted "${res.template.name}" v${res.version.versionNumber} to the Approval Queue.`,
      });
      await loadData();
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Submission failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveVersion(versionId: string) {
    setBusy(true);
    setBanner(null);
    try {
      const res = await approveTemplateVersionAction(versionId);
      setBanner({
        tone: 'success',
        text: `Approved "${res.template.name}" v${res.version.versionNumber} — now Active.`,
      });
      await loadData();
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Approval failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleRejectVersion(versionId: string) {
    const reason = rejectionReasons[versionId]?.trim() ?? '';
    if (!reason) {
      setBanner({
        tone: 'error',
        text: 'Please enter a rejection reason before rejecting.',
      });
      return;
    }
    setBusy(true);
    setBanner(null);
    try {
      const res = await rejectTemplateVersionAction(versionId, reason);
      setBanner({
        tone: 'success',
        text: `Rejected "${res.template.name}" v${res.version.versionNumber}.`,
      });
      await loadData();
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Rejection failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleRetireTemplate(templateId: string) {
    setBusy(true);
    setBanner(null);
    try {
      const res = await retireTemplateAction(templateId);
      setBanner({
        tone: 'success',
        text: `Retired template "${res.name}".`,
      });
      await loadData();
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Retire failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleRollback(templateId: string, targetVersionId: string) {
    setBusy(true);
    setBanner(null);
    try {
      const res = await rollbackTemplateVersionAction(
        templateId,
        targetVersionId,
      );
      setBanner({
        tone: 'success',
        text: `Rolled back "${res.template.name}" to v${res.activeVersion.versionNumber} (now Active).`,
      });
      await loadData();
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Rollback failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handlePreviewVersion(
    versionId: string,
    format: DocumentOutputFormat,
  ) {
    setBusy(true);
    setBanner(null);
    try {
      const res = await previewTemplateAction({
        versionId,
        outputFormat: format,
      });
      if (res.fileBase64) {
        triggerBase64Download(res.fileBase64, res.fileName, res.mimeType);
      } else if (res.missingRequiredFields.length > 0) {
        setBanner({
          tone: 'error',
          text: `Preview missing required fields: ${res.missingRequiredFields.join(', ')}`,
        });
      }
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Preview failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleExportPackage(templateId: string, versionId?: string) {
    setBusy(true);
    setBanner(null);
    try {
      const pkg = await exportTemplatePackageAction(templateId, versionId);
      const jsonStr = JSON.stringify(pkg, null, 2);
      triggerDownload(
        jsonStr,
        `${pkg.template.code.toLowerCase()}.docpkg.json`,
        'application/json',
      );
      setBanner({
        tone: 'success',
        text: `Exported template package "${pkg.template.code}.docpkg.json".`,
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Package export failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleImportPackageFile(
    e: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setBanner(null);
    try {
      const rawText = await file.text();
      const pkg = JSON.parse(rawText) as TemplatePackageManifest;
      const res = await importTemplatePackageAction(pkg);
      setSelectedTemplateId(res.template.id);
      setSelectedVersionId(res.version.id);
      setBanner({
        tone: 'success',
        text: `Imported "${res.template.name}" as Draft v${res.version.versionNumber}. It must be approved before activation.${res.validationWarnings.length ? ` Warnings: ${res.validationWarnings.join(' ')}` : ''}`,
      });
      await loadData();
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Package import failed.',
      });
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  function addPromptedField() {
    const key = newPromptedKey.trim().replace(/[^a-zA-Z0-9_]/g, '');
    const label = newPromptedLabel.trim();
    if (!key || !label) return;
    setDraftPrompted((prev) => [
      ...prev.filter((p) => p.key !== key),
      {
        key,
        label,
        fieldType: newPromptedType,
        required: newPromptedRequired,
      },
    ]);
    setNewPromptedKey('');
    setNewPromptedLabel('');
  }

  const groupedCatalogue = useMemo(() => {
    const fields = snapshot?.readableCatalogueFields ?? [];
    const q = catalogueSearch.trim().toLowerCase();
    const filtered = q
      ? fields.filter(
          (f) =>
            f.key.toLowerCase().includes(q) ||
            f.displayName.toLowerCase().includes(q) ||
            f.group.toLowerCase().includes(q),
        )
      : fields;
    const byGroup = new Map<string, typeof filtered>();
    for (const f of filtered) {
      const list = byGroup.get(f.group) ?? [];
      list.push(f);
      byGroup.set(f.group, list);
    }
    return Array.from(byGroup.entries());
  }, [snapshot, catalogueSearch]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Sub-navigation bar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 16px',
          background: '#ffffff',
          borderRadius: 12,
          border: '1px solid #e2e8f0',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            className={`btn btn--sm ${activeSubTab === 'templates' ? 'btn--primary' : 'btn--secondary'}`}
            onClick={() => setActiveSubTab('templates')}
          >
            <FileText size={14} />
            <span>Templates &amp; Mapper ({snapshot?.templates.length ?? 0})</span>
          </button>

          {canApprove ? (
            <button
              type="button"
              className={`btn btn--sm ${activeSubTab === 'approval_queue' ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setActiveSubTab('approval_queue')}
            >
              <ShieldCheck size={14} />
              <span>
                Approval Queue ({submittedVersions.length})
              </span>
            </button>
          ) : null}

          <button
            type="button"
            className={`btn btn--sm ${activeSubTab === 'field_chooser' ? 'btn--primary' : 'btn--secondary'}`}
            onClick={() => setActiveSubTab('field_chooser')}
          >
            <BookOpen size={14} />
            <span>
              Field Catalogue ({snapshot?.readableCatalogueFields.length ?? 0})
            </span>
          </button>

          {canViewUsage ? (
            <button
              type="button"
              className={`btn btn--sm ${activeSubTab === 'usage' ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setActiveSubTab('usage')}
            >
              <BarChart3 size={14} />
              <span>Usage &amp; Analytics</span>
            </button>
          ) : null}

          {canBuild ? (
            <button
              type="button"
              className={`btn btn--sm ${activeSubTab === 'settings' ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setActiveSubTab('settings')}
            >
              <Settings size={14} />
              <span>Storage &amp; Governance</span>
            </button>
          ) : null}
        </div>

        {canBuild ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label
              className="btn btn--secondary btn--sm"
              style={{ cursor: 'pointer', margin: 0 }}
            >
              <Upload size={14} />
              <span>Import Package (.docpkg.json)</span>
              <input
                type="file"
                accept=".json"
                style={{ display: 'none' }}
                onChange={handleImportPackageFile}
              />
            </label>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                setShowUploadForm((prev) => !prev);
                setActiveSubTab('templates');
              }}
            >
              <FilePlus2 size={14} />
              <span>+ New Template</span>
            </button>
          </div>
        ) : null}
      </div>

      {banner ? (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 10,
            background: banner.tone === 'success' ? '#ecfdf5' : '#fef2f2',
            border: `1px solid ${banner.tone === 'success' ? '#a7f3d0' : '#fecaca'}`,
            color: banner.tone === 'success' ? '#065f46' : '#991b1b',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {banner.tone === 'success' ? (
            <CheckCircle2 size={16} />
          ) : (
            <AlertTriangle size={16} />
          )}
          <span>{banner.text}</span>
        </div>
      ) : null}

      {/* Upload / Quick Builder Drawer */}
      {showUploadForm && canBuild ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h3 className="panel-title">Create or Upload Word (.docx) Template</h3>
              <p className="panel-subtitle">
                Upload a <code>.docx</code> file from disk or generate a Word
                template directly from placeholder text below. Macro-enabled{' '}
                <code>.docm</code> files and reserved <code>{'{% ... %}'}</code>{' '}
                blocks are automatically rejected.
              </p>
            </div>
          </div>
          <div
            className="panel-body"
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 12,
              }}
            >
              <div>
                <label style={{ fontSize: 12, fontWeight: 700 }}>
                  Template Code *
                </label>
                <input
                  className="input"
                  placeholder="e.g. LBA-DEBT-01"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 700 }}>
                  Template Name *
                </label>
                <input
                  className="input"
                  placeholder="e.g. Letter Before Action"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 700 }}>
                  Category
                </label>
                <input
                  className="input"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                />
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr',
                gap: 12,
              }}
            >
              <div>
                <label style={{ fontSize: 12, fontWeight: 700 }}>
                  Output Document Type
                </label>
                <select
                  className="input"
                  value={newOutputDocType}
                  onChange={(e) => setNewOutputDocType(e.target.value)}
                >
                  <option value="letter">Letter</option>
                  <option value="client_care">Client Care Letter</option>
                  <option value="attendance_note">Attendance Note</option>
                  <option value="court_form">Court / Tribunal Form</option>
                  <option value="agreement">Agreement / Contract</option>
                  <option value="memorandum">Advice Memorandum</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 700 }}>
                  Generated Filename Pattern
                </label>
                <input
                  className="input"
                  value={newFilenamePattern}
                  onChange={(e) => setNewFilenamePattern(e.target.value)}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 700 }}>
                  Available On Screens
                </label>
                <select
                  className="input"
                  value={newSourceContexts.join(',')}
                  onChange={(e) =>
                    setNewSourceContexts(
                      e.target.value.split(',') as Array<'matter' | 'client'>,
                    )
                  }
                >
                  <option value="matter,client">Both Matter &amp; Client</option>
                  <option value="matter">Matter Only</option>
                  <option value="client">Client Only</option>
                </select>
              </div>
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 700 }}>
                Description
              </label>
              <input
                className="input"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
              />
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 700 }}>
                Option A: Quick-Build .docx from Placeholder Text
              </label>
              <textarea
                className="input"
                rows={4}
                value={sampleBodyText}
                onChange={(e) => setSampleBodyText(e.target.value)}
              />
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: 8,
              }}
            >
              <label
                className="btn btn--secondary btn--sm"
                style={{ cursor: 'pointer', margin: 0 }}
              >
                <Upload size={14} />
                <span>Option B: Upload .docx File from Computer</span>
                <input
                  type="file"
                  accept=".docx"
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
                />
              </label>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setShowUploadForm(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={busy}
                  onClick={handleCreateQuickDocxDraft}
                >
                  <FileCode2 size={14} />
                  <span>Create .docx Draft</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* TAB 1: TEMPLATES & MAPPER */}
      {activeSubTab === 'templates' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '320px 1fr',
            gap: 18,
            alignItems: 'start',
          }}
        >
          {/* Left: Template List */}
          <section className="panel">
            <div className="panel-header">
              <h3 className="panel-title">Templates</h3>
            </div>
            <div className="panel-body" style={{ padding: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(snapshot?.templates ?? []).map((tpl) => {
                  const isSelected = tpl.id === selectedTemplate?.id;
                  const usage = usageByTemplateId.get(tpl.id);
                  return (
                    <div
                      key={tpl.id}
                      onClick={() => setSelectedTemplateId(tpl.id)}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 9,
                        cursor: 'pointer',
                        background: isSelected ? '#eff6ff' : '#f8fafc',
                        border: `1px solid ${isSelected ? '#3b82f6' : '#e2e8f0'}`,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 6,
                        }}
                      >
                        <strong style={{ fontSize: 13 }}>{tpl.name}</strong>
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            padding: '1px 7px',
                            borderRadius: 999,
                            background:
                              tpl.status === 'Active'
                                ? '#dcfce7'
                                : tpl.status === 'Submitted'
                                  ? '#fef3c7'
                                  : '#e2e8f0',
                            color:
                              tpl.status === 'Active'
                                ? '#166534'
                                : tpl.status === 'Submitted'
                                  ? '#92400e'
                                  : '#475569',
                          }}
                        >
                          {tpl.status}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: '#64748b',
                          marginTop: 4,
                        }}
                      >
                        <code>{tpl.code}</code> · {tpl.category}
                      </div>
                      {usage ? (
                        <div
                          style={{
                            fontSize: 11,
                            color: '#475569',
                            marginTop: 4,
                          }}
                        >
                          30d: <strong>{usage.last30d}</strong> · 90d:{' '}
                          <strong>{usage.last90d}</strong>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* Right: Selected Template & Version Mapper */}
          {selectedTemplate && selectedVersion ? (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h3 className="panel-title">
                    {selectedTemplate.name} (<code>{selectedTemplate.code}</code>)
                  </h3>
                  <p className="panel-subtitle">
                    {selectedTemplate.description} · Filename pattern:{' '}
                    <code>{selectedTemplate.filenamePattern}</code>
                  </p>
                </div>
                <div
                  className="panel-actions"
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
                >
                  <select
                    className="input"
                    style={{ width: 'auto' }}
                    value={selectedVersion.id}
                    onChange={(e) => setSelectedVersionId(e.target.value)}
                  >
                    {versionsForSelectedTemplate.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.versionNumber} — {v.status} ({v.scanStatus})
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    disabled={busy}
                    onClick={() =>
                      handlePreviewVersion(selectedVersion.id, 'docx')
                    }
                  >
                    <Download size={13} />
                    <span>Preview DOCX</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    disabled={busy}
                    onClick={() =>
                      handlePreviewVersion(selectedVersion.id, 'pdf')
                    }
                  >
                    <Download size={13} />
                    <span>Preview PDF</span>
                  </button>

                  {canBuild ? (
                    <>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={busy}
                        onClick={() =>
                          handleExportPackage(
                            selectedTemplate.id,
                            selectedVersion.id,
                          )
                        }
                      >
                        <Download size={13} />
                        <span>Export Package</span>
                      </button>
                      <label
                        className="btn btn--secondary btn--sm"
                        style={{ cursor: 'pointer', margin: 0 }}
                      >
                        <Upload size={13} />
                        <span>Upload New Version (.docx)</span>
                        <input
                          type="file"
                          accept=".docx"
                          style={{ display: 'none' }}
                          onChange={handleFileUpload}
                        />
                      </label>
                    </>
                  ) : null}

                  {canApprove && selectedTemplate.status === 'Active' ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy}
                      onClick={() => handleRetireTemplate(selectedTemplate.id)}
                    >
                      <XCircle size={14} />
                      <span>Retire</span>
                    </button>
                  ) : null}

                  {canApprove &&
                  selectedVersion.status === 'Retired' &&
                  selectedVersion.reviewedByUserId ? (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={busy}
                      onClick={() =>
                        handleRollback(selectedTemplate.id, selectedVersion.id)
                      }
                    >
                      <RotateCcw size={14} />
                      <span>Roll Back to v{selectedVersion.versionNumber}</span>
                    </button>
                  ) : null}
                </div>
              </div>

              <div
                className="panel-body"
                style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
              >
                {/* Version Status & Usage Summary Bar */}
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '10px 14px',
                    borderRadius: 8,
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    fontSize: 12.5,
                  }}
                >
                  <div>
                    <strong>Version v{selectedVersion.versionNumber}:</strong>{' '}
                    {selectedVersion.status} · Engine:{' '}
                    <code>{selectedVersion.engine}</code> · Malware Scan:{' '}
                    <code>{selectedVersion.scanStatus}</code> · SHA-256:{' '}
                    <code>{selectedVersion.fileSha256.slice(0, 12)}…</code>
                  </div>
                  {usageByTemplateId.get(selectedTemplate.id) ? (
                    <div>
                      <strong>Usage:</strong>{' '}
                      {usageByTemplateId.get(selectedTemplate.id)!.last30d} in
                      last 30d ·{' '}
                      {usageByTemplateId.get(selectedTemplate.id)!.last90d} in
                      last 90d
                    </div>
                  ) : null}
                </div>

                {selectedVersion.rejectionReason ? (
                  <div
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      background: '#fef2f2',
                      border: '1px solid #fecaca',
                      color: '#991b1b',
                      fontSize: 12.5,
                    }}
                  >
                    <strong>Rejected Reason:</strong>{' '}
                    {selectedVersion.rejectionReason}
                  </div>
                ) : null}

                {unmappedInSelectedVersion.length > 0 ? (
                  <div
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      background: '#fffbeb',
                      border: '1px solid #fde68a',
                      color: '#92400e',
                      fontSize: 12.5,
                    }}
                  >
                    <strong>
                      Unmapped Placeholders ({unmappedInSelectedVersion.length}):
                    </strong>{' '}
                    {unmappedInSelectedVersion.join(', ')} — map all placeholders
                    below before submitting for approval.
                  </div>
                ) : null}

                {/* Placeholder Mapping Table */}
                <div>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>
                    Placeholder Mappings ({selectedVersion.extractedPlaceholders.length})
                  </h4>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="table" style={{ fontSize: 12.5 }}>
                      <thead>
                        <tr>
                          <th>Placeholder in .docx</th>
                          <th>Source Type</th>
                          <th>Mapped Field / Prompted Key</th>
                          <th>Format Filter</th>
                          <th>Fallback Text</th>
                          <th>Required</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedVersion.extractedPlaceholders.map((ph) => {
                          const mapping = draftMappings[ph.identifier] ?? {
                            placeholder: ph.identifier,
                            sourceType: 'catalogue' as const,
                            catalogueKey: '',
                            required: false,
                          };
                          const isDraft =
                            selectedVersion.status === 'Draft' && canBuild;

                          return (
                            <tr key={ph.identifier}>
                              <td>
                                <code>{ph.rawToken}</code>
                              </td>
                              <td>
                                <select
                                  className="input"
                                  disabled={!isDraft}
                                  value={mapping.sourceType}
                                  onChange={(e) =>
                                    setDraftMappings((prev) => ({
                                      ...prev,
                                      [ph.identifier]: {
                                        ...mapping,
                                        sourceType: e.target.value as
                                          | 'catalogue'
                                          | 'prompted',
                                      },
                                    }))
                                  }
                                >
                                  <option value="catalogue">
                                    Field Catalogue
                                  </option>
                                  <option value="prompted">
                                    Prompted at Generation
                                  </option>
                                </select>
                              </td>
                              <td>
                                {mapping.sourceType === 'catalogue' ? (
                                  <select
                                    className="input"
                                    disabled={!isDraft}
                                    value={mapping.catalogueKey ?? ''}
                                    onChange={(e) =>
                                      setDraftMappings((prev) => ({
                                        ...prev,
                                        [ph.identifier]: {
                                          ...mapping,
                                          catalogueKey: e.target.value,
                                        },
                                      }))
                                    }
                                  >
                                    <option value="">
                                      — Select Catalogue Field —
                                    </option>
                                    {(
                                      snapshot?.readableCatalogueFields ?? []
                                    ).map((cf) => (
                                      <option key={cf.key} value={cf.key}>
                                        [{cf.group}] {cf.displayName} ({cf.key})
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <select
                                    className="input"
                                    disabled={!isDraft}
                                    value={mapping.promptedKey ?? ''}
                                    onChange={(e) =>
                                      setDraftMappings((prev) => ({
                                        ...prev,
                                        [ph.identifier]: {
                                          ...mapping,
                                          promptedKey: e.target.value,
                                        },
                                      }))
                                    }
                                  >
                                    <option value="">
                                      — Select Prompted Field —
                                    </option>
                                    {draftPrompted.map((pf) => (
                                      <option key={pf.key} value={pf.key}>
                                        {pf.label} ({pf.key})
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </td>
                              <td>
                                <select
                                  className="input"
                                  disabled={!isDraft}
                                  value={mapping.formatFilter ?? ''}
                                  onChange={(e) =>
                                    setDraftMappings((prev) => ({
                                      ...prev,
                                      [ph.identifier]: {
                                        ...mapping,
                                        formatFilter: (e.target.value ||
                                          undefined) as
                                          | PlaceholderFilterName
                                          | undefined,
                                      },
                                    }))
                                  }
                                >
                                  <option value="">Default / Inline</option>
                                  <option value="date">Date (d MMMM yyyy)</option>
                                  <option value="currency">Currency (£ GBP)</option>
                                  <option value="words">Amount in Words</option>
                                  <option value="upper">UPPERCASE</option>
                                  <option value="title">Title Case</option>
                                  <option value="address_single">
                                    Address (Single-Line)
                                  </option>
                                  <option value="address_multi">
                                    Address (Multi-Line)
                                  </option>
                                </select>
                              </td>
                              <td>
                                <input
                                  className="input"
                                  disabled={!isDraft}
                                  placeholder="Optional fallback…"
                                  value={mapping.fallbackText ?? ''}
                                  onChange={(e) =>
                                    setDraftMappings((prev) => ({
                                      ...prev,
                                      [ph.identifier]: {
                                        ...mapping,
                                        fallbackText: e.target.value,
                                      },
                                    }))
                                  }
                                />
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  disabled={!isDraft}
                                  checked={Boolean(mapping.required)}
                                  onChange={(e) =>
                                    setDraftMappings((prev) => ({
                                      ...prev,
                                      [ph.identifier]: {
                                        ...mapping,
                                        required: e.target.checked,
                                      },
                                    }))
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

                {/* Prompted Fields Configurator */}
                <div>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>
                    Prompted Fields ({draftPrompted.length})
                  </h4>
                  {draftPrompted.length > 0 ? (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                        marginBottom: 10,
                      }}
                    >
                      {draftPrompted.map((pf) => (
                        <span
                          key={pf.key}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 999,
                            background: '#f1f5f9',
                            border: '1px solid #cbd5e1',
                            fontSize: 12,
                          }}
                        >
                          <strong>{pf.label}</strong> (<code>{pf.key}</code> ·{' '}
                          {pf.fieldType}
                          {pf.required ? ' · required' : ''})
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {selectedVersion.status === 'Draft' && canBuild ? (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                        alignItems: 'center',
                      }}
                    >
                      <input
                        className="input"
                        style={{ width: 170 }}
                        placeholder="Prompt key (e.g. letterBody)"
                        value={newPromptedKey}
                        onChange={(e) => setNewPromptedKey(e.target.value)}
                      />
                      <input
                        className="input"
                        style={{ width: 210 }}
                        placeholder="Prompt label"
                        value={newPromptedLabel}
                        onChange={(e) => setNewPromptedLabel(e.target.value)}
                      />
                      <select
                        className="input"
                        style={{ width: 120 }}
                        value={newPromptedType}
                        onChange={(e) =>
                          setNewPromptedType(
                            e.target.value as PromptedFieldType,
                          )
                        }
                      >
                        <option value="text">Text</option>
                        <option value="date">Date</option>
                        <option value="number">Number</option>
                        <option value="choice">Choice</option>
                      </select>
                      <label
                        style={{
                          fontSize: 12,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={newPromptedRequired}
                          onChange={(e) =>
                            setNewPromptedRequired(e.target.checked)
                          }
                        />
                        Required
                      </label>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={addPromptedField}
                      >
                        + Add Prompted Field
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* Draft Actions Footer */}
                {selectedVersion.status === 'Draft' && canBuild ? (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'flex-end',
                      gap: 10,
                      paddingTop: 10,
                      borderTop: '1px solid #e2e8f0',
                    }}
                  >
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={busy}
                      onClick={handleSaveDraftMappings}
                    >
                      Save Draft Mappings
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={busy || unmappedInSelectedVersion.length > 0}
                      onClick={handleSubmitForApproval}
                    >
                      <Send size={14} />
                      <span>Submit for Approval</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {/* TAB 2: APPROVAL QUEUE */}
      {activeSubTab === 'approval_queue' && canApprove ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h3 className="panel-title">
                Template Approval Queue ({submittedVersions.length})
              </h3>
              <p className="panel-subtitle">
                Review submitted template versions, verify placeholder mappings
                and malware scan status, and approve or reject with a reason.
                Self-approval is{' '}
                <strong>
                  {snapshot?.config.approval.allowSelfApproval
                    ? 'permitted'
                    : 'disabled (dual-control enforced)'}
                </strong>
                .
              </p>
            </div>
          </div>
          <div className="panel-body">
            {submittedVersions.length === 0 ? (
              <div className="muted" style={{ padding: '12px 0' }}>
                No template versions are currently awaiting approval.
              </div>
            ) : (
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
              >
                {submittedVersions.map((ver) => {
                  const tpl = snapshot?.templates.find(
                    (t) => t.id === ver.templateId,
                  );
                  const isSelfSubmitted =
                    !snapshot?.config.approval.allowSelfApproval &&
                    (ver.submittedByUserId === currentUserId ||
                      ver.createdByUserId === currentUserId);

                  return (
                    <div
                      key={ver.id}
                      style={{
                        padding: 16,
                        borderRadius: 10,
                        background: '#f8fafc',
                        border: '1px solid #cbd5e1',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <div>
                          <strong style={{ fontSize: 14 }}>
                            {tpl?.name ?? ver.templateId} — Version v
                            {ver.versionNumber}
                          </strong>
                          <div style={{ fontSize: 12, color: '#64748b' }}>
                            Submitted by <code>{ver.submittedByUserId}</code> ·
                            Malware scan: <code>{ver.scanStatus}</code> ·{' '}
                            {ver.extractedPlaceholders.length} mapped
                            placeholders
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            disabled={busy}
                            onClick={() => handlePreviewVersion(ver.id, 'pdf')}
                          >
                            <Download size={13} />
                            <span>Preview PDF</span>
                          </button>
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            disabled={busy || isSelfSubmitted}
                            title={
                              isSelfSubmitted
                                ? 'Self-approval is disabled for this tenant'
                                : 'Approve and activate version'
                            }
                            onClick={() => handleApproveVersion(ver.id)}
                          >
                            <FileCheck2 size={14} />
                            <span>
                              {isSelfSubmitted
                                ? 'Self-Approval Blocked'
                                : 'Approve & Activate'}
                            </span>
                          </button>
                        </div>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <input
                          className="input"
                          placeholder="Reason for rejection (required to reject)…"
                          value={rejectionReasons[ver.id] ?? ''}
                          onChange={(e) =>
                            setRejectionReasons((prev) => ({
                              ...prev,
                              [ver.id]: e.target.value,
                            }))
                          }
                        />
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          disabled={busy}
                          onClick={() => handleRejectVersion(ver.id)}
                        >
                          Reject Version
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      ) : null}

      {/* TAB 3: FIELD CHOOSER */}
      {activeSubTab === 'field_chooser' ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h3 className="panel-title">
                Versioned Merge Field Catalogue
              </h3>
              <p className="panel-subtitle">
                Searchable registry of canonical merge fields you are permitted
                to read. HR, payroll, and sensitive employee fields are
                architecturally excluded.
              </p>
            </div>
            <div className="panel-actions">
              <input
                className="input"
                style={{ width: 280 }}
                placeholder="Search fields by key, label, or group…"
                value={catalogueSearch}
                onChange={(e) => setCatalogueSearch(e.target.value)}
              />
            </div>
          </div>
          <div
            className="panel-body"
            style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            {groupedCatalogue.map(([groupName, entries]) => (
              <div key={groupName}>
                <h4 style={{ margin: '0 0 8px 0', fontSize: 13.5 }}>
                  {groupName} ({entries.length})
                </h4>
                <table className="table" style={{ fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      <th>Placeholder Token</th>
                      <th>Display Name</th>
                      <th>Type</th>
                      <th>Permission</th>
                      <th>Sample Output</th>
                      <th>Copy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => {
                      const token = `{{ ${entry.key} }}`;
                      return (
                        <tr key={entry.key}>
                          <td>
                            <code>{token}</code>
                          </td>
                          <td>
                            <strong>{entry.displayName}</strong>
                            <div style={{ fontSize: 11, color: '#64748b' }}>
                              {entry.description}
                            </div>
                          </td>
                          <td>
                            <code>{entry.dataType}</code>
                          </td>
                          <td>
                            <code>{entry.requiredPermission}</code>
                          </td>
                          <td>{entry.sampleValue ?? '—'}</td>
                          <td>
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              onClick={() => {
                                void navigator.clipboard?.writeText(token);
                                setCopiedKey(entry.key);
                                setTimeout(() => setCopiedKey(null), 1500);
                              }}
                            >
                              <Copy size={12} />
                              <span>
                                {copiedKey === entry.key ? 'Copied' : 'Copy'}
                              </span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* TAB 4: USAGE & ANALYTICS */}
      {activeSubTab === 'usage' && canViewUsage && usageReport ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h3 className="panel-title">Template Usage &amp; Governance Report</h3>
              <p className="panel-subtitle">
                Tracks generations vs. previews, retirement candidates (&lt;{' '}
                {usageReport.lowUseThreshold} generations), and blocked attempts
                by missing required field key. Never stores field values or
                document content.
              </p>
            </div>
            <div
              className="panel-actions"
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <input
                type="date"
                className="input"
                style={{ width: 150 }}
                value={usageFromDate}
                onChange={(e) => setUsageFromDate(e.target.value)}
              />
              <input
                type="date"
                className="input"
                style={{ width: 150 }}
                value={usageToDate}
                onChange={(e) => setUsageToDate(e.target.value)}
              />
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() =>
                  triggerDownload(
                    usageReport.csvContent,
                    `template-usage-report-${new Date().toISOString().slice(0, 10)}.csv`,
                    'text/csv;charset=utf-8',
                  )
                }
              >
                <Download size={14} />
                <span>Export CSV</span>
              </button>
            </div>
          </div>

          <div
            className="panel-body"
            style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
          >
            {/* Headline Metrics */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 12,
              }}
            >
              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                }}
              >
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  Total Documents Generated
                </div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>
                  {usageReport.totalGeneratedCount}
                </div>
              </div>
              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                }}
              >
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  Template Previews
                </div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>
                  {usageReport.totalPreviewedCount}
                </div>
              </div>
              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: '#fffbeb',
                  border: '1px solid #fde68a',
                }}
              >
                <div style={{ fontSize: 12, color: '#92400e' }}>
                  Blocked (Missing Required Field)
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#92400e' }}>
                  {usageReport.totalBlockedMissingRequiredCount}
                </div>
              </div>
              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                }}
              >
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  Retirement Candidates
                </div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>
                  {usageReport.retirementCandidates.length}
                </div>
              </div>
            </div>

            {/* Per-Template Usage Table */}
            <div>
              <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>
                Template Usage &amp; Retirement Candidates
              </h4>
              <table className="table" style={{ fontSize: 12.5 }}>
                <thead>
                  <tr>
                    <th>Template</th>
                    <th>Status</th>
                    <th>Generations</th>
                    <th>Previews</th>
                    <th>30d / 90d</th>
                    <th>Blocked Attempts</th>
                    <th>Retirement Candidate</th>
                  </tr>
                </thead>
                <tbody>
                  {usageReport.mostUsedTemplates.map((row) => (
                    <tr key={row.templateId}>
                      <td>
                        <strong>{row.templateName}</strong> (
                        <code>{row.templateCode}</code>)
                      </td>
                      <td>{row.status}</td>
                      <td>
                        <strong>{row.generatedCount}</strong>
                      </td>
                      <td>{row.previewedCount}</td>
                      <td>
                        {row.last30DaysGeneratedCount} /{' '}
                        {row.last90DaysGeneratedCount}
                      </td>
                      <td>
                        {row.blockedMissingRequiredCount}
                        {row.topMissingFieldKeys.length > 0 ? (
                          <div style={{ fontSize: 11, color: '#92400e' }}>
                            Missing:{' '}
                            {row.topMissingFieldKeys
                              .map((k) => `${k.fieldKey} (${k.count})`)
                              .join(', ')}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {row.isRetirementCandidate ? (
                          <span style={{ color: '#b45309', fontWeight: 700 }}>
                            Candidate (&lt; {usageReport.lowUseThreshold})
                          </span>
                        ) : (
                          'No'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Named User Breakdown (Dual Gated) */}
            {usageReport.userLevelDetailPermitted && usageReport.byUser ? (
              <div>
                <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>
                  Usage by Named User (<code>document_template:view_usage_by_user</code>)
                </h4>
                <table className="table" style={{ fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Role Key</th>
                      <th>Documents Generated</th>
                      <th>Previews</th>
                      <th>Blocked Attempts</th>
                      <th>Last Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageReport.byUser.map((u) => (
                      <tr key={u.userId}>
                        <td>
                          <strong>
                            {usageReport.userDisplayNamesById[u.userId] ??
                              u.userId}
                          </strong>
                        </td>
                        <td>
                          <code>{u.roleKey}</code>
                        </td>
                        <td>{u.generatedCount}</td>
                        <td>{u.previewedCount}</td>
                        <td>{u.blockedCount}</td>
                        <td>
                          {new Date(u.lastActiveAt).toLocaleString('en-GB')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* TAB 5: STORAGE & GOVERNANCE SETTINGS */}
      {activeSubTab === 'settings' && canBuild && snapshot ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h3 className="panel-title">
                Document Generation Storage &amp; Governance Configuration
              </h3>
              <p className="panel-subtitle">
                Currently using temporary tenant-isolated local storage (
                <code>data/storage/tenant-&lt;slug&gt;-&lt;env&gt;/</code>) so no
                Azure Blob setup is required yet. Switchable to Azure Blob or
                DMS via configuration.
              </p>
            </div>
          </div>
          <div
            className="panel-body"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 16,
            }}
          >
            <div>
              <label style={{ fontSize: 12.5, fontWeight: 700 }}>
                Active Storage Provider
              </label>
              <select
                className="input"
                value={snapshot.config.storageProvider}
                onChange={async (e) => {
                  await updateDocumentGenerationConfigAction({
                    storageProvider: e.target.value as StorageProviderId,
                  });
                  await loadData();
                }}
              >
                <option value="local-fs">
                  Temporary Local Tenant Storage (local-fs — Active Default)
                </option>
                <option value="azure-blob">
                  Azure Blob Storage (azure-blob)
                </option>
                <option value="sharepoint">
                  SharePoint Online (DMS Adapter)
                </option>
                <option value="imanage">iManage Work (DMS Adapter)</option>
                <option value="netdocuments">
                  NetDocuments (DMS Adapter)
                </option>
              </select>
            </div>

            <div>
              <label style={{ fontSize: 12.5, fontWeight: 700 }}>
                Default Output Format
              </label>
              <select
                className="input"
                value={snapshot.config.defaultOutputFormat}
                onChange={async (e) => {
                  await updateDocumentGenerationConfigAction({
                    defaultOutputFormat: e.target
                      .value as DocumentOutputFormat,
                  });
                  await loadData();
                }}
              >
                <option value="docx">Word Document (.docx)</option>
                <option value="pdf">PDF Document (.pdf)</option>
              </select>
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={snapshot.config.allowUserFormatOverride}
                onChange={async (e) => {
                  await updateDocumentGenerationConfigAction({
                    allowUserFormatOverride: e.target.checked,
                  });
                  await loadData();
                }}
              />
              <span>
                Allow users to choose between <code>.docx</code> and{' '}
                <code>.pdf</code> at generation time
              </span>
            </label>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={snapshot.config.approval.allowSelfApproval}
                onChange={async (e) => {
                  await updateDocumentGenerationConfigAction({
                    approval: {
                      ...snapshot.config.approval,
                      allowSelfApproval: e.target.checked,
                    },
                  });
                  await loadData();
                }}
              />
              <span>
                Allow self-approval (<code>allowSelfApproval</code>)
              </span>
            </label>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={snapshot.config.usage.showUserLevelDetail}
                onChange={async (e) => {
                  await updateDocumentGenerationConfigAction({
                    usage: {
                      ...snapshot.config.usage,
                      showUserLevelDetail: e.target.checked,
                    },
                  });
                  await loadData();
                }}
              />
              <span>
                Enable named-user usage breakdown (
                <code>showUserLevelDetail</code>)
              </span>
            </label>
          </div>
        </section>
      ) : null}
    </div>
  );
}
