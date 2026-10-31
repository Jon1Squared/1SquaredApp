import { AdminClient, type AdminTab } from '@/components/AdminClient';
import { getAppSnapshot, getCurrentUserId, getPmsAdminSnapshot } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function AdminCatchAllPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<{ list?: string; section?: string }>;
}) {
  const { slug } = await params;
  const { list, section } = await searchParams;
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);
  const pmsAdmin = getPmsAdminSnapshot();

  const first = slug?.[0];
  const initialTab: AdminTab =
    section === 'homePages' || section === 'home-pages'
      ? 'home-pages'
      : first === 'teams'
        ? 'org-structure'
        : first === 'home-pages' ||
            first === 'org-structure' ||
            first === 'rates-and-costs' ||
            first === 'custom-fields' ||
            first === 'enquiry-settings' ||
            first === 'task-settings' ||
            first === 'employees' ||
            first === 'pms-links' ||
            first === 'demo-data'
          ? first
          : 'lists';

  return (
    <AdminClient
      initialTab={initialTab}
      initialListKey={list}
      activeViewingRole={snap.activeViewingRole}
      lists={snap.lists}
      values={snap.values}
      customFields={snap.customFields}
      people={snap.people}
      organisations={snap.organisations}
      matters={snap.matters}
      teams={snap.teams}
      enquirySettings={snap.enquirySettings}
      taskSettings={snap.taskSettings}
      enquiries={snap.enquiries}
      pmsAdmin={pmsAdmin}
      homePagesConfig={snap.homePagesConfig}
      orgStructure={snap.orgStructure}
      matterPartyTaxonomy={snap.matterPartyTaxonomy}
      matterPartyMigrationReport={snap.matterPartyMigrationReport}
      matterCostsConfig={snap.matterCostsConfig}
    />
  );
}

