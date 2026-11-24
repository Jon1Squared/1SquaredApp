import React from 'react';
import { MattersListClient } from '@/components/MattersListClient';
import {
  DEFAULT_LIST_PAGE_SIZE,
  loadMattersListPageData,
  withOptionalPageActor,
  type MattersListTabFilter,
} from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

type RawParams = Record<string, string | string[] | undefined>;

function firstParam(raw: RawParams, key: string): string | undefined {
  const val = raw[key];
  return Array.isArray(val) ? val[0] : val;
}

const VALID_TABS = new Set<MattersListTabFilter>([
  'all',
  'mine',
  'Transactional',
  'Contentious',
  'Advisory',
]);

export default async function MattersPage({
  searchParams,
}: {
  searchParams?: Promise<RawParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  const rawTab = firstParam(resolved, 'tab') as MattersListTabFilter | undefined;
  const tab: MattersListTabFilter = rawTab && VALID_TABS.has(rawTab) ? rawTab : 'all';
  const page = Number.parseInt(firstParam(resolved, 'page') ?? '1', 10) || 1;
  const pageSize =
    Number.parseInt(firstParam(resolved, 'pageSize') ?? '', 10) || DEFAULT_LIST_PAGE_SIZE;

  return withOptionalPageActor(async (actor) => {
    const data = await loadMattersListPageData(actor.personId, {
      page,
      pageSize,
      query: firstParam(resolved, 'q'),
      tab,
      practiceAreaId: firstParam(resolved, 'practiceArea'),
      statusFilter: firstParam(resolved, 'status'),
      feeEarnerFilter: firstParam(resolved, 'feeEarner'),
      billingBasisFilter: firstParam(resolved, 'billingBasis'),
    });
    const { shell, matterFinance } = data;
    return (
      <MattersListClient
        matters={data.matters}
        people={data.people}
        employees={shell.employees}
        organisations={data.organisations}
        tasks={data.tasks}
        values={shell.values}
        currentUserId={shell.currentUserId}
        canViewFinance={shell.finance.canViewMatter}
        pmsSummaryByMatterId={matterFinance?.pmsSummaryByMatterId}
        pmsAsAtDate={matterFinance?.pmsExtractInfo.asAtDate}
        pagination={data.pagination}
        initialFilters={data.filters}
      />
    );
  });
}
