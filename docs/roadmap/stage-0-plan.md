# Stage 0 plan: Foundations and hardening

| | |
|---|---|
| Status | Draft v3: checked against the code at `a0a5534` (no code changes since the review); ADRs 0024–0027 written for D1, D2, D5 and D9. D1, D5 and D9 confirmed by the product owner on 6 November 2026; D2 proposed. For review by Antigravity, then approval. |
| Baseline | `fix/testing-fixes`, commit `a0a5534` (6 November 2026) |
| Backlog | `docs/roadmap/feature-list.md` (IDs in this plan refer to it) |
| Standard | Platform Architecture Standard, especially sections 8, 9 and 14 |

## 1. Goal

Make what already exists safe, tenant-isolated and shared, so that stages 1 to 5 build on solid ground and no real client data is at risk.

Stage 0 adds no new user-facing features, apart from the registers engine and the search and notification improvements that later stages depend on.

## 2. Exit criteria

Stage 0 is done when every statement below is true and has been confirmed by re-running the status review.

**Safe**
- All High bugs (B1, B3, B4, B5, B7, B9, B10, B11, B12) and B8 are fixed, each with a regression test.
- No secrets in the repository or the browser bundle. The Ideal Postcodes key has been rotated, and CI secret scanning blocks new secrets (P5).
- Every server action and API route declares the permission it requires, and a guard test fails the build if one does not (P1).
- Finance data reaches only people with a finance permission, and every firm-wide roll-up excludes restricted matters (P4).
- No demo branches or fabricated statuses in product code. Demo content exists only as seed data loaded into a demo tenant (P6).
- Every tenant setting in the schema is applied at runtime or removed (P7).

**Solid**
- Every module reads and writes through a tenant-scoped repository backed by a real database per tenant. The JSON store is used only to seed dev and demo tenants, and ADR 0001 is superseded (P2).
- PMS data is tenant-scoped (P3).
- Two-tenant isolation tests cover every module (P8).
- A tenant-aware scheduler runs key date reminders and retention jobs (P9).
- The app runs on Azure Container Apps (D1). Bicep provisions the Container Apps environment, the database, Application Insights and the PDF converter (P12).
- A demo tenant, loaded from seed data, supports sales demos (D5).
- Email is sent through one `EmailSender` interface; the demo tenant sends real email from a 1Squared.co.uk mailbox, only to allowed recipients (D9).

**Shared**
- Items 28 to 32 meet the Completed bar, including tests (P10) and help (P11).
- The registers engine (31) is in the core, with sign-offs migrated onto it as its first consumer.

## 3. Scope

**In scope:** items 28 to 32; P1 to P12; bugs B1, B3, B4, B5, B7, B8, B9, B10, B11 and B12.

Stage 0 delivers everything listed under "What’s missing" for items 28 to 32, so that each meets the Completed bar. That includes the work-type behaviour (29), negotiated rates and CFA/DBA (30), and Teams delivery and digests (32). Section 5a maps every stage 0 backlog row to its slices.

**Out of scope:** new features from stages 1 to 5. B2 and B6 stay in stage 1, although B6 becomes simple once matter numbers come from a database sequence (slice S0-16). Undertakings, complaints and the other registers are built on the engine in stages 2 and 3, not here.

