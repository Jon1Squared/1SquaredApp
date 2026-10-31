import { TasksListClient } from '@/components/TasksListClient';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);

  return (
    <TasksListClient
      tasks={snap.tasks}
      teams={snap.teams}
      people={snap.people}
      organisations={snap.organisations}
      matters={snap.matters}
      enquiries={snap.enquiries}
      values={snap.values}
      currentUserId={snap.currentUserId}
    />
  );
}
