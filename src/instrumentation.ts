export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  await import('../core/src/tenancy/pgNodePreload');

  const [
    { emitPlatformStartupTelemetry, initializeAzureMonitorTelemetry },
    { resolveRequestCorrelationId },
    { assertRuntimeStorageAllowedForActiveTenant },
    {
      checkActiveTenantExtensionsReadiness,
      getActiveTenantConfiguration,
    },
  ] = await Promise.all([
    import('@platform/core'),
    import('./server/correlationId'),
    import('./server/documentGenerationServices'),
    import('./platform/tenantRuntime'),
  ]);

  const startupCorrelationId = resolveRequestCorrelationId(null, 'startup');

  if (process.env.NEXT_PHASE !== 'phase-production-build') {
    assertRuntimeStorageAllowedForActiveTenant();
    const extensionReadiness = checkActiveTenantExtensionsReadiness();
    if (!extensionReadiness.ok) {
      const activeCfg = getActiveTenantConfiguration();
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'platform.startup.extension_not_ready',
          tenantId: activeCfg.tenantId,
          correlationId: startupCorrelationId,
          environment: activeCfg.environment,
          errorCode: extensionReadiness.errorCode ?? 'EXTENSION_LOAD_FAILED',
        }),
      );
    }
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
    correlationId: startupCorrelationId,
    properties: {
      azureMonitorEnabled: enabled,
      environment: process.env.PLATFORM_ENVIRONMENT?.trim() || 'unset',
    },
  });
}
