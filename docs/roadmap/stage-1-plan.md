# Stage 1 plan: Intake to open matter

| | |
|---|---|
| Status | **Approved v3.1** (product owner, 22 November 2026) |
| Baseline | `develop` at `7c2ba3e` (repository, including the Stage 0 exit docs). The code baseline is `b3bcce1`, which is deployed to the Azure demo. Stage 0 is complete ([stage-0-exit-report.md](stage-0-exit-report.md)). |
| Backlog | [docs/roadmap/feature-list.md](feature-list.md) (IDs in this plan refer to it) |
| Standard | [Platform Architecture Standard](../architecture-standard.md). Especially §6 (extensions and integrations), §8 (isolation), §10 (data protection) and §14 (definition of done) |
| Quality bar | Unchanged from Stage 0. **Completed** means: works end to end, server-side permission checks, tests including two-tenant tests where data is touched, and a help article describing current behaviour. Speed comes from the process (section 6), not from a lower bar. |

## 1. Goal

Take a firm from first contact to a **funded, engaged, open matter** without leaving the system:
1. the enquiry;
2. the quote;
3. the conflict check;
4. client due diligence (recorded by staff);
5. the risk decision;
6. the engagement letter, sent and signed;
7. money on account requested and received;
8. the matter opened behind the right information barriers.

Every Stage 1 item must meet the Completed bar.

**Stage 1 has no third-party integrations** (owner decision, 22 November 2026). ID verification, sanctions and PEP screening, e-signature, payment links and live Companies House are deferred to named backlog items. Every journey works through recorded **manual** steps behind small core interfaces.

## 2. Exit criteria

Stage 1 is done when every statement below is true, confirmed by a Stage 1 exit review that follows the Stage 0 method (independent re-runs, sweeps and an owner live checklist).

**Intake and quoting**
- Items 1, 1a and 2 stay Completed. Their tests still pass, and the enquiry close no longer claims a task it didn't raise.
- **Item 3, quotes:**
  - a quote can be **sent** by email (through the outbox, with the quote as a PDF);
  - unaccepted quotes are **chased automatically** on a configurable schedule;
  - firms can configure **price transparency** text per work type;
  - payment on account can be set on a quote.

**Client and matter inception**
- **Item 4, client due diligence (CDD):**
  - each **client** has a CDD record, reused across their matters while valid;
  - the record has an evidence checklist driven by configuration (client type × risk);
  - staff record each check by hand, with evidence stored through the tenant's document storage (`local-fs` on the one-replica demo; see R3);
  - a re-check schedule raises reminders;
  - profiles show the real recorded status, never "screened".
- **Item 4, risk and opening:**
  - a **High** risk rating needs approval from a partner **and a different** COLP/MLRO (`high_risk_opening` register type) before the matter opens;
  - the opening gate enforces each work type's configured pre-conditions, and re-checks them inside the matter transaction;
  - the matter number format is configurable.

**Engagement and money**
- **Item 5, engagement:**
  - B2 is fixed, with the status set on the server and never moved backwards;
  - a client care letter can be generated, then sent from the system by email, then marked signed when staff upload the signed copy;
  - unsigned letters are chased;
  - a non-engagement letter is generated and its task raised when work is declined.
- **Item 6, money on account:**
  - the client can be sent a request by email, with the client account bank details and a reference;
  - unpaid requests are chased;
  - receipts are recorded by hand, or matched from the PMS client ledger, **in integer pence** (B21);
  - the opening gate can require funds received, if the work type is configured that way.

**Barriers, storage and integrations**
- **Item 33, information barriers:**
  - barriers are first-class records (core barrier tables), with a management screen, the approver recorded, and subjects that can be matters, people, organisations or documents;
  - **a barrier applies to everyone not on its allow-list, including holders of `matter:restricted:access`.** Explicit deny entries override everything (S1-D12);
  - every list, search, export and notification respects barriers, with two-tenant tests.
- **Email attachments:**
  - quote and engagement-letter PDFs are **held in the tenant's outbox,** so every drain, including the background job, sends them without a shared disk (S1-D11);
  - attachments are size-capped and scrubbed by the outbox content retention.
  - Document storage is unchanged from Stage 0: decision D4 still applies (local disk, demo only, `live` refused), and `azure-blob` stays on the "Before the first hosted client" list.
