import { describe, expect, it, vi } from 'vitest';
import type {
  AppliedTenantMigrationRecord,
  TenantContext,
  TenantMigrationRunner,
  TenantRegistry,
} from '@platform/core';
import {
  executeCliJobRunner,
  parseMigrateInvocation,
  runMigrateDownJob,
} from '../../scripts/run-job';

const TEST_REGISTRY: TenantRegistry = {
  schemaVersion: '1.0.0',
  environment: 'test',
  hostingMode: 'multi_tenant',
  tenants: [
    {
      tenantId: 'down-unit-alpha',
      slug: 'down_unit_alpha',
      environment: 'test',
      postgresHost: '127.0.0.1',
      postgresDatabaseName: 'pg_tenant_down_unit_alpha_test',
      postgresRoleName: 'role_tenant_down_unit_alpha_test',
      keyVaultUri: 'https://kv-downunit-test.vault.azure.net/',
      packageDir: 'client-not-a-law-firm',
      timeZone: 'Europe/London',
      enabled: true,
    },
  ],
};

describe('R828: guarded migrate-down CLI & runner', () => {
  it('refuses missing confirmation flag, missing target version, unknown version, free-text tenant args, and unconfirmed env vars', async () => {
    // Missing confirmation flag
    const missingConfirm = parseMigrateInvocation(
      ['--down', '--target', '0027'],
      {},
    );
    expect(missingConfirm).toMatchObject({
      ok: false,
      code: 'MIGRATION_ROLLBACK_CONFIRMATION_REQUIRED',
    });

    // Missing target version
    const missingTarget = parseMigrateInvocation(
      ['--down', '--confirm-rollback'],
      {},
    );
    expect(missingTarget).toMatchObject({
      ok: false,
      code: 'MIGRATION_ROLLBACK_TARGET_REQUIRED',
    });

    // Unknown target version
    const unknownTarget = parseMigrateInvocation(
      ['--down', '--target', '9999', '--confirm-rollback'],
      {},
    );
    expect(unknownTarget).toMatchObject({
      ok: false,
      code: 'MIGRATION_ROLLBACK_UNKNOWN_VERSION',
    });

    // Free-text tenant argument is strictly forbidden
    const freeTextTenant = parseMigrateInvocation(
      ['--down', '--target', '0027', '--confirm-rollback', '--tenant', 'alpha'],
      {},
    );
    expect(freeTextTenant).toMatchObject({
      ok: false,
      code: 'JOB_RUNNER_USAGE_ERROR',
    });

    // Env target without env confirmation refuses fail-closed rather than running UP
    const envMissingConfirm = parseMigrateInvocation([], {
      PLATFORM_MIGRATE_DOWN_TARGET: '0027',
      PLATFORM_MIGRATE_DOWN_CONFIRM: 'false',
    });
    expect(envMissingConfirm).toMatchObject({
      ok: false,
      code: 'MIGRATION_ROLLBACK_CONFIRMATION_REQUIRED',
    });

    // Default Bicep env values cleanly mean UP mode
    expect(
      parseMigrateInvocation([], {
        PLATFORM_MIGRATE_DOWN_TARGET: '',
        PLATFORM_MIGRATE_DOWN_CONFIRM: 'false',
      }),
    ).toEqual({ ok: true, mode: 'up' });

    // CLI runner returns exit code 1 with zero side effects on refused flags
    const stderr: string[] = [];
    const exitNoConfirm = await executeCliJobRunner(
      ['node', 'dist/jobs/run-job.mjs', 'migrate', '--down', '--target', '0027'],
      {
        stderr: (line) => stderr.push(line),
        env: {},
        registry: TEST_REGISTRY,
      },
    );
    expect(exitNoConfirm).toBe(1);
    expect(stderr.join('')).toContain('MIGRATION_ROLLBACK_CONFIRMATION_REQUIRED');
  });

  it('refuses rolling back any non-newest applied migration and rolls back only the newest applied migration from the current image', async () => {
    const rollbackSpy = vi.fn<(ctx: TenantContext, version: string) => Promise<boolean>>(
      async () => true,
    );
    let currentApplied: AppliedTenantMigrationRecord[] = [
      {
        tenantId: 'down-unit-alpha',
        databaseName: 'pg_tenant_down_unit_alpha_test',
        version: '0026',
        name: '0026_opening_gate_overrides_and_numbering_expand',
        checksum: 'c26',
        appliedAt: '2026-11-26T00:00:00.000Z',
      },
      {
        tenantId: 'down-unit-alpha',
        databaseName: 'pg_tenant_down_unit_alpha_test',
        version: '0027',
        name: '0027_pms_money_and_retainer_pence_expand',
        checksum: 'c27',
        appliedAt: '2026-11-26T01:00:00.000Z',
      },
    ];

    const fakeRunner = {
      listAppliedMigrations: vi.fn(async () => currentApplied),
      rollbackVersion: vi.fn(async (ctx: TenantContext, version: string) => {
        await rollbackSpy(ctx, version);
        currentApplied = currentApplied.filter((m) => m.version !== version);
        return true;
      }),
    } as unknown as TenantMigrationRunner;

    // 1. Attempting to roll back 0026 while 0027 is newest must fail closed
    const nonNewestRes = await runMigrateDownJob({
      targetVersion: '0026',
      confirmRollback: true,
      registry: TEST_REGISTRY,
      runner: fakeRunner,
    });
    expect(nonNewestRes.exitCode).toBe(1);
    expect(nonNewestRes.failedTenants).toEqual([
      { tenantId: 'down-unit-alpha', errorCode: 'MIGRATION_ROLLBACK_NOT_NEWEST' },
    ]);
    expect(nonNewestRes.results).toEqual([
      {
        tenantId: 'down-unit-alpha',
        previousVersion: '0027',
        targetVersion: '0026',
        resultingVersion: '0027',
        outcome: 'refused',
        errorCode: 'MIGRATION_ROLLBACK_NOT_NEWEST',
      },
    ]);
    expect(rollbackSpy).not.toHaveBeenCalled();

    // 2. Rolling back newest version 0027 succeeds cleanly via CLI and logs tenantId, versions, outcome only
    const stdout: string[] = [];
    const cliCode = await executeCliJobRunner(
      [
        'node',
        'dist/jobs/run-job.mjs',
        'migrate',
        '--down',
        '--target',
        '0027',
        '--confirm-rollback',
      ],
      {
        stdout: (line) => stdout.push(line),
        env: {},
        registry: TEST_REGISTRY,
        runner: fakeRunner,
      },
    );
    expect(cliCode).toBe(0);
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(stdout[0]!) as Record<string, unknown>;
    expect(logged).toEqual({
      event: 'job.migrate.down',
      tenantId: 'down-unit-alpha',
      previousVersion: '0027',
      targetVersion: '0027',
      resultingVersion: '0026',
      outcome: 'rolled_back',
    });
  });
});
