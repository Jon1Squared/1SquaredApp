/**
 * Tenant-Scoped Negotiated Rate Override Repository (`core/src/tenancy/rateOverrideRepository.ts`).
 *
 * Implements ADR 0034 §2 & Slice S0-28a (`R401`, `R402`, `R403`, `R478`, `R479`):
 * - Every read runs inside `withTenantReadTransaction` (`BEGIN READ ONLY` + `SET LOCAL ROLE`,
 *   joining an active outer `withTenantTransaction` via `AsyncLocalStorage` when present).
 * - Every write runs inside `withTenantTransaction` (`BEGIN` + `SET LOCAL ROLE`).
 * - Every SQL statement filters by `tenant_id = $1` and verifies returned rows with `assertRowTenant`.
 * - Enforces concurrency-safe date-range overlap detection (`pg_advisory_xact_lock` + `FOR UPDATE`)
 *   rejecting overlaps with `RATE_OVERRIDE_DATE_OVERLAP`.
 * - Resolves 4-tier rates (`resolveApplicableRates`) reading `matter_rate_overrides`,
 *   `client_rate_overrides`, active `organisations` (`merged_into_id IS NULL`), `choice_values`,
 *   and `tenant_module_configs` (`'matter_costs'`) inside the transaction.
 */

import type {
  ClientRateOverrideClientType,
  ClientRateOverrideRecord,
  FirmAuditEntryInput,
  MatterRateOverrideRecord,
  ParentChainNodeSummary,
  ParentOrganisationOverridesNode,
  RateCardFallbackConfig,
  RateCardFallbackEntry,
  ResolvedApplicableRatesResult,
  TenantConfiguration,
  TenantContext,
} from '../api/index';
import {
  isValidIsoCalendarDate,
  normaliseEffectiveDateBounds,
  RATE_OVERRIDE_DATE_OVERLAP_CODE,
  RATE_OVERRIDE_VALIDATION_ERROR_CODE,
  resolveApplicableRatesFromData,
} from '../domain/costs/rates';
import { minorUnitsToPounds, poundsToMinorUnits } from '../domain/money/index';
import { TenantAuditRepository } from './auditRepository';
import {
  TenantScopedRepository,
  toIsoString,
  type TenantSqlClient,
} from './tenantScopedRepository';

export const ORGANISATION_PARENT_CYCLE_CODE = 'ORGANISATION_PARENT_CYCLE' as const;
export const INVALID_PARENT_ORGANISATION_CODE = 'INVALID_PARENT_ORGANISATION' as const;

interface DbClientRateOverrideRow {
  tenant_id: string;
  id: string;
  client_type: string;
  client_id: string;
  practice_area_id: string | null;
  grade_key: string;
  rate_minor_units: string | number;
  currency: string;
  effective_from_ymd: string;
  effective_to_ymd: string | null;
  notes: string;
  created_by_id: string;
  created_at: Date | string;
  updated_by_id: string;
  updated_at: Date | string;
}

interface DbMatterRateOverrideRow {
  tenant_id: string;
  id: string;
  matter_id: string;
  grade_key: string;
  rate_minor_units: string | number;
  currency: string;
  effective_from_ymd: string;
  effective_to_ymd: string | null;
  notes: string;
  created_by_id: string;
  created_at: Date | string;
  updated_by_id: string;
  updated_at: Date | string;
}

function createCodedError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function parseMinorUnitsInput(params: {
  rateMinorUnits?: number;
  rateGbp?: number;
}): number {
  if (params.rateMinorUnits !== undefined) {
    if (!Number.isSafeInteger(params.rateMinorUnits) || params.rateMinorUnits < 0) {
      throw createCodedError(
        RATE_OVERRIDE_VALIDATION_ERROR_CODE,
        `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: Rate minor units must be a non-negative integer.`,
      );
    }
    return params.rateMinorUnits;
  }
  if (params.rateGbp !== undefined) {
    if (typeof params.rateGbp !== 'number' || !Number.isFinite(params.rateGbp) || params.rateGbp < 0) {
      throw createCodedError(
        RATE_OVERRIDE_VALIDATION_ERROR_CODE,
        `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: Hourly rate (GBP) must be a non-negative finite number.`,
      );
    }
    const raw = String(params.rateGbp);
    return /[eE]/.test(raw)
      ? poundsToMinorUnits(params.rateGbp.toFixed(4))
      : poundsToMinorUnits(raw);
  }
  throw createCodedError(
    RATE_OVERRIDE_VALIDATION_ERROR_CODE,
    `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: Either rateMinorUnits or rateGbp must be provided.`,
  );
}

function mapClientOverrideRow(row: DbClientRateOverrideRow): ClientRateOverrideRecord {
  const rateMinorUnits = Number(row.rate_minor_units);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    clientType: row.client_type as ClientRateOverrideClientType,
    clientId: row.client_id,
    practiceAreaId: row.practice_area_id ?? null,
    gradeKey: row.grade_key,
    rateMinorUnits,
    rateGbp: minorUnitsToPounds(rateMinorUnits),
    currency: row.currency || 'GBP',
    effectiveFrom: row.effective_from_ymd,
    effectiveTo: row.effective_to_ymd ?? null,
    notes: row.notes ?? '',
    createdById: row.created_by_id,
    createdAt: toIsoString(row.created_at),
    updatedById: row.updated_by_id,
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapMatterOverrideRow(row: DbMatterRateOverrideRow): MatterRateOverrideRecord {
  const rateMinorUnits = Number(row.rate_minor_units);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    matterId: row.matter_id,
    gradeKey: row.grade_key,
    rateMinorUnits,
    rateGbp: minorUnitsToPounds(rateMinorUnits),
    currency: row.currency || 'GBP',
    effectiveFrom: row.effective_from_ymd,
    effectiveTo: row.effective_to_ymd ?? null,
    notes: row.notes ?? '',
    createdById: row.created_by_id,
    createdAt: toIsoString(row.created_at),
    updatedById: row.updated_by_id,
    updatedAt: toIsoString(row.updated_at),
  };
}

