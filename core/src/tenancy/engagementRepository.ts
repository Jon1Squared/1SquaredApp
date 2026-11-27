/**
 * Tenant-Scoped Engagement Dispatch Repository (`core/src/tenancy/engagementRepository.ts`).
 *
 * Persists outbound Client Care / Engagement Letters and Non-Engagement Letters
 * inside `public.engagement_dispatches` (migration `0028`, `S1-06`).
 */

import type {
  EngagementDispatchKind,
  EngagementDispatchRecord,
  EngagementDispatchStatus,
  TenantContext,
} from '../api/index';
import type { TenantPostgresPoolManager } from './postgresPoolManager';
import {
  TenantScopedRepository,
  toIsoString,
  toNullableIsoString,
  type TenantSqlClient,
} from './tenantScopedRepository';

interface DbEngagementDispatchRow {
  tenant_id: string;
  id: string;
  kind: string;
  matter_id: string | null;
  enquiry_id: string | null;
  document_id: string | null;
  outbox_email_id: string | null;
  recipient_email: string;
  recipient_name: string | null;
  status: string;
  sent_at: Date | string;
  sent_by_person_id: string;
  signed_evidence_artifact_id: string | null;
  signed_at: Date | string | null;
  signed_by_person_id: string | null;
  intake_check_record_id: string | null;
  idempotency_key: string;
  created_at: Date | string;
}

function mapDispatchRow(row: DbEngagementDispatchRow): EngagementDispatchRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind as EngagementDispatchKind,
    matterId: row.matter_id ?? null,
    enquiryId: row.enquiry_id ?? null,
    documentId: row.document_id ?? null,
    outboxEmailId: row.outbox_email_id ?? null,
    recipientEmail: row.recipient_email,
    recipientName: row.recipient_name ?? null,
    status: row.status as EngagementDispatchStatus,
    sentAt: toIsoString(row.sent_at),
    sentByPersonId: row.sent_by_person_id,
    signedEvidenceArtifactId: row.signed_evidence_artifact_id ?? null,
    signedAt: toNullableIsoString(row.signed_at),
    signedByPersonId: row.signed_by_person_id ?? null,
    intakeCheckRecordId: row.intake_check_record_id ?? null,
    idempotencyKey: row.idempotency_key,
    createdAt: toIsoString(row.created_at),
  };
}

export class TenantEngagementRepository extends TenantScopedRepository {
  public constructor(
    options: { poolManager?: TenantPostgresPoolManager } = {},
  ) {
    super({ poolManager: options.poolManager });
  }

  public async getDispatchByIdempotencyKeyInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    idempotencyKey: string,
  ): Promise<EngagementDispatchRecord | null> {
    const cleanKey = idempotencyKey.trim();
    if (!cleanKey) return null;
    const res = await tx.query<DbEngagementDispatchRow>(
      `SELECT *
         FROM public.engagement_dispatches
        WHERE tenant_id = $1
          AND idempotency_key = $2
        LIMIT 1`,
      [ctx.tenantId, cleanKey],
    );
    const row = res.rows[0];
    if (!row) return null;
    this.assertRowTenant(ctx, row.tenant_id, 'EngagementDispatch');
    return mapDispatchRow(row);
  }

  public async getDispatchByIdempotencyKey(
    ctx: TenantContext,
    idempotencyKey: string,
  ): Promise<EngagementDispatchRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) =>
      this.getDispatchByIdempotencyKeyInTx(tx, ctx, idempotencyKey),
    );
  }

  public async createDispatchInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    input: {
      readonly kind: EngagementDispatchKind;
      readonly matterId?: string | null;
      readonly enquiryId?: string | null;
      readonly documentId?: string | null;
      readonly outboxEmailId?: string | null;
      readonly recipientEmail: string;
      readonly recipientName?: string | null;
      readonly sentAt: string;
      readonly sentByPersonId: string;
      readonly intakeCheckRecordId?: string | null;
      readonly idempotencyKey: string;
    },
  ): Promise<{
    readonly record: EngagementDispatchRecord;
    readonly deduplicated: boolean;
  }> {
    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) {
      throw new Error('ENGAGEMENT_DISPATCH_INVALID: idempotencyKey is required.');
    }
    const existing = await this.getDispatchByIdempotencyKeyInTx(tx, ctx, cleanKey);
    if (existing) {
      return { record: existing, deduplicated: true };
    }

    const seqRes = await tx.query<{ seq: string }>(
      `SELECT nextval('public.tenant_engagement_dispatch_id_seq')::text AS seq`,
    );
    const id = `ENG-${String(seqRes.rows[0]?.seq ?? '1').padStart(6, '0')}`;

    const insertRes = await tx.query<DbEngagementDispatchRow>(
      `INSERT INTO public.engagement_dispatches (
         tenant_id, id, kind, matter_id, enquiry_id, document_id,
         outbox_email_id, recipient_email, recipient_name, status,
         sent_at, sent_by_person_id, signed_evidence_artifact_id,
         signed_at, signed_by_person_id, intake_check_record_id,
         idempotency_key, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, 'sent',
         $10::timestamptz, $11, NULL,
         NULL, NULL, $12,
         $13, $10::timestamptz
       )
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        ctx.tenantId,
        id,
        input.kind,
        input.matterId ?? null,
        input.enquiryId ?? null,
        input.documentId ?? null,
        input.outboxEmailId ?? null,
        input.recipientEmail,
        input.recipientName ?? null,
        input.sentAt,
        input.sentByPersonId,
        input.intakeCheckRecordId ?? null,
        cleanKey,
      ],
    );

    if (!insertRes.rows[0]) {
      const winner = await this.getDispatchByIdempotencyKeyInTx(tx, ctx, cleanKey);
      return { record: winner!, deduplicated: true };
    }

    const inserted = insertRes.rows[0];
    this.assertRowTenant(ctx, inserted.tenant_id, 'EngagementDispatch');
    return {
      record: mapDispatchRow(inserted),
      deduplicated: false,
    };
  }

  public async markLatestClientCareDispatchSignedInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    params: {
      readonly matterId: string;
      readonly signedEvidenceArtifactId: string;
      readonly signedAt: string;
      readonly signedByPersonId: string;
      readonly intakeCheckRecordId?: string | null;
    },
  ): Promise<EngagementDispatchRecord | null> {
    const res = await tx.query<DbEngagementDispatchRow>(
      `SELECT *
         FROM public.engagement_dispatches
        WHERE tenant_id = $1
          AND kind = 'client_care'
          AND matter_id = $2
          AND status = 'sent'
        ORDER BY sent_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [ctx.tenantId, params.matterId],
    );
    const target = res.rows[0];
    if (!target) {
      return null;
    }
    this.assertRowTenant(ctx, target.tenant_id, 'EngagementDispatch');

    const updRes = await tx.query<DbEngagementDispatchRow>(
      `UPDATE public.engagement_dispatches
          SET status = 'signed',
              signed_evidence_artifact_id = $3,
              signed_at = $4::timestamptz,
              signed_by_person_id = $5,
              intake_check_record_id = COALESCE($6, intake_check_record_id)
        WHERE tenant_id = $1
          AND id = $2
        RETURNING *`,
      [
        ctx.tenantId,
        target.id,
        params.signedEvidenceArtifactId,
        params.signedAt,
        params.signedByPersonId,
        params.intakeCheckRecordId ?? null,
      ],
    );
    const updated = updRes.rows[0]!;
    this.assertRowTenant(ctx, updated.tenant_id, 'EngagementDispatch');
    return mapDispatchRow(updated);
  }

  public async listDispatchesForMatter(
    ctx: TenantContext,
    matterId: string,
    limit = 50,
  ): Promise<readonly EngagementDispatchRecord[]> {
    const cleanLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbEngagementDispatchRow>(
        `SELECT *
           FROM public.engagement_dispatches
          WHERE tenant_id = $1
            AND kind = 'client_care'
            AND matter_id = $2
          ORDER BY sent_at DESC, id DESC
          LIMIT $3`,
        [ctx.tenantId, matterId, cleanLimit],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'EngagementDispatch');
        return mapDispatchRow(row);
      });
    });
  }

  public async listDispatchesForEnquiry(
    ctx: TenantContext,
    enquiryId: string,
    limit = 50,
  ): Promise<readonly EngagementDispatchRecord[]> {
    const cleanLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbEngagementDispatchRow>(
        `SELECT *
           FROM public.engagement_dispatches
          WHERE tenant_id = $1
            AND kind = 'non_engagement'
            AND enquiry_id = $2
          ORDER BY sent_at DESC, id DESC
          LIMIT $3`,
        [ctx.tenantId, enquiryId, cleanLimit],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'EngagementDispatch');
        return mapDispatchRow(row);
      });
    });
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        'DELETE FROM public.engagement_dispatches WHERE tenant_id = $1',
        [ctx.tenantId],
      );
    });
  }
}
