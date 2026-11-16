import Link from 'next/link';
import { RegistersWorkspaceClient } from '@/components/RegistersWorkspaceClient';
import { isActionDenied } from '@/domain/actionResult';
import {
  getAppSnapshot,
  listRegistersWorkspaceDataRecord,
  withPageActor,
} from '@/server/services';

export const dynamic = 'force-dynamic';

export default async function RegistersPage({
  searchParams,
}: {
  searchParams: Promise<{ record?: string; type?: string }>;
}) {
  const { record, type } = await searchParams;
  return withPageActor(async (actor) => {
    const userId = actor.personId;
    const snap = await getAppSnapshot(userId);
    const data = await listRegistersWorkspaceDataRecord({}, userId);

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
        currentUserId={userId}
        userPermissions={snap.currentUserPermissions}
        registerTypes={data.registerTypes}
        registersConfig={data.registersConfig}
        initialRecords={data.records}
        initialTransitionsByRecordId={data.transitionsByRecordId}
        matters={data.matters}
        people={data.people}
        initialRecordId={record}
        initialTypeKey={type}
      />
    );
  });
}
