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

import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_EMAIL_TOTAL_ATTACHMENT_BYTES,
  type EmailAttachmentRef,
  type EmailInlineAttachment,
  type EmailOutboxAdminAttachmentResult,
  type EmailOutboxAdminDetail,
  type EmailOutboxAdminListItem,
  type EmailOutboxRecord,
  type EmailOutboxStatus,
  type EmailOutboxStoredAttachment,
  type EmailRecipientList,
  type FirmAuditEntryInput,
  type NotificationChannelFrequency,
  type NotificationKind,
  type OutgoingEmailAttachment,
  type OutgoingTeamsActivityTemplateParameter,
  type TeamsActivityOutboxRecord,
  type TeamsActivityOutboxStatus,
  type TenantContext,
  type UserNotificationPreference,
} from '../api/index';
import { TenantAuditRepository } from './auditRepository';
import {
  buildMatterHiddenFromViewerSql,
  ENQUIRY_VISIBLE_SQL_PREDICATE,
  QUOTE_VISIBLE_SQL_PREDICATE,
} from './intakeQuoteRepository';
import { sanitizeJobErrorCode } from './jobRunRepository';
import type { TenantPostgresPoolManager } from './postgresPoolManager';
import {
  TenantScopedRepository,
  toIsoString,
  type TenantSqlClient,
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
  matter_id: string | null;
  quote_id: string | null;
  enquiry_id: string | null;
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

function normalizeAttachments(raw: unknown): EmailOutboxStoredAttachment[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: EmailOutboxStoredAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (
      entry.source === 'outbox' &&
      typeof entry.ordinal === 'number' &&
      typeof entry.fileName === 'string' &&
      typeof entry.contentType === 'string' &&
      typeof entry.byteSize === 'number' &&
      typeof entry.sha256 === 'string'
    ) {
      out.push({
        source: 'outbox',
        ordinal: entry.ordinal,
        fileName: entry.fileName,
        contentType: entry.contentType,
        byteSize: entry.byteSize,
        sha256: entry.sha256,
      });
      continue;
    }
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
    ...(row.matter_id !== null && row.matter_id !== undefined
      ? { matterId: row.matter_id }
      : {}),
    ...(row.quote_id !== null && row.quote_id !== undefined
      ? { quoteId: row.quote_id }
      : {}),
    ...(row.enquiry_id !== null && row.enquiry_id !== undefined
      ? { enquiryId: row.enquiry_id }
      : {}),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function buildAdminOutboxVisibleWhereSql(): string {
  // R826: Only outbox rows linked to a matter, quote, or enquiry are visible
  // in Administration -> Email Outbox (omits pre-0028, staff alert, and digest emails).
  const linkageSql =
    '(eo.matter_id IS NOT NULL OR eo.quote_id IS NOT NULL OR eo.enquiry_id IS NOT NULL)';

  // R823: Always enforce exact matter, quote, and enquiry SQL visibility predicates;
  // Admin is NEVER exempt from restricted matters, staff matters, or ethical walls.
  return `(
    ${linkageSql}
    AND (
      eo.matter_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.matters m
         WHERE m.tenant_id = eo.tenant_id
           AND m.id = eo.matter_id
           AND NOT ${buildMatterHiddenFromViewerSql('m', 2)}
      )
    )
    AND (
      eo.quote_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.quotes q
         WHERE q.tenant_id = eo.tenant_id
           AND q.id = eo.quote_id
           AND ${QUOTE_VISIBLE_SQL_PREDICATE}
      )
    )
    AND (
      eo.enquiry_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.enquiries e
         WHERE e.tenant_id = eo.tenant_id
           AND e.id = eo.enquiry_id
           AND ${ENQUIRY_VISIBLE_SQL_PREDICATE}
      )
    )
  )`;
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

interface DbTeamsOutboxRow {
  tenant_id: string;
  id: string;
  idempotency_key: string;
  recipient_person_id: string;
  entra_object_id: string | null;
  activity_type: string;
  preview_text: string | null;
  template_parameters_json: unknown;
  deep_link_path: string;
  correlation_id: string;
  status: string;
  attempt_count: number | string;
  next_attempt_at: Date | string;
  claimed_at: Date | string | null;
  claim_token: string | null;
  sent_at: Date | string | null;
  provider_request_id: string | null;
  last_error_code: string | null;
  content_scrubbed_at: Date | string | null;
  created_by_person_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function normalizeTeamsTemplateParameters(
  raw: unknown,
): OutgoingTeamsActivityTemplateParameter[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: OutgoingTeamsActivityTemplateParameter[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.name === 'string' && typeof entry.value === 'string') {
      out.push({ name: entry.name, value: entry.value });
    }
  }
  return out;
}

function mapTeamsOutboxRow(row: DbTeamsOutboxRow): TeamsActivityOutboxRecord {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    recipientPersonId: row.recipient_person_id,
    entraObjectId: row.entra_object_id ?? null,
    activityType: row.activity_type,
    previewText: row.preview_text ?? null,
    templateParameters: normalizeTeamsTemplateParameters(
      row.template_parameters_json,
    ),
    deepLinkPath: row.deep_link_path,
    correlationId: row.correlation_id,
    status: row.status as TeamsActivityOutboxStatus,
    attemptCount: Number(row.attempt_count ?? 0),
    nextAttemptAt: toIsoString(row.next_attempt_at),
    claimedAt: toNullableIsoString(row.claimed_at),
    claimToken: row.claim_token ?? null,
    sentAt: toNullableIsoString(row.sent_at),
    providerRequestId: row.provider_request_id ?? null,
    lastErrorCode: row.last_error_code ?? null,
    contentScrubbedAt: toNullableIsoString(row.content_scrubbed_at),
    createdByPersonId: row.created_by_person_id ?? null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function computeAttemptFailurePlan(params: {
  readonly currentAttemptCount: number;
  readonly error: unknown;
  readonly maxAttempts?: number;
  readonly baseBackoffSeconds?: number;
  readonly forcePermanent?: boolean;
  readonly now: Date;
}): {
  readonly nextAttemptCount: number;
  readonly permanentFailure: boolean;
  readonly errorCode: string;
  readonly nextAttemptAtIso: string;
} {
  const maxAttempts = Math.max(
    1,
    Math.floor(params.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS),
  );
  const baseBackoffSeconds = Math.max(
    1,
    Math.floor(params.baseBackoffSeconds ?? DEFAULT_OUTBOX_BASE_BACKOFF_SECONDS),
  );
  const errorCode =
    typeof params.error === 'string' &&
    /^[A-Z0-9_.:-]{1,64}$/.test(params.error.trim())
      ? params.error.trim()
      : sanitizeJobErrorCode(params.error);
  const nextAttemptCount = params.currentAttemptCount + 1;
  const permanentFailure =
    Boolean(params.forcePermanent) || nextAttemptCount >= maxAttempts;
  const backoffSeconds = Math.min(
    MAX_OUTBOX_BACKOFF_SECONDS,
    baseBackoffSeconds * 2 ** Math.max(0, nextAttemptCount - 1),
  );
  return {
    nextAttemptCount,
    permanentFailure,
    errorCode,
    nextAttemptAtIso: new Date(
      params.now.getTime() + backoffSeconds * 1000,
    ).toISOString(),
  };
}

export interface EnqueueTeamsActivityOutboxInput {
  readonly idempotencyKey?: string;
  readonly recipientPersonId: string;
  readonly entraObjectId?: string | null;
  readonly activityType: string;
  readonly previewText: string;
  readonly templateParameters?: readonly OutgoingTeamsActivityTemplateParameter[];
  readonly deepLinkPath: string;
  readonly correlationId?: string;
  readonly createdByPersonId?: string | null;
  readonly nextAttemptAt?: string;
}

export interface EnqueueTeamsActivityOutboxResult {
  readonly record: TeamsActivityOutboxRecord;
  readonly deduplicated: boolean;
}

export interface EnqueueEmailOutboxInput {
  readonly idempotencyKey?: string;
  readonly templateKey: string;
  readonly recipients: EmailRecipientList;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly attachments?: readonly OutgoingEmailAttachment[];
  readonly matterId?: string | null;
  readonly quoteId?: string | null;
  readonly enquiryId?: string | null;
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

  private prepareEmailOutboxEnqueue(input: EnqueueEmailOutboxInput) {
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

    const preparedInlineAttachments: Array<{
      readonly ordinal: number;
      readonly fileName: string;
      readonly contentType: string;
      readonly byteSize: number;
      readonly sha256: string;
      readonly contentBytes: Uint8Array;
    }> = [];
    const attachmentsJson: EmailOutboxStoredAttachment[] = [];
    let cumulativeInlineBytes = 0;

    for (const [idx, rawAtt] of (input.attachments ?? []).entries()) {
      if ((rawAtt as EmailInlineAttachment)?.kind === 'inline') {
        const inline = rawAtt as EmailInlineAttachment;
        const fileName = inline.fileName?.trim() ?? '';
        const contentType = inline.contentType?.trim() ?? '';
        if (!fileName || !contentType) {
          throw new Error(
            'EMAIL_ATTACHMENT_INVALID: Inline attachments require fileName and contentType.',
          );
        }
        if (
          !(inline.contentBytes instanceof Uint8Array) ||
          inline.contentBytes.length === 0
        ) {
          throw new Error(
            'EMAIL_ATTACHMENT_INVALID: Inline attachment contentBytes must be a non-empty Uint8Array.',
          );
        }
        cumulativeInlineBytes += inline.contentBytes.length;
        if (cumulativeInlineBytes > MAX_EMAIL_TOTAL_ATTACHMENT_BYTES) {
          throw new Error(
            `EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED: Total email attachment size (${cumulativeInlineBytes} bytes) exceeds ${MAX_EMAIL_TOTAL_ATTACHMENT_BYTES} bytes.`,
          );
        }
        const sha256 = createHash('sha256')
          .update(inline.contentBytes)
          .digest('hex');
        const ordinal = idx;
        preparedInlineAttachments.push({
          ordinal,
          fileName,
          contentType,
          byteSize: inline.contentBytes.length,
          sha256,
          contentBytes: inline.contentBytes,
        });
        attachmentsJson.push({
          source: 'outbox',
          ordinal,
          fileName,
          contentType,
          byteSize: inline.contentBytes.length,
          sha256,
        });
      } else {
        const ref = rawAtt as EmailAttachmentRef;
        const blobKey = ref?.blobKey?.trim() ?? '';
        const fileName = ref?.fileName?.trim() ?? '';
        const contentType = ref?.contentType?.trim() ?? '';
        if (!blobKey || !fileName || !contentType) {
          throw new Error(
            'EMAIL_ATTACHMENT_INVALID: Attachment references require blobKey, fileName, and contentType.',
          );
        }
        attachmentsJson.push({
          blobKey,
          ...(ref.externalId ? { externalId: ref.externalId } : {}),
          fileName,
          contentType,
        });
      }
    }

    return {
      idempotencyKey,
      templateKey,
      normalizedRecipients,
      preparedInlineAttachments,
      attachmentsJson,
    };
  }

  public async enqueueEmailInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    input: EnqueueEmailOutboxInput,
    options?: { readonly auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<EnqueueEmailOutboxResult> {
    const {
      idempotencyKey,
      templateKey,
      normalizedRecipients,
      preparedInlineAttachments,
      attachmentsJson,
    } = this.prepareEmailOutboxEnqueue(input);

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
         matter_id, quote_id, enquiry_id,
         created_by_person_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::jsonb, $7, $8, $9, $10::jsonb,
         'pending', 0, $11::timestamptz, NULL, NULL,
         NULL, NULL, NULL, NULL,
         $12, $13, $14,
         $15, $16::timestamptz, $16::timestamptz
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
        JSON.stringify(attachmentsJson),
        nextAttemptAt,
        input.matterId?.trim() || null,
        input.quoteId?.trim() || null,
        input.enquiryId?.trim() || null,
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
    for (const att of preparedInlineAttachments) {
      await tx.query(
        `INSERT INTO public.email_outbox_attachments (
           tenant_id, outbox_id, ordinal, file_name, content_type,
           byte_size, sha256, content_bytes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ctx.tenantId,
          inserted.id,
          att.ordinal,
          att.fileName,
          att.contentType,
          att.byteSize,
          att.sha256,
          Buffer.from(att.contentBytes),
        ],
      );
    }
    if (options?.auditEntries && options.auditEntries.length > 0) {
      await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
    }
    return {
      record: mapOutboxRow(inserted),
      deduplicated: false,
    };
  }

  public async enqueueEmail(
    ctx: TenantContext,
    input: EnqueueEmailOutboxInput,
    options?: { readonly auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<EnqueueEmailOutboxResult> {
    this.prepareEmailOutboxEnqueue(input);
    return this.withTenantTransaction(ctx, async (tx) =>
      this.enqueueEmailInTx(tx, ctx, input, options),
    );
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

  public async getClaimedOutboxAttachmentBytes(
    ctx: TenantContext,
    params: { readonly outboxId: string; readonly claimToken: string },
  ): Promise<ReadonlyArray<EmailInlineAttachment & { readonly ordinal: number }>> {
    const outboxId = params.outboxId?.trim() ?? '';
    const claimToken = params.claimToken?.trim() ?? '';
    if (!outboxId || !claimToken) {
      return [];
    }

    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        outbox_id: string;
        ordinal: number;
        file_name: string;
        content_type: string;
        byte_size: number;
        sha256: string;
        content_bytes: Buffer;
      }>(
        `SELECT a.tenant_id, a.outbox_id, a.ordinal, a.file_name,
                a.content_type, a.byte_size, a.sha256, a.content_bytes
           FROM public.email_outbox_attachments a
           JOIN public.email_outbox o
             ON o.tenant_id = a.tenant_id
            AND o.id = a.outbox_id
          WHERE o.tenant_id = $1
            AND o.id = $2
            AND o.status = 'sending'
            AND o.claim_token = $3
            AND o.content_scrubbed_at IS NULL
          ORDER BY a.ordinal ASC`,
        [ctx.tenantId, outboxId, claimToken],
      );

      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'EmailOutboxAttachment');
        const bytes = new Uint8Array(row.content_bytes);
        const actualSha = createHash('sha256').update(bytes).digest('hex');
        if (actualSha !== row.sha256) {
          throw new Error(
            'EMAIL_OUTBOX_ATTACHMENT_CORRUPTED: Stored outbox attachment digest mismatch.',
          );
        }
        return {
          ordinal: Number(row.ordinal),
          kind: 'inline' as const,
          fileName: row.file_name,
          contentType: row.content_type,
          contentBytes: bytes,
          sha256: row.sha256,
          byteSize: Number(row.byte_size),
        };
      });
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
      readonly forcePermanent?: boolean;
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
          errorCode: computeAttemptFailurePlan({
            currentAttemptCount: 0,
            error: params.error,
            maxAttempts: params.maxAttempts,
            baseBackoffSeconds: params.baseBackoffSeconds,
            forcePermanent: params.forcePermanent,
            now,
          }).errorCode,
          record: null,
        };
      }
      this.assertRowTenant(ctx, current.tenant_id, 'EmailOutbox');

      const plan = computeAttemptFailurePlan({
        currentAttemptCount: Number(current.attempt_count ?? 0),
        error: params.error,
        maxAttempts: params.maxAttempts,
        baseBackoffSeconds: params.baseBackoffSeconds,
        forcePermanent: params.forcePermanent,
        now,
      });

      if (plan.permanentFailure) {
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
            plan.nextAttemptCount,
            plan.errorCode,
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
          errorCode: plan.errorCode,
          record: mapOutboxRow(updatedRow),
        };
      }

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
          plan.nextAttemptCount,
          plan.nextAttemptAtIso,
          plan.errorCode,
          nowIso,
        ],
      );
      const updatedRow = retryRes.rows[0]!;
      this.assertRowTenant(ctx, updatedRow.tenant_id, 'EmailOutbox');
      return {
        updated: true,
        permanentFailure: false,
        errorCode: plan.errorCode,
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

      if (scrubRes.rows.length > 0) {
        const scrubbedIds = scrubRes.rows.map((r) => r.id);
        await tx.query(
          `DELETE FROM public.email_outbox_attachments
            WHERE tenant_id = $1
              AND outbox_id = ANY($2::text[])`,
          [ctx.tenantId, scrubbedIds],
        );
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

  public async getOutboxRecordByIdInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    id: string,
  ): Promise<EmailOutboxRecord | null> {
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
  }

  public async getOutboxRecordById(
    ctx: TenantContext,
    id: string,
  ): Promise<EmailOutboxRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) =>
      this.getOutboxRecordByIdInTx(tx, ctx, id),
    );
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

  /**
   * Lists outbound emails visible to an Admin in Administration -> Email Outbox (`R823` & `R826`):
   * - Requires at least one link (`matter_id`, `quote_id`, or `enquiry_id`), omitting staff notifications & digests.
   * - Filters by matter/quote/enquiry SQL visibility predicates (Admin is NOT exempt).
   * - Never selects `html_body` or `text_body` in list queries.
   */
  public async listVisibleOutboxRecordsForAdmin(
    ctx: TenantContext,
    params: {
      readonly viewerId: string;
      readonly hasRestrictedMatterAccess?: boolean;
      readonly status?: EmailOutboxStatus;
      readonly limit?: number;
      readonly offset?: number;
    },
  ): Promise<readonly EmailOutboxAdminListItem[]> {
    const cleanViewerId = params.viewerId?.trim() ?? '';
    const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? 50)));
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const visibilitySql = buildAdminOutboxVisibleWhereSql();

    return this.withTenantReadTransaction(ctx, async (tx) => {
      const sqlParams: unknown[] = [ctx.tenantId, cleanViewerId];
      let whereSql = `eo.tenant_id = $1 AND ${visibilitySql}`;
      if (params.status) {
        sqlParams.push(params.status);
        whereSql += ` AND eo.status = $${sqlParams.length}`;
      }
      sqlParams.push(limit);
      const limitParam = `$${sqlParams.length}`;
      sqlParams.push(offset);
      const offsetParam = `$${sqlParams.length}`;

      const res = await tx.query<{
        tenant_id: string;
        id: string;
        template_key: string;
        recipients_json: unknown;
        subject: string | null;
        attachments_json: unknown;
        status: string;
        attempt_count: number | string;
        next_attempt_at: Date | string;
        sent_at: Date | string | null;
        last_error_code: string | null;
        content_scrubbed_at: Date | string | null;
        matter_id: string | null;
        quote_id: string | null;
        enquiry_id: string | null;
        created_by_person_id: string | null;
        created_at: Date | string;
        updated_at: Date | string;
      }>(
        `SELECT eo.tenant_id, eo.id, eo.template_key, eo.recipients_json, eo.subject,
                eo.attachments_json, eo.status, eo.attempt_count, eo.next_attempt_at,
                eo.sent_at, eo.last_error_code, eo.content_scrubbed_at,
                eo.matter_id, eo.quote_id, eo.enquiry_id,
                eo.created_by_person_id, eo.created_at, eo.updated_at
           FROM public.email_outbox eo
          WHERE ${whereSql}
          ORDER BY eo.created_at DESC, eo.id DESC
          LIMIT ${limitParam} OFFSET ${offsetParam}`,
        sqlParams,
      );

      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'EmailOutboxAdminList');
        return {
          tenantId: row.tenant_id,
          id: row.id,
          templateKey: row.template_key,
          recipients: normalizeRecipients(row.recipients_json),
          subject: row.subject ?? null,
          attachments: normalizeAttachments(row.attachments_json),
          status: row.status as EmailOutboxStatus,
          attemptCount: Number(row.attempt_count ?? 0),
          nextAttemptAt: toIsoString(row.next_attempt_at),
          sentAt: toNullableIsoString(row.sent_at),
          lastErrorCode: row.last_error_code ?? null,
          contentScrubbedAt: toNullableIsoString(row.content_scrubbed_at),
          matterId: row.matter_id ?? null,
          quoteId: row.quote_id ?? null,
          enquiryId: row.enquiry_id ?? null,
          createdByPersonId: row.created_by_person_id ?? null,
          createdAt: toIsoString(row.created_at),
          updatedAt: toIsoString(row.updated_at),
        };
      });
    });
  }

  /**
   * Loads one linked outbox message (including body) only if it satisfies R826 linkage
   * and R823 visibility for `viewerId`. Returns `null` when missing, cross-tenant, unlinked,
   * or belonging to a hidden matter/quote/enquiry (uniform NOT_FOUND at caller level).
   */
  public async getVisibleOutboxRecordForAdmin(
    ctx: TenantContext,
    params: {
      readonly outboxId: string;
      readonly viewerId: string;
      readonly hasRestrictedMatterAccess?: boolean;
    },
  ): Promise<EmailOutboxAdminDetail | null> {
    const cleanId = params.outboxId?.trim() ?? '';
    const cleanViewerId = params.viewerId?.trim() ?? '';
    if (!cleanId) return null;
    const visibilitySql = buildAdminOutboxVisibleWhereSql();

    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbEmailOutboxRow>(
        `SELECT eo.*
           FROM public.email_outbox eo
          WHERE eo.tenant_id = $1
            AND eo.id = $3
            AND ${visibilitySql}
          LIMIT 1`,
        [ctx.tenantId, cleanViewerId, cleanId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'EmailOutboxAdminDetail');
      return {
        tenantId: row.tenant_id,
        id: row.id,
        templateKey: row.template_key,
        recipients: normalizeRecipients(row.recipients_json),
        subject: row.subject ?? null,
        htmlBody: row.html_body ?? null,
        textBody: row.text_body ?? null,
        attachments: normalizeAttachments(row.attachments_json),
        status: row.status as EmailOutboxStatus,
        attemptCount: Number(row.attempt_count ?? 0),
        nextAttemptAt: toIsoString(row.next_attempt_at),
        sentAt: toNullableIsoString(row.sent_at),
        providerMessageId: row.provider_message_id ?? null,
        lastErrorCode: row.last_error_code ?? null,
        contentScrubbedAt: toNullableIsoString(row.content_scrubbed_at),
        matterId: row.matter_id ?? null,
        quoteId: row.quote_id ?? null,
        enquiryId: row.enquiry_id ?? null,
        createdByPersonId: row.created_by_person_id ?? null,
        createdAt: toIsoString(row.created_at),
        updatedAt: toIsoString(row.updated_at),
      };
    });
  }

  /**
   * Reads an inline attachment non-destructively (read-only TX; zero outbox status mutation)
   * only when the parent outbox row satisfies R826 linkage and R823 visibility.
   */
  public async getVisibleOutboxAttachmentForAdmin(
    ctx: TenantContext,
    params: {
      readonly outboxId: string;
      readonly ordinal: number;
      readonly viewerId: string;
      readonly hasRestrictedMatterAccess?: boolean;
    },
  ): Promise<EmailOutboxAdminAttachmentResult | null> {
    const cleanId = params.outboxId?.trim() ?? '';
    const cleanViewerId = params.viewerId?.trim() ?? '';
    if (!cleanId || !Number.isInteger(params.ordinal) || params.ordinal < 0) {
      return null;
    }
    const visibilitySql = buildAdminOutboxVisibleWhereSql();

    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        outbox_id: string;
        ordinal: number | string;
        file_name: string;
        content_type: string;
        byte_size: number | string;
        sha256: string;
        content_bytes: Buffer;
      }>(
        `SELECT a.tenant_id, a.outbox_id, a.ordinal, a.file_name,
                a.content_type, a.byte_size, a.sha256, a.content_bytes
           FROM public.email_outbox_attachments a
           JOIN public.email_outbox eo
             ON eo.tenant_id = a.tenant_id
            AND eo.id = a.outbox_id
          WHERE eo.tenant_id = $1
            AND eo.id = $3
            AND a.ordinal = $4
            AND eo.content_scrubbed_at IS NULL
            AND ${visibilitySql}
          LIMIT 1`,
        [ctx.tenantId, cleanViewerId, cleanId, params.ordinal],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'EmailOutboxAdminAttachment');
      const bytes = new Uint8Array(row.content_bytes);
      const actualSha = createHash('sha256').update(bytes).digest('hex');
      if (actualSha !== row.sha256) {
        throw new Error(
          'EMAIL_OUTBOX_ATTACHMENT_CORRUPTED: Stored outbox attachment digest mismatch.',
        );
      }
      return {
        outboxId: row.outbox_id,
        ordinal: Number(row.ordinal),
        fileName: row.file_name,
        contentType: row.content_type,
        byteSize: Number(row.byte_size),
        sha256: row.sha256,
        contentBytes: bytes,
      };
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

  public async listAllNotificationPreferences(
    ctx: TenantContext,
  ): Promise<readonly UserNotificationPreference[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbNotificationPreferenceRow>(
        `SELECT *
           FROM public.user_notification_preferences
          WHERE tenant_id = $1
          ORDER BY person_id ASC, notification_kind ASC`,
        [ctx.tenantId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(
          ctx,
          row.tenant_id,
          'UserNotificationPreference',
        );
        return mapPreferenceRow(row);
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

  public async enqueueTeamsActivity(
    ctx: TenantContext,
    input: EnqueueTeamsActivityOutboxInput,
    options?: { readonly auditEntries?: readonly FirmAuditEntryInput[] },
  ): Promise<EnqueueTeamsActivityOutboxResult> {
    const idempotencyKey =
      input.idempotencyKey?.trim() || `auto:${randomUUID()}`;
    const recipientPersonId = input.recipientPersonId.trim();
    const activityType = input.activityType.trim();
    const previewText = input.previewText.trim();
    const deepLinkPath = input.deepLinkPath.trim();
    if (!recipientPersonId || !activityType || !previewText || !deepLinkPath) {
      throw new Error(
        'TEAMS_OUTBOX_INVALID: recipientPersonId, activityType, previewText, and deepLinkPath are required.',
      );
    }

    return this.withTenantTransaction(ctx, async (tx) => {
      const existingRes = await tx.query<DbTeamsOutboxRow>(
        `SELECT *
           FROM public.teams_activity_outbox
          WHERE tenant_id = $1
            AND idempotency_key = $2
          LIMIT 1`,
        [ctx.tenantId, idempotencyKey],
      );
      if (existingRes.rows[0]) {
        this.assertRowTenant(ctx, existingRes.rows[0].tenant_id, 'TeamsActivityOutbox');
        return {
          record: mapTeamsOutboxRow(existingRes.rows[0]),
          deduplicated: true,
        };
      }

      const seqRes = await tx.query<{ seq: string }>(
        `SELECT nextval('public.tenant_teams_outbox_id_seq')::text AS seq`,
      );
      const id = `TOB-${String(seqRes.rows[0]?.seq ?? '1').padStart(6, '0')}`;
      const nowIso = new Date().toISOString();
      const nextAttemptAt = input.nextAttemptAt?.trim() || nowIso;
      const correlationId = input.correlationId?.trim() || ctx.correlationId;

      const insertRes = await tx.query<DbTeamsOutboxRow>(
        `INSERT INTO public.teams_activity_outbox (
           tenant_id, id, idempotency_key, recipient_person_id, entra_object_id,
           activity_type, preview_text, template_parameters_json, deep_link_path,
           correlation_id, status, attempt_count, next_attempt_at, claimed_at,
           claim_token, sent_at, provider_request_id, last_error_code,
           content_scrubbed_at, created_by_person_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8::jsonb, $9,
           $10, 'pending', 0, $11::timestamptz, NULL,
           NULL, NULL, NULL, NULL,
           NULL, $12, $13::timestamptz, $13::timestamptz
         )
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          ctx.tenantId,
          id,
          idempotencyKey,
          recipientPersonId,
          input.entraObjectId?.trim() || null,
          activityType,
          previewText,
          JSON.stringify(input.templateParameters ?? []),
          deepLinkPath,
          correlationId,
          nextAttemptAt,
          input.createdByPersonId ?? null,
          nowIso,
        ],
      );

      if (!insertRes.rows[0]) {
        const winnerRes = await tx.query<DbTeamsOutboxRow>(
          `SELECT *
             FROM public.teams_activity_outbox
            WHERE tenant_id = $1
              AND idempotency_key = $2
            LIMIT 1`,
          [ctx.tenantId, idempotencyKey],
        );
        const winner = winnerRes.rows[0]!;
        this.assertRowTenant(ctx, winner.tenant_id, 'TeamsActivityOutbox');
        return {
          record: mapTeamsOutboxRow(winner),
          deduplicated: true,
        };
      }

      const inserted = insertRes.rows[0];
      this.assertRowTenant(ctx, inserted.tenant_id, 'TeamsActivityOutbox');
      if (options?.auditEntries && options.auditEntries.length > 0) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      return {
        record: mapTeamsOutboxRow(inserted),
        deduplicated: false,
      };
    });
  }

  public async claimDueTeamsOutboxBatch(
    ctx: TenantContext,
    options?: {
      readonly limit?: number;
      readonly now?: Date;
      readonly claimToken?: string;
      readonly reclaimStaleBeforeMinutes?: number;
    },
  ): Promise<readonly TeamsActivityOutboxRecord[]> {
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
      const res = await tx.query<DbTeamsOutboxRow>(
        `WITH due AS (
           SELECT tenant_id, id
             FROM public.teams_activity_outbox
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
         UPDATE public.teams_activity_outbox o
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
        this.assertRowTenant(ctx, row.tenant_id, 'TeamsActivityOutbox');
        return mapTeamsOutboxRow(row);
      });
      records.sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      );
      return records;
    });
  }

  public async markTeamsOutboxSent(
    ctx: TenantContext,
    params: {
      readonly id: string;
      readonly claimToken: string;
      readonly entraObjectId?: string | null;
      readonly providerRequestId?: string | null;
      readonly sentAt?: Date;
      readonly auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<{ readonly updated: boolean; readonly record: TeamsActivityOutboxRecord | null }> {
    const nowIso = (params.sentAt ?? new Date()).toISOString();
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbTeamsOutboxRow>(
        `UPDATE public.teams_activity_outbox
            SET status = 'sent',
                attempt_count = attempt_count + 1,
                entra_object_id = COALESCE($5, entra_object_id),
                sent_at = $4::timestamptz,
                claimed_at = NULL,
                claim_token = NULL,
                provider_request_id = $6,
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
          params.entraObjectId ?? null,
          params.providerRequestId ?? null,
        ],
      );
      const row = res.rows[0];
      if (!row) {
        return { updated: false, record: null };
      }
      this.assertRowTenant(ctx, row.tenant_id, 'TeamsActivityOutbox');
      if (params.auditEntries && params.auditEntries.length > 0) {
        await this.auditRepo.appendAuditEntries(ctx, params.auditEntries);
      }
      return { updated: true, record: mapTeamsOutboxRow(row) };
    });
  }

  private async markTeamsOutboxDropped(
    ctx: TenantContext,
    status: 'dropped_allowlist' | 'dropped_unbound',
    defaultErrorCode: string,
    params: {
      readonly id: string;
      readonly claimToken: string;
      readonly entraObjectId?: string | null;
      readonly reasonCode?: string;
      readonly droppedAt?: Date;
      readonly auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<{ readonly updated: boolean; readonly record: TeamsActivityOutboxRecord | null }> {
    const nowIso = (params.droppedAt ?? new Date()).toISOString();
    const errorCode = params.reasonCode?.trim() || defaultErrorCode;
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<DbTeamsOutboxRow>(
        `UPDATE public.teams_activity_outbox
            SET status = $5,
                attempt_count = attempt_count + 1,
                entra_object_id = COALESCE($7, entra_object_id),
                claimed_at = NULL,
                claim_token = NULL,
                last_error_code = $6,
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
          status,
          errorCode,
          params.entraObjectId ?? null,
        ],
      );
      const row = res.rows[0];
      if (!row) {
        return { updated: false, record: null };
      }
      this.assertRowTenant(ctx, row.tenant_id, 'TeamsActivityOutbox');
      if (params.auditEntries && params.auditEntries.length > 0) {
        await this.auditRepo.appendAuditEntries(ctx, params.auditEntries);
      }
      return { updated: true, record: mapTeamsOutboxRow(row) };
    });
  }

  public async markTeamsOutboxDroppedAllowlist(
    ctx: TenantContext,
    params: {
      readonly id: string;
      readonly claimToken: string;
      readonly entraObjectId?: string | null;
      readonly reasonCode?: string;
      readonly droppedAt?: Date;
      readonly auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<{ readonly updated: boolean; readonly record: TeamsActivityOutboxRecord | null }> {
    return this.markTeamsOutboxDropped(
      ctx,
      'dropped_allowlist',
      'TEAMS_ALLOWLIST_BLOCKED',
      params,
    );
  }

  public async markTeamsOutboxDroppedUnbound(
    ctx: TenantContext,
    params: {
      readonly id: string;
      readonly claimToken: string;
      readonly reasonCode?: string;
      readonly droppedAt?: Date;
      readonly auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<{ readonly updated: boolean; readonly record: TeamsActivityOutboxRecord | null }> {
    return this.markTeamsOutboxDropped(
      ctx,
      'dropped_unbound',
      'TEAMS_RECIPIENT_UNBOUND',
      params,
    );
  }

  public async markTeamsOutboxAttemptFailed(
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
    readonly record: TeamsActivityOutboxRecord | null;
  }> {
    const now = params.failedAt ?? new Date();
    const nowIso = now.toISOString();

    return this.withTenantTransaction(ctx, async (tx) => {
      const currentRes = await tx.query<DbTeamsOutboxRow>(
        `SELECT *
           FROM public.teams_activity_outbox
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
          errorCode: computeAttemptFailurePlan({
            currentAttemptCount: 0,
            error: params.error,
            maxAttempts: params.maxAttempts,
            baseBackoffSeconds: params.baseBackoffSeconds,
            now,
          }).errorCode,
          record: null,
        };
      }
      this.assertRowTenant(ctx, current.tenant_id, 'TeamsActivityOutbox');

      const plan = computeAttemptFailurePlan({
        currentAttemptCount: Number(current.attempt_count ?? 0),
        error: params.error,
        maxAttempts: params.maxAttempts,
        baseBackoffSeconds: params.baseBackoffSeconds,
        now,
      });

      if (plan.permanentFailure) {
        const permRes = await tx.query<DbTeamsOutboxRow>(
          `UPDATE public.teams_activity_outbox
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
            plan.nextAttemptCount,
            plan.errorCode,
            nowIso,
          ],
        );
        const updatedRow = permRes.rows[0]!;
        this.assertRowTenant(ctx, updatedRow.tenant_id, 'TeamsActivityOutbox');
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
          errorCode: plan.errorCode,
          record: mapTeamsOutboxRow(updatedRow),
        };
      }

      const retryRes = await tx.query<DbTeamsOutboxRow>(
        `UPDATE public.teams_activity_outbox
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
          plan.nextAttemptCount,
          plan.nextAttemptAtIso,
          plan.errorCode,
          nowIso,
        ],
      );
      const updatedRow = retryRes.rows[0]!;
      this.assertRowTenant(ctx, updatedRow.tenant_id, 'TeamsActivityOutbox');
      return {
        updated: true,
        permanentFailure: false,
        errorCode: plan.errorCode,
        record: mapTeamsOutboxRow(updatedRow),
      };
    });
  }

  public async scrubExpiredTeamsOutboxContent(
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
    const lockKey = `onesquared_teams_outbox_scrub:${ctx.tenantId}`;

    return this.withTenantTransaction(ctx, async (tx) => {
      const lockRes = await tx.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
        [lockKey],
      );
      if (!lockRes.rows[0]?.acquired) {
        return { lockAcquired: false, scrubbedCount: 0 };
      }

      const scrubRes = await tx.query<{ tenant_id: string; id: string }>(
        `UPDATE public.teams_activity_outbox
            SET preview_text = NULL,
                template_parameters_json = '[]'::jsonb,
                entra_object_id = NULL,
                content_scrubbed_at = $2::timestamptz,
                updated_at = $2::timestamptz
          WHERE tenant_id = $1
            AND content_scrubbed_at IS NULL
            AND status IN ('sent', 'dropped_allowlist', 'dropped_unbound', 'failed_permanent')
            AND COALESCE(sent_at, updated_at, created_at) <= $3::timestamptz
         RETURNING tenant_id, id`,
        [ctx.tenantId, nowIso, cutoffIso],
      );

      for (const row of scrubRes.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'TeamsActivityOutbox');
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

  public async getTeamsOutboxRecordById(
    ctx: TenantContext,
    id: string,
  ): Promise<TeamsActivityOutboxRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbTeamsOutboxRow>(
        `SELECT *
           FROM public.teams_activity_outbox
          WHERE tenant_id = $1
            AND id = $2
          LIMIT 1`,
        [ctx.tenantId, id],
      );
      const row = res.rows[0];
      if (!row) {
        return null;
      }
      this.assertRowTenant(ctx, row.tenant_id, 'TeamsActivityOutbox');
      return mapTeamsOutboxRow(row);
    });
  }

  public async listTeamsOutboxRecords(
    ctx: TenantContext,
    filter?: {
      readonly status?: TeamsActivityOutboxStatus;
      readonly limit?: number;
    },
  ): Promise<readonly TeamsActivityOutboxRecord[]> {
    const limit = Math.max(1, Math.min(200, Math.floor(filter?.limit ?? 100)));
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const params: unknown[] = [ctx.tenantId];
      let where = 'tenant_id = $1';
      if (filter?.status) {
        params.push(filter.status);
        where += ` AND status = $${params.length}`;
      }
      params.push(limit);
      const res = await tx.query<DbTeamsOutboxRow>(
        `SELECT *
           FROM public.teams_activity_outbox
          WHERE ${where}
          ORDER BY created_at ASC, id ASC
          LIMIT $${params.length}`,
        params,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'TeamsActivityOutbox');
        return mapTeamsOutboxRow(row);
      });
    });
  }

  public async countAllTenantTeamsOutboxRows(ctx: TenantContext): Promise<number> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.teams_activity_outbox WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
      return Number(res.rows[0]?.count ?? 0);
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
        `DELETE FROM public.teams_activity_outbox WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
      await tx.query(
        `DELETE FROM public.user_notification_preferences WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
    });
  }
}
