import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getActiveTenantRawBaseConfig } from '@/platform/tenantRuntime';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts', 'import-pms.ts');

function runScriptSubprocess(
  args: readonly string[],
  envOverrides: Record<string, string | undefined>,
) {
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') mergedEnv[k] = v;
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete mergedEnv[k];
    } else {
      mergedEnv[k] = v;
    }
  }
  return spawnSync(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', SCRIPT_PATH, ...args],
    {
      cwd: process.cwd(),
      env: mergedEnv as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 15000,
      shell: false,
    },
  );
}

describe('pms:import CLI tenancy & live environment guards (R584)', () => {
  it('R584: pms:import CLI refuses live environment with PMS_IMPORT_LIVE_FORBIDDEN before touching PostgreSQL', () => {
    const res = runScriptSubprocess([], {
      PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
      PLATFORM_ENVIRONMENT: 'live',
      PLATFORM_HOSTING_MODE: 'multi_tenant',
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stderr}\n${res.stdout}`).toMatch(/PMS_IMPORT_LIVE_FORBIDDEN/);
  });

  it('R584: pms:import CLI refuses unregistered or disabled tenant IDs against active tenant registry', () => {
    const registryJson = JSON.stringify({
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [
        {
          tenantId: 'not-a-law-firm',
          slug: 'not_a_law_firm',
          environment: 'test',
          postgresHost: '127.0.0.1',
          postgresDatabaseName: 'pg_tenant_not_a_law_firm_test',
          postgresRoleName: 'role_tenant_not_a_law_firm_test',
          keyVaultUri: 'https://kv-notalawfirm-test.vault.azure.net/',
          packageDir: 'client-not-a-law-firm',
          timeZone: 'Europe/London',
          enabled: true,
        },
        {
          tenantId: 'tenant-disabled-test',
          slug: 'tenant_disabled_test',
          environment: 'test',
          postgresHost: '127.0.0.1',
          postgresDatabaseName: 'pg_tenant_tenant_disabled_test_test',
          postgresRoleName: 'role_tenant_tenant_disabled_test_test',
          keyVaultUri: 'https://kv-disabled-test.vault.azure.net/',
          packageDir: 'client-not-a-law-firm',
          timeZone: 'Europe/London',
          enabled: false,
        },
      ],
    });

    const unregRes = runScriptSubprocess(
      ['--tenant', 'unregistered-evil-tenant'],
      {
        PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
        PLATFORM_ENVIRONMENT: 'test',
        PLATFORM_HOSTING_MODE: 'multi_tenant',
        PLATFORM_TENANT_REGISTRY_JSON: registryJson,
      },
    );
    expect(unregRes.status).not.toBe(0);
    expect(`${unregRes.stderr}\n${unregRes.stdout}`).toMatch(
      /TENANCY_UNREGISTERED_JOB_TENANT/,
    );

    const disabledRes = runScriptSubprocess(
      ['--tenant', 'tenant-disabled-test'],
      {
        PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
        PLATFORM_ENVIRONMENT: 'test',
        PLATFORM_HOSTING_MODE: 'multi_tenant',
        PLATFORM_TENANT_REGISTRY_JSON: registryJson,
      },
    );
    expect(disabledRes.status).not.toBe(0);
    expect(`${disabledRes.stderr}\n${disabledRes.stdout}`).toMatch(
      /TENANCY_UNREGISTERED_JOB_TENANT/,
    );
  });

  it('R584: runImportPmsCli resolves target tenant config from registry packageDir and refuses live registry entries', async () => {
    const tmpPkg = fs.mkdtempSync(path.join(os.tmpdir(), '1sq-r584-pkg-'));
    try {
      const cfgDir = path.join(tmpPkg, 'config');
      const envDir = path.join(cfgDir, 'environments');
      fs.mkdirSync(envDir, { recursive: true });
      const rawBase = JSON.parse(
        JSON.stringify(getActiveTenantRawBaseConfig()).replace(
          /kv-notalawfirm-dev/g,
          'kv-alpha-r584',
        ),
      ) as Record<string, unknown>;
      rawBase.tenantId = 'tenant-alpha';
      rawBase.displayName = 'Alpha Legal R584';
      rawBase.keyVault = {
        vaultName: 'kv-alpha-r584',
        vaultUri: 'https://kv-alpha-r584.vault.azure.net/',
      };
      rawBase.database = {
        dedicatedServerHost: 'alpha-pg-r584.postgres.database.azure.com',
      };
      fs.writeFileSync(
        path.join(cfgDir, 'base.json'),
        JSON.stringify(rawBase, null, 2),
        'utf8',
      );
      fs.writeFileSync(
        path.join(envDir, 'test.json'),
        JSON.stringify(
          {
            tenantId: 'tenant-alpha',
            environment: 'test',
            keyVault: {
              vaultName: 'kv-alpha-r584',
              vaultUri: 'https://kv-alpha-r584.vault.azure.net/',
            },
            database: {
              dedicatedServerHost: 'alpha-pg-r584.postgres.database.azure.com',
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const relPkgDir = path.relative(process.cwd(), tmpPkg);
      const registry = {
        schemaVersion: '1.0.0' as const,
        environment: 'test' as const,
        hostingMode: 'multi_tenant' as const,
        tenants: [
          {
            tenantId: 'tenant-alpha',
            slug: 'tenant_alpha',
            environment: 'test' as const,
            postgresHost: 'alpha-pg-r584.postgres.database.azure.com',
            postgresDatabaseName: 'pg_tenant_tenant_alpha_test',
            postgresRoleName: 'role_tenant_tenant_alpha_test',
            keyVaultUri: 'https://kv-alpha-r584.vault.azure.net/',
            packageDir: relPkgDir,
            timeZone: 'Europe/London',
            enabled: true,
          },
        ],
      };

      const cliMod = (await import('../../../scripts/import-pms')) as {
        runImportPmsCli?: (
          argv: readonly string[],
          options?: {
            registry?: typeof registry;
            environment?: string;
            importer?: (ctx: {
              tenantId: string;
              configuredPostgresHost?: string;
              postgresDatabaseName?: string;
              configuredKeyVault?: {
                vaultName?: string;
                vaultUri?: string;
              };
              environment: string;
            }) => Promise<{
              dbPath: string;
              asAtDate: string;
              importedAt: string;
              counts: Record<string, number>;
            }>;
            closePools?: () => Promise<void>;
          },
        ) => Promise<{
          tenantId: string;
          databaseName: string;
          asAtDate: string;
          importedAt: string;
        }>;
      };

      expect(typeof cliMod.runImportPmsCli).toBe('function');
      let capturedCtx:
        | {
            tenantId: string;
            configuredPostgresHost?: string;
            postgresDatabaseName?: string;
            configuredKeyVault?: {
              vaultName?: string;
              vaultUri?: string;
            };
            environment: string;
          }
        | undefined;
      await cliMod.runImportPmsCli!(['--tenant', 'tenant-alpha'], {
        registry,
        environment: 'test',
        importer: async (ctx) => {
          capturedCtx = ctx;
          return {
            dbPath: `postgres://${ctx.postgresDatabaseName}`,
            asAtDate: '2026-11-20',
            importedAt: '2026-11-20T00:00:00.000Z',
            counts: {},
          };
        },
        closePools: async () => undefined,
      });

      expect(capturedCtx?.tenantId).toBe('tenant-alpha');
      expect(capturedCtx?.postgresDatabaseName).toBe(
        'pg_tenant_tenant_alpha_test',
      );
      expect(capturedCtx?.configuredPostgresHost).toBe(
        'alpha-pg-r584.postgres.database.azure.com',
      );
      expect(capturedCtx?.configuredKeyVault?.vaultUri).toBe(
        'https://kv-alpha-r584.vault.azure.net/',
      );
      expect(capturedCtx?.environment).toBe('test');

      await expect(
        cliMod.runImportPmsCli!(['--tenant', 'tenant-alpha'], {
          registry: {
            ...registry,
            environment: 'live',
            tenants: [
              {
                ...registry.tenants[0]!,
                environment: 'live',
              },
            ],
          } as unknown as typeof registry,
          environment: 'test',
          importer: async () => ({
            dbPath: 'should-not-run',
            asAtDate: '2026-11-20',
            importedAt: '2026-11-20T00:00:00.000Z',
            counts: {},
          }),
          closePools: async () => undefined,
        }),
      ).rejects.toThrow(/PMS_IMPORT_LIVE_FORBIDDEN/);
    } finally {
      fs.rmSync(tmpPkg, { recursive: true, force: true });
    }
  });
});
