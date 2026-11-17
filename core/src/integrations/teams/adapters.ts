/**
 * Microsoft Teams Activity Transport Adapters & `CoreTeamsNotifier`
 * (`core/src/integrations/teams/adapters.ts`).
 *
 * Implements ADR 0035 §3.1:
 * - Three configured modes: `disabled` (safe no-op / fail-closed send),
 *   `dev_catcher` (local HTTP endpoint catcher in non-live environments), and
 *   `graph` (Microsoft Graph application-only certificate auth via
 *   `GraphAppTokenProvider` calling
 *   `POST https://graph.microsoft.com/v1.0/users/{entraObjectId}/teamwork/sendActivityNotification`).
 * - Always resolves `entraObjectId` from PostgreSQL (`TenantPartyRepository`),
 *   enforces content scrubbing (`sanitizeTeamsActivityPayload`), and applies the
 *   fail-closed non-live allow-list (`evaluateTeamsRecipientAllowList`).
 */

import type {
  OutgoingTeamsActivity,
  TeamsNotifier,
  TeamsSendResult,
  TenantConfiguration,
  TenantContext,
  TenantTeamsIntegrationConfig,
} from '../../api/index';
import { TenantAuditRepository } from '../../tenancy/auditRepository';
import { TenantPartyRepository } from '../../tenancy/partyRepository';
import {
  GRAPH_MAIL_DEFAULT_SCOPE,
  GraphAppTokenProvider,
} from '../email/graphAppTokenProvider';
import type {
  FetchLike,
  KeyVaultSecretReader,
} from '../email/keyVaultSecretReader';
import { evaluateTeamsRecipientAllowList } from './allowList';
import { TeamsIntegrationError } from './errors';
import {
  SAFE_TEAMS_ACTIVITY_TYPE_BY_KIND,
  sanitizeTeamsActivityPayload,
} from './scrubber';

const BUILT_IN_ACTOR_ONLY_ACTIVITY_TYPES: ReadonlySet<string> = new Set(
  Object.values(SAFE_TEAMS_ACTIVITY_TYPE_BY_KIND),
);

export interface TeamsDevCatcherPayload {
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly recipientPersonId: string;
  readonly entraObjectId: string;
  readonly teamsAppId: string | null;
  readonly activityType: string;
  readonly previewText: string;
  readonly templateParameters: OutgoingTeamsActivity['templateParameters'];
  readonly deepLinkPath: string;
  readonly correlationId: string;
}

export type TeamsDevCatcherHandler = (
  payload: TeamsDevCatcherPayload,
) => Promise<{ readonly requestId?: string } | void>;

export interface CoreTeamsNotifierOptions {
  readonly getTeamsConfig?: (ctx: TenantContext) => TenantTeamsIntegrationConfig;
  readonly partyRepository?: TenantPartyRepository;
  readonly secretReader?: KeyVaultSecretReader;
  readonly tokenProvider?: GraphAppTokenProvider;
  readonly auditRepository?: TenantAuditRepository;
  readonly fetchImpl?: FetchLike;
  readonly devCatcherHandler?: TeamsDevCatcherHandler;
}

export interface SendTeamsActivityOptions {
  readonly skipDropAudit?: boolean;
  readonly outboxRecordId?: string;
}

export function resolveTeamsIntegrationConfig(
  tenantConfig: TenantConfiguration,
): TenantTeamsIntegrationConfig {
  const teams = tenantConfig.integrations?.teams;
  return {
    provider: teams?.provider ?? 'disabled',
    ...(teams?.teamsAppId ? { teamsAppId: teams.teamsAppId } : {}),
    ...(teams?.recipientAllowList
      ? { recipientAllowList: teams.recipientAllowList }
      : {}),
    ...(teams?.recipientAllowListVaultRef
      ? { recipientAllowListVaultRef: teams.recipientAllowListVaultRef }
      : {}),
    ...(teams?.devCatcher ? { devCatcher: teams.devCatcher } : {}),
    ...(teams?.graph ? { graph: teams.graph } : {}),
  };
}

function buildTeamsTopicWebUrl(
  teamsAppId: string | undefined,
  deepLinkPath: string,
): string {
  const trimmedAppId = teamsAppId?.trim();
  if (trimmedAppId) {
    const context = encodeURIComponent(
      JSON.stringify({ subEntityId: deepLinkPath }),
    );
    return `https://teams.microsoft.com/l/entity/${encodeURIComponent(trimmedAppId)}/home?context=${context}`;
  }
  return `https://teams.microsoft.com/l/app?context=${encodeURIComponent(JSON.stringify({ subEntityId: deepLinkPath }))}`;
}

