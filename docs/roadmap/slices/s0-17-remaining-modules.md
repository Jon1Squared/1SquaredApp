# S0-17a, S0-17b and S0-17c: Remaining modules cut-over to PostgreSQL

| | |
|---|---|
| Backlog | P2, P7 (`[x-reserved:S0-17]` `customFields`), P8, B13 (non-regression in `S0-17b`), items 1, 1a, 3, 9, 13, 20, 23, 25, 29, 32, E4, E8 |
| Decision | [ADR 0028: Tenant Databases and Repositories](../../decisions/0028-tenant-database-and-repositories.md) (D3, accepted 9 November 2026 — Owner Decisions 1, 2, 4, 5 and 9) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (WP4 Checkpoint 4b) |
| Branches | Three separate branches and pull requests (Owner Decision 1, 9 November 2026):<br>1. `s0-17a-intake-quotes-tasks` (from `s0-16-people-and-matters`, targeting `develop`)<br>2. `s0-17b-hr-teams-and-rbac` (from `s0-17a-intake-quotes-tasks`, targeting `develop`)<br>3. `s0-17c-catalogues-and-configs` (from `s0-17b-hr-teams-and-rbac`, targeting `develop`) |
| Change class | Core feature / persistence cut-over (`core/src/tenancy/`, `core/src/tenancy/migrations/`, `core/src/config-engine/`, `src/server/`, `src/app/`, `scripts/`). |
| Size | `S0-17a` = L · `S0-17b` = M · `S0-17c` = M (confirmed by Owner Decision 1; re-checked after S0-15) |
| Depends on | S0-16 (`people`, `person_emails`, `organisations`, `links`, `notes`, `matters`, `matter_parties` in PostgreSQL). *(Note: Document Generation and Document Store metadata already moved to PostgreSQL in `S0-14` per Owner Decision 2 / `R405`.)* |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) only for executing `docs/runbooks/store-cut-over.md` in Azure; local and CI PostgreSQL execution is unblocked. |
| Baseline | `develop` at `52390b9` |

## Confirmed 3-slice split (Owner Decisions 1 & 2)

Per Owner Decisions 1 and 2 (9 November 2026), S0-17 is delivered as **three ordered branches and pull requests** in Checkpoint 4b (with Document Generation and Document Store metadata already on PostgreSQL from `S0-14`, `R405`):

1. **`S0-17a` (`s0-17a-intake-quotes-tasks`, Size L):** Enquiries & enquiry settings, quotes & quote reference sequences, tasks & task settings, notifications, sign-offs, and `recentlyViewed`. Eliminates cross-store compensation on enquiry/quote conversion, matter opening tasks/sign-offs, and key-date reminder tasks/notifications, and unblocks `S0-19b` (enquiry retention anonymisation job).
2. **`S0-17b` (`s0-17b-hr-teams-and-rbac`, Size M):** Teams, effective-dated employee employment history (`employee_employment_records` + `employeeMigrationReport`, maintaining `person_emails` `source = 'firm_work_email'` in the same transaction per `R410`), `employee_sensitive_records` (same-transaction `view-payroll`, `view-sensitive`, `update-payroll`, `update-sensitive` audit entries), and `tenant_rbac_configs`. Removes `getStore()` from `src/server/authorize.ts:125` and makes `reassignLeaverOwnedRecords` 100% single-transaction in PostgreSQL.
3. **`S0-17c` (`s0-17c-catalogues-and-configs`, Size M):** Firm profile (`firm`, `isCleanDeployment`), choice lists & values, custom field definitions (activating `[x-reserved:S0-17]` `customFields`), org structure, matter party taxonomy & migration report, Home pages config, and matter costs config, plus switching the remaining `values` / `firm` / `orgStructure` reads in `documentGenerationServices.ts`, `documentStoreServices.ts`, and `extract/route.ts` off `getStore()`. Leaves **only `store.pmsLinks`** on `FirmStore` for `S0-18`.

## What exists today

Checked against `develop` (`52390b9`):

