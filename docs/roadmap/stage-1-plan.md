# Stage 1 plan: Intake to open matter

| | |
|---|---|
| Status | Draft v2: under review |
| Baseline | `develop` at `b3bcce1`: Stage 0 complete, signed off 22 November 2026 ([stage-0-exit-report.md](stage-0-exit-report.md)) |
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

**Stage 1 has no third-party integrations** (owner decision, 22 November 2026). ID verification, sanctions and PEP screening, e-signature, payment links and live Companies House lookup are all deferred to named backlog items. Every journey works through recorded **manual** steps, designed so that a provider can be added later without changing the journeys.

## 2. Exit criteria

Stage 1 is done when every statement below is true, confirmed by a Stage 1 exit review that follows the Stage 0 method (independent re-runs, sweeps and an owner live checklist).

**Intake and quoting**
- Items 1, 1a and 2 stay Completed. Their tests still pass, and the enquiry close no longer claims a task it didn't raise (S1-01).
- **Item 3, quotes:**
  - a quote can be **sent** to the client by email (through the outbox, with the quote as a PDF);
  - unaccepted quotes are **chased automatically** on a configurable schedule;
  - firms can configure **price transparency** text per work type.

**Client and matter inception**
- **Item 4, client due diligence (CDD):**
  - each **client** (person or organisation) has a CDD record, reused across their matters while valid, covering identity, source of funds and wealth, and sanctions and PEP;
  - the record has an evidence checklist driven by configuration (client type × risk rating);
  - staff record each check by hand, with evidence attached and the decision and who made it audited;
  - a re-check schedule raises reminders;
  - profiles show the real recorded CDD, sanctions and PEP status, replacing the fixed "Not checked". A status is never shown as screened by a provider.
- **Item 4, risk and opening:**
  - a **High** risk rating requires the configured approval (registers engine sign-off) before the matter opens;
  - the opening gate enforces the pre-conditions **configured for the work type**: CDD complete, engagement letter status, money on account received;
  - the **matter number format** is configurable.

**Engagement and money**
- **Item 5, engagement:**
  - B2 is fixed;
  - a client care letter can be generated, then sent from the system by email, then marked **signed** when staff upload the signed copy;
  - the status is tracked automatically from those actions;
  - unsigned letters are chased;
  - a **non-engagement letter** is generated and its task raised when work is declined.
- **Item 6, money on account:**
  - the amount can be set on a quote and on a matter;
  - the client can be sent a request by email, with the firm's client account bank details and a reference;
  - unpaid requests are chased;
  - receipts are recorded by hand, or matched from the PMS client ledger;
  - the opening gate can require funds received, if the work type is configured that way.

**Barriers and integrations**
- **Item 33, information barriers:**
  - a barrier management screen lets authorised users create, change and lift barriers, recording who approved each change;
  - barriers can apply to people, organisations and non-matter documents, as well as matters;
  - barriers set from a conflict decision record the approver;
  - every list, search, export and notification respects barriers. There are two-tenant tests.
- **Item 34, integrations: Partly built at exit, by decision.**
  - Address lookup uses POST (R371).
  - The intake checks (ID verification, sanctions and PEP, e-signature, payment requests) are written so that each one runs through a small interface with a **manual** implementation. A provider can then be added later without changing the journeys.
  - All provider integrations are deferred to named backlog items.
- **Item 46, PDF converter:** the dedicated converter container is built in CI, deployable by Bicep and selectable per tenant. The built-in converter stays as the fallback. This is infrastructure the firm owns, not a third-party integration.

**Platform**
- **B2 is fixed.** **B15 is fixed:** intake and opening paths, `getAppSnapshot` and duplicate checks no longer load the whole tenant.
- P10 and P11 have no Stage 1 gaps left: there are help articles for CDD, engagement, money on account and barriers.
- End-to-end journeys cover enquiry → quote → CDD → engagement → money on account → open matter.
- The Stage 0 checks the owner deferred that fall in Stage 1's area are re-run live:
  - 3.3: Risk approval of a referral;
  - 7.1–7.3: enquiry email delivery and the allow-list.

## 3. Scope

**In scope:** items 3, 4, 5, 6, 33 and 46; item 34 limited to R371 and the manual interfaces; bugs B2 and B15; keeping items 1, 1a and 2 Completed.

**Deferred** (recorded as named backlog items in S1-01):
- ID verification provider;
- sanctions and PEP screening provider;
- e-signature provider;
- payment links;
- live Companies House lookup.

