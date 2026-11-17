/**
 * Tenant-Scoped Transactional Email Outbox & Notification Preferences Repository
 * (`core/src/tenancy/outboxRepository.ts`).
 *
 * Enforces ADR 0027 §§6–7, ADR 0035 §1, and Platform Architecture Standard §§4, 8:
 * 1. Every read and write runs inside an explicit PostgreSQL transaction after
 *    `SET LOCAL ROLE "<role_tenant_slug_env>"`, predicates on `tenant_id = $1`
 *    bound strictly from `ctx.tenantId`, and verifies every returned row via
 *    `this.assertRowTenant`.
 * 2. Outbox claims use short `FOR UPDATE SKIP LOCKED` transactions with a unique
 *    `claim_token` lease, reclaim stale `'sending'` leases past 5 minutes, and
 *    guard every completion/retry update against `(tenant_id, id, status = 'sending', claim_token)`.
 * 3. Content scrubbing clears `subject`, `html_body`, `text_body`, `attachments_json`,
 *    and recipient addresses (`recipients_json = '{"to":[]}'::jsonb`) and sets
 *    `content_scrubbed_at` once terminal rows exceed `outboxContentRetentionDays`.
 * 4. Notification preferences resolve per `(tenant_id, person_id, notification_kind)`
 *    with canonical ADR 0035 §1 defaults when no custom override row exists.
 */

import { randomUUID } from 'node:crypto';
import type {
  EmailAttachmentRef,
  EmailOutboxRecord,
  EmailOutboxStatus,
  EmailRecipientList,
  FirmAuditEntryInput,
  NotificationChannelFrequency,
  NotificationKind,
  TenantContext,
  UserNotificationPreference,
} from '../api/index';
import { TenantAuditRepository } from './auditRepository';
import { sanitizeJobErrorCode } from './jobRunRepository';
import type { TenantPostgresPoolManager } from './postgresPoolManager';
import {
  TenantScopedRepository,
  toIsoString,
} from './tenantScopedRepository';

export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
export const DEFAULT_OUTBOX_STALE_CLAIM_MINUTES = 5;
export const DEFAULT_OUTBOX_RETENTION_DAYS = 30;
export const DEFAULT_OUTBOX_BASE_BACKOFF_SECONDS = 60;
export const MAX_OUTBOX_BACKOFF_SECONDS = 3600;

export const ALL_NOTIFICATION_KINDS: readonly NotificationKind[] = Object.freeze([
  'task_assigned',
  'team_task_arrived',
  'task_comment',
  'enquiry_assigned',
  'task_due_soon',
  'task_overdue',
  'approval_requested',
  'approval_decided',
  'key_date_approaching',
  'credit_control_escalation',
  'register_review_assigned',
  'register_reminder',
  'general',
]);

export const DEFAULT_NOTIFICATION_PREFERENCES_BY_KIND: Readonly<
  Record<
    NotificationKind,
    {
      readonly inAppEnabled: boolean;
      readonly emailFrequency: NotificationChannelFrequency;
      readonly teamsEnabled: boolean;
    }
  >
> = Object.freeze({
  task_assigned: { inAppEnabled: true, emailFrequency: 'immediate', teamsEnabled: false },
  team_task_arrived: { inAppEnabled: true, emailFrequency: 'daily_digest', teamsEnabled: false },
  task_comment: { inAppEnabled: true, emailFrequency: 'daily_digest', teamsEnabled: false },
  enquiry_assigned: { inAppEnabled: true, emailFrequency: 'immediate', teamsEnabled: false },
  task_due_soon: { inAppEnabled: true, emailFrequency: 'daily_digest', teamsEnabled: false },
  task_overdue: { inAppEnabled: true, emailFrequency: 'immediate', teamsEnabled: false },
  approval_requested: { inAppEnabled: true, emailFrequency: 'immediate', teamsEnabled: false },
  approval_decided: { inAppEnabled: true, emailFrequency: 'immediate', teamsEnabled: false },
  key_date_approaching: { inAppEnabled: true, emailFrequency: 'daily_digest', teamsEnabled: false },
  credit_control_escalation: {
    inAppEnabled: true,
    emailFrequency: 'daily_digest',
    teamsEnabled: false,
  },
  register_review_assigned: {
    inAppEnabled: true,
    emailFrequency: 'immediate',
    teamsEnabled: false,
  },
  register_reminder: {
    inAppEnabled: true,
    emailFrequency: 'daily_digest',
    teamsEnabled: false,
  },
  general: { inAppEnabled: true, emailFrequency: 'daily_digest', teamsEnabled: false },
});

