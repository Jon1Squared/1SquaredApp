import { redirect } from 'next/navigation';
import { AdminClient, type AdminTab } from '@/components/AdminClient';
import { hasPersonPermission } from '@/domain/rbac';
import { getEntraEnvStatus, getEntraSession } from '@/server/entraAuth';
import { getAppSnapshot, getCurrentUserId, getPmsAdminSnapshot } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function AdminCatchAllPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<{ list?: string; section?: string; authError?: string; authSuccess?: string }>;
}) {
  const { slug } = await params;
  const { list, section, authError, authSuccess } = await searchParams;
  const entraSession = await getEntraSession();
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);

  const canAccessAdmin = hasPersonPermission(snap.currentUser, 'admin:access', {
    allPeople: snap.people,
    teams: snap.teams,
    mfaVerified: entraSession?.mfaVerified ?? false,
    enforceMfa: true,
  });
  if (!canAccessAdmin) {
    redirect('/');
  }

  const pmsAdmin = getPmsAdminSnapshot();
  const entraEnvStatus = getEntraEnvStatus();

  const first = slug?.[0];
  const initialTab: AdminTab =
    section === 'homePages' || section === 'home-pages'
      ? 'home-pages'
      : first === 'teams'
        ? 'org-structure'
        : first === 'home-pages' ||
            first === 'rbac-and-entra' ||
            first === 'org-structure' ||
            first === 'rates-and-costs' ||
            first === 'document-templates' ||
            first === 'key-dates' ||
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
      currentUserId={snap.currentUserId}
      currentUserPermissions={snap.currentUserPermissions}
      rbacConfig={snap.rbacConfig}
      keyDatesConfig={snap.keyDatesConfig}
      currentUserKeyDatePermissions={snap.currentUserKeyDatePermissions}
      entraSession={entraSession}
      entraEnvStatus={entraEnvStatus}
      authError={authError}
      authSuccess={authSuccess === '1'}
    />
  );
}

