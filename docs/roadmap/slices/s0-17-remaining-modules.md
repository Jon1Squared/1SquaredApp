# S0-17: Remaining modules cut-over to PostgreSQL (proposed split: S0-17a, S0-17b, S0-17c)

| | |
|---|---|
| Backlog | P2, P7 (`[x-reserved:S0-17]` `customFields`), P8, items 1, 1a, 3, 9, 10, 13, 20, 23, 25, 29, 32, E1, E2, E4, E8 |
| Decision | [ADR 0028: Tenant Databases and Repositories](../../decisions/0028-tenant-database-and-repositories.md) (D3, revised and accepted 9 November 2026 — Owner Decisions 2, 4, 5 and 9) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4b) |
| Branch | Proposed 3-way split: `s0-17a-intake-quotes-tasks` (from `s0-16-people-and-matters`), `s0-17b-hr-teams-and-rbac` (from `s0-17a`), `s0-17c-catalogues-and-doc-metadata` (from `s0-17b`), targeting `develop` (or single branch `s0-17-remaining-modules` if owner prefers one PR) |
| Change class | Core feature / persistence cut-over (`core/src/tenancy/`, `core/src/tenancy/migrations/`, `core/src/config-engine/`, `src/server/`, `src/app/`, `scripts/`). |
| Size | XL overall -> **proposed split into three `M`/`L` slices (`S0-17a` = L, `S0-17b` = M, `S0-17c` = M)** |
| Depends on | S0-16 (`people`, `organisations`, `links`, `notes`, `matters`, `matter_parties` in PostgreSQL). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) only for running migrations and the one-off import in Azure; local and CI PostgreSQL execution is unblocked. |
| Baseline | `develop` at `52390b9` |

## Proposed split (for owner approval — not changed silently)

Inspecting `src/server/store.ts:67-116` and `src/server/services.ts` against `develop` (`52390b9`) shows that even with `audit` moved forward into S0-15, S0-17 still spans **26 `FirmStore` properties**, **19 PostgreSQL tables**, **~56 service functions**, removal of the JSON store sync bridges in both `documentGenerationServices.ts` and `documentStoreServices.ts`, activation of `[x-reserved:S0-17]` `customFields` in `tenant-config.schema.json`, and removal of `getStore()` from `src/server/authorize.ts` and `src/app/actions.ts`. In a single pull request that would exceed ~4,500 lines across four unrelated domains, making review error-prone.

