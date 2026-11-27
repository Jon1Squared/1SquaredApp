import { notFound } from 'next/navigation';
import { QuoteFormClient } from '@/components/QuoteFormClient';
import { buildRouteReturnTo } from '@/domain/authReturnTo';
import { loadQuoteFormPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ enquiryId?: string }>;
}) {
  const sp = await searchParams;
  return withOptionalPageActor(async (actor) => {
    const data = await loadQuoteFormPageData(actor.personId, sp.enquiryId);
    if (!data) notFound();
    const { shell } = data;

    return (
      <QuoteFormClient
        mode="new"
        initialEnquiry={data.initialEnquiry}
        initialResolvedRates={data.initialResolvedRates}
        enquiries={data.enquiries}
        matters={[]}
        people={data.people}
        organisations={data.organisations}
        links={data.links}
        values={shell.values}
        orgStructure={shell.orgStructure}
        currentUserId={shell.currentUserId}
        tenantId={shell.tenantId}
        tenantVatRatePercent={shell.store.matterCostsConfig.vatRatePercent}
        workTypesConfig={shell.store.workTypesConfig}
        firmFeeArrangementCaps={shell.store.matterCostsConfig.feeArrangementCaps}
        emailProviderDisabled={data.emailProviderDisabled}
      />
    );
  }, buildRouteReturnTo('/quotes/new', sp));
}
