# ADR-0014: Restricted Staff-Matter Access by Permission and Dynamic Matter Participation

- **Date:** 2026-11-01
- **Status:** Proposed
- **Supersedes:** Staff-matter access aspects of [ADR-0004](./0004-document-permissions-and-finance-view.md)

## Context

When a client on a matter is also a current employee (`person.isEmployee === true`), `computeStaffMatterStatus` (`src/domain/employment.ts` lines 779–826) marks `matter.isStaffMatter = true` and populates `matter.restrictedAccessUserIds` with:
1. Named matter participants (`responsiblePartnerId`, `supervisingPartnerId`, `leadFeeEarnerId`, `originatingSolicitorId`, `teamMemberIds`).
2. Every person in the firm who currently holds `admin` or `risk_compliance` (`roles.includes('admin') || roles.includes('risk_compliance') || appRole === 'admin'`).

Furthermore, when a person is newly marked as an employee in `savePersonRecord` (`src/server/services.ts` lines 1093–1132), the code hardcodes person IDs `'P-000003'` and `'P-000004'` into `restrictedAccessUserIds`!

This design has four serious flaws:
1. **Stale Stored Role Holders:** When someone joins or leaves the `admin`, `managing_partner`, or `risk_compliance` role, existing staff matters retain outdated user IDs in `restrictedAccessUserIds`, leaving former role holders with access and denying new role holders access.
2. **Hardcoded Person IDs in Server Code:** `'P-000003'` and `'P-000004'` in `src/server/services.ts` violate Rule 1 and Rule 4 of the Platform Architecture Standard.
3. **Missing Server-Side Enforcement Outside Document Generation:** While Document Generation checks `canActorAccessMatterRecord`, `getAppSnapshot` (`src/server/services.ts`) returns **all** matters (including `isStaffMatter: true`), notes, tasks, and time entries to every user without filtering by `canUserAccessMatter`!
4. **Inconsistency Between `canUserAccessMatter` and `canActorAccessMatterRecord`:** `canUserAccessMatter` (`src/domain/employment.ts`) grants dynamic access to `admin`, `managing_partner`, and `risk_compliance`, whereas `computeStaffMatterStatus` only baked `admin` and `risk_compliance` into `restrictedAccessUserIds`, and `toMatterAccessSubject` (`src/domain/documentGeneration.ts`) did not pass `teamMemberIds` separately.

## Decision

### 1. Dynamic Permission Check (`matter:restricted:access`) + Named Matter Participants

Access to a restricted staff matter (`matter.isStaffMatter === true`) is evaluated dynamically by a single core helper `canAccessMatter(resolvedPermissions, actorUserId, matter)`:

A user may access a restricted staff matter if and only if **at least one** of the following holds:
1. **Oversight Permission:** `hasPermission(resolvedPermissions, 'matter:restricted:access')` is `true` (granted by default to `admin`, `managing_partner`, and `risk_compliance`, and configurable per tenant via `rbac.roles`).
2. **Named Matter Participant:** `actorUserId` is one of the matter's active named participants:
   - `matter.responsiblePartnerId`
   - `matter.supervisingPartnerId`
   - `matter.leadFeeEarnerId`
   - `matter.originatingSolicitorId`
   - `matter.teamMemberIds` (an explicit member of the matter's team array)
   - `matter.restrictedAccessUserIds` (which now stores **only** explicit per-matter participant/exception user IDs, never role holders).

### 2. Clean Up `restrictedAccessUserIds` and Recompute on Matter / Employment Changes

- `computeStaffMatterStatus` in `src/domain/employment.ts` is updated so `restrictedAccessUserIds` contains **only** the named matter participants (`responsiblePartnerId`, `supervisingPartnerId`, `leadFeeEarnerId`, `originatingSolicitorId`, `teamMemberIds`) plus any explicitly added individual user exceptions—never role holders (`admin`, `risk_compliance`, `managing_partner`) and never hardcoded person IDs (`P-000003`, `P-000004`).
- The hardcoded `'P-000003'` and `'P-000004'` in `savePersonRecord` (`src/server/services.ts` lines 1128–1129) are removed.
- Whenever a matter's team (`responsiblePartnerId`, `supervisingPartnerId`, `leadFeeEarnerId`, `originatingSolicitorId`, `teamMemberIds`) or a linked client's `isEmployee` status changes, `computeStaffMatterStatus` recomputes `isStaffMatter` and the participant list.
- A data migration strips role-holder IDs that are not named matter participants from `restrictedAccessUserIds` on existing staff matters.

### 3. Comprehensive Server-Side Enforcement Across All Surfaces

`canAccessMatter` is enforced on the server across:
1. **Matter reads, lists, and snapshots (`getAppSnapshot`, `/matters`, `/matters/[id]`):** Restricted staff matters (and their linked notes, tasks, communications, time entries, financial summaries, and sign-offs) are filtered out of `getAppSnapshot` and rejected on direct `/matters/[id]` or mutation calls for unauthorised users.
2. **Client / Person profile matter lists (`/people/[id]`, `/organisations/[id]`):** Restricted staff matters are hidden from a client's linked matters tab, financial WIP rollups, and attention alerts for unauthorised users.
3. **Document Generation, Previews, Saved Documents, and Downloads:**
   - Generating, previewing (including Template Builder test preview), listing saved documents (`listDocumentsForEntityService`), issuing download tokens (`getDocumentDownloadTokenService`), and deleting documents linked to a restricted staff matter require `canAccessMatter(...) === true`.
   - If a document is linked to both a Client (`person` or `organisation`) and a restricted Staff Matter (`matter`), viewing the Client profile does **not** expose the staff-matter document unless the viewer passes `canAccessMatter` on that matter.
4. **Search and Exports:** Global search results and CSV/report exports exclude restricted staff matters and their documents for unauthorised users. (Aggregate template usage counts in `template_usage_daily_summaries` store no matter IDs, client names, or field values per [ADR-0006](./0006-template-usage-tracking-and-reporting.md)).

## Consequences

- Role changes take effect immediately for all restricted staff matters without stale user IDs lingering in `restrictedAccessUserIds`.
- Hardcoded person IDs (`P-000003`, `P-000004`) are eliminated from server code.
- Staff-matter confidentiality is enforced consistently on the server across matters, client profiles, tasks, notes, financials, and generated documents.
