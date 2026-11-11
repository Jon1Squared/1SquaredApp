import { HomeClient } from '@/components/HomeClient';
import { isActionDenied } from '@/domain/actionResult';
import { getEntraSession } from '@/server/entraAuth';
import {
  getFirmFinance,
  getMatterFinanceRows,
  getMyFinanceFigures,
} from '@/server/financeServices';
import { getAppSnapshot, withPageActor } from '@/server/services';

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
  return withPageActor(async (actor) => {
    const snap = await getAppSnapshot(actor.personId);
    const resolvedParams = searchParams ? await searchParams : {};

    const matterFinanceRes = snap.finance.canViewMatter
      ? getMatterFinanceRows(actor.personId)
      : null;
    const matterFinance =
      matterFinanceRes && !isActionDenied(matterFinanceRes) ? matterFinanceRes : undefined;

    const myFinanceRes = snap.finance.canViewMatter
      ? getMyFinanceFigures(actor.personId)
      : null;
    const myFinance =
      myFinanceRes && !isActionDenied(myFinanceRes) ? myFinanceRes : undefined;

    const firmFinanceRes = snap.finance.canViewFirm
      ? getFirmFinance(actor.personId)
      : null;
    const firmFinance =
      firmFinanceRes && !isActionDenied(firmFinanceRes) ? firmFinanceRes : undefined;

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
        finance={snap.finance}
        pmsLinks={matterFinance?.pmsLinks}
        pmsAsAtDate={
          matterFinance?.pmsExtractInfo.asAtDate ?? firmFinance?.pmsExtractInfo.asAtDate
        }
        pmsSummaryByMatterId={matterFinance?.pmsSummaryByMatterId}
        pmsSummaryByClientId={firmFinance?.pmsSummaryByClientId}
        allMatterFins={matterFinance?.allMatterFins}
        allClientFins={firmFinance?.allClientFins}
        allFeeEarnerPerformance={firmFinance?.allFeeEarnerPerformance}
        myFeeEarnerFigures={myFinance?.myFeeEarnerFigures}
        myWeeklyTime={myFinance?.myWeeklyTime}
        pmsAgedDebt={matterFinance?.pmsAgedDebt}
        pmsInvoices={matterFinance?.pmsInvoices}
        pmsMonthlyFeesBilled={firmFinance?.pmsMonthlyFeesBilled}
        pmsCashReceived={firmFinance?.pmsCashReceived}
        pmsDepartmentFinancials={firmFinance?.pmsDepartmentFinancials}
        pmsAllDisbursements={matterFinance?.pmsAllDisbursements}
        pmsClientAccountByMatterCode={matterFinance?.pmsClientAccountByMatterCode}
      />
    );
  });
}
