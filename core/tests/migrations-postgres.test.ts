import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CORE_REQUIRED_SCHEMA_VERSION,
  CORE_TENANT_MIGRATIONS,
  createDirectMigrationClient,
  resolveTenantFromVerifiedToken,
  TenantMigrationRunner,
  TenantPostgresPoolManager,
  TenantScopedRepository,
  validateTenantRegistry,
  type TenantContext,
  type TenantMigrationDefinition,
  type TenantRegistry,
} from '@platform/core';
import * as corePkg from '@platform/core';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import * as tenantRuntimePkg from '@/platform/tenantRuntime';
import { createSeedStore } from '@/server/store';
import {
  buildSystemImportTenantContext,
  importFirmStoreModulesToPostgres,
} from '@/server/storePostgresImport';
import { runMigrateJobSweep } from '../../scripts/run-job';

const REPO_ROOT = path.resolve(__dirname, '../..');

function makeTestTenantContext(
  tenantId: string,
  environment: 'test' | 'dev' = 'test',
  correlationId = `corr-pg-${tenantId}`,
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: `actor-${tenantId}`,
      tenantId,
      name: `Actor ${tenantId}`,
      email: `actor@${tenantId}.example`,
      roles: ['admin'],
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment,
    correlationId,
  });
}

class DiagnosticProbeRepository extends TenantScopedRepository {
  public async readCurrentRoleAndBackendPid(ctx: TenantContext): Promise<{
    currentUser: string;
    sessionUser: string;
    backendPid: number;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        current_user: string;
        session_user: string;
        pid: number;
      }>(
        'SELECT current_user, session_user, pg_backend_pid() AS pid',
      );
      const row = res.rows[0]!;
      return {
        currentUser: row.current_user,
        sessionUser: row.session_user,
        backendPid: Number(row.pid),
      };
    });
  }

  public async insertDiagnosticTemplateRow(
    ctx: TenantContext,
    id: string,
    code: string,
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        `INSERT INTO document_templates (id, tenant_id, code, name, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [id, ctx.tenantId, code, `Template ${code}`, ctx.actorId],
      );
    });
  }

  public async countDiagnosticTemplateRows(ctx: TenantContext): Promise<number> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{ cnt: string }>(
        'SELECT COUNT(*)::text AS cnt FROM document_templates WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      return Number(res.rows[0]?.cnt ?? '0');
    });
  }
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.next' ||
      entry.name === '.git' ||
      entry.name === 'dist' ||
      entry.name === 'build' ||
      entry.name === 'coverage'
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('S0-14: Real PostgreSQL 16 TenantScopedRepository, SET LOCAL ROLE, R402 privileges, and TenantMigrationRunner (R401, R402, R403)', () => {
  it('enforces the Owner Decision 2 contract: zero files outside core/src/tenancy/ import pg', () => {
    const tenancyDir = path.join(REPO_ROOT, 'core', 'src', 'tenancy');
    const files = collectSourceFiles(REPO_ROOT);
    const violations: string[] = [];
    const pgImportRegex =
      /(?:from\s+['"]pg(?:\/[^'"]*)?['"]|import\s*\(\s*['"]pg(?:\/[^'"]*)?['"]\s*\)|require\s*\(\s*['"]pg(?:\/[^'"]*)?['"]\s*\))/;

    for (const file of files) {
      if (file.startsWith(tenancyDir + path.sep)) {
        continue;
      }
      if (file.endsWith('migrations-postgres.test.ts')) {
        continue;
      }
      const content = fs.readFileSync(file, 'utf8');
      if (pgImportRegex.test(content)) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }

    expect(violations).toEqual([]);
  });

  it('applies 0001-0006 idempotently, verifies checksums, rolls back failed SQL cleanly, and round-trips downSql -> upSql on real PostgreSQL 16', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'mig-roundtrip-firm', environment: 'test' }],
    });
    const ctx = makeTestTenantContext('mig-roundtrip-firm');
    const runner = new TenantMigrationRunner();
    for (const v of ['0006', '0005', '0004', '0003', '0002', '0001']) {
      await runner.rollbackVersion(ctx, v);
    }

    const firstApply = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    expect(firstApply.map((m) => m.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
    ]);

    // Idempotent second run applies 0 migrations
    const secondApply = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    expect(secondApply).toEqual([]);

    // Failed SQL rolls back its transaction cleanly without recording in tenant_schema_migrations
    const brokenMigration: TenantMigrationDefinition = {
      version: '9999',
      name: '9999_broken_sql_test',
      description: 'Intentionally invalid SQL to verify transactional rollback',
      tablesChanged: ['should_never_exist_table'],
      dependsOn: ['0006'],
      upSql: `
        CREATE TABLE should_never_exist_table (id TEXT PRIMARY KEY);
        SELECT * FROM table_that_definitely_does_not_exist_9999;
      `,
      downSql: 'DROP TABLE IF EXISTS should_never_exist_table;',
    };

    await expect(
      runner.applyUp(ctx, [...CORE_TENANT_MIGRATIONS, brokenMigration]),
    ).rejects.toThrow(/TENANCY_DATABASE_ERROR/);

    const activeAfterFail = await runner.getActiveTables(ctx);
    expect(activeAfterFail).not.toContain('should_never_exist_table');

    // Round-trip rollback 0006 -> 0005 and re-apply
    expect(await runner.rollbackVersion(ctx, '0006')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0005')).toBe(true);
    expect(await runner.getActiveTables(ctx)).not.toContain(
      'matter_restriction_metadata',
    );
    expect(await runner.getActiveTables(ctx)).not.toContain(
      'document_generation_tenant_configs',
    );

    const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    expect(reapplied.map((m) => m.version)).toEqual(['0005', '0006']);
  });

  it('fails closed with TENANCY_DB_CONFIG_ERROR when password auth has no password env var, and core holds no built-in passwords (R435)', async () => {
    const saved = {
      runtime: process.env.PLATFORM_POSTGRES_RUNTIME_PASSWORD,
      migrate: process.env.PLATFORM_POSTGRES_MIGRATE_PASSWORD,
    };
    const ctx = makeTestTenantContext('tenant-a');
    const poolMgr = new TenantPostgresPoolManager();
    try {
      delete process.env.PLATFORM_POSTGRES_RUNTIME_PASSWORD;
      delete process.env.PLATFORM_POSTGRES_MIGRATE_PASSWORD;
      await expect(poolMgr.getPoolForTenant(ctx)).rejects.toMatchObject({
        code: 'TENANCY_DB_CONFIG_ERROR',
        message:
          'TENANCY_DB_CONFIG_ERROR: PLATFORM_POSTGRES_RUNTIME_PASSWORD must be set when PostgreSQL password authentication is used.',
      });
      await expect(createDirectMigrationClient({ ctx })).rejects.toMatchObject({
        code: 'TENANCY_DB_CONFIG_ERROR',
        message:
          'TENANCY_DB_CONFIG_ERROR: PLATFORM_POSTGRES_MIGRATE_PASSWORD must be set when PostgreSQL password authentication is used.',
      });
    } finally {
      process.env.PLATFORM_POSTGRES_RUNTIME_PASSWORD = saved.runtime;
      process.env.PLATFORM_POSTGRES_MIGRATE_PASSWORD = saved.migrate;
      await poolMgr.closeAllPools();
    }
    // Positive control: with the variables restored, tenant A connects.
    const client = await createDirectMigrationClient({ ctx });
    await client.end();

    const coreSources = collectSourceFiles(path.join(REPO_ROOT, 'core', 'src'));
    const offenders = coreSources.filter((file) =>
      /onesquared_local_|databaseNameOverride/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
    expect('provisionPostgresClusterRolesAndDatabases' in corePkg).toBe(false);
  });

  it('refuses a tenant whose intermediate migration was rolled back, and re-checks a cached ready state after its TTL (R437)', async () => {
    // Catalogue versions are contiguous, which the readiness check relies on.
    expect(CORE_TENANT_MIGRATIONS.map((m) => m.version)).toEqual(
      CORE_TENANT_MIGRATIONS.map((_, i) => String(i + 1).padStart(4, '0')),
    );

    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'mig-gap-firm', environment: 'test' }],
    });
    const ctx = makeTestTenantContext('mig-gap-firm');
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

    const cachedPoolMgr = new TenantPostgresPoolManager({ schemaReadyTtlMs: 0 });
    const freshPoolMgr = new TenantPostgresPoolManager();
    try {
      // Positive control: fully migrated tenant is ready.
      const cachedRepo = new DiagnosticProbeRepository({ poolManager: cachedPoolMgr });
      expect(await cachedRepo.countDiagnosticTemplateRows(ctx)).toBe(0);

      expect(await runner.rollbackVersion(ctx, '0005')).toBe(true);

      const expectedNotReady = {
        code: 'TENANT_SCHEMA_NOT_READY',
        message: `TENANT_SCHEMA_NOT_READY: Tenant "mig-gap-firm" database "pg_tenant_mig_gap_firm_test" is missing migration "0005" required by "${CORE_REQUIRED_SCHEMA_VERSION}".`,
      };
      // A fresh pool manager re-reads the ledger and sees the gap.
      const freshRepo = new DiagnosticProbeRepository({ poolManager: freshPoolMgr });
      await expect(freshRepo.countDiagnosticTemplateRows(ctx)).rejects.toMatchObject(
        expectedNotReady,
      );
      // The previously-ready cache expires and re-checks.
      await expect(cachedRepo.countDiagnosticTemplateRows(ctx)).rejects.toMatchObject(
        expectedNotReady,
      );
    } finally {
      await cachedPoolMgr.closeAllPools();
      await freshPoolMgr.closeAllPools();
      await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    }
  });

  it('runMigrateJobSweep refuses a registry entry whose database does not match the tenant ID (R440)', async () => {
    const host = process.env.PLATFORM_POSTGRES_HOST?.trim() || '127.0.0.1';
    const entry = (tenantId: string, slug: string, databaseSlug: string) => ({
      tenantId,
      slug,
      environment: 'test' as const,
      postgresHost: host,
      postgresDatabaseName: `pg_tenant_${databaseSlug}_test`,
      postgresRoleName: `role_tenant_${slug}_test`,
      keyVaultUri: 'https://kv-registrycheck-test.vault.azure.net/',
      packageDir: 'client-not-a-law-firm',
      timeZone: 'Europe/London',
      enabled: true,
    });
    // validateTenantRegistry already rejects this shape, so the sweep's own check (defence in depth)
    // is exercised with an unvalidated registry object, as a corrupted in-memory registry would be.
    validateTenantRegistry({
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [entry('tenant-b', 'tenant_b', 'tenant_b')],
    });
    const registry: TenantRegistry = Object.freeze({
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [
        entry('tenant-a', 'tenant_a', 'tenant_b'),
        entry('tenant-b', 'tenant_b', 'tenant_b'),
      ],
    });
    const summary = await runMigrateJobSweep({ registry });
    expect(summary.failedTenants).toEqual([
      { tenantId: 'tenant-a', errorCode: 'TENANT_REGISTRY_DATABASE_MISMATCH' },
    ]);
    // Positive control: the correctly configured tenant still migrates.
    expect(summary.succeededTenants).toEqual(['tenant-b']);
    expect(summary.exitCode).toBe(1);
  });

  it('never evicts an idle-timed-out pool that still has a checked-out client (R441)', async () => {
    const ctx = makeTestTenantContext('tenant-a');
    const poolMgr = new TenantPostgresPoolManager({ poolIdleEvictionMs: 0 });
    try {
      const { pool } = await poolMgr.getPoolForTenant(ctx);
      const held = await pool.connect();
      try {
        poolMgr.evictIdlePools(Date.now() + 60_000);
        const again = await poolMgr.getPoolForTenant(ctx);
        expect(again.pool).toBe(pool);
        expect((await held.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
      } finally {
        held.release();
      }
      // Control: once every client is idle the pool is evicted and a new one is created.
      poolMgr.evictIdlePools(Date.now() + 60_000);
      const replaced = await poolMgr.getPoolForTenant(ctx);
      expect(replaced.pool).not.toBe(pool);
    } finally {
      await poolMgr.closeAllPools();
    }
  });

  it('restores both documents template foreign keys when 0006 is rolled back (R434)', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'mig-fk-restore', environment: 'test' }],
    });
    const ctx = makeTestTenantContext('mig-fk-restore');
    const runner = new TenantMigrationRunner();
    for (const v of ['0006', '0005', '0004', '0003', '0002', '0001']) {
      await runner.rollbackVersion(ctx, v);
    }

    const readTemplateFks = async (): Promise<string[]> => {
      // Fresh direct connection for every read.
      const client = await createDirectMigrationClient({ ctx });
      try {
        const res = await client.query<{ conname: string }>(
          `SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.documents'::regclass
              AND contype = 'f'
              AND conname IN ('documents_template_id_fkey', 'documents_template_version_id_fkey')
            ORDER BY conname`,
        );
        return res.rows.map((r) => r.conname);
      } finally {
        await client.end();
      }
    };
    const bothKeys = [
      'documents_template_id_fkey',
      'documents_template_version_id_fkey',
    ];

    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS.slice(0, 5));
    expect(await readTemplateFks()).toEqual(bothKeys);

    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    expect(await readTemplateFks()).toEqual([]);

    expect(await runner.rollbackVersion(ctx, '0006')).toBe(true);
    expect(await readTemplateFks()).toEqual(bothKeys);

    const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    expect(reapplied.map((m) => m.version)).toEqual(['0006']);
    expect(await readTemplateFks()).toEqual([]);
  });

  it('isolates per-tenant migration failures in runMigrateJobSweep and refuses unmigrated tenants at runtime with TENANT_SCHEMA_NOT_READY (R403)', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'mig-partial-fail-a', environment: 'test' },
        { tenantId: 'mig-partial-ok-b', environment: 'test' },
      ],
    });

    const host = process.env.PLATFORM_POSTGRES_HOST?.trim() || '127.0.0.1';
    const registry = validateTenantRegistry({
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [
        {
          tenantId: 'mig-partial-fail-a',
          slug: 'mig_partial_fail_a',
          environment: 'test',
          postgresHost: host,
          postgresDatabaseName: 'pg_tenant_mig_partial_fail_a_test',
          postgresRoleName: 'role_tenant_mig_partial_fail_a_test',
          keyVaultUri: 'https://kv-migpartiala-test.vault.azure.net/',
          packageDir: 'client-not-a-law-firm',
          timeZone: 'Europe/London',
          enabled: true,
        },
        {
          tenantId: 'mig-partial-ok-b',
          slug: 'mig_partial_ok_b',
          environment: 'test',
          postgresHost: host,
          postgresDatabaseName: 'pg_tenant_mig_partial_ok_b_test',
          postgresRoleName: 'role_tenant_mig_partial_ok_b_test',
          keyVaultUri: 'https://kv-migpartialb-test.vault.azure.net/',
          packageDir: 'client-not-a-law-firm',
          timeZone: 'Europe/London',
          enabled: true,
        },
      ],
    });

    const failingFinalMigration: TenantMigrationDefinition = {
      ...CORE_TENANT_MIGRATIONS[5]!,
      upSql: 'SELECT * FROM nonexistent_relation_r403;',
    };

    const preCleanRunner = new TenantMigrationRunner();
    for (const v of ['0006', '0005', '0004', '0003', '0002', '0001']) {
      await preCleanRunner.rollbackVersion(makeTestTenantContext('mig-partial-fail-a'), v);
    }
    const summary = await runMigrateJobSweep({
      registry,
      migrationsByTenant: {
        'mig-partial-fail-a': [
          ...CORE_TENANT_MIGRATIONS.slice(0, 5),
          failingFinalMigration,
        ],
        'mig-partial-ok-b': CORE_TENANT_MIGRATIONS,
      },
    });

    expect(summary.exitCode).toBe(1);
    expect(summary.failedTenants.map((f) => f.tenantId)).toEqual([
      'mig-partial-fail-a',
    ]);
    expect(summary.succeededTenants).toEqual(['mig-partial-ok-b']);

    const poolManager = new TenantPostgresPoolManager();
    try {
      const probeRepo = new DiagnosticProbeRepository({
        poolManager,
        requiredSchemaVersion: CORE_REQUIRED_SCHEMA_VERSION,
      });
      const ctxFailA = makeTestTenantContext('mig-partial-fail-a');
      const ctxOkB = makeTestTenantContext('mig-partial-ok-b');

      await expect(
        probeRepo.readCurrentRoleAndBackendPid(ctxFailA),
      ).rejects.toMatchObject({
        code: 'TENANT_SCHEMA_NOT_READY',
        message: expect.stringContaining('TENANT_SCHEMA_NOT_READY'),
      });

      const okInfo = await probeRepo.readCurrentRoleAndBackendPid(ctxOkB);
      expect(okInfo.currentUser).toBe('role_tenant_mig_partial_ok_b_test');
    } finally {
      await poolManager.closeAllPools();
    }
  });

  it('enforces transaction-scoped SET LOCAL ROLE across pooled backend connections (R401) and R402 NOINHERIT + wrong-database permission denial', async () => {
    const ctxA = makeTestTenantContext('tenant-a');
    const ctxB = makeTestTenantContext('tenant-b');

    // 1. Single backend connection (`max: 1`) verification via pg_backend_pid() (R401)
    const singleConnPoolMgr = new TenantPostgresPoolManager({
      maxConnectionsPerTenant: 1,
    });
    try {
      const repo = new DiagnosticProbeRepository({
        poolManager: singleConnPoolMgr,
      });
      await repo.insertDiagnosticTemplateRow(ctxA, 'TPL-R401-A', 'R401-A');

      const infoA1 = await repo.readCurrentRoleAndBackendPid(ctxA);
      expect(infoA1.currentUser).toBe('role_tenant_tenant_a_test');

      // On the exact same single-connection pool (`pg_tenant_tenant_a_test`), inspect raw client state:
      // (a) `SET LOCAL ROLE` from infoA1 MUST have automatically reset back to `runtime_login` after COMMIT!
      // (b) `runtime_login` (`NOINHERIT`) WITHOUT `SET LOCAL ROLE` MUST be denied reading `document_templates` (R402)!
      // (c) `SET LOCAL ROLE role_tenant_tenant_b_test` on that same backend PID MUST have current_user = role_tenant_tenant_b_test
      //     and MUST be denied reading Tenant A's `document_templates` (`42501` permission denied, R401 & R402)!
      const { pool: poolA } = await singleConnPoolMgr.getPoolForTenant(ctxA);
      const rawClient = await poolA.connect();
      try {
        await rawClient.query('BEGIN');
        const unroled = await rawClient.query<{
          current_user: string;
          pid: number;
        }>('SELECT current_user, pg_backend_pid() AS pid');
        const runtimeUser =
          process.env.PLATFORM_POSTGRES_RUNTIME_USER?.trim() || 'runtime_login';
        expect(unroled.rows[0]!.current_user).toBe(runtimeUser);
        expect(Number(unroled.rows[0]!.pid)).toBe(infoA1.backendPid);

        // Unscoped runtime_login cannot read tenant table (R402a)
        await expect(
          rawClient.query('SELECT * FROM public.document_templates'),
        ).rejects.toMatchObject({ code: '42501' });
        await rawClient.query('ROLLBACK');

        // Same backend connection switching to Tenant B's role (R401)
        await rawClient.query('BEGIN');
        await rawClient.query('SET LOCAL ROLE "role_tenant_tenant_b_test"');
        const asRoleB = await rawClient.query<{
          current_user: string;
          pid: number;
        }>('SELECT current_user, pg_backend_pid() AS pid');
        expect(asRoleB.rows[0]!.current_user).toBe('role_tenant_tenant_b_test');
        expect(Number(asRoleB.rows[0]!.pid)).toBe(infoA1.backendPid);

        await expect(
          rawClient.query('SELECT * FROM public.document_templates'),
        ).rejects.toMatchObject({ code: '42501' });
        await rawClient.query('ROLLBACK');
      } finally {
        rawClient.release();
      }

      // Two-tenant repository calls through TenantPostgresPoolManager (ctxA vs ctxB)
      const infoB = await repo.readCurrentRoleAndBackendPid(ctxB);
      expect(infoB.currentUser).toBe('role_tenant_tenant_b_test');
      expect(await repo.countDiagnosticTemplateRows(ctxA)).toBeGreaterThanOrEqual(
        1,
      );
      expect(await repo.countDiagnosticTemplateRows(ctxB)).toBe(0);
    } finally {
      await singleConnPoolMgr.closeAllPools();
    }

    // 2. Real-pool wrong-database routing test (R402b, R435):
    // A real Tenant A context whose database entry points at Tenant B's database (as a
    // misconfigured registry entry would) fails closed with PostgreSQL permission denied (`42501`).
    const misroutedCtxA: TenantContext = Object.freeze({
      ...ctxA,
      postgresDatabaseName: ctxB.postgresDatabaseName,
    });
    const misroutedPoolMgr = new TenantPostgresPoolManager();
    try {
      const misroutedRepo = new DiagnosticProbeRepository({
        poolManager: misroutedPoolMgr,
      });
      await expect(
        misroutedRepo.insertDiagnosticTemplateRow(
          misroutedCtxA,
          'TPL-SHOULD-FAIL',
          'FAIL-CODE',
        ),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(
          /^TENANCY_DATABASE_PERMISSION_DENIED: PostgreSQL permission denied during .+ \(SQLSTATE 42501\)\.$/,
        ),
      });
    } finally {
      await misroutedPoolMgr.closeAllPools();
    }

    // Verify pg_tenant_tenant_b_test remains completely untouched
    const cleanPoolMgr = new TenantPostgresPoolManager();
    try {
      const cleanRepo = new DiagnosticProbeRepository({
        poolManager: cleanPoolMgr,
      });
      expect(await cleanRepo.countDiagnosticTemplateRows(ctxB)).toBe(0);
    } finally {
      await cleanPoolMgr.closeAllPools();
    }
  });

  it('deletes PostgresTenantCluster and JSON sync bridges, and imports Document Generation & Document Store metadata idempotently across double-runs (Owner Decisions 2 & 6, R405)', async () => {
    expect('PostgresTenantCluster' in corePkg).toBe(false);
    expect('getPlatformPostgresCluster' in tenantRuntimePkg).toBe(false);

    const docGenSvcSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'server', 'documentGenerationServices.ts'),
      'utf8',
    );
    const docStoreSvcSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'server', 'documentStoreServices.ts'),
      'utf8',
    );
    expect(docGenSvcSrc).not.toContain('syncStoreToRepository');
    expect(docGenSvcSrc).not.toContain('persistRepositoryToStore');
    expect(docStoreSvcSrc).not.toContain('ensureRepositorySyncedWithStore');
    expect(docStoreSvcSrc).not.toContain('persistRepositoryToStore');

    const seed = createSeedStore();
    const tenantConfig = tenantRuntimePkg.getActiveTenantConfiguration();
    const ctx = buildSystemImportTenantContext(tenantConfig);

    seed.documentTemplates = [
      {
        id: 'TPL-IMPORT-1',
        tenantId: ctx.tenantId,
        code: 'IMP-01',
        name: 'Imported Template',
        description: 'Idempotent import check',
        category: 'General',
        tags: ['import'],
        outputDocumentType: 'letter',
        filenamePattern: '{{matter.reference}} - Imported',
        availabilityRules: { sourceContexts: ['matter'] },
        activeVersionId: 'TPLV-IMPORT-1',
        status: 'Active',
        createdByUserId: 'P-000001',
        createdAt: '2026-11-09T10:00:00.000Z',
        updatedAt: '2026-11-09T10:00:00.000Z',
      },
    ];
    seed.documentTemplateVersions = [
      {
        id: 'TPLV-IMPORT-1',
        tenantId: ctx.tenantId,
        templateId: 'TPL-IMPORT-1',
        versionNumber: 1,
        engine: 'basic-merge',
        status: 'Active',
        storageProvider: 'local-fs',
        blobKey: 'templates/TPLV-IMPORT-1/imported.docx',
        fileName: 'imported.docx',
        fileSha256: 'abc123',
        fileSizeBytes: 512,
        scanStatus: 'clean',
        extractedPlaceholders: [],
        fieldMappings: {},
        promptedFields: [],
        createdByUserId: 'P-000001',
        createdAt: '2026-11-09T10:00:00.000Z',
      },
    ];
    seed.templateUsageEvents = [
      {
        id: 'TUE-IMPORT-1',
        tenantId: ctx.tenantId,
        templateId: 'TPL-IMPORT-1',
        templateVersionId: 'TPLV-IMPORT-1',
        versionNumber: 1,
        eventType: 'generated',
        occurredAt: '2026-11-09T11:00:00.000Z',
        actorUserId: 'P-000001',
        actorRoleKey: 'partner',
        sourceEntityType: 'matter',
        outputFormat: 'docx',
        missingFieldKeys: [],
        durationMs: 25,
        correlationId: 'corr-imp-1',
      },
    ];
    seed.documentStoreAuditEvents = [
      {
        id: 'DSAE-IMPORT-1',
        tenantId: ctx.tenantId,
        correlationId: 'corr-imp-ds-1',
        occurredAt: '2026-11-09T11:05:00.000Z',
        actorUserId: 'P-000001',
        identityUsed: 'user',
        triggerEvent: 'test.import',
        action: 'document:listed',
        matterId: 'M-000001',
        storeId: 'default-sp',
        libraryId: 'lib-1',
        providerItemId: null,
        outcome: 'succeeded',
        errorCode: null,
        metadata: {},
      },
    ];

    const firstImport = await importFirmStoreModulesToPostgres({
      store: seed,
      tenantConfig,
      modules: ['documents', 'document-store', 'key-dates'],
      clearFirst: true,
    });
    const secondImport = await importFirmStoreModulesToPostgres({
      store: seed,
      tenantConfig,
      modules: ['documents', 'document-store', 'key-dates'],
      clearFirst: false,
    });

    expect(secondImport.counts).toEqual(firstImport.counts);

    const docRepo = new corePkg.TenantDocumentRepository();
    const docStoreRepo = new corePkg.TenantDocumentStoreRepository();
    const summaries = await docRepo.listUsageSummaries(ctx);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.generatedCount).toBe(1);
    expect(await docStoreRepo.listAuditEvents(ctx)).toHaveLength(1);
  });
});
