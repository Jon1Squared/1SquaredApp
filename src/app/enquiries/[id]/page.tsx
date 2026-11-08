import { notFound } from 'next/navigation';
import { EnquiryFormClient } from '@/components/EnquiryFormClient';
import { KeyDatesPanel } from '@/components/KeyDatesPanel';
import {
  getAppSnapshot,
  recordRecentlyViewed,
  withPageActor,
} from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function EnquiryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return withPageActor(async (actor) => {
    const userId = actor.personId;
    const snap = getAppSnapshot(userId);
    const enquiry = snap.enquiries.find((e) => e.id === id);
    if (!enquiry) notFound();

    recordRecentlyViewed(userId, enquiry.id);

    const audit = snap.audit.filter(
      (a) => a.recordType === 'enquiry' && a.recordId === enquiry.id,
    );

    return (
      <div>
        <EnquiryFormClient
          mode={enquiry.status === 'Draft' ? 'draft' : 'saved'}
          enquiry={enquiry}
          quotes={snap.quotes}
          tasks={snap.tasks}
          audit={audit}
          people={snap.people}
          organisations={snap.organisations}
          matters={snap.matters}
          enquiries={snap.enquiries}
          teams={snap.teams}
          values={snap.values}
          customFields={snap.customFields}
          enquirySettings={snap.enquirySettings}
          currentUserId={snap.currentUserId}
          canReopen={Boolean(snap.canReopenByEnquiryId[enquiry.id])}
          canAnonymise={snap.currentUserPermissions.includes('enquiry:anonymise')}
          firmName={snap.firm.name}
          tenantId={snap.tenantId}
        />
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '0 24px 32px' }}>
          <KeyDatesPanel
            enquiry={enquiry}
            config={snap.keyDatesConfig}
            keyDates={snap.keyDates}
            reminderStates={snap.keyDateReminderStates}
            calendarSyncs={snap.keyDateCalendarSyncs}
            currentUser={snap.currentUser}
            userPermissions={snap.currentUserKeyDatePermissions}
            canVerifyByKeyDateId={snap.canVerifyByKeyDateId}
            teams={snap.teams}
            employees={snap.employees}
          />
        </div>
      </div>
    );
  });
}