1. **Remaining `FirmStore` properties in `src/server/store.ts` (excluding `pmsLinks` at `:92`, moved in `S0-18`, and DocGen/DocStore metadata `:98-116`, moved in `S0-14` per `R405`):**
   - **S0-17a collections:** `tasks` (`:83`), `enquiries` (`:84`), `quotes` (`:85`), `notifications` (`:86`), `enquirySettings` (`:87`), `taskSettings` (`:88`), `signOffs` (`:89`), `recentlyViewed` (`:96`), `nextQuoteReference` (`:1131`).
   - **S0-17b collections:** `employeeSensitiveRecords` (`:77`), `employeeMigrationReport` (`:78`), `Person.employment` (`src/domain/types.ts:487`), `teams` (`:82`), `rbacConfigOverride` (`:104`).
   - **S0-17c collections:** `firmId` (`:67`), `firm` (`:68`), `isCleanDeployment` (`:69`), `lists` (`:70`), `values` (`:71`), `customFields` (`:72`), `orgStructure` (`:73`), `matterPartyTaxonomy` (`:74`), `matterPartyMigrationReport` (`:75`), `homePagesConfig` (`:90`), `matterCostsConfig` (`:91`).
2. **Reserved tenant config key (`P7` / `S0-12`):**
   - `customFields` in `core/schemas/tenant-config.schema.json:411`, `core/src/config-engine/index.ts:742`, and `core/tests/tenant-config-usage.test.ts:620` (`RESERVED_FOR_SLICE` `'S0-17'`) is wired at runtime in `S0-17c`.
3. **Remaining `getStore()` callers touched across S0-17a–c:**
   - `src/server/authorize.ts:125` (`store.teams`, removed in `S0-17b`), `src/app/actions.ts:449, 483, 494` (`reorderChoiceValueAction`, `saveCustomFieldAction`, `reorderCustomFieldAction`, removed in `S0-17c`), `src/app/api/matters/extract/route.ts:2539-2565` (`teams` in `S0-17b`, `values` in `S0-17c`), and `documentGenerationServices.ts` / `documentStoreServices.ts` (`teams` in `S0-17b`, `values` / `firm` / `orgStructure` in `S0-17c`).

## Tables

Every table carries `tenant_id TEXT NOT NULL`, enforced by `TenantScopedRepository` (`SET LOCAL ROLE` + `WHERE tenant_id = $1` + `assertRowTenant`):

### S0-17a tables (`TenantIntakeAndWorkflowRepository` — `core/src/tenancy/intakeWorkflowRepository.ts`)

