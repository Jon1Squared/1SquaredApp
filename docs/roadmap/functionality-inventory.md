# Functionality inventory

Compiled on 6 November 2026 from branch `fix/testing-fixes` (commit `a0a5534`) by reading the code. Use it alongside `status-review.md`, which rates the same functionality against the roadmap list.

**Tags**
- **[Real]**: persists or reads real data and works end to end in the app.
- **[Stub]**: the UI exists but the action sends nothing, simulates a backend, or is not connected.
- **[Demo]**: hard-coded demo content. It appears when seeded demo matters or PMS demo data are present (`hasDemoSeedData` in `HomeClient.tsx`, `isSeededDemoMatter` in `MatterProfileClient.tsx`).
- **[Untested]**: no automated tests found.

## 1. Sign-in, shell and navigation
- **[Real] Microsoft Entra ID sign-in.**
  - OIDC with PKCE, state and nonce; RS256 JWT verification with a JWKS cache; checks aud/tid/iss/exp; signed 8-hour session cookie; open-redirect protection; sign-out.
  - Routes: `/api/auth/login`, `/api/auth/callback/microsoft-entra-id`, `/api/auth/logout`.
  - Code: `src/server/entraAuth.ts`. Tests: `core/tests/entra-auth.test.ts`.
- **[Real] MFA detection** from the `amr`/`acrs` claims (`core/src/domain/rbac/entra.ts`). Admin permissions require MFA.
- **[Real] Automatic employee provisioning** on first sign-in, matched by Entra object ID (`resolveOrProvisionEntraEmployee`, `src/server/services.ts`).
- **[Real] Login screen** with a configuration-missing notice (`LoginScreen.tsx`).
- **[Real] Left-rail menu** filtered by role: Home, Enquiries & Quotes, Tasks, Key dates, Matters, People, Organisations, Finance, Risk & compliance, Admin, Help (`AppShell.tsx`, `getLeftRailVisibility`).
- **[Real] Header menus:** "New" menu (enquiry, quote, task, matter, person, organisation), global search box, notifications bell, "Needs attention" list, account menu with light/dark theme.
- **[Real] "Viewing as"** role switcher. It changes presentation only and never permissions (ADR 0013).
- **[Demo] Demo persona switcher.** Eight personas, from fee earner through to admin. Only available outside live/production when `enableDemoMode` is set.
- **[Stub] "Start billing run"** in the Finance view only shows a fixed toast.

## 2. Home pages (role dashboards)
- **[Real] Role-based Home pages** for Fee earner, Partner, Support staff, Business development, Finance, Risk & compliance, Practice manager and System administrator.
  - Built from 39 panels and 35 headline cards (`src/domain/homeConfig.ts`).
  - Admins can configure them per role. Tests: `src/domain/home.test.ts`.
- **[Real] Panels and actions that work on real data:**
  - To Do (tasks, key dates, enquiry deadlines); My tasks today (complete/start/claim)
  - My enquiries awaiting contact (log contact); My active matters with PMS WIP and debt
  - Team queue (claim); Quick enquiry capture with a duplicate check
  - Callback SLA queue; Unassigned enquiries; Team task queue for supported fee earners
  - Sign-offs & approvals (approve/discuss)
  - Aged debt by band; Overdue invoices worklist (log call / reminder / escalate)
  - WIP ready to bill (request bill, flag write-off); Disbursements awaiting billing
  - Performance by practice area; Fee-earner utilisation; Top clients
- **[Demo] Panels that show fixed content, or nothing without demo data:**
  - Key dates 14 days; Waiting on client; Documents & correspondence queue
  - Matter openings checklist; Upcoming completions
  - Outcomes & conversion; Channels & referral sources; Matters needing partner attention
  - Enquiries by practice area; Key client & referrer touchpoints
  - Client account / SRA Rule 2.5 monitor
  - AML & CDD queue; Conflicts awaiting decision; High-risk matters / PEP register; Undertakings & file reviews; Complaints & breaches; Overdue compliance by team
  - New business pipeline (88% SLA); Exceptions register
  - Several headline-card figures, such as Team WIP, chargeable hours and the cash target.
