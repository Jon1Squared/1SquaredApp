'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Download,
  FilePlus2,
  FileText,
  Trash2,
} from 'lucide-react';
import {
  deleteGeneratedDocumentAction,
  downloadGeneratedDocumentAction,
  getDocumentGenerationSnapshotAction,
} from '@/app/actions';
import type { GeneratedDocumentRecord } from '@/domain/documentGeneration';
import type {
  ChoiceValue,
  Matter,
  Organisation,
  Person,
} from '@/domain/types';
import type { DocumentGenerationClientSnapshot } from '@/server/documentGenerationServices';
import { DocumentGenerationModal } from './DocumentGenerationModal';

export interface DocumentListSectionProps {
  entityType: 'matter' | 'organisation' | 'person';
  entityId: string;
  matter?: Matter | null;
  organisation?: Organisation | null;
  person?: Person | null;
  matters?: Matter[];
  people: Person[];
  organisations: Organisation[];
  values: ChoiceValue[];
  currentUserId: string;
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

export function DocumentListSection({
  entityType,
  entityId,
  matter,
  organisation,
  person,
  matters = [],
  people,
  organisations,
  values,
  currentUserId,
}: DocumentListSectionProps) {
  const [snapshot, setSnapshot] =
    useState<DocumentGenerationClientSnapshot | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadSnapshot = useCallback(async () => {
    try {
      const snap = await getDocumentGenerationSnapshotAction();
      setSnapshot(snap);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to load documents.',
      );
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadSnapshot();
    });
  }, [loadSnapshot, currentUserId, entityId]);

  const entityDocuments = useMemo(() => {
    if (!snapshot) return [];
    const linkedIds = new Set(
      snapshot.documentLinks
        .filter((l) => l.entityType === entityType && l.entityId === entityId)
        .map((l) => l.documentId),
    );
    return snapshot.documents.filter((doc) => {
      if (doc.isDeleted) return false;
      if (linkedIds.has(doc.id)) return true;
      if (entityType === 'matter' && doc.primaryMatterId === entityId) {
        return true;
      }
      if (
        (entityType === 'organisation' || entityType === 'person') &&
        doc.primaryClientId === entityId
      ) {
        return true;
      }
      return false;
    });
  }, [snapshot, entityType, entityId]);

  const canGenerate =
    snapshot?.userPermissions.includes('document:generate') ?? true;
  const canDelete =
    snapshot?.userPermissions.includes('document:delete') ?? false;

  async function handleDownload(doc: GeneratedDocumentRecord) {
    setBusyDocId(doc.id);
    setErrorMsg(null);
    try {
      const res = await downloadGeneratedDocumentAction(doc.id);
      triggerBase64Download(res.fileBase64, res.fileName, res.mimeType);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Download failed.',
      );
    } finally {
      setBusyDocId(null);
    }
  }

  async function handleDelete(doc: GeneratedDocumentRecord) {
    setBusyDocId(doc.id);
    setErrorMsg(null);
    try {
      await deleteGeneratedDocumentAction(doc.id);
      await loadSnapshot();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Delete failed.',
      );
    } finally {
      setBusyDocId(null);
    }
  }

  const matterById = useMemo(
    () => new Map(matters.map((m) => [m.id, m])),
    [matters],
  );

  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-header">
        <div>
          <h3 className="panel-title">Generated Documents</h3>
          <p className="panel-subtitle">
            {entityDocuments.length === 0
              ? 'No documents generated yet for this record.'
              : `${entityDocuments.length} generated document${entityDocuments.length === 1 ? '' : 's'} linked to this ${entityType}.`}
          </p>
        </div>
        {canGenerate ? (
          <div className="panel-actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => setModalOpen(true)}
            >
              <FilePlus2 size={14} />
              <span>+ Generate Document</span>
            </button>
          </div>
        ) : null}
      </div>

      <div className="panel-body">
        {errorMsg ? (
          <div
            style={{
              padding: '8px 12px',
              marginBottom: 10,
              borderRadius: 6,
              background: '#fef2f2',
              color: '#991b1b',
              fontSize: 12.5,
            }}
          >
            {errorMsg}
          </div>
        ) : null}

        {entityDocuments.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, padding: '8px 0' }}>
            Use <strong>+ Generate Document</strong> to merge an approved Word
            template into a saved <code>.docx</code> or <code>.pdf</code>{' '}
            document.
          </div>
        ) : (
          <ul className="worklist">
            {entityDocuments.map((doc) => {
              const linkedMatter = doc.primaryMatterId
                ? matterById.get(doc.primaryMatterId)
                : null;
              return (
                <li key={doc.id} className="worklist-row">
                  <div className="worklist-main">
                    <div
                      className="worklist-title"
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <FileText
                        size={14}
                        style={{ color: 'var(--color-primary)' }}
                      />
                      <strong>{doc.fileName}</strong>
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          padding: '1px 7px',
                          borderRadius: 999,
                          background:
                            doc.outputFormat === 'pdf' ? '#fee2e2' : '#dbeafe',
                          color:
                            doc.outputFormat === 'pdf' ? '#991b1b' : '#1e40af',
                        }}
                      >
                        {doc.outputFormat.toUpperCase()}
                      </span>
                    </div>
                    <div className="worklist-meta">
                      {doc.templateName} (v{doc.templateVersionNumber}) ·
                      Generated {new Date(doc.generatedAt).toLocaleString('en-GB')}{' '}
                      by {doc.generatedByName ?? doc.generatedByUserId}
                      {entityType !== 'matter' && linkedMatter
                        ? ` · Matter: ${linkedMatter.matterNumber} (${linkedMatter.title})`
                        : ''}
                    </div>
                  </div>
                  <div
                    className="worklist-right"
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={busyDocId === doc.id}
                      onClick={() => handleDownload(doc)}
                    >
                      <Download size={13} />
                      <span>Download</span>
                    </button>
                    {canDelete ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busyDocId === doc.id}
                        onClick={() => handleDelete(doc)}
                        title="Delete generated document"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <DocumentGenerationModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        sourceEntityType={entityType === 'matter' ? 'matter' : 'client'}
        matter={matter}
        organisation={organisation}
        person={person}
        people={people}
        organisations={organisations}
        values={values}
        currentUserId={currentUserId}
        initialSnapshot={snapshot}
        onDocumentGenerated={() => {
          void loadSnapshot();
        }}
      />
    </section>
  );
}
