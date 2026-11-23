import { EnquiriesListClient } from '@/components/EnquiriesListClient';
import { loadEnquiriesListPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function EnquiriesPage() {
  return withOptionalPageActor(async (actor) => {
    const data = await loadEnquiriesListPageData(actor.personId);
    const { shell } = data;

    return (
      <EnquiriesListClient
        enquiries={data.enquiries}
        quotes={data.quotes}
        tasks={data.tasks}
        teams={shell.teams}
        people={data.people}
        organisations={data.organisations}
        matters={data.matters}
        values={shell.values}
        currentUserId={shell.currentUserId}
      />
    );
  });
}
