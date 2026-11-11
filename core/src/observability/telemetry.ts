/**
 * Platform Observability & Application Insights OpenTelemetry Emitter (`core/src/observability/telemetry.ts`).
 *
 * Enforces Platform Architecture Standard §13 and Rule 5:
 * 1. Every request/action/job telemetry event carries `tenantId` and a validated `correlationId`.
 * 2. Process start-up/shutdown events before a user tenant exists go exclusively through
 *    `emitPlatformStartupTelemetry` (`tenantId: 'platform'` in multi-tenant or the configured single tenant).
 * 3. Recursive case-insensitive deny-list scrubbing strips all personal data, client content, SQL text/values,
 *    and credentials/tokens from properties and error messages before recording or exporting.
 * 4. Exports to Azure Application Insights via `@azure/monitor-opentelemetry` / `@opentelemetry/api` ONLY when
 *    `APPLICATIONINSIGHTS_CONNECTION_STRING` is explicitly configured (opt-in in Model A per Standard §7).
 */

import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import type { HostingMode } from '../api/index';

export const TELEMETRY_SAFE_CORRELATION_ID_PATTERN =
  /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Normalised lower-case keys (alphanumeric only) stripped from all telemetry payloads
 * at every nesting depth (Standard §13, Rule 5).
 */
const PERSONAL_DATA_AND_CONTENT_DENY_SET = new Set<string>([
  'email',
  'emails',
  'upn',
  'preferredusername',
  'entraobjectid',
  'oid',
  'sub',
  'firstname',
  'middlenames',
  'lastname',
  'surname',
  'preferredname',
  'othernames',
  'displayname',
  'name',
  'personname',
  'clientname',
  'phone',
  'phones',
  'mobile',
  'address',
  'addresses',
  'line1',
  'line2',
  'postcode',
  'dateofbirth',
  'dob',
  'ninumber',
  'nationalinsurancenumber',
  'passportnumber',
  'bankaccount',
  'bankaccountnumber',
  'accountnumber',
  'sortcode',
  'banksortcode',
  'salary',
  'payroll',
  'sensitive',
  'reasonableadjustmentsneeded',
  'diversity',
  'notes',
  'summary',
  'description',
  'scope',
  'assumptions',
  'body',
  'bodyhtml',
  'bodytext',
  'text',
  'prompt',
  'documenttext',
  'extractedtext',
  'mattertitle',
  'title',
  'legalname',
  'tradingname',
  'sql',
  'query',
  'parameters',
  'values',
  'authorization',
  'cookie',
  'setcookie',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'idtoken',
  'refreshtoken',
  'userassertiontoken',
  'apikey',
  'password',
  'connectionstring',
]);

const EMAIL_IN_TEXT_REGEX =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_OR_JWT_IN_TEXT_REGEX =
  /\bBearer\s+[A-Za-z0-9._~+/=-]+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\b(?:sk-ant-[A-Za-z0-9_-]+|ak_[A-Za-z0-9]{16,})\b/gi;

function normalisePropertyKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isDeniedTelemetryKey(key: string): boolean {
  return PERSONAL_DATA_AND_CONTENT_DENY_SET.has(normalisePropertyKey(key));
}

export function sanitizeTelemetryString(value: string): string {
  return value
    .replace(BEARER_OR_JWT_IN_TEXT_REGEX, '[REDACTED_TOKEN]')
    .replace(EMAIL_IN_TEXT_REGEX, '[REDACTED_EMAIL]');
}

export function sanitizeTelemetryValue(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 8) {
    return '[TRUNCATED_DEPTH]';
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeTelemetryString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTelemetryValue(item, depth + 1));
  }
  if (value instanceof Error) {
    return {
      errorName: value.name || 'Error',
      message: sanitizeTelemetryString(value.message || 'Error'),
      ...(typeof (value as { code?: unknown }).code === 'string'
        ? { code: sanitizeTelemetryString(String((value as { code?: unknown }).code)) }
        : {}),
    };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isDeniedTelemetryKey(k)) {
        continue;
      }
      const cleaned = sanitizeTelemetryValue(v, depth + 1);
      if (cleaned !== undefined) {
        out[k] = cleaned;
      }
    }
    return out;
  }
  return String(value);
}

