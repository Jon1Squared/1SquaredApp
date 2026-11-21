import { describe, expect, it, vi } from 'vitest';
import { getGlobalTenantPostgresPoolManager } from '@platform/core';

describe('Health & readiness endpoints (R580)', () => {
  it('R580: GET /api/health/live responds 200 without DB queries or tenant data', async () => {
    const liveMod = (await import('@/app/api/health/live/route')) as {
      GET: (req: Request) => Promise<Response>;
    };
    const res = await liveMod.GET(new Request('http://localhost:3000/api/health/live'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'live' });
  });

  it('R580: GET /api/health/ready verifies PostgreSQL pool & schema readiness, exposes zero tenant data, and fails 503 if unhealthy or live local-fs', async () => {
    const readyMod = (await import('@/app/api/health/ready/route')) as {
      GET: (req: Request) => Promise<Response>;
    };

    const okRes = await readyMod.GET(
      new Request('http://localhost:3000/api/health/ready'),
    );
    expect(okRes.status).toBe(200);
    const rawOk = await okRes.text();
    const okJson = JSON.parse(rawOk) as Record<string, unknown>;
    expect(okJson).toEqual({ status: 'ready' });
    expect(rawOk).not.toContain('not-a-law-firm');
    expect(rawOk).not.toContain('pg_tenant_');

    // Simulate unreachable database -> 503 not_ready with no details leaked
    const poolMgr = getGlobalTenantPostgresPoolManager();
    const poolSpy = vi
      .spyOn(poolMgr, 'getPoolForTenant')
      .mockRejectedValueOnce(new Error('DB_UNREACHABLE'));
    try {
      const failRes = await readyMod.GET(
        new Request('http://localhost:3000/api/health/ready'),
      );
      expect(failRes.status).toBe(503);
      const rawFail = await failRes.text();
      expect(JSON.parse(rawFail)).toEqual({ status: 'not_ready' });
      expect(rawFail).not.toContain('DB_UNREACHABLE');
    } finally {
      poolSpy.mockRestore();
    }

    // When environment is 'live' and storageProvider is 'local-fs', ready returns 503 not_ready
    vi.stubEnv('PLATFORM_ENVIRONMENT', 'live');
    try {
      const liveLocalFsRes = await readyMod.GET(
        new Request('http://localhost:3000/api/health/ready'),
      );
      expect(liveLocalFsRes.status).toBe(503);
      expect(await liveLocalFsRes.json()).toEqual({ status: 'not_ready' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
