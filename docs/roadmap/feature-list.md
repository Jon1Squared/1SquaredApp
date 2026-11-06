# 1Squared feature list and status

This is the master backlog for 1Squared. The Word document is a copy for sharing; when the two differ, this file wins. Last updated 6 November 2026.

## How to maintain this file (people and AI tools)

- **Never renumber.** IDs (1–45, F1–F18, P1–P12, B1–B10, E1–E9, Q1–Q2) are stable references used in plans, branches and pull requests. New items take the next free number in their series.
- **Update statuses in the same pull request** that changes the code, and add the PR number to the item's "What exists" text where useful.
- **Use the strict bar.** Completed means the item works end to end, with server-side permission checks, tests (including two-tenant tests where it touches data) and a help article. Otherwise use Partly built.
- **Statuses:** Completed · Partly built · Built differently (exists in another form, often read-only from the PMS) · Not started · Suggested (future idea, not agreed) · Open (questions).
- **Stages:** 0 Foundations and hardening · 1 Intake to open matter · 2 Running the matter · 3 Risk and compliance · 4 Closing and after · 5 Firm-level · After MVP (time, billing and accounts) · Future. The MVP is stages 1 to 5 on top of stage 0.
- **Plans and decisions:** stage plans live in `docs/roadmap/` (starting with `stage-0-plan.md`); decisions are recorded in `docs/decisions/`.
- **Source of the current statuses:** read-only review by Claude Code on 6 November 2026 (branch `fix/testing-fixes`, commit `a0a5534`), verified against the same commit by Google Antigravity, then adjusted by the product owner (item 2 shown as Partly built until B7 is fixed).

## MVP

### Intake and onboarding

| No. | Item | Description | What exists | What’s missing | Stage | Status |
|---|---|---|---|---|---|---|
| 1 | Enquiry | Capturing the initial contact, source, work type and outcome, including what happens to enquiries that don’t convert. | Capture and drafts, routing to teams, first-contact SLA in working hours, contact log, decline, refer, close and reopen, conflict check, retention. An enquiry:intake_view permission. Tested. | Sending email is a stub (audit entry only). No create, edit, assign or close permissions or server-side checks; the reopen check isn’t enforced on the server (B8). No two-tenant test. Limited help. | 1 | Partly built |
| 1a | Convert to matter | Turning an accepted enquiry into a client and matter without re-keying. | Re-runs conflicts and blocks on hits, creates or links the person and organisation, carries key dates across, raises a “Complete matter opening” task. Quotes convert too. | Neither conversion step is tested. People and organisations are created before any matter:create check. Quote conversion skips the conflict check entirely (B5). New organisations are marked “Cleared” with no recorded decision. | 1 | Partly built |
| 2 | Conflict check | Searching existing clients, matters and other parties before anything is accepted, and recording the decision and who made it. | Full matter search and quick check (exact, fuzzy, sound-alike, contact details), referral and review workflow, redacted restricted hits, audit, PDF export. Two-tenant tested. | Doesn’t search instructing or billing contacts, or people’s links to organisations (B7); shown as Partly built until B7 is fixed. Data still in the transitional store. | 1 | Partly built |
| 3 | Quote and costs information | Producing estimates, fixed fee quotes and price transparency information, and following up quotes that haven’t been accepted. | Quotes on fixed, estimate, capped and hourly bases, with VAT (legal fee VAT can be overridden), versions, follow-ups, outcomes, expiry and conversion to a matter. Matter costs configuration; cost sign-off tested. | “Mark as sent” sends nothing. No tests for quote maths or rate lookup, no quote permission keys, no help. VAT rate fixed at 20%; disbursement VAT can’t be overridden. Costs admin open to any user. Quote conversion skips the conflict check (B5). | 1 | Partly built |
| 4 | Client and matter inception | Client due diligence (ID verification, source of funds/wealth, sanctions and PEP screening), matter risk assessment, matter numbering and fee earner allocation. | Opening wizard with risk questionnaire, opening gate and PDF record. ID and source of funds fields. Matter numbering. Fee earner allocation by department (complete and tested). | Risk questionnaire answers are lost on save (B1); no server-side scoring; a High rating triggers nothing; questions don’t vary by work type. Matter numbers can be reissued (B6) and aren’t configurable. CDD workflow and evidence checklist. E-ID provider and re-check schedule. Sanctions and PEP screening (the UI shows a fake “Clear”). | 1 | Partly built |
| 5 | Engagement | Client care/engagement letter, terms of business, signature tracking, and non-engagement letters for declined work. | Engagement letter status fields and a “mark as drafted” service (permission-checked, audited and tested). | Generating a Client Care Letter doesn’t mark it as drafted, because of a document type mismatch (B2). E-signature, sent and signed workflow, chasing. Non-engagement letter task is configured but never raised. Help. | 1 | Partly built |
| 6 | Money on account | Requesting, chasing and receipting payments on account before work starts. | Payment on account amount on quotes and matter costs. Read-only client ledger from the PMS. | Request, chase and receipt tracking. Opening gate on funds received. Tests. | 1 | Partly built |

