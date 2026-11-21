# S0-21 — Clients, Contacts and Parties (Contact Personas, Conflict Traversal and Merge Execution)

| Field | Value |
|---|---|
| Slice | `S0-21` |
| Stage / Work package | Stage 0C — Make it shared (`WP5a`) |
| Status | Planned (ready to build on `s0-21-clients-contacts-and-parties`) |
| Branch | `s0-21-clients-contacts-and-parties` (target `develop`) |
| Depends on | `S0-16` (already merged on `develop`) |
| Size | `M` |
| Backlog IDs | `28`, `Q1` (also verifies `S0-07`/`B7`, `S0-09`/`B4`; cross-cutting `P8`, `P10`, `P11`) |
| Decision record(s) | `D8` — [ADR 0033](../decisions/0033-contact-personas.md) (`Accepted`) |
| Spec / standards references | Architecture Standard sections 4, 7, 10, 12; [RBAC Reference](../rbac-reference.md); [ADR 0014](../decisions/0014-staff-matter-access-by-permission.md); [ADR 0028](../decisions/0028-tenant-database-and-repositories.md) |

---

## 1. Purpose

Close Stage 0 backlog item `28` (*Clients, contacts and parties*) to the strict **Completed** bar and close open question `Q1` under [ADR 0033](../decisions/0033-contact-personas.md) (`D8`):

- Confirm and enforce one canonical `PersonRecord` model across every tenant: a person has **no separate persona sub-records** and instead links to each matter with a contextual `relationshipCode` (`CL | JC | CC | OP | CP | CO | TP | NO`) and capacity chosen from `MatterPartyTaxonomy`.
- Ensure `'person_role'` choice seeding (`'person_role.private_client'` / `'Private client'` / `'Client contact'`) is clean, key-based and idempotent across default and demo seeds.
- Ensure conflict searching traverses every party link and capacity across all canonical records while strictly redacting restricted staff and ethical-wall matters (`isStaffMatter` / `hasEthicalWall`) for unpermitted viewers.
- Prove `executeMerge` atomicity, conflict-traversal accuracy and strict two-tenant isolation in PostgreSQL, and publish full Help & documentation coverage.

---

## 2. Classification & Architectural Layer

- **Classification:** Core domain logic + host directory/conflict services + seed/config alignment (no client-specific core branches).
- **Single-tenant and multi-tenant operation:** Identical code path. Every directory read, conflict search and merge executes inside the authenticated `TenantContext` against `TenantPartyRepository` and `TenantMatterRepository` in that tenant's PostgreSQL database.

---

## 3. Existing Code & Schema

- **Database schema version on `develop`:** `0015` (`CORE_REQUIRED_SCHEMA_VERSION = '0015'` in `core/src/tenancy/tenantScopedRepository.ts:26`, registered in `CORE_TENANT_MIGRATIONS` at `core/src/tenancy/migrations/index.ts:1944-1960`).
- **Taxonomy & capacities:** `src/domain/matterParties.ts:41-635` defines `MatterPartyTaxonomy`, `8` relationship codes (`CL | JC | CC | OP | CP | CO | TP | NO`) and `70` capacities.
- **Role seeding:** `src/seed/lists.ts:50` defines `'person_role'`; `src/server/services.ts:4998`, `10725` and `15072` look up `vid('person_role', 'Private client')` / `vid('person_role', 'Client contact')`.
- **Conflict search:** `src/domain/matterConflicts.ts:143` (`buildEffectiveConflictParties`) and `:242` (`searchMatterConflicts`) compute effective conflict parties across matters.
- **Merge execution:** `src/server/services.ts:7263-7720` (`executeMerge`) merges duplicate people/organisations in `TenantPartyRepository` (`core/src/tenancy/partyRepository.ts:735`).
- **Restricted matter enforcement:** `canAccessMatter` (`core/src/domain/rbac/resolver.ts:628`).

---

## 4. Scope & Exact Changes

### 4.1 Canonical persona & `'person_role'` seeding (`ADR 0033`)

- Confirm `Person.relationshipRoleIds` uses stable `'person_role.*'` keys (`'person_role.private_client'` alongside `'person_role.client_contact'`, etc.), keeping display label lookups in `src/server/services.ts:4998, 10725, 15072` backwards-compatible while ensuring newly created/seeded records persist stable `'person_role.private_client'` IDs with zero broken references.
- Verify multi-matter party linking allows the same canonical `PersonRecord` to hold different relationship codes and capacities per matter (e.g., `CL` on Matter A and `OP`, `TP` or `NO` on Matter B) without duplicating the `PersonRecord` or merging matter-specific capacity metadata onto the person row.

### 4.2 Full conflict search & restricted-matter redaction

- Audit `buildEffectiveConflictParties` (`src/domain/matterConflicts.ts:143`) and `searchMatterConflicts` (`:242`) so conflict checks traverse:
  - all active and historical/linked `MatterParty` rows across all `8` relationship codes (`CL | JC | CC | OP | CP | CO | TP | NO`) and all `70` capacities;
  - alternative email addresses in `person_emails` and linked organisations / group relationships where applicable.
- Verify restricted-matter redaction: if a matching party appears on an `isStaffMatter` or `hasEthicalWall` matter that the acting user cannot view (`!canAccessMatter`), the conflict response preserves conflict-safety without leaking matter titles, client names, participant names or other restricted metadata (consistent with `S0-07`/`B7` and `canAccessMatter`).

### 4.3 Single-transaction `executeMerge` hardening

