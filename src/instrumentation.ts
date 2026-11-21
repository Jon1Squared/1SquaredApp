export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  await import('../core/src/tenancy/pgNodePreload');

  const [
    { emitPlatformStartupTelemetry, initializeAzureMonitorTelemetry },
    { resolveRequestCorrelationId },
    { assertRuntimeStorageAllowedForActiveTenant },
  ] = await Promise.all([
    import('@platform/core'),
    import('./server/correlationId'),
    import('./server/documentGenerationServices'),
  ]);

  if (process.env.NEXT_PHASE !== 'phase-production-build') {
    assertRuntimeStorageAllowedForActiveTenant();
  }

  const { enabled } = await initializeAzureMonitorTelemetry({
    loadAzureMonitor: () => import('@azure/monitor-opentelemetry'),
  });
  const hostingMode =
    process.env.PLATFORM_HOSTING_MODE === 'single_tenant'
      ? 'single_tenant'
      : 'multi_tenant';

  emitPlatformStartupTelemetry({
    eventName: 'platform.runtime.started',
    hostingMode,
    correlationId: resolveRequestCorrelationId(null, 'startup'),
    properties: {
      azureMonitorEnabled: enabled,
      environment: process.env.PLATFORM_ENVIRONMENT?.trim() || 'unset',
    },
  });
}
