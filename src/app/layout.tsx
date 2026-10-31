import type { Metadata } from 'next';
import { Manrope, Source_Sans_3 } from 'next/font/google';
import './globals.css';
import { AppShell } from '@/components/AppShell';
import { ToastProvider } from '@/components/Toast';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';

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

export const metadata: Metadata = {
  title: '1Squared · Not A Law Firm LLP',
  description: 'People & Organisations · Client inception, relationships and risk management',
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);

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
          >
            {children}
          </AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
