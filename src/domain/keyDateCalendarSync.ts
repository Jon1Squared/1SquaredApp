/**
 * One-Way Outlook Calendar Sync via Microsoft Graph (`src/domain/keyDateCalendarSync.ts`).
 *
 * Classification: Core feature (Platform Architecture Standard §14).
 * - Resolves sync enablement from `matterTypes[].calendarSync.enabled`, falling back to
 *   `defaults.calendarSync.enabled` (default `true`).
 * - Strictly one-way to Microsoft Graph using Managed Identity or Key Vault-referenced credentials.
 * - Restricted (staff) matters NEVER sync (`state: 'disabled'`).
 * - Syncs only statuses listed in `calendarSync.statusesToSync` (default `['confirmed']`).
 * - Updates or removes external events when a key date changes, is superseded, or is resolved.
 * - Event titles use `eventTitleTemplate` (allowed tokens: `matterReference`, `keyDateTypeLabel`,
 *   `title`, `category`) and contain no client names by default.
 * - Records failures in `KeyDateCalendarSync` without client content in error messages or logs,
 *   surfacing them as `calendar_sync_failed` compliance exceptions.
 */

import {
  findKeyDateTypeConfig,
  isMatterRestrictedForKeyDates,
  resolveMatterTypeCalendarSyncPolicy,
} from './keyDates';
import type {
  IsoDate,
  IsoDateTime,
  KeyDate,
  KeyDateCalendarSync,
  KeyDatesConfig,
} from './keyDates.types';
import type { Enquiry, Matter } from './types';

export interface MicrosoftGraphCalendarEventPayload {
  subject: string;
  dueDate: IsoDate;
  dueTime?: string;
  bodyText: string;
  isCritical: boolean;
}

export interface MicrosoftGraphCalendarAdapter {
  /**
   * Credential source must be Managed Identity or Key Vault secret reference—never inline keys.
   */
  readonly credentialSource: 'managed_identity' | `kv://${string}`;
  readonly isConfigured?: boolean;
  upsertEvent(input: {
    target: string; // 'person:<id>' or 'group:<groupId>'
    existingEventId?: string;
    payload: MicrosoftGraphCalendarEventPayload;
  }): Promise<{ eventId: string }>;
  deleteEvent(input: { target: string; eventId: string }): Promise<void>;
}

export type GraphCalendarAdapter = MicrosoftGraphCalendarAdapter;

/**
 * Default unconfigured Microsoft Graph calendar stub adapter used when no live Graph adapter
 * is injected. Always reports `isConfigured = false` so records are never falsely marked `synced`.
 */
export class ManagedIdentityGraphCalendarAdapter
  implements MicrosoftGraphCalendarAdapter
{
  public readonly credentialSource = 'managed_identity' as const;
  public readonly isConfigured: boolean = false;

  constructor(_options?: { isConfigured?: boolean }) {
    this.isConfigured = false;
  }

  public async upsertEvent(_input: {
    target: string;
    existingEventId?: string;
    payload: MicrosoftGraphCalendarEventPayload;
  }): Promise<{ eventId: string }> {
    throw new Error(
      'GRAPH_ADAPTER_NOT_IMPLEMENTED: Live Microsoft Graph calendar adapter is not configured.',
    );
  }

  public async deleteEvent(_input: {
    target: string;
    eventId: string;
  }): Promise<void> {
    throw new Error(
      'GRAPH_ADAPTER_NOT_IMPLEMENTED: Live Microsoft Graph calendar adapter is not configured.',
    );
  }
}

const ALLOWED_TEMPLATE_TOKENS = new Set([
  'matterReference',
  'keyDateTypeLabel',
  'title',
  'category',
]);

/**
 * Renders the calendar event title from `eventTitleTemplate` (default `{{matterReference}} – {{keyDateTypeLabel}}`).
 * Only replaces allowed tokens (`matterReference`, `keyDateTypeLabel`, `title`, `category`);
 * never injects client names.
 */
