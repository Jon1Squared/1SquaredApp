# 1Squared – Role-based Home Pages: Build Prompt for Antigravity

Oct 17, 2026 · @Someone

## How to use this with Antigravity

You need two things in the project: the design files and this doc.

1. Unzip `1Squared_Home_Page_Designs.zip` into the project as `docs/designs/home/`. It holds one static HTML page per role plus the overview, each opening in a browser.
2. Export this doc as Markdown and save it as `docs/role-home-pages.md`.
3. Give Antigravity this instruction:

> Read `docs/role-home-pages.md` in full and open every page in `docs/designs/home/`. Inspect the existing codebase, then reply with an implementation plan before changing any code.

Everything from **The prompt** onwards is written to Antigravity.

The designs assume the Enquiries & Tasks and PMS Financial Data prompts have been built. Where a panel needs data that isn't there yet, Antigravity is told to show an empty state rather than invent figures.

## The prompt

You are replacing the single Home page in 1Squared with role-based home pages. 1Squared already has People & Organisations, Matters, Enquiries, Tasks, Teams and a PMS financial data connection. Every user still lands on Home, but what Home leads with depends on their role. Admins can configure which panels each role sees.

The designs in `docs/designs/home/` are the specification. Match their layout, panel order, wording, colours and spacing. They are static mockups: every number, name and list in them must come from real data in the build.

### Before you write code

1. Open every design file in a browser, at desktop and phone width.
2. Inspect the codebase: the current Home page, the user and employee model, Teams, Tasks, Enquiries, Matters, the PMS source interface, and admin screens.
3. Reply with an implementation plan in the build order below, listing files to create or change. Wait for my approval.
4. After each step, compare the running page with its design side by side before moving on.

### Goal

Each person sees the work and numbers that matter to their job the moment they sign in, can act on routine items without opening the record, and a firm can adjust the panels per role without code changes.

### In scope

- A role model on users, with more than one role per user and a **Viewing as** switcher.
- A panel framework: each panel is a self-contained component with its own data query.
- The seven role home pages shown in the designs.
- **Admin › Home pages**, based on the overview design, where a firm sets the panels for each role.
- Demo users, one per role, with easy-to-find alliterative names.

### Out of scope

- **Time recording.** Do not add timers or time entry buttons anywhere. The design shows recorded hours read from the PMS only; how time is captured will be decided later.
- Business Development and Practice Manager home pages. Leave room for them in the role list; they can be configured later from existing panels.
- Drag-and-drop layout editing by end users.

### Ground rules

- Never show invented figures. If a panel's data source isn't available, show a short empty state that says what is missing.
- PMS figures always carry their as-at date.
- Every list item's action button must work (take, complete, approve, chase, open) or be left out.
- Keep existing data intact; add new fields and records through migrations.

## Roles and demo users

### Role model

- Add a `roles` list to each user: **Fee earner**, **Partner**, **Legal secretary**, **Enquiries coordinator**, **Finance**, **Risk and compliance**, **Managing partner**, **Admin**. Keep the list admin-editable so Business Development and Practice Manager can be added later.
- A user's **home role** is the first in their list. The **Viewing as** select in the header lists only the user's own roles and switches Home instantly. Remember the last choice per user.
- Roles also control the side rail: **Finance** shows only for Finance, Partner and Managing partner; **Risk and compliance** only for Risk and compliance and Managing partner, as in the designs.

### Demo users

Create one demo employee per role with an alliterative name, so each set-up is easy to find in search. Mark them `demo: true`.

| Demo user | Email | Role | Team | Shows the work of | Design |
| --- | --- | --- | --- | --- | --- |
| Felicity Fee-Earner | felicity.fee-earner@pembrokevaughan.co.uk | Fee earner | Real Estate & Property | Dafydd Evans | `01-fee-earner.html` |
| Patrick Partner | patrick.partner@pembrokevaughan.co.uk | Partner (team lead) | Real Estate & Property | Rhian Morgan | `02-partner.html` |
| Simone Secretary | simone.secretary@pembrokevaughan.co.uk | Legal secretary | Real Estate & Property | Sarah Cole | `03-legal-secretary.html` |
| Ethel Enquiries | ethel.enquiries@pembrokevaughan.co.uk | Enquiries coordinator | Intake | Lowri Ellis | `04-enquiries-coordinator.html` |
| Frank Finance | frank.finance@pembrokevaughan.co.uk | Finance | Accounts | Nia Jenkins | `05-finance-credit-control.html` |
| Rita Risk | rita.risk@pembrokevaughan.co.uk | Risk and compliance | Risk & Compliance | Bethan Rees | `06-risk-compliance.html` |
| Martha Managing-Partner | martha.managing-partner@pembrokevaughan.co.uk | Managing partner, Partner | Corporate & Commercial | Gethin Lloyd | `07-managing-partner.html` |
| Adam Admin | adam.admin@pembrokevaughan.co.uk | Admin, and every other role | IT | None | `00-overview-admin.html` |

