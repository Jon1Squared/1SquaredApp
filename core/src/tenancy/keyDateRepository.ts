/**
 * Tenant-Scoped Key Dates PostgreSQL Repository (`core/src/tenancy/keyDateRepository.ts`).
 *
 * Rules enforced (ADR 0028 & Platform Architecture Standard §8 & §9, Owner Decision 6, R401):
 * 1. All reads and writes execute against the tenant's dedicated PostgreSQL database inside an explicit
 *    transaction starting with `SET LOCAL ROLE <tenant_role>` (`TenantScopedRepository`).
 * 2. Key dates are never deleted in normal operation (updates increment `version`; edits to confirmed dates
 *    create a superseding record).
 * 3. Restricted (staff / ethical-wall) matters: entries are returned ONLY if `public.matters` marks the matter
 *    unrestricted (`NOT (is_staff_matter OR has_ethical_wall)`) OR `restricted_access_user_ids_json` contains
 *    `viewerId`. Otherwise omitted completely at the data layer.
 */

import type {
  KeyDate,
  KeyDateAuditAction,
  KeyDateCalendarSync,
  KeyDateId,
  KeyDateNotApplicable,
  KeyDateReminderState,
  KeyDatesConfiguration,
  KeyDateTypeId,
  PersonId,
  TeamDiaryQuery,
  TenantContext,
} from '../api/index';
import {
  hasActiveTenantTransaction,
  TenantScopedRepository,
  toIsoString,

  type TenantSqlClient,
} from './tenantScopedRepository';

export interface MatterRestrictionMetadata {
  matterId: string;
  isRestricted: boolean;
  restrictedAccessUserIds: readonly string[];
}

export interface KeyDateAuditEventRecord {
  id: string;
  action: KeyDateAuditAction;
  keyDateId?: KeyDateId;
  matterId?: string;
  enquiryId?: string;
  actorId: PersonId;
  occurredAt: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  correlationId: string;
}

interface DbMatterRestrictionFromMattersRow {
  tenant_id: string;
  id: string;
  is_staff_matter: boolean;
  has_ethical_wall: boolean;
  restricted_access_user_ids_json: string[];
}

interface DbKeyDateRow {
  id: string;
  tenant_id: string;
  matter_id: string | null;
  enquiry_id: string | null;
  key_date_type_id: string;
  category: KeyDate['category'];
  title: string;
  due_date: string;
  due_time: string | null;
  is_critical: boolean;
  status: KeyDate['status'];
  source: KeyDate['source'];
  team_id: string;
  responsible_person_ids: string[];
  calculation_json: KeyDate['calculation'] | null;
  verification_json: KeyDate['verification'];
  outcome_json: KeyDate['outcome'] | null;
  supersedes_key_date_id: string | null;
  superseded_by_key_date_id: string | null;
  notes: string | null;
  source_document_id: string | null;
  created_by_id: string;
  created_at: Date | string;
  updated_by_id: string;
  updated_at: Date | string;
  version: number;
}

interface DbNotApplicableRow {
  id: string;
  tenant_id: string;
  matter_id: string;
  key_date_type_id: string;
  reason: string;
  recorded_by_id: string;
  recorded_at: Date | string;
}

interface DbReminderStateRow {
  id: string;
  tenant_id: string;
  key_date_id: string;
  task_id: string;
  idempotency_key: string;
  reminder_schedule_id: string;
  current_stage_days_before: number;
  stage_entered_at: Date | string;
  acknowledged_by_id: string | null;
  acknowledged_at: Date | string | null;
  escalation_level: number;
  last_notified_at: Date | string | null;
  last_skipped_reason: KeyDateReminderState['lastSkippedReason'] | null;
}

interface DbCalendarSyncRow {
  id: string;
  tenant_id: string;
  key_date_id: string;
  state: KeyDateCalendarSync['state'];
  external_events_json: KeyDateCalendarSync['externalEvents'];
  last_synced_at: Date | string | null;
  last_error: string | null;
  attempts: number;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
}

interface DbKeyDateAuditRow {
  id: string;
  tenant_id: string;
  action: KeyDateAuditAction;
  key_date_id: string | null;
  matter_id: string | null;
  enquiry_id: string | null;
  actor_id: string;
  occurred_at: Date | string;
  reason: string | null;
  before_json: unknown;
  after_json: unknown;
  correlation_id: string;
}