- **Item 34:** **Partly built at exit, by decision.**
  - Address lookup uses POST, with the first-premise and in-memory copy faults fixed.
  - The manual intake-check interfaces exist ([ADR 0038](../decisions/0038-intake-check-interfaces-and-manual-adapters.md)).
  - All provider integrations are deferred to named backlog items.
- **Item 46, PDF converter:**
  - the self-built converter container is built and smoke-tested in CI and deployable by Bicep (internal ingress only, with probes);
  - it can be selected per tenant, with the built-in converter as the fallback.

**Platform**
- **B2, B15 and B21 are fixed.** B15: no request path loads the whole tenant except the documented allow-list, and a guard test enforces that.
- P10 and P11 have no Stage 1 gaps left.
- End-to-end journeys cover enquiry → quote → CDD → engagement → money on account → open matter.
- The Stage 0 checks the owner deferred that fall in Stage 1's area are re-run live (3.3, 7.1–7.3).

## 3. Scope

**In scope:**
- items 3, 4, 5, 6, 33 and 46;
- item 34: R371 and the manual interfaces only;
- bugs B2, B15 and B21;
- outbox-held email attachments (S1-D11);
- keeping items 1, 1a and 2 Completed.

**Deferred** (named backlog items): ID verification, sanctions and PEP, e-signature, payment links, live Companies House.