### Running the matter

| No. | Item | Description | What exists | What’s missing | Stage | Status |
|---|---|---|---|---|---|---|
| 7 | Matter planning and budget | Setting the budget or estimate, milestones and key dates. | Matter stages and milestones (tested). Fee estimate and cap, rate cards, disbursement presets. Partner cost sign-off with the client extension. | Phase or task plan and budget by phase. Tests for the costs maths. General costs help (cost sign-off is documented). | 2 | Partly built |
| 8 | Key dates and limitation | Recording critical deadlines with reminders and escalation, and a second-person check on limitation dates. | The most complete module: two-step verification, limitation calculator, staged reminders and escalation, team diary, exceptions report, opening and closure gates, admin. Eight test files, nine help articles plus one cross-cutting article. | Runs on the transitional store, not the tenant-scoped repository. Reminder job is started by hand (no scheduler). Outlook calendar sync not implemented. | 2 | Completed |
| 9 | Task and diary management | Work-type-specific task templates and fee earner and supervisor task lists. | Task lists and queues, multi-assignee tasks, take, start, complete and comment, audit, automatic tasks from Admin templates, notifications. Claiming a task is permission-checked. | Server-side check on edit and reassign (anyone can change any task). Commenting has no permission or restricted-matter check (B9). Appointments and diary. Work-type task templates. Service tests. Help. | 2 | Partly built |
| 10 | Document and correspondence management | Templates, precedents, email filing and version control. | Document generation with approved templates, field catalogue and usage tracking (tested, tenant-scoped). SharePoint matter folders, built against a mock backend. | Live SharePoint connection. Email filing. Correspondence log or letter register. Document metadata still saved in the transitional store. | 2 | Partly built |
| 11 | Instructing third parties | Counsel, experts, agents and search providers, including approval of costs. | Counsel, experts and agents exist as matter party capacities (tested), with counsel and expert disbursement presets. | Instruction workflow: letter of instruction, fee terms, cost approval and deliverable tracking. | 2 | Built differently |
| 12 | Undertakings | Giving, recording, monitoring and discharging undertakings in a central register. | Only an undertaking key date type, a sign-off kind and a demo Home panel. | Register, data model, given and discharged workflow, tests. A good first use of the registers engine (item 31). | 2 | Not started |
| 13 | Matter transfer | Changing fee earner or supervisor, or handling a matter when someone leaves. | Fee earner, partner, team and department changes (permission-checked, synced to the document store). Bulk leaver reassignment. | Handover workflow with acceptance and audit. Leaver reassignment has no permission check, doesn’t confirm the person has left, ignores restricted matters, doesn’t re-permission SharePoint folders and doesn’t audit the moved records. | 2 | Partly built |
| 14 | Costs updates | Monitoring work in progress (WIP) against the estimate and triggering client updates when thresholds are reached. | Finance tab shows estimate used %, alert threshold, estimate history and WIP from the PMS. Over-estimate alerts (tested). | In-app estimate revision. Record of costs updates sent to the client. Prompts. Figures exclude restricted matters but reach every user without a finance permission check. | 2 | Partly built |

