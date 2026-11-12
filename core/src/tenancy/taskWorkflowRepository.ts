/**
 * Tenant-Scoped Task, Notification, Sign-Off & Recently-Viewed Repository
 * (`core/src/tenancy/taskWorkflowRepository.ts`).
 *
 * Enforces ADR 0028 & Platform Architecture Standard §§4, 7, 8 (`R401`, `R402`, `R403`, `S0-17a`):
 * 1. Every read (`withTenantReadTransaction`) and write (`withTenantTransaction`) executes
 *    inside an explicit transaction after `SET LOCAL ROLE "<role_tenant_slug_env>"`.
 * 2. Every query predicates on `tenant_id = $1` bound from verified `TenantContext.tenantId`,
 *    and every returned row is verified via `this.assertRowTenant(row, ctx)`.
 * 3. Data-layer visibility filtering hides:
 *    - Tasks linked (`task_linked_records` or `linked_key_date_id`) to a restricted matter,
 *      a hidden enquiry (including personal Drafts or enquiries converted into restricted matters),
 *      a hidden quote (including quotes converted into restricted matters), or a key date on a restricted matter.
 *    - Sign-off requests on a restricted matter unless `viewerId` is in `matters.restricted_access_user_ids_json`.
 *    - Notifications and recently-viewed IDs referencing a record hidden from `viewerId`.
 * 4. Sequence allocation (`TSK-`, `NTF-`, `SO-`) uses `tenant_task_id_seq`,
 *    `tenant_notification_id_seq`, `tenant_sign_off_id_seq`, and `tenant_record_sequences` without `setval` (`R460`).
 */

import type {
  FirmAuditEntryInput as AppendTenantAuditEntryInput,
  TenantContext,
} from '../api/index';
import type { TenantPostgresPoolManager } from './postgresPoolManager';
import {
  TenantScopedRepository,
  type TenantSqlClient,
} from './tenantScopedRepository';
import { TenantAuditRepository } from './auditRepository';
import {
  ENQUIRY_VISIBLE_SQL_PREDICATE,
  QUOTE_VISIBLE_SQL_PREDICATE,
} from './intakeQuoteRepository';
export interface TenantTaskLinkedRecord {
  recordType: 'matter' | 'person' | 'organisation' | 'enquiry' | 'quote';
  recordId: string;
}

export interface TenantTaskCommentRecord {
  id: string;
  authorId: string;
  at: string;
  text: string;
}

export interface TenantTaskChecklistItemRecord {
  id: string;
  text: string;
  completed: boolean;
  completedById?: string | null;
  completedAt?: string | null;
}

export interface TenantTaskRecord {
  id: string;
  reference: string;
  title: string;
  description: string;
  taskTypeId: string;
  priorityId: string;
  dueAt: string;
  assignedTeamId: string | null;
  assignedPersonId: string | null;
  assignedPersonIds?: string[];
  multiAssigneeMode?: 'shared' | 'separate';
  status: 'To do' | 'In progress' | 'Waiting' | 'Done' | 'Cancelled';
  linkedRecords: TenantTaskLinkedRecord[];
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
  completedById: string | null;
  completedAt: string | null;
  comments: TenantTaskCommentRecord[];
  checklist?: TenantTaskChecklistItemRecord[];
  autoTrigger?: 'enquiry_contact' | 'non_engagement_letter' | 'complete_matter_opening' | null;
  linkedKeyDateId?: string | null;
  idempotencyKey?: string | null;
  systemKey?: string | null;
}

export interface TenantNotificationRecord {
  id: string;
  recipientId: string;
  kind: string;
  title: string;
  detail: string;
  href: string;
  recordId: string;
  byId?: string | null;
  createdAt: string;
  read: boolean;
  readAt?: string | null;
}

export interface TenantSignOffRecord {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  summary?: string;
  matterId?: string | null;
  matterNumber?: string;
  amountGbp?: number;
  requestedById: string;
  requestedAt: string;
  assignedPartnerId?: string | null;
  approverRole?: string;
  status: string;
  approvedById?: string | null;
  approvedAt?: string | null;
  discussionNote?: string | null;
}

interface TaskRow extends Record<string, unknown> {
  tenant_id: string;
  id: string;
  reference: string;
  title: string;
  description: string;
  status: string;
  task_type_id: string | null;
  priority_id: string | null;
  due_at: string | null;
  assigned_team_id: string | null;
  assigned_person_id: string | null;
  multi_assignee_mode: string | null;
  linked_key_date_id: string | null;
  system_key: string | null;
  auto_trigger: string | null;
  created_by_id: string | null;
  updated_by_id: string | null;
  completed_by_id: string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  assigned_person_ids_json: string[] | null;
  linked_records_json: TenantTaskLinkedRecord[] | null;
  comments_json: TenantTaskCommentRecord[] | null;
  checklist_json: TenantTaskChecklistItemRecord[] | null;
  profile_json: Record<string, unknown> | null;
}

interface TaskLinkedRecordRow extends Record<string, unknown> {
  tenant_id: string;
  task_id: string;
  record_type: string;
  record_id: string;
  sort_order: number;
}

interface NotificationRow extends Record<string, unknown> {
  tenant_id: string;
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  href: string;
  record_id: string;
  by_id: string | null;
  read: boolean;
  read_at: Date | string | null;
  created_at: Date | string;
  metadata_json: Record<string, unknown> | null;
}

interface SignOffRow extends Record<string, unknown> {
  tenant_id: string;
  id: string;
  kind: string;
  status: string;
  matter_id: string | null;
  matter_number: string | null;
  title: string;
  subtitle: string;
  requested_by_id: string | null;
  assigned_approver_id: string | null;
  decided_by_id: string | null;
  amount_gbp: string | number | null;
  requested_at: Date | string;
  decided_at: Date | string | null;
  discussion_note: string | null;
  payload_json: Record<string, unknown> | null;
}

interface RecentlyViewedRow extends Record<string, unknown> {
  tenant_id: string;
  user_id: string;
  items_json: string[] | null;
  updated_at: Date | string;
}

