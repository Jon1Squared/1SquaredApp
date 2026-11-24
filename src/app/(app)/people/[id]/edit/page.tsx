import { notFound, redirect } from 'next/navigation';
import { PersonFormClient } from '@/components/PersonFormClient';
import { loadPersonFormPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function EditPersonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return withOptionalPageActor(async (actor) => {
    const data = await loadPersonFormPageData(actor.personId, id);
    if (!data) notFound();
    if ('redirectTo' in data) {
      redirect(data.redirectTo);
    }
    if (!data.existing) notFound();
    const { shell } = data;
    const peopleById = new Map(shell.employees.map((p) => [p.id, p]));
    for (const p of data.ownedPeople) {
      if (!peopleById.has(p.id)) {
        peopleById.set(p.id, p);
      }
    }

    return (
      <PersonFormClient
        existing={data.existing}
        allPeople={Array.from(peopleById.values())}
        organisations={data.organisations}
        matters={data.matters}
        enquiries={data.enquiries}
        employees={shell.employees}
        lists={shell.lists}
        values={shell.values}
        customFields={shell.customFields}
        currentUserId={shell.currentUserId}
        orgStructure={shell.orgStructure}
        currentUserEmployeePermissions={shell.currentUserEmployeePermissions}
        existingSensitive={null}
        leaverOwnedRecords={data.leaverOwnedRecords}
        firmPrimaryDomain={shell.firmPrimaryDomain}
        firmName={shell.firm.name}
        tenantId={shell.tenantId}
      />
    );
  });
}
