import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadAndValidateTenantConfig,
  quotePgIdentifier,
  resolvePostgresMigrateUser,
  resolvePostgresRuntimeUser,
} from '@platform/core';
import { provisionEntraPostgresClusterRolesAndDatabases } from '../../../core/src/tenancy/postgresAdminBootstrap';
import { resolvePublicAppOrigin } from '@/server/entraAuth';
import {
  runProvisionJobSweep,
  runSeedDemoJobSweep,
} from '../../../scripts/run-job';
import {
  computeMatterOpeningChecklistProgress,
  isMatterConflictCheckAwaitingDecision,
  isMatterOpeningInProgress,
} from '@/domain/matterOpeningRecord';
import { isPrivilegedPersonForEmailLinking } from '@/domain/rbac';
import { selectHomeCandidateTasks } from '@/domain/homeTasks';
import { isComplianceOrOnboardingTask } from '@/domain/tasks';
import {
  createVerifiedTenantContext,
  getActiveTenantConfiguration,
  getActiveTenantRawBaseConfig,
  isNonLiveDemoEnvironment,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import {
  buildCommittedSeedStoreSnapshot,
  loadCommittedSeedStore,
  loadCommittedSeedStoreRaw,
} from '@/seed/seedSnapshot';
import { createCleanDeploymentStore } from '@/seed/seedStoreBuilder';
import {
  clearAllDataToCleanDeployment,
  getAppSnapshot,
  getCatalogueRepository,
  getKeyDateRepository,
  getMatterRepository,
  getPartyRepository,
  getTaskWorkflowRepository,
  isDataResetAllowedEnvironment,
  isDemoModeEnabled,
  resetAllDemoData,
} from '@/server/services';
import { getMyFinanceFigures } from '@/server/financeServices';
import { isActionDenied } from '@/domain/actionResult';
import { getDocumentGenerationSnapshotForUser } from '@/server/documentGenerationServices';
import { runWithActiveActorSession } from '@/domain/rbac';
import {
  createSignedEntraSessionCookie,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import {
  clearMigratedPostgresModulesForTenant,
  importFirmStoreModulesToPostgres,
} from '@/server/storePostgresImport';
import { runSeedDemoTenant } from '../../../scripts/seed-demo-tenant';
import { testDataResetContext } from '@/test/testTenantContexts';

function makeDemoEnvTenantCtx() {
  const cfg = getActiveTenantConfiguration();
  return createVerifiedTenantContext(
    {
      sub: 'system:seed-demo',
      tenantId: 'not-a-law-firm',
      name: 'System Seed Demo',
      email: 'seed-demo@notalawfirm.example',
      roles: ['admin'],
      mfaVerified: true,
      correlationId: 'corr-demo-tenant-test',
    },
    {
      ...cfg,
      tenantId: 'not-a-law-firm',
      hostingMode: 'multi_tenant',
      environment: 'demo',
    },
  );
}

describe('S0-11b: Demo tenant configuration, clean store fallback, and seed:demo command', () => {
  afterEach(() => {
    setActiveTenantConfigForTesting(null);
  });

  it('1. enables demo mode in NODE_ENV=production when environment is demo and enableDemoMode is true, and never in live or when enableDemoMode is false', () => {
    const baseCfg = getActiveTenantRawBaseConfig();

    // Simulate a production build (NODE_ENV=production) with PLATFORM_ENVIRONMENT=demo loading environments/demo.json
    setActiveTenantConfigForTesting(null);
    vi.stubEnv('PLATFORM_ENVIRONMENT', 'demo');
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(isNonLiveDemoEnvironment()).toBe(true);
      expect(isDemoModeEnabled()).toBe(true);
      expect(isDataResetAllowedEnvironment()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }

    // demo with enableDemoMode=false does not enable demo mode
    setActiveTenantConfigForTesting(
      {
        ...baseCfg,
        environment: 'demo',
      },
      {
        environment: 'demo',
        featureFlags: { enableDemoMode: false },
      },
    );
    expect(isNonLiveDemoEnvironment()).toBe(false);
    expect(isDemoModeEnabled()).toBe(false);
    expect(isDataResetAllowedEnvironment()).toBe(false);

    // live never enables demo mode regardless of flag or NODE_ENV
    expect(
      isNonLiveDemoEnvironment({
        environment: 'live',
        featureFlags: { enableDemoMode: true },
      }),
    ).toBe(false);
    expect(
      isNonLiveDemoEnvironment({
        environment: 'live',
        featureFlags: { enableDemoMode: false },
      }),
    ).toBe(false);

    setActiveTenantConfigForTesting(
      {
        ...baseCfg,
        environment: 'live',
        featureFlags: {
          ...(baseCfg.featureFlags as Record<string, unknown>),
          enableDemoMode: false,
        },
      },
      {
        environment: 'live',
        featureFlags: { enableDemoMode: false },
      },
    );
    expect(isNonLiveDemoEnvironment()).toBe(false);
    expect(isDemoModeEnabled()).toBe(false);
    expect(isDataResetAllowedEnvironment()).toBe(false);

    // R333: NODE_ENV=production with PLATFORM_ENVIRONMENT=live returns false for isDemoModeEnabled()
    setActiveTenantConfigForTesting(null);
    vi.stubEnv('PLATFORM_ENVIRONMENT', 'live');
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(isNonLiveDemoEnvironment()).toBe(false);
      expect(isDemoModeEnabled()).toBe(false);
      expect(isDataResetAllowedEnvironment()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('2. createCleanDeploymentStore and clearAllDataToCleanDeployment produce a clean deployment with zero operational rows in PostgreSQL', async () => {
    const ctx = testDataResetContext();
    try {
      const cleanTemplate = createCleanDeploymentStore();
      expect(cleanTemplate.isCleanDeployment).toBe(true);
      expect(cleanTemplate.people).toHaveLength(0);
      expect(cleanTemplate.organisations).toHaveLength(0);
      expect(cleanTemplate.matters).toHaveLength(0);
      expect(cleanTemplate.enquiries).toHaveLength(0);
      expect(cleanTemplate.quotes).toHaveLength(0);
      expect(cleanTemplate.tasks).toHaveLength(0);
      expect(cleanTemplate.keyDates).toHaveLength(0);

      await clearAllDataToCleanDeployment('P-000001', ctx);
      const profile = await getCatalogueRepository().getFirmProfile(ctx);
      expect(profile?.isCleanDeployment).toBe(true);
      expect(await getPartyRepository().listAllPeople(ctx)).toHaveLength(0);
      expect(await getPartyRepository().listAllOrganisations(ctx)).toHaveLength(0);
      expect(await getMatterRepository().listAllMattersUnfiltered(ctx)).toHaveLength(0);
    } finally {
      await resetAllDemoData('P-000001', ctx);
    }
  });

  it('3. seed:demo refuses live and requires PLATFORM_TENANT_PACKAGE_DIR and PLATFORM_ENVIRONMENT', async () => {
    await expect(runSeedDemoTenant({
        args: [],
        env: { PLATFORM_TENANT_PACKAGE_DIR: '', PLATFORM_ENVIRONMENT: 'demo' },
      })).rejects.toThrow(/PLATFORM_TENANT_PACKAGE_DIR and PLATFORM_ENVIRONMENT are required/);

    await expect(runSeedDemoTenant({
        args: [],
        env: {
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'live',
        },
      })).rejects.toThrow(/Refusing to seed demo data in the live environment/);
  });

  it('4. seed:demo refuses a non-empty store without --force, succeeds with --force, and logs only counts, tenantId and environment', async () => {
    const demoCtx = makeDemoEnvTenantCtx();
    const logs: string[] = [];

    await clearMigratedPostgresModulesForTenant({ ctx: demoCtx });

    // First seed into an empty tenant database succeeds
    const firstResult = await runSeedDemoTenant({
      args: [],
      env: {
        ...process.env,
        PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
        PLATFORM_ENVIRONMENT: 'demo',
      },
      logger: (line) => logs.push(line),
    });

    expect(firstResult.event).toBe('seed.demo_tenant_completed');
    expect(firstResult.tenantId).toBe('not-a-law-firm');
    expect(firstResult.environment).toBe('demo');
    expect(firstResult.counts.people).toBeGreaterThan(0);
    expect(firstResult.counts.matters).toBeGreaterThan(0);
    expect(firstResult.counts.keyDates).toBe(5);

    // Output log contains no person or client names
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain('Rhian');
    expect(logs[0]).not.toContain('Dafydd');
    expect(logs[0]).not.toContain('Penarth');

    // Second seed without --force refuses to overwrite non-empty store
    await expect(runSeedDemoTenant({
        args: [],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        logger: () => {},
      })).rejects.toThrow(/Refusing to overwrite a non-empty store without --force/);

    // Second seed with --force succeeds
    const forcedResult = await runSeedDemoTenant({
      args: ['--force'],
      env: {
        ...process.env,
        PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
        PLATFORM_ENVIRONMENT: 'demo',
      },
      logger: () => {},
    });
    expect(forcedResult.event).toBe('seed.demo_tenant_completed');
  });

  it('5. seed:demo --entra-map sets entraObjectId on the mapped persons only', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-entra-map-'));
    const mapPath = path.join(tmpDir, 'entra-map.local.json');
    const demoCtx = makeDemoEnvTenantCtx();

    try {
      fs.writeFileSync(
        mapPath,
        JSON.stringify(
          {
            'P-000001': '11111111-2222-4333-8444-555555555501',
            'P-000004': '11111111-2222-4333-8444-555555555504',
          },
          null,
          2,
        ),
        'utf8',
      );

      const res = await runSeedDemoTenant({
        args: ['--force', '--entra-map', mapPath],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        logger: () => {},
      });

      expect(res.mappedEntraPersonas).toBe(2);

      const seededPeople = await getPartyRepository().listAllPeople(demoCtx);
      const p1 = seededPeople.find((p) => p.id === 'P-000001');
      const p4 = seededPeople.find((p) => p.id === 'P-000004');
      const p2 = seededPeople.find((p) => p.id === 'P-000002');
      const unmappedWithOid = seededPeople.filter(
        (p) =>
          p.id !== 'P-000001' &&
          p.id !== 'P-000004' &&
          p.entraObjectId !== undefined,
      );

      expect(p1?.entraObjectId).toBe('11111111-2222-4333-8444-555555555501');
      expect(p4?.entraObjectId).toBe('11111111-2222-4333-8444-555555555504');
      expect(p2?.entraObjectId).toBeUndefined();
      expect(unmappedWithOid).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6. buildCommittedSeedStoreSnapshot matches the committed data/seed-not-a-law-firm.json file', () => {
    const regenerated = buildCommittedSeedStoreSnapshot();
    const committed = loadCommittedSeedStore();

    expect(regenerated).toEqual(committed);
    expect(JSON.stringify(regenerated, null, 2)).toBe(
      loadCommittedSeedStoreRaw().replace(/\r\n/g, '\n').trim(),
    );
  });

  it('7. PostgreSQL catalogue import in training environment with enableDemoMode=true preserves a custom firm.name instead of overwriting with Not A Law Firm LLP (R313)', async () => {
    const baseCfg = getActiveTenantRawBaseConfig();
    const trainingTenantConfig = loadAndValidateTenantConfig(
      baseCfg,
      {
        environment: 'training',
        featureFlags: { enableDemoMode: true },
      },
      'training',
      'multi_tenant',
    );
    const trainingCtx = createVerifiedTenantContext(
      {
        sub: 'system:seed-training',
        tenantId: 'not-a-law-firm',
        name: 'System Seed Training',
        email: 'seed-training@notalawfirm.example',
        roles: ['admin'],
        mfaVerified: true,
        correlationId: 'corr-r313-training',
      },
      trainingTenantConfig,
    );

    const customStore = loadCommittedSeedStore();
    customStore.isCleanDeployment = false;
    customStore.firm = {
      name: 'Invented Other LLP',
      shortName: 'Invented Other',
      offices: ['Cardiff'],
    };
    await importFirmStoreModulesToPostgres({
      ctx: trainingCtx,
      store: customStore,
      modules: ['catalogues'],
      clearFirst: true,
      tenantConfig: trainingTenantConfig,
    });

    const loadedProfile = await getCatalogueRepository().getFirmProfile<{ name: string; shortName: string }>(trainingCtx);
    expect(loadedProfile?.firm.name).toBe('Invented Other LLP');
    expect(loadedProfile?.firm.shortName).toBe('Invented Other');
  });

  it('8. resetAllDemoData preserves mapped entraObjectId bindings from the pre-reset store (R326)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-r326-reset-'));
    const mapPath = path.join(tmpDir, 'entra-map.local.json');
    const demoCtx = makeDemoEnvTenantCtx();

    try {
      fs.writeFileSync(
        mapPath,
        JSON.stringify(
          {
            'P-000001': '22222222-3333-4444-8555-666666666601',
            'P-000004': '22222222-3333-4444-8555-666666666604',
          },
          null,
          2,
        ),
        'utf8',
      );

      await runSeedDemoTenant({
        args: ['--force', '--entra-map', mapPath],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        logger: () => {},
      });

      vi.stubEnv('PLATFORM_ENVIRONMENT', 'demo');
      setActiveTenantConfigForTesting(null);

      await resetAllDemoData('P-000004', demoCtx);

      const peopleAfterReset = await getPartyRepository().listAllPeople(demoCtx);
      const p1 = peopleAfterReset.find((p) => p.id === 'P-000001');
      const p4 = peopleAfterReset.find((p) => p.id === 'P-000004');
      const p2 = peopleAfterReset.find((p) => p.id === 'P-000002');
      expect(p1?.entraObjectId).toBe('22222222-3333-4444-8555-666666666601');
      expect(p4?.entraObjectId).toBe('22222222-3333-4444-8555-666666666604');
      expect(p2?.entraObjectId).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      setActiveTenantConfigForTesting(null);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('9. seed:demo with a faked clock produces key dates in the future and no synthetic entraObjectId values when --entra-map is omitted (R328)', async () => {
    const demoCtx = makeDemoEnvTenantCtx();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-06-15T10:00:00Z'));
    try {
      await runSeedDemoTenant({
        args: ['--force'],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        logger: () => {},
      });

      const seededKeyDates = await getKeyDateRepository().listAllVisibleKeyDates(demoCtx);
      expect(seededKeyDates.length).toBeGreaterThan(0);
      for (const kd of seededKeyDates) {
        expect(kd.dueDate > '2027-06-15').toBe(true);
      }
      const seededPeople = await getPartyRepository().listAllPeople(demoCtx);
      const peopleWithOids = seededPeople.filter(
        (p) => p.entraObjectId !== undefined,
      );
      expect(peopleWithOids).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('10. every seeded key date satisfies four-eyes verification (verifiedById !== proposedById) and counters.KD equals keyDates.length (R329)', () => {
    const committed = loadCommittedSeedStore();
    expect(committed.keyDates).toBeDefined();
    expect(committed.keyDates!.length).toBe(5);
    expect(committed.counters.KD).toBe(committed.keyDates!.length);
    for (const kd of committed.keyDates!) {
      expect(kd.verification?.proposedById).toBeDefined();
      expect(kd.verification?.verifiedById).not.toBe(kd.verification?.proposedById);
    }
  });

  it('11. clearAllDataToCleanDeployment followed by provisioning a user as P-000004 and resetAllDemoData does not bind that user to the seeded admin persona or leave 00000000- object IDs (R336)', async () => {
    const demoCtx = makeDemoEnvTenantCtx();

    vi.stubEnv('PLATFORM_ENVIRONMENT', 'demo');
    setActiveTenantConfigForTesting(null);
    try {
      // Step 1: Clear all data to a clean deployment
      await clearAllDataToCleanDeployment('P-000004', demoCtx);
      const clearedProfile = await getCatalogueRepository().getFirmProfile(demoCtx);
      expect(clearedProfile?.isCleanDeployment).toBe(true);
      expect(await getPartyRepository().listAllPeople(demoCtx)).toHaveLength(0);

      // Step 2: Provision a real Entra user who happens to receive ID P-000004 in the clean deployment
      await getPartyRepository().putPeople(demoCtx, [
        {
          id: 'P-000004',
          recordType: 'person',
          createdAt: '2026-10-16T09:00:00Z',
          createdById: 'P-000004',
          updatedAt: '2026-10-16T09:00:00Z',
          updatedById: 'P-000004',
          tags: [],
          firstName: 'Provisioned',
          surname: 'Visitor',
          emails: [
            {
              id: 'EM-PROV-1',
              address: 'provisioned.visitor@notalawfirm.co.uk',
              typeId: null,
              isPrimary: true,
            },
          ],
          phones: [],
          addresses: [],
          personTypeIds: [],
          isStaff: true,
          entraObjectId: '99999999-8888-4777-8666-555555555504',
          entraUpn: 'provisioned.visitor@notalawfirm.co.uk',
        } as unknown as ReturnType<typeof loadCommittedSeedStore>['people'][number],
      ]);

      // Step 3: Reset demo data and verify P-000004 did not keep the visitor's OID
      await resetAllDemoData('P-000004', demoCtx);

      const afterReset = await getPartyRepository().listAllPeople(demoCtx);
      const p4 = afterReset.find((p) => p.id === 'P-000004');
      expect(p4).toBeDefined();
      expect(p4?.firstName).toBe('Huw');
      expect(p4?.surname).toBe('Pritchard');
      expect(p4?.entraObjectId).toBeUndefined();

      const withProvisionedOid = afterReset.filter(
        (p) => p.entraObjectId === '99999999-8888-4777-8666-555555555504',
      );
      expect(withProvisionedOid).toHaveLength(0);

      const withSyntheticOid = afterReset.filter((p) =>
        p.entraObjectId?.startsWith('00000000-'),
      );
      expect(withSyntheticOid).toHaveLength(0);

      // Step 4: Even in a non-clean store (!isCleanDeployment), an OID on P-000004 with a non-matching email is never copied onto Huw Pritchard
      const targetP4 = structuredClone(p4!);
      targetP4.emails = [
        {
          id: 'EM-PROV-2',
          address: 'someone.else@notalawfirm.co.uk',
          typeId: null,
          isPrimary: true,
        },
      ];
      targetP4.entraObjectId = '88888888-7777-4666-8555-444444444404';
      await getPartyRepository().putPerson(demoCtx, targetP4);

      await resetAllDemoData('P-000004', demoCtx);
      const afterSecondReset = await getPartyRepository().listAllPeople(demoCtx);
      expect(afterSecondReset.find((p) => p.id === 'P-000004')?.entraObjectId).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      setActiveTenantConfigForTesting(null);
    }
  });

  it('12. isMatterConflictCheckAwaitingDecision counts matters with conflictCheckRecord.status === Referred or legacy escalated status without a decision, and ignores cleared or already-decided matters (R351, R367)', () => {
    const committed = loadCommittedSeedStore();
    const m6 = committed.matters.find((m) => m.id === 'M-000006');
    expect(m6).toBeDefined();
    expect(m6?.conflictCheckRecord?.status).toBe('Referred');
    expect(isMatterConflictCheckAwaitingDecision(m6!)).toBe(true);

    // A matter converted with conflictDecision.outcome === 'Potential conflict' and later cleared in conflictCheckRecord is NOT awaiting decision
    const clearedAfterConversion = {
      conflictDecision: {
        outcome: 'Potential conflict' as const,
        summary: 'Initial conversion warning',
        decidedById: 'P-000002',
        decidedByName: 'Dafydd Evans',
        decidedAt: '2026-10-10',
        sourceRecordId: 'ENQ-000001',
        matchesCount: 1,
      },
      conflictCheckRecord: {
        status: 'Cleared' as const,
        outcomeLabel: 'Cleared by fee earner' as const,
        declarationConfirmed: true,
        reviewerMessage: '',
        lastRunAtDisplay: '2026-10-12',
        lastRunById: 'P-000003',
        lastRunByName: 'Bethan Rees',
        parties: [],
        matches: [],
        runs: [],
        comments: [],
      },
    };
    expect(isMatterConflictCheckAwaitingDecision(clearedAfterConversion)).toBe(false);

    // A matter with conflictDecision.outcome === 'Potential conflict' and no conflictCheckRecord is NOT counted
    expect(
      isMatterConflictCheckAwaitingDecision({
        conflictDecision: clearedAfterConversion.conflictDecision,
        conflictCheckRecord: null,
      }),
    ).toBe(false);

    // A matter with conflictCheckRecord.status === 'Referred' IS counted
    expect(
      isMatterConflictCheckAwaitingDecision({
        conflictDecision: undefined,
        conflictCheckRecord: {
          ...clearedAfterConversion.conflictCheckRecord,
          status: 'Referred',
          outcomeLabel: 'Referred to risk for review',
        },
      }),
    ).toBe(true);

    // A legacy matter with conflictCheckStatus === 'Potential conflict — escalated' and no conflictCheckRecord or conflictDecision IS counted (R367)
    expect(
      isMatterConflictCheckAwaitingDecision({
        conflictCheckStatus: 'Potential conflict — escalated',
        conflictCheckRecord: null,
        conflictDecision: null,
      }),
    ).toBe(true);

    // A legacy matter with conflictCheckStatus === 'Potential conflict — escalated' that already has a conflictDecision is NOT counted
    expect(
      isMatterConflictCheckAwaitingDecision({
        conflictCheckStatus: 'Potential conflict — escalated',
        conflictCheckRecord: null,
        conflictDecision: clearedAfterConversion.conflictDecision,
      }),
    ).toBe(false);

    // A legacy 'Clear' matter without a conflictCheckRecord is NOT counted (R367)
    expect(
      isMatterConflictCheckAwaitingDecision({
        conflictCheckStatus: 'Clear',
        conflictCheckRecord: null,
        conflictDecision: null,
      }),
    ).toBe(false);
  });

  it('13. isMatterOpeningInProgress, computeMatterOpeningChecklistProgress, and isComplianceOrOnboardingTask resolve statuses and task types strictly by systemKey via valueBySystemKey (R352, R372)', () => {
    const committed = loadCommittedSeedStore();
    const values = committed.values;

    // Seeded M-000006 and M-000008 (Prospective / Enquiry) are in-progress openings
    const m6 = committed.matters.find((m) => m.id === 'M-000006')!;
    const m8 = committed.matters.find((m) => m.id === 'M-000008')!;
    const m1 = committed.matters.find((m) => m.id === 'M-000001')!;
    expect(isMatterOpeningInProgress(m6, values)).toBe(true);
    expect(isMatterOpeningInProgress(m8, values)).toBe(true);
    expect(isMatterOpeningInProgress(m1, values)).toBe(false);

    // Custom ChoiceValue IDs with systemKey 'prospective' and 'cmi_incomplete' resolve via valueBySystemKey
    const customValues = [
      {
        id: 'matter_status.custom_intake_stage',
        listKey: 'matter_status' as const,
        label: 'Initial Intake',
        systemKey: 'prospective',
        sortOrder: 1,
        active: true,
      },
      {
        id: 'matter_status.custom_onboarding_hold',
        listKey: 'matter_status' as const,
        label: 'Onboarding Pending',
        systemKey: 'cmi_incomplete',
        sortOrder: 2,
        active: true,
      },
      {
        id: 'task_type.custom_conflict_verification',
        listKey: 'task_type' as const,
        label: 'Verify Conflicts',
        systemKey: 'conflict_check',
        sortOrder: 1,
        active: true,
      },
      {
        id: 'task_type.custom_onboarding_pack',
        listKey: 'task_type' as const,
        label: 'Complete Onboarding Pack',
        systemKey: 'complete_matter_opening',
        sortOrder: 2,
        active: true,
      },
    ];

    expect(
      isMatterOpeningInProgress({ matterStatusId: 'matter_status.custom_intake_stage' }, customValues),
    ).toBe(true);
    expect(
      isMatterOpeningInProgress(
        { matterStatusId: 'matter_status.custom_onboarding_hold' },
        customValues,
      ),
    ).toBe(true);
    expect(
      isMatterOpeningInProgress({ matterStatusId: 'matter_status.active_work' }, customValues),
    ).toBe(false);
    // When systemKey is missing from values, does not fall back to slug IDs (R372)
    expect(
      isMatterOpeningInProgress({ matterStatusId: 'matter_status.prospective_enquiry' }, []),
    ).toBe(false);

    const progress = computeMatterOpeningChecklistProgress(m8);
    expect(progress.conflictDone).toBe(true);
    expect(progress.amlDone).toBe(false);
    expect(progress.engDone).toBe(false);
    expect(progress.retainerDone).toBe(false);
    expect(progress.completedSteps).toBe(1);

    expect(
      isComplianceOrOnboardingTask(
        { taskTypeId: 'task_type.custom_conflict_verification' },
        customValues,
      ),
    ).toBe(true);
    expect(
      isComplianceOrOnboardingTask(
        { taskTypeId: 'task_type.custom_onboarding_pack' },
        customValues,
      ),
    ).toBe(true);
    expect(
      isComplianceOrOnboardingTask(
        { taskTypeId: 'task_type.general' },
        customValues,
      ),
    ).toBe(false);
    // When systemKey is missing from values, does not fall back to slug IDs (R372)
    expect(
      isComplianceOrOnboardingTask({ taskTypeId: 'task_type.conflict_check' }, []),
    ).toBe(false);
  });

  it('14. buildCommittedSeedStoreSnapshot under TZ=America/New_York matches data/seed-not-a-law-firm.json without global vitest TZ forcing and restores original timezone (R356, R370)', () => {
    const originalTz =
      process.env.TZ ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    process.env.TZ = 'America/New_York';
    try {
      expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(300);
      const rebuiltUnderNewYork = buildCommittedSeedStoreSnapshot();
      const committed = loadCommittedSeedStore();
      expect(rebuiltUnderNewYork).toEqual(committed);
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('15. runSeedDemoTenant refuses corrupted JSON files without echoing file content in the error message (R357, R368, R379, R380)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-r357-corrupt-'));
    const entraMapPath = path.join(tmpDir, 'entra-map.local.json');
    const corruptedEntraMapPayload = 'rhian.morgan';

    try {
      // Confirm V8's native JSON.parse error message does contain the token so this test would fail on unredacted error.message
      let rawParseMessage = '';
      try {
        JSON.parse(corruptedEntraMapPayload);
      } catch (parseErr) {
        rawParseMessage = parseErr instanceof Error ? parseErr.message : String(parseErr);
      }
      expect(rawParseMessage).toContain('rhian.morgan');

      // Verify runSeedDemoTenant with a malformed --entra-map file reports a fixed message without echoing file content (R379)
      fs.writeFileSync(entraMapPath, corruptedEntraMapPayload, 'utf8');
      let thrownEntraMapMessage = '';
      try {
        await runSeedDemoTenant({
          args: ['--force', '--entra-map', entraMapPath],
          env: {
            ...process.env,
            PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
            PLATFORM_ENVIRONMENT: 'demo',
          },
          logger: () => {},
        });
      } catch (err) {
        thrownEntraMapMessage = err instanceof Error ? err.message : String(err);
      }
      expect(thrownEntraMapMessage).toBe('Entra map file is not valid JSON.');
      expect(thrownEntraMapMessage).not.toContain('rhian.morgan');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('16. seed:demo without --entra-map prints a warning stating how many privileged personas remain unbound, with no email address in the output (S0-30, R381, R392)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-s030-seed-warn-'));
    const fullMapPath = path.join(tmpDir, 'entra-map.local.json');
    const stdoutLogs: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const unmappedRes = await runSeedDemoTenant({
        args: ['--force'],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        logger: (line) => stdoutLogs.push(line),
      });

      const activeTenantCfg = getActiveTenantConfiguration();
      const writtenStore = loadCommittedSeedStore();
      const privilegedSeededPeople = writtenStore.people.filter(
        (person: (typeof writtenStore.people)[number]) =>
          person.isEmployee &&
          !person.mergedIntoId &&
          isPrivilegedPersonForEmailLinking(person, {
            allPeople: writtenStore.people,
            teams: writtenStore.teams ?? [],
            tenantId: activeTenantCfg.tenantId,
            rbacConfig: activeTenantCfg.rbac,
          }),
      );
      expect(privilegedSeededPeople.length).toBeGreaterThan(0);
      expect(unmappedRes.unboundPrivilegedPersonas).toBe(privilegedSeededPeople.length);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const rawWarnLine = String(warnSpy.mock.calls[0]?.[0] ?? '');
      const parsedWarn = JSON.parse(rawWarnLine) as {
        event: string;
        tenantId: string;
        environment: string;
        unboundPrivilegedPersonas: number;
        warning: string;
      };
      expect(parsedWarn.event).toBe('seed.demo_tenant_unbound_privileged_warning');
      expect(parsedWarn.tenantId).toBe('not-a-law-firm');
      expect(parsedWarn.environment).toBe('demo');
      expect(parsedWarn.unboundPrivilegedPersonas).toBe(privilegedSeededPeople.length);
      expect(parsedWarn.warning).toContain('without --entra-map');
      expect(parsedWarn.warning).toContain(
        `${privilegedSeededPeople.length} privileged`,
      );
      expect(parsedWarn.warning).toContain('unbound');

      // Neither stdout nor stderr warning output may contain any email address, domain, or person name
      const combinedOutput = [...stdoutLogs, rawWarnLine].join('\n');
      expect(combinedOutput).not.toContain('@');
      expect(combinedOutput.toLowerCase()).not.toContain('notalawfirm.example');
      expect(combinedOutput.toLowerCase()).not.toContain('notalawfirm.co.uk');
      for (const person of writtenStore.people as Array<{
        firstName?: string;
        surname?: string;
        emails?: Array<{ address?: string }>;
      }>) {
        for (const em of person.emails ?? []) {
          if (em.address) {
            expect(combinedOutput.toLowerCase()).not.toContain(
              em.address.toLowerCase(),
            );
          }
        }
      }
      expect(combinedOutput).not.toContain('Rhian');
      expect(combinedOutput).not.toContain('Huw');
      expect(combinedOutput).not.toContain('Gethin');
      expect(combinedOutput).not.toContain('Bethan');

      // Positive control: supplying --entra-map covering all privileged personas emits no warning
      const allPrivilegedMap: Record<string, string> = {};
      privilegedSeededPeople.forEach((p: { id: string }, index: number) => {
        const suffix = String(index + 1).padStart(4, '0');
        allPrivilegedMap[p.id] = `33333333-4444-4555-8666-77777777${suffix}`;
      });
      fs.writeFileSync(fullMapPath, JSON.stringify(allPrivilegedMap, null, 2), 'utf8');
      warnSpy.mockClear();

      const mappedRes = await runSeedDemoTenant({
        args: ['--force', '--entra-map', fullMapPath],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        logger: () => {},
      });
      expect(mappedRes.unboundPrivilegedPersonas).toBe(0);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('17. runSeedDemoTenant supports DEMO_ENTRA_MAP_JSON and SEED_DEMO_FORCE=true, and runSeedDemoJobSweep refuses live while succeeding in demo', async () => {
    const demoCtx = makeDemoEnvTenantCtx();
    const res = await runSeedDemoTenant({
      args: [],
      env: {
        ...process.env,
        PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
        PLATFORM_ENVIRONMENT: 'demo',
        SEED_DEMO_FORCE: 'true',
        DEMO_ENTRA_MAP_JSON: JSON.stringify({
          'P-000001': '44444444-5555-4666-8777-888888880001',
        }),
      },
      logger: () => {},
      warnLogger: () => {},
    });
    expect(res.mappedEntraPersonas).toBe(1);
    const people = await getPartyRepository().listAllPeople(demoCtx);
    expect(people.find((p) => p.id === 'P-000001')?.entraObjectId).toBe(
      '44444444-5555-4666-8777-888888880001',
    );

    // Invalid DEMO_ENTRA_MAP_JSON reports fixed message without echoing secret content
    await expect(
      runSeedDemoTenant({
        args: ['--force'],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
          DEMO_ENTRA_MAP_JSON: 'secret-token-should-not-leak',
        },
        logger: () => {},
      }),
    ).rejects.toThrow('DEMO_ENTRA_MAP_JSON is not valid JSON.');

    // runSeedDemoJobSweep refuses live tenants
    const liveSummary = await runSeedDemoJobSweep({
      registry: {
        schemaVersion: '1.0',
        environment: 'live',
        hostingMode: 'multi_tenant',
        tenants: [
          {
            tenantId: 'not-a-law-firm',
            slug: 'not_a_law_firm',
            environment: 'live',
            enabled: true,
            postgresHost: '127.0.0.1',
            postgresDatabaseName: 'pg_tenant_not_a_law_firm_live',
            postgresRoleName: 'role_tenant_not_a_law_firm_live',
            keyVaultUri: 'https://kv-notalawfirm-live.vault.azure.net/',
            packageDir: 'client-not-a-law-firm',
            timeZone: 'Europe/London',
          },
        ],
      },
      force: true,
    });
    expect(liveSummary.exitCode).toBe(1);
    expect(liveSummary.failedTenants).toEqual([
      { tenantId: 'not-a-law-firm', errorCode: 'SEED_DEMO_LIVE_FORBIDDEN' },
    ]);

    // runProvisionJobSweep invokes the provisioner under guardedJob('provision', ...)
    const provisionSummary = await runProvisionJobSweep({
      registry: {
        schemaVersion: '1.0',
        environment: 'demo',
        hostingMode: 'multi_tenant',
        tenants: [
          {
            tenantId: 'not-a-law-firm',
            slug: 'not_a_law_firm',
            environment: 'demo',
            enabled: true,
            postgresHost: '127.0.0.1',
            postgresDatabaseName: 'pg_tenant_not_a_law_firm_demo',
            postgresRoleName: 'role_tenant_not_a_law_firm_demo',
            keyVaultUri: 'https://kvnotalawfi2cdo3cw7vuafm.vault.azure.net/',
            packageDir: 'client-not-a-law-firm',
            timeZone: 'Europe/London',
          },
        ],
      },
      provisioner: async (opts) => ({
        databasesProvisioned: opts.tenants.map(
          (t) => `pg_tenant_${t.tenantId.replace(/-/g, '_')}_${t.environment}`,
        ),
      }),
    });
    expect(provisionSummary.exitCode).toBe(0);
    expect(provisionSummary.succeededTenants).toEqual(['not-a-law-firm']);
    expect(provisionSummary.databasesProvisioned).toEqual([
      'pg_tenant_not_a_law_firm_demo',
    ]);
  });

  it('18. resolvePublicAppOrigin, resolvePostgresRuntimeUser, resolvePostgresMigrateUser, and provisionEntraPostgresClusterRolesAndDatabases enforce Container Apps & Entra PostgreSQL contracts', async () => {
    vi.stubEnv(
      'ENTRA_REDIRECT_URI',
      'https://ca-web-platform-demo.uksouth.azurecontainerapps.io/api/auth/callback/microsoft-entra-id',
    );
    try {
      expect(resolvePublicAppOrigin('http://0.0.0.0:3000/api/auth/login')).toBe(
        'https://ca-web-platform-demo.uksouth.azurecontainerapps.io',
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(resolvePublicAppOrigin('http://localhost:3000/api/auth/login')).toBe(
      'http://localhost:3000',
    );

    vi.stubEnv('PLATFORM_POSTGRES_USER', 'id-runtime-platform-demo');
    try {
      expect(resolvePostgresRuntimeUser()).toBe('id-runtime-platform-demo');
      expect(resolvePostgresMigrateUser()).toBe('id-runtime-platform-demo');
      expect(quotePgIdentifier('id-runtime-platform-demo')).toBe(
        '"id-runtime-platform-demo"',
      );
      expect(quotePgIdentifier('id-migrate-platform-demo')).toBe(
        '"id-migrate-platform-demo"',
      );
      expect(() => quotePgIdentifier('id-runtime"; DROP ROLE--')).toThrow(
        /TENANCY_SQL_IDENTIFIER_REJECTED/,
      );
      await expect(
        provisionEntraPostgresClusterRolesAndDatabases({
          tenants: [{ tenantId: 'not-a-law-firm', environment: 'demo' }],
        }),
      ).rejects.toThrow(
        /PLATFORM_POSTGRES_RUNTIME_USER and PLATFORM_POSTGRES_MIGRATE_USER must be distinct principals/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('R521: ignores user.showsWorkOfId and skips ensureSeedDocumentTemplates when not in a non-live demo environment', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const people = await getPartyRepository().listAllPeople(makeDemoEnvTenantCtx());
    const targetPerson = people.find((p) => p.id === 'P-000002')!;
    const actingAdmin = people.find((p) => p.id === 'P-000004')!;

    // Set demo + showsWorkOfId on P-000004 (who has no own PMS link) pointing to P-000002 (FE002), then run in live
    const updatedAdmin = {
      ...actingAdmin,
      demo: true,
      showsWorkOfId: targetPerson.id,
    };
    const baseCfg = getActiveTenantRawBaseConfig();
    const activeCfg = getActiveTenantConfiguration();
    const ctx = createVerifiedTenantContext(
      {
        sub: actingAdmin.id,
        tenantId: 'not-a-law-firm',
        name: 'Catrin Williams',
        email: 'catrin@notalawfirm.example',
        roles: ['admin', 'partner', 'fee_earner'],
        mfaVerified: true,
        correlationId: 'corr-r521-test',
      },
      { ...activeCfg, tenantId: 'not-a-law-firm', environment: 'test' },
    );
    await getPartyRepository().putPerson(ctx, updatedAdmin);

    // Give P-000002 (targetPerson) a distinct overdue task so effectiveWorkPerson divergence is observable in attention & candidate tasks
    await getTaskWorkflowRepository().putTask(ctx, {
      id: 'TSK-R544-OVERDUE',
      reference: 'TSK-R544-OVERDUE',
      title: 'R544 Target Person Overdue Task',
      description: 'Assigned only to targetPerson',
      taskTypeId: 'task_type.general',
      priorityId: 'task_priority.urgent',
      dueAt: '2020-01-01',
      assignedTeamId: null,
      assignedPersonId: targetPerson.id,
      assignedPersonIds: [targetPerson.id],
      status: 'To do',
      linkedRecords: [],
      createdById: actingAdmin.id,
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedById: actingAdmin.id,
      updatedAt: '2026-01-01T10:00:00.000Z',
      completedById: null,
      completedAt: null,
      comments: [],
    });

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const signedCookie = createSignedEntraSessionCookie({
      personId: actingAdmin.id,
      tenantId: 'not-a-law-firm',
      oid: actingAdmin.entraObjectId ?? '00000000-0000-4000-8000-000000000004',
      tid: '11111111-2222-3333-4444-000000000000',
      sub: actingAdmin.id,
      email: 'catrin@notalawfirm.example',
      displayName: 'Catrin Williams',
      entraRoles: ['admin', 'partner', 'fee_earner'],
      mappedRoles: ['admin', 'partner', 'fee_earner'],
      entraGroups: [],
      mfaVerified: true,
      amr: ['pwd', 'mfa'],
      authenticatedAt: nowIso,
      expiresAt,
    });
    const verifiedSession = verifySignedEntraSessionCookie(signedCookie)!;

    // Delete any existing docgen templates so ensureSeedDocumentTemplates would seed if unguarded
    await clearMigratedPostgresModulesForTenant({
      ctx,
      modules: ['documents'],
    }).catch(() => undefined);

    setActiveTenantConfigForTesting(
      {
        ...baseCfg,
        environment: 'live',
        featureFlags: { ...(baseCfg.featureFlags ?? {}), enableDemoMode: false },
      },
      { tenantId: 'not-a-law-firm', environment: 'live' },
    );
    try {
      await runWithActiveActorSession(
        {
          personId: actingAdmin.id,
          tenantId: 'not-a-law-firm',
          tokenRoles: ['admin', 'partner', 'fee_earner'],
          mfaVerified: true,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession,
        },
        async () => {
          const snap = await getAppSnapshot(actingAdmin.id);
          expect(snap.currentUser.id).toBe(actingAdmin.id);
          expect(snap.effectiveWorkPerson.id).toBe(actingAdmin.id);
          expect(snap.attention).not.toBeNull();
          expect(
            snap.attention.some(
              (item) => item.kind === 'overdue_task' && item.recordId === 'TSK-R544-OVERDUE',
            ),
          ).toBe(false);
          const candidateTasksLive = selectHomeCandidateTasks({
            tasks: snap.tasks,
            currentUserId: snap.currentUser.id,
            effectiveWorkPersonId: snap.effectiveWorkPerson.id,
            myTeamIds: new Set(
              snap.teams
                .filter(
                  (t) =>
                    t.memberIds.includes(snap.effectiveWorkPerson.id) ||
                    t.leadIds.includes(snap.effectiveWorkPerson.id),
                )
                .map((t) => t.id),
            ),
          });
          expect(candidateTasksLive.some((t) => t.id === 'TSK-R544-OVERDUE')).toBe(false);

          // In live, showsWorkOfId must be ignored so P-000004 (no FE PMS link) gets null instead of P-000002's FE002
          const myFigs = await getMyFinanceFigures(actingAdmin.id);
          expect((myFigs as { denied?: boolean }).denied).not.toBe(true);
          expect((myFigs as { myFeeEarnerFigures: unknown }).myFeeEarnerFigures).toBeNull();

          const docSnap = await getDocumentGenerationSnapshotForUser(actingAdmin.id);
          expect(isActionDenied(docSnap)).toBe(false);
          if (isActionDenied(docSnap)) throw new Error(docSnap.message);
          expect(docSnap.templates.filter((t) => t.id.startsWith('TPL-SEED-'))).toEqual([]);
        },
      );

      // Positive control: in non-live demo mode, showsWorkOfId IS honoured
      setActiveTenantConfigForTesting(
        {
          ...baseCfg,
          environment: 'demo',
          featureFlags: { ...(baseCfg.featureFlags ?? {}), enableDemoMode: true },
        },
        { tenantId: 'not-a-law-firm', environment: 'demo' },
      );
      await runWithActiveActorSession(
        {
          personId: actingAdmin.id,
          tenantId: 'not-a-law-firm',
          tokenRoles: ['admin', 'partner', 'fee_earner'],
          mfaVerified: true,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession,
        },
        async () => {
          const demoSnap = await getAppSnapshot(actingAdmin.id);
          expect(demoSnap.currentUser.id).toBe(actingAdmin.id);
          expect(demoSnap.effectiveWorkPerson.id).toBe(targetPerson.id);
          expect(
            demoSnap.attention.some(
              (item) => item.kind === 'overdue_task' && item.recordId === 'TSK-R544-OVERDUE',
            ),
          ).toBe(true);
          const candidateTasksDemo = selectHomeCandidateTasks({
            tasks: demoSnap.tasks,
            currentUserId: demoSnap.currentUser.id,
            effectiveWorkPersonId: demoSnap.effectiveWorkPerson.id,
            myTeamIds: new Set(
              demoSnap.teams
                .filter(
                  (t) =>
                    t.memberIds.includes(demoSnap.effectiveWorkPerson.id) ||
                    t.leadIds.includes(demoSnap.effectiveWorkPerson.id),
                )
                .map((t) => t.id),
            ),
          });
          expect(candidateTasksDemo.some((t) => t.id === 'TSK-R544-OVERDUE')).toBe(true);
        },
      );
    } finally {
      setActiveTenantConfigForTesting(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });
});
