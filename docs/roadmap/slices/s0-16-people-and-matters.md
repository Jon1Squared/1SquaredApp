# S0-16: People, organisations, links, notes, matters and parties on PostgreSQL

| | |
|---|---|
| Backlog | P2, P8, B6, items 4 (Client and matter inception) and 28 (Clients, contacts and matter parties) |
| Decision | [ADR 0028: Tenant Databases and Repositories](../../decisions/0028-tenant-database-and-repositories.md) (D3, revised and accepted 9 November 2026 — Owner Decisions 2, 4, 5, 9 and §6 `row_version`) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4b) |
| Branch | `s0-16-people-and-matters`, from `s0-15-key-dates-and-audit-log` (or `develop` if Checkpoint 4a has merged), targeting `develop` |
| Change class | Core feature / persistence cut-over (`core/src/tenancy/`, `core/src/tenancy/migrations/`, `src/server/`, `src/app/`, `scripts/`). |
| Size | L |
| Depends on | S0-15 (`TenantScopedRepository`, `TenantKeyDateRepository` live at runtime, `TenantAuditRepository` `audit_entries`, and S0-15 async caller conversion). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) only for running migrations and the one-off import against an Azure environment; local and CI PostgreSQL execution is unblocked. |
| Baseline | `develop` at `52390b9` |

## Scope and split evaluation (stage plan check)

We evaluated splitting S0-16 into `S0-16a` (Directory: `people`, `organisations`, `person_organisation_links`, `notes`, `merge_history`) and `S0-16b` (Matters: `matters`, `matter_parties`, `matter_number_sequences`) against keeping S0-16 as one slice:

1. **S0-15 already absorbs the async signature churn:** 18 of the 21 directory and matter functions in `src/server/services.ts` are **already `async` after S0-15** (because S0-15 moved `audit_entries` and `executeMerge` moved in S0-14). Only 3 directory/matter exports in `services.ts` (`activeEmployees`, `generateMatterNumber`, `findCandidateDuplicatesForRecord`) plus the PMS/finance/auth readers that join against `people` and `matters` convert to `async` in S0-16.
2. **Splitting directory from matters creates throwaway cross-store complexity:** `saveMatterRecord` (`src/server/services.ts:3692-3832`) creates pending client/party `people`, `organisations`, and `links` while saving a `matter`, and `executeMerge` (`:5639-6134`) atomically repoints `people`, `organisations`, `links`, `notes`, `matters`, `matter_parties`, and conflict check snapshots together. Keeping directory and matters in a single slice puts all of those writes inside **one PostgreSQL transaction** immediately instead of building and deleting a one-slice compensation bridge between `S0-16a` and `S0-16b`.

**Recommendation:** Keep **S0-16 as one branch (`s0-16-people-and-matters`)** structured as logical commits (migrations & repositories -> directory cut-over -> matters, `row_version` & `B6` sequence cut-over -> tests & docs). If the post-S0-15 async measurement at the end of Checkpoint 4a shows unexpectedly high friction, the clean contingency split (`S0-16a` directory / `S0-16b` matters) is recorded in `docs/roadmap/stage-0-plan.md` for owner decision before Checkpoint 4b starts.

## What exists today

Checked against `develop` (`52390b9`):

1. **JSON store collections (`src/server/store.ts:76, 79-81, 93, 95`):**
   - `FirmStore` holds `people` (`:76`), `organisations` (`:79`), `links` (`PersonOrganisationLink[]`, `:80`), `matters` (`Matter[]`, including embedded `parties: MatterParty[]`, `:81`), `notes` (`NoteEntry[]`, `:93`), and `mergeHistory` (`MergeHistory[]`, `:95`), plus `counters` (`:97`, `nextId` at `:1122`).
2. **Matter number reissue bug (`B6`, `src/server/services.ts:2905-2927`):**
   - `generateMatterNumber(store, clientId)` computes the next suffix by scanning `store.matters` (`maxSeq = existingForClient.length` and `/-(\d+)$/`). If a draft/vetoed opening is removed, rolled back, or deleted, the highest suffix disappears and its matter number is issued a second time (`docs/roadmap/feature-list.md:102`).
3. **No optimistic concurrency on `matters` (ADR 0028 §6):**
   - `Matter` (`src/domain/types.ts:942-1047`) has `updatedAt` (`nextMonotonicIsoTimestamp` at `src/server/services.ts:3352`), with no `row_version` check to prevent concurrent edits from silently overwriting each other.
