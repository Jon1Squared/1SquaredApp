/**
 * Tenant-Scoped Generic Communication Chasing Repository (`core/src/tenancy/chasingRepository.ts`).
 *
 * Implements ADR 0042 §§1 & 3 persistence and PostgreSQL-level step idempotency across:
 * - `public.communication_chases` (`uq_communication_chases_active` + `idx_communication_chases_due`)
 * - `public.communication_chase_events` (`uq_communication_chase_events_step`)
 */

import type {
  CommunicationChaseActionKind,
  CommunicationChaseEntityKind,
  CommunicationChaseEventRecord,
  CommunicationChaseOutcome,
  CommunicationChaseRecord,
  CommunicationChaseStatus,
  CommunicationChaseStoppedReason,
  FirmAuditEntryInput,
  TenantContext,
} from '../api/index';
import { TenantAuditRepository } from './auditRepository';
import type { TenantPostgresPoolManager } from './postgresPoolManager';
import {
  TenantScopedRepository,
  toIsoString,
  toNullableIsoString,
  type TenantSqlClient,
} from './tenantScopedRepository';

interface DbCommunicationChaseRow {
  tenant_id: string;
  id: string;
  entity_kind: string;
  entity_id: string;
  matter_id: string | null;
  quote_id: string | null;
  recipient_email: string | null;
  recipient_name: string | null;
  sent_at: Date | string;
  status: string;
  stopped_reason: string | null;
  stopped_at: Date | string | null;
  stopped_by_person_id: string | null;
  last_chased_at: Date | string | null;
  next_step_index: number | string;
  next_action_at: Date | string | null;
  consecutive_failure_count: number | string;
  last_error_code: string | null;
  created_by_person_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DbCommunicationChaseEventRow {
  tenant_id: string;
  id: string;
  chase_id: string;
  step_index: number | string;
  action_kind: string;
  outcome: string;
  outbox_email_id: string | null;
  task_id: string | null;
  executed_at: Date | string;
}

function mapChaseRow(row: DbCommunicationChaseRow): CommunicationChaseRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    entityKind: row.entity_kind as CommunicationChaseEntityKind,
    entityId: row.entity_id,
    matterId: row.matter_id ?? null,
    quoteId: row.quote_id ?? null,
    recipientEmail: row.recipient_email ?? null,
    recipientName: row.recipient_name ?? null,
    sentAt: toIsoString(row.sent_at),
    status: row.status as CommunicationChaseStatus,
    stoppedReason:
      (row.stopped_reason as CommunicationChaseStoppedReason | null) ?? null,
    stoppedAt: toNullableIsoString(row.stopped_at),
    stoppedByPersonId: row.stopped_by_person_id ?? null,
    lastChasedAt: toNullableIsoString(row.last_chased_at),
    nextStepIndex: Number(row.next_step_index ?? 1),
    nextActionAt: toNullableIsoString(row.next_action_at),
    consecutiveFailureCount: Number(row.consecutive_failure_count ?? 0),
    lastErrorCode: row.last_error_code ?? null,
    createdByPersonId: row.created_by_person_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapChaseEventRow(
  row: DbCommunicationChaseEventRow,
): CommunicationChaseEventRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    chaseId: row.chase_id,
    stepIndex: Number(row.step_index) as 1 | 2 | 3,
    actionKind: row.action_kind as CommunicationChaseActionKind,
    outcome: row.outcome as CommunicationChaseOutcome,
    outboxEmailId: row.outbox_email_id ?? null,
    taskId: row.task_id ?? null,
    executedAt: toIsoString(row.executed_at),
  };
}

export interface CommunicationChaseWithEvents {
  readonly chase: CommunicationChaseRecord;
  readonly events: readonly CommunicationChaseEventRecord[];
}

export class TenantChasingRepository extends TenantScopedRepository {
  private readonly auditRepo: TenantAuditRepository;

  public constructor(
    options: {
      poolManager?: TenantPostgresPoolManager;
      auditRepo?: TenantAuditRepository;
    } = {},
  ) {
    super({ poolManager: options.poolManager });
    this.auditRepo =
      options.auditRepo ??
      new TenantAuditRepository({ poolManager: this.poolManager });
  }