- **[Stub]** Many buttons inside the demo panels only show a toast (chase, nudge, verify ID, remind team lead and so on).

## 3. Enquiries and intake
- **[Real] Enquiries & Quotes list.**
  - Tabs: Team queue, Mine, My drafts, All open, Open quotes, Closed.
  - About 10 filters, shown as removable chips; sortable columns; compact/card layouts (`EnquiriesListClient.tsx`, `DataList.tsx`).
- **[Real] New or edit enquiry** (`EnquiryFormClient.tsx`).
  - Fields: caller, contact details, privacy notice, source, preferred contact, practice area, urgency, summary, next task.
  - UK address lookup (Ideal Postcodes).
- **[Real] Draft enquiries:** save as draft (no routing or SLA), or send to team (`saveEnquiryRecord`). Tests: `draftEnquiries.test.ts`.
- **[Real] Automatic routing** to the practice-area team, falling back to Intake (`resolveRoutedTeam`).
- **[Real] First-contact SLA** in working hours, using England & Wales bank holidays (`calculateFirstContactDue`, `src/domain/dates.ts`). Raises an automatic contact task.
- **[Real] Enquiry actions:**
  - Take, assign (notifies the assignee), record contact attempt (suggests "No response" after N attempts).
  - Decline (reason required), refer out, close as no response, reopen.
  - Tabs: Contact log, Tasks, Audit trail.
- **[Stub] Send email.** There is a rich-text editor, but `sendEnquiryEmailRecord` only writes an audit entry; nothing is sent.
- **[Real] Quick conflict check** on enquiries, quotes, people and organisations.
  - Matches on exact, fuzzy and sound-alike names, email, email domain, phone and address; link/unlink matches.
  - Tests: `domain.test.ts` (about 30 cases).
- **[Real] Convert enquiry to matter** (`prepareEnquiryConversion`, `finalizeEnquiryConversionToMatter`).
  - Re-runs the conflict check and blocks on blocking conflicts.
  - Creates or links the person and organisation, carries key dates across, and raises a "Complete matter opening" task.
- **[Real] Retention anonymisation** of closed enquiries (`anonymiseExpiredEnquiries`). Retention period is configurable (default 12 months). Run by hand from Admin or the enquiry; there is no scheduler. [Untested]
- **[Real] Enquiry settings:** emergency SLA hours, failed-attempt threshold, working day hours, retention months.

## 4. Quotes [Untested]
- **[Real] Create or edit a quote** with a client, work type, fee basis (fixed, estimate, capped, hourly), fee lines, VAT at a hard-coded 20% (can be overridden), validity, and a quick conflict check. References are `QTE-YYYY-NNNN`.
- **[Real] Quote actions:** mark as sent, log a follow-up, revise (keeps version history and supersedes the old version), record the outcome (accepted, or declined with a reason). Quotes expire automatically. There is a status timeline.
- **[Stub] "Mark as sent"** only changes the status; nothing is sent.
- **[Real] Convert a quote to a matter.** Also closes any linked enquiry.

## 5. Matters
- **[Real] Matters list.** Tabs: All, My matters, Transactional, Contentious, Advisory. Filters: practice area, status, fee earner, billing basis. Shows WIP and debt from the PMS.
- **[Real] Matter opening wizard** (`MatterFormClient.tsx`):
  1. Details and team: clients, instructing contact, department and work type, partner, fee earner, team.
  2. Costs: fee basis, rate source, grade rates, estimate or cap, disbursement presets, payment on account, partner sign-off.
  3. Risk assessment: question bank with scoring.
  4. Parties: two-field relationship and capacity model.
  5. Conflict search: results grouped by party, a decision per hit, and a warning if parties change after the search.
  6. Outcome and declaration: cleared, referred to Risk, or declined, plus a reviewer view with comments.
  7. More details: custom fields and work-type-specific fields.

  The form also has a progress sidebar, save as draft and assign.