### Risk and compliance

| No. | Item | Description | What exists | What’s missing | Stage | Status |
|---|---|---|---|---|---|---|
| 15 | File review | Periodic supervisory reviews, the checklist, actions arising and sign-off. | Demo Home panel only. | Everything. | 3 | Not started |
| 16 | Ongoing AML monitoring | Re-verification of ID, refreshed risk assessments and suspicious activity reporting to the MLRO. | AML and source of funds fields, opening risk questionnaire, alerts for expired or 12-month-old verification (tested). | Periodic CDD refresh, re-screening, sanctions and PEP monitoring, MLRO reporting. AML queue and PEP panels are demo content. | 3 | Partly built |
| 17 | Complaints | Logging, acknowledgement, investigation, response within the 8-week window and Legal Ombudsman signposting. | Demo Home panel only. | Data model, workflow, 8-week deadline, Legal Ombudsman signposting, reporting, tests. | 3 | Not started |
| 18 | Breach and incident reporting | Reporting to COLP/COFA, the decision on whether to report to the SRA, and lessons learned. | Demo Home panel only. | Register, reportability assessment, COLP/COFA workflow, lessons learned. | 3 | Not started |
| 19 | Data protection requests | Subject access requests, erasure requests and data breach handling. | Enquiry anonymisation only. | Subject access, erasure and rectification requests, deadlines, search and export. | 3 | Not started |
| 20 | Supervision | Oversight of trainees and junior staff, plus approval workflows. | Partner cost sign-off, conflict review approvals, key date verification, a generic sign-off queue (tested). | Approver rules and personal queues. Any user can approve or discuss a sign-off: no permission, matter access, assigned-partner or self-approval check. | 3 | Partly built |

### Closing and after

| No. | Item | Description | What exists | What’s missing | Stage | Status |
|---|---|---|---|---|---|---|
| 21 | Matter closure | Closure checklist, final bill, zero balances, undertakings discharged and closing letter. | Closure blocked while key dates are open (tested). SharePoint folder made read-only on close. Closure and destruction date fields. | Closure checklist (final bill, balances, undertakings, deeds, closing letter). Closure field rules not wired in. Dates not set automatically. | 4 | Partly built |
| 22 | Client feedback | Post-matter survey and review requests. | One field and a taxonomy milestone. | Surveys, capture and reporting. | 4 | Not started |
| 23 | Archiving, retention and destruction | Retention periods by work type, and destruction approval and recording. | Enquiry retention anonymisation (configurable, audited). HR retention dates. Matter destruction date as a key date. | Matter archive and destruction workflow, approval, certificate, legal hold. A scheduler. Permission check on anonymisation, and the retention check can be bypassed for a single enquiry (B3). | 4 | Partly built |
| 24 | Wills and deeds storage | (If relevant) registers for safe custody, and release and withdrawal. | Will date and location field only. | Safe custody register, check in and out, release workflow. | 4 | Not started |

### Firm-level

| No. | Item | Description | What exists | What’s missing | Stage | Status |
|---|---|---|---|---|---|---|
| 25 | Joiners, movers and leavers | System access, matter reallocation and file reviews on departure. | Employment records with effective-dated history, leaver effects, retention dates, audited payroll and sensitive access. Thoroughly tested. | Joiner and leaver checklists (IT, access, training). Safe leaver reassignment. Two-tenant test. Help. | 5 | Partly built |
| 26 | Reporting and KPIs | WIP, lockup, conversion rates, matter ageing and compliance dashboards. | Configurable role-based Home pages. Real PMS finance views. Key date exceptions report with export. | Many cards show hard-coded figures. No report builder, reports page or export. No real compliance KPIs. Four firm-wide finance roll-ups aren’t filtered for restricted matters. | 5 | Partly built |
| 27 | Marketing and referrals | Referrer tracking, consent management and cross-selling triggers. | Referrer and source fields on enquiries and matters. Origin and referral lists. | Introducer records, referral agreements and fee share, consent management, cross-selling triggers, tests. | 5 | Partly built |

### Foundations

