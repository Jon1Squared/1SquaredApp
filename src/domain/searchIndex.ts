/** Builds the client-side search index from the full record set. */
import { isInactiveStatus } from './attention';
import { formatDate } from './dates';
import { enquiryDisplayName, isEnquiryOpen } from './enquiries';
import { resolveLabel, systemKeyOf } from './lists';
import { personDisplayName, personFullName } from './names';
import type { SearchDoc, SearchField, StatusTone } from './search';
import { isTaskOpen, isTaskOverdue } from './tasks';
import type { ChoiceValue, Enquiry, Matter, Organisation, Person, PersonOrganisationLink, Task, Team } from './types';

export function mainLinkFor(personId: string, links: PersonOrganisationLink[]): PersonOrganisationLink | undefined {
  const current = links.filter((l) => l.personId === personId && l.isCurrent);
  return current.find((l) => l.isPrimaryContact) ?? current[0];
}

function statusPills(
  r: Person | Organisation,
  values: ChoiceValue[],
): { label: string; tone: StatusTone }[] {
  const pills: { label: string; tone: StatusTone }[] = [];
  if (r.mergedIntoId) pills.push({ label: 'Merged', tone: 'neutral' });
  const status = systemKeyOf(values, r.recordStatusId);
  if (!r.mergedIntoId && status && ['archived', 'deceased', 'dissolved'].includes(status))
    pills.push({ label: resolveLabel(values, r.recordStatusId), tone: 'neutral' });
  if (!r.mergedIntoId && systemKeyOf(values, r.duplicateStatusId) === 'possible_match')
    pills.push({ label: 'Possible duplicate', tone: 'warning' });
  if (systemKeyOf(values, r.verificationStatusId) === 'expired')
    pills.push({ label: 'Verification expired', tone: 'alert' });
  if (r.recordType === 'organisation' && systemKeyOf(values, r.conflictStatusId) === 'potential_conflict')
    pills.push({ label: 'Potential conflict', tone: 'alert' });
  return pills;
}

