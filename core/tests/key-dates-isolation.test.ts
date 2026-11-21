import { describe, expect, it, vi } from 'vitest';
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
  createOrProposeKeyDateRecord,
  executeKeyDateRemindersForTenant,
  getIntakeQuoteRepository,
  getKeyDatesConfig,
  getMatterRepository,
  getPartyRepository,
  getTaskWorkflowRepository,
  proposeProvisionalKeyDateRecord,
  reassignKeyDateTeamRecord,
  recordKeyDateNotApplicableRecord,
  rejectProposedKeyDateRecord,
  resetAllDemoData,
  resolveKeyDateOutcomeRecord,
  saveKeyDatesConfigRecord,
  saveMatterRecord,
  supersedeConfirmedKeyDateRecord,
  verifyProposedKeyDateRecord,
} from '../../src/server/services';
import {
  computeKeyDateExceptions,
  queryTeamDiaryEntries,
} from '../../src/server/rbacRuntime';
import {
  buildKeyDateReminderIdempotencyKey,
  isVerificationRequiredForKeyDate,
  resolveMatterTypeCalendarSyncPolicy,
} from '../../src/domain/keyDates';
import type { KeyDatesConfig } from '../../src/domain/keyDates.types';
import { calculateLimitationDate } from '../../src/domain/keyDateCalculator';
import type { Enquiry, Matter, Person, Task } from '../../src/domain/types';
import { getDocumentRepository } from '../../src/server/documentGenerationServices';
import { loadCommittedSeedStore } from '../../src/seed/seedSnapshot';
import { testDataResetContext } from '../../src/test/testTenantContexts';
import {
  auditEntriesSince,
  getKeyDateRepository,
  markAuditPosition,
  runAsTestActor,
  testTenantCtx,
} from '../../src/server/testSupport/auditTestSupport';

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
  it('applies and rolls back migration 0003_key_dates_expand per tenant independently while retaining key_date_audit_events (R39, R48)', async () => {
    const runner = new TenantMigrationRunner();
    const ctxA = createVerifiedTenantContext('tenant-alpha');
    const ctxB = createVerifiedTenantContext('tenant-bravo');

    try {
      for (const v of [...CORE_TENANT_MIGRATIONS.map((m) => m.version)].reverse()) {
        await runner.rollbackVersion(ctxA, v);
        await runner.rollbackVersion(ctxB, v);
      }

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
      expect(
        KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004.downSql,
      ).toContain(
        'DROP CONSTRAINT IF EXISTS chk_key_date_reminder_states_last_skipped_reason',
      );
      expect(
        KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004.downSql,
      ).toContain('DROP COLUMN IF EXISTS last_skipped_reason');

      // R145: Applying 0004 without its prerequisite 0003 throws MIGRATION_DEPENDENCY_ERROR
      await expect(
        runner.applyUp(ctxB, [
          KEY_DATES_REMINDER_LAST_SKIPPED_REASON_MIGRATION_0004,
        ]),
      ).rejects.toThrow(/MIGRATION_DEPENDENCY_ERROR/);

      const appliedA = await runner.applyUp(ctxA, CORE_TENANT_MIGRATIONS);
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
      expect(await runner.getActiveTables(ctxA)).toContain('key_dates');
      expect(await runner.getActiveTables(ctxA)).toContain('key_date_reminder_states');
      expect(await runner.getActiveTables(ctxA)).toContain('key_date_audit_events');
      expect(await runner.getActiveTables(ctxB)).not.toContain('key_dates');

      // R145: Rolling back post-0005 migrations + 0002 leaves key-date tables intact
      for (const v of [...CORE_TENANT_MIGRATIONS.map((m) => m.version)]
        .filter((x) => x >= '0006')
        .reverse()) {
        expect(await runner.rollbackVersion(ctxA, v)).toBe(true);
      }
      expect(await runner.rollbackVersion(ctxA, '0002')).toBe(true);
      expect(await runner.getActiveTables(ctxA)).toContain('key_dates');
      expect(await runner.getActiveTables(ctxA)).toContain('key_date_reminder_states');

      // R124 & R145: Attempting to roll back 0003 while 0004 and 0005 still depend on it throws MIGRATION_ROLLBACK_ORDER_ERROR
      await expect(runner.rollbackVersion(ctxA, '0003')).rejects.toThrow(
        /MIGRATION_ROLLBACK_ORDER_ERROR/,
      );
      expect(await runner.getActiveTables(ctxA)).toContain('key_dates');

      expect(await runner.rollbackVersion(ctxA, '0005')).toBe(true);
      const rolledBack0004 = await runner.rollbackVersion(ctxA, '0004');
      expect(rolledBack0004).toBe(true);
      expect(await runner.getActiveTables(ctxA)).toContain('key_date_reminder_states');

      const rolledBack = await runner.rollbackVersion(
        ctxA,
        '0003_key_dates_expand',
      );
      expect(rolledBack).toBe(true);
      expect(await runner.getActiveTables(ctxA)).not.toContain('key_dates');
      expect(await runner.getActiveTables(ctxA)).toContain('key_date_audit_events');
    } finally {
      await runner.applyUp(ctxA, CORE_TENANT_MIGRATIONS);
      await runner.applyUp(ctxB, CORE_TENANT_MIGRATIONS);
    }
  });

  it('isolates KeyDate, ReminderState, CalendarSync, NotApplicable, and AuditEvent records between Tenant A and Tenant B, including tampered record IDs and cross-tenant writes (R30, R31)', async () => {
    const repo = new TenantKeyDateRepository();
    const ctxA = createVerifiedTenantContext('tenant-alpha', 'P-ALPHA-1');
    const ctxB = createVerifiedTenantContext('tenant-bravo', 'P-BRAVO-1');

    await repo.setMatterRestriction(ctxA, {
      matterId: 'M-ALPHA-001',
      isRestricted: false,
      restrictedAccessUserIds: [],
    });

    const kdAlpha = makeSampleKeyDate({
      id: 'KD-SHARED-ID-001',
      matterId: 'M-ALPHA-001',
      title: 'Alpha Limitation',
    });
    await repo.putKeyDate(ctxA, kdAlpha);
    await repo.putReminderState(ctxA, {
      keyDateId: kdAlpha.id,
      taskId: 'TSK-ALPHA-001',
      idempotencyKey: `keydate-reminder:tenant-alpha:${kdAlpha.id}`,
      reminderScheduleId: 'limitation',
      currentStageDaysBefore: 90,
      stageEnteredAt: '2026-11-03T00:00:00.000Z',
      escalationLevel: 0,
      lastSkippedReason: 'no_permitted_assignees',
    });
    expect((await repo.getReminderState(ctxA, kdAlpha.id))?.lastSkippedReason).toBe(
      'no_permitted_assignees',
    );
    await expect(repo.putReminderState(ctxA, {
        keyDateId: kdAlpha.id,
        taskId: 'TSK-ALPHA-001',
        idempotencyKey: `keydate-reminder:tenant-alpha:${kdAlpha.id}`,
        reminderScheduleId: 'limitation',
        currentStageDaysBefore: 90,
        stageEnteredAt: '2026-11-03T00:00:00.000Z',
        escalationLevel: 0,
        lastSkippedReason: 'forged_reason' as unknown as 'no_permitted_assignees',
      })).rejects.toThrow(/KEY_DATE_VALIDATION_ERROR/);
    await repo.putCalendarSync(ctxA, {
      keyDateId: kdAlpha.id,
      externalEvents: [{ target: 'person:P-ALPHA-1', eventId: 'evt-alpha-1' }],
      state: 'synced',
      lastSyncedAt: '2026-11-03T00:00:00.000Z',
      attempts: 1,
    });
    await repo.putNotApplicable(ctxA, {
      matterId: 'M-ALPHA-001',
      keyDateTypeId: 'undertaking',
      reason: 'No undertaking given on this matter',
      recordedById: 'P-ALPHA-1',
      recordedAt: '2026-11-03T00:00:00.000Z',
    });
    await repo.appendAuditEvent(ctxA, {
      id: 'AU-KD-ALPHA-1',
      keyDateId: kdAlpha.id,
      matterId: 'M-ALPHA-001',
      action: 'keydate-create',
      actorId: 'P-ALPHA-1',
      occurredAt: '2026-11-03T00:00:00.000Z',
      correlationId: ctxA.correlationId,
    });

    // Tenant B attempting to fetch Tenant A's records by tampered ID gets null / empty
    expect(await repo.getKeyDateById(ctxB, 'KD-SHARED-ID-001')).toBeNull();
    expect(await repo.getReminderState(ctxB, 'KD-SHARED-ID-001')).toBeNull();
    expect(await repo.getCalendarSync(ctxB, 'KD-SHARED-ID-001')).toBeNull();
    expect(await repo.listKeyDatesForMatter(ctxB, 'M-ALPHA-001')).toEqual([]);
    expect(await repo.listNotApplicableForMatter(ctxB, 'M-ALPHA-001')).toEqual([]);
    expect(
      await repo.listAuditEvents(ctxB, { keyDateId: 'KD-SHARED-ID-001' }),
    ).toEqual([]);
    expect(
      await repo.queryKeyDatesForDiary(ctxB, {
        teamIds: ['TM-000001'],
        from: '2026-01-01',
        to: '2028-12-31',
      }),
    ).toEqual([]);

    // Tenant B attempting to write ReminderState or CalendarSync referencing Tenant A's keyDateId or unregistered matter is rejected
    await expect(repo.putReminderState(ctxB, {
        keyDateId: 'KD-SHARED-ID-001',
        taskId: 'TSK-BRAVO-FORGED',
        idempotencyKey: 'keydate-reminder:tenant-bravo:KD-SHARED-ID-001',
        reminderScheduleId: 'limitation',
        currentStageDaysBefore: 30,
        stageEnteredAt: '2026-11-03T00:00:00.000Z',
        escalationLevel: 0,
      })).rejects.toThrow(/KEY_DATE_NOT_FOUND/);
    await expect(repo.putCalendarSync(ctxB, {
        keyDateId: 'KD-SHARED-ID-001',
        externalEvents: [],
        state: 'disabled',
        attempts: 0,
      })).rejects.toThrow(/KEY_DATE_NOT_FOUND/);
    await expect(repo.putKeyDate(ctxB, {
        ...kdAlpha,
        title: 'Bravo Forged Overwrite',
      })).rejects.toThrow(/KEY_DATE_ACCESS_DENIED/);

    // Tenant A sees its own records
    expect((await repo.getKeyDateById(ctxA, 'KD-SHARED-ID-001'))?.title).toBe(
      'Alpha Limitation',
    );
    expect((await repo.getReminderState(ctxA, 'KD-SHARED-ID-001'))?.taskId).toBe(
      'TSK-ALPHA-001',
    );
    expect((await repo.getCalendarSync(ctxA, 'KD-SHARED-ID-001'))?.state).toBe('synced');
    expect(
      await repo.listAuditEvents(ctxA, { keyDateId: 'KD-SHARED-ID-001' }),
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
    ).toThrow(
      'TENANCY_CLAIM_ERROR: Authenticated token is missing a valid tenantId claim.',
    );

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
    ).toThrow(
      'TENANCY_FORGERY_DETECTED: Request attempted to override authenticated token tenantId.',
    );

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
    ).toThrow(
      'TENANCY_JOB_ERROR: Background job refused to run without a valid tenantId.',
    );
  });

  it('omits restricted (staff) matters at the data layer unless viewer is in matter.restrictedAccessUserIds', async () => {
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

    await repo.clearTenantData(ctxAuthorised);
    await repo.setMatterRestriction(ctxAuthorised, {
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
    await repo.putKeyDate(ctxAuthorised, staffKeyDate);

    // Authorised participant in restrictedAccessUserIds sees the key date
    expect(await repo.getKeyDateById(ctxAuthorised, 'KD-STAFF-001')).not.toBeNull();
    expect(
      await repo.queryKeyDatesForDiary(ctxAuthorised, {
        teamIds: ['TM-000001'],
        from: '2026-01-01',
        to: '2028-12-31',
      }),
    ).toHaveLength(1);

    // Unauthorised viewer (even with risk_compliance role) receives null / empty list with no placeholder
    expect(
      await repo.getKeyDateById(ctxUnauthorisedCompliance, 'KD-STAFF-001'),
    ).toBeNull();
    expect(
      await repo.listKeyDatesForMatter(ctxUnauthorisedCompliance, 'M-STAFF-001'),
    ).toEqual([]);
    expect(
      await repo.queryKeyDatesForDiary(ctxUnauthorisedCompliance, {
        teamIds: ['TM-000001'],
        from: '2026-01-01',
        to: '2028-12-31',
      }),
    ).toEqual([]);

    // Unpermitted user in the same tenant calling putKeyDate on a staff-matter key date gets an error (R31)
    await expect(repo.putKeyDate(ctxUnauthorisedCompliance, {
        ...staffKeyDate,
        title: 'Tampered Title',
      })).rejects.toThrow(/KEY_DATE_ACCESS_DENIED/);

    // Changing matterId on an existing KeyDate is rejected (R31)
    await repo.setMatterRestriction(ctxAuthorised, {
      matterId: 'M-OTHER-002',
      isRestricted: false,
      restrictedAccessUserIds: [],
    });
    await expect(repo.putKeyDate(ctxAuthorised, {
        ...staffKeyDate,
        matterId: 'M-OTHER-002',
      })).rejects.toThrow(/KEY_DATE_ENTITY_IMMUTABLE/);
  });

  it('rejects unpermitted callers across verify, resolve, reassign, acknowledge, and supersede services on a staff-matter key date with no state change (R30, R82)', async () => {
    const store = loadCommittedSeedStore();
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
    const kdRepo = getKeyDateRepository();
    const staffCtx = testTenantCtx(staffPartner.id);
    await getMatterRepository().putMatter(staffCtx, staffMatter, {
      expectedRowVersion: null,
    });
    await kdRepo.setMatterRestriction(staffCtx, {
      matterId: staffMatter.id,
      isRestricted: true,
      restrictedAccessUserIds: [staffPartner.id],
    });
    await kdRepo.putKeyDate(staffCtx, awaitingKd);
    await kdRepo.putKeyDate(staffCtx, confirmedKd);
    const readStatus = async (id: string) =>
      (await kdRepo.getKeyDateById(staffCtx, id, staffPartner.id))?.status;

    const verifyRes = await runAsTestActor(unpermittedPartner.id, () =>
      verifyProposedKeyDateRecord(
        awaitingKd.id,
        unpermittedPartner.id,
      ),
    );
    expect(verifyRes.ok).toBe(false);
    expect(verifyRes.error).toMatch(/Matter not found or restricted/i);
    expect(await readStatus(awaitingKd.id)).toBe('awaiting_verification');

    const resolveRes = await runAsTestActor(unpermittedPartner.id, () =>
      resolveKeyDateOutcomeRecord(
        confirmedKd.id,
        { kind: 'met', note: 'Attempted by outsider' },
        unpermittedPartner.id,
      ),
    );
    expect(resolveRes.ok).toBe(false);
    expect(resolveRes.error).toMatch(/Matter not found or restricted/i);
    expect(await readStatus(confirmedKd.id)).toBe('confirmed');

    const reassignRes = await runAsTestActor(unpermittedPartner.id, () =>
      reassignKeyDateTeamRecord(
        confirmedKd.id,
        {
          teamId: activeTeam.id,
          responsiblePersonIds: [staffPartner.id, unpermittedPartner.id],
          reason: 'Attempted by outsider',
        },
        unpermittedPartner.id,
      ),
    );
    expect(reassignRes.ok).toBe(false);
    expect(reassignRes.error).toMatch(/Matter not found or restricted/i);

    const ackRes = await runAsTestActor(unpermittedPartner.id, () =>
      acknowledgeKeyDateReminderRecord(
        confirmedKd.id,
        unpermittedPartner.id,
      ),
    );
    expect(ackRes.ok).toBe(false);
    expect(ackRes.error).toMatch(/Matter not found or restricted/i);

    const supersedeRes = await runAsTestActor(unpermittedPartner.id, () =>
      supersedeConfirmedKeyDateRecord(
        confirmedKd.id,
        { dueDate: '2028-01-01' },
        'Attempted by outsider',
        unpermittedPartner.id,
      ),
    );
    expect(supersedeRes.ok).toBe(false);
    expect(supersedeRes.error).toMatch(/Matter not found or restricted/i);
    expect(await readStatus(confirmedKd.id)).toBe('confirmed');

    // R82: A KeyDate referencing a missing matterId fails closed in services, diary, and exceptions
    const orphanKd: KeyDate = makeSampleKeyDate({
      id: 'KD-ORPHAN-MATTER',
      matterId: 'M-DOES-NOT-EXIST',
      dueDate: '2026-10-01', // past due relative to todayIso '2026-11-01' so past_due_unresolved would fire if not filtered out
      status: 'confirmed',
      teamId: activeTeam.id,
      responsiblePersonIds: [staffPartner.id],
    });
    // The repository only accepts writes for matters it has restriction metadata for, so register the
    // orphan matter id as unrestricted metadata; it remains absent from the matter store.
    await kdRepo.setMatterRestriction(staffCtx, {
      matterId: 'M-DOES-NOT-EXIST',
      isRestricted: false,
      restrictedAccessUserIds: [],
    });
    await kdRepo.putKeyDate(staffCtx, orphanKd);
    expect(store.matters.some((m) => m.id === 'M-DOES-NOT-EXIST')).toBe(false);
    const allKeyDates = await kdRepo.listKeyDatesForExceptionsReport(
      staffCtx,
      staffPartner.id,
      { includeMissingMatterOrphans: true },
    );
    expect(allKeyDates.some((k) => k.id === orphanKd.id)).toBe(true);

    const orphanResolve = await runAsTestActor(staffPartner.id, () =>
      resolveKeyDateOutcomeRecord(
        orphanKd.id,
        { kind: 'met', note: 'Attempted on orphan matter' },
        staffPartner.id,
      ),
    );
    expect(orphanResolve.ok).toBe(false);
    expect(orphanResolve.error).toMatch(/Matter not found or restricted/i);

    const diaryEntries = queryTeamDiaryEntries({
      viewer: staffPartner,
      query: {},
      todayIso: '2026-11-01',
      config: { enabled: true },
      keyDates: allKeyDates,
      matters: store.matters,
      people: store.people,
      teams: store.teams,
    });
    expect(diaryEntries.some((e) => e.keyDateId === orphanKd.id)).toBe(false);

    const exceptions = computeKeyDateExceptions({
      viewer: unpermittedPartner,
      todayIso: '2026-11-01',
      config: { enabled: true },
      keyDates: allKeyDates,
      matters: store.matters,
      people: store.people,
      teams: store.teams,
    });
    expect(exceptions.some((e) => e.keyDateId === orphanKd.id)).toBe(false);

    const adminExceptions = computeKeyDateExceptions({
      viewer: staffPartner,
      todayIso: '2026-11-01',
      config: { enabled: true },
      keyDates: allKeyDates,
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

  it('R577: double concurrent verifyProposedKeyDateRecord commits only one verification and one reminder task while preserving two-tenant isolation', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const kdRepo = getKeyDateRepository();
    const ctx = testTenantCtx('P-000001', {
      roles: ['admin', 'managing_partner'],
      mfaVerified: true,
    });
    const ctxB = createVerifiedTenantContext('tenant-bravo', 'P-BRAVO-1');

    try {
      const matters =
        await getMatterRepository().listAllMattersUnfiltered<Matter>(ctx);
      const people = await getPartyRepository().listAllPeople<Person>(ctx);
      const kdConfig = await getKeyDatesConfig({ ctx, userId: 'P-000001' });
      const kdType = (kdConfig.keyDateTypes ?? []).find(
        (t) => t.allowManualEntry !== false,
      )!;
      const targetMatter =
        matters.find(
          (m) =>
            !m.isStaffMatter &&
            isVerificationRequiredForKeyDate(
              kdConfig,
              m.matterTypeId || m.practiceAreaId,
              { category: kdType.category, isCritical: Boolean(kdType.defaultCritical) },
            ),
        ) ?? matters.find((m) => !m.isStaffMatter)!;
      const verifiers = people.filter(
        (p) =>
          p.isEmployee &&
          p.id !== 'P-000001' &&
          (p.roles?.includes('partner') || p.roles?.includes('managing_partner')),
      );
      const verifierOne = verifiers[0]!;
      const verifierTwo = verifiers[1] ?? verifierOne;

      const ruleSet = kdConfig.limitationRuleSets![0]!;
      const rule = ruleSet.rules[0]!;
      const calendar = (kdConfig.businessCalendars ?? []).find(
        (c) => c.id === rule.calendarId,
      );
      const calc = calculateLimitationDate(
        rule,
        { accrualDate: '2021-09-15' },
        calendar,
        { ruleSetReviewStatus: ruleSet.reviewStatus },
      );

      const created = await runAsTestActor(
        'P-000001',
        () =>
          createOrProposeKeyDateRecord(
            {
              matterId: targetMatter.id,
              keyDateTypeId: kdType.id,
              title: 'R577 Double Verify Concurrency Test',
              dueDate: calc.date,
              source: 'calculated',
              calculation: {
                ruleSetId: ruleSet.id,
                ruleSetVersion: ruleSet.version,
                ruleSetReviewStatus: ruleSet.reviewStatus,
                ruleId: rule.id,
                triggers: { accrualDate: '2021-09-15' },
                calculatedDate: calc.date,
                overridden: false,
                explanation: calc.explanation,
              },
              intent: 'propose',
            },
            'P-000001',
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(created.ok).toBe(true);
      expect(created.keyDate?.status).toBe('awaiting_verification');
      const kdId = created.keyDate!.id;

      // Seed an independent awaiting_verification key date in Tenant Bravo
      await kdRepo.setMatterRestriction(ctxB, {
        matterId: 'M-BRAVO-R577',
        isRestricted: false,
        restrictedAccessUserIds: [],
      });
      await kdRepo.putKeyDate(
        ctxB,
        makeSampleKeyDate({
          id: 'KD-BRAVO-R577-001',
          matterId: 'M-BRAVO-R577',
          status: 'awaiting_verification',
        }),
      );

      const [res1, res2] = await Promise.all([
        runAsTestActor(
          verifierOne.id,
          () => verifyProposedKeyDateRecord(kdId, verifierOne.id),
          { roles: verifierOne.roles ?? ['partner'], mfaVerified: true },
        ),
        runAsTestActor(
          verifierTwo.id,
          () => verifyProposedKeyDateRecord(kdId, verifierTwo.id),
          { roles: verifierTwo.roles ?? ['partner'], mfaVerified: true },
        ),
      ]);

      const okCount = [res1, res2].filter((r) => r.ok).length;
      const failResults = [res1, res2].filter((r) => !r.ok);
      expect(okCount).toBe(1);
      expect(failResults).toHaveLength(1);
      expect(failResults[0]?.error).toMatch(
        /KEY_DATE_VERIFY_ERROR|KEY_DATE_CONCURRENCY_CONFLICT|awaiting_verification/i,
      );

      const idempKey = buildKeyDateReminderIdempotencyKey(kdId, ctx.tenantId);
      const tasks =
        await getTaskWorkflowRepository().listAllTasksUnfiltered<Task>(ctx);
      const createdReminderTasks = tasks.filter(
        (t) => t.idempotencyKey === idempKey,
      );
      expect(createdReminderTasks).toHaveLength(1);

      expect(await kdRepo.getKeyDateById(ctxB, kdId)).toBeNull();
      expect(
        (await kdRepo.getKeyDateById(ctxB, 'KD-BRAVO-R577-001'))?.status,
      ).toBe('awaiting_verification');
    } finally {
      await kdRepo.clearTenantData(ctxB);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R577: putKeyDate rejects stale expectedVersion with KEY_DATE_CONCURRENCY_CONFLICT and concurrent reject vs verify never overwrites committed state across two tenants', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const kdRepo = getKeyDateRepository();
    const ctx = testTenantCtx('P-000001', {
      roles: ['admin', 'managing_partner'],
      mfaVerified: true,
    });
    const ctxB = createVerifiedTenantContext('tenant-bravo', 'P-BRAVO-1');

    try {
      const matters =
        await getMatterRepository().listAllMattersUnfiltered<Matter>(ctx);
      const people = await getPartyRepository().listAllPeople<Person>(ctx);
      const kdConfig = await getKeyDatesConfig({ ctx, userId: 'P-000001' });
      const kdType = (kdConfig.keyDateTypes ?? []).find(
        (t) => t.allowManualEntry !== false,
      )!;
      const targetMatter =
        matters.find(
          (m) =>
            !m.isStaffMatter &&
            isVerificationRequiredForKeyDate(
              kdConfig,
              m.matterTypeId || m.practiceAreaId,
              { category: kdType.category, isCritical: Boolean(kdType.defaultCritical) },
            ),
        ) ?? matters.find((m) => !m.isStaffMatter)!;
      const verifier = people.find(
        (p) =>
          p.isEmployee &&
          p.id !== 'P-000001' &&
          (p.roles?.includes('partner') || p.roles?.includes('managing_partner')),
      )!;

      const ruleSet = kdConfig.limitationRuleSets![0]!;
      const rule = ruleSet.rules[0]!;
      const calendar = (kdConfig.businessCalendars ?? []).find(
        (c) => c.id === rule.calendarId,
      );
      const calc = calculateLimitationDate(
        rule,
        { accrualDate: '2021-10-11' },
        calendar,
        { ruleSetReviewStatus: ruleSet.reviewStatus },
      );

      // 1. Provisional -> propose bumps version to 2; direct stale write (expectedVersion: 1) must reject
      const provisional = await runAsTestActor(
        'P-000001',
        () =>
          createOrProposeKeyDateRecord(
            {
              matterId: targetMatter.id,
              keyDateTypeId: kdType.id,
              title: 'R577 Stale Version & Re-proposal Race',
              dueDate: calc.date,
              source: 'calculated',
              calculation: {
                ruleSetId: ruleSet.id,
                ruleSetVersion: ruleSet.version,
                ruleSetReviewStatus: ruleSet.reviewStatus,
                ruleId: rule.id,
                triggers: { accrualDate: '2021-10-11' },
                calculatedDate: calc.date,
                overridden: false,
                explanation: calc.explanation,
              },
              intent: 'provisional',
            },
            'P-000001',
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(provisional.ok).toBe(true);
      const staleV1Snapshot = structuredClone(provisional.keyDate!);

      const proposed = await runAsTestActor(
        'P-000001',
        () =>
          proposeProvisionalKeyDateRecord(staleV1Snapshot.id, 'P-000001'),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(proposed.ok).toBe(true);
      expect(proposed.keyDate?.version).toBe(2);

      await expect(
        kdRepo.putKeyDate(
          ctx,
          { ...staleV1Snapshot, status: 'confirmed', version: 2 },
          { expectedVersion: 1 },
        ),
      ).rejects.toThrow(/KEY_DATE_CONCURRENCY_CONFLICT/);

      // 2. Concurrent reject vs verify on the awaiting_verification row: only one commits; winner is preserved
      const [rejectRes, verifyRes] = await Promise.all([
        runAsTestActor(
          verifier.id,
          () =>
            rejectProposedKeyDateRecord(
              staleV1Snapshot.id,
              'Due date needs correction before approval',
              verifier.id,
            ),
          { roles: verifier.roles ?? ['partner'], mfaVerified: true },
        ),
        runAsTestActor(
          verifier.id,
          () => verifyProposedKeyDateRecord(staleV1Snapshot.id, verifier.id),
          { roles: verifier.roles ?? ['partner'], mfaVerified: true },
        ),
      ]);

      expect([rejectRes, verifyRes].filter((r) => r.ok)).toHaveLength(1);
      expect([rejectRes, verifyRes].filter((r) => !r.ok)).toHaveLength(1);
      const finalKd = await kdRepo.getKeyDateById(
        ctx,
        staleV1Snapshot.id,
        'P-000001',
      );
      expect(finalKd?.status).toBe(rejectRes.ok ? 'provisional' : 'confirmed');
      if (rejectRes.ok) {
        expect(finalKd?.verification?.rejectedById).toBe(verifier.id);
      }
      expect(await kdRepo.getKeyDateById(ctxB, staleV1Snapshot.id)).toBeNull();
    } finally {
      await kdRepo.clearTenantData(ctxB);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R577: syncKeyDateToOutlookCalendar runs strictly after DB commit and makes zero Graph calls when transaction rolls back', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const kdRepo = getKeyDateRepository();
    const ctx = testTenantCtx('P-000001', {
      roles: ['admin', 'managing_partner'],
      mfaVerified: true,
    });
    const origPutKeyDate = kdRepo.putKeyDate.bind(kdRepo);

    try {
      const store = loadCommittedSeedStore();
      const kdConfig = await getKeyDatesConfig({ ctx, userId: 'P-000001' });
      const targetMatter = store.matters.find(
        (m) =>
          !m.isStaffMatter &&
          resolveMatterTypeCalendarSyncPolicy(
            kdConfig,
            m.matterTypeId || m.practiceAreaId,
            false,
          ).enabled,
      )!;
      const teams = store.teams.filter((t) => t.active);
      const secondTeam = teams[1] ?? teams[0]!;
      const kdType = (kdConfig.keyDateTypes ?? []).find(
        (t) => t.allowManualEntry !== false,
      )!;
      const partner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== 'P-000001' &&
          (p.roles?.includes('partner') || p.roles?.includes('managing_partner')),
      )!;

      const created = await runAsTestActor(
        'P-000001',
        () =>
          createOrProposeKeyDateRecord(
            {
              matterId: targetMatter.id,
              keyDateTypeId: kdType.id,
              title: 'R577 Post-Commit Calendar Sync Key Date',
              dueDate: '2027-11-20',
              intent: 'propose',
            },
            'P-000001',
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(created.ok).toBe(true);
      if (created.keyDate!.status === 'awaiting_verification') {
        const v = await runAsTestActor(
          partner.id,
          () => verifyProposedKeyDateRecord(created.keyDate!.id, partner.id),
          { roles: partner.roles ?? ['partner'], mfaVerified: true },
        );
        expect(v.ok).toBe(true);
      }
      const kdId = created.keyDate!.id;

      let noLockHeldTeamIdDuringGraphCall: string | undefined;
      const calendarAdapter = {
        credentialSource: 'managed_identity' as const,
        isConfigured: true,
        upsertEvent: vi.fn(async () => {
          // Prove no PostgreSQL transaction or row lock is held across the Graph HTTP call (R617)
          const rowDuringGraph = await kdRepo.withTenantTransaction(
            ctx,
            async (tx) => {
              const res = await tx.query<{ id: string; team_id: string }>(
                'SELECT id, team_id FROM key_dates WHERE tenant_id = $1 AND id = $2 FOR UPDATE NOWAIT',
                [ctx.tenantId, kdId],
              );
              return res.rows[0] ?? null;
            },
          );
          noLockHeldTeamIdDuringGraphCall = rowDuringGraph?.team_id;
          return { eventId: 'graph-evt-r577-1' };
        }),
        deleteEvent: vi.fn(async () => undefined),
      };

      // Force DB transaction abort on putKeyDate -> Graph must NOT be called
      let shouldFailOnce = true;
      kdRepo.putKeyDate = async (callCtx, kdArg, opts) => {
        if (shouldFailOnce) {
          shouldFailOnce = false;
          throw new Error('SIMULATED_KEY_DATE_TX_ABORT');
        }
        return origPutKeyDate(callCtx, kdArg, opts);
      };

      const abortedRes = await runAsTestActor(
        'P-000001',
        () =>
          reassignKeyDateTeamRecord(
            kdId,
            { teamId: secondTeam.id, reason: 'Rollback calendar isolation test' },
            'P-000001',
            { calendarAdapter },
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(abortedRes.ok).toBe(false);
      expect(calendarAdapter.upsertEvent).not.toHaveBeenCalled();
      expect(calendarAdapter.deleteEvent).not.toHaveBeenCalled();

      // Now let DB commit succeed -> Graph runs strictly AFTER commit without holding DB locks and sync state is persisted
      kdRepo.putKeyDate = origPutKeyDate;
      const committedRes = await runAsTestActor(
        'P-000001',
        () =>
          reassignKeyDateTeamRecord(
            kdId,
            { teamId: secondTeam.id, reason: 'Post-commit calendar sync test' },
            'P-000001',
            { calendarAdapter },
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(committedRes.ok).toBe(true);
      expect(calendarAdapter.upsertEvent).toHaveBeenCalled();
      expect(noLockHeldTeamIdDuringGraphCall).toBe(secondTeam.id);
      const savedSync = await kdRepo.getCalendarSync(ctx, kdId, 'P-000001');
      expect(savedSync?.state).toBe('synced');
      expect(savedSync?.externalEvents.length).toBeGreaterThan(0);
    } finally {
      kdRepo.putKeyDate = origPutKeyDate;
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R590: removes dead compensation helpers (undoDelta, deleteKeyDateByIdForCompensation, allowEntityRebindForCompensation) while keeping entity immutability enforced', async () => {
    const kdRepo = getKeyDateRepository();
    const docRepo = getDocumentRepository();
    const ctx = testTenantCtx('P-000001');

    expect('deleteKeyDateByIdForCompensation' in kdRepo).toBe(false);

    const repointRes = await docRepo.repointMergedEntityWithDelta(
      ctx,
      'person',
      'P-NO-SUCH-MERGED',
      'P-000001',
    );
    expect(repointRes).toEqual({ updatedCount: 0 });
    expect('undoDelta' in repointRes).toBe(false);

    const seed = loadCommittedSeedStore();
    const matter = seed.matters[0]!;
    const existingKd = (
      await kdRepo.listKeyDatesForMatter(ctx, matter.id, 'P-000001')
    )[0] ?? makeSampleKeyDate({ id: 'KD-R590-IMMUTABLE', matterId: matter.id });
    if (!(await kdRepo.getKeyDateById(ctx, existingKd.id, 'P-000001'))) {
      await kdRepo.putKeyDate(ctx, existingKd);
    }
    const otherMatter = seed.matters.find((m) => m.id !== matter.id && !m.isStaffMatter)!;
    await expect(
      kdRepo.putKeyDate(
        ctx,
        { ...existingKd, matterId: otherMatter.id },
        { allowEntityRebindForCompensation: true } as never,
      ),
    ).rejects.toThrow(/KEY_DATE_ENTITY_IMMUTABLE/);
  });

  it('R606 & R607: post-commit calendar sync failure returns ok:true + warning without duplicating key dates, emits PII-free log, and detects concurrent skew without holding DB locks', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const kdRepo = getKeyDateRepository();
    const ctx = testTenantCtx('P-000001', {
      roles: ['admin', 'managing_partner'],
      mfaVerified: true,
    });
    const ctxB = createVerifiedTenantContext('tenant-bravo', 'P-BRAVO-1');

    try {
      const store = loadCommittedSeedStore();
      const kdConfig = await getKeyDatesConfig({ ctx, userId: 'P-000001' });
      const targetMatter = store.matters.find(
        (m) =>
          !m.isStaffMatter &&
          resolveMatterTypeCalendarSyncPolicy(
            kdConfig,
            m.matterTypeId || m.practiceAreaId,
            false,
          ).enabled,
      )!;
      const teams = store.teams.filter((t) => t.active);
      const firstTeam = teams[0]!;
      const secondTeam = teams[1] ?? teams[0]!;
      const kdType = (kdConfig.keyDateTypes ?? []).find(
        (t) => t.allowManualEntry !== false,
      )!;
      const partner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== 'P-000001' &&
          (p.roles?.includes('partner') || p.roles?.includes('managing_partner')),
      )!;

      const created = await runAsTestActor(
        'P-000001',
        () =>
          createOrProposeKeyDateRecord(
            {
              matterId: targetMatter.id,
              keyDateTypeId: kdType.id,
              title: 'R606 R607 Sync Resilience Key Date',
              dueDate: '2027-12-01',
              teamId: firstTeam.id,
              responsiblePersonIds: ['P-000001'],
              notes: 'Client Alice Sensitive Note Should Never Log',
              intent: 'propose',
            },
            'P-000001',
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(created.ok).toBe(true);
      if (created.keyDate!.status === 'awaiting_verification') {
        const verified = await runAsTestActor(
          partner.id,
          () => verifyProposedKeyDateRecord(created.keyDate!.id, partner.id),
          { roles: partner.roles ?? ['partner'], mfaVerified: true },
        );
        expect(verified.ok).toBe(true);
      }
      const kdId = created.keyDate!.id;

      // 1. R606: failing calendar adapter still commits mutation once, warns caller, marks failed sync, and logs zero PII
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failingAdapter = {
        credentialSource: 'managed_identity' as const,
        isConfigured: true,
        upsertEvent: vi.fn(async () => {
          throw new Error(
            'GRAPH_503 user@client.example.invalid "Confidential Client Matter Title"',
          );
        }),
        deleteEvent: vi.fn(async () => undefined),
      };

      const failRes = await runAsTestActor(
        'P-000001',
        () =>
          reassignKeyDateTeamRecord(
            kdId,
            {
              teamId: secondTeam.id,
              responsiblePersonIds: ['P-000001'],
              reason: 'R606 failing adapter check',
            },
            'P-000001',
            { calendarAdapter: failingAdapter },
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(failRes.ok).toBe(true);
      expect(failRes.keyDate?.teamId).toBe(secondTeam.id);
      expect(
        (failRes as { calendarSyncWarning?: string }).calendarSyncWarning,
      ).toBeTruthy();

      const allMatterKds = await kdRepo.listKeyDatesForMatter(
        ctx,
        targetMatter.id,
        'P-000001',
      );
      expect(
        allMatterKds.filter((k) => k.title === 'R606 R607 Sync Resilience Key Date'),
      ).toHaveLength(1);
      const failedSync = await kdRepo.getCalendarSync(ctx, kdId, 'P-000001');
      expect(failedSync?.state).toBe('failed');
      expect(failedSync?.attempts).toBeGreaterThanOrEqual(1);
      expect(failedSync?.lastError).not.toContain('user@client.example.invalid');
      expect(failedSync?.lastError).not.toContain('Confidential Client Matter Title');

      const syncWarnLogs = warnSpy.mock.calls
        .map((c) => String(c[0] ?? ''))
        .filter((s) => s.includes('keydate.calendar_sync_failed'));
      expect(syncWarnLogs.length).toBeGreaterThanOrEqual(1);
      const parsedWarn = JSON.parse(syncWarnLogs[0]!) as {
        tenantId?: string;
        correlationId?: string;
      };
      expect(parsedWarn.tenantId).toBe(ctx.tenantId);
      expect(typeof parsedWarn.correlationId).toBe('string');
      expect(parsedWarn.correlationId!.length).toBeGreaterThan(0);
      expect(syncWarnLogs[0]).not.toContain('Alice');
      expect(syncWarnLogs[0]).not.toContain('user@client.example.invalid');
      warnSpy.mockRestore();

      // 2. R607: concurrent mutation during in-flight Graph sync re-reads latest state and converges without losing external events
      let slowCallCount = 0;
      const slowUpsertTargets: string[] = [];
      let releaseSlowFirstCall: (() => void) | null = null;
      const firstSlowCallStarted = new Promise<void>((resolve) => {
        releaseSlowFirstCall = resolve;
      });
      void firstSlowCallStarted;

      let fastCompletedPromise: Promise<unknown> | null = null;
      const fastAdapter = {
        credentialSource: 'managed_identity' as const,
        isConfigured: true,
        upsertEvent: vi.fn(async ({ target }: { target: string }) => ({
          eventId: `evt-fast-${target}`,
        })),
        deleteEvent: vi.fn(async () => undefined),
      };

      const slowAdapter = {
        credentialSource: 'managed_identity' as const,
        isConfigured: true,
        upsertEvent: vi.fn(async ({ target }: { target: string }) => {
          slowCallCount += 1;
          slowUpsertTargets.push(target);
          if (slowCallCount === 1) {
            // Confirm no DB row lock held during Graph call
            const nowait = await kdRepo.withTenantTransaction(ctx, async (tx) => {
              const r = await tx.query<{ id: string }>(
                'SELECT id FROM key_dates WHERE tenant_id = $1 AND id = $2 FOR UPDATE NOWAIT',
                [ctx.tenantId, kdId],
              );
              return r.rows[0] ?? null;
            });
            expect(nowait?.id).toBe(kdId);

            // While slowAdapter is in flight with stale owner P-000001, commit a concurrent reassignment to partner.id
            fastCompletedPromise = Promise.resolve(
              runAsTestActor(
                'P-000001',
                () =>
                  reassignKeyDateTeamRecord(
                    kdId,
                    {
                      teamId: firstTeam.id,
                      responsiblePersonIds: [partner.id],
                      reason: 'R607 concurrent update during in-flight Graph sync',
                    },
                    'P-000001',
                    { calendarAdapter: fastAdapter },
                  ),
                { roles: ['admin', 'managing_partner'], mfaVerified: true },
              ),
            );
            await fastCompletedPromise;
            releaseSlowFirstCall?.();
          }
          return { eventId: `evt-slow-${slowCallCount}-${target}` };
        }),
        deleteEvent: vi.fn(async () => undefined),
      };

      const slowRes = await runAsTestActor(
        'P-000001',
        () =>
          reassignKeyDateTeamRecord(
            kdId,
            {
              teamId: secondTeam.id,
              responsiblePersonIds: ['P-000001'],
              reason: 'R607 initial slow Graph sync',
            },
            'P-000001',
            { calendarAdapter: slowAdapter },
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(slowRes.ok).toBe(true);
      await fastCompletedPromise;

      // R607 skew retry must re-read latest DB state (partner.id) so externalEvents matches partner.id, NOT stale P-000001
      const finalKd = await kdRepo.getKeyDateById(ctx, kdId, 'P-000001');
      const finalSync = await kdRepo.getCalendarSync(ctx, kdId, 'P-000001');
      expect(finalKd?.responsiblePersonIds).toEqual([partner.id]);
      expect(slowUpsertTargets).toContain(`person:${partner.id}`);
      expect(finalSync?.state).toBe('synced');
      expect(finalSync?.externalEvents.some((e) => e.target === `person:${partner.id}`)).toBe(true);
      expect(await kdRepo.getCalendarSync(ctxB, kdId)).toBeNull();
    } finally {
      vi.restoreAllMocks();
      await kdRepo.clearTenantData(ctxB);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R608: N/A advisory lock prevents live reminder on concurrent verify, and unconfirmed supersede creates no live reminder', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const kdRepo = getKeyDateRepository();
    const taskRepo = getTaskWorkflowRepository();
    const ctx = testTenantCtx('P-000001', {
      roles: ['admin', 'managing_partner'],
      mfaVerified: true,
    });
    const ctxB = createVerifiedTenantContext('tenant-bravo', 'P-BRAVO-1');

    try {
      const store = loadCommittedSeedStore();
      const kdConfig = await getKeyDatesConfig({ ctx, userId: 'P-000001' });
      const targetMatter = store.matters.find((m) => !m.isStaffMatter)!;
      const kdType = (kdConfig.keyDateTypes ?? []).find(
        (t) => t.allowManualEntry !== false,
      )!;
      const partner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== 'P-000001' &&
          (p.roles?.includes('partner') || p.roles?.includes('managing_partner')),
      )!;

      // Part 1: supersede with intent:'provisional' must close old reminder task and create NO reminder state on unconfirmed replacement
      const baseConfirmed = await runAsTestActor(
        'P-000001',
        () =>
          createOrProposeKeyDateRecord(
            {
              matterId: targetMatter.id,
              keyDateTypeId: kdType.id,
              title: 'R608 Supersede Confirmed Base',
              dueDate: '2026-12-10',
              responsiblePersonIds: ['P-000001'],
              intent: 'propose',
            },
            'P-000001',
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(baseConfirmed.ok).toBe(true);
      if (baseConfirmed.keyDate!.status === 'awaiting_verification') {
        const ver = await runAsTestActor(
          partner.id,
          () => verifyProposedKeyDateRecord(baseConfirmed.keyDate!.id, partner.id),
          { roles: partner.roles ?? ['partner'], mfaVerified: true },
        );
        expect(ver.ok).toBe(true);
      }

      const supProvRes = await runAsTestActor(
        'P-000001',
        () =>
          supersedeConfirmedKeyDateRecord(
            baseConfirmed.keyDate!.id,
            {
              title: 'R608 Unconfirmed Provisional Replacement',
              dueDate: '2026-12-15',
              responsiblePersonIds: ['P-000001'],
              intent: 'provisional',
            },
            'Testing unconfirmed replacement reminder omission',
            'P-000001',
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(supProvRes.ok).toBe(true);
      expect(supProvRes.replacementKeyDate?.status).toBe('provisional');
      expect(
        await kdRepo.getReminderState(
          ctx,
          supProvRes.replacementKeyDate!.id,
          'P-000001',
        ),
      ).toBeNull();
      const tasksAfterSup = await taskRepo.listAllTasksUnfiltered(ctx);
      const oldTaskIdem = buildKeyDateReminderIdempotencyKey(
        baseConfirmed.keyDate!.id,
        ctx.tenantId,
      );
      const oldReminderTask = tasksAfterSup.find(
        (t) => t.idempotencyKey === oldTaskIdem,
      );
      if (oldReminderTask) {
        expect(oldReminderTask.status).toBe('Done');
      }

      // Part 2: concurrent N/A + verifyProposedKeyDateRecord race never leaves a live reminder state/task when N/A runs concurrently
      const secondMatter = store.matters.find(
        (m) => !m.isStaffMatter && m.id !== targetMatter.id,
      )!;
      const proposed = await runAsTestActor(
        'P-000001',
        () =>
          createOrProposeKeyDateRecord(
            {
              matterId: secondMatter.id,
              keyDateTypeId: kdType.id,
              title: 'R608 N/A vs Verify Race',
              dueDate: '2026-12-12',
              responsiblePersonIds: ['P-000001'],
              intent: 'propose',
            },
            'P-000001',
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(proposed.ok).toBe(true);
      const raceKdId = proposed.keyDate!.id;

      // Without advisory lock, N/A reading listNotApplicableForMatter before verify commits can interleave with verify's read,
      // leaving both N/A record AND live reminder state. Delay N/A slightly right after its first read if unlocked,
      // or run concurrently after an in-flight delay on verify.
      const origListNa = kdRepo.listNotApplicableForMatter.bind(kdRepo);
      let stalledVerifyReadOnce = false;
      kdRepo.listNotApplicableForMatter = async (callCtx, mId, viewer) => {
        const res = await origListNa(callCtx, mId, viewer);
        if (!stalledVerifyReadOnce && mId === secondMatter.id) {
          stalledVerifyReadOnce = true;
          // Restore immediately so second caller doesn't delay
          kdRepo.listNotApplicableForMatter = origListNa;
          await new Promise((r) => setTimeout(r, 120));
        }
        return res;
      };

      const verifyPromise =
        proposed.keyDate!.status === 'awaiting_verification'
          ? runAsTestActor(
              partner.id,
              () => verifyProposedKeyDateRecord(raceKdId, partner.id),
              { roles: partner.roles ?? ['partner'], mfaVerified: true },
            )
          : Promise.resolve({ ok: true });
      await new Promise((r) => setTimeout(r, 20));
      const naPromise = runAsTestActor(
        'P-000001',
        () =>
          recordKeyDateNotApplicableRecord(
            {
              matterId: secondMatter.id,
              keyDateTypeId: kdType.id,
              reason: 'R608 concurrent N/A',
            },
            'P-000001',
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );

      const [verRaceRes, naRaceRes] = await Promise.all([verifyPromise, naPromise]);
      expect(naRaceRes.ok).toBe(true);
      expect(verRaceRes.ok).toBe(true);

      const naListAfter = await kdRepo.listNotApplicableForMatter(
        ctx,
        secondMatter.id,
        'P-000001',
      );
      expect(
        naListAfter.some((na) => na.keyDateTypeId === kdType.id),
      ).toBe(true);
      // After both commit, zero live reminder state and zero open reminder task must exist
      expect(await kdRepo.getReminderState(ctx, raceKdId, 'P-000001')).toBeNull();
      const tasksAfterRace = await taskRepo.listAllTasksUnfiltered(ctx);
      const raceIdem = buildKeyDateReminderIdempotencyKey(raceKdId, ctx.tenantId);
      const liveRaceTask = tasksAfterRace.find(
        (t) => t.idempotencyKey === raceIdem && t.status !== 'Done' && t.status !== 'Cancelled',
      );
      expect(liveRaceTask).toBeUndefined();
      expect(await kdRepo.listNotApplicableForMatter(ctxB, secondMatter.id)).toEqual([]);
    } finally {
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R609: putReminderState and executeKeyDateRemindersForTenant preserve concurrent reminder acknowledgements without wiping acknowledged_at', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const kdRepo = getKeyDateRepository();
    const ctx = testTenantCtx('P-000001', {
      roles: ['admin', 'managing_partner'],
      mfaVerified: true,
    });
    const ctxB = createVerifiedTenantContext('tenant-bravo', 'P-BRAVO-1');

    try {
      const store = loadCommittedSeedStore();
      const kdConfig = await getKeyDatesConfig({ ctx, userId: 'P-000001' });
      const targetMatter = store.matters.find((m) => !m.isStaffMatter)!;
      const kdType = (kdConfig.keyDateTypes ?? []).find(
        (t) => t.allowManualEntry !== false,
      )!;
      const partner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== 'P-000001' &&
          (p.roles?.includes('partner') || p.roles?.includes('managing_partner')),
      )!;

      const created = await runAsTestActor(
        'P-000001',
        () =>
          createOrProposeKeyDateRecord(
            {
              matterId: targetMatter.id,
              keyDateTypeId: kdType.id,
              title: 'R609 Ack Preservation Key Date',
              dueDate: '2026-11-28',
              responsiblePersonIds: ['P-000001'],
              intent: 'propose',
            },
            'P-000001',
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(created.ok).toBe(true);
      if (created.keyDate!.status === 'awaiting_verification') {
        const v = await runAsTestActor(
          partner.id,
          () => verifyProposedKeyDateRecord(created.keyDate!.id, partner.id),
          { roles: partner.roles ?? ['partner'], mfaVerified: true },
        );
        expect(v.ok).toBe(true);
      }
      const kdId = created.keyDate!.id;

      // 1. Acknowledge the stage
      const ackRes = await runAsTestActor(
        'P-000001',
        () => acknowledgeKeyDateReminderRecord(kdId, 'P-000001'),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(ackRes.ok).toBe(true);
      expect(ackRes.reminderState?.acknowledgedAt).toBeTruthy();

      // 2. Same-stage scheduler upsert with acknowledgedAt undefined must NOT clear acknowledgedAt / acknowledgedById
      const afterSameStageWrite = await kdRepo.putReminderState(
        ctx,
        {
          ...ackRes.reminderState!,
          acknowledgedById: undefined,
          acknowledgedAt: undefined,
          lastNotifiedAt: '2026-11-21T03:00:00.000Z',
        },
        { allowSystemSchedulerWrite: true },
      );
      expect(afterSameStageWrite.acknowledgedAt).toBe(ackRes.reminderState!.acknowledgedAt);
      expect(afterSameStageWrite.acknowledgedById).toBe('P-000001');

      // 3. Concurrent scheduler sweep + acknowledgement lock ordering preserves acknowledgement
      const kd2 = await runAsTestActor(
        'P-000001',
        () =>
          createOrProposeKeyDateRecord(
            {
              matterId: targetMatter.id,
              keyDateTypeId: kdType.id,
              title: 'R609 Concurrent Job vs Ack Key Date',
              dueDate: '2026-11-29',
              responsiblePersonIds: ['P-000001'],
              intent: 'propose',
            },
            'P-000001',
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(kd2.ok).toBe(true);
      if (kd2.keyDate!.status === 'awaiting_verification') {
        await runAsTestActor(
          partner.id,
          () => verifyProposedKeyDateRecord(kd2.keyDate!.id, partner.id),
          { roles: partner.roles ?? ['partner'], mfaVerified: true },
        );
      }

      const origListSched = kdRepo.listAllReminderStatesUnfilteredForScheduler.bind(kdRepo);
      let delayedSchedOnce = false;
      kdRepo.listAllReminderStatesUnfilteredForScheduler = async (callCtx, opts) => {
        const res = await origListSched(callCtx, opts);
        if (!delayedSchedOnce) {
          delayedSchedOnce = true;
          kdRepo.listAllReminderStatesUnfilteredForScheduler = origListSched;
          await new Promise((r) => setTimeout(r, 120));
        }
        return res;
      };

      const adminCtx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const jobPromise = executeKeyDateRemindersForTenant(adminCtx, {
        triggerSource: 'manual',
        triggeredById: 'P-000001',
        defaultRunHourLocal: 0,
      });
      await new Promise((r) => setTimeout(r, 20));
      const concurrentAckPromise = runAsTestActor(
        'P-000001',
        () => acknowledgeKeyDateReminderRecord(kd2.keyDate!.id, 'P-000001'),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      const [jobRes, ack2Res] = await Promise.all([jobPromise, concurrentAckPromise]);
      expect(jobRes.outcome).toBe('executed');
      expect(ack2Res.ok).toBe(true);
      const persistedAck2 = await kdRepo.getReminderState(ctx, kd2.keyDate!.id, 'P-000001');
      expect(persistedAck2?.acknowledgedById).toBe('P-000001');
      expect(persistedAck2?.acknowledgedAt).toBeTruthy();
      expect(await kdRepo.getReminderState(ctxB, kd2.keyDate!.id)).toBeNull();
    } finally {
      await kdRepo.clearTenantData(ctxB);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R610: putKeyDate assigns version authoritatively in DB (1 on insert, +1 on update), supersede increments once, and enquiry conversion locks & versions carried key dates', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const kdRepo = getKeyDateRepository();
    const ctx = testTenantCtx('P-000001', {
      roles: ['admin', 'managing_partner'],
      mfaVerified: true,
    });
    const ctxB = createVerifiedTenantContext('tenant-bravo', 'P-BRAVO-1');

    try {
      const store = loadCommittedSeedStore();
      const kdConfig = await getKeyDatesConfig({ ctx, userId: 'P-000001' });
      const targetMatter = store.matters.find((m) => !m.isStaffMatter)!;
      const kdType = (kdConfig.keyDateTypes ?? []).find(
        (t) => t.allowManualEntry !== false,
      )!;
      const partner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== 'P-000001' &&
          (p.roles?.includes('partner') || p.roles?.includes('managing_partner')),
      )!;

      // 1. Caller-supplied version 99 on insert is ignored (DB sets 1); expectedVersion: null rejects overwrite
      const directInsert = await kdRepo.putKeyDate(
        ctx,
        makeSampleKeyDate({
          id: 'KD-R610-DB-VERSION',
          matterId: targetMatter.id,
          version: 99,
        }),
        { expectedVersion: null },
      );
      expect(directInsert.version).toBe(1);
      await expect(
        kdRepo.putKeyDate(ctx, directInsert, { expectedVersion: null }),
      ).rejects.toThrow(/KEY_DATE_CONCURRENCY_CONFLICT/);

      const directUpdate = await kdRepo.putKeyDate(
        ctx,
        { ...directInsert, notes: 'DB increments version', version: 42 },
        { expectedVersion: 1 },
      );
      expect(directUpdate.version).toBe(2);

      // 2. Supersede bumps superseded version by +1 (not +2) and inserts replacement at version 1
      const baseConfirmed = await runAsTestActor(
        'P-000001',
        () =>
          createOrProposeKeyDateRecord(
            {
              matterId: targetMatter.id,
              keyDateTypeId: kdType.id,
              title: 'R610 Supersede Version Base',
              dueDate: '2027-06-15',
              responsiblePersonIds: ['P-000001'],
              intent: 'propose',
            },
            'P-000001',
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(baseConfirmed.ok).toBe(true);
      let versionBeforeSupersede = baseConfirmed.keyDate!.version;
      if (baseConfirmed.keyDate!.status === 'awaiting_verification') {
        const ver = await runAsTestActor(
          partner.id,
          () => verifyProposedKeyDateRecord(baseConfirmed.keyDate!.id, partner.id),
          { roles: partner.roles ?? ['partner'], mfaVerified: true },
        );
        expect(ver.ok).toBe(true);
        versionBeforeSupersede = ver.keyDate!.version;
      }

      const supRes = await runAsTestActor(
        'P-000001',
        () =>
          supersedeConfirmedKeyDateRecord(
            baseConfirmed.keyDate!.id,
            {
              title: 'R610 Supersede Replacement',
              dueDate: '2027-07-15',
              responsiblePersonIds: ['P-000001'],
            },
            'Single +1 increment check',
            'P-000001',
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(supRes.ok).toBe(true);
      expect(supRes.supersededKeyDate?.version).toBe(versionBeforeSupersede + 1);
      expect(supRes.replacementKeyDate?.version).toBe(1);

      // 3. Enquiry conversion locks enquiry key dates FOR UPDATE & bumps version cleanly on carry-over
      const intakeRepo = getIntakeQuoteRepository();
      const enquiries = await intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(ctx);
      const openEnq = enquiries.find(
        (e: Enquiry) => e.status === 'Assigned' || e.status === 'In contact',
      )!;
      const enqKd = await kdRepo.putKeyDate(
        ctx,
        makeSampleKeyDate({
          id: 'KD-R610-ENQ-CARRY',
          matterId: undefined,
          enquiryId: openEnq.id,
          keyDateTypeId: kdType.id,
          source: 'manual',
          status: 'provisional',
          responsiblePersonIds: ['P-000001'],
          version: 9,
        }),
        { expectedVersion: null },
      );
      expect(enqKd.version).toBe(1);

      const listForEnqSpy = vi.spyOn(kdRepo, 'listKeyDatesForEnquiry');
      const { id: _omId, openedAt: _omOpen, ...matterTpl } = store.matters[0]!;
      void _omId;
      void _omOpen;
      const converted = await runAsTestActor(
        'P-000001',
        () =>
          saveMatterRecord(
            {
              ...matterTpl,
              matterNumber: 'DRAFT',
              openedAt: null,
              fieldValues: {},
              title: 'R610 Enquiry Conversion Matter',
              sourceEnquiryId: openEnq.id,
            },
            { byId: 'P-000001', saveMode: 'draft' },
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(converted.errors).toBeUndefined();
      expect(listForEnqSpy).toHaveBeenCalledWith(
        expect.anything(),
        openEnq.id,
        'P-000001',
        { forUpdate: true },
      );
      const carriedKd = await kdRepo.getKeyDateById(ctx, enqKd.id, 'P-000001');
      expect(carriedKd?.matterId).toBe(converted.matter!.id);
      expect(carriedKd?.enquiryId).toBeUndefined();
      expect(carriedKd?.version).toBe(2);
      expect(await kdRepo.getKeyDateById(ctxB, enqKd.id)).toBeNull();
    } finally {
      vi.restoreAllMocks();
      await kdRepo.clearTenantData(ctxB);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R617: serialises first-time saveKeyDatesConfigRecord and prevents concurrent races across supersede, resolve, reassign, and acknowledge', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const kdRepo = getKeyDateRepository();
    const ctx = testTenantCtx('P-000001', {
      roles: ['admin', 'managing_partner'],
      mfaVerified: true,
    });
    const ctxB = createVerifiedTenantContext('tenant-bravo', 'P-BRAVO-1');

    try {
      const store = loadCommittedSeedStore();
      const baseCfg = await getKeyDatesConfig({ ctx, userId: 'P-000001' });

      // 1. Delete existing config row so first-time concurrent saveKeyDatesConfigRecord runs against empty table
      await kdRepo.putKeyDatesTenantConfig(ctx, null);
      const origPutCfg = kdRepo.putKeyDatesTenantConfig.bind(kdRepo);
      let stalledFirstPut = false;
      kdRepo.putKeyDatesTenantConfig = async (callCtx, cfgArg, actorArg) => {
        if (!stalledFirstPut && cfgArg !== null) {
          stalledFirstPut = true;
          kdRepo.putKeyDatesTenantConfig = origPutCfg;
          await new Promise((r) => setTimeout(r, 150));
        }
        return origPutCfg(callCtx, cfgArg, actorArg);
      };

      const mark = await markAuditPosition();
      const save1Promise = runAsTestActor(
        'P-000004',
        () =>
          saveKeyDatesConfigRecord(
            {
              ...baseCfg,
              keyDateTypes: (baseCfg.keyDateTypes ?? []).map((t, i) =>
                i === 0 ? { ...t, label: 'R617 First Config Label' } : t,
              ),
            },
            'R617 first concurrent save',
            'P-000004',
            { mfaVerified: true },
          ),
        { roles: ['admin'], mfaVerified: true },
      );
      await new Promise((r) => setTimeout(r, 25));
      const save2Promise = runAsTestActor(
        'P-000004',
        () =>
          saveKeyDatesConfigRecord(
            {
              ...baseCfg,
              keyDateTypes: (baseCfg.keyDateTypes ?? []).map((t, i) =>
                i === 0 ? { ...t, label: 'R617 Second Config Label' } : t,
              ),
            },
            'R617 second concurrent save',
            'P-000004',
            { mfaVerified: true },
          ),
        { roles: ['admin'], mfaVerified: true },
      );

      const [s1, s2] = await Promise.all([save1Promise, save2Promise]);
      expect(s1.error).toBeUndefined();
      expect(s1.ok).toBe(true);
      expect(s2.error).toBeUndefined();
      expect(s2.ok).toBe(true);
      const latestCfg = await getKeyDatesConfig({ ctx, userId: 'P-000001' });
      expect(latestCfg.keyDateTypes?.[0]?.label).toBe('R617 Second Config Label');
      const cfgAudits = (await auditEntriesSince(mark)).filter(
        (a) => a.recordId === 'FIRM-KEY-DATES-CONFIG',
      );
      expect(cfgAudits).toHaveLength(2);
      const secondSaveAudit = cfgAudits.find(
        (a) => a.reason === 'R617 second concurrent save',
      );
      const secondAuditBefore = (
        secondSaveAudit?.snapshot as { before?: KeyDatesConfig } | undefined
      )?.before;
      expect(secondAuditBefore?.keyDateTypes?.[0]?.label).toBe(
        'R617 First Config Label',
      );

      // Restore clean seed config for lifecycle races
      await kdRepo.putKeyDatesTenantConfig(
        ctx,
        baseCfg as unknown as Parameters<typeof kdRepo.putKeyDatesTenantConfig>[1],
        'P-000001',
      );

      const targetMatter = store.matters.find((m) => !m.isStaffMatter)!;
      const kdType = (baseCfg.keyDateTypes ?? []).find(
        (t) => t.allowManualEntry !== false,
      )!;
      const partner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== 'P-000001' &&
          (p.roles?.includes('partner') || p.roles?.includes('managing_partner')),
      )!;
      const teams = store.teams.filter((t) => t.active);
      const teamB = teams[1] ?? teams[0]!;

      const makeConfirmed = async (title: string) => {
        const res = await runAsTestActor(
          'P-000001',
          () =>
            createOrProposeKeyDateRecord(
              {
                matterId: targetMatter.id,
                keyDateTypeId: kdType.id,
                title,
                dueDate: '2027-08-15',
                responsiblePersonIds: ['P-000001'],
                intent: 'propose',
              },
              'P-000001',
            ),
          { roles: ['admin', 'managing_partner'], mfaVerified: true },
        );
        expect(res.ok).toBe(true);
        if (res.keyDate!.status === 'awaiting_verification') {
          const v = await runAsTestActor(
            partner.id,
            () => verifyProposedKeyDateRecord(res.keyDate!.id, partner.id),
            { roles: partner.roles ?? ['partner'], mfaVerified: true },
          );
          expect(v.ok).toBe(true);
        }
        return res.keyDate!.id;
      };

      // 2. Concurrent supersede race -> exactly one succeeds
      const supKdId = await makeConfirmed('R617 Concurrent Supersede');
      const [supA, supB] = await Promise.all([
        runAsTestActor(
          'P-000001',
          () =>
            supersedeConfirmedKeyDateRecord(
              supKdId,
              { dueDate: '2027-09-01', responsiblePersonIds: ['P-000001'] },
              'Race A',
              'P-000001',
            ),
          { roles: ['admin', 'managing_partner'], mfaVerified: true },
        ),
        runAsTestActor(
          'P-000001',
          () =>
            supersedeConfirmedKeyDateRecord(
              supKdId,
              { dueDate: '2027-10-01', responsiblePersonIds: ['P-000001'] },
              'Race B',
              'P-000001',
            ),
          { roles: ['admin', 'managing_partner'], mfaVerified: true },
        ),
      ]);
      expect([supA, supB].filter((r) => r.ok)).toHaveLength(1);
      expect([supA, supB].filter((r) => !r.ok)).toHaveLength(1);

      // 3. Concurrent resolve outcome race -> exactly one succeeds
      const resKdId = await makeConfirmed('R617 Concurrent Resolve');
      const [outA, outB] = await Promise.all([
        runAsTestActor(
          'P-000001',
          () =>
            resolveKeyDateOutcomeRecord(resKdId, { kind: 'met', note: 'A' }, 'P-000001'),
          { roles: ['admin', 'managing_partner'], mfaVerified: true },
        ),
        runAsTestActor(
          'P-000001',
          () =>
            resolveKeyDateOutcomeRecord(
              resKdId,
              { kind: 'waived', note: 'Waiver reason B' },
              'P-000001',
            ),
          { roles: ['admin', 'managing_partner'], mfaVerified: true },
        ),
      ]);
      expect([outA, outB].filter((r) => r.ok)).toHaveLength(1);
      expect([outA, outB].filter((r) => !r.ok)).toHaveLength(1);

      // 4. Concurrent reassign & concurrent acknowledge races
      const reKdId = await makeConfirmed('R617 Concurrent Reassign & Ack');
      const [reA, reB] = await Promise.all([
        runAsTestActor(
          'P-000001',
          () =>
            reassignKeyDateTeamRecord(
              reKdId,
              { teamId: teamB.id, responsiblePersonIds: ['P-000001', partner.id], reason: 'Reassign 1' },
              'P-000001',
            ),
          { roles: ['admin', 'managing_partner'], mfaVerified: true },
        ),
        runAsTestActor(
          'P-000001',
          () =>
            reassignKeyDateTeamRecord(
              reKdId,
              { teamId: teams[0]!.id, responsiblePersonIds: ['P-000001'], reason: 'Reassign 2' },
              'P-000001',
            ),
          { roles: ['admin', 'managing_partner'], mfaVerified: true },
        ),
      ]);
      expect(reA.ok).toBe(true);
      expect(reB.ok).toBe(true);

      const [ack1, ack2] = await Promise.all([
        runAsTestActor(
          'P-000001',
          () => acknowledgeKeyDateReminderRecord(reKdId, 'P-000001'),
          { roles: ['admin', 'managing_partner'], mfaVerified: true },
        ),
        runAsTestActor(
          'P-000001',
          () => acknowledgeKeyDateReminderRecord(reKdId, 'P-000001'),
          { roles: ['admin', 'managing_partner'], mfaVerified: true },
        ),
      ]);
      expect(ack1.error).toBeUndefined();
      expect(ack2.error).toBeUndefined();
      expect(ack1.ok).toBe(true);
      expect(ack2.ok).toBe(true);
      const finalAckState = await kdRepo.getReminderState(ctx, reKdId, 'P-000001');
      expect(finalAckState?.acknowledgedById).toBe('P-000001');
      expect(finalAckState?.acknowledgedAt).toBeTruthy();
      expect(await kdRepo.getKeyDateById(ctxB, reKdId)).toBeNull();
    } finally {
      await kdRepo.clearTenantData(ctxB);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });
});
