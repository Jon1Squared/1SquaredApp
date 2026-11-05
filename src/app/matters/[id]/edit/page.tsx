import React from 'react';
import { notFound } from 'next/navigation';
import { getAppSnapshot, withPageActor } from '@/server/services';
import { MatterFormClient } from '@/components/MatterFormClient';

export const dynamic = 'force-dynamic';

export default async function EditMatterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return withPageActor(async (actor) => {
    const snap = getAppSnapshot(actor.personId);
    const matter = snap.matters.find((m) => m.id === id);
    if (!matter) notFound();

    return (
      <MatterFormClient
        existing={matter}
        activeViewingRole={snap.activeViewingRole}
        people={snap.people}
        organisations={snap.organisations}
        links={snap.links}
        matters={snap.matters}
        enquiries={snap.enquiries}
        lists={snap.lists}
        values={snap.values}
        customFields={snap.customFields}
        employees={snap.employees}
        currentUser={snap.currentUser}
        orgStructure={snap.orgStructure}
        matterPartyTaxonomy={snap.matterPartyTaxonomy}
        matterCostsConfig={snap.matterCostsConfig}
        canReassignOwnership={snap.currentUserPermissions.includes('matter:reassign_ownership')}
        canSignOffCosts={snap.canSignOffCostsByMatterId[matter.id] ?? false}
        initialSignOffEstimateGbp={snap.signOffEstimateGbpByMatterId[matter.id] ?? null}
        suggestedMatterGovernanceAssignees={snap.suggestedMatterGovernanceAssignees}
      />
    );
  });
}