**Corrections found while planning** (the code contradicts the backlog; fixed in S1-01):
- **Item 6:** payment on account is **not** on quotes. It exists only on the matter (`retainerMoniesOnAccountGbp`) and the costs snapshot.
- **Item 34:** there is no `lookupPostcode` and no "first premise" bug. The UI already offers several suggestions. Only the GET-to-POST change (R371) remains.
- **Item 5:**
  - the "tested" claim for the drafted-status flow needs checking;
  - `functionality-inventory.md` says generating a client care letter marks it drafted, but B2 means it doesn't;
  - the enquiry close toast says a non-engagement task was raised, but none is.
- **Item 33:** a barrier **can** already be set from a conflict decision (`information_barrier` reviewer condition, `services.ts:~8770`). What's missing is recording the approver, a management screen and non-matter barriers.
- **B15 is wider than recorded.** About 45 calls in `services.ts` load every matter. They include single-record writes (quote mark-sent and follow-up), and duplicate checks load every person and organisation.

**Out of scope:**
- Stage 2 onwards.
- Native billing and accounts: after the MVP.
- Stage 0's "Before the first hosted client" list. It doesn't change, but see risk R3.

## 4. Decisions

| No. | Decision | Outcome | Status | Needed before |
|---|---|---|---|---|
| S1-D1 | Intake check design | One small interface per check in `@platform/core-api` (identity verification, sanctions/PEP screening, e-signature, payment request), each with a **manual** implementation: staff record the result and attach evidence. Selected per tenant in configuration (`manual` is the only value in Stage 1). No sandbox or simulated adapters. Adding a provider later is an additive adapter, with no change to the journeys. ADR required. | **Decided** (owner, 22 November 2026: no third-party integrations in Stage 1) | S1-03 |
| S1-D2 | ID verification and sanctions/PEP provider | **Deferred.** Not in Stage 1. | Decided | – |
| S1-D3 | E-signature provider | **Deferred.** Signed letters are recorded by uploading the signed copy. | Decided | – |
| S1-D4 | Money on account collection | Request by email, with the firm's client account bank details and a reference. Receipts are recorded by hand or matched from the PMS client ledger. **Payment links are deferred.** | **Decided** | S1-08 |
| S1-D5 | CDD data model | **CDD belongs to the client (person or organisation), not the matter.** It is reused across matters while valid. Build it as a **register type on the registers engine** (`cdd`): fields, states, owner, re-check due dates, reminders, approvals and audit, with evidence attached. The checklist comes from configuration (client type × risk). | **Decided** (owner, 22 November 2026) | S1-04 |
| S1-D6 | Opening gate policy | **Every pre-condition is set per work type, with no universal rule.** The available pre-conditions are: CDD complete; engagement letter sent, or signed; money on account received. Firm-level defaults apply when a work type sets nothing: CDD **not required**, engagement letter **not required**, money on account **not required**. Each work type turns on what it needs. A partner can override a configured pre-condition with a recorded reason. Whether a work type's CDD requirement can be overridden is itself set per work type. | **Decided** (owner, 22 November 2026: "rules will change per work type") | S1-05 |
| S1-D7 | High risk handling | A High rating creates a **sign-off on the registers engine**, needing approval from a partner plus the COLP/MLRO role (both configurable). The matter can't open until it's approved. | **Decided** (accepted as recommended) | S1-05 |
| S1-D8 | Matter number format | A tenant-configurable token pattern (for example `{CLIENT}-{SEQ:4}`, `{YEAR}/{SEQ:5}`) with validation. Existing numbers never change. The sequence stays monotonic per tenant (B6). | **Decided** (accepted as recommended) | S1-05 |
| S1-D9 | Information barrier model | Barriers become first-class records. Each has a subject (matter, person, organisation or document), an allow-list and/or deny-list, a reason, an approver and a lift record. `canAccessMatter` and the visibility predicates read them. AG recommends in the slice plan whether barriers are a register type or a core barrier table. | **Decided** (accepted as recommended) | S1-09 |
| S1-D10 | Compliance content | The CDD checklists, price transparency wording, engagement and non-engagement letter terms, and money on account wording are **firm configuration**, with invented defaults for the demo tenant. They are product defaults, not legal advice: the owner or COLP confirms them (section 8). | **Decided** (accepted as recommended) | S1-04, S1-06, S1-07, S1-08 |

## 5. Slices

Each slice is one PR on its own branch, named `s1-NN-short-name`, targeting `develop`. Detailed slice plans go in [`docs/roadmap/slices/`](slices/). Every slice meets the §14 definition of done. Sizes: **S** is up to a day, **M** a few days, **L** a week or more of build effort.

