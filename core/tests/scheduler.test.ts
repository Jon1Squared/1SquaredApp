import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_BUILTIN_ROLE_KEYS,
  ALL_JOB_ONLY_PERMISSION_KEYS,
  ALL_PERMISSION_KEYS,
  ALL_USER_PERMISSION_KEYS,
  AuthorisationError,
  DEFAULT_RBAC_ROLES,
  getPlatformTelemetryRecorder,
  loadAndValidateTenantConfig,
  PERMISSION_REGISTRY,
  resolvePermissions,
  resolveTenantLocalDateAndHour,
  TenantJobRunRepository,
  validateTenantRegistry,
  type TenantConfiguration,
  type TenantRegistryEntry,
} from '@platform/core';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import {
  getActiveTenantRawBaseConfig,
  getAuditRepository,
  getHrAndRbacRepository,
  getJobRunRepository,
  getMatterRepository,
  getPartyRepository,
  getTaskWorkflowRepository,
  setActiveTenantConfigForTesting,
} from '../../src/platform/tenantRuntime';
import {
  getDefaultTenantRbacConfig,
  resolvePersonPermissionSet,
} from '../../src/server/rbacRuntime';
import {
  createOrProposeKeyDateRecord,
  executeUsageRetentionPurgeForTenant,
  getKeyDateRepository,
  getKeyDatesConfig,
  resetAllDemoData,
  runKeyDateReminderSchedulerRecord,
  runScheduledKeyDateRemindersJobSweep,
  updatePersonPermissionOverrides,
  updateTenantRbacConfig,
  verifyProposedKeyDateRecord,
} from '../../src/server/services';
import { buildKeyDateReminderIdempotencyKey } from '../../src/domain/keyDates';
import { getDocumentRepository } from '../../src/server/documentGenerationServices';
import { guardedAction, guardedJob } from '../../src/server/authorize';
import { runKeyDateReminderSchedulerAction } from '../../src/app/actions';
import { runMigrateJobSweep, executeCliJobRunner } from '../../scripts/run-job';
import {
  runAsTestActor,
  setTestActorSession,
  testTenantCtx,
} from '../../src/server/testSupport/auditTestSupport';
import { setTestEntraSessionOverride } from '../../src/server/entraAuth';
import { isActionDenied } from '../../src/domain/actionResult';
import { testDataResetContext } from '../../src/test/testTenantContexts';
import type { Matter, Person, Task } from '../../src/domain/types';

function makeTestRegistryEntry(
  tenantId = 'not-a-law-firm',
  slug = 'not_a_law_firm',
  timeZone = 'Europe/London',
): TenantRegistryEntry {
  const host = process.env.PLATFORM_POSTGRES_HOST?.trim() || '127.0.0.1';
  return {
    tenantId,
    slug,
    environment: 'test',
    postgresHost: host,
    postgresDatabaseName: `pg_tenant_${slug}_test`,
    postgresRoleName: `role_tenant_${slug}_test`,
    keyVaultUri: `https://kv-${slug.replace(/_/g, '')}-test.vault.azure.net/`,
    packageDir: 'client-not-a-law-firm',
    timeZone,
    enabled: true,
  };
}

