import { EnquiryFormClient } from '@/components/EnquiryFormClient';
import { loadEnquiryFormPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function NewEnquiryPage() {
  return withOptionalPageActor(async (actor) => {
    const { shell } = await loadEnquiryFormPageData(actor.personId);

    return (
      <EnquiryFormClient
        people={shell.employees}
        organisations={[]}
        matters={[]}
        enquiries={[]}
        teams={shell.teams}
        values={shell.values}
        orgStructure={shell.orgStructure}
        customFields={shell.customFields}
        enquirySettings={shell.store.enquirySettings}
        currentUserId={shell.currentUserId}
        firmName={shell.firm.name}
        tenantId={shell.tenantId}
      />
    );
  });
}
