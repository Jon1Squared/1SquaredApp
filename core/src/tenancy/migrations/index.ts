/**
 * Reversible, expand/contract per-tenant database migrations (`core/src/tenancy/migrations/`).
 *
 * Rules enforced (Platform Architecture Standard Section 9):
 * 1. Every migration is backward compatible (expand first), reversible (`downSql`), and tracked per tenant.
 * 2. The migration runner refuses to run without a valid `TenantContext`.
 * 3. Supports forward application, rollback, and re-application verification in CI.
 */

import crypto from 'node:crypto';
import type { TenantContext } from '../../api/index';
import {
  assertValidPostgresTenantContext,
  createDirectMigrationClient,
  invalidateGlobalTenantSchemaReadiness,
  quotePgIdentifier,
  resolveTenantPostgresRoleName,
  sanitizePostgresError,
} from '../postgresPoolManager';
import { toIsoString } from '../tenantScopedRepository';

export interface TenantMigrationDefinition {
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly upSql: string;
  readonly downSql: string;
  readonly tablesChanged: readonly string[];
  readonly dependsOn?: readonly string[];
  /**
   * Checksums recorded by earlier releases of this same migration whose `upSql` is
   * unchanged and only `downSql` was corrected. Never list a checksum whose `upSql` differs.
   */
  readonly acceptedPriorChecksums?: readonly string[];
}

export interface AppliedTenantMigrationRecord {
  tenantId: string;
  databaseName: string;
  version: string;
  name: string;
  checksum: string;
  appliedAt: string;
}

export const DOCUMENT_GENERATION_MIGRATION_0001: TenantMigrationDefinition = {
  version: '0001',
  name: '0001_document_generation_expand',
  description:
    'Expand schema with tenant-scoped document_templates, document_template_versions, documents, document_links, template_usage_events, and template_usage_daily_summaries tables.',
  tablesChanged: [
    'document_templates',
    'document_template_versions',
    'documents',
    'document_links',
    'template_usage_events',
    'template_usage_daily_summaries',
  ],
  upSql: `
CREATE TABLE IF NOT EXISTS document_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_document_type TEXT NOT NULL DEFAULT 'letter',
  filename_pattern TEXT NOT NULL DEFAULT '{{matter.reference}} - {{template.name}}',
  availability_rules JSONB NOT NULL DEFAULT '{"sourceContexts":["matter","client"]}'::jsonb,
  active_version_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_document_templates_tenant_code UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_document_templates_tenant_status
  ON document_templates (tenant_id, status);

CREATE TABLE IF NOT EXISTS document_template_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  engine TEXT NOT NULL DEFAULT 'basic-merge',
  status TEXT NOT NULL DEFAULT 'Draft',
  storage_provider TEXT NOT NULL DEFAULT 'local-fs',
  blob_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  scan_status TEXT NOT NULL DEFAULT 'pending',
  extracted_placeholders JSONB NOT NULL DEFAULT '[]'::jsonb,
  field_mappings JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompted_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_by_user_id TEXT NULL,
  submitted_at TIMESTAMPTZ NULL,
  reviewed_by_user_id TEXT NULL,
  reviewed_at TIMESTAMPTZ NULL,
  rejection_reason TEXT NULL,
  change_note TEXT NULL,
  CONSTRAINT uq_document_template_versions_num UNIQUE (tenant_id, template_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_document_template_versions_tenant_status
  ON document_template_versions (tenant_id, status);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  document_type TEXT NOT NULL,
  output_format TEXT NOT NULL DEFAULT 'docx',
  mime_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  file_sha256 TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES document_templates(id),
  template_name TEXT NOT NULL,
  template_version_id TEXT NOT NULL REFERENCES document_template_versions(id),
  template_version_number INTEGER NOT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'local-fs',
  storage_key TEXT NOT NULL,
  external_id TEXT NULL,
  external_version TEXT NULL,
  generated_by_user_id TEXT NOT NULL,
  generated_by_name TEXT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  primary_matter_id TEXT NULL,
  primary_client_id TEXT NULL,
  recipient_party_id TEXT NULL,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_by_user_id TEXT NULL,
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_tenant_matter
  ON documents (tenant_id, primary_matter_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_documents_tenant_client
  ON documents (tenant_id, primary_client_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS document_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  link_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_links_tenant_entity
  ON document_links (tenant_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS template_usage_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id TEXT NOT NULL,
  actor_role_key TEXT NOT NULL,
  team_id TEXT NULL,
  practice_area_id TEXT NULL,
  matter_type_id TEXT NULL,
  source_entity_type TEXT NOT NULL,
  output_format TEXT NOT NULL DEFAULT 'docx',
  missing_field_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_template_usage_events_tenant_occurred
  ON template_usage_events (tenant_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_template_usage_events_tenant_template
  ON template_usage_events (tenant_id, template_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_template_usage_events_tenant_actor
  ON template_usage_events (tenant_id, actor_user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS template_usage_daily_summaries (
  tenant_id TEXT NOT NULL,
  bucket_date DATE NOT NULL,
  template_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  practice_area_id TEXT NOT NULL DEFAULT '',
  matter_type_id TEXT NOT NULL DEFAULT '',
  team_id TEXT NOT NULL DEFAULT '',
  generated_count INTEGER NOT NULL DEFAULT 0,
  previewed_count INTEGER NOT NULL DEFAULT 0,
  blocked_missing_required_count INTEGER NOT NULL DEFAULT 0,
  blocked_permission_count INTEGER NOT NULL DEFAULT 0,
  last_generated_at TIMESTAMPTZ NULL,
  PRIMARY KEY (
    tenant_id,
    bucket_date,
    template_id,
    template_version_id,
    practice_area_id,
    matter_type_id,
    team_id
  )
);
`.trim(),
  downSql: `
DROP TABLE IF EXISTS template_usage_daily_summaries;
DROP TABLE IF EXISTS template_usage_events;
DROP TABLE IF EXISTS document_links;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS document_template_versions;
DROP TABLE IF EXISTS document_templates;
`.trim(),
};

export const DOCUMENT_STORE_INTEGRATION_MIGRATION_0002: TenantMigrationDefinition = {
  version: '0002',
  name: '0002_document_store_integration_expand',
  description:
    'Expand schema with tenant-scoped matter_document_locations, document_store_folder_scopes, document_lifecycle_jobs, document_reconciliation_findings, document_store_audit_events, and person_entra_identities tables.',
  tablesChanged: [
    'matter_document_locations',
    'document_store_folder_scopes',
    'document_lifecycle_jobs',
    'document_reconciliation_findings',
    'document_store_audit_events',
    'person_entra_identities',
  ],
  upSql: `
CREATE TABLE IF NOT EXISTS person_entra_identities (
  tenant_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  entra_object_id TEXT NOT NULL,
  upn TEXT NULL,
  populated_source TEXT NOT NULL DEFAULT 'oidc_signin',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, person_id),
  CONSTRAINT uq_person_entra_identities_oid UNIQUE (tenant_id, entra_object_id)
);

CREATE TABLE IF NOT EXISTS matter_document_locations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  provider_site_id TEXT NOT NULL,
  provider_drive_id TEXT NOT NULL,
  provider_folder_item_id TEXT NOT NULL,
  web_url TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  folder_item_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL DEFAULT 1,
  provisioning_status TEXT NOT NULL DEFAULT 'pending',
  link_mode TEXT NOT NULL DEFAULT 'provisioned',
  routing_mismatch_note TEXT NULL,
  has_unique_permissions BOOLEAN NOT NULL DEFAULT FALSE,
  unique_scope_count INTEGER NOT NULL DEFAULT 0,
  intended_grants JSONB NOT NULL DEFAULT '[]'::jsonb,
  retention_label_id TEXT NULL,
  delta_sync_cursor TEXT NULL,
  last_job_id TEXT NULL,
  last_error_code TEXT NULL,
  last_error_message TEXT NULL,
  provisioned_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_matter_document_locations_store UNIQUE (tenant_id, matter_id, store_id, library_id)
);

CREATE INDEX IF NOT EXISTS idx_matter_document_locations_tenant_matter
  ON matter_document_locations (tenant_id, matter_id);

CREATE TABLE IF NOT EXISTS document_store_folder_scopes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  has_unique_permissions BOOLEAN NOT NULL DEFAULT TRUE,
  intended_grants JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_document_store_folder_scopes_key UNIQUE (tenant_id, store_id, library_id, scope_type, scope_key)
);

CREATE TABLE IF NOT EXISTS document_lifecycle_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  matter_id TEXT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  triggered_by_user_id TEXT NULL,
  trigger_event TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NULL,
  last_error_code TEXT NULL,
  last_error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_lifecycle_jobs_tenant_status
  ON document_lifecycle_jobs (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS document_reconciliation_findings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  matter_id TEXT NULL,
  provider_item_id TEXT NULL,
  scope_identifier TEXT NOT NULL,
  finding_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  status TEXT NOT NULL DEFAULT 'open',
  intended_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  actual_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  remediated_at TIMESTAMPTZ NULL,
  remediated_by_user_id TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_reconciliation_findings_tenant_status
  ON document_reconciliation_findings (tenant_id, status, detected_at DESC);

CREATE TABLE IF NOT EXISTS document_store_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id TEXT NULL,
  identity_used TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  action TEXT NOT NULL,
  matter_id TEXT NULL,
  store_id TEXT NULL,
  library_id TEXT NULL,
  provider_item_id TEXT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_document_store_audit_events_tenant_occurred
  ON document_store_audit_events (tenant_id, occurred_at DESC);
`.trim(),
  downSql: `
DROP TABLE IF EXISTS document_store_audit_events;
DROP TABLE IF EXISTS document_reconciliation_findings;
DROP TABLE IF EXISTS document_lifecycle_jobs;
DROP TABLE IF EXISTS document_store_folder_scopes;
DROP TABLE IF EXISTS matter_document_locations;
DROP TABLE IF EXISTS person_entra_identities;
`.trim(),
};

