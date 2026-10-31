import { PeopleListClient } from '@/components/PeopleListClient';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function PeoplePage() {
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);
  return (
    <PeopleListClient
      people={snap.people}
      organisations={snap.organisations}
      links={snap.links}
      values={snap.values}
      employees={snap.employees}
      enquiries={snap.enquiries}
      currentUserId={snap.currentUserId}
    />
  );
}
