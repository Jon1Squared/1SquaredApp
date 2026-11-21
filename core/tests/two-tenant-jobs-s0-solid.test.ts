import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CORE_TENANT_MIGRATIONS,
  getGlobalTenantPostgresPoolManager,
  loadAndValidateTenantConfig,
  resolveTenantFromVerifiedToken,
  TenantJobRunRepository,
  TenantMigrationRunner,
  type EmailSender,
  type KeyDate,
  type TeamsNotifier,
  type TenantConfiguration,
  type TenantContext,
  type TenantRegistry,
  type TenantSqlClient,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import {
  getActiveTenantConfiguration,
  getActiveTenantRawBaseConfig,
  getJobRunRepository,
  getOutboxRepository,
  getPartyRepository,
  getRegisterRepository,
  getTaskWorkflowRepository,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import { guardedJob } from '@/server/authorize';
import {
  getDocumentRepository,
  getEffectiveTenantConfig,
} from '@/server/documentGenerationServices';
import {
  clearAllDataToCleanDeployment,
  executeKeyDateRemindersForTenant,
  executeUsageRetentionPurgeForTenant,
  getKeyDateRepository,
  getKeyDatesConfig,
  resetAllDemoData,
  runScheduledKeyDateRemindersJobSweep,
  runScheduledNotificationDigestsJobSweep,
  runScheduledOutboxDrainJobSweep,
  runScheduledRegisterRemindersJobSweep,
  runScheduledUsageRetentionPurgeJobSweep,
} from '@/server/services';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import {
  setJobRunBeforeCommitHookForTesting,
  setTestActorSession,
} from '@/server/testSupport/auditTestSupport';
import type { Person, Task } from '@/domain/types';

function makeVerifiedTenantCtx(tenantId: string): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: 'P-000001',
      name: `Admin ${tenantId}`,
      email: `admin@${tenantId}.example`,
      tenantId,
      roles: ['admin', 'managing_partner', 'partner', 'risk_compliance'],
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s0solid-${tenantId}`,
  });
}

function makeRegistryEntry(
  tenantId: string,
  packageDir = 'client-not-a-law-firm',
  enabled = true,
) {
  const host = process.env.PLATFORM_POSTGRES_HOST?.trim() || '127.0.0.1';
  const slug = tenantId.replace(/-/g, '_');
  return {
    tenantId,
    slug,
    environment: 'test' as const,
    postgresHost: host,
    postgresDatabaseName: `pg_tenant_${slug}_test`,
    postgresRoleName: `role_tenant_${slug}_test`,
    keyVaultUri: `https://kv-${slug.replace(/_/g, '')}-test.vault.azure.net/`,
    packageDir,
    timeZone: 'Europe/London',
    enabled,
  };
}

function buildTenantConfig(
  tenantId: string,
  overrides: Record<string, unknown> = {},
): TenantConfiguration {
  const rawBase = structuredClone(getActiveTenantRawBaseConfig()) as Record<
    string,
    unknown
  >;
  return loadAndValidateTenantConfig(
    rawBase,
    {
      ...overrides,
      tenantId,
      environment: 'test',
    },
    'test',
    'multi_tenant',
  );
}

function createTempTenantPackage(
  tenantId: string,
  baseOverrides: Record<string, unknown>,
  testOverlayOverrides: Record<string, unknown> = {},
): { dir: string; relDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `1sq-${tenantId}-`));
  const cfgDir = path.join(dir, 'config');
  const envDir = path.join(cfgDir, 'environments');
  fs.mkdirSync(envDir, { recursive: true });
  const rawBase = structuredClone(getActiveTenantRawBaseConfig()) as Record<
    string,
    unknown
  >;
  Object.assign(rawBase, baseOverrides, { tenantId });
  fs.writeFileSync(
    path.join(cfgDir, 'base.json'),
    JSON.stringify(rawBase, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(envDir, 'test.json'),
    JSON.stringify({ tenantId, environment: 'test', ...testOverlayOverrides }, null, 2),
    'utf8',
  );
  return { dir, relDir: path.relative(process.cwd(), dir) };
}

async function seedMinimalTenantEntities(
  ctx: TenantContext,
  tenantConfig: TenantConfiguration,
): Promise<{ matterId: string; personId: string; teamId: string }> {
  const store = createSeedStore(new Date(), { includeSyntheticEntraOids: false });
  await importFirmStoreModulesToPostgres({
    ctx,
    tenantConfig,
    store,
    clearFirst: true,
  });
  await getJobRunRepository().clearTenantJobRuns(ctx);
  await getTaskWorkflowRepository().clearTenantData(ctx);
  await getOutboxRepository().clearTenantData(ctx);
  await getKeyDateRepository().clearTenantData(ctx);
  await getKeyDateRepository().putKeyDatesTenantConfig(ctx, null);
  await getRegisterRepository().clearTenantData(ctx);

  const matter =
    store.matters.find(
      (m) =>
        !m.isStaffMatter &&
        !m.hasEthicalWall &&
        (m.restrictedAccessUserIds?.length ?? 0) === 0,
    ) ?? store.matters[0]!;
  return {
    matterId: matter.id,
    personId: 'P-000001',
    teamId: matter.owningTeamId ?? 'TM-000001',
  };
}

async function withFakeClock<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