Create **Lowri Ellis** as a real employee in the Intake team if she doesn't exist; the designs use her.

### Demo data scope

A new demo user owns no matters, tasks or time, so their personal panels would be empty. Add a demo-only field, **Shows the work of**, linking a demo user to a real employee.

- Personal panels (my tasks, my matters, my enquiries, my figures, my fee earners) query the linked employee's records.
- A thin banner under the header says *Demo user: showing Dafydd Evans’s work*.
- Actions taken as a demo user are recorded against the demo user, never the linked employee.
- Team, department and firm panels work normally from the demo user's own roles and teams.
- The field and banner exist only on users marked `demo: true`.

### Switching between demo users

Add **Switch to demo user** to the avatar menu, listing the demo users, when the firm setting **Demo mode** is on. It signs in as that user without a password. Demo mode is off by default and only an Admin can turn it on.

## Shell and panel framework

### Page shell (every role)

- **Header:** 1Squared name, search (*Search or ask anything*), **Viewing as** select, one role-specific primary button, notifications bell with unread dot, avatar.
- **Greeting row:** *Good morning, {first name}*, a one-line summary generated from the user's top items, and on the right the date plus *PMS figures as at {date}*.
- **Summary line rules:** pick the two or three most urgent items from the role's panels, in this order: overdue, due today, money at risk, deadlines within 14 days. Write it in plain sentences, as in the designs.
- **Body:** a row of headline figure cards, then two columns. The main column is about two-thirds wide; the side column stacks below it on phones.
- Reuse the app's existing colour tokens, Manrope headings and Source Sans 3 body text. Light and dark mode must both work.

### Panel framework

Build each home section as a **panel**: a component with an id, a title, an optional header link, a data loader and an empty state. Home pages are lists of panel ids per role, read from the configuration in Admin › Home pages.

| Panel id | Title in design | Used by |
| --- | --- | --- |
| `time-summary` | Time recorded | Fee earner |
| `kpi-strip` | Headline figures (role-specific set) | All |
| `today` | Today and this week | Fee earner, Legal secretary |
| `my-matters` | My matters | Fee earner |
| `my-enquiries` | Enquiries assigned to me | Fee earner |
| `team-queue` | {Team} queue | Fee earner |
| `ready-to-bill` | Ready to bill | Fee earner, Finance |
| `recently-viewed` | Recently viewed | Fee earner |
| `sign-offs` | Needs your sign-off | Partner |
| `matters-attention` | Matters needing attention | Partner |
| `my-team` | My team | Partner |
| `queues-supervised` | Queues you supervise | Partner |
| `my-figures` | My figures | Partner |
| `dept-enquiries` | Department enquiries | Partner |
| `clients-owned` | Clients you look after | Partner |
| `fee-earner-tasks` | Tasks for my fee earners | Legal secretary |
| `fee-earner-dates` | Key dates for my fee earners | Legal secretary |
| `fee-earners-today` | My fee earners today | Legal secretary |
| `waiting-on-others` | Waiting on others | Legal secretary |
| `bills-to-send` | Bills to send | Legal secretary |
| `enquiry-capture` | Take an enquiry | Enquiries coordinator |
| `enquiries-month` | Enquiries this month | Enquiries coordinator |
| `team-routing` | Team queues | Enquiries coordinator |
| `callbacks` | Callbacks booked for me | Enquiries coordinator |
| `enquiry-sources` | How they found us | Enquiries coordinator |
| `aged-debt` | Aged debt | Finance |
| `chase-list` | Chase list | Finance |
| `client-account` | Client account | Finance |
| `credit-limits` | Credit limit used | Finance |
| `billed-trend` | Fees billed by month | Finance, Managing partner |
| `openings` | Matters waiting to open | Risk and compliance |
| `conflicts` | Conflict checks | Risk and compliance |
| `firm-dates` | Critical dates across the firm | Risk and compliance |
| `aml` | AML and client due diligence | Risk and compliance |
| `data-quality` | Data quality | Risk and compliance |
| `registers` | Registers | Risk and compliance |
| `mp-attention` | Needs your attention | Managing partner |
| `departments` | Departments | Managing partner |
| `top-clients` | Top clients by fees | Managing partner |
| `enquiry-pipeline` | Enquiry pipeline | Managing partner |
| `risk-summary` | Risk and compliance | Managing partner |

Panels must be reusable: a firm can add, for example, `aged-debt` to the Partner page from Admin without code changes. Panels scope their data by the viewing user (personal), their teams (team) or the firm.

