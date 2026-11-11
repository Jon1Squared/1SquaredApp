import { afterAll, beforeAll } from 'vitest';
import '../../core/src/tenancy/pgNodePreload';
import { getGlobalTenantPostgresPoolManager } from '@platform/core';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import { saveStore } from '@/server/store';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { testDataResetContext } from './testTenantContexts';

// Explicitly seed the in-memory test store synchronously for module-load helpers,
// and reset + import migrated PostgreSQL modules cleanly before each test suite runs.
saveStore(loadCommittedSeedStore());

beforeAll(async () => {
  const seed = loadCommittedSeedStore();
  saveStore(seed);
  await importFirmStoreModulesToPostgres({
    ctx: testDataResetContext(),
    store: seed,
    clearFirst: true,
  });
});

afterAll(async () => {
  await getGlobalTenantPostgresPoolManager().closeAllPools();
});
