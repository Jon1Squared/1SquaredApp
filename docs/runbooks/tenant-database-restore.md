# Single-Tenant PostgreSQL Point-in-Time Restore Runbook (S0-14)

This runbook covers restoring a **single tenant's** PostgreSQL database (`pg_tenant_<slug>_<env>`) to a point in time on Azure Database for PostgreSQL Flexible Server without disrupting any other tenant on a shared hosted server, as specified in [ADR 0028 §7](../decisions/0028-tenant-database-and-repositories.md) and slice `S0-14` (`R402`).

> **Manual blocker (`docs/roadmap/stage-0-plan.md` §8):** Executing the quarterly restore drill against Azure Database for PostgreSQL Flexible Server waits on Azure subscription access. Privilege re-application (`R402`) and schema readiness verification (`R403`) are exercised in CI against PostgreSQL 16 (`core/tests/migrations-postgres.test.ts`).

---

## 1. Scope and Isolation Guarantee

- **Model A (single-tenant client Azure):** Each client has a dedicated Flexible Server (`psql-<slug>-<env>`), or a dedicated server specified via `database.dedicatedServerHost`. Point-in-time recovery (PITR) restores that tenant's server directly into a staged server before cut-over.
- **Model B (hosted multi-tenant):** Multiple tenants share the hosted Flexible Server (`psql-shared-<env>`), each in an isolated database (`pg_tenant_<slug>_<env>`) accessed exclusively via `SET LOCAL ROLE role_tenant_<slug>_<env>` from the `NOINHERIT` `runtime_login` (`id-runtime-<env>`). **Never** overwrite the shared Flexible Server in place — always restore to a temporary server, dump only the target tenant's database, and restore into a staged database on the live server.
- **Zero PII in operator logs:** Record only `tenantId`, `environment`, `correlationId`, timestamps, migration versions, and row counts during the incident or drill.

---

## 2. Step-by-Step Single-Tenant Restore Procedure

Set shell variables for the target tenant and recovery point (UTC ISO-8601):

```bash
export ENV="live"
export SLUG="<tenant_slug>"                  # normalised lowercase underscore slug
export DB_NAME="pg_tenant_${SLUG}_${ENV}"
export TENANT_ROLE="role_tenant_${SLUG}_${ENV}"
export RUNTIME_LOGIN="id-runtime-${ENV}"
export MIGRATE_LOGIN="id-migrate-${ENV}"
export PITR_UTC="2026-11-09T14:30:00Z"
export RG="rg-onesquared-${ENV}-uksouth"
export LIVE_SERVER="psql-shared-${ENV}"
export TEMP_SERVER="psql-pitr-${SLUG}-$(date +%s)"
```

### Step 1 — Restore Flexible Server Backup to an Isolated Temporary Server

Restore the server backup to `TEMP_SERVER` inside the same private VNet PostgreSQL delegated subnet (`snet-postgres`, UK South):

```bash
az postgres flexible-server restore \
  --resource-group "$RG" \
  --name "$TEMP_SERVER" \
  --source-server "$LIVE_SERVER" \
  --restore-time "$PITR_UTC"
```

Wait until `TEMP_SERVER` reports `Ready`. No application traffic points to `TEMP_SERVER`.

### Step 2 — Dump Only the Target Tenant's Database

From a maintenance container or jump host inside the VNet, authenticate as `$MIGRATE_LOGIN` (Entra ID access token for `https://ossrdbms-aad.database.windows.net/.default`) against **direct port `5432`** on `TEMP_SERVER` and export only `$DB_NAME` without source ownership or ACL drift:

```bash
export PGPASSWORD="$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)"

pg_dump \
  --host="${TEMP_SERVER}.postgres.database.azure.com" \
  --port=5432 \
  --username="$MIGRATE_LOGIN" \
  --dbname="$DB_NAME" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="/tmp/${DB_NAME}.dump"
```

### Step 3 — Restore into a Staged Database on the Live Server

Connect to the live server (`${LIVE_SERVER}.postgres.database.azure.com`, **direct port `5432`**, bypassing PgBouncer) as `$MIGRATE_LOGIN`, create `${DB_NAME}_restored`, and load the dump:

```bash
psql "host=${LIVE_SERVER}.postgres.database.azure.com port=5432 dbname=postgres user=${MIGRATE_LOGIN} sslmode=verify-full" \
  -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE ${DB_NAME}_restored;"

pg_restore \
  --host="${LIVE_SERVER}.postgres.database.azure.com" \
  --port=5432 \
  --username="$MIGRATE_LOGIN" \
  --dbname="${DB_NAME}_restored" \
  --no-owner \
  --no-acl \
  --exit-on-error \
  "/tmp/${DB_NAME}.dump"
```

