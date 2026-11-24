import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { ToastProvider } from '@/components/Toast';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={`${manrope.variable} ${sourceSans.variable}`}>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