export const KEY_DATES_MIGRATION_0003: TenantMigrationDefinition = {
  version: '0003',
  name: '0003_key_dates_expand',
  description:
    'Expand-phase migration creating tenant-scoped key_dates, key_date_not_applicable, key_date_reminder_states, key_date_calendar_syncs, and key_date_audit_events tables.',
  tablesChanged: [
    'key_dates',
    'key_date_not_applicable',
    'key_date_reminder_states',
    'key_date_calendar_syncs',
    'key_date_audit_events',
  ],
  upSql: `
CREATE TABLE IF NOT EXISTS key_dates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  matter_id TEXT NULL,
  enquiry_id TEXT NULL,
  key_date_type_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  due_date DATE NOT NULL,
  due_time TEXT NULL,
  is_critical BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  team_id TEXT NOT NULL,
  responsible_person_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  calculation_json JSONB NULL,
  verification_json JSONB NOT NULL,
  outcome_json JSONB NULL,
  supersedes_key_date_id TEXT NULL REFERENCES key_dates(id),
  superseded_by_key_date_id TEXT NULL REFERENCES key_dates(id),
  notes TEXT NULL,
  source_document_id TEXT NULL,
  created_by_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_by_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT chk_key_dates_entity CHECK (
    (matter_id IS NOT NULL AND enquiry_id IS NULL) OR
    (matter_id IS NULL AND enquiry_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_key_dates_tenant_matter
  ON key_dates (tenant_id, matter_id);

CREATE INDEX IF NOT EXISTS idx_key_dates_tenant_enquiry
  ON key_dates (tenant_id, enquiry_id);

CREATE INDEX IF NOT EXISTS idx_key_dates_tenant_team_due
  ON key_dates (tenant_id, team_id, due_date);

CREATE TABLE IF NOT EXISTS key_date_not_applicable (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  key_date_type_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  recorded_by_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, matter_id, key_date_type_id)
);

CREATE TABLE IF NOT EXISTS key_date_reminder_states (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  key_date_id TEXT NOT NULL UNIQUE REFERENCES key_dates(id),
  task_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  reminder_schedule_id TEXT NOT NULL,
  current_stage_days_before INTEGER NOT NULL,
  stage_entered_at TIMESTAMPTZ NOT NULL,
  acknowledged_by_id TEXT NULL,
  acknowledged_at TIMESTAMPTZ NULL,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  last_notified_at TIMESTAMPTZ NULL,
  CONSTRAINT uq_key_date_reminder_states_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS key_date_calendar_syncs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  key_date_id TEXT NOT NULL UNIQUE REFERENCES key_dates(id),
  state TEXT NOT NULL,
  external_events_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_synced_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS key_date_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  key_date_id TEXT NULL,
  matter_id TEXT NULL,
  enquiry_id TEXT NULL,
  actor_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  reason TEXT NULL,
  before_json JSONB NULL,
  after_json JSONB NULL,
  correlation_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_key_date_audit_events_tenant_key_date
  ON key_date_audit_events (tenant_id, key_date_id, occurred_at DESC);
`.trim(),
  downSql: `
-- Audit table key_date_audit_events is intentionally retained on rollback to preserve immutable regulatory audit history (ADR-0022).
DROP TABLE IF EXISTS key_date_calendar_syncs;
DROP TABLE IF EXISTS key_date_reminder_states;
DROP TABLE IF EXISTS key_date_not_applicable;
DROP INDEX IF EXISTS idx_key_dates_tenant_team_due;
DROP INDEX IF EXISTS idx_key_dates_tenant_enquiry;
DROP INDEX IF EXISTS idx_key_dates_tenant_matter;
DROP TABLE IF EXISTS key_dates;
`.trim(),
};

export const KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004: TenantMigrationDefinition = {
  version: '0004',
  name: '0004_key_date_reminder_last_skipped_reason_expand',
  description:
    'Adds nullable last_skipped_reason column with CHECK constraint to key_date_reminder_states so skipped reminder reasons (no_permitted_assignees, missing_matter) persist across tenant databases.',
  tablesChanged: ['key_date_reminder_states'],
  dependsOn: ['0003'],
  upSql: `
ALTER TABLE key_date_reminder_states
  ADD COLUMN IF NOT EXISTS last_skipped_reason TEXT NULL
  CONSTRAINT chk_key_date_reminder_states_last_skipped_reason
  CHECK (last_skipped_reason IS NULL OR last_skipped_reason IN ('no_permitted_assignees', 'missing_matter'));
`.trim(),
  downSql: `
ALTER TABLE key_date_reminder_states
  DROP CONSTRAINT IF EXISTS chk_key_date_reminder_states_last_skipped_reason;
ALTER TABLE key_date_reminder_states
  DROP COLUMN IF EXISTS last_skipped_reason;
`.trim(),
};

export const KEY_DATES_MATTER_RESTRICTIONS_MIGRATION_0005: TenantMigrationDefinition = {
  version: '0005',
  name: '0005_key_dates_matter_restrictions_expand',
  description:
    'Adds matter_restriction_metadata and key_dates_tenant_configs tables so restricted/staff matter visibility and per-tenant key date configuration overrides persist in PostgreSQL.',
  tablesChanged: ['matter_restriction_metadata', 'key_dates_tenant_configs'],
  dependsOn: ['0003'],
  upSql: `
CREATE TABLE IF NOT EXISTS matter_restriction_metadata (
  tenant_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  is_restricted BOOLEAN NOT NULL DEFAULT FALSE,
  restricted_access_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, matter_id)
);

CREATE TABLE IF NOT EXISTS key_dates_tenant_configs (
  tenant_id TEXT PRIMARY KEY,
  config_json JSONB NOT NULL,
  updated_by_id TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`.trim(),
  downSql: `
DROP TABLE IF EXISTS key_dates_tenant_configs;
DROP TABLE IF EXISTS matter_restriction_metadata;
`.trim(),
};

export const DOCUMENT_GENERATION_TENANT_CONFIG_MIGRATION_0006: TenantMigrationDefinition = {
  version: '0006',
  name: '0006_document_generation_tenant_config_expand',
  description:
    'Adds document_generation_tenant_configs and document_store_tenant_configs tables for per-tenant runtime configuration overrides and decouples generated documents historical template references.',
  tablesChanged: [
    'document_generation_tenant_configs',
    'document_store_tenant_configs',
    'documents',
  ],
  dependsOn: ['0001', '0002'],
  upSql: `
CREATE TABLE IF NOT EXISTS document_generation_tenant_configs (
  tenant_id TEXT PRIMARY KEY,
  config_json JSONB NOT NULL,
  updated_by_id TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_store_tenant_configs (
  tenant_id TEXT PRIMARY KEY,
  config_json JSONB NOT NULL,
  updated_by_id TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_template_id_fkey,
  DROP CONSTRAINT IF EXISTS documents_template_version_id_fkey;
`.trim(),
  // R434: the upSql drops the documents -> template foreign keys, so the downSql restores them.
  // NOT VALID keeps the rollback safe when rows written after 0006 no longer satisfy them.
  downSql: `
DROP TABLE IF EXISTS document_store_tenant_configs;
DROP TABLE IF EXISTS document_generation_tenant_configs;

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_template_id_fkey,
  DROP CONSTRAINT IF EXISTS documents_template_version_id_fkey;
ALTER TABLE documents
  ADD CONSTRAINT documents_template_id_fkey
    FOREIGN KEY (template_id) REFERENCES document_templates(id) NOT VALID,
  ADD CONSTRAINT documents_template_version_id_fkey
    FOREIGN KEY (template_version_id) REFERENCES document_template_versions(id) NOT VALID;
`.trim(),
  // Checksum recorded before R434 corrected the downSql (the upSql is unchanged).
  acceptedPriorChecksums: [
    'a2f39b9403c1dbd0e15f81f52150b804fec75196bcd5e352b6db8d4a3424cf54',
  ],
};

