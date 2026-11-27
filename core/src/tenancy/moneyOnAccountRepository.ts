/**
 * Tenant-Scoped Money on Account Requests & Receipts Repository
 * (`core/src/tenancy/moneyOnAccountRepository.ts`, ADR 0043, S1-08).
 *
 * Persists:
 * - `public.money_on_account_requests` (UK bank ref unique per tenant, snapshot JSON)
 * - `public.money_on_account_receipts` (append-only financial ledger with partial unique index
 *   `uq_moa_receipts_tenant_pms_tx` enforcing single active matching per PMS transaction ID)
 */

import type {
  BankAccountDetailsConfig,
  MoneyOnAccountReceiptRecord,
  MoneyOnAccountReceiptSource,
  MoneyOnAccountRequestRecord,
  MoneyOnAccountRequestStatus,
  TenantContext,
} from '../api/index';
import {
  minorUnitsToPgBigInt,
  pgBigIntToMinorUnits,
  type MinorUnits,
} from '../domain/money/index';
import type { TenantPostgresPoolManager } from './postgresPoolManager';
import {
  TenantScopedRepository,
  toIsoString,
  toNullableIsoString,
  type TenantSqlClient,
} from './tenantScopedRepository';

interface DbMoaRequestRow {
  tenant_id: string;
  id: string;
  matter_id: string;
  quote_id: string | null;
  payment_reference: string;
  requested_amount_pence: string | number | bigint;
  currency: string;
  recipient_email: string;
  recipient_name: string;
  status: string;
  requested_at: Date | string | null;
  requested_by_person_id: string | null;
  outbox_email_id: string | null;
  bank_details_snapshot_json: unknown;
  intake_check_record_id: string | null;
  notes: string | null;
  cancelled_at: Date | string | null;
  cancelled_by_person_id: string | null;
  cancellation_reason: string | null;
  idempotency_key: string | null;
  row_version: number;
  created_by_person_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DbMoaReceiptRow {
  tenant_id: string;
  id: string;
  request_id: string;
  matter_id: string;
  source: string;
  amount_pence: string | number | bigint;
  received_date: string;
  bank_reference: string | null;
  notes: string | null;
  pms_transaction_id: string | null;
  pms_matter_code: string | null;
  intake_check_record_id: string | null;
  evidence_artifact_id: string | null;
  recorded_by_person_id: string;
  recorded_at: Date | string;
  reversed_at: Date | string | null;
  reversed_by_person_id: string | null;
  reversal_reason: string | null;
}

function normalizeBankDetailsSnapshot(raw: unknown): BankAccountDetailsConfig {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Partial<BankAccountDetailsConfig>)
      : {};
  return {
    accountName: typeof obj.accountName === 'string' ? obj.accountName : '',
    bankName: typeof obj.bankName === 'string' ? obj.bankName : '',
    sortCode: typeof obj.sortCode === 'string' ? obj.sortCode : '',
    accountNumber: typeof obj.accountNumber === 'string' ? obj.accountNumber : '',
    iban: typeof obj.iban === 'string' ? obj.iban : '',
    bic: typeof obj.bic === 'string' ? obj.bic : '',
    allowDemoPlaceholderDetails: Boolean(obj.allowDemoPlaceholderDetails),
  };
}

