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
const PG_SAFE_IDENT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/;

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

/**
 * Exact set of production domain error codes that may pass through
 * `sanitizePostgresError` unchanged (R846). Anything outside this exact set —
 * including PostgreSQL driver errors or unrecognised codes/prefixes — is
 * collapsed to a neutral error (`TENANCY_DATABASE_ERROR`, `JOB_STATEMENT_TIMEOUT`,
 * `TENANCY_DATABASE_PERMISSION_DENIED`, or `TENANCY_FOREIGN_KEY_RESTRICT`).
 */
export const PASSTHROUGH_DOMAIN_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  // Tenancy & registry
  'TENANCY_ACTOR_MISMATCH',
  'TENANCY_AUDIT_TRANSACTION_REQUIRED',
  'TENANCY_AUDIT_WRITE_ERROR',
  'TENANCY_AUTH_ERROR',
  'TENANCY_BROWSER_FORBIDDEN',
  'TENANCY_CACHE_ERROR',
  'TENANCY_CACHE_ISOLATION_ERROR',
  'TENANCY_CLAIM_ERROR',
  'TENANCY_CROSS_TENANT_RECORD_ACCESS',
  'TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED',
  'TENANCY_DATABASE_ERROR',
  'TENANCY_DATABASE_PERMISSION_DENIED',
  'TENANCY_DB_CONFIG_ERROR',
  'TENANCY_ENTRA_TOKEN_ERROR',
  'TENANCY_FOREIGN_KEY_RESTRICT',
  'TENANCY_FORGERY_DETECTED',
  'TENANCY_INVALID_SAVEPOINT_NAME',
  'TENANCY_ISOLATION_ERROR',
  'TENANCY_JOB_ERROR',
  'TENANCY_MIGRATION_CHECKSUM_MISMATCH',
  'TENANCY_MIGRATION_ERROR',
  'TENANCY_OBSERVABILITY_ERROR',
  'TENANCY_SCHEMA_VERSION_INVALID',
  'TENANCY_SEQUENCE_ERROR',
  'TENANCY_SQL_IDENTIFIER_REJECTED',
  'TENANCY_TRANSACTION_ABORTED',
  'TENANCY_TRANSACTION_REQUIRED',
  'TENANCY_UNFLUSHED_AUDIT_ERROR',
  'TENANCY_UNREGISTERED_JOB_TENANT',
  'TENANT_CONFIG_ERROR',
  'TENANT_CONFIG_MISMATCH',
  'TENANT_ISOLATION_VIOLATION',
  'TENANT_MISMATCH',
  'TENANT_REGISTRY_BROWSER_FORBIDDEN',
  'TENANT_REGISTRY_DATABASE_MISMATCH',
  'TENANT_REGISTRY_ERROR',
  'TENANT_SCHEMA_NOT_READY',

  // Key dates
  'CALCULATOR_INVALID_DATE',
  'INVALID_CLOSURE_DATE',
  'KEY_DATE_ACCESS_DENIED',
  'KEY_DATE_CONCURRENCY_CONFLICT',
  'KEY_DATE_ENTITY_ERROR',
  'KEY_DATE_ENTITY_IMMUTABLE',
  'KEY_DATE_INVALID_STATE',
  'KEY_DATE_MANUAL_ENTRY_FORBIDDEN',
  'KEY_DATE_NOT_APPLICABLE_DISALLOWED',
  'KEY_DATE_NOT_FOUND',
  'KEY_DATE_OUTCOME_NOTE_REQUIRED',
  'KEY_DATE_OVERRIDE_REASON_REQUIRED',
  'KEY_DATE_PERMISSION_DENIED',
  'KEY_DATE_PERMISSION_ERROR',
  'KEY_DATE_REASON_REQUIRED',
  'KEY_DATE_REJECT_ERROR',
  'KEY_DATE_REJECT_REASON_REQUIRED',
  'KEY_DATE_REMINDER_NOT_FOUND',
  'KEY_DATE_STATUS_ERROR',
  'KEY_DATE_SUPERSEDE_REASON_REQUIRED',
  'KEY_DATE_TRANSACTION_REQUIRED',
  'KEY_DATE_VALIDATION_ERROR',
  'KEY_DATE_VERIFY_ERROR',
  'OPEN_KEY_DATES_BLOCK_CLOSURE',

  // Matters, opening gate, parties, rates, registers
  'MATTER_ALREADY_CLOSED',
  'MATTER_CONCURRENCY_CONFLICT',
  'MATTER_EXTRACTION_UNAVAILABLE',
  'MATTER_NOT_CLOSED',
  'MATTER_NOT_FOUND',
  'MATTER_NOT_OPENED',
  'MATTER_NUMBERING_VALIDATION_ERROR',
  'MATTER_NUMBER_IMMUTABLE',
  'MATTER_OPENING_GATE_BLOCKED',
  'MATTER_RATE_OVERRIDES_DISABLED',
  'MATTER_STATUS_NOT_CONFIGURED',
  'OPENING_GATE_INCONSISTENT',
  'OPENING_GATE_OVERRIDE_ALREADY_ACTIVE',
  'OPENING_GATE_OVERRIDE_FORBIDDEN',
  'OPENING_GATE_OVERRIDE_VALIDATION_ERROR',
  'PARTY_MERGE_VALIDATION_ERROR',
  'RATE_OVERRIDE_DATE_OVERLAP',
  'RATE_OVERRIDE_INVALID_DATE_RANGE',
  'RATE_OVERRIDE_VALIDATION_ERROR',
  'REGISTER_APPROVER_MISMATCH',
  'REGISTER_CONCURRENCY_CONFLICT',
  'REGISTER_DISTINCT_APPROVER_REQUIRED',
  'REGISTER_INVALID_TRANSITION',
  'REGISTER_NOT_FOUND',
  'REGISTER_SELF_APPROVAL_FORBIDDEN',
  'REGISTER_SYSTEM_ONLY_TRANSITION',
  'REGISTER_TYPE_DISABLED',
  'REGISTER_VALIDATION_ERROR',

  // Intake, CDD, quotes, tasks, sign-offs, notifications
  'CDD_CONFIG_INVALID',
  'CONFLICT_ERROR',
  'CONFLICT_INSUFFICIENT_DETAIL',
  'INTAKE_CHECK_EVIDENCE_CHECKSUM_MISMATCH',
  'INTAKE_CHECK_INVALID_ACTOR',
  'INTAKE_CHECK_INVALID_AMOUNT',
  'INTAKE_CHECK_INVALID_EVIDENCE',
  'INTAKE_CHECK_INVALID_OUTCOME',
  'INTAKE_CHECK_INVALID_REFERENCE',
  'INTAKE_CHECK_INVALID_SUBJECT',
  'INTAKE_CHECK_PROVIDER_NOT_SUPPORTED',
  'INTAKE_CHECK_UNAUTHENTICATED',
  'INTAKE_CHECK_UNSAFE_EVIDENCE',
  'INTAKE_SEQUENCE_ERROR',
  'INTAKE_VALIDATION_ERROR',
  'INTAKE_WRITE_ERROR',
  'QUOTE_SEQUENCE_ERROR',
  'QUOTE_VALIDATION_ERROR',
  'QUOTE_WRITE_ERROR',
  'TASK_SEQUENCE_ERROR',
  'TASK_VALIDATION_ERROR',
  'TASK_WRITE_ERROR',
  'NOTIFICATION_PREFERENCE_INVALID',
  'NOTIFICATION_VALIDATION_ERROR',
  'NOTIFICATION_WRITE_ERROR',
  'SIGN_OFF_ID_CONFLICT',
  'SIGN_OFF_VALIDATION_ERROR',
  'SIGN_OFF_WRITE_ERROR',

  // HR, RBAC, teams, catalogue, PMS, jobs, migrations
  'HR_SENSITIVE_VALIDATION_ERROR',
  'TEAM_VALIDATION_ERROR',
  'RBAC_CONFIG_CONCURRENCY_CONFLICT',
  'RBAC_CONFIG_INVALID',
  'RBAC_CONFIG_REQUIRED',
  'RBAC_PERMISSION_DENIED',
  'RBAC_TENANT_REQUIRED',
  'CATALOGUE_CONFIG_VALIDATION_ERROR',
  'CHOICE_LIST_VALIDATION_ERROR',
  'CHOICE_VALUE_NOT_CONFIGURED',
  'CHOICE_VALUE_NOT_FOUND',
  'CHOICE_VALUE_VALIDATION_ERROR',
  'CUSTOM_FIELD_NOT_FOUND',
  'CUSTOM_FIELD_VALIDATION_ERROR',
  'FIRM_PROFILE_VALIDATION_ERROR',
  'PMS_INVALID_AS_AT_DATE',
  'PMS_LINK_VALIDATION_ERROR',
  'PMS_OUTBOUND_TENANCY_ERROR',
  'PMS_PENCE_CONVERSION_MISMATCH',
  'JOB_EXECUTION_FAILED',
  'JOB_STATEMENT_TIMEOUT',
  'JOB_TENANT_TIMEOUT',
  'MIGRATION_CATALOGUE_ORDER_ERROR',
  'MIGRATION_DEPENDENCY_ERROR',
  'MIGRATION_ROLLBACK_ORDER_ERROR',
  'LIVE_AUDIT_RESET_FORBIDDEN',
  'DEMO_DATA_LIVE_FORBIDDEN',
  'EXTENSION_TRANSACTION_FORBIDDEN',

  // Documents, templates, storage, evidence, engagement, chasing, email, teams
  'DOCUMENT_ACCESS_DENIED',
  'DOCUMENT_GENERATION_DISABLED',
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_PATH_LENGTH_EXCEEDED',
  'DOCUMENT_PERMISSION_DENIED',
  'DOCUMENT_RECORD_ACCESS_DENIED',
  'DOCUMENT_ROUTING_ERROR',
  'DOCUMENT_TENANCY_ERROR',
  'PDF_CONVERTER_FAILED',
  'TEMPLATE_INVALID_EXTENSION',
  'TEMPLATE_INVALID_ROLE_KEY',
  'TEMPLATE_INVALID_TRANSITION',
  'TEMPLATE_MALWARE_DETECTED',
  'TEMPLATE_NOT_ACTIVE',
  'TEMPLATE_NOT_AVAILABLE_IN_CONTEXT',
  'TEMPLATE_NOT_FOUND',
  'TEMPLATE_OPERATION_ERROR',
  'TEMPLATE_PACKAGE_INVALID',
  'TEMPLATE_REJECTION_REASON_REQUIRED',
  'TEMPLATE_ROLLBACK_INVALID',
  'TEMPLATE_SELF_APPROVAL_FORBIDDEN',
  'TEMPLATE_SIZE_EXCEEDED',
  'TEMPLATE_UNMAPPED_PLACEHOLDERS',
  'TEMPLATE_VERSION_IMMUTABLE',
  'TEMPLATE_VERSION_NOT_ACTIVE',
  'TEMPLATE_VERSION_NOT_FOUND',
  'STORAGE_CONFIG_ERROR',
  'STORAGE_FS_UNAVAILABLE',
  'STORAGE_INVALID_CATEGORY',
  'STORAGE_LIVE_LOCAL_FS_FORBIDDEN',
  'STORAGE_MALWARE_BLOCKED',
  'STORAGE_NOT_FOUND',
  'STORAGE_PROVIDER_MISMATCH',
  'STORAGE_PROVIDER_NOT_SUPPORTED',
  'STORAGE_SECURITY_ERROR',
  'STORAGE_TENANCY_ERROR',
  'STORAGE_TENANCY_ISOLATION_ERROR',
  'STORAGE_TOKEN_ACTOR_MISMATCH',
  'STORAGE_TOKEN_EXPIRED',
  'STORAGE_TOKEN_FORGERY',
  'STORAGE_TOKEN_INVALID',
  'EVIDENCE_MALWARE_DETECTED',
  'ENGAGEMENT_CONFIG_INVALID',
  'ENGAGEMENT_CONFIG_VALIDATION_ERROR',
  'ENGAGEMENT_DISPATCH_INVALID',
  'ENGAGEMENT_SIGNED_COPY_REQUIRED',
  'COMMUNICATION_CHASE_INVALID',
  'CHASE_STEP_ERROR',
  'CHASING_CONFIG_INVALID',
  'CHASING_VALIDATION_ERROR',
  'EMAIL_ADDRESS_INVALID',
  'EMAIL_ALLOWLIST_BLOCKED',
  'EMAIL_ALLOWLIST_EMPTY',
  'EMAIL_ALLOWLIST_VAULT_UNREADABLE',
  'EMAIL_ATTACHMENT_INVALID',
  'EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED',
  'EMAIL_ATTACHMENT_STORAGE_UNAVAILABLE',
  'EMAIL_DEV_CATCHER_FORBIDDEN_IN_LIVE',
  'EMAIL_GRAPH_NOT_CONFIGURED',
  'EMAIL_KEYVAULT_AUTH_FAILED',
  'EMAIL_KEYVAULT_SECRET_EMPTY',
  'EMAIL_OUTBOX_ATTACHMENT_CORRUPTED',
  'EMAIL_OUTBOX_ATTACHMENT_MISSING',
  'EMAIL_OUTBOX_INVALID',
  'EMAIL_PROVIDER_NOT_IMPLEMENTED',
  'EMAIL_RECIPIENTS_EMPTY',
  'EMAIL_SENDER_ADDRESS_REQUIRED',
  'EMAIL_SMTP_CONNECTION_CLOSED',
  'EMAIL_SMTP_CONNECTION_FAILED',
  'EMAIL_SMTP_SERVER_RUNTIME_REQUIRED',
  'EMAIL_SMTP_TIMEOUT',
  'TEAMS_ACTIVITY_INVALID',
  'TEAMS_ALLOWLIST_BLOCKED',
  'TEAMS_ALLOWLIST_EMPTY',
  'TEAMS_ALLOWLIST_VAULT_UNREADABLE',
  'TEAMS_CONTENT_SCRUB_REJECTED',
  'TEAMS_DEEPLINK_FORBIDDEN',
  'TEAMS_DEV_CATCHER_ENDPOINT_INVALID',
  'TEAMS_DEV_CATCHER_ENDPOINT_REQUIRED',
  'TEAMS_DEV_CATCHER_FORBIDDEN_IN_LIVE',
  'TEAMS_GRAPH_CONFIG_INVALID',
  'TEAMS_OUTBOX_INVALID',
  'TEAMS_PROVIDER_DISABLED',
  'TEAMS_RECIPIENT_ID_MISSING',
  'TEAMS_RECIPIENT_UNBOUND',
]);

