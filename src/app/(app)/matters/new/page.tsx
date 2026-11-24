import React from 'react';
import { MatterFormClient } from '@/components/MatterFormClient';
import { buildRouteReturnTo } from '@/domain/authReturnTo';
import { loadMatterFormPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function NewMatterPage({
  searchParams,
}: {
  searchParams: Promise<{
    clientId?: string;
    subcategory?: string;
    enquiryId?: string;
    fromEnquiry?: string;
    quoteId?: string;
    instructingContactId?: string;
    draftId?: string;
  }>;
}) {
  const params = await searchParams;
  return withOptionalPageActor(async (actor) => {
    const data = await loadMatterFormPageData(actor.personId, params);
    if (!data) return null;
    const { shell } = data;

    return (
      <MatterFormClient
        existing={data.existing}
        isReopenedDraft={data.isReopenedDraft}
        initialClientId={params.clientId ?? null}
        initialSubcategoryName={params.subcategory ?? null}
        initialEnquiry={data.initialEnquiry}
        initialQuote={data.initialQuote}
        initialInstructingContactId={params.instructingContactId ?? null}
        initialConflictWarnings={data.initialConflictWarnings}
        initialResolvedRates={data.initialResolvedRates}
        initialMatterRateOverrides={data.initialMatterRateOverrides}
        activeViewingRole={shell.activeViewingRole}
        people={data.people}
        organisations={data.organisations}
        links={data.links}
        matters={data.clientMatters}
        enquiries={data.initialEnquiry ? [data.initialEnquiry] : []}
        lists={shell.lists}
        values={shell.values}
        customFields={shell.customFields}
        employees={shell.employees}
        currentUser={shell.currentUser}
        effectiveWorkPerson={shell.effectiveWorkPerson}
        supervisingPartnerByEmployeeId={shell.supervisingPartnerByEmployeeId}
        orgStructure={shell.orgStructure}
        workTypesConfig={shell.store.workTypesConfig}
        matterPartyTaxonomy={shell.store.matterPartyTaxonomy}
        matterCostsConfig={shell.store.matterCostsConfig}
        canReassignOwnership={shell.currentUserPermissions.includes(
          'matter:reassign_ownership',
        )}
        canSignOffCosts={
          data.existing
            ? data.canSignOffCosts
            : shell.currentUserPermissions.includes('matter:costs:sign_off')
        }
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
  }, buildRouteReturnTo('/matters/new', params));
}
