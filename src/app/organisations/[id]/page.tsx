import { notFound, redirect } from 'next/navigation';
import { OrganisationProfileClient } from '@/components/OrganisationProfileClient';
import {
  findCandidateDuplicatesForRecord,
  getAppSnapshot,
  getClientPmsViewBundle,
  getCurrentUserId,
  recordRecentlyViewed,
} from '@/server/services';
import type { Organisation } from '@/domain/types';

export const dynamic = 'force-dynamic';

export default async function OrganisationProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; mergedFrom?: string }>;
}) {
  const { id } = await params;
  const { tab, mergedFrom } = await searchParams;
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);

  const organisation = snap.organisations.find((o) => o.id === id);
  if (!organisation) notFound();

  if (organisation.mergedIntoId) {
    redirect(`/organisations/${organisation.mergedIntoId}?mergedFrom=${organisation.id}`);
  }

  recordRecentlyViewed(userId, organisation.id);

  const explicitMatches = organisation.possibleMatchIds
    .map((mid) => snap.organisations.find((o) => o.id === mid))
    .filter((o): o is Organisation => Boolean(o && !o.mergedIntoId));
  const autoMatches = findCandidateDuplicatesForRecord(organisation) as Organisation[];
  const duplicateCandidates = Array.from(
    new Map([...explicitMatches, ...autoMatches].map((o) => [o.id, o])).values(),
  );

  const notes = snap.notes.filter(
    (n) => n.recordType === 'organisation' && n.recordId === organisation.id,
  );
  const audit = snap.audit.filter(
    (a) => a.recordType === 'organisation' && a.recordId === organisation.id,
  );
  const merges = snap.mergeHistory.filter(
    (m) =>
      m.recordType === 'organisation' &&
      (m.survivorId === organisation.id || m.mergedId === organisation.id),
  );
  const pmsView = getClientPmsViewBundle('organisation', organisation.id);

  return (
    <OrganisationProfileClient
      organisation={organisation}
      allOrganisations={snap.organisations}
      people={snap.people}
      links={snap.links}
      matters={snap.matters}
      tasks={snap.tasks}
      teams={snap.teams}
      enquiries={snap.enquiries}
      currentUserId={snap.currentUserId}
      currentUserRole={snap.currentUserRole}
      canViewFinance={snap.canViewFinance}
      pmsView={pmsView}
      values={snap.values}
      customFields={snap.customFields}
      notes={notes}
      audit={audit}
      merges={merges}
      duplicateCandidates={duplicateCandidates}
      mergedFromId={mergedFrom ?? null}
      initialTab={tab}
    />
  );
}