We therefore **propose splitting S0-17 into three ordered sub-slices** inside Checkpoint 4b (also recorded as a proposed update in `docs/roadmap/stage-0-plan.md`, plus correcting `stage-0-plan.md:116`'s stale mention of *"and the audit log"* which already moved to S0-15):

1. **`S0-17a` (`s0-17a-intake-quotes-tasks`, Size L):** Enquiries & enquiry settings, quotes & quote reference sequences, tasks & task settings, notifications, sign-offs, and `recentlyViewed`. Eliminates all cross-store compensation on enquiry/quote conversion, matter opening tasks/sign-offs, and key-date reminder tasks/notifications, and unblocks `S0-19b` (enquiry retention anonymisation job).
2. **`S0-17b` (`s0-17b-hr-teams-and-rbac`, Size M):** Teams, effective-dated employee employment history (`Person.employment` normalised off `people.employment_json` + `employeeMigrationReport`), `employeeSensitiveRecords` (preserving mandatory `view-payroll`, `view-sensitive`, `update-payroll`, `update-sensitive` audit entries in the same Postgres transaction), and `rbacConfigOverride`. Removes `getStore()` from `src/server/authorize.ts:125` and makes `reassignLeaverOwnedRecords` 100% single-transaction in Postgres.
3. **`S0-17c` (`s0-17c-catalogues-and-doc-metadata`, Size M):** Firm profile (`firm`, `isCleanDeployment`), choice lists & values, custom field definitions (activating `[x-reserved:S0-17]` `customFields`), org structure, matter party taxonomy & migration report, Home pages config, matter costs config, and full cut-over of Document Generation (`0001` + `document_generation_tenant_configs`) and Document Store (`0002`) metadata off the JSON store. Leaves **only `store.pmsLinks`** on `FirmStore` for `S0-18`!

*(If the owner prefers keeping a single `s0-17-remaining-modules` branch with one commit per sub-area — matching how `S0-11a` was delivered — the exact same three boundaries become the commit sequence on `s0-17-remaining-modules`.)*

## What exists today

Checked against `develop` (`52390b9`):

1. **Remaining `FirmStore` properties in `src/server/store.ts` (excluding `pmsLinks` at `:92`, which moves in S0-18):**
   - **S0-17a collections:** `teams` *(moved in 17b)*, `tasks` (`:83`), `enquiries` (`:84`), `quotes` (`:85`), `notifications` (`:86`), `enquirySettings` (`:87`), `taskSettings` (`:88`), `signOffs` (`:89`), `recentlyViewed` (`:96`), `nextQuoteReference` (`:1131`).
   - **S0-17b collections:** `employeeSensitiveRecords` (`:77`), `employeeMigrationReport` (`:78`), `Person.employment` (`src/domain/types.ts:487`), `teams` (`:82`), `rbacConfigOverride` (`:104`).
   - **S0-17c collections:** `firmId` (`:67`), `firm` (`:68`), `isCleanDeployment` (`:69`), `lists` (`:70`), `values` (`:71`), `customFields` (`:72`), `orgStructure` (`:73`), `matterPartyTaxonomy` (`:74`), `matterPartyMigrationReport` (`:75`), `homePagesConfig` (`:90`), `matterCostsConfig` (`:91`), and the JSON mirror fields for Document Generation (`documentTemplates` `:98`, `documentTemplateVersions` `:99`, `documents` `:100`, `documentLinks` `:101`, `templateUsageEvents` `:102`, `documentGenerationConfigOverride` `:103`) and Document Store (`matterDocumentLocations` `:105`, `documentStoreFolderScopes` `:106`, `documentLifecycleJobs` `:107`, `documentReconciliationFindings` `:108`, `documentStoreAuditEvents` `:109`, `documentStoreConfigOverride` `:110-116`).
2. **Document Generation & Document Store JSON mirror bridges:**
   - `src/server/documentGenerationServices.ts`: `syncStoreToRepository` (`:263-370`) and `persistRepositoryToStore` (`:372-500`) copy `documentTemplates`, `documentTemplateVersions`, `documents`, `documentLinks`, and `templateUsageEvents` back and forth between `TenantDocumentRepository` (SQL tables from `0001` after S0-14) and `FirmStore` (`saveStore` at `:456, 499, 1696`; `getStore` at `:792`), and `documentGenerationConfigOverride` is read from `store.documentGenerationConfigOverride` (`:192, 224`).
   - `src/server/documentStoreServices.ts`: `ensureRepositorySyncedWithStore` (`:286-346`) and `persistRepositoryToStore` (`:348-384`) mirror `TenantDocumentStoreRepository` (SQL tables from `0002` after S0-14) to `FirmStore` (`saveStore` at `:382`; `getStore` across 23 helpers `:111`–`:2379`).
3. **Reserved tenant config key (`P7` / `S0-12`):**
   - `customFields` in `core/schemas/tenant-config.schema.json:411` (`description: "[x-reserved:S0-17] Declarative custom field definitions per entity type."`), `core/src/config-engine/index.ts:746`, and `core/tests/tenant-config-usage.test.ts:620` (`RESERVED_FOR_SLICE` `'S0-17'`) is explicitly scheduled to be wired at runtime in S0-17, merging declarative tenant-package `customFields` with admin-created `custom_field_definitions`.
4. **Other direct `getStore()` callers touched by S0-17:**
   - `src/server/authorize.ts:125`: `buildGuardedActorContext` still reads `store.teams` after S0-16 (`people` moved in S0-16).
   - `src/app/actions.ts:449, 483, 494`: `reorderChoiceValueAction` (`store.values`), `saveCustomFieldAction` (`store.customFields`), and `reorderCustomFieldAction` (`store.customFields`).
   - `src/app/api/matters/extract/route.ts:2539-2565`: reads `store.values` (`work_type` labels) and `store.teams`.

## Tables

Every table carries `tenant_id TEXT NOT NULL`, enforced by `TenantScopedRepository` (`SET ROLE` + `WHERE tenant_id = $1` + `assertRowTenant`):

### S0-17a tables (`TenantIntakeAndWorkflowRepository` — `core/src/tenancy/intakeWorkflowRepository.ts`)

| Table | Normalised columns | `jsonb` columns (per ADR 0028 §2) | Primary key & indexes |
|---|---|---|---|
| `enquiries` | `tenant_id`, `id`, `reference`, `status`, `first_name`, `last_name`, `email`, `phone`, `postcode`, `calling_on_behalf_of`, `organisation_name`, `channel_id`, `practice_area_id`, `work_type_subcategory_id`, `urgency_id`, `assigned_team_id`, `assigned_to_id`, `taken_by_id`, `created_by_id`, `linked_person_id`, `linked_organisation_id`, `converted_matter_id`, `privacy_notice_given BOOLEAN`, `received_at TIMESTAMPTZ`, `first_contact_due_at TIMESTAMPTZ`, `closed_at TIMESTAMPTZ`, `close_reason_id`, `referred_to_organisation_id`, `anonymised_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `summary_and_notes_json` (intake narrative, address lines, close notes, referral details), `contact_log_json` (`EnquiryContactLogEntry[]`), `conflict_snapshot_json` (`EnquiryConflictSnapshot` with `searchedInput`), `key_dates_json` (intake provisional key dates carried on conversion), `custom_fields_json` | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_enquiries_tenant_status_received ON enquiries (tenant_id, status, received_at DESC)`; `INDEX idx_enquiries_tenant_assignee ON enquiries (tenant_id, assigned_to_id, status)`; `INDEX idx_enquiries_tenant_retention ON enquiries (tenant_id, status, anonymised_at, received_at)` (supports S0-19b retention job) |
| `enquiry_settings` | `tenant_id`, `retention_months INTEGER NOT NULL`, `updated_at TIMESTAMPTZ` | `settings_json` (working hours, SLA targets by urgency, routing rules, email templates) | `PRIMARY KEY (tenant_id)` |
| `quotes` | `tenant_id`, `id`, `quote_reference`, `version INTEGER NOT NULL`, `status`, `fee_basis`, `client_type`, `client_person_id`, `client_organisation_id`, `prospect_name`, `linked_enquiry_id`, `converted_matter_id`, `practice_area_id`, `work_type_subcategory_id`, `prepared_by_id`, `fee_total_ex_vat_gbp NUMERIC(12,2)`, `total_inc_vat_gbp NUMERIC(12,2)`, `payment_on_account_gbp NUMERIC(12,2)`, `valid_until`, `sent_at TIMESTAMPTZ`, `outcome_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `pricing_breakdown_json` (stages, hourly/fixed lines, VAT overrides, disbursements, assumptions, scope), `follow_ups_json`, `version_history_json`, `conflict_decision_json` (S0-07 `B5`), `custom_fields_json` | `PRIMARY KEY (tenant_id, id)`; `UNIQUE INDEX idx_quotes_tenant_ref ON quotes (tenant_id, quote_reference)`; `INDEX idx_quotes_tenant_status ON quotes (tenant_id, status, updated_at DESC)`; `INDEX idx_quotes_tenant_enquiry ON quotes (tenant_id, linked_enquiry_id) WHERE linked_enquiry_id IS NOT NULL` |
| `quote_reference_sequences` | `tenant_id`, `year INTEGER NOT NULL`, `last_number BIGINT NOT NULL` | *(none — replaces `nextQuoteReference` at `store.ts:1131`)* | `PRIMARY KEY (tenant_id, year)` |
| `tasks` | `tenant_id`, `id`, `title`, `description`, `status`, `task_type_id`, `priority_id`, `due_at TIMESTAMPTZ`, `assigned_team_id`, `assigned_person_id`, `multi_assignee_mode`, `linked_key_date_id`, `system_key`, `auto_trigger`, `created_by_id`, `completed_by_id`, `completed_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `assigned_person_ids_json` (`string[]`), `linked_records_json` (`TaskLinkedRecord[]`), `comments_json` (`TaskComment[]`), `checklist_json` | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_tasks_tenant_status_due ON tasks (tenant_id, status, due_at)`; `INDEX idx_tasks_tenant_team ON tasks (tenant_id, assigned_team_id, status)`; `INDEX idx_tasks_tenant_person ON tasks (tenant_id, assigned_person_id, status)` |
| `task_settings` | `tenant_id`, `updated_at TIMESTAMPTZ` | `settings_json` (`TaskSettings`: automatic task templates, SLA/escalation defaults) | `PRIMARY KEY (tenant_id)` |
| `notifications` | `tenant_id`, `id`, `recipient_id`, `kind`, `title`, `body`, `href`, `read BOOLEAN NOT NULL DEFAULT FALSE`, `read_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ` | `metadata_json` (linked record refs / source key) | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_notifications_tenant_recipient ON notifications (tenant_id, recipient_id, read, created_at DESC)` |
| `sign_offs` | `tenant_id`, `id`, `kind`, `status`, `matter_id`, `requested_by_id`, `assigned_approver_id`, `decided_by_id`, `amount_gbp NUMERIC(12,2)`, `requested_at TIMESTAMPTZ`, `decided_at TIMESTAMPTZ` | `payload_json` (summary, discussion thread, notes, linked entity details — migrated to registers engine in `S0-24`) | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_sign_offs_tenant_status ON sign_offs (tenant_id, status, requested_at DESC)`; `INDEX idx_sign_offs_tenant_matter ON sign_offs (tenant_id, matter_id) WHERE matter_id IS NOT NULL` |
| `user_recently_viewed` | `tenant_id`, `person_id`, `updated_at TIMESTAMPTZ` | `items_json` (bounded MRU list of `{ recordType, recordId, viewedAt }`) | `PRIMARY KEY (tenant_id, person_id)` |

### S0-17b tables (`TenantHrAndRbacRepository` — `core/src/tenancy/hrRbacRepository.ts`)

| Table | Normalised columns | `jsonb` columns | Primary key & indexes |
|---|---|---|---|
| `teams` | `tenant_id`, `id`, `name`, `description`, `active BOOLEAN NOT NULL DEFAULT TRUE`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `member_ids_json` (`string[]`), `lead_ids_json` (`string[]`), `practice_area_ids_json` (`string[]`) | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_teams_tenant_active ON teams (tenant_id, active)` |
| `employee_employment_records` | `tenant_id`, `person_id`, `employment_status`, `worker_type`, `start_date`, `leaving_date`, `notice_end_date`, `hr_retention_until`, `updated_at TIMESTAMPTZ` | `employment_json` (effective-dated contract, working pattern, systems/firmWorkEmail, supervision, practising certificate, charge-out rate history) | `PRIMARY KEY (tenant_id, person_id)`; `FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id) ON DELETE CASCADE` |
| `employee_sensitive_records` | `tenant_id`, `person_id`, `updated_at TIMESTAMPTZ`, `updated_by_id` | `payroll_json` (bank/tax/NI/salary — access & updates write `view-payroll` / `update-payroll` in same transaction), `sensitive_hr_json` (right-to-work, DBS, medical/diversity, emergency contacts — access & updates write `view-sensitive` / `update-sensitive` in same transaction) | `PRIMARY KEY (tenant_id, person_id)`; `FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id) ON DELETE CASCADE` |
| `tenant_rbac_configs` | `tenant_id`, `updated_at TIMESTAMPTZ`, `updated_by_id` | `rbac_override_json` (`TenantRbacConfigOverride`: custom role mappings, permission overrides, migration report) | `PRIMARY KEY (tenant_id)` |

### S0-17c tables (`TenantCatalogueRepository` — `core/src/tenancy/catalogueRepository.ts` + `TenantDocumentRepository`)

| Table | Normalised columns | `jsonb` columns | Primary key & indexes |
|---|---|---|---|
| `firm_profiles` | `tenant_id`, `firm_id`, `is_clean_deployment BOOLEAN NOT NULL DEFAULT TRUE`, `updated_at TIMESTAMPTZ` | `firm_json` (`FirmProfile`: name, shortName, SRA number, VAT, offices) | `PRIMARY KEY (tenant_id)` |
| `choice_lists` | `tenant_id`, `key`, `label`, `description`, `allow_hierarchy BOOLEAN`, `system_locked BOOLEAN`, `updated_at TIMESTAMPTZ` | `metadata_json` | `PRIMARY KEY (tenant_id, key)` |
| `choice_values` | `tenant_id`, `id`, `list_key`, `code`, `label`, `parent_id`, `sort_order INTEGER NOT NULL`, `active BOOLEAN NOT NULL DEFAULT TRUE`, `updated_at TIMESTAMPTZ` | `metadata_json` (work-type profile config, stage group settings, colour/badge metadata) | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_choice_values_tenant_list ON choice_values (tenant_id, list_key, sort_order)` |
| `custom_field_definitions` | `tenant_id`, `id`, `record_type`, `field_key`, `label`, `field_type`, `section`, `required BOOLEAN`, `active BOOLEAN`, `sort_order INTEGER NOT NULL`, `source` (`'tenant_config' \| 'admin'`), `updated_at TIMESTAMPTZ` | `options_json` (`string[]` / validation config — merged at runtime with declarative `tenantConfig.customFields`, activating `[x-reserved:S0-17]`) | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_custom_fields_tenant_type ON custom_field_definitions (tenant_id, record_type, sort_order)` |
| `tenant_module_configs` | `tenant_id`, `config_key` (`'org_structure'`, `'matter_party_taxonomy'`, `'home_pages'`, `'matter_costs'`), `updated_at TIMESTAMPTZ`, `updated_by_id` | `config_json` (validated structured catalogue for `orgStructure`, `matterPartyTaxonomy` + migration report, `homePagesConfig`, and `matterCostsConfig`) | `PRIMARY KEY (tenant_id, config_key)` |
| `document_generation_tenant_configs` | `tenant_id`, `updated_at TIMESTAMPTZ`, `updated_by_id` | `config_json` (replaces `store.documentGenerationConfigOverride`, completing `0001` tables) | `PRIMARY KEY (tenant_id)` |

## Migrations

Expand-then-contract migrations in `CORE_TENANT_MIGRATIONS` (`core/src/tenancy/migrations/index.ts`):

1. **`0009_intake_quotes_tasks_expand`** (`S0-17a`, `kind: 'expand'`, `requiresAppliedVersion: '0008'`):
   - **`upSql`:** Creates `enquiries`, `enquiry_settings`, `quotes`, `quote_reference_sequences`, `tasks`, `task_settings`, `notifications`, `sign_offs`, and `user_recently_viewed` + indexes.
   - **`downSql`:** Drops indexes and those 9 tables (`DROP TABLE IF EXISTS user_recently_viewed, sign_offs, notifications, task_settings, tasks, quote_reference_sequences, quotes, enquiry_settings, enquiries;`).
2. **`0010_hr_teams_and_rbac_expand`** (`S0-17b`, `kind: 'expand'`, `requiresAppliedVersion: '0009'`):
   - **`upSql`:** Creates `teams`, `employee_employment_records`, `employee_sensitive_records`, and `tenant_rbac_configs` + indexes.
   - **`downSql`:** Drops indexes and those 4 tables (`DROP TABLE IF EXISTS tenant_rbac_configs, employee_sensitive_records, employee_employment_records, teams;`).
3. **`0011_people_employment_column_contract`** (`S0-17b`, `kind: 'contract'`, `requiresAppliedVersion: '0010'`):
   - **`upSql`:** Copies any non-null `people.employment_json` rows not yet in `employee_employment_records` (`INSERT INTO employee_employment_records ... ON CONFLICT DO NOTHING`), then drops the transitional `employment_json` column from `people` (`ALTER TABLE people DROP COLUMN IF EXISTS employment_json;`).
   - **`downSql`:** Re-adds `ALTER TABLE people ADD COLUMN IF NOT EXISTS employment_json JSONB NULL;` and back-populates it from `employee_employment_records` (`UPDATE people p SET employment_json = e.employment_json FROM employee_employment_records e WHERE p.tenant_id = e.tenant_id AND p.id = e.person_id;`).
4. **`0012_catalogues_and_docgen_config_expand`** (`S0-17c`, `kind: 'expand'`, `requiresAppliedVersion: '0011'`):
   - **`upSql`:** Creates `firm_profiles`, `choice_lists`, `choice_values`, `custom_field_definitions`, `tenant_module_configs`, and `document_generation_tenant_configs` + indexes.
   - **`downSql`:** Drops indexes and those 6 tables.

## Import (one-off JSON store to PostgreSQL)

1. **Entry points (`scripts/import-store-to-postgres.ts`):**
   - `npm run db:import -- --modules intake` (`S0-17a`), `--modules hr` (`S0-17b`), `--modules catalogues,documents` (`S0-17c`), or `--modules all-s0-17`.
2. **How it runs, handles a second run, and checks parity:**
   - Each module importer runs in `withTenantTransaction(ctx, ...)` using `ON CONFLICT ... DO UPDATE` upserts and `GREATEST(...)` sequence seeding (`quote_reference_sequences` and `tenant_record_sequences`).
   - In `S0-17c`, the importer also imports `store.documentTemplates`, `store.documentTemplateVersions`, `store.documents`, `store.documentLinks`, `store.templateUsageEvents`, `store.documentGenerationConfigOverride`, and `store.matterDocumentLocations` / `documentStore*` into `TenantDocumentRepository` (`0001` + `0012`) and `TenantDocumentStoreRepository` (`0002`) once, before the runtime JSON sync bridges are deleted.
   - Re-reads every table on a fresh connection after commit, verifying exact row counts against `store` and `tenant_id === ctx.tenantId`.
   - `scripts/seed-demo-tenant.ts` (`S0-11b`), `resetAllDemoData`, `clearAllDataToCleanDeployment`, and `e2e/global-setup.ts` seed/reset all S0-17 PostgreSQL tables directly through the importer (preserving S0-11b `entraObjectId` rules and S0-30 `--entra-map` warnings).

## Async conversion and effort estimate

Because S0-15 already converted all 49 audit-writing S0-17 functions in `src/server/services.ts` (plus `takeTaskRecord`), **only 7 synchronous exports in `src/server/services.ts` remain to convert to `async` across all of S0-17**:

- **S0-17a (3 exports in `services.ts` -> `async`):** `recordRecentlyViewed` (`:1090`), `markNotificationRead` (`:6633`), `markAllNotificationsRead` (`:6642`) (while all 22 enquiry, quote, task, sign-off, and compliance reminder exports are already `async` after S0-15; `flagMatterWriteOff` `:10686` also converts to `async` as it writes `sign_offs`).
- **S0-17b (3 exports in `services.ts` -> `async`):** `getEmployeeDetailsForUser` (`:1105`), `switchViewingRole` (`:9748`), `previewRbacOverrides` (`:10103`) (while `logEmployeeRestrictedAccess`, `reassignLeaverOwnedRecords`, `saveTeamRecord`, `updateEmployeeRoleSetting`, `updateEmployeeRolesAndSupports`, `updatePersonPermissionOverrides`, and `updateTenantRbacConfig` are already `async` after S0-15; `buildGuardedActorContext` in `src/server/authorize.ts:115` already became `async` in S0-16 and now loads `teams` + `rbacConfig` from `TenantHrAndRbacRepository`, removing `getStore()` from `authorize.ts` completely).
- **S0-17c (0 new `services.ts` exports -> `async`; 7 helpers in `documentStoreServices.ts` / `documentGenerationServices.ts` -> `async`):** all 19 catalogue/admin exports in `services.ts` (`addChoiceValue`, `updateChoiceValue`, `reorderChoiceValue`, `createMatterStageGroup`, `saveCustomFieldDefinition`, `reorderCustomField`, `resetAllDemoData`, `clearAllDataToCleanDeployment`, `saveHomePagesConfig`, `resetHomePagesConfig`, `addHomeRole`, `saveOrgStructure`, `saveMatterPartyRelationship`, `reorderMatterPartyRelationship`, `deleteMatterPartyRelationship`, `saveMatterPartyCapacity`, `deleteMatterPartyCapacity`, `updateWorkTypeProfiles`, `saveMatterCostsConfig`, `syncMatterCostsRatesFromPms`) are already `async` after S0-15. In `src/server/documentStoreServices.ts` (`:110, 163, 215, 391, 486`) and `src/server/documentGenerationServices.ts` (`:190, 224`), internal context helpers replace `getStore()` with repository reads and delete `syncStoreToRepository` / `persistRepositoryToStore` / `ensureRepositorySyncedWithStore`.
- **Callers updated with `await`:**
  - `src/app/actions.ts`: 7 callbacks (`recordRecentlyViewedAction` `:261`, `markNotificationReadAction` `:539`, `markAllNotificationsReadAction` `:546`, `switchViewingRoleAction` `:883`, `previewRbacOverridesAction` `:940`, `flagMatterWriteOffAction` `:1091`), plus removing `getStore()` in `reorderChoiceValueAction` (`:449`), `saveCustomFieldAction` (`:483`), and `reorderCustomFieldAction` (`:494`).
  - `src/app/people/[id]/page.tsx:31` (`await getEmployeeDetailsForUser(...)`) and `src/app/api/matters/extract/route.ts:2539` (replace `getStore()` for `values`/`teams` — zero `getStore()` calls remain in `extract/route.ts`!).
  - **Tests (~38 `await` additions across 3 test files):** `src/domain/employment.test.ts` (32 calls to `getEmployeeDetailsForUser`), `core/tests/rbac.test.ts` (5 calls to `switchViewingRole` / `flagMatterWriteOff` / `getEmployeeDetailsForUser`), `core/tests/isolation.test.ts` (1 call to `flagMatterWriteOff`).

**Honest effort estimate:** **~6–8 engineering days total across the 3 sub-slices** (`S0-17a`: ~2.5–3 days; `S0-17b`: ~2 days; `S0-17c`: ~2–3 days including `[x-reserved:S0-17]` `customFields` wiring and DocGen/DocStore bridge removal).

## Operations that span modules (Owner Decision 5)

1. **S0-17a eliminates cross-store compensation for intake, quotes, tasks, sign-offs, and key-date reminders:**
   - `prepareEnquiryConversion` + `saveMatterRecord` (`finalizeEnquiryConversionToMatter`), `prepareQuoteConversionRecord` + `saveMatterRecord` (`finalizeQuoteConversionToMatter`), automatic matter-opening `tasks`, partner cost `signOffs`, `flagMatterWriteOff`, and `runKeyDateReminderSchedulerRecord` now execute in **single PostgreSQL transactions** (`withTenantTransaction`) together with their `audit_entries`, deleting the S0-15/S0-16 JSON snapshot compensation wrappers on those flows.
   - `executeMerge` (`:5639`) moves `enquiries`, `quotes`, `tasks`, `recentlyViewed`, and `notifications` repointing into the single PostgreSQL merge transaction (leaving only `pmsLinks` compensated until S0-18).
2. **S0-17b preserves HR sensitive/payroll audit integrity in the same transaction:**
   - Every read or write of payroll or sensitive HR fields (`getEmployeeDetailsForUser`, `logEmployeeRestrictedAccess`, `savePersonRecord` employment/sensitive updates) writes `view-payroll`, `view-sensitive`, `update-payroll`, or `update-sensitive` into `audit_entries` **inside the same PostgreSQL transaction** — if the audit insert fails, sensitive data is never returned or committed (CLAUDE.md *"Roles and permissions"*).
   - `reassignLeaverOwnedRecords` (`:1196-1444`) becomes **100% single-transaction in PostgreSQL** across `people`, `matters`, `enquiries`, `tasks`, `document_store_folder_scopes`, and `audit_entries`.
3. **S0-17c activates `[x-reserved:S0-17]` `customFields` and retires DocGen/DocStore JSON bridges:**
   - Removes `[x-reserved:S0-17]` from `customFields` in `core/schemas/tenant-config.schema.json:411`, `core/src/config-engine/index.ts:746`, and `core/tests/tenant-config-usage.test.ts:620`, merging declarative `tenantConfig.customFields` with `custom_field_definitions` in PostgreSQL.
   - Deletes `syncStoreToRepository` / `persistRepositoryToStore` (`documentGenerationServices.ts:263-500`) and `ensureRepositorySyncedWithStore` / `persistRepositoryToStore` (`documentStoreServices.ts:286-384`), writing `document_generation` `audit_entries` in the same PostgreSQL transaction as template/document mutations.
   - Removes all `@remove-in S0-17` entries from `src/server/auditAdapter.ts` (leaving only `linkPmsRecord` / `unlinkPmsRecord` for S0-18).

## Tests

- **Unit & domain tests:**
  - Enquiry draft/open/reopen (`B8`), privacy notice (`R362`), retention (`B3`), quote conversion (`B5`), task permissions/visibility (`B9`), sign-off self-approval prevention (`S0-03`), HR effective-dated employment & sensitive/payroll audit (`src/domain/employment.test.ts`), leaver reassignment (`S0-05`), declarative + admin `customFields` (`core/tests/tenant-config-usage.test.ts`), Document Generation (`core/tests/document-generation.test.ts`), and Document Store (`core/tests/document-store.test.ts`) all run directly against PostgreSQL.
  - Same-transaction atomicity tests proving failed audit writes roll back HR sensitive reads/updates, enquiry/quote conversions, and template approvals.
- **Contract tests:**
  - `0009`–`0012` `upSql` -> `downSql` -> `upSql` round-trip in `core/tests/migrations-postgres.test.ts` (including `0011` `people.employment_json` back-population on `downSql`).
  - `core/tests/tenant-config-usage.test.ts` passes with `customFields` removed from `RESERVED_FOR_SLICE` (`'S0-17'`) and exercised by real runtime code.
  - Verify zero `getStore()` or `saveStore()` calls remain in `authorize.ts`, `documentGenerationServices.ts`, `documentStoreServices.ts`, or `extract/route.ts`.
- **Two-tenant isolation tests (`core/tests/isolation.test.ts`, Rule 9):**
  - Separate real databases (`pg_tenant_a_test`, `pg_tenant_b_test`) with per-tenant `SET ROLE` for **every S0-17 module** (enquiries, quotes, tasks, notifications, sign-offs, teams, HR employment & sensitive/payroll records, RBAC overrides, choice lists, custom fields, org structure, Home config, matter costs config, DocGen config):
    - **Positive control:** Tenant A reads and mutates its own records across each module.
    - **Forged tenant claim:** rejected with `TENANCY_FORGERY_DETECTED` (or `UNAUTHENTICATED`), asserting both `code` and `message`.
    - **Tampered record ID:** Tenant A passing Tenant B's `enquiryId`, `quoteId`, `taskId`, `notificationId`, `signOffId`, `teamId`, `personId` (HR/payroll), `choiceValueId`, or `customFieldId` fails with `NOT_FOUND` / `FORBIDDEN` (asserting code and message), and a fresh connection to `pg_tenant_b_test` confirms zero rows or `audit_entries` in Tenant B were read or modified.
- **E2E tests:**
  - `seed:demo` and `e2e/global-setup.ts` seed all S0-17 tables in PostgreSQL; all 9 Playwright role journeys pass (`npm run e2e`).

## Help and documentation (rule 11)

- **`src/docs/articles/tenant-settings.ts`:** Document runtime declarative `customFields` configuration (no longer reserved) alongside Admin custom fields.
- **`src/docs/articles/data-administration-and-retention.ts`, `src/docs/articles/leavers-and-reassignment.ts`, `src/docs/articles/sign-off-queue.ts`, `src/docs/articles/document-generation-governance.ts`, `src/docs/articles/sharepoint-document-stores.ts`, and `src/docs/articles/demo-environment.ts`:** Update storage architecture, transactional HR/payroll audit, DocGen/DocStore PostgreSQL metadata persistence, and `seed:demo` / reset database behaviour.
- **`docs/release-notes.md`:** Record S0-17a / S0-17b / S0-17c PostgreSQL cut-overs and declarative `customFields` activation.
- **`docs/roadmap/feature-list.md`:**
  - Update items **1**, **1a**, **2**, **10**, and **28** (remove `"Data still in the transitional store"` / `"Document metadata still saved in the transitional store"` from `"What's missing"`), **E1**, **E4**, **P2**, **P7** (note `customFields` activated in S0-17), and **P8** (repository-level two-tenant tests added for enquiries, quotes, tasks, sign-offs, and HR).

## Acceptance criteria

- Every `FirmStore` collection except `pmsLinks` (S0-18) runs exclusively on `TenantScopedRepository` subclasses in PostgreSQL, writing `audit_entries` in the same transaction.
- Document Generation and Document Store metadata no longer read or write `FirmStore`.
- Payroll and sensitive HR reads and writes record `view-payroll`, `view-sensitive`, `update-payroll`, and `update-sensitive` audit entries transactionally in PostgreSQL.
- `[x-reserved:S0-17]` `customFields` is active at runtime and verified by `core/tests/tenant-config-usage.test.ts`.
- `seed:demo` (`S0-11b`) and `db:import` seed PostgreSQL idempotently, and `npm run ci` passes (`MAX_KNOWN_GAPS = 0`).

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Running `migrate` (`0009`–`0012`) and `db:import` against a hosted Azure environment waits on subscription access; local and CI PostgreSQL execution is unblocked.

## Rollback

- Per Owner Decision 9 (ADR 0028 §5), there is no dual-writing. Each sub-slice's migrations (`0009`–`0012`) have reversible `downSql` (including `0011` restoring `people.employment_json`). Rolling back reverts the branch, runs `downSql`, and re-imports from the JSON seed/store (`npm run seed:demo -- --force` on demo).

## Pull request description must state

- **Change class:** Core persistence cut-over (`core/src/tenancy/`, `src/server/`, `src/app/`) plus activation of configuration option `customFields` (`core/schemas/tenant-config.schema.json`).
- **Both hosting models:** Identical tenant-scoped repositories run per-tenant in Model A (dedicated server) and Model B (shared server, database-per-tenant + `SET ROLE`).
- **Migration and rollback:** Runs migrations `0009`–`0012` via `migrate` job and `npm run db:import` per sub-slice; reversible via tested `downSql` and JSON re-import (ADR 0028 §5).
- **Cross-module operations:** Lists the conversion, matter-opening, key-date reminder, merge, HR sensitive audit, and leaver-reassignment flows unified into single PostgreSQL transactions.
