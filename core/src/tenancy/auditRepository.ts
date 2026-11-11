/**
 * Tenant-Scoped Append-Only Firm Audit Log Repository (`core/src/tenancy/auditRepository.ts`).
 *
 * Implements ADR 0028 §§2–5 & `S0-15` (`Owner Decision 4`, `R413`):
 * 1. Every read (`withTenantReadTransaction`) and write (`withTenantTransaction`) executes inside an
 *    explicit PostgreSQL transaction whose first statement is `SET LOCAL ROLE <role_tenant_slug_env>`.
 * 2. `audit_entries` is strictly append-only at the PostgreSQL privilege layer: `role_tenant_*` holds
 *    `SELECT, INSERT` ONLY on `public.audit_entries` (zero `UPDATE` or `DELETE` privilege, `R413`).
 * 3. Joins an active outer `withTenantTransaction` on the same `(poolManager, tenantId, databaseName)`
 *    automatically via `TenantScopedRepository`'s `AsyncLocalStorage`, so key-date and Document Generation
 *    mutations commit or roll back their `audit_entries` rows atomically in the same transaction.
 * 4. Exposes scoped queries (`listAuditEntriesForRecord` hitting `idx_audit_entries_tenant_record`, and
 *    paginated `listFirmAuditEntriesPage` hitting `idx_audit_entries_tenant_at`) so page renders never
 *    load the entire firm-wide `audit_entries` table (`R413`).
 */

import type {
  FirmAuditEntryInput,
  FirmAuditEntryRecord,
  FirmAuditPageResult,
  TenantContext,
} from '../api/index';
import {
  TenantScopedRepository,
  toIsoString,
  type TenantSqlClient,
} from './tenantScopedRepository';

const AU_ID_NUMERIC_PATTERN = /^AU-(\d+)$/;

interface DbAuditEntryRow {
  tenant_id: string;
  id: string;
  seq: string | number;
  record_type: string;
  record_id: string;
  action: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  by_id: string;
  at: Date | string;
  at_iso: string;
  snapshot_json: unknown;
}

function mapAuditRow(row: DbAuditEntryRow): FirmAuditEntryRecord {
  const mapped: FirmAuditEntryRecord = {
    id: row.id,
    seq: Number(row.seq),
    recordType: row.record_type,
    recordId: row.record_id,
    action: row.action,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    byId: row.by_id,
    at: row.at_iso || toIsoString(row.at),
    ...(row.reason !== null && row.reason !== undefined
      ? { reason: row.reason }
      : {}),
    ...(row.snapshot_json !== null && row.snapshot_json !== undefined
      ? { snapshot: structuredClone(row.snapshot_json) }
      : {}),
  };
  return mapped;
}

function formatAuditIdFromSeq(seqNum: string | number | bigint): string {
  return `AU-${String(seqNum).padStart(6, '0')}`;
}

export class TenantAuditRepository extends TenantScopedRepository {
  private async nextAuditIdInTx(tx: TenantSqlClient): Promise<string> {
    const res = await tx.query<{ seq_val: string | number }>(
      "SELECT nextval('public.tenant_audit_id_seq')::bigint AS seq_val",
    );
    const val = res.rows[0]?.seq_val ?? 1;
    return formatAuditIdFromSeq(val);
  }

  public async allocateNextAuditId(ctx: TenantContext): Promise<string> {
    return this.withTenantTransaction(ctx, (tx) => this.nextAuditIdInTx(tx));
  }

