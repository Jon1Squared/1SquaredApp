import { PersonFormClient } from '@/components/PersonFormClient';
import { loadPersonFormPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function NewPersonPage() {
  return withOptionalPageActor(async (actor) => {
    const data = await loadPersonFormPageData(actor.personId);
    if (!data || 'redirectTo' in data) return null;
    const { shell } = data;

    return (
      <PersonFormClient
        allPeople={shell.employees}
        organisations={data.organisations}
        matters={data.matters}
        enquiries={data.enquiries}
        employees={shell.employees}
        lists={shell.lists}
        values={shell.values}
        customFields={shell.customFields}
        currentUserId={shell.currentUserId}
        orgStructure={shell.orgStructure}
        currentUserEmployeePermissions={shell.currentUserEmployeePermissions}
        leaverOwnedRecords={data.leaverOwnedRecords}
        firmPrimaryDomain={shell.firmPrimaryDomain}
        firmName={shell.firm.name}
        tenantId={shell.tenantId}
      />
    );
  }, '/people/new');
}
