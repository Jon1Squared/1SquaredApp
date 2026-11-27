'use client';

import React, { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  logQuoteFollowUpAction,
  markQuoteSentOfflineAction,
  prepareQuoteConversionAction,
  recordQuoteOutcomeAction,
  retryCommunicationChaseAction,
  sendQuoteEmailAction,
  stopCommunicationChaseAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { quoteStatusTone } from '@/domain/badges';
import { addDays, formatDate, formatDateTime, toIsoDate } from '@/domain/dates';
import { enquiryDisplayName } from '@/domain/enquiries';
import { resolveLabel } from '@/domain/lists';
import { formatConversionConflictWarningsNotice } from '@/domain/matterConflicts';
import { personDisplayName, primaryEmail } from '@/domain/names';
import {
  calculateQuoteTotals,
  evaluateQuoteEffectiveStatus,
  formatGbp,
  isQuoteExpired,
  isQuoteFollowUpOverdue,
  QUOTE_DECLINE_REASONS,
  quoteClientDisplayName,
  quoteWorkTypeSummary,
} from '@/domain/quotes';
import type {
  ChoiceValue,
  ContactLogMethod,
  Enquiry,
  Matter,
  OrgStructureCatalogue,
  Organisation,
  Person,
  PersonOrganisationLink,
  Quote,
  QuoteDeclineReason,
} from '@/domain/types';
import {
  formatMinorUnitsGbp,
  minorUnitsToPounds,
  poundsToMinorUnits,
  sumMinorUnits,
  type CommunicationChaseEventRecord,
  type CommunicationChaseRecord,
  type FeeArrangementCapEntry,
  type ResolvedApplicableRatesResult,
  type WorkTypesConfiguration,
} from '@platform/core-api';
import { formatRateTierBadgeLabel } from '@/domain/matterCosts';
import { QuoteFormClient } from './QuoteFormClient';
import { createSendIdempotencyController } from './sendIdempotency';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  quote: Quote;
  enquiries: Enquiry[];
  matters: Matter[];
  people: Person[];
  organisations: Organisation[];
  links?: PersonOrganisationLink[];
  values: ChoiceValue[];
  orgStructure?: OrgStructureCatalogue;
  currentUserId: string;
  tenantId: string;
  tenantVatRatePercent?: number;
  workTypesConfig?: WorkTypesConfiguration;
  firmFeeArrangementCaps?: FeeArrangementCapEntry[];
  initialAction?: string | null;
  initialResolvedRates?: ResolvedApplicableRatesResult | null;
  quoteChases?: Array<{
    chase: CommunicationChaseRecord;
    events: CommunicationChaseEventRecord[];
  }>;
  emailProviderDisabled?: boolean;
}