| No. | Item | Description | What exists | What’s missing | Stage | Status |
|---|---|---|---|---|---|---|
| 28 | Clients, contacts and matter parties | One record per person or organisation, linked to matters in a stated capacity (client, other side, contact at a client organisation). | People, organisations and links. Duplicate detection and merge. Two-field party model (8 relationships, 70 capacities) with migration. Near complete. | Merge leaves records pointing at the merged-away person or organisation (B4). Server-side checks on merge and party admin. Tests for merge execution. Two-tenant test. | 0 | Partly built |
| 29 | Departments and work types | Configurable work types that drive task templates, key dates, risk questions, retention periods and reporting. | Org structure (entities, departments, teams, offices, cost centres), hierarchical work types, team routing, admin screens. Work types already drive key date rules and gates, the matter field model, party profiles, stage groups, document and folder routing, and department defaults. | Tests, help and permission checks on save. Work types don’t yet drive task templates, risk questions or retention. | 0 | Partly built |
| 30 | Rates and charging arrangements | Rate cards by grade, client- and matter-specific rates, fixed and capped fees, and VAT treatment. | Rate cards by department and grade, PMS rate sync, charge-out rate history (tested), fixed, estimate, capped and hourly quotes. Default costs config and cost sign-off tested. | Tests for rate lookup, the costs snapshot and quote maths. Negotiated client and matter rates. CFA/DBA models. Permission check on costs config. | 0 | Partly built |
| 31 | Registers, approvals and reminders engine | One reusable core capability for registers with owners, due dates, approvals, escalation and audit. | Three separate mechanisms: sign-offs, template approval and key date reminders. | One reusable engine with approver rules, then undertakings, complaints, breaches, data requests, file reviews and deeds built on it. | 0 | Built differently |
| 32 | Search and notifications | Firm-wide search across clients, matters and documents, and a single in-app and email notification service. | Global search over the records each user can see. In-app notifications and bell. Attention signals (tested). | Search doesn’t cover documents, quotes or key dates. Email delivery (Graph from a 1Squared mailbox for now, D9) and Teams delivery, preferences, digests. Server-side search that scales. Notification tests. A demo firm name is hard-coded in search. | 0 | Partly built |

### Further MVP items

| No. | Item | Description | What exists | What’s missing | Stage | Status |
|---|---|---|---|---|---|---|
| 33 | Information barriers | Restricting access to a client or matter beyond staff matters, set from a conflict decision and recorded with who approved it. | Staff matters and ethical walls through allow-lists, lift with permission, visibility filtering everywhere, redacted conflict hits, and barriers on generated documents and SharePoint matter folders (tested, ADR 0014). | Ethical wall flag not checked directly. Manual wall screen. Barriers on people, organisations and non-matter documents. Four firm-wide finance roll-ups not filtered. | 1 | Partly built |
| 34 | Intake integrations | ID verification and sanctions screening provider, e-signature for engagement letters, and payment links for money on account. | UK address lookup (Ideal Postcodes). | ID verification, sanctions screening, e-signature, payments, live Companies House (currently invents results). Remove the hard-coded API key. | 1 | Partly built |
| 35 | Data migration and import | Loading clients, matters, key dates, undertakings and documents from a firm’s current system, with reconciliation reports. | Demo PMS workbook import, per-tenant schema migrations, PMS record linking. | User-facing import of clients, contacts and matters with mapping, validation, reconciliation and rollback. | 5 | Built differently |

## Known bugs

Fix the High items in stage 0, before any real client data goes in.