**Corrections found while planning** (S1-01 fixes these in the backlog and inventory):
- **Item 6:** payment on account isn't on quotes.
- **Item 34:** there's no `lookupPostcode`, but `PersonFormClient` **does** pick the first premise and copies addresses from in-memory records (AG review SF-1).
- **Item 5:** B2 is wider than recorded (the Documents tab, an unawaited call, status regression). The "tested" claim is only partly true.
- **Item 33:** reviewers are stamped, but there's no barrier record with its own approver.
- **B15:** about 44 whole-tenant call sites, plus the layout loading data twice and browser-side scans in five forms.
- **B4 (from AG's review):** `canAccessMatter` lets `matter:restricted:access` through ethical walls. Fixed in S1-09 under S1-D12.

**Out of scope:**
- Stage 2 onwards.
- Native billing and accounts: after the MVP.
- The "Before the first hosted client" list, unchanged. It still includes `azure-blob`.

## 4. Decisions

| No. | Decision | Outcome | Status | Needed before |
|---|---|---|---|---|
| S1-D1 | Intake check design | Four small interfaces in `@platform/core-api` (identity verification, sanctions/PEP, e-signature, payment request), each with a **manual** evidence-backed implementation. Selected per tenant (`manual` is the only value). No sandbox or simulated adapters. This is an additive change, so `CORE_API_VERSION` goes to **2.1.0**. [ADR 0038](../decisions/0038-intake-check-interfaces-and-manual-adapters.md). | Decided; ADR 0038 to be Accepted | S1-03 |
| S1-D2 | ID verification and sanctions/PEP provider | Deferred | Decided | – |
| S1-D3 | E-signature provider | Deferred. Signed letters are recorded by upload. | Decided | – |
| S1-D4 | Money on account collection | An email request with bank details and a reference. Receipts are recorded by hand or matched from the PMS ledger. Payment links are deferred. | Decided | S1-08 |
| S1-D5 | CDD data model | Held on the client; a `cdd` register type, with checklist and evidence field support added to the engine, plus client indexes and filters (AG review SF-6). | Decided | S1-04 |
| S1-D6 | Opening gate policy | Every pre-condition is set per work type. The firm defaults are "not required". A partner can override a configured pre-condition with a recorded reason. Whether a work type's CDD requirement can be overridden is set per work type. The gate's database-backed checks are re-run inside the matter transaction. | Decided | S1-05 |
| S1-D7 | High risk handling | A dedicated `high_risk_opening` register type (`pending_partner` → `pending_compliance` → `approved`), using new generic engine rules: allowed roles per transition, and "must differ from the previous approver". The admin role can't bypass it. | Decided | S1-05 |
| S1-D8 | Matter number format | A configurable token pattern, rendered separately from the sequence key. Existing numbers never change, and B6 monotonicity is kept. | Decided | S1-05 |
| S1-D9 | Information barrier model | **Core barrier tables:** `information_barriers`, `information_barrier_targets` and `information_barrier_principals` (AG's recommendation), with indexed `EXISTS` / `NOT EXISTS` helpers used by every visibility predicate and by `canAccessMatter`. | Decided | S1-09 |
| S1-D10 | Compliance content | Firm configuration with invented demo defaults. The owner or COLP confirms it (section 8). | Decided | S1-04 to S1-08 |
| S1-D11 | Storage for email attachments | **Store the attachment bytes in the tenant's outbox,** in a tenant-database table or column added by an expand migration, so the background drain sends PDFs without a shared disk.<br>• Size-capped at about 3 MB per message (the Graph inline limit).<br>• Scrubbed by `outboxContentRetentionDays`.<br>• Never logged.<br>• Two-tenant tests.<br>**Azure Blob isn't built in Stage 1.** The Stage 0 D4 exception stays (local disk, demo only, one replica, `live` refused), and `azure-blob` stays on the "Before the first hosted client" list. | **Decided** (owner, 22 Nov 2026; revised the same day to remove Azure Blob) | S1-03 |
| S1-D12 | Who a barrier excludes | **Everyone not on the allow-list,** including `matter:restricted:access` holders. Explicit deny entries override everything. Senior staff and the COLP see a walled matter only if they're named on its allow-list, which is recorded and audited. HR staff matters keep their [ADR 0014](../decisions/0014-staff-matter-access-by-permission.md) oversight access. | **Decided** (owner, 22 Nov 2026) | S1-09 |

## 5. Slices

Each slice is one PR, on branch `s1-NN-short-name`, targeting `develop`. Slice plans are in [`docs/roadmap/slices/`](slices/). Sizes: **S** is up to a day, **M** a few days, **L** a week or more.

| ID | Slice | Items | Size | Depends on |
|---|---|---|---|---|
| [S1-01](slices/s1-01-quick-fixes.md) | **Quick fixes, truth and backlog.**<br>• B2: status set on the server, with no regression, `Drafted` and `Signed & returned` added, the full test set.<br>• The non-engagement letter task, raised after the person clean-up, skipping drafts and reasons that don't need a letter, with no duplicates, covering both UI callers.<br>• The conflict close reason matched by `systemKey`.<br>• R371: POST, the `PersonFormClient` first-premise and in-memory copy faults, the enquiry modal picker.<br>• Stale row text; R636's stable de-duplication key; the configured sender enforced over `message.from` (R598); the `?? 285` and `?? 1500` fallbacks removed.<br>• Backlog and inventory corrections, and the deferred integrations recorded. | 1, 5, 34, B2 | S–M | – |
| [S1-02a](slices/s1-02a-scoped-queries-server.md) | **B15, server side.**<br>• SQL-scoped repository methods; conflict and duplicate candidate SQL across all six conflict paths.<br>• The write paths, finance and document services converted.<br>• The `ENQUIRY_VISIBLE_SQL_PREDICATE` Draft fix; the `putQuote` write-on-read removed.<br>• Migration `0023` if indexes are needed.<br>• A **request-path guard test with a baseline list that can only shrink.** | B15, 1–4 | L | S1-01 |
| [S1-02b](slices/s1-02b-page-loaders.md) | **B15, page side.**<br>• `pageLoaders.ts`: the layout and per-route loaders, with no double-loading.<br>• The five browser `useMemo` scans moved to debounced server previews.<br>• The guard baseline shrunk to the documented allow-list. | B15 | M | S1-02a |
| [S1-03](slices/s1-03-intake-check-interfaces.md) | **Intake check interfaces and email attachments.**<br>• ADR 0038: four interfaces and manual implementations, an `evidence` storage category, config deep-merge, wiring for the config-usage test, core API 2.1.0.<br>• **Outbox-held attachments** (S1-D11): an expand migration adds attachment bytes to the tenant outbox; enqueue stores the PDF there, size-capped; every drain (the four in-app call sites and the scheduled sweep) reads it from the outbox; retention scrubs it. | 34 | M | S1-01 |
| S1-04 | **CDD workflow.**<br>• The `cdd` register type on the client, with engine checklist and evidence fields, client indexes and filters, and a client-mode registers UI.<br>• Re-check schedule and reminders.<br>• Real recorded status on profiles.<br>• Help. | 4 | L | S1-02a, S1-03 |
| S1-05 | **High-risk sign-off, opening gate and numbering.**<br>• The `high_risk_opening` type, with the generic engine role and distinct-approver rules.<br>• Opening rules per work type with audited overrides, re-checked inside the transaction.<br>• The token-based matter number format, with the sequence key kept separate.<br>• Aligning the `signoff:approve` and `register:approve` entry points. | 4 | L | S1-04 |
| S1-12 | **B21: PMS money as integer pence.**<br>• An expand-then-contract migration of the 22 PMS columns and `retainerMoniesOnAccountGbp` to `BIGINT` pence.<br>• Repository conversion at the boundary; no float sums anywhere.<br>• Tests. | B21, 6 | M | S1-02a |
| S1-06 | **Engagement.**<br>• Generate, then send through the outbox with the PDF attached.<br>• Then signed, by uploading the signed copy.<br>• Chase tasks.<br>• The non-engagement letter.<br>• Help. | 5 | L | S1-03, S1-05 |
| S1-07 | **Quotes.**<br>• A quote PDF (new).<br>• Send through the outbox.<br>• A scheduled chase job.<br>• Price transparency text per work type, with an admin screen.<br>• Payment on account on quotes (migration). | 3, 6 | M–L | S1-02a, S1-03 |
| S1-08 | **Money on account.**<br>• Request email.<br>• Chasing.<br>• Receipts recorded by hand and matched from the PMS ledger (in pence).<br>• The work-type gate option.<br>• Help. | 6 | M | S1-03, S1-05, S1-07, S1-12 |
| S1-09 | **Information barriers** (S1-D9, S1-D12).<br>• Core barrier tables and SQL helpers.<br>• `canAccessMatter` and every visibility predicate, search, export and notification updated.<br>• Deny precedence over `matter:restricted:access`.<br>• Existing `hasEthicalWall` matters migrated to barrier records.<br>• Management screen; approver recorded.<br>• Two-tenant and tampered-ID tests.<br>• Help. | 33 | L | S1-05 |
| [S1-10](slices/s1-10-pdf-converter.md) | **PDF converter container.**<br>• Option A: self-built `node:24-bookworm-slim` plus `libreoffice-writer-nogui`.<br>• CI build and readiness check.<br>• Bicep with internal ingress, probes and a configurable `minReplicas`.<br>• `DOC_CONVERTER_URL` on the web app and jobs.<br>• An adapter selected per tenant, with fallback and logging.<br>• Optional `tenantId` and `correlationId` on the converter interface. | 46 | M | – |
| S1-11 | **Stage 1 journeys and documentation.**<br>• The end-to-end journey.<br>• Remaining P10/P11 gaps closed.<br>• Backlog rows updated. | all | M | all |

## 5a. Work packages and timescales

Antigravity builds each package's slices in order. Claude Code reviews the package **once**. Only Blocking findings trigger a fix round; Should-fix findings are fixed in the same round where they're quick, and otherwise go to the backlog by name.

| Package | Slices, in order | Blocked by | Estimate* |
|---|---|---|---|
| WP1 Foundations | S1-01, S1-03, S1-02a, S1-10 | Plan v3.1 approved; ADR 0038 Accepted | 5–7 days |
| WP1b Page loaders | S1-02b | WP1 | 2–3 days |
| WP2 Client inception | S1-04, S1-05 | WP1; S1-D10 content | 6–8 days |
| WP3 Engagement, quotes and money | S1-12, S1-06, S1-07, S1-08 | WP2; S1-D10 | 7–9 days |
| WP4 Barriers | S1-09 | WP2 (shared visibility SQL) | 4–5 days |
| WP5 Close-out | S1-11, then the Stage 1 exit review | All | 3–4 days |

\* **Basis:** Stage 0's actual pace. **Estimate: about 5½–6½ weeks to the Stage 1 exit sign-off.** The first estimate was 3–3½ weeks. It rose because of:
- B21 (S1-12) coming into scope, and outbox-held attachments added to S1-03;
- S1-05 and S1-07 being larger than first sized;
- B15 being split for safety;
- WP4 now running after WP2.

**What could extend it:** waiting for the compliance content (section 8), and more than one fix round per package.

## 6. How to run each package

1. **Plan.** AG writes slice plans. Claude Code reviews the plans for the L-sized slices before coding.
2. **Build.** One branch per slice, stacked in package order. Don't push.
3. **Test, per branch:** `npx tsc --noEmit`, `npm run lint`, the changed test files and `npx vitest run isolation`. Run the **full `npm run ci` once, on the top branch,** at the end of the package. Only one test suite at a time against the local PostgreSQL cluster.
4. **Review.** Claude Code reviews the package once. Blocking findings mean a fix round. Should-fix findings are fixed in the same round if quick, or recorded in the backlog. Suggestions never cause another round.
5. **Merge.** Merge commits, with green PR CI, including the container readiness checks. Redeploy the demo (owner-authorised prompt) after each package that changes journeys or infrastructure.

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Manual CDD is mistaken for provider screening | Profiles show "Recorded manually by `<person>` on `<date>`", never "screened". Help explains this. |
| R2 | Compliance content is wrong | Firm configuration with invented demo defaults, confirmed by the owner or COLP (section 8). |
| R3 | CDD evidence and signed letters are client documents, but storage stays `local-fs` (demo only, one replica, `live` refused; Stage 0 D4) | Fine for the demo's invented data. **No live tenant can hold real CDD evidence until `azure-blob` is built** (on the "Before the first hosted client" list). Email attachments don't depend on shared storage, because they're held in the outbox (S1-D11). |
| R4 | The B15 refactor breaks screens | Split into server (S1-02a) and page (S1-02b) slices; the guard baseline only shrinks; the journeys catch regressions; restricted filtering stays in SQL. |
| R5 | Barrier changes leak data, or lock out people who need access | Central helpers; tampered-ID and two-tenant tests on every surface; existing walls migrated with their current allow-lists; senior staff added by name where the firm wants it; the Stage 0 sweep 6 re-run at exit. |
| R6 | Work types with no pre-conditions open matters without CDD | Intended (S1-D6). The admin screen makes it visible. A "matters open without CDD" report is on the Stage 3 backlog. |
| R7 | The B21 migration alters finance figures | Expand-then-contract, with conversion verified against the existing float values (round half away from zero) in tests. The demo is re-seeded. |
| R8 | Scope grows from tester feedback | Feedback goes to the backlog. Only Blocking issues change a package in flight. |

## 8. Manual setup tasks (not for Claude Code or Antigravity)

| Task | For | Notes |
|---|---|---|
| **COLP/MLRO or owner confirms the compliance defaults:**<br>• the CDD checklist by client type and risk, and the re-check interval;<br>• the High-risk approvers;<br>• the opening pre-conditions per work type;<br>• the price transparency wording;<br>• the engagement and non-engagement terms;<br>• the money on account wording and bank details. | S1-D6, S1-D10 | Needed before WP2 and WP3 exit. The demo uses invented values. |
| Ideal Postcodes key rotation (Stage 0 P5 exception, with standing conditions) | Ongoing | Unchanged. |
| Redeploy the demo after each package (owner-authorised AG prompt, then the owner's spot check). | Each package | |

## 9. Decisions log

| Date | Decision |
|---|---|
| 22 Nov 2026 | Draft v1 written after the Stage 0 sign-off. The owner confirmed: Stages 1–5 in order, the strict Completed bar, correctness over the demo, and speed through the test cadence and fewer fix rounds. |
| 22 Nov 2026 | Draft v2. Owner decisions:<br>• no third-party integrations in Stage 1 (providers deferred, manual implementations only);<br>• CDD held on the client;<br>• every opening pre-condition set per work type;<br>• S1-D7 to S1-D10 accepted. |
| 22 Nov 2026 | Draft v3, after Antigravity's review (4 Blocking, 9 Should-fix) and Claude Code's review:<br>• B21 added (S1-12);<br>• High-risk approval as a two-approver register type;<br>• the opening gate re-checked inside the transaction;<br>• outbox attachments wired;<br>• B15 split into S1-02a and S1-02b;<br>• S1-05 is L; WP4 runs after WP2;<br>• core barrier tables (S1-D9).<br>Owner decisions:<br>• **S1-D12:** barriers exclude everyone not on the allow-list, including `matter:restricted:access` holders. |
| 22 Nov 2026 | Draft v3.1. **S1-D11 revised:** Azure Blob storage is taken out of Stage 1 (S1-13 removed). Email attachment bytes are held in the tenant's outbox instead (S1-03). The Stage 0 D4 exception stays, and `azure-blob` stays on the "Before the first hosted client" list. |
