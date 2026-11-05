import { OrganisationsListClient } from '@/components/OrganisationsListClient';
import { getAppSnapshot, withPageActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function OrganisationsPage() {
  return withPageActor(async (actor) => {
    const snap = getAppSnapshot(actor.personId);
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
  });
}
