import { OrganisationsListClient } from '@/components/OrganisationsListClient';
import {
  loadOrganisationsListPageData,
  withOptionalPageActor,
} from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function OrganisationsPage() {
  return withOptionalPageActor(async (actor) => {
    const data = await loadOrganisationsListPageData(actor.personId);
    const { shell } = data;
    return (
      <OrganisationsListClient
        organisations={data.organisations}
        people={data.people}
        links={data.links}
        matters={data.matters}
        values={shell.values}
        employees={shell.employees}
        currentUserId={shell.currentUserId}
      />
    );
  });
}
