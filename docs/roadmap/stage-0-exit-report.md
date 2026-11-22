# Stage 0 exit report

Review working papers are held outside the repository (`PlanReviews`).

- **Date:** 22 November 2026
- **Final baseline:** `develop` at `b3bcce1` (PR #72). It is deployed to the Azure demo as image `onesquared-web:demo-b3bcce1`, and `/api/health/ready` returns `ready`.
- **Review starting point:** `develop` at `031dd3b`, 19 November 2026.
- **Method:** `Stage0-exit-review-plan.md`. Claude Code reviewed read-only and re-ran every command itself. Antigravity (AG) built the fixes. The owner made the decisions and ran the live checks.
- **Recommendation:** **Stage 0 exit criteria are met, with the caveats named below.** I recommend the owner signs off. Each caveat is either an owner decision already taken or a named item carried into Stage 1 or onto the "before the first hosted client" list.

## 1. How the review ran

| Session | Scope | Fix rounds | Merged | Result |
|---|---|---|---|---|
| 1 | Safe (S1–S6), command runs, sweeps 1–6 | R508–R574 (3 rounds) | PRs #58–#63, then `0bee9e0` | Met |
| 2 | Solid (O1–O7), sweeps 7–12, standard §1–16, ADRs | R575–R642 (5 rounds) | PRs #64–#68, then `8949aa5`; demo deployed | Met |
| 3 | Shared (H1–H2), backlog audit, fix-ID register | R643–R654 (1 round) | PRs #69–#71, then `5392b52` | Met |
| 4 | Owner live checklist; live-journey fixes | R655–R658 (1 round) | PR #72, then `b3bcce1`; demo redeployed | Met |

Session documents, all in `C:\1Squared\PlanReviews\`:
- `Stage0-exit-session1-safe.md`;
- `Stage0-exit-session2-solid.md` and its rounds 2–4;
- `Stage0-exit-session3-shared.md`;
- `Stage0-exit-session4-owner-checklist.md` and `Stage0-exit-session4-fixes.md`.

## 2. Verdict for each criterion

**Safe**

| ID | Criterion | Verdict | Evidence and caveat |
|---|---|---|---|
| S1 | High bugs (B1, B3, B4, B5, B7, B9–B12) and B8 fixed, with regression tests | **Met** | Every test exists and fails without its fix (session 1, re-confirmed in the session 3 backlog audit). B13–B20, added during the exit, are also Completed. |
| S2 | No secrets in the repo or bundle; key rotated; CI blocks new secrets | **Met with caveat** | gitleaks finds nothing in files or the bundle on every run. **Caveat:** Ideal Postcodes key rotation is an owner exception (P5, 18 November 2026), with standing conditions in [stage plan](stage-0-plan.md) §8. |
| S3 | Every action and route declares its permission; the guard test fails the build | **Met** | 125 actions and 13 routes, all wrapped and registered. The guard catches re-exports, inline `use server` and HEAD/OPTIONS handlers (R518, R548, R563). |
| S4 | Finance only to permitted users; roll-ups exclude restricted matters | **Met with caveat** | Owner decisions D1 (roll-ups exclude matters the viewer can't access), D2 (fee earners see their own matters' finance only) and D9 (negotiated rates written by partners, finance and admin only, with MFA for client rates). Live checks 5.1–5.3 passed. |
| S5 | No demo branches or fabricated statuses | **Met** | R510–R516 and R575 (the fabricated "email sent") are fixed. The demo-literal guard runs in CI. |
| S6 | Every setting applied or removed; no `x-reserved:S0-*` | **Met** | The 27 reserved settings are all tagged as backlog items (F17, F19–F23). |

**Solid**

| ID | Criterion | Verdict | Evidence and caveat |
|---|---|---|---|
| O1 | Tenant-scoped repositories and a database per tenant; JSON store only for seeding; ADR 0001 superseded | **Met** | `pg` is confined to `core/src/tenancy` by lint, with `SET LOCAL ROLE` per tenant ([ADR 0001](../decisions/0001-shared-repo-and-transitional-store.md)). Cross-tenant config fallbacks were removed (R586, R615). |
| O2 | PMS data tenant-scoped | **Met with caveat** | The `pms:import` live guard is in place (R584). **Caveat:** PMS money is stored as floating-point pounds, carried as **B21** (D6). |
| O3 | Two-tenant tests cover every module | **Met** | All 23 data modules are covered. The job and search gaps were closed (R587). |
| O4 | Tenant-aware scheduler runs reminders and retention | **Met** | It runs per registry tenant through `guardedJob` and writes `job_runs`. Timeout abort is fixed (R588, R614). Locked reminders are retried the same day (R638). All six schedules succeeded live (check 6.1). |
| O5 | Container Apps; Bicep provisions the environment, database, App Insights and PDF converter | **Met with caveat** | The demo is deployed with health probes, a job-failure alert and an Action Group (live checks 6.2 and 1.1). The container readiness check is now in CI (R655). **Caveats:** D4 (local disk storage for the demo only; a `live` web deployment is refused until `azure-blob` exists); D5 (the built-in PDF converter is the Stage 0 converter; the container is item 46). |
| O6 | Demo tenant loads from seed and supports demos | **Met** | The seed job and "Load demo dataset" both worked live (1.3, 1.4). Live enquiry and matter journeys pass after R655 and R656. |
| O7 | One `EmailSender`; demo sends real email only to allowed recipients | **Met with caveat** | There is one interface and one dispatcher, and the allow-list is checked at send time. R575 fixed enquiry email. **Caveat:** the live email, Teams and digest checks (7.1–7.6) were deferred by the owner to the process reviews. Automated two-tenant and allow-list tests cover the behaviour. |

**Shared**

| ID | Criterion | Verdict | Evidence and caveat |
|---|---|---|---|
| H1 | Items 28–32 meet the Completed bar, including tests (P10) and help (P11) | **Met** | 28 and 29 were confirmed in session 3. 30 was fixed under D9 (R643). 32 was fixed (R646 and R647: notifications sent, and reminders reach email and Teams). P10 and P11 stay Partly built as Stage 0-wide items, with their gaps listed by name. |
| H2 | Registers engine in the core; sign-offs migrated onto it | **Met with caveat** | The engine is in `core/`. Storage moved by migration 0017. Home approvals now go through the engine (R648), with one ID allocator (R650). **Caveat:** the dead `sign_offs` table awaits a contract migration, and partner cost sign-off isn't on the engine. Both are recorded in row 31. |

## 3. Command results (final `develop`)

- **Local, `npm run ci`** (Claude Code, at `078276b`, which equals `b3bcce1` apart from the agreed test, CI and UI tweak; AG's run on `b3bcce1` matches):
  - gitleaks: no leaks;
  - **800 tests passed, 1 skipped** (`sharepoint-live`, which needs live credentials);
  - **11 Playwright journeys passed**, including enquiry → Send to Team (with the privacy-notice rejection) and matter opening.
- **GitHub PR CI on #72:** all checks green, **including the new container readiness step**. The built image loads the extension and reports ready.
- **Migrations:** `0001`–`0022` are present, each with `downSql`. Round trips are tested, and `CORE_REQUIRED_SCHEMA_VERSION = '0022'`.
- **Bicep:** `az bicep build` is clean. The probe bounds are covered by the contract test.

## 4. Sweep results (final)

| # | Sweep | Result |
|---|---|---|
| 1 | Wrapped, registered; admin needs MFA | Pass (D3: admin MFA can't be turned off in `live`) |
| 2 | Tenant only from the verified token | Pass |
| 3 | Logs: no personal data; correlation and tenant IDs | Pass (R524) |
| 4 | No `NODE_ENV` or demo branches or test hooks in production | Pass (R520–R523, R533) |
| 5 | Payroll and sensitive HR audited | Pass (R508, R513) |
| 6 | Restricted matters excluded everywhere | Pass (R509, R528). Live checks in section 4 passed |
| 7 | No module-level state holding tenant data | Pass (R579, R585) |
| 8 | One transaction per operation; no compensation code | Pass (R577, R590, R591, R606–R610). The Outlook sync lease gaps are recorded in row 8 (the real adapter isn't built yet) |
| 9 | No client-supplied time where the server decides | Pass (R589) |
| 10 | Stable keys only | Pass (R576, R592, R626). The `resolveUserAppRole` debt is resolved |
| 11 | Money in integer minor units | Pass with caveat: **B21** (PMS layer) |
| 12 | Tenant ID in caches, queues, search and jobs; files in the tenant's container | Pass with caveat: D4 (`azure-blob` is on the hosted list) |

## 5. Architecture standard and ADRs

- **Sections 1, 3, 8, 14, 15 and 16 conform.** Sections 6 and 9 conform in code, with R593 and R599 enforcing manifest permissions.
- **The gaps in sections 2, 4, 5, 7, 9, 10, 11, 12 and 13** are all on the [stage plan](stage-0-plan.md)'s **"Before the first hosted client"** list (R595):
  - shared multi-tenant web compute and a single promoted image ([ADR 0036](../decisions/0036-stage-0-per-tenant-hosted-web-app.md));
  - an extension import lint rule and a fuller client-name check;
  - schema descriptions and defaults;
  - break-glass access;
  - sign-in and export audit entries;
  - release tags and a training environment;
  - dependency scanning;
  - budgets and dashboards;
  - `azure-blob` storage.
- **ADRs:** [0001](../decisions/0001-shared-repo-and-transitional-store.md) and [0004](../decisions/0004-document-permissions-and-finance-view.md) are Superseded. All others, 0002–0037, are Accepted. [ADR 0036](../decisions/0036-stage-0-per-tenant-hosted-web-app.md) records the Stage 0 one-app-per-tenant position. [ADR 0037](../decisions/0037-extension-api-v2-least-privilege-config-context.md) records extension API 2.0.0, as a one-off rule 7 exception approved by the owner.

## 6. Backlog changes made during the exit review

- **Rows 28–32:** Completed, after re-audit. Row 32 was briefly Partly built until R646 and R647 merged.
- **New rows:**
  - B17–B20: exit bugs, Completed;
  - B21: PMS float money, Stage 1;
  - 46: PDF converter container, Stage 1;
  - F22 and F23: reserved settings.
- **P10 and P11:** stay Partly built, with specific gaps listed.
- **Corrected:** the header ID ranges, the Stage 1 counts, F23, and the "What's missing" text on rows 8, 29, 31 and 32.

## 7. Fix-ID register

The register is in the repo: [docs/roadmap/stage-0-fix-id-register.md](stage-0-fix-id-register.md).
- **R1–R189:** closed by PR #1 and its commits and tests (owner decision **D10**). R26, R46, R64–R69 and R72 are recorded as "closed by PR #1, definition not retained".
- **R190–R658:** every R-ID is either closed and merged, or carried by name into the backlog.
  - **Carried:** R236, R371, R582, R583 (B21) and R639 (row 8).
  - **Recorded follow-ups:** R206, R372, R397, R430, R572, R597 and the R598 sub-items.
- **Open Blocking or Should-fix R-IDs:** none.

## 8. Owner live checklist (session 4)

Run on the demo, 22 November 2026. Full marks are in `Stage0-exit-session4-owner-checklist.md`.

| Area | Result |
|---|---|
| Alert email, Action Group test (1.1, 6.2) | Pass |
| Admin sign-in and admin pages (1.2); admin refused without MFA (2.4) | Pass |
| Demo reset keeps sign-ins (1.3, 1.4) | Pass |
| Enquiry routes to a team (1.5, 3.1) | **Failed, then fixed (R656), and re-tested: Pass** |
| Open a matter through the conflict check (3.2) | **Failed, then fixed (R655), and re-tested: Pass** |
| No Entra directory roles on demo accounts (2.1, R484) | Pass |
| Fee earner has no admin access; persona switcher limits (2.3, 2.5) | Pass |
| Restricted matter hidden: lists, search, direct link (section 4) | Re-tested after the fix: Pass |
| Finance limits and negotiated rate refusals (5.1–5.3) | Pass |
| Scheduled jobs all succeeding (6.1) | Pass |
| Search (8.1) | Pass |
| Undertaking create and discharge (section 9) | Re-tested after R658: Pass |
| Help articles (10.1, 10.2); clean-up reset (11.1) | Pass |
| **Deferred by the owner to the process reviews** | 2.2 (all 8 personas), 3.3–3.6 (Risk, partner sign-off, finance, secretary journeys), 5.4–5.5 (negotiated rates as partner and finance), 7.1–7.6 (email, Teams, digests, write-off notification) |

## 9. Carried into Stage 1, or to the "before the first hosted client" list

**Stage 1 backlog** (each recorded in [feature-list.md](feature-list.md)):
- **B21:** PMS money as integer minor units.
- **Item 46:** the PDF converter container.
- **Row 8:** the real Outlook calendar adapter, plus the lease gaps (a)–(e) listed under R639.
- **Row 31:**
  - a contract migration to drop `sign_offs`;
  - partner cost sign-off on the registers engine;
  - aligning the `signoff:approve` and `register:approve` entry points.
- **Reserved notification categories:** `key_date_approaching`, `credit_control_escalation` and `task_due_soon`.
- **Recorded fix-ID follow-ups:** R206, R372, R397, R430, R572, R597 and the R598 sub-items. Also:
  - a `job_runs` "partial" status;
  - de-duplicating the intake warning on a stable key.
- **P10 and P11:** the named test gaps and help articles (CDD, engagement, money on account).
- **The deferred live checks:** to be repeated in the owner's process reviews (see section 8).

**Before the first hosted client** ([stage plan](stage-0-plan.md)):
- `azure-blob` storage, with user-delegation SAS;
- shared web compute and a single promoted image ([ADR 0036](../decisions/0036-stage-0-per-tenant-hosted-web-app.md));
- the standard gaps listed in section 5 above;
- per-tenant keys, backup and restore, offboarding, rate limits, a penetration test and runbooks.

**Demo environment:**
- **MFA for admin demos.** It depends on the Entra tenant's settings (Entra ID Free with Security Defaults). Per-user MFA or a P1 Conditional Access policy is needed to demonstrate it reliably.
- **P5:** Ideal Postcodes key rotation stays an open owner exception, with its standing conditions.

**Ways of working** (agreed 21 November 2026):
- targeted tests on each branch, with one full CI run at the end;
- fewer fix rounds;
- consider test-file parallelism after Stage 0.

## 10. Owner decisions taken during the exit review

| ID | Decision | Date |
|---|---|---|
| D1 | Firm roll-ups exclude matters the viewer can't access; unlinked PMS rows are included (S4 caveat) | 19 Nov |
| D2 | Fee earner matter finance is limited to their own matters unless they hold `finance:view` | 19 Nov |
| D3 | Admin MFA can't be turned off in `live` | 19 Nov |
| P5 | Ideal Postcodes key rotation exception | 18 Nov |
| D4 | Local disk storage for the demo only; `azure-blob` before the first hosted client | 20 Nov |
| D5 | Built-in PDF converter for Stage 0; the container is item 46 | 20 Nov |
| D6 | PMS float money carried as B21 | 20 Nov |
| D7 | Accept the Proposed ADRs the code relies on (0002–0023) | 20 Nov |
| [ADR 0037](../decisions/0037-extension-api-v2-least-privilege-config-context.md) | Extension API 2.0.0, a one-off rule 7 exception | 21 Nov |
| D9 | Negotiated rate writes limited to partners, finance and admin; MFA for client rates | 21 Nov |
| D10 | PR #1 closes R1–R189 | 21 Nov |

(D8 was the [ADR 0037](../decisions/0037-extension-api-v2-least-privilege-config-context.md) approval gate.)

## 11. Final R-ID fix list

**None.** There are no open Blocking or Should-fix items.

## 12. Sign-off

**Signed off by the product owner on 22 November 2026.** Stage 0 is complete. Stage 1 planning may start.