- Verify `executeMerge` (`src/server/services.ts:7263-7720`) runs inside a single tenant PostgreSQL transaction (`TenantPartyRepository`):
  - keeps survivor `MatterParty` links and transfers all distinct `(matterId, relationshipCode, capacity)` links from the merged record onto the survivor without losing multi-capacity roles;
  - transfers `person_emails`, notes and links cleanly;
  - fails closed on self-merge, already-merged source, missing record or cross-tenant ID;
  - rolls back all changes if any step fails (no half-merged state) and writes a structured `audit_entries` record in the same transaction.

### 4.4 Out of Scope

- Splitting `Person` into separate client/contact tables (explicitly rejected by ADR 0033).
- Rewriting duplicate detection thresholds (`S0-09`/`B4` remains intact).
- Any new database migration (`0015` already has the required columns and constraints).

---

## 5. Migrations & Backwards Compatibility

- **Migration required:** `None`. `CORE_REQUIRED_SCHEMA_VERSION` stays `'0015'`.
- Existing `'person_role'` choice rows and `MatterParty` records continue working without downtime or schema changes.

---

## 6. Security, Tenancy & Permissions

- Every directory, conflict-search and merge server action uses `guardedAction` with an explicit policy in `src/server/actionPermissions.ts` (`MAX_KNOWN_GAPS = 0`).
- `TenantContext` is built solely from verified OIDC claims (`src/platform/tenantRuntime.ts`).
- `executeMerge` enforces permission checks and checks target/survivor existence inside the caller's tenant database before mutating rows.
- Restricted matters (`isStaffMatter` and `hasEthicalWall`, even when `restrictedAccessUserIds` is empty per `B12`) fail closed in conflict results via `canAccessMatter`.

---

## 7. Tests Required

1. **Canonical multi-capacity party linking unit/integration tests:** One canonical `PersonRecord` linked as `CL` on Matter A and as `OP` / `TP` / `NO` on Matters B–D; editing capacity on Matter B leaves Matter A unchanged; `'person_role.private_client'` seeded idempotently.
2. **Conflict traversal & restricted-matter redaction tests:** Conflict search finds matches across non-client capacities (`OP`, `CP`, `CO`, `TP`, `NO`), multi-capacity links and secondary `person_emails`; restricted matters (`isStaffMatter` and `hasEthicalWall`) are redacted for unpermitted viewers while still visible to permitted viewers.
3. **Single-transaction `executeMerge` tests:** Merging two canonical people preserves all distinct `(matterId, relationshipCode, capacity)` links and `person_emails`, writes an audit entry, and rolls back cleanly on forced DB error with zero partial mutations.
4. **Two-tenant isolation tests (`P8`):**
   - Forged `tenantId` claims or tampered `personId` / `matterId` / `organisationId` never return or merge records across Tenant A and Tenant B.
   - Cross-tenant conflict search returns zero matches even with identical names/emails across tenants.

---

## 8. Documentation, Help & Backlog Updates

- **Help & documentation (`Rule 11`, `P11`):**
  - Update [quick-conflict-check.ts](file:///c:/1Squared/App/src/docs/articles/quick-conflict-check.ts) (traversal across all 8 relationship codes & capacities, restricted matter handling).
  - Update [duplicate-checks.ts](file:///c:/1Squared/App/src/docs/articles/duplicate-checks.ts) (canonical person records, merge outcome and preserved party links).
  - Update [matters-enquiries-tasks-and-navigation.ts](file:///c:/1Squared/App/src/docs/articles/matters-enquiries-tasks-and-navigation.ts) (`MatterPartyTaxonomy` capacities vs person role tags).
- **Release notes:** Add an `S0-21` entry in `docs/release-notes.md`.
- **Backlog updates (`docs/roadmap/feature-list.md`):**
  - Item `28` (*Clients, contacts and parties*): `Partly built` -> `Completed`.
  - Item `Q1` (*Contact personas vs unified Person records*): `Open` -> `Resolved` (`ADR 0033` Accepted; canonical `PersonRecord` + `MatterPartyTaxonomy`).
  - Record verification of `P8`, `P10`, `P11`.

---

## 9. Manual Setup / External Blockers

- `None`.

---

## 10. Acceptance Criteria

- [ ] `Person.relationshipRoleIds` (`'person_role.private_client'` etc.) seeds cleanly across default and demo tenants with no broken choices or label regressions.
- [ ] Same canonical `PersonRecord` can serve across multiple matters in distinct relationship codes (`CL | JC | CC | OP | CP | CO | TP | NO`) and capacities without duplicating person records.
- [ ] Conflict search traverses all `MatterParty` links and capacities and redacts restricted (`isStaffMatter` / `hasEthicalWall`) matters from unpermitted viewers.
- [ ] `executeMerge` preserves all survivor and merged party links/emails in a single transaction, writes an audit entry and rolls back cleanly on error.
- [ ] Two-tenant isolation tests (forged tenant claims, tampered record IDs, cross-tenant merge and conflict search) pass against PostgreSQL.
- [ ] Help articles (`quick-conflict-check.ts`, `duplicate-checks.ts`, `matters-enquiries-tasks-and-navigation.ts`), `docs/release-notes.md` and `docs/roadmap/feature-list.md` (`28` -> `Completed`, `Q1` -> `Resolved`) are updated in the same PR.
- [ ] `npm run ci` passes cleanly.

---

## 11. Re-plan Signs & Risks

- **Re-plan if:**
  - Any UI or service flow still duplicates a `PersonRecord` merely to represent a different matter capacity;
  - `TenantPartyRepository.executeMerge` touches non-directory tables whose FK constraints block merge without an expand migration;
  - Any seeded `person_role` lookup depends on free-text labels where key-based IDs (`person_role.*`) are required by ADR 0033.
- **Scope note:** No changes to `docs/roadmap/stage-0-plan.md` rows are needed beyond normal completion; `S0-21` row already cites `28, Q1`.
