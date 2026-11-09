# ADR 0028: Tenant Databases and Repositories

- **Date:** 2026-11-06 (revised 2026-11-09 after review)
- **Status:** Accepted (2026-11-09)
- **Roadmap:** Stage 0 decision D3, slices S0-14 to S0-17 and S0-20 (`docs/roadmap/stage-0-plan.md`); backlog gaps P2 and P8
- **Builds on:** [ADR 0001](./0001-shared-repo-and-transitional-store.md) (transitional store), [ADR 0024](./0024-azure-container-apps-hosting.md) (hosting), [ADR 0030](./0030-tenant-aware-scheduler.md) (jobs)

## Context

Section 8 of the standard requires:
- a database per tenant, with isolation enforced by the database rather than by application filters alone (items 3 and 4)
- encryption keys per tenant (item 5)
- independent backup and restore for each tenant (item 9)
- migrations tracked per tenant that can be rolled back (section 11)

At commit `147ac61`, none of this is real yet:

- **No real database.**
  - `PostgresTenantCluster` (`core/src/tenancy/index.ts:152`) is an in-memory map keyed by database name.
  - No Postgres driver is installed.
  - The connection settings from `resolveTenantPostgresConfig` (`:124`) are never used.
- **Migrations are only recorded.** `TenantMigrationRunner` (`core/src/tenancy/migrations/index.ts`) records which of the four migrations (`0001`–`0004`, each with `upSql` and `downSql`) are applied, but runs no SQL.
- **The host app uses the JSON store.**
  - Apart from file contents, everything the host application stores goes through the transitional JSON store (`src/server/store.ts`). That includes document generation and document store metadata.
  - `getStore()` (`:711`) and `saveStore()` (`:1224`) are **synchronous**, and so is most of `src/server/services.ts` (over 12,000 lines) built on them.
- **The repository pattern exists but isn't used at runtime.**
  - The tenant repositories (`TenantKeyDateRepository`, `TenantDocumentRepository`, `TenantDocumentStoreRepository`) already take a `TenantContext` first and check the tenant on every row.
  - Only tests use them.
- **The repository name exists only in a document.** ADR 0001 names a `TenantScopedRepository`, but no such class exists.

## Decision

### 1. Server, databases and encryption
- **Azure Database for PostgreSQL Flexible Server.**
  - In the hosted model, there is one shared server per environment.
  - In Model A, there is one server per firm.
- **Each tenant gets its own database,** named `pg_tenant_<slug>_<environment>`, as `resolveTenantPostgresConfig` already does.
- **Access:**
  - The server uses private access in a delegated subnet (ADR 0024) and enforces TLS.
  - Sign-in uses Microsoft Entra ID with the app's managed identity. There are no database passwords.
- **Encryption keys (standard 8, item 5).** Flexible Server encrypts a whole server with one key, so databases on the same server share it. Therefore:
  - **The shared hosted server uses a platform-managed key.** Tenants on it share that key. This is a **recorded exception** to item 5, accepted by the owner on 9 November 2026. Isolation for those tenants rests on a separate database per tenant (item 3) and the access controls in point 2.
  - **Any tenant that needs its own key, or a customer-managed key, gets a dedicated server.** That server's key is held in the tenant's own Key Vault. The tenant's configuration says which server it uses, and the tenant-scoped data layer connects to it the same way.
  - **Model A servers** are each the firm's own, so the key is the firm's.
  - The exception is reviewed before the first hosted client goes live.

### 2. Data access
- **Driver:** the `pg` driver, with one connection pool per tenant database.
- **Pools:**
  - Each pool is created lazily and capped, with a default of 5 connections per tenant for each replica.
  - Idle pools are closed after a timeout.
  - Connections go through the server's built-in PgBouncer, so the total stays within the server's connection limit (about 50 on Burstable B1ms) as tenants and replicas grow.
- **Core base class:** `TenantScopedRepository` resolves the pool only from `TenantContext` (`tenantId`, `postgresDatabaseName`, and the server when the tenant has a dedicated one).
- **Per call:**
  - Every method takes the context first.
  - Every row is checked against the tenant, following the pattern in `TenantKeyDateRepository` (`getDb(ctx)`, `assertRowTenant`).
  - Every table keeps a `tenant_id` column as a second check.
- **No code outside `core/src/tenancy/` opens a database connection.**
- **Trust boundary:**
  - The single managed identity can connect to every database on the shared server. Isolation therefore depends on the data layer choosing the database only from `TenantContext`, which comes only from the token (rule 4).
  - **Defence in depth:**
    - Each tenant database has its own Postgres role, granted `CONNECT` on that database only.
    - The data layer runs `SET ROLE` to the tenant's role on every connection it takes from a pool.
    - A connection pointed at the wrong database therefore fails, rather than reading another tenant's data.
- **Table design:**
  - Core fields are normalised columns.
  - Data shaped by configuration (custom field values, configurable lists, configuration snapshots) goes in `jsonb` columns, validated by the same schemas as today.
  - Each slice follows this rule and doesn't decide again.

### 3. The services layer becomes asynchronous
- `pg` is asynchronous. As each module moves, the services, server actions, routes and tests that touch it change from synchronous to `async`.
- This is expected, and it is the largest cost of the move.
- **Each cut-over slice:**
  - converts only the services for its own modules
  - keeps the public action signatures, which are already `async`
  - doesn't reformat unrelated code