**Before the first hosted client (not stage 0; recorded so they aren't lost):**
- per-tenant backup and restore, tested (standard 8.9)
- offboarding process (8.10)
- per-tenant rate limits (8.12)
- per-tenant encryption keys (8.5)
- runbooks (13)
- an independent penetration test (8)

## 4. Decisions to make before building

Each of these gets a decision record in `docs/decisions/` before the slices that depend on it.

| No. | Decision | Recommendation or decision | Status | Needed before |
|---|---|---|---|---|
| D1 | Hosting platform. The standard confirms Azure Container Apps, but `main.bicep` provisions a Linux App Service. | **Container Apps**, as the standard says. Replace the App Service resources in Bicep. Use Container Apps jobs for scheduled work (D6) and a separate container app for the PDF converter. Shared platform resources and per-tenant resources become separate Bicep modules. [ADR 0024](../decisions/0024-azure-container-apps-hosting.md). | Decided | S0-13 |
| D2 | Permission enforcement pattern | One helper (for example `authorize(actor, permission, resource?)`) used by every server action and route, plus a registry mapping each action to its permission. A guard test enumerates exports and fails on any undeclared action. Start the guard with a baseline list of known gaps that can only shrink. [ADR 0025](../decisions/0025-permission-enforcement-pattern.md), building on ADR 0010. | Decided | S0-02 |
| D3 | Persistence and migration | Postgres database per tenant (already confirmed). One repository per module behind the tenant-scoped data layer. Because there is no live client data yet, cut over module by module with a one-off import from the JSON store, rather than dual-writing. Draft: [ADR 0028](../decisions/0028-tenant-database-and-repositories.md). | Proposed | S0-14 |
| D4 | Finance data delivery | Take finance out of the app snapshot. Load it on demand through gated endpoints, so it never reaches someone without permission. Draft: [ADR 0029](../decisions/0029-finance-data-delivery.md). | Proposed | S0-10 |
| D5 | Demo mode | **A separate demo tenant** loaded from seed data. Product components never check whether demo data is present. Unbuilt features show an honest empty state or are hidden. Until S0-17 the demo tenant is a separate non-live deployment. [ADR 0026](../decisions/0026-separate-demo-tenant.md). | Decided | S0-11a, S0-11b |
| D6 | Scheduler | Container Apps jobs on a timer (follows D1), running a tenant-aware job runner that iterates tenants and refuses to run a job without a tenant context, as the standard requires. Draft: [ADR 0030](../decisions/0030-tenant-aware-scheduler.md). | Proposed | S0-19 |
| D7 | Registers engine design | Register types defined as configuration (fields, states, owner, due dates, approval rules, reminder schedule). One core implementation for records, lifecycle, approvals (no self-approval, approver rules), reminders through the scheduler, and audit. Extension points for client-specific steps. Key dates stay separate for now and may move onto the engine later. | Proposed | S0-24 |
| D8 | Contact personas (Q1) | One person record, linked in different capacities; the capacity is chosen on each matter, and the conflict search follows all of them. | Proposed | S0-21 |
| D9 | Email delivery | **One `EmailSender` interface in the core, with adapters chosen per tenant in configuration** (credentials as Key Vault references): a dev catcher such as Mailpit for dev and test; Microsoft Graph sending app-only from a 1Squared.co.uk shared mailbox, restricted to that mailbox with Exchange Online RBAC for Applications, for the demo tenant and pilots; Azure Communication Services Email later for the hosted service; and Graph from the firm’s own mailbox for client-hosted installations. Non-live and demo tenants only send to an allow-list of recipients. Teams delivery later. [ADR 0027](../decisions/0027-email-sender-interface.md). | Decided | S0-26 |
| D10 | Fee arrangements model | Rates resolved in a fixed order: matter rate, then client (organisation or client group) rate, then rate card by department and grade. Each negotiated rate has effective dates and an audit trail. CFA and DBA are added as fee bases, with their terms (success fee, uplift, percentage of damages, caps) held as tenant configuration with validation, not hard-coded. Statutory caps are configured defaults, confirmed by the product owner. | Proposed | S0-28 |
| D11 | Teams delivery and digests | Digests: a scheduled job (D6) builds a per-user daily or weekly summary of unread notifications, tasks due and key dates, and sends it by email (ADR 0027), respecting each user’s preferences. Teams: activity-feed notifications through Microsoft Graph (`TeamsActivity.Send`) from a 1Squared Teams app, using the same per-tenant adapter pattern as email. Amends ADR 0027, point 5 (“Teams delivery later”). | Proposed | S0-29 |

Decision records not yet written (D3, D4, D6, D7, D8, D10 and D11) are drafted in the planning step of the slice that needs them. Each must be approved and merged, as the first commit of that slice's pull request, before the rest of the slice is built.

## 5. Phases and slices

Each slice is one pull request on its own branch named `s0-NN-short-name` (for example `s0-03-lock-down-approvals`), targeting `develop`. CI runs on `s0-*` branches from S0-01 onwards. Detailed slice plans are kept in [`slices/`](slices/). Every slice must meet the section 14 definition of done: tests (two-tenant where it touches data), help updated where users are affected, and `feature-list.md` updated in the same pull request.

Size is relative: S is up to a day, M is a few days, L is a week or more.

### Phase 0A: Make it safe

Do these first, in this order (S0-27 sits between S0-02 and S0-03). S0-01 should happen today. S0-08 and S0-11a have no dependencies and can run alongside the permission slices.

| Slice | Work | Backlog IDs | Size | Depends on |
|---|---|---|---|---|
| S0-01 | Rotate the Ideal Postcodes key; move it to Key Vault behind a server-side lookup route. Read the key only from the server-side setting `IDEAL_POSTCODES_API_KEY`: no `NEXT_PUBLIC_` variant and no fallback in code. Remove `apiKeyOverride` from the extraction route and clear any key saved in browsers; add the two Key Vault references to `main.bicep`; add secret scanning to CI; run CI on `s0-*` branches. | P5 | S | Manual: key rotation |
| S0-02 | Permission helper, action-to-permission registry and guard test, with a baseline of current gaps. Decision record D2. | P1 | M | – |
| S0-27 | Role journey smoke tests: Playwright tests that sign in as each built-in role (test-only sign-in: a Playwright global setup mints a signed session cookie with a test-only `AUTH_SECRET`; no sign-in bypass in product code) and walk its main journeys, run in CI. The safety net for S0-03 to S0-07. | P10 | M | S0-02 |
| S0-03 | Lock down destructive and approval actions: clear and reset data (admin, MFA, non-live only, audited); approve and discuss sign-off (permission, matter access, assigned partner, no self-approval); enquiry anonymisation (permission, retention check always applied). Person save (B11): reject `roles`, `permissionOverrides`, `appRole`, `employeePermissions` and `documentPermissions` in `savePersonRecord` (they change only through the RBAC actions, with self-escalation checks), require create or edit permission for contact changes and `employee:edit_core` whenever employee status, role, department or employment changes. Ethical walls (B12): `canAccessMatter` in the core treats `hasEthicalWall` as restricted even when the allow-list is empty (fail closed), with two-tenant and tampered-ID tests. | P1, B3, B11, B12 | L | S0-02, S0-27 |
| S0-04 | Admin saves: teams, lists, custom fields, picklists, org structure, enquiry and task settings, matter costs config, party taxonomy, PMS links. All require admin permissions and MFA. | P1, E8 | M | S0-02 |
| S0-05 | Record actions: task save and reassign; task comments (matter access); enquiry create, edit, assign, close and reopen permissions; merge and party relationships; leaver reassignment (permission, confirm leaver, respect restricted matters, re-permission SharePoint folders, audit each moved record). | P1, B8, B9, item 13 | L | S0-02 |
| S0-06 | AI extraction route: require create permissions, never create employees, apply `aiProviderChoice` and `enableAiMatterExtraction`. Record which data goes to which AI provider for each tenant (standard section 10) in a help article and the configuration notes. | B10, P7 | M | S0-02 |
| S0-07 | Conflict fixes: quote conversion runs the full conflict check and blocking rules; enquiry conversion checks `matter:create` before creating records and records a decision for new organisations; the search covers instructing and billing contacts and a person’s organisation links, in **both** conflict searches (`searchMatterConflicts` in `src/domain/matterConflicts.ts` and `runEnquiryConflictSearch` in `src/domain/enquiries.ts`), and records what was searched. | B5, B7, item 1a | M | S0-02 |
| S0-08 | Risk assessment: keep the wizard answers on save and score risk on the server, with tests for new and edited matters. | B1, item 4 | M | – |
| S0-09 | Merge: repoint every reference in one operation, with tests for each record type: matters (client person and organisation, `additionalClientIds`, instructing, billing and referrer contacts, parties, conflict record party links), enquiries, quotes, tasks, PMS links, person–organisation links (de-duplicated), organisation `relationshipPartnerId`, generated documents and document links (including the tenant document repository), and notes. Refuse to merge employee records. Keep the merged-away record as a tombstone (`mergedIntoId`) so old links and audit entries still resolve. | B4, item 28 | L | S0-05 |
| S0-10 | Finance gating: finance out of the snapshot (D4); gate on `finance:view` and `finance:view_matter`; remove the hard-coded `canViewFinance: true`; filter the four firm roll-ups for restricted matters. | P4 | M | S0-02 |
| S0-11a | Remove demo content from product code (D5), one pull request per area: Home, matter profile, person and organisation profiles. Remove fake compliance statuses and the hard-coded firm name; add a CI check for demo literals. | P6 | L | – |
| S0-11b | Demo tenant (ADR 0026): a seed command that loads demo data into a tenant, and a non-live demo deployment with demo mode and the email allow-list, so demos keep working. Becomes a tenant in the shared deployment after S0-17. | P6 | M | S0-11a |
| S0-12 | Tenant settings: apply or remove each of the seven ignored settings; add a test that every schema key is used at runtime or marked reserved. | P7 | S | S0-06 |

**Checkpoint A:** re-run the status review for the 0A rows and update `feature-list.md`.

### Phase 0B: Make it solid

| Slice | Work | Backlog IDs | Size | Depends on |
|---|---|---|---|---|
| S0-13 | Infrastructure (D1, ADR 0024): split `main.bicep` into shared platform and per-tenant modules; replace App Service with a Container Apps environment and app; add the database, Log Analytics and Application Insights, and the PDF converter as an internal container app; cost tags per tenant. Keep the existing VNet and Key Vault design. Second pull request (S0-13b): telemetry from the app with correlation and tenant IDs and no personal data (standard 13). | P12 | L | Manual: Azure access |
| S0-14 | Replace the in-memory Postgres simulation with a real per-tenant database and migration runner. Migrations are tracked per tenant and reversible. Decision record D3. | P2 | L | S0-13 |
| S0-15 | Move key dates onto `TenantKeyDateRepository` at runtime. The repository already exists, so this proves the pattern for the other modules. | P2, P8 | M | S0-14 |
| S0-16 | Move people, organisations, links and notes; then matters and parties (matter numbers from a sequence, which also fixes B6). | P2, P8 | L | S0-15 |
| S0-17 | Move enquiries, quotes, tasks, notifications and sign-offs; then HR and employment; then lists, org structure, custom fields and the audit log. Document generation and document store metadata move off the JSON store too. | P2, P8 | L | S0-16 |
| S0-18 | PMS data per tenant, using `pmsConnectionSecretVaultRef`, with a two-tenant test. | P3 | M | S0-14 |
| S0-19 | Tenant-aware scheduler on Container Apps jobs (D6). Move the daily key date reminder check and retention anonymisation onto it. | P9 | M | S0-13, S0-14 |
| S0-20 | Retire the JSON store: keep it only for dev and demo seeding; remove Firestore sync; supersede ADR 0001. | P2 | S | S0-17 |

**Checkpoint B:** run the full two-tenant test suite; re-run the status review.

### Phase 0C: Make it shared

S0-24 (the registers engine) can start once S0-17 and S0-19 are done, and can run alongside the other 0C slices. It must be finished before stage 2’s undertakings and stage 3’s registers. S0-26 can be brought forward if real email is needed for demos sooner; the `EmailSender` interface does not depend on the store migration, only notification scheduling does. S0-28 and S0-29 are needed for items 30 and 32 to meet the Completed bar.

| Slice | Work | Backlog IDs | Size | Depends on |
|---|---|---|---|---|
| S0-21 | Clients, contacts and parties: persona decision (D8), merge execution tests, two-tenant test, help. | 28, Q1 | M | S0-16 |
| S0-22 | Departments and work types: tests and help. Work types drive (a) automatic task templates, chosen by work type when a matter opens; (b) the risk questionnaire, with questions varying by work type, building on S0-08’s server-side scoring; and (c) retention periods, setting the matter destruction date on closure. All three are tenant configuration with schema entries. Also advances items 4, 9 and 23. | 29 | L | S0-17, S0-08 |
| S0-23 | Rates and charging: tests for rate lookup, the costs snapshot and quote maths; VAT rate as tenant configuration. | 30 | M | S0-17 |
| S0-24 | Registers engine in the core (D7), with sign-offs migrated onto it as the first consumer; contract tests for its extension points; two-tenant isolation tests for register records, including tampered record IDs. | 31 | L | S0-17, S0-19 |
| S0-25 | Search: server-side search covering documents, quotes and key dates, respecting visibility; tests, including two-tenant tests that search never returns another tenant’s records or restricted matters. | 32 | M | S0-17 |
| S0-26 | Email and notifications (D9): the `EmailSender` interface and the dev catcher, Graph and placeholder ACS adapters; tenant configuration for provider, sender address, Key Vault references and recipient allow-list (schema change, backward compatible); notification email delivery with user preferences (channel and frequency per notification type); tests, including that a non-live tenant never sends outside its allow-list. Enquiry and quote sending (items 1 and 3) are wired to it in stage 1. | 32 | M | S0-19 |
| S0-28 | Negotiated rates and CFA/DBA (D10): client- and matter-level rate overrides with effective dates and precedence; rate lookup uses them in quotes, matter costs and the costs snapshot; CFA and DBA fee bases with configurable, validated terms; tests for every precedence path and fee basis; two-tenant test; help. | 30 | L | S0-23 |
| S0-29 | Teams delivery and digests (D11): digest job on the scheduler, per-user preferences, digest email through `EmailSender`; Teams activity-feed adapter behind a per-tenant setting (default off); tests, including that a non-live tenant never sends outside its allow-list; help. | 32 | M | S0-26, S0-19 |

**Exit review:** re-run the status review against section 2 of this plan. Stage 1 planning starts when every exit criterion is met.

## 5a. Coverage of the stage 0 backlog

Every stage 0 row in `feature-list.md` and the slices that deliver it. Any new stage 0 backlog row must be added to this table, with a slice, in the same pull request.

| Backlog | Slices |
|---|---|
| 28 Clients, contacts and parties | S0-04, S0-05, S0-09, S0-16, S0-21 |
| 29 Departments and work types | S0-04, S0-17, S0-22 |
| 30 Rates and charging | S0-04, S0-23, S0-28 |
| 31 Registers engine | S0-24 |
| 32 Search and notifications | S0-11a, S0-25, S0-26, S0-29 |
| P1 Permission checks | S0-02 to S0-07, S0-10 |
| P2 Off the transitional store | S0-14 to S0-17, S0-20 |
| P3 PMS per tenant | S0-18 |
| P4 Finance exposure | S0-10 |
| P5 Secrets | S0-01 (plus the deferred key rotation) |
| P6 Demo content | S0-11a, S0-11b |
| P7 Ignored settings | S0-06, S0-12 |
| P8 Two-tenant tests | S0-03, S0-15 to S0-18, S0-21, S0-24, S0-25, S0-28 |
| P9 Scheduler | S0-19 |
| P10 Test coverage | S0-27, and tests in every slice |
| P11 Help articles | Every slice |
| P12 Infrastructure | S0-13 |
| B1 | S0-08 |
| B3 | S0-03 |
| B4 | S0-09 |
| B5, B7 | S0-07 |
| B8, B9 | S0-05 |
| B11, B12 | S0-03 |
| B10 | S0-06 |

## 5b. Work packages

To cut the number of hand-offs, slices are built and reviewed in five work packages. Antigravity builds every slice in a package in order; Claude Code reviews the package once and returns one fix list; Antigravity applies the fixes once.

| Package | Slices, in order | Starts | Blocked by |
|---|---|---|---|
| WP1 Safety foundations | S0-01 review fixes (R229–R235), S0-02, S0-27, S0-08 | Now | Nothing |
| WP2 Lock-down and bug fixes | S0-03, S0-04, S0-05, S0-06, S0-07, S0-09, S0-12 | After WP1 merges | Nothing |
| WP3 Finance and demo | S0-10, S0-11a, S0-11b | After WP2 | D4 accepted; demo Entra app (manual) |
| WP4 Make it solid (0B) | S0-13 to S0-20 | After D3 and D6 are accepted | Azure subscription access (manual) |
| WP5 Make it shared (0C) | S0-21 to S0-26, S0-28, S0-29 | After WP4 | D7, D8, D10, D11; Teams app, mailbox and CFA/DBA caps (manual) |

Rules:
- Each slice keeps its own branch (`s0-NN-short-name`, from `develop` or stacked on the slice it depends on), its own commits and its own `feature-list.md` update.
- The builder does not push or open pull requests. It hands the whole package back with a report per slice.
- After the review fixes, the product owner pushes and opens one pull request per slice, merged in dependency order.
- S0-11a sits in WP3, with the demo tenant that replaces the demo content, to keep WP1 reviewable.

## 6. How to run each slice

1. **Plan.** In Claude Code plan mode: “Plan slice S0-NN from `docs/roadmap/stage-0-plan.md`. Read the backlog rows it lists, the architecture standard and CLAUDE.md. List the files you will change, the tests you will add (including two-tenant tests), any decision record needed, and the `feature-list.md` rows to update. Don’t write code yet.”
2. **Review the plan** with Antigravity before coding, for the L-sized slices and any slice touching data access, permissions or the conflict search.
3. **Build** on the slice branch.
4. **Review the pull request** with the other tool, against section 14 of the standard and this slice’s acceptance criteria.
5. **Update** `feature-list.md` statuses (strict Completed bar), the Help & documentation pages and `docs/release-notes.md` in the same pull request, then merge.

Keep one tool editing a branch at a time. With work packages (section 5b), steps 1 to 5 run once per package: one prompt, one build of all its slices, one review, one round of fixes, then one pull request per slice.

## 7. Risks

| Risk | Mitigation |
|---|---|
| The store migration (S0-14 to S0-17) is the largest piece and could stall the stage. | Move one module per pull request, starting with key dates, where the repository already exists. Re-check estimates after S0-15. |
| The permission sweep breaks working screens. | The guard test’s baseline list lets gaps close one at a time; add an end-to-end test of each role’s main journeys before S0-03. |
| Removing demo content weakens sales demos. | The demo tenant (D5) keeps a full demo, from seed data only. |
| Hosting mismatch (D1) causes rework in infrastructure. | Decide D1 before S0-13. |
| Adding the work-type, fee arrangement and Teams work (S0-22, S0-28, S0-29) makes stage 0 longer. | These slices are in phase 0C and run in parallel once their dependencies are met. Stage 1 planning (not building) can start during phase 0C. |
| Stage 0 runs long and delays visible progress. | Phase 0A is short and urgent. If needed, stage 1 planning (not building) can start during phase 0C. |

## 8. Manual setup tasks (not for Claude Code)

These need a person with the right admin access. Claude Code should list them in its slice plans where they block work, not attempt them.

| Task | For | Notes |
|---|---|---|
| Rotate the Ideal Postcodes API key in the Ideal Postcodes account and store the new one in Key Vault. | S0-01, stage 0 exit | **Deferred** by the product owner on 6 November 2026: the existing key has credits and is used only in test. It is now in local `.env.local`. The old key is still in the repository history, so rotate it before any real client data goes in, before anyone else gets repository access, and before stage 0 exit. Until then P5 stays Partly built. |
| Create a shared mailbox on 1Squared.co.uk (for example `notifications@1squared.co.uk`). | S0-26 | A shared mailbox is enough; it doesn’t need a user licence for this use. |
| Register an Entra ID app for email, grant Mail.Send through Exchange Online RBAC for Applications scoped to that mailbox only, and do not grant the tenant-wide Graph Mail.Send permission. | S0-26 | Use a certificate or managed identity rather than a client secret if possible; store references in Key Vault. |
| Add SPF, DKIM and DMARC records for 1Squared.co.uk if they aren’t already in place. | S0-26 | Helps demo emails reach inboxes rather than spam. |
| Confirm Azure subscription access for creating the Container Apps environment and database. | S0-13 | |
| Create and approve the 1Squared Teams app (manifest upload by a Teams administrator) and grant `TeamsActivity.Send` to its app registration. | S0-29 | |
| Confirm the CFA and DBA cap values to use as configuration defaults. | S0-28 | A product owner decision, not legal advice. |
| Turn on GitHub secret scanning and push protection for the repository. | S0-01 | **Done** (confirmed 6 November 2026). Complements the CI scan. |
| Put `ANTHROPIC_API_KEY` in Key Vault (and local `.env.local`) for environments that use AI extraction. | S0-01 | **Local `.env.local` done** (6 November 2026). Key Vault follows when an Azure environment exists (S0-13). The browser key box is removed. |
| Create the demo deployment's Entra app registration and test users for each role. | S0-11b, S0-27 | Invented names only. |

## 9. Decisions log

| Date | Decision |
|---|---|
| 6 Nov 2026 | D1: host on Azure Container Apps, as the standard says. |
| 6 Nov 2026 | D5: a separate demo tenant is acceptable for sales demos. |
| 6 Nov 2026 | D9: email through one interface with per-tenant adapters; Graph from a 1Squared.co.uk mailbox now, so demos send real email; Azure Communication Services for the hosted service later. |
| 6 Nov 2026 | Item 2 (Conflict check) shown as Partly built until B7 is fixed. |
| 6 Nov 2026 | Plan v3: checked against the code at `a0a5534`. ADRs 0024 (D1), 0026 (D5) and 0027 (D9) accepted; ADR 0025 (D2) proposed. Added S0-27, split S0-11 into S0-11a and S0-11b, recorded the pre-go-live items, added the AI data-flow record to S0-06, and set the rule that the Ideal Postcodes key is read only from server-side `IDEAL_POSTCODES_API_KEY`. |
| 6 Nov 2026 | D2 decided: ADR 0025 accepted, and ADR 0010 accepted with an amendment (the registry file is the authoritative permission list). |
| 6 Nov 2026 | Ideal Postcodes key rotation deferred while in test; must happen before real client data, wider repository access or stage 0 exit. GitHub secret scanning and push protection are on. Anthropic key set locally. |
| 6 Nov 2026 | Stage 0 delivers all of items 28 to 32: added S0-28 (negotiated rates, CFA/DBA) and S0-29 (Teams and digests), widened S0-22 and S0-26, added D10 and D11 and the coverage table (section 5a). |
| 6 Nov 2026 | Antigravity review of the plan (findings AG1–AG12): added B11 (person save allows self-granted roles) and B12 (ethical walls fail open) to S0-03, which grows to L; widened S0-07 (both conflict searches) and S0-09 (all merge references, no employee merges; now L); two-tenant tests for S0-24 and S0-25; S0-01 and S0-02 slice plans and ADRs 0024 and 0025 corrected. AG12 rejected (the cited references are not in the documents). |
| 6 Nov 2026 | Work packages (section 5b): five packages, one review each; S0-11a moved to WP3. Draft ADRs 0028 (D3), 0029 (D4) and 0030 (D6) added as Proposed. |
