import { notFound } from 'next/navigation';
import { TaskDetailClient } from '@/components/TaskDetailClient';
import { canUserReassignTask, canUserTakeTask } from '@/domain/tasks';
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
  const canTake = canUserTakeTask(
    snap.currentUserId,
    task,
    snap.teams,
    snap.people,
    snap.values,
    snap.currentUserPermissions,
  );
  const canReassign = canUserReassignTask(
    snap.currentUserId,
    task,
    snap.teams,
    snap.people,
    snap.values,
    snap.currentUserPermissions,
  );

  return (
    <TaskDetailClient
      task={task}
      teams={snap.teams}
      people={snap.people}
      organisations={snap.organisations}
      matters={snap.matters}
      enquiries={snap.enquiries}
      quotes={snap.quotes}
      values={snap.values}
      audit={audit}
      currentUserId={snap.currentUserId}
      canTake={canTake}
      canReassign={canReassign}
    />
  );
}
