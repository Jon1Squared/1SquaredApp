import { notFound } from 'next/navigation';
import { QuoteDetailClient } from '@/components/QuoteDetailClient';
import { isActionDenied } from '@/domain/actionResult';
import {
  getAppSnapshot,
  recordRecentlyViewed,
  resolveApplicableRatesRecord,
  withPageActor,
} from '@/server/services';

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
  return withPageActor(async (actor) => {
    const userId = actor.personId;
    const snap = await getAppSnapshot(userId);

    const quote = snap.quotes.find((q) => q.id === id || q.reference === id);
    if (!quote) {
      notFound();
    }

    await recordRecentlyViewed(userId, quote.id);

    const rateClientId = quote.linkedOrganisationId ?? quote.linkedPersonId ?? null;
    const rateClientType = quote.linkedOrganisationId
      ? 'organisation'
      : quote.linkedPersonId
        ? 'person'
        : null;
    const ratesRes = await resolveApplicableRatesRecord(
      {
        clientId: rateClientId,
        clientType: rateClientType,
        practiceAreaId: quote.practiceAreaId,
      },
      userId,
    );

    return (
      <QuoteDetailClient
        quote={quote}
        initialResolvedRates={
          ratesRes && !isActionDenied(ratesRes) ? (ratesRes.resolved ?? null) : null
        }
        enquiries={snap.enquiries}
        matters={snap.matters}
        people={snap.people}
        organisations={snap.organisations}
        links={snap.links}
        values={snap.values}
        orgStructure={snap.orgStructure}
        currentUserId={snap.currentUserId}
        tenantId={snap.tenantId}
        tenantVatRatePercent={snap.matterCostsConfig.vatRatePercent}
        workTypesConfig={snap.workTypesConfig}
        firmFeeArrangementCaps={snap.matterCostsConfig.feeArrangementCaps}
        initialAction={sp.action ?? null}
      />
    );
  });
}
