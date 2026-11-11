/**
 * Tenant-Scoped PostgreSQL Pool Manager & Entra / Role Connection Factory
 * (`core/src/tenancy/postgresPoolManager.ts`).
 *
 * Enforces ADR 0028 §§1–2 & Platform Architecture Standard §8 (`R401`, `R402`, `R403`):
 * 1. Resolves `(host, port, databaseName, tenantRole)` strictly from verified `TenantContext`
 *    (plus optional `configuredPostgresHost` from `database.dedicatedServerHost`).
 * 2. Caps each per-tenant pool at `max: 5` connections per replica by default, evicting idle pools.
 * 3. Runtime pools (`web` and scheduled/import jobs) connect to PgBouncer (`port: 6432` by default,
 *    `pool_mode = transaction`) as the non-admin `NOINHERIT` `runtimeIdentity` / `runtime_login`.
 * 4. Direct migration clients (`createDirectMigrationClient`) connect directly to PostgreSQL port `5432`
 *    (bypassing PgBouncer) as `migrateIdentity` / `migrate_login`.
 * 5. Sanitises all database errors so SQL text, bind parameters, and row values never leak into logs
 *    or error messages (Rule 5 & Standard §13).
 */

import type * as PgTypes from 'pg';
import type { TenantContext } from '../api/index';
import { loadPgModule } from './pgDriver';

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const PG_DATABASE_NAME_PATTERN = /^pg_tenant_[a-z0-9_]{2,58}$/;
const PG_TENANT_ROLE_PATTERN = /^role_tenant_[a-z0-9_]{2,58}$/;
const PG_SAFE_IDENT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

const PG_DATE_OID = 1082;
let pgTypeParsersConfigured = false;

export interface ResolvedTenantPostgresRuntimeTarget {
  readonly host: string;
  readonly port: number;
  readonly databaseName: string;
  readonly tenantRoleName: string;
  readonly ssl: boolean | { rejectUnauthorized: boolean };
}

export interface TenantPostgresPoolManagerOptions {
  readonly maxConnectionsPerTenant?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly poolIdleEvictionMs?: number;
  /** How long a positive schema readiness check is trusted before re-checking (R437). */
  readonly schemaReadyTtlMs?: number;
}

interface ManagedPoolEntry {
  pool: PgTypes.Pool;
  lastUsedAtMs: number;
  target: ResolvedTenantPostgresRuntimeTarget;
}

export function quotePgIdentifier(ident: string): string {
  if (!PG_SAFE_IDENT_PATTERN.test(ident)) {
    throw new Error(
      'TENANCY_SQL_IDENTIFIER_REJECTED: Unsafe PostgreSQL identifier rejected.',
    );
  }
  return `"${ident}"`;
}

export function resolveTenantPostgresRoleName(
  ctx: Pick<TenantContext, 'tenantId' | 'environment'>,
): string {
  const tenantId = ctx?.tenantId?.trim() ?? '';
  if (!tenantId || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(
      'TENANCY_ISOLATION_ERROR: Valid TenantContext.tenantId is required to resolve PostgreSQL role.',
    );
  }
  const slug = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const roleName = `role_tenant_${slug}_${ctx.environment}`;
  if (!PG_TENANT_ROLE_PATTERN.test(roleName)) {
    throw new Error(
      'TENANCY_ISOLATION_ERROR: Resolved PostgreSQL tenant role name failed validation.',
    );
  }
  return roleName;
}

export function assertValidPostgresTenantContext(ctx: TenantContext): void {
  if (
    !ctx ||
    !ctx.tenantId ||
    !TENANT_ID_PATTERN.test(ctx.tenantId) ||
    !ctx.postgresDatabaseName ||
    !PG_DATABASE_NAME_PATTERN.test(ctx.postgresDatabaseName)
  ) {
    throw new Error(
      'TENANCY_ISOLATION_ERROR: Data access requires a valid TenantContext with verified tenantId and postgresDatabaseName.',
    );
  }
}

