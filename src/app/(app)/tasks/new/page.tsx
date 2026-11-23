import { TaskFormClient } from '@/components/TaskFormClient';
import type { TaskLinkedRecord, TaskLinkedRecordType } from '@/domain/types';
import { loadTaskFormPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<{ recordType?: string; recordId?: string; teamId?: string }>;
}) {
  const sp = await searchParams;
  return withOptionalPageActor(async (actor) => {
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

    const data = await loadTaskFormPageData(actor.personId, initialLinkedRecord);
    const { shell } = data;

    return (
      <TaskFormClient
        teams={shell.teams}
        people={data.people}
        organisations={data.organisations}
        matters={data.matters}
        enquiries={data.enquiries}
        quotes={data.quotes}
        values={shell.values}
        currentUserId={shell.currentUserId}
        initialLinkedRecord={initialLinkedRecord}
        initialTeamId={sp.teamId ?? null}
      />
    );
  });
}
