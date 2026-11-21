import { describe, expect, it, vi } from 'vitest';
import { getGlobalTenantPostgresPoolManager } from '@platform/core';
import { resetHealthReadinessCacheForTesting } from '@/server/healthReadiness';

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
    resetHealthReadinessCacheForTesting();
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
    resetHealthReadinessCacheForTesting();
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
      resetHealthReadinessCacheForTesting();
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
      resetHealthReadinessCacheForTesting();
    }
  });

  it('R612: deduplicates 50 concurrent /api/health/ready requests into at most one DB probe, caches within 5s TTL, and logs failures with correlationId and no PII', async () => {
    resetHealthReadinessCacheForTesting();
    const readyMod = (await import('@/app/api/health/ready/route')) as {
      GET: (req: Request) => Promise<Response>;
    };
    const poolMgr = getGlobalTenantPostgresPoolManager();
    const origGetPool = poolMgr.getPoolForTenant.bind(poolMgr);
    let poolLookups = 0;
    const poolSpy = vi
      .spyOn(poolMgr, 'getPoolForTenant')
      .mockImplementation(async (ctx) => {
        poolLookups += 1;
        await new Promise((r) => setTimeout(r, 40));
        return origGetPool(ctx);
      });

    try {
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, idx) =>
          readyMod.GET(
            new Request(`http://localhost:3000/api/health/ready?r=${idx}`),
          ),
        ),
      );
      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(poolLookups).toBe(1);

      // Subsequent call within 5s TTL serves cached readiness without extra DB probe
      const callsAfterBurst = poolLookups;
      const cachedRes = await readyMod.GET(
        new Request('http://localhost:3000/api/health/ready?r=cached'),
      );
      expect(cachedRes.status).toBe(200);
      expect(poolLookups).toBe(callsAfterBurst);
    } finally {
      poolSpy.mockRestore();
      resetHealthReadinessCacheForTesting();
    }

    // Fresh failure test: spy on warn to confirm PII-free health.readiness_failed log with exact correlationId
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failSpy = vi
      .spyOn(poolMgr, 'getPoolForTenant')
      .mockRejectedValue(new Error('postgresql://user:secret@host/db_down'));
    try {
      const failRes = await readyMod.GET(
        new Request('http://localhost:3000/api/health/ready', {
          headers: { 'x-correlation-id': 'corr-r612-probe' },
        }),
      );
      expect(failRes.status).toBe(503);
      const logs = warnSpy.mock.calls
        .map((c) => String(c[0] ?? ''))
        .filter((line) => line.includes('health.readiness_failed'));
      expect(logs.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(logs[0]!) as {
        correlationId?: string;
        tenantId?: string;
      };
      expect(parsed.correlationId).toBe('corr-r612-probe');
      expect(parsed.tenantId).toBeTruthy();
      expect(logs[0]).not.toContain('secret');
      expect(logs[0]).not.toContain('postgresql://');
    } finally {
      failSpy.mockRestore();
      warnSpy.mockRestore();
      resetHealthReadinessCacheForTesting();
    }

    // Test-reset helper refuses non-test NODE_ENV
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => resetHealthReadinessCacheForTesting()).toThrow(/SECURITY_ERROR/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('R630 & R631: synchronous createVerifiedTenantContext throw does not poison in-flight readiness map after TTL expiry, and readiness fails 503 when PLATFORM_DOCUMENT_STORAGE_PROVIDER mismatches tenant config or is azure-blob', async () => {
    resetHealthReadinessCacheForTesting();
    const tenantRuntime = await import('@/platform/tenantRuntime');
    const readyMod = (await import('@/app/api/health/ready/route')) as {
      GET: (req: Request) => Promise<Response>;
    };

    const baseTime = new Date('2026-11-21T16:00:00.000Z').getTime();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(baseTime);
    const ctxSpy = vi
      .spyOn(tenantRuntime, 'createVerifiedTenantContext')
      .mockImplementationOnce(() => {
        throw new Error('SYNC_CONTEXT_THROW');
      });

    try {
      const firstFail = await readyMod.GET(
        new Request('http://localhost:3000/api/health/ready?r=r630-1'),
      );
      expect(firstFail.status).toBe(503);

      // Advance past the 5-second cache TTL -> must run a fresh probe and recover 200 instead of returning a stuck failed promise
      vi.setSystemTime(baseTime + 6000);
      const recovered = await readyMod.GET(
        new Request('http://localhost:3000/api/health/ready?r=r630-2'),
      );
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ status: 'ready' });
    } finally {
      ctxSpy.mockRestore();
      vi.useRealTimers();
      resetHealthReadinessCacheForTesting();
    }

    // R631: readiness fails 503 when PLATFORM_DOCUMENT_STORAGE_PROVIDER is azure-blob or disagrees with tenant config
    for (const badEnvProvider of ['azure-blob', 'sharepoint'] as const) {
      resetHealthReadinessCacheForTesting();
      vi.stubEnv('PLATFORM_DOCUMENT_STORAGE_PROVIDER', badEnvProvider);
      try {
        const mismatchRes = await readyMod.GET(
          new Request('http://localhost:3000/api/health/ready'),
        );
        expect(mismatchRes.status, badEnvProvider).toBe(503);
        expect(await mismatchRes.json()).toEqual({ status: 'not_ready' });
      } finally {
        vi.unstubAllEnvs();
        resetHealthReadinessCacheForTesting();
      }
    }
  });
});