| ID | Slice | Items | Size | Depends on |
|---|---|---|---|---|
| S1-01 | **Quick fixes, truth and backlog.**<br>• B2: one shared document-type constant, with a test.<br>• Raise the non-engagement letter task on decline or close, and make the toast accurate.<br>• Address lookup GET to POST (R371).<br>• Backlog and inventory corrections (§3).<br>• Add the deferred integrations as named backlog items. | 1, 5, 34, B2 | S | – |
| S1-02 | **B15: per-page and SQL-scoped queries.**<br>• `getAppSnapshot` split into per-page loads.<br>• Intake, quote, conflict and opening services use `listVisibleMatters` / `searchVisibleMatters` or targeted lookups.<br>• Duplicate checks run as SQL queries.<br>• Restricted-matter filtering stays in SQL. | B15, 1–4 | L | – |
| S1-03 | **Intake check interfaces** (S1-D1).<br>• Core interfaces and `manual` implementations.<br>• A config schema entry (`manual` only).<br>• Evidence attachment through the existing document storage.<br>• Two-tenant tests.<br>• ADR. | 34 | S | S1-D1 |
| S1-04 | **CDD workflow** (S1-D5).<br>• CDD register type on the client, with a configurable evidence checklist and checks recorded by hand with evidence.<br>• Re-check schedule and reminders.<br>• Real recorded status on profiles.<br>• Help article. | 4 | L | S1-03 |
| S1-05 | **Risk sign-off and opening gate** (S1-D6, S1-D7, S1-D8).<br>• High-risk sign-off on the engine.<br>• Opening pre-conditions configured per work type, with audited overrides.<br>• Configurable matter number format. | 4 | M | S1-04 |
| S1-06 | **Engagement.**<br>• Generate, then send through the outbox with the PDF.<br>• Then signed, by uploading the signed copy, with status tracked automatically.<br>• Chase tasks.<br>• Non-engagement letter generation.<br>• Help article. | 5 | L | S1-01, S1-03 |
| S1-07 | **Quotes.**<br>• Send by email with the PDF (outbox).<br>• Automatic follow-up (a scheduled job or tasks under the tenant-aware scheduler).<br>• Configurable price transparency text per work type.<br>• Payment on account on quotes. | 3, 6 | M | S1-02 |
| S1-08 | **Money on account** (S1-D4).<br>• Request email with bank details and reference.<br>• Chasing.<br>• Receipt recording and PMS ledger matching.<br>• Work-type opening gate option.<br>• Help article. | 6 | M | S1-05, S1-07 |
| S1-09 | **Information barriers** (S1-D9).<br>• Management screen; approver recorded.<br>• Barriers on people, organisations and documents.<br>• All visibility predicates, search, exports and notifications updated.<br>• Two-tenant and tampered-ID tests.<br>• Help article. | 33 | L | S1-02 |
| S1-10 | **PDF converter container.**<br>• Dockerfile (headless LibreOffice), CI build and readiness check, Bicep wiring.<br>• An adapter selected per tenant, with the built-in converter as fallback. | 46 | M | – |
| S1-11 | **Stage 1 journeys and documentation.**<br>• End-to-end journey enquiry → quote → CDD → engagement → money on account → open.<br>• Close any remaining P10/P11 gaps for Stage 1.<br>• Backlog rows updated. | 1–6, 33, 34 | M | all |

## 5a. Work packages and timescales

Antigravity builds each package's slices in order. Claude Code reviews the package **once**. Only Blocking findings trigger a fix round; Should-fix findings are fixed in the same round where they're quick, and otherwise go to the backlog by name. Testing follows section 6.

| Package | Slices | Blocked by | Estimated elapsed time* |
|---|---|---|---|
| WP1 Foundations | S1-01, S1-02, S1-03, S1-10 | Nothing (decisions taken) | 4–5 days |
| WP2 Client inception | S1-04, S1-05 | WP1; S1-D10 content confirmed | 4–5 days |
| WP3 Engagement, quotes and money | S1-06, S1-07, S1-08 | WP2; S1-D10 | 4–6 days |
| WP4 Barriers | S1-09 | WP1 (can run alongside WP2 or WP3) | 3–4 days |
| WP5 Close-out | S1-11, then the Stage 1 exit review (4 sessions, as for Stage 0) | All | 3–4 days |