- **[Real] AI pre-fill** from documents or emails (.docx, PDF, .msg, .eml), handling several matters per pack (`/api/matters/extract`, Anthropic API). Needs an API key from the server or pasted in the UI. There is a non-AI fallback. [Untested apart from a 401 check]
- **[Real] Matter numbering:** `<client prefix>-NNNN`, never reissued (`generateMatterNumber`).
- **[Real] Status lifecycle:** Prospective → "CMI incomplete" → Open → Closed/Archived; save modes draft, submit cleared and submit referred.
- **[Real] Opening gate** (`runMatterOpeningGate`). Blocks opening when:
  - a required extension failed to load, or
  - required key dates are missing or unverified, or
  - the partner cost sign-off is outstanding (client extension).

  It writes an opening-gate record. Tests: `isolation.test.ts`.
- **[Real] Closure gate:** a matter cannot close while key dates are open.
- **[Real] Matter stages and milestones,** with stage groups. Stage numbers can be moved forward or back from the profile.
- **[Real] Three-layer matter field model:** 75 core fields, 66 subcategory rules and 590 work-type-specific fields (`src/seed/data/matterFieldModel.json`).
- **[Real] Matter profile tabs:**
  - Overview; Parties.
  - Documents: SharePoint store plus generated documents.
  - Tasks & dates.
  - Time & billing (PMS).
  - Compliance: conflict record with re-run, risk assessment, opening record, PDF exports.
  - Activity; Record (taxonomy axes, metadata, audit).
- **[Real] Opening record snapshot** and client-side PDFs of the matter opening, conflict check and risk assessment (`matterOpeningRecord.ts`). [Untested]
- **[Real] Engagement letter status fields.** Generating a Client Care Letter marks the engagement letter as drafted.
- **[Real] Restricted matters:**
  - Staff matters and ethical walls are derived automatically and give an allow-list (`restrictedAccessUserIds`).
  - They can be lifted with a reason and the `matter:restriction:lift` permission.
  - Visibility is filtered everywhere (`src/server/visibility.ts`).
- **[Real] Ownership change** (department or team) needs `matter:reassign_ownership` and syncs to the document store.
- **[Demo]** Overview financials for seeded matters, demo tasks, the archived DMS document list and the AML / engagement letter "done" state on seeded matters.

## 6. Conflict checking
- **[Real] Full matter conflict search** (`searchMatterConflicts`). Hits on restricted matters are redacted and audited as counts only.
- **[Real] Conflict review workflow.** Referred checks create a "Conflict review" task routed by tenant configuration (`conflictReview.assigneeTeamKey` / `assigneeRoleKey`). Decisions require `risk:view` and are audited. Tests: `isolation.test.ts` (R144–R189).
- **[Real] Conflict check PDF** export.

## 7. Matter parties and taxonomy
- **[Real] Two-field party model:** 8 relationships, 70 capacities in 7 groups, 11 work-type profiles. Client capacity is inferred; usage counts are tracked.
- **[Real] Migration** from the legacy party role, with a migration report. Tests: `matterParties.test.ts`.
- **[Real] Admin for the taxonomy:** relationships, capacities and work-type profiles. [Untested]

## 8. People and organisations (CRM)
- **[Real] People list.** Tabs: All active, External, Enquiry stage, Firm staff, Archived.
- **[Real] Organisations list.** Tabs: All, Clients, Prospects, Referrers & others, Archived.
- **[Real] Person form:** personal and contact details, organisation, relationship, compliance (verification status, method, date and reviewer), employee details (see section 15), custom fields.
- **[Real] Organisation form:** identity, commercial relationship, compliance and billing, VAT number, parent organisation, custom fields.
- **[Real] Profiles** with overview, matters, documents, activity (filtered), finance (PMS), contacts and links, relationship, compliance, record and audit trail. Also notes and recently viewed.
- **[Real] Duplicate detection** (email, domain, phone, name, fuzzy, sound-alike, company number, address) with dismiss. **Merge** with history and audit. Tests: `domain.test.ts` (merge execution is untested).
- **[Real] Person–organisation links.**
- **[Real] Client groups (basic):** parent organisation, and a group finance roll-up covering parent plus direct subsidiaries.
- **[Real] UK address lookup** (Ideal Postcodes, runs in the browser).
- **[Stub] Companies House search** returns invented demo companies (`searchCompaniesHouseDemo`).
- **[Demo]** "Sanctions & PEP: Clear" and ID "Re-check due" pills are hard-coded. Some profiles show fixed demo contacts and matters.
- **[Stub]** "Record time" and "Send reminder" buttons on profiles only show a toast.