| No. | Bug | Item | What happens | Fix | Severity | Stage | Status |
|---|---|---|---|---|---|---|---|
| B1 | Risk answers lost on save | 4 | The server strips the risk assessment from the saved fields before resolving it. New matters fall back to default answers, discarding everything entered in the wizard; edits on existing matters are ignored. | Stop stripping the answers, or pass them separately; score risk on the server; add tests. | High | 0 | Not started |
| B5 | Quote conversion skips the conflict check | 1a, 3 | Converting a quote creates people and organisations and marks them “Cleared” without running a conflict check. | Run the same conflict check and blocking rules as enquiry conversion; record the decision. | High | 0 | Not started |
| B7 | Conflict search misses some connections | 2 | Instructing and billing contacts and organisation links on existing matters aren’t searched unless the contact is also a party. When a person is the new client, their employer isn’t checked against adverse parties. | Extend the search to these fields and links, with tests. | High | 0 | Not started |
| B3 | Retention check can be bypassed | 23 | Anonymising a single enquiry skips the retention check, so any signed-in user can wipe personal data on any closed unconverted enquiry immediately. | Always apply the retention check; require a permission; add tests. | High | 0 | Not started |
| B4 | Merge leaves broken references | 28 | Merging only repoints links, parent organisations and notes. Matters, enquiries, quotes, tasks and PMS links still point at the merged-away record. | Repoint every reference, in one transaction, with tests. | High | 0 | Not started |
| B9 | Task comments ignore access | 9 | Commenting on a task checks neither permissions nor restricted-matter access. | Apply the matter access and task permission checks. | High | 0 | Not started |
| B10 | AI extraction creates employees | E7 | The extraction route can create employee records (including with a Partner job title) with only a sign-in check. Job titles feed role resolution. | Never create employees from extraction; require create permissions for people and organisations. | High | 0 | Not started |
| B2 | Client Care Letter not marked as drafted | 5 | The seeded template sets the document type to client_care, but the screen checks for “Client Care Letter”, so the engagement letter is never marked drafted. | Use one shared document type constant; add a test. | Medium | 1 | Not started |
| B6 | Matter numbers can be reissued | 4 | Numbers are worked out from existing matters, not a counter. If an opening is vetoed or the latest matter is deleted, its number is used again. | Use a per-tenant counter that never goes backwards. | Medium | 1 | Not started |
| B8 | Reopen permission not enforced | 1 | The reopen check is used to show the button but not called when reopening on the server. | Call it in the reopen service. | Medium | 0 | Not started |

## Platform-wide gaps

These cut across many items and belong in stage 0.

| No. | Issue | What the review found | Action | Status |
|---|---|---|---|---|
| P1 | Server-side permission checks | Checks are built and tested for matters, key dates, document generation, SharePoint, HR, RBAC and Home admin, and claiming tasks. Elsewhere actions only check sign-in: any user can wipe or reset data, approve sign-offs, anonymise enquiries, reassign a leaver’s records, merge records, save other Admin settings (including custom fields and picklists), link PMS records, edit any task, and create people, organisations and employees through AI extraction. | Add a permission check to every remaining server action, with tests. Start with data wipe, sign-off approval and Admin saves. | Partly built |
| P2 | Move off the transitional store | Everything except documents runs on the JSON store (ADR 0001). The tenant key date repository is only used by tests. The per-tenant Postgres database is simulated in memory. Even document generation and the document store load and save their metadata through the JSON store; only file contents are stored separately. | Tenant-scoped repositories per module on a real database per tenant, module by module, starting with key dates. | Partly built |
| P3 | Tenant-scope the PMS data | PMS figures come from one process-wide SQLite file with no tenant scoping. | Put PMS data behind the tenant-scoped data layer. | Not started |
| P4 | Finance data exposure | Matter-level finance is filtered for restricted matters on the server (tested). But finance data goes to every user without a finance permission check (one check is hard-coded to true), and four firm-wide roll-ups aren’t filtered for restricted matters. | Gate finance data on finance:view and finance:view_matter on the server, and filter the four roll-ups. | Partly built |
| P5 | Secrets in code | An Ideal Postcodes API key is hard-coded and exposed to the browser. The AI route accepts an API key from the browser. | Rotate the key now, move it to Key Vault, remove the browser key option. | Not started |
| P6 | Demo content in the product | Home and matter screens contain many hard-coded panels, figures and statuses (including a fake “Sanctions & PEP: Clear”), toast-only buttons and demo firm names. | Show real data or an honest empty state. Keep demo content in seed data only. | Not started |
| P7 | Tenant settings that do nothing | Seven settings are declared but ignored: aiProviderChoice, clientCodeAllocation, companiesHouseApiKeyVaultRef, enableAiMatterExtraction, enableMatterCostsGovernance, enablePmsLiveRateSync and pmsConnectionSecretVaultRef. “AI disabled” has no effect. | Apply each setting, or remove it from the schema. | Not started |
| P8 | Two-tenant isolation tests | Covered for key dates, documents, document store, RBAC and conflicts. Missing for enquiries, quotes, tasks, matters, finance, sign-offs and HR. | Add them as each module moves to tenant-scoped storage. | Partly built |
| P9 | Background job scheduler | Key date reminders and retention anonymisation are started by hand. | A tenant-aware scheduler for daily jobs. | Not started |
| P10 | Test coverage | Partial tests exist for merge planning, PMS auto-linking, costs config and sign-off, PDF conversion and reminders. None for quote maths, task services, notifications, merge execution, org structure, anonymisation, AI extraction, opening record PDFs or matter numbering. | Add tests module by module, alongside P1. | Partly built |
| P11 | Help articles | 19 articles exist. None for quotes, costs, matter opening and risk, CDD, engagement, tasks, finance, Home pages, HR, retention, sign-offs or search. A general matters article covers opening gates, cost sign-off and conflict review. | Write help as each MVP item is finished. | Partly built |
| P12 | Infrastructure gaps | The Bicep templates have parameters for a database and PDF converter but no resources for them, and no Application Insights. | Move hosting from App Service to Container Apps (D1) and add these, before the first hosted or client-hosted deployment. | Partly built |