export const FIRM_AUDIT_LOG_MIGRATION_0007: TenantMigrationDefinition = {
  version: '0007',
  name: '0007_firm_audit_log_expand',
  description:
    'Expand-phase migration creating append-only firm-wide audit_entries table, per-tenant audit/key-date sequences, and record/chronological indexes with SELECT/INSERT-only tenant-role privileges (ADR 0028, S0-15, R413).',
  tablesChanged: ['audit_entries'],
  dependsOn: ['0006'],
  upSql: `
CREATE SEQUENCE IF NOT EXISTS tenant_audit_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS tenant_key_date_id_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS audit_entries (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  seq BIGSERIAL NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL,
  field TEXT NULL,
  old_value TEXT NULL,
  new_value TEXT NULL,
  reason TEXT NULL,
  by_id TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  at_iso TEXT NOT NULL,
  snapshot_json JSONB NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_audit_entries_tenant_at
  ON audit_entries (tenant_id, at DESC, seq DESC);

CREATE INDEX IF NOT EXISTS idx_audit_entries_tenant_record
  ON audit_entries (tenant_id, record_type, record_id, at DESC);

DO $$
DECLARE
  v_role TEXT := 'role_tenant_' || substring(current_database() from '^pg_tenant_(.+)$');
BEGIN
  IF v_role IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('REVOKE ALL ON TABLE public.audit_entries FROM %I', v_role);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE public.audit_entries TO %I', v_role);
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.tenant_audit_id_seq, public.tenant_key_date_id_seq, public.audit_entries_seq_seq TO %I', v_role);
  END IF;
END $$;
`.trim(),
  downSql: `
DROP INDEX IF EXISTS idx_audit_entries_tenant_record;
DROP INDEX IF EXISTS idx_audit_entries_tenant_at;
DROP TABLE IF EXISTS audit_entries;
DROP SEQUENCE IF EXISTS tenant_key_date_id_seq;
DROP SEQUENCE IF EXISTS tenant_audit_id_seq;
`.trim(),
};

/**
 * R453: lets the web app's demo reset clear the audit log under the tenant role, without the
 * migrate identity. The function exists only in non-live databases and refuses again at run time
 * if the database is a `_live` one. The tenant role keeps SELECT and INSERT only on audit_entries.
 */
export const NON_LIVE_AUDIT_RESET_MIGRATION_0008: TenantMigrationDefinition = {
  version: '0008',
  name: '0008_non_live_audit_reset_function',
  description:
    'Expand-phase migration adding the SECURITY DEFINER public.reset_non_live_audit_log(text) function in non-live tenant databases only, executable by the tenant role, so demo reset never needs the migrate identity, plus idx_audit_entries_tenant_seq and sequence privilege tightening (S0-15, R451, R453, R460).',
  tablesChanged: [],
  dependsOn: ['0007'],
  upSql: `
CREATE INDEX IF NOT EXISTS idx_audit_entries_tenant_seq
  ON public.audit_entries (tenant_id, seq DESC);

DO $do$
DECLARE
  v_suffix TEXT := substring(current_database() from '^pg_tenant_(.+)$');
  v_role TEXT := 'role_tenant_' || substring(current_database() from '^pg_tenant_(.+)$');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public FROM %I', v_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', v_role);
    EXECUTE format('GRANT UPDATE ON SEQUENCE public.tenant_audit_id_seq TO %I', v_role);
  END IF;
  IF v_suffix IS NULL OR right(v_suffix, 5) = '_live' THEN
    RETURN;
  END IF;
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.reset_non_live_audit_log(p_tenant_id TEXT)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $body$
    BEGIN
      IF right(current_database(), 5) = '_live' THEN
        RAISE EXCEPTION 'LIVE_AUDIT_RESET_FORBIDDEN: Immutable audit_entries cannot be cleared in the live environment.'
          USING ERRCODE = '42501';
      END IF;
      DELETE FROM public.audit_entries WHERE tenant_id = p_tenant_id;
      PERFORM setval('public.tenant_audit_id_seq', 1, false);
    END
    $body$
  $fn$;
  EXECUTE 'REVOKE ALL ON FUNCTION public.reset_non_live_audit_log(TEXT) FROM PUBLIC';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.reset_non_live_audit_log(TEXT) TO %I', v_role);
  END IF;
END
$do$;
`.trim(),
  downSql: `
DROP FUNCTION IF EXISTS public.reset_non_live_audit_log(TEXT);
DROP INDEX IF EXISTS public.idx_audit_entries_tenant_seq;
`.trim(),
};

export const PARTIES_AND_MATTERS_MIGRATION_0009: TenantMigrationDefinition = {
  version: '0009',
  name: '0009_parties_and_matters_expand',
  description:
    'Expand-phase migration creating people, person_emails, organisations, person_organisation_links, notes, merge_history, matters (with row_version optimistic concurrency), matter_parties, matter_number_sequences, tenant_record_sequences, and per-tenant sequences (ADR 0028, S0-16, B6, R408, R409, R410, R448).',
  tablesChanged: [
    'tenant_record_sequences',
    'matter_number_sequences',
    'people',
    'person_emails',
    'organisations',
    'person_organisation_links',
    'notes',
    'merge_history',
    'matters',
    'matter_parties',
  ],
  dependsOn: ['0008'],
  upSql: `
CREATE SEQUENCE IF NOT EXISTS tenant_person_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS tenant_organisation_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS tenant_link_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS tenant_note_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS tenant_merge_history_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS tenant_matter_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS tenant_matter_number_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS tenant_record_sequences (
  tenant_id TEXT NOT NULL,
  counter_key TEXT NOT NULL,
  last_value BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, counter_key)
);

CREATE TABLE IF NOT EXISTS matter_number_sequences (
  tenant_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  last_number BIGINT NOT NULL CHECK (last_number >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, prefix)
);

CREATE TABLE IF NOT EXISTS people (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  preferred_name TEXT NOT NULL DEFAULT '',
  other_names TEXT NOT NULL DEFAULT '',
  surname TEXT NOT NULL DEFAULT '',
  title_id TEXT NULL,
  date_of_birth TEXT NULL,
  is_employee BOOLEAN NOT NULL DEFAULT FALSE,
  employee_role_id TEXT NULL,
  app_role TEXT NULL,
  entra_object_id TEXT NULL,
  primary_email_lower TEXT NULL,
  job_title TEXT NOT NULL DEFAULT '',
  department_id TEXT NULL,
  office_id TEXT NULL,
  supervisor_id TEXT NULL,
  is_fee_earner BOOLEAN NOT NULL DEFAULT FALSE,
  default_hourly_rate_gbp NUMERIC(12,2) NULL,
  client_status_id TEXT NULL,
  aml_status_id TEXT NULL,
  id_verified_on TEXT NULL,
  id_expiry_date TEXT NULL,
  created_from_enquiry_id TEXT NULL,
  merged_into_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  emails_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  phones_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  addresses_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  relationship_role_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  roles_json JSONB NULL,
  permission_overrides_json JSONB NULL,
  dismissed_duplicate_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  employment_json JSONB NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_people_tenant_entra_oid
  ON people (tenant_id, entra_object_id)
  WHERE entra_object_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_people_tenant_surname
  ON people (tenant_id, lower(surname), lower(first_name));

CREATE INDEX IF NOT EXISTS idx_people_tenant_employee
  ON people (tenant_id, is_employee)
  WHERE merged_into_id IS NULL;

CREATE TABLE IF NOT EXISTS person_emails (
  tenant_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  email_lower TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('contact_email', 'firm_work_email')),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, person_id, email_lower, source),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_person_emails_tenant_active
  ON person_emails (tenant_id, email_lower)
  WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS organisations (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  legal_name TEXT NOT NULL DEFAULT '',
  trading_name TEXT NOT NULL DEFAULT '',
  organisation_type_id TEXT NULL,
  company_number TEXT NOT NULL DEFAULT '',
  vat_number TEXT NOT NULL DEFAULT '',
  client_reference TEXT NOT NULL DEFAULT '',
  general_email TEXT NOT NULL DEFAULT '',
  main_phone TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  parent_organisation_id TEXT NULL,
  relationship_partner_id TEXT NULL,
  conflict_status TEXT NULL,
  aml_status_id TEXT NULL,
  client_status_id TEXT NULL,
  created_from_enquiry_id TEXT NULL,
  merged_into_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registered_address_json JSONB NULL,
  trading_address_json JSONB NULL,
  relationship_type_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  sector_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  dismissed_duplicate_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_organisations_tenant_name
  ON organisations (tenant_id, lower(legal_name));

CREATE INDEX IF NOT EXISTS idx_organisations_tenant_company_no
  ON organisations (tenant_id, company_number)
  WHERE company_number <> '';

CREATE INDEX IF NOT EXISTS idx_organisations_tenant_parent
  ON organisations (tenant_id, parent_organisation_id)
  WHERE parent_organisation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS person_organisation_links (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  organisation_id TEXT NOT NULL,
  job_title TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  role_within_organisation TEXT NOT NULL DEFAULT '',
  is_primary_contact BOOLEAN NOT NULL DEFAULT FALSE,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  start_date TEXT NULL,
  end_date TEXT NULL,
  contact_status_id TEXT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  contact_role_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_po_links_tenant_person
  ON person_organisation_links (tenant_id, person_id);

CREATE INDEX IF NOT EXISTS idx_po_links_tenant_org
  ON person_organisation_links (tenant_id, organisation_id);

CREATE TABLE IF NOT EXISTS notes (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'standard',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_id TEXT NOT NULL,
  merged_from_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_notes_tenant_record
  ON notes (tenant_id, record_type, record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS merge_history (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  survivor_id TEXT NOT NULL,
  merged_id TEXT NOT NULL,
  merged_by_id TEXT NOT NULL,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_merge_history_tenant_survivor
  ON merge_history (tenant_id, record_type, survivor_id);

CREATE INDEX IF NOT EXISTS idx_merge_history_tenant_merged
  ON merge_history (tenant_id, record_type, merged_id);

CREATE TABLE IF NOT EXISTS matters (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  matter_number TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  client_type TEXT NOT NULL DEFAULT 'organisation',
  client_id TEXT NOT NULL DEFAULT '',
  instructing_contact_id TEXT NULL,
  billing_contact_id TEXT NULL,
  referrer_person_id TEXT NULL,
  referrer_organisation_id TEXT NULL,
  legal_entity_id TEXT NULL,
  department_id TEXT NULL,
  team_id TEXT NULL,
  office_id TEXT NULL,
  practice_area_id TEXT NOT NULL DEFAULT '',
  work_type_subcategory_id TEXT NOT NULL DEFAULT '',
  status_id TEXT NOT NULL DEFAULT '',
  stage_group_id TEXT NULL,
  current_stage_id TEXT NOT NULL DEFAULT '',
  responsible_partner_id TEXT NULL,
  responsible_fee_earner_id TEXT NULL,
  supervisor_id TEXT NULL,
  risk_rating_id TEXT NOT NULL DEFAULT '',
  conflict_check_status TEXT NOT NULL DEFAULT '',
  conflict_cleared_by_id TEXT NULL,
  is_staff_matter BOOLEAN NOT NULL DEFAULT FALSE,
  has_ethical_wall BOOLEAN NOT NULL DEFAULT FALSE,
  source_enquiry_id TEXT NULL,
  source_quote_id TEXT NULL,
  opened_on TEXT NULL,
  closed_on TEXT NULL,
  destruction_date TEXT NULL,
  engagement_letter_status TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  additional_client_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  restricted_access_user_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  conflict_check_record_json JSONB NULL,
  risk_assessment_json JSONB NULL,
  costs_json JSONB NULL,
  opening_record_json JSONB NULL,
  milestones_json JSONB NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_matters_tenant_number
  ON matters (tenant_id, matter_number);

CREATE INDEX IF NOT EXISTS idx_matters_tenant_client
  ON matters (tenant_id, client_id);

CREATE INDEX IF NOT EXISTS idx_matters_tenant_status
  ON matters (tenant_id, status_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_matters_tenant_fee_earner
  ON matters (tenant_id, responsible_fee_earner_id);

CREATE INDEX IF NOT EXISTS idx_matters_tenant_restricted
  ON matters (tenant_id, is_staff_matter, has_ethical_wall);

CREATE TABLE IF NOT EXISTS matter_parties (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  entity_type TEXT NULL,
  entity_id TEXT NULL,
  relationship_id TEXT NULL,
  capacity_id TEXT NULL,
  reference TEXT NULL,
  acting_solicitor_organisation_id TEXT NULL,
  acting_solicitor_person_id TEXT NULL,
  notes TEXT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, matter_id) REFERENCES matters (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_matter_parties_tenant_matter
  ON matter_parties (tenant_id, matter_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_matter_parties_tenant_entity
  ON matter_parties (tenant_id, entity_type, entity_id);
`.trim(),
  downSql: `
DROP INDEX IF EXISTS idx_matter_parties_tenant_entity;
DROP INDEX IF EXISTS idx_matter_parties_tenant_matter;
DROP TABLE IF EXISTS matter_parties;

DROP INDEX IF EXISTS idx_matters_tenant_restricted;
DROP INDEX IF EXISTS idx_matters_tenant_fee_earner;
DROP INDEX IF EXISTS idx_matters_tenant_status;
DROP INDEX IF EXISTS idx_matters_tenant_client;
DROP INDEX IF EXISTS idx_matters_tenant_number;
DROP TABLE IF EXISTS matters;

DROP INDEX IF EXISTS idx_merge_history_tenant_merged;
DROP INDEX IF EXISTS idx_merge_history_tenant_survivor;
DROP TABLE IF EXISTS merge_history;

DROP INDEX IF EXISTS idx_notes_tenant_record;
DROP TABLE IF EXISTS notes;

DROP INDEX IF EXISTS idx_po_links_tenant_org;
DROP INDEX IF EXISTS idx_po_links_tenant_person;
DROP TABLE IF EXISTS person_organisation_links;

DROP INDEX IF EXISTS idx_organisations_tenant_parent;
DROP INDEX IF EXISTS idx_organisations_tenant_company_no;
DROP INDEX IF EXISTS idx_organisations_tenant_name;
DROP TABLE IF EXISTS organisations;

DROP INDEX IF EXISTS idx_person_emails_tenant_active;
DROP TABLE IF EXISTS person_emails;

DROP INDEX IF EXISTS idx_people_tenant_employee;
DROP INDEX IF EXISTS idx_people_tenant_surname;
DROP INDEX IF EXISTS idx_people_tenant_entra_oid;
DROP TABLE IF EXISTS people;

DROP TABLE IF EXISTS matter_number_sequences;
DROP TABLE IF EXISTS tenant_record_sequences;

DROP SEQUENCE IF EXISTS tenant_matter_number_seq;
DROP SEQUENCE IF EXISTS tenant_matter_id_seq;
DROP SEQUENCE IF EXISTS tenant_merge_history_id_seq;
DROP SEQUENCE IF EXISTS tenant_note_id_seq;
DROP SEQUENCE IF EXISTS tenant_link_id_seq;
DROP SEQUENCE IF EXISTS tenant_organisation_id_seq;
DROP SEQUENCE IF EXISTS tenant_person_id_seq;
`.trim(),
};

