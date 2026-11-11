import { TaskFormClient } from '@/components/TaskFormClient';
import type { TaskLinkedRecord, TaskLinkedRecordType } from '@/domain/types';
import { getAppSnapshot, withPageActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<{ recordType?: string; recordId?: string; teamId?: string }>;
}) {
  const sp = await searchParams;
  return withPageActor(async (actor) => {
    const snap = await getAppSnapshot(actor.personId);

    const validTypes: TaskLinkedRecordType[] = [
      'enquiry',
      'quote',
      'matter',
      'person',
      'organisation',
    ];
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
        quotes={snap.quotes}
        values={snap.values}
        currentUserId={snap.currentUserId}
        initialLinkedRecord={initialLinkedRecord}
        initialTeamId={sp.teamId ?? null}
      />
    );
  });
}