export interface UpsertClientRateOverrideInput {
  id?: string;
  clientType: ClientRateOverrideClientType;
  clientId: string;
  practiceAreaId?: string | null;
  gradeKey: string;
  rateMinorUnits?: number;
  rateGbp?: number;
  currency?: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string;
  byId: string;
}

export interface UpsertMatterRateOverrideInput {
  id?: string;
  matterId: string;
  gradeKey: string;
  rateMinorUnits?: number;
  rateGbp?: number;
  currency?: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string;
  byId: string;
}

export type { ParentChainNodeSummary };

export interface ResolveApplicableRatesParams {
  asAtDate?: string;
  matterId?: string | null;
  clientId?: string | null;
  clientType?: ClientRateOverrideClientType | null;
  practiceAreaId?: string | null;
  rateCardId?: string | null;
  preferredSource?: 'auto' | 'app_table' | 'pms';
  gradeKey?: string | null;
  baseMatterCostsConfig?: TenantConfiguration['matterCosts'] | null;
  fallbackRateCardConfig?: RateCardFallbackConfig | null;
}

function formatServerLocalYmd(now: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) {
      return `${y}-${m}-${d}`;
    }
  } catch {
    // Fallback to UTC ISO date
  }
  return now.toISOString().slice(0, 10);
}

export class TenantRateOverrideRepository extends TenantScopedRepository {
  private readonly auditRepo = new TenantAuditRepository();

