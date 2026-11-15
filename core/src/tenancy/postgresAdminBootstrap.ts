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

import type { PlatformEnvironment } from '../api/index';
import { loadPgModule } from './pgDriver';
import {
  acquireEntraManagedIdentityPostgresToken,
  quotePgIdentifier,
  resolvePostgresMigrateUser,
  resolvePostgresRuntimeUser,
} from './postgresPoolManager';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export async function provisionEntraPostgresClusterRolesAndDatabases(
  options: ProvisionPostgresClusterOptions,
): Promise<{ databasesProvisioned: string[] }> {
  const pg = await loadPgModule();
  const host =
    process.env.PLATFORM_POSTGRES_MIGRATE_HOST?.trim() ||
    requireBootstrapEnv('PLATFORM_POSTGRES_HOST');
  const port = Number(process.env.PLATFORM_POSTGRES_MIGRATE_PORT || 5432);
  const migrateUser = resolvePostgresMigrateUser();
  const runtimeUser = resolvePostgresRuntimeUser();
  const runtimePrincipalId =
    process.env.PLATFORM_POSTGRES_RUNTIME_PRINCIPAL_ID?.trim();

  if (runtimeUser === migrateUser) {
    const err = new Error(
      'TENANCY_DB_CONFIG_ERROR: PLATFORM_POSTGRES_RUNTIME_USER and PLATFORM_POSTGRES_MIGRATE_USER must be distinct principals (R402).',
    ) as Error & { code: string };
    err.code = 'TENANCY_DB_CONFIG_ERROR';
    throw err;
  }

  const migrateClientId =
    process.env.AZURE_MIGRATE_CLIENT_ID?.trim() ||
    process.env.PLATFORM_POSTGRES_CLIENT_ID?.trim() ||
    process.env.AZURE_CLIENT_ID?.trim() ||
    undefined;
  const token = await acquireEntraManagedIdentityPostgresToken(migrateClientId);
  const useTls = process.env.PLATFORM_POSTGRES_SSL !== 'false';

  const migrateIdent = quotePgIdentifier(migrateUser);
  const runtimeIdent = quotePgIdentifier(runtimeUser);

  const adminClient = new pg.Client({
    host,
    port,
    database: 'postgres',
    user: migrateUser,
    password: token,
    ssl: useTls ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 15_000,
  });
  await adminClient.connect();

  const databasesProvisioned: string[] = [];
  try {
    // 1. Ensure Entra principal exists for runtimeIdentity and enforce NOINHERIT (R402)
    const runExists = await adminClient.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [runtimeUser],
    );
    if (runExists.rowCount === 0) {
      if (runtimePrincipalId && UUID_PATTERN.test(runtimePrincipalId)) {
        await adminClient.query(
          'SELECT * FROM pgaadauth_create_principal_with_oid($1, $2, $3, false, false)',
          [runtimeUser, runtimePrincipalId, 'service'],
        );
      } else {
        await adminClient.query(
          'SELECT * FROM pgaadauth_create_principal($1, false, false)',
          [runtimeUser],
        );
      }
    }
    try {
      await adminClient.query(
        `ALTER ROLE ${runtimeIdent} WITH LOGIN NOINHERIT NOCREATEDB NOCREATEROLE`,
      );
    } catch {
      try {
        await adminClient.query(`ALTER ROLE ${runtimeIdent} WITH NOINHERIT`);
      } catch {
        // On Azure Flexible Server where pgaadauth owns the Entra principal, membership-level
        // WITH INHERIT FALSE below still enforces non-inheritance for tenant roles.
      }
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
          `CREATE ROLE ${roleIdent} WITH NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE`,
        );
      } else {
        await adminClient.query(
          `ALTER ROLE ${roleIdent} WITH NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE`,
        );
      }
      try {
        await adminClient.query(
          `GRANT ${roleIdent} TO ${runtimeIdent} WITH INHERIT FALSE, SET TRUE`,
        );
      } catch {
        await adminClient.query(`GRANT ${roleIdent} TO ${runtimeIdent}`);
      }
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

  // 3. Apply per-database public schema lockdown and default privileges (R402)
  for (const t of options.tenants) {
    const slug = t.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const dbName = `pg_tenant_${slug}_${t.environment}`;
    const roleName = `role_tenant_${slug}_${t.environment}`;
    const roleIdent = quotePgIdentifier(roleName);

    const dbClient = new pg.Client({
      host,
      port,
      database: dbName,
      user: migrateUser,
      password: token,
      ssl: useTls ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 15_000,
    });
    await dbClient.connect();
    try {
      await dbClient.query(`REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC`);
      await dbClient.query(`REVOKE ALL ON SCHEMA public FROM ${runtimeIdent}`);
      await dbClient.query(
        `GRANT USAGE, CREATE ON SCHEMA public TO ${migrateIdent}`,
      );
      await dbClient.query(`GRANT USAGE ON SCHEMA public TO ${roleIdent}`);
      await dbClient.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrateIdent} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleIdent}`,
      );
      await dbClient.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrateIdent} IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, ${runtimeIdent}, ${roleIdent}`,
      );
      await dbClient.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrateIdent} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${roleIdent}`,
      );
    } finally {
      await dbClient.end();
    }
  }

  return { databasesProvisioned };
}

export async function provisionPostgresClusterRolesAndDatabases(
  options: ProvisionPostgresClusterOptions,
): Promise<{ databasesProvisioned: string[] }> {
  if (
    process.env.PLATFORM_POSTGRES_AUTH_MODE?.trim() === 'entra_managed_identity'
  ) {
    return provisionEntraPostgresClusterRolesAndDatabases(options);
  }

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