export const INTAKE_QUOTES_TASKS_MIGRATION_0010: TenantMigrationDefinition = {
  version: '0010',
  name: '0010_intake_quotes_tasks_expand',
  description:
    'Creates tenant-scoped tables and sequences for enquiries, quotes, tasks, task_linked_records, notifications, sign_offs, and recently_viewed (S0-17a).',
  dependsOn: ['0009'],
  tablesChanged: [
    'enquiries',
    'quotes',
    'quote_reference_sequences',
    'tasks',
    'task_linked_records',
    'notifications',
    'sign_offs',
    'recently_viewed',
  ],
  upSql: `
CREATE SEQUENCE IF NOT EXISTS tenant_enquiry_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS tenant_quote_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS tenant_task_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS tenant_notification_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS tenant_sign_off_id_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS enquiries (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'New',
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT NULL,
  phone TEXT NULL,
  postcode TEXT NULL,
  calling_on_behalf_of TEXT NULL,
  organisation_name TEXT NULL,
  channel_id TEXT NULL,
  practice_area_id TEXT NULL,
  work_type_subcategory_id TEXT NULL,
  urgency_id TEXT NULL,
  assigned_team_id TEXT NULL,
  assigned_to_id TEXT NULL,
  taken_by_id TEXT NULL,
  created_by_id TEXT NULL,
  updated_by_id TEXT NULL,
  linked_person_id TEXT NULL,
  linked_organisation_id TEXT NULL,
  referrer_person_id TEXT NULL,
  referred_to_organisation_id TEXT NULL,
  converted_matter_id TEXT NULL,
  close_reason_id TEXT NULL,
  privacy_notice_given BOOLEAN NOT NULL DEFAULT FALSE,
  received_at TIMESTAMPTZ NOT NULL,
  first_contact_due_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  anonymised_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary_and_notes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  contact_log_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflict_snapshot_json JSONB NULL,
  key_dates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_enquiries_tenant_status
  ON enquiries (tenant_id, status, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_enquiries_tenant_team
  ON enquiries (tenant_id, assigned_team_id, status);

CREATE INDEX IF NOT EXISTS idx_enquiries_tenant_assignee
  ON enquiries (tenant_id, assigned_to_id, status);

CREATE INDEX IF NOT EXISTS idx_enquiries_tenant_linked_person
  ON enquiries (tenant_id, linked_person_id);

CREATE INDEX IF NOT EXISTS idx_enquiries_tenant_linked_org
  ON enquiries (tenant_id, linked_organisation_id);

CREATE INDEX IF NOT EXISTS idx_enquiries_tenant_converted_matter
  ON enquiries (tenant_id, converted_matter_id);

CREATE INDEX IF NOT EXISTS idx_enquiries_tenant_retention
  ON enquiries (tenant_id, status, closed_at);

CREATE TABLE IF NOT EXISTS quotes (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  quote_reference TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'Draft',
  fee_basis TEXT NOT NULL DEFAULT '',
  client_type TEXT NULL,
  client_person_id TEXT NULL,
  client_organisation_id TEXT NULL,
  prospect_name TEXT NULL,
  source_enquiry_id TEXT NULL,
  converted_matter_id TEXT NULL,
  practice_area_id TEXT NULL,
  work_type_subcategory_id TEXT NULL,
  prepared_by_id TEXT NULL,
  assigned_team_id TEXT NULL,
  fee_total_ex_vat_gbp NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_inc_vat_gbp NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_on_account_gbp NUMERIC(12,2) NULL,
  valid_until TEXT NULL,
  sent_at TIMESTAMPTZ NULL,
  outcome_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pricing_breakdown_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  follow_ups_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  version_history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflict_decision_json JSONB NULL,
  custom_fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_quotes_tenant_status
  ON quotes (tenant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_quotes_tenant_enquiry
  ON quotes (tenant_id, source_enquiry_id);

CREATE INDEX IF NOT EXISTS idx_quotes_tenant_converted_matter
  ON quotes (tenant_id, converted_matter_id);

CREATE INDEX IF NOT EXISTS idx_quotes_tenant_reference
  ON quotes (tenant_id, quote_reference);

CREATE TABLE IF NOT EXISTS quote_reference_sequences (
  tenant_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  last_number BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, year)
);

CREATE TABLE IF NOT EXISTS tasks (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  reference TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'To do',
  task_type_id TEXT NULL,
  priority_id TEXT NULL,
  due_at TEXT NULL,
  assigned_team_id TEXT NULL,
  assigned_person_id TEXT NULL,
  multi_assignee_mode TEXT NULL,
  linked_key_date_id TEXT NULL,
  system_key TEXT NULL,
  auto_trigger TEXT NULL,
  created_by_id TEXT NULL,
  updated_by_id TEXT NULL,
  completed_by_id TEXT NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_person_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  linked_records_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  comments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  checklist_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status_due
  ON tasks (tenant_id, status, due_at);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_team
  ON tasks (tenant_id, assigned_team_id, status);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_person
  ON tasks (tenant_id, assigned_person_id, status);

CREATE TABLE IF NOT EXISTS task_linked_records (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, task_id, record_type, record_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_linked_records_tenant_target
  ON task_linked_records (tenant_id, record_type, record_id);

CREATE TABLE IF NOT EXISTS notifications (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  href TEXT NOT NULL DEFAULT '',
  record_id TEXT NOT NULL DEFAULT '',
  by_id TEXT NULL,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_user_created
  ON notifications (tenant_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sign_offs (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  matter_id TEXT NULL,
  matter_number TEXT NULL,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  requested_by_id TEXT NULL,
  assigned_approver_id TEXT NULL,
  decided_by_id TEXT NULL,
  amount_gbp NUMERIC(12,2) NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ NULL,
  discussion_note TEXT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_sign_offs_tenant_status_matter
  ON sign_offs (tenant_id, status, matter_id);

CREATE TABLE IF NOT EXISTS recently_viewed (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_id)
);
`.trim(),
  downSql: `
DROP TABLE IF EXISTS recently_viewed;

DROP INDEX IF EXISTS idx_sign_offs_tenant_status_matter;
DROP TABLE IF EXISTS sign_offs;

DROP INDEX IF EXISTS idx_notifications_tenant_user_created;
DROP TABLE IF EXISTS notifications;

DROP INDEX IF EXISTS idx_task_linked_records_tenant_target;
DROP TABLE IF EXISTS task_linked_records;

DROP INDEX IF EXISTS idx_tasks_tenant_person;
DROP INDEX IF EXISTS idx_tasks_tenant_team;
DROP INDEX IF EXISTS idx_tasks_tenant_status_due;
DROP TABLE IF EXISTS tasks;

DROP TABLE IF EXISTS quote_reference_sequences;

DROP INDEX IF EXISTS idx_quotes_tenant_reference;
DROP INDEX IF EXISTS idx_quotes_tenant_converted_matter;
DROP INDEX IF EXISTS idx_quotes_tenant_enquiry;
DROP INDEX IF EXISTS idx_quotes_tenant_status;
DROP TABLE IF EXISTS quotes;

DROP INDEX IF EXISTS idx_enquiries_tenant_retention;
DROP INDEX IF EXISTS idx_enquiries_tenant_converted_matter;
DROP INDEX IF EXISTS idx_enquiries_tenant_linked_org;
DROP INDEX IF EXISTS idx_enquiries_tenant_linked_person;
DROP INDEX IF EXISTS idx_enquiries_tenant_assignee;
DROP INDEX IF EXISTS idx_enquiries_tenant_team;
DROP INDEX IF EXISTS idx_enquiries_tenant_status;
DROP TABLE IF EXISTS enquiries;

DROP SEQUENCE IF EXISTS tenant_sign_off_id_seq;
DROP SEQUENCE IF EXISTS tenant_notification_id_seq;
DROP SEQUENCE IF EXISTS tenant_task_id_seq;
DROP SEQUENCE IF EXISTS tenant_quote_id_seq;
DROP SEQUENCE IF EXISTS tenant_enquiry_id_seq;
`.trim(),
};