function toIsoString(value: Date | string | null | undefined): string {
  if (!value) {
    return new Date(0).toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function toNullableIsoString(
  value: Date | string | null | undefined,
  fallback?: string | null,
): string | null {
  if (fallback !== undefined && fallback !== null) {
    return fallback;
  }
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function createTaskWorkflowError(
  code: string,
  message: string,
): Error & { code: string } {
  const err = new Error(`${code}: ${message}`) as Error & { code: string };
  err.code = code;
  return err;
}

function mapRowToTask(
  row: TaskRow,
  linkedRows?: readonly TaskLinkedRecordRow[],
): TenantTaskRecord {
  const profile =
    row.profile_json && typeof row.profile_json === 'object'
      ? (structuredClone(row.profile_json) as Partial<TenantTaskRecord>)
      : {};
  const linkedRecords: TenantTaskLinkedRecord[] =
    linkedRows && linkedRows.length > 0
      ? linkedRows.map((lr) => ({
          recordType: lr.record_type as TenantTaskLinkedRecord['recordType'],
          recordId: lr.record_id,
        }))
      : Array.isArray(row.linked_records_json)
        ? structuredClone(row.linked_records_json)
        : Array.isArray(profile.linkedRecords)
          ? structuredClone(profile.linkedRecords)
          : [];

  const assignedPersonIds = Array.isArray(row.assigned_person_ids_json)
    ? [...row.assigned_person_ids_json]
    : profile.assignedPersonIds
      ? [...profile.assignedPersonIds]
      : undefined;

  const checklist = Array.isArray(row.checklist_json)
    ? structuredClone(row.checklist_json)
    : profile.checklist
      ? structuredClone(profile.checklist)
      : undefined;

  const result: TenantTaskRecord = {
    ...profile,
    id: row.id,
    reference: row.reference || profile.reference || row.id,
    title: row.title ?? profile.title ?? '',
    description: row.description ?? profile.description ?? '',
    taskTypeId: row.task_type_id ?? profile.taskTypeId ?? '',
    priorityId: row.priority_id ?? profile.priorityId ?? '',
    dueAt: row.due_at ?? profile.dueAt ?? '',
    assignedTeamId:
      row.assigned_team_id !== undefined
        ? row.assigned_team_id
        : (profile.assignedTeamId ?? null),
    assignedPersonId:
      row.assigned_person_id !== undefined
        ? row.assigned_person_id
        : (profile.assignedPersonId ?? null),
    status: (row.status || profile.status || 'To do') as TenantTaskRecord['status'],
    linkedRecords,
    createdById: row.created_by_id ?? profile.createdById ?? '',
    createdAt:
      typeof profile.createdAt === 'string' && profile.createdAt
        ? profile.createdAt
        : toIsoString(row.created_at),
    updatedById: row.updated_by_id ?? profile.updatedById ?? '',
    updatedAt:
      typeof profile.updatedAt === 'string' && profile.updatedAt
        ? profile.updatedAt
        : toIsoString(row.updated_at),
    completedById:
      row.completed_by_id !== undefined
        ? row.completed_by_id
        : (profile.completedById ?? null),
    completedAt: toNullableIsoString(row.completed_at, profile.completedAt),
    comments: Array.isArray(row.comments_json)
      ? structuredClone(row.comments_json)
      : Array.isArray(profile.comments)
        ? structuredClone(profile.comments)
        : [],
  };

  if (
    assignedPersonIds !== undefined &&
    (assignedPersonIds.length > 0 || profile.assignedPersonIds !== undefined)
  ) {
    result.assignedPersonIds = assignedPersonIds;
  }
  if (row.multi_assignee_mode || profile.multiAssigneeMode) {
    result.multiAssigneeMode = (row.multi_assignee_mode ??
      profile.multiAssigneeMode) as 'shared' | 'separate';
  }
  if (
    checklist !== undefined &&
    (checklist.length > 0 || profile.checklist !== undefined)
  ) {
    result.checklist = checklist;
  }
  if (row.auto_trigger !== null || profile.autoTrigger !== undefined) {
    result.autoTrigger = (row.auto_trigger ??
      profile.autoTrigger ??
      null) as TenantTaskRecord['autoTrigger'];
  }
  if (row.linked_key_date_id !== null || profile.linkedKeyDateId !== undefined) {
    result.linkedKeyDateId =
      row.linked_key_date_id ?? profile.linkedKeyDateId ?? null;
  }
  if (row.system_key !== null || profile.systemKey !== undefined) {
    result.systemKey = row.system_key ?? profile.systemKey ?? null;
  }
  return result;
}

function mapRowToNotification(row: NotificationRow): TenantNotificationRecord {
  const meta =
    row.metadata_json && typeof row.metadata_json === 'object'
      ? (structuredClone(row.metadata_json) as Partial<TenantNotificationRecord>)
      : {};
  const result: TenantNotificationRecord = {
    ...meta,
    id: row.id,
    recipientId: row.user_id,
    kind: row.kind,
    title: row.title,
    detail: row.body,
    href: row.href,
    recordId: row.record_id,
    byId: row.by_id ?? null,
    createdAt:
      typeof meta.createdAt === 'string' && meta.createdAt
        ? meta.createdAt
        : toIsoString(row.created_at),
    read: Boolean(row.read),
  };
  if (row.read_at !== null && row.read_at !== undefined) {
    result.readAt = toIsoString(row.read_at);
  }
  return result;
}

function mapRowToSignOff(row: SignOffRow): TenantSignOffRecord {
  const payload =
    row.payload_json && typeof row.payload_json === 'object'
      ? (structuredClone(row.payload_json) as Partial<TenantSignOffRecord>)
      : {};
  const result: TenantSignOffRecord = {
    ...payload,
    id: row.id,
    kind: row.kind,
    title: row.title,
    subtitle: row.subtitle,
    requestedById: row.requested_by_id ?? payload.requestedById ?? '',
    requestedAt:
      typeof payload.requestedAt === 'string' && payload.requestedAt
        ? payload.requestedAt
        : toIsoString(row.requested_at),
    assignedPartnerId:
      row.assigned_approver_id !== undefined
        ? row.assigned_approver_id
        : (payload.assignedPartnerId ?? null),
    status: row.status,
  };
  if (row.matter_id !== null && row.matter_id !== undefined) {
    result.matterId = row.matter_id;
  } else {
    delete result.matterId;
  }
  if (row.matter_number !== null && row.matter_number !== undefined) {
    result.matterNumber = row.matter_number;
  }
  if (row.amount_gbp !== null && row.amount_gbp !== undefined) {
    result.amountGbp = Number(row.amount_gbp);
  }
  if (row.decided_by_id !== null && row.decided_by_id !== undefined) {
    result.approvedById = row.decided_by_id;
  }
  if (row.decided_at !== null && row.decided_at !== undefined) {
    result.approvedAt =
      typeof payload.approvedAt === 'string' && payload.approvedAt
        ? payload.approvedAt
        : toIsoString(row.decided_at);
  }
  if (row.discussion_note !== null && row.discussion_note !== undefined) {
    result.discussionNote = row.discussion_note;
  }
  return result;
}

/**
 * SQL predicate returning TRUE when a task row `t` (`t.tenant_id = $1`) is visible to `viewerId` (`$2`).
 */
export const TASK_VISIBLE_SQL_PREDICATE = `(
  (
    t.linked_key_date_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM key_dates kd
      LEFT JOIN matters km
        ON km.tenant_id = kd.tenant_id AND km.id = kd.matter_id
      LEFT JOIN enquiries ke
        ON ke.tenant_id = kd.tenant_id AND ke.id = kd.enquiry_id
      WHERE kd.tenant_id = t.tenant_id
        AND kd.id = t.linked_key_date_id
        AND (
          (
            km.id IS NOT NULL
            AND (km.is_staff_matter = TRUE OR km.has_ethical_wall = TRUE)
            AND NOT (km.restricted_access_user_ids_json ? $2)
          )
          OR (
            ke.id IS NOT NULL
            AND NOT (
              (ke.status <> 'Draft' OR ke.created_by_id = $2)
              AND (
                ke.converted_matter_id IS NULL
                OR NOT EXISTS (
                  SELECT 1 FROM matters kem
                  WHERE kem.tenant_id = ke.tenant_id
                    AND kem.id = ke.converted_matter_id
                    AND (kem.is_staff_matter = TRUE OR kem.has_ethical_wall = TRUE)
                    AND NOT (kem.restricted_access_user_ids_json ? $2)
                )
              )
            )
          )
        )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM task_linked_records tlr
    JOIN matters m
      ON m.tenant_id = tlr.tenant_id
     AND m.id = tlr.record_id
    WHERE tlr.tenant_id = t.tenant_id
      AND tlr.task_id = t.id
      AND tlr.record_type = 'matter'
      AND (m.is_staff_matter = TRUE OR m.has_ethical_wall = TRUE)
      AND NOT (m.restricted_access_user_ids_json ? $2)
  )
  AND NOT EXISTS (
    SELECT 1 FROM task_linked_records tlr
    JOIN enquiries e
      ON e.tenant_id = tlr.tenant_id
     AND e.id = tlr.record_id
    WHERE tlr.tenant_id = t.tenant_id
      AND tlr.task_id = t.id
      AND tlr.record_type = 'enquiry'
      AND NOT ${ENQUIRY_VISIBLE_SQL_PREDICATE}
  )
  AND NOT EXISTS (
    SELECT 1 FROM task_linked_records tlr
    JOIN quotes q
      ON q.tenant_id = tlr.tenant_id
     AND q.id = tlr.record_id
    WHERE tlr.tenant_id = t.tenant_id
      AND tlr.task_id = t.id
      AND tlr.record_type = 'quote'
      AND NOT ${QUOTE_VISIBLE_SQL_PREDICATE}
  )
)`;

/**
 * SQL predicate returning TRUE when a sign-off row `s` (`s.tenant_id = $1`) is visible to `viewerId` (`$2`).
 */
export const SIGN_OFF_VISIBLE_SQL_PREDICATE = `(
  s.matter_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM matters m
    WHERE m.tenant_id = s.tenant_id
      AND m.id = s.matter_id
      AND (m.is_staff_matter = TRUE OR m.has_ethical_wall = TRUE)
      AND NOT (m.restricted_access_user_ids_json ? $2)
  )
)`;

export class TenantTaskWorkflowRepository extends TenantScopedRepository {
  private readonly auditRepo: TenantAuditRepository;

  public constructor(options?: {
    poolManager?: TenantPostgresPoolManager;
    requiredSchemaVersion?: string;
    statementTimeoutMs?: number;
  }) {
    super(options);
    this.auditRepo = new TenantAuditRepository(options);
  }

  // ---------------------------------------------------------------------------
  // Sequence Allocation (`TSK-`, `NTF-`, `SO-`, `R460`)
  // ---------------------------------------------------------------------------

  private async allocateSequenceIds(
    ctx: TenantContext,
    params: {
      prefix: 'TSK' | 'NTF' | 'SO';
      sequenceName:
        | 'tenant_task_id_seq'
        | 'tenant_notification_id_seq'
        | 'tenant_sign_off_id_seq';
      tableName: 'tasks' | 'notifications' | 'sign_offs';
      count: number;
      padDigits: number;
    },
  ): Promise<string[]> {
    const safeCount = Math.max(0, Math.floor(params.count));
    if (safeCount === 0) {
      return [];
    }
    const regex = `^${params.prefix}-([0-9]+)$`;
    return this.withTenantTransaction(ctx, async (tx) => {
      const results: string[] = [];
      for (let i = 0; i < safeCount; i++) {
        const res = await tx.query<{ tenant_id: string; last_value: string }>(
          `WITH seq AS (
             SELECT nextval('${params.sequenceName}') AS val
           ),
           max_existing AS (
             SELECT COALESCE(
               MAX(SUBSTRING(id FROM $3)::bigint),
               0
             ) AS max_id
             FROM ${params.tableName}
             WHERE tenant_id = $1 AND id ~ $3
           )
           INSERT INTO tenant_record_sequences (tenant_id, counter_key, last_value)
           SELECT $1, $2, GREATEST((SELECT val FROM seq), (SELECT max_id FROM max_existing) + 1)
           ON CONFLICT (tenant_id, counter_key) DO UPDATE
             SET last_value = GREATEST(
               tenant_record_sequences.last_value + 1,
               EXCLUDED.last_value,
               (SELECT max_id FROM max_existing) + 1
             )
           RETURNING tenant_id, last_value::text AS last_value`,
          [ctx.tenantId, params.prefix, regex],
        );
        const row = res.rows[0];
        if (!row) {
          throw createTaskWorkflowError(
            'TASK_SEQUENCE_ERROR',
            `Failed to allocate next ${params.prefix} ID.`,
          );
        }
        this.assertRowTenant(ctx, row.tenant_id, `tenant_record_sequences.${params.prefix}`);
        results.push(
          `${params.prefix}-${String(Number(row.last_value)).padStart(params.padDigits, '0')}`,
        );
      }
      return results;
    });
  }

  public async allocateNextTaskIds(
    ctx: TenantContext,
    count: number,
    options?: { padDigits?: number },
  ): Promise<string[]> {
    return this.allocateSequenceIds(ctx, {
      prefix: 'TSK',
      sequenceName: 'tenant_task_id_seq',
      tableName: 'tasks',
      count,
      padDigits: options?.padDigits ?? 6,
    });
  }

  public async allocateNextTaskId(
    ctx: TenantContext,
    options?: { padDigits?: number },
  ): Promise<string> {
    const [id] = await this.allocateNextTaskIds(ctx, 1, options);
    return id!;
  }

  public async allocateNextNotificationIds(
    ctx: TenantContext,
    count: number,
    options?: { padDigits?: number },
  ): Promise<string[]> {
    return this.allocateSequenceIds(ctx, {
      prefix: 'NTF',
      sequenceName: 'tenant_notification_id_seq',
      tableName: 'notifications',
      count,
      padDigits: options?.padDigits ?? 6,
    });
  }

  public async allocateNextNotificationId(
    ctx: TenantContext,
    options?: { padDigits?: number },
  ): Promise<string> {
    const [id] = await this.allocateNextNotificationIds(ctx, 1, options);
    return id!;
  }

  public async allocateNextSignOffIds(
    ctx: TenantContext,
    count: number,
    options?: { padDigits?: number },
  ): Promise<string[]> {
    return this.allocateSequenceIds(ctx, {
      prefix: 'SO',
      sequenceName: 'tenant_sign_off_id_seq',
      tableName: 'sign_offs',
      count,
      padDigits: options?.padDigits ?? 6,
    });
  }

  public async allocateNextSignOffId(
    ctx: TenantContext,
    options?: { padDigits?: number },
  ): Promise<string> {
    const [id] = await this.allocateNextSignOffIds(ctx, 1, options);
    return id!;
  }

  // ---------------------------------------------------------------------------
  // Tasks CRUD & Queries (`tasks` + `task_linked_records`)
  // ---------------------------------------------------------------------------

  public async upsertTaskInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    task: TenantTaskRecord,
  ): Promise<void> {
    if (!task?.id?.trim()) {
      throw createTaskWorkflowError('TASK_VALIDATION_ERROR', 'Task id is required.');
    }
    const existingCheck = await tx.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tasks WHERE id = $1`,
      [task.id],
    );
    for (const r of existingCheck.rows) {
      if (r.tenant_id !== ctx.tenantId) {
        throw createTaskWorkflowError(
          'TENANCY_CROSS_TENANT_RECORD_ACCESS',
          `Task "${task.id}" belongs to another tenant.`,
        );
      }
    }

    const nowIso = new Date().toISOString();
    const createdAt = task.createdAt || nowIso;
    const updatedAt = task.updatedAt || nowIso;
    const linkedRecords = Array.isArray(task.linkedRecords)
      ? task.linkedRecords
      : [];

    await tx.query(
      `INSERT INTO tasks (
         tenant_id, id, reference, title, description, status,
         task_type_id, priority_id, due_at,
         assigned_team_id, assigned_person_id, multi_assignee_mode,
         linked_key_date_id, system_key, auto_trigger,
         created_by_id, updated_by_id, completed_by_id,
         completed_at, created_at, updated_at,
         assigned_person_ids_json, linked_records_json,
         comments_json, checklist_json, profile_json
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9,
         $10, $11, $12,
         $13, $14, $15,
         $16, $17, $18,
         $19::timestamptz, $20::timestamptz, $21::timestamptz,
         $22::jsonb, $23::jsonb,
         $24::jsonb, $25::jsonb, $26::jsonb
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         reference = EXCLUDED.reference,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         task_type_id = EXCLUDED.task_type_id,
         priority_id = EXCLUDED.priority_id,
         due_at = EXCLUDED.due_at,
         assigned_team_id = EXCLUDED.assigned_team_id,
         assigned_person_id = EXCLUDED.assigned_person_id,
         multi_assignee_mode = EXCLUDED.multi_assignee_mode,
         linked_key_date_id = EXCLUDED.linked_key_date_id,
         system_key = EXCLUDED.system_key,
         auto_trigger = EXCLUDED.auto_trigger,
         created_by_id = EXCLUDED.created_by_id,
         updated_by_id = EXCLUDED.updated_by_id,
         completed_by_id = EXCLUDED.completed_by_id,
         completed_at = EXCLUDED.completed_at,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         assigned_person_ids_json = EXCLUDED.assigned_person_ids_json,
         linked_records_json = EXCLUDED.linked_records_json,
         comments_json = EXCLUDED.comments_json,
         checklist_json = EXCLUDED.checklist_json,
         profile_json = EXCLUDED.profile_json`,
      [
        ctx.tenantId,
        task.id,
        task.reference || task.id,
        task.title ?? '',
        task.description ?? '',
        task.status || 'To do',
        task.taskTypeId || null,
        task.priorityId || null,
        task.dueAt || null,
        task.assignedTeamId ?? null,
        task.assignedPersonId ?? null,
        task.multiAssigneeMode ?? null,
        task.linkedKeyDateId ?? null,
        task.systemKey ?? null,
        task.autoTrigger ?? null,
        task.createdById || null,
        task.updatedById || null,
        task.completedById ?? null,
        task.completedAt ?? null,
        createdAt,
        updatedAt,
        JSON.stringify(task.assignedPersonIds ?? []),
        JSON.stringify(linkedRecords),
        JSON.stringify(task.comments ?? []),
        JSON.stringify(task.checklist ?? []),
        JSON.stringify(task),
      ],
    );

    await tx.query(
      `DELETE FROM task_linked_records WHERE tenant_id = $1 AND task_id = $2`,
      [ctx.tenantId, task.id],
    );

    const seenKeys = new Set<string>();
    for (let idx = 0; idx < linkedRecords.length; idx++) {
      const lr = linkedRecords[idx]!;
      if (!lr?.recordType || !lr?.recordId) continue;
      const dedupeKey = `${lr.recordType}::${lr.recordId}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      await tx.query(
        `INSERT INTO task_linked_records (tenant_id, task_id, record_type, record_id, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [ctx.tenantId, task.id, lr.recordType, lr.recordId, idx],
      );
    }  }

  private async loadTaskLinkedRecordsInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    taskIds: readonly string[],
  ): Promise<Map<string, TaskLinkedRecordRow[]>> {
    const byTaskId = new Map<string, TaskLinkedRecordRow[]>();
    if (taskIds.length === 0) {
      return byTaskId;
    }
    const res = await tx.query<TaskLinkedRecordRow>(
      `SELECT tenant_id, task_id, record_type, record_id, sort_order
       FROM task_linked_records
       WHERE tenant_id = $1 AND task_id = ANY($2::text[])
       ORDER BY task_id ASC, sort_order ASC`,
      [ctx.tenantId, taskIds],
    );
    for (const row of res.rows) {
      this.assertRowTenant(ctx, row.tenant_id, 'task_linked_records');
      const list = byTaskId.get(row.task_id) ?? [];
      list.push(row);
      byTaskId.set(row.task_id, list);
    }
    return byTaskId;
  }

  public async putTask<T = TenantTaskRecord>(
    ctx: TenantContext,
    task: TenantTaskRecord,
    options?: { auditEntries?: readonly AppendTenantAuditEntryInput[] },
  ): Promise<T> {
    return this.withTenantTransaction(ctx, async (tx) => {
      await this.upsertTaskInTx(tx, ctx, task);
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      const res = await tx.query<TaskRow>(
        `SELECT * FROM tasks WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, task.id],
      );
      const row = res.rows[0];
      if (!row) {
        throw createTaskWorkflowError('TASK_WRITE_ERROR', 'Failed to read saved task.');
      }
      this.assertRowTenant(ctx, row.tenant_id, 'tasks.putTask');
      const linkedMap = await this.loadTaskLinkedRecordsInTx(tx, ctx, [row.id]);
      return mapRowToTask(row, linkedMap.get(row.id)) as unknown as T;
    });
  }

  public async putTasks(
    ctx: TenantContext,
    tasks: readonly TenantTaskRecord[],
    options?: { auditEntries?: readonly AppendTenantAuditEntryInput[] },
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      for (const task of tasks) {
        await this.upsertTaskInTx(tx, ctx, task);
      }
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
    });
  }

  public async getTaskById<T = TenantTaskRecord>(
    ctx: TenantContext,
    taskId: string,
    options?: { viewerId?: string; includeRestricted?: boolean },
  ): Promise<T | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const viewerId = options?.viewerId ?? ctx.actorId;
      const res = includeRestricted
        ? await tx.query<TaskRow>(
            `SELECT * FROM tasks t WHERE t.tenant_id = $1 AND t.id = $2`,
            [ctx.tenantId, taskId],
          )
        : await tx.query<TaskRow>(
            `SELECT * FROM tasks t
             WHERE t.tenant_id = $1
               AND t.id = $3
               AND ${TASK_VISIBLE_SQL_PREDICATE}`,
            [ctx.tenantId, viewerId, taskId],
          );
      const row = res.rows[0];
      if (!row) {
        return null;
      }
      this.assertRowTenant(ctx, row.tenant_id, 'tasks.getTaskById');
      const linkedMap = await this.loadTaskLinkedRecordsInTx(tx, ctx, [row.id]);
      return mapRowToTask(row, linkedMap.get(row.id)) as unknown as T;
    });
  }

  public async listVisibleTasks<T = TenantTaskRecord>(
    ctx: TenantContext,
    viewerId: string,
    options?: {
      status?: string;
      assignedTeamId?: string;
      assignedPersonId?: string;
      linkedRecordType?: string;
      linkedRecordId?: string;
      includeRestricted?: boolean;
    },
  ): Promise<T[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const params: unknown[] = includeRestricted
        ? [ctx.tenantId]
        : [ctx.tenantId, viewerId];
      const clauses: string[] = ['t.tenant_id = $1'];
      if (!includeRestricted) {
        clauses.push(TASK_VISIBLE_SQL_PREDICATE);
      }
      if (options?.status) {
        params.push(options.status);
        clauses.push(`t.status = $${params.length}`);
      }
      if (options?.assignedTeamId) {
        params.push(options.assignedTeamId);
        clauses.push(`t.assigned_team_id = $${params.length}`);
      }
      if (options?.assignedPersonId) {
        params.push(options.assignedPersonId);
        clauses.push(
          `(t.assigned_person_id = $${params.length} OR t.assigned_person_ids_json ? $${params.length})`,
        );
      }
      if (options?.linkedRecordType && options?.linkedRecordId) {
        params.push(options.linkedRecordType, options.linkedRecordId);
        const typeIdx = params.length - 1;
        const idIdx = params.length;
        clauses.push(
          `EXISTS (
             SELECT 1 FROM task_linked_records tlr
             WHERE tlr.tenant_id = t.tenant_id
               AND tlr.task_id = t.id
               AND tlr.record_type = $${typeIdx}
               AND tlr.record_id = $${idIdx}
           )`,
        );
      }

      const res = await tx.query<TaskRow>(
        `SELECT * FROM tasks t
         WHERE ${clauses.join(' AND ')}
         ORDER BY t.created_at DESC, t.id ASC`,
        params,
      );
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'tasks.listVisibleTasks');
      }
      const linkedMap = await this.loadTaskLinkedRecordsInTx(
        tx,
        ctx,
        res.rows.map((r) => r.id),
      );
      return res.rows.map(
        (row) => mapRowToTask(row, linkedMap.get(row.id)) as unknown as T,
      );
    });
  }

  public async listAllTasksUnfiltered<T = TenantTaskRecord>(
    ctx: TenantContext,
  ): Promise<T[]> {
    return (await this.listVisibleTasks(ctx, ctx.actorId, {
      includeRestricted: true,
    })) as unknown as T[];
  }

  public async deleteTaskById(
    ctx: TenantContext,
    taskId: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        `DELETE FROM tasks WHERE tenant_id = $1 AND id = $2 RETURNING tenant_id`,
        [ctx.tenantId, taskId],
      );
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'tasks.deleteTaskById');
      }      return res.rowCount > 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Notifications CRUD & Queries
  // ---------------------------------------------------------------------------

  public async upsertNotificationInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    notification: TenantNotificationRecord,
  ): Promise<void> {
    if (!notification?.id?.trim()) {
      throw createTaskWorkflowError(
        'NOTIFICATION_VALIDATION_ERROR',
        'Notification id is required.',
      );
    }
    const existingCheck = await tx.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM notifications WHERE id = $1`,
      [notification.id],
    );
    for (const r of existingCheck.rows) {
      if (r.tenant_id !== ctx.tenantId) {
        throw createTaskWorkflowError(
          'TENANCY_CROSS_TENANT_RECORD_ACCESS',
          `Notification "${notification.id}" belongs to another tenant.`,
        );
      }
    }

    const createdAt = notification.createdAt || new Date().toISOString();
    await tx.query(
      `INSERT INTO notifications (
         tenant_id, id, user_id, kind, title, body,
         href, record_id, by_id, read, read_at, created_at, metadata_json
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11::timestamptz, $12::timestamptz, $13::jsonb
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         kind = EXCLUDED.kind,
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         href = EXCLUDED.href,
         record_id = EXCLUDED.record_id,
         by_id = EXCLUDED.by_id,
         read = EXCLUDED.read,
         read_at = EXCLUDED.read_at,
         created_at = EXCLUDED.created_at,
         metadata_json = EXCLUDED.metadata_json`,
      [
        ctx.tenantId,
        notification.id,
        notification.recipientId,
        notification.kind,
        notification.title ?? '',
        notification.detail ?? '',
        notification.href ?? '',
        notification.recordId ?? '',
        notification.byId ?? null,
        Boolean(notification.read),
        notification.readAt ?? null,
        createdAt,
        JSON.stringify(notification),
      ],
    );  }

  public async putNotification<T = TenantNotificationRecord>(
    ctx: TenantContext,
    notification: TenantNotificationRecord,
  ): Promise<T> {
    return this.withTenantTransaction(ctx, async (tx) => {
      await this.upsertNotificationInTx(tx, ctx, notification);
      const res = await tx.query<NotificationRow>(
        `SELECT * FROM notifications WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, notification.id],
      );
      const row = res.rows[0];
      if (!row) {
        throw createTaskWorkflowError(
          'NOTIFICATION_WRITE_ERROR',
          'Failed to read saved notification.',
        );
      }
      this.assertRowTenant(ctx, row.tenant_id, 'notifications.putNotification');
      return mapRowToNotification(row) as unknown as T;
    });
  }

  public async putNotifications(
    ctx: TenantContext,
    notifications: readonly TenantNotificationRecord[],
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      for (const n of notifications) {
        await this.upsertNotificationInTx(tx, ctx, n);
      }
    });
  }

  public async listNotificationsForUser<T = TenantNotificationRecord>(
    ctx: TenantContext,
    userId: string,
    options?: { viewerId?: string; includeRestricted?: boolean },
  ): Promise<T[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const viewerId = options?.viewerId ?? userId;
      const res = includeRestricted
        ? await tx.query<NotificationRow>(
            `SELECT * FROM notifications n
             WHERE n.tenant_id = $1 AND n.user_id = $2
             ORDER BY n.created_at DESC, n.id ASC`,
            [ctx.tenantId, userId],
          )
        : await tx.query<NotificationRow>(
            `SELECT * FROM notifications n
             WHERE n.tenant_id = $1
               AND n.user_id = $3
               AND NOT EXISTS (
                 SELECT 1 FROM matters m
                 WHERE m.tenant_id = n.tenant_id
                   AND m.id = n.record_id
                   AND (m.is_staff_matter = TRUE OR m.has_ethical_wall = TRUE)
                   AND NOT (m.restricted_access_user_ids_json ? $2)
               )
               AND NOT EXISTS (
                 SELECT 1 FROM enquiries e
                 WHERE e.tenant_id = n.tenant_id
                   AND e.id = n.record_id
                   AND NOT ${ENQUIRY_VISIBLE_SQL_PREDICATE}
               )
               AND NOT EXISTS (
                 SELECT 1 FROM quotes q
                 WHERE q.tenant_id = n.tenant_id
                   AND q.id = n.record_id
                   AND NOT ${QUOTE_VISIBLE_SQL_PREDICATE}
               )
               AND NOT EXISTS (
                 SELECT 1 FROM tasks t
                 WHERE t.tenant_id = n.tenant_id
                   AND t.id = n.record_id
                   AND NOT ${TASK_VISIBLE_SQL_PREDICATE}
               )
             ORDER BY n.created_at DESC, n.id ASC`,
            [ctx.tenantId, viewerId, userId],
          );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'notifications.listNotificationsForUser');
        return mapRowToNotification(row) as unknown as T;
      });
    });
  }

  public async listAllNotificationsUnfiltered<T = TenantNotificationRecord>(
    ctx: TenantContext,
  ): Promise<T[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<NotificationRow>(
        `SELECT * FROM notifications WHERE tenant_id = $1 ORDER BY created_at DESC, id ASC`,
        [ctx.tenantId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'notifications.listAllNotificationsUnfiltered');
        return mapRowToNotification(row) as unknown as T;
      });
    });
  }

  public async markNotificationRead(
    ctx: TenantContext,
    notificationId: string,
    userId?: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const nowIso = new Date().toISOString();
      const params: unknown[] = [ctx.tenantId, notificationId, nowIso];
      let userClause = '';
      if (userId) {
        params.push(userId);
        userClause = `AND user_id = $${params.length}`;
      }
      const res = await tx.query<NotificationRow>(
        `SELECT * FROM notifications WHERE tenant_id = $1 AND id = $2 ${userClause} FOR UPDATE`,
        userId ? [ctx.tenantId, notificationId, userId] : [ctx.tenantId, notificationId],
      );
      const row = res.rows[0];
      if (!row) {
        return false;
      }
      this.assertRowTenant(ctx, row.tenant_id, 'notifications.markNotificationRead');
      const updated: TenantNotificationRecord = {
        ...mapRowToNotification(row),
        read: true,
        readAt: nowIso,
      };
      await this.upsertNotificationInTx(tx, ctx, updated);
      return true;
    });
  }

  public async markAllNotificationsRead(
    ctx: TenantContext,
    userId: string,
  ): Promise<number> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const nowIso = new Date().toISOString();
      const res = await tx.query<NotificationRow>(
        `SELECT * FROM notifications
         WHERE tenant_id = $1 AND user_id = $2 AND read = FALSE
         FOR UPDATE`,
        [ctx.tenantId, userId],
      );
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'notifications.markAllNotificationsRead');
        const updated: TenantNotificationRecord = {
          ...mapRowToNotification(row),
          read: true,
          readAt: nowIso,
        };
        await this.upsertNotificationInTx(tx, ctx, updated);
      }
      return res.rows.length;
    });
  }

  public async getNotificationById<T = TenantNotificationRecord>(
    ctx: TenantContext,
    notificationId: string,
  ): Promise<T | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<NotificationRow>(
        `SELECT * FROM notifications WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, notificationId],
      );
      const row = res.rows[0];
      if (!row) {
        return null;
      }
      this.assertRowTenant(ctx, row.tenant_id, 'notifications.getNotificationById');
      return mapRowToNotification(row) as unknown as T;
    });
  }

  public async deleteNotificationById(
    ctx: TenantContext,
    notificationId: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        `DELETE FROM notifications WHERE tenant_id = $1 AND id = $2 RETURNING tenant_id`,
        [ctx.tenantId, notificationId],
      );
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'notifications.deleteNotificationById');
      }      return res.rowCount > 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Sign-Offs CRUD & Queries
  // ---------------------------------------------------------------------------

  public async upsertSignOffInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    signOff: TenantSignOffRecord,
  ): Promise<void> {
    if (!signOff?.id?.trim()) {
      throw createTaskWorkflowError('SIGN_OFF_VALIDATION_ERROR', 'Sign-off id is required.');
    }
    const existingCheck = await tx.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM sign_offs WHERE id = $1`,
      [signOff.id],
    );
    for (const r of existingCheck.rows) {
      if (r.tenant_id !== ctx.tenantId) {
        throw createTaskWorkflowError(
          'TENANCY_CROSS_TENANT_RECORD_ACCESS',
          `Sign-off "${signOff.id}" belongs to another tenant.`,
        );
      }
    }

    const requestedAt = signOff.requestedAt || new Date().toISOString();
    await tx.query(
      `INSERT INTO sign_offs (
         tenant_id, id, kind, status, matter_id, matter_number,
         title, subtitle, requested_by_id, assigned_approver_id, decided_by_id,
         amount_gbp, requested_at, decided_at, discussion_note, payload_json
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13::timestamptz, $14::timestamptz, $15, $16::jsonb
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         kind = EXCLUDED.kind,
         status = EXCLUDED.status,
         matter_id = EXCLUDED.matter_id,
         matter_number = EXCLUDED.matter_number,
         title = EXCLUDED.title,
         subtitle = EXCLUDED.subtitle,
         requested_by_id = EXCLUDED.requested_by_id,
         assigned_approver_id = EXCLUDED.assigned_approver_id,
         decided_by_id = EXCLUDED.decided_by_id,
         amount_gbp = EXCLUDED.amount_gbp,
         requested_at = EXCLUDED.requested_at,
         decided_at = EXCLUDED.decided_at,
         discussion_note = EXCLUDED.discussion_note,
         payload_json = EXCLUDED.payload_json`,
      [
        ctx.tenantId,
        signOff.id,
        signOff.kind,
        signOff.status || 'Pending',
        signOff.matterId ?? null,
        signOff.matterNumber ?? null,
        signOff.title ?? '',
        signOff.subtitle ?? '',
        signOff.requestedById || null,
        signOff.assignedPartnerId || null,
        signOff.approvedById ?? null,
        signOff.amountGbp !== undefined && signOff.amountGbp !== null
          ? Number(signOff.amountGbp)
          : null,
        requestedAt,
        signOff.approvedAt ?? null,
        signOff.discussionNote ?? null,
        JSON.stringify(signOff),
      ],
    );  }

  public async putSignOff<T = TenantSignOffRecord>(
    ctx: TenantContext,
    signOff: TenantSignOffRecord,
    options?: { auditEntries?: readonly AppendTenantAuditEntryInput[] },
  ): Promise<T> {
    return this.withTenantTransaction(ctx, async (tx) => {
      await this.upsertSignOffInTx(tx, ctx, signOff);
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      const res = await tx.query<SignOffRow>(
        `SELECT * FROM sign_offs WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, signOff.id],
      );
      const row = res.rows[0];
      if (!row) {
        throw createTaskWorkflowError(
          'SIGN_OFF_WRITE_ERROR',
          'Failed to read saved sign-off.',
        );
      }
      this.assertRowTenant(ctx, row.tenant_id, 'sign_offs.putSignOff');
      return mapRowToSignOff(row) as unknown as T;
    });
  }

  public async putSignOffs(
    ctx: TenantContext,
    signOffs: readonly TenantSignOffRecord[],
    options?: { auditEntries?: readonly AppendTenantAuditEntryInput[] },
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      for (const s of signOffs) {
        await this.upsertSignOffInTx(tx, ctx, s);
      }
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
    });
  }

  public async getSignOffById<T = TenantSignOffRecord>(
    ctx: TenantContext,
    signOffId: string,
    options?: { viewerId?: string; includeRestricted?: boolean },
  ): Promise<T | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const viewerId = options?.viewerId ?? ctx.actorId;
      const res = includeRestricted
        ? await tx.query<SignOffRow>(
            `SELECT * FROM sign_offs s WHERE s.tenant_id = $1 AND s.id = $2`,
            [ctx.tenantId, signOffId],
          )
        : await tx.query<SignOffRow>(
            `SELECT * FROM sign_offs s
             WHERE s.tenant_id = $1
               AND s.id = $3
               AND ${SIGN_OFF_VISIBLE_SQL_PREDICATE}`,
            [ctx.tenantId, viewerId, signOffId],
          );
      const row = res.rows[0];
      if (!row) {
        return null;
      }
      this.assertRowTenant(ctx, row.tenant_id, 'sign_offs.getSignOffById');
      return mapRowToSignOff(row) as unknown as T;
    });
  }

  public async listVisibleSignOffs<T = TenantSignOffRecord>(
    ctx: TenantContext,
    viewerId: string,
    options?: {
      status?: string;
      matterId?: string;
      includeRestricted?: boolean;
    },
  ): Promise<T[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const params: unknown[] = includeRestricted
        ? [ctx.tenantId]
        : [ctx.tenantId, viewerId];
      const clauses: string[] = ['s.tenant_id = $1'];
      if (!includeRestricted) {
        clauses.push(SIGN_OFF_VISIBLE_SQL_PREDICATE);
      }
      if (options?.status) {
        params.push(options.status);
        clauses.push(`s.status = $${params.length}`);
      }
      if (options?.matterId) {
        params.push(options.matterId);
        clauses.push(`s.matter_id = $${params.length}`);
      }

      const res = await tx.query<SignOffRow>(
        `SELECT * FROM sign_offs s
         WHERE ${clauses.join(' AND ')}
         ORDER BY s.requested_at DESC, s.id ASC`,
        params,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'sign_offs.listVisibleSignOffs');
        return mapRowToSignOff(row) as unknown as T;
      });
    });
  }

  public async listAllSignOffsUnfiltered<T = TenantSignOffRecord>(
    ctx: TenantContext,
  ): Promise<T[]> {
    return (await this.listVisibleSignOffs(ctx, ctx.actorId, {
      includeRestricted: true,
    })) as unknown as T[];
  }

  public async deleteSignOffById(
    ctx: TenantContext,
    signOffId: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        `DELETE FROM sign_offs WHERE tenant_id = $1 AND id = $2 RETURNING tenant_id`,
        [ctx.tenantId, signOffId],
      );
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'sign_offs.deleteSignOffById');
      }      return res.rowCount > 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Recently Viewed (`recently_viewed`, `PRIMARY KEY (tenant_id, user_id)`)
  // ---------------------------------------------------------------------------

  public async upsertRecentlyViewedInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    userId: string,
    items: readonly string[],
  ): Promise<void> {
    if (!userId?.trim()) {
      throw createTaskWorkflowError(
        'TASK_VALIDATION_ERROR',
        'userId is required for recently_viewed.',
      );
    }
    await tx.query(
      `INSERT INTO recently_viewed (tenant_id, user_id, items_json, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET
         items_json = EXCLUDED.items_json,
         updated_at = NOW()`,
      [ctx.tenantId, userId, JSON.stringify(items)],
    );  }

  public async putRecentlyViewedForUser(
    ctx: TenantContext,
    userId: string,
    items: readonly string[],
  ): Promise<string[]> {
    const next = [...items];
    await this.withTenantTransaction(ctx, async (tx) => {
      await this.upsertRecentlyViewedInTx(tx, ctx, userId, next);
    });
    return next;
  }

  public async recordRecentlyViewed(
    ctx: TenantContext,
    userId: string,
    recordId: string,
    maxItems = 8,
  ): Promise<string[]> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<RecentlyViewedRow>(
        `SELECT * FROM recently_viewed WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [ctx.tenantId, userId],
      );
      const row = res.rows[0];
      if (row) {
        this.assertRowTenant(ctx, row.tenant_id, 'recently_viewed.recordRecentlyViewed');
      }
      const current = Array.isArray(row?.items_json) ? row.items_json : [];
      if (current[0] === recordId) {
        return [...current];
      }
      const next = [
        recordId,
        ...current.filter((id) => id !== recordId),
      ].slice(0, maxItems);
      await this.upsertRecentlyViewedInTx(tx, ctx, userId, next);
      return next;
    });
  }

  public async getRecentlyViewedForUser(
    ctx: TenantContext,
    userId: string,
    options?: { viewerId?: string; includeRestricted?: boolean },
  ): Promise<string[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<RecentlyViewedRow>(
        `SELECT * FROM recently_viewed WHERE tenant_id = $1 AND user_id = $2`,
        [ctx.tenantId, userId],
      );
      const row = res.rows[0];
      if (!row) {
        return [];
      }
      this.assertRowTenant(ctx, row.tenant_id, 'recently_viewed.getRecentlyViewedForUser');
      const items = Array.isArray(row.items_json) ? [...row.items_json] : [];
      if (items.length === 0 || options?.includeRestricted) {
        return items;
      }
      const viewerId = options?.viewerId ?? userId;
      const hiddenRes = await tx.query<{ id: string }>(
        `SELECT m.id FROM matters m
         WHERE m.tenant_id = $1 AND m.id = ANY($3::text[])
           AND (m.is_staff_matter = TRUE OR m.has_ethical_wall = TRUE)
           AND NOT (m.restricted_access_user_ids_json ? $2)
         UNION ALL
         SELECT e.id FROM enquiries e
         WHERE e.tenant_id = $1 AND e.id = ANY($3::text[])
           AND NOT ${ENQUIRY_VISIBLE_SQL_PREDICATE}
         UNION ALL
         SELECT q.id FROM quotes q
         WHERE q.tenant_id = $1 AND q.id = ANY($3::text[])
           AND NOT ${QUOTE_VISIBLE_SQL_PREDICATE}
         UNION ALL
         SELECT t.id FROM tasks t
         WHERE t.tenant_id = $1 AND t.id = ANY($3::text[])
           AND NOT ${TASK_VISIBLE_SQL_PREDICATE}`,
        [ctx.tenantId, viewerId, items],
      );
      const hiddenIds = new Set(hiddenRes.rows.map((r) => r.id));
      return items.filter((id) => !hiddenIds.has(id));
    });
  }

  public async listAllRecentlyViewed(
    ctx: TenantContext,
  ): Promise<Record<string, string[]>> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<RecentlyViewedRow>(
        `SELECT * FROM recently_viewed WHERE tenant_id = $1 ORDER BY user_id ASC`,
        [ctx.tenantId],
      );
      const map: Record<string, string[]> = {};
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'recently_viewed.listAllRecentlyViewed');
        map[row.user_id] = Array.isArray(row.items_json)
          ? [...row.items_json]
          : [];
      }
      return map;
    });
  }

  public async getRecentlyViewedMap(
    ctx: TenantContext,
  ): Promise<Record<string, string[]>> {
    return this.listAllRecentlyViewed(ctx);
  }

  public async deleteRecentlyViewedForUser(
    ctx: TenantContext,
    userId: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        `DELETE FROM recently_viewed WHERE tenant_id = $1 AND user_id = $2 RETURNING tenant_id`,
        [ctx.tenantId, userId],
      );
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'recently_viewed.deleteRecentlyViewedForUser');
      }      return res.rowCount > 0;
    });
  }

  public async countAllTenantTaskWorkflowRows(ctx: TenantContext): Promise<{
    tasks: number;
    taskLinkedRecords: number;
    notifications: number;
    signOffs: number;
    recentlyViewed: number;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [tskRes, tlrRes, ntfRes, soRes, rvRes] = await Promise.all([
        tx.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM tasks WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
        tx.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM task_linked_records WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
        tx.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM notifications WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
        tx.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM sign_offs WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
        tx.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM recently_viewed WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
      ]);
      return {
        tasks: Number(tskRes.rows[0]?.count ?? 0),
        taskLinkedRecords: Number(tlrRes.rows[0]?.count ?? 0),
        notifications: Number(ntfRes.rows[0]?.count ?? 0),
        signOffs: Number(soRes.rows[0]?.count ?? 0),
        recentlyViewed: Number(rvRes.rows[0]?.count ?? 0),
      };
    });
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(`DELETE FROM recently_viewed WHERE tenant_id = $1`, [
        ctx.tenantId,
      ]);
      await tx.query(`DELETE FROM sign_offs WHERE tenant_id = $1`, [
        ctx.tenantId,
      ]);
      await tx.query(`DELETE FROM notifications WHERE tenant_id = $1`, [
        ctx.tenantId,
      ]);
      await tx.query(`DELETE FROM task_linked_records WHERE tenant_id = $1`, [
        ctx.tenantId,
      ]);
      await tx.query(`DELETE FROM tasks WHERE tenant_id = $1`, [ctx.tenantId]);
      await tx.query(
        `DELETE FROM tenant_record_sequences
         WHERE tenant_id = $1 AND counter_key IN ('TSK', 'NTF', 'SO')`,
        [ctx.tenantId],
      );    });
  }
}