export function sanitizePostgresError(
  err: unknown,
  contextLabel: string,
): Error & { code?: string; sqlState?: string } {
  if (err instanceof Error) {
    const existingCode = (err as { code?: unknown }).code;
    if (
      typeof existingCode === 'string' &&
      (existingCode.startsWith('TENANCY_') ||
        existingCode === 'TENANT_SCHEMA_NOT_READY' ||
        existingCode.startsWith('KEY_DATE_') ||
        existingCode.startsWith('MATTER_') ||
        existingCode.startsWith('PARTY_') ||
        existingCode.startsWith('INTAKE_') ||
        existingCode.startsWith('QUOTE_') ||
        existingCode.startsWith('TASK_') ||
        existingCode.startsWith('NOTIFICATION_') ||
        existingCode.startsWith('SIGN_OFF_') ||
        existingCode.startsWith('HR_') ||
        existingCode.startsWith('TEAM_') ||
        existingCode.startsWith('RBAC_') ||
        existingCode.startsWith('EMPLOYEE_') ||
        existingCode.startsWith('CATALOGUE_') ||
        existingCode.startsWith('CUSTOM_FIELD_') ||
        existingCode.startsWith('CHOICE_') ||
        existingCode.startsWith('FIRM_PROFILE_') ||
        existingCode.startsWith('MIGRATION_') ||
        existingCode.startsWith('DOCUMENT_') ||
        existingCode.startsWith('TEMPLATE_'))
    ) {
      return err as Error & { code?: string };
    }
    if (
      err.message.startsWith('TENANCY_') ||
      err.message.startsWith('TENANT_SCHEMA_NOT_READY') ||
      err.message.startsWith('KEY_DATE_') ||
      err.message.startsWith('MATTER_') ||
      err.message.startsWith('PARTY_') ||
      err.message.startsWith('INTAKE_') ||
      err.message.startsWith('QUOTE_') ||
      err.message.startsWith('TASK_') ||
      err.message.startsWith('NOTIFICATION_') ||
      err.message.startsWith('SIGN_OFF_') ||
      err.message.startsWith('HR_') ||
      err.message.startsWith('TEAM_') ||
      err.message.startsWith('RBAC_') ||
      err.message.startsWith('EMPLOYEE_') ||
      err.message.startsWith('CATALOGUE_') ||
      err.message.startsWith('CUSTOM_FIELD_') ||
      err.message.startsWith('CHOICE_') ||
      err.message.startsWith('FIRM_PROFILE_') ||
      err.message.startsWith('MIGRATION_') ||
      err.message.startsWith('DOCUMENT_') ||
      err.message.startsWith('TEMPLATE_')
    ) {
      return err as Error & { code?: string };
    }
  }

  const sqlState =
    typeof (err as { code?: unknown })?.code === 'string'
      ? String((err as { code?: unknown }).code)
      : undefined;

  if (sqlState === '42501') {
    const denied = new Error(
      `TENANCY_DATABASE_PERMISSION_DENIED: PostgreSQL permission denied during ${contextLabel} (SQLSTATE 42501).`,
    ) as Error & { code: string; sqlState: string };
    denied.code = '42501';
    denied.sqlState = '42501';
    return denied;
  }

  if (sqlState === '23503') {
    const restricted = new Error(
      `TENANCY_FOREIGN_KEY_RESTRICT: Database operation "${contextLabel}" refused by foreign key ON DELETE RESTRICT constraint (SQLSTATE 23503).`,
    ) as Error & { code: string; sqlState: string };
    restricted.code = '23503';
    restricted.sqlState = '23503';
    return restricted;
  }

  const safeErr = new Error(
    `TENANCY_DATABASE_ERROR: Database operation "${contextLabel}" failed${sqlState ? ` (SQLSTATE ${sqlState})` : ''}.`,
  ) as Error & { code?: string; sqlState?: string };
  if (sqlState) {
    safeErr.code = sqlState;
    safeErr.sqlState = sqlState;
  }
  return safeErr;
}