interface DbEmailOutboxRow {
  tenant_id: string;
  id: string;
  idempotency_key: string;
  template_key: string;
  correlation_id: string;
  recipients_json: unknown;
  subject: string | null;
  html_body: string | null;
  text_body: string | null;
  attachments_json: unknown;
  status: string;
  attempt_count: number | string;
  next_attempt_at: Date | string;
  claimed_at: Date | string | null;
  claim_token: string | null;
  sent_at: Date | string | null;
  provider_message_id: string | null;
  last_error_code: string | null;
  content_scrubbed_at: Date | string | null;
  created_by_person_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DbNotificationPreferenceRow {
  tenant_id: string;
  person_id: string;
  notification_kind: string;
  in_app_enabled: boolean;
  email_frequency: string;
  teams_enabled: boolean;
  digest_day_of_week: number | string;
  updated_at: Date | string;
}

function normalizeEmailArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

function normalizeRecipients(raw: unknown): EmailRecipientList {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const to = normalizeEmailArray(obj.to);
  const cc = normalizeEmailArray(obj.cc);
  const bcc = normalizeEmailArray(obj.bcc);
  return {
    to,
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
  };
}

function normalizeAttachments(raw: unknown): EmailAttachmentRef[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: EmailAttachmentRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.blobKey === 'string' &&
      typeof entry.fileName === 'string' &&
      typeof entry.contentType === 'string'
    ) {
      out.push({
        blobKey: entry.blobKey,
        ...(typeof entry.externalId === 'string'
          ? { externalId: entry.externalId }
          : {}),
        fileName: entry.fileName,
        contentType: entry.contentType,
      });
    }
  }
  return out;
}

function toNullableIsoString(val: Date | string | null | undefined): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  return toIsoString(val);
}