function mapCalendarSyncRow(row: DbCalendarSyncRow): KeyDateCalendarSync {
  return {
    keyDateId: row.key_date_id,
    state: row.state,
    externalEvents: Array.isArray(row.external_events_json)
      ? row.external_events_json.map((e) => ({ ...e }))
      : [],
    ...(row.last_synced_at !== null
      ? { lastSyncedAt: toIsoString(row.last_synced_at) }
      : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    attempts: Number(row.attempts),
    ...(row.lease_token !== null ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at !== null
      ? { leaseExpiresAt: toIsoString(row.lease_expires_at) }
      : {}),
  };
}

function mapKeyDateRow(row: DbKeyDateRow): KeyDate {
  return {
    id: row.id,
    ...(row.matter_id !== null ? { matterId: row.matter_id } : {}),
    ...(row.enquiry_id !== null ? { enquiryId: row.enquiry_id } : {}),
    keyDateTypeId: row.key_date_type_id,
    category: row.category,
    title: row.title,
    dueDate: String(row.due_date).slice(0, 10),
    ...(row.due_time !== null ? { dueTime: row.due_time } : {}),
    isCritical: Boolean(row.is_critical),
    status: row.status,
    source: row.source,
    teamId: row.team_id,
    responsiblePersonIds: Array.isArray(row.responsible_person_ids)
      ? [...row.responsible_person_ids]
      : [],
    ...(row.calculation_json !== null
      ? { calculation: structuredClone(row.calculation_json) }
      : {}),
    verification: structuredClone(row.verification_json),
    ...(row.outcome_json !== null
      ? { outcome: structuredClone(row.outcome_json) }
      : {}),
    ...(row.supersedes_key_date_id !== null
      ? { supersedesKeyDateId: row.supersedes_key_date_id }
      : {}),
    ...(row.superseded_by_key_date_id !== null
      ? { supersededByKeyDateId: row.superseded_by_key_date_id }
      : {}),
    ...(row.notes !== null ? { notes: row.notes } : {}),
    ...(row.source_document_id !== null
      ? { sourceDocumentId: row.source_document_id }
      : {}),
    createdById: row.created_by_id,
    createdAt: toIsoString(row.created_at),
    updatedById: row.updated_by_id,
    updatedAt: toIsoString(row.updated_at),
    version: Number(row.version),
  };
}

function mapReminderStateRow(row: DbReminderStateRow): KeyDateReminderState {
  return {
    keyDateId: row.key_date_id,
    taskId: row.task_id,
    idempotencyKey: row.idempotency_key,
    reminderScheduleId: row.reminder_schedule_id,
    currentStageDaysBefore: Number(row.current_stage_days_before),
    stageEnteredAt: toIsoString(row.stage_entered_at),
    ...(row.acknowledged_by_id !== null
      ? { acknowledgedById: row.acknowledged_by_id }
      : {}),
    ...(row.acknowledged_at !== null
      ? { acknowledgedAt: toIsoString(row.acknowledged_at) }
      : {}),
    escalationLevel: Number(row.escalation_level),
    ...(row.last_notified_at !== null
      ? { lastNotifiedAt: toIsoString(row.last_notified_at) }
      : {}),
    ...(row.last_skipped_reason !== null
      ? { lastSkippedReason: row.last_skipped_reason }
      : {}),
  };
}

export class TenantKeyDateRepository extends TenantScopedRepository {
  // ============================================================================
  // Tenant Key Dates Config Override (`key_dates_tenant_configs`, 0005)
  // ============================================================================

  public async getKeyDatesTenantConfig(
    ctx: TenantContext,
  ): Promise<KeyDatesConfiguration | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        config_json: KeyDatesConfiguration;
      }>(
        'SELECT tenant_id, config_json FROM key_dates_tenant_configs WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'KeyDatesTenantConfig');
      return structuredClone(row.config_json);
    });
  }

  public async ensureAndLockKeyDatesTenantConfig(
    ctx: TenantContext,
    defaultConfig: KeyDatesConfiguration,
    updatedById?: string,
  ): Promise<KeyDatesConfiguration> {
    if (!hasActiveTenantTransaction(ctx)) {
      const txErr = new Error(
        'KEY_DATE_TRANSACTION_REQUIRED: ensureAndLockKeyDatesTenantConfig must run inside an active write transaction.',
      ) as Error & { code?: string };
      txErr.code = 'KEY_DATE_TRANSACTION_REQUIRED';
      throw txErr;
    }
    return this.withTenantTransaction(ctx, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `onesquared_keydates_config:${ctx.tenantId}`,
      ]);
      await tx.query(
        `INSERT INTO key_dates_tenant_configs (tenant_id, config_json, updated_by_id, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (tenant_id) DO NOTHING`,
        [ctx.tenantId, JSON.stringify(defaultConfig), updatedById ?? ctx.actorId],
      );
      const res = await tx.query<{
        tenant_id: string;
        config_json: KeyDatesConfiguration;
      }>(
        'SELECT tenant_id, config_json FROM key_dates_tenant_configs WHERE tenant_id = $1 FOR UPDATE',
        [ctx.tenantId],
      );
      const row = res.rows[0]!;
      this.assertRowTenant(ctx, row.tenant_id, 'KeyDatesTenantConfig');
      return structuredClone(row.config_json);
    });
  }

  public async acquireKeyDateTypeScopeLock(
    ctx: TenantContext,
    scopeKey: string,
    keyDateTypeId: string,
  ): Promise<void> {
    if (!hasActiveTenantTransaction(ctx)) {
      const txErr = new Error(
        'KEY_DATE_TRANSACTION_REQUIRED: acquireKeyDateTypeScopeLock must run inside an active write transaction.',
      ) as Error & { code?: string };
      txErr.code = 'KEY_DATE_TRANSACTION_REQUIRED';
      throw txErr;
    }
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `onesquared_keydate_na:${ctx.tenantId}:${scopeKey}:${keyDateTypeId}`,
      ]);
    });
  }

  public async getKeyDateScopeSummary(
    ctx: TenantContext,
    keyDateId: KeyDateId,
  ): Promise<{
    matterId?: string;
    enquiryId?: string;
    keyDateTypeId: string;
  } | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        matter_id: string | null;
        enquiry_id: string | null;
        key_date_type_id: string;
      }>(
        'SELECT tenant_id, matter_id, enquiry_id, key_date_type_id FROM key_dates WHERE id = $1 AND tenant_id = $2',
        [keyDateId, ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'KeyDate');
      return {
        ...(row.matter_id !== null ? { matterId: row.matter_id } : {}),
        ...(row.enquiry_id !== null ? { enquiryId: row.enquiry_id } : {}),
        keyDateTypeId: row.key_date_type_id,
      };
    });
  }

  public async putKeyDatesTenantConfig(
    ctx: TenantContext,
    config: KeyDatesConfiguration | null,
    updatedById?: string,
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      if (config === null) {
        await tx.query(
          'DELETE FROM key_dates_tenant_configs WHERE tenant_id = $1',
          [ctx.tenantId],
        );
        return;
      }
      await tx.query(
        `INSERT INTO key_dates_tenant_configs (tenant_id, config_json, updated_by_id, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET
           config_json = EXCLUDED.config_json,
           updated_by_id = EXCLUDED.updated_by_id,
           updated_at = NOW()`,
        [ctx.tenantId, JSON.stringify(config), updatedById ?? ctx.actorId],
      );
    });
  }

  // ============================================================================
  // Matter Restriction Resolution via `public.matters` (0009, R408, R417)
  // ============================================================================

  private async checkMatterVisibleInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    matterId: string | undefined,
    viewerId: string,
  ): Promise<boolean> {
    if (!matterId) return true;
    const res = await tx.query<DbMatterRestrictionFromMattersRow>(
      `SELECT tenant_id, id, is_staff_matter, has_ethical_wall, restricted_access_user_ids_json
       FROM matters
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, matterId],
    );
    const row = res.rows[0];
    if (!row) return false;
    this.assertRowTenant(ctx, row.tenant_id, 'Matter');
    const allowIds = Array.isArray(row.restricted_access_user_ids_json)
      ? row.restricted_access_user_ids_json
      : [];
    const isRestricted =
      Boolean(row.is_staff_matter) ||
      Boolean(row.has_ethical_wall) ||
      allowIds.length > 0;
    if (!isRestricted) return true;
    return allowIds.includes(viewerId);
  }

  public async setMatterRestriction(
    ctx: TenantContext,
    metadata: MatterRestrictionMetadata,
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      const restrictedIds = [...metadata.restrictedAccessUserIds];
      const isRestricted = Boolean(metadata.isRestricted);
      await tx.query(
        `INSERT INTO public.matters (
           tenant_id, id, row_version, matter_number, title,
           client_type, client_id, is_staff_matter, has_ethical_wall,
           restricted_access_user_ids_json, created_at, updated_at
         ) VALUES (
           $1, $2, 1, 'DRAFT', $2,
           'organisation', 'O-KEYDATE-STUB', $3, FALSE,
           $4::jsonb, NOW(), NOW()
         )
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           is_staff_matter = CASE
             WHEN public.matters.client_id = 'O-KEYDATE-STUB' THEN EXCLUDED.is_staff_matter
             WHEN EXCLUDED.is_staff_matter = FALSE THEN FALSE
             WHEN public.matters.has_ethical_wall = TRUE THEN public.matters.is_staff_matter
             ELSE TRUE
           END,
           has_ethical_wall = CASE
             WHEN public.matters.client_id = 'O-KEYDATE-STUB' THEN FALSE
             WHEN EXCLUDED.is_staff_matter = FALSE THEN FALSE
             ELSE public.matters.has_ethical_wall
           END,
           restricted_access_user_ids_json = EXCLUDED.restricted_access_user_ids_json,
           updated_at = NOW()`,
        [
          ctx.tenantId,
          metadata.matterId,
          isRestricted,
          JSON.stringify(restrictedIds),
        ],
      );
    });
  }

  public async isMatterVisibleToViewer(
    ctx: TenantContext,
    matterId: string | undefined,
    viewerId: string = ctx.actorId,
  ): Promise<boolean> {
    if (!matterId) return true;
    return this.withTenantReadTransaction(ctx, (tx) =>
      this.checkMatterVisibleInTx(tx, ctx, matterId, viewerId),
    );
  }

  public async isMatterRestricted(
    ctx: TenantContext,
    matterId: string | undefined,
  ): Promise<boolean> {
    if (!matterId) return false;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbMatterRestrictionFromMattersRow>(
        `SELECT tenant_id, id, is_staff_matter, has_ethical_wall, restricted_access_user_ids_json
         FROM matters
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, matterId],
      );
      const row = res.rows[0];
      if (!row) return false;
      this.assertRowTenant(ctx, row.tenant_id, 'Matter');
      const allowIds = Array.isArray(row.restricted_access_user_ids_json)
        ? row.restricted_access_user_ids_json
        : [];
      return (
        Boolean(row.is_staff_matter) ||
        Boolean(row.has_ethical_wall) ||
        allowIds.length > 0
      );
    });
  }

  // ============================================================================
  // Key Dates (Never deleted in normal operation)
  // ============================================================================

  public async allocateNextKeyDateId(ctx: TenantContext): Promise<string> {
    const ids = await this.allocateNextKeyDateIds(ctx, 1);
    return ids[0]!;
  }

  public async allocateNextKeyDateIds(
    ctx: TenantContext,
    count: number,
  ): Promise<string[]> {
    const n = Math.max(0, Math.floor(count));
    if (n === 0) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const maxRes = await tx.query<{ max_id: string | number }>(
        `SELECT COALESCE(
           MAX(CASE WHEN id ~ '^KD-[0-9]+$' THEN SUBSTRING(id FROM 4)::bigint ELSE 0 END),
           0
         )::bigint AS max_id
         FROM key_dates
         WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
      const maxExisting = Number(maxRes.rows[0]?.max_id ?? 0);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        let val = 0;
        do {
          const res = await tx.query<{ seq_val: string | number }>(
            "SELECT nextval('public.tenant_key_date_id_seq')::bigint AS seq_val",
          );
          val = Number(res.rows[0]?.seq_val ?? 1);
        } while (val <= maxExisting);
        ids.push(`KD-${String(val).padStart(6, '0')}`);
      }
      return ids;
    });
  }

  public async putKeyDate(
    ctx: TenantContext,
    keyDate: KeyDate,
    options: { expectedVersion: number | null },
  ): Promise<KeyDate> {
    const expectedVersion = options?.expectedVersion;
    const validExpectedVersion =
      options !== null &&
      options !== undefined &&
      typeof options === 'object' &&
      (expectedVersion === null ||
        (typeof expectedVersion === 'number' &&
          Number.isInteger(expectedVersion) &&
          expectedVersion >= 1));
    if (!validExpectedVersion) {
      throw new Error(
        'KEY_DATE_VALIDATION_ERROR: putKeyDate requires explicit options.expectedVersion (null for insert or positive integer version for update).',
      );
    }
    if (
      (keyDate.matterId && keyDate.enquiryId) ||
      (!keyDate.matterId && !keyDate.enquiryId)
    ) {
      throw new Error(
        'KEY_DATE_ENTITY_ERROR: Exactly one of matterId or enquiryId must be set on a KeyDate.',
      );
    }
    if (!keyDate.teamId) {
      throw new Error('KEY_DATE_VALIDATION_ERROR: teamId is required.');
    }
    if (
      !Array.isArray(keyDate.responsiblePersonIds) ||
      keyDate.responsiblePersonIds.length === 0
    ) {
      throw new Error(
        'KEY_DATE_VALIDATION_ERROR: responsiblePersonIds must contain at least one person.',
      );
    }

    return this.withTenantTransaction(ctx, async (tx) => {
      if (
        keyDate.matterId &&
        !(await this.checkMatterVisibleInTx(
          tx,
          ctx,
          keyDate.matterId,
          ctx.actorId,
        ))
      ) {
        throw new Error(
          `KEY_DATE_ACCESS_DENIED: Viewer "${ctx.actorId}" is not permitted to write key dates for matter "${keyDate.matterId}".`,
        );
      }

      const existingRes = await tx.query<DbKeyDateRow>(
        'SELECT * FROM key_dates WHERE id = $1 FOR UPDATE',
        [keyDate.id],
      );
      const existing = existingRes.rows[0];
      if (existing) {
        this.assertRowTenant(ctx, existing.tenant_id, 'KeyDate');
        if (
          existing.matter_id &&
          existing.matter_id !== keyDate.matterId &&
          !(await this.checkMatterVisibleInTx(
            tx,
            ctx,
            existing.matter_id,
            ctx.actorId,
          ))
        ) {
          throw new Error(
            `KEY_DATE_ACCESS_DENIED: Viewer "${ctx.actorId}" is not permitted to write key dates for matter "${existing.matter_id}".`,
          );
        }
        const entityChanged =
          (existing.matter_id ?? undefined) !==
            (keyDate.matterId ?? undefined) ||
          (existing.enquiry_id ?? undefined) !==
            (keyDate.enquiryId ?? undefined);
        const isCarriedFromEnquiryConversion =
          existing.enquiry_id !== null &&
          existing.matter_id === null &&
          Boolean(keyDate.matterId) &&
          !keyDate.enquiryId &&
          keyDate.source === 'carried_from_enquiry';
        if (entityChanged && !isCarriedFromEnquiryConversion) {
          throw new Error(
            'KEY_DATE_ENTITY_IMMUTABLE: Cannot change matterId or enquiryId on an existing KeyDate.',
          );
        }
        if (expectedVersion === null) {
          const conflictErr = new Error(
            `KEY_DATE_CONCURRENCY_CONFLICT: KeyDate "${keyDate.id}" already exists (version ${existing.version}).`,
          ) as Error & { code: string };
          conflictErr.code = 'KEY_DATE_CONCURRENCY_CONFLICT';
          throw conflictErr;
        }
        if (typeof expectedVersion === 'number') {
          if (Number(existing.version) !== expectedVersion) {
            const conflictErr = new Error(
              `KEY_DATE_CONCURRENCY_CONFLICT: KeyDate "${keyDate.id}" was modified concurrently (expected version ${expectedVersion}, found ${existing.version}).`,
            ) as Error & { code: string };
            conflictErr.code = 'KEY_DATE_CONCURRENCY_CONFLICT';
            throw conflictErr;
          }
        }
      } else if (typeof expectedVersion === 'number') {
        const conflictErr = new Error(
          `KEY_DATE_CONCURRENCY_CONFLICT: KeyDate "${keyDate.id}" no longer exists (expected version ${expectedVersion}).`,
        ) as Error & { code: string };
        conflictErr.code = 'KEY_DATE_CONCURRENCY_CONFLICT';
        throw conflictErr;
      }

      const res = await tx.query<DbKeyDateRow>(
        `INSERT INTO key_dates (
           id, tenant_id, matter_id, enquiry_id, key_date_type_id, category,
           title, due_date, due_time, is_critical, status, source, team_id,
           responsible_person_ids, calculation_json, verification_json, outcome_json,
           supersedes_key_date_id, superseded_by_key_date_id, notes, source_document_id,
           created_by_id, created_at, updated_by_id, updated_at, version
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,
           $14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25,1
         )
         ON CONFLICT (id) DO UPDATE SET
           matter_id = EXCLUDED.matter_id,
           enquiry_id = EXCLUDED.enquiry_id,
           key_date_type_id = EXCLUDED.key_date_type_id,
           category = EXCLUDED.category,
           title = EXCLUDED.title,
           due_date = EXCLUDED.due_date,
           due_time = EXCLUDED.due_time,
           is_critical = EXCLUDED.is_critical,
           status = EXCLUDED.status,
           source = EXCLUDED.source,
           team_id = EXCLUDED.team_id,
           responsible_person_ids = EXCLUDED.responsible_person_ids,
           calculation_json = EXCLUDED.calculation_json,
           verification_json = EXCLUDED.verification_json,
           outcome_json = EXCLUDED.outcome_json,
           supersedes_key_date_id = EXCLUDED.supersedes_key_date_id,
           superseded_by_key_date_id = EXCLUDED.superseded_by_key_date_id,
           notes = EXCLUDED.notes,
           source_document_id = EXCLUDED.source_document_id,
           updated_by_id = EXCLUDED.updated_by_id,
           updated_at = EXCLUDED.updated_at,
           version = public.key_dates.version + 1
         WHERE key_dates.tenant_id = $2
         RETURNING *`,
        [
          keyDate.id,
          ctx.tenantId,
          keyDate.matterId ?? null,
          keyDate.enquiryId ?? null,
          keyDate.keyDateTypeId,
          keyDate.category,
          keyDate.title,
          keyDate.dueDate,
          keyDate.dueTime ?? null,
          Boolean(keyDate.isCritical),
          keyDate.status,
          keyDate.source,
          keyDate.teamId,
          JSON.stringify(keyDate.responsiblePersonIds),
          keyDate.calculation ? JSON.stringify(keyDate.calculation) : null,
          JSON.stringify(keyDate.verification),
          keyDate.outcome ? JSON.stringify(keyDate.outcome) : null,
          keyDate.supersedesKeyDateId ?? null,
          keyDate.supersededByKeyDateId ?? null,
          keyDate.notes ?? null,
          keyDate.sourceDocumentId ?? null,
          keyDate.createdById,
          keyDate.createdAt,
          keyDate.updatedById,
          keyDate.updatedAt,
        ],
      );
      const saved = res.rows[0];
      if (!saved) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Cross-tenant KeyDate ID collision rejected.',
        );
      }
      this.assertRowTenant(ctx, saved.tenant_id, 'KeyDate');
      return mapKeyDateRow(saved);
    });
  }

  public async importKeyDates(
    ctx: TenantContext,
    keyDates: readonly KeyDate[],
  ): Promise<void> {
    if (keyDates.length === 0) return;
    await this.withTenantTransaction(ctx, async (tx) => {
      for (const kd of keyDates) {
        if (
          (kd.matterId && kd.enquiryId) ||
          (!kd.matterId && !kd.enquiryId)
        ) {
          throw new Error(
            'KEY_DATE_ENTITY_ERROR: Exactly one of matterId or enquiryId must be set on a KeyDate.',
          );
        }
        if (!kd.teamId) {
          throw new Error('KEY_DATE_VALIDATION_ERROR: teamId is required.');
        }
        if (
          !Array.isArray(kd.responsiblePersonIds) ||
          kd.responsiblePersonIds.length === 0
        ) {
          throw new Error(
            'KEY_DATE_VALIDATION_ERROR: responsiblePersonIds must contain at least one person.',
          );
        }
        const existingRes = await tx.query<{
          tenant_id: string;
          matter_id: string | null;
          enquiry_id: string | null;
        }>(
          'SELECT tenant_id, matter_id, enquiry_id FROM key_dates WHERE id = $1 FOR UPDATE',
          [kd.id],
        );
        const existing = existingRes.rows[0];
        if (existing) {
          this.assertRowTenant(ctx, existing.tenant_id, 'KeyDate');
          const entityChanged =
            (existing.matter_id ?? undefined) !== (kd.matterId ?? undefined) ||
            (existing.enquiry_id ?? undefined) !== (kd.enquiryId ?? undefined);
          if (entityChanged) {
            throw new Error(
              'KEY_DATE_ENTITY_IMMUTABLE: Cannot change matterId or enquiryId on an existing KeyDate.',
            );
          }
        }
        const res = await tx.query<{ tenant_id: string }>(
          `INSERT INTO key_dates (
             id, tenant_id, matter_id, enquiry_id, key_date_type_id, category,
             title, due_date, due_time, is_critical, status, source, team_id,
             responsible_person_ids, calculation_json, verification_json, outcome_json,
             supersedes_key_date_id, superseded_by_key_date_id, notes, source_document_id,
             created_by_id, created_at, updated_by_id, updated_at, version
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,
             $14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,NULL,NULL,$18,$19,$20,$21,$22,$23,$24
           )
           ON CONFLICT (id) DO UPDATE SET
             matter_id = EXCLUDED.matter_id,
             enquiry_id = EXCLUDED.enquiry_id,
             key_date_type_id = EXCLUDED.key_date_type_id,
             category = EXCLUDED.category,
             title = EXCLUDED.title,
             due_date = EXCLUDED.due_date,
             due_time = EXCLUDED.due_time,
             is_critical = EXCLUDED.is_critical,
             status = EXCLUDED.status,
             source = EXCLUDED.source,
             team_id = EXCLUDED.team_id,
             responsible_person_ids = EXCLUDED.responsible_person_ids,
             calculation_json = EXCLUDED.calculation_json,
             verification_json = EXCLUDED.verification_json,
             outcome_json = EXCLUDED.outcome_json,
             supersedes_key_date_id = NULL,
             superseded_by_key_date_id = NULL,
             notes = EXCLUDED.notes,
             source_document_id = EXCLUDED.source_document_id,
             updated_by_id = EXCLUDED.updated_by_id,
             updated_at = EXCLUDED.updated_at,
             version = EXCLUDED.version
           WHERE key_dates.tenant_id = $2
           RETURNING tenant_id`,
          [
            kd.id,
            ctx.tenantId,
            kd.matterId ?? null,
            kd.enquiryId ?? null,
            kd.keyDateTypeId,
            kd.category,
            kd.title,
            kd.dueDate,
            kd.dueTime ?? null,
            Boolean(kd.isCritical),
            kd.status,
            kd.source,
            kd.teamId,
            JSON.stringify(kd.responsiblePersonIds),
            kd.calculation ? JSON.stringify(kd.calculation) : null,
            JSON.stringify(kd.verification),
            kd.outcome ? JSON.stringify(kd.outcome) : null,
            kd.notes ?? null,
            kd.sourceDocumentId ?? null,
            kd.createdById,
            kd.createdAt,
            kd.updatedById,
            kd.updatedAt,
            Math.max(1, Math.trunc(kd.version || 1)),
          ],
        );
        if (!res.rows[0]) {
          throw new Error(
            'TENANCY_ISOLATION_ERROR: Cross-tenant KeyDate import ID collision rejected.',
          );
        }
        this.assertRowTenant(ctx, res.rows[0].tenant_id, 'KeyDate');
      }
      for (const kd of keyDates) {
        if (kd.supersedesKeyDateId || kd.supersededByKeyDateId) {
          await tx.query(
            `UPDATE key_dates
             SET supersedes_key_date_id = $1,
                 superseded_by_key_date_id = $2
             WHERE id = $3 AND tenant_id = $4`,
            [
              kd.supersedesKeyDateId ?? null,
              kd.supersededByKeyDateId ?? null,
              kd.id,
              ctx.tenantId,
            ],
          );
        }
      }
    });
  }

  public async listHiddenKeyDateIdsForMatters(
    ctx: TenantContext,
    hiddenMatterIds: ReadonlySet<string>,
  ): Promise<ReadonlySet<string>> {
    if (hiddenMatterIds.size === 0) {
      return new Set<string>();
    }
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string; id: string }>(
        `SELECT tenant_id, id
         FROM key_dates
         WHERE tenant_id = $1
           AND matter_id = ANY($2::text[])`,
        [ctx.tenantId, Array.from(hiddenMatterIds)],
      );
      const out = new Set<string>();
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'KeyDate');
        out.add(row.id);
      }
      return out;
    });
  }

  public async listKeyDatesForExceptionsReport(
    ctx: TenantContext,
    viewerId: string = ctx.actorId,
    options?: { includeMissingMatterOrphans?: boolean },
  ): Promise<KeyDate[]> {
    if (!options?.includeMissingMatterOrphans) {
      return this.listAllVisibleKeyDates(ctx, viewerId);
    }
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbKeyDateRow>(
        `SELECT kd.*
         FROM key_dates kd
         LEFT JOIN matters m
           ON m.tenant_id = kd.tenant_id AND m.id = kd.matter_id
         WHERE kd.tenant_id = $1
           AND (
             kd.matter_id IS NULL
             OR m.id IS NULL
             OR (
               m.is_staff_matter = FALSE
               AND m.has_ethical_wall = FALSE
               AND jsonb_array_length(COALESCE(m.restricted_access_user_ids_json, '[]'::jsonb)) = 0
             )
             OR m.restricted_access_user_ids_json ? $2
           )
         ORDER BY kd.due_date ASC, kd.id ASC`,
        [ctx.tenantId, viewerId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'KeyDate');
        return mapKeyDateRow(r);
      });
    });
  }

  public async getKeyDateById(
    ctx: TenantContext,
    id: KeyDateId,
    viewerId: string = ctx.actorId,
    options?: { includeRestricted?: boolean },
  ): Promise<KeyDate | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbKeyDateRow>(
        'SELECT * FROM key_dates WHERE id = $1 AND tenant_id = $2',
        [id, ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'KeyDate');
      if (
        !options?.includeRestricted &&
        row.matter_id &&
        !(await this.checkMatterVisibleInTx(tx, ctx, row.matter_id, viewerId))
      ) {
        return null;
      }
      return mapKeyDateRow(row);
    });
  }

  public async getKeyDateByIdForUpdate(
    ctx: TenantContext,
    id: KeyDateId,
    viewerId: string = ctx.actorId,
    options?: { includeRestricted?: boolean },
  ): Promise<KeyDate | null> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbKeyDateRow>(
        'SELECT * FROM key_dates WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [id, ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'KeyDate');
      if (
        !options?.includeRestricted &&
        row.matter_id &&
        !(await this.checkMatterVisibleInTx(tx, ctx, row.matter_id, viewerId))
      ) {
        return null;
      }
      return mapKeyDateRow(row);
    });
  }

  public async listKeyDatesForMatter(
    ctx: TenantContext,
    matterId: string,
    viewerId: string = ctx.actorId,
    options?: { forUpdate?: boolean; keyDateTypeId?: KeyDateTypeId },
  ): Promise<KeyDate[]> {
    const run = async (tx: TenantSqlClient): Promise<KeyDate[]> => {
      if (!(await this.checkMatterVisibleInTx(tx, ctx, matterId, viewerId))) {
        return [];
      }
      const clauses = ['tenant_id = $1', 'matter_id = $2'];
      const values: unknown[] = [ctx.tenantId, matterId];
      if (options?.keyDateTypeId) {
        values.push(options.keyDateTypeId);
        clauses.push(`key_date_type_id = $${values.length}`);
      }
      const res = await tx.query<DbKeyDateRow>(
        options?.forUpdate
          ? `SELECT * FROM key_dates WHERE ${clauses.join(' AND ')} ORDER BY id ASC FOR UPDATE`
          : `SELECT * FROM key_dates WHERE ${clauses.join(' AND ')} ORDER BY due_date ASC, id ASC`,
        values,
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'KeyDate');
        return mapKeyDateRow(r);
      });
    };
    return options?.forUpdate
      ? this.withTenantTransaction(ctx, run)
      : this.withTenantReadTransaction(ctx, run);
  }

  public async listKeyDatesForEnquiry(
    ctx: TenantContext,
    enquiryId: string,
    viewerId: string = ctx.actorId,
    options?: { forUpdate?: boolean },
  ): Promise<KeyDate[]> {
    void viewerId;
    const run = async (tx: TenantSqlClient): Promise<KeyDate[]> => {
      const res = await tx.query<DbKeyDateRow>(
        options?.forUpdate
          ? 'SELECT * FROM key_dates WHERE tenant_id = $1 AND enquiry_id = $2 ORDER BY id ASC FOR UPDATE'
          : 'SELECT * FROM key_dates WHERE tenant_id = $1 AND enquiry_id = $2 ORDER BY due_date ASC, id ASC',
        [ctx.tenantId, enquiryId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'KeyDate');
        return mapKeyDateRow(r);
      });
    };
    return options?.forUpdate
      ? this.withTenantTransaction(ctx, run)
      : this.withTenantReadTransaction(ctx, run);
  }

  public async listAllKeyDatesUnfilteredForScheduler(
    ctx: TenantContext,
    options?: { forUpdate?: boolean },
  ): Promise<KeyDate[]> {
    const run = async (tx: TenantSqlClient): Promise<KeyDate[]> => {
      const res = await tx.query<DbKeyDateRow>(
        options?.forUpdate
          ? 'SELECT * FROM key_dates WHERE tenant_id = $1 ORDER BY id ASC FOR UPDATE'
          : 'SELECT * FROM key_dates WHERE tenant_id = $1 ORDER BY due_date ASC, id ASC',
        [ctx.tenantId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'KeyDate');
        return mapKeyDateRow(r);
      });
    };
    return options?.forUpdate
      ? this.withTenantTransaction(ctx, run)
      : this.withTenantReadTransaction(ctx, run);
  }

  public async listAllVisibleKeyDates(
    ctx: TenantContext,
    viewerId: string = ctx.actorId,
  ): Promise<KeyDate[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbKeyDateRow>(
        `SELECT kd.*
         FROM key_dates kd
         LEFT JOIN matters m
           ON m.tenant_id = kd.tenant_id AND m.id = kd.matter_id
         WHERE kd.tenant_id = $1
           AND (
             kd.matter_id IS NULL
             OR (
               m.id IS NOT NULL
               AND (
                 (
                   m.is_staff_matter = FALSE
                   AND m.has_ethical_wall = FALSE
                   AND jsonb_array_length(COALESCE(m.restricted_access_user_ids_json, '[]'::jsonb)) = 0
                 )
                 OR m.restricted_access_user_ids_json ? $2
               )
             )
           )
         ORDER BY kd.due_date ASC, kd.id ASC`,
        [ctx.tenantId, viewerId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'KeyDate');
        return mapKeyDateRow(r);
      });
    });
  }

  public async queryKeyDatesForDiary(
    ctx: TenantContext,
    query: TeamDiaryQuery,
    viewerId: string = ctx.actorId,
  ): Promise<KeyDate[]> {
    const visible = await this.listAllVisibleKeyDates(ctx, viewerId);
    const teamSet = new Set(query.teamIds);
    const categorySet = query.categories?.length
      ? new Set(query.categories)
      : null;
    const statusSet = query.statuses?.length ? new Set(query.statuses) : null;

    return visible.filter((kd) => {
      if (teamSet.size > 0 && !teamSet.has(kd.teamId)) return false;
      if (
        (query.from && kd.dueDate < query.from) ||
        (query.to && kd.dueDate > query.to)
      ) {
        return false;
      }
      if (categorySet && !categorySet.has(kd.category)) return false;
      if (statusSet && !statusSet.has(kd.status)) return false;
      if (query.criticalOnly && !kd.isCritical) return false;
      if (
        query.awaitingVerificationOnly &&
        kd.status !== 'awaiting_verification'
      ) {
        return false;
      }
      return true;
    });
  }

  // ============================================================================
  // Not Applicable Records
  // ============================================================================

  public async putNotApplicable(
    ctx: TenantContext,
    record: KeyDateNotApplicable,
  ): Promise<KeyDateNotApplicable> {
    return this.withTenantTransaction(ctx, async (tx) => {
      if (
        !(await this.checkMatterVisibleInTx(
          tx,
          ctx,
          record.matterId,
          ctx.actorId,
        ))
      ) {
        throw new Error(
          `KEY_DATE_ACCESS_DENIED: Viewer "${ctx.actorId}" is not permitted to write not-applicable records for matter "${record.matterId}".`,
        );
      }
      const rowId = `${ctx.tenantId}:${record.matterId}:${record.keyDateTypeId}`;
      const res = await tx.query<DbNotApplicableRow>(
        `INSERT INTO key_date_not_applicable (
           id, tenant_id, matter_id, key_date_type_id, reason, recorded_by_id, recorded_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, matter_id, key_date_type_id) DO UPDATE SET
           reason = EXCLUDED.reason,
           recorded_by_id = EXCLUDED.recorded_by_id,
           recorded_at = EXCLUDED.recorded_at
         RETURNING *`,
        [
          rowId,
          ctx.tenantId,
          record.matterId,
          record.keyDateTypeId,
          record.reason,
          record.recordedById,
          record.recordedAt,
        ],
      );
      const saved = res.rows[0]!;
      this.assertRowTenant(ctx, saved.tenant_id, 'KeyDateNotApplicable');
      return {
        matterId: saved.matter_id,
        keyDateTypeId: saved.key_date_type_id,
        reason: saved.reason,
        recordedById: saved.recorded_by_id,
        recordedAt: toIsoString(saved.recorded_at),
      };
    });
  }

  public async removeNotApplicable(
    ctx: TenantContext,
    matterId: string,
    keyDateTypeId: KeyDateTypeId,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      if (!(await this.checkMatterVisibleInTx(tx, ctx, matterId, ctx.actorId))) {
        throw new Error(
          `KEY_DATE_ACCESS_DENIED: Viewer "${ctx.actorId}" is not permitted to remove not-applicable records for matter "${matterId}".`,
        );
      }
      const del = await tx.query(
        `DELETE FROM key_date_not_applicable
         WHERE tenant_id = $1 AND matter_id = $2 AND key_date_type_id = $3`,
        [ctx.tenantId, matterId, keyDateTypeId],
      );
      return del.rowCount > 0;
    });
  }

  public async listNotApplicableForMatter(
    ctx: TenantContext,
    matterId: string,
    viewerId: string = ctx.actorId,
  ): Promise<KeyDateNotApplicable[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      if (!(await this.checkMatterVisibleInTx(tx, ctx, matterId, viewerId))) {
        return [];
      }
      const res = await tx.query<DbNotApplicableRow>(
        `SELECT * FROM key_date_not_applicable
         WHERE tenant_id = $1 AND matter_id = $2
         ORDER BY key_date_type_id ASC`,
        [ctx.tenantId, matterId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'KeyDateNotApplicable');
        return {
          matterId: r.matter_id,
          keyDateTypeId: r.key_date_type_id,
          reason: r.reason,
          recordedById: r.recorded_by_id,
          recordedAt: toIsoString(r.recorded_at),
        };
      });
    });
  }

  public async listAllVisibleNotApplicable(
    ctx: TenantContext,
    viewerId: string = ctx.actorId,
  ): Promise<KeyDateNotApplicable[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbNotApplicableRow>(
        `SELECT na.*
         FROM key_date_not_applicable na
         INNER JOIN matters m
           ON m.tenant_id = na.tenant_id AND m.id = na.matter_id
         WHERE na.tenant_id = $1
           AND (
             (
               m.is_staff_matter = FALSE
               AND m.has_ethical_wall = FALSE
               AND jsonb_array_length(COALESCE(m.restricted_access_user_ids_json, '[]'::jsonb)) = 0
             )
             OR m.restricted_access_user_ids_json ? $2
           )
         ORDER BY na.matter_id ASC, na.key_date_type_id ASC`,
        [ctx.tenantId, viewerId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'KeyDateNotApplicable');
        return {
          matterId: r.matter_id,
          keyDateTypeId: r.key_date_type_id,
          reason: r.reason,
          recordedById: r.recorded_by_id,
          recordedAt: toIsoString(r.recorded_at),
        };
      });
    });
  }

  /**
   * Used ONLY by the tenant-scoped reminder scheduler, which must inspect
   * not-applicable records across all matters in the tenant (including staff
   * matters and ethical-wall matters) so that key dates marked not applicable
   * are skipped regardless of the triggering actor's matter visibility.
   */
  public async listAllNotApplicableUnfilteredForScheduler(
    ctx: TenantContext,
  ): Promise<KeyDateNotApplicable[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbNotApplicableRow>(
        'SELECT * FROM key_date_not_applicable WHERE tenant_id = $1 ORDER BY matter_id ASC, key_date_type_id ASC',
        [ctx.tenantId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'KeyDateNotApplicable');
        return {
          matterId: r.matter_id,
          keyDateTypeId: r.key_date_type_id,
          reason: r.reason,
          recordedById: r.recorded_by_id,
          recordedAt: toIsoString(r.recorded_at),
        };
      });
    });
  }

  // ============================================================================
  // Reminder States (1 per confirmed key date)
  // ============================================================================

  private isSystemReminderSchedulerContext(ctx: TenantContext): boolean {
    return (
      ctx.actorId.startsWith('system:') &&
      Boolean(ctx.actorSub?.startsWith('system:')) &&
      Boolean(ctx.jobPermissions?.includes('keydate:run_reminders'))
    );
  }

  public async putReminderState(
    ctx: TenantContext,
    state: KeyDateReminderState,
  ): Promise<KeyDateReminderState> {
    if (
      state.lastSkippedReason !== undefined &&
      state.lastSkippedReason !== 'no_permitted_assignees' &&
      state.lastSkippedReason !== 'missing_matter'
    ) {
      throw new Error(
        `KEY_DATE_VALIDATION_ERROR: Invalid lastSkippedReason "${String(state.lastSkippedReason)}"; expected 'no_permitted_assignees' or 'missing_matter'.`,
      );
    }

    const bypassMatterCheck = this.isSystemReminderSchedulerContext(ctx);

    return this.withTenantTransaction(ctx, async (tx) => {
      const kdRes = await tx.query<DbKeyDateRow>(
        'SELECT * FROM key_dates WHERE id = $1 AND tenant_id = $2',
        [state.keyDateId, ctx.tenantId],
      );
      const kdRow = kdRes.rows[0];
      if (!kdRow) {
        throw new Error(
          `KEY_DATE_NOT_FOUND: KeyDate "${state.keyDateId}" was not found in tenant "${ctx.tenantId}".`,
        );
      }
      this.assertRowTenant(ctx, kdRow.tenant_id, 'KeyDate');
      if (
        !bypassMatterCheck &&
        kdRow.matter_id &&
        !(await this.checkMatterVisibleInTx(
          tx,
          ctx,
          kdRow.matter_id,
          ctx.actorId,
        ))
      ) {
        throw new Error(
          `KEY_DATE_ACCESS_DENIED: Viewer "${ctx.actorId}" is not permitted to write reminder state for matter "${kdRow.matter_id}".`,
        );
      }

      const rowId = `${ctx.tenantId}:REM:${state.keyDateId}`;
      const res = await tx.query<DbReminderStateRow>(
        `INSERT INTO key_date_reminder_states (
           id, tenant_id, key_date_id, task_id, idempotency_key,
           reminder_schedule_id, current_stage_days_before, stage_entered_at,
           acknowledged_by_id, acknowledged_at, escalation_level,
           last_notified_at, last_skipped_reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (key_date_id) DO UPDATE SET
           task_id = EXCLUDED.task_id,
           idempotency_key = EXCLUDED.idempotency_key,
           reminder_schedule_id = EXCLUDED.reminder_schedule_id,
           current_stage_days_before = EXCLUDED.current_stage_days_before,
           stage_entered_at = EXCLUDED.stage_entered_at,
           acknowledged_by_id = CASE
             WHEN key_date_reminder_states.current_stage_days_before IS NOT DISTINCT FROM EXCLUDED.current_stage_days_before
               AND key_date_reminder_states.idempotency_key IS NOT DISTINCT FROM EXCLUDED.idempotency_key
               AND key_date_reminder_states.stage_entered_at IS NOT DISTINCT FROM EXCLUDED.stage_entered_at
               AND EXCLUDED.acknowledged_by_id IS NULL
               AND EXCLUDED.acknowledged_at IS NULL
             THEN key_date_reminder_states.acknowledged_by_id
             ELSE EXCLUDED.acknowledged_by_id
           END,
           acknowledged_at = CASE
             WHEN key_date_reminder_states.current_stage_days_before IS NOT DISTINCT FROM EXCLUDED.current_stage_days_before
               AND key_date_reminder_states.idempotency_key IS NOT DISTINCT FROM EXCLUDED.idempotency_key
               AND key_date_reminder_states.stage_entered_at IS NOT DISTINCT FROM EXCLUDED.stage_entered_at
               AND EXCLUDED.acknowledged_by_id IS NULL
               AND EXCLUDED.acknowledged_at IS NULL
             THEN key_date_reminder_states.acknowledged_at
             ELSE EXCLUDED.acknowledged_at
           END,
           escalation_level = EXCLUDED.escalation_level,
           last_notified_at = EXCLUDED.last_notified_at,
           last_skipped_reason = EXCLUDED.last_skipped_reason
         WHERE key_date_reminder_states.tenant_id = $2
         RETURNING *`,
        [
          rowId,
          ctx.tenantId,
          state.keyDateId,
          state.taskId,
          state.idempotencyKey,
          state.reminderScheduleId,
          state.currentStageDaysBefore,
          state.stageEnteredAt,
          state.acknowledgedById ?? null,
          state.acknowledgedAt ?? null,
          state.escalationLevel ?? 0,
          state.lastNotifiedAt ?? null,
          state.lastSkippedReason ?? null,
        ],
      );
      const saved = res.rows[0]!;
      this.assertRowTenant(ctx, saved.tenant_id, 'KeyDateReminderState');
      return mapReminderStateRow(saved);
    });
  }

  public async getReminderState(
    ctx: TenantContext,
    keyDateId: KeyDateId,
    viewerId: string = ctx.actorId,
    options?: { forUpdate?: boolean },
  ): Promise<KeyDateReminderState | null> {
    const run = async (tx: TenantSqlClient): Promise<KeyDateReminderState | null> => {
      const kdRes = await tx.query<{ tenant_id: string; matter_id: string | null }>(
        'SELECT tenant_id, matter_id FROM key_dates WHERE id = $1 AND tenant_id = $2',
        [keyDateId, ctx.tenantId],
      );
      const kdRow = kdRes.rows[0];
      if (!kdRow) return null;
      this.assertRowTenant(ctx, kdRow.tenant_id, 'KeyDate');
      if (
        kdRow.matter_id &&
        !(await this.checkMatterVisibleInTx(tx, ctx, kdRow.matter_id, viewerId))
      ) {
        return null;
      }
      const res = await tx.query<DbReminderStateRow>(
        options?.forUpdate
          ? 'SELECT * FROM key_date_reminder_states WHERE tenant_id = $1 AND key_date_id = $2 FOR UPDATE'
          : 'SELECT * FROM key_date_reminder_states WHERE tenant_id = $1 AND key_date_id = $2',
        [ctx.tenantId, keyDateId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'KeyDateReminderState');
      return mapReminderStateRow(row);
    };
    return options?.forUpdate
      ? this.withTenantTransaction(ctx, run)
      : this.withTenantReadTransaction(ctx, run);
  }

  public async listReminderStates(
    ctx: TenantContext,
    viewerId: string = ctx.actorId,
  ): Promise<KeyDateReminderState[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const visibleIds = new Set(
        (await this.listAllVisibleKeyDates(ctx, viewerId)).map((kd) => kd.id),
      );
      if (visibleIds.size === 0) return [];
      const res = await tx.query<DbReminderStateRow>(
        'SELECT * FROM key_date_reminder_states WHERE tenant_id = $1 ORDER BY key_date_id ASC',
        [ctx.tenantId],
      );
      const out: KeyDateReminderState[] = [];
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'KeyDateReminderState');
        if (visibleIds.has(row.key_date_id)) {
          out.push(mapReminderStateRow(row));
        }
      }
      return out;
    });
  }

  private resolveKeyDateVisibilitySql(
    alias: string,
    viewerParamIndex: number,
  ): string {
    return `EXISTS (
      SELECT 1
      FROM key_dates kd
      LEFT JOIN matters m
        ON m.tenant_id = kd.tenant_id AND m.id = kd.matter_id
      WHERE kd.tenant_id = ${alias}.tenant_id
        AND kd.id = ${alias}.key_date_id
        AND (
          kd.matter_id IS NULL
          OR (
            m.id IS NOT NULL
            AND (
              (
                m.is_staff_matter = FALSE
                AND m.has_ethical_wall = FALSE
                AND jsonb_array_length(COALESCE(m.restricted_access_user_ids_json, '[]'::jsonb)) = 0
              )
              OR m.restricted_access_user_ids_json ? $${viewerParamIndex}
            )
          )
        )
    )`;
  }

  public async listReminderStatesForKeyDateIds(
    ctx: TenantContext,
    keyDateIds: readonly string[],
    viewerOrOptions:
      | string
      | {
          readonly viewerId?: string;
          readonly includeRestricted?: boolean;
          readonly hasRestrictedMatterAccess?: boolean;
        } = ctx.actorId,
  ): Promise<KeyDateReminderState[]> {
    const cleanIds = Array.from(
      new Set(keyDateIds.map((x) => x?.trim()).filter(Boolean) as string[]),
    );
    if (cleanIds.length === 0) return [];
    const includeRestricted =
      typeof viewerOrOptions === 'object' &&
      viewerOrOptions !== null &&
      Boolean(
        viewerOrOptions.includeRestricted ||
          viewerOrOptions.hasRestrictedMatterAccess,
      );
    const viewerId =
      typeof viewerOrOptions === 'string'
        ? viewerOrOptions
        : viewerOrOptions?.viewerId ?? ctx.actorId;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = includeRestricted
        ? await tx.query<DbReminderStateRow>(
            `SELECT * FROM key_date_reminder_states rs
             WHERE rs.tenant_id = $1 AND rs.key_date_id = ANY($2::text[])
             ORDER BY rs.key_date_id ASC`,
            [ctx.tenantId, cleanIds],
          )
        : await tx.query<DbReminderStateRow>(
            `SELECT rs.* FROM key_date_reminder_states rs
             WHERE rs.tenant_id = $1
               AND rs.key_date_id = ANY($2::text[])
               AND ${this.resolveKeyDateVisibilitySql('rs', 3)}
             ORDER BY rs.key_date_id ASC`,
            [ctx.tenantId, cleanIds, viewerId],
          );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'KeyDateReminderState');
        return mapReminderStateRow(row);
      });
    });
  }

  public async listAllReminderStates(
    ctx: TenantContext,
    viewerId: string = ctx.actorId,
  ): Promise<KeyDateReminderState[]> {
    return this.listReminderStates(ctx, viewerId);
  }

  public async listAllReminderStatesUnfilteredForScheduler(
    ctx: TenantContext,
    options?: { forUpdate?: boolean },
  ): Promise<KeyDateReminderState[]> {
    const run = async (tx: TenantSqlClient): Promise<KeyDateReminderState[]> => {
      const res = await tx.query<DbReminderStateRow>(
        options?.forUpdate
          ? 'SELECT * FROM key_date_reminder_states WHERE tenant_id = $1 ORDER BY key_date_id ASC FOR UPDATE'
          : 'SELECT * FROM key_date_reminder_states WHERE tenant_id = $1 ORDER BY key_date_id ASC',
        [ctx.tenantId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'KeyDateReminderState');
        return mapReminderStateRow(row);
      });
    };
    return options?.forUpdate
      ? this.withTenantTransaction(ctx, run)
      : this.withTenantReadTransaction(ctx, run);
  }

  public async removeReminderState(
    ctx: TenantContext,
    keyDateId: KeyDateId,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query(
        'DELETE FROM key_date_reminder_states WHERE tenant_id = $1 AND key_date_id = $2',
        [ctx.tenantId, keyDateId],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  /**
   * Acquires `FOR UPDATE SKIP LOCKED` row locks ONLY for scheduler candidate key dates
   * (`key_dates` in ascending `id` order, then `key_date_reminder_states` in ascending `key_date_id` order),
   * skipping any candidate currently locked by an active user transaction so acknowledgements and edits
   * on unrelated or busy rows are never stalled (R629).
   */
  public async lockKeyDatesAndRemindersForSchedulerWrite(
    ctx: TenantContext,
    candidateKeyDateIds: readonly KeyDateId[],
  ): Promise<{
    lockedKeyDateIds: Set<KeyDateId>;
    keyDates: KeyDate[];
    reminderStates: KeyDateReminderState[];
    skippedKeyDateIds: KeyDateId[];
  }> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const uniqueIds = Array.from(new Set(candidateKeyDateIds)).sort();
      if (uniqueIds.length === 0) {
        return {
          lockedKeyDateIds: new Set<KeyDateId>(),
          keyDates: [],
          reminderStates: [],
          skippedKeyDateIds: [],
        };
      }

      const kdRes = await tx.query<DbKeyDateRow>(
        'SELECT * FROM key_dates WHERE tenant_id = $1 AND id = ANY($2::text[]) ORDER BY id ASC FOR UPDATE SKIP LOCKED',
        [ctx.tenantId, uniqueIds],
      );
      const kdById = new Map<KeyDateId, KeyDate>();
      for (const row of kdRes.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'KeyDate');
        kdById.set(row.id, mapKeyDateRow(row));
      }

      const lockedKdIds = Array.from(kdById.keys()).sort();
      const rsByKdId = new Map<KeyDateId, KeyDateReminderState>();
      if (lockedKdIds.length > 0) {
        const existingRsRes = await tx.query<{ key_date_id: string }>(
          'SELECT key_date_id FROM key_date_reminder_states WHERE tenant_id = $1 AND key_date_id = ANY($2::text[])',
          [ctx.tenantId, lockedKdIds],
        );
        const hasReminderRow = new Set(existingRsRes.rows.map((r) => r.key_date_id));
        const rsRes = await tx.query<DbReminderStateRow>(
          'SELECT * FROM key_date_reminder_states WHERE tenant_id = $1 AND key_date_id = ANY($2::text[]) ORDER BY key_date_id ASC FOR UPDATE SKIP LOCKED',
          [ctx.tenantId, lockedKdIds],
        );
        for (const row of rsRes.rows) {
          this.assertRowTenant(ctx, row.tenant_id, 'KeyDateReminderState');
          rsByKdId.set(row.key_date_id, mapReminderStateRow(row));
        }
        for (const kdId of lockedKdIds) {
          if (hasReminderRow.has(kdId) && !rsByKdId.has(kdId)) {
            kdById.delete(kdId);
          }
        }
      }

      const finalLockedIds = new Set(kdById.keys());
      const skippedKeyDateIds = uniqueIds.filter((id) => !finalLockedIds.has(id));
      return {
        lockedKeyDateIds: finalLockedIds,
        keyDates: Array.from(kdById.values()),
        reminderStates: Array.from(rsByKdId.values()),
        skippedKeyDateIds,
      };
    });
  }

  // ============================================================================
  // Calendar Sync State
  // ============================================================================

  public async putCalendarSync(
    ctx: TenantContext,
    sync: KeyDateCalendarSync,
  ): Promise<KeyDateCalendarSync> {
    const bypassMatterCheck = this.isSystemReminderSchedulerContext(ctx);

    return this.withTenantTransaction(ctx, async (tx) => {
      const kdRes = await tx.query<DbKeyDateRow>(
        'SELECT * FROM key_dates WHERE id = $1 AND tenant_id = $2',
        [sync.keyDateId, ctx.tenantId],
      );
      const kdRow = kdRes.rows[0];
      if (!kdRow) {
        throw new Error(
          `KEY_DATE_NOT_FOUND: KeyDate "${sync.keyDateId}" was not found in tenant "${ctx.tenantId}".`,
        );
      }
      this.assertRowTenant(ctx, kdRow.tenant_id, 'KeyDate');
      if (
        !bypassMatterCheck &&
        kdRow.matter_id &&
        !(await this.checkMatterVisibleInTx(
          tx,
          ctx,
          kdRow.matter_id,
          ctx.actorId,
        ))
      ) {
        throw new Error(
          `KEY_DATE_ACCESS_DENIED: Viewer "${ctx.actorId}" is not permitted to write calendar sync state for matter "${kdRow.matter_id}".`,
        );
      }

      const rowId = `${ctx.tenantId}:CAL:${sync.keyDateId}`;
      const res = await tx.query<DbCalendarSyncRow>(
        `INSERT INTO key_date_calendar_syncs (
           id, tenant_id, key_date_id, state, external_events_json,
           last_synced_at, last_error, attempts, lease_token, lease_expires_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
         ON CONFLICT (key_date_id) DO UPDATE SET
           state = EXCLUDED.state,
           external_events_json = EXCLUDED.external_events_json,
           last_synced_at = EXCLUDED.last_synced_at,
           last_error = EXCLUDED.last_error,
           attempts = EXCLUDED.attempts,
           lease_token = EXCLUDED.lease_token,
           lease_expires_at = EXCLUDED.lease_expires_at
         WHERE key_date_calendar_syncs.tenant_id = $2
         RETURNING *`,
        [
          rowId,
          ctx.tenantId,
          sync.keyDateId,
          sync.state,
          JSON.stringify(sync.externalEvents ?? []),
          sync.lastSyncedAt ?? null,
          sync.lastError ?? null,
          sync.attempts ?? 0,
          sync.leaseToken ?? null,
          sync.leaseExpiresAt ?? null,
        ],
      );
      const saved = res.rows[0]!;
      this.assertRowTenant(ctx, saved.tenant_id, 'KeyDateCalendarSync');
      return mapCalendarSyncRow(saved);
    });
  }

  public async readKeyDateAndCalendarSyncForUpdate(
    ctx: TenantContext,
    keyDateId: KeyDateId,
  ): Promise<{
    keyDate: KeyDate | null;
    calendarSync: KeyDateCalendarSync | null;
  }> {
    const bypassMatterCheck = this.isSystemReminderSchedulerContext(ctx);

    return this.withTenantTransaction(ctx, async (tx) => {
      const kdRes = await tx.query<DbKeyDateRow>(
        'SELECT * FROM key_dates WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [keyDateId, ctx.tenantId],
      );
      const kdRow = kdRes.rows[0];
      if (!kdRow) {
        return { keyDate: null, calendarSync: null };
      }
      this.assertRowTenant(ctx, kdRow.tenant_id, 'KeyDate');
      if (
        !bypassMatterCheck &&
        kdRow.matter_id &&
        !(await this.checkMatterVisibleInTx(
          tx,
          ctx,
          kdRow.matter_id,
          ctx.actorId,
        ))
      ) {
        throw new Error(
          `KEY_DATE_ACCESS_DENIED: Viewer "${ctx.actorId}" is not permitted to access calendar sync state for matter "${kdRow.matter_id}".`,
        );
      }
      const syncRes = await tx.query<DbCalendarSyncRow>(
        'SELECT * FROM key_date_calendar_syncs WHERE tenant_id = $1 AND key_date_id = $2 FOR UPDATE',
        [ctx.tenantId, keyDateId],
      );
      const syncRow = syncRes.rows[0];
      let calendarSync: KeyDateCalendarSync | null = null;
      if (syncRow) {
        this.assertRowTenant(ctx, syncRow.tenant_id, 'KeyDateCalendarSync');
        calendarSync = mapCalendarSyncRow(syncRow);
      }
      return { keyDate: mapKeyDateRow(kdRow), calendarSync };
    });
  }

  public async getCalendarSync(
    ctx: TenantContext,
    keyDateId: KeyDateId,
    viewerId: string = ctx.actorId,
  ): Promise<KeyDateCalendarSync | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const kd = await this.getKeyDateById(ctx, keyDateId, viewerId);
      if (!kd) return null;
      const res = await tx.query<DbCalendarSyncRow>(
        'SELECT * FROM key_date_calendar_syncs WHERE tenant_id = $1 AND key_date_id = $2',
        [ctx.tenantId, keyDateId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'KeyDateCalendarSync');
      return mapCalendarSyncRow(row);
    });
  }

  public async listCalendarSyncsForKeyDateIds(
    ctx: TenantContext,
    keyDateIds: readonly string[],
    viewerOrOptions:
      | string
      | {
          readonly viewerId?: string;
          readonly includeRestricted?: boolean;
          readonly hasRestrictedMatterAccess?: boolean;
        } = ctx.actorId,
  ): Promise<KeyDateCalendarSync[]> {
    const cleanIds = Array.from(
      new Set(keyDateIds.map((x) => x?.trim()).filter(Boolean) as string[]),
    );
    if (cleanIds.length === 0) return [];
    const includeRestricted =
      typeof viewerOrOptions === 'object' &&
      viewerOrOptions !== null &&
      Boolean(
        viewerOrOptions.includeRestricted ||
          viewerOrOptions.hasRestrictedMatterAccess,
      );
    const viewerId =
      typeof viewerOrOptions === 'string'
        ? viewerOrOptions
        : viewerOrOptions?.viewerId ?? ctx.actorId;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = includeRestricted
        ? await tx.query<DbCalendarSyncRow>(
            `SELECT * FROM key_date_calendar_syncs cs
             WHERE cs.tenant_id = $1 AND cs.key_date_id = ANY($2::text[])
             ORDER BY cs.key_date_id ASC`,
            [ctx.tenantId, cleanIds],
          )
        : await tx.query<DbCalendarSyncRow>(
            `SELECT cs.* FROM key_date_calendar_syncs cs
             WHERE cs.tenant_id = $1
               AND cs.key_date_id = ANY($2::text[])
               AND ${this.resolveKeyDateVisibilitySql('cs', 3)}
             ORDER BY cs.key_date_id ASC`,
            [ctx.tenantId, cleanIds, viewerId],
          );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'KeyDateCalendarSync');
        return mapCalendarSyncRow(row);
      });
    });
  }

  public async listAllVisibleCalendarSyncs(
    ctx: TenantContext,
    viewerId: string = ctx.actorId,
  ): Promise<KeyDateCalendarSync[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const visibleIds = new Set(
        (await this.listAllVisibleKeyDates(ctx, viewerId)).map((kd) => kd.id),
      );
      if (visibleIds.size === 0) return [];
      const res = await tx.query<DbCalendarSyncRow>(
        'SELECT * FROM key_date_calendar_syncs WHERE tenant_id = $1 ORDER BY key_date_id ASC',
        [ctx.tenantId],
      );
      const out: KeyDateCalendarSync[] = [];
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'KeyDateCalendarSync');
        if (visibleIds.has(row.key_date_id)) {
          out.push(mapCalendarSyncRow(row));
        }
      }
      return out;
    });
  }

  /**
   * Used ONLY by the tenant-scoped reminder scheduler, which inspects calendar
   * sync records across all key dates in the tenant when building its run summary.
   */
  public async listAllCalendarSyncsUnfilteredForScheduler(
    ctx: TenantContext,
  ): Promise<KeyDateCalendarSync[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbCalendarSyncRow>(
        'SELECT * FROM key_date_calendar_syncs WHERE tenant_id = $1 ORDER BY key_date_id ASC',
        [ctx.tenantId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'KeyDateCalendarSync');
        return mapCalendarSyncRow(row);
      });
    });
  }

  public async countAllTenantKeyDateRows(ctx: TenantContext): Promise<{
    keyDates: number;
    notApplicable: number;
    reminderStates: number;
    calendarSyncs: number;
    hasConfigOverride: boolean;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        kd_cnt: number;
        na_cnt: number;
        rs_cnt: number;
        cs_cnt: number;
        cfg_cnt: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM key_dates WHERE tenant_id = $1) AS kd_cnt,
           (SELECT COUNT(*)::int FROM key_date_not_applicable WHERE tenant_id = $1) AS na_cnt,
           (SELECT COUNT(*)::int FROM key_date_reminder_states WHERE tenant_id = $1) AS rs_cnt,
           (SELECT COUNT(*)::int FROM key_date_calendar_syncs WHERE tenant_id = $1) AS cs_cnt,
           (SELECT COUNT(*)::int FROM key_dates_tenant_configs WHERE tenant_id = $1) AS cfg_cnt`,
        [ctx.tenantId],
      );
      const row = res.rows[0];
      return {
        keyDates: Number(row?.kd_cnt ?? 0),
        notApplicable: Number(row?.na_cnt ?? 0),
        reminderStates: Number(row?.rs_cnt ?? 0),
        calendarSyncs: Number(row?.cs_cnt ?? 0),
        hasConfigOverride: Number(row?.cfg_cnt ?? 0) > 0,
      };
    });
  }

  // ============================================================================
  // Immutable Key Date Audit Events
  // ============================================================================

  public async appendAuditEvent(
    ctx: TenantContext,
    event: KeyDateAuditEventRecord,
  ): Promise<KeyDateAuditEventRecord> {
    return this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        `INSERT INTO key_date_audit_events (
           id, tenant_id, action, key_date_id, matter_id, enquiry_id,
           actor_id, occurred_at, reason, before_json, after_json, correlation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          event.id,
          ctx.tenantId,
          event.action,
          event.keyDateId ?? null,
          event.matterId ?? null,
          event.enquiryId ?? null,
          event.actorId,
          event.occurredAt,
          event.reason ?? null,
          event.before !== undefined ? JSON.stringify(event.before) : null,
          event.after !== undefined ? JSON.stringify(event.after) : null,
          event.correlationId,
        ],
      );
      return Object.freeze({ ...event });
    });
  }

  public async listAuditEvents(
    ctx: TenantContext,
    filter?: { keyDateId?: KeyDateId; matterId?: string; enquiryId?: string },
    viewerId: string = ctx.actorId,
  ): Promise<KeyDateAuditEventRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses = ['tenant_id = $1'];
      const values: unknown[] = [ctx.tenantId];
      if (filter?.keyDateId) {
        values.push(filter.keyDateId);
        clauses.push(`key_date_id = $${values.length}`);
      }
      if (filter?.matterId) {
        values.push(filter.matterId);
        clauses.push(`matter_id = $${values.length}`);
      }
      if (filter?.enquiryId) {
        values.push(filter.enquiryId);
        clauses.push(`enquiry_id = $${values.length}`);
      }
      const res = await tx.query<DbKeyDateAuditRow>(
        `SELECT * FROM key_date_audit_events WHERE ${clauses.join(' AND ')} ORDER BY occurred_at ASC, id ASC`,
        values,
      );
      const out: KeyDateAuditEventRecord[] = [];
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'KeyDateAuditEventRecord');
        if (
          row.matter_id &&
          !(await this.checkMatterVisibleInTx(tx, ctx, row.matter_id, viewerId))
        ) {
          continue;
        }
        out.push({
          id: row.id,
          action: row.action,
          ...(row.key_date_id !== null ? { keyDateId: row.key_date_id } : {}),
          ...(row.matter_id !== null ? { matterId: row.matter_id } : {}),
          ...(row.enquiry_id !== null ? { enquiryId: row.enquiry_id } : {}),
          actorId: row.actor_id,
          occurredAt: toIsoString(row.occurred_at),
          ...(row.reason !== null ? { reason: row.reason } : {}),
          ...(row.before_json !== null ? { before: row.before_json } : {}),
          ...(row.after_json !== null ? { after: row.after_json } : {}),
          correlationId: row.correlation_id,
        });
      }
      return out;
    });
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        'DELETE FROM key_date_calendar_syncs WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM key_date_reminder_states WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM key_date_not_applicable WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'UPDATE key_dates SET supersedes_key_date_id = NULL, superseded_by_key_date_id = NULL WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query('DELETE FROM key_dates WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query('DELETE FROM key_date_audit_events WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query(
        "DELETE FROM matters WHERE tenant_id = $1 AND client_id = 'O-KEYDATE-STUB'",
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM key_dates_tenant_configs WHERE tenant_id = $1',
        [ctx.tenantId],
      );
    });
  }
}
