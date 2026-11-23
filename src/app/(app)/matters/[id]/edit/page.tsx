import React from 'react';
import { notFound } from 'next/navigation';
import { MatterFormClient } from '@/components/MatterFormClient';
import { loadMatterFormPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function EditMatterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return withOptionalPageActor(async (actor) => {
    const data = await loadMatterFormPageData(actor.personId, { editId: id });
    if (!data || !data.existing) notFound();
    const { shell } = data;

    return (
      <MatterFormClient
        existing={data.existing}
        initialEnquiry={data.initialEnquiry}
        initialQuote={data.initialQuote}
        initialConflictWarnings={data.initialConflictWarnings}
        initialResolvedRates={data.initialResolvedRates}
        initialMatterRateOverrides={data.initialMatterRateOverrides}
        activeViewingRole={shell.activeViewingRole}
        people={data.people}
        organisations={data.organisations}
        links={data.links}
        enquiries={data.initialEnquiry ? [data.initialEnquiry] : []}
        lists={shell.lists}
        values={shell.values}
        customFields={shell.customFields}
        employees={shell.employees}
        currentUser={shell.currentUser}
        orgStructure={shell.orgStructure}
        workTypesConfig={shell.store.workTypesConfig}
        matterPartyTaxonomy={shell.store.matterPartyTaxonomy}
        matterCostsConfig={shell.store.matterCostsConfig}
        canReassignOwnership={shell.currentUserPermissions.includes(
          'matter:reassign_ownership',
        )}
        canSignOffCosts={data.canSignOffCosts}
        canManageMatterRateOverrides={shell.currentUserPermissions.some((p) =>
          ['matter:costs:sign_off', 'finance:credit_control', 'admin:access'].includes(
            p,
          ),
        )}
        initialSignOffEstimateGbp={data.initialSignOffEstimateGbp}
        suggestedMatterGovernanceAssignees={data.suggestedMatterGovernanceAssignees}
        enableAiMatterExtraction={shell.enableAiMatterExtraction}
        aiProviderChoice={shell.aiProviderChoice}
        enableMatterCostsGovernance={shell.enableMatterCostsGovernance}
        tenantId={shell.tenantId}
      />
    );
  });
}
