import { notFound } from 'next/navigation';
import { TaskDetailClient } from '@/components/TaskDetailClient';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);
  const task = snap.tasks.find((t) => t.id === id);
  if (!task) notFound();

  const audit = snap.audit.filter((a) => a.recordType === 'task' && a.recordId === task.id);

  return (
    <TaskDetailClient
      task={task}
      teams={snap.teams}
      people={snap.people}
      organisations={snap.organisations}
      matters={snap.matters}
      enquiries={snap.enquiries}
      values={snap.values}
      audit={audit}
      currentUserId={snap.currentUserId}
    />
  );
}