4. **Every runtime reader and writer of `people`, `organisations`, `links`, `notes`, `mergeHistory`, and `matters` outside `store.ts`:**
   - **`src/server/services.ts` (362 property accesses across directory, matter, auth, merge, conflict, intake, and PMS services):**
     - Auth & session resolution: `requireAuthenticatedActor` (`:341`), `switchUserInDemoMode` (`:423`), `activeEmployees` (`:534`), `resolveOrProvisionEntraEmployee` (`:12469`).
     - Directory & notes: `savePersonRecord` (`:1446`, including S0-30 `employee:edit_core` + MFA email-binding checks), `saveOrganisationRecord` (`:2447`), `createOrUpdateLink` (`:2664`), `deleteLink` (`:2764`), `addNoteToRecord` (`:2804`), `dismissDuplicateMatch` (`:5538`), `executeMerge` (`:5639`), `findCandidateDuplicatesForRecord` (`:6136`).
     - Matters & conflicts: `generateMatterNumber` (`:2905`), `runMatterOpeningGate` (`:2960`), `saveMatterRecord` (`:3329`), `markEngagementLetterDrafted` (`:4776`), `liftMatterRestriction` (`:4833`), `runMatterConflictSearchRecord` (`:4970`), `updateMatterConflictRecord` (`:5101`), `signOffMatterCostsRecord` (`:5367`).
     - Cross-module callers reading `people` / `organisations` / `matters`: `getAppSnapshotInScope` (`:611`), `reassignLeaverOwnedRecords` (`:1196`), `prepareEnquiryConversion` (`:8570`), `finalizeEnquiryConversionToMatter` (`:8809`), `prepareQuoteConversionRecord` (`:12106`), `finalizeQuoteConversionToMatter` (`:12333`), PMS helpers (`:9022`–`:9685`), credit-control actions (`:10623`–`:10762`), and `runKeyDateReminderSchedulerRecord` (`:13684`).
   - **`src/server/authorize.ts:125`:** `buildGuardedActorContext` calls `getStore()` to read `store.people` (and `store.teams`) for `resolvePersonPermissionSet`.
   - **`src/server/visibility.ts:26, 35`:** `buildRecordVisibility` reads `store.people` and `store.matters` (`canPersonAccessMatter` for `isStaffMatter` and `hasEthicalWall` with `B12` fail-closed empty allow-list).
   - **`src/server/conflictReview.ts:121, 135`:** `resolveConflictReviewTaskRouting` reads `store.people`.
   - **`src/server/financeServices.ts:164-260`:** `verifyFinanceActorAndPermission` and `getMatterFinanceRows` call `getStore()` and read `store.people` and `store.matters` to enforce `finance:view` / `finance:view_matter` and exclude restricted matters (`S0-10` / ADR 0029).
   - **`src/server/documentGenerationServices.ts:229, 548, 849, 1294-1431` and `src/app/api/documents/download/route.ts:60, 65`:** read `store.people`, `store.organisations`, `store.links`, and `store.matters` for merge-field hydration and matter barrier checks (`canActorAccessGeneratedDocument`).
   - **`src/server/documentStoreServices.ts:226-2310`:** reads `store.people` and `store.matters` for SharePoint folder routing, permission sync, and restricted-matter access checks.
   - **`src/app/actions.ts:761-775`:** `linkPmsRecordAction` calls `getStore()` to verify existence in `store.people`, `store.organisations`, and `store.matters`.
   - **`src/app/api/matters/extract/route.ts:2377, 2528, 2703`:** calls `getStore()` directly to read `people`, `organisations`, `links`, and `values` during AI matter extraction (`S0-06`).

## Tables

Added behind `TenantDirectoryRepository` (`core/src/tenancy/directoryRepository.ts`) and `TenantMatterRepository` (`core/src/tenancy/matterRepository.ts`), both extending `TenantScopedRepository`. Every table includes `tenant_id TEXT NOT NULL`, verified in SQL (`WHERE tenant_id = $1`) and on read (`assertRowTenant`):

