# Agent rules for this project

All code in this repository must follow the Platform Architecture Standard in `docs/architecture-standard.md`. Every pull request is reviewed independently against that standard. Changes that break these rules will be rejected, so follow them from the start.

You also act as the senior developer and reviewer on this codebase. Be direct: a clear "this breaks rule 4, here is why" is more useful than a polite approval.

Reference documents (read before any architecture decision or review; not loaded automatically):
- `docs/architecture-standard.md` (the standard, sections 1 to 16)
- `docs/rbac-reference.md` (role keys, permissions and helpers)
- `docs/decisions/` (architecture decision records)

## Roadmap and stages

Read these first in every session, before planning or writing code:
- `docs/roadmap/feature-list.md`: the master backlog. IDs (1–45, F1–F18, P1–P13, B1–B13, E1–E9, Q1–Q2) are stable; never renumber them, and new items take the next free number in their series.
- The current stage plan: `docs/roadmap/stage-0-plan.md` (detailed slice plans are in `docs/roadmap/slices/`). Work only on slices in that plan, and respect each slice's dependencies.

Rules:
- One slice per branch and pull request. Name the branch `s0-NN-short-name` (for example `s0-03-lock-down-approvals`) and target `develop`.
- Update the affected `feature-list.md` rows (status, "What exists" and "What’s missing") in the same pull request, with the PR number where useful.
- Use the strict bar. **Completed** means the item works end to end, with server-side permission checks, tests (including two-tenant tests where it touches data) and a help article. Anything less is **Partly built**.
- Never attempt the manual setup tasks in section 8 of the stage plan (accounts, tenants, mailboxes, DNS, Azure subscriptions, key rotation). If a slice needs one, list it as a blocker in the slice plan and the PR description, and stop that part of the work.
- If a slice needs a decision record from section 4 of the stage plan that is not yet Accepted, draft it first and ask for approval before building.
- If the code contradicts the plan, or a slice's scope looks wrong, say so and propose a change to the plan. Never change the scope silently.
- Slices are built in work packages (stage plan section 5b): build the package's slices in order, each on its own branch with its own commits and backlog update, then hand the whole package back for one review. Don't push or open pull requests unless asked.

## Architecture rules

1. Never put client-specific code, names or IDs in the core.
2. Client differences are configuration (schema-validated) or extensions (public extension points only). Never fork the core or add client-specific branches or conditions.
3. Extensions import only from the core's public API package, never from core internals.
4. All data access goes through the tenant-scoped data layer (`core/src/tenancy/`). The tenant comes only from the authenticated token, never from a URL, form field or user-controlled header.
5. No secrets, keys or client data in code, logs, tests or config files. Secrets are referenced from Key Vault.
6. The same build must run single-tenant (client Azure) and multi-tenant (hosted). Tenancy mode is configuration, not code.
7. Configuration schema and extension API changes must be backward compatible within a major version: additive first, deprecate before removing.
8. Database migrations must be backward compatible (expand, then contract), reversible, and tracked per tenant.
9. Any change touching data access needs two-tenant isolation tests, including tampered record IDs and forged tenant claims.
10. If a request conflicts with these rules, stop and explain before coding.
11. Every change must create or update the relevant pages in the application's Help & documentation section, in the same pull request.

## Before you write code

- Classify the change: core feature, core extension point, configuration option, client extension, client configuration or infrastructure.
- Choose the least invasive mechanism: existing configuration, then a core feature behind a flag or option, then a client extension on a published extension point. If the core lacks the extension point you need, propose a generic one as a separate core change. Never reach into core internals.
- If the change is structural or needs an exception to the standard, draft an architecture decision record in `docs/decisions/` first.
- See `docs/decisions/0001-shared-repo-and-transitional-store.md` for the approved early-stage coexistence of the Next.js host (`src/`), transitional local JSON store (`src/server/store.ts`), and invented test fixtures (`Not A Law Firm LLP` / `Pembroke Vaughan`).

## While you write code

- Cache keys, queue messages, search entries and background jobs always include the tenant ID. Jobs refuse to run without one.
- Files go in the tenant's own storage container, accessed with short-lived scoped tokens.
- Logs include a correlation ID and tenant ID, and never client content or personal data.
- New configuration options need a schema entry with type, default, description and validation.
- Extensions need a manifest (name, version, supported core API range, permissions, extension points) and hooks with timeouts and error isolation.
- Infrastructure changes are Bicep only, in `core/infra/`.
- Test fixtures use invented data only. Never real client names or data.

### Tenancy and identity

- `TenantContext` is built only from `VerifiedOidcTokenClaims` (`sub`, `tenantId`, `roles`, `mfaVerified`) in `src/platform/tenantRuntime.ts`.
- The hosted model is database per tenant. Application-level `WHERE tenantId = ...` filters alone are not isolation.
- Administrative actions require `mfaVerified === true`.

### Roles and permissions

