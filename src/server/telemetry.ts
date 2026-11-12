import 'server-only';

import { headers } from 'next/headers';
import {
  emitPlatformStartupTelemetry,
  emitTenantTelemetryEvent,
  emitTenantTelemetryException,
  getPlatformTelemetryRecorder,
  initializeAzureMonitorTelemetry,
  type RecordedTelemetryEntry,
  type TelemetrySeverity,
} from '@platform/core';
import { resolveRequestCorrelationId } from './correlationId';

/**
 * Resolves the active request's correlation ID strictly through `resolveRequestCorrelationId`
 * (`src/server/correlationId.ts`, S0-30). Reads `x-correlation-id` from Next.js request headers
 * when inside an HTTP request context and falls back to a fresh UUID outside HTTP scope.
 */
export async function resolveCurrentRequestCorrelationId(
  fallbackPrefix?: string,
): Promise<string> {
  try {
    const reqHeaders = await headers();
    return resolveRequestCorrelationId(
      reqHeaders.get('x-correlation-id'),
      fallbackPrefix,
    );
  } catch {
    return resolveRequestCorrelationId(null, fallbackPrefix);
  }
}

export {
  emitPlatformStartupTelemetry,
  emitTenantTelemetryEvent,
  emitTenantTelemetryException,
  getPlatformTelemetryRecorder,
  initializeAzureMonitorTelemetry,
  type RecordedTelemetryEntry,
  type TelemetrySeverity,
};
