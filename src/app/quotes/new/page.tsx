import { notFound } from 'next/navigation';
import { QuoteFormClient } from '@/components/QuoteFormClient';
import { isActionDenied } from '@/domain/actionResult';
import {
  getAppSnapshot,
  resolveApplicableRatesRecord,
  withPageActor,
} from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ enquiryId?: string }>;
}) {
  const sp = await searchParams;
  return withPageActor(async (actor) => {
    const snap = await getAppSnapshot(actor.personId);
    if (
      !snap.currentUserPermissions.includes('quote:view') ||
      !snap.currentUserPermissions.includes('quote:edit')
    ) {
      notFound();
    }

    const initialEnquiry = sp.enquiryId
      ? snap.enquiries.find((e) => e.id === sp.enquiryId) ?? null
      : null;
    const rateClientId =
      initialEnquiry?.linkedOrganisationId ?? initialEnquiry?.linkedPersonId ?? null;
    const rateClientType = initialEnquiry?.linkedOrganisationId
      ? 'organisation'
      : initialEnquiry?.linkedPersonId
        ? 'person'
        : null;
    const ratesRes =
      rateClientId || initialEnquiry?.practiceAreaId
        ? await resolveApplicableRatesRecord(
            {
              clientId: rateClientId,
              clientType: rateClientType,
              practiceAreaId: initialEnquiry?.practiceAreaId ?? null,
            },
            actor.personId,
          )
        : null;

    return (
      <QuoteFormClient
        mode="new"
        initialEnquiry={initialEnquiry}
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
      />
    );
  });
}
