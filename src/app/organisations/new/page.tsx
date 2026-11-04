import { OrganisationFormClient } from '@/components/OrganisationFormClient';
import { getAppSnapshot, withPageActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function NewOrganisationPage() {
  return withPageActor(async (actor) => {
    const userId = actor.personId;
    const snap = getAppSnapshot(userId);

    return (
      <OrganisationFormClient
        allOrganisations={snap.organisations}
        allPeople={snap.people}
        matters={snap.matters}
        enquiries={snap.enquiries}
        employees={snap.employees}
        lists={snap.lists}
        values={snap.values}
        customFields={snap.customFields}
        currentUserId={userId}
      />
    );
  });
}
