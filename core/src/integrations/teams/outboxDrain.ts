/**
 * Tenant-Scoped Teams Activity Outbox Drainer & Content Retention Scrubber
 * (`core/src/integrations/teams/outboxDrain.ts`).
 *
 * Mirrors `drainEmailOutboxForTenant` (ADR 0027 / ADR 0035):
 * - Claims due `public.teams_activity_outbox` batches with `FOR UPDATE SKIP LOCKED`
 *   and lease tokens (`claim_token`).
 * - Dispatches through `TeamsNotifier` (`CoreTeamsNotifier` or injected adapter).
 * - Handles `sent`, `dropped_unbound`, `dropped_allowlist` (zero-PII audit),
 *   transient exponential-backoff retry, and terminal `failed_permanent`
 *   (`outbox.delivery.failed_permanent` telemetry exception with `channel: 'teams'`).
 * - Scrubs `preview_text` and `template_parameters_json` past `outboxContentRetentionDays`.
 */

import type {
  FirmAuditEntryInput,
  TeamsIntegrationProviderId,
  TeamsNotifier,
  TenantConfiguration,
  TenantContext,
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
import { resolveEmailIntegrationConfig } from '../email/adapters';
import type { GraphAppTokenProvider } from '../email/graphAppTokenProvider';
import type { FetchLike, KeyVaultSecretReader } from '../email/keyVaultSecretReader';
import {
  CoreTeamsNotifier,
  resolveTeamsIntegrationConfig,
  type SendTeamsActivityOptions,
  type TeamsDevCatcherHandler,
} from './adapters';

export interface TeamsOutboxDrainResult {
  readonly tenantId: string;
  readonly provider: TeamsIntegrationProviderId;
  readonly skippedDisabled: boolean;
  readonly claimedCount: number;
  readonly sentCount: number;
  readonly droppedAllowlistCount: number;
  readonly droppedUnboundCount: number;
  readonly retriedCount: number;
  readonly failedPermanentCount: number;
  readonly scrubbedCount: number;
}

export async function drainTeamsOutboxForTenant(
  ctx: TenantContext,
  options: {
    readonly tenantConfig: TenantConfiguration;
    readonly outboxRepository?: TenantOutboxRepository;
    readonly teamsNotifier?: TeamsNotifier;
    readonly secretReader?: KeyVaultSecretReader;
    readonly graphTokenProvider?: GraphAppTokenProvider;
    readonly fetchFn?: FetchLike;
    readonly devCatcherHandler?: TeamsDevCatcherHandler;
    readonly actorId?: string;
    readonly batchSize?: number;
    readonly maxAttempts?: number;
    readonly baseBackoffSeconds?: number;
    readonly now?: Date;
  },
): Promise<TeamsOutboxDrainResult> {
  const teamsCfg = resolveTeamsIntegrationConfig(options.tenantConfig);
  const emailCfg = resolveEmailIntegrationConfig(options.tenantConfig);
  const provider: TeamsIntegrationProviderId = teamsCfg.provider ?? 'disabled';
  const retentionDays =
    emailCfg.outboxContentRetentionDays ?? DEFAULT_OUTBOX_RETENTION_DAYS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS;
  const baseBackoffSeconds =
    options.baseBackoffSeconds ?? DEFAULT_OUTBOX_BASE_BACKOFF_SECONDS;
  const now = options.now ?? new Date();
  const actorId = options.actorId?.trim() || 'system:outbox-drain';
  const outboxRepo = options.outboxRepository ?? new TenantOutboxRepository();

  let skippedDisabled = false;
  let claimedCount = 0;
  let sentCount = 0;
  let droppedAllowlistCount = 0;
  let droppedUnboundCount = 0;
  let retriedCount = 0;
  let failedPermanentCount = 0;

  if (provider === 'disabled') {
    skippedDisabled = true;
  } else {
    const notifier: TeamsNotifier =
      options.teamsNotifier ??
      new CoreTeamsNotifier(options.tenantConfig, {
        secretReader: options.secretReader,
        tokenProvider: options.graphTokenProvider,
        fetchImpl: options.fetchFn,
        devCatcherHandler: options.devCatcherHandler,
      });

    const batch = await outboxRepo.claimDueTeamsOutboxBatch(ctx, {
      limit: options.batchSize ?? 20,
      now,
    });
    claimedCount = batch.length;

    for (const row of batch) {
      if (!row.claimToken) continue;

      try {
        const sendWithOptions = notifier.sendActivity as (
          c: TenantContext,
          a: {
            readonly idempotencyKey: string;
            readonly recipientPersonId: string;
            readonly activityType: string;
            readonly previewText: string;
            readonly templateParameters: typeof row.templateParameters;
            readonly deepLinkPath: string;
            readonly correlationId: string;
          },
          opts?: SendTeamsActivityOptions,
        ) => ReturnType<TeamsNotifier['sendActivity']>;

        const result = await sendWithOptions.call(
          notifier,
          ctx,
          {
            idempotencyKey: row.idempotencyKey,
            recipientPersonId: row.recipientPersonId,
            activityType: row.activityType,
            previewText: row.previewText ?? '',
            templateParameters: row.templateParameters,
            deepLinkPath: row.deepLinkPath,
            correlationId: row.correlationId,
          },
          { skipDropAudit: true, outboxRecordId: row.id },
        );

        const resolvedOid =
          (result as { readonly entraObjectId?: string }).entraObjectId ?? null;

        if (result.outcome === 'sent') {
          const marked = await outboxRepo.markTeamsOutboxSent(ctx, {
            id: row.id,
            claimToken: row.claimToken,
            entraObjectId: resolvedOid,
            providerRequestId: result.providerRequestId ?? null,
            sentAt: now,
          });
          if (marked.updated) {
            sentCount += 1;
          }
          continue;
        }

        if (result.outcome === 'dropped_unbound') {
          const marked = await outboxRepo.markTeamsOutboxDroppedUnbound(ctx, {
            id: row.id,
            claimToken: row.claimToken,
            reasonCode: 'TEAMS_RECIPIENT_UNBOUND',
            droppedAt: now,
            auditEntries: [
              {
                recordType: 'teams_activity_outbox',
                recordId: row.id,
                action: 'teams-notification-dropped-unbound',
                field: 'entraObjectId',
                oldValue: null,
                newValue: 'dropped_unbound',
                byId: actorId,
                at: now.toISOString(),
                reason: `Teams Activity outbox ${row.id} dropped because recipient ${row.recipientPersonId} has no bound Entra object ID.`,
              },
            ],
          });
          if (marked.updated) {
            droppedUnboundCount += 1;
          }
          continue;
        }

        // dropped_not_allow_listed
        const dropRes = await outboxRepo.markTeamsOutboxDroppedAllowlist(ctx, {
          id: row.id,
          claimToken: row.claimToken,
          entraObjectId: resolvedOid,
          reasonCode: result.reason,
          droppedAt: now,
          auditEntries: [
            {
              recordType: 'teams_activity_outbox',
              recordId: row.id,
              action: 'teams-notification-dropped-allowlist',
              field: 'allowList',
              oldValue: null,
              newValue: result.reason,
              byId: actorId,
              at: now.toISOString(),
              reason: `Non-live allow-list blocked Teams Activity delivery for outbox ${row.id} (${result.reason}).`,
            },
          ],
        });
        if (dropRes.updated) {
          droppedAllowlistCount += 1;
          emitTenantTelemetryEvent({
            eventName: 'outbox.delivery.dropped_allowlist',
            tenantId: ctx.tenantId,
            correlationId: row.correlationId,
            properties: {
              channel: 'teams',
              outboxId: row.id,
              reason: result.reason,
            },
          });
        }
      } catch (err) {
        const failRes = await outboxRepo.markTeamsOutboxAttemptFailed(ctx, {
          id: row.id,
          claimToken: row.claimToken,
          error: err,
          maxAttempts,
          baseBackoffSeconds,
          failedAt: now,
          auditEntriesOnPermanentFailure: [
            {
              recordType: 'teams_activity_outbox',
              recordId: row.id,
              action: 'teams-send-failed-permanent',
              field: 'status',
              oldValue: 'sending',
              newValue: 'failed_permanent',
              byId: actorId,
              at: now.toISOString(),
              reason: `Permanent Teams delivery failure for outbox item ${row.id} after ${maxAttempts} attempts (activityType=${row.activityType}).`,
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
                channel: 'teams',
                outboxId: row.id,
                activityType: row.activityType,
                attemptCount: failRes.record?.attemptCount ?? maxAttempts,
                errorCode: failRes.errorCode,
              },
            });
          } else {
            retriedCount += 1;
          }
        }
      }
    }
  }

  const scrubRes = await outboxRepo.scrubExpiredTeamsOutboxContent(ctx, {
    retentionDays,
    now,
    auditEntriesFactory: (scrubbedCount, atIso): readonly FirmAuditEntryInput[] => [
      {
        recordType: 'teams_activity_outbox',
        recordId: 'TEAMS-OUTBOX-RETENTION',
        action: 'teams-outbox-content-scrubbed',
        field: 'content_scrubbed_at',
        oldValue: null,
        newValue: `scrubbed=${scrubbedCount}; retentionDays=${retentionDays}`,
        byId: actorId,
        at: atIso,
        reason: `Scrubbed expired Teams Activity outbox content past ${retentionDays} days.`,
      },
    ],
  });

  if (scrubRes.scrubbedCount > 0) {
    emitTenantTelemetryEvent({
      eventName: 'outbox.retention.scrubbed',
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      properties: {
        channel: 'teams',
        scrubbedCount: scrubRes.scrubbedCount,
        retentionDays,
      },
    });
  }

  return {
    tenantId: ctx.tenantId,
    provider,
    skippedDisabled,
    claimedCount,
    sentCount,
    droppedAllowlistCount,
    droppedUnboundCount,
    retriedCount,
    failedPermanentCount,
    scrubbedCount: scrubRes.scrubbedCount,
  };
}
