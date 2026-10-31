'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  anonymiseExpiredEnquiriesAction,
  assignEnquiryAction,
  closeEnquiryAction,
  logEnquiryContactAction,
  prepareEnquiryConversionAction,
  reopenEnquiryAction,
  saveEnquiryAction,
} from '@/app/actions';
import {
  formatDate,
  formatDateTime,
  formatKeyDateCountdown,
} from '@/domain/dates';
import { enquiryStatusTone, urgencyTone } from '@/domain/badges';
import {
  canUserReopenEnquiry,
  enquiryDisplayName,
  failedContactAttemptsCount,
  findEnquiryEntityMatches,
  formatConflictAlertLabel,
  getAvailableEnquiryActions,
  isEnquiryOpen,
  isEnquiryRouted,
  runEnquiryConflictSearch,
  shouldSuggestNoResponse,
} from '@/domain/enquiries';
import { formatAddress } from '@/domain/fieldRegistry';
import { resolveLabel, valuesForList } from '@/domain/lists';
import { personDisplayName } from '@/domain/names';
import type {
  Address,
  AuditEntry,
  ChoiceValue,
  ContactLogMethod,
  ContactLogOutcome,
  Enquiry,
  EnquirySettings,
  Matter,
  Organisation,
  Person,
  Task,
  Team,
} from '@/domain/types';
import { SingleAddressEditor } from './FormControls';
import { RecordTasksSection } from './RecordTasksSection';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  enquiry: Enquiry;
  tasks: Task[];
  teams: Team[];
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
  values: ChoiceValue[];
  enquirySettings: EnquirySettings;
  audit: AuditEntry[];
  currentUserId: string;
}

