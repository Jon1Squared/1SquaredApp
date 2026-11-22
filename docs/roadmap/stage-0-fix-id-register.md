# Stage 0 fix-ID register (`R1`–`R654`)

Maintained for Stage 0 exit review plan step 5 (`docs/roadmap/stage-0-plan.md`, `R653`, Owner Decision `D10`): *"Every R-ID raised (R1 to the latest) and every deferred follow-up must be closed with evidence or carried into Stage 1 by name."*

Originally compiled on 21 November 2026 from `C:\1Squared\PlanReviews\*.md` / `*.txt` and `develop` (`8949aa5`), and completed on `docs/s0-shared-backlog-and-help` following Session 3 fixes (`fix/s0-shared-rates-and-org` with `D9 = (a)`, `fix/s0-shared-notifications-and-signoffs`, and `docs/s0-shared-backlog-and-help` with `D10 = accept`).

**Definitions of status used here**
- **Closed (verified):** a later review file, Session 3 verification, or Stage 0 Session 3 PR records the fix as complete and tested on `develop` / the stacked Session 3 branch line.
- **Closed (`D10` accepted):** Owner Decision `D10` (21 November 2026) accepts PR #1 (`c7ee9e7`), its `"resolve re-test N findings"` commits, and test citations as closure evidence for `R1`–`R189`, recording the nine untraceable IDs (`R26`, `R46`, `R64`–`R69`, `R72`) as `"closed by PR #1, definition not retained"`.
- **Closed (merged, re-check not on file):** the fix commit or PR is on `develop`, with no subsequent Claude Code re-check note on file.
- **Exception:** deferred, carried, or partly done follow-up. Every open exception and named follow-up is recorded in `docs/roadmap/feature-list.md` and/or `docs/roadmap/stage-0-plan.md` (`0` unrecorded items).

## Totals

