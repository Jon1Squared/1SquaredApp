# ADR 0033: Contact Personas Across Organisations and Matters

- **Date:** 2026-11-15
- **Status:** Accepted
- **Roadmap:** Stage 0 decision D8, slice S0-21 (`docs/roadmap/stage-0-plan.md`); backlog items 28, Q1
- **Builds on:** [ADR 0028](./0028-tenant-database-and-repositories.md) (tenant databases and repositories), S0-07 (conflict search, B7), S0-09 and S0-16 (record merge, B4)

## Context

Open question `Q1` in `docs/roadmap/feature-list.md` asks:
> *"How do we handle a contact from a client firm who then instructs us separately as an individual?"*

In legal practice, the same natural person frequently interacts with the firm in multiple capacities over time:
- as a director, shareholder, general counsel, or instructing/billing contact at a corporate client (`Organisation`),
- as a private client instructing the firm in their own right (for example on a residential conveyance, will, or employment matter),
- as a joint client (`additionalClientIds`), opposing party, counterparty, guarantor, witness, or professional adviser on another matter, and
- as an introducer or referrer (`referrerContactId`, `referrerPersonId`).

Creating separate `Person` records per persona would split the person's identity verification (CDD/AML), contact details, marketing consent, and matter history across duplicates, and would weaken conflict checking.

At commit `6940cdc` on `develop`, the data model already supports a single `Person` record (`public.people`), linked to organisations via `public.person_organisation_links` (`contactRoleIds`, `isPrimaryContact`, `isCurrent`) and to matters via `matters.client_id`, `matters.additional_client_ids_json`, `matters.instructing_contact_id`, `matters.billing_contact_id`, `matters.referrer_contact_id`, and `public.matter_parties` (`relationshipCode` across 8 relationships `CL`, `JC`, `CC`, `OP`, `CP`, `CO`, `TP`, `NO` and 70 capacities in `MatterPartyTaxonomy`, `src/domain/matterParties.ts:41-635`). However, `Q1` remains marked `Open` until the persona rules, conflict-search traversal across all capacities, restricted-matter redaction on party links, and merge behaviour across multiple capacities are formally specified and tested end to end.

## Decision

### 1. One person record, linked in different capacities
- **Single `Person` identity per natural person (`public.people`):**
  - Every individual known to the tenant is represented by a single `Person` record (`P-xxxxxx`), regardless of how many capacities they hold across organisations and matters.
  - Firm-level relationship roles (`Person.relationshipRoleIds` from the `'person_role'` choice list, `src/seed/lists.ts:50-67`, such as `'person_role.private_client'` / `Private client`, `Client contact`, `Referrer`, `Professional adviser`, `Opposing party`) are multi-valued (`allowMultiple: true`) and summarise the person's relationship standing with the firm.
  - When a person who is already recorded as an organisation contact (`person_organisation_links`) instructs the firm as an individual client (`matters.client_id = person.id` or `additionalClientIds` includes `person.id` or `matter_parties` with `relationshipCode` `'CL'` or `'JC'`), the existing `Person` record is reused and `'person_role.private_client'` is added to `Person.relationshipRoleIds` in the same transaction without removing their `Client contact` role or organisation links.

### 2. Capacity is chosen on each matter and organisation link
- **Per-matter capacity (`Matter` and `MatterParty`):**
  - On each matter, the person's capacity is recorded explicitly for that matter:
    - Primary client (`matter.clientId`) or joint client (`matter.additionalClientIds` / `MatterParty` with `relationshipCode: 'CL' | 'JC'`).
    - Organisation representative (`matter.instructingContactId`, `matter.billingContactId`, or `MatterParty` with `relationshipCode: 'CC'` and `connectedToPartyId` pointing to the client organisation party, with `capacityCodes` such as `['CAP_DECISION_MAKER']`, `['CAP_DIRECTOR_OFFICER']`, or `['CAP_BENEFICIAL_OWNER_PSC']`).
    - Adverse, counterparty, third-party, or neutral capacity (`MatterParty` with `relationshipCode: 'OP' | 'CP' | 'CO' | 'TP' | 'NO'` and `capacityCodes`).
    - Referrer (`matter.referrerContactId`).
  - A person may even hold more than one role on the same matter (for example, `instructingContactId` and `billingContactId`, or a `MatterParty` with multiple `capacityCodes` allowed for its `relationshipCode` in `MatterPartyTaxonomy`).
- **Per-organisation capacity (`PersonOrganisationLink`):**
  - Each `person_organisation_links` row records the person's role at that organisation (`jobTitle`, `department`, `roleWithinOrganisation`, `contactRoleIds`, `isPrimaryContact`, `isCurrent`, `startDate`, `endDate`). A person may be linked to multiple organisations simultaneously or historically.