## 9. Tasks
- **[Real] Tasks list.** Tabs: My tasks, Team queue, Created by me, All open. Filters: type, team, linked record, priority, status.
- **[Real] Create a task** linked to any record, with several assignees (one shared task or separate copies), due date and priority. Assignees or the team are notified.
- **[Real] Task detail:** take, start, complete, reopen, edit, comments (notify), audit trail. There is also a task section on every record.
- **[Real] Automatic tasks** from templates set in Admin › Task settings:
  - enquiry contact (at the SLA due time)
  - complete matter opening (5 working days)
  - conflict check / conflict review
  - discuss sign-off
  - approve draft bill
  - partner escalation for an overdue invoice
  - key-date reminders (one task per date)
- **[Stub]** The `non_engagement_letter` automatic task is configured but never raised.

## 10. Key dates and limitation (most complete module)
- **[Real] Key dates per matter and enquiry:**
  - Create, or propose as provisional.
  - Two-step verification (no self-verification), reject, supersede (never deletes).
  - Record the outcome (met, missed, waived); mark not applicable; reassign team.
  - Carried from an enquiry to its matter.
- **[Real] Limitation calculator:**
  - Single or later-of triggers; years, months and days; calendar, business or clear days.
  - Weekend adjustment, minority adjustment, standstill periods, longstop.
  - Warns on unreviewed rule sets; overrides need a reason and permission.
  - Tests: `keyDateCalculator.test.ts`.
- **[Real] Reminders:**
  - Staged schedule (90/60/30/14/7/1/0 days by default), one task per date, acknowledgement, escalation to team leads or a role.
  - Respects restricted matters.
  - In-app only. The daily job is started by hand ("Run daily reminder check"); there is no scheduler.
- **[Real] Team diary** (list, month and week views) with filters, and verify/reject from the diary.
- **[Real] Compliance exceptions report** (10 exception kinds) with export.
- **[Real] Key-date opening and closure gates** per matter type.
- **[Real] Admin:** module enable, key date types, matter type settings, reminder schedules, limitation rule sets, business calendars.
- **[Real]** Eight `keydate:*` permissions; config saves require MFA.
- Tests: eight files in `src/domain/__tests__/keyDate*` plus `core/tests/key-dates-isolation.test.ts`. Ten help articles.
- **[Stub] Outlook calendar sync:** status is shown, but the Graph adapter is not implemented, so sync is always disabled.
- At runtime key dates live in the JSON store. `TenantKeyDateRepository` is used only by tests.

## 11. Documents
- **[Real] Document generation:**
  - DOCX templates with `{{placeholder | filter}}` syntax; filters date, currency, upper, title, words, address.
  - Split-run merge; built-in DOCX→PDF converter.
  - Generate from a matter, person or organisation with prompted fields and a preview.
  - Download through a short-lived signed token.
  - Code: `core/src/domain/document-generation/*`, `src/server/documentGenerationServices.ts`.
- **[Real] Template lifecycle:**
  - Draft → submit → approve/reject (no self-approval) → active → retire, with rollback.
  - Auto-mapping of placeholders; import/export of template packages.
  - Seeded Client Care and General Correspondence templates.
