import React from 'react';
import { isActionDenied } from '@/domain/actionResult';
import { getMatterFinanceRows } from '@/server/financeServices';
import { getAppSnapshot, withPageActor } from '@/server/services';
import { MattersListClient } from '@/components/MattersListClient';

export const dynamic = 'force-dynamic';

export default async function MattersPage() {
  return withPageActor(async (actor) => {
    const snap = getAppSnapshot(actor.personId);
    const matterFinanceRes = snap.finance.canViewMatter
      ? getMatterFinanceRows(actor.personId)
      : null;
    const matterFinance =
      matterFinanceRes && !isActionDenied(matterFinanceRes) ? matterFinanceRes : undefined;
    return (
      <MattersListClient
        matters={snap.matters}
        people={snap.people}
        organisations={snap.organisations}
        tasks={snap.tasks}
        values={snap.values}
        currentUserId={snap.currentUserId}
        canViewFinance={snap.finance.canViewMatter}
        pmsSummaryByMatterId={matterFinance?.pmsSummaryByMatterId}
        pmsAsAtDate={matterFinance?.pmsExtractInfo.asAtDate}
      />
    );
  });
}

