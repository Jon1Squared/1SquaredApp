/**
 * Base Tenant-Scoped PostgreSQL Repository (`core/src/tenancy/tenantScopedRepository.ts`).
 *
 * Enforces ADR 0028 §§2–4 & Platform Architecture Standard §8 (`R401`, `R402`, `R403`):
 * 1. NO non-transactional `withTenantConnection` and NO session-level `SET ROLE` / `RESET ROLE` (`R401`).
 * 2. Every read (`withTenantReadTransaction` -> `BEGIN READ ONLY`) and write (`withTenantTransaction` -> `BEGIN`)
 *    executes inside an explicit PostgreSQL transaction whose very first statements are:
 *      - `SET LOCAL ROLE "<role_tenant_slug_env>"`
 *      - `SET LOCAL statement_timeout = '15000ms'`
 *    Because `SET LOCAL ROLE` automatically reverts on `COMMIT` / `ROLLBACK`, PgBouncer `transaction`
 *    pooling is deterministic and never leaks roles across pooled server connections.
 * 3. Verifies on first use that the tenant database's `tenant_schema_migrations` has reached
 *    `CORE_REQUIRED_SCHEMA_VERSION`, refusing immediately with `TENANT_SCHEMA_NOT_READY` otherwise (`R403`).
 * 4. Enforces a row-level second check (`assertRowTenant`) and strips SQL text/parameters from errors.
 */

import type { TenantContext } from '../api/index';
import {
  assertValidPostgresTenantContext,
  getGlobalTenantPostgresPoolManager,
  quotePgIdentifier,
  sanitizePostgresError,
  type TenantPostgresPoolManager,
} from './postgresPoolManager';

export const CORE_REQUIRED_SCHEMA_VERSION = '0006';

export interface TenantQueryResult<TRow = Record<string, unknown>> {
  readonly rows: TRow[];
  readonly rowCount: number;
}

export interface TenantSqlClient {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<TenantQueryResult<TRow>>;
}

interface ActiveTenantTransactionScope {
  readonly poolManager: TenantPostgresPoolManager;
  readonly tenantId: string;
  readonly databaseName: string;
  readonly readOnly: boolean;
  readonly tx: TenantSqlClient;
}

interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
}

let cachedActiveTenantTxStorage:
  | AsyncLocalStorageLike<ActiveTenantTransactionScope>
  | null
  | undefined;

function getActiveTenantTxStorage(): AsyncLocalStorageLike<ActiveTenantTransactionScope> | null {
  if (cachedActiveTenantTxStorage !== undefined) {
    return cachedActiveTenantTxStorage;
  }
  if (
    typeof window !== 'undefined' ||
    typeof process.getBuiltinModule !== 'function'
  ) {
    cachedActiveTenantTxStorage = null;
    return null;
  }
  try {
    const asyncHooks = process.getBuiltinModule('node:async_hooks') as
      | typeof import('node:async_hooks')
      | undefined;
    cachedActiveTenantTxStorage = asyncHooks?.AsyncLocalStorage
      ? new asyncHooks.AsyncLocalStorage<ActiveTenantTransactionScope>()
      : null;
  } catch {
    cachedActiveTenantTxStorage = null;
  }
  return cachedActiveTenantTxStorage;
}

function createSchemaNotReadyError(params: {
  tenantId: string;
  databaseName: string;
  currentVersion: string | null;
  requiredVersion: string;
  missingVersion?: string;
}): Error & { code: string } {
  const err = new Error(
    params.missingVersion && params.currentVersion
      ? `TENANT_SCHEMA_NOT_READY: Tenant "${params.tenantId}" database "${params.databaseName}" is missing migration "${params.missingVersion}" required by "${params.requiredVersion}".`
      : `TENANT_SCHEMA_NOT_READY: Tenant "${params.tenantId}" database "${params.databaseName}" schema version is "${params.currentVersion ?? 'unmigrated'}", below required "${params.requiredVersion}".`,
  ) as Error & { code: string };
  err.code = 'TENANT_SCHEMA_NOT_READY';
  return err;
}

export function listRequiredSchemaVersions(requiredVersion: string): string[] {
  const required = Number(requiredVersion);
  if (!/^\d{4}$/.test(requiredVersion) || required < 1) {
    throw new Error(
      `TENANCY_SCHEMA_VERSION_INVALID: Required schema version "${requiredVersion}" is not a four-digit catalogue version.`,
    );
  }
  return Array.from({ length: required }, (_, i) =>
    String(i + 1).padStart(4, '0'),
  );
}

export function toIsoString(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === 'string') {
    const parsed = new Date(val);
    if (!Number.isNaN(parsed.getTime()) && val.includes(' ')) {
      return parsed.toISOString();
    }
    return val;
  }
  return new Date().toISOString();
}

export function toNullableIsoString(val: unknown): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  return toIsoString(val);
}

export abstract class TenantScopedRepository {
  protected readonly poolManager: TenantPostgresPoolManager;
  protected readonly requiredSchemaVersion: string;
  protected readonly statementTimeoutMs: number;

  public constructor(options?: {
    poolManager?: TenantPostgresPoolManager;
    requiredSchemaVersion?: string;
    statementTimeoutMs?: number;
  }) {
    this.poolManager =
      options?.poolManager ?? getGlobalTenantPostgresPoolManager();
    this.requiredSchemaVersion =
      options?.requiredSchemaVersion ?? CORE_REQUIRED_SCHEMA_VERSION;
    this.statementTimeoutMs = options?.statementTimeoutMs ?? 15_000;
  }