| Measure | Count |
|---|---|
| R-IDs in `R1`–`R654` | 654 |
| Pre-folder IDs closed under Owner Decision `D10` (`R1`–`R189`) | 189 (115 in PR #1 commit messages, 65 cited in tests/comments, 9 untraceable: `"closed by PR #1, definition not retained"`) |
| Numbering gaps (not defined / deliberately unused) | 3 (`R227`, `R501`, `R517`) |
| Defined in the review sources (`R190`–`R654`, less `R227`, `R501`, `R517`) | 462 |
| Severity of the 462 | Blocking 51 · Should fix 317 · Suggestion 91 · other 3 (R226 unlabelled Part C, R373 "pre-existing, high", R507 follow-up row) |
| Closed (verified) | 409 (395 prior verified + `R312` verified in Session 3 + `R396` verified on `develop` + 12 Session 3 IDs `R643`–`R654`) |
| Closed (merged, re-check not on file) | 41 |
| Exceptions (carried / deferred / follow-up) | 12 (`R206`, `R236`, `R371`, `R372`, `R397`, `R430`, `R572`, `R582`, `R583`, `R597`, `R598`, `R639`) |
| … recorded in `docs/roadmap/feature-list.md` / `stage-0-plan.md` | 12 |
| Unrecorded (`NOT RECORDED`) | 0 |

Severity counts come from the inline label (`· Blocking ·`, `(Should fix)`) or the enclosing section heading at first definition.

## Summary by round

| Round (source files) | R-ID range | Count | B / S / Sg / other | How closed (approval + merge) | Exceptions |
|---|---|---|---|---|---|
| Pre-folder architecture review (no file) | `R1`–`R189` | 189 | unknown | **Closed (`D10` accepted, 21 Nov 2026):** `R75`–`R189` have `"resolve re-test N findings (R…)"` commits `95272b0`…`4c5b486` merged in PR #1 (`c7ee9e7`); 65 of `R1`–`R74` are cited in tests/comments on `develop`; `R26`, `R46`, `R64`–`R69`, `R72` are recorded as `"closed by PR #1, definition not retained"`. | See "Gaps in numbering" |
| SharePoint Sites.Selected (`SharepointReview-Fixes.md`, `-Round2.md`, `SharepointPR-Description.md`) | `R190`–`R209` | 20 | 3 / 9 / 8 / 0 | Round 2: `"R190–R204 from round 1 are all done"`; `c08e386` (`R205`, `R207`–`R209`); PR #2 (`d1d29e6`). | `R206` |
| CI parity (`LocalCiParity-Fixes.md`) | `R210`–`R212` | 3 | 0 / 0 / 3 / 0 | `0f7471b`, PR #3 (`a06746f`). No re-check file. | — |
| Interactive testing (`interactive_testing_review_fixes.md`) | `R213`–`R228` (`R227` gap) | 15 | 0 / 8 / 6 / 1 | `f0e64e9` (`R213`–`R219`, `R228`), `a0a5534` (`R220`–`R225`), PR #5 (`31db152`). `R226` (Part C) superseded by S0-10 / ADR 0029, PR #20 (reviewed in WP3). No re-check file for `R213`–`R225`, `R228`. | — |
| S0-01 + WP1 (`S0-01-review-fixes.md`, `WP1-prompt.md`, `WP1-review-fixes.md`, `WP1-retest-fixes.md`, `WP1-retest2-fixes.md`, `WP1-retest3.md`) | `R229`–`R251` | 23 | 2 / 9 / 12 / 0 | WP1-prompt `"R229–R235 are done… all resolved"`; WP1-retest `"R239–R246 are all resolved"`; WP1-retest2 `"R247 is resolved"`; WP1-retest3 `"R248–R251 are all fixed… meets the merge bar"`. PRs #9–#12. | `R236` |
| WP2 (`WP2-review-fixes.md`, `WP2-retest-fixes.md` to `-retest5-fixes.md`) | `R252`–`R312` | 61 | 6 / 51 / 4 / 0 | Retests 1–4 list each item Fixed; retest 5 confirms `R311` and raises `R312`. `R312` fix `245439a` merged in PR #17 and **re-checked fixed in Session 3** (no `conflictWarning` URL parameter remains). PRs #13–#19. | — |
| WP3 + S0-30 (`WP3-review-fixes.md`, `WP3-retest-fixes.md` to `-retest4-fixes.md`, `S0-30-retest5-fixes.md`, `Push-and-PR-prompt.md`) | `R313`–`R400` | 88 | 2 / 74 / 11 / 1 | WP3-retest4: `"WP3: ready to merge. R374–R380 are all Fixed"`, PRs #20–#22. S0-30: retest4/retest5 list `R381`–`R395` fixed; `R396` verified closed on `develop` (`core/tests/rbac.test.ts:8460-8515`, `src/server/services.ts:20688-20690`, `R399`); `R398`–`R400` fixes merged in PR #24 (`52390b9`); `R392` via `7f57d4c`. `R373` became `B13` / S0-30 (`Completed`). | `R371`, `R372`, `R397` |
| WP4 plan (`WP4-plan-review.md`, `-retest.md`, `-retest2.md`, `-retest3.md`) | `R401`–`R421` | 21 | 2 / 14 / 5 / 0 | Retest: `R401`–`R416` fixed and suggestions taken up; retest2: `R417`–`R420` fixed; retest3: `"R421 is fixed"`. PR #25. | — |
| WP4 4a (`WP4-4a-review-fixes.md`) | `R422`–`R462` | 41 | 10 / 23 / 8 / 0 | WP4-4b-prompt: `"R422–R462 are fixed"` (`R430` explicitly left as a follow-up). PRs #26–#29. | `R430` |
| WP4 4b (`WP4-4b-prompt.md`, `WP4-4b-review-fixes.md`, `WP4-4a-ci-fix.md`, `WP4-4b-retest-fixes.md` to `-retest3-fixes.md`) | `R463`–`R479` | 17 | 9 / 8 / 0 / 0 | 4b review: `R463`, `R464` fixed; retests: `R465`–`R468`, `R472`, `R474`, `R477` fixed; `R478` → `R479`. 4c review: `"all of 4b merged (PRs #30–#34)"`. | — |
| WP4 4c (`WP4-4c-review-fixes.md`) | `R480`–`R483` | 4 | 1 / 3 / 0 / 0 | Fix commits `1832d4f`, `1456ecd` on `develop` (`R480` caller clock also covered by Session 2 sweep 9). No re-check file. | — |
| S0-11b deployment (`S0-11b-deployment-review-fixes.md`, `azure-deployment-log.md`) | `R484`–`R485` | 2 | 1 / 1 / 0 / 0 | `R484` resolved per `azure-deployment-log.md:96-99` (pending Session 4 owner live Azure confirmation); `R485` live verification recorded in `stage-0-plan.md` change log (18 Nov) and PR #53 (`d9d1bca`). | — |
| WP5 Phase 0 ADRs (`WP5-phase0-review-fixes.md`) | `R486`–`R494` | 9 | 0 / 9 / 0 / 0 | `1265267` `"address WP5 Phase 0 review fixes (R486–R494, S1–S3)"`, PR #39. No re-check file. | — |
| WP5 5a (`WP5-5a-review-fixes.md`) | `R495`–`R497` | 3 | 0 / 3 / 0 / 0 | `"Re-review, 16 November 2026: passed"` (`R495`–`R497`, S1, S2 closed). PR #44. | — |
| WP5 5c (`WP5-5c-review-fixes.md`) | `R498`–`R500` | 3 | 0 / 3 / 0 / 0 | Re-review: `R498`, `R499` closed. `R500` test on `develop` (`core/tests/email-notifications-s026.test.ts:1557`); PR #49. No re-check of `R500`. | — |
| PRs #54–#56 (`Stage0-PRs-54-56-review.md`) | `R502`–`R507` | 6 | 0 / 3 / 2 / 1 | PRs #54, #55, #56 merged; `R507` became `B16`, fixed in PR #57 (`Completed`). No re-check file. | — |
| Exit session 1 (`Stage0-exit-session1-safe.md`, `-fixes.md`, `-fixes-review.md`, `-fixes-round2.md`) | `R508`–`R574` (`R517` unused) | 66 | 9 / 34 / 23 / 0 | Fixes review + Round 2: `R508`–`R571`, `R573`–`R574` fixed (`Verdict: approved to merge`, PRs #58–#63); `R572` covered by a Help note with backfill deferred. | `R572` |
| Exit session 2 (`Stage0-exit-session2-solid.md`, `-fixes.md`, `-fixes-round2.md`, `-round3.md`, `-round4.md`, AG reports, `-merge-report.md`) | `R575`–`R642` | 68 | 6 / 54 / 8 / 0 | Round 2 / 3 / 4 reviews list each item fixed (`Result 21 Nov: R635–R642 are fixed… Verdict: approved to merge`, PRs #64–#68 `2a5c801`…`8949aa5`). `R598` `ctx.jobPermissions` sub-item closed by `R637`. | `R582`, `R583`, `R597`, `R598`, `R639` |
| Exit session 3 (`Stage0-exit-session3-shared.md`) | `R643`–`R654` | 12 | 0 / 11 / 1 / 0 | Fixed, fail-first + two-tenant PostgreSQL tested, documented, and audited across stacked branches `fix/s0-shared-rates-and-org` (`D9 = (a)`), `fix/s0-shared-notifications-and-signoffs`, and `docs/s0-shared-backlog-and-help` (`D10 = accept`). | — |

## Exceptions (`12` total, all recorded in backlog / stage plan)

Every R-ID that is carried, deferred, or partly done is listed below alongside its permanent backlog location (`0` unrecorded items).

| R-ID | Source file | Severity | Title | Current status | Recorded in backlog |
|---|---|---|---|---|---|
| `R206` | `SharepointReview-Fixes-Round2.md:129` | Suggestion | Health result is stored in the mock backend (`MockSharePointGraphBackend.healthCache`) | Deferred `"before a real Graph backend replaces the mock"`. Still in `core/src/integrations/document-stores/mockSharePointGraph.ts:144`. | `docs/roadmap/feature-list.md` row `10` ("What's missing"); `docs/decisions/0023-sharepoint-sites-selected-least-privilege.md` §3 item 4 (`:159`) |
| `R236` | `S0-01-review-fixes.md:88` | Suggestion (note only) | Unlimited calls to the paid address lookup | Carried: per-tenant rate limits. | `docs/roadmap/stage-0-plan.md` §3 "Before the first hosted client" (`per-tenant rate limits (8.12)`); cross-referenced in `docs/roadmap/feature-list.md` `P8` |
| `R371` | `WP3-retest2-fixes.md:154` | Should fix | Record the deferred items | Address lookup `GET`→`POST` + multi-premise picker carried to Stage 1; tenant `timeZone` added in `S0-19`; `PLATFORM_ENVIRONMENT` check done in `S0-13b`. | `docs/roadmap/feature-list.md` row `34` (`R371`), `F8` (`tenantConfig.timeZone`), `P12`/`E8` (done) |
| `R372` | `WP3-retest2-fixes.md:162` | Suggestion | S0-10 as-at date follow-ups | Required parts done; two optional parts deferred (`src/server/financeServices.ts:432, 625` clean-path `importedAt` still falls back to `new Date()`, and no explicit `asAtAvailable` boolean flag). | `docs/roadmap/feature-list.md` row `26` ("What's missing") |
| `R397` | `WP3-retest4-fixes.md:68` | Suggestion | WP3 follow-up PR list (`verify-no-demo-literals.mjs:19` skips silently when workbook missing; `seed-demo-tenant.ts:192-197` wraps `readFileSync` inside `JSON.parse` `try`, plus remaining WP3 polish) | Open post-Stage-0 hardening follow-up. | `docs/roadmap/feature-list.md` `P6` ("Action") |
| `R430` | `WP4-4a-review-fixes.md:128` | Suggestion | Remove the test-only `recorder?` parameters from telemetry | Still present (`core/src/observability/telemetry.ts:370, 395, 439, 494, 549`). | `docs/roadmap/feature-list.md` `P12` ("Action") |
| `R572` | `Stage0-exit-session1-fixes-round2.md:51` | Suggestion | Matters imported before `494d565` (and seed / `pms:import` paths) never get `isPmsImport`, so show `"Not started"` | Covered by `matter-opening-and-risk` Help note; optional backfill deferred. | `docs/roadmap/feature-list.md` row `35` ("What's missing") and `P6` ("Action") |
| `R582` | `Stage0-exit-session2-solid.md:189` | Should fix | The PDF converter is in Bicep only (`Stage 0 exit decision D5`) | Stage 0 uses `BuiltInOpenXmlPdfConverter` (`ADR 0024`); disabled `ca-pdf` scaffold (`enablePdfConverterContainerApp: false`) carried. | `docs/roadmap/feature-list.md` item `46` ("Dedicated PDF converter container", Stage 1, Not started) & `E5` |
| `R583` | `Stage0-exit-session2-solid.md:193` | Should fix | PMS money is held as floating-point pounds (sweep 11; `Stage 0 exit decision D6`) | Carried to Stage 1 (`B21`). | `docs/roadmap/feature-list.md` `B21` (Stage 1, Not started) & `stage-0-plan.md` §9 |
| `R597` | `Stage0-exit-session2-solid.md:296` | Suggestion | Catalogue reads merge in `src/seed` lists and defaults at runtime (`services.ts`), so values a tenant deletes come back | Deferred to Stage 1+ catalogue refactor. | `docs/roadmap/feature-list.md` row `29` ("What's missing") & `P2` ("Action") |
| `R598` | `Stage0-exit-session2-solid.md:297` | Suggestion | Other small items (`10` sub-items) | Closed sub-items: dead default (`EnquiryProfileClient.tsx:121-126` uses `systemKey`), `DEMO_DATA_LIVE_FORBIDDEN` live guards (`two-tenant-jobs-s0-solid.test.ts:1089`), `ctx.jobPermissions` (`R637`, `services.ts:23155`), and ADRs 0027/0030 alignment. Remaining open sub-items: (1) tenant ID ~40-char cap (`tenantRegistry.ts:81`), (2) forcing outbound `message.from` to `email.senderAddress` rather than caller precedence (`core/src/integrations/email/adapters.ts:476`), (3) excluding seed JSON and PMS workbook from live `Dockerfile:37-38` images, (4) removing the hard-coded demo vault name from `client-not-a-law-firm/config/environments/demo.json`, (5) `billing_basis` `systemKey`s (`src/seed/lists.ts:330`), and (6) extension hook CPU budget (`core/src/extension-host/index.ts`). | `docs/roadmap/feature-list.md` rows `29`, `32`, `P6`, and `P8` |
| `R639` | `Stage0-exit-session2-fixes-round4.md:80` | Should fix (record only) | Calendar sync lease gaps `(a)`–`(e)` go to the Outlook sync backlog item | Carried: conditions for building the real Microsoft Graph adapter. | `docs/roadmap/feature-list.md` row `8` ("What's missing": `R639` (a)–(e)) |

### Recent Session 3 closures of prior un-checked / unknown items

- **`R312` (`WP2-retest5-fixes.md:26`, Blocking):** Re-checked in Session 3 (`Stage0-exit-session3-shared.md:211`) and confirmed fixed on `develop`: no `conflictWarning` URL parameter remains in source or tests. Moved from un-re-checked (`42` → `41`) to **Closed (verified)**.
- **`R396` (`WP3-retest4-fixes.md:62`, Suggestion):** Verified closed on `develop`: `R382` tests (`core/tests/rbac.test.ts:8460-8515`) query PostgreSQL directly (`getPartyRepository()`) without reading cached stores; `Entra ID OIDC Sign-In` (`src/server/services.ts:20688-20690` and `rbac.test.ts:8457-8494`) omits `oid=`; correlation-ID validation closed under `R399` (`src/server/correlationId.ts`). Moved from Exceptions (`13` → `12`) to **Closed (verified)**.

### Closed (merged, re-check not on file) — 41 IDs

| R-IDs | Severity mix | Evidence on `develop` |
|---|---|---|
| `R210`–`R212` | 3 Sg | `0f7471b`, PR #3 |
| `R213`–`R225`, `R228` | 8 S / 6 Sg | `f0e64e9`, `a0a5534`, PR #5; `docs/release-notes.md` cites `R213`–`R225`, `R228` |
| `R398`, `R399`, `R400` | 2 S / 1 Sg | PR #24; `docs/release-notes.md` cites `R398`; `src/server/correlationId.ts` (`R399`); `deny` helper `src/server/services.ts` and `opts.mfaVerified` (`R400`) |
| `R480`–`R483` | **1 Blocking** / 3 S | `1832d4f`, `1456ecd`; `docs/release-notes.md` cites `R480`–`R483` (`R480` caller-supplied clock also covered by Session 2 sweep 9) |
| `R484` | **1 Blocking** | Directory-role removal recorded in `PlanReviews/azure-deployment-log.md:96-99` (Azure-side change; also on Session 4 owner live checklist) |
| `R486`–`R494` | 9 S | `1265267`, PR #39 (`ADRs 0032`–`0035` Accepted) |
| `R500` | 1 S | Test `core/tests/email-notifications-s026.test.ts:1557`; PR #49 |
| `R502`–`R507` | 3 S / 2 Sg / 1 follow-up | PRs #54–#57; `docs/roadmap/feature-list.md` rows `34`, `B14`, `B16` updated |

## Gaps in numbering

| R-IDs | Finding |
|---|---|
| `R1`–`R189` | Defined during the 3–5 November 2026 architecture review before `C:\1Squared\PlanReviews\` existed. **Closed under Owner Decision `D10` (21 November 2026):** `R75`–`R189` each fall in a `"resolve re-test N findings (R…)"` commit (`95272b0`, `9d1c0de`, `28a58d1`, `651b85d`, `5072830`, `b2ac080`, `8089209`, `1677820`, `0bdd041`, `d1c0013`, `ecf5265`, `6391fc0`, `c426f42`, `761244e`, `44b9d05`, `5d7c001`, `4c5b486`) merged in PR #1 (`c7ee9e7`), and 65 of `R1`–`R74` are cited in tests or code comments on `develop`. The nine untraceable IDs (`R26`, `R46`, `R64`, `R65`, `R66`, `R67`, `R68`, `R69`, `R72`) are formally recorded under `D10` as **`"closed by PR #1, definition not retained"`**. Subsequent full-codebase exit reviews (Sessions 1–3) re-audited the whole codebase. |
| `R227` | Not defined anywhere (the interactive-testing list jumps `R226` → `R228`; never issued). |
| `R501` | Not defined anywhere (`WP5-5c-review-fixes.md:112` set `"Next free R-ID: R501"`; next review started at `R502`). |
| `R517` | Deliberately unused: `"R517 and R526–R527 aren't used: the owner decisions D1–D3 above replace them"` (`Stage0-exit-session1-safe.md:247`). `R526`–`R527` were later reissued in `Stage0-exit-session1-fixes.md` and closed. |

## Named deferred follow-ups (non-R-ID)

| Follow-up | Origin | Status | Where recorded |
|---|---|---|---|
| `B14` Document Generation permission keys | Exit plan step 5; out of scope in WP4 4b/4c | Fixed, PR #55 (`R503`, `R505`) | `docs/roadmap/feature-list.md` `B14` (`Completed`) |
| `B16` Document Generation settings MFA / policy key | `R507` | Fixed, PR #57 | `docs/roadmap/feature-list.md` `B16` (`Completed`) |
| `B21` PMS float money | `R583` / Stage 0 exit decision `D6` | Carried to Stage 1 | `docs/roadmap/feature-list.md` `B21` (Stage 1, Not started); `stage-0-plan.md` §9 |
| S0-28a money follow-ups | WP5-5a S2; WP5-5b S1 | 5a S2 and 5b S1 (`302ba03`) closed; remaining float paths are PMS only → `B21` | `docs/roadmap/feature-list.md` `B21` |
| Dedicated PDF converter container | `R582` / Stage 0 exit decision `D5` | Carried | `docs/roadmap/feature-list.md` item `46` (Stage 1, Not started) |
| `R371` deferred items (address lookup `POST`, tenant `timeZone`, `PLATFORM_ENVIRONMENT`) | WP3 retest 2 | Address lookup and `timeZone` carried; `PLATFORM_ENVIRONMENT` done | `docs/roadmap/feature-list.md` row `34`, `F8`, `P12`/`E8` |
| Outlook sync lease gaps `(a)`–`(e)` | `R639` | Carried; conditions for real adapter | `docs/roadmap/feature-list.md` row `8` ("What's missing") |
| `"Before the first hosted client"` list (`azure-blob` + SAS + Defender per Stage 0 exit decision `D4` / ADR 0008; shared multi-tenant web compute per ADR 0036; CI-built promoted image; extension import lint & wider client-name check; schema `description`/`default` lint; backup/restore; offboarding; rate limits; per-tenant keys; break-glass; sign-in/export audit; release tags & `training`; dependency scanning & SAST; runbooks, budgets & dashboards; pen test) | `docs/roadmap/stage-0-plan.md` §3, extended by `R595` | Carried (pre-hosted-client prerequisites) | `docs/roadmap/stage-0-plan.md` §3 and linked from `docs/roadmap/feature-list.md` `P2`, `P8`, `P12`, and `R236` |
| `job_runs` `'partial'` status (`partial` runs record `status = 'running'`, `summary_json.scope = 'partial'`, and `finished_at`; consider additive `'partial'` status) | Session 2 Round 4 Result | Stage 1 suggestion | `docs/roadmap/feature-list.md` `P9` ("Action") |
| `R636` admin warning de-duplication keyed on stable key rather than title text | Session 2 Round 4 Result | Open Stage 1 polish | `docs/roadmap/feature-list.md` row `1` ("What's missing") |
| `ADR 0023` §3 open items (3 live Microsoft 365 confirmations plus `R206` health cache) | SharePoint round 2 PR checklist | Open (before live SharePoint backend) | `docs/roadmap/feature-list.md` row `10` ("What's missing") & `docs/decisions/0023-sharepoint-sites-selected-least-privilege.md` §3 |
| WP2 review unnumbered suggestions (`WP2-review-fixes.md:216-244`) | WP2 review | Remainder closed (`S0-06`, `S0-07`, `S0-09`, `S0-12`); remaining `S0-04`/`S0-05` leaver-party & non-restricted-matter SharePoint re-permissioning items open | `docs/roadmap/feature-list.md` rows `13` and `35` ("What's missing") |
| WP4 4c `S1`–`S3`, WP5 Phase 0 `S1`–`S3`, WP5 5a `S1`–`S2`, 5b `S1`–`S2` | 4c / Phase 0 / 5a / 5b reviews | Closed (`1832d4f`, `1456ecd`, `1265267`, `302ba03`) | Closed (historical) |
| `P5` Ideal Postcodes test key not rotated | Owner agreed exception (18 Nov 2026) | Agreed exception with standing conditions | `docs/roadmap/feature-list.md` `P5`; `docs/roadmap/stage-0-plan.md` §8 & §9 (18 Nov) |
| Session 4 owner live checklist (`R484` directory role confirmation, action-group email check, **Load demo dataset** as admin, test enquiry team routing check) | Session 2 / Session 3 merge & deploy | Owner manual verification pending on live Azure demo | `docs/roadmap/stage-0-plan.md` §8 & Session 4 owner live checklist |

## Appendix: per-ID index (`R190`–`R654`)

Generated from the first definition of each ID. Titles are truncated; "Closed (PRs …)" means the round's approval section plus the listed merges (see the summary table). Severity is taken from the inline label or enclosing heading.

| R-ID | Severity | Defined in | Title (truncated) | Status |
|---|---|---|---|---|
| R190 | Blocking | SharepointReview-Fixes.md:14 | Config design uses a schema that doesn't exist | Closed (PR #2) |
| R191 | Blocking | SharepointReview-Fixes.md:21 | Changing the default breaks existing tenants | Closed (PR #2) |
| R192 | Blocking | SharepointReview-Fixes.md:34 | Config can't enforce least privilege | Closed (PR #2) |
| R193 | Should fix | SharepointReview-Fixes.md:49 | Endpoint inventory hasn't been tested against Microsoft | Closed (PR #2) |
| R194 | Should fix | SharepointReview-Fixes.md:61 | The role check may itself need a broad permission | Closed (PR #2) |
| R195 | Should fix | SharepointReview-Fixes.md:67 | "Startup" checks conflict with tenancy | Closed (PR #2) |
| R196 | Should fix | SharepointReview-Fixes.md:78 | Drop allowedSiteIds and enforce the store's own site instead | Closed (PR #2) |
| R197 | Should fix | SharepointReview-Fixes.md:84 | Don't add SharePoint-specific error codes to the public API | Closed (PR #2) |
| R198 | Should fix | SharepointReview-Fixes.md:91 | Error message exposes configuration to users | Closed (PR #2) |
| R199 | Should fix | SharepointReview-Fixes.md:96 | Required permission set is incomplete | Closed (PR #2) |
| R200 | Should fix | SharepointReview-Fixes.md:102 | Rollback and hosting-model steps are missing | Closed (PR #2) |
| R201 | Suggestion | SharepointReview-Fixes.md:113 | Enforce the /search/query ban with a test that greps sharepointProvider.ts, | Closed (PR #2) |
| R202 | Suggestion | SharepointReview-Fixes.md:114 | data/pembroke-vaughan.json has no delegatedPermissionScope. Only client-not | Closed (PR #2) |
| R203 | Suggestion | SharepointReview-Fixes.md:115 | If the admin panel can change delegatedPermissionScope, that change must re | Closed (PR #2) |
| R204 | Suggestion | SharepointReview-Fixes.md:116 | ADR wording: "Defense" should be "Defence", deciders should be named roles, | Closed (PR #2) |
| R205 | Should fix | SharepointReview-Fixes-Round2.md:23 | / Should fix / Yes. This blocks the merge. / | Closed (PR #2) |
| R206 | Suggestion | SharepointReview-Fixes-Round2.md:24 | / Suggestion / No. Add a note to the ADR only (see R206). / | EXCEPTION: deferred (feature-list row 10 & ADR 0023 §3) |
| R207 | Suggestion | SharepointReview-Fixes-Round2.md:25 | / Suggestion / Yes. Small, and the code was added on this branch. / | Closed (PR #2) |
| R208 | Suggestion | SharepointReview-Fixes-Round2.md:26 | / Suggestion / Yes. Docs wording only. / | Closed (PR #2) |
| R209 | Suggestion | SharepointReview-Fixes-Round2.md:27 | / Suggestion / Yes. Two unused imports. / | Closed (PR #2) |
| R210 | Suggestion | LocalCiParity-Fixes.md:37 | CI doesn't run on push for chore/ and fix/ branches | Closed (merged; re-check not on file) |
| R211 | Suggestion | LocalCiParity-Fixes.md:45 | npm run ci doesn't check the Node version | Closed (merged; re-check not on file) |
| R212 | Suggestion | LocalCiParity-Fixes.md:65 | CLAUDE.md is out of date with the CI steps | Closed (merged; re-check not on file) |
| R213 | Should fix | interactive_testing_review_fixes.md:73 | Dev signing key is a literal in the repo | Closed (merged; re-check not on file) |
| R214 | Should fix | interactive_testing_review_fixes.md:98 | Admin "preview any role" contradicts ADR 0013 | Closed (merged; re-check not on file) |
| R215 | Should fix | interactive_testing_review_fixes.md:119 | Undefined role key 'system_admin' | Closed (merged; re-check not on file) |
| R216 | Should fix | interactive_testing_review_fixes.md:145 | Fix-list item 1.4 is only partly fixed | Closed (merged; re-check not on file) |
| R217 | Should fix | interactive_testing_review_fixes.md:168 | The store repair overwrites admin-added taxonomy values | Closed (merged; re-check not on file) |
| R218 | Should fix | interactive_testing_review_fixes.md:192 | Help articles contradict the key dates rule | Closed (merged; re-check not on file) |
| R219 | Should fix | interactive_testing_review_fixes.md:203 | The KPI and To Do panel use a third copy of the task logic | Closed (merged; re-check not on file) |
| R220 | Suggestion | interactive_testing_review_fixes.md:248 | Key dates exceptions report wording | Closed (merged; re-check not on file) |
| R221 | Suggestion | interactive_testing_review_fixes.md:257 | Pass only the session fields the shell needs | Closed (merged; re-check not on file) |
| R222 | Suggestion | interactive_testing_review_fixes.md:267 | Contrast fix is wider than needed, and the release note is inaccurate | Closed (merged; re-check not on file) |
| R223 | Suggestion | interactive_testing_review_fixes.md:281 | Fragile parsing of party roles and stage status | Closed (merged; re-check not on file) |
| R224 | Suggestion | interactive_testing_review_fixes.md:300 | Filter <select> elements in the list views have no id or name | Closed (merged; re-check not on file) |
| R225 | Suggestion | interactive_testing_review_fixes.md:314 | Remaining items from fix-list 3.2.1 and 3.4 | Closed (merged; re-check not on file) |
| R226 | Unlabelled (Part C) | interactive_testing_review_fixes.md:333 | Finance data is sent to every user's Home page | Closed via S0-10 (PR #20) |
| R227 | — | — | — | Gap: not defined anywhere |
| R228 | Should fix | interactive_testing_review_fixes.md:227 | The session token is sent to the browser, and the cookie is written twice | Closed (merged; re-check not on file) |
| R229 | Should fix | S0-01-review-fixes.md:22 | Verify the gitleaks download in CI | Closed (PR #9) |
| R230 | Should fix | S0-01-review-fixes.md:32 | Add tenant and correlation IDs to the "not configured" log | Closed (PR #9) |
| R231 | Should fix | S0-01-review-fixes.md:41 | Use the same gitleaks version locally and in CI | Closed (PR #9) |
| R232 | Suggestion | S0-01-review-fixes.md:57 | One helper for reading server secrets | Closed (PR #9) |
| R233 | Suggestion | S0-01-review-fixes.md:63 | Remove the provider-format fallback in the browser helper | Closed (PR #9) |
| R234 | Suggestion | S0-01-review-fixes.md:68 | Limit the gitleaks placeholder allow-list to the test files | Closed (PR #9) |
| R235 | Suggestion | S0-01-review-fixes.md:78 | Automate the bundle check | Closed (PR #9) |
| R236 | Suggestion | S0-01-review-fixes.md:88 | Unlimited calls to the paid lookup (note only) | EXCEPTION: carried (stage-0-plan.md §3 & feature-list P8) |
| R237 | Should fix | WP1-prompt.md:27 | (Should fix): validate the client-supplied correlation ID | Closed (PR #9) |
| R238 | Suggestion | WP1-prompt.md:33 | (Suggestion): use the same bundle check pattern in CI and locally | Closed (PR #9) |
| R239 | Blocking | WP1-review-fixes.md:29 | Make the WP1 branches merge cleanly, in order | Closed (PRs #9–#12) |
| R240 | Should fix | WP1-review-fixes.md:55 | Add the e2e job to GitHub CI (S0-27) | Closed (PRs #9–#12) |
| R241 | Should fix | WP1-review-fixes.md:61 | Remove the policyOverride parameter from the wrappers (S0-02) | Closed (PRs #9–#12) |
| R242 | Should fix | WP1-review-fixes.md:71 | Don't invent risk answers for matters created without the questionnaire (S0 | Closed (PRs #9–#12) |
| R243 | Suggestion | WP1-review-fixes.md:91 | Don't run e2e against an old build (S0-27) | Closed (PRs #9–#12) |
| R244 | Suggestion | WP1-review-fixes.md:96 | Unit test for the left-menu key dates rule (S0-27) | Closed (PRs #9–#12) |
| R245 | Suggestion | WP1-review-fixes.md:100 | Limit the length of follow-up answers (S0-08) | Closed (PRs #9–#12) |
| R246 | Suggestion | WP1-review-fixes.md:104 | Record who actually completed the risk assessment (S0-08) | Closed (PRs #9–#12) |
| R247 | Blocking | WP1-retest-fixes.md:23 | (Blocking for S0-08): role journeys fail under parallel workers on s0-08-ri | Closed (PRs #9–#12) |
| R248 | Should fix | WP1-retest2-fixes.md:37 | (Should fix, S0-08): the risk assessment panel shows "Low risk" for questio | Closed (PRs #9–#12) |
| R249 | Should fix | WP1-retest2-fixes.md:55 | (Should fix, S0-08): the tenant config cache has no tests | Closed (PRs #9–#12) |
| R250 | Suggestion | WP1-retest2-fixes.md:66 | (Suggestion, S0-08): make the cached config read-only | Closed (PRs #9–#12) |
| R251 | Suggestion | WP1-retest2-fixes.md:75 | (Suggestion, S0-27): mode: 'serial' on the enquiries coordinator journey do | Closed (PRs #9–#12) |
| R252 | Blocking | WP2-review-fixes.md:32 | (S0-03 and S0-05): a caller can switch off the contact permission checks | Closed (PRs #13–#19) |
| R253 | Should fix | WP2-review-fixes.md:105 | "Clear all data" leaves the user on a 405 page. | Closed (PRs #13–#19) |
| R254 | Blocking | WP2-review-fixes.md:48 | (S0-07): quote conversion overwrites an organisation's existing conflict st | Closed (PRs #13–#19) |
| R255 | Should fix | WP2-review-fixes.md:157 | quote conversion blocks more than matter save does. | Closed (PRs #13–#19) |
| R256 | Should fix | WP2-review-fixes.md:161 | the redacted conflict hit still carries the real matter ID. | Closed (PRs #13–#19) |
| R257 | Should fix | WP2-review-fixes.md:164 | saving an enquiry drops restricted hits silently. | Closed (PRs #13–#19) |
| R258 | Should fix | WP2-review-fixes.md:167 | conflict decisions are audited with the wrong action. | Closed (PRs #13–#19) |
| R259 | Should fix | WP2-review-fixes.md:171 | the link searches will get slow as data grows. | Closed (PRs #13–#19) |
| R260 | Should fix | WP2-review-fixes.md:174 | the S0-07 two-tenant test proves nothing. | Closed (PRs #13–#19) |
| R261 | Should fix | WP2-review-fixes.md:140 | the AI panel shows when extraction is switched off. | Closed (PRs #13–#19) |
| R262 | Should fix | WP2-review-fixes.md:150 | the docs don't match the code. | Closed (PRs #13–#19) |
| R263 | Should fix | WP2-review-fixes.md:144 | same tenant, different user: the cache misses | Closed (PRs #13–#19) |
| R264 | Blocking | WP2-review-fixes.md:59 | (S0-05): saving an enquiry skips the assign, close and reopen checks, so B8 | Closed (PRs #13–#19) |
| R265 | Should fix | WP2-review-fixes.md:110 | success messages are shown when an action is refused. | Closed (PRs #13–#19) |
| R266 | Should fix | WP2-review-fixes.md:115 | the test for moving a walled matter off a leaver doesn't check the SharePoi | Closed (PRs #13–#19) |
| R267 | Should fix | WP2-review-fixes.md:118 | the organisation, link and delete-link permission checks | Closed (PRs #13–#19) |
| R268 | Should fix | WP2-review-fixes.md:129 | saving a task assigns its linked enquiries that aren't routed yet. | Closed (PRs #13–#19) |
| R269 | Should fix | WP2-review-fixes.md:132 | the help article lists the wrong roles. | Closed (PRs #13–#19) |
| R270 | Should fix | WP2-review-fixes.md:135 | the leaver report and the reassignment disagree on tasks. | Closed (PRs #13–#19) |
| R271 | Blocking | WP2-review-fixes.md:72 | (S0-09): the merge signs its own admin session with MFA marked as verified | Closed (PRs #13–#19) |
| R272 | Blocking | WP2-review-fixes.md:87 | (S0-09): the merge isn't one operation | Closed (PRs #13–#19) |
| R273 | Should fix | WP2-review-fixes.md:179 | link de-duplication ignores isCurrent. | Closed (PRs #13–#19) |
| R274 | Should fix | WP2-review-fixes.md:183 | core changes aren't documented. | Closed (PRs #13–#19) |
| R275 | Should fix | WP2-review-fixes.md:187 | the S0-09 tests are weak. | Closed (PRs #13–#19) |
| R276 | Should fix | WP2-review-fixes.md:192 | the settings usage test can be passed without a setting being used. | Closed (PRs #13–#19) |
| R277 | Should fix | WP2-review-fixes.md:200 | the reserved settings list can drift from the schema. | Closed (PRs #13–#19) |
| R278 | Should fix | WP2-review-fixes.md:203 | out-of-scope changes aren't documented. | Closed (PRs #13–#19) |
| R279 | Should fix | WP2-review-fixes.md:210 | the matter costs sign-off returns the wrong refusal format. | Closed (PRs #13–#19) |
| R280 | Should fix | WP2-retest-fixes.md:63 | (R258 follow-up): two conflict audit sites still use 'duplicate'. | Closed (PRs #13–#19) |
| R281 | Should fix | WP2-retest-fixes.md:39 | (R260, R267 and R275 follow-up): the two-tenant tests still only prove "not | Closed (PRs #13–#19) |
| R282 | Should fix | WP2-retest-fixes.md:80 | (R272 follow-up): the document repository can get out of step with the stor | Closed (PRs #13–#19) |
| R283 | Should fix | WP2-retest-fixes.md:93 | (R276 follow-up): code added only so the usage test passes. | Closed (PRs #13–#19) |
| R284 | Should fix | WP2-retest-fixes.md:102 | "reviewed by" is never recorded. | Closed (PRs #13–#19) |
| R285 | Should fix | WP2-retest-fixes.md:109 | allowManualEntry: false has a new, unannounced effect. | Closed (PRs #13–#19) |
| R286 | Should fix | WP2-retest-fixes.md:115 | (R276 follow-up): the usage test is still easy to pass. | Closed (PRs #13–#19) |
| R287 | Should fix | WP2-retest-fixes.md:124 | the audit is wrong when approval isn't required. | Closed (PRs #13–#19) |
| R288 | Should fix | WP2-retest-fixes.md:129 | (R277 follow-up): reserved settings under a $ref are missed. | Closed (PRs #13–#19) |
| R289 | Should fix | WP2-retest-fixes.md:136 | (R278 follow-up): changes not documented. | Closed (PRs #13–#19) |
| R290 | Should fix | WP2-retest-fixes.md:68 | (R256 follow-up): the redacted matter ID can be recovered. | Closed (PRs #13–#19) |
| R291 | Should fix | WP2-retest-fixes.md:55 | (R263 follow-up): the hidden-enquiry test has no positive control. | Closed (PRs #13–#19) |
| R292 | Should fix | WP2-retest-fixes.md:27 | (R264 follow-up): the R264 tests can pass for the wrong reason. | Closed (PRs #13–#19) |
| R293 | Suggestion | WP2-retest-fixes.md:148 | S0-05: | Closed (PRs #13–#19) |
| R294 | Should fix | WP2-retest2-fixes.md:77 | (regression from R285): manual-entry rule can be bypassed. | Closed (PRs #13–#19) |
| R295 | Should fix | WP2-retest2-fixes.md:90 | (R284 remainder): the client sets the review date. | Closed (PRs #13–#19) |
| R296 | Should fix | WP2-retest2-fixes.md:66 | (R282 remainder): the core API change isn't documented, the restore can wip | Closed (PRs #13–#19) |
| R297 | Should fix | WP2-retest2-fixes.md:50 | (new in R293): a name match blocks a different organisation. | Closed (PRs #13–#19) |
| R298 | Should fix | WP2-retest2-fixes.md:26 | (R281 S0-05 remainder): positive controls cover 6 of 20 actions, and the te | Closed (PRs #13–#19) |
| R299 | Should fix | WP2-retest2-fixes.md:37 | (R293 S0-05 remainder): the closed-enquiry test doesn't check that the task | Closed (PRs #13–#19) |
| R300 | Should fix | WP2-retest2-fixes.md:42 | (R291 remainder): the positive control uses a different name. | Closed (PRs #13–#19) |
| R301 | Should fix | WP2-retest2-fixes.md:99 | (R283 remainder): the reserved settings point to slices that don't cover th | Closed (PRs #13–#19) |
| R302 | Should fix | WP2-retest2-fixes.md:111 | (R288 remainder): a reserved list setting is reported once per child field. | Closed (PRs #13–#19) |
| R303 | Should fix | WP2-retest2-fixes.md:117 | (R286 remainder): two scope anchors let anything through. | Closed (PRs #13–#19) |
| R304 | Suggestion | WP2-retest2-fixes.md:129 | S0-05: the leaver report shows "Assigned person (assignedPersonIds)" to use | Closed (PRs #13–#19) |
| R305 | Suggestion | WP2-retest2-fixes.md:137 | Earlier WP2 suggestions still apply and can go to a follow-up PR. | Closed (PRs #13–#19) |
| R306 | Should fix | WP2-retest3-fixes.md:74 | (R294 remainder): superseding a carried-over or extracted key date skips th | Closed (PRs #13–#19) |
| R307 | Should fix | WP2-retest3-fixes.md:30 | (R297 remainder): enquiry conversion has no declined-organisation rule, and | Closed (PRs #13–#19) |
| R308 | Should fix | WP2-retest3-fixes.md:48 | (R304 S0-07 remainder): some client conflict searches still use the default | Closed (PRs #13–#19) |
| R309 | Should fix | WP2-retest3-fixes.md:62 | (new in R296): a failed merge can hide its original error. | Closed (PRs #13–#19) |
| R310 | Suggestion | WP2-retest3-fixes.md:89 | S0-05: | Closed (PRs #13–#19) |
| R311 | Should fix | WP2-retest4-fixes.md:24 | conversion warnings never reach the user. | Closed (PRs #13–#19) |
| R312 | Blocking | WP2-retest5-fixes.md:26 | conflict warnings are passed in the URL. | Closed (PR #17; re-checked fixed in Session 3) |
| R313 | Blocking | WP3-review-fixes.md:55 | getStore() still writes demo branding into the store, and now it does so in | Closed (PRs #20–#22) |
| R314 | Should fix | WP3-review-fixes.md:76 | unlinked PMS matters skip the matter-access check. | Closed (PRs #20–#22) |
| R315 | Should fix | WP3-review-fixes.md:95 | the credit-control action trusts the client code and invoice number sent by | Closed (PRs #20–#22) |
| R316 | Should fix | WP3-review-fixes.md:107 | the finance help article gets the default grants wrong. | Closed (PRs #20–#22) |
| R317 | Should fix | WP3-review-fixes.md:119 | the finance tests don't pin the numbers or the rows. | Closed (PRs #20–#22) |
| R318 | Should fix | WP3-review-fixes.md:138 | a no-op added only to silence lint. | Closed (PRs #20–#22) |
| R319 | Should fix | WP3-review-fixes.md:142 | (S0-10 and S0-11a): fixed October 2026 figures are shown under the current  | Closed (PRs #20–#22) |
| R320 | Should fix | WP3-review-fixes.md:169 | (S0-11a and S0-11b): the release notes, help article and backlog describe c | Closed (PRs #20–#22) |
| R321 | Should fix | WP3-review-fixes.md:183 | fake "all clear" statuses are still shown. | Closed (PRs #20–#22) |
| R322 | Should fix | WP3-review-fixes.md:193 | the demo-literals check misses what it was written to catch. | Closed (PRs #20–#22) |
| R323 | Should fix | WP3-review-fixes.md:208 | the document-generation test asserts keys that don't exist. | Closed (PRs #20–#22) |
| R324 | Should fix | WP3-review-fixes.md:212 | cards labelled with the month count all-time totals. | Closed (PRs #20–#22) |
| R325 | Should fix | WP3-review-fixes.md:223 | invented defaults are still left. | Closed (PRs #20–#22) |
| R326 | Should fix | WP3-review-fixes.md:242 | the in-app reset wipes the --entra-map bindings. | Closed (PRs #20–#22) |
| R327 | Should fix | WP3-review-fixes.md:250 | the seed snapshot depends on the machine's timezone. | Closed (PRs #20–#22) |
| R328 | Should fix | WP3-review-fixes.md:258 | seed:demo loads frozen dates, and the two reset paths give different data. | Closed (PRs #20–#22) |
| R329 | Should fix | WP3-review-fixes.md:268 | a seeded key date breaks the four-eyes rule. | Closed (PRs #20–#22) |
| R330 | Should fix | WP3-review-fixes.md:276 | the seed data for spec 3c is thin, and one field holds the wrong value. | Closed (PRs #20–#22) |
| R331 | Should fix | WP3-review-fixes.md:286 | the runbook has errors (docs/runbooks/demo-deployment.md). | Closed (PRs #20–#22) |
| R332 | Should fix | WP3-review-fixes.md:292 | the new environment variable and the local demo setup aren't documented. | Closed (PRs #20–#22) |
| R333 | Should fix | WP3-review-fixes.md:299 | the flag-off denial test doesn't isolate its reason. | Closed (PRs #20–#22) |
| R334 | Should fix | WP3-review-fixes.md:309 | backlog statuses claim too much. | Closed (PRs #20–#22) |
| R335 | Suggestion | WP3-review-fixes.md:320 | S0-10: | Closed (PRs #20–#22) |
| R336 | Blocking | WP3-retest-fixes.md:44 | (R326 follow-up): resetting demo data can bind a real sign-in to a seeded a | Closed (PRs #20–#22) |
| R337 | Should fix | WP3-retest-fixes.md:67 | (R315 follow-up): the credit-control actions guess the matter from its numb | Closed (PRs #20–#22) |
| R338 | Should fix | WP3-retest-fixes.md:80 | (R319 follow-up): the as-at date still falls back to October 2026. | Closed (PRs #20–#22) |
| R339 | Should fix | WP3-retest-fixes.md:93 | "this year" and target figures count all time. | Closed (PRs #20–#22) |
| R340 | Should fix | WP3-retest-fixes.md:99 | (R319, s0-10 on its own): s0-10's Home still shows October. | Closed (PRs #20–#22) |
| R341 | Should fix | WP3-retest-fixes.md:109 | the finance help article names the wrong function. | Closed (PRs #20–#22) |
| R342 | Should fix | WP3-retest-fixes.md:114 | the SLA figure reads the latest contact as the first. | Closed (PRs #20–#22) |
| R343 | Should fix | WP3-retest-fixes.md:119 | (R324 follow-up): month-labelled panels still count all-time. | Closed (PRs #20–#22) |
| R344 | Should fix | WP3-retest-fixes.md:135 | (R319 follow-up): a few labels still don't match the figures. | Closed (PRs #20–#22) |
| R345 | Should fix | WP3-retest-fixes.md:140 | (R321 follow-up): risk filter and one remaining fake positive. | Closed (PRs #20–#22) |
| R346 | Should fix | WP3-retest-fixes.md:148 | (R322 follow-up): the demo-literal check can still be bypassed. | Closed (PRs #20–#22) |
| R347 | Should fix | WP3-retest-fixes.md:163 | (R325 follow-up): the privacy notice is still pre-ticked on the full enquir | Closed (PRs #20–#22) |
| R348 | Should fix | WP3-retest-fixes.md:167 | (R325 follow-up): an invented office fallback. | Closed (PRs #20–#22) |
| R349 | Should fix | WP3-retest-fixes.md:171 | (R335 claims): either do it or drop the claim. | Closed (PRs #20–#22) |
| R350 | Should fix | WP3-retest-fixes.md:176 | (R320 follow-up): s0-11a docs that don't match the code. | Closed (PRs #20–#22) |
| R351 | Should fix | WP3-retest-fixes.md:187 | (R330 follow-up): the conflicts panels were changed just to show seed data. | Closed (PRs #20–#22) |
| R352 | Should fix | WP3-retest-fixes.md:195 | (R330 follow-up): the other Home filter changes are real bug fixes, but unt | Closed (PRs #20–#22) |
| R353 | Should fix | WP3-retest-fixes.md:202 | (R330 follow-up): a seed change that does nothing, and a false panel claim. | Closed (PRs #20–#22) |
| R354 | Should fix | WP3-retest-fixes.md:207 | (R334): P6 is not Completed. | Closed (PRs #20–#22) |
| R355 | Should fix | WP3-retest-fixes.md:211 | (R320 follow-up): s0-11b docs that don't match the code. | Closed (PRs #20–#22) |
| R356 | Should fix | WP3-retest-fixes.md:218 | (R327 follow-up): the global UTC setting hides timezone bugs. | Closed (PRs #20–#22) |
| R357 | Suggestion | WP3-retest-fixes.md:232 | S0-10: | Closed (PRs #20–#22) |
| R358 | Should fix | WP3-retest2-fixes.md:37 | (R339 follow-up): "YTD" labels still show all-time figures. | Closed (PRs #20–#22) |
| R359 | Should fix | WP3-retest2-fixes.md:46 | (R338 follow-up): the importer's date logic has no tests. | Closed (PRs #20–#22) |
| R360 | Should fix | WP3-retest2-fixes.md:56 | (regression from R357): the London "now" is up to 24 hours in the future. | Closed (PRs #20–#22) |
| R361 | Should fix | WP3-retest2-fixes.md:68 | (R343 follow-up): the practice-area filter shows every enquiry in edge case | Closed (PRs #20–#22) |
| R362 | Should fix | WP3-retest2-fixes.md:83 | (R347 follow-up): the privacy notice isn't enforced on the server. | Closed (PRs #20–#22) |
| R363 | Should fix | WP3-retest2-fixes.md:90 | (R346 follow-up): remaining sanctions variants, and false positives. | Closed (PRs #20–#22) |
| R364 | Should fix | WP3-retest2-fixes.md:105 | (R350 follow-up): s0-11a docs. | Closed (PRs #20–#22) |
| R365 | Should fix | WP3-retest2-fixes.md:118 | (R351 follow-up, regression on s0-11a): the conflicts clause still ships on | Closed (PRs #20–#22) |
| R366 | Should fix | WP3-retest2-fixes.md:126 | (R357 follow-up): an arbitrary person in the self-approval check. | Closed (PRs #20–#22) |
| R367 | Should fix | WP3-retest2-fixes.md:131 | (R351 follow-up): legacy matters with an escalated conflict are missed. | Closed (PRs #20–#22) |
| R368 | Should fix | WP3-retest2-fixes.md:136 | (new): the corrupted-store error can write store content to the logs. | Closed (PRs #20–#22) |
| R369 | Should fix | WP3-retest2-fixes.md:142 | (R357 follow-up): the Key Vault rename isn't finished. | Closed (PRs #20–#22) |
| R370 | Should fix | WP3-retest2-fixes.md:149 | (R356 follow-up): test 14 leaves the process in New York time. | Closed (PRs #20–#22) |
| R371 | Should fix | WP3-retest2-fixes.md:154 | (R357 follow-up): record the deferred items. | Closed; items carried (rows 34, F8; P12/E8 done) |
| R372 | Suggestion | WP3-retest2-fixes.md:162 | S0-10: | EXCEPTION: optional parts carried (feature-list row 26) |
| R373 | High (pre-existing) | WP3-retest2-fixes.md:189 | (pre-existing, high severity): an employee persona can be taken over by edi | Closed (PRs #20–#22) |
| R374 | Should fix | WP3-retest3-fixes.md:42 | (R358 follow-up): client "Fees billed" is now year-to-date, but the screens | Closed (PRs #20–#22) |
| R375 | Should fix | WP3-retest3-fixes.md:57 | (R363 regression): the demo-literal guard's PMS client-code list is hard-co | Closed (PRs #20–#22) |
| R376 | Should fix | WP3-retest3-fixes.md:61 | (R362 follow-up): a legacy enquiry stored with privacyNoticeGiven: false ca | Closed (PRs #20–#22) |
| R377 | Should fix | WP3-retest3-fixes.md:69 | (R360 follow-up): the "SLA overdue" pill and the overdue count disagree. | Closed (PRs #20–#22) |
| R378 | Should fix | WP3-retest3-fixes.md:75 | (R364 follow-up): team_workload_and_utilisation still uses its own "as at"  | Closed (PRs #20–#22) |
| R379 | Should fix | WP3-retest3-fixes.md:80 | (R368 follow-up): the test can't fail, and one log site still echoes file c | Closed (PRs #20–#22) |
| R380 | Suggestion | WP3-retest3-fixes.md:166 | (WP3) | Closed (PRs #20–#22) |
| R381 | Should fix | WP3-retest3-fixes.md:94 | B13 is marked Completed, but the demo items are neither done nor recorded. | Closed (PR #24) |
| R382 | Should fix | WP3-retest3-fixes.md:101 | when a privileged link is refused, sign-in quietly creates a duplicate empl | Closed (PR #24) |
| R383 | Should fix | WP3-retest3-fixes.md:117 | turning a contact into an employee skips the identity-change gate. | Closed (PR #24) |
| R384 | Should fix | WP3-retest3-fixes.md:128 | an undeclared loosening of the S0-03 employee check. | Closed (PR #24) |
| R385 | Should fix | WP3-retest3-fixes.md:134 | the sign-in forgery check depends on a non-Entra claim and a test-only over | Closed (PR #24) |
| R386 | Should fix | WP3-retest3-fixes.md:141 | emailLinking.enabled isn't validated, so a bad value leaves linking on. | Closed (PR #24) |
| R387 | Should fix | WP3-retest3-fixes.md:146 | Entra ID doesn't issue email_verified. | Closed (PR #24) |
| R388 | Should fix | WP3-retest3-fixes.md:153 | each commit must build on its own. | Closed (PR #24) |
| R389 | Suggestion | WP3-retest3-fixes.md:178 | (S0-30) | Closed (PR #24) |
| R390 | Suggestion | WP3-retest3-fixes.md:189 | , feature-list.md:7: the approved ID list says F1–F18, but F19–F21 exist. C | Closed (PR #24) |
| R391 | Suggestion | WP3-retest3-fixes.md:190 | , merge order: merge chore/s0-30-plan into develop after the WP3 PRs. Then  | Closed (PR #24) |
| R392 | Suggestion | WP3-retest3-fixes.md:191 | , demo follow-up: once S0-11b and S0-30 are both on develop, the runbook no | Closed (PR #24) |
| R393 | Should fix | WP3-retest4-fixes.md:32 | (R383 follow-up): an email synthesised for a new or promoted employee escap | Closed (PR #24) |
| R394 | Should fix | WP3-retest4-fixes.md:46 | (R385 follow-up): the slice adds two test-only fallbacks to production code | Closed (PR #24) |
| R395 | Should fix | WP3-retest4-fixes.md:56 | (R387 follow-up): the changelog still describes the old claims. | Closed (PR #24) |
| R396 | Suggestion | WP3-retest4-fixes.md:62 | (S0-30) | Closed (PR #24; verified on develop in Session 3) |
| R397 | Suggestion | WP3-retest4-fixes.md:68 | (WP3, follow-up PR) | EXCEPTION: deferred follow-up (feature-list P6) |
| R398 | Should fix | S0-30-retest5-fixes.md:27 | marking a leaver now needs MFA. Change the gate so it applies only when an  | Closed: merged PR #24; no reviewer re-check on file |
| R399 | Should fix | S0-30-retest5-fixes.md:42 | a correlation ID from a request header goes into audit text without any che | Closed: merged PR #24; no reviewer re-check on file |
| R400 | Suggestion | S0-30-retest5-fixes.md:53 | Tenant check in savePersonRecord: R394 removed the whole TENANCY_FORGERY_DE | Closed on code evidence; no reviewer re-check |
| R401 | Blocking | WP4-plan-review.md:33 | SET ROLE and advisory locks are session-level, but connections go through P | Closed (PR #25) |
| R402 | Blocking | WP4-plan-review.md:52 | the privilege model doesn't give the protection the plan claims. | Closed (PR #25) |
| R403 | Should fix | WP4-plan-review.md:77 | the migrate job has no tenant list until S0-19, and two entry points. | Closed (PR #25) |
| R404 | Should fix | WP4-plan-review.md:96 | the job and migrate code won't run in the container as planned. | Closed (PR #25) |
| R405 | Should fix | WP4-plan-review.md:106 | move document metadata in S0-14 (owner decision 2). | Closed (PR #25) |
| R406 | Should fix | WP4-plan-review.md:114 | making services async lets requests interleave on the shared JSON store. | Closed (PR #25) |
| R407 | Should fix | WP4-plan-review.md:127 | there's no cut-over order for a release. | Closed (PR #25) |
| R408 | Should fix | WP4-plan-review.md:141 | contract migrations run in the same release as the code that stops using th | Closed (PR #25) |
| R409 | Should fix | WP4-plan-review.md:149 | row_version isn't carried from the form. | Closed (PR #25) |
| R410 | Should fix | WP4-plan-review.md:158 | the S0-30 email match needs every email, not just the primary one. | Closed (PR #25) |
| R411 | Should fix | WP4-plan-review.md:166 | keep the PMS sync settings reserved (owner decision 3). | Closed (PR #25) |
| R412 | Should fix | WP4-plan-review.md:174 | S0-19 and S0-19b differ from ADR 0030 in four places. | Closed (PR #25) |
| R413 | Suggestion | WP4-plan-review.md:182 | (plans) | Closed (PR #25) |
| R414 | Suggestion | WP4-plan-review.md:190 | (report accuracy) | Closed (PR #25) |
| R415 | Suggestion | WP4-plan-review.md:197 | (CLAUDE.md / AGENTS.md wording for S0-20) | Closed (PR #25) |
| R416 | Suggestion | WP4-plan-review.md:201 | (Checkpoint 4a order) | Closed (PR #25) |
| R417 | Should fix | WP4-plan-retest.md:29 | (R408 follow-up): code must stop reading the transitional structures before | Closed (PR #25) |
| R418 | Should fix | WP4-plan-retest.md:44 | (R406 follow-up): the JSON store lock deadlocks on nested calls. | Closed (PR #25) |
| R419 | Should fix | WP4-plan-retest.md:55 | (R401 follow-up): say what the job's advisory lock covers. | Closed (PR #25) |
| R420 | Suggestion | WP4-plan-retest.md:67 | Unlocked reads: reads that don't take the lock (for example getAppSnapshot) | Closed (PR #25) |
| R421 | Should fix | WP4-plan-retest2.md:22 | (from R417): the S0-17b HR import reads employment data from the wrong plac | Closed (PR #25) |
| R422 | Blocking | WP4-4a-review-fixes.md:51 | Telemetry can't authenticate to Application Insights | Closed (PRs #26–#29) |
| R423 | Blocking | WP4-4a-review-fixes.md:66 | Auto-instrumented spans skip tenant stamping and the deny-list | Closed (PRs #26–#29) |
| R424 | Should fix | WP4-4a-review-fixes.md:78 | A caller-supplied configuredKeyVault widens the vault boundary | Closed (PRs #26–#29) |
| R425 | Should fix | WP4-4a-review-fixes.md:86 | The vault allow-list accepts the tenant's vault in every environment | Closed (PRs #26–#29) |
| R426 | Should fix | WP4-4a-review-fixes.md:92 | The Dockerfile hard-codes the invented client package | Closed (PRs #26–#29) |
| R427 | Should fix | WP4-4a-review-fixes.md:102 | The telemetry deny-list misses personal-data and content keys | Closed (PRs #26–#29) |
| R428 | Should fix | WP4-4a-review-fixes.md:111 | Key Vault and storage names can collide | Closed (PRs #26–#29) |
| R429 | Should fix | WP4-4a-review-fixes.md:118 | Backlog row E9 is out of date | Closed (PRs #26–#29) |
| R430 | Suggestion | WP4-4a-review-fixes.md:128 | remove the test-only recorder? parameters (telemetry.ts:349, 367, 409). Tes | EXCEPTION: deferred follow-up (feature-list P12) |
| R431 | Suggestion | WP4-4a-review-fixes.md:129 | the store-import job mounts five web secrets it never uses (platform.bicep: | Closed (PRs #26–#29) |
| R432 | Should fix | WP4-4a-review-fixes.md:122 | A telemetry failure can turn a denial into a 500 | Closed (PRs #26–#29) |
| R433 | Blocking | WP4-4a-review-fixes.md:135 | Web actions run imports under an invented admin context | Closed (PRs #26–#29) |
| R434 | Blocking | WP4-4a-review-fixes.md:149 | Migration 0006 can't be reversed | Closed (PRs #26–#29) |
| R435 | Blocking | WP4-4a-review-fixes.md:155 | Test-only overrides and hard-coded passwords in core | Closed (PRs #26–#29) |
| R436 | Blocking | WP4-4a-review-fixes.md:170 | Client package name and fail-open defaults in the core registry | Closed (PRs #26–#29) |
| R437 | Should fix | WP4-4a-review-fixes.md:179 | The readiness check only looks at the highest migration version | Closed (PRs #26–#29) |
| R438 | Should fix | WP4-4a-review-fixes.md:186 | The restore runbook's audit-log step fails | Closed (PRs #26–#29) |
| R439 | Should fix | WP4-4a-review-fixes.md:193 | The two-tenant tests fall short of the WP4 bar | Closed (PRs #26–#29) |
| R440 | Suggestion | WP4-4a-review-fixes.md:205 | scripts/run-job.ts:66-83. Assert that the registry entry's postgresDatabase | Closed (PRs #26–#29) |
| R441 | Suggestion | WP4-4a-review-fixes.md:206 | postgresPoolManager.ts:358. Evict idle pools only when totalCount === idleC | Closed (PRs #26–#29) |
| R442 | Blocking | WP4-4a-review-fixes.md:212 | Compensation doesn't cover sensitive HR or RBAC changes | Closed (PRs #26–#29) |
| R443 | Blocking | WP4-4a-review-fixes.md:226 | executeMerge still restores the whole store | Closed (PRs #26–#29) |
| R444 | Blocking | WP4-4a-review-fixes.md:237 | Audit entries are dropped silently outside a write scope | Closed (PRs #26–#29) |
| R445 | Blocking | WP4-4a-review-fixes.md:250 | A test-only branch creates an MFA-verified admin context with no session | Closed (PRs #26–#29) |
| R446 | Should fix | WP4-4a-review-fixes.md:265 | Nested frames commit their own audit, and undo runs in the wrong order | Closed (PRs #26–#29) |
| R447 | Should fix | WP4-4a-review-fixes.md:278 | Compensation failures are swallowed | Closed (PRs #26–#29) |
| R448 | Should fix | WP4-4a-review-fixes.md:285 | R144 race tests now treat stale overwrites as correct | Closed (PRs #26–#29) |
| R449 | Should fix | WP4-4a-review-fixes.md:301 | The reminder scheduler reads data before its permission checks | Closed (PRs #26–#29) |
| R450 | Should fix | WP4-4a-review-fixes.md:312 | A test failure hook sits in the production audit path | Closed (PRs #26–#29) |
| R451 | Should fix | WP4-4a-review-fixes.md:317 | The firm audit page cursor doesn't match the sort order | Closed (PRs #26–#29) |
| R452 | Should fix | WP4-4a-review-fixes.md:322 | The Admin firm audit page is fetched but never shown | Closed (PRs #26–#29) |
| R453 | Should fix | WP4-4a-review-fixes.md:332 | Demo reset needs the migration role from the web app | Closed (PRs #26–#29) |
| R454 | Should fix | WP4-4a-review-fixes.md:348 | Rolling back 0007 destroys the append-only audit log | Closed (PRs #26–#29) |
| R455 | Should fix | WP4-4a-review-fixes.md:359 | A duplicate audit ID is reported as saved | Closed (PRs #26–#29) |
| R456 | Should fix | WP4-4a-review-fixes.md:366 | The nested-lock test uses a stand-in, not the real path | Closed (PRs #26–#29) |
| R457 | Should fix | WP4-4a-review-fixes.md:375 | The audit read functions check permissions differently from getAppSnapshot | Closed (PRs #26–#29) |
| R458 | Should fix | WP4-4a-review-fixes.md:388 | Backlog rows are inaccurate | Closed (PRs #26–#29) |
| R459 | Suggestion | WP4-4a-review-fixes.md:399 | src/server/visibility.ts:92-93. Make hiddenMatterKeyDateIds a required opti | Closed (PRs #26–#29) |
| R460 | Suggestion | WP4-4a-review-fixes.md:400 | migrations/index.ts:730, 829. Grant UPDATE only on tenant_audit_id_seq, not | Closed (PRs #26–#29) |
| R461 | Suggestion | WP4-4a-review-fixes.md:401 | src/server/testSupport/auditTestSupport.ts:31-37. The comment says "peeks", | Closed (PRs #26–#29) |
| R462 | Suggestion | WP4-4a-review-fixes.md:402 | src/server/entraAuth.ts:634-669. createSignInActorFromVerifiedOidcToken is  | Closed (PRs #26–#29) |
| R463 | Should fix | WP4-4b-prompt.md:24 | Migration 0008 accepts a checksum whose upSql differs | Closed (PRs #28–#34) |
| R464 | Should fix | WP4-4b-prompt.md:36 | The R456 nested-save test has no positive control | Closed (PRs #28–#34) |
| R465 | Blocking | WP4-4b-review-fixes.md:43 | A cold start or new replica wipes the tenant's PostgreSQL data | Closed (PRs #28–#34) |
| R466 | Blocking | WP4-4b-review-fixes.md:64 | Replicas serve and write back stale data | Closed (PRs #28–#34) |
| R467 | Blocking | WP4-4b-review-fixes.md:78 | One in-memory store is shared by every tenant in the process | Closed (PRs #28–#34) |
| R468 | Blocking | WP4-4b-review-fixes.md:92 | Moved data, including payroll and sensitive HR, is still written to the JSO | Closed (PRs #28–#34) |
| R469 | Blocking | WP4-4b-review-fixes.md:103 | Build the read and write path the slice plans describe | Closed (PRs #28–#34) |
| R470 | Should fix | WP4-4b-review-fixes.md:128 | The grep contract tests pass by renaming | Closed (PRs #28–#34) |
| R471 | Should fix | WP4-4b-review-fixes.md:136 | Test-only behaviour in production code | Closed (PRs #28–#34) |
| R472 | Blocking | WP4-4a-ci-fix.md:15 | Re-provisioning in tests breaks PgBouncer's stored login, so CI fails | Closed (PRs #28–#34) |
| R473 | Blocking | WP4-4b-retest-fixes.md:40 | A process-level cache can leave staff-matter access lists stale on other re | Closed (PRs #28–#34) |
| R474 | Should fix | WP4-4b-retest-fixes.md:59 | Multi-step writes still commit in several transactions and roll back by com | Closed (PRs #28–#34) |
| R475 | Should fix | WP4-4b-retest-fixes.md:77 | A process-wide write lock still serialises every tenant's writes | Closed (PRs #28–#34) |
| R476 | Should fix | WP4-4b-retest-fixes.md:97 | listAllMatters is an unfiltered alias | Closed (PRs #28–#34) |
| R477 | Blocking | WP4-4b-retest2-fixes.md:40 | RBAC configuration is still cached per process | Closed (PRs #28–#34) |
| R478 | Blocking | WP4-4b-retest2-fixes.md:61 | Read paths rewrite staff-matter access lists from data read outside the tra | Closed (PRs #28–#34) |
| R479 | Should fix | WP4-4b-retest3-fixes.md:40 | Two write paths still pass in teams read before their transaction | Closed (PRs #28–#34) |
| R480 | Blocking | WP4-4c-review-fixes.md:40 | Server actions accept a caller-supplied clock | Closed (merged; re-check not on file) |
| R481 | Should fix | WP4-4c-review-fixes.md:58 | run-job --now lets a scheduled job run with any date | Closed (merged; re-check not on file) |
| R482 | Should fix | WP4-4c-review-fixes.md:72 | Test hooks in production job code | Closed (merged; re-check not on file) |
| R483 | Should fix | WP4-4c-review-fixes.md:84 | The reminder job reads all key dates but only the not-applicable records th | Closed (merged; re-check not on file) |
| R484 | Blocking | S0-11b-deployment-review-fixes.md:22 | Demo accounts were given a real admin role in the company directory | Closed (merged; re-check not on file) |
| R485 | Should fix | S0-11b-deployment-review-fixes.md:40 | P12 is marked Completed before the live checks have run | Closed (PR #38 / PR #53) |
| R486 | Should fix | WP5-phase0-review-fixes.md:39 | Work-type cap above the firm cap | Closed (merged; re-check not on file) |
| R487 | Should fix | WP5-phase0-review-fixes.md:44 | Nothing says which cap category a matter falls into | Closed (merged; re-check not on file) |
| R488 | Should fix | WP5-phase0-review-fixes.md:51 | Pin down the statutory table and the rounding rule | Closed (merged; re-check not on file) |
| R489 | Should fix | WP5-phase0-review-fixes.md:58 | Register types have two sources of truth | Closed (merged; re-check not on file) |
| R490 | Should fix | WP5-phase0-review-fixes.md:62 | Extension hooks and the transaction | Closed (merged; re-check not on file) |
| R491 | Should fix | WP5-phase0-review-fixes.md:69 | Allow-lists would put personal identifiers in committed config | Closed (merged; re-check not on file) |
| R492 | Should fix | WP5-phase0-review-fixes.md:79 | The outbox drain doesn't fit ADR 0030 as written | Closed (merged; re-check not on file) |
| R493 | Should fix | WP5-phase0-review-fixes.md:92 | Be explicit about caching credentials | Closed (merged; re-check not on file) |
| R494 | Should fix | WP5-phase0-review-fixes.md:100 | Outbox keeps addresses and message bodies indefinitely | Closed (merged; re-check not on file) |
| R495 | Should fix | WP5-5a-review-fixes.md:20 | Clients can set the matter's closure and destruction dates | Closed (PR #44) |
| R496 | Should fix | WP5-5a-review-fixes.md:38 | Matter status is chosen by its display label | Closed (PR #44) |
| R497 | Should fix | WP5-5a-review-fixes.md:46 | Retention settings and the key-date closure check are read before the trans | Closed (PR #44) |
| R498 | Should fix | WP5-5c-review-fixes.md:28 | Demo Key Vault references point at a vault that doesn't exist | Closed (PRs #49–#50) |
| R499 | Should fix | WP5-5c-review-fixes.md:42 | No Teams app package or Teams runbook | Closed (PRs #49–#50) |
| R500 | Should fix | WP5-5c-review-fixes.md:92 | Hand-written PKCS#12 decryption in the Graph token provider | Closed: test on develop; no reviewer re-check on file |
| R501 | — | — | — | Gap: not defined anywhere (next-free marker in WP5-5c; numbering resumed at R502) |
| R502 | Should fix | Stage0-PRs-54-56-review.md:27 | #54 docs/stage-0-exceptions · docs/roadmap/feature-list.md row 34 | Closed (merged; re-check not on file) |
| R503 | Should fix | Stage0-PRs-54-56-review.md:33 | #55 fix/b14-docgen-permission-keys · src/docs/articles/document-generation. | Closed (merged; re-check not on file) |
| R504 | Should fix | Stage0-PRs-54-56-review.md:41 | #56 fix/p6-demo-literals · src/components/PersonProfileClient.tsx ("Able to | Closed (merged; re-check not on file) |
| R505 | Suggestion | Stage0-PRs-54-56-review.md:62 | #55 · core/tests/tenant-config-usage.test.ts, B14 save test. The finally bl | Closed (merged; re-check not on file) |
| R506 | Suggestion | Stage0-PRs-54-56-review.md:63 | #56 · scripts/verify-no-demo-literals.mjs. The bare 'Pembroke' deny literal | Closed (merged; re-check not on file) |
| R507 | Follow-up (B16) | Stage0-PRs-54-56-review.md:67 | B16 (next free B number) · Document Generation settings save has no MFA che | Closed (merged; re-check not on file) |
| R508 | Blocking | Stage0-exit-session1-safe.md:99 | Any signed-in user can read any employee's payroll and HR record | Closed (PRs #58–#63) |
| R509 | Blocking | Stage0-exit-session1-safe.md:107 | Immediate notification emails leak restricted-matter task content | Closed (PRs #58–#63) |
| R510 | Blocking | Stage0-exit-session1-safe.md:115 | Verified (bypass to be proven by test) · Matter opening invents a "Clear" c | Closed (PRs #58–#63) |
| R511 | Blocking | Stage0-exit-session1-safe.md:123 | AI matter extraction returns a hard-coded demo scenario in every environmen | Closed (PRs #58–#63) |
| R512 | Blocking | Stage0-exit-session1-safe.md:131 | New employee records are created with fabricated compliance facts | Closed (PRs #58–#63) |
| R513 | Blocking | Stage0-exit-session1-safe.md:141 | Verified (scope: holders of employee:payroll) · Payroll goes to the browser | Closed (PRs #58–#63) |
| R514 | Should fix | Stage0-exit-session1-safe.md:152 | Reported · Toast-only buttons | Closed (PRs #58–#63) |
| R515 | Should fix | Stage0-exit-session1-safe.md:156 | Merging people or organisations doesn't repoint register records | Closed (PRs #58–#63) |
| R516 | Should fix | Stage0-exit-session1-safe.md:161 | Reported · The demo-literal guard misses most of the codebase | Closed (PRs #58–#63) |
| R517 | — | — | — | Gap: deliberately unused (Stage0-exit-session1-safe.md:247) |
| R518 | Should fix | Stage0-exit-session1-safe.md:169 | Reported · Guard coverage gaps | Closed (PRs #58–#63) |
| R519 | Should fix | Stage0-exit-session1-safe.md:177 | Reported · Document generation snapshot doesn't check its declared permissi | Closed (PRs #58–#63) |
| R520 | Should fix | Stage0-exit-session1-safe.md:181 | Reported · process.env.VITEST turns on test signing keys | Closed (PRs #58–#63) |
| R521 | Should fix | Stage0-exit-session1-safe.md:185 | Reported · Demo branches not gated by the demo check | Closed (PRs #58–#63) |
| R522 | Should fix | Stage0-exit-session1-safe.md:191 | Reported · A client name in host code, and the tenant registry fails open | Closed (PRs #58–#63) |
| R523 | Should fix | Stage0-exit-session1-safe.md:195 | Reported · The SharePoint mock is usable in live and reports success | Closed (PRs #58–#63) |
| R524 | Should fix | Stage0-exit-session1-safe.md:199 | Reported · Logging gaps | Closed (PRs #58–#63) |
| R525 | Should fix | Stage0-exit-session1-safe.md:206 | Reported · The PMS admin snapshot has no finance check of its own | Closed (PRs #58–#63) |
| R526 | Should fix | Stage0-exit-session1-fixes.md:158 | Owner decision D2 · Matter-level finance limited to the user's own matters | Closed (PRs #58–#63) |
| R527 | Should fix | Stage0-exit-session1-fixes.md:171 | Owner decision D3 · Admin MFA can't be turned off in live | Closed (PRs #58–#63) |
| R528 | Should fix | Stage0-exit-session1-safe.md:210 | Reported · Two restriction checks don't match canAccessMatter | Closed (PRs #58–#63) |
| R529 | Should fix | Stage0-exit-session1-safe.md:218 | Reported · B8: the denial message and help promise rules the code doesn't h | Closed (PRs #58–#63) |
| R530 | Should fix | Stage0-exit-session1-safe.md:222 | Reported · B16: the policy-alignment test is a fixed value | Closed (PRs #58–#63) |
| R531 | Suggestion | Stage0-exit-session1-safe.md:228 | B5 tests 2b and 2c assert on stale objects (core/tests/rbac.test.ts:~4380-4 | Closed (PRs #58–#63) |
| R532 | Suggestion | Stage0-exit-session1-safe.md:231 | listFirmAuditEntriesPage (services.ts:1481-1488) should use enforceMfa. | Closed (PRs #58–#63) |
| R533 | Suggestion | Stage0-exit-session1-safe.md:235 | clearMatterExtractionCacheForTesting; | Closed (PRs #58–#63) |
| R534 | Suggestion | Stage0-exit-session1-safe.md:241 | The migration roll-back loops should assert each rollbackVersion returns tr | Closed (PRs #58–#63) |
| R535 | Blocking | Stage0-exit-session1-fixes-review.md:36 | Branch 2 · The actor's token roles are applied to other people | Closed (PRs #58–#63) |
| R536 | Blocking | Stage0-exit-session1-fixes-review.md:54 | Branch 3 · R510 bypass still open: draft, then submit as cleared | Closed (PRs #58–#63) |
| R537 | Blocking | Stage0-exit-session1-fixes-review.md:74 | Reported (prove it with a test first) · Branch 3 · Close and reopen turns a | Closed (PRs #58–#63) |
| R538 | Should fix | Stage0-exit-session1-fixes-review.md:92 | R513 incomplete: the page snapshot still sends raw payroll | Closed (PRs #58–#63) |
| R539 | Should fix | Stage0-exit-session1-fixes-review.md:99 | Reported · R508 case 2 has no test. Add the spec's second case: a no-HR use | Closed (PRs #58–#63) |
| R540 | Should fix | Stage0-exit-session1-fixes-review.md:101 | Reported · A false view-payroll audit for non-employees. In PersonFormClien | Closed (PRs #58–#63) |
| R541 | Should fix | Stage0-exit-session1-fixes-review.md:105 | Reported · canRecipientReceiveNotification loads whole tables for each reci | Closed (PRs #58–#63) |
| R542 | Should fix | Stage0-exit-session1-fixes-review.md:107 | show that a permitted recipient does get the notification, the email_outbox | Closed (PRs #58–#63) |
| R543 | Should fix | Stage0-exit-session1-fixes-review.md:111 | Reported · A task can't be edited once an existing assignee has lost access | Closed (PRs #58–#63) |
| R544 | Should fix | Stage0-exit-session1-fixes-review.md:115 | Reported · The R521 test doesn't test the gate. src/server/__tests__/demoTe | Closed (PRs #58–#63) |
| R545 | Should fix | Stage0-exit-session1-fixes-review.md:122 | Don't go back to 'Clear'. | Closed (PRs #58–#63) |
| R546 | Should fix | Stage0-exit-session1-fixes-review.md:130 | Reported · R526 has no restricted-matter test. Add a case where a fee earne | Closed (PRs #58–#63) |
| R547 | Should fix | Stage0-exit-session1-fixes-review.md:132 | Reported · R527: the defence in depth doesn't reach every resolver call. Th | Closed (PRs #58–#63) |
| R548 | Should fix | Stage0-exit-session1-fixes-review.md:141 | Reported · R518: re-exports from other files are still skipped. The regexes | Closed (PRs #58–#63) |
| R549 | Should fix | Stage0-exit-session1-fixes-review.md:148 | Reported · R519 hides the generated-document list from roles without templa | Closed (PRs #58–#63) |
| R550 | Should fix | Stage0-exit-session1-fixes-review.md:154 | Reported · The R522 scheduler test accepts any error. rejects.toThrow() has | Closed (PRs #58–#63) |
| R551 | Should fix | Stage0-exit-session1-fixes-review.md:158 | Reported · The register repoint doesn't bump row_version. The register UPDA | Closed (PRs #58–#63) |
| R552 | Should fix | Stage0-exit-session1-fixes-review.md:162 | Reported · The R515 table list isn't recorded, and two documents are wrong. | Closed (PRs #58–#63) |
| R553 | Suggestion | Stage0-exit-session1-fixes-review.md:168 | B1: revealEmployeePayrollAction returns unmasked NI and bank details even t | Closed (PRs #58–#63) |
| R554 | Suggestion | Stage0-exit-session1-fixes-review.md:169 | B1: loading and then unmasking payroll writes two audit entries. Once loade | Closed (PRs #58–#63) |
| R555 | Suggestion | Stage0-exit-session1-fixes-review.md:170 | B1: the success return of savePersonRecord still gives permissionOverrides  | Closed (PRs #58–#63) |
| R556 | Suggestion | Stage0-exit-session1-fixes-review.md:171 | B2: saveTaskRecord looks up linked key dates through the actor-scoped getKe | Closed (PRs #58–#63) |
| R557 | Suggestion | Stage0-exit-session1-fixes-review.md:172 | B3: remove the dead 'local-fallback' code (route.ts:~1662, MatterFormClient | Closed (PRs #58–#63) |
| R558 | Suggestion | Stage0-exit-session1-fixes-review.md:173 | B4: verifyFinanceActorAndPermission and syncMatterCostsRatesFromPms skip MF | Closed (PRs #58–#63) |
| R559 | Suggestion | Stage0-exit-session1-fixes-review.md:174 | B4: in the R527 test, restore PLATFORM_ENVIRONMENT with delete when it was  | Closed (PRs #58–#63) |
| R560 | Suggestion | Stage0-exit-session1-fixes-review.md:175 | B5: updateMatterConflictRecordAction declares risk:view and matter:create,  | Closed (PRs #58–#63) |
| R561 | Suggestion | Stage0-exit-session1-fixes-review.md:176 | B5: the coarse pre-check hard-codes the line-manager grant rather than read | Closed (PRs #58–#63) |
| R562 | Suggestion | Stage0-exit-session1-fixes-review.md:177 | B5: unify live detection in blobStorage.ts and documentGenerationServices.t | Closed (PRs #58–#63) |
| R563 | Suggestion | Stage0-exit-session1-fixes-review.md:178 | B5: make the guard test reject inline 'use server' inside function bodies. | Closed (PRs #58–#63) |
| R564 | Suggestion | Stage0-exit-session1-fixes-review.md:179 | B6: assert the exact denial message in the B9 test. | Closed (PRs #58–#63) |
| R565 | Suggestion | Stage0-exit-session1-fixes-review.md:180 | B6: repoint nested { id: <mergedId> } values inside field_values_json too,  | Closed (PRs #58–#63) |
| R566 | Suggestion | Stage0-exit-session1-fixes-review.md:181 | B6: give the remaining [x-reserved:backlog] settings backlog IDs (core/src/ | Closed (PRs #58–#63) |
| R567 | Suggestion | Stage0-exit-session1-fixes-review.md:182 | B5: say in the release notes and the PR that the R518 coarse pre-check is M | Closed (PRs #58–#63) |
| R568 | Should fix | Stage0-exit-session1-fixes-round2.md:29 | Branch 2 · A client can unlink a task's key date | Closed (PRs #58–#63) |
| R569 | Should fix | Stage0-exit-session1-fixes-round2.md:38 | Reported · Branch 2 · R543 test gap | Closed (PRs #58–#63) |
| R570 | Should fix | Stage0-exit-session1-fixes-round2.md:42 | Branch 4 · Record the canAccessMatter change | Closed (PRs #58–#63) |
| R571 | Suggestion | Stage0-exit-session1-fixes-round2.md:50 | B2: in resolvePersonPermissionSet (src/domain/rbac.ts), options.tokenRoles  | Closed (PRs #58–#63) |
| R572 | Suggestion | Stage0-exit-session1-fixes-round2.md:51 | B3: matters imported before 494d565, and the seed and pms:import paths, nev | EXCEPTION: Help note; backfill carried (feature-list rows 35, P6) |
| R573 | Suggestion | Stage0-exit-session1-fixes-round2.md:52 | B2: move the R556 key-date lookup inside the transaction. | Closed (PRs #58–#63) |
| R574 | Suggestion | Stage0-exit-session1-fixes-round2.md:53 | B4/B5: in the R548 guard test, match on the "forbidden module re-export" me | Closed (PRs #58–#63) |
| R575 | Blocking | Stage0-exit-session2-solid.md:101 | Enquiry "Send email" records an email that is never sent (O7, P6) | Closed (PRs #64–#68) |
| R576 | Blocking | Stage0-exit-session2-solid.md:113 | The matter opening gate depends on a renameable label (sweep 10) | Closed (PRs #64–#68) |
| R577 | Blocking | Stage0-exit-session2-solid.md:125 | Key date actions read outside the transaction and overwrite without a versi | Closed (PRs #64–#68) |
| R578 | Should fix | Stage0-exit-session2-solid.md:155 | Hosted file storage is the container's own disk (sweep 12, O5, O6; depends  | Closed (PRs #64–#68) |
| R579 | Should fix | Stage0-exit-session2-solid.md:168 | The storage provider keeps every document in process memory (sweep 7) | Closed (PRs #64–#68) |
| R580 | Should fix | Stage0-exit-session2-solid.md:177 | Health probes check nothing (O5) | Closed (PRs #64–#68) |
| R581 | Should fix | Stage0-exit-session2-solid.md:185 | Reported · Job-failure alerts reach nobody (O5) | Closed (PRs #64–#68) |
| R582 | Should fix | Stage0-exit-session2-solid.md:189 | The PDF converter is in Bicep only (O5; depends on D5) | Closed (D5); container carried as item 46 |
| R583 | Should fix | Stage0-exit-session2-solid.md:193 | PMS money is held as floating-point pounds (sweep 11; depends on D6) | EXCEPTION: carried to Stage 1 as B21 |
| R584 | Should fix | Stage0-exit-session2-solid.md:200 | pms:import builds a half-overridden tenant context and has no live guard (O | Closed (PRs #64–#68) |
| R585 | Should fix | Stage0-exit-session2-solid.md:207 | AI extraction cache can return another upload's results (sweep 7) | Closed (PRs #64–#68) |
| R586 | Should fix | Stage0-exit-session2-solid.md:216 | Helpers fall back to the process tenant's configuration for other tenants ( | Closed (PRs #64–#68) |
| R587 | Should fix | Stage0-exit-session2-solid.md:226 | Reported · Two-tenant gaps in jobs and search (O3, O4; ADR 0030 §6) | Closed (PRs #64–#68) |
| R588 | Should fix | Stage0-exit-session2-solid.md:233 | Reported · guardedJob reports a timeout but the work still commits (O4) | Closed (PRs #64–#68) |
| R589 | Should fix | Stage0-exit-session2-solid.md:238 | Reported · Client can set conflictCheckDate and openedAt (sweep 9) | Closed (PRs #64–#68) |
| R590 | Should fix | Stage0-exit-session2-solid.md:244 | Reported · Dead compensation code, including an immutability bypass (sweep  | Closed (PRs #64–#68) |
| R591 | Should fix | Stage0-exit-session2-solid.md:251 | Reported · Config and rate-override writes read before the transaction (swe | Closed (PRs #64–#68) |
| R592 | Should fix | Stage0-exit-session2-solid.md:255 | Reported · Server logic still keyed on names, labels or job titles (sweep 1 | Closed (PRs #64–#68) |
| R593 | Should fix | Stage0-exit-session2-solid.md:264 | Reported · Extensions get the whole tenant configuration regardless of thei | Closed (PRs #64–#68) |
| R594 | Should fix | Stage0-exit-session2-solid.md:272 | ADR status and stale references (step 6; depends on D7) | Closed (PRs #64–#68) |
| R595 | Should fix | Stage0-exit-session2-solid.md:280 | Reported · Standard gaps missing from the "before the first hosted client"  | Closed (PRs #64–#68) |
| R596 | Suggestion | Stage0-exit-session2-solid.md:295 | REQUEST_PERMISSION_CACHE (core/src/domain/rbac/resolver.ts:164) is written  | Closed (PRs #64–#68) |
| R597 | Suggestion | Stage0-exit-session2-solid.md:296 | catalogue reads merge in src/seed lists and defaults at runtime (services.t | EXCEPTION: deferred (feature-list rows 29, P2) |
| R598 | Suggestion | Stage0-exit-session2-solid.md:297 | Tenant ID length: cap tenant IDs at about 40 characters (PostgreSQL's 63-by | EXCEPTION: 4 sub-items closed (incl. R637); 6 recorded (feature-list rows 29, 32, P6, P8) |
| R599 | Blocking | Stage0-exit-session2-fixes-round2.md:41 | Branch 4 · Breaking extension API change with no version change (rule 7) | Closed (PRs #64–#68) |
| R600 | Should fix | Stage0-exit-session2-fixes-round2.md:57 | The conflict-draft task matcher takes over the Risk reviewer's task (regres | Closed (PRs #64–#68) |
| R601 | Should fix | Stage0-exit-session2-fixes-round2.md:66 | The enquiry email idempotency key is random | Closed (PRs #64–#68) |
| R602 | Should fix | Stage0-exit-session2-fixes-round2.md:71 | Client HTML goes into the outbox unsanitised, and the recipient isn't valid | Closed (PRs #64–#68) |
| R603 | Should fix | Stage0-exit-session2-fixes-round2.md:78 | The PMS grade map can return an inactive or missing role | Closed (PRs #64–#68) |
| R604 | Should fix | Stage0-exit-session2-fixes-round2.md:83 | Reported · New keys exist only in the seed; existing tenant databases aren' | Closed (PRs #64–#68) |
| R605 | Should fix | Stage0-exit-session2-fixes-round2.md:92 | Reported · fallbackTeamId, Team.departmentId and Team.systemKey can't be co | Closed (PRs #64–#68) |
| R606 | Should fix | Stage0-exit-session2-fixes-round2.md:104 | A calendar sync failure after commit reports failure for work that was save | Closed (PRs #64–#68) |
| R607 | Should fix | Stage0-exit-session2-fixes-round2.md:112 | Reported · Post-commit calendar syncs can run on stale state or out of orde | Closed (PRs #64–#68) |
| R608 | Should fix | Stage0-exit-session2-fixes-round2.md:116 | Reported · "Not applicable" can race with create and verify | Closed (PRs #64–#68) |
| R609 | Should fix | Stage0-exit-session2-fixes-round2.md:121 | Reported · The nightly reminder job can overwrite an acknowledgement | Closed (PRs #64–#68) |
| R610 | Should fix | Stage0-exit-session2-fixes-round2.md:126 | Reported · Some key-date writes still bypass the version check | Closed (PRs #64–#68) |
| R611 | Should fix | Stage0-exit-session2-fixes-round2.md:132 | Probes have no timeout or failure threshold | Closed (PRs #64–#68) |
| R612 | Should fix | Stage0-exit-session2-fixes-round2.md:136 | Reported · /api/health/ready can be called without limit | Closed (PRs #64–#68) |
| R613 | Should fix | Stage0-exit-session2-fixes-round2.md:143 | Reported · The single-replica guard covers demo only | Closed (PRs #64–#68) |
| R614 | Should fix | Stage0-exit-session2-fixes-round2.md:149 | Reported · A job can still time out between the abort check and commit | Closed (PRs #64–#68) |
| R615 | Should fix | Stage0-exit-session2-fixes-round2.md:153 | Reported · The registers config still falls back silently | Closed (PRs #64–#68) |
| R616 | Suggestion | Stage0-exit-session2-fixes-round2.md:159 | valueBySystemKey (src/domain/lists.ts:~53) ignores active, so a deactivated | Closed (PRs #64–#68) |
| R617 | Suggestion | Stage0-exit-session2-fixes-round2.md:165 | Saving the key-date config for the first time takes no lock. Insert the def | Closed (PRs #64–#68) |
| R618 | Suggestion | Stage0-exit-session2-fixes-round2.md:169 | Add an R579 restart test: a new provider instance reads an existing file as | Closed (PRs #64–#68) |
| R619 | Blocking | Stage0-exit-session2-fixes-round3.md:47 | Branch 1 · Migration 0021 hard-codes one firm's team layout into the core ( | Closed (PRs #64–#68) |
| R620 | Blocking | Stage0-exit-session2-fixes-round3.md:69 | Branch 3 · The Startup probe can't be deployed | Closed (PRs #64–#68) |
| R621 | Should fix | Stage0-exit-session2-fixes-round3.md:78 | Reported · Legacy open Risk review tasks aren't backfilled (R600) | Closed (PRs #64–#68) |
| R622 | Should fix | Stage0-exit-session2-fixes-round3.md:83 | Reported · Reusing a submission ID with different content is silently dropp | Closed (PRs #64–#68) |
| R623 | Should fix | Stage0-exit-session2-fixes-round3.md:90 | Reported · Entities are double-escaped in sanitised email HTML (R602) | Closed (PRs #64–#68) |
| R624 | Should fix | Stage0-exit-session2-fixes-round3.md:97 | Reported · Gaps in the R605 configuration | Closed (PRs #64–#68) |
| R625 | Should fix | Stage0-exit-session2-fixes-round3.md:102 | Reported · Default practice groups are force-merged into every tenant's org | Closed (PRs #64–#68) |
| R626 | Should fix | Stage0-exit-session2-fixes-round3.md:107 | New display-label matching added (stable keys rule) | Closed (PRs #64–#68) |
| R627 | Should fix | Stage0-exit-session2-fixes-round3.md:113 | Reported · Two overlapping calendar syncs can create duplicate or orphaned  | Closed (PRs #64–#68) |
| R628 | Should fix | Stage0-exit-session2-fixes-round3.md:124 | The calendar sync warning promises a retry that doesn't exist | Closed (PRs #64–#68) |
| R629 | Should fix | Stage0-exit-session2-fixes-round3.md:129 | Verified (CASE) / Reported (locking) · The R609 fix locks too much and can  | Closed (PRs #64–#68) |
| R630 | Should fix | Stage0-exit-session2-fixes-round3.md:138 | The readiness check can keep a finished failure as its in-flight probe | Closed (PRs #64–#68) |
| R631 | Should fix | Stage0-exit-session2-fixes-round3.md:147 | Reported · The Bicep documentStorageProvider isn't connected to the app | Closed (PRs #64–#68) |
| R632 | Should fix | Stage0-exit-session2-fixes-round3.md:153 | Reported · A transaction can silently roll back but report success | Closed (PRs #64–#68) |
| R633 | Suggestion | Stage0-exit-session2-fixes-round3.md:160 | valueBySystemKey now skips inactive values, so the ! non-null assertions (s | Closed (PRs #64–#68) |
| R634 | Suggestion | Stage0-exit-session2-fixes-round3.md:164 | Make expectedVersion required in putKeyDate. | Closed (PRs #64–#68) |
| R635 | Should fix | Stage0-exit-session2-fixes-round4.md:47 | Reported · The R621 backfill can tag several tasks per matter | Closed (PRs #64–#68) |
| R636 | Should fix | Stage0-exit-session2-fixes-round4.md:55 | Reported · The intake routing change needs an upgrade note | Closed (PRs #64–#68) |
| R637 | Should fix | Stage0-exit-session2-fixes-round4.md:62 | A caller-supplied flag skips the restricted-matter check | Closed (PRs #64–#68) |
| R638 | Should fix | Stage0-exit-session2-fixes-round4.md:72 | Reported · Reminders skipped because their rows are locked are put off for  | Closed (PRs #64–#68) |
| R639 | Should fix | Stage0-exit-session2-fixes-round4.md:80 | Calendar sync lease gaps go to the Outlook sync backlog item | EXCEPTION: record only; feature-list row 8 |
| R640 | Should fix | Stage0-exit-session2-fixes-round4.md:91 | Reported · The storage parity check reads the base config, not the effectiv | Closed (PRs #64–#68) |
| R641 | Should fix | Stage0-exit-session2-fixes-round4.md:100 | The data reset help article claims something false | Closed (PRs #64–#68) |
| R642 | Should fix | Stage0-exit-session2-fixes-round4.md:106 | Reported · "D8" means two different decisions | Closed (PRs #64–#68) |
| R643 | Should fix | Stage0-exit-session3-shared.md:87 | Negotiated rate permissions don't match the help (D9 = (a)) | Closed (fix/s0-shared-rates-and-org) |
| R644 | Should fix | Stage0-exit-session3-shared.md:101 | Reported · Org structure saves aren't validated, and the audit has no before-image | Closed (fix/s0-shared-rates-and-org) |
| R645 | Should fix | Stage0-exit-session3-shared.md:145 | Reported · Row 29's "What's missing" overstates what's done | Closed (docs/s0-shared-backlog-and-help) |
| R646 | Should fix | Stage0-exit-session3-shared.md:109 | Six notification categories are never sent (item 32) | Closed (fix/s0-shared-notifications-and-signoffs) |
| R647 | Should fix | Stage0-exit-session3-shared.md:120 | Register reminders skip email and Teams | Closed (fix/s0-shared-notifications-and-signoffs) |
| R648 | Should fix | Stage0-exit-session3-shared.md:125 | Home-queue sign-off approvals bypass the registers engine (H2) | Closed (fix/s0-shared-notifications-and-signoffs) |
| R649 | Should fix | Stage0-exit-session3-shared.md:133 | Reported · Write-off requests aren't audited or notified | Closed (fix/s0-shared-notifications-and-signoffs) |
| R650 | Should fix | Stage0-exit-session3-shared.md:138 | Reported · Two ID counters for SO- references | Closed (fix/s0-shared-notifications-and-signoffs) |
| R651 | Should fix | Stage0-exit-session3-shared.md:150 | Help corrections (sign-off-queue, registers-engine, home-and-profile-screens) | Closed (fix/s0-shared-notifications-and-signoffs & docs/s0-shared-backlog-and-help) |
| R652 | Should fix | Stage0-exit-session3-shared.md:155 | Reported · Backlog corrections (docs/roadmap/feature-list.md) | Closed (docs/s0-shared-backlog-and-help) |
| R653 | Should fix | Stage0-exit-session3-shared.md:171 | Record the open fix-ID exceptions in the backlog by name & permanent register (D10) | Closed (docs/s0-shared-backlog-and-help) |
| R654 | Suggestion | Stage0-exit-session3-shared.md:199 | clients-and-contacts Help article, B-row test citations, row 46, ADR 0032 §3 note & Stage 0 bug count | Closed (docs/s0-shared-backlog-and-help) |