export function buildSearchIndex(
  people: Person[],
  organisations: Organisation[],
  links: PersonOrganisationLink[],
  values: ChoiceValue[],
  matters: Matter[] = [],
  enquiries: Enquiry[] = [],
  tasks: Task[] = [],
  teams: Team[] = [],
): SearchDoc[] {
  const orgName = new Map(organisations.map((o) => [o.id, o.legalName]));
  const personName = new Map(people.map((p) => [p.id, personDisplayName(p)]));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const docs: SearchDoc[] = [];

  for (const p of people) {
    const fields: SearchField[] = [
      { kind: 'name', text: personFullName(p) },
      { kind: 'id', text: p.id },
    ];
    if (p.preferredName) fields.push({ kind: 'preferredName', text: `${p.preferredName} ${p.surname}` });
    for (const n of p.otherNames) fields.push({ kind: 'otherName', text: n.name });
    for (const e of p.emails) fields.push({ kind: 'email', text: e.address });
    for (const ph of p.phones) fields.push({ kind: 'phone', text: ph.number });
    for (const a of p.addresses) if (a.postcode) fields.push({ kind: 'postcode', text: a.postcode });
    if (p.jobTitle) fields.push({ kind: 'jobTitle', text: p.jobTitle });
    for (const l of links.filter((x) => x.personId === p.id && x.jobTitle)) fields.push({ kind: 'jobTitle', text: l.jobTitle });
    for (const t of p.tags) fields.push({ kind: 'tag', text: t });

    const main = mainLinkFor(p.id, links);
    let subtitle: string;
    if (p.isEmployee) {
      subtitle = ['Not A Law Firm', resolveLabel(values, p.employeeRoleId)].filter(Boolean).join(' · ');
    } else if (main) {
      subtitle = [orgName.get(main.organisationId), main.jobTitle || p.jobTitle].filter(Boolean).join(' · ');
    } else {
      subtitle = p.jobTitle || resolveLabel(values, p.relationshipRoleIds[0]) || 'Individual';
    }

    docs.push({
      id: p.id,
      type: 'person',
      title: personDisplayName(p),
      subtitle,
      status: p.isEmployee ? 'Employee' : resolveLabel(values, p.relationshipStatusId),
      pills: statusPills(p, values),
      fields,
      inactive: isInactiveStatus(values, p.recordStatusId),
      mergedIntoId: p.mergedIntoId,
      createdAt: p.createdAt,
    });
  }

  for (const o of organisations) {
    const fields: SearchField[] = [
      { kind: 'name', text: o.legalName },
      { kind: 'id', text: o.id },
    ];
    for (const n of o.otherNames) fields.push({ kind: 'otherName', text: n.name });
    if (o.generalEmail) fields.push({ kind: 'email', text: o.generalEmail });
    if (o.mainPhone) fields.push({ kind: 'phone', text: o.mainPhone });
    for (const a of [o.registeredAddress, o.correspondenceAddress, o.billingAddress])
      if (a?.postcode) fields.push({ kind: 'postcode', text: a.postcode });
    if (o.companyNumber) fields.push({ kind: 'companyNumber', text: o.companyNumber });
    if (o.vatNumber) fields.push({ kind: 'vatNumber', text: o.vatNumber });
    for (const t of o.tags) fields.push({ kind: 'tag', text: t });

    docs.push({
      id: o.id,
      type: 'organisation',
      title: o.legalName,
      subtitle: resolveLabel(values, o.organisationTypeId) || 'Organisation',
      status: resolveLabel(values, o.relationshipStatusId),
      pills: statusPills(o, values),
      fields,
      inactive: isInactiveStatus(values, o.recordStatusId),
      mergedIntoId: o.mergedIntoId,
      createdAt: o.createdAt,
    });
  }

  for (const m of matters) {
    const clientLabel = orgName.get(m.clientId) || personName.get(m.clientId) || '';
    const subcatLabel = resolveLabel(values, m.workTypeSubcategoryId) || resolveLabel(values, m.practiceAreaId);
    const fields: SearchField[] = [
      { kind: 'name', text: m.title },
      { kind: 'matterNumber', text: m.matterNumber },
      { kind: 'id', text: m.id },
    ];
    if (clientLabel) fields.push({ kind: 'otherName', text: clientLabel });
    if (subcatLabel) fields.push({ kind: 'tag', text: subcatLabel });
    for (const t of m.tags) fields.push({ kind: 'tag', text: t });

    const pills: { label: string; tone: StatusTone }[] = [];
    if (m.conflictCheckStatus.toLowerCase().includes('conflict')) {
      pills.push({ label: m.conflictCheckStatus, tone: 'alert' });
    }
    const statusLabel = resolveLabel(values, m.matterStatusId) || 'Active';
    if (
      statusLabel === 'CMI incomplete' ||
      m.amlStatus === 'CMI incomplete' ||
      m.amlStatus === 'Pending'
    ) {
      pills.push({ label: 'CMI incomplete', tone: 'warning' });
    } else if (m.amlStatus === 'High risk / EDD') {
      pills.push({ label: `AML: ${m.amlStatus}`, tone: 'warning' });
    }

    docs.push({
      id: m.id,
      type: 'matter',
      title: `${m.matterNumber} — ${m.title}`,
      subtitle: [clientLabel, subcatLabel].filter(Boolean).join(' · '),
      status: resolveLabel(values, m.matterStatusId) || 'Active',
      pills,
      fields,
      inactive: false,
      mergedIntoId: m.mergedIntoId,
      createdAt: m.createdAt,
    });
  }

  for (const enq of enquiries) {
    const callerName = enquiryDisplayName(enq);
    const paLabel = resolveLabel(values, enq.practiceAreaId);
    const urgencyLabel = resolveLabel(values, enq.urgencyId);
    const fields: SearchField[] = [
      { kind: 'name', text: callerName },
      { kind: 'id', text: enq.reference },
      { kind: 'summary', text: enq.summary },
    ];
    if (enq.email) fields.push({ kind: 'email', text: enq.email });
    if (enq.phone) fields.push({ kind: 'phone', text: enq.phone });
    if (enq.callingOnBehalfOf) fields.push({ kind: 'otherName', text: enq.callingOnBehalfOf });
    if (paLabel) fields.push({ kind: 'tag', text: paLabel });

    const pills: { label: string; tone: StatusTone }[] = [];
    if (isEnquiryOpen(enq)) {
      if (urgencyLabel.toLowerCase().includes('emergency')) {
        pills.push({ label: 'Emergency', tone: 'alert' });
      } else if (urgencyLabel.toLowerCase().includes('urgent')) {
        pills.push({ label: 'Urgent', tone: 'warning' });
      }
    }

    docs.push({
      id: enq.id,
      type: 'enquiry',
      title: `${enq.reference} — ${callerName}`,
      subtitle: [paLabel, enq.summary].filter(Boolean).join(' · '),
      status: enq.status,
      pills,
      fields,
      inactive: !isEnquiryOpen(enq),
      mergedIntoId: null,
      createdAt: enq.createdAt,
    });
  }

  for (const t of tasks) {
    const assignee = t.assignedPersonId
      ? personName.get(t.assignedPersonId)
      : t.assignedTeamId
        ? teamName.get(t.assignedTeamId)
        : 'Unassigned';
    const fields: SearchField[] = [
      { kind: 'name', text: t.title },
      { kind: 'id', text: t.reference },
    ];
    if (t.description) fields.push({ kind: 'summary', text: t.description });
    if (assignee) fields.push({ kind: 'otherName', text: assignee });

    const pills: { label: string; tone: StatusTone }[] = [];
    if (isTaskOverdue(t)) {
      pills.push({ label: 'Overdue', tone: 'alert' });
    }

    docs.push({
      id: t.id,
      type: 'task',
      title: `${t.reference} — ${t.title}`,
      subtitle: [assignee, t.dueAt ? `Due ${formatDate(t.dueAt)}` : ''].filter(Boolean).join(' · '),
      status: t.status,
      pills,
      fields,
      inactive: !isTaskOpen(t),
      mergedIntoId: null,
      createdAt: t.createdAt,
    });
  }

  return docs;
}

