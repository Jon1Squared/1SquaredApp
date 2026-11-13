/**
 * Tenant-Scoped HR, Teams & RBAC Repository (`core/src/tenancy/hrRbacRepository.ts`).
 *
 * Implements ADR 0028 §§2–5 & `S0-17b` (`Owner Decision 1`, `Owner Decision 2`, `Owner Decision 5`, `R408`, `R410`, `R413`, `R417`, `R421`):
 * 1. Every read (`withTenantReadTransaction`) and write (`withTenantTransaction`) executes inside an
 *    explicit PostgreSQL transaction whose first statement is `SET LOCAL ROLE <role_tenant_slug_env>`.
 * 2. Every SQL statement scopes by `tenant_id = $1` and every returned row is verified via `assertRowTenant`.
 * 3. `employee_employment_records` and `employee_sensitive_records` enforce `ON DELETE RESTRICT` against
 *    `public.people (tenant_id, id)` (`R413`) so statutory HR retention records cannot be cascade-deleted.
 * 4. Every employment write synchronises `public.person_emails` (`source = 'firm_work_email'`) in the same
 *    PostgreSQL transaction (`R410`) so `resolveOrProvisionEntraEmployee` (`B13` / `S0-30`) matches updated
 *    `firmWorkEmail` addresses immediately.
 * 5. Sensitive HR and payroll reads/writes (`view-payroll`, `view-sensitive`, `update-payroll`,
 *    `update-sensitive`) commit their `audit_entries` in the same PostgreSQL transaction (`R444`, `R446`).
 */

import type {
  FirmAuditEntryInput,
  FirmAuditEntryRecord,
  RbacConfiguration,
  TenantContext,
} from '../api/index';
import { TenantAuditRepository } from './auditRepository';
import {
  getActiveTenantTransactionState,
  TenantScopedRepository,
  type TenantSqlClient,
  toIsoString,
} from './tenantScopedRepository';

export type TenantScopedRepositoryOptions = NonNullable<
  ConstructorParameters<typeof TenantScopedRepository>[0]
>;

export interface TenantTeamRecord {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  leadIds: string[];
  practiceAreaIds: string[];
  active: boolean;
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
}