| Table | Normalised columns | `jsonb` columns (per ADR 0028 §2) | Primary key & indexes |
|---|---|---|---|
| `people` | `tenant_id`, `id`, `first_name`, `preferred_name`, `other_names`, `surname`, `title_id`, `date_of_birth`, `is_employee BOOLEAN`, `employee_role_id`, `app_role`, `entra_object_id`, `primary_email_lower` (derived index column for fast case-insensitive lookup), `job_title`, `department_id`, `office_id`, `supervisor_id`, `is_fee_earner BOOLEAN`, `default_hourly_rate_gbp NUMERIC(12,2)`, `client_status_id`, `aml_status_id`, `id_verified_on`, `id_expiry_date`, `created_from_enquiry_id`, `merged_into_id`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `emails_json` (`EmailEntry[]`), `phones_json` (`PhoneEntry[]`), `addresses_json` (`AddressEntry[]`), `relationship_role_ids_json`, `roles_json`, `permission_overrides_json`, `dismissed_duplicate_ids_json`, `custom_fields_json` (tenant-configured custom fields), `profile_json` (remaining optional CDD/onboarding attributes), `employment_json` (carried intact until `S0-17b` normalises employment history) | `PRIMARY KEY (tenant_id, id)`; `UNIQUE INDEX idx_people_tenant_entra_oid ON people (tenant_id, entra_object_id) WHERE entra_object_id IS NOT NULL`; `INDEX idx_people_tenant_email ON people (tenant_id, primary_email_lower)`; `INDEX idx_people_tenant_surname ON people (tenant_id, lower(surname), lower(first_name))`; `INDEX idx_people_tenant_employee ON people (tenant_id, is_employee) WHERE merged_into_id IS NULL` |
| `organisations` | `tenant_id`, `id`, `legal_name`, `trading_name`, `organisation_type_id`, `company_number`, `vat_number`, `client_reference`, `general_email`, `main_phone`, `website`, `parent_organisation_id`, `relationship_partner_id`, `conflict_status`, `aml_status_id`, `client_status_id`, `created_from_enquiry_id`, `merged_into_id`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `registered_address_json`, `trading_address_json`, `relationship_type_ids_json`, `sector_ids_json`, `dismissed_duplicate_ids_json`, `custom_fields_json`, `profile_json` (optional onboarding/CDD details) | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_organisations_tenant_name ON organisations (tenant_id, lower(legal_name))`; `INDEX idx_organisations_tenant_company_no ON organisations (tenant_id, company_number) WHERE company_number <> ''`; `INDEX idx_organisations_tenant_parent ON organisations (tenant_id, parent_organisation_id) WHERE parent_organisation_id IS NOT NULL` |
| `person_organisation_links` | `tenant_id`, `id`, `person_id`, `organisation_id`, `job_title`, `department`, `role_within_organisation`, `is_primary_contact BOOLEAN`, `is_current BOOLEAN`, `start_date`, `end_date`, `contact_status_id`, `notes`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `contact_role_ids_json` (`string[]`) | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_po_links_tenant_person ON person_organisation_links (tenant_id, person_id)`; `INDEX idx_po_links_tenant_org ON person_organisation_links (tenant_id, organisation_id)` |
| `notes` | `tenant_id`, `id`, `record_type`, `record_id`, `body`, `visibility`, `pinned BOOLEAN`, `created_by_id`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | *(none — pure normalised columns)* | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_notes_tenant_record ON notes (tenant_id, record_type, record_id, created_at DESC)` |
| `merge_history` | `tenant_id`, `id`, `record_type`, `survivor_id`, `merged_id`, `merged_by_id`, `merged_at TIMESTAMPTZ` | `summary_json` (structured merge field/repoint summary, `MergeHistory`) | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_merge_history_tenant_survivor ON merge_history (tenant_id, record_type, survivor_id)`; `INDEX idx_merge_history_tenant_merged ON merge_history (tenant_id, record_type, merged_id)` |
| `matters` | `tenant_id`, `id`, `row_version INTEGER NOT NULL DEFAULT 1`, `matter_number`, `title`, `client_type`, `client_id`, `instructing_contact_id`, `billing_contact_id`, `referrer_person_id`, `referrer_organisation_id`, `legal_entity_id`, `department_id`, `team_id`, `office_id`, `practice_area_id`, `work_type_subcategory_id`, `status_id`, `stage_group_id`, `current_stage_id`, `responsible_partner_id`, `responsible_fee_earner_id`, `supervisor_id`, `risk_rating_id`, `conflict_check_status`, `conflict_cleared_by_id`, `is_staff_matter BOOLEAN NOT NULL DEFAULT FALSE`, `has_ethical_wall BOOLEAN NOT NULL DEFAULT FALSE`, `source_enquiry_id`, `source_quote_id`, `opened_on`, `closed_on`, `destruction_date`, `engagement_letter_status`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `additional_client_ids_json` (`string[]`), `restricted_access_user_ids_json` (`string[]`), `fields_json` (590 work-type-specific field values, ADR 0028 §2), `custom_fields_json` (tenant-configured custom fields), `conflict_check_record_json`, `risk_assessment_json` (validated S0-08 risk answers & server-scored snapshot), `costs_json` (fee basis, estimates, partner sign-off, disbursements), `opening_record_json` (immutable opening record & gate state), `milestones_json` | `PRIMARY KEY (tenant_id, id)`; `UNIQUE INDEX idx_matters_tenant_number ON matters (tenant_id, matter_number)`; `INDEX idx_matters_tenant_client ON matters (tenant_id, client_id)`; `INDEX idx_matters_tenant_status ON matters (tenant_id, status_id, updated_at DESC)`; `INDEX idx_matters_tenant_fee_earner ON matters (tenant_id, responsible_fee_earner_id)`; `INDEX idx_matters_tenant_restricted ON matters (tenant_id, is_staff_matter, has_ethical_wall)` |
| `matter_parties` | `tenant_id`, `id`, `matter_id`, `entity_type` (`'person' \| 'organisation'`), `entity_id`, `relationship_id`, `capacity_id`, `reference`, `acting_solicitor_organisation_id`, `acting_solicitor_person_id`, `notes`, `sort_order INTEGER NOT NULL DEFAULT 0`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `metadata_json` (optional capacity-specific party fields) | `PRIMARY KEY (tenant_id, id)`; `FOREIGN KEY (tenant_id, matter_id) REFERENCES matters (tenant_id, id) ON DELETE CASCADE`; `INDEX idx_matter_parties_tenant_matter ON matter_parties (tenant_id, matter_id, sort_order)`; `INDEX idx_matter_parties_tenant_entity ON matter_parties (tenant_id, entity_type, entity_id)` |
| `matter_number_sequences` | `tenant_id TEXT NOT NULL`, `prefix TEXT NOT NULL`, `last_number BIGINT NOT NULL CHECK (last_number >= 0)`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` | *(none)* | `PRIMARY KEY (tenant_id, prefix)` — monotonic per-tenant counter (`INSERT ... ON CONFLICT (tenant_id, prefix) DO UPDATE SET last_number = matter_number_sequences.last_number + 1, updated_at = NOW() RETURNING last_number`), allocated in an autonomous connection so even rolled-back openings or deleted matters never reissue a number (**fixes B6**) |
| `tenant_record_sequences` | `tenant_id TEXT NOT NULL`, `counter_key TEXT NOT NULL` (`'person'`, `'organisation'`, `'link'`, `'note'`, `'matter'`, etc.), `last_value BIGINT NOT NULL` | *(none)* | `PRIMARY KEY (tenant_id, counter_key)` — replaces `store.counters` (`nextId`) for moved modules |

### Optimistic concurrency (`row_version`, ADR 0028 §6) and staff/ethical-wall enforcement

- **Optimistic concurrency:** `Matter` gains `rowVersion: number` (default `1`). Every `TenantMatterRepository.updateMatter(ctx, matter, expectedRowVersion)` runs:
  ```sql
  UPDATE matters
     SET ..., row_version = row_version + 1, updated_at = $...
   WHERE tenant_id = $1 AND id = $2 AND row_version = $3
  RETURNING *;
  ```
  If `rowCount === 0` while the matter exists for `tenant_id`, the repository returns/throws `CONFLICT_CONCURRENT_MODIFICATION` (`"This matter was updated by someone else. Reload and try again."`) instead of overwriting concurrent changes.
- **Staff matters & ethical walls (Rule 9, B12):** Every repository/service method returning matters or matter parties enforces `canAccessMatter` (`isStaffMatter` and `hasEthicalWall`, failing closed when `restrictedAccessUserIds` is empty per `B12`), and conflict searches continue redacting restricted hits via `redactRecordId` (`S0-07`).

## Migrations

Expand-then-contract migrations in `CORE_TENANT_MIGRATIONS` (`core/src/tenancy/migrations/index.ts`):

1. **`0007_directory_and_matters_expand`** (`kind: 'expand'`, `requiresAppliedVersion: '0006'`):
   - **`upSql`:** `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for `tenant_record_sequences`, `matter_number_sequences`, `people`, `organisations`, `person_organisation_links`, `notes`, `merge_history`, `matters`, and `matter_parties`.
   - **`downSql`:** Drops indexes and tables in reverse dependency order (`DROP TABLE IF EXISTS matter_parties, matters, merge_history, notes, person_organisation_links, organisations, people, matter_number_sequences, tenant_record_sequences;`).
