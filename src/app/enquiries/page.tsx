import { EnquiriesListClient } from '@/components/EnquiriesListClient';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function EnquiriesPage() {
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);

  return (
    <EnquiriesListClient
      enquiries={snap.enquiries}
      quotes={snap.quotes}
      tasks={snap.tasks}
      teams={snap.teams}
      people={snap.people}
      organisations={snap.organisations}
      matters={snap.matters}
      values={snap.values}
      currentUserId={snap.currentUserId}
    />
  );
}