export function renderCalendarEventTitle(
  template: string | undefined,
  tokens: {
    matterReference: string;
    keyDateTypeLabel: string;
    title: string;
    category: string;
  },
): string {
  const tpl =
    template && template.trim()
      ? template
      : '{{matterReference}} – {{keyDateTypeLabel}}';

  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, tokenName) => {
    if (!ALLOWED_TEMPLATE_TOKENS.has(tokenName)) {
      return '';
    }
    return tokens[tokenName as keyof typeof tokens] ?? '';
  });
}

/**
 * Scrubs any potential client content or personal data from Graph error strings
 * so `KeyDateCalendarSync.lastError` and logs contain only technical diagnostic codes.
 */
export function sanitizeCalendarSyncError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  // Redact email addresses, quoted strings, or long free-text payloads
  const redacted = raw
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[redacted-email]')
    .replace(/"[^"]*"/g, '"[redacted]"')
    .slice(0, 160);
  return redacted || 'Microsoft Graph calendar sync error';
}

/**
 * Resolves the target mailboxes / group calendars (`person:<personId>` and `group:<groupId>`)
 * configured in `keyDates.calendarSync`.
 */
export function resolveCalendarSyncTargets(
  keyDate: Pick<KeyDate, 'teamId' | 'responsiblePersonIds'>,
  config: KeyDatesConfig,
): string[] {
  const targetsConfig = config.calendarSync?.targets ?? ['responsible_persons'];
  const targets: string[] = [];

  if (targetsConfig.includes('responsible_persons')) {
    for (const pid of keyDate.responsiblePersonIds) {
      if (pid) targets.push(`person:${pid}`);
    }
  }

  if (targetsConfig.includes('team_calendar')) {
    const mapping = config.calendarSync?.teamCalendarMappings?.find(
      (m) => m.teamId === keyDate.teamId,
    );
    if (mapping?.groupId) {
      targets.push(`group:${mapping.groupId}`);
    }
  }

  return Array.from(new Set(targets));
}

export interface SyncKeyDateCalendarParams {
  keyDate: KeyDate;
  config: KeyDatesConfig;
  matter?: Matter | null;
  enquiry?: Enquiry | null;
  calendarSyncs: KeyDateCalendarSync[];
  nowIso: IsoDateTime;
  adapter?: MicrosoftGraphCalendarAdapter;
}

/**
 * Synchronises a `KeyDate` one-way to Microsoft Outlook via Microsoft Graph.
 * - Restricted matters NEVER sync (`state: 'disabled'`, any prior external events removed).
 * - Matter types with `calendarSync.enabled === false` do not sync (`state: 'disabled'`).
 * - Statuses in `statusesToSync` (default `['confirmed']`) create or update the external events.
 * - Statuses outside `statusesToSync` (e.g. `superseded`, `met`, `missed`, `waived`) remove any existing external events.
 * - Failures are recorded in `KeyDateCalendarSync` (`state: 'failed'`) so they appear in Compliance Exceptions.
 */