2. **`0008_matter_restriction_metadata_contract`** (`kind: 'contract'`, `requiresAppliedVersion: '0007'`):
   - Once `matters` lives in PostgreSQL (`0007`), `TenantKeyDateRepository` reads `is_staff_matter`, `has_ethical_wall`, and `restricted_access_user_ids_json` directly from `matters` (falling back gracefully if `matters` is empty only before import), retiring S0-14's temporary `matter_restriction_metadata` bridge table.
   - **`upSql`:** `DROP TABLE IF EXISTS matter_restriction_metadata;`
   - **`downSql`:** Recreates `matter_restriction_metadata` (`tenant_id`, `matter_id`, `is_restricted`, `restricted_access_user_ids`, `updated_at`, `PRIMARY KEY (tenant_id, matter_id)`) and populates it from `matters` (`INSERT INTO matter_restriction_metadata SELECT tenant_id, id, (is_staff_matter OR has_ethical_wall), restricted_access_user_ids_json, updated_at FROM matters ON CONFLICT DO NOTHING;`) so rolling back `0008` preserves full key-date restriction state.

## Import (one-off JSON store to PostgreSQL)

1. **Entry point:** `npm run db:import -- --modules directory,matters [--store-path <path>]` (`importDirectoryAndMattersFromStore(ctx, store)` in `scripts/import-store-to-postgres.ts`).
2. **Execution & `B6` counter initialisation:**
   - Inside `withTenantTransaction(ctx, ...)`, upserts `people`, `organisations`, `person_organisation_links`, `notes`, `merge_history`, `matters` (`row_version = COALESCE(existing.row_version, 1)`), and `matter_parties` (replacing the party list for each imported matter idempotently).
   - Computes the maximum numeric suffix per matter-number `prefix` across all imported `store.matters` (plus client-count baseline) and upserts `matter_number_sequences` using `GREATEST(matter_number_sequences.last_number, EXCLUDED.last_number)` — guaranteeing a second run never lowers a sequence counter.
   - Seeds `tenant_record_sequences` (`person`, `organisation`, `link`, `note`, `matter`, `merge`) using `GREATEST(...)` against imported IDs and `store.counters`.
