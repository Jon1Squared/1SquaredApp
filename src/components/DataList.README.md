# `DataList` — Reusable Two-Line List Pattern

`DataList` (`src/components/DataList.tsx`) is the standard, data-driven list component for 1Squared. It renders a fixed-layout (`table-layout: fixed`) scannable table where **every row is at most two text lines tall** (~60px in `comfortable` density, ~44px in `compact` density), paired with a right-hand `PreviewDrawer` (`420px` wide) for full record detail and a single-row `DataListFilterBar`.

---

## Core Design Rules (Apply to Every List)

1. **Maximum 6–7 columns** (`table-layout: fixed` with explicit widths on every column).
2. **At most two lines per cell** via `ListCell`:
   - **Primary line**: Normal weight (`0.9rem`), body text colour (`var(--color-text)`), with primary record links in teal (`var(--color-link)`).
   - **Secondary line**: Smaller (`0.78rem`), muted grey (`var(--color-text-muted)`). Hidden in `compact` density unless `keepSecondaryInCompact: true` is set (used only for time-critical key dates).
3. **Merge related pairs into a single two-line column** instead of separate columns:
   - *Title / Name* over *Reference*
   - *Summary* over *Key date*
   - *Status pill* over *Relative age (`RelativeTime`)*
   - *Next action* over *Due date*
4. **Clamp free-text cells to 1 line** (`text-overflow: ellipsis`) and expose full text via the native `title` tooltip (`tooltip` column callback) and inside the right-hand `PreviewDrawer`.
5. **Quiet urgency & status columns**:
   - Use shared badge helpers from `src/domain/badges.ts` (`urgencyTone`, `isExceptionalUrgencyLabel`, `urgencyEdgeKind`, `enquiryStatusTone`).
   - Show urgency pills and the 4px left-edge row border (`--pill-alert-fg` / `--pill-warning-fg`) for **Emergency** and **Urgent** only; normal/standard urgency renders an empty cell.
6. **Responsive column priorities & single-row filter bar**:
   - Assign every column a `priority` (`1`, `2`, or `3`):
     - `< 1280px`: Priority `3` columns hide automatically.
     - `< 1024px`: Priority `2` columns hide automatically.
     - `< 768px`: Table switches to stacked mobile cards (`.data-list__cards`).
   - Keep the filter bar on a single row (`DataListFilterBar`): flex-grow search input + at most 2 inline `<select>` controls + `"Filters"` popover button (with active count badge) + removable active filter chips + `Comfortable` / `Compact` density toggle persisted per user via `useListDensity(currentUserId)`.

---

## Column Config Example

```tsx
import Link from 'next/link';
import {
  DataList,
  DataListFilterBar,
  PersonChip,
  PreviewDrawer,
  RelativeTime,
  useListDensity,
  type DataListColumn,
  type DataListSortState,
} from '@/components/DataList';
import { StatusPill } from '@/components/SearchBox';
import { enquiryStatusTone, isExceptionalUrgencyLabel, urgencyEdgeKind, urgencyTone } from '@/domain/badges';

const columns: DataListColumn<Enquiry>[] = [
  {
    id: 'enquiry',
    header: 'Enquiry',
    width: '20%',
    priority: 1,
    renderPrimary: (row) => <Link href={`/enquiries/${row.id}`}>{row.clientName}</Link>,
    renderSecondary: (row) => row.reference,
    tooltip: (row) => `${row.clientName} (${row.reference})`,
  },
  {
    id: 'summary',
    header: 'Summary',
    width: '28%',
    priority: 1,
    keepSecondaryInCompact: true,
    renderPrimary: (row) => row.summary,
    renderSecondary: (row) => row.keyDateSummary,
    tooltip: (row) => row.summary,
  },
  {
    id: 'urgency',
    header: 'Urgency',
    width: '110px',
    priority: 1,
    sortable: true,
    renderPrimary: (row) =>
      isExceptionalUrgencyLabel(row.urgencyLabel) ? (
        <StatusPill label={row.urgencyLabel} tone={urgencyTone(row.urgencyLabel)} />
      ) : null,
  },
  {
    id: 'status',
    header: 'Status',
    width: '130px',
    priority: 1,
    sortable: true,
    secondarySortable: { id: 'receivedAt', header: 'Age' },
    renderPrimary: (row) => (
      <StatusPill label={row.status} tone={enquiryStatusTone(row.status)} />
    ),
    renderSecondary: (row) => (
      <RelativeTime value={row.receivedAt} tooltipDetail={row.channelLabel} />
    ),
  },
  {
    id: 'assignedTo',
    header: 'Assigned to',
    width: '150px',
    priority: 2,
    renderPrimary: (row) => <PersonChip name={row.assigneeName} emptyLabel="Unassigned" />,
  },
  {
    id: 'nextAction',
    header: 'Next action',
    width: '22%',
    priority: 2,
    renderPrimary: (row) => row.nextActionTitle,
    renderSecondary: (row) => row.nextActionDue,
    tooltip: (row) => row.nextActionFull,
  },
  {
    id: 'practiceArea',
    header: 'Practice area',
    width: '140px',
    priority: 3,
    renderPrimary: (row) => row.practiceAreaLabel,
  },
];
```

