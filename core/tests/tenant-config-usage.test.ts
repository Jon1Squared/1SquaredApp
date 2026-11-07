import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthorisationError,
  collectConfigReservedSettings,
  collectStructuredConfigReservedSettings,
  loadAndValidateTenantConfig,
  RESERVED_TENANT_CONFIG_SETTINGS,
  TenantConfigurationSchema,
  validateTenantConfigWithWarnings,
  type PlatformEnvironment,
} from '@platform/core';
import tenantConfigJsonSchema from '../schemas/tenant-config.schema.json';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import {
  getActiveTenantConfiguration,
  setActiveTenantConfigForTesting,
} from '../../src/platform/tenantRuntime';
import {
  saveMatterCostsConfig,
  signOffMatterCostsRecord,
  syncMatterCostsRatesFromPms,
} from '../../src/server/services';
import { getStore, saveStore } from '../../src/server/store';
import { runWithActiveActorSession } from '../../src/server/rbacRuntime';
import { createDefaultMatterCostsConfig } from '../../src/domain/matterCosts';

const REPO_ROOT = path.resolve(__dirname, '../..');

interface SchemaLeafEntry {
  path: string;
  key: string;
  deprecated: boolean;
  reserved?: {
    for: string;
    reason: string;
  };
}

function walkTenantSchemaProperties(
  node: Record<string, unknown>,
  prefix = '',
  inheritedReserved?: { for: string; reason: string },
  inheritedDeprecated = false,
): SchemaLeafEntry[] {
  const results: SchemaLeafEntry[] = [];
  if (!node || typeof node !== 'object') {
    return results;
  }

  const nodeReserved = (node['x-reserved'] as
    | { for: string; reason: string }
    | undefined) ?? inheritedReserved;
  const nodeDeprecated = Boolean(node.deprecated) || inheritedDeprecated;

  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(
      node.properties as Record<string, Record<string, unknown>>,
    )) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      const children = walkTenantSchemaProperties(
        child,
        childPath,
        nodeReserved,
        nodeDeprecated,
      );
      if (children.length === 0) {
        const leafReserved = (child['x-reserved'] as
          | { for: string; reason: string }
          | undefined) ?? nodeReserved;
        results.push({
          path: childPath,
          key,
          deprecated: Boolean(child.deprecated) || nodeDeprecated,
          reserved: leafReserved,
        });
      } else {
        results.push(...children);
      }
    }
    return results;
  }

  if (
    node.items &&
    typeof node.items === 'object' &&
    (node.items as Record<string, unknown>).properties
  ) {
    const itemsObj = node.items as Record<string, unknown>;
    const itemsReserved = (itemsObj['x-reserved'] as
      | { for: string; reason: string }
      | undefined) ?? nodeReserved;
    for (const [key, child] of Object.entries(
      itemsObj.properties as Record<string, Record<string, unknown>>,
    )) {
      const childPath = `${prefix}[].${key}`;
      const children = walkTenantSchemaProperties(
        child,
        childPath,
        itemsReserved,
        nodeDeprecated,
      );
      if (children.length === 0) {
        const leafReserved = (child['x-reserved'] as
          | { for: string; reason: string }
          | undefined) ?? itemsReserved;
        results.push({
          path: childPath,
          key,
          deprecated: Boolean(child.deprecated) || nodeDeprecated,
          reserved: leafReserved,
        });
      } else {
        results.push(...children);
      }
    }
    return results;
  }

  if (
    node.additionalProperties &&
    typeof node.additionalProperties === 'object' &&
    (node.additionalProperties as Record<string, unknown>).properties
  ) {
    const addPropsObj = node.additionalProperties as Record<string, unknown>;
    for (const [key, child] of Object.entries(
      addPropsObj.properties as Record<string, Record<string, unknown>>,
    )) {
      const childPath = `${prefix}.*.${key}`;
      const children = walkTenantSchemaProperties(
        child,
        childPath,
        nodeReserved,
        nodeDeprecated,
      );
      if (children.length === 0) {
        const leafReserved = (child['x-reserved'] as
          | { for: string; reason: string }
          | undefined) ?? nodeReserved;
        results.push({
          path: childPath,
          key,
          deprecated: Boolean(child.deprecated) || nodeDeprecated,
          reserved: leafReserved,
        });
      } else {
        results.push(...children);
      }
    }
    return results;
  }

  if (Array.isArray(node.oneOf)) {
    for (const variant of node.oneOf as Record<string, unknown>[]) {
      results.push(
        ...walkTenantSchemaProperties(
          variant,
          prefix,
          nodeReserved,
          nodeDeprecated,
        ),
      );
    }
  }

  return results;
}

function collectRuntimeSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === '__tests__' ||
        entry.name === 'tests' ||
        entry.name === 'docs' ||
        entry.name === 'seed'
      ) {
        continue;
      }
      files.push(...collectRuntimeSourceFiles(fullPath));
    } else if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts') &&
      entry.name !== 'types.ts' &&
      !fullPath.endsWith(path.join('core', 'src', 'api', 'index.ts')) &&
      !fullPath.endsWith(path.join('core', 'src', 'config-engine', 'index.ts'))
    ) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

describe('S0-12: tenant configuration schema usage, reserved markers, and feature flag gates', () => {
  afterEach(() => {
    setActiveTenantConfigForTesting(null);
    vi.restoreAllMocks();
  });

  it('walks tenantConfigJsonSchema.properties recursively and asserts every leaf key is either referenced in runtime code or marked x-reserved', () => {
    const leaves = walkTenantSchemaProperties(
      tenantConfigJsonSchema as unknown as Record<string, unknown>,
    );
    expect(leaves.length).toBeGreaterThan(50);

    const runtimeFiles = [
      ...collectRuntimeSourceFiles(path.join(REPO_ROOT, 'src')),
      ...collectRuntimeSourceFiles(path.join(REPO_ROOT, 'core', 'src')),
    ];
    const runtimeCorpus = runtimeFiles
      .map((filePath) => fs.readFileSync(filePath, 'utf8'))
      .join('\n');

    const unreferencedNonReserved: string[] = [];
    for (const leaf of leaves) {
      if (leaf.reserved) {
        expect(leaf.reserved.for).toMatch(/^S0-\d+[a-z]?$/);
        expect(leaf.reserved.reason.trim().length).toBeGreaterThan(10);
        continue;
      }

      const escapedKey = leaf.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const keyPattern = new RegExp(`\\b${escapedKey}\\b`);
      if (!keyPattern.test(runtimeCorpus)) {
        unreferencedNonReserved.push(leaf.path);
      }
    }

    expect(unreferencedNonReserved).toEqual([]);
  });

  it('marks all unused settings as x-reserved with their target slice in JSON schema and Zod descriptions', () => {
    const expectedReservedByPath: Record<string, string> = {
      'branding.accentColorHex': 'S0-11b',
      'branding.logoAssetKey': 'S0-11b',
      'matterCosts.rateSourceMode': 'S0-23',
      'matterCosts.allowMatterRateOverrides': 'S0-23',
      'matterCosts.partnerSignOffThresholdGbp': 'S0-23',
      'matterCosts.rateCards': 'S0-23',
      'matterCosts.disbursementPresets': 'S0-23',
      'integrations.pmsConnectionSecretVaultRef': 'S0-18',
      'integrations.companiesHouseApiKeyVaultRef': 'S0-18',
      'integrations.pmsSync.enabled': 'S0-18',
      'integrations.pmsSync.providerKey': 'S0-18',
      'integrations.pmsSync.syncMode': 'S0-18',
      'integrations.pmsSync.matterCodeAllocation': 'S0-18',
      'integrations.pmsSync.clientCodeAllocation': 'S0-18',
      'integrations.pmsSync.pollIntervalMinutes': 'S0-18',
      'integrations.pmsSync.fieldMappings': 'S0-18',
      'documentAccess.autoRemediateDrift': 'S0-25',
    };

    const leaves = walkTenantSchemaProperties(
      tenantConfigJsonSchema as unknown as Record<string, unknown>,
    );

    for (const [expectedPath, expectedSlice] of Object.entries(
      expectedReservedByPath,
    )) {
      const matchingLeaves = leaves.filter(
        (l) =>
          l.path === expectedPath || l.path.startsWith(`${expectedPath}[].`),
      );
      expect(matchingLeaves.length).toBeGreaterThan(0);
      for (const match of matchingLeaves) {
        expect(match.reserved?.for).toBe(expectedSlice);
      }
    }

    expect(
      RESERVED_TENANT_CONFIG_SETTINGS.map((s) => [s.path, s.forSlice]),
    ).toEqual(Object.entries(expectedReservedByPath));

    expect(
      TenantConfigurationSchema.shape.branding.shape.accentColorHex.description,
    ).toContain('[x-reserved:S0-11b]');
    expect(
      TenantConfigurationSchema.shape.matterCosts.shape.rateSourceMode
        .description,
    ).toContain('[x-reserved:S0-23]');
    expect(
      TenantConfigurationSchema.shape.integrations.shape
        .pmsConnectionSecretVaultRef.description,
    ).toContain('[x-reserved:S0-18]');
  });

  it('validates client-not-a-law-firm/config/base.json and all environment overlays unchanged (Rule 7 backward compatibility)', () => {
    const configDir = path.join(REPO_ROOT, 'client-not-a-law-firm', 'config');
    const baseRaw = JSON.parse(
      fs.readFileSync(path.join(configDir, 'base.json'), 'utf8'),
    ) as Record<string, unknown>;

    const environmentsDir = path.join(configDir, 'environments');
    const overlayFiles = fs
      .readdirSync(environmentsDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(overlayFiles).toEqual(['dev.json', 'test.json']);

    const environments: PlatformEnvironment[] = [
      'dev',
      'test',
      'training',
      'live',
    ];
    for (const env of environments) {
      const overlayPath = path.join(environmentsDir, `${env}.json`);
      const overlayRaw = fs.existsSync(overlayPath)
        ? (JSON.parse(
            fs.readFileSync(overlayPath, 'utf8'),
          ) as Record<string, unknown>)
        : {};

      const validated = loadAndValidateTenantConfig(baseRaw, overlayRaw, env);
      expect(validated.tenantId).toBe('not-a-law-firm');
      expect(validated.environment).toBe(env);

      const withNotices = validateTenantConfigWithWarnings(
        baseRaw,
        overlayRaw,
        env,
      );
      expect(withNotices.deprecationWarnings).toEqual([]);
      expect(withNotices.reservedSettings.length).toBeGreaterThan(0);
      expect(
        withNotices.structuredReservedSettings.some(
          (n) =>
            n.path === 'integrations.pmsConnectionSecretVaultRef' &&
            n.forSlice === 'S0-18',
        ),
      ).toBe(true);
    }

    expect(
      collectConfigReservedSettings(baseRaw).some((msg) =>
        msg.includes('[RESERVED_CONFIG_KEY] matterCosts.rateSourceMode'),
      ),
    ).toBe(true);
    expect(collectStructuredConfigReservedSettings({})).toEqual([]);
  });

  it('logs reserved settings once as info at startup when loading tenant configuration', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    setActiveTenantConfigForTesting(
      notALawFirmBaseConfig as unknown as Record<string, unknown>,
    );

    const first = getActiveTenantConfiguration();
    const second = getActiveTenantConfiguration();
    expect(first.tenantId).toBe('not-a-law-firm');
    expect(second.tenantId).toBe('not-a-law-firm');

    const reservedLogs = infoSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(String(call[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.event === 'tenant_config.reserved_settings');

    expect(reservedLogs).toHaveLength(1);
    expect(reservedLogs[0]?.level).toBe('info');
    expect(reservedLogs[0]?.tenantId).toBe('not-a-law-firm');
    expect(String(reservedLogs[0]?.correlationId)).toMatch(
      /^cfg-startup-not-a-law-firm-/,
    );
  });

  it('gates saveMatterCostsConfig, signOffMatterCostsRecord, and syncMatterCostsRatesFromPms on featureFlags', async () => {
    const store = getStore();
    const snapshot = structuredClone(store);
    try {
      const sampleConfig = createDefaultMatterCostsConfig(store.values, {
        clientProfileCode: notALawFirmBaseConfig.tenantId,
        displayName: notALawFirmBaseConfig.displayName,
        primaryDomain: notALawFirmBaseConfig.branding.primaryDomain,
      });

      setActiveTenantConfigForTesting({
        ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
        featureFlags: {
          ...notALawFirmBaseConfig.featureFlags,
          enableMatterCostsGovernance: false,
          enablePmsLiveRateSync: false,
        },
      });

      expect(() => saveMatterCostsConfig(sampleConfig, 'P-0001')).toThrow(
        AuthorisationError,
      );
      expect(() => syncMatterCostsRatesFromPms('P-0001')).toThrow(
        AuthorisationError,
      );

      const targetMatter = store.matters[0]!;
      const signOffDenied = await runWithActiveActorSession(
        {
          tenantId: 'not-a-law-firm',
          personId: 'P-0001',
          tokenRoles: ['managing_partner', 'admin'],
          mfaVerified: true,
          expiresAtMs: Date.now() + 60_000,
          verifiedSession: {
            __verifiedEntraSession: true,
            tenantId: 'not-a-law-firm',
            personId: 'P-0001',
            entraObjectId: '00000000-0000-4000-8000-000000000001',
            email: 'aldous.vane@notalawfirm.example',
            displayName: 'Aldous Vane',
            mappedRoles: ['managing_partner', 'admin'],
            mfaVerified: true,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
        () =>
          signOffMatterCostsRecord(
            targetMatter.id,
            'P-0001',
            'Attempted sign-off while feature disabled',
          ),
      );
      expect(signOffDenied.matter).toBeNull();
      expect(signOffDenied.errors?.featureDisabled).toContain(
        'enableMatterCostsGovernance is false',
      );
    } finally {
      saveStore(snapshot);
    }
  });
});
