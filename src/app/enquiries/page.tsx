import { EnquiriesListClient } from '@/components/EnquiriesListClient';
import { getAppSnapshot, withPageActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function EnquiriesPage() {
  return withPageActor(async (actor) => {
    const snap = getAppSnapshot(actor.personId);

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
  });
}
