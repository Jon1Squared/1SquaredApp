import { TaskFormClient } from '@/components/TaskFormClient';
import type { TaskLinkedRecord, TaskLinkedRecordType } from '@/domain/types';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<{ recordType?: string; recordId?: string; teamId?: string }>;
}) {
  const sp = await searchParams;
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);

  const validTypes: TaskLinkedRecordType[] = ['enquiry', 'matter', 'person', 'organisation'];
  const initialLinkedRecord: TaskLinkedRecord | null =
    sp.recordType &&
    sp.recordId &&
    validTypes.includes(sp.recordType as TaskLinkedRecordType)
      ? { recordType: sp.recordType as TaskLinkedRecordType, recordId: sp.recordId }
      : null;

  return (
    <TaskFormClient
      teams={snap.teams}
      people={snap.people}
      organisations={snap.organisations}
      matters={snap.matters}
      enquiries={snap.enquiries}
      values={snap.values}
      currentUserId={snap.currentUserId}
      initialLinkedRecord={initialLinkedRecord}
      initialTeamId={sp.teamId ?? null}
    />
  );
}
