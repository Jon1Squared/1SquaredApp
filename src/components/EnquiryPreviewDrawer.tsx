'use client';

import React from 'react';
import Link from 'next/link';
import { Calendar } from 'lucide-react';
import { enquiryStatusTone, urgencyTone } from '@/domain/badges';
import {
  formatDate,
  formatDateTime,
  formatKeyDateSummary,
  formatRelativeAge,
} from '@/domain/dates';
import { enquiryDisplayName, isEnquiryRouted } from '@/domain/enquiries';
import { formatAddress } from '@/domain/fieldRegistry';
import { resolveLabel } from '@/domain/lists';
import { personDisplayName } from '@/domain/names';
import { isTaskOpen } from '@/domain/tasks';
import type { ChoiceValue, Enquiry, Matter, Person, Task, Team } from '@/domain/types';
import { PersonChip, PreviewDrawer, PreviewField, PreviewSection } from './DataList';
import { StatusPill } from './SearchBox';

interface EnquiryPreviewDrawerProps {
  enquiry: Enquiry | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onTake?: (enquiry: Enquiry) => void;
  takingPending?: boolean;
  tasks: Task[];
  teams: Team[];
  people: Person[];
  matters?: Matter[];
  values: ChoiceValue[];
}

export function EnquiryPreviewDrawer({
  enquiry,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onTake,
  takingPending = false,
  tasks,
  teams,
  people,
  matters = [],
  values,
}: EnquiryPreviewDrawerProps) {
  if (!enquiry) return null;

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

  const clientName = enquiryDisplayName(enquiry, 'Unnamed enquiry');
  const urgLabel = resolveLabel(values, enquiry.urgencyId) || 'Standard';
  const paLabel = resolveLabel(values, enquiry.practiceAreaId) || '—';
  const subcatLabel = enquiry.workTypeSubcategoryId
    ? resolveLabel(values, enquiry.workTypeSubcategoryId)
    : '';
  const channelLabel = resolveLabel(values, enquiry.channelId) || '—';
  const sourceLabel = enquiry.sourceId ? resolveLabel(values, enquiry.sourceId) : '';
  const prefContactLabel = enquiry.preferredContactMethodId
    ? resolveLabel(values, enquiry.preferredContactMethodId)
    : '';
  const assigneeName = enquiry.assignedToId ? nameOfPerson(enquiry.assignedToId) : '';
  const teamName = enquiry.assignedTeamId ? nameOfTeam(enquiry.assignedTeamId) : '';
  const takenByName = enquiry.takenById ? nameOfPerson(enquiry.takenById) : '—';
  const keyDateInfo = formatKeyDateSummary(enquiry.keyDate);

  const convertedMatter = enquiry.convertedMatterId
    ? matters.find((m) => m.id === enquiry.convertedMatterId) ?? null
    : null;
  const matterValueDisplay =
    convertedMatter?.feeEstimateGbp != null
      ? `£${convertedMatter.feeEstimateGbp.toLocaleString('en-GB')}`
      : 'Not recorded';

  const openTask = tasks.find(
    (t) =>
      isTaskOpen(t) &&
      t.linkedRecords.some((lr) => lr.recordType === 'enquiry' && lr.recordId === enquiry.id),
  );

  const pastSla =
    isEnquiryRouted(enquiry) &&
    enquiry.contactLog.length === 0 &&
    Boolean(enquiry.firstContactDueAt) &&
    new Date(enquiry.firstContactDueAt!).getTime() < Date.now();

  const formattedAddress = enquiry.address ? formatAddress(enquiry.address, values) : '';
  const closeReason = enquiry.closeReasonId ? resolveLabel(values, enquiry.closeReasonId) : '';

  return (
    <PreviewDrawer
      open={Boolean(enquiry)}
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      hasPrev={hasPrev}
      hasNext={hasNext}
      subtitle={enquiry.reference}
      title={clientName}
      ariaLabel={`Enquiry preview: ${clientName} (${enquiry.reference})`}
      badges={
        <>
          <StatusPill label={enquiry.status} tone={enquiryStatusTone(enquiry.status)} />
          <StatusPill label={urgLabel} tone={urgencyTone(urgLabel)} />
          {pastSla ? <StatusPill label="Past SLA" tone="warning" /> : null}
        </>
      }
      footerActions={
        <>
          {!enquiry.assignedToId && isEnquiryRouted(enquiry) && onTake ? (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={takingPending}
              onClick={() => onTake(enquiry)}
            >
              Take enquiry
            </button>
          ) : null}
          <Link href={`/enquiries/${enquiry.id}`} className="btn btn--primary">
            {enquiry.status === 'Draft' ? 'Continue draft' : 'Open enquiry'}
          </Link>
        </>
      }
    >
      {/* 1. Client */}
      <PreviewSection title="Client">
        <PreviewField label="Name">{clientName}</PreviewField>
        {enquiry.callingOnBehalfOf ? (
          <PreviewField label="Calling on behalf of">
            {enquiry.callingOnBehalfOf}
          </PreviewField>
        ) : null}
        <PreviewField label="Phone">
          {enquiry.phone ? (
            <a href={`tel:${enquiry.phone.replace(/\s+/g, '')}`}>{enquiry.phone}</a>
          ) : (
            <span className="muted">—</span>
          )}
        </PreviewField>
        <PreviewField label="Email">
          {enquiry.email ? (
            <a href={`mailto:${enquiry.email}`}>{enquiry.email}</a>
          ) : (
            <span className="muted">—</span>
          )}
        </PreviewField>
        {prefContactLabel || enquiry.bestTimeToCall ? (
          <PreviewField label="Preferred contact" fullWidth>
            {[prefContactLabel, enquiry.bestTimeToCall].filter(Boolean).join(' · ')}
          </PreviewField>
        ) : null}
        {formattedAddress ? (
          <PreviewField label="Address" fullWidth>
            {formattedAddress}
          </PreviewField>
        ) : null}
      </PreviewSection>

      {/* 2. Matter */}
      <PreviewSection title="Matter">
        <PreviewField label="Practice area">
          {paLabel}
          {subcatLabel ? <span className="muted"> · {subcatLabel}</span> : null}
        </PreviewField>
        <PreviewField label="Value">
          <span className={convertedMatter?.feeEstimateGbp != null ? '' : 'muted'}>
            {matterValueDisplay}
          </span>
        </PreviewField>
        <PreviewField label="Key date" fullWidth>
          {enquiry.keyDate && keyDateInfo ? (
            <span
              className={`key-date-inline ${
                keyDateInfo.isUrgentWeek ? 'key-date-inline--urgent' : ''
              }`}
            >
              <Calendar size={12} aria-hidden="true" />
              <span>
                {formatDate(enquiry.keyDate)} ({keyDateInfo.relativeShort})
                {enquiry.keyDateLabel ? ` — ${enquiry.keyDateLabel}` : ''}
              </span>
            </span>
          ) : (
            <span className="muted">None</span>
          )}
        </PreviewField>
        <PreviewField label="Summary" fullWidth>
          {enquiry.summary || <span className="muted">—</span>}
        </PreviewField>
        {enquiry.otherPartiesNamed ? (
          <PreviewField label="Other parties named" fullWidth>
            {enquiry.otherPartiesNamed}
          </PreviewField>
        ) : null}
        {enquiry.notes ? (
          <PreviewField label="Intake notes" fullWidth>
            {enquiry.notes}
          </PreviewField>
        ) : null}
      </PreviewSection>

      {/* 3. Intake */}
      <PreviewSection title="Intake">
        <PreviewField label="Received">{formatDateTime(enquiry.receivedAt)}</PreviewField>
        <PreviewField label="Age">{formatRelativeAge(enquiry.receivedAt)}</PreviewField>
        <PreviewField label="Channel">{channelLabel}</PreviewField>
        <PreviewField label="Taken by">{takenByName}</PreviewField>
        {sourceLabel ? <PreviewField label="Source">{sourceLabel}</PreviewField> : null}
      </PreviewSection>

      {/* 4. Ownership */}
      <PreviewSection title="Ownership">
        <PreviewField label="Assignee">
          <PersonChip name={assigneeName} emptyLabel="Unassigned" />
        </PreviewField>
        <PreviewField label="Team">
          {teamName ? (
            <>
              {teamName}
              {enquiry.routedToIntakeFallback ? ' (Fallback)' : ''}
            </>
          ) : (
            <span className="muted">Not routed</span>
          )}
        </PreviewField>
        <PreviewField label="Status">
          <StatusPill label={enquiry.status} tone={enquiryStatusTone(enquiry.status)} />
        </PreviewField>
        {enquiry.firstContactDueAt ? (
          <PreviewField label="First-contact SLA">
            {formatDateTime(enquiry.firstContactDueAt)}
          </PreviewField>
        ) : null}
      </PreviewSection>

      {/* 5. Next action */}
      <PreviewSection title="Next action">
        {enquiry.status === 'Draft' ? (
          <PreviewField label="Action" fullWidth>
            Complete draft &amp; route
          </PreviewField>
        ) : openTask ? (
          <>
            <PreviewField label="Task" fullWidth>
              {openTask.title}
            </PreviewField>
            <PreviewField label="Due">
              {openTask.dueAt.includes('T')
                ? formatDateTime(openTask.dueAt)
                : formatDate(openTask.dueAt)}
            </PreviewField>
          </>
        ) : enquiry.nextActionDate ? (
          <PreviewField label="Follow-up due" fullWidth>
            Follow up with client on {formatDate(enquiry.nextActionDate)}
          </PreviewField>
        ) : (
          <PreviewField label="Action" fullWidth>
            <span className="muted">No open task</span>
          </PreviewField>
        )}

        {enquiry.convertedMatterId ? (
          <PreviewField label="Converted matter" fullWidth>
            <Link href={`/matters/${enquiry.convertedMatterId}`}>
              View converted matter ({convertedMatter?.matterNumber ?? enquiry.convertedMatterId}) →
            </Link>
          </PreviewField>
        ) : null}

        {closeReason || enquiry.closeNotes || enquiry.referredToName ? (
          <PreviewField label="Closure outcome" fullWidth>
            {[
              closeReason,
              enquiry.referredToName ? `Referred to ${enquiry.referredToName}` : '',
              enquiry.closeNotes,
            ]
              .filter(Boolean)
              .join(' · ')}
          </PreviewField>
        ) : null}
      </PreviewSection>
    </PreviewDrawer>
  );
}
