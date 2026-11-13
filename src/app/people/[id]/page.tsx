import { notFound, redirect } from 'next/navigation';
import { PersonProfileClient } from '@/components/PersonProfileClient';
import { isActionDenied } from '@/domain/actionResult';
import {
  findCandidateDuplicatesForRecord,
  getAppSnapshot,
  getClientPmsViewBundle,
  listAuditEntriesForRecord,
  recordRecentlyViewed,
  withPageActor,
  type ClientPmsViewBundle,
} from '@/server/services';
import type { Person } from '@/domain/types';

export const dynamic = 'force-dynamic';

export default async function PersonProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; mergedFrom?: string }>;
}) {
  const { id } = await params;
  const { tab, mergedFrom } = await searchParams;
  return withPageActor(async (actor) => {
    const userId = actor.personId;
    const snap = await getAppSnapshot(userId);

    if (id.startsWith('ENQ-')) {
      const enquiry = snap.enquiries.find((e) => e.id === id);
      if (!enquiry) notFound();
      if (enquiry.linkedPersonId) {
        redirect(`/people/${enquiry.linkedPersonId}`);
      }
      redirect(`/enquiries/${enquiry.id}`);
    }

    const person = snap.people.find((p) => p.id === id);
    if (!person) notFound();

    if (person.mergedIntoId) {
      redirect(`/people/${person.mergedIntoId}?mergedFrom=${person.id}`);
    }

    await recordRecentlyViewed(userId, person.id);

    const explicitMatches = person.possibleMatchIds
      .map((mid) => snap.people.find((p) => p.id === mid))
      .filter((p): p is Person => Boolean(p && !p.mergedIntoId));
    const autoMatches = (await findCandidateDuplicatesForRecord(person, {
      people: snap.people,
      organisations: snap.organisations,
    })) as Person[];
    const duplicateCandidates = Array.from(
      new Map([...explicitMatches, ...autoMatches].map((p) => [p.id, p])).values(),
    );

    const notes = snap.notes.filter((n) => n.recordType === 'person' && n.recordId === person.id);
    const audit = await listAuditEntriesForRecord('person', person.id, userId, {
      limit: 200,
    });
    const merges = snap.mergeHistory.filter(
      (m) => m.recordType === 'person' && (m.survivorId === person.id || m.mergedId === person.id),
    );
    let pmsView: ClientPmsViewBundle | undefined;
    if (snap.finance.canViewMatter) {
      const personPmsRes = await getClientPmsViewBundle('person', person.id, userId);
      const personPmsView = !isActionDenied(personPmsRes) ? personPmsRes : undefined;
      const primaryOrgLink =
        snap.links.find((l) => l.personId === person.id && l.isCurrent && l.isPrimaryContact) ??
        snap.links.find((l) => l.personId === person.id && l.isCurrent);
      if (personPmsView?.clientBundle || !primaryOrgLink) {
        pmsView = personPmsView;
      } else {
        const orgPmsRes = await getClientPmsViewBundle(
          'organisation',
          primaryOrgLink.organisationId,
          userId,
        );
        pmsView = !isActionDenied(orgPmsRes) ? orgPmsRes : personPmsView;
      }
    }

    return (
      <PersonProfileClient
        person={person}
        allPeople={snap.people}
        organisations={snap.organisations}
        links={snap.links}
        matters={snap.matters}
        tasks={snap.tasks}
        teams={snap.teams}
        enquiries={snap.enquiries}
        currentUserId={snap.currentUserId}
        currentUserRole={snap.currentUserRole}
        canTakeByTaskId={snap.canTakeByTaskId}
        canViewFinance={snap.finance.canViewMatter}
        pmsView={pmsView}
        values={snap.values}
        customFields={snap.customFields}
        notes={notes}
        audit={audit}
        merges={merges}
        duplicateCandidates={duplicateCandidates}
        mergedFromId={mergedFrom ?? null}
        initialTab={tab}
        firmName={snap.firm.name}
        orgStructure={snap.orgStructure}
      />
    );
  });
}

