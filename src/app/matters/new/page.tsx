import React from 'react';
import { getAppSnapshot, withPageActor } from '@/server/services';
import { MatterFormClient } from '@/components/MatterFormClient';

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
    scenario?: string;
  }>;
}) {
  const params = await searchParams;
  return withPageActor(async (actor) => {
    const snap = getAppSnapshot(actor.personId);
    const initialQuote = params.quoteId
      ? snap.quotes.find((q) => q.id === params.quoteId || q.reference === params.quoteId) ?? null
      : null;
    const resolvedEnquiryId =
      params.enquiryId ?? params.fromEnquiry ?? initialQuote?.linkedEnquiryId ?? undefined;
    const initialEnquiry = resolvedEnquiryId
      ? snap.enquiries.find((e) => e.id === resolvedEnquiryId) ?? null
      : null;
    const draftMatter = params.draftId
      ? snap.matters.find((m) => m.id === params.draftId) ?? null
      : null;
    return (
      <MatterFormClient
        existing={draftMatter}
        isReopenedDraft={Boolean(draftMatter)}
        initialScenario={params.scenario ?? null}
        initialClientId={params.clientId ?? null}
        initialSubcategoryName={params.subcategory ?? null}
        initialEnquiry={initialEnquiry}
        initialQuote={initialQuote}
        initialInstructingContactId={params.instructingContactId ?? null}
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
        canSignOffCosts={
          draftMatter
            ? snap.canSignOffCostsByMatterId[draftMatter.id] ?? false
            : snap.currentUserPermissions.includes('matter:costs:sign_off')
        }
        initialSignOffEstimateGbp={
          draftMatter
            ? snap.signOffEstimateGbpByMatterId[draftMatter.id] ?? null
            : null
        }
        suggestedMatterGovernanceAssignees={snap.suggestedMatterGovernanceAssignees}
        enableAiMatterExtraction={snap.enableAiMatterExtraction}
        aiProviderChoice={snap.aiProviderChoice}
      />
    );
  });
}
