import { describe, expect, it } from 'vitest';
import {
  loadAndValidateTenantConfig,
  RESERVED_TENANT_CONFIG_SETTINGS,
  TenantConfigurationSchema,
  validateCddConfig,
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

  it('R527 (D3): rejects rbac.identityMapping.requireMfaForAdminPermissions=false when environment is live, while allowing false in dev and test', () => {
    const devFalse = loadAndValidateTenantConfig(
      SAMPLE_BASE_CONFIG,
      {
        environment: 'dev',
        rbac: {
          identityMapping: {
            requireMfaForAdminPermissions: false,
          },
        },
      },
    );
    expect(devFalse.rbac.identityMapping.requireMfaForAdminPermissions).toBe(false);

    const testFalse = loadAndValidateTenantConfig(
      SAMPLE_BASE_CONFIG,
      {
        environment: 'test',
        rbac: {
          identityMapping: {
            requireMfaForAdminPermissions: false,
          },
        },
      },
    );
    expect(testFalse.rbac.identityMapping.requireMfaForAdminPermissions).toBe(false);

    const liveTrue = loadAndValidateTenantConfig(
      SAMPLE_BASE_CONFIG,
      {
        environment: 'live',
        rbac: {
          identityMapping: {
            requireMfaForAdminPermissions: true,
          },
        },
      },
    );
    expect(liveTrue.rbac.identityMapping.requireMfaForAdminPermissions).toBe(true);

    const liveFalseParsed = TenantConfigurationSchema.safeParse({
      ...SAMPLE_BASE_CONFIG,
      environment: 'live',
      integrations: {
        ...((SAMPLE_BASE_CONFIG.integrations as Record<string, unknown>) ?? {}),
        pmsConnectionSecretVaultRef: 'kv://kv-tenant-alpha-live/pms-db-conn',
        companiesHouseApiKeyVaultRef: 'kv://kv-tenant-alpha-live/companies-house-api-key',
      },
      rbac: {
        identityMapping: {
          requireMfaForAdminPermissions: false,
        },
      },
    });
    expect(liveFalseParsed.success).toBe(false);
    if (!liveFalseParsed.success) {
      expect(
        liveFalseParsed.error.issues.some(
          (issue) =>
            issue.path.join('.') === 'rbac.identityMapping.requireMfaForAdminPermissions' &&
            /live/i.test(issue.message),
        ),
      ).toBe(true);
    }

    expect(() =>
      loadAndValidateTenantConfig(SAMPLE_BASE_CONFIG, {
        environment: 'live',
        integrations: {
          pmsConnectionSecretVaultRef: 'kv://kv-tenant-alpha-live/pms-db-conn',
          companiesHouseApiKeyVaultRef: 'kv://kv-tenant-alpha-live/companies-house-api-key',
        },
        rbac: {
          identityMapping: {
            requireMfaForAdminPermissions: false,
          },
        },
      }),
    ).toThrow(/requireMfaForAdminPermissions.*live/i);
  });

  it('S1-04: deep-merges cdd configuration overrides without wiping base mappings or checklists and validates standalone validateCddConfig', () => {
    const withBaseCdd = {
      ...SAMPLE_BASE_CONFIG,
      cdd: {
        enabled: true,
        clientTypeMapping: {
          company: 'company_or_llp',
          sole_trader: 'individual',
        },
        riskTierMapping: {
          low: 'standard',
          high: 'high',
          sensitive: 'high',
        },
        checklists: {
          individual: {
            standard: [
              {
                itemKey: 'photo_id',
                label: 'Photo ID',
                required: true,
                requiresEvidence: true,
                linkedIntakeCheckKind: 'identity_verification',
              },
            ],
            highAdditional: [
              {
                itemKey: 'source_of_funds',
                label: 'Source of funds',
                required: true,
                requiresEvidence: true,
              },
            ],
          },
        },
        recheckIntervalsMonths: {
          standard: 36,
          high: 12,
        },
        reminderScheduleDaysBefore: [30, 7, 0],
        maxEvidenceFileSizeBytes: 10485760,
      },
    };

    const merged = loadAndValidateTenantConfig(withBaseCdd, {
      cdd: {
        clientTypeMapping: {
          trust: 'trust_charity_or_partnership',
        },
        recheckIntervalsMonths: {
          high: 6,
        },
      },
    });

    expect(merged.cdd?.enabled).toBe(true);
    expect(merged.cdd?.clientTypeMapping).toEqual({
      company: 'company_or_llp',
      sole_trader: 'individual',
      trust: 'trust_charity_or_partnership',
    });
    expect(merged.cdd?.riskTierMapping?.sensitive).toBe('high');
    expect(merged.cdd?.checklists?.individual?.standard).toHaveLength(1);
    expect(merged.cdd?.recheckIntervalsMonths).toEqual({
      standard: 36,
      high: 6,
    });
    expect(merged.cdd?.reminderScheduleDaysBefore).toEqual([30, 7, 0]);
    expect(merged.cdd?.maxEvidenceFileSizeBytes).toBe(10485760);

    const validated = validateCddConfig({
      enabled: true,
      recheckIntervalsMonths: { standard: 24, high: 12 },
    });
    expect(validated.recheckIntervalsMonths?.standard).toBe(24);

    expect(() => validateCddConfig({ unknownCddKey: true })).toThrow();
    expect(() => validateCddConfig('not-an-object')).toThrow(/CDD_CONFIG_INVALID/);
  });
});