export const HR_TEAMS_AND_RBAC_MIGRATION_0011: TenantMigrationDefinition = {
  version: '0011',
  name: '0011_hr_teams_and_rbac_expand',
  description:
    'Creates tenant-scoped tables and sequences for teams, employee_employment_records (ON DELETE RESTRICT), employee_sensitive_records (ON DELETE RESTRICT), employee_migration_reports, and tenant_rbac_configs (S0-17b).',
  dependsOn: ['0010'],
  tablesChanged: [
    'teams',
    'employee_employment_records',
    'employee_sensitive_records',
    'employee_migration_reports',
    'tenant_rbac_configs',
  ],
  upSql: `
CREATE SEQUENCE IF NOT EXISTS tenant_team_id_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS teams (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_id TEXT NULL,
  updated_by_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  member_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  lead_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  practice_area_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_teams_tenant_active
  ON teams (tenant_id, active);

CREATE TABLE IF NOT EXISTS employee_employment_records (
  tenant_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  employment_status TEXT NULL,
  worker_type TEXT NULL,
  start_date TEXT NULL,
  leaving_date TEXT NULL,
  notice_end_date TEXT NULL,
  hr_retention_until TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  employment_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, person_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_emp_records_tenant_status
  ON employee_employment_records (tenant_id, employment_status);

CREATE TABLE IF NOT EXISTS employee_sensitive_records (
  tenant_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_id TEXT NULL,
  payroll_json JSONB NULL,
  sensitive_hr_json JSONB NULL,
  PRIMARY KEY (tenant_id, person_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS employee_migration_reports (
  tenant_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  report_json JSONB NULL,
  PRIMARY KEY (tenant_id)
);

CREATE TABLE IF NOT EXISTS tenant_rbac_configs (
  tenant_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_id TEXT NULL,
  rbac_override_json JSONB NULL,
  PRIMARY KEY (tenant_id)
);
`.trim(),
  downSql: `
DROP TABLE IF EXISTS tenant_rbac_configs;
DROP TABLE IF EXISTS employee_migration_reports;
DROP TABLE IF EXISTS employee_sensitive_records;

DROP INDEX IF EXISTS idx_emp_records_tenant_status;
DROP TABLE IF EXISTS employee_employment_records;

DROP INDEX IF EXISTS idx_teams_tenant_active;
DROP TABLE IF EXISTS teams;

DROP SEQUENCE IF EXISTS tenant_team_id_seq;
`.trim(),
};

export const CATALOGUES_AND_CONFIG_MIGRATION_0012: TenantMigrationDefinition = {
  version: '0012',
  name: '0012_catalogues_and_config_expand',
  description:
    'Creates tenant-scoped tables for firm_profiles, choice_lists, choice_values, custom_field_definitions, and tenant_module_configs (S0-17c).',
  dependsOn: ['0011'],
  tablesChanged: [
    'firm_profiles',
    'choice_lists',
    'choice_values',
    'custom_field_definitions',
    'tenant_module_configs',
  ],
  upSql: `
CREATE TABLE IF NOT EXISTS firm_profiles (
  tenant_id TEXT NOT NULL,
  firm_id TEXT NOT NULL,
  is_clean_deployment BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  firm_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id)
);

CREATE TABLE IF NOT EXISTS choice_lists (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NULL,
  allow_hierarchy BOOLEAN NOT NULL DEFAULT FALSE,
  system_locked BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS choice_values (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  list_key TEXT NOT NULL,
  code TEXT NULL,
  label TEXT NOT NULL,
  parent_id TEXT NULL,
  sort_order INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_choice_values_tenant_list
  ON choice_values (tenant_id, list_key, sort_order);

CREATE TABLE IF NOT EXISTS custom_field_definitions (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,
  section TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'admin',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  options_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_custom_fields_tenant_type
  ON custom_field_definitions (tenant_id, record_type, sort_order);

CREATE TABLE IF NOT EXISTS tenant_module_configs (
  tenant_id TEXT NOT NULL,
  config_key TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_id TEXT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, config_key)
);
`.trim(),
  downSql: `
DROP TABLE IF EXISTS tenant_module_configs;

DROP INDEX IF EXISTS idx_custom_fields_tenant_type;
DROP TABLE IF EXISTS custom_field_definitions;

DROP INDEX IF EXISTS idx_choice_values_tenant_list;
DROP TABLE IF EXISTS choice_values;

DROP TABLE IF EXISTS choice_lists;
DROP TABLE IF EXISTS firm_profiles;
`.trim(),
};

