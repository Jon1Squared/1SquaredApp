import { notFound, redirect } from 'next/navigation';
import { OrganisationFormClient } from '@/components/OrganisationFormClient';
import {
  loadOrganisationFormPageData,
  withOptionalPageActor,
} from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function EditOrganisationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return withOptionalPageActor(async (actor) => {
    const data = await loadOrganisationFormPageData(actor.personId, id);
    if (!data) notFound();
    if ('redirectTo' in data) {
      redirect(data.redirectTo);
    }
    if (!data.existing) notFound();
    const { shell } = data;

    return (
      <OrganisationFormClient
        existing={data.existing}
        allOrganisations={data.allOrganisations}
        allPeople={shell.employees}
        matters={[]}
        enquiries={[]}
        employees={shell.employees}
        lists={shell.lists}
        values={shell.values}
        customFields={shell.customFields}
        currentUserId={shell.currentUserId}
        tenantId={shell.tenantId}
      />
    );
  });
}