export function sanitizeTelemetryProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!properties) {
    return {};
  }
  return sanitizeTelemetryValue(properties, 0) as Record<string, unknown>;
}

export type TelemetrySeverity = 'info' | 'warn' | 'error';

export interface RecordedTelemetryEntry {
  readonly kind: 'event' | 'exception' | 'startup';
  readonly eventName: string;
  readonly severity: TelemetrySeverity;
  readonly tenantId: string;
  readonly correlationId: string;
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly errorName?: string;
  readonly errorMessage?: string;
  readonly errorCode?: string;
}

export type TelemetrySinkListener = (entry: RecordedTelemetryEntry) => void;

const MAX_RECENT_TELEMETRY_ENTRIES = 500;

export class PlatformTelemetryRecorder {
  private readonly entries: RecordedTelemetryEntry[] = [];
  private readonly listeners = new Set<TelemetrySinkListener>();
  private azureMonitorInitialised = false;

  public subscribe(listener: TelemetrySinkListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public record(entry: RecordedTelemetryEntry): RecordedTelemetryEntry {
    const frozen: RecordedTelemetryEntry = Object.freeze({
      ...entry,
      properties: Object.freeze({ ...entry.properties }),
    });
    this.entries.push(frozen);
    if (this.entries.length > MAX_RECENT_TELEMETRY_ENTRIES) {
      this.entries.shift();
    }

    // Export through OpenTelemetry API (no-op tracer unless @azure/monitor-opentelemetry was initialised)
    const tracer = trace.getTracer('@platform/core-telemetry');
    const flatAttributes = flattenToOtelAttributes({
      'onesquared.tenant_id': frozen.tenantId,
      'onesquared.correlation_id': frozen.correlationId,
      'onesquared.event_kind': frozen.kind,
      'onesquared.severity': frozen.severity,
      ...frozen.properties,
    });

    const span = tracer.startSpan(frozen.eventName, {
      attributes: flatAttributes,
    });
    if (frozen.kind === 'exception') {
      const safeErr = new Error(frozen.errorMessage ?? frozen.eventName);
      safeErr.name = frozen.errorName ?? 'Error';
      span.recordException(safeErr);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: frozen.errorMessage ?? frozen.eventName,
      });
    } else {
      span.addEvent(frozen.eventName, flatAttributes);
      span.setStatus({
        code:
          frozen.severity === 'error'
            ? SpanStatusCode.ERROR
            : SpanStatusCode.OK,
      });
    }
    span.end();

    for (const listener of this.listeners) {
      listener(frozen);
    }
    return frozen;
  }

  public getRecentEntries(filter?: {
    tenantId?: string;
    correlationId?: string;
  }): readonly RecordedTelemetryEntry[] {
    return this.entries.filter((e) => {
      if (filter?.tenantId && e.tenantId !== filter.tenantId) {
        return false;
      }
      if (filter?.correlationId && e.correlationId !== filter.correlationId) {
        return false;
      }
      return true;
    });
  }

  public clearForTesting(): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(
        'SECURITY_ERROR: clearForTesting is permitted only when NODE_ENV === "test".',
      );
    }
    this.entries.length = 0;
  }

  public isAzureMonitorInitialised(): boolean {
    return this.azureMonitorInitialised;
  }

  public markAzureMonitorInitialised(): void {
    this.azureMonitorInitialised = true;
  }
}

function flattenToOtelAttributes(
  input: Record<string, unknown>,
): Attributes {
  const attrs: Attributes = {};
  for (const [key, val] of Object.entries(input)) {
    if (
      typeof val === 'string' ||
      typeof val === 'number' ||
      typeof val === 'boolean'
    ) {
      attrs[key] = val;
    } else if (val !== undefined && val !== null) {
      attrs[key] = JSON.stringify(val);
    }
  }
  return attrs;
}

const globalTelemetryState = globalThis as typeof globalThis & {
  __oneSquaredTelemetryRecorder?: PlatformTelemetryRecorder;
};