3. **Verification:**
   - Re-queries on a fresh `TenantScopedRepository` connection to verify exact row counts for `people`, `organisations`, `person_organisation_links`, `notes`, `merge_history`, `matters`, and total `matter_parties`, verifies `matter_number_sequences.last_number >= max_suffix` for every prefix, and asserts `tenant_id === ctx.tenantId`.
   - Wired into `scripts/seed-demo-tenant.ts` (`S0-11b`), `resetAllDemoData`, `clearAllDataToCleanDeployment`, and `e2e/global-setup.ts`.

## Async conversion and effort estimate

1. **`src/server/services.ts`:**
   - **Already `async` after S0-14 & S0-15 (19 exports — internal body moved from `store` to `TenantDirectoryRepository` / `TenantMatterRepository` + same-transaction `TenantAuditRepository`, external signature unchanged):** `requireAuthenticatedActor` (`:341`), `switchUserInDemoMode` (`:423`), `getAppSnapshot` (`:604`), `savePersonRecord` (`:1446`), `saveOrganisationRecord` (`:2447`), `createOrUpdateLink` (`:2664`), `deleteLink` (`:2764`), `addNoteToRecord` (`:2804`), `saveMatterRecord` (`:3329`), `markEngagementLetterDrafted` (`:4776`), `liftMatterRestriction` (`:4833`), `runMatterConflictSearchRecord` (`:4970`), `updateMatterConflictRecord` (`:5101`), `signOffMatterCostsRecord` (`:5367`), `dismissDuplicateMatch` (`:5538`), `executeMerge` (`:5639`), `resolveOrProvisionEntraEmployee` (`:12469`), plus cross-module `prepareEnquiryConversion` (`:8570`), `prepareQuoteConversionRecord` (`:12106`), `reassignLeaverOwnedRecords` (`:1196`), `linkPmsRecord` (`:9467`), `unlinkPmsRecord` (`:9538`), `createRecordFromPms` (`:9559`).
   - **Synchronous -> `async` in S0-16 (8 exports in `services.ts`):**
     - Directory & matters (3): `activeEmployees` (`:534`), `generateMatterNumber` (`:2905` -> `allocateNextMatterNumber(ctx, clientId)`), `findCandidateDuplicatesForRecord` (`:6136`).
     - PMS/credit-control readers joining `people`, `organisations`, and `matters` (5 — converted now so they read live PostgreSQL `people`/`matters` instead of stale JSON between S0-16 and S0-18): `getMatterPmsViewBundle` (`:9022`), `getClientPmsViewBundle` (`:9097`), `getPmsAdminSnapshot` (`:9255`), `rerunAutomaticPmsMatching` (`:9387`), `requestMatterBill` (`:10623`).