describe('Two-tenant scheduled jobs, per-tenant config, timeout abort & live guards (R586, R587, R588, R598)', () => {
  const ctxAlpha = makeVerifiedTenantCtx('tenant-alpha');
  const ctxBravo = makeVerifiedTenantCtx('tenant-bravo');

  beforeAll(async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'tenant-alpha', environment: 'test' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      ],
    });
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
    await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);
  });

  afterEach(async () => {
    setJobRunBeforeCommitHookForTesting(null);
    setTestActorSession(null);
    setActiveTenantConfigForTesting(null);
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await getJobRunRepository().clearTenantJobRuns(ctxAlpha).catch(() => undefined);
    await getJobRunRepository().clearTenantJobRuns(ctxBravo).catch(() => undefined);
  });

  it('R586: tenant config helpers and single-tenant job runners refuse cross-tenant fallback to active process config with TENANT_CONFIG_MISMATCH', async () => {
    const docRepo = getDocumentRepository();

    await expect(getKeyDatesConfig({ ctx: ctxBravo })).rejects.toThrow(
      /TENANT_CONFIG_MISMATCH/,
    );
    await expect(getEffectiveTenantConfig(ctxBravo, docRepo)).rejects.toThrow(
      /TENANT_CONFIG_MISMATCH/,
    );
    await expect(
      executeUsageRetentionPurgeForTenant(ctxBravo, {
        triggerSource: 'manual',
      }),
    ).rejects.toThrow(/TENANT_CONFIG_MISMATCH/);
    await expect(
      executeKeyDateRemindersForTenant(ctxBravo, {
        triggerSource: 'manual',
        triggeredById: 'P-000001',
      }),
    ).rejects.toThrow(/TENANT_CONFIG_MISMATCH/);
  });

  it('R586: scheduled job sweeps resolve each tenant own packageDir configuration instead of active process tenant config', async () => {
    const activeCfg = getActiveTenantConfiguration();
    const rawKeyDates = structuredClone(activeCfg.keyDates) as unknown as Record<
      string,
      unknown
    >;
    const rawDocGen = structuredClone(activeCfg.documentGeneration) as unknown as Record<
      string,
      unknown
    >;

    const makeKeyDatesWithLimitationDays = (days: number[]) => ({
      ...structuredClone(rawKeyDates),
      enabled: true,
      reminderSchedules: [
        {
          id: 'standard',
          label: 'Standard',
          stages: days.map((d) => ({
            daysBefore: d,
            priority: d <= 7 ? 'high' : 'normal',
          })),
          escalation: { afterUnacknowledgedDays: 2, levels: ['team_leads'] },
        },
        {
          id: 'limitation',
          label: 'Limitation',
          stages: days.map((d) => ({
            daysBefore: d,
            priority: d <= 7 ? 'urgent' : 'high',
          })),
          escalation: { afterUnacknowledgedDays: 1, levels: ['team_leads'] },
        },
      ],
    });

    const alphaCfg = buildTenantConfig('tenant-alpha', {
      documentGeneration: {
        ...structuredClone(rawDocGen),
        usage: {
          ...(rawDocGen.usage as Record<string, unknown>),
          retentionMonths: 6,
        },
      },
      keyDates: makeKeyDatesWithLimitationDays([45, 7]),
    });
    const bravoCfg = buildTenantConfig('tenant-bravo', {
      documentGeneration: {
        ...structuredClone(rawDocGen),
        usage: {
          ...(rawDocGen.usage as Record<string, unknown>),
          retentionMonths: 36,
        },
      },
      keyDates: makeKeyDatesWithLimitationDays([14]),
    });

    const pkgAlpha = createTempTenantPackage('tenant-alpha', {
      documentGeneration: alphaCfg.documentGeneration,
      keyDates: alphaCfg.keyDates,
    });
    const pkgBravo = createTempTenantPackage('tenant-bravo', {
      documentGeneration: bravoCfg.documentGeneration,
      keyDates: bravoCfg.keyDates,
    });

    try {
      const alphaEntities = await seedMinimalTenantEntities(ctxAlpha, alphaCfg);
      const bravoEntities = await seedMinimalTenantEntities(ctxBravo, bravoCfg);

      const docRepo = getDocumentRepository();
      const kdRepo = getKeyDateRepository();

      // Seed 18-month-old usage events in BOTH tenants (process active config has retentionMonths = 12,
      // whereas Alpha = 6 [MUST purge] and Bravo = 36 [MUST retain!]).
      const eighteenMonthsAgoIso = '2024-12-10T10:00:00.000Z';
      for (const [ctx, id] of [
        [ctxAlpha, 'UE-R586-ALPHA-18M'],
        [ctxBravo, 'UE-R586-BRAVO-18M'],
      ] as const) {
        await docRepo.putUsageEvent(ctx, {
          id,
          tenantId: ctx.tenantId,
          templateId: 'TPL-R586',
          templateVersionId: 'TPLV-R586',
          versionNumber: 1,
          eventType: 'generated',
          occurredAt: eighteenMonthsAgoIso,
          actorUserId: 'P-000001',
          actorRoleKey: 'partner',
          sourceEntityType: 'matter',
          outputFormat: 'docx',
          missingFieldKeys: [],
          durationMs: 10,
          correlationId: `corr-${id}`,
        });
      }

      // Seed confirmed key dates 20 days in the future on BOTH tenants (2026-06-15 -> 2026-07-05):
      // Alpha has stages [45, 7] -> enters 45-day stage (neither falls back to process config's 30-day stage).
      // Bravo has stage [14] -> enters 14-day stage from Bravo's own packageDir config.
      for (const [ctx, entities, kdId] of [
        [ctxAlpha, alphaEntities, 'KD-R586-ALPHA-20D'],
        [ctxBravo, bravoEntities, 'KD-R586-BRAVO-20D'],
      ] as const) {
        const kd: KeyDate = {
          id: kdId,
          matterId: entities.matterId,
          keyDateTypeId: 'limitation',
          category: 'limitation',
          title: `R586 Config Check ${ctx.tenantId}`,
          dueDate: '2026-07-05',
          isCritical: true,
          status: 'confirmed',
          source: 'manual',
          teamId: entities.teamId,
          responsiblePersonIds: ['P-000001'],
          verification: { required: false },
          createdById: 'P-000001',
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedById: 'P-000001',
          updatedAt: '2026-05-01T10:00:00.000Z',
          version: 1,
        };
        await kdRepo.putKeyDate(ctx, kd, { expectedVersion: null });
      }

      const registry: TenantRegistry = {
        schemaVersion: '1.0.0',
        environment: 'test',
        hostingMode: 'multi_tenant',
        tenants: [
          makeRegistryEntry('tenant-alpha', pkgAlpha.relDir, true),
          makeRegistryEntry('tenant-bravo', pkgBravo.relDir, true),
        ],
      };

      const purgeSummary = await withFakeClock('2026-06-15T01:30:00.000Z', () =>
        runScheduledUsageRetentionPurgeJobSweep({
          registry,
          defaultRunHourLocal: 0,
        }),
      );
      expect(purgeSummary.exitCode).toBe(0);
      expect(purgeSummary.succeededTenants).toEqual(['tenant-alpha', 'tenant-bravo']);

      expect(
        (await docRepo.listUsageEvents(ctxAlpha)).some(
          (e) => e.id === 'UE-R586-ALPHA-18M',
        ),
      ).toBe(false);
      expect(
        (await docRepo.listUsageEvents(ctxBravo)).some(
          (e) => e.id === 'UE-R586-BRAVO-18M',
        ),
      ).toBe(true);

      const kdSummary = await withFakeClock('2026-06-15T01:30:00.000Z', () =>
        runScheduledKeyDateRemindersJobSweep({
          registry,
          defaultRunHourLocal: 0,
        }),
      );
      expect(kdSummary.exitCode).toBe(0);
      expect(kdSummary.succeededTenants).toEqual(['tenant-alpha', 'tenant-bravo']);

      const alphaReminderState = await kdRepo.getReminderState(
        ctxAlpha,
        'KD-R586-ALPHA-20D',
      );
      const bravoReminderState = await kdRepo.getReminderState(
        ctxBravo,
        'KD-R586-BRAVO-20D',
      );
      expect(alphaReminderState?.currentStageDaysBefore).toBe(45);
      expect(bravoReminderState?.currentStageDaysBefore).toBe(14);
    } finally {
      fs.rmSync(pkgAlpha.dir, { recursive: true, force: true });
      fs.rmSync(pkgBravo.dir, { recursive: true, force: true });
    }
  });

  it('R588: guardedJob timeout aborts executeControlledTenantJobRun before COMMIT and leaves zero succeeded job_runs rows', async () => {
    const alphaCfg = buildTenantConfig('tenant-alpha');
    await seedMinimalTenantEntities(ctxAlpha, alphaCfg);

    const taskRepo = getTaskWorkflowRepository();
    const jobRunRepo = getJobRunRepository();
    const pkgAlpha = createTempTenantPackage('tenant-alpha', {});
    try {
      const registry: TenantRegistry = {
        schemaVersion: '1.0.0',
        environment: 'test',
        hostingMode: 'multi_tenant',
        tenants: [makeRegistryEntry('tenant-alpha', pkgAlpha.relDir, true)],
      };

      const timeoutTaskId = 'TSK-R588-TIMEOUT-ROLLBACK';
      let slowWorkSettled = false;

      await expect(
        guardedJob(
          'usage-retention-purge',
          'tenant-alpha',
          ({ tenantContext, signal }) =>
            jobRunRepo.executeControlledTenantJobRun(tenantContext, {
              jobKey: 'usage-retention-purge',
              triggerSource: 'scheduled',
              triggeredById: 'system:usage-retention-purge',
              timeZone: 'Europe/London',
              targetLocalHour: 0,
              now: new Date('2026-07-02T03:00:00.000Z'),
              signal,
              work: async () => {
                await taskRepo.putTask(tenantContext, {
                  id: timeoutTaskId,
                  reference: 'T-TIMEOUT-999999',
                  title: 'Should roll back on timeout',
                  description: 'Rollback verification task',
                  taskTypeId: 'task_type.general',
                  priorityId: 'task_priority.normal',
                  dueAt: '2026-07-03T12:00:00.000Z',
                  assignedTeamId: null,
                  assignedPersonId: null,
                  status: 'To do',
                  linkedRecords: [],
                  createdById: 'P-000001',
                  createdAt: '2026-07-02T03:00:00.000Z',
                  updatedById: 'P-000001',
                  updatedAt: '2026-07-02T03:00:00.000Z',
                  completedById: null,
                  completedAt: null,
                  comments: [],
                });
                await new Promise((resolve) => setTimeout(resolve, 160));
                slowWorkSettled = true;
                return {
                  result: { done: true },
                  summary: { count: 1 },
                };
              },
            } as Parameters<typeof jobRunRepo.executeControlledTenantJobRun>[1]),
          { registry, timeoutMs: 35 },
        ),
      ).rejects.toMatchObject({ code: 'JOB_TENANT_TIMEOUT' });

      // Wait until the slow in-flight handler settles so any un-aborted late COMMIT would have occurred
      for (let i = 0; i < 20 && !slowWorkSettled; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await new Promise((resolve) => setTimeout(resolve, 40));

      const runsAfter = await jobRunRepo.listJobRuns(ctxAlpha, {
        jobKey: 'usage-retention-purge',
        localDate: '2026-07-02',
      });
      expect(runsAfter.filter((r) => r.status === 'succeeded')).toHaveLength(0);
      expect(runsAfter.some((r) => r.status === 'failed')).toBe(true);

      const orphanTask = await taskRepo.getTaskById(ctxAlpha, timeoutTaskId, {
        includeRestricted: true,
      });
      expect(orphanTask).toBeNull();
    } finally {
      fs.rmSync(pkgAlpha.dir, { recursive: true, force: true });
    }
  });

  it('R587 (i): key-date-reminders two-tenant sweep has Alpha positive control and forged/unregistered tenant checks', async () => {
    const rawKeyDates = structuredClone(
      getActiveTenantRawBaseConfig().keyDates,
    ) as Record<string, unknown>;
    const alphaCfg = buildTenantConfig('tenant-alpha', {
      keyDates: { ...structuredClone(rawKeyDates), enabled: true },
    });
    const bravoCfg = buildTenantConfig('tenant-bravo', {
      keyDates: { ...structuredClone(rawKeyDates), enabled: true },
    });
    const alphaEntities = await seedMinimalTenantEntities(ctxAlpha, alphaCfg);
    await seedMinimalTenantEntities(ctxBravo, bravoCfg);

    const kdRepo = getKeyDateRepository();
    const taskRepo = getTaskWorkflowRepository();

    await kdRepo.putKeyDate(ctxAlpha, {
      id: 'KD-R587-ALPHA-DUE',
      matterId: alphaEntities.matterId,
      keyDateTypeId: 'limitation',
      category: 'limitation',
      title: 'R587 Alpha Due Deadline',
      dueDate: '2026-07-10',
      isCritical: true,
      status: 'confirmed',
      source: 'manual',
      teamId: alphaEntities.teamId,
      responsiblePersonIds: ['P-000001'],
      verification: { required: false },
      createdById: 'P-000001',
      createdAt: '2026-06-01T10:00:00.000Z',
      updatedById: 'P-000001',
      updatedAt: '2026-06-01T10:00:00.000Z',
      version: 1,
    }, { expectedVersion: null });

    const registry: TenantRegistry = {
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [
        makeRegistryEntry('tenant-alpha'),
        makeRegistryEntry('tenant-bravo'),
        makeRegistryEntry('tenant-disabled-test', 'client-not-a-law-firm', false),
      ],
    };

    // Unregistered / disabled tenant rejection & forged claim rejection
    await expect(
      guardedJob('key-date-reminders', 'unregistered-evil-tenant', async () => 'no', {
        registry,
      }),
    ).rejects.toMatchObject({ code: 'TENANCY_UNREGISTERED_JOB_TENANT' });
    await expect(
      guardedJob('key-date-reminders', 'tenant-disabled-test', async () => 'no', {
        registry,
      }),
    ).rejects.toMatchObject({ code: 'TENANCY_UNREGISTERED_JOB_TENANT' });
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000001',
          tenantId: 'tenant-alpha',
          roles: ['admin'],
          mfaVerified: true,
          email: 'admin@invented.example',
          name: 'Invented Admin',
        },
        untrustedRequestTenantOverride: 'tenant-bravo',
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged-kd',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);

    const sweep = await withFakeClock('2026-07-06T01:30:00.000Z', () =>
      runScheduledKeyDateRemindersJobSweep({
        registry,
        defaultRunHourLocal: 0,
        tenantConfigOverrideByTenantId: {
          'tenant-alpha': alphaCfg,
          'tenant-bravo': bravoCfg,
        },
      }),
    );
    expect(sweep.exitCode).toBe(0);
    expect(sweep.succeededTenants).toEqual(['tenant-alpha', 'tenant-bravo']);

    const alphaTasks = await taskRepo.listAllTasksUnfiltered<Task>(ctxAlpha);
    const bravoTasks = await taskRepo.listAllTasksUnfiltered<Task>(ctxBravo);
    expect(alphaTasks.some((t) => t.title.includes('R587 Alpha Due Deadline'))).toBe(
      true,
    );
    expect(bravoTasks.some((t) => t.title.includes('R587 Alpha Due Deadline'))).toBe(
      false,
    );
    expect(
      (await kdRepo.getReminderState(ctxAlpha, 'KD-R587-ALPHA-DUE')),
    ).not.toBeNull();
    expect(
      (await kdRepo.getReminderState(ctxBravo, 'KD-R587-ALPHA-DUE')),
    ).toBeNull();
  });

  it('R587 (ii): register-reminders two-tenant sweep has Alpha positive control and forged/unregistered tenant checks', async () => {
    const alphaCfg = buildTenantConfig('tenant-alpha');
    const bravoCfg = buildTenantConfig('tenant-bravo');
    const alphaEntities = await seedMinimalTenantEntities(ctxAlpha, alphaCfg);
    await seedMinimalTenantEntities(ctxBravo, bravoCfg);

    const regRepo = getRegisterRepository();
    const taskRepo = getTaskWorkflowRepository();

    const dueIso = '2026-07-12T12:00:00.000Z';
    const created = await regRepo.createRegisterRecord(ctxAlpha, {
      id: 'REG-R587-ALPHA-DUE',
      registerTypeKey: 'undertaking',
      reference: 'UND-R587-ALPHA-1',
      title: 'R587 Alpha Due Undertaking',
      status: 'open',
      matterId: alphaEntities.matterId,
      ownerId: 'P-000001',
      dueAt: dueIso,
      reminderScheduleDays: [7, 1],
      fieldValues: {
        recipientName: 'Alpha Lender Ltd',
        undertakingTerms: 'Return executed deed',
        givenByPersonId: 'P-000001',
      },
      createdById: 'P-000001',
    });
    expect(created.id).toBe('REG-R587-ALPHA-DUE');

    const registry: TenantRegistry = {
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [
        makeRegistryEntry('tenant-alpha'),
        makeRegistryEntry('tenant-bravo'),
      ],
    };

    await expect(
      guardedJob('register-reminders', 'unregistered-evil-tenant', async () => 'no', {
        registry,
      }),
    ).rejects.toMatchObject({ code: 'TENANCY_UNREGISTERED_JOB_TENANT' });

    const sweep = await withFakeClock('2026-07-11T09:00:00.000Z', () =>
      runScheduledRegisterRemindersJobSweep({
        registry,
        defaultRunHourLocal: 0,
        tenantConfigOverrideByTenantId: {
          'tenant-alpha': alphaCfg,
          'tenant-bravo': bravoCfg,
        },
      }),
    );
    expect(sweep.exitCode).toBe(0);
    expect(sweep.succeededTenants).toEqual(['tenant-alpha', 'tenant-bravo']);

    const alphaNotifs = await taskRepo.listNotificationsForUser(ctxAlpha, 'P-000001');
    const bravoNotifs = await taskRepo.listNotificationsForUser(ctxBravo, 'P-000001');
    expect(
      alphaNotifs.some(
        (n) =>
          n.kind === 'register_reminder' &&
          n.href?.includes('REG-R587-ALPHA-DUE'),
      ),
    ).toBe(true);
    expect(
      bravoNotifs.some((n) => n.href?.includes('REG-R587-ALPHA-DUE')),
    ).toBe(false);
    expect(await regRepo.getRegisterRecordById(ctxBravo, 'REG-R587-ALPHA-DUE')).toBeNull();
  });

  it('R587 (iii): outbox-drain two-tenant sweep has Alpha positive control (email + Teams) and forged/unregistered tenant checks', async () => {
    const emailEnabled = {
      email: {
        provider: 'dev_catcher',
        senderAddress: 'noreply@notalawfirm.example',
        recipientAllowList: ['@alpha.example'],
        devCatcher: { host: '127.0.0.1', port: 1025, secure: false },
      },
      teams: {
        provider: 'dev_catcher',
        recipientAllowList: ['@alpha.example'],
        devCatcher: { endpointUrl: 'http://127.0.0.1:19999/teams-catcher' },
      },
    };
    const alphaCfg = buildTenantConfig('tenant-alpha', {
      integrations: {
        ...getActiveTenantRawBaseConfig().integrations as Record<string, unknown>,
        ...emailEnabled,
      },
    });
    const bravoCfg = buildTenantConfig('tenant-bravo', {
      integrations: {
        ...getActiveTenantRawBaseConfig().integrations as Record<string, unknown>,
        email: {
          provider: 'dev_catcher',
          senderAddress: 'noreply@notalawfirm.example',
          recipientAllowList: ['@bravo.example'],
          devCatcher: { host: '127.0.0.1', port: 1025, secure: false },
        },
        teams: {
          provider: 'dev_catcher',
          recipientAllowList: ['@bravo.example'],
          devCatcher: { endpointUrl: 'http://127.0.0.1:19999/teams-catcher' },
        },
      },
    });

    await seedMinimalTenantEntities(ctxAlpha, alphaCfg);
    await seedMinimalTenantEntities(ctxBravo, bravoCfg);

    const partyRepo = getPartyRepository();
    const alphaPerson = await partyRepo.getPersonById<Person>(ctxAlpha, 'P-000001');
    if (alphaPerson) {
      await partyRepo.putPerson(ctxAlpha, {
        ...alphaPerson,
        entraObjectId: '00000000-0000-4000-8000-00000000a001',
        emails: [{ id: 'em-a', typeId: null, address: 'alpha-user@alpha.example', isPrimary: true }],
      });
    }

    const outboxRepo = getOutboxRepository();
    const emailRow = await outboxRepo.enqueueEmail(ctxAlpha, {
      idempotencyKey: 'r587-outbox-alpha-email',
      templateKey: 'notification.approval_requested',
      recipients: { to: ['alpha-user@alpha.example'] },
      subject: 'Alpha Outbox Positive Control',
      htmlBody: '<p>Alpha</p>',
      textBody: 'Alpha',
    });
    const teamsRow = await outboxRepo.enqueueTeamsActivity(ctxAlpha, {
      idempotencyKey: 'r587-outbox-alpha-teams',
      recipientPersonId: 'P-000001',
      activityType: 'taskAssigned',
      previewText: 'Alpha Teams Positive Control',
      deepLinkPath: '/tasks/TSK-1',
      correlationId: 'corr-alpha-teams',
    });

    const sentEmails: Array<{ tenantId: string; to: readonly string[] }> = [];
    const sentTeams: Array<{ tenantId: string; key: string }> = [];

    const emailSender: EmailSender = {
      provider: 'dev_catcher',
      send: async (sendCtx, msg) => {
        sentEmails.push({ tenantId: sendCtx.tenantId, to: msg.recipients.to });
        return { status: 'sent', provider: 'dev_catcher', providerMessageId: 'msg-1' };
      },
    };
    const teamsNotifier: TeamsNotifier = {
      provider: 'dev_catcher',
      sendActivity: async (sendCtx, act) => {
        sentTeams.push({ tenantId: sendCtx.tenantId, key: act.idempotencyKey });
        return { outcome: 'sent', providerRequestId: 'teams-1' };
      },
    };

    const registry: TenantRegistry = {
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [
        makeRegistryEntry('tenant-alpha'),
        makeRegistryEntry('tenant-bravo'),
      ],
    };

    await expect(
      guardedJob('outbox-drain', 'unregistered-evil-tenant', async () => 'no', {
        registry,
      }),
    ).rejects.toMatchObject({ code: 'TENANCY_UNREGISTERED_JOB_TENANT' });

    const sweep = await runScheduledOutboxDrainJobSweep({
      registry,
      tenantConfigOverrideByTenantId: {
        'tenant-alpha': alphaCfg,
        'tenant-bravo': bravoCfg,
      },
      emailSender,
      teamsNotifier,
    });

    expect(sweep.exitCode).toBe(0);
    expect(sweep.succeededTenants).toEqual(['tenant-alpha', 'tenant-bravo']);
    expect(sentEmails).toEqual([
      { tenantId: 'tenant-alpha', to: ['alpha-user@alpha.example'] },
    ]);
    expect(sentTeams).toEqual([
      { tenantId: 'tenant-alpha', key: 'r587-outbox-alpha-teams' },
    ]);
    expect(
      (await outboxRepo.getOutboxRecordById(ctxAlpha, emailRow.record.id))?.status,
    ).toBe('sent');
    expect(
      (await outboxRepo.getTeamsOutboxRecordById(ctxAlpha, teamsRow.record.id))
        ?.status,
    ).toBe('sent');
    expect(await outboxRepo.listOutboxRecords(ctxBravo)).toHaveLength(0);
    expect(await outboxRepo.listTeamsOutboxRecords(ctxBravo)).toHaveLength(0);
  });

  it('R587 (iv): notification-digests two-tenant sweep has Alpha positive control and forged/unregistered tenant checks', async () => {
    const emailEnabled = {
      email: {
        provider: 'dev_catcher',
        senderAddress: 'noreply@notalawfirm.example',
        recipientAllowList: ['@alpha.example'],
        devCatcher: { host: '127.0.0.1', port: 1025, secure: false },
      },
    };
    const alphaCfg = buildTenantConfig('tenant-alpha', {
      integrations: {
        ...(getActiveTenantRawBaseConfig().integrations as Record<string, unknown>),
        ...emailEnabled,
      },
    });
    const bravoCfg = buildTenantConfig('tenant-bravo');

    await seedMinimalTenantEntities(ctxAlpha, alphaCfg);
    await seedMinimalTenantEntities(ctxBravo, bravoCfg);

    const partyRepo = getPartyRepository();
    const taskRepo = getTaskWorkflowRepository();
    const outboxRepo = getOutboxRepository();

    const alphaPerson = await partyRepo.getPersonById<Person>(ctxAlpha, 'P-000001');
    if (alphaPerson) {
      await partyRepo.putPerson(ctxAlpha, {
        ...alphaPerson,
        emails: [{ id: 'em-a', typeId: null, address: 'alpha-digest@alpha.example', isPrimary: true }],
      });
    }
    await outboxRepo.upsertNotificationPreference(ctxAlpha, {
      personId: 'P-000001',
      notificationKind: 'general',
      emailFrequency: 'daily_digest',
      teamsEnabled: false,
      digestDayOfWeek: 1,
    });
    await taskRepo.putNotification(ctxAlpha, {
      id: 'NTF-R587-DIGEST-ALPHA',
      recipientId: 'P-000001',
      kind: 'general',
      title: 'Alpha Daily Digest Item',
      detail: 'Alpha confidential item',
      href: '/home',
      recordId: 'NTF-R587-DIGEST-ALPHA',
      createdAt: '2026-07-13T05:00:00.000Z', // Monday
      read: false,
      byId: 'P-000001',
    });

    const sentDigestRecipients: string[] = [];
    const emailSender: EmailSender = {
      provider: 'dev_catcher',
      send: async (sendCtx, msg) => {
        sentDigestRecipients.push(
          `${sendCtx.tenantId}:${msg.recipients.to.join(',')}`,
        );
        return { status: 'sent', provider: 'dev_catcher', providerMessageId: 'dig-1' };
      },
    };

    const registry: TenantRegistry = {
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [
        makeRegistryEntry('tenant-alpha'),
        makeRegistryEntry('tenant-bravo'),
        makeRegistryEntry('tenant-disabled-test', 'client-not-a-law-firm', false),
      ],
    };

    // Unregistered & disabled tenant checks
    await expect(
      guardedJob('notification-digests', 'unregistered-evil-tenant', async () => 'no', {
        registry,
      }),
    ).rejects.toMatchObject({ code: 'TENANCY_UNREGISTERED_JOB_TENANT' });
    await expect(
      guardedJob('notification-digests', 'tenant-disabled-test', async () => 'no', {
        registry,
      }),
    ).rejects.toMatchObject({ code: 'TENANCY_UNREGISTERED_JOB_TENANT' });

    // Forged OIDC claim check
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000001',
          tenantId: 'tenant-alpha',
          roles: ['admin'],
          mfaVerified: true,
          email: 'admin@invented.example',
          name: 'Invented Admin',
        },
        untrustedRequestTenantOverride: 'tenant-bravo',
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged-digest',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);

    // Monday 2026-11-23T09:00:00Z -> positive control executes on Alpha and compiles 0 items on Bravo
    const sweep = await runScheduledNotificationDigestsJobSweep({
      registry,
      digestHourLocal: 0,
      now: new Date('2026-11-23T09:00:00.000Z'),
      tenantConfigOverrideByTenantId: {
        'tenant-alpha': alphaCfg,
        'tenant-bravo': bravoCfg,
      },
      emailSender,
    });
    expect(sweep.exitCode).toBe(0);
    expect(sweep.succeededTenants).toEqual(['tenant-alpha', 'tenant-bravo']);

    const alphaOutbox = await outboxRepo.listOutboxRecords(ctxAlpha);
    const bravoOutbox = await outboxRepo.listOutboxRecords(ctxBravo);
    expect(alphaOutbox.some((r) => r.templateKey.includes('digest'))).toBe(true);
    expect(bravoOutbox).toHaveLength(0);
    expect(sentDigestRecipients).toEqual(['tenant-alpha:alpha-digest@alpha.example']);
  });

  it('R587 (v): one tenant failing in a scheduled sweep does not prevent the second tenant from succeeding', async () => {
    const rawKeyDates = structuredClone(
      getActiveTenantConfiguration().keyDates,
    ) as unknown as Record<string, unknown>;
    const alphaCfg = buildTenantConfig('tenant-alpha', {
      keyDates: { ...structuredClone(rawKeyDates), enabled: true },
    });
    const bravoCfg = buildTenantConfig('tenant-bravo', {
      keyDates: { ...structuredClone(rawKeyDates), enabled: true },
    });
    const alphaEntities = await seedMinimalTenantEntities(ctxAlpha, alphaCfg);
    await seedMinimalTenantEntities(ctxBravo, bravoCfg);

    await getKeyDateRepository().putKeyDate(ctxAlpha, {
      id: 'KD-R587-FAULT-ALPHA',
      matterId: alphaEntities.matterId,
      keyDateTypeId: 'limitation',
      category: 'limitation',
      title: 'R587 Alpha Fault Isolation Key Date',
      dueDate: '2026-07-16',
      isCritical: true,
      status: 'confirmed',
      source: 'manual',
      teamId: alphaEntities.teamId,
      responsiblePersonIds: ['P-000001'],
      verification: { required: false },
      createdById: 'P-000001',
      createdAt: '2026-06-01T10:00:00.000Z',
      updatedById: 'P-000001',
      updatedAt: '2026-06-01T10:00:00.000Z',
      version: 1,
    }, { expectedVersion: null });

    const outboxRepo = getOutboxRepository();
    await outboxRepo.enqueueEmail(ctxBravo, {
      idempotencyKey: 'r587-fault-iso-bravo',
      templateKey: 'notification.approval_requested',
      recipients: { to: ['bravo-user@bravo.example'] },
      subject: 'Bravo Succeeds When Alpha Fails',
      htmlBody: '<p>Bravo</p>',
      textBody: 'Bravo',
    });

    const bothValidRegistry: TenantRegistry = {
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [
        makeRegistryEntry('tenant-alpha'),
        makeRegistryEntry('tenant-bravo'),
      ],
    };

    const kdSpy = vi
      .spyOn(getKeyDateRepository(), 'putReminderState')
      .mockRejectedValueOnce(new Error('SIMULATED_ALPHA_REMINDER_WRITE_FAILURE'));
    let kdFaultSummary;
    try {
      kdFaultSummary = await withFakeClock('2026-07-14T09:00:00.000Z', () =>
        runScheduledKeyDateRemindersJobSweep({
          registry: bothValidRegistry,
          defaultRunHourLocal: 0,
          tenantConfigOverrideByTenantId: {
            'tenant-alpha': alphaCfg,
            'tenant-bravo': bravoCfg,
          },
        }),
      );
    } finally {
      kdSpy.mockRestore();
    }
    expect(kdFaultSummary.exitCode).toBe(1);
    expect(kdFaultSummary.failedTenants.map((f) => f.tenantId)).toEqual([
      'tenant-alpha',
    ]);
    expect(kdFaultSummary.succeededTenants).toEqual(['tenant-bravo']);

    const alphaKdRuns = await getJobRunRepository().listJobRuns(ctxAlpha, {
      jobKey: 'key-date-reminders',
      localDate: '2026-07-14',
    });
    expect(alphaKdRuns.some((r) => r.status === 'failed')).toBe(true);
    expect(alphaKdRuns.some((r) => r.status === 'succeeded')).toBe(false);

    const bravoKdRuns = await getJobRunRepository().listJobRuns(ctxBravo, {
      jobKey: 'key-date-reminders',
      localDate: '2026-07-14',
    });
    expect(bravoKdRuns.some((r) => r.status === 'succeeded')).toBe(true);

    // Outbox drain: simulate Alpha throwing in emailSender while Bravo succeeds cleanly
    const activeIntegrations = structuredClone(
      getActiveTenantConfiguration().integrations,
    ) as Record<string, unknown>;
    const bravoEmailCfg = buildTenantConfig('tenant-bravo', {
      integrations: {
        ...structuredClone(activeIntegrations),
        email: {
          provider: 'dev_catcher',
          senderAddress: 'noreply@notalawfirm.example',
          recipientAllowList: ['@bravo.example'],
          devCatcher: { host: '127.0.0.1', port: 1025, secure: false },
        },
      },
    });
    const alphaEmailCfg = buildTenantConfig('tenant-alpha', {
      integrations: {
        ...structuredClone(activeIntegrations),
        email: {
          provider: 'dev_catcher',
          senderAddress: 'noreply@notalawfirm.example',
          recipientAllowList: ['@alpha.example'],
          devCatcher: { host: '127.0.0.1', port: 1025, secure: false },
        },
      },
    });
    await outboxRepo.enqueueEmail(ctxAlpha, {
      idempotencyKey: 'r587-fault-iso-alpha',
      templateKey: 'notification.approval_requested',
      recipients: { to: ['alpha-user@alpha.example'] },
      subject: 'Alpha Throws Mid-Send',
      htmlBody: '<p>Alpha</p>',
      textBody: 'Alpha',
    });

    const outboxFaultSummary = await runScheduledOutboxDrainJobSweep({
      registry: bothValidRegistry,
      tenantConfigOverrideByTenantId: {
        'tenant-alpha': alphaEmailCfg,
        'tenant-bravo': bravoEmailCfg,
      },
      emailSender: {
        provider: 'dev_catcher',
        send: async (sendCtx) => {
          if (sendCtx.tenantId === 'tenant-alpha') {
            throw new Error('SIMULATED_ALPHA_SMTP_CRASH');
          }
          return {
            status: 'sent',
            provider: 'dev_catcher',
            providerMessageId: 'bravo-ok',
          };
        },
      },
    });
    // Outbox drain isolates per-tenant failures or records failedTenants depending on where error throws;
    // Bravo's queued row MUST always succeed cleanly regardless of Alpha!
    expect(outboxFaultSummary.succeededTenants).toContain('tenant-bravo');
    const bravoOutboxAfter = await outboxRepo.listOutboxRecords(ctxBravo);
    expect(
      bravoOutboxAfter.find((r) => r.idempotencyKey === 'r587-fault-iso-bravo')
        ?.status,
    ).toBe('sent');
  });

  it('R598: resetAllDemoData, clearAllDataToCleanDeployment, and importFirmStoreModulesToPostgres refuse live environment', async () => {
    const liveCtx = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-000001',
        name: 'Live Admin',
        email: 'admin@live-tenant.example',
        tenantId: 'not-a-law-firm',
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      },
      hostingMode: 'single_tenant',
      environment: 'live',
      correlationId: 'corr-r598-live-guard',
    });
    const rawBase = structuredClone(getActiveTenantRawBaseConfig()) as Record<
      string,
      unknown
    >;
    const liveConfig = loadAndValidateTenantConfig(
      rawBase,
      { tenantId: 'not-a-law-firm', environment: 'live' },
      'live',
      'single_tenant',
    );

    await expect(resetAllDemoData('P-000001', liveCtx)).rejects.toThrow(
      /DEMO_DATA_LIVE_FORBIDDEN/,
    );
    await expect(
      clearAllDataToCleanDeployment('P-000001', liveCtx),
    ).rejects.toThrow(/DEMO_DATA_LIVE_FORBIDDEN/);
    await expect(
      importFirmStoreModulesToPostgres({
        ctx: liveCtx,
        tenantConfig: liveConfig,
        store: createSeedStore(),
        clearFirst: true,
      }),
    ).rejects.toThrow(/DEMO_DATA_LIVE_FORBIDDEN/);
  });

  it('R614: aborting signal during the final succeeded job_runs insert rolls back both domain writes and the succeeded job_runs row while isolating other tenants', async () => {
    const alphaCfg = buildTenantConfig('tenant-alpha');
    const bravoCfg = buildTenantConfig('tenant-bravo');
    await seedMinimalTenantEntities(ctxAlpha, alphaCfg);
    await seedMinimalTenantEntities(ctxBravo, bravoCfg);

    const taskRepo = getTaskWorkflowRepository();
    const controller = new AbortController();
    const r614JobRepo = new (class extends TenantJobRunRepository {
      override withTenantTransaction<T>(
        txCtx: TenantContext,
        fn: (tx: TenantSqlClient) => Promise<T>,
        txOpts?: { statementTimeoutMs?: number },
      ): Promise<T> {
        return super.withTenantTransaction(
          txCtx,
          (tx) => {
            const origQuery = tx.query.bind(tx);
            const spiedTx: TenantSqlClient = {
              query: async <TRow = Record<string, unknown>>(
                sql: string,
                queryParams?: readonly unknown[],
              ) => {
                const res = await origQuery<TRow>(sql, queryParams);
                if (
                  txCtx.tenantId === 'tenant-alpha' &&
                  sql.includes('INSERT INTO public.job_runs') &&
                  (sql.includes("'succeeded'") || queryParams?.[6] === 'succeeded')
                ) {
                  controller.abort(
                    Object.assign(
                      new Error('JOB_TENANT_TIMEOUT: aborted after succeeded job_runs insert'),
                      { code: 'JOB_TENANT_TIMEOUT' },
                    ),
                  );
                }
                return res;
              },
            };
            return fn(spiedTx);
          },
          txOpts,
        );
      }
    })();

    const abortedTaskId = 'TSK-R614-POST-INSERT-ABORT';
    await expect(
      r614JobRepo.executeControlledTenantJobRun(ctxAlpha, {
        jobKey: 'usage-retention-purge',
        triggerSource: 'scheduled',
        triggeredById: 'system:usage-retention-purge',
        timeZone: 'Europe/London',
        targetLocalHour: 0,
        now: new Date('2026-07-04T03:00:00.000Z'),
        signal: controller.signal,
        work: async () => {
          await taskRepo.putTask(ctxAlpha, {
            id: abortedTaskId,
            reference: 'T-R614-ABORT',
            title: 'Must roll back when aborted post-insert',
            description: 'R614 post-insert abort rollback check',
            taskTypeId: 'task_type.general',
            priorityId: 'task_priority.normal',
            dueAt: '2026-07-05T12:00:00.000Z',
            assignedTeamId: null,
            assignedPersonId: null,
            status: 'To do',
            linkedRecords: [],
            createdById: 'P-000001',
            createdAt: '2026-07-04T03:00:00.000Z',
            updatedById: 'P-000001',
            updatedAt: '2026-07-04T03:00:00.000Z',
            completedById: null,
            completedAt: null,
            comments: [],
          });
          return { result: { purged: 1 }, summary: { count: 1 } };
        },
      }),
    ).rejects.toMatchObject({ code: 'JOB_TENANT_TIMEOUT' });

    const alphaRuns = await r614JobRepo.listJobRuns(ctxAlpha, {
      jobKey: 'usage-retention-purge',
      localDate: '2026-07-04',
    });
    expect(alphaRuns.filter((r) => r.status === 'succeeded')).toHaveLength(0);
    expect(
      await taskRepo.getTaskById(ctxAlpha, abortedTaskId, {
        includeRestricted: true,
      }),
    ).toBeNull();

    // Positive control: unaffected Tenant Bravo completes cleanly
    const bravoController = new AbortController();
    const bravoOutcome = await r614JobRepo.executeControlledTenantJobRun(ctxBravo, {
      jobKey: 'usage-retention-purge',
      triggerSource: 'scheduled',
      triggeredById: 'system:usage-retention-purge',
      timeZone: 'Europe/London',
      targetLocalHour: 0,
      now: new Date('2026-07-04T03:00:00.000Z'),
      signal: bravoController.signal,
      work: async () => ({ result: { purged: 0 }, summary: { count: 0 } }),
    });
    expect(bravoOutcome.outcome).toBe('executed');
  });

  it('R618: scheduled job sweeps reject tenantConfigOverrideByTenantId when NODE_ENV !== "test"', async () => {
    const alphaCfg = buildTenantConfig('tenant-alpha');
    const registry: TenantRegistry = {
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [makeRegistryEntry('tenant-alpha')],
    };

    vi.stubEnv('NODE_ENV', 'production');
    try {
      await expect(
        runScheduledKeyDateRemindersJobSweep({
          registry,
          tenantConfigOverrideByTenantId: { 'tenant-alpha': alphaCfg },
        }),
      ).rejects.toThrow(/SECURITY_ERROR/);
      await expect(
        runScheduledOutboxDrainJobSweep({
          registry,
          tenantConfigOverrideByTenantId: { 'tenant-alpha': alphaCfg },
        }),
      ).rejects.toThrow(/SECURITY_ERROR/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('R632: withTenantTransaction rejects and rolls back earlier writes when an un-awaited or caught-and-ignored queued query aborts the PostgreSQL transaction', async () => {
    const alphaCfg = buildTenantConfig('tenant-alpha');
    const bravoCfg = buildTenantConfig('tenant-bravo');
    await seedMinimalTenantEntities(ctxAlpha, alphaCfg);
    await seedMinimalTenantEntities(ctxBravo, bravoCfg);

    const taskRepo = getTaskWorkflowRepository();

    const makeR632Task = (id: string, reference: string, title: string): Task => ({
      id,
      reference,
      title,
      description: 'R632 aborted transaction regression check',
      taskTypeId: 'task_type.general',
      priorityId: 'task_priority.normal',
      dueAt: '2026-07-06T12:00:00.000Z',
      assignedTeamId: null,
      assignedPersonId: null,
      status: 'To do',
      linkedRecords: [],
      createdById: 'P-000001',
      createdAt: '2026-07-05T03:00:00.000Z',
      updatedById: 'P-000001',
      updatedAt: '2026-07-05T03:00:00.000Z',
      completedById: null,
      completedAt: null,
      comments: [],
    });

    // 1. Un-awaited failing query leaves transaction aborted in PostgreSQL
    const unawaitedTaskId = 'TSK-R632-UNAWAITED';
    await expect(
      taskRepo.withTenantTransaction(ctxAlpha, async (tx) => {
        await taskRepo.putTask(
          ctxAlpha,
          makeR632Task(unawaitedTaskId, 'T-R632-UNAW', 'Must roll back unawaited failure'),
        );
        void tx.query('SELECT 1 / 0');
        return 'committed';
      }),
    ).rejects.toMatchObject({ code: 'TENANCY_TRANSACTION_ABORTED' });

    expect(
      await taskRepo.getTaskById(ctxAlpha, unawaitedTaskId, {
        includeRestricted: true,
      }),
    ).toBeNull();

    // 2. Caught and swallowed failing query still leaves PostgreSQL transaction aborted
    const caughtTaskId = 'TSK-R632-CAUGHT';
    await expect(
      taskRepo.withTenantTransaction(ctxAlpha, async (tx) => {
        await taskRepo.putTask(
          ctxAlpha,
          makeR632Task(caughtTaskId, 'T-R632-CGHT', 'Must roll back swallowed failure'),
        );
        try {
          await tx.query('SELECT 1 / 0');
        } catch {
          // Intentionally swallowed by buggy caller
        }
        return 'committed';
      }),
    ).rejects.toMatchObject({ code: 'TENANCY_TRANSACTION_ABORTED' });

    expect(
      await taskRepo.getTaskById(ctxAlpha, caughtTaskId, {
        includeRestricted: true,
      }),
    ).toBeNull();

    // 3. Defence in depth: non-COMMIT response to COMMIT throws TENANCY_TRANSACTION_ABORTED
    const poolMgr = getGlobalTenantPostgresPoolManager();
    const origGetPool = poolMgr.getPoolForTenant.bind(poolMgr);
    let intercepted = false;
    const poolSpy = vi
      .spyOn(poolMgr, 'getPoolForTenant')
      .mockImplementation(async (targetCtx) => {
        const res = await origGetPool(targetCtx);
        if (!intercepted && targetCtx.tenantId === 'tenant-alpha') {
          intercepted = true;
          const origConnect = res.pool.connect.bind(res.pool);
          vi.spyOn(res.pool, 'connect').mockImplementationOnce(async () => {
            const client = await origConnect();
            const origQuery = client.query.bind(client);
            client.query = (async (sql: unknown, params?: unknown) => {
              if (typeof sql === 'string' && sql.trim() === 'COMMIT') {
                client.query = origQuery;
                await (origQuery as (q: string) => Promise<unknown>)('ROLLBACK');
                return { command: 'ROLLBACK', rows: [], rowCount: 0 };
              }
              return (origQuery as (q: unknown, p?: unknown) => Promise<unknown>)(
                sql,
                params,
              );
            }) as typeof client.query;
            return client;
          });
        }
        return res;
      });

    const commitAbortTaskId = 'TSK-R632-COMMIT-ROLLBACK';
    try {
      await expect(
        taskRepo.withTenantTransaction(ctxAlpha, async () => {
          await taskRepo.putTask(
            ctxAlpha,
            makeR632Task(
              commitAbortTaskId,
              'T-R632-CMTR',
              'Must throw when COMMIT returns ROLLBACK',
            ),
          );
          return 'committed';
        }),
      ).rejects.toMatchObject({ code: 'TENANCY_TRANSACTION_ABORTED' });
    } finally {
      poolSpy.mockRestore();
    }

    expect(
      await taskRepo.getTaskById(ctxAlpha, commitAbortTaskId, {
        includeRestricted: true,
      }),
    ).toBeNull();

    // 4. Swallowed 23505 unique violation inside withTenantTransaction wraps as TENANCY_TRANSACTION_ABORTED with SQLSTATE in cause
    const swallowed23505TaskId = 'TSK-R632-SWALLOWED-23505';
    let caught23505TxErr: unknown = null;
    try {
      await taskRepo.withTenantTransaction(ctxAlpha, async (tx) => {
        await taskRepo.putTask(
          ctxAlpha,
          makeR632Task(
            swallowed23505TaskId,
            'T-R632-23505',
            'Must roll back swallowed 23505',
          ),
        );
        await tx.query(
          'INSERT INTO tenant_record_sequences (tenant_id, counter_key, last_value) VALUES ($1, $2, 1)',
          [ctxAlpha.tenantId, 'R632-DUP-KEY-4'],
        );
        try {
          await tx.query(
            'INSERT INTO tenant_record_sequences (tenant_id, counter_key, last_value) VALUES ($1, $2, 1)',
            [ctxAlpha.tenantId, 'R632-DUP-KEY-4'],
          );
        } catch {
          // Swallowed unique violation inside caller callback
        }
        return 'committed';
      });
    } catch (err) {
      caught23505TxErr = err;
    }
    expect(caught23505TxErr).toMatchObject({
      code: 'TENANCY_TRANSACTION_ABORTED',
      cause: { code: '23505' },
    });
    expect(
      await taskRepo.getTaskById(ctxAlpha, swallowed23505TaskId, {
        includeRestricted: true,
      }),
    ).toBeNull();

    // 5. Swallowed 23505 inside scheduled executeControlledTenantJobRun fails with TENANCY_TRANSACTION_ABORTED (never already_succeeded_today)
    const jobRunRepo = getJobRunRepository();
    let jobErr: unknown = null;
    try {
      await jobRunRepo.executeControlledTenantJobRun(ctxAlpha, {
        jobKey: 'register-reminders',
        triggerSource: 'scheduled',
        triggeredById: 'system:register-reminders',
        timeZone: 'UTC',
        targetLocalHour: 0,
        now: new Date('2026-07-07T03:00:00.000Z'),
        work: async ({ tx }) => {
          await tx.query(
            'INSERT INTO tenant_record_sequences (tenant_id, counter_key, last_value) VALUES ($1, $2, 1)',
            [ctxAlpha.tenantId, 'R632-DUP-KEY-5'],
          );
          try {
            await tx.query(
              'INSERT INTO tenant_record_sequences (tenant_id, counter_key, last_value) VALUES ($1, $2, 1)',
              [ctxAlpha.tenantId, 'R632-DUP-KEY-5'],
            );
          } catch {
            // Swallowed unique violation inside scheduled job work
          }
          return { result: 'unexpected', summary: { count: 1 } };
        },
      });
    } catch (err) {
      jobErr = err;
    }
    expect(jobErr).toMatchObject({
      code: 'TENANCY_TRANSACTION_ABORTED',
      cause: { code: '23505' },
    });
    const r632FailedRuns = await jobRunRepo.listJobRuns(ctxAlpha, {
      jobKey: 'register-reminders',
      localDate: '2026-07-07',
    });
    expect(r632FailedRuns.some((r) => r.status === 'succeeded')).toBe(false);
    expect(
      r632FailedRuns.some(
        (r) =>
          r.status === 'failed' &&
          r.errorCode === 'TENANCY_TRANSACTION_ABORTED',
      ),
    ).toBe(true);
    expect(
      await jobRunRepo.listJobRuns(ctxBravo, {
        jobKey: 'register-reminders',
        localDate: '2026-07-07',
      }),
    ).toHaveLength(0);

    // Two-tenant positive control: Tenant Bravo commits cleanly
    const bravoTaskId = 'TSK-R632-BRAVO-OK';
    await taskRepo.withTenantTransaction(ctxBravo, async () => {
      await taskRepo.putTask(
        ctxBravo,
        makeR632Task(bravoTaskId, 'T-R632-BRVO', 'Bravo transaction commits cleanly'),
      );
    });
    expect(
      await taskRepo.getTaskById(ctxBravo, bravoTaskId, {
        includeRestricted: true,
      }),
    ).toMatchObject({ id: bravoTaskId, reference: 'T-R632-BRVO' });
  });
});
