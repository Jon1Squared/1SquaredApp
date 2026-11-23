/**
 * Tenant Email Outbox Drainer & Content Retention Scrubber
 * (`core/src/integrations/email/outboxDrain.ts`).
 *
 * Implements the ADR 0030 high-frequency outbox drain variant defined in
 * ADR 0027 §6.4:
 * - Bypasses the daily once-per-day `job_runs` gate used by daily calendar jobs.
 * - Claims due outbox rows in short `FOR UPDATE SKIP LOCKED` lease transactions
 *   (reclaiming stale `'sending'` leases older than 5 minutes).
 * - Dispatches each claimed row through `CoreEmailDispatcher` (`EmailSender`).
 * - Transitions terminal rows (`'sent'`, `'dropped_allowlist'`), retries failures
 *   with exponential backoff up to `maxAttempts` (`5`), and emits an `error`-severity
 *   `outbox.delivery.failed_permanent` telemetry exception + zero-PII audit entry
 *   upon permanent failure.
 * - Runs per-tenant advisory-locked content scrubbing past `outboxContentRetentionDays`
 *   (`default: 30`), setting `content_scrubbed_at` and clearing bodies and recipient
 *   addresses.
 */

import type {
  DocumentStorageProvider,
  EmailProviderId,
  EmailSender,
  FirmAuditEntryInput,
  TenantConfiguration,
  TenantContext,
  TenantEmailIntegrationConfig,
} from '../../api/index';
import {
  emitTenantTelemetryEvent,
  emitTenantTelemetryException,
} from '../../observability/telemetry';
import {
  DEFAULT_OUTBOX_BASE_BACKOFF_SECONDS,
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  DEFAULT_OUTBOX_RETENTION_DAYS,
  TenantOutboxRepository,
} from '../../tenancy/outboxRepository';
import { CoreEmailDispatcher, resolveEmailIntegrationConfig } from './adapters';
import type { GraphAppTokenProvider } from './graphAppTokenProvider';
import type { FetchLike, KeyVaultSecretReader } from './keyVaultSecretReader';
import type { TeamsNotifier } from '../../api/index';
import type { TeamsDevCatcherHandler } from '../teams/adapters';
import {
  drainTeamsOutboxForTenant,
  type TeamsOutboxDrainResult,
} from '../teams/outboxDrain';

export interface OutboxDrainResult {
  readonly tenantId: string;
  readonly provider: EmailProviderId;
  readonly skippedDisabled: boolean;
  readonly claimedCount: number;
  readonly sentCount: number;
  readonly droppedAllowlistCount: number;
  readonly retriedCount: number;
  readonly failedPermanentCount: number;
  readonly scrubbedCount: number;
}