  protected assertRowTenant(
    ctx: TenantContext,
    rowTenantId: string | undefined | null,
    entityLabel: string,
  ): void {
    if (!rowTenantId || rowTenantId !== ctx.tenantId) {
      const err = new Error(
        `TENANCY_ISOLATION_ERROR: Cannot write or access ${entityLabel} belonging to tenant "${rowTenantId ?? 'unknown'}" under tenant "${ctx.tenantId}".`,
      ) as Error & { code: string };
      err.code = 'TENANCY_ISOLATION_ERROR';
      throw err;
    }
  }

  public async withTenantReadTransaction<T>(
    ctx: TenantContext,
    fn: (tx: TenantSqlClient) => Promise<T>,
  ): Promise<T> {
    return this.executeTransaction(ctx, true, fn);
  }

  public async withTenantTransaction<T>(
    ctx: TenantContext,
    fn: (tx: TenantSqlClient) => Promise<T>,
  ): Promise<T> {
    return this.executeTransaction(ctx, false, fn);
  }

  private async executeTransaction<T>(
    ctx: TenantContext,
    readOnly: boolean,
    fn: (tx: TenantSqlClient) => Promise<T>,
  ): Promise<T> {
    assertValidPostgresTenantContext(ctx);

    const txStorage = getActiveTenantTxStorage();
    const existingScope = txStorage?.getStore();
    if (
      existingScope &&
      existingScope.poolManager === this.poolManager &&
      existingScope.tenantId === ctx.tenantId &&
      existingScope.databaseName === ctx.postgresDatabaseName &&
      (readOnly || !existingScope.readOnly)
    ) {
      return fn(existingScope.tx);
    }

    const { pool, target } = await this.poolManager.getPoolForTenant(ctx);
    let rawClient;
    try {
      rawClient = await pool.connect();
    } catch (connectErr) {
      throw sanitizePostgresError(connectErr, 'pool.connect');
    }

    let inTransaction = false;
    try {
      await rawClient.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      inTransaction = true;

      const quotedRole = quotePgIdentifier(target.tenantRoleName);
      await rawClient.query(`SET LOCAL ROLE ${quotedRole}`);
      await rawClient.query(
        `SET LOCAL statement_timeout = '${Math.max(1000, Math.floor(this.statementTimeoutMs))}ms'`,
      );

      if (
        !this.poolManager.isTenantSchemaReady(
          target.databaseName,
          this.requiredSchemaVersion,
        )
      ) {
        let versionRows: Array<{ version: string }> = [];
        try {
          const res = await rawClient.query<{ version: string }>(
            'SELECT version FROM public.tenant_schema_migrations WHERE tenant_id = $1',
            [ctx.tenantId],
          );
          versionRows = res.rows;
        } catch (migCheckErr) {
          const pgCode = (migCheckErr as { code?: string })?.code;
          if (pgCode === '42P01') {
            await rawClient.query('ROLLBACK');
            inTransaction = false;
            throw createSchemaNotReadyError({
              tenantId: ctx.tenantId,
              databaseName: target.databaseName,
              currentVersion: null,
              requiredVersion: this.requiredSchemaVersion,
            });
          }
          throw migCheckErr;
        }

        const appliedVersions = new Set(versionRows.map((r) => r.version));
        const maxVersion =
          [...appliedVersions].sort().at(-1) ?? null;
        // R437: every catalogue version up to the required one must be applied, not only the
        // highest. Catalogue versions are contiguous four-digit numbers (validated in tests).
        const missingVersion = listRequiredSchemaVersions(
          this.requiredSchemaVersion,
        ).find((v) => !appliedVersions.has(v));
        if (!maxVersion || missingVersion) {
          await rawClient.query('ROLLBACK');
          inTransaction = false;
          throw createSchemaNotReadyError({
            tenantId: ctx.tenantId,
            databaseName: target.databaseName,
            currentVersion: maxVersion,
            requiredVersion: this.requiredSchemaVersion,
            ...(missingVersion && maxVersion !== null && maxVersion >= this.requiredSchemaVersion
              ? { missingVersion }
              : {}),
          });
        }
        this.poolManager.markTenantSchemaReady(
          target.databaseName,
          this.requiredSchemaVersion,
        );
      }

      const wrappedTx: TenantSqlClient = {
        query: async <TRow = Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[],
        ): Promise<TenantQueryResult<TRow>> => {
          try {
            const res = await rawClient.query(
              sql,
              params ? [...params] : undefined,
            );
            return {
              rows: res.rows as TRow[],
              rowCount: res.rowCount ?? res.rows.length,
            };
          } catch (queryErr) {
            if ((queryErr as { code?: string })?.code === '42P01') {
              // A missing relation means the schema changed under us (R437): re-check next time.
              this.poolManager.invalidateSchemaReadiness(target.databaseName);
            }
            throw sanitizePostgresError(queryErr, 'query');
          }
        },
      };

      const scope: ActiveTenantTransactionScope = {
        poolManager: this.poolManager,
        tenantId: ctx.tenantId,
        databaseName: ctx.postgresDatabaseName,
        readOnly,
        tx: wrappedTx,
      };
      const result = txStorage
        ? await txStorage.run(scope, () => fn(wrappedTx))
        : await fn(wrappedTx);

      await rawClient.query('COMMIT');
      inTransaction = false;
      return result;
    } catch (err) {
      if (inTransaction) {
        await rawClient.query('ROLLBACK').catch(() => {});
      }
      throw sanitizePostgresError(err, 'transaction');
    } finally {
      rawClient.release();
    }
  }
}
