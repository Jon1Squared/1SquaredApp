import React from 'react';
import { notFound } from 'next/navigation';
import {
  getAppSnapshot,
  getCurrentUserId,
  getMatterPmsViewBundle,
  recordRecentlyViewed,
} from '@/server/services';
import { MatterFormClient } from '@/components/MatterFormClient';
import { MatterProfileClient } from '@/components/MatterProfileClient';

export const dynamic = 'force-dynamic';

export default async function MatterProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const search = searchParams ? await searchParams : {};
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);
  const matter = snap.matters.find((m) => m.id === id);
  if (!matter) notFound();

  recordRecentlyViewed(userId, matter.id);

  if (
    matter.matterNumber === 'DRAFT' ||
    matter.conflictCheckStatus === 'Draft' ||
    (matter.conflictCheckStatus === 'Pending conflict review' && !search.tab)
  ) {
    const linkedQuote = matter.sourceQuoteId
      ? snap.quotes.find((q) => q.id === matter.sourceQuoteId) ?? null
      : snap.quotes.find((q) => q.convertedMatterId === matter.id) ?? null;
    const linkedEnquiry = matter.sourceEnquiryId
      ? snap.enquiries.find((e) => e.id === matter.sourceEnquiryId) ?? null
      : snap.enquiries.find(
          (e) => e.convertedMatterId === matter.id || e.id === linkedQuote?.linkedEnquiryId,
        ) ?? null;
    return (
      <MatterFormClient
        existing={matter}
        initialEnquiry={linkedEnquiry}
        initialQuote={linkedQuote}
        isReopenedDraft={
          matter.matterNumber === 'DRAFT' || matter.conflictCheckStatus === 'Draft'
        }
        activeViewingRole={snap.activeViewingRole}
        people={snap.people}
        organisations={snap.organisations}
        links={snap.links}
        matters={snap.matters}
        lists={snap.lists}
        values={snap.values}
        customFields={snap.customFields}
        employees={snap.employees}
        currentUser={snap.currentUser}
      />
    );
  }

  const pmsView = getMatterPmsViewBundle(matter.id);

  return (
    <MatterProfileClient
      matter={matter}
      initialTab={search.tab}
      people={snap.people}
      organisations={snap.organisations}
      values={snap.values}
      tasks={snap.tasks}
      teams={snap.teams}
      enquiries={snap.enquiries}
      quotes={snap.quotes}
      currentUserId={snap.currentUserId}
      currentUserRole={snap.currentUserRole}
      canViewFinance={snap.canViewFinance}
      pmsView={pmsView}
      notes={snap.notes.filter((n) => n.recordType === 'matter' && n.recordId === matter.id)}
      audit={snap.audit.filter((a) => a.recordType === 'matter' && a.recordId === matter.id)}
    />
  );
}

