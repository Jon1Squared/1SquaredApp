import type { Metadata } from 'next';
import { Manrope, Source_Sans_3 } from 'next/font/google';
import './globals.css';
import { AppShell } from '@/components/AppShell';
import { LoginScreen } from '@/components/LoginScreen';
import { ToastProvider } from '@/components/Toast';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import { getEntraEnvStatus, getEntraSession } from '@/server/entraAuth';
import { getAppSnapshot, withPageActor } from '@/server/services';

const manrope = Manrope({
  variable: '--font-manrope',
  subsets: ['latin', 'latin-ext'],
  weight: ['700', '800'],
});

const sourceSans = Source_Sans_3({
  variable: '--font-source-sans',
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '600', '700'],
});

export async function generateMetadata(): Promise<Metadata> {
  const displayName = getActiveTenantConfiguration().displayName;
  return {
    title: displayName ? `1Squared · ${displayName}` : '1Squared',
    description:
      'People & Organisations · Client inception, relationships and risk management',
  };
}

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const entraSession = await getEntraSession();

  if (!entraSession) {
    const entraEnvStatus = getEntraEnvStatus();
    return (
      <html lang="en-GB" className={`${manrope.variable} ${sourceSans.variable}`}>
        <body>
          <LoginScreen entraEnvStatus={entraEnvStatus} />
        </body>
      </html>
    );
  }

  return withPageActor(async (actor) => {
    const snap = getAppSnapshot(actor.personId);

    return (
      <html lang="en-GB" className={`${manrope.variable} ${sourceSans.variable}`}>
        <body>
          <ToastProvider>
            <AppShell
              currentUser={snap.currentUser}
              effectiveWorkPerson={snap.effectiveWorkPerson}
              currentUserRoles={snap.currentUserRoles}
              activeViewingRole={snap.activeViewingRole}
              leftRailVisibility={snap.leftRailVisibility}
              homePagesConfig={snap.homePagesConfig}
              employees={snap.employees}
              searchIndex={snap.searchIndex}
              attention={snap.attention}
              tasks={snap.tasks}
              notifications={snap.notifications}
              firmName={snap.firm.name}
              entraSession={entraSession}
            >
              {children}
            </AppShell>
          </ToastProvider>
        </body>
      </html>
    );
  });
}