export function getPlatformTelemetryRecorder(): PlatformTelemetryRecorder {
  if (!globalTelemetryState.__oneSquaredTelemetryRecorder) {
    globalTelemetryState.__oneSquaredTelemetryRecorder =
      new PlatformTelemetryRecorder();
  }
  return globalTelemetryState.__oneSquaredTelemetryRecorder;
}

function assertValidTelemetryContext(
  tenantId: string,
  correlationId: string,
): { tenantId: string; correlationId: string } {
  const trimmedTenant = tenantId?.trim() ?? '';
  if (!trimmedTenant || trimmedTenant === 'platform') {
    throw new Error(
      'TELEMETRY_TENANT_REQUIRED: Request and job telemetry events require a non-empty tenantId.',
    );
  }
  const trimmedCorrelation = correlationId?.trim() ?? '';
  if (
    !trimmedCorrelation ||
    !TELEMETRY_SAFE_CORRELATION_ID_PATTERN.test(trimmedCorrelation)
  ) {
    throw new Error(
      'TELEMETRY_CORRELATION_REQUIRED: Telemetry events require a validated correlationId.',
    );
  }
  return { tenantId: trimmedTenant, correlationId: trimmedCorrelation };
}

export function emitTenantTelemetryEvent(params: {
  eventName: string;
  tenantId: string;
  correlationId: string;
  severity?: TelemetrySeverity;
  properties?: Record<string, unknown>;
  recorder?: PlatformTelemetryRecorder;
}): RecordedTelemetryEntry {
  const { tenantId, correlationId } = assertValidTelemetryContext(
    params.tenantId,
    params.correlationId,
  );
  const sanitisedProps = sanitizeTelemetryProperties(params.properties);
  const recorder = params.recorder ?? getPlatformTelemetryRecorder();
  return recorder.record({
    kind: 'event',
    eventName: params.eventName,
    severity: params.severity ?? 'info',
    tenantId,
    correlationId,
    timestamp: new Date().toISOString(),
    properties: sanitisedProps,
  });
}

export function emitTenantTelemetryException(params: {
  eventName: string;
  tenantId: string;
  correlationId: string;
  error: unknown;
  properties?: Record<string, unknown>;
  recorder?: PlatformTelemetryRecorder;
}): RecordedTelemetryEntry {
  const { tenantId, correlationId } = assertValidTelemetryContext(
    params.tenantId,
    params.correlationId,
  );
  const sanitisedProps = sanitizeTelemetryProperties(params.properties);
  const rawMessage =
    params.error instanceof Error
      ? params.error.message
      : String(params.error ?? 'Unknown error');
  const errorName =
    params.error instanceof Error ? params.error.name || 'Error' : 'Error';
  const rawCode =
    typeof (params.error as { code?: unknown })?.code === 'string'
      ? ((params.error as { code: string }).code ?? undefined)
      : undefined;

  const recorder = params.recorder ?? getPlatformTelemetryRecorder();
  return recorder.record({
    kind: 'exception',
    eventName: params.eventName,
    severity: 'error',
    tenantId,
    correlationId,
    timestamp: new Date().toISOString(),
    properties: sanitisedProps,
    errorName,
    errorMessage: sanitizeTelemetryString(rawMessage),
    ...(rawCode ? { errorCode: sanitizeTelemetryString(rawCode) } : {}),
  });
}

/**
 * Dedicated emitter for process start-up and shutdown lifecycle events where no
 * user request exists yet (R413). Never accepts user or client content.
 */