| Table | Normalised columns | `jsonb` columns (per ADR 0028 §2) | Primary key & indexes |
|---|---|---|---|
| `enquiries` | `tenant_id`, `id`, `reference`, `status`, `first_name`, `last_name`, `email`, `phone`, `postcode`, `calling_on_behalf_of`, `organisation_name`, `channel_id`, `practice_area_id`, `work_type_subcategory_id`, `urgency_id`, `assigned_team_id`, `assigned_to_id`, `taken_by_id`, `created_by_id`, `linked_person_id`, `linked_organisation_id`, `converted_matter_id`, `privacy_notice_given BOOLEAN`, `received_at TIMESTAMPTZ`, `first_contact_due_at TIMESTAMPTZ`, `closed_at TIMESTAMPTZ`, `close_reason_id`, `referred_to_organisation_id`, `anonymised_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `summary_and_notes_json`, `contact_log_json`, `conflict_snapshot_json`, `key_dates_json`, `custom_fields_json` | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_enquiries_tenant_status_received ON enquiries (tenant_id, status, received_at DESC)`; `INDEX idx_enquiries_tenant_assignee ON enquiries (tenant_id, assigned_to_id, status)`; `INDEX idx_enquiries_tenant_retention ON enquiries (tenant_id, status, anonymised_at, received_at)` |
| `enquiry_settings` | `tenant_id`, `retention_months INTEGER NOT NULL`, `updated_at TIMESTAMPTZ` | `settings_json` | `PRIMARY KEY (tenant_id)` |
| `quotes` | `tenant_id`, `id`, `quote_reference`, `version INTEGER NOT NULL`, `status`, `fee_basis`, `client_type`, `client_person_id`, `client_organisation_id`, `prospect_name`, `linked_enquiry_id`, `converted_matter_id`, `practice_area_id`, `work_type_subcategory_id`, `prepared_by_id`, `fee_total_ex_vat_gbp NUMERIC(12,2)`, `total_inc_vat_gbp NUMERIC(12,2)`, `payment_on_account_gbp NUMERIC(12,2)`, `valid_until`, `sent_at TIMESTAMPTZ`, `outcome_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `pricing_breakdown_json`, `follow_ups_json`, `version_history_json`, `conflict_decision_json` (`B5`), `custom_fields_json` | `PRIMARY KEY (tenant_id, id)`; `UNIQUE INDEX idx_quotes_tenant_ref ON quotes (tenant_id, quote_reference)`; `INDEX idx_quotes_tenant_status ON quotes (tenant_id, status, updated_at DESC)`; `INDEX idx_quotes_tenant_enquiry ON quotes (tenant_id, linked_enquiry_id) WHERE linked_enquiry_id IS NOT NULL` |
| `quote_reference_sequences` | `tenant_id`, `year INTEGER NOT NULL`, `last_number BIGINT NOT NULL` | *(none)* | `PRIMARY KEY (tenant_id, year)` |
| `tasks` | `tenant_id`, `id`, `title`, `description`, `status`, `task_type_id`, `priority_id`, `due_at TIMESTAMPTZ`, `assigned_team_id`, `assigned_person_id`, `multi_assignee_mode`, `linked_key_date_id`, `system_key`, `auto_trigger`, `created_by_id`, `completed_by_id`, `completed_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `assigned_person_ids_json`, `linked_records_json`, `comments_json`, `checklist_json` | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_tasks_tenant_status_due ON tasks (tenant_id, status, due_at)`; `INDEX idx_tasks_tenant_team ON tasks (tenant_id, assigned_team_id, status)`; `INDEX idx_tasks_tenant_person ON tasks (tenant_id, assigned_person_id, status)` |
| `task_settings` | `tenant_id`, `updated_at TIMESTAMPTZ` | `settings_json` | `PRIMARY KEY (tenant_id)` |
| `notifications` | `tenant_id`, `id`, `recipient_id`, `kind`, `title`, `body`, `href`, `read BOOLEAN NOT NULL DEFAULT FALSE`, `read_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ` | `metadata_json` | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_notifications_tenant_recipient ON notifications (tenant_id, recipient_id, read, created_at DESC)` |
| `sign_offs` | `tenant_id`, `id`, `kind`, `status`, `matter_id`, `requested_by_id`, `assigned_approver_id`, `decided_by_id`, `amount_gbp NUMERIC(12,2)`, `requested_at TIMESTAMPTZ`, `decided_at TIMESTAMPTZ` | `payload_json` (migrated to registers engine in `S0-24`) | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_sign_offs_tenant_status ON sign_offs (tenant_id, status, requested_at DESC)`; `INDEX idx_sign_offs_tenant_matter ON sign_offs (tenant_id, matter_id) WHERE matter_id IS NOT NULL` |
| `user_recently_viewed` | `tenant_id`, `person_id`, `updated_at TIMESTAMPTZ` | `items_json` | `PRIMARY KEY (tenant_id, person_id)` |

### S0-17b tables (`TenantHrAndRbacRepository` — `core/src/tenancy/hrRbacRepository.ts`)

| Table | Normalised columns | `jsonb` columns | Primary key, indexes & `ON DELETE RESTRICT` (`R413`) |
|---|---|---|---|
| `teams` | `tenant_id`, `id`, `name`, `description`, `active BOOLEAN NOT NULL DEFAULT TRUE`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `member_ids_json`, `lead_ids_json`, `practice_area_ids_json` | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_teams_tenant_active ON teams (tenant_id, active)` |
| `employee_employment_records` | `tenant_id`, `person_id`, `employment_status`, `worker_type`, `start_date`, `leaving_date`, `notice_end_date`, `hr_retention_until`, `updated_at TIMESTAMPTZ` | `employment_json` (effective-dated contract, working pattern, `systems.firmWorkEmail`, supervision, practising certificate, charge-out rate history, migration report) | `PRIMARY KEY (tenant_id, person_id)`; **`FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id) ON DELETE RESTRICT`** (`R413` — prevents cascade deletion of HR records under statutory retention) |
| `employee_sensitive_records` | `tenant_id`, `person_id`, `updated_at TIMESTAMPTZ`, `updated_by_id` | `payroll_json`, `sensitive_hr_json` | `PRIMARY KEY (tenant_id, person_id)`; **`FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id) ON DELETE RESTRICT`** (`R413`) |
| `tenant_rbac_configs` | `tenant_id`, `updated_at TIMESTAMPTZ`, `updated_by_id` | `rbac_override_json` (`TenantRbacConfigOverride`) | `PRIMARY KEY (tenant_id)` |

