import { OrganisationsListClient } from '@/components/OrganisationsListClient';
import {
  DEFAULT_LIST_PAGE_SIZE,
  loadOrganisationsListPageData,
  withOptionalPageActor,
  type OrganisationsListTabFilter,
} from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

type RawParams = Record<string, string | string[] | undefined>;

function firstParam(raw: RawParams, key: string): string | undefined {
  const val = raw[key];
  return Array.isArray(val) ? val[0] : val;
}

const VALID_TABS = new Set<OrganisationsListTabFilter>([
  'all',
  'clients',
  'prospects',
  'referrers',
  'archived',
]);

export default async function OrganisationsPage({
  searchParams,
}: {
  searchParams?: Promise<RawParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  const rawTab = firstParam(resolved, 'tab') as OrganisationsListTabFilter | undefined;
  const tab: OrganisationsListTabFilter = rawTab && VALID_TABS.has(rawTab) ? rawTab : 'all';
  const page = Number.parseInt(firstParam(resolved, 'page') ?? '1', 10) || 1;
  const pageSize =
    Number.parseInt(firstParam(resolved, 'pageSize') ?? '', 10) || DEFAULT_LIST_PAGE_SIZE;

  return withOptionalPageActor(async (actor) => {
    const data = await loadOrganisationsListPageData(actor.personId, {
      page,
      pageSize,
      query: firstParam(resolved, 'q'),
      tab,
      typeFilter: firstParam(resolved, 'type'),
      statusFilter: firstParam(resolved, 'status'),
      orgTypeFilter: firstParam(resolved, 'orgType'),
      sectorFilter: firstParam(resolved, 'sector'),
      ownerFilter: firstParam(resolved, 'owner'),
    });
    const { shell } = data;
    return (
      <OrganisationsListClient
        organisations={data.organisations}
        people={data.people}
        links={data.links}
        matters={data.matters}
        activeMatterCountsByOrgId={data.activeMatterCountsByOrgId}
        values={shell.values}
        employees={shell.employees}
        currentUserId={shell.currentUserId}
        pagination={data.pagination}
        initialFilters={data.filters}
      />
    );
  });
}
