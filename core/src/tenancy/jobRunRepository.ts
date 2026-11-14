/**
 * Tenant-Scoped Scheduler Job Run Repository (`core/src/tenancy/jobRunRepository.ts`).
 *
 * Implements ADR 0030 §§4–5 & Slice `S0-19` (`0014_scheduler_job_runs_expand`):
 * 1. Zero process-level copies of tenant data or job state (`Map`, `Set`, `global`).
 *    Job state lives exclusively in `public.job_runs` in each tenant's PostgreSQL database.
 * 2. One transaction per job per tenant (`withTenantTransaction` starting with `SET LOCAL ROLE`):
 *    - Step 1: `pg_try_advisory_xact_lock(hashtext('onesquared_job:' || jobKey || ':' || tenantId))`
 *      returns `already_running` immediately if another replica or manual action holds the lock.
 *    - Step 2: For scheduled ticks, checks local hour >= `02:00` in `tenantConfig.timeZone`
 *      (default `'Europe/London'`, handling GMT/BST via `Intl.DateTimeFormat`) and checks on the
 *      same transaction client whether any `status = 'succeeded'` row (scheduled or manual)
 *      already exists for `(tenant_id, job_key, local_date)`.
 *    - Step 3: Executes all domain reads, reminder/task/notification/usage-purge writes, and
 *      `audit_entries` writes inside that same transaction (nested repositories join via
 *      `TenantScopedRepository`'s `AsyncLocalStorage`).
 *    - Step 4: Inserts the `status = 'succeeded'` row into `public.job_runs` before `COMMIT`
 *      releases the transaction-scoped advisory lock atomically.
 * 3. If Step 3 throws, the transaction rolls back all domain and `audit_entries` writes, and a
 *    short autonomous transaction writes a `status = 'failed'` row in `public.job_runs` so
 *    failure history is recorded without blocking retry on the next hourly tick.
 */

import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../api/index';
import {
  TenantScopedRepository,
  toIsoString,
  toNullableIsoString,
  type TenantSqlClient,
} from './tenantScopedRepository';

export type JobTriggerSource = 'scheduled' | 'manual';
export type JobRunStatus = 'running' | 'succeeded' | 'failed';

export interface JobRunRecord {
  readonly tenantId: string;
  readonly id: string;
  readonly jobKey: string;
  readonly localDate: string;
  readonly triggerSource: JobTriggerSource;
  readonly triggeredById: string;
  readonly status: JobRunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly correlationId: string;
  readonly errorCode: string | null;
  readonly summary: Readonly<Record<string, number>>;
}

export type ControlledJobRunOutcome<TResult> =
  | {
      readonly outcome: 'executed';
      readonly localDate: string;
      readonly localHour: number;
      readonly jobRun: JobRunRecord;
      readonly result: TResult;
    }
  | {
      readonly outcome: 'before_window';
      readonly localDate: string;
      readonly localHour: number;
    }
  | {
      readonly outcome: 'already_running';
      readonly localDate: string;
      readonly localHour: number;
    }
  | {
      readonly outcome: 'already_succeeded_today';
      readonly localDate: string;
      readonly localHour: number;
      readonly existingRun?: JobRunRecord;
    };

interface DbJobRunRow {
  tenant_id: string;
  id: string;
  job_key: string;
  local_date: string;
  trigger_source: JobTriggerSource;
  triggered_by_id: string;
  status: JobRunStatus;
  started_at: Date | string;
  finished_at: Date | string | null;
  correlation_id: string;
  error_code: string | null;
  summary_json: Record<string, unknown> | null;
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== 'string' || !timeZone.trim()) {
    return false;
  }
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timeZone.trim() });
    return true;
  } catch {
    return false;
  }
}

export function resolveTenantLocalDateAndHour(
  now: Date = new Date(),
  timeZone = 'Europe/London',
): {
  readonly localDate: string;
  readonly localHour: number;
  readonly timeZone: string;
} {
  const effectiveTimeZone = isValidIanaTimeZone(timeZone)
    ? timeZone.trim()
    : 'Europe/London';
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: effectiveTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  const rawHour = Number.parseInt(
    parts.find((p) => p.type === 'hour')?.value ?? '0',
    10,
  );
  const localHour = Number.isFinite(rawHour) ? rawHour % 24 : 0;
  return {
    localDate: `${year}-${month}-${day}`,
    localHour,
    timeZone: effectiveTimeZone,
  };
}

