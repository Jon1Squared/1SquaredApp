import React from 'react';
import { notFound } from 'next/navigation';
import { MatterFormClient } from '@/components/MatterFormClient';
import { MatterProfileClient } from '@/components/MatterProfileClient';
import { buildRouteReturnTo } from '@/domain/authReturnTo';
import { loadMatterDetailPageData, withOptionalPageActor } from '@/server/pageLoaders';
import { recordRecentlyViewed } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function MatterProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const search = searchParams ? await searchParams : {};
  return withOptionalPageActor(async (actor) => {
    const data = await loadMatterDetailPageData(actor.personId, id, search.tab);
    if (!data) notFound();

    await recordRecentlyViewed(actor.personId, data.matter.id);
    const { shell } = data;

    if (data.kind === 'form') {
      return (
        <MatterFormClient
          existing={data.matter}
          initialEnquiry={data.initialEnquiry}
          initialQuote={data.initialQuote}
          isReopenedDraft={data.isReopenedDraft}
          initialResolvedRates={data.initialResolvedRates}
          initialMatterRateOverrides={data.initialMatterRateOverrides}
          activeViewingRole={shell.activeViewingRole}
          people={data.people}
          organisations={data.organisations}
          links={data.links}
          matters={data.clientMatters}
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
          canViewCdd={data.canViewClientCdd}
          canSignOffCosts={data.canSignOffCosts}
          canManageMatterRateOverrides={data.canManageMatterRateOverrides}
          initialSignOffEstimateGbp={data.initialSignOffEstimateGbp}
          suggestedMatterGovernanceAssignees={data.suggestedMatterGovernanceAssignees}
          enableAiMatterExtraction={shell.enableAiMatterExtraction}
          aiProviderChoice={shell.aiProviderChoice}
          enableMatterCostsGovernance={shell.enableMatterCostsGovernance}
          tenantId={shell.tenantId}
        />
      );
    }

    return (
      <MatterProfileClient
        matter={data.matter}
        initialTab={search.tab}
        people={data.people}
        organisations={data.organisations}
        values={shell.values}
        tasks={data.tasks}
        teams={shell.teams}
        enquiries={data.enquiries}
        quotes={data.quotes}
        currentUserId={shell.currentUserId}
        currentUserRole={shell.currentUserRole}
        currentUser={shell.currentUser}
        employees={shell.employees}
        keyDatesConfig={shell.keyDatesConfig}
        keyDates={data.keyDates}
        keyDateNotApplicable={data.keyDateNotApplicable}
        keyDateReminderStates={data.keyDateReminderStates}
        keyDateCalendarSyncs={data.keyDateCalendarSyncs}
        userKeyDatePermissions={shell.currentUserKeyDatePermissions}
        userPermissions={shell.currentUserPermissions}
        userRoles={shell.currentUserRoles}
        registersConfig={data.registersConfig}
        registerTypes={data.registerTypes}
        matterRegisterRecords={data.matterRegisterRecords}
        matterRegisterTransitions={data.matterRegisterTransitions}
        openingGateState={data.openingGateState}
        canViewClientCdd={data.canViewClientCdd}
        canVerifyByKeyDateId={data.canVerifyByKeyDateId}
        canTakeByTaskId={data.canTakeByTaskId}
        canViewFinance={shell.finance.canViewMatter}
        canLiftRestriction={shell.currentUserPermissions.includes(
          'matter:restriction:lift',
        )}
        canEditMatter={shell.currentUserPermissions.includes('matter:edit')}
        pmsView={data.pmsView}
        engagementDispatches={data.engagementDispatches}
        engagementChases={data.engagementChases}
        signedEngagementDownloadUrl={data.signedEngagementDownloadUrl}
        moneyOnAccountSummary={data.moneyOnAccountSummary}
        moneyOnAccountRequests={data.moneyOnAccountRequests}
        moneyOnAccountReceipts={data.moneyOnAccountReceipts}
        moneyOnAccountChases={data.moneyOnAccountChases}
        unmatchedPmsClientReceipts={data.unmatchedPmsClientReceipts}
        moaReceiptDownloadUrls={data.moaReceiptDownloadUrls}
        moneyOnAccountAgreedPence={data.moneyOnAccountAgreedPence}
        moneyOnAccountBankConfigured={data.moneyOnAccountBankConfigured}
        canViewMoneyOnAccount={data.canViewMoneyOnAccount}
        canRequestMoneyOnAccount={data.canRequestMoneyOnAccount}
        canRecordMoneyOnAccountReceipt={data.canRecordMoneyOnAccountReceipt}
        canMatchPmsClientLedgerReceipt={data.canMatchPmsClientLedgerReceipt}
        emailProviderDisabled={data.emailProviderDisabled}
        firmName={shell.firm.name}
        notes={data.notes}
        audit={data.audit}
      />
    );
  }, buildRouteReturnTo(`/matters/${encodeURIComponent(id)}`, search));
}
