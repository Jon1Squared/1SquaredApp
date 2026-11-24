import { notFound, redirect } from 'next/navigation';
import { OrganisationProfileClient } from '@/components/OrganisationProfileClient';
import { buildRouteReturnTo } from '@/domain/authReturnTo';
import {
  loadOrganisationDetailPageData,
  withOptionalPageActor,
} from '@/server/pageLoaders';
import { recordRecentlyViewed } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function OrganisationProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; mergedFrom?: string }>;
}) {
  const { id } = await params;
  const resolvedSearch = await searchParams;
  const { tab, mergedFrom } = resolvedSearch;
  return withOptionalPageActor(async (actor) => {
    const data = await loadOrganisationDetailPageData(actor.personId, id);
    if (!data) notFound();
    if ('redirectTo' in data) {
      redirect(`${data.redirectTo}?mergedFrom=${id}`);
    }

    const { shell, organisation } = data;
    await recordRecentlyViewed(actor.personId, organisation.id);

    return (
      <OrganisationProfileClient
        organisation={organisation}
        allOrganisations={data.allOrganisations}
        people={data.people}
        links={data.links}
        matters={data.matters}
        tasks={data.tasks}
        teams={shell.teams}
        enquiries={data.enquiries}
        currentUserId={shell.currentUserId}
        currentUserRole={shell.currentUserRole}
        canTakeByTaskId={data.canTakeByTaskId}
        canViewFinance={shell.finance.canViewMatter}
        pmsView={data.pmsView}
        canViewNegotiatedRates={data.canViewNegotiatedRates}
        canManageNegotiatedRates={data.canManageNegotiatedRates}
        clientRateOverrides={data.clientRateOverrides}
        parentRateChain={data.parentRateChain}
        inheritedParentRateOverrides={data.inheritedParentRateOverrides}
        rateCustomGrades={data.rateCustomGrades}
        values={shell.values}
        customFields={shell.customFields}
        notes={data.notes}
        audit={data.audit}
        merges={data.merges}
        duplicateCandidates={data.duplicateCandidates}
        mergedFromId={mergedFrom ?? null}
        initialTab={tab}
      />
    );
  }, buildRouteReturnTo(`/organisations/${encodeURIComponent(id)}`, resolvedSearch));
}