## Existing functionality not on the list

| No. | Area | What exists | Status |
|---|---|---|---|
| E1 | Document generation | DOCX templates with placeholders and filters, PDF output, template approval workflow, versioned field catalogue, usage tracking and governance report (ADRs 0002–0009). Tested and tenant-scoped, though metadata is still saved in the JSON store and the Azure Blob provider is a stub. | Completed |
| E2 | SharePoint document store | Per-matter folders from routing rules and templates, permission inheritance, reconciliation, least-privilege access (ADRs 0017, 0019–0021, 0023). Runs against a mock backend until the live connection is built. | Partly built |
| E3 | Identity and RBAC | Entra ID sign-in with MFA, central permission registry and resolver, ten roles, per-person overrides, “viewing as”, Entra group mapping (ADRs 0010–0016, 0018). Tested. Enforcement on server actions is the gap in P1. | Completed |
| E4 | HR and employment records | Contracts, right to work, payroll and diversity, with masked fields and audited access to sensitive data. Still on the transitional store. | Partly built |
| E5 | Matter opening | Seven-step opening wizard, opening gate, immutable opening record and PDF exports. Opening record and PDFs untested. | Partly built |
| E6 | PMS integration | Record matching and linking, read-only finance tabs and firm views. Outbound commands and inbound reconciliation are built but only called from tests. | Partly built |
| E7 | AI matter extraction | Pre-fills one or more matters from emails and documents, with CRM matching. Untested, ignores the tenant AI settings, accepts a browser API key, and creates people, organisations and even employee records with only a sign-in check (B10). | Partly built |
| E8 | Configuration and extension platform | Tenant configuration engine and schemas, extension host with fail-closed hooks, custom fields, picklist engine, configurable Home pages, audit log. Custom field and picklist saves have no server-side permission checks or tests, and 4 of the 11 hooks are never called. | Partly built |
| E9 | Infrastructure and CI | Bicep templates, CI pipeline, Claude PR review against the architecture standard, invented-fixture guard. Bicep provisions App Service; moving to Container Apps (D1). | Partly built |

## Additional items: not required in the MVP

### Misc and reporting

