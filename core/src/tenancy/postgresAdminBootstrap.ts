/**
 * PostgreSQL Tenant Provisioning & Privilege Bootstrap (`core/src/tenancy/postgresAdminBootstrap.ts`).
 *
 * Lives inside `core/src/tenancy/` so zero code outside `core/src/tenancy/` ever imports `pg`
 * (Owner Decision 2). Used by `scripts/setup-test-postgres.mjs` and `TenantMigrationRunner` to
 * enforce the `R402` privilege model:
 * - `migrate_login`: DDL/migration administrator on direct port `5432`.
 * - `runtime_login`: `LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER`, granted membership in
 *   each `role_tenant_<slug>_<env>`, with ZERO direct schema/table/sequence privileges.
 * - Each `pg_tenant_<slug>_<env>`: `REVOKE ALL ON DATABASE ... FROM PUBLIC`, `REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC`,
 *   `GRANT USAGE ON SCHEMA public TO role_tenant_<slug>_<env>`.
 *
 * Local and CI tooling only (R435): not exported from `@platform/core`. Scripts and tests import
 * this module by path. It stays inside `core/src/tenancy/` because Owner Decision 2 allows `pg`
 * nowhere else. Every credential comes from the environment; there are no built-in passwords.
 */

import type { PlatformEnvironment, TenantContext } from '../api/index';
import { loadPgModule } from './pgDriver';
import {
  createDirectMigrationClient,
  quotePgIdentifier,
} from './postgresPoolManager';

export interface ProvisionPostgresClusterOptions {
  readonly tenants: ReadonlyArray<{
    readonly tenantId: string;
    readonly environment: PlatformEnvironment;
  }>;
  /**
   * When false (the default), existing `migrate_login` and `runtime_login` roles keep their
   * current password / SCRAM verifier (`R472`) while role attributes (`LOGIN`, `NOINHERIT`, etc.)
   * are still enforced. Pass `true` only when explicitly rotating cluster login passwords.
   */
  readonly rotatePasswords?: boolean;
}

function requireBootstrapEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    const err = new Error(
      `TENANCY_DB_CONFIG_ERROR: ${name} must be set to provision local or CI PostgreSQL.`,
    ) as Error & { code: string };
    err.code = 'TENANCY_DB_CONFIG_ERROR';
    throw err;
  }
  return value;
}

