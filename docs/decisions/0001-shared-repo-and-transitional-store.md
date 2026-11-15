# ADR-0001: Early-Stage Shared Repository Structure and Transitional Local Store

- **Date:** 2026-10-31
- **Status:** Superseded by ADR 0028 (runtime persistence) and ADR 0026 (demo seeding)

> **Supersession note (Slice S0-20, November 2026):** The transitional local JSON store (`src/server/store.ts`, `data/runtime-store.json`), SQLite PMS demo database (`data/pms/pms-demo.sqlite`, `DemoDbPmsSource`), and Firestore sync (`firebase-admin`) have been retired. All runtime state and background jobs run exclusively against per-tenant PostgreSQL databases (`core/src/tenancy/`, [ADR 0028](./0028-tenant-database-and-repositories.md)), and pure seed-generation helpers live in `src/seed/seedStoreBuilder.ts` for non-live demo seeding and resets ([ADR 0026](./0026-demo-tenant.md)). The shared repository structure (`core/`, `client-not-a-law-firm/`, `src/`, `docs/`) and invented fixture names (`Not A Law Firm LLP` / `Pembroke Vaughan`) remain in effect under `docs/architecture-standard.md` §4.

## Context

`c:\1Squared\App` hosts the 1Squared Next.js web application (`onesquared`) alongside the platform architecture defined in `docs/architecture-standard.md`.

During active product development:
1. Section 4 of `docs/architecture-standard.md` notes: *"A shared repository with strict folder ownership is acceptable in the early stage, but it must be split before any client is given direct access."*
2. The platform core (`core/`), schema-validated tenant configuration and extensions (`client-not-a-law-firm/`), and Next.js application (`src/`) live within this repository.
3. While `core/src/tenancy/` provides the canonical OIDC-verified, database-per-tenant isolation layer (`PostgresTenantCluster` and `TenantScopedRepository`), interactive UI and domain prototyping in `src/` currently persists local demo state through `src/server/store.ts` (initialised from the tracked seed snapshot `data/seed-not-a-law-firm.json` and written at runtime only to the git-ignored `data/runtime-store.json`) seeded with invented test fixtures in `src/seed/demo.ts` (`Not A Law Firm LLP` / `Pembroke Vaughan`).

## Decision

1. **Repository Layout:** Maintain `core/`, `client-not-a-law-firm/`, `docs/`, and the Next.js host (`src/`) in the root of this repository with strict folder and import boundaries:
   - `core/` contains zero client names, IDs, or client-specific branches.
   - Extensions in `client-not-a-law-firm/extensions/` import only from `@platform/core-api` (`core/src/api/index.ts`).
   - `src/platform/tenantRuntime.ts` bridges the Next.js host to `@platform/core`, tenant configuration, and registered extensions.
2. **Invented Fixture Names:** `Not A Law Firm LLP` (`notalawfirm.example`) and `Pembroke Vaughan` are invented fixture names used for testing, demonstration, and contract verification. They are not real client data.
3. **Transitional Store Coexistence:** Feature development in the Next.js application (`src/app/`, `src/components/`, `src/domain/`, `src/server/store.ts`, `src/server/services.ts`) may continue to read and write through `src/server/store.ts` while domain modules are progressively migrated to `core/src/tenancy/`, provided that:
   - All new features in `src/` remain configuration-driven (Layer 1/2) rather than hardcoding firm-specific rules.
   - Any change to `core/src/tenancy/` or multi-tenant data access is covered by two-tenant isolation tests in `core/tests/`.
   - **Amendment (pending approval, 4 November 2026):** Asynchronous matter saves (`saveMatterRecord`) check for concurrent updates (`updatedAt`) after awaiting extension hooks and never roll back monotonic ID counters on a hook veto; when cutting over to per-tenant PostgreSQL in hosted/single-tenant deployments, matter updates must enforce optimistic concurrency (row versioning / `updated_at` check) or `SELECT ... FOR UPDATE`.

## Alternatives Considered

- **Immediate multi-repo split and blocking all `src/server/store.ts` edits:** Rejected for the current phase because splitting repositories and prohibiting local JSON store updates before all UI workflows are finalised would halt day-to-day application feature development.

## Consequences

- Developers and AI coding agents can follow `AGENTS.md` and `docs/architecture-standard.md` strictly without false-positive halts when working on Next.js UI, domain logic, or `src/server/store.ts`.
- All core platform tenancy, configuration schema validation, and extension sandboxing rules remain enforced and tested in CI via `core/tests/`.