  private async allocateNextOverrideIdInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    kind: 'client' | 'matter',
  ): Promise<string> {
    const seqName =
      kind === 'client'
        ? 'public.tenant_client_rate_override_id_seq'
        : 'public.tenant_matter_rate_override_id_seq';
    const tableName =
      kind === 'client' ? 'public.client_rate_overrides' : 'public.matter_rate_overrides';
    const counterKey = kind === 'client' ? 'CRO' : 'MRO';
    const prefix = kind === 'client' ? 'CRO' : 'MRO';
    const pattern = `^${prefix}-([0-9]+)$`;

    const res = await tx.query<{ tenant_id: string; last_value: string }>(
      `WITH seq AS (
         SELECT nextval($2) AS val
       ),
       max_existing AS (
         SELECT COALESCE(
           MAX(SUBSTRING(id FROM $4)::bigint),
           0
         ) AS max_id
         FROM ${tableName}
         WHERE tenant_id = $1 AND id ~ $4
       )
       INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
       SELECT $1, $3, GREATEST((SELECT val FROM seq), (SELECT max_id FROM max_existing) + 1)
       ON CONFLICT (tenant_id, counter_key) DO UPDATE
         SET last_value = GREATEST(
           public.tenant_record_sequences.last_value + 1,
           EXCLUDED.last_value,
           (SELECT max_id FROM max_existing) + 1
         )
       RETURNING tenant_id, last_value::text AS last_value`,
      [ctx.tenantId, seqName, counterKey, pattern],
    );
    const row = res.rows[0];
    if (!row) {
      throw createCodedError(
        RATE_OVERRIDE_VALIDATION_ERROR_CODE,
        `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: Failed to allocate next ${prefix} rate override identifier.`,
      );
    }
    this.assertRowTenant(ctx, row.tenant_id, `tenant_record_sequences.${counterKey}`);
    return `${prefix}-${String(Number(row.last_value)).padStart(6, '0')}`;
  }

  // ---------------------------------------------------------------------------
  // Client Rate Overrides (Tier 2 & Tier 3)
  // ---------------------------------------------------------------------------

  public async listClientRateOverrides(
    ctx: TenantContext,
    options?: {
      clientId?: string;
      clientType?: ClientRateOverrideClientType;
      practiceAreaId?: string | null;
      gradeKey?: string;
      activeOnDate?: string;
    },
  ): Promise<ClientRateOverrideRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const params: unknown[] = [ctx.tenantId];
      const clauses: string[] = ['tenant_id = $1'];
      if (options?.clientId) {
        params.push(options.clientId);
        clauses.push(`client_id = $${params.length}`);
      }
      if (options?.clientType) {
        params.push(options.clientType);
        clauses.push(`client_type = $${params.length}`);
      }
      if (options?.practiceAreaId !== undefined) {
        if (options.practiceAreaId === null) {
          clauses.push('practice_area_id IS NULL');
        } else {
          params.push(options.practiceAreaId);
          clauses.push(`practice_area_id = $${params.length}`);
        }
      }
      if (options?.gradeKey) {
        params.push(options.gradeKey);
        clauses.push(`grade_key = $${params.length}`);
      }
      if (options?.activeOnDate) {
        if (!isValidIsoCalendarDate(options.activeOnDate)) {
          throw createCodedError(
            RATE_OVERRIDE_VALIDATION_ERROR_CODE,
            `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: activeOnDate must be YYYY-MM-DD.`,
          );
        }
        params.push(options.activeOnDate);
        const dateParam = `$${params.length}::date`;
        clauses.push(
          `effective_from <= ${dateParam} AND (effective_to IS NULL OR effective_to >= ${dateParam})`,
        );
      }

      const res = await tx.query<DbClientRateOverrideRow>(
        `SELECT tenant_id, id, client_type, client_id, practice_area_id, grade_key,
                rate_minor_units, currency,
                TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd,
                notes, created_by_id, created_at, updated_by_id, updated_at
         FROM public.client_rate_overrides
         WHERE ${clauses.join(' AND ')}
         ORDER BY client_id ASC, grade_key ASC, practice_area_id ASC NULLS LAST, effective_from DESC, id ASC`,
        params,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'client_rate_overrides.list');
        return mapClientOverrideRow(row);
      });
    });
  }

  public async getClientRateOverrideById(
    ctx: TenantContext,
    id: string,
  ): Promise<ClientRateOverrideRecord | null> {
    if (!id?.trim()) return null;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbClientRateOverrideRow>(
        `SELECT tenant_id, id, client_type, client_id, practice_area_id, grade_key,
                rate_minor_units, currency,
                TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd,
                notes, created_by_id, created_at, updated_by_id, updated_at
         FROM public.client_rate_overrides
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id.trim()],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'client_rate_overrides.getById');
      return mapClientOverrideRow(row);
    });
  }

  public async upsertClientRateOverride(
    ctx: TenantContext,
    input: UpsertClientRateOverrideInput,
    auditEntries?: readonly FirmAuditEntryInput[],
  ): Promise<ClientRateOverrideRecord> {
    const clientType = input.clientType;
    if (clientType !== 'person' && clientType !== 'organisation') {
      throw createCodedError(
        RATE_OVERRIDE_VALIDATION_ERROR_CODE,
        `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: clientType must be "person" or "organisation".`,
      );
    }
    const clientId = (input.clientId ?? '').trim();
    if (!clientId) {
      throw createCodedError(
        RATE_OVERRIDE_VALIDATION_ERROR_CODE,
        `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: clientId is required.`,
      );
    }
    const gradeKey = (input.gradeKey ?? '').trim();
    if (!gradeKey) {
      throw createCodedError(
        RATE_OVERRIDE_VALIDATION_ERROR_CODE,
        `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: gradeKey is required.`,
      );
    }
    const practiceAreaId = input.practiceAreaId?.trim() || null;
    const rateMinorUnits = parseMinorUnitsInput(input);
    const currency = (input.currency ?? 'GBP').trim().toUpperCase() || 'GBP';
    const { effectiveFrom, effectiveTo } = normaliseEffectiveDateBounds({
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
    });
    const byId = (input.byId || ctx.actorId || 'system').trim();
    const notes = (input.notes ?? '').trim();

    return this.withTenantTransaction(ctx, async (tx) => {
      // Verify target client exists and is active (not merged) inside this tenant database
      const clientTable =
        clientType === 'organisation' ? 'public.organisations' : 'public.people';
      const clientCheck = await tx.query<{ tenant_id: string; merged_into_id: string | null }>(
        `SELECT tenant_id, merged_into_id
         FROM ${clientTable}
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, clientId],
      );
      const clientRow = clientCheck.rows[0];
      if (!clientRow || clientRow.merged_into_id) {
        throw createCodedError(
          'NOT_FOUND',
          `NOT_FOUND: Target ${clientType} "${clientId}" was not found or has been merged.`,
        );
      }
      this.assertRowTenant(ctx, clientRow.tenant_id, `${clientTable}.verifyTarget`);

      const editId = input.id?.trim() || null;
      let existingRow: DbClientRateOverrideRow | null = null;
      if (editId) {
        const existingRes = await tx.query<DbClientRateOverrideRow>(
          `SELECT tenant_id, id, client_type, client_id, practice_area_id, grade_key,
                  rate_minor_units, currency,
                  TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                  TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd,
                  notes, created_by_id, created_at, updated_by_id, updated_at
           FROM public.client_rate_overrides
           WHERE tenant_id = $1 AND id = $2
           FOR UPDATE`,
          [ctx.tenantId, editId],
        );
        existingRow = existingRes.rows[0] ?? null;
        if (!existingRow) {
          throw createCodedError(
            'NOT_FOUND',
            `NOT_FOUND: Client rate override "${editId}" was not found.`,
          );
        }
        this.assertRowTenant(ctx, existingRow.tenant_id, 'client_rate_overrides.editLookup');
      }

      // Acquire deterministic advisory lock(s) per scope so concurrent inserts cannot race past overlap detection
      const lockKeys = new Set<string>([
        `onesquared_rate_override:${ctx.tenantId}:client:${clientId}:${practiceAreaId ?? ''}:${gradeKey}`,
      ]);
      if (existingRow) {
        lockKeys.add(
          `onesquared_rate_override:${ctx.tenantId}:client:${existingRow.client_id}:${existingRow.practice_area_id ?? ''}:${existingRow.grade_key}`,
        );
      }
      for (const lockKey of Array.from(lockKeys).sort()) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      }

      const overlapRes = await tx.query<{
        tenant_id: string;
        id: string;
        effective_from_ymd: string;
        effective_to_ymd: string | null;
      }>(
        `SELECT tenant_id, id,
                TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd
         FROM public.client_rate_overrides
         WHERE tenant_id = $1
           AND client_id = $2
           AND COALESCE(practice_area_id, '') = COALESCE($3, '')
           AND grade_key = $4
           AND ($5::text IS NULL OR id <> $5)
           AND effective_from <= COALESCE($7::date, '9999-12-31'::date)
           AND COALESCE(effective_to, '9999-12-31'::date) >= $6::date
         ORDER BY effective_from ASC, id ASC
         FOR UPDATE`,
        [ctx.tenantId, clientId, practiceAreaId, gradeKey, editId, effectiveFrom, effectiveTo],
      );
      if (overlapRes.rows.length > 0) {
        const conflict = overlapRes.rows[0]!;
        this.assertRowTenant(ctx, conflict.tenant_id, 'client_rate_overrides.overlapCheck');
        const rangeLabel = `${conflict.effective_from_ymd} to ${conflict.effective_to_ymd ?? 'open-ended'}`;
        throw createCodedError(
          RATE_OVERRIDE_DATE_OVERLAP_CODE,
          `${RATE_OVERRIDE_DATE_OVERLAP_CODE}: Effective date range (${effectiveFrom} to ${effectiveTo ?? 'open-ended'}) overlaps existing client rate override ${conflict.id} (${rangeLabel}) for grade "${gradeKey}".`,
        );
      }

      const overrideId =
        editId ?? (await this.allocateNextOverrideIdInTx(tx, ctx, 'client'));

      const savedRes = await tx.query<DbClientRateOverrideRow>(
        `INSERT INTO public.client_rate_overrides (
           tenant_id, id, client_type, client_id, practice_area_id, grade_key,
           rate_minor_units, currency, effective_from, effective_to, notes,
           created_by_id, created_at, updated_by_id, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7::bigint, $8, $9::date, $10::date, $11,
           $12, NOW(), $12, NOW()
         )
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           client_type = EXCLUDED.client_type,
           client_id = EXCLUDED.client_id,
           practice_area_id = EXCLUDED.practice_area_id,
           grade_key = EXCLUDED.grade_key,
           rate_minor_units = EXCLUDED.rate_minor_units,
           currency = EXCLUDED.currency,
           effective_from = EXCLUDED.effective_from,
           effective_to = EXCLUDED.effective_to,
           notes = EXCLUDED.notes,
           updated_by_id = EXCLUDED.updated_by_id,
           updated_at = NOW()
         RETURNING tenant_id, id, client_type, client_id, practice_area_id, grade_key,
                   rate_minor_units, currency,
                   TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                   TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd,
                   notes, created_by_id, created_at, updated_by_id, updated_at`,
        [
          ctx.tenantId,
          overrideId,
          clientType,
          clientId,
          practiceAreaId,
          gradeKey,
          rateMinorUnits,
          currency,
          effectiveFrom,
          effectiveTo,
          notes,
          byId,
        ],
      );
      const savedRow = savedRes.rows[0];
      if (!savedRow) {
        throw createCodedError(
          RATE_OVERRIDE_VALIDATION_ERROR_CODE,
          `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: Failed to persist client rate override.`,
        );
      }
      this.assertRowTenant(ctx, savedRow.tenant_id, 'client_rate_overrides.upsert');

      if (auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, auditEntries);
      }

      return mapClientOverrideRow(savedRow);
    });
  }

  public async deleteClientRateOverride(
    ctx: TenantContext,
    id: string,
    auditEntries?: readonly FirmAuditEntryInput[],
  ): Promise<boolean> {
    if (!id?.trim()) return false;
    return this.withTenantTransaction(ctx, async (tx) => {
      const del = await tx.query<{ tenant_id: string }>(
        `DELETE FROM public.client_rate_overrides
         WHERE tenant_id = $1 AND id = $2
         RETURNING tenant_id`,
        [ctx.tenantId, id.trim()],
      );
      for (const row of del.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'client_rate_overrides.delete');
      }
      if (del.rowCount > 0 && auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, auditEntries);
      }
      return del.rowCount > 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Matter Rate Overrides (Tier 1)
  // ---------------------------------------------------------------------------

  public async listMatterRateOverrides(
    ctx: TenantContext,
    options?: {
      matterId?: string;
      gradeKey?: string;
      activeOnDate?: string;
    },
  ): Promise<MatterRateOverrideRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const params: unknown[] = [ctx.tenantId];
      const clauses: string[] = ['tenant_id = $1'];
      if (options?.matterId) {
        params.push(options.matterId);
        clauses.push(`matter_id = $${params.length}`);
      }
      if (options?.gradeKey) {
        params.push(options.gradeKey);
        clauses.push(`grade_key = $${params.length}`);
      }
      if (options?.activeOnDate) {
        if (!isValidIsoCalendarDate(options.activeOnDate)) {
          throw createCodedError(
            RATE_OVERRIDE_VALIDATION_ERROR_CODE,
            `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: activeOnDate must be YYYY-MM-DD.`,
          );
        }
        params.push(options.activeOnDate);
        const dateParam = `$${params.length}::date`;
        clauses.push(
          `effective_from <= ${dateParam} AND (effective_to IS NULL OR effective_to >= ${dateParam})`,
        );
      }

      const res = await tx.query<DbMatterRateOverrideRow>(
        `SELECT tenant_id, id, matter_id, grade_key,
                rate_minor_units, currency,
                TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd,
                notes, created_by_id, created_at, updated_by_id, updated_at
         FROM public.matter_rate_overrides
         WHERE ${clauses.join(' AND ')}
         ORDER BY matter_id ASC, grade_key ASC, effective_from DESC, id ASC`,
        params,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'matter_rate_overrides.list');
        return mapMatterOverrideRow(row);
      });
    });
  }

  public async getMatterRateOverrideById(
    ctx: TenantContext,
    id: string,
  ): Promise<MatterRateOverrideRecord | null> {
    if (!id?.trim()) return null;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbMatterRateOverrideRow>(
        `SELECT tenant_id, id, matter_id, grade_key,
                rate_minor_units, currency,
                TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd,
                notes, created_by_id, created_at, updated_by_id, updated_at
         FROM public.matter_rate_overrides
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id.trim()],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'matter_rate_overrides.getById');
      return mapMatterOverrideRow(row);
    });
  }

  public async upsertMatterRateOverride(
    ctx: TenantContext,
    input: UpsertMatterRateOverrideInput,
    auditEntries?: readonly FirmAuditEntryInput[],
  ): Promise<MatterRateOverrideRecord> {
    const matterId = (input.matterId ?? '').trim();
    if (!matterId) {
      throw createCodedError(
        RATE_OVERRIDE_VALIDATION_ERROR_CODE,
        `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: matterId is required.`,
      );
    }
    const gradeKey = (input.gradeKey ?? '').trim();
    if (!gradeKey) {
      throw createCodedError(
        RATE_OVERRIDE_VALIDATION_ERROR_CODE,
        `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: gradeKey is required.`,
      );
    }
    const rateMinorUnits = parseMinorUnitsInput(input);
    const currency = (input.currency ?? 'GBP').trim().toUpperCase() || 'GBP';
    const { effectiveFrom, effectiveTo } = normaliseEffectiveDateBounds({
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
    });
    const byId = (input.byId || ctx.actorId || 'system').trim();
    const notes = (input.notes ?? '').trim();

    return this.withTenantTransaction(ctx, async (tx) => {
      const matterCheck = await tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM public.matters WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, matterId],
      );
      const matterRow = matterCheck.rows[0];
      if (!matterRow) {
        throw createCodedError(
          'NOT_FOUND',
          `NOT_FOUND: Matter "${matterId}" was not found.`,
        );
      }
      this.assertRowTenant(ctx, matterRow.tenant_id, 'matters.verifyTarget');

      const editId = input.id?.trim() || null;
      let existingRow: DbMatterRateOverrideRow | null = null;
      if (editId) {
        const existingRes = await tx.query<DbMatterRateOverrideRow>(
          `SELECT tenant_id, id, matter_id, grade_key,
                  rate_minor_units, currency,
                  TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                  TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd,
                  notes, created_by_id, created_at, updated_by_id, updated_at
           FROM public.matter_rate_overrides
           WHERE tenant_id = $1 AND id = $2
           FOR UPDATE`,
          [ctx.tenantId, editId],
        );
        existingRow = existingRes.rows[0] ?? null;
        if (!existingRow) {
          throw createCodedError(
            'NOT_FOUND',
            `NOT_FOUND: Matter rate override "${editId}" was not found.`,
          );
        }
        this.assertRowTenant(ctx, existingRow.tenant_id, 'matter_rate_overrides.editLookup');
      }

      const lockKeys = new Set<string>([
        `onesquared_rate_override:${ctx.tenantId}:matter:${matterId}:${gradeKey}`,
      ]);
      if (existingRow) {
        lockKeys.add(
          `onesquared_rate_override:${ctx.tenantId}:matter:${existingRow.matter_id}:${existingRow.grade_key}`,
        );
      }
      for (const lockKey of Array.from(lockKeys).sort()) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      }

      const overlapRes = await tx.query<{
        tenant_id: string;
        id: string;
        effective_from_ymd: string;
        effective_to_ymd: string | null;
      }>(
        `SELECT tenant_id, id,
                TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd
         FROM public.matter_rate_overrides
         WHERE tenant_id = $1
           AND matter_id = $2
           AND grade_key = $3
           AND ($4::text IS NULL OR id <> $4)
           AND effective_from <= COALESCE($6::date, '9999-12-31'::date)
           AND COALESCE(effective_to, '9999-12-31'::date) >= $5::date
         ORDER BY effective_from ASC, id ASC
         FOR UPDATE`,
        [ctx.tenantId, matterId, gradeKey, editId, effectiveFrom, effectiveTo],
      );
      if (overlapRes.rows.length > 0) {
        const conflict = overlapRes.rows[0]!;
        this.assertRowTenant(ctx, conflict.tenant_id, 'matter_rate_overrides.overlapCheck');
        const rangeLabel = `${conflict.effective_from_ymd} to ${conflict.effective_to_ymd ?? 'open-ended'}`;
        throw createCodedError(
          RATE_OVERRIDE_DATE_OVERLAP_CODE,
          `${RATE_OVERRIDE_DATE_OVERLAP_CODE}: Effective date range (${effectiveFrom} to ${effectiveTo ?? 'open-ended'}) overlaps existing matter rate override ${conflict.id} (${rangeLabel}) for grade "${gradeKey}".`,
        );
      }

      const overrideId =
        editId ?? (await this.allocateNextOverrideIdInTx(tx, ctx, 'matter'));

      const savedRes = await tx.query<DbMatterRateOverrideRow>(
        `INSERT INTO public.matter_rate_overrides (
           tenant_id, id, matter_id, grade_key,
           rate_minor_units, currency, effective_from, effective_to, notes,
           created_by_id, created_at, updated_by_id, updated_at
         ) VALUES (
           $1, $2, $3, $4,
           $5::bigint, $6, $7::date, $8::date, $9,
           $10, NOW(), $10, NOW()
         )
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           matter_id = EXCLUDED.matter_id,
           grade_key = EXCLUDED.grade_key,
           rate_minor_units = EXCLUDED.rate_minor_units,
           currency = EXCLUDED.currency,
           effective_from = EXCLUDED.effective_from,
           effective_to = EXCLUDED.effective_to,
           notes = EXCLUDED.notes,
           updated_by_id = EXCLUDED.updated_by_id,
           updated_at = NOW()
         RETURNING tenant_id, id, matter_id, grade_key,
                   rate_minor_units, currency,
                   TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                   TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd,
                   notes, created_by_id, created_at, updated_by_id, updated_at`,
        [
          ctx.tenantId,
          overrideId,
          matterId,
          gradeKey,
          rateMinorUnits,
          currency,
          effectiveFrom,
          effectiveTo,
          notes,
          byId,
        ],
      );
      const savedRow = savedRes.rows[0];
      if (!savedRow) {
        throw createCodedError(
          RATE_OVERRIDE_VALIDATION_ERROR_CODE,
          `${RATE_OVERRIDE_VALIDATION_ERROR_CODE}: Failed to persist matter rate override.`,
        );
      }
      this.assertRowTenant(ctx, savedRow.tenant_id, 'matter_rate_overrides.upsert');

      if (auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, auditEntries);
      }

      return mapMatterOverrideRow(savedRow);
    });
  }

  public async deleteMatterRateOverride(
    ctx: TenantContext,
    id: string,
    auditEntries?: readonly FirmAuditEntryInput[],
  ): Promise<boolean> {
    if (!id?.trim()) return false;
    return this.withTenantTransaction(ctx, async (tx) => {
      const del = await tx.query<{ tenant_id: string }>(
        `DELETE FROM public.matter_rate_overrides
         WHERE tenant_id = $1 AND id = $2
         RETURNING tenant_id`,
        [ctx.tenantId, id.trim()],
      );
      for (const row of del.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'matter_rate_overrides.delete');
      }
      if (del.rowCount > 0 && auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, auditEntries);
      }
      return del.rowCount > 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Parent Organisation Chain & 4-Tier Rate Resolution (`resolveApplicableRates`)
  // ---------------------------------------------------------------------------

  private async listActiveParentChainInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    organisationId: string,
  ): Promise<ParentChainNodeSummary[]> {
    const startRes = await tx.query<{
      tenant_id: string;
      id: string;
      legal_name: string;
      parent_organisation_id: string | null;
    }>(
      `SELECT tenant_id, id, legal_name, parent_organisation_id
       FROM public.organisations
       WHERE tenant_id = $1 AND id = $2 AND merged_into_id IS NULL`,
      [ctx.tenantId, organisationId],
    );
    const startRow = startRes.rows[0];
    if (!startRow) {
      return [];
    }
    this.assertRowTenant(ctx, startRow.tenant_id, 'organisations.parentChainStart');

    const chain: ParentChainNodeSummary[] = [];
    const visited = new Set<string>([startRow.id]);
    let nextParentId = startRow.parent_organisation_id;
    let hops = 0;

    while (nextParentId && !visited.has(nextParentId) && hops < 20) {
      visited.add(nextParentId);
      hops += 1;
      const parentRes = await tx.query<{
        tenant_id: string;
        id: string;
        legal_name: string;
        parent_organisation_id: string | null;
      }>(
        `SELECT tenant_id, id, legal_name, parent_organisation_id
         FROM public.organisations
         WHERE tenant_id = $1 AND id = $2 AND merged_into_id IS NULL`,
        [ctx.tenantId, nextParentId],
      );
      const parentRow = parentRes.rows[0];
      if (!parentRow) {
        // Parent missing, soft-deleted, or merged (`merged_into_id IS NOT NULL`) -> stop cleanly
        break;
      }
      this.assertRowTenant(ctx, parentRow.tenant_id, 'organisations.parentChainHop');
      chain.push({
        id: parentRow.id,
        legalName: parentRow.legal_name,
        parentOrganisationId: parentRow.parent_organisation_id,
      });
      nextParentId = parentRow.parent_organisation_id;
    }

    return chain;
  }

  public async listActiveParentOrganisationChain(
    ctx: TenantContext,
    organisationId: string,
  ): Promise<ParentChainNodeSummary[]> {
    if (!organisationId?.trim()) return [];
    return this.withTenantReadTransaction(ctx, (tx) =>
      this.listActiveParentChainInTx(tx, ctx, organisationId.trim()),
    );
  }

  private async resolveInTxRateCardConfig(
    tx: TenantSqlClient,
    ctx: TenantContext,
    baseConfig?: TenantConfiguration['matterCosts'] | null,
    explicitFallback?: RateCardFallbackConfig | null,
  ): Promise<RateCardFallbackConfig> {
    const dbCfgRes = await tx.query<{
      tenant_id: string;
      config_json: Record<string, unknown>;
    }>(
      `SELECT tenant_id, config_json
       FROM public.tenant_module_configs
       WHERE tenant_id = $1 AND config_key = 'matter_costs'`,
      [ctx.tenantId],
    );
    const dbRow = dbCfgRes.rows[0];
    if (dbRow) {
      this.assertRowTenant(ctx, dbRow.tenant_id, 'tenant_module_configs.matter_costs');
    }
    const dbOverride = dbRow?.config_json as
      | {
          rateSourceMode?: 'app_table' | 'pms_when_linked' | 'pms_only';
          pmsLinkActive?: boolean;
          allowMatterRateOverrides?: boolean;
          rateCards?: RateCardFallbackEntry[];
        }
      | undefined;

    if (explicitFallback && !dbOverride) {
      return explicitFallback;
    }

    const workTypeValuesRes = await tx.query<{
      tenant_id: string;
      id: string;
      metadata_json: Record<string, unknown>;
    }>(
      `SELECT tenant_id, id, metadata_json
       FROM public.choice_values
       WHERE tenant_id = $1 AND list_key = 'work_type'`,
      [ctx.tenantId],
    );
    const paByKeyOrId = new Map<string, string>();
    for (const r of workTypeValuesRes.rows) {
      this.assertRowTenant(ctx, r.tenant_id, 'choice_values.work_type');
      paByKeyOrId.set(r.id, r.id);
      const sk =
        typeof r.metadata_json?.systemKey === 'string'
          ? r.metadata_json.systemKey
          : null;
      if (sk) {
        paByKeyOrId.set(sk, r.id);
      }
    }

    const cfgRateSourceMode =
      dbOverride?.rateSourceMode ??
      explicitFallback?.rateSourceMode ??
      (baseConfig?.rateSourceMode === 'application_table' ? 'app_table' : 'pms_when_linked');
    const cfgPmsLinkActive =
      typeof dbOverride?.pmsLinkActive === 'boolean'
        ? dbOverride.pmsLinkActive
        : (explicitFallback?.pmsLinkActive ?? false);
    const cfgAllowOverrides =
      typeof dbOverride?.allowMatterRateOverrides === 'boolean'
        ? dbOverride.allowMatterRateOverrides
        : (explicitFallback?.allowMatterRateOverrides ??
          (typeof baseConfig?.allowMatterRateOverrides === 'boolean'
            ? baseConfig.allowMatterRateOverrides
            : true));

    const mappedBaseCards: RateCardFallbackEntry[] = (baseConfig?.rateCards ?? []).map(
      (rc) => ({
        id: rc.id,
        name: rc.name,
        practiceAreaId: rc.practiceAreaKey
          ? (paByKeyOrId.get(rc.practiceAreaKey) ?? rc.practiceAreaKey)
          : null,
        partnerRateGbp: Number(rc.partnerRateGbp) || 0,
        associateRateGbp: Number(rc.associateRateGbp) || 0,
        traineeRateGbp: Number(rc.traineeRateGbp) || 0,
        customGrades: Array.isArray(rc.customGrades) ? rc.customGrades : [],
        active: Boolean(rc.active),
      }),
    );

    const rateCards: readonly RateCardFallbackEntry[] =
      Array.isArray(dbOverride?.rateCards) && dbOverride.rateCards.length > 0
        ? dbOverride.rateCards
        : explicitFallback?.rateCards?.length
          ? explicitFallback.rateCards
          : mappedBaseCards;

    return {
      rateSourceMode: cfgRateSourceMode,
      pmsLinkActive: cfgPmsLinkActive,
      allowMatterRateOverrides: cfgAllowOverrides,
      rateCards,
    };
  }

  /**
   * Resolves 4-tier rates inside a transaction (or active outer transaction), reading
   * `matter_rate_overrides`, `client_rate_overrides`, active `organisations` (`merged_into_id IS NULL`),
   * and live `matter_costs` configuration in the tenant database.
   */
  public async resolveApplicableRates(
    ctx: TenantContext,
    params: ResolveApplicableRatesParams & { timeZone?: string } = {},
  ): Promise<ResolvedApplicableRatesResult> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const asAtDate =
        params.asAtDate?.trim() ||
        formatServerLocalYmd(new Date(), params.timeZone || 'Europe/London');

      const matterId = params.matterId?.trim() || null;
      let clientId = params.clientId?.trim() || null;
      let practiceAreaId = params.practiceAreaId?.trim() || null;

      if (matterId && (!clientId || !practiceAreaId)) {
        const mRes = await tx.query<{
          tenant_id: string;
          client_id: string;
          practice_area_id: string;
        }>(
          `SELECT tenant_id, client_id, practice_area_id
           FROM public.matters
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, matterId],
        );
        const mRow = mRes.rows[0];
        if (mRow) {
          this.assertRowTenant(ctx, mRow.tenant_id, 'matters.resolveApplicableRates');
          if (!clientId) clientId = mRow.client_id || null;
          if (!practiceAreaId) practiceAreaId = mRow.practice_area_id || null;
        }
      }

      const rateCardConfig = await this.resolveInTxRateCardConfig(
        tx,
        ctx,
        params.baseMatterCostsConfig,
        params.fallbackRateCardConfig,
      );

      let matterOverrides: MatterRateOverrideRecord[] = [];
      if (matterId && rateCardConfig.allowMatterRateOverrides) {
        const moRes = await tx.query<DbMatterRateOverrideRow>(
          `SELECT tenant_id, id, matter_id, grade_key,
                  rate_minor_units, currency,
                  TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                  TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd,
                  notes, created_by_id, created_at, updated_by_id, updated_at
           FROM public.matter_rate_overrides
           WHERE tenant_id = $1
             AND matter_id = $2
             AND effective_from <= $3::date
             AND (effective_to IS NULL OR effective_to >= $3::date)
           ORDER BY effective_from DESC, id ASC`,
          [ctx.tenantId, matterId, asAtDate],
        );
        matterOverrides = moRes.rows.map((r) => {
          this.assertRowTenant(ctx, r.tenant_id, 'matter_rate_overrides.resolve');
          return mapMatterOverrideRow(r);
        });
      }

      let directClientOverrides: ClientRateOverrideRecord[] = [];
      const parentChainOverrides: ParentOrganisationOverridesNode[] = [];

      if (clientId) {
        const directRes = await tx.query<DbClientRateOverrideRow>(
          `SELECT tenant_id, id, client_type, client_id, practice_area_id, grade_key,
                  rate_minor_units, currency,
                  TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                  TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd,
                  notes, created_by_id, created_at, updated_by_id, updated_at
           FROM public.client_rate_overrides
           WHERE tenant_id = $1
             AND client_id = $2
             AND ($4::text IS NULL OR client_type = $4)
             AND effective_from <= $3::date
             AND (effective_to IS NULL OR effective_to >= $3::date)
           ORDER BY effective_from DESC, id ASC`,
          [ctx.tenantId, clientId, asAtDate, params.clientType ?? null],
        );
        directClientOverrides = directRes.rows.map((r) => {
          this.assertRowTenant(ctx, r.tenant_id, 'client_rate_overrides.resolveDirect');
          return mapClientOverrideRow(r);
        });

        const parentChain =
          params.clientType === 'person'
            ? []
            : await this.listActiveParentChainInTx(tx, ctx, clientId);
        if (parentChain.length > 0) {
          const parentIds = parentChain.map((p) => p.id);
          const parentOverridesRes = await tx.query<DbClientRateOverrideRow>(
            `SELECT tenant_id, id, client_type, client_id, practice_area_id, grade_key,
                    rate_minor_units, currency,
                    TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                    TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd,
                    notes, created_by_id, created_at, updated_by_id, updated_at
             FROM public.client_rate_overrides
             WHERE tenant_id = $1
               AND client_id = ANY($2::text[])
               AND effective_from <= $3::date
               AND (effective_to IS NULL OR effective_to >= $3::date)
             ORDER BY effective_from DESC, id ASC`,
            [ctx.tenantId, parentIds, asAtDate],
          );
          const byParentId = new Map<string, ClientRateOverrideRecord[]>();
          for (const row of parentOverridesRes.rows) {
            this.assertRowTenant(ctx, row.tenant_id, 'client_rate_overrides.resolveParent');
            const mapped = mapClientOverrideRow(row);
            const bucket = byParentId.get(mapped.clientId) ?? [];
            bucket.push(mapped);
            byParentId.set(mapped.clientId, bucket);
          }
          for (const parentNode of parentChain) {
            parentChainOverrides.push({
              parentOrganisationId: parentNode.id,
              parentOrganisationName: parentNode.legalName,
              overrides: byParentId.get(parentNode.id) ?? [],
            });
          }
        }
      }

      return resolveApplicableRatesFromData({
        asAtDate,
        practiceAreaId,
        rateCardId: params.rateCardId,
        preferredSource: params.preferredSource,
        gradeKey: params.gradeKey,
        config: rateCardConfig,
        matterOverrides,
        directClientOverrides,
        parentChainOverrides,
      });
    });
  }

  public async countAllTenantRateOverrideRows(ctx: TenantContext): Promise<{
    clientRateOverrides: number;
    matterRateOverrides: number;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{ cro_cnt: number; mro_cnt: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM public.client_rate_overrides WHERE tenant_id = $1) AS cro_cnt,
           (SELECT COUNT(*)::int FROM public.matter_rate_overrides WHERE tenant_id = $1) AS mro_cnt`,
        [ctx.tenantId],
      );
      const row = res.rows[0];
      return {
        clientRateOverrides: Number(row?.cro_cnt ?? 0),
        matterRateOverrides: Number(row?.mro_cnt ?? 0),
      };
    });
  }

  public async clearTenantData(
    ctx: TenantContext,
    options?: {
      includeClientOverrides?: boolean;
      includeMatterOverrides?: boolean;
    },
  ): Promise<void> {
    const includeClientOverrides = options?.includeClientOverrides ?? true;
    const includeMatterOverrides = options?.includeMatterOverrides ?? true;
    if (!includeClientOverrides && !includeMatterOverrides) {
      return;
    }
    await this.withTenantTransaction(ctx, async (tx) => {
      const counterKeys: string[] = [];
      if (includeMatterOverrides) {
        await tx.query(
          'DELETE FROM public.matter_rate_overrides WHERE tenant_id = $1',
          [ctx.tenantId],
        );
        counterKeys.push('MRO');
      }
      if (includeClientOverrides) {
        await tx.query(
          'DELETE FROM public.client_rate_overrides WHERE tenant_id = $1',
          [ctx.tenantId],
        );
        counterKeys.push('CRO');
      }
      if (counterKeys.length > 0) {
        await tx.query(
          `DELETE FROM public.tenant_record_sequences
           WHERE tenant_id = $1 AND counter_key = ANY($2::text[])`,
          [ctx.tenantId, counterKeys],
        );
      }
    });
  }
}
