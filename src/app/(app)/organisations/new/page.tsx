import { OrganisationFormClient } from '@/components/OrganisationFormClient';
import {
  loadOrganisationFormPageData,
  withOptionalPageActor,
} from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function NewOrganisationPage() {
  return withOptionalPageActor(async (actor) => {
    const data = await loadOrganisationFormPageData(actor.personId);
    if (!data || 'redirectTo' in data) return null;
    const { shell } = data;

    return (
      <OrganisationFormClient
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