  public async allocateNextAuditIds(
    ctx: TenantContext,
    count: number,
  ): Promise<string[]> {
    const n = Math.max(0, Math.floor(count));
    if (n === 0) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        ids.push(await this.nextAuditIdInTx(tx));
      }
      return ids;
    });
  }

  public async appendAuditEntry(
    ctx: TenantContext,
    entry: FirmAuditEntryInput,
  ): Promise<FirmAuditEntryRecord> {
    const appended = await this.appendAuditEntries(ctx, [entry]);
    return appended[0]!;
  }

  public async appendAuditEntries(
    ctx: TenantContext,
    entries: readonly FirmAuditEntryInput[],
  ): Promise<FirmAuditEntryRecord[]> {
    if (entries.length === 0) {
      return [];
    }

    return this.withTenantTransaction(ctx, async (tx) => {
      const persisted: FirmAuditEntryRecord[] = [];
      let maxExplicitAuNum = 0;

      for (const entry of entries) {
        const trimmedExplicitId = entry.id?.trim();
        const id = trimmedExplicitId || (await this.nextAuditIdInTx(tx));
        if (trimmedExplicitId) {
          const match = AU_ID_NUMERIC_PATTERN.exec(trimmedExplicitId);
          if (match?.[1]) {
            const num = Number.parseInt(match[1], 10);
            if (Number.isFinite(num) && num > maxExplicitAuNum) {
              maxExplicitAuNum = num;
            }
          }
        }

        const atIso = entry.at?.trim() || new Date().toISOString();
        const parsedAtMs = Date.parse(atIso);
        const safePgTimestampIso = Number.isNaN(parsedAtMs)
          ? new Date().toISOString()
          : new Date(parsedAtMs).toISOString();

        const snapshotParam =
          entry.snapshot !== undefined ? JSON.stringify(entry.snapshot) : null;

        const insertRes = await tx.query<DbAuditEntryRow>(
          `INSERT INTO public.audit_entries (
             tenant_id, id, record_type, record_id, action, field,
             old_value, new_value, reason, by_id, at, at_iso, snapshot_json
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11::timestamptz, $12, $13::jsonb
           )
           ON CONFLICT (tenant_id, id) DO NOTHING
           RETURNING *`,
          [
            ctx.tenantId,
            id,
            entry.recordType,
            entry.recordId,
            entry.action,
            entry.field ?? null,
            entry.oldValue ?? null,
            entry.newValue ?? null,
            entry.reason ?? null,
            entry.byId,
            safePgTimestampIso,
            atIso,
            snapshotParam,
          ],
        );

        let row = insertRes.rows[0];
        if (!row) {
          const existingRes = await tx.query<DbAuditEntryRow>(
            'SELECT * FROM public.audit_entries WHERE tenant_id = $1 AND id = $2',
            [ctx.tenantId, id],
          );
          row = existingRes.rows[0];
        }
        if (!row) {
          throw new Error(
            'TENANCY_AUDIT_WRITE_ERROR: Audit entry could not be persisted or verified.',
          );
        }
        this.assertRowTenant(ctx, row.tenant_id, 'FirmAuditEntry');
        persisted.push(mapAuditRow(row));
      }

      if (maxExplicitAuNum > 0) {
        await tx.query(
          `SELECT setval(
             'public.tenant_audit_id_seq',
             GREATEST(
               CASE WHEN is_called THEN last_value ELSE 0 END,
               $1::bigint
             ),
             true
           )
           FROM public.tenant_audit_id_seq`,
          [maxExplicitAuNum],
        );
      }

      return persisted;
    });
  }

  public async listAuditEntriesForRecord(
    ctx: TenantContext,
    recordType: string,
    recordId: string,
    options?: { limit?: number },
  ): Promise<FirmAuditEntryRecord[]> {
    const safeLimit = Math.min(
      1000,
      Math.max(1, Math.floor(options?.limit ?? 200)),
    );
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbAuditEntryRow>(
        `SELECT *
         FROM public.audit_entries
         WHERE tenant_id = $1
           AND record_type = $2
           AND record_id = $3
         ORDER BY at DESC, seq DESC
         LIMIT $4`,
        [ctx.tenantId, recordType, recordId, safeLimit],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'FirmAuditEntry');
        return mapAuditRow(row);
      });
    });
  }

  public async listFirmAuditEntriesPage(
    ctx: TenantContext,
    options?: { limit?: number; beforeSeq?: number },
  ): Promise<FirmAuditPageResult> {
    const safeLimit = Math.min(
      2000,
      Math.max(1, Math.floor(options?.limit ?? 250)),
    );
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const hasCursor =
        typeof options?.beforeSeq === 'number' &&
        Number.isFinite(options.beforeSeq);

      const res = hasCursor
        ? await tx.query<DbAuditEntryRow>(
            `SELECT *
             FROM public.audit_entries
             WHERE tenant_id = $1
               AND seq < $2::bigint
             ORDER BY at DESC, seq DESC
             LIMIT $3`,
            [ctx.tenantId, Math.floor(options!.beforeSeq!), safeLimit + 1],
          )
        : await tx.query<DbAuditEntryRow>(
            `SELECT *
             FROM public.audit_entries
             WHERE tenant_id = $1
             ORDER BY at DESC, seq DESC
             LIMIT $2`,
            [ctx.tenantId, safeLimit + 1],
          );

      const hasMore = res.rows.length > safeLimit;
      const slice = hasMore ? res.rows.slice(0, safeLimit) : res.rows;
      const entries = slice.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'FirmAuditEntry');
        return mapAuditRow(row);
      });
      const lastEntry = entries.at(-1);
      const nextBeforeSeq =
        hasMore && lastEntry?.seq !== undefined ? lastEntry.seq : null;

      return {
        entries,
        nextBeforeSeq,
      };
    });
  }

  public async countAuditEntries(ctx: TenantContext): Promise<number> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM public.audit_entries WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      return Number(res.rows[0]?.cnt ?? 0);
    });
  }

  /**
   * Clears this tenant's audit log and restarts the AU- sequence, for demo reset and clean
   * deployment in non-live environments only (R453).
   *
   * Runs under the caller's own tenant role. The tenant role still has no UPDATE or DELETE on
   * `audit_entries`; the delete happens inside `public.reset_non_live_audit_log`, a
   * `SECURITY DEFINER` function that migration 0008 creates only in non-live databases and that
   * refuses again if it ever runs in a `_live` database.
   */
  public async resetNonLiveAuditLog(ctx: TenantContext): Promise<void> {
    if (ctx.environment === 'live') {
      const err = new Error(
        'LIVE_AUDIT_RESET_FORBIDDEN: Immutable audit_entries cannot be cleared in the live environment.',
      ) as Error & { code: string };
      err.code = 'LIVE_AUDIT_RESET_FORBIDDEN';
      throw err;
    }
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query('SELECT public.reset_non_live_audit_log($1)', [
        ctx.tenantId,
      ]);
    });
  }
}