export interface TenantEmploymentRecord {
  id?: string;
  personId: string;
  engagementType?: string;
  status?: string;
  employeeNumber?: string;
  employingEntityId?: string;
  jobTitle?: string;
  gradeOrBand?: string;
  roleType?: string;
  divisionId?: string | null;
  departmentId?: string;
  teamOrPracticeGroupId?: string | null;
  officeId?: string | null;
  costCentreId?: string | null;
  profitCentreId?: string | null;
  isTopOfHierarchy?: boolean;
  lineManagerId?: string | null;
  supervisingPartnerId?: string | null;
  timesheetApproverId?: string | null;
  holidayApproverId?: string | null;
  onboardingBuddyId?: string | null;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  assignmentHistory?: Array<Record<string, unknown>>;
  contract?: {
    startDate?: string;
    leavingDate?: string | null;
    noticePeriod?: string;
    noticeEndDate?: string | null;
    hrRetentionUntil?: string | null;
    [key: string]: unknown;
  } | null;
  feeEarner?: Record<string, unknown> | null;
  rightToWork?: Record<string, unknown> | null;
  payroll?: Record<string, unknown> | null;
  emergencyContacts?: Array<Record<string, unknown>>;
  systems?: {
    firmWorkEmail?: string;
    [key: string]: unknown;
  } | null;
  conflictCheckOnHire?: Record<string, unknown> | null;
  createdById?: string;
  createdAt?: string;
  updatedById?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export type TenantEmployeeEmploymentPayload = TenantEmploymentRecord;

export interface TenantEmployeeSensitiveRecord {
  personId: string;
  reasonableAdjustmentsNeeded: string;
  diversity: unknown;
  updatedById: string;
  updatedAt: string;
}

export type TenantEmployeeSensitiveHrPayload = TenantEmployeeSensitiveRecord;

export interface TenantEmployeeMigrationReportRecord {
  migratedAt: string;
  migratedCount?: number;
  employeesMigrated?: number;
  unmappedRecords?: Array<{
    personId: string;
    personName: string;
    field: 'employeeRoleId' | 'departmentId';
    rawValue: string;
    reason: string;
  }>;
}

export type TenantEmployeeMigrationReportPayload =
  TenantEmployeeMigrationReportRecord;

export type TenantRbacConfigOverridePayload = Partial<RbacConfiguration>;

export interface AuthoritativePersonEmploymentImportRow {
  personId: string;
  employment: TenantEmploymentRecord | null;
  mergedIntoId: string | null;
}

interface TeamRow extends Record<string, unknown> {
  tenant_id: string;
  id: string;
  name: string;
  description: string;
  active: boolean;
  created_by_id: string | null;
  updated_by_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  member_ids_json: string[] | null;
  lead_ids_json: string[] | null;
  practice_area_ids_json: string[] | null;
  payload_json: Record<string, unknown> | null;
}

interface EmploymentRow extends Record<string, unknown> {
  tenant_id: string;
  person_id: string;
  employment_status: string | null;
  worker_type: string | null;
  start_date: string | null;
  leaving_date: string | null;
  notice_end_date: string | null;
  hr_retention_until: string | null;
  updated_at: Date | string;
  employment_json: Record<string, unknown> | null;
  payroll_json?: Record<string, unknown> | null;
}

interface SensitiveRow extends Record<string, unknown> {
  tenant_id: string;
  person_id: string;
  updated_at: Date | string;
  updated_by_id: string | null;
  payroll_json: Record<string, unknown> | null;
  sensitive_hr_json: Record<string, unknown> | null;
}

interface EmployeeMigrationReportRow extends Record<string, unknown> {
  tenant_id: string;
  updated_at: Date | string;
  report_json: Record<string, unknown> | null;
}

interface TenantRbacConfigRow extends Record<string, unknown> {
  tenant_id: string;
  updated_at: Date | string;
  updated_by_id: string | null;
  rbac_override_json: Partial<RbacConfiguration> | null;
}

function safeTimestampIso(value: string | undefined | null): string {
  if (!value || typeof value !== 'string') {
    return new Date().toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed)
    ? new Date().toISOString()
    : new Date(parsed).toISOString();
}

function mapTeamRow<TTeam extends TenantTeamRecord = TenantTeamRecord>(
  row: TeamRow,
): TTeam {
  const payload =
    row.payload_json && typeof row.payload_json === 'object'
      ? structuredClone(row.payload_json)
      : {};
  const createdAt =
    (payload.createdAt as string | undefined) ?? toIsoString(row.created_at);
  const updatedAt =
    (payload.updatedAt as string | undefined) ?? toIsoString(row.updated_at);
  return {
    ...payload,
    id: row.id,
    name: row.name ?? '',
    description: row.description ?? '',
    memberIds: Array.isArray(row.member_ids_json)
      ? [...row.member_ids_json]
      : [],
    leadIds: Array.isArray(row.lead_ids_json) ? [...row.lead_ids_json] : [],
    practiceAreaIds: Array.isArray(row.practice_area_ids_json)
      ? [...row.practice_area_ids_json]
      : [],
    active: Boolean(row.active),
    createdById:
      row.created_by_id ?? (payload.createdById as string | undefined) ?? 'system',
    createdAt,
    updatedById:
      row.updated_by_id ?? (payload.updatedById as string | undefined) ?? 'system',
    updatedAt,
  } as TTeam;
}

function mapEmploymentRow<
  TEmp extends TenantEmploymentRecord = TenantEmploymentRecord,
>(row: EmploymentRow): TEmp {
  const base =
    row.employment_json && typeof row.employment_json === 'object'
      ? structuredClone(row.employment_json)
      : {};
  if (row.payroll_json !== undefined && row.payroll_json !== null) {
    base.payroll = structuredClone(row.payroll_json);
  }
  return {
    ...base,
    personId: row.person_id,
    status: (row.employment_status ?? base.status ?? 'Active') as string,
    engagementType: (row.worker_type ??
      base.engagementType ??
      'Employee') as string,
  } as TEmp;
}

function mapSensitiveRow<
  TSens extends TenantEmployeeSensitiveRecord = TenantEmployeeSensitiveRecord,
>(row: SensitiveRow): TSens | null {
  if (!row.sensitive_hr_json || typeof row.sensitive_hr_json !== 'object') {
    return null;
  }
  const cloned = structuredClone(row.sensitive_hr_json);
  return {
    ...cloned,
    personId: row.person_id,
    reasonableAdjustmentsNeeded:
      (cloned.reasonableAdjustmentsNeeded as string | undefined) ?? '',
    diversity:
      cloned.diversity && typeof cloned.diversity === 'object'
        ? structuredClone(cloned.diversity as Record<string, unknown>)
        : {},
    updatedById:
      row.updated_by_id ??
      (cloned.updatedById as string | undefined) ??
      'system',
    updatedAt:
      (cloned.updatedAt as string | undefined) ?? toIsoString(row.updated_at),
  } as TSens;
}

/**
 * Synchronises the `'firm_work_email'` entry in `public.person_emails` for `personId`
 * inside an active transaction (`R410`).
 */
export async function syncPersonFirmWorkEmailInTx(
  tx: TenantSqlClient,
  ctx: TenantContext,
  personId: string,
  employment: Record<string, unknown> | null | undefined,
  options?: { isMergedOrTombstoned?: boolean },
): Promise<void> {
  await tx.query(
    `DELETE FROM public.person_emails
     WHERE tenant_id = $1 AND person_id = $2 AND source = 'firm_work_email'`,
    [ctx.tenantId, personId],
  );
  if (!employment || typeof employment !== 'object') {
    return;
  }
  const systems =
    employment.systems && typeof employment.systems === 'object'
      ? (employment.systems as { firmWorkEmail?: string | null })
      : null;
  const firmWorkEmailLower =
    systems?.firmWorkEmail?.trim().toLowerCase() ?? '';
  if (!firmWorkEmailLower) {
    return;
  }

  let isTombstoned = Boolean(options?.isMergedOrTombstoned);
  if (options?.isMergedOrTombstoned === undefined) {
    const pRes = await tx.query<{
      tenant_id: string;
      merged_into_id: string | null;
      profile_json: Record<string, unknown> | null;
    }>(
      'SELECT tenant_id, merged_into_id, profile_json FROM public.people WHERE tenant_id = $1 AND id = $2',
      [ctx.tenantId, personId],
    );
    const pRow = pRes.rows[0];
    if (pRow) {
      const recordStatusId =
        (pRow.profile_json?.recordStatusId as string | undefined) ?? '';
      isTombstoned =
        Boolean(pRow.merged_into_id) ||
        recordStatusId.endsWith('.inactive') ||
        recordStatusId.endsWith('.archived');
    }
  }

  const isActiveWorkEmail =
    !isTombstoned && (employment.status as string | undefined) !== 'Leaver';

  await tx.query(
    `INSERT INTO public.person_emails (
       tenant_id, person_id, email_lower, source, is_primary, active, updated_at
     ) VALUES ($1, $2, $3, 'firm_work_email', FALSE, $4, NOW())
     ON CONFLICT (tenant_id, person_id, email_lower, source) DO UPDATE SET
       active = EXCLUDED.active,
       updated_at = NOW()`,
    [ctx.tenantId, personId, firmWorkEmailLower, isActiveWorkEmail],
  );
}

/**
 * Upserts a person's `employee_employment_records` row (and `employee_sensitive_records.payroll_json`
 * when `employment.payroll` is present) plus `person_emails` (`source = 'firm_work_email'`)
 * inside an active transaction (`R410`, `R413`, `R417`).
 */
export async function upsertPersonEmploymentAndPayrollInTx(
  tx: TenantSqlClient,
  ctx: TenantContext,
  personId: string,
  employment: Record<string, unknown> | null | undefined,
  options?: {
    updatedById?: string | null;
    updatedAt?: string | null;
    isMergedOrTombstoned?: boolean;
  },
): Promise<void> {
  if (!employment || typeof employment !== 'object') {
    await syncPersonFirmWorkEmailInTx(tx, ctx, personId, null, {
      isMergedOrTombstoned: options?.isMergedOrTombstoned,
    });
    return;
  }

  const contract =
    employment.contract && typeof employment.contract === 'object'
      ? (employment.contract as Record<string, unknown>)
      : null;
  const employmentStatus =
    (employment.status as string | null | undefined) ?? 'Active';
  const workerType =
    (employment.engagementType as string | null | undefined) ?? 'Employee';
  const startDate =
    (contract?.startDate as string | null | undefined) ??
    (employment.effectiveFrom as string | null | undefined) ??
    null;
  const leavingDate =
    (contract?.leavingDate as string | null | undefined) ??
    (employment.effectiveTo as string | null | undefined) ??
    null;
  const noticeEndDate =
    (contract?.noticeEndDate as string | null | undefined) ??
    (employment.noticeEndDate as string | null | undefined) ??
    null;
  const hrRetentionUntil =
    (contract?.hrRetentionUntil as string | null | undefined) ??
    (employment.hrRetentionUntil as string | null | undefined) ??
    null;
  const updatedAtIso = safeTimestampIso(
    options?.updatedAt ??
      (employment.updatedAt as string | null | undefined) ??
      null,
  );

  await tx.query(
    `INSERT INTO public.employee_employment_records (
       tenant_id, person_id, employment_status, worker_type,
       start_date, leaving_date, notice_end_date, hr_retention_until,
       updated_at, employment_json
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9::timestamptz, $10::jsonb
     )
     ON CONFLICT (tenant_id, person_id) DO UPDATE SET
       employment_status = EXCLUDED.employment_status,
       worker_type = EXCLUDED.worker_type,
       start_date = EXCLUDED.start_date,
       leaving_date = EXCLUDED.leaving_date,
       notice_end_date = EXCLUDED.notice_end_date,
       hr_retention_until = EXCLUDED.hr_retention_until,
       updated_at = EXCLUDED.updated_at,
       employment_json = EXCLUDED.employment_json`,
    [
      ctx.tenantId,
      personId,
      employmentStatus,
      workerType,
      startDate,
      leavingDate,
      noticeEndDate,
      hrRetentionUntil,
      updatedAtIso,
      JSON.stringify(employment),
    ],
  );

  if (Object.prototype.hasOwnProperty.call(employment, 'payroll')) {
    const payrollObj =
      employment.payroll && typeof employment.payroll === 'object'
        ? (employment.payroll as Record<string, unknown>)
        : null;
    const updatedBy =
      options?.updatedById ??
      (employment.updatedById as string | null | undefined) ??
      'system';
    await tx.query(
      `INSERT INTO public.employee_sensitive_records (
         tenant_id, person_id, updated_at, updated_by_id, payroll_json, sensitive_hr_json
       ) VALUES ($1, $2, $3::timestamptz, $4, $5::jsonb, NULL)
       ON CONFLICT (tenant_id, person_id) DO UPDATE SET
         updated_at = EXCLUDED.updated_at,
         updated_by_id = EXCLUDED.updated_by_id,
         payroll_json = EXCLUDED.payroll_json`,
      [
        ctx.tenantId,
        personId,
        updatedAtIso,
        updatedBy,
        payrollObj ? JSON.stringify(payrollObj) : null,
      ],
    );
  }

  await syncPersonFirmWorkEmailInTx(tx, ctx, personId, employment, {
    isMergedOrTombstoned: options?.isMergedOrTombstoned,
  });
}

export class TenantHrAndRbacRepository extends TenantScopedRepository {
  private readonly auditRepo: TenantAuditRepository;