export function sanitizeJobSummaryCounts(
  raw: Record<string, unknown> | null | undefined,
): Record<string, number> {
  const clean: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') {
    return clean;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (
      /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k) &&
      typeof v === 'number' &&
      Number.isFinite(v)
    ) {
      clean[k] = v;
    }
  }
  return clean;
}

export function sanitizeJobErrorCode(err: unknown): string {
  const rawCode = (err as { code?: unknown })?.code;
  if (
    typeof rawCode === 'string' &&
    /^[A-Z0-9_:-]{2,64}$/i.test(rawCode.trim())
  ) {
    return rawCode.trim().toUpperCase();
  }
  if (err instanceof Error && typeof err.message === 'string') {
    const prefixMatch = /^([A-Z][A-Z0-9_]{2,63}):/.exec(err.message.trim());
    if (prefixMatch?.[1]) {
      return prefixMatch[1];
    }
  }
  return 'JOB_EXECUTION_FAILED';
}

function mapJobRunRow(row: DbJobRunRow): JobRunRecord {
  return Object.freeze({
    tenantId: row.tenant_id,
    id: row.id,
    jobKey: row.job_key,
    localDate: row.local_date,
    triggerSource: row.trigger_source,
    triggeredById: row.triggered_by_id,
    status: row.status,
    startedAt: toIsoString(row.started_at),
    finishedAt: toNullableIsoString(row.finished_at),
    correlationId: row.correlation_id,
    errorCode: row.error_code ?? null,
    summary: Object.freeze(sanitizeJobSummaryCounts(row.summary_json)),
  });
}

export class TenantJobRunRepository extends TenantScopedRepository {
  public buildAdvisoryLockKey(jobKey: string, tenantId: string): string {
    return `onesquared_job:${jobKey}:${tenantId}`;
  }

