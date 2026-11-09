import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitPlatformStartupTelemetry,
  emitTenantTelemetryEvent,
  emitTenantTelemetryException,
  initializeAzureMonitorTelemetry,
  PlatformTelemetryRecorder,
  sanitizeTelemetryProperties,
} from '@platform/core';

describe('S0-13b: Core Application Insights / OpenTelemetry telemetry emitter & PII scrubber', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires non-empty tenantId and validated correlationId on request/job events and rejects missing or platform tenantId', () => {
    const recorder = new PlatformTelemetryRecorder();

    expect(() =>
      emitTenantTelemetryEvent({
        eventName: 'matter.opened',
        tenantId: '',
        correlationId: 'corr-valid-123',
        recorder,
      }),
    ).toThrow(/TELEMETRY_TENANT_REQUIRED/);

    expect(() =>
      emitTenantTelemetryEvent({
        eventName: 'matter.opened',
        tenantId: 'platform',
        correlationId: 'corr-valid-123',
        recorder,
      }),
    ).toThrow(/TELEMETRY_TENANT_REQUIRED/);

    expect(() =>
      emitTenantTelemetryEvent({
        eventName: 'matter.opened',
        tenantId: 'not-a-law-firm',
        correlationId: 'bad header with spaces <script>',
        recorder,
      }),
    ).toThrow(/TELEMETRY_CORRELATION_REQUIRED/);

    const valid = emitTenantTelemetryEvent({
      eventName: 'matter.opened',
      tenantId: 'not-a-law-firm',
      correlationId: 'corr-valid-001',
      properties: {
        matterId: 'M-000001',
        durationMs: 42,
      },
      recorder,
    });

    expect(valid.tenantId).toBe('not-a-law-firm');
    expect(valid.correlationId).toBe('corr-valid-001');
    expect(valid.properties).toEqual({
      matterId: 'M-000001',
      durationMs: 42,
    });
  });

  it('recursively strips personal data, client content, SQL queries/parameters, and tokens across nested objects, arrays, and Error.message while preserving operational metadata', () => {
    const recorder = new PlatformTelemetryRecorder();

    const eventEntry = emitTenantTelemetryEvent({
      eventName: 'request.completed',
      tenantId: 'not-a-law-firm',
      correlationId: 'corr-scrub-001',
      properties: {
        route: '/api/matters/extract',
        statusCode: 200,
        durationMs: 118,
        recordId: 'M-000009',
        // Top-level deny-list fields
        email: 'client@notalawfirm.example',
        upn: 'rhian@notalawfirm.example',
        preferred_username: 'rhian@notalawfirm.example',
        entraObjectId: '11111111-2222-3333-4444-555555555555',
        oid: '11111111-2222-3333-4444-555555555555',
        sub: 'sub-user-001',
        firstName: 'Carys',
        surname: 'Jenkins',
        displayName: 'Dr Carys Jenkins',
        phone: '+44 7700 900123',
        postcode: 'CF10 1AA',
        dateOfBirth: '1980-04-12',
        niNumber: 'QQ123456C',
        salary: 95000,
        matterTitle: 'Confidential Share Purchase',
        legalName: 'Fictional Holdings Ltd',
        sql: 'SELECT * FROM people WHERE email = $1',
        parameters: ['client@notalawfirm.example'],
        authorization: 'Bearer secret-jwt-value',
        cookie: 'onesquared_session=secret',
        apiKey: 'sk-ant-api03-supersecretvalue',
        // Nested object & array
        nested: {
          step: 'conflict_check',
          matchCount: 2,
          addresses: [{ line1: '10 Cathedral Road', postcode: 'CF11 9LJ' }],
          notes: 'Sensitive attendance note body',
          extractedText: 'Privileged letter instructions',
        },
        items: [
          {
            itemId: 'IT-1',
            name: 'Mr Evan Price',
            bankAccountNumber: '12345678',
            sortCode: '12-34-56',
            status: 'ok',
          },
        ],
        freeTextStatus:
          'Contacted user client@notalawfirm.example with Bearer abc.def.ghi and key sk-ant-secret12345',
      },
      recorder,
    });

    expect(eventEntry.properties).toEqual({
      route: '/api/matters/extract',
      statusCode: 200,
      durationMs: 118,
      recordId: 'M-000009',
      nested: {
        step: 'conflict_check',
        matchCount: 2,
      },
      items: [
        {
          itemId: 'IT-1',
          status: 'ok',
        },
      ],
      freeTextStatus:
        'Contacted user [REDACTED_EMAIL] with [REDACTED_TOKEN] and key [REDACTED_TOKEN]',
    });

    const rawError = Object.assign(
      new Error(
        'Auth failed for partner@notalawfirm.example using Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123456789',
      ),
      { code: 'AUTH_TOKEN_REJECTED' },
    );
    const exceptionEntry = emitTenantTelemetryException({
      eventName: 'auth.callback.failed',
      tenantId: 'not-a-law-firm',
      correlationId: 'corr-scrub-002',
      error: rawError,
      properties: {
        provider: 'entra_oidc',
        clientSecret: 'top-secret',
      },
      recorder,
    });

    expect(exceptionEntry.errorCode).toBe('AUTH_TOKEN_REJECTED');
    expect(exceptionEntry.errorMessage).toBe(
      'Auth failed for [REDACTED_EMAIL] using [REDACTED_TOKEN]',
    );
    expect(exceptionEntry.errorMessage).not.toContain('notalawfirm.example');
    expect(exceptionEntry.errorMessage).not.toContain('eyJ');
    expect(exceptionEntry.properties).toEqual({
      provider: 'entra_oidc',
    });

    expect(
      sanitizeTelemetryProperties({
        prompt: 'Summarise client instructions',
        safeCount: 3,
      }),
    ).toEqual({ safeCount: 3 });
  });

  it('handles start-up lifecycle events without a user request via emitPlatformStartupTelemetry and performs zero network calls when APPLICATIONINSIGHTS_CONNECTION_STRING is unset (R413)', async () => {
    const recorder = new PlatformTelemetryRecorder();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const initRes = await initializeAzureMonitorTelemetry({
      connectionString: '',
      recorder,
    });
    expect(initRes.enabled).toBe(false);
    expect(recorder.isAzureMonitorInitialised()).toBe(false);

    const multiTenantStartup = emitPlatformStartupTelemetry({
      eventName: 'platform.runtime.started',
      hostingMode: 'multi_tenant',
      configuredTenantId: 'not-a-law-firm',
      properties: {
        environment: 'test',
        secret: 'never-logged',
      },
      recorder,
    });
    expect(multiTenantStartup.kind).toBe('startup');
    expect(multiTenantStartup.tenantId).toBe('platform');
    expect(multiTenantStartup.correlationId).toMatch(/^startup-[0-9a-f-]{36}$/i);
    expect(multiTenantStartup.properties).toEqual({
      environment: 'test',
      scope: 'platform_startup',
      lifecycleScope: 'platform_startup',
      hostingMode: 'multi_tenant',
    });

    const singleTenantStartup = emitPlatformStartupTelemetry({
      eventName: 'platform.runtime.started',
      hostingMode: 'single_tenant',
      configuredTenantId: 'not-a-law-firm',
      correlationId: 'startup-custom-001',
      recorder,
    });
    expect(singleTenantStartup.tenantId).toBe('not-a-law-firm');
    expect(singleTenantStartup.correlationId).toBe('startup-custom-001');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