function mapOutboxRow(row: DbEmailOutboxRow): EmailOutboxRecord {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    templateKey: row.template_key,
    correlationId: row.correlation_id,
    recipients: normalizeRecipients(row.recipients_json),
    subject: row.subject ?? null,
    htmlBody: row.html_body ?? null,
    textBody: row.text_body ?? null,
    attachments: normalizeAttachments(row.attachments_json),
    status: row.status as EmailOutboxStatus,
    attemptCount: Number(row.attempt_count ?? 0),
    nextAttemptAt: toIsoString(row.next_attempt_at),
    claimedAt: toNullableIsoString(row.claimed_at),
    claimToken: row.claim_token ?? null,
    sentAt: toNullableIsoString(row.sent_at),
    providerMessageId: row.provider_message_id ?? null,
    lastErrorCode: row.last_error_code ?? null,
    contentScrubbedAt: toNullableIsoString(row.content_scrubbed_at),
    createdByPersonId: row.created_by_person_id ?? null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapPreferenceRow(
  row: DbNotificationPreferenceRow,
): UserNotificationPreference {
  return {
    tenantId: row.tenant_id,
    personId: row.person_id,
    notificationKind: row.notification_kind as NotificationKind,
    inAppEnabled: Boolean(row.in_app_enabled),
    emailFrequency: row.email_frequency as NotificationChannelFrequency,
    teamsEnabled: Boolean(row.teams_enabled),
    digestDayOfWeek: Number(row.digest_day_of_week ?? 1),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
  };
}

export interface EnqueueEmailOutboxInput {
  readonly idempotencyKey?: string;
  readonly templateKey: string;
  readonly recipients: EmailRecipientList;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly attachments?: readonly EmailAttachmentRef[];
  readonly createdByPersonId?: string | null;
  readonly nextAttemptAt?: string;
  readonly correlationId?: string;
}

export interface EnqueueEmailOutboxResult {
  readonly record: EmailOutboxRecord;
  readonly deduplicated: boolean;
}

export interface UpsertNotificationPreferenceInput {
  readonly personId: string;
  readonly notificationKind: NotificationKind;
  readonly inAppEnabled?: boolean;
  readonly emailFrequency?: NotificationChannelFrequency;
  readonly teamsEnabled?: boolean;
  readonly digestDayOfWeek?: number;
}

export class TenantOutboxRepository extends TenantScopedRepository {
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

  public async enqueueEmail(
    ctx: TenantContext,
    input: EnqueueEmailOutboxInput,
    options?: { readonly auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<EnqueueEmailOutboxResult> {
    const idempotencyKey =
      input.idempotencyKey?.trim() || `auto:${randomUUID()}`;
    const templateKey = input.templateKey.trim();
    if (!templateKey) {
      throw new Error('EMAIL_OUTBOX_INVALID: templateKey is required.');
    }
    const normalizedRecipients = normalizeRecipients(input.recipients);
    const totalRecipients =
      normalizedRecipients.to.length +
      (normalizedRecipients.cc?.length ?? 0) +
      (normalizedRecipients.bcc?.length ?? 0);
    if (totalRecipients === 0) {
      throw new Error(
        'EMAIL_OUTBOX_INVALID: At least one recipient (to, cc, or bcc) is required.',
      );
    }

    return this.withTenantTransaction(ctx, async (tx) => {
      const existingRes = await tx.query<DbEmailOutboxRow>(
        `SELECT *
           FROM public.email_outbox
          WHERE tenant_id = $1
            AND idempotency_key = $2
          LIMIT 1`,
        [ctx.tenantId, idempotencyKey],
      );
      if (existingRes.rows[0]) {
        this.assertRowTenant(ctx, existingRes.rows[0].tenant_id, 'EmailOutbox');
        return {
          record: mapOutboxRow(existingRes.rows[0]),
          deduplicated: true,
        };
      }

      const seqRes = await tx.query<{ seq: string }>(
        `SELECT nextval('public.tenant_email_outbox_id_seq')::text AS seq`,
      );
      const id = `EO-${String(seqRes.rows[0]?.seq ?? '1').padStart(6, '0')}`;
      const nowIso = new Date().toISOString();
      const nextAttemptAt = input.nextAttemptAt?.trim() || nowIso;
      const correlationId = input.correlationId?.trim() || ctx.correlationId;

      const insertRes = await tx.query<DbEmailOutboxRow>(
        `INSERT INTO public.email_outbox (
           tenant_id, id, idempotency_key, template_key, correlation_id,
           recipients_json, subject, html_body, text_body, attachments_json,
           status, attempt_count, next_attempt_at, claimed_at, claim_token,
           sent_at, provider_message_id, last_error_code, content_scrubbed_at,
           created_by_person_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6::jsonb, $7, $8, $9, $10::jsonb,
           'pending', 0, $11::timestamptz, NULL, NULL,
           NULL, NULL, NULL, NULL,
           $12, $13::timestamptz, $13::timestamptz
         )
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          ctx.tenantId,
          id,
          idempotencyKey,
          templateKey,
          correlationId,
          JSON.stringify(normalizedRecipients),
          input.subject,
          input.htmlBody,
          input.textBody,
          JSON.stringify(input.attachments ?? []),
          nextAttemptAt,
          input.createdByPersonId ?? null,
          nowIso,
        ],
      );

      if (!insertRes.rows[0]) {
        const winnerRes = await tx.query<DbEmailOutboxRow>(
          `SELECT *
             FROM public.email_outbox
            WHERE tenant_id = $1
              AND idempotency_key = $2
            LIMIT 1`,
          [ctx.tenantId, idempotencyKey],
        );
        const winner = winnerRes.rows[0]!;
        this.assertRowTenant(ctx, winner.tenant_id, 'EmailOutbox');
        return {
          record: mapOutboxRow(winner),
          deduplicated: true,
        };
      }

      const inserted = insertRes.rows[0];
      this.assertRowTenant(ctx, inserted.tenant_id, 'EmailOutbox');
      if (options?.auditEntries && options.auditEntries.length > 0) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return {
        record: mapOutboxRow(inserted),
        deduplicated: false,
      };
    });
  }

  public async claimDueOutboxBatch(
    ctx: TenantContext,
    options?: {
      readonly limit?: number;
      readonly now?: Date;
      readonly claimToken?: string;
      readonly reclaimStaleBeforeMinutes?: number;
    },
  ): Promise<readonly EmailOutboxRecord[]> {
    const limit = Math.max(1, Math.min(100, Math.floor(options?.limit ?? 20)));
    const now = options?.now ?? new Date();
    const nowIso = now.toISOString();
    const staleMinutes = Math.max(
      1,
      Math.floor(
        options?.reclaimStaleBeforeMinutes ?? DEFAULT_OUTBOX_STALE_CLAIM_MINUTES,
      ),
    );
    const staleCutoffIso = new Date(
      now.getTime() - staleMinutes * 60_000,
    ).toISOString();
    const claimToken = options?.claimToken?.trim() || randomUUID();

    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbEmailOutboxRow>(
        `WITH due AS (
           SELECT tenant_id, id
             FROM public.email_outbox
            WHERE tenant_id = $1
              AND content_scrubbed_at IS NULL
              AND (
                (status = 'pending' AND next_attempt_at <= $2::timestamptz)
                OR (
                  status = 'sending'
                  AND claimed_at IS NOT NULL
                  AND claimed_at <= $3::timestamptz
                )
              )
            ORDER BY next_attempt_at ASC, created_at ASC, id ASC
            LIMIT $4
            FOR UPDATE SKIP LOCKED
         )
         UPDATE public.email_outbox o
            SET status = 'sending',
                claimed_at = $2::timestamptz,
                claim_token = $5,
                updated_at = $2::timestamptz
           FROM due
          WHERE o.tenant_id = due.tenant_id
            AND o.id = due.id
         RETURNING o.*`,
        [ctx.tenantId, nowIso, staleCutoffIso, limit, claimToken],
      );

      const records = res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'EmailOutbox');
        return mapOutboxRow(row);
      });
      records.sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      );
      return records;
    });
  }

  public async markOutboxSent(
    ctx: TenantContext,
    params: {
      readonly id: string;
      readonly claimToken: string;
      readonly providerMessageId?: string | null;
      readonly sentAt?: Date;
      readonly auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<{ readonly updated: boolean; readonly record: EmailOutboxRecord | null }> {
    const nowIso = (params.sentAt ?? new Date()).toISOString();
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbEmailOutboxRow>(
        `UPDATE public.email_outbox
            SET status = 'sent',
                attempt_count = attempt_count + 1,
                sent_at = $4::timestamptz,
                claimed_at = NULL,
                claim_token = NULL,
                provider_message_id = $5,
                last_error_code = NULL,
                updated_at = $4::timestamptz
          WHERE tenant_id = $1
            AND id = $2
            AND status = 'sending'
            AND claim_token = $3
         RETURNING *`,
        [
          ctx.tenantId,
          params.id,
          params.claimToken,
          nowIso,
          params.providerMessageId ?? null,
        ],
      );
      const row = res.rows[0];
      if (!row) {
        return { updated: false, record: null };
      }
      this.assertRowTenant(ctx, row.tenant_id, 'EmailOutbox');
      if (params.auditEntries && params.auditEntries.length > 0) {
        await this.auditRepo.appendAuditEntries(ctx, params.auditEntries);
      }
      return { updated: true, record: mapOutboxRow(row) };
    });
  }

  public async markOutboxDroppedAllowlist(
    ctx: TenantContext,
    params: {
      readonly id: string;
      readonly claimToken: string;
      readonly reasonCode?: string;
      readonly droppedAt?: Date;
      readonly auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<{ readonly updated: boolean; readonly record: EmailOutboxRecord | null }> {
    const nowIso = (params.droppedAt ?? new Date()).toISOString();
    const errorCode = params.reasonCode?.trim() || 'EMAIL_ALLOWLIST_BLOCKED';
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbEmailOutboxRow>(
        `UPDATE public.email_outbox
            SET status = 'dropped_allowlist',
                attempt_count = attempt_count + 1,
                claimed_at = NULL,
                claim_token = NULL,
                last_error_code = $5,
                updated_at = $4::timestamptz
          WHERE tenant_id = $1
            AND id = $2
            AND status = 'sending'
            AND claim_token = $3
         RETURNING *`,
        [ctx.tenantId, params.id, params.claimToken, nowIso, errorCode],
      );
      const row = res.rows[0];
      if (!row) {
        return { updated: false, record: null };
      }
      this.assertRowTenant(ctx, row.tenant_id, 'EmailOutbox');
      if (params.auditEntries && params.auditEntries.length > 0) {
        await this.auditRepo.appendAuditEntries(ctx, params.auditEntries);
      }
      return { updated: true, record: mapOutboxRow(row) };
    });
  }

  public async markOutboxAttemptFailed(
    ctx: TenantContext,
    params: {
      readonly id: string;
      readonly claimToken: string;
      readonly error: unknown;
      readonly maxAttempts?: number;
      readonly baseBackoffSeconds?: number;
      readonly failedAt?: Date;
      readonly auditEntriesOnPermanentFailure?: readonly FirmAuditEntryInput[];
    },
  ): Promise<{
    readonly updated: boolean;
    readonly permanentFailure: boolean;
    readonly errorCode: string;
    readonly record: EmailOutboxRecord | null;
  }> {
    const now = params.failedAt ?? new Date();
    const nowIso = now.toISOString();
    const maxAttempts = Math.max(
      1,
      Math.floor(params.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS),
    );
    const baseBackoffSeconds = Math.max(
      1,
      Math.floor(
        params.baseBackoffSeconds ?? DEFAULT_OUTBOX_BASE_BACKOFF_SECONDS,
      ),
    );
    const errorCode =
      typeof params.error === 'string' && /^[A-Z0-9_.:-]{1,64}$/.test(params.error.trim())
        ? params.error.trim()
        : sanitizeJobErrorCode(params.error);

    return this.withTenantTransaction(ctx, async (tx) => {
      const currentRes = await tx.query<DbEmailOutboxRow>(
        `SELECT *
           FROM public.email_outbox
          WHERE tenant_id = $1
            AND id = $2
            AND status = 'sending'
            AND claim_token = $3
          FOR UPDATE`,
        [ctx.tenantId, params.id, params.claimToken],
      );
      const current = currentRes.rows[0];
      if (!current) {
        return {
          updated: false,
          permanentFailure: false,
          errorCode,
          record: null,
        };
      }
      this.assertRowTenant(ctx, current.tenant_id, 'EmailOutbox');

      const nextAttemptCount = Number(current.attempt_count ?? 0) + 1;
      const permanentFailure = nextAttemptCount >= maxAttempts;

      if (permanentFailure) {
        const permRes = await tx.query<DbEmailOutboxRow>(
          `UPDATE public.email_outbox
              SET status = 'failed_permanent',
                  attempt_count = $4,
                  claimed_at = NULL,
                  claim_token = NULL,
                  last_error_code = $5,
                  updated_at = $6::timestamptz
            WHERE tenant_id = $1
              AND id = $2
              AND status = 'sending'
              AND claim_token = $3
           RETURNING *`,
          [
            ctx.tenantId,
            params.id,
            params.claimToken,
            nextAttemptCount,
            errorCode,
            nowIso,
          ],
        );
        const updatedRow = permRes.rows[0]!;
        this.assertRowTenant(ctx, updatedRow.tenant_id, 'EmailOutbox');
        if (
          params.auditEntriesOnPermanentFailure &&
          params.auditEntriesOnPermanentFailure.length > 0
        ) {
          await this.auditRepo.appendAuditEntries(
            ctx,
            params.auditEntriesOnPermanentFailure,
          );
        }
        return {
          updated: true,
          permanentFailure: true,
          errorCode,
          record: mapOutboxRow(updatedRow),
        };
      }

      const backoffSeconds = Math.min(
        MAX_OUTBOX_BACKOFF_SECONDS,
        baseBackoffSeconds * 2 ** Math.max(0, nextAttemptCount - 1),
      );
      const nextAttemptAtIso = new Date(
        now.getTime() + backoffSeconds * 1000,
      ).toISOString();

      const retryRes = await tx.query<DbEmailOutboxRow>(
        `UPDATE public.email_outbox
            SET status = 'pending',
                attempt_count = $4,
                next_attempt_at = $5::timestamptz,
                claimed_at = NULL,
                claim_token = NULL,
                last_error_code = $6,
                updated_at = $7::timestamptz
          WHERE tenant_id = $1
            AND id = $2
            AND status = 'sending'
            AND claim_token = $3
         RETURNING *`,
        [
          ctx.tenantId,
          params.id,
          params.claimToken,
          nextAttemptCount,
          nextAttemptAtIso,
          errorCode,
          nowIso,
        ],
      );
      const updatedRow = retryRes.rows[0]!;
      this.assertRowTenant(ctx, updatedRow.tenant_id, 'EmailOutbox');
      return {
        updated: true,
        permanentFailure: false,
        errorCode,
        record: mapOutboxRow(updatedRow),
      };
    });
  }

  public async scrubExpiredOutboxContent(
    ctx: TenantContext,
    params?: {
      readonly retentionDays?: number;
      readonly now?: Date;
      readonly auditEntriesFactory?: (
        scrubbedCount: number,
        nowIso: string,
      ) => readonly FirmAuditEntryInput[];
    },
  ): Promise<{ readonly lockAcquired: boolean; readonly scrubbedCount: number }> {
    const retentionDays = Math.max(
      1,
      Math.min(
        3650,
        Math.floor(params?.retentionDays ?? DEFAULT_OUTBOX_RETENTION_DAYS),
      ),
    );
    const now = params?.now ?? new Date();
    const nowIso = now.toISOString();
    const cutoffIso = new Date(
      now.getTime() - retentionDays * 86_400_000,
    ).toISOString();
    const lockKey = `onesquared_outbox_scrub:${ctx.tenantId}`;

    return this.withTenantTransaction(ctx, async (tx) => {
      const lockRes = await tx.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
        [lockKey],
      );
      if (!lockRes.rows[0]?.acquired) {
        return { lockAcquired: false, scrubbedCount: 0 };
      }

      const scrubRes = await tx.query<{ tenant_id: string; id: string }>(
        `UPDATE public.email_outbox
            SET recipients_json = '{"to":[]}'::jsonb,
                subject = NULL,
                html_body = NULL,
                text_body = NULL,
                attachments_json = '[]'::jsonb,
                content_scrubbed_at = $2::timestamptz,
                updated_at = $2::timestamptz
          WHERE tenant_id = $1
            AND content_scrubbed_at IS NULL
            AND status IN ('sent', 'dropped_allowlist', 'failed_permanent')
            AND COALESCE(sent_at, updated_at, created_at) <= $3::timestamptz
         RETURNING tenant_id, id`,
        [ctx.tenantId, nowIso, cutoffIso],
      );

      for (const row of scrubRes.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'EmailOutbox');
      }

      const scrubbedCount = scrubRes.rows.length;
      if (scrubbedCount > 0 && params?.auditEntriesFactory) {
        const auditEntries = params.auditEntriesFactory(scrubbedCount, nowIso);
        if (auditEntries.length > 0) {
          await this.auditRepo.appendAuditEntries(ctx, auditEntries);
        }
      }

      return { lockAcquired: true, scrubbedCount };
    });
  }

  public async getOutboxRecordById(
    ctx: TenantContext,
    id: string,
  ): Promise<EmailOutboxRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbEmailOutboxRow>(
        `SELECT *
           FROM public.email_outbox
          WHERE tenant_id = $1
            AND id = $2
          LIMIT 1`,
        [ctx.tenantId, id],
      );
      const row = res.rows[0];
      if (!row) {
        return null;
      }
      this.assertRowTenant(ctx, row.tenant_id, 'EmailOutbox');
      return mapOutboxRow(row);
    });
  }

  public async listOutboxRecords(
    ctx: TenantContext,
    filter?: { readonly status?: EmailOutboxStatus; readonly limit?: number },
  ): Promise<readonly EmailOutboxRecord[]> {
    const limit = Math.max(1, Math.min(200, Math.floor(filter?.limit ?? 100)));
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const params: unknown[] = [ctx.tenantId];
      let where = 'tenant_id = $1';
      if (filter?.status) {
        params.push(filter.status);
        where += ` AND status = $${params.length}`;
      }
      params.push(limit);
      const res = await tx.query<DbEmailOutboxRow>(
        `SELECT *
           FROM public.email_outbox
          WHERE ${where}
          ORDER BY created_at ASC, id ASC
          LIMIT $${params.length}`,
        params,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'EmailOutbox');
        return mapOutboxRow(row);
      });
    });
  }

  public async getNotificationPreference(
    ctx: TenantContext,
    personId: string,
    notificationKind: NotificationKind,
  ): Promise<UserNotificationPreference> {
    const defaults =
      DEFAULT_NOTIFICATION_PREFERENCES_BY_KIND[notificationKind] ??
      DEFAULT_NOTIFICATION_PREFERENCES_BY_KIND.general;

    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbNotificationPreferenceRow>(
        `SELECT *
           FROM public.user_notification_preferences
          WHERE tenant_id = $1
            AND person_id = $2
            AND notification_kind = $3
          LIMIT 1`,
        [ctx.tenantId, personId, notificationKind],
      );
      const row = res.rows[0];
      if (!row) {
        return {
          tenantId: ctx.tenantId,
          personId,
          notificationKind,
          inAppEnabled: defaults.inAppEnabled,
          emailFrequency: defaults.emailFrequency,
          teamsEnabled: defaults.teamsEnabled,
          digestDayOfWeek: 1,
          updatedAt: new Date(0).toISOString(),
        };
      }
      this.assertRowTenant(
        ctx,
        row.tenant_id,
        'UserNotificationPreference',
      );
      return mapPreferenceRow(row);
    });
  }

  public async listNotificationPreferencesForUser(
    ctx: TenantContext,
    personId: string,
  ): Promise<readonly UserNotificationPreference[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbNotificationPreferenceRow>(
        `SELECT *
           FROM public.user_notification_preferences
          WHERE tenant_id = $1
            AND person_id = $2`,
        [ctx.tenantId, personId],
      );
      const byKind = new Map<string, UserNotificationPreference>();
      for (const row of res.rows) {
        this.assertRowTenant(
          ctx,
          row.tenant_id,
          'UserNotificationPreference',
        );
        const mapped = mapPreferenceRow(row);
        byKind.set(mapped.notificationKind, mapped);
      }

      return ALL_NOTIFICATION_KINDS.map((kind) => {
        const stored = byKind.get(kind);
        if (stored) {
          return stored;
        }
        const defaults =
          DEFAULT_NOTIFICATION_PREFERENCES_BY_KIND[kind] ??
          DEFAULT_NOTIFICATION_PREFERENCES_BY_KIND.general;
        return {
          tenantId: ctx.tenantId,
          personId,
          notificationKind: kind,
          inAppEnabled: defaults.inAppEnabled,
          emailFrequency: defaults.emailFrequency,
          teamsEnabled: defaults.teamsEnabled,
          digestDayOfWeek: 1,
          updatedAt: new Date(0).toISOString(),
        };
      });
    });
  }

  public async upsertNotificationPreference(
    ctx: TenantContext,
    input: UpsertNotificationPreferenceInput,
    options?: { readonly auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<UserNotificationPreference> {
    const personId = input.personId.trim();
    if (!personId) {
      throw new Error('NOTIFICATION_PREFERENCE_INVALID: personId is required.');
    }
    const defaults =
      DEFAULT_NOTIFICATION_PREFERENCES_BY_KIND[input.notificationKind] ??
      DEFAULT_NOTIFICATION_PREFERENCES_BY_KIND.general;
    const inAppEnabled = input.inAppEnabled ?? defaults.inAppEnabled;
    const emailFrequency = input.emailFrequency ?? defaults.emailFrequency;
    const teamsEnabled = input.teamsEnabled ?? defaults.teamsEnabled;
    const digestDayOfWeek = input.digestDayOfWeek ?? 1;
    if (
      !Number.isInteger(digestDayOfWeek) ||
      digestDayOfWeek < 0 ||
      digestDayOfWeek > 6
    ) {
      throw new Error(
        'NOTIFICATION_PREFERENCE_INVALID: digestDayOfWeek must be an integer between 0 and 6.',
      );
    }

    return this.withTenantTransaction(ctx, async (tx) => {
      const nowIso = new Date().toISOString();
      const res = await tx.query<DbNotificationPreferenceRow>(
        `INSERT INTO public.user_notification_preferences (
           tenant_id, person_id, notification_kind,
           in_app_enabled, email_frequency, teams_enabled,
           digest_day_of_week, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::timestamptz
         )
         ON CONFLICT (tenant_id, person_id, notification_kind) DO UPDATE
           SET in_app_enabled = EXCLUDED.in_app_enabled,
               email_frequency = EXCLUDED.email_frequency,
               teams_enabled = EXCLUDED.teams_enabled,
               digest_day_of_week = EXCLUDED.digest_day_of_week,
               updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          ctx.tenantId,
          personId,
          input.notificationKind,
          inAppEnabled,
          emailFrequency,
          teamsEnabled,
          digestDayOfWeek,
          nowIso,
        ],
      );
      const row = res.rows[0]!;
      this.assertRowTenant(
        ctx,
        row.tenant_id,
        'UserNotificationPreference',
      );
      if (options?.auditEntries && options.auditEntries.length > 0) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return mapPreferenceRow(row);
    });
  }

  public async countAllTenantOutboxRows(ctx: TenantContext): Promise<{
    readonly outbox: number;
    readonly preferences: number;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [outRes, prefRes] = await Promise.all([
        tx.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM public.email_outbox WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
        tx.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM public.user_notification_preferences WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
      ]);
      return {
        outbox: Number(outRes.rows[0]?.count ?? 0),
        preferences: Number(prefRes.rows[0]?.count ?? 0),
      };
    });
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        `DELETE FROM public.email_outbox WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
      await tx.query(
        `DELETE FROM public.user_notification_preferences WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
    });
  }
}
