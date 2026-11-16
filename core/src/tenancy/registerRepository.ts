/**
 * Tenant-Scoped Configurable Registers PostgreSQL Repository
 * (`core/src/tenancy/registerRepository.ts`).
 *
 * Enforces ADR 0032 & Platform Architecture Standard §§4, 7, 8:
 * 1. Every read (`withTenantReadTransaction`) and write (`withTenantTransaction`) executes
 *    inside an explicit transaction after `SET LOCAL ROLE "<role_tenant_slug_env>"`.
 * 2. Every SQL query predicates on `tenant_id = $1` bound strictly from `ctx.tenantId`,
 *    and every returned row is verified via `this.assertRowTenant(ctx, row.tenant_id, ...)`.
 * 3. SQL-level visibility (`REGISTER_RECORD_VISIBLE_SQL_PREDICATE`) joins `public.matters` so
 *    records linked to a restricted staff/ethical-wall matter are omitted before leaving
 *    PostgreSQL unless `viewerId` is in `matters.restricted_access_user_ids_json`.
 * 4. Transition writes acquire `FOR UPDATE` row lock, enforce optimistic concurrency
 *    (`row_version`), record an immutable row in `public.register_transitions`, and
 *    atomically append audit entries inside the same transaction.
 */

import type {
  FirmAuditEntryInput,
  RegisterRecord,
  RegisterReminderSkippedReason,
  RegisterReminderState,
  RegisterReminderTriggerKind,
  RegisterTransition,
  TenantContext,
} from '../api/index';
import {
  REGISTER_DOMAIN_ERROR_CODES,
  createRegisterDomainError,
} from '../domain/registers/index';
import { TenantAuditRepository } from './auditRepository';
import type { TenantPostgresPoolManager } from './postgresPoolManager';
import {
  TenantScopedRepository,
  toIsoString,
  type TenantSqlClient,
} from './tenantScopedRepository';

export const REGISTER_RECORD_VISIBLE_SQL_PREDICATE = `(
  r.matter_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM public.matters m
    WHERE m.tenant_id = r.tenant_id
      AND m.id = r.matter_id
      AND (m.is_staff_matter = TRUE OR m.has_ethical_wall = TRUE)
      AND NOT (m.restricted_access_user_ids_json ? $2)
  )
)`;

interface DbRegisterRecordRow {
  tenant_id: string;
  id: string;
  register_type_key: string;
  reference: string;
  title: string;
  status: string;
  matter_id: string | null;
  enquiry_id: string | null;
  person_id: string | null;
  organisation_id: string | null;
  owner_id: string | null;
  assigned_approver_id: string | null;
  decided_by_id: string | null;
  decided_at: Date | string | null;
  due_at: Date | string | null;
  review_at: Date | string | null;
  reminder_schedule_days_json: unknown;
  field_values_json: unknown;
  row_version: number | string;
  created_by_id: string;
  created_at: Date | string;
  updated_by_id: string;
  updated_at: Date | string;
}

interface DbRegisterTransitionRow {
  tenant_id: string;
  id: string;
  register_record_id: string;
  register_type_key: string;
  transition_key: string;
  from_status: string;
  to_status: string;
  actor_id: string;
  comment: string | null;
  payload_json: unknown;
  correlation_id: string;
  transitioned_at: Date | string;
}

interface DbRegisterReminderStateRow {
  tenant_id: string;
  register_record_id: string;
  idempotency_key: string;
  trigger_kind: RegisterReminderTriggerKind;
  stage_days_before: number | string;
  last_notified_at: Date | string | null;
  last_skipped_reason: RegisterReminderSkippedReason | null;
  metadata_json: unknown;
  updated_at: Date | string;
}

