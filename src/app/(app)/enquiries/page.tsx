import { EnquiriesListClient } from '@/components/EnquiriesListClient';
import type { EnquiriesQueueTab } from '@/domain/enquiries';
import {
  DEFAULT_LIST_PAGE_SIZE,
  loadEnquiriesListPageData,
  withOptionalPageActor,
} from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

type RawParams = Record<string, string | string[] | undefined>;

function firstParam(raw: RawParams, key: string): string | undefined {
  const val = raw[key];
  return Array.isArray(val) ? val[0] : val;
}

const VALID_TABS = new Set<EnquiriesQueueTab>([
  'team',
  'mine',
  'drafts',
  'open',
  'open_quotes',
  'closed',
]);

export default async function EnquiriesPage({
  searchParams,
}: {
  searchParams?: Promise<RawParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  const rawTab = firstParam(resolved, 'tab') as EnquiriesQueueTab | undefined;
  const tab: EnquiriesQueueTab = rawTab && VALID_TABS.has(rawTab) ? rawTab : 'team';
  const rawType = firstParam(resolved, 'type');
  const typeFilter: 'all' | 'enquiry' | 'quote' =
    rawType === 'enquiry' || rawType === 'quote' ? rawType : 'all';
  const rawFollowUp = firstParam(resolved, 'followUp');
  const followUpDueFilter: 'all' | 'overdue' | 'today' | 'this_week' =
    rawFollowUp === 'overdue' || rawFollowUp === 'today' || rawFollowUp === 'this_week'
      ? rawFollowUp
      : 'all';
  const page = Number.parseInt(firstParam(resolved, 'page') ?? '1', 10) || 1;
  const pageSize =
    Number.parseInt(firstParam(resolved, 'pageSize') ?? '', 10) || DEFAULT_LIST_PAGE_SIZE;

  return withOptionalPageActor(async (actor) => {
    const data = await loadEnquiriesListPageData(actor.personId, {
      page,
      pageSize,
      query: firstParam(resolved, 'q'),
      tab,
      typeFilter,
      urgencyFilter: firstParam(resolved, 'urgency'),
      statusFilter: firstParam(resolved, 'status'),
      practiceAreaFilter: firstParam(resolved, 'practiceArea'),
      teamFilter: firstParam(resolved, 'team'),
      channelFilter: firstParam(resolved, 'channel'),
      feeBasisFilter: firstParam(resolved, 'feeBasis'),
      feeEarnerFilter: firstParam(resolved, 'feeEarner'),
      validUntilFrom: firstParam(resolved, 'validFrom'),
      validUntilTo: firstParam(resolved, 'validTo'),
      followUpDueFilter,
    });
    const { shell } = data;

    return (
      <EnquiriesListClient
        enquiries={data.enquiries}
        quotes={data.quotes}
        tasks={data.tasks}
        teams={shell.teams}
        people={data.people}
        employees={shell.employees}
        organisations={data.organisations}
        matters={data.matters}
        values={shell.values}
        currentUserId={shell.currentUserId}
        pagination={data.pagination}
        initialFilters={data.filters}
      />
    );
  });
}