### Step 4 — Explicitly Re-Apply the `R402` Least-Privilege Grant Model

Because `pg_dump --no-owner --no-acl` strips ACLs and `CREATE DATABASE` grants default `PUBLIC` access, **you must re-apply the full `R402` privilege model on `${DB_NAME}_restored` before swapping** so that:
- `PUBLIC` has zero `CONNECT`, `CREATE`, or `USAGE` privileges;
- `$RUNTIME_LOGIN` remains `NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER` with role membership in `$TENANT_ROLE` and **zero** direct schema, table, or sequence privileges;
- `$TENANT_ROLE` has `USAGE` on `public` and table/sequence privileges only inside its own database (and `SELECT, INSERT` only — never `UPDATE` or `DELETE` — on `public.audit_entries` once `0007` is applied).

Run as `$MIGRATE_LOGIN` on `${DB_NAME}_restored` (port `5432`):

```sql
-- 1. Verify runtime login flags and tenant role membership
ALTER ROLE :"runtime_login" WITH LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER;
GRANT :"tenant_role" TO :"runtime_login";

-- 2. Lock down database-level CONNECT privileges
REVOKE ALL ON DATABASE :"restored_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"restored_db" TO :"runtime_login", :"tenant_role";

-- 3. Lock down public schema privileges (blocks cross-database access if a pool is ever misrouted)
REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM :"runtime_login";
GRANT USAGE ON SCHEMA public TO :"tenant_role";

-- 4. Grant table and sequence privileges exclusively to the per-tenant role
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, :"runtime_login";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, :"runtime_login";

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"tenant_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"tenant_role";

-- 5. Preserve append-only immutability on firm audit_entries (migration 0007+)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'audit_entries'
  ) THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON TABLE public.audit_entries FROM %I', :'tenant_role');
    EXECUTE format('GRANT SELECT, INSERT ON TABLE public.audit_entries TO %I', :'tenant_role');
  END IF;
END $$;

-- 6. Restore default privileges for future expand migrations run by migrate_login
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrate_login" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"tenant_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrate_login" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"tenant_role";
```

Verify the privilege boundary before proceeding:
1. Connect as `$RUNTIME_LOGIN` **without** `SET LOCAL ROLE` and confirm `SELECT * FROM public.tenant_schema_migrations;` fails with `SQLSTATE 42501` (`permission denied for schema public`).
2. Run `BEGIN READ ONLY; SET LOCAL ROLE <TENANT_ROLE>; SELECT version FROM public.tenant_schema_migrations ORDER BY version; COMMIT;` and confirm it succeeds.

### Step 5 — Verify `tenant_schema_migrations` Readiness (`R403`)

Compare the highest `version` in `${DB_NAME}_restored.public.tenant_schema_migrations` against the running application revision's `CORE_REQUIRED_SCHEMA_VERSION`:
- If the PITR timestamp precedes a recent expand migration, run `TenantMigrationRunner` (`node dist/jobs/run-job.mjs migrate` targeting `${DB_NAME}_restored`) so `${DB_NAME}_restored` reaches `CORE_REQUIRED_SCHEMA_VERSION` before swap. Otherwise `TenantScopedRepository` will fail closed with `TENANT_SCHEMA_NOT_READY`.

### Step 6 — Atomic Database Rename Swap and Cleanup

Terminate active backend sessions **for `$DB_NAME` only** (other tenants' databases on `$LIVE_SERVER` are unaffected), swap the databases, and verify health:

```sql
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'db_name' AND pid <> pg_backend_pid();

ALTER DATABASE :"db_name" RENAME TO :"pre_restore_backup_db";
ALTER DATABASE :"restored_db" RENAME TO :"db_name";
```

1. Verify tenant requests succeed through PgBouncer (`6432`) with zero `42501` or `TENANT_SCHEMA_NOT_READY` errors.
2. Delete the temporary dump file (`/tmp/${DB_NAME}.dump`) and destroy `$TEMP_SERVER`:
   ```bash
   rm -f "/tmp/${DB_NAME}.dump"
   az postgres flexible-server delete --resource-group "$RG" --name "$TEMP_SERVER" --yes
   ```
3. Retain `${DB_NAME}_pre_restore_<ts>` for the incident sign-off window (typically 24–72 hours), then `DROP DATABASE` once signed off by the firm administrator and platform owner.