- **[Real] Versioned field catalogue** of 76 core fields, plus custom and extension fields. HR and payroll fields are always excluded; finance fields need `finance:view`.
- **[Real] Template usage tracking** with a governance report, CSV export and retention purge. No field values are logged.
- **[Real] Local tenant storage** (`local-fs`) with HMAC-signed, scoped download tokens and an upload malware/macro scan.
- **[Stub] Matter document store (SharePoint).** The full UI and API run against an in-memory mock Graph backend (`MockSharePointGraphBackend`); live Graph is Phase 2. Functions:
  - Per-matter folder provisioning from routing rules and folder templates (inherit/extend); link an existing folder; retry.
  - Browse, upload (resumable above 4 MiB), download, create folder, rename, move, delete, open in SharePoint.
  - Permission model built on inheritance: department, team, matter, restricted and closed. Scale guard at 4,000/5,000 unique scopes.
  - Close or reopen a matter makes its folder read-only or writable again.
  - Reconciliation scan for permission drift, with fixes.
  - Admin: stores, connection test, paste-a-URL resolution, routing rules, Entra group mappings, folder template preview/apply, health check.
  - Two-identity model (user on-behalf-of plus app provisioning), encrypted per-tenant token cache, fail-closed Sites.Selected least-privilege check.
  - Tests: `core/tests/document-store.test.ts` (27 cases including two-tenant).
- **[Stub] Azure Blob storage provider** throws on every call.

## 12. Finance (read-only from the PMS)
- **[Real] PMS demo data source:** `scripts/import-pms.ts` builds `data/pms/pms-demo.sqlite` from a demo workbook (as at 16 October 2026). It is read through `getPmsSource()` and checked against the workbook's check sheets in `src/pms/pms.test.ts`.
- **[Real] Matter "Time & billing" tab:**
  - Headline figures, fee estimate and history (estimate used %, alert threshold).
  - Time entries, WIP by fee earner and by age.
  - Bills and payments including credit notes; disbursements; client account ledger.
- **[Real] Client finance** on person and organisation profiles, including the group roll-up.
- **[Real] Firm-wide views:** department financials, fee-earner performance and weekly time, monthly fees billed, cash received, aged debt, invoices.
- **[Real] PMS linking:** automatic matching, manual link/unlink, create a 1Squared record from a PMS record (Admin › PMS links, matter tab).
- **[Real] Credit control actions:** log a call, "send reminder" (writes a note only; nothing is sent), escalate (creates an urgent partner task). All are audited.
- **[Real] Bill request:** creates an "Approve draft bill" task.
- **[Real] Write-off request:** creates a write-off sign-off. Approving it changes no ledger.
- **[Real] Finance attention signals:** over estimate, capped fee exceeded, bill overdue 60+ days, WIP older than 30 days, estimate revision pending.
- **[Stub] Outbound PMS commands** (open matter, update commercials, revise estimate) and **inbound reconciliation** that respects field ownership are built but only called from tests.
- There is no native time recording, billing, disbursement posting or client account transactions; all are read-only from the PMS.

## 13. Costs and rates
- **[Real] Rate cards** by department and grade, with custom client grades. Rate source is the application table or the PMS when linked. Rates can be synced from PMS fee earners.
- **[Real] Disbursement presets,** payment on account, fee estimate and cap.
- **[Real] Partner cost sign-off** above a threshold (default £25,000), enforced at opening by the client extension `nalf-matter-costs-governance`. Tests: R169/R178.
- [Untested] rate lookup and costs maths (`matterCosts.ts`).

## 14. Approvals and sign-offs
- **[Real] Sign-off queue** (write-off, matter opening, undertaking kinds): approve, or discuss (creates a task). Only write-offs are created by code; the other kinds come from seed data.
- **[Real]** Partner costs sign-off; conflict review decision; template approval; key-date verification.

## 15. People, HR and employment
- **[Real] Employment record** with these sections:
  - core employment; contract and terms; fee earner details (including charge-out rate history)
  - right to work and vetting; payroll and benefits (masked NI and bank details)
  - emergency contacts; sensitive information; systems and access
