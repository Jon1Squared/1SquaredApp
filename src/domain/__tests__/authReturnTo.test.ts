import { describe, expect, it } from 'vitest';
import {
  buildLoginRedirectPath,
  sanitizeReturnToPath,
} from '../authReturnTo';

describe('Suggestion 9: /login returnTo sanitization', () => {
  it('preserves valid same-origin paths with query strings and hashes', () => {
    expect(sanitizeReturnToPath('/')).toBe('/');
    expect(sanitizeReturnToPath('/matters')).toBe('/matters');
    expect(sanitizeReturnToPath('/matters/M-000001?tab=costs#summary')).toBe(
      '/matters/M-000001?tab=costs#summary',
    );
    expect(
      sanitizeReturnToPath('/enquiries?q=lease&page=2', 'https://app.example'),
    ).toBe('/enquiries?q=lease&page=2');
  });

  it('rejects open-redirect payloads, backslashes, control characters, and auth loops', () => {
    expect(sanitizeReturnToPath(null)).toBe('/');
    expect(sanitizeReturnToPath('')).toBe('/');
    expect(sanitizeReturnToPath('   ')).toBe('/');
    expect(sanitizeReturnToPath('https://evil.com/matters')).toBe('/');
    expect(sanitizeReturnToPath('http://evil.com')).toBe('/');
    expect(sanitizeReturnToPath('//evil.com/matters')).toBe('/');
    expect(sanitizeReturnToPath('/\\evil.com')).toBe('/');
    expect(sanitizeReturnToPath('///evil.com')).toBe('/');
    expect(sanitizeReturnToPath('javascript:alert(1)')).toBe('/');
    expect(sanitizeReturnToPath('/matters\r\nLocation: https://evil.com')).toBe('/');
    expect(sanitizeReturnToPath('/login')).toBe('/');
    expect(sanitizeReturnToPath('/login?returnTo=/matters')).toBe('/');
    expect(sanitizeReturnToPath('/api/auth/login')).toBe('/');
    expect(sanitizeReturnToPath('/api/auth/callback/microsoft-entra-id')).toBe('/');
  });

  it('builds /login redirect URLs only for safe non-root targets', () => {
    expect(buildLoginRedirectPath(undefined)).toBe('/login');
    expect(buildLoginRedirectPath('/')).toBe('/login');
    expect(buildLoginRedirectPath('//evil.com')).toBe('/login');
    expect(buildLoginRedirectPath('/login?foo=1')).toBe('/login');
    expect(buildLoginRedirectPath('/matters/M-000001?tab=tasks')).toBe(
      '/login?returnTo=%2Fmatters%2FM-000001%3Ftab%3Dtasks',
    );
  });
});