### 3. Conflict search follows every capacity and never leaks restricted matters
- **Both conflict searches traverse every capacity (`S0-07`, `B7`):**
  - `buildEffectiveConflictParties` and `searchMatterConflicts` (`src/domain/matterConflicts.ts:143-520`) and `runEnquiryConflictSearch` / `detectPreliminaryConflicts` (`src/domain/enquiries.ts:382-720`) inspect:
    1. `matter.clientId` and `matter.additionalClientIds` (`CL` / `JC`),
    2. `matter.instructingContactId`, `matter.billingContactId`, and `matter.referrerContactId`,
    3. every `matter.parties` (`public.matter_parties`) entry across all `relationshipCode` and `capacityCodes` values (distinguishing aligned `CL`/`JC`/`CC` from adverse `OP`/`CP`/`CO` and third-party/neutral `TP`/`NO`),
    4. every `person_organisation_links` row connecting a searched person to an organisation (so when an organisation contact instructs the firm as an individual against a party, or when a new party is adverse to an organisation where the individual is a linked contact/director, the cross-persona link is surfaced with the exact capacity and organisation relationship), and
    5. enquiries (`linkedPersonId`, `linkedOrganisationId`, caller details, and `otherPartiesNamed`).
- **Restricted and ethical-wall matters never leak through party links (`Rule 9`, `B12`):**
  - When a person or organisation is linked (as client, instructing/billing/referrer contact, or `matter_parties` entry) to a matter where `isStaffMatter === true` or `hasEthicalWall === true` and the viewing user is not authorised (`!canPersonAccessMatter`), the person/organisation profile and party-link queries exclude the restricted matter from visible matter lists and party summaries, while conflict search emits only a redacted restricted hit (`restricted: true`, `redactRecordId(tenantId, matter.id)`) with no matter number, title, client name, or capacity details leaked.

### 4. Merging two persons (or two organisations) preserves all capacities in one transaction
- Building on `S0-09` (`B4`) and `S0-16`/`S0-17a`/`S0-18` (`executeMerge` in `src/server/services.ts:7263-7720` and `TenantPartyRepository.executeMergeInTransaction` in `core/src/tenancy/partyRepository.ts`):
  - **Refusal guard:** Employee and leaver records are refused (`isEmployeeOrLeaverRecord`).
  - **Single PostgreSQL transaction (`withTenantTransaction`):**
    1. **Survivor profile & relationship roles:** Unions `survivor.relationshipRoleIds` and `merged.relationshipRoleIds` so all personas (e.g. both `Client (individual)` and `Client contact`) are retained on the survivor.
    2. **Person–organisation links (`public.person_organisation_links`):** Repoints links from `mergedId` to `survivorId`; when both records were linked to the same organisation, `mergeCollidingLinkIntoSurvivor` unions `contactRoleIds`, preserves `isCurrent: true` and `isPrimaryContact: true`, and widens `startDate`/`endDate`.
    3. **Matter references & `public.matter_parties` capacities:** Repoints `clientId`, `additionalClientIds` (deduplicated), `instructingContactId`, `billingContactId`, `referrerContactId`, `parties[].linkedRecordId`, `parties[].connectedToPartyId`, and `conflictCheckRecord` (`parties` and `matches`). When `survivorId` and `mergedId` both appear in `matter.parties` on the same matter with the same `relationshipCode`, deduplicates the party entry by unioning `capacityCodes` and preserving `notes` and `identifiers`; when they appear in different relationships on the same matter, both party rows are repointed to `survivorId` so no capacity is lost.
    4. **All other module references:** Repoints `enquiries` (`linked_person_id`, `linked_organisation_id`, `referrer_person_id`, `referred_to_organisation_id`, `conflict_snapshot_json`), `quotes` (`linked_person_id`, `linked_organisation_id`), `tasks` (`task_linked_records`, deduplicated), `documents` (`primary_client_id`, `recipient_party_id`, `document_links`), `notes`, `notifications`, `recently_viewed`, `organisations.parent_organisation_id`, and `pms_links` (recording any PMS code collision in `merge_history.pms_link_conflicts_json`).
    5. **Tombstone and audit:** Marks the merged record as a tombstone (`mergedIntoId = survivor.id`) and writes `public.merge_history` and `public.audit_entries` in the same transaction.

## Alternatives Considered

- **Separate `Person` record per persona (e.g. one record for "Emma Clarke at Severn Freight Services Ltd" and another for "Emma Clarke (private client)").** Rejected: duplicates personal data, breaks single-view CDD/AML verification and GDPR subject-access/rectification handling, and requires manual linking to detect conflicts.
- **Storing capacity only on `Person` rather than per matter.** Rejected: a person can be the client on Matter A, an instructing contact for an organisation on Matter B, and an opposing director on Matter C; capacity is an attribute of the person's link to each matter and organisation.

## Consequences

- Open Question `Q1` in `docs/roadmap/feature-list.md` is closed (`Resolved`) and item `28` (*Clients, contacts and matter parties*) retains `Completed` with explicit multi-persona conflict search, restricted-matter party isolation, and single-transaction merge execution tests (`core/tests/parties-matters-postgres.test.ts` and `core/tests/isolation.test.ts`) and updated Help documentation (`duplicate-checks`, `quick-conflict-check`, `matter-opening-and-risk`).