  public constructor(options: TenantScopedRepositoryOptions = {}) {
    super(options);
    this.auditRepo = new TenantAuditRepository(options);
  }

  private async allocateScopedSequenceInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    prefix: 'TM',
    pgSeqName: 'public.tenant_team_id_seq',
  ): Promise<string> {
    const seqRes = await tx.query<{ next_val: string | number }>(
      `SELECT nextval('${pgSeqName}')::bigint AS next_val`,
    );
    const seqVal = Number(seqRes.rows[0]?.next_val ?? 1);
    const rowRes = await tx.query<{
      tenant_id: string;
      counter_key: string;
      last_value: string | number;
    }>(
      `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
       VALUES ($1, $2, GREATEST(1::bigint, $3::bigint))
       ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
         last_value = GREATEST(public.tenant_record_sequences.last_value + 1, EXCLUDED.last_value)
       RETURNING tenant_id, counter_key, last_value`,
      [ctx.tenantId, prefix, seqVal],
    );
    const row = rowRes.rows[0];
    if (!row) {
      throw new Error(
        `TENANCY_SEQUENCE_ERROR: Failed to allocate ${prefix} sequence.`,
      );
    }
    this.assertRowTenant(ctx, row.tenant_id, 'tenant_record_sequences');
    const allocated = Number(row.last_value);
    return `${prefix}-${String(allocated).padStart(6, '0')}`;
  }

  public async allocateNextTeamId(ctx: TenantContext): Promise<string> {
    return this.withTenantTransaction(ctx, (tx) =>
      this.allocateScopedSequenceInTx(
        tx,
        ctx,
        'TM',
        'public.tenant_team_id_seq',
      ),
    );
  }