export function EnquiryProfileClient({
  enquiry,
  tasks,
  teams,
  people,
  organisations,
  matters,
  values,
  enquirySettings,
  audit,
  currentUserId,
}: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  // Modals
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [logContactModalOpen, setLogContactModalOpen] = useState(false);
  const [convertModalOpen, setConvertModalOpen] = useState(false);
  const [closeModalMode, setCloseModalMode] = useState<
    'Declined' | 'Referred out' | 'No response' | null
  >(null);
  const [editing, setEditing] = useState(false);

  // Assign modal state
  const [assignPersonId, setAssignPersonId] = useState(enquiry.assignedToId ?? '');
  const [assignTeamId, setAssignTeamId] = useState(enquiry.assignedTeamId ?? '');

  // Log contact modal state
  const [contactMethod, setContactMethod] = useState<ContactLogMethod>('Phone');
  const [contactOutcome, setContactOutcome] = useState<ContactLogOutcome>('Spoke');
  const [contactNote, setContactNote] = useState('');

  // Close / Decline / Refer out state
  const closeReasons = useMemo(
    () => valuesForList(values, 'enquiry_close_reason').filter((v) => v.active),
    [values],
  );
  const [closeReasonId, setCloseReasonId] = useState(
    () => closeReasons.find((r) => r.label === 'Outside practice area')?.id ?? closeReasons[0]?.id ?? '',
  );
  const [closeNotes, setCloseNotes] = useState('');
  const [referredToOrganisationId, setReferredToOrganisationId] = useState('');
  const [referredToName, setReferredToName] = useState('');

  // Convert modal state
  const entityMatches = useMemo(
    () =>
      findEnquiryEntityMatches(
        {
          firstName: enquiry.firstName,
          lastName: enquiry.lastName,
          email: enquiry.email,
          phone: enquiry.phone,
          callingOnBehalfOf: enquiry.callingOnBehalfOf,
        },
        people,
        organisations,
      ),
    [enquiry, people, organisations],
  );
  const [convertUsePersonId, setConvertUsePersonId] = useState<string>(
    enquiry.linkedPersonId ?? entityMatches.people[0]?.person.id ?? '',
  );
  const [convertUseOrgId, setConvertUseOrgId] = useState<string>(
    enquiry.linkedOrganisationId ?? entityMatches.organisations[0]?.organisation.id ?? '',
  );
  const [convertForBusiness, setConvertForBusiness] = useState<boolean>(
    Boolean(enquiry.callingOnBehalfOf.trim() || enquiry.linkedOrganisationId),
  );

  // Edit enquiry state
  const [editFirstName, setEditFirstName] = useState(enquiry.firstName);
  const [editLastName, setEditLastName] = useState(enquiry.lastName);
  const [editBehalf, setEditBehalf] = useState(enquiry.callingOnBehalfOf);
  const [editPhone, setEditPhone] = useState(enquiry.phone);
  const [editEmail, setEditEmail] = useState(enquiry.email);
  const [editPrefMethodId, setEditPrefMethodId] = useState(
    enquiry.preferredContactMethodId ?? '',
  );
  const [editBestTime, setEditBestTime] = useState(enquiry.bestTimeToCall);
  const [editPracticeAreaId, setEditPracticeAreaId] = useState(enquiry.practiceAreaId);
  const [editSubcategoryId, setEditSubcategoryId] = useState(
    enquiry.workTypeSubcategoryId ?? '',
  );
  const [editSummary, setEditSummary] = useState(enquiry.summary);
  const [editNotes, setEditNotes] = useState(enquiry.notes);
  const [editOtherParties, setEditOtherParties] = useState(enquiry.otherPartiesNamed);
  const [editUrgencyId, setEditUrgencyId] = useState(enquiry.urgencyId);
  const [editKeyDate, setEditKeyDate] = useState(enquiry.keyDate ?? '');
  const [editKeyDateLabel, setEditKeyDateLabel] = useState(enquiry.keyDateLabel);
  const [editNextActionDate, setEditNextActionDate] = useState(enquiry.nextActionDate ?? '');
  const [editLine1, setEditLine1] = useState(enquiry.address?.line1 ?? '');
  const [editLine2, setEditLine2] = useState(enquiry.address?.line2 ?? '');
  const [editTown, setEditTown] = useState(enquiry.address?.town ?? '');
  const [editCounty, setEditCounty] = useState(enquiry.address?.county ?? '');
  const [editPostcode, setEditPostcode] = useState(enquiry.address?.postcode ?? '');
  const [editCountryId, setEditCountryId] = useState(enquiry.address?.countryId ?? null);

  const practiceAreas = useMemo(
    () => valuesForList(values, 'work_type').filter((v) => !v.parentId && v.active),
    [values],
  );
  const allWorkTypes = useMemo(
    () => valuesForList(values, 'work_type').filter((v) => v.active),
    [values],
  );
  const urgencies = useMemo(
    () => valuesForList(values, 'enquiry_urgency').filter((v) => v.active),
    [values],
  );
  const contactMethods = useMemo(
    () => valuesForList(values, 'contact_method').filter((v) => v.active),
    [values],
  );
  const countries = useMemo(
    () => valuesForList(values, 'country').filter((v) => v.active),
    [values],
  );
  const employees = useMemo(
    () =>
      people
        .filter((p) => p.isEmployee && !p.mergedIntoId)
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b))),
    [people],
  );

  const conflictCheck = useMemo(
    () =>
      runEnquiryConflictSearch(
        {
          firstName: enquiry.firstName,
          lastName: enquiry.lastName,
          callingOnBehalfOf: enquiry.callingOnBehalfOf,
          otherPartiesNamed: enquiry.otherPartiesNamed,
          email: enquiry.email,
          phone: enquiry.phone,
          address: enquiry.address,
          linkedPersonId: convertUsePersonId || enquiry.linkedPersonId,
          linkedOrganisationId: convertUseOrgId || enquiry.linkedOrganisationId,
        },
        people,
        organisations,
        matters,
        values,
      ),
    [enquiry, convertUsePersonId, convertUseOrgId, people, organisations, matters, values],
  );

  const nameOfPerson = (id: string | null | undefined) => {
    if (!id) return '';
    const p = people.find((x) => x.id === id);
    return p ? personDisplayName(p) : id;
  };
  const nameOfTeam = (id: string | null | undefined) => {
    if (!id) return '';
    const tm = teams.find((x) => x.id === id);
    return tm ? tm.name : id;
  };

  const open = isEnquiryOpen(enquiry);
  const routed = isEnquiryRouted(enquiry);
  const availableActions = getAvailableEnquiryActions(enquiry, currentUserId);
  const canReopen = canUserReopenEnquiry(currentUserId, enquiry, teams, people, values);
  const suggestNoResponse = shouldSuggestNoResponse(
    enquiry,
    enquirySettings.failedAttemptsBeforeSuggestNoResponse || 3,
  );
  const failedAttemptsCount = failedContactAttemptsCount(enquiry);
  const keyDateCountdown = formatKeyDateCountdown(enquiry.keyDate);
  const convertedMatter = enquiry.convertedMatterId
    ? matters.find((m) => m.id === enquiry.convertedMatterId) ?? null
    : null;

  const urgencyLabel = resolveLabel(values, enquiry.urgencyId) || 'Standard';
  const practiceLabel = resolveLabel(values, enquiry.practiceAreaId);
  const subcatLabel = enquiry.workTypeSubcategoryId
    ? resolveLabel(values, enquiry.workTypeSubcategoryId)
    : '';

  const handleTake = () => {
    startTransition(async () => {
      await assignEnquiryAction(enquiry.id, currentUserId);
      setAssignPersonId(currentUserId);
      showToast('Enquiry assigned to you');
    });
  };

  const handleAssignSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      await assignEnquiryAction(
        enquiry.id,
        assignPersonId || null,
        assignTeamId || null,
      );
      setAssignModalOpen(false);
      showToast('Enquiry assignment updated');
    });
  };

  const handleLogContactSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactNote.trim()) {
      showToast('Please add a brief note about the contact attempt.');
      return;
    }
    startTransition(async () => {
      const res = await logEnquiryContactAction(enquiry.id, {
        method: contactMethod,
        outcome: contactOutcome,
        note: contactNote.trim(),
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setContactNote('');
      setLogContactModalOpen(false);
      showToast(
        contactOutcome === 'Spoke'
          ? 'Contact logged — enquiry marked In contact and initial callback task completed'
          : 'Contact attempt logged',
      );
    });
  };

  const handleCloseSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!closeModalMode) return;
    startTransition(async () => {
      const res = await closeEnquiryAction(enquiry.id, {
        targetStatus: closeModalMode,
        closeReasonId: closeModalMode === 'Declined' ? closeReasonId : undefined,
        closeNotes,
        referredToOrganisationId:
          closeModalMode === 'Referred out' && referredToOrganisationId
            ? referredToOrganisationId
            : null,
        referredToName: closeModalMode === 'Referred out' ? referredToName : undefined,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      const mode = closeModalMode;
      setCloseModalMode(null);
      showToast(
        mode === 'Declined' || mode === 'Referred out'
          ? `Enquiry closed as ${mode} — raised 'Send non-engagement letter' task`
          : 'Enquiry closed as No response',
      );
    });
  };

  const handleReopen = () => {
    startTransition(async () => {
      const res = await reopenEnquiryAction(enquiry.id);
      if (res.error) {
        showToast(res.error);
        return;
      }
      showToast('Enquiry reopened');
    });
  };

  const handleConvertProceed = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await prepareEnquiryConversionAction(enquiry.id, {
        usePersonId: convertUsePersonId || null,
        useOrganisationId: convertForBusiness ? convertUseOrgId || null : null,
        createForBusiness: convertForBusiness,
      });
      if (!res.ok) {
        showToast(res.conflictReasons?.[0] ?? 'Cannot convert enquiry due to conflict');
        return;
      }
      setConvertModalOpen(false);
      router.push(
        `/matters/new?enquiryId=${enquiry.id}&clientId=${res.clientId ?? ''}&instructingContactId=${res.instructingContactId ?? ''}`,
      );
    });
  };

  const handleDeclineConflict = () => {
    const conflictReason = closeReasons.find((r) => r.label.toLowerCase() === 'conflict');
    if (conflictReason) setCloseReasonId(conflictReason.id);
    setCloseNotes(
      conflictCheck.otherPartyClientMatches
        .concat(conflictCheck.clientAgainstPartyMatches)
        .map((h) => `${h.queryTerm}: ${h.reason}`)
        .join('; '),
    );
    setConvertModalOpen(false);
    setCloseModalMode('Declined');
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    const hasAddress = [editLine1, editLine2, editTown, editCounty, editPostcode].some(
      (s) => s.trim().length > 0,
    );
    const addrPayload: Address | null = hasAddress
      ? {
          id: enquiry.address?.id ?? 'enq_addr',
          typeId: enquiry.address?.typeId ?? null,
          line1: editLine1.trim(),
          line2: editLine2.trim(),
          town: editTown.trim(),
          county: editCounty.trim(),
          postcode: editPostcode.trim(),
          countryId: editCountryId,
        }
      : null;

    startTransition(async () => {
      const res = await saveEnquiryAction(
        {
          channelId: enquiry.channelId,
          firstName: editFirstName.trim(),
          lastName: editLastName.trim(),
          callingOnBehalfOf: editBehalf.trim(),
          phone: editPhone.trim(),
          email: editEmail.trim(),
          preferredContactMethodId: editPrefMethodId || null,
          bestTimeToCall: editBestTime.trim(),
          address: addrPayload,
          practiceAreaId: editPracticeAreaId,
          workTypeSubcategoryId: editSubcategoryId || null,
          summary: editSummary.trim(),
          notes: editNotes.trim(),
          otherPartiesNamed: editOtherParties.trim(),
          urgencyId: editUrgencyId,
          keyDate: editKeyDate || null,
          keyDateLabel: editKeyDateLabel.trim(),
          nextActionDate: editNextActionDate || null,
          privacyNoticeGiven: enquiry.privacyNoticeGiven,
        },
        { id: enquiry.id },
      );
      if (res.errors) {
        showToast(Object.values(res.errors)[0] ?? 'Validation error');
        return;
      }
      setEditing(false);
      showToast('Enquiry updated');
    });
  };

  return (
    <div className="page">
      {/* HEADER */}
      <div className="page-header">
        <div>
          <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
            <Link href="/enquiries">← Back to Enquiries</Link>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h1>{enquiryDisplayName(enquiry)}</h1>
            <StatusPill label={enquiry.reference} tone="neutral" />
            <StatusPill
              label={enquiry.status}
              tone={enquiryStatusTone(enquiry.status)}
            />
            <StatusPill
              label={urgencyLabel}
              tone={urgencyTone(urgencyLabel)}
            />
            <StatusPill label={practiceLabel} tone="neutral" />
            {subcatLabel ? <StatusPill label={subcatLabel} tone="neutral" /> : null}
          </div>

          <div className="muted" style={{ marginTop: 6 }}>
            {enquiry.summary}
          </div>

          {/* Key date countdown and one-click call/email links */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              marginTop: 10,
            }}
          >
            {enquiry.phone ? (
              <a href={`tel:${enquiry.phone.replace(/\s+/g, '')}`} className="btn btn--secondary btn--sm">
                Call {enquiry.phone}
              </a>
            ) : null}
            {enquiry.email ? (
              <a href={`mailto:${enquiry.email}`} className="btn btn--secondary btn--sm">
                Email {enquiry.email}
              </a>
            ) : null}
            {keyDateCountdown ? (
              <span
                className="status-pill status-pill--warning"
                style={{ fontWeight: 700 }}
              >
                Key date: {formatDate(enquiry.keyDate)}
                {enquiry.keyDateLabel ? ` (${enquiry.keyDateLabel})` : ''} —{' '}
                {keyDateCountdown.label}
              </span>
            ) : null}
            {convertedMatter ? (
              <Link
                href={`/matters/${convertedMatter.id}`}
                className="status-pill status-pill--positive"
                style={{ textDecoration: 'none' }}
              >
                Converted to Matter {convertedMatter.matterNumber} — {convertedMatter.title} →
              </Link>
            ) : null}
          </div>
        </div>

        {/* ACTIONS BAR */}
        <div className="page-header__actions" style={{ flexWrap: 'wrap' }}>
          {open ? (
            <>
              {availableActions.includes('Take') ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={pending}
                  onClick={handleTake}
                >
                  Take
                </button>
              ) : null}
              {availableActions.includes('Assign') ? (
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => {
                    setAssignPersonId(enquiry.assignedToId ?? '');
                    setAssignTeamId(enquiry.assignedTeamId ?? '');
                    setAssignModalOpen(true);
                  }}
                >
                  Assign
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setLogContactModalOpen(true)}
              >
                Log contact
              </button>
              <Link
                href={`/quotes/new?enquiryId=${enquiry.id}`}
                className="btn btn--secondary"
              >
                Create quote
              </Link>
              {availableActions.includes('Convert to matter') ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setConvertModalOpen(true)}
                >
                  Convert to matter
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setCloseModalMode('Declined')}
              >
                Decline
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setCloseModalMode('Referred out')}
              >
                Refer out
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setCloseModalMode('No response')}
              >
                Close — no response
              </button>
            </>
          ) : canReopen ? (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={pending}
              onClick={handleReopen}
            >
              Reopen enquiry
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? 'Cancel edit' : 'Edit details'}
          </button>
        </div>
      </div>

      {/* BANNER: Fallback Intake routing */}
      {enquiry.routedToIntakeFallback && open && routed ? (
        <div className="banner banner--warning" style={{ marginBottom: 16 }}>
          <div>
            <strong>Manual routing needed:</strong> No active team was mapped to{' '}
            {practiceLabel}, so this enquiry was placed in the <strong>Intake</strong> team
            queue. Use <strong>Assign</strong> to route it to a team or fee earner.
          </div>
        </div>
      ) : null}

      {/* BANNER: Suggest closing as No response after N failed attempts */}
      {suggestNoResponse ? (
        <div className="banner banner--warning" style={{ marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <strong>{failedAttemptsCount} contact attempts without speaking:</strong> You have
            logged {failedAttemptsCount} contact attempts on this enquiry without a &lsquo;Spoke&rsquo;
            outcome. Would you like to close this enquiry as <strong>No response</strong>?
          </div>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setCloseModalMode('No response')}
          >
            Close — no response
          </button>
        </div>
      ) : null}

      {/* BANNER: Conflict warning on other parties named */}
      {conflictCheck.otherPartyClientMatches.length > 0 ||
      conflictCheck.clientAgainstPartyMatches.length > 0 ? (
        <div className="banner banner--warning" style={{ marginBottom: 16 }}>
          <div>
            <strong>Conflict check alert:</strong>
            <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
              {[
                ...conflictCheck.otherPartyClientMatches,
                ...conflictCheck.clientAgainstPartyMatches,
              ].map((hit, idx) => (
                <li key={`${hit.recordId}-${idx}`}>
                  <strong>{hit.queryTerm}</strong> matches{' '}
                  <Link href={hit.href}>{formatConflictAlertLabel(hit)}</Link> — {hit.reason}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {/* EDIT FORM */}
      {editing ? (
        <form onSubmit={handleSaveEdit} className="form-section" style={{ marginBottom: 24 }}>
          <div className="form-section__header">
            <h2>Edit enquiry details</h2>
          </div>
          <div className="form-grid">
            <div className="field-group">
              <label className="field-label">First name *</label>
              <input
                type="text"
                required
                className="field-input"
                value={editFirstName}
                onChange={(e) => setEditFirstName(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-label">Last name *</label>
              <input
                type="text"
                required
                className="field-input"
                value={editLastName}
                onChange={(e) => setEditLastName(e.target.value)}
              />
            </div>
            <div className="field-group field-group--full">
              <label className="field-label">Calling on behalf of</label>
              <input
                type="text"
                className="field-input"
                value={editBehalf}
                onChange={(e) => setEditBehalf(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-label">Phone</label>
              <input
                type="tel"
                className="field-input"
                value={editPhone}
                onChange={(e) => setEditPhone(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-label">Email</label>
              <input
                type="email"
                className="field-input"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-label">Preferred contact method</label>
              <select
                className="field-select"
                value={editPrefMethodId}
                onChange={(e) => setEditPrefMethodId(e.target.value)}
              >
                <option value="">— Any —</option>
                {contactMethods.map((cm) => (
                  <option key={cm.id} value={cm.id}>
                    {cm.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-group">
              <label className="field-label">Best time to call</label>
              <input
                type="text"
                className="field-input"
                value={editBestTime}
                onChange={(e) => setEditBestTime(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-label">Practice area *</label>
              <select
                className="field-select"
                value={editPracticeAreaId}
                onChange={(e) => {
                  setEditPracticeAreaId(e.target.value);
                  setEditSubcategoryId('');
                }}
              >
                {practiceAreas.map((pa) => (
                  <option key={pa.id} value={pa.id}>
                    {pa.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-group">
              <label className="field-label">Work type subcategory</label>
              <select
                className="field-select"
                value={editSubcategoryId}
                onChange={(e) => setEditSubcategoryId(e.target.value)}
              >
                <option value="">— Optional —</option>
                {allWorkTypes
                  .filter((v) => v.parentId === editPracticeAreaId)
                  .map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      {sc.label}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field-group field-group--full">
              <label className="field-label">One-line summary * (max 120 chars)</label>
              <input
                type="text"
                required
                maxLength={120}
                className="field-input"
                value={editSummary}
                onChange={(e) => setEditSummary(e.target.value)}
              />
            </div>
            <div className="field-group field-group--full">
              <label className="field-label">Enquiry notes *</label>
              <textarea
                rows={4}
                required
                className="field-textarea"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
              />
            </div>
            <div className="field-group field-group--full">
              <label className="field-label">Other parties named</label>
              <input
                type="text"
                className="field-input"
                value={editOtherParties}
                onChange={(e) => setEditOtherParties(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-label">Urgency</label>
              <select
                className="field-select"
                value={editUrgencyId}
                onChange={(e) => setEditUrgencyId(e.target.value)}
              >
                {urgencies.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-group">
              <label className="field-label">Key date</label>
              <input
                type="date"
                className="field-input"
                value={editKeyDate}
                onChange={(e) => setEditKeyDate(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-label">Key date description</label>
              <input
                type="text"
                className="field-input"
                value={editKeyDateLabel}
                onChange={(e) => setEditKeyDateLabel(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-label">Next action date</label>
              <input
                type="date"
                className="field-input"
                value={editNextActionDate}
                onChange={(e) => setEditNextActionDate(e.target.value)}
              />
            </div>
            <div className="field-group field-group--full">
              <SingleAddressEditor
                bare
                label="Address"
                address={{
                  id: enquiry.address?.id ?? 'enq_addr',
                  typeId: enquiry.address?.typeId ?? null,
                  line1: editLine1,
                  line2: editLine2,
                  town: editTown,
                  county: editCounty,
                  postcode: editPostcode,
                  countryId: editCountryId,
                }}
                values={values}
                onChange={(nextAddr) => {
                  setEditLine1(nextAddr?.line1 ?? '');
                  setEditLine2(nextAddr?.line2 ?? '');
                  setEditTown(nextAddr?.town ?? '');
                  setEditCounty(nextAddr?.county ?? '');
                  setEditPostcode(nextAddr?.postcode ?? '');
                  setEditCountryId(nextAddr?.countryId ?? null);
                }}
              />
            </div>
          </div>
          <div className="form-actions" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={pending}>
              Save changes
            </button>
          </div>
        </form>
      ) : null}

      {/* ENQUIRY DETAILS */}
      <section className="profile-section">
        <div className="profile-section__header">
          <h2>Enquiry details</h2>
        </div>
        <dl className="kv-grid">
          <div>
            <dt>Reference</dt>
            <dd>{enquiry.reference}</dd>
          </div>
          <div>
            <dt>Received</dt>
            <dd>
              {formatDateTime(enquiry.receivedAt)} ({resolveLabel(values, enquiry.channelId)})
            </dd>
          </div>
          <div>
            <dt>Taken by</dt>
            <dd>
              <Link href={`/people/${enquiry.takenById}`}>
                {nameOfPerson(enquiry.takenById)}
              </Link>
            </dd>
          </div>
          <div>
            <dt>Assigned to</dt>
            <dd>
              {enquiry.assignedToId ? (
                <Link href={`/people/${enquiry.assignedToId}`}>
                  {nameOfPerson(enquiry.assignedToId)}
                </Link>
              ) : (
                'Unclaimed'
              )}
              {enquiry.assignedTeamId ? ` (${nameOfTeam(enquiry.assignedTeamId)})` : ''}
            </dd>
          </div>
          <div>
            <dt>First-contact SLA target</dt>
            <dd>{formatDateTime(enquiry.firstContactDueAt)}</dd>
          </div>
          <div>
            <dt>Next action date</dt>
            <dd>{enquiry.nextActionDate ? formatDate(enquiry.nextActionDate) : '—'}</dd>
          </div>
          <div>
            <dt>Enquirer name</dt>
            <dd>
              {enquiry.firstName} {enquiry.lastName}
              {enquiry.linkedPersonId ? (
                <>
                  {' '}
                  ·{' '}
                  <Link href={`/people/${enquiry.linkedPersonId}`}>
                    Linked Person ({enquiry.linkedPersonId})
                  </Link>
                </>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Calling on behalf of</dt>
            <dd>
              {enquiry.callingOnBehalfOf || '—'}
              {enquiry.linkedOrganisationId ? (
                <>
                  {' '}
                  ·{' '}
                  <Link href={`/organisations/${enquiry.linkedOrganisationId}`}>
                    Linked Organisation ({enquiry.linkedOrganisationId})
                  </Link>
                </>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>
              {enquiry.phone ? (
                <a href={`tel:${enquiry.phone.replace(/\s+/g, '')}`}>{enquiry.phone}</a>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>
              {enquiry.email ? <a href={`mailto:${enquiry.email}`}>{enquiry.email}</a> : '—'}
            </dd>
          </div>
          <div>
            <dt>Preferred contact method</dt>
            <dd>
              {enquiry.preferredContactMethodId
                ? resolveLabel(values, enquiry.preferredContactMethodId)
                : 'Any'}
            </dd>
          </div>
          <div>
            <dt>Best time to call</dt>
            <dd>{enquiry.bestTimeToCall || '—'}</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>{enquiry.address ? formatAddress(enquiry.address, values) : '—'}</dd>
          </div>
          <div>
            <dt>Practice area &amp; work type</dt>
            <dd>
              {practiceLabel}
              {subcatLabel ? ` → ${subcatLabel}` : ''}
            </dd>
          </div>
          <div>
            <dt>Other parties named</dt>
            <dd>{enquiry.otherPartiesNamed || 'None recorded'}</dd>
          </div>
          <div>
            <dt>How they heard about us</dt>
            <dd>
              {enquiry.sourceId ? resolveLabel(values, enquiry.sourceId) : '—'}
              {enquiry.referrerPersonId ? (
                <>
                  {' '}
                  (Referrer:{' '}
                  <Link href={`/people/${enquiry.referrerPersonId}`}>
                    {nameOfPerson(enquiry.referrerPersonId)}
                  </Link>
                  )
                </>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Privacy notice given</dt>
            <dd>{enquiry.privacyNoticeGiven ? 'Yes' : 'No'}</dd>
          </div>
          {!open && enquiry.status !== 'Converted' ? (
            <div>
              <dt>Outcome / close reason</dt>
              <dd>
                {enquiry.status}
                {enquiry.closeReasonId
                  ? ` — ${resolveLabel(values, enquiry.closeReasonId)}`
                  : ''}
                {enquiry.referredToName ? ` · Referred to: ${enquiry.referredToName}` : ''}
                {enquiry.referredToOrganisationId ? (
                  <>
                    {' '}
                    (
                    <Link href={`/organisations/${enquiry.referredToOrganisationId}`}>
                      {organisations.find((o) => o.id === enquiry.referredToOrganisationId)
                        ?.legalName ?? enquiry.referredToOrganisationId}
                    </Link>
                    )
                  </>
                ) : null}
                {enquiry.closeNotes ? ` · ${enquiry.closeNotes}` : ''}
              </dd>
            </div>
          ) : null}
          <div style={{ gridColumn: '1 / -1' }}>
            <dt>Enquiry notes (caller&apos;s words)</dt>
            <dd style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{enquiry.notes}</dd>
          </div>
        </dl>
      </section>

      {/* CONTACT LOG */}
      <section className="profile-section">
        <div className="profile-section__header">
          <h2>Contact log ({enquiry.contactLog.length})</h2>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setLogContactModalOpen(true)}
          >
            + Log contact
          </button>
        </div>

        {enquiry.contactLog.length === 0 ? (
          <p className="muted">
            No contact attempts logged yet. Use &lsquo;Log contact&rsquo; whenever you call, email or
            meet the enquirer.
          </p>
        ) : (
          <div>
            {enquiry.contactLog.map((c) => (
              <div key={c.id} className="note-item">
                <div className="note-item__meta">
                  <StatusPill
                    label={c.outcome}
                    tone={c.outcome === 'Spoke' ? 'positive' : 'neutral'}
                  />{' '}
                  <strong>{c.method}</strong> · {formatDateTime(c.at)} · by{' '}
                  {nameOfPerson(c.byId)}
                </div>
                <div className="note-item__text" style={{ marginTop: 4 }}>
                  {c.note}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* TASKS SECTION */}
      <RecordTasksSection
        recordType="enquiry"
        recordId={enquiry.id}
        recordLabel={`${enquiry.reference} (${enquiryDisplayName(enquiry)})`}
        defaultTeamId={enquiry.assignedTeamId}
        defaultPersonId={enquiry.assignedToId ?? currentUserId}
        tasks={tasks}
        teams={teams}
        people={people}
        values={values}
        currentUserId={currentUserId}
      />

      {/* AUDIT TRAIL & PRIVACY */}
      <section className="profile-section">
        <div className="profile-section__header">
          <h2>Audit trail ({audit.length})</h2>
          {!open && enquiry.status !== 'Converted' && !enquiry.anonymisedAt ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await anonymiseExpiredEnquiriesAction(enquiry.id);
                  showToast('Personal details anonymised for retention compliance');
                })
              }
            >
              Anonymise personal details (retention)
            </button>
          ) : null}
        </div>
        {audit.length === 0 ? (
          <p className="muted">No audit entries yet.</p>
        ) : (
          <div className="audit-list">
            {audit.map((a) => (
              <div key={a.id} className="audit-row">
                <div className="audit-row__main">
                  <strong>{a.field ?? a.action}</strong>
                  {a.oldValue || a.newValue ? (
                    <span className="muted">
                      {' '}
                      — {a.oldValue ? `${a.oldValue} → ` : ''}
                      {a.newValue ?? ''}
                    </span>
                  ) : null}
                </div>
                <div className="audit-row__meta">
                  {nameOfPerson(a.byId)} · {formatDateTime(a.at)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* MODAL: ASSIGN ENQUIRY */}
      {assignModalOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h2>Assign enquiry {enquiry.reference}</h2>
            </div>
            <form onSubmit={handleAssignSubmit}>
              <div className="form-grid">
                <div className="field-group field-group--full">
                  <label className="field-label" htmlFor="assign-enq-team">
                    Team
                  </label>
                  <select
                    id="assign-enq-team"
                    className="field-select"
                    value={assignTeamId}
                    onChange={(e) => setAssignTeamId(e.target.value)}
                  >
                    <option value="">— None —</option>
                    {teams
                      .filter((t) => t.active)
                      .map((tm) => (
                        <option key={tm.id} value={tm.id}>
                          {tm.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="field-group field-group--full">
                  <label className="field-label" htmlFor="assign-enq-person">
                    Assigned person
                  </label>
                  <select
                    id="assign-enq-person"
                    className="field-select"
                    value={assignPersonId}
                    onChange={(e) => setAssignPersonId(e.target.value)}
                  >
                    <option value="">— Unclaimed (team queue) —</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {personDisplayName(emp)} ({resolveLabel(values, emp.employeeRoleId)})
                      </option>
                    ))}
                  </select>
                  <span className="field-help">
                    Assigning the enquiry also moves its open contact callback task to that
                    person.
                  </span>
                </div>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setAssignModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={pending}>
                  Save assignment
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* MODAL: LOG CONTACT */}
      {logContactModalOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <h2>Log contact on {enquiry.reference}</h2>
            </div>
            <form onSubmit={handleLogContactSubmit}>
              <div className="form-grid">
                <div className="field-group">
                  <label className="field-label" htmlFor="log-method">
                    Method *
                  </label>
                  <select
                    id="log-method"
                    className="field-select"
                    value={contactMethod}
                    onChange={(e) => setContactMethod(e.target.value as ContactLogMethod)}
                  >
                    <option value="Phone">Phone</option>
                    <option value="Email">Email</option>
                    <option value="In person">In person</option>
                    <option value="Video">Video</option>
                  </select>
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="log-outcome">
                    Outcome *
                  </label>
                  <select
                    id="log-outcome"
                    className="field-select"
                    value={contactOutcome}
                    onChange={(e) => setContactOutcome(e.target.value as ContactLogOutcome)}
                  >
                    <option value="Spoke">Spoke</option>
                    <option value="Left message">Left message</option>
                    <option value="No answer">No answer</option>
                    <option value="Sent email">Sent email</option>
                  </select>
                </div>
                <div className="field-group field-group--full">
                  <label className="field-label" htmlFor="log-note">
                    Note *
                  </label>
                  <textarea
                    id="log-note"
                    rows={4}
                    required
                    className="field-textarea"
                    placeholder="Record what was discussed or the message left…"
                    value={contactNote}
                    onChange={(e) => setContactNote(e.target.value)}
                  />
                  {contactOutcome === 'Spoke' ? (
                    <span className="field-help">
                      Logging &lsquo;Spoke&rsquo; automatically moves the enquiry to{' '}
                      <strong>In contact</strong> and marks the initial callback task complete.
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setLogContactModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={pending}>
                  Save contact log
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* MODAL: CLOSE / DECLINE / REFER OUT */}
      {closeModalMode ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 560 }}>
            <div className="modal-header">
              <h2>
                {closeModalMode === 'Declined'
                  ? 'Decline enquiry'
                  : closeModalMode === 'Referred out'
                    ? 'Refer enquiry out'
                    : 'Close enquiry — No response'}
              </h2>
            </div>
            <form onSubmit={handleCloseSubmit}>
              <div className="form-grid">
                {closeModalMode === 'Declined' ? (
                  <div className="field-group field-group--full">
                    <label className="field-label" htmlFor="close-reason-select">
                      Decline reason *
                    </label>
                    <select
                      id="close-reason-select"
                      required
                      className="field-select"
                      value={closeReasonId}
                      onChange={(e) => setCloseReasonId(e.target.value)}
                    >
                      {closeReasons.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {closeModalMode === 'Referred out' ? (
                  <>
                    <div className="field-group field-group--full">
                      <label className="field-label" htmlFor="refer-org-select">
                        Referred to organisation in directory (optional)
                      </label>
                      <select
                        id="refer-org-select"
                        className="field-select"
                        value={referredToOrganisationId}
                        onChange={(e) => {
                          setReferredToOrganisationId(e.target.value);
                          const o = organisations.find((x) => x.id === e.target.value);
                          if (o && !referredToName) setReferredToName(o.legalName);
                        }}
                      >
                        <option value="">— Or type firm/service name below —</option>
                        {organisations
                          .filter((o) => !o.mergedIntoId)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.legalName} ({o.id})
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="field-group field-group--full">
                      <label className="field-label" htmlFor="refer-name-input">
                        Referred to firm or service name *
                      </label>
                      <input
                        id="refer-name-input"
                        type="text"
                        required={!referredToOrganisationId}
                        className="field-input"
                        placeholder="e.g. Morgans Criminal Defence LLP"
                        value={referredToName}
                        onChange={(e) => setReferredToName(e.target.value)}
                      />
                    </div>
                  </>
                ) : null}

                <div className="field-group field-group--full">
                  <label className="field-label" htmlFor="close-notes-input">
                    Closing notes
                  </label>
                  <textarea
                    id="close-notes-input"
                    rows={3}
                    className="field-textarea"
                    placeholder="Context or explanation for the file…"
                    value={closeNotes}
                    onChange={(e) => setCloseNotes(e.target.value)}
                  />
                  {closeModalMode === 'Declined' || closeModalMode === 'Referred out' ? (
                    <span className="field-help">
                      Compliance rule: Closing as {closeModalMode} automatically raises a{' '}
                      <strong>Send non-engagement letter</strong> task due in 2 working days.
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setCloseModalMode(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={pending}>
                  Confirm {closeModalMode.toLowerCase()}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* MODAL: CONVERT TO MATTER */}
      {convertModalOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 660 }}>
            <div className="modal-header">
              <h2>Convert {enquiry.reference} to a matter</h2>
            </div>

            {/* Step 1: Link or create client */}
            <form onSubmit={handleConvertProceed}>
              <div style={{ marginBottom: 16 }}>
                <div className="section-label" style={{ marginBottom: 6 }}>
                  Step 1 — Link or create client record
                </div>
                <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                  Select an existing Person (and Organisation if acting for a business), or leave
                  set to create a new client record from the enquiry details.
                </p>

                <div className="form-grid">
                  <div className="field-group field-group--full">
                    <label className="field-label" htmlFor="conv-person-select">
                      Person record for {enquiry.firstName} {enquiry.lastName}
                    </label>
                    <select
                      id="conv-person-select"
                      className="field-select"
                      value={convertUsePersonId}
                      onChange={(e) => setConvertUsePersonId(e.target.value)}
                    >
                      <option value="">
                        + Create new Person ({enquiry.firstName} {enquiry.lastName})
                      </option>
                      {people
                        .filter((p) => !p.mergedIntoId && !p.isEmployee)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            Use existing: {personDisplayName(p)} ({p.id})
                            {entityMatches.people.some((m) => m.person.id === p.id)
                              ? ' ★ Suggested match'
                              : ''}
                          </option>
                        ))}
                    </select>
                  </div>

                  <div className="field-group field-group--full">
                    <label className="checkbox-pill">
                      <input
                        type="checkbox"
                        checked={convertForBusiness}
                        onChange={(e) => setConvertForBusiness(e.target.checked)}
                      />
                      <span>
                        Enquiry is on behalf of a business / organisation (
                        {enquiry.callingOnBehalfOf || 'specify or link organisation'})
                      </span>
                    </label>
                  </div>

                  {convertForBusiness ? (
                    <div className="field-group field-group--full">
                      <label className="field-label" htmlFor="conv-org-select">
                        Organisation client record
                      </label>
                      <select
                        id="conv-org-select"
                        className="field-select"
                        value={convertUseOrgId}
                        onChange={(e) => setConvertUseOrgId(e.target.value)}
                      >
                        <option value="">
                          + Create new Organisation (
                          {enquiry.callingOnBehalfOf ||
                            `${enquiry.firstName} ${enquiry.lastName} Business`}
                          )
                        </option>
                        {organisations
                          .filter((o) => !o.mergedIntoId)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              Use existing: {o.legalName} ({o.id})
                              {entityMatches.organisations.some(
                                (m) => m.organisation.id === o.id,
                              )
                                ? ' ★ Suggested match'
                                : ''}
                            </option>
                          ))}
                      </select>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Step 2: Conflict check */}
              <div style={{ marginBottom: 16 }}>
                <div className="section-label" style={{ marginBottom: 6 }}>
                  Step 2 — Pre-conversion conflict check
                </div>
                {conflictCheck.hasBlockingConflict ? (
                  <div className="banner banner--warning">
                    <div>
                      <strong>Conflict identified — conversion blocked:</strong>
                      <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                        {[
                          ...conflictCheck.otherPartyClientMatches,
                          ...conflictCheck.clientAgainstPartyMatches,
                        ]
                          .filter((h) => h.blocking)
                          .map((hit, idx) => (
                            <li key={`${hit.recordId}-${idx}`}>
                              <strong>{hit.queryTerm}</strong> — {hit.reason}
                            </li>
                          ))}
                      </ul>
                      <div style={{ marginTop: 8 }}>
                        Conversion cannot proceed while an active conflict exists. You can decline
                        this enquiry with reason <strong>Conflict</strong> (which will raise the
                        non-engagement letter task).
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="subcard" style={{ background: 'var(--bg-subtle)' }}>
                    <StatusPill label="No blocking conflicts found" tone="positive" />{' '}
                    <span className="muted" style={{ fontSize: 13, marginLeft: 6 }}>
                      Checked client ({enquiry.firstName} {enquiry.lastName}
                      {enquiry.callingOnBehalfOf ? ` / ${enquiry.callingOnBehalfOf}` : ''}) and
                      other parties ({enquiry.otherPartiesNamed || 'none named'}) against People,
                      Organisations and Matter parties.
                    </span>
                  </div>
                )}
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setConvertModalOpen(false)}
                >
                  Cancel
                </button>
                {conflictCheck.hasBlockingConflict ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleDeclineConflict}
                  >
                    Decline enquiry (Conflict)
                  </button>
                ) : (
                  <button type="submit" className="btn btn--primary" disabled={pending}>
                    Continue to pre-filled New Matter form →
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
