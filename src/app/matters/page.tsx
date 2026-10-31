import React from 'react';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';
import { MattersListClient } from '@/components/MattersListClient';

export const dynamic = 'force-dynamic';

export default async function MattersPage() {
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);
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
}