  public async executeControlledTenantJobRun<TResult>(
    ctx: TenantContext,
    params: {
      readonly jobKey: string;
      readonly triggerSource: JobTriggerSource;
      readonly triggeredById: string;
      readonly timeZone?: string;
      readonly now?: Date;
      readonly localDateOverride?: string;
      readonly targetLocalHour?: number;
      readonly statementTimeoutMs?: number;
      readonly work: (info: {
        readonly tx: TenantSqlClient;
        readonly localDate: string;
        readonly localHour: number;
        readonly nowIso: string;
      }) => Promise<{
        readonly result: TResult;
        readonly summary: Record<string, number>;
      }>;
    },
  ): Promise<ControlledJobRunOutcome<TResult>> {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();
    const clock = resolveTenantLocalDateAndHour(
      now,
      params.timeZone ?? 'Europe/London',
    );
    const localDate = params.localDateOverride?.trim() || clock.localDate;
    const localHour = clock.localHour;
    const targetLocalHour = params.targetLocalHour ?? 2;

    if (params.triggerSource === 'scheduled' && localHour < targetLocalHour) {
      return {
        outcome: 'before_window',
        localDate,
        localHour,
      };
    }

    const lockKey = this.buildAdvisoryLockKey(params.jobKey, ctx.tenantId);
    const runId = `JR-${randomUUID()}`;
    const startedAtIso = nowIso;

    try {
      return await this.withTenantTransaction(
        ctx,
        async (tx) => {
          // 1. Acquire transaction-scoped advisory lock on this tenant DB connection
          const lockRes = await tx.query<{ acquired: boolean }>(
            'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
            [lockKey],
          );
          if (!lockRes.rows[0]?.acquired) {
            return {
              outcome: 'already_running' as const,
              localDate,
              localHour,
            };
          }

          // 2. For scheduled runs, check if any succeeded row (scheduled OR manual) already exists for (tenant_id, job_key, local_date)
          if (params.triggerSource === 'scheduled') {
            const existingRes = await tx.query<DbJobRunRow>(
              `SELECT *
                 FROM public.job_runs
                WHERE tenant_id = $1
                  AND job_key = $2
                  AND local_date = $3
                  AND status = 'succeeded'
                ORDER BY finished_at DESC NULLS LAST, started_at DESC
                LIMIT 1`,
              [ctx.tenantId, params.jobKey, localDate],
            );
            const existingRow = existingRes.rows[0];
            if (existingRow) {
              this.assertRowTenant(ctx, existingRow.tenant_id, 'JobRun');
              return {
                outcome: 'already_succeeded_today' as const,
                localDate,
                localHour,
                existingRun: mapJobRunRow(existingRow),
              };
            }
          }

          // 3. Execute all reads, domain work, and audit_entries writes on the same transaction client
          const { result, summary } = await params.work({
            tx,
            localDate,
            localHour,
            nowIso,
          });

          const cleanSummary = sanitizeJobSummaryCounts(summary);
          const finishedAtIso = new Date().toISOString();

          // 4. Insert the succeeded row in job_runs before COMMIT releases the advisory lock
          const insertRes = await tx.query<DbJobRunRow>(
            `INSERT INTO public.job_runs (
               tenant_id, id, job_key, local_date, trigger_source, triggered_by_id,
               status, started_at, finished_at, correlation_id, error_code, summary_json
             ) VALUES (
               $1, $2, $3, $4, $5, $6,
               'succeeded', $7::timestamptz, $8::timestamptz, $9, NULL, $10::jsonb
             )
             RETURNING *`,
            [
              ctx.tenantId,
              runId,
              params.jobKey,
              localDate,
              params.triggerSource,
              params.triggeredById,
              startedAtIso,
              finishedAtIso,
              ctx.correlationId,
              JSON.stringify(cleanSummary),
            ],
          );
          const inserted = insertRes.rows[0]!;
          this.assertRowTenant(ctx, inserted.tenant_id, 'JobRun');

          return {
            outcome: 'executed' as const,
            localDate,
            localHour,
            jobRun: mapJobRunRow(inserted),
            result,
          };
        },
        params.statementTimeoutMs !== undefined
          ? { statementTimeoutMs: params.statementTimeoutMs }
          : undefined,
      );
    } catch (err) {
      const sqlState = (err as { code?: unknown; sqlState?: unknown })?.sqlState ??
        (err as { code?: unknown })?.code;
      if (params.triggerSource === 'scheduled' && sqlState === '23505') {
        return {
          outcome: 'already_succeeded_today',
          localDate,
          localHour,
        };
      }

      // Record a status = 'failed' row in a short second autonomous transaction so failure history
      // is preserved without blocking retry on the next hourly tick.
      const errorCode = sanitizeJobErrorCode(err);
      const failedAtIso = new Date().toISOString();
      try {
        await this.withAutonomousTenantTransaction(ctx, async (failTx) => {
          await failTx.query(
            `INSERT INTO public.job_runs (
               tenant_id, id, job_key, local_date, trigger_source, triggered_by_id,
               status, started_at, finished_at, correlation_id, error_code, summary_json
             ) VALUES (
               $1, $2, $3, $4, $5, $6,
               'failed', $7::timestamptz, $8::timestamptz, $9, $10, '{}'::jsonb
             )`,
            [
              ctx.tenantId,
              runId,
              params.jobKey,
              localDate,
              params.triggerSource,
              params.triggeredById,
              startedAtIso,
              failedAtIso,
              ctx.correlationId,
              errorCode,
            ],
          );
        });
      } catch {
        // Best-effort failure record (e.g. if the database connection itself is unavailable)
      }

      throw err;
    }
  }

  public async listJobRuns(
    ctx: TenantContext,
    filter?: {
      readonly jobKey?: string;
      readonly localDate?: string;
      readonly status?: JobRunStatus;
    },
  ): Promise<JobRunRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses: string[] = ['tenant_id = $1'];
      const values: unknown[] = [ctx.tenantId];
      if (filter?.jobKey) {
        values.push(filter.jobKey);
        clauses.push(`job_key = $${values.length}`);
      }
      if (filter?.localDate) {
        values.push(filter.localDate);
        clauses.push(`local_date = $${values.length}`);
      }
      if (filter?.status) {
        values.push(filter.status);
        clauses.push(`status = $${values.length}`);
      }
      const res = await tx.query<DbJobRunRow>(
        `SELECT *
           FROM public.job_runs
          WHERE ${clauses.join(' AND ')}
          ORDER BY started_at ASC, id ASC`,
        values,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'JobRun');
        return mapJobRunRow(row);
      });
    });
  }

  public async getJobRunById(
    ctx: TenantContext,
    id: string,
  ): Promise<JobRunRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbJobRunRow>(
        'SELECT * FROM public.job_runs WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'JobRun');
      return mapJobRunRow(row);
    });
  }

  public async clearTenantJobRuns(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query('DELETE FROM public.job_runs WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
    });
  }
}
