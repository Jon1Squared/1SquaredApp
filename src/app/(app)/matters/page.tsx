import React from 'react';
import { MattersListClient } from '@/components/MattersListClient';
import { loadMattersListPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function MattersPage() {
  return withOptionalPageActor(async (actor) => {
    const data = await loadMattersListPageData(actor.personId);
    const { shell, matterFinance } = data;
    return (
      <MattersListClient
        matters={data.matters}
        people={data.people}
        organisations={data.organisations}
        tasks={data.tasks}
        values={shell.values}
        currentUserId={shell.currentUserId}
        canViewFinance={shell.finance.canViewMatter}
        pmsSummaryByMatterId={matterFinance?.pmsSummaryByMatterId}
        pmsAsAtDate={matterFinance?.pmsExtractInfo.asAtDate}
      />
    );
  });
}