export async function drainEmailOutboxForTenant(
  ctx: TenantContext,
  options: {
    readonly tenantConfig: TenantConfiguration;
    readonly outboxRepository?: TenantOutboxRepository;
    readonly emailSender?: EmailSender;
    readonly secretReader?: KeyVaultSecretReader;
    readonly graphTokenProvider?: GraphAppTokenProvider;
    readonly storageProvider?: DocumentStorageProvider;
    readonly fetchFn?: FetchLike;
    readonly actorId?: string;
    readonly batchSize?: number;
    readonly maxAttempts?: number;
    readonly baseBackoffSeconds?: number;
    readonly now?: Date;
  },
): Promise<OutboxDrainResult> {
  const email: TenantEmailIntegrationConfig = resolveEmailIntegrationConfig(
    options.tenantConfig,
  );
  const provider = email.provider ?? 'disabled';
  const retentionDays =
    email.outboxContentRetentionDays ?? DEFAULT_OUTBOX_RETENTION_DAYS;
  const outboxRepo = options.outboxRepository ?? new TenantOutboxRepository();
  const now = options.now ?? new Date();
  const actorId = options.actorId?.trim() || 'system:outbox-drain';

  let claimedCount = 0;
  let sentCount = 0;
  let droppedAllowlistCount = 0;
  let retriedCount = 0;
  let failedPermanentCount = 0;
  let skippedDisabled = false;

  if (provider === 'disabled') {
    skippedDisabled = true;
  } else {
    const sender =
      options.emailSender ??
      new CoreEmailDispatcher({
        emailConfig: email,
        secretReader: options.secretReader,
        graphTokenProvider: options.graphTokenProvider,
        storageProvider: options.storageProvider,
        fetchFn: options.fetchFn,
      });

    const batch = await outboxRepo.claimDueOutboxBatch(ctx, {
      limit: options.batchSize ?? 25,
      now,
    });
    claimedCount = batch.length;

    const maxAttempts = options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS;
    const baseBackoffSeconds =
      options.baseBackoffSeconds ?? DEFAULT_OUTBOX_BASE_BACKOFF_SECONDS;

    for (const row of batch) {
      if (
        !row.claimToken ||
        row.subject === null ||
        row.htmlBody === null ||
        row.textBody === null
      ) {
        continue;
      }

      const recipientCount =
        row.recipients.to.length +
        (row.recipients.cc?.length ?? 0) +
        (row.recipients.bcc?.length ?? 0);

      try {
        const outboxEntries = row.attachments.filter(
          (att): att is import('../../api/index').EmailOutboxAttachmentMetadata =>
            'source' in att && att.source === 'outbox',
        );
        const claimedInline =
          outboxEntries.length > 0
            ? await outboxRepo.getClaimedOutboxAttachmentBytes(ctx, {
                outboxId: row.id,
                claimToken: row.claimToken,
              })
            : [];
        if (
          outboxEntries.length > 0 &&
          claimedInline.length !== outboxEntries.length
        ) {
          throw new Error(
            'EMAIL_OUTBOX_ATTACHMENT_MISSING: Expected outbox-held attachment bytes were missing for claimed message.',
          );
        }
        const claimedByOrdinal = new Map(
          claimedInline.map((item) => [item.ordinal, item]),
        );
        const dispatchAttachments: import('../../api/index').OutgoingEmailAttachment[] =
          row.attachments.map((att) => {
            if ('source' in att && att.source === 'outbox') {
              const matched = claimedByOrdinal.get(att.ordinal);
              if (!matched) {
                throw new Error(
                  'EMAIL_OUTBOX_ATTACHMENT_MISSING: Expected outbox-held attachment bytes were missing for claimed message.',
                );
              }
              if (att.sha256 && matched.sha256 && att.sha256 !== matched.sha256) {
                throw new Error(
                  'EMAIL_OUTBOX_ATTACHMENT_CORRUPTED: Outbox attachment metadata digest does not match stored attachment bytes.',
                );
              }
              return matched;
            }
            return att as import('../../api/index').EmailAttachmentRef;
          });

        const result = await sender.send(ctx, {
          idempotencyKey: row.idempotencyKey,
          templateKey: row.templateKey,
          recipients: row.recipients,
          subject: row.subject,
          htmlBody: row.htmlBody,
          textBody: row.textBody,
          attachments: dispatchAttachments,
          createdByPersonId: row.createdByPersonId,
        });

        if (result.status === 'sent') {
          const sentRes = await outboxRepo.markOutboxSent(ctx, {
            id: row.id,
            claimToken: row.claimToken,
            providerMessageId: result.providerMessageId ?? null,
            sentAt: now,
            auditEntries: [
              {
                recordType: 'email_outbox',
                recordId: row.id,
                action: 'email-sent',
                field: 'status',
                oldValue: 'sending',
                newValue: `sent:${result.provider}`,
                byId: actorId,
                at: now.toISOString(),
                reason: `Delivered outbox item ${row.id} via ${result.provider} (template=${row.templateKey}, recipients=${recipientCount}).`,
              },
            ],
          });
          if (sentRes.updated) {
            sentCount += 1;
            emitTenantTelemetryEvent({
              eventName: 'outbox.delivery.sent',
              tenantId: ctx.tenantId,
              correlationId: row.correlationId,
              properties: {
                outboxId: row.id,
                templateKey: row.templateKey,
                provider: result.provider,
                recipientCount,
              },
            });
          }
          continue;
        }

        if (result.status === 'dropped_allowlist') {
          const dropRes = await outboxRepo.markOutboxDroppedAllowlist(ctx, {
            id: row.id,
            claimToken: row.claimToken,
            reasonCode: result.errorCode ?? 'EMAIL_ALLOWLIST_BLOCKED',
            droppedAt: now,
            auditEntries: [
              {
                recordType: 'email_outbox',
                recordId: row.id,
                action: 'email-dropped-allowlist',
                field: 'status',
                oldValue: 'sending',
                newValue: 'dropped_allowlist',
                byId: actorId,
                at: now.toISOString(),
                reason: `Blocked non-live outbox delivery ${row.id} against recipient allow-list (template=${row.templateKey}, blockedCount=${result.blockedRecipients?.length ?? 0}).`,
              },
            ],
          });
          if (dropRes.updated) {
            droppedAllowlistCount += 1;
            emitTenantTelemetryEvent({
              eventName: 'outbox.delivery.dropped_allowlist',
              severity: 'warn',
              tenantId: ctx.tenantId,
              correlationId: row.correlationId,
              properties: {
                outboxId: row.id,
                templateKey: row.templateKey,
                provider: result.provider,
                blockedCount: result.blockedRecipients?.length ?? 0,
              },
            });
          }
          continue;
        }

        // result.status === 'disabled' — provider disabled mid-flight; treat cleanly as skipped
        skippedDisabled = true;
      } catch (err) {
        const failRes = await outboxRepo.markOutboxAttemptFailed(ctx, {
          id: row.id,
          claimToken: row.claimToken,
          error: err,
          maxAttempts,
          baseBackoffSeconds,
          failedAt: now,
          auditEntriesOnPermanentFailure: [
            {
              recordType: 'email_outbox',
              recordId: row.id,
              action: 'email-send-failed-permanent',
              field: 'status',
              oldValue: 'sending',
              newValue: 'failed_permanent',
              byId: actorId,
              at: now.toISOString(),
              reason: `Permanent delivery failure for outbox item ${row.id} after ${maxAttempts} attempts (template=${row.templateKey}).`,
            },
          ],
        });

        if (failRes.updated) {
          if (failRes.permanentFailure) {
            failedPermanentCount += 1;
            emitTenantTelemetryException({
              eventName: 'outbox.delivery.failed_permanent',
              tenantId: ctx.tenantId,
              correlationId: row.correlationId,
              error: err,
              properties: {
                outboxId: row.id,
                templateKey: row.templateKey,
                provider,
                attemptCount: failRes.record?.attemptCount ?? maxAttempts,
                lastErrorCode: failRes.errorCode,
              },
            });
          } else {
            retriedCount += 1;
            emitTenantTelemetryEvent({
              eventName: 'outbox.delivery.retried',
              severity: 'warn',
              tenantId: ctx.tenantId,
              correlationId: row.correlationId,
              properties: {
                outboxId: row.id,
                templateKey: row.templateKey,
                provider,
                attemptCount: failRes.record?.attemptCount ?? 1,
                lastErrorCode: failRes.errorCode,
              },
            });
          }
        }
      }
    }
  }

  const scrubRes = await outboxRepo.scrubExpiredOutboxContent(ctx, {
    retentionDays,
    now,
    auditEntriesFactory: (scrubbedCount, atIso): readonly FirmAuditEntryInput[] => [
      {
        recordType: 'email_outbox',
        recordId: 'EMAIL-OUTBOX-RETENTION',
        action: 'email-outbox-content-scrubbed',
        field: 'content_scrubbed_at',
        oldValue: null,
        newValue: `scrubbed=${scrubbedCount}; retentionDays=${retentionDays}`,
        byId: actorId,
        at: atIso,
        reason: `Scrubbed expired email outbox content past ${retentionDays} days.`,
      },
    ],
  });

  if (scrubRes.scrubbedCount > 0) {
    emitTenantTelemetryEvent({
      eventName: 'outbox.retention.scrubbed',
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      properties: {
        scrubbedCount: scrubRes.scrubbedCount,
        retentionDays,
      },
    });
  }

  emitTenantTelemetryEvent({
    eventName: 'outbox.drain.completed',
    tenantId: ctx.tenantId,
    correlationId: ctx.correlationId,
    properties: {
      provider,
      skippedDisabled,
      claimedCount,
      sentCount,
      droppedAllowlistCount,
      retriedCount,
      failedPermanentCount,
      scrubbedCount: scrubRes.scrubbedCount,
    },
  });

  return {
    tenantId: ctx.tenantId,
    provider,
    skippedDisabled,
    claimedCount,
    sentCount,
    droppedAllowlistCount,
    retriedCount,
    failedPermanentCount,
    scrubbedCount: scrubRes.scrubbedCount,
  };
}

