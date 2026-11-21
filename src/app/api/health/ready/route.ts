import { NextResponse } from 'next/server';
import {
  isLiveBlobStorageEnvironment,
  probeTenantDatabaseReadiness,
} from '@platform/core';
import {
  createVerifiedTenantContext,
  getActiveTenantConfiguration,
} from '@/platform/tenantRuntime';
import { guardedRoute } from '@/server/authorize';

export const dynamic = 'force-dynamic';

export const GET = guardedRoute(
  'GET /api/health/ready',
  async (): Promise<Response> => {
    try {
      const activeCfg = getActiveTenantConfiguration();
      if (
        isLiveBlobStorageEnvironment(activeCfg.environment) &&
        activeCfg.documentGeneration.storageProvider === 'local-fs'
      ) {
        return NextResponse.json(
          { status: 'not_ready' },
          {
            status: 503,
            headers: { 'Cache-Control': 'no-store' },
          },
        );
      }

      const ctx = createVerifiedTenantContext(
        {
          sub: 'system:health-ready',
          name: 'System Health Readiness',
          tenantId: activeCfg.tenantId,
          email: `health@${activeCfg.tenantId}.local`,
          roles: [],
          mfaVerified: false,
          correlationId: 'health-ready',
        },
        activeCfg,
      );
      await probeTenantDatabaseReadiness(ctx);

      return NextResponse.json(
        { status: 'ready' },
        {
          status: 200,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    } catch {
      return NextResponse.json(
        { status: 'not_ready' },
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }
  },
);
