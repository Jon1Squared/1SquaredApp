'use client';

import React, { Suspense } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import type { EntraEnvStatus } from '@/server/entraAuth';

function LoginCard({ entraEnvStatus }: { entraEnvStatus: EntraEnvStatus }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const authError = searchParams.get('authError');
  const signedOut = searchParams.get('signedOut') === '1';

  const returnTo =
    pathname && pathname !== '/login' && !pathname.startsWith('/api/auth')
      ? pathname
      : '/';

  const loginHref = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background:
          'radial-gradient(circle at 50% 0%, rgba(13, 92, 99, 0.10) 0%, var(--bg-canvas, #f6f7f9) 65%)',
      }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: 420,
          padding: '36px 32px',
          borderRadius: 14,
          boxShadow: '0 12px 32px rgba(15, 23, 42, 0.08)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 20,
        }}
      >
        <div
          className="logo-mark"
          aria-hidden="true"
          style={{
            width: 52,
            height: 52,
            fontSize: 22,
            marginBottom: 4,
          }}
        >
          <span className="logo-mark__tile">1</span>
          <span className="logo-mark__sq" />
        </div>

        <div>
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: '-0.02em',
              color: 'var(--text-primary)',
            }}
          >
            Sign in to 1Squared
          </h1>
          <p
            className="muted"
            style={{
              margin: '6px 0 0',
              fontSize: 13.5,
              lineHeight: 1.5,
            }}
          >
            Authenticate with your organisation&apos;s Microsoft Entra ID account to access the platform.
          </p>
        </div>

        {signedOut && !authError ? (
          <div
            role="status"
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 8,
              background: 'rgba(13, 92, 99, 0.08)',
              border: '1px solid rgba(13, 92, 99, 0.25)',
              color: 'var(--brand-teal, #0D5C63)',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            You have been signed out of 1Squared.
          </div>
        ) : null}

        {authError ? (
          <div
            role="alert"
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 8,
              background: 'rgba(220, 38, 38, 0.08)',
              border: '1px solid rgba(220, 38, 38, 0.25)',
              color: '#b91c1c',
              fontSize: 12.5,
              textAlign: 'left',
              lineHeight: 1.45,
            }}
          >
            <strong>Sign-in error:</strong> {authError}
          </div>
        ) : null}

        {!entraEnvStatus.configured ? (
          <div
            role="alert"
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 8,
              background: 'rgba(217, 119, 6, 0.08)',
              border: '1px solid rgba(217, 119, 6, 0.3)',
              color: '#b45309',
              fontSize: 12.5,
              textAlign: 'left',
              lineHeight: 1.45,
            }}
          >
            <strong>Configuration required:</strong> Set{' '}
            <code>{entraEnvStatus.missingOrPlaceholderVars.join(', ')}</code> in{' '}
            <code>.env.local</code> and restart the server.
          </div>
        ) : null}

        <a
          href={loginHref}
          className="btn btn--primary"
          style={{
            width: '100%',
            justifyContent: 'center',
            padding: '11px 16px',
            fontSize: 14,
            fontWeight: 700,
            gap: 10,
            textDecoration: 'none',
            borderRadius: 8,
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 21 21"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
          </svg>
          <span>Sign in with Microsoft</span>
        </a>

        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--text-muted)',
            marginTop: 4,
          }}
        >
          <ShieldCheck size={15} aria-hidden="true" />
          <span>Protected by Microsoft Entra ID OIDC &amp; RBAC</span>
        </div>
      </div>
    </div>
  );
}

export function LoginScreen({ entraEnvStatus }: { entraEnvStatus: EntraEnvStatus }) {
  return (
    <Suspense fallback={null}>
      <LoginCard entraEnvStatus={entraEnvStatus} />
    </Suspense>
  );
}
