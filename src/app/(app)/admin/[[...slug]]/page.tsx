import { redirect } from 'next/navigation';
import { AdminClient } from '@/components/AdminClient';
import { buildRouteReturnTo } from '@/domain/authReturnTo';
import { loadAdminPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function AdminCatchAllPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<{
    list?: string;
    section?: string;
    authError?: string;
    authSuccess?: string;
    auditBeforeSeq?: string;
    beforeSeq?: string;
  }>;
}) {
  const { slug } = await params;
  const resolvedSearch = await searchParams;
  const { list, section, authError, authSuccess, auditBeforeSeq, beforeSeq } =
    resolvedSearch;
  const basePath = slug?.length
    ? `/admin/${slug.map(encodeURIComponent).join('/')}`
    : '/admin';

  return withOptionalPageActor(async (actor) => {
    const data = await loadAdminPageData(actor.personId, {
      slug,
      section,
      auditBeforeSeq,
      beforeSeq,
      mfaVerified: actor.mfaVerified,
    });
    if ('redirectTo' in data) {
      redirect(data.redirectTo);
    }

    const { shell } = data;
    return (
      <AdminClient
        initialTab={data.initialTab}
        initialListKey={list}
        activeViewingRole={shell.activeViewingRole}
        lists={data.lists}
        values={data.values}
        customFields={data.customFields}
        people={data.people}
        organisations={data.organisations}
        matters={data.matters}
        teams={data.teams}
        enquirySettings={data.enquirySettings}
        taskSettings={data.taskSettings}
        enquiries={data.enquiries}
        pmsAdmin={data.pmsAdmin}
        initialPmsLinksData={data.initialPmsLinksData}
        expiredUnconvertedEnquiriesCount={data.expiredUnconvertedEnquiriesCount}
        matterPartyUsageCounts={data.matterPartyUsageCounts}
        isLiveEnvironment={data.isLiveEnvironment}
        homePagesConfig={shell.homePagesConfig}
        defaultRoleConfigs={data.defaultRoleConfigs}
        orgStructure={data.orgStructure}
        matterPartyTaxonomy={data.matterPartyTaxonomy}
        matterPartyMigrationReport={data.matterPartyMigrationReport}
        matterCostsConfig={data.matterCostsConfig}
        enableMatterCostsGovernance={shell.enableMatterCostsGovernance}
        enablePmsLiveRateSync={shell.enablePmsLiveRateSync}
        currentUserId={shell.currentUserId}
        currentUserPermissions={shell.currentUserPermissions}
        appRoleByPersonId={data.appRoleByPersonId}
        rolesByPersonId={data.rolesByPersonId}
        permissionsByPersonId={data.permissionsByPersonId}
        rbacConfig={shell.rbacConfig}
        keyDatesConfig={shell.keyDatesConfig}
        currentUserKeyDatePermissions={shell.currentUserKeyDatePermissions}
        registersConfig={data.registersConfig}
        registerTypes={data.registerTypes}
        cddConfig={data.cddConfig}
        workTypesConfig={data.workTypesConfig}
        matterNumberingConfig={data.matterNumberingConfig}
        effectiveChasingConfig={data.effectiveChasingConfig}
        effectiveEngagementConfig={data.effectiveEngagementConfig}
        effectiveMoneyOnAccountConfig={data.effectiveMoneyOnAccountConfig}
        emailProviderDisabled={data.emailProviderDisabled}
        hasMfaVerified={actor.mfaVerified}
        entraSession={actor.session}
        entraEnvStatus={data.entraEnvStatus}
        firmAuditPage={data.firmAuditPage}
        firmName={shell.firm.name}
        authError={authError}
        authSuccess={authSuccess === '1'}
      />
    );
  }, buildRouteReturnTo(basePath, resolvedSearch));
}
