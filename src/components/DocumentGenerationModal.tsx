'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCheck2,
  FileText,
  Sparkles,
  X,
} from 'lucide-react';
import {
  generateDocumentAction,
  getDocumentGenerationSnapshotAction,
  previewTemplateAction,
} from '@/app/actions';
import {
  isTemplateAvailableInContext,
  listPartyCandidatesForRecord,
  type DocumentOutputFormat,
  type DocumentTemplateRecord,
  type DocumentTemplateVersionRecord,
  type GeneratedDocumentRecord,
} from '@/domain/documentGeneration';
import type {
  ChoiceValue,
  Matter,
  Organisation,
  Person,
} from '@/domain/types';
import type { DocumentGenerationClientSnapshot } from '@/server/documentGenerationServices';

export interface DocumentGenerationModalProps {
  open: boolean;
  onClose: () => void;
  sourceEntityType: 'matter' | 'client';
  matter?: Matter | null;
  organisation?: Organisation | null;
  person?: Person | null;
  people: Person[];
  organisations: Organisation[];
  values: ChoiceValue[];
  currentUserId: string;
  initialSnapshot?: DocumentGenerationClientSnapshot | null;
  onDocumentGenerated?: (doc: GeneratedDocumentRecord) => void;
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
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

export function DocumentGenerationModal({
  open,
  onClose,
  sourceEntityType,
  matter,
  organisation,
  person,
  people,
  organisations,
  values,
  currentUserId,
  initialSnapshot,
  onDocumentGenerated,
}: DocumentGenerationModalProps) {
  const [snapshot, setSnapshot] =
    useState<DocumentGenerationClientSnapshot | null>(initialSnapshot ?? null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [outputFormat, setOutputFormat] =
    useState<DocumentOutputFormat>('docx');
  const [recipientPartyId, setRecipientPartyId] = useState<string>('');
  const [promptedValues, setPromptedValues] = useState<Record<string, string>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [missingRequiredFields, setMissingRequiredFields] = useState<string[]>(
    [],
  );
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const currentUser = useMemo(
    () => people.find((p) => p.id === currentUserId) ?? people[0] ?? null,
    [people, currentUserId],
  );

  const partyCandidates = useMemo(
    () =>
      listPartyCandidatesForRecord({
        matter,
        organisation,
        person,
        people,
        organisations,
        values,
      }),
    [matter, organisation, person, people, organisations, values],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setErrorMsg(null);
      setMissingRequiredFields([]);
      setSuccessBanner(null);

      if (partyCandidates.length > 0 && !recipientPartyId) {
        setRecipientPartyId(partyCandidates[0]!.id);
      }

      setLoadingSnapshot(true);
      getDocumentGenerationSnapshotAction()
        .then((snap) => {
          if (cancelled) return;
          setSnapshot(snap);
          setOutputFormat(snap.config.defaultOutputFormat);
        })
        .catch((err) => {
          if (cancelled) return;
          setErrorMsg(
            err instanceof Error
              ? err.message
              : 'Unable to load templates.',
          );
        })
        .finally(() => {
          if (!cancelled) setLoadingSnapshot(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [open, partyCandidates, recipientPartyId]);

  const availableTemplates = useMemo(() => {
    if (!snapshot || !currentUser) return [];
    const actor = snapshot.actor;
    const versionById = new Map<string, DocumentTemplateVersionRecord>(
      snapshot.versions.map((v) => [v.id, v]),
    );
    const practiceAreaLabel = matter?.practiceAreaId
      ? (values.find((v) => v.id === matter.practiceAreaId)?.label ??
        matter.practiceAreaId)
      : null;
    const matterTypeLabel = matter?.workTypeSubcategoryId
      ? (values.find((v) => v.id === matter.workTypeSubcategoryId)?.label ??
        matter.workTypeSubcategoryId)
      : null;
    const clientType: 'Organisation' | 'Person' | null = organisation
      ? 'Organisation'
      : person
        ? 'Person'
        : matter?.clientId?.startsWith('O-')
          ? 'Organisation'
          : matter?.clientId?.startsWith('P-')
            ? 'Person'
            : null;

    return snapshot.templates.filter((t) => {
      const activeVer = t.activeVersionId
        ? versionById.get(t.activeVersionId)
        : null;
      const check = isTemplateAvailableInContext({
        template: t,
        version: activeVer,
        actor,
        config: {
          documentGeneration: snapshot.config,
        },
        permittedTemplateIds: snapshot.permittedTemplateIds,
        sourceEntityType,
        practiceAreaKey: practiceAreaLabel,
        matterTypeKey: matterTypeLabel,
        clientType,
      });
      return check.available;
    });
  }, [
    snapshot,
    currentUser,
    matter,
    organisation,
    person,
    sourceEntityType,
    values,
  ]);

  useEffect(() => {
    if (availableTemplates.length > 0) {
      const stillValid = availableTemplates.some(
        (t) => t.id === selectedTemplateId,
      );
      if (!stillValid) {
        const nextId = availableTemplates[0]!.id;
        queueMicrotask(() => setSelectedTemplateId(nextId));
      }
    }
  }, [availableTemplates, selectedTemplateId]);

  const selectedTemplate: DocumentTemplateRecord | null = useMemo(
    () =>
      availableTemplates.find((t) => t.id === selectedTemplateId) ??
      availableTemplates[0] ??
      null,
    [availableTemplates, selectedTemplateId],
  );

  const selectedVersion: DocumentTemplateVersionRecord | null = useMemo(() => {
    if (!selectedTemplate?.activeVersionId || !snapshot) return null;
    return (
      snapshot.versions.find(
        (v) => v.id === selectedTemplate.activeVersionId,
      ) ?? null
    );
  }, [selectedTemplate, snapshot]);

  // Populate default values for prompted fields when selectedVersion changes
  useEffect(() => {
    if (!selectedVersion) {
      queueMicrotask(() => setPromptedValues({}));
      return;
    }
    const defaults: Record<string, string> = {};
    for (const pf of selectedVersion.promptedFields) {
      defaults[pf.key] = pf.defaultValue ?? '';
    }
    queueMicrotask(() => setPromptedValues(defaults));
  }, [selectedVersion]);

  if (!open) return null;

  const selectedRecipientCandidate = partyCandidates.find(
    (c) => c.id === recipientPartyId,
  );

  async function handlePreview() {
    if (!selectedVersion) return;
    setBusy(true);
    setErrorMsg(null);
    setMissingRequiredFields([]);
    try {
      const res = await previewTemplateAction({
        versionId: selectedVersion.id,
        matterId: matter?.id ?? null,
        organisationId: organisation?.id ?? null,
        personId: person?.id ?? null,
        recipientPartyId: recipientPartyId || null,
        promptedValues,
        outputFormat,
      });
      if (res.missingRequiredFields.length > 0) {
        setMissingRequiredFields(res.missingRequiredFields);
      } else if (res.fileBase64) {
        triggerBase64Download(res.fileBase64, res.fileName, res.mimeType);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Preview generation failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateAndSave() {
    if (!selectedTemplate) return;
    setBusy(true);
    setErrorMsg(null);
    setMissingRequiredFields([]);
    setSuccessBanner(null);
    try {
      const res = await generateDocumentAction({
        templateId: selectedTemplate.id,
        sourceEntityType,
        matterId: matter?.id ?? null,
        organisationId: organisation?.id ?? null,
        personId: person?.id ?? null,
        recipientPartyId: recipientPartyId || null,
        recipientPartyEntityType:
          selectedRecipientCandidate?.entityType ?? null,
        promptedValues,
        outputFormat,
      });

      if (res.status === 'blocked_missing_required') {
        setMissingRequiredFields(res.missingRequiredFields);
        return;
      }

      if (res.document) {
        if (res.fileBase64) {
          triggerBase64Download(
            res.fileBase64,
            res.document.fileName,
            res.document.mimeType,
          );
        }
        setSuccessBanner(
          `Saved "${res.document.fileName}" to ${sourceEntityType === 'matter' ? 'matter and client records' : 'client record'}.`,
        );
        onDocumentGenerated?.(res.document);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Document generation failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="doc-gen-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 860,
          maxHeight: '90vh',
          background: '#ffffff',
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(15, 23, 42, 0.28)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid #cbd5e1',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 22px',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: '#e0f0ec',
                color: '#0d5c54',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <FileText size={20} />
            </div>
            <div>
              <h2
                id="doc-gen-modal-title"
                style={{
                  margin: 0,
                  fontSize: 17,
                  fontWeight: 800,
                  color: '#0f172a',
                }}
              >
                Generate Document from Approved Template
              </h2>
              <div style={{ fontSize: 12.5, color: '#64748b' }}>
                {matter
                  ? `Matter ${matter.matterNumber} — ${matter.title}`
                  : organisation
                    ? `Client Organisation — ${organisation.legalName}`
                    : person
                      ? `Client — ${person.firstName} ${person.surname}`
                      : 'Select an active template'}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onClose}
            aria-label="Close modal"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            padding: '18px 22px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          {errorMsg ? (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#991b1b',
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <AlertTriangle size={16} />
              <span>{errorMsg}</span>
            </div>
          ) : null}

          {missingRequiredFields.length > 0 ? (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: '#fffbeb',
                border: '1px solid #fde68a',
                color: '#92400e',
                fontSize: 13,
              }}
            >
              <div
                style={{
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                }}
              >
                <AlertTriangle size={15} />
                <span>
                  Generation blocked — required fields are missing:
                </span>
              </div>
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                {missingRequiredFields.map((fk) => (
                  <li key={fk}>
                    <code>{fk}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {successBanner ? (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: '#ecfdf5',
                border: '1px solid #a7f3d0',
                color: '#065f46',
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <CheckCircle2 size={16} />
              <span>{successBanner}</span>
            </div>
          ) : null}

          {loadingSnapshot ? (
            <div className="muted" style={{ padding: '20px 0' }}>
              Loading approved templates…
            </div>
          ) : availableTemplates.length === 0 ? (
            <div
              style={{
                padding: 18,
                borderRadius: 10,
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                color: '#475569',
                fontSize: 13,
              }}
            >
              No active approved templates are available for your role and this
              record type. Administrators can upload and approve templates in{' '}
              <strong>Admin → Document Templates</strong>.
            </div>
          ) : (
            <>
              {/* Template Selector & Output Format */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr',
                  gap: 14,
                }}
              >
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: 12.5,
                      fontWeight: 700,
                      marginBottom: 4,
                    }}
                  >
                    Approved Template
                  </label>
                  <select
                    className="input"
                    value={selectedTemplate?.id ?? ''}
                    onChange={(e) => setSelectedTemplateId(e.target.value)}
                  >
                    {availableTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.category} · {t.code})
                      </option>
                    ))}
                  </select>
                  {selectedTemplate ? (
                    <div
                      style={{
                        fontSize: 12,
                        color: '#64748b',
                        marginTop: 4,
                      }}
                    >
                      {selectedTemplate.description} · Active v
                      {selectedVersion?.versionNumber ?? 1}
                    </div>
                  ) : null}
                </div>

                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: 12.5,
                      fontWeight: 700,
                      marginBottom: 4,
                    }}
                  >
                    Output Format
                  </label>
                  <select
                    className="input"
                    value={outputFormat}
                    disabled={!snapshot?.config.allowUserFormatOverride}
                    onChange={(e) =>
                      setOutputFormat(e.target.value as DocumentOutputFormat)
                    }
                  >
                    <option value="docx">Word Document (.docx)</option>
                    <option value="pdf">PDF Document (.pdf)</option>
                  </select>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#64748b',
                      marginTop: 4,
                    }}
                  >
                    Storage: <code>{snapshot?.config.storageProvider}</code>
                  </div>
                </div>
              </div>

              {/* Recipient Party Selector */}
              {partyCandidates.length > 0 ? (
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: 12.5,
                      fontWeight: 700,
                      marginBottom: 4,
                    }}
                  >
                    Addressee / Recipient Party (<code>party.recipient.*</code>)
                  </label>
                  <select
                    className="input"
                    value={recipientPartyId}
                    onChange={(e) => setRecipientPartyId(e.target.value)}
                  >
                    {partyCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} — {c.role}
                        {c.email ? ` (${c.email})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {/* Prompted Fields */}
              {selectedVersion && selectedVersion.promptedFields.length > 0 ? (
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: 10,
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: '#0f172a',
                      marginBottom: 10,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <Sparkles size={15} />
                    <span>Prompted Fields (Entered at Generation Time)</span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    {selectedVersion.promptedFields.map((pf) => (
                      <div key={pf.key}>
                        <label
                          style={{
                            display: 'block',
                            fontSize: 12.5,
                            fontWeight: 600,
                            marginBottom: 4,
                          }}
                        >
                          {pf.label}{' '}
                          {pf.required ? (
                            <span style={{ color: '#dc2626' }}>*</span>
                          ) : (
                            <span className="muted">(optional)</span>
                          )}
                        </label>
                        {pf.fieldType === 'choice' && pf.options?.length ? (
                          <select
                            className="input"
                            value={promptedValues[pf.key] ?? ''}
                            onChange={(e) =>
                              setPromptedValues((prev) => ({
                                ...prev,
                                [pf.key]: e.target.value,
                              }))
                            }
                          >
                            <option value="">Select…</option>
                            {pf.options.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        ) : pf.fieldType === 'date' ? (
                          <input
                            type="date"
                            className="input"
                            value={promptedValues[pf.key] ?? ''}
                            onChange={(e) =>
                              setPromptedValues((prev) => ({
                                ...prev,
                                [pf.key]: e.target.value,
                              }))
                            }
                          />
                        ) : pf.fieldType === 'number' ? (
                          <input
                            type="number"
                            className="input"
                            value={promptedValues[pf.key] ?? ''}
                            onChange={(e) =>
                              setPromptedValues((prev) => ({
                                ...prev,
                                [pf.key]: e.target.value,
                              }))
                            }
                          />
                        ) : (
                          <textarea
                            className="input"
                            rows={3}
                            value={promptedValues[pf.key] ?? ''}
                            onChange={(e) =>
                              setPromptedValues((prev) => ({
                                ...prev,
                                [pf.key]: e.target.value,
                              }))
                            }
                          />
                        )}
                        {pf.helpText ? (
                          <div
                            style={{
                              fontSize: 11.5,
                              color: '#64748b',
                              marginTop: 2,
                            }}
                          >
                            {pf.helpText}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Mapped Merge Fields Summary */}
              {selectedVersion ? (
                <div
                  style={{
                    fontSize: 12,
                    color: '#475569',
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: '#f1f5f9',
                  }}
                >
                  <strong>Mapped Placeholders ({selectedVersion.extractedPlaceholders.length}):</strong>{' '}
                  {selectedVersion.extractedPlaceholders
                    .map((p) => p.rawToken)
                    .join(', ')}
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 22px',
            borderTop: '1px solid #e2e8f0',
            background: '#f8fafc',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={onClose}
          >
            Close
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={busy || !selectedVersion}
              onClick={handlePreview}
            >
              <Download size={14} />
              <span>Preview ({outputFormat.toUpperCase()})</span>
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy || !selectedTemplate}
              onClick={handleGenerateAndSave}
            >
              <FileCheck2 size={14} />
              <span>
                {busy
                  ? 'Generating…'
                  : `Generate & Save (${outputFormat.toUpperCase()})`}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