export const PMS_PER_TENANT_MIGRATION_0013: TenantMigrationDefinition = {
  version: '0013',
  name: '0013_pms_per_tenant_expand',
  description:
    'Creates tenant-scoped tables for pms_links, pms_extract_metadata, per-tenant PMS extract tables, pms_matter_financials, and pms_credit_control_log (S0-18).',
  dependsOn: ['0012'],
  tablesChanged: [
    'pms_links',
    'pms_extract_metadata',
    'pms_fee_earners',
    'pms_clients',
    'pms_matters',
    'pms_matter_financials',
    'pms_fee_estimates',
    'pms_invoices',
    'pms_payments',
    'pms_time_entries',
    'pms_disbursements',
    'pms_client_account_entries',
    'pms_credit_control_log',
  ],
  upSql: `
CREATE SEQUENCE IF NOT EXISTS public.tenant_pms_link_id_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS pms_links (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  onesquared_id TEXT NOT NULL,
  pms_code TEXT NOT NULL,
  match_status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  match_reason TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by_id TEXT NULL,
  last_synced_at TIMESTAMPTZ NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pms_links_tenant_entity_osid
  ON pms_links (tenant_id, entity_type, onesquared_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pms_links_tenant_entity_code
  ON pms_links (tenant_id, entity_type, pms_code);

CREATE TABLE IF NOT EXISTS pms_extract_metadata (
  tenant_id TEXT NOT NULL,
  as_at_date TEXT NOT NULL,
  source_name TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id)
);

CREATE TABLE IF NOT EXISTS pms_fee_earners (
  tenant_id TEXT NOT NULL,
  fee_earner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  grade TEXT NOT NULL,
  department TEXT NOT NULL,
  office TEXT NOT NULL,
  charge_out_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, fee_earner_id)
);

CREATE TABLE IF NOT EXISTS pms_clients (
  tenant_id TEXT NOT NULL,
  client_code TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_type TEXT NOT NULL,
  company_number TEXT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, client_code)
);

CREATE TABLE IF NOT EXISTS pms_matters (
  tenant_id TEXT NOT NULL,
  matter_code TEXT NOT NULL,
  client_code TEXT NOT NULL,
  matter_description TEXT NOT NULL,
  department TEXT NOT NULL,
  work_type TEXT NOT NULL,
  responsible_partner_id TEXT NOT NULL,
  acting_fee_earner_id TEXT NOT NULL,
  billing_basis TEXT NOT NULL,
  fee_estimate DOUBLE PRECISION NOT NULL DEFAULT 0,
  matter_status TEXT NOT NULL,
  open_date TEXT NULL,
  close_date TEXT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, matter_code)
);

CREATE INDEX IF NOT EXISTS idx_pms_matters_tenant_client
  ON pms_matters (tenant_id, client_code);

CREATE INDEX IF NOT EXISTS idx_pms_matters_tenant_fe
  ON pms_matters (tenant_id, acting_fee_earner_id);

CREATE TABLE IF NOT EXISTS pms_matter_financials (
  tenant_id TEXT NOT NULL,
  matter_code TEXT NOT NULL,
  client_code TEXT NOT NULL,
  matter_description TEXT NOT NULL,
  department TEXT NOT NULL,
  work_type TEXT NOT NULL,
  responsible_partner_id TEXT NOT NULL,
  acting_fee_earner_id TEXT NOT NULL,
  billing_basis TEXT NOT NULL,
  matter_status TEXT NOT NULL,
  open_date TEXT NULL,
  close_date TEXT NULL,
  current_fee_estimate DOUBLE PRECISION NOT NULL DEFAULT 0,
  wip_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  wip_value DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_time_value DOUBLE PRECISION NOT NULL DEFAULT 0,
  billed_fees_ex_vat DOUBLE PRECISION NOT NULL DEFAULT 0,
  billed_disb_ex_vat DOUBLE PRECISION NOT NULL DEFAULT 0,
  billed_vat DOUBLE PRECISION NOT NULL DEFAULT 0,
  billed_total_inc_vat DOUBLE PRECISION NOT NULL DEFAULT 0,
  cash_received DOUBLE PRECISION NOT NULL DEFAULT 0,
  outstanding_debt DOUBLE PRECISION NOT NULL DEFAULT 0,
  unbilled_disbursements DOUBLE PRECISION NOT NULL DEFAULT 0,
  client_account_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, matter_code)
);

CREATE INDEX IF NOT EXISTS idx_pms_fin_tenant_client
  ON pms_matter_financials (tenant_id, client_code);

CREATE INDEX IF NOT EXISTS idx_pms_fin_tenant_fe
  ON pms_matter_financials (tenant_id, acting_fee_earner_id);

CREATE TABLE IF NOT EXISTS pms_fee_estimates (
  tenant_id TEXT NOT NULL,
  estimate_id TEXT NOT NULL,
  matter_code TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  estimate_date TEXT NOT NULL,
  estimated_fees_ex_vat DOUBLE PRECISION NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, estimate_id)
);

CREATE INDEX IF NOT EXISTS idx_pms_estimates_tenant_matter
  ON pms_fee_estimates (tenant_id, matter_code, version);

CREATE TABLE IF NOT EXISTS pms_invoices (
  tenant_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  matter_code TEXT NOT NULL,
  client_code TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL,
  total_inc_vat DOUBLE PRECISION NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_pms_invoices_tenant_matter
  ON pms_invoices (tenant_id, matter_code, invoice_date DESC);

CREATE INDEX IF NOT EXISTS idx_pms_invoices_tenant_client
  ON pms_invoices (tenant_id, client_code);

CREATE TABLE IF NOT EXISTS pms_payments (
  tenant_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  matter_code TEXT NOT NULL,
  client_code TEXT NOT NULL,
  payment_date TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, receipt_id)
);

CREATE INDEX IF NOT EXISTS idx_pms_payments_tenant_invoice
  ON pms_payments (tenant_id, invoice_number);

CREATE INDEX IF NOT EXISTS idx_pms_payments_tenant_matter
  ON pms_payments (tenant_id, matter_code);

CREATE INDEX IF NOT EXISTS idx_pms_payments_tenant_client
  ON pms_payments (tenant_id, client_code);

CREATE INDEX IF NOT EXISTS idx_pms_payments_tenant_date
  ON pms_payments (tenant_id, payment_date);

CREATE TABLE IF NOT EXISTS pms_time_entries (
  tenant_id TEXT NOT NULL,
  time_id TEXT NOT NULL,
  matter_code TEXT NOT NULL,
  fee_earner_id TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  value DOUBLE PRECISION NOT NULL DEFAULT 0,
  billing_status TEXT NOT NULL,
  invoice_number TEXT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, time_id)
);

CREATE INDEX IF NOT EXISTS idx_pms_time_tenant_matter
  ON pms_time_entries (tenant_id, matter_code, entry_date DESC);

CREATE INDEX IF NOT EXISTS idx_pms_time_tenant_fe
  ON pms_time_entries (tenant_id, fee_earner_id);

CREATE INDEX IF NOT EXISTS idx_pms_time_tenant_date
  ON pms_time_entries (tenant_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS pms_disbursements (
  tenant_id TEXT NOT NULL,
  disbursement_id TEXT NOT NULL,
  matter_code TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  amount_ex_vat DOUBLE PRECISION NOT NULL DEFAULT 0,
  billing_status TEXT NOT NULL,
  invoice_number TEXT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, disbursement_id)
);

CREATE INDEX IF NOT EXISTS idx_pms_disb_tenant_matter
  ON pms_disbursements (tenant_id, matter_code, entry_date DESC);

CREATE INDEX IF NOT EXISTS idx_pms_disb_tenant_date
  ON pms_disbursements (tenant_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS pms_client_account_entries (
  tenant_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  matter_code TEXT NOT NULL,
  client_code TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  balance_after DOUBLE PRECISION NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_pms_client_acct_tenant_matter
  ON pms_client_account_entries (tenant_id, matter_code, entry_date DESC);

CREATE INDEX IF NOT EXISTS idx_pms_client_acct_tenant_client
  ON pms_client_account_entries (tenant_id, client_code);

CREATE INDEX IF NOT EXISTS idx_pms_client_acct_tenant_date
  ON pms_client_account_entries (tenant_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS pms_credit_control_log (
  tenant_id TEXT NOT NULL,
  id BIGSERIAL NOT NULL,
  invoice_number TEXT NOT NULL,
  matter_code TEXT NOT NULL,
  action_type TEXT NOT NULL,
  notes TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_pms_cc_log_tenant_invoice
  ON pms_credit_control_log (tenant_id, invoice_number, id DESC);

CREATE INDEX IF NOT EXISTS idx_pms_cc_log_tenant_matter
  ON pms_credit_control_log (tenant_id, matter_code, id DESC);
`.trim(),
  downSql: `
DROP INDEX IF EXISTS idx_pms_cc_log_tenant_matter;
DROP INDEX IF EXISTS idx_pms_cc_log_tenant_invoice;
DROP TABLE IF EXISTS pms_credit_control_log;

DROP INDEX IF EXISTS idx_pms_client_acct_tenant_date;
DROP INDEX IF EXISTS idx_pms_client_acct_tenant_client;
DROP INDEX IF EXISTS idx_pms_client_acct_tenant_matter;
DROP TABLE IF EXISTS pms_client_account_entries;

DROP INDEX IF EXISTS idx_pms_disb_tenant_date;
DROP INDEX IF EXISTS idx_pms_disb_tenant_matter;
DROP TABLE IF EXISTS pms_disbursements;

DROP INDEX IF EXISTS idx_pms_time_tenant_date;
DROP INDEX IF EXISTS idx_pms_time_tenant_fe;
DROP INDEX IF EXISTS idx_pms_time_tenant_matter;
DROP TABLE IF EXISTS pms_time_entries;

DROP INDEX IF EXISTS idx_pms_payments_tenant_date;
DROP INDEX IF EXISTS idx_pms_payments_tenant_client;
DROP INDEX IF EXISTS idx_pms_payments_tenant_matter;
DROP INDEX IF EXISTS idx_pms_payments_tenant_invoice;
DROP TABLE IF EXISTS pms_payments;

DROP INDEX IF EXISTS idx_pms_invoices_tenant_client;
DROP INDEX IF EXISTS idx_pms_invoices_tenant_matter;
DROP TABLE IF EXISTS pms_invoices;

DROP INDEX IF EXISTS idx_pms_estimates_tenant_matter;
DROP TABLE IF EXISTS pms_fee_estimates;

DROP INDEX IF EXISTS idx_pms_fin_tenant_fe;
DROP INDEX IF EXISTS idx_pms_fin_tenant_client;
DROP TABLE IF EXISTS pms_matter_financials;

DROP INDEX IF EXISTS idx_pms_matters_tenant_fe;
DROP INDEX IF EXISTS idx_pms_matters_tenant_client;
DROP TABLE IF EXISTS pms_matters;

DROP TABLE IF EXISTS pms_clients;
DROP TABLE IF EXISTS pms_fee_earners;
DROP TABLE IF EXISTS pms_extract_metadata;

DROP INDEX IF EXISTS idx_pms_links_tenant_entity_code;
DROP INDEX IF EXISTS idx_pms_links_tenant_entity_osid;
DROP TABLE IF EXISTS pms_links;

DROP SEQUENCE IF EXISTS public.tenant_pms_link_id_seq;
`.trim(),
};

