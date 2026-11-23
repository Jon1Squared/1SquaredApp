import { notFound } from 'next/navigation';
import { TaskDetailClient } from '@/components/TaskDetailClient';
import { loadTaskDetailPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return withOptionalPageActor(async (actor) => {
    const data = await loadTaskDetailPageData(actor.personId, id);
    if (!data) notFound();
    const { shell } = data;

    return (
      <TaskDetailClient
        task={data.task}
        teams={shell.teams}
        people={data.people}
        organisations={data.organisations}
        matters={data.matters}
        enquiries={data.enquiries}
        quotes={data.quotes}
        values={shell.values}
        audit={data.audit}
        currentUserId={shell.currentUserId}
        canTake={data.canTake}
        canReassign={data.canReassign}
      />
    );
  });
}
