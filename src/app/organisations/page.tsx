import { OrganisationsListClient } from '@/components/OrganisationsListClient';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function OrganisationsPage() {
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);
  return (
    <OrganisationsListClient
      organisations={snap.organisations}
      people={snap.people}
      links={snap.links}
      matters={snap.matters}
      values={snap.values}
      employees={snap.employees}
      currentUserId={snap.currentUserId}
    />
  );
}
