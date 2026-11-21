import {
  probeTenantDatabaseReadiness,
} from '@platform/core';
import {
  createVerifiedTenantContext,
  getActiveTenantConfiguration,
} from '@/platform/tenantRuntime';
import { validateRuntimeDocumentStorageProvider } from '@/server/documentGenerationServices';

export const READINESS_CACHE_TTL_MS = 5000;

export interface HealthReadinessCheckResult {
  readonly ready: boolean;
  readonly status: 200 | 503;
}

interface CachedReadinessEntry extends HealthReadinessCheckResult {
  readonly expiresAtMs: number;
}

const readinessCacheByKey = new Map<string, CachedReadinessEntry>();
const inFlightReadinessByKey = new Map<string, Promise<HealthReadinessCheckResult>>();

function extractSafeErrorCode(err: unknown): string {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string' &&
    (err as { code: string }).code.trim()
  ) {
    return (err as { code: string }).code.trim().slice(0, 64);
  }
  return 'READINESS_PROBE_FAILED';
}

/**
 * Probes per-tenant PostgreSQL readiness for the active process configuration with a 5-second
 * tenant-scoped TTL cache and single-flight in-flight deduplication (`R612`, `R630`, `R631`),
 * logging probe failures with `correlationId` and `tenantId` without exposing client data or connection strings.
 */
export async function checkTenantReadinessWithCache(params?: {
  correlationId?: string;
}): Promise<HealthReadinessCheckResult> {
  const correlationId = params?.correlationId?.trim() || 'health-ready';
  const activeCfg = getActiveTenantConfiguration();
  const storageProvider = activeCfg.documentGeneration.storageProvider;
  const envStorageProvider = process.env.PLATFORM_DOCUMENT_STORAGE_PROVIDER;

  const storageCheck = validateRuntimeDocumentStorageProvider({
    environment: activeCfg.environment,
    configuredStorageProvider: storageProvider,
    envStorageProvider,
  });
  if (!storageCheck.ok) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'health.readiness_failed',
        tenantId: activeCfg.tenantId,
        correlationId,
        environment: activeCfg.environment,
        errorCode: storageCheck.code,
      }),
    );
    return { ready: false, status: 503 };
  }

  const cacheKey = `${activeCfg.tenantId}:${activeCfg.environment}:${storageProvider}:${envStorageProvider?.trim() || 'unset'}`;
  const nowMs = Date.now();
  const cached = readinessCacheByKey.get(cacheKey);
  if (cached && nowMs < cached.expiresAtMs) {
    return { ready: cached.ready, status: cached.status };
  }

  const existingInFlight = inFlightReadinessByKey.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  let settled = false;
  let probePromise: Promise<HealthReadinessCheckResult> | null = null;
  probePromise = (async (): Promise<HealthReadinessCheckResult> => {
    try {
      const ctx = createVerifiedTenantContext(
        {
          sub: 'system:health-ready',
          name: 'System Health Readiness',
          tenantId: activeCfg.tenantId,
          email: `health@${activeCfg.tenantId}.local`,
          roles: [],
          mfaVerified: false,
          correlationId,
        },
        activeCfg,
      );
      await probeTenantDatabaseReadiness(ctx);
      const okResult: HealthReadinessCheckResult = { ready: true, status: 200 };
      readinessCacheByKey.set(cacheKey, {
        ...okResult,
        expiresAtMs: Date.now() + READINESS_CACHE_TTL_MS,
      });
      return okResult;
    } catch (err) {
      const errorCode = extractSafeErrorCode(err);
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'health.readiness_failed',
          tenantId: activeCfg.tenantId,
          correlationId,
          environment: activeCfg.environment,
          errorCode,
        }),
      );
      const failResult: HealthReadinessCheckResult = { ready: false, status: 503 };
      readinessCacheByKey.set(cacheKey, {
        ...failResult,
        expiresAtMs: Date.now() + READINESS_CACHE_TTL_MS,
      });
      return failResult;
    } finally {
      settled = true;
      if (probePromise && inFlightReadinessByKey.get(cacheKey) === probePromise) {
        inFlightReadinessByKey.delete(cacheKey);
      }
    }
  })();

  if (!settled) {
    inFlightReadinessByKey.set(cacheKey, probePromise);
  }
  return probePromise;
}

export function resetHealthReadinessCacheForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'SECURITY_ERROR: resetHealthReadinessCacheForTesting is only permitted when NODE_ENV === "test".',
    );
  }
  readinessCacheByKey.clear();
  inFlightReadinessByKey.clear();
}
