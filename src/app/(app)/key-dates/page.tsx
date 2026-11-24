import { KeyDatesDiaryWorkspace } from '@/components/KeyDatesDiaryWorkspace';
import { loadKeyDatesPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function KeyDatesPage() {
  return withOptionalPageActor(async (actor) => {
    const data = await loadKeyDatesPageData(actor.personId);
    const { shell } = data;
    const todayIso = new Date().toISOString().slice(0, 10);

    return (
      <KeyDatesDiaryWorkspace
        currentUserId={shell.currentUserId}
        userPermissions={shell.currentUserKeyDatePermissions}
        keyDatesConfig={shell.keyDatesConfig}
        initialDiaryEntries={data.initialDiaryEntries}
        initialExceptions={data.initialExceptions}
        teams={shell.teams}
        userDefaultTeamIds={data.userDefaultTeamIds}
        matters={data.matters}
        enquiries={data.enquiries}
        people={data.people}
        todayIso={todayIso}
      />
    );
  }, '/key-dates');
}
