import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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
  isDataResetAllowedEnvironment,
  isDemoModeEnabled,
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
});
