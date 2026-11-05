import { notFound, redirect } from 'next/navigation';
import { PersonFormClient } from '@/components/PersonFormClient';
import { getAppSnapshot, withPageActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function EditPersonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return withPageActor(async (actor) => {
    const userId = actor.personId;
    const snap = getAppSnapshot(userId);

    const person = snap.people.find((p) => p.id === id);
    if (!person) notFound();
    if (person.mergedIntoId) {
      redirect(`/people/${person.mergedIntoId}/edit`);
    }

    return (
      <PersonFormClient
        existing={person}
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
        existingSensitive={null}
        leaverOwnedRecords={snap.leaverOwnedRecords}
        firmPrimaryDomain={snap.firmPrimaryDomain}
        firmName={snap.firm.name}
      />
    );
  });
}
