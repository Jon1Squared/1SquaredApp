import type { DocArticle } from '../registry';

export const developmentProcessArticle: DocArticle = {
  slug: 'development-process',
  title: 'Engineering process, quality assurance & release governance',
  section: 'architecture-security',
  summary:
    'How 1Squared designs, tests, audits (including independent Claude Code verification on develop), and releases software safely across isolated branches and deployment rings.',
  updated: '2026-11-06',
  body: `
For a law firm, a software update cannot be a leap of faith. 1Squared is engineered around a **Zero-Trust, Architecture-First Software Development Lifecycle (SDLC)** where every change passes through **six independent quality and security gates** before reaching live production.

> **Core governance principle**: No engineer or AI tool can commit directly to \`develop\` or \`main\` (live), and the system that writes code never approves its own work unchallenged. Every release undergoes automated two-tenant isolation testing and an independent **Claude Code** architecture and security audit on \`develop\` before promotion to live.

## 1. The six quality gates from idea to live production

\`\`\`
[Gate 1: ADR & Classification]
       ↓
[Gate 2: Isolated Feature Branch (feat/*) + Synthetic Data Only]
       ↓
[Gate 3: GitHub Actions Platform CI + Two-Tenant Isolation Suite]
       ↓
[Gate 4: Staging Integration on develop]
       ↓
[Gate 5: Independent Claude Code Senior Developer & Security Audit]
       ↓
[Gate 6: Expand-Then-Contract Migration & Ring-Based Release to main]
\`\`\`

## 2. Step-by-step engineering lifecycle

### Gate 1: Architecture-first design & change classification
Before a single line of production code is written, every change is classified under the Platform Architecture Standard and any structural feature requires a formal **Architecture Decision Record (ADR)** in \`docs/decisions/\`:

| Change Class | Mandatory Engineering Requirements |
| --- | --- |
| **Core Feature** | Formal ADR, two-tenant isolation tests, reversible migration plan, user & admin documentation |
| **Core Extension Point** | Versioned API contract in \`@platform/core/api\`, contract tests, backward-compatibility guarantee |
| **Configuration Option** | JSON Schema entry in \`tenant-config.schema.json\`, safe default value, runtime validation |
| **Client Extension** | Isolated in the firm’s private repository (\`client-<firm>/\`), manifest permission review, sandbox timeout tests |
| **Client Configuration** | Validated against the tenant JSON Schema before deployment |
| **Infrastructure** | Declarative Bicep (\`core/infra/\`) only, with cost and security review |

### Gate 2: Isolated feature branches & 100% synthetic test data
- **Branch Isolation**: All development takes place on isolated branches (\`feat/*\`, \`fix/*\` and \`chore/*\`), with roadmap slices on \`s0-NN-short-name\` branches as set out in \`docs/roadmap/stage-0-plan.md\`. Each slice is one Pull Request to \`develop\` and updates the backlog (\`docs/roadmap/feature-list.md\`) in the same Pull Request. Direct pushes to \`develop\` or \`main\` are blocked.
- **11 Immutable Architecture Rules**: Enforced via \`AGENTS.md\` and \`CLAUDE.md\`—prohibiting client-specific code in the core, requiring all data access to use a token-derived \`TenantContext\`, banning secrets in code or config, and requiring every change to create or update the relevant pages in **Help & documentation** in the same Pull Request (Rule 11).
- **Zero Real Client Data in Dev/Test**: Engineers never develop or test with real client PII. All development uses purpose-built synthetic law firm fixtures (*Not A Law Firm LLP* and *Pembroke Vaughan*) confined to \`data/\` and \`src/seed/\`. In Platform CI, \`scripts/verify-invented-fixtures.mjs\` verifies that seed fixtures use only RFC 2606 domains and Ofcom drama telephone numbers, while \`scripts/verify-no-demo-literals.mjs\` scans git-tracked product code under \`src/components/\` and \`src/domain/\` to ensure no demo firm names, seed person/organisation names, matter numbers, record IDs, or fake \`"Sanctions & PEP: Clear"\` statuses appear in product code.

### Gate 3: Automated Platform CI & adversarial two-tenant isolation tests
Every push and Pull Request triggers the automated **Platform CI** workflow (\`.github/workflows/ci.yml\`):
1. **Strict TypeScript Verification (\`tsc --noEmit\`)**: Ensures end-to-end type safety across core, schemas, extensions, and UI.
2. **Unit & Contract Suite**: Verifies domain rules, RBAC permissions, conflict checks, and JSON Schema contracts.
3. **Adversarial Two-Tenant Isolation Suite**: Automatically provisions two separate firms (*Tenant A* and *Tenant B*) and attempts cross-tenant record reads, updates, deletes, and forged \`tenantId\` claim injection. Any boundary failure immediately blocks the Pull Request.
4. **Clean Production Build (\`npm run build\`)**: Verifies the immutable production build succeeds.
5. **Browser Role Journey Smoke Tests (\`npm run e2e\`)**: Runs Playwright browser tests against a production \`next start\` server across the eight seeded roles.

### End-to-end tests
Browser-level role journey smoke tests live in \`e2e/\` and are configured in \`playwright.config.ts\` (\`npm run e2e\`). Before each run, \`e2e/global-setup.ts\` restores \`data/seed-not-a-law-firm.json\` into the runtime store and mints HMAC-SHA256 signed \`onesquared_entra_session\` cookies in test code only (never via a sign-in bypass in product code).

The suite covers the eight roles with seeded holders in *Not A Law Firm LLP*:
- **Fee earner** (\`P-000002\` — Dafydd Evans)
- **Partner** (\`P-000001\` — Rhian Morgan)
- **Legal secretary** (\`P-000010\` — Nia Edwards)
- **Enquiries coordinator** (\`P-000042\` — Lowri Ellis)
- **Finance** (\`P-000009\` — Gethin Powell)
- **Risk and compliance** (\`P-000003\` — Bethan Rees)
- **Managing partner** (\`P-000038\` — Gethin Lloyd)
- **Admin** (\`P-000004\` — Huw Pritchard, tested both with \`mfaVerified: true\` and \`mfaVerified: false\`)

*(Note: \`supervisor\` and \`intake\` have no dedicated seeded holder in \`data/seed-not-a-law-firm.json\` and are covered by the unit RBAC suite.)*

Each role journey verifies four things:
1. Home loads without runtime errors and displays the expected active Home role.
2. The left navigation rail matches \`getLeftRailVisibility\` for that role.
3. One primary end-to-end journey for that role succeeds (such as opening a matter workspace, saving a draft enquiry, or opening the Finance, Risk, or Admin workspaces).
4. An unauthorised page or navigation item is hidden or refused (including \`/admin\` redirecting away when \`admin:access\` or \`mfaVerified\` is missing).

### Gate 4 & Gate 5: Staging on \`develop\` & independent Claude Code audit
To eliminate single-perspective blind spots, 1Squared enforces an adversarial **Builder vs. Auditor** model combining distinct AI systems with human principal oversight:

- **Automated Pull Request Review (\`claude-review.yml\`)**: Every Pull Request is automatically inspected against the 10 Architecture Rules.
- **Pre-Release \`develop\` Audit with Claude Code**: Once features are integrated into the \`develop\` staging branch—and before they are ever pushed to \`main\` (live)—**Claude Code** is run as an independent Senior Developer and Principal Architecture Reviewer across the \`develop\` branch to verify:
  - Zero client-specific identifiers, branches, or credentials exist in the core.
  - Every API route, database query, cache key, and background job enforces \`TenantContext\` from the verified token only.
  - Both [deployment models](/docs/deployment-and-security) (Model B Hosted Cloud and Model A Client Self-Hosted Azure) work identically.
  - Edge cases, error handling, and permission boundaries are thoroughly covered by tests.

### Gate 6: Reversible migrations & ring-based production rollout
- **Expand-Then-Contract Migrations**: Database migrations (\`core/src/tenancy/migrations/\`) are tracked per tenant, strictly additive/backward-compatible, and paired with tested \`down\` rollback scripts.
- **Controlled Deployment Rings**:
  - **Ring 0**: 1Squared internal validation tenant.
  - **Ring 1**: Pilot / Training environment built from semantic release tags (\`vX.Y.Z\`).
  - **Ring 2**: Live production rollout across hosted tenants (and signed container + Bicep release for self-hosted firms).

## 3. Client presentation blueprint (6 slides)

When presenting 1Squared’s development and release governance to a law firm’s Risk Committee, CIO, or Managing Partner:

1. **Slide 1 — Built for Legal-Grade Reliability**: Overview of the 6 mandatory quality gates from ADR design to ring-based live release.
2. **Slide 2 — Architecture-First Design**: How ADRs, the 10 Architecture Rules, and 100% synthetic test fixtures protect confidentiality from day one.
3. **Slide 3 — Automated Two-Tenant Security Testing**: How every commit must pass adversarial cross-tenant tampering and forged-claim tests in GitHub Actions.
4. **Slide 4 — Independent Multi-Model AI Audit ("Builder vs. Auditor")**: How **Claude Code** independently audits the \`develop\` branch against our architecture and security standards before any release is promoted to live.
5. **Slide 5 — Zero-Downtime Upgrades & Rollback Safety**: Expand-then-contract database migrations, schema-validated customisations, and ring rollouts.
6. **Slide 6 — Governance Summary Checklist**: Due-diligence matrix covering branch protection, ADRs, isolation gates, independent Claude Code review, synthetic data privacy, and reversible releases.
`,
};
