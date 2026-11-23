import { PeopleListClient } from '@/components/PeopleListClient';
import { loadPeopleListPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function PeoplePage() {
  return withOptionalPageActor(async (actor) => {
    const data = await loadPeopleListPageData(actor.personId);
    const { shell } = data;
    return (
      <PeopleListClient
        people={data.people}
        organisations={data.organisations}
        links={data.links}
        values={shell.values}
        employees={shell.employees}
        enquiries={data.enquiries}
        currentUserId={shell.currentUserId}
        firmName={shell.firm.name}
      />
    );
  });
}
