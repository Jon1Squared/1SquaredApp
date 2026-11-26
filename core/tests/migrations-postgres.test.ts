import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeMigrationChecksum,
  CORE_REQUIRED_SCHEMA_VERSION,
  CORE_TENANT_MIGRATIONS,
  createDirectMigrationClient,
  getPlatformTelemetryRecorder,
  NON_LIVE_AUDIT_RESET_MIGRATION_0008,
  PMS_MONEY_AND_RETAINER_PENCE_MIGRATION_0027,
  PMS_PENCE_MIGRATION_0027_COLUMNS,
  resolveTenantFromVerifiedToken,
  TenantCatalogueRepository,
  TenantEvidenceArtifactRepository,
  TenantHrAndRbacRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantPartyRepository,
  TenantPostgresPoolManager,
  TenantScopedRepository,
  TenantTaskWorkflowRepository,
  validateTenantRegistry,
  verifyPmsMoneyPenceConversionInClient,
  type TenantChoiceValueRecord,
  type TenantContext,
  type TenantMigrationDefinition,
  type TenantRegistry,
} from '@platform/core';
import { parsePmsWorkbookDataset } from '@/pms/importPms';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import {
  computeOrganisationLookupKeys,
  computePersonLookupKeys,
} from '../src/tenancy/candidateKeys';
import type { Team } from '@/domain/types';
import { resolveRoutedTeam } from '@/domain/tasks';
import * as corePkg from '@platform/core';
import { loadPgModule } from '../src/tenancy/pgDriver';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import * as tenantRuntimePkg from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { buildSystemJobTenantContext } from '../../scripts/lib/systemJobTenantContext';
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

  public async readBackfill0025AuditCountAsRuntime(
    ctx: TenantContext,
  ): Promise<number> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{ cnt: string }>(
        'SELECT COUNT(*)::text AS cnt FROM public.migration_0025_backfill_audit',
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

  it('applies 0001-0007 idempotently, verifies checksums, rolls back failed SQL cleanly, and round-trips downSql -> upSql on real PostgreSQL 16', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'mig-roundtrip-firm', environment: 'test' }],
    });
    const ctx = makeTestTenantContext('mig-roundtrip-firm');
    const runner = new TenantMigrationRunner();
    const expectedVersions = CORE_TENANT_MIGRATIONS.map((m) => m.version);
    for (const v of [...expectedVersions].reverse()) {
      await runner.rollbackVersion(ctx, v);
    }

    const firstApply = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    expect(firstApply.map((m) => m.version)).toEqual(expectedVersions);

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

    // Round-trip rollback 0017 -> 0016 -> 0015 -> 0014 -> 0013 -> 0012 -> 0011 -> 0010 -> 0009 -> 0008 -> 0007 -> 0006 -> 0005 and re-apply
    const activeAt0017 = await runner.getActiveTables(ctx);
    expect(activeAt0017).toEqual(
      expect.arrayContaining([
        'people',
        'person_emails',
        'organisations',
        'person_organisation_links',
        'notes',
        'merge_history',
        'matters',
        'matter_parties',
        'matter_number_sequences',
        'tenant_record_sequences',
        'enquiries',
        'quotes',
        'quote_reference_sequences',
        'tasks',
        'task_linked_records',
        'notifications',
        'sign_offs',
        'recently_viewed',
        'teams',
        'employee_employment_records',
        'employee_sensitive_records',
        'employee_migration_reports',
        'tenant_rbac_configs',
        'firm_profiles',
        'choice_lists',
        'choice_values',
        'custom_field_definitions',
        'tenant_module_configs',
        'pms_links',
        'pms_extract_metadata',
        'pms_fee_earners',
        'pms_clients',
        'pms_matters',
        'pms_matter_financials',
        'pms_fee_estimates',
        'pms_invoices',
        'pms_payments',
        'pms_time_entries',
        'pms_disbursements',
        'pms_client_account_entries',
        'pms_credit_control_log',
        'job_runs',
        'client_rate_overrides',
        'matter_rate_overrides',
        'register_records',
        'register_transitions',
        'register_reminder_states',
        'email_outbox',
        'user_notification_preferences',
        'teams_activity_outbox',
      ]),
    );
    expect(activeAt0017).not.toContain('matter_restriction_metadata');
    expect(await runner.rollbackVersion(ctx, '0027')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0026')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0025')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0024')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0023')).toBe(true);
    const activeAfter0023Rollback = await runner.getActiveTables(ctx);
    expect(activeAfter0023Rollback).not.toContain('intake_check_records');
    expect(activeAfter0023Rollback).not.toContain('email_outbox_attachments');
    expect(await runner.rollbackVersion(ctx, '0022')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0021')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0020')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0019')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0018')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0017')).toBe(true);
    const activeAfter0017Rollback = await runner.getActiveTables(ctx);
    expect(activeAfter0017Rollback).not.toContain('register_records');
    expect(activeAfter0017Rollback).not.toContain('register_transitions');
    expect(activeAfter0017Rollback).not.toContain('register_reminder_states');
    expect(await runner.rollbackVersion(ctx, '0016')).toBe(true);
    const activeAfter0016Rollback = await runner.getActiveTables(ctx);
    expect(activeAfter0016Rollback).not.toContain('client_rate_overrides');
    expect(activeAfter0016Rollback).not.toContain('matter_rate_overrides');
    expect(await runner.rollbackVersion(ctx, '0015')).toBe(true);
    const activeAfter0015Rollback = await runner.getActiveTables(ctx);
    expect(activeAfter0015Rollback).toContain('matter_restriction_metadata');
    expect(await runner.rollbackVersion(ctx, '0014')).toBe(true);
    const activeAfter0014Rollback = await runner.getActiveTables(ctx);
    expect(activeAfter0014Rollback).not.toContain('job_runs');
    expect(await runner.rollbackVersion(ctx, '0013')).toBe(true);
    const activeAfter0013Rollback = await runner.getActiveTables(ctx);
    expect(activeAfter0013Rollback).not.toContain('pms_links');
    expect(activeAfter0013Rollback).not.toContain('pms_extract_metadata');
    expect(activeAfter0013Rollback).not.toContain('pms_fee_earners');
    expect(activeAfter0013Rollback).not.toContain('pms_clients');
    expect(activeAfter0013Rollback).not.toContain('pms_matters');
    expect(activeAfter0013Rollback).not.toContain('pms_matter_financials');
    expect(activeAfter0013Rollback).not.toContain('pms_fee_estimates');
    expect(activeAfter0013Rollback).not.toContain('pms_invoices');
    expect(activeAfter0013Rollback).not.toContain('pms_payments');
    expect(activeAfter0013Rollback).not.toContain('pms_time_entries');
    expect(activeAfter0013Rollback).not.toContain('pms_disbursements');
    expect(activeAfter0013Rollback).not.toContain('pms_client_account_entries');
    expect(activeAfter0013Rollback).not.toContain('pms_credit_control_log');
    expect(await runner.rollbackVersion(ctx, '0012')).toBe(true);
    const activeAfter0012Rollback = await runner.getActiveTables(ctx);
    expect(activeAfter0012Rollback).not.toContain('firm_profiles');
    expect(activeAfter0012Rollback).not.toContain('choice_lists');
    expect(activeAfter0012Rollback).not.toContain('choice_values');
    expect(activeAfter0012Rollback).not.toContain('custom_field_definitions');
    expect(activeAfter0012Rollback).not.toContain('tenant_module_configs');
    expect(await runner.rollbackVersion(ctx, '0011')).toBe(true);
    const activeAfter0011Rollback = await runner.getActiveTables(ctx);
    expect(activeAfter0011Rollback).not.toContain('teams');
    expect(activeAfter0011Rollback).not.toContain('employee_employment_records');
    expect(activeAfter0011Rollback).not.toContain('employee_sensitive_records');
    expect(activeAfter0011Rollback).not.toContain('employee_migration_reports');
    expect(activeAfter0011Rollback).not.toContain('tenant_rbac_configs');
    expect(await runner.rollbackVersion(ctx, '0010')).toBe(true);
    const activeAfter0010Rollback = await runner.getActiveTables(ctx);
    expect(activeAfter0010Rollback).not.toContain('enquiries');
    expect(activeAfter0010Rollback).not.toContain('quotes');
    expect(activeAfter0010Rollback).not.toContain('quote_reference_sequences');
    expect(activeAfter0010Rollback).not.toContain('tasks');
    expect(activeAfter0010Rollback).not.toContain('task_linked_records');
    expect(activeAfter0010Rollback).not.toContain('notifications');
    expect(activeAfter0010Rollback).not.toContain('sign_offs');
    expect(activeAfter0010Rollback).not.toContain('recently_viewed');
    expect(await runner.rollbackVersion(ctx, '0009')).toBe(true);
    const activeAfter0009Rollback = await runner.getActiveTables(ctx);
    expect(activeAfter0009Rollback).not.toContain('people');
    expect(activeAfter0009Rollback).not.toContain('person_emails');
    expect(activeAfter0009Rollback).not.toContain('organisations');
    expect(activeAfter0009Rollback).not.toContain('person_organisation_links');
    expect(activeAfter0009Rollback).not.toContain('notes');
    expect(activeAfter0009Rollback).not.toContain('merge_history');
    expect(activeAfter0009Rollback).not.toContain('matters');
    expect(activeAfter0009Rollback).not.toContain('matter_parties');
    expect(activeAfter0009Rollback).not.toContain('matter_number_sequences');
    expect(activeAfter0009Rollback).not.toContain('tenant_record_sequences');
    for (const v of [...expectedVersions].filter((v) => v >= '0008' && v < '0009').reverse()) {
      expect(await runner.rollbackVersion(ctx, v)).toBe(true);
    }
    expect(await runner.rollbackVersion(ctx, '0007')).toBe(true);
    expect(await runner.getActiveTables(ctx)).not.toContain('audit_entries');
    expect(await runner.rollbackVersion(ctx, '0006')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0005')).toBe(true);
    expect(await runner.getActiveTables(ctx)).not.toContain(
      'matter_restriction_metadata',
    );
    expect(await runner.getActiveTables(ctx)).not.toContain(
      'document_generation_tenant_configs',
    );

    const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    expect(reapplied.map((m) => m.version)).toEqual(
      expectedVersions.filter((v) => v >= '0005'),
    );
    expect(await runner.getActiveTables(ctx)).toEqual(
      expect.arrayContaining([
        'audit_entries',
        'people',
        'person_emails',
        'organisations',
        'person_organisation_links',
        'notes',
        'merge_history',
        'matters',
        'matter_parties',
        'matter_number_sequences',
        'tenant_record_sequences',
        'enquiries',
        'quotes',
        'quote_reference_sequences',
        'tasks',
        'task_linked_records',
        'notifications',
        'sign_offs',
        'recently_viewed',
        'teams',
        'employee_employment_records',
        'employee_sensitive_records',
        'employee_migration_reports',
        'tenant_rbac_configs',
        'firm_profiles',
        'choice_lists',
        'choice_values',
        'custom_field_definitions',
        'tenant_module_configs',
        'pms_links',
        'pms_extract_metadata',
        'pms_fee_earners',
        'pms_clients',
        'pms_matters',
        'pms_matter_financials',
        'pms_fee_estimates',
        'pms_invoices',
        'pms_payments',
        'pms_time_entries',
        'pms_disbursements',
        'pms_client_account_entries',
        'pms_credit_control_log',
        'job_runs',
        'client_rate_overrides',
        'matter_rate_overrides',
        'register_records',
        'register_transitions',
        'register_reminder_states',
      ]),
    );
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
    const appliedBefore = await runner.listAppliedMigrations(ctx);
    for (const m of [...appliedBefore].reverse()) {
      expect(await runner.rollbackVersion(ctx, m.version)).toBe(true);
    }
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
    const versionsDesc = CORE_TENANT_MIGRATIONS.map((m) => m.version).reverse();
    const versionsAfter0006 = versionsDesc.filter((v) => v > '0006');
    for (const v of versionsDesc) {
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

    for (const v of versionsAfter0006) {
      expect(await runner.rollbackVersion(ctx, v)).toBe(true);
    }
    expect(await runner.rollbackVersion(ctx, '0006')).toBe(true);
    expect(await readTemplateFks()).toEqual(bothKeys);

    const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    expect(reapplied.map((m) => m.version)).toEqual([
      '0006',
      ...[...versionsAfter0006].reverse(),
    ]);
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
      ...CORE_TENANT_MIGRATIONS.at(-1)!,
      upSql: 'SELECT * FROM nonexistent_relation_r403;',
    };

    const preCleanRunner = new TenantMigrationRunner();
    for (const v of [...CORE_TENANT_MIGRATIONS.map((m) => m.version)].reverse()) {
      await preCleanRunner.rollbackVersion(makeTestTenantContext('mig-partial-fail-a'), v);
      await preCleanRunner.rollbackVersion(makeTestTenantContext('mig-partial-ok-b'), v);
    }
    const summary = await runMigrateJobSweep({
      registry,
      migrationsByTenant: {
        'mig-partial-fail-a': [
          ...CORE_TENANT_MIGRATIONS.slice(0, -1),
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
    const ctx = buildSystemJobTenantContext({ tenantConfig, jobKey: 'store-import' });

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
      ctx,
      store: seed,
      modules: ['documents', 'document-store', 'key-dates'],
      clearFirst: true,
    });
    const secondImport = await importFirmStoreModulesToPostgres({
      ctx,
      store: seed,
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

  it('R472: re-provisioning cluster roles leaves existing runtime_login and migrate_login SCRAM verifiers unchanged and pooled connections succeed', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'tenant-a', environment: 'test' }],
    });

    const pg = await loadPgModule();
    const host =
      process.env.PLATFORM_POSTGRES_MIGRATE_HOST?.trim() ||
      process.env.PLATFORM_POSTGRES_HOST?.trim() ||
      '127.0.0.1';
    const port = Number(process.env.PLATFORM_POSTGRES_MIGRATE_PORT || 5432);
    const adminUser = process.env.PLATFORM_POSTGRES_ADMIN_USER?.trim() || 'postgres';
    const adminPassword = process.env.PLATFORM_POSTGRES_ADMIN_PASSWORD?.trim() || 'postgres';

    const readLoginVerifiers = async (): Promise<Record<string, string>> => {
      const client = new pg.Client({
        host,
        port,
        database: 'postgres',
        user: adminUser,
        password: adminPassword,
      });
      await client.connect();
      try {
        const res = await client.query<{ rolname: string; rolpassword: string }>(
          `SELECT rolname, rolpassword
             FROM pg_authid
            WHERE rolname IN ('runtime_login', 'migrate_login')
            ORDER BY rolname`,
        );
        return Object.fromEntries(res.rows.map((r) => [r.rolname, r.rolpassword]));
      } finally {
        await client.end();
      }
    };

    const verifiersBefore = await readLoginVerifiers();
    expect(verifiersBefore.runtime_login).toMatch(/^SCRAM-SHA-256\$/);
    expect(verifiersBefore.migrate_login).toMatch(/^SCRAM-SHA-256\$/);

    // Re-provision without rotatePasswords: verifiers in pg_authid must be identical (no salt rotation).
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'tenant-a', environment: 'test' }],
    });

    const verifiersAfter = await readLoginVerifiers();
    expect(verifiersAfter.runtime_login).toBe(verifiersBefore.runtime_login);
    expect(verifiersAfter.migrate_login).toBe(verifiersBefore.migrate_login);

    // Pooled runtime connection succeeds after re-provisioning.
    const ctx = makeTestTenantContext('tenant-a');
    const poolMgr = new TenantPostgresPoolManager();
    try {
      const repo = new DiagnosticProbeRepository({ poolManager: poolMgr });
      const probe = await repo.readCurrentRoleAndBackendPid(ctx);
      expect(probe.currentUser).toBe('role_tenant_tenant_a_test');
      expect(probe.sessionUser).toBe('runtime_login');
    } finally {
      await poolMgr.closeAllPools();
    }

    // CI workflow and docker-compose build userlist.txt from env passwords rather than copying pg_authid/pg_shadow SCRAM verifiers.
    const ciYml = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ciYml).not.toContain('FROM pg_authid');
    expect(ciYml).toContain('PLATFORM_POSTGRES_RUNTIME_PASSWORD');
    expect(ciYml).toContain('PLATFORM_POSTGRES_MIGRATE_PASSWORD');

    const composeYml = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.postgres.yml'), 'utf8');
    expect(composeYml).not.toContain('FROM pg_shadow');
    expect(composeYml).toContain('PLATFORM_POSTGRES_RUNTIME_PASSWORD');
    expect(composeYml).toContain('PLATFORM_POSTGRES_MIGRATE_PASSWORD');
  });

  it('rejects a modified 0008 checksum with TENANCY_MIGRATION_CHECKSUM_MISMATCH and carries no acceptedPriorChecksums on 0008 (R463)', async () => {
    expect(NON_LIVE_AUDIT_RESET_MIGRATION_0008.acceptedPriorChecksums).toBeUndefined();

    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'mig-checksum-0008', environment: 'test' }],
    });
    const ctx = makeTestTenantContext('mig-checksum-0008');
    const runner = new TenantMigrationRunner();
    const appliedBefore = await runner.listAppliedMigrations(ctx);
    for (const m of [...appliedBefore].reverse()) {
      expect(await runner.rollbackVersion(ctx, m.version)).toBe(true);
    }
    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

    const expected0008Checksum = computeMigrationChecksum(
      NON_LIVE_AUDIT_RESET_MIGRATION_0008,
    );
    const staleDev0008Checksum =
      'ee6d64d00491d8ec88618161273cdce5206997c711e387d3b93c5888acd48dc0';
    expect(staleDev0008Checksum).not.toBe(expected0008Checksum);

    const client = await createDirectMigrationClient({ ctx });
    try {
      await client.query(
        `UPDATE tenant_schema_migrations SET checksum = $1 WHERE tenant_id = $2 AND version = '0008'`,
        [staleDev0008Checksum, ctx.tenantId],
      );
    } finally {
      await client.end();
    }

    try {
      await expect(
        runner.applyUp(ctx, CORE_TENANT_MIGRATIONS),
      ).rejects.toMatchObject({
        code: 'TENANCY_MIGRATION_CHECKSUM_MISMATCH',
        message: `TENANCY_MIGRATION_CHECKSUM_MISMATCH: Migration 0008 was modified after being applied to ${ctx.postgresDatabaseName}.`,
      });
    } finally {
      // Clean recovery: roll back 0008 and re-apply so the database matches the current catalogue
      const versionsAfter0008 = CORE_TENANT_MIGRATIONS.map((m) => m.version)
        .filter((v) => v > '0008')
        .reverse();
      for (const v of versionsAfter0008) {
        expect(await runner.rollbackVersion(ctx, v)).toBe(true);
      }
      expect(await runner.rollbackVersion(ctx, '0008')).toBe(true);
      await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    }

    const appliedAfterRecovery = await runner.listAppliedMigrations(ctx);
    const mig0008 = appliedAfterRecovery.find((m) => m.version === '0008');
    expect(mig0008?.checksum).toBe(expected0008Checksum);
  });

  it('round-trips 0015_transitional_bridges_contract (up -> down -> up), dropping and back-populating matter_restriction_metadata and people.employment_json with tenant role privileges (R408)', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'mig-contract-0015', environment: 'test' }],
    });
    const ctx = makeTestTenantContext('mig-contract-0015');
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

    const store = createSeedStore();
    await importFirmStoreModulesToPostgres({
      ctx,
      store,
      modules: ['parties', 'matters', 'hr'],
      clearFirst: true,
      tenantConfig: {
        ...tenantRuntimePkg.getActiveTenantConfiguration(),
        tenantId: ctx.tenantId,
      },
    });

    const client = await createDirectMigrationClient({ ctx });
    try {
      // Seed a restricted staff matter so rollback back-population of matter_restriction_metadata is verified with non-default values
      const sampleMatterId = store.matters[0]!.id;
      await client.query(
        `UPDATE public.matters
            SET is_staff_matter = TRUE,
                restricted_access_user_ids_json = $3::jsonb
          WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, sampleMatterId, JSON.stringify(['P-000001', 'P-000002'])],
      );

      // At 0015 (up), neither matter_restriction_metadata nor people.employment_json exists
      const tableAt0015 = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'matter_restriction_metadata'`,
      );
      expect(tableAt0015.rowCount).toBe(0);

      const colAt0015 = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'people' AND column_name = 'employment_json'`,
      );
      expect(colAt0015.rowCount).toBe(0);

      // Roll back dependent 0026/0025/0024/0023 -> 0021..0016 before 0015
      await expect(runner.rollbackVersion(ctx, '0015')).rejects.toThrow(
        /MIGRATION_ROLLBACK_ORDER_ERROR/,
      );
      expect(await runner.rollbackVersion(ctx, '0026')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0025')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0024')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0023')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0021')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0020')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0019')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0018')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0017')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0016')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0015')).toBe(true);

      const tableAfterDown = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'matter_restriction_metadata'`,
      );
      expect(tableAfterDown.rowCount).toBe(1);

      const colAfterDown = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'people' AND column_name = 'employment_json'`,
      );
      expect(colAfterDown.rowCount).toBe(1);

      const bridgeRow = await client.query<{
        is_restricted: boolean;
        restricted_access_user_ids: string[];
      }>(
        `SELECT is_restricted, restricted_access_user_ids
           FROM public.matter_restriction_metadata
          WHERE tenant_id = $1 AND matter_id = $2`,
        [ctx.tenantId, sampleMatterId],
      );
      expect(bridgeRow.rows[0]).toEqual({
        is_restricted: true,
        restricted_access_user_ids: ['P-000001', 'P-000002'],
      });

      const empBackpopulated = await client.query<{
        id: string;
        employment_json: { jobTitle?: string } | null;
      }>(
        `SELECT id, employment_json
           FROM public.people
          WHERE tenant_id = $1 AND id = 'P-000001'`,
        [ctx.tenantId],
      );
      expect(empBackpopulated.rows[0]?.employment_json?.jobTitle).toBeTruthy();

      // Verify role_tenant_<slug>_<env> was granted SELECT, INSERT, UPDATE, DELETE on recreated matter_restriction_metadata
      const privCheck = await client.query<{ has_select: boolean; has_insert: boolean }>(
        `SELECT
           has_table_privilege('role_tenant_mig_contract_0015_test', 'public.matter_restriction_metadata', 'SELECT') AS has_select,
           has_table_privilege('role_tenant_mig_contract_0015_test', 'public.matter_restriction_metadata', 'INSERT') AS has_insert`,
      );
      expect(privCheck.rows[0]).toEqual({ has_select: true, has_insert: true });

      // Re-apply 0015..0021, 0023..0026 -> upSql drops both bridges again and recreates state
      const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual([
        '0015',
        '0016',
        '0017',
        '0018',
        '0019',
        '0020',
        '0021',
        '0023',
        '0024',
        '0025',
        '0026',
      ]);

      const tableAfterReapply = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'matter_restriction_metadata'`,
      );
      expect(tableAfterReapply.rowCount).toBe(0);

      const colAfterReapply = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'people' AND column_name = 'employment_json'`,
      );
      expect(colAfterReapply.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('0016_negotiated_rates_expand applies client_rate_overrides & matter_rate_overrides with role privileges and reverses cleanly (up -> down -> up)', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'mig-rates-0016', environment: 'test' }],
    });
    const ctx = makeTestTenantContext('mig-rates-0016');
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

    const client = await createDirectMigrationClient({ ctx });
    try {
      const tablesUp = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('client_rate_overrides', 'matter_rate_overrides')
         ORDER BY table_name ASC`,
      );
      expect(tablesUp.rows.map((r) => r.table_name)).toEqual([
        'client_rate_overrides',
        'matter_rate_overrides',
      ]);

      const privsUp = await client.query<{ cro_ins: boolean; mro_del: boolean }>(
        `SELECT
           has_table_privilege('role_tenant_mig_rates_0016_test', 'public.client_rate_overrides', 'INSERT') AS cro_ins,
           has_table_privilege('role_tenant_mig_rates_0016_test', 'public.matter_rate_overrides', 'DELETE') AS mro_del`,
      );
      expect(privsUp.rows[0]).toEqual({ cro_ins: true, mro_del: true });

      expect(await runner.rollbackVersion(ctx, '0026')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0025')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0024')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0023')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0021')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0020')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0019')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0018')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0017')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0016')).toBe(true);
      const tablesDown = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('client_rate_overrides', 'matter_rate_overrides')`,
      );
      expect(tablesDown.rowCount).toBe(0);

      const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual([
        '0016',
        '0017',
        '0018',
        '0019',
        '0020',
        '0021',
        '0023',
        '0024',
        '0025',
        '0026',
      ]);

      const tablesReapplied = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('client_rate_overrides', 'matter_rate_overrides')
         ORDER BY table_name ASC`,
      );
      expect(tablesReapplied.rows.map((r) => r.table_name)).toEqual([
        'client_rate_overrides',
        'matter_rate_overrides',
      ]);
    } finally {
      await client.end();
    }
  });

  it('0017_registers_engine_expand creates tables & sequences, backfills sign_offs, grants role privileges, and reverses cleanly (up -> down -> up)', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'mig-registers-0017', environment: 'test' }],
    });
    const ctx = makeTestTenantContext('mig-registers-0017');
    const runner = new TenantMigrationRunner();
    const pre0017 = CORE_TENANT_MIGRATIONS.filter((m) => m.version < '0017');
    await runner.applyUp(ctx, pre0017);
    await runner.rollbackVersion(ctx, '0026');
    await runner.rollbackVersion(ctx, '0025');
    await runner.rollbackVersion(ctx, '0024');
    await runner.rollbackVersion(ctx, '0023');
    await runner.rollbackVersion(ctx, '0021');
    await runner.rollbackVersion(ctx, '0020');
    await runner.rollbackVersion(ctx, '0019');
    await runner.rollbackVersion(ctx, '0018');
    await runner.rollbackVersion(ctx, '0017');

    const client = await createDirectMigrationClient({ ctx });
    try {
      await client.query(`DELETE FROM public.sign_offs WHERE tenant_id = 'mig-registers-0017'`);
      await client.query(
        `INSERT INTO public.sign_offs (
          tenant_id, id, kind, status, matter_id, matter_number, title, subtitle,
          requested_by_id, assigned_approver_id, decided_by_id, amount_gbp,
          requested_at, decided_at, discussion_note, payload_json
        ) VALUES
          ('mig-registers-0017', 'SO-000001', 'write_off', 'Pending', 'M-000001', 'MAT-001', 'Write-off approval', 'Excess write-off', 'P-000002', 'P-000001', NULL, 250.50, '2026-10-01T09:00:00Z', NULL, NULL, '{"customFlag":true}'::jsonb),
          ('mig-registers-0017', 'SO-000002', 'matter_opening', 'Discussing', 'M-000002', 'MAT-002', 'High-risk opening', 'PEP review', 'P-000003', 'P-000001', NULL, NULL, '2026-10-02T10:00:00Z', NULL, 'Checking source of funds', '{}'::jsonb),
          ('mig-registers-0017', 'SO-000003', 'undertaking', 'Pending', 'M-000001', 'MAT-001', 'Discharge mortgage', 'Standard undertaking', 'P-000002', 'P-000001', NULL, NULL, '2026-10-03T11:00:00Z', NULL, NULL, '{}'::jsonb)`,
      );

      await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

      const tablesUp = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('register_records', 'register_transitions', 'register_reminder_states')
         ORDER BY table_name ASC`,
      );
      expect(tablesUp.rows.map((r) => r.table_name)).toEqual([
        'register_records',
        'register_reminder_states',
        'register_transitions',
      ]);

      const privsUp = await client.query<{
        rr_ins: boolean;
        rt_sel: boolean;
        rrs_upd: boolean;
        seq_rec: boolean;
        seq_tr: boolean;
      }>(
        `SELECT
           has_table_privilege('role_tenant_mig_registers_0017_test', 'public.register_records', 'INSERT') AS rr_ins,
           has_table_privilege('role_tenant_mig_registers_0017_test', 'public.register_transitions', 'SELECT') AS rt_sel,
           has_table_privilege('role_tenant_mig_registers_0017_test', 'public.register_reminder_states', 'UPDATE') AS rrs_upd,
           has_sequence_privilege('role_tenant_mig_registers_0017_test', 'public.tenant_register_record_id_seq', 'USAGE') AS seq_rec,
           has_sequence_privilege('role_tenant_mig_registers_0017_test', 'public.tenant_register_transition_id_seq', 'USAGE') AS seq_tr`,
      );
      expect(privsUp.rows[0]).toEqual({
        rr_ins: true,
        rt_sel: true,
        rrs_upd: true,
        seq_rec: true,
        seq_tr: true,
      });

      const backfilled = await client.query<{
        id: string;
        register_type_key: string;
        status: string;
        assigned_approver_id: string | null;
        field_values_json: Record<string, unknown>;
      }>(
        `SELECT id, register_type_key, status, assigned_approver_id, field_values_json
         FROM public.register_records
         WHERE tenant_id = 'mig-registers-0017'
         ORDER BY id ASC`,
      );
      expect(backfilled.rows).toHaveLength(3);
      expect(backfilled.rows[0]).toMatchObject({
        id: 'SO-000001',
        register_type_key: 'sign_off',
        status: 'pending_approval',
        assigned_approver_id: 'P-000001',
        field_values_json: {
          signOffKind: 'write_off',
          matterNumber: 'MAT-001',
          amountGbp: 250.5,
          customFlag: true,
        },
      });
      expect(backfilled.rows[1]).toMatchObject({
        id: 'SO-000002',
        register_type_key: 'sign_off',
        status: 'discussing',
      });
      expect(backfilled.rows[2]).toMatchObject({
        id: 'SO-000003',
        register_type_key: 'undertaking',
        status: 'open',
        assigned_approver_id: null,
      });

      // Mutate a sign_off in register_records, roll back 0017, verify sync back into sign_offs and table drop
      await client.query(
        `UPDATE public.register_records
         SET status = 'approved', decided_by_id = 'P-000001', decided_at = '2026-10-04T12:00:00Z'
         WHERE tenant_id = 'mig-registers-0017' AND id = 'SO-000001'`,
      );

      expect(await runner.rollbackVersion(ctx, '0026')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0025')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0024')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0023')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0021')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0020')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0019')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0018')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0017')).toBe(true);
      const syncedSignOff = await client.query<{
        status: string;
        decided_by_id: string | null;
        payload_json: Record<string, unknown>;
      }>(
        `SELECT status, decided_by_id, payload_json
         FROM public.sign_offs
         WHERE tenant_id = 'mig-registers-0017' AND id = 'SO-000001'`,
      );
      expect(syncedSignOff.rows[0]).toMatchObject({
        status: 'Approved',
        decided_by_id: 'P-000001',
        payload_json: { customFlag: true },
      });

      const tablesDown = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('register_records', 'register_transitions', 'register_reminder_states')`,
      );
      expect(tablesDown.rowCount).toBe(0);

      const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual([
        '0017',
        '0018',
        '0019',
        '0020',
        '0021',
        '0023',
        '0024',
        '0025',
        '0026',
      ]);
      const rebackfilled = await client.query<{ status: string }>(
        `SELECT status FROM public.register_records WHERE tenant_id = 'mig-registers-0017' AND id = 'SO-000001'`,
      );
      expect(rebackfilled.rows[0]?.status).toBe('approved');
    } finally {
      await client.end();
    }
  });

  it('0018_tenant_search_indexes_expand installs pg_trgm and IMMUTABLE GIN search indexes and reverses cleanly (up -> down -> up)', async () => {
    const tenantId = 'mig-search-0018';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId, environment: 'test' }],
    });
    const ctx = makeTestTenantContext(tenantId);
    const runner = new TenantMigrationRunner();

    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

    const client = await createDirectMigrationClient({ ctx });
    try {
      const extRes = await client.query<{ extname: string }>(
        `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`,
      );
      expect(extRes.rowCount).toBe(1);

      const expectedIndexes = [
        'idx_document_links_tenant_document',
        'idx_search_people_fts',
        'idx_search_people_trgm',
        'idx_search_person_emails_trgm',
        'idx_search_organisations_fts',
        'idx_search_organisations_trgm',
        'idx_search_matters_fts',
        'idx_search_matters_trgm',
        'idx_search_enquiries_fts',
        'idx_search_enquiries_trgm',
        'idx_search_quotes_fts',
        'idx_search_quotes_trgm',
        'idx_search_tasks_fts',
        'idx_search_tasks_trgm',
        'idx_search_documents_fts',
        'idx_search_documents_trgm',
        'idx_search_key_dates_fts',
        'idx_search_key_dates_trgm',
        'idx_search_register_records_fts',
        'idx_search_register_records_trgm',
      ];

      const idxUp = await client.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = ANY($1::text[])`,
        [expectedIndexes],
      );
      expect(idxUp.rows.map((r) => r.indexname).sort()).toEqual(
        [...expectedIndexes].sort(),
      );

      expect(await runner.rollbackVersion(ctx, '0026')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0025')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0024')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0023')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0021')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0020')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0019')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0018')).toBe(true);

      const idxDown = await client.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = ANY($1::text[])`,
        [expectedIndexes],
      );
      expect(idxDown.rowCount).toBe(0);

      const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual([
        '0018',
        '0019',
        '0020',
        '0021',
        '0023',
        '0024',
        '0025',
        '0026',
      ]);

      const idxReapplied = await client.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = ANY($1::text[])`,
        [expectedIndexes],
      );
      expect(idxReapplied.rows.map((r) => r.indexname).sort()).toEqual(
        [...expectedIndexes].sort(),
      );
    } finally {
      await client.end();
    }
  });

  it('0019_email_outbox_and_preferences_expand creates email_outbox & user_notification_preferences with tenant role grants and reverses cleanly (up -> down -> up)', async () => {
    const tenantId = 'mig-email-0019';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId, environment: 'test' }],
    });
    const ctx = makeTestTenantContext(tenantId);
    const runner = new TenantMigrationRunner();

    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

    const client = await createDirectMigrationClient({ ctx });
    try {
      const tablesUp = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('email_outbox', 'user_notification_preferences')
          ORDER BY table_name ASC`,
      );
      expect(tablesUp.rows.map((r) => r.table_name)).toEqual([
        'email_outbox',
        'user_notification_preferences',
      ]);

      const privs = await client.query<{ out_ins: boolean; pref_upd: boolean }>(
        `SELECT
           has_table_privilege('role_tenant_mig_email_0019_test', 'public.email_outbox', 'INSERT') AS out_ins,
           has_table_privilege('role_tenant_mig_email_0019_test', 'public.user_notification_preferences', 'UPDATE') AS pref_upd`,
      );
      expect(privs.rows[0]).toEqual({ out_ins: true, pref_upd: true });

      expect(await runner.rollbackVersion(ctx, '0026')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0025')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0023')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0021')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0020')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0019')).toBe(true);

      const tablesDown = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('email_outbox', 'user_notification_preferences')`,
      );
      expect(tablesDown.rowCount).toBe(0);

      const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual([
        '0019',
        '0020',
        '0021',
        '0023',
        '0025',
        '0026',
      ]);

      const tablesReapplied = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('email_outbox', 'user_notification_preferences')
          ORDER BY table_name ASC`,
      );
      expect(tablesReapplied.rows.map((r) => r.table_name)).toEqual([
        'email_outbox',
        'user_notification_preferences',
      ]);
    } finally {
      await client.end();
    }
  });

  it('0020_teams_outbox_and_digests_expand creates teams_activity_outbox, adds notifications digest_sent_at/matter_id + partial index with tenant role grants, and reverses cleanly (up -> down -> up)', async () => {
    const tenantId = 'mig-teams-0020';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId, environment: 'test' }],
    });
    const ctx = makeTestTenantContext(tenantId);
    const runner = new TenantMigrationRunner();

    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

    const client = await createDirectMigrationClient({ ctx });
    try {
      const tablesUp = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('teams_activity_outbox', 'notifications')
          ORDER BY table_name ASC`,
      );
      expect(tablesUp.rows.map((r) => r.table_name)).toEqual([
        'notifications',
        'teams_activity_outbox',
      ]);

      const colsUp = await client.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'notifications'
            AND column_name IN ('digest_sent_at', 'matter_id')
          ORDER BY column_name ASC`,
      );
      expect(colsUp.rows.map((r) => r.column_name)).toEqual([
        'digest_sent_at',
        'matter_id',
      ]);

      const idxUp = await client.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'idx_notifications_undigested'`,
      );
      expect(idxUp.rowCount).toBe(1);

      const privs = await client.query<{ teams_ins: boolean; ntf_upd: boolean }>(
        `SELECT
           has_table_privilege('role_tenant_mig_teams_0020_test', 'public.teams_activity_outbox', 'INSERT') AS teams_ins,
           has_table_privilege('role_tenant_mig_teams_0020_test', 'public.notifications', 'UPDATE') AS ntf_upd`,
      );
      expect(privs.rows[0]).toEqual({ teams_ins: true, ntf_upd: true });

      expect(await runner.rollbackVersion(ctx, '0026')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0025')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0021')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0020')).toBe(true);

      const teamsDown = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'teams_activity_outbox'`,
      );
      expect(teamsDown.rowCount).toBe(0);

      const colsDown = await client.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'notifications'
            AND column_name IN ('digest_sent_at', 'matter_id')`,
      );
      expect(colsDown.rowCount).toBe(0);

      const idxDown = await client.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'idx_notifications_undigested'`,
      );
      expect(idxDown.rowCount).toBe(0);

      const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual(['0020', '0021', '0025', '0026']);

      const teamsReapplied = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'teams_activity_outbox'`,
      );
      expect(teamsReapplied.rowCount).toBe(1);

      const privsAfterReapply = await client.query<{ teams_upd: boolean; seq_usage: boolean }>(
        `SELECT
           has_table_privilege('role_tenant_mig_teams_0020_test', 'public.teams_activity_outbox', 'UPDATE') AS teams_upd,
           has_sequence_privilege('role_tenant_mig_teams_0020_test', 'public.tenant_teams_outbox_id_seq', 'USAGE') AS seq_usage`,
      );
      expect(privsAfterReapply.rows[0]).toEqual({ teams_upd: true, seq_usage: true });
    } finally {
      await client.end();
    }
  });

  it('R604, R619 & R621: 0021 backfills canonical choice systemKeys and Referred/Draft task triggers without touching custom teams, revokes audit table privileges, avoids duplicate systemKeys, and reverses value-matched rows cleanly', async () => {
    expect(Number(CORE_REQUIRED_SCHEMA_VERSION)).toBeGreaterThanOrEqual(22);
    const tenantId = 'mig-backfill-0021';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId, environment: 'test' }],
    });
    const ctx = makeTestTenantContext(tenantId);
    const runner = new TenantMigrationRunner();
    const catRepo = new TenantCatalogueRepository();
    const hrRepo = new TenantHrAndRbacRepository();
    const taskRepo = new TenantTaskWorkflowRepository();

    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    expect(await runner.rollbackVersion(ctx, '0026')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0025')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0021')).toBe(true);

    // Seed pre-0021 rows via direct migration client (runtime repos refuse < 0021 with TENANT_SCHEMA_NOT_READY)
    const client = await createDirectMigrationClient({ ctx });
    try {
      await client.query(
        `DELETE FROM public.tasks WHERE tenant_id = $1 AND id IN ('TSK-000099','TSK-R621-REVIEW')`,
        [tenantId],
      );
      await client.query(
        `DELETE FROM public.matters WHERE tenant_id = $1 AND id IN ('M-LEGACY','M-REFERRED')`,
        [tenantId],
      );
      await client.query(
        `DELETE FROM public.teams WHERE tenant_id = $1 AND id IN ('TM-000008','TM-000009','TM-000010','TM-000006','TM-CUST-1')`,
        [tenantId],
      );
      await client.query(
        `DELETE FROM public.choice_values WHERE tenant_id = $1 AND id IN ('employee_role.partner','employee_role.support_staff','risk_rating.high','risk_rating.custom_preserved','risk_rating.preexisting_low','risk_rating.low')`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO public.choice_lists (tenant_id, key, label, description, system_locked, metadata_json)
         VALUES
           ($1, 'employee_role', 'Employee role', 'Roles', TRUE, '{"group":"system","appliesTo":["employee"],"systemManaged":true}'::jsonb),
           ($1, 'risk_rating', 'Risk rating', 'Risk', FALSE, '{"group":"taxonomy","appliesTo":["matter"],"systemManaged":false}'::jsonb)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO public.choice_values (tenant_id, id, list_key, label, sort_order, active, metadata_json)
         VALUES
           ($1, 'employee_role.partner', 'employee_role', 'Equity Partner', 1, TRUE, '{}'::jsonb),
           ($1, 'employee_role.support_staff', 'employee_role', 'Legal Support', 2, TRUE, '{}'::jsonb),
           ($1, 'risk_rating.high', 'risk_rating', 'High Risk', 1, TRUE, '{}'::jsonb),
           ($1, 'risk_rating.custom_preserved', 'risk_rating', 'Custom Preserved', 2, TRUE, '{"systemKey":"custom_admin_key"}'::jsonb),
           ($1, 'risk_rating.preexisting_low', 'risk_rating', 'Custom Low Already Claimed', 3, TRUE, '{"systemKey":"low"}'::jsonb),
           ($1, 'risk_rating.low', 'risk_rating', 'Standard Low', 4, TRUE, '{}'::jsonb)`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO public.teams (tenant_id, id, name, description, active, created_by_id, updated_by_id, member_ids_json, lead_ids_json, practice_area_ids_json, payload_json)
         VALUES
           ($1, 'TM-000008', 'Intake', 'Firm Intake Team', TRUE, 'system', 'system', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb),
           ($1, 'TM-CUST-1', 'Corporate North', 'Custom Firm Org Team', TRUE, 'system', 'system', '[]'::jsonb, '[]'::jsonb, '["work_type.corporate_and_commercial"]'::jsonb, '{}'::jsonb)`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO public.matters (tenant_id, id, matter_number, title, client_id, practice_area_id, status_id, conflict_check_status, conflict_check_record_json)
         VALUES
           ($1, 'M-LEGACY', 'MAT-LEGACY', 'Legacy Draft Matter', 'O-1', 'work_type.corporate_and_commercial', 'matter_status.prospective_enquiry', 'Draft', '{"status":"In progress","savedDraftAtDisplay":"20 Nov 2026"}'::jsonb),
           ($1, 'M-REFERRED', 'MAT-REFERRED', 'Legacy Referred Matter', 'O-1', 'work_type.corporate_and_commercial', 'matter_status.prospective_enquiry', 'Pending conflict review', '{"status":"Referred","reviewerMessage":"Legacy escalate"}'::jsonb)`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO public.tasks (tenant_id, id, reference, title, description, status, task_type_id, priority_id, due_at, assigned_team_id, assigned_person_id, auto_trigger, created_by_id, updated_by_id, linked_records_json, profile_json)
         VALUES
           ($1, 'TSK-000099', 'TSK-000099', 'Custom Draft Task Name Without Prefix', 'Custom draft description', 'To do', 'task_type.conflict_check', 'task_priority.high', '2026-11-20', NULL, 'P-000001', NULL, 'P-000001', 'P-000001', '[{"recordType":"matter","recordId":"M-LEGACY"}]'::jsonb, '{}'::jsonb),
           ($1, 'TSK-R621-REVIEW', 'TSK-R621-REVIEW', 'Non-standard review title', 'Pre-upgrade referred task', 'In progress', 'task_type.conflict_check', 'task_priority.high', '2026-11-20', NULL, 'P-000003', NULL, 'P-000001', 'P-000001', '[{"recordType":"matter","recordId":"M-REFERRED"}]'::jsonb, '{}'::jsonb)`,
        [tenantId],
      );

      const applied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
      expect(applied.map((m) => m.version)).toEqual(['0021', '0025', '0026']);

      // R619: Tenant runtime role has ZERO privileges on migration_0021_backfill_audit
      const dbRoleRes = await client.query<{
        priv_sel: boolean;
        priv_ins: boolean;
        priv_upd: boolean;
        priv_del: boolean;
      }>(
        `SELECT
           has_table_privilege('role_tenant_' || substring(current_database() from '^pg_tenant_(.+)$'), 'public.migration_0021_backfill_audit', 'SELECT') AS priv_sel,
           has_table_privilege('role_tenant_' || substring(current_database() from '^pg_tenant_(.+)$'), 'public.migration_0021_backfill_audit', 'INSERT') AS priv_ins,
           has_table_privilege('role_tenant_' || substring(current_database() from '^pg_tenant_(.+)$'), 'public.migration_0021_backfill_audit', 'UPDATE') AS priv_upd,
           has_table_privilege('role_tenant_' || substring(current_database() from '^pg_tenant_(.+)$'), 'public.migration_0021_backfill_audit', 'DELETE') AS priv_del`,
      );
      expect(dbRoleRes.rows[0]).toEqual({
        priv_sel: false,
        priv_ins: false,
        priv_upd: false,
        priv_del: false,
      });

      const valuesAfter = await catRepo.listAllChoiceValues<
        TenantChoiceValueRecord & { systemKey?: string }
      >(ctx);
      expect(valuesAfter.find((v) => v.id === 'employee_role.partner')?.systemKey).toBe('partner');
      expect(valuesAfter.find((v) => v.id === 'employee_role.support_staff')?.systemKey).toBe('support_staff');
      expect(valuesAfter.find((v) => v.id === 'risk_rating.high')?.systemKey).toBe('high');
      expect(valuesAfter.find((v) => v.id === 'risk_rating.custom_preserved')?.systemKey).toBe('custom_admin_key');
      // R619: Duplicate systemKey 'low' is NOT written to risk_rating.low because risk_rating.preexisting_low already holds it
      expect(valuesAfter.find((v) => v.id === 'risk_rating.low')?.systemKey).toBeUndefined();

      // R619: 0021 does NOT modify any teams or stamp firm-specific DEPT-*/TPG-* IDs or display-name systemKeys
      const teamsAfter = await hrRepo.listAllTeams<Team>(ctx);
      expect(teamsAfter.find((t) => t.id === 'TM-000008')?.systemKey).toBeUndefined();
      expect(teamsAfter.find((t) => t.id === 'TM-000008')?.departmentId).toBeUndefined();
      expect(teamsAfter.find((t) => t.id === 'TM-CUST-1')?.departmentId).toBeUndefined();
      expect(teamsAfter.find((t) => t.id === 'TM-CUST-1')?.orgTeamId).toBeUndefined();
      // Configured fallbackTeamId routes when no team holds 'intake'; with neither, returns team: null
      expect(resolveRoutedTeam('work_type.unknown', teamsAfter, 'TM-CUST-1')).toEqual({
        team: teamsAfter.find((t) => t.id === 'TM-CUST-1'),
        isFallbackIntake: true,
      });
      expect(resolveRoutedTeam('work_type.unknown', teamsAfter, null)).toEqual({
        team: null,
        isFallbackIntake: false,
      });

      // R621: Both draft and referred conflict tasks are backfilled by matter linkage & status without title matching
      const draftTaskAfter = await taskRepo.getTaskById(ctx, 'TSK-000099', {
        includeRestricted: true,
      });
      expect(draftTaskAfter?.autoTrigger).toBe('conflict_check_draft');
      const reviewTaskAfter = await taskRepo.getTaskById(ctx, 'TSK-R621-REVIEW', {
        includeRestricted: true,
      });
      expect(reviewTaskAfter?.autoTrigger).toBe('conflict_check_review');

      // Simulate admin changing employee_role.partner's backfilled systemKey before rolling back 0021
      await client.query(
        `UPDATE public.choice_values
            SET metadata_json = jsonb_set(metadata_json, '{systemKey}', '"admin_partner_override"'::jsonb, true)
          WHERE tenant_id = $1 AND id = 'employee_role.partner'`,
        [tenantId],
      );

      // Reversal removes ONLY values that still match what 0021 wrote (leaving admin override & pre-existing keys untouched)
      expect(await runner.rollbackVersion(ctx, '0026')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0025')).toBe(true);
      expect(await runner.rollbackVersion(ctx, '0021')).toBe(true);
      const valuesDown = await client.query<{ id: string; metadata_json: { systemKey?: string } }>(
        `SELECT id, metadata_json FROM public.choice_values WHERE tenant_id = $1 AND id IN ('employee_role.partner', 'employee_role.support_staff', 'risk_rating.custom_preserved')`,
        [tenantId],
      );
      expect(valuesDown.rows.find((v) => v.id === 'employee_role.support_staff')?.metadata_json?.systemKey).toBeUndefined();
      expect(valuesDown.rows.find((v) => v.id === 'employee_role.partner')?.metadata_json?.systemKey).toBe('admin_partner_override');
      expect(valuesDown.rows.find((v) => v.id === 'risk_rating.custom_preserved')?.metadata_json?.systemKey).toBe('custom_admin_key');

      const tasksDown = await client.query<{ id: string; auto_trigger: string | null }>(
        `SELECT id, auto_trigger FROM public.tasks WHERE tenant_id = $1 AND id IN ('TSK-000099', 'TSK-R621-REVIEW')`,
        [tenantId],
      );
      expect(tasksDown.rows.find((t) => t.id === 'TSK-000099')?.auto_trigger).toBeNull();
      expect(tasksDown.rows.find((t) => t.id === 'TSK-R621-REVIEW')?.auto_trigger).toBeNull();

      // Clean up admin override to verify clean re-up round trip
      await client.query(
        `UPDATE public.choice_values SET metadata_json = '{}'::jsonb WHERE tenant_id = $1 AND id = 'employee_role.partner'`,
        [tenantId],
      );
      const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual(['0021', '0025', '0026']);
    } finally {
      await client.end();
    }
  });

  it('R635: 0021 tags at most the most recent open conflict-check task per matter, leaves older/other tasks untouched, and supports task_linked_records across two tenants', async () => {
    const tenantAlpha = 'mig-r635-alpha';
    const tenantBravo = 'mig-r635-bravo';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });
    const ctxAlpha = makeTestTenantContext(tenantAlpha);
    const ctxBravo = makeTestTenantContext(tenantBravo);
    const runner = new TenantMigrationRunner();
    const taskRepo = new TenantTaskWorkflowRepository();

    await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
    await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);
    expect(await runner.rollbackVersion(ctxAlpha, '0026')).toBe(true);
    expect(await runner.rollbackVersion(ctxBravo, '0026')).toBe(true);
    expect(await runner.rollbackVersion(ctxAlpha, '0025')).toBe(true);
    expect(await runner.rollbackVersion(ctxBravo, '0025')).toBe(true);
    expect(await runner.rollbackVersion(ctxAlpha, '0021')).toBe(true);
    expect(await runner.rollbackVersion(ctxBravo, '0021')).toBe(true);

    const clientAlpha = await createDirectMigrationClient({ ctx: ctxAlpha });
    const clientBravo = await createDirectMigrationClient({ ctx: ctxBravo });
    try {
      await clientAlpha.query(
        `DELETE FROM public.task_linked_records WHERE tenant_id = $1`,
        [tenantAlpha],
      );
      await clientAlpha.query(
        `DELETE FROM public.tasks WHERE tenant_id = $1 AND id IN ('TSK-R635-OLD','TSK-R635-NEW')`,
        [tenantAlpha],
      );
      await clientAlpha.query(
        `DELETE FROM public.matters WHERE tenant_id = $1 AND id IN ('M-R635-REF')`,
        [tenantAlpha],
      );
      await clientAlpha.query(
        `INSERT INTO public.matters (tenant_id, id, matter_number, title, client_id, practice_area_id, status_id, conflict_check_status, conflict_check_record_json)
         VALUES ($1, 'M-R635-REF', 'MAT-R635-1', 'Alpha Referred Matter', 'O-1', 'work_type.corporate_and_commercial', 'matter_status.prospective_enquiry', 'Pending conflict review', '{"status":"Referred","reviewerMessage":"Two open tasks"}'::jsonb)`,
        [tenantAlpha],
      );
      await clientAlpha.query(
        `INSERT INTO public.tasks (tenant_id, id, reference, title, description, status, task_type_id, priority_id, due_at, assigned_team_id, assigned_person_id, auto_trigger, created_by_id, updated_by_id, created_at, linked_records_json, profile_json)
         VALUES
           ($1, 'TSK-R635-OLD', 'TSK-R635-OLD', 'User-created conflict task', 'Older open conflict task', 'To do', 'task_type.conflict_check', 'task_priority.normal', '2026-11-20', NULL, 'P-000001', NULL, 'P-000001', 'P-000001', '2026-11-01T10:00:00.000Z'::timestamptz, '[{"recordType":"matter","recordId":"M-R635-REF"}]'::jsonb, '{}'::jsonb),
           ($1, 'TSK-R635-NEW', 'TSK-R635-NEW', 'Latest conflict referral task', 'Newest open conflict task', 'In progress', 'task_type.conflict_check', 'task_priority.high', '2026-11-20', NULL, 'P-000003', NULL, 'P-000001', 'P-000001', '2026-11-10T10:00:00.000Z'::timestamptz, '[]'::jsonb, '{}'::jsonb)`,
        [tenantAlpha],
      );
      await clientAlpha.query(
        `INSERT INTO public.task_linked_records (tenant_id, task_id, record_type, record_id)
         VALUES ($1, 'TSK-R635-NEW', 'matter', 'M-R635-REF')`,
        [tenantAlpha],
      );

      await clientBravo.query(
        `DELETE FROM public.task_linked_records WHERE tenant_id = $1`,
        [tenantBravo],
      );
      await clientBravo.query(
        `DELETE FROM public.tasks WHERE tenant_id = $1 AND id IN ('TSK-R635-B-OPEN','TSK-R635-B-DONE')`,
        [tenantBravo],
      );
      await clientBravo.query(
        `DELETE FROM public.matters WHERE tenant_id = $1 AND id IN ('M-R635-BRAVO')`,
        [tenantBravo],
      );
      await clientBravo.query(
        `INSERT INTO public.matters (tenant_id, id, matter_number, title, client_id, practice_area_id, status_id, conflict_check_status, conflict_check_record_json)
         VALUES ($1, 'M-R635-BRAVO', 'MAT-R635-B', 'Bravo Draft TLR Matter', 'O-1', 'work_type.corporate_and_commercial', 'matter_status.prospective_enquiry', 'Draft', '{"status":"In progress","savedDraftAtDisplay":"20 Nov 2026"}'::jsonb)`,
        [tenantBravo],
      );
      await clientBravo.query(
        `INSERT INTO public.tasks (tenant_id, id, reference, title, description, status, task_type_id, priority_id, due_at, assigned_team_id, assigned_person_id, auto_trigger, created_by_id, updated_by_id, created_at, linked_records_json, profile_json)
         VALUES
           ($1, 'TSK-R635-B-OPEN', 'TSK-R635-B-OPEN', 'Bravo Draft Linked Task', 'Linked solely via task_linked_records', 'To do', 'task_type.conflict_check', 'task_priority.normal', '2026-11-20', NULL, 'P-000001', NULL, 'P-000001', 'P-000001', '2026-11-05T10:00:00.000Z'::timestamptz, '[]'::jsonb, '{}'::jsonb),
           ($1, 'TSK-R635-B-DONE', 'TSK-R635-B-DONE', 'Bravo Completed Conflict Task', 'Already Done newer task', 'Done', 'task_type.conflict_check', 'task_priority.normal', '2026-11-20', NULL, 'P-000001', NULL, 'P-000001', 'P-000001', '2026-11-12T10:00:00.000Z'::timestamptz, '[]'::jsonb, '{}'::jsonb)`,
        [tenantBravo],
      );
      await clientBravo.query(
        `INSERT INTO public.task_linked_records (tenant_id, task_id, record_type, record_id)
         VALUES
           ($1, 'TSK-R635-B-OPEN', 'matter', 'M-R635-BRAVO'),
           ($1, 'TSK-R635-B-DONE', 'matter', 'M-R635-BRAVO')`,
        [tenantBravo],
      );

      await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
      await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);

      const alphaOld = await taskRepo.getTaskById(ctxAlpha, 'TSK-R635-OLD', {
        includeRestricted: true,
      });
      const alphaNew = await taskRepo.getTaskById(ctxAlpha, 'TSK-R635-NEW', {
        includeRestricted: true,
      });
      expect(alphaNew?.autoTrigger).toBe('conflict_check_review');
      expect(alphaOld?.autoTrigger).toBeUndefined();

      const bravoOpen = await taskRepo.getTaskById(ctxBravo, 'TSK-R635-B-OPEN', {
        includeRestricted: true,
      });
      const bravoDone = await taskRepo.getTaskById(ctxBravo, 'TSK-R635-B-DONE', {
        includeRestricted: true,
      });
      expect(bravoOpen?.autoTrigger).toBe('conflict_check_draft');
      expect(bravoDone?.autoTrigger).toBeUndefined();

      // Reversal clears only what 0021 wrote in each tenant independently
      expect(await runner.rollbackVersion(ctxAlpha, '0026')).toBe(true);
      expect(await runner.rollbackVersion(ctxBravo, '0026')).toBe(true);
      expect(await runner.rollbackVersion(ctxAlpha, '0025')).toBe(true);
      expect(await runner.rollbackVersion(ctxBravo, '0025')).toBe(true);
      expect(await runner.rollbackVersion(ctxAlpha, '0021')).toBe(true);
      expect(await runner.rollbackVersion(ctxBravo, '0021')).toBe(true);
      await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
      await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);
    } finally {
      await clientAlpha.end();
      await clientBravo.end();
    }
  });

  it('R627: 0022_key_date_calendar_sync_lease_expand adds lease columns and reverses cleanly (up -> down -> up)', async () => {
    const tenantId = 'mig-lease-0022';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId, environment: 'test' }],
    });
    const ctx = makeTestTenantContext(tenantId);
    const runner = new TenantMigrationRunner();
    const client = await createDirectMigrationClient({ ctx });
    try {
      await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

      const colsUp = await client.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'key_date_calendar_syncs'
            AND column_name IN ('lease_token', 'lease_expires_at')
          ORDER BY column_name ASC`,
      );
      expect(colsUp.rows.map((r) => r.column_name)).toEqual([
        'lease_expires_at',
        'lease_token',
      ]);

      expect(await runner.rollbackVersion(ctx, '0022')).toBe(true);
      const colsDown = await client.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'key_date_calendar_syncs'
            AND column_name IN ('lease_token', 'lease_expires_at')`,
      );
      expect(colsDown.rowCount).toBe(0);

      const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual(['0022']);
      const colsReapplied = await client.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'key_date_calendar_syncs'
            AND column_name IN ('lease_token', 'lease_expires_at')
          ORDER BY column_name ASC`,
      );
      expect(colsReapplied.rows.map((r) => r.column_name)).toEqual([
        'lease_expires_at',
        'lease_token',
      ]);
    } finally {
      await client.end();
    }
  });

  it('S1-03: 0023_intake_checks_and_outbox_attachments_expand creates tables and reverses cleanly (up -> down -> up)', async () => {
    const tenantId = 'mig-s103-0023';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId, environment: 'test' }],
    });
    const ctx = makeTestTenantContext(tenantId);
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

    const activeUp = await runner.getActiveTables(ctx);
    expect(activeUp).toContain('intake_check_records');
    expect(activeUp).toContain('email_outbox_attachments');

    expect(await runner.rollbackVersion(ctx, '0026')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0025')).toBe(true);
    expect(await runner.rollbackVersion(ctx, '0023')).toBe(true);
    const activeDown = await runner.getActiveTables(ctx);
    expect(activeDown).not.toContain('intake_check_records');
    expect(activeDown).not.toContain('email_outbox_attachments');

    const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    expect(reapplied.map((m) => m.version)).toEqual(['0023', '0025', '0026']);
    const activeReapplied = await runner.getActiveTables(ctx);
    expect(activeReapplied).toContain('intake_check_records');
    expect(activeReapplied).toContain('email_outbox_attachments');

    // R668: DB CHECK constraint enforces valid outcomes per check_kind
    const client = await createDirectMigrationClient({ ctx });
    try {
      await expect(
        client.query(
          `INSERT INTO public.intake_check_records (
             tenant_id, id, check_kind, provider, subject_type, subject_id,
             outcome, recorded_by_person_id, correlation_id
           ) VALUES ($1, 'ICHK-BAD-OUTCOME', 'identity_verification', 'manual', 'person', 'P-1', 'clear', 'P-1', 'corr-1')`,
          [tenantId],
        ),
      ).rejects.toThrow(/chk_intake_check_records_outcome_by_kind|check constraint/i);
    } finally {
      await client.end();
    }
  });

  it('S1-02a: 0024_scoped_lookup_and_candidate_indexes_expand adds lookup columns & indexes and reverses cleanly (up -> down -> up)', async () => {
    const tenantId = 'mig-s102a-0024';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId, environment: 'test' }],
    });
    const ctx = makeTestTenantContext(tenantId);
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

    const client = await createDirectMigrationClient({ ctx });
    try {
      const colsUp = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'people'
           AND column_name IN ('phone_last9_keys', 'postcode_keys', 'phonetic_keys')
         ORDER BY column_name ASC`,
      );
      expect(colsUp.rows.map((r) => r.column_name)).toEqual([
        'phone_last9_keys',
        'phonetic_keys',
        'postcode_keys',
      ]);

      expect(await runner.rollbackVersion(ctx, '0024')).toBe(true);
      const colsDown = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'people'
           AND column_name IN ('phone_last9_keys', 'postcode_keys', 'phonetic_keys')`,
      );
      expect(colsDown.rowCount).toBe(0);

      const reapplied = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual(['0024']);
    } finally {
      await client.end();
    }
  });

  it('R660: 0024 backfills exact compute*LookupKeys for accented names (ŵ, ñ, ø, æ, ß) and multiple otherNames, and SQL search matches profile_json->otherNames', async () => {
    const tenantId = 'mig-s102a-r660';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId, environment: 'test' }],
    });
    const ctx = makeTestTenantContext(tenantId);
    const runner = new TenantMigrationRunner();
    const preMigrations = CORE_TENANT_MIGRATIONS.filter((m) => m.version !== '0024');
    await runner.applyUp(ctx, preMigrations);
    await runner.rollbackVersion(ctx, '0024');

    const personFixture = {
      firstName: 'Gŵyl',
      preferredName: 'Peña',
      surname: 'Sørensen-Strauß',
      otherNames: [{ name: 'Æthelred' }, { name: 'Ŵyndham' }],
      phones: [{ number: '+44 7700 900777' }],
      addresses: [{ postcode: 'CF10 1AA' }],
    };
    const orgFixture = {
      legalName: 'Peña & Gŵyl Holdings Ltd',
      otherNames: [
        { name: 'Sørensen & Strauß Ltd' },
        { name: 'Æthelred Cyf' },
        { name: 'Former Ŵestminster Co' },
      ],
      companyNumber: 'GB01234567',
      generalEmail: 'hello@pena-gwyl.example',
      mainPhone: '029 2018 0999',
      website: 'https://www.pena-gwyl.example',
      registeredAddress: { postcode: 'CF10 1AB' },
      correspondenceAddress: { postcode: 'NP20 1AA' },
      billingAddress: { postcode: 'SA1 1AA' },
    };

    const client = await createDirectMigrationClient({ ctx });
    try {
      await client.query(
        `DELETE FROM public.people WHERE tenant_id = $1 AND id = 'P-R660-1'`,
        [tenantId],
      );
      await client.query(
        `DELETE FROM public.organisations WHERE tenant_id = $1 AND id = 'O-R660-1'`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO public.people (
           tenant_id, id, first_name, preferred_name, other_names, surname,
           phones_json, addresses_json, profile_json
         ) VALUES ($1, 'P-R660-1', $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)`,
        [
          tenantId,
          personFixture.firstName,
          personFixture.preferredName,
          personFixture.otherNames.map((n) => n.name).join('; '),
          personFixture.surname,
          JSON.stringify(personFixture.phones),
          JSON.stringify(personFixture.addresses),
          JSON.stringify({ otherNames: personFixture.otherNames }),
        ],
      );
      await client.query(
        `INSERT INTO public.organisations (
           tenant_id, id, legal_name, trading_name, company_number, general_email,
           main_phone, website, registered_address_json, trading_address_json, profile_json
         ) VALUES ($1, 'O-R660-1', $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
        [
          tenantId,
          orgFixture.legalName,
          orgFixture.otherNames[0]!.name,
          orgFixture.companyNumber,
          orgFixture.generalEmail,
          orgFixture.mainPhone,
          orgFixture.website,
          JSON.stringify(orgFixture.registeredAddress),
          JSON.stringify(orgFixture.correspondenceAddress),
          JSON.stringify({
            otherNames: orgFixture.otherNames,
            billingAddress: orgFixture.billingAddress,
          }),
        ],
      );

      await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

      const personRowRes = await client.query<{
        phone_last9_keys: string[];
        postcode_keys: string[];
        phonetic_keys: string[];
      }>(
        `SELECT phone_last9_keys, postcode_keys, phonetic_keys
           FROM public.people WHERE tenant_id = $1 AND id = 'P-R660-1'`,
        [tenantId],
      );
      const expectedPersonKeys = computePersonLookupKeys(personFixture);
      expect(personRowRes.rows[0]?.phone_last9_keys).toEqual(
        expectedPersonKeys.phoneLast9Keys,
      );
      expect(personRowRes.rows[0]?.postcode_keys).toEqual(
        expectedPersonKeys.postcodeKeys,
      );
      expect(personRowRes.rows[0]?.phonetic_keys).toEqual(
        expectedPersonKeys.phoneticKeys,
      );

      const orgRowRes = await client.query<{
        norm_company_number: string;
        email_domains: string[];
        phone_last9_keys: string[];
        postcode_keys: string[];
        phonetic_keys: string[];
      }>(
        `SELECT norm_company_number, email_domains, phone_last9_keys, postcode_keys, phonetic_keys
           FROM public.organisations WHERE tenant_id = $1 AND id = 'O-R660-1'`,
        [tenantId],
      );
      const expectedOrgKeys = computeOrganisationLookupKeys(orgFixture);
      expect(orgRowRes.rows[0]?.norm_company_number).toBe(
        expectedOrgKeys.normCompanyNumber,
      );
      expect(orgRowRes.rows[0]?.email_domains).toEqual(
        expectedOrgKeys.emailDomains,
      );
      expect(orgRowRes.rows[0]?.phone_last9_keys).toEqual(
        expectedOrgKeys.phoneLast9Keys,
      );
      expect(orgRowRes.rows[0]?.postcode_keys).toEqual(
        expectedOrgKeys.postcodeKeys,
      );
      expect(orgRowRes.rows[0]?.phonetic_keys).toEqual(
        expectedOrgKeys.phoneticKeys,
      );

      // SQL duplicate search must match an organisation by a 2nd/3rd otherNames entry stored in profile_json
      const partyRepo = new TenantPartyRepository();
      const orgMatchesByFormerName = await partyRepo.findSqlDuplicateCandidates(
        ctx,
        {
          kind: 'organisation',
          legalName: 'Former Ŵestminster Co',
          fuzzy: true,
        },
      );
      expect(orgMatchesByFormerName.some((o) => o.id === 'O-R660-1')).toBe(true);

      // Second tenant isolation: Bravo sees zero records and zero backfilled rows from Alpha
      const tenantBravoId = 'mig-s102a-r660-bravo';
      await provisionPostgresClusterRolesAndDatabases({
        tenants: [{ tenantId: tenantBravoId, environment: 'test' }],
      });
      const ctxBravo = makeTestTenantContext(tenantBravoId);
      await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);
      const bravoMatches = await partyRepo.findSqlDuplicateCandidates(
        ctxBravo,
        {
          kind: 'organisation',
          legalName: 'Former Ŵestminster Co',
          fuzzy: true,
        },
      );
      expect(bravoMatches).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('R685: 0024 keyset-paginates backfill (>500 rows), is idempotent on re-run, and reverses cleanly (up -> down -> up)', async () => {
    const tenantAlpha = 'mig-s102a-r685-a';
    const tenantBravo = 'mig-s102a-r685-b';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });
    const ctxAlpha = makeTestTenantContext(tenantAlpha);
    const ctxBravo = makeTestTenantContext(tenantBravo);
    const runner = new TenantMigrationRunner();
    const preMigrations = CORE_TENANT_MIGRATIONS.filter((m) => m.version !== '0024');
    await runner.applyUp(ctxAlpha, preMigrations);
    await runner.rollbackVersion(ctxAlpha, '0024');
    await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);

    const mig0024 = CORE_TENANT_MIGRATIONS.find((m) => m.version === '0024')!;
    expect(mig0024).toBeDefined();

    const client = await createDirectMigrationClient({ ctx: ctxAlpha });
    try {
      await client.query(`DELETE FROM public.people WHERE tenant_id = $1 AND id LIKE 'P-R685-%'`, [tenantAlpha]);
      await client.query(`DELETE FROM public.organisations WHERE tenant_id = $1 AND id LIKE 'O-R685-%'`, [tenantAlpha]);

      const bulkPeople = Array.from({ length: 515 }, (_, i) => ({
        id: `P-R685-${String(i).padStart(4, '0')}`,
        firstName: `Kestrel${i}`,
        surname: i === 514 ? 'LastPagePerson' : 'PagedPerson',
        phone: `0770090${String(i).padStart(4, '0')}`,
        postcode: 'CF10 3ZZ',
      }));
      await client.query(
        `INSERT INTO public.people (
           tenant_id, id, first_name, surname, phones_json, addresses_json, profile_json
         )
         SELECT
           $1,
           v.id,
           v."firstName",
           v.surname,
           jsonb_build_array(jsonb_build_object('number', v.phone)),
           jsonb_build_array(jsonb_build_object('postcode', v.postcode)),
           '{}'::jsonb
         FROM jsonb_to_recordset($2::jsonb) AS v(
           id text,
           "firstName" text,
           surname text,
           phone text,
           postcode text
         )`,
        [tenantAlpha, JSON.stringify(bulkPeople)],
      );

      const bulkOrgs = Array.from({ length: 510 }, (_, i) => ({
        id: `O-R685-${String(i).padStart(4, '0')}`,
        legalName: i === 509 ? 'Zeta Final Page Org Ltd' : `Paged Org ${i} Ltd`,
        companyNumber: `10${String(i).padStart(6, '0')}`,
        email: `org${i}@paged-r685.example`,
        phone: `0292018${String(i).padStart(4, '0')}`,
      }));
      await client.query(
        `INSERT INTO public.organisations (
           tenant_id, id, legal_name, company_number, general_email, main_phone, profile_json
         )
         SELECT
           $1,
           v.id,
           v."legalName",
           v."companyNumber",
           v.email,
           v.phone,
           '{}'::jsonb
         FROM jsonb_to_recordset($2::jsonb) AS v(
           id text,
           "legalName" text,
           "companyNumber" text,
           email text,
           phone text
         )`,
        [tenantAlpha, JSON.stringify(bulkOrgs)],
      );

      // Apply 0024 -> spans 2 pages on both tables
      const applied = await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
      expect(applied.map((m) => m.version)).toContain('0024');

      const { computePersonLookupKeys, computeOrganisationLookupKeys } = await import('../src/tenancy/candidateKeys');
      const expectedLastPerson = computePersonLookupKeys({
        firstName: 'Kestrel514',
        surname: 'LastPagePerson',
        phones: [{ number: '07700900514' }],
        addresses: [{ postcode: 'CF10 3ZZ' }],
      });
      const expectedLastOrg = computeOrganisationLookupKeys({
        legalName: 'Zeta Final Page Org Ltd',
        companyNumber: '10000509',
        generalEmail: 'org509@paged-r685.example',
        mainPhone: '02920180509',
      });

      const lastPersonRow = await client.query<{
        phone_last9_keys: string[];
        postcode_keys: string[];
        phonetic_keys: string[];
      }>(
        `SELECT phone_last9_keys, postcode_keys, phonetic_keys FROM public.people WHERE tenant_id = $1 AND id = 'P-R685-0514'`,
        [tenantAlpha],
      );
      expect(lastPersonRow.rows[0]?.phone_last9_keys).toEqual(expectedLastPerson.phoneLast9Keys);
      expect(lastPersonRow.rows[0]?.postcode_keys).toEqual(expectedLastPerson.postcodeKeys);
      expect(lastPersonRow.rows[0]?.phonetic_keys).toEqual(expectedLastPerson.phoneticKeys);

      const lastOrgRow = await client.query<{
        norm_company_number: string | null;
        email_domains: string[];
        phonetic_keys: string[];
      }>(
        `SELECT norm_company_number, email_domains, phonetic_keys FROM public.organisations WHERE tenant_id = $1 AND id = 'O-R685-0509'`,
        [tenantAlpha],
      );
      expect(lastOrgRow.rows[0]?.norm_company_number).toBe(expectedLastOrg.normCompanyNumber);
      expect(lastOrgRow.rows[0]?.email_domains).toEqual(expectedLastOrg.emailDomains);
      expect(lastOrgRow.rows[0]?.phonetic_keys).toEqual(expectedLastOrg.phoneticKeys);

      // Re-run afterUpSql directly (idempotent: clears & repopulates cleanly without duplicating/erasing)
      await client.query(
        `UPDATE public.people SET phone_last9_keys = '{}'::text[] WHERE tenant_id = $1 AND id IN ('P-R685-0000', 'P-R685-0514')`,
        [tenantAlpha],
      );
      await mig0024.afterUpSql!(client, ctxAlpha);
      await mig0024.afterUpSql!(client, ctxAlpha);
      const repopulated = await client.query<{ id: string; phone_last9_keys: string[] }>(
        `SELECT id, phone_last9_keys FROM public.people WHERE tenant_id = $1 AND id = 'P-R685-0514'`,
        [tenantAlpha],
      );
      expect(repopulated.rows[0]?.phone_last9_keys).toEqual(expectedLastPerson.phoneLast9Keys);

      // Full down -> up round-trip preserves rows and repopulates keys across pages
      expect(await runner.rollbackVersion(ctxAlpha, '0024')).toBe(true);
      const reapplied = await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual(['0024']);

      const afterRoundTrip = await client.query<{
        phonetic_keys: string[];
        postcode_keys: string[];
      }>(
        `SELECT phonetic_keys, postcode_keys FROM public.people WHERE tenant_id = $1 AND id = 'P-R685-0514'`,
        [tenantAlpha],
      );
      expect(afterRoundTrip.rows[0]?.phonetic_keys).toEqual(expectedLastPerson.phoneticKeys);
      expect(afterRoundTrip.rows[0]?.postcode_keys).toEqual(expectedLastPerson.postcodeKeys);

      // Two-tenant isolation: Bravo has zero Alpha rows (verified via dedicated Bravo client)
      const bravoClient = await createDirectMigrationClient({
        ctx: ctxBravo,
      });
      try {
        const bravoCount = await bravoClient.query<{ cnt: string }>(
          `SELECT count(*)::text AS cnt FROM public.people WHERE tenant_id = $1`,
          [tenantBravo],
        );
        expect(Number(bravoCount.rows[0]?.cnt ?? 0)).toBe(0);
      } finally {
        await bravoClient.end();
      }
    } finally {
      await client.end();
    }
  }, 30_000);

  it('S1-04 (ADR 0039 / R743): 0025_registers_cdd_and_org_type_keys_expand round-trips cleanly, grants runtime evidence access, locks audit table, backfills 13 organisation_type keys safely, and repoints on party merge', async () => {
    const tenantAlpha = 'mig-s104-0025-alpha';
    const tenantBravo = 'mig-s104-0025-bravo';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });
    const ctxAlpha = makeTestTenantContext(tenantAlpha);
    const ctxBravo = makeTestTenantContext(tenantBravo);
    const runner = new TenantMigrationRunner();

    // 1. Pre-seed choice_values on Alpha before applying 0025, leaving 12 blank,
    //    pre-populating `trust` with a custom systemKey, and inserting a collision on `company`.
    const pre0025 = CORE_TENANT_MIGRATIONS.filter(
      (m) => m.version !== '0025' && m.version !== '0026',
    );
    await runner.applyUp(ctxAlpha, pre0025);
    await runner.rollbackVersion(ctxAlpha, '0026');
    await runner.rollbackVersion(ctxAlpha, '0025');

    const ORG_TYPE_EXPECTED: ReadonlyArray<readonly [string, string]> = [
      ['organisation_type.company', 'company'],
      ['organisation_type.plc', 'plc'],
      ['organisation_type.llp', 'llp'],
      ['organisation_type.partnership', 'partnership'],
      ['organisation_type.sole_trader', 'sole_trader'],
      ['organisation_type.charity', 'charity'],
      ['organisation_type.public_body', 'public_body'],
      ['organisation_type.law_firm', 'law_firm'],
      ['organisation_type.barristers_chambers', 'barristers_chambers'],
      ['organisation_type.supplier', 'supplier'],
      ['organisation_type.non_profit', 'non_profit'],
      ['organisation_type.insurer', 'insurer'],
      ['organisation_type.trust', 'trust'],
    ];

    const alphaDirect = await createDirectMigrationClient({ ctx: ctxAlpha });
    try {
      await alphaDirect.query(
        `DELETE FROM public.choice_values WHERE tenant_id = $1 AND list_key = 'organisation_type'`,
        [tenantAlpha],
      );
      await alphaDirect.query(
        `INSERT INTO public.choice_lists (tenant_id, key, label)
         VALUES ($1, 'organisation_type', 'Organisation type')
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [tenantAlpha],
      );
      for (const [idx, [id]] of ORG_TYPE_EXPECTED.entries()) {
        const meta =
          id === 'organisation_type.trust'
            ? { systemKey: 'custom_trust' }
            : {};
        await alphaDirect.query(
          `INSERT INTO public.choice_values (tenant_id, id, list_key, label, sort_order, active, metadata_json)
           VALUES ($1, $2, 'organisation_type', $3, $4, TRUE, $5::jsonb)`,
          [tenantAlpha, id, `Org Type ${idx}`, idx + 1, JSON.stringify(meta)],
        );
      }
      // Colliding custom entry already occupying systemKey = 'company'
      await alphaDirect.query(
        `INSERT INTO public.choice_values (tenant_id, id, list_key, label, sort_order, active, metadata_json)
         VALUES ($1, 'organisation_type.custom_company', 'organisation_type', 'Custom Company', 99, TRUE, '{"systemKey":"company"}'::jsonb)`,
        [tenantAlpha],
      );
    } finally {
      await alphaDirect.end();
    }

    // Apply 0025..0026 onto Alpha & Bravo (on Bravo insert all 13 without collisions first)
    await runner.applyUp(ctxBravo, pre0025);
    await runner.rollbackVersion(ctxBravo, '0026');
    await runner.rollbackVersion(ctxBravo, '0025');
    const bravoDirect = await createDirectMigrationClient({ ctx: ctxBravo });
    try {
      await bravoDirect.query(
        `DELETE FROM public.choice_values WHERE tenant_id = $1 AND list_key = 'organisation_type'`,
        [tenantBravo],
      );
      await bravoDirect.query(
        `INSERT INTO public.choice_lists (tenant_id, key, label)
         VALUES ($1, 'organisation_type', 'Organisation type')
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [tenantBravo],
      );
      for (const [idx, [id]] of ORG_TYPE_EXPECTED.entries()) {
        await bravoDirect.query(
          `INSERT INTO public.choice_values (tenant_id, id, list_key, label, sort_order, active, metadata_json)
           VALUES ($1, $2, 'organisation_type', $3, $4, TRUE, '{}'::jsonb)`,
          [tenantBravo, id, `Org Type ${idx}`, idx + 1],
        );
      }
    } finally {
      await bravoDirect.end();
    }

    const alphaApplied = await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
    expect(alphaApplied.map((m) => m.version)).toEqual(['0025', '0026']);
    const bravoApplied = await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);
    expect(bravoApplied.map((m) => m.version)).toEqual(['0025', '0026']);

    const poolManager = new TenantPostgresPoolManager();
    const alphaDirectAfter = await createDirectMigrationClient({ ctx: ctxAlpha });
    const bravoDirectAfter = await createDirectMigrationClient({ ctx: ctxBravo });
    try {
      // 2. Verify indexes, evidence_artifacts table, sequence, and Bravo 13/13 keys
      const activeUp = await runner.getActiveTables(ctxAlpha);
      expect(activeUp).toContain('evidence_artifacts');

      const idxRes = await alphaDirectAfter.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname IN (
             'idx_register_records_tenant_person',
             'idx_register_records_tenant_organisation',
             'idx_evidence_artifacts_tenant_subject'
           )
         ORDER BY indexname ASC`,
      );
      expect(idxRes.rows.map((r) => r.indexname)).toEqual([
        'idx_evidence_artifacts_tenant_subject',
        'idx_register_records_tenant_organisation',
        'idx_register_records_tenant_person',
      ]);

      const seqRes = await alphaDirectAfter.query<{ sequence_name: string }>(
        `SELECT sequence_name FROM information_schema.sequences
         WHERE sequence_schema = 'public'
           AND sequence_name = 'tenant_evidence_artifact_id_seq'`,
      );
      expect(seqRes.rowCount).toBe(1);

      const bravoChoices = await bravoDirectAfter.query<{
        id: string;
        sys_key: string | null;
      }>(
        `SELECT id, metadata_json->>'systemKey' AS sys_key
         FROM public.choice_values
         WHERE tenant_id = $1 AND list_key = 'organisation_type'
         ORDER BY sort_order ASC`,
        [tenantBravo],
      );
      expect(bravoChoices.rows.map((r) => [r.id, r.sys_key])).toEqual(
        ORG_TYPE_EXPECTED.map(([id, sysKey]) => [id, sysKey]),
      );

      // Alpha collision & pre-existing check
      const alphaChoices = await alphaDirectAfter.query<{
        id: string;
        sys_key: string | null;
      }>(
        `SELECT id, metadata_json->>'systemKey' AS sys_key
         FROM public.choice_values
         WHERE tenant_id = $1 AND list_key = 'organisation_type'`,
        [tenantAlpha],
      );
      const alphaChoiceMap = new Map(
        alphaChoices.rows.map((r) => [r.id, r.sys_key]),
      );
      expect(alphaChoiceMap.get('organisation_type.trust')).toBe('custom_trust');
      expect(alphaChoiceMap.get('organisation_type.company')).toBeNull();
      expect(alphaChoiceMap.get('organisation_type.custom_company')).toBe('company');
      expect(alphaChoiceMap.get('organisation_type.llp')).toBe('llp');

      // 3. Runtime role verification:
      //    - TenantEvidenceArtifactRepository works with EVD-000001 allocation without explicit GRANTs
      //    - scanStatus === 'infected' throws EVIDENCE_MALWARE_DETECTED
      //    - Runtime role cannot read public.migration_0025_backfill_audit
      const evidenceRepo = new TenantEvidenceArtifactRepository({ poolManager });
      const probeRepo = new DiagnosticProbeRepository({ poolManager });
      await evidenceRepo.clearTenantData(ctxAlpha);
      await evidenceRepo.clearTenantData(ctxBravo);

      const createdAlpha = await evidenceRepo.createArtifact(ctxAlpha, {
        blobKey: `tenant-${tenantAlpha}-test/evidence/p-merged/file1.pdf`,
        subjectType: 'person',
        subjectId: 'P-MERGED-0025',
        fileName: 'passport.pdf',
        contentType: 'application/pdf',
        byteSize: 2048,
        sha256: 'a'.repeat(64),
        scanStatus: 'clean',
        uploadedByPersonId: 'P-ACTOR-1',
      });
      expect(createdAlpha.id).toMatch(/^EVD-\d{6}$/);

      await expect(
        evidenceRepo.createArtifact(ctxAlpha, {
          blobKey: `tenant-${tenantAlpha}-test/evidence/p-merged/bad.pdf`,
          subjectType: 'person',
          subjectId: 'P-MERGED-0025',
          fileName: 'eicar.pdf',
          contentType: 'application/pdf',
          byteSize: 68,
          sha256: 'b'.repeat(64),
          scanStatus: 'infected',
          uploadedByPersonId: 'P-ACTOR-1',
        }),
      ).rejects.toThrow(/EVIDENCE_MALWARE_DETECTED/);

      await expect(
        probeRepo.readBackfill0025AuditCountAsRuntime(ctxAlpha),
      ).rejects.toThrow(/permission denied/i);

      // 4. Test executeMergeInTransaction step 12d (intake_check_records & evidence_artifacts repointing)
      await alphaDirectAfter.query(
        `DELETE FROM public.intake_check_records WHERE tenant_id = $1`,
        [tenantAlpha],
      );
      await bravoDirectAfter.query(
        `DELETE FROM public.intake_check_records WHERE tenant_id = $1`,
        [tenantBravo],
      );
      await alphaDirectAfter.query(
        `DELETE FROM public.people WHERE tenant_id = $1 AND id IN ('P-SURV-0025', 'P-MERGED-0025')`,
        [tenantAlpha],
      );
      await alphaDirectAfter.query(
        `DELETE FROM public.organisations WHERE tenant_id = $1 AND id IN ('O-SURV-0025', 'O-MERGED-0025')`,
        [tenantAlpha],
      );
      await alphaDirectAfter.query(
        `INSERT INTO public.people (tenant_id, id, first_name, surname, phones_json, addresses_json, profile_json)
         VALUES ($1, 'P-SURV-0025', 'Surv', 'Client', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb),
                ($1, 'P-MERGED-0025', 'Merg', 'Client', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
        [tenantAlpha],
      );
      await alphaDirectAfter.query(
        `INSERT INTO public.organisations (tenant_id, id, legal_name, profile_json)
         VALUES ($1, 'O-SURV-0025', 'Surv Org Ltd', '{}'::jsonb),
                ($1, 'O-MERGED-0025', 'Merg Org Ltd', '{}'::jsonb)`,
        [tenantAlpha],
      );
      await alphaDirectAfter.query(
        `INSERT INTO public.intake_check_records (
           tenant_id, id, check_kind, provider, subject_type, subject_id,
           outcome, recorded_by_person_id, correlation_id
         ) VALUES
           ($1, 'ICHK-0025-P', 'identity_verification', 'manual', 'person', 'P-MERGED-0025', 'verified', 'P-ACTOR-1', 'corr-1'),
           ($1, 'ICHK-0025-O', 'sanctions_pep', 'manual', 'organisation', 'O-MERGED-0025', 'clear', 'P-ACTOR-1', 'corr-2')`,
        [tenantAlpha],
      );
      await evidenceRepo.createArtifact(ctxAlpha, {
        blobKey: `tenant-${tenantAlpha}-test/evidence/o-merged/cert.pdf`,
        subjectType: 'organisation',
        subjectId: 'O-MERGED-0025',
        fileName: 'cert.pdf',
        contentType: 'application/pdf',
        byteSize: 1024,
        sha256: 'c'.repeat(64),
        scanStatus: 'clean',
        uploadedByPersonId: 'P-ACTOR-1',
      });
      await evidenceRepo.createArtifact(ctxBravo, {
        blobKey: `tenant-${tenantBravo}-test/evidence/p-bravo/other.pdf`,
        subjectType: 'person',
        subjectId: 'P-MERGED-0025',
        fileName: 'other.pdf',
        contentType: 'application/pdf',
        byteSize: 512,
        sha256: 'd'.repeat(64),
        scanStatus: 'clean',
        uploadedByPersonId: 'P-ACTOR-2',
      });

      const partyRepo = new TenantPartyRepository({ poolManager });
      await partyRepo.executeMergeInTransaction(ctxAlpha, {
        recordType: 'person',
        survivorId: 'P-SURV-0025',
        mergedId: 'P-MERGED-0025',
      });
      await partyRepo.executeMergeInTransaction(ctxAlpha, {
        recordType: 'organisation',
        survivorId: 'O-SURV-0025',
        mergedId: 'O-MERGED-0025',
      });

      const mergedChecksAlpha = await alphaDirectAfter.query<{
        id: string;
        subject_id: string;
      }>(
        `SELECT id, subject_id FROM public.intake_check_records
         WHERE tenant_id = $1 AND id IN ('ICHK-0025-P', 'ICHK-0025-O')
         ORDER BY id ASC`,
        [tenantAlpha],
      );
      expect(mergedChecksAlpha.rows).toEqual([
        { id: 'ICHK-0025-O', subject_id: 'O-SURV-0025' },
        { id: 'ICHK-0025-P', subject_id: 'P-SURV-0025' },
      ]);

      const personArtifacts = await evidenceRepo.listArtifactsForSubject(
        ctxAlpha,
        { subjectType: 'person', subjectId: 'P-SURV-0025' },
      );
      expect(personArtifacts.map((a) => a.fileName)).toEqual(['passport.pdf']);
      const orgArtifacts = await evidenceRepo.listArtifactsForSubject(
        ctxAlpha,
        { subjectType: 'organisation', subjectId: 'O-SURV-0025' },
      );
      expect(orgArtifacts.map((a) => a.fileName)).toEqual(['cert.pdf']);

      // Bravo untouched
      const bravoArtifacts = await evidenceRepo.listArtifactsForSubject(
        ctxBravo,
        { subjectType: 'person', subjectId: 'P-MERGED-0025' },
      );
      expect(bravoArtifacts.map((a) => a.fileName)).toEqual(['other.pdf']);

      // 5. Rollback preservation & full up -> down -> up round-trip:
      //    Admin overrides `plc` to `admin_plc`; down must keep `trust` (`custom_trust`),
      //    `custom_company` (`company`), and `plc` (`admin_plc`), while clearing `llp`.
      await alphaDirectAfter.query(
        `UPDATE public.choice_values
         SET metadata_json = jsonb_set(metadata_json, '{systemKey}', '"admin_plc"'::jsonb, true)
         WHERE tenant_id = $1 AND id = 'organisation_type.plc'`,
        [tenantAlpha],
      );

      expect(await runner.rollbackVersion(ctxAlpha, '0026')).toBe(true);
      expect(await runner.rollbackVersion(ctxAlpha, '0025')).toBe(true);
      const activeDown = await runner.getActiveTables(ctxAlpha);
      expect(activeDown).not.toContain('evidence_artifacts');

      const seqDown = await alphaDirectAfter.query(
        `SELECT 1 FROM information_schema.sequences
         WHERE sequence_schema = 'public' AND sequence_name = 'tenant_evidence_artifact_id_seq'`,
      );
      expect(seqDown.rowCount).toBe(0);

      const afterDownChoices = await alphaDirectAfter.query<{
        id: string;
        sys_key: string | null;
      }>(
        `SELECT id, metadata_json->>'systemKey' AS sys_key
         FROM public.choice_values
         WHERE tenant_id = $1 AND list_key = 'organisation_type'`,
        [tenantAlpha],
      );
      const downMap = new Map(
        afterDownChoices.rows.map((r) => [r.id, r.sys_key]),
      );
      expect(downMap.get('organisation_type.llp')).toBeNull();
      expect(downMap.get('organisation_type.trust')).toBe('custom_trust');
      expect(downMap.get('organisation_type.custom_company')).toBe('company');
      expect(downMap.get('organisation_type.plc')).toBe('admin_plc');

      const reapplied = await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual(['0025', '0026']);
    } finally {
      await alphaDirectAfter.end();
      await bravoDirectAfter.end();
      await poolManager.closeAllPools();
    }
  }, 30_000);

  it('S1-05 (ADR 0040 / R743 / R744): 0026_opening_gate_overrides_and_numbering_expand expands safely without GRANTs or unique matter_number index, backfills sequence metadata leaving duplicate rows untouched, supports override CRUD + immutability, and round-trips up -> down -> up', async () => {
    expect(Number(CORE_REQUIRED_SCHEMA_VERSION)).toBeGreaterThanOrEqual(26);
    const mig0026 = CORE_TENANT_MIGRATIONS.find((m) => m.version === '0026');
    expect(mig0026).toBeDefined();
    expect(mig0026!.upSql).not.toMatch(/\bGRANT\b/i);
    expect(mig0026!.upSql).not.toMatch(/CREATE\s+UNIQUE\s+INDEX[^;]*\bmatters\b[^;]*\bmatter_number\b/i);

    const tenantAlpha = 'mig-s105-0026-alpha';
    const tenantBravo = 'mig-s105-0026-bravo';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });
    const ctxAlpha = makeTestTenantContext(tenantAlpha);
    const ctxBravo = makeTestTenantContext(tenantBravo);
    const runner = new TenantMigrationRunner();

    const pre0026 = CORE_TENANT_MIGRATIONS.filter((m) => m.version !== '0026');
    await runner.applyUp(ctxAlpha, pre0026);
    await runner.rollbackVersion(ctxAlpha, '0026');
    await runner.applyUp(ctxBravo, pre0026);
    await runner.rollbackVersion(ctxBravo, '0026');

    const alphaDirectPre = await createDirectMigrationClient({ ctx: ctxAlpha });
    try {
      await alphaDirectPre.query(
        'DELETE FROM public.matter_opening_gate_overrides WHERE tenant_id = $1',
        [tenantAlpha],
      ).catch(() => {});
      await alphaDirectPre.query(
        'DELETE FROM public.matters WHERE tenant_id = $1',
        [tenantAlpha],
      );
      await alphaDirectPre.query(
        `INSERT INTO public.matters (
           tenant_id, id, row_version, matter_number, title, client_type, client_id,
           practice_area_id, work_type_subcategory_id, status_id, current_stage_id,
           risk_rating_id, conflict_check_status
         ) VALUES
         ($1, 'M-DUP-1', 1, 'BRI001-0003', 'Pre-0026 Duplicate One', 'organisation', 'O-000001', 'pa.1', 'wt.1', 'matter_status.active', 'stage.1', 'risk_rating.low', 'Approved'),
         ($1, 'M-DUP-2', 1, 'BRI001-0003', 'Pre-0026 Duplicate Two', 'organisation', 'O-000002', 'pa.1', 'wt.1', 'matter_status.active', 'stage.1', 'risk_rating.low', 'Approved'),
         ($1, 'M-DRAFT-1', 1, 'DRAFT-9001', 'Pre-0026 Draft Row', 'organisation', 'O-000003', 'pa.1', 'wt.1', 'matter_status.prospective', 'stage.1', 'risk_rating.low', 'Not started')`,
        [tenantAlpha],
      );
    } finally {
      await alphaDirectPre.end();
    }

    const alphaUp = await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
    expect(alphaUp.map((m) => m.version)).toEqual(['0026']);
    await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);

    const alphaDirect = await createDirectMigrationClient({ ctx: ctxAlpha });
    const poolManager = new TenantPostgresPoolManager();
    const matterRepo = new TenantMatterRepository({ poolManager });
    try {
      // Backfill populated sequence columns on non-draft matching numbers, untouched on draft, and kept duplicate matter_number intact
      const rows = await alphaDirect.query<{
        id: string;
        matter_number: string;
        number_sequence_key: string | null;
        number_sequence_value: string | null;
      }>(
        `SELECT id, matter_number, number_sequence_key, number_sequence_value::text AS number_sequence_value
         FROM public.matters
         WHERE tenant_id = $1
         ORDER BY id ASC`,
        [tenantAlpha],
      );
      expect(rows.rows).toEqual([
        {
          id: 'M-DRAFT-1',
          matter_number: 'DRAFT-9001',
          number_sequence_key: null,
          number_sequence_value: null,
        },
        {
          id: 'M-DUP-1',
          matter_number: 'BRI001-0003',
          number_sequence_key: 'BRI001',
          number_sequence_value: '3',
        },
        {
          id: 'M-DUP-2',
          matter_number: 'BRI001-0003',
          number_sequence_key: 'BRI001',
          number_sequence_value: '3',
        },
      ]);

      // Runtime override CRUD + active partial unique constraint + immutability check
      const override1 = await matterRepo.insertOpeningGateOverride(ctxAlpha, {
        matterId: 'M-DRAFT-1',
        preconditionKey: 'cdd_complete',
        reason: 'Partner urgent deadline approval for M-DRAFT-1',
        overriddenByPersonId: 'P-PARTNER-1',
      });
      expect(override1.id).toMatch(/^OVR-\d{6}$/);
      expect(override1.preconditionKey).toBe('cdd_complete');
      expect(override1.revokedAt).toBeNull();

      // Second active override for the same (matterId, preconditionKey) is rejected by partial unique index
      await expect(
        matterRepo.insertOpeningGateOverride(ctxAlpha, {
          matterId: 'M-DRAFT-1',
          preconditionKey: 'cdd_complete',
          reason: 'Duplicate active override should fail',
          overriddenByPersonId: 'P-PARTNER-2',
        }),
      ).rejects.toThrow();

      // Bravo cannot see Alpha's overrides
      expect(
        await matterRepo.listOpeningGateOverridesForMatter(ctxBravo, 'M-DRAFT-1'),
      ).toEqual([]);

      const revoked = await matterRepo.revokeOpeningGateOverride(ctxAlpha, {
        overrideId: override1.id,
        matterId: 'M-DRAFT-1',
        revokedByPersonId: 'P-PARTNER-1',
      });
      expect(revoked?.revokedByPersonId).toBe('P-PARTNER-1');
      expect(revoked?.revokedAt).toBeTruthy();

      // After revoking, a new active override for the same precondition succeeds
      const override2 = await matterRepo.insertOpeningGateOverride(ctxAlpha, {
        matterId: 'M-DRAFT-1',
        preconditionKey: 'cdd_complete',
        reason: 'Re-granted override after initial revocation',
        overriddenByPersonId: 'P-PARTNER-2',
      });
      expect(override2.id).not.toBe(override1.id);
      const allOverrides = await matterRepo.listOpeningGateOverridesForMatter(
        ctxAlpha,
        'M-DRAFT-1',
      );
      expect(allOverrides).toHaveLength(2);
      const activeOverrides = await matterRepo.listOpeningGateOverridesForMatter(
        ctxAlpha,
        'M-DRAFT-1',
        { activeOnly: true },
      );
      expect(activeOverrides.map((o) => o.id)).toEqual([override2.id]);

      // Existing permanent matterNumber cannot be altered via updateMatter (MATTER_NUMBER_IMMUTABLE)
      const loadedDup1 = await matterRepo.getMatterById(ctxAlpha, 'M-DUP-1', {
        includeRestricted: true,
      });
      expect(loadedDup1).not.toBeNull();
      await expect(
        matterRepo.updateMatter(
          ctxAlpha,
          { ...loadedDup1!, matterNumber: 'BRI001-9999' },
          loadedDup1!.rowVersion ?? 1,
        ),
      ).rejects.toMatchObject({
        code: corePkg.MATTER_NUMBER_IMMUTABLE_CODE,
      });

      // Down -> up round-trip preserves matter_number values
      expect(await runner.rollbackVersion(ctxAlpha, '0026')).toBe(true);
      const activeTablesDown = await runner.getActiveTables(ctxAlpha);
      expect(activeTablesDown).not.toContain('matter_opening_gate_overrides');
      const seqDown = await alphaDirect.query(
        `SELECT 1 FROM information_schema.sequences
         WHERE sequence_schema = 'public' AND sequence_name = 'tenant_opening_override_id_seq'`,
      );
      expect(seqDown.rowCount).toBe(0);
      const preservedMatters = await alphaDirect.query<{
        id: string;
        matter_number: string;
      }>(
        `SELECT id, matter_number FROM public.matters WHERE tenant_id = $1 ORDER BY id ASC`,
        [tenantAlpha],
      );
      expect(preservedMatters.rows.map((r) => [r.id, r.matter_number])).toEqual([
        ['M-DRAFT-1', 'DRAFT-9001'],
        ['M-DUP-1', 'BRI001-0003'],
        ['M-DUP-2', 'BRI001-0003'],
      ]);

      const reapplied = await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual(['0026']);
    } finally {
      await alphaDirect.end();
      await poolManager.closeAllPools();
    }
  }, 30_000);

  it('S1-12 (ADR 0041 / R820): 0027_pms_money_and_retainer_pence_expand converts 20 PMS columns + retainer funds to BIGINT pence (leaving wip_hours & hours DOUBLE PRECISION and payload_json untouched), verifies half-penny ties & zero-PII telemetry across two tenants, and round-trips up -> down -> up', async () => {
    expect(Number(CORE_REQUIRED_SCHEMA_VERSION)).toBeGreaterThanOrEqual(27);
    const mig0027 = CORE_TENANT_MIGRATIONS.find((m) => m.version === '0027');
    expect(mig0027).toBeDefined();
    expect(mig0027!.upSql).not.toMatch(/\bGRANT\b/i);
    expect(PMS_PENCE_MIGRATION_0027_COLUMNS).toHaveLength(20);

    const tenantAlpha = 'mig-s112-0027-alpha';
    const tenantBravo = 'mig-s112-0027-bravo';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });
    const ctxAlpha = makeTestTenantContext(tenantAlpha);
    const ctxBravo = makeTestTenantContext(tenantBravo);
    const runner = new TenantMigrationRunner();

    const pre0027 = CORE_TENANT_MIGRATIONS.filter((m) => m.version !== '0027');
    await runner.applyUp(ctxAlpha, pre0027);
    await runner.rollbackVersion(ctxAlpha, '0027');
    await runner.applyUp(ctxBravo, pre0027);
    await runner.rollbackVersion(ctxBravo, '0027');

    const alphaPayloadMarker = {
      credit_limit: 50000.25,
      annual_target_fees: 245000.75,
      note: 'Client Sensitive Title Must Never Appear In Telemetry',
    };

    const seedPre0027Tenant = async (
      ctx: TenantContext,
      multiplier: number,
      retainerText: string | null,
    ): Promise<void> => {
      const direct = await createDirectMigrationClient({ ctx });
      try {
        await direct.query('DELETE FROM public.pms_credit_control_log WHERE tenant_id = $1', [ctx.tenantId]);
        await direct.query('DELETE FROM public.pms_client_account_entries WHERE tenant_id = $1', [ctx.tenantId]);
        await direct.query('DELETE FROM public.pms_disbursements WHERE tenant_id = $1', [ctx.tenantId]);
        await direct.query('DELETE FROM public.pms_time_entries WHERE tenant_id = $1', [ctx.tenantId]);
        await direct.query('DELETE FROM public.pms_payments WHERE tenant_id = $1', [ctx.tenantId]);
        await direct.query('DELETE FROM public.pms_invoices WHERE tenant_id = $1', [ctx.tenantId]);
        await direct.query('DELETE FROM public.pms_fee_estimates WHERE tenant_id = $1', [ctx.tenantId]);
        await direct.query('DELETE FROM public.pms_matter_financials WHERE tenant_id = $1', [ctx.tenantId]);
        await direct.query('DELETE FROM public.pms_matters WHERE tenant_id = $1', [ctx.tenantId]);
        await direct.query('DELETE FROM public.pms_clients WHERE tenant_id = $1', [ctx.tenantId]);
        await direct.query('DELETE FROM public.pms_fee_earners WHERE tenant_id = $1', [ctx.tenantId]);
        await direct.query('DELETE FROM public.matters WHERE tenant_id = $1', [ctx.tenantId]);

        await direct.query(
          `INSERT INTO public.pms_fee_earners (tenant_id, fee_earner_id, name, grade, department, office, charge_out_rate, status, payload_json)
           VALUES ($1, 'FE-1', 'Gareth Davies', 'Partner', 'Corporate', 'Cardiff', $2, 'Active', $3::jsonb)`,
          [ctx.tenantId, 325.5 * multiplier, JSON.stringify({ annual_target_fees: alphaPayloadMarker.annual_target_fees })],
        );
        await direct.query(
          `INSERT INTO public.pms_clients (tenant_id, client_code, client_name, client_type, company_number, payload_json)
           VALUES ($1, 'CLI-1', 'Cambria Holdings Ltd', 'Organisation', '12345678', $2::jsonb)`,
          [ctx.tenantId, JSON.stringify({ credit_limit: alphaPayloadMarker.credit_limit, note: alphaPayloadMarker.note })],
        );
        await direct.query(
          `INSERT INTO public.pms_matters (tenant_id, matter_code, client_code, matter_description, department, work_type, responsible_partner_id, acting_fee_earner_id, billing_basis, fee_estimate, matter_status, payload_json)
           VALUES ($1, 'MAT-1', 'CLI-1', 'Confidential Acquisition', 'Corporate', 'M&A', 'FE-1', 'FE-1', 'Hourly', 19.995 * $2, 'Open', '{"fixed_fee_amount":12500.50}'::jsonb)`,
          [ctx.tenantId, multiplier],
        );
        await direct.query(
          `INSERT INTO public.pms_matter_financials (
             tenant_id, matter_code, client_code, matter_description, department, work_type,
             responsible_partner_id, acting_fee_earner_id, billing_basis, matter_status,
             current_fee_estimate, wip_hours, wip_value, total_time_value,
             billed_fees_ex_vat, billed_disb_ex_vat, billed_vat, billed_total_inc_vat,
             cash_received, outstanding_debt, unbilled_disbursements, client_account_balance, payload_json
           ) VALUES (
             $1, 'MAT-1', 'CLI-1', 'Confidential Acquisition', 'Corporate', 'M&A',
             'FE-1', 'FE-1', 'Hourly', 'Open',
             19.995, 12.75, 4250.25, 9123.45,
             5000.00, 250.50, 1000.00, 6250.50,
             -19.995, 6270.495, 105.005, -0.0, '{"tag":"keep"}'::jsonb
           )`,
          [ctx.tenantId],
        );
        await direct.query(
          `INSERT INTO public.pms_fee_estimates (tenant_id, estimate_id, matter_code, version, estimate_date, estimated_fees_ex_vat, payload_json)
           VALUES ($1, 'EST-1', 'MAT-1', 1, '2026-10-01', 1500.005, '{"disbursements_estimate":300.25}'::jsonb)`,
          [ctx.tenantId],
        );
        await direct.query(
          `INSERT INTO public.pms_invoices (tenant_id, invoice_number, matter_code, client_code, invoice_date, due_date, status, total_inc_vat, payload_json)
           VALUES
             ($1, 'INV-1', 'MAT-1', 'CLI-1', '2026-10-01', '2026-10-31', 'Issued', 1200.55, '{"fees_net":1000.46,"disbursements_net":0,"vat":200.09}'::jsonb),
             ($1, 'CN-1', 'MAT-1', 'CLI-1', '2026-10-15', '2026-10-15', 'Issued', -19.995, '{"fees_net":-19.995}'::jsonb)`,
          [ctx.tenantId],
        );
        await direct.query(
          `INSERT INTO public.pms_payments (tenant_id, receipt_id, invoice_number, matter_code, client_code, payment_date, amount, payload_json)
           VALUES ($1, 'PAY-1', 'INV-1', 'MAT-1', 'CLI-1', '2026-10-10', 500.005, '{}'::jsonb)`,
          [ctx.tenantId],
        );
        await direct.query(
          `INSERT INTO public.pms_time_entries (tenant_id, time_id, matter_code, fee_earner_id, entry_date, hours, value, billing_status, invoice_number, payload_json)
           VALUES ($1, 'TIME-1', 'MAT-1', 'FE-1', '2026-10-02', 3.25, 812.50, 'Unbilled', NULL, '{"rate":250.00,"billed_value":0,"write_off_value":0}'::jsonb)`,
          [ctx.tenantId],
        );
        await direct.query(
          `INSERT INTO public.pms_disbursements (tenant_id, disbursement_id, matter_code, entry_date, amount_ex_vat, billing_status, payload_json)
           VALUES ($1, 'DISB-1', 'MAT-1', '2026-10-03', 105.005, 'Unbilled', '{"vat_amount":21.00,"gross_amount":126.01}'::jsonb)`,
          [ctx.tenantId],
        );
        await direct.query(
          `INSERT INTO public.pms_client_account_entries (tenant_id, transaction_id, matter_code, client_code, entry_date, direction, amount, balance_after, payload_json)
           VALUES
             ($1, 'CA-1', 'MAT-1', 'CLI-1', '2026-10-01', 'Receipt', 1000.005, 1000.005, '{}'::jsonb),
             ($1, 'CA-2', 'MAT-1', 'CLI-1', '2026-10-04', 'Payment', -0.005, 1000.00, '{}'::jsonb)`,
          [ctx.tenantId],
        );
        await direct.query(
          `INSERT INTO public.matters (
             tenant_id, id, row_version, matter_number, title, client_type, client_id,
             practice_area_id, work_type_subcategory_id, status_id, current_stage_id,
             risk_rating_id, conflict_check_status, costs_json, opening_record_json
           ) VALUES
             ($1, 'M-RET-1', 1, 'MAT-001', 'Matter With Retainer', 'organisation', 'O-1', 'pa.1', 'wt.1', 'matter_status.active', 'stage.1', 'risk_rating.low', 'Cleared', $2::jsonb, $3::jsonb),
             ($1, 'M-RET-NULL', 1, 'MAT-002', 'Matter Without Retainer', 'organisation', 'O-1', 'pa.1', 'wt.1', 'matter_status.active', 'stage.1', 'risk_rating.low', 'Cleared', '{}'::jsonb, '{}'::jsonb)`,
          [
            ctx.tenantId,
            retainerText !== null
              ? JSON.stringify({ retainerMoniesOnAccountGbp: Number(retainerText) })
              : '{}',
            retainerText !== null
              ? JSON.stringify({ retainerMoniesOnAccountGbp: Number(retainerText) })
              : '{}',
          ],
        );
      } finally {
        await direct.end();
      }
    };

    await seedPre0027Tenant(ctxAlpha, 1, '450.50');
    await seedPre0027Tenant(ctxBravo, 2, '999.995');

    getPlatformTelemetryRecorder().clearForTesting();
    const pgHost = process.env.PLATFORM_POSTGRES_HOST?.trim() || '127.0.0.1';
    const sweepRegistry: TenantRegistry = {
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [
        {
          tenantId: tenantAlpha,
          slug: 'mig_s112_0027_alpha',
          environment: 'test',
          postgresHost: pgHost,
          postgresDatabaseName: ctxAlpha.postgresDatabaseName,
          postgresRoleName: 'role_tenant_mig_s112_0027_alpha_test',
          keyVaultUri: 'https://kv-s112-alpha.vault.azure.net/',
          packageDir: 'client-not-a-law-firm',
          timeZone: 'Europe/London',
          enabled: true,
        },
        {
          tenantId: tenantBravo,
          slug: 'mig_s112_0027_bravo',
          environment: 'test',
          postgresHost: pgHost,
          postgresDatabaseName: ctxBravo.postgresDatabaseName,
          postgresRoleName: 'role_tenant_mig_s112_0027_bravo_test',
          keyVaultUri: 'https://kv-s112-bravo.vault.azure.net/',
          packageDir: 'client-not-a-law-firm',
          timeZone: 'Europe/London',
          enabled: true,
        },
      ],
    };

    const sweepRes = await runMigrateJobSweep({
      registry: sweepRegistry,
    });
    expect(sweepRes.exitCode).toBe(0);
    expect(sweepRes.succeededTenants).toEqual([tenantAlpha, tenantBravo]);

    // Verify structured telemetry contains ONLY counts and differences — zero money sums or client PII
    const telemetryEvents = getPlatformTelemetryRecorder()
      .getRecentEntries()
      .filter((e) => e.eventName === 'job.migrate.pms_pence_verified');
    expect(telemetryEvents).toHaveLength(2);
    for (const evt of telemetryEvents) {
      expect(evt.properties.tablesVerified).toBe(10);
      expect(evt.properties.totalColumnsVerified).toBe(21);
      expect(evt.properties.mismatchCount).toBe(0);
      const serialized = JSON.stringify(evt);
      expect(serialized).not.toContain('Cambria');
      expect(serialized).not.toContain('Confidential Acquisition');
      expect(serialized).not.toContain('Client Sensitive Title');
      expect(serialized).not.toContain('9123.45');
    }

    const alphaDirect = await createDirectMigrationClient({ ctx: ctxAlpha });
    const bravoDirect = await createDirectMigrationClient({ ctx: ctxBravo });
    try {
      // 1. Schema check: 20 BIGINT *_pence + retainer_monies_on_account_pence + wip_hours/hours remain DOUBLE PRECISION
      const colsRes = await alphaDirect.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT table_name, column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (
              (table_name LIKE 'pms_%' AND (column_name LIKE '%_pence' OR column_name IN ('wip_hours', 'hours')))
              OR (table_name = 'matters' AND column_name = 'retainer_monies_on_account_pence')
            )
          ORDER BY table_name ASC, column_name ASC`,
      );
      const colTypeMap = new Map(
        colsRes.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]),
      );
      for (const spec of PMS_PENCE_MIGRATION_0027_COLUMNS) {
        const meta = colTypeMap.get(`${spec.table}.${spec.penceColumn}`);
        expect(meta).toBeDefined();
        expect(meta!.data_type).toBe('bigint');
        expect(meta!.is_nullable).toBe('NO');
      }
      expect(colTypeMap.get('pms_matter_financials.wip_hours')?.data_type).toBe('double precision');
      expect(colTypeMap.get('pms_time_entries.hours')?.data_type).toBe('double precision');
      expect(colTypeMap.get('matters.retainer_monies_on_account_pence')?.data_type).toBe('bigint');
      expect(colTypeMap.get('matters.retainer_monies_on_account_pence')?.is_nullable).toBe('YES');

      // 2. Verify converted half-away-from-zero values & untouched payload_json & hours
      const mfAlpha = await alphaDirect.query<{
        current_fee_estimate_pence: string;
        wip_hours: number;
        cash_received_pence: string;
        client_account_balance_pence: string;
      }>(
        `SELECT current_fee_estimate_pence::text, wip_hours, cash_received_pence::text, client_account_balance_pence::text
           FROM public.pms_matter_financials WHERE tenant_id = $1 AND matter_code = 'MAT-1'`,
        [tenantAlpha],
      );
      expect(mfAlpha.rows[0]).toEqual({
        current_fee_estimate_pence: '2000',
        wip_hours: 12.75,
        cash_received_pence: '-2000',
        client_account_balance_pence: '0',
      });

      const caAlpha = await alphaDirect.query<{
        transaction_id: string;
        amount_pence: string;
        balance_after_pence: string;
      }>(
        `SELECT transaction_id, amount_pence::text, balance_after_pence::text
           FROM public.pms_client_account_entries WHERE tenant_id = $1 ORDER BY transaction_id ASC`,
        [tenantAlpha],
      );
      expect(caAlpha.rows).toEqual([
        { transaction_id: 'CA-1', amount_pence: '100001', balance_after_pence: '100001' },
        { transaction_id: 'CA-2', amount_pence: '-1', balance_after_pence: '100000' },
      ]);

      const mattersAlpha = await alphaDirect.query<{
        id: string;
        retainer_monies_on_account_pence: string | null;
      }>(
        `SELECT id, retainer_monies_on_account_pence::text FROM public.matters WHERE tenant_id = $1 ORDER BY id ASC`,
        [tenantAlpha],
      );
      expect(mattersAlpha.rows).toEqual([
        { id: 'M-RET-1', retainer_monies_on_account_pence: '45050' },
        { id: 'M-RET-NULL', retainer_monies_on_account_pence: null },
      ]);

      const mattersBravo = await bravoDirect.query<{
        id: string;
        retainer_monies_on_account_pence: string | null;
      }>(
        `SELECT id, retainer_monies_on_account_pence::text FROM public.matters WHERE tenant_id = $1 ORDER BY id ASC`,
        [tenantBravo],
      );
      expect(mattersBravo.rows).toEqual([
        { id: 'M-RET-1', retainer_monies_on_account_pence: '100000' },
        { id: 'M-RET-NULL', retainer_monies_on_account_pence: null },
      ]);

      // payload_json left untouched in SQL
      const cliAlpha = await alphaDirect.query<{ payload_json: Record<string, unknown> }>(
        `SELECT payload_json FROM public.pms_clients WHERE tenant_id = $1 AND client_code = 'CLI-1'`,
        [tenantAlpha],
      );
      expect(cliAlpha.rows[0]?.payload_json).toEqual({
        credit_limit: 50000.25,
        note: alphaPayloadMarker.note,
      });

      // 3. Rollback down -> verifies columns dropped & legacy floats preserved -> re-up round-trip
      expect(await runner.rollbackVersion(ctxAlpha, '0027')).toBe(true);
      const penceColsDown = await alphaDirect.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (
              (table_name LIKE 'pms_%' AND column_name LIKE '%_pence')
              OR (table_name = 'matters' AND column_name = 'retainer_monies_on_account_pence')
            )`,
      );
      expect(penceColsDown.rowCount).toBe(0);

      const legacyStillIntact = await alphaDirect.query<{ total_inc_vat: number }>(
        `SELECT total_inc_vat FROM public.pms_invoices WHERE tenant_id = $1 AND invoice_number = 'INV-1'`,
        [tenantAlpha],
      );
      expect(legacyStillIntact.rows[0]?.total_inc_vat).toBe(1200.55);

      const reapplied = await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
      expect(reapplied.map((m) => m.version)).toEqual(['0027']);
      expect(reapplied[0]?.verificationMetadata?.pmsPenceVerification).toMatchObject({
        tablesVerified: 10,
        totalColumnsVerified: 21,
        mismatchCount: 0,
      });
    } finally {
      await alphaDirect.end();
      await bravoDirect.end();
    }
  }, 45_000);

  it('R820: fails closed and rolls back 0027 cleanly when a pence column is corrupted after backfill or when a source float is NaN', async () => {
    const tenantId = 'mig-s112-0027-fail';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId, environment: 'test' }],
    });
    const ctx = makeTestTenantContext(tenantId);
    const runner = new TenantMigrationRunner();

    const pre0027 = CORE_TENANT_MIGRATIONS.filter((m) => m.version !== '0027');
    await runner.applyUp(ctx, pre0027);
    await runner.rollbackVersion(ctx, '0027');

    const base0027 = PMS_MONEY_AND_RETAINER_PENCE_MIGRATION_0027;
    const direct = await createDirectMigrationClient({ ctx });
    try {
      await direct.query('DELETE FROM public.pms_invoices WHERE tenant_id = $1', [tenantId]);
      await direct.query(
        `INSERT INTO public.pms_invoices (tenant_id, invoice_number, matter_code, client_code, invoice_date, due_date, status, total_inc_vat, payload_json)
         VALUES ($1, 'INV-CORRUPT', 'MAT-1', 'CLI-1', '2026-10-01', '2026-10-31', 'Issued', 100.00, '{}'::jsonb)`,
        [tenantId],
      );
    } finally {
      await direct.end();
    }

    // 1. Corrupt *_pence value AFTER backfill, BEFORE independent check -> PMS_PENCE_CONVERSION_MISMATCH + rollback
    const corrupting0027: TenantMigrationDefinition = {
      ...base0027,
      afterUpSql: async (client, c) => {
        await client.query(
          `UPDATE public.pms_invoices
              SET total_inc_vat_pence = total_inc_vat_pence + 2
            WHERE tenant_id = $1 AND invoice_number = 'INV-CORRUPT'`,
          [c.tenantId],
        );
        await verifyPmsMoneyPenceConversionInClient(client, c);
      },
    };
    await expect(
      runner.applyUp(ctx, [...pre0027, corrupting0027]),
    ).rejects.toThrow(/PMS_PENCE_CONVERSION_MISMATCH/);

    // Verify 0027 rolled back cleanly
    const appliedAfterCorrupt = await runner.listAppliedMigrations(ctx);
    expect(appliedAfterCorrupt.some((m) => m.version === '0027')).toBe(false);
    const checkCol = await createDirectMigrationClient({ ctx });
    try {
      const colExists = await checkCol.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pms_invoices' AND column_name = 'total_inc_vat_pence'`,
      );
      expect(colExists.rowCount).toBe(0);

      // 2. Inject NaN float -> pre-check in upSql rejects cleanly and rolls back
      await checkCol.query(
        `UPDATE public.pms_invoices SET total_inc_vat = 'NaN'::double precision WHERE tenant_id = $1 AND invoice_number = 'INV-CORRUPT'`,
        [tenantId],
      );
    } finally {
      await checkCol.end();
    }

    await expect(runner.applyUp(ctx, CORE_TENANT_MIGRATIONS)).rejects.toThrow(
      /PMS_PENCE_CONVERSION_MISMATCH/,
    );
    const appliedAfterNan = await runner.listAppliedMigrations(ctx);
    expect(appliedAfterNan.some((m) => m.version === '0027')).toBe(false);

    // Repair and apply cleanly
    const fixClient = await createDirectMigrationClient({ ctx });
    try {
      await fixClient.query(
        `UPDATE public.pms_invoices SET total_inc_vat = 100.00 WHERE tenant_id = $1 AND invoice_number = 'INV-CORRUPT'`,
        [tenantId],
      );
    } finally {
      await fixClient.end();
    }
    const cleanRes = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    expect(cleanRes.map((m) => m.version)).toEqual(['0027']);
  }, 30_000);

  it('S1-12 demo in-place conversion check: converts 1Squared_PMS_Demo_Data.xlsx + seed-not-a-law-firm.json across 0027 with zero mismatches', async () => {
    const tenantId = 'mig-s112-demo-verify';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId, environment: 'test' }],
    });
    const ctx = makeTestTenantContext(tenantId);
    const runner = new TenantMigrationRunner();

    const pre0027 = CORE_TENANT_MIGRATIONS.filter((m) => m.version !== '0027');
    await runner.applyUp(ctx, pre0027);
    await runner.rollbackVersion(ctx, '0027');

    const dataset = parsePmsWorkbookDataset();
    const seedStore = loadCommittedSeedStore(REPO_ROOT);

    const direct = await createDirectMigrationClient({ ctx });
    try {
      await direct.query('DELETE FROM public.pms_credit_control_log WHERE tenant_id = $1', [tenantId]);
      await direct.query('DELETE FROM public.pms_client_account_entries WHERE tenant_id = $1', [tenantId]);
      await direct.query('DELETE FROM public.pms_disbursements WHERE tenant_id = $1', [tenantId]);
      await direct.query('DELETE FROM public.pms_time_entries WHERE tenant_id = $1', [tenantId]);
      await direct.query('DELETE FROM public.pms_payments WHERE tenant_id = $1', [tenantId]);
      await direct.query('DELETE FROM public.pms_invoices WHERE tenant_id = $1', [tenantId]);
      await direct.query('DELETE FROM public.pms_fee_estimates WHERE tenant_id = $1', [tenantId]);
      await direct.query('DELETE FROM public.pms_matter_financials WHERE tenant_id = $1', [tenantId]);
      await direct.query('DELETE FROM public.pms_matters WHERE tenant_id = $1', [tenantId]);
      await direct.query('DELETE FROM public.pms_clients WHERE tenant_id = $1', [tenantId]);
      await direct.query('DELETE FROM public.pms_fee_earners WHERE tenant_id = $1', [tenantId]);
      await direct.query('DELETE FROM public.matters WHERE tenant_id = $1', [tenantId]);

      for (const fe of dataset.feeEarners) {
        await direct.query(
          `INSERT INTO public.pms_fee_earners (tenant_id, fee_earner_id, name, grade, department, office, charge_out_rate, status, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [tenantId, fe.fee_earner_id, `${fe.first_name} ${fe.last_name}`, fe.grade, fe.department, 'Cardiff', fe.standard_hourly_rate, fe.active, JSON.stringify(fe)],
        );
      }
      for (const c of dataset.clients) {
        await direct.query(
          `INSERT INTO public.pms_clients (tenant_id, client_code, client_name, client_type, company_number, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [tenantId, c.client_code, c.client_name, c.client_type, c.company_number || null, JSON.stringify(c)],
        );
      }
      for (const m of dataset.matters) {
        await direct.query(
          `INSERT INTO public.pms_matters (tenant_id, matter_code, client_code, matter_description, department, work_type, responsible_partner_id, acting_fee_earner_id, billing_basis, fee_estimate, matter_status, open_date, close_date, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
          [tenantId, m.matter_code, m.client_code, m.matter_description, m.practice_area, m.work_type, m.responsible_partner_id, m.fee_earner_id, m.billing_basis, m.fee_estimate, m.status, m.date_opened || null, m.date_closed || null, JSON.stringify(m)],
        );
      }
      // Derive baseline pre-0027 matter financial floats from workbook sheets
      const estVersion = new Map<string, number>();
      for (const est of dataset.feeEstimates) {
        const nextV = (estVersion.get(est.matter_code) ?? 0) + 1;
        estVersion.set(est.matter_code, nextV);
        await direct.query(
          `INSERT INTO public.pms_fee_estimates (tenant_id, estimate_id, matter_code, version, estimate_date, estimated_fees_ex_vat, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [tenantId, est.estimate_id, est.matter_code, nextV, est.date_given, est.fees_estimate, JSON.stringify(est)],
        );
      }
      for (const inv of dataset.invoices) {
        await direct.query(
          `INSERT INTO public.pms_invoices (tenant_id, invoice_number, matter_code, client_code, invoice_date, due_date, status, total_inc_vat, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [tenantId, inv.invoice_number, inv.matter_code, inv.client_code, inv.invoice_date, inv.due_date, inv.status, inv.total, JSON.stringify(inv)],
        );
      }
      for (const pay of dataset.payments) {
        await direct.query(
          `INSERT INTO public.pms_payments (tenant_id, receipt_id, invoice_number, matter_code, client_code, payment_date, amount, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [tenantId, pay.receipt_id, pay.invoice_number, pay.matter_code, pay.client_code, pay.receipt_date, pay.amount, JSON.stringify(pay)],
        );
      }
      for (const te of dataset.timeEntries) {
        await direct.query(
          `INSERT INTO public.pms_time_entries (tenant_id, time_id, matter_code, fee_earner_id, entry_date, hours, value, billing_status, invoice_number, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [tenantId, te.time_id, te.matter_code, te.fee_earner_id, te.date, te.hours, te.value, te.billed_status, te.invoice_number ?? null, JSON.stringify(te)],
        );
      }
      for (const d of dataset.disbursements) {
        await direct.query(
          `INSERT INTO public.pms_disbursements (tenant_id, disbursement_id, matter_code, entry_date, amount_ex_vat, billing_status, invoice_number, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [tenantId, d.disbursement_id, d.matter_code, d.date, d.net_amount, d.billed_status, d.invoice_number ?? null, JSON.stringify(d)],
        );
      }
      const runningCaByMatter = new Map<string, number>();
      const sortedCa = [...dataset.clientAccount].sort((a, b) =>
        a.matter_code.localeCompare(b.matter_code) ||
        a.date.localeCompare(b.date) ||
        a.transaction_id.localeCompare(b.transaction_id),
      );
      for (const ca of sortedCa) {
        const nextBal = Math.round(((runningCaByMatter.get(ca.matter_code) ?? 0) + ca.amount + Number.EPSILON) * 100) / 100;
        runningCaByMatter.set(ca.matter_code, nextBal);
        await direct.query(
          `INSERT INTO public.pms_client_account_entries (tenant_id, transaction_id, matter_code, client_code, entry_date, direction, amount, balance_after, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [tenantId, ca.transaction_id, ca.matter_code, ca.client_code, ca.date, ca.type, ca.amount, nextBal, JSON.stringify(ca)],
        );
      }
      for (const m of dataset.matters) {
        const wipHours = dataset.timeEntries
          .filter((t) => t.matter_code === m.matter_code && t.billed_status === 'Unbilled')
          .reduce((a, t) => a + t.hours, 0);
        const wipValue = Math.round((dataset.timeEntries
          .filter((t) => t.matter_code === m.matter_code && t.billed_status === 'Unbilled')
          .reduce((a, t) => a + t.value, 0) + Number.EPSILON) * 100) / 100;
        const totalTime = Math.round((dataset.timeEntries
          .filter((t) => t.matter_code === m.matter_code)
          .reduce((a, t) => a + t.value, 0) + Number.EPSILON) * 100) / 100;
        const matterInvs = dataset.invoices.filter((i) => i.matter_code === m.matter_code);
        const billedFees = Math.round((matterInvs.reduce((a, i) => a + i.fees_net, 0) + Number.EPSILON) * 100) / 100;
        const billedDisb = Math.round((matterInvs.reduce((a, i) => a + i.disbursements_net, 0) + Number.EPSILON) * 100) / 100;
        const billedVat = Math.round((matterInvs.reduce((a, i) => a + i.vat, 0) + Number.EPSILON) * 100) / 100;
        const billedTotal = Math.round((matterInvs.reduce((a, i) => a + i.total, 0) + Number.EPSILON) * 100) / 100;
        const cashReceived = Math.round((dataset.payments
          .filter((p) => p.matter_code === m.matter_code)
          .reduce((a, p) => a + p.amount, 0) + Number.EPSILON) * 100) / 100;
        const outstandingDebt = Math.round((billedTotal - cashReceived + Number.EPSILON) * 100) / 100;
        const unbilledDisb = Math.round((dataset.disbursements
          .filter((d) => d.matter_code === m.matter_code && d.billed_status === 'Unbilled')
          .reduce((a, d) => a + d.net_amount, 0) + Number.EPSILON) * 100) / 100;
        const caBal = runningCaByMatter.get(m.matter_code) ?? 0;
        await direct.query(
          `INSERT INTO public.pms_matter_financials (
             tenant_id, matter_code, client_code, matter_description, department, work_type,
             responsible_partner_id, acting_fee_earner_id, billing_basis, matter_status,
             current_fee_estimate, wip_hours, wip_value, total_time_value,
             billed_fees_ex_vat, billed_disb_ex_vat, billed_vat, billed_total_inc_vat,
             cash_received, outstanding_debt, unbilled_disbursements, client_account_balance, payload_json
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10,
             $11, $12, $13, $14,
             $15, $16, $17, $18,
             $19, $20, $21, $22, '{}'::jsonb
           )`,
          [
            tenantId, m.matter_code, m.client_code, m.matter_description, m.practice_area, m.work_type,
            m.responsible_partner_id, m.fee_earner_id, m.billing_basis, m.status,
            m.fee_estimate, wipHours, wipValue, totalTime,
            billedFees, billedDisb, billedVat, billedTotal,
            cashReceived, outstandingDebt, unbilledDisb, caBal,
          ],
        );
      }
      for (const matter of seedStore.matters) {
        await direct.query(
          `INSERT INTO public.matters (
             tenant_id, id, row_version, matter_number, title, client_type, client_id,
             practice_area_id, work_type_subcategory_id, status_id, current_stage_id,
             risk_rating_id, conflict_check_status, costs_json, opening_record_json
           ) VALUES ($1, $2, 1, $3, $4, 'organisation', $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)`,
          [
            tenantId,
            matter.id,
            matter.matterNumber,
            matter.title,
            matter.clientId,
            matter.practiceAreaId,
            matter.workTypeSubcategoryId,
            matter.matterStatusId,
            matter.stageId,
            matter.riskRatingId,
            matter.conflictCheckStatus,
            JSON.stringify({ retainerMoniesOnAccountGbp: matter.retainerMoniesOnAccountGbp ?? null }),
            JSON.stringify({ retainerMoniesOnAccountGbp: matter.retainerMoniesOnAccountGbp ?? null }),
          ],
        );
      }
    } finally {
      await direct.end();
    }

    const appliedDemo = await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
    expect(appliedDemo.map((m) => m.version)).toEqual(['0027']);
    const report = appliedDemo[0]?.verificationMetadata?.pmsPenceVerification as
      | {
          tablesVerified: number;
          totalColumnsVerified: number;
          totalRowsChecked: number;
          totalNonNullChecked: number;
          mismatchCount: number;
          maxColumnTotalDiffPence: number;
          columns: Array<{
            table: string;
            column: string;
            sourceColumn: string;
            rowCount: number;
            nonNullCount: number;
            totalDiffPence: number;
          }>;
        }
      | undefined;
    expect(report).toBeDefined();
    expect(report!.mismatchCount).toBe(0);
    expect(report!.tablesVerified).toBe(10);
    expect(report!.totalColumnsVerified).toBe(21);
    expect(report!.totalRowsChecked).toBeGreaterThan(50);
    console.info(`[DEMO_0027_VERIFICATION] ${JSON.stringify(report)}`);
  }, 45_000);
});
