import { notFound, redirect } from 'next/navigation';
import { PersonProfileClient } from '@/components/PersonProfileClient';
import { loadPersonDetailPageData, withOptionalPageActor } from '@/server/pageLoaders';
import { recordRecentlyViewed } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function PersonProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; mergedFrom?: string }>;
}) {
  const { id } = await params;
  const { tab, mergedFrom } = await searchParams;
  return withOptionalPageActor(async (actor) => {
    const data = await loadPersonDetailPageData(actor.personId, id);
    if (!data) notFound();
    if ('redirectTo' in data) {
      if (!id.startsWith('ENQ-') && data.redirectTo.startsWith('/people/')) {
        redirect(`${data.redirectTo}?mergedFrom=${id}`);
      }
      redirect(data.redirectTo);
    }

    const { shell, person } = data;
    await recordRecentlyViewed(actor.personId, person.id);

    return (
      <PersonProfileClient
        person={person}
        allPeople={data.allPeople}
        organisations={data.organisations}
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
        rateCustomGrades={data.rateCustomGrades}
        values={shell.values}
        customFields={shell.customFields}
        notes={data.notes}
        audit={data.audit}
        merges={data.merges}
        duplicateCandidates={data.duplicateCandidates}
        mergedFromId={mergedFrom ?? null}
        initialTab={tab}
        firmName={shell.firm.name}
        orgStructure={shell.orgStructure}
        canViewPayroll={data.canViewPayroll}
        canViewOwnNotificationPreferences={data.canViewOwnNotificationPreferences}
        canManageOwnNotificationPreferences={data.canManageOwnNotificationPreferences}
        initialNotificationPreferences={data.initialNotificationPreferences}
      />
    );
  });
}
