/**
 * Provisions local / CI PostgreSQL 16 roles (`migrate_login` and `NOINHERIT` `runtime_login`),
 * isolated tenant databases (`pg_tenant_<slug>_<env>`), per-tenant roles (`role_tenant_<slug>_<env>`),
 * and runs `CORE_TENANT_MIGRATIONS` via `@platform/core` (`R401`, `R402`).
 *
 * Imports exclusively from `@platform/core` — never imports `pg` directly outside `core/src/tenancy/`.
 */

import {
  CORE_TENANT_MIGRATIONS,
  getGlobalTenantPostgresPoolManager,
  resolveTenantFromVerifiedToken,
  TenantMigrationRunner,
  TenantPartyRepository,
  type PlatformEnvironment,
} from '@platform/core';
import '../core/src/tenancy/pgNodePreload';
// Local/CI provisioning helper; deliberately not exported from @platform/core (R435).
import { provisionPostgresClusterRolesAndDatabases } from '../core/src/tenancy/postgresAdminBootstrap';
import { loadCommittedSeedStore } from '../src/seed/seedSnapshot';
import { createSeedStore } from '../src/seed/seedStoreBuilder';
import { importFirmStoreModulesToPostgres } from '../src/server/storePostgresImport';

process.env.PLATFORM_HOSTING_MODE ||= 'multi_tenant';
process.env.PLATFORM_POSTGRES_HOST ||= '127.0.0.1';
process.env.PLATFORM_POSTGRES_PORT ||=
  process.env.PLATFORM_POSTGRES_MIGRATE_PORT || '5432';
process.env.PLATFORM_POSTGRES_MIGRATE_PORT ||= '5432';
process.env.PLATFORM_POSTGRES_ADMIN_USER ||= 'postgres';
process.env.PLATFORM_POSTGRES_ADMIN_PASSWORD ||= 'postgres';
process.env.PLATFORM_POSTGRES_RUNTIME_PASSWORD ||= 'onesquared_local_runtime';
process.env.PLATFORM_POSTGRES_MIGRATE_PASSWORD ||= 'onesquared_local_migrate';
process.env.PLATFORM_TENANT_PACKAGE_DIR ||= 'client-not-a-law-firm';
process.env.PLATFORM_ENVIRONMENT ||= 'test';

const TEST_CLUSTER_TENANTS: ReadonlyArray<{
  readonly tenantId: string;
  readonly environment: PlatformEnvironment;
}> = [
  { tenantId: 'not-a-law-firm', environment: 'test' },
  { tenantId: 'not-a-law-firm', environment: 'dev' },
  { tenantId: 'not-a-law-firm', environment: 'demo' },
  { tenantId: 'not-a-law-firm', environment: 'training' },
  { tenantId: 'not-a-law-firm', environment: 'live' },
  { tenantId: 'fictional-chambers-uk', environment: 'test' },
  { tenantId: 'fictional-chambers-uk', environment: 'dev' },
  { tenantId: 'fictional-chambers-uk-chancery', environment: 'test' },
  { tenantId: 'firm-alpha', environment: 'test' },
  { tenantId: 'firm-alpha', environment: 'dev' },
  { tenantId: 'firm-beta', environment: 'test' },
  { tenantId: 'firm-beta', environment: 'dev' },
  { tenantId: 'firm-live-test', environment: 'live' },
  { tenantId: 'firm-live-test', environment: 'training' },
  { tenantId: 'live-test-tenant', environment: 'test' },
  { tenantId: 'pembroke-vaughan', environment: 'test' },
  { tenantId: 'pembroke-vaughan', environment: 'dev' },
  { tenantId: 'second-law-firm', environment: 'test' },
  { tenantId: 'tenant-a', environment: 'test' },
  { tenantId: 'tenant-a', environment: 'dev' },
  { tenantId: 'tenant-alpha', environment: 'test' },
  { tenantId: 'tenant-alpha', environment: 'dev' },
  { tenantId: 'tenant-b', environment: 'test' },
  { tenantId: 'tenant-b', environment: 'dev' },
  { tenantId: 'tenant-bravo', environment: 'test' },
  { tenantId: 'tenant-bravo', environment: 'dev' },
  { tenantId: 'tenant-clean', environment: 'test' },
  { tenantId: 'tenant-nalf-test', environment: 'test' },
  { tenantId: 'tenant-pembroke-vaughan-prod', environment: 'live' },
  { tenantId: 'other-tenant', environment: 'test' },
  { tenantId: 'other-tenant-id', environment: 'test' },
];

async function main(): Promise<void> {
  const resetTestSeed = process.argv.includes('--reset-test-seed');
  const { databasesProvisioned } =
    await provisionPostgresClusterRolesAndDatabases({
      tenants: TEST_CLUSTER_TENANTS,
    });

  const runner = new TenantMigrationRunner();
  for (const t of TEST_CLUSTER_TENANTS) {
    const ctx = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'system-migrate-bootstrap',
        tenantId: t.tenantId,
        name: 'Platform Migration Runner',
        email: 'migrate@platform.example',
        roles: ['admin'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: t.environment,
      correlationId: `corr-bootstrap-${t.tenantId}-${t.environment}`,
    });
    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    if (
      t.tenantId === 'not-a-law-firm' &&
      (t.environment === 'test' || t.environment === 'dev')
    ) {
      const partyRepo = new TenantPartyRepository();
      const existingCounts = await partyRepo.countAllTenantPartyRows(ctx);
      if (resetTestSeed && t.environment === 'test') {
        const committedSeed = loadCommittedSeedStore();
        await importFirmStoreModulesToPostgres({
          ctx,
          store: committedSeed,
          clearFirst: true,
        });
      } else if (existingCounts.people === 0) {
        const seedStore =
          t.environment === 'test'
            ? loadCommittedSeedStore()
            : createSeedStore(new Date(), {
                includeSyntheticEntraOids: false,
              });
        await importFirmStoreModulesToPostgres({
          ctx,
          store: seedStore,
        });
      }
    }
  }
  await getGlobalTenantPostgresPoolManager().closeAllPools();

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'postgres.test_cluster.ready',
      databasesCount: databasesProvisioned.length,
      latestMigration: CORE_TENANT_MIGRATIONS.at(-1)?.version ?? 'none',
    }),
  );
}

main().catch((err: unknown) => {
  console.error(
    '[provision-test-postgres] Failed:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
