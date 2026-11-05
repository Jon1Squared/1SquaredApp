import { notFound, redirect } from 'next/navigation';
import { OrganisationFormClient } from '@/components/OrganisationFormClient';
import { getAppSnapshot, withPageActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function EditOrganisationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return withPageActor(async (actor) => {
    const userId = actor.personId;
    const snap = getAppSnapshot(userId);

    const organisation = snap.organisations.find((o) => o.id === id);
    if (!organisation) notFound();
    if (organisation.mergedIntoId) {
      redirect(`/organisations/${organisation.mergedIntoId}/edit`);
    }

    return (
      <OrganisationFormClient
        existing={organisation}
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