export async function provisionPostgresClusterRolesAndDatabases(
  options: ProvisionPostgresClusterOptions,
): Promise<{ databasesProvisioned: string[] }> {
  const pg = await loadPgModule();
  const host =
    process.env.PLATFORM_POSTGRES_MIGRATE_HOST?.trim() ||
    requireBootstrapEnv('PLATFORM_POSTGRES_HOST');
  const port = Number(process.env.PLATFORM_POSTGRES_MIGRATE_PORT || 5432);
  const adminUser = requireBootstrapEnv('PLATFORM_POSTGRES_ADMIN_USER');
  const adminPassword = requireBootstrapEnv('PLATFORM_POSTGRES_ADMIN_PASSWORD');
  const migrateUser =
    process.env.PLATFORM_POSTGRES_MIGRATE_USER?.trim() || 'migrate_login';
  const migratePassword = requireBootstrapEnv(
    'PLATFORM_POSTGRES_MIGRATE_PASSWORD',
  );
  const runtimeUser =
    process.env.PLATFORM_POSTGRES_RUNTIME_USER?.trim() || 'runtime_login';
  const runtimePassword = requireBootstrapEnv(
    'PLATFORM_POSTGRES_RUNTIME_PASSWORD',
  );

  const migrateIdent = quotePgIdentifier(migrateUser);
  const runtimeIdent = quotePgIdentifier(runtimeUser);

  const adminClient = new pg.Client({
    host,
    port,
    database: 'postgres',
    user: adminUser,
    password: adminPassword,
  });
  await adminClient.connect();

  const databasesProvisioned: string[] = [];
  try {
    // 1. Provision migrate_login (migration/provisioning admin) and NOINHERIT runtime_login (R402, R472)
    const migExists = await adminClient.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [migrateUser],
    );
    const escapedMigPass = migratePassword.replace(/'/g, "''");
    if (migExists.rowCount === 0) {
      await adminClient.query(
        `CREATE ROLE ${migrateIdent} WITH LOGIN CREATEDB CREATEROLE PASSWORD '${escapedMigPass}'`,
      );
    } else if (options.rotatePasswords === true) {
      await adminClient.query(
        `ALTER ROLE ${migrateIdent} WITH LOGIN CREATEDB CREATEROLE PASSWORD '${escapedMigPass}'`,
      );
    } else {
      await adminClient.query(
        `ALTER ROLE ${migrateIdent} WITH LOGIN CREATEDB CREATEROLE`,
      );
    }

    const runExists = await adminClient.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [runtimeUser],
    );
    const escapedRunPass = runtimePassword.replace(/'/g, "''");
    if (runExists.rowCount === 0) {
      await adminClient.query(
        `CREATE ROLE ${runtimeIdent} WITH LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD '${escapedRunPass}'`,
      );
    } else if (options.rotatePasswords === true) {
      await adminClient.query(
        `ALTER ROLE ${runtimeIdent} WITH LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD '${escapedRunPass}'`,
      );
    } else {
      await adminClient.query(
        `ALTER ROLE ${runtimeIdent} WITH LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER`,
      );
    }

    // 2. Provision per-tenant NOLOGIN roles and isolated databases
    for (const t of options.tenants) {
      const slug = t.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const dbName = `pg_tenant_${slug}_${t.environment}`;
      const roleName = `role_tenant_${slug}_${t.environment}`;
      const dbIdent = quotePgIdentifier(dbName);
      const roleIdent = quotePgIdentifier(roleName);

      const roleExists = await adminClient.query(
        'SELECT 1 FROM pg_roles WHERE rolname = $1',
        [roleName],
      );
      if (roleExists.rowCount === 0) {
        await adminClient.query(
          `CREATE ROLE ${roleIdent} WITH NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER`,
        );
      }
      await adminClient.query(`GRANT ${roleIdent} TO ${runtimeIdent}`);
      await adminClient.query(`GRANT ${roleIdent} TO ${migrateIdent}`);

      const dbExists = await adminClient.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [dbName],
      );
      if (dbExists.rowCount === 0) {
        await adminClient.query(
          `CREATE DATABASE ${dbIdent} OWNER ${migrateIdent}`,
        );
      }
      await adminClient.query(`REVOKE ALL ON DATABASE ${dbIdent} FROM PUBLIC`);
      await adminClient.query(
        `GRANT CONNECT ON DATABASE ${dbIdent} TO ${migrateIdent}, ${runtimeIdent}, ${roleIdent}`,
      );
      databasesProvisioned.push(dbName);
    }
  } finally {
    await adminClient.end();
  }

  // 3. Apply per-database public schema lockdown (R402)
  for (const t of options.tenants) {
    const slug = t.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const dbName = `pg_tenant_${slug}_${t.environment}`;
    const roleName = `role_tenant_${slug}_${t.environment}`;
    const roleIdent = quotePgIdentifier(roleName);

    const dbClient = new pg.Client({
      host,
      port,
      database: dbName,
      user: adminUser,
      password: adminPassword,
    });
    await dbClient.connect();
    try {
      await dbClient.query(`ALTER SCHEMA public OWNER TO ${migrateIdent}`);
      await dbClient.query(`REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC`);
      await dbClient.query(`REVOKE ALL ON SCHEMA public FROM ${runtimeIdent}`);
      await dbClient.query(
        `GRANT USAGE, CREATE ON SCHEMA public TO ${migrateIdent}`,
      );
      await dbClient.query(`GRANT USAGE ON SCHEMA public TO ${roleIdent}`);
    } finally {
      await dbClient.end();
    }
  }

  return { databasesProvisioned };
}

/**
 * Non-live test/demo reset helper for the append-only `audit_entries` table (`S0-15`, `R413`).
 *
 * Because `role_tenant_<slug>_<env>` strictly holds `SELECT, INSERT` ONLY on `audit_entries`
 * (never `UPDATE`, `DELETE`, or `TRUNCATE`), non-live test suites, `seed:demo`, `resetAllDemoData`,
 * and `clearAllDataToCleanDeployment` reset `audit_entries` via `migrate_login` on direct port `5432`.
 * Refuses immediately if `ctx.environment === 'live'`.
 */
export async function resetNonLiveTenantAuditLogForTestingOrDemo(
  ctx: TenantContext,
): Promise<void> {
  if (ctx.environment === 'live') {
    throw new Error(
      'LIVE_AUDIT_RESET_FORBIDDEN: Immutable audit_entries cannot be cleared in the live environment.',
    );
  }
  const client = await createDirectMigrationClient({ ctx });
  try {
    const tableCheck = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'audit_entries'`,
    );
    if (!tableCheck.rowCount) {
      return;
    }
    await client.query('BEGIN');
    try {
      await client.query(
        'DELETE FROM public.audit_entries WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await client.query(
        "SELECT setval('public.tenant_audit_id_seq', 1, false)",
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    await client.end().catch(() => {});
  }
}