## The seven home pages

Layout for each page: headline figures, then the main column, then the side column, in the order listed. Exact copy and styling are in the design files.

### 1. Fee earner · `01-fee-earner.html`

- **Header button:** + New.
- **Time recorded:** chargeable hours from the PMS for each weekday of the last week, with the daily pace needed for the annual target. Days under 2 hours are amber, and a line flags light days. No timer or time entry controls.
- **Headline figures:** chargeable hours last week against weekly pace; month to date; my unbilled WIP with matter count and oldest entry date; matters over estimate.
- **Main:** *Today and this week* merges my tasks and the key dates of my matters, sorted by date, with overdue first. Each row has its action. *My matters* shows matter, client and number, stage, next key date, unbilled WIP, and a bar of fees against estimate: amber from the matter's alert percentage, red past 100%.
- **Side:** enquiries assigned to me with Convert and Log contact; my team's unclaimed queue with Take; Ready to bill with Request bill or Flag write-off; recently viewed.

### 2. Partner / head of department · `02-partner.html`

- **Header button:** + New.
- **Headline figures:** department unbilled WIP and open matters; billed this year; department debt (red when any is over 90 days); count of sign-offs waiting.
- **Main:** *Needs your sign-off* lists write-offs, matter openings and undertakings needing partner approval, with Approve and Discuss. *Matters needing attention* lists over fee, near estimate, WIP over 30 days, debt over 90 days and key dates, each with a tag and an action. *My team* is a table per fee earner: open matters, last week's hours, month's hours, unbilled WIP and overdue tasks.
- **Side:** queues supervised, with unclaimed and overdue counts and Assign; my own figures (no time entry buttons); department enquiries this month as received, in progress and converted, with the latest three; clients I am relationship partner for, with billed, WIP and debt.

### 3. Legal secretary · `03-legal-secretary.html`

- **Header button:** + New.
- **Who they support:** add **Supports** (employee links) to the employee record; Sarah Cole supports Rhian Morgan and Dafydd Evans.
- **Headline figures:** my open tasks; letters to send; items waiting on others; the next completion.
- **Main:** *Tasks for my fee earners*: tasks assigned to me or created for the people I support, with who asked and blockers shown, plus a New task button. *Key dates for my fee earners*, six weeks ahead.
- **Side:** a card per supported fee earner with their overdue count and top item; waiting on others; bills to send.

### 4. Enquiries coordinator · `04-enquiries-coordinator.html`

- **No header button:** the capture form is on the page.
- **Take an enquiry:** the enquiry capture form from the Enquiries build, embedded at the top, with the high-level-facts reminder, live duplicate check, privacy notice checkbox, and *Save and add another* and *Save and send to team* buttons.
- **Headline figures:** taken last week by channel; waiting for first contact; past response time and last breach date; converted this month.
- **Main:** *Enquiries this month* table with enquirer, practice area, urgency, received, first contact (due time or done), who has it and status. *Callbacks booked for me.*
- **Side:** *Team queues*, one row per team, with a warning and a *Remind team lead* button when something is unclaimed near its response time. *How they found us* as bars by source.

### 5. Finance and credit control · `05-finance-credit-control.html`

- **Header button:** Start billing run.
- **Headline figures:** total debt; overdue amount and share; unbilled WIP with oldest entry; cash received this month against last month; client account held with next reconciliation date.
- **Main:** *Aged debt* as one stacked bar (not yet due, 1–30, 31–60, 61–90, 90+) with amounts. *Chase list*: overdue bills with outstanding, days late, age, notes and next action; the 90+ action is *Escalate to {partner}*. *Ready to bill*: largest unbilled WIP with status and action.
- **Side:** client account balances by matter and the reconciliation status (due within five weeks of the last one); credit limit used per client, red at 75% and over; fees billed by month.

### 6. Risk and compliance · `06-risk-compliance.html`

- **Header button:** Run conflict search.
- **Headline figures:** conflicts to clear; pending matter openings (red if any has a deadline within 14 days); AML and ID items; critical dates in the next 14 days.
- **Main:** *Matters waiting to open* with risk rating, what is missing and the nearest deadline; show a warning when a key date falls before the matter can open. *Conflict checks* from records and enquiries. *Critical dates across the firm* for the next 14 days, including enquiries and pending matters.
- **Side:** AML and due diligence, including expired verification, CDD in progress and screening; data quality (possible duplicates, with Compare); registers (undertakings, file reviews, complaints, non-engagement letters).

### 7. Managing partner · `07-managing-partner.html`