---

## Proposed Column Specifications for Other Lists (Phase 6 Inventory)

Below are the proposed column specifications for every other list page in the app, applying the same two-line anatomy, column budget ($\le 7$ columns), priority hiding, single-row filter bar, and right-hand preview drawer.

### 1. Matters List (`src/components/MattersListClient.tsx`)
Currently uses a flex-row list where title, client, work type, fee earner, supervisor, and open task count compete in a single line.

| Column Header | Primary Line | Secondary Line | Width | Priority | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Matter** | Matter title (teal link to `/matters/[id]`) | Reference, e.g. `M-2026-004` | `24%` | `1` | Truncates with ellipsis; full title in tooltip |
| **Client** | Client display name (person or organisation) | Matter role / instructing contact | `20%` | `1` | Full contact details move to preview drawer |
| **Stage & Key date** | Current stage or next milestone (1 line clamped) | Key date with calendar icon (`Key date 14 Nov (26d)`) | `22%` | `1` | `keepSecondaryInCompact: true`; red-tint when $\le 7\text{d}$ |
| **Status** | `StatusPill` (`Active`, `On hold`, `Closing`, `Closed`, `Archived`) | Opened `<RelativeTime />` (`"14d ago"`) | `130px` | `1` | Sortable by `Status / Opened`; full open date in tooltip |
| **Fee earner** | `<PersonChip />` (initials avatar + fee earner name) | — | `150px` | `2` | Supervisor & team move to preview drawer |
| **Open work** | Next open task title (1 line clamped) | Open task count & next due date | `18%` | `2` | Full task list & WIP/billing summary in preview drawer |
| **Work type** | Work type label | — | `140px` | `3` | First column to hide below `1280px` |

- **Filter bar**: Search box + `Status` select + `Work type` select + `"Filters"` popover (`Fee earner`, `Supervisor`, `Client`) + Density toggle.
- **Preview drawer sections**: *Matter overview*, *Client & related parties*, *Ownership (Fee earner, Supervisor, Team)*, *Financials (Fee estimate, WIP, Unpaid billed)*, *Open tasks*.

---

### 2. Tasks List (`src/components/TasksListClient.tsx`)
Currently uses a 7-column `.data-table` (`Task`, `Linked record`, `Assignee`, `Priority`, `Due`, `Source`, `Status`) where notes and multi-record chips wrap vertically.

| Column Header | Primary Line | Secondary Line | Width | Priority | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Task** | Task title (teal link to `/tasks/[id]`) | Task reference (`TSK-0012`) | `26%` | `1` | Notes move to preview drawer & tooltip |
| **Linked record** | Primary linked record name (link to Matter/Enquiry/Person) | Record reference & type (`M-2026-001 · Matter`) | `24%` | `1` | Additional linked records shown in preview drawer |
| **Priority** | `StatusPill` for **Urgent** / **High** only | — | `110px` | `1` | Sortable; drives 4px row left-edge colour; `Normal`/`Low` blank |
| **Status** | `StatusPill` (`Open`, `Overdue`, `Completed`, `Cancelled`) | Due `<RelativeTime />` or countdown (`"Due tomorrow"`, `"2d overdue"`) | `140px` | `1` | Sortable by `Status / Due`; full due timestamp in tooltip |
| **Assigned to** | `<PersonChip />` (assignee avatar + name) | — | `155px` | `2` | Team & `Created by` move to preview drawer; hidden on `Mine` tab |
| **Source** | `Manual` or `Auto-generated` | Trigger rule label (1 line clamped) | `150px` | `3` | Hides below `1280px` |

- **Filter bar**: Search box + `Priority` select + `Status` select + `"Filters"` popover (`Team`, `Assignee`, `Linked record type`, `Source`) + Density toggle.
- **Preview drawer sections**: *Task details & full notes*, *Linked records*, *Assignment & audit*, *Quick complete / reassign actions*.

---

### 3. People List (`src/components/DirectoryListClient.tsx` — `/people`)
Currently uses a flex-row list stacking status, capacity, primary email, primary phone, and town into a single wrapping meta line.

