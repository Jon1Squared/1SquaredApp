import { EnquiryFormClient } from '@/components/EnquiryFormClient';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function NewEnquiryPage() {
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);

  return (
    <EnquiryFormClient
      people={snap.people}
      organisations={snap.organisations}
      matters={snap.matters}
      enquiries={snap.enquiries}
      teams={snap.teams}
      values={snap.values}
      currentUserId={snap.currentUserId}
    />
  );
}