- **Header button:** + New.
- **Headline figures:** fees billed this year; billed this month against last; lock-up (WIP plus debt); enquiries this month; risk items.
- **Main:** *Needs your attention*: their own matters with problems, plus firm items that need them. *Fees billed by month* chart for the year. *Departments* table: open matters, billed this year, WIP, debt and hours this month, with a firm total row and a one-line comment.
- **Side:** top clients by fees, rolling up groups (Severn group); enquiry pipeline (received, contacted, converted); risk and compliance summary linking to Rita Risk’s page.

## Admin › Home pages

Turn `00-overview-admin.html` into a working admin screen where each firm customises home pages without code. Keep the design's look: the role cards at the top and the module matrix below.

### Role cards

- One card per role, showing the role name, a short purpose line (editable) and the number of users with that role.
- **Preview** opens that role's Home in a read-only preview using the demo user for that role, so an admin can check the result.
- **Add role** creates a new role (for example Business Development) from a copy of an existing role's panels.

### Panel matrix

- Rows are panels, using the plain titles in the design (*Today: tasks and key dates*, *Aged debt and credit control*…). Columns are roles.
- Each cell cycles through three states: **Primary** (filled dot: shown in the main column), **Summary** (outlined dot: shown in the side column) and **Off** (blank). Use real buttons with labels for screen readers, not bare dots.
- Within a role, admins can reorder panels in each column with up and down buttons.
- **Headline figures:** per role, an admin picks up to five figure cards from a list (for example *Unbilled WIP*, *Debt over 90 days*, *Sign-offs waiting*).
- **Save** applies the configuration to everyone with that role on their next page load. **Reset to defaults** restores the configuration shown in the designs.
- Changes are recorded in the audit trail with who changed what.

### Firm settings on the same screen

- **Demo mode** on or off (controls the demo user switcher).
- **Working day pace:** hours per day used for the chargeable pace line; default from each fee earner's annual target divided by the firm's working days.
- **Attention thresholds:** WIP age (default 30 days), debt age (default 90 days), credit limit warning (default 75%), key date window (default 14 days).

### Defaults

The default configuration is exactly what the seven designs show, and the matrix on the overview design must match it.

## Data, build order and acceptance

### Where panel data comes from

| Source | Feeds |
| --- | --- |
| Tasks and Teams | Today, team queues, sign-offs, tasks for fee earners, queues supervised, waiting on others |
| Enquiries | Enquiries assigned, capture, enquiries this month, routing, callbacks, sources, pipeline, conflict pre-checks |
| Matters (1Squared) | My matters, key dates, matters waiting to open, critical dates, registers |
| People & Organisations | Clients owned, AML and ID status, duplicates, recently viewed |
| PMS source (`PmsSource`) | Hours, WIP, billed, debt, aged debt, chase list, client account, credit limits, departments, top clients, billing trend |

Panels read PMS figures only through `PmsSource`. A panel with no linked PMS data shows *Not linked to the PMS*.

### Data to add for the designs

- The demo users, Lowri Ellis, the **Supports** links and the **Shows the work of** links from Roles and demo users.
- Enquiries the designs use if missing: ENQ-000002 Western Vale Homes Ltd (converted), ENQ-000003 Coastal Storage Ltd (assigned to Rhian Morgan), ENQ-000005 Tranter Haulage Ltd (declined: conflict, because the firm acts for Severn Logistics against them).
- Approval records for write-offs and undertakings, so the Partner sign-off panel has real items.

### Build order

1. Role model, Viewing as, rail visibility.
2. Demo users, Shows the work of, Supports, Demo mode and the user switcher.
3. Panel framework and page shell with the summary line.
4. Fee earner and Partner pages.
5. Legal secretary and Enquiries coordinator pages.
6. Finance, Risk and compliance, and Managing partner pages.
7. Admin › Home pages configuration, with defaults matching the designs.

### Acceptance criteria

- [ ] Searching *Ethel* finds Ethel Enquiries, and switching to her shows the Enquiries coordinator page with the capture form at the top.
- [ ] Each demo user lands on the page matching their design, filled with real data from the person whose work they show, and the demo banner says whose work it is.
- [ ] Martha Managing-Partner can switch **Viewing as** between Managing partner and Partner; Adam Admin can view every role.
- [ ] No timer, Start timer or Record time control appears anywhere.
- [ ] Finance figures on the Finance and Managing partner pages match the PMS check sheets (debt £49,130.22, WIP £34,140.00, client account £118,454.20).
- [ ] Taking an unclaimed task from a queue panel moves it to *My tasks* without leaving Home.
- [ ] In Admin › Home pages, switching *Aged debt* to Summary for Partner adds it to Patrick Partner’s side column on reload; Reset to defaults removes it.
- [ ] Panels with no data show an empty state, never zeros or placeholder figures.
- [ ] Every page works at phone width and in dark mode, matching the designs’ structure.
- [ ] With Demo mode off, the user switcher and demo banners do not appear.
