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

export interface TenantMigrationDefinition {
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly upSql: string;
  readonly downSql: string;
  readonly tablesChanged: readonly string[];
  readonly dependsOn?: readonly string[];
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

export const CORE_TENANT_MIGRATIONS: readonly TenantMigrationDefinition[] = [
  DOCUMENT_GENERATION_MIGRATION_0001,
  DOCUMENT_STORE_INTEGRATION_MIGRATION_0002,
  KEY_DATES_MIGRATION_0003,
  KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004,
];

export function computeMigrationChecksum(migration: TenantMigrationDefinition): string {
  return crypto
    .createHash('sha256')
    .update(`${migration.version}:${migration.name}:${migration.upSql}:${migration.downSql}`)
    .digest('hex');
}

export class TenantMigrationRunner {
  private readonly appliedByDatabase = new Map<
    string,
    Map<string, AppliedTenantMigrationRecord>
  >();
  private readonly activeTablesByDatabase = new Map<string, Set<string>>();

  private ensureContext(ctx: TenantContext): void {
    if (!ctx?.tenantId || !ctx?.postgresDatabaseName) {
      throw new Error(
        'TENANCY_MIGRATION_ERROR: Per-tenant migrations require a valid TenantContext.',
      );
    }
  }

  public applyUp(
    ctx: TenantContext,
    migrations: readonly TenantMigrationDefinition[] = CORE_TENANT_MIGRATIONS,
  ): AppliedTenantMigrationRecord[] {
    this.ensureContext(ctx);
    let dbMigrations = this.appliedByDatabase.get(ctx.postgresDatabaseName);
    if (!dbMigrations) {
      dbMigrations = new Map<string, AppliedTenantMigrationRecord>();
      this.appliedByDatabase.set(ctx.postgresDatabaseName, dbMigrations);
    }

    let tables = this.activeTablesByDatabase.get(ctx.postgresDatabaseName);
    if (!tables) {
      tables = new Set<string>(['tenant_schema_migrations']);
      this.activeTablesByDatabase.set(ctx.postgresDatabaseName, tables);
    }

    const newlyApplied: AppliedTenantMigrationRecord[] = [];
    for (const migration of migrations) {
      const checksum = computeMigrationChecksum(migration);
      const existing = dbMigrations.get(migration.version);
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(
            `TENANCY_MIGRATION_CHECKSUM_MISMATCH: Migration ${migration.version} was modified after being applied to ${ctx.postgresDatabaseName}.`,
          );
        }
        continue;
      }

      const missingDeps = (migration.dependsOn ?? []).filter(
        (depVersion) => !dbMigrations.has(depVersion),
      );
      if (missingDeps.length > 0) {
        throw new Error(
          `MIGRATION_DEPENDENCY_ERROR: Cannot apply migration "${migration.version}" before prerequisite migration(s) ${missingDeps.map((d) => `"${d}"`).join(', ')} are applied.`,
        );
      }

      for (const table of migration.tablesChanged) {
        tables.add(table);
      }

      const record: AppliedTenantMigrationRecord = Object.freeze({
        tenantId: ctx.tenantId,
        databaseName: ctx.postgresDatabaseName,
        version: migration.version,
        name: migration.name,
        checksum,
        appliedAt: new Date().toISOString(),
      });
      dbMigrations.set(migration.version, record);
      newlyApplied.push(record);
    }

    return newlyApplied;
  }

  public rollbackVersion(
    ctx: TenantContext,
    version: string,
    migrations: readonly TenantMigrationDefinition[] = CORE_TENANT_MIGRATIONS,
  ): boolean {
    this.ensureContext(ctx);
    const dbMigrations = this.appliedByDatabase.get(ctx.postgresDatabaseName);
    const tables = this.activeTablesByDatabase.get(ctx.postgresDatabaseName);
    if (!dbMigrations) {
      return false;
    }

    const targetIndex = migrations.findIndex(
      (m) => m.version === version || m.name === version,
    );
    const definition = targetIndex >= 0 ? migrations[targetIndex] : undefined;
    const targetVersion = definition?.version ?? version;
    if (!dbMigrations.has(targetVersion)) {
      return false;
    }

    const dependants = migrations.filter(
      (m) =>
        dbMigrations.has(m.version) &&
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

    if (tables) {
      for (const table of definition.tablesChanged) {
        const dropRegex = new RegExp(
          `DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${table}\\b`,
          'i',
        );
        if (dropRegex.test(definition.downSql)) {
          tables.delete(table);
        }
      }
    }
    dbMigrations.delete(targetVersion);
    return true;
  }

  public listAppliedMigrations(
    ctx: TenantContext,
  ): AppliedTenantMigrationRecord[] {
    this.ensureContext(ctx);
    const dbMigrations = this.appliedByDatabase.get(ctx.postgresDatabaseName);
    if (!dbMigrations) return [];
    return Array.from(dbMigrations.values()).filter(
      (m) => m.tenantId === ctx.tenantId,
    );
  }

  public getActiveTables(ctx: TenantContext): string[] {
    this.ensureContext(ctx);
    return Array.from(
      this.activeTablesByDatabase.get(ctx.postgresDatabaseName) ?? [],
    );
  }
}