export function QuoteDetailClient({
  quote,
  enquiries,
  matters,
  people,
  organisations,
  links = [],
  values,
  orgStructure,
  currentUserId,
  tenantId,
  tenantVatRatePercent = 20,
  workTypesConfig,
  firmFeeArrangementCaps,
  initialAction = null,
  initialResolvedRates = null,
  quoteChases = [],
  emailProviderDisabled = false,
}: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const now = useMemo(() => new Date(), []);

  const [viewMode, setViewMode] = useState<'detail' | 'edit' | 'revise'>(() =>
    initialAction === 'revise' ? 'revise' : 'detail',
  );
  const [followUpModalOpen, setFollowUpModalOpen] = useState(false);
  const [outcomeModalOpen, setOutcomeModalOpen] = useState(false);

  // Follow-up modal state
  const [followUpMethod, setFollowUpMethod] = useState<ContactLogMethod>('Phone');
  const [followUpNote, setFollowUpNote] = useState('');
  const [nextFollowUpDate, setNextFollowUpDate] = useState(() =>
    toIsoDate(addDays(new Date(), quote.followUpAfterDays || 7)),
  );

  // Outcome modal state
  const [outcomeType, setOutcomeType] = useState<'Accepted' | 'Declined'>('Accepted');
  const [declineReason, setDeclineReason] = useState<QuoteDeclineReason>('Price');
  const [outcomeNote, setOutcomeNote] = useState('');

  // Email & offline dispatch modals
  const linkedPersonRec = useMemo(
    () => (quote.linkedPersonId ? people.find((p) => p.id === quote.linkedPersonId) ?? null : null),
    [people, quote.linkedPersonId],
  );
  const linkedOrgRec = useMemo(
    () =>
      quote.linkedOrganisationId
        ? organisations.find((o) => o.id === quote.linkedOrganisationId) ?? null
        : null,
    [organisations, quote.linkedOrganisationId],
  );
  const linkedEnquiryForEmail = useMemo(
    () => (quote.linkedEnquiryId ? enquiries.find((e) => e.id === quote.linkedEnquiryId) ?? null : null),
    [enquiries, quote.linkedEnquiryId],
  );
  const resolvedDefaultEmail = (
    quote.sentToEmail ||
    quote.prospectEmail ||
    (linkedPersonRec ? primaryEmail(linkedPersonRec) : '') ||
    linkedOrgRec?.generalEmail ||
    linkedEnquiryForEmail?.email ||
    ''
  ).trim();
  const [sendEmailModalOpen, setSendEmailModalOpen] = useState(false);
  const [sendRecipientEmail, setSendRecipientEmail] = useState(resolvedDefaultEmail);
  const [sendRecipientName, setSendRecipientName] = useState(
    quote.prospectName || (linkedPersonRec ? personDisplayName(linkedPersonRec) : linkedOrgRec?.legalName ?? ''),
  );
  const [sendCustomNote, setSendCustomNote] = useState(
    quote.priceTransparencySnapshot?.customNote ?? '',
  );
  const [sendEmailError, setSendEmailError] = useState<string | null>(null);
  const [queuedNoticeVisible, setQueuedNoticeVisible] = useState(false);

  const [offlineModalOpen, setOfflineModalOpen] = useState(false);
  const [offlineSentDate, setOfflineSentDate] = useState(() => toIsoDate(new Date()));
  const [offlineNote, setOfflineNote] = useState('');
  const [chaseBusy, setChaseBusy] = useState(false);

  const quoteSendControllerRef = useRef<ReturnType<
    typeof createSendIdempotencyController
  > | null>(null);
  const getQuoteSendController = () => {
    if (!quoteSendControllerRef.current) {
      quoteSendControllerRef.current = createSendIdempotencyController();
    }
    return quoteSendControllerRef.current;
  };
  useEffect(() => {
    quoteSendControllerRef.current?.reset();
  }, [quote.id, quote.version, resolvedDefaultEmail]);

  const openSendEmailModal = () => {
    setSendRecipientEmail(resolvedDefaultEmail);
    setSendEmailError(null);
    setSendEmailModalOpen(true);
  };

  const activeOrLatestChase = useMemo(
    () =>
      quoteChases.find(
        (c) =>
          c.chase.status === 'active' ||
          c.chase.status === 'needs_owner' ||
          c.chase.status === 'failed',
      ) ?? quoteChases[0] ?? null,
    [quoteChases],
  );

  const effectiveStatus = evaluateQuoteEffectiveStatus(quote, now);
  const overdueFollowUp = isQuoteFollowUpOverdue(quote, now);
  const expired = isQuoteExpired(quote, now);

  const clientName = quoteClientDisplayName(quote, people, organisations);
  const workSummary = quoteWorkTypeSummary(quote, values);
  const practiceAreaLabel = resolveLabel(values, quote.practiceAreaId);
  const subcategoryLabel = quote.workTypeSubcategoryId
    ? resolveLabel(values, quote.workTypeSubcategoryId)
    : '';

  const linkedEnquiry = quote.linkedEnquiryId
    ? enquiries.find((e) => e.id === quote.linkedEnquiryId) ?? null
    : null;
  const convertedMatter = quote.convertedMatterId
    ? matters.find((m) => m.id === quote.convertedMatterId) ?? null
    : null;

  const quoteVatRatePercent = quote.vatRatePercent ?? 20;

  const totals = useMemo(
    () =>
      calculateQuoteTotals(
        quote.feeAmountExVat,
        quote.vatAmount,
        quote.disbursements,
        quoteVatRatePercent,
      ),
    [quote.feeAmountExVat, quote.vatAmount, quote.disbursements, quoteVatRatePercent],
  );

  const nameOfPerson = (id: string | null | undefined) => {
    if (!id) return '';
    const p = people.find((x) => x.id === id);
    return p ? personDisplayName(p) : id;
  };

  const handleSendQuoteEmailSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = sendRecipientEmail.trim();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setSendEmailError('Please enter a valid recipient email address.');
      return;
    }
    setSendEmailError(null);
    startTransition(async () => {
      await getQuoteSendController().runGuarded(async (idempotencyKey) => {
        const res = await sendQuoteEmailAction({
          quoteId: quote.id,
          recipientEmail: cleanEmail,
          recipientName: sendRecipientName.trim() || undefined,
          customNote: sendCustomNote.trim() || undefined,
          idempotencyKey,
        });
        if (isActionDenied(res) || !res.ok) {
          const msg = isActionDenied(res) ? res.message : res.message;
          setSendEmailError(msg || 'Failed to send quote email.');
          showToast(msg || 'Failed to send quote email.');
          return;
        }
        quoteSendControllerRef.current?.reset();
        setSendEmailModalOpen(false);
        if (res.emailProviderDisabled) {
          setQueuedNoticeVisible(true);
          showToast('Quote email queued in outbox (email delivery is currently disabled).');
        } else {
          showToast(
            `Quote ${res.quote.reference} sent to ${cleanEmail} · Follow-up scheduled for ${formatDate(res.quote.nextFollowUpDate)}`,
          );
        }
        router.refresh();
      });
    });
  };

  const handleMarkSentOfflineSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await markQuoteSentOfflineAction({
        quoteId: quote.id,
        sentDate: offlineSentDate.trim() || undefined,
        note: offlineNote.trim() || undefined,
      });
      if (isActionDenied(res) || !res.ok) {
        const msg = isActionDenied(res) ? res.message : res.message;
        showToast(msg || 'Failed to mark quote as sent offline.');
        return;
      }
      setOfflineModalOpen(false);
      setOfflineNote('');
      showToast(
        `Quote ${res.quote.reference} recorded as sent offline · Follow-up scheduled for ${formatDate(res.quote.nextFollowUpDate)}`,
      );
      router.refresh();
    });
  };

  const handleLogFollowUpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!followUpNote.trim()) {
      showToast('Please enter a note for the follow-up.');
      return;
    }
    startTransition(async () => {
      const res = await logQuoteFollowUpAction(quote.id, {
        method: followUpMethod,
        note: followUpNote.trim(),
        nextFollowUpDate: nextFollowUpDate || null,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setFollowUpNote('');
      setFollowUpModalOpen(false);
      showToast('Follow-up logged and next follow-up date updated');
      router.refresh();
    });
  };

  const handleRecordOutcomeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (outcomeType === 'Declined' && declineReason === 'Other' && !outcomeNote.trim()) {
      showToast('Please add a note when selecting "Other" as the decline reason.');
      return;
    }
    startTransition(async () => {
      const res = await recordQuoteOutcomeAction(quote.id, {
        outcome: outcomeType,
        declineReason: outcomeType === 'Declined' ? declineReason : null,
        note: outcomeNote.trim(),
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setOutcomeModalOpen(false);
      setOutcomeNote('');
      showToast(
        outcomeType === 'Accepted'
          ? 'Quote marked as Accepted — ready to convert to matter'
          : `Quote marked as Declined (${declineReason})`,
      );
      router.refresh();
    });
  };

  const handleConvertToMatter = () => {
    startTransition(async () => {
      const res = await prepareQuoteConversionAction(quote.id);
      if (isActionDenied(res)) {
        showToast(res.message);
        return;
      }
      if (!res.ok) {
        showToast(res.error ?? res.conflictReasons?.[0] ?? 'Could not prepare quote conversion');
        return;
      }
      const warningNotice = formatConversionConflictWarningsNotice(
        res.conflictWarnings,
      );
      if (warningNotice) {
        showToast(warningNotice);
      }
      const params = new URLSearchParams();
      params.set('quoteId', quote.id);
      if (res.clientId) params.set('clientId', res.clientId);
      if (res.instructingContactId) params.set('instructingContactId', res.instructingContactId);
      if (res.enquiryId) params.set('enquiryId', res.enquiryId);
      router.push(`/matters/new?${params.toString()}`);
    });
  };

  useEffect(() => {
    if (initialAction === 'convert' && effectiveStatus === 'Accepted' && !convertedMatter) {
      handleConvertToMatter();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAction]);

  if (viewMode === 'edit' || viewMode === 'revise') {
    return (
      <QuoteFormClient
        mode={viewMode}
        existing={quote}
        initialResolvedRates={initialResolvedRates}
        enquiries={enquiries}
        matters={matters}
        people={people}
        organisations={organisations}
        links={links}
        values={values}
        orgStructure={orgStructure}
        currentUserId={currentUserId}
        tenantId={tenantId}
        tenantVatRatePercent={tenantVatRatePercent}
        workTypesConfig={workTypesConfig}
        firmFeeArrangementCaps={firmFeeArrangementCaps}
        emailProviderDisabled={emailProviderDisabled}
        onCancelOverride={() => setViewMode('detail')}
        onSuccessOverride={() => {
          setViewMode('detail');
          router.refresh();
        }}
      />
    );
  }

  return (
    <div className="page">
      {/* HEADER */}
      <div className="page-header">
        <div>
          <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
            <Link href="/enquiries">← Back to Enquiries &amp; Quotes</Link>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h1>{clientName}</h1>
            <StatusPill
              label={`${quote.reference}${quote.version > 1 ? ` · v${quote.version}` : ''}`}
              tone="neutral"
            />
            {effectiveStatus === 'Expired' ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '2px 10px',
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  background: 'rgba(100, 116, 139, 0.14)',
                  color: '#64748b',
                  border: '1px solid rgba(100, 116, 139, 0.3)',
                }}
              >
                Expired
              </span>
            ) : (
              <StatusPill label={effectiveStatus} tone={quoteStatusTone(effectiveStatus)} />
            )}
            <StatusPill label={workSummary} tone="neutral" />
            <StatusPill label={quote.feeBasis} tone="neutral" />
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            Fee earner: <strong>{nameOfPerson(quote.feeEarnerId) || 'Unassigned'}</strong> ·{' '}
            Valid until <strong>{formatDate(quote.validUntil) || '—'}</strong>
            {quote.sentAt ? (
              <>
                {' '}
                · Sent <strong>{formatDateTime(quote.sentAt)}</strong>
              </>
            ) : null}
          </div>
        </div>

        {/* AVAILABLE ACTIONS */}
        <div className="page-header__actions" style={{ gap: 8, flexWrap: 'wrap' }}>
          <a
            href={`/api/quotes/${encodeURIComponent(quote.id)}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn--secondary"
            data-testid="quote-download-pdf-link"
          >
            Download PDF
          </a>

          {effectiveStatus === 'Draft' ? (
            <>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={pending}
                onClick={() => setViewMode('edit')}
              >
                Edit quote
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="quote-mark-offline-open-btn"
                disabled={pending}
                onClick={() => setOfflineModalOpen(true)}
              >
                Record as Sent Offline
              </button>
              <button
                type="button"
                className="btn btn--primary"
                data-testid="quote-send-email-open-btn"
                disabled={pending}
                onClick={openSendEmailModal}
              >
                Send Quote by Email
              </button>
            </>
          ) : null}

          {effectiveStatus === 'Sent' || effectiveStatus === 'Follow-up due' ? (
            <>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="quote-send-email-open-btn"
                disabled={pending}
                onClick={openSendEmailModal}
              >
                Re-send Quote by Email
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={pending}
                onClick={() => setFollowUpModalOpen(true)}
              >
                Log follow-up
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={pending}
                onClick={() => {
                  setOutcomeType('Accepted');
                  setOutcomeModalOpen(true);
                }}
              >
                Record outcome
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={pending}
                onClick={() => setViewMode('revise')}
              >
                Revise quote
              </button>
            </>
          ) : null}

          {effectiveStatus === 'Accepted' ? (
            <>
              {!convertedMatter ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={pending}
                  onClick={handleConvertToMatter}
                >
                  Convert to matter
                </button>
              ) : (
                <Link href={`/matters/${convertedMatter.id}`} className="btn btn--primary">
                  Open Matter{' '}
                  {convertedMatter.matterNumber === 'DRAFT'
                    ? '(Draft)'
                    : convertedMatter.matterNumber}{' '}
                  →
                </Link>
              )}
              <button
                type="button"
                className="btn btn--secondary"
                disabled={pending}
                onClick={() => setViewMode('revise')}
              >
                Revise quote
              </button>
            </>
          ) : null}

          {effectiveStatus === 'Declined' ||
          effectiveStatus === 'Expired' ||
          effectiveStatus === 'Superseded' ? (
            <>
              <button
                type="button"
                className="btn btn--primary"
                disabled={pending}
                onClick={() => setViewMode('revise')}
              >
                Revise quote (create v{quote.version + 1})
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={pending}
                onClick={() => {
                  setOutcomeType('Accepted');
                  setOutcomeModalOpen(true);
                }}
              >
                Record outcome
              </button>
            </>
          ) : null}
        </div>
      </div>

      {/* BANNERS */}
      {emailProviderDisabled && (queuedNoticeVisible || quote.lastSentOutboxId) ? (
        <div
          className="banner banner--warning"
          role="status"
          data-testid="quote-outbox-queued-banner"
          style={{ marginBottom: 16 }}
        >
          <div>
            <strong>Quote email queued in outbox</strong>
            {quote.sentToEmail ? ` for ${quote.sentToEmail}` : ''}: live email delivery is currently
            disabled in tenant settings, so the PDF message remains pending in the email outbox
            rather than being delivered externally.
          </div>
        </div>
      ) : null}
      {overdueFollowUp ? (
        <div
          className="banner banner--warning"
          style={{
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <strong>Follow-up overdue ({formatDate(quote.nextFollowUpDate)}):</strong> This quote
            is in <strong>Follow-up due</strong> status and appears in {nameOfPerson(quote.feeEarnerId)}
            &rsquo;s Mine queue.
          </div>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setFollowUpModalOpen(true)}
          >
            Log follow-up
          </button>
        </div>
      ) : null}

      {expired ? (
        <div
          className="banner"
          style={{
            marginBottom: 16,
            background: 'rgba(100, 116, 139, 0.1)',
            border: '1px solid rgba(100, 116, 139, 0.3)',
            color: '#475569',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <strong>Quote expired on {formatDate(quote.validUntil)}:</strong> The valid-until date
            passed without an outcome. You can revise the quote to issue a new version (v
            {quote.version + 1}) or record a late outcome.
          </div>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setViewMode('revise')}
          >
            Revise quote →
          </button>
        </div>
      ) : null}

      {effectiveStatus === 'Accepted' ? (
        <div
          className="banner"
          style={{
            marginBottom: 16,
            background: 'rgba(15, 118, 110, 0.08)',
            border: '1px solid rgba(15, 118, 110, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <strong>Quote accepted{quote.outcomeAt ? ` on ${formatDate(quote.outcomeAt)}` : ''}.</strong>{' '}
            {convertedMatter ? (
              <span>
                Converted to{' '}
                <strong>
                  {convertedMatter.matterNumber === 'DRAFT'
                    ? `Draft Matter — ${convertedMatter.title}`
                    : `${convertedMatter.matterNumber} — ${convertedMatter.title}`}
                </strong>
                .
              </span>
            ) : (
              <span>
                {quote.outcomeNote || 'Client has accepted the quote.'} Click{' '}
                <strong>Convert to matter</strong> to open the New Matter screen pre-filled with
                these quote details.
              </span>
            )}
          </div>
          {convertedMatter ? (
            <Link
              href={`/matters/${convertedMatter.id}`}
              className="btn btn--primary btn--sm"
            >
              Open Matter →
            </Link>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={pending}
              onClick={handleConvertToMatter}
            >
              Convert to matter
            </button>
          )}
        </div>
      ) : null}

      {effectiveStatus === 'Declined' ? (
        <div
          className="banner"
          style={{
            marginBottom: 16,
            background: 'rgba(100, 116, 139, 0.08)',
            border: '1px solid rgba(100, 116, 139, 0.25)',
          }}
        >
          <div>
            <strong>Quote declined ({quote.declineReason || 'Reason recorded'}):</strong>{' '}
            {quote.declineNote || 'No additional notes recorded.'}
          </div>
        </div>
      ) : null}

      {/* MAIN GRID */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.3fr) minmax(320px, 0.9fr)',
          gap: 20,
          alignItems: 'start',
        }}
      >
        {/* LEFT COLUMN: SUMMARY, FEE BREAKDOWN, VERSION HISTORY */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* SUMMARY & LINKED RECORDS */}
          <section className="card" style={{ padding: 20 }}>
            <h2 style={{ fontSize: 16, marginBottom: 12 }}>Summary &amp; scope</h2>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 12,
                marginBottom: 16,
                fontSize: 13,
              }}
            >
              <div>
                <div className="muted">Client / Prospect</div>
                <div style={{ fontWeight: 600, marginTop: 2 }}>
                  {quote.linkedOrganisationId ? (
                    <Link href={`/organisations/${quote.linkedOrganisationId}`}>
                      {clientName}
                    </Link>
                  ) : quote.linkedPersonId ? (
                    <Link href={`/people/${quote.linkedPersonId}`}>{clientName}</Link>
                  ) : (
                    clientName
                  )}
                </div>
                {quote.prospectEmail || quote.prospectPhone ? (
                  <div className="muted" style={{ marginTop: 2 }}>
                    {[quote.prospectEmail, quote.prospectPhone].filter(Boolean).join(' · ')}
                  </div>
                ) : null}
              </div>

              <div>
                <div className="muted">Work type</div>
                <div style={{ fontWeight: 600, marginTop: 2 }}>
                  {practiceAreaLabel}
                  {subcategoryLabel ? ` · ${subcategoryLabel}` : ''}
                </div>
              </div>

              <div>
                <div className="muted">Linked enquiry</div>
                <div style={{ marginTop: 2 }}>
                  {linkedEnquiry ? (
                    <Link href={`/enquiries/${linkedEnquiry.id}`} style={{ fontWeight: 600 }}>
                      {linkedEnquiry.reference} — {enquiryDisplayName(linkedEnquiry)} (
                      {linkedEnquiry.status})
                    </Link>
                  ) : (
                    <span className="muted">Standalone quote</span>
                  )}
                </div>
              </div>

              <div>
                <div className="muted">Linked matter</div>
                <div style={{ marginTop: 2 }}>
                  {convertedMatter ? (
                    <Link href={`/matters/${convertedMatter.id}`} style={{ fontWeight: 600 }}>
                      {convertedMatter.matterNumber === 'DRAFT'
                        ? `Draft — ${convertedMatter.title}`
                        : `${convertedMatter.matterNumber} — ${convertedMatter.title}`}
                    </Link>
                  ) : (
                    <span className="muted">Not yet converted</span>
                  )}
                </div>
              </div>

              <div>
                <div className="muted">Valid until</div>
                <div
                  style={{
                    fontWeight: 600,
                    marginTop: 2,
                    color: expired ? '#64748b' : undefined,
                  }}
                >
                  {formatDate(quote.validUntil) || '—'}
                  {expired ? ' (Expired)' : ''}
                </div>
              </div>

              <div>
                <div className="muted">Next follow-up date</div>
                <div
                  style={{
                    fontWeight: 600,
                    marginTop: 2,
                    color: overdueFollowUp ? '#b45309' : undefined,
                  }}
                >
                  {quote.nextFollowUpDate ? formatDate(quote.nextFollowUpDate) : '—'}
                  {overdueFollowUp ? ' (Overdue)' : ''}
                </div>
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Description of work / scope
              </div>
              <div
                style={{
                  whiteSpace: 'pre-wrap',
                  fontSize: 14,
                  lineHeight: 1.5,
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'var(--surface-subtle, rgba(15, 23, 42, 0.03))',
                  border: '1px solid var(--border, #e2e8f0)',
                }}
              >
                {quote.scope || '—'}
              </div>
            </div>

            {quote.assumptions ? (
              <div>
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                  Assumptions and exclusions
                </div>
                <div
                  style={{
                    whiteSpace: 'pre-wrap',
                    fontSize: 13.5,
                    lineHeight: 1.5,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: 'var(--surface-subtle, rgba(15, 23, 42, 0.02))',
                    border: '1px solid var(--border, #e2e8f0)',
                  }}
                >
                  {quote.assumptions}
                </div>
              </div>
            ) : null}
          </section>

          {/* FEE BREAKDOWN */}
          <section className="card" style={{ padding: 20 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <h2 style={{ fontSize: 16, margin: 0 }}>
                Fee breakdown (v{quote.version})
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {quote.rateSource ? (
                  <span
                    className={`status-pill ${
                      quote.rateTier === 2 || quote.rateTier === 3 || quote.rateTier === 1
                        ? 'status-pill--positive'
                        : quote.rateSource === 'custom_override'
                          ? 'status-pill--warning'
                          : 'status-pill--neutral'
                    }`}
                  >
                    {formatRateTierBadgeLabel(
                      quote.rateTier,
                      quote.rateSource,
                      Object.values(quote.rateProvenanceByGrade ?? {}).find(
                        (g) => g.tier === 3 && g.inheritedFromParentOrganisationName,
                      )?.inheritedFromParentOrganisationName,
                    )}
                  </span>
                ) : null}
                <span className="status-pill status-pill--neutral">
                  VAT @ {quoteVatRatePercent}%
                </span>
                <span className="status-pill status-pill--neutral">{quote.feeBasis}</span>
              </div>
            </div>

            <table className="data-list__table" style={{ width: '100%', fontSize: 13.5 }}>
              <thead>
                <tr className="data-list__head-row">
                  <th className="data-list__th">Item</th>
                  <th className="data-list__th data-list__th--right">Ex VAT</th>
                  <th className="data-list__th data-list__th--right">VAT</th>
                  <th className="data-list__th data-list__th--right">Total (inc VAT)</th>
                </tr>
              </thead>
              <tbody>
                <tr className="data-list__row">
                  <td className="data-list__td">
                    <strong>Professional fee ({quote.feeBasis})</strong>
                    {quote.feeArrangementPercent !== undefined &&
                    quote.feeArrangementPercent !== null &&
                    quote.feeArrangementCapBaseDescription ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {quote.feeArrangementPercent}% of{' '}
                        {quote.feeArrangementCapBaseDescription}
                        {quote.feeArrangementAppliedCapPercent != null
                          ? ` · Cap: ${quote.feeArrangementAppliedCapPercent}% (${
                              quote.feeArrangementCapLevel === 'work_type'
                                ? 'work type cap'
                                : quote.feeArrangementCapLevel === 'firm'
                                  ? 'firm cap'
                                  : 'statutory maximum'
                            })`
                          : ''}
                      </div>
                    ) : null}
                    {quote.feeBasis === 'Hourly rate with estimate' && quote.hourlyRateGbp ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        Hourly rate: {formatGbp(quote.hourlyRateGbp)}/hr ex VAT
                        {quote.rateGradeKey ? ` (${quote.rateGradeKey})` : ''}
                        {quote.rateAsAtDate ? ` · Frozen at ${formatDate(quote.rateAsAtDate)}` : ''}
                      </div>
                    ) : null}
                  </td>
                  <td className="data-list__td data-list__td--right">
                    {formatGbp(totals.feeAmountExVat, true)}
                  </td>
                  <td className="data-list__td data-list__td--right">
                    {formatGbp(totals.vatOnFee, true)}
                  </td>
                  <td className="data-list__td data-list__td--right">
                    <strong>
                      {formatGbp(
                        minorUnitsToPounds(
                          sumMinorUnits([
                            poundsToMinorUnits(totals.feeAmountExVat),
                            poundsToMinorUnits(totals.vatOnFee),
                          ]),
                        ),
                        true,
                      )}
                    </strong>
                  </td>
                </tr>

                {quote.disbursements.map((d) => {
                  const dVat = calculateQuoteTotals(
                    0,
                    0,
                    [d],
                    quoteVatRatePercent,
                  ).vatOnDisbursements;
                  return (
                    <tr key={d.id} className="data-list__row">
                      <td className="data-list__td">
                        Disbursement: {d.description}
                        <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>
                          (
                          {d.vatOverridden
                            ? 'VAT overridden'
                            : d.vatApplicable
                              ? `VAT @ ${quoteVatRatePercent}%`
                              : 'No VAT'}
                          )
                        </span>
                      </td>
                      <td className="data-list__td data-list__td--right">
                        {formatGbp(d.amountExVat, true)}
                      </td>
                      <td className="data-list__td data-list__td--right">
                        {formatGbp(dVat, true)}
                      </td>
                      <td className="data-list__td data-list__td--right">
                        {formatGbp(
                          minorUnitsToPounds(
                            sumMinorUnits([
                              poundsToMinorUnits(d.amountExVat),
                              poundsToMinorUnits(dVat),
                            ]),
                          ),
                          true,
                        )}
                      </td>
                    </tr>
                  );
                })}

                <tr
                  className="data-list__row"
                  style={{
                    fontWeight: 700,
                    background: 'var(--surface-subtle, rgba(15, 23, 42, 0.03))',
                  }}
                >
                  <td className="data-list__td">Total quote</td>
                  <td className="data-list__td data-list__td--right">
                    {formatGbp(totals.totalExVat, true)}
                  </td>
                  <td className="data-list__td data-list__td--right">
                    {formatGbp(totals.totalVat, true)}
                  </td>
                  <td
                    className="data-list__td data-list__td--right"
                    style={{ color: 'var(--brand, #0f766e)', fontSize: 15 }}
                  >
                    {formatGbp(totals.totalIncVat, true)}
                  </td>
                </tr>
                {quote.paymentOnAccountRequired ? (
                  <tr className="data-list__row" data-testid="quote-poa-summary-row">
                    <td className="data-list__td">
                      <strong>Payment on Account (requested before work begins)</strong>
                    </td>
                    <td className="data-list__td data-list__td--right">—</td>
                    <td className="data-list__td data-list__td--right">—</td>
                    <td className="data-list__td data-list__td--right">
                      <strong>
                        {typeof quote.paymentOnAccountPence === 'number'
                          ? formatMinorUnitsGbp(quote.paymentOnAccountPence)
                          : formatGbp(quote.paymentOnAccountGbp ?? 0, true)}
                      </strong>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>

          {/* PRICE TRANSPARENCY SNAPSHOT */}
          {quote.priceTransparencySnapshot?.enabled ? (
            <section
              className="card"
              style={{ padding: 20 }}
              data-testid="quote-price-transparency-card"
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 10,
                }}
              >
                <h2 style={{ fontSize: 16, margin: 0 }}>Price Transparency disclosures</h2>
                {quote.priceTransparencySnapshot.capturedAt ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    Frozen {formatDateTime(quote.priceTransparencySnapshot.capturedAt)}
                  </span>
                ) : null}
              </div>
              <div style={{ display: 'grid', gap: 8, fontSize: 13.5 }}>
                {quote.priceTransparencySnapshot.headlineSummary ? (
                  <div>
                    <strong>Overview:</strong> {quote.priceTransparencySnapshot.headlineSummary}
                  </div>
                ) : null}
                {quote.priceTransparencySnapshot.serviceDescription ? (
                  <div>
                    <strong>Service included:</strong>{' '}
                    {quote.priceTransparencySnapshot.serviceDescription}
                  </div>
                ) : null}
                {quote.priceTransparencySnapshot.keyStages ? (
                  <div>
                    <strong>Key stages:</strong> {quote.priceTransparencySnapshot.keyStages}
                  </div>
                ) : null}
                {quote.priceTransparencySnapshot.typicalTimescales ? (
                  <div>
                    <strong>Typical timescales:</strong>{' '}
                    {quote.priceTransparencySnapshot.typicalTimescales}
                  </div>
                ) : null}
                {quote.priceTransparencySnapshot.disbursementsGuidance ? (
                  <div>
                    <strong>Disbursements guidance:</strong>{' '}
                    {quote.priceTransparencySnapshot.disbursementsGuidance}
                  </div>
                ) : null}
                {quote.priceTransparencySnapshot.exclusionsAndVatNote ? (
                  <div>
                    <strong>VAT &amp; exclusions:</strong>{' '}
                    {quote.priceTransparencySnapshot.exclusionsAndVatNote}
                  </div>
                ) : null}
                {quote.priceTransparencySnapshot.customNote ? (
                  <div>
                    <strong>Matter-specific note:</strong>{' '}
                    {quote.priceTransparencySnapshot.customNote}
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* VERSION HISTORY */}
          {quote.versionHistory.length > 0 ? (
            <section className="card" style={{ padding: 20 }}>
              <h2 style={{ fontSize: 16, marginBottom: 12 }}>Version history</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid rgba(15, 118, 110, 0.3)',
                    background: 'rgba(15, 118, 110, 0.05)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <strong>
                      v{quote.version} (Current) — {quote.feeBasis}:{' '}
                      {formatGbp(quote.feeAmountExVat)} ex VAT ({formatGbp(quote.totalIncVat)} inc
                      VAT · {quoteVatRatePercent}% VAT)
                    </strong>
                    <StatusPill label={effectiveStatus} tone={quoteStatusTone(effectiveStatus)} />
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Valid until {formatDate(quote.validUntil)} · {quote.scope}
                  </div>
                </div>

                {[...quote.versionHistory]
                  .sort((a, b) => b.version - a.version)
                  .map((ver) => (
                    <div
                      key={ver.version}
                      style={{
                        padding: '10px 14px',
                        borderRadius: 8,
                        border: '1px solid var(--border, #e2e8f0)',
                        background: 'var(--surface-subtle, rgba(15, 23, 42, 0.02))',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <strong>
                          v{ver.version} — {ver.feeBasis}: {formatGbp(ver.feeAmountExVat)} ex VAT (
                          {formatGbp(ver.totalIncVat)} inc VAT · {ver.vatRatePercent ?? 20}% VAT)
                        </strong>
                        <StatusPill label="Superseded" tone="neutral" />
                      </div>
                      {ver.feeArrangementPercent !== undefined &&
                      ver.feeArrangementPercent !== null &&
                      ver.feeArrangementCapBaseDescription ? (
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                          Fee arrangement: {ver.feeArrangementPercent}% of{' '}
                          {ver.feeArrangementCapBaseDescription}
                        </div>
                      ) : null}
                      {ver.paymentOnAccountRequired ? (
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                          Payment on Account:{' '}
                          {typeof ver.paymentOnAccountPence === 'number'
                            ? formatMinorUnitsGbp(ver.paymentOnAccountPence)
                            : formatGbp(ver.paymentOnAccountGbp ?? 0, true)}
                        </div>
                      ) : null}
                      {ver.priceTransparencySnapshot?.headlineSummary ? (
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                          Price Transparency snapshot: {ver.priceTransparencySnapshot.headlineSummary}
                        </div>
                      ) : null}
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        Superseded {formatDateTime(ver.supersededAt)} by {nameOfPerson(ver.byId)}
                        {ver.revisionNote ? ` — "${ver.revisionNote}"` : ''}
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                        Scope: {ver.scope}
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          ) : null}
        </div>

        {/* RIGHT COLUMN: STATUS TIMELINE & FOLLOW-UP HISTORY */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {activeOrLatestChase ? (
            <section
              className="card"
              style={{ padding: 20 }}
              data-testid="quote-chase-summary"
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <h2 style={{ fontSize: 16, margin: 0 }}>Automated follow-up</h2>
                <StatusPill
                  label={
                    activeOrLatestChase.chase.status === 'active'
                      ? 'Active'
                      : activeOrLatestChase.chase.status === 'needs_owner'
                        ? 'Needs owner'
                        : activeOrLatestChase.chase.status === 'failed'
                          ? 'Failed'
                          : activeOrLatestChase.chase.status === 'completed'
                            ? 'Escalated'
                            : 'Stopped'
                  }
                  tone={
                    activeOrLatestChase.chase.status === 'active'
                      ? 'positive'
                      : activeOrLatestChase.chase.status === 'stopped'
                        ? 'neutral'
                        : 'warning'
                  }
                />
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
                {activeOrLatestChase.chase.status === 'stopped'
                  ? `Stopped${activeOrLatestChase.chase.stoppedReason ? ` (${activeOrLatestChase.chase.stoppedReason})` : ''}.`
                  : activeOrLatestChase.chase.status === 'needs_owner'
                    ? 'No eligible team member or fee earner could receive the escalation task.'
                    : activeOrLatestChase.chase.status === 'failed'
                      ? 'Automated chasing paused after repeated delivery errors.'
                      : activeOrLatestChase.chase.status === 'completed'
                        ? 'Day 21 escalation task created.'
                        : (
                          <>
                            Chasing {activeOrLatestChase.chase.recipientEmail || 'client'} &middot;{' '}
                            {activeOrLatestChase.events.length} reminder step(s) completed &middot;{' '}
                            {activeOrLatestChase.chase.nextActionAt
                              ? `Next action due ${formatDateTime(activeOrLatestChase.chase.nextActionAt)}`
                              : 'Escalation pending'}
                          </>
                        )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {activeOrLatestChase.chase.status === 'needs_owner' ||
                activeOrLatestChase.chase.status === 'failed' ? (
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    data-testid="retry-quote-chase-btn"
                    disabled={chaseBusy}
                    onClick={async () => {
                      setChaseBusy(true);
                      try {
                        const res = await retryCommunicationChaseAction({
                          chaseId: activeOrLatestChase.chase.id,
                        });
                        if (isActionDenied(res) || !res.ok) {
                          showToast(
                            isActionDenied(res)
                              ? res.message
                              : res.message || 'Could not retry quote follow-up.',
                          );
                          return;
                        }
                        showToast('Quote automated follow-up updated.');
                        router.refresh();
                      } finally {
                        setChaseBusy(false);
                      }
                    }}
                  >
                    Retry follow-up
                  </button>
                ) : null}
                {activeOrLatestChase.chase.status === 'active' ||
                activeOrLatestChase.chase.status === 'needs_owner' ? (
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    data-testid="stop-quote-chase-btn"
                    disabled={chaseBusy}
                    onClick={async () => {
                      setChaseBusy(true);
                      try {
                        const res = await stopCommunicationChaseAction({
                          chaseId: activeOrLatestChase.chase.id,
                        });
                        if (isActionDenied(res) || !res.ok) {
                          showToast(
                            isActionDenied(res)
                              ? res.message
                              : res.message || 'Could not stop automated quote chasing.',
                          );
                          return;
                        }
                        showToast('Automated quote chasing stopped.');
                        router.refresh();
                      } finally {
                        setChaseBusy(false);
                      }
                    }}
                  >
                    Stop chasing
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}
          <section className="card" style={{ padding: 20 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <h2 style={{ fontSize: 16, margin: 0 }}>Status timeline</h2>
              {effectiveStatus === 'Sent' || effectiveStatus === 'Follow-up due' ? (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => setFollowUpModalOpen(true)}
                >
                  + Log follow-up
                </button>
              ) : null}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[...quote.timeline]
                .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
                .map((ev) => (
                  <div
                    key={ev.id}
                    style={{
                      paddingLeft: 12,
                      borderLeft: '2px solid var(--border, #cbd5e1)',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{ev.title}</div>
                    {ev.detail ? (
                      <div style={{ fontSize: 13, marginTop: 2 }}>{ev.detail}</div>
                    ) : null}
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      {formatDateTime(ev.at)}
                      {ev.byId ? ` · ${nameOfPerson(ev.byId)}` : ''}
                    </div>
                  </div>
                ))}
            </div>
          </section>

          {quote.followUps.length > 0 ? (
            <section className="card" style={{ padding: 20 }}>
              <h2 style={{ fontSize: 16, marginBottom: 12 }}>
                Follow-ups ({quote.followUps.length})
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {quote.followUps.map((fu) => (
                  <div
                    key={fu.id}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      border: '1px solid var(--border, #e2e8f0)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 12.5,
                        marginBottom: 4,
                      }}
                    >
                      <strong>{fu.method}</strong>
                      <span className="muted">
                        {formatDateTime(fu.at)} · {nameOfPerson(fu.byId)}
                      </span>
                    </div>
                    <div style={{ fontSize: 13.5 }}>{fu.note}</div>
                    {fu.nextFollowUpDate ? (
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        Next follow-up scheduled: {formatDate(fu.nextFollowUpDate)}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {/* MODAL: LOG FOLLOW-UP */}
      {followUpModalOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Log follow-up">
          <form className="modal" onSubmit={handleLogFollowUpSubmit} style={{ maxWidth: 480 }}>
            <div className="modal__header">
              <h2>Log quote follow-up</h2>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setFollowUpModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="field">
                <label className="field-label" htmlFor="qfu-method">
                  Contact method
                </label>
                <select
                  id="qfu-method"
                  className="field-select"
                  value={followUpMethod}
                  onChange={(e) => setFollowUpMethod(e.target.value as ContactLogMethod)}
                >
                  <option value="Phone">Phone</option>
                  <option value="Email">Email</option>
                  <option value="Video call">Video call</option>
                  <option value="In person">In person</option>
                  <option value="Voicemail">Voicemail</option>
                </select>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="qfu-note">
                  Follow-up note *
                </label>
                <textarea
                  id="qfu-note"
                  className="field-input"
                  rows={3}
                  placeholder="Record the discussion or message left with the client/prospect…"
                  value={followUpNote}
                  onChange={(e) => setFollowUpNote(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="qfu-next-date">
                  Next follow-up date
                </label>
                <input
                  id="qfu-next-date"
                  type="date"
                  className="field-input"
                  value={nextFollowUpDate}
                  onChange={(e) => setNextFollowUpDate(e.target.value)}
                />
              </div>
            </div>
            <div className="modal__footer">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setFollowUpModalOpen(false)}
              >
                Cancel
              </button>
              <button type="submit" className="btn btn--primary" disabled={pending}>
                Save follow-up
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* MODAL: RECORD OUTCOME */}
      {outcomeModalOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Record outcome">
          <form className="modal" onSubmit={handleRecordOutcomeSubmit} style={{ maxWidth: 480 }}>
            <div className="modal__header">
              <h2>Record quote outcome</h2>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setOutcomeModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="field">
                <label className="field-label">Outcome</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className={`btn btn--sm ${outcomeType === 'Accepted' ? 'btn--primary' : 'btn--secondary'}`}
                    onClick={() => setOutcomeType('Accepted')}
                  >
                    Accepted
                  </button>
                  <button
                    type="button"
                    className={`btn btn--sm ${outcomeType === 'Declined' ? 'btn--primary' : 'btn--secondary'}`}
                    onClick={() => setOutcomeType('Declined')}
                  >
                    Declined
                  </button>
                </div>
              </div>

              {outcomeType === 'Declined' ? (
                <div className="field">
                  <label className="field-label" htmlFor="qout-reason">
                    Reason for declining *
                  </label>
                  <select
                    id="qout-reason"
                    className="field-select"
                    value={declineReason}
                    onChange={(e) => setDeclineReason(e.target.value as QuoteDeclineReason)}
                  >
                    {QUOTE_DECLINE_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div className="field">
                <label className="field-label" htmlFor="qout-note">
                  {outcomeType === 'Declined' && declineReason === 'Other'
                    ? 'Note (required for Other) *'
                    : 'Note (optional)'}
                </label>
                <textarea
                  id="qout-note"
                  className="field-input"
                  rows={3}
                  placeholder={
                    outcomeType === 'Accepted'
                      ? 'Optional acceptance note or PO reference…'
                      : 'Add details about why the quote was declined…'
                  }
                  value={outcomeNote}
                  onChange={(e) => setOutcomeNote(e.target.value)}
                />
              </div>
            </div>
            <div className="modal__footer">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setOutcomeModalOpen(false)}
              >
                Cancel
              </button>
              <button type="submit" className="btn btn--primary" disabled={pending}>
                Save outcome
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* MODAL: SEND QUOTE BY EMAIL */}
      {sendEmailModalOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Send quote by email"
        >
          <form
            className="modal"
            onSubmit={handleSendQuoteEmailSubmit}
            style={{ maxWidth: 480 }}
          >
            <div className="modal__header">
              <h2>Send quote by email</h2>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setSendEmailModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="field">
                <label className="field-label" htmlFor="qsend-email">
                  Recipient email *
                </label>
                <input
                  id="qsend-email"
                  data-testid="quote-send-email-input"
                  type="email"
                  className="field-input"
                  required
                  value={sendRecipientEmail}
                  onChange={(e) => setSendRecipientEmail(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="qsend-name">
                  Recipient name (optional)
                </label>
                <input
                  id="qsend-name"
                  type="text"
                  className="field-input"
                  value={sendRecipientName}
                  onChange={(e) => setSendRecipientName(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="qsend-note">
                  Covering note (optional)
                </label>
                <textarea
                  id="qsend-note"
                  className="field-input"
                  rows={3}
                  placeholder="Optional message included in the email and frozen on the quote PDF…"
                  value={sendCustomNote}
                  onChange={(e) => setSendCustomNote(e.target.value)}
                />
              </div>
              {emailProviderDisabled ? (
                <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                  Live email delivery is currently disabled in tenant settings. Sending will queue
                  the email with the quote PDF attached in the outbox and begin automated
                  follow-ups.
                </p>
              ) : null}
              {sendEmailError ? (
                <div className="banner banner--warning" role="alert" style={{ margin: 0 }}>
                  {sendEmailError}
                </div>
              ) : null}
            </div>
            <div className="modal__footer">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setSendEmailModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                data-testid="quote-send-email-submit-btn"
                disabled={pending}
              >
                {emailProviderDisabled ? 'Queue quote email' : 'Send quote email'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* MODAL: RECORD AS SENT OFFLINE */}
      {offlineModalOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Record quote as sent offline"
        >
          <form
            className="modal"
            onSubmit={handleMarkSentOfflineSubmit}
            style={{ maxWidth: 460 }}
          >
            <div className="modal__header">
              <h2>Record quote as sent offline</h2>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setOfflineModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                Use this when you posted, handed over, or emailed the quote outside this system.
                No email will be sent and automated email chasing will not run.
              </p>
              <div className="field">
                <label className="field-label" htmlFor="qoff-date">
                  Date sent *
                </label>
                <input
                  id="qoff-date"
                  type="date"
                  className="field-input"
                  required
                  value={offlineSentDate}
                  onChange={(e) => setOfflineSentDate(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="qoff-note">
                  Dispatch note (optional)
                </label>
                <textarea
                  id="qoff-note"
                  data-testid="quote-mark-offline-note-input"
                  className="field-input"
                  rows={2}
                  placeholder="e.g. Sent by signed post or handed to client in meeting"
                  value={offlineNote}
                  onChange={(e) => setOfflineNote(e.target.value)}
                />
              </div>
            </div>
            <div className="modal__footer">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setOfflineModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                data-testid="quote-mark-offline-submit-btn"
                disabled={pending}
              >
                Record offline dispatch
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
