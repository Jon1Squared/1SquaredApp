'use client';

import React, { useMemo, useState } from 'react';
import {
  Check,
  Download,
  FileCheck2,
  FileText,
  RotateCcw,
  Sliders,
  Sparkles,
  X,
} from 'lucide-react';
import {
  assembleClientCareLetter,
  buildDefaultClientCareAnswers,
  type ClientCareLetterAnswers,
  downloadClientCareDocx,
  downloadClientCarePdf,
  type FeeBasisAssemblyMode,
  type IdVerificationAssemblyMode,
  type SavedAssembledDocument,
} from '@/domain/documentAssembly';
import { personDisplayName } from '@/domain/names';
import type {
  ChoiceValue,
  Enquiry,
  Matter,
  Organisation,
  Person,
  Quote,
} from '@/domain/types';

export interface DocumentAssemblyModalProps {
  open: boolean;
  onClose: () => void;
  matter: Matter;
  people: Person[];
  organisations: Organisation[];
  values: ChoiceValue[];
  quotes?: Quote[];
  enquiries?: Enquiry[];
  currentUserId?: string;
  initialSavedDoc?: SavedAssembledDocument | null;
  onSaveAssembledDocument?: (savedDoc: SavedAssembledDocument) => Promise<void> | void;
}

type ActiveInputTab = 'conditions' | 'instructions' | 'placeholders';