- **[Real] Joiners:** next employee number, default record, probation end date.
- **[Real] Movers:** effective-dated history.
- **[Real] Leavers:** leaver effects, 6-year HR retention date, finding records the leaver owns, bulk reassignment.
- **[Real] Staff as clients:** detects staff matters.
- **[Real] Audited access** to payroll and sensitive data (`view-payroll`, `view-sensitive`) behind five `employee:*` permissions, with "reveal" logging.
- **[Real] Department defaults** for new matters (fee earner list filtered by department).
- **[Real] Firm employees admin:** roles, Home roles, supported fee earners.
- Tests: `src/domain/employment.test.ts` (thorough).

## 16. Search, notifications and attention
- **[Real] Global search** across enquiries, tasks, matters, people and organisations. Weighted scoring, highlighted matches, keyboard navigation. The index is built per request from records the user can see. (The "ask anything" placeholder has no AI behind it.)
- **[Real] In-app notifications** (task assigned, team task arrived, task comment, enquiry assigned, task overdue) with mark read / mark all read. No email or Teams delivery.
- **[Real] Attention signals** on records: possible duplicate, verification expired, potential conflict, review overdue, stale (12 months), overdue task, unclaimed urgent enquiry, late first contact, plus the finance signals.

## 17. Audit
- **[Real] Audit log** (`writeAudit`) with record diffs, an audit trail on every record, and separate audit streams for key dates and the document store (no personal data in document-store audit).

## 18. Permissions and roles (RBAC)
- **[Real] Central permission registry:** 49 permission keys covering employee, document template, document, document store, finance, risk, matter, task, enquiry, admin, rbac and keydate. Each key has a sensitivity level and an MFA flag.
- **[Real] Ten built-in roles:** fee earner, supervisor, partner, legal secretary, intake, enquiries coordinator, finance, risk & compliance, managing partner, admin.
- **[Real] Single resolver:**
  - roles + department grants + relationship grants (team lead, line manager) + per-person overrides (revoke wins)
  - MFA-pending permissions; per-request cache
  - Code: `core/src/domain/rbac/resolver.ts`.
- **[Real] Restricted matter access** (`canAccessMatter`): staff matters and ethical walls via the allow-list or `matter:restricted:access`.
- **[Real] Entra app-role and group mapping** to role keys; authority mode token, store or hybrid.
- **[Real] RBAC admin:** permission matrix, department and relationship grants, Entra mapping, per-person overrides with preview. Blocks self-modification and privilege escalation and requires MFA.
- Tests: `core/tests/rbac.test.ts` (26 cases).

## 19. Administration
Admin needs `admin:access` with MFA. Tabs:
- **Home pages:** per role cards and panels, firm thresholds, preview, reset.
- **Lists & taxonomy:**
  - 56 choice lists with about 744 values; add, edit, deactivate (system values are protected), reorder, "where used".
  - Work-type settings; matter stage groups; party taxonomy.
- **Organisation structure & teams:** divisions, departments, teams, offices, cost and profit centres.
- **Rates & matter costs.**
- **Document templates & usage.**
- **Document stores & DMS** (mock backend). The `/admin/document-stores` URL slug is missing and falls back to Lists.
- **Enquiry settings** and retention anonymisation.
- **Task settings** (automatic task templates).
- **Key dates & limitation.**
- **Custom fields:** six field types, screen location, mandatory, reorder; validated on save.
- **Firm employees.**
- **RBAC & Entra ID.**
- **PMS links.**
- **Demo data:** clear all data (new client deployment), or load the demo dataset.

## 20. Help and documentation
**[Real]** In-app help reader with 19 articles (`src/docs/articles/`, `registry.ts`):
- **General:** about the docs; sign-in, RBAC & MFA; deployment & security; engineering process.
- **Features:** document generation; SharePoint document store; Sites.Selected setup; quick conflict check; duplicate checks.
- **Key dates (10):** overview, managing, limitation calculator, verification, team diary, reminders, calendar sync, exceptions, administration, integration across the workspace.