function mapRegisterRecordRow(row: DbRegisterRecordRow): RegisterRecord {
  const reminderDays = Array.isArray(row.reminder_schedule_days_json)
    ? row.reminder_schedule_days_json.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
    : null;
  const fieldValues =
    row.field_values_json &&
    typeof row.field_values_json === 'object' &&
    !Array.isArray(row.field_values_json)
      ? structuredClone(row.field_values_json as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    tenantId: row.tenant_id,
    registerTypeKey: row.register_type_key,
    reference: row.reference,
    title: row.title,
    status: row.status,
    matterId: row.matter_id,
    enquiryId: row.enquiry_id,
    personId: row.person_id,
    organisationId: row.organisation_id,
    ownerId: row.owner_id,
    assignedApproverId: row.assigned_approver_id,
    decidedById: row.decided_by_id,
    decidedAt: row.decided_at ? toIsoString(row.decided_at) : null,
    dueAt: row.due_at ? toIsoString(row.due_at) : null,
    reviewAt: row.review_at ? toIsoString(row.review_at) : null,
    reminderScheduleDays: reminderDays,
    fieldValues,
    rowVersion: Number(row.row_version),
    createdById: row.created_by_id,
    createdAt: toIsoString(row.created_at),
    updatedById: row.updated_by_id,
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapRegisterTransitionRow(row: DbRegisterTransitionRow): RegisterTransition {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    registerRecordId: row.register_record_id,
    registerTypeKey: row.register_type_key,
    transitionKey: row.transition_key,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorId: row.actor_id,
    comment: row.comment,
    payload:
      row.payload_json &&
      typeof row.payload_json === 'object' &&
      !Array.isArray(row.payload_json)
        ? structuredClone(row.payload_json as Record<string, unknown>)
        : {},
    correlationId: row.correlation_id,
    transitionedAt: toIsoString(row.transitioned_at),
  };
}

function mapRegisterReminderStateRow(
  row: DbRegisterReminderStateRow,
): RegisterReminderState {
  return {
    tenantId: row.tenant_id,
    registerRecordId: row.register_record_id,
    idempotencyKey: row.idempotency_key,
    triggerKind: row.trigger_kind,
    stageDaysBefore: Number(row.stage_days_before),
    lastNotifiedAt: row.last_notified_at ? toIsoString(row.last_notified_at) : null,
    lastSkippedReason: row.last_skipped_reason,
    metadata:
      row.metadata_json &&
      typeof row.metadata_json === 'object' &&
      !Array.isArray(row.metadata_json)
        ? structuredClone(row.metadata_json as Record<string, unknown>)
        : {},
    updatedAt: toIsoString(row.updated_at),
  };
}

export class TenantRegisterRepository extends TenantScopedRepository {
  private readonly auditRepo: TenantAuditRepository;

  public constructor(options: {
    poolManager?: TenantPostgresPoolManager;
    auditRepo?: TenantAuditRepository;
  } = {}) {
    super({ poolManager: options.poolManager });
    this.auditRepo =
      options.auditRepo ??
      new TenantAuditRepository({ poolManager: this.poolManager });
  }

  public async allocateNextRecordIds(
    ctx: TenantContext,
    count: number,
    options?: { idPrefix?: string; padDigits?: number },
  ): Promise<string[]> {
    if (!Number.isInteger(count) || count <= 0) {
      return [];
    }
    const prefix = options?.idPrefix?.trim() || 'REG';
    const padDigits = options?.padDigits ?? 6;
    const counterKey = `REG_${prefix}`;
    const likePattern = `${prefix}-%`;
    const regexPattern = `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([0-9]+)$`;
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < count; i++) {
        const res = await tx.query<{ tenant_id: string; last_value: string }>(
          `WITH seq AS (
             SELECT nextval('public.tenant_register_record_id_seq') AS val
           ),
           max_existing AS (
             SELECT COALESCE(
               MAX(
                 CASE
                   WHEN id ~ $3 THEN substring(id FROM $3)::bigint
                   WHEN reference ~ $3 THEN substring(reference FROM $3)::bigint
                   ELSE NULL
                 END
               ),
               0
             ) AS max_id
             FROM public.register_records
             WHERE tenant_id = $1 AND (id LIKE $4 OR reference LIKE $4)
           )
           INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
           SELECT $1, $2, GREATEST((SELECT val FROM seq), (SELECT max_id FROM max_existing) + 1)
           ON CONFLICT (tenant_id, counter_key) DO UPDATE
             SET last_value = GREATEST(
               public.tenant_record_sequences.last_value + 1,
               EXCLUDED.last_value,
               (SELECT max_id FROM max_existing) + 1
             )
           RETURNING tenant_id, last_value::text AS last_value`,
          [ctx.tenantId, counterKey, regexPattern, likePattern],
        );
        const row = res.rows[0]!;
        this.assertRowTenant(ctx, row.tenant_id, 'register_records.allocateNextRecordIds');
        out.push(`${prefix}-${String(Number(row.last_value)).padStart(padDigits, '0')}`);
      }
      return out;
    });
  }

  public async allocateNextRecordId(
    ctx: TenantContext,
    options?: { idPrefix?: string; padDigits?: number },
  ): Promise<string> {
    const [id] = await this.allocateNextRecordIds(ctx, 1, options);
    return id!;
  }

  private async allocateTransitionIdInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
  ): Promise<string> {
    const maxRes = await tx.query<{ max_num: string | null }>(
      `SELECT MAX(substring(id from '^RT-([0-9]+)$')::bigint)::text AS max_num
       FROM public.register_transitions
       WHERE tenant_id = $1 AND id ~ '^RT-[0-9]+$'`,
      [ctx.tenantId],
    );
    const maxExisting = Number(maxRes.rows[0]?.max_num ?? '0') || 0;
    const seqRes = await tx.query<{ next_val: string }>(
      `SELECT nextval('public.tenant_register_transition_id_seq')::text AS next_val`,
    );
    const seqNum = Number(seqRes.rows[0]?.next_val ?? '1') || 1;
    const num = Math.max(maxExisting + 1, seqNum);
    return `RT-${String(num).padStart(6, '0')}`;
  }

  public async upsertRegisterRecordInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    record: Omit<RegisterRecord, 'tenantId' | 'rowVersion' | 'createdAt' | 'updatedAt'> & {
      rowVersion?: number;
      createdAt?: string;
      updatedAt?: string;
    },
  ): Promise<RegisterRecord> {
    if (!record.id?.trim()) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
        'Register record id is required.',
      );
    }
    const existingCheck = await tx.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM public.register_records WHERE id = $1`,
      [record.id],
    );
    for (const r of existingCheck.rows) {
      if (r.tenant_id !== ctx.tenantId) {
        const err = new Error(
          `TENANCY_CROSS_TENANT_RECORD_ACCESS: Register record "${record.id}" belongs to another tenant.`,
        ) as Error & { code: string };
        err.code = 'TENANCY_CROSS_TENANT_RECORD_ACCESS';
        throw err;
      }
    }

    const nowIso = new Date().toISOString();
    const createdAt = record.createdAt || nowIso;
    const updatedAt = record.updatedAt || nowIso;
    const res = await tx.query<DbRegisterRecordRow>(
      `INSERT INTO public.register_records (
         tenant_id, id, register_type_key, reference, title, status,
         matter_id, enquiry_id, person_id, organisation_id,
         owner_id, assigned_approver_id, decided_by_id, decided_at,
         due_at, review_at, reminder_schedule_days_json, field_values_json,
         row_version, created_by_id, created_at, updated_by_id, updated_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14::timestamptz,
         $15::timestamptz, $16::timestamptz, $17::jsonb, $18::jsonb,
         $19, $20, $21::timestamptz, $22, $23::timestamptz
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         register_type_key = EXCLUDED.register_type_key,
         reference = EXCLUDED.reference,
         title = EXCLUDED.title,
         status = EXCLUDED.status,
         matter_id = EXCLUDED.matter_id,
         enquiry_id = EXCLUDED.enquiry_id,
         person_id = EXCLUDED.person_id,
         organisation_id = EXCLUDED.organisation_id,
         owner_id = EXCLUDED.owner_id,
         assigned_approver_id = EXCLUDED.assigned_approver_id,
         decided_by_id = EXCLUDED.decided_by_id,
         decided_at = EXCLUDED.decided_at,
         due_at = EXCLUDED.due_at,
         review_at = EXCLUDED.review_at,
         reminder_schedule_days_json = EXCLUDED.reminder_schedule_days_json,
         field_values_json = EXCLUDED.field_values_json,
         row_version = public.register_records.row_version + 1,
         updated_by_id = EXCLUDED.updated_by_id,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        ctx.tenantId,
        record.id,
        record.registerTypeKey,
        record.reference,
        record.title,
        record.status,
        record.matterId ?? null,
        record.enquiryId ?? null,
        record.personId ?? null,
        record.organisationId ?? null,
        record.ownerId ?? null,
        record.assignedApproverId ?? null,
        record.decidedById ?? null,
        record.decidedAt ?? null,
        record.dueAt ?? null,
        record.reviewAt ?? null,
        record.reminderScheduleDays ? JSON.stringify(record.reminderScheduleDays) : null,
        JSON.stringify(record.fieldValues ?? {}),
        record.rowVersion ?? 1,
        record.createdById || ctx.actorId || 'system',
        createdAt,
        record.updatedById || ctx.actorId || 'system',
        updatedAt,
      ],
    );
    const saved = res.rows[0]!;
    this.assertRowTenant(ctx, saved.tenant_id, 'register_records.upsert');
    return mapRegisterRecordRow(saved);
  }

  public async createRegisterRecord(
    ctx: TenantContext,
    input: {
      id: string;
      registerTypeKey: string;
      reference: string;
      title: string;
      status: string;
      matterId?: string | null;
      enquiryId?: string | null;
      personId?: string | null;
      organisationId?: string | null;
      ownerId?: string | null;
      assignedApproverId?: string | null;
      dueAt?: string | null;
      reviewAt?: string | null;
      reminderScheduleDays?: readonly number[] | null;
      fieldValues: Record<string, unknown>;
      createdById: string;
    },
    options?: {
      auditEntries?: readonly FirmAuditEntryInput[];
      recordInitialTransition?: boolean;
    },
  ): Promise<RegisterRecord> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const nowIso = new Date().toISOString();
      const saved = await this.upsertRegisterRecordInTx(tx, ctx, {
        id: input.id,
        registerTypeKey: input.registerTypeKey,
        reference: input.reference,
        title: input.title,
        status: input.status,
        matterId: input.matterId ?? null,
        enquiryId: input.enquiryId ?? null,
        personId: input.personId ?? null,
        organisationId: input.organisationId ?? null,
        ownerId: input.ownerId ?? input.createdById,
        assignedApproverId: input.assignedApproverId ?? null,
        decidedById: null,
        decidedAt: null,
        dueAt: input.dueAt ?? null,
        reviewAt: input.reviewAt ?? null,
        reminderScheduleDays: input.reminderScheduleDays ?? null,
        fieldValues: input.fieldValues,
        createdById: input.createdById,
        createdAt: nowIso,
        updatedById: input.createdById,
        updatedAt: nowIso,
      });

      if (options?.recordInitialTransition !== false) {
        const trId = await this.allocateTransitionIdInTx(tx, ctx);
        await tx.query(
          `INSERT INTO public.register_transitions (
             tenant_id, id, register_record_id, register_type_key,
             transition_key, from_status, to_status, actor_id,
             comment, payload_json, correlation_id, transitioned_at
           )
           VALUES (
             $1, $2, $3, $4,
             $5, $6, $7, $8,
             $9, $10::jsonb, $11, $12::timestamptz
           )`,
          [
            ctx.tenantId,
            trId,
            saved.id,
            saved.registerTypeKey,
            'create',
            '',
            saved.status,
            input.createdById,
            null,
            JSON.stringify({ reference: saved.reference }),
            ctx.correlationId,
            nowIso,
          ],
        );
      }

      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return saved;
    });
  }

  public async putRegisterRecords(
    ctx: TenantContext,
    records: readonly RegisterRecord[],
  ): Promise<void> {
    if (records.length === 0) return;
    await this.withTenantTransaction(ctx, async (tx) => {
      for (const r of records) {
        await this.upsertRegisterRecordInTx(tx, ctx, r);
      }
    });
  }

  public async getRegisterRecordById(
    ctx: TenantContext,
    recordId: string,
    options?: { viewerId?: string; includeRestricted?: boolean },
  ): Promise<RegisterRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const viewerId = options?.viewerId ?? ctx.actorId;
      const res = includeRestricted
        ? await tx.query<DbRegisterRecordRow>(
            `SELECT * FROM public.register_records r WHERE r.tenant_id = $1 AND r.id = $2`,
            [ctx.tenantId, recordId],
          )
        : await tx.query<DbRegisterRecordRow>(
            `SELECT * FROM public.register_records r
             WHERE r.tenant_id = $1
               AND r.id = $3
               AND ${REGISTER_RECORD_VISIBLE_SQL_PREDICATE}`,
            [ctx.tenantId, viewerId, recordId],
          );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'register_records.getById');
      return mapRegisterRecordRow(row);
    });
  }

  public async listVisibleRegisterRecords(
    ctx: TenantContext,
    viewerId: string,
    options?: {
      registerTypeKey?: string;
      status?: string;
      matterId?: string;
      enquiryId?: string;
      includeRestricted?: boolean;
      limit?: number;
    },
  ): Promise<RegisterRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const params: unknown[] = includeRestricted
        ? [ctx.tenantId]
        : [ctx.tenantId, viewerId];
      const clauses: string[] = ['r.tenant_id = $1'];
      if (!includeRestricted) {
        clauses.push(REGISTER_RECORD_VISIBLE_SQL_PREDICATE);
      }
      if (options?.registerTypeKey) {
        params.push(options.registerTypeKey);
        clauses.push(`r.register_type_key = $${params.length}`);
      }
      if (options?.status) {
        params.push(options.status);
        clauses.push(`r.status = $${params.length}`);
      }
      if (options?.matterId) {
        params.push(options.matterId);
        clauses.push(`r.matter_id = $${params.length}`);
      }
      if (options?.enquiryId) {
        params.push(options.enquiryId);
        clauses.push(`r.enquiry_id = $${params.length}`);
      }
      let limitClause = '';
      if (options?.limit && options.limit > 0) {
        params.push(Math.floor(options.limit));
        limitClause = ` LIMIT $${params.length}`;
      }
      const res = await tx.query<DbRegisterRecordRow>(
        `SELECT * FROM public.register_records r
         WHERE ${clauses.join(' AND ')}
         ORDER BY r.updated_at DESC, r.created_at DESC, r.id ASC${limitClause}`,
        params,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'register_records.listVisible');
        return mapRegisterRecordRow(row);
      });
    });
  }

  public async listTransitionsForRecord(
    ctx: TenantContext,
    registerRecordId: string,
    options?: { viewerId?: string; includeRestricted?: boolean },
  ): Promise<RegisterTransition[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const viewerId = options?.viewerId ?? ctx.actorId;
      const recordVisible = includeRestricted
        ? await tx.query<{ tenant_id: string }>(
            `SELECT r.tenant_id FROM public.register_records r WHERE r.tenant_id = $1 AND r.id = $2`,
            [ctx.tenantId, registerRecordId],
          )
        : await tx.query<{ tenant_id: string }>(
            `SELECT r.tenant_id FROM public.register_records r
             WHERE r.tenant_id = $1 AND r.id = $3 AND ${REGISTER_RECORD_VISIBLE_SQL_PREDICATE}`,
            [ctx.tenantId, viewerId, registerRecordId],
          );
      if (!recordVisible.rows[0]) {
        return [];
      }
      this.assertRowTenant(ctx, recordVisible.rows[0].tenant_id, 'register_records.listTransitions.check');

      const res = await tx.query<DbRegisterTransitionRow>(
        `SELECT * FROM public.register_transitions
         WHERE tenant_id = $1 AND register_record_id = $2
         ORDER BY transitioned_at DESC, id DESC`,
        [ctx.tenantId, registerRecordId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'register_transitions.list');
        return mapRegisterTransitionRow(row);
      });
    });
  }

  public async updateRegisterRecordDetails(
    ctx: TenantContext,
    params: {
      recordId: string;
      expectedRowVersion?: number;
      title?: string;
      assignedApproverId?: string | null;
      dueAt?: string | null;
      reviewAt?: string | null;
      fieldValues?: Record<string, unknown>;
      updatedById: string;
      auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<{ previousRecord: RegisterRecord; updatedRecord: RegisterRecord }> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const lockRes = await tx.query<DbRegisterRecordRow>(
        `SELECT * FROM public.register_records
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [ctx.tenantId, params.recordId],
      );
      const lockedRow = lockRes.rows[0];
      if (!lockedRow) {
        throw createRegisterDomainError(
          REGISTER_DOMAIN_ERROR_CODES.NOT_FOUND,
          `Register record "${params.recordId}" not found.`,
        );
      }
      this.assertRowTenant(ctx, lockedRow.tenant_id, 'register_records.updateDetails.lock');
      const previousRecord = mapRegisterRecordRow(lockedRow);

      if (
        params.expectedRowVersion !== undefined &&
        previousRecord.rowVersion !== params.expectedRowVersion
      ) {
        throw createRegisterDomainError(
          REGISTER_DOMAIN_ERROR_CODES.CONCURRENCY_CONFLICT,
          `Register record "${params.recordId}" modified concurrently (expected ${params.expectedRowVersion}, actual ${previousRecord.rowVersion}).`,
        );
      }

      const nowIso = new Date().toISOString();
      const mergedFields = {
        ...previousRecord.fieldValues,
        ...(params.fieldValues ?? {}),
      };

      const updRes = await tx.query<DbRegisterRecordRow>(
        `UPDATE public.register_records
         SET title = $3,
             assigned_approver_id = $4,
             due_at = $5::timestamptz,
             review_at = $6::timestamptz,
             field_values_json = $7::jsonb,
             row_version = row_version + 1,
             updated_by_id = $8,
             updated_at = $9::timestamptz
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          params.recordId,
          params.title !== undefined ? params.title : previousRecord.title,
          params.assignedApproverId !== undefined
            ? params.assignedApproverId
            : previousRecord.assignedApproverId,
          params.dueAt !== undefined ? params.dueAt : previousRecord.dueAt,
          params.reviewAt !== undefined ? params.reviewAt : previousRecord.reviewAt,
          JSON.stringify(mergedFields),
          params.updatedById,
          nowIso,
        ],
      );
      const updatedRow = updRes.rows[0]!;
      this.assertRowTenant(ctx, updatedRow.tenant_id, 'register_records.updateDetails.return');

      if (params.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, params.auditEntries);
      }

      return {
        previousRecord,
        updatedRecord: mapRegisterRecordRow(updatedRow),
      };
    });
  }

  public async lockAndExecuteTransition(
    ctx: TenantContext,
    params: {
      recordId: string;
      transitionKey: string;
      actorId: string;
      comment: string | null;
      validateAndCompute: (lockedRecord: RegisterRecord) =>
        | {
            nextStatus: string;
            setsDecidedAt: boolean;
            mergedFieldValues: Record<string, unknown>;
            extraPayload?: Record<string, unknown>;
          }
        | Promise<{
            nextStatus: string;
            setsDecidedAt: boolean;
            mergedFieldValues: Record<string, unknown>;
            extraPayload?: Record<string, unknown>;
          }>;
      buildAuditEntries?: (result: {
        previousRecord: RegisterRecord;
        updatedRecord: RegisterRecord;
        transition: RegisterTransition;
      }) => readonly FirmAuditEntryInput[];
    },
  ): Promise<{
    previousRecord: RegisterRecord;
    updatedRecord: RegisterRecord;
    transition: RegisterTransition;
  }> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const lockRes = await tx.query<DbRegisterRecordRow>(
        `SELECT * FROM public.register_records
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [ctx.tenantId, params.recordId],
      );
      const lockedRow = lockRes.rows[0];
      if (!lockedRow) {
        throw createRegisterDomainError(
          REGISTER_DOMAIN_ERROR_CODES.NOT_FOUND,
          `Register record "${params.recordId}" not found.`,
        );
      }
      this.assertRowTenant(ctx, lockedRow.tenant_id, 'register_records.transition.lock');
      const previousRecord = mapRegisterRecordRow(lockedRow);

      const computed = await params.validateAndCompute(previousRecord);
      const nowIso = new Date().toISOString();
      const decidedById = computed.setsDecidedAt
        ? params.actorId
        : previousRecord.decidedById;
      const decidedAt = computed.setsDecidedAt ? nowIso : previousRecord.decidedAt;

      const updRes = await tx.query<DbRegisterRecordRow>(
        `UPDATE public.register_records
         SET status = $3,
             decided_by_id = $4,
             decided_at = $5::timestamptz,
             field_values_json = $6::jsonb,
             row_version = row_version + 1,
             updated_by_id = $7,
             updated_at = $8::timestamptz
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          params.recordId,
          computed.nextStatus,
          decidedById,
          decidedAt,
          JSON.stringify(computed.mergedFieldValues),
          params.actorId,
          nowIso,
        ],
      );
      const updatedRow = updRes.rows[0]!;
      this.assertRowTenant(ctx, updatedRow.tenant_id, 'register_records.transition.update');
      const updatedRecord = mapRegisterRecordRow(updatedRow);

      const transitionId = await this.allocateTransitionIdInTx(tx, ctx);
      const trRes = await tx.query<DbRegisterTransitionRow>(
        `INSERT INTO public.register_transitions (
           tenant_id, id, register_record_id, register_type_key,
           transition_key, from_status, to_status, actor_id,
           comment, payload_json, correlation_id, transitioned_at
         )
         VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8,
           $9, $10::jsonb, $11, $12::timestamptz
         )
         RETURNING *`,
        [
          ctx.tenantId,
          transitionId,
          updatedRecord.id,
          updatedRecord.registerTypeKey,
          params.transitionKey,
          previousRecord.status,
          updatedRecord.status,
          params.actorId,
          params.comment,
          JSON.stringify(computed.extraPayload ?? {}),
          ctx.correlationId,
          nowIso,
        ],
      );
      const transitionRow = trRes.rows[0]!;
      this.assertRowTenant(ctx, transitionRow.tenant_id, 'register_transitions.insert');
      const transition = mapRegisterTransitionRow(transitionRow);

      if (params.buildAuditEntries) {
        const auditEntries = params.buildAuditEntries({
          previousRecord,
          updatedRecord,
          transition,
        });
        if (auditEntries.length > 0) {
          await this.auditRepo.appendAuditEntries(ctx, auditEntries);
        }
      }

      return {
        previousRecord,
        updatedRecord,
        transition,
      };
    });
  }

  public async listReminderCandidateRecords(
    ctx: TenantContext,
  ): Promise<RegisterRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbRegisterRecordRow>(
        `SELECT * FROM public.register_records
         WHERE tenant_id = $1
           AND (due_at IS NOT NULL OR review_at IS NOT NULL)
         ORDER BY COALESCE(due_at, review_at) ASC, id ASC`,
        [ctx.tenantId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'register_records.reminderCandidates');
        return mapRegisterRecordRow(row);
      });
    });
  }

  public async listReminderStatesForTenant(
    ctx: TenantContext,
  ): Promise<RegisterReminderState[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbRegisterReminderStateRow>(
        `SELECT * FROM public.register_reminder_states
         WHERE tenant_id = $1
         ORDER BY updated_at DESC`,
        [ctx.tenantId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'register_reminder_states.list');
        return mapRegisterReminderStateRow(row);
      });
    });
  }

  public async tryAcquireReminderDispatchInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    input: {
      registerRecordId: string;
      idempotencyKey: string;
      triggerKind: RegisterReminderTriggerKind;
      stageDaysBefore: number;
      lastNotifiedAt: string | null;
      lastSkippedReason: RegisterReminderSkippedReason | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const res = await tx.query<{ tenant_id: string }>(
      `INSERT INTO public.register_reminder_states (
         tenant_id, register_record_id, idempotency_key, trigger_kind,
         stage_days_before, last_notified_at, last_skipped_reason,
         metadata_json, updated_at
       )
       VALUES (
         $1, $2, $3, $4,
         $5, $6::timestamptz, $7,
         $8::jsonb, NOW()
       )
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING tenant_id`,
      [
        ctx.tenantId,
        input.registerRecordId,
        input.idempotencyKey,
        input.triggerKind,
        input.stageDaysBefore,
        input.lastNotifiedAt,
        input.lastSkippedReason,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    for (const row of res.rows) {
      this.assertRowTenant(ctx, row.tenant_id, 'register_reminder_states.tryAcquire');
    }
    return res.rowCount > 0;
  }

  public async deleteRegisterRecordById(
    ctx: TenantContext,
    recordId: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        `DELETE FROM public.register_records WHERE tenant_id = $1 AND id = $2 RETURNING tenant_id`,
        [ctx.tenantId, recordId],
      );
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'register_records.delete');
      }
      return res.rowCount > 0;
    });
  }

  public async countAllTenantRegisterRows(ctx: TenantContext): Promise<{
    registerRecords: number;
    registerTransitions: number;
    registerReminderStates: number;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [recRes, trRes, remRes] = await Promise.all([
        tx.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM public.register_records WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
        tx.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM public.register_transitions WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
        tx.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM public.register_reminder_states WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
      ]);
      return {
        registerRecords: Number(recRes.rows[0]?.count ?? '0'),
        registerTransitions: Number(trRes.rows[0]?.count ?? '0'),
        registerReminderStates: Number(remRes.rows[0]?.count ?? '0'),
      };
    });
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(`DELETE FROM public.register_reminder_states WHERE tenant_id = $1`, [
        ctx.tenantId,
      ]);
      await tx.query(`DELETE FROM public.register_transitions WHERE tenant_id = $1`, [
        ctx.tenantId,
      ]);
      await tx.query(`DELETE FROM public.register_records WHERE tenant_id = $1`, [
        ctx.tenantId,
      ]);
    });
  }
}