  public async advanceTeamSequenceToAtLeast(
    ctx: TenantContext,
    minCounterValue: number,
  ): Promise<void> {
    const safeMin = Math.max(0, Math.floor(minCounterValue));
    if (safeMin <= 0) return;
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
         VALUES ($1, 'TM', $2::bigint)
         ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
           last_value = GREATEST(public.tenant_record_sequences.last_value, EXCLUDED.last_value)`,
        [ctx.tenantId, safeMin],
      );
    });
  }

  // ============================================================================
  // Teams (`teams`)
  // ============================================================================

  private async upsertTeamInTx<TTeam extends TenantTeamRecord = TenantTeamRecord>(
    tx: TenantSqlClient,
    ctx: TenantContext,
    team: TTeam,
  ): Promise<TTeam> {
    if (!team.id?.trim() || !team.name?.trim()) {
      const err = new Error(
        'TEAM_VALIDATION_ERROR: Team id and name are required.',
      ) as Error & { code: string };
      err.code = 'TEAM_VALIDATION_ERROR';
      throw err;
    }

    const memberIds = Array.isArray(team.memberIds) ? [...team.memberIds] : [];
    const leadIds = Array.isArray(team.leadIds) ? [...team.leadIds] : [];
    const practiceAreaIds = Array.isArray(team.practiceAreaIds)
      ? [...team.practiceAreaIds]
      : [];
    const createdAtIso = safeTimestampIso(team.createdAt);
    const updatedAtIso = safeTimestampIso(team.updatedAt);

    const res = await tx.query<TeamRow>(
      `INSERT INTO public.teams (
         tenant_id, id, name, description, active,
         created_by_id, updated_by_id, created_at, updated_at,
         member_ids_json, lead_ids_json, practice_area_ids_json, payload_json
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8::timestamptz, $9::timestamptz,
         $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         active = EXCLUDED.active,
         created_by_id = EXCLUDED.created_by_id,
         updated_by_id = EXCLUDED.updated_by_id,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         member_ids_json = EXCLUDED.member_ids_json,
         lead_ids_json = EXCLUDED.lead_ids_json,
         practice_area_ids_json = EXCLUDED.practice_area_ids_json,
         payload_json = EXCLUDED.payload_json
       RETURNING *`,
      [
        ctx.tenantId,
        team.id,
        team.name.trim(),
        team.description ?? '',
        team.active !== false,
        team.createdById ?? 'system',
        team.updatedById ?? 'system',
        createdAtIso,
        updatedAtIso,
        JSON.stringify(memberIds),
        JSON.stringify(leadIds),
        JSON.stringify(practiceAreaIds),
        JSON.stringify(team),
      ],
    );

    const saved = res.rows[0];
    if (!saved) {
      throw new Error('TENANCY_ISOLATION_ERROR: Team row could not be persisted.');
    }
    this.assertRowTenant(ctx, saved.tenant_id, 'teams');

    const match = /^TM-(\d+)$/.exec(team.id);
    if (match?.[1]) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n) && n > 0) {
        await tx.query(
          `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
           VALUES ($1, 'TM', $2::bigint)
           ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
             last_value = GREATEST(public.tenant_record_sequences.last_value, EXCLUDED.last_value)`,
          [ctx.tenantId, n],
        );
      }
    }

    return mapTeamRow<TTeam>(saved);
  }

  public async putTeam<TTeam extends TenantTeamRecord = TenantTeamRecord>(
    ctx: TenantContext,
    team: TTeam,
    options?: { auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<TTeam> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const saved = await this.upsertTeamInTx<TTeam>(tx, ctx, team);
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return saved;
    });
  }

  public async putTeams<TTeam extends TenantTeamRecord = TenantTeamRecord>(
    ctx: TenantContext,
    teams: readonly TTeam[],
    options?: { auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<TTeam[]> {
    if (teams.length === 0 && !options?.auditEntries?.length) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: TTeam[] = [];
      for (const team of teams) {
        out.push(await this.upsertTeamInTx<TTeam>(tx, ctx, team));
      }
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return out;
    });
  }

  public async getTeamById<TTeam extends TenantTeamRecord = TenantTeamRecord>(
    ctx: TenantContext,
    id: string,
  ): Promise<TTeam | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<TeamRow>(
        'SELECT * FROM public.teams WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'teams');
      return mapTeamRow<TTeam>(row);
    });
  }

  public async listAllTeams<TTeam extends TenantTeamRecord = TenantTeamRecord>(
    ctx: TenantContext,
    options?: { activeOnly?: boolean },
  ): Promise<TTeam[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses = ['tenant_id = $1'];
      if (options?.activeOnly) {
        clauses.push('active = TRUE');
      }
      const res = await tx.query<TeamRow>(
        `SELECT *
         FROM public.teams
         WHERE ${clauses.join(' AND ')}
         ORDER BY id ASC`,
        [ctx.tenantId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'teams');
        return mapTeamRow<TTeam>(row);
      });
    });
  }

  public async deleteTeamById(
    ctx: TenantContext,
    id: string,
    options?: { auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const del = await tx.query(
        'DELETE FROM public.teams WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return del.rowCount > 0;
    });
  }

  // ============================================================================
  // Employment Records (`employee_employment_records` + `person_emails` `R410`)
  // ============================================================================

  public async appendHrAuditEntriesInTx(
    ctx: TenantContext,
    entries: readonly FirmAuditEntryInput[],
  ): Promise<FirmAuditEntryRecord[]> {
    if (entries.length === 0) return [];
    return this.auditRepo.appendAuditEntries(ctx, entries);
  }

  public async putEmploymentRecord<
    TEmp extends TenantEmploymentRecord = TenantEmploymentRecord,
  >(
    ctx: TenantContext,
    personId: string,
    employment: TEmp,
    options?: {
      updatedById?: string | null;
      updatedAt?: string | null;
      syncFirmWorkEmail?: boolean;
      personMergedIntoId?: string | null;
      isMergedOrTombstoned?: boolean;
      auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<TEmp> {
    return this.withTenantTransaction(ctx, async (tx) => {
      await upsertPersonEmploymentAndPayrollInTx(
        tx,
        ctx,
        personId,
        employment as unknown as Record<string, unknown>,
        {
          updatedById: options?.updatedById,
          updatedAt: options?.updatedAt,
          ...(options?.isMergedOrTombstoned !== undefined
            ? { isMergedOrTombstoned: options.isMergedOrTombstoned }
            : options?.personMergedIntoId !== undefined
              ? { isMergedOrTombstoned: Boolean(options.personMergedIntoId) }
              : {}),
        },
      );
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      const readRes = await tx.query<EmploymentRow>(
        `SELECT eer.*, esr.payroll_json
         FROM public.employee_employment_records eer
         LEFT JOIN public.employee_sensitive_records esr
           ON esr.tenant_id = eer.tenant_id AND esr.person_id = eer.person_id
         WHERE eer.tenant_id = $1 AND eer.person_id = $2`,
        [ctx.tenantId, personId],
      );
      const saved = readRes.rows[0];
      if (!saved) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Employment record could not be persisted.',
        );
      }
      this.assertRowTenant(
        ctx,
        saved.tenant_id,
        'employee_employment_records',
      );
      return mapEmploymentRow<TEmp>(saved);
    });
  }

  public async putEmploymentRecords<
    TEmp extends TenantEmploymentRecord = TenantEmploymentRecord,
  >(
    ctx: TenantContext,
    records: ReadonlyArray<{ personId: string; employment: TEmp }>,
    options?: { auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<void> {
    if (records.length === 0 && !options?.auditEntries?.length) return;
    await this.withTenantTransaction(ctx, async (tx) => {
      for (const item of records) {
        await upsertPersonEmploymentAndPayrollInTx(
          tx,
          ctx,
          item.personId,
          item.employment as unknown as Record<string, unknown>,
        );
      }
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
    });
  }

  public async getEmploymentRecordByPersonId<
    TEmp = TenantEmploymentRecord,
  >(
    ctx: TenantContext,
    personId: string,
    options?: { auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<TEmp | null> {
    const runQuery = async (tx: TenantSqlClient): Promise<TEmp | null> => {
      const res = await tx.query<EmploymentRow>(
        `SELECT eer.*, esr.payroll_json
         FROM public.employee_employment_records eer
         LEFT JOIN public.employee_sensitive_records esr
           ON esr.tenant_id = eer.tenant_id AND esr.person_id = eer.person_id
         WHERE eer.tenant_id = $1 AND eer.person_id = $2`,
        [ctx.tenantId, personId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(
        ctx,
        row.tenant_id,
        'employee_employment_records',
      );
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return mapEmploymentRow(row) as unknown as TEmp;
    };

    if (options?.auditEntries?.length) {
      return this.withTenantTransaction(ctx, runQuery);
    }
    return this.withTenantReadTransaction(ctx, runQuery);
  }

  public async getEmploymentRecord<
    TEmp = TenantEmploymentRecord,
  >(
    ctx: TenantContext,
    personId: string,
    options?: { auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<TEmp | null> {
    return this.getEmploymentRecordByPersonId<TEmp>(ctx, personId, options);
  }

  public async listAllEmploymentRecords<
    TEmp extends TenantEmploymentRecord = TenantEmploymentRecord,
  >(ctx: TenantContext): Promise<TEmp[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<EmploymentRow>(
        `SELECT eer.*, esr.payroll_json
         FROM public.employee_employment_records eer
         LEFT JOIN public.employee_sensitive_records esr
           ON esr.tenant_id = eer.tenant_id AND esr.person_id = eer.person_id
         WHERE eer.tenant_id = $1
         ORDER BY eer.person_id ASC`,
        [ctx.tenantId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(
          ctx,
          row.tenant_id,
          'employee_employment_records',
        );
        return mapEmploymentRow<TEmp>(row);
      });
    });
  }

  public async deleteEmploymentRecordByPersonId(
    ctx: TenantContext,
    personId: string,
    options?: { auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      await syncPersonFirmWorkEmailInTx(tx, ctx, personId, null);
      const del = await tx.query(
        'DELETE FROM public.employee_employment_records WHERE tenant_id = $1 AND person_id = $2',
        [ctx.tenantId, personId],
      );
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return del.rowCount > 0;
    });
  }

  // ============================================================================
  // Sensitive HR & Payroll Records (`employee_sensitive_records`)
  // ============================================================================

  private async upsertSensitiveRecordInTx<
    TSens extends TenantEmployeeSensitiveRecord = TenantEmployeeSensitiveRecord,
  >(
    tx: TenantSqlClient,
    ctx: TenantContext,
    record: TSens,
    payroll?: Record<string, unknown> | null,
  ): Promise<TSens> {
    if (!record.personId?.trim()) {
      const err = new Error(
        'HR_SENSITIVE_VALIDATION_ERROR: personId is required for employee_sensitive_records.',
      ) as Error & { code: string };
      err.code = 'HR_SENSITIVE_VALIDATION_ERROR';
      throw err;
    }

    const updatedAtIso = safeTimestampIso(record.updatedAt);
    const updatedById = record.updatedById ?? 'system';

    const res =
      payroll !== undefined
        ? await tx.query<SensitiveRow>(
            `INSERT INTO public.employee_sensitive_records (
               tenant_id, person_id, updated_at, updated_by_id, payroll_json, sensitive_hr_json
             ) VALUES ($1, $2, $3::timestamptz, $4, $5::jsonb, $6::jsonb)
             ON CONFLICT (tenant_id, person_id) DO UPDATE SET
               updated_at = EXCLUDED.updated_at,
               updated_by_id = EXCLUDED.updated_by_id,
               payroll_json = EXCLUDED.payroll_json,
               sensitive_hr_json = EXCLUDED.sensitive_hr_json
             RETURNING *`,
            [
              ctx.tenantId,
              record.personId,
              updatedAtIso,
              updatedById,
              payroll ? JSON.stringify(payroll) : null,
              JSON.stringify(record),
            ],
          )
        : await tx.query<SensitiveRow>(
            `INSERT INTO public.employee_sensitive_records (
               tenant_id, person_id, updated_at, updated_by_id, payroll_json, sensitive_hr_json
             ) VALUES ($1, $2, $3::timestamptz, $4, NULL, $5::jsonb)
             ON CONFLICT (tenant_id, person_id) DO UPDATE SET
               updated_at = EXCLUDED.updated_at,
               updated_by_id = EXCLUDED.updated_by_id,
               sensitive_hr_json = EXCLUDED.sensitive_hr_json
             RETURNING *`,
            [
              ctx.tenantId,
              record.personId,
              updatedAtIso,
              updatedById,
              JSON.stringify(record),
            ],
          );

    const saved = res.rows[0];
    if (!saved) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Sensitive HR record could not be persisted.',
      );
    }
    this.assertRowTenant(ctx, saved.tenant_id, 'employee_sensitive_records');
    return mapSensitiveRow<TSens>(saved)!;
  }

  public async putSensitiveRecord<
    TSens extends TenantEmployeeSensitiveRecord = TenantEmployeeSensitiveRecord,
  >(
    ctx: TenantContext,
    record: TSens,
    options?: {
      payroll?: Record<string, unknown> | null;
      auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<TSens> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const saved = await this.upsertSensitiveRecordInTx<TSens>(
        tx,
        ctx,
        record,
        options?.payroll,
      );
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return saved;
    });
  }

  public async putEmployeeSensitiveRecord(
    ctx: TenantContext,
    input: {
      personId: string;
      payroll?: Record<string, unknown> | null;
      sensitiveHr?: TenantEmployeeSensitiveRecord | Record<string, unknown> | null;
      updatedById?: string | null;
      updatedAt?: string | null;
      auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      if (input.sensitiveHr) {
        const rec: TenantEmployeeSensitiveRecord = {
          ...(input.sensitiveHr as Record<string, unknown>),
          personId: input.personId,
          reasonableAdjustmentsNeeded:
            ((input.sensitiveHr as { reasonableAdjustmentsNeeded?: string })
              .reasonableAdjustmentsNeeded ?? ''),
          diversity:
            ((input.sensitiveHr as { diversity?: unknown }).diversity ?? {}),
          updatedById:
            input.updatedById ??
            ((input.sensitiveHr as { updatedById?: string }).updatedById ??
              'system'),
          updatedAt:
            input.updatedAt ??
            ((input.sensitiveHr as { updatedAt?: string }).updatedAt ??
              new Date().toISOString()),
        };
        await this.upsertSensitiveRecordInTx(
          tx,
          ctx,
          rec,
          input.payroll,
        );
      } else if (input.payroll !== undefined) {
        const updatedAtIso = safeTimestampIso(input.updatedAt);
        const updatedBy = input.updatedById ?? 'system';
        await tx.query(
          `INSERT INTO public.employee_sensitive_records (
             tenant_id, person_id, updated_at, updated_by_id, payroll_json, sensitive_hr_json
           ) VALUES ($1, $2, $3::timestamptz, $4, $5::jsonb, NULL)
           ON CONFLICT (tenant_id, person_id) DO UPDATE SET
             updated_at = EXCLUDED.updated_at,
             updated_by_id = EXCLUDED.updated_by_id,
             payroll_json = EXCLUDED.payroll_json`,
          [
            ctx.tenantId,
            input.personId,
            updatedAtIso,
            updatedBy,
            input.payroll ? JSON.stringify(input.payroll) : null,
          ],
        );
      }
      if (input.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, input.auditEntries);
      }
    });
  }

  public async putSensitiveRecords<
    TSens extends TenantEmployeeSensitiveRecord = TenantEmployeeSensitiveRecord,
  >(
    ctx: TenantContext,
    records: readonly TSens[],
    options?: { auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<TSens[]> {
    if (records.length === 0 && !options?.auditEntries?.length) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: TSens[] = [];
      for (const rec of records) {
        out.push(await this.upsertSensitiveRecordInTx<TSens>(tx, ctx, rec));
      }
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return out;
    });
  }

  public async putPayrollRecord(
    ctx: TenantContext,
    personId: string,
    payroll: Record<string, unknown> | null,
    options?: {
      updatedById?: string | null;
      updatedAt?: string | null;
      auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      const updatedAtIso = safeTimestampIso(options?.updatedAt);
      const updatedBy = options?.updatedById ?? 'system';
      await tx.query(
        `INSERT INTO public.employee_sensitive_records (
           tenant_id, person_id, updated_at, updated_by_id, payroll_json, sensitive_hr_json
         ) VALUES ($1, $2, $3::timestamptz, $4, $5::jsonb, NULL)
         ON CONFLICT (tenant_id, person_id) DO UPDATE SET
           updated_at = EXCLUDED.updated_at,
           updated_by_id = EXCLUDED.updated_by_id,
           payroll_json = EXCLUDED.payroll_json`,
        [
          ctx.tenantId,
          personId,
          updatedAtIso,
          updatedBy,
          payroll ? JSON.stringify(payroll) : null,
        ],
      );
      // Also mirror into employee_employment_records.employment_json if row exists
      const empRes = await tx.query<{
        tenant_id: string;
        employment_json: Record<string, unknown> | null;
      }>(
        'SELECT tenant_id, employment_json FROM public.employee_employment_records WHERE tenant_id = $1 AND person_id = $2 FOR UPDATE',
        [ctx.tenantId, personId],
      );
      const empRow = empRes.rows[0];
      if (empRow && empRow.employment_json) {
        this.assertRowTenant(
          ctx,
          empRow.tenant_id,
          'employee_employment_records',
        );
        const nextEmp = {
          ...empRow.employment_json,
          payroll: payroll ? structuredClone(payroll) : null,
        };
        await tx.query(
          `UPDATE public.employee_employment_records
           SET employment_json = $3::jsonb, updated_at = $4::timestamptz
           WHERE tenant_id = $1 AND person_id = $2`,
          [ctx.tenantId, personId, JSON.stringify(nextEmp), updatedAtIso],
        );
      }
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
    });
  }

  public async getSensitiveRecordByPersonId<
    TSens = TenantEmployeeSensitiveRecord,
  >(
    ctx: TenantContext,
    personId: string,
    options?: { auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<TSens | null> {
    const runQuery = async (tx: TenantSqlClient): Promise<TSens | null> => {
      const res = await tx.query<SensitiveRow>(
        'SELECT * FROM public.employee_sensitive_records WHERE tenant_id = $1 AND person_id = $2',
        [ctx.tenantId, personId],
      );
      const row = res.rows[0];
      if (row) {
        this.assertRowTenant(ctx, row.tenant_id, 'employee_sensitive_records');
      }
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return row ? (mapSensitiveRow(row) as unknown as TSens | null) : null;
    };

    if (options?.auditEntries?.length) {
      return this.withTenantTransaction(ctx, runQuery);
    }
    return this.withTenantReadTransaction(ctx, runQuery);
  }

  public async getSensitiveRecord<
    TSens = TenantEmployeeSensitiveRecord,
  >(
    ctx: TenantContext,
    personId: string,
    options?: { auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<TSens | null> {
    return this.getSensitiveRecordByPersonId<TSens>(ctx, personId, options);
  }

  public async getPayrollRecordByPersonId<
    TPayroll extends Record<string, unknown> = Record<string, unknown>,
  >(
    ctx: TenantContext,
    personId: string,
    options?: { auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<TPayroll | null> {
    const runQuery = async (tx: TenantSqlClient): Promise<TPayroll | null> => {
      const res = await tx.query<SensitiveRow>(
        'SELECT * FROM public.employee_sensitive_records WHERE tenant_id = $1 AND person_id = $2',
        [ctx.tenantId, personId],
      );
      const row = res.rows[0];
      if (row) {
        this.assertRowTenant(ctx, row.tenant_id, 'employee_sensitive_records');
      }
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return row?.payroll_json
        ? (structuredClone(row.payroll_json) as TPayroll)
        : null;
    };

    if (options?.auditEntries?.length) {
      return this.withTenantTransaction(ctx, runQuery);
    }
    return this.withTenantReadTransaction(ctx, runQuery);
  }

  public async listAllSensitiveRecordsMap<
    TSens extends TenantEmployeeSensitiveRecord = TenantEmployeeSensitiveRecord,
  >(ctx: TenantContext): Promise<Record<string, TSens>> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<SensitiveRow>(
        `SELECT *
         FROM public.employee_sensitive_records
         WHERE tenant_id = $1 AND sensitive_hr_json IS NOT NULL
         ORDER BY person_id ASC`,
        [ctx.tenantId],
      );
      const out: Record<string, TSens> = {};
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'employee_sensitive_records');
        const mapped = mapSensitiveRow<TSens>(row);
        if (mapped) {
          out[row.person_id] = mapped;
        }
      }
      return out;
    });
  }

  public async listAllEmployeeSensitiveHrRecords<
    TSens extends TenantEmployeeSensitiveRecord = TenantEmployeeSensitiveRecord,
  >(ctx: TenantContext): Promise<Record<string, TSens>> {
    return this.listAllSensitiveRecordsMap<TSens>(ctx);
  }

  public async deleteSensitiveRecordByPersonId(
    ctx: TenantContext,
    personId: string,
    options?: {
      deletePayrollToo?: boolean;
      auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      let affected = false;
      if (options?.deletePayrollToo) {
        const del = await tx.query(
          'DELETE FROM public.employee_sensitive_records WHERE tenant_id = $1 AND person_id = $2',
          [ctx.tenantId, personId],
        );
        affected = del.rowCount > 0;
      } else {
        const upd = await tx.query<{
          tenant_id: string;
          payroll_json: Record<string, unknown> | null;
        }>(
          `UPDATE public.employee_sensitive_records
           SET sensitive_hr_json = NULL, updated_at = NOW()
           WHERE tenant_id = $1 AND person_id = $2
           RETURNING tenant_id, payroll_json`,
          [ctx.tenantId, personId],
        );
        const row = upd.rows[0];
        if (row) {
          this.assertRowTenant(
            ctx,
            row.tenant_id,
            'employee_sensitive_records',
          );
          affected = true;
          if (!row.payroll_json) {
            await tx.query(
              'DELETE FROM public.employee_sensitive_records WHERE tenant_id = $1 AND person_id = $2 AND payroll_json IS NULL AND sensitive_hr_json IS NULL',
              [ctx.tenantId, personId],
            );
          }
        }
      }
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return affected;
    });
  }

  public async deleteEmployeeSensitiveRecord(
    ctx: TenantContext,
    personId: string,
    options?: {
      deletePayrollToo?: boolean;
      auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<boolean> {
    return this.deleteSensitiveRecordByPersonId(ctx, personId, options);
  }

  // ============================================================================
  // Employee Migration Report (`employee_migration_reports`)
  // ============================================================================

  public async getEmployeeMigrationReport<
    TReport extends TenantEmployeeMigrationReportRecord = TenantEmployeeMigrationReportRecord,
  >(ctx: TenantContext): Promise<TReport | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<EmployeeMigrationReportRow>(
        'SELECT * FROM public.employee_migration_reports WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row || !row.report_json) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'employee_migration_reports');
      return structuredClone(row.report_json) as TReport;
    });
  }

  public async getMigrationReport<
    TReport extends TenantEmployeeMigrationReportRecord = TenantEmployeeMigrationReportRecord,
  >(ctx: TenantContext): Promise<TReport | null> {
    return this.getEmployeeMigrationReport<TReport>(ctx);
  }

  public async putEmployeeMigrationReport<
    TReport extends TenantEmployeeMigrationReportRecord = TenantEmployeeMigrationReportRecord,
  >(
    ctx: TenantContext,
    report: TReport | null | undefined,
  ): Promise<TReport | null> {
    return this.withTenantTransaction(ctx, async (tx) => {
      if (!report) {
        await tx.query(
          'DELETE FROM public.employee_migration_reports WHERE tenant_id = $1',
          [ctx.tenantId],
        );
        return null;
      }
      const res = await tx.query<EmployeeMigrationReportRow>(
        `INSERT INTO public.employee_migration_reports (tenant_id, updated_at, report_json)
         VALUES ($1, NOW(), $2::jsonb)
         ON CONFLICT (tenant_id) DO UPDATE SET
           updated_at = NOW(),
           report_json = EXCLUDED.report_json
         RETURNING *`,
        [ctx.tenantId, JSON.stringify(report)],
      );
      const row = res.rows[0];
      if (row) {
        this.assertRowTenant(ctx, row.tenant_id, 'employee_migration_reports');
      }
      return row?.report_json
        ? (structuredClone(row.report_json) as TReport)
        : null;
    });
  }

  public async putMigrationReport<
    TReport extends TenantEmployeeMigrationReportRecord = TenantEmployeeMigrationReportRecord,
  >(
    ctx: TenantContext,
    report: TReport | null | undefined,
  ): Promise<TReport | null> {
    return this.putEmployeeMigrationReport<TReport>(ctx, report);
  }

  public async deleteEmployeeMigrationReport(
    ctx: TenantContext,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const del = await tx.query(
        'DELETE FROM public.employee_migration_reports WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      return del.rowCount > 0;
    });
  }

  // ============================================================================
  // Tenant RBAC Configuration Overrides (`tenant_rbac_configs`, `R477`, `S3`)
  // ============================================================================

  private extractRbacOverrideAndRowVersion<
    TOverride extends Partial<RbacConfiguration> = Partial<RbacConfiguration>,
  >(
    raw: Record<string, unknown> | Partial<RbacConfiguration> | null | undefined,
  ): { override: TOverride | null; rowVersion: number } {
    if (!raw || typeof raw !== 'object') {
      return { override: null, rowVersion: 0 };
    }
    const cloned = structuredClone(raw) as Record<string, unknown>;
    const rawVer = cloned['_rowVersion'] ?? cloned['row_version'];
    const rowVersion =
      typeof rawVer === 'number' && Number.isFinite(rawVer) && rawVer >= 1
        ? Math.floor(rawVer)
        : 1;
    delete cloned['_rowVersion'];
    delete cloned['row_version'];
    return {
      override: cloned as TOverride,
      rowVersion,
    };
  }

  public async getRbacConfigOverrideWithVersion<
    TOverride extends Partial<RbacConfiguration> = Partial<RbacConfiguration>,
  >(
    ctx: TenantContext,
  ): Promise<{ override: TOverride | null; rowVersion: number }> {
    const activeTx = getActiveTenantTransactionState();
    const inWriteTx = activeTx?.tenantId === ctx.tenantId;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<TenantRbacConfigRow>(
        inWriteTx
          ? 'SELECT * FROM public.tenant_rbac_configs WHERE tenant_id = $1 FOR UPDATE'
          : 'SELECT * FROM public.tenant_rbac_configs WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row || !row.rbac_override_json) {
        return { override: null, rowVersion: 0 };
      }
      this.assertRowTenant(ctx, row.tenant_id, 'tenant_rbac_configs');
      return this.extractRbacOverrideAndRowVersion<TOverride>(
        row.rbac_override_json,
      );
    });
  }

  public async getRbacConfigOverride<
    TOverride extends Partial<RbacConfiguration> = Partial<RbacConfiguration>,
  >(ctx: TenantContext): Promise<TOverride | null> {
    const { override } = await this.getRbacConfigOverrideWithVersion<TOverride>(
      ctx,
    );
    return override;
  }

  public async putRbacConfigOverride<
    TOverride extends Partial<RbacConfiguration> = Partial<RbacConfiguration>,
  >(
    ctx: TenantContext,
    override: TOverride | null | undefined,
    updatedByIdOrOptions?:
      | string
      | {
          updatedById?: string | null;
          updatedAt?: string | null;
          expectedRowVersion?: number | null;
          auditEntries?: readonly FirmAuditEntryInput[];
        },
  ): Promise<TOverride | null> {
    const options =
      typeof updatedByIdOrOptions === 'string'
        ? { updatedById: updatedByIdOrOptions }
        : updatedByIdOrOptions;
    return this.withTenantTransaction(ctx, async (tx) => {
      const existingRes = await tx.query<TenantRbacConfigRow>(
        'SELECT * FROM public.tenant_rbac_configs WHERE tenant_id = $1 FOR UPDATE',
        [ctx.tenantId],
      );
      const existingRow = existingRes.rows[0];
      if (existingRow) {
        this.assertRowTenant(ctx, existingRow.tenant_id, 'tenant_rbac_configs');
      }
      const currentRowVersion = existingRow?.rbac_override_json
        ? this.extractRbacOverrideAndRowVersion(existingRow.rbac_override_json)
            .rowVersion
        : 0;
      if (
        options?.expectedRowVersion !== undefined &&
        options.expectedRowVersion !== null &&
        options.expectedRowVersion !== currentRowVersion
      ) {
        const conflictErr = new Error(
          `RBAC_CONFIG_CONCURRENCY_CONFLICT: Tenant RBAC configuration was modified by another transaction (expected row_version ${options.expectedRowVersion}, actual ${currentRowVersion}).`,
        ) as Error & { code: string };
        conflictErr.code = 'RBAC_CONFIG_CONCURRENCY_CONFLICT';
        throw conflictErr;
      }

      if (!override) {
        await tx.query(
          'DELETE FROM public.tenant_rbac_configs WHERE tenant_id = $1',
          [ctx.tenantId],
        );
        if (options?.auditEntries?.length) {
          await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
        }
        return null;
      }
      const updatedAtIso = safeTimestampIso(options?.updatedAt);
      const updatedById = options?.updatedById ?? 'system';
      const nextRowVersion = currentRowVersion + 1;
      const payloadWithVersion = {
        ...(structuredClone(override) as Record<string, unknown>),
        _rowVersion: nextRowVersion,
      };
      const res = await tx.query<TenantRbacConfigRow>(
        `INSERT INTO public.tenant_rbac_configs (
           tenant_id, updated_at, updated_by_id, rbac_override_json
         ) VALUES ($1, $2::timestamptz, $3, $4::jsonb)
         ON CONFLICT (tenant_id) DO UPDATE SET
           updated_at = EXCLUDED.updated_at,
           updated_by_id = EXCLUDED.updated_by_id,
           rbac_override_json = EXCLUDED.rbac_override_json
         RETURNING *`,
        [
          ctx.tenantId,
          updatedAtIso,
          updatedById,
          JSON.stringify(payloadWithVersion),
        ],
      );
      const row = res.rows[0];
      if (row) {
        this.assertRowTenant(ctx, row.tenant_id, 'tenant_rbac_configs');
      }
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return this.extractRbacOverrideAndRowVersion<TOverride>(
        row?.rbac_override_json,
      ).override;
    });
  }

  public async deleteRbacConfigOverride(
    ctx: TenantContext,
    options?: { auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const del = await tx.query(
        'DELETE FROM public.tenant_rbac_configs WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return del.rowCount > 0;
    });
  }

  // ============================================================================
  // Cut-over Import Support (`R421`) & Counts / Clear
  // ============================================================================

  /**
   * Reads post-`S0-16` live employment records from `public.people.employment_json` (if the
   * column exists) and `public.employee_employment_records` solely for `--modules hr` cut-over
   * import (`R421`). Uses a savepoint so if `people.employment_json` has been dropped (`S0-20`
   * or `R417` verification test), it falls back cleanly to `employee_employment_records`.
   */
  public async readAuthoritativePeopleEmploymentForImport(
    ctx: TenantContext,
  ): Promise<AuthoritativePersonEmploymentImportRow[]> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: AuthoritativePersonEmploymentImportRow[] = [];
      await tx.query('SAVEPOINT sp_read_legacy_emp_json');
      try {
        const res = await tx.query<{
          tenant_id: string;
          id: string;
          merged_into_id: string | null;
          legacy_emp_json: Record<string, unknown> | null;
          current_emp_json: Record<string, unknown> | null;
          current_payroll_json: Record<string, unknown> | null;
        }>(
          `SELECT
             p.tenant_id,
             p.id,
             p.merged_into_id,
             p.employment_json AS legacy_emp_json,
             eer.employment_json AS current_emp_json,
             esr.payroll_json AS current_payroll_json
           FROM public.people p
           LEFT JOIN public.employee_employment_records eer
             ON eer.tenant_id = p.tenant_id AND eer.person_id = p.id
           LEFT JOIN public.employee_sensitive_records esr
             ON esr.tenant_id = p.tenant_id AND esr.person_id = p.id
           WHERE p.tenant_id = $1
           ORDER BY p.id ASC`,
          [ctx.tenantId],
        );
        await tx.query('RELEASE SAVEPOINT sp_read_legacy_emp_json');
        for (const row of res.rows) {
          this.assertRowTenant(ctx, row.tenant_id, 'people.hr_import');
          const leg = row.legacy_emp_json;
          const cur: Record<string, unknown> | null = row.current_emp_json
            ? {
                ...row.current_emp_json,
                ...(row.current_payroll_json
                  ? { payroll: row.current_payroll_json }
                  : {}),
              }
            : null;
          let chosen: Record<string, unknown> | null = null;
          if (leg && cur) {
            const legTs = Date.parse(String(leg['updatedAt'] ?? '')) || 0;
            const curTs = Date.parse(String(cur['updatedAt'] ?? '')) || 0;
            chosen = structuredClone(legTs >= curTs ? leg : cur);
          } else if (leg) {
            chosen = structuredClone(leg);
          } else if (cur) {
            chosen = structuredClone(cur);
          }
          out.push({
            personId: row.id,
            employment: chosen as TenantEmploymentRecord | null,
            mergedIntoId: row.merged_into_id ?? null,
          });
        }
        return out;
      } catch {
        await tx.query('ROLLBACK TO SAVEPOINT sp_read_legacy_emp_json');
        await tx.query('RELEASE SAVEPOINT sp_read_legacy_emp_json');
        const res = await tx.query<{
          tenant_id: string;
          id: string;
          merged_into_id: string | null;
          employment_json: Record<string, unknown> | null;
          payroll_json: Record<string, unknown> | null;
        }>(
          `SELECT
             p.tenant_id,
             p.id,
             p.merged_into_id,
             eer.employment_json,
             esr.payroll_json
           FROM public.people p
           LEFT JOIN public.employee_employment_records eer
             ON eer.tenant_id = p.tenant_id AND eer.person_id = p.id
           LEFT JOIN public.employee_sensitive_records esr
             ON esr.tenant_id = p.tenant_id AND esr.person_id = p.id
           WHERE p.tenant_id = $1
           ORDER BY p.id ASC`,
          [ctx.tenantId],
        );
        for (const row of res.rows) {
          this.assertRowTenant(
            ctx,
            row.tenant_id,
            'employee_employment_records.hr_import',
          );
          const emp = row.employment_json
            ? ({
                ...structuredClone(row.employment_json),
                ...(row.payroll_json
                  ? { payroll: structuredClone(row.payroll_json) }
                  : {}),
              } as TenantEmploymentRecord)
            : null;
          out.push({
            personId: row.id,
            employment: emp,
            mergedIntoId: row.merged_into_id ?? null,
          });
        }
        return out;
      }
    });
  }

  public async countAllTenantHrAndRbacRows(ctx: TenantContext): Promise<{
    teams: number;
    employmentRecords: number;
    sensitiveRecords: number;
    payrollRecords: number;
    hasMigrationReport: boolean;
    hasEmployeeMigrationReport: boolean;
    hasRbacConfigOverride: boolean;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        tm_cnt: number;
        emp_cnt: number;
        sens_cnt: number;
        pay_cnt: number;
        mig_cnt: number;
        rbac_cnt: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM public.teams WHERE tenant_id = $1) AS tm_cnt,
           (SELECT COUNT(*)::int FROM public.employee_employment_records WHERE tenant_id = $1) AS emp_cnt,
           (SELECT COUNT(*)::int FROM public.employee_sensitive_records WHERE tenant_id = $1) AS sens_cnt,
           (SELECT COUNT(*)::int FROM public.employee_sensitive_records WHERE tenant_id = $1 AND payroll_json IS NOT NULL) AS pay_cnt,
           (SELECT COUNT(*)::int FROM public.employee_migration_reports WHERE tenant_id = $1 AND report_json IS NOT NULL) AS mig_cnt,
           (SELECT COUNT(*)::int FROM public.tenant_rbac_configs WHERE tenant_id = $1 AND rbac_override_json IS NOT NULL) AS rbac_cnt`,
        [ctx.tenantId],
      );
      const row = res.rows[0];
      const hasMig = Number(row?.mig_cnt ?? 0) > 0;
      return {
        teams: Number(row?.tm_cnt ?? 0),
        employmentRecords: Number(row?.emp_cnt ?? 0),
        sensitiveRecords: Number(row?.sens_cnt ?? 0),
        payrollRecords: Number(row?.pay_cnt ?? 0),
        hasMigrationReport: hasMig,
        hasEmployeeMigrationReport: hasMig,
        hasRbacConfigOverride: Number(row?.rbac_cnt ?? 0) > 0,
      };
    });
  }

  public async countAllTenantHrRbacRows(ctx: TenantContext): Promise<{
    teams: number;
    employmentRecords: number;
    sensitiveRecords: number;
    payrollRecords: number;
    hasMigrationReport: boolean;
    hasEmployeeMigrationReport: boolean;
    hasRbacConfigOverride: boolean;
  }> {
    return this.countAllTenantHrAndRbacRows(ctx);
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        'DELETE FROM public.tenant_rbac_configs WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM public.employee_migration_reports WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM public.employee_sensitive_records WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM public.employee_employment_records WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        "DELETE FROM public.person_emails WHERE tenant_id = $1 AND source = 'firm_work_email'",
        [ctx.tenantId],
      );
      await tx.query('DELETE FROM public.teams WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query(
        `DELETE FROM public.tenant_record_sequences
         WHERE tenant_id = $1 AND counter_key = 'TM'`,
        [ctx.tenantId],
      );
    });
  }
}
