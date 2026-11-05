import React from 'react';
import { getAppSnapshot, withPageActor } from '@/server/services';
import { MattersListClient } from '@/components/MattersListClient';

export const dynamic = 'force-dynamic';

export default async function MattersPage() {
  return withPageActor(async (actor) => {
    const snap = getAppSnapshot(actor.personId);
    return (
      <MattersListClient
        matters={snap.matters}
        people={snap.people}
        organisations={snap.organisations}
        tasks={snap.tasks}
        values={snap.values}
        currentUserId={snap.currentUserId}
        canViewFinance={snap.canViewFinance}
        pmsSummaryByMatterId={snap.pmsSummaryByMatterId}
        pmsAsAtDate={snap.pmsExtractInfo.asAtDate}
      />
    );
  });
}

