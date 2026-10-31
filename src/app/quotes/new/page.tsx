import { QuoteFormClient } from '@/components/QuoteFormClient';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ enquiryId?: string }>;
}) {
  const sp = await searchParams;
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);

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
}
