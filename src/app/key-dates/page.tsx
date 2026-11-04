import { KeyDatesDiaryWorkspace } from '@/components/KeyDatesDiaryWorkspace';
import { userTeams } from '@/domain/tasks';
import {
  getAppSnapshot,
  getKeyDateExceptionsReportRecord,
  queryKeyDatesTeamDiaryRecord,
  withPageActor,
} from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function KeyDatesPage() {
  return withPageActor(async (actor) => {
    const userId = actor.personId;
    const snap = getAppSnapshot(userId);
    const effectivePersonId = snap.effectiveWorkPerson.id;
    const userDefaultTeamIds = userTeams(effectivePersonId, snap.teams).map((t) => t.id);
    const canViewAnyTeam = snap.currentUserKeyDatePermissions.includes('keydate:view_any_team');

    const initialDiaryEntries = queryKeyDatesTeamDiaryRecord(
      {
        teamIds: canViewAnyTeam ? snap.teams.map((t) => t.id) : userDefaultTeamIds,
      },
      userId,
    );

    const initialExceptions = canViewAnyTeam
      ? getKeyDateExceptionsReportRecord({}, userId)
      : [];

    const todayIso = new Date().toISOString().slice(0, 10);

    return (
      <KeyDatesDiaryWorkspace
        currentUserId={userId}
        userPermissions={snap.currentUserKeyDatePermissions}
        keyDatesConfig={snap.keyDatesConfig}
        initialDiaryEntries={initialDiaryEntries}
        initialExceptions={initialExceptions}
        teams={snap.teams}
        userDefaultTeamIds={userDefaultTeamIds}
        matters={snap.matters}
        enquiries={snap.enquiries}
        people={snap.people}
        todayIso={todayIso}
      />
    );
  });
}
