import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeMatterOpeningChecklistProgress,
  isMatterConflictCheckAwaitingDecision,
  isMatterOpeningInProgress,
} from '@/domain/matterOpeningRecord';
import { isPrivilegedPersonForEmailLinking } from '@/domain/rbac';
import { isComplianceOrOnboardingTask } from '@/domain/tasks';
import {
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
import {
  clearAllDataToCleanDeployment,
  isDataResetAllowedEnvironment,
  isDemoModeEnabled,
  resetAllDemoData,
} from '@/server/services';
import {
  clearStoreMemoryCache,
  getStore,
  saveStore,
} from '@/server/store';
import { runSeedDemoTenant } from '../../../scripts/seed-demo-tenant';

describe('S0-11b: Demo tenant configuration, clean store fallback, and seed:demo command', () => {
  afterEach(() => {
    setActiveTenantConfigForTesting(null);
    delete process.env.ONESQUARED_RUNTIME_STORE_PATH;
    saveStore(loadCommittedSeedStore());
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

  it('2. getStore() with no runtime file returns a clean deployment store and never back-fills demo data into an existing store', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-clean-store-'));
    const missingStorePath = path.join(tmpDir, 'non-existent-store.json');
    try {
      process.env.ONESQUARED_RUNTIME_STORE_PATH = missingStorePath;
      clearStoreMemoryCache();

      const store = getStore();
      expect(store.isCleanDeployment).toBe(true);
      expect(store.people).toHaveLength(0);
      expect(store.organisations).toHaveLength(0);
      expect(store.matters).toHaveLength(0);
      expect(store.enquiries).toHaveLength(0);
      expect(store.quotes).toHaveLength(0);
      expect(store.tasks).toHaveLength(0);
      expect(store.keyDates).toHaveLength(0);
      expect(fs.existsSync(missingStorePath)).toBe(true);

      // Even if isCleanDeployment is false on disk with empty arrays, getStore() does not back-fill from buildDemoData
      const rawDisk = JSON.parse(fs.readFileSync(missingStorePath, 'utf8'));
      rawDisk.isCleanDeployment = false;
      rawDisk.matters = [];
      rawDisk.people = [];
      rawDisk.organisations = [];
      delete rawDisk.keyDates;
      fs.writeFileSync(missingStorePath, JSON.stringify(rawDisk, null, 2), 'utf8');

      clearStoreMemoryCache();
      const reloaded = getStore();
      expect(reloaded.matters).toHaveLength(0);
      expect(reloaded.people).toHaveLength(0);
      expect(reloaded.organisations).toHaveLength(0);
      expect(reloaded.keyDates).toEqual([]);
    } finally {
      delete process.env.ONESQUARED_RUNTIME_STORE_PATH;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. seed:demo refuses live and requires PLATFORM_TENANT_PACKAGE_DIR and PLATFORM_ENVIRONMENT', () => {
    expect(() =>
      runSeedDemoTenant({
        args: [],
        env: { PLATFORM_TENANT_PACKAGE_DIR: '', PLATFORM_ENVIRONMENT: 'demo' },
      }),
    ).toThrow(/PLATFORM_TENANT_PACKAGE_DIR and PLATFORM_ENVIRONMENT are required/);

    expect(() =>
      runSeedDemoTenant({
        args: [],
        env: {
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'live',
        },
      }),
    ).toThrow(/Refusing to seed demo data in the live environment/);
  });

  it('4. seed:demo refuses a non-empty store without --force, succeeds with --force, and logs only counts, tenantId and environment', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-seed-cmd-'));
    const storePath = path.join(tmpDir, 'runtime-store.json');
    const logs: string[] = [];

    try {
      // First seed into an empty/non-existent path succeeds
      const firstResult = runSeedDemoTenant({
        args: [],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        runtimeStorePath: storePath,
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
      expect(() =>
        runSeedDemoTenant({
          args: [],
          env: {
            ...process.env,
            PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
            PLATFORM_ENVIRONMENT: 'demo',
          },
          runtimeStorePath: storePath,
          logger: () => {},
        }),
      ).toThrow(/Refusing to overwrite a non-empty store without --force/);

      // Second seed with --force succeeds
      const forcedResult = runSeedDemoTenant({
        args: ['--force'],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        runtimeStorePath: storePath,
        logger: () => {},
      });
      expect(forcedResult.event).toBe('seed.demo_tenant_completed');

      // R335: Unparseable store file is refused without --force
      fs.writeFileSync(storePath, '{ not valid json', 'utf8');
      expect(() =>
        runSeedDemoTenant({
          args: [],
          env: {
            ...process.env,
            PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
            PLATFORM_ENVIRONMENT: 'demo',
          },
          runtimeStorePath: storePath,
          logger: () => {},
        }),
      ).toThrow(/Refusing to overwrite an unparseable store file without --force/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('5. seed:demo --entra-map sets entraObjectId on the mapped persons only', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-entra-map-'));
    const storePath = path.join(tmpDir, 'runtime-store.json');
    const mapPath = path.join(tmpDir, 'entra-map.local.json');

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

      const res = runSeedDemoTenant({
        args: ['--entra-map', mapPath],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        runtimeStorePath: storePath,
        logger: () => {},
      });

      expect(res.mappedEntraPersonas).toBe(2);

      const writtenStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const p1 = writtenStore.people.find((p: { id: string }) => p.id === 'P-000001');
      const p4 = writtenStore.people.find((p: { id: string }) => p.id === 'P-000004');
      const p2 = writtenStore.people.find((p: { id: string }) => p.id === 'P-000002');
      const unmappedWithOid = writtenStore.people.filter(
        (p: { id: string; entraObjectId?: string }) =>
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

  it('7. getStore() in training environment with enableDemoMode=true preserves a custom firm.name instead of overwriting with Not A Law Firm LLP (R313)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-r313-branding-'));
    const storePath = path.join(tmpDir, 'runtime-store.json');
    const baseCfg = getActiveTenantRawBaseConfig();

    try {
      setActiveTenantConfigForTesting(
        {
          ...baseCfg,
          environment: 'training',
        },
        {
          environment: 'training',
          featureFlags: { enableDemoMode: true },
        },
      );
      process.env.ONESQUARED_RUNTIME_STORE_PATH = storePath;

      const customStore = loadCommittedSeedStore();
      customStore.isCleanDeployment = false;
      customStore.firm = {
        name: 'Invented Other LLP',
        shortName: 'Invented Other',
        offices: ['Cardiff'],
      };
      fs.writeFileSync(storePath, JSON.stringify(customStore, null, 2), 'utf8');

      clearStoreMemoryCache();
      const loaded = getStore();
      expect(loaded.firm.name).toBe('Invented Other LLP');
      expect(loaded.firm.shortName).toBe('Invented Other');
    } finally {
      delete process.env.ONESQUARED_RUNTIME_STORE_PATH;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('8. resetAllDemoData preserves mapped entraObjectId bindings from the pre-reset store (R326)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-r326-reset-'));
    const storePath = path.join(tmpDir, 'runtime-store.json');
    const mapPath = path.join(tmpDir, 'entra-map.local.json');

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

      runSeedDemoTenant({
        args: ['--entra-map', mapPath],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        runtimeStorePath: storePath,
        logger: () => {},
      });

      process.env.ONESQUARED_RUNTIME_STORE_PATH = storePath;
      clearStoreMemoryCache();

      resetAllDemoData('P-000004');

      const afterReset = getStore();
      const p1 = afterReset.people.find((p) => p.id === 'P-000001');
      const p4 = afterReset.people.find((p) => p.id === 'P-000004');
      const p2 = afterReset.people.find((p) => p.id === 'P-000002');
      expect(p1?.entraObjectId).toBe('22222222-3333-4444-8555-666666666601');
      expect(p4?.entraObjectId).toBe('22222222-3333-4444-8555-666666666604');
      expect(p2?.entraObjectId).toBeUndefined();
    } finally {
      delete process.env.ONESQUARED_RUNTIME_STORE_PATH;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('9. seed:demo with a faked clock produces key dates in the future and no synthetic entraObjectId values when --entra-map is omitted (R328)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-r328-clock-'));
    const storePath = path.join(tmpDir, 'runtime-store.json');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-06-15T10:00:00Z'));
    try {
      runSeedDemoTenant({
        args: [],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        runtimeStorePath: storePath,
        logger: () => {},
      });

      const seeded = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      expect(seeded.keyDates.length).toBeGreaterThan(0);
      for (const kd of seeded.keyDates) {
        expect(kd.dueDate > '2027-06-15').toBe(true);
      }
      const peopleWithOids = seeded.people.filter(
        (p: { entraObjectId?: string }) => p.entraObjectId !== undefined,
      );
      expect(peopleWithOids).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      fs.rmSync(tmpDir, { recursive: true, force: true });
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

  it('11. clearAllDataToCleanDeployment followed by provisioning a user as P-000004 and resetAllDemoData does not bind that user to the seeded admin persona or leave 00000000- object IDs (R336)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-r336-reset-'));
    const storePath = path.join(tmpDir, 'runtime-store.json');

    vi.stubEnv('PLATFORM_ENVIRONMENT', 'demo');
    try {
      process.env.ONESQUARED_RUNTIME_STORE_PATH = storePath;
      saveStore(loadCommittedSeedStore());
      clearStoreMemoryCache();

      // Step 1: Clear all data to a clean deployment
      clearAllDataToCleanDeployment('P-000004');
      const cleared = getStore();
      expect(cleared.isCleanDeployment).toBe(true);
      expect(cleared.people).toHaveLength(0);

      // Step 2: Provision a real Entra user who happens to receive ID P-000004 in the clean deployment
      cleared.people.push({
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
      } as unknown as (typeof cleared.people)[number]);
      saveStore(cleared);
      clearStoreMemoryCache();

      // Step 3: Also test when isCleanDeployment was flipped to false but P-000004 is still a different person (different email)
      resetAllDemoData('P-000004');

      const afterReset = getStore();
      const p4 = afterReset.people.find((p) => p.id === 'P-000004');
      expect(p4).toBeDefined();
      expect(p4?.firstName).toBe('Huw');
      expect(p4?.surname).toBe('Pritchard');
      expect(p4?.entraObjectId).toBeUndefined();

      // Ensure no person received the provisioned user's object ID or any synthetic 00000000- object ID
      const withProvisionedOid = afterReset.people.filter(
        (p) => p.entraObjectId === '99999999-8888-4777-8666-555555555504',
      );
      expect(withProvisionedOid).toHaveLength(0);

      const withSyntheticOid = afterReset.people.filter((p) =>
        p.entraObjectId?.startsWith('00000000-'),
      );
      expect(withSyntheticOid).toHaveLength(0);

      // Step 4: Even in a non-clean store (!isCleanDeployment), an OID on P-000004 with a non-matching email is never copied onto Huw Pritchard
      const nonCleanMutated = getStore();
      const targetP4 = nonCleanMutated.people.find((p) => p.id === 'P-000004')!;
      targetP4.emails = [
        {
          id: 'EM-PROV-2',
          address: 'someone.else@notalawfirm.co.uk',
          typeId: null,
          isPrimary: true,
        },
      ];
      targetP4.entraObjectId = '88888888-7777-4666-8555-444444444404';
      saveStore(nonCleanMutated);
      clearStoreMemoryCache();

      resetAllDemoData('P-000004');
      const afterSecondReset = getStore();
      expect(afterSecondReset.people.find((p) => p.id === 'P-000004')?.entraObjectId).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      delete process.env.ONESQUARED_RUNTIME_STORE_PATH;
      fs.rmSync(tmpDir, { recursive: true, force: true });
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

  it('15. getStore() and runSeedDemoTenant refuse corrupted JSON files without echoing file content in the error message (R357, R368, R379, R380)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-r357-corrupt-'));
    const storePath = path.join(tmpDir, 'runtime-store.json');
    const entraMapPath = path.join(tmpDir, 'entra-map.local.json');
    // In V8, JSON.parse('{"name": JaneSecret}') throws:
    //   Unexpected token 'J', "{"name": JaneSecret}" is not valid JSON
    // which echoes the unquoted token in error.message unless redacted.
    const corruptedPayload = '{"name": JaneSecret}';
    const corruptedEntraMapPayload = '{"email": rhian.morgan@notalawfirm.co.uk}';

    try {
      // Confirm V8's native JSON.parse error message does contain the token so this test would fail on unredacted error.message
      let rawParseMessage = '';
      try {
        JSON.parse(corruptedPayload);
      } catch (parseErr) {
        rawParseMessage = parseErr instanceof Error ? parseErr.message : String(parseErr);
      }
      expect(rawParseMessage).toContain('JaneSecret');

      fs.writeFileSync(storePath, corruptedPayload, 'utf8');
      process.env.ONESQUARED_RUNTIME_STORE_PATH = storePath;
      clearStoreMemoryCache();

      let thrownMessage = '';
      try {
        getStore();
      } catch (err) {
        thrownMessage = err instanceof Error ? err.message : String(err);
      }
      expect(thrownMessage).toMatch(
        /Refusing to load corrupted runtime store file.*not valid JSON/,
      );
      expect(thrownMessage).not.toContain('JaneSecret');
      expect(fs.readFileSync(storePath, 'utf8')).toBe(corruptedPayload);

      // Also verify runSeedDemoTenant with a malformed --entra-map file reports a fixed message without echoing file content (R379)
      fs.writeFileSync(entraMapPath, corruptedEntraMapPayload, 'utf8');
      const seedTargetPath = path.join(tmpDir, 'seeded-store.json');
      let thrownEntraMapMessage = '';
      try {
        runSeedDemoTenant({
          args: ['--entra-map', entraMapPath],
          env: {
            PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
            PLATFORM_ENVIRONMENT: 'demo',
          },
          runtimeStorePath: seedTargetPath,
          logger: () => {},
        });
      } catch (err) {
        thrownEntraMapMessage = err instanceof Error ? err.message : String(err);
      }
      expect(thrownEntraMapMessage).toBe('Entra map file is not valid JSON.');
      expect(thrownEntraMapMessage).not.toContain('rhian.morgan');
    } finally {
      delete process.env.ONESQUARED_RUNTIME_STORE_PATH;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('16. seed:demo without --entra-map prints a warning stating how many privileged personas remain unbound, with no email address in the output (S0-30, R381, R392)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onesquared-s030-seed-warn-'));
    const storePath = path.join(tmpDir, 'runtime-store.json');
    const fullMapPath = path.join(tmpDir, 'entra-map.local.json');
    const stdoutLogs: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const unmappedRes = runSeedDemoTenant({
        args: [],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        runtimeStorePath: storePath,
        logger: (line) => stdoutLogs.push(line),
      });

      const activeTenantCfg = getActiveTenantConfiguration();
      const writtenStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
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

      const mappedRes = runSeedDemoTenant({
        args: ['--force', '--entra-map', fullMapPath],
        env: {
          ...process.env,
          PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
          PLATFORM_ENVIRONMENT: 'demo',
        },
        runtimeStorePath: storePath,
        logger: () => {},
      });
      expect(mappedRes.unboundPrivilegedPersonas).toBe(0);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