export function emitPlatformStartupTelemetry(params: {
  eventName: string;
  hostingMode: HostingMode;
  configuredTenantId?: string;
  correlationId?: string;
  severity?: TelemetrySeverity;
  properties?: Record<string, unknown>;
  recorder?: PlatformTelemetryRecorder;
}): RecordedTelemetryEntry {
  const effectiveTenantId =
    params.hostingMode === 'single_tenant' && params.configuredTenantId?.trim()
      ? params.configuredTenantId.trim()
      : 'platform';
  const candidateCorrelation = params.correlationId?.trim() ?? '';
  const safeCorrelationId = TELEMETRY_SAFE_CORRELATION_ID_PATTERN.test(
    candidateCorrelation,
  )
    ? candidateCorrelation
    : `startup-${randomUUID()}`;
  const sanitisedProps = { ...sanitizeTelemetryProperties(params.properties), scope: 'platform_startup', lifecycleScope: 'platform_startup', hostingMode: params.hostingMode };
  const recorder = params.recorder ?? getPlatformTelemetryRecorder();
  return recorder.record({
    kind: 'startup',
    eventName: params.eventName,
    severity: params.severity ?? 'info',
    tenantId: effectiveTenantId,
    correlationId: safeCorrelationId,
    timestamp: new Date().toISOString(),
    properties: sanitisedProps,
  });
}

/**
 * Every auto-instrumentation `@azure/monitor-opentelemetry` would otherwise switch on.
 * Auto-instrumented spans (HTTP URLs with query strings, `db.statement`, and so on)
 * bypass tenant/correlation stamping and the deny-list, so all are disabled explicitly
 * and only spans recorded through this module are exported (Standard §13, Rule 5, R423).
 */
export const DISABLED_AZURE_MONITOR_INSTRUMENTATIONS = Object.freeze({
  azureSdk: { enabled: false },
  http: { enabled: false },
  mongoDb: { enabled: false },
  mySql: { enabled: false },
  postgreSql: { enabled: false },
  redis: { enabled: false },
  redis4: { enabled: false },
  bunyan: { enabled: false },
  winston: { enabled: false },
  console: { enabled: false },
});

/**
 * Initialises `@azure/monitor-opentelemetry` ONLY when `connectionString` is non-empty.
 * When unset (local dev/test or Model A opt-out per Standard §7), returns `{ enabled: false }`
 * and performs zero network calls.
 *
 * Application Insights has local authentication disabled (`DisableLocalAuth: true`), so
 * export authenticates with the user-assigned managed identity named by `AZURE_CLIENT_ID`.
 * Outside `dev`, a missing `AZURE_CLIENT_ID` fails closed (R422).
 */
export async function initializeAzureMonitorTelemetry(options?: {
  connectionString?: string | null;
  recorder?: PlatformTelemetryRecorder;
  loadAzureMonitor?: () => Promise<typeof import('@azure/monitor-opentelemetry')>;
}): Promise<{ enabled: boolean }> {
  const connStr = (
    options?.connectionString ??
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ??
    ''
  ).trim();
  if (!connStr) {
    return { enabled: false };
  }
  const recorder = options?.recorder ?? getPlatformTelemetryRecorder();
  if (recorder.isAzureMonitorInitialised()) {
    return { enabled: true };
  }
  const managedIdentityClientId = process.env.AZURE_CLIENT_ID?.trim() ?? '';
  const environment = process.env.PLATFORM_ENVIRONMENT?.trim() ?? '';
  if (!managedIdentityClientId && environment !== 'dev') {
    throw new Error(
      'TELEMETRY_MANAGED_IDENTITY_REQUIRED: AZURE_CLIENT_ID must name the managed identity used to export telemetry outside dev.',
    );
  }
  const credential = managedIdentityClientId
    ? new (await import('@azure/identity')).ManagedIdentityCredential({
        clientId: managedIdentityClientId,
      })
    : undefined;
  const loader =
    options?.loadAzureMonitor ??
    (() =>
      import(
        /* webpackIgnore: true */ ['@azure', 'monitor-opentelemetry'].join('/')
      ) as Promise<typeof import('@azure/monitor-opentelemetry')>);
  const { useAzureMonitor: enableAzureMonitor } = await loader();
  enableAzureMonitor({
    azureMonitorExporterOptions: {
      connectionString: connStr,
      ...(credential ? { credential } : {}),
    },
    instrumentationOptions: {
      ...DISABLED_AZURE_MONITOR_INSTRUMENTATIONS,
    },
  });
  recorder.markAzureMonitorInitialised();
  return { enabled: true };
}
