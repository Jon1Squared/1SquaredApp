import { TasksListClient } from '@/components/TasksListClient';
import { getAppSnapshot, withPageActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  return withPageActor(async (actor) => {
    const snap = getAppSnapshot(actor.personId);

    return (
      <TasksListClient
        tasks={snap.tasks}
        teams={snap.teams}
        people={snap.people}
        organisations={snap.organisations}
        matters={snap.matters}
        enquiries={snap.enquiries}
        quotes={snap.quotes}
        values={snap.values}
        currentUserId={snap.currentUserId}
        currentUserRole={snap.currentUserRole}
      />
    );
  });
}