| Column Header | Primary Line | Secondary Line | Width | Priority | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Person** | Full display name (teal link to `/people/[id]`) | Reference (`P-0014`) · Capacity (`Client`, `Contact`, `Staff`) | `24%` | `1` | Preferred name / title in tooltip and preview drawer |
| **Organisation** | Primary linked organisation name | Role / job title at organisation | `22%` | `1` | `—` when independent individual |
| **Status & AML** | Client status `StatusPill` (`Client`, `Prospect`, `Former`) | AML verification badge (`Verified`, `Pending`, `Expired`) | `140px` | `1` | Sortable by `Status` |
| **Primary contact** | Primary email (`1 line clamped`) | Primary phone number | `22%` | `2` | Full contact methods & preferences in preview drawer |
| **Relationship owner** | `<PersonChip />` (owner / partner avatar + name) | — | `150px` | `2` | `"Unassigned"` in grey italic when empty |
| **Location** | Town / City | Postcode | `130px` | `3` | Full address in preview drawer; hides below `1280px` |

- **Filter bar**: Search box + `Client status` select + `Capacity` select + `"Filters"` popover (`AML status`, `Relationship owner`, `Location`) + Density toggle.
- **Preview drawer sections**: *Identity & capacities*, *Contact details & address*, *Compliance / AML*, *Active matters & enquiries*.

---

### 4. Organisations List (`src/components/DirectoryListClient.tsx` — `/organisations`)
Currently shares `DirectoryListClient.tsx` with People, concatenating organisation type, registration number, primary contact, and town into one subtitle line.

| Column Header | Primary Line | Secondary Line | Width | Priority | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Organisation** | Legal name (teal link to `/organisations/[id]`) | Reference (`O-0006`) · Trading name | `26%` | `1` | Truncates with ellipsis |
| **Primary contact** | Primary contact person name | Contact email or phone | `22%` | `1` | All linked people shown in preview drawer |
| **Status** | `StatusPill` (`Client`, `Prospect`, `Referrer`, `Supplier`) | Active matters count (`"3 active matters"`) | `140px` | `1` | Sortable by `Status` |
| **Type & Reg.** | Organisation type (`Limited company`, `LLP`, `Charity`, etc.) | Companies House / Registration number | `180px` | `2` | Hides below `1024px` |
| **Relationship owner** | `<PersonChip />` (account partner avatar + name) | — | `150px` | `2` | Hides below `1024px` |
| **Location** | Registered office town | Postcode | `130px` | `3` | Full registered & trading addresses in preview drawer |

- **Filter bar**: Search box + `Status` select + `Organisation type` select + `"Filters"` popover (`Sector`, `Relationship owner`, `Location`) + Density toggle.
- **Preview drawer sections**: *Organisation profile & registration*, *Key contacts*, *Addresses*, *Active matters & referral history*.

---

### 5. Admin Lists (`src/components/AdminClient.tsx` — Users, Teams, Audit Log)
Currently uses ad-hoc `.data-table` tables on the Admin page.

#### 5a. Admin › Users & Teams
| Column Header | Primary Line | Secondary Line | Width | Priority | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **User** | `<PersonChip />` (avatar + full name) | Job title · Staff ref | `26%` | `1` | Click opens user configuration drawer |
| **Role & Home** | System role (`Partner`, `Fee earner`, `Coordinator`, `Admin`) | Assigned home page profile | `22%` | `1` | Sortable by `Role` |
| **Status** | `StatusPill` (`Active`, `Inactive`) | Last active `<RelativeTime />` | `130px` | `1` | Sortable |
| **Primary team** | Primary team name | Additional team count (`"+2 teams"`) | `20%` | `2` | Full team memberships in preview drawer |
| **Email** | Work email address | Direct phone / extension | `22%` | `3` | Hides below `1280px` |

#### 5b. Admin › Audit Log
| Column Header | Primary Line | Secondary Line | Width | Priority | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Event** | Action summary (1 line clamped) | Field changed (`before → after`) | `34%` | `1` | Full diff in preview drawer |
| **Record** | Record title / reference (link to record) | Record type (`Enquiry`, `Matter`, `Task`, `Person`) | `24%` | `1` | — |
| **Actor** | `<PersonChip />` (user who made the change) | — | `160px` | `1` | — |
| **When** | `<RelativeTime />` (`"15m ago"`) | Absolute timestamp (`19 Oct 2026, 12:30`) | `160px` | `2` | Sortable by timestamp |
| **Category** | `StatusPill` (`Assignment`, `Status`, `Compliance`, `Edit`) | — | `130px` | `3` | Hides below `1280px` |
