import { describe, expect, it } from 'vitest';
import {
  CORE_TENANT_MIGRATIONS,
  KEY_DATES_MIGRATION_0003,
  KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004,
  resolveTenantFromVerifiedToken,
  runTenantBackgroundJob,
  TenantKeyDateRepository,
  TenantMigrationRunner,
  type KeyDate,
  type TenantContext,
} from '../src/index';
import {
  acknowledgeKeyDateReminderRecord,
  reassignKeyDateTeamRecord,
  resolveKeyDateOutcomeRecord,
  supersedeConfirmedKeyDateRecord,
  verifyProposedKeyDateRecord,
} from '../../src/server/services';
import {
  computeKeyDateExceptions,
  queryTeamDiaryEntries,
} from '../../src/domain/keyDateDiary';
import { getStore, resetStore } from '../../src/server/store';

function createVerifiedTenantContext(
  tenantId: string,
  actorId: string = 'P-000001',
  roles: string[] = ['partner'],
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      name: `Actor ${actorId}`,
      email: `${actorId.toLowerCase()}@${tenantId}.example.invalid`,
      tenantId,
      roles,
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-${tenantId}-${actorId}`,
  });
}

function makeSampleKeyDate(overrides: Partial<KeyDate> = {}): KeyDate {
  return {
    id: 'KD-000001',
    matterId: 'M-000001',
    keyDateTypeId: 'limitation',
    category: 'limitation',
    title: 'Primary Limitation Date',
    dueDate: '2027-06-01',
    isCritical: true,
    status: 'confirmed',
    source: 'calculated',
    teamId: 'TM-000001',
    responsiblePersonIds: ['P-000001', 'P-000002'],
    verification: {
      required: true,
      proposedById: 'P-000001',
      proposedAt: '2026-11-01T10:00:00.000Z',
      verifiedById: 'P-000002',
      verifiedAt: '2026-11-02T10:00:00.000Z',
    },
    createdById: 'P-000001',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedById: 'P-000002',
    updatedAt: '2026-11-02T10:00:00.000Z',
    version: 2,
    ...overrides,
  };
}

describe('Key Dates Two-Tenant Isolation, Migrations & Restricted Matter Omission (Phase 1)', () => {
  it('applies and rolls back migration 0003_key_dates_expand per tenant independently while retaining key_date_audit_events (R39, R48)', () => {
    const runner = new TenantMigrationRunner();
    const ctxA = createVerifiedTenantContext('tenant-alpha');
    const ctxB = createVerifiedTenantContext('tenant-bravo');

    expect(KEY_DATES_MIGRATION_0003.version).toBe('0003');
    expect(KEY_DATES_MIGRATION_0003.name).toBe('0003_key_dates_expand');
    expect(KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004.version).toBe(
      '0004',
    );
    expect(KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004.name).toBe(
      '0004_key_date_reminder_last_skipped_reason_expand',
    );
    expect(
      KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004.dependsOn,
    ).toEqual(['0003']);
    // R149: Verify 0004 downSql drops both the constraint and the last_skipped_reason column
    expect(
      KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004.downSql,
    ).toContain(
      'DROP CONSTRAINT IF EXISTS chk_key_date_reminder_states_last_skipped_reason',
    );
    expect(
      KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004.downSql,
    ).toContain('DROP COLUMN IF EXISTS last_skipped_reason');

    // R145: Applying 0004 without its prerequisite 0003 throws MIGRATION_DEPENDENCY_ERROR
    expect(() =>
      runner.applyUp(ctxB, [
        KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004,
      ]),
    ).toThrow(/MIGRATION_DEPENDENCY_ERROR/);

    const appliedA = runner.applyUp(ctxA, CORE_TENANT_MIGRATIONS);
    expect(
      appliedA.some((m) => m.version === KEY_DATES_MIGRATION_0003.version),
    ).toBe(true);
    expect(
      appliedA.some(
        (m) =>
          m.version ===
          KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004.version,
      ),
    ).toBe(true);
    expect(runner.getActiveTables(ctxA)).toContain('key_dates');
    expect(runner.getActiveTables(ctxA)).toContain('key_date_reminder_states');
    expect(runner.getActiveTables(ctxA)).toContain('key_date_audit_events');
    expect(runner.getActiveTables(ctxB)).not.toContain('key_dates');

    // R145: Rolling back 0002 (which 0003 and 0004 do not depend on) succeeds independently and leaves key-date tables intact
    expect(runner.rollbackVersion(ctxA, '0002')).toBe(true);
    expect(runner.getActiveTables(ctxA)).toContain('key_dates');
    expect(runner.getActiveTables(ctxA)).toContain('key_date_reminder_states');

    // R124 & R145: Attempting to roll back 0003 while 0004 (dependsOn: ['0003']) is still applied throws MIGRATION_ROLLBACK_ORDER_ERROR
    expect(() => runner.rollbackVersion(ctxA, '0003')).toThrow(
      /MIGRATION_ROLLBACK_ORDER_ERROR/,
    );
    expect(runner.getActiveTables(ctxA)).toContain('key_dates');

    // R110 & R124: Reversible rollback of 0004 ('0004' or '0004_key_date_reminder_last_skipped_reason_expand'), followed by 0003
    const rolledBack0004 = runner.rollbackVersion(ctxA, '0004');
    expect(rolledBack0004).toBe(true);
    expect(runner.getActiveTables(ctxA)).toContain('key_date_reminder_states');

    // Reversible rollback on tenant-alpha (matching either version '0003' or name '0003_key_dates_expand')
    const rolledBack = runner.rollbackVersion(
      ctxA,
      '0003_key_dates_expand',
    );
    expect(rolledBack).toBe(true);
    expect(runner.getActiveTables(ctxA)).not.toContain('key_dates');
    // Audit table is retained on rollback (R39)
    expect(runner.getActiveTables(ctxA)).toContain('key_date_audit_events');
  });

  it('isolates KeyDate, ReminderState, CalendarSync, NotApplicable, and AuditEvent records between Tenant A and Tenant B, including tampered record IDs and cross-tenant writes (R30, R31)', () => {
    const repo = new TenantKeyDateRepository();
    const ctxA = createVerifiedTenantContext('tenant-alpha', 'P-ALPHA-1');
    const ctxB = createVerifiedTenantContext('tenant-bravo', 'P-BRAVO-1');

    repo.setMatterRestriction(ctxA, {
      matterId: 'M-ALPHA-001',
      isRestricted: false,
      restrictedAccessUserIds: [],
    });

    const kdAlpha = makeSampleKeyDate({
      id: 'KD-SHARED-ID-001',
      matterId: 'M-ALPHA-001',
      title: 'Alpha Limitation',
    });
    repo.putKeyDate(ctxA, kdAlpha);
    repo.putReminderState(ctxA, {
      keyDateId: kdAlpha.id,
      taskId: 'TSK-ALPHA-001',
      idempotencyKey: `keydate-reminder:tenant-alpha:${kdAlpha.id}`,
      reminderScheduleId: 'limitation',
      currentStageDaysBefore: 90,
      stageEnteredAt: '2026-11-03T00:00:00.000Z',
      escalationLevel: 0,
      lastSkippedReason: 'no_permitted_assignees',
    });
    expect(repo.getReminderState(ctxA, kdAlpha.id)?.lastSkippedReason).toBe(
      'no_permitted_assignees',
    );
    expect(() =>
      repo.putReminderState(ctxA, {
        keyDateId: kdAlpha.id,
        taskId: 'TSK-ALPHA-001',
        idempotencyKey: `keydate-reminder:tenant-alpha:${kdAlpha.id}`,
        reminderScheduleId: 'limitation',
        currentStageDaysBefore: 90,
        stageEnteredAt: '2026-11-03T00:00:00.000Z',
        escalationLevel: 0,
        lastSkippedReason: 'forged_reason' as unknown as 'no_permitted_assignees',
      }),
    ).toThrow(/KEY_DATE_VALIDATION_ERROR/);
    repo.putCalendarSync(ctxA, {
      keyDateId: kdAlpha.id,
      externalEvents: [{ target: 'person:P-ALPHA-1', eventId: 'evt-alpha-1' }],
      state: 'synced',
      lastSyncedAt: '2026-11-03T00:00:00.000Z',
      attempts: 1,
    });
    repo.putNotApplicable(ctxA, {
      matterId: 'M-ALPHA-001',
      keyDateTypeId: 'undertaking',
      reason: 'No undertaking given on this matter',
      recordedById: 'P-ALPHA-1',
      recordedAt: '2026-11-03T00:00:00.000Z',
    });
    repo.appendAuditEvent(ctxA, {
      id: 'AU-KD-ALPHA-1',
      keyDateId: kdAlpha.id,
      matterId: 'M-ALPHA-001',
      action: 'keydate-create',
      actorId: 'P-ALPHA-1',
      occurredAt: '2026-11-03T00:00:00.000Z',
      correlationId: ctxA.correlationId,
    });

    // Tenant B attempting to fetch Tenant A's records by tampered ID gets null / empty
    expect(repo.getKeyDateById(ctxB, 'KD-SHARED-ID-001')).toBeNull();
    expect(repo.getReminderState(ctxB, 'KD-SHARED-ID-001')).toBeNull();
    expect(repo.getCalendarSync(ctxB, 'KD-SHARED-ID-001')).toBeNull();
    expect(repo.listKeyDatesForMatter(ctxB, 'M-ALPHA-001')).toEqual([]);
    expect(repo.listNotApplicableForMatter(ctxB, 'M-ALPHA-001')).toEqual([]);
    expect(
      repo.listAuditEvents(ctxB, { keyDateId: 'KD-SHARED-ID-001' }),
    ).toEqual([]);
    expect(
      repo.queryKeyDatesForDiary(ctxB, {
        teamIds: ['TM-000001'],
        from: '2026-01-01',
        to: '2028-12-31',
      }),
    ).toEqual([]);

    // Tenant B attempting to write ReminderState or CalendarSync referencing Tenant A's keyDateId or unregistered matter is rejected
    expect(() =>
      repo.putReminderState(ctxB, {
        keyDateId: 'KD-SHARED-ID-001',
        taskId: 'TSK-BRAVO-FORGED',
        idempotencyKey: 'keydate-reminder:tenant-bravo:KD-SHARED-ID-001',
        reminderScheduleId: 'limitation',
        currentStageDaysBefore: 30,
        stageEnteredAt: '2026-11-03T00:00:00.000Z',
        escalationLevel: 0,
      }),
    ).toThrow(/KEY_DATE_NOT_FOUND/);
    expect(() =>
      repo.putCalendarSync(ctxB, {
        keyDateId: 'KD-SHARED-ID-001',
        externalEvents: [],
        state: 'disabled',
        attempts: 0,
      }),
    ).toThrow(/KEY_DATE_NOT_FOUND/);
    expect(() =>
      repo.putKeyDate(ctxB, {
        ...kdAlpha,
        title: 'Bravo Forged Overwrite',
      }),
    ).toThrow(/KEY_DATE_ACCESS_DENIED/);

    // Tenant A sees its own records
    expect(repo.getKeyDateById(ctxA, 'KD-SHARED-ID-001')?.title).toBe(
      'Alpha Limitation',
    );
    expect(repo.getReminderState(ctxA, 'KD-SHARED-ID-001')?.taskId).toBe(
      'TSK-ALPHA-001',
    );
    expect(repo.getCalendarSync(ctxA, 'KD-SHARED-ID-001')?.state).toBe('synced');
    expect(
      repo.listAuditEvents(ctxA, { keyDateId: 'KD-SHARED-ID-001' }),
    ).toHaveLength(1);
  });

  it('rejects forged or missing tenant claims and refuses to run background jobs without tenantId', () => {
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000001',
          name: 'Forged User',
          email: 'forged@example.invalid',
          tenantId: '../forged-tenant!',
          roles: ['fee_earner'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged',
      }),
    ).toThrow(/TENANCY_CLAIM_ERROR/);

    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000001',
          name: 'User',
          email: 'user@example.invalid',
          tenantId: 'tenant-alpha',
          roles: ['fee_earner'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged-override',
        untrustedRequestTenantOverride: 'tenant-bravo',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);

    expect(() =>
      runTenantBackgroundJob(
        {
          jobId: 'keydate-reminder-daily',
          tenantId: '',
          correlationId: 'corr-job-1',
          payload: {},
        },
        () => 'should-not-run',
      ),
    ).toThrow(/TENANCY_JOB_ERROR/);
  });

  it('omits restricted (staff) matters at the data layer unless viewer is in matter.restrictedAccessUserIds', () => {
    const repo = new TenantKeyDateRepository();
    const ctxAuthorised = createVerifiedTenantContext(
      'tenant-alpha',
      'P-ALLOWED-PARTNER',
      ['partner'],
    );
    const ctxUnauthorisedCompliance = createVerifiedTenantContext(
      'tenant-alpha',
      'P-COMPLIANCE-OUTSIDER',
      ['risk_compliance'],
    );

    repo.setMatterRestriction(ctxAuthorised, {
      matterId: 'M-STAFF-001',
      isRestricted: true,
      restrictedAccessUserIds: ['P-ALLOWED-PARTNER', 'P-ALLOWED-FE'],
    });

    const staffKeyDate = makeSampleKeyDate({
      id: 'KD-STAFF-001',
      matterId: 'M-STAFF-001',
      title: 'Restricted Staff Matter Deadline',
      teamId: 'TM-000001',
    });
    repo.putKeyDate(ctxAuthorised, staffKeyDate);

    // Authorised participant in restrictedAccessUserIds sees the key date
    expect(repo.getKeyDateById(ctxAuthorised, 'KD-STAFF-001')).not.toBeNull();
    expect(
      repo.queryKeyDatesForDiary(ctxAuthorised, {
        teamIds: ['TM-000001'],
        from: '2026-01-01',
        to: '2028-12-31',
      }),
    ).toHaveLength(1);

    // Unauthorised viewer (even with risk_compliance role) receives null / empty list with no placeholder
    expect(
      repo.getKeyDateById(ctxUnauthorisedCompliance, 'KD-STAFF-001'),
    ).toBeNull();
    expect(
      repo.listKeyDatesForMatter(ctxUnauthorisedCompliance, 'M-STAFF-001'),
    ).toEqual([]);
    expect(
      repo.queryKeyDatesForDiary(ctxUnauthorisedCompliance, {
        teamIds: ['TM-000001'],
        from: '2026-01-01',
        to: '2028-12-31',
      }),
    ).toEqual([]);

    // Unpermitted user in the same tenant calling putKeyDate on a staff-matter key date gets an error (R31)
    expect(() =>
      repo.putKeyDate(ctxUnauthorisedCompliance, {
        ...staffKeyDate,
        title: 'Tampered Title',
      }),
    ).toThrow(/KEY_DATE_ACCESS_DENIED/);

    // Changing matterId on an existing KeyDate is rejected (R31)
    repo.setMatterRestriction(ctxAuthorised, {
      matterId: 'M-OTHER-002',
      isRestricted: false,
      restrictedAccessUserIds: [],
    });
    expect(() =>
      repo.putKeyDate(ctxAuthorised, {
        ...staffKeyDate,
        matterId: 'M-OTHER-002',
      }),
    ).toThrow(/KEY_DATE_ENTITY_IMMUTABLE/);
  });

  it('rejects unpermitted callers across verify, resolve, reassign, acknowledge, and supersede services on a staff-matter key date with no state change (R30, R82)', async () => {
    resetStore();
    const store = getStore();
    const staffPartner = store.people.find(
      (p) => p.isEmployee && p.roles?.includes('managing_partner'),
    )!;
    const unpermittedPartner = store.people.find(
      (p) =>
        p.isEmployee &&
        p.id !== staffPartner.id &&
        p.roles?.includes('partner'),
    )!;
    const activeTeam = store.teams.find((t) => t.active)!;
    // Make unpermittedPartner a lead/member of activeTeam so reassign/acknowledge would succeed if not for the staff-matter gate
    activeTeam.leadIds = Array.from(
      new Set([...activeTeam.leadIds, unpermittedPartner.id]),
    );
    activeTeam.memberIds = Array.from(
      new Set([...activeTeam.memberIds, unpermittedPartner.id]),
    );

    const baseMatter = store.matters[0]!;
    const staffMatter = {
      ...baseMatter,
      id: 'M-STAFF-SVC-001',
      matterNumber: 'NALF-STAFF-SVC-001',
      title: 'Staff Restricted Matter',
      isStaffMatter: true,
      restrictedAccessUserIds: [staffPartner.id],
      responsiblePartnerId: staffPartner.id,
      supervisingPartnerId: staffPartner.id,
      leadFeeEarnerId: staffPartner.id,
      teamMemberIds: [staffPartner.id],
    };
    store.matters.push(staffMatter);

    const awaitingKd: KeyDate = makeSampleKeyDate({
      id: 'KD-STAFF-SVC-AWAIT',
      matterId: staffMatter.id,
      status: 'awaiting_verification',
      teamId: activeTeam.id,
      responsiblePersonIds: [staffPartner.id, unpermittedPartner.id],
      verification: {
        required: true,
        proposedById: staffPartner.id,
        proposedAt: '2026-11-01T10:00:00.000Z',
      },
    });
    const confirmedKd: KeyDate = makeSampleKeyDate({
      id: 'KD-STAFF-SVC-CONF',
      matterId: staffMatter.id,
      status: 'confirmed',
      teamId: activeTeam.id,
      responsiblePersonIds: [staffPartner.id, unpermittedPartner.id],
    });
    store.keyDates = [awaitingKd, confirmedKd, ...(store.keyDates ?? [])];

    const verifyRes = await verifyProposedKeyDateRecord(
      awaitingKd.id,
      unpermittedPartner.id,
    );
    expect(verifyRes.ok).toBe(false);
    expect(verifyRes.error).toMatch(/Matter not found or restricted/i);
    expect(awaitingKd.status).toBe('awaiting_verification');

    const resolveRes = await resolveKeyDateOutcomeRecord(
      confirmedKd.id,
      { kind: 'met', note: 'Attempted by outsider' },
      unpermittedPartner.id,
    );
    expect(resolveRes.ok).toBe(false);
    expect(resolveRes.error).toMatch(/Matter not found or restricted/i);
    expect(confirmedKd.status).toBe('confirmed');

    const reassignRes = await reassignKeyDateTeamRecord(
      confirmedKd.id,
      {
        teamId: activeTeam.id,
        responsiblePersonIds: [staffPartner.id, unpermittedPartner.id],
        reason: 'Attempted by outsider',
      },
      unpermittedPartner.id,
    );
    expect(reassignRes.ok).toBe(false);
    expect(reassignRes.error).toMatch(/Matter not found or restricted/i);

    const ackRes = acknowledgeKeyDateReminderRecord(
      confirmedKd.id,
      unpermittedPartner.id,
    );
    expect(ackRes.ok).toBe(false);
    expect(ackRes.error).toMatch(/Matter not found or restricted/i);

    const supersedeRes = await supersedeConfirmedKeyDateRecord(
      confirmedKd.id,
      { dueDate: '2028-01-01' },
      'Attempted by outsider',
      unpermittedPartner.id,
    );
    expect(supersedeRes.ok).toBe(false);
    expect(supersedeRes.error).toMatch(/Matter not found or restricted/i);
    expect(confirmedKd.status).toBe('confirmed');

    // R82: A KeyDate referencing a missing matterId fails closed in services, diary, and exceptions
    const orphanKd: KeyDate = makeSampleKeyDate({
      id: 'KD-ORPHAN-MATTER',
      matterId: 'M-DOES-NOT-EXIST',
      dueDate: '2026-10-01', // past due relative to todayIso '2026-11-01' so past_due_unresolved would fire if not filtered out
      status: 'confirmed',
      teamId: activeTeam.id,
      responsiblePersonIds: [staffPartner.id],
    });
    store.keyDates.push(orphanKd);

    const orphanResolve = await resolveKeyDateOutcomeRecord(
      orphanKd.id,
      { kind: 'met', note: 'Attempted on orphan matter' },
      staffPartner.id,
    );
    expect(orphanResolve.ok).toBe(false);
    expect(orphanResolve.error).toMatch(/Matter not found or restricted/i);

    const diaryEntries = queryTeamDiaryEntries({
      viewer: staffPartner,
      query: {},
      todayIso: '2026-11-01',
      config: { enabled: true },
      keyDates: store.keyDates,
      matters: store.matters,
      people: store.people,
      teams: store.teams,
    });
    expect(diaryEntries.some((e) => e.keyDateId === orphanKd.id)).toBe(false);

    const exceptions = computeKeyDateExceptions({
      viewer: unpermittedPartner,
      todayIso: '2026-11-01',
      config: { enabled: true },
      keyDates: store.keyDates,
      matters: store.matters,
      people: store.people,
      teams: store.teams,
    });
    expect(exceptions.some((e) => e.keyDateId === orphanKd.id)).toBe(false);

    const adminExceptions = computeKeyDateExceptions({
      viewer: staffPartner,
      todayIso: '2026-11-01',
      config: { enabled: true },
      keyDates: store.keyDates,
      matters: store.matters,
      people: store.people,
      teams: store.teams,
    });
    const adminOrphanMatches = adminExceptions.filter(
      (e) => e.keyDateId === orphanKd.id,
    );
    expect(adminOrphanMatches).toHaveLength(1);
    expect(adminOrphanMatches[0]?.kind).toBe('orphan_key_date_missing_matter');
    expect(adminOrphanMatches[0]?.matterId).toBeUndefined();
  });
});
