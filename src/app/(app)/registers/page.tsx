import Link from 'next/link';
import { RegistersWorkspaceClient } from '@/components/RegistersWorkspaceClient';
import { isActionDenied } from '@/domain/actionResult';
import { buildRouteReturnTo } from '@/domain/authReturnTo';
import { loadRegistersPageData, withOptionalPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function RegistersPage({
  searchParams,
}: {
  searchParams: Promise<{ record?: string; type?: string }>;
}) {
  const resolvedSearch = await searchParams;
  const { record, type } = resolvedSearch;
  return withOptionalPageActor(async (actor) => {
    const { shell, data, clientLabelsById } = await loadRegistersPageData(actor.personId);

    if (isActionDenied(data) || !data.ok) {
      return (
        <section className="home-panel" style={{ margin: 24 }}>
          <div className="panel-header">
            <h1 className="panel-title">Firm registers &amp; undertakings</h1>
          </div>
          <div className="panel-body padded">
            <p className="muted">
              {data.message || 'You do not have permission to view firm registers.'}
            </p>
            <Link href="/" className="btn btn--secondary btn--sm">
              Return to Home
            </Link>
          </div>
        </section>
      );
    }

    return (
      <RegistersWorkspaceClient
        currentUserId={shell.currentUserId}
        userPermissions={shell.currentUserPermissions}
        registerTypes={data.registerTypes}
        registersConfig={data.registersConfig}
        initialRecords={data.records}
        initialTransitionsByRecordId={data.transitionsByRecordId}
        matters={data.matters}
        people={data.people}
        clientLabelsById={clientLabelsById}
        initialRecordId={record}
        initialTypeKey={type}
      />
    );
  }, buildRouteReturnTo('/registers', resolvedSearch));
}