- **Re-estimating:** S0-16 and S0-17 are re-estimated after S0-15 (stage plan, section 7), and split if needed.

### 4. Migrations
- **Running them:**
  - `TenantMigrationRunner` runs each migration's `upSql` and `downSql` in a transaction for each tenant.
  - It records the version, name and checksum in a `schema_migrations` table in that tenant's database.
- **Format:** migrations stay expand-then-contract, so they can be rolled back, and keep the dependency checks they already have.
- **When they run:**
  - **New tenants** are migrated when they are provisioned.
  - **New releases:** migrations run as a Container Apps job (`migrate`, ADR 0030), before the new revision takes traffic.
    - They are never run when the web app starts, because several replicas would race.
    - Each tenant migrates inside a Postgres advisory lock.
    - If a tenant fails, its rollout stops, the failure is reported, and the other tenants carry on.
    - A revision doesn't take traffic for a tenant until that tenant's database is at the version the revision needs.

### 5. Cut-over
- **One-off imports, no dual-writing.**
  - Modules move one at a time. Each move is a one-off import from the JSON store.
  - There is no dual-writing, because there is no live client data yet.
- **Audit log and key dates move first, together (S0-15).**
  - Every later module then writes its audit entries in the same database transaction as its own data.
- **Operations that span modules move together.**
  - An operation that writes to more than one module must not be split across the two stores.
  - Each cut-over slice moves together the modules that one operation writes, or adds compensation for the operation when it fails.
  - **Known operations:**
    - merging people and organisations, which repoints matters, parties, tasks and documents
    - converting an enquiry or quote into a matter
    - opening a matter, with sign-offs and tasks
    - recording a leaver, with tasks and HR
  - Each slice plan lists the operations it affects and how they are handled.
- **Rolling back during cut-over.**
  - Reverting a cut-over slice loses anything written to the moved modules since the import, for example on the demo tenant.
  - This is acceptable while there is no client data. After a revert, the import is run again from the JSON store.
- **After S0-17:**
  - The JSON store is used only to seed dev and demo tenants.
  - ADR 0001 is superseded (S0-20).

### 6. Concurrency
- Matter updates use optimistic concurrency, as the ADR 0001 amendment requires. A `row_version` column is checked on every update.
- Matter numbers come from a per-tenant sequence, which fixes B6.

### 7. Backup and restore for one tenant (standard 8, item 9)
- **Backups:** the server's automatic backups and point-in-time restore cover every database on it.
- **Restoring one tenant without touching others:**
  1. Restore the server to the chosen time, as a new temporary server.
  2. Dump that tenant's database from the temporary server.
  3. Restore the dump into a new database on the live server, then swap it in for the tenant.
  4. Delete the temporary server.
- **Tenants with their own server** restore that server directly.
- **Runbook and testing:** S0-14 adds the runbook, `docs/runbooks/tenant-database-restore.md`. The procedure is tested at least once a quarter, and each test is recorded.

### 8. Testing
- **Local development** uses a Docker Postgres, or a local one.
- **CI** runs a Postgres service container. Unit tests and the two-tenant isolation tests run against real, separate databases, including tampered record IDs and forged tenant claims.
- **The in-memory simulation is deleted.** `PostgresTenantCluster` and the in-memory stores inside the repositories are removed when the real driver lands (S0-14). That leaves one implementation, so there is no simulation for tests to drift from.

## Alternatives Considered

- **A shared database with row-level security.** The standard allows this only for low-sensitivity data, and only when the database enforces it. Rejected for client data.
- **A server for every tenant.** This gives each tenant its own key without an exception, but costs one server per tenant. Rejected as the default, and offered to tenants that ask (point 1).
- **Application-level encryption of sensitive columns with a key per tenant.** This gives each tenant its own key on a shared server, but breaks searching and indexing on those columns and adds key handling everywhere. Rejected for now. It can be revisited if the exception in point 1 isn't accepted for a client.
- **Azure SQL with elastic pools.** A viable option, but the existing migrations and tooling are written for PostgreSQL. Rejected to avoid a rewrite.
- **Cosmos DB.** It doesn't suit the relational matter, party and conflict data. Rejected.
- **Keeping the in-memory simulation for fast unit tests.** Two implementations would drift apart unless the same contract tests ran against both. Rejected in favour of running tests against the CI Postgres.

## Consequences

- **Infrastructure (S0-13):** must provide:
  - the server
  - the delegated subnet
  - the private DNS zone
  - the `migrate` job
  - optional dedicated servers, as a parameter of the tenant module
- **S0-14 adds:**
  - the `pg` driver
  - `TenantScopedRepository`, with roles per tenant and `SET ROLE`
  - the migration job
  - the restore runbook
  - the CI Postgres service
  - removal of the in-memory simulation
  - updates to the setup guide and `.env.example`
- **S0-15 moves the audit log as well as key dates.**
- **Each cut-over slice:**
  - converts its services to `async`
  - lists the operations it affects that span modules
  - includes the one-off import and two-tenant tests
- **Exception to standard 8, item 5:**
  - The shared key on the hosted server is recorded here.
  - It must be stated to hosted clients.
  - It is reviewed before the first hosted client goes live.
- **Running locally:** needs Docker, or a local Postgres.
- **Cost:**
  - One Flexible Server per environment, shared by that environment's tenants. Burstable tiers are enough for dev and test.
  - Dedicated servers cost extra and are charged to the tenant (cost tags, standard 13).
