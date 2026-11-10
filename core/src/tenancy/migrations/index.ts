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

export const CORE_TENANT_MIGRATIONS: readonly TenantMigrationDefinition[] = [
  DOCUMENT_GENERATION_MIGRATION_0001,
  DOCUMENT_STORE_INTEGRATION_MIGRATION_0002,
  KEY_DATES_MIGRATION_0003,
  KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004,
  KEY_DATES_MATTER_RESTRICTIONS_MIGRATION_0005,
  DOCUMENT_GENERATION_TENANT_CONFIG_MIGRATION_0006,
  FIRM_AUDIT_LOG_MIGRATION_0007,
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
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrateIdent} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${tenantRoleIdent}`,
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
              throw new Error(
                `TENANCY_MIGRATION_CHECKSUM_MISMATCH: Migration ${migration.version} was modified after being applied to ${ctx.postgresDatabaseName}.`,
              );
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
            `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${tenantRoleIdent}`,
          );

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