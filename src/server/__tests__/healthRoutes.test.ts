import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('R655: standalone bundled-only layout loads enabled extension and opens a matter, while missing/invalid extensions fail /api/health/ready with 503, log startup errorCode only, and isolate per tenant', async () => {
    const tenantRuntime = await import('@/platform/tenantRuntime');
    const { resetAllDemoData, saveMatterRecord } = await import('@/server/services');
    const { runAsTestActor } = await import('@/server/testSupport/auditTestSupport');
    const { loadCommittedSeedStore } = await import('@/seed/seedSnapshot');
    const { testDataResetContext } = await import('@/test/testTenantContexts');
    const { executeCliJobRunner } = await import('../../../scripts/run-job');
    const instrumentation = await import('@/instrumentation');
    const readyMod = (await import('@/app/api/health/ready/route')) as {
      GET: (req: Request) => Promise<Response>;
    };

    const tempPkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r655-standalone-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // Build standalone/runtime layout: config/* + extensions/*/manifest.json ONLY (zero .ts/.js source files)
      fs.cpSync(
        path.join(process.cwd(), 'client-not-a-law-firm', 'config'),
        path.join(tempPkgDir, 'config'),
        { recursive: true },
      );
      const extDir = path.join(
        tempPkgDir,
        'extensions',
        'nalf-matter-costs-governance',
      );
      fs.mkdirSync(extDir, { recursive: true });
      fs.copyFileSync(
        path.join(
          process.cwd(),
          'client-not-a-law-firm',
          'extensions',
          'nalf-matter-costs-governance',
          'manifest.json',
        ),
        path.join(extDir, 'manifest.json'),
      );

      vi.stubEnv('PLATFORM_TENANT_PACKAGE_DIR', tempPkgDir);
      vi.stubEnv('PLATFORM_ENVIRONMENT', 'test');
      tenantRuntime.resetTenantRuntimeForTesting();
      resetHealthReadinessCacheForTesting();

      // 1. Standalone layout with manifest.json (no .ts/.js source) loads extension via BUNDLED_TENANT_EXTENSIONS
      const host = tenantRuntime.getPlatformExtensionHost();
      const activeIds = host
        .getActiveExtensionsForTenant(tenantRuntime.getActiveTenantConfiguration())
        .map((e) => e.manifest.id);
      expect(activeIds).toContain('nalf-matter-costs-governance');
      expect(tenantRuntime.getExtensionHostLoadErrors()).toEqual([]);

      const okRes = await readyMod.GET(
        new Request('http://localhost:3000/api/health/ready?r=r655-ok'),
      );
      expect(okRes.status).toBe(200);
      expect(await okRes.json()).toEqual({ status: 'ready' });

      // CLI --verify-extensions succeeds cleanly under bundled-only layout
      const outLines: string[] = [];
      const cliOkCode = await executeCliJobRunner(
        ['node', 'run-job.ts', '--verify-extensions'],
        {
          stdout: (msg) => outLines.push(msg),
          stderr: (msg) => outLines.push(msg),
        },
      );
      expect(cliOkCode).toBe(0);
      expect(outLines.join('')).toContain('job.verify-extensions.succeeded');

      // 2. Matter opening passes under the bundled-only layout (proves beforeMatterOpen runs from BUNDLED_TENANT_EXTENSIONS)
      const seed = loadCommittedSeedStore();
      const baseMatter = seed.matters.find((m) => m.id === 'M-000008')!;
      const openRes = await runAsTestActor('P-000001', () =>
        saveMatterRecord(
          {
            ...baseMatter,
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
            conflictCheckRecord: {
              status: 'Cleared',
              outcomeLabel: 'Cleared by fee earner',
              declarationConfirmed: true,
              reviewerMessage: '',
              lastRunAtDisplay: '22 Nov 2026',
              lastRunById: 'P-000001',
              lastRunByName: 'Rhian Morgan',
              submittedAtDisplay: '22 Nov 2026',
              submittedById: 'P-000001',
              submittedByName: 'Rhian Morgan',
              approvedAtDisplay: null,
              approvedById: null,
              approvedByName: null,
              parties: [],
              matches: [],
              comments: [],
              runs: [],
            },
          },
          { id: baseMatter.id, byId: 'P-000001', saveMode: 'submit_cleared' },
        ),
      );
      expect(openRes.errors).toBeUndefined();
      expect(openRes.matter?.matterNumber).toMatch(/^[A-Z0-9]+-\d{4}$/);
      expect(
        (
          openRes.matter?.fieldValues?.matterOpeningGate as
            | { allowProceed?: boolean }
            | undefined
        )?.allowProceed,
      ).toBe(true);

      // 3. Manifest mismatch fails assertManifestMatchesFile -> readiness 503 with EXTENSION_MANIFEST_MISMATCH
      const parsedManifest = JSON.parse(
        fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
      fs.writeFileSync(
        path.join(extDir, 'manifest.json'),
        JSON.stringify({ ...parsedManifest, version: '9.9.9' }),
        'utf8',
      );
      tenantRuntime.resetTenantRuntimeForTesting();
      resetHealthReadinessCacheForTesting();

      const mismatchRes = await readyMod.GET(
        new Request('http://localhost:3000/api/health/ready?r=r655-mismatch', {
          headers: { 'x-correlation-id': 'corr-r655-mismatch' },
        }),
      );
      expect(mismatchRes.status).toBe(503);
      const mismatchWarnLogs = warnSpy.mock.calls
        .map((c) => String(c[0] ?? ''))
        .filter((line) => line.includes('health.readiness_failed'));
      expect(mismatchWarnLogs.length).toBeGreaterThanOrEqual(1);
      expect(mismatchWarnLogs.at(-1)).toContain('EXTENSION_MANIFEST_MISMATCH');

      // 4. Missing extensions folder completely -> /api/health/ready returns 503, --verify-extensions exits 1, and startup logs errorCode only
      fs.rmSync(path.join(tempPkgDir, 'extensions'), {
        recursive: true,
        force: true,
      });
      warnSpy.mockClear();
      errSpy.mockClear();
      tenantRuntime.resetTenantRuntimeForTesting();
      resetHealthReadinessCacheForTesting();

      const cliFailLines: string[] = [];
      const cliFailCode = await executeCliJobRunner(
        ['node', 'run-job.ts', '--verify-extensions'],
        {
          stdout: (msg) => cliFailLines.push(msg),
          stderr: (msg) => cliFailLines.push(msg),
        },
      );
      expect(cliFailCode).toBe(1);
      expect(cliFailLines.join('')).toContain('EXTENSION_NOT_REGISTERED');

      const missingExtRes = await readyMod.GET(
        new Request('http://localhost:3000/api/health/ready?r=r655-missing', {
          headers: { 'x-correlation-id': 'corr-r655-missing' },
        }),
      );
      expect(missingExtRes.status).toBe(503);
      expect(await missingExtRes.json()).toEqual({ status: 'not_ready' });

      // Reset M-000008 back to prospective state so missing-extensions save tests the actual opening gate
      await resetAllDemoData('P-000001', testDataResetContext());

      // Attempting matter opening while extensions/ is absent also fails closed with errors.extensions
      const blockedOpenRes = await runAsTestActor('P-000001', () =>
        saveMatterRecord(
          {
            ...baseMatter,
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
            conflictCheckRecord: {
              status: 'Cleared',
              outcomeLabel: 'Cleared by fee earner',
              declarationConfirmed: true,
              reviewerMessage: '',
              lastRunAtDisplay: '22 Nov 2026',
              lastRunById: 'P-000001',
              lastRunByName: 'Rhian Morgan',
              submittedAtDisplay: '22 Nov 2026',
              submittedById: 'P-000001',
              submittedByName: 'Rhian Morgan',
              approvedAtDisplay: null,
              approvedById: null,
              approvedByName: null,
              parties: [],
              matches: [],
              comments: [],
              runs: [],
            },
          },
          { id: baseMatter.id, byId: 'P-000001', saveMode: 'submit_cleared' },
        ),
      );
      expect(blockedOpenRes.matter).toBeNull();
      expect(blockedOpenRes.errors?.extensions).toBe(
        "A required opening check couldn't run. Please contact your administrator.",
      );

      const readyFailLogs = warnSpy.mock.calls
        .map((c) => String(c[0] ?? ''))
        .filter((line) => line.includes('health.readiness_failed'));
      expect(readyFailLogs.length).toBe(1);
      const readyFailParsed = JSON.parse(readyFailLogs[0]!) as Record<
        string,
        unknown
      >;
      expect(readyFailParsed.errorCode).toBe('EXTENSION_NOT_REGISTERED');
      expect(readyFailParsed.error).toBeUndefined();
      expect(readyFailLogs[0]).not.toContain(tempPkgDir);

      // Startup instrumentation logs errorCode only
      vi.stubEnv('NEXT_RUNTIME', 'nodejs');
      vi.stubEnv('NEXT_PHASE', 'phase-production-server');
      errSpy.mockClear();
      await instrumentation.register();
      const startupErrLogs = errSpy.mock.calls
        .map((c) => String(c[0] ?? ''))
        .filter((line) => line.includes('platform.startup.extension_not_ready'));
      expect(startupErrLogs.length).toBe(1);
      const startupParsed = JSON.parse(startupErrLogs[0]!) as Record<
        string,
        unknown
      >;
      expect(startupParsed.errorCode).toBe('EXTENSION_NOT_REGISTERED');
      expect(startupParsed.error).toBeUndefined();
      expect(startupErrLogs[0]).not.toContain(tempPkgDir);

      // Two-tenant / per-tenant isolation sanity: configuring a second valid tenant package recovers readiness for that tenant cleanly
      const tempTenantB = fs.mkdtempSync(
        path.join(os.tmpdir(), 'r655-tenant-b-'),
      );
      try {
        const cfgDirB = path.join(tempTenantB, 'config');
        fs.mkdirSync(cfgDirB, { recursive: true });
        const baseJson = JSON.parse(
          fs.readFileSync(
            path.join(process.cwd(), 'client-not-a-law-firm', 'config', 'base.json'),
            'utf8',
          ),
        ) as Record<string, unknown>;
        fs.writeFileSync(
          path.join(cfgDirB, 'base.json'),
          JSON.stringify({
            ...baseJson,
            tenantId: 'fictional-chambers-uk',
            displayName: 'Fictional Chambers UK',
            enabledExtensions: [],
          }),
          'utf8',
        );
        vi.stubEnv('PLATFORM_TENANT_PACKAGE_DIR', tempTenantB);
        tenantRuntime.resetTenantRuntimeForTesting();
        resetHealthReadinessCacheForTesting();
        const tenantBReady = await readyMod.GET(
          new Request('http://localhost:3000/api/health/ready?r=r655-tenant-b'),
        );
        expect(tenantBReady.status).toBe(200);
      } finally {
        fs.rmSync(tempTenantB, { recursive: true, force: true });
      }
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
      vi.unstubAllEnvs();
      tenantRuntime.resetTenantRuntimeForTesting();
      resetHealthReadinessCacheForTesting();
      fs.rmSync(tempPkgDir, { recursive: true, force: true });
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });
});
