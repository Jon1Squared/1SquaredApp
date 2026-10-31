import { PersonFormClient } from '@/components/PersonFormClient';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function NewPersonPage() {
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);

  return (
    <PersonFormClient
      allPeople={snap.people}
      organisations={snap.organisations}
      matters={snap.matters}
      enquiries={snap.enquiries}
      employees={snap.employees}
      lists={snap.lists}
      values={snap.values}
      customFields={snap.customFields}
      currentUserId={userId}
      orgStructure={snap.orgStructure}
      currentUserEmployeePermissions={snap.currentUserEmployeePermissions}
      leaverOwnedRecords={snap.leaverOwnedRecords}
    />
  );
}
