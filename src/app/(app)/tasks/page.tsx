import { TasksListClient } from '@/components/TasksListClient';
import { loadTasksListPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  return withOptionalPageActor(async (actor) => {
    const data = await loadTasksListPageData(actor.personId);
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
      />
    );
  });
}
