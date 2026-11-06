# ADR 0026: A Separate Demo Tenant Instead of Demo Branches in Product Code

- **Date:** 2026-11-06
- **Status:** Accepted
- **Roadmap:** Stage 0 decision D5, slices S0-11a and S0-11b (`docs/roadmap/stage-0-plan.md`); backlog gap P6

## Context

Product components decide what to show by checking whether demo data is present: for example `hasDemoSeedData` in `src/components/HomeClient.tsx` and `isSeededDemoMatter` in `src/components/MatterProfileClient.tsx`. About 20 Home panels, several headline figures and some matter, person and organisation sections show hard-coded content. That content includes a fabricated "Sanctions & PEP: Clear" status. A demo firm name is also hard-coded in search.

As a result, a real firm could be shown invented compliance statuses.

Sales demos still need a convincing, fully populated system.

## Decision

1. **Product code never checks whether demo data is present,** and never contains demo figures, names or statuses. A feature that isn't built shows an honest empty state or is hidden by configuration.
2. **Demos run in a demo tenant.** It is loaded from seed data (`src/seed/`, `data/seed-*.json`) by a seed command, not by product code. Seed data uses invented fixtures only, as checked by `scripts/verify-invented-fixtures.mjs`.
3. **The demo tenant is never live.** It runs with an `environment` other than `live`, so `featureFlags.enableDemoMode` (the persona switcher) remains valid there and is still rejected in `live`. It sends email only to its recipient allow-list ([ADR 0027](./0027-email-sender-interface.md)).
4. **Until the store migration (slice S0-17), the demo tenant is a separate deployment.** The transitional store ([ADR 0001](./0001-shared-repo-and-transitional-store.md)) is one file per process, and a deployment loads one tenant package (`PLATFORM_TENANT_PACKAGE_DIR`). After S0-17, the demo tenant becomes an ordinary tenant with its own database in the shared non-live deployment.
5. **The demo uses the existing invented tenant package `client-not-a-law-firm`,** with a demo environment overlay. A second invented package can be added later if test data and demo data need to differ.
6. **A CI check fails on known demo literals** in `src/components/` and `src/domain/`, such as the demo firm name and fixed compliance statuses.

## Alternatives Considered

- **Keep a demo-mode flag inside product components.** This is the cheapest option. Rejected: invented statuses could reach a real firm through a configuration mistake.
- **A separate demo build.** Rejected: it breaks the "one build artefact" rule (standard section 7).

## Consequences

- Home and profile screens look emptier on a new tenant until stages 1 to 5 build the real features behind them. This is accepted.
- Demo quality depends on the seed data, which has to be maintained alongside the schema.
- Slice S0-11 is split in two. S0-11a removes the demo branches from product code. S0-11b builds the seed command and the demo deployment.