export function sanitizePostgresError(
  err: unknown,
  contextLabel: string,
): Error & { code?: string; sqlState?: string } {
  if (err instanceof Error) {
    const existingCode = (err as { code?: unknown }).code;
    if (
      typeof existingCode === 'string' &&
      PASSTHROUGH_DOMAIN_ERROR_CODES.has(existingCode)
    ) {
      return err as Error & { code?: string };
    }
    const msgCode = /^([A-Z][A-Z0-9_]+)(?::|\s|$)/.exec(err.message)?.[1];
    if (msgCode && PASSTHROUGH_DOMAIN_ERROR_CODES.has(msgCode)) {
      return err as Error & { code?: string };
    }
  }

  const rawCode =
    typeof (err as { code?: unknown })?.code === 'string'
      ? String((err as { code?: unknown }).code)
      : undefined;
  const sqlState =
    rawCode && /^[0-9A-Z]{5}$/.test(rawCode) ? rawCode : undefined;

  if (sqlState === '57014') {
    const timeoutErr = new Error(
      `JOB_STATEMENT_TIMEOUT: PostgreSQL statement timeout exceeded during ${contextLabel} (SQLSTATE 57014).`,
    ) as Error & { code: string; sqlState: string };
    timeoutErr.code = 'JOB_STATEMENT_TIMEOUT';
    timeoutErr.sqlState = '57014';
    return timeoutErr;
  }

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

export async function acquireEntraManagedIdentityPostgresToken(
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

export function resolvePostgresRuntimeUser(): string {
  return (
    process.env.PLATFORM_POSTGRES_RUNTIME_USER?.trim() ||
    process.env.PLATFORM_POSTGRES_USER?.trim() ||
    'runtime_login'
  );
}

export function resolvePostgresMigrateUser(): string {
  return (
    process.env.PLATFORM_POSTGRES_MIGRATE_USER?.trim() ||
    process.env.PLATFORM_POSTGRES_USER?.trim() ||
    'migrate_login'
  );
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

    const runtimeUser = resolvePostgresRuntimeUser();
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
              process.env.PLATFORM_POSTGRES_CLIENT_ID?.trim() ||
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
  const migrateUser = resolvePostgresMigrateUser();
  const authMode = process.env.PLATFORM_POSTGRES_AUTH_MODE?.trim();
  const useEntraAuth =
    authMode === 'entra_managed_identity' ||
    (!authMode &&
      !isLocalPostgresHost(host) &&
      !process.env.PLATFORM_POSTGRES_MIGRATE_PASSWORD);

  const password: string = useEntraAuth
    ? await acquireEntraManagedIdentityPostgresToken(
        process.env.AZURE_MIGRATE_CLIENT_ID?.trim() ||
          process.env.PLATFORM_POSTGRES_CLIENT_ID?.trim() ||
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