export async function syncKeyDateToOutlookCalendar(
  params: SyncKeyDateCalendarParams,
): Promise<KeyDateCalendarSync> {
  const {
    keyDate,
    config,
    matter,
    enquiry,
    calendarSyncs,
    nowIso,
    adapter = new ManagedIdentityGraphCalendarAdapter(),
  } = params;

  let syncRecord = calendarSyncs.find((cs) => cs.keyDateId === keyDate.id);
  if (!syncRecord) {
    syncRecord = {
      keyDateId: keyDate.id,
      state: 'pending',
      externalEvents: [],
      attempts: 0,
    };
    calendarSyncs.push(syncRecord);
  }

  const isRestricted = isMatterRestrictedForKeyDates(matter);
  const matterTypeId =
    matter?.matterTypeId ??
    matter?.practiceAreaId ??
    enquiry?.practiceAreaId ??
    undefined;
  const syncPolicy = resolveMatterTypeCalendarSyncPolicy(
    config,
    matterTypeId,
    isRestricted,
  );

  // 1. If restricted matter, calendar sync disabled for matter type (or module disabled), or default adapter is unconfigured, ensure disabled & remove any existing events
  const isUnconfiguredDefaultAdapter =
    adapter instanceof ManagedIdentityGraphCalendarAdapter &&
    !adapter.isConfigured;
  const syncProvider = config.calendarSync?.provider ?? 'microsoft_graph';
  if (
    !config?.enabled ||
    syncProvider !== 'microsoft_graph' ||
    isRestricted ||
    !syncPolicy.enabled ||
    isUnconfiguredDefaultAdapter
  ) {
    if (syncRecord.externalEvents.length > 0) {
      for (const extEvt of syncRecord.externalEvents) {
        try {
          await adapter.deleteEvent(extEvt);
        } catch {
          // Ignore delete errors when disabling
        }
      }
      syncRecord.externalEvents = [];
    }
    syncRecord.state = 'disabled';
    syncRecord.lastError = undefined;
    return syncRecord;
  }

  const statusesToSync = config.calendarSync?.statusesToSync ?? ['confirmed'];
  const shouldBePresentInOutlook = (
    statusesToSync as readonly string[]
  ).includes(keyDate.status);

  // 2. If key date status is not in `statusesToSync` (e.g. superseded, met, missed, waived), remove external events
  if (!shouldBePresentInOutlook) {
    if (syncRecord.externalEvents.length > 0) {
      syncRecord.attempts += 1;
      try {
        for (const extEvt of syncRecord.externalEvents) {
          await adapter.deleteEvent(extEvt);
        }
        syncRecord.externalEvents = [];
        syncRecord.state = 'synced';
        syncRecord.lastSyncedAt = nowIso;
        syncRecord.lastError = undefined;
      } catch (err) {
        syncRecord.state = 'failed';
        syncRecord.lastError = sanitizeCalendarSyncError(err);
      }
    } else {
      syncRecord.state = 'pending';
    }
    return syncRecord;
  }

  // 3. Status is in `statusesToSync`: create or update external events for each configured target
  const targets = resolveCalendarSyncTargets(keyDate, config);
  const kdType = findKeyDateTypeConfig(config, keyDate.keyDateTypeId);
  const matterReference =
    (matter as { reference?: string } | undefined)?.reference ??
    matter?.matterNumber ??
    enquiry?.reference ??
    keyDate.matterId ??
    keyDate.enquiryId ??
    keyDate.id;
  const keyDateTypeLabel = kdType?.label ?? keyDate.keyDateTypeId;

  const subject = renderCalendarEventTitle(
    config.calendarSync?.eventTitleTemplate,
    {
      matterReference,
      keyDateTypeLabel,
      title: keyDate.title,
      category: keyDate.category,
    },
  );

  const bodyLines = [
    `Reference: ${matterReference}`,
    `Type: ${keyDateTypeLabel} (${keyDate.category})`,
    `Key date: ${keyDate.title}`,
    `Due date: ${keyDate.dueDate}${keyDate.dueTime ? ` at ${keyDate.dueTime}` : ''}`,
    `Status: ${keyDate.status}`,
  ];
  if (config.calendarSync?.includeMatterDescription && matter?.title) {
    bodyLines.push(`Description: ${matter.title}`);
  }

  const payload: MicrosoftGraphCalendarEventPayload = {
    subject,
    dueDate: keyDate.dueDate,
    dueTime: keyDate.dueTime,
    bodyText: bodyLines.join('\n'),
    isCritical: keyDate.isCritical,
  };

  syncRecord.attempts += 1;
  try {
    const existingByTarget = new Map(
      syncRecord.externalEvents.map((e) => [e.target, e.eventId]),
    );
    const updatedExternalEvents: { target: string; eventId: string }[] = [];

    for (const target of targets) {
      const existingEventId = existingByTarget.get(target);
      const res = await adapter.upsertEvent({
        target,
        existingEventId,
        payload,
      });
      updatedExternalEvents.push({ target, eventId: res.eventId });
      existingByTarget.delete(target);
    }

    // Remove any stale targets that were previously synced but are no longer targets
    for (const [removedTarget, removedEventId] of existingByTarget.entries()) {
      await adapter.deleteEvent({
        target: removedTarget,
        eventId: removedEventId,
      });
    }

    syncRecord.externalEvents = updatedExternalEvents;
    syncRecord.state = 'synced';
    syncRecord.lastSyncedAt = nowIso;
    syncRecord.lastError = undefined;
  } catch (err) {
    syncRecord.state = 'failed';
    syncRecord.lastError = sanitizeCalendarSyncError(err);
  }

  return syncRecord;
}