export interface CombinedOutboxDrainResult extends OutboxDrainResult {
  readonly teams: TeamsOutboxDrainResult;
}

/**
 * Shared `outbox-drain` entry point draining both `public.email_outbox`
 * and `public.teams_activity_outbox` for a tenant (ADR 0027 / ADR 0035 §3.1).
 */
export async function drainOutboxForTenant(
  ctx: TenantContext,
  options: {
    readonly tenantConfig: TenantConfiguration;
    readonly outboxRepository?: TenantOutboxRepository;
    readonly emailSender?: EmailSender;
    readonly teamsNotifier?: TeamsNotifier;
    readonly secretReader?: KeyVaultSecretReader;
    readonly graphTokenProvider?: GraphAppTokenProvider;
    readonly storageProvider?: DocumentStorageProvider;
    readonly fetchFn?: FetchLike;
    readonly teamsDevCatcherHandler?: TeamsDevCatcherHandler;
    readonly actorId?: string;
    readonly batchSize?: number;
    readonly maxAttempts?: number;
    readonly baseBackoffSeconds?: number;
    readonly now?: Date;
  },
): Promise<CombinedOutboxDrainResult> {
  const [emailRes, teamsRes] = await Promise.all([
    drainEmailOutboxForTenant(ctx, options),
    drainTeamsOutboxForTenant(ctx, {
      tenantConfig: options.tenantConfig,
      outboxRepository: options.outboxRepository,
      teamsNotifier: options.teamsNotifier,
      secretReader: options.secretReader,
      graphTokenProvider: options.graphTokenProvider,
      fetchFn: options.fetchFn,
      devCatcherHandler: options.teamsDevCatcherHandler,
      actorId: options.actorId,
      batchSize: options.batchSize,
      maxAttempts: options.maxAttempts,
      baseBackoffSeconds: options.baseBackoffSeconds,
      now: options.now,
    }),
  ]);

  return {
    ...emailRes,
    skippedDisabled: emailRes.skippedDisabled && teamsRes.skippedDisabled,
    teams: teamsRes,
  };
}
