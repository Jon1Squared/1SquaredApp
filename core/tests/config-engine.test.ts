import { describe, expect, it } from 'vitest';
import {
  loadAndValidateTenantConfig,
  RESERVED_TENANT_CONFIG_SETTINGS,
  validateTenantConfigWithWarnings,
} from '../src/config-engine';

const SAMPLE_BASE_CONFIG: Record<string, unknown> = {
  schemaVersion: '1.0.0',
  tenantId: 'tenant-alpha',
  displayName: 'Alpha Legal Practice',
  hostingMode: 'multi_tenant',
  environment: 'test',
  branding: {
    primaryDomain: 'alpha-legal.example',
    accentColorHex: '#1D4ED8',
    logoAssetKey: 'tenants/tenant-alpha/logo.svg',
  },
  featureFlags: {
    enableMatterCostsGovernance: true,
    enablePmsLiveRateSync: true,
    enableAiMatterExtraction: false,
  },
  matterCosts: {
    rateSourceMode: 'pms_when_linked',
    allowMatterRateOverrides: true,
    partnerSignOffThresholdGbp: 15000,
    rateCards: [],
    disbursementPresets: [],
  },
  integrations: {
    pmsConnectionSecretVaultRef: 'kv://kv-alpha-uk/pms-db-conn',
    companiesHouseApiKeyVaultRef: 'kv://kv-alpha-uk/companies-house-api-key',
    aiProviderChoice: 'disabled',
    pmsSync: {
      enabled: true,
      providerKey: 'generic_sql',
      syncMode: 'two_way',
      matterCodeAllocation: 'onesquared',
      clientCodeAllocation: 'onesquared',
      pollIntervalMinutes: 15,
      fieldMappings: [
        {
          id: 'MAP-MATTER-TITLE',
          entityType: 'matter',
          onesquaredFieldKey: 'title',
          externalFieldKey: 'matter_description',
          ownership: 'onesquared_master',
          active: true,
        },
        {
          id: 'MAP-MATTER-ESTIMATE',
          entityType: 'matter',
          onesquaredFieldKey: 'feeEstimateGbp',
          externalFieldKey: 'fee_estimate',
          ownership: 'bidirectional',
          active: true,
        },
      ],
    },
  },
};

describe('S0-18: Tenant Configuration Engine — integrations.pmsSync Deep-Merge & Reserved Backlog Tagging (R411)', () => {
  it('deep-merges partial overlay.integrations.pmsSync overrides without wiping base.integrations.pmsSync fields or fieldMappings (R411)', () => {
    const partialOverlay: Record<string, unknown> = {
      environment: 'live',
      integrations: {
        pmsSync: {
          pollIntervalMinutes: 5,
          syncMode: 'read_only',
        },
      },
    };

    const merged = loadAndValidateTenantConfig(
      SAMPLE_BASE_CONFIG,
      partialOverlay,
    );

    expect(merged.environment).toBe('live');
    expect(merged.integrations.pmsConnectionSecretVaultRef).toBe(
      'kv://kv-alpha-uk/pms-db-conn',
    );
    expect(merged.integrations.companiesHouseApiKeyVaultRef).toBe(
      'kv://kv-alpha-uk/companies-house-api-key',
    );
    expect(merged.integrations.pmsSync).toBeDefined();
    expect(merged.integrations.pmsSync?.pollIntervalMinutes).toBe(5);
    expect(merged.integrations.pmsSync?.syncMode).toBe('read_only');
    // Unchanged base fields and fieldMappings must remain intact
    expect(merged.integrations.pmsSync?.enabled).toBe(true);
    expect(merged.integrations.pmsSync?.providerKey).toBe('generic_sql');
    expect(merged.integrations.pmsSync?.matterCodeAllocation).toBe('onesquared');
    expect(merged.integrations.pmsSync?.clientCodeAllocation).toBe('onesquared');
    expect(merged.integrations.pmsSync?.fieldMappings).toHaveLength(2);
    expect(merged.integrations.pmsSync?.fieldMappings[0]?.id).toBe(
      'MAP-MATTER-TITLE',
    );
    expect(merged.integrations.pmsSync?.fieldMappings[1]?.id).toBe(
      'MAP-MATTER-ESTIMATE',
    );
  });

  it('re-tags pmsConnectionSecretVaultRef, companiesHouseApiKeyVaultRef, and all 7 integrations.pmsSync.* leaves to backlog (Owner Decision 3, R411)', () => {
    const pmsAndChPaths = [
      'integrations.pmsConnectionSecretVaultRef',
      'integrations.companiesHouseApiKeyVaultRef',
      'integrations.pmsSync.enabled',
      'integrations.pmsSync.providerKey',
      'integrations.pmsSync.syncMode',
      'integrations.pmsSync.matterCodeAllocation',
      'integrations.pmsSync.clientCodeAllocation',
      'integrations.pmsSync.pollIntervalMinutes',
      'integrations.pmsSync.fieldMappings',
    ];

    for (const path of pmsAndChPaths) {
      const entry = RESERVED_TENANT_CONFIG_SETTINGS.find((s) => s.path === path);
      expect(entry, `Expected ${path} in RESERVED_TENANT_CONFIG_SETTINGS`).toBeDefined();
      expect(entry?.forSlice).toBe('backlog');
    }

    expect(
      RESERVED_TENANT_CONFIG_SETTINGS.some((s) => s.forSlice === 'S0-18'),
    ).toBe(false);

    const validated = validateTenantConfigWithWarnings(SAMPLE_BASE_CONFIG);
    for (const path of pmsAndChPaths) {
      expect(
        validated.structuredReservedSettings.some(
          (n) => n.path === path && n.forSlice === 'backlog',
        ),
        `Expected structuredReservedSettings notice for ${path} -> backlog`,
      ).toBe(true);
    }
  });
});
