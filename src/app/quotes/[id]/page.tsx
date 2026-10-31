import { notFound } from 'next/navigation';
import { QuoteDetailClient } from '@/components/QuoteDetailClient';
import { getAppSnapshot, getCurrentUserId, recordRecentlyViewed } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function QuoteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ action?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);

  const quote = snap.quotes.find((q) => q.id === id || q.reference === id);
  if (!quote) {
    notFound();
  }

  recordRecentlyViewed(userId, quote.id);

  return (
    <QuoteDetailClient
      quote={quote}
      enquiries={snap.enquiries}
      matters={snap.matters}
      people={snap.people}
      organisations={snap.organisations}
      links={snap.links}
      values={snap.values}
      currentUserId={snap.currentUserId}
      initialAction={sp.action ?? null}
    />
  );
}
