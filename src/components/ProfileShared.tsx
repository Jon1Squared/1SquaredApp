'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  addNoteAction,
  deleteLinkAction,
  dismissDuplicateAction,
  mergeRecordsAction,
  saveLinkAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { formatDate, formatDateTime, toIsoDate } from '@/domain/dates';
import { isActionDenied } from '@/domain/actionResult';
import { optionsFor, resolveLabel, resolveLabels } from '@/domain/lists';
import { isEmployeeOrLeaverRecord, planMerge } from '@/domain/merge';
import { hrefForId, personDisplayName, recordDisplayName } from '@/domain/names';
import type {
  AnyRecord,
  AuditEntry,
  ChoiceValue,
  MergeHistory,
  Note,
  Organisation,
  Person,
  PersonOrganisationLink,
  RecordType,
} from '@/domain/types';
import { useToast } from './Toast';

export function KeyValue({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={`kv-item ${full ? 'kv-item--full' : ''}`}>
      <div className="kv-label">{label}</div>
      <div className="kv-value">{children || <span className="subtle">—</span>}</div>
    </div>
  );
}

export function PossibleDuplicateBanner({
  record,
  candidates,
  allSameType,
}: {
  record: AnyRecord;
  candidates: AnyRecord[];
  allSameType: AnyRecord[];
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [mergeOpen, setMergeOpen] = useState(false);
  const recordIsEmployeeOrLeaver = isEmployeeOrLeaverRecord(record);
  const mergeableCandidates = useMemo(
    () => candidates.filter((c) => !isEmployeeOrLeaverRecord(c)),
    [candidates],
  );
  const selectableTargets = useMemo(
    () =>
      allSameType.filter(
        (r) =>
          r.id !== record.id && !r.mergedIntoId && !isEmployeeOrLeaverRecord(r),
      ),
    [allSameType, record.id],
  );
  const [survivorId, setSurvivorId] = useState<string>(
    mergeableCandidates[0]?.id ?? selectableTargets[0]?.id ?? '',
  );
  const [busy, setBusy] = useState(false);

  const selectedSurvivor = useMemo(
    () =>
      selectableTargets.find((r) => r.id === survivorId) ??
      mergeableCandidates[0] ??
      null,
    [selectableTargets, mergeableCandidates, survivorId],
  );

  const preview = useMemo(() => {
    if (!selectedSurvivor) return null;
    try {
      return planMerge(selectedSurvivor, record);
    } catch {
      return null;
    }
  }, [selectedSurvivor, record]);

  async function onDismiss() {
    setBusy(true);
    const res = await dismissDuplicateAction(record.recordType, record.id, null);
    setBusy(false);
    if (isActionDenied(res)) {
      return;
    }
    showToast('Marked as not a duplicate');
    router.refresh();
  }

  async function onConfirmMerge() {
    if (!selectedSurvivor) return;
    setBusy(true);
      return;
    }
    setMergeOpen(false);
    showToast(`Merged into ${recordDisplayName(selectedSurvivor)}`);
    router.push(hrefForId(selectedSurvivor.id));
    router.refresh();
  }

  return (
    <>
      <div className="banner banner--warning" role="region" aria-label="Possible duplicate">
        <div>
          <strong>Possible duplicate record.</strong>{' '}
          {candidates.length > 0 ? (
            <>
              Matches{' '}
              {candidates.map((c, idx) => (
                <React.Fragment key={c.id}>
                  {idx > 0 ? ', ' : ''}
                  <Link href={hrefForId(c.id)} style={{ fontWeight: 700, textDecoration: 'underline' }}>
                    {recordDisplayName(c)} ({c.id})
                  </Link>
                </React.Fragment>
              ))}
              .
            </>
          ) : (
            'Flagged for duplicate review.'
          )}
        </div>
        <div className="banner__actions">
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={busy}
            onClick={onDismiss}
          >
            Not a duplicate
          </button>
          {!recordIsEmployeeOrLeaver ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={() => {
                if (
                  !survivorId &&
                  (mergeableCandidates[0]?.id || selectableTargets[0]?.id)
                ) {
                  setSurvivorId(
                    mergeableCandidates[0]?.id ?? selectableTargets[0]?.id ?? '',
                  );
                }
                setMergeOpen(true);
              }}
            >
              Merge into…
            </button>
          ) : null}
        </div>
      </div>

      {mergeOpen && !recordIsEmployeeOrLeaver ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Merge duplicate record">
          <div className="modal-panel">
            <h2>Merge {recordDisplayName(record)} ({record.id}) into…</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              Missing fields, emails, phone numbers, addresses, organisation links, notes and tags will be copied to the surviving record. This record will be marked as merged and redirect to the survivor.
            </p>

            <div className="field" style={{ marginTop: 18 }}>
              <label className="field-label" htmlFor="merge-survivor-select">
                Surviving record
              </label>
              <select
                id="merge-survivor-select"
                className="select"
                value={survivorId}
                onChange={(e) => setSurvivorId(e.target.value)}
              >
                {mergeableCandidates.length > 0 ? (
                  <optgroup label="Suggested matches">
                    {mergeableCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {recordDisplayName(c)} ({c.id})
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <optgroup label="All records">
                  {selectableTargets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {recordDisplayName(t)} ({t.id})
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>

            {preview ? (
              <div style={{ marginTop: 16, padding: 14, borderRadius: 10, background: 'var(--color-input-bg)' }}>
                <div className="section-label">Fields to copy across</div>
                <div style={{ marginTop: 6, fontSize: '0.92rem' }}>
                  {preview.fieldsTaken.length > 0
                    ? preview.fieldsTaken.join(', ') + ', plus any notes and links'
                    : 'All scalar fields already populated on the survivor; notes and links will still be transferred.'}
                </div>
              </div>
            ) : null}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setMergeOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!selectedSurvivor || busy}
                onClick={onConfirmMerge}
              >
                Confirm merge
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function NoteModal({
  recordType,
  recordId,
  open,
  onClose,
}: {
  recordType: RecordType;
  recordId: string;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    const res = await addNoteAction(recordType, recordId, text.trim());
    setBusy(false);
    if (isActionDenied(res)) {
      showToast(res.message);
      return;
    }
    setText('');
    onClose();
    showToast('Note added');
    router.refresh();
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Add note">
      <form className="modal-panel" onSubmit={onSubmit}>
        <h2>Add note</h2>
        <p className="muted" style={{ marginTop: 4 }}>
          Adding a note also updates the record&rsquo;s last meaningful interaction date to today.
        </p>
        <div className="field" style={{ marginTop: 16 }}>
          <label className="field-label" htmlFor="note-textarea">
            Note
          </label>
          <textarea
            id="note-textarea"
            className="textarea"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Record a call, meeting, referral or relationship update…"
            required
            autoFocus
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || !text.trim()}>
            Save note
          </button>
        </div>
      </form>
    </div>
  );
}

export function LinkModal({
  mode,
  fixedPerson,
  fixedOrganisation,
  people,
  organisations,
  values,
  existing,
  open,
  onClose,
}: {
  mode: 'from-person' | 'from-organisation';
  fixedPerson?: Person;
  fixedOrganisation?: Organisation;
  people: Person[];
  organisations: Organisation[];
  values: ChoiceValue[];
  existing?: PersonOrganisationLink | null;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [personId, setPersonId] = useState(
    existing?.personId ?? fixedPerson?.id ?? people.find((p) => !p.isEmployee && !p.mergedIntoId)?.id ?? '',
  );
  const [organisationId, setOrganisationId] = useState(
    existing?.organisationId ?? fixedOrganisation?.id ?? organisations.find((o) => !o.mergedIntoId)?.id ?? '',
  );
  const [jobTitle, setJobTitle] = useState(existing?.jobTitle ?? fixedPerson?.jobTitle ?? '');
  const [department, setDepartment] = useState(existing?.department ?? '');
  const [roleWithinOrganisation, setRoleWithinOrganisation] = useState(
    existing?.roleWithinOrganisation ?? '',
  );
  const [contactRoleIds, setContactRoleIds] = useState<string[]>(existing?.contactRoleIds ?? []);
  const [isPrimaryContact, setIsPrimaryContact] = useState(existing?.isPrimaryContact ?? false);
  const [isCurrent, setIsCurrent] = useState(existing?.isCurrent ?? true);
  const [startDate, setStartDate] = useState(existing?.startDate ?? toIsoDate(new Date()));
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  const contactStatusOptions = useMemo(
    () => optionsFor(values, 'contact_status', existing?.contactStatusId),
    [values, existing?.contactStatusId],
  );
  const [contactStatusId, setContactStatusId] = useState(
    existing?.contactStatusId ?? contactStatusOptions[0]?.id ?? '',
  );
  const [busy, setBusy] = useState(false);

  const contactRoleOptions = useMemo(
    () => optionsFor(values, 'contact_role', contactRoleIds),
    [values, contactRoleIds],
  );

  if (!open) return null;

  function toggleRole(id: string) {
    setContactRoleIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!personId || !organisationId) return;
    setBusy(true);
    const res = await saveLinkAction({
      id: existing?.id,
      personId,
      organisationId,
      jobTitle,
      department,
      roleWithinOrganisation,
      contactRoleIds,
      isPrimaryContact,
      isCurrent,
      startDate: startDate || null,
      endDate: endDate || null,
      contactStatusId: contactStatusId || null,
    });
    setBusy(false);
    if (isActionDenied(res)) {
      showToast(res.message);
      return;
    }
    onClose();
    showToast(existing ? 'Link updated' : 'Linked to organisation');
    router.refresh();
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Link person and organisation">
      <form className="modal-panel" onSubmit={onSubmit}>
        <h2>{existing ? 'Edit link' : mode === 'from-person' ? 'Link to organisation' : 'Link a person'}</h2>

        <div className="form-grid" style={{ marginTop: 16 }}>
          {mode === 'from-person' ? (
            <div className="field field--full">
              <label className="field-label" htmlFor="link-org-select">
                Organisation
              </label>
              <select
                id="link-org-select"
                className="select"
                value={organisationId}
                onChange={(e) => setOrganisationId(e.target.value)}
                required
              >
                {organisations
                  .filter((o) => !o.mergedIntoId)
                  .sort((a, b) => a.legalName.localeCompare(b.legalName))
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.legalName}
                    </option>
                  ))}
              </select>
            </div>
          ) : (
            <div className="field field--full">
              <label className="field-label" htmlFor="link-person-select">
                Person
              </label>
              <select
                id="link-person-select"
                className="select"
                value={personId}
                onChange={(e) => setPersonId(e.target.value)}
                required
              >
                {people
                  .filter((p) => !p.mergedIntoId)
                  .sort((a, b) => a.surname.localeCompare(b.surname))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {personDisplayName(p)} {p.jobTitle ? `(${p.jobTitle})` : ''}
                    </option>
                  ))}
              </select>
            </div>
          )}

          <div className="field">
            <label className="field-label" htmlFor="link-job-title">
              Job title at organisation
            </label>
            <input
              id="link-job-title"
              className="input"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="link-dept">
              Department or team
            </label>
            <input
              id="link-dept"
              className="input"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="link-role-within">
              Role within organisation
            </label>
            <input
              id="link-role-within"
              className="input"
              value={roleWithinOrganisation}
              onChange={(e) => setRoleWithinOrganisation(e.target.value)}
              placeholder="e.g. Director, Partner, Owner"
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="link-contact-status">
              Contact status
            </label>
            <select
              id="link-contact-status"
              className="select"
              value={contactStatusId}
              onChange={(e) => setContactStatusId(e.target.value)}
            >
              {contactStatusOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field field--full">
            <span className="field-label">Contact roles</span>
            <div className="chip-multi">
              {contactRoleOptions.map((opt) => {
                const selected = contactRoleIds.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => toggleRole(opt.id)}
                    className={`chip-option ${selected ? 'chip-option--selected' : ''}`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="link-start-date">
              Start date
            </label>
            <input
              id="link-start-date"
              type="date"
              className="input"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="link-end-date">
              End date
            </label>
            <input
              id="link-end-date"
              type="date"
              className="input"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>

          <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <input
              id="link-primary-cb"
              type="checkbox"
              checked={isPrimaryContact}
              onChange={(e) => setIsPrimaryContact(e.target.checked)}
            />
            <label htmlFor="link-primary-cb" className="field-label">
              Primary contact for organisation
            </label>
          </div>

          <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <input
              id="link-current-cb"
              type="checkbox"
              checked={isCurrent}
              onChange={(e) => setIsCurrent(e.target.checked)}
            />
            <label htmlFor="link-current-cb" className="field-label">
              Current link
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
          {existing ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={async () => {
                const res = await deleteLinkAction(existing.id);
                if (isActionDenied(res)) {
                  showToast(res.message);
                  return;
                }
                onClose();
                showToast('Link removed');
                router.refresh();
              }}
            >
              Remove link
            </button>
          ) : (
            <span />
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="btn btn--secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              Save link
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

export function NotesSection({
  recordType,
  recordId,
  notes,
  nameById,
}: {
  recordType: RecordType;
  recordId: string;
  notes: Note[];
  nameById: Record<string, string>;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    const res = await addNoteAction(recordType, recordId, text.trim());
    setBusy(false);
    if (isActionDenied(res)) {
      showToast(res.message);
      return;
    }
    setText('');
    showToast('Note added');
    router.refresh();
  }

  return (
    <div>
      <form onSubmit={onAdd} style={{ marginBottom: 28 }}>
        <label className="section-label" htmlFor="inline-note-input">
          Add a note
        </label>
        <textarea
          id="inline-note-input"
          className="textarea"
          style={{ marginTop: 8 }}
          placeholder="Write a note about a call, meeting or update…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !text.trim()}>
            Add note
          </button>
        </div>
      </form>

      <div className="section-label" style={{ marginBottom: 8 }}>
        Activity &amp; notes ({notes.length})
      </div>
      {notes.length === 0 ? (
        <p className="muted">No notes recorded yet.</p>
      ) : (
        notes.map((n) => (
          <div key={n.id} className="list-row" style={{ alignItems: 'flex-start' }}>
            <div className="list-row__main">
              <div style={{ fontSize: '0.95rem', whiteSpace: 'pre-wrap' }}>{n.text}</div>
              <div className="list-row__meta" style={{ marginTop: 6 }}>
                {nameById[n.authorId] ?? n.authorId} · {formatDate(n.at)}
                {n.mergedFromId ? ` · Merged from ${n.mergedFromId}` : ''}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export function AuditAndMergeSection({
  record,
  values,
  nameById,
  audit,
  merges,
}: {
  record: AnyRecord;
  values: ChoiceValue[];
  nameById: Record<string, string>;
  audit: AuditEntry[];
  merges: MergeHistory[];
}) {
  return (
    <div>
      <div className="profile-section">
        <h2 className="section-label">Record metadata</h2>
        <div className="kv-grid">
          <KeyValue label="Permanent ID">{record.id}</KeyValue>
          <KeyValue label="Record status">{resolveLabel(values, record.recordStatusId)}</KeyValue>
          <KeyValue label="Record owner">
            {record.recordOwnerId ? (
              <Link href={`/people/${record.recordOwnerId}`}>
                {nameById[record.recordOwnerId] ?? record.recordOwnerId}
              </Link>
            ) : null}
          </KeyValue>
          <KeyValue label="Data source">{resolveLabel(values, record.sourceId)}</KeyValue>
          <KeyValue label="Created">
            {formatDate(record.createdAt)} by {nameById[record.createdById] ?? record.createdById}
          </KeyValue>
          <KeyValue label="Last updated">
            {formatDate(record.updatedAt)} by {nameById[record.updatedById] ?? record.updatedById}
          </KeyValue>
          <KeyValue label="Last verified">{formatDate(record.lastVerifiedAt)}</KeyValue>
          <KeyValue label="Duplicate status">{resolveLabel(values, record.duplicateStatusId)}</KeyValue>
          <KeyValue label="Tags" full>
            {record.tags.length ? record.tags.join(', ') : null}
          </KeyValue>
        </div>
      </div>

      <div className="profile-section">
        <h2 className="section-label">Merge history ({merges.length})</h2>
        {merges.length === 0 ? (
          <p className="muted" style={{ marginTop: 10 }}>
            No records have been merged into or from this record.
          </p>
        ) : (
          merges.map((m) => (
            <div key={m.id} className="list-row">
              <div className="list-row__main">
                <div className="list-row__title">
                  Merged {m.mergedLabel} ({m.mergedId}) into {m.survivorId}
                </div>
                <div className="list-row__meta">
                  {formatDate(m.at)} by {nameById[m.byId] ?? m.byId} · Fields taken:{' '}
                  {m.fieldsTaken.length ? m.fieldsTaken.join(', ') : 'none'}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="profile-section">
        <h2 className="section-label">Audit trail ({audit.length})</h2>
        {audit.map((a) => (
          <div key={a.id} className="list-row">
            <div className="list-row__main">
              <div className="list-row__title">
                {a.field ? `${a.field}` : a.action === 'create' ? 'Record created' : a.action}
              </div>
              <div className="list-row__meta">
                {a.oldValue ? `${a.oldValue} → ` : ''}
                {a.newValue ?? 'Removed'}
              </div>
            </div>
            <div className="list-row__aside muted" style={{ fontSize: '0.82rem' }}>
              {nameById[a.byId] ?? a.byId} · {formatDateTime(a.at)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function renderLinkDates(l: PersonOrganisationLink): string {
  if (!l.startDate && !l.endDate) return l.isCurrent ? 'Current' : 'Previous';
  const start = l.startDate ? formatDate(l.startDate) : 'Unknown start';
  const end = l.endDate ? formatDate(l.endDate) : l.isCurrent ? 'present' : 'ended';
  return `${start} – ${end}`;
}

export function renderLinkRoles(l: PersonOrganisationLink, values: ChoiceValue[]): string {
  return resolveLabels(values, l.contactRoleIds).join(', ');
}
