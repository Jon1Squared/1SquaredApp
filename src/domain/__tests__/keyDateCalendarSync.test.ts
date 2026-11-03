import { describe, expect, it } from 'vitest';
import exampleConfig from '../../../schemas/keyDates.config.example.json';
import type {
  KeyDate,
  KeyDateCalendarSync,
  KeyDatesConfig,
} from '../keyDates.types';
import type { Matter } from '../types';
import {
  renderCalendarEventTitle,
  sanitizeCalendarSyncError,
  syncKeyDateToOutlookCalendar,
  type MicrosoftGraphCalendarAdapter,
  type MicrosoftGraphCalendarEventPayload,
} from '../keyDateCalendarSync';
import { reassignKeyDateTeamRecord } from '@/server/services';
import { getStore, resetStore } from '@/server/store';

const config = exampleConfig as unknown as KeyDatesConfig;

const litMatter = {
  id: 'MAT-SYNC-1',
  reference: 'NALF-2026-0500',
  title: 'Pembroke v Sterling Corp',
  clientId: 'P-CLI-1',
  practiceAreaId: 'work_type.dispute_resolution',
  matterTypeId: 'matter_type.litigation',
  owningTeamId: 'TM-LIT',
  status: 'Active',
} as unknown as Matter;

function makeKeyDate(overrides?: Partial<KeyDate>): KeyDate {
  return {
    id: 'KD-SYNC-1',
    matterId: litMatter.id,
    keyDateTypeId: 'limitation',
    category: 'limitation',
    title: 'Primary Limitation Date',
    dueDate: '2026-11-15',
    isCritical: true,
    status: 'confirmed',
    source: 'calculated',
    teamId: 'TM-LIT',
    responsiblePersonIds: ['P-FEE-1', 'P-SUP-1'],
    verification: { required: true },
    createdById: 'P-FEE-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedById: 'P-FEE-1',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

describe('One-Way Outlook Calendar Sync via Microsoft Graph (§7)', () => {
  it('renders event titles from eventTitleTemplate using only allowed tokens and never client names', () => {
    const title = renderCalendarEventTitle(
      '{{matterReference}} – {{keyDateTypeLabel}} ({{clientName}})',
      {
        matterReference: 'NALF-2026-0500',
        keyDateTypeLabel: 'Limitation date',
        title: 'Primary Limitation',
        category: 'limitation',
      },
    );
    expect(title).toBe('NALF-2026-0500 – Limitation date ()');
    expect(title).not.toContain('Pembroke');
  });

  it('syncs confirmed key dates to responsible persons and mapped team calendars, and removes events on supersede/resolve', async () => {
    const upserted: Array<{
      target: string;
      existingEventId?: string;
      payload: MicrosoftGraphCalendarEventPayload;
    }> = [];
    const deleted: Array<{ target: string; eventId: string }> = [];

    const mockAdapter: MicrosoftGraphCalendarAdapter = {
      credentialSource: 'managed_identity',
      async upsertEvent(input) {
        upserted.push(input);
        return { eventId: input.existingEventId ?? `evt-${input.target}` };
      },
      async deleteEvent(input) {
        deleted.push(input);
      },
    };

    const customConfig: KeyDatesConfig = {
      ...config,
      calendarSync: {
        ...config.calendarSync,
        targets: ['responsible_persons', 'team_calendar'],
        teamCalendarMappings: [
          { teamId: 'TM-LIT', groupId: 'm365-group-litigation' },
        ],
      },
    };

    const calendarSyncs: KeyDateCalendarSync[] = [];
    const kd = makeKeyDate();

    // 1. Confirmed date syncs to 2 responsible persons + 1 team calendar
    const sync1 = await syncKeyDateToOutlookCalendar({
      keyDate: kd,
      config: customConfig,
      matter: litMatter,
      calendarSyncs,
      nowIso: '2026-02-01T10:00:00Z',
      adapter: mockAdapter,
    });

    expect(sync1.state).toBe('synced');
    expect(sync1.externalEvents).toHaveLength(3);
    expect(upserted.map((u) => u.target)).toEqual([
      'person:P-FEE-1',
      'person:P-SUP-1',
      'group:m365-group-litigation',
    ]);
    expect(upserted[0]!.payload.subject).toBe(
      'NALF-2026-0500 – Limitation date',
    );

    // 2. Resolving as 'met' (outside statusesToSync=['confirmed']) deletes external events
    kd.status = 'met';
    const sync2 = await syncKeyDateToOutlookCalendar({
      keyDate: kd,
      config: customConfig,
      matter: litMatter,
      calendarSyncs,
      nowIso: '2026-02-02T10:00:00Z',
      adapter: mockAdapter,
    });

    expect(sync2.state).toBe('synced');
    expect(sync2.externalEvents).toHaveLength(0);
    expect(deleted).toHaveLength(3);
  });

  it('never syncs restricted (staff) matters or matter types where calendarSync.enabled is false', async () => {
    let called = false;
    const spyAdapter: MicrosoftGraphCalendarAdapter = {
      credentialSource: 'managed_identity',
      async upsertEvent() {
        called = true;
        return { eventId: 'evt-should-not-happen' };
      },
      async deleteEvent() {
        called = true;
      },
    };

    const restrictedMatter = {
      ...litMatter,
      id: 'MAT-STAFF-SYNC',
      isStaffMatter: true,
      restrictedAccessUserIds: ['P-SUP-1'],
    } as unknown as Matter;

    const calendarSyncs: KeyDateCalendarSync[] = [];
    const syncRestricted = await syncKeyDateToOutlookCalendar({
      keyDate: makeKeyDate({ id: 'KD-STAFF-SYNC', matterId: restrictedMatter.id }),
      config,
      matter: restrictedMatter,
      calendarSyncs,
      nowIso: '2026-02-01T10:00:00Z',
      adapter: spyAdapter,
    });

    expect(syncRestricted.state).toBe('disabled');
    expect(called).toBe(false);
  });

  it('records Graph failures in KeyDateCalendarSync with sanitized error messages (no client data)', async () => {
    const failingAdapter: MicrosoftGraphCalendarAdapter = {
      credentialSource: 'kv://graph-calendar-client-secret',
      async upsertEvent() {
        throw new Error(
          'Graph HTTP 503 for user eleanor.vance@example.test concerning "Confidential Client Name"',
        );
      },
      async deleteEvent() {},
    };

    const calendarSyncs: KeyDateCalendarSync[] = [];
    const syncFailed = await syncKeyDateToOutlookCalendar({
      keyDate: makeKeyDate({ id: 'KD-FAIL-SYNC' }),
      config,
      matter: litMatter,
      calendarSyncs,
      nowIso: '2026-02-01T10:00:00Z',
      adapter: failingAdapter,
    });

    expect(syncFailed.state).toBe('failed');
    expect(syncFailed.attempts).toBe(1);
    expect(syncFailed.lastError).toBeDefined();
    expect(syncFailed.lastError).not.toContain('eleanor.vance@example.test');
    expect(syncFailed.lastError).not.toContain('Confidential Client Name');
    expect(sanitizeCalendarSyncError('test@example.com "Secret Client"')).toBe(
      '[redacted-email] "[redacted]"',
    );
  });

  it('marks sync state as disabled with the default unconfigured adapter (even when GRAPH_CALENDAR_SYNC_ENABLED=true) and deletes the old owner event on reassignment (R40, R81)', async () => {
    const calendarSyncs: KeyDateCalendarSync[] = [];
    const defaultSync = await syncKeyDateToOutlookCalendar({
      keyDate: makeKeyDate({ id: 'KD-DEFAULT-ADAPTER' }),
      config,
      matter: litMatter,
      calendarSyncs,
      nowIso: '2026-02-01T10:00:00Z',
    });
    expect(defaultSync.state).not.toBe('synced');
    expect(defaultSync.state).toBe('disabled');

    const prevGraphFlag = process.env.GRAPH_CALENDAR_SYNC_ENABLED;
    process.env.GRAPH_CALENDAR_SYNC_ENABLED = 'true';
    try {
      const flaggedSyncs: KeyDateCalendarSync[] = [];
      const flaggedSync = await syncKeyDateToOutlookCalendar({
        keyDate: makeKeyDate({ id: 'KD-FLAGGED-STUB-ADAPTER' }),
        config,
        matter: litMatter,
        calendarSyncs: flaggedSyncs,
        nowIso: '2026-02-01T10:00:00Z',
      });
      expect(flaggedSync.state).not.toBe('synced');
      expect(flaggedSync.state).toBe('disabled');
    } finally {
      if (prevGraphFlag === undefined) {
        delete process.env.GRAPH_CALENDAR_SYNC_ENABLED;
      } else {
        process.env.GRAPH_CALENDAR_SYNC_ENABLED = prevGraphFlag;
      }
    }

    // Reassignment via reassignKeyDateTeamRecord calls syncKeyDateToOutlookCalendar and deletes the old owner's event
    resetStore();
    const store = getStore();
    const confirmedKd = store.keyDates!.find((k) => k.status === 'confirmed')!;
    const oldOwnerId = confirmedKd.responsiblePersonIds[0]!;
    const newOwner = store.people.find(
      (p) =>
        p.isEmployee &&
        !p.mergedIntoId &&
        !confirmedKd.responsiblePersonIds.includes(p.id),
    )!;
    const supervisor = store.people.find(
      (p) => p.isEmployee && p.roles?.includes('managing_partner'),
    )!;

    store.keyDateCalendarSyncs = [
      {
        keyDateId: confirmedKd.id,
        externalEvents: [
          { target: `person:${oldOwnerId}`, eventId: 'evt-old-owner-1' },
        ],
        state: 'synced',
        lastSyncedAt: '2026-02-01T10:00:00Z',
        attempts: 1,
      },
    ];

    const deletedEvents: Array<{ target: string; eventId: string }> = [];
    const upsertedEvents: Array<{ target: string; eventId: string }> = [];
    const spyAdapter: MicrosoftGraphCalendarAdapter = {
      credentialSource: 'managed_identity',
      isConfigured: true,
      async upsertEvent(input) {
        const id = input.existingEventId ?? `evt-new-${input.target}`;
        upsertedEvents.push({ target: input.target, eventId: id });
        return { eventId: id };
      },
      async deleteEvent(input) {
        deletedEvents.push(input);
      },
    };

    const res = await reassignKeyDateTeamRecord(
      confirmedKd.id,
      {
        teamId: confirmedKd.teamId,
        responsiblePersonIds: [newOwner.id],
        reason: 'Reassigning to new owner',
      },
      supervisor.id,
      { calendarAdapter: spyAdapter },
    );
    expect(res.ok).toBe(true);
    expect(deletedEvents).toEqual([
      { target: `person:${oldOwnerId}`, eventId: 'evt-old-owner-1' },
    ]);
    expect(upsertedEvents.some((e) => e.target === `person:${newOwner.id}`)).toBe(
      true,
    );
  });
});
