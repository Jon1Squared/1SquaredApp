import React from 'react';
import { notFound } from 'next/navigation';
import { isActionDenied } from '@/domain/actionResult';
import {
  getAppSnapshot,
  getMatterKeyDatesSnapshot,
  getMatterPmsViewBundle,
  listAuditEntriesForRecord,
  recordRecentlyViewed,
  withPageActor,
} from '@/server/services';
import { MatterFormClient } from '@/components/MatterFormClient';
import { MatterProfileClient } from '@/components/MatterProfileClient';

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
  return withPageActor(async (actor) => {
    const userId = actor.personId;
    const snap = await getAppSnapshot(userId);
    const matter = snap.matters.find((m) => m.id === id);
    if (!matter) notFound();

    await recordRecentlyViewed(userId, matter.id);

    if (
      matter.matterNumber === 'DRAFT' ||
      matter.conflictCheckStatus === 'Draft' ||
      (matter.conflictCheckStatus === 'Pending conflict review' && !search.tab)
    ) {
      const linkedQuote = matter.sourceQuoteId
        ? snap.quotes.find((q) => q.id === matter.sourceQuoteId) ?? null
        : snap.quotes.find((q) => q.convertedMatterId === matter.id) ?? null;
      const linkedEnquiry = matter.sourceEnquiryId
        ? snap.enquiries.find((e) => e.id === matter.sourceEnquiryId) ?? null
        : snap.enquiries.find(
            (e) => e.convertedMatterId === matter.id || e.id === linkedQuote?.linkedEnquiryId,
          ) ?? null;
      return (
        <MatterFormClient
          existing={matter}
          initialEnquiry={linkedEnquiry}
          initialQuote={linkedQuote}
          isReopenedDraft={
            matter.matterNumber === 'DRAFT' || matter.conflictCheckStatus === 'Draft'
          }
          activeViewingRole={snap.activeViewingRole}
          people={snap.people}
          organisations={snap.organisations}
          links={snap.links}
          matters={snap.matters}
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
          enableAiMatterExtraction={snap.enableAiMatterExtraction}
          aiProviderChoice={snap.aiProviderChoice}
          enableMatterCostsGovernance={snap.enableMatterCostsGovernance}
          tenantId={snap.tenantId}
        />
      );
    }

    const pmsViewRes = snap.finance.canViewMatter
      ? await getMatterPmsViewBundle(matter.id, userId)
      : null;
    const pmsView =
      pmsViewRes && !isActionDenied(pmsViewRes) ? pmsViewRes : undefined;
    const [matterKeyDates, matterAudit] = await Promise.all([
      getMatterKeyDatesSnapshot(matter.id, userId),
      listAuditEntriesForRecord('matter', matter.id, userId, { limit: 200 }),
    ]);

    return (
      <MatterProfileClient
        matter={matter}
        initialTab={search.tab}
        people={snap.people}
        organisations={snap.organisations}
        values={snap.values}
        tasks={snap.tasks}
        teams={snap.teams}
        enquiries={snap.enquiries}
        quotes={snap.quotes}
        currentUserId={snap.currentUserId}
        currentUserRole={snap.currentUserRole}
        currentUser={snap.currentUser}
        employees={snap.employees}
        keyDatesConfig={snap.keyDatesConfig}
        keyDates={matterKeyDates.keyDates}
        keyDateNotApplicable={matterKeyDates.keyDateNotApplicable}
        keyDateReminderStates={matterKeyDates.keyDateReminderStates}
        keyDateCalendarSyncs={matterKeyDates.keyDateCalendarSyncs}
        userKeyDatePermissions={snap.currentUserKeyDatePermissions}
        canVerifyByKeyDateId={matterKeyDates.canVerifyByKeyDateId}
        canTakeByTaskId={snap.canTakeByTaskId}
        canViewFinance={snap.finance.canViewMatter}
        canLiftRestriction={snap.currentUserPermissions.includes('matter:restriction:lift')}
        pmsView={pmsView}
        notes={snap.notes.filter((n) => n.recordType === 'matter' && n.recordId === matter.id)}
        audit={matterAudit}
      />
    );
  });
}