| No. | Item | Description | What exists | What’s missing | Status |
|---|---|---|---|---|---|
| F1 | Client groups | Creating client groups. | Parent organisation and a group finance roll-up (parent plus direct subsidiaries). | Named groups, multi-level and family groups, group conflicts and reporting. | Partly built |
| F2 | Feedback system | Feedback system for quick improvements and review. | None. | Everything. | Not started |
| F3 | Bulk conflict search and matter upload | Bulk conflict search and matter upload from a spreadsheet. | None (conflict search is one record at a time). | Everything. | Not started |
| F4 | Outlook task from email | Create a task in Outlook from an email. | None. | Outlook add-in or Graph mail flow that creates tasks. | Not started |
| F5 | Word add-in for document creation | Field chooser and control over where fields go, with Word doing the layout. | None. Document generation is server-side. | Everything. | Not started |
| F6 | AI usage and cost controls | Who has used which AI functions for what and at what cost, with the ability to turn features off or choose risk levels. | AI matter extraction from emails and documents. | Usage and cost tracking, budgets, an on/off switch that works (the provider and feature flag settings are ignored). Remove the browser-supplied API key. | Not started |
| F7 | Enquiry success and failure report | Conversion and loss reasons for enquiries. | The data exists (statuses, close reasons, conversions, decline reasons). Panels are mostly demo content. | A real report with breakdowns, date range and export. | Partly built |
| F8 | Enquiry SLA report | Enquiry response against SLA by department and by user. | SLA due-time calculation (tested). Callback queue and overdue alerts are real. | SLA-met calculation (the 88% figure is hard-coded) and the report. | Partly built |

### Suggested future functionality

| No. | Item | Description | What exists | What’s missing | Status |
|---|---|---|---|---|---|
| F9 | Client portal | Matter progress, secure messaging, document upload and online payment for clients. | None. | Everything. | Suggested |
| F10 | Work-type case management | Step-by-step workflows for high-volume work such as conveyancing, probate and personal injury. | Matter stages, 590 work-type fields, automatic tasks. | Workflow templates by work type. | Suggested |
| F11 | AI matter assistant | Matter summaries, draft letters and suggested time narratives from emails and calendar entries. | AI extraction that pre-fills new matters. | Summaries, drafting and time narratives. | Suggested |
| F12 | Profitability reporting | Recovery, realisation and margin by matter, client, fee earner and work type. | PMS department financials and fee earner performance. | Recovery, realisation and margin calculations. | Suggested |
| F13 | Resource and capacity planning | Workload by fee earner against targets and availability. | Fee earner utilisation panel from the PMS. | Capacity view and allocation guidance. | Suggested |
| F14 | E-billing | LEDES/UTBMS invoices for corporate and insurer clients. | None. | Everything. | Suggested |
| F15 | Public API and webhooks | Published, versioned API for client integrations. | Extension API (@platform/core-api v1.1) with 11 hook points (4 unused). | External API and webhooks. | Suggested |
| F16 | Mobile time capture and approvals | Recording time and approving bills, payments and write-offs from a phone. | None. | Everything. | Suggested |
| F17 | Companies House and HM Land Registry lookups | Pre-filling client and property details and supporting due diligence. | Companies House search is a demo stub. | Live Companies House and HM Land Registry. | Suggested |
| F18 | Know-how and precedent bank | Searchable, approved precedents and practice notes by work type. | Document templates with an approval workflow. | Precedent and practice note bank. | Suggested |

## Open questions

| No. | Topic | Question | Proposed approach | Status |
|---|---|---|---|---|
| Q1 | Contacts with more than one persona | How do we handle a contact from a client firm who then instructs us separately as an individual? | Most of the model exists: the party model links people and organisations to matters through a relationship and a capacity. Still to confirm: a person can be a contact at an organisation and a client in their own right, the capacity is chosen on each matter, and conflict searches find them in both. The conflict search doesn’t yet follow instructing or billing contacts or a person’s organisation links (B7). Builds on item 28. | Open |
| Q2 | Estimating matter progress | Can we estimate how far through a matter is, and let the lawyer confirm or reject it? | Yes. Matter stages (item 7) and estimate used % (item 14) already exist. Combine stages completed, WIP against estimate and key dates passed into an estimate the fee earner confirms or overrides, and keep their answers to improve future estimates. Strongest once F10 is in place. | Open |

## Delivery stages

