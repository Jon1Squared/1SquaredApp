import { notFound } from 'next/navigation';
import { QuoteFormClient } from '@/components/QuoteFormClient';
import { getAppSnapshot, withPageActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ enquiryId?: string }>;
}) {
  const sp = await searchParams;
  return withPageActor(async (actor) => {
    const snap = getAppSnapshot(actor.personId);
    if (
      !snap.currentUserPermissions.includes('quote:view') ||
      !snap.currentUserPermissions.includes('quote:edit')
    ) {
      notFound();
    }

    const initialEnquiry = sp.enquiryId
      ? snap.enquiries.find((e) => e.id === sp.enquiryId) ?? null
      : null;

    return (
      <QuoteFormClient
        mode="new"
        initialEnquiry={initialEnquiry}
        enquiries={snap.enquiries}
        matters={snap.matters}
        people={snap.people}
        organisations={snap.organisations}
        links={snap.links}
        values={snap.values}
        currentUserId={snap.currentUserId}
      />
    );
  });
}
