import { notFound } from 'next/navigation';
import { EnquiryFormClient } from '@/components/EnquiryFormClient';
import {
  getAppSnapshot,
  getCurrentUserId,
  recordRecentlyViewed,
} from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function EnquiryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);
  const enquiry = snap.enquiries.find((e) => e.id === id);
  if (!enquiry) notFound();

  recordRecentlyViewed(userId, enquiry.id);

  const audit = snap.audit.filter(
    (a) => a.recordType === 'enquiry' && a.recordId === enquiry.id,
  );

  return (
    <EnquiryFormClient
      mode={enquiry.status === 'Draft' ? 'draft' : 'saved'}
      enquiry={enquiry}
      quotes={snap.quotes}
      tasks={snap.tasks}
      audit={audit}
      people={snap.people}
      organisations={snap.organisations}
      matters={snap.matters}
      enquiries={snap.enquiries}
      teams={snap.teams}
      values={snap.values}
      enquirySettings={snap.enquirySettings}
      currentUserId={snap.currentUserId}
    />
  );
}

