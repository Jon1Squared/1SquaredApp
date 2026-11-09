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
 */

import type { PlatformEnvironment } from '../api/index';
import { loadPgModule } from './pgDriver';
import { quotePgIdentifier } from './postgresPoolManager';

export interface ProvisionPostgresClusterOptions {
  readonly host?: string;
  readonly adminPort?: number;
  readonly adminUser?: string;
  readonly adminPassword?: string;
  readonly migrateUser?: string;
  readonly migratePassword?: string;
  readonly runtimeUser?: string;
  readonly runtimePassword?: string;
  readonly tenants: ReadonlyArray<{
    readonly tenantId: string;
    readonly environment: PlatformEnvironment;
  }>;
}

export async function provisionPostgresClusterRolesAndDatabases(
  options: ProvisionPostgresClusterOptions,
): Promise<{ databasesProvisioned: string[] }> {
  const pg = await loadPgModule();
  const host =
    options.host?.trim() ||
    process.env.PLATFORM_POSTGRES_MIGRATE_HOST?.trim() ||
    process.env.PLATFORM_POSTGRES_HOST?.trim() ||
    '127.0.0.1';
  const port =
    options.adminPort ??
    Number(process.env.PLATFORM_POSTGRES_MIGRATE_PORT || 5432);
  const adminUser =
    options.adminUser?.trim() ||
    process.env.PLATFORM_POSTGRES_ADMIN_USER?.trim() ||
    'postgres';
  const adminPassword =
    options.adminPassword ??
    process.env.PLATFORM_POSTGRES_ADMIN_PASSWORD ??
    'postgres';
  const migrateUser =
    options.migrateUser?.trim() ||
    process.env.PLATFORM_POSTGRES_MIGRATE_USER?.trim() ||
    'migrate_login';
  const migratePassword =
    options.migratePassword ??
    process.env.PLATFORM_POSTGRES_MIGRATE_PASSWORD ??
    'onesquared_local_migrate';
  const runtimeUser =
    options.runtimeUser?.trim() ||
    process.env.PLATFORM_POSTGRES_RUNTIME_USER?.trim() ||
    'runtime_login';
  const runtimePassword =
    options.runtimePassword ??
    process.env.PLATFORM_POSTGRES_RUNTIME_PASSWORD ??
    'onesquared_local_runtime';

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
    // 1. Provision migrate_login (migration/provisioning admin) and NOINHERIT runtime_login (R402)
    const migExists = await adminClient.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [migrateUser],
    );
    const escapedMigPass = migratePassword.replace(/'/g, "''");
    if (migExists.rowCount === 0) {
      await adminClient.query(
        `CREATE ROLE ${migrateIdent} WITH LOGIN CREATEDB CREATEROLE PASSWORD '${escapedMigPass}'`,
      );
    } else {
      await adminClient.query(
        `ALTER ROLE ${migrateIdent} WITH LOGIN CREATEDB CREATEROLE PASSWORD '${escapedMigPass}'`,
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
    } else {
      await adminClient.query(
        `ALTER ROLE ${runtimeIdent} WITH LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD '${escapedRunPass}'`,
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