async function acquireEntraManagedIdentityPostgresToken(
  clientId?: string,
): Promise<string> {
  const resource = 'https://ossrdbms-aad.database.windows.net';
  const identityEndpoint = process.env.IDENTITY_ENDPOINT?.trim();
  const identityHeader = process.env.IDENTITY_HEADER?.trim();

  if (identityEndpoint && identityHeader) {
    const url = new URL(identityEndpoint);
    url.searchParams.set('api-version', '2019-08-01');
    url.searchParams.set('resource', resource);
    if (clientId) {
      url.searchParams.set('client_id', clientId);
    }
    const res = await fetch(url.toString(), {
      headers: { 'X-IDENTITY-HEADER': identityHeader },
    });
    if (!res.ok) {
      throw new Error(
        `TENANCY_ENTRA_TOKEN_ERROR: Managed identity token request failed with status ${res.status}.`,
      );
    }
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new Error(
        'TENANCY_ENTRA_TOKEN_ERROR: Managed identity response did not contain an access_token.',
      );
    }
    return body.access_token;
  }

  const imdsUrl = new URL('http://169.254.169.254/metadata/identity/oauth2/token');
  imdsUrl.searchParams.set('api-version', '2018-02-01');
  imdsUrl.searchParams.set('resource', resource);
  if (clientId) {
    imdsUrl.searchParams.set('client_id', clientId);
  }
  const res = await fetch(imdsUrl.toString(), {
    headers: { Metadata: 'true' },
  });
  if (!res.ok) {
    throw new Error(
      `TENANCY_ENTRA_TOKEN_ERROR: Azure IMDS token request failed with status ${res.status}.`,
    );
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error(
      'TENANCY_ENTRA_TOKEN_ERROR: Azure IMDS response did not contain an access_token.',
    );
  }
  return body.access_token;
}

function isLocalPostgresHost(host: string): boolean {
  const lower = host.trim().toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === 'postgres' || lower === 'pgbouncer';
}

/**
 * Password authentication never falls back to a built-in password (rule 5, fail closed).
 * Local `.env` files and CI set the variable explicitly.
 */
export function requirePostgresPasswordEnv(
  name:
    | 'PLATFORM_POSTGRES_RUNTIME_PASSWORD'
    | 'PLATFORM_POSTGRES_MIGRATE_PASSWORD',
): string {
  const value = process.env[name];
  if (!value) {
    const err = new Error(
      `TENANCY_DB_CONFIG_ERROR: ${name} must be set when PostgreSQL password authentication is used.`,
    ) as Error & { code: string };
    err.code = 'TENANCY_DB_CONFIG_ERROR';
    throw err;
  }
  return value;
}

async function ensurePgParsersInitialised(): Promise<typeof PgTypes> {
  const pg = await loadPgModule();
  if (!pgTypeParsersConfigured && pg.types?.setTypeParser) {
    // Keep PostgreSQL DATE (OID 1082) as exact 'YYYY-MM-DD' strings independent of server timezone.
    pg.types.setTypeParser(PG_DATE_OID, (val: string) => val);
    pgTypeParsersConfigured = true;
  }
  return pg;
}

export class TenantPostgresPoolManager {
  private readonly pools = new Map<string, ManagedPoolEntry>();
  private readonly readySchemas = new Map<string, number>();
  private readonly options: TenantPostgresPoolManagerOptions;

  public constructor(options: TenantPostgresPoolManagerOptions = {}) {
    this.options = options;
  }