function mapRequestRow(row: DbMoaRequestRow): MoneyOnAccountRequestRecord {
  const requestedAmountPence = pgBigIntToMinorUnits(
    row.requested_amount_pence,
    'money_on_account_requests.requested_amount_pence',
  );
  return {
    id: row.id,
    tenantId: row.tenant_id,
    matterId: row.matter_id,
    quoteId: row.quote_id ?? null,
    paymentReference: row.payment_reference,
    requestedAmountPence,
    currency: (row.currency as 'GBP') || 'GBP',
    recipientEmail: row.recipient_email,
    recipientName: row.recipient_name,
    status: row.status as MoneyOnAccountRequestStatus,
    requestedAt: toNullableIsoString(row.requested_at),
    requestedByPersonId: row.requested_by_person_id ?? null,
    outboxEmailId: row.outbox_email_id ?? null,
    bankDetailsSnapshot: normalizeBankDetailsSnapshot(
      row.bank_details_snapshot_json,
    ),
    intakeCheckRecordId: row.intake_check_record_id ?? null,
    notes: row.notes ?? null,
    cancelledAt: toNullableIsoString(row.cancelled_at),
    cancelledByPersonId: row.cancelled_by_person_id ?? null,
    cancellationReason: row.cancellation_reason ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    rowVersion: Number(row.row_version ?? 1),
    createdByPersonId: row.created_by_person_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapReceiptRow(row: DbMoaReceiptRow): MoneyOnAccountReceiptRecord {
  const amountPence = pgBigIntToMinorUnits(
    row.amount_pence,
    'money_on_account_receipts.amount_pence',
  );
  return {
    id: row.id,
    tenantId: row.tenant_id,
    requestId: row.request_id,
    matterId: row.matter_id,
    source: row.source as MoneyOnAccountReceiptSource,
    amountPence,
    receivedDate: row.received_date,
    bankReference: row.bank_reference ?? null,
    notes: row.notes ?? null,
    pmsTransactionId: row.pms_transaction_id ?? null,
    pmsMatterCode: row.pms_matter_code ?? null,
    intakeCheckRecordId: row.intake_check_record_id ?? null,
    evidenceArtifactId: row.evidence_artifact_id ?? null,
    recordedByPersonId: row.recorded_by_person_id,
    recordedAt: toIsoString(row.recorded_at),
    reversedAt: toNullableIsoString(row.reversed_at),
    reversedByPersonId: row.reversed_by_person_id ?? null,
    reversalReason: row.reversal_reason ?? null,
  };
}

function makeCodedError(code: string, message: string): Error & { code: string } {
  const err = new Error(`${code}: ${message}`) as Error & { code: string };
  err.code = code;
  return err;
}

export class TenantMoneyOnAccountRepository extends TenantScopedRepository {
  public constructor(
    options: { poolManager?: TenantPostgresPoolManager } = {},
  ) {
    super({ poolManager: options.poolManager });
  }

  public async allocateRequestIdInTx(tx: TenantSqlClient): Promise<string> {
    const res = await tx.query<{ seq: string }>(
      `SELECT nextval('public.tenant_moa_request_id_seq')::text AS seq`,
    );
    return `MOA-${String(res.rows[0]?.seq ?? '1').padStart(6, '0')}`;
  }

  public async allocateReceiptIdInTx(tx: TenantSqlClient): Promise<string> {
    const res = await tx.query<{ seq: string }>(
      `SELECT nextval('public.tenant_moa_receipt_id_seq')::text AS seq`,
    );
    return `MOAR-${String(res.rows[0]?.seq ?? '1').padStart(6, '0')}`;
  }

  public async countRequestsForMatterInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    matterId: string,
  ): Promise<number> {
    const res = await tx.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM public.money_on_account_requests
        WHERE tenant_id = $1
          AND matter_id = $2`,
      [ctx.tenantId, matterId],
    );
    const cnt = Number.parseInt(res.rows[0]?.cnt ?? '0', 10);
    return Number.isFinite(cnt) ? cnt : 0;
  }

  public async findRequestByIdempotencyKeyInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    matterId: string,
    idempotencyKey: string,
    options?: { readonly forUpdate?: boolean },
  ): Promise<MoneyOnAccountRequestRecord | null> {
    const cleanKey = idempotencyKey.trim();
    if (!cleanKey) return null;
    const lockSql = options?.forUpdate ? ' FOR UPDATE' : '';
    const res = await tx.query<DbMoaRequestRow>(
      `SELECT *
         FROM public.money_on_account_requests
        WHERE tenant_id = $1
          AND matter_id = $2
          AND idempotency_key = $3
        LIMIT 1${lockSql}`,
      [ctx.tenantId, matterId, cleanKey],
    );
    const row = res.rows[0];
    if (!row) return null;
    this.assertRowTenant(ctx, row.tenant_id, 'MoneyOnAccountRequest');
    return mapRequestRow(row);
  }

  public async findRequestByIdempotencyKey(
    ctx: TenantContext,
    matterId: string,
    idempotencyKey: string,
  ): Promise<MoneyOnAccountRequestRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) =>
      this.findRequestByIdempotencyKeyInTx(tx, ctx, matterId, idempotencyKey),
    );
  }

  public async getRequestByIdInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    id: string,
    options?: { readonly forUpdate?: boolean },
  ): Promise<MoneyOnAccountRequestRecord | null> {
    const cleanId = id.trim();
    if (!cleanId) return null;
    const lockSql = options?.forUpdate ? ' FOR UPDATE' : '';
    const res = await tx.query<DbMoaRequestRow>(
      `SELECT *
         FROM public.money_on_account_requests
        WHERE tenant_id = $1
          AND id = $2
        LIMIT 1${lockSql}`,
      [ctx.tenantId, cleanId],
    );
    const row = res.rows[0];
    if (!row) return null;
    this.assertRowTenant(ctx, row.tenant_id, 'MoneyOnAccountRequest');
    return mapRequestRow(row);
  }

  public async getRequestById(
    ctx: TenantContext,
    id: string,
  ): Promise<MoneyOnAccountRequestRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) =>
      this.getRequestByIdInTx(tx, ctx, id),
    );
  }

  public async listRequestsForMatterInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    matterId: string,
    options?: { readonly forShare?: boolean },
  ): Promise<readonly MoneyOnAccountRequestRecord[]> {
    const lockSql = options?.forShare ? ' FOR SHARE' : '';
    const res = await tx.query<DbMoaRequestRow>(
      `SELECT *
         FROM public.money_on_account_requests
        WHERE tenant_id = $1
          AND matter_id = $2
        ORDER BY created_at DESC, id DESC${lockSql}`,
      [ctx.tenantId, matterId],
    );
    return res.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'MoneyOnAccountRequest');
      return mapRequestRow(row);
    });
  }

  public async listRequestsForMatter(
    ctx: TenantContext,
    matterId: string,
  ): Promise<readonly MoneyOnAccountRequestRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) =>
      this.listRequestsForMatterInTx(tx, ctx, matterId),
    );
  }

  public async insertRequestInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    input: {
      readonly id?: string;
      readonly matterId: string;
      readonly quoteId?: string | null;
      readonly paymentReference: string;
      readonly requestedAmountPence: MinorUnits;
      readonly recipientEmail: string;
      readonly recipientName: string;
      readonly status: MoneyOnAccountRequestStatus;
      readonly requestedAt?: string | null;
      readonly requestedByPersonId?: string | null;
      readonly outboxEmailId?: string | null;
      readonly bankDetailsSnapshot: BankAccountDetailsConfig;
      readonly intakeCheckRecordId?: string | null;
      readonly notes?: string | null;
      readonly idempotencyKey?: string | null;
      readonly createdByPersonId: string;
      readonly createdAt?: string;
    },
  ): Promise<MoneyOnAccountRequestRecord> {
    const id = input.id?.trim() || (await this.allocateRequestIdInTx(tx));
    const requestedPenceStr = minorUnitsToPgBigInt(input.requestedAmountPence);
    const createdAt = input.createdAt?.trim() || new Date().toISOString();

    let res: { rows: DbMoaRequestRow[] };
    try {
      res = await tx.query<DbMoaRequestRow>(
        `INSERT INTO public.money_on_account_requests (
           tenant_id, id, matter_id, quote_id, payment_reference,
           requested_amount_pence, currency, recipient_email, recipient_name, status,
           requested_at, requested_by_person_id, outbox_email_id, bank_details_snapshot_json,
           intake_check_record_id, notes, cancelled_at, cancelled_by_person_id,
           cancellation_reason, idempotency_key, row_version, created_by_person_id,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6::bigint, 'GBP', $7, $8, $9,
           $10::timestamptz, $11, $12, $13::jsonb,
           $14, $15, NULL, NULL,
           NULL, $16, 1, $17,
           $18::timestamptz, $18::timestamptz
         )
         RETURNING *`,
        [
          ctx.tenantId,
          id,
          input.matterId,
          input.quoteId ?? null,
          input.paymentReference,
          requestedPenceStr,
          input.recipientEmail,
          input.recipientName,
          input.status,
          input.requestedAt ?? null,
          input.requestedByPersonId ?? null,
          input.outboxEmailId ?? null,
          JSON.stringify(input.bankDetailsSnapshot),
          input.intakeCheckRecordId ?? null,
          input.notes ?? null,
          input.idempotencyKey?.trim() || null,
          input.createdByPersonId,
          createdAt,
        ],
      );
    } catch (pgErr) {
      const code =
        (pgErr as { sqlState?: unknown })?.sqlState ??
        (pgErr as { code?: unknown })?.code;
      const constraint = String(
        (pgErr as { constraint?: unknown })?.constraint ?? '',
      );
      if (code === '23505') {
        if (
          constraint === 'uq_moa_requests_idempotency_key' ||
          (!constraint && Boolean(input.idempotencyKey?.trim()))
        ) {
          throw makeCodedError(
            'MOA_REQUEST_IDEMPOTENCY_CONFLICT',
            'Duplicate money on account request dispatch prevented by idempotency key.',
          );
        }
        throw makeCodedError(
          'MOA_PAYMENT_REFERENCE_CONFLICT',
          `Payment reference "${input.paymentReference}" already exists for this tenant.`,
        );
      }
      throw pgErr;
    }

    const row = res.rows[0]!;
    this.assertRowTenant(ctx, row.tenant_id, 'MoneyOnAccountRequest');
    return mapRequestRow(row);
  }

  public async updateRequestInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    requestId: string,
    patch: {
      readonly status?: MoneyOnAccountRequestStatus;
      readonly outboxEmailId?: string | null;
      readonly intakeCheckRecordId?: string | null;
      readonly cancelledAt?: string | null;
      readonly cancelledByPersonId?: string | null;
      readonly cancellationReason?: string | null;
      readonly updatedAt?: string;
    },
  ): Promise<MoneyOnAccountRequestRecord> {
    const current = await this.getRequestByIdInTx(tx, ctx, requestId, {
      forUpdate: true,
    });
    if (!current) {
      throw makeCodedError(
        'NOT_FOUND',
        'Money on account request was not found.',
      );
    }
    const nextStatus = patch.status ?? current.status;
    const nextOutboxId =
      patch.outboxEmailId !== undefined
        ? patch.outboxEmailId
        : current.outboxEmailId;
    const nextCheckId =
      patch.intakeCheckRecordId !== undefined
        ? patch.intakeCheckRecordId
        : current.intakeCheckRecordId;
    const nextCancelledAt =
      patch.cancelledAt !== undefined ? patch.cancelledAt : current.cancelledAt;
    const nextCancelledBy =
      patch.cancelledByPersonId !== undefined
        ? patch.cancelledByPersonId
        : current.cancelledByPersonId;
    const nextCancelReason =
      patch.cancellationReason !== undefined
        ? patch.cancellationReason
        : current.cancellationReason;
    const updatedAt = patch.updatedAt?.trim() || new Date().toISOString();

    const res = await tx.query<DbMoaRequestRow>(
      `UPDATE public.money_on_account_requests
          SET status = $3,
              outbox_email_id = $4,
              intake_check_record_id = $5,
              cancelled_at = $6::timestamptz,
              cancelled_by_person_id = $7,
              cancellation_reason = $8,
              row_version = row_version + 1,
              updated_at = $9::timestamptz
        WHERE tenant_id = $1
          AND id = $2
        RETURNING *`,
      [
        ctx.tenantId,
        requestId,
        nextStatus,
        nextOutboxId,
        nextCheckId,
        nextCancelledAt,
        nextCancelledBy,
        nextCancelReason,
        updatedAt,
      ],
    );
    const updated = res.rows[0]!;
    this.assertRowTenant(ctx, updated.tenant_id, 'MoneyOnAccountRequest');
    return mapRequestRow(updated);
  }

  public async getReceiptByIdInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    receiptId: string,
    options?: { readonly forUpdate?: boolean },
  ): Promise<MoneyOnAccountReceiptRecord | null> {
    const cleanId = receiptId.trim();
    if (!cleanId) return null;
    const lockSql = options?.forUpdate ? ' FOR UPDATE' : '';
    const res = await tx.query<DbMoaReceiptRow>(
      `SELECT *
         FROM public.money_on_account_receipts
        WHERE tenant_id = $1
          AND id = $2
        LIMIT 1${lockSql}`,
      [ctx.tenantId, cleanId],
    );
    const row = res.rows[0];
    if (!row) return null;
    this.assertRowTenant(ctx, row.tenant_id, 'MoneyOnAccountReceipt');
    return mapReceiptRow(row);
  }

  public async getReceiptById(
    ctx: TenantContext,
    receiptId: string,
  ): Promise<MoneyOnAccountReceiptRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) =>
      this.getReceiptByIdInTx(tx, ctx, receiptId),
    );
  }

  public async listReceiptsForMatterInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    matterId: string,
    options?: {
      readonly includeReversed?: boolean;
      readonly forShare?: boolean;
    },
  ): Promise<readonly MoneyOnAccountReceiptRecord[]> {
    const includeReversed = options?.includeReversed !== false;
    const lockSql = options?.forShare ? ' FOR SHARE' : '';
    const res = await tx.query<DbMoaReceiptRow>(
      `SELECT *
         FROM public.money_on_account_receipts
        WHERE tenant_id = $1
          AND matter_id = $2
          ${includeReversed ? '' : 'AND reversed_at IS NULL'}
        ORDER BY recorded_at DESC, id DESC${lockSql}`,
      [ctx.tenantId, matterId],
    );
    return res.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'MoneyOnAccountReceipt');
      return mapReceiptRow(row);
    });
  }

  public async listReceiptsForMatter(
    ctx: TenantContext,
    matterId: string,
    options?: { readonly includeReversed?: boolean },
  ): Promise<readonly MoneyOnAccountReceiptRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) =>
      this.listReceiptsForMatterInTx(tx, ctx, matterId, options),
    );
  }

  public async listReceiptsForRequestInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    requestId: string,
    options?: {
      readonly includeReversed?: boolean;
      readonly forShare?: boolean;
    },
  ): Promise<readonly MoneyOnAccountReceiptRecord[]> {
    const includeReversed = options?.includeReversed !== false;
    const lockSql = options?.forShare ? ' FOR SHARE' : '';
    const res = await tx.query<DbMoaReceiptRow>(
      `SELECT *
         FROM public.money_on_account_receipts
        WHERE tenant_id = $1
          AND request_id = $2
          ${includeReversed ? '' : 'AND reversed_at IS NULL'}
        ORDER BY recorded_at DESC, id DESC${lockSql}`,
      [ctx.tenantId, requestId],
    );
    return res.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'MoneyOnAccountReceipt');
      return mapReceiptRow(row);
    });
  }

  public async insertReceiptInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    input: {
      readonly id?: string;
      readonly requestId: string;
      readonly matterId: string;
      readonly source: MoneyOnAccountReceiptSource;
      readonly amountPence: MinorUnits;
      readonly receivedDate: string;
      readonly bankReference?: string | null;
      readonly notes?: string | null;
      readonly pmsTransactionId?: string | null;
      readonly pmsMatterCode?: string | null;
      readonly intakeCheckRecordId?: string | null;
      readonly evidenceArtifactId?: string | null;
      readonly recordedByPersonId: string;
      readonly recordedAt?: string;
    },
  ): Promise<MoneyOnAccountReceiptRecord> {
    const id = input.id?.trim() || (await this.allocateReceiptIdInTx(tx));
    const amountPenceStr = minorUnitsToPgBigInt(input.amountPence);
    const recordedAt = input.recordedAt?.trim() || new Date().toISOString();

    let res: { rows: DbMoaReceiptRow[] };
    try {
      res = await tx.query<DbMoaReceiptRow>(
        `INSERT INTO public.money_on_account_receipts (
           tenant_id, id, request_id, matter_id, source,
           amount_pence, received_date, bank_reference, notes,
           pms_transaction_id, pms_matter_code, intake_check_record_id,
           evidence_artifact_id, recorded_by_person_id, recorded_at,
           reversed_at, reversed_by_person_id, reversal_reason
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6::bigint, $7, $8, $9,
           $10, $11, $12,
           $13, $14, $15::timestamptz,
           NULL, NULL, NULL
         )
         RETURNING *`,
        [
          ctx.tenantId,
          id,
          input.requestId,
          input.matterId,
          input.source,
          amountPenceStr,
          input.receivedDate,
          input.bankReference ?? null,
          input.notes ?? null,
          input.pmsTransactionId ?? null,
          input.pmsMatterCode ?? null,
          input.intakeCheckRecordId ?? null,
          input.evidenceArtifactId ?? null,
          input.recordedByPersonId,
          recordedAt,
        ],
      );
    } catch (pgErr) {
      const code =
        (pgErr as { sqlState?: unknown })?.sqlState ??
        (pgErr as { code?: unknown })?.code;
      const constraint = String(
        (pgErr as { constraint?: unknown })?.constraint ?? '',
      );
      if (
        code === '23505' &&
        (constraint === 'uq_moa_receipts_tenant_pms_tx' ||
          String(pgErr).includes('uq_moa_receipts_tenant_pms_tx') ||
          Boolean(input.pmsTransactionId?.trim()))
      ) {
        throw makeCodedError(
          'MOA_PMS_RECEIPT_ALREADY_MATCHED',
          `PMS client ledger transaction "${input.pmsTransactionId ?? ''}" has already been matched to an active Money on Account receipt.`,
        );
      }
      throw pgErr;
    }

    const row = res.rows[0]!;
    this.assertRowTenant(ctx, row.tenant_id, 'MoneyOnAccountReceipt');
    return mapReceiptRow(row);
  }

  public async reverseReceiptInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    input: {
      readonly receiptId: string;
      readonly reversedAt?: string;
      readonly reversedByPersonId: string;
      readonly reversalReason: string;
    },
  ): Promise<MoneyOnAccountReceiptRecord> {
    const cleanReason = input.reversalReason.trim();
    if (!cleanReason) {
      throw makeCodedError(
        'VALIDATION_ERROR',
        'A reversal reason is required.',
      );
    }
    const existing = await this.getReceiptByIdInTx(tx, ctx, input.receiptId, {
      forUpdate: true,
    });
    if (!existing) {
      throw makeCodedError('NOT_FOUND', 'Money on account receipt was not found.');
    }
    if (existing.reversedAt) {
      throw makeCodedError(
        'MOA_RECEIPT_ALREADY_REVERSED',
        'This Money on Account receipt has already been reversed.',
      );
    }

    const reversedAt = input.reversedAt?.trim() || new Date().toISOString();
    const res = await tx.query<DbMoaReceiptRow>(
      `UPDATE public.money_on_account_receipts
          SET reversed_at = $3::timestamptz,
              reversed_by_person_id = $4,
              reversal_reason = $5
        WHERE tenant_id = $1
          AND id = $2
          AND reversed_at IS NULL
        RETURNING *`,
      [
        ctx.tenantId,
        input.receiptId,
        reversedAt,
        input.reversedByPersonId,
        cleanReason,
      ],
    );
    const updated = res.rows[0];
    if (!updated) {
      throw makeCodedError(
        'MOA_RECEIPT_ALREADY_REVERSED',
        'This Money on Account receipt has already been reversed.',
      );
    }
    this.assertRowTenant(ctx, updated.tenant_id, 'MoneyOnAccountReceipt');
    return mapReceiptRow(updated);
  }

  public async clearTenantDataInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
  ): Promise<void> {
    await tx.query(
      'DELETE FROM public.money_on_account_receipts WHERE tenant_id = $1',
      [ctx.tenantId],
    );
    await tx.query(
      'DELETE FROM public.money_on_account_requests WHERE tenant_id = $1',
      [ctx.tenantId],
    );
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) =>
      this.clearTenantDataInTx(tx, ctx),
    );
  }
}