2. **Other server modules & routes:**
   - `src/server/authorize.ts:115`: `buildGuardedActorContext` -> `async` (awaited inside already-`async` `guardedAction` `:157` and `guardedRoute` `:262` — zero external signature change), reading `people` from `TenantDirectoryRepository`.
   - `src/server/visibility.ts:17`: add `loadVisibilityDataSlice(ctx, store)` reading `people` and `matters` from PostgreSQL (`keyDates` from S0-15, `teams`/`enquiries`/`quotes` from `store` until S0-17).
   - `src/server/financeServices.ts:108, 234, 376, 456`: `verifyFinanceActorAndPermission`, `getMatterFinanceRows`, `getMyFinanceFigures`, and `getFirmFinance` -> `async` so S0-10 restricted-matter exclusions immediately reflect PostgreSQL `people` and `matters`.
   - `src/server/documentGenerationServices.ts` & `src/app/api/documents/download/route.ts:60, 65` & `src/server/documentStoreServices.ts`: read `people`, `organisations`, `links`, and `matters` from `TenantDirectoryRepository` / `TenantMatterRepository` (callers are already `async` after S0-14).
   - `src/app/actions.ts`: add `await` inside `findDuplicateCandidatesAction` (`:419`), `rerunAutomaticPmsMatchingAction` (`:794`), `requestMatterBillAction` (`:1079`), and replace `getStore()` in `linkPmsRecordAction` (`:761`) with repository existence checks.
   - `src/app/**/page.tsx` (6 already-`async` Server Components, 9 `await` insertions): `src/app/page.tsx:27,33,39`, `src/app/matters/page.tsx:13`, `src/app/matters/[id]/page.tsx:80`, `src/app/organisations/[id]/page.tsx:57`, `src/app/people/[id]/page.tsx:62,70,84`, `src/app/admin/[[...slug]]/page.tsx:33`.
   - `src/app/api/matters/extract/route.ts:2377, 2528, 2703`: replace the 3 `getStore()` calls with `TenantDirectoryRepository` reads (`values` from `store` until S0-17).
   - **Tests (~55 `await` additions across 5 files):** `core/tests/isolation.test.ts` (16 finance/PMS calls), `core/tests/rbac.test.ts` (26 finance/duplicate/matter-number calls), `src/pms/pms.test.ts` (8 calls), `src/domain/home.test.ts` (5 calls), plus new `B6` and `row_version` tests.

**Honest effort estimate:** **Size L (~3–4 engineering days)** — substantial domain surface (`people`, `organisations`, `matters`, `matter_parties`, `executeMerge`, conflict search inputs), while async caller churn is small because S0-15 already converted the audit-writing functions.

## Operations that span modules (Owner Decision 5)

1. **Directory & matter mutations + `audit_entries` (same PostgreSQL transaction):**
   - `savePersonRecord`, `saveOrganisationRecord`, `createOrUpdateLink`, `deleteLink`, `addNoteToRecord`, `dismissDuplicateMatch`, `markEngagementLetterDrafted`, `liftMatterRestriction`, `runMatterConflictSearchRecord`, `updateMatterConflictRecord`, `signOffMatterCostsRecord`, and `resolveOrProvisionEntraEmployee` now write their records and `audit_entries` inside **one `withTenantTransaction(ctx, ...)`**, removing all `@remove-in S0-16` calls from `src/server/auditAdapter.ts`.
2. **`saveMatterRecord` (`:3329` — spans `matters`, `matter_parties`, pending `people`/`organisations`/`links`, `key_dates`, `audit_entries` in Postgres + `enquiries`/`quotes`/`tasks`/`signOffs` in JSON until S0-17 + `DocumentStore` folder sync):**
   - Matter number allocation (`allocateNextMatterNumber`) commits in its own short transaction on `matter_number_sequences` so numbers never roll back or reissue (`B6`).
   - Snapshot JSON `store` (`storeSnapshot = structuredClone(store)`), stage any `enquiries`/`quotes` conversion status updates (`finalizeEnquiryConversionToMatter`, `finalizeQuoteConversionToMatter`), automatic opening `tasks`, and cost `signOffs` in `store`, then execute **one PostgreSQL transaction** writing pending `people`/`organisations`/`links`, `matters` (`row_version` checked), `matter_parties`, carried/seeded `key_dates`, and all `audit_entries`. If the Postgres transaction fails, restore `storeSnapshot` and `saveStore(store)`; if `saveStore(store)` fails, roll back the Postgres transaction. Sync SharePoint matter folder metadata via `TenantDocumentStoreRepository` in the same tenant context.
