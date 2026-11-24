import { TasksListClient } from '@/components/TasksListClient';
import {
  loadTasksListPageData,
  parseListPageParam,
  parseListPageSizeParam,
  withOptionalPageActor,
  type TasksListTabFilter,
} from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

type RawParams = Record<string, string | string[] | undefined>;

function firstParam(raw: RawParams, key: string): string | undefined {
  const val = raw[key];
  return Array.isArray(val) ? val[0] : val;
}

const VALID_TABS = new Set<TasksListTabFilter>(['my', 'team', 'created', 'all']);

export default async function TasksPage({
  searchParams,
}: {
  searchParams?: Promise<RawParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  const rawTab = firstParam(resolved, 'tab') as TasksListTabFilter | undefined;
  const tab: TasksListTabFilter = rawTab && VALID_TABS.has(rawTab) ? rawTab : 'my';
  const page = parseListPageParam(firstParam(resolved, 'page'));
  const pageSize = parseListPageSizeParam(firstParam(resolved, 'pageSize'));
  const rawDir = firstParam(resolved, 'dir');
  const sortDir = rawDir === 'desc' ? 'desc' : rawDir === 'asc' ? 'asc' : undefined;

  return withOptionalPageActor(async (actor) => {
    const data = await loadTasksListPageData(actor.personId, {
      page,
      pageSize,
      query: firstParam(resolved, 'q'),
      tab,
      statusFilter: firstParam(resolved, 'status') ?? 'open',
      priorityFilter: firstParam(resolved, 'priority'),
      typeFilter: firstParam(resolved, 'type'),
      teamFilter: firstParam(resolved, 'team'),
      recordTypeFilter: firstParam(resolved, 'recordType'),
      sortBy: firstParam(resolved, 'sort'),
      sortDir,
    });
    const { shell } = data;

    return (
      <TasksListClient
        tasks={data.tasks}
        teams={shell.teams}
        people={data.people}
        organisations={data.organisations}
        matters={data.matters}
        enquiries={data.enquiries}
        quotes={data.quotes}
        values={shell.values}
        currentUserId={shell.currentUserId}
        currentUserRole={shell.currentUserRole}
        pagination={data.pagination}
        initialFilters={data.filters}
      />
    );
  });
}