export class CoreTeamsNotifier implements TeamsNotifier {
  private readonly getTeamsConfig: (
    ctx: TenantContext,
  ) => TenantTeamsIntegrationConfig;
  private readonly partyRepository: TenantPartyRepository;
  private readonly secretReader?: KeyVaultSecretReader;
  private readonly tokenProvider: GraphAppTokenProvider;
  private readonly auditRepository: TenantAuditRepository;
  private readonly fetchImpl: FetchLike;
  private readonly devCatcherHandler?: TeamsDevCatcherHandler;

  public constructor(
    configOrResolver:
      | TenantConfiguration
      | ((ctx: TenantContext) => TenantConfiguration | TenantTeamsIntegrationConfig),
    options?: CoreTeamsNotifierOptions,
  ) {
    if (options?.getTeamsConfig) {
      this.getTeamsConfig = options.getTeamsConfig;
    } else if (typeof configOrResolver === 'function') {
      this.getTeamsConfig = (ctx) => {
        const resolved = configOrResolver(ctx);
        if (resolved && typeof resolved === 'object' && 'integrations' in resolved) {
          return resolveTeamsIntegrationConfig(resolved as TenantConfiguration);
        }
        return resolved as TenantTeamsIntegrationConfig;
      };
    } else {
      const staticTeams = resolveTeamsIntegrationConfig(configOrResolver);
      this.getTeamsConfig = () => staticTeams;
    }

    this.partyRepository =
      options?.partyRepository ?? new TenantPartyRepository();
    this.secretReader = options?.secretReader;
    this.tokenProvider =
      options?.tokenProvider ??
      new GraphAppTokenProvider({
        secretReader: options?.secretReader,
        fetchFn: options?.fetchImpl,
      });
    this.auditRepository =
      options?.auditRepository ?? new TenantAuditRepository();
    this.fetchImpl =
      options?.fetchImpl ?? ((url, init) => fetch(url, init));
    this.devCatcherHandler = options?.devCatcherHandler;
  }

  public get provider(): TenantTeamsIntegrationConfig['provider'] {
    // Dynamic resolution requires TenantContext; expose default `'disabled'` only when unbound.
    return 'disabled';
  }

