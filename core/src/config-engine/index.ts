/**
 * Schema-validated tenant configuration engine (`core/src/config-engine/`).
 *
 * Rules enforced:
 * - Every configuration option has a type, default, description, and validation.
 * - Unknown keys are rejected (`.strict()`).
 * - Secrets are referenced by Key Vault URI/name only; raw secrets are rejected.
 */

import { z } from 'zod';
import type {
  HostingMode,
  PlatformEnvironment,
  TenantConfiguration,
} from '../api/index';

const KeyVaultRefSchema = z
  .string()
  .regex(
    /^kv:\/\/[a-z0-9-]+\/[a-z0-9-]+$/i,
    'Integration secrets must be Key Vault references formatted as kv://<vault>/<secret-name>',
  )
  .describe('Key Vault secret reference URI (never a raw secret value)');

const CustomGradeSchema = z
  .object({
    id: z.string().min(1).describe('Unique grade identifier'),
    label: z.string().min(1).describe('Display label for the custom fee-earner grade'),
    hourlyRateGbp: z.number().nonnegative().describe('Standard hourly rate in GBP'),
  })
  .strict();

const RateCardEntrySchema = z
  .object({
    id: z.string().min(1).describe('Rate card identifier'),
    name: z.string().min(1).describe('Rate card display name'),
    practiceAreaKey: z
      .string()
      .nullable()
      .default(null)
      .describe('Optional practice area key mapped to this rate card'),
    pmsDepartmentCode: z
      .string()
      .default('Standard')
      .describe('Department code in the practice management system'),
    partnerRateGbp: z.number().nonnegative().default(350).describe('Partner hourly rate in GBP'),
    associateRateGbp: z.number().nonnegative().default(250).describe('Associate hourly rate in GBP'),
    traineeRateGbp: z.number().nonnegative().default(145).describe('Trainee hourly rate in GBP'),
    customGrades: z
      .array(CustomGradeSchema)
      .default([])
      .describe('Optional additional fee-earner grade rates'),
    active: z.boolean().default(true).describe('Whether this rate card is active'),
  })
  .strict();

const DisbursementPresetSchema = z
  .object({
    id: z.string().min(1).describe('Disbursement preset identifier'),
    description: z.string().min(1).describe('Disbursement line description'),
    defaultAmountGbp: z.number().nonnegative().default(0).describe('Default amount in GBP'),
    practiceAreaKey: z
      .string()
      .nullable()
      .default(null)
      .describe('Optional practice area key restriction'),
    vatApplicable: z.boolean().default(true).describe('Whether standard UK VAT applies'),
  })
  .strict();

export const TenantConfigurationSchema = z
  .object({
    schemaVersion: z
      .string()
      .default('1.0.0')
      .describe('Semantic version of the configuration schema'),
    tenantId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/)
      .describe('Unique immutable tenant slug'),
    displayName: z.string().min(1).describe('Tenant display name'),
    hostingMode: z
      .enum(['single_tenant', 'multi_tenant'])
      .default('multi_tenant')
      .describe('Deployment tenancy mode (Model A single_tenant or Model B multi_tenant)'),
    environment: z
      .enum(['dev', 'test', 'training', 'live'])
      .default('dev')
      .describe('Target deployment environment'),
    branding: z
      .object({
        primaryDomain: z.string().min(1).describe('Verified primary domain for the tenant'),
        accentColorHex: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default('#1f6feb')
          .describe('Primary brand accent hex colour'),
        logoAssetKey: z
          .string()
          .default('default-logo.svg')
          .describe('Tenant-scoped asset key for the firm logo'),
      })
      .strict(),
    featureFlags: z
      .object({
        enableMatterCostsGovernance: z
          .boolean()
          .default(true)
          .describe('Enable matter cost threshold governance checks'),
        enablePmsLiveRateSync: z
          .boolean()
          .default(true)
          .describe('Allow syncing hourly rates from the connected PMS'),
        enableAiMatterExtraction: z
          .boolean()
          .default(false)
          .describe('Enable AI-assisted matter field extraction'),
      })
      .strict(),
    matterCosts: z
      .object({
        rateSourceMode: z
          .enum(['application_table', 'pms_when_linked'])
          .default('pms_when_linked')
          .describe('Source of default fee-earner hourly rates'),
        allowMatterRateOverrides: z
          .boolean()
          .default(true)
          .describe('Whether fee earners can override standard rates on a matter'),
        partnerSignOffThresholdGbp: z
          .number()
          .nonnegative()
          .default(25000)
          .describe('Fee estimate or cap threshold in GBP requiring Partner cost sign-off'),
        rateCards: z.array(RateCardEntrySchema).default([]),
        disbursementPresets: z.array(DisbursementPresetSchema).default([]),
      })
      .strict(),
    integrations: z
      .object({
        pmsConnectionSecretVaultRef: KeyVaultRefSchema,
        companiesHouseApiKeyVaultRef: KeyVaultRefSchema,
        aiProviderChoice: z
          .enum(['azure_openai_uk', 'disabled'])
          .default('disabled')
          .describe('Configured AI model provider for this tenant'),
      })
      .strict(),
    enabledExtensions: z
      .array(z.string())
      .default([])
      .describe('List of extension IDs enabled for this tenant'),
  })
  .strict();

export function loadAndValidateTenantConfig(
  baseConfig: Record<string, unknown>,
  environmentOverlay: Record<string, unknown> = {},
  environmentOverride?: PlatformEnvironment,
  hostingModeOverride?: HostingMode,
): TenantConfiguration {
  const merged: Record<string, unknown> = {
    ...baseConfig,
    ...environmentOverlay,
    branding: {
      ...(baseConfig.branding as Record<string, unknown> | undefined),
      ...(environmentOverlay.branding as Record<string, unknown> | undefined),
    },
    featureFlags: {
      ...(baseConfig.featureFlags as Record<string, unknown> | undefined),
      ...(environmentOverlay.featureFlags as Record<string, unknown> | undefined),
    },
    matterCosts: {
      ...(baseConfig.matterCosts as Record<string, unknown> | undefined),
      ...(environmentOverlay.matterCosts as Record<string, unknown> | undefined),
    },
    integrations: {
      ...(baseConfig.integrations as Record<string, unknown> | undefined),
      ...(environmentOverlay.integrations as Record<string, unknown> | undefined),
    },
  };

  if (environmentOverride) {
    merged.environment = environmentOverride;
  }
  if (hostingModeOverride) {
    merged.hostingMode = hostingModeOverride;
  }

  return TenantConfigurationSchema.parse(merged);
}
