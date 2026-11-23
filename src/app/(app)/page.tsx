import { HomeClient } from '@/components/HomeClient';
import { loadHomePageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ view?: string; previewRole?: string }>;
}) {
  const resolvedParams = searchParams ? await searchParams : {};
  return withOptionalPageActor(async (actor) => {
    const data = await loadHomePageData(actor.personId, resolvedParams);
    const { shell, matterFinance, myFinance, firmFinance } = data;

    return (
      <HomeClient
        currentUser={shell.currentUser}
        effectiveWorkPerson={shell.effectiveWorkPerson}
        activeRoleKey={data.activeRoleKey}
        homePagesConfig={shell.homePagesConfig}
        signOffs={data.signOffs}
        people={data.people}
        organisations={data.organisations}
        matters={data.matters}
        enquiries={data.enquiries}
        tasks={data.tasks}
        teams={shell.teams}
        values={shell.values}
        registerTypes={data.registerTypes}
        registerRecords={data.registerRecords}
        finance={shell.finance}
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
