import { HomeClient } from '@/components/HomeClient';
import { getEntraSession } from '@/server/entraAuth';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ view?: string; previewRole?: string }>;
}) {
  const entraSession = await getEntraSession();
  if (!entraSession) {
    return null;
  }
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);
  const resolvedParams = searchParams ? await searchParams : {};

  // Allow left-rail Finance / Risk shortcuts or Admin Preview links to override the displayed role view
  const requestedRole = resolvedParams.previewRole || resolvedParams.view;
  const activeRoleKey =
    requestedRole && snap.homePagesConfig.roles.some((r) => r.key === requestedRole)
      ? requestedRole
      : snap.activeViewingRole;

  return (
    <HomeClient
      currentUser={snap.currentUser}
      effectiveWorkPerson={snap.effectiveWorkPerson}
      activeRoleKey={activeRoleKey}
      homePagesConfig={snap.homePagesConfig}
      searchIndex={snap.searchIndex}
      signOffs={snap.signOffs}
      people={snap.people}
      organisations={snap.organisations}
      matters={snap.matters}
      enquiries={snap.enquiries}
      tasks={snap.tasks}
      teams={snap.teams}
      values={snap.values}
      pmsLinks={snap.pmsLinks}
      pmsAsAtDate={snap.pmsExtractInfo.asAtDate}
      pmsSummaryByMatterId={snap.pmsSummaryByMatterId}
      pmsSummaryByClientId={snap.pmsSummaryByClientId}
      allMatterFins={snap.allMatterFins}
      allClientFins={snap.allClientFins}
      allFeeEarnerPerformance={snap.allFeeEarnerPerformance}
      myFeeEarnerFigures={snap.myFeeEarnerFigures}
      myWeeklyTime={snap.myWeeklyTime}
      pmsAgedDebt={snap.pmsAgedDebt}
      pmsInvoices={snap.pmsInvoices}
      pmsMonthlyFeesBilled={snap.pmsMonthlyFeesBilled}
      pmsCashReceived={snap.pmsCashReceived}
      pmsDepartmentFinancials={snap.pmsDepartmentFinancials}
      pmsAllDisbursements={snap.pmsAllDisbursements}
      pmsClientAccountByMatterCode={snap.pmsClientAccountByMatterCode}
    />
  );
}
