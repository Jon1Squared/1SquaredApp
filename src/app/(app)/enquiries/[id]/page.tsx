import { notFound } from 'next/navigation';
import { EnquiryFormClient } from '@/components/EnquiryFormClient';
import { KeyDatesPanel } from '@/components/KeyDatesPanel';
import { loadEnquiryDetailPageData, withOptionalPageActor } from '@/server/pageLoaders';
import { recordRecentlyViewed } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function EnquiryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return withOptionalPageActor(async (actor) => {
    const data = await loadEnquiryDetailPageData(actor.personId, id);
    if (!data) notFound();

    const { shell, enquiry } = data;
    await recordRecentlyViewed(actor.personId, enquiry.id);

    return (
      <div>
        <EnquiryFormClient
          mode={enquiry.status === 'Draft' ? 'draft' : 'saved'}
          enquiry={enquiry}
          quotes={data.quotes}
          tasks={data.tasks}
          audit={data.audit}
          people={data.people}
          organisations={data.organisations}
          matters={data.matters}
          enquiries={[enquiry]}
          teams={shell.teams}
          values={shell.values}
          orgStructure={shell.orgStructure}
          customFields={shell.customFields}
          enquirySettings={shell.store.enquirySettings}
          currentUserId={shell.currentUserId}
          canReopen={data.canReopen}
          canAnonymise={data.canAnonymise}
          nonEngagementDispatches={data.nonEngagementDispatches}
          emailProviderDisabled={data.emailProviderDisabled}
          canSendNonEngagement={data.canSendNonEngagement}
          firmName={shell.firm.name}
          tenantId={shell.tenantId}
          supervisingPartnerByEmployeeId={shell.supervisingPartnerByEmployeeId}
        />
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '0 24px 32px' }}>
          <KeyDatesPanel
            enquiry={enquiry}
            config={shell.keyDatesConfig}
            keyDates={data.keyDates}
            reminderStates={data.keyDateReminderStates}
            calendarSyncs={data.keyDateCalendarSyncs}
            currentUser={shell.currentUser}
            userPermissions={shell.currentUserKeyDatePermissions}
            canVerifyByKeyDateId={data.canVerifyByKeyDateId}
            teams={shell.teams}
            employees={shell.employees}
          />
        </div>
      </div>
    );
  }, `/enquiries/${encodeURIComponent(id)}`);
}