  public resolveRuntimeTarget(
    ctx: TenantContext,
  ): ResolvedTenantPostgresRuntimeTarget {
    assertValidPostgresTenantContext(ctx);
    const configuredHost =
      ctx.configuredPostgresHost?.trim() ||
      process.env.PLATFORM_POSTGRES_HOST?.trim() ||
      (ctx.hostingMode === 'single_tenant'
        ? `${ctx.tenantId}-pg-${ctx.environment}.postgres.database.azure.com`
        : `platform-shared-pool-${ctx.environment}.postgres.database.azure.com`);

    const port = Number(process.env.PLATFORM_POSTGRES_PORT || 6432);
    const databaseName = ctx.postgresDatabaseName;
    const tenantRoleName = resolveTenantPostgresRoleName(ctx);
    const useTls =
      process.env.PLATFORM_POSTGRES_SSL === 'true' ||
      (!isLocalPostgresHost(configuredHost) &&
        process.env.PLATFORM_POSTGRES_SSL !== 'false');

    return {
      host: configuredHost,
      port,
      databaseName,
      tenantRoleName,
      ssl: useTls ? { rejectUnauthorized: true } : false,
    };
  }

  public async getPoolForTenant(ctx: TenantContext): Promise<{
    pool: PgTypes.Pool;
    target: ResolvedTenantPostgresRuntimeTarget;
  }> {
    const pg = await ensurePgParsersInitialised();
    const target = this.resolveRuntimeTarget(ctx);
    const poolKey = `${target.host}:${target.port}:${target.databaseName}`;
    const now = Date.now();

    this.evictIdlePools(now);

    const existing = this.pools.get(poolKey);
    if (existing) {
      existing.lastUsedAtMs = now;
      // R439: the role always comes from this call's context, never from whichever context
      // first opened the shared pool for this database.
      return { pool: existing.pool, target };
    }

    const runtimeUser =
      process.env.PLATFORM_POSTGRES_RUNTIME_USER?.trim() || 'runtime_login';
    const authMode = process.env.PLATFORM_POSTGRES_AUTH_MODE?.trim();
    const useEntraAuth =
      authMode === 'entra_managed_identity' ||
      (!authMode &&
        !isLocalPostgresHost(target.host) &&
        !process.env.PLATFORM_POSTGRES_RUNTIME_PASSWORD);

    const passwordConfig: string | (() => Promise<string>) = useEntraAuth
      ? () =>
          acquireEntraManagedIdentityPostgresToken(
            process.env.AZURE_RUNTIME_CLIENT_ID?.trim() ||
              process.env.AZURE_CLIENT_ID?.trim() ||
              undefined,
          )
      : requirePostgresPasswordEnv('PLATFORM_POSTGRES_RUNTIME_PASSWORD');

    const pool = new pg.Pool({
      host: target.host,
      port: target.port,
      database: target.databaseName,
      user: runtimeUser,
      password: passwordConfig,
      ssl: target.ssl,
      max:
        this.options.maxConnectionsPerTenant ??
        Number(process.env.PLATFORM_POSTGRES_POOL_MAX || 5),
      idleTimeoutMillis: this.options.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: this.options.connectionTimeoutMillis ?? 10_000,
    });

    pool.on('error', () => {
      // Prevent unhandled idle client error events from crashing the process or logging raw pg internals.
    });

    const managed: ManagedPoolEntry = {
      pool,
      lastUsedAtMs: now,
      target,
    };
    this.pools.set(poolKey, managed);
    return { pool, target };
  }

  public isTenantSchemaReady(
    databaseName: string,
    requiredVersion: string,
  ): boolean {
    const key = `${databaseName}::${requiredVersion}`;
    const markedAtMs = this.readySchemas.get(key);
    if (markedAtMs === undefined) {
      return false;
    }
    const ttlMs = this.options.schemaReadyTtlMs ?? 30_000;
    if (Date.now() - markedAtMs > ttlMs) {
      this.readySchemas.delete(key);
      return false;
    }
    return true;
  }

  public markTenantSchemaReady(
    databaseName: string,
    requiredVersion: string,
  ): void {
    this.readySchemas.set(`${databaseName}::${requiredVersion}`, Date.now());
  }

  public invalidateSchemaReadiness(databaseName?: string): void {
    if (!databaseName) {
      this.readySchemas.clear();
      return;
    }
    for (const key of Array.from(this.readySchemas.keys())) {
      if (key.startsWith(`${databaseName}::`)) {
        this.readySchemas.delete(key);
      }
    }
  }

