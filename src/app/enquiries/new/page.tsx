import { EnquiryFormClient } from '@/components/EnquiryFormClient';
import { getAppSnapshot, withPageActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function NewEnquiryPage() {
  return withPageActor(async (actor) => {
    const snap = getAppSnapshot(actor.personId);

    return (
      <EnquiryFormClient
        people={snap.people}
        organisations={snap.organisations}
        matters={snap.matters}
        enquiries={snap.enquiries}
        teams={snap.teams}
        values={snap.values}
        customFields={snap.customFields}
        currentUserId={snap.currentUserId}
      />
    );
  });
}
