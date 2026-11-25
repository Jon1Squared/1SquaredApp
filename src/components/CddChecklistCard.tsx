'use client';

import React, { useEffect, useState } from 'react';
import type {
  CddClientCategoryKey,
  IntakeEvidenceArtifactRef,
  RegisterChecklistItemValue,
  SanctionsPepOutcome,
} from '@platform/core-api';
import {
  completeClientCddAction,
  recordCddChecklistItemAction,
  recordManualSanctionsPepAction,
  startOrLoadClientCddAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import {
  buildCddStatusDisplayText,
  formatUkShortDate,
  type CddEvidenceDownloadableRef,
  type ClientCddSummary,
} from '@/domain/cdd';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

const SCREENING_NO_MATCH: SanctionsPepOutcome = 'clear';
const SCREENING_FLAGGED: SanctionsPepOutcome = 'match_flagged';
const SCREENING_PENDING: SanctionsPepOutcome = 'pending';

const CATEGORY_LABELS: Record<CddClientCategoryKey, string> = {
  individual: 'Individual',
  company_or_llp: 'Company or LLP',
  trust_charity_or_partnership: 'Trust, charity or partnership',
};

function screeningOutcomeLabel(outcome: SanctionsPepOutcome): string {
  if (outcome === SCREENING_NO_MATCH) return 'No match recorded (manual check)';
  if (outcome === SCREENING_FLAGGED) return 'Potential match flagged';
  return 'Pending review';
}

function screeningOutcomeTone(
  outcome: SanctionsPepOutcome,
): 'positive' | 'alert' | 'warning' {
  if (outcome === SCREENING_NO_MATCH) return 'positive';
  if (outcome === SCREENING_FLAGGED) return 'alert';
  return 'warning';
}

function itemStatusBadge(
  status: RegisterChecklistItemValue['status'],
): { label: string; tone: 'positive' | 'warning' | 'alert' | 'neutral' } {
  switch (status) {
    case 'recorded':
      return { label: 'Recorded', tone: 'positive' };
    case 'not_applicable':
      return { label: 'Not applicable', tone: 'neutral' };
    case 'failed':
      return { label: 'Issue flagged', tone: 'alert' };
    default:
      return { label: 'Pending', tone: 'warning' };
  }
}

interface CddChecklistCardProps {
  initialSummary: ClientCddSummary;
  subjectLabel: string;
}

export function CddChecklistCard({
  initialSummary,
  subjectLabel,
}: CddChecklistCardProps) {
  const { showToast } = useToast();
  const [summary, setSummary] = useState<ClientCddSummary>(initialSummary);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [noteByItemKey, setNoteByItemKey] = useState<Record<string, string>>({});
  const [pendingEvidenceByItemKey, setPendingEvidenceByItemKey] = useState<
    Record<string, CddEvidenceDownloadableRef[]>
  >({});
  const [manualSummaryNote, setManualSummaryNote] = useState<string>(
    initialSummary.manualSummaryNote || '',
  );

  // Manual politically exposed person & sanctions watch state
  const [screeningOutcome, setScreeningOutcome] =
    useState<SanctionsPepOutcome>(SCREENING_NO_MATCH);
  const [screeningScope, setScreeningScope] = useState<string>(
    'UK consolidated list & politically exposed person manual check',
  );
  const [screeningRef, setScreeningRef] = useState<string>('');
  const [screeningNotes, setScreeningNotes] = useState<string>('');

  useEffect(() => {
    setSummary(initialSummary);
    setManualSummaryNote(initialSummary.manualSummaryNote || '');
  }, [initialSummary]);

  if (!summary.visible) {
    return null;
  }

  const downloadUrlByBlobKey = new Map<string, string>();
  for (const ref of summary.evidenceRefs) {
    if (ref.downloadUrl) {
      downloadUrlByBlobKey.set(ref.blobKey, ref.downloadUrl);
    }
  }
  for (const list of Object.values(pendingEvidenceByItemKey)) {
    for (const ref of list) {
      if (ref.downloadUrl) {
        downloadUrlByBlobKey.set(ref.blobKey, ref.downloadUrl);
      }
    }
  }

  const statusText = buildCddStatusDisplayText(summary);
  const incompleteRequiredCount = summary.checklistItems.filter(
    (item) =>
      item.required !== false &&
      item.status !== 'recorded' &&
      item.status !== 'not_applicable',
  ).length;

  const handleStartOrUpgrade = async (opts: {
    createIfMissing?: boolean;
    upgradeToHighRisk?: boolean;
  }) => {
    setBusyKey(opts.upgradeToHighRisk ? 'upgrade' : 'start');
    setErrorBanner(null);
    try {
      const res = await startOrLoadClientCddAction({
        subjectType: summary.subjectType,
        subjectId: summary.subjectId,
        ...opts,
      });
      if (isActionDenied(res) || !res.ok) {
        const msg = isActionDenied(res)
          ? res.message
          : res.message || 'Unable to start or update CDD.';
        setErrorBanner(msg);
        showToast(msg);
        return;
      }
      setSummary(res.summary);
      setManualSummaryNote(res.summary.manualSummaryNote || '');
      showToast(
        opts.upgradeToHighRisk
          ? 'CDD upgraded to High Risk checklist.'
          : 'CDD checklist initialised.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleFileUpload = async (itemKey: string, file: File) => {
    setBusyKey(`upload:${itemKey}`);
    setErrorBanner(null);
    try {
      const formData = new FormData();
      formData.set('subjectType', summary.subjectType);
      formData.set('subjectId', summary.subjectId);
      formData.set('file', file);

      const response = await fetch('/api/evidence/upload', {
        method: 'POST',
        body: formData,
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        evidenceRef?: CddEvidenceDownloadableRef;
      };
      if (!response.ok || !payload.ok || !payload.evidenceRef) {
        const msg = payload.error || 'Evidence upload rejected.';
        setErrorBanner(msg);
        showToast(msg);
        return;
      }
      setPendingEvidenceByItemKey((prev) => ({
        ...prev,
        [itemKey]: [...(prev[itemKey] ?? []), payload.evidenceRef!],
      }));
      showToast(`Uploaded ${payload.evidenceRef.fileName || 'evidence file'}.`);
    } catch {
      const msg = 'Unable to upload evidence file.';
      setErrorBanner(msg);
      showToast(msg);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRecordItem = async (
    item: RegisterChecklistItemValue,
    nextStatus: 'recorded' | 'not_applicable' | 'failed',
  ) => {
    if (!summary.record) return;
    const itemNote = (noteByItemKey[item.itemKey] ?? item.note ?? '').trim();
    if ((nextStatus === 'not_applicable' || nextStatus === 'failed') && !itemNote) {
      const msg = `Please enter a written reason before marking "${item.label}" as ${nextStatus === 'not_applicable' ? 'Not applicable' : 'Issue flagged'}.`;
      setErrorBanner(msg);
      showToast(msg);
      return;
    }

    const stagedRefs: IntakeEvidenceArtifactRef[] = (
      pendingEvidenceByItemKey[item.itemKey] ?? []
    ).map((r) => ({
      blobKey: r.blobKey,
      sha256: r.sha256,
      contentType: r.contentType,
      sizeBytes: r.sizeBytes,
      scanStatus: r.scanStatus,
      ...(r.fileName ? { fileName: r.fileName } : {}),
      ...(r.uploadedByActorId ? { uploadedByActorId: r.uploadedByActorId } : {}),
      ...(r.uploadedAt ? { uploadedAt: r.uploadedAt } : {}),
    }));

    setBusyKey(`item:${item.itemKey}`);
    setErrorBanner(null);
    try {
      const res = await recordCddChecklistItemAction({
        recordId: summary.record.id,
        itemKey: item.itemKey,
        status: nextStatus,
        note: itemNote || undefined,
        evidenceRefs: stagedRefs.length > 0 ? stagedRefs : undefined,
        ...(item.itemKey === 'photo_id' ||
        item.itemKey === 'director_photo_id' ||
        item.itemKey === 'controllers_id'
          ? nextStatus === 'recorded'
            ? {
                linkManualIdentityCheck: {
                  outcome: 'verified',
                  verificationMethod: itemNote || 'Manual identity verification recorded',
                },
              }
            : {}
          : {}),
        expectedRowVersion: summary.record.rowVersion,
      });
      if (isActionDenied(res) || !res.ok) {
        const msg = isActionDenied(res)
          ? res.message
          : res.message || 'Could not update checklist item.';
        setErrorBanner(msg);
        showToast(msg);
        return;
      }
      setSummary(res.summary);
      setPendingEvidenceByItemKey((prev) => {
        const next = { ...prev };
        delete next[item.itemKey];
        return next;
      });
      showToast(`${item.label} updated.`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleCompleteCdd = async () => {
    if (!summary.record) return;
    setBusyKey('complete');
    setErrorBanner(null);
    try {
      const res = await completeClientCddAction({
        recordId: summary.record.id,
        manualSummaryNote: manualSummaryNote.trim() || undefined,
        expectedRowVersion: summary.record.rowVersion,
      });
      if (isActionDenied(res) || !res.ok) {
        const msg = isActionDenied(res)
          ? res.message
          : res.message || 'Unable to complete CDD.';
        setErrorBanner(msg);
        showToast(msg);
        return;
      }
      setSummary(res.summary);
      showToast('Client Due Diligence marked complete.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRecordScreening = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyKey('screening');
    setErrorBanner(null);
    try {
      const res = await recordManualSanctionsPepAction({
        subjectType: summary.subjectType,
        subjectId: summary.subjectId,
        outcome: screeningOutcome,
        screeningScope: screeningScope.trim() || 'Manual watchlist check',
        referenceCode: screeningRef.trim() || undefined,
        notes: screeningNotes.trim() || undefined,
      });
      if (isActionDenied(res) || !res.ok) {
        const msg = isActionDenied(res)
          ? res.message
          : res.message || 'Unable to record screening check.';
        setErrorBanner(msg);
        showToast(msg);
        return;
      }
      setSummary(res.summary);
      setScreeningRef('');
      setScreeningNotes('');
      showToast('Manual watchlist check recorded.');
    } finally {
      setBusyKey(null);
    }
  };

  const headerTone: 'positive' | 'warning' | 'alert' | 'neutral' =
    summary.status === 'recorded'
      ? summary.isExpired
        ? 'alert'
        : 'positive'
      : summary.status === 'in_progress'
        ? 'warning'
        : 'neutral';

  return (
    <section
      className="home-panel"
      data-testid="cdd-checklist-card"
      aria-label={`Client Due Diligence for ${subjectLabel}`}
      style={{ marginTop: 16 }}
    >
      <div className="panel-header">
        <div className="panel-title-group">
          <h2 className="panel-title">Client Due Diligence (CDD)</h2>
          <StatusPill
            label={
              summary.status === 'recorded'
                ? summary.isExpired
                  ? 'Re-check overdue'
                  : 'Recorded manually'
                : summary.status === 'in_progress'
                  ? 'In progress'
                  : 'Not started'
            }
            tone={headerTone}
          />
          <StatusPill
            label={summary.riskTier === 'high' ? 'High Risk CDD (12m)' : 'Standard CDD (36m)'}
            tone={summary.riskTier === 'high' ? 'warning' : 'neutral'}
          />
          {summary.clientCategory ? (
            <StatusPill
              label={CATEGORY_LABELS[summary.clientCategory] ?? summary.clientCategory}
              tone="neutral"
            />
          ) : null}
        </div>
        <div className="panel-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!summary.hasRecord && summary.canRecord ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busyKey !== null}
              onClick={() => void handleStartOrUpgrade({ createIfMissing: true })}
            >
              {busyKey === 'start' ? 'Starting…' : 'Start CDD'}
            </button>
          ) : null}
          {summary.hasRecord && summary.needsUpgradeToHighRisk && summary.canRecord ? (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={busyKey !== null}
              onClick={() => void handleStartOrUpgrade({ upgradeToHighRisk: true })}
            >
              {busyKey === 'upgrade' ? 'Upgrading…' : 'Upgrade to High Risk'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="panel-body padded" style={{ display: 'grid', gap: 14 }}>
        <div style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>
          <strong>{statusText}</strong>
          {summary.hasRecord ? (
            <span>
              {' '}
              · {summary.requiredCompleted} of {summary.requiredTotal} required checklist item
              {summary.requiredTotal === 1 ? '' : 's'} satisfied
            </span>
          ) : (
            <span> · Checklist items follow the client’s MLR 2017 category and risk tier.</span>
          )}
        </div>

        {summary.needsUpgradeToHighRisk ? (
          <div
            role="status"
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid #f59e0b',
              background: '#fffbeb',
              fontSize: 13,
            }}
          >
            This client is currently rated <strong>High Risk</strong> based on client or active
            matter risk ratings. Upgrade the CDD record to capture enhanced due diligence items.
          </div>
        ) : null}

        {errorBanner ? (
          <div
            role="alert"
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid #dc2626',
              background: '#fef2f2',
              color: '#991b1b',
              fontSize: 13,
            }}
          >
            {errorBanner}
          </div>
        ) : null}

        {summary.hasRecord ? (
          <div style={{ display: 'grid', gap: 12 }}>
            {summary.checklistItems.map((item) => {
              const badge = itemStatusBadge(item.status);
              const pendingForItem = pendingEvidenceByItemKey[item.itemKey] ?? [];
              const existingEvidence = item.evidenceRefs ?? [];
              const itemNoteVal =
                noteByItemKey[item.itemKey] !== undefined
                  ? noteByItemKey[item.itemKey]
                  : (item.note ?? '');

              return (
                <div
                  key={item.itemKey}
                  data-testid={`cdd-item-${item.itemKey}`}
                  style={{
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                    padding: 12,
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <strong style={{ fontSize: 14 }}>{item.label}</strong>
                      {item.required === false ? (
                        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                          Optional
                        </span>
                      ) : (
                        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                          Required
                        </span>
                      )}
                    </div>
                    <StatusPill label={badge.label} tone={badge.tone} />
                  </div>

                  {item.recordedAt ? (
                    <div className="muted" style={{ fontSize: 12 }}>
                      Recorded by {item.recordedByName || item.recordedById || 'Authorised user'} on{' '}
                      {formatUkShortDate(item.recordedAt)}
                    </div>
                  ) : null}

                  {(existingEvidence.length > 0 || pendingForItem.length > 0) && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12.5 }}>
                      {existingEvidence.map((ref) => {
                        const href = downloadUrlByBlobKey.get(ref.blobKey);
                        return href ? (
                          <a
                            key={ref.blobKey}
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn--secondary btn--sm"
                          >
                            Download: {ref.fileName || 'Evidence file'}
                          </a>
                        ) : (
                          <span key={ref.blobKey} className="muted">
                            Attached: {ref.fileName || ref.blobKey}
                          </span>
                        );
                      })}
                      {pendingForItem.map((ref) => (
                        <span key={ref.blobKey} className="client-pill client-pill--green">
                          Ready to link: {ref.fileName || 'Uploaded file'}
                        </span>
                      ))}
                    </div>
                  )}

                  {summary.canRecord ? (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                          flexWrap: 'wrap',
                          alignItems: 'center',
                        }}
                      >
                        <input
                          type="text"
                          className="field-input"
                          style={{ flex: '1 1 240px' }}
                          aria-label={`Note for ${item.label}`}
                          placeholder="Verification reference or reason (required for Not applicable / Flag)"
                          value={itemNoteVal}
                          onChange={(e) =>
                            setNoteByItemKey((prev) => ({
                              ...prev,
                              [item.itemKey]: e.target.value,
                            }))
                          }
                        />
                        <label className="btn btn--secondary btn--sm" style={{ cursor: 'pointer' }}>
                          {busyKey === `upload:${item.itemKey}` ? 'Scanning…' : 'Attach evidence'}
                          <input
                            type="file"
                            style={{ display: 'none' }}
                            disabled={busyKey !== null}
                            onChange={(e) => {
                              const picked = e.target.files?.[0];
                              e.target.value = '';
                              if (picked) {
                                void handleFileUpload(item.itemKey, picked);
                              }
                            }}
                          />
                        </label>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          disabled={busyKey !== null}
                          onClick={() => void handleRecordItem(item, 'recorded')}
                        >
                          Mark recorded
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          disabled={busyKey !== null}
                          onClick={() => void handleRecordItem(item, 'not_applicable')}
                        >
                          Not applicable
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          disabled={busyKey !== null}
                          onClick={() => void handleRecordItem(item, 'failed')}
                        >
                          Flag issue
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}

            {summary.canRecord ? (
              <div
                style={{
                  borderTop: '1px solid var(--border-subtle)',
                  paddingTop: 12,
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                <input
                  type="text"
                  className="field-input"
                  style={{ flex: '1 1 280px' }}
                  aria-label="Overall CDD manual completion note"
                  placeholder="Optional overall CDD summary note"
                  value={manualSummaryNote}
                  onChange={(e) => setManualSummaryNote(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={busyKey !== null || incompleteRequiredCount > 0}
                  onClick={() => void handleCompleteCdd()}
                >
                  {busyKey === 'complete' ? 'Completing…' : 'Complete CDD'}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div
          style={{
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 12,
            display: 'grid',
            gap: 10,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <strong style={{ fontSize: 13.5 }}>
              Manual watchlist check (sanctions &amp; politically exposed persons)
            </strong>
            {summary.latestSanctionsCheck ? (
              <StatusPill
                label={screeningOutcomeLabel(summary.latestSanctionsCheck.outcome)}
                tone={screeningOutcomeTone(summary.latestSanctionsCheck.outcome)}
              />
            ) : (
              <StatusPill label="Not yet checked" tone="neutral" />
            )}
          </div>
          {summary.latestSanctionsCheck ? (
            <div className="muted" style={{ fontSize: 12.5 }}>
              Last recorded on {formatUkShortDate(summary.latestSanctionsCheck.recordedAt)} · Scope:{' '}
              {summary.latestSanctionsCheck.screeningScope}
              {summary.latestSanctionsCheck.referenceCode
                ? ` · Ref: ${summary.latestSanctionsCheck.referenceCode}`
                : ''}
            </div>
          ) : null}
          {summary.canRecord ? (
            <form
              onSubmit={(e) => void handleRecordScreening(e)}
              style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
            >
              <select
                className="field-select"
                aria-label="Manual watchlist outcome"
                value={screeningOutcome}
                onChange={(e) => setScreeningOutcome(e.target.value as SanctionsPepOutcome)}
              >
                <option value={SCREENING_NO_MATCH}>No match recorded (manual check)</option>
                <option value={SCREENING_FLAGGED}>Potential match flagged</option>
                <option value={SCREENING_PENDING}>Pending review</option>
              </select>
              <input
                type="text"
                className="field-input"
                aria-label="Manual watchlist scope"
                placeholder="Screening scope"
                value={screeningScope}
                onChange={(e) => setScreeningScope(e.target.value)}
              />
              <input
                type="text"
                className="field-input"
                aria-label="Manual watchlist reference"
                placeholder="Optional reference code"
                value={screeningRef}
                onChange={(e) => setScreeningRef(e.target.value)}
              />
              <input
                type="text"
                className="field-input"
                aria-label="Manual watchlist notes"
                placeholder="Optional notes"
                value={screeningNotes}
                onChange={(e) => setScreeningNotes(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn--secondary btn--sm"
                disabled={busyKey !== null}
              >
                {busyKey === 'screening' ? 'Saving…' : 'Record watchlist check'}
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </section>
  );
}
