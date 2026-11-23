import Link from 'next/link';
import { LoginScreen } from '@/components/LoginScreen';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import { getEntraEnvStatus, getEntraSession } from '@/server/entraAuth';

export const dynamic = 'force-dynamic';

export default async function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const entraSession = await getEntraSession();
  if (!entraSession) {
    return <LoginScreen entraEnvStatus={getEntraEnvStatus()} />;
  }

  const firmDisplayName = getActiveTenantConfiguration().displayName || '1Squared';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        className="top-bar"
        style={{
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface, #fff)',
        }}
      >
        <div className="top-bar__left" style={{ gap: 16 }}>
          <Link href="/" className="brand-wordmark" style={{ textDecoration: 'none' }}>
            1Squared
          </Link>
          <span className="muted" style={{ fontSize: 13 }}>
            {firmDisplayName} · Help &amp; documentation
          </span>
        </div>
        <div className="top-bar__right">
          {entraSession.displayName ? (
            <span className="muted" style={{ fontSize: 13 }}>
              {entraSession.displayName}
            </span>
          ) : null}
          <Link href="/" className="btn btn--secondary btn--sm">
            Back to Home
          </Link>
        </div>
      </header>
      <main className="main-content" style={{ padding: '20px 24px 48px' }}>
        {children}
      </main>
    </div>
  );
}