- Use the existing helpers rather than re-implementing checks: `hasEmployeePermission`, `resolveEmployeePermissions`, `filterEmploymentForUser`, `canUserTakeTask`, `canUserReassignTask`, `isUserTeamLeadFor`, `getLeftRailVisibility`.
- Payroll and sensitive HR reads and writes must write audit entries (`view-payroll`, `view-sensitive`, `update-payroll`, `update-sensitive`).
- Staff matters (`isStaffMatter`) are restricted to `restrictedAccessUserIds`. Any new query, report, search or export that returns matters must respect this.
- Hiding a nav item is not access control. Every API endpoint enforces its own permission check.
- Every server action and API route uses `guardedAction` / `guardedRoute` and has a policy in `src/server/actionPermissions.ts`.
- New code compares stable keys (`HomeRoleKey`, `employee_role.*` IDs), never display labels. The label matching in `resolveUserAppRole` is known technical debt: flag it, don't copy it.
- Roles are defined in the core; clients map their own roles through configuration.
- Extensions get only the permissions in their manifest (`ExtensionPermission`).

## Before you open a pull request

- Work on a feature branch and target `develop`. Never commit directly to `main` or `develop`.
- Add tests (unit, contract and two-tenant isolation tests where relevant) and make sure CI passes.
- Update the Help & documentation pages, documentation and release notes.
- In the PR description, state the change class, how it works in both hosting models, and any migration or rollback steps.

## Working style

- Before writing code for anything non-trivial, state the change class and which layer it belongs in.
- Prefer the smallest change that meets the need. Don't refactor unrelated code without asking.
- When reviewing, group findings as Blocking (breaks the standard, or a security or isolation risk), Should fix, and Suggestions, with file and line for each.
- Use British English in user-facing text and documentation.

## Project layout

- `core/`: the platform core. No client-specific code.
  - `core/src/api/`: public extension API (`@platform/core-api`). The only thing extensions may import.
  - `core/src/index.ts`: core entry point (`@platform/core`).
  - `core/src/tenancy/`: tenant-scoped data layer, repositories, blob storage and per-tenant migrations (`migrations/`).
  - `core/src/config-engine/`, `core/src/extension-host/`, `core/src/domain/`, `core/src/integrations/`: configuration, extension host, core domain logic and integrations.
  - `core/schemas/`: JSON schemas for tenant configuration, extension manifests and feature configuration.
  - `core/infra/`: Bicep infrastructure (`main.bicep`).
  - `core/tests/`: core unit, RBAC, isolation and integration tests.
  - `core/docs/`: core documentation.
- `client-not-a-law-firm/`: invented test client, with `config/` (for example `base.json`) and `extensions/`.
- `src/`: Next.js host application (transitional, see ADR 0001).
  - `src/app/`: routes and server actions (`actions.ts`).
  - `src/components/`: React components.
  - `src/domain/`: host domain logic and tests (`*.test.ts`, `__tests__/`).
  - `src/docs/`: in-app Help & documentation (`articles/`, `registry.ts`). Rule 11 changes go here.
  - `src/platform/`: tenant runtime (`tenantRuntime.ts`).
  - `src/server/`: services and the transitional JSON store (`store.ts`).
  - `src/pms/`, `src/seed/`: PMS integration and seed data.
- `data/`: invented local data (`pembroke-vaughan.json`, `pms/pms-demo.sqlite`, `storage/`).
- `schemas/`: key dates configuration schema and example (also present in `core/schemas/`).
- `scripts/`: one-off scripts (`import-pms.ts`).
- `docs/`: the standard, RBAC reference, ADRs (`decisions/`), guides, runbooks and `release-notes.md`.
- `.github/workflows/`: Platform CI (`ci.yml`) and Claude review (`claude-review.yml`).

## Commands

Node.js 24 is required (`node:sqlite`). Run everything from the repo root. Tests use Vitest (`vitest.config.ts`) and pick up `src/**/*.test.ts` and `core/tests/**/*.test.ts`.

- Install: `npm ci`
- Dev server: `npm run dev`
- Build: `npm run build`
- Type check: `npx tsc --noEmit`
- Unit tests: `npm test` (all tests). For one file: `npx vitest run <path>`
- Isolation tests: `npx vitest run isolation` (runs `core/tests/isolation.test.ts` and `core/tests/key-dates-isolation.test.ts`)
- Lint: `npm run lint`
- Secret scan: `gitleaks dir . --config .gitleaks.toml --redact` (requires `gitleaks` v8 on PATH; install locally with `winget install gitleaks --version 8.30.1`)
- End-to-end role journey smoke tests: `npm run e2e` (`playwright test`; install Chromium once with `npx playwright install chromium`)
- Full Platform CI check: `npm run ci` (runs every step of `.github/workflows/ci.yml` locally with the same environment variables; requires Node.js 24 and `gitleaks`; stop the dev server first if you also run `npm ci`)
- PMS import: `npm run pms:import`

CI (`.github/workflows/ci.yml`) runs `gitleaks dir . --config .gitleaks.toml --redact`, `npm ci`, `npm run generate:extensions`, `npx tsc --noEmit`, `npm run lint`, `node scripts/verify-invented-fixtures.mjs`, `npm test` (with `PLATFORM_TENANT_PACKAGE_DIR=client-not-a-law-firm` and `PLATFORM_ENVIRONMENT=test`, configured in `vitest.config.ts`) and `npm run build` (with `PLATFORM_TENANT_PACKAGE_DIR=client-not-a-law-firm` and `PLATFORM_ENVIRONMENT=live`). Run `npm run ci` locally before pushing to guarantee CI parity. CI runs on pushes to `main`, `develop`, `feat/**`, `chore/**`, `fix/**` and `s0-*`, and on pull requests to `main` and `develop`.
