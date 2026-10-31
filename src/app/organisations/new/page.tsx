import { OrganisationFormClient } from '@/components/OrganisationFormClient';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function NewOrganisationPage() {
  const userId = await getCurrentUserId();
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
}
