import { afterAll, beforeAll } from 'vitest';
import '../../core/src/tenancy/pgNodePreload';
import { getGlobalTenantPostgresPoolManager } from '@platform/core';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { testDataResetContext } from './testTenantContexts';

beforeAll(async () => {
  const seed = loadCommittedSeedStore();
  await importFirmStoreModulesToPostgres({
    ctx: testDataResetContext(),
    store: seed,
    clearFirst: true,
  });
});

afterAll(async () => {
  await getGlobalTenantPostgresPoolManager().closeAllPools();
});
