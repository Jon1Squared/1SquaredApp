import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { AppShell } from '@/components/AppShell';
import { LoginScreen } from '@/components/LoginScreen';
import { ToastProvider } from '@/components/Toast';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import { getEntraEnvStatus, getEntraSession } from '@/server/entraAuth';
import { getAppSnapshot, withPageActor } from '@/server/services';

const manrope = localFont({
  src: './fonts/Manrope-VariableFont_wght.woff2',
  variable: '--font-manrope',
  weight: '700 800',
  display: 'swap',
});

const sourceSans = localFont({
  src: './fonts/SourceSans3-VariableFont_wght.woff2',
  variable: '--font-source-sans',
  weight: '400 700',
  display: 'swap',
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
              entraSession={
                entraSession
                  ? {
                      email: entraSession.email,
                      displayName: entraSession.displayName,
                      oid: entraSession.oid,
                      mfaVerified: entraSession.mfaVerified,
                    }
                  : null
              }
            >
              {children}
            </AppShell>
          </ToastProvider>
        </body>
      </html>
    );
  });
}