describe('S0-19: Tenant-aware background job scheduler (ADR 0030)', () => {
  beforeEach(async () => {
    setActiveTenantConfigForTesting(null);
    setTestEntraSessionOverride(undefined);
    const ctx = testTenantCtx('P-000001', {
      roles: ['admin', 'managing_partner'],
      mfaVerified: true,
    });
    await getJobRunRepository().clearTenantJobRuns(ctx);
  });

  describe('1. Job-only RBAC permissions & guardedJob enforcement (ADR 0030 §3 / Lesson 4)', () => {
    it('ensures no role (admin included) holds tenant:migrate, keydate:run_reminders, document_generation:purge_usage, or enquiry:run_retention_anonymise, and rejects attempts to grant them via overrides, RBAC config, or R477 DB rows', async () => {
      expect(ALL_JOB_ONLY_PERMISSION_KEYS).toEqual([
        'tenant:migrate',
        'keydate:run_reminders',
        'document_generation:purge_usage',
        'enquiry:run_retention_anonymise',
      ]);
      expect(ALL_PERMISSION_KEYS.length).toBe(
        ALL_USER_PERMISSION_KEYS.length + ALL_JOB_ONLY_PERMISSION_KEYS.length,
      );

      for (const jobPerm of ALL_JOB_ONLY_PERMISSION_KEYS) {
        expect(PERMISSION_REGISTRY[jobPerm].jobOnly).toBe(true);
        expect(PERMISSION_REGISTRY[jobPerm].sensitivity).toBe('critical');
      }

      // 1. No built-in role (including admin) holds any jobOnly permission
      for (const roleKey of ALL_BUILTIN_ROLE_KEYS) {
        const roleDef = DEFAULT_RBAC_ROLES[roleKey];
        for (const jobPerm of ALL_JOB_ONLY_PERMISSION_KEYS) {
          expect(roleDef.permissions).not.toContain(jobPerm);
        }
      }

      // 2. resolvePermissions strips jobOnly permissions even if injected via crafted config or overrides
      const baseConfig = loadAndValidateTenantConfig({
        ...(notALawFirmBaseConfig as Record<string, unknown>),
        tenantId: 'not-a-law-firm',
      });
      const craftedConfig = {
        ...baseConfig,
        rbac: {
          ...getDefaultTenantRbacConfig(),
          roles: {
            ...getDefaultTenantRbacConfig().roles,
            admin: {
              ...getDefaultTenantRbacConfig().roles.admin,
              permissions: [...ALL_PERMISSION_KEYS],
            },
          },
        },
      } as unknown as TenantConfiguration;

      const resolvedAdmin = resolvePermissions({
        context: {
          tenantId: 'not-a-law-firm',
          correlationId: 'corr-job-perm-admin',
          actorId: 'P-000001',
          actorRoles: ['admin'],
          mfaVerified: true,
        },
        actor: {
          userId: 'P-000001',
          roles: ['admin'],
          permissionOverrides: {
            grant: [...ALL_JOB_ONLY_PERMISSION_KEYS],
            revoke: [],
          },
        },
        config: craftedConfig,
      });

      for (const jobPerm of ALL_JOB_ONLY_PERMISSION_KEYS) {
        expect(resolvedAdmin.has(jobPerm)).toBe(false);
      }

      // 3. updatePersonPermissionOverrides refuses granting any jobOnly permission with FORBIDDEN
      for (const jobPerm of ALL_JOB_ONLY_PERMISSION_KEYS) {
        const overrideAttempt = await runAsTestActor(
          'P-000001',
          async () =>
            updatePersonPermissionOverrides(
              'P-000002',
              {
                grant: [jobPerm],
                revoke: [],
                reason: 'Attempted escalation to job-only permission',
              },
              'P-000001',
              { mfaVerified: true },
            ),
          { roles: ['admin', 'managing_partner'], mfaVerified: true },
        );
        expect(overrideAttempt.ok).toBe(false);
        expect(overrideAttempt.code).toBe('FORBIDDEN');
        expect(overrideAttempt.error).toMatch(
          /PRIVILEGE_ESCALATION_FORBIDDEN|jobOnly|cannot grant/i,
        );
      }

      // 4. updateTenantRbacConfig refuses granting any jobOnly permission in roles or departmentGrants with FORBIDDEN
      for (const jobPerm of ALL_JOB_ONLY_PERMISSION_KEYS) {
        const rbacRoleAttempt = await runAsTestActor(
          'P-000001',
          async () =>
            updateTenantRbacConfig(
              {
                roles: {
                  ...getDefaultTenantRbacConfig().roles,
                  admin: {
                    ...getDefaultTenantRbacConfig().roles.admin,
                    permissions: [...ALL_USER_PERMISSION_KEYS, jobPerm],
                  },
                },
              },
              'P-000001',
              { mfaVerified: true },
            ),
          { roles: ['admin', 'managing_partner'], mfaVerified: true },
        );
        expect(rbacRoleAttempt.ok).toBe(false);
        expect(rbacRoleAttempt.code).toBe('FORBIDDEN');
        expect(rbacRoleAttempt.error).toMatch(
          /reserved for background jobs \(jobOnly\)/i,
        );

        const rbacDeptAttempt = await runAsTestActor(
          'P-000001',
          async () =>
            updateTenantRbacConfig(
              {
                departmentGrants: {
                  'DEPT-CORP': [jobPerm],
                },
              },
              'P-000001',
              { mfaVerified: true },
            ),
          { roles: ['admin', 'managing_partner'], mfaVerified: true },
        );
        expect(rbacDeptAttempt.ok).toBe(false);
        expect(rbacDeptAttempt.code).toBe('FORBIDDEN');
        expect(rbacDeptAttempt.error).toMatch(
          /reserved for background jobs \(jobOnly\)/i,
        );
      }

      // 5. R477 per-request RBAC path in buildGuardedActorContext (via guardedAction) strips jobOnly permissions even if persisted directly in PostgreSQL
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const hrRepo = getHrAndRbacRepository();
      const priorRbacOverride =
        await hrRepo.getRbacConfigOverrideWithVersion(ctx);
      try {
        await hrRepo.putRbacConfigOverride(
          ctx,
          {
            ...getDefaultTenantRbacConfig(),
            roles: {
              ...getDefaultTenantRbacConfig().roles,
              admin: {
                ...getDefaultTenantRbacConfig().roles.admin,
                permissions: [...ALL_PERMISSION_KEYS],
              },
            },
            departmentGrants: {
              'DEPT-EXEC': [...ALL_JOB_ONLY_PERMISSION_KEYS],
            },
          },
          {
            updatedById: 'P-000001',
            updatedAt: new Date().toISOString(),
            expectedRowVersion: priorRbacOverride.rowVersion,
          },
        );

        setTestActorSession('P-000001', {
          roles: ['admin', 'managing_partner'],
          mfaVerified: true,
        });
        const actorCtx = await guardedAction(
          'runKeyDateReminderSchedulerAction',
          async (guardedActor) => guardedActor,
        );
        expect(actorCtx).not.toBeNull();
        for (const jobPerm of ALL_JOB_ONLY_PERMISSION_KEYS) {
          expect(actorCtx.permissions.has(jobPerm)).toBe(false);
        }

        const people = await getPartyRepository().listAllPeople<Person>(ctx);
        const adminPerson = people.find((p) => p.id === 'P-000001')!;
        const directSet = resolvePersonPermissionSet(
          {
            ...adminPerson,
            permissionOverrides: {
              grant: [...ALL_JOB_ONLY_PERMISSION_KEYS],
              revoke: [],
            },
          },
          {
            allPeople: people,
            mfaVerified: true,
          },
        );
        for (const jobPerm of ALL_JOB_ONLY_PERMISSION_KEYS) {
          expect(directSet.has(jobPerm)).toBe(false);
        }
      } finally {
        const currentRbac = await hrRepo.getRbacConfigOverrideWithVersion(ctx);
        await hrRepo.putRbacConfigOverride(ctx, priorRbacOverride.override, {
          updatedById: 'P-000001',
          updatedAt: new Date().toISOString(),
          expectedRowVersion: currentRbac.rowVersion,
        });
        setTestActorSession(null);
      }
    });

    it('runs migrate inside guardedJob requiring tenant:migrate and minting system:migrate with jobPermissions', async () => {
      const entry = makeTestRegistryEntry();
      const registry = validateTenantRegistry({
        schemaVersion: '1.0.0',
        environment: 'test',
        hostingMode: 'multi_tenant',
        tenants: [entry],
      });

      const recorder = getPlatformTelemetryRecorder();
      recorder.clearForTesting();

      const sweep = await runMigrateJobSweep({ registry });
      expect(sweep.exitCode).toBe(0);
      expect(sweep.succeededTenants).toEqual(['not-a-law-firm']);

      const startedEvents = recorder
        .getRecentEntries({ tenantId: 'not-a-law-firm' })
        .filter((e) => e.eventName === 'job.tenant.started');
      const succeededEvents = recorder
        .getRecentEntries({ tenantId: 'not-a-law-firm' })
        .filter((e) => e.eventName === 'job.tenant.succeeded');

      expect(startedEvents.length).toBeGreaterThanOrEqual(1);
      expect(startedEvents[0]!.properties).toMatchObject({
        jobKey: 'migrate',
      });
      expect(succeededEvents.length).toBeGreaterThanOrEqual(1);
      expect(succeededEvents[0]!.properties).toMatchObject({
        jobKey: 'migrate',
        status: 'succeeded',
      });

      // Verify guardedJob mints system:migrate with tenant:migrate and rejects a forged jobPermissions list lacking tenant:migrate
      let capturedActorId = '';
      let capturedJobPermissions: readonly string[] = [];
      await guardedJob(
        'migrate',
        entry,
        async ({ tenantContext }) => {
          capturedActorId = tenantContext.actorId;
          capturedJobPermissions = tenantContext.jobPermissions ?? [];
          return 'ok';
        },
        { registry },
      );
      expect(capturedActorId).toBe('system:migrate');
      expect(capturedJobPermissions).toEqual(['tenant:migrate']);

      await expect(
        guardedJob('migrate', entry, async () => 'should-not-run', {
          registry,
          overrideJobPermissions: ['keydate:run_reminders'],
        }),
      ).rejects.toThrow(AuthorisationError);
    });
  });

  describe('2. Scheduled & Manual Key Date Reminders, Concurrency, Two-Process Locking, and GMT/BST', () => {
    it('records system:key-date-reminders on scheduled runs, actor.personId on manual runs, and skips subsequent scheduled ticks on the same local_date', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const jobRunRepo = getJobRunRepository();
      await jobRunRepo.clearTenantJobRuns(ctx);

      const matters =
        await getMatterRepository().listAllMattersUnfiltered<Matter>(ctx);
      const targetMatter = matters.find((m) => !m.isStaffMatter)!;
      const kdConfig = await getKeyDatesConfig({ ctx, userId: 'P-000001' });
      const kdType = (kdConfig.keyDateTypes ?? []).find(
        (t) => t.allowManualEntry !== false,
      )!;

      // Use dueDate > 180 days after test creation time so initial stage is 180 at creation
      const createdKd = await runAsTestActor(
        'P-000001',
        async () => {
          const created = await createOrProposeKeyDateRecord(
            {
              matterId: targetMatter.id,
              keyDateTypeId: kdType.id,
              title: 'S0-19 Scheduled vs Manual Reminder Test Date',
              dueDate: '2027-08-22',
              intent: 'propose',
            },
            'P-000001',
          );
          expect(created.ok).toBe(true);
          return created.keyDate!;
        },
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );

      if (createdKd.status === 'awaiting_verification') {
        await runAsTestActor(
          'P-000002',
          async () => {
            const verified = await verifyProposedKeyDateRecord(
              createdKd.id,
              'P-000002',
            );
            expect(verified.ok).toBe(true);
          },
          { roles: ['admin', 'partner'], mfaVerified: true },
        );
      }

      // 1. Manual run via runKeyDateReminderSchedulerRecord (at 00:15 UTC = 01:15 BST on 2027-08-20 — before 02:00 local window, manual runs immediately)
      const manualNowIso = '2027-08-20T00:15:00.000Z';
      const manualRes = await runAsTestActor(
        'P-000001',
        async () =>
          runKeyDateReminderSchedulerRecord({
            tenantCtx: ctx,
            byId: 'P-000001',
            mfaVerified: true,
            nowIso: manualNowIso,
            timeZone: 'Europe/London',
          }),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(manualRes.ok).toBe(true);
      expect(manualRes.jobStatus).toBe('succeeded');
      expect(manualRes.triggeredBy).toBe('P-000001');
      expect(manualRes.jobRun).toMatchObject({
        tenantId: 'not-a-law-firm',
        jobKey: 'key-date-reminders',
        localDate: '2027-08-20',
        triggerSource: 'manual',
        triggeredById: 'P-000001',
        status: 'succeeded',
      });

      const kdAuditsAfterManual =
        await getAuditRepository().listAuditEntriesForRecord(
          ctx,
          'key_date',
          createdKd.id,
        );
      expect(kdAuditsAfterManual.some((a) => a.byId === 'P-000001')).toBe(true);

      // 2. Subsequent scheduled tick on the same local_date (2027-08-20 at 02:05 BST = 01:05 UTC) skips cleanly with already_succeeded_today
      const entry = makeTestRegistryEntry();
      const registry = validateTenantRegistry({
        schemaVersion: '1.0.0',
        environment: 'test',
        hostingMode: 'multi_tenant',
        tenants: [entry],
      });

      const scheduledSameDay = await runScheduledKeyDateRemindersJobSweep({
        registry,
        nowIso: '2027-08-20T01:05:00.000Z', // 02:05 BST on 2027-08-20
      });
      expect(scheduledSameDay.exitCode).toBe(0);
      expect(scheduledSameDay.succeededTenants).toEqual([]);
      expect(scheduledSameDay.skippedTenants).toEqual([
        {
          tenantId: 'not-a-law-firm',
          status: 'skipped',
          reason: 'already_succeeded_today',
        },
      ]);

      // 3. Scheduled tick on a subsequent local day (2027-08-22 at 02:05 BST = 01:05 UTC, when due date is today -> 1d stage) executes with system:key-date-reminders
      const scheduledNextDay = await runScheduledKeyDateRemindersJobSweep({
        registry,
        nowIso: '2027-08-22T01:05:00.000Z', // 02:05 BST on 2027-08-22
      });
      expect(scheduledNextDay.exitCode).toBe(0);
      expect(scheduledNextDay.succeededTenants).toEqual(['not-a-law-firm']);

      const runs = await jobRunRepo.listJobRuns(ctx, {
        jobKey: 'key-date-reminders',
      });
      const scheduledRun = runs.find(
        (r) => r.localDate === '2027-08-22' && r.triggerSource === 'scheduled',
      );
      expect(scheduledRun).toBeDefined();
      expect(scheduledRun!.triggeredById).toBe('system:key-date-reminders');
      expect(scheduledRun!.status).toBe('succeeded');

      const kdAuditsAfterScheduled =
        await getAuditRepository().listAuditEntriesForRecord(
          ctx,
          'key_date',
          createdKd.id,
        );
      expect(
        kdAuditsAfterScheduled.some(
          (a) => a.byId === 'system:key-date-reminders',
        ),
      ).toBe(true);
    });

    it('handles two runs at once (Promise.all of scheduled key-date-reminders and manual runKeyDateReminderSchedulerAction) creating each reminder, task, notification, and audit entry once', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const jobRunRepo = getJobRunRepository();
      await jobRunRepo.clearTenantJobRuns(ctx);

      const matters =
        await getMatterRepository().listAllMattersUnfiltered<Matter>(ctx);
      const targetMatter = matters.find((m) => !m.isStaffMatter)!;
      const kdConfig = await getKeyDatesConfig({ ctx, userId: 'P-000001' });
      const kdType = (kdConfig.keyDateTypes ?? []).find(
        (t) => t.allowManualEntry !== false,
      )!;

      const createdKd = await runAsTestActor(
        'P-000001',
        async () => {
          const created = await createOrProposeKeyDateRecord(
            {
              matterId: targetMatter.id,
              keyDateTypeId: kdType.id,
              title: 'S0-19 Promise.all Concurrent Reminder Date',
              dueDate: '2027-07-10',
              intent: 'propose',
            },
            'P-000001',
          );
          return created.keyDate!;
        },
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );

      if (createdKd.status === 'awaiting_verification') {
        await runAsTestActor(
          'P-000002',
          async () => {
            const verified = await verifyProposedKeyDateRecord(
              createdKd.id,
              'P-000002',
            );
            expect(verified.ok).toBe(true);
          },
          { roles: ['admin', 'partner'], mfaVerified: true },
        );
      }

      const expectedIdempotencyKey = buildKeyDateReminderIdempotencyKey(
        createdKd.id,
        ctx.tenantId,
      );
      const reminderBefore = await getKeyDateRepository().getReminderState(
        ctx,
        createdKd.id,
        'P-000001',
      );
      expect(reminderBefore?.currentStageDaysBefore).toBe(90);

      const entry = makeTestRegistryEntry();
      const registry = validateTenantRegistry({
        schemaVersion: '1.0.0',
        environment: 'test',
        hostingMode: 'multi_tenant',
        tenants: [entry],
      });

      // Run at 02:10 BST on 2027-07-10 (01:10 UTC) so both scheduled and manual are eligible for local_date 2027-07-10
      const concurrentNowIso = '2027-07-10T01:10:00.000Z';
      setTestActorSession('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      try {
        const [scheduledSweep, manualActionRes] = await Promise.all([
          runScheduledKeyDateRemindersJobSweep({
            registry,
            nowIso: concurrentNowIso,
          }),
          runAsTestActor(
            'P-000001',
            () =>
              runKeyDateReminderSchedulerAction({
                nowIso: concurrentNowIso,
              }),
            { roles: ['admin', 'managing_partner'], mfaVerified: true },
          ),
        ]);

        expect(scheduledSweep.exitCode).toBe(0);
        expect(isActionDenied(manualActionRes)).toBe(false);
      } finally {
        setTestActorSession(null);
      }

      // Verify the single reminder task and audit entry for createdKd were updated once (never duplicated)
      const tasksAfter =
        await getTaskWorkflowRepository().listAllTasksUnfiltered<Task>(ctx);
      const kdTasksAfter = tasksAfter.filter(
        (t) => t.idempotencyKey === expectedIdempotencyKey,
      );
      expect(kdTasksAfter).toHaveLength(1);

      const reminderAfter = await getKeyDateRepository().getReminderState(
        ctx,
        createdKd.id,
        'P-000001',
      );
      expect(reminderAfter?.currentStageDaysBefore).toBe(0);

      const kdAuditsAfter =
        await getAuditRepository().listAuditEntriesForRecord(
          ctx,
          'key_date',
          createdKd.id,
        );
      const stageUpdatesFor20270710 = kdAuditsAfter.filter(
        (a) => a.at === concurrentNowIso,
      );
      expect(stageUpdatesFor20270710).toHaveLength(1);
    });

    it('handles Europe/London GMT/BST spring-forward (2026-03-29) and fall-back (2026-10-25) across 24 hourly UTC ticks with exactly one scheduled run per local day', async () => {
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const jobRunRepo = new TenantJobRunRepository();
      await jobRunRepo.clearTenantJobRuns(ctx);

      // Verify resolveTenantLocalDateAndHour directly around the spring-forward transition on 2026-03-29:
      // 00:30 UTC -> 00:30 GMT (hour 0)
      // 01:00 UTC -> 02:00 BST (clocks spring forward from 01:00 GMT to 02:00 BST!)
      expect(
        resolveTenantLocalDateAndHour(
          new Date('2026-03-29T00:30:00.000Z'),
          'Europe/London',
        ),
      ).toEqual({
        localDate: '2026-03-29',
        localHour: 0,
        timeZone: 'Europe/London',
      });
      expect(
        resolveTenantLocalDateAndHour(
          new Date('2026-03-29T01:00:00.000Z'),
          'Europe/London',
        ),
      ).toEqual({
        localDate: '2026-03-29',
        localHour: 2,
        timeZone: 'Europe/London',
      });

      // Simulate all 24 hourly UTC ticks on 2026-03-29 (BST spring-forward)
      const springOutcomes: string[] = [];
      for (let utcHour = 0; utcHour < 24; utcHour += 1) {
        const tickDate = new Date(
          `2026-03-29T${String(utcHour).padStart(2, '0')}:05:00.000Z`,
        );
        const res = await jobRunRepo.executeControlledTenantJobRun(ctx, {
          jobKey: 'key-date-reminders',
          triggerSource: 'scheduled',
          triggeredById: 'system:key-date-reminders',
          timeZone: 'Europe/London',
          now: tickDate,
          work: async () => ({
            result: { tickHour: utcHour },
            summary: { evaluatedCount: 5 },
          }),
        });
        springOutcomes.push(res.outcome);
      }

      expect(springOutcomes.filter((o) => o === 'executed')).toHaveLength(1);
      expect(springOutcomes[0]).toBe('before_window'); // 00:05 UTC = 00:05 GMT on 2026-03-29
      expect(springOutcomes[1]).toBe('executed'); // 01:05 UTC = 02:05 BST on 2026-03-29 (first tick >= 02:00 local)
      expect(
        springOutcomes
          .slice(2, 23)
          .every((o) => o === 'already_succeeded_today'),
      ).toBe(true); // 02:05..22:05 UTC = 03:05..23:05 BST on 2026-03-29
      expect(springOutcomes[23]).toBe('before_window'); // 23:05 UTC = 00:05 BST on 2026-03-30 (next local day, before 02:00 window)

      // Simulate all 24 hourly UTC ticks on 2026-10-25 (GMT fall-back: 00:05 UTC = 01:05 BST, 01:05 UTC = 01:05 GMT, 02:05 UTC = 02:05 GMT)
      const autumnOutcomes: string[] = [];
      for (let utcHour = 0; utcHour < 24; utcHour += 1) {
        const tickDate = new Date(
          `2026-10-25T${String(utcHour).padStart(2, '0')}:05:00.000Z`,
        );
        const res = await jobRunRepo.executeControlledTenantJobRun(ctx, {
          jobKey: 'key-date-reminders',
          triggerSource: 'scheduled',
          triggeredById: 'system:key-date-reminders',
          timeZone: 'Europe/London',
          now: tickDate,
          work: async () => ({
            result: { tickHour: utcHour },
            summary: { evaluatedCount: 5 },
          }),
        });
        autumnOutcomes.push(res.outcome);
      }

      expect(autumnOutcomes.filter((o) => o === 'executed')).toHaveLength(1);
      expect(autumnOutcomes[0]).toBe('before_window'); // 00:05 UTC = 01:05 BST
      expect(autumnOutcomes[1]).toBe('before_window'); // 01:05 UTC = 01:05 GMT
      expect(autumnOutcomes[2]).toBe('executed'); // 02:05 UTC = 02:05 GMT
      expect(
        autumnOutcomes.slice(3).every((o) => o === 'already_succeeded_today'),
      ).toBe(true);
    });

    it('rolls back all reminder, task, and audit writes when a job fails, records status = failed in job_runs, and retries cleanly on the next hourly tick', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const jobRunRepo = getJobRunRepository();
      await jobRunRepo.clearTenantJobRuns(ctx);

      const matters =
        await getMatterRepository().listAllMattersUnfiltered<Matter>(ctx);
      const targetMatter = matters.find((m) => !m.isStaffMatter)!;
      const kdConfig = await getKeyDatesConfig({ ctx, userId: 'P-000001' });
      const kdType = (kdConfig.keyDateTypes ?? []).find(
        (t) => t.allowManualEntry !== false,
      )!;

      const createdKd = await runAsTestActor(
        'P-000001',
        async () => {
          const created = await createOrProposeKeyDateRecord(
            {
              matterId: targetMatter.id,
              keyDateTypeId: kdType.id,
              title: 'S0-19 Rollback and Retry Reminder Date',
              dueDate: '2027-09-15',
              intent: 'propose',
            },
            'P-000001',
          );
          return created.keyDate!;
        },
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );

      if (createdKd.status === 'awaiting_verification') {
        await runAsTestActor(
          'P-000002',
          async () => {
            const verified = await verifyProposedKeyDateRecord(
              createdKd.id,
              'P-000002',
            );
            expect(verified.ok).toBe(true);
          },
          { roles: ['admin', 'partner'], mfaVerified: true },
        );
      }

      const expectedIdempotencyKey = buildKeyDateReminderIdempotencyKey(
        createdKd.id,
        ctx.tenantId,
      );

      const entry = makeTestRegistryEntry();
      const registry = validateTenantRegistry({
        schemaVersion: '1.0.0',
        environment: 'test',
        hostingMode: 'multi_tenant',
        tenants: [entry],
      });

      // 1. Tick at 02:05 BST on 2027-09-15 (01:05 UTC) throws after staging reminder/task/audit writes
      const failedSweep = await runScheduledKeyDateRemindersJobSweep({
        registry,
        nowIso: '2027-09-15T01:05:00.000Z',
        onAfterWorkBeforeCommitByTenant: {
          'not-a-law-firm': () => {
            const err = new Error('Simulated mid-transaction failure');
            (err as Error & { code?: string }).code = 'SIMULATED_TX_FAILURE';
            throw err;
          },
        },
      });
      expect(failedSweep.exitCode).toBe(1);
      expect(failedSweep.failedTenants).toEqual([
        { tenantId: 'not-a-law-firm', errorCode: 'SIMULATED_TX_FAILURE' },
      ]);

      // Verify reminder stage advancement and audit entries were rolled back completely
      const reminderAfterFailure =
        await getKeyDateRepository().getReminderState(
          ctx,
          createdKd.id,
          'P-000001',
        );
      expect(reminderAfterFailure?.currentStageDaysBefore).toBe(90);

      const auditsAfterFailure =
        await getAuditRepository().listAuditEntriesForRecord(
          ctx,
          'key_date',
          createdKd.id,
        );
      expect(
        auditsAfterFailure.filter(
          (a) => a.byId === 'system:key-date-reminders',
        ),
      ).toHaveLength(0);

      // Verify a status = 'failed' row was recorded in job_runs
      const runsAfterFailure = await jobRunRepo.listJobRuns(ctx, {
        jobKey: 'key-date-reminders',
        localDate: '2027-09-15',
      });
      expect(runsAfterFailure).toHaveLength(1);
      expect(runsAfterFailure[0]!.status).toBe('failed');
      expect(runsAfterFailure[0]!.errorCode).toBe('SIMULATED_TX_FAILURE');

      // 2. Next hourly tick at 03:05 BST on 2027-09-15 (02:05 UTC) retries and succeeds
      const retrySweep = await runScheduledKeyDateRemindersJobSweep({
        registry,
        nowIso: '2027-09-15T02:05:00.000Z',
      });
      expect(retrySweep.exitCode).toBe(0);
      expect(retrySweep.succeededTenants).toEqual(['not-a-law-firm']);

      const reminderAfterRetry = await getKeyDateRepository().getReminderState(
        ctx,
        createdKd.id,
        'P-000001',
      );
      expect(reminderAfterRetry?.currentStageDaysBefore).toBe(0);

      const tasksAfterRetry =
        await getTaskWorkflowRepository().listAllTasksUnfiltered<Task>(ctx);
      expect(
        tasksAfterRetry.filter(
          (t) => t.idempotencyKey === expectedIdempotencyKey,
        ),
      ).toHaveLength(1);

      const auditsAfterRetry =
        await getAuditRepository().listAuditEntriesForRecord(
          ctx,
          'key_date',
          createdKd.id,
        );
      expect(
        auditsAfterRetry.filter((a) => a.byId === 'system:key-date-reminders'),
      ).toHaveLength(1);

      const runsAfterRetry = await jobRunRepo.listJobRuns(ctx, {
        jobKey: 'key-date-reminders',
        localDate: '2027-09-15',
      });
      expect(runsAfterRetry).toHaveLength(2);
      expect(runsAfterRetry.map((r) => r.status).sort()).toEqual([
        'failed',
        'succeeded',
      ]);
    });
  });

  describe('3. Usage retention purge job, CLI runner, timeouts, and zero-PII telemetry', () => {
    it('purges usage events older than documentGeneration.usage.retentionMonths and writes an audit entry and job_runs row in one transaction', async () => {
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const docRepo = getDocumentRepository();
      const jobRunRepo = getJobRunRepository();
      await jobRunRepo.clearTenantJobRuns(ctx);

      const rawBaseCfg = getActiveTenantRawBaseConfig();
      const baseDocGen = (rawBaseCfg.documentGeneration ?? {}) as Record<
        string,
        unknown
      >;
      const baseUsage = (baseDocGen.usage ?? {}) as Record<string, unknown>;
      setActiveTenantConfigForTesting({
        ...rawBaseCfg,
        documentGeneration: {
          ...baseDocGen,
          usage: {
            ...baseUsage,
            retentionMonths: 12,
          },
        },
      });

      await docRepo.putUsageEvent(ctx, {
        id: 'UE-S019-EXPIRED-18M',
        tenantId: ctx.tenantId,
        templateId: 'TPL-S019-1',
        templateVersionId: 'TPLV-S019-1',
        versionNumber: 1,
        eventType: 'generated',
        occurredAt: '2024-10-01T10:00:00.000Z',
        actorUserId: 'P-000001',
        actorRoleKey: 'partner',
        sourceEntityType: 'matter',
        outputFormat: 'docx',
        missingFieldKeys: [],
        durationMs: 20,
        correlationId: 'corr-ue-18m',
      });
      await docRepo.putUsageEvent(ctx, {
        id: 'UE-S019-RECENT-2M',
        tenantId: ctx.tenantId,
        templateId: 'TPL-S019-1',
        templateVersionId: 'TPLV-S019-1',
        versionNumber: 1,
        eventType: 'generated',
        occurredAt: '2026-04-15T10:00:00.000Z',
        actorUserId: 'P-000001',
        actorRoleKey: 'partner',
        sourceEntityType: 'matter',
        outputFormat: 'docx',
        missingFieldKeys: [],
        durationMs: 18,
        correlationId: 'corr-ue-2m',
      });

      const outcome = await executeUsageRetentionPurgeForTenant(ctx, {
        triggerSource: 'scheduled',
        triggeredById: 'system:usage-retention-purge',
        timeZone: 'Europe/London',
        nowIso: '2026-06-20T01:10:00.000Z', // 02:10 BST on 2026-06-20
      });
      expect(outcome.outcome).toBe('executed');
      if (outcome.outcome === 'executed') {
        expect(outcome.result.retentionMonths).toBe(12);
        expect(outcome.result.purgedEventsCount).toBeGreaterThanOrEqual(1);
        expect(outcome.jobRun.triggeredById).toBe(
          'system:usage-retention-purge',
        );
      }

      const remainingEvents = await docRepo.listUsageEvents(ctx);
      expect(remainingEvents.some((e) => e.id === 'UE-S019-EXPIRED-18M')).toBe(
        false,
      );
      expect(remainingEvents.some((e) => e.id === 'UE-S019-RECENT-2M')).toBe(
        true,
      );

      const purgeAudits = await getAuditRepository().listAuditEntriesForRecord(
        ctx,
        'matter',
        'FIRM-DOCGEN-USAGE-RETENTION',
      );
      expect(
        purgeAudits.some((a) => a.byId === 'system:usage-retention-purge'),
      ).toBe(true);
    });

    it('enforces per-tenant timeout (JOB_TENANT_TIMEOUT), emits PII-free telemetry, and exposes all three CLI jobs in executeCliJobRunner', async () => {
      const entry = makeTestRegistryEntry();
      const registry = validateTenantRegistry({
        schemaVersion: '1.0.0',
        environment: 'test',
        hostingMode: 'multi_tenant',
        tenants: [entry],
      });

      const recorder = getPlatformTelemetryRecorder();
      recorder.clearForTesting();

      await expect(
        guardedJob(
          'key-date-reminders',
          entry,
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            return 'late';
          },
          {
            registry,
            timeoutMs: 25,
          },
        ),
      ).rejects.toMatchObject({
        code: 'JOB_TENANT_TIMEOUT',
      });

      const entries = recorder.getRecentEntries({
        tenantId: 'not-a-law-firm',
      });
      const failedEvent = entries.find(
        (e) => e.eventName === 'job.tenant.failed',
      );
      expect(failedEvent).toBeDefined();
      expect(failedEvent!.properties).toMatchObject({
        jobKey: 'key-date-reminders',
        errorCode: 'JOB_TENANT_TIMEOUT',
      });

      // Verify CLI runner --list and unknown job handling
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const listExit = await executeCliJobRunner(
        ['node', 'dist/jobs/run-job.mjs', '--list'],
        {
          stdout: (line) => stdoutLines.push(line),
          stderr: (line) => stderrLines.push(line),
        },
      );
      expect(listExit).toBe(0);
      const parsedList = JSON.parse(stdoutLines[0]!);
      expect(parsedList.jobs.map((j: { name: string }) => j.name)).toEqual([
        'migrate',
        'key-date-reminders',
        'usage-retention-purge',
        'enquiry-retention-anonymise',
      ]);

      const unknownExit = await executeCliJobRunner(
        ['node', 'dist/jobs/run-job.mjs', 'non-existent-job'],
        {
          stdout: (line) => stdoutLines.push(line),
          stderr: (line) => stderrLines.push(line),
        },
      );
      expect(unknownExit).toBe(1);
    });

    it('synchronises two isolated module graphs (vi.resetModules()) via PostgreSQL pg_try_advisory_xact_lock and job_runs with zero in-process lock state (Lesson 1 & Lesson 2)', async () => {
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const jobRunRepo = getJobRunRepository();
      await jobRunRepo.clearTenantJobRuns(ctx);

      const modA = await import('../../src/server/services');
      vi.resetModules();
      const modB = await import('../../src/server/services');
      expect(modA.executeKeyDateRemindersForTenant).not.toBe(
        modB.executeKeyDateRemindersForTenant,
      );

      let releaseHoldA!: () => void;
      const holdPromiseA = new Promise<void>((resolve) => {
        releaseHoldA = resolve;
      });
      let enteredWorkA!: () => void;
      const enteredPromiseA = new Promise<void>((resolve) => {
        enteredWorkA = resolve;
      });

      const tickNowIso = '2026-08-12T01:15:00.000Z'; // 02:15 BST on 2026-08-12

      // Start Worker A in module graph A and hold inside the transaction while holding pg_try_advisory_xact_lock
      const runAPromise = modA.executeKeyDateRemindersForTenant(ctx, {
        triggerSource: 'scheduled',
        triggeredById: 'system:key-date-reminders',
        timeZone: 'Europe/London',
        nowIso: tickNowIso,
        onAfterWorkBeforeCommit: async () => {
          enteredWorkA();
          await holdPromiseA;
        },
      });

      await enteredPromiseA;

      // While Worker A holds the transaction advisory lock in PostgreSQL, Worker B (isolated module graph B) attempts the same tenant job
      const outcomeBWhileRunning = await modB.executeKeyDateRemindersForTenant(
        ctx,
        {
          triggerSource: 'scheduled',
          triggeredById: 'system:key-date-reminders',
          timeZone: 'Europe/London',
          nowIso: tickNowIso,
        },
      );
      expect(outcomeBWhileRunning.outcome).toBe('already_running');

      // Release Worker A so its transaction commits the succeeded row in job_runs
      releaseHoldA();
      const outcomeA = await runAPromise;
      expect(outcomeA.outcome).toBe('executed');

      // Now Worker B runs again after Worker A committed; it sees the succeeded row in job_runs and returns already_succeeded_today
      const outcomeBAfterCommit = await modB.executeKeyDateRemindersForTenant(
        ctx,
        {
          triggerSource: 'scheduled',
          triggeredById: 'system:key-date-reminders',
          timeZone: 'Europe/London',
          nowIso: tickNowIso,
        },
      );
      expect(outcomeBAfterCommit.outcome).toBe('already_succeeded_today');

      const runs = await jobRunRepo.listJobRuns(ctx, {
        jobKey: 'key-date-reminders',
        localDate: '2026-08-12',
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('succeeded');
    });
  });
});