## 21. Platform core (multi-tenant architecture)
- **[Real] Tenant context** built only from a verified OIDC token. Detects forged tenant claims, URL overrides and header overrides. A correlation ID is required.
- **[Real] Hosting modes:** single-tenant (client Azure) or multi-tenant (hosted), set by configuration. Environments are dev, test, training and live.
- **[Real] Tenant-scoped repositories** for documents, the document store and key dates. Cache keys must include the tenant, and background jobs refuse to run without a tenant ID.
- **[Stub] Postgres database per tenant** (`PostgresTenantCluster`) and the migration runner are simulated in memory. Four reversible per-tenant migrations are defined (document generation, document store, key dates, reminder column).
- **[Real] Configuration engine** (Zod):
  - Tenant configuration covers branding, firm, conflict review routing, feature flags, matter costs, integrations/PMS sync, custom fields, document generation, RBAC, document stores, routing, folder templates, document access and key dates.
  - Environment overlays; deprecation warnings.
  - JSON schemas in `core/schemas/`.
- **[Real] Extension platform:**
  - Public API `@platform/core-api` (v1.1.0); manifest validation; core API range check.
  - 14 extension permissions and 11 hook points; hooks have timeouts (default 2s) and error isolation (opening fails closed).
  - Generated extension registry; one client extension (`nalf-matter-costs-governance`).
  - Unused surface: `afterMatterCostsCalculate`, `afterMatterOpen`, `uiSlots`, `onPmsOutboundCommand`.
- **Declared but not applied:** `aiProviderChoice`, `clientCodeAllocation`, `companiesHouseApiKeyVaultRef`.

## 22. Infrastructure, CI and tooling
- **[Real] Bicep** (`core/infra/main.bicep): VNet, Key Vault (RBAC, purge protection, private network), Linux App Service with managed identity and Key Vault references, and an optional storage account with Defender malware scanning. There is no Postgres resource, no Application Insights, and no PDF converter container.
- **[Real] Platform CI** (`.github/workflows/ci.yml`): install, generate extensions, type check, lint, invented-fixture check, tests, build. Local parity through `npm run ci`.
- **[Real] Claude PR review** workflow against the architecture standard.
- **[Real] Invented-fixture guard:** only RFC 2606 email domains and Ofcom drama phone numbers are allowed.
- **[Real] Demo and seed data:** firm "Not A Law Firm LLP" with 52 people, 16 organisations, 16 matters, 12 enquiries, 6 quotes, 29 tasks, 3 key dates and 26 PMS links. Includes store repair and migration on load.
- **[Stub] Firestore sync** of firm settings and counters only (`store.ts`).

## 23. Tests at a glance
- **Core** (`core/tests/`):
  - `isolation.test.ts` (41): two-tenant isolation, forged claims, extensions, conflicts, restricted matters, opening gate.
  - `document-generation.test.ts` (10); `document-store.test.ts` (27); `entra-auth.test.ts` (12); `key-dates-isolation.test.ts` (5); `rbac.test.ts` (26).
  - `sharepoint-live.integration.test.ts`: opt-in, and currently runs against the mock.
- **Host** (`src/`):
  - `domain.test.ts` (56); `employment.test.ts` (15); `home.test.ts` (11); `homeTasks.test.ts` (3); `pms.test.ts` (9); `storeRepair.test.ts` (3).
  - In `__tests__/`: `draftEnquiries` (11), `keyDateCalculator` (8), `keyDateCalendarSync` (5), `keyDateDiaryAndExceptions` (4), `keyDateReminders` (6), `keyDateVerificationAndLifecycle` (10), `keyDatesPermissionsAndConfig` (17), `listHelpers` (4), `matterParties` (8), `documentGeneration` (4).
- **No tests:** quotes, task services, notifications, merge execution, PMS link services, costs config, org structure, party taxonomy admin, anonymisation, AI extraction, PDFs, matter numbering, clean deployment.

## 24. Architecture decision records
ADRs 0001–0023 in `docs/decisions/` cover:
- the transitional store
- document generation (0002–0009)
- RBAC and identity (0010–0016, 0018)
- the document store and SharePoint (0017, 0019–0021, 0023)
- key dates (0022)

