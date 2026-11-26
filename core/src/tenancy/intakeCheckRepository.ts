/**
 * Tenant-Scoped Intake Check Repository (`core/src/tenancy/intakeCheckRepository.ts`).
 *
 * Persists manual Stage 1 intake check records (identity verification, sanctions/PEP,
 * manual e-signature, and minor-unit payment requests) inside per-tenant PostgreSQL (`public.intake_check_records`),
 * with `SET LOCAL ROLE`, `assertRowTenant`, and same-transaction zero-PII `audit_entries` (`ADR 0038`, `ADR 0020`).
 */

import {
  INTAKE_CHECK_OUTCOMES_BY_KIND,
  type FirmAuditEntryInput,
  type IntakeCheckKind,
  type IntakeCheckProviderMode,
  type IntakeCheckSubjectType,
  type IntakeEvidenceArtifactRef,
  type TenantContext,
} from '../api/index';
import { TenantAuditRepository } from './auditRepository';
import type { TenantPostgresPoolManager } from './postgresPoolManager';
import {
  TenantScopedRepository,
  toIsoString,
  type TenantSqlClient,
} from './tenantScopedRepository';

export const ALLOWED_INTAKE_CHECK_OUTCOMES_BY_KIND: Readonly<
  Record<IntakeCheckKind, readonly string[]>
> = INTAKE_CHECK_OUTCOMES_BY_KIND;

export function assertValidIntakeCheckOutcome(
  checkKind: IntakeCheckKind,
  outcome: unknown,
): string {
  const allowed = ALLOWED_INTAKE_CHECK_OUTCOMES_BY_KIND[checkKind];
  if (!allowed || typeof outcome !== 'string' || !allowed.includes(outcome)) {
    throw new Error(
      `INTAKE_CHECK_INVALID_OUTCOME: Invalid outcome "${String(outcome)}" for intake check kind "${checkKind}".`,
    );
  }
  return outcome;
}

export interface StoredIntakeCheckRow {
  readonly id: string;
  readonly tenantId: string;
  readonly checkKind: IntakeCheckKind;
  readonly provider: IntakeCheckProviderMode;
  readonly subjectType: IntakeCheckSubjectType;
  readonly subjectId: string;
  readonly outcome: string;
  readonly amountMinorUnits: bigint | null;
  readonly currency: 'GBP' | null;
  readonly referenceCode: string | null;
  readonly metadata: Record<string, unknown>;
  readonly evidenceRefs: readonly IntakeEvidenceArtifactRef[];
  readonly recordedByPersonId: string;
  readonly recordedAt: string;
  readonly correlationId: string;
}

interface DbIntakeCheckRow {
  tenant_id: string;
  id: string;
  check_kind: string;
  provider: string;
  subject_type: string;
  subject_id: string;
  outcome: string;
  amount_minor_units: string | number | bigint | null;
  currency: string | null;
  reference_code: string | null;
  metadata_json: unknown;
  evidence_refs_json: unknown;
  recorded_by_person_id: string;
  recorded_at: Date | string;
  correlation_id: string;
}

function mapIntakeCheckRow(row: DbIntakeCheckRow): StoredIntakeCheckRow {
  const metadata =
    row.metadata_json &&
    typeof row.metadata_json === 'object' &&
    !Array.isArray(row.metadata_json)
      ? structuredClone(row.metadata_json as Record<string, unknown>)
      : {};
  const evidenceRefs = Array.isArray(row.evidence_refs_json)
    ? structuredClone(row.evidence_refs_json as IntakeEvidenceArtifactRef[])
    : [];
  const rawMinor = row.amount_minor_units;
  const amountMinorUnits =
    rawMinor === null || rawMinor === undefined ? null : BigInt(rawMinor);

  return {
    id: row.id,
    tenantId: row.tenant_id,
    checkKind: row.check_kind as IntakeCheckKind,
    provider: row.provider as IntakeCheckProviderMode,
    subjectType: row.subject_type as IntakeCheckSubjectType,
    subjectId: row.subject_id,
    outcome: row.outcome,
    amountMinorUnits,
    currency: (row.currency as 'GBP' | null) ?? null,
    referenceCode: row.reference_code ?? null,
    metadata,
    evidenceRefs,
    recordedByPersonId: row.recorded_by_person_id,
    recordedAt: toIsoString(row.recorded_at) ?? new Date().toISOString(),
    correlationId: row.correlation_id,
  };
}

export class TenantIntakeCheckRepository extends TenantScopedRepository {
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