  public async sendActivity(
    ctx: TenantContext,
    activity: OutgoingTeamsActivity,
    options?: SendTeamsActivityOptions,
  ): Promise<TeamsSendResult & { readonly entraObjectId?: string }> {
    const teamsCfg = this.getTeamsConfig(ctx);
    const provider = teamsCfg.provider ?? 'disabled';

    if (provider === 'disabled') {
      throw new TeamsIntegrationError(
        'TEAMS_PROVIDER_DISABLED',
        'Teams Activity delivery is disabled for this tenant configuration.',
      );
    }

    const cleanActivity = sanitizeTeamsActivityPayload(activity);
    const allowEval = await evaluateTeamsRecipientAllowList(
      ctx,
      teamsCfg,
      cleanActivity.recipientPersonId,
      {
        partyRepository: this.partyRepository,
        secretReader: this.secretReader,
      },
    );

    if (!allowEval.allowed) {
      if (allowEval.outcome === 'dropped_unbound') {
        return { outcome: 'dropped_unbound' };
      }

      if (!options?.skipDropAudit) {
        await this.auditRepository.appendAuditEntries(ctx, [
          {
            recordType: 'teams_activity_outbox',
            recordId: options?.outboxRecordId ?? cleanActivity.idempotencyKey,
            action: 'teams-notification-dropped-allowlist',
            field: 'allowList',
            oldValue: null,
            newValue: allowEval.reason,
            byId: ctx.actorId || 'system:teams-notifier',
            at: new Date().toISOString(),
            reason: `Teams Activity dropped by non-live allow-list (${allowEval.reason}; correlationId=${cleanActivity.correlationId}).`,
          },
        ]);
      }
      return {
        outcome: 'dropped_not_allow_listed',
        reason: allowEval.reason,
        entraObjectId: allowEval.entraObjectId,
      };
    }

    if (provider === 'dev_catcher') {
      if (ctx.environment === 'live') {
        throw new TeamsIntegrationError(
          'TEAMS_DEV_CATCHER_FORBIDDEN_IN_LIVE',
          'The dev_catcher Teams provider cannot be used in live environments.',
        );
      }
      const endpointUrl = teamsCfg.devCatcher?.endpointUrl?.trim() ?? '';
      if (!endpointUrl) {
        throw new TeamsIntegrationError(
          'TEAMS_DEV_CATCHER_ENDPOINT_REQUIRED',
          'integrations.teams.devCatcher.endpointUrl is required for dev_catcher Teams delivery.',
        );
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(endpointUrl);
      } catch {
        throw new TeamsIntegrationError(
          'TEAMS_DEV_CATCHER_ENDPOINT_INVALID',
          'integrations.teams.devCatcher.endpointUrl must be a valid URL.',
        );
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new TeamsIntegrationError(
          'TEAMS_DEV_CATCHER_ENDPOINT_INVALID',
          'integrations.teams.devCatcher.endpointUrl must use http or https.',
        );
      }

      const devPayload: TeamsDevCatcherPayload = {
        tenantId: ctx.tenantId,
        idempotencyKey: cleanActivity.idempotencyKey,
        recipientPersonId: cleanActivity.recipientPersonId,
        entraObjectId: allowEval.entraObjectId,
        teamsAppId: teamsCfg.teamsAppId ?? null,
        activityType: cleanActivity.activityType,
        previewText: cleanActivity.previewText,
        templateParameters: cleanActivity.templateParameters,
        deepLinkPath: cleanActivity.deepLinkPath,
        correlationId: cleanActivity.correlationId,
      };

      if (this.devCatcherHandler) {
        const res = await this.devCatcherHandler(devPayload);
        return {
          outcome: 'sent',
          providerRequestId:
            res?.requestId ?? `devcatcher:${cleanActivity.idempotencyKey}`,
          entraObjectId: allowEval.entraObjectId,
        };
      }

      const response = await this.fetchImpl(parsedUrl.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': cleanActivity.correlationId,
          'x-idempotency-key': cleanActivity.idempotencyKey,
        },
        body: JSON.stringify(devPayload),
      });
      if (!response.ok) {
        throw new TeamsIntegrationError(
          `TEAMS_DEV_CATCHER_HTTP_${response.status}`,
          `Teams dev_catcher endpoint responded with HTTP ${response.status}.`,
        );
      }
      let requestId: string | undefined;
      try {
        const json = (await response.json()) as {
          requestId?: unknown;
          id?: unknown;
        };
        if (typeof json.requestId === 'string' && json.requestId.trim()) {
          requestId = json.requestId.trim();
        } else if (typeof json.id === 'string' && json.id.trim()) {
          requestId = json.id.trim();
        }
      } catch {
        // Empty 200/202/204 response is valid.
      }
      return {
        outcome: 'sent',
        providerRequestId:
          requestId ?? `devcatcher:${cleanActivity.idempotencyKey}`,
        entraObjectId: allowEval.entraObjectId,
      };
    }

    // provider === 'graph'
    const graphCfg = teamsCfg.graph;
    if (
      !graphCfg?.tenantId?.trim() ||
      !graphCfg.clientId?.trim() ||
      !graphCfg.certificateVaultRef?.trim() ||
      !graphCfg.certificateThumbprint?.trim()
    ) {
      throw new TeamsIntegrationError(
        'TEAMS_GRAPH_CONFIG_INVALID',
        'integrations.teams.graph (tenantId, clientId, certificateVaultRef, certificateThumbprint) is incomplete.',
      );
    }

    const accessToken = await this.tokenProvider.acquireAppToken(
      ctx,
      {
        tenantId: graphCfg.tenantId,
        clientId: graphCfg.clientId,
        certificateVaultRef: graphCfg.certificateVaultRef,
        certificateThumbprint: graphCfg.certificateThumbprint,
      },
      GRAPH_MAIL_DEFAULT_SCOPE,
    );

    const graphEndpoint = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(allowEval.entraObjectId)}/teamwork/sendActivityNotification`;
    const graphTemplateParameters = BUILT_IN_ACTOR_ONLY_ACTIVITY_TYPES.has(
      cleanActivity.activityType,
    )
      ? []
      : cleanActivity.templateParameters.map((p) => ({
          name: p.name,
          value: p.value,
        }));
    const graphPayload = {
      topic: {
        source: 'text',
        value: cleanActivity.activityType,
        webUrl: buildTeamsTopicWebUrl(
          teamsCfg.teamsAppId,
          cleanActivity.deepLinkPath,
        ),
      },
      activityType: cleanActivity.activityType,
      previewText: {
        content: cleanActivity.previewText,
      },
      templateParameters: graphTemplateParameters,
    };

    const response = await this.fetchImpl(graphEndpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'client-request-id': cleanActivity.correlationId,
      },
      body: JSON.stringify(graphPayload),
    });

    if (!response.ok) {
      throw new TeamsIntegrationError(
        `TEAMS_GRAPH_HTTP_${response.status}`,
        `Microsoft Graph sendActivityNotification failed with HTTP ${response.status}.`,
      );
    }

    let requestId: string | undefined;
    try {
      const json = (await response.json()) as { id?: unknown };
      if (typeof json.id === 'string' && json.id.trim()) {
        requestId = json.id.trim();
      }
    } catch {
      // Graph returns 204 No Content on success.
    }

    return {
      outcome: 'sent',
      providerRequestId: requestId ?? `graph:${cleanActivity.correlationId}`,
      entraObjectId: allowEval.entraObjectId,
    };
  }
}
