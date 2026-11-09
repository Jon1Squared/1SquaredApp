import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getActiveTenantConfiguration,
  resolveConfiguredEnvironment,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { guardedRoute } from '@/server/authorize';
import {
  getPlatformTelemetryRecorder,
  resolveCurrentRequestCorrelationId,
} from '@/server/telemetry';
import { register as registerInstrumentation } from '@/instrumentation';

describe('S0-13b: Host correlation ID propagation, production PLATFORM_ENVIRONMENT fail-closed guard, and instrumentation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setActiveTenantConfigForTesting(null);
  });

  it('fails closed when NODE_ENV=production and PLATFORM_ENVIRONMENT is unset, blank, or invalid, and succeeds when explicitly set (P12 / R371)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PLATFORM_ENVIRONMENT', '');

    expect(() => resolveConfiguredEnvironment()).toThrow(
      /TENANT_CONFIG_ERROR: PLATFORM_ENVIRONMENT must be explicitly set when NODE_ENV=production/,
    );
    expect(() => getActiveTenantConfiguration()).toThrow(
      /TENANT_CONFIG_ERROR: PLATFORM_ENVIRONMENT must be explicitly set when NODE_ENV=production/,
    );

    vi.stubEnv('PLATFORM_ENVIRONMENT', 'staging-invalid');
    expect(() => resolveConfiguredEnvironment()).toThrow(
      /TENANT_CONFIG_ERROR: Invalid PLATFORM_ENVIRONMENT "staging-invalid"/,
    );

    // Positive control: explicit valid PLATFORM_ENVIRONMENT under NODE_ENV=production succeeds
    vi.stubEnv('PLATFORM_ENVIRONMENT', 'live');
    expect(resolveConfiguredEnvironment()).toBe('live');
    const liveCfg = getActiveTenantConfiguration();
    expect(liveCfg.environment).toBe('live');
    expect(liveCfg.tenantId).toBe('not-a-law-firm');
  });

  it('resolves correlation IDs strictly via resolveRequestCorrelationId across server helpers and guardedRoute', async () => {
    // Outside HTTP request scope, mints a prefixed UUID
    const generated = await resolveCurrentRequestCorrelationId('corr-act');
    expect(generated).toMatch(/^corr-act-[0-9a-f-]{36}$/i);

    const recorder = getPlatformTelemetryRecorder();
    recorder.clearForTesting();

    // guardedRoute preserves a valid incoming x-correlation-id on authorisation denial telemetry
    const protectedHandler = guardedRoute('POST /api/matters/extract', async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const validHeaderReq = new Request('http://localhost/api/matters/extract', {
      method: 'POST',
      headers: {
        'x-correlation-id': 'client-trace-abc_123',
      },
    });
    const res1 = await protectedHandler(validHeaderReq);
    expect(res1.status).toBe(401);

    const recordedValid = recorder
      .getRecentEntries({ correlationId: 'client-trace-abc_123' })
      .find((e) => e.eventName === 'authorisation.denied');
    expect(recordedValid).toBeDefined();
    expect(recordedValid?.tenantId).toBe('not-a-law-firm');
    expect(recordedValid?.properties).toMatchObject({
      action: 'POST /api/matters/extract',
      code: 'UNAUTHENTICATED',
    });

    // Malformed incoming x-correlation-id is replaced with a fresh corr-rte-<uuid>
    const malformedHeaderReq = new Request(
      'http://localhost/api/matters/extract',
      {
        method: 'POST',
        headers: {
          'x-correlation-id': 'bad header with spaces <script>; injected=1',
        },
      },
    );
    const res2 = await protectedHandler(malformedHeaderReq);
    expect(res2.status).toBe(401);
    const latest = recorder.getRecentEntries().at(-1);
    expect(latest?.correlationId).toMatch(/^corr-rte-[0-9a-f-]{36}$/i);
  });

  it('registers Next.js nodejs instrumentation without network calls when APPLICATIONINSIGHTS_CONNECTION_STRING is unset', async () => {
    const recorder = getPlatformTelemetryRecorder();
    recorder.clearForTesting();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('APPLICATIONINSIGHTS_CONNECTION_STRING', '');
    vi.stubEnv('PLATFORM_HOSTING_MODE', 'multi_tenant');
    vi.stubEnv('PLATFORM_ENVIRONMENT', 'test');

    await registerInstrumentation();

    const startupEvents = recorder
      .getRecentEntries({ tenantId: 'platform' })
      .filter((e) => e.eventName === 'platform.runtime.started');
    expect(startupEvents.length).toBeGreaterThanOrEqual(1);
    expect(startupEvents.at(-1)?.properties).toMatchObject({
      azureMonitorEnabled: false,
      environment: 'test',
      lifecycleScope: 'platform_startup',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