export function DocumentAssemblyModal({
  open,
  onClose,
  matter,
  people,
  organisations,
  values,
  quotes = [],
  enquiries = [],
  currentUserId = 'P-0001',
  initialSavedDoc = null,
  onSaveAssembledDocument,
}: DocumentAssemblyModalProps) {
  const defaultAnswers = useMemo(
    () =>
      buildDefaultClientCareAnswers({
        matter,
        people,
        organisations,
        values,
        quotes,
        enquiries,
        currentUserId,
      }),
    [matter, people, organisations, values, quotes, enquiries, currentUserId],
  );

  const [answers, setAnswers] = useState<ClientCareLetterAnswers>(
    () => initialSavedDoc?.answers ?? defaultAnswers,
  );
  const [activeSectionTab, setActiveSectionTab] = useState<ActiveInputTab>('conditions');
  const [saving, setSaving] = useState(false);

  // Sync when modal opens with a different saved doc or matter
  React.useEffect(() => {
    if (open) {
      setAnswers(initialSavedDoc?.answers ?? defaultAnswers);
    }
  }, [open, initialSavedDoc, defaultAnswers]);

  const assembled = useMemo(() => assembleClientCareLetter(answers), [answers]);

  if (!open) return null;

  function updateField<K extends keyof ClientCareLetterAnswers>(
    key: K,
    value: ClientCareLetterAnswers[K],
  ) {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  }

  function handleResetDefaults() {
    setAnswers(defaultAnswers);
  }

  async function handleSaveToMatter(andDownloadDocx = false) {
    if (andDownloadDocx) {
      downloadClientCareDocx(assembled);
    }
    if (!onSaveAssembledDocument) return;
    setSaving(true);
    try {
      const currentUserObj = people.find((p) => p.id === currentUserId);
      const currentUserName = currentUserObj
        ? personDisplayName(currentUserObj)
        : 'Fee Earner';
      const existingList =
        (matter.fieldValues?.['assembledDocuments'] as
          | SavedAssembledDocument[]
          | undefined) ?? [];
      const nextVersion = initialSavedDoc
        ? initialSavedDoc.version + 1
        : existingList.length + 1;
      const safeRef = assembled.ourRef.replace(/[^a-zA-Z0-9_-]/g, '-');
      const savedDoc: SavedAssembledDocument = {
        id: initialSavedDoc?.id ?? `DOC-CCL-${Date.now()}`,
        templateId: 'client_care_letter_v1',
        templateName: 'Client Care & Engagement Letter',
        fileName: `Client-Care-Letter-${safeRef}-v${nextVersion}.docx`,
        version: nextVersion,
        createdAt: new Date().toISOString(),
        createdById: currentUserId,
        createdByName: currentUserName,
        answers,
      };
      await onSaveAssembledDocument(savedDoc);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12.5,
    fontWeight: 700,
    color: '#0f172a',
    marginBottom: 4,
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    fontSize: 13,
    color: '#0f172a',
    background: '#ffffff',
    border: '1px solid #cbd5e1',
    borderRadius: 7,
    fontFamily: 'inherit',
  };

  const cardStyle: React.CSSProperties = {
    background: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    padding: '14px 16px',
    marginBottom: 12,
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="doc-assembly-title"
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
          maxWidth: 1240,
          height: '90vh',
          maxHeight: 880,
          background: '#f8fafc',
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(15, 23, 42, 0.28)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid #cbd5e1',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* MODAL HEADER */}
        <div
          style={{
            padding: '16px 22px',
            background: '#ffffff',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
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
                flexShrink: 0,
              }}
            >
              <FileText size={20} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h2
                  id="doc-assembly-title"
                  style={{
                    margin: 0,
                    fontSize: 17,
                    fontWeight: 800,
                    color: '#0f172a',
                  }}
                >
                  Document Assembly — Client Care &amp; Engagement Letter
                </h2>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: '#e0f0ec',
                    color: '#0d5c54',
                  }}
                >
                  Precedent v1.0
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 2 }}>
                Pre-populated from <strong>{matter.matterNumber}</strong> ({matter.title}). Answer
                the questions on the left to add, remove, or tailor clauses in real time.
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={handleResetDefaults}
              className="btn btn--ghost btn--sm"
              title="Reset all answers to Matter defaults"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <RotateCcw size={14} />
              <span>Reset to Matter data</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close document assembly modal"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: '#64748b',
                padding: 6,
                borderRadius: 6,
                display: 'inline-flex',
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* SPLIT BODY: QUESTIONNAIRE (LEFT) + LIVE PREVIEW (RIGHT) */}
        <div
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: 'minmax(420px, 480px) minmax(0, 1fr)',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          {/* LEFT PANE: QUESTIONNAIRE & PLACEHOLDERS */}
          <div
            style={{
              borderRight: '1px solid #e2e8f0',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              background: '#f8fafc',
            }}
          >
            {/* Sub-navigation tabs */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 6,
                padding: '10px 16px',
                background: '#ffffff',
                borderBottom: '1px solid #e2e8f0',
              }}
            >
              <button
                type="button"
                onClick={() => setActiveSectionTab('conditions')}
                style={{
                  padding: '7px 8px',
                  fontSize: 12,
                  fontWeight: 700,
                  borderRadius: 7,
                  border:
                    activeSectionTab === 'conditions'
                      ? '1.5px solid #0d5c54'
                      : '1px solid #e2e8f0',
                  background: activeSectionTab === 'conditions' ? '#f2f9f7' : '#ffffff',
                  color: activeSectionTab === 'conditions' ? '#0d5c54' : '#475569',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 5,
                }}
              >
                <Sliders size={13} />
                <span>1. Logic &amp; Clauses</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveSectionTab('instructions')}
                style={{
                  padding: '7px 8px',
                  fontSize: 12,
                  fontWeight: 700,
                  borderRadius: 7,
                  border:
                    activeSectionTab === 'instructions'
                      ? '1.5px solid #0d5c54'
                      : '1px solid #e2e8f0',
                  background: activeSectionTab === 'instructions' ? '#f2f9f7' : '#ffffff',
                  color: activeSectionTab === 'instructions' ? '#0d5c54' : '#475569',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 5,
                }}
              >
                <Sparkles size={13} />
                <span>2. Scope &amp; Work</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveSectionTab('placeholders')}
                style={{
                  padding: '7px 8px',
                  fontSize: 12,
                  fontWeight: 700,
                  borderRadius: 7,
                  border:
                    activeSectionTab === 'placeholders'
                      ? '1.5px solid #0d5c54'
                      : '1px solid #e2e8f0',
                  background: activeSectionTab === 'placeholders' ? '#f2f9f7' : '#ffffff',
                  color: activeSectionTab === 'placeholders' ? '#0d5c54' : '#475569',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 5,
                }}
              >
                <FileCheck2 size={13} />
                <span>3. Details &amp; Refs</span>
              </button>
            </div>

            {/* Scrollable Questionnaire Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              {activeSectionTab === 'conditions' ? (
                <>
                  {/* Q1: Fee Basis Branching */}
                  <div style={cardStyle}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>
                      How are fees charged on this matter?
                    </div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
                      Switches the <strong>Our fees</strong> paragraph between the Fixed Fee wording
                      and the Hourly Rate table.
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      {(
                        [
                          { key: 'fixed', label: 'Fixed fee' },
                          { key: 'hourly', label: 'Hourly rates' },
                        ] as { key: FeeBasisAssemblyMode; label: string }[]
                      ).map((opt) => {
                        const active = answers.feeBasisMode === opt.key;
                        return (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => updateField('feeBasisMode', opt.key)}
                            style={{
                              padding: '9px 12px',
                              borderRadius: 8,
                              border: active ? '1.5px solid #0d5c54' : '1px solid #cbd5e1',
                              background: active ? '#f2f9f7' : '#ffffff',
                              color: active ? '#0d5c54' : '#0f172a',
                              fontWeight: 700,
                              fontSize: 12.5,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                            }}
                          >
                            <span>{opt.label}</span>
                            {active ? <Check size={14} /> : null}
                          </button>
                        );
                      })}
                    </div>

                    {answers.feeBasisMode === 'fixed' ? (
                      <div style={{ marginTop: 12 }}>
                        <label style={labelStyle}>Fixed fee amount (£ ex VAT)</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.fixedFeeAmount}
                          onChange={(e) => updateField('fixedFeeAmount', e.target.value)}
                        />
                      </div>
                    ) : (
                      <div style={{ marginTop: 12 }}>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(3, 1fr)',
                            gap: 8,
                            marginBottom: 10,
                          }}
                        >
                          <div>
                            <label style={labelStyle}>Partner (£/hr)</label>
                            <input
                              type="text"
                              style={inputStyle}
                              value={answers.partnerRate}
                              onChange={(e) => updateField('partnerRate', e.target.value)}
                            />
                          </div>
                          <div>
                            <label style={labelStyle}>Associate (£/hr)</label>
                            <input
                              type="text"
                              style={inputStyle}
                              value={answers.associateRate}
                              onChange={(e) => updateField('associateRate', e.target.value)}
                            />
                          </div>
                          <div>
                            <label style={labelStyle}>Trainee (£/hr)</label>
                            <input
                              type="text"
                              style={inputStyle}
                              value={answers.traineeRate}
                              onChange={(e) => updateField('traineeRate', e.target.value)}
                            />
                          </div>
                        </div>
                        <div>
                          <label style={labelStyle}>Total cost estimate (£ ex VAT)</label>
                          <input
                            type="text"
                            style={inputStyle}
                            value={answers.estimateAmount}
                            onChange={(e) => updateField('estimateAmount', e.target.value)}
                          />
                        </div>
                      </div>
                    )}

                    <div
                      style={{
                        marginTop: 12,
                        paddingTop: 10,
                        borderTop: '1px solid #f1f5f9',
                      }}
                    >
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: '#0f172a',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={answers.includeDisbursements}
                          onChange={(e) =>
                            updateField('includeDisbursements', e.target.checked)
                          }
                          style={{ accentColor: '#0d5c54', width: 15, height: 15 }}
                        />
                        <span>Include estimated disbursements</span>
                      </label>
                      {answers.includeDisbursements ? (
                        <div style={{ marginTop: 8 }}>
                          <label style={labelStyle}>Approximate disbursements (£)</label>
                          <input
                            type="text"
                            style={inputStyle}
                            value={answers.disbursementsAmount}
                            onChange={(e) =>
                              updateField('disbursementsAmount', e.target.value)
                            }
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {/* Q2: Payment on Account Section */}
                  <div style={cardStyle}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a' }}>
                          Require payment on account?
                        </div>
                        <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                          Adds or removes the entire <strong>Payment on account</strong> section.
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={answers.requirePaymentOnAccount}
                        onChange={(e) =>
                          updateField('requirePaymentOnAccount', e.target.checked)
                        }
                        style={{ accentColor: '#0d5c54', width: 18, height: 18, cursor: 'pointer' }}
                      />
                    </div>
                    {answers.requirePaymentOnAccount ? (
                      <div style={{ marginTop: 10 }}>
                        <label style={labelStyle}>Payment on account amount (£)</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.paymentOnAccountAmount}
                          onChange={(e) =>
                            updateField('paymentOnAccountAmount', e.target.value)
                          }
                        />
                      </div>
                    ) : null}
                  </div>

                  {/* Q3: Identification Section & Enclosures */}
                  <div style={cardStyle}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>
                      Client identification status
                    </div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
                      Controls the <strong>Identification</strong> paragraph and automatically
                      updates the <strong>Enc:</strong> list at the foot of the letter.
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {(
                        [
                          {
                            key: 'required',
                            label: 'ID required — enclose Client Identification Form',
                          },
                          {
                            key: 'already_verified',
                            label: 'ID already verified on file (remove form from Enclosures)',
                          },
                          {
                            key: 'omit',
                            label: 'Omit Identification section entirely',
                          },
                        ] as { key: IdVerificationAssemblyMode; label: string }[]
                      ).map((opt) => (
                        <label
                          key={opt.key}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontSize: 12.5,
                            color: '#0f172a',
                            cursor: 'pointer',
                            padding: '6px 8px',
                            borderRadius: 6,
                            background:
                              answers.idVerificationMode === opt.key ? '#f2f9f7' : 'transparent',
                          }}
                        >
                          <input
                            type="radio"
                            name="id-verification-mode"
                            checked={answers.idVerificationMode === opt.key}
                            onChange={() => updateField('idVerificationMode', opt.key)}
                            style={{ accentColor: '#0d5c54', width: 15, height: 15 }}
                          />
                          <span>{opt.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Q4: Supervision & Additional Clauses */}
                  <div style={cardStyle}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>
                      Additional conditional clauses &amp; rows
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12.5,
                          color: '#0f172a',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={answers.isSupervisedByPartner}
                          onChange={(e) =>
                            updateField('isSupervisedByPartner', e.target.checked)
                          }
                          style={{ accentColor: '#0d5c54', width: 15, height: 15 }}
                        />
                        <span>
                          Fee earner is supervised by a separate Partner (
                          {answers.supervisingPartnerName})
                        </span>
                      </label>

                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12.5,
                          color: '#0f172a',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={answers.includeExclusions}
                          onChange={(e) => updateField('includeExclusions', e.target.checked)}
                          style={{ accentColor: '#0d5c54', width: 15, height: 15 }}
                        />
                        <span>
                          Include scope exclusions sentence in <strong>Your instructions</strong>
                        </span>
                      </label>

                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12.5,
                          color: '#0f172a',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={answers.includeOrganisation}
                          onChange={(e) =>
                            updateField('includeOrganisation', e.target.checked)
                          }
                          style={{ accentColor: '#0d5c54', width: 15, height: 15 }}
                        />
                        <span>Include Organisation line in recipient address block</span>
                      </label>

                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12.5,
                          color: '#0f172a',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={answers.includeYourRef}
                          onChange={(e) => updateField('includeYourRef', e.target.checked)}
                          style={{ accentColor: '#0d5c54', width: 15, height: 15 }}
                        />
                        <span>Include &ldquo;Your ref&rdquo; line at top of letter</span>
                      </label>

                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12.5,
                          color: '#0f172a',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={answers.sendByEmail}
                          onChange={(e) => updateField('sendByEmail', e.target.checked)}
                          style={{ accentColor: '#0d5c54', width: 15, height: 15 }}
                        />
                        <span>Include &ldquo;By email:&rdquo; delivery line</span>
                      </label>

                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12.5,
                          color: '#0f172a',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={answers.includeForAndOnBehalfOf}
                          onChange={(e) =>
                            updateField('includeForAndOnBehalfOf', e.target.checked)
                          }
                          style={{ accentColor: '#0d5c54', width: 15, height: 15 }}
                        />
                        <span>
                          Include &ldquo;For and on behalf of [Client name]&rdquo; row in
                          acceptance table
                        </span>
                      </label>
                    </div>
                  </div>
                </>
              ) : null}

              {activeSectionTab === 'instructions' ? (
                <div style={cardStyle}>
                  <div style={{ marginBottom: 12 }}>
                    <label style={labelStyle}>Your matter: [Matter description]</label>
                    <input
                      type="text"
                      style={inputStyle}
                      value={answers.matterDescription}
                      onChange={(e) => updateField('matterDescription', e.target.value)}
                    />
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <label style={labelStyle}>
                      Summary of instructions (&ldquo;You have asked us to…&rdquo;)
                    </label>
                    <textarea
                      rows={3}
                      style={{ ...inputStyle, resize: 'vertical' }}
                      value={answers.summaryOfInstructions}
                      onChange={(e) => updateField('summaryOfInstructions', e.target.value)}
                    />
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <label style={labelStyle}>
                      List of tasks (&ldquo;Our work will include…&rdquo;)
                    </label>
                    <textarea
                      rows={3}
                      style={{ ...inputStyle, resize: 'vertical' }}
                      value={answers.listOfTasks}
                      onChange={(e) => updateField('listOfTasks', e.target.value)}
                    />
                  </div>

                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 4,
                      }}
                    >
                      <label style={{ ...labelStyle, marginBottom: 0 }}>
                        Exclusions (&ldquo;It will not include…&rdquo;)
                      </label>
                      <label
                        style={{
                          fontSize: 12,
                          color: '#0d5c54',
                          fontWeight: 600,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={answers.includeExclusions}
                          onChange={(e) => updateField('includeExclusions', e.target.checked)}
                          style={{ accentColor: '#0d5c54' }}
                        />
                        <span>Include in letter</span>
                      </label>
                    </div>
                    {answers.includeExclusions ? (
                      <textarea
                        rows={2}
                        style={{ ...inputStyle, resize: 'vertical' }}
                        value={answers.exclusions}
                        onChange={(e) => updateField('exclusions', e.target.value)}
                      />
                    ) : (
                      <div style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic' }}>
                        Exclusions sentence is currently omitted from the letter.
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              {activeSectionTab === 'placeholders' ? (
                <>
                  <div style={cardStyle}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: '#64748b',
                        marginBottom: 10,
                      }}
                    >
                      References, Firm &amp; Recipient
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: 10,
                        marginBottom: 10,
                      }}
                    >
                      <div>
                        <label style={labelStyle}>Firm name</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.firmName}
                          onChange={(e) => updateField('firmName', e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Date [DD Month YYYY]</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.letterDate}
                          onChange={(e) => updateField('letterDate', e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Our ref [OUR REF]</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.ourRef}
                          onChange={(e) => updateField('ourRef', e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Your ref [YOUR REF]</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.yourRef}
                          disabled={!answers.includeYourRef}
                          onChange={(e) => updateField('yourRef', e.target.value)}
                        />
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: 10,
                        marginBottom: 10,
                      }}
                    >
                      <div>
                        <label style={labelStyle}>Recipient name</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.recipientName}
                          onChange={(e) => updateField('recipientName', e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Dear [Name]</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.salutationName}
                          onChange={(e) => updateField('salutationName', e.target.value)}
                        />
                      </div>
                    </div>

                    {answers.includeOrganisation ? (
                      <div style={{ marginBottom: 10 }}>
                        <label style={labelStyle}>Organisation</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.organisationName}
                          onChange={(e) => updateField('organisationName', e.target.value)}
                        />
                      </div>
                    ) : null}

                    <div style={{ marginBottom: 10 }}>
                      <label style={labelStyle}>Address line 1</label>
                      <input
                        type="text"
                        style={inputStyle}
                        value={answers.addressLine1}
                        onChange={(e) => updateField('addressLine1', e.target.value)}
                      />
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: 10,
                        marginBottom: 10,
                      }}
                    >
                      <div>
                        <label style={labelStyle}>Town or city</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.townOrCity}
                          onChange={(e) => updateField('townOrCity', e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Postcode</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.postcode}
                          onChange={(e) => updateField('postcode', e.target.value)}
                        />
                      </div>
                    </div>

                    {answers.sendByEmail ? (
                      <div>
                        <label style={labelStyle}>By email</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.recipientEmail}
                          onChange={(e) => updateField('recipientEmail', e.target.value)}
                        />
                      </div>
                    ) : null}
                  </div>

                  <div style={cardStyle}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: '#64748b',
                        marginBottom: 10,
                      }}
                    >
                      People, Supervision &amp; Sign-Off
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: 10,
                        marginBottom: 10,
                      }}
                    >
                      <div>
                        <label style={labelStyle}>Fee earner name</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.feeEarnerName}
                          onChange={(e) => updateField('feeEarnerName', e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Fee earner position</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.feeEarnerPosition}
                          onChange={(e) => updateField('feeEarnerPosition', e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Supervising partner</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.supervisingPartnerName}
                          onChange={(e) =>
                            updateField('supervisingPartnerName', e.target.value)
                          }
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Complaints partner</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.complaintsPartnerName}
                          onChange={(e) =>
                            updateField('complaintsPartnerName', e.target.value)
                          }
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Author name</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.authorName}
                          onChange={(e) => updateField('authorName', e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Author position</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.authorPosition}
                          onChange={(e) => updateField('authorPosition', e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Direct line</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.authorDirectLine}
                          onChange={(e) => updateField('authorDirectLine', e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Author email</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={answers.authorEmail}
                          onChange={(e) => updateField('authorEmail', e.target.value)}
                        />
                      </div>
                    </div>

                    <div>
                      <label style={labelStyle}>Client name (for acceptance table)</label>
                      <input
                        type="text"
                        style={inputStyle}
                        value={answers.clientName}
                        onChange={(e) => updateField('clientName', e.target.value)}
                      />
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {/* RIGHT PANE: LIVE A4 DOCUMENT PREVIEW */}
          <div
            style={{
              background: '#e2e8f0',
              overflowY: 'auto',
              padding: '24px 32px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                width: '100%',
                maxWidth: 740,
                background: '#ffffff',
                borderRadius: 6,
                boxShadow: '0 10px 30px rgba(15, 23, 42, 0.12)',
                padding: '44px 52px',
                color: '#0f172a',
                fontSize: 13.5,
                lineHeight: 1.6,
                fontFamily: ' Calibri, "Segoe UI", sans-serif',
              }}
            >
              {/* References & Date Header */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '95px 1fr',
                  rowGap: 3,
                  marginBottom: 20,
                  fontSize: 13,
                }}
              >
                <span style={{ fontWeight: 700, color: '#334155' }}>Our ref</span>
                <span>{assembled.ourRef}</span>
                {assembled.yourRef ? (
                  <>
                    <span style={{ fontWeight: 700, color: '#334155' }}>Your ref</span>
                    <span>{assembled.yourRef}</span>
                  </>
                ) : null}
                <span style={{ fontWeight: 700, color: '#334155' }}>Date</span>
                <span>{assembled.letterDate}</span>
              </div>

              {/* Recipient Address Block */}
              <div style={{ marginBottom: 16 }}>
                {assembled.recipientLines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>

              {/* By Email */}
              {assembled.byEmailLine ? (
                <div style={{ fontWeight: 700, marginBottom: 16 }}>
                  {assembled.byEmailLine}
                </div>
              ) : null}

              {/* Salutation & Subject */}
              <div style={{ marginBottom: 12 }}>{assembled.salutation}</div>
              <div
                style={{
                  fontWeight: 800,
                  fontSize: 14.5,
                  color: '#0f172a',
                  marginBottom: 12,
                }}
              >
                {assembled.subjectLine}
              </div>

              {/* Opening Paragraph */}
              <p style={{ margin: '0 0 16px 0' }}>{assembled.openingParagraph}</p>

              {/* Dynamic Sections */}
              {assembled.sections.map((sec) => (
                <div
                  key={sec.id}
                  style={{
                    marginBottom: 16,
                    padding: sec.conditionTag ? '10px 12px' : 0,
                    borderRadius: sec.conditionTag ? 8 : 0,
                    background: sec.conditionTag ? '#f8fafc' : 'transparent',
                    borderLeft: sec.conditionTag ? '3px solid #0d5c54' : 'none',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      marginBottom: 4,
                    }}
                  >
                    {sec.heading ? (
                      <div
                        style={{
                          fontWeight: 800,
                          fontSize: 13.5,
                          color: '#0d5c54',
                        }}
                      >
                        {sec.heading}
                      </div>
                    ) : null}
                    {sec.conditionTag ? (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          color: '#0d5c54',
                          background: '#e0f0ec',
                          padding: '1px 7px',
                          borderRadius: 999,
                        }}
                      >
                        {sec.conditionTag}
                      </span>
                    ) : null}
                  </div>
                  {sec.paragraphs.map((p, idx) => (
                    <p
                      key={idx}
                      style={{
                        margin: idx === sec.paragraphs.length - 1 ? 0 : '0 0 8px 0',
                      }}
                    >
                      {p}
                    </p>
                  ))}
                </div>
              ))}

              {/* Sign-Off */}
              <div style={{ marginTop: 22, marginBottom: 22 }}>
                <div style={{ marginBottom: 24 }}>{assembled.signOff.yoursSincerely}</div>
                <div style={{ fontWeight: 700 }}>{assembled.signOff.authorName}</div>
                <div>{assembled.signOff.authorPositionAndFirm}</div>
                {assembled.signOff.contactLine ? (
                  <div style={{ fontSize: 12.5, color: '#475569', marginTop: 2 }}>
                    {assembled.signOff.contactLine}
                  </div>
                ) : null}
                <div
                  style={{
                    fontSize: 12.5,
                    fontStyle: 'italic',
                    color: '#334155',
                    marginTop: 12,
                  }}
                >
                  {assembled.signOff.enclosuresLine}
                </div>
              </div>

              {/* Client Acceptance Table */}
              <div
                style={{
                  borderTop: '1px solid #cbd5e1',
                  paddingTop: 18,
                }}
              >
                <div
                  style={{
                    fontWeight: 800,
                    fontSize: 13.5,
                    color: '#0d5c54',
                    marginBottom: 4,
                  }}
                >
                  {assembled.acceptance.heading}
                </div>
                <p style={{ margin: '0 0 12px 0' }}>{assembled.acceptance.statement}</p>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 13,
                  }}
                >
                  <tbody>
                    {assembled.acceptance.rows.map((r) => (
                      <tr key={r.label}>
                        <td
                          style={{
                            width: '36%',
                            padding: '8px 12px',
                            border: '1px solid #cbd5e1',
                            background: '#f8fafc',
                            fontWeight: 700,
                          }}
                        >
                          {r.label}
                        </td>
                        <td
                          style={{
                            padding: '8px 12px',
                            border: '1px solid #cbd5e1',
                          }}
                        >
                          {r.value}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* MODAL FOOTER */}
        <div
          style={{
            padding: '14px 22px',
            background: '#ffffff',
            borderTop: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ fontSize: 12.5, color: '#64748b' }}>
            {assembled.sections.length} active sections ·{' '}
            {answers.feeBasisMode === 'fixed' ? 'Fixed fee clause' : 'Hourly rates clause'} ·{' '}
            {answers.requirePaymentOnAccount
              ? 'Payment on account included'
              : 'Payment on account omitted'}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => downloadClientCarePdf(assembled)}
            >
              <Download size={15} />
              <span>Download PDF (.pdf)</span>
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => downloadClientCareDocx(assembled)}
            >
              <Download size={15} />
              <span>Download Word (.docx)</span>
            </button>
            {onSaveAssembledDocument ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={saving}
                onClick={() => void handleSaveToMatter(true)}
              >
                <FileCheck2 size={15} />
                <span>
                  {saving ? 'Saving…' : 'Save to Matter & Download .docx'}
                </span>
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
