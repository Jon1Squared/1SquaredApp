import { notFound } from 'next/navigation';
import { QuoteDetailClient } from '@/components/QuoteDetailClient';
import { buildRouteReturnTo } from '@/domain/authReturnTo';
import { loadQuoteDetailPageData, withOptionalPageActor } from '@/server/pageLoaders';
import { recordRecentlyViewed } from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function QuoteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ action?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  return withOptionalPageActor(async (actor) => {
    const data = await loadQuoteDetailPageData(actor.personId, id);
    if (!data) notFound();

    const { shell, quote } = data;
    await recordRecentlyViewed(actor.personId, quote.id);

    return (
      <QuoteDetailClient
        quote={quote}
        initialResolvedRates={data.initialResolvedRates}
        enquiries={data.enquiries}
        matters={data.matters}
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
        initialAction={sp.action ?? null}
        quoteChases={data.quoteChases}
        emailProviderDisabled={data.emailProviderDisabled}
      />
    );
  }, buildRouteReturnTo(`/quotes/${encodeURIComponent(id)}`, sp));
}