  public async startOrReplaceChaseInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    input: {
      readonly entityKind: CommunicationChaseEntityKind;
      readonly entityId: string;
      readonly matterId?: string | null;
      readonly quoteId?: string | null;
      readonly recipientEmail?: string | null;
      readonly recipientName?: string | null;
      readonly sentAt: string;
      readonly nextActionAt: string;
      readonly createdByPersonId: string;
    },
    options?: { readonly auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<{
    readonly chase: CommunicationChaseRecord;
    readonly supersededChaseId: string | null;
  }> {
    const entityId = input.entityId.trim();
    if (!entityId) {
      throw new Error('COMMUNICATION_CHASE_INVALID: entityId is required.');
    }

    const priorRes = await tx.query<{ id: string }>(
      `UPDATE public.communication_chases
          SET status = 'stopped',
              stopped_reason = 'superseded',
              stopped_at = $4::timestamptz,
              stopped_by_person_id = $5,
              next_action_at = NULL,
              updated_at = $4::timestamptz
        WHERE tenant_id = $1
          AND entity_kind = $2
          AND entity_id = $3
          AND status IN ('active', 'needs_owner')
        RETURNING id`,
      [
        ctx.tenantId,
        input.entityKind,
        entityId,
        input.sentAt,
        input.createdByPersonId,
      ],
    );
    const supersededChaseId = priorRes.rows[0]?.id ?? null;

    const seqRes = await tx.query<{ seq: string }>(
      `SELECT nextval('public.tenant_communication_chase_id_seq')::text AS seq`,
    );
    const id = `CHS-${String(seqRes.rows[0]?.seq ?? '1').padStart(6, '0')}`;
    const insertRes = await tx.query<DbCommunicationChaseRow>(
      `INSERT INTO public.communication_chases (
         tenant_id, id, entity_kind, entity_id, matter_id, quote_id,
         recipient_email, recipient_name, sent_at, status, stopped_reason,
         stopped_at, stopped_by_person_id, last_chased_at,
         next_step_index, next_action_at, created_by_person_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9::timestamptz, 'active', NULL,
         NULL, NULL, NULL,
         1, $10::timestamptz, $11,
         $9::timestamptz, $9::timestamptz
       )
       RETURNING *`,
      [
        ctx.tenantId,
        id,
        input.entityKind,
        entityId,
        input.matterId ?? null,
        input.quoteId ?? null,
        input.recipientEmail ?? null,
        input.recipientName ?? null,
        input.sentAt,
        input.nextActionAt,
        input.createdByPersonId,
      ],
    );

    const row = insertRes.rows[0]!;
    this.assertRowTenant(ctx, row.tenant_id, 'CommunicationChase');

    if (options?.auditEntries && options.auditEntries.length > 0) {
      await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
    }

    return {
      chase: mapChaseRow(row),
      supersededChaseId,
    };
  }

  public async stopActiveChaseInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    params: {
      readonly entityKind: CommunicationChaseEntityKind;
      readonly entityId: string;
      readonly reason: CommunicationChaseStoppedReason;
      readonly stoppedByPersonId: string;
      readonly stoppedAt: string;
    },
  ): Promise<CommunicationChaseRecord | null> {
    const res = await tx.query<DbCommunicationChaseRow>(
      `UPDATE public.communication_chases
          SET status = 'stopped',
              stopped_reason = $4,
              stopped_at = $5::timestamptz,
              stopped_by_person_id = $6,
              next_action_at = NULL,
              updated_at = $5::timestamptz
        WHERE tenant_id = $1
          AND entity_kind = $2
          AND entity_id = $3
          AND status IN ('active', 'needs_owner')
        RETURNING *`,
      [
        ctx.tenantId,
        params.entityKind,
        params.entityId,
        params.reason,
        params.stoppedAt,
        params.stoppedByPersonId,
      ],
    );
    const row = res.rows[0];
    if (!row) return null;
    this.assertRowTenant(ctx, row.tenant_id, 'CommunicationChase');
    return mapChaseRow(row);
  }

  public async stopActiveChasesForMatterInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    params: {
      readonly matterId: string;
      readonly reason: CommunicationChaseStoppedReason;
      readonly stoppedByPersonId: string;
      readonly stoppedAt: string;
    },
  ): Promise<readonly CommunicationChaseRecord[]> {
    const cleanMatterId = params.matterId.trim();
    if (!cleanMatterId) return [];
    const res = await tx.query<DbCommunicationChaseRow>(
      `UPDATE public.communication_chases
          SET status = 'stopped',
              stopped_reason = $3,
              stopped_at = $4::timestamptz,
              stopped_by_person_id = $5,
              next_action_at = NULL,
              updated_at = $4::timestamptz
        WHERE tenant_id = $1
          AND matter_id = $2
          AND status IN ('active', 'needs_owner')
        RETURNING *`,
      [
        ctx.tenantId,
        cleanMatterId,
        params.reason,
        params.stoppedAt,
        params.stoppedByPersonId,
      ],
    );
    return res.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'CommunicationChase');
      return mapChaseRow(row);
    });
  }

  public async stopChaseByIdInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    params: {
      readonly chaseId: string;
      readonly reason: CommunicationChaseStoppedReason;
      readonly stoppedByPersonId: string;
      readonly stoppedAt: string;
    },
  ): Promise<CommunicationChaseRecord | null> {
    const lockRes = await tx.query<DbCommunicationChaseRow>(
      `SELECT *
         FROM public.communication_chases
        WHERE tenant_id = $1
          AND id = $2
        LIMIT 1
        FOR UPDATE`,
      [ctx.tenantId, params.chaseId],
    );
    const existing = lockRes.rows[0];
    if (!existing) {
      return null;
    }
    this.assertRowTenant(ctx, existing.tenant_id, 'CommunicationChase');
    if (existing.status !== 'active' && existing.status !== 'needs_owner') {
      return mapChaseRow(existing);
    }
    const upd = await tx.query<DbCommunicationChaseRow>(
      `UPDATE public.communication_chases
          SET status = 'stopped',
              stopped_reason = $3,
              stopped_at = $4::timestamptz,
              stopped_by_person_id = $5,
              next_action_at = NULL,
              updated_at = $4::timestamptz
        WHERE tenant_id = $1
          AND id = $2
        RETURNING *`,
      [
        ctx.tenantId,
        params.chaseId,
        params.reason,
        params.stoppedAt,
        params.stoppedByPersonId,
      ],
    );
    const updated = upd.rows[0]!;
    this.assertRowTenant(ctx, updated.tenant_id, 'CommunicationChase');
    return mapChaseRow(updated);
  }

  public async getChaseById(
    ctx: TenantContext,
    chaseId: string,
  ): Promise<CommunicationChaseRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbCommunicationChaseRow>(
        `SELECT *
           FROM public.communication_chases
          WHERE tenant_id = $1 AND id = $2
          LIMIT 1`,
        [ctx.tenantId, chaseId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'CommunicationChase');
      return mapChaseRow(row);
    });
  }

  public async getActiveChaseForEntity(
    ctx: TenantContext,
    params: {
      readonly entityKind: CommunicationChaseEntityKind;
      readonly entityId: string;
    },
  ): Promise<CommunicationChaseRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbCommunicationChaseRow>(
        `SELECT *
           FROM public.communication_chases
          WHERE tenant_id = $1
            AND entity_kind = $2
            AND entity_id = $3
            AND status IN ('active', 'needs_owner')
          LIMIT 1`,
        [ctx.tenantId, params.entityKind, params.entityId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'CommunicationChase');
      return mapChaseRow(row);
    });
  }

  public async listChasesForMatter(
    ctx: TenantContext,
    matterId: string,
    limit = 50,
  ): Promise<readonly CommunicationChaseWithEvents[]> {
    const cleanLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbCommunicationChaseRow>(
        `SELECT *
           FROM public.communication_chases
          WHERE tenant_id = $1
            AND matter_id = $2
          ORDER BY sent_at DESC, id DESC
          LIMIT $3`,
        [ctx.tenantId, matterId, cleanLimit],
      );
      const chases = res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'CommunicationChase');
        return mapChaseRow(row);
      });
      if (chases.length === 0) {
        return [];
      }
      const eventsMap = await this.loadEventsByChaseIdsInTx(
        tx,
        ctx,
        chases.map((c) => c.id),
      );
      return chases.map((chase) => ({
        chase,
        events: eventsMap.get(chase.id) ?? [],
      }));
    });
  }

  public async listDueActiveChases(
    ctx: TenantContext,
    params: { readonly nowIso: string; readonly limit?: number },
  ): Promise<readonly CommunicationChaseRecord[]> {
    const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? 100)));
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbCommunicationChaseRow>(
        `SELECT *
           FROM public.communication_chases
          WHERE tenant_id = $1
            AND status = 'active'
            AND next_action_at IS NOT NULL
            AND next_action_at <= $2::timestamptz
          ORDER BY next_action_at ASC, id ASC
          LIMIT $3`,
        [ctx.tenantId, params.nowIso, limit],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'CommunicationChase');
        return mapChaseRow(row);
      });
    });
  }

  public async lockDueChaseForUpdateInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    chaseId: string,
    nowIso?: string,
  ): Promise<CommunicationChaseRecord | null> {
    const params: unknown[] = [ctx.tenantId, chaseId];
    const dueClause = nowIso
      ? ` AND next_action_at IS NOT NULL AND next_action_at <= $3::timestamptz`
      : '';
    if (nowIso) {
      params.push(nowIso);
    }
    const res = await tx.query<DbCommunicationChaseRow>(
      `SELECT *
         FROM public.communication_chases
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'active'${dueClause}
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      params,
    );
    const row = res.rows[0];
    if (!row) return null;
    this.assertRowTenant(ctx, row.tenant_id, 'CommunicationChase');
    return mapChaseRow(row);
  }

  public async recordChaseStepEventAndAdvanceInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    params: {
      readonly chaseId: string;
      readonly stepIndex: 1 | 2 | 3;
      readonly actionKind: CommunicationChaseActionKind;
      readonly outcome: CommunicationChaseOutcome;
      readonly outboxEmailId?: string | null;
      readonly taskId?: string | null;
      readonly executedAt: string;
      readonly nextActionAt: string | null;
    },
  ): Promise<{
    readonly alreadyExecuted: boolean;
    readonly event: CommunicationChaseEventRecord | null;
    readonly chase: CommunicationChaseRecord;
  }> {
    const seqRes = await tx.query<{ seq: string }>(
      `SELECT nextval('public.tenant_communication_chase_event_id_seq')::text AS seq`,
    );
    const eventId = `CHE-${String(seqRes.rows[0]?.seq ?? '1').padStart(6, '0')}`;

    const eventInsertRes = await tx.query<DbCommunicationChaseEventRow>(
      `INSERT INTO public.communication_chase_events (
         tenant_id, id, chase_id, step_index, action_kind, outcome,
         outbox_email_id, task_id, executed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9::timestamptz
       )
       ON CONFLICT (tenant_id, chase_id, step_index) DO NOTHING
       RETURNING *`,
      [
        ctx.tenantId,
        eventId,
        params.chaseId,
        params.stepIndex,
        params.actionKind,
        params.outcome,
        params.outboxEmailId ?? null,
        params.taskId ?? null,
        params.executedAt,
      ],
    );

    if (!eventInsertRes.rows[0]) {
      const currentRes = await tx.query<DbCommunicationChaseRow>(
        `SELECT *
           FROM public.communication_chases
          WHERE tenant_id = $1 AND id = $2
          LIMIT 1`,
        [ctx.tenantId, params.chaseId],
      );
      const currentRow = currentRes.rows[0]!;
      this.assertRowTenant(ctx, currentRow.tenant_id, 'CommunicationChase');
      return {
        alreadyExecuted: true,
        event: null,
        chase: mapChaseRow(currentRow),
      };
    }

    const eventRow = eventInsertRes.rows[0];
    this.assertRowTenant(ctx, eventRow.tenant_id, 'CommunicationChaseEvent');

    const isComplete = params.stepIndex >= 3 || params.nextActionAt === null;
    const nextStepIndex = Math.min(4, params.stepIndex + 1);
    const chaseUpdateRes = await tx.query<DbCommunicationChaseRow>(
      `UPDATE public.communication_chases
          SET status = $3,
              last_chased_at = $4::timestamptz,
              next_step_index = $5,
              next_action_at = $6::timestamptz,
              consecutive_failure_count = 0,
              last_error_code = NULL,
              updated_at = $4::timestamptz
        WHERE tenant_id = $1
          AND id = $2
        RETURNING *`,
      [
        ctx.tenantId,
        params.chaseId,
        isComplete ? 'completed' : 'active',
        params.executedAt,
        nextStepIndex,
        isComplete ? null : params.nextActionAt,
      ],
    );
    const updatedChaseRow = chaseUpdateRes.rows[0]!;
    this.assertRowTenant(ctx, updatedChaseRow.tenant_id, 'CommunicationChase');

    return {
      alreadyExecuted: false,
      event: mapChaseEventRow(eventRow),
      chase: mapChaseRow(updatedChaseRow),
    };
  }

  public async markChaseNeedsOwnerInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    params: {
      readonly chaseId: string;
      readonly stepIndex: 1 | 2 | 3;
      readonly executedAt: string;
    },
  ): Promise<{
    readonly alreadyRecorded: boolean;
    readonly event: CommunicationChaseEventRecord | null;
    readonly chase: CommunicationChaseRecord;
  }> {
    const seqRes = await tx.query<{ seq: string }>(
      `SELECT nextval('public.tenant_communication_chase_event_id_seq')::text AS seq`,
    );
    const eventId = `CHE-${String(seqRes.rows[0]?.seq ?? '1').padStart(6, '0')}`;

    const eventInsertRes = await tx.query<DbCommunicationChaseEventRow>(
      `INSERT INTO public.communication_chase_events (
         tenant_id, id, chase_id, step_index, action_kind, outcome,
         outbox_email_id, task_id, executed_at
       ) VALUES (
         $1, $2, $3, $4, 'escalation_task', 'escalation_unassigned',
         NULL, NULL, $5::timestamptz
       )
       ON CONFLICT (tenant_id, chase_id, step_index) DO NOTHING
       RETURNING *`,
      [ctx.tenantId, eventId, params.chaseId, params.stepIndex, params.executedAt],
    );

    if (!eventInsertRes.rows[0]) {
      const currentRes = await tx.query<DbCommunicationChaseRow>(
        `SELECT * FROM public.communication_chases WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [ctx.tenantId, params.chaseId],
      );
      const currentRow = currentRes.rows[0]!;
      this.assertRowTenant(ctx, currentRow.tenant_id, 'CommunicationChase');
      return {
        alreadyRecorded: true,
        event: null,
        chase: mapChaseRow(currentRow),
      };
    }

    const eventRow = eventInsertRes.rows[0];
    this.assertRowTenant(ctx, eventRow.tenant_id, 'CommunicationChaseEvent');

    const chaseUpdateRes = await tx.query<DbCommunicationChaseRow>(
      `UPDATE public.communication_chases
          SET status = 'needs_owner',
              last_chased_at = $3::timestamptz,
              next_step_index = 4,
              next_action_at = NULL,
              consecutive_failure_count = 0,
              last_error_code = NULL,
              updated_at = $3::timestamptz
        WHERE tenant_id = $1
          AND id = $2
        RETURNING *`,
      [ctx.tenantId, params.chaseId, params.executedAt],
    );
    const updatedChaseRow = chaseUpdateRes.rows[0]!;
    this.assertRowTenant(ctx, updatedChaseRow.tenant_id, 'CommunicationChase');

    return {
      alreadyRecorded: false,
      event: mapChaseEventRow(eventRow),
      chase: mapChaseRow(updatedChaseRow),
    };
  }

  public async recordChaseFailureInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    params: {
      readonly chaseId: string;
      readonly stepIndex: 1 | 2 | 3;
      readonly actionKind: CommunicationChaseActionKind;
      readonly errorCode: string;
      readonly executedAt: string;
      readonly maxConsecutiveFailures?: number;
      readonly retryNextActionAt?: string | null;
    },
  ): Promise<{
    readonly chase: CommunicationChaseRecord;
    readonly markedFailed: boolean;
  }> {
    const threshold = Math.max(1, Math.floor(params.maxConsecutiveFailures ?? 3));
    const safeErrorCode = params.errorCode
      .replace(/[^A-Za-z0-9_.:-]/g, '_')
      .slice(0, 64) || 'CHASE_STEP_ERROR';
    const updRes = await tx.query<DbCommunicationChaseRow>(
      `UPDATE public.communication_chases
          SET consecutive_failure_count = consecutive_failure_count + 1,
              last_error_code = $3,
              status = CASE
                WHEN consecutive_failure_count + 1 >= $4 THEN 'failed'
                ELSE status
              END,
              next_action_at = CASE
                WHEN consecutive_failure_count + 1 >= $4 THEN NULL
                WHEN $6::timestamptz IS NOT NULL THEN $6::timestamptz
                ELSE next_action_at
              END,
              updated_at = $5::timestamptz
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'active'
        RETURNING *`,
      [
        ctx.tenantId,
        params.chaseId,
        safeErrorCode,
        threshold,
        params.executedAt,
        params.retryNextActionAt ?? null,
      ],
    );
    const row = updRes.rows[0];
    if (!row) {
      const current = await tx.query<DbCommunicationChaseRow>(
        `SELECT * FROM public.communication_chases WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [ctx.tenantId, params.chaseId],
      );
      const existingRow = current.rows[0]!;
      this.assertRowTenant(ctx, existingRow.tenant_id, 'CommunicationChase');
      return { chase: mapChaseRow(existingRow), markedFailed: false };
    }
    this.assertRowTenant(ctx, row.tenant_id, 'CommunicationChase');
    const mapped = mapChaseRow(row);
    const markedFailed = mapped.status === 'failed';
    if (markedFailed) {
      const seqRes = await tx.query<{ seq: string }>(
        `SELECT nextval('public.tenant_communication_chase_event_id_seq')::text AS seq`,
      );
      const eventId = `CHE-${String(seqRes.rows[0]?.seq ?? '1').padStart(6, '0')}`;
      await tx.query(
        `INSERT INTO public.communication_chase_events (
           tenant_id, id, chase_id, step_index, action_kind, outcome,
           outbox_email_id, task_id, executed_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'step_failed',
           NULL, NULL, $6::timestamptz
         )
         ON CONFLICT (tenant_id, chase_id, step_index) DO NOTHING`,
        [
          ctx.tenantId,
          eventId,
          params.chaseId,
          params.stepIndex,
          params.actionKind,
          params.executedAt,
        ],
      );
    }
    return { chase: mapped, markedFailed };
  }

  private async loadEventsByChaseIdsInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    chaseIds: readonly string[],
  ): Promise<ReadonlyMap<string, CommunicationChaseEventRecord[]>> {
    const cleanIds = chaseIds.filter(Boolean);
    const out = new Map<string, CommunicationChaseEventRecord[]>();
    if (cleanIds.length === 0) return out;
    const res = await tx.query<DbCommunicationChaseEventRow>(
      `SELECT *
         FROM public.communication_chase_events
        WHERE tenant_id = $1
          AND chase_id = ANY($2::text[])
        ORDER BY step_index ASC, executed_at ASC`,
      [ctx.tenantId, cleanIds],
    );
    for (const row of res.rows) {
      this.assertRowTenant(ctx, row.tenant_id, 'CommunicationChaseEvent');
      const mapped = mapChaseEventRow(row);
      const list = out.get(mapped.chaseId) ?? [];
      list.push(mapped);
      out.set(mapped.chaseId, list);
    }
    return out;
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        'DELETE FROM public.communication_chase_events WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM public.communication_chases WHERE tenant_id = $1',
        [ctx.tenantId],
      );
    });
  }
}