\* **Basis:** Stage 0's actual pace (about 30 slices, 6–22 November, including a 4-day exit review). Removing the third-party integrations removes the provider-account waits and makes S1-03, S1-06 and S1-08 smaller.
- **Estimate: about 3–3½ weeks** to the Stage 1 exit sign-off, with WP4 running alongside WP2 or WP3. About 4 weeks if every package runs in sequence.
- **What could extend it:** waiting for the compliance-content confirmations (section 8), and more than one fix round per package.

## 6. How to run each package

1. **Plan.** AG writes slice plans for the package: the files, tests (including two-tenant tests), ADRs and backlog rows. Claude Code reviews the plans for the L-sized slices before coding.
2. **Build.** One branch per slice, stacked where slices depend on each other. Don't push.
3. **Test, per branch:** `npx tsc --noEmit`, `npm run lint`, the changed test files and `npx vitest run isolation`. Run the **full `npm run ci` once, on the top branch,** at the end of the package. Only one test suite at a time against the local PostgreSQL cluster.
4. **Review.** Claude Code reviews the package once. **Blocking** findings mean a fix round. **Should-fix** findings are fixed in the same round if quick, or recorded by name in the backlog. Suggestions never cause another round.
5. **Merge.** Merge commits, with green PR CI, including the container readiness check. Redeploy the demo, using the owner-authorised deploy prompt, after each package that changes user journeys.

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Manual CDD is mistaken for provider screening | Profiles and documents show "Recorded manually by <person> on <date>", never "screened". Help explains that no automated screening is connected. |
| R2 | Compliance content is wrong (CDD checklists, engagement terms, money on account wording) | Everything is firm configuration with invented demo defaults. The owner or COLP confirms them (section 8). The code makes no legal claims. |
| R3 | CDD evidence and signed engagement letters are client documents, but hosted storage is `local-fs` for the demo only (Stage 0 decision D4) | Fine for the demo, which holds invented data. **No live tenant can hold real CDD evidence until `azure-blob` storage is built** (already on the "Before the first hosted client" list). Consider pulling that item forward if a pilot client is planned. |
| R4 | The B15 refactor breaks existing screens | S1-02 is in WP1, so the later slices build on it. The existing journey tests plus new ones catch regressions. Restricted-matter filtering stays in SQL, with two-tenant tests. |
| R5 | Barrier changes (S1-09) leak restricted data | Visibility predicates stay central (`canAccessMatter` and the SQL predicates). Tampered-ID and two-tenant tests run for every surface. Stage 0's sweep 6 is re-run in the exit review. |
| R6 | Work types configured with no pre-conditions open matters without CDD | That is the intended behaviour (S1-D6). The work-type admin screen shows each work type's pre-conditions clearly, and the help explains the choice. A firm-wide report of open matters without completed CDD goes on the backlog for Stage 3 (risk and compliance). |
| R7 | Scope grows from tester feedback | Feedback goes to the backlog. Only Blocking issues change a package in flight. |

## 8. Manual setup tasks (not for Claude Code or Antigravity)

| Task | For | Notes |
|---|---|---|
| **COLP/MLRO or owner confirms the compliance defaults:**<br>• the CDD evidence checklist by client type and risk, and the re-check interval;<br>• the High-risk approvers;<br>• which work types require CDD, an engagement letter or money on account before opening;<br>• the price transparency wording;<br>• the engagement and non-engagement letter templates and terms;<br>• the money on account request wording and client account bank details. | S1-D6, S1-D10 | Needed before WP2 and WP3 exit. The demo tenant uses invented values. |
| Ideal Postcodes key rotation (the Stage 0 P5 exception, with standing conditions) | Ongoing | Unchanged. |
| Redeploy the demo after each package that changes journeys (owner-authorised AG prompt, then the owner's spot check). | Each package | As in Stage 0 session 4. |

## 9. Decisions log

| Date | Decision |
|---|---|
| 22 Nov 2026 | Draft v1 written from `develop` `b3bcce1` after the Stage 0 sign-off. The owner confirmed: build Stages 1–5 in order, keep the strict Completed bar, prioritise correctness over the demo, and gain speed through the test cadence and fewer fix rounds. |
| 22 Nov 2026 | Owner decisions (draft v2):<br>• **No third-party integrations in Stage 1.** ID verification, sanctions and PEP, e-signature, payment links and live Companies House are deferred to named backlog items, and Stage 1 uses manual implementations behind small interfaces.<br>• **CDD is held on the client.**<br>• **CDD is not required before a matter opens unless the work type requires it.** Every opening pre-condition is set per work type.<br>• S1-D7 to S1-D10 accepted as recommended. |
