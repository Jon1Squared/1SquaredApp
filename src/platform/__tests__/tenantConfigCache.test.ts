import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getActiveTenantConfiguration,
  getActiveTenantRawBaseConfig,
  getTenantConfigValidationCountForTesting,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';

describe('tenantRuntime — TenantConfiguration cache and immutability (R249, R250)', () => {
  const originalEnv = process.env.PLATFORM_ENVIRONMENT;
  const originalHostingMode = process.env.PLATFORM_HOSTING_MODE;
  const originalPackageDir = process.env.PLATFORM_TENANT_PACKAGE_DIR;

  beforeEach(() => {
    process.env.PLATFORM_TENANT_PACKAGE_DIR = 'client-not-a-law-firm';
    process.env.PLATFORM_ENVIRONMENT = 'test';
    process.env.PLATFORM_HOSTING_MODE = 'multi_tenant';
    setActiveTenantConfigForTesting(null);
  });

  afterEach(() => {
    setActiveTenantConfigForTesting(null);
    if (originalEnv === undefined) {
      delete process.env.PLATFORM_ENVIRONMENT;
    } else {
      process.env.PLATFORM_ENVIRONMENT = originalEnv;
    }
    if (originalHostingMode === undefined) {
      delete process.env.PLATFORM_HOSTING_MODE;
    } else {
      process.env.PLATFORM_HOSTING_MODE = originalHostingMode;
    }
    if (originalPackageDir === undefined) {
      delete process.env.PLATFORM_TENANT_PACKAGE_DIR;
    } else {
      process.env.PLATFORM_TENANT_PACKAGE_DIR = originalPackageDir;
    }
  });

  it('1. returns the same object reference (toBe) on repeated calls when nothing changes, validating only once', () => {
    const countBefore = getTenantConfigValidationCountForTesting();

    const first = getActiveTenantConfiguration();
    const countAfterFirst = getTenantConfigValidationCountForTesting();
    expect(countAfterFirst).toBe(countBefore + 1);

    const second = getActiveTenantConfiguration();
    const countAfterSecond = getTenantConfigValidationCountForTesting();

    expect(second).toBe(first);
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('2. returns a newly validated config when PLATFORM_ENVIRONMENT changes between calls', () => {
    process.env.PLATFORM_ENVIRONMENT = 'test';
    const testConfig = getActiveTenantConfiguration();
    expect(testConfig.environment).toBe('test');
    expect(testConfig.integrations.pmsConnectionSecretVaultRef).toBe(
      'kv://kv-notalawfirm-test/pms-connection-string',
    );

    const countBeforeChange = getTenantConfigValidationCountForTesting();
    process.env.PLATFORM_ENVIRONMENT = 'dev';
    const devConfig = getActiveTenantConfiguration();
    const countAfterChange = getTenantConfigValidationCountForTesting();

    expect(devConfig).not.toBe(testConfig);
    expect(devConfig.environment).toBe('dev');
    expect(devConfig.integrations.pmsConnectionSecretVaultRef).toBe(
      'kv://kv-notalawfirm-dev/pms-connection-string',
    );
    expect(countAfterChange).toBe(countBeforeChange + 1);
  });

  it('3. returns a newly validated config when PLATFORM_HOSTING_MODE changes between single_tenant and multi_tenant', () => {
    process.env.PLATFORM_HOSTING_MODE = 'multi_tenant';
    const multiConfig = getActiveTenantConfiguration();
    expect(multiConfig.hostingMode).toBe('multi_tenant');

    const countBeforeChange = getTenantConfigValidationCountForTesting();
    process.env.PLATFORM_HOSTING_MODE = 'single_tenant';
    const singleConfig = getActiveTenantConfiguration();
    const countAfterChange = getTenantConfigValidationCountForTesting();

    expect(singleConfig).not.toBe(multiConfig);
    expect(singleConfig.hostingMode).toBe('single_tenant');
    expect(countAfterChange).toBe(countBeforeChange + 1);
  });

  it('4. setActiveTenantConfigForTesting clears the cache so the next call reflects the new base config', () => {
    const initialConfig = getActiveTenantConfiguration();
    expect(initialConfig.displayName).toBe('Not A Law Firm LLP');

    const rawBase = getActiveTenantRawBaseConfig();
    const countBeforeOverride = getTenantConfigValidationCountForTesting();
    setActiveTenantConfigForTesting({
      ...rawBase,
      displayName: 'Not A Law Firm LLP (Cache Override Check)',
    });

    const overriddenConfig = getActiveTenantConfiguration();
    const countAfterOverride = getTenantConfigValidationCountForTesting();

    expect(overriddenConfig).not.toBe(initialConfig);
    expect(overriddenConfig.displayName).toBe(
      'Not A Law Firm LLP (Cache Override Check)',
    );
    expect(countAfterOverride).toBe(countBeforeOverride + 1);
  });

  it('5. deep-freezes the cached TenantConfiguration so mutating top-level or nested properties throws in strict mode (R250)', () => {
    const cfg = getActiveTenantConfiguration();

    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.branding)).toBe(true);
    expect(Object.isFrozen(cfg.rbac)).toBe(true);

    expect(() => {
      (cfg as { displayName: string }).displayName = 'Mutated Firm Name';
    }).toThrow(TypeError);

    expect(() => {
      (cfg.branding as { primaryDomain: string }).primaryDomain =
        'mutated.example';
    }).toThrow(TypeError);
  });
});