3. **`executeMerge` (`:5639` — spans `people`, `organisations`, `links`, `notes`, `merge_history`, `matters`, `matter_parties`, `generated_documents`/`document_links`, `audit_entries` in Postgres + `enquiries`, `quotes`, `tasks`, `pmsLinks`, `recentlyViewed`, `notifications` in JSON until S0-17/S0-18):**
   - Snapshot JSON `store`, repoint references in `enquiries`, `quotes`, `tasks`, `pmsLinks`, `recentlyViewed`, and `notifications`, and run **one PostgreSQL transaction** repointing `people` (tombstone `mergedIntoId`), `organisations` (including `parentOrganisationId`, leaving `relationshipPartnerId` untouched per S0-09), `person_organisation_links` (de-duplicated with S0-09 collision rules), `notes`, `matters` & `matter_parties` & conflict records, `generated_documents` & `document_links`, `merge_history`, and `audit_entries`. Restore `storeSnapshot` on any PostgreSQL error so neither store is ever left half-merged.
4. **`prepareEnquiryConversion` (`:8570`) and `prepareQuoteConversionRecord` (`:12106`):**
   - Run the full conflict check (`searchMatterConflicts`) against PostgreSQL `people`, `organisations`, `links`, and `matters` (`B5`, `B7`). Snapshot JSON `store`, update the enquiry/quote conversion state in `store`, and write any newly created `people`, `organisations`, `person_organisation_links`, and `conflict-decision` `audit_entries` in one PostgreSQL transaction (restoring `storeSnapshot` on failure).
5. **`reassignLeaverOwnedRecords` (`:1196`):**
   - Snapshot JSON `store`, update open `enquiries` and `tasks` in `store`, and in one PostgreSQL transaction verify `isLeaverPerson`, update `matters` (`responsibleFeeEarnerId`, `responsiblePartnerId`, `supervisorId`, `restrictedAccessUserIds`), sync `TenantDocumentStoreRepository` folder permissions, and write per-record `audit_entries` (compensating `storeSnapshot` on failure; becomes 100% Postgres in S0-17).

## Tests

- **Unit & domain persistence tests (`core/tests/directory-and-matters-postgres.test.ts` — new, plus existing `rbac`, `matterRiskAssessment`, `conflict` suites):**
  - **`B6` monotonic matter-number sequence test:** allocate `MAT-0001` and `MAT-0002` for a client, simulate a vetoed/rolled-back opening and delete the latest matter row, then open another matter for the same client and assert it receives `MAT-0003` (never reissuing `0002`); also test concurrent `Promise.all` matter creations for the same client and assert strictly unique sequential numbers.
  - **`row_version` optimistic concurrency test:** load a matter twice (`rowVersion: 1`), save edit A (`rowVersion` -> `2`), then attempt save edit B with stale `rowVersion: 1` and assert `CONFLICT_CONCURRENT_MODIFICATION` (both `code` and `message`), verifying via a fresh database connection that edit A's fields remain intact.
  - **Staff & ethical-wall query enforcement (`B12`):** verify restricted staff matters and ethical-wall matters (including empty `restrictedAccessUserIds`) are excluded from snapshots, search, conflict details (`redactRecordId`), document downloads, and all S0-10 finance roll-ups.
  - **Cross-store compensation tests:** force a failure mid-way through `saveMatterRecord` and `executeMerge` and verify via a fresh Postgres connection and fresh JSON store read that both stores rolled back cleanly.
  - **One-off import idempotency test:** run `importDirectoryAndMattersFromStore` twice and verify row counts, `matter_parties`, and `matter_number_sequences` parity.
- **Contract tests:**
  - `0007` and `0008` `upSql` -> `downSql` -> `upSql` round-trip in `core/tests/migrations-postgres.test.ts`.
  - Static/runtime check confirming `store.people`, `store.organisations`, `store.links`, `store.notes`, `store.mergeHistory`, and `store.matters` are never read or mutated by runtime routes/actions/services.