  public async recordCheckInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    input: {
      readonly checkKind: IntakeCheckKind;
      readonly provider: IntakeCheckProviderMode;
      readonly subjectType: IntakeCheckSubjectType;
      readonly subjectId: string;
      readonly outcome: string;
      readonly amountMinorUnits?: bigint | null;
      readonly currency?: 'GBP' | null;
      readonly referenceCode?: string | null;
      readonly metadata: Record<string, unknown>;
      readonly evidenceRefs: readonly IntakeEvidenceArtifactRef[];
      readonly auditAction?: string;
    },
  ): Promise<StoredIntakeCheckRow> {
    if (!ctx?.actorId) {
      throw new Error(
        'INTAKE_CHECK_INVALID_ACTOR: Authenticated actorId is required to record an intake check.',
      );
    }
    const subjectId = input.subjectId.trim();
    if (!subjectId) {
      throw new Error(
        'INTAKE_CHECK_INVALID_SUBJECT: Non-empty subjectId is required.',
      );
    }
    const outcome = assertValidIntakeCheckOutcome(input.checkKind, input.outcome);

    const seqRes = await tx.query<{ seq: string }>(
      `SELECT nextval('public.tenant_intake_check_id_seq')::text AS seq`,
    );
    const id = `ICHK-${String(seqRes.rows[0]?.seq ?? '1').padStart(6, '0')}`;
    const recordedAt = new Date().toISOString();
    const amountStr =
      input.amountMinorUnits === null || input.amountMinorUnits === undefined
        ? null
        : input.amountMinorUnits.toString();

    const insertRes = await tx.query<DbIntakeCheckRow>(
      `INSERT INTO public.intake_check_records (
         tenant_id, id, check_kind, provider, subject_type, subject_id,
         outcome, amount_minor_units, currency, reference_code,
         metadata_json, evidence_refs_json, recorded_by_person_id, recorded_at, correlation_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8::bigint, $9, $10,
         $11::jsonb, $12::jsonb, $13, $14::timestamptz, $15
       )
       RETURNING *`,
      [
        ctx.tenantId,
        id,
        input.checkKind,
        input.provider,
        input.subjectType,
        subjectId,
        outcome,
        amountStr,
        input.currency ?? null,
        input.referenceCode ?? null,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.evidenceRefs ?? []),
        ctx.actorId,
        recordedAt,
        ctx.correlationId,
      ],
    );

    const inserted = insertRes.rows[0]!;
    this.assertRowTenant(ctx, inserted.tenant_id, 'IntakeCheckRecord');

    // Append zero-PII audit entry in the same transaction (ADR 0020)
    const auditEntry: FirmAuditEntryInput = {
      recordType: 'intake_check',
      recordId: inserted.id,
      action: input.auditAction ?? 'intake-check-recorded',
      field: input.checkKind,
      oldValue: null,
      newValue: `${input.provider}:${input.outcome}`,
      byId: ctx.actorId,
      at: recordedAt,
      reason: `Intake check recorded (kind=${input.checkKind}, provider=${input.provider}, subjectType=${input.subjectType}, evidenceCount=${input.evidenceRefs.length}, correlationId=${ctx.correlationId}).`,
    };
    await this.auditRepo.appendAuditEntries(ctx, [auditEntry]);

    return mapIntakeCheckRow(inserted);
  }

  public async recordCheck(
    ctx: TenantContext,
    input: {
      readonly checkKind: IntakeCheckKind;
      readonly provider: IntakeCheckProviderMode;
      readonly subjectType: IntakeCheckSubjectType;
      readonly subjectId: string;
      readonly outcome: string;
      readonly amountMinorUnits?: bigint | null;
      readonly currency?: 'GBP' | null;
      readonly referenceCode?: string | null;
      readonly metadata: Record<string, unknown>;
      readonly evidenceRefs: readonly IntakeEvidenceArtifactRef[];
      readonly auditAction?: string;
    },
  ): Promise<StoredIntakeCheckRow> {
    return this.withTenantTransaction(ctx, async (tx) =>
      this.recordCheckInTx(tx, ctx, input),
    );
  }

  public async getCheckById(
    ctx: TenantContext,
    id: string,
  ): Promise<StoredIntakeCheckRow | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbIntakeCheckRow>(
        `SELECT *
           FROM public.intake_check_records
          WHERE tenant_id = $1
            AND id = $2
          LIMIT 1`,
        [ctx.tenantId, id],
      );
      const row = res.rows[0];
      if (!row) {
        return null;
      }
      this.assertRowTenant(ctx, row.tenant_id, 'IntakeCheckRecord');
      return mapIntakeCheckRow(row);
    });
  }

  public async getLatestCheckForSubject(
    ctx: TenantContext,
    params: {
      readonly checkKind: IntakeCheckKind;
      readonly subjectType: IntakeCheckSubjectType;
      readonly subjectId: string;
    },
  ): Promise<StoredIntakeCheckRow | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbIntakeCheckRow>(
        `SELECT *
           FROM public.intake_check_records
          WHERE tenant_id = $1
            AND subject_type = $2
            AND subject_id = $3
            AND check_kind = $4
          ORDER BY recorded_at DESC, id DESC
          LIMIT 1`,
        [ctx.tenantId, params.subjectType, params.subjectId, params.checkKind],
      );
      const row = res.rows[0];
      if (!row) {
        return null;
      }
      this.assertRowTenant(ctx, row.tenant_id, 'IntakeCheckRecord');
      return mapIntakeCheckRow(row);
    });
  }

  public async listChecksForSubject(
    ctx: TenantContext,
    params: {
      readonly subjectType: IntakeCheckSubjectType;
      readonly subjectId: string;
      readonly checkKind?: IntakeCheckKind;
    },
  ): Promise<readonly StoredIntakeCheckRow[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = params.checkKind
        ? await tx.query<DbIntakeCheckRow>(
            `SELECT *
               FROM public.intake_check_records
              WHERE tenant_id = $1
                AND subject_type = $2
                AND subject_id = $3
                AND check_kind = $4
              ORDER BY recorded_at DESC, id DESC`,
            [
              ctx.tenantId,
              params.subjectType,
              params.subjectId,
              params.checkKind,
            ],
          )
        : await tx.query<DbIntakeCheckRow>(
            `SELECT *
               FROM public.intake_check_records
              WHERE tenant_id = $1
                AND subject_type = $2
                AND subject_id = $3
              ORDER BY recorded_at DESC, id DESC`,
            [ctx.tenantId, params.subjectType, params.subjectId],
          );

      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'IntakeCheckRecord');
        return mapIntakeCheckRow(row);
      });
    });
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        'DELETE FROM public.intake_check_records WHERE tenant_id = $1',
        [ctx.tenantId],
      );
    });
  }
}
