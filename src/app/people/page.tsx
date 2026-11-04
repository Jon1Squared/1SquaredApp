import { PeopleListClient } from '@/components/PeopleListClient';
import { getAppSnapshot, withPageActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function PeoplePage() {
  return withPageActor(async (actor) => {
    const snap = getAppSnapshot(actor.personId);
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
  });
}
