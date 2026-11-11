/**
 * Shared test tenant contexts. Built through the job entry point helper in `scripts/` (ADR 0030
 * §3) so production code under `src/` never constructs a synthetic verified token (R433).
 */

import type { TenantContext } from '@platform/core';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import { buildSystemJobTenantContext } from '../../scripts/lib/systemJobTenantContext';

/** Context used by tests that reset the seeded store and its PostgreSQL modules. */
export function testDataResetContext(): TenantContext {
  return buildSystemJobTenantContext({
    tenantConfig: getActiveTenantConfiguration(),
    jobKey: 'test-data-reset',
  });
}