export const SCHEDULER_JOB_RUNS_MIGRATION_0014: TenantMigrationDefinition = {
  version: '0014',
  name: '0014_scheduler_job_runs_expand',
  description:
    'Create per-tenant job_runs table for daily scheduler and manual job execution tracking, advisory lock coordination, and once-per-local-day scheduled idempotency',
  tablesChanged: ['job_runs'],
  dependsOn: ['0013'],
  upSql: `
CREATE TABLE IF NOT EXISTS public.job_runs (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  local_date TEXT NOT NULL,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('scheduled', 'manual')),
  triggered_by_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ NULL,
  correlation_id TEXT NOT NULL,
  error_code TEXT NULL,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_runs_scheduled_once_per_day
  ON public.job_runs (tenant_id, job_key, local_date)
  WHERE status = 'succeeded' AND trigger_source = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_job_runs_tenant_job_date_status
  ON public.job_runs (tenant_id, job_key, local_date, status);
`.trim(),
  downSql: `
DROP INDEX IF EXISTS public.idx_job_runs_tenant_job_date_status;
DROP INDEX IF EXISTS public.idx_job_runs_scheduled_once_per_day;
DROP TABLE IF EXISTS public.job_runs;
`.trim(),
};

export const TRANSITIONAL_BRIDGES_CONTRACT_MIGRATION_0015: TenantMigrationDefinition = {
  version: '0015',
  name: '0015_transitional_bridges_contract',
  description:
    'Drops transitional people.employment_json column and matter_restriction_metadata table after S0-16 and S0-17b cut-overs (ADR 0028, R408).',
  tablesChanged: ['people', 'matter_restriction_metadata'],
  dependsOn: ['0014'],
  upSql: `
ALTER TABLE people DROP COLUMN IF EXISTS employment_json;
DROP TABLE IF EXISTS matter_restriction_metadata;
`.trim(),
  downSql: `
CREATE TABLE IF NOT EXISTS matter_restriction_metadata (
  tenant_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  is_restricted BOOLEAN NOT NULL DEFAULT FALSE,
  restricted_access_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, matter_id)
);

INSERT INTO matter_restriction_metadata (tenant_id, matter_id, is_restricted, restricted_access_user_ids, updated_at)
SELECT tenant_id, id, (is_staff_matter OR has_ethical_wall), restricted_access_user_ids_json, updated_at
FROM matters
ON CONFLICT (tenant_id, matter_id) DO UPDATE SET
  is_restricted = EXCLUDED.is_restricted,
  restricted_access_user_ids = EXCLUDED.restricted_access_user_ids,
  updated_at = EXCLUDED.updated_at;

ALTER TABLE people ADD COLUMN IF NOT EXISTS employment_json JSONB NULL;

UPDATE people p
SET employment_json = e.employment_json
FROM employee_employment_records e
WHERE p.tenant_id = e.tenant_id AND p.id = e.person_id;
`.trim(),
};

export const CORE_TENANT_MIGRATIONS: readonly TenantMigrationDefinition[] = [
  DOCUMENT_GENERATION_MIGRATION_0001,
  DOCUMENT_STORE_INTEGRATION_MIGRATION_0002,
  KEY_DATES_MIGRATION_0003,
  KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004,
  KEY_DATES_MATTER_RESTRICTIONS_MIGRATION_0005,
  DOCUMENT_GENERATION_TENANT_CONFIG_MIGRATION_0006,
  FIRM_AUDIT_LOG_MIGRATION_0007,
  NON_LIVE_AUDIT_RESET_MIGRATION_0008,
  PARTIES_AND_MATTERS_MIGRATION_0009,
  INTAKE_QUOTES_TASKS_MIGRATION_0010,
  HR_TEAMS_AND_RBAC_MIGRATION_0011,
  CATALOGUES_AND_CONFIG_MIGRATION_0012,
  PMS_PER_TENANT_MIGRATION_0013,
  SCHEDULER_JOB_RUNS_MIGRATION_0014,
  TRANSITIONAL_BRIDGES_CONTRACT_MIGRATION_0015,
];

export function validateMigrationCatalogueOrder(
  migrations: readonly TenantMigrationDefinition[],
): void {
  const seenVersions = new Set<string>();
  for (const migration of migrations) {
    for (const depVersion of migration.dependsOn ?? []) {
      if (!seenVersions.has(depVersion)) {
        throw new Error(
          `MIGRATION_CATALOGUE_ORDER_ERROR: Migration "${migration.version}" declares dependsOn "${depVersion}", which does not appear earlier in the migration catalogue.`,
        );
      }
    }
    seenVersions.add(migration.version);
  }
}

validateMigrationCatalogueOrder(CORE_TENANT_MIGRATIONS);

export function computeMigrationChecksum(
  migration: TenantMigrationDefinition,
): string {
  return crypto
    .createHash('sha256')
    .update(
      `${migration.version}:${migration.name}:${migration.upSql}:${migration.downSql}`,
    )
    .digest('hex');
}

export class TenantMigrationRunner {

  private ensureContext(ctx: TenantContext): void {
    if (!ctx?.tenantId || !ctx?.postgresDatabaseName) {
      throw new Error(
        'TENANCY_MIGRATION_ERROR: Per-tenant migrations require a valid TenantContext.',
      );
    }
    assertValidPostgresTenantContext(ctx);
  }

