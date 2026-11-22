import React from 'react';
import { normaliseConversionConflictWarnings } from '@/domain/matterConflicts';
import { isActionDenied } from '@/domain/actionResult';
import {
  getAppSnapshot,
  listMatterRateOverridesRecord,
  resolveApplicableRatesRecord,
  withPageActor,
} from '@/server/services';
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
  }>;
}) {
  const params = await searchParams;
  return withPageActor(async (actor) => {
    const snap = await getAppSnapshot(actor.personId);
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
    const rateClientId =
      draftMatter?.clientId ??
      params.clientId ??
      initialQuote?.linkedOrganisationId ??
      initialQuote?.linkedPersonId ??
      null;
    const ratePracticeAreaId =
      draftMatter?.practiceAreaId ?? initialQuote?.practiceAreaId ?? null;
    const [initialRatesRes, matterRateOverridesRes] = await Promise.all([
      rateClientId || ratePracticeAreaId || draftMatter?.id
        ? resolveApplicableRatesRecord(
            {
              matterId: draftMatter?.id ?? null,
              clientId: rateClientId,
              clientType: rateClientId?.startsWith('O-')
                ? 'organisation'
                : rateClientId
                  ? 'person'
                  : null,
              practiceAreaId: ratePracticeAreaId,
            },
            actor.personId,
          )
        : Promise.resolve(null),
      draftMatter?.id
        ? listMatterRateOverridesRecord(draftMatter.id, actor.personId)
        : Promise.resolve(null),
    ]);
    return (
      <MatterFormClient
        existing={draftMatter}
        isReopenedDraft={Boolean(draftMatter)}
        initialClientId={params.clientId ?? null}
        initialSubcategoryName={params.subcategory ?? null}
        initialEnquiry={initialEnquiry}
        initialQuote={initialQuote}
        initialInstructingContactId={params.instructingContactId ?? null}
        initialConflictWarnings={normaliseConversionConflictWarnings(
          initialQuote?.conflictDecision?.warnings ??
            initialEnquiry?.conflictDecision?.warnings,
        )}
        initialResolvedRates={
          initialRatesRes && !isActionDenied(initialRatesRes)
            ? (initialRatesRes.resolved ?? null)
            : null
        }
        initialMatterRateOverrides={
          matterRateOverridesRes && !isActionDenied(matterRateOverridesRes)
            ? matterRateOverridesRes.overrides
            : []
        }
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
        workTypesConfig={snap.workTypesConfig}
        matterPartyTaxonomy={snap.matterPartyTaxonomy}
        matterCostsConfig={snap.matterCostsConfig}
        canReassignOwnership={snap.currentUserPermissions.includes('matter:reassign_ownership')}
        canSignOffCosts={
          draftMatter
            ? snap.canSignOffCostsByMatterId[draftMatter.id] ?? false
            : snap.currentUserPermissions.includes('matter:costs:sign_off')
        }
        canManageMatterRateOverrides={snap.currentUserPermissions.some((p) =>
          ['matter:costs:sign_off', 'finance:credit_control', 'admin:access'].includes(p),
        )}
        initialSignOffEstimateGbp={
          draftMatter
            ? snap.signOffEstimateGbpByMatterId[draftMatter.id] ?? null
            : null
        }
        suggestedMatterGovernanceAssignees={snap.suggestedMatterGovernanceAssignees}
        enableAiMatterExtraction={snap.enableAiMatterExtraction}
        aiProviderChoice={snap.aiProviderChoice}
        enableMatterCostsGovernance={snap.enableMatterCostsGovernance}
        tenantId={snap.tenantId}
      />
    );
  });
}