### S0-17c tables (`TenantCatalogueRepository` — `core/src/tenancy/catalogueRepository.ts`)

| Table | Normalised columns | `jsonb` columns | Primary key & indexes |
|---|---|---|---|
| `firm_profiles` | `tenant_id`, `firm_id`, `is_clean_deployment BOOLEAN NOT NULL DEFAULT TRUE`, `updated_at TIMESTAMPTZ` | `firm_json` (`FirmProfile`) | `PRIMARY KEY (tenant_id)` |
| `choice_lists` | `tenant_id`, `key`, `label`, `description`, `allow_hierarchy BOOLEAN`, `system_locked BOOLEAN`, `updated_at TIMESTAMPTZ` | `metadata_json` | `PRIMARY KEY (tenant_id, key)` |
| `choice_values` | `tenant_id`, `id`, `list_key`, `code`, `label`, `parent_id`, `sort_order INTEGER NOT NULL`, `active BOOLEAN NOT NULL DEFAULT TRUE`, `updated_at TIMESTAMPTZ` | `metadata_json` | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_choice_values_tenant_list ON choice_values (tenant_id, list_key, sort_order)` |
| `custom_field_definitions` | `tenant_id`, `id`, `record_type`, `field_key`, `label`, `field_type`, `section`, `required BOOLEAN`, `active BOOLEAN`, `sort_order INTEGER NOT NULL`, `source` (`'tenant_config' \| 'admin'`), `updated_at TIMESTAMPTZ` | `options_json` (merged at runtime with declarative `tenantConfig.customFields`, activating `[x-reserved:S0-17]`) | `PRIMARY KEY (tenant_id, id)`; `INDEX idx_custom_fields_tenant_type ON custom_field_definitions (tenant_id, record_type, sort_order)` |
| `tenant_module_configs` | `tenant_id`, `config_key` (`'org_structure'`, `'matter_party_taxonomy'`, `'home_pages'`, `'matter_costs'`), `updated_at TIMESTAMPTZ`, `updated_by_id` | `config_json` | `PRIMARY KEY (tenant_id, config_key)` |

## Migrations (`R408`, `R417`)

Expand-only migrations across S0-17a–c. **From `S0-17b` onwards, nothing in runtime code reads or writes `people.employment_json`** (`TenantDirectoryRepository` uses explicit column lists on `people` omitting `employment_json`, and all employment reads/writes go solely through `employee_employment_records`; `docs/runbooks/store-cut-over.md` imports `hr` before traffic starts), while the nullable `people.employment_json` column stays physically present on disk until `S0-20`'s contract migration `0014` so `S0-16` / `S0-17a` replicas never break during `S0-17b`'s `migrate` and `S0-19b` replicas never touch `people.employment_json` when `S0-20`'s `migrate` drops it (`R408`, `R417`):

1. **`0009_intake_quotes_tasks_expand`** (`S0-17a`, `kind: 'expand'`, `requiresAppliedVersion: '0008'`, `CORE_REQUIRED_SCHEMA_VERSION = '0009'`): creates the 9 S0-17a tables + indexes; `downSql` drops them.
2. **`0010_hr_teams_and_rbac_expand`** (`S0-17b`, `kind: 'expand'`, `requiresAppliedVersion: '0009'`, `CORE_REQUIRED_SCHEMA_VERSION = '0010'`): creates `teams`, `employee_employment_records` (`ON DELETE RESTRICT`), `employee_sensitive_records` (`ON DELETE RESTRICT`), and `tenant_rbac_configs` + indexes; `downSql` drops them.
3. **`0011_catalogues_and_configs_expand`** (`S0-17c`, `kind: 'expand'`, `requiresAppliedVersion: '0010'`, `CORE_REQUIRED_SCHEMA_VERSION = '0011'`): creates `firm_profiles`, `choice_lists`, `choice_values`, `custom_field_definitions`, and `tenant_module_configs` + indexes; `downSql` drops them.

## Import and release cut-over (`R407`)

- Each PR follows **`docs/runbooks/store-cut-over.md`**: stop web writes -> `migrate` (`0009` / `0010` / `0011`) -> `node dist/jobs/import-store.mjs --modules intake` (`S0-17a`), `--modules hr` (`S0-17b`, including `person_emails` `firm_work_email` sync), or `--modules catalogues` (`S0-17c`) -> verify fresh-connection counts -> start new revision. Wired into `seed-demo-tenant.ts`, `resetAllDemoData`, `clearAllDataToCleanDeployment`, and `e2e/global-setup.ts`.

## Async conversion and effort estimate

Only **7 synchronous exports** in `src/server/services.ts` remain to convert across all three slices:
- **`S0-17a` (4 exports -> `async`, Size L ~2.5–3 days):** `recordRecentlyViewed` (`:1090`, awaited in `enquiries/[id]/page.tsx:24`, `matters/[id]/page.tsx:31`, `organisations/[id]/page.tsx:35`, `people/[id]/page.tsx:45`, `quotes/[id]/page.tsx:25`), `markNotificationRead` (`:6633`, `actions.ts:537`), `markAllNotificationsRead` (`:6642`, `actions.ts:544`), and `flagMatterWriteOff` (`:10686`, `actions.ts:941`).
- **`S0-17b` (3 exports -> `async`, Size M ~2 days):** `getEmployeeDetailsForUser` (`:1105`, `people/[id]/page.tsx:31`), `switchViewingRole` (`:9748`, `actions.ts:809`), and `previewRbacOverrides` (`:10103`, `actions.ts:872`), plus removing `getStore()` from `src/server/authorize.ts:125`.
- **`S0-17c` (0 new `services.ts` exports -> `async`, Size M ~2 days):** all 19 catalogue/admin exports in `services.ts` are already `async` after `S0-15`; remove `getStore()` in `src/app/actions.ts:449, 483, 494`, `src/app/api/matters/extract/route.ts:2539`, `src/server/documentGenerationServices.ts`, and `src/server/documentStoreServices.ts`.

## Operations that span modules (`Owner Decision 5`, `R406`, `R410`, `R417`, `R418`)

1. **`S0-17a`:** `prepareEnquiryConversion` (`:8490`) + `saveMatterRecord` (`finalizeEnquiryConversionToMatter` `:8809`), `prepareQuoteConversionRecord` (`:11905`) + `saveMatterRecord` (`finalizeQuoteConversionToMatter` `:12333`), automatic opening `tasks`, partner cost `signOffs`, `flagMatterWriteOff`, and `runKeyDateReminderSchedulerRecord` (`:13684`) move into **single PostgreSQL transactions** with `audit_entries`. `executeMerge` (`:5639`) keeps `withJsonStoreWriteLock` + delta compensation (`R406`) solely for `pmsLinks` until `S0-18`.
2. **`S0-17b` (`R410`, `R413`):**
   - **Maintaining `firmWorkEmail` in `person_emails` (`R410`, `R417`):** whenever `savePersonRecord` (`:1446`), `importHrFromStore`, or employment updates write `employee_employment_records` (`employment.systems.firmWorkEmail`), the **same PostgreSQL transaction** updates `person_emails` (`source = 'firm_work_email'`) so `resolveOrProvisionEntraEmployee` (`B13` / `S0-30`) continues matching all active emails and `firmWorkEmail` across all people, **and nothing reads or writes `people.employment_json` from `S0-17b` onwards** (`R417`).
   - **HR sensitive/payroll audit atomicity:** `getEmployeeDetailsForUser`, `logEmployeeRestrictedAccess`, and `savePersonRecord` write `view-payroll`, `view-sensitive`, `update-payroll`, and `update-sensitive` into `audit_entries` in the **same PostgreSQL transaction**. `reassignLeaverOwnedRecords` (`:1196`) becomes 100% single-transaction in PostgreSQL.
3. **`S0-17c`:** activates `[x-reserved:S0-17]` `customFields` (`tenant-config.schema.json:411`, `config-engine/index.ts:742`, `tenant-config-usage.test.ts:620`) and removes all `@remove-in S0-17*` entries from `src/server/auditAdapter.ts` (leaving only `linkPmsRecord` / `unlinkPmsRecord` for `S0-18`).

## Tests

- **Unit, `R410`, `R413`, `R417` & domain tests:** enquiry draft/reopen/privacy/retention (`B3`, `B8`, `R362`), quote conversion (`B5`), tasks (`B9`), sign-offs (`S0-03`), HR sensitive/payroll same-transaction audit, **`ON DELETE RESTRICT` refusal test when attempting to delete a `people` row with `employee_employment_records` or `employee_sensitive_records` (`R413`)**, **`firmWorkEmail` update -> `person_emails` S0-30 test (`R410`)**, **zero `people.employment_json` runtime dependency test in `S0-17b` (`R417`: drop `people.employment_json` in a test database after importing `hr`, then run the HR and people tests and assert all pass)**, and declarative `customFields` (`tenant-config-usage.test.ts`).
- **Contract, two-tenant isolation & E2E tests:** `0009`–`0011` `upSql` -> `downSql` -> `upSql` round-trips; zero `getStore()`/`saveStore()` left in `authorize.ts`, `documentGenerationServices.ts`, `documentStoreServices.ts`, or `extract/route.ts`; two-tenant PgBouncer isolation (`core/tests/isolation.test.ts`) for every S0-17a/b/c module; all 9 Playwright journeys pass (`npm run e2e`).

## Help and documentation (rule 11)

- **`src/docs/articles/tenant-settings.ts`, `src/docs/articles/data-administration-and-retention.ts`, `src/docs/articles/leavers-and-reassignment.ts`, `src/docs/articles/sign-off-queue.ts`, and `src/docs/articles/demo-environment.ts`:** Document PostgreSQL storage across S0-17a–c, `ON DELETE RESTRICT` HR retention protection, transactional payroll/sensitive audit, and active declarative `customFields`.
- **`docs/release-notes.md` and `docs/roadmap/feature-list.md`:** Record `S0-17a`, `S0-17b`, and `S0-17c`; update items **1**, **1a**, **2**, **28**, **E4**, **P2**, **P7** (`customFields` active), and **P8**.

## Acceptance criteria

- Every `FirmStore` collection except `pmsLinks` (`S0-18`) runs exclusively on `TenantScopedRepository` subclasses in PostgreSQL across the three branches/PRs (`S0-17a`, `S0-17b`, `S0-17c`), writing `audit_entries` in the same transaction.
- `employee_employment_records` and `employee_sensitive_records` enforce `ON DELETE RESTRICT` (`R413`), `firmWorkEmail` stays synced in `person_emails` (`R410`), nothing reads or writes `people.employment_json` from `S0-17b` onwards while the column drop stays deferred to `S0-20` (`R408`, `R417`), `[x-reserved:S0-17]` `customFields` is active, and `npm run ci` passes (`MAX_KNOWN_GAPS = 0`).

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Cloud execution of `docs/runbooks/store-cut-over.md` waits on subscription access.

## Rollback

- Each sub-slice follows **`docs/runbooks/store-cut-over.md`** (`R407`): stop web writes, revert the sub-slice branch, run `downSql` (`0011`, `0010`, or `0009`; `people.employment_json` was kept intact per `R408`), and re-import from the JSON seed/store.

## Pull request descriptions (one per PR: S0-17a, S0-17b, S0-17c) must state

- **Change class:** Core persistence cut-over (`S0-17a`, `S0-17b`, `S0-17c`) plus activation of `customFields` in `S0-17c`.
- **Both hosting models:** Identical tenant-scoped repositories run per-tenant over PgBouncer (`SET LOCAL ROLE`) in Model A and Model B.
- **Migration, cut-over and rollback:** Follows **`docs/runbooks/store-cut-over.md`** (`0009` + `--modules intake`, `0010` + `--modules hr`, `0011` + `--modules catalogues`; `people.employment_json` drop deferred to `S0-20` per `R408`).
- **Cross-module operations:** Lists single-transaction conversion/opening/reminder flows (`S0-17a`), HR sensitive audit + `person_emails` `firmWorkEmail` sync + leaver reassignment (`S0-17b`), and `customFields` activation (`S0-17c`).
