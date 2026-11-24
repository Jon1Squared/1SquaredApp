import { PeopleListClient } from '@/components/PeopleListClient';
import {
  loadPeopleListPageData,
  parseListPageParam,
  parseListPageSizeParam,
  withOptionalPageActor,
  type PeopleListTabFilter,
} from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

type RawParams = Record<string, string | string[] | undefined>;

function firstParam(raw: RawParams, key: string): string | undefined {
  const val = raw[key];
  return Array.isArray(val) ? val[0] : val;
}

const VALID_TABS = new Set<PeopleListTabFilter>([
  'all',
  'external',
  'enquiry',
  'employee',
  'archived',
]);

export default async function PeoplePage({
  searchParams,
}: {
  searchParams?: Promise<RawParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  const rawTab = firstParam(resolved, 'tab') as PeopleListTabFilter | undefined;
  const tab: PeopleListTabFilter = rawTab && VALID_TABS.has(rawTab) ? rawTab : 'all';
  const page = parseListPageParam(firstParam(resolved, 'page'));
  const pageSize = parseListPageSizeParam(firstParam(resolved, 'pageSize'));
  const rawDir = firstParam(resolved, 'dir');
  const sortDir = rawDir === 'desc' ? 'desc' : rawDir === 'asc' ? 'asc' : undefined;

  return withOptionalPageActor(async (actor) => {
    const data = await loadPeopleListPageData(actor.personId, {
      page,
      pageSize,
      query: firstParam(resolved, 'q'),
      tab,
      roleFilter: firstParam(resolved, 'role'),
      statusFilter: firstParam(resolved, 'status'),
      ownerFilter: firstParam(resolved, 'owner'),
      sortBy: firstParam(resolved, 'sort'),
      sortDir,
    });
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
        pagination={data.pagination}
        initialFilters={data.filters}
      />
    );
  });
}