| Stage | Name | Focus | Items | Progress |
|---|---|---|---|---|
| 0 | Foundations and hardening | Make what exists safe and shared: fix the High bugs, permissions, tenant-scoped storage, real data instead of demo content, and the registers engine. | 28–32, P1–P12, High bugs | Items 28–32: 4 partly built, 1 built differently. P1–P12: 7 partly built, 5 not started. |
| 1 | Intake to open matter | From first contact to a funded, engaged matter. | 1–6, 33, 34 | 9 partly built |
| 2 | Running the matter | Day-to-day matter work and controls. | 7–14 | 1 completed, 5 partly built, 1 built differently, 1 not started |
| 3 | Risk and compliance | Supervision and regulatory processes, mostly configured on the registers engine. | 15–20 | 2 partly built, 4 not started |
| 4 | Closing and after | Closure, feedback, retention and safe custody. | 21–24 | 2 partly built, 2 not started |
| 5 | Firm-level | People changes, reporting, marketing and migrating a firm’s data. | 25–27, 35 | 3 partly built, 1 built differently |
| After MVP | Time, billing and accounts | Only where the PMS integration doesn’t already cover it. | 36–45 | 4 partly built, 4 built differently, 2 not started |
| Future | Additional items | Not required for the MVP. | F1–F18 | Listed separately |

## Time, billing and accounts (after the MVP)

These follow all other stages. Integration with the firm’s PMS may mean some are not needed.

| No. | Item | Description | What exists | What’s missing | Stage | Status |
|---|---|---|---|---|---|---|
| 36 | Time recording | Capture, narrative standards and unrecorded time alerts. | Read-only time entries and WIP from the PMS (tested). | Native time entry. “Record time” buttons only show a message. | After MVP | Built differently |
| 37 | Disbursements | Requesting, approving, paying and recovering disbursements. | Read-only from the PMS. Estimate presets. | Recording, approval, posting and payment. Supplier invoices. | After MVP | Built differently |
| 38 | Billing | Interim and final bills, bill approval, and billing from client funds. | Read-only invoices and payments from the PMS. “Request bill” creates an approval task. | Bill drafting, numbering, VAT and posting to the PMS. “Start billing run” is a stub. Bill requests check matter access but no finance permission. | After MVP | Built differently |
| 39 | Write-offs and adjustments | Approval levels and reasons. | A write-off request creates a sign-off (tested). | Approval changes nothing in a ledger or the PMS. No audit on request. Checks matter access but no finance permission. | After MVP | Partly built |
| 40 | Credit control | Debt chasing stages, escalation and suspension of work. | Aged debt and overdue invoice worklists from the PMS. Log a call. Escalate to a partner task (tested). | Reminders send nothing. Chase history, promise-to-pay, statements. finance:credit_control not enforced (only matter access is checked). | After MVP | Partly built |
| 41 | Client account transactions | Receipts, payments, client-to-office transfers and authorisation under the SRA Accounts Rules. | Read-only client ledger from the PMS. | Native receipts, payments, transfers, authorisation and SRA controls. | After MVP | Built differently |
| 42 | Reconciliations and residual balances | The five-weekly reconciliation and returning or handling dormant balances. | Demo Home panel only. | Bank, cashbook and ledger reconciliation. Residual balances (SRA Rule 2.5). | After MVP | Not started |
| 43 | Bill payers and funders | Bills addressed to someone other than the client (insurer, employer, legal expenses insurer, guarantor). | Billing contact on the matter. Litigation funder capacity. Funding source risk question. | Payer records, split billing, funder limits. Resolve the CORE-029 field ID clash. | After MVP | Partly built |
| 44 | Office accounts and VAT | Office ledger, nominal ledger and VAT, or a recorded decision to integrate with an existing accounts package. | VAT on quotes. Organisation VAT number. Read-only office and client payments from the PMS. | Office and nominal ledger, configurable VAT rate, VAT returns, or a recorded decision to leave these to the PMS. | After MVP | Partly built |
| 45 | Accountant’s report and regulatory returns | Data for the annual accountant’s report, the SRA annual return and diversity monitoring. | Demo Home panels only. | Everything. | After MVP | Not started |

