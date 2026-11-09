# ADR 0029: Finance Data Delivery

- **Date:** 2026-11-06
- **Status:** Accepted (8 November 2026)
- **Roadmap:** Stage 0 decision D4, slice S0-10 (`docs/roadmap/stage-0-plan.md`); backlog gap P4, items 14 and 26
- **Builds on:** [ADR 0004](./0004-document-permissions-and-finance-view.md), [ADR 0010](./0010-central-permission-registry-and-resolver.md), [ADR 0014](./0014-staff-matter-access-by-permission.md), [ADR 0025](./0025-permission-enforcement-pattern.md)

## Context

At commit `fb4b08d`, `getAppSnapshot` (`src/server/services.ts:626-636`, computing finance at lines 830-938 and returning at lines 1150-1166) sends firm-wide finance and Practice Management System (PMS) data to every signed-in user, whatever their permissions. That data includes:
- matter and client financials
- fee-earner performance and weekly time
- aged debt and invoices
- monthly fees billed
- cash received
- department financials
- disbursements and client account balances

Some matter-level lists are filtered for restricted matters. The firm-wide and client-level roll-ups are not: they are read straight from PMS views and sums (`getClientFinancials` at `src/pms/pmsSource.ts:245` and `getAllClientFinancials` at `:257` from `v_client_financials`, `getFeeEarnerPerformance` at `:524` from `v_fee_earner_performance`, `getFeeEarnerWeeklyTime` at `:666` summing `time_entries`, `getMonthlyFeesBilled` at `:744`, `getCashReceivedSummary` at `:777`, and `getDepartmentFinancials` at `:807` with firm total at `:852-860`), as well as `getMatterPmsViewBundle` (`src/server/services.ts:8981`) and `getClientPmsViewBundle` (`:9040`, including `clientBundle.summary`, `groupView` company financials at `:9101` and summed totals at `:9111-9136`). So they include figures from staff matters and matters behind ethical walls.

The attention list is called with `canViewFinance: true` hard-coded (`services.ts:957`). `canUserViewFinance` (`src/domain/pms.ts:74`), `attentionList` (`src/domain/attention.ts:110`), and several components (`MatterProfileClient.tsx:212`, `MattersListClient.tsx:75`, `OrganisationProfileClient.tsx:133`, `PersonProfileClient.tsx:120`) also default `canViewFinance` to `true`.

## Decision

1. **Take finance out of the app snapshot.** The snapshot carries no finance or PMS figures, only the user's finance capabilities, derived from their permissions.
2. **Load finance on demand, from gated server functions** that follow ADR 0025:
   - firm-wide finance views and Home finance panels require `finance:view`
   - matter and client finance (tabs, figures in lists, attention signals) require `finance:view_matter`, plus `canAccessMatter` for every matter included
   - credit-control actions, bill requests and write-off requests require `finance:credit_control`
3. **Keep restricted matters out of roll-ups.** Firm-wide totals are calculated from matter-level rows after restricted matters are removed for that user. They are not read from unfiltered PMS views. The PMS views may still be used, but only as input rows, never as totals.
4. **Deny by default.** Every `canViewFinance` default becomes `false`, and the hard-coded `true` in the attention list is replaced by the user's real permission.
5. **Load Home panels by role.** Home finance panels are requested only for roles that hold the relevant permission. Other roles never receive the data.

### Clarification (9 November 2026)

1. **Matter-level loaders fail closed on unlinked PMS rows.** `getMatterFinanceRows`, `getMyFinanceFigures`, `getMatterPmsViewBundle`, and `getClientPmsViewBundle` include only PMS rows whose `matter_code` maps through a `pmsLinks` entry to a 1Squared matter the actor can access (`canPersonAccessMatter`). Unlinked PMS matters are excluded from matter-level loaders so an unlinked staff or ethical-wall matter cannot fail open.
2. **Firm totals still include unlinked PMS rows.** `getFirmFinance` (`finance:view`) includes unlinked PMS rows in firm-wide roll-ups because those rows belong to the firm's books and `finance:view` holders are firm-level roles, while excluding any PMS rows linked to restricted 1Squared matters the actor cannot access. `allUnlinkedPmsMatters` in `getMatterPmsViewBundle` is returned only to actors holding `finance:manage_links` to populate the link picker.

## Alternatives Considered

- **Keep the snapshot and filter it per user.** It is smaller as a change, but the data still travels in one large payload, and every new field risks leaking. Rejected.
- **Client-side hiding only.** Hiding a panel is not access control (CLAUDE.md, "Roles and permissions"). Rejected.

## Consequences

- Home and profile screens fetch finance separately, which means more requests but less data per request.
- Users without finance permissions see no financial figures anywhere, including the attention signals on matters.
- The firm-wide totals may change slightly once restricted matters are excluded. This is expected and is noted in the release notes.
- Two-tenant and restricted-matter tests are needed for every finance endpoint (P8).
