import { afterEach, describe, expect, it } from 'vitest';
import { loadActiveTenantRegistry } from '@platform/core';

const REQUIRED_VARS = [
  'PLATFORM_TENANT_PACKAGE_DIR',
  'PLATFORM_ENVIRONMENT',
  'PLATFORM_HOSTING_MODE',
  'PLATFORM_POSTGRES_HOST',
] as const;

const saved: Record<string, string | undefined> = {};
for (const name of [
  ...REQUIRED_VARS,
  'PLATFORM_TENANT_REGISTRY_JSON',
  'PLATFORM_TENANT_REGISTRY_PATH',
]) {
  saved[name] = process.env[name];
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe('S0-14: single-package tenant registry fails closed (R436)', () => {
  it('loads the configured package when every variable is set (positive control)', () => {
    delete process.env.PLATFORM_TENANT_REGISTRY_JSON;
    delete process.env.PLATFORM_TENANT_REGISTRY_PATH;
    const registry = loadActiveTenantRegistry();
    expect(registry.environment).toBe(process.env.PLATFORM_ENVIRONMENT);
    expect(registry.hostingMode).toBe(process.env.PLATFORM_HOSTING_MODE);
    expect(registry.tenants).toHaveLength(1);
    expect(registry.tenants[0]!.packageDir).toBe(
      process.env.PLATFORM_TENANT_PACKAGE_DIR,
    );
  });

  for (const name of REQUIRED_VARS) {
    it(`throws TENANT_REGISTRY_ERROR when ${name} is unset`, () => {
      delete process.env.PLATFORM_TENANT_REGISTRY_JSON;
      delete process.env.PLATFORM_TENANT_REGISTRY_PATH;
      delete process.env[name];
      let caught: unknown;
      try {
        loadActiveTenantRegistry();
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({
        code: 'TENANT_REGISTRY_ERROR',
        message: `TENANT_REGISTRY_ERROR: ${name} must be set to load the single-package tenant registry.`,
      });
    });
  }

  it('rejects an unknown hosting mode instead of defaulting to multi_tenant', () => {
    delete process.env.PLATFORM_TENANT_REGISTRY_JSON;
    delete process.env.PLATFORM_TENANT_REGISTRY_PATH;
    process.env.PLATFORM_HOSTING_MODE = 'shared';
    expect(() => loadActiveTenantRegistry()).toThrow(
      'TENANT_REGISTRY_ERROR: PLATFORM_HOSTING_MODE "shared" must be single_tenant or multi_tenant.',
    );
  });
});