  public async applyUp(
    ctx: TenantContext,
    migrations: readonly TenantMigrationDefinition[] = CORE_TENANT_MIGRATIONS,
  ): Promise<AppliedTenantMigrationRecord[]> {
    this.ensureContext(ctx);
    const tenantRoleName = resolveTenantPostgresRoleName(ctx);
    const tenantRoleIdent = quotePgIdentifier(tenantRoleName);
    const runtimeUser =
      process.env.PLATFORM_POSTGRES_RUNTIME_USER?.trim() || 'runtime_login';
    const runtimeIdent = quotePgIdentifier(runtimeUser);
    const migrateUser =
      process.env.PLATFORM_POSTGRES_MIGRATE_USER?.trim() || 'migrate_login';
    const migrateIdent = quotePgIdentifier(migrateUser);
    const dbIdent = quotePgIdentifier(ctx.postgresDatabaseName);

    const client = await createDirectMigrationClient({ ctx });

    try {
      // Ensure schema_migrations ledger & R402 baseline privileges under advisory transaction lock
      await client.query('BEGIN');
      try {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`onesquared_migrate:${ctx.tenantId}`],
        );
        await client.query(`REVOKE ALL ON DATABASE ${dbIdent} FROM PUBLIC`);
        await client.query(
          `GRANT CONNECT ON DATABASE ${dbIdent} TO ${runtimeIdent}, ${tenantRoleIdent}`,
        );
        await client.query(`REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC`);
        await client.query(`REVOKE ALL ON SCHEMA public FROM ${runtimeIdent}`);
        await client.query(`GRANT USAGE ON SCHEMA public TO ${tenantRoleIdent}`);
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrateIdent} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${tenantRoleIdent}`,
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrateIdent} IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, ${runtimeIdent}, ${tenantRoleIdent}`,
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrateIdent} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${tenantRoleIdent}`,
        );
        await client.query(`
          CREATE TABLE IF NOT EXISTS tenant_schema_migrations (
            tenant_id TEXT NOT NULL,
            database_name TEXT NOT NULL,
            version TEXT NOT NULL,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (tenant_id, version)
          )
        `);
        await client.query(
          `REVOKE ALL ON TABLE tenant_schema_migrations FROM PUBLIC, ${runtimeIdent}`,
        );
        await client.query(
          `GRANT SELECT ON TABLE tenant_schema_migrations TO ${tenantRoleIdent}`,
        );
        await client.query('COMMIT');
      } catch (initErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw sanitizePostgresError(initErr, 'migration.bootstrap');
      }

      const newlyApplied: AppliedTenantMigrationRecord[] = [];
      for (const migration of migrations) {
        const checksum = computeMigrationChecksum(migration);
        await client.query('BEGIN');
        try {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtext($1))',
            [`onesquared_migrate:${ctx.tenantId}`],
          );

          const existingRows = await client.query<{
            version: string;
            checksum: string;
          }>(
            'SELECT version, checksum FROM tenant_schema_migrations WHERE tenant_id = $1',
            [ctx.tenantId],
          );
          const appliedMap = new Map(
            existingRows.rows.map((r) => [r.version, r.checksum]),
          );

          if (appliedMap.has(migration.version)) {
            const recordedChecksum = appliedMap.get(migration.version);
            if (
              recordedChecksum !== checksum &&
              !(migration.acceptedPriorChecksums ?? []).includes(
                recordedChecksum ?? '',
              )
            ) {
              const mismatchErr = new Error(
                `TENANCY_MIGRATION_CHECKSUM_MISMATCH: Migration ${migration.version} was modified after being applied to ${ctx.postgresDatabaseName}.`,
              ) as Error & { code: string };
              mismatchErr.code = 'TENANCY_MIGRATION_CHECKSUM_MISMATCH';
              throw mismatchErr;
            }
            await client.query('COMMIT');
            continue;
          }

          const missingDeps = (migration.dependsOn ?? []).filter(
            (depVersion) => !appliedMap.has(depVersion),
          );
          if (missingDeps.length > 0) {
            throw new Error(
              `MIGRATION_DEPENDENCY_ERROR: Cannot apply migration "${migration.version}" before prerequisite migration(s) ${missingDeps.map((d) => `"${d}"`).join(', ')} are applied.`,
            );
          }

          await client.query(migration.upSql);

          await client.query(
            `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, ${runtimeIdent}`,
          );
          await client.query(
            `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, ${runtimeIdent}`,
          );
          await client.query(
            `GRANT SELECT ON TABLE tenant_schema_migrations TO ${tenantRoleIdent}`,
          );

          for (const tableName of migration.tablesChanged) {
            const tableIdent = quotePgIdentifier(tableName);
            const tableExists = await client.query(
              `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
              [tableName],
            );
            if (tableExists.rowCount && tableExists.rowCount > 0) {
              if (tableName === 'audit_entries') {
                await client.query(
                  `REVOKE ALL ON TABLE ${tableIdent} FROM ${tenantRoleIdent}`,
                );
                await client.query(
                  `GRANT SELECT, INSERT ON TABLE ${tableIdent} TO ${tenantRoleIdent}`,
                );
              } else {
                await client.query(
                  `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${tableIdent} TO ${tenantRoleIdent}`,
                );
              }
            }
          }
          await client.query(
            `REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public FROM ${tenantRoleIdent}`,
          );
          await client.query(
            `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${tenantRoleIdent}`,
          );
          const auditSeqCheck = await client.query(
            `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tenant_audit_id_seq' AND c.relkind = 'S'`,
          );
          if (auditSeqCheck.rowCount && auditSeqCheck.rowCount > 0) {
            await client.query(
              `GRANT UPDATE ON SEQUENCE public.tenant_audit_id_seq TO ${tenantRoleIdent}`,
            );
          }

          const appliedAt = new Date().toISOString();
          await client.query(
            `INSERT INTO tenant_schema_migrations (tenant_id, database_name, version, name, checksum, applied_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              ctx.tenantId,
              ctx.postgresDatabaseName,
              migration.version,
              migration.name,
              checksum,
              appliedAt,
            ],
          );
          await client.query('COMMIT');

          newlyApplied.push(
            Object.freeze({
              tenantId: ctx.tenantId,
              databaseName: ctx.postgresDatabaseName,
              version: migration.version,
              name: migration.name,
              checksum,
              appliedAt,
            }),
          );
        } catch (migErr) {
          await client.query('ROLLBACK').catch(() => {});
          throw sanitizePostgresError(migErr, `migration.applyUp:${migration.version}`);
        }
      }

      invalidateGlobalTenantSchemaReadiness(ctx.postgresDatabaseName);
      return newlyApplied;
    } finally {
      await client.end().catch(() => {});
    }
  }

  public async rollbackVersion(
    ctx: TenantContext,
    version: string,
    migrations: readonly TenantMigrationDefinition[] = CORE_TENANT_MIGRATIONS,
  ): Promise<boolean> {
    this.ensureContext(ctx);
    const client = await createDirectMigrationClient({ ctx });

    try {
      await client.query('BEGIN');
      try {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`onesquared_migrate:${ctx.tenantId}`],
        );

        const tableCheck = await client.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tenant_schema_migrations'`,
        );
        if (!tableCheck.rowCount) {
          await client.query('COMMIT');
          return false;
        }

        const appliedRes = await client.query<{ version: string }>(
          'SELECT version FROM tenant_schema_migrations WHERE tenant_id = $1',
          [ctx.tenantId],
        );
        const appliedVersions = new Set(appliedRes.rows.map((r) => r.version));

        const combinedByVersion = new Map<string, TenantMigrationDefinition>();
        for (const m of CORE_TENANT_MIGRATIONS) {
          combinedByVersion.set(m.version, m);
        }
        for (const m of migrations) {
          combinedByVersion.set(m.version, m);
        }
        const allKnownMigrations = Array.from(combinedByVersion.values());

        const definition =
          migrations.find((m) => m.version === version || m.name === version) ??
          allKnownMigrations.find(
            (m) => m.version === version || m.name === version,
          );
        const targetVersion = definition?.version ?? version;
        if (!appliedVersions.has(targetVersion)) {
          await client.query('COMMIT');
          return false;
        }

        const dependants = allKnownMigrations.filter(
          (m) =>
            appliedVersions.has(m.version) &&
            (m.dependsOn ?? []).includes(targetVersion),
        );
        if (dependants.length > 0) {
          throw new Error(
            `MIGRATION_ROLLBACK_ORDER_ERROR: Cannot roll back "${targetVersion}" while ${dependants.map((d) => `"${d.version}"`).join(', ')} still depend on it.`,
          );
        }

        if (!definition || !definition.downSql.trim()) {
          throw new Error(
            `TENANCY_MIGRATION_ERROR: Migration ${version} does not define a reversible downSql script.`,
          );
        }

        await client.query(definition.downSql);

        const tenantRoleName = resolveTenantPostgresRoleName(ctx);
        const tenantRoleIdent = quotePgIdentifier(tenantRoleName);
        const runtimeUser =
          process.env.PLATFORM_POSTGRES_RUNTIME_USER?.trim() || 'runtime_login';
        const runtimeIdent = quotePgIdentifier(runtimeUser);
        for (const tableName of definition.tablesChanged) {
          const tableIdent = quotePgIdentifier(tableName);
          const tableExists = await client.query(
            `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
            [tableName],
          );
          if (tableExists.rowCount && tableExists.rowCount > 0) {
            await client.query(
              `REVOKE ALL ON TABLE ${tableIdent} FROM PUBLIC, ${runtimeIdent}`,
            );
            if (tableName === 'audit_entries') {
              await client.query(
                `REVOKE ALL ON TABLE ${tableIdent} FROM ${tenantRoleIdent}`,
              );
              await client.query(
                `GRANT SELECT, INSERT ON TABLE ${tableIdent} TO ${tenantRoleIdent}`,
              );
            } else {
              await client.query(
                `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${tableIdent} TO ${tenantRoleIdent}`,
              );
            }
          }
        }

        await client.query(
          'DELETE FROM tenant_schema_migrations WHERE tenant_id = $1 AND version = $2',
          [ctx.tenantId, targetVersion],
        );
        await client.query('COMMIT');
        invalidateGlobalTenantSchemaReadiness(ctx.postgresDatabaseName);
        return true;
      } catch (rbErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw sanitizePostgresError(rbErr, `migration.rollback:${version}`);
      }
    } finally {
      await client.end().catch(() => {});
    }
  }

  public async listAppliedMigrations(
    ctx: TenantContext,
  ): Promise<AppliedTenantMigrationRecord[]> {
    this.ensureContext(ctx);
    const client = await createDirectMigrationClient({ ctx });
    try {
      const tableCheck = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tenant_schema_migrations'`,
      );
      if (!tableCheck.rowCount) {
        return [];
      }
      const res = await client.query<{
        tenant_id: string;
        database_name: string;
        version: string;
        name: string;
        checksum: string;
        applied_at: Date | string;
      }>(
        `SELECT tenant_id, database_name, version, name, checksum, applied_at
         FROM tenant_schema_migrations
         WHERE tenant_id = $1
         ORDER BY version ASC`,
        [ctx.tenantId],
      );
      return res.rows.map((r) =>
        Object.freeze({
          tenantId: r.tenant_id,
          databaseName: r.database_name,
          version: r.version,
          name: r.name,
          checksum: r.checksum,
          appliedAt: toIsoString(r.applied_at),
        }),
      );
    } finally {
      await client.end().catch(() => {});
    }
  }

  public async getActiveTables(ctx: TenantContext): Promise<string[]> {
    this.ensureContext(ctx);
    const client = await createDirectMigrationClient({ ctx });
    try {
      const res = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name ASC`,
      );
      return res.rows.map((r) => r.table_name);
    } finally {
      await client.end().catch(() => {});
    }
  }
}