  public evictIdlePools(nowMs = Date.now()): void {
    const evictionMs =
      this.options.poolIdleEvictionMs ??
      Number(process.env.PLATFORM_POSTGRES_POOL_EVICTION_MS || 10 * 60 * 1000);
    for (const [key, entry] of this.pools.entries()) {
      if (nowMs - entry.lastUsedAtMs > evictionMs && entry.pool.waitingCount === 0 &&
        // R441: never end a pool that still has checked-out clients.
        entry.pool.totalCount === entry.pool.idleCount
      ) {
        this.pools.delete(key);
        void entry.pool.end().catch(() => {});
      }
    }
  }

  public async closeAllPools(): Promise<void> {
    const entries = Array.from(this.pools.values());
    this.pools.clear();
    this.readySchemas.clear();
    await Promise.all(entries.map((e) => e.pool.end().catch(() => {})));
  }
}

const globalPoolState = globalThis as typeof globalThis & {
  __oneSquaredTenantPgPoolManager?: TenantPostgresPoolManager;
};

export function getGlobalTenantPostgresPoolManager(): TenantPostgresPoolManager {
  if (!globalPoolState.__oneSquaredTenantPgPoolManager) {
    globalPoolState.__oneSquaredTenantPgPoolManager =
      new TenantPostgresPoolManager();
  }
  return globalPoolState.__oneSquaredTenantPgPoolManager;
}

export function invalidateGlobalTenantSchemaReadiness(
  databaseName?: string,
): void {
  globalPoolState.__oneSquaredTenantPgPoolManager?.invalidateSchemaReadiness(
    databaseName,
  );
}

/**
 * Opens a direct (non-PgBouncer) PostgreSQL connection on `PLATFORM_POSTGRES_MIGRATE_PORT` (`5432`)
 * as `migrateIdentity` / `migrate_login`, strictly for `TenantMigrationRunner` (`R401`, `R402`).
 */
export async function createDirectMigrationClient(params: {
  ctx: Pick<
    TenantContext,
    | 'tenantId'
    | 'environment'
    | 'hostingMode'
    | 'postgresDatabaseName'
    | 'configuredPostgresHost'
  >;
}): Promise<PgTypes.Client> {
  const pg = await ensurePgParsersInitialised();
  const host =
    params.ctx.configuredPostgresHost?.trim() ||
    process.env.PLATFORM_POSTGRES_MIGRATE_HOST?.trim() ||
    process.env.PLATFORM_POSTGRES_HOST?.trim();
  if (!host) {
    throw new Error(
      'TENANCY_DB_CONFIG_ERROR: PLATFORM_POSTGRES_MIGRATE_HOST or PLATFORM_POSTGRES_HOST must be set for migration connections.',
    );
  }
  const port = Number(process.env.PLATFORM_POSTGRES_MIGRATE_PORT || 5432);
  const migrateUser =
    process.env.PLATFORM_POSTGRES_MIGRATE_USER?.trim() || 'migrate_login';
  const authMode = process.env.PLATFORM_POSTGRES_AUTH_MODE?.trim();
  const useEntraAuth =
    authMode === 'entra_managed_identity' ||
    (!authMode &&
      !isLocalPostgresHost(host) &&
      !process.env.PLATFORM_POSTGRES_MIGRATE_PASSWORD);

  const password: string = useEntraAuth
    ? await acquireEntraManagedIdentityPostgresToken(
        process.env.AZURE_MIGRATE_CLIENT_ID?.trim() ||
          process.env.AZURE_CLIENT_ID?.trim() ||
          undefined,
      )
    : requirePostgresPasswordEnv('PLATFORM_POSTGRES_MIGRATE_PASSWORD');

  const useTls =
    process.env.PLATFORM_POSTGRES_SSL === 'true' ||
    (!isLocalPostgresHost(host) &&
      process.env.PLATFORM_POSTGRES_SSL !== 'false');

  const client = new pg.Client({
    host,
    port,
    database: params.ctx.postgresDatabaseName,
    user: migrateUser,
    password,
    ssl: useTls ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  return client;
}