- **Two-tenant isolation tests (`core/tests/isolation.test.ts`, Rule 9):**
  - Against separate real databases (`pg_tenant_a_test`, `pg_tenant_b_test`) with per-tenant `SET ROLE`:
    - **Positive control:** Tenant A creates and queries its own people, organisations, links, notes, matters, conflict searches, and merges, and allocates independent matter numbers (`0001`) unaffected by Tenant B's sequence.
    - **Forged tenant claim:** calling person, organisation, link, note, matter, conflict, or merge actions/services with a forged `tenantId` fails with `TENANCY_FORGERY_DETECTED` (or `UNAUTHENTICATED`), asserting both `code` and `message`.
    - **Tampered record ID:** Tenant A passing Tenant B's `personId`, `organisationId`, `linkId`, `matterId`, or `partyId` to `savePersonRecord`, `saveOrganisationRecord`, `createOrUpdateLink`, `deleteLink`, `addNoteToRecord`, `saveMatterRecord`, `liftMatterRestriction`, `updateMatterConflictRecord`, `signOffMatterCostsRecord`, or `executeMerge` is rejected (`NOT_FOUND` / `FORBIDDEN`, asserting code and message), and a fresh connection to `pg_tenant_b_test` confirms zero rows or `row_version` values in Tenant B changed.
- **E2E tests:**
  - `e2e/global-setup.ts` imports directory and matters into Postgres; all 9 Playwright role journeys pass (`npm run e2e`).

## Help and documentation (rule 11)

- **`src/docs/articles/matter-opening-and-risk.ts`:** Document monotonic per-tenant matter numbering (`B6` — numbers never reissue if a draft or opening is discarded) and optimistic concurrency conflict protection (`row_version`) on matter saves, and update line 55 storage notes.
- **`src/docs/articles/duplicate-checks.ts` and `src/docs/articles/leavers-and-reassignment.ts`:** Update storage and transaction notes (`leavers-and-reassignment.ts:21-23`) for PostgreSQL directory and matter repositories.
- **`docs/release-notes.md`:** Record PostgreSQL cut-over for people, organisations, links, notes, merge history, matters, and parties, `row_version` optimistic concurrency, and the `B6` matter-number sequence fix (`S0-16`).
- **`docs/roadmap/feature-list.md`:**
  - Move **B6** (`Matter numbers can be reissued`) to **`Completed`** (and remove `"Matter numbers can be reissued (B6)"` from item **4**'s `"What's missing"`, updating **P10** to note matter-numbering test coverage).
  - Update item **28** (`Clients, contacts and matter parties`), **P2**, and **P8**.

## Acceptance criteria

- `people`, `organisations`, `person_organisation_links`, `notes`, `merge_history`, `matters`, and `matter_parties` run exclusively on `TenantDirectoryRepository` and `TenantMatterRepository` in PostgreSQL, writing `audit_entries` in the same transaction.
- Matter numbers come from `matter_number_sequences` per tenant and never go backwards or reissue (`B6` fixed and tested).
- `matters` enforces `row_version` optimistic concurrency (`CONFLICT_CONCURRENT_MODIFICATION` on stale writes).
- Staff matters and ethical walls (`isStaffMatter`, `hasEthicalWall`, `restrictedAccessUserIds`, `B12`), employee email-binding rules (`B13`, `S0-30`), merge reference integrity (`B4`, `S0-09`), conflict search rules (`B5`, `B7`, `S0-07`), and finance restricted-matter exclusions (`S0-10`) all pass without regression.
- `seed:demo` (`S0-11b`) and `db:import -- --modules directory,matters` populate PostgreSQL idempotently, and `npm run ci` passes (`MAX_KNOWN_GAPS = 0`).

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Running `migrate` (`0007`–`0008`) and `db:import` against a hosted Azure environment waits on subscription access; local and CI PostgreSQL execution is unblocked.

## Rollback

- Per Owner Decision 9 (ADR 0028 §5), there is no dual-writing. Rolling back S0-16 reverts the branch, runs `downSql` for `0008` (restoring `matter_restriction_metadata` from `matters`) and `0007`, and re-imports S0-15 tables from the JSON store (`npm run seed:demo -- --force` on demo). Any post-cut-over non-live edits since S0-16 would be lost, as accepted in ADR 0028 §5.

## Pull request description must state

- **Change class:** Core persistence cut-over (`core/src/tenancy/`, `src/server/`, `src/app/`) plus bug fix `B6`.
- **Both hosting models:** Identical `TenantDirectoryRepository` and `TenantMatterRepository` run per-tenant in Model A (dedicated server) and Model B (shared server, database-per-tenant + `SET ROLE`).
- **Migration and rollback:** Runs `0007_directory_and_matters_expand` and `0008_matter_restriction_metadata_contract` via the `migrate` job, followed by `npm run db:import -- --modules directory,matters`. Both migrations have tested `downSql` (`0008` repopulates `matter_restriction_metadata` on rollback).
- **Cross-module operations:** Details single-transaction PostgreSQL writes + JSON snapshot compensation for `saveMatterRecord`, `executeMerge`, `prepareEnquiryConversion`, `prepareQuoteConversionRecord`, and `reassignLeaverOwnedRecords`.
