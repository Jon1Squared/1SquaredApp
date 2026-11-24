import { AppShell } from '@/components/AppShell';
import { LoginScreen } from '@/components/LoginScreen';
import { getEntraEnvStatus, getEntraSession } from '@/server/entraAuth';
import { loadShellContext, withCachedPageActor } from '@/server/pageLoaders';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const entraSession = await getEntraSession();

  if (!entraSession) {
    return <LoginScreen entraEnvStatus={getEntraEnvStatus()} />;
  }

  return withCachedPageActor(async (actor) => {
    const shell = await loadShellContext(actor.personId);

    return (
      <AppShell
        currentUser={shell.currentUser}
        effectiveWorkPerson={shell.effectiveWorkPerson}
        currentUserRoles={shell.currentUserRoles}
        activeViewingRole={shell.activeViewingRole}
        leftRailVisibility={shell.leftRailVisibility}
        homePagesConfig={shell.homePagesConfig}
        employees={shell.employees}
        attention={shell.attention}
        urgentTaskBadgeCount={shell.urgentTaskBadgeCount}
        notifications={shell.notifications}
        firmName={shell.firm.name}
        demoShowsWorkOfName={shell.demoShowsWorkOfName}
        entraSession={{
          email: entraSession.email,
          displayName: entraSession.displayName,
          oid: entraSession.oid,
          mfaVerified: entraSession.mfaVerified,
        }}
      >
        {children}
      </AppShell>
    );
  });
}
