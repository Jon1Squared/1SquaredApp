# ADR 0028: Tenant Databases and Repositories

- **Date:** 2026-11-06
- **Status:** Proposed
- **Roadmap:** Stage 0 decision D3, slices S0-14 to S0-17 and S0-20 (`docs/roadmap/stage-0-plan.md`); backlog gaps P2 and P8
- **Builds on:** [ADR 0001](./0001-shared-repo-and-transitional-store.md) (transitional store), [ADR 0024](./0024-azure-container-apps-hosting.md) (hosting)

## Context

Section 8 of the standard requires a database per tenant, with isolation enforced by the database rather than by application filters alone. At commit `a0a5534`, none of this is real yet:

- **No real database.** `PostgresTenantCluster` (`core/src/tenancy/index.ts:148-212`) is an in-memory map keyed by database name. No Postgres driver is installed, and the connection settings from `resolveTenantPostgresConfig` (lines 124-140) are never used.
- **Migrations are only recorded.** `TenantMigrationRunner` (`core/src/tenancy/migrations/index.ts`) records which of the four migrations (`0001`–`0004`, each with `upSql` and `downSql`) are applied, but runs no SQL.
- **The host app uses the JSON store.** Apart from file contents, everything the host application stores goes through the transitional JSON store (`src/server/store.ts`). That includes document generation and document store metadata.
- **The repository pattern exists but isn't used at runtime.** The tenant repositories (`TenantKeyDateRepository`, `TenantDocumentRepository`, `TenantDocumentStoreRepository`) already take a `TenantContext` first and check the tenant on every row. Only tests use `TenantKeyDateRepository`.
- **The repository name exists only in a document.** ADR 0001 names a `TenantScopedRepository`, but no such class exists.

## Decision

1. **Azure Database for PostgreSQL Flexible Server.** One server per environment in the hosted model, and one per firm in Model A.
   - Each tenant gets its own database, named `pg_tenant_<slug>_<environment>` as `resolveTenantPostgresConfig` already does.
   - The server uses private access in a delegated subnet (ADR 0024) and enforces TLS.
   - Sign-in uses Microsoft Entra ID with the app's managed identity. There are no database passwords.
2. **Data access.**
   - Use the `pg` driver, with one connection pool per tenant database, created lazily and capped in size.
   - A core `TenantScopedRepository` base class resolves the pool only from `TenantContext` (`tenantId`, `postgresDatabaseName`).
   - Every method takes the context first, and every row is checked against the tenant, following the pattern in `TenantKeyDateRepository` (`getDb(ctx)`, `assertRowTenant`).
   - No code outside `core/src/tenancy/` opens a database connection.
3. **Migrations.** `TenantMigrationRunner` runs each migration's `upSql` and `downSql` in a transaction for each tenant.
   - It records the version, name and checksum in a `schema_migrations` table in that tenant's database.
   - Migrations stay expand-then-contract and reversible, with the dependency checks they already have.
   - New tenants are migrated when they are provisioned.
4. **Cut-over.** Modules move one at a time, starting with key dates (S0-15). Each move is a one-off import from the JSON store. There is no dual-writing, because there is no live client data yet.
   - After S0-17, the JSON store is used only to seed dev and demo tenants, and ADR 0001 is superseded (S0-20).
5. **Concurrency.** Matter updates use optimistic concurrency, via a `row_version` column checked on update, as the ADR 0001 amendment requires. Matter numbers come from a per-tenant sequence, which fixes B6.
6. **Testing.** Local development uses a Docker Postgres. CI runs a Postgres service container, so the two-tenant isolation tests run against real, separate databases, including tampered record IDs and forged tenant claims.

## Alternatives Considered

- **A shared database with row-level security.** The standard allows this only for low-sensitivity data, and only when the database enforces it. Rejected for client data.
- **Azure SQL with elastic pools.** A viable option, but the existing migrations and tooling are written for PostgreSQL. Rejected to avoid a rewrite.
- **Cosmos DB.** It doesn't suit the relational matter, party and conflict data. Rejected.

## Consequences

- Infrastructure (S0-13) must provide the server, the delegated subnet and the private DNS zone.
- Running locally needs Docker, or a local Postgres. The setup guide and `.env.example` are updated in S0-14.
- Each tenant can be backed up and restored independently (standard 8.9) by restoring its own database.
- Cost: one Flexible Server per environment, shared by that environment's tenants. Burstable tiers are enough for dev and test.
